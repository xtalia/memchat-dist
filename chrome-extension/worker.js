'use strict';
importScripts('config.js');
/* module: extension/storage-schema.js */
// Bundled into worker and isolated content; never exposed in the page world.
const MEMCHAT_STORAGE_KEYS = new Set([
    'debug', 'calcRules_v2', 'scheduleReplacements_v1', 'scheduleCacheEnabled_v1',
    'scheduleCache_v1_today', 'scheduleCache_v1_tomorrow', 'selectedAction_v1',
    'showHatikoLinks_v1', 'hatikoSearchMode_v1', 'retryBehavior_v1', 'hiddenFields_v1',
    'msQuickPanel_v1', 'floatWindowPos_v1', 'chatHistory_v1', 'clearTextDelay_v1',
    'clearTextEnabled', 'hackerDefaultChannel_v1', 'hackerQuickButtons_v1',
    'msMagicConfig_v1', 'msFieldsSpoilerOpen_v1', 'msReferenceCache_v1',
    'hackerMsApi_v1', 'hackerStates_v1', 'hackerOrderNotifier_v1',
    'hackerNotifierOrganizations_v1', 'hackerNotifierSeen_v1',
    'hackerInternalOrderCheck_v1', 'hackerInternalOrderWarehouses_v1'
].map(key => 'memchat:' + key).concat(['calcRules_v2', 'scheduleReplacements_v1']));
const MEMCHAT_RETIRED_STORAGE_KEYS = new Set(['memchat:panelCsrf_v1', 'clearTextEnabled']);
function extensionSanitizeStoredValue(key, value) {
    if (key === 'memchat:chatHistory_v1') {
        try { const history = JSON.parse(value);
            if (history && typeof history === 'object' && !Array.isArray(history)) {
                delete history.checkHatikoBonuses;
                return JSON.stringify(history);
            }
        } catch { /* Preserve malformed existing data, not a fabricated replacement. */ }
    }
    return value;
}
/* module: extension/storage-worker.js */
// Private storage is origin-scoped to preserve existing site/account separation.
// Chrome owns persistence; page localStorage is used only for one-time migration.
const privateStorageReady = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
})();
// Handle initialization rejection immediately, while retaining fail-closed awaits.
privateStorageReady.catch(() => {});
let privateStorageChain = Promise.resolve();
const privateStorageSubscribers = new Map();
function privateStorageSnapshot(bucket) {
    return JSON.stringify([bucket.version, Object.keys(bucket.items).sort().map(key =>
        [key, bucket.items[key].revision, bucket.items[key].value]),
    Object.keys(bucket.legacyBackup || {}).sort().map(key => [key, bucket.legacyBackup[key]]),
    (bucket.recoveries || []).map(entry => [entry.id, entry.key, entry.value, entry.document, entry.revision]),
    bucket.recoverySequence || 0, bucket.recoveryFences || []]);
}
// Private variants append normally; only explicit confirmed prune deletes one.
// No automatic eviction: exhaustion fails closed,
// and content must explicitly warn that the newest edit is NOT yet durable.
function privateStorageRecover(bucket, key, value, revision, document) {
    bucket.recoveries ||= [];
    const existing = bucket.recoveries.find(entry => entry.key === key && entry.value === value
        && entry.document === document && entry.revision === revision);
    if (existing) return;
    if (bucket.recoveries.length >= 128) {
        memchatDebugRecord({ level: 'error', scope: 'storage', event: 'capacity', detail: { key } }, 'worker');
        throw Error('Recovery capacity exhausted');
    }
    const id = Math.max(bucket.recoverySequence || 0, ...bucket.recoveries.map(entry => entry.id)) + 1;
    if (!Number.isSafeInteger(id)) {
        memchatDebugRecord({ level: 'error', scope: 'storage', event: 'capacity', detail: { key } }, 'worker');
        throw Error('Recovery ID exhausted');
    }
    bucket.recoverySequence = id;
    bucket.recoveries.push({ id, key, value, revision, document });
    if (JSON.stringify(bucket.recoveries).length > 5 * 1024 * 1024) {
        memchatDebugRecord({ level: 'error', scope: 'storage', event: 'capacity', detail: { key } }, 'worker');
        throw Error('Recovery capacity exhausted');
    }
}
function privateStorageRecoveryList(bucket) {
    // Never send recovery values (especially credentials/history) into a view.
    return (bucket.recoveries || []).map(({ id, key, value, revision }) => ({ id, key, deleted: value === null, revision }));
}
async function privateStorageCommit(storageKey, bucket) {
    await chrome.storage.local.set({ [storageKey]: bucket });
    const committed = (await chrome.storage.local.get(storageKey))[storageKey];
    if (!committed || privateStorageSnapshot(committed) !== privateStorageSnapshot(bucket)) {
        memchatDebugRecord({ level: 'error', scope: 'storage', event: 'verification', detail: {} }, 'worker');
        throw Error('Storage verification failed');
    }
    return committed;
}
async function privateStorageCredentialCurrent(sender, authorization) {
    await privateStorageReady;
    await privateStorageChain;
    const key = 'memchatPrivate_v1:' + runtimeSenderOrigin(sender);
    const saved = (await chrome.storage.local.get(key))[key];
    const api = JSON.parse(saved?.items['memchat:hackerMsApi_v1']?.value || '{}');
    return api.bearerEnabled === true && typeof api.token === 'string' && authorization === 'Bearer ' + api.token;
}
function privateStorageMessage(message, sender) {
    const operation = privateStorageChain.then(async () => {
        await privateStorageReady;
        const origin = runtimeSenderOrigin(sender);
        const storageKey = 'memchatPrivate_v1:' + origin;
        const saved = (await chrome.storage.local.get(storageKey))[storageKey];
        const bucket = saved || { version: 1, items: {}, legacyBackup: {} };
        if (bucket.version !== 1 || !bucket.items || typeof bucket.items !== 'object') throw Error('Invalid schema');
        if (message.type === 'memchat:storage-init') {
            const legacy = message.legacy;
            if (trustedNativeRuntimeSender(sender) && Object.keys(legacy || {}).length) throw Error('Native runtime cannot migrate page data');
            if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw Error('Invalid legacy snapshot');
            const cleanup = [];
            for (const [key, raw] of Object.entries(legacy)) {
                if (typeof raw !== 'string' || raw.length > 5 * 1024 * 1024) throw Error('Invalid value');
                if (key === 'clearTextEnabled' && ['true', 'false'].includes(raw)) {
                    if (!Object.hasOwn(bucket.items, 'memchat:clearTextEnabled')) {
                        const value = ['true', 'false'].includes(legacy['memchat:clearTextEnabled']) ? legacy['memchat:clearTextEnabled'] : raw;
                        bucket.items['memchat:clearTextEnabled'] = { value, revision: 1 };
                    } else if (bucket.items['memchat:clearTextEnabled'].value !== raw) {
                        bucket.legacyBackup ||= {};
                        bucket.legacyBackup.clearTextEnabled = raw;
                    }
                }
                if (MEMCHAT_RETIRED_STORAGE_KEYS.has(key)) { cleanup.push(key); continue; }
                if (!MEMCHAT_STORAGE_KEYS.has(key)) continue;
                const value = extensionSanitizeStoredValue(key, raw);
                if (!saved) bucket.items[key] = { value, revision: 1 };
                else if (bucket.items[key]?.value !== value) {
                    // An older userscript may recreate old keys. Preserve that copy
                    // privately, but never roll back the canonical extension state.
                    bucket.legacyBackup ||= {};
                    bucket.legacyBackup[key] = value;
                }
                cleanup.push(key);
            }
            // Acknowledge only after Chrome commits and a read-back verifies it.
            const committed = await privateStorageCommit(storageKey, bucket);
            privateStorageSubscribers.set(sender.tab?.id ?? 'native:' + sender.url, { origin, documentId: sender.documentId, sender });
            return { ok: true, items: committed.items, cleanup, recoveries: privateStorageRecoveryList(committed) };
        }
        if (message.type === 'memchat:storage-prune') {
            // Explicit irreversible deletion of ONE immutable ID, never a bulk clear.
            // Keep its document fence after deletion, and never recycle IDs (stale UI/ack retries).
            const sequence = Math.max(bucket.recoverySequence || 0, ...(bucket.recoveries || []).map(entry => entry.id));
            if (message.confirmed !== true || !Number.isSafeInteger(message.id) || message.id < 1 || message.id > sequence) throw Error('Invalid prune');
            const entry = bucket.recoveries?.find(item => item.id === message.id);
            bucket.recoverySequence = sequence;
            if (entry) {
                if (entry.document) {
                    bucket.recoveryFences ||= [];
                    if (!bucket.recoveryFences.some(([key, document]) => key === entry.key && document === entry.document)) {
                        bucket.recoveryFences.push([entry.key, entry.document]);
                    }
                }
                bucket.recoveries = bucket.recoveries.filter(item => item.id !== message.id);
            }
            const committed = await privateStorageCommit(storageKey, bucket);
            return { ok: true, recoveries: privateStorageRecoveryList(committed) };
        }
        if (['memchat:storage-write', 'memchat:storage-restore'].includes(message.type)) {
            const restoring = message.type === 'memchat:storage-restore';
            const recovery = restoring && Number.isSafeInteger(message.id)
                && bucket.recoveries?.find(entry => entry.id === message.id);
            if (restoring && !recovery) throw Error('Invalid recovery');
            const key = restoring ? recovery.key : message.key, revision = message.revision;
            const raw = restoring ? recovery.value : message.value;
            if (!MEMCHAT_STORAGE_KEYS.has(key) || !Number.isSafeInteger(revision) || revision < 0
                || revision >= Number.MAX_SAFE_INTEGER
                || (raw !== null && (typeof raw !== 'string' || raw.length > 5 * 1024 * 1024))) throw Error('Invalid write');
            const previous = bucket.items[key] || { value: null, revision: 0 };
            const value = raw === null ? null : extensionSanitizeStoredValue(key, raw);
            const document = sender.documentId || (trustedNativeRuntimeSender(sender) ? 'native:' + sender.url : 'tab:' + sender.tab.id);
            // Persist the document fence with the first conflict. Already sent
            // optimistic writes cannot accidentally overwrite the winner later,
            // including after worker suspension. Reload creates a new document.
            const blocked = !restoring && (bucket.recoveries?.some(entry => entry.key === key && entry.document === document)
                || bucket.recoveryFences?.some(([fencedKey, fencedDocument]) => fencedKey === key && fencedDocument === document));
            // A concurrent writer may have committed the identical desired value.
            // Only accept the immediately preceding revision so optimistic queued
            // writes continue from the revision the content adapter predicted.
            if (!blocked && !restoring && previous.revision === revision + 1 && previous.value === value) return { ok: true, item: previous };
            if (blocked || previous.revision !== revision || message.previousValue !== previous.value) {
                if (!restoring) {
                    privateStorageRecover(bucket, key, value, revision, document);
                    await privateStorageCommit(storageKey, bucket);
                }
                memchatDebugRecord({ level: 'error', scope: 'storage', event: 'conflict', detail: { key } }, 'worker');
                return { ok: false, conflict: true, recovered: true, key, item: previous,
                    recoveries: privateStorageRecoveryList(bucket) };
            }
            if (restoring && previous.value !== value) privateStorageRecover(bucket, key, previous.value, previous.revision, null);
            const item = { value, revision: revision + 1 };
            bucket.items[key] = item;
            await privateStorageCommit(storageKey, bucket);
            // Best-effort private invalidation; closed/replaced documents are ignored.
            for (const [tabId, subscriber] of privateStorageSubscribers) {
                if (tabId === (sender.tab?.id ?? 'native:' + sender.url) || subscriber.origin !== origin) continue;
                if (typeof tabId === 'string') {
                    try { nativeRuntimeNotify(subscriber.sender, { type: 'memchat:storage-changed', key, item }); }
                    catch { privateStorageSubscribers.delete(tabId); }
                    continue;
                }
                const options = subscriber.documentId ? { documentId: subscriber.documentId } : { frameId: 0 };
                chrome.tabs.sendMessage(tabId, { type: 'memchat:storage-changed', key, item }, options).catch(() => {
                    if (privateStorageSubscribers.get(tabId) === subscriber) privateStorageSubscribers.delete(tabId);
                });
            }
            return { ok: true, key, item, ...(restoring ? { recoveries: privateStorageRecoveryList(bucket) } : {}) };
        }
        throw Error('Invalid operation');
    });
    privateStorageChain = operation.catch(() => {});
    // Any rejected write is refused before it becomes durable; keep the key only,
    // never the value or the error text.
    operation.catch(() => {
        memchatDebugRecord({ level: 'error', scope: 'storage', event: 'rejected',
            detail: { key: typeof message.key === 'string' ? message.key.slice(0, 128) : null } }, 'worker');
    });
    return operation;
}
/* module: extension/worker/debug-log.js */
// Extension-wide ring buffer shared by the worker, the native panel and the
// content world. It lives in chrome.storage.session so worker suspension does
// not lose the trail while the browser stays open. Never prefer local storage:
// the log is diagnostic data, not durable state, and may be exported by a user.
const MEMCHAT_DEBUG_LOG_KEY = 'memchatDebugLog_v1';
const MEMCHAT_DEBUG_FLAG_KEY = 'memchatDebugEnabled_v1';
const MEMCHAT_DEBUG_LOG_LIMIT = 500;
const MEMCHAT_DEBUG_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MEMCHAT_DEBUG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const MEMCHAT_DEBUG_WORLDS = Object.freeze(['panel', 'content', 'runtime', 'worker']);
const MEMCHAT_DEBUG_SECRET_KEY = /token|password|authorization|cookie|secret|credential|csrf|apikey|api_key|session|bearer|signature|private/i;
// Query strings carry bearer-like values (?token=, ?access_token=, signed URLs)
// and the path can embed a session id; keep only origin+pathname for diagnostics.
function memchatDebugSafeUrl(raw) {
    try {
        const url = new URL(String(raw));
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '[URL]';
        return url.origin + url.pathname;
    } catch { return '[URL]'; }
}

function memchatDebugSanitize(value, key = '', depth = 0) {
    if (MEMCHAT_DEBUG_SECRET_KEY.test(key)) return '[REDACTED]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (depth >= 5) return '[MAX_DEPTH]';
    if (value instanceof Error) return {
        name: value.name,
        message: memchatDebugSanitize(String(value.message || ''), 'message', depth + 1),
        stack: memchatDebugSanitize(String(value.stack || ''), 'stack', depth + 1)
    };
    if (typeof value === 'string') {
        return value
            .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
            .replace(/\b(?:eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})\b/g, '[JWT]')
            .replace(/\b[0-9a-f]{32,}\b/gi, '[HEX]')
            .replace(/(?<![\d+])(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}\b/g, '[PHONE]')
            .slice(0, 3000);
    }
    if (Array.isArray(value)) return value.slice(0, 40).map(item => memchatDebugSanitize(item, key, depth + 1));
    if (typeof value === 'object') {
        const result = {};
        Object.keys(value).slice(0, 50).forEach(childKey => {
            try {
                result[childKey] = /^(url|href|origin|referrer)$/i.test(childKey) && typeof value[childKey] === 'string'
                    ? memchatDebugSafeUrl(value[childKey])
                    : memchatDebugSanitize(value[childKey], childKey, depth + 1);
            }
            catch { result[childKey] = '[UNREADABLE]'; }
        });
        return result;
    }
    return String(value).slice(0, 3000);
}

// In-memory mirror of the session buffer. All mutations share one promise chain
// so a burst of records cannot interleave a read-modify-write and lose entries.
let memchatDebugEntries = [];
let memchatDebugLoaded = false;
let memchatDebugChain = Promise.resolve();
let memchatDebugSequence = 0;

function memchatDebugFresh(entries) {
    const cutoff = Date.now() - MEMCHAT_DEBUG_LOG_MAX_AGE_MS;
    return (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && typeof entry.at === 'number' && entry.at >= cutoff)
        .slice(-MEMCHAT_DEBUG_LOG_LIMIT);
}

async function memchatDebugHydrate() {
    if (memchatDebugLoaded) return memchatDebugEntries;
    try {
        const saved = (await chrome.storage.session.get(MEMCHAT_DEBUG_LOG_KEY))[MEMCHAT_DEBUG_LOG_KEY];
        memchatDebugEntries = memchatDebugFresh(saved);
    } catch { memchatDebugEntries = []; }
    memchatDebugLoaded = true;
    return memchatDebugEntries;
}

async function memchatDebugEnabled() {
    try { return (await chrome.storage.local.get(MEMCHAT_DEBUG_FLAG_KEY))[MEMCHAT_DEBUG_FLAG_KEY] === 'true'; }
    catch { return false; }
}

async function memchatDebugSetEnabled(enabled) {
    const value = String(enabled === true);
    try {
        await chrome.storage.local.set({ [MEMCHAT_DEBUG_FLAG_KEY]: value });
        return (await chrome.storage.local.get(MEMCHAT_DEBUG_FLAG_KEY))[MEMCHAT_DEBUG_FLAG_KEY] === value;
    } catch { return false; }
}

function memchatDebugRecord(entry, world = 'worker') {
    const work = memchatDebugChain.then(async () => {
        try {
            const level = MEMCHAT_DEBUG_LEVELS.includes(entry?.level) ? entry.level : 'info';
            // Errors are always kept: they are what a user reports. Everything
            // else is opt-in because the buffer is shared and may be exported.
            if (level !== 'error' && !await memchatDebugEnabled()) return;
            const entries = await memchatDebugHydrate();
            const now = Date.now();
            entries.push({
                id: 'dl-' + now + '-' + (++memchatDebugSequence),
                at: now,
                world: MEMCHAT_DEBUG_WORLDS.includes(world) ? world : 'worker',
                level,
                scope: typeof entry?.scope === 'string' ? entry.scope.slice(0, 64) : 'app',
                event: typeof entry?.event === 'string' ? entry.event.slice(0, 200) : '',
                detail: memchatDebugSanitize(entry?.detail)
            });
            memchatDebugEntries = memchatDebugFresh(entries);
            try { await chrome.storage.session.set({ [MEMCHAT_DEBUG_LOG_KEY]: memchatDebugEntries }); }
            catch { /* Diagnostics must never disturb the operation being traced. */ }
        } catch { /* Same: a broken buffer cannot break business logic. */ }
    });
    memchatDebugChain = work.catch(() => {});
    return work;
}

// Entries are returned newest first so a pasted excerpt starts at the latest
// failure. `limit` is clamped to the ring size.
function memchatDebugRead(options = {}) {
    const work = memchatDebugChain.then(async () => {
        const enabled = await memchatDebugEnabled();
        let entries;
        try { entries = memchatDebugFresh(await memchatDebugHydrate()); memchatDebugEntries = entries; }
        catch { entries = []; }
        const limit = Number.isInteger(options?.limit)
            ? Math.min(Math.max(options.limit, 1), MEMCHAT_DEBUG_LOG_LIMIT) : MEMCHAT_DEBUG_LOG_LIMIT;
        return { ok: true, enabled, entries: entries.slice(-limit).reverse() };
    });
    memchatDebugChain = work.catch(() => {});
    return work.catch(() => ({ ok: true, enabled: false, entries: [] }));
}

function memchatDebugClear() {
    const work = memchatDebugChain.then(async () => {
        memchatDebugEntries = [];
        memchatDebugLoaded = true;
        try { await chrome.storage.session.set({ [MEMCHAT_DEBUG_LOG_KEY]: [] }); }
        catch { /* Clearing is best effort. */ }
        return { ok: true };
    });
    memchatDebugChain = work.catch(() => {});
    return work.catch(() => ({ ok: true }));
}
/* module: extension/worker/network.js */
'use strict';

const pendingRequests = new Map();
const rulesReady = chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1, 2],
    addRules: [
        { id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'https://panel.hatiko.ru' },
            { header: 'Referer', operation: 'set', value: 'https://panel.hatiko.ru/search' }
        ] }, condition: { initiatorDomains: [chrome.runtime.id], urlFilter: '|https://panel.hatiko.ru/', resourceTypes: ['xmlhttprequest'] } },
        { id: 2, priority: 2, action: { type: 'block' }, condition: {
            initiatorDomains: [chrome.runtime.id],
            excludedRequestDomains: [...new Set(MEMCHAT_EXTENSION_CONFIG.networkHosts.map(host => host.replace(/^\*\./, '')))],
            resourceTypes: ['xmlhttprequest']
        } }
    ]
});
// Fail closed: a failed DNR setup is caught here and blocks subsequent requests.
let ruleFailure = false;
rulesReady.catch(() => { ruleFailure = true; });

function matchesHost(hostname, pattern) {
    return pattern.startsWith('*.')
        ? hostname === pattern.slice(2) || hostname.endsWith('.' + pattern.slice(2))
        : hostname === pattern;
}

function allowedUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !MEMCHAT_EXTENSION_CONFIG.networkHosts.some(host => matchesHost(url.hostname, host))) {
        throw new Error('URL not permitted');
    }
    return url;
}

function trustedContentSender(sender) {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
    try {
        const url = new URL(sender.url);
        return url.protocol === 'https:' && !url.port && MEMCHAT_EXTENSION_CONFIG.pageMatches.some(pattern =>
            matchesHost(url.hostname, new URL(pattern.replace('*.', 'wildcard.')).hostname.replace('wildcard.', '*.')));
    } catch { return false; }
}

function requestKey(sender, id) {
    return trustedNativeRuntimeSender(sender) ? `native:${sender.url}:${id}` : `${sender.tab.id}:${sender.frameId}:${id}`;
}

// Dispatch MS requests directly. Only a failed read waits for its own retry;
// no profile-wide quota state, reservations, concurrency cap or pacing.
function isMsJsonApi(url) {
    return url.hostname === 'api.moysklad.ru' && /^\/api\/remap\/1\.2(?:\/|$)/.test(url.pathname);
}
function msRetryDelay(response, text = '') {
    if (response) {
        let quotaError = false;
        try { quotaError = JSON.parse(text)?.errors?.some(error => Number(error.code) === 1073) === true; } catch { /* Not JSON. */ }
        if (![408, 429].includes(response.status) && response.status < 500 && !quotaError) return null;
    }
    const lognex = Number(response?.headers.get('X-Lognex-Retry-After') || 0);
    const retryAfter = response?.headers.get('Retry-After');
    const seconds = retryAfter?.trim() ? Number(retryAfter) : 0;
    const standard = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    const delay = Math.max(500, Number.isFinite(lognex) ? lognex : 0, Number.isFinite(standard) ? standard : 0);
    return delay;
}
function msWaitForRetry(signal, delay) {
    return new Promise(resolve => {
        let remaining = delay;
        let timer;
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const schedule = () => {
            const chunk = Math.min(remaining, 2147483647);
            timer = setTimeout(() => {
                remaining -= chunk;
                if (remaining > 0) schedule();
                else done();
            }, chunk);
        };
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
        else schedule();
    });
}

async function performRequest(message, sender, backgroundSignal) {
    const request = message.request;
    const url = allowedUrl(request?.url);
    const method = String(request.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Method not permitted');
    if (request.data != null && typeof request.data !== 'string') throw new Error('Body must be text');
    if (request.data != null && ['GET', 'HEAD'].includes(method)) throw new Error('Unexpected body');
    if (request.responseType && !['text', 'json'].includes(request.responseType)) throw new Error('Unsupported response type');
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers || {})) {
        if (typeof value !== 'string') throw new Error('Invalid header');
        if (/^authorization$/i.test(name) && url.hostname !== 'api.moysklad.ru') throw new Error('Authorization host not permitted');
        if (/^(origin|referer|user-agent|cookie|host|content-length|connection|accept-encoding|proxy-.*|sec-.*)$/i.test(name)) continue;
        headers.set(name, value);
    }
    if (trustedNativeRuntimeSender(sender) && isMsJsonApi(url) && request.credentialGuard !== true) throw Error('Native credentials must be guarded');
    const key = requestKey(sender, message.id);
    if (pendingRequests.has(key)) throw new Error('Duplicate request');
    const entry = { controller: new AbortController(), event: '' };
    pendingRequests.set(key, entry);
    const cancelBackground = () => { entry.event = 'abort'; entry.controller.abort(); };
    backgroundSignal?.addEventListener('abort', cancelBackground, { once: true });
    if (backgroundSignal?.aborted) cancelBackground();
    const timeout = Math.min(30000, Math.max(1, Number(request.timeout) || 30000));
    let timer;
    const checkCurrent = request.credentialGuard === true ? async () => {
        let checkTimer;
        try {
            const result = await Promise.race([
                trustedNativeRuntimeSender(sender)
                    ? nativeRuntimeRequest(nativeRuntimeIdentities.get(sender), { type: 'memchat:request-current', id: message.id })
                    : chrome.tabs.sendMessage(sender.tab.id, { type: 'memchat:request-current', id: message.id }, sender.documentId ? { documentId: sender.documentId } : { frameId: sender.frameId }),
                new Promise(resolve => { checkTimer = setTimeout(() => resolve(null), 1000); })
            ]);
            if (result?.current === true && (!isMsJsonApi(url) || typeof privateStorageCredentialCurrent !== 'function'
                || await privateStorageCredentialCurrent(sender, headers.get('authorization')))) return;
        } catch { /* Missing/invalidated content world fails closed. */ }
        finally { clearTimeout(checkTimer); }
        entry.event = 'abort';
        entry.controller.abort();
    } : null;
    try {
        await rulesReady;
        if (ruleFailure) throw new Error('Network rules unavailable');
        if (url.origin === 'https://panel.hatiko.ru' && panelSession?.tab) {
            if (checkCurrent) await checkCurrent();
            return await panelRequestViaTab({ ...request, method }, entry.controller.signal);
        }
        for (let attempt = 0; ; attempt++) {
            if (entry.event) return { event: entry.event };
            if (checkCurrent) await checkCurrent();
            if (entry.event) return { event: entry.event };
            const canRetry = isMsJsonApi(url) && ['GET', 'HEAD'].includes(method) && attempt === 0;
            let retryDelay;
            try {
                const controller = entry.controller;
                timer = setTimeout(() => { entry.event = 'timeout'; controller.abort(); }, timeout);
                const response = await fetch(url.href, {
                    method, headers, body: request.data ?? undefined,
                    credentials: request.anonymous === true ? 'omit' : 'include',
                    signal: controller.signal, redirect: isMsJsonApi(url) ? 'error' : 'follow'
                });
                // DNR blocks redirects to ungranted hosts before sending bytes.
                allowedUrl(response.url || url.href);
                const responseText = await response.text();
                if (trustedNativeRuntimeSender(sender) && checkCurrent) await checkCurrent();
                if (entry.event) throw new Error('Cancelled');
                retryDelay = canRetry ? msRetryDelay(response, responseText) : null;
                // Path only: query strings can carry search terms or identifiers.
                if (response.status >= 400) memchatDebugRecord({ level: 'error', scope: 'network', event: 'http-error',
                    detail: { url: url.origin + url.pathname, status: response.status, retryDelay, attempt } }, 'worker');
                if (retryDelay === null) {
                    let parsed = responseText;
                    if (request.responseType === 'json') {
                        try { parsed = JSON.parse(responseText); } catch { parsed = null; }
                    }
                    return { event: 'load', response: {
                        status: response.status, statusText: response.statusText, responseText,
                        response: parsed, responseHeaders: [...response.headers].map(([name, value]) => `${name}: ${value}`).join(String.fromCharCode(13, 10)),
                        finalUrl: response.url || url.href, readyState: 4
                    } };
                }
            } catch {
                if (entry.event !== 'abort') memchatDebugRecord({ level: 'error', scope: 'network', event: 'network-error',
                    detail: { url: url.origin + url.pathname, status: null, retryDelay: canRetry ? 500 : null, attempt } }, 'worker');
                if (!canRetry || entry.event === 'abort') return { event: entry.event || 'error', error: 'Ошибка сети расширения Memchat' };
                retryDelay = 500;
            } finally { clearTimeout(timer); }
            // A timeout aborts its attempt, not the next one. Explicit aborts and
            // credential changes still cancel this wait and suppress the retry.
            entry.event = '';
            entry.controller = new AbortController();
            await msWaitForRetry(entry.controller.signal, retryDelay);
        }
    } catch {
        return { event: entry.event || 'error', error: 'Ошибка сети расширения Memchat' };
    } finally {
        clearTimeout(timer);
        backgroundSignal?.removeEventListener('abort', cancelBackground);
        pendingRequests.delete(key);
    }
}
/* module: extension/worker/panel-session.js */
// A single worker owns the Panel token. Never persist it into page storage.
const PANEL_SESSION_TTL = 12 * 60 * 1000;
const PANEL_SESSION_TIMEOUT = 15000;
let panelSession = null;
let normalPanelSessionFlight = null;
let forcedPanelSessionFlight = null;
let queuedPanelSessionFlight = null;

function extractPanelSessionToken(html) {
    const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(clean)) return '';
    for (const tag of clean.match(/<meta\b[^>]*>/gi) || []) {
        const attrs = {};
        for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            attrs[match[1].toLowerCase()] = match[2] ?? match[3];
        }
        if (attrs.name?.toLowerCase() === 'csrf-token' && /^[A-Za-z0-9_-]{16,512}$/.test(attrs.content || '')) return attrs.content;
    }
    return '';
}

let panelTabSequence = 0;
function panelTabUrl(raw) {
    try { const url = new URL(raw); return url.origin === 'https://panel.hatiko.ru' && !url.username && !url.password && !/^\/login\/?$/.test(url.pathname); }
    catch { return false; }
}
function panelTabRequestAllowed(request) {
    try {
        const url = new URL(request?.url), method = String(request.method || 'GET').toUpperCase();
        return panelTabUrl(url.href) && !url.hash && !url.search && ((method === 'GET'
            && (url.pathname === '/api/search/filters' || /^\/api\/bonuses\/check\/\d{1,20}$/.test(url.pathname)))
            || (method === 'POST' && url.pathname === '/api/search' && typeof request.data === 'string' && request.data.length <= 32768));
    } catch { return false; }
}
async function panelTabMessage(tabId, payload, signal) {
    const id = 'panel-' + Date.now() + '-' + (++panelTabSequence);
    let timer, abort;
    try {
        const timeout = new Promise(resolve => {
            abort = () => {
                chrome.tabs.sendMessage(tabId, { type: 'memchat:panel-tab', id, operation: 'cancel' }, { frameId: 0 }).catch(() => {});
                resolve(null);
            };
            timer = setTimeout(abort, PANEL_SESSION_TIMEOUT);
            signal?.addEventListener('abort', abort, { once: true });
        });
        if (signal?.aborted) return null;
        return await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'memchat:panel-tab', id, ...payload }, { frameId: 0 }), timeout]);
    } catch { return null; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function recoverPanelFromTab(signal) {
    if (!chrome.tabs?.query || !chrome.tabs?.get || signal.aborted) return null;
    try {
        const tabs = (await chrome.tabs.query({ url: 'https://panel.hatiko.ru/*' })).filter(tab => Number.isInteger(tab.id) && panelTabUrl(tab.url));
        tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
        for (const tab of tabs.slice(0, 3)) {
            if (signal.aborted) return null;
            const reply = await panelTabMessage(tab.id, { operation: 'session' }, signal);
            const current = await chrome.tabs.get(tab.id).catch(() => null);
            if (signal.aborted) return null;
            if (reply?.ok && /^[A-Za-z0-9_-]{16,512}$/.test(reply.token || '') && typeof reply.instance === 'string'
                && reply.instance.length <= 100 && panelTabUrl(current?.url)) {
                panelSession = { token: reply.token, savedAt: Date.now(), tab: { id: tab.id, instance: reply.instance } };
                return { ok: true, token: reply.token };
            }
        }
    } catch { /* Closed/navigated tabs are not an authenticated session. */ }
    return null;
}
async function panelRequestViaTab(request, signal) {
    const route = panelSession?.tab;
    if (!route || !panelTabRequestAllowed(request)) return { event: 'error', error: 'Panel: запрос отклонён' };
    const current = await chrome.tabs.get(route.id).catch(() => null);
    if (!panelTabUrl(current?.url) || signal.aborted) return { event: signal.aborted ? 'abort' : 'error', error: 'Panel: вкладка закрыта или изменена. Повторите проверку panel.' };
    const reply = await panelTabMessage(route.id, { operation: 'request', instance: route.instance, request }, signal);
    if (signal.aborted) return { event: 'abort' };
    const after = await chrome.tabs.get(route.id).catch(() => null);
    if (!reply?.ok || reply.instance !== route.instance || !panelTabUrl(after?.url) || reply.result?.event !== 'load'
        || !Number.isInteger(reply.result.response?.status) || reply.result.response?.finalUrl !== request.url) {
        if (panelSession?.tab === route) panelSession = null;
        memchatDebugRecord({ level: 'error', scope: 'panel', event: 'session-lost', detail: { reason: 'context' } }, 'worker');
        return { event: 'error', error: 'Panel: контекст вкладки изменился. Нажмите panel для повторной проверки.' };
    }
    return reply.result;
}

function startPanelSessionFlight(force) {
    // A queued normal flight may have populated the cache since force was requested.
    if (force) panelSession = null;
    const flight = { promise: null };
    flight.promise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PANEL_SESSION_TIMEOUT);
        const failure = async (reason, error) => {
            memchatDebugRecord({ level: 'error', scope: 'panel', event: 'session-failed', detail: { reason } }, 'worker');
            return (await recoverPanelFromTab(controller.signal)) || { ok: false, reason, error };
        };
        try {
            await rulesReady;
            if (ruleFailure || controller.signal.aborted) throw new Error('Panel unavailable');
            const response = await fetch('https://panel.hatiko.ru/search', {
                method: 'GET', headers: { Accept: 'text/html' }, credentials: 'include',
                cache: 'no-store', redirect: 'follow', signal: controller.signal
            });
            const finalUrl = new URL(response.url || 'https://panel.hatiko.ru/search');
            if (finalUrl.origin !== 'https://panel.hatiko.ru' || !/^\/search\/?$/.test(finalUrl.pathname)
                || response.status < 200 || response.status >= 300) {
                return await failure('auth', 'Panel: фоновый вход недоступен. Откройте авторизованную panel.hatiko.ru в этом профиле и нажмите panel.');
            }
            const token = extractPanelSessionToken(await response.text());
            if (!token || controller.signal.aborted) return await failure('auth', 'Panel: не удалось подтвердить вход. Откройте panel.hatiko.ru и нажмите panel.');
            // Laravel issues CSRF even for anonymous login pages. Confirm access
            // to an actual protected read-only API with the same browser cookies.
            const auth = await fetch('https://panel.hatiko.ru/api/search/filters', {
                method: 'GET', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'include', cache: 'no-store', redirect: 'follow', signal: controller.signal
            });
            const authUrl = new URL(auth.url || 'https://panel.hatiko.ru/api/search/filters');
            if (auth.status < 200 || auth.status >= 300 || authUrl.origin !== 'https://panel.hatiko.ru'
                || authUrl.pathname !== '/api/search/filters' || !/application\/json/i.test(auth.headers.get('content-type') || '')) {
                panelSession = null;
                return await failure(auth.status >= 500 ? 'network' : 'auth', 'Panel: нет доступа к API. Откройте авторизованную panel.hatiko.ru и нажмите panel.');
            }
            const proof = await auth.json();
            if (!proof || typeof proof !== 'object' || controller.signal.aborted) throw Error('Invalid Panel auth proof');
            panelSession = { token, savedAt: Date.now() };
            return { ok: true, token };
        } catch {
            return await failure('network', 'Panel: не удалось проверить вход. Проверьте соединение и открытую вкладку panel.hatiko.ru.');
        } finally {
            clearTimeout(timer);
            if (force) {
                if (forcedPanelSessionFlight === flight) forcedPanelSessionFlight = null;
            } else if (normalPanelSessionFlight === flight) normalPanelSessionFlight = null;
        }
    })();
    if (force) forcedPanelSessionFlight = flight;
    else normalPanelSessionFlight = flight;
    return flight.promise;
}

