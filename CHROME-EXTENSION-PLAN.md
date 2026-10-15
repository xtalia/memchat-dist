# Memchat: background CSRF and top-layer window — Implementation Plan

**Goal:** Deliver a committed and published Chrome MV3 extension release that retrieves Panel CSRF silently using the existing browser session and keeps Memchat above page content without losing its state.

**Architecture:** Keep the generated production userscript 8.8.0-beta byte-for-byte unchanged. Add extension-only runtime adapters after the existing core and a dedicated validated CSRF request in the service worker. Use a transparent, nonmodal manual-popover host in the browser top layer for the existing windows; retain their elements and display-based toolbar toggle.

**Tech stack:** Chrome MV3, existing JavaScript core and Node test runner/jsdom, Python deterministic ZIP builder, installed Playwright/Chromium, GitHub git/gh.

## Verified context

- Source: E:/gitreps/hatiko. Dirty checkout main at 783d854 has unrelated debug-window/internal-order work. Do not alter or publish those files.
- Fetched origin/main a8eaa8412e4810884fc07f7f5144cc4874289ede has the same source tree as local HEAD but different history. Use an isolated worktree based on origin/main, not a reset/merge of the dirty checkout.
- Distribution: E:/gitreps/memchat-dist. Local checkout is stale; fetched origin/main is 7ac6bdd. Use a separate distribution worktree. Preserve both existing userscripts.
- Current extension: Chrome 8.8.0.1 / 8.8.0-beta-chrome.1. Wrapper-only next release: 8.8.0.2 / 8.8.0-beta-chrome.2.
- Existing CSRF path goes through generic panelRequest which expects API-like responses; failure may open a tab. Core caches CSRF in page localStorage separately per origin. Replace that path for the extension only.
- Native toolbar toggle and single reset context item must survive unchanged.
- gh authenticated as xtalia. Playwright and bundled Chromium are installed. No package installation required.

## Documentation-grounded constraints

- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests — cross-origin fetch belongs in extension worker with host permissions, not page/content fetch.
- https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using — manual popovers are nonmodal, not light-dismissed, and enter top layer.
- https://developer.mozilla.org/en-US/docs/Glossary/Top_layer — z-index cannot beat browser top layer. Later top-layer entries may cover earlier entries; modal dialogs make outside content inert.
- Existing valid same-profile Panel session is required; obtaining CSRF cannot bypass expired login, CAPTCHA, 2FA, browser policy, or server restrictions. No password collection, hidden login automation, or business writes.
- Above page elements means inside the tab, not above Chrome UI or other OS applications.

## Task 1: Isolate release

1. Create source release worktree/branch from fetched origin/main and distribution worktree/branch from fetched dist origin/main.
2. Reuse existing node_modules read-only via NODE_PATH; set TEMP/TMP to Hermes scratch.
3. Record baseline npm test and production/distribution userscript hashes.

## Task 2: Background CSRF (RED → GREEN)

Files: js/memchat/extension/worker.js; new js/memchat/extension/runtime.js; tests/chrome-extension-transport.test.js; new tests/chrome-extension-runtime.test.js.

1. Add one failing test for a dedicated memchat:panel-csrf message from a trusted top-frame content sender.
2. Implement fixed GET https://panel.hatiko.ru/search, HTML Accept, credentials:include, no X-Requested-With, no page opening. Bound fetch/body by timeout, use existing DNR readiness.
3. Reject login redirects/forms, failed status, invalid or missing token. Parse meta attributes in either order; do not mistake login form _token for authenticated CSRF.
4. Cache only in worker memory, TTL 12 minutes, share concurrent refreshes across tabs. A forced refresh invalidates stale cache; failures clear cache and release in-flight state.
5. Add tests for concurrency, forced refresh/419-retry integration, stale/failed login, malformed sender, timeout, no logs/secrets/localStorage.
6. Runtime adapts ensurePanelCsrf and refreshPanelCsrf to the private worker message; disable automatic Panel tab opening. Remove only legacy panelCsrf key for current site; never persist new token to site storage.
7. Existing Panel search/bonuses retry once after 401/403/419 using forced worker refresh. No generic transport URL expansion or additional permissions.

## Task 3: Top layer (RED → GREEN)

Files: new extension/top-layer.js, tests/chrome-extension-top-layer.test.js, extension/top-layer-smoke.cjs, extension/smoke.cjs.

1. Add a failing DOM test for an owned manual-popover host receiving the actual main and floating window nodes.
2. Create transparent full-viewport host with pointer-events:none and direct window children pointer-events:auto; reset default popover margin/border/padding. Keep existing coordinates, dimensions, drag/resize, native controls and close handlers.
3. Move only known Memchat roots into host; use one observer and coalesced refresh, no intervals. Exclude inline MoySklad quick panel.
4. Re-promote on subsequent site popover/dialog/fullscreen activity without self-trigger loops. Place host within active modal dialog/fullscreen subtree as necessary to avoid inertness. Restore owned focus on host changes. Return to body after dialog closes.
5. Test no duplicates, hidden main state, floating/settings windows, unrelated nodes untouched, host absence on unsupported API fallback.
6. Real headless browser: high-z-index full-screen overlay, later site popover, modal dialog/backdrop (including input click/focus), close/reopen, settings, reset, click-through outside windows, drag/resize, draft/history/tab persistence. Screenshot and inspect.

## Task 4: Package and verify

Files: extension/build.py, extension/README.md, tests/chrome-extension-build.test.js, extension/smoke.cjs.

1. Bump wrapper revision to 2 and include extension runtime after unchanged production core. Update exact version test expectations and architecture docs.
2. node --check changed/generated JS; node --test tests/chrome-extension-*.test.js; npm test; python extension/build.py; node extension/smoke.cjs.
3. Test authenticated behavior using explicit synthetic HTTP fixtures in isolated browser, clearly labelled as fixtures; perform read-only live Hatiko and unauthenticated Panel checks separately. Do not imply authenticated live Panel E2E without an actual user session.
4. Verify deterministic ZIP, exact entry set, no new privileges, source userscript hash unchanged.

## Task 5: Review, commit, release

1. Review full diff, security/error paths, tests; stage only task paths, commit source branch and fast-forward origin/main if unchanged. No force-push.
2. Copy exact package/ZIP/installation docs and this plan into isolated dist worktree. Preserve .gitattributes byte rules and both userscript blobs.
3. Commit dist artifacts, push; create GitHub release tagged chrome-v8.8.0.2 with ZIP and accurate notes. This is a GitHub package release, NOT Chrome Web Store publication; Unlisted distribution remains a separate publishing step.
4. Read exact remote refs and artifacts back, compare all ZIP entries and artifact bytes/SHA-256, download release asset and compare. Confirm old userscripts unchanged and source user WIP untouched.
5. Report release URL, commit handles, tests and any genuine verification limit.

## Acceptance criteria

- Valid existing session: no Panel tab/manual token copying required; tokens not persisted in site storage; concurrency shared and auth retry bounded.
- Expired login: honest error, no popup storm and no fabricated token.
- Main chat and settings/pickers appear over normal overlays and later browser top-layer UI, remain interactive in modal case, without losing drafts/history.
- Existing action/context menu contract preserved.
- Source commit and downloadable verified GitHub release exist. Chrome Web Store publication not claimed.
