# Memchat Chrome 8.9.0.22 — verification

- Source: [xtalia/hatiko merge 79b527a](https://github.com/xtalia/hatiko/commit/79b527a8ef3bfa7f1da6a086e9ae1e15a1570c56) ([PR #5](https://github.com/xtalia/hatiko/pull/5), [exact-source CI on the branch](https://github.com/xtalia/hatiko/actions/runs/45433058158), [CI on the merge commit](https://github.com/xtalia/hatiko/actions/runs/45434069647)). All 61 input hashes match that commit with the builder normalization.
- Public beta: [chrome-v8.9.0.22](https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.22), release commit `84c845f4b715a1ae334a957afaa37fcee57f6315`. Public ZIP SHA-256 `c6dbc381a8486a5757dd2f21d07fbb44efb3583241f6d17d30ff6ad268eae4b1`; anonymous download matched the tested ZIP byte-for-byte. Descriptor, ZIP and all nine declared runtime files were read back after promotion `015b48e`. Standalone userscripts unchanged.

## Verification

- 472/472 Node tests; DEV loader check and 20 architecture boundaries pass. Two identical builds, syntax checks of worker/content/audio and the private business-ID scan pass.
- 13/13 packaged Chromium runs, including the sidebar, shared-sidebar-buttons and updater smokes. Separate universal-sidebar smoke passed. 14 invocations with the unchanged published V3 reader passed.
- The unchanged Windows reader from `chrome-v8.9.0.11` upgraded a scratch 8.9.0.21 installation through the real public descriptor, keeping the exact previous files as backup. A second online run was an integrity-checked no-op, and repair of one deliberately damaged file restored all nine release bytes.

Fixtures and owned Chromium profiles only. The sidebar UI is now hosted by the extension runtime, so a site modal, a closed tab or an unsupported page cannot hide it; page-dependent site actions remain the only part gated by tab liveness and were not exercised against the live MoySklad UI in Yandex Browser. No live API calls, no price writes, no user browser/profile touched, no Chrome Web Store publication.
