// Shared lobby filter/sort logic for openfront-lobby-overlay.user.js — the
// matching rules mirror index.html's original filter panel (app.js) exactly,
// so a profile or filter set behaves the same whether it's applied on the
// site or from inside the overlay. Pure: no DOM, no state, so both callers
// can wrap it in whatever UI they have.
(function (global) {
  "use strict";

  const TRI = { NONE: "none", OR: "or", AND: "and", NOT: "not" };

  function normalizeModifierRule(value) {
    if (value === TRI.OR || value === "in") return TRI.OR;
    if (value === TRI.AND || value === "need" || value === "yes") return TRI.AND;
    if (value === TRI.NOT || value === "out" || value === "no") return TRI.NOT;
    return TRI.NONE;
  }

  function getCfg(g) { return g?.cfg || g?.gameConfig || null; }
  function getPm(g) { return g?.pm || g?.gameConfig?.publicGameModifiers || null; }

  function getPmTrue(g, key) {
    const pm = getPm(g);
    if (!pm || !(key in pm)) return null;
    return pm[key] === true;
  }

  function getAnyTrue(g, sources) {
    const pm = getPm(g);
    const cfg = getCfg(g);
    for (const [where, key] of sources) {
      const obj = where === "pm" ? pm : cfg;
      if (!obj || !(key in obj)) continue;
      if (obj[key] === true) return true;
    }
    return null;
  }

  function getNumber(g, key) {
    const pm = getPm(g);
    if (pm && typeof pm[key] === "number") return pm[key];
    const cfg = getCfg(g);
    if (cfg && typeof cfg[key] === "number") return cfg[key];
    return null;
  }

  // Public-queue (ffa/team/special) modifier toggles, surfaced on
  // publicGameModifiers per getActiveModifiers() (src/client/Utils.ts), plus
  // a few extra fields (ranked, nations, host cheats) that aren't modifiers
  // there but are still useful to filter on here.
  const boolFilters = [
    { id: "isCompact", label: "Compact Map", get: (g) => getPmTrue(g, "isCompact") },
    { id: "isCrowded", label: "Crowded", get: (g) => getPmTrue(g, "isCrowded") },
    { id: "randomSpawn", label: "Random Spawn", get: (g) => getAnyTrue(g, [["pm", "isRandomSpawn"], ["cfg", "randomSpawn"]]) },
    { id: "isAlliancesDisabled", label: "Alliances Disabled", get: (g) => getPmTrue(g, "isAlliancesDisabled") },
    { id: "isNukesDisabled", label: "Nukes Disabled", get: (g) => getPmTrue(g, "isNukesDisabled") },
    { id: "isPortsDisabled", label: "Ports Disabled", get: (g) => getPmTrue(g, "isPortsDisabled") },
    { id: "isSAMsDisabled", label: "SAMs Disabled", get: (g) => getPmTrue(g, "isSAMsDisabled") },
    { id: "waterNukes", label: "Water Nukes", get: (g) => getAnyTrue(g, [["pm", "isWaterNukes"], ["cfg", "waterNukes"]]) },
    { id: "isPeaceTime", label: "Peace Time", get: (g) => getPmTrue(g, "isPeaceTime") },
    { id: "isHardNations", label: "Hard Nations", get: (g) => getPmTrue(g, "isHardNations") },
    { id: "nationsDisabled", label: "Nations Disabled", get: (g) => (getCfg(g)?.nations === "disabled" ? true : null) },
    { id: "isDoomsdayClock", label: "Doomsday Clock", get: (g) => getPmTrue(g, "isDoomsdayClock") },
    { id: "isOvertime", label: "Overtime", get: (g) => getPmTrue(g, "isOvertime") },
    { id: "rankedType", label: "Ranked", get: (g) => (getCfg(g)?.rankedType ? true : null) },
  ];

  const numExact = [
    { id: "goldMultiplier_eq_2", label: "2× Gold", key: "goldMultiplier", exact: 2 },
    { id: "startingGold_eq_1000000", label: "1M Starting Gold", key: "startingGold", exact: 1000000 },
    { id: "startingGold_eq_5000000", label: "5M Starting Gold", key: "startingGold", exact: 5000000 },
    { id: "startingGold_eq_25000000", label: "25M Starting Gold", key: "startingGold", exact: 25000000 },
  ];

  // Fields that only ever come from a player-hosted ("Custom") lobby's own
  // config, not the fixed public matchmaking presets.
  const OTHER_DISABLABLE_UNITS = [
    "Transport", "Warship", "Shell", "SAMMissile", "Hydrogen Bomb",
    "Trade Ship", "Missile Silo", "Defense Post", "SAM Launcher", "City",
    "MIRV", "MIRV Warhead", "Train", "Factory",
  ];

  const privateBoolFilters = [
    {
      id: "hostCheats",
      label: "Host Cheats",
      get: (g) => {
        const hc = getCfg(g)?.hostCheats;
        if (!hc) return null;
        return hc.infiniteGold === true ||
          hc.infiniteTroops === true ||
          hc.goldMultiplier != null ||
          hc.startingGold != null
          ? true
          : null;
      },
    },
    { id: "customAllianceDuration", label: "Custom Alliance Duration", get: (g) => (getCfg(g)?.customAllianceDuration != null ? true : null) },
    { id: "startDelay", label: "Custom Start Delay", get: (g) => (getCfg(g)?.startDelay != null ? true : null) },
    { id: "spawnImmunityDuration", label: "Custom Spawn Immunity", get: (g) => (getCfg(g)?.spawnImmunityDuration != null ? true : null) },
    { id: "maxTimerValue", label: "Custom Max Timer", get: (g) => (getCfg(g)?.maxTimerValue != null ? true : null) },
    ...OTHER_DISABLABLE_UNITS.map((unit) => ({
      id: `unitDisabled_${unit.replace(/\s+/g, "")}`,
      label: `${unit} Disabled`,
      get: (g) => {
        const disabled = getCfg(g)?.disabledUnits;
        return Array.isArray(disabled) && disabled.includes(unit) ? true : null;
      },
    })),
  ];

  function parseNum(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Normalizes one raw PublicGameInfo (as decoded by lobby-wire.js) into the
  // shape every matcher/sorter below reads. `raw` keeps the original object
  // so a caller can render from it once filtering picks it.
  function normalizeGame(g, rawType) {
    const cfg = g?.gameConfig || {};
    const pm = cfg.publicGameModifiers || {};
    const joined = Number(g?.numClients ?? 0);
    const maxPlayers = typeof cfg.maxPlayers === "number" ? cfg.maxPlayers : null;

    const teamValue = cfg.playerTeams ?? null;
    const teamCount = typeof teamValue === "number" ? teamValue : null;
    const compactTeam = String(teamValue ?? "").trim().replace(/\s+/g, "").toLowerCase();

    let format = null;
    if (compactTeam === "duos") format = "Duos";
    else if (compactTeam === "trios") format = "Trios";
    else if (compactTeam === "quads") format = "Quads";
    else if (compactTeam === "humansvsnations") format = "HumansVsNations";

    const effectiveRawType = rawType ?? g?.__rawType ?? g?.publicGameType;
    const kind = teamCount && teamCount > 1 ? "team" : (format ? "team" : (effectiveRawType === "team" ? "team" : "ffa"));

    return {
      raw: g,
      rawType: effectiveRawType,
      cfg,
      pm,
      id: String(g?.gameID ?? ""),
      map: String(cfg.gameMap ?? "—"),
      joined,
      maxPlayers,
      kind,
      teamCount,
      playersPerTeam:
        format === "Duos" ? 2 :
        format === "Trios" ? 3 :
        format === "Quads" ? 4 :
        (typeof teamCount === "number" && maxPlayers !== null && teamCount > 0 ? maxPlayers / teamCount : null),
      format,
      startsAt: g?.startsAt ?? null,
    };
  }

  function getLobbyKind(g) {
    return g?.kind || "ffa";
  }

  // The "Type" filter treats Humans vs Nations as its own type, separate
  // from plain Teams (matches the FFA / Teams / Humans vs Nations choices).
  function getLobbyType(g) {
    return g?.format === "HumansVsNations" ? "humansVsNations" : getLobbyKind(g);
  }

  function matchTeamsFilter(g, teamFilters) {
    if (!teamFilters || teamFilters.length === 0) return true;

    const teams = g.teamCount ?? g.raw?.gameConfig?.playerTeams ?? null;
    if (teams === null && !g.format) return false;

    for (const value of teamFilters) {
      if (value.startsWith("teams:")) {
        const n = Number(value.split(":")[1]);
        if (typeof teams === "number" && teams === n) return true;
      } else if (value.startsWith("format:")) {
        const want = value.split(":")[1];
        if (g.format === want) return true;
      }
    }

    return false;
  }

  function matchPlayerFilters(g, f) {
    const joined = g.joined ?? 0;
    const maxPlayers = g.maxPlayers;

    if (f.minJoined !== null && joined < f.minJoined) return false;
    if (f.maxJoined !== null && joined > f.maxJoined) return false;

    if (f.maxPlayersEq !== null) {
      if (maxPlayers === null) return false;
      if (maxPlayers !== f.maxPlayersEq) return false;
    }

    if (f.minMaxPlayers !== null) {
      if (maxPlayers === null) return false;
      if (maxPlayers < f.minMaxPlayers) return false;
    }

    if (f.maxMaxPlayers !== null) {
      if (maxPlayers === null) return false;
      if (maxPlayers > f.maxMaxPlayers) return false;
    }

    if (f.minPerTeam !== null || f.maxPerTeam !== null) {
      const perTeam = g.playersPerTeam;
      if (perTeam === null || perTeam === undefined) return false;
      if (f.minPerTeam !== null && perTeam < f.minPerTeam) return false;
      if (f.maxPerTeam !== null && perTeam > f.maxPerTeam) return false;
    }

    return true;
  }

  function matchModifierFilters(g, triState) {
    const entries = [
      ...boolFilters.map((bf) => [bf.id, bf.get(g.raw ?? g) === true]),
      ...privateBoolFilters.map((bf) => [bf.id, bf.get(g.raw ?? g) === true]),
      ...numExact.map((nf) => [nf.id, getNumber(g.raw ?? g, nf.key) === nf.exact]),
    ];

    let hasOrRule = false;
    let matchedOrRule = false;

    for (const [id, matched] of entries) {
      const rule = normalizeModifierRule(triState.get(id));

      if (rule === TRI.NOT && matched) return false;
      if (rule === TRI.AND && !matched) return false;

      if (rule === TRI.OR) {
        hasOrRule = true;
        if (matched) matchedOrRule = true;
      }
    }

    return !hasOrRule || matchedOrRule;
  }

  function matchAllFilters(g, f, triState) {
    if (f.type !== "all" && getLobbyType(g) !== f.type) return false;
    if (f.hideEmpty && (g.joined ?? 0) === 0) return false;

    if (!matchTeamsFilter(g, f.teamFilters)) return false;
    if (!matchPlayerFilters(g, f)) return false;
    if (!matchModifierFilters(g, triState)) return false;

    return true;
  }

  function sortGames(games, sort) {
    const getMax = (g) => (typeof g.maxPlayers === "number" ? g.maxPlayers : -1);

    const primary =
      {
        players_desc: (a, b) => (b.joined ?? 0) - (a.joined ?? 0),
        players_asc: (a, b) => (a.joined ?? 0) - (b.joined ?? 0),
        maxPlayers_desc: (a, b) => getMax(b) - getMax(a),
        maxPlayers_asc: (a, b) => getMax(a) - getMax(b),
        // Two lobbies with no startsAt both fall back to Infinity here,
        // making this NaN (Infinity - Infinity) for that pair — see the
        // tiebreak below for why that matters.
        starts_asc: (a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity),
        map_asc: (a, b) => String(a.map ?? "").localeCompare(String(b.map ?? "")),
      }[sort] || ((a, b) => (b.joined ?? 0) - (a.joined ?? 0));

    // A tied (or NaN) primary result falls through to id order instead of
    // leaving the outcome to whatever order the two lobbies happened to
    // arrive in on this particular snapshot. Without this, two lobbies that
    // tie on the active sort key — most commonly two "Open" custom lobbies,
    // both startsAt: null — visibly swap places whenever the server's own
    // array order between them flips, since a comparator returning 0 or NaN
    // gives JS's sort nothing to anchor on.
    const cmp = (a, b) => primary(a, b) || String(a.id ?? "").localeCompare(String(b.id ?? ""));

    return games.slice().sort(cmp);
  }

  function defaultFilters() {
    return {
      type: "all",
      hideEmpty: false,
      teamFilters: [],
      sort: "starts_asc",
      minJoined: null,
      maxJoined: null,
      maxPlayersEq: null,
      minMaxPlayers: null,
      maxMaxPlayers: null,
      minPerTeam: null,
      maxPerTeam: null,
    };
  }

  function initTriState() {
    const tri = new Map();
    for (const f of boolFilters) tri.set(f.id, TRI.NONE);
    for (const f of privateBoolFilters) tri.set(f.id, TRI.NONE);
    for (const n of numExact) tri.set(n.id, TRI.NONE);
    return tri;
  }

  const api = {
    TRI,
    normalizeModifierRule,
    boolFilters,
    numExact,
    privateBoolFilters,
    parseNum,
    normalizeGame,
    getLobbyKind,
    getLobbyType,
    matchTeamsFilter,
    matchPlayerFilters,
    matchModifierFilters,
    matchAllFilters,
    sortGames,
    defaultFilters,
    initTriState,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.OpenFrontLobbyFilters = api;
})(typeof window !== "undefined" ? window : globalThis);
