// ==UserScript==
// @name         OpenFront Lobby Overlay
// @namespace    https://minhkarl.github.io
// @version      1.7.21
// @description  Replaces OpenFront's home-screen lobby preview cards with the richer minhkarl.github.io dashboard cards, and removes the JOIN LOBBY button.
// @match        https://openfront.io/*
// @run-at       document-idle
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/lobby-wire.js
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/modifier-labels.js
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/lobby-filters.js
// @updateURL    https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js
// @grant        GM_xmlhttpRequest
// @connect      trackerfront.com
// ==/UserScript==

(function () {
  "use strict";

  // OpenFront's multi-server rollout (docs/MultiServer.md) means there is no
  // fixed lobby host any more — window.BOOTSTRAP_CONFIG on the real client
  // carries none of numWorkers/serverHost/cluster (confirmed live
  // 2026-09-20: DevTools showed only gitCommit/assetManifest/cdnBase/gameEnv/
  // jwtAudience/stripePublishableKey/turnstileSiteKey), so a page has to ask
  // the same API the game's own ClientEnv/ServerList does: which servers
  // exist right now, and how many workers each one runs. This is the actual
  // fix for the "reconnecting forever" failure — a red herring earlier in
  // this file's history briefly blamed a Tampermonkey sandbox/origin issue
  // (@grant unsafeWindow), but every wss://openfront.io/w{N}/lobbies attempt
  // was failing because openfront.io itself is no longer a real game server
  // to connect to, not because of which realm the socket opened from.
  //
  // Cached briefly so a burst of reconnects doesn't refetch on every
  // attempt; a server "draining" or "fenced" still serves a live lobby list
  // even though it won't take a new game, so only "no servers at all" falls
  // through to the pre-multi-server guess below.
  const CLUSTER_LIST_URL = "https://api.openfront.io/cluster.json?site=openfront.io";
  const SERVER_CACHE_MS = 30_000;
  let serverCache = null; // { host, numWorkers, cachedAt }

  async function resolveServer() {
    if (serverCache && Date.now() - serverCache.cachedAt < SERVER_CACHE_MS) {
      return serverCache;
    }
    try {
      const res = await fetch(CLUSTER_LIST_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`cluster.json responded ${res.status}`);
      const data = await res.json();
      const entries = Object.values(data?.servers || {});
      const pick =
        entries.find((s) => s?.state === "open") ||
        entries.find((s) => s?.state !== "fenced") ||
        entries[0];
      if (!pick?.host || !pick.numWorkers) throw new Error("cluster.json had no usable server");
      serverCache = { host: pick.host, numWorkers: pick.numWorkers, cachedAt: Date.now() };
    } catch (e) {
      console.error("[of-overlay] cluster.json lookup failed, falling back to openfront.io directly:", e);
      // Last-resort guess matching this script's pre-multi-server behavior,
      // for the (now unlikely) case the API itself is unreachable.
      serverCache = { host: "openfront.io", numWorkers: 5, cachedAt: Date.now() };
    }
    return serverCache;
  }

  // Hosted lobbies must join via join-lobby-modal.open({lobbyId}) with NO
  // lobbyInfo — JoinLobbyModal.onOpen() only calls handleUrlJoin() (which
  // dispatches the real join) when lobbyInfo is absent. Passing it up front
  // leaves the modal stuck on "Connecting..." forever.
  const CATEGORIES = [
    { key: "ffa", label: "Free For All", dot: "#4f9eff", source: "public" },
    { key: "team", label: "Teams", dot: "#4ade80", source: "public" },
    { key: "special", label: "Special", dot: "#facc15", source: "public" },
    { key: "hosted", label: "Custom", dot: "#f472b6", source: "hosted" },
  ];

  // Filter/sort matching rules live in lobby-filters.js (@require above) —
  // shared with index.html's own filter panel so a saved profile or a filter
  // choice behaves identically in both places.
  const LF = window.OpenFrontLobbyFilters;

  // lobby-filters.js's defaultFilters() mirrors index.html, which has no map
  // filter — `maps` is an overlay-only addition layered on top, so it's
  // added here rather than in the shared module.
  function freshFilters() {
    return { ...LF.defaultFilters(), maps: [] };
  }

  // --- TrackerFront integration: openfront.io itself shows no ranked-ELO or
  // game-history UI, so the left sidebar's stats come from trackerfront.com's
  // public API instead. Its own frontend calls it same-origin (relative
  // /api/public/... paths — read directly out of its bundle 2026-09-20) and
  // that API sends no Access-Control-Allow-Origin header at all, so a plain
  // page fetch() from openfront.io would be silently blocked by the browser
  // exactly like api.openfront.io blocked the standalone dashboard earlier.
  // GM_xmlhttpRequest issues the request from the userscript engine instead
  // of the page's own realm, which isn't subject to that same check — this
  // is the one thing @grant none couldn't do, hence the @grant/@connect
  // added above.
  const TF_API_BASE = "https://trackerfront.com/api/public";
  const TF_REFRESH_MS = 5 * 60_000;

  function gmFetchJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { Accept: "application/json" },
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(`${url} responded ${res.status}`));
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error(`${url} request failed`)),
      });
    });
  }

  const RANK_COLORS = {
    iron: "#8d8d8d", bronze: "#b8763e", silver: "#c7ccd6", gold: "#f2c14e",
    platinum: "#4fd1c5", diamond: "#4f9eff", master: "#c084fc",
  };
  function rankColor(name) {
    return RANK_COLORS[String(name || "").toLowerCase()] || "#4f9eff";
  }

  // trackerfront.com's own rank-tier icons — plain <img> hotlinking, unlike
  // its JSON API, needs no GM_xmlhttpRequest workaround at all: an <img src>
  // isn't subject to CORS the way fetch/XHR reads are. "platinium" is their
  // own asset filename typo (confirmed live 2026-09-21), not ours to fix.
  const TF_ASSET_BASE = "https://trackerfront.com/asset";
  const RANK_ASSET_NAMES = {
    iron: "iron", bronze: "bronze", silver: "silver", gold: "gold",
    platinum: "platinium", diamond: "diamond", master: "master", challenger: "challenger",
  };
  function rankIconUrl(name) {
    const key = RANK_ASSET_NAMES[String(name || "").toLowerCase()];
    return key ? `${TF_ASSET_BASE}/${key}.svg` : null;
  }

  // UsernameInput.ts (openfrontio/OpenFrontIO) persists the chosen name to
  // this exact localStorage key — verified 2026-09-20 against main. Doesn't
  // account for the "use verified name" override showing a different display
  // name than what's stored here; good enough since trackerfront's own
  // /search matches against both a player's raw username and display name.
  function getLocalUsername() {
    try {
      return localStorage.getItem("username") || "";
    } catch {
      return "";
    }
  }

  // /players/{id}/games comes back most-recent-first (confirmed from a live
  // response) — count backwards from the front until the streak breaks.
  function computeStreak(games) {
    if (!games || games.length === 0) return null;
    const won = games[0].won;
    let count = 0;
    for (const g of games) {
      if (g.won !== won) break;
      count++;
    }
    return { won, count };
  }

  async function fetchTrackerFrontStats(username) {
    if (!username) return { state: "no-username" };
    let matches;
    try {
      matches = await gmFetchJson(`${TF_API_BASE}/search?q=${encodeURIComponent(username)}&limit=8`);
    } catch (e) {
      console.error("[of-overlay] trackerfront search failed", e);
      return { state: "error" };
    }
    const match =
      matches.find((p) => p.username === username) ||
      matches.find((p) => p.display_name === username) ||
      null;
    if (!match) return { state: "not-found", username };

    try {
      const [profile, games, history] = await Promise.all([
        gmFetchJson(`${TF_API_BASE}/players/${match.public_uuid}`),
        gmFetchJson(`${TF_API_BASE}/players/${match.public_uuid}/games?limit=10`),
        gmFetchJson(`${TF_API_BASE}/players/${match.public_uuid}/history?limit=12`),
      ]);
      return { state: "ok", profile, games, history, streak: computeStreak(games) };
    } catch (e) {
      console.error("[of-overlay] trackerfront profile fetch failed", e);
      return { state: "error" };
    }
  }

  // A plain inline-SVG polyline instead of a charting library — a userscript
  // has no bundler step to pull one in through, and a handful of RR points
  // doesn't need more than this.
  function sparklineSvg(history, color) {
    const points = (history || []).map((h) => h?.rank?.rr).filter((v) => typeof v === "number");
    if (points.length < 2) return "";
    const w = 100, h = 28;
    const min = Math.min(...points);
    const span = Math.max(...points) - min || 1;
    const step = w / (points.length - 1);
    const path = points
      .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
      .join(" ");
    // A `style` attribute, not the `stroke` presentation attribute — a plain
    // SVG presentation attribute loses to .ofov-sparkline path's own stroke
    // rule in the stylesheet regardless of source order, so this is the only
    // way to actually get the current rank's color onto the line.
    return `<svg class="ofov-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${path}" style="stroke:${color}"></path></svg>`;
  }

  function formatShortDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // Small per-opponent rank-tier icons, truncated with a "+N" like
  // trackerfront's own recent-games list — tracked_ranks is every tracked
  // player's rank in that particular game, not just the two people shown.
  const MAX_TRACKED_ICONS = 6;
  function trackedRanksHtml(tracked) {
    if (!Array.isArray(tracked) || tracked.length === 0) return "";
    const shown = tracked.slice(0, MAX_TRACKED_ICONS);
    const extra = tracked.length - shown.length;
    const icons = shown
      .map((t) => {
        const url = rankIconUrl(t?.name);
        return url
          ? `<img class="ofov-tfTrackedIcon" src="${url}" alt="" title="${escapeHtml(t.name || "")}" loading="lazy">`
          : "";
      })
      .join("");
    const extraHtml = extra > 0 ? `<span class="ofov-tfTrackedExtra">+${extra}</span>` : "";
    return `<div class="ofov-tfTracked">${icons}${extraHtml}</div>`;
  }

  // Blends trackerfront's own two "recent games" layouts: a map thumbnail
  // and win/loss framing like its game-history cards, in the single compact
  // row its player-profile list actually uses (a full card per game is too
  // tall to show more than one in this sidebar).
  function trackerGameRowHtml(g) {
    const delta = typeof g.rr_delta === "number" ? `${g.rr_delta >= 0 ? "+" : ""}${g.rr_delta.toFixed(1)}` : "";
    const sub = [g.game_mode, g.num_players != null ? `${g.num_players}P` : null].filter(Boolean).join(" · ");
    return `
      <div class="ofov-tfGame ${g.won ? "ofov-tfWin" : "ofov-tfLoss"}">
        <img class="ofov-tfGameThumb" src="${getMapThumbnailUrl(g.game_map)}" alt="" loading="lazy" onerror="this.style.visibility='hidden';">
        <div class="ofov-tfGameBody">
          <div class="ofov-tfGameTop">
            <span class="ofov-tfMap">${escapeHtml(g.game_map || "—")}</span>
            <span class="ofov-tfDelta">${escapeHtml(delta)}</span>
          </div>
          <div class="ofov-tfGameSub">
            <span class="ofov-tfResultTag">${g.won ? "W" : "L"}</span>
            <span class="ofov-tfGameSubText">${escapeHtml(sub)}</span>
            <span class="ofov-tfGameDate">${escapeHtml(formatShortDate(g.played_at))}</span>
          </div>
          ${trackedRanksHtml(g.tracked_ranks)}
        </div>
      </div>
    `;
  }

  function buildTrackerFrontPanelHtml(data) {
    if (!data || data.state === "no-username") {
      return `<div class="ofov-tfEmpty">Set a username in-game to see your stats here.</div>`;
    }
    if (data.state === "not-found") {
      return `<div class="ofov-tfEmpty">No ranked games found for <strong>${escapeHtml(data.username)}</strong> yet.</div>`;
    }
    if (data.state === "error") {
      return `<div class="ofov-tfEmpty">Couldn't load stats from trackerfront.com right now.</div>`;
    }

    const { profile, games, streak, history } = data;
    const rank = profile.rank || {};
    const rankName = (rank.name || "unranked").toUpperCase();
    const color = rankColor(rank.name);
    const rr = typeof rank.rr === "number" ? Math.max(0, Math.min(100, rank.rr)) : null;
    const rankIcon = rankIconUrl(rank.name);
    const streakHtml =
      streak && streak.count >= 2
        ? `<div class="ofov-tfStreak ${streak.won ? "ofov-tfWin" : "ofov-tfLoss"}">${streak.won ? "🔥" : "❄️"} ${streak.count} ${streak.won ? "win" : "loss"} streak</div>`
        : "";
    const lastGames = (games || []).slice(0, 2).map(trackerGameRowHtml).join("");

    return `
      <div class="ofov-tfHeader">
        ${rankIcon ? `<img class="ofov-tfRankIcon" src="${rankIcon}" alt="">` : ""}
        <span class="ofov-tfRankBadge" style="background:${color}">${escapeHtml(rankName)}</span>
        ${profile.verified ? `<span class="ofov-tfVerified" title="Verified">✓</span>` : ""}
        ${profile.clan_tag ? `<span class="ofov-tfClan">[${escapeHtml(profile.clan_tag)}]</span>` : ""}
      </div>
      <div class="ofov-tfRRRow">
        <div class="ofov-tfRRBarTrack"><div class="ofov-tfRRBarFill" style="width:${rr ?? 0}%; background:${color}"></div></div>
        <div class="ofov-tfRR">${rr != null ? rr.toFixed(1) : "—"}<span class="ofov-tfRRMax">/100</span></div>
      </div>
      ${sparklineSvg(history, color)}
      <div class="ofov-tfMeta">Global rank <strong>#${profile.global_position ?? "—"}</strong> / ${profile.total_ranked ?? "—"}</div>
      <div class="ofov-tfMeta">${profile.games_scored ?? 0} scored games</div>
      ${streakHtml}
      <div class="ofov-modSectionLabel">Last games</div>
      <div class="ofov-tfGames">${lastGames || `<div class="ofov-tfEmpty">No games yet</div>`}</div>
    `;
  }

  // Bumped on every call so an overlapping refresh (e.g. the 5-minute timer
  // firing again before a slow request resolved) can't have its response
  // land after a newer one already did.
  let tfGeneration = 0;

  async function refreshTrackerFrontPanel(bodyEl) {
    const generation = ++tfGeneration;
    const data = await fetchTrackerFrontStats(getLocalUsername());
    if (generation !== tfGeneration || !bodyEl.isConnected) return;
    bodyEl.innerHTML = buildTrackerFrontPanelHtml(data);
  }

  function mountTrackerFrontPanel(bodyEl, refreshBtn) {
    bodyEl.innerHTML = `<div class="ofov-tfEmpty">Loading…</div>`;
    refreshTrackerFrontPanel(bodyEl);
    setInterval(() => refreshTrackerFrontPanel(bodyEl), TF_REFRESH_MS);
    refreshBtn?.addEventListener("click", () => refreshTrackerFrontPanel(bodyEl));
  }

  // --- OpenFront's own ranked (1v1/2v2) ELO. There is no public API for it
  // — it only ever reaches the page as the detail of a "userMeResponse"
  // document event, broadcast (Main.ts) after an authenticated /users/@me
  // call this script has no way to make itself (the JWT it needs lives in
  // an in-memory closure inside OpenFront's own auth module, never in
  // localStorage/cookies). <ranked-modal> listens for that same event and
  // computes its own `elo`/`elo2v2` fields from it to feed its own display —
  // and since TypeScript's `private`/@state() decorators are compile-time
  // only, those fields are exactly as readable from here as they are from
  // inside that component. This never touches the token; it just reads the
  // same broadcast (and the same component) OpenFront's own ranked UI does. ---
  const rankedElo = { oneVOne: null, twoVTwo: null };

  function readRankedEloFromModal() {
    const modal = document.querySelector("ranked-modal");
    if (!modal) return;
    const usable = (v) => typeof v === "number" || (typeof v === "string" && v && v !== "...");
    if (usable(modal.elo)) rankedElo.oneVOne = modal.elo;
    if (usable(modal.elo2v2)) rankedElo.twoVTwo = modal.elo2v2;
    renderRankedElo();
  }

  function rankedEloHtml() {
    if (rankedElo.oneVOne == null && rankedElo.twoVTwo == null) {
      return `<div class="ofov-tfEmpty">Opens once you visit Ranked this session.</div>`;
    }
    const row = (label, value) =>
      `<div class="ofov-rankedRow"><span>${label}</span><strong>${escapeHtml(String(value ?? "—"))}</strong></div>`;
    return row("1v1", rankedElo.oneVOne) + row("2v2", rankedElo.twoVTwo);
  }

  function renderRankedElo() {
    const el = document.getElementById("ofov-rankedElo");
    if (el) el.innerHTML = rankedEloHtml();
  }

  function initRankedElo() {
    // RankedModal.ts's own listener for this same event is registered long
    // before ours (it's a page-level element mounted at boot; this script
    // runs at document-idle), so by the time our handler runs in the same
    // dispatch its `elo`/`elo2v2` are already updated — read straight away.
    document.addEventListener("userMeResponse", readRankedEloFromModal);
    // Covers the case where that event already fired (player already
    // signed in) before this script attached its own listener.
    readRankedEloFromModal();
  }

  // <play-page>'s identity row: flag + username + "use verified" + skin.
  // Moved into the left sidebar's own slot (see mount()) instead of staying
  // above the lobby grid — the same DOM node, just relocated, not rebuilt,
  // so none of its own state/behavior changes. Retried like
  // relocateFooter/relocateNewsBox since neither the identity row nor the
  // sidebar are guaranteed to exist in the same tick.
  function relocateIdentityBar(attemptsLeft = 15) {
    const identityRow = document.querySelector('div[class*="sm:min-h-[60px]"]');
    const slot = document.getElementById("ofov-identitySlot");
    if (!identityRow || !slot) {
      if (attemptsLeft > 0) setTimeout(() => relocateIdentityBar(attemptsLeft - 1), 300);
      return;
    }
    if (identityRow.classList.contains("ofov-identityRelocated")) return;
    identityRow.classList.add("ofov-identityRelocated");
    slot.appendChild(identityRow);
  }

  const state = {
    games: { ffa: [], team: [], special: [], hosted: [] },
    byId: new Map(),
    // gameID -> that card's .ofov-time element, rebuilt once per render() so
    // the once-a-second timer tick can update text directly instead of
    // re-querying the DOM every tick.
    timeEls: new Map(),
    // gameID -> that card's player-count <span>, same reasoning as timeEls —
    // "counts" frames arrive often, so patchCounts needs a direct reference
    // rather than a querySelector per lobby per frame.
    metaEls: new Map(),
    serverTime: undefined,
    serverTimeCapturedAt: undefined,
    filters: freshFilters(),
    tri: LF.initTriState(),
    activeProfiles: new Set(),
    profileSelectionOrder: [],
    // True while a saved profile's values are being written into the form —
    // suppresses the "editing manually clears active profiles" rule so
    // selecting a profile doesn't immediately deselect itself.
    applyingProfile: false,
  };

  const PROFILE_STORAGE_KEY = "ofovLobbyProfiles";
  const PROFILE_ACTIVE_STORAGE_KEY = "ofovLobbyActiveProfiles";

  const TEAM_FILTER_OPTIONS = [
    { value: "any", label: "All" },
    { value: "format:Duos", label: "Duos (2 per team)" },
    { value: "format:Trios", label: "Trios (3 per team)" },
    { value: "format:Quads", label: "Quads (4 per team)" },
    { value: "teams:2", label: "2 teams" },
    { value: "teams:3", label: "3 teams" },
    { value: "teams:4", label: "4 teams" },
    { value: "teams:5", label: "5 teams" },
    { value: "teams:6", label: "6 teams" },
    { value: "teams:7", label: "7 teams" },
    { value: "teams:8", label: "8 teams" },
  ];

  const SORT_OPTIONS = [
    { value: "starts_asc", label: "Starts Soonest" },
    { value: "players_desc", label: "Players ↓" },
    { value: "players_asc", label: "Players ↑" },
    { value: "maxPlayers_desc", label: "Max Players ↓" },
    { value: "maxPlayers_asc", label: "Max Players ↑" },
    { value: "map_asc", label: "Map A→Z" },
  ];

  // Full snapshots (the only source of serverTime) arrive well under once a
  // second, so extrapolate "now" from elapsed time; past this cutoff, stop
  // trusting the extrapolation and fall back to "Open".
  const STALE_AFTER_MS = 30_000;

  function estimatedServerTime() {
    if (state.serverTime == null || state.serverTimeCapturedAt == null) return undefined;
    const elapsed = Date.now() - state.serverTimeCapturedAt;
    if (elapsed > STALE_AFTER_MS) return undefined;
    return state.serverTime + elapsed;
  }

  // Same handful of maps recur across every lobby on every render — cache
  // the computed URL per name instead of re-running the regex replaces.
  const thumbnailUrlCache = new Map();
  function getMapThumbnailUrl(mapName) {
    const key = String(mapName || "");
    let url = thumbnailUrlCache.get(key);
    if (url === undefined) {
      const slug = key
        .toLowerCase()
        .replace(/[\s_]/g, "")
        .replace(/[^\w]/g, "");
      url = `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`;
      thumbnailUrlCache.set(key, url);
    }
    return url;
  }

  function formatDuration(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}s`;
    if (m < 60) return `${m}m ${r}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // Shared with index.html via modifier-labels.js (@require above) — one
  // source of truth instead of two hand-copies drifting apart.
  const modifierBadges = (cfg) => window.OpenFrontModifierLabels.gameModifierLabels(cfg);

  // Badges sit absolutely-positioned over a fixed-height card — past this
  // many they'd get silently clipped, so fold the rest into a "+N more" chip.
  const MAX_CARD_BADGES = 3;

  function timeText(lobby, serverTimeNow) {
    if (!lobby.startsAt || !serverTimeNow) return "Open";
    const deltaS = (lobby.startsAt - serverTimeNow) / 1000;
    return deltaS > 0 ? formatDuration(deltaS) : "Starting";
  }

  // Duos/Trios/Quads store a preset name (not a number) in playerTeams, so
  // team count has to be derived from total players.
  const TEAM_FORMAT_SIZE = { Duos: 2, Trios: 3, Quads: 4 };

  function modeSummaryLine(cfg, numClients) {
    if (cfg?.gameMode !== "Team") return "Free For All";
    const totalPlayers = cfg?.maxPlayers ?? numClients;
    const playerTeams = cfg?.playerTeams;

    const perTeam = TEAM_FORMAT_SIZE[playerTeams];
    if (perTeam) {
      const teamCount = totalPlayers ? Math.floor(totalPlayers / perTeam) : null;
      return teamCount ? `${teamCount} Teams of ${perTeam}` : playerTeams;
    }
    if (playerTeams === "Humans Vs Nations") {
      return "Humans vs Nations";
    }
    if (typeof playerTeams === "number") {
      const perTeamCount = totalPlayers && playerTeams > 0 ? Math.floor(totalPlayers / playerTeams) : null;
      return perTeamCount ? `${playerTeams} Teams of ${perTeamCount}` : `${playerTeams} Teams`;
    }
    return "Team";
  }

  function cardHtml(lobby, serverTime, source) {
    const cfg = lobby.gameConfig || {};
    const map = cfg.gameMap || "—";
    const title = lobby.label || map;
    const allBadgeLabels = modifierBadges(cfg);
    const visibleBadgeLabels = allBadgeLabels.slice(0, MAX_CARD_BADGES);
    const hiddenBadgeLabels = allBadgeLabels.slice(MAX_CARD_BADGES);
    const badges =
      visibleBadgeLabels.map((l) => `<span class="ofov-badge" title="${escapeHtml(l)}">${escapeHtml(l)}</span>`).join("") +
      (hiddenBadgeLabels.length
        ? `<span class="ofov-badge ofov-badgeMore" title="${escapeHtml(hiddenBadgeLabels.join(", "))}">+${hiddenBadgeLabels.length} more</span>`
        : "");
    const featuredBadge = lobby.featured ? `<span class="ofov-badge ofov-featured">★ Featured</span>` : "";
    const cardTimeText = timeText(lobby, serverTime);
    const mode = modeSummaryLine(cfg, lobby.numClients);
    // A native title tooltip is invisible/delayed and doesn't help with
    // badges that are ellipsis-truncated in place (as opposed to the ones
    // folded into "+N more") — show every modifier as plain wrapped text
    // over the image on hover instead.
    const modifierOverlay = allBadgeLabels.length
      ? `<div class="ofov-modifierOverlay">${allBadgeLabels
          .map((label) => `<span class="ofov-badge ofov-badgeFull">${escapeHtml(label)}</span>`)
          .join("")}</div>`
      : "";
    return `
      <article class="ofov-card" data-game-id="${escapeHtml(lobby.gameID)}" data-source="${source}"
        tabindex="0" role="button" aria-label="Join ${escapeHtml(title)}, ${escapeHtml(mode)}" ${
      lobby.accent ? `data-accent="${escapeHtml(lobby.accent)}"` : ""
    }>
        <img class="ofov-img" src="${getMapThumbnailUrl(map)}" alt="${escapeHtml(map)}" loading="lazy"
             onerror="this.style.opacity='0';">
        <div class="ofov-badges">${featuredBadge}${badges}</div>
        ${modifierOverlay}
        <div class="ofov-time">${escapeHtml(cardTimeText)}</div>
        <div class="ofov-bottom">
          <div class="ofov-title">${escapeHtml(title)}</div>
          <div class="ofov-subrow">
            <div class="ofov-mode">${escapeHtml(mode)}</div>
            <div class="ofov-meta">
              <span>${lobby.numClients ?? 0}${cfg.maxPlayers != null ? "/" + cfg.maxPlayers : ""} 👥</span>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  // --- Filters/profiles: matching rules come from lobby-filters.js; this
  // section is just storage + the DOM form that edits state.filters/tri. ---

  function getStoredProfiles() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function saveStoredProfiles(profiles) {
    try { localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profiles)); } catch {}
  }
  function loadActiveProfileNames() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_ACTIVE_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  }
  function saveActiveProfileNames() {
    try { localStorage.setItem(PROFILE_ACTIVE_STORAGE_KEY, JSON.stringify(state.profileSelectionOrder)); } catch {}
  }

  function normalizeProfileFilters(value) {
    value = value || {};
    return {
      type: value.type || "all",
      hideEmpty: value.hideEmpty === true,
      teamFilters: Array.isArray(value.teamFilters) ? value.teamFilters.filter((v) => v && v !== "any") : [],
      maps: Array.isArray(value.maps) ? value.maps.filter((v) => typeof v === "string" && v) : [],
      sort: value.sort || "starts_asc",
      minJoined: value.minJoined ?? null,
      maxJoined: value.maxJoined ?? null,
      maxPlayersEq: value.maxPlayersEq ?? null,
      minMaxPlayers: value.minMaxPlayers ?? null,
      maxMaxPlayers: value.maxMaxPlayers ?? null,
      minPerTeam: value.minPerTeam ?? null,
      maxPerTeam: value.maxPerTeam ?? null,
    };
  }

  function normalizeProfileTri(rawTri) {
    const tri = new Map();
    if (Array.isArray(rawTri)) {
      for (const entry of rawTri) {
        if (Array.isArray(entry) && entry.length >= 2 && entry[0]) {
          tri.set(entry[0], LF.normalizeModifierRule(entry[1]));
        }
      }
    }
    return tri;
  }

  // Every active profile is OR'd together: a lobby matching any one of them
  // passes, same as index.html's own multi-profile behavior.
  function getActiveProfileDefinitions() {
    if (state.activeProfiles.size === 0) return [];
    return getStoredProfiles()
      .filter((p) => p?.name && state.activeProfiles.has(p.name))
      .map((p) => ({ name: p.name, filters: normalizeProfileFilters(p.filters), tri: normalizeProfileTri(p.filters?.tri) }));
  }

  function getProfileSnapshot() {
    return { ...state.filters, tri: Array.from(state.tri.entries()) };
  }

  // Overlay-only, so it isn't part of lobby-filters.js's matchAllFilters —
  // applied as an extra pass alongside it instead.
  function matchesMapFilter(g, maps) {
    if (!maps || maps.length === 0) return true;
    return maps.includes(g.map);
  }

  function matchesCurrentFilters(g) {
    const profiles = getActiveProfileDefinitions();
    if (profiles.length === 0) {
      return LF.matchAllFilters(g, state.filters, state.tri) && matchesMapFilter(g, state.filters.maps);
    }
    return profiles.some(
      (profile) => LF.matchAllFilters(g, profile.filters, profile.tri) && matchesMapFilter(g, profile.filters.maps),
    );
  }

  // The full map list, same source lobby-wire.js's decoder uses (kept in
  // sync by the repo's resync automation) — every map the game knows about,
  // not just ones with a lobby open right now. Static, so unlike the profile
  // select this never needs refreshing after the panel is first built.
  function getKnownMaps() {
    return (window.OpenFrontWire?.GAME_MAP || []).slice().sort();
  }

  // Filters/sorts across all four server buckets together (a "Teams" type
  // filter, say, should empty the FFA/Special/Custom columns too, not just
  // hide within each), then re-buckets survivors back into their original
  // column so render() can keep drawing four columns.
  function getVisibleGames() {
    const flattened = [];
    for (const key of Object.keys(state.games)) {
      for (const raw of state.games[key] || []) {
        flattened.push(LF.normalizeGame(raw, key));
      }
    }
    const matching = flattened.filter((g) => matchesCurrentFilters(g));
    const sorted = LF.sortGames(matching, state.filters.sort);

    const buckets = { ffa: [], team: [], special: [], hosted: [] };
    for (const g of sorted) {
      if (buckets[g.rawType]) buckets[g.rawType].push(g.raw);
    }
    return buckets;
  }

  function triButtonGroup(id) {
    const current = LF.normalizeModifierRule(state.tri.get(id));
    const makeButton = (value, text, title) =>
      `<button type="button" class="ofov-triBtn ${current === value ? "active" : ""}" data-tri="${escapeHtml(id)}" data-val="${escapeHtml(value)}" title="${escapeHtml(title)}" aria-pressed="${current === value ? "true" : "false"}">${escapeHtml(text)}</button>`;
    return `<div class="ofov-triBtns">
      ${makeButton(LF.TRI.OR, "OR", "Match if at least one selected OR modifier is present")}
      ${makeButton(LF.TRI.AND, "AND", "Require every selected AND modifier")}
      ${makeButton(LF.TRI.NOT, "NOT", "Exclude lobbies containing this modifier")}
    </div>`;
  }

  function modifierGroupsHtml(filters) {
    return filters.map((f) => `<div class="ofov-modBox"><div class="ofov-modTitle">${escapeHtml(f.label)}</div>${triButtonGroup(f.id)}</div>`).join("");
  }

  // --- Compact multi-select dropdown: a trigger button showing a summary,
  // and a popover list of checkable rows — click a row to toggle it, no
  // ctrl/cmd needed. Mirrors index.html's own custom-select widget so the
  // interaction feels the same in both places, without pulling in its
  // DOM-specific implementation. ---

  function summarizeMultiSelect(options, selected, emptyLabel) {
    if (selected.size === 0) return emptyLabel;
    if (selected.size <= 2) {
      return options.filter((o) => selected.has(o.value)).map((o) => o.label).join(", ");
    }
    return `${selected.size} selected`;
  }

  function multiSelectItemsHtml(options, selected) {
    return options
      .map(
        (o) =>
          `<label class="ofov-msItem"><input type="checkbox" value="${escapeHtml(o.value)}"${selected.has(o.value) ? " checked" : ""}><span>${escapeHtml(o.label)}</span></label>`,
      )
      .join("");
  }

  function multiSelectDropdownHtml(id, options, selected, emptyLabel) {
    return `
      <div class="ofov-msDropdown" id="${id}">
        <button type="button" class="ofov-msTrigger" aria-expanded="false">${escapeHtml(summarizeMultiSelect(options, selected, emptyLabel))}</button>
        <div class="ofov-msList" hidden>${multiSelectItemsHtml(options, selected)}</div>
      </div>
    `;
  }

  function getMultiSelectChecked(container) {
    return Array.from(container.querySelectorAll('.ofov-msList input[type="checkbox"]:checked')).map((c) => c.value);
  }

  // Wires one dropdown's open/close and change behavior. onChange receives
  // the newly-checked values; the caller decides what that means (a plain
  // filter field vs. the profile-activation flow, which needs more than
  // just recording the selection).
  function wireMultiSelectDropdown(panel, id, { onChange, emptyLabel = "All" } = {}) {
    const container = panel.querySelector(`#${id}`);
    if (!container) return;
    const trigger = container.querySelector(".ofov-msTrigger");
    const list = container.querySelector(".ofov-msList");

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = list.hidden;
      // Only one dropdown open at a time within this panel.
      panel.querySelectorAll(".ofov-msList").forEach((l) => { if (l !== list) l.hidden = true; });
      panel.querySelectorAll(".ofov-msTrigger").forEach((t) => { if (t !== trigger) t.setAttribute("aria-expanded", "false"); });
      list.hidden = !willOpen;
      trigger.setAttribute("aria-expanded", String(willOpen));
    });

    list.addEventListener("change", () => {
      const options = Array.from(list.querySelectorAll("label")).map((lbl) => ({
        value: lbl.querySelector("input").value,
        label: lbl.querySelector("span")?.textContent ?? "",
      }));
      const selected = new Set(getMultiSelectChecked(container));
      trigger.textContent = summarizeMultiSelect(options, selected, emptyLabel);
      onChange?.(Array.from(selected));
    });
  }

  function buildFiltersPanelHtml() {
    const f = state.filters;
    const sortOptionsHtml = SORT_OPTIONS.map(
      (o) => `<option value="${o.value}"${f.sort === o.value ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    ).join("");
    const teamsDropdownHtml = multiSelectDropdownHtml(
      "ofov-f-teams",
      TEAM_FILTER_OPTIONS.filter((o) => o.value !== "any"),
      new Set(f.teamFilters),
      "All",
    );
    const mapsDropdownHtml = multiSelectDropdownHtml(
      "ofov-f-maps",
      getKnownMaps().map((m) => ({ value: m, label: m })),
      new Set(f.maps || []),
      "All maps",
    );

    return `
      <div class="ofov-modSectionLabel">Lobby</div>
      <div class="ofov-filtersRow">
        <div class="ofov-field">
          <label>Type</label>
          <select id="ofov-f-type">
            <option value="all"${f.type === "all" ? " selected" : ""}>All</option>
            <option value="ffa"${f.type === "ffa" ? " selected" : ""}>FFA</option>
            <option value="team"${f.type === "team" ? " selected" : ""}>Teams</option>
            <option value="humansVsNations"${f.type === "humansVsNations" ? " selected" : ""}>Humans vs Nations</option>
          </select>
        </div>
        <div class="ofov-field">
          <label>Hide empty</label>
          <select id="ofov-f-hideEmpty">
            <option value="no"${!f.hideEmpty ? " selected" : ""}>No</option>
            <option value="yes"${f.hideEmpty ? " selected" : ""}>Yes</option>
          </select>
        </div>
        <div class="ofov-field">
          <label>Sort by</label>
          <select id="ofov-f-sort">${sortOptionsHtml}</select>
        </div>
      </div>

      <div class="ofov-filtersRow">
        <div class="ofov-field ofov-fieldGrow">
          <label>Teams</label>
          ${teamsDropdownHtml}
        </div>
        <div class="ofov-field ofov-fieldGrow">
          <label>Map</label>
          ${mapsDropdownHtml}
        </div>
      </div>

      <div class="ofov-modSectionLabel">Players</div>
      <div class="ofov-filtersRow">
        <div class="ofov-field"><label>Min joined</label><input id="ofov-f-minJoined" type="number" placeholder="any" value="${f.minJoined ?? ""}"></div>
        <div class="ofov-field"><label>Max joined</label><input id="ofov-f-maxJoined" type="number" placeholder="any" value="${f.maxJoined ?? ""}"></div>
        <div class="ofov-field"><label>Capacity =</label><input id="ofov-f-maxPlayersEq" type="number" placeholder="any" value="${f.maxPlayersEq ?? ""}"></div>
        <div class="ofov-field"><label>Min capacity</label><input id="ofov-f-minMaxPlayers" type="number" placeholder="any" value="${f.minMaxPlayers ?? ""}"></div>
        <div class="ofov-field"><label>Max capacity</label><input id="ofov-f-maxMaxPlayers" type="number" placeholder="any" value="${f.maxMaxPlayers ?? ""}"></div>
        <div class="ofov-field"><label>Min per team</label><input id="ofov-f-minPerTeam" type="number" placeholder="any" value="${f.minPerTeam ?? ""}"></div>
        <div class="ofov-field"><label>Max per team</label><input id="ofov-f-maxPerTeam" type="number" placeholder="any" value="${f.maxPerTeam ?? ""}"></div>
        <div class="ofov-field"><label>&nbsp;</label><button type="button" id="ofov-f-reset" class="ofov-smallBtn">Reset all</button></div>
      </div>

      <details class="ofov-details">
        <summary>Modifier &amp; Custom Lobby filters</summary>
        <div class="ofov-modSectionLabel">Modifier logic</div>
        <div class="ofov-modGrid">${modifierGroupsHtml([...LF.boolFilters, ...LF.numExact])}</div>

        <div class="ofov-modSectionLabel">Custom Lobby</div>
        <div class="ofov-modGrid">${modifierGroupsHtml(LF.privateBoolFilters)}</div>
      </details>

      <div class="ofov-modSectionLabel">Profiles</div>
      <div class="ofov-filtersRow">
        <div class="ofov-field ofov-fieldGrow"><label>Profile name</label><input id="ofov-f-profileName" type="text" placeholder="e.g. Big team games"></div>
        <div class="ofov-field ofov-fieldGrow"><label>Active profiles</label>${multiSelectDropdownHtml("ofov-f-profileSelect", [], state.activeProfiles, "Manual filters")}</div>
        <div class="ofov-field"><label>&nbsp;</label><button type="button" id="ofov-f-profileSave" class="ofov-smallBtn">Save</button></div>
        <div class="ofov-field"><label>&nbsp;</label><button type="button" id="ofov-f-profileDelete" class="ofov-smallBtn">Delete</button></div>
      </div>
    `;
  }

  function readFiltersFromForm(panel) {
    const val = (id) => panel.querySelector(`#${id}`)?.value;
    const teamsContainer = panel.querySelector("#ofov-f-teams");
    const teamFilters = teamsContainer ? getMultiSelectChecked(teamsContainer) : [];
    const mapsContainer = panel.querySelector("#ofov-f-maps");
    const maps = mapsContainer ? getMultiSelectChecked(mapsContainer) : [];

    return {
      type: val("ofov-f-type") || "all",
      hideEmpty: val("ofov-f-hideEmpty") === "yes",
      teamFilters,
      maps,
      sort: val("ofov-f-sort") || "starts_asc",
      minJoined: LF.parseNum(val("ofov-f-minJoined")),
      maxJoined: LF.parseNum(val("ofov-f-maxJoined")),
      maxPlayersEq: LF.parseNum(val("ofov-f-maxPlayersEq")),
      minMaxPlayers: LF.parseNum(val("ofov-f-minMaxPlayers")),
      maxMaxPlayers: LF.parseNum(val("ofov-f-maxMaxPlayers")),
      minPerTeam: LF.parseNum(val("ofov-f-minPerTeam")),
      maxPerTeam: LF.parseNum(val("ofov-f-maxPerTeam")),
    };
  }

  // Editing anything by hand exits "profile mode" (matches index.html) —
  // otherwise a tweak would look ignored, since active profiles still OR in
  // their own saved values on top of whatever you just typed.
  function leaveProfileModeOnManualChange(panel) {
    if (state.applyingProfile || state.activeProfiles.size === 0) return;
    state.activeProfiles.clear();
    state.profileSelectionOrder = [];
    saveActiveProfileNames();
    const container = panel.querySelector("#ofov-f-profileSelect");
    if (container) {
      container.querySelectorAll('.ofov-msList input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
      const trigger = container.querySelector(".ofov-msTrigger");
      if (trigger) trigger.textContent = "Manual filters";
    }
  }

  function refreshProfileSelect(panel) {
    const container = panel.querySelector("#ofov-f-profileSelect");
    if (!container) return;
    const list = container.querySelector(".ofov-msList");
    const trigger = container.querySelector(".ofov-msTrigger");
    const profiles = getStoredProfiles().filter((p) => p?.name).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const validNames = new Set(profiles.map((p) => p.name));
    state.activeProfiles = new Set(Array.from(state.activeProfiles).filter((n) => validNames.has(n)));
    state.profileSelectionOrder = state.profileSelectionOrder.filter((n) => state.activeProfiles.has(n));

    const options = profiles.map((p) => ({ value: p.name, label: p.name }));
    list.innerHTML = multiSelectItemsHtml(options, state.activeProfiles);
    trigger.textContent = summarizeMultiSelect(options, state.activeProfiles, "Manual filters");
    saveActiveProfileNames();
  }

  // Rebuilds the whole panel from state.filters/tri, which wipes whatever the
  // fresh markup doesn't already know — profileName included — so a loaded
  // profile's name is passed through explicitly rather than set on the
  // about-to-be-replaced input beforehand.
  function applyProfileSnapshot(rawFilters, panel, profileName) {
    if (!rawFilters) return;
    state.applyingProfile = true;
    try {
      state.filters = normalizeProfileFilters(rawFilters);
      state.tri = normalizeProfileTri(rawFilters.tri);
      panel.innerHTML = buildFiltersPanelHtml();
      wireFiltersPanel(panel);
      refreshProfileSelect(panel);
      const nameInput = panel.querySelector("#ofov-f-profileName");
      if (nameInput && profileName) nameInput.value = profileName;
    } finally {
      state.applyingProfile = false;
    }
    render(estimatedServerTime());
  }

  function saveCurrentProfile(panel) {
    const nameInput = panel.querySelector("#ofov-f-profileName");
    const name = nameInput?.value.trim();
    if (!name) {
      alert("Name the profile first.");
      return;
    }

    const profiles = getStoredProfiles().filter((p) => p?.name !== name);
    profiles.push({ name, filters: getProfileSnapshot(), updatedAt: Date.now() });
    saveStoredProfiles(profiles);
    state.activeProfiles = new Set([name]);
    state.profileSelectionOrder = [name];
    refreshProfileSelect(panel);
    render(estimatedServerTime());
  }

  function deleteSelectedProfile(panel) {
    const nameInput = panel.querySelector("#ofov-f-profileName");
    const typedName = nameInput?.value.trim();
    const names = typedName ? [typedName] : Array.from(state.activeProfiles);
    if (names.length === 0) {
      alert("Select a saved profile first.");
      return;
    }

    const remove = new Set(names);
    const profiles = getStoredProfiles();
    const next = profiles.filter((p) => !remove.has(p?.name));
    if (next.length === profiles.length) {
      alert("That profile does not exist.");
      return;
    }

    saveStoredProfiles(next);
    for (const n of remove) state.activeProfiles.delete(n);
    state.profileSelectionOrder = state.profileSelectionOrder.filter((n) => !remove.has(n));
    if (nameInput) nameInput.value = "";
    refreshProfileSelect(panel);
    render(estimatedServerTime());
  }

  function wireFiltersPanel(panel) {
    const onManualFilterChange = () => {
      leaveProfileModeOnManualChange(panel);
      state.filters = readFiltersFromForm(panel);
      render(estimatedServerTime());
    };

    panel.querySelectorAll("select, input[type=number]").forEach((el) => {
      el.addEventListener("change", onManualFilterChange);
      if (el.tagName === "INPUT") el.addEventListener("input", onManualFilterChange);
    });

    wireMultiSelectDropdown(panel, "ofov-f-teams", { onChange: onManualFilterChange, emptyLabel: "All" });
    wireMultiSelectDropdown(panel, "ofov-f-maps", { onChange: onManualFilterChange, emptyLabel: "All maps" });
    wireMultiSelectDropdown(panel, "ofov-f-profileSelect", {
      emptyLabel: "Manual filters",
      onChange: (selected) => {
        state.activeProfiles = new Set(selected);
        state.profileSelectionOrder = selected;
        saveActiveProfileNames();

        const lastName = selected[selected.length - 1];
        const lastProfile = lastName ? getStoredProfiles().find((p) => p?.name === lastName) : null;
        if (lastProfile) {
          applyProfileSnapshot(lastProfile.filters, panel, lastProfile.name);
        } else {
          render(estimatedServerTime());
        }
      },
    });

    panel.querySelectorAll("[data-tri][data-val]").forEach((btn) => {
      btn.addEventListener("click", () => {
        leaveProfileModeOnManualChange(panel);
        const id = btn.getAttribute("data-tri");
        const value = btn.getAttribute("data-val");
        const current = LF.normalizeModifierRule(state.tri.get(id));
        const next = current === value ? LF.TRI.NONE : value;
        state.tri.set(id, next);
        panel.querySelectorAll(`[data-tri="${CSS.escape(id)}"]`).forEach((b) => {
          b.classList.toggle("active", next !== LF.TRI.NONE && b.getAttribute("data-val") === next);
        });
        render(estimatedServerTime());
      });
    });

    panel.querySelector("#ofov-f-reset")?.addEventListener("click", () => {
      state.filters = freshFilters();
      state.tri = LF.initTriState();
      state.activeProfiles.clear();
      state.profileSelectionOrder = [];
      saveActiveProfileNames();
      panel.innerHTML = buildFiltersPanelHtml();
      wireFiltersPanel(panel);
      refreshProfileSelect(panel);
      render(estimatedServerTime());
    });

    panel.querySelector("#ofov-f-profileSave")?.addEventListener("click", () => saveCurrentProfile(panel));
    panel.querySelector("#ofov-f-profileDelete")?.addEventListener("click", () => deleteSelectedProfile(panel));
  }

  function initProfilesAndFilters(panel) {
    state.profileSelectionOrder = loadActiveProfileNames();
    state.activeProfiles = new Set(state.profileSelectionOrder);
    refreshProfileSelect(panel);

    const lastName = state.profileSelectionOrder.at(-1);
    const lastProfile = lastName ? getStoredProfiles().find((p) => p?.name === lastName) : null;
    if (lastProfile) {
      applyProfileSnapshot(lastProfile.filters, panel, lastProfile.name);
    }
  }

  // Shows the fade only when there's actually more below the visible area —
  // a column that fits without scrolling gets no fade at all.
  function updateColumnFade(colCardsEl) {
    const col = colCardsEl.closest(".ofov-col");
    if (!col) return;
    const hasMore = colCardsEl.scrollHeight - colCardsEl.clientHeight - colCardsEl.scrollTop > 2;
    col.classList.toggle("ofov-hasMoreBelow", hasMore);
  }

  function nodeFromHtml(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // Identifies everything a card shows besides the live-ticking
  // count/countdown (those patch separately via patchCounts/tickTimers). A
  // hosted lobby can keep the same game ID across a rehost while its
  // map/modifiers change entirely — this fingerprint is how reconcileColumn
  // notices that and rebuilds the card instead of leaving stale content
  // behind on a reused node.
  function cardFingerprint(g) {
    const cfg = g.gameConfig || {};
    return [
      g.gameID, cfg.gameMap, cfg.maxPlayers, cfg.playerTeams, g.label, g.accent, g.featured,
      JSON.stringify(cfg.publicGameModifiers || {}), cfg.rankedType, cfg.nations,
    ].join(":");
  }

  // Build the four empty column shells once — reused for the lifetime of
  // the page rather than torn down and rebuilt (see reconcileColumn for why).
  function ensureGridColumns(root) {
    if (root.querySelector(".ofov-col")) return;
    root.innerHTML = CATEGORIES.map(
      ({ key, label, dot }) => `
        <div class="ofov-col" data-cat="${key}">
          <div class="ofov-colHeader">
            <span class="ofov-dot" style="background:${dot}"></span>
            ${escapeHtml(label.toUpperCase())}
            <span class="ofov-count" data-col-count="${key}">0</span>
          </div>
          <div class="ofov-colCards" data-col-cards="${key}"></div>
          <div class="ofov-colCardsFade" aria-hidden="true">
            <span class="ofov-moreHint">▾ Scroll for more</span>
          </div>
        </div>
      `,
    ).join("");
  }

  // Reconciles one column's cards against the desired game list, keyed by
  // id, instead of replacing .ofov-colCards' innerHTML wholesale — a full
  // rebuild on every "full" snapshot (arriving every few seconds) recreated
  // this element each time, which reset its scrollTop to 0 (scrolled-down
  // users got yanked back to the top) and re-decoded every card's image,
  // which is what read as stutter. Reusing the node for a game that's still
  // here — and only rebuilding it if cardFingerprint says its content
  // actually changed — keeps the container itself, and most cards, fully
  // untouched across a snapshot that didn't really change anything.
  function reconcileColumn(colCardsEl, games, serverTime, source) {
    const existing = new Map();
    colCardsEl.querySelectorAll(":scope > .ofov-card[data-game-id]").forEach((n) => existing.set(n.dataset.gameId, n));

    if (games.length === 0) {
      for (const node of existing.values()) node.remove();
      if (!colCardsEl.querySelector(":scope > .ofov-colEmpty")) {
        colCardsEl.innerHTML = `<div class="ofov-colEmpty">No open lobbies</div>`;
      }
      return;
    }
    colCardsEl.querySelector(":scope > .ofov-colEmpty")?.remove();

    const frag = document.createDocumentFragment();
    for (const g of games) {
      const id = String(g.gameID);
      const fp = cardFingerprint(g);
      let node = existing.get(id);
      if (node) existing.delete(id);
      if (!node || node.dataset.ofovFp !== fp) {
        // One malformed lobby (or a modifier-labels.js @require that failed
        // to load) shouldn't take down every column — skip just that card.
        try {
          node = nodeFromHtml(cardHtml(g, serverTime, source));
          node.dataset.ofovFp = fp;
        } catch (e) {
          console.error("[of-overlay] failed to render lobby card", g?.gameID, e);
          continue;
        }
      }
      frag.appendChild(node);
    }
    for (const node of existing.values()) node.remove();
    colCardsEl.appendChild(frag);
  }

  function render(serverTime) {
    const root = document.getElementById("ofov-grid");
    if (!root) return;

    ensureGridColumns(root);

    // FLIP (First-Last-Invert-Play): a card that shifts position — most
    // commonly the one below a lobby that just ended sliding up to take its
    // place — jumps from doing this instantly to visibly animating into its
    // new spot. Read every surviving card's rect first, in one pass, before
    // reconciling — writing a transform on one card would otherwise
    // invalidate layout for the next card's rect read, forcing a separate
    // synchronous reflow per moved card instead of sharing one.
    const firstRects = new Map();
    root.querySelectorAll(".ofov-card[data-game-id]").forEach((card) => {
      firstRects.set(card.dataset.gameId, card.getBoundingClientRect());
    });

    const visible = getVisibleGames();
    for (const { key, source } of CATEGORIES) {
      const list = visible[key] || [];
      const colCardsEl = root.querySelector(`.ofov-colCards[data-col-cards="${key}"]`);
      const countEl = root.querySelector(`[data-col-count="${key}"]`);
      if (countEl) countEl.textContent = String(list.length);
      if (colCardsEl) reconcileColumn(colCardsEl, list, serverTime, source);
    }
    root.querySelectorAll(".ofov-colCards").forEach(updateColumnFade);

    state.timeEls.clear();
    state.metaEls.clear();

    const moves = [];
    root.querySelectorAll(".ofov-card[data-game-id]").forEach((card) => {
      const gameId = card.dataset.gameId;
      const timeEl = card.querySelector(".ofov-time");
      if (timeEl) state.timeEls.set(gameId, timeEl);
      const metaEl = card.querySelector(".ofov-meta span");
      if (metaEl) state.metaEls.set(gameId, metaEl);

      const first = firstRects.get(gameId);
      if (!first) return;
      const last = card.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      moves.push({ card, dx, dy });
    });

    if (moves.length) {
      for (const { card, dx, dy } of moves) {
        card.style.transition = "none";
        card.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      // One shared reflow for the whole batch of moved cards, so the browser
      // registers every starting position before the transition below is
      // applied — otherwise each pair of style writes above/below could
      // coalesce into one frame and the cards would just snap with no
      // visible motion.
      void root.offsetHeight;
      for (const { card } of moves) {
        card.style.transition = "transform 220ms ease";
        card.style.transform = "";
        card.addEventListener(
          "transitionend",
          () => {
            card.style.transition = "";
          },
          { once: true },
        );
      }
    }
  }

  // A hosted lobby that dips below the player minimum needed to keep its
  // countdown running reports startsAt: null for a beat, then a real value
  // again once someone rejoins — without smoothing that out, the card reads
  // as "Open" and back on every such blip, and since sort_asc sorts by
  // startsAt, it visibly swaps places in its column each time too. Holding
  // the last real value for a short grace window absorbs the blip without
  // hiding a countdown that's actually been cancelled for good — past the
  // grace window it's treated as genuinely Open again.
  const STARTS_AT_STICKY_MS = 8_000;
  const startsAtSticky = new Map(); // gameID -> { startsAt, seenAt }

  function stabilizeStartsAt(games) {
    const now = Date.now();
    for (const g of games) {
      const id = String(g.gameID);
      if (g.startsAt) {
        startsAtSticky.set(id, { startsAt: g.startsAt, seenAt: now });
        continue;
      }
      const sticky = startsAtSticky.get(id);
      if (sticky && now - sticky.seenAt < STARTS_AT_STICKY_MS) {
        g.startsAt = sticky.startsAt;
      } else {
        startsAtSticky.delete(id);
      }
    }
  }

  function reindex() {
    state.byId.clear();
    for (const key of Object.keys(state.games)) {
      for (const g of state.games[key]) state.byId.set(String(g.gameID), g);
    }
    // A game that's left every category entirely (ended, or the host closed
    // it) has nothing left to smooth for — without this the map would keep
    // one stale entry per lobby that ever counted down, forever.
    for (const id of startsAtSticky.keys()) {
      if (!state.byId.has(id)) startsAtSticky.delete(id);
    }
  }

  // Patch player-count text in place rather than re-rendering the grid —
  // counts frames arrive often, and rebuilding on every one destroyed
  // whatever card the mouse was resting on (retriggering its hover transition
  // on every update, which looked like pulsating).
  function patchCounts(updatedIds) {
    for (const id of updatedIds) {
      const g = state.byId.get(id);
      const metaSpan = state.metaEls.get(id);
      if (!g || !metaSpan) continue;
      const maxPlayers = g.gameConfig?.maxPlayers;
      metaSpan.textContent = `${g.numClients ?? 0}${maxPlayers != null ? "/" + maxPlayers : ""} 👥`;
    }
  }

  // Text-only patch, same reasoning as patchCounts above. Passing `now`
  // through even when estimatedServerTime() has gone stale (undefined) is
  // deliberate — timeText() already falls back to "Open" in that case, so
  // countdowns don't freeze at their last value once the socket's been
  // quiet past STALE_AFTER_MS.
  function tickTimers() {
    const now = estimatedServerTime();
    for (const [gameId, timeEl] of state.timeEls) {
      const lobby = state.byId.get(gameId);
      if (lobby) timeEl.textContent = timeText(lobby, now);
    }
  }

  // Exponential backoff (capped, with jitter) for reconnects — a flat
  // fixed-interval retry means every connected client hammers the lobby
  // server on the same cadence for as long as it's down.
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30_000;
  let reconnectDelayMs = RECONNECT_BASE_MS;

  async function connect() {
    const { host, numWorkers } = await resolveServer();
    const worker = `w${Math.floor(Math.random() * numWorkers)}`;
    const ws = new WebSocket(`wss://${host}/${worker}/lobbies`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnectDelayMs = RECONNECT_BASE_MS;
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = window.OpenFrontWire.decodeLobbyMessage(ev.data);
      } catch (e) {
        console.error("[of-overlay] decode failed", e);
        return;
      }

      if (msg.type === "full") {
        state.games = {
          ffa: msg.games?.ffa || [],
          team: msg.games?.team || [],
          special: msg.games?.special || [],
          hosted: msg.games?.hosted || [],
        };
        state.serverTime = msg.serverTime;
        state.serverTimeCapturedAt = Date.now();
        for (const key of Object.keys(state.games)) stabilizeStartsAt(state.games[key]);
        reindex();
        render(state.serverTime);
        return;
      }

      if (msg.type === "counts") {
        const updatedIds = [];
        for (const [id, count] of Object.entries(msg.counts || {})) {
          const g = state.byId.get(String(id));
          if (g) {
            g.numClients = count;
            updatedIds.push(String(id));
          }
        }
        patchCounts(updatedIds);
      }
    };

    ws.onclose = () => {
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
      setTimeout(connect, delay + Math.random() * delay * 0.3);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      game-mode-selector div[class*="sm:grid-cols-[2fr_1fr]"] { display: none !important; }
      /* Hides the native SOLO/CREATE/RANKED/JOIN row (replaced below) via CSS
         rather than touching game-mode-selector's own Lit-managed DOM. */
      game-mode-selector div[class*="h-14"] { display: none !important; }

      /* Identity row (flag + username + skin, in <play-page>'s render()) —
         shrunk, not hidden: still fully usable, just claiming less of the
         vertical space above the lobby grid. Targets the exact Tailwind
         arbitrary-value classes from PlayPage.ts (min-h-[60px]/max-h-[52px]/
         h-[50px]) the same substring-match way the native grid is hidden
         above, since none of these elements have their own id/data-hook.
         Also has sm:flex-1 in its own class list, and its flex-column parent
         gets stretched tall by the top-strip grid's items-stretch (to match
         Streaming Now's height) — flex-grow fills that freed space right
         back up regardless of min-height/max-height, which is why capping
         only the height left it looking unchanged. flex:0 0 auto stops it
         from growing to fill that space at all. */
      div[class*="sm:min-h-[60px]"] {
        min-height: 60px !important;
        max-height: 72px !important;
        flex: 0 0 auto !important;
      }
      flag-input[class*="max-h-[52px]"],
      cosmetics-input[class*="max-h-[52px]"] { max-height: 56px !important; }
      username-input[class*="sm:h-[50px]"] { height: 56px !important; }

      /* Streaming Now is now just a small hover-icon (see below), not a
         real column of content, so the 2fr/1fr split PlayPage.ts's grid
         switches to whenever a stream is live wastes a third of the row on
         it. Give the icon just enough column to fit itself (auto) and let
         the identity bar's column (1fr) take the rest, both centered on the
         row's cross axis — items-stretch was the source of the original
         "everything stretches to match" bug, so replace it outright rather
         than leaving it for the icon to fight too. The attribute selector
         matches on the literal Tailwind class text, which is present
         whether or not anyone is live — :has(.streaming-live) is what
         actually restricts this to the live case, matching the native
         rule it's overriding; without it, nobody streaming still forced
         the two-column split against an empty second column, throwing
         off the identity bar's alignment. */
      div[class*="lg:has-[.streaming-live]:grid-cols-[2fr_1fr]"]:has(.streaming-live) {
        grid-template-columns: 1fr auto !important;
        align-items: center !important;
      }

      /* Streaming Now — collapsed to a small square icon sitting in that
         auto column beside the identity bar (a normal in-flow grid item now,
         not fixed/absolute — that's what actually keeps it visually
         anchored next to the bar instead of floating in a page corner
         unrelated to it). Hovering (or focusing into it via keyboard)
         reveals streaming-now's real rendered panel — untouched, not
         reimplemented — as a popover that grows out of the icon in place,
         the same hide-native/reveal-on-demand pattern used for news-box. */
      streaming-now.streaming-live {
        flex: 0 0 auto !important;
        align-self: center !important;
        position: relative !important;
        z-index: 90000 !important;
        width: 46px !important;
        min-width: 46px !important;
        height: 46px !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow: visible !important;
        cursor: pointer !important;
      }
      streaming-now.streaming-live::before {
        content: "🔴";
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.3rem;
        animation: ofovStreamPulse 1.6s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes ofovStreamPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.45; }
      }
      /* Targets the real content div by its own distinctive class fragment
         (sm:justify-center, from StreamingNow.ts's render()) rather than
         "> div" — a positional child selector breaks the moment that
         render() gains a sibling (it already renders a <style> tag before
         this div; another wrapper would silently defeat a > div match). */
      streaming-now.streaming-live div[class*="sm:justify-center"] {
        position: absolute !important;
        top: 0 !important;
        right: 0 !important;
        width: 46px !important;
        height: auto !important;
        max-height: 0 !important;
        overflow: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        transition: width 220ms ease, max-height 220ms ease, opacity 220ms ease !important;
        z-index: 90000 !important;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.46) !important;
        border-radius: 0.75rem !important;
      }
      streaming-now.streaming-live:hover div[class*="sm:justify-center"],
      streaming-now.streaming-live:focus-within div[class*="sm:justify-center"] {
        width: 280px !important;
        /* Generously larger than any realistic streamer-row content — the
           collapsed 0 needs a finite max-height to animate from at all, but
           a cap that's actually tight enough to matter here would just clip
           the real panel's content again instead of merely running the
           open/close transition. overflow flips to visible too, once open,
           so nothing inside (a long streamer title, its own hover states)
           gets cropped either. */
        max-height: 500px !important;
        overflow: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }

      /* <news-box> (the inline "Steam is coming!" style announcement card)
         is light-DOM Lit like game-mode-selector, so hiding it by default is
         the same safe pattern — its own state (cycling/dismiss) keeps
         running in the background regardless of display:none. Relocated to
         a small icon in <nav-utility-icons> (see relocateNewsBox()); opening
         that icon just flips this same class rather than re-implementing
         the card's content. */
      news-box { display: none !important; }
      news-box.ofov-newsOpen {
        display: block !important;
        position: fixed !important;
        top: 4.5rem;
        right: 1rem;
        z-index: 100000;
        width: min(360px, calc(100vw - 2rem));
        border-radius: 0.75rem;
        overflow: hidden;
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.46);
        animation: ofovNewsPopIn 0.15s ease-out;
      }
      @keyframes ofovNewsPopIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Folded into the Terms/Privacy row (see relocateFooter) instead of
         sitting on its own centered line — the block-level centering/margin
         it had there would misalign it once it's just another item in that
         row's flex layout. */
      .ofov-footerVersionInline {
        margin: 0 !important; padding: 0 !important; text-align: left !important;
      }
      /* The footer's left grid column (see relocateFooter's comment) is
         otherwise empty, so anchoring the icon row to its bottom-left corner
         doesn't overlap the centered Terms/Privacy content or the Steam
         promo widget in the right column. */
      .ofov-footerIconsCorner {
        position: absolute !important;
        left: 0.75rem; bottom: 0.4rem;
        justify-content: flex-start !important;
        padding: 0 !important; margin: 0 !important;
      }

      /* Design tokens: every font-size/weight and every button/pill/tab
         dimension below reads from this scale instead of a one-off value,
         so a new element added later inherits the same look for free
         instead of needing its own guess at "how big should this text be".
         Three weights only — regular for body copy, bold for anything
         interactive or numeric, black for headers and the one standout
         number (RR) — and five font sizes, smallest to largest. */
      #ofov-root {
        width: 100%;
        --ofov-fs-xs: 0.62rem;
        --ofov-fs-sm: 0.68rem;
        --ofov-fs-md: 0.74rem;
        --ofov-fs-lg: 0.85rem;
        --ofov-fs-xl: 1.05rem;
        --ofov-fw-regular: 600;
        --ofov-fw-bold: 700;
        --ofov-fw-black: 800;
        --ofov-radius-badge: 0.25rem;
        --ofov-radius-btn: 0.4rem;
        --ofov-radius-full: 999px;
        --ofov-pad-badge: 0.15rem 0.4rem;
        --ofov-pad-btn: 0.4rem 0.7rem;
        --ofov-pad-field: 0.4rem 0.5rem;
        font-size: var(--ofov-fs-md);
        font-weight: var(--ofov-fw-regular);
      }
      #ofov-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
        gap: 0.6rem;
        align-items: start;
      }
      .ofov-col { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; position: relative; }
      .ofov-colHeader {
        display: flex; align-items: center; gap: 0.45rem;
        font-size: var(--ofov-fs-lg); font-weight: var(--ofov-fw-black); color: #fff;
        text-transform: uppercase; letter-spacing: 0.03em;
        background: #1a1f2e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 0.6rem; padding: 0.5rem 0.75rem;
      }
      .ofov-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; flex-shrink: 0; }
      .ofov-count {
        margin-left: auto; background: rgba(255,255,255,0.12);
        border-radius: var(--ofov-radius-full); padding: 0.15rem 0.5rem;
        font-size: var(--ofov-fs-sm); font-weight: var(--ofov-fw-bold);
      }
      .ofov-colCards {
        display: flex; flex-direction: column; gap: 0.5rem;
        /* Scales with viewport height so a tall window shows more cards
           before scrolling, clamped so a short window still gets a sane
           minimum and a huge one doesn't run off the bottom of the page. */
        max-height: clamp(18rem, 52vh, 40rem);
        overflow-y: auto; overflow-x: hidden; padding-bottom: 2px;
        /* Scrolling still works — only the native scrollbar track/thumb is
           hidden, since .ofov-moreHint is the intended "there's more" cue. */
        scrollbar-width: none;
      }
      .ofov-colCards::-webkit-scrollbar { display: none; }
      /* Overlays the bottom of .ofov-colCards (a sibling, so it stays put
         instead of scrolling away) — only shown once JS confirms via
         .ofov-hasMoreBelow that there's actually more to scroll to. */
      .ofov-colCardsFade {
        position: absolute; left: 0; right: 0; bottom: 0; height: 2.5rem;
        background: linear-gradient(transparent, #1a1f2e 85%);
        display: flex; align-items: flex-end; justify-content: center; padding-bottom: 0.35rem;
        pointer-events: none; opacity: 0; transition: opacity 150ms ease;
      }
      .ofov-col.ofov-hasMoreBelow .ofov-colCardsFade { opacity: 1; }
      .ofov-moreHint {
        font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-black); color: #fff;
        text-transform: uppercase; letter-spacing: 0.05em;
        background: rgba(0,0,0,0.6); padding: 0.2rem 0.55rem; border-radius: var(--ofov-radius-full);
      }
      .ofov-colEmpty {
        color: rgba(255,255,255,0.4); font-size: var(--ofov-fs-sm);
        text-align: center; padding: 1rem 0;
      }
      .ofov-card {
        position: relative;
        display: block;
        width: 100%;
        height: 8rem;
        /* .ofov-colCards is a column flex container with overflow-y:auto —
           that combination drops the browser's automatic min-size for flex
           children to 0 (spec behavior once overflow isn't visible), so
           without flex-shrink:0 cards get squashed to fit instead of the
           container scrolling past them. */
        flex-shrink: 0;
        border-radius: 1rem;
        overflow: hidden;
        background: #1a1f2e;
        cursor: pointer;
        border: none;
        padding: 0;
        transition: transform 0.15s ease;
      }
      .ofov-card:hover { transform: scale(1.02); }
      .ofov-card:focus-visible { outline: 2px solid #4f9eff; outline-offset: 2px; }
      .ofov-card[data-accent="gold"] { box-shadow: 0 0 0 2px #facc15; }
      .ofov-img {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; object-position: center;
      }
      .ofov-badges {
        position: absolute; top: 0.35rem; left: 0.35rem; right: 3.6rem;
        display: flex; flex-direction: column; gap: 0.2rem; align-items: flex-start;
      }
      .ofov-badge {
        background: #4f9eff; color: #fff; font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-bold);
        text-transform: uppercase; letter-spacing: 0.04em;
        padding: var(--ofov-pad-badge); border-radius: var(--ofov-radius-badge);
        max-width: 100%; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; box-sizing: border-box;
      }
      .ofov-featured { background: #facc15; color: #000; }
      .ofov-badgeMore { background: rgba(0,0,0,0.6); color: rgba(255,255,255,0.75); cursor: help; }
      .ofov-modifierOverlay {
        position: absolute; inset: 0; z-index: 3;
        display: flex; flex-wrap: wrap; align-content: flex-start;
        gap: 6px; padding: 10px;
        background: rgba(7, 14, 23, 0.92);
        opacity: 0; pointer-events: none; overflow-y: auto;
        transition: opacity 120ms ease;
      }
      .ofov-card:hover .ofov-modifierOverlay { opacity: 1; }
      .ofov-badgeFull { max-width: none; overflow: visible; text-overflow: clip; white-space: normal; }
      .ofov-time {
        position: absolute; top: 0.35rem; right: 0.35rem;
        background: #4f9eff; color: #fff; font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-bold);
        padding: var(--ofov-pad-badge); border-radius: var(--ofov-radius-badge);
      }
      .ofov-bottom {
        position: absolute; bottom: 0; left: 0; right: 0;
        background: linear-gradient(transparent, rgba(0,0,0,0.8) 35%);
        padding: 0.9rem 0.5rem 0.35rem;
      }
      .ofov-title {
        color: #fff; font-weight: var(--ofov-fw-bold); text-transform: uppercase;
        font-size: var(--ofov-fs-md); letter-spacing: 0.02em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ofov-subrow {
        display: flex; align-items: center; justify-content: space-between;
        gap: 0.4rem; margin-top: 0.1rem;
      }
      .ofov-mode {
        color: rgba(255,255,255,0.65); font-size: var(--ofov-fs-xs);
        text-transform: uppercase; letter-spacing: 0.02em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        flex: 1 1 auto; min-width: 0;
      }
      .ofov-meta { color: rgba(255,255,255,0.7); font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-bold); flex-shrink: 0; }

      .ofov-actions { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
      .ofov-actionBtn {
        flex: 1; height: 2.2rem; border-radius: var(--ofov-radius-btn); border: none;
        background: #1a1f2e; color: #fff; font-weight: var(--ofov-fw-bold); text-transform: uppercase;
        letter-spacing: 0.03em; font-size: var(--ofov-fs-sm); cursor: pointer;
        transition: filter 0.15s ease, transform 0.15s ease;
      }
      .ofov-actionBtn:hover { filter: brightness(1.15); transform: scale(1.02); }
      .ofov-actionBtn:active { transform: scale(0.98); }
      /* Solo intentionally matches Create/Ranked's plain dark styling now
         (OpenFront's own native row gives Solo a distinct accent color —
         this overlay's own action row reads better with all three uniform). */
      #ofov-filtersToggle[aria-expanded="true"] { background: #4f9eff; }

      /* Same height as .ofov-actionBtn (2.2rem = 0.4rem padding + 0.68rem
         text + border, at line-height 1) so a small button never reads as a
         different control size than the row of action buttons above it. */
      .ofov-smallBtn {
        height: 2.2rem;
        background: #0d1017; color: #fff; border: 1px solid rgba(255,255,255,0.14);
        border-radius: var(--ofov-radius-btn); padding: 0 0.7rem;
        font-size: var(--ofov-fs-sm); font-weight: var(--ofov-fw-bold);
        text-transform: uppercase; letter-spacing: 0.03em; cursor: pointer;
        transition: filter 0.15s ease;
      }
      .ofov-smallBtn:hover { filter: brightness(1.2); }

      /* The lobby browser (everything #ofov-root sits beside) lives in
         OpenFront's own narrow left-hand column next to its full-screen map
         background — verified live 2026-09-21: laying the side panels out
         as normal-flow flex children of that column (an earlier attempt)
         made the *column itself* grow to fit them, squeezing #ofov-grid
         down to 2 cramped cards per row instead of leaving it the width it
         already had. Docking both panels to the real viewport edges instead
         — the same trick the original single filters panel used — lets them
         sit in the actual empty map space outside that column without
         touching its width at all, so the grid gets its full room back. */
      .ofov-mainCol { min-width: 0; }

      .ofov-sidePanel {
        position: fixed; z-index: 40000;
        /* 4.5rem below the top nav matches news-box's own offset above; the
           bottom clearance clears the game's "OpenFront on Steam" promo
           banner plus the page footer beneath it. */
        top: 4.5rem; bottom: 6rem;
        width: min(14rem, 22vw);
        background: #1a1f2e; border: 1px solid rgba(255,255,255,0.1);
        display: flex; flex-direction: column;
        overflow: hidden;
        transition: width 150ms ease;
      }
      #ofov-leftOuter { left: 0; border-left: none; border-radius: 0 0.75rem 0.75rem 0; }
      #ofov-filtersOuter {
        right: 0; border-right: none; border-radius: 0.75rem 0 0 0.75rem;
        width: min(18rem, 28vw);
      }
      /* Shrunk to a thin strip rather than removed outright — a quick way
         to reclaim screen space without losing the panel's state (open
         dropdowns, scroll position, form values). */
      .ofov-sidePanel.ofov-collapsed { width: 2.4rem; }
      .ofov-sidePanel.ofov-collapsed .ofov-sidePanelBody,
      .ofov-sidePanel.ofov-collapsed .ofov-sidePanelHeader span { display: none; }

      .ofov-sidePanelHeader {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0.5rem 0.6rem; flex-shrink: 0;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-black); text-transform: uppercase;
        letter-spacing: 0.05em; color: rgba(255,255,255,0.7);
      }
      .ofov-sidePanelHeaderBtns { display: flex; gap: 0.3rem; }
      .ofov-iconBtn {
        background: transparent; border: 1px solid rgba(255,255,255,0.16);
        color: #fff; border-radius: var(--ofov-radius-badge); width: 1.35rem; height: 1.35rem;
        font-size: var(--ofov-fs-sm); line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .ofov-iconBtn:hover { filter: brightness(1.3); }
      /* flex:1 (not the implicit flex:0 1 auto a plain block would get)
         is what actually lets this fill whatever's left under the header/
         identity/ranked sections and scroll within that instead of the
         panel's own overflow:hidden silently clipping it. */
      .ofov-sidePanelBody { flex: 1 1 auto; min-height: 0; padding: 0.65rem; overflow-y: auto; }

      /* The relocated flag/username/verified row (see relocateIdentityBar)
         — its own Tailwind classes assume the wide top-strip row it used to
         sit in, which a ~14rem sidebar can't give it, so its layout is
         forced into a plain vertical stack here regardless of what those
         classes say. Best-effort: this component's internal shadow-DOM-free
         markup wasn't designed for this width, so it may still need a
         follow-up tweak once seen live. */
      .ofov-identitySlot {
        padding: 0.6rem 0.6rem 0; flex-shrink: 0;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .ofov-identitySlot > div {
        display: flex !important; flex-direction: column !important;
        align-items: stretch !important; gap: 0.4rem !important;
        width: 100% !important; height: auto !important;
        min-height: 0 !important; max-height: none !important;
      }
      .ofov-identitySlot flag-input,
      .ofov-identitySlot username-input,
      .ofov-identitySlot cosmetics-input {
        width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important;
      }

      .ofov-rankedSection {
        padding: 0.6rem 0.65rem; flex-shrink: 0;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .ofov-rankedSection .ofov-modSectionLabel { margin: 0 0 0.3rem; }
      .ofov-rankedRow {
        display: flex; align-items: center; justify-content: space-between;
        font-size: var(--ofov-fs-sm); color: rgba(255,255,255,0.7); padding: 0.1rem 0;
      }
      .ofov-rankedRow strong { color: #fff; font-weight: var(--ofov-fw-bold); }

      /* --- TrackerFront profile/stats panel --- */
      .ofov-tfEmpty { color: rgba(255,255,255,0.45); font-size: var(--ofov-fs-sm); line-height: 1.4; }
      .ofov-tfHeader { display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.35rem; }
      .ofov-tfRankIcon { width: 1.1rem; height: 1.1rem; flex-shrink: 0; }
      .ofov-tfRankBadge {
        color: #06120f; font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-bold);
        text-transform: uppercase; letter-spacing: 0.04em;
        padding: var(--ofov-pad-badge); border-radius: var(--ofov-radius-badge);
      }
      .ofov-tfVerified { color: #4ade80; font-weight: var(--ofov-fw-bold); font-size: var(--ofov-fs-md); }
      .ofov-tfClan { color: rgba(255,255,255,0.5); font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-bold); }
      .ofov-tfRRRow { display: flex; align-items: center; gap: 0.4rem; }
      .ofov-tfRRBarTrack {
        flex: 1 1 auto; height: 0.4rem; background: rgba(255,255,255,0.12);
        border-radius: var(--ofov-radius-full); overflow: hidden;
      }
      .ofov-tfRRBarFill { height: 100%; border-radius: var(--ofov-radius-full); transition: width 300ms ease; }
      .ofov-tfRR { flex-shrink: 0; color: #fff; font-size: var(--ofov-fs-md); font-weight: var(--ofov-fw-bold); }
      .ofov-tfRRMax { color: rgba(255,255,255,0.4); font-size: var(--ofov-fs-sm); font-weight: var(--ofov-fw-regular); }
      .ofov-sparkline { width: 100%; height: 1.75rem; margin: 0.3rem 0; display: block; }
      .ofov-sparkline path { fill: none; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
      .ofov-tfMeta { color: rgba(255,255,255,0.6); font-size: var(--ofov-fs-sm); margin-top: 0.15rem; }
      .ofov-tfMeta strong { color: #fff; }
      .ofov-tfStreak { font-size: var(--ofov-fs-sm); font-weight: var(--ofov-fw-bold); margin-top: 0.4rem; }
      .ofov-tfStreak.ofov-tfWin { color: #4ade80; }
      .ofov-tfStreak.ofov-tfLoss { color: #f87171; }
      .ofov-tfGames { display: flex; flex-direction: column; gap: 0.4rem; }
      .ofov-tfGame {
        display: flex; align-items: flex-start; gap: 0.5rem;
        background: #0d1017; border: 1px solid rgba(255,255,255,0.08);
        border-left: 3px solid transparent;
        border-radius: var(--ofov-radius-btn); padding: 0.4rem; font-size: var(--ofov-fs-sm);
      }
      .ofov-tfGame.ofov-tfWin { border-left-color: #4ade80; }
      .ofov-tfGame.ofov-tfLoss { border-left-color: #f87171; }
      .ofov-tfGameThumb {
        width: 2rem; height: 2rem; flex-shrink: 0; object-fit: cover;
        border-radius: 0.3rem; background: rgba(255,255,255,0.08);
      }
      .ofov-tfGameBody { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
      .ofov-tfGameTop { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
      .ofov-tfGameSub {
        display: flex; align-items: center; gap: 0.3rem;
        color: rgba(255,255,255,0.55); font-size: var(--ofov-fs-xs);
      }
      .ofov-tfGameSubText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ofov-tfGameDate { margin-left: auto; flex-shrink: 0; }
      .ofov-tfResultTag {
        flex-shrink: 0; width: 1rem; height: 1rem; border-radius: var(--ofov-radius-badge);
        display: flex; align-items: center; justify-content: center;
        font-weight: var(--ofov-fw-bold); font-size: var(--ofov-fs-xs); color: #06120f;
      }
      .ofov-tfGame.ofov-tfWin .ofov-tfResultTag { background: #4ade80; }
      .ofov-tfGame.ofov-tfLoss .ofov-tfResultTag { background: #f87171; }
      .ofov-tfMap {
        flex: 1 1 auto; min-width: 0; color: #fff; font-weight: var(--ofov-fw-bold);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ofov-tfDelta { flex-shrink: 0; color: rgba(255,255,255,0.5); font-weight: var(--ofov-fw-bold); }
      .ofov-tfTracked { display: flex; align-items: center; gap: 0.15rem; margin-top: 0.15rem; flex-wrap: wrap; }
      .ofov-tfTrackedIcon { width: 0.85rem; height: 0.85rem; flex-shrink: 0; }
      .ofov-tfTrackedExtra { font-size: var(--ofov-fs-xs); color: rgba(255,255,255,0.4); margin-left: 0.1rem; }

      .ofov-filtersRow {
        display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; align-items: flex-start;
      }
      .ofov-field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 7rem; flex: 1 1 7rem; }
      .ofov-fieldGrow { flex: 1 1 10rem; }
      .ofov-field label {
        font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-black); text-transform: uppercase;
        letter-spacing: 0.03em; color: rgba(255,255,255,0.55);
      }
      /* Every text input/select/dropdown-trigger in the filters panel shares
         this same padding/radius/size — a field reads as the same kind of
         control no matter which of the three it happens to be. */
      .ofov-field select, .ofov-field input {
        background: #0d1017; color: #fff; border: 1px solid rgba(255,255,255,0.14);
        border-radius: var(--ofov-radius-btn); padding: var(--ofov-pad-field); font-size: var(--ofov-fs-md);
      }
      .ofov-field select:focus, .ofov-field input:focus { outline: 1px solid #4f9eff; }

      /* Compact multi-select dropdown (Teams/Map/Active profiles) — a
         trigger button plus a popover list of checkable rows, so picking
         several values is a plain click per row instead of a ctrl/cmd-click
         on a native multi-select list. */
      .ofov-msDropdown { position: relative; }
      .ofov-msTrigger {
        display: block; width: 100%; text-align: left;
        background: #0d1017; color: #fff; border: 1px solid rgba(255,255,255,0.14);
        border-radius: var(--ofov-radius-btn); padding: var(--ofov-pad-field);
        font-size: var(--ofov-fs-md); cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ofov-msTrigger:hover { filter: brightness(1.25); }
      .ofov-msTrigger[aria-expanded="true"] { outline: 1px solid #4f9eff; }
      .ofov-msList {
        position: absolute; top: calc(100% + 0.25rem); left: 0; right: 0; z-index: 50;
        max-height: 14rem; overflow-y: auto;
        background: #0d1017; border: 1px solid rgba(255,255,255,0.2); border-radius: var(--ofov-radius-btn);
        padding: 0.3rem;
        box-shadow: 0 10px 24px rgba(0,0,0,0.45);
      }
      .ofov-msItem {
        display: flex; align-items: center; gap: 0.4rem;
        padding: 0.3rem 0.4rem; border-radius: var(--ofov-radius-badge); cursor: pointer;
        font-size: var(--ofov-fs-md); color: #fff;
      }
      .ofov-msItem:hover { background: rgba(255,255,255,0.1); }
      .ofov-msItem input[type="checkbox"] { flex-shrink: 0; }

      .ofov-modSectionLabel {
        font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-black); text-transform: uppercase;
        letter-spacing: 0.05em; color: rgba(255,255,255,0.5);
        margin: 0.6rem 0 0.4rem;
      }
      .ofov-modSectionLabel:first-child { margin-top: 0; }
      .ofov-modGrid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr)); gap: 0.35rem;
      }
      /* Collapsed by default so ~37 modifier tri-groups don't dominate the
         popover — one disclosure covers both Modifier logic and Custom Lobby. */
      .ofov-details {
        margin-bottom: 0.6rem; padding-top: 0.5rem;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      .ofov-details > summary {
        cursor: pointer; list-style: none;
        font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-black); text-transform: uppercase;
        letter-spacing: 0.05em; color: rgba(255,255,255,0.7);
      }
      .ofov-details > summary::-webkit-details-marker { display: none; }
      .ofov-details > summary::before { content: "▸ "; }
      .ofov-details[open] > summary::before { content: "▾ "; }
      .ofov-details[open] > summary { margin-bottom: 0.5rem; }
      .ofov-modBox {
        background: #0d1017; border: 1px solid rgba(255,255,255,0.08);
        border-radius: var(--ofov-radius-btn); padding: 0.4rem 0.5rem;
      }
      .ofov-modTitle {
        font-size: var(--ofov-fs-sm); font-weight: var(--ofov-fw-bold); color: rgba(255,255,255,0.75); margin-bottom: 0.3rem;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ofov-triBtns { display: flex; gap: 0.25rem; }
      .ofov-triBtn {
        flex: 1; background: #0d1017; color: rgba(255,255,255,0.6);
        border: 1px solid rgba(255,255,255,0.1); border-radius: var(--ofov-radius-badge);
        font-size: var(--ofov-fs-xs); font-weight: var(--ofov-fw-black); padding: 0.2rem 0; cursor: pointer;
      }
      .ofov-triBtn:hover { filter: brightness(1.3); }
      .ofov-triBtn.active[data-val="or"] { background: #4f9eff; color: #fff; border-color: #4f9eff; }
      .ofov-triBtn.active[data-val="and"] { background: #4ade80; color: #06240f; border-color: #4ade80; }
      .ofov-triBtn.active[data-val="not"] { background: #f87171; color: #2a0808; border-color: #f87171; }
    `;
    document.head.appendChild(style);
  }

  const ACTIONS = {
    solo: () => document.querySelector("single-player-modal")?.open(),
    create: () => document.querySelector("host-lobby-modal")?.open(),
    // window.showPage?.("page-ranked") looks equivalent to the native
    // handler but skips its own gating (GameModeSelector.ts's
    // openRankedMenu checks shouldBlockMultiplayerAction and
    // validateUsername first) — clicking the real button instead (still in
    // the DOM, just CSS-hidden) guarantees identical behavior to the actual
    // Ranked card, including whatever that gating decides. It's the middle
    // of the three buttons in the create/ranked/join row (verified against
    // GameModeSelector.ts's render(), 2026-09-21).
    ranked: () => {
      const buttons = document.querySelectorAll("game-mode-selector div.grid.grid-cols-3 button");
      buttons[1]?.click();
    },
  };

  function mount(gms) {
    const root = document.createElement("div");
    root.id = "ofov-root";
    root.innerHTML = `
      <div id="ofov-layout" class="ofov-layout">
        <aside id="ofov-leftOuter" class="ofov-sidePanel">
          <div class="ofov-sidePanelHeader">
            <span>Profile</span>
            <div class="ofov-sidePanelHeaderBtns">
              <button type="button" id="ofov-tfRefresh" class="ofov-iconBtn" title="Refresh stats">⟳</button>
              <button type="button" id="ofov-leftCollapse" class="ofov-iconBtn" aria-expanded="true" title="Collapse">‹</button>
            </div>
          </div>
          <div id="ofov-identitySlot" class="ofov-identitySlot"></div>
          <div class="ofov-rankedSection">
            <div class="ofov-modSectionLabel">Ranked ELO</div>
            <div id="ofov-rankedElo">${rankedEloHtml()}</div>
          </div>
          <div id="ofov-tfBody" class="ofov-sidePanelBody"></div>
        </aside>

        <div class="ofov-mainCol">
          <div id="ofov-grid"></div>
          <div class="ofov-actions">
            <button class="ofov-actionBtn ofov-solo" data-action="solo">Solo</button>
            <button class="ofov-actionBtn" data-action="create">Create Lobby</button>
            <button class="ofov-actionBtn" data-action="ranked">Ranked</button>
            <button type="button" id="ofov-filtersToggle" class="ofov-actionBtn" aria-expanded="true">Filters</button>
          </div>
        </div>

        <aside id="ofov-filtersOuter" class="ofov-sidePanel">
          <div class="ofov-sidePanelHeader"><span>Filters</span></div>
          <div id="ofov-filtersPanel" class="ofov-sidePanelBody">${buildFiltersPanelHtml()}</div>
        </aside>
      </div>
    `;

    const filtersPanel = root.querySelector("#ofov-filtersPanel");
    const filtersOuter = root.querySelector("#ofov-filtersOuter");
    const filtersToggle = root.querySelector("#ofov-filtersToggle");
    wireFiltersPanel(filtersPanel);
    initProfilesAndFilters(filtersPanel);

    // The filters column is a permanent part of the layout now (not a
    // popover), so "collapsing" it just shrinks it to a thin strip instead
    // of hiding/showing content — same idea as the left panel's own chevron.
    filtersToggle?.addEventListener("click", () => {
      const willExpand = filtersOuter.classList.contains("ofov-collapsed");
      filtersOuter.classList.toggle("ofov-collapsed", !willExpand);
      filtersToggle.setAttribute("aria-expanded", String(willExpand));
    });

    const leftOuter = root.querySelector("#ofov-leftOuter");
    const leftCollapse = root.querySelector("#ofov-leftCollapse");
    leftCollapse?.addEventListener("click", () => {
      const willExpand = leftOuter.classList.contains("ofov-collapsed");
      leftOuter.classList.toggle("ofov-collapsed", !willExpand);
      leftCollapse.setAttribute("aria-expanded", String(willExpand));
      leftCollapse.textContent = willExpand ? "‹" : "›";
    });
    mountTrackerFrontPanel(root.querySelector("#ofov-tfBody"), root.querySelector("#ofov-tfRefresh"));

    // Closes any open Teams/Map/Active-profiles dropdown on an outside
    // click — added once here rather than in wireFiltersPanel, which reruns
    // on every panel rebuild (reset, applying a profile) and would
    // otherwise pile up duplicate listeners.
    document.addEventListener("click", (e) => {
      if (e.target.closest(".ofov-msDropdown")) return;
      filtersPanel.querySelectorAll(".ofov-msList").forEach((l) => { l.hidden = true; });
      filtersPanel.querySelectorAll(".ofov-msTrigger").forEach((t) => t.setAttribute("aria-expanded", "false"));
    });

    function joinFromCard(card) {
      const lobby = state.byId.get(card.dataset.gameId);
      if (!lobby) return;

      if (card.dataset.source === "hosted") {
        document.querySelector("join-lobby-modal")?.open({ lobbyId: lobby.gameID });
        return;
      }

      document.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: { gameID: lobby.gameID, source: "public", publicLobbyInfo: lobby },
          bubbles: true,
          composed: true,
        }),
      );
    }

    root.addEventListener("click", (e) => {
      const actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        ACTIONS[actionBtn.dataset.action]?.();
        return;
      }

      const card = e.target.closest("[data-game-id]");
      if (card) joinFromCard(card);
    });
    // Cards are focusable (tabindex="0"/role="button" in cardHtml) but
    // <article> has no native activation key handling like <button> does,
    // so Enter/Space have to be wired up by hand for keyboard users.
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("[data-game-id]");
      if (!card) return;
      e.preventDefault();
      joinFromCard(card);
    });
    // "scroll" doesn't bubble, and render() rebuilds .ofov-colCards on every
    // full snapshot — a listener on those elements wouldn't survive. root
    // itself is never rebuilt, so listen there in the capture phase instead,
    // which still sees scroll events from any descendant.
    root.addEventListener(
      "scroll",
      (e) => {
        if (e.target.classList?.contains("ofov-colCards")) updateColumnFade(e.target);
      },
      true,
    );
    gms.parentNode.insertBefore(root, gms);
  }

  // <news-box> ships CSS-hidden (see injectStyle) so it stops eating vertical
  // space above the lobby grid; this gives it back as a small icon instead of
  // dropping it. Targets <desktop-nav-bar>'s <nav> and <mobile-nav-bar>'s menu
  // list directly — verified against the actually-deployed release (v0.33.14),
  // not main: OpenFront has a newer <nav-utility-icons> refactor on main that
  // consolidates these into one component, but it isn't live yet, so building
  // against it was the mistake ("shape not yet released" — the same class of
  // bug as trusted-lobby GameConfig drift). Both are light-DOM Lit, same
  // "safe to touch from outside" pattern already relied on elsewhere here.
  // Retries briefly since the nav chrome and the play page aren't guaranteed
  // to mount in the same tick.
  function relocateNewsBox(attemptsLeft = 15) {
    const newsBox = document.querySelector("news-box");
    const desktopNav = document.querySelector("desktop-nav-bar nav");
    // Substring match, same reasoning as the game-mode-selector hide rules —
    // this div has no id/data-hook of its own, just a long Tailwind class
    // string, so anchor on one distinctive fragment of it.
    const mobileNav = document.querySelector('mobile-nav-bar div[class*="overflow-y-auto"]');
    if (!newsBox || (!desktopNav && !mobileNav)) {
      if (attemptsLeft > 0) setTimeout(() => relocateNewsBox(attemptsLeft - 1), 300);
      return;
    }

    const setOpen = (open) => newsBox.classList.toggle("ofov-newsOpen", open);
    // news-box renders `nothing` (no children at all) when it has no items
    // — cheaper and more robust than reaching into its private Lit state.
    const hasNews = () => newsBox.children.length > 0;

    const iconEls = [];
    function addIcon(container, html) {
      if (!container || container.querySelector(".ofov-newsIconWrap")) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      const el = wrap.firstElementChild;
      el.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        setOpen(!newsBox.classList.contains("ofov-newsOpen"));
      });
      container.appendChild(el);
      iconEls.push(el);
    }

    const dotHtml = `<span class="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full animate-ping ofov-newsDot"></span>
                 <span class="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full ofov-newsDot"></span>`;

    // news-box's own item list can change after this ran once (news
    // arriving later, or the user dismissing it) — re-derive the dot on
    // every childList change instead of baking a one-time snapshot into the
    // icon HTML above.
    function syncDot() {
      const show = hasNews();
      for (const el of iconEls) {
        el.querySelectorAll(".ofov-newsDot").forEach((d) => d.remove());
        if (show) el.insertAdjacentHTML("beforeend", dotHtml);
      }
    }

    // Matches the NEWS/STORE/HELP items' own markup shape exactly (a
    // `.relative` wrapper around a `.nav-menu-item` button plus its dot).
    addIcon(
      desktopNav,
      `<div class="relative ofov-newsIconWrap">
        <button
          class="nav-menu-item text-white/70 hover:text-malibu-blue font-medium tracking-wider uppercase cursor-pointer transition-colors [&.active]:text-malibu-blue"
          type="button"
          aria-label="News"
          title="News"
        >📰</button>
      </div>`,
    );

    // Mobile's menu items are full-width rows, not a button cluster.
    addIcon(
      mobileNav,
      `<div class="nav-menu-item flex items-center w-full cursor-pointer ofov-newsIconWrap">
        <button
          class="block text-left font-bold uppercase tracking-[0.05em] text-white/70 transition-all duration-200 cursor-pointer hover:text-blue-600"
          type="button"
        >📰 News</button>
      </div>`,
    );

    syncDot();
    new MutationObserver(syncDot).observe(newsBox, { childList: true });

    document.addEventListener("click", (e) => {
      if (!newsBox.classList.contains("ofov-newsOpen")) return;
      if (newsBox.contains(e.target) || e.target.closest(".ofov-newsIconWrap")) return;
      setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && newsBox.classList.contains("ofov-newsOpen")) setOpen(false);
    });
  }

  // <page-footer>'s <footer> has three sibling divs in a row (verified via
  // DevTools 2026-09-20, v0.34.11): the GitHub/Reddit/Discord/logo icon row,
  // then .footer-version (a real, stable class — the full version string,
  // shell version included, kept off the nav bar so a bug report can quote
  // it), then the Terms of Service/copyright/Privacy Policy row. Moving
  // .footer-version into that last row folds it into one line instead of
  // its own; the icon row moves into the footer's own left column, which
  // the footer's own comment says exists only so the Steam promo widget (in
  // the right column) never overlaps centered content — otherwise unused
  // here, so anchoring the icons there doesn't fight anything.
  function relocateFooter(attemptsLeft = 15) {
    const versionEl = document.querySelector(".footer-version");
    const tosRow = versionEl?.nextElementSibling;
    const iconsRow = versionEl?.previousElementSibling;
    if (!versionEl || !tosRow || !iconsRow) {
      if (attemptsLeft > 0) setTimeout(() => relocateFooter(attemptsLeft - 1), 300);
      return;
    }
    if (versionEl.classList.contains("ofov-footerVersionInline")) return; // already done

    versionEl.classList.add("ofov-footerVersionInline");
    tosRow.insertBefore(versionEl, tosRow.firstChild);

    iconsRow.classList.add("ofov-footerIconsCorner");
  }

  // The CSS hiding rules and the SOLO/CREATE/RANKED/hosted-join actions all
  // depend on OpenFront's current markup/components matching what this was
  // written against — nothing else here would notice if that assumption
  // silently broke (native grid reappearing, buttons doing nothing). Check
  // once after mount and fail loudly instead.
  function verifyIntegration(gms) {
    const grid = gms.querySelector('div[class*="sm:grid-cols-[2fr_1fr]"]');
    if (grid && getComputedStyle(grid).display !== "none") {
      console.error("[of-overlay] native lobby grid selector didn't match/hide — OpenFront's markup may have changed.");
    }
    for (const selector of ["single-player-modal", "host-lobby-modal", "join-lobby-modal"]) {
      const el = document.querySelector(selector);
      if (!el || typeof el.open !== "function") {
        console.error(`[of-overlay] <${selector}>.open() not found — its buttons/cards may silently do nothing.`);
      }
    }
  }

  let started = false;

  function init() {
    if (started) return;
    const gms = document.querySelector("game-mode-selector");
    if (!gms) {
      setTimeout(init, 200);
      return;
    }
    started = true;
    injectStyle();
    mount(gms);
    relocateNewsBox();
    relocateFooter();
    relocateIdentityBar();
    initRankedElo();
    connect();
    setInterval(tickTimers, 1000);
    setTimeout(() => verifyIntegration(gms), 1000);
  }

  init();
})();
