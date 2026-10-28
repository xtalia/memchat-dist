# Memchat Chrome 8.9.0.8

## Change

- Discount and markup percentages display at most two decimal places; unnecessary trailing zeroes are removed.
- `142490-3156` now shows `3156 руб. (2.21%)`, total `139334 руб.`.
- Original ruble amounts and totals, parsing, permissions, storage and updater formats are unchanged.
- Independently published standalone userscripts are unchanged.

Source: https://github.com/xtalia/hatiko/commit/81f587a149e4bf8500d6191634ae90663e8329ee

## Verification before publication

- Exact reported example reproduced by a failing regression before the fix, then passed.
- Full `npm test`: 256 passed, 0 failed, using the existing project jsdom dependency through NODE_PATH.
- Independent review approved the production change; reviewer independently reproduced rounding and unchanged amounts, but did not repeat the full suite because its isolated environment lacked jsdom.
- Deterministic package/build tests, DEV-loader manifest check, source and packaged JavaScript syntax checks passed.
- Packaged headless Chromium 151.0.7922.34: real discount-tab input/Enter verified discount, markup, rounding up, whole percentages and trailing-zero removal.
- Existing packaged native smoke passed: Panel recovery/419, error-indicator click, cold-start field clearing, schedule rendering and private settings across browser restart.
- Actual loaded scratch installation upgraded 8.9.0.7 -> 8.9.0.8 via PowerShell updater and extension-card Reload; extension path/ID, calculator mode/history and private clear-field preference preserved.
- Tests use owned scratch browser profiles and synthetic pages/HTTP. User browser, real credentials and business documents were not modified. Native macOS execution is not claimed.

## Artifact

- Release: https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.8
- ZIP SHA-256: `0e72f3a36cdc0225ed619f93b1adbbeebdf23fa6ca1f616de7a6dd9cfe831210`
- ZIP: 303696 bytes, 12 members, unchanged seven-file V2 extension allowlist.
- Publication gate: read back immutable release ZIP and every unpacked artifact byte-for-byte, verify source/tag/latest refs and unchanged userscript blobs; only then advertise the update descriptor.
- After descriptor publication, verify the real fixed online URL using both PowerShell and Git Bash in owned scratch targets: previous-version upgrade, no-op, corruption repair and full previous-installation backups. Git Bash is not native macOS verification.

## Updating

Run your existing current `Update-Memchat.cmd` (Windows) or `Update-Memchat.command` (macOS), then reload the extension at `chrome://extensions` and refresh working tabs. Keep the installed folder path; do not remove the extension. Very old launchers must first be replaced with current adjacent launcher files from the ZIP. This is a GitHub unpacked-extension release, not a Chrome Web Store publication.
