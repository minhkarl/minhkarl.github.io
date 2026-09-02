// ==UserScript==
// @name         OpenFront Lobby Overlay
// @namespace    https://minhkarl.github.io
// @version      1.0.0
// @description  Replaces OpenFront's home-screen lobby preview cards with the richer minhkarl.github.io dashboard cards, and removes the JOIN LOBBY button.
// @match        https://openfront.io/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/gh/minhkarl/minhkarl.github.io@main/lobby-wire.js
// @grant        none
// ==/UserScript==

// This reuses lobby-wire.js verbatim (same decoder the dashboard uses, kept in
// sync with upstream by .github/workflows/resync-lobby-wire.yml) and opens its
// own independent connection to the same public lobby feed OpenFront's own
// <game-mode-selector> uses. Clicking a card dispatches the exact same
// "join-lobby" CustomEvent OpenFront's own cards dispatch (see
// GameModeSelector.ts#validateAndJoin and Main.ts#handleJoinLobby), so the
// real join flow (turnstile, join modal, etc.) is untouched — this only
// changes what the picker looks like, not how joining works.
(function () {
  "use strict";

  const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];
  const SLOTS = [
    { key: "ffa", label: "Free For All" },
    { key: "team", label: "Team" },
    { key: "special", label: "Special" },
  ];

  const state = {
    games: { ffa: [], team: [], special: [] },
    byId: new Map(),
  };

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

  // Trimmed port of index.html's gameModifierLabels() — only the badges that
  // matter at this card size. Working directly off the raw decoded
  // gameConfig/publicGameModifiers shape (no dashboard-side normalization).
  function modifierBadges(cfg) {
    const pm = cfg?.publicGameModifiers || {};
    const disabled = Array.isArray(cfg?.disabledUnits) ? cfg.disabledUnits : [];
    const labels = [];
    if (pm.isCompact === true || cfg?.gameMapSize === "Compact") labels.push("Compact Map");
    if (pm.isAlliancesDisabled === true || cfg?.disableAlliances === true) labels.push("Alliances Disabled");
    if (pm.isNukesDisabled === true || disabled.includes("Atom Bomb")) labels.push("Nukes Disabled");
    if (pm.isPortsDisabled === true || disabled.includes("Port")) labels.push("Ports Disabled");
    if (pm.isDoomsdayClock === true) {
      const speedLabels = { slow: "Slow", normal: "Normal", fast: "Fast", veryfast: "Very Fast" };
      const speed = cfg?.doomsdayClock?.speed;
      labels.push(speed ? `Doomsday Clock (${speedLabels[speed] || speed})` : "Doomsday Clock");
    }
    if (pm.isOvertime === true) {
      const startMinutes = cfg?.overtime?.startMinutes;
      labels.push(Number.isFinite(startMinutes) ? `Overtime (${startMinutes}m)` : "Overtime");
    }
    if (cfg?.rankedType) labels.push(`Ranked ${cfg.rankedType}`);
    if (cfg?.nations === "disabled") labels.push("Nations Disabled");
    return labels;
  }

  function cardHtml(lobby, serverTime) {
    const cfg = lobby.gameConfig || {};
    const map = cfg.gameMap || "—";
    const title = lobby.label || map;
    const badges = modifierBadges(cfg)
      .map((l) => `<span class="ofov-badge">${escapeHtml(l)}</span>`)
      .join("");
    const featuredBadge = lobby.featured ? `<span class="ofov-badge ofov-featured">★ Featured</span>` : "";
    const timeText =
      lobby.startsAt && serverTime
        ? (() => {
            const deltaS = (lobby.startsAt - serverTime) / 1000;
            return deltaS > 0 ? formatDuration(deltaS) : "Starting";
          })()
        : "Open";
    return `
      <article class="ofov-card" data-game-id="${escapeHtml(lobby.gameID)}" ${
      lobby.accent ? `data-accent="${escapeHtml(lobby.accent)}"` : ""
    }>
        <img class="ofov-img" src="${getMapThumbnailUrl(map)}" alt="${escapeHtml(map)}" loading="lazy"
             onerror="this.style.opacity='0';">
        <div class="ofov-badges">${featuredBadge}${badges}</div>
        <div class="ofov-time">${escapeHtml(timeText)}</div>
        <div class="ofov-bottom">
          <div class="ofov-title">${escapeHtml(title)}</div>
          <div class="ofov-meta">
            <span>${escapeHtml(String(lobby.numClients ?? 0))}${
      cfg.maxPlayers != null ? "/" + escapeHtml(String(cfg.maxPlayers)) : ""
    } 👥</span>
          </div>
        </div>
      </article>
    `;
  }

  function render(serverTime) {
    const root = document.getElementById("ofov-grid");
    if (!root) return;
    const html = SLOTS.map(({ key }) => {
      const lobby = state.games[key]?.[0];
      return lobby ? cardHtml(lobby, serverTime) : "";
    }).join("");
    root.innerHTML = html || `<div class="ofov-empty">Waiting for lobbies…</div>`;
  }

  function reindex() {
    state.byId.clear();
    for (const key of Object.keys(state.games)) {
      for (const g of state.games[key]) state.byId.set(String(g.gameID), g);
    }
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
        };
        reindex();
        render(msg.serverTime);
        return;
      }

      if (msg.type === "counts") {
        for (const [id, count] of Object.entries(msg.counts || {})) {
          const g = state.byId.get(String(id));
          if (g) g.numClients = count;
        }
        render();
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
      game-mode-selector div[class*="grid-cols-3"] {
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      }
      game-mode-selector div[class*="grid-cols-3"] > *:last-child { display: none !important; }

      #ofov-root { width: 100%; }
      #ofov-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem;
        min-height: 11rem;
      }
      .ofov-card {
        position: relative;
        display: block;
        width: 100%;
        height: 11rem;
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
      .ofov-meta { color: rgba(255,255,255,0.7); font-size: 0.7rem; margin-top: 0.15rem; }
      .ofov-empty {
        grid-column: 1 / -1; display: flex; align-items: center; justify-content: center;
        color: rgba(255,255,255,0.5); font-size: 0.85rem;
      }
    `;
    document.head.appendChild(style);
  }

  function mount(gms) {
    const root = document.createElement("div");
    root.id = "ofov-root";
    root.innerHTML = `<div id="ofov-grid"></div>`;
    root.addEventListener("click", (e) => {
      const card = e.target.closest("[data-game-id]");
      if (!card) return;
      const lobby = state.byId.get(card.dataset.gameId);
      if (!lobby) return;
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

  function init() {
    const gms = document.querySelector("game-mode-selector");
    if (!gms) {
      setTimeout(init, 200);
      return;
    }
    injectStyle();
    mount(gms);
    connect();
  }

  init();
})();
