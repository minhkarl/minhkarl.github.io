# minhkarl.github.io

Lobby browser for OpenFront.io. Shows every open lobby at once with filters, sorting and modifier info the game's own picker doesn't have. Live at https://minhkarl.github.io

## Userscript

`openfront-lobby-overlay.user.js` puts this same UI directly on openfront.io, replacing the native lobby cards and join button.

Install:
1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari)
2. Chrome/Edge only: go to `chrome://extensions`, click Details under Tampermonkey, turn on "Allow User Scripts"
3. Open the [raw script](https://raw.githubusercontent.com/minhkarl/minhkarl.github.io/main/openfront-lobby-overlay.user.js), Tampermonkey pops up an install prompt
4. Click Install
5. Open openfront.io, the lobby picker is replaced automatically

Updates: Tampermonkey checks the script's `@updateURL` on its own every so often (or you can force it from the Tampermonkey dashboard, "Check for userscript updates"), but it only pulls a new copy when the `@version` header changes. Every push touching `openfront-lobby-overlay.user.js`, `lobby-wire.js`, or `modifier-labels.js` auto-bumps `@version`, so real changes always ship a new version and get picked up on their own.

## Dev

Static files, no build step.

```sh
npx serve .
```

`lobby-wire.js` decodes OpenFront's binary lobby protocol and is kept in sync with upstream via `.github/workflows/resync-lobby-wire.yml`. Enum tables auto-update; a `GameConfig` shape change fails the workflow on purpose instead of guessing.
