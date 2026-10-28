# Memchat Chrome 8.9.0.9

## Correction

- Remove artificial decimal-place limits from discount and markup percentages, as requested. The previous 8.9.0.8 two-decimal change misunderstood the requirement.
- Display every digit provided by native JavaScript Number string conversion; no toFixed, decimal cap or padded zeroes. This does not claim arbitrary/infinite mathematical precision.
- `142490-3156` displays `3156 руб. (2.214892273141975%)`, total `139334 руб.`.
- Original ruble amounts/totals, parsing, permissions, private storage and updater formats are unchanged. Published standalone userscripts are unchanged.

Source: https://github.com/xtalia/hatiko/commit/1216ea0848dcdc631d39edf75f7f6b68c7ecf051

## Verification

- Updated regression tests failed against 8.9.0.8, then passed after removing rounding.
- Full npm test: 256 passed, 0 failed, existing project jsdom 27.4.0 through NODE_PATH.
- Independent review approved all six changed files; focused calculator tests independently passed.
- Deterministic build/package tests, syntax and DEV-loader checks passed.
- Packaged headless Chromium 151.0.7922.34 verified real discount-tab input/Enter: full-precision discount and markup, repeating fractions, terminating and whole percentages.
- Existing native browser smoke passed: Panel recovery/419 and indicator click, cold-start field clearing, schedule and private settings across restart.
- Actual loaded scratch installation upgraded 8.9.0.8 -> 8.9.0.9 through PowerShell updater and extension-card Reload; same path/ID, calculator mode/history and clear-field preference preserved.
- Owned scratch profiles, synthetic pages/HTTP only. User browser, credentials and business documents were not modified. Native macOS execution is not claimed.

## Artifact and publication gate

- Release: https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.9
- ZIP SHA-256: `ba00de6fd4519848be69cd1203feaca73ba81783f1e4edb1e0593f40a3f628ba`
- ZIP: 303695 bytes, 12 members, unchanged seven-file extension V2 allowlist.
- Read back immutable ZIP and all unpacked artifact bytes, verify source/tag/latest refs and unchanged userscript blobs before advertising the update descriptor.
- After descriptor publication, exercise the fixed real online metadata URL through PowerShell and Git Bash: previous-version upgrade, no-op, corruption repair and complete prior-installation backup. Git Bash on Windows is not native macOS verification.

## Updating

Run your current adjacent Update-Memchat.cmd (Windows) or Update-Memchat.command (macOS), reload the extension at chrome://extensions and refresh working tabs. Do not remove the extension or change its installed path. Very old launchers must first be replaced with current adjacent files from the ZIP. This is a GitHub unpacked-extension release, not a Chrome Web Store publication.