function getPanelSession(force) {
    if (force) panelSession = null;
    if (forcedPanelSessionFlight) return forcedPanelSessionFlight.promise;
    if (queuedPanelSessionFlight) return queuedPanelSessionFlight.promise;
    if (force && normalPanelSessionFlight) {
        const queued = { promise: null };
        queued.promise = (async () => {
            try { await normalPanelSessionFlight.promise; }
            finally {
                if (queuedPanelSessionFlight === queued) queuedPanelSessionFlight = null;
            }
            return startPanelSessionFlight(true);
        })();
        queuedPanelSessionFlight = queued;
        return queued.promise;
    }
    if (!force && panelSession && Date.now() - panelSession.savedAt < PANEL_SESSION_TTL) return Promise.resolve({ ok: true, token: panelSession.token });
    if (!force && normalPanelSessionFlight) return normalPanelSessionFlight.promise;
    return startPanelSessionFlight(force);
}
/* module: extension/worker/order-alerts.js */
// Extension-owned presentation. No site DOM, tokens, or content-tab audio.
const ORDER_NOTIFICATION_ID = 'memchat-orders';
const ORDER_NOTIFICATION_EXPIRY = 'memchat-order-notification-expire';
function orderBearIcon(size) {
    const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext('2d'), s = size / 32;
    const oval = (x, y, rx, ry, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x * s, y * s, rx * s, ry * s, 0, 0, Math.PI * 2); ctx.fill(); };
    oval(7, 7, 6, 6, '#713f2a'); oval(25, 7, 6, 6, '#713f2a');
    oval(7, 7, 3, 3, '#d8aa78'); oval(25, 7, 3, 3, '#d8aa78');
    oval(16, 18, 14, 13, '#98623b');
    oval(16, 24, 8, 6, '#edc99b');
    oval(10, 17, 2, 2.5, '#23150e'); oval(22, 17, 2, 2.5, '#23150e');
    oval(16, 22, 3, 2, '#23150e'); oval(16, 26, 2, 1, '#713f2a');
    return ctx.getImageData(0, 0, size, size);
}
async function orderUpdateIcon() {
    if (!chrome.action?.setIcon) return;
    const enabled = orderConfig?.settings.enabled === true;
    await chrome.action.setIcon(enabled ? { imageData: { 16: orderBearIcon(16), 32: orderBearIcon(32) } } : { path: 'icon.png' });
    await chrome.action.setTitle({ title: enabled ? '🐻 Оповещатель включён · Открыть боковую панель Memchat' : 'Открыть Мемчат в боковой панели' });
}
let orderAudioCreating = null;
let orderAudioGeneration = 0;
async function orderStopAudio() {
    orderAudioGeneration++;
    if (!chrome.runtime.getContexts) return;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] });
    if (contexts.length) await chrome.runtime.sendMessage({ target: 'memchat-offscreen', type: 'memchat:audio-stop' });
}
async function orderEnsureAudio() {
    if (orderAudioCreating) return orderAudioCreating;
    orderAudioCreating = (async () => {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] });
        if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'One shared Memchat order alarm, independent of open MoySklad tabs.' });
    })().finally(() => { orderAudioCreating = null; });
    return orderAudioCreating;
}
async function orderPlayAudio(isCurrent = () => true) {
    const generation = orderAudioGeneration;
    await orderEnsureAudio();
    if (!isCurrent() || generation !== orderAudioGeneration) return;
    const response = await chrome.runtime.sendMessage({ target: 'memchat-offscreen', type: 'memchat:audio-play' });
    if (!response?.ok) throw Error('Звук расширения недоступен');
}
async function orderPresentResult(result, config, controller) {
    const current = () => config === orderConfig && config.settings.enabled && !controller.signal.aborted;
    if (!result.orders.length || !current()) return [];
    const notify = async () => {
        const permission = await chrome.notifications.getPermissionLevel();
        if (!current()) return;
        if (permission !== 'granted') throw Error('Уведомления отключены в браузере');
        const orders = result.orders;
        await chrome.notifications.create(ORDER_NOTIFICATION_ID, { type: 'basic', iconUrl: 'icon.png',
            title: '🐻 Memchat · Заказы: ' + orders.length,
            message: orders.slice(0, 3).map(item => String(item.name).slice(0, 80) + ' · ' + String(item.organizationName).slice(0, 80)).join('\n') + (result.partial ? '\n⚠ Опрос неполный' : ''),
            priority: 0, silent: true, requireInteraction: config.settings.toastDurationMinutes === 0 });
        if (!current()) { await chrome.notifications.clear(ORDER_NOTIFICATION_ID); return; }
        if (config.settings.toastDurationMinutes > 0) await chrome.alarms.create(ORDER_NOTIFICATION_EXPIRY, { when: Date.now() + config.settings.toastDurationMinutes * 60000 });
        else await chrome.alarms.clear(ORDER_NOTIFICATION_EXPIRY);
    };
    const tasks = [notify()];
    if (config.settings.soundEnabled) tasks.push(orderPlayAudio(current));
    const outcomes = await Promise.allSettled(tasks);
    return outcomes.flatMap((item, index) => item.status === 'rejected' ? [index === 0 ? 'Системные уведомления недоступны' : 'Звук расширения недоступен'] : []);
}
if (chrome.notifications?.onClicked) chrome.notifications.onClicked.addListener(id => {
    if (id !== ORDER_NOTIFICATION_ID) return;
    chrome.tabs.create({ url: 'https://online.moysklad.ru/app/#customerorder', active: true }).catch(() => {});
    chrome.notifications.clear(id).catch(() => {});
    chrome.alarms.clear(ORDER_NOTIFICATION_EXPIRY).catch(() => {});
});
/* module: extension/worker/orders.js */
// Shared order polling is independent of the lifetime/number of content tabs.
// Session storage is extension-private; bearer never enters a broadcast or logs.
const ORDER_SESSION_KEY = 'memchatOrderService_v1';
let orderConfig = null;
let orderSubscribers = new Set();
let orderRevision = 0;
let orderFlight = null;
let orderController = null;
let orderLastResult = null;
let orderConfigChain = Promise.resolve();
function orderMutate(callback) {
    const next = orderConfigChain.then(callback);
    orderConfigChain = next.catch(() => {});
    return next;
}
const orderReady = (async () => {
    try {
        const saved = (await chrome.storage.session.get(ORDER_SESSION_KEY))[ORDER_SESSION_KEY];
        if (saved) { orderConfig = saved.config; orderRevision = saved.revision || 0; orderSubscribers = new Set(saved.subscribers || []); }
        await orderUpdateIcon();
    } catch { /* Configure must successfully persist before enabling polling. */ }
})();
function orderPublicConfig() {
    return { ok: true, settings: orderConfig?.settings, revision: orderRevision };
}
function orderReference(value, kind) {
    return typeof value === 'string' && new RegExp('^https://api\\.moysklad\\.ru/api/remap/1\\.2/entity/' + kind + '/[A-Za-z0-9-]+$').test(value);
}
function orderSettings(raw) {
    const refs = (values, kind) => {
        if (!Array.isArray(values) || !values.every(value => orderReference(value, kind))) throw Error('Invalid references');
        return [...new Set(values)];
    };
    return { enabled: raw?.enabled !== false, soundEnabled: raw?.soundEnabled !== false,
        intervalMinutes: Math.min(1440, Math.max(1, Math.round(Number(raw?.intervalMinutes) || 1))),
        toastDurationMinutes: Math.min(1440, Math.max(0, Math.round(Number(raw?.toastDurationMinutes) || 0))),
        organizationHrefs: refs(raw?.organizationHrefs, 'organization'),
        statusHrefs: refs(raw?.statusHrefs, 'customerorder/metadata/states') };
}
async function orderSetAlarm() {
    if (!orderConfig?.settings.enabled || !orderConfig.settings.soundEnabled) await orderStopAudio().catch(() => {});
    if (!orderConfig?.settings.enabled && chrome.notifications?.clear) await chrome.notifications.clear(ORDER_NOTIFICATION_ID).catch(() => {});
    // Toolbar presentation must never prevent scheduling or pausing the service.
    await orderUpdateIcon().catch(() => {});
    if (!chrome.alarms) return;
    if (!orderConfig?.settings.enabled) await chrome.alarms.clear(ORDER_NOTIFICATION_EXPIRY);
    if (orderConfig?.settings.enabled && orderConfig.settings.organizationHrefs.length && orderConfig.settings.statusHrefs.length) {
        await chrome.alarms.create('memchat-orders', { periodInMinutes: orderConfig.settings.intervalMinutes });
    } else await chrome.alarms.clear('memchat-orders');
}
async function configureOrders(message, sender) {
    await orderReady;
    if (typeof message.token !== 'string' || !message.token.trim() || message.token.length > 4096) throw Error('Invalid token');
    const settings = orderSettings(message.settings);
    const unchanged = orderConfig?.token === message.token && JSON.stringify(orderConfig.settings) === JSON.stringify(settings);
    if (orderConfig && (message.update !== true || unchanged)) {
        if (orderConfig.token !== message.token) return { ok: false, revision: orderRevision, error: 'Другой Bearer в фоне. Сохраните настройки явно для смены аккаунта.' };
        if (sender.tab) orderSubscribers.add(sender.tab.id);
        await chrome.storage.session.set({ [ORDER_SESSION_KEY]: { config: orderConfig, revision: orderRevision, subscribers: [...orderSubscribers] } });
        if (chrome.alarms?.get && !(await chrome.alarms.get('memchat-orders'))) await orderSetAlarm();
        return { ...orderPublicConfig(), pollRequired: false };
    }
    if (orderConfig && message.revision !== orderRevision) return { ...orderPublicConfig(), ok: false, conflict: true, error: 'Настройки изменены в другой вкладке. Повторите изменение.' };
    const subscribers = orderConfig?.token === message.token ? new Set(orderSubscribers) : new Set();
    if (sender.tab) subscribers.add(sender.tab.id);
    const config = { token: message.token, settings, organizations: (Array.isArray(message.organizations) ? message.organizations : [])
        .filter(item => settings.organizationHrefs.includes(item?.href)).map(item => ({ href: item.href, name: String(item.name || '').slice(0, 300) })) };
    await chrome.storage.session.set({ [ORDER_SESSION_KEY]: { config, revision: orderRevision + 1, subscribers: [...subscribers] } });
    orderController?.abort();
    orderConfig = config; orderSubscribers = subscribers; orderRevision++; orderLastResult = null;
    await orderSetAlarm();
    return { ...orderPublicConfig(), pollRequired: true };
}
async function orderGet(path, config, controller) {
    const response = await performRequest({ id: 'background-orders', request: {
        url: 'https://api.moysklad.ru/api/remap/1.2' + path, method: 'GET',
        headers: { Authorization: 'Bearer ' + config.token, Accept: 'application/json;charset=utf-8' },
        anonymous: true, backgroundOrder: true
    } }, { tab: { id: -1 }, frameId: 0 }, controller.signal);
    if (controller.signal.aborted || config !== orderConfig) throw Error('Cancelled');
    if (response.event !== 'load') throw Error('Ошибка соединения с МойСклад');
    const status = response.response.status;
    if (status < 200 || status >= 300) { const error = Error('МойСклад: HTTP ' + status); error.status = status; throw error; }
    let data;
    try { data = JSON.parse(response.response.responseText); } catch { throw Error('Некорректный ответ МойСклад'); }
    if (!Array.isArray(data?.rows)) throw Error('Неполный ответ списка заказов');
    return data;
}
async function deliverOrderResult(result, config, controller, revision) {
    if (!chrome.tabs?.query) return;
    const tabs = await chrome.tabs.query({});
    if (config !== orderConfig || controller.signal.aborted) return;
    const candidates = tabs.filter(tab => orderSubscribers.has(tab.id) && trustedContentSender({ id: chrome.runtime.id, tab, frameId: 0, url: tab.url }));
    candidates.sort((a, b) => Number(!!b.active) - Number(!!a.active));
    for (const tab of candidates) {
            if (config !== orderConfig || controller.signal.aborted) return;
            try {
            const ack = await chrome.tabs.sendMessage(tab.id, { type: 'memchat:orders-result', result, revision, settings: config.settings }, { frameId: 0 });
            if (ack?.ok) return;
        } catch { /* Try another live content world, not every tab. */ }
    }
    for (const native of nativeRuntimeSessions.values()) {
        if (native.orderToken !== config.token || native.orderRevision !== revision || config !== orderConfig || controller.signal.aborted) continue;
        try {
            if (!await privateStorageCredentialCurrent(native.sender, 'Bearer ' + config.token)) continue;
            const ack = await nativeRuntimeRequest(native, { type: 'memchat:orders-result', result, revision, settings: config.settings });
            if (ack?.ok) return;
        } catch { /* A closed native document is not another subscriber. */ }
    }
}
async function pollOrders() {
    await orderReady;
    await orderConfigChain;
    if (orderFlight) return orderFlight;
    const config = orderConfig;
    if (!config?.settings.enabled || !config.settings.organizationHrefs.length || !config.settings.statusHrefs.length) return { ok: false, error: 'Оповещатель выключен или не настроен' };
    const controller = new AbortController();
        const revision = orderRevision;
        orderController = controller;
    orderFlight = (async () => {
        const found = new Map(), failed = [];
        let authFailed = false;
        for (const href of config.settings.organizationHrefs) {
            const label = config.organizations.find(item => item.href === href)?.name || 'Организация недоступна';
            try {
                const rows = new Map();
                let offset = 0;
                for (;;) {
                    const filter = ['organization=' + href, ...config.settings.statusHrefs.map(state => 'state=' + state)].join(';');
                    const data = await orderGet('/entity/customerorder?filter=' + encodeURIComponent(filter)
                        + '&expand=state,organization&order=moment,desc&limit=100&offset=' + offset, config, controller);
                    const previous = rows.size;
                    for (const row of data.rows) {
                        if (!row?.id) throw Error('Заказ без идентификатора');
                        rows.set(row.id, row);
                    }
                    offset += data.rows.length;
                    const more = !!data.meta?.nextHref || (Number.isFinite(data.meta?.size) ? offset < data.meta.size : data.rows.length >= 100);
                    if (!more) break;
                    if (!data.rows.length || rows.size === previous) throw Error('Пагинация заказов не продвигается');
                }
                for (const row of rows.values()) if (config.settings.statusHrefs.includes(row.state?.meta?.href)) {
                    found.set(row.id, { id: row.id, name: row.name || row.id, stateName: row.state?.name || 'Новый', organizationName: label, organizationHref: href });
                }
            } catch (error) {
                if (controller.signal.aborted || config !== orderConfig) return { ok: false, error: 'Опрос отменён: настройки изменены' };
                failed.push(label + ' — ' + (error.message || 'Ошибка запроса'));
                if ([401, 403].includes(error.status)) { authFailed = true; break; }
            }
        }
        if (controller.signal.aborted || config !== orderConfig) return { ok: false, error: 'Опрос отменён' };
        if (authFailed) {
            await orderMutate(async () => {
                if (config !== orderConfig || controller.signal.aborted) return;
                config.settings.enabled = false;
                await chrome.storage.session.set({ [ORDER_SESSION_KEY]: { config, revision: ++orderRevision, subscribers: [...orderSubscribers] } });
                await orderSetAlarm();
            });
        }
        if (config !== orderConfig || controller.signal.aborted) return { ok: false, error: 'Опрос отменён' };
        const result = { id: String(Date.now()) + '-' + orderRevision, orders: [...found.values()], failed, partial: failed.length > 0,
            bearer: authFailed ? 'error' : failed.length === config.settings.organizationHrefs.length ? 'unknown' : 'ok', at: Date.now() };
        result.orders.forEach(order => { order.partial = result.partial; });
        orderLastResult = result;
        result.alertWarnings = await orderPresentResult(result, config, controller);
        if (config !== orderConfig || controller.signal.aborted) return { ok: false, error: 'Опрос отменён: настройки изменены' };
        await deliverOrderResult(result, config, controller, revision);
        return { ok: true, result };
    })().finally(() => { orderFlight = null; if (orderController === controller) orderController = null; });
    return orderFlight;
}
if (chrome.alarms) chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ORDER_NOTIFICATION_EXPIRY) return chrome.notifications.clear(ORDER_NOTIFICATION_ID).catch(() => {});
    if (alarm.name === 'memchat-orders') return pollOrders().catch(() => {});
});
/* module: extension/native-runtime-worker.js */
// Native runtime identities are real Chrome MessageSenders, never synthetic tabs.
// A one-use capability, delivered only to a verified SIDE_PANEL document, binds
// its child port to one window/origin for its entire lifetime.
const nativeRuntimeIdentities = new WeakMap();
const nativeRuntimeSessions = new Map();
const nativeRuntimeTickets = new Map();
let nativeDraftChain = Promise.resolve();
const NATIVE_LAST_ORIGIN_KEY = 'memchatNativeLastOrigin_v1';
let nativeSelectionChain = Promise.resolve();
function nativeSupportedOrigin(origin) {
    try {
        const url = new URL(origin);
        return url.origin === origin && url.protocol === 'https:' && !url.port && !url.username && !url.password
            && MEMCHAT_EXTENSION_CONFIG.pageMatches.some(pattern => {
                const host = new URL(pattern.replace('*.', 'wildcard.')).hostname.replace('wildcard.', '*.');
                return host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith('.' + host.slice(2)) : url.hostname === host;
            });
    } catch { return false; }
}
function nativeDocumentUrl(raw, query, hash) {
    try {
        const url = new URL(raw);
        return url.origin === new URL(chrome.runtime.getURL('offscreen.html')).origin && url.pathname === '/offscreen.html'
            && url.hash === '#' + hash && new RegExp('^\\?' + query + '=[a-f0-9-]{36}$').test(url.search);
    } catch { return false; }
}
const nativePanelWindows = new Map();
async function nativePanelIdentity(sender, windowId) {
    if (!Number.isInteger(windowId) || windowId < 0 || sender?.id !== chrome.runtime.id || sender.tab || sender.frameId !== undefined && sender.frameId !== 0
        || !nativeDocumentUrl(sender.url, 'panel', 'sidebar')) return false;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [sender.url] });
    const context = contexts.find(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === sender.url
        && (!sender.documentId || context.documentId === sender.documentId));
    if (!context) { nativePanelWindows.delete(sender.url); return false; }
    // Chrome reports windowId=-1 for a global SIDE_PANEL (observed in Chromium).
    // Only our verified native UI can establish this first binding; it obtains
    // its window via windows.getCurrent(). Never let a document retarget later.
    if (context.windowId !== -1 && context.windowId !== windowId) return false;
    if (!nativePanelWindows.has(sender.url)) nativePanelWindows.set(sender.url, windowId);
    return nativePanelWindows.get(sender.url) === windowId;
}
async function nativeLastOrigin() {
    await privateStorageReady;
    await nativeSelectionChain;
    const saved = (await chrome.storage.local.get(NATIVE_LAST_ORIGIN_KEY))[NATIVE_LAST_ORIGIN_KEY];
    return nativeSupportedOrigin(saved) ? saved : 'https://online.moysklad.ru';
}
function nativeRememberOrigin(origin) {
    const work = nativeSelectionChain.then(async () => {
        if (!nativeSupportedOrigin(origin)) throw Error('Invalid origin');
        await privateStorageReady;
        if ((await chrome.storage.local.get(NATIVE_LAST_ORIGIN_KEY))[NATIVE_LAST_ORIGIN_KEY] === origin) return;
        await chrome.storage.local.set({ [NATIVE_LAST_ORIGIN_KEY]: origin });
        if ((await chrome.storage.local.get(NATIVE_LAST_ORIGIN_KEY))[NATIVE_LAST_ORIGIN_KEY] !== origin) throw Error('Selection not durable');
    });
    nativeSelectionChain = work.catch(() => {});
    return work;
}
async function nativeRuntimeTicket(sender, windowId, origin) {
    if (!nativeSupportedOrigin(origin) || !await nativePanelIdentity(sender, windowId)) throw Error('Invalid native identity');
    for (const [ticket, binding] of nativeRuntimeTickets) if (binding.expires < Date.now() || binding.parent.url === sender.url && binding.origin === origin) nativeRuntimeTickets.delete(ticket);
    const ticket = crypto.randomUUID();
    nativeRuntimeTickets.set(ticket, { parent: sender, windowId, origin, expires: Date.now() + 15000 });
    return ticket;
}
function trustedNativeRuntimeSender(sender) { return nativeRuntimeIdentities.has(sender); }
function runtimeSenderOrigin(sender) {
    const native = nativeRuntimeIdentities.get(sender);
    if (native) return native.origin;
    if (typeof trustedContentSender === 'function' && trustedContentSender(sender)) return new URL(sender.url).origin;
    throw Error('Unbound runtime identity');
}
// Track actual focused-site use, not periodic snapshots from a background window.
let nativeFocusGeneration = 0;
async function nativeTrackActiveWindow(windowId) {
    const generation = ++nativeFocusGeneration;
    try {
        const window = await chrome.windows.get(windowId);
        if (!window.focused) return;
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (generation === nativeFocusGeneration && supportedActionTab(tab)) await nativeRememberOrigin(new URL(tab.url).origin);
    } catch { /* Closed/unavailable window must not change the saved selection. */ }
}
chrome.tabs?.onActivated?.addListener(info => { void nativeTrackActiveWindow(info.windowId); });
chrome.tabs?.onUpdated?.addListener((id, change, tab) => { if (tab.active && change.url) void nativeTrackActiveWindow(tab.windowId); });
chrome.windows?.onFocusChanged?.addListener(windowId => { if (windowId >= 0) void nativeTrackActiveWindow(windowId); else nativeFocusGeneration++; });
if (chrome.windows?.getLastFocused) chrome.windows.getLastFocused().then(window => nativeTrackActiveWindow(window.id), () => {});
function nativeDraftMessage(message, sender) {
    const session = nativeRuntimeIdentities.get(sender);
    if (!session || session.closed) return Promise.reject(Error('Unbound runtime'));
    const key = 'memchatNativeDraft_v1:' + session.windowId + ':' + session.origin;
    const work = nativeDraftChain.then(async () => {
        if (message.type === 'memchat:native-draft-write') {
            if (typeof message.value !== 'string' || message.value.length > 1024 * 1024) throw Error('Invalid draft');
            await chrome.storage.session.set({ [key]: message.value });
            if ((await chrome.storage.session.get(key))[key] !== message.value) throw Error('Draft not durable');
        }
        const value = (await chrome.storage.session.get(key))[key];
        return { ok: true, value: typeof value === 'string' ? value : '' };
    });
    nativeDraftChain = work.catch(() => {});
    return work;
}
function nativeRuntimeSessionKey(parent, origin) { return parent.url + ':' + origin; }
function nativeRuntimeRequest(session, message) {
    if (session.closed) return Promise.reject(Error('Runtime disconnected'));
    const id = ++session.sequence;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { session.pending.delete(id); reject(Error('Runtime timed out')); }, 5000);
        session.pending.set(id, { resolve, reject, timer });
        try { session.port.postMessage({ call: id, message }); }
        catch { clearTimeout(timer); session.pending.delete(id); reject(Error('Runtime disconnected')); }
    });
}
function nativeRuntimeNotify(sender, message) {
    const session = nativeRuntimeIdentities.get(sender);
    if (!session || session.closed) throw Error('Runtime disconnected');
    session.port.postMessage({ message });
}
chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'memchat-native-runtime') return;
    const sender = port.sender;
    if (sender?.id !== chrome.runtime.id || sender.tab || sender.frameId !== undefined && sender.frameId !== 0
        || !nativeDocumentUrl(sender.url, 'runtime', 'runtime')) { port.disconnect(); return; }
    let session, binding = false, disconnected = false;
    const close = () => {
        disconnected = true;
        if (!session || session.closed) return;
        session.closed = true; nativeRuntimeIdentities.delete(sender);
        if (nativeRuntimeSessions.get(session.key) === session) nativeRuntimeSessions.delete(session.key);
        privateStorageSubscribers.delete('native:' + sender.url);
        for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Runtime disconnected')); }
        session.pending.clear();
        for (const [key, request] of pendingRequests) if (key.startsWith('native:' + sender.url + ':')) { request.event = 'abort'; request.controller.abort(); }
    };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(async packet => {
        try {
            if (!session) {
                if (binding) throw Error('Already binding');
                binding = true;
                const capability = nativeRuntimeTickets.get(packet?.ticket);
                nativeRuntimeTickets.delete(packet?.ticket);
                if (!capability || capability.expires < Date.now() || !await nativePanelIdentity(capability.parent, capability.windowId) || disconnected) throw Error('Invalid native capability');
                const key = nativeRuntimeSessionKey(capability.parent, capability.origin);
                if (nativeRuntimeSessions.has(key)) throw Error('Runtime already bound');
                session = { ...capability, key, sender, port, pending: new Map(), sequence: 0, closed: false };
                nativeRuntimeIdentities.set(sender, session); nativeRuntimeSessions.set(key, session);
                port.postMessage({ ready: true }); return;
            }
            if (Number.isSafeInteger(packet?.answer)) {
                const pending = session.pending.get(packet.answer);
                if (pending) { session.pending.delete(packet.answer); clearTimeout(pending.timer); pending.resolve(packet.reply); }
                return;
            }
            if (!Number.isSafeInteger(packet?.id) || packet.id < 1 || !packet.message || session.closed) throw Error('Invalid native packet');
            // Check the parent is still a native document in the bound window.
            if (!await nativePanelIdentity(session.parent, session.windowId) || session.closed) throw Error('Native parent closed');
            let answered = false;
            const handled = extensionHandleMessage(packet.message, sender, reply => {
                answered = true;
                if (!session.closed) port.postMessage({ id: packet.id, reply });
            });
            if (!handled && !answered) port.postMessage({ id: packet.id, reply: { ok: false, error: 'Недопустимый запрос расширения' } });
        } catch { close(); try { port.disconnect(); } catch { /* Already gone. */ } }
    });
});
/* module: extension/history-worker.js */
// Exact-panel private port: never broadcast history and never persist it.
const sidebarHistoryOwners = new Map();
const SIDEBAR_CHAT_MODES = new Set(['checkHatiko', 'checkHatikoBonuses', 'calculator',
    'calculator_reverse', 'calculator_discount', 'calculator_simple']);
function sidebarHistoryTarget(sender) {
    if (trustedNativeRuntimeSender(sender)) return 'native:' + sender.url;
    if (trustedContentSender(sender)) return 'tab:' + sender.tab.id;
    return null;
}
function sidebarHistoryBind(parent, target, documentToken) {
    const owner = sidebarHistoryOwners.get(parent.url);
    if (!owner || !target || typeof documentToken !== 'string') return;
    owner.targets.set(target, documentToken);
}
chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'memchat-sidebar-history') return;
    const sender = port.sender;
    let owner, disconnected = false, binding = false;
    const close = () => {
        disconnected = true;
        if (!owner) return;
        if (sidebarHistoryOwners.get(sender.url) === owner) sidebarHistoryOwners.delete(sender.url);
        for (const pending of owner.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, closed: true }); }
        owner.pending.clear(); owner.targets.clear();
    };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(async message => {
        if (disconnected) return;
        try {
            if (!owner) {
                if (binding || message?.type !== 'bind') throw Error('Invalid history binding');
                binding = true;
                if (!await nativePanelIdentity(sender, message.windowId) || disconnected) throw Error('Invalid panel');
                // A replacement port may not hijack an existing conversation.
                if (sidebarHistoryOwners.has(sender.url)) throw Error('Already bound');
                owner = { id: crypto.randomUUID(), sender, windowId: message.windowId, port, targets: new Map(), pending: new Map() };
                sidebarHistoryOwners.set(sender.url, owner);
                port.postMessage({ ready: true, owner: owner.id }); return;
            }
            if (message?.type !== 'ack' || typeof message.id !== 'string') return;
            const pending = owner.pending.get(message.id);
            if (pending) { owner.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve({ ok: true }); }
        } catch { close(); try { port.disconnect(); } catch { /* already closed */ } }
    });
});
function sidebarHistoryMessage(message, sender, reply) {
    if (message?.type !== 'memchat:chat-event') return false;
    const run = async () => {
        const target = sidebarHistoryTarget(sender);
        const owner = [...sidebarHistoryOwners.values()].find(value => value.id === message.owner);
        if (!owner) return { ok: false, closed: true };
        if (!target || owner.targets.get(target) !== message.documentToken || !await nativePanelIdentity(owner.sender, owner.windowId)) return { ok: false };
        if (!SIDEBAR_CHAT_MODES.has(message.action) || !Number.isSafeInteger(message.epoch) || message.epoch < 0
            || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)
            || !['append', 'clear'].includes(message.operation)) return { ok: false };
        if (message.operation === 'append') {
            const entry = message.entry;
            if (!entry || entry.action !== message.action || !['user', 'bot', 'system'].includes(entry.sender)
                || !['message', 'emoji', 'timestamp', 'query'].every(key => typeof entry[key] === 'string')
                || JSON.stringify(entry).length > 1024 * 1024) return { ok: false };
        }
        if (owner.pending.has(message.id) || owner.pending.size >= 128) return { ok: false };
        return new Promise(resolve => {
            const timer = setTimeout(() => { owner.pending.delete(message.id); resolve({ ok: false }); }, 5000);
            owner.pending.set(message.id, { resolve, timer });
            try { owner.port.postMessage({ event: { id: message.id, operation: message.operation,
                epoch: message.epoch, action: message.action, entry: message.entry } }); }
            catch { clearTimeout(timer); owner.pending.delete(message.id); resolve({ ok: false, closed: true }); }
        });
    };
    run().then(reply, () => reply({ ok: false })); return true;
}
/* module: extension/sidebar-worker.js */
// Private native-view channel. Never broadcast view data: replies go only to the
// exact requesting native panel. Site/account state stays in its content world.
const SIDEBAR_FEATURES = Object.freeze(['checkHatiko', 'checkHatikoBonuses', 'today', 'tomorrow',
    'calculator', 'calculator_reverse', 'calculator_discount', 'calculator_simple', 'hacker', 'settings']);
