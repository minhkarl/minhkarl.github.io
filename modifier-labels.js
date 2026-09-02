// Shared modifier-badge label logic for index.html and
// openfront-lobby-overlay.user.js — a single source of truth so the two
// don't silently drift the way lobby-wire.js's hand-transcribed tables used
// to before it was resynced against upstream.
//
// Labels mirror OpenFront's own getActiveModifiers() (src/client/Utils.ts) so
// they match the in-game lobby badges, plus a few extra fields (ranked type,
// nations, host cheats) that function doesn't cover but are still useful to
// surface here.
(function (global) {
  "use strict";

  function compactNumber(value) {
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) >= 1000000) {
      const n = value / 1000000;
      return `${Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (Math.abs(value) >= 1000) {
      const n = value / 1000;
      return `${Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, "")}K`;
    }
    return String(value);
  }

  // cfg is a GameConfig object (PublicGameInfo.gameConfig). startingGold and
  // goldMultiplier can live in either of two places depending on how the
  // lobby was created: automated public-queue games (ffa/team/special) set
  // them on publicGameModifiers, matching getActiveModifiers() exactly — but
  // player-hosted (Custom) lobbies never populate publicGameModifiers at
  // all; HostLobbyModal.ts writes these two fields directly on GameConfig's
  // own top level instead. Checking only publicGameModifiers (as
  // getActiveModifiers does) silently drops these badges for every hosted
  // lobby, so fall back to the top-level fields too.
  function gameModifierLabels(cfg) {
    cfg = cfg || {};
    const pm = cfg.publicGameModifiers || {};
    const disabled = Array.isArray(cfg.disabledUnits) ? cfg.disabledUnits : [];
    const labels = [];

    const startingGold = cfg.startingGold ?? pm.startingGold;
    if (Number.isFinite(startingGold) && startingGold > 0) {
      labels.push(`${compactNumber(startingGold)} Starting Gold`);
    }
    const goldMultiplier = cfg.goldMultiplier ?? pm.goldMultiplier;
    if (Number.isFinite(goldMultiplier) && goldMultiplier !== 1) {
      labels.push(`${goldMultiplier}× Gold`);
    }

    if (pm.isRandomSpawn === true || cfg.randomSpawn === true) labels.push("Random Spawn");
    if (pm.isCompact === true || cfg.gameMapSize === "Compact") labels.push("Compact Map");
    if (pm.isCrowded === true) labels.push("Crowded");
    if (pm.isHardNations === true) labels.push("Hard Nations");
    if (pm.isAlliancesDisabled === true || cfg.disableAlliances === true) labels.push("Alliances Disabled");
    if (pm.isPortsDisabled === true || disabled.includes("Port")) labels.push("Ports Disabled");
    if (pm.isNukesDisabled === true || disabled.includes("Atom Bomb")) labels.push("Nukes Disabled");
    if (pm.isSAMsDisabled === true) labels.push("SAMs Disabled");
    if (pm.isPeaceTime === true) labels.push("4min Peace");
    if (pm.isWaterNukes === true || cfg.waterNukes === true) labels.push("Water Nukes");
    if (pm.isDoomsdayClock === true) {
      const speedLabels = { slow: "Slow", normal: "Normal", fast: "Fast", veryfast: "Very Fast" };
      const speed = cfg.doomsdayClock?.speed;
      labels.push(speed ? `Doomsday Clock (${speedLabels[speed] || speed})` : "Doomsday Clock");
    }
    if (pm.isOvertime === true) {
      const startMinutes = cfg.overtime?.startMinutes;
      labels.push(Number.isFinite(startMinutes) ? `Overtime (${startMinutes}m)` : "Overtime");
    }
    if (cfg.rankedType) labels.push(`Ranked ${cfg.rankedType}`);

    if (typeof cfg.nations === "number") labels.push(`${cfg.nations} Nations`);
    else if (cfg.nations === "disabled") labels.push("Nations Disabled");

    const hc = cfg.hostCheats;
    if (hc && (hc.infiniteGold === true || hc.infiniteTroops === true || hc.goldMultiplier != null || hc.startingGold != null)) {
      labels.push("Host Cheats");
    }

    return labels;
  }

  const api = { gameModifierLabels, compactNumber };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.OpenFrontModifierLabels = api;
})(typeof window !== "undefined" ? window : globalThis);
