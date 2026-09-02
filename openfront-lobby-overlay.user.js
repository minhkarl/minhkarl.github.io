// ==UserScript==
// @name         OpenFront Lobby Overlay
// @namespace    https://minhkarl.github.io
// @version      1.6.0
// @description  Replaces OpenFront's home-screen lobby preview cards with the richer minhkarl.github.io dashboard cards, and removes the JOIN LOBBY button.
// @match        https://openfront.io/*
// @run-at       document-idle
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/lobby-wire.js
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/modifier-labels.js
// @updateURL    https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js
// @grant        none
// ==/UserScript==

// Reuses lobby-wire.js (kept in sync by resync-lobby-wire.yml) over an
// independent connection to the same public lobby feed. Cards dispatch the
// same "join-lobby" event OpenFront's own cards do, so the real join flow
// is untouched — this only changes how lobbies are picked.
(function () {
  "use strict";

  const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];
  // hosted lobbies can't join via a raw "join-lobby" dispatch like the other
  // categories — join-lobby-modal.open() has to run first to set up tracking
  // state, or the lobby silently never opens (see the click handler).
  const CATEGORIES = [
    { key: "ffa", label: "Free For All", dot: "#4f9eff", source: "public" },
    { key: "team", label: "Teams", dot: "#4ade80", source: "public" },
    { key: "special", label: "Special", dot: "#facc15", source: "public" },
    { key: "hosted", label: "Custom", dot: "#f472b6", source: "hosted" },
  ];

  const state = {
    games: { ffa: [], team: [], special: [], hosted: [] },
    byId: new Map(),
    serverTime: undefined,
    serverTimeCapturedAt: undefined,
  };

  // Full snapshots (the only source of serverTime) arrive far less than once
  // a second, so extrapolate "now" from real elapsed time since the last one.
  // Past STALE_AFTER_MS (the socket's been down that long), stop trusting the
  // extrapolation — countdowns should fall back to "Open" rather than keep
  // ticking convincingly on data that's no longer being refreshed.
  const STALE_AFTER_MS = 30_000;

  function estimatedServerTime() {
    if (state.serverTime == null || state.serverTimeCapturedAt == null) return undefined;
    const elapsed = Date.now() - state.serverTimeCapturedAt;
    if (elapsed > STALE_AFTER_MS) return undefined;
    return state.serverTime + elapsed;
  }

  function getMapThumbnailUrl(mapName) {
    const slug = String(mapName || "")
      .toLowerCase()
      .replace(/[\s_]/g, "")
      .replace(/[^\w]/g, "");
    return `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`;
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
      .replaceAll('"', "&quot;");
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
      visibleBadgeLabels.map((l) => `<span class="ofov-badge">${escapeHtml(l)}</span>`).join("") +
      (hiddenBadgeLabels.length
        ? `<span class="ofov-badge ofov-badgeMore" title="${escapeHtml(hiddenBadgeLabels.join(", "))}">+${hiddenBadgeLabels.length} more</span>`
        : "");
    const featuredBadge = lobby.featured ? `<span class="ofov-badge ofov-featured">★ Featured</span>` : "";
    const cardTimeText = timeText(lobby, serverTime);
    const mode = modeSummaryLine(cfg, lobby.numClients);
    return `
      <article class="ofov-card" data-game-id="${escapeHtml(lobby.gameID)}" data-source="${source}" ${
      lobby.accent ? `data-accent="${escapeHtml(lobby.accent)}"` : ""
    }>
        <img class="ofov-img" src="${getMapThumbnailUrl(map)}" alt="${escapeHtml(map)}" loading="lazy"
             onerror="this.style.opacity='0';">
        <div class="ofov-badges">${featuredBadge}${badges}</div>
        <div class="ofov-time">${escapeHtml(cardTimeText)}</div>
        <div class="ofov-bottom">
          <div class="ofov-title">${escapeHtml(title)}</div>
          <div class="ofov-subrow">
            <div class="ofov-mode">${escapeHtml(mode)}</div>
            <div class="ofov-meta">
              <span>${escapeHtml(String(lobby.numClients ?? 0))}${
      cfg.maxPlayers != null ? "/" + escapeHtml(String(cfg.maxPlayers)) : ""
    } 👥</span>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function render(serverTime) {
    const root = document.getElementById("ofov-grid");
    if (!root) return;
    const html = CATEGORIES.map(({ key, label, dot, source }) => {
      const list = state.games[key] || [];
      const cards = list.length
        ? list.map((g) => cardHtml(g, serverTime, source)).join("")
        : `<div class="ofov-colEmpty">No open lobbies</div>`;
      return `
        <div class="ofov-col">
          <div class="ofov-colHeader">
            <span class="ofov-dot" style="background:${dot}"></span>
            ${escapeHtml(label.toUpperCase())}
            <span class="ofov-count">${list.length}</span>
          </div>
          <div class="ofov-colCards">${cards}</div>
        </div>
      `;
    }).join("");
    root.innerHTML = html;
  }

  function reindex() {
    state.byId.clear();
    for (const key of Object.keys(state.games)) {
      for (const g of state.games[key]) state.byId.set(String(g.gameID), g);
    }
  }

  // Patch player-count text in place rather than re-rendering the grid —
  // counts frames arrive often, and rebuilding on every one destroyed
  // whatever card the mouse was resting on (retriggering its hover transition
  // on every update, which looked like pulsating).
  function patchCounts(updatedIds) {
    for (const id of updatedIds) {
      const g = state.byId.get(id);
      const card = document.querySelector(`.ofov-card[data-game-id="${CSS.escape(id)}"]`);
      const metaSpan = card?.querySelector(".ofov-meta span");
      if (!g || !metaSpan) continue;
      const maxPlayers = g.gameConfig?.maxPlayers;
      metaSpan.textContent = `${g.numClients ?? 0}${maxPlayers != null ? "/" + maxPlayers : ""} 👥`;
    }
  }

  // Text-only patch, same reasoning as patchCounts above.
  function tickTimers() {
    const now = estimatedServerTime();
    if (now === undefined) return;
    document.querySelectorAll("#ofov-grid .ofov-card[data-game-id]").forEach((card) => {
      const lobby = state.byId.get(card.dataset.gameId);
      const timeEl = card.querySelector(".ofov-time");
      if (lobby && timeEl) timeEl.textContent = timeText(lobby, now);
    });
  }

  function connect() {
    const worker = WORKER_POOL[Math.floor(Math.random() * WORKER_POOL.length)];
    const ws = new WebSocket(`wss://openfront.io/${worker}/lobbies`);
    ws.binaryType = "arraybuffer";

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

    ws.onclose = () => setTimeout(connect, 3000);
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

      #ofov-root { width: 100%; }
      #ofov-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1rem;
        align-items: start;
      }
      @media (max-width: 640px) {
        #ofov-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      .ofov-col { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
      .ofov-colHeader {
        display: flex; align-items: center; gap: 0.4rem;
        font-size: 0.7rem; font-weight: 800; color: #fff;
        text-transform: uppercase; letter-spacing: 0.04em;
        background: #1a1f2e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 0.5rem; padding: 0.4rem 0.6rem;
      }
      .ofov-dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; flex-shrink: 0; }
      .ofov-count {
        margin-left: auto; background: rgba(255,255,255,0.12);
        border-radius: 999px; padding: 0.05rem 0.45rem; font-size: 0.65rem;
      }
      .ofov-colCards { display: flex; flex-direction: column; gap: 0.6rem; }
      .ofov-colEmpty {
        color: rgba(255,255,255,0.4); font-size: 0.75rem;
        text-align: center; padding: 1rem 0;
      }
      .ofov-card {
        position: relative;
        display: block;
        width: 100%;
        height: 13rem;
        border-radius: 1rem;
        overflow: hidden;
        background: #1a1f2e;
        cursor: pointer;
        border: none;
        padding: 0;
        transition: transform 0.15s ease;
      }
      .ofov-card:hover { transform: scale(1.02); }
      .ofov-card[data-accent="gold"] { box-shadow: 0 0 0 2px #facc15; }
      .ofov-img {
        position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; object-position: center;
      }
      .ofov-badges {
        position: absolute; top: 0.5rem; left: 0.5rem;
        display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start;
      }
      .ofov-badge {
        background: #4f9eff; color: #fff; font-size: 0.65rem; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.05em;
        padding: 0.15rem 0.4rem; border-radius: 0.25rem;
      }
      .ofov-featured { background: #facc15; color: #000; }
      .ofov-badgeMore { background: rgba(0,0,0,0.6); color: rgba(255,255,255,0.75); cursor: help; }
      .ofov-time {
        position: absolute; top: 0.5rem; right: 0.5rem;
        background: #4f9eff; color: #fff; font-size: 0.7rem; font-weight: 700;
        padding: 0.15rem 0.4rem; border-radius: 0.25rem;
      }
      .ofov-bottom {
        position: absolute; bottom: 0; left: 0; right: 0;
        background: linear-gradient(transparent, rgba(0,0,0,0.75) 40%);
        padding: 1.5rem 0.75rem 0.5rem;
      }
      .ofov-title {
        color: #fff; font-weight: 700; text-transform: uppercase;
        font-size: 0.9rem; letter-spacing: 0.03em;
      }
      .ofov-subrow {
        display: flex; align-items: center; justify-content: space-between;
        gap: 0.5rem; margin-top: 0.15rem;
      }
      .ofov-mode {
        color: rgba(255,255,255,0.65); font-size: 0.7rem;
        text-transform: uppercase; letter-spacing: 0.03em;
      }
      .ofov-meta { color: rgba(255,255,255,0.7); font-size: 0.7rem; flex-shrink: 0; }

      .ofov-actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
      .ofov-actionBtn {
        flex: 1; height: 3.5rem; border-radius: 0.5rem; border: none;
        background: #1a1f2e; color: #fff; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.05em; font-size: 0.85rem; cursor: pointer;
        transition: filter 0.15s ease, transform 0.15s ease;
      }
      .ofov-actionBtn:hover { filter: brightness(1.15); transform: scale(1.02); }
      .ofov-actionBtn:active { transform: scale(0.98); }
      .ofov-solo { background: #4f9eff; }
    `;
    document.head.appendChild(style);
  }

  const ACTIONS = {
    solo: () => document.querySelector("single-player-modal")?.open(),
    create: () => document.querySelector("host-lobby-modal")?.open(),
    ranked: () => window.showPage?.("page-ranked"),
  };

  function mount(gms) {
    const root = document.createElement("div");
    root.id = "ofov-root";
    root.innerHTML = `
      <div id="ofov-grid"></div>
      <div class="ofov-actions">
        <button class="ofov-actionBtn ofov-solo" data-action="solo">Solo</button>
        <button class="ofov-actionBtn" data-action="create">Create Lobby</button>
        <button class="ofov-actionBtn" data-action="ranked">Ranked</button>
      </div>
    `;
    root.addEventListener("click", (e) => {
      const actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        ACTIONS[actionBtn.dataset.action]?.();
        return;
      }

      const card = e.target.closest("[data-game-id]");
      if (!card) return;
      const lobby = state.byId.get(card.dataset.gameId);
      if (!lobby) return;

      if (card.dataset.source === "hosted") {
        document.querySelector("join-lobby-modal")?.open({ lobbyId: lobby.gameID, lobbyInfo: lobby });
        return;
      }

      document.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: { gameID: lobby.gameID, source: "public", publicLobbyInfo: lobby },
          bubbles: true,
          composed: true,
        }),
      );
    });
    gms.parentNode.insertBefore(root, gms);
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
    connect();
    setInterval(tickTimers, 1000);
    setTimeout(() => verifyIntegration(gms), 1000);
  }

  init();
})();