async function sidebarDispatch(message) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: message.windowId });
    if (!supportedActionTab(tab)) return { ok: false, reason: 'unsupported' };
    if (message.type === 'memchat:sidebar-command' && tab.id !== message.tabId) return { ok: false, reason: 'changed' };
    const command = message.type === 'memchat:sidebar-status'
        ? { type: 'memchat:feature-status' } : { type: 'memchat:open-feature', feature: message.feature };
    let reply;
    try { reply = await chrome.tabs.sendMessage(tab.id, command, { frameId: 0 }); }
    catch { return { ok: false, reason: 'missing' }; }
    if (!reply?.ok) return { ok: false, reason: ['storage', 'conflict'].includes(reply?.reason) ? reply.reason : 'failed' };
    // Never forward an arbitrary content reply, tab title, URL path/query or persisted data.
    return { ok: true, tabId: tab.id, host: new URL(tab.url).hostname };
}
// chrome.tabs.sendMessage has no timeout of its own: a frozen background tab
// (Chrome Freezing) or a stuck content handler would hold the panel until its
// own 8 s deadline with a vague timeout. Answer the panel first instead.
let SIDEBAR_VIEW_DEADLINE_MS = 4000;
function sidebarSendToTab(tabId, message) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), SIDEBAR_VIEW_DEADLINE_MS);
        let sent;
        try { sent = chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
        catch { clearTimeout(timer); resolve({ ok: false, reason: 'missing' }); return; }
        // There is no AbortController for sendMessage. The losing promise still
        // settles later, so both a late reply and a late rejection are absorbed.
        Promise.resolve(sent).then(reply => resolve(reply), () => resolve({ ok: false, reason: 'missing' }))
            .finally(() => clearTimeout(timer));
    });
}
// A panel's target is captured once and then read, never recomputed from the
// live tab URL: {tabId, windowId, origin, supported}. The origin (and with it
// the private bucket) therefore stays put while the bound tab navigates, loses
// focus or is restored. Only an explicit (re)bind (no tabId) or a tab/window
// mismatch rewrites it; liveness is checked separately.
// MV3 kills the worker after idle time, so the Map alone would restore from the
// global last-origin guess on wake. A copy per panel document lives in
// chrome.storage.session (browser lifetime, never disk) and is read back first.
const SIDEBAR_BINDING_KEY = 'memchatSidebarBinding_v1';
const SIDEBAR_BINDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const sidebarBindings = new Map();
let sidebarBindingRecords = null;
let sidebarBindingChain = Promise.resolve();
async function sidebarBindingLoad() {
    if (sidebarBindingRecords) return sidebarBindingRecords;
    try {
        const saved = (await chrome.storage.session.get(SIDEBAR_BINDING_KEY))[SIDEBAR_BINDING_KEY];
        sidebarBindingRecords = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
        memchatDebugRecord({ level: 'error', scope: 'sidebar', event: 'binding-storage', detail: { reason: 'read' } }, 'worker');
        sidebarBindingRecords = {};
    }
    return sidebarBindingRecords;
}
function sidebarBindingValid(binding) {
    return !!binding && Number.isInteger(binding.tabId) && binding.tabId >= 0
        && Number.isInteger(binding.windowId) && binding.windowId >= 0
        && typeof binding.origin === 'string' && typeof binding.supported === 'boolean';
}
// One owner, one assignment: only an explicit rebind or a post-sleep rebuild
// writes. Rewriting by panel URL bounds the record set; stale entries are
// dropped here instead of by a separate collector.
function sidebarBindingSave(panelUrl, binding) {
    const work = sidebarBindingChain.then(async () => {
        const records = await sidebarBindingLoad();
        const cutoff = Date.now() - SIDEBAR_BINDING_MAX_AGE_MS;
        const next = {};
        for (const [key, value] of Object.entries(records)) {
            if (key !== panelUrl && sidebarBindingValid(value) && typeof value.at === 'number' && value.at >= cutoff) next[key] = value;
        }
        next[panelUrl] = { tabId: binding.tabId, windowId: binding.windowId, origin: binding.origin,
            supported: binding.supported, at: Date.now() };
        await chrome.storage.session.set({ [SIDEBAR_BINDING_KEY]: next });
        sidebarBindingRecords = next;
    });
    sidebarBindingChain = work.catch(() => {});
    // A failed write falls back to the in-memory binding for this worker's life.
    return work.catch(() => {
        memchatDebugRecord({ level: 'error', scope: 'sidebar', event: 'binding-storage', detail: { reason: 'write' } }, 'worker');
    });
}
function sidebarBindingLog(binding, source) {
    memchatDebugRecord({ level: 'info', scope: 'sidebar', event: 'binding-created', detail: {
        tabId: binding.tabId, origin: binding.origin, supported: binding.supported, source
    } }, 'worker');
}
function sidebarBindingMismatch(expected, actual) {
    memchatDebugRecord({ level: 'warn', scope: 'sidebar', event: 'binding-mismatch', detail: {
        expected: { tabId: expected.tabId, origin: expected.origin },
        actual: { tabId: actual.tabId, windowId: actual.windowId }
    } }, 'worker');
}
function sidebarDebugHost(origin) {
    try { return typeof origin === 'string' ? new URL(origin).hostname : null; }
    catch { return null; }
}
// A failed view is the signal a panel-only report usually lacks: keep the exact
// reason and which captured binding produced it, never page content.
function sidebarDebugFailure(message, binding, reason) {
    memchatDebugRecord({ level: 'error', scope: 'sidebar', event: 'view-failed', detail: {
        reason, tabId: Number.isInteger(binding?.tabId) ? binding.tabId : (Number.isInteger(message.tabId) ? message.tabId : null),
        supported: binding?.supported === true, host: sidebarDebugHost(binding?.origin)
    } }, 'worker');
}
async function sidebarBindingFor(message, sender) {
    const current = sidebarBindings.get(sender.url);
    if (message.tabId === undefined) {
        const [active] = await chrome.tabs.query({ active: true, windowId: message.windowId });
        if (!active) return { reason: 'changed' };
        const supported = supportedActionTab(active);
        const origin = supported ? new URL(active.url).origin : await nativeLastOrigin();
        const binding = { tabId: active.id, windowId: message.windowId, origin, supported };
        sidebarBindings.set(sender.url, binding);
        sidebarBindingLog(binding, 'explicit');
        await sidebarBindingSave(sender.url, binding);
        return { binding };
    }
    if (current) {
        // The binding is immutable for its life; a poll naming another tab is a
        // stale or foreign request, not a rebind.
        if (current.tabId !== message.tabId || current.windowId !== message.windowId) {
            sidebarBindingMismatch(current, message);
            return { reason: 'changed' };
        }
        return { binding: current };
    }
    // The worker slept or restarted. Read the panel's own captured record from
    // session storage first: that copy is the fix for a silently moving private
    // bucket. Only a panel without any record is rebuilt from live tab state.
    const saved = (await sidebarBindingLoad())[sender.url];
    if (sidebarBindingValid(saved) && saved.windowId === message.windowId) {
        if (saved.tabId !== message.tabId) {
            sidebarBindingMismatch(saved, message);
            return { reason: 'changed' };
        }
        const binding = { tabId: saved.tabId, windowId: saved.windowId, origin: saved.origin, supported: saved.supported };
        sidebarBindings.set(sender.url, binding);
        sidebarBindingLog(binding, 'session');
        await sidebarBindingSave(sender.url, binding);
        return { binding };
    }
    let tab;
    try { tab = await chrome.tabs.get(message.tabId); } catch {
        sidebarDebugFailure(message, null, 'closed');
        return { reason: 'closed' };
    }
    if (tab.windowId !== message.windowId) {
        sidebarDebugFailure(message, { tabId: tab.id, windowId: tab.windowId, origin: null, supported: false }, 'changed');
        return { reason: 'changed' };
    }
    const supported = supportedActionTab(tab);
    const origin = supported ? new URL(tab.url).origin : await nativeLastOrigin();
    const binding = { tabId: tab.id, windowId: message.windowId, origin, supported };
    sidebarBindings.set(sender.url, binding);
    // A recovered binding was rebuilt after worker suspension without any saved
    // record; unlike an explicit selection it re-reads current tab state, which
    // is the risky case and should stay rare.
    sidebarBindingLog(binding, 'recovered');
    await sidebarBindingSave(sender.url, binding);
    return { binding };
}
// Availability only: the tab exists, belongs to the panel's window and is not
// discarded/unloaded. Whether the page is a supported site is captured policy in
// the binding, not a liveness test.
async function sidebarBoundTab(message, binding) {
    let tab;
    try { tab = await chrome.tabs.get(binding.tabId); } catch { return { reason: 'closed' }; }
    if (tab.windowId !== message.windowId) return { reason: 'changed' };
    if (tab.status === 'unloaded' || tab.discarded === true) return { reason: 'missing' };
    return { tab };
}
async function sidebarViewDispatch(message, sender) {
    const resolved = await sidebarBindingFor(message, sender);
    if (!resolved.binding) {
        sidebarDebugFailure(message, null, resolved.reason || 'changed');
        return { ok: false, reason: resolved.reason || 'changed' };
    }
    const binding = resolved.binding;
    const bound = await sidebarBoundTab(message, binding);
    if (!bound.tab) {
        sidebarDebugFailure(message, binding, bound.reason);
        return { ok: false, reason: bound.reason };
    }
    const tab = bound.tab;
    const origin = binding.origin;
    // A captured supported binding whose page has since left the supported origin
    // lost its content script. Never silently move to the fallback runtime/bucket:
    // report the transient missing state so the panel keeps its view and goes inert
    // until the user explicitly rebinds.
    if (binding.supported && (!supportedActionTab(tab) || new URL(tab.url).origin !== origin)) {
        sidebarDebugFailure(message, binding, 'missing');
        return { ok: false, reason: 'missing' };
    }
    // The history channel is a private per-panel sink, never a precondition for
    // rendering: a panel that lost it still shows the view and reports its own
    // history error, exactly as a missing credentials path must stay fail-closed
    // for storage alone.
    const history = sidebarHistoryOwners.get(sender.url);
    const request = message.type === 'memchat:sidebar-view'
        ? { type: 'memchat:view-snapshot' }
        : { type: 'memchat:view-event', documentToken: message.documentToken,
            key: message.key, event: message.event, value: message.value,
            checked: message.checked, selected: message.selected,
            ...(message.event === 'enter' ? { eventId: message.eventId } : {}) };
    // Forward the panel's ETag only on snapshot polls; events always need the
    // full view. Unknown fields stay absent so old content worlds see an
    // ordinary request.
    if (message.type === 'memchat:sidebar-view' && typeof message.knownHash === 'string') request.knownHash = message.knownHash;
    if (message.type === 'memchat:sidebar-view' && typeof message.knownDocumentToken === 'string') request.knownDocumentToken = message.knownDocumentToken;
    // The panel's chat memory is addressed by owner id plus the exact document
    // token that will answer it; a rewritten epoch map can neither move an
    // answer into another mode nor revive a cleared history.
    if (history) {
        request.historyOwner = history.id;
        request.chatMode = SIDEBAR_FEATURES.includes(message.chatMode) ? message.chatMode : null;
        request.chatEpochs = Object.fromEntries([...SIDEBAR_CHAT_MODES].map(mode =>
            [mode, Number.isSafeInteger(message.chatEpochs?.[mode]) && message.chatEpochs[mode] >= 0 ? message.chatEpochs[mode] : 0]));
    }
    let historyTarget;
    let view;
    try {
        if (binding.supported) { historyTarget = 'tab:' + tab.id; view = await sidebarSendToTab(tab.id, request); }
        else {
            const session = nativeRuntimeSessions.get(nativeRuntimeSessionKey(sender, origin));
            if (!session) {
                if (message.type !== 'memchat:sidebar-view') return { ok: false, reason: 'changed' };
                return { ok: true, tabId: tab.id, host: new URL(origin).hostname,
                    runtime: { origin, ticket: await nativeRuntimeTicket(sender, message.windowId, origin) } };
            }
            historyTarget = 'native:' + session.sender.url;
            view = await nativeRuntimeRequest(session, request);
        }
    } catch {
        sidebarDebugFailure(message, binding, 'missing');
        return { ok: false, reason: 'missing' };
    }
    // The bound tab itself must still exist in the panel's window; never re-target
    // to whatever happens to be active. The content documentToken still pins events.
    let alive;
    try { alive = await chrome.tabs.get(tab.id); } catch {
        sidebarDebugFailure(message, binding, 'closed');
        return { ok: false, reason: 'closed' };
    }
    if (alive.windowId !== message.windowId || !await nativePanelIdentity(sender, message.windowId)) {
        sidebarDebugFailure(message, binding, 'changed');
        return { ok: false, reason: 'changed' };
    }
    if (!view?.ok) {
        const reason = ['storage', 'conflict', 'changed', 'timeout', 'too-large'].includes(view?.reason) ? view.reason : 'failed';
        sidebarDebugFailure(message, binding, reason);
        return { ok: false, reason };
    }
    // Only a first binding or an event from the visible bound tab records the
    // selection; a background poll of a non-active tab must not overwrite it.
    const activeBound = message.tabId === undefined || (message.type === 'memchat:sidebar-event'
        && (await chrome.tabs.query({ active: true, windowId: message.windowId }))[0]?.id === tab.id);
    if (binding.supported && activeBound && (await chrome.windows.get(message.windowId)).focused) await nativeRememberOrigin(origin);
    // Only a view that really answered may become the target of this panel's
    // chat sink; a refused request must not bind a document that never rendered.
    if (history) sidebarHistoryBind(sender, historyTarget, view.documentToken);
    return { ok: true, tabId: tab.id, host: new URL(origin).hostname, native: !binding.supported, view };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!['memchat:sidebar-status', 'memchat:sidebar-command', 'memchat:sidebar-view', 'memchat:sidebar-event'].includes(message?.type)) return false;
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.frameId !== undefined && sender.frameId !== 0)
        || !nativeDocumentUrl(sender.url, 'panel', 'sidebar')
        || !Number.isInteger(message.windowId) || message.windowId < 0
        || (message.type === 'memchat:sidebar-command' && (!Number.isInteger(message.tabId) || message.tabId < 0
            || !SIDEBAR_FEATURES.includes(message.feature)))
        || (message.type === 'memchat:sidebar-view' && message.tabId !== undefined && (!Number.isInteger(message.tabId) || message.tabId < 0))
        || (message.type === 'memchat:sidebar-view' && ((message.knownHash !== undefined
            && (typeof message.knownHash !== 'string' || message.knownHash.length > 64))
            || (message.knownDocumentToken !== undefined
            && (typeof message.knownDocumentToken !== 'string' || message.knownDocumentToken.length > 100))))
        || (message.type === 'memchat:sidebar-event' && (!Number.isInteger(message.tabId) || message.tabId < 0
            || typeof message.documentToken !== 'string' || message.documentToken.length > 100
            || typeof message.key !== 'string' || !/^\d{1,8}$/.test(message.key)
            || !['click', 'input', 'change', 'enter'].includes(message.event)
            || (message.event === 'enter' && (typeof message.eventId !== 'string'
                || !/^[a-f0-9-]{1,64}$/.test(message.eventId)))))) {
        sendResponse({ ok: false, reason: 'invalid' }); return false;
    }
    nativePanelIdentity(sender, message.windowId).then(valid => valid
        ? (['memchat:sidebar-view', 'memchat:sidebar-event'].includes(message.type)
            ? sidebarViewDispatch(message, sender) : sidebarDispatch(message))
        : { ok: false, reason: 'invalid' }).then(sendResponse, () => sendResponse({ ok: false, reason: 'failed' }));
    return true;
});
/* module: extension/worker.js */
'use strict';

// The panel is a verified SIDE_PANEL document; it has no tab and no subframe.
function debugPanelSender(sender) {
    return sender?.id === chrome.runtime.id && !sender.tab
        && (sender.frameId === undefined || sender.frameId === 0)
        && nativeDocumentUrl(sender.url, 'panel', 'sidebar');
}
function debugWorldFor(sender, panel) {
    if (panel) return 'panel';
    if (trustedContentSender(sender)) return 'content';
    if (trustedNativeRuntimeSender(sender)) return 'runtime';
    return 'worker';
}
async function debugMessage(message, sender, panel) {
    if (message.type === 'memchat:debug-flag') {
        if (typeof message.enabled !== 'boolean') return { ok: false, error: 'Недопустимый журнал расширения' };
        // memchatDebugSetEnabled returns whether the write verified, not the value.
        // Read the persisted flag back so turning the log OFF is also confirmed.
        const verified = await memchatDebugSetEnabled(message.enabled);
        const enabled = await memchatDebugEnabled();
        return verified && enabled === message.enabled
            ? { ok: true, enabled }
            : { ok: false, error: 'Флаг журнала не подтверждён' };
    }
    if (message.type === 'memchat:debug-read') {
        if (message.limit !== undefined && (!Number.isInteger(message.limit) || message.limit < 1
            || message.limit > MEMCHAT_DEBUG_LOG_LIMIT)) return { ok: false, error: 'Недопустимый журнал расширения' };
        return memchatDebugRead({ limit: message.limit });
    }
    if (message.type === 'memchat:debug-clear') return memchatDebugClear();
    // The world is derived from the authenticated sender, never trusted from the
    // payload: a content world cannot claim to be the panel or the worker.
    if (!MEMCHAT_DEBUG_LEVELS.includes(message.level)
        || typeof message.scope !== 'string' || !/^[a-z0-9:-]{1,64}$/.test(message.scope)
        || typeof message.event !== 'string' || message.event.length < 1 || message.event.length > 200
        || (message.world !== undefined && !MEMCHAT_DEBUG_WORLDS.includes(message.world))) {
        return { ok: false, error: 'Недопустимый журнал расширения' };
    }
    await memchatDebugRecord({ level: message.level, scope: message.scope, event: message.event, detail: message.detail },
        debugWorldFor(sender, panel));
    return { ok: true };
}

function extensionHandleMessage(message, sender, sendResponse) {
    if (message?.type === 'memchat:chat-event') return sidebarHistoryMessage(message, sender, sendResponse);
    if (['memchat:debug-log', 'memchat:debug-read', 'memchat:debug-clear', 'memchat:debug-flag'].includes(message?.type)) {
        const panel = debugPanelSender(sender);
        // The verbose-log switch lives in the settings window, which is rendered by
        // our own content script (or the native runtime), not by the panel document.
        // A page cannot forge any of these senders: sender.id must be our extension.
        const trusted = panel || trustedContentSender(sender) || trustedNativeRuntimeSender(sender);
        if (!trusted) {
            sendResponse({ ok: false, error: 'Запрос расширения отклонён' });
            return false;
        }
        debugMessage(message, sender, panel).then(sendResponse,
            () => sendResponse({ ok: false, error: 'Журнал расширения недоступен' }));
        return true;
    }
    if (['memchat:native-draft-read', 'memchat:native-draft-write'].includes(message?.type)) {
        if (!trustedNativeRuntimeSender(sender)) { sendResponse({ ok: false, error: 'Запрос расширения отклонён' }); return false; }
        nativeDraftMessage(message, sender).then(sendResponse, () => sendResponse({ ok: false, error: 'Черновик не подтверждён. Не закрывайте панель.' }));
        return true;
    }
    if (message?.type === 'memchat:orders-test-sound') {
        if (!(trustedContentSender(sender) || trustedNativeRuntimeSender(sender))) { sendResponse({ ok: false, error: 'Запрос расширения отклонён' }); return false; }
        orderPlayAudio().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, error: 'Звук расширения недоступен' }));
        return true;
    }
    if (['memchat:storage-init', 'memchat:storage-write', 'memchat:storage-restore', 'memchat:storage-prune'].includes(message?.type)) {
        if (!(trustedContentSender(sender) || trustedNativeRuntimeSender(sender))) { sendResponse({ ok: false, error: 'Запрос хранилища отклонён' }); return false; }
        privateStorageMessage(message, sender).then(sendResponse,
            () => sendResponse({ ok: false, error: 'Данные не подтверждены хранилищем. Не закрывайте и не перезагружайте вкладку.' }));
        return true;
    }
    if (['memchat:orders-configure', 'memchat:orders-poll', 'memchat:orders-stop'].includes(message?.type)) {
        if (!(trustedContentSender(sender) || trustedNativeRuntimeSender(sender))) { sendResponse({ ok: false, error: 'Запрос расширения отклонён' }); return false; }
        const work = async () => {
            await orderReady;
            if (trustedNativeRuntimeSender(sender) && message.type !== 'memchat:orders-stop'
                && !await privateStorageCredentialCurrent(sender, 'Bearer ' + message.token)) return { ok: false, error: 'Учётные данные изменены. Подтвердите ключ.' };
            if (message.type === 'memchat:orders-configure') {
                const result = await orderMutate(() => configureOrders(message, sender));
                const native = nativeRuntimeIdentities.get(sender);
                if (native && result.ok) { native.orderToken = message.token; native.orderRevision = result.revision; }
                return result;
            }
            if (message.type === 'memchat:orders-stop') return orderMutate(async () => {
                if (!orderConfig || message.token !== orderConfig.token) return { ok: false, error: 'Bearer не совпадает с фоновым опросом' };
                orderController?.abort();
                orderConfig.settings.enabled = false;
                await chrome.storage.session.set({ [ORDER_SESSION_KEY]: { config: orderConfig, revision: ++orderRevision, subscribers: [...orderSubscribers] } });
                await orderSetAlarm();
                return orderPublicConfig();
            });
            await orderConfigChain;
            if (!orderConfig || message.token !== orderConfig.token) return { ok: false, error: 'Bearer не совпадает с фоновым опросом' };
            return pollOrders();
        };
        work().then(sendResponse, () => sendResponse({ ok: false, error: 'Не удалось настроить фоновый опрос' }));
        return true;
    }
    if (message?.type === 'memchat:panel-csrf') {
        if (!(trustedContentSender(sender) || trustedNativeRuntimeSender(sender)) || (message.force !== undefined && typeof message.force !== 'boolean')) {
            sendResponse({ ok: false, error: 'Запрос расширения отклонён' });
            return false;
        }
        getPanelSession(message.force === true).then(sendResponse,
            () => sendResponse({ ok: false, error: 'Panel: фоновая сессия недоступна.' }));
        return true;
    }
    if (!['memchat:http', 'memchat:abort'].includes(message?.type)) return false;
    if (!(trustedContentSender(sender) || trustedNativeRuntimeSender(sender)) || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) {
        sendResponse({ event: 'error', error: 'Запрос расширения отклонён' });
        return false;
    }
    if (message.type === 'memchat:abort') {
        const entry = pendingRequests.get(requestKey(sender, message.id));
        if (entry) { entry.event = 'abort'; entry.controller.abort(); }
        sendResponse({ ok: true });
        return false;
    }
    performRequest(message, sender).then(result => {
        if (result.event === 'load' && [401, 403, 419].includes(result.response?.status)
            && new URL(message.request.url).origin === 'https://panel.hatiko.ru') {
            const sentToken = new Headers(message.request.headers || {}).get('x-csrf-token');
            if (sentToken && sentToken === panelSession?.token) {
                panelSession = null;
                result.panelAuthLost = true;
                memchatDebugRecord({ level: 'error', scope: 'panel', event: 'auth-lost',
                    detail: { status: result.response?.status } }, 'worker');
            }
        }
        sendResponse(result);
    }, () => sendResponse({ event: 'error', error: 'Недопустимый запрос расширения' }));
    return true;
}
chrome.runtime.onMessage.addListener(extensionHandleMessage);

