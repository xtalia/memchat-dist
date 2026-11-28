# Memchat Chrome 8.9.0.23 — verification

- Source baseline: [xtalia/hatiko merge 79b527a](https://github.com/xtalia/hatiko/commit/79b527a8ef3bfa7f1da6a086e9ae1e15a1570c56), the exact source commit recorded for 8.9.0.22. Building that baseline reproduced the public 8.9.0.22 ZIP byte-for-byte (SHA-256 `c6dbc381a8486a5757dd2f21d07fbb44efb3583241f6d17d30ff6ad268eae4b1`). The isolated fix is in source PR [#6](https://github.com/xtalia/hatiko/pull/6), commits `1bf851a` and `9ea1ff5`.
- Beta release: [chrome-v8.9.0.23](https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.23), release commit `2c559c33a4e4845b21499b686904d984a0026ca5`. Public ZIP SHA-256 `03d956264f5e58d5ae19311995a2c33a16b9df506f6ad471abb3b8c13433c62d`; anonymous download matched the local archive. The V3 descriptor and all nine runtime-file hashes were checked against the public ZIP.

## Verification

- Two independent builds of the isolated 8.9.0.23 source tree produced identical artifacts. The V3 package still contains exactly nine runtime files; generated content and worker pass `node --check`.
- Node suite: **473 passed, 0 failed**. Field-clear regression and package-focused rerun: **9 passed, 0 failed**. DEV loader check and all **20 architecture boundaries** passed.
- Updater suite: **38 run, 1 skipped, 0 failed**.
- Packaged headless Chromium 151.0.7922.34 smoke passed all six checks, including first-document Enter clearing, toggle on/off, stale timer and restart persistence. HTTP and credentials were synthetic; no user browser, production API, or business records were used.
- Standalone userscript artifacts were unchanged. This is a GitHub release, not a Chrome Web Store publication.
