# Memchat Chrome 8.9.0.3 — private storage and Panel session validation

## Scope

Extension-only follow-up to `8.9.0.2`. Generated `js/memchat.user.js`, `js/memchat/src/`, DEV userscript, and existing distribution userscripts stay unchanged. Production channel is the existing GitHub release/update index, not Chrome Web Store.

## User-visible changes

1. Small `bearer / panel` badges replace the old `Bearer: 200 — валиден` line inside the header; no second row beneath the header divider. Each remains independently clickable.
2. Memchat production preferences, Bearer, safe history and caches migrate from website localStorage to origin-scoped extension `chrome.storage.local`. Initialization hydrates a synchronous private adapter before executing the unchanged core.
3. Panel CSRF acquisition confirms actual protected API access (`GET /api/search/filters`) before returning success. A login page's anonymous CSRF is insufficient. The same-profile browser cookie session is reused without copying credentials/cookies into extension storage. 401/403/419 invalidate only the matching cached token; a late response for an old token cannot invalidate a renewed token. Existing forced refresh/one API retry is retained.

## Data guarantees

- Exact owned production-key allowlist, no DEV/site key deletion. Migration runs when each origin is next opened, not by silently visiting all sites.
- Persist and semantically verify read-back before acknowledging legacy cleanup; Chrome may reorder JSON object keys. Remove a website value only if it still equals the captured snapshot.
- Preserve conflicting legacy values in a private backup, not by rolling back canonical preferences; deleted values keep revision tombstones.
- Origin-scoped per-key compare-and-set (revision and previous value), serialized worker writes. An optimistic queued follow-up cannot overwrite another tab's winner after a conflict.
- `TRUSTED_CONTEXTS` enforced by Chrome; private runtime notifications target subscribed same-origin documents. No credential-bearing DOM StorageEvents.
- Shared MS transport rechecks the canonical saved Bearer at guarded dispatch, not only a possibly stale content cache. New-key changes invalidate old-tab access.
- Bonus/phone history is excluded from canonical records and migration backups.
- Quota/read/write failures are explicit and fail closed; there is no persistent website-storage fallback.
- Keep existing extension path/ID. Removing the extension erases Chrome-owned data; updater folder backups contain code only. No reverse migration of secrets into website storage for old-version rollback.

## Verification

- Standard JavaScript suite: **225 passed, 0 failed**.
- Sequential JavaScript suite: **225 passed, 0 failed**.
- Python updater suite: **32 run, 1 platform skip**, no failures.
- Actual headless Chromium 151: extension load, native action/context controls, top-layer/modal/fullscreen, calculator/history/settings persistence, live public Hatiko mount, safe runtime/network allowlist and cookie transport.
- Storage smoke with synthetic HTTP/accounts: migration preserving Bearer/safe history, unrelated site keys retained, actual `TRUSTED_CONTEXTS` access rejection, website-storage clearing, complete browser restart, origin separation, settings input changing a key in two tabs without DOM leakage.
- Order-service smoke: shared two-tab single-flight, one receiver, real alarm polling with no tabs, product/barcode snapshot and added-only no-network view, malformed-position rejection.
- Native Windows updater + actual Chrome reload: `8.9.0.2` to `8.9.0.3` at identical path/ID; calculator history and selected mode migrate into Chrome storage; old website keys disappear.
- Panel: real cookie attachment confirmed through CDP Network extra-info; mocked authenticated 419-to-refresh-to-success UI flow and expired-login handling. Real unauthenticated Panel request returns a safe auth error and opens no tab.
- Read-only inspection of the available existing browser profile found `/login` with a password form and a CSRF meta, and protected API HTTP **401**. No Panel login is present in the vault. A genuinely authenticated production-account search/bonus end-to-end test is therefore **not verified**, and no bypass is attempted. User must sign in to Panel in the same Chrome profile, then click `panel` to recheck.
- No business records written; no actual user credentials included in tests/package. macOS-native execution is not claimed by Windows Bash checks.

## Release contract

The V2 index and exact seven extension filenames remain compatible with the existing V2 updater. Build is deterministic. Publish immutable ZIP first, then advertise index; read back exact remote source/dist refs, all artifacts and the release ZIP byte-for-byte before reporting production success.