// Register toolbar/context-menu listeners synchronously on every worker wake.
importScripts('controls.js');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL2RlYnVnLWxvZy5qcyIsImV4dGVuc2lvbi93b3JrZXIvbmV0d29yay5qcyIsImV4dGVuc2lvbi93b3JrZXIvcGFuZWwtc2Vzc2lvbi5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXItYWxlcnRzLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci9vcmRlcnMuanMiLCJleHRlbnNpb24vbmF0aXZlLXJ1bnRpbWUtd29ya2VyLmpzIiwiZXh0ZW5zaW9uL2hpc3Rvcnktd29ya2VyLmpzIiwiZXh0ZW5zaW9uL3NpZGViYXItd29ya2VyLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBCdW5kbGVkIGludG8gd29ya2VyIGFuZCBpc29sYXRlZCBjb250ZW50OyBuZXZlciBleHBvc2VkIGluIHRoZSBwYWdlIHdvcmxkLlxuY29uc3QgTUVNQ0hBVF9TVE9SQUdFX0tFWVMgPSBuZXcgU2V0KFtcbiAgICAnZGVidWcnLCAnY2FsY1J1bGVzX3YyJywgJ3NjaGVkdWxlUmVwbGFjZW1lbnRzX3YxJywgJ3NjaGVkdWxlQ2FjaGVFbmFibGVkX3YxJyxcbiAgICAnc2NoZWR1bGVDYWNoZV92MV90b2RheScsICdzY2hlZHVsZUNhY2hlX3YxX3RvbW9ycm93JywgJ3NlbGVjdGVkQWN0aW9uX3YxJyxcbiAgICAnc2hvd0hhdGlrb0xpbmtzX3YxJywgJ2hhdGlrb1NlYXJjaE1vZGVfdjEnLCAncmV0cnlCZWhhdmlvcl92MScsICdoaWRkZW5GaWVsZHNfdjEnLFxuICAgICdtc1F1aWNrUGFuZWxfdjEnLCAnZmxvYXRXaW5kb3dQb3NfdjEnLCAnY2hhdEhpc3RvcnlfdjEnLCAnY2xlYXJUZXh0RGVsYXlfdjEnLFxuICAgICdjbGVhclRleHRFbmFibGVkJywgJ2hhY2tlckRlZmF1bHRDaGFubmVsX3YxJywgJ2hhY2tlclF1aWNrQnV0dG9uc192MScsXG4gICAgJ21zTWFnaWNDb25maWdfdjEnLCAnbXNGaWVsZHNTcG9pbGVyT3Blbl92MScsICdtc1JlZmVyZW5jZUNhY2hlX3YxJyxcbiAgICAnaGFja2VyTXNBcGlfdjEnLCAnaGFja2VyU3RhdGVzX3YxJywgJ2hhY2tlck9yZGVyTm90aWZpZXJfdjEnLFxuICAgICdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnNfdjEnLCAnaGFja2VyTm90aWZpZXJTZWVuX3YxJyxcbiAgICAnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrX3YxJywgJ2hhY2tlckludGVybmFsT3JkZXJXYXJlaG91c2VzX3YxJ1xuXS5tYXAoa2V5ID0+ICdtZW1jaGF0OicgKyBrZXkpLmNvbmNhdChbJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MSddKSk7XG5jb25zdCBNRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbJ21lbWNoYXQ6cGFuZWxDc3JmX3YxJywgJ2NsZWFyVGV4dEVuYWJsZWQnXSk7XG5mdW5jdGlvbiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgdmFsdWUpIHtcbiAgICBpZiAoa2V5ID09PSAnbWVtY2hhdDpjaGF0SGlzdG9yeV92MScpIHtcbiAgICAgICAgdHJ5IHsgY29uc3QgaGlzdG9yeSA9IEpTT04ucGFyc2UodmFsdWUpO1xuICAgICAgICAgICAgaWYgKGhpc3RvcnkgJiYgdHlwZW9mIGhpc3RvcnkgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KGhpc3RvcnkpKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGhpc3RvcnkuY2hlY2tIYXRpa29Cb251c2VzO1xuICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShoaXN0b3J5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIFByZXNlcnZlIG1hbGZvcm1lZCBleGlzdGluZyBkYXRhLCBub3QgYSBmYWJyaWNhdGVkIHJlcGxhY2VtZW50LiAqLyB9XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cbiIsIi8vIFByaXZhdGUgc3RvcmFnZSBpcyBvcmlnaW4tc2NvcGVkIHRvIHByZXNlcnZlIGV4aXN0aW5nIHNpdGUvYWNjb3VudCBzZXBhcmF0aW9uLlxuLy8gQ2hyb21lIG93bnMgcGVyc2lzdGVuY2U7IHBhZ2UgbG9jYWxTdG9yYWdlIGlzIHVzZWQgb25seSBmb3Igb25lLXRpbWUgbWlncmF0aW9uLlxuY29uc3QgcHJpdmF0ZVN0b3JhZ2VSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0QWNjZXNzTGV2ZWwoeyBhY2Nlc3NMZXZlbDogJ1RSVVNURURfQ09OVEVYVFMnIH0pO1xufSkoKTtcbi8vIEhhbmRsZSBpbml0aWFsaXphdGlvbiByZWplY3Rpb24gaW1tZWRpYXRlbHksIHdoaWxlIHJldGFpbmluZyBmYWlsLWNsb3NlZCBhd2FpdHMuXG5wcml2YXRlU3RvcmFnZVJlYWR5LmNhdGNoKCgpID0+IHt9KTtcbmxldCBwcml2YXRlU3RvcmFnZUNoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5jb25zdCBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzID0gbmV3IE1hcCgpO1xuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VTbmFwc2hvdChidWNrZXQpIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW2J1Y2tldC52ZXJzaW9uLCBPYmplY3Qua2V5cyhidWNrZXQuaXRlbXMpLnNvcnQoKS5tYXAoa2V5ID0+XG4gICAgICAgIFtrZXksIGJ1Y2tldC5pdGVtc1trZXldLnJldmlzaW9uLCBidWNrZXQuaXRlbXNba2V5XS52YWx1ZV0pLFxuICAgIE9iamVjdC5rZXlzKGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHwge30pLnNvcnQoKS5tYXAoa2V5ID0+IFtrZXksIGJ1Y2tldC5sZWdhY3lCYWNrdXBba2V5XV0pLFxuICAgIChidWNrZXQucmVjb3ZlcmllcyB8fCBbXSkubWFwKGVudHJ5ID0+IFtlbnRyeS5pZCwgZW50cnkua2V5LCBlbnRyeS52YWx1ZSwgZW50cnkuZG9jdW1lbnQsIGVudHJ5LnJldmlzaW9uXSksXG4gICAgYnVja2V0LnJlY292ZXJ5U2VxdWVuY2UgfHwgMCwgYnVja2V0LnJlY292ZXJ5RmVuY2VzIHx8IFtdXSk7XG59XG4vLyBQcml2YXRlIHZhcmlhbnRzIGFwcGVuZCBub3JtYWxseTsgb25seSBleHBsaWNpdCBjb25maXJtZWQgcHJ1bmUgZGVsZXRlcyBvbmUuXG4vLyBObyBhdXRvbWF0aWMgZXZpY3Rpb246IGV4aGF1c3Rpb24gZmFpbHMgY2xvc2VkLFxuLy8gYW5kIGNvbnRlbnQgbXVzdCBleHBsaWNpdGx5IHdhcm4gdGhhdCB0aGUgbmV3ZXN0IGVkaXQgaXMgTk9UIHlldCBkdXJhYmxlLlxuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCB2YWx1ZSwgcmV2aXNpb24sIGRvY3VtZW50KSB7XG4gICAgYnVja2V0LnJlY292ZXJpZXMgfHw9IFtdO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gYnVja2V0LnJlY292ZXJpZXMuZmluZChlbnRyeSA9PiBlbnRyeS5rZXkgPT09IGtleSAmJiBlbnRyeS52YWx1ZSA9PT0gdmFsdWVcbiAgICAgICAgJiYgZW50cnkuZG9jdW1lbnQgPT09IGRvY3VtZW50ICYmIGVudHJ5LnJldmlzaW9uID09PSByZXZpc2lvbik7XG4gICAgaWYgKGV4aXN0aW5nKSByZXR1cm47XG4gICAgaWYgKGJ1Y2tldC5yZWNvdmVyaWVzLmxlbmd0aCA+PSAxMjgpIHtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc3RvcmFnZScsIGV2ZW50OiAnY2FwYWNpdHknLCBkZXRhaWw6IHsga2V5IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICB0aHJvdyBFcnJvcignUmVjb3ZlcnkgY2FwYWNpdHkgZXhoYXVzdGVkJyk7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gTWF0aC5tYXgoYnVja2V0LnJlY292ZXJ5U2VxdWVuY2UgfHwgMCwgLi4uYnVja2V0LnJlY292ZXJpZXMubWFwKGVudHJ5ID0+IGVudHJ5LmlkKSkgKyAxO1xuICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIoaWQpKSB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ2NhcGFjaXR5JywgZGV0YWlsOiB7IGtleSB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1JlY292ZXJ5IElEIGV4aGF1c3RlZCcpO1xuICAgIH1cbiAgICBidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSA9IGlkO1xuICAgIGJ1Y2tldC5yZWNvdmVyaWVzLnB1c2goeyBpZCwga2V5LCB2YWx1ZSwgcmV2aXNpb24sIGRvY3VtZW50IH0pO1xuICAgIGlmIChKU09OLnN0cmluZ2lmeShidWNrZXQucmVjb3ZlcmllcykubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ2NhcGFjaXR5JywgZGV0YWlsOiB7IGtleSB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1JlY292ZXJ5IGNhcGFjaXR5IGV4aGF1c3RlZCcpO1xuICAgIH1cbn1cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGJ1Y2tldCkge1xuICAgIC8vIE5ldmVyIHNlbmQgcmVjb3ZlcnkgdmFsdWVzIChlc3BlY2lhbGx5IGNyZWRlbnRpYWxzL2hpc3RvcnkpIGludG8gYSB2aWV3LlxuICAgIHJldHVybiAoYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcCgoeyBpZCwga2V5LCB2YWx1ZSwgcmV2aXNpb24gfSkgPT4gKHsgaWQsIGtleSwgZGVsZXRlZDogdmFsdWUgPT09IG51bGwsIHJldmlzaW9uIH0pKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCkge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtzdG9yYWdlS2V5XTogYnVja2V0IH0pO1xuICAgIGNvbnN0IGNvbW1pdHRlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoc3RvcmFnZUtleSkpW3N0b3JhZ2VLZXldO1xuICAgIGlmICghY29tbWl0dGVkIHx8IHByaXZhdGVTdG9yYWdlU25hcHNob3QoY29tbWl0dGVkKSAhPT0gcHJpdmF0ZVN0b3JhZ2VTbmFwc2hvdChidWNrZXQpKSB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ3ZlcmlmaWNhdGlvbicsIGRldGFpbDoge30gfSwgJ3dvcmtlcicpO1xuICAgICAgICB0aHJvdyBFcnJvcignU3RvcmFnZSB2ZXJpZmljYXRpb24gZmFpbGVkJyk7XG4gICAgfVxuICAgIHJldHVybiBjb21taXR0ZWQ7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgYXV0aG9yaXphdGlvbikge1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbjtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKTtcbiAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XTtcbiAgICBjb25zdCBhcGkgPSBKU09OLnBhcnNlKHNhdmVkPy5pdGVtc1snbWVtY2hhdDpoYWNrZXJNc0FwaV92MSddPy52YWx1ZSB8fCAne30nKTtcbiAgICByZXR1cm4gYXBpLmJlYXJlckVuYWJsZWQgPT09IHRydWUgJiYgdHlwZW9mIGFwaS50b2tlbiA9PT0gJ3N0cmluZycgJiYgYXV0aG9yaXphdGlvbiA9PT0gJ0JlYXJlciAnICsgYXBpLnRva2VuO1xufVxuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IG9wZXJhdGlvbiA9IHByaXZhdGVTdG9yYWdlQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKTtcbiAgICAgICAgY29uc3Qgc3RvcmFnZUtleSA9ICdtZW1jaGF0UHJpdmF0ZV92MTonICsgb3JpZ2luO1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoc3RvcmFnZUtleSkpW3N0b3JhZ2VLZXldO1xuICAgICAgICBjb25zdCBidWNrZXQgPSBzYXZlZCB8fCB7IHZlcnNpb246IDEsIGl0ZW1zOiB7fSwgbGVnYWN5QmFja3VwOiB7fSB9O1xuICAgICAgICBpZiAoYnVja2V0LnZlcnNpb24gIT09IDEgfHwgIWJ1Y2tldC5pdGVtcyB8fCB0eXBlb2YgYnVja2V0Lml0ZW1zICE9PSAnb2JqZWN0JykgdGhyb3cgRXJyb3IoJ0ludmFsaWQgc2NoZW1hJyk7XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtaW5pdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGxlZ2FjeSA9IG1lc3NhZ2UubGVnYWN5O1xuICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgT2JqZWN0LmtleXMobGVnYWN5IHx8IHt9KS5sZW5ndGgpIHRocm93IEVycm9yKCdOYXRpdmUgcnVudGltZSBjYW5ub3QgbWlncmF0ZSBwYWdlIGRhdGEnKTtcbiAgICAgICAgICAgIGlmICghbGVnYWN5IHx8IHR5cGVvZiBsZWdhY3kgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkobGVnYWN5KSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbGVnYWN5IHNuYXBzaG90Jyk7XG4gICAgICAgICAgICBjb25zdCBjbGVhbnVwID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHJhd10gb2YgT2JqZWN0LmVudHJpZXMobGVnYWN5KSkge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSB0aHJvdyBFcnJvcignSW52YWxpZCB2YWx1ZScpO1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICdjbGVhclRleHRFbmFibGVkJyAmJiBbJ3RydWUnLCAnZmFsc2UnXS5pbmNsdWRlcyhyYXcpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghT2JqZWN0Lmhhc093bihidWNrZXQuaXRlbXMsICdtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBbJ3RydWUnLCAnZmFsc2UnXS5pbmNsdWRlcyhsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddKSA/IGxlZ2FjeVsnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJ10gOiByYXc7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQuaXRlbXNbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChidWNrZXQuaXRlbXNbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddLnZhbHVlICE9PSByYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHw9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cC5jbGVhclRleHRFbmFibGVkID0gcmF3O1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChNRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSB7IGNsZWFudXAucHVzaChrZXkpOyBjb250aW51ZTsgfVxuICAgICAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHJhdyk7XG4gICAgICAgICAgICAgICAgaWYgKCFzYXZlZCkgYnVja2V0Lml0ZW1zW2tleV0gPSB7IHZhbHVlLCByZXZpc2lvbjogMSB9O1xuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGJ1Y2tldC5pdGVtc1trZXldPy52YWx1ZSAhPT0gdmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQW4gb2xkZXIgdXNlcnNjcmlwdCBtYXkgcmVjcmVhdGUgb2xkIGtleXMuIFByZXNlcnZlIHRoYXQgY29weVxuICAgICAgICAgICAgICAgICAgICAvLyBwcml2YXRlbHksIGJ1dCBuZXZlciByb2xsIGJhY2sgdGhlIGNhbm9uaWNhbCBleHRlbnNpb24gc3RhdGUuXG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHw9IHt9O1xuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY2xlYW51cC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBBY2tub3dsZWRnZSBvbmx5IGFmdGVyIENocm9tZSBjb21taXRzIGFuZCBhIHJlYWQtYmFjayB2ZXJpZmllcyBpdC5cbiAgICAgICAgICAgIGNvbnN0IGNvbW1pdHRlZCA9IGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLnNldChzZW5kZXIudGFiPy5pZCA/PyAnbmF0aXZlOicgKyBzZW5kZXIudXJsLCB7IG9yaWdpbiwgZG9jdW1lbnRJZDogc2VuZGVyLmRvY3VtZW50SWQsIHNlbmRlciB9KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtczogY29tbWl0dGVkLml0ZW1zLCBjbGVhbnVwLCByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChjb21taXR0ZWQpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c3RvcmFnZS1wcnVuZScpIHtcbiAgICAgICAgICAgIC8vIEV4cGxpY2l0IGlycmV2ZXJzaWJsZSBkZWxldGlvbiBvZiBPTkUgaW1tdXRhYmxlIElELCBuZXZlciBhIGJ1bGsgY2xlYXIuXG4gICAgICAgICAgICAvLyBLZWVwIGl0cyBkb2N1bWVudCBmZW5jZSBhZnRlciBkZWxldGlvbiwgYW5kIG5ldmVyIHJlY3ljbGUgSURzIChzdGFsZSBVSS9hY2sgcmV0cmllcykuXG4gICAgICAgICAgICBjb25zdCBzZXF1ZW5jZSA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLihidWNrZXQucmVjb3ZlcmllcyB8fCBbXSkubWFwKGVudHJ5ID0+IGVudHJ5LmlkKSk7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5jb25maXJtZWQgIT09IHRydWUgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1lc3NhZ2UuaWQpIHx8IG1lc3NhZ2UuaWQgPCAxIHx8IG1lc3NhZ2UuaWQgPiBzZXF1ZW5jZSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcHJ1bmUnKTtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gYnVja2V0LnJlY292ZXJpZXM/LmZpbmQoaXRlbSA9PiBpdGVtLmlkID09PSBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlID0gc2VxdWVuY2U7XG4gICAgICAgICAgICBpZiAoZW50cnkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZG9jdW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LnJlY292ZXJ5RmVuY2VzIHx8PSBbXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFidWNrZXQucmVjb3ZlcnlGZW5jZXMuc29tZSgoW2tleSwgZG9jdW1lbnRdKSA9PiBrZXkgPT09IGVudHJ5LmtleSAmJiBkb2N1bWVudCA9PT0gZW50cnkuZG9jdW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQucmVjb3ZlcnlGZW5jZXMucHVzaChbZW50cnkua2V5LCBlbnRyeS5kb2N1bWVudF0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyaWVzID0gYnVja2V0LnJlY292ZXJpZXMuZmlsdGVyKGl0ZW0gPT4gaXRlbS5pZCAhPT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlY292ZXJpZXM6IHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGNvbW1pdHRlZCkgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnXS5pbmNsdWRlcyhtZXNzYWdlLnR5cGUpKSB7XG4gICAgICAgICAgICBjb25zdCByZXN0b3JpbmcgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtcmVzdG9yZSc7XG4gICAgICAgICAgICBjb25zdCByZWNvdmVyeSA9IHJlc3RvcmluZyAmJiBOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmlkKVxuICAgICAgICAgICAgICAgICYmIGJ1Y2tldC5yZWNvdmVyaWVzPy5maW5kKGVudHJ5ID0+IGVudHJ5LmlkID09PSBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIGlmIChyZXN0b3JpbmcgJiYgIXJlY292ZXJ5KSB0aHJvdyBFcnJvcignSW52YWxpZCByZWNvdmVyeScpO1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzdG9yaW5nID8gcmVjb3Zlcnkua2V5IDogbWVzc2FnZS5rZXksIHJldmlzaW9uID0gbWVzc2FnZS5yZXZpc2lvbjtcbiAgICAgICAgICAgIGNvbnN0IHJhdyA9IHJlc3RvcmluZyA/IHJlY292ZXJ5LnZhbHVlIDogbWVzc2FnZS52YWx1ZTtcbiAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHJldmlzaW9uKSB8fCByZXZpc2lvbiA8IDBcbiAgICAgICAgICAgICAgICB8fCByZXZpc2lvbiA+PSBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUlxuICAgICAgICAgICAgICAgIHx8IChyYXcgIT09IG51bGwgJiYgKHR5cGVvZiByYXcgIT09ICdzdHJpbmcnIHx8IHJhdy5sZW5ndGggPiA1ICogMTAyNCAqIDEwMjQpKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgd3JpdGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gYnVja2V0Lml0ZW1zW2tleV0gfHwgeyB2YWx1ZTogbnVsbCwgcmV2aXNpb246IDAgfTtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gcmF3ID09PSBudWxsID8gbnVsbCA6IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBzZW5kZXIuZG9jdW1lbnRJZCB8fCAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSA/ICduYXRpdmU6JyArIHNlbmRlci51cmwgOiAndGFiOicgKyBzZW5kZXIudGFiLmlkKTtcbiAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIGRvY3VtZW50IGZlbmNlIHdpdGggdGhlIGZpcnN0IGNvbmZsaWN0LiBBbHJlYWR5IHNlbnRcbiAgICAgICAgICAgIC8vIG9wdGltaXN0aWMgd3JpdGVzIGNhbm5vdCBhY2NpZGVudGFsbHkgb3ZlcndyaXRlIHRoZSB3aW5uZXIgbGF0ZXIsXG4gICAgICAgICAgICAvLyBpbmNsdWRpbmcgYWZ0ZXIgd29ya2VyIHN1c3BlbnNpb24uIFJlbG9hZCBjcmVhdGVzIGEgbmV3IGRvY3VtZW50LlxuICAgICAgICAgICAgY29uc3QgYmxvY2tlZCA9ICFyZXN0b3JpbmcgJiYgKGJ1Y2tldC5yZWNvdmVyaWVzPy5zb21lKGVudHJ5ID0+IGVudHJ5LmtleSA9PT0ga2V5ICYmIGVudHJ5LmRvY3VtZW50ID09PSBkb2N1bWVudClcbiAgICAgICAgICAgICAgICB8fCBidWNrZXQucmVjb3ZlcnlGZW5jZXM/LnNvbWUoKFtmZW5jZWRLZXksIGZlbmNlZERvY3VtZW50XSkgPT4gZmVuY2VkS2V5ID09PSBrZXkgJiYgZmVuY2VkRG9jdW1lbnQgPT09IGRvY3VtZW50KSk7XG4gICAgICAgICAgICAvLyBBIGNvbmN1cnJlbnQgd3JpdGVyIG1heSBoYXZlIGNvbW1pdHRlZCB0aGUgaWRlbnRpY2FsIGRlc2lyZWQgdmFsdWUuXG4gICAgICAgICAgICAvLyBPbmx5IGFjY2VwdCB0aGUgaW1tZWRpYXRlbHkgcHJlY2VkaW5nIHJldmlzaW9uIHNvIG9wdGltaXN0aWMgcXVldWVkXG4gICAgICAgICAgICAvLyB3cml0ZXMgY29udGludWUgZnJvbSB0aGUgcmV2aXNpb24gdGhlIGNvbnRlbnQgYWRhcHRlciBwcmVkaWN0ZWQuXG4gICAgICAgICAgICBpZiAoIWJsb2NrZWQgJiYgIXJlc3RvcmluZyAmJiBwcmV2aW91cy5yZXZpc2lvbiA9PT0gcmV2aXNpb24gKyAxICYmIHByZXZpb3VzLnZhbHVlID09PSB2YWx1ZSkgcmV0dXJuIHsgb2s6IHRydWUsIGl0ZW06IHByZXZpb3VzIH07XG4gICAgICAgICAgICBpZiAoYmxvY2tlZCB8fCBwcmV2aW91cy5yZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgbWVzc2FnZS5wcmV2aW91c1ZhbHVlICE9PSBwcmV2aW91cy52YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmICghcmVzdG9yaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ2NvbmZsaWN0JywgZGV0YWlsOiB7IGtleSB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGNvbmZsaWN0OiB0cnVlLCByZWNvdmVyZWQ6IHRydWUsIGtleSwgaXRlbTogcHJldmlvdXMsXG4gICAgICAgICAgICAgICAgICAgIHJlY292ZXJpZXM6IHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGJ1Y2tldCkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZXN0b3JpbmcgJiYgcHJldmlvdXMudmFsdWUgIT09IHZhbHVlKSBwcml2YXRlU3RvcmFnZVJlY292ZXIoYnVja2V0LCBrZXksIHByZXZpb3VzLnZhbHVlLCBwcmV2aW91cy5yZXZpc2lvbiwgbnVsbCk7XG4gICAgICAgICAgICBjb25zdCBpdGVtID0geyB2YWx1ZSwgcmV2aXNpb246IHJldmlzaW9uICsgMSB9O1xuICAgICAgICAgICAgYnVja2V0Lml0ZW1zW2tleV0gPSBpdGVtO1xuICAgICAgICAgICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDb21taXQoc3RvcmFnZUtleSwgYnVja2V0KTtcbiAgICAgICAgICAgIC8vIEJlc3QtZWZmb3J0IHByaXZhdGUgaW52YWxpZGF0aW9uOyBjbG9zZWQvcmVwbGFjZWQgZG9jdW1lbnRzIGFyZSBpZ25vcmVkLlxuICAgICAgICAgICAgZm9yIChjb25zdCBbdGFiSWQsIHN1YnNjcmliZXJdIG9mIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMpIHtcbiAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IChzZW5kZXIudGFiPy5pZCA/PyAnbmF0aXZlOicgKyBzZW5kZXIudXJsKSB8fCBzdWJzY3JpYmVyLm9yaWdpbiAhPT0gb3JpZ2luKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHRhYklkID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICB0cnkgeyBuYXRpdmVSdW50aW1lTm90aWZ5KHN1YnNjcmliZXIuc2VuZGVyLCB7IHR5cGU6ICdtZW1jaGF0OnN0b3JhZ2UtY2hhbmdlZCcsIGtleSwgaXRlbSB9KTsgfVxuICAgICAgICAgICAgICAgICAgICBjYXRjaCB7IHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZGVsZXRlKHRhYklkKTsgfVxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHN1YnNjcmliZXIuZG9jdW1lbnRJZCA/IHsgZG9jdW1lbnRJZDogc3Vic2NyaWJlci5kb2N1bWVudElkIH0gOiB7IGZyYW1lSWQ6IDAgfTtcbiAgICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnLCBrZXksIGl0ZW0gfSwgb3B0aW9ucykuY2F0Y2goKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAocHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5nZXQodGFiSWQpID09PSBzdWJzY3JpYmVyKSBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSh0YWJJZCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwga2V5LCBpdGVtLCAuLi4ocmVzdG9yaW5nID8geyByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIH0gOiB7fSkgfTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBFcnJvcignSW52YWxpZCBvcGVyYXRpb24nKTtcbiAgICB9KTtcbiAgICBwcml2YXRlU3RvcmFnZUNoYWluID0gb3BlcmF0aW9uLmNhdGNoKCgpID0+IHt9KTtcbiAgICAvLyBBbnkgcmVqZWN0ZWQgd3JpdGUgaXMgcmVmdXNlZCBiZWZvcmUgaXQgYmVjb21lcyBkdXJhYmxlOyBrZWVwIHRoZSBrZXkgb25seSxcbiAgICAvLyBuZXZlciB0aGUgdmFsdWUgb3IgdGhlIGVycm9yIHRleHQuXG4gICAgb3BlcmF0aW9uLmNhdGNoKCgpID0+IHtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc3RvcmFnZScsIGV2ZW50OiAncmVqZWN0ZWQnLFxuICAgICAgICAgICAgZGV0YWlsOiB7IGtleTogdHlwZW9mIG1lc3NhZ2Uua2V5ID09PSAnc3RyaW5nJyA/IG1lc3NhZ2Uua2V5LnNsaWNlKDAsIDEyOCkgOiBudWxsIH0gfSwgJ3dvcmtlcicpO1xuICAgIH0pO1xuICAgIHJldHVybiBvcGVyYXRpb247XG59XG4iLCIvLyBFeHRlbnNpb24td2lkZSByaW5nIGJ1ZmZlciBzaGFyZWQgYnkgdGhlIHdvcmtlciwgdGhlIG5hdGl2ZSBwYW5lbCBhbmQgdGhlXG4vLyBjb250ZW50IHdvcmxkLiBJdCBsaXZlcyBpbiBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uIHNvIHdvcmtlciBzdXNwZW5zaW9uIGRvZXNcbi8vIG5vdCBsb3NlIHRoZSB0cmFpbCB3aGlsZSB0aGUgYnJvd3NlciBzdGF5cyBvcGVuLiBOZXZlciBwcmVmZXIgbG9jYWwgc3RvcmFnZTpcbi8vIHRoZSBsb2cgaXMgZGlhZ25vc3RpYyBkYXRhLCBub3QgZHVyYWJsZSBzdGF0ZSwgYW5kIG1heSBiZSBleHBvcnRlZCBieSBhIHVzZXIuXG5jb25zdCBNRU1DSEFUX0RFQlVHX0xPR19LRVkgPSAnbWVtY2hhdERlYnVnTG9nX3YxJztcbmNvbnN0IE1FTUNIQVRfREVCVUdfRkxBR19LRVkgPSAnbWVtY2hhdERlYnVnRW5hYmxlZF92MSc7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xPR19MSU1JVCA9IDUwMDtcbmNvbnN0IE1FTUNIQVRfREVCVUdfTE9HX01BWF9BR0VfTVMgPSA3ICogMjQgKiA2MCAqIDYwICogMTAwMDtcbmNvbnN0IE1FTUNIQVRfREVCVUdfTEVWRUxTID0gT2JqZWN0LmZyZWV6ZShbJ2RlYnVnJywgJ2luZm8nLCAnd2FybicsICdlcnJvciddKTtcbmNvbnN0IE1FTUNIQVRfREVCVUdfV09STERTID0gT2JqZWN0LmZyZWV6ZShbJ3BhbmVsJywgJ2NvbnRlbnQnLCAncnVudGltZScsICd3b3JrZXInXSk7XG5jb25zdCBNRU1DSEFUX0RFQlVHX1NFQ1JFVF9LRVkgPSAvdG9rZW58cGFzc3dvcmR8YXV0aG9yaXphdGlvbnxjb29raWV8c2VjcmV0fGNyZWRlbnRpYWx8Y3NyZnxhcGlrZXl8YXBpX2tleXxzZXNzaW9ufGJlYXJlcnxzaWduYXR1cmV8cHJpdmF0ZS9pO1xuLy8gUXVlcnkgc3RyaW5ncyBjYXJyeSBiZWFyZXItbGlrZSB2YWx1ZXMgKD90b2tlbj0sID9hY2Nlc3NfdG9rZW49LCBzaWduZWQgVVJMcylcbi8vIGFuZCB0aGUgcGF0aCBjYW4gZW1iZWQgYSBzZXNzaW9uIGlkOyBrZWVwIG9ubHkgb3JpZ2luK3BhdGhuYW1lIGZvciBkaWFnbm9zdGljcy5cbmZ1bmN0aW9uIG1lbWNoYXREZWJ1Z1NhZmVVcmwocmF3KSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChTdHJpbmcocmF3KSk7XG4gICAgICAgIGlmICh1cmwucHJvdG9jb2wgIT09ICdodHRwczonICYmIHVybC5wcm90b2NvbCAhPT0gJ2h0dHA6JykgcmV0dXJuICdbVVJMXSc7XG4gICAgICAgIHJldHVybiB1cmwub3JpZ2luICsgdXJsLnBhdGhuYW1lO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gJ1tVUkxdJzsgfVxufVxuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdTYW5pdGl6ZSh2YWx1ZSwga2V5ID0gJycsIGRlcHRoID0gMCkge1xuICAgIGlmIChNRU1DSEFUX0RFQlVHX1NFQ1JFVF9LRVkudGVzdChrZXkpKSByZXR1cm4gJ1tSRURBQ1RFRF0nO1xuICAgIGlmICh2YWx1ZSA9PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHJldHVybiB2YWx1ZTtcbiAgICBpZiAoZGVwdGggPj0gNSkgcmV0dXJuICdbTUFYX0RFUFRIXSc7XG4gICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiB7XG4gICAgICAgIG5hbWU6IHZhbHVlLm5hbWUsXG4gICAgICAgIG1lc3NhZ2U6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKFN0cmluZyh2YWx1ZS5tZXNzYWdlIHx8ICcnKSwgJ21lc3NhZ2UnLCBkZXB0aCArIDEpLFxuICAgICAgICBzdGFjazogbWVtY2hhdERlYnVnU2FuaXRpemUoU3RyaW5nKHZhbHVlLnN0YWNrIHx8ICcnKSwgJ3N0YWNrJywgZGVwdGggKyAxKVxuICAgIH07XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlXG4gICAgICAgICAgICAucmVwbGFjZSgvQmVhcmVyXFxzK1teXFxzXCInXSsvZ2ksICdCZWFyZXIgW1JFREFDVEVEXScpXG4gICAgICAgICAgICAucmVwbGFjZSgvXFxiKD86ZXlKW1xcdy1dezEwLH1cXC5bXFx3LV17MTAsfVxcLltcXHctXXs1LH0pXFxiL2csICdbSldUXScpXG4gICAgICAgICAgICAucmVwbGFjZSgvXFxiWzAtOWEtZl17MzIsfVxcYi9naSwgJ1tIRVhdJylcbiAgICAgICAgICAgIC5yZXBsYWNlKC8oPzwhW1xcZCtdKSg/OlxcKz83fDgpW1xccygpLi1dKlxcZHszfVtcXHMoKS4tXSpcXGR7M31bXFxzKCkuLV0qXFxkezJ9W1xccygpLi1dKlxcZHsyfVxcYi9nLCAnW1BIT05FXScpXG4gICAgICAgICAgICAuc2xpY2UoMCwgMzAwMCk7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIHZhbHVlLnNsaWNlKDAsIDQwKS5tYXAoaXRlbSA9PiBtZW1jaGF0RGVidWdTYW5pdGl6ZShpdGVtLCBrZXksIGRlcHRoICsgMSkpO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xuICAgICAgICBPYmplY3Qua2V5cyh2YWx1ZSkuc2xpY2UoMCwgNTApLmZvckVhY2goY2hpbGRLZXkgPT4ge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbY2hpbGRLZXldID0gL14odXJsfGhyZWZ8b3JpZ2lufHJlZmVycmVyKSQvaS50ZXN0KGNoaWxkS2V5KSAmJiB0eXBlb2YgdmFsdWVbY2hpbGRLZXldID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICAgICA/IG1lbWNoYXREZWJ1Z1NhZmVVcmwodmFsdWVbY2hpbGRLZXldKVxuICAgICAgICAgICAgICAgICAgICA6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKHZhbHVlW2NoaWxkS2V5XSwgY2hpbGRLZXksIGRlcHRoICsgMSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXRjaCB7IHJlc3VsdFtjaGlsZEtleV0gPSAnW1VOUkVBREFCTEVdJzsgfVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG4gICAgcmV0dXJuIFN0cmluZyh2YWx1ZSkuc2xpY2UoMCwgMzAwMCk7XG59XG5cbi8vIEluLW1lbW9yeSBtaXJyb3Igb2YgdGhlIHNlc3Npb24gYnVmZmVyLiBBbGwgbXV0YXRpb25zIHNoYXJlIG9uZSBwcm9taXNlIGNoYWluXG4vLyBzbyBhIGJ1cnN0IG9mIHJlY29yZHMgY2Fubm90IGludGVybGVhdmUgYSByZWFkLW1vZGlmeS13cml0ZSBhbmQgbG9zZSBlbnRyaWVzLlxubGV0IG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBbXTtcbmxldCBtZW1jaGF0RGVidWdMb2FkZWQgPSBmYWxzZTtcbmxldCBtZW1jaGF0RGVidWdDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xubGV0IG1lbWNoYXREZWJ1Z1NlcXVlbmNlID0gMDtcblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnRnJlc2goZW50cmllcykge1xuICAgIGNvbnN0IGN1dG9mZiA9IERhdGUubm93KCkgLSBNRU1DSEFUX0RFQlVHX0xPR19NQVhfQUdFX01TO1xuICAgIHJldHVybiAoQXJyYXkuaXNBcnJheShlbnRyaWVzKSA/IGVudHJpZXMgOiBbXSlcbiAgICAgICAgLmZpbHRlcihlbnRyeSA9PiBlbnRyeSAmJiB0eXBlb2YgZW50cnkuYXQgPT09ICdudW1iZXInICYmIGVudHJ5LmF0ID49IGN1dG9mZilcbiAgICAgICAgLnNsaWNlKC1NRU1DSEFUX0RFQlVHX0xPR19MSU1JVCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0h5ZHJhdGUoKSB7XG4gICAgaWYgKG1lbWNoYXREZWJ1Z0xvYWRlZCkgcmV0dXJuIG1lbWNoYXREZWJ1Z0VudHJpZXM7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoTUVNQ0hBVF9ERUJVR19MT0dfS0VZKSlbTUVNQ0hBVF9ERUJVR19MT0dfS0VZXTtcbiAgICAgICAgbWVtY2hhdERlYnVnRW50cmllcyA9IG1lbWNoYXREZWJ1Z0ZyZXNoKHNhdmVkKTtcbiAgICB9IGNhdGNoIHsgbWVtY2hhdERlYnVnRW50cmllcyA9IFtdOyB9XG4gICAgbWVtY2hhdERlYnVnTG9hZGVkID0gdHJ1ZTtcbiAgICByZXR1cm4gbWVtY2hhdERlYnVnRW50cmllcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWVtY2hhdERlYnVnRW5hYmxlZCgpIHtcbiAgICB0cnkgeyByZXR1cm4gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZKSlbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV0gPT09ICd0cnVlJzsgfVxuICAgIGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1lbWNoYXREZWJ1Z1NldEVuYWJsZWQoZW5hYmxlZCkge1xuICAgIGNvbnN0IHZhbHVlID0gU3RyaW5nKGVuYWJsZWQgPT09IHRydWUpO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZXTogdmFsdWUgfSk7XG4gICAgICAgIHJldHVybiAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KE1FTUNIQVRfREVCVUdfRkxBR19LRVkpKVtNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZXSA9PT0gdmFsdWU7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdSZWNvcmQoZW50cnksIHdvcmxkID0gJ3dvcmtlcicpIHtcbiAgICBjb25zdCB3b3JrID0gbWVtY2hhdERlYnVnQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBsZXZlbCA9IE1FTUNIQVRfREVCVUdfTEVWRUxTLmluY2x1ZGVzKGVudHJ5Py5sZXZlbCkgPyBlbnRyeS5sZXZlbCA6ICdpbmZvJztcbiAgICAgICAgICAgIC8vIEVycm9ycyBhcmUgYWx3YXlzIGtlcHQ6IHRoZXkgYXJlIHdoYXQgYSB1c2VyIHJlcG9ydHMuIEV2ZXJ5dGhpbmdcbiAgICAgICAgICAgIC8vIGVsc2UgaXMgb3B0LWluIGJlY2F1c2UgdGhlIGJ1ZmZlciBpcyBzaGFyZWQgYW5kIG1heSBiZSBleHBvcnRlZC5cbiAgICAgICAgICAgIGlmIChsZXZlbCAhPT0gJ2Vycm9yJyAmJiAhYXdhaXQgbWVtY2hhdERlYnVnRW5hYmxlZCgpKSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBlbnRyaWVzID0gYXdhaXQgbWVtY2hhdERlYnVnSHlkcmF0ZSgpO1xuICAgICAgICAgICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgICAgIGVudHJpZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgaWQ6ICdkbC0nICsgbm93ICsgJy0nICsgKCsrbWVtY2hhdERlYnVnU2VxdWVuY2UpLFxuICAgICAgICAgICAgICAgIGF0OiBub3csXG4gICAgICAgICAgICAgICAgd29ybGQ6IE1FTUNIQVRfREVCVUdfV09STERTLmluY2x1ZGVzKHdvcmxkKSA/IHdvcmxkIDogJ3dvcmtlcicsXG4gICAgICAgICAgICAgICAgbGV2ZWwsXG4gICAgICAgICAgICAgICAgc2NvcGU6IHR5cGVvZiBlbnRyeT8uc2NvcGUgPT09ICdzdHJpbmcnID8gZW50cnkuc2NvcGUuc2xpY2UoMCwgNjQpIDogJ2FwcCcsXG4gICAgICAgICAgICAgICAgZXZlbnQ6IHR5cGVvZiBlbnRyeT8uZXZlbnQgPT09ICdzdHJpbmcnID8gZW50cnkuZXZlbnQuc2xpY2UoMCwgMjAwKSA6ICcnLFxuICAgICAgICAgICAgICAgIGRldGFpbDogbWVtY2hhdERlYnVnU2FuaXRpemUoZW50cnk/LmRldGFpbClcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgbWVtY2hhdERlYnVnRW50cmllcyA9IG1lbWNoYXREZWJ1Z0ZyZXNoKGVudHJpZXMpO1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbTUVNQ0hBVF9ERUJVR19MT0dfS0VZXTogbWVtY2hhdERlYnVnRW50cmllcyB9KTsgfVxuICAgICAgICAgICAgY2F0Y2ggeyAvKiBEaWFnbm9zdGljcyBtdXN0IG5ldmVyIGRpc3R1cmIgdGhlIG9wZXJhdGlvbiBiZWluZyB0cmFjZWQuICovIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIFNhbWU6IGEgYnJva2VuIGJ1ZmZlciBjYW5ub3QgYnJlYWsgYnVzaW5lc3MgbG9naWMuICovIH1cbiAgICB9KTtcbiAgICBtZW1jaGF0RGVidWdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrO1xufVxuXG4vLyBFbnRyaWVzIGFyZSByZXR1cm5lZCBuZXdlc3QgZmlyc3Qgc28gYSBwYXN0ZWQgZXhjZXJwdCBzdGFydHMgYXQgdGhlIGxhdGVzdFxuLy8gZmFpbHVyZS4gYGxpbWl0YCBpcyBjbGFtcGVkIHRvIHRoZSByaW5nIHNpemUuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdSZWFkKG9wdGlvbnMgPSB7fSkge1xuICAgIGNvbnN0IHdvcmsgPSBtZW1jaGF0RGVidWdDaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgZW5hYmxlZCA9IGF3YWl0IG1lbWNoYXREZWJ1Z0VuYWJsZWQoKTtcbiAgICAgICAgbGV0IGVudHJpZXM7XG4gICAgICAgIHRyeSB7IGVudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChhd2FpdCBtZW1jaGF0RGVidWdIeWRyYXRlKCkpOyBtZW1jaGF0RGVidWdFbnRyaWVzID0gZW50cmllczsgfVxuICAgICAgICBjYXRjaCB7IGVudHJpZXMgPSBbXTsgfVxuICAgICAgICBjb25zdCBsaW1pdCA9IE51bWJlci5pc0ludGVnZXIob3B0aW9ucz8ubGltaXQpXG4gICAgICAgICAgICA/IE1hdGgubWluKE1hdGgubWF4KG9wdGlvbnMubGltaXQsIDEpLCBNRU1DSEFUX0RFQlVHX0xPR19MSU1JVCkgOiBNRU1DSEFUX0RFQlVHX0xPR19MSU1JVDtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGVuYWJsZWQsIGVudHJpZXM6IGVudHJpZXMuc2xpY2UoLWxpbWl0KS5yZXZlcnNlKCkgfTtcbiAgICB9KTtcbiAgICBtZW1jaGF0RGVidWdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+ICh7IG9rOiB0cnVlLCBlbmFibGVkOiBmYWxzZSwgZW50cmllczogW10gfSkpO1xufVxuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdDbGVhcigpIHtcbiAgICBjb25zdCB3b3JrID0gbWVtY2hhdERlYnVnQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBbXTtcbiAgICAgICAgbWVtY2hhdERlYnVnTG9hZGVkID0gdHJ1ZTtcbiAgICAgICAgdHJ5IHsgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbTUVNQ0hBVF9ERUJVR19MT0dfS0VZXTogW10gfSk7IH1cbiAgICAgICAgY2F0Y2ggeyAvKiBDbGVhcmluZyBpcyBiZXN0IGVmZm9ydC4gKi8gfVxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICAgIG1lbWNoYXREZWJ1Z0NoYWluID0gd29yay5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHdvcmsuY2F0Y2goKCkgPT4gKHsgb2s6IHRydWUgfSkpO1xufVxuIiwiJ3VzZSBzdHJpY3QnO1xuXG5jb25zdCBwZW5kaW5nUmVxdWVzdHMgPSBuZXcgTWFwKCk7XG5jb25zdCBydWxlc1JlYWR5ID0gY2hyb21lLmRlY2xhcmF0aXZlTmV0UmVxdWVzdC51cGRhdGVTZXNzaW9uUnVsZXMoe1xuICAgIHJlbW92ZVJ1bGVJZHM6IFsxLCAyXSxcbiAgICBhZGRSdWxlczogW1xuICAgICAgICB7IGlkOiAxLCBwcmlvcml0eTogMSwgYWN0aW9uOiB7IHR5cGU6ICdtb2RpZnlIZWFkZXJzJywgcmVxdWVzdEhlYWRlcnM6IFtcbiAgICAgICAgICAgIHsgaGVhZGVyOiAnT3JpZ2luJywgb3BlcmF0aW9uOiAnc2V0JywgdmFsdWU6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgfSxcbiAgICAgICAgICAgIHsgaGVhZGVyOiAnUmVmZXJlcicsIG9wZXJhdGlvbjogJ3NldCcsIHZhbHVlOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJyB9XG4gICAgICAgIF0gfSwgY29uZGl0aW9uOiB7IGluaXRpYXRvckRvbWFpbnM6IFtjaHJvbWUucnVudGltZS5pZF0sIHVybEZpbHRlcjogJ3xodHRwczovL3BhbmVsLmhhdGlrby5ydS8nLCByZXNvdXJjZVR5cGVzOiBbJ3htbGh0dHByZXF1ZXN0J10gfSB9LFxuICAgICAgICB7IGlkOiAyLCBwcmlvcml0eTogMiwgYWN0aW9uOiB7IHR5cGU6ICdibG9jaycgfSwgY29uZGl0aW9uOiB7XG4gICAgICAgICAgICBpbml0aWF0b3JEb21haW5zOiBbY2hyb21lLnJ1bnRpbWUuaWRdLFxuICAgICAgICAgICAgZXhjbHVkZWRSZXF1ZXN0RG9tYWluczogWy4uLm5ldyBTZXQoTUVNQ0hBVF9FWFRFTlNJT05fQ09ORklHLm5ldHdvcmtIb3N0cy5tYXAoaG9zdCA9PiBob3N0LnJlcGxhY2UoL15cXCpcXC4vLCAnJykpKV0sXG4gICAgICAgICAgICByZXNvdXJjZVR5cGVzOiBbJ3htbGh0dHByZXF1ZXN0J11cbiAgICAgICAgfSB9XG4gICAgXVxufSk7XG4vLyBGYWlsIGNsb3NlZDogYSBmYWlsZWQgRE5SIHNldHVwIGlzIGNhdWdodCBoZXJlIGFuZCBibG9ja3Mgc3Vic2VxdWVudCByZXF1ZXN0cy5cbmxldCBydWxlRmFpbHVyZSA9IGZhbHNlO1xucnVsZXNSZWFkeS5jYXRjaCgoKSA9PiB7IHJ1bGVGYWlsdXJlID0gdHJ1ZTsgfSk7XG5cbmZ1bmN0aW9uIG1hdGNoZXNIb3N0KGhvc3RuYW1lLCBwYXR0ZXJuKSB7XG4gICAgcmV0dXJuIHBhdHRlcm4uc3RhcnRzV2l0aCgnKi4nKVxuICAgICAgICA/IGhvc3RuYW1lID09PSBwYXR0ZXJuLnNsaWNlKDIpIHx8IGhvc3RuYW1lLmVuZHNXaXRoKCcuJyArIHBhdHRlcm4uc2xpY2UoMikpXG4gICAgICAgIDogaG9zdG5hbWUgPT09IHBhdHRlcm47XG59XG5cbmZ1bmN0aW9uIGFsbG93ZWRVcmwocmF3KSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpO1xuICAgIGlmICh1cmwucHJvdG9jb2wgIT09ICdodHRwczonIHx8IHVybC51c2VybmFtZSB8fCB1cmwucGFzc3dvcmQgfHwgdXJsLnBvcnRcbiAgICAgICAgfHwgIU1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5uZXR3b3JrSG9zdHMuc29tZShob3N0ID0+IG1hdGNoZXNIb3N0KHVybC5ob3N0bmFtZSwgaG9zdCkpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVVJMIG5vdCBwZXJtaXR0ZWQnKTtcbiAgICB9XG4gICAgcmV0dXJuIHVybDtcbn1cblxuZnVuY3Rpb24gdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB7XG4gICAgaWYgKHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgIU51bWJlci5pc0ludGVnZXIoc2VuZGVyLnRhYj8uaWQpIHx8IHNlbmRlci5mcmFtZUlkICE9PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChzZW5kZXIudXJsKTtcbiAgICAgICAgcmV0dXJuIHVybC5wcm90b2NvbCA9PT0gJ2h0dHBzOicgJiYgIXVybC5wb3J0ICYmIE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5wYWdlTWF0Y2hlcy5zb21lKHBhdHRlcm4gPT5cbiAgICAgICAgICAgIG1hdGNoZXNIb3N0KHVybC5ob3N0bmFtZSwgbmV3IFVSTChwYXR0ZXJuLnJlcGxhY2UoJyouJywgJ3dpbGRjYXJkLicpKS5ob3N0bmFtZS5yZXBsYWNlKCd3aWxkY2FyZC4nLCAnKi4nKSkpO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cblxuZnVuY3Rpb24gcmVxdWVzdEtleShzZW5kZXIsIGlkKSB7XG4gICAgcmV0dXJuIHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgPyBgbmF0aXZlOiR7c2VuZGVyLnVybH06JHtpZH1gIDogYCR7c2VuZGVyLnRhYi5pZH06JHtzZW5kZXIuZnJhbWVJZH06JHtpZH1gO1xufVxuXG4vLyBEaXNwYXRjaCBNUyByZXF1ZXN0cyBkaXJlY3RseS4gT25seSBhIGZhaWxlZCByZWFkIHdhaXRzIGZvciBpdHMgb3duIHJldHJ5O1xuLy8gbm8gcHJvZmlsZS13aWRlIHF1b3RhIHN0YXRlLCByZXNlcnZhdGlvbnMsIGNvbmN1cnJlbmN5IGNhcCBvciBwYWNpbmcuXG5mdW5jdGlvbiBpc01zSnNvbkFwaSh1cmwpIHtcbiAgICByZXR1cm4gdXJsLmhvc3RuYW1lID09PSAnYXBpLm1veXNrbGFkLnJ1JyAmJiAvXlxcL2FwaVxcL3JlbWFwXFwvMVxcLjIoPzpcXC98JCkvLnRlc3QodXJsLnBhdGhuYW1lKTtcbn1cbmZ1bmN0aW9uIG1zUmV0cnlEZWxheShyZXNwb25zZSwgdGV4dCA9ICcnKSB7XG4gICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgIGxldCBxdW90YUVycm9yID0gZmFsc2U7XG4gICAgICAgIHRyeSB7IHF1b3RhRXJyb3IgPSBKU09OLnBhcnNlKHRleHQpPy5lcnJvcnM/LnNvbWUoZXJyb3IgPT4gTnVtYmVyKGVycm9yLmNvZGUpID09PSAxMDczKSA9PT0gdHJ1ZTsgfSBjYXRjaCB7IC8qIE5vdCBKU09OLiAqLyB9XG4gICAgICAgIGlmICghWzQwOCwgNDI5XS5pbmNsdWRlcyhyZXNwb25zZS5zdGF0dXMpICYmIHJlc3BvbnNlLnN0YXR1cyA8IDUwMCAmJiAhcXVvdGFFcnJvcikgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGxvZ25leCA9IE51bWJlcihyZXNwb25zZT8uaGVhZGVycy5nZXQoJ1gtTG9nbmV4LVJldHJ5LUFmdGVyJykgfHwgMCk7XG4gICAgY29uc3QgcmV0cnlBZnRlciA9IHJlc3BvbnNlPy5oZWFkZXJzLmdldCgnUmV0cnktQWZ0ZXInKTtcbiAgICBjb25zdCBzZWNvbmRzID0gcmV0cnlBZnRlcj8udHJpbSgpID8gTnVtYmVyKHJldHJ5QWZ0ZXIpIDogMDtcbiAgICBjb25zdCBzdGFuZGFyZCA9IE51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSA/IHNlY29uZHMgKiAxMDAwIDogRGF0ZS5wYXJzZShyZXRyeUFmdGVyKSAtIERhdGUubm93KCk7XG4gICAgY29uc3QgZGVsYXkgPSBNYXRoLm1heCg1MDAsIE51bWJlci5pc0Zpbml0ZShsb2duZXgpID8gbG9nbmV4IDogMCwgTnVtYmVyLmlzRmluaXRlKHN0YW5kYXJkKSA/IHN0YW5kYXJkIDogMCk7XG4gICAgcmV0dXJuIGRlbGF5O1xufVxuZnVuY3Rpb24gbXNXYWl0Rm9yUmV0cnkoc2lnbmFsLCBkZWxheSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgbGV0IHJlbWFpbmluZyA9IGRlbGF5O1xuICAgICAgICBsZXQgdGltZXI7XG4gICAgICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGRvbmUpOyByZXNvbHZlKCk7IH07XG4gICAgICAgIGNvbnN0IHNjaGVkdWxlID0gKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2h1bmsgPSBNYXRoLm1pbihyZW1haW5pbmcsIDIxNDc0ODM2NDcpO1xuICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgICAgICByZW1haW5pbmcgLT0gY2h1bms7XG4gICAgICAgICAgICAgICAgaWYgKHJlbWFpbmluZyA+IDApIHNjaGVkdWxlKCk7XG4gICAgICAgICAgICAgICAgZWxzZSBkb25lKCk7XG4gICAgICAgICAgICB9LCBjaHVuayk7XG4gICAgICAgIH07XG4gICAgICAgIHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGRvbmUsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgaWYgKHNpZ25hbC5hYm9ydGVkKSBkb25lKCk7XG4gICAgICAgIGVsc2Ugc2NoZWR1bGUoKTtcbiAgICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybVJlcXVlc3QobWVzc2FnZSwgc2VuZGVyLCBiYWNrZ3JvdW5kU2lnbmFsKSB7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UucmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhbGxvd2VkVXJsKHJlcXVlc3Q/LnVybCk7XG4gICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICghWydHRVQnLCAnSEVBRCcsICdQT1NUJywgJ1BVVCcsICdQQVRDSCcsICdERUxFVEUnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ01ldGhvZCBub3QgcGVybWl0dGVkJyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0JvZHkgbXVzdCBiZSB0ZXh0Jyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgYm9keScpO1xuICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSAmJiAhWyd0ZXh0JywgJ2pzb24nXS5pbmNsdWRlcyhyZXF1ZXN0LnJlc3BvbnNlVHlwZSkpIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgcmVzcG9uc2UgdHlwZScpO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycygpO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXF1ZXN0LmhlYWRlcnMgfHwge30pKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGVhZGVyJyk7XG4gICAgICAgIGlmICgvXmF1dGhvcml6YXRpb24kL2kudGVzdChuYW1lKSAmJiB1cmwuaG9zdG5hbWUgIT09ICdhcGkubW95c2tsYWQucnUnKSB0aHJvdyBuZXcgRXJyb3IoJ0F1dGhvcml6YXRpb24gaG9zdCBub3QgcGVybWl0dGVkJyk7XG4gICAgICAgIGlmICgvXihvcmlnaW58cmVmZXJlcnx1c2VyLWFnZW50fGNvb2tpZXxob3N0fGNvbnRlbnQtbGVuZ3RofGNvbm5lY3Rpb258YWNjZXB0LWVuY29kaW5nfHByb3h5LS4qfHNlYy0uKikkL2kudGVzdChuYW1lKSkgY29udGludWU7XG4gICAgICAgIGhlYWRlcnMuc2V0KG5hbWUsIHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgaXNNc0pzb25BcGkodXJsKSAmJiByZXF1ZXN0LmNyZWRlbnRpYWxHdWFyZCAhPT0gdHJ1ZSkgdGhyb3cgRXJyb3IoJ05hdGl2ZSBjcmVkZW50aWFscyBtdXN0IGJlIGd1YXJkZWQnKTtcbiAgICBjb25zdCBrZXkgPSByZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCk7XG4gICAgaWYgKHBlbmRpbmdSZXF1ZXN0cy5oYXMoa2V5KSkgdGhyb3cgbmV3IEVycm9yKCdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IGVudHJ5ID0geyBjb250cm9sbGVyOiBuZXcgQWJvcnRDb250cm9sbGVyKCksIGV2ZW50OiAnJyB9O1xuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoa2V5LCBlbnRyeSk7XG4gICAgY29uc3QgY2FuY2VsQmFja2dyb3VuZCA9ICgpID0+IHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH07XG4gICAgYmFja2dyb3VuZFNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgaWYgKGJhY2tncm91bmRTaWduYWw/LmFib3J0ZWQpIGNhbmNlbEJhY2tncm91bmQoKTtcbiAgICBjb25zdCB0aW1lb3V0ID0gTWF0aC5taW4oMzAwMDAsIE1hdGgubWF4KDEsIE51bWJlcihyZXF1ZXN0LnRpbWVvdXQpIHx8IDMwMDAwKSk7XG4gICAgbGV0IHRpbWVyO1xuICAgIGNvbnN0IGNoZWNrQ3VycmVudCA9IHJlcXVlc3QuY3JlZGVudGlhbEd1YXJkID09PSB0cnVlID8gYXN5bmMgKCkgPT4ge1xuICAgICAgICBsZXQgY2hlY2tUaW1lcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICAgICAgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKVxuICAgICAgICAgICAgICAgICAgICA/IG5hdGl2ZVJ1bnRpbWVSZXF1ZXN0KG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmdldChzZW5kZXIpLCB7IHR5cGU6ICdtZW1jaGF0OnJlcXVlc3QtY3VycmVudCcsIGlkOiBtZXNzYWdlLmlkIH0pXG4gICAgICAgICAgICAgICAgICAgIDogY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2Uoc2VuZGVyLnRhYi5pZCwgeyB0eXBlOiAnbWVtY2hhdDpyZXF1ZXN0LWN1cnJlbnQnLCBpZDogbWVzc2FnZS5pZCB9LCBzZW5kZXIuZG9jdW1lbnRJZCA/IHsgZG9jdW1lbnRJZDogc2VuZGVyLmRvY3VtZW50SWQgfSA6IHsgZnJhbWVJZDogc2VuZGVyLmZyYW1lSWQgfSksXG4gICAgICAgICAgICAgICAgbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7IGNoZWNrVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUobnVsbCksIDEwMDApOyB9KVxuICAgICAgICAgICAgXSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0Py5jdXJyZW50ID09PSB0cnVlICYmICghaXNNc0pzb25BcGkodXJsKSB8fCB0eXBlb2YgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudCAhPT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgICAgIHx8IGF3YWl0IHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQoc2VuZGVyLCBoZWFkZXJzLmdldCgnYXV0aG9yaXphdGlvbicpKSkpIHJldHVybjtcbiAgICAgICAgfSBjYXRjaCB7IC8qIE1pc3NpbmcvaW52YWxpZGF0ZWQgY29udGVudCB3b3JsZCBmYWlscyBjbG9zZWQuICovIH1cbiAgICAgICAgZmluYWxseSB7IGNsZWFyVGltZW91dChjaGVja1RpbWVyKTsgfVxuICAgICAgICBlbnRyeS5ldmVudCA9ICdhYm9ydCc7XG4gICAgICAgIGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICB9IDogbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBydWxlc1JlYWR5O1xuICAgICAgICBpZiAocnVsZUZhaWx1cmUpIHRocm93IG5ldyBFcnJvcignTmV0d29yayBydWxlcyB1bmF2YWlsYWJsZScpO1xuICAgICAgICBpZiAodXJsLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyAmJiBwYW5lbFNlc3Npb24/LnRhYikge1xuICAgICAgICAgICAgaWYgKGNoZWNrQ3VycmVudCkgYXdhaXQgY2hlY2tDdXJyZW50KCk7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgcGFuZWxSZXF1ZXN0VmlhVGFiKHsgLi4ucmVxdWVzdCwgbWV0aG9kIH0sIGVudHJ5LmNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgOyBhdHRlbXB0KyspIHtcbiAgICAgICAgICAgIGlmIChlbnRyeS5ldmVudCkgcmV0dXJuIHsgZXZlbnQ6IGVudHJ5LmV2ZW50IH07XG4gICAgICAgICAgICBpZiAoY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgIGlmIChlbnRyeS5ldmVudCkgcmV0dXJuIHsgZXZlbnQ6IGVudHJ5LmV2ZW50IH07XG4gICAgICAgICAgICBjb25zdCBjYW5SZXRyeSA9IGlzTXNKc29uQXBpKHVybCkgJiYgWydHRVQnLCAnSEVBRCddLmluY2x1ZGVzKG1ldGhvZCkgJiYgYXR0ZW1wdCA9PT0gMDtcbiAgICAgICAgICAgIGxldCByZXRyeURlbGF5O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBjb250cm9sbGVyID0gZW50cnkuY29udHJvbGxlcjtcbiAgICAgICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBlbnRyeS5ldmVudCA9ICd0aW1lb3V0JzsgY29udHJvbGxlci5hYm9ydCgpOyB9LCB0aW1lb3V0KTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybC5ocmVmLCB7XG4gICAgICAgICAgICAgICAgICAgIG1ldGhvZCwgaGVhZGVycywgYm9keTogcmVxdWVzdC5kYXRhID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgICAgY3JlZGVudGlhbHM6IHJlcXVlc3QuYW5vbnltb3VzID09PSB0cnVlID8gJ29taXQnIDogJ2luY2x1ZGUnLFxuICAgICAgICAgICAgICAgICAgICBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLCByZWRpcmVjdDogaXNNc0pzb25BcGkodXJsKSA/ICdlcnJvcicgOiAnZm9sbG93J1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIC8vIEROUiBibG9ja3MgcmVkaXJlY3RzIHRvIHVuZ3JhbnRlZCBob3N0cyBiZWZvcmUgc2VuZGluZyBieXRlcy5cbiAgICAgICAgICAgICAgICBhbGxvd2VkVXJsKHJlc3BvbnNlLnVybCB8fCB1cmwuaHJlZik7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuICAgICAgICAgICAgICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpICYmIGNoZWNrQ3VycmVudCkgYXdhaXQgY2hlY2tDdXJyZW50KCk7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSB0aHJvdyBuZXcgRXJyb3IoJ0NhbmNlbGxlZCcpO1xuICAgICAgICAgICAgICAgIHJldHJ5RGVsYXkgPSBjYW5SZXRyeSA/IG1zUmV0cnlEZWxheShyZXNwb25zZSwgcmVzcG9uc2VUZXh0KSA6IG51bGw7XG4gICAgICAgICAgICAgICAgLy8gUGF0aCBvbmx5OiBxdWVyeSBzdHJpbmdzIGNhbiBjYXJyeSBzZWFyY2ggdGVybXMgb3IgaWRlbnRpZmllcnMuXG4gICAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA+PSA0MDApIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ25ldHdvcmsnLCBldmVudDogJ2h0dHAtZXJyb3InLFxuICAgICAgICAgICAgICAgICAgICBkZXRhaWw6IHsgdXJsOiB1cmwub3JpZ2luICsgdXJsLnBhdGhuYW1lLCBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgcmV0cnlEZWxheSwgYXR0ZW1wdCB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgICAgICBpZiAocmV0cnlEZWxheSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgcGFyc2VkID0gcmVzcG9uc2VUZXh0O1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVxdWVzdC5yZXNwb25zZVR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpOyB9IGNhdGNoIHsgcGFyc2VkID0gbnVsbDsgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGV2ZW50OiAnbG9hZCcsIHJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCwgcmVzcG9uc2VUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2U6IHBhcnNlZCwgcmVzcG9uc2VIZWFkZXJzOiBbLi4ucmVzcG9uc2UuaGVhZGVyc10ubWFwKChbbmFtZSwgdmFsdWVdKSA9PiBgJHtuYW1lfTogJHt2YWx1ZX1gKS5qb2luKFN0cmluZy5mcm9tQ2hhckNvZGUoMTMsIDEwKSksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaW5hbFVybDogcmVzcG9uc2UudXJsIHx8IHVybC5ocmVmLCByZWFkeVN0YXRlOiA0XG4gICAgICAgICAgICAgICAgICAgIH0gfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQgIT09ICdhYm9ydCcpIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ25ldHdvcmsnLCBldmVudDogJ25ldHdvcmstZXJyb3InLFxuICAgICAgICAgICAgICAgICAgICBkZXRhaWw6IHsgdXJsOiB1cmwub3JpZ2luICsgdXJsLnBhdGhuYW1lLCBzdGF0dXM6IG51bGwsIHJldHJ5RGVsYXk6IGNhblJldHJ5ID8gNTAwIDogbnVsbCwgYXR0ZW1wdCB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgICAgICBpZiAoIWNhblJldHJ5IHx8IGVudHJ5LmV2ZW50ID09PSAnYWJvcnQnKSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfHwgJ2Vycm9yJywgZXJyb3I6ICfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcgfTtcbiAgICAgICAgICAgICAgICByZXRyeURlbGF5ID0gNTAwO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgfVxuICAgICAgICAgICAgLy8gQSB0aW1lb3V0IGFib3J0cyBpdHMgYXR0ZW1wdCwgbm90IHRoZSBuZXh0IG9uZS4gRXhwbGljaXQgYWJvcnRzIGFuZFxuICAgICAgICAgICAgLy8gY3JlZGVudGlhbCBjaGFuZ2VzIHN0aWxsIGNhbmNlbCB0aGlzIHdhaXQgYW5kIHN1cHByZXNzIHRoZSByZXRyeS5cbiAgICAgICAgICAgIGVudHJ5LmV2ZW50ID0gJyc7XG4gICAgICAgICAgICBlbnRyeS5jb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICAgICAgYXdhaXQgbXNXYWl0Rm9yUmV0cnkoZW50cnkuY29udHJvbGxlci5zaWduYWwsIHJldHJ5RGVsYXkpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGJhY2tncm91bmRTaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsQmFja2dyb3VuZCk7XG4gICAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoa2V5KTtcbiAgICB9XG59XG4iLCIvLyBBIHNpbmdsZSB3b3JrZXIgb3ducyB0aGUgUGFuZWwgdG9rZW4uIE5ldmVyIHBlcnNpc3QgaXQgaW50byBwYWdlIHN0b3JhZ2UuXG5jb25zdCBQQU5FTF9TRVNTSU9OX1RUTCA9IDEyICogNjAgKiAxMDAwO1xuY29uc3QgUEFORUxfU0VTU0lPTl9USU1FT1VUID0gMTUwMDA7XG5sZXQgcGFuZWxTZXNzaW9uID0gbnVsbDtcbmxldCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xubGV0IGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcblxuZnVuY3Rpb24gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGh0bWwpIHtcbiAgICBjb25zdCBjbGVhbiA9IGh0bWwucmVwbGFjZSgvPCEtLVtcXHNcXFNdKj8tLT58PHNjcmlwdFxcYltePl0qPltcXHNcXFNdKj88XFwvc2NyaXB0XFxzKj4vZ2ksICcnKTtcbiAgICBpZiAoLzxpbnB1dFxcYltePl0qXFxidHlwZVxccyo9XFxzKltcIiddP3Bhc3N3b3JkXFxiL2kudGVzdChjbGVhbikpIHJldHVybiAnJztcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBjbGVhbi5tYXRjaCgvPG1ldGFcXGJbXj5dKj4vZ2kpIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IGF0dHJzID0ge307XG4gICAgICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgdGFnLm1hdGNoQWxsKC8oW1xcdy1dKylcXHMqPVxccyooPzpcIihbXlwiXSopXCJ8JyhbXiddKiknKS9nKSkge1xuICAgICAgICAgICAgYXR0cnNbbWF0Y2hbMV0udG9Mb3dlckNhc2UoKV0gPSBtYXRjaFsyXSA/PyBtYXRjaFszXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXR0cnMubmFtZT8udG9Mb3dlckNhc2UoKSA9PT0gJ2NzcmYtdG9rZW4nICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChhdHRycy5jb250ZW50IHx8ICcnKSkgcmV0dXJuIGF0dHJzLmNvbnRlbnQ7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cblxubGV0IHBhbmVsVGFiU2VxdWVuY2UgPSAwO1xuZnVuY3Rpb24gcGFuZWxUYWJVcmwocmF3KSB7XG4gICAgdHJ5IHsgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpOyByZXR1cm4gdXJsLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmQgJiYgIS9eXFwvbG9naW5cXC8/JC8udGVzdCh1cmwucGF0aG5hbWUpOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmZ1bmN0aW9uIHBhbmVsVGFiUmVxdWVzdEFsbG93ZWQocmVxdWVzdCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxdWVzdD8udXJsKSwgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gcGFuZWxUYWJVcmwodXJsLmhyZWYpICYmICF1cmwuaGFzaCAmJiAhdXJsLnNlYXJjaCAmJiAoKG1ldGhvZCA9PT0gJ0dFVCdcbiAgICAgICAgICAgICYmICh1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAvXlxcL2FwaVxcL2JvbnVzZXNcXC9jaGVja1xcL1xcZHsxLDIwfSQvLnRlc3QodXJsLnBhdGhuYW1lKSkpXG4gICAgICAgICAgICB8fCAobWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZWFyY2gnICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgPT09ICdzdHJpbmcnICYmIHJlcXVlc3QuZGF0YS5sZW5ndGggPD0gMzI3NjgpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFRhYk1lc3NhZ2UodGFiSWQsIHBheWxvYWQsIHNpZ25hbCkge1xuICAgIGNvbnN0IGlkID0gJ3BhbmVsLScgKyBEYXRlLm5vdygpICsgJy0nICsgKCsrcGFuZWxUYWJTZXF1ZW5jZSk7XG4gICAgbGV0IHRpbWVyLCBhYm9ydDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBhYm9ydCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgb3BlcmF0aW9uOiAnY2FuY2VsJyB9LCB7IGZyYW1lSWQ6IDAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgICAgICAgIHJlc29sdmUobnVsbCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KGFib3J0LCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc2lnbmFsPy5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IFByb21pc2UucmFjZShbY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6cGFuZWwtdGFiJywgaWQsIC4uLnBheWxvYWQgfSwgeyBmcmFtZUlkOiAwIH0pLCB0aW1lb3V0XSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XG4gICAgZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBhYm9ydCk7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHJlY292ZXJQYW5lbEZyb21UYWIoc2lnbmFsKSB7XG4gICAgaWYgKCFjaHJvbWUudGFicz8ucXVlcnkgfHwgIWNocm9tZS50YWJzPy5nZXQgfHwgc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRhYnMgPSAoYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS8qJyB9KSkuZmlsdGVyKHRhYiA9PiBOdW1iZXIuaXNJbnRlZ2VyKHRhYi5pZCkgJiYgcGFuZWxUYWJVcmwodGFiLnVybCkpO1xuICAgICAgICB0YWJzLnNvcnQoKGEsIGIpID0+IE51bWJlcighIWIuYWN0aXZlKSAtIE51bWJlcighIWEuYWN0aXZlKSB8fCAoYi5sYXN0QWNjZXNzZWQgfHwgMCkgLSAoYS5sYXN0QWNjZXNzZWQgfHwgMCkgfHwgYS5pZCAtIGIuaWQpO1xuICAgICAgICBmb3IgKGNvbnN0IHRhYiBvZiB0YWJzLnNsaWNlKDAsIDMpKSB7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2UodGFiLmlkLCB7IG9wZXJhdGlvbjogJ3Nlc3Npb24nIH0sIHNpZ25hbCk7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYi5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgaWYgKHJlcGx5Py5vayAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QocmVwbHkudG9rZW4gfHwgJycpICYmIHR5cGVvZiByZXBseS5pbnN0YW5jZSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAmJiByZXBseS5pbnN0YW5jZS5sZW5ndGggPD0gMTAwICYmIHBhbmVsVGFiVXJsKGN1cnJlbnQ/LnVybCkpIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSB7IHRva2VuOiByZXBseS50b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSwgdGFiOiB7IGlkOiB0YWIuaWQsIGluc3RhbmNlOiByZXBseS5pbnN0YW5jZSB9IH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuOiByZXBseS50b2tlbiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC9uYXZpZ2F0ZWQgdGFicyBhcmUgbm90IGFuIGF1dGhlbnRpY2F0ZWQgc2Vzc2lvbi4gKi8gfVxuICAgIHJldHVybiBudWxsO1xufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxSZXF1ZXN0VmlhVGFiKHJlcXVlc3QsIHNpZ25hbCkge1xuICAgIGNvbnN0IHJvdXRlID0gcGFuZWxTZXNzaW9uPy50YWI7XG4gICAgaWYgKCFyb3V0ZSB8fCAhcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSkgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC30LDQv9GA0L7RgSDQvtGC0LrQu9C+0L3RkdC9JyB9O1xuICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQocm91dGUuaWQpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmICghcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6IHNpZ25hbC5hYm9ydGVkID8gJ2Fib3J0JyA6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INCy0LrQu9Cw0LTQutCwINC30LDQutGA0YvRgtCwINC40LvQuCDQuNC30LzQtdC90LXQvdCwLiDQn9C+0LLRgtC+0YDQuNGC0LUg0L/RgNC+0LLQtdGA0LrRgyBwYW5lbC4nIH07XG4gICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2Uocm91dGUuaWQsIHsgb3BlcmF0aW9uOiAncmVxdWVzdCcsIGluc3RhbmNlOiByb3V0ZS5pbnN0YW5jZSwgcmVxdWVzdCB9LCBzaWduYWwpO1xuICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6ICdhYm9ydCcgfTtcbiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFyZXBseT8ub2sgfHwgcmVwbHkuaW5zdGFuY2UgIT09IHJvdXRlLmluc3RhbmNlIHx8ICFwYW5lbFRhYlVybChhZnRlcj8udXJsKSB8fCByZXBseS5yZXN1bHQ/LmV2ZW50ICE9PSAnbG9hZCdcbiAgICAgICAgfHwgIU51bWJlci5pc0ludGVnZXIocmVwbHkucmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpIHx8IHJlcGx5LnJlc3VsdC5yZXNwb25zZT8uZmluYWxVcmwgIT09IHJlcXVlc3QudXJsKSB7XG4gICAgICAgIGlmIChwYW5lbFNlc3Npb24/LnRhYiA9PT0gcm91dGUpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3BhbmVsJywgZXZlbnQ6ICdzZXNzaW9uLWxvc3QnLCBkZXRhaWw6IHsgcmVhc29uOiAnY29udGV4dCcgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ1BhbmVsOiDQutC+0L3RgtC10LrRgdGCINCy0LrQu9Cw0LTQutC4INC40LfQvNC10L3QuNC70YHRjy4g0J3QsNC20LzQuNGC0LUgcGFuZWwg0LTQu9GPINC/0L7QstGC0L7RgNC90L7QuSDQv9GA0L7QstC10YDQutC4LicgfTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcGx5LnJlc3VsdDtcbn1cblxuZnVuY3Rpb24gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpIHtcbiAgICAvLyBBIHF1ZXVlZCBub3JtYWwgZmxpZ2h0IG1heSBoYXZlIHBvcHVsYXRlZCB0aGUgY2FjaGUgc2luY2UgZm9yY2Ugd2FzIHJlcXVlc3RlZC5cbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgY29uc3QgZmxpZ2h0ID0geyBwcm9taXNlOiBudWxsIH07XG4gICAgZmxpZ2h0LnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICBjb25zdCBmYWlsdXJlID0gYXN5bmMgKHJlYXNvbiwgZXJyb3IpID0+IHtcbiAgICAgICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3BhbmVsJywgZXZlbnQ6ICdzZXNzaW9uLWZhaWxlZCcsIGRldGFpbDogeyByZWFzb24gfSB9LCAnd29ya2VyJyk7XG4gICAgICAgICAgICByZXR1cm4gKGF3YWl0IHJlY292ZXJQYW5lbEZyb21UYWIoY29udHJvbGxlci5zaWduYWwpKSB8fCB7IG9rOiBmYWxzZSwgcmVhc29uLCBlcnJvciB9O1xuICAgICAgICB9O1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgcnVsZXNSZWFkeTtcbiAgICAgICAgICAgIGlmIChydWxlRmFpbHVyZSB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgRXJyb3IoJ1BhbmVsIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKCdodHRwczovL3BhbmVsLmhhdGlrby5ydS9zZWFyY2gnLCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnR0VUJywgaGVhZGVyczogeyBBY2NlcHQ6ICd0ZXh0L2h0bWwnIH0sIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsXG4gICAgICAgICAgICAgICAgY2FjaGU6ICduby1zdG9yZScsIHJlZGlyZWN0OiAnZm9sbG93Jywgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBjb25zdCBmaW5hbFVybCA9IG5ldyBVUkwocmVzcG9uc2UudXJsIHx8ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9zZWFyY2gnKTtcbiAgICAgICAgICAgIGlmIChmaW5hbFVybC5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgfHwgIS9eXFwvc2VhcmNoXFwvPyQvLnRlc3QoZmluYWxVcmwucGF0aG5hbWUpXG4gICAgICAgICAgICAgICAgfHwgcmVzcG9uc2Uuc3RhdHVzIDwgMjAwIHx8IHJlc3BvbnNlLnN0YXR1cyA+PSAzMDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZmFpbHVyZSgnYXV0aCcsICdQYW5lbDog0YTQvtC90L7QstGL0Lkg0LLRhdC+0LQg0L3QtdC00L7RgdGC0YPQv9C10L0uINCe0YLQutGA0L7QudGC0LUg0LDQstGC0L7RgNC40LfQvtCy0LDQvdC90YPRjiBwYW5lbC5oYXRpa28ucnUg0LIg0Y3RgtC+0Lwg0L/RgNC+0YTQuNC70LUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB0b2tlbiA9IGV4dHJhY3RQYW5lbFNlc3Npb25Ub2tlbihhd2FpdCByZXNwb25zZS50ZXh0KCkpO1xuICAgICAgICAgICAgaWYgKCF0b2tlbiB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4gYXdhaXQgZmFpbHVyZSgnYXV0aCcsICdQYW5lbDog0L3QtSDRg9C00LDQu9C+0YHRjCDQv9C+0LTRgtCy0LXRgNC00LjRgtGMINCy0YXQvtC0LiDQntGC0LrRgNC+0LnRgtC1IHBhbmVsLmhhdGlrby5ydSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIC8vIExhcmF2ZWwgaXNzdWVzIENTUkYgZXZlbiBmb3IgYW5vbnltb3VzIGxvZ2luIHBhZ2VzLiBDb25maXJtIGFjY2Vzc1xuICAgICAgICAgICAgLy8gdG8gYW4gYWN0dWFsIHByb3RlY3RlZCByZWFkLW9ubHkgQVBJIHdpdGggdGhlIHNhbWUgYnJvd3NlciBjb29raWVzLlxuICAgICAgICAgICAgY29uc3QgYXV0aCA9IGF3YWl0IGZldGNoKCdodHRwczovL3BhbmVsLmhhdGlrby5ydS9hcGkvc2VhcmNoL2ZpbHRlcnMnLCB7XG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnR0VUJywgaGVhZGVyczogeyBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJywgJ1gtUmVxdWVzdGVkLVdpdGgnOiAnWE1MSHR0cFJlcXVlc3QnIH0sXG4gICAgICAgICAgICAgICAgY3JlZGVudGlhbHM6ICdpbmNsdWRlJywgY2FjaGU6ICduby1zdG9yZScsIHJlZGlyZWN0OiAnZm9sbG93Jywgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBjb25zdCBhdXRoVXJsID0gbmV3IFVSTChhdXRoLnVybCB8fCAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvYXBpL3NlYXJjaC9maWx0ZXJzJyk7XG4gICAgICAgICAgICBpZiAoYXV0aC5zdGF0dXMgPCAyMDAgfHwgYXV0aC5zdGF0dXMgPj0gMzAwIHx8IGF1dGhVcmwub3JpZ2luICE9PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnXG4gICAgICAgICAgICAgICAgfHwgYXV0aFVybC5wYXRobmFtZSAhPT0gJy9hcGkvc2VhcmNoL2ZpbHRlcnMnIHx8ICEvYXBwbGljYXRpb25cXC9qc29uL2kudGVzdChhdXRoLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJykpIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKGF1dGguc3RhdHVzID49IDUwMCA/ICduZXR3b3JrJyA6ICdhdXRoJywgJ1BhbmVsOiDQvdC10YIg0LTQvtGB0YLRg9C/0LAg0LogQVBJLiDQntGC0LrRgNC+0LnRgtC1INCw0LLRgtC+0YDQuNC30L7QstCw0L3QvdGD0Y4gcGFuZWwuaGF0aWtvLnJ1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgcHJvb2YgPSBhd2FpdCBhdXRoLmpzb24oKTtcbiAgICAgICAgICAgIGlmICghcHJvb2YgfHwgdHlwZW9mIHByb29mICE9PSAnb2JqZWN0JyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBFcnJvcignSW52YWxpZCBQYW5lbCBhdXRoIHByb29mJyk7XG4gICAgICAgICAgICBwYW5lbFNlc3Npb24gPSB7IHRva2VuLCBzYXZlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdG9rZW4gfTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZmFpbHVyZSgnbmV0d29yaycsICdQYW5lbDog0L3QtSDRg9C00LDQu9C+0YHRjCDQv9GA0L7QstC10YDQuNGC0Ywg0LLRhdC+0LQuINCf0YDQvtCy0LXRgNGM0YLQtSDRgdC+0LXQtNC40L3QtdC90LjQtSDQuCDQvtGC0LrRgNGL0YLRg9GOINCy0LrQu9Cw0LTQutGDIHBhbmVsLmhhdGlrby5ydS4nKTtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICBpZiAoZm9yY2UpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID09PSBmbGlnaHQpIGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gZmxpZ2h0KSBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICB9XG4gICAgfSkoKTtcbiAgICBpZiAoZm9yY2UpIGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IGZsaWdodDtcbiAgICBlbHNlIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IGZsaWdodDtcbiAgICByZXR1cm4gZmxpZ2h0LnByb21pc2U7XG59XG5cbmZ1bmN0aW9uIGdldFBhbmVsU2Vzc2lvbihmb3JjZSkge1xuICAgIGlmIChmb3JjZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICBpZiAoZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0KSByZXR1cm4gZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7XG4gICAgaWYgKHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIGlmIChmb3JjZSAmJiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQpIHtcbiAgICAgICAgY29uc3QgcXVldWVkID0geyBwcm9taXNlOiBudWxsIH07XG4gICAgICAgIHF1ZXVlZC5wcm9taXNlID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlOyB9XG4gICAgICAgICAgICBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICBpZiAocXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID09PSBxdWV1ZWQpIHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQodHJ1ZSk7XG4gICAgICAgIH0pKCk7XG4gICAgICAgIHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IHF1ZXVlZDtcbiAgICAgICAgcmV0dXJuIHF1ZXVlZC5wcm9taXNlO1xuICAgIH1cbiAgICBpZiAoIWZvcmNlICYmIHBhbmVsU2Vzc2lvbiAmJiBEYXRlLm5vdygpIC0gcGFuZWxTZXNzaW9uLnNhdmVkQXQgPCBQQU5FTF9TRVNTSU9OX1RUTCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiB0cnVlLCB0b2tlbjogcGFuZWxTZXNzaW9uLnRva2VuIH0pO1xuICAgIGlmICghZm9yY2UgJiYgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0KSByZXR1cm4gbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7XG4gICAgcmV0dXJuIHN0YXJ0UGFuZWxTZXNzaW9uRmxpZ2h0KGZvcmNlKTtcbn1cbiIsIi8vIEV4dGVuc2lvbi1vd25lZCBwcmVzZW50YXRpb24uIE5vIHNpdGUgRE9NLCB0b2tlbnMsIG9yIGNvbnRlbnQtdGFiIGF1ZGlvLlxuY29uc3QgT1JERVJfTk9USUZJQ0FUSU9OX0lEID0gJ21lbWNoYXQtb3JkZXJzJztcbmNvbnN0IE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkgPSAnbWVtY2hhdC1vcmRlci1ub3RpZmljYXRpb24tZXhwaXJlJztcbmZ1bmN0aW9uIG9yZGVyQmVhckljb24oc2l6ZSkge1xuICAgIGNvbnN0IGNhbnZhcyA9IG5ldyBPZmZzY3JlZW5DYW52YXMoc2l6ZSwgc2l6ZSksIGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCcyZCcpLCBzID0gc2l6ZSAvIDMyO1xuICAgIGNvbnN0IG92YWwgPSAoeCwgeSwgcngsIHJ5LCBjb2xvcikgPT4geyBjdHguZmlsbFN0eWxlID0gY29sb3I7IGN0eC5iZWdpblBhdGgoKTsgY3R4LmVsbGlwc2UoeCAqIHMsIHkgKiBzLCByeCAqIHMsIHJ5ICogcywgMCwgMCwgTWF0aC5QSSAqIDIpOyBjdHguZmlsbCgpOyB9O1xuICAgIG92YWwoNywgNywgNiwgNiwgJyM3MTNmMmEnKTsgb3ZhbCgyNSwgNywgNiwgNiwgJyM3MTNmMmEnKTtcbiAgICBvdmFsKDcsIDcsIDMsIDMsICcjZDhhYTc4Jyk7IG92YWwoMjUsIDcsIDMsIDMsICcjZDhhYTc4Jyk7XG4gICAgb3ZhbCgxNiwgMTgsIDE0LCAxMywgJyM5ODYyM2InKTtcbiAgICBvdmFsKDE2LCAyNCwgOCwgNiwgJyNlZGM5OWInKTtcbiAgICBvdmFsKDEwLCAxNywgMiwgMi41LCAnIzIzMTUwZScpOyBvdmFsKDIyLCAxNywgMiwgMi41LCAnIzIzMTUwZScpO1xuICAgIG92YWwoMTYsIDIyLCAzLCAyLCAnIzIzMTUwZScpOyBvdmFsKDE2LCAyNiwgMiwgMSwgJyM3MTNmMmEnKTtcbiAgICByZXR1cm4gY3R4LmdldEltYWdlRGF0YSgwLCAwLCBzaXplLCBzaXplKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyVXBkYXRlSWNvbigpIHtcbiAgICBpZiAoIWNocm9tZS5hY3Rpb24/LnNldEljb24pIHJldHVybjtcbiAgICBjb25zdCBlbmFibGVkID0gb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgPT09IHRydWU7XG4gICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRJY29uKGVuYWJsZWQgPyB7IGltYWdlRGF0YTogeyAxNjogb3JkZXJCZWFySWNvbigxNiksIDMyOiBvcmRlckJlYXJJY29uKDMyKSB9IH0gOiB7IHBhdGg6ICdpY29uLnBuZycgfSk7XG4gICAgYXdhaXQgY2hyb21lLmFjdGlvbi5zZXRUaXRsZSh7IHRpdGxlOiBlbmFibGVkID8gJ/CfkLsg0J7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDQstC60LvRjtGH0ZHQvSDCtyDQntGC0LrRgNGL0YLRjCDQsdC+0LrQvtCy0YPRjiDQv9Cw0L3QtdC70YwgTWVtY2hhdCcgOiAn0J7RgtC60YDRi9GC0Ywg0JzQtdC80YfQsNGCINCyINCx0L7QutC+0LLQvtC5INC/0LDQvdC10LvQuCcgfSk7XG59XG5sZXQgb3JkZXJBdWRpb0NyZWF0aW5nID0gbnVsbDtcbmxldCBvcmRlckF1ZGlvR2VuZXJhdGlvbiA9IDA7XG5hc3luYyBmdW5jdGlvbiBvcmRlclN0b3BBdWRpbygpIHtcbiAgICBvcmRlckF1ZGlvR2VuZXJhdGlvbisrO1xuICAgIGlmICghY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMpIHJldHVybjtcbiAgICBjb25zdCBjb250ZXh0cyA9IGF3YWl0IGNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKHsgY29udGV4dFR5cGVzOiBbJ09GRlNDUkVFTl9ET0NVTUVOVCddLCBkb2N1bWVudFVybHM6IFtjaHJvbWUucnVudGltZS5nZXRVUkwoJ29mZnNjcmVlbi5odG1sJyldIH0pO1xuICAgIGlmIChjb250ZXh0cy5sZW5ndGgpIGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdGFyZ2V0OiAnbWVtY2hhdC1vZmZzY3JlZW4nLCB0eXBlOiAnbWVtY2hhdDphdWRpby1zdG9wJyB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyRW5zdXJlQXVkaW8oKSB7XG4gICAgaWYgKG9yZGVyQXVkaW9DcmVhdGluZykgcmV0dXJuIG9yZGVyQXVkaW9DcmVhdGluZztcbiAgICBvcmRlckF1ZGlvQ3JlYXRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBjb250ZXh0cyA9IGF3YWl0IGNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKHsgY29udGV4dFR5cGVzOiBbJ09GRlNDUkVFTl9ET0NVTUVOVCddLCBkb2N1bWVudFVybHM6IFtjaHJvbWUucnVudGltZS5nZXRVUkwoJ29mZnNjcmVlbi5odG1sJyldIH0pO1xuICAgICAgICBpZiAoIWNvbnRleHRzLmxlbmd0aCkgYXdhaXQgY2hyb21lLm9mZnNjcmVlbi5jcmVhdGVEb2N1bWVudCh7IHVybDogJ29mZnNjcmVlbi5odG1sJywgcmVhc29uczogWydBVURJT19QTEFZQkFDSyddLCBqdXN0aWZpY2F0aW9uOiAnT25lIHNoYXJlZCBNZW1jaGF0IG9yZGVyIGFsYXJtLCBpbmRlcGVuZGVudCBvZiBvcGVuIE1veVNrbGFkIHRhYnMuJyB9KTtcbiAgICB9KSgpLmZpbmFsbHkoKCkgPT4geyBvcmRlckF1ZGlvQ3JlYXRpbmcgPSBudWxsOyB9KTtcbiAgICByZXR1cm4gb3JkZXJBdWRpb0NyZWF0aW5nO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJQbGF5QXVkaW8oaXNDdXJyZW50ID0gKCkgPT4gdHJ1ZSkge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBvcmRlckF1ZGlvR2VuZXJhdGlvbjtcbiAgICBhd2FpdCBvcmRlckVuc3VyZUF1ZGlvKCk7XG4gICAgaWYgKCFpc0N1cnJlbnQoKSB8fCBnZW5lcmF0aW9uICE9PSBvcmRlckF1ZGlvR2VuZXJhdGlvbikgcmV0dXJuO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0YXJnZXQ6ICdtZW1jaGF0LW9mZnNjcmVlbicsIHR5cGU6ICdtZW1jaGF0OmF1ZGlvLXBsYXknIH0pO1xuICAgIGlmICghcmVzcG9uc2U/Lm9rKSB0aHJvdyBFcnJvcign0JfQstGD0Log0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C10L0nKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyUHJlc2VudFJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlcikge1xuICAgIGNvbnN0IGN1cnJlbnQgPSAoKSA9PiBjb25maWcgPT09IG9yZGVyQ29uZmlnICYmIGNvbmZpZy5zZXR0aW5ncy5lbmFibGVkICYmICFjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkO1xuICAgIGlmICghcmVzdWx0Lm9yZGVycy5sZW5ndGggfHwgIWN1cnJlbnQoKSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IG5vdGlmeSA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmdldFBlcm1pc3Npb25MZXZlbCgpO1xuICAgICAgICBpZiAoIWN1cnJlbnQoKSkgcmV0dXJuO1xuICAgICAgICBpZiAocGVybWlzc2lvbiAhPT0gJ2dyYW50ZWQnKSB0aHJvdyBFcnJvcign0KPQstC10LTQvtC80LvQtdC90LjRjyDQvtGC0LrQu9GO0YfQtdC90Ysg0LIg0LHRgNCw0YPQt9C10YDQtScpO1xuICAgICAgICBjb25zdCBvcmRlcnMgPSByZXN1bHQub3JkZXJzO1xuICAgICAgICBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5jcmVhdGUoT1JERVJfTk9USUZJQ0FUSU9OX0lELCB7IHR5cGU6ICdiYXNpYycsIGljb25Vcmw6ICdpY29uLnBuZycsXG4gICAgICAgICAgICB0aXRsZTogJ/CfkLsgTWVtY2hhdCDCtyDQl9Cw0LrQsNC30Ys6ICcgKyBvcmRlcnMubGVuZ3RoLFxuICAgICAgICAgICAgbWVzc2FnZTogb3JkZXJzLnNsaWNlKDAsIDMpLm1hcChpdGVtID0+IFN0cmluZyhpdGVtLm5hbWUpLnNsaWNlKDAsIDgwKSArICcgwrcgJyArIFN0cmluZyhpdGVtLm9yZ2FuaXphdGlvbk5hbWUpLnNsaWNlKDAsIDgwKSkuam9pbignXFxuJykgKyAocmVzdWx0LnBhcnRpYWwgPyAnXFxu4pqgINCe0L/RgNC+0YEg0L3QtdC/0L7Qu9C90YvQuScgOiAnJyksXG4gICAgICAgICAgICBwcmlvcml0eTogMCwgc2lsZW50OiB0cnVlLCByZXF1aXJlSW50ZXJhY3Rpb246IGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyA9PT0gMCB9KTtcbiAgICAgICAgaWYgKCFjdXJyZW50KCkpIHsgYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0lEKTsgcmV0dXJuOyB9XG4gICAgICAgIGlmIChjb25maWcuc2V0dGluZ3MudG9hc3REdXJhdGlvbk1pbnV0ZXMgPiAwKSBhd2FpdCBjaHJvbWUuYWxhcm1zLmNyZWF0ZShPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZLCB7IHdoZW46IERhdGUubm93KCkgKyBjb25maWcuc2V0dGluZ3MudG9hc3REdXJhdGlvbk1pbnV0ZXMgKiA2MDAwMCB9KTtcbiAgICAgICAgZWxzZSBhd2FpdCBjaHJvbWUuYWxhcm1zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkpO1xuICAgIH07XG4gICAgY29uc3QgdGFza3MgPSBbbm90aWZ5KCldO1xuICAgIGlmIChjb25maWcuc2V0dGluZ3Muc291bmRFbmFibGVkKSB0YXNrcy5wdXNoKG9yZGVyUGxheUF1ZGlvKGN1cnJlbnQpKTtcbiAgICBjb25zdCBvdXRjb21lcyA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZCh0YXNrcyk7XG4gICAgcmV0dXJuIG91dGNvbWVzLmZsYXRNYXAoKGl0ZW0sIGluZGV4KSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3JlamVjdGVkJyA/IFtpbmRleCA9PT0gMCA/ICfQodC40YHRgtC10LzQvdGL0LUg0YPQstC10LTQvtC80LvQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0L3RiycgOiAn0JfQstGD0Log0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C10L0nXSA6IFtdKTtcbn1cbmlmIChjaHJvbWUubm90aWZpY2F0aW9ucz8ub25DbGlja2VkKSBjaHJvbWUubm90aWZpY2F0aW9ucy5vbkNsaWNrZWQuYWRkTGlzdGVuZXIoaWQgPT4ge1xuICAgIGlmIChpZCAhPT0gT1JERVJfTk9USUZJQ0FUSU9OX0lEKSByZXR1cm47XG4gICAgY2hyb21lLnRhYnMuY3JlYXRlKHsgdXJsOiAnaHR0cHM6Ly9vbmxpbmUubW95c2tsYWQucnUvYXBwLyNjdXN0b21lcm9yZGVyJywgYWN0aXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihpZCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSkuY2F0Y2goKCkgPT4ge30pO1xufSk7XG4iLCIvLyBTaGFyZWQgb3JkZXIgcG9sbGluZyBpcyBpbmRlcGVuZGVudCBvZiB0aGUgbGlmZXRpbWUvbnVtYmVyIG9mIGNvbnRlbnQgdGFicy5cbi8vIFNlc3Npb24gc3RvcmFnZSBpcyBleHRlbnNpb24tcHJpdmF0ZTsgYmVhcmVyIG5ldmVyIGVudGVycyBhIGJyb2FkY2FzdCBvciBsb2dzLlxuY29uc3QgT1JERVJfU0VTU0lPTl9LRVkgPSAnbWVtY2hhdE9yZGVyU2VydmljZV92MSc7XG5sZXQgb3JkZXJDb25maWcgPSBudWxsO1xubGV0IG9yZGVyU3Vic2NyaWJlcnMgPSBuZXcgU2V0KCk7XG5sZXQgb3JkZXJSZXZpc2lvbiA9IDA7XG5sZXQgb3JkZXJGbGlnaHQgPSBudWxsO1xubGV0IG9yZGVyQ29udHJvbGxlciA9IG51bGw7XG5sZXQgb3JkZXJMYXN0UmVzdWx0ID0gbnVsbDtcbmxldCBvcmRlckNvbmZpZ0NoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5mdW5jdGlvbiBvcmRlck11dGF0ZShjYWxsYmFjaykge1xuICAgIGNvbnN0IG5leHQgPSBvcmRlckNvbmZpZ0NoYWluLnRoZW4oY2FsbGJhY2spO1xuICAgIG9yZGVyQ29uZmlnQ2hhaW4gPSBuZXh0LmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gbmV4dDtcbn1cbmNvbnN0IG9yZGVyUmVhZHkgPSAoYXN5bmMgKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KE9SREVSX1NFU1NJT05fS0VZKSlbT1JERVJfU0VTU0lPTl9LRVldO1xuICAgICAgICBpZiAoc2F2ZWQpIHsgb3JkZXJDb25maWcgPSBzYXZlZC5jb25maWc7IG9yZGVyUmV2aXNpb24gPSBzYXZlZC5yZXZpc2lvbiB8fCAwOyBvcmRlclN1YnNjcmliZXJzID0gbmV3IFNldChzYXZlZC5zdWJzY3JpYmVycyB8fCBbXSk7IH1cbiAgICAgICAgYXdhaXQgb3JkZXJVcGRhdGVJY29uKCk7XG4gICAgfSBjYXRjaCB7IC8qIENvbmZpZ3VyZSBtdXN0IHN1Y2Nlc3NmdWxseSBwZXJzaXN0IGJlZm9yZSBlbmFibGluZyBwb2xsaW5nLiAqLyB9XG59KSgpO1xuZnVuY3Rpb24gb3JkZXJQdWJsaWNDb25maWcoKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNldHRpbmdzOiBvcmRlckNvbmZpZz8uc2V0dGluZ3MsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uIH07XG59XG5mdW5jdGlvbiBvcmRlclJlZmVyZW5jZSh2YWx1ZSwga2luZCkge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIG5ldyBSZWdFeHAoJ15odHRwczovL2FwaVxcXFwubW95c2tsYWRcXFxcLnJ1L2FwaS9yZW1hcC8xXFxcXC4yL2VudGl0eS8nICsga2luZCArICcvW0EtWmEtejAtOS1dKyQnKS50ZXN0KHZhbHVlKTtcbn1cbmZ1bmN0aW9uIG9yZGVyU2V0dGluZ3MocmF3KSB7XG4gICAgY29uc3QgcmVmcyA9ICh2YWx1ZXMsIGtpbmQpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlcykgfHwgIXZhbHVlcy5ldmVyeSh2YWx1ZSA9PiBvcmRlclJlZmVyZW5jZSh2YWx1ZSwga2luZCkpKSB0aHJvdyBFcnJvcignSW52YWxpZCByZWZlcmVuY2VzJyk7XG4gICAgICAgIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMpXTtcbiAgICB9O1xuICAgIHJldHVybiB7IGVuYWJsZWQ6IHJhdz8uZW5hYmxlZCAhPT0gZmFsc2UsIHNvdW5kRW5hYmxlZDogcmF3Py5zb3VuZEVuYWJsZWQgIT09IGZhbHNlLFxuICAgICAgICBpbnRlcnZhbE1pbnV0ZXM6IE1hdGgubWluKDE0NDAsIE1hdGgubWF4KDEsIE1hdGgucm91bmQoTnVtYmVyKHJhdz8uaW50ZXJ2YWxNaW51dGVzKSB8fCAxKSkpLFxuICAgICAgICB0b2FzdER1cmF0aW9uTWludXRlczogTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChOdW1iZXIocmF3Py50b2FzdER1cmF0aW9uTWludXRlcykgfHwgMCkpKSxcbiAgICAgICAgb3JnYW5pemF0aW9uSHJlZnM6IHJlZnMocmF3Py5vcmdhbml6YXRpb25IcmVmcywgJ29yZ2FuaXphdGlvbicpLFxuICAgICAgICBzdGF0dXNIcmVmczogcmVmcyhyYXc/LnN0YXR1c0hyZWZzLCAnY3VzdG9tZXJvcmRlci9tZXRhZGF0YS9zdGF0ZXMnKSB9O1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJTZXRBbGFybSgpIHtcbiAgICBpZiAoIW9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkIHx8ICFvcmRlckNvbmZpZy5zZXR0aW5ncy5zb3VuZEVuYWJsZWQpIGF3YWl0IG9yZGVyU3RvcEF1ZGlvKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgJiYgY2hyb21lLm5vdGlmaWNhdGlvbnM/LmNsZWFyKSBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAvLyBUb29sYmFyIHByZXNlbnRhdGlvbiBtdXN0IG5ldmVyIHByZXZlbnQgc2NoZWR1bGluZyBvciBwYXVzaW5nIHRoZSBzZXJ2aWNlLlxuICAgIGF3YWl0IG9yZGVyVXBkYXRlSWNvbigpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBpZiAoIWNocm9tZS5hbGFybXMpIHJldHVybjtcbiAgICBpZiAoIW9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkKSBhd2FpdCBjaHJvbWUuYWxhcm1zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkpO1xuICAgIGlmIChvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCAmJiBvcmRlckNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggJiYgb3JkZXJDb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMubGVuZ3RoKSB7XG4gICAgICAgIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKCdtZW1jaGF0LW9yZGVycycsIHsgcGVyaW9kSW5NaW51dGVzOiBvcmRlckNvbmZpZy5zZXR0aW5ncy5pbnRlcnZhbE1pbnV0ZXMgfSk7XG4gICAgfSBlbHNlIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoJ21lbWNoYXQtb3JkZXJzJyk7XG59XG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVPcmRlcnMobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgYXdhaXQgb3JkZXJSZWFkeTtcbiAgICBpZiAodHlwZW9mIG1lc3NhZ2UudG9rZW4gIT09ICdzdHJpbmcnIHx8ICFtZXNzYWdlLnRva2VuLnRyaW0oKSB8fCBtZXNzYWdlLnRva2VuLmxlbmd0aCA+IDQwOTYpIHRocm93IEVycm9yKCdJbnZhbGlkIHRva2VuJyk7XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBvcmRlclNldHRpbmdzKG1lc3NhZ2Uuc2V0dGluZ3MpO1xuICAgIGNvbnN0IHVuY2hhbmdlZCA9IG9yZGVyQ29uZmlnPy50b2tlbiA9PT0gbWVzc2FnZS50b2tlbiAmJiBKU09OLnN0cmluZ2lmeShvcmRlckNvbmZpZy5zZXR0aW5ncykgPT09IEpTT04uc3RyaW5naWZ5KHNldHRpbmdzKTtcbiAgICBpZiAob3JkZXJDb25maWcgJiYgKG1lc3NhZ2UudXBkYXRlICE9PSB0cnVlIHx8IHVuY2hhbmdlZCkpIHtcbiAgICAgICAgaWYgKG9yZGVyQ29uZmlnLnRva2VuICE9PSBtZXNzYWdlLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uLCBlcnJvcjogJ9CU0YDRg9Cz0L7QuSBCZWFyZXIg0LIg0YTQvtC90LUuINCh0L7RhdGA0LDQvdC40YLQtSDQvdCw0YHRgtGA0L7QudC60Lgg0Y/QstC90L4g0LTQu9GPINGB0LzQtdC90Ysg0LDQutC60LDRg9C90YLQsC4nIH07XG4gICAgICAgIGlmIChzZW5kZXIudGFiKSBvcmRlclN1YnNjcmliZXJzLmFkZChzZW5kZXIudGFiLmlkKTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgIGlmIChjaHJvbWUuYWxhcm1zPy5nZXQgJiYgIShhd2FpdCBjaHJvbWUuYWxhcm1zLmdldCgnbWVtY2hhdC1vcmRlcnMnKSkpIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgcmV0dXJuIHsgLi4ub3JkZXJQdWJsaWNDb25maWcoKSwgcG9sbFJlcXVpcmVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAob3JkZXJDb25maWcgJiYgbWVzc2FnZS5yZXZpc2lvbiAhPT0gb3JkZXJSZXZpc2lvbikgcmV0dXJuIHsgLi4ub3JkZXJQdWJsaWNDb25maWcoKSwgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgZXJyb3I6ICfQndCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiyDQsiDQtNGA0YPQs9C+0Lkg0LLQutC70LDQtNC60LUuINCf0L7QstGC0L7RgNC40YLQtSDQuNC30LzQtdC90LXQvdC40LUuJyB9O1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3JkZXJDb25maWc/LnRva2VuID09PSBtZXNzYWdlLnRva2VuID8gbmV3IFNldChvcmRlclN1YnNjcmliZXJzKSA6IG5ldyBTZXQoKTtcbiAgICBpZiAoc2VuZGVyLnRhYikgc3Vic2NyaWJlcnMuYWRkKHNlbmRlci50YWIuaWQpO1xuICAgIGNvbnN0IGNvbmZpZyA9IHsgdG9rZW46IG1lc3NhZ2UudG9rZW4sIHNldHRpbmdzLCBvcmdhbml6YXRpb25zOiAoQXJyYXkuaXNBcnJheShtZXNzYWdlLm9yZ2FuaXphdGlvbnMpID8gbWVzc2FnZS5vcmdhbml6YXRpb25zIDogW10pXG4gICAgICAgIC5maWx0ZXIoaXRlbSA9PiBzZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5pbmNsdWRlcyhpdGVtPy5ocmVmKSkubWFwKGl0ZW0gPT4gKHsgaHJlZjogaXRlbS5ocmVmLCBuYW1lOiBTdHJpbmcoaXRlbS5uYW1lIHx8ICcnKS5zbGljZSgwLCAzMDApIH0pKSB9O1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWcsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uICsgMSwgc3Vic2NyaWJlcnM6IFsuLi5zdWJzY3JpYmVyc10gfSB9KTtcbiAgICBvcmRlckNvbnRyb2xsZXI/LmFib3J0KCk7XG4gICAgb3JkZXJDb25maWcgPSBjb25maWc7IG9yZGVyU3Vic2NyaWJlcnMgPSBzdWJzY3JpYmVyczsgb3JkZXJSZXZpc2lvbisrOyBvcmRlckxhc3RSZXN1bHQgPSBudWxsO1xuICAgIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBwb2xsUmVxdWlyZWQ6IHRydWUgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyR2V0KHBhdGgsIGNvbmZpZywgY29udHJvbGxlcikge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcGVyZm9ybVJlcXVlc3QoeyBpZDogJ2JhY2tncm91bmQtb3JkZXJzJywgcmVxdWVzdDoge1xuICAgICAgICB1cmw6ICdodHRwczovL2FwaS5tb3lza2xhZC5ydS9hcGkvcmVtYXAvMS4yJyArIHBhdGgsIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciAnICsgY29uZmlnLnRva2VuLCBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnIH0sXG4gICAgICAgIGFub255bW91czogdHJ1ZSwgYmFja2dyb3VuZE9yZGVyOiB0cnVlXG4gICAgfSB9LCB7IHRhYjogeyBpZDogLTEgfSwgZnJhbWVJZDogMCB9LCBjb250cm9sbGVyLnNpZ25hbCk7XG4gICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgdGhyb3cgRXJyb3IoJ0NhbmNlbGxlZCcpO1xuICAgIGlmIChyZXNwb25zZS5ldmVudCAhPT0gJ2xvYWQnKSB0aHJvdyBFcnJvcign0J7RiNC40LHQutCwINGB0L7QtdC00LjQvdC10L3QuNGPINGBINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICBjb25zdCBzdGF0dXMgPSByZXNwb25zZS5yZXNwb25zZS5zdGF0dXM7XG4gICAgaWYgKHN0YXR1cyA8IDIwMCB8fCBzdGF0dXMgPj0gMzAwKSB7IGNvbnN0IGVycm9yID0gRXJyb3IoJ9Cc0L7QudCh0LrQu9Cw0LQ6IEhUVFAgJyArIHN0YXR1cyk7IGVycm9yLnN0YXR1cyA9IHN0YXR1czsgdGhyb3cgZXJyb3I7IH1cbiAgICBsZXQgZGF0YTtcbiAgICB0cnkgeyBkYXRhID0gSlNPTi5wYXJzZShyZXNwb25zZS5yZXNwb25zZS5yZXNwb25zZVRleHQpOyB9IGNhdGNoIHsgdGhyb3cgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQvtGC0LLQtdGCINCc0L7QudCh0LrQu9Cw0LQnKTsgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhPy5yb3dzKSkgdGhyb3cgRXJyb3IoJ9Cd0LXQv9C+0LvQvdGL0Lkg0L7RgtCy0LXRgiDRgdC/0LjRgdC60LAg0LfQsNC60LDQt9C+0LInKTtcbiAgICByZXR1cm4gZGF0YTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGRlbGl2ZXJPcmRlclJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlciwgcmV2aXNpb24pIHtcbiAgICBpZiAoIWNocm9tZS50YWJzPy5xdWVyeSkgcmV0dXJuO1xuICAgIGNvbnN0IHRhYnMgPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7fSk7XG4gICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSB0YWJzLmZpbHRlcih0YWIgPT4gb3JkZXJTdWJzY3JpYmVycy5oYXModGFiLmlkKSAmJiB0cnVzdGVkQ29udGVudFNlbmRlcih7IGlkOiBjaHJvbWUucnVudGltZS5pZCwgdGFiLCBmcmFtZUlkOiAwLCB1cmw6IHRhYi51cmwgfSkpO1xuICAgIGNhbmRpZGF0ZXMuc29ydCgoYSwgYikgPT4gTnVtYmVyKCEhYi5hY3RpdmUpIC0gTnVtYmVyKCEhYS5hY3RpdmUpKTtcbiAgICBmb3IgKGNvbnN0IHRhYiBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgYWNrID0gYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0Om9yZGVycy1yZXN1bHQnLCByZXN1bHQsIHJldmlzaW9uLCBzZXR0aW5nczogY29uZmlnLnNldHRpbmdzIH0sIHsgZnJhbWVJZDogMCB9KTtcbiAgICAgICAgICAgIGlmIChhY2s/Lm9rKSByZXR1cm47XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBUcnkgYW5vdGhlciBsaXZlIGNvbnRlbnQgd29ybGQsIG5vdCBldmVyeSB0YWIuICovIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCBuYXRpdmUgb2YgbmF0aXZlUnVudGltZVNlc3Npb25zLnZhbHVlcygpKSB7XG4gICAgICAgIGlmIChuYXRpdmUub3JkZXJUb2tlbiAhPT0gY29uZmlnLnRva2VuIHx8IG5hdGl2ZS5vcmRlclJldmlzaW9uICE9PSByZXZpc2lvbiB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIGNvbnRpbnVlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFhd2FpdCBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KG5hdGl2ZS5zZW5kZXIsICdCZWFyZXIgJyArIGNvbmZpZy50b2tlbikpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgYWNrID0gYXdhaXQgbmF0aXZlUnVudGltZVJlcXVlc3QobmF0aXZlLCB7IHR5cGU6ICdtZW1jaGF0Om9yZGVycy1yZXN1bHQnLCByZXN1bHQsIHJldmlzaW9uLCBzZXR0aW5nczogY29uZmlnLnNldHRpbmdzIH0pO1xuICAgICAgICAgICAgaWYgKGFjaz8ub2spIHJldHVybjtcbiAgICAgICAgfSBjYXRjaCB7IC8qIEEgY2xvc2VkIG5hdGl2ZSBkb2N1bWVudCBpcyBub3QgYW5vdGhlciBzdWJzY3JpYmVyLiAqLyB9XG4gICAgfVxufVxuYXN5bmMgZnVuY3Rpb24gcG9sbE9yZGVycygpIHtcbiAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgIGF3YWl0IG9yZGVyQ29uZmlnQ2hhaW47XG4gICAgaWYgKG9yZGVyRmxpZ2h0KSByZXR1cm4gb3JkZXJGbGlnaHQ7XG4gICAgY29uc3QgY29uZmlnID0gb3JkZXJDb25maWc7XG4gICAgaWYgKCFjb25maWc/LnNldHRpbmdzLmVuYWJsZWQgfHwgIWNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggfHwgIWNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0YvQutC70Y7Rh9C10L0g0LjQu9C4INC90LUg0L3QsNGB0YLRgNC+0LXQvScgfTtcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCByZXZpc2lvbiA9IG9yZGVyUmV2aXNpb247XG4gICAgICAgIG9yZGVyQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XG4gICAgb3JkZXJGbGlnaHQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBmb3VuZCA9IG5ldyBNYXAoKSwgZmFpbGVkID0gW107XG4gICAgICAgIGxldCBhdXRoRmFpbGVkID0gZmFsc2U7XG4gICAgICAgIGZvciAoY29uc3QgaHJlZiBvZiBjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMpIHtcbiAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gY29uZmlnLm9yZ2FuaXphdGlvbnMuZmluZChpdGVtID0+IGl0ZW0uaHJlZiA9PT0gaHJlZik/Lm5hbWUgfHwgJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAnO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByb3dzID0gbmV3IE1hcCgpO1xuICAgICAgICAgICAgICAgIGxldCBvZmZzZXQgPSAwO1xuICAgICAgICAgICAgICAgIGZvciAoOzspIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZmlsdGVyID0gWydvcmdhbml6YXRpb249JyArIGhyZWYsIC4uLmNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5tYXAoc3RhdGUgPT4gJ3N0YXRlPScgKyBzdGF0ZSldLmpvaW4oJzsnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG9yZGVyR2V0KCcvZW50aXR5L2N1c3RvbWVyb3JkZXI/ZmlsdGVyPScgKyBlbmNvZGVVUklDb21wb25lbnQoZmlsdGVyKVxuICAgICAgICAgICAgICAgICAgICAgICAgKyAnJmV4cGFuZD1zdGF0ZSxvcmdhbml6YXRpb24mb3JkZXI9bW9tZW50LGRlc2MmbGltaXQ9MTAwJm9mZnNldD0nICsgb2Zmc2V0LCBjb25maWcsIGNvbnRyb2xsZXIpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IHJvd3Muc2l6ZTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2YgZGF0YS5yb3dzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIXJvdz8uaWQpIHRocm93IEVycm9yKCfQl9Cw0LrQsNC3INCx0LXQtyDQuNC00LXQvdGC0LjRhNC40LrQsNGC0L7RgNCwJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dzLnNldChyb3cuaWQsIHJvdyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgb2Zmc2V0ICs9IGRhdGEucm93cy5sZW5ndGg7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1vcmUgPSAhIWRhdGEubWV0YT8ubmV4dEhyZWYgfHwgKE51bWJlci5pc0Zpbml0ZShkYXRhLm1ldGE/LnNpemUpID8gb2Zmc2V0IDwgZGF0YS5tZXRhLnNpemUgOiBkYXRhLnJvd3MubGVuZ3RoID49IDEwMCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbW9yZSkgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZGF0YS5yb3dzLmxlbmd0aCB8fCByb3dzLnNpemUgPT09IHByZXZpb3VzKSB0aHJvdyBFcnJvcign0J/QsNCz0LjQvdCw0YbQuNGPINC30LDQutCw0LfQvtCyINC90LUg0L/RgNC+0LTQstC40LPQsNC10YLRgdGPJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZvciAoY29uc3Qgcm93IG9mIHJvd3MudmFsdWVzKCkpIGlmIChjb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMuaW5jbHVkZXMocm93LnN0YXRlPy5tZXRhPy5ocmVmKSkge1xuICAgICAgICAgICAgICAgICAgICBmb3VuZC5zZXQocm93LmlkLCB7IGlkOiByb3cuaWQsIG5hbWU6IHJvdy5uYW1lIHx8IHJvdy5pZCwgc3RhdGVOYW1lOiByb3cuc3RhdGU/Lm5hbWUgfHwgJ9Cd0L7QstGL0LknLCBvcmdhbml6YXRpb25OYW1lOiBsYWJlbCwgb3JnYW5pemF0aW9uSHJlZjogaHJlZiB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9OiDQvdCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiycgfTtcbiAgICAgICAgICAgICAgICBmYWlsZWQucHVzaChsYWJlbCArICcg4oCUICcgKyAoZXJyb3IubWVzc2FnZSB8fCAn0J7RiNC40LHQutCwINC30LDQv9GA0L7RgdCwJykpO1xuICAgICAgICAgICAgICAgIGlmIChbNDAxLCA0MDNdLmluY2x1ZGVzKGVycm9yLnN0YXR1cykpIHsgYXV0aEZhaWxlZCA9IHRydWU7IGJyZWFrOyB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L0nIH07XG4gICAgICAgIGlmIChhdXRoRmFpbGVkKSB7XG4gICAgICAgICAgICBhd2FpdCBvcmRlck11dGF0ZShhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGNvbmZpZy5zZXR0aW5ncy5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZywgcmV2aXNpb246ICsrb3JkZXJSZXZpc2lvbiwgc3Vic2NyaWJlcnM6IFsuLi5vcmRlclN1YnNjcmliZXJzXSB9IH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9JyB9O1xuICAgICAgICBjb25zdCByZXN1bHQgPSB7IGlkOiBTdHJpbmcoRGF0ZS5ub3coKSkgKyAnLScgKyBvcmRlclJldmlzaW9uLCBvcmRlcnM6IFsuLi5mb3VuZC52YWx1ZXMoKV0sIGZhaWxlZCwgcGFydGlhbDogZmFpbGVkLmxlbmd0aCA+IDAsXG4gICAgICAgICAgICBiZWFyZXI6IGF1dGhGYWlsZWQgPyAnZXJyb3InIDogZmFpbGVkLmxlbmd0aCA9PT0gY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCA/ICd1bmtub3duJyA6ICdvaycsIGF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgIHJlc3VsdC5vcmRlcnMuZm9yRWFjaChvcmRlciA9PiB7IG9yZGVyLnBhcnRpYWwgPSByZXN1bHQucGFydGlhbDsgfSk7XG4gICAgICAgIG9yZGVyTGFzdFJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgcmVzdWx0LmFsZXJ0V2FybmluZ3MgPSBhd2FpdCBvcmRlclByZXNlbnRSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIpO1xuICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvTog0L3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90YsnIH07XG4gICAgICAgIGF3YWl0IGRlbGl2ZXJPcmRlclJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlciwgcmV2aXNpb24pO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcmVzdWx0IH07XG4gICAgfSkoKS5maW5hbGx5KCgpID0+IHsgb3JkZXJGbGlnaHQgPSBudWxsOyBpZiAob3JkZXJDb250cm9sbGVyID09PSBjb250cm9sbGVyKSBvcmRlckNvbnRyb2xsZXIgPSBudWxsOyB9KTtcbiAgICByZXR1cm4gb3JkZXJGbGlnaHQ7XG59XG5pZiAoY2hyb21lLmFsYXJtcykgY2hyb21lLmFsYXJtcy5vbkFsYXJtLmFkZExpc3RlbmVyKGFsYXJtID0+IHtcbiAgICBpZiAoYWxhcm0ubmFtZSA9PT0gT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSkgcmV0dXJuIGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmIChhbGFybS5uYW1lID09PSAnbWVtY2hhdC1vcmRlcnMnKSByZXR1cm4gcG9sbE9yZGVycygpLmNhdGNoKCgpID0+IHt9KTtcbn0pO1xuIiwiLy8gTmF0aXZlIHJ1bnRpbWUgaWRlbnRpdGllcyBhcmUgcmVhbCBDaHJvbWUgTWVzc2FnZVNlbmRlcnMsIG5ldmVyIHN5bnRoZXRpYyB0YWJzLlxuLy8gQSBvbmUtdXNlIGNhcGFiaWxpdHksIGRlbGl2ZXJlZCBvbmx5IHRvIGEgdmVyaWZpZWQgU0lERV9QQU5FTCBkb2N1bWVudCwgYmluZHNcbi8vIGl0cyBjaGlsZCBwb3J0IHRvIG9uZSB3aW5kb3cvb3JpZ2luIGZvciBpdHMgZW50aXJlIGxpZmV0aW1lLlxuY29uc3QgbmF0aXZlUnVudGltZUlkZW50aXRpZXMgPSBuZXcgV2Vha01hcCgpO1xuY29uc3QgbmF0aXZlUnVudGltZVNlc3Npb25zID0gbmV3IE1hcCgpO1xuY29uc3QgbmF0aXZlUnVudGltZVRpY2tldHMgPSBuZXcgTWFwKCk7XG5sZXQgbmF0aXZlRHJhZnRDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgTkFUSVZFX0xBU1RfT1JJR0lOX0tFWSA9ICdtZW1jaGF0TmF0aXZlTGFzdE9yaWdpbl92MSc7XG5sZXQgbmF0aXZlU2VsZWN0aW9uQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmZ1bmN0aW9uIG5hdGl2ZVN1cHBvcnRlZE9yaWdpbihvcmlnaW4pIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKG9yaWdpbik7XG4gICAgICAgIHJldHVybiB1cmwub3JpZ2luID09PSBvcmlnaW4gJiYgdXJsLnByb3RvY29sID09PSAnaHR0cHM6JyAmJiAhdXJsLnBvcnQgJiYgIXVybC51c2VybmFtZSAmJiAhdXJsLnBhc3N3b3JkXG4gICAgICAgICAgICAmJiBNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcucGFnZU1hdGNoZXMuc29tZShwYXR0ZXJuID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBob3N0ID0gbmV3IFVSTChwYXR0ZXJuLnJlcGxhY2UoJyouJywgJ3dpbGRjYXJkLicpKS5ob3N0bmFtZS5yZXBsYWNlKCd3aWxkY2FyZC4nLCAnKi4nKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gaG9zdC5zdGFydHNXaXRoKCcqLicpID8gdXJsLmhvc3RuYW1lID09PSBob3N0LnNsaWNlKDIpIHx8IHVybC5ob3N0bmFtZS5lbmRzV2l0aCgnLicgKyBob3N0LnNsaWNlKDIpKSA6IHVybC5ob3N0bmFtZSA9PT0gaG9zdDtcbiAgICAgICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmZ1bmN0aW9uIG5hdGl2ZURvY3VtZW50VXJsKHJhdywgcXVlcnksIGhhc2gpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgICAgIHJldHVybiB1cmwub3JpZ2luID09PSBuZXcgVVJMKGNocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKSkub3JpZ2luICYmIHVybC5wYXRobmFtZSA9PT0gJy9vZmZzY3JlZW4uaHRtbCdcbiAgICAgICAgICAgICYmIHVybC5oYXNoID09PSAnIycgKyBoYXNoICYmIG5ldyBSZWdFeHAoJ15cXFxcPycgKyBxdWVyeSArICc9W2EtZjAtOS1dezM2fSQnKS50ZXN0KHVybC5zZWFyY2gpO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmNvbnN0IG5hdGl2ZVBhbmVsV2luZG93cyA9IG5ldyBNYXAoKTtcbmFzeW5jIGZ1bmN0aW9uIG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2VuZGVyLCB3aW5kb3dJZCkge1xuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcih3aW5kb3dJZCkgfHwgd2luZG93SWQgPCAwIHx8IHNlbmRlcj8uaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWIgfHwgc2VuZGVyLmZyYW1lSWQgIT09IHVuZGVmaW5lZCAmJiBzZW5kZXIuZnJhbWVJZCAhPT0gMFxuICAgICAgICB8fCAhbmF0aXZlRG9jdW1lbnRVcmwoc2VuZGVyLnVybCwgJ3BhbmVsJywgJ3NpZGViYXInKSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnU0lERV9QQU5FTCddLCBkb2N1bWVudFVybHM6IFtzZW5kZXIudXJsXSB9KTtcbiAgICBjb25zdCBjb250ZXh0ID0gY29udGV4dHMuZmluZChjb250ZXh0ID0+IGNvbnRleHQuY29udGV4dFR5cGUgPT09ICdTSURFX1BBTkVMJyAmJiBjb250ZXh0LmRvY3VtZW50VXJsID09PSBzZW5kZXIudXJsXG4gICAgICAgICYmICghc2VuZGVyLmRvY3VtZW50SWQgfHwgY29udGV4dC5kb2N1bWVudElkID09PSBzZW5kZXIuZG9jdW1lbnRJZCkpO1xuICAgIGlmICghY29udGV4dCkgeyBuYXRpdmVQYW5lbFdpbmRvd3MuZGVsZXRlKHNlbmRlci51cmwpOyByZXR1cm4gZmFsc2U7IH1cbiAgICAvLyBDaHJvbWUgcmVwb3J0cyB3aW5kb3dJZD0tMSBmb3IgYSBnbG9iYWwgU0lERV9QQU5FTCAob2JzZXJ2ZWQgaW4gQ2hyb21pdW0pLlxuICAgIC8vIE9ubHkgb3VyIHZlcmlmaWVkIG5hdGl2ZSBVSSBjYW4gZXN0YWJsaXNoIHRoaXMgZmlyc3QgYmluZGluZzsgaXQgb2J0YWluc1xuICAgIC8vIGl0cyB3aW5kb3cgdmlhIHdpbmRvd3MuZ2V0Q3VycmVudCgpLiBOZXZlciBsZXQgYSBkb2N1bWVudCByZXRhcmdldCBsYXRlci5cbiAgICBpZiAoY29udGV4dC53aW5kb3dJZCAhPT0gLTEgJiYgY29udGV4dC53aW5kb3dJZCAhPT0gd2luZG93SWQpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoIW5hdGl2ZVBhbmVsV2luZG93cy5oYXMoc2VuZGVyLnVybCkpIG5hdGl2ZVBhbmVsV2luZG93cy5zZXQoc2VuZGVyLnVybCwgd2luZG93SWQpO1xuICAgIHJldHVybiBuYXRpdmVQYW5lbFdpbmRvd3MuZ2V0KHNlbmRlci51cmwpID09PSB3aW5kb3dJZDtcbn1cbmFzeW5jIGZ1bmN0aW9uIG5hdGl2ZUxhc3RPcmlnaW4oKSB7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VSZWFkeTtcbiAgICBhd2FpdCBuYXRpdmVTZWxlY3Rpb25DaGFpbjtcbiAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTkFUSVZFX0xBU1RfT1JJR0lOX0tFWSkpW05BVElWRV9MQVNUX09SSUdJTl9LRVldO1xuICAgIHJldHVybiBuYXRpdmVTdXBwb3J0ZWRPcmlnaW4oc2F2ZWQpID8gc2F2ZWQgOiAnaHR0cHM6Ly9vbmxpbmUubW95c2tsYWQucnUnO1xufVxuZnVuY3Rpb24gbmF0aXZlUmVtZW1iZXJPcmlnaW4ob3JpZ2luKSB7XG4gICAgY29uc3Qgd29yayA9IG5hdGl2ZVNlbGVjdGlvbkNoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBpZiAoIW5hdGl2ZVN1cHBvcnRlZE9yaWdpbihvcmlnaW4pKSB0aHJvdyBFcnJvcignSW52YWxpZCBvcmlnaW4nKTtcbiAgICAgICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VSZWFkeTtcbiAgICAgICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTkFUSVZFX0xBU1RfT1JJR0lOX0tFWSkpW05BVElWRV9MQVNUX09SSUdJTl9LRVldID09PSBvcmlnaW4pIHJldHVybjtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW05BVElWRV9MQVNUX09SSUdJTl9LRVldOiBvcmlnaW4gfSk7XG4gICAgICAgIGlmICgoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KE5BVElWRV9MQVNUX09SSUdJTl9LRVkpKVtOQVRJVkVfTEFTVF9PUklHSU5fS0VZXSAhPT0gb3JpZ2luKSB0aHJvdyBFcnJvcignU2VsZWN0aW9uIG5vdCBkdXJhYmxlJyk7XG4gICAgfSk7XG4gICAgbmF0aXZlU2VsZWN0aW9uQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yaztcbn1cbmFzeW5jIGZ1bmN0aW9uIG5hdGl2ZVJ1bnRpbWVUaWNrZXQoc2VuZGVyLCB3aW5kb3dJZCwgb3JpZ2luKSB7XG4gICAgaWYgKCFuYXRpdmVTdXBwb3J0ZWRPcmlnaW4ob3JpZ2luKSB8fCAhYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIHdpbmRvd0lkKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbmF0aXZlIGlkZW50aXR5Jyk7XG4gICAgZm9yIChjb25zdCBbdGlja2V0LCBiaW5kaW5nXSBvZiBuYXRpdmVSdW50aW1lVGlja2V0cykgaWYgKGJpbmRpbmcuZXhwaXJlcyA8IERhdGUubm93KCkgfHwgYmluZGluZy5wYXJlbnQudXJsID09PSBzZW5kZXIudXJsICYmIGJpbmRpbmcub3JpZ2luID09PSBvcmlnaW4pIG5hdGl2ZVJ1bnRpbWVUaWNrZXRzLmRlbGV0ZSh0aWNrZXQpO1xuICAgIGNvbnN0IHRpY2tldCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgbmF0aXZlUnVudGltZVRpY2tldHMuc2V0KHRpY2tldCwgeyBwYXJlbnQ6IHNlbmRlciwgd2luZG93SWQsIG9yaWdpbiwgZXhwaXJlczogRGF0ZS5ub3coKSArIDE1MDAwIH0pO1xuICAgIHJldHVybiB0aWNrZXQ7XG59XG5mdW5jdGlvbiB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpIHsgcmV0dXJuIG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmhhcyhzZW5kZXIpOyB9XG5mdW5jdGlvbiBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcikge1xuICAgIGNvbnN0IG5hdGl2ZSA9IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmdldChzZW5kZXIpO1xuICAgIGlmIChuYXRpdmUpIHJldHVybiBuYXRpdmUub3JpZ2luO1xuICAgIGlmICh0eXBlb2YgdHJ1c3RlZENvbnRlbnRTZW5kZXIgPT09ICdmdW5jdGlvbicgJiYgdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSkgcmV0dXJuIG5ldyBVUkwoc2VuZGVyLnVybCkub3JpZ2luO1xuICAgIHRocm93IEVycm9yKCdVbmJvdW5kIHJ1bnRpbWUgaWRlbnRpdHknKTtcbn1cbi8vIFRyYWNrIGFjdHVhbCBmb2N1c2VkLXNpdGUgdXNlLCBub3QgcGVyaW9kaWMgc25hcHNob3RzIGZyb20gYSBiYWNrZ3JvdW5kIHdpbmRvdy5cbmxldCBuYXRpdmVGb2N1c0dlbmVyYXRpb24gPSAwO1xuYXN5bmMgZnVuY3Rpb24gbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3cod2luZG93SWQpIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gKytuYXRpdmVGb2N1c0dlbmVyYXRpb247XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgd2luZG93ID0gYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0KHdpbmRvd0lkKTtcbiAgICAgICAgaWYgKCF3aW5kb3cuZm9jdXNlZCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZCB9KTtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gPT09IG5hdGl2ZUZvY3VzR2VuZXJhdGlvbiAmJiBzdXBwb3J0ZWRBY3Rpb25UYWIodGFiKSkgYXdhaXQgbmF0aXZlUmVtZW1iZXJPcmlnaW4obmV3IFVSTCh0YWIudXJsKS5vcmlnaW4pO1xuICAgIH0gY2F0Y2ggeyAvKiBDbG9zZWQvdW5hdmFpbGFibGUgd2luZG93IG11c3Qgbm90IGNoYW5nZSB0aGUgc2F2ZWQgc2VsZWN0aW9uLiAqLyB9XG59XG5jaHJvbWUudGFicz8ub25BY3RpdmF0ZWQ/LmFkZExpc3RlbmVyKGluZm8gPT4geyB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KGluZm8ud2luZG93SWQpOyB9KTtcbmNocm9tZS50YWJzPy5vblVwZGF0ZWQ/LmFkZExpc3RlbmVyKChpZCwgY2hhbmdlLCB0YWIpID0+IHsgaWYgKHRhYi5hY3RpdmUgJiYgY2hhbmdlLnVybCkgdm9pZCBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyh0YWIud2luZG93SWQpOyB9KTtcbmNocm9tZS53aW5kb3dzPy5vbkZvY3VzQ2hhbmdlZD8uYWRkTGlzdGVuZXIod2luZG93SWQgPT4geyBpZiAod2luZG93SWQgPj0gMCkgdm9pZCBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyh3aW5kb3dJZCk7IGVsc2UgbmF0aXZlRm9jdXNHZW5lcmF0aW9uKys7IH0pO1xuaWYgKGNocm9tZS53aW5kb3dzPy5nZXRMYXN0Rm9jdXNlZCkgY2hyb21lLndpbmRvd3MuZ2V0TGFzdEZvY3VzZWQoKS50aGVuKHdpbmRvdyA9PiBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyh3aW5kb3cuaWQpLCAoKSA9PiB7fSk7XG5mdW5jdGlvbiBuYXRpdmVEcmFmdE1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmdldChzZW5kZXIpO1xuICAgIGlmICghc2Vzc2lvbiB8fCBzZXNzaW9uLmNsb3NlZCkgcmV0dXJuIFByb21pc2UucmVqZWN0KEVycm9yKCdVbmJvdW5kIHJ1bnRpbWUnKSk7XG4gICAgY29uc3Qga2V5ID0gJ21lbWNoYXROYXRpdmVEcmFmdF92MTonICsgc2Vzc2lvbi53aW5kb3dJZCArICc6JyArIHNlc3Npb24ub3JpZ2luO1xuICAgIGNvbnN0IHdvcmsgPSBuYXRpdmVEcmFmdENoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpuYXRpdmUtZHJhZnQtd3JpdGUnKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIG1lc3NhZ2UudmFsdWUgIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2UudmFsdWUubGVuZ3RoID4gMTAyNCAqIDEwMjQpIHRocm93IEVycm9yKCdJbnZhbGlkIGRyYWZ0Jyk7XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtrZXldOiBtZXNzYWdlLnZhbHVlIH0pO1xuICAgICAgICAgICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChrZXkpKVtrZXldICE9PSBtZXNzYWdlLnZhbHVlKSB0aHJvdyBFcnJvcignRHJhZnQgbm90IGR1cmFibGUnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB2YWx1ZSA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChrZXkpKVtrZXldO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyB2YWx1ZSA6ICcnIH07XG4gICAgfSk7XG4gICAgbmF0aXZlRHJhZnRDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrO1xufVxuZnVuY3Rpb24gbmF0aXZlUnVudGltZVNlc3Npb25LZXkocGFyZW50LCBvcmlnaW4pIHsgcmV0dXJuIHBhcmVudC51cmwgKyAnOicgKyBvcmlnaW47IH1cbmZ1bmN0aW9uIG5hdGl2ZVJ1bnRpbWVSZXF1ZXN0KHNlc3Npb24sIG1lc3NhZ2UpIHtcbiAgICBpZiAoc2Vzc2lvbi5jbG9zZWQpIHJldHVybiBQcm9taXNlLnJlamVjdChFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKSk7XG4gICAgY29uc3QgaWQgPSArK3Nlc3Npb24uc2VxdWVuY2U7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgc2Vzc2lvbi5wZW5kaW5nLmRlbGV0ZShpZCk7IHJlamVjdChFcnJvcignUnVudGltZSB0aW1lZCBvdXQnKSk7IH0sIDUwMDApO1xuICAgICAgICBzZXNzaW9uLnBlbmRpbmcuc2V0KGlkLCB7IHJlc29sdmUsIHJlamVjdCwgdGltZXIgfSk7XG4gICAgICAgIHRyeSB7IHNlc3Npb24ucG9ydC5wb3N0TWVzc2FnZSh7IGNhbGw6IGlkLCBtZXNzYWdlIH0pOyB9XG4gICAgICAgIGNhdGNoIHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2Vzc2lvbi5wZW5kaW5nLmRlbGV0ZShpZCk7IHJlamVjdChFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKSk7IH1cbiAgICB9KTtcbn1cbmZ1bmN0aW9uIG5hdGl2ZVJ1bnRpbWVOb3RpZnkoc2VuZGVyLCBtZXNzYWdlKSB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmdldChzZW5kZXIpO1xuICAgIGlmICghc2Vzc2lvbiB8fCBzZXNzaW9uLmNsb3NlZCkgdGhyb3cgRXJyb3IoJ1J1bnRpbWUgZGlzY29ubmVjdGVkJyk7XG4gICAgc2Vzc2lvbi5wb3J0LnBvc3RNZXNzYWdlKHsgbWVzc2FnZSB9KTtcbn1cbmNocm9tZS5ydW50aW1lLm9uQ29ubmVjdC5hZGRMaXN0ZW5lcihwb3J0ID0+IHtcbiAgICBpZiAocG9ydC5uYW1lICE9PSAnbWVtY2hhdC1uYXRpdmUtcnVudGltZScpIHJldHVybjtcbiAgICBjb25zdCBzZW5kZXIgPSBwb3J0LnNlbmRlcjtcbiAgICBpZiAoc2VuZGVyPy5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncnVudGltZScsICdydW50aW1lJykpIHsgcG9ydC5kaXNjb25uZWN0KCk7IHJldHVybjsgfVxuICAgIGxldCBzZXNzaW9uLCBiaW5kaW5nID0gZmFsc2UsIGRpc2Nvbm5lY3RlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBpZiAoIXNlc3Npb24gfHwgc2Vzc2lvbi5jbG9zZWQpIHJldHVybjtcbiAgICAgICAgc2Vzc2lvbi5jbG9zZWQgPSB0cnVlOyBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5kZWxldGUoc2VuZGVyKTtcbiAgICAgICAgaWYgKG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5nZXQoc2Vzc2lvbi5rZXkpID09PSBzZXNzaW9uKSBuYXRpdmVSdW50aW1lU2Vzc2lvbnMuZGVsZXRlKHNlc3Npb24ua2V5KTtcbiAgICAgICAgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUoJ25hdGl2ZTonICsgc2VuZGVyLnVybCk7XG4gICAgICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiBzZXNzaW9uLnBlbmRpbmcudmFsdWVzKCkpIHsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlamVjdChFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKSk7IH1cbiAgICAgICAgc2Vzc2lvbi5wZW5kaW5nLmNsZWFyKCk7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgcmVxdWVzdF0gb2YgcGVuZGluZ1JlcXVlc3RzKSBpZiAoa2V5LnN0YXJ0c1dpdGgoJ25hdGl2ZTonICsgc2VuZGVyLnVybCArICc6JykpIHsgcmVxdWVzdC5ldmVudCA9ICdhYm9ydCc7IHJlcXVlc3QuY29udHJvbGxlci5hYm9ydCgpOyB9XG4gICAgfTtcbiAgICBwb3J0Lm9uRGlzY29ubmVjdC5hZGRMaXN0ZW5lcihjbG9zZSk7XG4gICAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoYXN5bmMgcGFja2V0ID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgICAgICAgICAgIGlmIChiaW5kaW5nKSB0aHJvdyBFcnJvcignQWxyZWFkeSBiaW5kaW5nJyk7XG4gICAgICAgICAgICAgICAgYmluZGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29uc3QgY2FwYWJpbGl0eSA9IG5hdGl2ZVJ1bnRpbWVUaWNrZXRzLmdldChwYWNrZXQ/LnRpY2tldCk7XG4gICAgICAgICAgICAgICAgbmF0aXZlUnVudGltZVRpY2tldHMuZGVsZXRlKHBhY2tldD8udGlja2V0KTtcbiAgICAgICAgICAgICAgICBpZiAoIWNhcGFiaWxpdHkgfHwgY2FwYWJpbGl0eS5leHBpcmVzIDwgRGF0ZS5ub3coKSB8fCAhYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShjYXBhYmlsaXR5LnBhcmVudCwgY2FwYWJpbGl0eS53aW5kb3dJZCkgfHwgZGlzY29ubmVjdGVkKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgY2FwYWJpbGl0eScpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGtleSA9IG5hdGl2ZVJ1bnRpbWVTZXNzaW9uS2V5KGNhcGFiaWxpdHkucGFyZW50LCBjYXBhYmlsaXR5Lm9yaWdpbik7XG4gICAgICAgICAgICAgICAgaWYgKG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5oYXMoa2V5KSkgdGhyb3cgRXJyb3IoJ1J1bnRpbWUgYWxyZWFkeSBib3VuZCcpO1xuICAgICAgICAgICAgICAgIHNlc3Npb24gPSB7IC4uLmNhcGFiaWxpdHksIGtleSwgc2VuZGVyLCBwb3J0LCBwZW5kaW5nOiBuZXcgTWFwKCksIHNlcXVlbmNlOiAwLCBjbG9zZWQ6IGZhbHNlIH07XG4gICAgICAgICAgICAgICAgbmF0aXZlUnVudGltZUlkZW50aXRpZXMuc2V0KHNlbmRlciwgc2Vzc2lvbik7IG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5zZXQoa2V5LCBzZXNzaW9uKTtcbiAgICAgICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgcmVhZHk6IHRydWUgfSk7IHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChOdW1iZXIuaXNTYWZlSW50ZWdlcihwYWNrZXQ/LmFuc3dlcikpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwZW5kaW5nID0gc2Vzc2lvbi5wZW5kaW5nLmdldChwYWNrZXQuYW5zd2VyKTtcbiAgICAgICAgICAgICAgICBpZiAocGVuZGluZykgeyBzZXNzaW9uLnBlbmRpbmcuZGVsZXRlKHBhY2tldC5hbnN3ZXIpOyBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7IHBlbmRpbmcucmVzb2x2ZShwYWNrZXQucmVwbHkpOyB9XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihwYWNrZXQ/LmlkKSB8fCBwYWNrZXQuaWQgPCAxIHx8ICFwYWNrZXQubWVzc2FnZSB8fCBzZXNzaW9uLmNsb3NlZCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbmF0aXZlIHBhY2tldCcpO1xuICAgICAgICAgICAgLy8gQ2hlY2sgdGhlIHBhcmVudCBpcyBzdGlsbCBhIG5hdGl2ZSBkb2N1bWVudCBpbiB0aGUgYm91bmQgd2luZG93LlxuICAgICAgICAgICAgaWYgKCFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlc3Npb24ucGFyZW50LCBzZXNzaW9uLndpbmRvd0lkKSB8fCBzZXNzaW9uLmNsb3NlZCkgdGhyb3cgRXJyb3IoJ05hdGl2ZSBwYXJlbnQgY2xvc2VkJyk7XG4gICAgICAgICAgICBsZXQgYW5zd2VyZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IGhhbmRsZWQgPSBleHRlbnNpb25IYW5kbGVNZXNzYWdlKHBhY2tldC5tZXNzYWdlLCBzZW5kZXIsIHJlcGx5ID0+IHtcbiAgICAgICAgICAgICAgICBhbnN3ZXJlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKCFzZXNzaW9uLmNsb3NlZCkgcG9ydC5wb3N0TWVzc2FnZSh7IGlkOiBwYWNrZXQuaWQsIHJlcGx5IH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAoIWhhbmRsZWQgJiYgIWFuc3dlcmVkKSBwb3J0LnBvc3RNZXNzYWdlKHsgaWQ6IHBhY2tldC5pZCwgcmVwbHk6IHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQt9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH0gfSk7XG4gICAgICAgIH0gY2F0Y2ggeyBjbG9zZSgpOyB0cnkgeyBwb3J0LmRpc2Nvbm5lY3QoKTsgfSBjYXRjaCB7IC8qIEFscmVhZHkgZ29uZS4gKi8gfSB9XG4gICAgfSk7XG59KTtcbiIsIi8vIEV4YWN0LXBhbmVsIHByaXZhdGUgcG9ydDogbmV2ZXIgYnJvYWRjYXN0IGhpc3RvcnkgYW5kIG5ldmVyIHBlcnNpc3QgaXQuXG5jb25zdCBzaWRlYmFySGlzdG9yeU93bmVycyA9IG5ldyBNYXAoKTtcbmNvbnN0IFNJREVCQVJfQ0hBVF9NT0RFUyA9IG5ldyBTZXQoWydjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLCAnY2FsY3VsYXRvcicsXG4gICAgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJ10pO1xuZnVuY3Rpb24gc2lkZWJhckhpc3RvcnlUYXJnZXQoc2VuZGVyKSB7XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHJldHVybiAnbmF0aXZlOicgKyBzZW5kZXIudXJsO1xuICAgIGlmICh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSByZXR1cm4gJ3RhYjonICsgc2VuZGVyLnRhYi5pZDtcbiAgICByZXR1cm4gbnVsbDtcbn1cbmZ1bmN0aW9uIHNpZGViYXJIaXN0b3J5QmluZChwYXJlbnQsIHRhcmdldCwgZG9jdW1lbnRUb2tlbikge1xuICAgIGNvbnN0IG93bmVyID0gc2lkZWJhckhpc3RvcnlPd25lcnMuZ2V0KHBhcmVudC51cmwpO1xuICAgIGlmICghb3duZXIgfHwgIXRhcmdldCB8fCB0eXBlb2YgZG9jdW1lbnRUb2tlbiAhPT0gJ3N0cmluZycpIHJldHVybjtcbiAgICBvd25lci50YXJnZXRzLnNldCh0YXJnZXQsIGRvY3VtZW50VG9rZW4pO1xufVxuY2hyb21lLnJ1bnRpbWUub25Db25uZWN0LmFkZExpc3RlbmVyKHBvcnQgPT4ge1xuICAgIGlmIChwb3J0Lm5hbWUgIT09ICdtZW1jaGF0LXNpZGViYXItaGlzdG9yeScpIHJldHVybjtcbiAgICBjb25zdCBzZW5kZXIgPSBwb3J0LnNlbmRlcjtcbiAgICBsZXQgb3duZXIsIGRpc2Nvbm5lY3RlZCA9IGZhbHNlLCBiaW5kaW5nID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGlmICghb3duZXIpIHJldHVybjtcbiAgICAgICAgaWYgKHNpZGViYXJIaXN0b3J5T3duZXJzLmdldChzZW5kZXIudXJsKSA9PT0gb3duZXIpIHNpZGViYXJIaXN0b3J5T3duZXJzLmRlbGV0ZShzZW5kZXIudXJsKTtcbiAgICAgICAgZm9yIChjb25zdCBwZW5kaW5nIG9mIG93bmVyLnBlbmRpbmcudmFsdWVzKCkpIHsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlc29sdmUoeyBvazogZmFsc2UsIGNsb3NlZDogdHJ1ZSB9KTsgfVxuICAgICAgICBvd25lci5wZW5kaW5nLmNsZWFyKCk7IG93bmVyLnRhcmdldHMuY2xlYXIoKTtcbiAgICB9O1xuICAgIHBvcnQub25EaXNjb25uZWN0LmFkZExpc3RlbmVyKGNsb3NlKTtcbiAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyBtZXNzYWdlID0+IHtcbiAgICAgICAgaWYgKGRpc2Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFvd25lcikge1xuICAgICAgICAgICAgICAgIGlmIChiaW5kaW5nIHx8IG1lc3NhZ2U/LnR5cGUgIT09ICdiaW5kJykgdGhyb3cgRXJyb3IoJ0ludmFsaWQgaGlzdG9yeSBiaW5kaW5nJyk7XG4gICAgICAgICAgICAgICAgYmluZGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKCFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkgfHwgZGlzY29ubmVjdGVkKSB0aHJvdyBFcnJvcignSW52YWxpZCBwYW5lbCcpO1xuICAgICAgICAgICAgICAgIC8vIEEgcmVwbGFjZW1lbnQgcG9ydCBtYXkgbm90IGhpamFjayBhbiBleGlzdGluZyBjb252ZXJzYXRpb24uXG4gICAgICAgICAgICAgICAgaWYgKHNpZGViYXJIaXN0b3J5T3duZXJzLmhhcyhzZW5kZXIudXJsKSkgdGhyb3cgRXJyb3IoJ0FscmVhZHkgYm91bmQnKTtcbiAgICAgICAgICAgICAgICBvd25lciA9IHsgaWQ6IGNyeXB0by5yYW5kb21VVUlEKCksIHNlbmRlciwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQsIHBvcnQsIHRhcmdldHM6IG5ldyBNYXAoKSwgcGVuZGluZzogbmV3IE1hcCgpIH07XG4gICAgICAgICAgICAgICAgc2lkZWJhckhpc3RvcnlPd25lcnMuc2V0KHNlbmRlci51cmwsIG93bmVyKTtcbiAgICAgICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgcmVhZHk6IHRydWUsIG93bmVyOiBvd25lci5pZCB9KTsgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKG1lc3NhZ2U/LnR5cGUgIT09ICdhY2snIHx8IHR5cGVvZiBtZXNzYWdlLmlkICE9PSAnc3RyaW5nJykgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgcGVuZGluZyA9IG93bmVyLnBlbmRpbmcuZ2V0KG1lc3NhZ2UuaWQpO1xuICAgICAgICAgICAgaWYgKHBlbmRpbmcpIHsgb3duZXIucGVuZGluZy5kZWxldGUobWVzc2FnZS5pZCk7IGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVyKTsgcGVuZGluZy5yZXNvbHZlKHsgb2s6IHRydWUgfSk7IH1cbiAgICAgICAgfSBjYXRjaCB7IGNsb3NlKCk7IHRyeSB7IHBvcnQuZGlzY29ubmVjdCgpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBjbG9zZWQgKi8gfSB9XG4gICAgfSk7XG59KTtcbmZ1bmN0aW9uIHNpZGViYXJIaXN0b3J5TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIsIHJlcGx5KSB7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgIT09ICdtZW1jaGF0OmNoYXQtZXZlbnQnKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcnVuID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBzaWRlYmFySGlzdG9yeVRhcmdldChzZW5kZXIpO1xuICAgICAgICBjb25zdCBvd25lciA9IFsuLi5zaWRlYmFySGlzdG9yeU93bmVycy52YWx1ZXMoKV0uZmluZCh2YWx1ZSA9PiB2YWx1ZS5pZCA9PT0gbWVzc2FnZS5vd25lcik7XG4gICAgICAgIGlmICghb3duZXIpIHJldHVybiB7IG9rOiBmYWxzZSwgY2xvc2VkOiB0cnVlIH07XG4gICAgICAgIGlmICghdGFyZ2V0IHx8IG93bmVyLnRhcmdldHMuZ2V0KHRhcmdldCkgIT09IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbiB8fCAhYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShvd25lci5zZW5kZXIsIG93bmVyLndpbmRvd0lkKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGlmICghU0lERUJBUl9DSEFUX01PREVTLmhhcyhtZXNzYWdlLmFjdGlvbikgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1lc3NhZ2UuZXBvY2gpIHx8IG1lc3NhZ2UuZXBvY2ggPCAwXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtZjAtOS1dezM2fSQvLnRlc3QobWVzc2FnZS5pZClcbiAgICAgICAgICAgIHx8ICFbJ2FwcGVuZCcsICdjbGVhciddLmluY2x1ZGVzKG1lc3NhZ2Uub3BlcmF0aW9uKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGlmIChtZXNzYWdlLm9wZXJhdGlvbiA9PT0gJ2FwcGVuZCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gbWVzc2FnZS5lbnRyeTtcbiAgICAgICAgICAgIGlmICghZW50cnkgfHwgZW50cnkuYWN0aW9uICE9PSBtZXNzYWdlLmFjdGlvbiB8fCAhWyd1c2VyJywgJ2JvdCcsICdzeXN0ZW0nXS5pbmNsdWRlcyhlbnRyeS5zZW5kZXIpXG4gICAgICAgICAgICAgICAgfHwgIVsnbWVzc2FnZScsICdlbW9qaScsICd0aW1lc3RhbXAnLCAncXVlcnknXS5ldmVyeShrZXkgPT4gdHlwZW9mIGVudHJ5W2tleV0gPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgICAgIHx8IEpTT04uc3RyaW5naWZ5KGVudHJ5KS5sZW5ndGggPiAxMDI0ICogMTAyNCkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG93bmVyLnBlbmRpbmcuaGFzKG1lc3NhZ2UuaWQpIHx8IG93bmVyLnBlbmRpbmcuc2l6ZSA+PSAxMjgpIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBvd25lci5wZW5kaW5nLmRlbGV0ZShtZXNzYWdlLmlkKTsgcmVzb2x2ZSh7IG9rOiBmYWxzZSB9KTsgfSwgNTAwMCk7XG4gICAgICAgICAgICBvd25lci5wZW5kaW5nLnNldChtZXNzYWdlLmlkLCB7IHJlc29sdmUsIHRpbWVyIH0pO1xuICAgICAgICAgICAgdHJ5IHsgb3duZXIucG9ydC5wb3N0TWVzc2FnZSh7IGV2ZW50OiB7IGlkOiBtZXNzYWdlLmlkLCBvcGVyYXRpb246IG1lc3NhZ2Uub3BlcmF0aW9uLFxuICAgICAgICAgICAgICAgIGVwb2NoOiBtZXNzYWdlLmVwb2NoLCBhY3Rpb246IG1lc3NhZ2UuYWN0aW9uLCBlbnRyeTogbWVzc2FnZS5lbnRyeSB9IH0pOyB9XG4gICAgICAgICAgICBjYXRjaCB7IGNsZWFyVGltZW91dCh0aW1lcik7IG93bmVyLnBlbmRpbmcuZGVsZXRlKG1lc3NhZ2UuaWQpOyByZXNvbHZlKHsgb2s6IGZhbHNlLCBjbG9zZWQ6IHRydWUgfSk7IH1cbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBydW4oKS50aGVuKHJlcGx5LCAoKSA9PiByZXBseSh7IG9rOiBmYWxzZSB9KSk7IHJldHVybiB0cnVlO1xufVxuIiwiLy8gUHJpdmF0ZSBuYXRpdmUtdmlldyBjaGFubmVsLiBOZXZlciBicm9hZGNhc3QgdmlldyBkYXRhOiByZXBsaWVzIGdvIG9ubHkgdG8gdGhlXG4vLyBleGFjdCByZXF1ZXN0aW5nIG5hdGl2ZSBwYW5lbC4gU2l0ZS9hY2NvdW50IHN0YXRlIHN0YXlzIGluIGl0cyBjb250ZW50IHdvcmxkLlxuY29uc3QgU0lERUJBUl9GRUFUVVJFUyA9IE9iamVjdC5mcmVlemUoWydjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLCAndG9kYXknLCAndG9tb3Jyb3cnLFxuICAgICdjYWxjdWxhdG9yJywgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJywgJ2hhY2tlcicsICdzZXR0aW5ncyddKTtcbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJEaXNwYXRjaChtZXNzYWdlKSB7XG4gICAgY29uc3QgW3RhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQgfSk7XG4gICAgaWYgKCFzdXBwb3J0ZWRBY3Rpb25UYWIodGFiKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICd1bnN1cHBvcnRlZCcgfTtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnICYmIHRhYi5pZCAhPT0gbWVzc2FnZS50YWJJZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIGNvbnN0IGNvbW1hbmQgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItc3RhdHVzJ1xuICAgICAgICA/IHsgdHlwZTogJ21lbWNoYXQ6ZmVhdHVyZS1zdGF0dXMnIH0gOiB7IHR5cGU6ICdtZW1jaGF0Om9wZW4tZmVhdHVyZScsIGZlYXR1cmU6IG1lc3NhZ2UuZmVhdHVyZSB9O1xuICAgIGxldCByZXBseTtcbiAgICB0cnkgeyByZXBseSA9IGF3YWl0IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgY29tbWFuZCwgeyBmcmFtZUlkOiAwIH0pOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07IH1cbiAgICBpZiAoIXJlcGx5Py5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFsnc3RvcmFnZScsICdjb25mbGljdCddLmluY2x1ZGVzKHJlcGx5Py5yZWFzb24pID8gcmVwbHkucmVhc29uIDogJ2ZhaWxlZCcgfTtcbiAgICAvLyBOZXZlciBmb3J3YXJkIGFuIGFyYml0cmFyeSBjb250ZW50IHJlcGx5LCB0YWIgdGl0bGUsIFVSTCBwYXRoL3F1ZXJ5IG9yIHBlcnNpc3RlZCBkYXRhLlxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKHRhYi51cmwpLmhvc3RuYW1lIH07XG59XG4vLyBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSBoYXMgbm8gdGltZW91dCBvZiBpdHMgb3duOiBhIGZyb3plbiBiYWNrZ3JvdW5kIHRhYlxuLy8gKENocm9tZSBGcmVlemluZykgb3IgYSBzdHVjayBjb250ZW50IGhhbmRsZXIgd291bGQgaG9sZCB0aGUgcGFuZWwgdW50aWwgaXRzXG4vLyBvd24gOCBzIGRlYWRsaW5lIHdpdGggYSB2YWd1ZSB0aW1lb3V0LiBBbnN3ZXIgdGhlIHBhbmVsIGZpcnN0IGluc3RlYWQuXG5sZXQgU0lERUJBUl9WSUVXX0RFQURMSU5FX01TID0gNDAwMDtcbmZ1bmN0aW9uIHNpZGViYXJTZW5kVG9UYWIodGFiSWQsIG1lc3NhZ2UpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICd0aW1lb3V0JyB9KSwgU0lERUJBUl9WSUVXX0RFQURMSU5FX01TKTtcbiAgICAgICAgbGV0IHNlbnQ7XG4gICAgICAgIHRyeSB7IHNlbnQgPSBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgbWVzc2FnZSwgeyBmcmFtZUlkOiAwIH0pOyB9XG4gICAgICAgIGNhdGNoIHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgcmVzb2x2ZSh7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfSk7IHJldHVybjsgfVxuICAgICAgICAvLyBUaGVyZSBpcyBubyBBYm9ydENvbnRyb2xsZXIgZm9yIHNlbmRNZXNzYWdlLiBUaGUgbG9zaW5nIHByb21pc2Ugc3RpbGxcbiAgICAgICAgLy8gc2V0dGxlcyBsYXRlciwgc28gYm90aCBhIGxhdGUgcmVwbHkgYW5kIGEgbGF0ZSByZWplY3Rpb24gYXJlIGFic29yYmVkLlxuICAgICAgICBQcm9taXNlLnJlc29sdmUoc2VudCkudGhlbihyZXBseSA9PiByZXNvbHZlKHJlcGx5KSwgKCkgPT4gcmVzb2x2ZSh7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfSkpXG4gICAgICAgICAgICAuZmluYWxseSgoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpKTtcbiAgICB9KTtcbn1cbi8vIEEgcGFuZWwncyB0YXJnZXQgaXMgY2FwdHVyZWQgb25jZSBhbmQgdGhlbiByZWFkLCBuZXZlciByZWNvbXB1dGVkIGZyb20gdGhlXG4vLyBsaXZlIHRhYiBVUkw6IHt0YWJJZCwgd2luZG93SWQsIG9yaWdpbiwgc3VwcG9ydGVkfS4gVGhlIG9yaWdpbiAoYW5kIHdpdGggaXRcbi8vIHRoZSBwcml2YXRlIGJ1Y2tldCkgdGhlcmVmb3JlIHN0YXlzIHB1dCB3aGlsZSB0aGUgYm91bmQgdGFiIG5hdmlnYXRlcywgbG9zZXNcbi8vIGZvY3VzIG9yIGlzIHJlc3RvcmVkLiBPbmx5IGFuIGV4cGxpY2l0IChyZSliaW5kIChubyB0YWJJZCkgb3IgYSB0YWIvd2luZG93XG4vLyBtaXNtYXRjaCByZXdyaXRlcyBpdDsgbGl2ZW5lc3MgaXMgY2hlY2tlZCBzZXBhcmF0ZWx5LlxuLy8gTVYzIGtpbGxzIHRoZSB3b3JrZXIgYWZ0ZXIgaWRsZSB0aW1lLCBzbyB0aGUgTWFwIGFsb25lIHdvdWxkIHJlc3RvcmUgZnJvbSB0aGVcbi8vIGdsb2JhbCBsYXN0LW9yaWdpbiBndWVzcyBvbiB3YWtlLiBBIGNvcHkgcGVyIHBhbmVsIGRvY3VtZW50IGxpdmVzIGluXG4vLyBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uIChicm93c2VyIGxpZmV0aW1lLCBuZXZlciBkaXNrKSBhbmQgaXMgcmVhZCBiYWNrIGZpcnN0LlxuY29uc3QgU0lERUJBUl9CSU5ESU5HX0tFWSA9ICdtZW1jaGF0U2lkZWJhckJpbmRpbmdfdjEnO1xuY29uc3QgU0lERUJBUl9CSU5ESU5HX01BWF9BR0VfTVMgPSAyNCAqIDYwICogNjAgKiAxMDAwO1xuY29uc3Qgc2lkZWJhckJpbmRpbmdzID0gbmV3IE1hcCgpO1xubGV0IHNpZGViYXJCaW5kaW5nUmVjb3JkcyA9IG51bGw7XG5sZXQgc2lkZWJhckJpbmRpbmdDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdMb2FkKCkge1xuICAgIGlmIChzaWRlYmFyQmluZGluZ1JlY29yZHMpIHJldHVybiBzaWRlYmFyQmluZGluZ1JlY29yZHM7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoU0lERUJBUl9CSU5ESU5HX0tFWSkpW1NJREVCQVJfQklORElOR19LRVldO1xuICAgICAgICBzaWRlYmFyQmluZGluZ1JlY29yZHMgPSBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHNhdmVkKSA/IHNhdmVkIDoge307XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3NpZGViYXInLCBldmVudDogJ2JpbmRpbmctc3RvcmFnZScsIGRldGFpbDogeyByZWFzb246ICdyZWFkJyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdSZWNvcmRzID0ge307XG4gICAgfVxuICAgIHJldHVybiBzaWRlYmFyQmluZGluZ1JlY29yZHM7XG59XG5mdW5jdGlvbiBzaWRlYmFyQmluZGluZ1ZhbGlkKGJpbmRpbmcpIHtcbiAgICByZXR1cm4gISFiaW5kaW5nICYmIE51bWJlci5pc0ludGVnZXIoYmluZGluZy50YWJJZCkgJiYgYmluZGluZy50YWJJZCA+PSAwXG4gICAgICAgICYmIE51bWJlci5pc0ludGVnZXIoYmluZGluZy53aW5kb3dJZCkgJiYgYmluZGluZy53aW5kb3dJZCA+PSAwXG4gICAgICAgICYmIHR5cGVvZiBiaW5kaW5nLm9yaWdpbiA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIGJpbmRpbmcuc3VwcG9ydGVkID09PSAnYm9vbGVhbic7XG59XG4vLyBPbmUgb3duZXIsIG9uZSBhc3NpZ25tZW50OiBvbmx5IGFuIGV4cGxpY2l0IHJlYmluZCBvciBhIHBvc3Qtc2xlZXAgcmVidWlsZFxuLy8gd3JpdGVzLiBSZXdyaXRpbmcgYnkgcGFuZWwgVVJMIGJvdW5kcyB0aGUgcmVjb3JkIHNldDsgc3RhbGUgZW50cmllcyBhcmVcbi8vIGRyb3BwZWQgaGVyZSBpbnN0ZWFkIG9mIGJ5IGEgc2VwYXJhdGUgY29sbGVjdG9yLlxuZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdTYXZlKHBhbmVsVXJsLCBiaW5kaW5nKSB7XG4gICAgY29uc3Qgd29yayA9IHNpZGViYXJCaW5kaW5nQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBzaWRlYmFyQmluZGluZ0xvYWQoKTtcbiAgICAgICAgY29uc3QgY3V0b2ZmID0gRGF0ZS5ub3coKSAtIFNJREVCQVJfQklORElOR19NQVhfQUdFX01TO1xuICAgICAgICBjb25zdCBuZXh0ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZHMpKSB7XG4gICAgICAgICAgICBpZiAoa2V5ICE9PSBwYW5lbFVybCAmJiBzaWRlYmFyQmluZGluZ1ZhbGlkKHZhbHVlKSAmJiB0eXBlb2YgdmFsdWUuYXQgPT09ICdudW1iZXInICYmIHZhbHVlLmF0ID49IGN1dG9mZikgbmV4dFtrZXldID0gdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgbmV4dFtwYW5lbFVybF0gPSB7IHRhYklkOiBiaW5kaW5nLnRhYklkLCB3aW5kb3dJZDogYmluZGluZy53aW5kb3dJZCwgb3JpZ2luOiBiaW5kaW5nLm9yaWdpbixcbiAgICAgICAgICAgIHN1cHBvcnRlZDogYmluZGluZy5zdXBwb3J0ZWQsIGF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW1NJREVCQVJfQklORElOR19LRVldOiBuZXh0IH0pO1xuICAgICAgICBzaWRlYmFyQmluZGluZ1JlY29yZHMgPSBuZXh0O1xuICAgIH0pO1xuICAgIHNpZGViYXJCaW5kaW5nQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICAvLyBBIGZhaWxlZCB3cml0ZSBmYWxscyBiYWNrIHRvIHRoZSBpbi1tZW1vcnkgYmluZGluZyBmb3IgdGhpcyB3b3JrZXIncyBsaWZlLlxuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+IHtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1zdG9yYWdlJywgZGV0YWlsOiB7IHJlYXNvbjogJ3dyaXRlJyB9IH0sICd3b3JrZXInKTtcbiAgICB9KTtcbn1cbmZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsIHNvdXJjZSkge1xuICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnaW5mbycsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1jcmVhdGVkJywgZGV0YWlsOiB7XG4gICAgICAgIHRhYklkOiBiaW5kaW5nLnRhYklkLCBvcmlnaW46IGJpbmRpbmcub3JpZ2luLCBzdXBwb3J0ZWQ6IGJpbmRpbmcuc3VwcG9ydGVkLCBzb3VyY2VcbiAgICB9IH0sICd3b3JrZXInKTtcbn1cbmZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nTWlzbWF0Y2goZXhwZWN0ZWQsIGFjdHVhbCkge1xuICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnd2FybicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1taXNtYXRjaCcsIGRldGFpbDoge1xuICAgICAgICBleHBlY3RlZDogeyB0YWJJZDogZXhwZWN0ZWQudGFiSWQsIG9yaWdpbjogZXhwZWN0ZWQub3JpZ2luIH0sXG4gICAgICAgIGFjdHVhbDogeyB0YWJJZDogYWN0dWFsLnRhYklkLCB3aW5kb3dJZDogYWN0dWFsLndpbmRvd0lkIH1cbiAgICB9IH0sICd3b3JrZXInKTtcbn1cbmZ1bmN0aW9uIHNpZGViYXJEZWJ1Z0hvc3Qob3JpZ2luKSB7XG4gICAgdHJ5IHsgcmV0dXJuIHR5cGVvZiBvcmlnaW4gPT09ICdzdHJpbmcnID8gbmV3IFVSTChvcmlnaW4pLmhvc3RuYW1lIDogbnVsbDsgfVxuICAgIGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbn1cbi8vIEEgZmFpbGVkIHZpZXcgaXMgdGhlIHNpZ25hbCBhIHBhbmVsLW9ubHkgcmVwb3J0IHVzdWFsbHkgbGFja3M6IGtlZXAgdGhlIGV4YWN0XG4vLyByZWFzb24gYW5kIHdoaWNoIGNhcHR1cmVkIGJpbmRpbmcgcHJvZHVjZWQgaXQsIG5ldmVyIHBhZ2UgY29udGVudC5cbmZ1bmN0aW9uIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgcmVhc29uKSB7XG4gICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAndmlldy1mYWlsZWQnLCBkZXRhaWw6IHtcbiAgICAgICAgcmVhc29uLCB0YWJJZDogTnVtYmVyLmlzSW50ZWdlcihiaW5kaW5nPy50YWJJZCkgPyBiaW5kaW5nLnRhYklkIDogKE51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgPyBtZXNzYWdlLnRhYklkIDogbnVsbCksXG4gICAgICAgIHN1cHBvcnRlZDogYmluZGluZz8uc3VwcG9ydGVkID09PSB0cnVlLCBob3N0OiBzaWRlYmFyRGVidWdIb3N0KGJpbmRpbmc/Lm9yaWdpbilcbiAgICB9IH0sICd3b3JrZXInKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nRm9yKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBzaWRlYmFyQmluZGluZ3MuZ2V0KHNlbmRlci51cmwpO1xuICAgIGlmIChtZXNzYWdlLnRhYklkID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgW2FjdGl2ZV0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQgfSk7XG4gICAgICAgIGlmICghYWN0aXZlKSByZXR1cm4geyByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICBjb25zdCBzdXBwb3J0ZWQgPSBzdXBwb3J0ZWRBY3Rpb25UYWIoYWN0aXZlKTtcbiAgICAgICAgY29uc3Qgb3JpZ2luID0gc3VwcG9ydGVkID8gbmV3IFVSTChhY3RpdmUudXJsKS5vcmlnaW4gOiBhd2FpdCBuYXRpdmVMYXN0T3JpZ2luKCk7XG4gICAgICAgIGNvbnN0IGJpbmRpbmcgPSB7IHRhYklkOiBhY3RpdmUuaWQsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4sIHN1cHBvcnRlZCB9O1xuICAgICAgICBzaWRlYmFyQmluZGluZ3Muc2V0KHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgICAgICBzaWRlYmFyQmluZGluZ0xvZyhiaW5kaW5nLCAnZXhwbGljaXQnKTtcbiAgICAgICAgYXdhaXQgc2lkZWJhckJpbmRpbmdTYXZlKHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgICAgICByZXR1cm4geyBiaW5kaW5nIH07XG4gICAgfVxuICAgIGlmIChjdXJyZW50KSB7XG4gICAgICAgIC8vIFRoZSBiaW5kaW5nIGlzIGltbXV0YWJsZSBmb3IgaXRzIGxpZmU7IGEgcG9sbCBuYW1pbmcgYW5vdGhlciB0YWIgaXMgYVxuICAgICAgICAvLyBzdGFsZSBvciBmb3JlaWduIHJlcXVlc3QsIG5vdCBhIHJlYmluZC5cbiAgICAgICAgaWYgKGN1cnJlbnQudGFiSWQgIT09IG1lc3NhZ2UudGFiSWQgfHwgY3VycmVudC53aW5kb3dJZCAhPT0gbWVzc2FnZS53aW5kb3dJZCkge1xuICAgICAgICAgICAgc2lkZWJhckJpbmRpbmdNaXNtYXRjaChjdXJyZW50LCBtZXNzYWdlKTtcbiAgICAgICAgICAgIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgYmluZGluZzogY3VycmVudCB9O1xuICAgIH1cbiAgICAvLyBUaGUgd29ya2VyIHNsZXB0IG9yIHJlc3RhcnRlZC4gUmVhZCB0aGUgcGFuZWwncyBvd24gY2FwdHVyZWQgcmVjb3JkIGZyb21cbiAgICAvLyBzZXNzaW9uIHN0b3JhZ2UgZmlyc3Q6IHRoYXQgY29weSBpcyB0aGUgZml4IGZvciBhIHNpbGVudGx5IG1vdmluZyBwcml2YXRlXG4gICAgLy8gYnVja2V0LiBPbmx5IGEgcGFuZWwgd2l0aG91dCBhbnkgcmVjb3JkIGlzIHJlYnVpbHQgZnJvbSBsaXZlIHRhYiBzdGF0ZS5cbiAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBzaWRlYmFyQmluZGluZ0xvYWQoKSlbc2VuZGVyLnVybF07XG4gICAgaWYgKHNpZGViYXJCaW5kaW5nVmFsaWQoc2F2ZWQpICYmIHNhdmVkLndpbmRvd0lkID09PSBtZXNzYWdlLndpbmRvd0lkKSB7XG4gICAgICAgIGlmIChzYXZlZC50YWJJZCAhPT0gbWVzc2FnZS50YWJJZCkge1xuICAgICAgICAgICAgc2lkZWJhckJpbmRpbmdNaXNtYXRjaChzYXZlZCwgbWVzc2FnZSk7XG4gICAgICAgICAgICByZXR1cm4geyByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGJpbmRpbmcgPSB7IHRhYklkOiBzYXZlZC50YWJJZCwgd2luZG93SWQ6IHNhdmVkLndpbmRvd0lkLCBvcmlnaW46IHNhdmVkLm9yaWdpbiwgc3VwcG9ydGVkOiBzYXZlZC5zdXBwb3J0ZWQgfTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdzLnNldChzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdMb2coYmluZGluZywgJ3Nlc3Npb24nKTtcbiAgICAgICAgYXdhaXQgc2lkZWJhckJpbmRpbmdTYXZlKHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgICAgICByZXR1cm4geyBiaW5kaW5nIH07XG4gICAgfVxuICAgIGxldCB0YWI7XG4gICAgdHJ5IHsgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KG1lc3NhZ2UudGFiSWQpOyB9IGNhdGNoIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBudWxsLCAnY2xvc2VkJyk7XG4gICAgICAgIHJldHVybiB7IHJlYXNvbjogJ2Nsb3NlZCcgfTtcbiAgICB9XG4gICAgaWYgKHRhYi53aW5kb3dJZCAhPT0gbWVzc2FnZS53aW5kb3dJZCkge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIHsgdGFiSWQ6IHRhYi5pZCwgd2luZG93SWQ6IHRhYi53aW5kb3dJZCwgb3JpZ2luOiBudWxsLCBzdXBwb3J0ZWQ6IGZhbHNlIH0sICdjaGFuZ2VkJyk7XG4gICAgICAgIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgfVxuICAgIGNvbnN0IHN1cHBvcnRlZCA9IHN1cHBvcnRlZEFjdGlvblRhYih0YWIpO1xuICAgIGNvbnN0IG9yaWdpbiA9IHN1cHBvcnRlZCA/IG5ldyBVUkwodGFiLnVybCkub3JpZ2luIDogYXdhaXQgbmF0aXZlTGFzdE9yaWdpbigpO1xuICAgIGNvbnN0IGJpbmRpbmcgPSB7IHRhYklkOiB0YWIuaWQsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4sIHN1cHBvcnRlZCB9O1xuICAgIHNpZGViYXJCaW5kaW5ncy5zZXQoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgLy8gQSByZWNvdmVyZWQgYmluZGluZyB3YXMgcmVidWlsdCBhZnRlciB3b3JrZXIgc3VzcGVuc2lvbiB3aXRob3V0IGFueSBzYXZlZFxuICAgIC8vIHJlY29yZDsgdW5saWtlIGFuIGV4cGxpY2l0IHNlbGVjdGlvbiBpdCByZS1yZWFkcyBjdXJyZW50IHRhYiBzdGF0ZSwgd2hpY2hcbiAgICAvLyBpcyB0aGUgcmlza3kgY2FzZSBhbmQgc2hvdWxkIHN0YXkgcmFyZS5cbiAgICBzaWRlYmFyQmluZGluZ0xvZyhiaW5kaW5nLCAncmVjb3ZlcmVkJyk7XG4gICAgYXdhaXQgc2lkZWJhckJpbmRpbmdTYXZlKHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgIHJldHVybiB7IGJpbmRpbmcgfTtcbn1cbi8vIEF2YWlsYWJpbGl0eSBvbmx5OiB0aGUgdGFiIGV4aXN0cywgYmVsb25ncyB0byB0aGUgcGFuZWwncyB3aW5kb3cgYW5kIGlzIG5vdFxuLy8gZGlzY2FyZGVkL3VubG9hZGVkLiBXaGV0aGVyIHRoZSBwYWdlIGlzIGEgc3VwcG9ydGVkIHNpdGUgaXMgY2FwdHVyZWQgcG9saWN5IGluXG4vLyB0aGUgYmluZGluZywgbm90IGEgbGl2ZW5lc3MgdGVzdC5cbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJCb3VuZFRhYihtZXNzYWdlLCBiaW5kaW5nKSB7XG4gICAgbGV0IHRhYjtcbiAgICB0cnkgeyB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQoYmluZGluZy50YWJJZCk7IH0gY2F0Y2ggeyByZXR1cm4geyByZWFzb246ICdjbG9zZWQnIH07IH1cbiAgICBpZiAodGFiLndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkKSByZXR1cm4geyByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIGlmICh0YWIuc3RhdHVzID09PSAndW5sb2FkZWQnIHx8IHRhYi5kaXNjYXJkZWQgPT09IHRydWUpIHJldHVybiB7IHJlYXNvbjogJ21pc3NpbmcnIH07XG4gICAgcmV0dXJuIHsgdGFiIH07XG59XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyVmlld0Rpc3BhdGNoKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgc2lkZWJhckJpbmRpbmdGb3IobWVzc2FnZSwgc2VuZGVyKTtcbiAgICBpZiAoIXJlc29sdmVkLmJpbmRpbmcpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBudWxsLCByZXNvbHZlZC5yZWFzb24gfHwgJ2NoYW5nZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IHJlc29sdmVkLnJlYXNvbiB8fCAnY2hhbmdlZCcgfTtcbiAgICB9XG4gICAgY29uc3QgYmluZGluZyA9IHJlc29sdmVkLmJpbmRpbmc7XG4gICAgY29uc3QgYm91bmQgPSBhd2FpdCBzaWRlYmFyQm91bmRUYWIobWVzc2FnZSwgYmluZGluZyk7XG4gICAgaWYgKCFib3VuZC50YWIpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCBib3VuZC5yZWFzb24pO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogYm91bmQucmVhc29uIH07XG4gICAgfVxuICAgIGNvbnN0IHRhYiA9IGJvdW5kLnRhYjtcbiAgICBjb25zdCBvcmlnaW4gPSBiaW5kaW5nLm9yaWdpbjtcbiAgICAvLyBBIGNhcHR1cmVkIHN1cHBvcnRlZCBiaW5kaW5nIHdob3NlIHBhZ2UgaGFzIHNpbmNlIGxlZnQgdGhlIHN1cHBvcnRlZCBvcmlnaW5cbiAgICAvLyBsb3N0IGl0cyBjb250ZW50IHNjcmlwdC4gTmV2ZXIgc2lsZW50bHkgbW92ZSB0byB0aGUgZmFsbGJhY2sgcnVudGltZS9idWNrZXQ6XG4gICAgLy8gcmVwb3J0IHRoZSB0cmFuc2llbnQgbWlzc2luZyBzdGF0ZSBzbyB0aGUgcGFuZWwga2VlcHMgaXRzIHZpZXcgYW5kIGdvZXMgaW5lcnRcbiAgICAvLyB1bnRpbCB0aGUgdXNlciBleHBsaWNpdGx5IHJlYmluZHMuXG4gICAgaWYgKGJpbmRpbmcuc3VwcG9ydGVkICYmICghc3VwcG9ydGVkQWN0aW9uVGFiKHRhYikgfHwgbmV3IFVSTCh0YWIudXJsKS5vcmlnaW4gIT09IG9yaWdpbikpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCAnbWlzc2luZycpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07XG4gICAgfVxuICAgIC8vIFRoZSBoaXN0b3J5IGNoYW5uZWwgaXMgYSBwcml2YXRlIHBlci1wYW5lbCBzaW5rLCBuZXZlciBhIHByZWNvbmRpdGlvbiBmb3JcbiAgICAvLyByZW5kZXJpbmc6IGEgcGFuZWwgdGhhdCBsb3N0IGl0IHN0aWxsIHNob3dzIHRoZSB2aWV3IGFuZCByZXBvcnRzIGl0cyBvd25cbiAgICAvLyBoaXN0b3J5IGVycm9yLCBleGFjdGx5IGFzIGEgbWlzc2luZyBjcmVkZW50aWFscyBwYXRoIG11c3Qgc3RheSBmYWlsLWNsb3NlZFxuICAgIC8vIGZvciBzdG9yYWdlIGFsb25lLlxuICAgIGNvbnN0IGhpc3RvcnkgPSBzaWRlYmFySGlzdG9yeU93bmVycy5nZXQoc2VuZGVyLnVybCk7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3J1xuICAgICAgICA/IHsgdHlwZTogJ21lbWNoYXQ6dmlldy1zbmFwc2hvdCcgfVxuICAgICAgICA6IHsgdHlwZTogJ21lbWNoYXQ6dmlldy1ldmVudCcsIGRvY3VtZW50VG9rZW46IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbixcbiAgICAgICAgICAgIGtleTogbWVzc2FnZS5rZXksIGV2ZW50OiBtZXNzYWdlLmV2ZW50LCB2YWx1ZTogbWVzc2FnZS52YWx1ZSxcbiAgICAgICAgICAgIGNoZWNrZWQ6IG1lc3NhZ2UuY2hlY2tlZCwgc2VsZWN0ZWQ6IG1lc3NhZ2Uuc2VsZWN0ZWQsXG4gICAgICAgICAgICAuLi4obWVzc2FnZS5ldmVudCA9PT0gJ2VudGVyJyA/IHsgZXZlbnRJZDogbWVzc2FnZS5ldmVudElkIH0gOiB7fSkgfTtcbiAgICAvLyBGb3J3YXJkIHRoZSBwYW5lbCdzIEVUYWcgb25seSBvbiBzbmFwc2hvdCBwb2xsczsgZXZlbnRzIGFsd2F5cyBuZWVkIHRoZVxuICAgIC8vIGZ1bGwgdmlldy4gVW5rbm93biBmaWVsZHMgc3RheSBhYnNlbnQgc28gb2xkIGNvbnRlbnQgd29ybGRzIHNlZSBhblxuICAgIC8vIG9yZGluYXJ5IHJlcXVlc3QuXG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JyAmJiB0eXBlb2YgbWVzc2FnZS5rbm93bkhhc2ggPT09ICdzdHJpbmcnKSByZXF1ZXN0Lmtub3duSGFzaCA9IG1lc3NhZ2Uua25vd25IYXNoO1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgdHlwZW9mIG1lc3NhZ2Uua25vd25Eb2N1bWVudFRva2VuID09PSAnc3RyaW5nJykgcmVxdWVzdC5rbm93bkRvY3VtZW50VG9rZW4gPSBtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbjtcbiAgICAvLyBUaGUgcGFuZWwncyBjaGF0IG1lbW9yeSBpcyBhZGRyZXNzZWQgYnkgb3duZXIgaWQgcGx1cyB0aGUgZXhhY3QgZG9jdW1lbnRcbiAgICAvLyB0b2tlbiB0aGF0IHdpbGwgYW5zd2VyIGl0OyBhIHJld3JpdHRlbiBlcG9jaCBtYXAgY2FuIG5laXRoZXIgbW92ZSBhblxuICAgIC8vIGFuc3dlciBpbnRvIGFub3RoZXIgbW9kZSBub3IgcmV2aXZlIGEgY2xlYXJlZCBoaXN0b3J5LlxuICAgIGlmIChoaXN0b3J5KSB7XG4gICAgICAgIHJlcXVlc3QuaGlzdG9yeU93bmVyID0gaGlzdG9yeS5pZDtcbiAgICAgICAgcmVxdWVzdC5jaGF0TW9kZSA9IFNJREVCQVJfRkVBVFVSRVMuaW5jbHVkZXMobWVzc2FnZS5jaGF0TW9kZSkgPyBtZXNzYWdlLmNoYXRNb2RlIDogbnVsbDtcbiAgICAgICAgcmVxdWVzdC5jaGF0RXBvY2hzID0gT2JqZWN0LmZyb21FbnRyaWVzKFsuLi5TSURFQkFSX0NIQVRfTU9ERVNdLm1hcChtb2RlID0+XG4gICAgICAgICAgICBbbW9kZSwgTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5jaGF0RXBvY2hzPy5bbW9kZV0pICYmIG1lc3NhZ2UuY2hhdEVwb2Noc1ttb2RlXSA+PSAwID8gbWVzc2FnZS5jaGF0RXBvY2hzW21vZGVdIDogMF0pKTtcbiAgICB9XG4gICAgbGV0IGhpc3RvcnlUYXJnZXQ7XG4gICAgbGV0IHZpZXc7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGJpbmRpbmcuc3VwcG9ydGVkKSB7IGhpc3RvcnlUYXJnZXQgPSAndGFiOicgKyB0YWIuaWQ7IHZpZXcgPSBhd2FpdCBzaWRlYmFyU2VuZFRvVGFiKHRhYi5pZCwgcmVxdWVzdCk7IH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZVNlc3Npb25zLmdldChuYXRpdmVSdW50aW1lU2Vzc2lvbktleShzZW5kZXIsIG9yaWdpbikpO1xuICAgICAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHJ1bnRpbWU6IHsgb3JpZ2luLCB0aWNrZXQ6IGF3YWl0IG5hdGl2ZVJ1bnRpbWVUaWNrZXQoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4pIH0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGhpc3RvcnlUYXJnZXQgPSAnbmF0aXZlOicgKyBzZXNzaW9uLnNlbmRlci51cmw7XG4gICAgICAgICAgICB2aWV3ID0gYXdhaXQgbmF0aXZlUnVudGltZVJlcXVlc3Qoc2Vzc2lvbiwgcmVxdWVzdCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCAnbWlzc2luZycpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07XG4gICAgfVxuICAgIC8vIFRoZSBib3VuZCB0YWIgaXRzZWxmIG11c3Qgc3RpbGwgZXhpc3QgaW4gdGhlIHBhbmVsJ3Mgd2luZG93OyBuZXZlciByZS10YXJnZXRcbiAgICAvLyB0byB3aGF0ZXZlciBoYXBwZW5zIHRvIGJlIGFjdGl2ZS4gVGhlIGNvbnRlbnQgZG9jdW1lbnRUb2tlbiBzdGlsbCBwaW5zIGV2ZW50cy5cbiAgICBsZXQgYWxpdmU7XG4gICAgdHJ5IHsgYWxpdmUgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiLmlkKTsgfSBjYXRjaCB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgJ2Nsb3NlZCcpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2Nsb3NlZCcgfTtcbiAgICB9XG4gICAgaWYgKGFsaXZlLndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCAnY2hhbmdlZCcpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgfVxuICAgIGlmICghdmlldz8ub2spIHtcbiAgICAgICAgY29uc3QgcmVhc29uID0gWydzdG9yYWdlJywgJ2NvbmZsaWN0JywgJ2NoYW5nZWQnLCAndGltZW91dCcsICd0b28tbGFyZ2UnXS5pbmNsdWRlcyh2aWV3Py5yZWFzb24pID8gdmlldy5yZWFzb24gOiAnZmFpbGVkJztcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCByZWFzb24pO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbiB9O1xuICAgIH1cbiAgICAvLyBPbmx5IGEgZmlyc3QgYmluZGluZyBvciBhbiBldmVudCBmcm9tIHRoZSB2aXNpYmxlIGJvdW5kIHRhYiByZWNvcmRzIHRoZVxuICAgIC8vIHNlbGVjdGlvbjsgYSBiYWNrZ3JvdW5kIHBvbGwgb2YgYSBub24tYWN0aXZlIHRhYiBtdXN0IG5vdCBvdmVyd3JpdGUgaXQuXG4gICAgY29uc3QgYWN0aXZlQm91bmQgPSBtZXNzYWdlLnRhYklkID09PSB1bmRlZmluZWQgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1ldmVudCdcbiAgICAgICAgJiYgKGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KSlbMF0/LmlkID09PSB0YWIuaWQpO1xuICAgIGlmIChiaW5kaW5nLnN1cHBvcnRlZCAmJiBhY3RpdmVCb3VuZCAmJiAoYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0KG1lc3NhZ2Uud2luZG93SWQpKS5mb2N1c2VkKSBhd2FpdCBuYXRpdmVSZW1lbWJlck9yaWdpbihvcmlnaW4pO1xuICAgIC8vIE9ubHkgYSB2aWV3IHRoYXQgcmVhbGx5IGFuc3dlcmVkIG1heSBiZWNvbWUgdGhlIHRhcmdldCBvZiB0aGlzIHBhbmVsJ3NcbiAgICAvLyBjaGF0IHNpbms7IGEgcmVmdXNlZCByZXF1ZXN0IG11c3Qgbm90IGJpbmQgYSBkb2N1bWVudCB0aGF0IG5ldmVyIHJlbmRlcmVkLlxuICAgIGlmIChoaXN0b3J5KSBzaWRlYmFySGlzdG9yeUJpbmQoc2VuZGVyLCBoaXN0b3J5VGFyZ2V0LCB2aWV3LmRvY3VtZW50VG9rZW4pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUsIG5hdGl2ZTogIWJpbmRpbmcuc3VwcG9ydGVkLCB2aWV3IH07XG59XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gICAgaWYgKCFbJ21lbWNoYXQ6c2lkZWJhci1zdGF0dXMnLCAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnLCAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnLCAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50J10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoc2VuZGVyLmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCBzZW5kZXIudGFiIHx8IChzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwKVxuICAgICAgICB8fCAhbmF0aXZlRG9jdW1lbnRVcmwoc2VuZGVyLnVybCwgJ3BhbmVsJywgJ3NpZGViYXInKVxuICAgICAgICB8fCAhTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLndpbmRvd0lkKSB8fCBtZXNzYWdlLndpbmRvd0lkIDwgMFxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnICYmICghTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSB8fCBtZXNzYWdlLnRhYklkIDwgMFxuICAgICAgICAgICAgfHwgIVNJREVCQVJfRkVBVFVSRVMuaW5jbHVkZXMobWVzc2FnZS5mZWF0dXJlKSkpXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgbWVzc2FnZS50YWJJZCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSB8fCBtZXNzYWdlLnRhYklkIDwgMCkpXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgKChtZXNzYWdlLmtub3duSGFzaCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAmJiAodHlwZW9mIG1lc3NhZ2Uua25vd25IYXNoICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLmtub3duSGFzaC5sZW5ndGggPiA2NCkpXG4gICAgICAgICAgICB8fCAobWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW4gIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgJiYgKHR5cGVvZiBtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbiAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW4ubGVuZ3RoID4gMTAwKSkpKVxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50JyAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmRvY3VtZW50VG9rZW4gIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbi5sZW5ndGggPiAxMDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmtleSAhPT0gJ3N0cmluZycgfHwgIS9eXFxkezEsOH0kLy50ZXN0KG1lc3NhZ2Uua2V5KVxuICAgICAgICAgICAgfHwgIVsnY2xpY2snLCAnaW5wdXQnLCAnY2hhbmdlJywgJ2VudGVyJ10uaW5jbHVkZXMobWVzc2FnZS5ldmVudClcbiAgICAgICAgICAgIHx8IChtZXNzYWdlLmV2ZW50ID09PSAnZW50ZXInICYmICh0eXBlb2YgbWVzc2FnZS5ldmVudElkICE9PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgIHx8ICEvXlthLWYwLTktXXsxLDY0fSQvLnRlc3QobWVzc2FnZS5ldmVudElkKSkpKSkpIHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdpbnZhbGlkJyB9KTsgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkudGhlbih2YWxpZCA9PiB2YWxpZFxuICAgICAgICA/IChbJ21lbWNoYXQ6c2lkZWJhci12aWV3JywgJ21lbWNoYXQ6c2lkZWJhci1ldmVudCddLmluY2x1ZGVzKG1lc3NhZ2UudHlwZSlcbiAgICAgICAgICAgID8gc2lkZWJhclZpZXdEaXNwYXRjaChtZXNzYWdlLCBzZW5kZXIpIDogc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpKVxuICAgICAgICA6IHsgb2s6IGZhbHNlLCByZWFzb246ICdpbnZhbGlkJyB9KS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdmYWlsZWQnIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn0pO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBUaGUgcGFuZWwgaXMgYSB2ZXJpZmllZCBTSURFX1BBTkVMIGRvY3VtZW50OyBpdCBoYXMgbm8gdGFiIGFuZCBubyBzdWJmcmFtZS5cbmZ1bmN0aW9uIGRlYnVnUGFuZWxTZW5kZXIoc2VuZGVyKSB7XG4gICAgcmV0dXJuIHNlbmRlcj8uaWQgPT09IGNocm9tZS5ydW50aW1lLmlkICYmICFzZW5kZXIudGFiXG4gICAgICAgICYmIChzZW5kZXIuZnJhbWVJZCA9PT0gdW5kZWZpbmVkIHx8IHNlbmRlci5mcmFtZUlkID09PSAwKVxuICAgICAgICAmJiBuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpO1xufVxuZnVuY3Rpb24gZGVidWdXb3JsZEZvcihzZW5kZXIsIHBhbmVsKSB7XG4gICAgaWYgKHBhbmVsKSByZXR1cm4gJ3BhbmVsJztcbiAgICBpZiAodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICdjb250ZW50JztcbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICdydW50aW1lJztcbiAgICByZXR1cm4gJ3dvcmtlcic7XG59XG5hc3luYyBmdW5jdGlvbiBkZWJ1Z01lc3NhZ2UobWVzc2FnZSwgc2VuZGVyLCBwYW5lbCkge1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OmRlYnVnLWZsYWcnKSB7XG4gICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZS5lbmFibGVkICE9PSAnYm9vbGVhbicpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LbRg9GA0L3QsNC7INGA0LDRgdGI0LjRgNC10L3QuNGPJyB9O1xuICAgICAgICAvLyBtZW1jaGF0RGVidWdTZXRFbmFibGVkIHJldHVybnMgd2hldGhlciB0aGUgd3JpdGUgdmVyaWZpZWQsIG5vdCB0aGUgdmFsdWUuXG4gICAgICAgIC8vIFJlYWQgdGhlIHBlcnNpc3RlZCBmbGFnIGJhY2sgc28gdHVybmluZyB0aGUgbG9nIE9GRiBpcyBhbHNvIGNvbmZpcm1lZC5cbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdTZXRFbmFibGVkKG1lc3NhZ2UuZW5hYmxlZCk7XG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdFbmFibGVkKCk7XG4gICAgICAgIHJldHVybiB2ZXJpZmllZCAmJiBlbmFibGVkID09PSBtZXNzYWdlLmVuYWJsZWRcbiAgICAgICAgICAgID8geyBvazogdHJ1ZSwgZW5hYmxlZCB9XG4gICAgICAgICAgICA6IHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ck0LvQsNCzINC20YPRgNC90LDQu9CwINC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvScgfTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6ZGVidWctcmVhZCcpIHtcbiAgICAgICAgaWYgKG1lc3NhZ2UubGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS5saW1pdCkgfHwgbWVzc2FnZS5saW1pdCA8IDFcbiAgICAgICAgICAgIHx8IG1lc3NhZ2UubGltaXQgPiBNRU1DSEFUX0RFQlVHX0xPR19MSU1JVCkpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LbRg9GA0L3QsNC7INGA0LDRgdGI0LjRgNC10L3QuNGPJyB9O1xuICAgICAgICByZXR1cm4gbWVtY2hhdERlYnVnUmVhZCh7IGxpbWl0OiBtZXNzYWdlLmxpbWl0IH0pO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpkZWJ1Zy1jbGVhcicpIHJldHVybiBtZW1jaGF0RGVidWdDbGVhcigpO1xuICAgIC8vIFRoZSB3b3JsZCBpcyBkZXJpdmVkIGZyb20gdGhlIGF1dGhlbnRpY2F0ZWQgc2VuZGVyLCBuZXZlciB0cnVzdGVkIGZyb20gdGhlXG4gICAgLy8gcGF5bG9hZDogYSBjb250ZW50IHdvcmxkIGNhbm5vdCBjbGFpbSB0byBiZSB0aGUgcGFuZWwgb3IgdGhlIHdvcmtlci5cbiAgICBpZiAoIU1FTUNIQVRfREVCVUdfTEVWRUxTLmluY2x1ZGVzKG1lc3NhZ2UubGV2ZWwpXG4gICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLnNjb3BlICE9PSAnc3RyaW5nJyB8fCAhL15bYS16MC05Oi1dezEsNjR9JC8udGVzdChtZXNzYWdlLnNjb3BlKVxuICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5ldmVudCAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS5ldmVudC5sZW5ndGggPCAxIHx8IG1lc3NhZ2UuZXZlbnQubGVuZ3RoID4gMjAwXG4gICAgICAgIHx8IChtZXNzYWdlLndvcmxkICE9PSB1bmRlZmluZWQgJiYgIU1FTUNIQVRfREVCVUdfV09STERTLmluY2x1ZGVzKG1lc3NhZ2Uud29ybGQpKSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC20YPRgNC90LDQuyDRgNCw0YHRiNC40YDQtdC90LjRjycgfTtcbiAgICB9XG4gICAgYXdhaXQgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6IG1lc3NhZ2UubGV2ZWwsIHNjb3BlOiBtZXNzYWdlLnNjb3BlLCBldmVudDogbWVzc2FnZS5ldmVudCwgZGV0YWlsOiBtZXNzYWdlLmRldGFpbCB9LFxuICAgICAgICBkZWJ1Z1dvcmxkRm9yKHNlbmRlciwgcGFuZWwpKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xufVxuXG5mdW5jdGlvbiBleHRlbnNpb25IYW5kbGVNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSB7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0OmNoYXQtZXZlbnQnKSByZXR1cm4gc2lkZWJhckhpc3RvcnlNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKTtcbiAgICBpZiAoWydtZW1jaGF0OmRlYnVnLWxvZycsICdtZW1jaGF0OmRlYnVnLXJlYWQnLCAnbWVtY2hhdDpkZWJ1Zy1jbGVhcicsICdtZW1jaGF0OmRlYnVnLWZsYWcnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBjb25zdCBwYW5lbCA9IGRlYnVnUGFuZWxTZW5kZXIoc2VuZGVyKTtcbiAgICAgICAgLy8gVGhlIHZlcmJvc2UtbG9nIHN3aXRjaCBsaXZlcyBpbiB0aGUgc2V0dGluZ3Mgd2luZG93LCB3aGljaCBpcyByZW5kZXJlZCBieVxuICAgICAgICAvLyBvdXIgb3duIGNvbnRlbnQgc2NyaXB0IChvciB0aGUgbmF0aXZlIHJ1bnRpbWUpLCBub3QgYnkgdGhlIHBhbmVsIGRvY3VtZW50LlxuICAgICAgICAvLyBBIHBhZ2UgY2Fubm90IGZvcmdlIGFueSBvZiB0aGVzZSBzZW5kZXJzOiBzZW5kZXIuaWQgbXVzdCBiZSBvdXIgZXh0ZW5zaW9uLlxuICAgICAgICBjb25zdCB0cnVzdGVkID0gcGFuZWwgfHwgdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpO1xuICAgICAgICBpZiAoIXRydXN0ZWQpIHtcbiAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgZGVidWdNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgcGFuZWwpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CW0YPRgNC90LDQuyDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpuYXRpdmUtZHJhZnQtcmVhZCcsICdtZW1jaGF0Om5hdGl2ZS1kcmFmdC13cml0ZSddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgbmF0aXZlRHJhZnRNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikudGhlbihzZW5kUmVzcG9uc2UsICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQp9C10YDQvdC+0LLQuNC6INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvS4g0J3QtSDQt9Cw0LrRgNGL0LLQsNC50YLQtSDQv9Cw0L3QtdC70YwuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLXRlc3Qtc291bmQnKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIG9yZGVyUGxheUF1ZGlvKCkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9JyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2UtaW5pdCcsICdtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnLCAnbWVtY2hhdDpzdG9yYWdlLXBydW5lJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGF0YDQsNC90LjQu9C40YnQsCDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CU0LDQvdC90YvQtSDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNC10L3RiyDRhdGA0LDQvdC40LvQuNGJ0LXQvC4g0J3QtSDQt9Cw0LrRgNGL0LLQsNC50YLQtSDQuCDQvdC1INC/0LXRgNC10LfQsNCz0YDRg9C20LDQudGC0LUg0LLQutC70LDQtNC60YMuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnLCAnbWVtY2hhdDpvcmRlcnMtcG9sbCcsICdtZW1jaGF0Om9yZGVycy1zdG9wJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgY29uc3Qgd29yayA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgICAgICAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSAmJiBtZXNzYWdlLnR5cGUgIT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJ1xuICAgICAgICAgICAgICAgICYmICFhd2FpdCBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgJ0JlYXJlciAnICsgbWVzc2FnZS50b2tlbikpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQo9GH0ZHRgtC90YvQtSDQtNCw0L3QvdGL0LUg0LjQt9C80LXQvdC10L3Riy4g0J/QvtC00YLQstC10YDQtNC40YLQtSDQutC70Y7Rhy4nIH07XG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtY29uZmlndXJlJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yZGVyTXV0YXRlKCgpID0+IGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpKTtcbiAgICAgICAgICAgICAgICBjb25zdCBuYXRpdmUgPSBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5nZXQoc2VuZGVyKTtcbiAgICAgICAgICAgICAgICBpZiAobmF0aXZlICYmIHJlc3VsdC5vaykgeyBuYXRpdmUub3JkZXJUb2tlbiA9IG1lc3NhZ2UudG9rZW47IG5hdGl2ZS5vcmRlclJldmlzaW9uID0gcmVzdWx0LnJldmlzaW9uOyB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJykgcmV0dXJuIG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICAgICAgICAgICAgICBvcmRlckNvbmZpZy5zZXR0aW5ncy5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiArK29yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9yZGVyUHVibGljQ29uZmlnKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyQ29uZmlnQ2hhaW47XG4gICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgcmV0dXJuIHBvbGxPcmRlcnMoKTtcbiAgICAgICAgfTtcbiAgICAgICAgd29yaygpLnRoZW4oc2VuZFJlc3BvbnNlLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvdCw0YHRgtGA0L7QuNGC0Ywg0YTQvtC90L7QstGL0Lkg0L7Qv9GA0L7RgScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0OnBhbmVsLWNzcmYnKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgfHwgKG1lc3NhZ2UuZm9yY2UgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgbWVzc2FnZS5mb3JjZSAhPT0gJ2Jvb2xlYW4nKSkge1xuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBnZXRQYW5lbFNlc3Npb24obWVzc2FnZS5mb3JjZSA9PT0gdHJ1ZSkudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAnUGFuZWw6INGE0L7QvdC+0LLQsNGPINGB0LXRgdGB0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsC4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmICghWydtZW1jaGF0Omh0dHAnLCAnbWVtY2hhdDphYm9ydCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtekEtWjAtOS1dezEsODB9JC8udGVzdChtZXNzYWdlLmlkKSkge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6YWJvcnQnKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCkpO1xuICAgICAgICBpZiAoZW50cnkpIHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcGVyZm9ybVJlcXVlc3QobWVzc2FnZSwgc2VuZGVyKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQuZXZlbnQgPT09ICdsb2FkJyAmJiBbNDAxLCA0MDMsIDQxOV0uaW5jbHVkZXMocmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpXG4gICAgICAgICAgICAmJiBuZXcgVVJMKG1lc3NhZ2UucmVxdWVzdC51cmwpLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1Jykge1xuICAgICAgICAgICAgY29uc3Qgc2VudFRva2VuID0gbmV3IEhlYWRlcnMobWVzc2FnZS5yZXF1ZXN0LmhlYWRlcnMgfHwge30pLmdldCgneC1jc3JmLXRva2VuJyk7XG4gICAgICAgICAgICBpZiAoc2VudFRva2VuICYmIHNlbnRUb2tlbiA9PT0gcGFuZWxTZXNzaW9uPy50b2tlbikge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmVzdWx0LnBhbmVsQXV0aExvc3QgPSB0cnVlO1xuICAgICAgICAgICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3BhbmVsJywgZXZlbnQ6ICdhdXRoLWxvc3QnLFxuICAgICAgICAgICAgICAgICAgICBkZXRhaWw6IHsgc3RhdHVzOiByZXN1bHQucmVzcG9uc2U/LnN0YXR1cyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzZW5kUmVzcG9uc2UocmVzdWx0KTtcbiAgICB9LCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPJyB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG59XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoZXh0ZW5zaW9uSGFuZGxlTWVzc2FnZSk7XG5cbi8vIFJlZ2lzdGVyIHRvb2xiYXIvY29udGV4dC1tZW51IGxpc3RlbmVycyBzeW5jaHJvbm91c2x5IG9uIGV2ZXJ5IHdvcmtlciB3YWtlLlxuaW1wb3J0U2NyaXB0cygnY29udHJvbHMuanMnKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckxBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaktBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbFNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIn0=
