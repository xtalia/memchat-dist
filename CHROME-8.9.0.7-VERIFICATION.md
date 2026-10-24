# Memchat Chrome 8.9.0.7

## Change

- Clicking the red `panel` connection indicator opens `https://panel.hatiko.ru/` in a new tab, with `noopener,noreferrer`.
- Hover text preserves the session/API failure reason and explains the click action.
- Green/yellow Panel clicks retain forced session recheck. Bearer behavior is unchanged.
- Settings, extension permissions, storage schema, updater format and standalone userscripts are unchanged.

Source: https://github.com/xtalia/hatiko/commit/1de70d1718d6e465d21afa7857e3777ae5b1fecf (includes feature commit `cf271e4`).

## Verification before publication

- Full `npm test`: 253 passed, 0 failed; existing project-compatible jsdom 27.4.0.
- Deterministic build covered by tests; packaged content.js and worker.js pass `node --check`.
- Packaged headless Chromium 151.0.7922.34: red indicator hover and real click open exactly one Panel tab with `window.opener === null`; existing Panel recovery/419, cold-start field clearing, private settings/restart and synthetic schedule rendering pass.
- Actual loaded scratch installation upgraded from 8.9.0.6 to 8.9.0.7 using Windows PowerShell updater and extension-card reload: identical extension path/ID, calculator mode/history and clear-field preference preserved.
- Browser scenarios use owned scratch profiles and synthetic HTTP/credentials; not authenticated production Panel E2E, not the user's installed browser. No business documents modified.

## Artifact

- Release: https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.7
- ZIP SHA-256: `864740b4d9f394db315f657c3a1632bfd822a119b0a9eb884d47c597deab61a6`
- ZIP: 303715 bytes, 12 members, including the unchanged seven-file V2 extension allowlist.
- Publication gate: download release ZIP back, compare exact bytes and all remote unpacked files, preserve userscript blob IDs, then advertise the update descriptor.

## Updating

Run your existing updated `Update-Memchat.cmd` (Windows) or `Update-Memchat.command` (macOS), then reload the extension at `chrome://extensions` and refresh working tabs. Keep the installed folder path and do not remove the extension. Very old launcher readers must first be replaced by the current launchers from the ZIP. macOS is not natively tested here; Bash updater verification runs under Git Bash on Windows.
