#!/usr/bin/env node
// Regenerates lobby-wire.js's enum tables (GAME_MAP, DIFFICULTY, etc.) from
// the latest openfrontio/OpenFrontIO GitHub *release* tag — not main, since
// production only redeploys on releases (see release.yml over there), and
// they ship releases roughly daily, so main can be ahead of what's live.
//
// This script does two independent things:
//
//   1. Enum tables: mechanically safe. Each is just an ordinal -> string
//      list, generated straight from an upstream `enum { ... }` or
//      `z.enum([...])`. Re-derived and written back to lobby-wire.js
//      whenever they differ.
//
//   2. GameConfig/PublicGameInfo/etc. object *shape*: NOT mechanically safe
//      to auto-write. A field's position (and its opt/nullable-ness) sets
//      its presence-bit position in zbin's packed header, so a wrong guess
//      there doesn't fail loudly, it silently misaligns every field decoded
//      after it — worse than doing nothing. So this script only *compares*
//      the upstream shape against what parseLocalTree() finds already
//      encoded in lobby-wire.js's `obj([...])`/`f(...)` calls. Any
//      difference (field added/removed/reordered/opt/nullable changed) is
//      printed and the script exits 2 without touching the file, so CI goes
//      red and a human re-derives that part by hand.
//
// Exit codes: 0 = clean (possibly rewrote enum tables), 1 = fetch/parse
// error (couldn't even check), 2 = GameConfig-shape drift detected.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = "openfrontio/OpenFrontIO";
const WIRE_PATH = fileURLToPath(new URL("../../lobby-wire.js", import.meta.url));

async function ghApi(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      "User-Agent": "minhkarl-github-io-resync",
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function rawFile(tag, path) {
  const url = `https://raw.githubusercontent.com/${REPO}/${tag}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

// --- tiny bracket-depth-aware TS scanner ------------------------------
// Not a real parser. Just enough to find top-level object fields and their
// trailing .optional()/.nullable() modifiers without being fooled by
// modifiers belonging to a *nested* inline z.object({ ... }).

function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") i++;
    i++;
  }
  return i + 1;
}

// A bare "/" is a regex literal, not division, unless the previous
// non-whitespace character just closed a value (identifier/number/closing
// bracket) — the standard heuristic real tokenizers use. Schemas.ts already
// has at least one field-level regex (UsernameSchema); nothing stops one
// from landing inside GameConfigSchema/PublicGameInfoSchema later, and an
// unescaped "[" or "]" inside its pattern would otherwise desync depth.
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  return !/[\w$)\]]/.test(src[j]);
}

// i points at the opening "/". Scans to the matching unescaped "/",
// treating "[...]" character classes specially (an unescaped "/" inside one
// doesn't end the regex), then skips trailing flags.
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n") break; // malformed — bail rather than run away
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) { j++; break; }
  }
  while (j < src.length && /[a-z]/i.test(src[j])) j++;
  return j;
}

// Body between (and excluding) the outer `{` `}` of a `<name> = z.object({...})`.
function extractObjectBody(source, constName) {
  const m = source.match(
    new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*z\\.object\\(\\{`),
  );
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      i = skipString(source, i) - 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = (nl === -1 ? source.length : nl) - 1;
      continue;
    }
    if (c === "/" && isRegexStart(source, i)) {
      i = skipRegex(source, i) - 1;
      continue;
    }
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i);
}

