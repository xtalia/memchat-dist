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

async function performRequest(message, sender, backgroundSignal, backgroundCredentialCurrent) {
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
    const checkCurrent = backgroundCredentialCurrent ? async () => {
        try { if (await backgroundCredentialCurrent()) return; } catch { /* Fail closed. */ }
        entry.event = 'abort';
        entry.controller.abort();
    } : request.credentialGuard === true ? async () => {
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
function sidebarClickId(message) {
    const id = message.clickId;
    return message.event === 'click' && typeof id === 'string' && /^[g-v]{32}$/.test(id) ? id : null;
}
// A failed view is the signal a panel-only report usually lacks: keep the exact
// reason and which captured binding produced it, never page content.
function sidebarDebugFailure(message, binding, reason) {
    const clickId = sidebarClickId(message);
    memchatDebugRecord({ level: 'error', scope: 'sidebar', event: 'view-failed', detail: {
        reason, tabId: Number.isInteger(binding?.tabId) ? binding.tabId : (Number.isInteger(message.tabId) ? message.tabId : null),
        supported: binding?.supported === true, host: sidebarDebugHost(binding?.origin), ...(clickId ? { clickId } : {})
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
    const clickId = sidebarClickId(message);
    const request = message.type === 'memchat:sidebar-view'
        ? { type: 'memchat:view-snapshot' }
        : { type: 'memchat:view-event', documentToken: message.documentToken,
            key: message.key, event: message.event, value: message.value,
            checked: message.checked, selected: message.selected,
            ...(message.event === 'click' && message.trustedGesture === true ? { trustedGesture: true } : {}),
            ...(clickId ? { clickId } : {}),
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
    const relayClickTrace = route => {
        if (clickId) memchatDebugRecord({ level: 'debug', scope: 'sidebar', event: 'click-relayed', detail: { clickId, route } }, 'worker');
    };
    try {
        if (binding.supported) {
            historyTarget = 'tab:' + tab.id;
            relayClickTrace('content');
            view = await sidebarSendToTab(tab.id, request);
        }
        else {
            const session = nativeRuntimeSessions.get(nativeRuntimeSessionKey(sender, origin));
            if (!session) {
                if (message.type !== 'memchat:sidebar-view') return { ok: false, reason: 'changed' };
                return { ok: true, tabId: tab.id, host: new URL(origin).hostname,
                    runtime: { origin, ticket: await nativeRuntimeTicket(sender, message.windowId, origin) } };
            }
            historyTarget = 'native:' + session.sender.url;
            relayClickTrace('runtime');
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
/* module: src/features/reprice/service.js */
const MEMCHAT_REPRICE_API = 'https://api.moysklad.ru/api/remap/1.2';
const MEMCHAT_REPRICE_PRICE_TYPES = '/context/companysettings/pricetype';
const MEMCHAT_REPRICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMCHAT_REPRICE_DEFAULTS = Object.freeze({ multiplier: '1.041', rounding: 'up', step: '100', subtract: '10' });

function memchatRepriceFormula(rules) {
    const decimal = (value, places) => {
        if (typeof value !== 'string' || !new RegExp(`^\\d{1,8}(?:\\.\\d{1,${places}})?$`).test(value)) {
            throw Error('Введите десятичные значения коэффициента, шага и вычитания.');
        }
        const [whole, fraction = ''] = value.split('.');
        const suffix = fraction.replace(/0+$/, '');
        return String(Number(whole)) + (suffix ? '.' + suffix : '');
    };
    const multiplier = decimal(rules.multiplier, 6);
    const step = decimal(rules.step, 2);
    const subtract = decimal(rules.subtract, 2);
    const rounding = rules.rounding;
    if (Number(multiplier) <= 0 || Number(step) <= 0) throw Error('Коэффициент и шаг должны быть больше нуля.');
    if (!['up', 'nearest', 'down'].includes(rounding)) throw Error('Выберите направление округления.');
    return { multiplier, rounding, step, subtract };
}

function memchatRepricePriceTypes(payload) {
    if (!Array.isArray(payload)) throw Error('Справочник типов цен недоступен.');
    const types = new Map();
    for (const row of payload) {
        if (typeof row?.id !== 'string' || !MEMCHAT_REPRICE_UUID.test(row.id) || types.has(row.id)
            || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 300
            || row.meta?.href !== MEMCHAT_REPRICE_API + MEMCHAT_REPRICE_PRICE_TYPES + '/' + row.id) {
            throw Error('Некорректный справочник типов цен.');
        }
        types.set(row.id, row.name);
    }
    return types;
}

function createMemchatRepriceService(config) {
    'use strict';

    const ORDER_ID = config.orderId;
    const BASE_PRICE_TYPE_ID = config.baseTypeId;
    const BASE_PRICE_TYPE_NAME = config.baseTypeName;
    const TARGET_PRICE_TYPE_ID = config.targetTypeId;
    const TARGET_PRICE_TYPE_NAME = config.targetTypeName;
    const PRICE_TYPE_CONTEXT_PATH = MEMCHAT_REPRICE_PRICE_TYPES;
    const API = MEMCHAT_REPRICE_API;
    const POSITIONS_LIMIT = 1000;
    const formula = memchatRepriceFormula({ ...MEMCHAT_REPRICE_DEFAULTS, ...config });
    const scaled = (value, places) => {
        const [whole, fraction = ''] = value.split('.');
        return BigInt(whole + fraction.padEnd(places, '0'));
    };
    const multiplier = scaled(formula.multiplier, 6);
    const step = scaled(formula.step, 2);
    const subtract = scaled(formula.subtract, 2);
    const divisor = 1000000n * step;
    const UUID_PATTERN = MEMCHAT_REPRICE_UUID;
    const CARD_VOLATILE = ['meta', 'context', 'updated', 'salePrices'];
    const DOCUMENT_VOLATILE = ['meta', 'context', 'positions', 'updated'];

    function failure(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function invalid(code, message) {
        const error = failure(code, message);
        error.validation = true;
        return error;
    }

    function integer(value) {
        if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
        if (typeof value === 'bigint') {
            const converted = Number(value);
            return Number.isSafeInteger(converted) ? converted : null;
        }
        if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
            const converted = Number(value.trim());
            return Number.isSafeInteger(converted) ? converted : null;
        }
        return null;
    }

    function calculate(baseKopecks) {
        const base = integer(baseKopecks);
        if (base === null || base <= 0) {
            throw failure('invalid-base', 'Базовая цена должна быть положительным целым числом копеек');
        }
        const offset = formula.rounding === 'up' ? divisor - 1n : formula.rounding === 'nearest' ? divisor / 2n : 0n;
        const rounded = (BigInt(base) * multiplier + offset) / divisor;
        const result = rounded * step - subtract;
        if (result <= 0n || !Number.isSafeInteger(Number(result))) {
            throw invalid('out-of-range', 'Рассчитанная цена должна быть положительной и в безопасном диапазоне');
        }
        return Number(result);
    }

    function canonical(value) {
        if (value === void 0) return 'null';
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        return '{' + Object.keys(value).sort()
            .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }

    function copy(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function lastSegment(href) {
        const parts = String(href).split('?')[0].split('/');
        return parts[parts.length - 1];
    }

    function readPath(path) {
        if (typeof path !== 'string' || path.length === 0) {
            throw failure('invalid-read-path', 'Некорректный адрес чтения МойСклад');
        }
        if (path === PRICE_TYPE_CONTEXT_PATH) return path;
        if (!path.startsWith('/entity/') || path.indexOf('//') !== -1) {
            throw failure('invalid-read-path', 'Чтение разрешено только в /entity');
        }
        return path;
    }

    async function readJson(read, path) {
        const data = await read(readPath(path));
        if (data && Array.isArray(data.errors) && data.errors.length) {
            throw failure('api-response', 'Ответ МойСклад содержит ошибки');
        }
        return data;
    }

    function linkBase(href, marker) {
        if (typeof href !== 'string' || !href) {
            throw failure('identity', 'Не удалось определить адрес API МойСклад');
        }
        const clean = href.split('?')[0];
        if (clean !== API + marker) {
            throw failure('identity', 'Ссылка вне согласованного адреса МойСклад');
        }
        return API;
    }

    function orderBase(order) {
        return linkBase(order && order.meta && order.meta.href,
            '/entity/internalorder/' + ORDER_ID);
    }

    function cardBase(card, id) {
        return linkBase(card && card.meta && card.meta.href, '/entity/product/' + id);
    }

    function relative(href, base) {
        if (typeof href !== 'string' || !href) {
            throw failure('scope', 'Некорректная ссылка МойСклад');
        }
        if (href.charAt(0) === '/') {
            if (!href.startsWith('/entity/') || href.indexOf('//') !== -1) {
                throw failure('scope', 'Ссылка вне согласованного API МойСклад');
            }
            return href;
        }
        if (!href.startsWith(base + '/entity/')) {
            throw failure('scope', 'Ссылка вне согласованного API МойСклад');
        }
        return href.slice(base.length);
    }

    function productRef(href, base) {
        const path = relative(href, base);
        const segments = path.split('?')[0].split('/');
        if (segments.length !== 4 || segments[1] !== 'entity' || segments[2] !== 'product'
            || !UUID_PATTERN.test(segments[3])) {
            throw invalid('product-ref', 'Некорректная ссылка product');
        }
        return { id: segments[3], path };
    }

    function priceTypeId(price) {
        const priceType = price && price.priceType;
        if (!priceType) return '';
        if (typeof priceType.id === 'string' && priceType.id) return priceType.id;
        return priceType.meta && typeof priceType.meta.href === 'string'
            ? lastSegment(priceType.meta.href) : '';
    }

    function selectPrice(card, id, name) {
        if (!card || !Array.isArray(card.salePrices)) {
            throw invalid('prices', 'В карточке нет типов цен');
        }
        const matches = card.salePrices.filter(price => priceTypeId(price) === id);
        if (matches.length !== 1 || (name !== undefined && matches[0].priceType?.name !== name)
            || matches[0].priceType?.meta?.href !== API + PRICE_TYPE_CONTEXT_PATH + '/' + id) {
            throw invalid('prices', 'Отсутствует или переименован тип цены ' + name);
        }
        const price = matches[0];
        if (!price.currency || !price.currency.meta
            || typeof price.currency.meta.href !== 'string') {
            throw invalid('currency', 'У типа цены нет валюты');
        }
        return price;
    }

    async function requireRuble(read, price, base, cache) {
        const path = relative(price.currency.meta.href, base);
        const segments = path.split('?')[0].split('/');
        if (segments.length !== 4 || segments[2] !== 'currency'
            || !UUID_PATTERN.test(segments[3])) {
            throw invalid('currency', 'Некорректная ссылка валюты');
        }
        let iso = cache.get(path);
        if (iso === void 0) {
            const data = await readJson(read, path);
            iso = data && data.isoCode;
            cache.set(path, iso);
        }
        if (iso !== 'RUB') throw invalid('currency', 'Валюта цены не RUB');
    }

    function otherPrices(card) {
        const prices = card && Array.isArray(card.salePrices) ? card.salePrices : [];
        return prices
            .filter(price => priceTypeId(price) !== TARGET_PRICE_TYPE_ID)
            .map(price => ({
                id: priceTypeId(price),
                value: Number(price.value),
                currency: price.currency && price.currency.meta
                    ? String(price.currency.meta.href) : ''
            }))
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    }

    function businessFields(card) {
        const fields = {};
        Object.keys(card || {}).forEach(key => {
            if (CARD_VOLATILE.indexOf(key) === -1) fields[key] = card[key];
        });
        return fields;
    }

    function documentSignature(order, positions) {
        const header = {};
        Object.keys(order || {}).forEach(key => {
            if (DOCUMENT_VOLATILE.indexOf(key) === -1) header[key] = order[key];
        });
        const rows = positions.map(position => {
            const row = {};
            Object.keys(position || {}).forEach(key => {
                if (key !== 'meta' && key !== 'assortment') row[key] = position[key];
            });
            row.assortment = position && position.assortment && position.assortment.meta
                ? position.assortment.meta.href : null;
            return row;
        }).sort((left, right) => {
            const a = String(left.id === void 0 ? '' : left.id);
            const b = String(right.id === void 0 ? '' : right.id);
            return a < b ? -1 : a > b ? 1 : 0;
        });
        return canonical({ header, positions: rows });
    }

    async function collectPages(read, first, base, endpoint) {
        const rows = [];
        const visited = new Set();
        let expectedSize;
        let next = first;
        while (next) {
            const path = relative(next, base);
            if (path.split('?')[0] !== endpoint) {
                throw failure('pagination', 'Некорректная пагинация МойСклад');
            }
            if (visited.has(path)) {
                throw failure('pagination', 'Повторная страница пагинации МойСклад');
            }
            visited.add(path);
            const page = await readJson(read, path);
            if (!page || !Array.isArray(page.rows) || !page.meta) {
                throw failure('pagination', 'Неполная страница пагинации МойСклад');
            }
            const size = integer(page.meta.size);
            if (size === null || size < 0) {
                throw failure('pagination', 'Не указан размер выборки МойСклад');
            }
            if (page.meta.offset !== void 0 && integer(page.meta.offset) !== rows.length) {
                throw failure('pagination', 'Неверное смещение пагинации МойСклад');
            }
            if (expectedSize !== void 0 && size !== expectedSize) {
                throw failure('pagination', 'Размер выборки изменился во время чтения МойСклад');
            }
            expectedSize = size;
            rows.push.apply(rows, page.rows);
            if (rows.length > size) {
                throw failure('pagination', 'Лишние строки в выборке МойСклад');
            }
            if (page.meta.nextHref) {
                if (typeof page.meta.nextHref !== 'string' || !page.rows.length || rows.length >= size) {
                    throw failure('pagination', 'Некорректное продолжение пагинации МойСклад');
                }
                next = page.meta.nextHref;
            } else {
                if (rows.length !== size) {
                    throw failure('pagination', 'Неполная выборка МойСклад');
                }
                next = null;
            }
        }
        if (expectedSize === void 0) throw failure('pagination', 'Неполная выборка МойСклад');
        return rows;
    }

    function checkPriceTypes(payload) {
        const types = memchatRepricePriceTypes(payload);
        if (BASE_PRICE_TYPE_ID === TARGET_PRICE_TYPE_ID || !types.has(BASE_PRICE_TYPE_ID) || !types.has(TARGET_PRICE_TYPE_ID)
            || types.get(BASE_PRICE_TYPE_ID) !== BASE_PRICE_TYPE_NAME || types.get(TARGET_PRICE_TYPE_ID) !== TARGET_PRICE_TYPE_NAME) {
            throw failure('pricetype-context', 'Тип цены не совпадает с настройкой. Обновите правила переоценки.');
        }
    }

    async function makePlan(read) {
        if (typeof read !== 'function') throw new TypeError('plan requires a read function');
        if (typeof ORDER_ID !== 'string' || !UUID_PATTERN.test(ORDER_ID)) throw failure('identity', 'Некорректный внутренний заказ');
        checkPriceTypes(await readJson(read, PRICE_TYPE_CONTEXT_PATH));

        const order = await readJson(read, '/entity/internalorder/' + ORDER_ID);
        const base = orderBase(order);
        if (!order || order.id !== ORDER_ID || typeof order.name !== 'string' || !order.name.trim()) {
            throw failure('identity', 'Внутренний заказ не совпадает со ссылкой');
        }
        const endpoint = '/entity/internalorder/' + ORDER_ID + '/positions';
        const positions = await collectPages(read,
            endpoint + '?expand=assortment&limit=' + POSITIONS_LIMIT, base, endpoint);

        const entries = [];
        const skipped = [];
        const seen = new Set();
        const cache = new Map();

        for (const position of positions) {
            const assortment = position && position.assortment;
            const href = assortment && assortment.meta && assortment.meta.href;
            const type = assortment && assortment.meta && assortment.meta.type;
            const label = assortment && typeof assortment.name === 'string' && assortment.name
                ? assortment.name : (typeof href === 'string' ? href : 'позиция');
            if (type !== 'product' || typeof href !== 'string') {
                skipped.push({ name: label, reason: 'поддерживаются только карточки product' });
                continue;
            }
            let product;
            try {
                product = productRef(href, base);
            } catch (error) {
                if (error && error.validation === true) {
                    skipped.push({ name: label, reason: error.message });
                    continue;
                }
                throw error;
            }
            if (seen.has(product.id)) continue;
            seen.add(product.id);

            const card = await readJson(read, product.path);
            if (!card || card.id !== product.id || typeof card.name !== 'string') {
                throw failure('identity', 'Карточка не совпадает с позицией заказа');
            }
            try {
                const basePrice = selectPrice(card, BASE_PRICE_TYPE_ID, BASE_PRICE_TYPE_NAME);
                const targetPrice = selectPrice(card, TARGET_PRICE_TYPE_ID, TARGET_PRICE_TYPE_NAME);
                await requireRuble(read, basePrice, base, cache);
                await requireRuble(read, targetPrice, base, cache);
                const baseKopecks = integer(basePrice.value);
                if (baseKopecks === null || baseKopecks <= 0) {
                    throw invalid('base', 'Базовая цена должна быть положительной и целой');
                }
                const old = integer(targetPrice.value);
                if (old === null) throw invalid('target', 'Ценник должен быть целым числом копеек');
                if (old < 0) throw invalid('target', 'Отрицательный текущий ценник');
                const next = Number(calculate(baseKopecks));
                entries.push({ id: product.id, name: card.name, base: baseKopecks, old, new: next });
            } catch (error) {
                if (error && error.validation === true) {
                    skipped.push({ name: label, reason: error.message });
                    continue;
                }
                throw error;
            }
        }
        return { orderName: order.name, signature: documentSignature(order, positions), entries, skipped };
    }

    async function plan(read) {
        return makePlan(read);
    }

    function differences(entries) {
        const changed = {};
        for (const entry of entries) {
            if (entry && entry.new !== entry.old) {
                changed[entry.id] = { base: entry.base, old: entry.old, new: entry.new };
            }
        }
        return changed;
    }

    function metaCopy(meta) {
        if (!meta || typeof meta !== 'object') {
            throw invalid('prices', 'Нет метаданных типа цены');
        }
        const result = {};
        Object.keys(meta).forEach(key => { result[key] = meta[key]; });
        return result;
    }

    function payloadFor(entry, targetPrice) {
        return {
            salePrices: [{
                value: entry.new,
                priceType: { meta: metaCopy(targetPrice.priceType.meta) },
                currency: { meta: metaCopy(targetPrice.currency.meta) }
            }]
        };
    }

    function verifyWritable(card, entry, before) {
        if (!card || card.id !== entry.id || card.name !== entry.name) {
            throw invalid('identity', 'Карточка изменилась во время переоценки');
        }
        const basePrice = selectPrice(card, BASE_PRICE_TYPE_ID, BASE_PRICE_TYPE_NAME);
        const targetPrice = selectPrice(card, TARGET_PRICE_TYPE_ID, TARGET_PRICE_TYPE_NAME);
        if (integer(basePrice.value) !== entry.base) {
            throw invalid('base', 'Базовая цена изменилась во время переоценки');
        }
        if (integer(targetPrice.value) !== entry.new) {
            throw invalid('target', 'Ценник не подтверждён обратным чтением');
        }
        if (targetPrice.currency.meta.href !== selectPrice(before, TARGET_PRICE_TYPE_ID, TARGET_PRICE_TYPE_NAME).currency.meta.href) {
            throw invalid('currency', 'Изменилась валюта целевой цены');
        }
        if (canonical(otherPrices(card)) !== canonical(otherPrices(before))) {
            throw invalid('prices', 'Изменился другой тип цены');
        }
        if (canonical(businessFields(card)) !== canonical(businessFields(before))) {
            throw invalid('fields', 'Изменились другие поля карточки');
        }
    }

    async function verifyStable(card, entry, expected, read, base, cache) {
        if (!card || card.id !== entry.id || card.name !== entry.name) {
            throw invalid('identity', 'Итоговая карточка не совпадает с планом');
        }
        const basePrice = selectPrice(card, BASE_PRICE_TYPE_ID, BASE_PRICE_TYPE_NAME);
        const targetPrice = selectPrice(card, TARGET_PRICE_TYPE_ID, TARGET_PRICE_TYPE_NAME);
        await requireRuble(read, basePrice, base, cache);
        await requireRuble(read, targetPrice, base, cache);
        if (integer(basePrice.value) !== entry.base) {
            throw invalid('base', 'Итоговая базовая цена не совпадает');
        }
        if (integer(targetPrice.value) !== expected) {
            throw invalid('target', 'Итоговый ценник не совпадает');
        }
    }

    function makeJournal(fresh, changed) {
        return {
            status: 'writing',
            checked: 0,
            verified: 0,
            signature: fresh.signature,
            total: fresh.entries.length,
            changed: changed.length,
            intent: null,
            records: changed.map(entry => ({
                id: entry.id,
                name: entry.name,
                old: entry.old,
                new: entry.new,
                outcome: 'pending'
            })),
            error: null
        };
    }

    async function saveJournal(persist, journal) {
        if (typeof persist !== 'function') return false;
        const snapshot = copy(journal);
        try {
            const stored = await persist(snapshot);
            return stored !== null && typeof stored === 'object'
                && canonical(stored) === canonical(snapshot);
        } catch (error) {
            return false;
        }
    }

    function setOutcome(journal, id, outcome) {
        for (const record of journal.records) {
            if (record.id === id) record.outcome = outcome;
        }
    }

    function recount(journal) {
        let checked = 0;
        let verified = 0;
        for (const record of journal.records) {
            if (record.outcome === 'pending' || record.outcome === 'writing') continue;
            checked += 1;
            if (record.outcome === 'verified' || record.outcome === 'applied'
                || record.outcome === 'applied-after-error') verified += 1;
        }
        journal.checked = checked;
        journal.verified = verified;
    }

    function failureStatus(journal) {
        return journal.verified > 0 ? 'interrupted' : 'failed';
    }

    async function finalAudit(journal, read, fresh) {
        let checked = 0;
        let verified = 0;
        try {
            const cache = new Map();
            for (const entry of fresh.entries) {
                const card = await readJson(read, '/entity/product/' + entry.id);
                cardBase(card, entry.id);
                await verifyStable(card, entry, entry.new, read, API, cache);
                checked += 1;
                verified += 1;
            }
            const order = await readJson(read, '/entity/internalorder/' + ORDER_ID);
            const base = orderBase(order);
            if (!order || order.id !== ORDER_ID || order.name !== fresh.orderName) {
                throw invalid('identity', 'Итоговый внутренний заказ не совпадает');
            }
            const endpoint = '/entity/internalorder/' + ORDER_ID + '/positions';
            const positions = await collectPages(read,
                endpoint + '?expand=assortment&limit=' + POSITIONS_LIMIT, base, endpoint);
            if (documentSignature(order, positions) !== fresh.signature) {
                journal.status = failureStatus(journal);
                journal.checked = checked;
                journal.verified = verified;
                journal.error = 'signature-changed';
                return journal;
            }
            journal.checked = checked;
            journal.verified = verified;
            journal.status = 'verified';
            journal.intent = null;
            journal.error = null;
            for (const record of journal.records) record.outcome = 'verified';
            return journal;
        } catch (error) {
            journal.status = failureStatus(journal);
            journal.checked = checked;
            journal.verified = verified;
            journal.error = 'final-read-failed';
            return journal;
        }
    }

    async function finish(journal, persist) {
        const stored = await saveJournal(persist, journal);
        if (journal.status === 'verified' && !stored) {
            journal.status = 'uncertain';
            journal.error = 'persist-failed';
        }
        return journal;
    }

    async function apply(preview, ports) {
        const options = ports || {};
        const read = options.read;
        const write = options.write;
        const persist = options.persist;
        if (typeof read !== 'function' || typeof write !== 'function') {
            throw new TypeError('apply requires read and write functions');
        }
        if (!preview || typeof preview !== 'object' || typeof preview.signature !== 'string'
            || !Array.isArray(preview.entries)) {
            throw new TypeError('apply requires an explicitly captured preview');
        }

        let fresh;
        try {
            fresh = await makePlan(read);
        } catch (error) {
            return {
                status: 'failed', checked: 0, verified: 0,
                signature: preview.signature, total: 0, changed: 0,
                intent: null, records: [], error: 'plan-failed'
            };
        }

        const changed = fresh.entries.filter(entry => entry.new !== entry.old);
        const journal = makeJournal(fresh, changed);
        const sorted = rows => rows.slice().sort((left, right) => left.id.localeCompare(right.id));
        const stale = fresh.signature !== preview.signature
            || canonical(sorted(fresh.entries)) !== canonical(sorted(preview.entries))
            || canonical(fresh.skipped) !== canonical(preview.skipped);
        if (stale) {
            journal.status = 'failed';
            journal.error = 'stale-preview';
            await saveJournal(persist, journal);
            return journal;
        }

        if (!changed.length) {
            const audited = await finalAudit(journal, read, fresh);
            return finish(audited, persist);
        }

        for (const entry of changed) {
            const path = '/entity/product/' + entry.id;
            let before;
            try {
                before = await readJson(read, path);
            } catch (error) {
                journal.status = failureStatus(journal);
                journal.error = 'prewrite-read-failed';
                await saveJournal(persist, journal);
                return journal;
            }

            let targetPrice;
            try {
                if (!before || before.id !== entry.id || before.name !== entry.name) {
                    throw invalid('identity', 'Карточка изменилась после предпросмотра');
                }
                const basePrice = selectPrice(before, BASE_PRICE_TYPE_ID, BASE_PRICE_TYPE_NAME);
                targetPrice = selectPrice(before, TARGET_PRICE_TYPE_ID, TARGET_PRICE_TYPE_NAME);
                if (integer(basePrice.value) !== entry.base
                    || integer(targetPrice.value) !== entry.old) {
                    throw invalid('preview', 'Цена изменилась после предпросмотра');
                }
                const base = cardBase(before, entry.id);
                const cache = new Map();
                await requireRuble(read, basePrice, base, cache);
                await requireRuble(read, targetPrice, base, cache);
            } catch (error) {
                journal.status = failureStatus(journal);
                journal.error = error && error.validation === true
                    ? 'prewrite-mismatch' : 'prewrite-read-failed';
                await saveJournal(persist, journal);
                return journal;
            }

            journal.intent = {
                id: entry.id,
                name: entry.name,
                path,
                base: entry.base,
                old: entry.old,
                new: entry.new,
                priceType: {
                    id: TARGET_PRICE_TYPE_ID,
                    name: TARGET_PRICE_TYPE_NAME,
                    href: String(targetPrice.priceType.meta.href)
                },
                currency: { href: String(targetPrice.currency.meta.href) },
                others: otherPrices(before),
                fields: canonical(businessFields(before))
            };
            journal.status = 'writing';
            setOutcome(journal, entry.id, 'writing');
            recount(journal);
            if (!await saveJournal(persist, journal)) {
                journal.status = 'failed';
                journal.intent = null;
                journal.error = 'persist-failed';
                return journal;
            }

            const payload = payloadFor(entry, targetPrice);
            let writeFailed = false;
            try {
                await write(path, payload);
            } catch (error) {
                writeFailed = true;
            }

            let after;
            try {
                after = await readJson(read, path);
            } catch (error) {
                journal.status = 'uncertain';
                journal.error = 'readback-failed';
                setOutcome(journal, entry.id, 'uncertain');
                recount(journal);
                await saveJournal(persist, journal);
                return journal;
            }

            try {
                verifyWritable(after, entry, before);
            } catch (error) {
                journal.status = 'uncertain';
                journal.error = writeFailed ? 'write-failed-unverified' : 'readback-mismatch';
                setOutcome(journal, entry.id, 'uncertain');
                recount(journal);
                await saveJournal(persist, journal);
                return journal;
            }

            journal.intent = null;
            setOutcome(journal, entry.id, writeFailed ? 'applied-after-error' : 'verified');
            recount(journal);
            if (!await saveJournal(persist, journal)) {
                journal.status = 'uncertain';
                journal.error = 'persist-failed';
                return journal;
            }
            if (writeFailed) {
                journal.status = 'interrupted';
                journal.error = 'write-failed-applied';
                await saveJournal(persist, journal);
                return journal;
            }
        }

        const audited = await finalAudit(journal, read, fresh);
        return finish(audited, persist);
    }

    async function unresolved(journal, persist) {
        journal.status = 'uncertain';
        await saveJournal(persist, journal);
        return {
            summary: 'interrupted', status: journal.status, resolved: false, blocked: true,
            outcome: 'unresolved', checked: journal.checked, verified: journal.verified,
            intent: journal.intent
        };
    }

    async function reconcile(journal, ports) {
        const options = ports || {};
        const read = options.read;
        const persist = options.persist;
        if (typeof read !== 'function') throw new TypeError('reconcile requires a read function');
        if (!journal || typeof journal !== 'object') {
            throw new TypeError('reconcile requires a journal');
        }

        journal = copy(journal);
        const intent = journal.intent;
        if (journal.status === 'verified' && !intent) {
            return {
                summary: 'finished', status: 'verified', resolved: true, blocked: false,
                outcome: 'verified', checked: journal.checked, verified: journal.verified, intent: null
            };
        }
        if (!intent) {
            journal.status = 'interrupted';
            const resolved = await saveJournal(persist, journal);
            return {
                summary: 'interrupted', status: journal.status, resolved, blocked: !resolved,
                outcome: 'none', checked: journal.checked, verified: journal.verified, intent: null
            };
        }

        let card;
        try {
            if (!UUID_PATTERN.test(intent.id) || intent.path !== '/entity/product/' + intent.id) throw Error('Некорректное намерение записи');
            card = await readJson(read, intent.path);
        } catch (error) {
            return unresolved(journal, persist);
        }

        try {
            if (!card || card.id !== intent.id || card.name !== intent.name) {
                throw invalid('identity', 'Карточка не совпадает с намерением');
            }
            const base = cardBase(card, intent.id);
            const basePrice = selectPrice(card, BASE_PRICE_TYPE_ID, BASE_PRICE_TYPE_NAME);
            const targetPrice = selectPrice(card, TARGET_PRICE_TYPE_ID, TARGET_PRICE_TYPE_NAME);
            const cache = new Map();
            await requireRuble(read, basePrice, base, cache);
            await requireRuble(read, targetPrice, base, cache);
            if (integer(basePrice.value) !== intent.base) {
                throw invalid('base', 'Базовая цена не совпадает с намерением');
            }
            if (canonical(otherPrices(card)) !== canonical(intent.others)) {
                throw invalid('prices', 'Другие типы цен не совпадают с намерением');
            }
            if (canonical(businessFields(card)) !== intent.fields || targetPrice.currency.meta.href !== intent.currency.href
                || targetPrice.priceType.meta.href !== intent.priceType.href) {
                throw invalid('fields', 'Поля карточки не совпадают с намерением');
            }
            const value = integer(targetPrice.value);
            if (value !== intent.old && value !== intent.new) {
                throw invalid('target', 'Ценник не совпадает ни со старым, ни с новым значением');
            }
            const applied = value === intent.new;
            setOutcome(journal, intent.id, applied ? 'applied' : 'not-applied');
            recount(journal);
            journal.intent = null;
            journal.status = 'interrupted';
            journal.error = null;
            if (!await saveJournal(persist, journal)) {
                return {
                    summary: 'interrupted', status: 'uncertain', resolved: false, blocked: true,
                    outcome: 'unresolved', checked: journal.checked, verified: journal.verified,
                    intent: { id: intent.id, path: intent.path }
                };
            }
            return {
                summary: 'finished', status: 'interrupted', resolved: true, blocked: false,
                outcome: applied ? 'applied' : 'not-applied',
                checked: journal.checked, verified: journal.verified, intent: null
            };
        } catch (error) {
            return unresolved(journal, persist);
        }
    }

    return Object.freeze({ plan, apply, reconcile, calculate });
}
/* module: extension/worker/reprice.js */
// One Memchat writer across all native panels. An unfinished journal survives worker restarts.
const MEMCHAT_REPRICE_JOURNAL = 'memchatRepriceJournal_v1';

const repricePreviews = new Map();
const repriceSettings = new Map();
const repricePending = new Set();
let repriceBusy = false;

function repriceOwner(sender) {
    if (trustedNativeRuntimeSender(sender)) return 'native:' + sender.url;
    if (trustedContentSender(sender) && typeof sender.documentId === 'string' && sender.documentId) {
        return `content:${sender.tab.id}:${sender.documentId}`;
    }
    return '';
}

async function repriceAccess(sender) {
    if (!repriceOwner(sender)) throw Error('Панель отключена');
    const origin = runtimeSenderOrigin(sender);
    await privateStorageReady;
    await privateStorageChain;
    const key = 'memchatPrivate_v1:' + origin;
    const bucket = (await chrome.storage.local.get(key))[key];
    const api = JSON.parse(bucket?.items?.['memchat:hackerMsApi_v1']?.value || '{}');
    if (!repriceOwner(sender) || api.bearerEnabled !== true || typeof api.token !== 'string' || !api.token.trim()
        || typeof api.referenceScope !== 'string' || !api.referenceScope) throw Error('Bearer недоступен');
    return { origin, scope: api.referenceScope, token: api.token };
}

function repriceSameAccount(left, right) {
    return left.origin === right.origin && left.scope === right.scope;
}

let salesSettingsChain = Promise.resolve();
function salesSettingsMessage(message, sender) {
    const work = salesSettingsChain.then(async () => {
        const { accountId } = message;
        const save = message.type === 'memchat:sales-settings-save';
        if (typeof accountId !== 'string' || !MEMCHAT_REPRICE_UUID.test(accountId)) return { ok: false };
        const credential = await repriceAccess(sender);
        const key = 'memchatSalesStore_v1:' + credential.origin + ':' + accountId;
        const storeId = save ? message.storeId : (await chrome.storage.local.get(key))[key];
        if (!save && storeId == null) return { ok: true, storeId: null };
        if (typeof storeId !== 'string' || !MEMCHAT_REPRICE_UUID.test(storeId)) return { ok: false };
        const current = async () => {
            const active = await repriceAccess(sender);
            return repriceSameAccount(active, credential) && active.token === credential.token;
        };
        const response = await performRequest({ id: 'sales-store-' + crypto.randomUUID(), request: {
            url: MEMCHAT_REPRICE_API + '/entity/store/' + storeId, method: 'GET', anonymous: true, credentialGuard: true,
            headers: { Authorization: 'Bearer ' + credential.token, Accept: 'application/json;charset=utf-8' },
        } }, sender, undefined, current);
        if (response.event !== 'load' || !await current()) return { ok: false };
        if (!save && response.response.status === 404) return { ok: true, storeId: null };
        if (response.response.status !== 200) return { ok: false };
        const store = JSON.parse(response.response.responseText);
        if (store.id !== storeId || store.accountId !== accountId || store.archived === true) {
            return save ? { ok: false } : { ok: true, storeId: null };
        }
        if (save) {
            await chrome.storage.local.set({ [key]: storeId });
            if ((await chrome.storage.local.get(key))[key] !== storeId) return { ok: false };
        }
        return { ok: true, storeId };
    });
    salesSettingsChain = work.catch(() => {});
    return work.catch(() => ({ ok: false }));
}

function repriceRulesKey(origin) { return 'memchatRepriceRules_v1:' + origin; }

async function repriceLoadRules(access) {
    const key = repriceRulesKey(access.origin);
    const record = (await chrome.storage.local.get(key))[key];
    if (record?.scope !== access.scope) return null;
    if (typeof record.revision !== 'string' || !record.rules) throw Error('Правила переоценки недоступны.');
    return record;
}

function repriceOrderId(raw) {
    if (typeof raw !== 'string' || raw.length > 256) return null;
    const prefix = 'https://online.moysklad.ru/app/#internalorder/edit?id=';
    const url = raw.trim();
    const id = url.slice(prefix.length);
    return url.startsWith(prefix) && MEMCHAT_REPRICE_UUID.test(id) ? id : null;
}

async function repriceLive(sender, origin) {
    if (trustedNativeRuntimeSender(sender)) return runtimeSenderOrigin(sender) === origin;
    let timer;
    try {
        const reply = await Promise.race([
            chrome.tabs.sendMessage(sender.tab.id, { type: 'memchat:reprice-current' }, { documentId: sender.documentId }),
            new Promise(resolve => { timer = setTimeout(resolve, 1000); })
        ]);
        return reply?.current === true && reply.url === sender.url && new URL(reply.url).origin === origin;
    } catch { return false; }
    finally { clearTimeout(timer); }
}

function repriceRemember(map, owner, value) {
    map.delete(owner);
    for (const [key, entry] of map) if (entry.expires < Date.now()) map.delete(key);
    if (map.size >= 32) return false;
    map.set(owner, { ...value, expires: Date.now() + 5 * 60 * 1000 });
    return true;
}

function repriceRecoveryConfig(saved) {
    if (saved.config) return saved.config;
    // V1 journals predate configurable rules. Use only the IDs captured in the
    // original journal; the legacy setup key and current defaults are not needed.
    const old = JSON.parse(saved.configKey || 'null');
    if (!old || !['orderId', 'baseTypeId', 'targetTypeId'].every(key =>
        typeof old[key] === 'string' && MEMCHAT_REPRICE_UUID.test(old[key])) || old.baseTypeId === old.targetTypeId) {
        throw Error('Журнал недоступен');
    }
    return { orderId: old.orderId, baseTypeId: old.baseTypeId, targetTypeId: old.targetTypeId,
        targetTypeName: saved.journal.intent?.priceType?.name };
}

function repriceUnfinished(record) {
    return !!record && (record.journal?.intent != null || !['verified', 'interrupted', 'failed'].includes(record.journal?.status));
}

function repriceJournalJson(value) {
    return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

async function repriceLoadJournal() {
    await privateStorageReady;
    const record = (await chrome.storage.local.get(MEMCHAT_REPRICE_JOURNAL))[MEMCHAT_REPRICE_JOURNAL];
    if (record === undefined) return null;
    if (!record || typeof record.origin !== 'string' || typeof record.scope !== 'string' || !record.journal
        || !['writing', 'verified', 'uncertain', 'interrupted', 'failed'].includes(record.journal.status)) throw Error('Журнал недоступен');
    return record;
}

async function repriceMessage(message, sender) {
    const action = message.action;
    const refuse = (error, recovery = false) => ({ ok: false, error, recovery });
    const owner = repriceOwner(sender);
    if (!owner || !['preview', 'apply', 'recover', 'settings-load', 'settings-save'].includes(action)) {
        return refuse('Запрос переоценки отклонён.');
    }
    const settings = action.startsWith('settings-');
    const changesState = ['apply', 'recover', 'settings-save'].includes(action);
    if (repriceBusy || repricePending.has(owner)) return refuse('Другой запрос переоценки уже выполняется.');
    const orderId = action === 'preview' ? repriceOrderId(message.orderLink) : null;
    if (action === 'preview') {
        repricePreviews.delete(owner);
        if (!orderId) return refuse('Вставьте ссылку на внутренний заказ из online.moysklad.ru.');
    }
    if (changesState) repriceBusy = true;
    repricePending.add(owner);
    let enteredService = false;
    let runId = null;
    try {
        const credential = await repriceAccess(sender);
        const rulesRecord = action === 'recover' ? null : await repriceLoadRules(credential);
        const revision = rulesRecord?.revision ?? null;
        const isCurrent = async () => {
            if (!await repriceLive(sender, credential.origin)) return false;
            const current = await repriceAccess(sender);
            if (!repriceSameAccount(current, credential) || current.token !== credential.token) return false;
            const latest = action === 'recover' ? null : await repriceLoadRules(current);
            return repriceOwner(sender) === owner && (latest?.revision ?? null) === revision
                && repriceJournalJson(latest?.rules ?? null) === repriceJournalJson(rulesRecord?.rules ?? null);
        };
        const request = async (method, path, body) => {
            const url = new URL(MEMCHAT_REPRICE_API + path);
            if (url.origin !== 'https://api.moysklad.ru' || !/^\/api\/remap\/1\.2\/(?:entity|context)\//.test(url.pathname) || url.hash) throw Error('Invalid API path');
            const response = await performRequest({ id: 'reprice-' + crypto.randomUUID(), request: {
                url: url.href, method, anonymous: true, credentialGuard: true,
                headers: { Authorization: 'Bearer ' + credential.token, Accept: 'application/json;charset=utf-8', ...(body ? { 'Content-Type': 'application/json;charset=utf-8' } : {}) },
                data: body ? JSON.stringify(body) : undefined
            } }, sender, undefined, isCurrent);
            if (response.event !== 'load' || !await isCurrent()) throw Error('Соединение с МойСклад потеряно');
            const status = response.response.status;
            if (status < 200 || status >= 300) { const error = Error('МойСклад: HTTP ' + status); error.status = status; throw error; }
            return method === 'GET' ? JSON.parse(response.response.responseText) : undefined;
        };
        if (settings) {
            if (action === 'settings-load') {
                repriceSettings.delete(owner);
                const types = memchatRepricePriceTypes(await request('GET', MEMCHAT_REPRICE_PRICE_TYPES));
                if (types.size < 2) return refuse('В МойСклад нужны хотя бы два типа цен.');
                const id = crypto.randomUUID();
                if (!repriceRemember(repriceSettings, owner, { id, credential, revision, types, sourceUrl: sender.url })) {
                    return refuse('Слишком много открытых настроек. Повторите позже.');
                }
                return { ok: true, id, rules: rulesRecord?.rules || MEMCHAT_REPRICE_DEFAULTS,
                    priceTypes: Array.from(types, ([id, name]) => ({ id, name })) };
            }
            const opened = repriceSettings.get(owner);
            if (message.confirmed !== true || !opened || opened.id !== message.id || opened.expires < Date.now()
                || !repriceSameAccount(opened.credential, credential) || opened.credential.token !== credential.token
                || opened.revision !== revision || opened.sourceUrl !== sender.url) return refuse('Настройки устарели. Загрузите типы цен заново.');
            const { baseTypeId, targetTypeId } = message.rules ?? {};
            if (!opened.types.has(baseTypeId) || !opened.types.has(targetTypeId) || baseTypeId === targetTypeId) {
                return refuse('Выберите два разных типа цен из справочника.');
            }
            let formula;
            try { formula = memchatRepriceFormula(message.rules); } catch (error) { return refuse(error.message); }
            const rules = { baseTypeId, baseTypeName: opened.types.get(baseTypeId), targetTypeId,
                targetTypeName: opened.types.get(targetTypeId), ...formula };
            const key = repriceRulesKey(credential.origin);
            const expected = { scope: credential.scope, revision: crypto.randomUUID(), rules };
            if (!await isCurrent()) return refuse('Настройки устарели. Загрузите типы цен заново.');
            repriceSettings.delete(owner);
            await chrome.storage.local.set({ [key]: expected });
            if (repriceJournalJson((await chrome.storage.local.get(key))[key]) !== repriceJournalJson(expected)) {
                return refuse('Сохранение правил не подтверждено. Откройте настройки заново.');
            }
            return { ok: true, rules };
        }
        const saved = await repriceLoadJournal();
        const unfinished = repriceUnfinished(saved);
        if (unfinished && !repriceSameAccount(saved, credential)) {
            return refuse('Есть незавершённая переоценка. Для проверки нужен прежний профиль Bearer.');
        }
        if (unfinished && action !== 'recover') return refuse('Незавершённая переоценка. Сначала проверьте запись в МойСклад.', true);
        if (action === 'recover' && !unfinished) return { ok: true, status: 'none', verified: 0 };
        if (action !== 'recover' && !rulesRecord) return refuse('Выберите и сохраните типы цен в настройках переоценки.');
        const preview = action === 'apply' ? repricePreviews.get(owner) : null;
        if (action === 'apply' && (message.confirmed !== true || !preview || message.id !== preview.id || preview.expires < Date.now()
            || !repriceSameAccount(preview.credential, credential) || preview.credential.token !== credential.token
            || preview.revision !== revision || preview.sourceUrl !== sender.url
            || repriceJournalJson(preview.rules) !== repriceJournalJson(rulesRecord.rules))) {
            return refuse('Предпросмотр устарел или не подтверждён. Загрузите его снова.');
        }
        const config = action === 'recover' ? repriceRecoveryConfig(saved) : { ...rulesRecord.rules, orderId: orderId || preview.orderId };
        const read = path => request('GET', path);
        runId = action === 'recover' ? saved.run : crypto.randomUUID();
        let durableIntent = null;
        const persist = async journal => {
            const expected = { origin: credential.origin, scope: credential.scope, config, run: runId, journal };
            const encoded = repriceJournalJson(expected);
            if (encoded.length > 1024 * 1024) throw Error('Журнал слишком большой');
            await chrome.storage.local.set({ [MEMCHAT_REPRICE_JOURNAL]: JSON.parse(encoded) });
            const committed = (await chrome.storage.local.get(MEMCHAT_REPRICE_JOURNAL))[MEMCHAT_REPRICE_JOURNAL];
            if (repriceJournalJson(committed) !== encoded) throw Error('Журнал не подтверждён');
            durableIntent = journal.intent ? { path: journal.intent.path, value: journal.intent.new } : null;
            return committed.journal;
        };
        const service = createMemchatRepriceService(config);
        if (action === 'preview') {
            const data = await service.plan(read);
            if (data.entries.length + data.skipped.length > 500) return refuse('В заказе больше 500 карточек. Переоценка не запущена.');
            if (!await isCurrent() || repriceBusy) return refuse('План устарел. Обновите предпросмотр.');
            const id = crypto.randomUUID();
            if (!repriceRemember(repricePreviews, owner, { id, data, credential, orderId, revision, rules: rulesRecord.rules, sourceUrl: sender.url })) {
                return refuse('Слишком много активных предпросмотров. Повторите через несколько минут.');
            }
            return { ok: true, id, orderName: data.orderName, baseName: config.baseTypeName, targetName: config.targetTypeName,
                entries: data.entries.map(({ id, name, base, old, new: next }) => ({ id, name, base, old, next })), skipped: data.skipped };
        }
        if (!await isCurrent()) return refuse('Документ или настройки изменились. Повторите проверку.', unfinished);
        if (action === 'recover') {
            const outcome = await service.reconcile(saved.journal, { read, persist });
            const latest = await repriceLoadJournal();
            return { ok: true, status: latest?.journal.status || outcome?.status, verified: latest?.journal.verified || 0,
                recovery: repriceUnfinished(latest) };
        }
        repricePreviews.delete(owner);
        const changes = new Map(preview.data.entries.filter(entry => entry.new !== entry.old)
            .map(entry => ['/entity/product/' + entry.id, entry.new]));
        if (!changes.size) return refuse('В предпросмотре нет изменений.');
        const write = (path, body) => {
            const line = body?.salePrices?.[0];
            if (!/^\/entity\/product\/[a-f0-9-]{36}$/i.test(path) || !changes.has(path)
                || durableIntent?.path !== path || durableIntent.value !== line?.value
                || Object.keys(body || {}).length !== 1 || !Array.isArray(body.salePrices) || body.salePrices.length !== 1
                || Object.keys(line || {}).length !== 3 || line.value !== changes.get(path)
                || !Number.isSafeInteger(line.value) || line.value <= 0
                || line.priceType?.meta?.href !== 'https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/' + config.targetTypeId
                || !/^https:\/\/api\.moysklad\.ru\/api\/remap\/1\.2\/entity\/currency\/[a-f0-9-]{36}$/i.test(line.currency?.meta?.href)) throw Error('Недопустимая запись ценника');
            changes.delete(path); // No second PUT even if its first response is ambiguous.
            durableIntent = null;
            return request('PUT', path, body);
        };
        enteredService = true;
        const journal = await service.apply(preview.data, { read, write, persist });
        const stored = await repriceLoadJournal();
        const recovery = repriceUnfinished(stored);
        const verified = journal.verified;
        const error = recovery ? 'Запуск не завершён. Проверьте незавершённую запись в МойСклад.'
            : journal.error === 'stale-preview' ? 'План изменился. Загрузите новый предпросмотр.'
                : verified ? `Переоценка остановлена. Сверено до остановки: ${verified}. Загрузите свежий предпросмотр.`
                    : 'Переоценка не завершена. Проверьте данные и доступ МойСклад.';
        return { ok: journal.status === 'verified', status: journal.status, verified: journal.verified,
            checked: journal.checked, changed: journal.changed, recovery,
            ...(journal.status === 'verified' ? {} : { error }) };
    } catch (error) {
        if (settings) return refuse(Number.isInteger(error?.status) ? 'МойСклад: HTTP ' + error.status + '. Проверьте доступ Bearer.'
            : 'Не удалось загрузить или сохранить правила. Проверьте доступ Bearer и откройте настройки заново.');
        const saved = await repriceLoadJournal().catch(() => null);
        const unresolved = repriceUnfinished(saved);
        const partial = enteredService && saved?.run === runId && saved.journal.verified > 0;
        const status = error?.status;
        return { ...refuse(unresolved ? 'Запуск не завершён. Перед повтором проверьте журнал: часть цен могла измениться.'
            : partial ? 'Переоценка выполнена частично. Загрузите свежий предпросмотр.'
                : error?.code === 'pricetype-context' ? 'Тип цены изменился. Откройте и сохраните настройки переоценки заново.'
                : Number.isInteger(status) ? 'МойСклад: HTTP ' + status + '. Проверьте доступ и план.'
                : enteredService ? 'План устарел или не подтверждён. Загрузите новый предпросмотр.'
                    : 'Не удалось проверить заказ, Bearer или журнал переоценки.', unresolved || enteredService),
            ...(unresolved || partial ? { verified: saved?.journal?.verified || 0 } : {}) };
    } finally {
        repricePending.delete(owner);
        if (changesState) repriceBusy = false;
    }
}
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
    if (['memchat:reprice', 'memchat:sales-settings-get', 'memchat:sales-settings-save'].includes(message?.type)) {
        if (!(trustedContentSender(sender) || trustedNativeRuntimeSender(sender))) {
            sendResponse({ ok: false, error: 'Запрос переоценки отклонён.' });
            return false;
        }
        const operation = message.type === 'memchat:reprice' ? repriceMessage(message, sender) : salesSettingsMessage(message, sender);
        operation.then(sendResponse,
            () => sendResponse({ ok: false, error: 'Переоценка недоступна.', recovery: true }));
        return true;
    }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL2RlYnVnLWxvZy5qcyIsImV4dGVuc2lvbi93b3JrZXIvbmV0d29yay5qcyIsImV4dGVuc2lvbi93b3JrZXIvcGFuZWwtc2Vzc2lvbi5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXItYWxlcnRzLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci9vcmRlcnMuanMiLCJleHRlbnNpb24vbmF0aXZlLXJ1bnRpbWUtd29ya2VyLmpzIiwiZXh0ZW5zaW9uL2hpc3Rvcnktd29ya2VyLmpzIiwiZXh0ZW5zaW9uL3NpZGViYXItd29ya2VyLmpzIiwic3JjL2ZlYXR1cmVzL3JlcHJpY2Uvc2VydmljZS5qcyIsImV4dGVuc2lvbi93b3JrZXIvcmVwcmljZS5qcyIsImV4dGVuc2lvbi93b3JrZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBQcml2YXRlIHN0b3JhZ2UgaXMgb3JpZ2luLXNjb3BlZCB0byBwcmVzZXJ2ZSBleGlzdGluZyBzaXRlL2FjY291bnQgc2VwYXJhdGlvbi5cbi8vIENocm9tZSBvd25zIHBlcnNpc3RlbmNlOyBwYWdlIGxvY2FsU3RvcmFnZSBpcyB1c2VkIG9ubHkgZm9yIG9uZS10aW1lIG1pZ3JhdGlvbi5cbmNvbnN0IHByaXZhdGVTdG9yYWdlUmVhZHkgPSAoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldEFjY2Vzc0xldmVsKHsgYWNjZXNzTGV2ZWw6ICdUUlVTVEVEX0NPTlRFWFRTJyB9KTtcbn0pKCk7XG4vLyBIYW5kbGUgaW5pdGlhbGl6YXRpb24gcmVqZWN0aW9uIGltbWVkaWF0ZWx5LCB3aGlsZSByZXRhaW5pbmcgZmFpbC1jbG9zZWQgYXdhaXRzLlxucHJpdmF0ZVN0b3JhZ2VSZWFkeS5jYXRjaCgoKSA9PiB7fSk7XG5sZXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycyA9IG5ldyBNYXAoKTtcbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtidWNrZXQudmVyc2lvbiwgT2JqZWN0LmtleXMoYnVja2V0Lml0ZW1zKS5zb3J0KCkubWFwKGtleSA9PlxuICAgICAgICBba2V5LCBidWNrZXQuaXRlbXNba2V5XS5yZXZpc2lvbiwgYnVja2V0Lml0ZW1zW2tleV0udmFsdWVdKSxcbiAgICBPYmplY3Qua2V5cyhidWNrZXQubGVnYWN5QmFja3VwIHx8IHt9KS5zb3J0KCkubWFwKGtleSA9PiBba2V5LCBidWNrZXQubGVnYWN5QmFja3VwW2tleV1dKSxcbiAgICAoYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBbZW50cnkuaWQsIGVudHJ5LmtleSwgZW50cnkudmFsdWUsIGVudHJ5LmRvY3VtZW50LCBlbnRyeS5yZXZpc2lvbl0pLFxuICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fCBbXV0pO1xufVxuLy8gUHJpdmF0ZSB2YXJpYW50cyBhcHBlbmQgbm9ybWFsbHk7IG9ubHkgZXhwbGljaXQgY29uZmlybWVkIHBydW5lIGRlbGV0ZXMgb25lLlxuLy8gTm8gYXV0b21hdGljIGV2aWN0aW9uOiBleGhhdXN0aW9uIGZhaWxzIGNsb3NlZCxcbi8vIGFuZCBjb250ZW50IG11c3QgZXhwbGljaXRseSB3YXJuIHRoYXQgdGhlIG5ld2VzdCBlZGl0IGlzIE5PVCB5ZXQgZHVyYWJsZS5cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCkge1xuICAgIGJ1Y2tldC5yZWNvdmVyaWVzIHx8PSBbXTtcbiAgICBjb25zdCBleGlzdGluZyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbmQoZW50cnkgPT4gZW50cnkua2V5ID09PSBrZXkgJiYgZW50cnkudmFsdWUgPT09IHZhbHVlXG4gICAgICAgICYmIGVudHJ5LmRvY3VtZW50ID09PSBkb2N1bWVudCAmJiBlbnRyeS5yZXZpc2lvbiA9PT0gcmV2aXNpb24pO1xuICAgIGlmIChleGlzdGluZykgcmV0dXJuO1xuICAgIGlmIChidWNrZXQucmVjb3Zlcmllcy5sZW5ndGggPj0gMTI4KSB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ2NhcGFjaXR5JywgZGV0YWlsOiB7IGtleSB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1JlY292ZXJ5IGNhcGFjaXR5IGV4aGF1c3RlZCcpO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLmJ1Y2tldC5yZWNvdmVyaWVzLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpICsgMTtcbiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGlkKSkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjYXBhY2l0eScsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHRocm93IEVycm9yKCdSZWNvdmVyeSBJRCBleGhhdXN0ZWQnKTtcbiAgICB9XG4gICAgYnVja2V0LnJlY292ZXJ5U2VxdWVuY2UgPSBpZDtcbiAgICBidWNrZXQucmVjb3Zlcmllcy5wdXNoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCB9KTtcbiAgICBpZiAoSlNPTi5zdHJpbmdpZnkoYnVja2V0LnJlY292ZXJpZXMpLmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjYXBhY2l0eScsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHRocm93IEVycm9yKCdSZWNvdmVyeSBjYXBhY2l0eSBleGhhdXN0ZWQnKTtcbiAgICB9XG59XG5mdW5jdGlvbiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIHtcbiAgICAvLyBOZXZlciBzZW5kIHJlY292ZXJ5IHZhbHVlcyAoZXNwZWNpYWxseSBjcmVkZW50aWFscy9oaXN0b3J5KSBpbnRvIGEgdmlldy5cbiAgICByZXR1cm4gKGJ1Y2tldC5yZWNvdmVyaWVzIHx8IFtdKS5tYXAoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uIH0pID0+ICh7IGlkLCBrZXksIGRlbGV0ZWQ6IHZhbHVlID09PSBudWxsLCByZXZpc2lvbiB9KSk7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpIHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGJ1Y2tldCB9KTtcbiAgICBjb25zdCBjb21taXR0ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICBpZiAoIWNvbW1pdHRlZCB8fCBwcml2YXRlU3RvcmFnZVNuYXBzaG90KGNvbW1pdHRlZCkgIT09IHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICd2ZXJpZmljYXRpb24nLCBkZXRhaWw6IHt9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1N0b3JhZ2UgdmVyaWZpY2F0aW9uIGZhaWxlZCcpO1xuICAgIH1cbiAgICByZXR1cm4gY29tbWl0dGVkO1xufVxuYXN5bmMgZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGF1dGhvcml6YXRpb24pIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ2hhaW47XG4gICAgY29uc3Qga2V5ID0gJ21lbWNoYXRQcml2YXRlX3YxOicgKyBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgY29uc3QgYXBpID0gSlNPTi5wYXJzZShzYXZlZD8uaXRlbXNbJ21lbWNoYXQ6aGFja2VyTXNBcGlfdjEnXT8udmFsdWUgfHwgJ3t9Jyk7XG4gICAgcmV0dXJuIGFwaS5iZWFyZXJFbmFibGVkID09PSB0cnVlICYmIHR5cGVvZiBhcGkudG9rZW4gPT09ICdzdHJpbmcnICYmIGF1dGhvcml6YXRpb24gPT09ICdCZWFyZXIgJyArIGFwaS50b2tlbjtcbn1cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBvcGVyYXRpb24gPSBwcml2YXRlU3RvcmFnZUNoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgICAgIGNvbnN0IHN0b3JhZ2VLZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIG9yaWdpbjtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICAgICAgY29uc3QgYnVja2V0ID0gc2F2ZWQgfHwgeyB2ZXJzaW9uOiAxLCBpdGVtczoge30sIGxlZ2FjeUJhY2t1cDoge30gfTtcbiAgICAgICAgaWYgKGJ1Y2tldC52ZXJzaW9uICE9PSAxIHx8ICFidWNrZXQuaXRlbXMgfHwgdHlwZW9mIGJ1Y2tldC5pdGVtcyAhPT0gJ29iamVjdCcpIHRocm93IEVycm9yKCdJbnZhbGlkIHNjaGVtYScpO1xuICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLWluaXQnKSB7XG4gICAgICAgICAgICBjb25zdCBsZWdhY3kgPSBtZXNzYWdlLmxlZ2FjeTtcbiAgICAgICAgICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpICYmIE9iamVjdC5rZXlzKGxlZ2FjeSB8fCB7fSkubGVuZ3RoKSB0aHJvdyBFcnJvcignTmF0aXZlIHJ1bnRpbWUgY2Fubm90IG1pZ3JhdGUgcGFnZSBkYXRhJyk7XG4gICAgICAgICAgICBpZiAoIWxlZ2FjeSB8fCB0eXBlb2YgbGVnYWN5ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGxlZ2FjeSkpIHRocm93IEVycm9yKCdJbnZhbGlkIGxlZ2FjeSBzbmFwc2hvdCcpO1xuICAgICAgICAgICAgY29uc3QgY2xlYW51cCA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCBba2V5LCByYXddIG9mIE9iamVjdC5lbnRyaWVzKGxlZ2FjeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdmFsdWUnKTtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnY2xlYXJUZXh0RW5hYmxlZCcgJiYgWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMocmF3KSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIU9iamVjdC5oYXNPd24oYnVja2V0Lml0ZW1zLCAnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMobGVnYWN5WydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSkgPyBsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddIDogcmF3O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSA9IHsgdmFsdWUsIHJldmlzaW9uOiAxIH07XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXS52YWx1ZSAhPT0gcmF3KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAuY2xlYXJUZXh0RW5hYmxlZCA9IHJhdztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgeyBjbGVhbnVwLnB1c2goa2V5KTsgY29udGludWU7IH1cbiAgICAgICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgICAgIGlmICghc2F2ZWQpIGJ1Y2tldC5pdGVtc1trZXldID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICBlbHNlIGlmIChidWNrZXQuaXRlbXNba2V5XT8udmFsdWUgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEFuIG9sZGVyIHVzZXJzY3JpcHQgbWF5IHJlY3JlYXRlIG9sZCBrZXlzLiBQcmVzZXJ2ZSB0aGF0IGNvcHlcbiAgICAgICAgICAgICAgICAgICAgLy8gcHJpdmF0ZWx5LCBidXQgbmV2ZXIgcm9sbCBiYWNrIHRoZSBjYW5vbmljYWwgZXh0ZW5zaW9uIHN0YXRlLlxuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cFtrZXldID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNsZWFudXAucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQWNrbm93bGVkZ2Ugb25seSBhZnRlciBDaHJvbWUgY29tbWl0cyBhbmQgYSByZWFkLWJhY2sgdmVyaWZpZXMgaXQuXG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5zZXQoc2VuZGVyLnRhYj8uaWQgPz8gJ25hdGl2ZTonICsgc2VuZGVyLnVybCwgeyBvcmlnaW4sIGRvY3VtZW50SWQ6IHNlbmRlci5kb2N1bWVudElkLCBzZW5kZXIgfSk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaXRlbXM6IGNvbW1pdHRlZC5pdGVtcywgY2xlYW51cCwgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoY29tbWl0dGVkKSB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtcHJ1bmUnKSB7XG4gICAgICAgICAgICAvLyBFeHBsaWNpdCBpcnJldmVyc2libGUgZGVsZXRpb24gb2YgT05FIGltbXV0YWJsZSBJRCwgbmV2ZXIgYSBidWxrIGNsZWFyLlxuICAgICAgICAgICAgLy8gS2VlcCBpdHMgZG9jdW1lbnQgZmVuY2UgYWZ0ZXIgZGVsZXRpb24sIGFuZCBuZXZlciByZWN5Y2xlIElEcyAoc3RhbGUgVUkvYWNrIHJldHJpZXMpLlxuICAgICAgICAgICAgY29uc3Qgc2VxdWVuY2UgPSBNYXRoLm1heChidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSB8fCAwLCAuLi4oYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UuY29uZmlybWVkICE9PSB0cnVlIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmlkKSB8fCBtZXNzYWdlLmlkIDwgMSB8fCBtZXNzYWdlLmlkID4gc2VxdWVuY2UpIHRocm93IEVycm9yKCdJbnZhbGlkIHBydW5lJyk7XG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGJ1Y2tldC5yZWNvdmVyaWVzPy5maW5kKGl0ZW0gPT4gaXRlbS5pZCA9PT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSA9IHNlcXVlbmNlO1xuICAgICAgICAgICAgaWYgKGVudHJ5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5LmRvY3VtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fD0gW107XG4gICAgICAgICAgICAgICAgICAgIGlmICghYnVja2V0LnJlY292ZXJ5RmVuY2VzLnNvbWUoKFtrZXksIGRvY3VtZW50XSkgPT4ga2V5ID09PSBlbnRyeS5rZXkgJiYgZG9jdW1lbnQgPT09IGVudHJ5LmRvY3VtZW50KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LnJlY292ZXJ5RmVuY2VzLnB1c2goW2VudHJ5LmtleSwgZW50cnkuZG9jdW1lbnRdKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBidWNrZXQucmVjb3ZlcmllcyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbHRlcihpdGVtID0+IGl0ZW0uaWQgIT09IG1lc3NhZ2UuaWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgY29tbWl0dGVkID0gYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDb21taXQoc3RvcmFnZUtleSwgYnVja2V0KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChjb21taXR0ZWQpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFsnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJywgJ21lbWNoYXQ6c3RvcmFnZS1yZXN0b3JlJ10uaW5jbHVkZXMobWVzc2FnZS50eXBlKSkge1xuICAgICAgICAgICAgY29uc3QgcmVzdG9yaW5nID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnO1xuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcnkgPSByZXN0b3JpbmcgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5pZClcbiAgICAgICAgICAgICAgICAmJiBidWNrZXQucmVjb3Zlcmllcz8uZmluZChlbnRyeSA9PiBlbnRyeS5pZCA9PT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmICFyZWNvdmVyeSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcmVjb3ZlcnknKTtcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlc3RvcmluZyA/IHJlY292ZXJ5LmtleSA6IG1lc3NhZ2Uua2V5LCByZXZpc2lvbiA9IG1lc3NhZ2UucmV2aXNpb247XG4gICAgICAgICAgICBjb25zdCByYXcgPSByZXN0b3JpbmcgPyByZWNvdmVyeS52YWx1ZSA6IG1lc3NhZ2UudmFsdWU7XG4gICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihyZXZpc2lvbikgfHwgcmV2aXNpb24gPCAwXG4gICAgICAgICAgICAgICAgfHwgcmV2aXNpb24gPj0gTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVJcbiAgICAgICAgICAgICAgICB8fCAocmF3ICE9PSBudWxsICYmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHdyaXRlJyk7XG4gICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGJ1Y2tldC5pdGVtc1trZXldIHx8IHsgdmFsdWU6IG51bGwsIHJldmlzaW9uOiAwIH07XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IHJhdyA9PT0gbnVsbCA/IG51bGwgOiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgcmF3KTtcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gc2VuZGVyLmRvY3VtZW50SWQgfHwgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgPyAnbmF0aXZlOicgKyBzZW5kZXIudXJsIDogJ3RhYjonICsgc2VuZGVyLnRhYi5pZCk7XG4gICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSBkb2N1bWVudCBmZW5jZSB3aXRoIHRoZSBmaXJzdCBjb25mbGljdC4gQWxyZWFkeSBzZW50XG4gICAgICAgICAgICAvLyBvcHRpbWlzdGljIHdyaXRlcyBjYW5ub3QgYWNjaWRlbnRhbGx5IG92ZXJ3cml0ZSB0aGUgd2lubmVyIGxhdGVyLFxuICAgICAgICAgICAgLy8gaW5jbHVkaW5nIGFmdGVyIHdvcmtlciBzdXNwZW5zaW9uLiBSZWxvYWQgY3JlYXRlcyBhIG5ldyBkb2N1bWVudC5cbiAgICAgICAgICAgIGNvbnN0IGJsb2NrZWQgPSAhcmVzdG9yaW5nICYmIChidWNrZXQucmVjb3Zlcmllcz8uc29tZShlbnRyeSA9PiBlbnRyeS5rZXkgPT09IGtleSAmJiBlbnRyeS5kb2N1bWVudCA9PT0gZG9jdW1lbnQpXG4gICAgICAgICAgICAgICAgfHwgYnVja2V0LnJlY292ZXJ5RmVuY2VzPy5zb21lKChbZmVuY2VkS2V5LCBmZW5jZWREb2N1bWVudF0pID0+IGZlbmNlZEtleSA9PT0ga2V5ICYmIGZlbmNlZERvY3VtZW50ID09PSBkb2N1bWVudCkpO1xuICAgICAgICAgICAgLy8gQSBjb25jdXJyZW50IHdyaXRlciBtYXkgaGF2ZSBjb21taXR0ZWQgdGhlIGlkZW50aWNhbCBkZXNpcmVkIHZhbHVlLlxuICAgICAgICAgICAgLy8gT25seSBhY2NlcHQgdGhlIGltbWVkaWF0ZWx5IHByZWNlZGluZyByZXZpc2lvbiBzbyBvcHRpbWlzdGljIHF1ZXVlZFxuICAgICAgICAgICAgLy8gd3JpdGVzIGNvbnRpbnVlIGZyb20gdGhlIHJldmlzaW9uIHRoZSBjb250ZW50IGFkYXB0ZXIgcHJlZGljdGVkLlxuICAgICAgICAgICAgaWYgKCFibG9ja2VkICYmICFyZXN0b3JpbmcgJiYgcHJldmlvdXMucmV2aXNpb24gPT09IHJldmlzaW9uICsgMSAmJiBwcmV2aW91cy52YWx1ZSA9PT0gdmFsdWUpIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtOiBwcmV2aW91cyB9O1xuICAgICAgICAgICAgaWYgKGJsb2NrZWQgfHwgcHJldmlvdXMucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IG1lc3NhZ2UucHJldmlvdXNWYWx1ZSAhPT0gcHJldmlvdXMudmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3RvcmluZykge1xuICAgICAgICAgICAgICAgICAgICBwcml2YXRlU3RvcmFnZVJlY292ZXIoYnVja2V0LCBrZXksIHZhbHVlLCByZXZpc2lvbiwgZG9jdW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjb25mbGljdCcsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgcmVjb3ZlcmVkOiB0cnVlLCBrZXksIGl0ZW06IHByZXZpb3VzLFxuICAgICAgICAgICAgICAgICAgICByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmIHByZXZpb3VzLnZhbHVlICE9PSB2YWx1ZSkgcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCBwcmV2aW91cy52YWx1ZSwgcHJldmlvdXMucmV2aXNpb24sIG51bGwpO1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHsgdmFsdWUsIHJldmlzaW9uOiByZXZpc2lvbiArIDEgfTtcbiAgICAgICAgICAgIGJ1Y2tldC5pdGVtc1trZXldID0gaXRlbTtcbiAgICAgICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICAvLyBCZXN0LWVmZm9ydCBwcml2YXRlIGludmFsaWRhdGlvbjsgY2xvc2VkL3JlcGxhY2VkIGRvY3VtZW50cyBhcmUgaWdub3JlZC5cbiAgICAgICAgICAgIGZvciAoY29uc3QgW3RhYklkLCBzdWJzY3JpYmVyXSBvZiBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRhYklkID09PSAoc2VuZGVyLnRhYj8uaWQgPz8gJ25hdGl2ZTonICsgc2VuZGVyLnVybCkgfHwgc3Vic2NyaWJlci5vcmlnaW4gIT09IG9yaWdpbikgY29udGludWU7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB0YWJJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHsgbmF0aXZlUnVudGltZU5vdGlmeShzdWJzY3JpYmVyLnNlbmRlciwgeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnLCBrZXksIGl0ZW0gfSk7IH1cbiAgICAgICAgICAgICAgICAgICAgY2F0Y2ggeyBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSh0YWJJZCk7IH1cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBzdWJzY3JpYmVyLmRvY3VtZW50SWQgPyB7IGRvY3VtZW50SWQ6IHN1YnNjcmliZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiAwIH07XG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1jaGFuZ2VkJywga2V5LCBpdGVtIH0sIG9wdGlvbnMpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZ2V0KHRhYklkKSA9PT0gc3Vic2NyaWJlcikgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUodGFiSWQpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGtleSwgaXRlbSwgLi4uKHJlc3RvcmluZyA/IHsgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoYnVja2V0KSB9IDoge30pIH07XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgRXJyb3IoJ0ludmFsaWQgb3BlcmF0aW9uJyk7XG4gICAgfSk7XG4gICAgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gICAgLy8gQW55IHJlamVjdGVkIHdyaXRlIGlzIHJlZnVzZWQgYmVmb3JlIGl0IGJlY29tZXMgZHVyYWJsZTsga2VlcCB0aGUga2V5IG9ubHksXG4gICAgLy8gbmV2ZXIgdGhlIHZhbHVlIG9yIHRoZSBlcnJvciB0ZXh0LlxuICAgIG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ3JlamVjdGVkJyxcbiAgICAgICAgICAgIGRldGFpbDogeyBrZXk6IHR5cGVvZiBtZXNzYWdlLmtleSA9PT0gJ3N0cmluZycgPyBtZXNzYWdlLmtleS5zbGljZSgwLCAxMjgpIDogbnVsbCB9IH0sICd3b3JrZXInKTtcbiAgICB9KTtcbiAgICByZXR1cm4gb3BlcmF0aW9uO1xufVxuIiwiLy8gRXh0ZW5zaW9uLXdpZGUgcmluZyBidWZmZXIgc2hhcmVkIGJ5IHRoZSB3b3JrZXIsIHRoZSBuYXRpdmUgcGFuZWwgYW5kIHRoZVxuLy8gY29udGVudCB3b3JsZC4gSXQgbGl2ZXMgaW4gY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbiBzbyB3b3JrZXIgc3VzcGVuc2lvbiBkb2VzXG4vLyBub3QgbG9zZSB0aGUgdHJhaWwgd2hpbGUgdGhlIGJyb3dzZXIgc3RheXMgb3Blbi4gTmV2ZXIgcHJlZmVyIGxvY2FsIHN0b3JhZ2U6XG4vLyB0aGUgbG9nIGlzIGRpYWdub3N0aWMgZGF0YSwgbm90IGR1cmFibGUgc3RhdGUsIGFuZCBtYXkgYmUgZXhwb3J0ZWQgYnkgYSB1c2VyLlxuY29uc3QgTUVNQ0hBVF9ERUJVR19MT0dfS0VZID0gJ21lbWNoYXREZWJ1Z0xvZ192MSc7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZID0gJ21lbWNoYXREZWJ1Z0VuYWJsZWRfdjEnO1xuY29uc3QgTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQgPSA1MDA7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xPR19NQVhfQUdFX01TID0gNyAqIDI0ICogNjAgKiA2MCAqIDEwMDA7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xFVkVMUyA9IE9iamVjdC5mcmVlemUoWydkZWJ1ZycsICdpbmZvJywgJ3dhcm4nLCAnZXJyb3InXSk7XG5jb25zdCBNRU1DSEFUX0RFQlVHX1dPUkxEUyA9IE9iamVjdC5mcmVlemUoWydwYW5lbCcsICdjb250ZW50JywgJ3J1bnRpbWUnLCAnd29ya2VyJ10pO1xuY29uc3QgTUVNQ0hBVF9ERUJVR19TRUNSRVRfS0VZID0gL3Rva2VufHBhc3N3b3JkfGF1dGhvcml6YXRpb258Y29va2llfHNlY3JldHxjcmVkZW50aWFsfGNzcmZ8YXBpa2V5fGFwaV9rZXl8c2Vzc2lvbnxiZWFyZXJ8c2lnbmF0dXJlfHByaXZhdGUvaTtcbi8vIFF1ZXJ5IHN0cmluZ3MgY2FycnkgYmVhcmVyLWxpa2UgdmFsdWVzICg/dG9rZW49LCA/YWNjZXNzX3Rva2VuPSwgc2lnbmVkIFVSTHMpXG4vLyBhbmQgdGhlIHBhdGggY2FuIGVtYmVkIGEgc2Vzc2lvbiBpZDsga2VlcCBvbmx5IG9yaWdpbitwYXRobmFtZSBmb3IgZGlhZ25vc3RpY3MuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdTYWZlVXJsKHJhdykge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoU3RyaW5nKHJhdykpO1xuICAgICAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyAmJiB1cmwucHJvdG9jb2wgIT09ICdodHRwOicpIHJldHVybiAnW1VSTF0nO1xuICAgICAgICByZXR1cm4gdXJsLm9yaWdpbiArIHVybC5wYXRobmFtZTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuICdbVVJMXSc7IH1cbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnU2FuaXRpemUodmFsdWUsIGtleSA9ICcnLCBkZXB0aCA9IDApIHtcbiAgICBpZiAoTUVNQ0hBVF9ERUJVR19TRUNSRVRfS0VZLnRlc3Qoa2V5KSkgcmV0dXJuICdbUkVEQUNURURdJztcbiAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJyB8fCB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSByZXR1cm4gdmFsdWU7XG4gICAgaWYgKGRlcHRoID49IDUpIHJldHVybiAnW01BWF9ERVBUSF0nO1xuICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4ge1xuICAgICAgICBuYW1lOiB2YWx1ZS5uYW1lLFxuICAgICAgICBtZXNzYWdlOiBtZW1jaGF0RGVidWdTYW5pdGl6ZShTdHJpbmcodmFsdWUubWVzc2FnZSB8fCAnJyksICdtZXNzYWdlJywgZGVwdGggKyAxKSxcbiAgICAgICAgc3RhY2s6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKFN0cmluZyh2YWx1ZS5zdGFjayB8fCAnJyksICdzdGFjaycsIGRlcHRoICsgMSlcbiAgICB9O1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZVxuICAgICAgICAgICAgLnJlcGxhY2UoL0JlYXJlclxccytbXlxcc1wiJ10rL2dpLCAnQmVhcmVyIFtSRURBQ1RFRF0nKVxuICAgICAgICAgICAgLnJlcGxhY2UoL1xcYig/OmV5SltcXHctXXsxMCx9XFwuW1xcdy1dezEwLH1cXC5bXFx3LV17NSx9KVxcYi9nLCAnW0pXVF0nKVxuICAgICAgICAgICAgLnJlcGxhY2UoL1xcYlswLTlhLWZdezMyLH1cXGIvZ2ksICdbSEVYXScpXG4gICAgICAgICAgICAucmVwbGFjZSgvKD88IVtcXGQrXSkoPzpcXCs/N3w4KVtcXHMoKS4tXSpcXGR7M31bXFxzKCkuLV0qXFxkezN9W1xccygpLi1dKlxcZHsyfVtcXHMoKS4tXSpcXGR7Mn1cXGIvZywgJ1tQSE9ORV0nKVxuICAgICAgICAgICAgLnNsaWNlKDAsIDMwMDApO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5zbGljZSgwLCA0MCkubWFwKGl0ZW0gPT4gbWVtY2hhdERlYnVnU2FuaXRpemUoaXRlbSwga2V5LCBkZXB0aCArIDEpKTtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXModmFsdWUpLnNsaWNlKDAsIDUwKS5mb3JFYWNoKGNoaWxkS2V5ID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkS2V5XSA9IC9eKHVybHxocmVmfG9yaWdpbnxyZWZlcnJlcikkL2kudGVzdChjaGlsZEtleSkgJiYgdHlwZW9mIHZhbHVlW2NoaWxkS2V5XSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAgICAgPyBtZW1jaGF0RGVidWdTYWZlVXJsKHZhbHVlW2NoaWxkS2V5XSlcbiAgICAgICAgICAgICAgICAgICAgOiBtZW1jaGF0RGVidWdTYW5pdGl6ZSh2YWx1ZVtjaGlsZEtleV0sIGNoaWxkS2V5LCBkZXB0aCArIDEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2F0Y2ggeyByZXN1bHRbY2hpbGRLZXldID0gJ1tVTlJFQURBQkxFXSc7IH1cbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcodmFsdWUpLnNsaWNlKDAsIDMwMDApO1xufVxuXG4vLyBJbi1tZW1vcnkgbWlycm9yIG9mIHRoZSBzZXNzaW9uIGJ1ZmZlci4gQWxsIG11dGF0aW9ucyBzaGFyZSBvbmUgcHJvbWlzZSBjaGFpblxuLy8gc28gYSBidXJzdCBvZiByZWNvcmRzIGNhbm5vdCBpbnRlcmxlYXZlIGEgcmVhZC1tb2RpZnktd3JpdGUgYW5kIGxvc2UgZW50cmllcy5cbmxldCBtZW1jaGF0RGVidWdFbnRyaWVzID0gW107XG5sZXQgbWVtY2hhdERlYnVnTG9hZGVkID0gZmFsc2U7XG5sZXQgbWVtY2hhdERlYnVnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmxldCBtZW1jaGF0RGVidWdTZXF1ZW5jZSA9IDA7XG5cbmZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0ZyZXNoKGVudHJpZXMpIHtcbiAgICBjb25zdCBjdXRvZmYgPSBEYXRlLm5vdygpIC0gTUVNQ0hBVF9ERUJVR19MT0dfTUFYX0FHRV9NUztcbiAgICByZXR1cm4gKEFycmF5LmlzQXJyYXkoZW50cmllcykgPyBlbnRyaWVzIDogW10pXG4gICAgICAgIC5maWx0ZXIoZW50cnkgPT4gZW50cnkgJiYgdHlwZW9mIGVudHJ5LmF0ID09PSAnbnVtYmVyJyAmJiBlbnRyeS5hdCA+PSBjdXRvZmYpXG4gICAgICAgIC5zbGljZSgtTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtZW1jaGF0RGVidWdIeWRyYXRlKCkge1xuICAgIGlmIChtZW1jaGF0RGVidWdMb2FkZWQpIHJldHVybiBtZW1jaGF0RGVidWdFbnRyaWVzO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KE1FTUNIQVRfREVCVUdfTE9HX0tFWSkpW01FTUNIQVRfREVCVUdfTE9HX0tFWV07XG4gICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChzYXZlZCk7XG4gICAgfSBjYXRjaCB7IG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBbXTsgfVxuICAgIG1lbWNoYXREZWJ1Z0xvYWRlZCA9IHRydWU7XG4gICAgcmV0dXJuIG1lbWNoYXREZWJ1Z0VudHJpZXM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0VuYWJsZWQoKSB7XG4gICAgdHJ5IHsgcmV0dXJuIChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTUVNQ0hBVF9ERUJVR19GTEFHX0tFWSkpW01FTUNIQVRfREVCVUdfRkxBR19LRVldID09PSAndHJ1ZSc7IH1cbiAgICBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBtZW1jaGF0RGVidWdTZXRFbmFibGVkKGVuYWJsZWQpIHtcbiAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhlbmFibGVkID09PSB0cnVlKTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV06IHZhbHVlIH0pO1xuICAgICAgICByZXR1cm4gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZKSlbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV0gPT09IHZhbHVlO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnUmVjb3JkKGVudHJ5LCB3b3JsZCA9ICd3b3JrZXInKSB7XG4gICAgY29uc3Qgd29yayA9IG1lbWNoYXREZWJ1Z0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbGV2ZWwgPSBNRU1DSEFUX0RFQlVHX0xFVkVMUy5pbmNsdWRlcyhlbnRyeT8ubGV2ZWwpID8gZW50cnkubGV2ZWwgOiAnaW5mbyc7XG4gICAgICAgICAgICAvLyBFcnJvcnMgYXJlIGFsd2F5cyBrZXB0OiB0aGV5IGFyZSB3aGF0IGEgdXNlciByZXBvcnRzLiBFdmVyeXRoaW5nXG4gICAgICAgICAgICAvLyBlbHNlIGlzIG9wdC1pbiBiZWNhdXNlIHRoZSBidWZmZXIgaXMgc2hhcmVkIGFuZCBtYXkgYmUgZXhwb3J0ZWQuXG4gICAgICAgICAgICBpZiAobGV2ZWwgIT09ICdlcnJvcicgJiYgIWF3YWl0IG1lbWNoYXREZWJ1Z0VuYWJsZWQoKSkgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IGF3YWl0IG1lbWNoYXREZWJ1Z0h5ZHJhdGUoKTtcbiAgICAgICAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICAgICAgICBlbnRyaWVzLnB1c2goe1xuICAgICAgICAgICAgICAgIGlkOiAnZGwtJyArIG5vdyArICctJyArICgrK21lbWNoYXREZWJ1Z1NlcXVlbmNlKSxcbiAgICAgICAgICAgICAgICBhdDogbm93LFxuICAgICAgICAgICAgICAgIHdvcmxkOiBNRU1DSEFUX0RFQlVHX1dPUkxEUy5pbmNsdWRlcyh3b3JsZCkgPyB3b3JsZCA6ICd3b3JrZXInLFxuICAgICAgICAgICAgICAgIGxldmVsLFxuICAgICAgICAgICAgICAgIHNjb3BlOiB0eXBlb2YgZW50cnk/LnNjb3BlID09PSAnc3RyaW5nJyA/IGVudHJ5LnNjb3BlLnNsaWNlKDAsIDY0KSA6ICdhcHAnLFxuICAgICAgICAgICAgICAgIGV2ZW50OiB0eXBlb2YgZW50cnk/LmV2ZW50ID09PSAnc3RyaW5nJyA/IGVudHJ5LmV2ZW50LnNsaWNlKDAsIDIwMCkgOiAnJyxcbiAgICAgICAgICAgICAgICBkZXRhaWw6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKGVudHJ5Py5kZXRhaWwpXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChlbnRyaWVzKTtcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW01FTUNIQVRfREVCVUdfTE9HX0tFWV06IG1lbWNoYXREZWJ1Z0VudHJpZXMgfSk7IH1cbiAgICAgICAgICAgIGNhdGNoIHsgLyogRGlhZ25vc3RpY3MgbXVzdCBuZXZlciBkaXN0dXJiIHRoZSBvcGVyYXRpb24gYmVpbmcgdHJhY2VkLiAqLyB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBTYW1lOiBhIGJyb2tlbiBidWZmZXIgY2Fubm90IGJyZWFrIGJ1c2luZXNzIGxvZ2ljLiAqLyB9XG4gICAgfSk7XG4gICAgbWVtY2hhdERlYnVnQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yaztcbn1cblxuLy8gRW50cmllcyBhcmUgcmV0dXJuZWQgbmV3ZXN0IGZpcnN0IHNvIGEgcGFzdGVkIGV4Y2VycHQgc3RhcnRzIGF0IHRoZSBsYXRlc3Rcbi8vIGZhaWx1cmUuIGBsaW1pdGAgaXMgY2xhbXBlZCB0byB0aGUgcmluZyBzaXplLlxuZnVuY3Rpb24gbWVtY2hhdERlYnVnUmVhZChvcHRpb25zID0ge30pIHtcbiAgICBjb25zdCB3b3JrID0gbWVtY2hhdERlYnVnQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdFbmFibGVkKCk7XG4gICAgICAgIGxldCBlbnRyaWVzO1xuICAgICAgICB0cnkgeyBlbnRyaWVzID0gbWVtY2hhdERlYnVnRnJlc2goYXdhaXQgbWVtY2hhdERlYnVnSHlkcmF0ZSgpKTsgbWVtY2hhdERlYnVnRW50cmllcyA9IGVudHJpZXM7IH1cbiAgICAgICAgY2F0Y2ggeyBlbnRyaWVzID0gW107IH1cbiAgICAgICAgY29uc3QgbGltaXQgPSBOdW1iZXIuaXNJbnRlZ2VyKG9wdGlvbnM/LmxpbWl0KVxuICAgICAgICAgICAgPyBNYXRoLm1pbihNYXRoLm1heChvcHRpb25zLmxpbWl0LCAxKSwgTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpIDogTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQ7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBlbmFibGVkLCBlbnRyaWVzOiBlbnRyaWVzLnNsaWNlKC1saW1pdCkucmV2ZXJzZSgpIH07XG4gICAgfSk7XG4gICAgbWVtY2hhdERlYnVnQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yay5jYXRjaCgoKSA9PiAoeyBvazogdHJ1ZSwgZW5hYmxlZDogZmFsc2UsIGVudHJpZXM6IFtdIH0pKTtcbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnQ2xlYXIoKSB7XG4gICAgY29uc3Qgd29yayA9IG1lbWNoYXREZWJ1Z0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBtZW1jaGF0RGVidWdFbnRyaWVzID0gW107XG4gICAgICAgIG1lbWNoYXREZWJ1Z0xvYWRlZCA9IHRydWU7XG4gICAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW01FTUNIQVRfREVCVUdfTE9HX0tFWV06IFtdIH0pOyB9XG4gICAgICAgIGNhdGNoIHsgLyogQ2xlYXJpbmcgaXMgYmVzdCBlZmZvcnQuICovIH1cbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgICBtZW1jaGF0RGVidWdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+ICh7IG9rOiB0cnVlIH0pKTtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxuY29uc3QgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcCgpO1xuY29uc3QgcnVsZXNSZWFkeSA9IGNocm9tZS5kZWNsYXJhdGl2ZU5ldFJlcXVlc3QudXBkYXRlU2Vzc2lvblJ1bGVzKHtcbiAgICByZW1vdmVSdWxlSWRzOiBbMSwgMl0sXG4gICAgYWRkUnVsZXM6IFtcbiAgICAgICAgeyBpZDogMSwgcHJpb3JpdHk6IDEsIGFjdGlvbjogeyB0eXBlOiAnbW9kaWZ5SGVhZGVycycsIHJlcXVlc3RIZWFkZXJzOiBbXG4gICAgICAgICAgICB7IGhlYWRlcjogJ09yaWdpbicsIG9wZXJhdGlvbjogJ3NldCcsIHZhbHVlOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIH0sXG4gICAgICAgICAgICB7IGhlYWRlcjogJ1JlZmVyZXInLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcgfVxuICAgICAgICBdIH0sIGNvbmRpdGlvbjogeyBpbml0aWF0b3JEb21haW5zOiBbY2hyb21lLnJ1bnRpbWUuaWRdLCB1cmxGaWx0ZXI6ICd8aHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvJywgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddIH0gfSxcbiAgICAgICAgeyBpZDogMiwgcHJpb3JpdHk6IDIsIGFjdGlvbjogeyB0eXBlOiAnYmxvY2snIH0sIGNvbmRpdGlvbjoge1xuICAgICAgICAgICAgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSxcbiAgICAgICAgICAgIGV4Y2x1ZGVkUmVxdWVzdERvbWFpbnM6IFsuLi5uZXcgU2V0KE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5uZXR3b3JrSG9zdHMubWFwKGhvc3QgPT4gaG9zdC5yZXBsYWNlKC9eXFwqXFwuLywgJycpKSldLFxuICAgICAgICAgICAgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddXG4gICAgICAgIH0gfVxuICAgIF1cbn0pO1xuLy8gRmFpbCBjbG9zZWQ6IGEgZmFpbGVkIEROUiBzZXR1cCBpcyBjYXVnaHQgaGVyZSBhbmQgYmxvY2tzIHN1YnNlcXVlbnQgcmVxdWVzdHMuXG5sZXQgcnVsZUZhaWx1cmUgPSBmYWxzZTtcbnJ1bGVzUmVhZHkuY2F0Y2goKCkgPT4geyBydWxlRmFpbHVyZSA9IHRydWU7IH0pO1xuXG5mdW5jdGlvbiBtYXRjaGVzSG9zdChob3N0bmFtZSwgcGF0dGVybikge1xuICAgIHJldHVybiBwYXR0ZXJuLnN0YXJ0c1dpdGgoJyouJylcbiAgICAgICAgPyBob3N0bmFtZSA9PT0gcGF0dGVybi5zbGljZSgyKSB8fCBob3N0bmFtZS5lbmRzV2l0aCgnLicgKyBwYXR0ZXJuLnNsaWNlKDIpKVxuICAgICAgICA6IGhvc3RuYW1lID09PSBwYXR0ZXJuO1xufVxuXG5mdW5jdGlvbiBhbGxvd2VkVXJsKHJhdykge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5wb3J0XG4gICAgICAgIHx8ICFNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLnNvbWUoaG9zdCA9PiBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIGhvc3QpKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VSTCBub3QgcGVybWl0dGVkJyk7XG4gICAgfVxuICAgIHJldHVybiB1cmw7XG59XG5cbmZ1bmN0aW9uIHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHNlbmRlci50YWI/LmlkKSB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VuZGVyLnVybCk7XG4gICAgICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiBNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcucGFnZU1hdGNoZXMuc29tZShwYXR0ZXJuID0+XG4gICAgICAgICAgICBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIG5ldyBVUkwocGF0dGVybi5yZXBsYWNlKCcqLicsICd3aWxkY2FyZC4nKSkuaG9zdG5hbWUucmVwbGFjZSgnd2lsZGNhcmQuJywgJyouJykpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RLZXkoc2VuZGVyLCBpZCkge1xuICAgIHJldHVybiB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpID8gYG5hdGl2ZToke3NlbmRlci51cmx9OiR7aWR9YCA6IGAke3NlbmRlci50YWIuaWR9OiR7c2VuZGVyLmZyYW1lSWR9OiR7aWR9YDtcbn1cblxuLy8gRGlzcGF0Y2ggTVMgcmVxdWVzdHMgZGlyZWN0bHkuIE9ubHkgYSBmYWlsZWQgcmVhZCB3YWl0cyBmb3IgaXRzIG93biByZXRyeTtcbi8vIG5vIHByb2ZpbGUtd2lkZSBxdW90YSBzdGF0ZSwgcmVzZXJ2YXRpb25zLCBjb25jdXJyZW5jeSBjYXAgb3IgcGFjaW5nLlxuZnVuY3Rpb24gaXNNc0pzb25BcGkodXJsKSB7XG4gICAgcmV0dXJuIHVybC5ob3N0bmFtZSA9PT0gJ2FwaS5tb3lza2xhZC5ydScgJiYgL15cXC9hcGlcXC9yZW1hcFxcLzFcXC4yKD86XFwvfCQpLy50ZXN0KHVybC5wYXRobmFtZSk7XG59XG5mdW5jdGlvbiBtc1JldHJ5RGVsYXkocmVzcG9uc2UsIHRleHQgPSAnJykge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICBsZXQgcXVvdGFFcnJvciA9IGZhbHNlO1xuICAgICAgICB0cnkgeyBxdW90YUVycm9yID0gSlNPTi5wYXJzZSh0ZXh0KT8uZXJyb3JzPy5zb21lKGVycm9yID0+IE51bWJlcihlcnJvci5jb2RlKSA9PT0gMTA3MykgPT09IHRydWU7IH0gY2F0Y2ggeyAvKiBOb3QgSlNPTi4gKi8gfVxuICAgICAgICBpZiAoIVs0MDgsIDQyOV0uaW5jbHVkZXMocmVzcG9uc2Uuc3RhdHVzKSAmJiByZXNwb25zZS5zdGF0dXMgPCA1MDAgJiYgIXF1b3RhRXJyb3IpIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBsb2duZXggPSBOdW1iZXIocmVzcG9uc2U/LmhlYWRlcnMuZ2V0KCdYLUxvZ25leC1SZXRyeS1BZnRlcicpIHx8IDApO1xuICAgIGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZT8uaGVhZGVycy5nZXQoJ1JldHJ5LUFmdGVyJyk7XG4gICAgY29uc3Qgc2Vjb25kcyA9IHJldHJ5QWZ0ZXI/LnRyaW0oKSA/IE51bWJlcihyZXRyeUFmdGVyKSA6IDA7XG4gICAgY29uc3Qgc3RhbmRhcmQgPSBOdW1iZXIuaXNGaW5pdGUoc2Vjb25kcykgPyBzZWNvbmRzICogMTAwMCA6IERhdGUucGFyc2UocmV0cnlBZnRlcikgLSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGRlbGF5ID0gTWF0aC5tYXgoNTAwLCBOdW1iZXIuaXNGaW5pdGUobG9nbmV4KSA/IGxvZ25leCA6IDAsIE51bWJlci5pc0Zpbml0ZShzdGFuZGFyZCkgPyBzdGFuZGFyZCA6IDApO1xuICAgIHJldHVybiBkZWxheTtcbn1cbmZ1bmN0aW9uIG1zV2FpdEZvclJldHJ5KHNpZ25hbCwgZGVsYXkpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgIGxldCByZW1haW5pbmcgPSBkZWxheTtcbiAgICAgICAgbGV0IHRpbWVyO1xuICAgICAgICBjb25zdCBkb25lID0gKCkgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBkb25lKTsgcmVzb2x2ZSgpOyB9O1xuICAgICAgICBjb25zdCBzY2hlZHVsZSA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNodW5rID0gTWF0aC5taW4ocmVtYWluaW5nLCAyMTQ3NDgzNjQ3KTtcbiAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVtYWluaW5nIC09IGNodW5rO1xuICAgICAgICAgICAgICAgIGlmIChyZW1haW5pbmcgPiAwKSBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgICAgIGVsc2UgZG9uZSgpO1xuICAgICAgICAgICAgfSwgY2h1bmspO1xuICAgICAgICB9O1xuICAgICAgICBzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBkb25lLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgZG9uZSgpO1xuICAgICAgICBlbHNlIHNjaGVkdWxlKCk7XG4gICAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1SZXF1ZXN0KG1lc3NhZ2UsIHNlbmRlciwgYmFja2dyb3VuZFNpZ25hbCwgYmFja2dyb3VuZENyZWRlbnRpYWxDdXJyZW50KSB7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UucmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhbGxvd2VkVXJsKHJlcXVlc3Q/LnVybCk7XG4gICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICghWydHRVQnLCAnSEVBRCcsICdQT1NUJywgJ1BVVCcsICdQQVRDSCcsICdERUxFVEUnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ01ldGhvZCBub3QgcGVybWl0dGVkJyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0JvZHkgbXVzdCBiZSB0ZXh0Jyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgYm9keScpO1xuICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSAmJiAhWyd0ZXh0JywgJ2pzb24nXS5pbmNsdWRlcyhyZXF1ZXN0LnJlc3BvbnNlVHlwZSkpIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgcmVzcG9uc2UgdHlwZScpO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycygpO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXF1ZXN0LmhlYWRlcnMgfHwge30pKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGVhZGVyJyk7XG4gICAgICAgIGlmICgvXmF1dGhvcml6YXRpb24kL2kudGVzdChuYW1lKSAmJiB1cmwuaG9zdG5hbWUgIT09ICdhcGkubW95c2tsYWQucnUnKSB0aHJvdyBuZXcgRXJyb3IoJ0F1dGhvcml6YXRpb24gaG9zdCBub3QgcGVybWl0dGVkJyk7XG4gICAgICAgIGlmICgvXihvcmlnaW58cmVmZXJlcnx1c2VyLWFnZW50fGNvb2tpZXxob3N0fGNvbnRlbnQtbGVuZ3RofGNvbm5lY3Rpb258YWNjZXB0LWVuY29kaW5nfHByb3h5LS4qfHNlYy0uKikkL2kudGVzdChuYW1lKSkgY29udGludWU7XG4gICAgICAgIGhlYWRlcnMuc2V0KG5hbWUsIHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgaXNNc0pzb25BcGkodXJsKSAmJiByZXF1ZXN0LmNyZWRlbnRpYWxHdWFyZCAhPT0gdHJ1ZSkgdGhyb3cgRXJyb3IoJ05hdGl2ZSBjcmVkZW50aWFscyBtdXN0IGJlIGd1YXJkZWQnKTtcbiAgICBjb25zdCBrZXkgPSByZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCk7XG4gICAgaWYgKHBlbmRpbmdSZXF1ZXN0cy5oYXMoa2V5KSkgdGhyb3cgbmV3IEVycm9yKCdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IGVudHJ5ID0geyBjb250cm9sbGVyOiBuZXcgQWJvcnRDb250cm9sbGVyKCksIGV2ZW50OiAnJyB9O1xuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoa2V5LCBlbnRyeSk7XG4gICAgY29uc3QgY2FuY2VsQmFja2dyb3VuZCA9ICgpID0+IHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH07XG4gICAgYmFja2dyb3VuZFNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgaWYgKGJhY2tncm91bmRTaWduYWw/LmFib3J0ZWQpIGNhbmNlbEJhY2tncm91bmQoKTtcbiAgICBjb25zdCB0aW1lb3V0ID0gTWF0aC5taW4oMzAwMDAsIE1hdGgubWF4KDEsIE51bWJlcihyZXF1ZXN0LnRpbWVvdXQpIHx8IDMwMDAwKSk7XG4gICAgbGV0IHRpbWVyO1xuICAgIGNvbnN0IGNoZWNrQ3VycmVudCA9IGJhY2tncm91bmRDcmVkZW50aWFsQ3VycmVudCA/IGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHsgaWYgKGF3YWl0IGJhY2tncm91bmRDcmVkZW50aWFsQ3VycmVudCgpKSByZXR1cm47IH0gY2F0Y2ggeyAvKiBGYWlsIGNsb3NlZC4gKi8gfVxuICAgICAgICBlbnRyeS5ldmVudCA9ICdhYm9ydCc7XG4gICAgICAgIGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICB9IDogcmVxdWVzdC5jcmVkZW50aWFsR3VhcmQgPT09IHRydWUgPyBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxldCBjaGVja1RpbWVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgICAgICB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpXG4gICAgICAgICAgICAgICAgICAgID8gbmF0aXZlUnVudGltZVJlcXVlc3QobmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlciksIHsgdHlwZTogJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50JywgaWQ6IG1lc3NhZ2UuaWQgfSlcbiAgICAgICAgICAgICAgICAgICAgOiBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShzZW5kZXIudGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0OnJlcXVlc3QtY3VycmVudCcsIGlkOiBtZXNzYWdlLmlkIH0sIHNlbmRlci5kb2N1bWVudElkID8geyBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiBzZW5kZXIuZnJhbWVJZCB9KSxcbiAgICAgICAgICAgICAgICBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgY2hlY2tUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShudWxsKSwgMTAwMCk7IH0pXG4gICAgICAgICAgICBdKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQ/LmN1cnJlbnQgPT09IHRydWUgJiYgKCFpc01zSnNvbkFwaSh1cmwpIHx8IHR5cGVvZiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50ICE9PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgfHwgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGhlYWRlcnMuZ2V0KCdhdXRob3JpemF0aW9uJykpKSkgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogTWlzc2luZy9pbnZhbGlkYXRlZCBjb250ZW50IHdvcmxkIGZhaWxzIGNsb3NlZC4gKi8gfVxuICAgICAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KGNoZWNrVGltZXIpOyB9XG4gICAgICAgIGVudHJ5LmV2ZW50ID0gJ2Fib3J0JztcbiAgICAgICAgZW50cnkuY29udHJvbGxlci5hYm9ydCgpO1xuICAgIH0gOiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgIGlmIChydWxlRmFpbHVyZSkgdGhyb3cgbmV3IEVycm9yKCdOZXR3b3JrIHJ1bGVzIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgIGlmICh1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmIHBhbmVsU2Vzc2lvbj8udGFiKSB7XG4gICAgICAgICAgICBpZiAoY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBwYW5lbFJlcXVlc3RWaWFUYWIoeyAuLi5yZXF1ZXN0LCBtZXRob2QgfSwgZW50cnkuY29udHJvbGxlci5zaWduYWwpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGNvbnN0IGNhblJldHJ5ID0gaXNNc0pzb25BcGkodXJsKSAmJiBbJ0dFVCcsICdIRUFEJ10uaW5jbHVkZXMobWV0aG9kKSAmJiBhdHRlbXB0ID09PSAwO1xuICAgICAgICAgICAgbGV0IHJldHJ5RGVsYXk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBlbnRyeS5jb250cm9sbGVyO1xuICAgICAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGVudHJ5LmV2ZW50ID0gJ3RpbWVvdXQnOyBjb250cm9sbGVyLmFib3J0KCk7IH0sIHRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLmhyZWYsIHtcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiByZXF1ZXN0LmRhdGEgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogcmVxdWVzdC5hbm9ueW1vdXMgPT09IHRydWUgPyAnb21pdCcgOiAnaW5jbHVkZScsXG4gICAgICAgICAgICAgICAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsIHJlZGlyZWN0OiBpc01zSnNvbkFwaSh1cmwpID8gJ2Vycm9yJyA6ICdmb2xsb3cnXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgLy8gRE5SIGJsb2NrcyByZWRpcmVjdHMgdG8gdW5ncmFudGVkIGhvc3RzIGJlZm9yZSBzZW5kaW5nIGJ5dGVzLlxuICAgICAgICAgICAgICAgIGFsbG93ZWRVcmwocmVzcG9uc2UudXJsIHx8IHVybC5ocmVmKTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHRocm93IG5ldyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IGNhblJldHJ5ID8gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCByZXNwb25zZVRleHQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICAvLyBQYXRoIG9ubHk6IHF1ZXJ5IHN0cmluZ3MgY2FuIGNhcnJ5IHNlYXJjaCB0ZXJtcyBvciBpZGVudGlmaWVycy5cbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID49IDQwMCkgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnbmV0d29yaycsIGV2ZW50OiAnaHR0cC1lcnJvcicsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyB1cmw6IHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWUsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCByZXRyeURlbGF5LCBhdHRlbXB0IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgICAgIGlmIChyZXRyeURlbGF5ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJzZWQgPSByZXNwb25zZVRleHQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyBwYXJzZWQgPSBudWxsOyB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgZXZlbnQ6ICdsb2FkJywgcmVzcG9uc2U6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LCByZXNwb25zZVRleHQsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZTogcGFyc2VkLCByZXNwb25zZUhlYWRlcnM6IFsuLi5yZXNwb25zZS5oZWFkZXJzXS5tYXAoKFtuYW1lLCB2YWx1ZV0pID0+IGAke25hbWV9OiAke3ZhbHVlfWApLmpvaW4oU3RyaW5nLmZyb21DaGFyQ29kZSgxMywgMTApKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbmFsVXJsOiByZXNwb25zZS51cmwgfHwgdXJsLmhyZWYsIHJlYWR5U3RhdGU6IDRcbiAgICAgICAgICAgICAgICAgICAgfSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIGlmIChlbnRyeS5ldmVudCAhPT0gJ2Fib3J0JykgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnbmV0d29yaycsIGV2ZW50OiAnbmV0d29yay1lcnJvcicsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyB1cmw6IHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWUsIHN0YXR1czogbnVsbCwgcmV0cnlEZWxheTogY2FuUmV0cnkgPyA1MDAgOiBudWxsLCBhdHRlbXB0IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgICAgIGlmICghY2FuUmV0cnkgfHwgZW50cnkuZXZlbnQgPT09ICdhYm9ydCcpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgICAgICAgICAgICAgIHJldHJ5RGVsYXkgPSA1MDA7XG4gICAgICAgICAgICB9IGZpbmFsbHkgeyBjbGVhclRpbWVvdXQodGltZXIpOyB9XG4gICAgICAgICAgICAvLyBBIHRpbWVvdXQgYWJvcnRzIGl0cyBhdHRlbXB0LCBub3QgdGhlIG5leHQgb25lLiBFeHBsaWNpdCBhYm9ydHMgYW5kXG4gICAgICAgICAgICAvLyBjcmVkZW50aWFsIGNoYW5nZXMgc3RpbGwgY2FuY2VsIHRoaXMgd2FpdCBhbmQgc3VwcHJlc3MgdGhlIHJldHJ5LlxuICAgICAgICAgICAgZW50cnkuZXZlbnQgPSAnJztcbiAgICAgICAgICAgIGVudHJ5LmNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgICAgICBhd2FpdCBtc1dhaXRGb3JSZXRyeShlbnRyeS5jb250cm9sbGVyLnNpZ25hbCwgcmV0cnlEZWxheSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHsgZXZlbnQ6IGVudHJ5LmV2ZW50IHx8ICdlcnJvcicsIGVycm9yOiAn0J7RiNC40LHQutCwINGB0LXRgtC4INGA0LDRgdGI0LjRgNC10L3QuNGPIE1lbWNoYXQnIH07XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgYmFja2dyb3VuZFNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kKTtcbiAgICAgICAgcGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShrZXkpO1xuICAgIH1cbn1cbiIsIi8vIEEgc2luZ2xlIHdvcmtlciBvd25zIHRoZSBQYW5lbCB0b2tlbi4gTmV2ZXIgcGVyc2lzdCBpdCBpbnRvIHBhZ2Ugc3RvcmFnZS5cbmNvbnN0IFBBTkVMX1NFU1NJT05fVFRMID0gMTIgKiA2MCAqIDEwMDA7XG5jb25zdCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQgPSAxNTAwMDtcbmxldCBwYW5lbFNlc3Npb24gPSBudWxsO1xubGV0IG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbmxldCBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuXG5mdW5jdGlvbiBleHRyYWN0UGFuZWxTZXNzaW9uVG9rZW4oaHRtbCkge1xuICAgIGNvbnN0IGNsZWFuID0gaHRtbC5yZXBsYWNlKC88IS0tW1xcc1xcU10qPy0tPnw8c2NyaXB0XFxiW14+XSo+W1xcc1xcU10qPzxcXC9zY3JpcHRcXHMqPi9naSwgJycpO1xuICAgIGlmICgvPGlucHV0XFxiW14+XSpcXGJ0eXBlXFxzKj1cXHMqW1wiJ10/cGFzc3dvcmRcXGIvaS50ZXN0KGNsZWFuKSkgcmV0dXJuICcnO1xuICAgIGZvciAoY29uc3QgdGFnIG9mIGNsZWFuLm1hdGNoKC88bWV0YVxcYltePl0qPi9naSkgfHwgW10pIHtcbiAgICAgICAgY29uc3QgYXR0cnMgPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBtYXRjaCBvZiB0YWcubWF0Y2hBbGwoLyhbXFx3LV0rKVxccyo9XFxzKig/OlwiKFteXCJdKilcInwnKFteJ10qKScpL2cpKSB7XG4gICAgICAgICAgICBhdHRyc1ttYXRjaFsxXS50b0xvd2VyQ2FzZSgpXSA9IG1hdGNoWzJdID8/IG1hdGNoWzNdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhdHRycy5uYW1lPy50b0xvd2VyQ2FzZSgpID09PSAnY3NyZi10b2tlbicgJiYgL15bQS1aYS16MC05Xy1dezE2LDUxMn0kLy50ZXN0KGF0dHJzLmNvbnRlbnQgfHwgJycpKSByZXR1cm4gYXR0cnMuY29udGVudDtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xufVxuXG5sZXQgcGFuZWxUYWJTZXF1ZW5jZSA9IDA7XG5mdW5jdGlvbiBwYW5lbFRhYlVybChyYXcpIHtcbiAgICB0cnkgeyBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7IHJldHVybiB1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmICF1cmwudXNlcm5hbWUgJiYgIXVybC5wYXNzd29yZCAmJiAhL15cXC9sb2dpblxcLz8kLy50ZXN0KHVybC5wYXRobmFtZSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuZnVuY3Rpb24gcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXF1ZXN0Py51cmwpLCBtZXRob2QgPSBTdHJpbmcocmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIHJldHVybiBwYW5lbFRhYlVybCh1cmwuaHJlZikgJiYgIXVybC5oYXNoICYmICF1cmwuc2VhcmNoICYmICgobWV0aG9kID09PSAnR0VUJ1xuICAgICAgICAgICAgJiYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2VhcmNoL2ZpbHRlcnMnIHx8IC9eXFwvYXBpXFwvYm9udXNlc1xcL2NoZWNrXFwvXFxkezEsMjB9JC8udGVzdCh1cmwucGF0aG5hbWUpKSlcbiAgICAgICAgICAgIHx8IChtZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaCcgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSA9PT0gJ3N0cmluZycgJiYgcmVxdWVzdC5kYXRhLmxlbmd0aCA8PSAzMjc2OCkpO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiTWVzc2FnZSh0YWJJZCwgcGF5bG9hZCwgc2lnbmFsKSB7XG4gICAgY29uc3QgaWQgPSAncGFuZWwtJyArIERhdGUubm93KCkgKyAnLScgKyAoKytwYW5lbFRhYlNlcXVlbmNlKTtcbiAgICBsZXQgdGltZXIsIGFib3J0O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgICAgIGFib3J0ID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6ICdtZW1jaGF0OnBhbmVsLXRhYicsIGlkLCBvcGVyYXRpb246ICdjYW5jZWwnIH0sIHsgZnJhbWVJZDogMCB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZShudWxsKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoYWJvcnQsIFBBTkVMX1NFU1NJT05fVElNRU9VVCk7XG4gICAgICAgICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgYWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChzaWduYWw/LmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5yYWNlKFtjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgLi4ucGF5bG9hZCB9LCB7IGZyYW1lSWQ6IDAgfSksIHRpbWVvdXRdKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0KTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gcmVjb3ZlclBhbmVsRnJvbVRhYihzaWduYWwpIHtcbiAgICBpZiAoIWNocm9tZS50YWJzPy5xdWVyeSB8fCAhY2hyb21lLnRhYnM/LmdldCB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFicyA9IChhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1LyonIH0pKS5maWx0ZXIodGFiID0+IE51bWJlci5pc0ludGVnZXIodGFiLmlkKSAmJiBwYW5lbFRhYlVybCh0YWIudXJsKSk7XG4gICAgICAgIHRhYnMuc29ydCgoYSwgYikgPT4gTnVtYmVyKCEhYi5hY3RpdmUpIC0gTnVtYmVyKCEhYS5hY3RpdmUpIHx8IChiLmxhc3RBY2Nlc3NlZCB8fCAwKSAtIChhLmxhc3RBY2Nlc3NlZCB8fCAwKSB8fCBhLmlkIC0gYi5pZCk7XG4gICAgICAgIGZvciAoY29uc3QgdGFiIG9mIHRhYnMuc2xpY2UoMCwgMykpIHtcbiAgICAgICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHBhbmVsVGFiTWVzc2FnZSh0YWIuaWQsIHsgb3BlcmF0aW9uOiAnc2Vzc2lvbicgfSwgc2lnbmFsKTtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBpZiAocmVwbHk/Lm9rICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChyZXBseS50b2tlbiB8fCAnJykgJiYgdHlwZW9mIHJlcGx5Lmluc3RhbmNlID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICYmIHJlcGx5Lmluc3RhbmNlLmxlbmd0aCA8PSAxMDAgJiYgcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW46IHJlcGx5LnRva2VuLCBzYXZlZEF0OiBEYXRlLm5vdygpLCB0YWI6IHsgaWQ6IHRhYi5pZCwgaW5zdGFuY2U6IHJlcGx5Lmluc3RhbmNlIH0gfTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdG9rZW46IHJlcGx5LnRva2VuIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogQ2xvc2VkL25hdmlnYXRlZCB0YWJzIGFyZSBub3QgYW4gYXV0aGVudGljYXRlZCBzZXNzaW9uLiAqLyB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFJlcXVlc3RWaWFUYWIocmVxdWVzdCwgc2lnbmFsKSB7XG4gICAgY29uc3Qgcm91dGUgPSBwYW5lbFNlc3Npb24/LnRhYjtcbiAgICBpZiAoIXJvdXRlIHx8ICFwYW5lbFRhYlJlcXVlc3RBbGxvd2VkKHJlcXVlc3QpKSByZXR1cm4geyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LfQsNC/0YDQvtGBINC+0YLQutC70L7QvdGR0L0nIH07XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFwYW5lbFRhYlVybChjdXJyZW50Py51cmwpIHx8IHNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBldmVudDogc2lnbmFsLmFib3J0ZWQgPyAnYWJvcnQnIDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LLQutC70LDQtNC60LAg0LfQsNC60YDRi9GC0LAg0LjQu9C4INC40LfQvNC10L3QtdC90LAuINCf0L7QstGC0L7RgNC40YLQtSDQv9GA0L7QstC10YDQutGDIHBhbmVsLicgfTtcbiAgICBjb25zdCByZXBseSA9IGF3YWl0IHBhbmVsVGFiTWVzc2FnZShyb3V0ZS5pZCwgeyBvcGVyYXRpb246ICdyZXF1ZXN0JywgaW5zdGFuY2U6IHJvdXRlLmluc3RhbmNlLCByZXF1ZXN0IH0sIHNpZ25hbCk7XG4gICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBldmVudDogJ2Fib3J0JyB9O1xuICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHJvdXRlLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICBpZiAoIXJlcGx5Py5vayB8fCByZXBseS5pbnN0YW5jZSAhPT0gcm91dGUuaW5zdGFuY2UgfHwgIXBhbmVsVGFiVXJsKGFmdGVyPy51cmwpIHx8IHJlcGx5LnJlc3VsdD8uZXZlbnQgIT09ICdsb2FkJ1xuICAgICAgICB8fCAhTnVtYmVyLmlzSW50ZWdlcihyZXBseS5yZXN1bHQucmVzcG9uc2U/LnN0YXR1cykgfHwgcmVwbHkucmVzdWx0LnJlc3BvbnNlPy5maW5hbFVybCAhPT0gcmVxdWVzdC51cmwpIHtcbiAgICAgICAgaWYgKHBhbmVsU2Vzc2lvbj8udGFiID09PSByb3V0ZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ3Nlc3Npb24tbG9zdCcsIGRldGFpbDogeyByZWFzb246ICdjb250ZXh0JyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC60L7QvdGC0LXQutGB0YIg0LLQutC70LDQtNC60Lgg0LjQt9C80LXQvdC40LvRgdGPLiDQndCw0LbQvNC40YLQtSBwYW5lbCDQtNC70Y8g0L/QvtCy0YLQvtGA0L3QvtC5INC/0YDQvtCy0LXRgNC60LguJyB9O1xuICAgIH1cbiAgICByZXR1cm4gcmVwbHkucmVzdWx0O1xufVxuXG5mdW5jdGlvbiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodChmb3JjZSkge1xuICAgIC8vIEEgcXVldWVkIG5vcm1hbCBmbGlnaHQgbWF5IGhhdmUgcG9wdWxhdGVkIHRoZSBjYWNoZSBzaW5jZSBmb3JjZSB3YXMgcmVxdWVzdGVkLlxuICAgIGlmIChmb3JjZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICBjb25zdCBmbGlnaHQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICBmbGlnaHQucHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIFBBTkVMX1NFU1NJT05fVElNRU9VVCk7XG4gICAgICAgIGNvbnN0IGZhaWx1cmUgPSBhc3luYyAocmVhc29uLCBlcnJvcikgPT4ge1xuICAgICAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ3Nlc3Npb24tZmFpbGVkJywgZGV0YWlsOiB7IHJlYXNvbiB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgIHJldHVybiAoYXdhaXQgcmVjb3ZlclBhbmVsRnJvbVRhYihjb250cm9sbGVyLnNpZ25hbCkpIHx8IHsgb2s6IGZhbHNlLCByZWFzb24sIGVycm9yIH07XG4gICAgICAgIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBydWxlc1JlYWR5O1xuICAgICAgICAgICAgaWYgKHJ1bGVGYWlsdXJlIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBFcnJvcignUGFuZWwgdW5hdmFpbGFibGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ3RleHQvaHRtbCcgfSwgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgICAgICBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsVXJsID0gbmV3IFVSTChyZXNwb25zZS51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcpO1xuICAgICAgICAgICAgaWYgKGZpbmFsVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB8fCAhL15cXC9zZWFyY2hcXC8/JC8udGVzdChmaW5hbFVybC5wYXRobmFtZSlcbiAgICAgICAgICAgICAgICB8fCByZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDRhNC+0L3QvtCy0YvQuSDQstGF0L7QtCDQvdC10LTQvtGB0YLRg9C/0LXQvS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQsiDRjdGC0L7QvCDQv9GA0L7RhNC40LvQtSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHRva2VuID0gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGF3YWl0IHJlc3BvbnNlLnRleHQoKSk7XG4gICAgICAgICAgICBpZiAoIXRva2VuIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0L7QtNGC0LLQtdGA0LTQuNGC0Ywg0LLRhdC+0LQuINCe0YLQutGA0L7QudGC0LUgcGFuZWwuaGF0aWtvLnJ1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgLy8gTGFyYXZlbCBpc3N1ZXMgQ1NSRiBldmVuIGZvciBhbm9ueW1vdXMgbG9naW4gcGFnZXMuIENvbmZpcm0gYWNjZXNzXG4gICAgICAgICAgICAvLyB0byBhbiBhY3R1YWwgcHJvdGVjdGVkIHJlYWQtb25seSBBUEkgd2l0aCB0aGUgc2FtZSBicm93c2VyIGNvb2tpZXMuXG4gICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLCAnWC1SZXF1ZXN0ZWQtV2l0aCc6ICdYTUxIdHRwUmVxdWVzdCcgfSxcbiAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLCBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGF1dGhVcmwgPSBuZXcgVVJMKGF1dGgudXJsIHx8ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9hcGkvc2VhcmNoL2ZpbHRlcnMnKTtcbiAgICAgICAgICAgIGlmIChhdXRoLnN0YXR1cyA8IDIwMCB8fCBhdXRoLnN0YXR1cyA+PSAzMDAgfHwgYXV0aFVybC5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydSdcbiAgICAgICAgICAgICAgICB8fCBhdXRoVXJsLnBhdGhuYW1lICE9PSAnL2FwaS9zZWFyY2gvZmlsdGVycycgfHwgIS9hcHBsaWNhdGlvblxcL2pzb24vaS50ZXN0KGF1dGguaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoYXV0aC5zdGF0dXMgPj0gNTAwID8gJ25ldHdvcmsnIDogJ2F1dGgnLCAnUGFuZWw6INC90LXRgiDQtNC+0YHRgtGD0L/QsCDQuiBBUEkuINCe0YLQutGA0L7QudGC0LUg0LDQstGC0L7RgNC40LfQvtCy0LDQvdC90YPRjiBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBwcm9vZiA9IGF3YWl0IGF1dGguanNvbigpO1xuICAgICAgICAgICAgaWYgKCFwcm9vZiB8fCB0eXBlb2YgcHJvb2YgIT09ICdvYmplY3QnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIFBhbmVsIGF1dGggcHJvb2YnKTtcbiAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbiB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCduZXR3b3JrJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0YDQvtCy0LXRgNC40YLRjCDQstGF0L7QtC4g0J/RgNC+0LLQtdGA0YzRgtC1INGB0L7QtdC00LjQvdC10L3QuNC1INC4INC+0YLQutGA0YvRgtGD0Y4g0LLQutC70LDQtNC60YMgcGFuZWwuaGF0aWtvLnJ1LicpO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIGlmIChmb3JjZSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID09PSBmbGlnaHQpIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG4gICAgICAgIH1cbiAgICB9KSgpO1xuICAgIGlmIChmb3JjZSkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIGVsc2Ugbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIHJldHVybiBmbGlnaHQucHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gZ2V0UGFuZWxTZXNzaW9uKGZvcmNlKSB7XG4gICAgaWYgKGZvcmNlKSBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAocXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0KSByZXR1cm4gcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7XG4gICAgaWYgKGZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkge1xuICAgICAgICBjb25zdCBxdWV1ZWQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICAgICAgcXVldWVkLnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7IH1cbiAgICAgICAgICAgIGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IHF1ZXVlZCkgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodCh0cnVlKTtcbiAgICAgICAgfSkoKTtcbiAgICAgICAgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gcXVldWVkO1xuICAgICAgICByZXR1cm4gcXVldWVkLnByb21pc2U7XG4gICAgfVxuICAgIGlmICghZm9yY2UgJiYgcGFuZWxTZXNzaW9uICYmIERhdGUubm93KCkgLSBwYW5lbFNlc3Npb24uc2F2ZWRBdCA8IFBBTkVMX1NFU1NJT05fVFRMKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IHRydWUsIHRva2VuOiBwYW5lbFNlc3Npb24udG9rZW4gfSk7XG4gICAgaWYgKCFmb3JjZSAmJiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICByZXR1cm4gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpO1xufVxuIiwiLy8gRXh0ZW5zaW9uLW93bmVkIHByZXNlbnRhdGlvbi4gTm8gc2l0ZSBET00sIHRva2Vucywgb3IgY29udGVudC10YWIgYXVkaW8uXG5jb25zdCBPUkRFUl9OT1RJRklDQVRJT05fSUQgPSAnbWVtY2hhdC1vcmRlcnMnO1xuY29uc3QgT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSA9ICdtZW1jaGF0LW9yZGVyLW5vdGlmaWNhdGlvbi1leHBpcmUnO1xuZnVuY3Rpb24gb3JkZXJCZWFySWNvbihzaXplKSB7XG4gICAgY29uc3QgY2FudmFzID0gbmV3IE9mZnNjcmVlbkNhbnZhcyhzaXplLCBzaXplKSwgY3R4ID0gY2FudmFzLmdldENvbnRleHQoJzJkJyksIHMgPSBzaXplIC8gMzI7XG4gICAgY29uc3Qgb3ZhbCA9ICh4LCB5LCByeCwgcnksIGNvbG9yKSA9PiB7IGN0eC5maWxsU3R5bGUgPSBjb2xvcjsgY3R4LmJlZ2luUGF0aCgpOyBjdHguZWxsaXBzZSh4ICogcywgeSAqIHMsIHJ4ICogcywgcnkgKiBzLCAwLCAwLCBNYXRoLlBJICogMik7IGN0eC5maWxsKCk7IH07XG4gICAgb3ZhbCg3LCA3LCA2LCA2LCAnIzcxM2YyYScpOyBvdmFsKDI1LCA3LCA2LCA2LCAnIzcxM2YyYScpO1xuICAgIG92YWwoNywgNywgMywgMywgJyNkOGFhNzgnKTsgb3ZhbCgyNSwgNywgMywgMywgJyNkOGFhNzgnKTtcbiAgICBvdmFsKDE2LCAxOCwgMTQsIDEzLCAnIzk4NjIzYicpO1xuICAgIG92YWwoMTYsIDI0LCA4LCA2LCAnI2VkYzk5YicpO1xuICAgIG92YWwoMTAsIDE3LCAyLCAyLjUsICcjMjMxNTBlJyk7IG92YWwoMjIsIDE3LCAyLCAyLjUsICcjMjMxNTBlJyk7XG4gICAgb3ZhbCgxNiwgMjIsIDMsIDIsICcjMjMxNTBlJyk7IG92YWwoMTYsIDI2LCAyLCAxLCAnIzcxM2YyYScpO1xuICAgIHJldHVybiBjdHguZ2V0SW1hZ2VEYXRhKDAsIDAsIHNpemUsIHNpemUpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJVcGRhdGVJY29uKCkge1xuICAgIGlmICghY2hyb21lLmFjdGlvbj8uc2V0SWNvbikgcmV0dXJuO1xuICAgIGNvbnN0IGVuYWJsZWQgPSBvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEljb24oZW5hYmxlZCA/IHsgaW1hZ2VEYXRhOiB7IDE2OiBvcmRlckJlYXJJY29uKDE2KSwgMzI6IG9yZGVyQmVhckljb24oMzIpIH0gfSA6IHsgcGF0aDogJ2ljb24ucG5nJyB9KTtcbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldFRpdGxlKHsgdGl0bGU6IGVuYWJsZWQgPyAn8J+QuyDQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0LrQu9GO0YfRkdC9IMK3INCe0YLQutGA0YvRgtGMINCx0L7QutC+0LLRg9GOINC/0LDQvdC10LvRjCBNZW1jaGF0JyA6ICfQntGC0LrRgNGL0YLRjCDQnNC10LzRh9Cw0YIg0LIg0LHQvtC60L7QstC+0Lkg0L/QsNC90LXQu9C4JyB9KTtcbn1cbmxldCBvcmRlckF1ZGlvQ3JlYXRpbmcgPSBudWxsO1xubGV0IG9yZGVyQXVkaW9HZW5lcmF0aW9uID0gMDtcbmFzeW5jIGZ1bmN0aW9uIG9yZGVyU3RvcEF1ZGlvKCkge1xuICAgIG9yZGVyQXVkaW9HZW5lcmF0aW9uKys7XG4gICAgaWYgKCFjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cykgcmV0dXJuO1xuICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgaWYgKGNvbnRleHRzLmxlbmd0aCkgYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0YXJnZXQ6ICdtZW1jaGF0LW9mZnNjcmVlbicsIHR5cGU6ICdtZW1jaGF0OmF1ZGlvLXN0b3AnIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJFbnN1cmVBdWRpbygpIHtcbiAgICBpZiAob3JkZXJBdWRpb0NyZWF0aW5nKSByZXR1cm4gb3JkZXJBdWRpb0NyZWF0aW5nO1xuICAgIG9yZGVyQXVkaW9DcmVhdGluZyA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgICAgIGlmICghY29udGV4dHMubGVuZ3RoKSBhd2FpdCBjaHJvbWUub2Zmc2NyZWVuLmNyZWF0ZURvY3VtZW50KHsgdXJsOiAnb2Zmc2NyZWVuLmh0bWwnLCByZWFzb25zOiBbJ0FVRElPX1BMQVlCQUNLJ10sIGp1c3RpZmljYXRpb246ICdPbmUgc2hhcmVkIE1lbWNoYXQgb3JkZXIgYWxhcm0sIGluZGVwZW5kZW50IG9mIG9wZW4gTW95U2tsYWQgdGFicy4nIH0pO1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyQXVkaW9DcmVhdGluZyA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckF1ZGlvQ3JlYXRpbmc7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclBsYXlBdWRpbyhpc0N1cnJlbnQgPSAoKSA9PiB0cnVlKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG9yZGVyQXVkaW9HZW5lcmF0aW9uO1xuICAgIGF3YWl0IG9yZGVyRW5zdXJlQXVkaW8oKTtcbiAgICBpZiAoIWlzQ3VycmVudCgpIHx8IGdlbmVyYXRpb24gIT09IG9yZGVyQXVkaW9HZW5lcmF0aW9uKSByZXR1cm47XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHRhcmdldDogJ21lbWNoYXQtb2Zmc2NyZWVuJywgdHlwZTogJ21lbWNoYXQ6YXVkaW8tcGxheScgfSk7XG4gICAgaWYgKCFyZXNwb25zZT8ub2spIHRocm93IEVycm9yKCfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJQcmVzZW50UmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgY3VycmVudCA9ICgpID0+IGNvbmZpZyA9PT0gb3JkZXJDb25maWcgJiYgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgJiYgIWNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQ7XG4gICAgaWYgKCFyZXN1bHQub3JkZXJzLmxlbmd0aCB8fCAhY3VycmVudCgpKSByZXR1cm4gW107XG4gICAgY29uc3Qgbm90aWZ5ID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuZ2V0UGVybWlzc2lvbkxldmVsKCk7XG4gICAgICAgIGlmICghY3VycmVudCgpKSByZXR1cm47XG4gICAgICAgIGlmIChwZXJtaXNzaW9uICE9PSAnZ3JhbnRlZCcpIHRocm93IEVycm9yKCfQo9Cy0LXQtNC+0LzQu9C10L3QuNGPINC+0YLQutC70Y7Rh9C10L3RiyDQsiDQsdGA0LDRg9C30LXRgNC1Jyk7XG4gICAgICAgIGNvbnN0IG9yZGVycyA9IHJlc3VsdC5vcmRlcnM7XG4gICAgICAgIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZShPUkRFUl9OT1RJRklDQVRJT05fSUQsIHsgdHlwZTogJ2Jhc2ljJywgaWNvblVybDogJ2ljb24ucG5nJyxcbiAgICAgICAgICAgIHRpdGxlOiAn8J+QuyBNZW1jaGF0IMK3INCX0LDQutCw0LfRizogJyArIG9yZGVycy5sZW5ndGgsXG4gICAgICAgICAgICBtZXNzYWdlOiBvcmRlcnMuc2xpY2UoMCwgMykubWFwKGl0ZW0gPT4gU3RyaW5nKGl0ZW0ubmFtZSkuc2xpY2UoMCwgODApICsgJyDCtyAnICsgU3RyaW5nKGl0ZW0ub3JnYW5pemF0aW9uTmFtZSkuc2xpY2UoMCwgODApKS5qb2luKCdcXG4nKSArIChyZXN1bHQucGFydGlhbCA/ICdcXG7imqAg0J7Qv9GA0L7RgSDQvdC10L/QvtC70L3Ri9C5JyA6ICcnKSxcbiAgICAgICAgICAgIHByaW9yaXR5OiAwLCBzaWxlbnQ6IHRydWUsIHJlcXVpcmVJbnRlcmFjdGlvbjogY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzID09PSAwIH0pO1xuICAgICAgICBpZiAoIWN1cnJlbnQoKSkgeyBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpOyByZXR1cm47IH1cbiAgICAgICAgaWYgKGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyA+IDApIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlksIHsgd2hlbjogRGF0ZS5ub3coKSArIGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyAqIDYwMDAwIH0pO1xuICAgICAgICBlbHNlIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgfTtcbiAgICBjb25zdCB0YXNrcyA9IFtub3RpZnkoKV07XG4gICAgaWYgKGNvbmZpZy5zZXR0aW5ncy5zb3VuZEVuYWJsZWQpIHRhc2tzLnB1c2gob3JkZXJQbGF5QXVkaW8oY3VycmVudCkpO1xuICAgIGNvbnN0IG91dGNvbWVzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRhc2tzKTtcbiAgICByZXR1cm4gb3V0Y29tZXMuZmxhdE1hcCgoaXRlbSwgaW5kZXgpID0+IGl0ZW0uc3RhdHVzID09PSAncmVqZWN0ZWQnID8gW2luZGV4ID09PSAwID8gJ9Ch0LjRgdGC0LXQvNC90YvQtSDRg9Cy0LXQtNC+0LzQu9C10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QvdGLJyA6ICfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvSddIDogW10pO1xufVxuaWYgKGNocm9tZS5ub3RpZmljYXRpb25zPy5vbkNsaWNrZWQpIGNocm9tZS5ub3RpZmljYXRpb25zLm9uQ2xpY2tlZC5hZGRMaXN0ZW5lcihpZCA9PiB7XG4gICAgaWYgKGlkICE9PSBPUkRFUl9OT1RJRklDQVRJT05fSUQpIHJldHVybjtcbiAgICBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydS9hcHAvI2N1c3RvbWVyb3JkZXInLCBhY3RpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKS5jYXRjaCgoKSA9PiB7fSk7XG59KTtcbiIsIi8vIFNoYXJlZCBvcmRlciBwb2xsaW5nIGlzIGluZGVwZW5kZW50IG9mIHRoZSBsaWZldGltZS9udW1iZXIgb2YgY29udGVudCB0YWJzLlxuLy8gU2Vzc2lvbiBzdG9yYWdlIGlzIGV4dGVuc2lvbi1wcml2YXRlOyBiZWFyZXIgbmV2ZXIgZW50ZXJzIGEgYnJvYWRjYXN0IG9yIGxvZ3MuXG5jb25zdCBPUkRFUl9TRVNTSU9OX0tFWSA9ICdtZW1jaGF0T3JkZXJTZXJ2aWNlX3YxJztcbmxldCBvcmRlckNvbmZpZyA9IG51bGw7XG5sZXQgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoKTtcbmxldCBvcmRlclJldmlzaW9uID0gMDtcbmxldCBvcmRlckZsaWdodCA9IG51bGw7XG5sZXQgb3JkZXJDb250cm9sbGVyID0gbnVsbDtcbmxldCBvcmRlckxhc3RSZXN1bHQgPSBudWxsO1xubGV0IG9yZGVyQ29uZmlnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmZ1bmN0aW9uIG9yZGVyTXV0YXRlKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgbmV4dCA9IG9yZGVyQ29uZmlnQ2hhaW4udGhlbihjYWxsYmFjayk7XG4gICAgb3JkZXJDb25maWdDaGFpbiA9IG5leHQuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBuZXh0O1xufVxuY29uc3Qgb3JkZXJSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoT1JERVJfU0VTU0lPTl9LRVkpKVtPUkRFUl9TRVNTSU9OX0tFWV07XG4gICAgICAgIGlmIChzYXZlZCkgeyBvcmRlckNvbmZpZyA9IHNhdmVkLmNvbmZpZzsgb3JkZXJSZXZpc2lvbiA9IHNhdmVkLnJldmlzaW9uIHx8IDA7IG9yZGVyU3Vic2NyaWJlcnMgPSBuZXcgU2V0KHNhdmVkLnN1YnNjcmliZXJzIHx8IFtdKTsgfVxuICAgICAgICBhd2FpdCBvcmRlclVwZGF0ZUljb24oKTtcbiAgICB9IGNhdGNoIHsgLyogQ29uZmlndXJlIG11c3Qgc3VjY2Vzc2Z1bGx5IHBlcnNpc3QgYmVmb3JlIGVuYWJsaW5nIHBvbGxpbmcuICovIH1cbn0pKCk7XG5mdW5jdGlvbiBvcmRlclB1YmxpY0NvbmZpZygpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgc2V0dGluZ3M6IG9yZGVyQ29uZmlnPy5zZXR0aW5ncywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gfTtcbn1cbmZ1bmN0aW9uIG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgbmV3IFJlZ0V4cCgnXmh0dHBzOi8vYXBpXFxcXC5tb3lza2xhZFxcXFwucnUvYXBpL3JlbWFwLzFcXFxcLjIvZW50aXR5LycgKyBraW5kICsgJy9bQS1aYS16MC05LV0rJCcpLnRlc3QodmFsdWUpO1xufVxuZnVuY3Rpb24gb3JkZXJTZXR0aW5ncyhyYXcpIHtcbiAgICBjb25zdCByZWZzID0gKHZhbHVlcywga2luZCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWVzKSB8fCAhdmFsdWVzLmV2ZXJ5KHZhbHVlID0+IG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHJlZmVyZW5jZXMnKTtcbiAgICAgICAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyldO1xuICAgIH07XG4gICAgcmV0dXJuIHsgZW5hYmxlZDogcmF3Py5lbmFibGVkICE9PSBmYWxzZSwgc291bmRFbmFibGVkOiByYXc/LnNvdW5kRW5hYmxlZCAhPT0gZmFsc2UsXG4gICAgICAgIGludGVydmFsTWludXRlczogTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChOdW1iZXIocmF3Py5pbnRlcnZhbE1pbnV0ZXMpIHx8IDEpKSksXG4gICAgICAgIHRvYXN0RHVyYXRpb25NaW51dGVzOiBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKE51bWJlcihyYXc/LnRvYXN0RHVyYXRpb25NaW51dGVzKSB8fCAwKSkpLFxuICAgICAgICBvcmdhbml6YXRpb25IcmVmczogcmVmcyhyYXc/Lm9yZ2FuaXphdGlvbkhyZWZzLCAnb3JnYW5pemF0aW9uJyksXG4gICAgICAgIHN0YXR1c0hyZWZzOiByZWZzKHJhdz8uc3RhdHVzSHJlZnMsICdjdXN0b21lcm9yZGVyL21ldGFkYXRhL3N0YXRlcycpIH07XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclNldEFsYXJtKCkge1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgfHwgIW9yZGVyQ29uZmlnLnNldHRpbmdzLnNvdW5kRW5hYmxlZCkgYXdhaXQgb3JkZXJTdG9wQXVkaW8oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCAmJiBjaHJvbWUubm90aWZpY2F0aW9ucz8uY2xlYXIpIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIC8vIFRvb2xiYXIgcHJlc2VudGF0aW9uIG11c3QgbmV2ZXIgcHJldmVudCBzY2hlZHVsaW5nIG9yIHBhdXNpbmcgdGhlIHNlcnZpY2UuXG4gICAgYXdhaXQgb3JkZXJVcGRhdGVJY29uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmICghY2hyb21lLmFsYXJtcykgcmV0dXJuO1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQpIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgaWYgKG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCAmJiBvcmRlckNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoJ21lbWNoYXQtb3JkZXJzJywgeyBwZXJpb2RJbk1pbnV0ZXM6IG9yZGVyQ29uZmlnLnNldHRpbmdzLmludGVydmFsTWludXRlcyB9KTtcbiAgICB9IGVsc2UgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcignbWVtY2hhdC1vcmRlcnMnKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgIGlmICh0eXBlb2YgbWVzc2FnZS50b2tlbiAhPT0gJ3N0cmluZycgfHwgIW1lc3NhZ2UudG9rZW4udHJpbSgpIHx8IG1lc3NhZ2UudG9rZW4ubGVuZ3RoID4gNDA5NikgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdG9rZW4nKTtcbiAgICBjb25zdCBzZXR0aW5ncyA9IG9yZGVyU2V0dGluZ3MobWVzc2FnZS5zZXR0aW5ncyk7XG4gICAgY29uc3QgdW5jaGFuZ2VkID0gb3JkZXJDb25maWc/LnRva2VuID09PSBtZXNzYWdlLnRva2VuICYmIEpTT04uc3RyaW5naWZ5KG9yZGVyQ29uZmlnLnNldHRpbmdzKSA9PT0gSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpO1xuICAgIGlmIChvcmRlckNvbmZpZyAmJiAobWVzc2FnZS51cGRhdGUgIT09IHRydWUgfHwgdW5jaGFuZ2VkKSkge1xuICAgICAgICBpZiAob3JkZXJDb25maWcudG9rZW4gIT09IG1lc3NhZ2UudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIGVycm9yOiAn0JTRgNGD0LPQvtC5IEJlYXJlciDQsiDRhNC+0L3QtS4g0KHQvtGF0YDQsNC90LjRgtC1INC90LDRgdGC0YDQvtC50LrQuCDRj9Cy0L3QviDQtNC70Y8g0YHQvNC10L3RiyDQsNC60LrQsNGD0L3RgtCwLicgfTtcbiAgICAgICAgaWYgKHNlbmRlci50YWIpIG9yZGVyU3Vic2NyaWJlcnMuYWRkKHNlbmRlci50YWIuaWQpO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnOiBvcmRlckNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgaWYgKGNocm9tZS5hbGFybXM/LmdldCAmJiAhKGF3YWl0IGNocm9tZS5hbGFybXMuZ2V0KCdtZW1jaGF0LW9yZGVycycpKSkgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBwb2xsUmVxdWlyZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChvcmRlckNvbmZpZyAmJiBtZXNzYWdlLnJldmlzaW9uICE9PSBvcmRlclJldmlzaW9uKSByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBvazogZmFsc2UsIGNvbmZsaWN0OiB0cnVlLCBlcnJvcjogJ9Cd0LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLINCyINC00YDRg9Cz0L7QuSDQstC60LvQsNC00LrQtS4g0J/QvtCy0YLQvtGA0LjRgtC1INC40LfQvNC10L3QtdC90LjQtS4nIH07XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gPyBuZXcgU2V0KG9yZGVyU3Vic2NyaWJlcnMpIDogbmV3IFNldCgpO1xuICAgIGlmIChzZW5kZXIudGFiKSBzdWJzY3JpYmVycy5hZGQoc2VuZGVyLnRhYi5pZCk7XG4gICAgY29uc3QgY29uZmlnID0geyB0b2tlbjogbWVzc2FnZS50b2tlbiwgc2V0dGluZ3MsIG9yZ2FuaXphdGlvbnM6IChBcnJheS5pc0FycmF5KG1lc3NhZ2Uub3JnYW5pemF0aW9ucykgPyBtZXNzYWdlLm9yZ2FuaXphdGlvbnMgOiBbXSlcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IHNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmluY2x1ZGVzKGl0ZW0/LmhyZWYpKS5tYXAoaXRlbSA9PiAoeyBocmVmOiBpdGVtLmhyZWYsIG5hbWU6IFN0cmluZyhpdGVtLm5hbWUgfHwgJycpLnNsaWNlKDAsIDMwMCkgfSkpIH07XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gKyAxLCBzdWJzY3JpYmVyczogWy4uLnN1YnNjcmliZXJzXSB9IH0pO1xuICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICBvcmRlckNvbmZpZyA9IGNvbmZpZzsgb3JkZXJTdWJzY3JpYmVycyA9IHN1YnNjcmliZXJzOyBvcmRlclJldmlzaW9uKys7IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG4gICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIHBvbGxSZXF1aXJlZDogdHJ1ZSB9O1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJHZXQocGF0aCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwZXJmb3JtUmVxdWVzdCh7IGlkOiAnYmFja2dyb3VuZC1vcmRlcnMnLCByZXF1ZXN0OiB7XG4gICAgICAgIHVybDogJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjInICsgcGF0aCwgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyICcgKyBjb25maWcudG9rZW4sIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfSxcbiAgICAgICAgYW5vbnltb3VzOiB0cnVlLCBiYWNrZ3JvdW5kT3JkZXI6IHRydWVcbiAgICB9IH0sIHsgdGFiOiB7IGlkOiAtMSB9LCBmcmFtZUlkOiAwIH0sIGNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSB0aHJvdyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgaWYgKHJlc3BvbnNlLmV2ZW50ICE9PSAnbG9hZCcpIHRocm93IEVycm9yKCfQntGI0LjQsdC60LAg0YHQvtC10LTQuNC90LXQvdC40Y8g0YEg0JzQvtC50KHQutC70LDQtCcpO1xuICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cztcbiAgICBpZiAoc3RhdHVzIDwgMjAwIHx8IHN0YXR1cyA+PSAzMDApIHsgY29uc3QgZXJyb3IgPSBFcnJvcign0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgc3RhdHVzKTsgZXJyb3Iuc3RhdHVzID0gc3RhdHVzOyB0aHJvdyBlcnJvcjsgfVxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7IGRhdGEgPSBKU09OLnBhcnNlKHJlc3BvbnNlLnJlc3BvbnNlLnJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyB0aHJvdyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INC+0YLQstC10YIg0JzQvtC50KHQutC70LDQtCcpOyB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGE/LnJvd3MpKSB0aHJvdyBFcnJvcign0J3QtdC/0L7Qu9C90YvQuSDQvtGC0LLQtdGCINGB0L/QuNGB0LrQsCDQt9Cw0LrQsNC30L7QsicpO1xuICAgIHJldHVybiBkYXRhO1xufVxuYXN5bmMgZnVuY3Rpb24gZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbikge1xuICAgIGlmICghY2hyb21lLnRhYnM/LnF1ZXJ5KSByZXR1cm47XG4gICAgY29uc3QgdGFicyA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHt9KTtcbiAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHRhYnMuZmlsdGVyKHRhYiA9PiBvcmRlclN1YnNjcmliZXJzLmhhcyh0YWIuaWQpICYmIHRydXN0ZWRDb250ZW50U2VuZGVyKHsgaWQ6IGNocm9tZS5ydW50aW1lLmlkLCB0YWIsIGZyYW1lSWQ6IDAsIHVybDogdGFiLnVybCB9KSk7XG4gICAgY2FuZGlkYXRlcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoISFiLmFjdGl2ZSkgLSBOdW1iZXIoISFhLmFjdGl2ZSkpO1xuICAgIGZvciAoY29uc3QgdGFiIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSwgeyBmcmFtZUlkOiAwIH0pO1xuICAgICAgICAgICAgaWYgKGFjaz8ub2spIHJldHVybjtcbiAgICAgICAgfSBjYXRjaCB7IC8qIFRyeSBhbm90aGVyIGxpdmUgY29udGVudCB3b3JsZCwgbm90IGV2ZXJ5IHRhYi4gKi8gfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hdGl2ZSBvZiBuYXRpdmVSdW50aW1lU2Vzc2lvbnMudmFsdWVzKCkpIHtcbiAgICAgICAgaWYgKG5hdGl2ZS5vcmRlclRva2VuICE9PSBjb25maWcudG9rZW4gfHwgbmF0aXZlLm9yZGVyUmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgY29udGludWU7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQobmF0aXZlLnNlbmRlciwgJ0JlYXJlciAnICsgY29uZmlnLnRva2VuKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBuYXRpdmVSdW50aW1lUmVxdWVzdChuYXRpdmUsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSk7XG4gICAgICAgICAgICBpZiAoYWNrPy5vaykgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogQSBjbG9zZWQgbmF0aXZlIGRvY3VtZW50IGlzIG5vdCBhbm90aGVyIHN1YnNjcmliZXIuICovIH1cbiAgICB9XG59XG5hc3luYyBmdW5jdGlvbiBwb2xsT3JkZXJzKCkge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgYXdhaXQgb3JkZXJDb25maWdDaGFpbjtcbiAgICBpZiAob3JkZXJGbGlnaHQpIHJldHVybiBvcmRlckZsaWdodDtcbiAgICBjb25zdCBjb25maWcgPSBvcmRlckNvbmZpZztcbiAgICBpZiAoIWNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCB8fCAhY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCB8fCAhY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLRi9C60LvRjtGH0LXQvSDQuNC70Lgg0L3QtSDQvdCw0YHRgtGA0L7QtdC9JyB9O1xuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHJldmlzaW9uID0gb3JkZXJSZXZpc2lvbjtcbiAgICAgICAgb3JkZXJDb250cm9sbGVyID0gY29udHJvbGxlcjtcbiAgICBvcmRlckZsaWdodCA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gbmV3IE1hcCgpLCBmYWlsZWQgPSBbXTtcbiAgICAgICAgbGV0IGF1dGhGYWlsZWQgPSBmYWxzZTtcbiAgICAgICAgZm9yIChjb25zdCBocmVmIG9mIGNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcykge1xuICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBjb25maWcub3JnYW5pemF0aW9ucy5maW5kKGl0ZW0gPT4gaXRlbS5ocmVmID09PSBocmVmKT8ubmFtZSB8fCAn0J7RgNCz0LDQvdC40LfQsNGG0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsCc7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICAgICAgbGV0IG9mZnNldCA9IDA7XG4gICAgICAgICAgICAgICAgZm9yICg7Oykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBmaWx0ZXIgPSBbJ29yZ2FuaXphdGlvbj0nICsgaHJlZiwgLi4uY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLm1hcChzdGF0ZSA9PiAnc3RhdGU9JyArIHN0YXRlKV0uam9pbignOycpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgb3JkZXJHZXQoJy9lbnRpdHkvY3VzdG9tZXJvcmRlcj9maWx0ZXI9JyArIGVuY29kZVVSSUNvbXBvbmVudChmaWx0ZXIpXG4gICAgICAgICAgICAgICAgICAgICAgICArICcmZXhwYW5kPXN0YXRlLG9yZ2FuaXphdGlvbiZvcmRlcj1tb21lbnQsZGVzYyZsaW1pdD0xMDAmb2Zmc2V0PScgKyBvZmZzZXQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gcm93cy5zaXplO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiBkYXRhLnJvd3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghcm93Py5pZCkgdGhyb3cgRXJyb3IoJ9CX0LDQutCw0Lcg0LHQtdC3INC40LTQtdC90YLQuNGE0LjQutCw0YLQvtGA0LAnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd3Muc2V0KHJvdy5pZCwgcm93KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBvZmZzZXQgKz0gZGF0YS5yb3dzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW9yZSA9ICEhZGF0YS5tZXRhPy5uZXh0SHJlZiB8fCAoTnVtYmVyLmlzRmluaXRlKGRhdGEubWV0YT8uc2l6ZSkgPyBvZmZzZXQgPCBkYXRhLm1ldGEuc2l6ZSA6IGRhdGEucm93cy5sZW5ndGggPj0gMTAwKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3JlKSBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFkYXRhLnJvd3MubGVuZ3RoIHx8IHJvd3Muc2l6ZSA9PT0gcHJldmlvdXMpIHRocm93IEVycm9yKCfQn9Cw0LPQuNC90LDRhtC40Y8g0LfQsNC60LDQt9C+0LIg0L3QtSDQv9GA0L7QtNCy0LjQs9Cw0LXRgtGB0Y8nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2Ygcm93cy52YWx1ZXMoKSkgaWYgKGNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5pbmNsdWRlcyhyb3cuc3RhdGU/Lm1ldGE/LmhyZWYpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kLnNldChyb3cuaWQsIHsgaWQ6IHJvdy5pZCwgbmFtZTogcm93Lm5hbWUgfHwgcm93LmlkLCBzdGF0ZU5hbWU6IHJvdy5zdGF0ZT8ubmFtZSB8fCAn0J3QvtCy0YvQuScsIG9yZ2FuaXphdGlvbk5hbWU6IGxhYmVsLCBvcmdhbml6YXRpb25IcmVmOiBocmVmIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L06INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLJyB9O1xuICAgICAgICAgICAgICAgIGZhaWxlZC5wdXNoKGxhYmVsICsgJyDigJQgJyArIChlcnJvci5tZXNzYWdlIHx8ICfQntGI0LjQsdC60LAg0LfQsNC/0YDQvtGB0LAnKSk7XG4gICAgICAgICAgICAgICAgaWYgKFs0MDEsIDQwM10uaW5jbHVkZXMoZXJyb3Iuc3RhdHVzKSkgeyBhdXRoRmFpbGVkID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScgfTtcbiAgICAgICAgaWYgKGF1dGhGYWlsZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICAgICAgICAgICAgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnLCByZXZpc2lvbjogKytvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L0nIH07XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHsgaWQ6IFN0cmluZyhEYXRlLm5vdygpKSArICctJyArIG9yZGVyUmV2aXNpb24sIG9yZGVyczogWy4uLmZvdW5kLnZhbHVlcygpXSwgZmFpbGVkLCBwYXJ0aWFsOiBmYWlsZWQubGVuZ3RoID4gMCxcbiAgICAgICAgICAgIGJlYXJlcjogYXV0aEZhaWxlZCA/ICdlcnJvcicgOiBmYWlsZWQubGVuZ3RoID09PSBjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoID8gJ3Vua25vd24nIDogJ29rJywgYXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgcmVzdWx0Lm9yZGVycy5mb3JFYWNoKG9yZGVyID0+IHsgb3JkZXIucGFydGlhbCA9IHJlc3VsdC5wYXJ0aWFsOyB9KTtcbiAgICAgICAgb3JkZXJMYXN0UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICByZXN1bHQuYWxlcnRXYXJuaW5ncyA9IGF3YWl0IG9yZGVyUHJlc2VudFJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9OiDQvdCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiycgfTtcbiAgICAgICAgYXdhaXQgZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbik7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZXN1bHQgfTtcbiAgICB9KSgpLmZpbmFsbHkoKCkgPT4geyBvcmRlckZsaWdodCA9IG51bGw7IGlmIChvcmRlckNvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIG9yZGVyQ29udHJvbGxlciA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckZsaWdodDtcbn1cbmlmIChjaHJvbWUuYWxhcm1zKSBjaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoYWxhcm0gPT4ge1xuICAgIGlmIChhbGFybS5uYW1lID09PSBPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKSByZXR1cm4gY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0lEKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKGFsYXJtLm5hbWUgPT09ICdtZW1jaGF0LW9yZGVycycpIHJldHVybiBwb2xsT3JkZXJzKCkuY2F0Y2goKCkgPT4ge30pO1xufSk7XG4iLCIvLyBOYXRpdmUgcnVudGltZSBpZGVudGl0aWVzIGFyZSByZWFsIENocm9tZSBNZXNzYWdlU2VuZGVycywgbmV2ZXIgc3ludGhldGljIHRhYnMuXG4vLyBBIG9uZS11c2UgY2FwYWJpbGl0eSwgZGVsaXZlcmVkIG9ubHkgdG8gYSB2ZXJpZmllZCBTSURFX1BBTkVMIGRvY3VtZW50LCBiaW5kc1xuLy8gaXRzIGNoaWxkIHBvcnQgdG8gb25lIHdpbmRvdy9vcmlnaW4gZm9yIGl0cyBlbnRpcmUgbGlmZXRpbWUuXG5jb25zdCBuYXRpdmVSdW50aW1lSWRlbnRpdGllcyA9IG5ldyBXZWFrTWFwKCk7XG5jb25zdCBuYXRpdmVSdW50aW1lU2Vzc2lvbnMgPSBuZXcgTWFwKCk7XG5jb25zdCBuYXRpdmVSdW50aW1lVGlja2V0cyA9IG5ldyBNYXAoKTtcbmxldCBuYXRpdmVEcmFmdENoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5jb25zdCBOQVRJVkVfTEFTVF9PUklHSU5fS0VZID0gJ21lbWNoYXROYXRpdmVMYXN0T3JpZ2luX3YxJztcbmxldCBuYXRpdmVTZWxlY3Rpb25DaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwob3JpZ2luKTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gPT09IG9yaWdpbiAmJiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmRcbiAgICAgICAgICAgICYmIE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5wYWdlTWF0Y2hlcy5zb21lKHBhdHRlcm4gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGhvc3QgPSBuZXcgVVJMKHBhdHRlcm4ucmVwbGFjZSgnKi4nLCAnd2lsZGNhcmQuJykpLmhvc3RuYW1lLnJlcGxhY2UoJ3dpbGRjYXJkLicsICcqLicpO1xuICAgICAgICAgICAgICAgIHJldHVybiBob3N0LnN0YXJ0c1dpdGgoJyouJykgPyB1cmwuaG9zdG5hbWUgPT09IGhvc3Quc2xpY2UoMikgfHwgdXJsLmhvc3RuYW1lLmVuZHNXaXRoKCcuJyArIGhvc3Quc2xpY2UoMikpIDogdXJsLmhvc3RuYW1lID09PSBob3N0O1xuICAgICAgICAgICAgfSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuZnVuY3Rpb24gbmF0aXZlRG9jdW1lbnRVcmwocmF3LCBxdWVyeSwgaGFzaCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gPT09IG5ldyBVUkwoY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpKS5vcmlnaW4gJiYgdXJsLnBhdGhuYW1lID09PSAnL29mZnNjcmVlbi5odG1sJ1xuICAgICAgICAgICAgJiYgdXJsLmhhc2ggPT09ICcjJyArIGhhc2ggJiYgbmV3IFJlZ0V4cCgnXlxcXFw/JyArIHF1ZXJ5ICsgJz1bYS1mMC05LV17MzZ9JCcpLnRlc3QodXJsLnNlYXJjaCk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuY29uc3QgbmF0aXZlUGFuZWxXaW5kb3dzID0gbmV3IE1hcCgpO1xuYXN5bmMgZnVuY3Rpb24gbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIHdpbmRvd0lkKSB7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHdpbmRvd0lkKSB8fCB3aW5kb3dJZCA8IDAgfHwgc2VuZGVyPy5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydTSURFX1BBTkVMJ10sIGRvY3VtZW50VXJsczogW3NlbmRlci51cmxdIH0pO1xuICAgIGNvbnN0IGNvbnRleHQgPSBjb250ZXh0cy5maW5kKGNvbnRleHQgPT4gY29udGV4dC5jb250ZXh0VHlwZSA9PT0gJ1NJREVfUEFORUwnICYmIGNvbnRleHQuZG9jdW1lbnRVcmwgPT09IHNlbmRlci51cmxcbiAgICAgICAgJiYgKCFzZW5kZXIuZG9jdW1lbnRJZCB8fCBjb250ZXh0LmRvY3VtZW50SWQgPT09IHNlbmRlci5kb2N1bWVudElkKSk7XG4gICAgaWYgKCFjb250ZXh0KSB7IG5hdGl2ZVBhbmVsV2luZG93cy5kZWxldGUoc2VuZGVyLnVybCk7IHJldHVybiBmYWxzZTsgfVxuICAgIC8vIENocm9tZSByZXBvcnRzIHdpbmRvd0lkPS0xIGZvciBhIGdsb2JhbCBTSURFX1BBTkVMIChvYnNlcnZlZCBpbiBDaHJvbWl1bSkuXG4gICAgLy8gT25seSBvdXIgdmVyaWZpZWQgbmF0aXZlIFVJIGNhbiBlc3RhYmxpc2ggdGhpcyBmaXJzdCBiaW5kaW5nOyBpdCBvYnRhaW5zXG4gICAgLy8gaXRzIHdpbmRvdyB2aWEgd2luZG93cy5nZXRDdXJyZW50KCkuIE5ldmVyIGxldCBhIGRvY3VtZW50IHJldGFyZ2V0IGxhdGVyLlxuICAgIGlmIChjb250ZXh0LndpbmRvd0lkICE9PSAtMSAmJiBjb250ZXh0LndpbmRvd0lkICE9PSB3aW5kb3dJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghbmF0aXZlUGFuZWxXaW5kb3dzLmhhcyhzZW5kZXIudXJsKSkgbmF0aXZlUGFuZWxXaW5kb3dzLnNldChzZW5kZXIudXJsLCB3aW5kb3dJZCk7XG4gICAgcmV0dXJuIG5hdGl2ZVBhbmVsV2luZG93cy5nZXQoc2VuZGVyLnVybCkgPT09IHdpbmRvd0lkO1xufVxuYXN5bmMgZnVuY3Rpb24gbmF0aXZlTGFzdE9yaWdpbigpIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IG5hdGl2ZVNlbGVjdGlvbkNoYWluO1xuICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV07XG4gICAgcmV0dXJuIG5hdGl2ZVN1cHBvcnRlZE9yaWdpbihzYXZlZCkgPyBzYXZlZCA6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydSc7XG59XG5mdW5jdGlvbiBuYXRpdmVSZW1lbWJlck9yaWdpbihvcmlnaW4pIHtcbiAgICBjb25zdCB3b3JrID0gbmF0aXZlU2VsZWN0aW9uQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmICghbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikpIHRocm93IEVycm9yKCdJbnZhbGlkIG9yaWdpbicpO1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV0gPT09IG9yaWdpbikgcmV0dXJuO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV06IG9yaWdpbiB9KTtcbiAgICAgICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTkFUSVZFX0xBU1RfT1JJR0lOX0tFWSkpW05BVElWRV9MQVNUX09SSUdJTl9LRVldICE9PSBvcmlnaW4pIHRocm93IEVycm9yKCdTZWxlY3Rpb24gbm90IGR1cmFibGUnKTtcbiAgICB9KTtcbiAgICBuYXRpdmVTZWxlY3Rpb25DaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrO1xufVxuYXN5bmMgZnVuY3Rpb24gbmF0aXZlUnVudGltZVRpY2tldChzZW5kZXIsIHdpbmRvd0lkLCBvcmlnaW4pIHtcbiAgICBpZiAoIW5hdGl2ZVN1cHBvcnRlZE9yaWdpbihvcmlnaW4pIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgd2luZG93SWQpKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgaWRlbnRpdHknKTtcbiAgICBmb3IgKGNvbnN0IFt0aWNrZXQsIGJpbmRpbmddIG9mIG5hdGl2ZVJ1bnRpbWVUaWNrZXRzKSBpZiAoYmluZGluZy5leHBpcmVzIDwgRGF0ZS5ub3coKSB8fCBiaW5kaW5nLnBhcmVudC51cmwgPT09IHNlbmRlci51cmwgJiYgYmluZGluZy5vcmlnaW4gPT09IG9yaWdpbikgbmF0aXZlUnVudGltZVRpY2tldHMuZGVsZXRlKHRpY2tldCk7XG4gICAgY29uc3QgdGlja2V0ID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICBuYXRpdmVSdW50aW1lVGlja2V0cy5zZXQodGlja2V0LCB7IHBhcmVudDogc2VuZGVyLCB3aW5kb3dJZCwgb3JpZ2luLCBleHBpcmVzOiBEYXRlLm5vdygpICsgMTUwMDAgfSk7XG4gICAgcmV0dXJuIHRpY2tldDtcbn1cbmZ1bmN0aW9uIHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgeyByZXR1cm4gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuaGFzKHNlbmRlcik7IH1cbmZ1bmN0aW9uIHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKSB7XG4gICAgY29uc3QgbmF0aXZlID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKG5hdGl2ZSkgcmV0dXJuIG5hdGl2ZS5vcmlnaW47XG4gICAgaWYgKHR5cGVvZiB0cnVzdGVkQ29udGVudFNlbmRlciA9PT0gJ2Z1bmN0aW9uJyAmJiB0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSByZXR1cm4gbmV3IFVSTChzZW5kZXIudXJsKS5vcmlnaW47XG4gICAgdGhyb3cgRXJyb3IoJ1VuYm91bmQgcnVudGltZSBpZGVudGl0eScpO1xufVxuLy8gVHJhY2sgYWN0dWFsIGZvY3VzZWQtc2l0ZSB1c2UsIG5vdCBwZXJpb2RpYyBzbmFwc2hvdHMgZnJvbSBhIGJhY2tncm91bmQgd2luZG93LlxubGV0IG5hdGl2ZUZvY3VzR2VuZXJhdGlvbiA9IDA7XG5hc3luYyBmdW5jdGlvbiBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyh3aW5kb3dJZCkge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSArK25hdGl2ZUZvY3VzR2VuZXJhdGlvbjtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB3aW5kb3cgPSBhd2FpdCBjaHJvbWUud2luZG93cy5nZXQod2luZG93SWQpO1xuICAgICAgICBpZiAoIXdpbmRvdy5mb2N1c2VkKSByZXR1cm47XG4gICAgICAgIGNvbnN0IFt0YWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkIH0pO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiA9PT0gbmF0aXZlRm9jdXNHZW5lcmF0aW9uICYmIHN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSBhd2FpdCBuYXRpdmVSZW1lbWJlck9yaWdpbihuZXcgVVJMKHRhYi51cmwpLm9yaWdpbik7XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC91bmF2YWlsYWJsZSB3aW5kb3cgbXVzdCBub3QgY2hhbmdlIHRoZSBzYXZlZCBzZWxlY3Rpb24uICovIH1cbn1cbmNocm9tZS50YWJzPy5vbkFjdGl2YXRlZD8uYWRkTGlzdGVuZXIoaW5mbyA9PiB7IHZvaWQgbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3coaW5mby53aW5kb3dJZCk7IH0pO1xuY2hyb21lLnRhYnM/Lm9uVXBkYXRlZD8uYWRkTGlzdGVuZXIoKGlkLCBjaGFuZ2UsIHRhYikgPT4geyBpZiAodGFiLmFjdGl2ZSAmJiBjaGFuZ2UudXJsKSB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHRhYi53aW5kb3dJZCk7IH0pO1xuY2hyb21lLndpbmRvd3M/Lm9uRm9jdXNDaGFuZ2VkPy5hZGRMaXN0ZW5lcih3aW5kb3dJZCA9PiB7IGlmICh3aW5kb3dJZCA+PSAwKSB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvd0lkKTsgZWxzZSBuYXRpdmVGb2N1c0dlbmVyYXRpb24rKzsgfSk7XG5pZiAoY2hyb21lLndpbmRvd3M/LmdldExhc3RGb2N1c2VkKSBjaHJvbWUud2luZG93cy5nZXRMYXN0Rm9jdXNlZCgpLnRoZW4od2luZG93ID0+IG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvdy5pZCksICgpID0+IHt9KTtcbmZ1bmN0aW9uIG5hdGl2ZURyYWZ0TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2xvc2VkKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoRXJyb3IoJ1VuYm91bmQgcnVudGltZScpKTtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdE5hdGl2ZURyYWZ0X3YxOicgKyBzZXNzaW9uLndpbmRvd0lkICsgJzonICsgc2Vzc2lvbi5vcmlnaW47XG4gICAgY29uc3Qgd29yayA9IG5hdGl2ZURyYWZ0Q2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om5hdGl2ZS1kcmFmdC13cml0ZScpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZS52YWx1ZSAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS52YWx1ZS5sZW5ndGggPiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgZHJhZnQnKTtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW2tleV06IG1lc3NhZ2UudmFsdWUgfSk7XG4gICAgICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KGtleSkpW2tleV0gIT09IG1lc3NhZ2UudmFsdWUpIHRocm93IEVycm9yKCdEcmFmdCBub3QgZHVyYWJsZScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHZhbHVlID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KGtleSkpW2tleV07XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyA/IHZhbHVlIDogJycgfTtcbiAgICB9KTtcbiAgICBuYXRpdmVEcmFmdENoYWluID0gd29yay5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHdvcms7XG59XG5mdW5jdGlvbiBuYXRpdmVSdW50aW1lU2Vzc2lvbktleShwYXJlbnQsIG9yaWdpbikgeyByZXR1cm4gcGFyZW50LnVybCArICc6JyArIG9yaWdpbjsgfVxuZnVuY3Rpb24gbmF0aXZlUnVudGltZVJlcXVlc3Qoc2Vzc2lvbiwgbWVzc2FnZSkge1xuICAgIGlmIChzZXNzaW9uLmNsb3NlZCkgcmV0dXJuIFByb21pc2UucmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTtcbiAgICBjb25zdCBpZCA9ICsrc2Vzc2lvbi5zZXF1ZW5jZTtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBzZXNzaW9uLnBlbmRpbmcuZGVsZXRlKGlkKTsgcmVqZWN0KEVycm9yKCdSdW50aW1lIHRpbWVkIG91dCcpKTsgfSwgNTAwMCk7XG4gICAgICAgIHNlc3Npb24ucGVuZGluZy5zZXQoaWQsIHsgcmVzb2x2ZSwgcmVqZWN0LCB0aW1lciB9KTtcbiAgICAgICAgdHJ5IHsgc2Vzc2lvbi5wb3J0LnBvc3RNZXNzYWdlKHsgY2FsbDogaWQsIG1lc3NhZ2UgfSk7IH1cbiAgICAgICAgY2F0Y2ggeyBjbGVhclRpbWVvdXQodGltZXIpOyBzZXNzaW9uLnBlbmRpbmcuZGVsZXRlKGlkKTsgcmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTsgfVxuICAgIH0pO1xufVxuZnVuY3Rpb24gbmF0aXZlUnVudGltZU5vdGlmeShzZW5kZXIsIG1lc3NhZ2UpIHtcbiAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2xvc2VkKSB0aHJvdyBFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKTtcbiAgICBzZXNzaW9uLnBvcnQucG9zdE1lc3NhZ2UoeyBtZXNzYWdlIH0pO1xufVxuY2hyb21lLnJ1bnRpbWUub25Db25uZWN0LmFkZExpc3RlbmVyKHBvcnQgPT4ge1xuICAgIGlmIChwb3J0Lm5hbWUgIT09ICdtZW1jaGF0LW5hdGl2ZS1ydW50aW1lJykgcmV0dXJuO1xuICAgIGNvbnN0IHNlbmRlciA9IHBvcnQuc2VuZGVyO1xuICAgIGlmIChzZW5kZXI/LmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCBzZW5kZXIudGFiIHx8IHNlbmRlci5mcmFtZUlkICE9PSB1bmRlZmluZWQgJiYgc2VuZGVyLmZyYW1lSWQgIT09IDBcbiAgICAgICAgfHwgIW5hdGl2ZURvY3VtZW50VXJsKHNlbmRlci51cmwsICdydW50aW1lJywgJ3J1bnRpbWUnKSkgeyBwb3J0LmRpc2Nvbm5lY3QoKTsgcmV0dXJuOyB9XG4gICAgbGV0IHNlc3Npb24sIGJpbmRpbmcgPSBmYWxzZSwgZGlzY29ubmVjdGVkID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGlmICghc2Vzc2lvbiB8fCBzZXNzaW9uLmNsb3NlZCkgcmV0dXJuO1xuICAgICAgICBzZXNzaW9uLmNsb3NlZCA9IHRydWU7IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmRlbGV0ZShzZW5kZXIpO1xuICAgICAgICBpZiAobmF0aXZlUnVudGltZVNlc3Npb25zLmdldChzZXNzaW9uLmtleSkgPT09IHNlc3Npb24pIG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5kZWxldGUoc2Vzc2lvbi5rZXkpO1xuICAgICAgICBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSgnbmF0aXZlOicgKyBzZW5kZXIudXJsKTtcbiAgICAgICAgZm9yIChjb25zdCBwZW5kaW5nIG9mIHNlc3Npb24ucGVuZGluZy52YWx1ZXMoKSkgeyBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7IHBlbmRpbmcucmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTsgfVxuICAgICAgICBzZXNzaW9uLnBlbmRpbmcuY2xlYXIoKTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCByZXF1ZXN0XSBvZiBwZW5kaW5nUmVxdWVzdHMpIGlmIChrZXkuc3RhcnRzV2l0aCgnbmF0aXZlOicgKyBzZW5kZXIudXJsICsgJzonKSkgeyByZXF1ZXN0LmV2ZW50ID0gJ2Fib3J0JzsgcmVxdWVzdC5jb250cm9sbGVyLmFib3J0KCk7IH1cbiAgICB9O1xuICAgIHBvcnQub25EaXNjb25uZWN0LmFkZExpc3RlbmVyKGNsb3NlKTtcbiAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyBwYWNrZXQgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKGJpbmRpbmcpIHRocm93IEVycm9yKCdBbHJlYWR5IGJpbmRpbmcnKTtcbiAgICAgICAgICAgICAgICBiaW5kaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBjYXBhYmlsaXR5ID0gbmF0aXZlUnVudGltZVRpY2tldHMuZ2V0KHBhY2tldD8udGlja2V0KTtcbiAgICAgICAgICAgICAgICBuYXRpdmVSdW50aW1lVGlja2V0cy5kZWxldGUocGFja2V0Py50aWNrZXQpO1xuICAgICAgICAgICAgICAgIGlmICghY2FwYWJpbGl0eSB8fCBjYXBhYmlsaXR5LmV4cGlyZXMgPCBEYXRlLm5vdygpIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KGNhcGFiaWxpdHkucGFyZW50LCBjYXBhYmlsaXR5LndpbmRvd0lkKSB8fCBkaXNjb25uZWN0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIG5hdGl2ZSBjYXBhYmlsaXR5Jyk7XG4gICAgICAgICAgICAgICAgY29uc3Qga2V5ID0gbmF0aXZlUnVudGltZVNlc3Npb25LZXkoY2FwYWJpbGl0eS5wYXJlbnQsIGNhcGFiaWxpdHkub3JpZ2luKTtcbiAgICAgICAgICAgICAgICBpZiAobmF0aXZlUnVudGltZVNlc3Npb25zLmhhcyhrZXkpKSB0aHJvdyBFcnJvcignUnVudGltZSBhbHJlYWR5IGJvdW5kJyk7XG4gICAgICAgICAgICAgICAgc2Vzc2lvbiA9IHsgLi4uY2FwYWJpbGl0eSwga2V5LCBzZW5kZXIsIHBvcnQsIHBlbmRpbmc6IG5ldyBNYXAoKSwgc2VxdWVuY2U6IDAsIGNsb3NlZDogZmFsc2UgfTtcbiAgICAgICAgICAgICAgICBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5zZXQoc2VuZGVyLCBzZXNzaW9uKTsgbmF0aXZlUnVudGltZVNlc3Npb25zLnNldChrZXksIHNlc3Npb24pO1xuICAgICAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2UoeyByZWFkeTogdHJ1ZSB9KTsgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKE51bWJlci5pc1NhZmVJbnRlZ2VyKHBhY2tldD8uYW5zd2VyKSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBlbmRpbmcgPSBzZXNzaW9uLnBlbmRpbmcuZ2V0KHBhY2tldC5hbnN3ZXIpO1xuICAgICAgICAgICAgICAgIGlmIChwZW5kaW5nKSB7IHNlc3Npb24ucGVuZGluZy5kZWxldGUocGFja2V0LmFuc3dlcik7IGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVyKTsgcGVuZGluZy5yZXNvbHZlKHBhY2tldC5yZXBseSk7IH1cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHBhY2tldD8uaWQpIHx8IHBhY2tldC5pZCA8IDEgfHwgIXBhY2tldC5tZXNzYWdlIHx8IHNlc3Npb24uY2xvc2VkKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgcGFja2V0Jyk7XG4gICAgICAgICAgICAvLyBDaGVjayB0aGUgcGFyZW50IGlzIHN0aWxsIGEgbmF0aXZlIGRvY3VtZW50IGluIHRoZSBib3VuZCB3aW5kb3cuXG4gICAgICAgICAgICBpZiAoIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2Vzc2lvbi5wYXJlbnQsIHNlc3Npb24ud2luZG93SWQpIHx8IHNlc3Npb24uY2xvc2VkKSB0aHJvdyBFcnJvcignTmF0aXZlIHBhcmVudCBjbG9zZWQnKTtcbiAgICAgICAgICAgIGxldCBhbnN3ZXJlZCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc3QgaGFuZGxlZCA9IGV4dGVuc2lvbkhhbmRsZU1lc3NhZ2UocGFja2V0Lm1lc3NhZ2UsIHNlbmRlciwgcmVwbHkgPT4ge1xuICAgICAgICAgICAgICAgIGFuc3dlcmVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoIXNlc3Npb24uY2xvc2VkKSBwb3J0LnBvc3RNZXNzYWdlKHsgaWQ6IHBhY2tldC5pZCwgcmVwbHkgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmICghaGFuZGxlZCAmJiAhYW5zd2VyZWQpIHBvcnQucG9zdE1lc3NhZ2UoeyBpZDogcGFja2V0LmlkLCByZXBseTogeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC30LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjycgfSB9KTtcbiAgICAgICAgfSBjYXRjaCB7IGNsb3NlKCk7IHRyeSB7IHBvcnQuZGlzY29ubmVjdCgpOyB9IGNhdGNoIHsgLyogQWxyZWFkeSBnb25lLiAqLyB9IH1cbiAgICB9KTtcbn0pO1xuIiwiLy8gRXhhY3QtcGFuZWwgcHJpdmF0ZSBwb3J0OiBuZXZlciBicm9hZGNhc3QgaGlzdG9yeSBhbmQgbmV2ZXIgcGVyc2lzdCBpdC5cbmNvbnN0IHNpZGViYXJIaXN0b3J5T3duZXJzID0gbmV3IE1hcCgpO1xuY29uc3QgU0lERUJBUl9DSEFUX01PREVTID0gbmV3IFNldChbJ2NoZWNrSGF0aWtvJywgJ2NoZWNrSGF0aWtvQm9udXNlcycsICdjYWxjdWxhdG9yJyxcbiAgICAnY2FsY3VsYXRvcl9yZXZlcnNlJywgJ2NhbGN1bGF0b3JfZGlzY291bnQnLCAnY2FsY3VsYXRvcl9zaW1wbGUnXSk7XG5mdW5jdGlvbiBzaWRlYmFySGlzdG9yeVRhcmdldChzZW5kZXIpIHtcbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICduYXRpdmU6JyArIHNlbmRlci51cmw7XG4gICAgaWYgKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHJldHVybiAndGFiOicgKyBzZW5kZXIudGFiLmlkO1xuICAgIHJldHVybiBudWxsO1xufVxuZnVuY3Rpb24gc2lkZWJhckhpc3RvcnlCaW5kKHBhcmVudCwgdGFyZ2V0LCBkb2N1bWVudFRva2VuKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzaWRlYmFySGlzdG9yeU93bmVycy5nZXQocGFyZW50LnVybCk7XG4gICAgaWYgKCFvd25lciB8fCAhdGFyZ2V0IHx8IHR5cGVvZiBkb2N1bWVudFRva2VuICE9PSAnc3RyaW5nJykgcmV0dXJuO1xuICAgIG93bmVyLnRhcmdldHMuc2V0KHRhcmdldCwgZG9jdW1lbnRUb2tlbik7XG59XG5jaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIocG9ydCA9PiB7XG4gICAgaWYgKHBvcnQubmFtZSAhPT0gJ21lbWNoYXQtc2lkZWJhci1oaXN0b3J5JykgcmV0dXJuO1xuICAgIGNvbnN0IHNlbmRlciA9IHBvcnQuc2VuZGVyO1xuICAgIGxldCBvd25lciwgZGlzY29ubmVjdGVkID0gZmFsc2UsIGJpbmRpbmcgPSBmYWxzZTtcbiAgICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKCFvd25lcikgcmV0dXJuO1xuICAgICAgICBpZiAoc2lkZWJhckhpc3RvcnlPd25lcnMuZ2V0KHNlbmRlci51cmwpID09PSBvd25lcikgc2lkZWJhckhpc3RvcnlPd25lcnMuZGVsZXRlKHNlbmRlci51cmwpO1xuICAgICAgICBmb3IgKGNvbnN0IHBlbmRpbmcgb2Ygb3duZXIucGVuZGluZy52YWx1ZXMoKSkgeyBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7IHBlbmRpbmcucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY2xvc2VkOiB0cnVlIH0pOyB9XG4gICAgICAgIG93bmVyLnBlbmRpbmcuY2xlYXIoKTsgb3duZXIudGFyZ2V0cy5jbGVhcigpO1xuICAgIH07XG4gICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoY2xvc2UpO1xuICAgIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKGFzeW5jIG1lc3NhZ2UgPT4ge1xuICAgICAgICBpZiAoZGlzY29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIW93bmVyKSB7XG4gICAgICAgICAgICAgICAgaWYgKGJpbmRpbmcgfHwgbWVzc2FnZT8udHlwZSAhPT0gJ2JpbmQnKSB0aHJvdyBFcnJvcignSW52YWxpZCBoaXN0b3J5IGJpbmRpbmcnKTtcbiAgICAgICAgICAgICAgICBiaW5kaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkKSB8fCBkaXNjb25uZWN0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIHBhbmVsJyk7XG4gICAgICAgICAgICAgICAgLy8gQSByZXBsYWNlbWVudCBwb3J0IG1heSBub3QgaGlqYWNrIGFuIGV4aXN0aW5nIGNvbnZlcnNhdGlvbi5cbiAgICAgICAgICAgICAgICBpZiAoc2lkZWJhckhpc3RvcnlPd25lcnMuaGFzKHNlbmRlci51cmwpKSB0aHJvdyBFcnJvcignQWxyZWFkeSBib3VuZCcpO1xuICAgICAgICAgICAgICAgIG93bmVyID0geyBpZDogY3J5cHRvLnJhbmRvbVVVSUQoKSwgc2VuZGVyLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCwgcG9ydCwgdGFyZ2V0czogbmV3IE1hcCgpLCBwZW5kaW5nOiBuZXcgTWFwKCkgfTtcbiAgICAgICAgICAgICAgICBzaWRlYmFySGlzdG9yeU93bmVycy5zZXQoc2VuZGVyLnVybCwgb3duZXIpO1xuICAgICAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2UoeyByZWFkeTogdHJ1ZSwgb3duZXI6IG93bmVyLmlkIH0pOyByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobWVzc2FnZT8udHlwZSAhPT0gJ2FjaycgfHwgdHlwZW9mIG1lc3NhZ2UuaWQgIT09ICdzdHJpbmcnKSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBwZW5kaW5nID0gb3duZXIucGVuZGluZy5nZXQobWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBpZiAocGVuZGluZykgeyBvd25lci5wZW5kaW5nLmRlbGV0ZShtZXNzYWdlLmlkKTsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlc29sdmUoeyBvazogdHJ1ZSB9KTsgfVxuICAgICAgICB9IGNhdGNoIHsgY2xvc2UoKTsgdHJ5IHsgcG9ydC5kaXNjb25uZWN0KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGNsb3NlZCAqLyB9IH1cbiAgICB9KTtcbn0pO1xuZnVuY3Rpb24gc2lkZWJhckhpc3RvcnlNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgcmVwbHkpIHtcbiAgICBpZiAobWVzc2FnZT8udHlwZSAhPT0gJ21lbWNoYXQ6Y2hhdC1ldmVudCcpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBydW4gPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IHNpZGViYXJIaXN0b3J5VGFyZ2V0KHNlbmRlcik7XG4gICAgICAgIGNvbnN0IG93bmVyID0gWy4uLnNpZGViYXJIaXN0b3J5T3duZXJzLnZhbHVlcygpXS5maW5kKHZhbHVlID0+IHZhbHVlLmlkID09PSBtZXNzYWdlLm93bmVyKTtcbiAgICAgICAgaWYgKCFvd25lcikgcmV0dXJuIHsgb2s6IGZhbHNlLCBjbG9zZWQ6IHRydWUgfTtcbiAgICAgICAgaWYgKCF0YXJnZXQgfHwgb3duZXIudGFyZ2V0cy5nZXQodGFyZ2V0KSAhPT0gbWVzc2FnZS5kb2N1bWVudFRva2VuIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KG93bmVyLnNlbmRlciwgb3duZXIud2luZG93SWQpKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgaWYgKCFTSURFQkFSX0NIQVRfTU9ERVMuaGFzKG1lc3NhZ2UuYWN0aW9uKSB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5lcG9jaCkgfHwgbWVzc2FnZS5lcG9jaCA8IDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmlkICE9PSAnc3RyaW5nJyB8fCAhL15bYS1mMC05LV17MzZ9JC8udGVzdChtZXNzYWdlLmlkKVxuICAgICAgICAgICAgfHwgIVsnYXBwZW5kJywgJ2NsZWFyJ10uaW5jbHVkZXMobWVzc2FnZS5vcGVyYXRpb24pKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgaWYgKG1lc3NhZ2Uub3BlcmF0aW9uID09PSAnYXBwZW5kJykge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBtZXNzYWdlLmVudHJ5O1xuICAgICAgICAgICAgaWYgKCFlbnRyeSB8fCBlbnRyeS5hY3Rpb24gIT09IG1lc3NhZ2UuYWN0aW9uIHx8ICFbJ3VzZXInLCAnYm90JywgJ3N5c3RlbSddLmluY2x1ZGVzKGVudHJ5LnNlbmRlcilcbiAgICAgICAgICAgICAgICB8fCAhWydtZXNzYWdlJywgJ2Vtb2ppJywgJ3RpbWVzdGFtcCcsICdxdWVyeSddLmV2ZXJ5KGtleSA9PiB0eXBlb2YgZW50cnlba2V5XSA9PT0gJ3N0cmluZycpXG4gICAgICAgICAgICAgICAgfHwgSlNPTi5zdHJpbmdpZnkoZW50cnkpLmxlbmd0aCA+IDEwMjQgKiAxMDI0KSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3duZXIucGVuZGluZy5oYXMobWVzc2FnZS5pZCkgfHwgb3duZXIucGVuZGluZy5zaXplID49IDEyOCkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IG93bmVyLnBlbmRpbmcuZGVsZXRlKG1lc3NhZ2UuaWQpOyByZXNvbHZlKHsgb2s6IGZhbHNlIH0pOyB9LCA1MDAwKTtcbiAgICAgICAgICAgIG93bmVyLnBlbmRpbmcuc2V0KG1lc3NhZ2UuaWQsIHsgcmVzb2x2ZSwgdGltZXIgfSk7XG4gICAgICAgICAgICB0cnkgeyBvd25lci5wb3J0LnBvc3RNZXNzYWdlKHsgZXZlbnQ6IHsgaWQ6IG1lc3NhZ2UuaWQsIG9wZXJhdGlvbjogbWVzc2FnZS5vcGVyYXRpb24sXG4gICAgICAgICAgICAgICAgZXBvY2g6IG1lc3NhZ2UuZXBvY2gsIGFjdGlvbjogbWVzc2FnZS5hY3Rpb24sIGVudHJ5OiBtZXNzYWdlLmVudHJ5IH0gfSk7IH1cbiAgICAgICAgICAgIGNhdGNoIHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgb3duZXIucGVuZGluZy5kZWxldGUobWVzc2FnZS5pZCk7IHJlc29sdmUoeyBvazogZmFsc2UsIGNsb3NlZDogdHJ1ZSB9KTsgfVxuICAgICAgICB9KTtcbiAgICB9O1xuICAgIHJ1bigpLnRoZW4ocmVwbHksICgpID0+IHJlcGx5KHsgb2s6IGZhbHNlIH0pKTsgcmV0dXJuIHRydWU7XG59XG4iLCIvLyBQcml2YXRlIG5hdGl2ZS12aWV3IGNoYW5uZWwuIE5ldmVyIGJyb2FkY2FzdCB2aWV3IGRhdGE6IHJlcGxpZXMgZ28gb25seSB0byB0aGVcbi8vIGV4YWN0IHJlcXVlc3RpbmcgbmF0aXZlIHBhbmVsLiBTaXRlL2FjY291bnQgc3RhdGUgc3RheXMgaW4gaXRzIGNvbnRlbnQgd29ybGQuXG5jb25zdCBTSURFQkFSX0ZFQVRVUkVTID0gT2JqZWN0LmZyZWV6ZShbJ2NoZWNrSGF0aWtvJywgJ2NoZWNrSGF0aWtvQm9udXNlcycsICd0b2RheScsICd0b21vcnJvdycsXG4gICAgJ2NhbGN1bGF0b3InLCAnY2FsY3VsYXRvcl9yZXZlcnNlJywgJ2NhbGN1bGF0b3JfZGlzY291bnQnLCAnY2FsY3VsYXRvcl9zaW1wbGUnLCAnaGFja2VyJywgJ3NldHRpbmdzJ10pO1xuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpIHtcbiAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KTtcbiAgICBpZiAoIXN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ3Vuc3VwcG9ydGVkJyB9O1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcgJiYgdGFiLmlkICE9PSBtZXNzYWdlLnRhYklkKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgY29uc3QgY29tbWFuZCA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1zdGF0dXMnXG4gICAgICAgID8geyB0eXBlOiAnbWVtY2hhdDpmZWF0dXJlLXN0YXR1cycgfSA6IHsgdHlwZTogJ21lbWNoYXQ6b3Blbi1mZWF0dXJlJywgZmVhdHVyZTogbWVzc2FnZS5mZWF0dXJlIH07XG4gICAgbGV0IHJlcGx5O1xuICAgIHRyeSB7IHJlcGx5ID0gYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCBjb21tYW5kLCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTsgfVxuICAgIGlmICghcmVwbHk/Lm9rKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogWydzdG9yYWdlJywgJ2NvbmZsaWN0J10uaW5jbHVkZXMocmVwbHk/LnJlYXNvbikgPyByZXBseS5yZWFzb24gOiAnZmFpbGVkJyB9O1xuICAgIC8vIE5ldmVyIGZvcndhcmQgYW4gYXJiaXRyYXJ5IGNvbnRlbnQgcmVwbHksIHRhYiB0aXRsZSwgVVJMIHBhdGgvcXVlcnkgb3IgcGVyc2lzdGVkIGRhdGEuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRhYklkOiB0YWIuaWQsIGhvc3Q6IG5ldyBVUkwodGFiLnVybCkuaG9zdG5hbWUgfTtcbn1cbi8vIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlIGhhcyBubyB0aW1lb3V0IG9mIGl0cyBvd246IGEgZnJvemVuIGJhY2tncm91bmQgdGFiXG4vLyAoQ2hyb21lIEZyZWV6aW5nKSBvciBhIHN0dWNrIGNvbnRlbnQgaGFuZGxlciB3b3VsZCBob2xkIHRoZSBwYW5lbCB1bnRpbCBpdHNcbi8vIG93biA4IHMgZGVhZGxpbmUgd2l0aCBhIHZhZ3VlIHRpbWVvdXQuIEFuc3dlciB0aGUgcGFuZWwgZmlyc3QgaW5zdGVhZC5cbmxldCBTSURFQkFSX1ZJRVdfREVBRExJTkVfTVMgPSA0MDAwO1xuZnVuY3Rpb24gc2lkZWJhclNlbmRUb1RhYih0YWJJZCwgbWVzc2FnZSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoeyBvazogZmFsc2UsIHJlYXNvbjogJ3RpbWVvdXQnIH0pLCBTSURFQkFSX1ZJRVdfREVBRExJTkVfTVMpO1xuICAgICAgICBsZXQgc2VudDtcbiAgICAgICAgdHJ5IHsgc2VudCA9IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCBtZXNzYWdlLCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICAgICAgY2F0Y2ggeyBjbGVhclRpbWVvdXQodGltZXIpOyByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9KTsgcmV0dXJuOyB9XG4gICAgICAgIC8vIFRoZXJlIGlzIG5vIEFib3J0Q29udHJvbGxlciBmb3Igc2VuZE1lc3NhZ2UuIFRoZSBsb3NpbmcgcHJvbWlzZSBzdGlsbFxuICAgICAgICAvLyBzZXR0bGVzIGxhdGVyLCBzbyBib3RoIGEgbGF0ZSByZXBseSBhbmQgYSBsYXRlIHJlamVjdGlvbiBhcmUgYWJzb3JiZWQuXG4gICAgICAgIFByb21pc2UucmVzb2x2ZShzZW50KS50aGVuKHJlcGx5ID0+IHJlc29sdmUocmVwbHkpLCAoKSA9PiByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9KSlcbiAgICAgICAgICAgIC5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lcikpO1xuICAgIH0pO1xufVxuLy8gQSBwYW5lbCdzIHRhcmdldCBpcyBjYXB0dXJlZCBvbmNlIGFuZCB0aGVuIHJlYWQsIG5ldmVyIHJlY29tcHV0ZWQgZnJvbSB0aGVcbi8vIGxpdmUgdGFiIFVSTDoge3RhYklkLCB3aW5kb3dJZCwgb3JpZ2luLCBzdXBwb3J0ZWR9LiBUaGUgb3JpZ2luIChhbmQgd2l0aCBpdFxuLy8gdGhlIHByaXZhdGUgYnVja2V0KSB0aGVyZWZvcmUgc3RheXMgcHV0IHdoaWxlIHRoZSBib3VuZCB0YWIgbmF2aWdhdGVzLCBsb3Nlc1xuLy8gZm9jdXMgb3IgaXMgcmVzdG9yZWQuIE9ubHkgYW4gZXhwbGljaXQgKHJlKWJpbmQgKG5vIHRhYklkKSBvciBhIHRhYi93aW5kb3dcbi8vIG1pc21hdGNoIHJld3JpdGVzIGl0OyBsaXZlbmVzcyBpcyBjaGVja2VkIHNlcGFyYXRlbHkuXG4vLyBNVjMga2lsbHMgdGhlIHdvcmtlciBhZnRlciBpZGxlIHRpbWUsIHNvIHRoZSBNYXAgYWxvbmUgd291bGQgcmVzdG9yZSBmcm9tIHRoZVxuLy8gZ2xvYmFsIGxhc3Qtb3JpZ2luIGd1ZXNzIG9uIHdha2UuIEEgY29weSBwZXIgcGFuZWwgZG9jdW1lbnQgbGl2ZXMgaW5cbi8vIGNocm9tZS5zdG9yYWdlLnNlc3Npb24gKGJyb3dzZXIgbGlmZXRpbWUsIG5ldmVyIGRpc2spIGFuZCBpcyByZWFkIGJhY2sgZmlyc3QuXG5jb25zdCBTSURFQkFSX0JJTkRJTkdfS0VZID0gJ21lbWNoYXRTaWRlYmFyQmluZGluZ192MSc7XG5jb25zdCBTSURFQkFSX0JJTkRJTkdfTUFYX0FHRV9NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XG5jb25zdCBzaWRlYmFyQmluZGluZ3MgPSBuZXcgTWFwKCk7XG5sZXQgc2lkZWJhckJpbmRpbmdSZWNvcmRzID0gbnVsbDtcbmxldCBzaWRlYmFyQmluZGluZ0NoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyQmluZGluZ0xvYWQoKSB7XG4gICAgaWYgKHNpZGViYXJCaW5kaW5nUmVjb3JkcykgcmV0dXJuIHNpZGViYXJCaW5kaW5nUmVjb3JkcztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChTSURFQkFSX0JJTkRJTkdfS0VZKSlbU0lERUJBUl9CSU5ESU5HX0tFWV07XG4gICAgICAgIHNpZGViYXJCaW5kaW5nUmVjb3JkcyA9IHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkoc2F2ZWQpID8gc2F2ZWQgOiB7fTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1zdG9yYWdlJywgZGV0YWlsOiB7IHJlYXNvbjogJ3JlYWQnIH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICBzaWRlYmFyQmluZGluZ1JlY29yZHMgPSB7fTtcbiAgICB9XG4gICAgcmV0dXJuIHNpZGViYXJCaW5kaW5nUmVjb3Jkcztcbn1cbmZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nVmFsaWQoYmluZGluZykge1xuICAgIHJldHVybiAhIWJpbmRpbmcgJiYgTnVtYmVyLmlzSW50ZWdlcihiaW5kaW5nLnRhYklkKSAmJiBiaW5kaW5nLnRhYklkID49IDBcbiAgICAgICAgJiYgTnVtYmVyLmlzSW50ZWdlcihiaW5kaW5nLndpbmRvd0lkKSAmJiBiaW5kaW5nLndpbmRvd0lkID49IDBcbiAgICAgICAgJiYgdHlwZW9mIGJpbmRpbmcub3JpZ2luID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgYmluZGluZy5zdXBwb3J0ZWQgPT09ICdib29sZWFuJztcbn1cbi8vIE9uZSBvd25lciwgb25lIGFzc2lnbm1lbnQ6IG9ubHkgYW4gZXhwbGljaXQgcmViaW5kIG9yIGEgcG9zdC1zbGVlcCByZWJ1aWxkXG4vLyB3cml0ZXMuIFJld3JpdGluZyBieSBwYW5lbCBVUkwgYm91bmRzIHRoZSByZWNvcmQgc2V0OyBzdGFsZSBlbnRyaWVzIGFyZVxuLy8gZHJvcHBlZCBoZXJlIGluc3RlYWQgb2YgYnkgYSBzZXBhcmF0ZSBjb2xsZWN0b3IuXG5mdW5jdGlvbiBzaWRlYmFyQmluZGluZ1NhdmUocGFuZWxVcmwsIGJpbmRpbmcpIHtcbiAgICBjb25zdCB3b3JrID0gc2lkZWJhckJpbmRpbmdDaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IHNpZGViYXJCaW5kaW5nTG9hZCgpO1xuICAgICAgICBjb25zdCBjdXRvZmYgPSBEYXRlLm5vdygpIC0gU0lERUJBUl9CSU5ESU5HX01BWF9BR0VfTVM7XG4gICAgICAgIGNvbnN0IG5leHQgPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkcykpIHtcbiAgICAgICAgICAgIGlmIChrZXkgIT09IHBhbmVsVXJsICYmIHNpZGViYXJCaW5kaW5nVmFsaWQodmFsdWUpICYmIHR5cGVvZiB2YWx1ZS5hdCA9PT0gJ251bWJlcicgJiYgdmFsdWUuYXQgPj0gY3V0b2ZmKSBuZXh0W2tleV0gPSB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBuZXh0W3BhbmVsVXJsXSA9IHsgdGFiSWQ6IGJpbmRpbmcudGFiSWQsIHdpbmRvd0lkOiBiaW5kaW5nLndpbmRvd0lkLCBvcmlnaW46IGJpbmRpbmcub3JpZ2luLFxuICAgICAgICAgICAgc3VwcG9ydGVkOiBiaW5kaW5nLnN1cHBvcnRlZCwgYXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbU0lERUJBUl9CSU5ESU5HX0tFWV06IG5leHQgfSk7XG4gICAgICAgIHNpZGViYXJCaW5kaW5nUmVjb3JkcyA9IG5leHQ7XG4gICAgfSk7XG4gICAgc2lkZWJhckJpbmRpbmdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIC8vIEEgZmFpbGVkIHdyaXRlIGZhbGxzIGJhY2sgdG8gdGhlIGluLW1lbW9yeSBiaW5kaW5nIGZvciB0aGlzIHdvcmtlcidzIGxpZmUuXG4gICAgcmV0dXJuIHdvcmsuY2F0Y2goKCkgPT4ge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICdiaW5kaW5nLXN0b3JhZ2UnLCBkZXRhaWw6IHsgcmVhc29uOiAnd3JpdGUnIH0gfSwgJ3dvcmtlcicpO1xuICAgIH0pO1xufVxuZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdMb2coYmluZGluZywgc291cmNlKSB7XG4gICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdpbmZvJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICdiaW5kaW5nLWNyZWF0ZWQnLCBkZXRhaWw6IHtcbiAgICAgICAgdGFiSWQ6IGJpbmRpbmcudGFiSWQsIG9yaWdpbjogYmluZGluZy5vcmlnaW4sIHN1cHBvcnRlZDogYmluZGluZy5zdXBwb3J0ZWQsIHNvdXJjZVxuICAgIH0gfSwgJ3dvcmtlcicpO1xufVxuZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdNaXNtYXRjaChleHBlY3RlZCwgYWN0dWFsKSB7XG4gICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICd3YXJuJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICdiaW5kaW5nLW1pc21hdGNoJywgZGV0YWlsOiB7XG4gICAgICAgIGV4cGVjdGVkOiB7IHRhYklkOiBleHBlY3RlZC50YWJJZCwgb3JpZ2luOiBleHBlY3RlZC5vcmlnaW4gfSxcbiAgICAgICAgYWN0dWFsOiB7IHRhYklkOiBhY3R1YWwudGFiSWQsIHdpbmRvd0lkOiBhY3R1YWwud2luZG93SWQgfVxuICAgIH0gfSwgJ3dvcmtlcicpO1xufVxuZnVuY3Rpb24gc2lkZWJhckRlYnVnSG9zdChvcmlnaW4pIHtcbiAgICB0cnkgeyByZXR1cm4gdHlwZW9mIG9yaWdpbiA9PT0gJ3N0cmluZycgPyBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUgOiBudWxsOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxufVxuZnVuY3Rpb24gc2lkZWJhckNsaWNrSWQobWVzc2FnZSkge1xuICAgIGNvbnN0IGlkID0gbWVzc2FnZS5jbGlja0lkO1xuICAgIHJldHVybiBtZXNzYWdlLmV2ZW50ID09PSAnY2xpY2snICYmIHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgL15bZy12XXszMn0kLy50ZXN0KGlkKSA/IGlkIDogbnVsbDtcbn1cbi8vIEEgZmFpbGVkIHZpZXcgaXMgdGhlIHNpZ25hbCBhIHBhbmVsLW9ubHkgcmVwb3J0IHVzdWFsbHkgbGFja3M6IGtlZXAgdGhlIGV4YWN0XG4vLyByZWFzb24gYW5kIHdoaWNoIGNhcHR1cmVkIGJpbmRpbmcgcHJvZHVjZWQgaXQsIG5ldmVyIHBhZ2UgY29udGVudC5cbmZ1bmN0aW9uIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgcmVhc29uKSB7XG4gICAgY29uc3QgY2xpY2tJZCA9IHNpZGViYXJDbGlja0lkKG1lc3NhZ2UpO1xuICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3NpZGViYXInLCBldmVudDogJ3ZpZXctZmFpbGVkJywgZGV0YWlsOiB7XG4gICAgICAgIHJlYXNvbiwgdGFiSWQ6IE51bWJlci5pc0ludGVnZXIoYmluZGluZz8udGFiSWQpID8gYmluZGluZy50YWJJZCA6IChOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpID8gbWVzc2FnZS50YWJJZCA6IG51bGwpLFxuICAgICAgICBzdXBwb3J0ZWQ6IGJpbmRpbmc/LnN1cHBvcnRlZCA9PT0gdHJ1ZSwgaG9zdDogc2lkZWJhckRlYnVnSG9zdChiaW5kaW5nPy5vcmlnaW4pLCAuLi4oY2xpY2tJZCA/IHsgY2xpY2tJZCB9IDoge30pXG4gICAgfSB9LCAnd29ya2VyJyk7XG59XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyQmluZGluZ0ZvcihtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gc2lkZWJhckJpbmRpbmdzLmdldChzZW5kZXIudXJsKTtcbiAgICBpZiAobWVzc2FnZS50YWJJZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IFthY3RpdmVdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkIH0pO1xuICAgICAgICBpZiAoIWFjdGl2ZSkgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICAgICAgY29uc3Qgc3VwcG9ydGVkID0gc3VwcG9ydGVkQWN0aW9uVGFiKGFjdGl2ZSk7XG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IHN1cHBvcnRlZCA/IG5ldyBVUkwoYWN0aXZlLnVybCkub3JpZ2luIDogYXdhaXQgbmF0aXZlTGFzdE9yaWdpbigpO1xuICAgICAgICBjb25zdCBiaW5kaW5nID0geyB0YWJJZDogYWN0aXZlLmlkLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCwgb3JpZ2luLCBzdXBwb3J0ZWQgfTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdzLnNldChzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdMb2coYmluZGluZywgJ2V4cGxpY2l0Jyk7XG4gICAgICAgIGF3YWl0IHNpZGViYXJCaW5kaW5nU2F2ZShzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAgICAgcmV0dXJuIHsgYmluZGluZyB9O1xuICAgIH1cbiAgICBpZiAoY3VycmVudCkge1xuICAgICAgICAvLyBUaGUgYmluZGluZyBpcyBpbW11dGFibGUgZm9yIGl0cyBsaWZlOyBhIHBvbGwgbmFtaW5nIGFub3RoZXIgdGFiIGlzIGFcbiAgICAgICAgLy8gc3RhbGUgb3IgZm9yZWlnbiByZXF1ZXN0LCBub3QgYSByZWJpbmQuXG4gICAgICAgIGlmIChjdXJyZW50LnRhYklkICE9PSBtZXNzYWdlLnRhYklkIHx8IGN1cnJlbnQud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQpIHtcbiAgICAgICAgICAgIHNpZGViYXJCaW5kaW5nTWlzbWF0Y2goY3VycmVudCwgbWVzc2FnZSk7XG4gICAgICAgICAgICByZXR1cm4geyByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IGJpbmRpbmc6IGN1cnJlbnQgfTtcbiAgICB9XG4gICAgLy8gVGhlIHdvcmtlciBzbGVwdCBvciByZXN0YXJ0ZWQuIFJlYWQgdGhlIHBhbmVsJ3Mgb3duIGNhcHR1cmVkIHJlY29yZCBmcm9tXG4gICAgLy8gc2Vzc2lvbiBzdG9yYWdlIGZpcnN0OiB0aGF0IGNvcHkgaXMgdGhlIGZpeCBmb3IgYSBzaWxlbnRseSBtb3ZpbmcgcHJpdmF0ZVxuICAgIC8vIGJ1Y2tldC4gT25seSBhIHBhbmVsIHdpdGhvdXQgYW55IHJlY29yZCBpcyByZWJ1aWx0IGZyb20gbGl2ZSB0YWIgc3RhdGUuXG4gICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgc2lkZWJhckJpbmRpbmdMb2FkKCkpW3NlbmRlci51cmxdO1xuICAgIGlmIChzaWRlYmFyQmluZGluZ1ZhbGlkKHNhdmVkKSAmJiBzYXZlZC53aW5kb3dJZCA9PT0gbWVzc2FnZS53aW5kb3dJZCkge1xuICAgICAgICBpZiAoc2F2ZWQudGFiSWQgIT09IG1lc3NhZ2UudGFiSWQpIHtcbiAgICAgICAgICAgIHNpZGViYXJCaW5kaW5nTWlzbWF0Y2goc2F2ZWQsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBiaW5kaW5nID0geyB0YWJJZDogc2F2ZWQudGFiSWQsIHdpbmRvd0lkOiBzYXZlZC53aW5kb3dJZCwgb3JpZ2luOiBzYXZlZC5vcmlnaW4sIHN1cHBvcnRlZDogc2F2ZWQuc3VwcG9ydGVkIH07XG4gICAgICAgIHNpZGViYXJCaW5kaW5ncy5zZXQoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsICdzZXNzaW9uJyk7XG4gICAgICAgIGF3YWl0IHNpZGViYXJCaW5kaW5nU2F2ZShzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAgICAgcmV0dXJuIHsgYmluZGluZyB9O1xuICAgIH1cbiAgICBsZXQgdGFiO1xuICAgIHRyeSB7IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChtZXNzYWdlLnRhYklkKTsgfSBjYXRjaCB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgbnVsbCwgJ2Nsb3NlZCcpO1xuICAgICAgICByZXR1cm4geyByZWFzb246ICdjbG9zZWQnIH07XG4gICAgfVxuICAgIGlmICh0YWIud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCB7IHRhYklkOiB0YWIuaWQsIHdpbmRvd0lkOiB0YWIud2luZG93SWQsIG9yaWdpbjogbnVsbCwgc3VwcG9ydGVkOiBmYWxzZSB9LCAnY2hhbmdlZCcpO1xuICAgICAgICByZXR1cm4geyByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIH1cbiAgICBjb25zdCBzdXBwb3J0ZWQgPSBzdXBwb3J0ZWRBY3Rpb25UYWIodGFiKTtcbiAgICBjb25zdCBvcmlnaW4gPSBzdXBwb3J0ZWQgPyBuZXcgVVJMKHRhYi51cmwpLm9yaWdpbiA6IGF3YWl0IG5hdGl2ZUxhc3RPcmlnaW4oKTtcbiAgICBjb25zdCBiaW5kaW5nID0geyB0YWJJZDogdGFiLmlkLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCwgb3JpZ2luLCBzdXBwb3J0ZWQgfTtcbiAgICBzaWRlYmFyQmluZGluZ3Muc2V0KHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgIC8vIEEgcmVjb3ZlcmVkIGJpbmRpbmcgd2FzIHJlYnVpbHQgYWZ0ZXIgd29ya2VyIHN1c3BlbnNpb24gd2l0aG91dCBhbnkgc2F2ZWRcbiAgICAvLyByZWNvcmQ7IHVubGlrZSBhbiBleHBsaWNpdCBzZWxlY3Rpb24gaXQgcmUtcmVhZHMgY3VycmVudCB0YWIgc3RhdGUsIHdoaWNoXG4gICAgLy8gaXMgdGhlIHJpc2t5IGNhc2UgYW5kIHNob3VsZCBzdGF5IHJhcmUuXG4gICAgc2lkZWJhckJpbmRpbmdMb2coYmluZGluZywgJ3JlY292ZXJlZCcpO1xuICAgIGF3YWl0IHNpZGViYXJCaW5kaW5nU2F2ZShzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICByZXR1cm4geyBiaW5kaW5nIH07XG59XG4vLyBBdmFpbGFiaWxpdHkgb25seTogdGhlIHRhYiBleGlzdHMsIGJlbG9uZ3MgdG8gdGhlIHBhbmVsJ3Mgd2luZG93IGFuZCBpcyBub3Rcbi8vIGRpc2NhcmRlZC91bmxvYWRlZC4gV2hldGhlciB0aGUgcGFnZSBpcyBhIHN1cHBvcnRlZCBzaXRlIGlzIGNhcHR1cmVkIHBvbGljeSBpblxuLy8gdGhlIGJpbmRpbmcsIG5vdCBhIGxpdmVuZXNzIHRlc3QuXG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyQm91bmRUYWIobWVzc2FnZSwgYmluZGluZykge1xuICAgIGxldCB0YWI7XG4gICAgdHJ5IHsgdGFiID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KGJpbmRpbmcudGFiSWQpOyB9IGNhdGNoIHsgcmV0dXJuIHsgcmVhc29uOiAnY2xvc2VkJyB9OyB9XG4gICAgaWYgKHRhYi53aW5kb3dJZCAhPT0gbWVzc2FnZS53aW5kb3dJZCkgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICBpZiAodGFiLnN0YXR1cyA9PT0gJ3VubG9hZGVkJyB8fCB0YWIuZGlzY2FyZGVkID09PSB0cnVlKSByZXR1cm4geyByZWFzb246ICdtaXNzaW5nJyB9O1xuICAgIHJldHVybiB7IHRhYiB9O1xufVxuYXN5bmMgZnVuY3Rpb24gc2lkZWJhclZpZXdEaXNwYXRjaChtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHNpZGViYXJCaW5kaW5nRm9yKG1lc3NhZ2UsIHNlbmRlcik7XG4gICAgaWYgKCFyZXNvbHZlZC5iaW5kaW5nKSB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgbnVsbCwgcmVzb2x2ZWQucmVhc29uIHx8ICdjaGFuZ2VkJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiByZXNvbHZlZC5yZWFzb24gfHwgJ2NoYW5nZWQnIH07XG4gICAgfVxuICAgIGNvbnN0IGJpbmRpbmcgPSByZXNvbHZlZC5iaW5kaW5nO1xuICAgIGNvbnN0IGJvdW5kID0gYXdhaXQgc2lkZWJhckJvdW5kVGFiKG1lc3NhZ2UsIGJpbmRpbmcpO1xuICAgIGlmICghYm91bmQudGFiKSB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgYm91bmQucmVhc29uKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IGJvdW5kLnJlYXNvbiB9O1xuICAgIH1cbiAgICBjb25zdCB0YWIgPSBib3VuZC50YWI7XG4gICAgY29uc3Qgb3JpZ2luID0gYmluZGluZy5vcmlnaW47XG4gICAgLy8gQSBjYXB0dXJlZCBzdXBwb3J0ZWQgYmluZGluZyB3aG9zZSBwYWdlIGhhcyBzaW5jZSBsZWZ0IHRoZSBzdXBwb3J0ZWQgb3JpZ2luXG4gICAgLy8gbG9zdCBpdHMgY29udGVudCBzY3JpcHQuIE5ldmVyIHNpbGVudGx5IG1vdmUgdG8gdGhlIGZhbGxiYWNrIHJ1bnRpbWUvYnVja2V0OlxuICAgIC8vIHJlcG9ydCB0aGUgdHJhbnNpZW50IG1pc3Npbmcgc3RhdGUgc28gdGhlIHBhbmVsIGtlZXBzIGl0cyB2aWV3IGFuZCBnb2VzIGluZXJ0XG4gICAgLy8gdW50aWwgdGhlIHVzZXIgZXhwbGljaXRseSByZWJpbmRzLlxuICAgIGlmIChiaW5kaW5nLnN1cHBvcnRlZCAmJiAoIXN1cHBvcnRlZEFjdGlvblRhYih0YWIpIHx8IG5ldyBVUkwodGFiLnVybCkub3JpZ2luICE9PSBvcmlnaW4pKSB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgJ21pc3NpbmcnKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9O1xuICAgIH1cbiAgICAvLyBUaGUgaGlzdG9yeSBjaGFubmVsIGlzIGEgcHJpdmF0ZSBwZXItcGFuZWwgc2luaywgbmV2ZXIgYSBwcmVjb25kaXRpb24gZm9yXG4gICAgLy8gcmVuZGVyaW5nOiBhIHBhbmVsIHRoYXQgbG9zdCBpdCBzdGlsbCBzaG93cyB0aGUgdmlldyBhbmQgcmVwb3J0cyBpdHMgb3duXG4gICAgLy8gaGlzdG9yeSBlcnJvciwgZXhhY3RseSBhcyBhIG1pc3NpbmcgY3JlZGVudGlhbHMgcGF0aCBtdXN0IHN0YXkgZmFpbC1jbG9zZWRcbiAgICAvLyBmb3Igc3RvcmFnZSBhbG9uZS5cbiAgICBjb25zdCBoaXN0b3J5ID0gc2lkZWJhckhpc3RvcnlPd25lcnMuZ2V0KHNlbmRlci51cmwpO1xuICAgIGNvbnN0IGNsaWNrSWQgPSBzaWRlYmFyQ2xpY2tJZChtZXNzYWdlKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnXG4gICAgICAgID8geyB0eXBlOiAnbWVtY2hhdDp2aWV3LXNuYXBzaG90JyB9XG4gICAgICAgIDogeyB0eXBlOiAnbWVtY2hhdDp2aWV3LWV2ZW50JywgZG9jdW1lbnRUb2tlbjogbWVzc2FnZS5kb2N1bWVudFRva2VuLFxuICAgICAgICAgICAga2V5OiBtZXNzYWdlLmtleSwgZXZlbnQ6IG1lc3NhZ2UuZXZlbnQsIHZhbHVlOiBtZXNzYWdlLnZhbHVlLFxuICAgICAgICAgICAgY2hlY2tlZDogbWVzc2FnZS5jaGVja2VkLCBzZWxlY3RlZDogbWVzc2FnZS5zZWxlY3RlZCxcbiAgICAgICAgICAgIC4uLihtZXNzYWdlLmV2ZW50ID09PSAnY2xpY2snICYmIG1lc3NhZ2UudHJ1c3RlZEdlc3R1cmUgPT09IHRydWUgPyB7IHRydXN0ZWRHZXN0dXJlOiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4oY2xpY2tJZCA/IHsgY2xpY2tJZCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKG1lc3NhZ2UuZXZlbnQgPT09ICdlbnRlcicgPyB7IGV2ZW50SWQ6IG1lc3NhZ2UuZXZlbnRJZCB9IDoge30pIH07XG4gICAgLy8gRm9yd2FyZCB0aGUgcGFuZWwncyBFVGFnIG9ubHkgb24gc25hcHNob3QgcG9sbHM7IGV2ZW50cyBhbHdheXMgbmVlZCB0aGVcbiAgICAvLyBmdWxsIHZpZXcuIFVua25vd24gZmllbGRzIHN0YXkgYWJzZW50IHNvIG9sZCBjb250ZW50IHdvcmxkcyBzZWUgYW5cbiAgICAvLyBvcmRpbmFyeSByZXF1ZXN0LlxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgdHlwZW9mIG1lc3NhZ2Uua25vd25IYXNoID09PSAnc3RyaW5nJykgcmVxdWVzdC5rbm93bkhhc2ggPSBtZXNzYWdlLmtub3duSGFzaDtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnICYmIHR5cGVvZiBtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbiA9PT0gJ3N0cmluZycpIHJlcXVlc3Qua25vd25Eb2N1bWVudFRva2VuID0gbWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW47XG4gICAgLy8gVGhlIHBhbmVsJ3MgY2hhdCBtZW1vcnkgaXMgYWRkcmVzc2VkIGJ5IG93bmVyIGlkIHBsdXMgdGhlIGV4YWN0IGRvY3VtZW50XG4gICAgLy8gdG9rZW4gdGhhdCB3aWxsIGFuc3dlciBpdDsgYSByZXdyaXR0ZW4gZXBvY2ggbWFwIGNhbiBuZWl0aGVyIG1vdmUgYW5cbiAgICAvLyBhbnN3ZXIgaW50byBhbm90aGVyIG1vZGUgbm9yIHJldml2ZSBhIGNsZWFyZWQgaGlzdG9yeS5cbiAgICBpZiAoaGlzdG9yeSkge1xuICAgICAgICByZXF1ZXN0Lmhpc3RvcnlPd25lciA9IGhpc3RvcnkuaWQ7XG4gICAgICAgIHJlcXVlc3QuY2hhdE1vZGUgPSBTSURFQkFSX0ZFQVRVUkVTLmluY2x1ZGVzKG1lc3NhZ2UuY2hhdE1vZGUpID8gbWVzc2FnZS5jaGF0TW9kZSA6IG51bGw7XG4gICAgICAgIHJlcXVlc3QuY2hhdEVwb2NocyA9IE9iamVjdC5mcm9tRW50cmllcyhbLi4uU0lERUJBUl9DSEFUX01PREVTXS5tYXAobW9kZSA9PlxuICAgICAgICAgICAgW21vZGUsIE51bWJlci5pc1NhZmVJbnRlZ2VyKG1lc3NhZ2UuY2hhdEVwb2Nocz8uW21vZGVdKSAmJiBtZXNzYWdlLmNoYXRFcG9jaHNbbW9kZV0gPj0gMCA/IG1lc3NhZ2UuY2hhdEVwb2Noc1ttb2RlXSA6IDBdKSk7XG4gICAgfVxuICAgIGxldCBoaXN0b3J5VGFyZ2V0O1xuICAgIGxldCB2aWV3O1xuICAgIGNvbnN0IHJlbGF5Q2xpY2tUcmFjZSA9IHJvdXRlID0+IHtcbiAgICAgICAgaWYgKGNsaWNrSWQpIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZGVidWcnLCBzY29wZTogJ3NpZGViYXInLCBldmVudDogJ2NsaWNrLXJlbGF5ZWQnLCBkZXRhaWw6IHsgY2xpY2tJZCwgcm91dGUgfSB9LCAnd29ya2VyJyk7XG4gICAgfTtcbiAgICB0cnkge1xuICAgICAgICBpZiAoYmluZGluZy5zdXBwb3J0ZWQpIHtcbiAgICAgICAgICAgIGhpc3RvcnlUYXJnZXQgPSAndGFiOicgKyB0YWIuaWQ7XG4gICAgICAgICAgICByZWxheUNsaWNrVHJhY2UoJ2NvbnRlbnQnKTtcbiAgICAgICAgICAgIHZpZXcgPSBhd2FpdCBzaWRlYmFyU2VuZFRvVGFiKHRhYi5pZCwgcmVxdWVzdCk7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZVNlc3Npb25zLmdldChuYXRpdmVSdW50aW1lU2Vzc2lvbktleShzZW5kZXIsIG9yaWdpbikpO1xuICAgICAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHJ1bnRpbWU6IHsgb3JpZ2luLCB0aWNrZXQ6IGF3YWl0IG5hdGl2ZVJ1bnRpbWVUaWNrZXQoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4pIH0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGhpc3RvcnlUYXJnZXQgPSAnbmF0aXZlOicgKyBzZXNzaW9uLnNlbmRlci51cmw7XG4gICAgICAgICAgICByZWxheUNsaWNrVHJhY2UoJ3J1bnRpbWUnKTtcbiAgICAgICAgICAgIHZpZXcgPSBhd2FpdCBuYXRpdmVSdW50aW1lUmVxdWVzdChzZXNzaW9uLCByZXF1ZXN0KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsICdtaXNzaW5nJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTtcbiAgICB9XG4gICAgLy8gVGhlIGJvdW5kIHRhYiBpdHNlbGYgbXVzdCBzdGlsbCBleGlzdCBpbiB0aGUgcGFuZWwncyB3aW5kb3c7IG5ldmVyIHJlLXRhcmdldFxuICAgIC8vIHRvIHdoYXRldmVyIGhhcHBlbnMgdG8gYmUgYWN0aXZlLiBUaGUgY29udGVudCBkb2N1bWVudFRva2VuIHN0aWxsIHBpbnMgZXZlbnRzLlxuICAgIGxldCBhbGl2ZTtcbiAgICB0cnkgeyBhbGl2ZSA9IGF3YWl0IGNocm9tZS50YWJzLmdldCh0YWIuaWQpOyB9IGNhdGNoIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCAnY2xvc2VkJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnY2xvc2VkJyB9O1xuICAgIH1cbiAgICBpZiAoYWxpdmUud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQgfHwgIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkKSkge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsICdjaGFuZ2VkJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICB9XG4gICAgaWYgKCF2aWV3Py5vaykge1xuICAgICAgICBjb25zdCByZWFzb24gPSBbJ3N0b3JhZ2UnLCAnY29uZmxpY3QnLCAnY2hhbmdlZCcsICd0aW1lb3V0JywgJ3Rvby1sYXJnZSddLmluY2x1ZGVzKHZpZXc/LnJlYXNvbikgPyB2aWV3LnJlYXNvbiA6ICdmYWlsZWQnO1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsIHJlYXNvbik7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uIH07XG4gICAgfVxuICAgIC8vIE9ubHkgYSBmaXJzdCBiaW5kaW5nIG9yIGFuIGV2ZW50IGZyb20gdGhlIHZpc2libGUgYm91bmQgdGFiIHJlY29yZHMgdGhlXG4gICAgLy8gc2VsZWN0aW9uOyBhIGJhY2tncm91bmQgcG9sbCBvZiBhIG5vbi1hY3RpdmUgdGFiIG11c3Qgbm90IG92ZXJ3cml0ZSBpdC5cbiAgICBjb25zdCBhY3RpdmVCb3VuZCA9IG1lc3NhZ2UudGFiSWQgPT09IHVuZGVmaW5lZCB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50J1xuICAgICAgICAmJiAoYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkIH0pKVswXT8uaWQgPT09IHRhYi5pZCk7XG4gICAgaWYgKGJpbmRpbmcuc3VwcG9ydGVkICYmIGFjdGl2ZUJvdW5kICYmIChhd2FpdCBjaHJvbWUud2luZG93cy5nZXQobWVzc2FnZS53aW5kb3dJZCkpLmZvY3VzZWQpIGF3YWl0IG5hdGl2ZVJlbWVtYmVyT3JpZ2luKG9yaWdpbik7XG4gICAgLy8gT25seSBhIHZpZXcgdGhhdCByZWFsbHkgYW5zd2VyZWQgbWF5IGJlY29tZSB0aGUgdGFyZ2V0IG9mIHRoaXMgcGFuZWwnc1xuICAgIC8vIGNoYXQgc2luazsgYSByZWZ1c2VkIHJlcXVlc3QgbXVzdCBub3QgYmluZCBhIGRvY3VtZW50IHRoYXQgbmV2ZXIgcmVuZGVyZWQuXG4gICAgaWYgKGhpc3RvcnkpIHNpZGViYXJIaXN0b3J5QmluZChzZW5kZXIsIGhpc3RvcnlUYXJnZXQsIHZpZXcuZG9jdW1lbnRUb2tlbik7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRhYklkOiB0YWIuaWQsIGhvc3Q6IG5ldyBVUkwob3JpZ2luKS5ob3N0bmFtZSwgbmF0aXZlOiAhYmluZGluZy5zdXBwb3J0ZWQsIHZpZXcgfTtcbn1cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZSwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICBpZiAoIVsnbWVtY2hhdDpzaWRlYmFyLXN0YXR1cycsICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcsICdtZW1jaGF0OnNpZGViYXItdmlldycsICdtZW1jaGF0OnNpZGViYXItZXZlbnQnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWIgfHwgKHNlbmRlci5mcmFtZUlkICE9PSB1bmRlZmluZWQgJiYgc2VuZGVyLmZyYW1lSWQgIT09IDApXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpXG4gICAgICAgIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2Uud2luZG93SWQpIHx8IG1lc3NhZ2Uud2luZG93SWQgPCAwXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpIHx8IG1lc3NhZ2UudGFiSWQgPCAwXG4gICAgICAgICAgICB8fCAhU0lERUJBUl9GRUFUVVJFUy5pbmNsdWRlcyhtZXNzYWdlLmZlYXR1cmUpKSlcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JyAmJiBtZXNzYWdlLnRhYklkICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpIHx8IG1lc3NhZ2UudGFiSWQgPCAwKSlcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JyAmJiAoKG1lc3NhZ2Uua25vd25IYXNoICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICYmICh0eXBlb2YgbWVzc2FnZS5rbm93bkhhc2ggIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2Uua25vd25IYXNoLmxlbmd0aCA+IDY0KSlcbiAgICAgICAgICAgIHx8IChtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbiAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAmJiAodHlwZW9mIG1lc3NhZ2Uua25vd25Eb2N1bWVudFRva2VuICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbi5sZW5ndGggPiAxMDApKSkpXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItZXZlbnQnICYmICghTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSB8fCBtZXNzYWdlLnRhYklkIDwgMFxuICAgICAgICAgICAgfHwgdHlwZW9mIG1lc3NhZ2UuZG9jdW1lbnRUb2tlbiAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS5kb2N1bWVudFRva2VuLmxlbmd0aCA+IDEwMFxuICAgICAgICAgICAgfHwgdHlwZW9mIG1lc3NhZ2Uua2V5ICE9PSAnc3RyaW5nJyB8fCAhL15cXGR7MSw4fSQvLnRlc3QobWVzc2FnZS5rZXkpXG4gICAgICAgICAgICB8fCAhWydjbGljaycsICdpbnB1dCcsICdjaGFuZ2UnLCAnZW50ZXInXS5pbmNsdWRlcyhtZXNzYWdlLmV2ZW50KVxuICAgICAgICAgICAgfHwgKG1lc3NhZ2UuZXZlbnQgPT09ICdlbnRlcicgJiYgKHR5cGVvZiBtZXNzYWdlLmV2ZW50SWQgIT09ICdzdHJpbmcnXG4gICAgICAgICAgICAgICAgfHwgIS9eW2EtZjAtOS1dezEsNjR9JC8udGVzdChtZXNzYWdlLmV2ZW50SWQpKSkpKSkge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ2ludmFsaWQnIH0pOyByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkKS50aGVuKHZhbGlkID0+IHZhbGlkXG4gICAgICAgID8gKFsnbWVtY2hhdDpzaWRlYmFyLXZpZXcnLCAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50J10uaW5jbHVkZXMobWVzc2FnZS50eXBlKVxuICAgICAgICAgICAgPyBzaWRlYmFyVmlld0Rpc3BhdGNoKG1lc3NhZ2UsIHNlbmRlcikgOiBzaWRlYmFyRGlzcGF0Y2gobWVzc2FnZSkpXG4gICAgICAgIDogeyBvazogZmFsc2UsIHJlYXNvbjogJ2ludmFsaWQnIH0pLnRoZW4oc2VuZFJlc3BvbnNlLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ2ZhaWxlZCcgfSkpO1xuICAgIHJldHVybiB0cnVlO1xufSk7XG4iLCJjb25zdCBNRU1DSEFUX1JFUFJJQ0VfQVBJID0gJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjInO1xuY29uc3QgTUVNQ0hBVF9SRVBSSUNFX1BSSUNFX1RZUEVTID0gJy9jb250ZXh0L2NvbXBhbnlzZXR0aW5ncy9wcmljZXR5cGUnO1xuY29uc3QgTUVNQ0hBVF9SRVBSSUNFX1VVSUQgPSAvXlswLTlhLWZdezh9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezEyfSQvO1xuY29uc3QgTUVNQ0hBVF9SRVBSSUNFX0RFRkFVTFRTID0gT2JqZWN0LmZyZWV6ZSh7IG11bHRpcGxpZXI6ICcxLjA0MScsIHJvdW5kaW5nOiAndXAnLCBzdGVwOiAnMTAwJywgc3VidHJhY3Q6ICcxMCcgfSk7XG5cbmZ1bmN0aW9uIG1lbWNoYXRSZXByaWNlRm9ybXVsYShydWxlcykge1xuICAgIGNvbnN0IGRlY2ltYWwgPSAodmFsdWUsIHBsYWNlcykgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJyB8fCAhbmV3IFJlZ0V4cChgXlxcXFxkezEsOH0oPzpcXFxcLlxcXFxkezEsJHtwbGFjZXN9fSk/JGApLnRlc3QodmFsdWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBFcnJvcign0JLQstC10LTQuNGC0LUg0LTQtdGB0Y/RgtC40YfQvdGL0LUg0LfQvdCw0YfQtdC90LjRjyDQutC+0Y3RhNGE0LjRhtC40LXQvdGC0LAsINGI0LDQs9CwINC4INCy0YvRh9C40YLQsNC90LjRjy4nKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBbd2hvbGUsIGZyYWN0aW9uID0gJyddID0gdmFsdWUuc3BsaXQoJy4nKTtcbiAgICAgICAgY29uc3Qgc3VmZml4ID0gZnJhY3Rpb24ucmVwbGFjZSgvMCskLywgJycpO1xuICAgICAgICByZXR1cm4gU3RyaW5nKE51bWJlcih3aG9sZSkpICsgKHN1ZmZpeCA/ICcuJyArIHN1ZmZpeCA6ICcnKTtcbiAgICB9O1xuICAgIGNvbnN0IG11bHRpcGxpZXIgPSBkZWNpbWFsKHJ1bGVzLm11bHRpcGxpZXIsIDYpO1xuICAgIGNvbnN0IHN0ZXAgPSBkZWNpbWFsKHJ1bGVzLnN0ZXAsIDIpO1xuICAgIGNvbnN0IHN1YnRyYWN0ID0gZGVjaW1hbChydWxlcy5zdWJ0cmFjdCwgMik7XG4gICAgY29uc3Qgcm91bmRpbmcgPSBydWxlcy5yb3VuZGluZztcbiAgICBpZiAoTnVtYmVyKG11bHRpcGxpZXIpIDw9IDAgfHwgTnVtYmVyKHN0ZXApIDw9IDApIHRocm93IEVycm9yKCfQmtC+0Y3RhNGE0LjRhtC40LXQvdGCINC4INGI0LDQsyDQtNC+0LvQttC90Ysg0LHRi9GC0Ywg0LHQvtC70YzRiNC1INC90YPQu9GPLicpO1xuICAgIGlmICghWyd1cCcsICduZWFyZXN0JywgJ2Rvd24nXS5pbmNsdWRlcyhyb3VuZGluZykpIHRocm93IEVycm9yKCfQktGL0LHQtdGA0LjRgtC1INC90LDQv9GA0LDQstC70LXQvdC40LUg0L7QutGA0YPQs9C70LXQvdC40Y8uJyk7XG4gICAgcmV0dXJuIHsgbXVsdGlwbGllciwgcm91bmRpbmcsIHN0ZXAsIHN1YnRyYWN0IH07XG59XG5cbmZ1bmN0aW9uIG1lbWNoYXRSZXByaWNlUHJpY2VUeXBlcyhwYXlsb2FkKSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHBheWxvYWQpKSB0aHJvdyBFcnJvcign0KHQv9GA0LDQstC+0YfQvdC40Log0YLQuNC/0L7QsiDRhtC10L0g0L3QtdC00L7RgdGC0YPQv9C10L0uJyk7XG4gICAgY29uc3QgdHlwZXMgPSBuZXcgTWFwKCk7XG4gICAgZm9yIChjb25zdCByb3cgb2YgcGF5bG9hZCkge1xuICAgICAgICBpZiAodHlwZW9mIHJvdz8uaWQgIT09ICdzdHJpbmcnIHx8ICFNRU1DSEFUX1JFUFJJQ0VfVVVJRC50ZXN0KHJvdy5pZCkgfHwgdHlwZXMuaGFzKHJvdy5pZClcbiAgICAgICAgICAgIHx8IHR5cGVvZiByb3cubmFtZSAhPT0gJ3N0cmluZycgfHwgIXJvdy5uYW1lLnRyaW0oKSB8fCByb3cubmFtZS5sZW5ndGggPiAzMDBcbiAgICAgICAgICAgIHx8IHJvdy5tZXRhPy5ocmVmICE9PSBNRU1DSEFUX1JFUFJJQ0VfQVBJICsgTUVNQ0hBVF9SRVBSSUNFX1BSSUNFX1RZUEVTICsgJy8nICsgcm93LmlkKSB7XG4gICAgICAgICAgICB0aHJvdyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INGB0L/RgNCw0LLQvtGH0L3QuNC6INGC0LjQv9C+0LIg0YbQtdC9LicpO1xuICAgICAgICB9XG4gICAgICAgIHR5cGVzLnNldChyb3cuaWQsIHJvdy5uYW1lKTtcbiAgICB9XG4gICAgcmV0dXJuIHR5cGVzO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVNZW1jaGF0UmVwcmljZVNlcnZpY2UoY29uZmlnKSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuXG4gICAgY29uc3QgT1JERVJfSUQgPSBjb25maWcub3JkZXJJZDtcbiAgICBjb25zdCBCQVNFX1BSSUNFX1RZUEVfSUQgPSBjb25maWcuYmFzZVR5cGVJZDtcbiAgICBjb25zdCBCQVNFX1BSSUNFX1RZUEVfTkFNRSA9IGNvbmZpZy5iYXNlVHlwZU5hbWU7XG4gICAgY29uc3QgVEFSR0VUX1BSSUNFX1RZUEVfSUQgPSBjb25maWcudGFyZ2V0VHlwZUlkO1xuICAgIGNvbnN0IFRBUkdFVF9QUklDRV9UWVBFX05BTUUgPSBjb25maWcudGFyZ2V0VHlwZU5hbWU7XG4gICAgY29uc3QgUFJJQ0VfVFlQRV9DT05URVhUX1BBVEggPSBNRU1DSEFUX1JFUFJJQ0VfUFJJQ0VfVFlQRVM7XG4gICAgY29uc3QgQVBJID0gTUVNQ0hBVF9SRVBSSUNFX0FQSTtcbiAgICBjb25zdCBQT1NJVElPTlNfTElNSVQgPSAxMDAwO1xuICAgIGNvbnN0IGZvcm11bGEgPSBtZW1jaGF0UmVwcmljZUZvcm11bGEoeyAuLi5NRU1DSEFUX1JFUFJJQ0VfREVGQVVMVFMsIC4uLmNvbmZpZyB9KTtcbiAgICBjb25zdCBzY2FsZWQgPSAodmFsdWUsIHBsYWNlcykgPT4ge1xuICAgICAgICBjb25zdCBbd2hvbGUsIGZyYWN0aW9uID0gJyddID0gdmFsdWUuc3BsaXQoJy4nKTtcbiAgICAgICAgcmV0dXJuIEJpZ0ludCh3aG9sZSArIGZyYWN0aW9uLnBhZEVuZChwbGFjZXMsICcwJykpO1xuICAgIH07XG4gICAgY29uc3QgbXVsdGlwbGllciA9IHNjYWxlZChmb3JtdWxhLm11bHRpcGxpZXIsIDYpO1xuICAgIGNvbnN0IHN0ZXAgPSBzY2FsZWQoZm9ybXVsYS5zdGVwLCAyKTtcbiAgICBjb25zdCBzdWJ0cmFjdCA9IHNjYWxlZChmb3JtdWxhLnN1YnRyYWN0LCAyKTtcbiAgICBjb25zdCBkaXZpc29yID0gMTAwMDAwMG4gKiBzdGVwO1xuICAgIGNvbnN0IFVVSURfUEFUVEVSTiA9IE1FTUNIQVRfUkVQUklDRV9VVUlEO1xuICAgIGNvbnN0IENBUkRfVk9MQVRJTEUgPSBbJ21ldGEnLCAnY29udGV4dCcsICd1cGRhdGVkJywgJ3NhbGVQcmljZXMnXTtcbiAgICBjb25zdCBET0NVTUVOVF9WT0xBVElMRSA9IFsnbWV0YScsICdjb250ZXh0JywgJ3Bvc2l0aW9ucycsICd1cGRhdGVkJ107XG5cbiAgICBmdW5jdGlvbiBmYWlsdXJlKGNvZGUsIG1lc3NhZ2UpIHtcbiAgICAgICAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgIGVycm9yLmNvZGUgPSBjb2RlO1xuICAgICAgICByZXR1cm4gZXJyb3I7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaW52YWxpZChjb2RlLCBtZXNzYWdlKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gZmFpbHVyZShjb2RlLCBtZXNzYWdlKTtcbiAgICAgICAgZXJyb3IudmFsaWRhdGlvbiA9IHRydWU7XG4gICAgICAgIHJldHVybiBlcnJvcjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBpbnRlZ2VyKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSByZXR1cm4gTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUpID8gdmFsdWUgOiBudWxsO1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnYmlnaW50Jykge1xuICAgICAgICAgICAgY29uc3QgY29udmVydGVkID0gTnVtYmVyKHZhbHVlKTtcbiAgICAgICAgICAgIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcihjb252ZXJ0ZWQpID8gY29udmVydGVkIDogbnVsbDtcbiAgICAgICAgfVxuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiAvXi0/XFxkKyQvLnRlc3QodmFsdWUudHJpbSgpKSkge1xuICAgICAgICAgICAgY29uc3QgY29udmVydGVkID0gTnVtYmVyKHZhbHVlLnRyaW0oKSk7XG4gICAgICAgICAgICByZXR1cm4gTnVtYmVyLmlzU2FmZUludGVnZXIoY29udmVydGVkKSA/IGNvbnZlcnRlZCA6IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2FsY3VsYXRlKGJhc2VLb3BlY2tzKSB7XG4gICAgICAgIGNvbnN0IGJhc2UgPSBpbnRlZ2VyKGJhc2VLb3BlY2tzKTtcbiAgICAgICAgaWYgKGJhc2UgPT09IG51bGwgfHwgYmFzZSA8PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpbnZhbGlkLWJhc2UnLCAn0JHQsNC30L7QstCw0Y8g0YbQtdC90LAg0LTQvtC70LbQvdCwINCx0YvRgtGMINC/0L7Qu9C+0LbQuNGC0LXQu9GM0L3Ri9C8INGG0LXQu9GL0Lwg0YfQuNGB0LvQvtC8INC60L7Qv9C10LXQuicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG9mZnNldCA9IGZvcm11bGEucm91bmRpbmcgPT09ICd1cCcgPyBkaXZpc29yIC0gMW4gOiBmb3JtdWxhLnJvdW5kaW5nID09PSAnbmVhcmVzdCcgPyBkaXZpc29yIC8gMm4gOiAwbjtcbiAgICAgICAgY29uc3Qgcm91bmRlZCA9IChCaWdJbnQoYmFzZSkgKiBtdWx0aXBsaWVyICsgb2Zmc2V0KSAvIGRpdmlzb3I7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHJvdW5kZWQgKiBzdGVwIC0gc3VidHJhY3Q7XG4gICAgICAgIGlmIChyZXN1bHQgPD0gMG4gfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKE51bWJlcihyZXN1bHQpKSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnb3V0LW9mLXJhbmdlJywgJ9Cg0LDRgdGB0YfQuNGC0LDQvdC90LDRjyDRhtC10L3QsCDQtNC+0LvQttC90LAg0LHRi9GC0Ywg0L/QvtC70L7QttC40YLQtdC70YzQvdC+0Lkg0Lgg0LIg0LHQtdC30L7Qv9Cw0YHQvdC+0Lwg0LTQuNCw0L/QsNC30L7QvdC1Jyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIE51bWJlcihyZXN1bHQpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNhbm9uaWNhbCh2YWx1ZSkge1xuICAgICAgICBpZiAodmFsdWUgPT09IHZvaWQgMCkgcmV0dXJuICdudWxsJztcbiAgICAgICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuICdbJyArIHZhbHVlLm1hcChjYW5vbmljYWwpLmpvaW4oJywnKSArICddJztcbiAgICAgICAgcmV0dXJuICd7JyArIE9iamVjdC5rZXlzKHZhbHVlKS5zb3J0KClcbiAgICAgICAgICAgIC5tYXAoa2V5ID0+IEpTT04uc3RyaW5naWZ5KGtleSkgKyAnOicgKyBjYW5vbmljYWwodmFsdWVba2V5XSkpLmpvaW4oJywnKSArICd9JztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjb3B5KHZhbHVlKSB7XG4gICAgICAgIHJldHVybiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbGFzdFNlZ21lbnQoaHJlZikge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IFN0cmluZyhocmVmKS5zcGxpdCgnPycpWzBdLnNwbGl0KCcvJyk7XG4gICAgICAgIHJldHVybiBwYXJ0c1twYXJ0cy5sZW5ndGggLSAxXTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWFkUGF0aChwYXRoKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcGF0aCAhPT0gJ3N0cmluZycgfHwgcGF0aC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2ludmFsaWQtcmVhZC1wYXRoJywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQsNC00YDQtdGBINGH0YLQtdC90LjRjyDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHBhdGggPT09IFBSSUNFX1RZUEVfQ09OVEVYVF9QQVRIKSByZXR1cm4gcGF0aDtcbiAgICAgICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoJy9lbnRpdHkvJykgfHwgcGF0aC5pbmRleE9mKCcvLycpICE9PSAtMSkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaW52YWxpZC1yZWFkLXBhdGgnLCAn0KfRgtC10L3QuNC1INGA0LDQt9GA0LXRiNC10L3QviDRgtC+0LvRjNC60L4g0LIgL2VudGl0eScpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBwYXRoO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHJlYWRKc29uKHJlYWQsIHBhdGgpIHtcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlYWQocmVhZFBhdGgocGF0aCkpO1xuICAgICAgICBpZiAoZGF0YSAmJiBBcnJheS5pc0FycmF5KGRhdGEuZXJyb3JzKSAmJiBkYXRhLmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2FwaS1yZXNwb25zZScsICfQntGC0LLQtdGCINCc0L7QudCh0LrQu9Cw0LQg0YHQvtC00LXRgNC20LjRgiDQvtGI0LjQsdC60LgnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZGF0YTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBsaW5rQmFzZShocmVmLCBtYXJrZXIpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBocmVmICE9PSAnc3RyaW5nJyB8fCAhaHJlZikge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaWRlbnRpdHknLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvtC/0YDQtdC00LXQu9C40YLRjCDQsNC00YDQtdGBIEFQSSDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY2xlYW4gPSBocmVmLnNwbGl0KCc/JylbMF07XG4gICAgICAgIGlmIChjbGVhbiAhPT0gQVBJICsgbWFya2VyKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpZGVudGl0eScsICfQodGB0YvQu9C60LAg0LLQvdC1INGB0L7Qs9C70LDRgdC+0LLQsNC90L3QvtCz0L4g0LDQtNGA0LXRgdCwINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gQVBJO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG9yZGVyQmFzZShvcmRlcikge1xuICAgICAgICByZXR1cm4gbGlua0Jhc2Uob3JkZXIgJiYgb3JkZXIubWV0YSAmJiBvcmRlci5tZXRhLmhyZWYsXG4gICAgICAgICAgICAnL2VudGl0eS9pbnRlcm5hbG9yZGVyLycgKyBPUkRFUl9JRCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2FyZEJhc2UoY2FyZCwgaWQpIHtcbiAgICAgICAgcmV0dXJuIGxpbmtCYXNlKGNhcmQgJiYgY2FyZC5tZXRhICYmIGNhcmQubWV0YS5ocmVmLCAnL2VudGl0eS9wcm9kdWN0LycgKyBpZCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVsYXRpdmUoaHJlZiwgYmFzZSkge1xuICAgICAgICBpZiAodHlwZW9mIGhyZWYgIT09ICdzdHJpbmcnIHx8ICFocmVmKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdzY29wZScsICfQndC10LrQvtGA0YDQtdC60YLQvdCw0Y8g0YHRgdGL0LvQutCwINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaHJlZi5jaGFyQXQoMCkgPT09ICcvJykge1xuICAgICAgICAgICAgaWYgKCFocmVmLnN0YXJ0c1dpdGgoJy9lbnRpdHkvJykgfHwgaHJlZi5pbmRleE9mKCcvLycpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3Njb3BlJywgJ9Ch0YHRi9C70LrQsCDQstC90LUg0YHQvtCz0LvQsNGB0L7QstCw0L3QvdC+0LPQviBBUEkg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGhyZWY7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFocmVmLnN0YXJ0c1dpdGgoYmFzZSArICcvZW50aXR5LycpKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdzY29wZScsICfQodGB0YvQu9C60LAg0LLQvdC1INGB0L7Qs9C70LDRgdC+0LLQsNC90L3QvtCz0L4gQVBJINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaHJlZi5zbGljZShiYXNlLmxlbmd0aCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcHJvZHVjdFJlZihocmVmLCBiYXNlKSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShocmVmLCBiYXNlKTtcbiAgICAgICAgY29uc3Qgc2VnbWVudHMgPSBwYXRoLnNwbGl0KCc/JylbMF0uc3BsaXQoJy8nKTtcbiAgICAgICAgaWYgKHNlZ21lbnRzLmxlbmd0aCAhPT0gNCB8fCBzZWdtZW50c1sxXSAhPT0gJ2VudGl0eScgfHwgc2VnbWVudHNbMl0gIT09ICdwcm9kdWN0J1xuICAgICAgICAgICAgfHwgIVVVSURfUEFUVEVSTi50ZXN0KHNlZ21lbnRzWzNdKSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJvZHVjdC1yZWYnLCAn0J3QtdC60L7RgNGA0LXQutGC0L3QsNGPINGB0YHRi9C70LrQsCBwcm9kdWN0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgaWQ6IHNlZ21lbnRzWzNdLCBwYXRoIH07XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcHJpY2VUeXBlSWQocHJpY2UpIHtcbiAgICAgICAgY29uc3QgcHJpY2VUeXBlID0gcHJpY2UgJiYgcHJpY2UucHJpY2VUeXBlO1xuICAgICAgICBpZiAoIXByaWNlVHlwZSkgcmV0dXJuICcnO1xuICAgICAgICBpZiAodHlwZW9mIHByaWNlVHlwZS5pZCA9PT0gJ3N0cmluZycgJiYgcHJpY2VUeXBlLmlkKSByZXR1cm4gcHJpY2VUeXBlLmlkO1xuICAgICAgICByZXR1cm4gcHJpY2VUeXBlLm1ldGEgJiYgdHlwZW9mIHByaWNlVHlwZS5tZXRhLmhyZWYgPT09ICdzdHJpbmcnXG4gICAgICAgICAgICA/IGxhc3RTZWdtZW50KHByaWNlVHlwZS5tZXRhLmhyZWYpIDogJyc7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc2VsZWN0UHJpY2UoY2FyZCwgaWQsIG5hbWUpIHtcbiAgICAgICAgaWYgKCFjYXJkIHx8ICFBcnJheS5pc0FycmF5KGNhcmQuc2FsZVByaWNlcykpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3ByaWNlcycsICfQkiDQutCw0YDRgtC+0YfQutC1INC90LXRgiDRgtC40L/QvtCyINGG0LXQvScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG1hdGNoZXMgPSBjYXJkLnNhbGVQcmljZXMuZmlsdGVyKHByaWNlID0+IHByaWNlVHlwZUlkKHByaWNlKSA9PT0gaWQpO1xuICAgICAgICBpZiAobWF0Y2hlcy5sZW5ndGggIT09IDEgfHwgKG5hbWUgIT09IHVuZGVmaW5lZCAmJiBtYXRjaGVzWzBdLnByaWNlVHlwZT8ubmFtZSAhPT0gbmFtZSlcbiAgICAgICAgICAgIHx8IG1hdGNoZXNbMF0ucHJpY2VUeXBlPy5tZXRhPy5ocmVmICE9PSBBUEkgKyBQUklDRV9UWVBFX0NPTlRFWFRfUEFUSCArICcvJyArIGlkKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcmljZXMnLCAn0J7RgtGB0YPRgtGB0YLQstGD0LXRgiDQuNC70Lgg0L/QtdGA0LXQuNC80LXQvdC+0LLQsNC9INGC0LjQvyDRhtC10L3RiyAnICsgbmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcHJpY2UgPSBtYXRjaGVzWzBdO1xuICAgICAgICBpZiAoIXByaWNlLmN1cnJlbmN5IHx8ICFwcmljZS5jdXJyZW5jeS5tZXRhXG4gICAgICAgICAgICB8fCB0eXBlb2YgcHJpY2UuY3VycmVuY3kubWV0YS5ocmVmICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnY3VycmVuY3knLCAn0KMg0YLQuNC/0LAg0YbQtdC90Ysg0L3QtdGCINCy0LDQu9GO0YLRiycpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBwcmljZTtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiByZXF1aXJlUnVibGUocmVhZCwgcHJpY2UsIGJhc2UsIGNhY2hlKSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShwcmljZS5jdXJyZW5jeS5tZXRhLmhyZWYsIGJhc2UpO1xuICAgICAgICBjb25zdCBzZWdtZW50cyA9IHBhdGguc3BsaXQoJz8nKVswXS5zcGxpdCgnLycpO1xuICAgICAgICBpZiAoc2VnbWVudHMubGVuZ3RoICE9PSA0IHx8IHNlZ21lbnRzWzJdICE9PSAnY3VycmVuY3knXG4gICAgICAgICAgICB8fCAhVVVJRF9QQVRURVJOLnRlc3Qoc2VnbWVudHNbM10pKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdjdXJyZW5jeScsICfQndC10LrQvtGA0YDQtdC60YLQvdCw0Y8g0YHRgdGL0LvQutCwINCy0LDQu9GO0YLRiycpO1xuICAgICAgICB9XG4gICAgICAgIGxldCBpc28gPSBjYWNoZS5nZXQocGF0aCk7XG4gICAgICAgIGlmIChpc28gPT09IHZvaWQgMCkge1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlYWRKc29uKHJlYWQsIHBhdGgpO1xuICAgICAgICAgICAgaXNvID0gZGF0YSAmJiBkYXRhLmlzb0NvZGU7XG4gICAgICAgICAgICBjYWNoZS5zZXQocGF0aCwgaXNvKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaXNvICE9PSAnUlVCJykgdGhyb3cgaW52YWxpZCgnY3VycmVuY3knLCAn0JLQsNC70Y7RgtCwINGG0LXQvdGLINC90LUgUlVCJyk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gb3RoZXJQcmljZXMoY2FyZCkge1xuICAgICAgICBjb25zdCBwcmljZXMgPSBjYXJkICYmIEFycmF5LmlzQXJyYXkoY2FyZC5zYWxlUHJpY2VzKSA/IGNhcmQuc2FsZVByaWNlcyA6IFtdO1xuICAgICAgICByZXR1cm4gcHJpY2VzXG4gICAgICAgICAgICAuZmlsdGVyKHByaWNlID0+IHByaWNlVHlwZUlkKHByaWNlKSAhPT0gVEFSR0VUX1BSSUNFX1RZUEVfSUQpXG4gICAgICAgICAgICAubWFwKHByaWNlID0+ICh7XG4gICAgICAgICAgICAgICAgaWQ6IHByaWNlVHlwZUlkKHByaWNlKSxcbiAgICAgICAgICAgICAgICB2YWx1ZTogTnVtYmVyKHByaWNlLnZhbHVlKSxcbiAgICAgICAgICAgICAgICBjdXJyZW5jeTogcHJpY2UuY3VycmVuY3kgJiYgcHJpY2UuY3VycmVuY3kubWV0YVxuICAgICAgICAgICAgICAgICAgICA/IFN0cmluZyhwcmljZS5jdXJyZW5jeS5tZXRhLmhyZWYpIDogJydcbiAgICAgICAgICAgIH0pKVxuICAgICAgICAgICAgLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiAobGVmdC5pZCA8IHJpZ2h0LmlkID8gLTEgOiBsZWZ0LmlkID4gcmlnaHQuaWQgPyAxIDogMCkpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGJ1c2luZXNzRmllbGRzKGNhcmQpIHtcbiAgICAgICAgY29uc3QgZmllbGRzID0ge307XG4gICAgICAgIE9iamVjdC5rZXlzKGNhcmQgfHwge30pLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgIGlmIChDQVJEX1ZPTEFUSUxFLmluZGV4T2Yoa2V5KSA9PT0gLTEpIGZpZWxkc1trZXldID0gY2FyZFtrZXldO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGZpZWxkcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkb2N1bWVudFNpZ25hdHVyZShvcmRlciwgcG9zaXRpb25zKSB7XG4gICAgICAgIGNvbnN0IGhlYWRlciA9IHt9O1xuICAgICAgICBPYmplY3Qua2V5cyhvcmRlciB8fCB7fSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgICAgaWYgKERPQ1VNRU5UX1ZPTEFUSUxFLmluZGV4T2Yoa2V5KSA9PT0gLTEpIGhlYWRlcltrZXldID0gb3JkZXJba2V5XTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHJvd3MgPSBwb3NpdGlvbnMubWFwKHBvc2l0aW9uID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJvdyA9IHt9O1xuICAgICAgICAgICAgT2JqZWN0LmtleXMocG9zaXRpb24gfHwge30pLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ICE9PSAnbWV0YScgJiYga2V5ICE9PSAnYXNzb3J0bWVudCcpIHJvd1trZXldID0gcG9zaXRpb25ba2V5XTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcm93LmFzc29ydG1lbnQgPSBwb3NpdGlvbiAmJiBwb3NpdGlvbi5hc3NvcnRtZW50ICYmIHBvc2l0aW9uLmFzc29ydG1lbnQubWV0YVxuICAgICAgICAgICAgICAgID8gcG9zaXRpb24uYXNzb3J0bWVudC5tZXRhLmhyZWYgOiBudWxsO1xuICAgICAgICAgICAgcmV0dXJuIHJvdztcbiAgICAgICAgfSkuc29ydCgobGVmdCwgcmlnaHQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGEgPSBTdHJpbmcobGVmdC5pZCA9PT0gdm9pZCAwID8gJycgOiBsZWZ0LmlkKTtcbiAgICAgICAgICAgIGNvbnN0IGIgPSBTdHJpbmcocmlnaHQuaWQgPT09IHZvaWQgMCA/ICcnIDogcmlnaHQuaWQpO1xuICAgICAgICAgICAgcmV0dXJuIGEgPCBiID8gLTEgOiBhID4gYiA/IDEgOiAwO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGNhbm9uaWNhbCh7IGhlYWRlciwgcG9zaXRpb25zOiByb3dzIH0pO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RQYWdlcyhyZWFkLCBmaXJzdCwgYmFzZSwgZW5kcG9pbnQpIHtcbiAgICAgICAgY29uc3Qgcm93cyA9IFtdO1xuICAgICAgICBjb25zdCB2aXNpdGVkID0gbmV3IFNldCgpO1xuICAgICAgICBsZXQgZXhwZWN0ZWRTaXplO1xuICAgICAgICBsZXQgbmV4dCA9IGZpcnN0O1xuICAgICAgICB3aGlsZSAobmV4dCkge1xuICAgICAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKG5leHQsIGJhc2UpO1xuICAgICAgICAgICAgaWYgKHBhdGguc3BsaXQoJz8nKVswXSAhPT0gZW5kcG9pbnQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90LDRjyDQv9Cw0LPQuNC90LDRhtC40Y8g0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZpc2l0ZWQuaGFzKHBhdGgpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQn9C+0LLRgtC+0YDQvdCw0Y8g0YHRgtGA0LDQvdC40YbQsCDQv9Cw0LPQuNC90LDRhtC40Lgg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmlzaXRlZC5hZGQocGF0aCk7XG4gICAgICAgICAgICBjb25zdCBwYWdlID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgcGF0aCk7XG4gICAgICAgICAgICBpZiAoIXBhZ2UgfHwgIUFycmF5LmlzQXJyYXkocGFnZS5yb3dzKSB8fCAhcGFnZS5tZXRhKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC10L/QvtC70L3QsNGPINGB0YLRgNCw0L3QuNGG0LAg0L/QsNCz0LjQvdCw0YbQuNC4INCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNpemUgPSBpbnRlZ2VyKHBhZ2UubWV0YS5zaXplKTtcbiAgICAgICAgICAgIGlmIChzaXplID09PSBudWxsIHx8IHNpemUgPCAwKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC1INGD0LrQsNC30LDQvSDRgNCw0LfQvNC10YAg0LLRi9Cx0L7RgNC60Lgg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHBhZ2UubWV0YS5vZmZzZXQgIT09IHZvaWQgMCAmJiBpbnRlZ2VyKHBhZ2UubWV0YS5vZmZzZXQpICE9PSByb3dzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtdCy0LXRgNC90L7QtSDRgdC80LXRidC10L3QuNC1INC/0LDQs9C40L3QsNGG0LjQuCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRTaXplICE9PSB2b2lkIDAgJiYgc2l6ZSAhPT0gZXhwZWN0ZWRTaXplKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQoNCw0LfQvNC10YAg0LLRi9Cx0L7RgNC60Lgg0LjQt9C80LXQvdC40LvRgdGPINCy0L4g0LLRgNC10LzRjyDRh9GC0LXQvdC40Y8g0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZXhwZWN0ZWRTaXplID0gc2l6ZTtcbiAgICAgICAgICAgIHJvd3MucHVzaC5hcHBseShyb3dzLCBwYWdlLnJvd3MpO1xuICAgICAgICAgICAgaWYgKHJvd3MubGVuZ3RoID4gc2l6ZSkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0JvQuNGI0L3QuNC1INGB0YLRgNC+0LrQuCDQsiDQstGL0LHQvtGA0LrQtSDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocGFnZS5tZXRhLm5leHRIcmVmKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBwYWdlLm1ldGEubmV4dEhyZWYgIT09ICdzdHJpbmcnIHx8ICFwYWdlLnJvd3MubGVuZ3RoIHx8IHJvd3MubGVuZ3RoID49IHNpemUpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC10LrQvtGA0YDQtdC60YLQvdC+0LUg0L/RgNC+0LTQvtC70LbQtdC90LjQtSDQv9Cw0LPQuNC90LDRhtC40Lgg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBuZXh0ID0gcGFnZS5tZXRhLm5leHRIcmVmO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAocm93cy5sZW5ndGggIT09IHNpemUpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC10L/QvtC70L3QsNGPINCy0YvQsdC+0YDQutCwINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbmV4dCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV4cGVjdGVkU2l6ZSA9PT0gdm9pZCAwKSB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LXQv9C+0LvQvdCw0Y8g0LLRi9Cx0L7RgNC60LAg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjaGVja1ByaWNlVHlwZXMocGF5bG9hZCkge1xuICAgICAgICBjb25zdCB0eXBlcyA9IG1lbWNoYXRSZXByaWNlUHJpY2VUeXBlcyhwYXlsb2FkKTtcbiAgICAgICAgaWYgKEJBU0VfUFJJQ0VfVFlQRV9JRCA9PT0gVEFSR0VUX1BSSUNFX1RZUEVfSUQgfHwgIXR5cGVzLmhhcyhCQVNFX1BSSUNFX1RZUEVfSUQpIHx8ICF0eXBlcy5oYXMoVEFSR0VUX1BSSUNFX1RZUEVfSUQpXG4gICAgICAgICAgICB8fCB0eXBlcy5nZXQoQkFTRV9QUklDRV9UWVBFX0lEKSAhPT0gQkFTRV9QUklDRV9UWVBFX05BTUUgfHwgdHlwZXMuZ2V0KFRBUkdFVF9QUklDRV9UWVBFX0lEKSAhPT0gVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncHJpY2V0eXBlLWNvbnRleHQnLCAn0KLQuNC/INGG0LXQvdGLINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINC90LDRgdGC0YDQvtC50LrQvtC5LiDQntCx0L3QvtCy0LjRgtC1INC/0YDQsNCy0LjQu9CwINC/0LXRgNC10L7RhtC10L3QutC4LicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gbWFrZVBsYW4ocmVhZCkge1xuICAgICAgICBpZiAodHlwZW9mIHJlYWQgIT09ICdmdW5jdGlvbicpIHRocm93IG5ldyBUeXBlRXJyb3IoJ3BsYW4gcmVxdWlyZXMgYSByZWFkIGZ1bmN0aW9uJyk7XG4gICAgICAgIGlmICh0eXBlb2YgT1JERVJfSUQgIT09ICdzdHJpbmcnIHx8ICFVVUlEX1BBVFRFUk4udGVzdChPUkRFUl9JRCkpIHRocm93IGZhaWx1cmUoJ2lkZW50aXR5JywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQstC90YPRgtGA0LXQvdC90LjQuSDQt9Cw0LrQsNC3Jyk7XG4gICAgICAgIGNoZWNrUHJpY2VUeXBlcyhhd2FpdCByZWFkSnNvbihyZWFkLCBQUklDRV9UWVBFX0NPTlRFWFRfUEFUSCkpO1xuXG4gICAgICAgIGNvbnN0IG9yZGVyID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgJy9lbnRpdHkvaW50ZXJuYWxvcmRlci8nICsgT1JERVJfSUQpO1xuICAgICAgICBjb25zdCBiYXNlID0gb3JkZXJCYXNlKG9yZGVyKTtcbiAgICAgICAgaWYgKCFvcmRlciB8fCBvcmRlci5pZCAhPT0gT1JERVJfSUQgfHwgdHlwZW9mIG9yZGVyLm5hbWUgIT09ICdzdHJpbmcnIHx8ICFvcmRlci5uYW1lLnRyaW0oKSkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaWRlbnRpdHknLCAn0JLQvdGD0YLRgNC10L3QvdC40Lkg0LfQsNC60LDQtyDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgdC+INGB0YHRi9C70LrQvtC5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZW5kcG9pbnQgPSAnL2VudGl0eS9pbnRlcm5hbG9yZGVyLycgKyBPUkRFUl9JRCArICcvcG9zaXRpb25zJztcbiAgICAgICAgY29uc3QgcG9zaXRpb25zID0gYXdhaXQgY29sbGVjdFBhZ2VzKHJlYWQsXG4gICAgICAgICAgICBlbmRwb2ludCArICc/ZXhwYW5kPWFzc29ydG1lbnQmbGltaXQ9JyArIFBPU0lUSU9OU19MSU1JVCwgYmFzZSwgZW5kcG9pbnQpO1xuXG4gICAgICAgIGNvbnN0IGVudHJpZXMgPSBbXTtcbiAgICAgICAgY29uc3Qgc2tpcHBlZCA9IFtdO1xuICAgICAgICBjb25zdCBzZWVuID0gbmV3IFNldCgpO1xuICAgICAgICBjb25zdCBjYWNoZSA9IG5ldyBNYXAoKTtcblxuICAgICAgICBmb3IgKGNvbnN0IHBvc2l0aW9uIG9mIHBvc2l0aW9ucykge1xuICAgICAgICAgICAgY29uc3QgYXNzb3J0bWVudCA9IHBvc2l0aW9uICYmIHBvc2l0aW9uLmFzc29ydG1lbnQ7XG4gICAgICAgICAgICBjb25zdCBocmVmID0gYXNzb3J0bWVudCAmJiBhc3NvcnRtZW50Lm1ldGEgJiYgYXNzb3J0bWVudC5tZXRhLmhyZWY7XG4gICAgICAgICAgICBjb25zdCB0eXBlID0gYXNzb3J0bWVudCAmJiBhc3NvcnRtZW50Lm1ldGEgJiYgYXNzb3J0bWVudC5tZXRhLnR5cGU7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IGFzc29ydG1lbnQgJiYgdHlwZW9mIGFzc29ydG1lbnQubmFtZSA9PT0gJ3N0cmluZycgJiYgYXNzb3J0bWVudC5uYW1lXG4gICAgICAgICAgICAgICAgPyBhc3NvcnRtZW50Lm5hbWUgOiAodHlwZW9mIGhyZWYgPT09ICdzdHJpbmcnID8gaHJlZiA6ICfQv9C+0LfQuNGG0LjRjycpO1xuICAgICAgICAgICAgaWYgKHR5cGUgIT09ICdwcm9kdWN0JyB8fCB0eXBlb2YgaHJlZiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBza2lwcGVkLnB1c2goeyBuYW1lOiBsYWJlbCwgcmVhc29uOiAn0L/QvtC00LTQtdGA0LbQuNCy0LDRjtGC0YHRjyDRgtC+0LvRjNC60L4g0LrQsNGA0YLQvtGH0LrQuCBwcm9kdWN0JyB9KTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCBwcm9kdWN0O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBwcm9kdWN0ID0gcHJvZHVjdFJlZihocmVmLCBiYXNlKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnZhbGlkYXRpb24gPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc2tpcHBlZC5wdXNoKHsgbmFtZTogbGFiZWwsIHJlYXNvbjogZXJyb3IubWVzc2FnZSB9KTtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHNlZW4uaGFzKHByb2R1Y3QuaWQpKSBjb250aW51ZTtcbiAgICAgICAgICAgIHNlZW4uYWRkKHByb2R1Y3QuaWQpO1xuXG4gICAgICAgICAgICBjb25zdCBjYXJkID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgcHJvZHVjdC5wYXRoKTtcbiAgICAgICAgICAgIGlmICghY2FyZCB8fCBjYXJkLmlkICE9PSBwcm9kdWN0LmlkIHx8IHR5cGVvZiBjYXJkLm5hbWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaWRlbnRpdHknLCAn0JrQsNGA0YLQvtGH0LrQsCDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDQv9C+0LfQuNGG0LjQtdC5INC30LDQutCw0LfQsCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBiYXNlUHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBCQVNFX1BSSUNFX1RZUEVfSUQsIEJBU0VfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgICAgICAgICBjb25zdCB0YXJnZXRQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIFRBUkdFVF9QUklDRV9UWVBFX0lELCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgYmFzZVByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIHRhcmdldFByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYmFzZUtvcGVja3MgPSBpbnRlZ2VyKGJhc2VQcmljZS52YWx1ZSk7XG4gICAgICAgICAgICAgICAgaWYgKGJhc2VLb3BlY2tzID09PSBudWxsIHx8IGJhc2VLb3BlY2tzIDw9IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnYmFzZScsICfQkdCw0LfQvtCy0LDRjyDRhtC10L3QsCDQtNC+0LvQttC90LAg0LHRi9GC0Ywg0L/QvtC70L7QttC40YLQtdC70YzQvdC+0Lkg0Lgg0YbQtdC70L7QuScpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBvbGQgPSBpbnRlZ2VyKHRhcmdldFByaWNlLnZhbHVlKTtcbiAgICAgICAgICAgICAgICBpZiAob2xkID09PSBudWxsKSB0aHJvdyBpbnZhbGlkKCd0YXJnZXQnLCAn0KbQtdC90L3QuNC6INC00L7Qu9C20LXQvSDQsdGL0YLRjCDRhtC10LvRi9C8INGH0LjRgdC70L7QvCDQutC+0L/QtdC10LonKTtcbiAgICAgICAgICAgICAgICBpZiAob2xkIDwgMCkgdGhyb3cgaW52YWxpZCgndGFyZ2V0JywgJ9Ce0YLRgNC40YbQsNGC0LXQu9GM0L3Ri9C5INGC0LXQutGD0YnQuNC5INGG0LXQvdC90LjQuicpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBOdW1iZXIoY2FsY3VsYXRlKGJhc2VLb3BlY2tzKSk7XG4gICAgICAgICAgICAgICAgZW50cmllcy5wdXNoKHsgaWQ6IHByb2R1Y3QuaWQsIG5hbWU6IGNhcmQubmFtZSwgYmFzZTogYmFzZUtvcGVja3MsIG9sZCwgbmV3OiBuZXh0IH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IudmFsaWRhdGlvbiA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgICAgICBza2lwcGVkLnB1c2goeyBuYW1lOiBsYWJlbCwgcmVhc29uOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgb3JkZXJOYW1lOiBvcmRlci5uYW1lLCBzaWduYXR1cmU6IGRvY3VtZW50U2lnbmF0dXJlKG9yZGVyLCBwb3NpdGlvbnMpLCBlbnRyaWVzLCBza2lwcGVkIH07XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gcGxhbihyZWFkKSB7XG4gICAgICAgIHJldHVybiBtYWtlUGxhbihyZWFkKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaWZmZXJlbmNlcyhlbnRyaWVzKSB7XG4gICAgICAgIGNvbnN0IGNoYW5nZWQgPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICAgICAgICBpZiAoZW50cnkgJiYgZW50cnkubmV3ICE9PSBlbnRyeS5vbGQpIHtcbiAgICAgICAgICAgICAgICBjaGFuZ2VkW2VudHJ5LmlkXSA9IHsgYmFzZTogZW50cnkuYmFzZSwgb2xkOiBlbnRyeS5vbGQsIG5ldzogZW50cnkubmV3IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNoYW5nZWQ7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbWV0YUNvcHkobWV0YSkge1xuICAgICAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcmljZXMnLCAn0J3QtdGCINC80LXRgtCw0LTQsNC90L3Ri9GFINGC0LjQv9CwINGG0LXQvdGLJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdWx0ID0ge307XG4gICAgICAgIE9iamVjdC5rZXlzKG1ldGEpLmZvckVhY2goa2V5ID0+IHsgcmVzdWx0W2tleV0gPSBtZXRhW2tleV07IH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHBheWxvYWRGb3IoZW50cnksIHRhcmdldFByaWNlKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzYWxlUHJpY2VzOiBbe1xuICAgICAgICAgICAgICAgIHZhbHVlOiBlbnRyeS5uZXcsXG4gICAgICAgICAgICAgICAgcHJpY2VUeXBlOiB7IG1ldGE6IG1ldGFDb3B5KHRhcmdldFByaWNlLnByaWNlVHlwZS5tZXRhKSB9LFxuICAgICAgICAgICAgICAgIGN1cnJlbmN5OiB7IG1ldGE6IG1ldGFDb3B5KHRhcmdldFByaWNlLmN1cnJlbmN5Lm1ldGEpIH1cbiAgICAgICAgICAgIH1dXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdmVyaWZ5V3JpdGFibGUoY2FyZCwgZW50cnksIGJlZm9yZSkge1xuICAgICAgICBpZiAoIWNhcmQgfHwgY2FyZC5pZCAhPT0gZW50cnkuaWQgfHwgY2FyZC5uYW1lICE9PSBlbnRyeS5uYW1lKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdpZGVudGl0eScsICfQmtCw0YDRgtC+0YfQutCwINC40LfQvNC10L3QuNC70LDRgdGMINCy0L4g0LLRgNC10LzRjyDQv9C10YDQtdC+0YbQtdC90LrQuCcpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGJhc2VQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIEJBU0VfUFJJQ0VfVFlQRV9JRCwgQkFTRV9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICBjb25zdCB0YXJnZXRQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIFRBUkdFVF9QUklDRV9UWVBFX0lELCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgaWYgKGludGVnZXIoYmFzZVByaWNlLnZhbHVlKSAhPT0gZW50cnkuYmFzZSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnYmFzZScsICfQkdCw0LfQvtCy0LDRjyDRhtC10L3QsCDQuNC30LzQtdC90LjQu9Cw0YHRjCDQstC+INCy0YDQtdC80Y8g0L/QtdGA0LXQvtGG0LXQvdC60LgnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW50ZWdlcih0YXJnZXRQcmljZS52YWx1ZSkgIT09IGVudHJ5Lm5ldykge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgndGFyZ2V0JywgJ9Cm0LXQvdC90LjQuiDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0g0L7QsdGA0LDRgtC90YvQvCDRh9GC0LXQvdC40LXQvCcpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0YXJnZXRQcmljZS5jdXJyZW5jeS5tZXRhLmhyZWYgIT09IHNlbGVjdFByaWNlKGJlZm9yZSwgVEFSR0VUX1BSSUNFX1RZUEVfSUQsIFRBUkdFVF9QUklDRV9UWVBFX05BTUUpLmN1cnJlbmN5Lm1ldGEuaHJlZikge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnY3VycmVuY3knLCAn0JjQt9C80LXQvdC40LvQsNGB0Ywg0LLQsNC70Y7RgtCwINGG0LXQu9C10LLQvtC5INGG0LXQvdGLJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNhbm9uaWNhbChvdGhlclByaWNlcyhjYXJkKSkgIT09IGNhbm9uaWNhbChvdGhlclByaWNlcyhiZWZvcmUpKSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJpY2VzJywgJ9CY0LfQvNC10L3QuNC70YHRjyDQtNGA0YPQs9C+0Lkg0YLQuNC/INGG0LXQvdGLJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNhbm9uaWNhbChidXNpbmVzc0ZpZWxkcyhjYXJkKSkgIT09IGNhbm9uaWNhbChidXNpbmVzc0ZpZWxkcyhiZWZvcmUpKSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnZmllbGRzJywgJ9CY0LfQvNC10L3QuNC70LjRgdGMINC00YDRg9Cz0LjQtSDQv9C+0LvRjyDQutCw0YDRgtC+0YfQutC4Jyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiB2ZXJpZnlTdGFibGUoY2FyZCwgZW50cnksIGV4cGVjdGVkLCByZWFkLCBiYXNlLCBjYWNoZSkge1xuICAgICAgICBpZiAoIWNhcmQgfHwgY2FyZC5pZCAhPT0gZW50cnkuaWQgfHwgY2FyZC5uYW1lICE9PSBlbnRyeS5uYW1lKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdpZGVudGl0eScsICfQmNGC0L7Qs9C+0LLQsNGPINC60LDRgNGC0L7Rh9C60LAg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0L/Qu9Cw0L3QvtC8Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmFzZVByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgQkFTRV9QUklDRV9UWVBFX0lELCBCQVNFX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgIGNvbnN0IHRhcmdldFByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgVEFSR0VUX1BSSUNFX1RZUEVfSUQsIFRBUkdFVF9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgYmFzZVByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCB0YXJnZXRQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICBpZiAoaW50ZWdlcihiYXNlUHJpY2UudmFsdWUpICE9PSBlbnRyeS5iYXNlKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdiYXNlJywgJ9CY0YLQvtCz0L7QstCw0Y8g0LHQsNC30L7QstCw0Y8g0YbQtdC90LAg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YInKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW50ZWdlcih0YXJnZXRQcmljZS52YWx1ZSkgIT09IGV4cGVjdGVkKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCd0YXJnZXQnLCAn0JjRgtC+0LPQvtCy0YvQuSDRhtC10L3QvdC40Log0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YInKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIG1ha2VKb3VybmFsKGZyZXNoLCBjaGFuZ2VkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGF0dXM6ICd3cml0aW5nJyxcbiAgICAgICAgICAgIGNoZWNrZWQ6IDAsXG4gICAgICAgICAgICB2ZXJpZmllZDogMCxcbiAgICAgICAgICAgIHNpZ25hdHVyZTogZnJlc2guc2lnbmF0dXJlLFxuICAgICAgICAgICAgdG90YWw6IGZyZXNoLmVudHJpZXMubGVuZ3RoLFxuICAgICAgICAgICAgY2hhbmdlZDogY2hhbmdlZC5sZW5ndGgsXG4gICAgICAgICAgICBpbnRlbnQ6IG51bGwsXG4gICAgICAgICAgICByZWNvcmRzOiBjaGFuZ2VkLm1hcChlbnRyeSA9PiAoe1xuICAgICAgICAgICAgICAgIGlkOiBlbnRyeS5pZCxcbiAgICAgICAgICAgICAgICBuYW1lOiBlbnRyeS5uYW1lLFxuICAgICAgICAgICAgICAgIG9sZDogZW50cnkub2xkLFxuICAgICAgICAgICAgICAgIG5ldzogZW50cnkubmV3LFxuICAgICAgICAgICAgICAgIG91dGNvbWU6ICdwZW5kaW5nJ1xuICAgICAgICAgICAgfSkpLFxuICAgICAgICAgICAgZXJyb3I6IG51bGxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcGVyc2lzdCAhPT0gJ2Z1bmN0aW9uJykgcmV0dXJuIGZhbHNlO1xuICAgICAgICBjb25zdCBzbmFwc2hvdCA9IGNvcHkoam91cm5hbCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBwZXJzaXN0KHNuYXBzaG90KTtcbiAgICAgICAgICAgIHJldHVybiBzdG9yZWQgIT09IG51bGwgJiYgdHlwZW9mIHN0b3JlZCA9PT0gJ29iamVjdCdcbiAgICAgICAgICAgICAgICAmJiBjYW5vbmljYWwoc3RvcmVkKSA9PT0gY2Fub25pY2FsKHNuYXBzaG90KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNldE91dGNvbWUoam91cm5hbCwgaWQsIG91dGNvbWUpIHtcbiAgICAgICAgZm9yIChjb25zdCByZWNvcmQgb2Ygam91cm5hbC5yZWNvcmRzKSB7XG4gICAgICAgICAgICBpZiAocmVjb3JkLmlkID09PSBpZCkgcmVjb3JkLm91dGNvbWUgPSBvdXRjb21lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVjb3VudChqb3VybmFsKSB7XG4gICAgICAgIGxldCBjaGVja2VkID0gMDtcbiAgICAgICAgbGV0IHZlcmlmaWVkID0gMDtcbiAgICAgICAgZm9yIChjb25zdCByZWNvcmQgb2Ygam91cm5hbC5yZWNvcmRzKSB7XG4gICAgICAgICAgICBpZiAocmVjb3JkLm91dGNvbWUgPT09ICdwZW5kaW5nJyB8fCByZWNvcmQub3V0Y29tZSA9PT0gJ3dyaXRpbmcnKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNoZWNrZWQgKz0gMTtcbiAgICAgICAgICAgIGlmIChyZWNvcmQub3V0Y29tZSA9PT0gJ3ZlcmlmaWVkJyB8fCByZWNvcmQub3V0Y29tZSA9PT0gJ2FwcGxpZWQnXG4gICAgICAgICAgICAgICAgfHwgcmVjb3JkLm91dGNvbWUgPT09ICdhcHBsaWVkLWFmdGVyLWVycm9yJykgdmVyaWZpZWQgKz0gMTtcbiAgICAgICAgfVxuICAgICAgICBqb3VybmFsLmNoZWNrZWQgPSBjaGVja2VkO1xuICAgICAgICBqb3VybmFsLnZlcmlmaWVkID0gdmVyaWZpZWQ7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZmFpbHVyZVN0YXR1cyhqb3VybmFsKSB7XG4gICAgICAgIHJldHVybiBqb3VybmFsLnZlcmlmaWVkID4gMCA/ICdpbnRlcnJ1cHRlZCcgOiAnZmFpbGVkJztcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBmaW5hbEF1ZGl0KGpvdXJuYWwsIHJlYWQsIGZyZXNoKSB7XG4gICAgICAgIGxldCBjaGVja2VkID0gMDtcbiAgICAgICAgbGV0IHZlcmlmaWVkID0gMDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gbmV3IE1hcCgpO1xuICAgICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBmcmVzaC5lbnRyaWVzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY2FyZCA9IGF3YWl0IHJlYWRKc29uKHJlYWQsICcvZW50aXR5L3Byb2R1Y3QvJyArIGVudHJ5LmlkKTtcbiAgICAgICAgICAgICAgICBjYXJkQmFzZShjYXJkLCBlbnRyeS5pZCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgdmVyaWZ5U3RhYmxlKGNhcmQsIGVudHJ5LCBlbnRyeS5uZXcsIHJlYWQsIEFQSSwgY2FjaGUpO1xuICAgICAgICAgICAgICAgIGNoZWNrZWQgKz0gMTtcbiAgICAgICAgICAgICAgICB2ZXJpZmllZCArPSAxO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgb3JkZXIgPSBhd2FpdCByZWFkSnNvbihyZWFkLCAnL2VudGl0eS9pbnRlcm5hbG9yZGVyLycgKyBPUkRFUl9JRCk7XG4gICAgICAgICAgICBjb25zdCBiYXNlID0gb3JkZXJCYXNlKG9yZGVyKTtcbiAgICAgICAgICAgIGlmICghb3JkZXIgfHwgb3JkZXIuaWQgIT09IE9SREVSX0lEIHx8IG9yZGVyLm5hbWUgIT09IGZyZXNoLm9yZGVyTmFtZSkge1xuICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2lkZW50aXR5JywgJ9CY0YLQvtCz0L7QstGL0Lkg0LLQvdGD0YLRgNC10L3QvdC40Lkg0LfQsNC60LDQtyDQvdC1INGB0L7QstC/0LDQtNCw0LXRgicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZW5kcG9pbnQgPSAnL2VudGl0eS9pbnRlcm5hbG9yZGVyLycgKyBPUkRFUl9JRCArICcvcG9zaXRpb25zJztcbiAgICAgICAgICAgIGNvbnN0IHBvc2l0aW9ucyA9IGF3YWl0IGNvbGxlY3RQYWdlcyhyZWFkLFxuICAgICAgICAgICAgICAgIGVuZHBvaW50ICsgJz9leHBhbmQ9YXNzb3J0bWVudCZsaW1pdD0nICsgUE9TSVRJT05TX0xJTUlULCBiYXNlLCBlbmRwb2ludCk7XG4gICAgICAgICAgICBpZiAoZG9jdW1lbnRTaWduYXR1cmUob3JkZXIsIHBvc2l0aW9ucykgIT09IGZyZXNoLnNpZ25hdHVyZSkge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gZmFpbHVyZVN0YXR1cyhqb3VybmFsKTtcbiAgICAgICAgICAgICAgICBqb3VybmFsLmNoZWNrZWQgPSBjaGVja2VkO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwudmVyaWZpZWQgPSB2ZXJpZmllZDtcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3NpZ25hdHVyZS1jaGFuZ2VkJztcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGpvdXJuYWwuY2hlY2tlZCA9IGNoZWNrZWQ7XG4gICAgICAgICAgICBqb3VybmFsLnZlcmlmaWVkID0gdmVyaWZpZWQ7XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd2ZXJpZmllZCc7XG4gICAgICAgICAgICBqb3VybmFsLmludGVudCA9IG51bGw7XG4gICAgICAgICAgICBqb3VybmFsLmVycm9yID0gbnVsbDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGpvdXJuYWwucmVjb3JkcykgcmVjb3JkLm91dGNvbWUgPSAndmVyaWZpZWQnO1xuICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9IGZhaWx1cmVTdGF0dXMoam91cm5hbCk7XG4gICAgICAgICAgICBqb3VybmFsLmNoZWNrZWQgPSBjaGVja2VkO1xuICAgICAgICAgICAgam91cm5hbC52ZXJpZmllZCA9IHZlcmlmaWVkO1xuICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdmaW5hbC1yZWFkLWZhaWxlZCc7XG4gICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIGZpbmlzaChqb3VybmFsLCBwZXJzaXN0KSB7XG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICBpZiAoam91cm5hbC5zdGF0dXMgPT09ICd2ZXJpZmllZCcgJiYgIXN0b3JlZCkge1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAndW5jZXJ0YWluJztcbiAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAncGVyc2lzdC1mYWlsZWQnO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIGFwcGx5KHByZXZpZXcsIHBvcnRzKSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwb3J0cyB8fCB7fTtcbiAgICAgICAgY29uc3QgcmVhZCA9IG9wdGlvbnMucmVhZDtcbiAgICAgICAgY29uc3Qgd3JpdGUgPSBvcHRpb25zLndyaXRlO1xuICAgICAgICBjb25zdCBwZXJzaXN0ID0gb3B0aW9ucy5wZXJzaXN0O1xuICAgICAgICBpZiAodHlwZW9mIHJlYWQgIT09ICdmdW5jdGlvbicgfHwgdHlwZW9mIHdyaXRlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdhcHBseSByZXF1aXJlcyByZWFkIGFuZCB3cml0ZSBmdW5jdGlvbnMnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXByZXZpZXcgfHwgdHlwZW9mIHByZXZpZXcgIT09ICdvYmplY3QnIHx8IHR5cGVvZiBwcmV2aWV3LnNpZ25hdHVyZSAhPT0gJ3N0cmluZydcbiAgICAgICAgICAgIHx8ICFBcnJheS5pc0FycmF5KHByZXZpZXcuZW50cmllcykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2FwcGx5IHJlcXVpcmVzIGFuIGV4cGxpY2l0bHkgY2FwdHVyZWQgcHJldmlldycpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZyZXNoO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgZnJlc2ggPSBhd2FpdCBtYWtlUGxhbihyZWFkKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3RhdHVzOiAnZmFpbGVkJywgY2hlY2tlZDogMCwgdmVyaWZpZWQ6IDAsXG4gICAgICAgICAgICAgICAgc2lnbmF0dXJlOiBwcmV2aWV3LnNpZ25hdHVyZSwgdG90YWw6IDAsIGNoYW5nZWQ6IDAsXG4gICAgICAgICAgICAgICAgaW50ZW50OiBudWxsLCByZWNvcmRzOiBbXSwgZXJyb3I6ICdwbGFuLWZhaWxlZCdcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBjaGFuZ2VkID0gZnJlc2guZW50cmllcy5maWx0ZXIoZW50cnkgPT4gZW50cnkubmV3ICE9PSBlbnRyeS5vbGQpO1xuICAgICAgICBjb25zdCBqb3VybmFsID0gbWFrZUpvdXJuYWwoZnJlc2gsIGNoYW5nZWQpO1xuICAgICAgICBjb25zdCBzb3J0ZWQgPSByb3dzID0+IHJvd3Muc2xpY2UoKS5zb3J0KChsZWZ0LCByaWdodCkgPT4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKSk7XG4gICAgICAgIGNvbnN0IHN0YWxlID0gZnJlc2guc2lnbmF0dXJlICE9PSBwcmV2aWV3LnNpZ25hdHVyZVxuICAgICAgICAgICAgfHwgY2Fub25pY2FsKHNvcnRlZChmcmVzaC5lbnRyaWVzKSkgIT09IGNhbm9uaWNhbChzb3J0ZWQocHJldmlldy5lbnRyaWVzKSlcbiAgICAgICAgICAgIHx8IGNhbm9uaWNhbChmcmVzaC5za2lwcGVkKSAhPT0gY2Fub25pY2FsKHByZXZpZXcuc2tpcHBlZCk7XG4gICAgICAgIGlmIChzdGFsZSkge1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAnZmFpbGVkJztcbiAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAnc3RhbGUtcHJldmlldyc7XG4gICAgICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFjaGFuZ2VkLmxlbmd0aCkge1xuICAgICAgICAgICAgY29uc3QgYXVkaXRlZCA9IGF3YWl0IGZpbmFsQXVkaXQoam91cm5hbCwgcmVhZCwgZnJlc2gpO1xuICAgICAgICAgICAgcmV0dXJuIGZpbmlzaChhdWRpdGVkLCBwZXJzaXN0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgY2hhbmdlZCkge1xuICAgICAgICAgICAgY29uc3QgcGF0aCA9ICcvZW50aXR5L3Byb2R1Y3QvJyArIGVudHJ5LmlkO1xuICAgICAgICAgICAgbGV0IGJlZm9yZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYmVmb3JlID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgcGF0aCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gZmFpbHVyZVN0YXR1cyhqb3VybmFsKTtcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3ByZXdyaXRlLXJlYWQtZmFpbGVkJztcbiAgICAgICAgICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHRhcmdldFByaWNlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAoIWJlZm9yZSB8fCBiZWZvcmUuaWQgIT09IGVudHJ5LmlkIHx8IGJlZm9yZS5uYW1lICE9PSBlbnRyeS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2lkZW50aXR5JywgJ9Ca0LDRgNGC0L7Rh9C60LAg0LjQt9C80LXQvdC40LvQsNGB0Ywg0L/QvtGB0LvQtSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YDQsCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBiYXNlUHJpY2UgPSBzZWxlY3RQcmljZShiZWZvcmUsIEJBU0VfUFJJQ0VfVFlQRV9JRCwgQkFTRV9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICAgICAgICAgIHRhcmdldFByaWNlID0gc2VsZWN0UHJpY2UoYmVmb3JlLCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCwgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgICAgICAgICAgaWYgKGludGVnZXIoYmFzZVByaWNlLnZhbHVlKSAhPT0gZW50cnkuYmFzZVxuICAgICAgICAgICAgICAgICAgICB8fCBpbnRlZ2VyKHRhcmdldFByaWNlLnZhbHVlKSAhPT0gZW50cnkub2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3ByZXZpZXcnLCAn0KbQtdC90LAg0LjQt9C80LXQvdC40LvQsNGB0Ywg0L/QvtGB0LvQtSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YDQsCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBiYXNlID0gY2FyZEJhc2UoYmVmb3JlLCBlbnRyeS5pZCk7XG4gICAgICAgICAgICAgICAgY29uc3QgY2FjaGUgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIGJhc2VQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCB0YXJnZXRQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9IGZhaWx1cmVTdGF0dXMoam91cm5hbCk7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9IGVycm9yICYmIGVycm9yLnZhbGlkYXRpb24gPT09IHRydWVcbiAgICAgICAgICAgICAgICAgICAgPyAncHJld3JpdGUtbWlzbWF0Y2gnIDogJ3ByZXdyaXRlLXJlYWQtZmFpbGVkJztcbiAgICAgICAgICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgam91cm5hbC5pbnRlbnQgPSB7XG4gICAgICAgICAgICAgICAgaWQ6IGVudHJ5LmlkLFxuICAgICAgICAgICAgICAgIG5hbWU6IGVudHJ5Lm5hbWUsXG4gICAgICAgICAgICAgICAgcGF0aCxcbiAgICAgICAgICAgICAgICBiYXNlOiBlbnRyeS5iYXNlLFxuICAgICAgICAgICAgICAgIG9sZDogZW50cnkub2xkLFxuICAgICAgICAgICAgICAgIG5ldzogZW50cnkubmV3LFxuICAgICAgICAgICAgICAgIHByaWNlVHlwZToge1xuICAgICAgICAgICAgICAgICAgICBpZDogVEFSR0VUX1BSSUNFX1RZUEVfSUQsXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IFRBUkdFVF9QUklDRV9UWVBFX05BTUUsXG4gICAgICAgICAgICAgICAgICAgIGhyZWY6IFN0cmluZyh0YXJnZXRQcmljZS5wcmljZVR5cGUubWV0YS5ocmVmKVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgY3VycmVuY3k6IHsgaHJlZjogU3RyaW5nKHRhcmdldFByaWNlLmN1cnJlbmN5Lm1ldGEuaHJlZikgfSxcbiAgICAgICAgICAgICAgICBvdGhlcnM6IG90aGVyUHJpY2VzKGJlZm9yZSksXG4gICAgICAgICAgICAgICAgZmllbGRzOiBjYW5vbmljYWwoYnVzaW5lc3NGaWVsZHMoYmVmb3JlKSlcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd3cml0aW5nJztcbiAgICAgICAgICAgIHNldE91dGNvbWUoam91cm5hbCwgZW50cnkuaWQsICd3cml0aW5nJyk7XG4gICAgICAgICAgICByZWNvdW50KGpvdXJuYWwpO1xuICAgICAgICAgICAgaWYgKCFhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKSkge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ2ZhaWxlZCc7XG4gICAgICAgICAgICAgICAgam91cm5hbC5pbnRlbnQgPSBudWxsO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAncGVyc2lzdC1mYWlsZWQnO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBwYXlsb2FkID0gcGF5bG9hZEZvcihlbnRyeSwgdGFyZ2V0UHJpY2UpO1xuICAgICAgICAgICAgbGV0IHdyaXRlRmFpbGVkID0gZmFsc2U7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHdyaXRlKHBhdGgsIHBheWxvYWQpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICB3cml0ZUZhaWxlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBhZnRlcjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYWZ0ZXIgPSBhd2FpdCByZWFkSnNvbihyZWFkLCBwYXRoKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAndW5jZXJ0YWluJztcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3JlYWRiYWNrLWZhaWxlZCc7XG4gICAgICAgICAgICAgICAgc2V0T3V0Y29tZShqb3VybmFsLCBlbnRyeS5pZCwgJ3VuY2VydGFpbicpO1xuICAgICAgICAgICAgICAgIHJlY291bnQoam91cm5hbCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgdmVyaWZ5V3JpdGFibGUoYWZ0ZXIsIGVudHJ5LCBiZWZvcmUpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd1bmNlcnRhaW4nO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSB3cml0ZUZhaWxlZCA/ICd3cml0ZS1mYWlsZWQtdW52ZXJpZmllZCcgOiAncmVhZGJhY2stbWlzbWF0Y2gnO1xuICAgICAgICAgICAgICAgIHNldE91dGNvbWUoam91cm5hbCwgZW50cnkuaWQsICd1bmNlcnRhaW4nKTtcbiAgICAgICAgICAgICAgICByZWNvdW50KGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBqb3VybmFsLmludGVudCA9IG51bGw7XG4gICAgICAgICAgICBzZXRPdXRjb21lKGpvdXJuYWwsIGVudHJ5LmlkLCB3cml0ZUZhaWxlZCA/ICdhcHBsaWVkLWFmdGVyLWVycm9yJyA6ICd2ZXJpZmllZCcpO1xuICAgICAgICAgICAgcmVjb3VudChqb3VybmFsKTtcbiAgICAgICAgICAgIGlmICghYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCkpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd1bmNlcnRhaW4nO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAncGVyc2lzdC1mYWlsZWQnO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHdyaXRlRmFpbGVkKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAnaW50ZXJydXB0ZWQnO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAnd3JpdGUtZmFpbGVkLWFwcGxpZWQnO1xuICAgICAgICAgICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgYXVkaXRlZCA9IGF3YWl0IGZpbmFsQXVkaXQoam91cm5hbCwgcmVhZCwgZnJlc2gpO1xuICAgICAgICByZXR1cm4gZmluaXNoKGF1ZGl0ZWQsIHBlcnNpc3QpO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHVucmVzb2x2ZWQoam91cm5hbCwgcGVyc2lzdCkge1xuICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd1bmNlcnRhaW4nO1xuICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN1bW1hcnk6ICdpbnRlcnJ1cHRlZCcsIHN0YXR1czogam91cm5hbC5zdGF0dXMsIHJlc29sdmVkOiBmYWxzZSwgYmxvY2tlZDogdHJ1ZSxcbiAgICAgICAgICAgIG91dGNvbWU6ICd1bnJlc29sdmVkJywgY2hlY2tlZDogam91cm5hbC5jaGVja2VkLCB2ZXJpZmllZDogam91cm5hbC52ZXJpZmllZCxcbiAgICAgICAgICAgIGludGVudDogam91cm5hbC5pbnRlbnRcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiByZWNvbmNpbGUoam91cm5hbCwgcG9ydHMpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHBvcnRzIHx8IHt9O1xuICAgICAgICBjb25zdCByZWFkID0gb3B0aW9ucy5yZWFkO1xuICAgICAgICBjb25zdCBwZXJzaXN0ID0gb3B0aW9ucy5wZXJzaXN0O1xuICAgICAgICBpZiAodHlwZW9mIHJlYWQgIT09ICdmdW5jdGlvbicpIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlY29uY2lsZSByZXF1aXJlcyBhIHJlYWQgZnVuY3Rpb24nKTtcbiAgICAgICAgaWYgKCFqb3VybmFsIHx8IHR5cGVvZiBqb3VybmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVjb25jaWxlIHJlcXVpcmVzIGEgam91cm5hbCcpO1xuICAgICAgICB9XG5cbiAgICAgICAgam91cm5hbCA9IGNvcHkoam91cm5hbCk7XG4gICAgICAgIGNvbnN0IGludGVudCA9IGpvdXJuYWwuaW50ZW50O1xuICAgICAgICBpZiAoam91cm5hbC5zdGF0dXMgPT09ICd2ZXJpZmllZCcgJiYgIWludGVudCkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdW1tYXJ5OiAnZmluaXNoZWQnLCBzdGF0dXM6ICd2ZXJpZmllZCcsIHJlc29sdmVkOiB0cnVlLCBibG9ja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBvdXRjb21lOiAndmVyaWZpZWQnLCBjaGVja2VkOiBqb3VybmFsLmNoZWNrZWQsIHZlcmlmaWVkOiBqb3VybmFsLnZlcmlmaWVkLCBpbnRlbnQ6IG51bGxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFpbnRlbnQpIHtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ2ludGVycnVwdGVkJztcbiAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHN1bW1hcnk6ICdpbnRlcnJ1cHRlZCcsIHN0YXR1czogam91cm5hbC5zdGF0dXMsIHJlc29sdmVkLCBibG9ja2VkOiAhcmVzb2x2ZWQsXG4gICAgICAgICAgICAgICAgb3V0Y29tZTogJ25vbmUnLCBjaGVja2VkOiBqb3VybmFsLmNoZWNrZWQsIHZlcmlmaWVkOiBqb3VybmFsLnZlcmlmaWVkLCBpbnRlbnQ6IG51bGxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY2FyZDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICghVVVJRF9QQVRURVJOLnRlc3QoaW50ZW50LmlkKSB8fCBpbnRlbnQucGF0aCAhPT0gJy9lbnRpdHkvcHJvZHVjdC8nICsgaW50ZW50LmlkKSB0aHJvdyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3QvtC1INC90LDQvNC10YDQtdC90LjQtSDQt9Cw0L/QuNGB0LgnKTtcbiAgICAgICAgICAgIGNhcmQgPSBhd2FpdCByZWFkSnNvbihyZWFkLCBpbnRlbnQucGF0aCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5yZXNvbHZlZChqb3VybmFsLCBwZXJzaXN0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIWNhcmQgfHwgY2FyZC5pZCAhPT0gaW50ZW50LmlkIHx8IGNhcmQubmFtZSAhPT0gaW50ZW50Lm5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdpZGVudGl0eScsICfQmtCw0YDRgtC+0YfQutCwINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINC90LDQvNC10YDQtdC90LjQtdC8Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBiYXNlID0gY2FyZEJhc2UoY2FyZCwgaW50ZW50LmlkKTtcbiAgICAgICAgICAgIGNvbnN0IGJhc2VQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIEJBU0VfUFJJQ0VfVFlQRV9JRCwgQkFTRV9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICAgICAgY29uc3QgdGFyZ2V0UHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCwgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IG5ldyBNYXAoKTtcbiAgICAgICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCBiYXNlUHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCB0YXJnZXRQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICAgICAgaWYgKGludGVnZXIoYmFzZVByaWNlLnZhbHVlKSAhPT0gaW50ZW50LmJhc2UpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdiYXNlJywgJ9CR0LDQt9C+0LLQsNGPINGG0LXQvdCwINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINC90LDQvNC10YDQtdC90LjQtdC8Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoY2Fub25pY2FsKG90aGVyUHJpY2VzKGNhcmQpKSAhPT0gY2Fub25pY2FsKGludGVudC5vdGhlcnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJpY2VzJywgJ9CU0YDRg9Cz0LjQtSDRgtC40L/RiyDRhtC10L0g0L3QtSDRgdC+0LLQv9Cw0LTQsNGO0YIg0YEg0L3QsNC80LXRgNC10L3QuNC10LwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjYW5vbmljYWwoYnVzaW5lc3NGaWVsZHMoY2FyZCkpICE9PSBpbnRlbnQuZmllbGRzIHx8IHRhcmdldFByaWNlLmN1cnJlbmN5Lm1ldGEuaHJlZiAhPT0gaW50ZW50LmN1cnJlbmN5LmhyZWZcbiAgICAgICAgICAgICAgICB8fCB0YXJnZXRQcmljZS5wcmljZVR5cGUubWV0YS5ocmVmICE9PSBpbnRlbnQucHJpY2VUeXBlLmhyZWYpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdmaWVsZHMnLCAn0J/QvtC70Y8g0LrQsNGA0YLQvtGH0LrQuCDQvdC1INGB0L7QstC/0LDQtNCw0Y7RgiDRgSDQvdCw0LzQtdGA0LXQvdC40LXQvCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBpbnRlZ2VyKHRhcmdldFByaWNlLnZhbHVlKTtcbiAgICAgICAgICAgIGlmICh2YWx1ZSAhPT0gaW50ZW50Lm9sZCAmJiB2YWx1ZSAhPT0gaW50ZW50Lm5ldykge1xuICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3RhcmdldCcsICfQptC10L3QvdC40Log0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0L3QuCDRgdC+INGB0YLQsNGA0YvQvCwg0L3QuCDRgSDQvdC+0LLRi9C8INC30L3QsNGH0LXQvdC40LXQvCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYXBwbGllZCA9IHZhbHVlID09PSBpbnRlbnQubmV3O1xuICAgICAgICAgICAgc2V0T3V0Y29tZShqb3VybmFsLCBpbnRlbnQuaWQsIGFwcGxpZWQgPyAnYXBwbGllZCcgOiAnbm90LWFwcGxpZWQnKTtcbiAgICAgICAgICAgIHJlY291bnQoam91cm5hbCk7XG4gICAgICAgICAgICBqb3VybmFsLmludGVudCA9IG51bGw7XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICdpbnRlcnJ1cHRlZCc7XG4gICAgICAgICAgICBqb3VybmFsLmVycm9yID0gbnVsbDtcbiAgICAgICAgICAgIGlmICghYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBzdW1tYXJ5OiAnaW50ZXJydXB0ZWQnLCBzdGF0dXM6ICd1bmNlcnRhaW4nLCByZXNvbHZlZDogZmFsc2UsIGJsb2NrZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIG91dGNvbWU6ICd1bnJlc29sdmVkJywgY2hlY2tlZDogam91cm5hbC5jaGVja2VkLCB2ZXJpZmllZDogam91cm5hbC52ZXJpZmllZCxcbiAgICAgICAgICAgICAgICAgICAgaW50ZW50OiB7IGlkOiBpbnRlbnQuaWQsIHBhdGg6IGludGVudC5wYXRoIH1cbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdW1tYXJ5OiAnZmluaXNoZWQnLCBzdGF0dXM6ICdpbnRlcnJ1cHRlZCcsIHJlc29sdmVkOiB0cnVlLCBibG9ja2VkOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBvdXRjb21lOiBhcHBsaWVkID8gJ2FwcGxpZWQnIDogJ25vdC1hcHBsaWVkJyxcbiAgICAgICAgICAgICAgICBjaGVja2VkOiBqb3VybmFsLmNoZWNrZWQsIHZlcmlmaWVkOiBqb3VybmFsLnZlcmlmaWVkLCBpbnRlbnQ6IG51bGxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5yZXNvbHZlZChqb3VybmFsLCBwZXJzaXN0KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBPYmplY3QuZnJlZXplKHsgcGxhbiwgYXBwbHksIHJlY29uY2lsZSwgY2FsY3VsYXRlIH0pO1xufVxuIiwiLy8gT25lIE1lbWNoYXQgd3JpdGVyIGFjcm9zcyBhbGwgbmF0aXZlIHBhbmVscy4gQW4gdW5maW5pc2hlZCBqb3VybmFsIHN1cnZpdmVzIHdvcmtlciByZXN0YXJ0cy5cbmNvbnN0IE1FTUNIQVRfUkVQUklDRV9KT1VSTkFMID0gJ21lbWNoYXRSZXByaWNlSm91cm5hbF92MSc7XG5cbmNvbnN0IHJlcHJpY2VQcmV2aWV3cyA9IG5ldyBNYXAoKTtcbmNvbnN0IHJlcHJpY2VTZXR0aW5ncyA9IG5ldyBNYXAoKTtcbmNvbnN0IHJlcHJpY2VQZW5kaW5nID0gbmV3IFNldCgpO1xubGV0IHJlcHJpY2VCdXN5ID0gZmFsc2U7XG5cbmZ1bmN0aW9uIHJlcHJpY2VPd25lcihzZW5kZXIpIHtcbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICduYXRpdmU6JyArIHNlbmRlci51cmw7XG4gICAgaWYgKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgJiYgdHlwZW9mIHNlbmRlci5kb2N1bWVudElkID09PSAnc3RyaW5nJyAmJiBzZW5kZXIuZG9jdW1lbnRJZCkge1xuICAgICAgICByZXR1cm4gYGNvbnRlbnQ6JHtzZW5kZXIudGFiLmlkfToke3NlbmRlci5kb2N1bWVudElkfWA7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVwcmljZUFjY2VzcyhzZW5kZXIpIHtcbiAgICBpZiAoIXJlcHJpY2VPd25lcihzZW5kZXIpKSB0aHJvdyBFcnJvcign0J/QsNC90LXQu9GMINC+0YLQutC70Y7Rh9C10L3QsCcpO1xuICAgIGNvbnN0IG9yaWdpbiA9IHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKTtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ2hhaW47XG4gICAgY29uc3Qga2V5ID0gJ21lbWNoYXRQcml2YXRlX3YxOicgKyBvcmlnaW47XG4gICAgY29uc3QgYnVja2V0ID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldO1xuICAgIGNvbnN0IGFwaSA9IEpTT04ucGFyc2UoYnVja2V0Py5pdGVtcz8uWydtZW1jaGF0OmhhY2tlck1zQXBpX3YxJ10/LnZhbHVlIHx8ICd7fScpO1xuICAgIGlmICghcmVwcmljZU93bmVyKHNlbmRlcikgfHwgYXBpLmJlYXJlckVuYWJsZWQgIT09IHRydWUgfHwgdHlwZW9mIGFwaS50b2tlbiAhPT0gJ3N0cmluZycgfHwgIWFwaS50b2tlbi50cmltKClcbiAgICAgICAgfHwgdHlwZW9mIGFwaS5yZWZlcmVuY2VTY29wZSAhPT0gJ3N0cmluZycgfHwgIWFwaS5yZWZlcmVuY2VTY29wZSkgdGhyb3cgRXJyb3IoJ0JlYXJlciDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xuICAgIHJldHVybiB7IG9yaWdpbiwgc2NvcGU6IGFwaS5yZWZlcmVuY2VTY29wZSwgdG9rZW46IGFwaS50b2tlbiB9O1xufVxuXG5mdW5jdGlvbiByZXByaWNlU2FtZUFjY291bnQobGVmdCwgcmlnaHQpIHtcbiAgICByZXR1cm4gbGVmdC5vcmlnaW4gPT09IHJpZ2h0Lm9yaWdpbiAmJiBsZWZ0LnNjb3BlID09PSByaWdodC5zY29wZTtcbn1cblxubGV0IHNhbGVzU2V0dGluZ3NDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gc2FsZXNTZXR0aW5nc01lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3Qgd29yayA9IHNhbGVzU2V0dGluZ3NDaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgeyBhY2NvdW50SWQgfSA9IG1lc3NhZ2U7XG4gICAgICAgIGNvbnN0IHNhdmUgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNhbGVzLXNldHRpbmdzLXNhdmUnO1xuICAgICAgICBpZiAodHlwZW9mIGFjY291bnRJZCAhPT0gJ3N0cmluZycgfHwgIU1FTUNIQVRfUkVQUklDRV9VVUlELnRlc3QoYWNjb3VudElkKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGNvbnN0IGNyZWRlbnRpYWwgPSBhd2FpdCByZXByaWNlQWNjZXNzKHNlbmRlcik7XG4gICAgICAgIGNvbnN0IGtleSA9ICdtZW1jaGF0U2FsZXNTdG9yZV92MTonICsgY3JlZGVudGlhbC5vcmlnaW4gKyAnOicgKyBhY2NvdW50SWQ7XG4gICAgICAgIGNvbnN0IHN0b3JlSWQgPSBzYXZlID8gbWVzc2FnZS5zdG9yZUlkIDogKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldO1xuICAgICAgICBpZiAoIXNhdmUgJiYgc3RvcmVJZCA9PSBudWxsKSByZXR1cm4geyBvazogdHJ1ZSwgc3RvcmVJZDogbnVsbCB9O1xuICAgICAgICBpZiAodHlwZW9mIHN0b3JlSWQgIT09ICdzdHJpbmcnIHx8ICFNRU1DSEFUX1JFUFJJQ0VfVVVJRC50ZXN0KHN0b3JlSWQpKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFjdGl2ZSA9IGF3YWl0IHJlcHJpY2VBY2Nlc3Moc2VuZGVyKTtcbiAgICAgICAgICAgIHJldHVybiByZXByaWNlU2FtZUFjY291bnQoYWN0aXZlLCBjcmVkZW50aWFsKSAmJiBhY3RpdmUudG9rZW4gPT09IGNyZWRlbnRpYWwudG9rZW47XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcGVyZm9ybVJlcXVlc3QoeyBpZDogJ3NhbGVzLXN0b3JlLScgKyBjcnlwdG8ucmFuZG9tVVVJRCgpLCByZXF1ZXN0OiB7XG4gICAgICAgICAgICB1cmw6IE1FTUNIQVRfUkVQUklDRV9BUEkgKyAnL2VudGl0eS9zdG9yZS8nICsgc3RvcmVJZCwgbWV0aG9kOiAnR0VUJywgYW5vbnltb3VzOiB0cnVlLCBjcmVkZW50aWFsR3VhcmQ6IHRydWUsXG4gICAgICAgICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246ICdCZWFyZXIgJyArIGNyZWRlbnRpYWwudG9rZW4sIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfSxcbiAgICAgICAgfSB9LCBzZW5kZXIsIHVuZGVmaW5lZCwgY3VycmVudCk7XG4gICAgICAgIGlmIChyZXNwb25zZS5ldmVudCAhPT0gJ2xvYWQnIHx8ICFhd2FpdCBjdXJyZW50KCkpIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICBpZiAoIXNhdmUgJiYgcmVzcG9uc2UucmVzcG9uc2Uuc3RhdHVzID09PSA0MDQpIHJldHVybiB7IG9rOiB0cnVlLCBzdG9yZUlkOiBudWxsIH07XG4gICAgICAgIGlmIChyZXNwb25zZS5yZXNwb25zZS5zdGF0dXMgIT09IDIwMCkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGNvbnN0IHN0b3JlID0gSlNPTi5wYXJzZShyZXNwb25zZS5yZXNwb25zZS5yZXNwb25zZVRleHQpO1xuICAgICAgICBpZiAoc3RvcmUuaWQgIT09IHN0b3JlSWQgfHwgc3RvcmUuYWNjb3VudElkICE9PSBhY2NvdW50SWQgfHwgc3RvcmUuYXJjaGl2ZWQgPT09IHRydWUpIHtcbiAgICAgICAgICAgIHJldHVybiBzYXZlID8geyBvazogZmFsc2UgfSA6IHsgb2s6IHRydWUsIHN0b3JlSWQ6IG51bGwgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2F2ZSkge1xuICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW2tleV06IHN0b3JlSWQgfSk7XG4gICAgICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldICE9PSBzdG9yZUlkKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgc3RvcmVJZCB9O1xuICAgIH0pO1xuICAgIHNhbGVzU2V0dGluZ3NDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+ICh7IG9rOiBmYWxzZSB9KSk7XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VSdWxlc0tleShvcmlnaW4pIHsgcmV0dXJuICdtZW1jaGF0UmVwcmljZVJ1bGVzX3YxOicgKyBvcmlnaW47IH1cblxuYXN5bmMgZnVuY3Rpb24gcmVwcmljZUxvYWRSdWxlcyhhY2Nlc3MpIHtcbiAgICBjb25zdCBrZXkgPSByZXByaWNlUnVsZXNLZXkoYWNjZXNzLm9yaWdpbik7XG4gICAgY29uc3QgcmVjb3JkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldO1xuICAgIGlmIChyZWNvcmQ/LnNjb3BlICE9PSBhY2Nlc3Muc2NvcGUpIHJldHVybiBudWxsO1xuICAgIGlmICh0eXBlb2YgcmVjb3JkLnJldmlzaW9uICE9PSAnc3RyaW5nJyB8fCAhcmVjb3JkLnJ1bGVzKSB0aHJvdyBFcnJvcign0J/RgNCw0LLQuNC70LAg0L/QtdGA0LXQvtGG0LXQvdC60Lgg0L3QtdC00L7RgdGC0YPQv9C90YsuJyk7XG4gICAgcmV0dXJuIHJlY29yZDtcbn1cblxuZnVuY3Rpb24gcmVwcmljZU9yZGVySWQocmF3KSB7XG4gICAgaWYgKHR5cGVvZiByYXcgIT09ICdzdHJpbmcnIHx8IHJhdy5sZW5ndGggPiAyNTYpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHByZWZpeCA9ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydS9hcHAvI2ludGVybmFsb3JkZXIvZWRpdD9pZD0nO1xuICAgIGNvbnN0IHVybCA9IHJhdy50cmltKCk7XG4gICAgY29uc3QgaWQgPSB1cmwuc2xpY2UocHJlZml4Lmxlbmd0aCk7XG4gICAgcmV0dXJuIHVybC5zdGFydHNXaXRoKHByZWZpeCkgJiYgTUVNQ0hBVF9SRVBSSUNFX1VVSUQudGVzdChpZCkgPyBpZCA6IG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcHJpY2VMaXZlKHNlbmRlciwgb3JpZ2luKSB7XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHJldHVybiBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcikgPT09IG9yaWdpbjtcbiAgICBsZXQgdGltZXI7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2Uoc2VuZGVyLnRhYi5pZCwgeyB0eXBlOiAnbWVtY2hhdDpyZXByaWNlLWN1cnJlbnQnIH0sIHsgZG9jdW1lbnRJZDogc2VuZGVyLmRvY3VtZW50SWQgfSksXG4gICAgICAgICAgICBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgdGltZXIgPSBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMDApOyB9KVxuICAgICAgICBdKTtcbiAgICAgICAgcmV0dXJuIHJlcGx5Py5jdXJyZW50ID09PSB0cnVlICYmIHJlcGx5LnVybCA9PT0gc2VuZGVyLnVybCAmJiBuZXcgVVJMKHJlcGx5LnVybCkub3JpZ2luID09PSBvcmlnaW47XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxuICAgIGZpbmFsbHkgeyBjbGVhclRpbWVvdXQodGltZXIpOyB9XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VSZW1lbWJlcihtYXAsIG93bmVyLCB2YWx1ZSkge1xuICAgIG1hcC5kZWxldGUob3duZXIpO1xuICAgIGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIG1hcCkgaWYgKGVudHJ5LmV4cGlyZXMgPCBEYXRlLm5vdygpKSBtYXAuZGVsZXRlKGtleSk7XG4gICAgaWYgKG1hcC5zaXplID49IDMyKSByZXR1cm4gZmFsc2U7XG4gICAgbWFwLnNldChvd25lciwgeyAuLi52YWx1ZSwgZXhwaXJlczogRGF0ZS5ub3coKSArIDUgKiA2MCAqIDEwMDAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VSZWNvdmVyeUNvbmZpZyhzYXZlZCkge1xuICAgIGlmIChzYXZlZC5jb25maWcpIHJldHVybiBzYXZlZC5jb25maWc7XG4gICAgLy8gVjEgam91cm5hbHMgcHJlZGF0ZSBjb25maWd1cmFibGUgcnVsZXMuIFVzZSBvbmx5IHRoZSBJRHMgY2FwdHVyZWQgaW4gdGhlXG4gICAgLy8gb3JpZ2luYWwgam91cm5hbDsgdGhlIGxlZ2FjeSBzZXR1cCBrZXkgYW5kIGN1cnJlbnQgZGVmYXVsdHMgYXJlIG5vdCBuZWVkZWQuXG4gICAgY29uc3Qgb2xkID0gSlNPTi5wYXJzZShzYXZlZC5jb25maWdLZXkgfHwgJ251bGwnKTtcbiAgICBpZiAoIW9sZCB8fCAhWydvcmRlcklkJywgJ2Jhc2VUeXBlSWQnLCAndGFyZ2V0VHlwZUlkJ10uZXZlcnkoa2V5ID0+XG4gICAgICAgIHR5cGVvZiBvbGRba2V5XSA9PT0gJ3N0cmluZycgJiYgTUVNQ0hBVF9SRVBSSUNFX1VVSUQudGVzdChvbGRba2V5XSkpIHx8IG9sZC5iYXNlVHlwZUlkID09PSBvbGQudGFyZ2V0VHlwZUlkKSB7XG4gICAgICAgIHRocm93IEVycm9yKCfQltGD0YDQvdCw0Lsg0L3QtdC00L7RgdGC0YPQv9C10L0nKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgb3JkZXJJZDogb2xkLm9yZGVySWQsIGJhc2VUeXBlSWQ6IG9sZC5iYXNlVHlwZUlkLCB0YXJnZXRUeXBlSWQ6IG9sZC50YXJnZXRUeXBlSWQsXG4gICAgICAgIHRhcmdldFR5cGVOYW1lOiBzYXZlZC5qb3VybmFsLmludGVudD8ucHJpY2VUeXBlPy5uYW1lIH07XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VVbmZpbmlzaGVkKHJlY29yZCkge1xuICAgIHJldHVybiAhIXJlY29yZCAmJiAocmVjb3JkLmpvdXJuYWw/LmludGVudCAhPSBudWxsIHx8ICFbJ3ZlcmlmaWVkJywgJ2ludGVycnVwdGVkJywgJ2ZhaWxlZCddLmluY2x1ZGVzKHJlY29yZC5qb3VybmFsPy5zdGF0dXMpKTtcbn1cblxuZnVuY3Rpb24gcmVwcmljZUpvdXJuYWxKc29uKHZhbHVlKSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHZhbHVlLCAoX2tleSwgaXRlbSkgPT4gaXRlbSAmJiB0eXBlb2YgaXRlbSA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkoaXRlbSlcbiAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmtleXMoaXRlbSkuc29ydCgpLm1hcChrZXkgPT4gW2tleSwgaXRlbVtrZXldXSkpIDogaXRlbSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcHJpY2VMb2FkSm91cm5hbCgpIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGNvbnN0IHJlY29yZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTUVNQ0hBVF9SRVBSSUNFX0pPVVJOQUwpKVtNRU1DSEFUX1JFUFJJQ0VfSk9VUk5BTF07XG4gICAgaWYgKHJlY29yZCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIXJlY29yZCB8fCB0eXBlb2YgcmVjb3JkLm9yaWdpbiAhPT0gJ3N0cmluZycgfHwgdHlwZW9mIHJlY29yZC5zY29wZSAhPT0gJ3N0cmluZycgfHwgIXJlY29yZC5qb3VybmFsXG4gICAgICAgIHx8ICFbJ3dyaXRpbmcnLCAndmVyaWZpZWQnLCAndW5jZXJ0YWluJywgJ2ludGVycnVwdGVkJywgJ2ZhaWxlZCddLmluY2x1ZGVzKHJlY29yZC5qb3VybmFsLnN0YXR1cykpIHRocm93IEVycm9yKCfQltGD0YDQvdCw0Lsg0L3QtdC00L7RgdGC0YPQv9C10L0nKTtcbiAgICByZXR1cm4gcmVjb3JkO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXByaWNlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBhY3Rpb24gPSBtZXNzYWdlLmFjdGlvbjtcbiAgICBjb25zdCByZWZ1c2UgPSAoZXJyb3IsIHJlY292ZXJ5ID0gZmFsc2UpID0+ICh7IG9rOiBmYWxzZSwgZXJyb3IsIHJlY292ZXJ5IH0pO1xuICAgIGNvbnN0IG93bmVyID0gcmVwcmljZU93bmVyKHNlbmRlcik7XG4gICAgaWYgKCFvd25lciB8fCAhWydwcmV2aWV3JywgJ2FwcGx5JywgJ3JlY292ZXInLCAnc2V0dGluZ3MtbG9hZCcsICdzZXR0aW5ncy1zYXZlJ10uaW5jbHVkZXMoYWN0aW9uKSkge1xuICAgICAgICByZXR1cm4gcmVmdXNlKCfQl9Cw0L/RgNC+0YEg0L/QtdGA0LXQvtGG0LXQvdC60Lgg0L7RgtC60LvQvtC90ZHQvS4nKTtcbiAgICB9XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhY3Rpb24uc3RhcnRzV2l0aCgnc2V0dGluZ3MtJyk7XG4gICAgY29uc3QgY2hhbmdlc1N0YXRlID0gWydhcHBseScsICdyZWNvdmVyJywgJ3NldHRpbmdzLXNhdmUnXS5pbmNsdWRlcyhhY3Rpb24pO1xuICAgIGlmIChyZXByaWNlQnVzeSB8fCByZXByaWNlUGVuZGluZy5oYXMob3duZXIpKSByZXR1cm4gcmVmdXNlKCfQlNGA0YPQs9C+0Lkg0LfQsNC/0YDQvtGBINC/0LXRgNC10L7RhtC10L3QutC4INGD0LbQtSDQstGL0L/QvtC70L3Rj9C10YLRgdGPLicpO1xuICAgIGNvbnN0IG9yZGVySWQgPSBhY3Rpb24gPT09ICdwcmV2aWV3JyA/IHJlcHJpY2VPcmRlcklkKG1lc3NhZ2Uub3JkZXJMaW5rKSA6IG51bGw7XG4gICAgaWYgKGFjdGlvbiA9PT0gJ3ByZXZpZXcnKSB7XG4gICAgICAgIHJlcHJpY2VQcmV2aWV3cy5kZWxldGUob3duZXIpO1xuICAgICAgICBpZiAoIW9yZGVySWQpIHJldHVybiByZWZ1c2UoJ9CS0YHRgtCw0LLRjNGC0LUg0YHRgdGL0LvQutGDINC90LAg0LLQvdGD0YLRgNC10L3QvdC40Lkg0LfQsNC60LDQtyDQuNC3IG9ubGluZS5tb3lza2xhZC5ydS4nKTtcbiAgICB9XG4gICAgaWYgKGNoYW5nZXNTdGF0ZSkgcmVwcmljZUJ1c3kgPSB0cnVlO1xuICAgIHJlcHJpY2VQZW5kaW5nLmFkZChvd25lcik7XG4gICAgbGV0IGVudGVyZWRTZXJ2aWNlID0gZmFsc2U7XG4gICAgbGV0IHJ1bklkID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBjcmVkZW50aWFsID0gYXdhaXQgcmVwcmljZUFjY2VzcyhzZW5kZXIpO1xuICAgICAgICBjb25zdCBydWxlc1JlY29yZCA9IGFjdGlvbiA9PT0gJ3JlY292ZXInID8gbnVsbCA6IGF3YWl0IHJlcHJpY2VMb2FkUnVsZXMoY3JlZGVudGlhbCk7XG4gICAgICAgIGNvbnN0IHJldmlzaW9uID0gcnVsZXNSZWNvcmQ/LnJldmlzaW9uID8/IG51bGw7XG4gICAgICAgIGNvbnN0IGlzQ3VycmVudCA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGlmICghYXdhaXQgcmVwcmljZUxpdmUoc2VuZGVyLCBjcmVkZW50aWFsLm9yaWdpbikpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCByZXByaWNlQWNjZXNzKHNlbmRlcik7XG4gICAgICAgICAgICBpZiAoIXJlcHJpY2VTYW1lQWNjb3VudChjdXJyZW50LCBjcmVkZW50aWFsKSB8fCBjdXJyZW50LnRva2VuICE9PSBjcmVkZW50aWFsLnRva2VuKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBjb25zdCBsYXRlc3QgPSBhY3Rpb24gPT09ICdyZWNvdmVyJyA/IG51bGwgOiBhd2FpdCByZXByaWNlTG9hZFJ1bGVzKGN1cnJlbnQpO1xuICAgICAgICAgICAgcmV0dXJuIHJlcHJpY2VPd25lcihzZW5kZXIpID09PSBvd25lciAmJiAobGF0ZXN0Py5yZXZpc2lvbiA/PyBudWxsKSA9PT0gcmV2aXNpb25cbiAgICAgICAgICAgICAgICAmJiByZXByaWNlSm91cm5hbEpzb24obGF0ZXN0Py5ydWxlcyA/PyBudWxsKSA9PT0gcmVwcmljZUpvdXJuYWxKc29uKHJ1bGVzUmVjb3JkPy5ydWxlcyA/PyBudWxsKTtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgcmVxdWVzdCA9IGFzeW5jIChtZXRob2QsIHBhdGgsIGJvZHkpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoTUVNQ0hBVF9SRVBSSUNFX0FQSSArIHBhdGgpO1xuICAgICAgICAgICAgaWYgKHVybC5vcmlnaW4gIT09ICdodHRwczovL2FwaS5tb3lza2xhZC5ydScgfHwgIS9eXFwvYXBpXFwvcmVtYXBcXC8xXFwuMlxcLyg/OmVudGl0eXxjb250ZXh0KVxcLy8udGVzdCh1cmwucGF0aG5hbWUpIHx8IHVybC5oYXNoKSB0aHJvdyBFcnJvcignSW52YWxpZCBBUEkgcGF0aCcpO1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwZXJmb3JtUmVxdWVzdCh7IGlkOiAncmVwcmljZS0nICsgY3J5cHRvLnJhbmRvbVVVSUQoKSwgcmVxdWVzdDoge1xuICAgICAgICAgICAgICAgIHVybDogdXJsLmhyZWYsIG1ldGhvZCwgYW5vbnltb3VzOiB0cnVlLCBjcmVkZW50aWFsR3VhcmQ6IHRydWUsXG4gICAgICAgICAgICAgICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyICcgKyBjcmVkZW50aWFsLnRva2VuLCBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnLCAuLi4oYm9keSA/IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnIH0gOiB7fSkgfSxcbiAgICAgICAgICAgICAgICBkYXRhOiBib2R5ID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWRcbiAgICAgICAgICAgIH0gfSwgc2VuZGVyLCB1bmRlZmluZWQsIGlzQ3VycmVudCk7XG4gICAgICAgICAgICBpZiAocmVzcG9uc2UuZXZlbnQgIT09ICdsb2FkJyB8fCAhYXdhaXQgaXNDdXJyZW50KCkpIHRocm93IEVycm9yKCfQodC+0LXQtNC40L3QtdC90LjQtSDRgSDQnNC+0LnQodC60LvQsNC0INC/0L7RgtC10YDRj9C90L4nKTtcbiAgICAgICAgICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cztcbiAgICAgICAgICAgIGlmIChzdGF0dXMgPCAyMDAgfHwgc3RhdHVzID49IDMwMCkgeyBjb25zdCBlcnJvciA9IEVycm9yKCfQnNC+0LnQodC60LvQsNC0OiBIVFRQICcgKyBzdGF0dXMpOyBlcnJvci5zdGF0dXMgPSBzdGF0dXM7IHRocm93IGVycm9yOyB9XG4gICAgICAgICAgICByZXR1cm4gbWV0aG9kID09PSAnR0VUJyA/IEpTT04ucGFyc2UocmVzcG9uc2UucmVzcG9uc2UucmVzcG9uc2VUZXh0KSA6IHVuZGVmaW5lZDtcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XG4gICAgICAgICAgICBpZiAoYWN0aW9uID09PSAnc2V0dGluZ3MtbG9hZCcpIHtcbiAgICAgICAgICAgICAgICByZXByaWNlU2V0dGluZ3MuZGVsZXRlKG93bmVyKTtcbiAgICAgICAgICAgICAgICBjb25zdCB0eXBlcyA9IG1lbWNoYXRSZXByaWNlUHJpY2VUeXBlcyhhd2FpdCByZXF1ZXN0KCdHRVQnLCBNRU1DSEFUX1JFUFJJQ0VfUFJJQ0VfVFlQRVMpKTtcbiAgICAgICAgICAgICAgICBpZiAodHlwZXMuc2l6ZSA8IDIpIHJldHVybiByZWZ1c2UoJ9CSINCc0L7QudCh0LrQu9Cw0LQg0L3Rg9C20L3RiyDRhdC+0YLRjyDQsdGLINC00LLQsCDRgtC40L/QsCDRhtC10L0uJyk7XG4gICAgICAgICAgICAgICAgY29uc3QgaWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICAgICAgICAgICAgICAgIGlmICghcmVwcmljZVJlbWVtYmVyKHJlcHJpY2VTZXR0aW5ncywgb3duZXIsIHsgaWQsIGNyZWRlbnRpYWwsIHJldmlzaW9uLCB0eXBlcywgc291cmNlVXJsOiBzZW5kZXIudXJsIH0pKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZWZ1c2UoJ9Ch0LvQuNGI0LrQvtC8INC80L3QvtCz0L4g0L7RgtC60YDRi9GC0YvRhSDQvdCw0YHRgtGA0L7QtdC6LiDQn9C+0LLRgtC+0YDQuNGC0LUg0L/QvtC30LbQtS4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGlkLCBydWxlczogcnVsZXNSZWNvcmQ/LnJ1bGVzIHx8IE1FTUNIQVRfUkVQUklDRV9ERUZBVUxUUyxcbiAgICAgICAgICAgICAgICAgICAgcHJpY2VUeXBlczogQXJyYXkuZnJvbSh0eXBlcywgKFtpZCwgbmFtZV0pID0+ICh7IGlkLCBuYW1lIH0pKSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgb3BlbmVkID0gcmVwcmljZVNldHRpbmdzLmdldChvd25lcik7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5jb25maXJtZWQgIT09IHRydWUgfHwgIW9wZW5lZCB8fCBvcGVuZWQuaWQgIT09IG1lc3NhZ2UuaWQgfHwgb3BlbmVkLmV4cGlyZXMgPCBEYXRlLm5vdygpXG4gICAgICAgICAgICAgICAgfHwgIXJlcHJpY2VTYW1lQWNjb3VudChvcGVuZWQuY3JlZGVudGlhbCwgY3JlZGVudGlhbCkgfHwgb3BlbmVkLmNyZWRlbnRpYWwudG9rZW4gIT09IGNyZWRlbnRpYWwudG9rZW5cbiAgICAgICAgICAgICAgICB8fCBvcGVuZWQucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IG9wZW5lZC5zb3VyY2VVcmwgIT09IHNlbmRlci51cmwpIHJldHVybiByZWZ1c2UoJ9Cd0LDRgdGC0YDQvtC50LrQuCDRg9GB0YLQsNGA0LXQu9C4LiDQl9Cw0LPRgNGD0LfQuNGC0LUg0YLQuNC/0Ysg0YbQtdC9INC30LDQvdC+0LLQvi4nKTtcbiAgICAgICAgICAgIGNvbnN0IHsgYmFzZVR5cGVJZCwgdGFyZ2V0VHlwZUlkIH0gPSBtZXNzYWdlLnJ1bGVzID8/IHt9O1xuICAgICAgICAgICAgaWYgKCFvcGVuZWQudHlwZXMuaGFzKGJhc2VUeXBlSWQpIHx8ICFvcGVuZWQudHlwZXMuaGFzKHRhcmdldFR5cGVJZCkgfHwgYmFzZVR5cGVJZCA9PT0gdGFyZ2V0VHlwZUlkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzZSgn0JLRi9Cx0LXRgNC40YLQtSDQtNCy0LAg0YDQsNC30L3Ri9GFINGC0LjQv9CwINGG0LXQvSDQuNC3INGB0L/RgNCw0LLQvtGH0L3QuNC60LAuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgZm9ybXVsYTtcbiAgICAgICAgICAgIHRyeSB7IGZvcm11bGEgPSBtZW1jaGF0UmVwcmljZUZvcm11bGEobWVzc2FnZS5ydWxlcyk7IH0gY2F0Y2ggKGVycm9yKSB7IHJldHVybiByZWZ1c2UoZXJyb3IubWVzc2FnZSk7IH1cbiAgICAgICAgICAgIGNvbnN0IHJ1bGVzID0geyBiYXNlVHlwZUlkLCBiYXNlVHlwZU5hbWU6IG9wZW5lZC50eXBlcy5nZXQoYmFzZVR5cGVJZCksIHRhcmdldFR5cGVJZCxcbiAgICAgICAgICAgICAgICB0YXJnZXRUeXBlTmFtZTogb3BlbmVkLnR5cGVzLmdldCh0YXJnZXRUeXBlSWQpLCAuLi5mb3JtdWxhIH07XG4gICAgICAgICAgICBjb25zdCBrZXkgPSByZXByaWNlUnVsZXNLZXkoY3JlZGVudGlhbC5vcmlnaW4pO1xuICAgICAgICAgICAgY29uc3QgZXhwZWN0ZWQgPSB7IHNjb3BlOiBjcmVkZW50aWFsLnNjb3BlLCByZXZpc2lvbjogY3J5cHRvLnJhbmRvbVVVSUQoKSwgcnVsZXMgfTtcbiAgICAgICAgICAgIGlmICghYXdhaXQgaXNDdXJyZW50KCkpIHJldHVybiByZWZ1c2UoJ9Cd0LDRgdGC0YDQvtC50LrQuCDRg9GB0YLQsNGA0LXQu9C4LiDQl9Cw0LPRgNGD0LfQuNGC0LUg0YLQuNC/0Ysg0YbQtdC9INC30LDQvdC+0LLQvi4nKTtcbiAgICAgICAgICAgIHJlcHJpY2VTZXR0aW5ncy5kZWxldGUob3duZXIpO1xuICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW2tleV06IGV4cGVjdGVkIH0pO1xuICAgICAgICAgICAgaWYgKHJlcHJpY2VKb3VybmFsSnNvbigoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV0pICE9PSByZXByaWNlSm91cm5hbEpzb24oZXhwZWN0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzZSgn0KHQvtGF0YDQsNC90LXQvdC40LUg0L/RgNCw0LLQuNC7INC90LUg0L/QvtC00YLQstC10YDQttC00LXQvdC+LiDQntGC0LrRgNC+0LnRgtC1INC90LDRgdGC0YDQvtC50LrQuCDQt9Cw0L3QvtCy0L4uJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcnVsZXMgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzYXZlZCA9IGF3YWl0IHJlcHJpY2VMb2FkSm91cm5hbCgpO1xuICAgICAgICBjb25zdCB1bmZpbmlzaGVkID0gcmVwcmljZVVuZmluaXNoZWQoc2F2ZWQpO1xuICAgICAgICBpZiAodW5maW5pc2hlZCAmJiAhcmVwcmljZVNhbWVBY2NvdW50KHNhdmVkLCBjcmVkZW50aWFsKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZnVzZSgn0JXRgdGC0Ywg0L3QtdC30LDQstC10YDRiNGR0L3QvdCw0Y8g0L/QtdGA0LXQvtGG0LXQvdC60LAuINCU0LvRjyDQv9GA0L7QstC10YDQutC4INC90YPQttC10L0g0L/RgNC10LbQvdC40Lkg0L/RgNC+0YTQuNC70YwgQmVhcmVyLicpO1xuICAgICAgICB9XG4gICAgICAgIGlmICh1bmZpbmlzaGVkICYmIGFjdGlvbiAhPT0gJ3JlY292ZXInKSByZXR1cm4gcmVmdXNlKCfQndC10LfQsNCy0LXRgNGI0ZHQvdC90LDRjyDQv9C10YDQtdC+0YbQtdC90LrQsC4g0KHQvdCw0YfQsNC70LAg0L/RgNC+0LLQtdGA0YzRgtC1INC30LDQv9C40YHRjCDQsiDQnNC+0LnQodC60LvQsNC0LicsIHRydWUpO1xuICAgICAgICBpZiAoYWN0aW9uID09PSAncmVjb3ZlcicgJiYgIXVuZmluaXNoZWQpIHJldHVybiB7IG9rOiB0cnVlLCBzdGF0dXM6ICdub25lJywgdmVyaWZpZWQ6IDAgfTtcbiAgICAgICAgaWYgKGFjdGlvbiAhPT0gJ3JlY292ZXInICYmICFydWxlc1JlY29yZCkgcmV0dXJuIHJlZnVzZSgn0JLRi9Cx0LXRgNC40YLQtSDQuCDRgdC+0YXRgNCw0L3QuNGC0LUg0YLQuNC/0Ysg0YbQtdC9INCyINC90LDRgdGC0YDQvtC50LrQsNGFINC/0LXRgNC10L7RhtC10L3QutC4LicpO1xuICAgICAgICBjb25zdCBwcmV2aWV3ID0gYWN0aW9uID09PSAnYXBwbHknID8gcmVwcmljZVByZXZpZXdzLmdldChvd25lcikgOiBudWxsO1xuICAgICAgICBpZiAoYWN0aW9uID09PSAnYXBwbHknICYmIChtZXNzYWdlLmNvbmZpcm1lZCAhPT0gdHJ1ZSB8fCAhcHJldmlldyB8fCBtZXNzYWdlLmlkICE9PSBwcmV2aWV3LmlkIHx8IHByZXZpZXcuZXhwaXJlcyA8IERhdGUubm93KClcbiAgICAgICAgICAgIHx8ICFyZXByaWNlU2FtZUFjY291bnQocHJldmlldy5jcmVkZW50aWFsLCBjcmVkZW50aWFsKSB8fCBwcmV2aWV3LmNyZWRlbnRpYWwudG9rZW4gIT09IGNyZWRlbnRpYWwudG9rZW5cbiAgICAgICAgICAgIHx8IHByZXZpZXcucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IHByZXZpZXcuc291cmNlVXJsICE9PSBzZW5kZXIudXJsXG4gICAgICAgICAgICB8fCByZXByaWNlSm91cm5hbEpzb24ocHJldmlldy5ydWxlcykgIT09IHJlcHJpY2VKb3VybmFsSnNvbihydWxlc1JlY29yZC5ydWxlcykpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmdXNlKCfQn9GA0LXQtNC/0YDQvtGB0LzQvtGC0YAg0YPRgdGC0LDRgNC10Lsg0LjQu9C4INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvS4g0JfQsNCz0YDRg9C30LjRgtC1INC10LPQviDRgdC90L7QstCwLicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNvbmZpZyA9IGFjdGlvbiA9PT0gJ3JlY292ZXInID8gcmVwcmljZVJlY292ZXJ5Q29uZmlnKHNhdmVkKSA6IHsgLi4ucnVsZXNSZWNvcmQucnVsZXMsIG9yZGVySWQ6IG9yZGVySWQgfHwgcHJldmlldy5vcmRlcklkIH07XG4gICAgICAgIGNvbnN0IHJlYWQgPSBwYXRoID0+IHJlcXVlc3QoJ0dFVCcsIHBhdGgpO1xuICAgICAgICBydW5JZCA9IGFjdGlvbiA9PT0gJ3JlY292ZXInID8gc2F2ZWQucnVuIDogY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICAgICAgbGV0IGR1cmFibGVJbnRlbnQgPSBudWxsO1xuICAgICAgICBjb25zdCBwZXJzaXN0ID0gYXN5bmMgam91cm5hbCA9PiB7XG4gICAgICAgICAgICBjb25zdCBleHBlY3RlZCA9IHsgb3JpZ2luOiBjcmVkZW50aWFsLm9yaWdpbiwgc2NvcGU6IGNyZWRlbnRpYWwuc2NvcGUsIGNvbmZpZywgcnVuOiBydW5JZCwgam91cm5hbCB9O1xuICAgICAgICAgICAgY29uc3QgZW5jb2RlZCA9IHJlcHJpY2VKb3VybmFsSnNvbihleHBlY3RlZCk7XG4gICAgICAgICAgICBpZiAoZW5jb2RlZC5sZW5ndGggPiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ9CW0YPRgNC90LDQuyDRgdC70LjRiNC60L7QvCDQsdC+0LvRjNGI0L7QuScpO1xuICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW01FTUNIQVRfUkVQUklDRV9KT1VSTkFMXTogSlNPTi5wYXJzZShlbmNvZGVkKSB9KTtcbiAgICAgICAgICAgIGNvbnN0IGNvbW1pdHRlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTUVNQ0hBVF9SRVBSSUNFX0pPVVJOQUwpKVtNRU1DSEFUX1JFUFJJQ0VfSk9VUk5BTF07XG4gICAgICAgICAgICBpZiAocmVwcmljZUpvdXJuYWxKc29uKGNvbW1pdHRlZCkgIT09IGVuY29kZWQpIHRocm93IEVycm9yKCfQltGD0YDQvdCw0Lsg0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTRkdC9Jyk7XG4gICAgICAgICAgICBkdXJhYmxlSW50ZW50ID0gam91cm5hbC5pbnRlbnQgPyB7IHBhdGg6IGpvdXJuYWwuaW50ZW50LnBhdGgsIHZhbHVlOiBqb3VybmFsLmludGVudC5uZXcgfSA6IG51bGw7XG4gICAgICAgICAgICByZXR1cm4gY29tbWl0dGVkLmpvdXJuYWw7XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHNlcnZpY2UgPSBjcmVhdGVNZW1jaGF0UmVwcmljZVNlcnZpY2UoY29uZmlnKTtcbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3ByZXZpZXcnKSB7XG4gICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgc2VydmljZS5wbGFuKHJlYWQpO1xuICAgICAgICAgICAgaWYgKGRhdGEuZW50cmllcy5sZW5ndGggKyBkYXRhLnNraXBwZWQubGVuZ3RoID4gNTAwKSByZXR1cm4gcmVmdXNlKCfQkiDQt9Cw0LrQsNC30LUg0LHQvtC70YzRiNC1IDUwMCDQutCw0YDRgtC+0YfQtdC6LiDQn9C10YDQtdC+0YbQtdC90LrQsCDQvdC1INC30LDQv9GD0YnQtdC90LAuJyk7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IGlzQ3VycmVudCgpIHx8IHJlcHJpY2VCdXN5KSByZXR1cm4gcmVmdXNlKCfQn9C70LDQvSDRg9GB0YLQsNGA0LXQuy4g0J7QsdC90L7QstC40YLQtSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YAuJyk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgICAgICAgICBpZiAoIXJlcHJpY2VSZW1lbWJlcihyZXByaWNlUHJldmlld3MsIG93bmVyLCB7IGlkLCBkYXRhLCBjcmVkZW50aWFsLCBvcmRlcklkLCByZXZpc2lvbiwgcnVsZXM6IHJ1bGVzUmVjb3JkLnJ1bGVzLCBzb3VyY2VVcmw6IHNlbmRlci51cmwgfSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVmdXNlKCfQodC70LjRiNC60L7QvCDQvNC90L7Qs9C+INCw0LrRgtC40LLQvdGL0YUg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGA0L7Qsi4g0J/QvtCy0YLQvtGA0LjRgtC1INGH0LXRgNC10Lcg0L3QtdGB0LrQvtC70YzQutC+INC80LjQvdGD0YIuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaWQsIG9yZGVyTmFtZTogZGF0YS5vcmRlck5hbWUsIGJhc2VOYW1lOiBjb25maWcuYmFzZVR5cGVOYW1lLCB0YXJnZXROYW1lOiBjb25maWcudGFyZ2V0VHlwZU5hbWUsXG4gICAgICAgICAgICAgICAgZW50cmllczogZGF0YS5lbnRyaWVzLm1hcCgoeyBpZCwgbmFtZSwgYmFzZSwgb2xkLCBuZXc6IG5leHQgfSkgPT4gKHsgaWQsIG5hbWUsIGJhc2UsIG9sZCwgbmV4dCB9KSksIHNraXBwZWQ6IGRhdGEuc2tpcHBlZCB9O1xuICAgICAgICB9XG4gICAgICAgIGlmICghYXdhaXQgaXNDdXJyZW50KCkpIHJldHVybiByZWZ1c2UoJ9CU0L7QutGD0LzQtdC90YIg0LjQu9C4INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LjQu9C40YHRjC4g0J/QvtCy0YLQvtGA0LjRgtC1INC/0YDQvtCy0LXRgNC60YMuJywgdW5maW5pc2hlZCk7XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdyZWNvdmVyJykge1xuICAgICAgICAgICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHNlcnZpY2UucmVjb25jaWxlKHNhdmVkLmpvdXJuYWwsIHsgcmVhZCwgcGVyc2lzdCB9KTtcbiAgICAgICAgICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHJlcHJpY2VMb2FkSm91cm5hbCgpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHN0YXR1czogbGF0ZXN0Py5qb3VybmFsLnN0YXR1cyB8fCBvdXRjb21lPy5zdGF0dXMsIHZlcmlmaWVkOiBsYXRlc3Q/LmpvdXJuYWwudmVyaWZpZWQgfHwgMCxcbiAgICAgICAgICAgICAgICByZWNvdmVyeTogcmVwcmljZVVuZmluaXNoZWQobGF0ZXN0KSB9O1xuICAgICAgICB9XG4gICAgICAgIHJlcHJpY2VQcmV2aWV3cy5kZWxldGUob3duZXIpO1xuICAgICAgICBjb25zdCBjaGFuZ2VzID0gbmV3IE1hcChwcmV2aWV3LmRhdGEuZW50cmllcy5maWx0ZXIoZW50cnkgPT4gZW50cnkubmV3ICE9PSBlbnRyeS5vbGQpXG4gICAgICAgICAgICAubWFwKGVudHJ5ID0+IFsnL2VudGl0eS9wcm9kdWN0LycgKyBlbnRyeS5pZCwgZW50cnkubmV3XSkpO1xuICAgICAgICBpZiAoIWNoYW5nZXMuc2l6ZSkgcmV0dXJuIHJlZnVzZSgn0JIg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGA0LUg0L3QtdGCINC40LfQvNC10L3QtdC90LjQuS4nKTtcbiAgICAgICAgY29uc3Qgd3JpdGUgPSAocGF0aCwgYm9keSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgbGluZSA9IGJvZHk/LnNhbGVQcmljZXM/LlswXTtcbiAgICAgICAgICAgIGlmICghL15cXC9lbnRpdHlcXC9wcm9kdWN0XFwvW2EtZjAtOS1dezM2fSQvaS50ZXN0KHBhdGgpIHx8ICFjaGFuZ2VzLmhhcyhwYXRoKVxuICAgICAgICAgICAgICAgIHx8IGR1cmFibGVJbnRlbnQ/LnBhdGggIT09IHBhdGggfHwgZHVyYWJsZUludGVudC52YWx1ZSAhPT0gbGluZT8udmFsdWVcbiAgICAgICAgICAgICAgICB8fCBPYmplY3Qua2V5cyhib2R5IHx8IHt9KS5sZW5ndGggIT09IDEgfHwgIUFycmF5LmlzQXJyYXkoYm9keS5zYWxlUHJpY2VzKSB8fCBib2R5LnNhbGVQcmljZXMubGVuZ3RoICE9PSAxXG4gICAgICAgICAgICAgICAgfHwgT2JqZWN0LmtleXMobGluZSB8fCB7fSkubGVuZ3RoICE9PSAzIHx8IGxpbmUudmFsdWUgIT09IGNoYW5nZXMuZ2V0KHBhdGgpXG4gICAgICAgICAgICAgICAgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGxpbmUudmFsdWUpIHx8IGxpbmUudmFsdWUgPD0gMFxuICAgICAgICAgICAgICAgIHx8IGxpbmUucHJpY2VUeXBlPy5tZXRhPy5ocmVmICE9PSAnaHR0cHM6Ly9hcGkubW95c2tsYWQucnUvYXBpL3JlbWFwLzEuMi9jb250ZXh0L2NvbXBhbnlzZXR0aW5ncy9wcmljZXR5cGUvJyArIGNvbmZpZy50YXJnZXRUeXBlSWRcbiAgICAgICAgICAgICAgICB8fCAhL15odHRwczpcXC9cXC9hcGlcXC5tb3lza2xhZFxcLnJ1XFwvYXBpXFwvcmVtYXBcXC8xXFwuMlxcL2VudGl0eVxcL2N1cnJlbmN5XFwvW2EtZjAtOS1dezM2fSQvaS50ZXN0KGxpbmUuY3VycmVuY3k/Lm1ldGE/LmhyZWYpKSB0aHJvdyBFcnJvcign0J3QtdC00L7Qv9GD0YHRgtC40LzQsNGPINC30LDQv9C40YHRjCDRhtC10L3QvdC40LrQsCcpO1xuICAgICAgICAgICAgY2hhbmdlcy5kZWxldGUocGF0aCk7IC8vIE5vIHNlY29uZCBQVVQgZXZlbiBpZiBpdHMgZmlyc3QgcmVzcG9uc2UgaXMgYW1iaWd1b3VzLlxuICAgICAgICAgICAgZHVyYWJsZUludGVudCA9IG51bGw7XG4gICAgICAgICAgICByZXR1cm4gcmVxdWVzdCgnUFVUJywgcGF0aCwgYm9keSk7XG4gICAgICAgIH07XG4gICAgICAgIGVudGVyZWRTZXJ2aWNlID0gdHJ1ZTtcbiAgICAgICAgY29uc3Qgam91cm5hbCA9IGF3YWl0IHNlcnZpY2UuYXBwbHkocHJldmlldy5kYXRhLCB7IHJlYWQsIHdyaXRlLCBwZXJzaXN0IH0pO1xuICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCByZXByaWNlTG9hZEpvdXJuYWwoKTtcbiAgICAgICAgY29uc3QgcmVjb3ZlcnkgPSByZXByaWNlVW5maW5pc2hlZChzdG9yZWQpO1xuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGpvdXJuYWwudmVyaWZpZWQ7XG4gICAgICAgIGNvbnN0IGVycm9yID0gcmVjb3ZlcnkgPyAn0JfQsNC/0YPRgdC6INC90LUg0LfQsNCy0LXRgNGI0ZHQvS4g0J/RgNC+0LLQtdGA0YzRgtC1INC90LXQt9Cw0LLQtdGA0YjRkdC90L3Rg9GOINC30LDQv9C40YHRjCDQsiDQnNC+0LnQodC60LvQsNC0LidcbiAgICAgICAgICAgIDogam91cm5hbC5lcnJvciA9PT0gJ3N0YWxlLXByZXZpZXcnID8gJ9Cf0LvQsNC9INC40LfQvNC10L3QuNC70YHRjy4g0JfQsNCz0YDRg9C30LjRgtC1INC90L7QstGL0Lkg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGALidcbiAgICAgICAgICAgICAgICA6IHZlcmlmaWVkID8gYNCf0LXRgNC10L7RhtC10L3QutCwINC+0YHRgtCw0L3QvtCy0LvQtdC90LAuINCh0LLQtdGA0LXQvdC+INC00L4g0L7RgdGC0LDQvdC+0LLQutC4OiAke3ZlcmlmaWVkfS4g0JfQsNCz0YDRg9C30LjRgtC1INGB0LLQtdC20LjQuSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YAuYFxuICAgICAgICAgICAgICAgICAgICA6ICfQn9C10YDQtdC+0YbQtdC90LrQsCDQvdC1INC30LDQstC10YDRiNC10L3QsC4g0J/RgNC+0LLQtdGA0YzRgtC1INC00LDQvdC90YvQtSDQuCDQtNC+0YHRgtGD0L8g0JzQvtC50KHQutC70LDQtC4nO1xuICAgICAgICByZXR1cm4geyBvazogam91cm5hbC5zdGF0dXMgPT09ICd2ZXJpZmllZCcsIHN0YXR1czogam91cm5hbC5zdGF0dXMsIHZlcmlmaWVkOiBqb3VybmFsLnZlcmlmaWVkLFxuICAgICAgICAgICAgY2hlY2tlZDogam91cm5hbC5jaGVja2VkLCBjaGFuZ2VkOiBqb3VybmFsLmNoYW5nZWQsIHJlY292ZXJ5LFxuICAgICAgICAgICAgLi4uKGpvdXJuYWwuc3RhdHVzID09PSAndmVyaWZpZWQnID8ge30gOiB7IGVycm9yIH0pIH07XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKHNldHRpbmdzKSByZXR1cm4gcmVmdXNlKE51bWJlci5pc0ludGVnZXIoZXJyb3I/LnN0YXR1cykgPyAn0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgZXJyb3Iuc3RhdHVzICsgJy4g0J/RgNC+0LLQtdGA0YzRgtC1INC00L7RgdGC0YPQvyBCZWFyZXIuJ1xuICAgICAgICAgICAgOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDQt9Cw0LPRgNGD0LfQuNGC0Ywg0LjQu9C4INGB0L7RhdGA0LDQvdC40YLRjCDQv9GA0LDQstC40LvQsC4g0J/RgNC+0LLQtdGA0YzRgtC1INC00L7RgdGC0YPQvyBCZWFyZXIg0Lgg0L7RgtC60YDQvtC50YLQtSDQvdCw0YHRgtGA0L7QudC60Lgg0LfQsNC90L7QstC+LicpO1xuICAgICAgICBjb25zdCBzYXZlZCA9IGF3YWl0IHJlcHJpY2VMb2FkSm91cm5hbCgpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgICAgICBjb25zdCB1bnJlc29sdmVkID0gcmVwcmljZVVuZmluaXNoZWQoc2F2ZWQpO1xuICAgICAgICBjb25zdCBwYXJ0aWFsID0gZW50ZXJlZFNlcnZpY2UgJiYgc2F2ZWQ/LnJ1biA9PT0gcnVuSWQgJiYgc2F2ZWQuam91cm5hbC52ZXJpZmllZCA+IDA7XG4gICAgICAgIGNvbnN0IHN0YXR1cyA9IGVycm9yPy5zdGF0dXM7XG4gICAgICAgIHJldHVybiB7IC4uLnJlZnVzZSh1bnJlc29sdmVkID8gJ9CX0LDQv9GD0YHQuiDQvdC1INC30LDQstC10YDRiNGR0L0uINCf0LXRgNC10LQg0L/QvtCy0YLQvtGA0L7QvCDQv9GA0L7QstC10YDRjNGC0LUg0LbRg9GA0L3QsNC7OiDRh9Cw0YHRgtGMINGG0LXQvSDQvNC+0LPQu9CwINC40LfQvNC10L3QuNGC0YzRgdGPLidcbiAgICAgICAgICAgIDogcGFydGlhbCA/ICfQn9C10YDQtdC+0YbQtdC90LrQsCDQstGL0L/QvtC70L3QtdC90LAg0YfQsNGB0YLQuNGH0L3Qvi4g0JfQsNCz0YDRg9C30LjRgtC1INGB0LLQtdC20LjQuSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YAuJ1xuICAgICAgICAgICAgICAgIDogZXJyb3I/LmNvZGUgPT09ICdwcmljZXR5cGUtY29udGV4dCcgPyAn0KLQuNC/INGG0LXQvdGLINC40LfQvNC10L3QuNC70YHRjy4g0J7RgtC60YDQvtC50YLQtSDQuCDRgdC+0YXRgNCw0L3QuNGC0LUg0L3QsNGB0YLRgNC+0LnQutC4INC/0LXRgNC10L7RhtC10L3QutC4INC30LDQvdC+0LLQvi4nXG4gICAgICAgICAgICAgICAgOiBOdW1iZXIuaXNJbnRlZ2VyKHN0YXR1cykgPyAn0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgc3RhdHVzICsgJy4g0J/RgNC+0LLQtdGA0YzRgtC1INC00L7RgdGC0YPQvyDQuCDQv9C70LDQvS4nXG4gICAgICAgICAgICAgICAgOiBlbnRlcmVkU2VydmljZSA/ICfQn9C70LDQvSDRg9GB0YLQsNGA0LXQuyDQuNC70Lgg0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTRkdC9LiDQl9Cw0LPRgNGD0LfQuNGC0LUg0L3QvtCy0YvQuSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YAuJ1xuICAgICAgICAgICAgICAgICAgICA6ICfQndC1INGD0LTQsNC70L7RgdGMINC/0YDQvtCy0LXRgNC40YLRjCDQt9Cw0LrQsNC3LCBCZWFyZXIg0LjQu9C4INC20YPRgNC90LDQuyDQv9C10YDQtdC+0YbQtdC90LrQuC4nLCB1bnJlc29sdmVkIHx8IGVudGVyZWRTZXJ2aWNlKSxcbiAgICAgICAgICAgIC4uLih1bnJlc29sdmVkIHx8IHBhcnRpYWwgPyB7IHZlcmlmaWVkOiBzYXZlZD8uam91cm5hbD8udmVyaWZpZWQgfHwgMCB9IDoge30pIH07XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcmVwcmljZVBlbmRpbmcuZGVsZXRlKG93bmVyKTtcbiAgICAgICAgaWYgKGNoYW5nZXNTdGF0ZSkgcmVwcmljZUJ1c3kgPSBmYWxzZTtcbiAgICB9XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbi8vIFRoZSBwYW5lbCBpcyBhIHZlcmlmaWVkIFNJREVfUEFORUwgZG9jdW1lbnQ7IGl0IGhhcyBubyB0YWIgYW5kIG5vIHN1YmZyYW1lLlxuZnVuY3Rpb24gZGVidWdQYW5lbFNlbmRlcihzZW5kZXIpIHtcbiAgICByZXR1cm4gc2VuZGVyPy5pZCA9PT0gY2hyb21lLnJ1bnRpbWUuaWQgJiYgIXNlbmRlci50YWJcbiAgICAgICAgJiYgKHNlbmRlci5mcmFtZUlkID09PSB1bmRlZmluZWQgfHwgc2VuZGVyLmZyYW1lSWQgPT09IDApXG4gICAgICAgICYmIG5hdGl2ZURvY3VtZW50VXJsKHNlbmRlci51cmwsICdwYW5lbCcsICdzaWRlYmFyJyk7XG59XG5mdW5jdGlvbiBkZWJ1Z1dvcmxkRm9yKHNlbmRlciwgcGFuZWwpIHtcbiAgICBpZiAocGFuZWwpIHJldHVybiAncGFuZWwnO1xuICAgIGlmICh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSByZXR1cm4gJ2NvbnRlbnQnO1xuICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSByZXR1cm4gJ3J1bnRpbWUnO1xuICAgIHJldHVybiAnd29ya2VyJztcbn1cbmFzeW5jIGZ1bmN0aW9uIGRlYnVnTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIsIHBhbmVsKSB7XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6ZGVidWctZmxhZycpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBtZXNzYWdlLmVuYWJsZWQgIT09ICdib29sZWFuJykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQttGD0YDQvdCw0Lsg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH07XG4gICAgICAgIC8vIG1lbWNoYXREZWJ1Z1NldEVuYWJsZWQgcmV0dXJucyB3aGV0aGVyIHRoZSB3cml0ZSB2ZXJpZmllZCwgbm90IHRoZSB2YWx1ZS5cbiAgICAgICAgLy8gUmVhZCB0aGUgcGVyc2lzdGVkIGZsYWcgYmFjayBzbyB0dXJuaW5nIHRoZSBsb2cgT0ZGIGlzIGFsc28gY29uZmlybWVkLlxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IG1lbWNoYXREZWJ1Z1NldEVuYWJsZWQobWVzc2FnZS5lbmFibGVkKTtcbiAgICAgICAgY29uc3QgZW5hYmxlZCA9IGF3YWl0IG1lbWNoYXREZWJ1Z0VuYWJsZWQoKTtcbiAgICAgICAgcmV0dXJuIHZlcmlmaWVkICYmIGVuYWJsZWQgPT09IG1lc3NhZ2UuZW5hYmxlZFxuICAgICAgICAgICAgPyB7IG9rOiB0cnVlLCBlbmFibGVkIH1cbiAgICAgICAgICAgIDogeyBvazogZmFsc2UsIGVycm9yOiAn0KTQu9Cw0LMg0LbRg9GA0L3QsNC70LAg0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTRkdC9JyB9O1xuICAgIH1cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpkZWJ1Zy1yZWFkJykge1xuICAgICAgICBpZiAobWVzc2FnZS5saW1pdCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLmxpbWl0KSB8fCBtZXNzYWdlLmxpbWl0IDwgMVxuICAgICAgICAgICAgfHwgbWVzc2FnZS5saW1pdCA+IE1FTUNIQVRfREVCVUdfTE9HX0xJTUlUKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQttGD0YDQvdCw0Lsg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH07XG4gICAgICAgIHJldHVybiBtZW1jaGF0RGVidWdSZWFkKHsgbGltaXQ6IG1lc3NhZ2UubGltaXQgfSk7XG4gICAgfVxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OmRlYnVnLWNsZWFyJykgcmV0dXJuIG1lbWNoYXREZWJ1Z0NsZWFyKCk7XG4gICAgLy8gVGhlIHdvcmxkIGlzIGRlcml2ZWQgZnJvbSB0aGUgYXV0aGVudGljYXRlZCBzZW5kZXIsIG5ldmVyIHRydXN0ZWQgZnJvbSB0aGVcbiAgICAvLyBwYXlsb2FkOiBhIGNvbnRlbnQgd29ybGQgY2Fubm90IGNsYWltIHRvIGJlIHRoZSBwYW5lbCBvciB0aGUgd29ya2VyLlxuICAgIGlmICghTUVNQ0hBVF9ERUJVR19MRVZFTFMuaW5jbHVkZXMobWVzc2FnZS5sZXZlbClcbiAgICAgICAgfHwgdHlwZW9mIG1lc3NhZ2Uuc2NvcGUgIT09ICdzdHJpbmcnIHx8ICEvXlthLXowLTk6LV17MSw2NH0kLy50ZXN0KG1lc3NhZ2Uuc2NvcGUpXG4gICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmV2ZW50ICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLmV2ZW50Lmxlbmd0aCA8IDEgfHwgbWVzc2FnZS5ldmVudC5sZW5ndGggPiAyMDBcbiAgICAgICAgfHwgKG1lc3NhZ2Uud29ybGQgIT09IHVuZGVmaW5lZCAmJiAhTUVNQ0hBVF9ERUJVR19XT1JMRFMuaW5jbHVkZXMobWVzc2FnZS53b3JsZCkpKSB7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LbRg9GA0L3QsNC7INGA0LDRgdGI0LjRgNC10L3QuNGPJyB9O1xuICAgIH1cbiAgICBhd2FpdCBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogbWVzc2FnZS5sZXZlbCwgc2NvcGU6IG1lc3NhZ2Uuc2NvcGUsIGV2ZW50OiBtZXNzYWdlLmV2ZW50LCBkZXRhaWw6IG1lc3NhZ2UuZGV0YWlsIH0sXG4gICAgICAgIGRlYnVnV29ybGRGb3Ioc2VuZGVyLCBwYW5lbCkpO1xuICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG59XG5cbmZ1bmN0aW9uIGV4dGVuc2lvbkhhbmRsZU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpIHtcbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6Y2hhdC1ldmVudCcpIHJldHVybiBzaWRlYmFySGlzdG9yeU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpO1xuICAgIGlmIChbJ21lbWNoYXQ6cmVwcmljZScsICdtZW1jaGF0OnNhbGVzLXNldHRpbmdzLWdldCcsICdtZW1jaGF0OnNhbGVzLXNldHRpbmdzLXNhdmUnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBpZiAoISh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpKSB7XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINC/0LXRgNC10L7RhtC10L3QutC4INC+0YLQutC70L7QvdGR0L0uJyB9KTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvcGVyYXRpb24gPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnJlcHJpY2UnID8gcmVwcmljZU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKSA6IHNhbGVzU2V0dGluZ3NNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcik7XG4gICAgICAgIG9wZXJhdGlvbi50aGVuKHNlbmRSZXNwb25zZSxcbiAgICAgICAgICAgICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQn9C10YDQtdC+0YbQtdC90LrQsCDQvdC10LTQvtGB0YLRg9C/0L3QsC4nLCByZWNvdmVyeTogdHJ1ZSB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0OmRlYnVnLWxvZycsICdtZW1jaGF0OmRlYnVnLXJlYWQnLCAnbWVtY2hhdDpkZWJ1Zy1jbGVhcicsICdtZW1jaGF0OmRlYnVnLWZsYWcnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBjb25zdCBwYW5lbCA9IGRlYnVnUGFuZWxTZW5kZXIoc2VuZGVyKTtcbiAgICAgICAgLy8gVGhlIHZlcmJvc2UtbG9nIHN3aXRjaCBsaXZlcyBpbiB0aGUgc2V0dGluZ3Mgd2luZG93LCB3aGljaCBpcyByZW5kZXJlZCBieVxuICAgICAgICAvLyBvdXIgb3duIGNvbnRlbnQgc2NyaXB0IChvciB0aGUgbmF0aXZlIHJ1bnRpbWUpLCBub3QgYnkgdGhlIHBhbmVsIGRvY3VtZW50LlxuICAgICAgICAvLyBBIHBhZ2UgY2Fubm90IGZvcmdlIGFueSBvZiB0aGVzZSBzZW5kZXJzOiBzZW5kZXIuaWQgbXVzdCBiZSBvdXIgZXh0ZW5zaW9uLlxuICAgICAgICBjb25zdCB0cnVzdGVkID0gcGFuZWwgfHwgdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpO1xuICAgICAgICBpZiAoIXRydXN0ZWQpIHtcbiAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgZGVidWdNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgcGFuZWwpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CW0YPRgNC90LDQuyDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpuYXRpdmUtZHJhZnQtcmVhZCcsICdtZW1jaGF0Om5hdGl2ZS1kcmFmdC13cml0ZSddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgbmF0aXZlRHJhZnRNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikudGhlbihzZW5kUmVzcG9uc2UsICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQp9C10YDQvdC+0LLQuNC6INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvS4g0J3QtSDQt9Cw0LrRgNGL0LLQsNC50YLQtSDQv9Cw0L3QtdC70YwuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLXRlc3Qtc291bmQnKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIG9yZGVyUGxheUF1ZGlvKCkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9JyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2UtaW5pdCcsICdtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnLCAnbWVtY2hhdDpzdG9yYWdlLXBydW5lJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGF0YDQsNC90LjQu9C40YnQsCDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CU0LDQvdC90YvQtSDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNC10L3RiyDRhdGA0LDQvdC40LvQuNGJ0LXQvC4g0J3QtSDQt9Cw0LrRgNGL0LLQsNC50YLQtSDQuCDQvdC1INC/0LXRgNC10LfQsNCz0YDRg9C20LDQudGC0LUg0LLQutC70LDQtNC60YMuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnLCAnbWVtY2hhdDpvcmRlcnMtcG9sbCcsICdtZW1jaGF0Om9yZGVycy1zdG9wJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgY29uc3Qgd29yayA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgICAgICAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSAmJiBtZXNzYWdlLnR5cGUgIT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJ1xuICAgICAgICAgICAgICAgICYmICFhd2FpdCBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgJ0JlYXJlciAnICsgbWVzc2FnZS50b2tlbikpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQo9GH0ZHRgtC90YvQtSDQtNCw0L3QvdGL0LUg0LjQt9C80LXQvdC10L3Riy4g0J/QvtC00YLQstC10YDQtNC40YLQtSDQutC70Y7Rhy4nIH07XG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtY29uZmlndXJlJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yZGVyTXV0YXRlKCgpID0+IGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpKTtcbiAgICAgICAgICAgICAgICBjb25zdCBuYXRpdmUgPSBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5nZXQoc2VuZGVyKTtcbiAgICAgICAgICAgICAgICBpZiAobmF0aXZlICYmIHJlc3VsdC5vaykgeyBuYXRpdmUub3JkZXJUb2tlbiA9IG1lc3NhZ2UudG9rZW47IG5hdGl2ZS5vcmRlclJldmlzaW9uID0gcmVzdWx0LnJldmlzaW9uOyB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJykgcmV0dXJuIG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICAgICAgICAgICAgICBvcmRlckNvbmZpZy5zZXR0aW5ncy5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiArK29yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9yZGVyUHVibGljQ29uZmlnKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyQ29uZmlnQ2hhaW47XG4gICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgcmV0dXJuIHBvbGxPcmRlcnMoKTtcbiAgICAgICAgfTtcbiAgICAgICAgd29yaygpLnRoZW4oc2VuZFJlc3BvbnNlLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvdCw0YHRgtGA0L7QuNGC0Ywg0YTQvtC90L7QstGL0Lkg0L7Qv9GA0L7RgScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0OnBhbmVsLWNzcmYnKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgfHwgKG1lc3NhZ2UuZm9yY2UgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgbWVzc2FnZS5mb3JjZSAhPT0gJ2Jvb2xlYW4nKSkge1xuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBnZXRQYW5lbFNlc3Npb24obWVzc2FnZS5mb3JjZSA9PT0gdHJ1ZSkudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAnUGFuZWw6INGE0L7QvdC+0LLQsNGPINGB0LXRgdGB0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsC4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmICghWydtZW1jaGF0Omh0dHAnLCAnbWVtY2hhdDphYm9ydCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtekEtWjAtOS1dezEsODB9JC8udGVzdChtZXNzYWdlLmlkKSkge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6YWJvcnQnKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCkpO1xuICAgICAgICBpZiAoZW50cnkpIHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcGVyZm9ybVJlcXVlc3QobWVzc2FnZSwgc2VuZGVyKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQuZXZlbnQgPT09ICdsb2FkJyAmJiBbNDAxLCA0MDMsIDQxOV0uaW5jbHVkZXMocmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpXG4gICAgICAgICAgICAmJiBuZXcgVVJMKG1lc3NhZ2UucmVxdWVzdC51cmwpLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1Jykge1xuICAgICAgICAgICAgY29uc3Qgc2VudFRva2VuID0gbmV3IEhlYWRlcnMobWVzc2FnZS5yZXF1ZXN0LmhlYWRlcnMgfHwge30pLmdldCgneC1jc3JmLXRva2VuJyk7XG4gICAgICAgICAgICBpZiAoc2VudFRva2VuICYmIHNlbnRUb2tlbiA9PT0gcGFuZWxTZXNzaW9uPy50b2tlbikge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmVzdWx0LnBhbmVsQXV0aExvc3QgPSB0cnVlO1xuICAgICAgICAgICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3BhbmVsJywgZXZlbnQ6ICdhdXRoLWxvc3QnLFxuICAgICAgICAgICAgICAgICAgICBkZXRhaWw6IHsgc3RhdHVzOiByZXN1bHQucmVzcG9uc2U/LnN0YXR1cyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzZW5kUmVzcG9uc2UocmVzdWx0KTtcbiAgICB9LCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPJyB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG59XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoZXh0ZW5zaW9uSGFuZGxlTWVzc2FnZSk7XG5cbi8vIFJlZ2lzdGVyIHRvb2xiYXIvY29udGV4dC1tZW51IGxpc3RlbmVycyBzeW5jaHJvbm91c2x5IG9uIGV2ZXJ5IHdvcmtlciB3YWtlLlxuaW1wb3J0U2NyaXB0cygnY29udHJvbHMuanMnKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckxBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0xBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqS0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2xUQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbHpCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4VEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSJ9
