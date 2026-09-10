// ==UserScript==
// @name         OpenFront Lobby Overlay
// @namespace    https://minhkarl.github.io
// @version      1.7.5
// @description  Replaces OpenFront's home-screen lobby preview cards with the richer minhkarl.github.io dashboard cards, and removes the JOIN LOBBY button.
// @match        https://openfront.io/*
// @run-at       document-idle
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/lobby-wire.js
// @require      https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/modifier-labels.js
// @updateURL    https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js
// @downloadURL  https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];
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
  };

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

  // Shows the fade only when there's actually more below the visible area —
  // a column that fits without scrolling gets no fade at all.
  function updateColumnFade(colCardsEl) {
    const col = colCardsEl.closest(".ofov-col");
    if (!col) return;
    const hasMore = colCardsEl.scrollHeight - colCardsEl.clientHeight - colCardsEl.scrollTop > 2;
    col.classList.toggle("ofov-hasMoreBelow", hasMore);
  }

  function render(serverTime) {
    const root = document.getElementById("ofov-grid");
    if (!root) return;

    const firstRects = new Map();
    root.querySelectorAll(".ofov-card[data-game-id]").forEach((card) => {
      firstRects.set(card.dataset.gameId, card.getBoundingClientRect());
    });

    const html = CATEGORIES.map(({ key, label, dot, source }) => {
      const list = state.games[key] || [];
      const cards = list.length
        ? list
            .map((g) => {
              // One malformed lobby (or a modifier-labels.js @require that
              // failed to load) shouldn't take down every column — skip
              // just that card and keep going.
              try {
                return cardHtml(g, serverTime, source);
              } catch (e) {
                console.error("[of-overlay] failed to render lobby card", g?.gameID, e);
                return "";
              }
            })
            .join("")
        : `<div class="ofov-colEmpty">No open lobbies</div>`;
      return `
        <div class="ofov-col">
          <div class="ofov-colHeader">
            <span class="ofov-dot" style="background:${dot}"></span>
            ${escapeHtml(label.toUpperCase())}
            <span class="ofov-count">${list.length}</span>
          </div>
          <div class="ofov-colCards">${cards}</div>
          <div class="ofov-colCardsFade" aria-hidden="true">
            <span class="ofov-moreHint">▾ Scroll for more</span>
          </div>
        </div>
      `;
    }).join("");
    root.innerHTML = html;
    root.querySelectorAll(".ofov-colCards").forEach(updateColumnFade);

    state.timeEls.clear();
    state.metaEls.clear();

    // FLIP (First-Last-Invert-Play): a card that shifts position across a
    // rebuild — most commonly the one below a lobby that just ended sliding
    // up to take its place — jumps from doing this instantly to visibly
    // animating into its new spot. Read every card's rect first, in one
    // pass, before writing any style — writing a transform on one card would
    // otherwise invalidate layout for the next card's rect read, forcing a
    // separate synchronous reflow per moved card instead of sharing one.
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

  function connect() {
    const worker = WORKER_POOL[Math.floor(Math.random() * WORKER_POOL.length)];
    const ws = new WebSocket(`wss://openfront.io/${worker}/lobbies`);
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
      .ofov-col { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; position: relative; }
      .ofov-colHeader {
        display: flex; align-items: center; gap: 0.45rem;
        font-size: 0.85rem; font-weight: 800; color: #fff;
        text-transform: uppercase; letter-spacing: 0.03em;
        background: #1a1f2e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 0.6rem; padding: 0.5rem 0.75rem;
      }
      .ofov-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; flex-shrink: 0; }
      .ofov-count {
        margin-left: auto; background: rgba(255,255,255,0.12);
        border-radius: 999px; padding: 0.15rem 0.5rem; font-size: 0.75rem;
      }
      .ofov-colCards {
        display: flex; flex-direction: column; gap: 0.6rem;
        /* Exactly 2 cards (13rem each) + the gap between them — a 3rd card
           is fully clipped rather than peeking through, so scrolling only
           ever shows up once there's actually a 3rd+ lobby. */
        max-height: calc(13rem * 2 + 0.6rem);
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
        font-size: 0.62rem; font-weight: 800; color: #fff;
        text-transform: uppercase; letter-spacing: 0.05em;
        background: rgba(0,0,0,0.6); padding: 0.2rem 0.55rem; border-radius: 999px;
        animation: ofovMoreHintBounce 1.6s ease-in-out infinite;
      }
      @keyframes ofovMoreHintBounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(3px); }
      }
      .ofov-colEmpty {
        color: rgba(255,255,255,0.4); font-size: 0.75rem;
        text-align: center; padding: 1rem 0;
      }
      .ofov-card {
        position: relative;
        display: block;
        width: 100%;
        height: 13rem;
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
        position: absolute; top: 0.5rem; left: 0.5rem; right: 4.5rem;
        display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start;
      }
      .ofov-badge {
        background: #4f9eff; color: #fff; font-size: 0.65rem; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.05em;
        padding: 0.15rem 0.4rem; border-radius: 0.25rem;
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
    connect();
    setInterval(tickTimers, 1000);
    setTimeout(() => verifyIntegration(gms), 1000);
  }

  init();
})();