// Given the body of an object literal (between { and }), return top-level
// fields in declaration order: { key, optional, nullable, raw }. Recurses
// into inline `z.object({...})` values via `.nested`.
function parseFields(body) {
  const fields = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body.startsWith("//", i)) {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
      continue;
    }
    const keyMatch = body.slice(i).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
    if (!keyMatch) {
      // Silently skipping here would let a field this scanner can't
      // recognize (a quoted/computed key, spread syntax, ...) vanish from
      // the extracted shape with no error — exactly the "wrong verdict, no
      // warning" failure mode this script exists to prevent. Fail loudly
      // instead: a human re-derives the shape by hand, same as shape drift.
      throw new Error(
        `parseFields: couldn't recognize a field key at offset ${i} ` +
          `(near ${JSON.stringify(body.slice(i, i + 40))}) — the object ` +
          `literal likely uses a quoted/computed key or spread syntax this ` +
          `scanner doesn't understand.`,
      );
    }
    const key = keyMatch[1];
    i += keyMatch[0].length;

    let depth = 0;
    const valStart = i;
    let optional = false;
    let nullable = false;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '"' || c === "'") {
        i = skipString(body, i) - 1;
        continue;
      }
      if (c === "/" && body[i + 1] === "/") {
        const nl = body.indexOf("\n", i);
        i = (nl === -1 ? body.length : nl) - 1;
        continue;
      }
      if (c === "/" && isRegexStart(body, i)) {
        i = skipRegex(body, i) - 1;
        continue;
      }
      if ("{([".includes(c)) depth++;
      else if ("})]".includes(c)) depth--;
      else if (depth === 0 && c === ",") break;
      if (depth === 0) {
        if (body.startsWith(".optional()", i)) optional = true;
        if (body.startsWith(".nullable()", i)) nullable = true;
      }
    }
    const raw = body.slice(valStart, i).trim();

    let nested = null;
    // Inline object values are sometimes written "z.object({" and sometimes
    // "z\n    .object({" (upstream's own formatting is inconsistent between
    // top-level consts and nested fields) — match whitespace-tolerantly.
    const nestedMatch = raw.match(/^z\s*\.\s*object\s*\(\s*\{/);
    if (nestedMatch) {
      let d = 1;
      let j = nestedMatch[0].length;
      for (; j < raw.length && d > 0; j++) {
        if (raw[j] === "{") d++;
        else if (raw[j] === "}") d--;
      }
      nested = parseFields(raw.slice(nestedMatch[0].length, j - 1));
    }

    fields.push({ key, optional, nullable, nested });
  }
  return fields;
}

function shapeOf(fields) {
  return fields.map((f) => ({
    key: f.key,
    optional: f.optional,
    nullable: f.nullable,
    nested: f.nested ? shapeOf(f.nested) : null,
  }));
}

function shapesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- upstream extraction -------------------------------------------------

