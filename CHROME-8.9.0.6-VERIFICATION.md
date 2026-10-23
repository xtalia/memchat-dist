# Memchat Chrome 8.9.0.6 — verification record

Source: https://github.com/xtalia/hatiko/commit/99945c01d6d0148f77eccceb6a8123a27177c035
Panel recovery commit: https://github.com/xtalia/hatiko/commit/bed40c5
Architecture: https://github.com/xtalia/hatiko/blob/99945c01d6d0148f77eccceb6a8123a27177c035/docs/extension-architecture.md

## Changes

- Background Panel failures may recover using an already-open, logged-in same-profile Panel tab. Both session proof and dependent API work use that private content context; no cookie copying, persisted CSRF, surprise tabs or keepalive.
- Cold-start clear-field switch uses the private owned key and initializes before settings. Enter delay/on/off, IME, stale text, settings synchronization, legacy boolean migration, navigation and browser restart are covered.
- Native source-module build, explicit platform capabilities, split worker network/Panel/orders modules, dedicated field-clear controller and embedded source maps. No generated userscript dependency or chained runtime monkey-patching.
- Private storage remains TRUSTED_CONTEXTS and origin-separated. MS dispatch remains direct, with one transient read retry, credential guards and shared background notifier flights.

## Observed checks

- Baseline: 240/240 npm tests. Final ordinary `npm test`: **251/251**, zero failures, jsdom 27.4.0.
- **48 JavaScript source/smoke files** passed `node --check`; standalone build from **16 source modules** checked only in scratch. Published standalone artifacts were not rebuilt.
- Deterministic ZIP and source-hash normalization across CRLF/LF checkouts tested. Build works without `js/memchat.user.js` present. Source maps contain original source modules.
- Final packaged headless Chromium **151.0.7922.34**: native regressions; toolbar/calculators/top-layer/fullscreen/CSRF; private storage/migration/restart; settings/rules; shared orders/alarms/diagnostics; direct MS/cancellation/worker wake — all passed.
- The first document of a fresh browser profile exercises the quick clear switch and Enter **before any settings window was opened**.
- Native Google Docs transport handles a synthetic marked-up highlighted shift, replacements and correct Today/Tomorrow dates; renders schedule rows.
- Native updater offline suites: **34 tests, OK, one skip** because directory symlink creation is unavailable without Windows privileges. PowerShell and Git Bash executed; no native macOS claim.
- Actual owned-profile updater upgrade **8.9.0.5 → 8.9.0.6**, followed by the real Chrome extension-card reload arrow: identical extension ID/path, preserved private calculator history/mode, old website clear preference migrated.
- Opt-in **live read-only MoySklad** packaged check passed: checkbox alone → filtered GET → real toast, second tab, alarms, HTTP200 and HTTP412/API1005 diagnostics, disable. **businessWrites=0**, no page errors, real credential absent from local/session extension storage.

## Update compatibility

The V2 descriptor and exact seven-file allowlist are unchanged. `build-info.json` now honestly identifies `source: modules.json` and `source_kind: extension-native`. New readers accept legacy and native identities; unknown identities fail closed. Old readers reject the new identity before changing files.

**One-time migration:** download this ZIP and replace the four adjacent updater launcher files with the new copies. Run the updater against the **same existing `chrome-extension` directory**. Do not uninstall, move the directory, or load a second extension. Reload the extension card and working tabs afterward. Chrome Web Store publication is not part of this release.

## Package identity

ZIP SHA-256:

`1cf197687252227717af1ec77774e77ef9d67a181af89ffb0e28e40b1066c22c`

ZIP contains **12 members**: seven `chrome-extension/*` files, four platform launchers and README. `memchat-update.txt` is published outside the ZIP after the versioned release asset is uploaded and read back.

## Limits

Authenticated production Panel E2E and the user's installed browser were not accessed. Panel worker-denied/tab-authenticated recovery and highlighted schedule input are explicitly synthetic HTTP fixtures, not fabricated production results. The exact original incident's browser cookie trace was unavailable. Google Docs authentication is not treated as proof of Panel authentication. No business documents changed. Physical toolbar clicks are not claimed for headless callbacks, and physical speaker output/native macOS were not verified.

Final publication must separately read back release/tag/latest flags, ZIP bytes/SHA, unpacked files, source/dist refs, old userscript blob identities and online upgrade/no-op/repair in scratch. Those checks are recorded in the source goal journal after publication.
