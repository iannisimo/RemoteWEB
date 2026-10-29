# RemoteWEB

A userscript that makes websites usable with a TV remote or d-pad (arrow keys + Enter + Back), for media-center setups like KDE Plasma Bigscreen with a Bluetooth remote.

- **Spatial navigation:** arrow keys move a highlight to the nearest element in that direction, staying inside lists and carousels while possible. Finds plain `div`s with click handlers, hover-only buttons and elements inside web components.
- **Per-site rules** for pages where automatic movement guesses wrong, e.g. "on the first grid column, Left goes to the sidebar". Recorded on screen, no code needed.
- **Any key:** map remote buttons to actions or to the site's own shortcuts (Play/Pause → `k` on YouTube).
- **Text fields:** OK enters edit mode with real focus, so the system virtual keyboard can appear; Back leaves it.
- **Respects the site's focus style:** no extra ring where the site already shows one.
- No Tampermonkey-specific APIs, so the same file can be injected into Electron apps.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [remoteweb.user.js](https://raw.githubusercontent.com/iannisimo/RemoteWEB/main/remoteweb.user.js) and install it. It updates itself from this repo.

For auto-updates while editing locally, serve the script with `python3 serve.py` and install from `http://127.0.0.1:8765/remoteweb.user.js`. Every save becomes a new version.

## Use

The script is **off on every page** until you enable it.

| Key | Action |
|---|---|
| Ctrl+Shift+F8 | Settings: enable for the site/page, list and delete rules, options |
| Arrows / Enter / Esc | Move / activate / back |
| F4 | Record a rule, step by step |
| F5 | Make the highlighted element ignored by arrow movement (F5 again to undo) |
| F2 | Debug view: outline every element the script can reach |

Recorded rules and settings are stored in each site's browser storage. To make them permanent, use "Copy as CONFIG" in the settings dialog and paste the result into `CONFIG.sites` at the top of the script. Keys and global options are configured there too.

In the browser console, `__remoteweb.why($0)` explains why an inspected element can or can't be reached.

## Publish

`./push.sh "message" [patch|minor|major]` bumps `@version` if the script changed, then commits and pushes, so installed copies pick up the update.

## Test

Open `demo.html?test` in a browser; results appear at the bottom of the page. Headless:

```
chromium --headless=new --virtual-time-budget=40000 --dump-dom "file://$PWD/demo.html?test" | grep -E "^(PASS|FAIL)|results\">"
```

## License

[Unlicense](LICENSE): public domain.
