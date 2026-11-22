# Memchat Chrome 8.9.0.18 — verification

Source: [xtalia/hatiko @ 81a592c21145f8edb82ed42140fb74b09501c002](https://github.com/xtalia/hatiko/commit/81a592c21145f8edb82ed42140fb74b09501c002).
Visible version: **2026-11-22 · beta**, Chrome 141+, updater schema **MEMCHAT_UPDATE_V3** (nine runtime files).

ZIP SHA-256: `3889d44c36309f33073b17a7c8a54940832c07c92733fb4d49a7d286dea1ec57`.

## Changes since distributed 8.9.0.16

- Conversation history is owned by each native sidebar document, in memory only. Close/reload starts an empty history; the autonomous input draft is no longer persisted. Settings, credentials and selected mode remain private and durable. Previously stored history is preserved but not loaded into the new chat.
- Captured request mode/owner/epoch prevents late results from switching modes or reviving a cleared history; superseded Panel responses are dropped.
- Private history channel bind no longer blocks the main view; timed-out ports are disconnected so retry can work.
- Existing legacy window retains its own ephemeral view; no new history is persisted from that surface either.
- Diagnostics setup is idempotent within its factory instance.

## Actual verification

- 425/425 Node tests, zero failures/skips/cancellations; loader check and 17 architecture boundaries pass.
- Updater unittest: 38 tests, OK; one skipped for Windows symlink privilege.
- Two builds have identical runtime, ZIP and update index; 55 normalized build input hashes independently match the exact source main commit.
- Complete sequential packaged confirmation: 12/12 pass (storage, orders-service, native-alerts, native-regressions, settings-rules, ms-direct, calculator-discount, top-layer, storage-conflict, notifier-race, sidebar, updater).
- Separate universal-sidebar smoke passes: unsupported/internal pages, no supported tabs, two-window isolation, native sender checks, canonical credential revocation and actual MV3 worker stop/wake.
- Unchanged published Windows updater from 8.9.0.11 upgrades at the same path, preserves all nine previous files in backup, then real extension-card Reload preserves ID and private settings/archived history.
- [Exact source merge CI: success](https://github.com/xtalia/hatiko/actions/runs/44995198344).

## Retained failure evidence / limitations

A previous complete packaged run passed 11/12 because updater smoke selected a restarting MV3 worker after real Reload (`worker.evaluate: Service worker restarted`, updater-smoke.cjs:85). One complete sequential confirmation then passed 12/12 without production-code changes. This is a remaining harness timing risk, not proof of an extension runtime defect. Full integration findings are [in the source release report](https://github.com/xtalia/hatiko/blob/81a592c21145f8edb82ed42140fb74b09501c002/docs/releases/memchat-chrome-8.9.0.18.md).

Tests use owned headless Chromium profiles and synthetic HTTP/credentials. No production business writes, user browser activation, native macOS/Linux checks, physical-speaker or OS-banner verification are claimed. Self-review was performed; no independent reviewer ran. GitHub distribution publication is not Chrome Web Store publication; updater installation and manual Chrome Reload are separate operations.
