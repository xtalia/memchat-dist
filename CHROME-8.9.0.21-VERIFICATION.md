# Memchat Chrome 8.9.0.21 — verification

- Source: [xtalia/hatiko merge 10168bb](https://github.com/xtalia/hatiko/commit/10168bb51226da552e8bb13dccff8614ab396203) ([PR #4](https://github.com/xtalia/hatiko/pull/4), [exact-source CI](https://github.com/xtalia/hatiko/actions/runs/45408810462)). All 61 input hashes match that commit with the builder's normalization.
- Public beta: [chrome-v8.9.0.21](https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.21), release commit `f4d417bb1eaaf93302f63bfc2b8c621ffe150468`. Public ZIP SHA-256 `c70d071a4bae802bc1ec95631de1a803d16da2f99109e7385b058b0e99db3d29`; anonymous download matched the tested ZIP byte-for-byte. Descriptor and all nine declared runtime files were independently read back and checked after promotion `6e7dd68`. Standalone userscripts unchanged.

## Verification

- 469/469 Node tests; DEV loader and 20 architecture boundaries pass. Two identical builds, worker/content/audio syntax checks and known private business ID scan pass.
- 13/13 packaged Chromium runs, including 220-pixel sidebar buttons in both modes and the modal click-interception fixture. Separate universal-sidebar smoke passed. 14 invocations with unchanged published V3 readers passed.
- The unchanged published Windows reader from `chrome-v8.9.0.11` used the public descriptor and archive to upgrade a scratch 8.9.0.20 install, preserving the previous exact files as backup. Online integrity-checked no-op and repair of one deliberately damaged file both passed; all nine new files match.

Tested with fixture data and owned Chromium profiles. The live MoySklad product dialog in Yandex Browser and actual business operations were not exercised. The user browser/profile was untouched. Chrome Web Store publication was not performed.
