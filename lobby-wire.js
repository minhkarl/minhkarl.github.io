// Decoder for OpenFront's /lobbies WebSocket, which now speaks "zbin" — the
// game's custom binary serialization (see OpenFrontIO/zbin) — instead of JSON.
//
// A zbin payload is a bare positional byte stream with no version byte and no
// field tags: the schema IS the format. This file mirrors the exact wire
// layout of PublicLobbyMessageSchema in OpenFrontIO/src/core/Schemas.ts:
//
//   frame        = varint union tag (0 = "full", 1 = "counts") + object body
//   object       = ceil(bits/8) presence-header bytes, then field bodies in
//                  declaration order. Bits are allocated per field, in
//                  declaration order, as (presence, null, bool-value) and
//                  packed LSB-first. Booleans and single-value literals write
//                  no body bytes.
//   varint       = unsigned LEB128 (arithmetic, full 2^53 range)
//   string       = varint byte length + UTF-8
//   float        = float64 little-endian (8 bytes)
//   enum         = varint ordinal in declaration order
//   array        = varint count + elements
//   record       = varint count + (key, value) pairs; keys are enum ordinals
//                  for partialRecord(enum, …) or plain strings otherwise
//   union        = varint variant tag + variant body
//
// Because the game pins client and server to one build, adding/reordering any
// schema field or enum member changes the layout. When the game updates,
// re-derive the tables below from Schemas.ts / Game.ts / Maps.gen.ts.
// Unknown enum ordinals (e.g. a newly added map) decode to "unknown#<n>"
// instead of throwing, so a map addition alone doesn't kill the dashboard.
(function (global) {
  "use strict";

  // --- Enum tables (declaration order = wire ordinal) -----------------------

  // src/core/game/Maps.gen.ts — GameMapType
  const GAME_MAP = [
    "Achiran", "Aegean", "Africa", "Alps", "Amazon River", "Antarctica",
    "ArchipelagoSea", "Arctic", "Asia", "Australia", "Baikal",
    "Baikal Nuke Wars", "Baja California", "Balkans", "Balkhash", "Baltics",
    "Bering Sea", "Bering Strait", "Between Two Seas", "Black Sea",
    "Bosphorus Straits", "Branching Paths", "Britannia", "Britannia Classic",
    "Caribbean", "Caspian Sea", "Caucasus", "China", "Chopping Block",
    "Clearwater Lakes", "Conakry", "Crimea", "Danish Straits",
    "Deglaciated Antarctica", "Didier", "Didier France", "Dyslexdria",
    "East Asia", "Europe", "Europe Classic", "Falkland Islands",
    "Faroe Islands", "Finger Lakes", "Four Islands", "France",
    "Gateway to the Atlantic", "Germany", "Giant World Map", "Great Lakes",
    "Gulf Of Guinea", "Gulf of St. Lawrence", "Halkidiki", "Hawaii",
    "Hecate Strait", "Hong Kong", "Iceland", "Indian Subcontinent",
    "Irish Sea", "Italia", "Japan", "Juan De Fuca Strait", "Korea",
    "Labyrinth", "Las Vegas Strip", "Lemnos", "Levant", "Lisbon",
    "Los Angeles", "Luna", "Manicouagan", "Mare Nostrum", "Mars", "Mena",
    "Middle East", "MilkyWay", "Mississippi River", "Montreal",
    "More Than Luck", "New York City", "Nile Delta", "North America",
    "Northwest Passage", "Oceania", "Onion", "Pangaea", "Passage", "Pluto",
    "Russia", "San Francisco", "Scandinavia", "Sierpinski", "Sol",
    "South America", "SoutheastAsia", "Strait of Gibraltar",
    "Strait of Hormuz", "Strait Of Malacca", "Surrounded", "Svalmel",
    "Taiwan Strait", "The Box", "Tierra Del Fuego", "Titan",
    "Tourney 2 Teams", "Tourney 3 Teams", "Tourney 4 Teams",
    "Tourney 8 Teams", "Traders Dream", "Two Lakes", "United States",
    "Venice", "Vietnam", "Warship Warship", "World", "World Inverted",
    "Yangtze River", "Yellow Sea", "Yenisei",
  ];

  // src/core/game/Game.ts
  const DIFFICULTY = ["Easy", "Medium", "Hard", "Impossible"];
  const GAME_TYPE = ["Singleplayer", "Public", "Private"];
  const GAME_MODE = ["Free For All", "Team"];
  const RANKED_TYPE = ["1v1", "2v2"];
  const GAME_MAP_SIZE = ["Compact", "Normal"];
  const UNIT_TYPE = [
    "Transport", "Warship", "Shell", "SAMMissile", "Port", "Atom Bomb",
    "Hydrogen Bomb", "Trade Ship", "Missile Silo", "Defense Post",
    "SAM Launcher", "City", "MIRV", "MIRV Warhead", "Train", "Factory",
  ];

  // src/core/Schemas.ts
  const PUBLIC_GAME_TYPE = ["ffa", "team", "special", "hosted"];
  const LOBBY_ACCENT = ["gold", "blue", "green", "red"];
  const DOOMSDAY_SPEED = ["slow", "normal", "fast", "veryfast"];
  const NATIONS_PRESET = ["default", "disabled"];

  // --- Byte reader -----------------------------------------------------------

  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;

  class ZbinDecodeError extends Error {
    constructor(message) {
      super(message);
      this.name = "ZbinDecodeError";
    }
  }

  class Reader {
    constructor(buf) {
      this.buf = buf;
      this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.pos = 0;
    }
    get remaining() {
      return this.buf.length - this.pos;
    }
    need(n) {
      if (this.pos + n > this.buf.length) {
        throw new ZbinDecodeError("unexpected end of input");
      }
    }
    u8() {
      this.need(1);
      return this.buf[this.pos++];
    }
    uint() {
      let result = 0;
      let mult = 1;
      for (;;) {
        const b = this.u8();
        result += (b & 0x7f) * mult;
        if ((b & 0x80) === 0) break;
        mult *= 0x80;
        if (mult > MAX_SAFE) throw new ZbinDecodeError("varint too large");
      }
      if (result > MAX_SAFE) throw new ZbinDecodeError("varint too large");
      return result;
    }
    f64() {
      this.need(8);
      const v = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return v;
    }
    str() {
      const len = this.uint();
      this.need(len);
      try {
        return textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
      } finally {
        this.pos += len;
      }
    }
    count(path) {
      const n = this.uint();
      // Every element here costs at least one byte, so a count past the
      // remaining input is corrupt — refuse before allocating.
      if (n > this.remaining) {
        throw new ZbinDecodeError(`${path}: implausible count ${n}`);
      }
      return n;
    }
    expectEnd() {
      if (this.remaining !== 0) {
        throw new ZbinDecodeError(`${this.remaining} trailing byte(s)`);
      }
    }
  }

  // --- Mini schema interpreter (mirrors zbin's derived codecs) ---------------

  // Field: { key, type, opt, nul }. Types:
  //   "uint" | "f64" | "str" | "bool"
  //   { enum: [...] } | { const: value } | { obj: fields }
  //   { arr: type } | { recordEnum: [keys], val: type } | { recordStr: type }
  //   { union: [types] }
  const f = (key, type, mods) => ({
    key,
    type,
    opt: !!(mods && mods.opt),
    nul: !!(mods && mods.nul),
  });

  function decodeEnum(r, values, path) {
    const idx = r.uint();
    // Tolerated (unlike the game client): a newly shipped map or unit only
    // makes this ordinal unknown, and the dashboard can still render the rest.
    return idx < values.length ? values[idx] : `unknown#${idx}`;
  }

  function decodeValue(r, type, path) {
    if (type === "uint") return r.uint();
    if (type === "f64") return r.f64();
    if (type === "str") return r.str();
    if (type === "bool") {
      const b = r.u8();
      if (b > 1) throw new ZbinDecodeError(`${path}: invalid boolean ${b}`);
      return b === 1;
    }
    if (type.enum) return decodeEnum(r, type.enum, path);
    if ("const" in type) return type.const;
    if (type.obj) return decodeObject(r, type.obj, path);
    if (type.arr) {
      const n = r.count(path);
      const out = [];
      for (let i = 0; i < n; i++) out.push(decodeValue(r, type.arr, path + "[]"));
      return out;
    }
    if (type.recordEnum) {
      const n = r.count(path);
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = decodeEnum(r, type.recordEnum, path + "{key}");
        out[k] = decodeValue(r, type.val, path + "{}");
      }
      return out;
    }
    if (type.recordStr) {
      const n = r.count(path);
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = r.str();
        if (k === "__proto__") {
          throw new ZbinDecodeError(`${path}: forbidden key __proto__`);
        }
        out[k] = decodeValue(r, type.recordStr, path + "{}");
      }
      return out;
    }
    if (type.union) {
      const idx = r.uint();
      if (idx >= type.union.length) {
        throw new ZbinDecodeError(`${path}: union tag ${idx} out of range`);
      }
      return decodeValue(r, type.union[idx], `${path}|${idx}`);
    }
    throw new ZbinDecodeError(`${path}: bad type descriptor`);
  }

  // Mirrors zbin objectCodec: allocate bits per field in declaration order as
  // (presence, null, bool-value); header is ceil(bits/8) bytes, LSB-first.
  function planObject(fields) {
    let bits = 0;
    const plans = fields.map((field) => {
      const isBool = field.type === "bool";
      const isConst = typeof field.type === "object" && "const" in field.type;
      return {
        field,
        isBool,
        isConst,
        presenceBit: field.opt ? bits++ : -1,
        nullBit: field.nul ? bits++ : -1,
        valueBit: isBool ? bits++ : -1,
      };
    });
    return { plans, headerBytes: Math.ceil(bits / 8) };
  }

  function decodeObject(r, objSpec, path) {
    const { plans, headerBytes } = objSpec._plan || (objSpec._plan = planObject(objSpec.fields));
    r.need(headerBytes);
    const header = r.buf.subarray(r.pos, r.pos + headerBytes);
    r.pos += headerBytes;
    const bit = (i) => (header[i >> 3] & (1 << (i & 7))) !== 0;

    const out = {};
    for (const p of plans) {
      const field = p.field;
      if (p.presenceBit >= 0 && !bit(p.presenceBit)) continue;
      if (p.nullBit >= 0 && bit(p.nullBit)) {
        out[field.key] = null;
        continue;
      }
      if (p.isBool) {
        out[field.key] = bit(p.valueBit);
      } else if (p.isConst) {
        out[field.key] = field.type.const;
      } else {
        out[field.key] = decodeValue(r, field.type, `${path}.${field.key}`);
      }
    }
    return out;
  }

  const obj = (fields) => ({ obj: { fields } });

  // --- Schemas (field order = Schemas.ts declaration order) ------------------

  const DoomsdayClockConfig = obj([
    f("enabled", "bool", { opt: true }),
    f("speed", { enum: DOOMSDAY_SPEED }, { opt: true }),
  ]);

  const OvertimeConfig = obj([
    f("enabled", "bool", { opt: true }),
    f("startMinutes", "uint", { opt: true }),
  ]);

  const PublicGameModifiers = obj([
    f("isCompact", "bool", { opt: true }),
    f("isRandomSpawn", "bool", { opt: true }),
    f("isCrowded", "bool", { opt: true }),
    f("isHardNations", "bool", { opt: true }),
    f("startingGold", "uint", { opt: true }),
    f("goldMultiplier", "f64", { opt: true }),
    f("isAlliancesDisabled", "bool", { opt: true }),
    f("isPortsDisabled", "bool", { opt: true }),
    f("isNukesDisabled", "bool", { opt: true }),
    f("isSAMsDisabled", "bool", { opt: true }),
    f("isPeaceTime", "bool", { opt: true }),
    f("isWaterNukes", "bool", { opt: true }),
    f("isDoomsdayClock", "bool", { opt: true }),
    f("isOvertime", "bool", { opt: true }),
  ]);

  const HostCheats = obj([
    f("infiniteGold", "bool", { opt: true }),
    f("infiniteTroops", "bool", { opt: true }),
    f("goldMultiplier", "f64", { opt: true, nul: true }),
    f("startingGold", "uint", { opt: true, nul: true }),
  ]);

  const GameConfig = obj([
    f("gameMap", { enum: GAME_MAP }),
    f("difficulty", { enum: DIFFICULTY }),
    f("donateGold", "bool"),
    f("donateTroops", "bool"),
    f("gameType", { enum: GAME_TYPE }),
    f("gameMode", { enum: GAME_MODE }),
    f("rankedType", { enum: RANKED_TYPE }, { opt: true }),
    f("gameMapSize", { enum: GAME_MAP_SIZE }),
    f("doomsdayClock", DoomsdayClockConfig, { opt: true }),
    f("overtime", OvertimeConfig, { opt: true }),
    f("publicGameModifiers", PublicGameModifiers, { opt: true }),
    f("nations", { union: ["uint", { enum: NATIONS_PRESET }] }),
    f("bots", "uint"),
    f("infiniteGold", "bool"),
    f("infiniteTroops", "bool"),
    f("instantBuild", "bool"),
    f("disableNavMesh", "bool", { opt: true }),
    f("disableAlliances", "bool", { opt: true, nul: true }),
    f("disableClanTags", "bool", { opt: true }),
    f("liveStatsEnabled", "bool", { opt: true }),
    f("anonymizeNames", "bool", { opt: true }),
    f("nameReveals", { arr: "str" }, { opt: true }),
    f("nameRevealPublicIds", { arr: "str" }, { opt: true }),
    f("waterNukes", "bool", { opt: true, nul: true }),
    f("randomSpawn", "bool"),
    f("maxPlayers", "uint", { opt: true }),
    f("allowedPublicIds", { arr: "str" }, { opt: true }),
    f("maxTimerValue", "uint", { opt: true, nul: true }),
    f("customAllianceDuration", "uint", { opt: true, nul: true }),
    f("startDelay", "uint", { opt: true, nul: true }),
    f("spawnImmunityDuration", "uint", { opt: true, nul: true }),
    f("disabledUnits", { arr: { enum: UNIT_TYPE } }, { opt: true }),
    // TeamCountConfig: uint | "Duos" | "Trios" | "Quads" | "Humans Vs Nations"
    f(
      "playerTeams",
      {
        union: [
          "uint",
          { const: "Duos" },
          { const: "Trios" },
          { const: "Quads" },
          { const: "Humans Vs Nations" },
        ],
      },
      { opt: true },
    ),
    f("goldMultiplier", "f64", { opt: true, nul: true }),
    f("startingGold", "uint", { opt: true, nul: true }),
    f("hostCheats", HostCheats, { opt: true }),
  ]);

  const PublicGameInfo = obj([
    f("gameID", "str"),
    f("numClients", "uint"),
    f("startsAt", "uint", { opt: true }),
    f("gameConfig", GameConfig, { opt: true }),
    f("publicGameType", { enum: PUBLIC_GAME_TYPE }),
    f("label", "str", { opt: true }),
    f("accent", { enum: LOBBY_ACCENT }, { opt: true }),
    f("featured", "bool", { opt: true }),
  ]);

  const PublicLobbyFull = obj([
    f("type", { const: "full" }),
    f("serverTime", "uint"),
    f("games", { recordEnum: PUBLIC_GAME_TYPE, val: { arr: PublicGameInfo } }),
  ]);

  const PublicLobbyCounts = obj([
    f("type", { const: "counts" }),
    f("serverTime", "uint"),
    f("counts", { recordStr: "uint" }),
  ]);

  const LOBBY_VARIANTS = [PublicLobbyFull, PublicLobbyCounts];

  function decodeLobbyMessage(bytes) {
    const r = new Reader(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    const tag = r.uint();
    if (tag >= LOBBY_VARIANTS.length) {
      throw new ZbinDecodeError(`lobby message tag ${tag} out of range`);
    }
    const msg = decodeValue(r, LOBBY_VARIANTS[tag], "$");
    r.expectEnd();
    return msg;
  }

  const api = { decodeLobbyMessage, ZbinDecodeError };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.OpenFrontWire = api;
})(typeof window !== "undefined" ? window : globalThis);