function parseTsStringEnum(source, enumName) {
  const m = source.match(new RegExp(`export enum ${enumName} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`couldn't find "export enum ${enumName}" upstream`);
  const values = [...m[1].matchAll(/=\s*"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  if (values.length === 0) throw new Error(`"export enum ${enumName}" had no string members`);
  return values;
}

function parseInlineZodEnum(source, anchor) {
  const idx = source.indexOf(anchor);
  if (idx === -1) throw new Error(`couldn't find anchor for inline enum: ${anchor}`);
  const tail = source.slice(idx, idx + 500);
  const m = tail.match(/z\.enum\(\[([^\]]*)\]\)/);
  if (!m) throw new Error(`couldn't find z.enum([...]) after anchor: ${anchor}`);
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
}

async function fetchUpstream(tag) {
  const [mapsTs, gameTs, schemasTs] = await Promise.all([
    rawFile(tag, "src/core/game/Maps.gen.ts"),
    rawFile(tag, "src/core/game/Game.ts"),
    rawFile(tag, "src/core/Schemas.ts"),
  ]);

  // Extracted once and reused for both its shape and its nested enum below,
  // so DOOMSDAY_SPEED is anchored to the "speed:" field specifically within
  // this schema's own body — not "the first z.enum() found somewhere after
  // the schema name," which would silently grab the wrong array if the
  // schema were ever reordered or gained another enum-typed field first.
  const doomsdayClockBody = extractObjectBody(schemasTs, "DoomsdayClockConfigSchema");
  if (!doomsdayClockBody) throw new Error("couldn't find DoomsdayClockConfigSchema object body upstream");

  const enums = {
    GAME_MAP: parseTsStringEnum(mapsTs, "GameMapType"),
    DIFFICULTY: parseTsStringEnum(gameTs, "Difficulty"),
    GAME_TYPE: parseTsStringEnum(gameTs, "GameType"),
    GAME_MODE: parseTsStringEnum(gameTs, "GameMode"),
    RANKED_TYPE: parseTsStringEnum(gameTs, "RankedType"),
    GAME_MAP_SIZE: parseTsStringEnum(gameTs, "GameMapSize"),
    UNIT_TYPE: parseTsStringEnum(gameTs, "UnitType"),
    PUBLIC_GAME_TYPE: parseInlineZodEnum(schemasTs, "export const PublicGameTypeSchema ="),
    LOBBY_ACCENT: parseInlineZodEnum(schemasTs, "export const LobbyAccentSchema ="),
    DOOMSDAY_SPEED: parseInlineZodEnum(doomsdayClockBody, "speed:"),
    NATIONS_PRESET: parseInlineZodEnum(schemasTs, "nations: zb.union("),
  };

  // GameConfigSchema shape, with publicGameModifiers/hostCheats nested inline.
  const gameConfigBody = extractObjectBody(schemasTs, "GameConfigSchema");
  if (!gameConfigBody) throw new Error("couldn't find GameConfigSchema object body upstream");

  const doomsdayShape = shapeOf(parseFields(doomsdayClockBody));
  const overtimeShape = shapeOf(parseFields(extractObjectBody(schemasTs, "OvertimeConfigSchema")));

  // Unlike publicGameModifiers/hostCheats (inline z.object({...})), these two
  // fields reference a separately-declared schema by name, so parseFields
  // sees a bare identifier and leaves `nested` null. The local lobby-wire.js
  // side always recurses into a referenced obj([...]) const regardless of
  // whether upstream inlined it or not — so to compare like with like, patch
  // the same nested shape in by hand here.
  let gameConfigShape = shapeOf(parseFields(gameConfigBody)).map((f) => {
    if (f.key === "doomsdayClock") return { ...f, nested: doomsdayShape };
    if (f.key === "overtime") return { ...f, nested: overtimeShape };
    return f;
  });

  const publicGameInfoShape = shapeOf(parseFields(extractObjectBody(schemasTs, "PublicGameInfoSchema"))).map(
    (f) => (f.key === "gameConfig" ? { ...f, nested: gameConfigShape } : f),
  );

  const shape = {
    DoomsdayClockConfig: doomsdayShape,
    OvertimeConfig: overtimeShape,
    GameConfig: gameConfigShape,
    PublicGameInfo: publicGameInfoShape,
    PublicLobbyFull: shapeOf(parseFields(extractObjectBody(schemasTs, "PublicLobbyFullSchema"))),
    PublicLobbyCounts: shapeOf(parseFields(extractObjectBody(schemasTs, "PublicLobbyCountsSchema"))),
  };

  for (const [name, body] of Object.entries(shape)) {
    if (!body || body.length === 0) {
      throw new Error(`upstream shape for ${name} parsed empty — schema layout likely changed structurally`);
    }
  }

  return { enums, shape };
}

// --- local (lobby-wire.js) extraction -------------------------------------

function parseLocalEnumArray(wireSrc, constName) {
  const m = wireSrc.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`couldn't find "const ${constName} = [...]" in lobby-wire.js`);
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
}

// Parses `const Name = obj([ f("key", type, {opt:true,...}), ... ]);` into
// the same {key, optional, nullable, nested} shape as the upstream parser,
// resolving `type` references to other local obj([...]) consts by name so
// DoomsdayClockConfig / PublicGameModifiers / HostCheats nest the same way
// GameConfigSchema's inline objects do upstream.
function parseLocalObj(wireSrc, constName, seen = new Set()) {
  if (seen.has(constName)) throw new Error(`cycle while resolving local schema ${constName}`);
  seen.add(constName);

  const m = wireSrc.match(new RegExp(`const ${constName} = obj\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!m) throw new Error(`couldn't find "const ${constName} = obj([...])" in lobby-wire.js`);
  const body = m[1];

  const fields = [];
  const fCallRe = /f\(\s*"([^"]+)"\s*,/g;
  let match;
  while ((match = fCallRe.exec(body))) {
    const key = match[1];
    // Find this f(...) call's full argument list by depth-tracking from
    // the opening "(" right after "f".
    const openIdx = body.indexOf("(", match.index);
    let depth = 1;
    let i = openIdx + 1;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
    }
    const args = body.slice(openIdx + 1, i - 1);

    // Second positional arg is the type: either a bare identifier
    // referencing another local obj([...]) const, or an inline literal
    // (string/enum/union/etc. — doesn't nest further for our purposes).
    const restAfterKey = args.slice(args.indexOf(",") + 1).trim();
    const typeIdentMatch = restAfterKey.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    let nested = null;
    if (typeIdentMatch && new RegExp(`const ${typeIdentMatch[1]} = obj\\(`).test(wireSrc)) {
      nested = parseLocalObj(wireSrc, typeIdentMatch[1], seen);
    }

    const optional = /opt\s*:\s*true/.test(args);
    const nullable = /nul\s*:\s*true/.test(args);
    fields.push({ key, optional, nullable, nested });
  }
  return fields;
}

function parseLocal(wireSrc) {
  const enums = {
    GAME_MAP: parseLocalEnumArray(wireSrc, "GAME_MAP"),
    DIFFICULTY: parseLocalEnumArray(wireSrc, "DIFFICULTY"),
    GAME_TYPE: parseLocalEnumArray(wireSrc, "GAME_TYPE"),
    GAME_MODE: parseLocalEnumArray(wireSrc, "GAME_MODE"),
    RANKED_TYPE: parseLocalEnumArray(wireSrc, "RANKED_TYPE"),
    GAME_MAP_SIZE: parseLocalEnumArray(wireSrc, "GAME_MAP_SIZE"),
    UNIT_TYPE: parseLocalEnumArray(wireSrc, "UNIT_TYPE"),
    PUBLIC_GAME_TYPE: parseLocalEnumArray(wireSrc, "PUBLIC_GAME_TYPE"),
    LOBBY_ACCENT: parseLocalEnumArray(wireSrc, "LOBBY_ACCENT"),
    DOOMSDAY_SPEED: parseLocalEnumArray(wireSrc, "DOOMSDAY_SPEED"),
    NATIONS_PRESET: parseLocalEnumArray(wireSrc, "NATIONS_PRESET"),
  };

  const shape = {
    DoomsdayClockConfig: shapeOf(parseLocalObj(wireSrc, "DoomsdayClockConfig")),
    OvertimeConfig: shapeOf(parseLocalObj(wireSrc, "OvertimeConfig")),
    GameConfig: shapeOf(parseLocalObj(wireSrc, "GameConfig")),
    PublicGameInfo: shapeOf(parseLocalObj(wireSrc, "PublicGameInfo")),
    PublicLobbyFull: shapeOf(parseLocalObj(wireSrc, "PublicLobbyFull")),
    PublicLobbyCounts: shapeOf(parseLocalObj(wireSrc, "PublicLobbyCounts")),
  };

  return { enums, shape };
}

// --- rewriting -------------------------------------------------------------

function formatEnumArray(values) {
  // Match the file's existing style: wrapped ~4-per-line-ish via a plain
  // greedy fill, quoted, trailing comma. Good enough — Prettier (if the
  // repo ever adds it) would reformat on next run anyway.
  const quoted = values.map((v) => JSON.stringify(v));
  const lines = [];
  let line = "    ";
  for (const q of quoted) {
    const piece = q + ", ";
    if (line.length + piece.length > 78) {
      lines.push(line.trimEnd());
      line = "    ";
    }
    line += piece;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join("\n");
}

function rewriteEnumArray(wireSrc, constName, values) {
  const re = new RegExp(`(const ${constName} = \\[)[\\s\\S]*?(\\];)`);
  if (!re.test(wireSrc)) throw new Error(`rewrite: couldn't find const ${constName} again`);
  return wireSrc.replace(re, `$1\n${formatEnumArray(values)}\n  $2`);
}

// --- main --------------------------------------------------------------

async function main() {
  const release = await ghApi(`/repos/${REPO}/releases/latest`);
  const tag = release.tag_name;
  console.log(`Latest ${REPO} release: ${tag} (published ${release.published_at})`);

  const upstream = await fetchUpstream(tag);
  const wireSrc = readFileSync(WIRE_PATH, "utf8");
  const local = parseLocal(wireSrc);

  // 1. Structural drift check (never auto-fixed).
  let shapeDrift = false;
  for (const name of Object.keys(upstream.shape)) {
    if (!shapesEqual(upstream.shape[name], local.shape[name])) {
      shapeDrift = true;
      console.error(`\n=== SHAPE DRIFT: ${name} ===`);
      console.error("upstream:", JSON.stringify(upstream.shape[name], null, 2));
      console.error("local:   ", JSON.stringify(local.shape[name], null, 2));
    }
  }

  // 2. Enum diffs (mechanically safe to auto-fix).
  let newSrc = wireSrc;
  const changedEnums = [];
  for (const name of Object.keys(upstream.enums)) {
    const up = upstream.enums[name];
    const loc = local.enums[name];
    if (JSON.stringify(up) !== JSON.stringify(loc)) {
      changedEnums.push(name);
      console.log(`\n${name} differs (upstream has ${up.length}, local has ${loc.length}):`);
      console.log("  upstream:", up.join(", "));
      console.log("  local:   ", loc.join(", "));
      newSrc = rewriteEnumArray(newSrc, name, up);
    }
  }

  if (changedEnums.length > 0) {
    const syncedComment = /Last synced against openfrontio\/OpenFrontIO release .*\./;
    const newComment = `Last synced against openfrontio/OpenFrontIO release ${tag}.`;
    const fallbackAnchor = /(instead of throwing, so a map addition alone doesn't kill the dashboard\.\n)/;

    if (syncedComment.test(newSrc)) {
      newSrc = newSrc.replace(syncedComment, newComment);
    } else if (fallbackAnchor.test(newSrc)) {
      newSrc = newSrc.replace(fallbackAnchor, `$1//\n// ${newComment}\n`);
    } else {
      // .replace() on a non-matching pattern is a silent no-op, not an
      // error — without this check the enum tables would still get fixed
      // correctly, but the header comment would go stale with nothing in
      // the log to say so.
      console.warn(
        "\nWarning: couldn't find where to insert the \"Last synced\" " +
          "comment (neither the existing comment nor its fallback anchor " +
          "text matched). The enum tables below were still updated " +
          "correctly — only the header comment is now stale. Update it by hand.",
      );
    }

    writeFileSync(WIRE_PATH, newSrc);
    console.log(`\nRewrote lobby-wire.js: ${changedEnums.join(", ")}`);
  } else {
    console.log("\nAll enum tables already match upstream.");
  }

  if (shapeDrift) {
    console.error(
      "\nGameConfig-family object shape changed upstream. This needs a human " +
        "to re-derive the field list by hand (a wrong auto-guess here would " +
        "silently misalign every field decoded after the changed one, which " +
        "is worse than leaving it stale) — see the diffs above. Failing.",
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("resync failed:", err.stack || err.message);
  process.exit(1);
});
