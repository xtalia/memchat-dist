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
        const timer = setTimeout(() => {
            session.pending.delete(id);
            // Keep the deadline reason distinct so the panel can tell a frozen
            // runtime from an ordinary disconnect instead of backing off blindly.
            const error = Error('Runtime timed out');
            error.code = 'timeout';
            reject(error);
        }, 5000);
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
// The UI view/event channel is served exclusively by the panel's own
// extension-hosted runtime. The bound tab is only an optional site-action target:
// its liveness and support decide the separate `site` flag, never whether the
// panel keeps rendering. No request is ever delivered to the site content world.
function sidebarDocumentContext(tab) {
    if (!tab || typeof tab.url !== 'string') return null;
    let hash;
    try { hash = new URL(tab.url).hash; } catch { return null; }
    const match = hash.match(/^#(customerorder|demand)\/edit\?id=([0-9a-fA-F-]{8,64})$/);
    return match ? { type: match[1], id: match[2] } : null;
}
async function sidebarViewDispatch(message, sender) {
    const resolved = await sidebarBindingFor(message, sender);
    if (!resolved.binding) {
        sidebarDebugFailure(message, null, resolved.reason || 'changed');
        return { ok: false, reason: resolved.reason || 'changed' };
    }
    const binding = resolved.binding;
    const origin = binding.origin;
    const bound = await sidebarBoundTab(message, binding);
    const tab = bound.tab;
    // Site availability is a separate capability. A missing, discarded or
    // navigated page only removes the site-action target and the document context;
    // the captured origin keeps rendering the UI from the private runtime.
    if (!tab && bound.reason === 'changed') {
        sidebarDebugFailure(message, binding, 'changed');
        return { ok: false, reason: 'changed' };
    }
    const site = !!tab && binding.supported && supportedActionTab(tab) && new URL(tab.url).origin === origin;
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
    // The bounded open-document context is derived only from the captured tab URL
    // and only while that page is still the supported site. No path/query, title
    // or page-supplied selector crosses the channel.
    request.documentContext = site ? sidebarDocumentContext(tab) : null;
    let historyTarget;
    let view;
    const relayClickTrace = route => {
        if (clickId) memchatDebugRecord({ level: 'debug', scope: 'sidebar', event: 'click-relayed', detail: { clickId, route } }, 'worker');
    };
    try {
        const session = nativeRuntimeSessions.get(nativeRuntimeSessionKey(sender, origin));
        if (!session) {
            // The panel's own runtime is the only view host. If it is not bound yet,
            // hand the panel a one-use capability instead of ever falling back to
            // the site content world.
            if (message.type !== 'memchat:sidebar-view') return { ok: false, reason: 'changed' };
            return { ok: true, tabId: binding.tabId, host: new URL(origin).hostname, site, native: !site,
                runtime: { origin, ticket: await nativeRuntimeTicket(sender, message.windowId, origin) } };
        }
        historyTarget = 'native:' + session.sender.url;
        relayClickTrace('runtime');
        view = await nativeRuntimeRequest(session, request);
    } catch (error) {
        const reason = error?.code === 'timeout' ? 'timeout' : 'missing';
        sidebarDebugFailure(message, binding, reason);
        return { ok: false, reason };
    }
    if (!await nativePanelIdentity(sender, message.windowId)) {
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
        && (await chrome.tabs.query({ active: true, windowId: message.windowId }))[0]?.id === binding.tabId);
    if (site && activeBound && (await chrome.windows.get(message.windowId)).focused) await nativeRememberOrigin(origin);
    // Only a view that really answered may become the target of this panel's
    // chat sink; a refused request must not bind a document that never rendered.
    if (history) sidebarHistoryBind(sender, historyTarget, view.documentToken);
    return { ok: true, tabId: binding.tabId, host: new URL(origin).hostname, site, native: !site, view };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL2RlYnVnLWxvZy5qcyIsImV4dGVuc2lvbi93b3JrZXIvbmV0d29yay5qcyIsImV4dGVuc2lvbi93b3JrZXIvcGFuZWwtc2Vzc2lvbi5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXItYWxlcnRzLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci9vcmRlcnMuanMiLCJleHRlbnNpb24vbmF0aXZlLXJ1bnRpbWUtd29ya2VyLmpzIiwiZXh0ZW5zaW9uL2hpc3Rvcnktd29ya2VyLmpzIiwiZXh0ZW5zaW9uL3NpZGViYXItd29ya2VyLmpzIiwic3JjL2ZlYXR1cmVzL3JlcHJpY2Uvc2VydmljZS5qcyIsImV4dGVuc2lvbi93b3JrZXIvcmVwcmljZS5qcyIsImV4dGVuc2lvbi93b3JrZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBQcml2YXRlIHN0b3JhZ2UgaXMgb3JpZ2luLXNjb3BlZCB0byBwcmVzZXJ2ZSBleGlzdGluZyBzaXRlL2FjY291bnQgc2VwYXJhdGlvbi5cbi8vIENocm9tZSBvd25zIHBlcnNpc3RlbmNlOyBwYWdlIGxvY2FsU3RvcmFnZSBpcyB1c2VkIG9ubHkgZm9yIG9uZS10aW1lIG1pZ3JhdGlvbi5cbmNvbnN0IHByaXZhdGVTdG9yYWdlUmVhZHkgPSAoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldEFjY2Vzc0xldmVsKHsgYWNjZXNzTGV2ZWw6ICdUUlVTVEVEX0NPTlRFWFRTJyB9KTtcbn0pKCk7XG4vLyBIYW5kbGUgaW5pdGlhbGl6YXRpb24gcmVqZWN0aW9uIGltbWVkaWF0ZWx5LCB3aGlsZSByZXRhaW5pbmcgZmFpbC1jbG9zZWQgYXdhaXRzLlxucHJpdmF0ZVN0b3JhZ2VSZWFkeS5jYXRjaCgoKSA9PiB7fSk7XG5sZXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycyA9IG5ldyBNYXAoKTtcbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtidWNrZXQudmVyc2lvbiwgT2JqZWN0LmtleXMoYnVja2V0Lml0ZW1zKS5zb3J0KCkubWFwKGtleSA9PlxuICAgICAgICBba2V5LCBidWNrZXQuaXRlbXNba2V5XS5yZXZpc2lvbiwgYnVja2V0Lml0ZW1zW2tleV0udmFsdWVdKSxcbiAgICBPYmplY3Qua2V5cyhidWNrZXQubGVnYWN5QmFja3VwIHx8IHt9KS5zb3J0KCkubWFwKGtleSA9PiBba2V5LCBidWNrZXQubGVnYWN5QmFja3VwW2tleV1dKSxcbiAgICAoYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBbZW50cnkuaWQsIGVudHJ5LmtleSwgZW50cnkudmFsdWUsIGVudHJ5LmRvY3VtZW50LCBlbnRyeS5yZXZpc2lvbl0pLFxuICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fCBbXV0pO1xufVxuLy8gUHJpdmF0ZSB2YXJpYW50cyBhcHBlbmQgbm9ybWFsbHk7IG9ubHkgZXhwbGljaXQgY29uZmlybWVkIHBydW5lIGRlbGV0ZXMgb25lLlxuLy8gTm8gYXV0b21hdGljIGV2aWN0aW9uOiBleGhhdXN0aW9uIGZhaWxzIGNsb3NlZCxcbi8vIGFuZCBjb250ZW50IG11c3QgZXhwbGljaXRseSB3YXJuIHRoYXQgdGhlIG5ld2VzdCBlZGl0IGlzIE5PVCB5ZXQgZHVyYWJsZS5cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCkge1xuICAgIGJ1Y2tldC5yZWNvdmVyaWVzIHx8PSBbXTtcbiAgICBjb25zdCBleGlzdGluZyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbmQoZW50cnkgPT4gZW50cnkua2V5ID09PSBrZXkgJiYgZW50cnkudmFsdWUgPT09IHZhbHVlXG4gICAgICAgICYmIGVudHJ5LmRvY3VtZW50ID09PSBkb2N1bWVudCAmJiBlbnRyeS5yZXZpc2lvbiA9PT0gcmV2aXNpb24pO1xuICAgIGlmIChleGlzdGluZykgcmV0dXJuO1xuICAgIGlmIChidWNrZXQucmVjb3Zlcmllcy5sZW5ndGggPj0gMTI4KSB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ2NhcGFjaXR5JywgZGV0YWlsOiB7IGtleSB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1JlY292ZXJ5IGNhcGFjaXR5IGV4aGF1c3RlZCcpO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLmJ1Y2tldC5yZWNvdmVyaWVzLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpICsgMTtcbiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGlkKSkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjYXBhY2l0eScsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHRocm93IEVycm9yKCdSZWNvdmVyeSBJRCBleGhhdXN0ZWQnKTtcbiAgICB9XG4gICAgYnVja2V0LnJlY292ZXJ5U2VxdWVuY2UgPSBpZDtcbiAgICBidWNrZXQucmVjb3Zlcmllcy5wdXNoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCB9KTtcbiAgICBpZiAoSlNPTi5zdHJpbmdpZnkoYnVja2V0LnJlY292ZXJpZXMpLmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjYXBhY2l0eScsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHRocm93IEVycm9yKCdSZWNvdmVyeSBjYXBhY2l0eSBleGhhdXN0ZWQnKTtcbiAgICB9XG59XG5mdW5jdGlvbiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIHtcbiAgICAvLyBOZXZlciBzZW5kIHJlY292ZXJ5IHZhbHVlcyAoZXNwZWNpYWxseSBjcmVkZW50aWFscy9oaXN0b3J5KSBpbnRvIGEgdmlldy5cbiAgICByZXR1cm4gKGJ1Y2tldC5yZWNvdmVyaWVzIHx8IFtdKS5tYXAoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uIH0pID0+ICh7IGlkLCBrZXksIGRlbGV0ZWQ6IHZhbHVlID09PSBudWxsLCByZXZpc2lvbiB9KSk7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpIHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGJ1Y2tldCB9KTtcbiAgICBjb25zdCBjb21taXR0ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICBpZiAoIWNvbW1pdHRlZCB8fCBwcml2YXRlU3RvcmFnZVNuYXBzaG90KGNvbW1pdHRlZCkgIT09IHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICd2ZXJpZmljYXRpb24nLCBkZXRhaWw6IHt9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1N0b3JhZ2UgdmVyaWZpY2F0aW9uIGZhaWxlZCcpO1xuICAgIH1cbiAgICByZXR1cm4gY29tbWl0dGVkO1xufVxuYXN5bmMgZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGF1dGhvcml6YXRpb24pIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ2hhaW47XG4gICAgY29uc3Qga2V5ID0gJ21lbWNoYXRQcml2YXRlX3YxOicgKyBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgY29uc3QgYXBpID0gSlNPTi5wYXJzZShzYXZlZD8uaXRlbXNbJ21lbWNoYXQ6aGFja2VyTXNBcGlfdjEnXT8udmFsdWUgfHwgJ3t9Jyk7XG4gICAgcmV0dXJuIGFwaS5iZWFyZXJFbmFibGVkID09PSB0cnVlICYmIHR5cGVvZiBhcGkudG9rZW4gPT09ICdzdHJpbmcnICYmIGF1dGhvcml6YXRpb24gPT09ICdCZWFyZXIgJyArIGFwaS50b2tlbjtcbn1cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBvcGVyYXRpb24gPSBwcml2YXRlU3RvcmFnZUNoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgICAgIGNvbnN0IHN0b3JhZ2VLZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIG9yaWdpbjtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICAgICAgY29uc3QgYnVja2V0ID0gc2F2ZWQgfHwgeyB2ZXJzaW9uOiAxLCBpdGVtczoge30sIGxlZ2FjeUJhY2t1cDoge30gfTtcbiAgICAgICAgaWYgKGJ1Y2tldC52ZXJzaW9uICE9PSAxIHx8ICFidWNrZXQuaXRlbXMgfHwgdHlwZW9mIGJ1Y2tldC5pdGVtcyAhPT0gJ29iamVjdCcpIHRocm93IEVycm9yKCdJbnZhbGlkIHNjaGVtYScpO1xuICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLWluaXQnKSB7XG4gICAgICAgICAgICBjb25zdCBsZWdhY3kgPSBtZXNzYWdlLmxlZ2FjeTtcbiAgICAgICAgICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpICYmIE9iamVjdC5rZXlzKGxlZ2FjeSB8fCB7fSkubGVuZ3RoKSB0aHJvdyBFcnJvcignTmF0aXZlIHJ1bnRpbWUgY2Fubm90IG1pZ3JhdGUgcGFnZSBkYXRhJyk7XG4gICAgICAgICAgICBpZiAoIWxlZ2FjeSB8fCB0eXBlb2YgbGVnYWN5ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGxlZ2FjeSkpIHRocm93IEVycm9yKCdJbnZhbGlkIGxlZ2FjeSBzbmFwc2hvdCcpO1xuICAgICAgICAgICAgY29uc3QgY2xlYW51cCA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCBba2V5LCByYXddIG9mIE9iamVjdC5lbnRyaWVzKGxlZ2FjeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdmFsdWUnKTtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnY2xlYXJUZXh0RW5hYmxlZCcgJiYgWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMocmF3KSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIU9iamVjdC5oYXNPd24oYnVja2V0Lml0ZW1zLCAnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMobGVnYWN5WydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSkgPyBsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddIDogcmF3O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSA9IHsgdmFsdWUsIHJldmlzaW9uOiAxIH07XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXS52YWx1ZSAhPT0gcmF3KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAuY2xlYXJUZXh0RW5hYmxlZCA9IHJhdztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgeyBjbGVhbnVwLnB1c2goa2V5KTsgY29udGludWU7IH1cbiAgICAgICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgICAgIGlmICghc2F2ZWQpIGJ1Y2tldC5pdGVtc1trZXldID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICBlbHNlIGlmIChidWNrZXQuaXRlbXNba2V5XT8udmFsdWUgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEFuIG9sZGVyIHVzZXJzY3JpcHQgbWF5IHJlY3JlYXRlIG9sZCBrZXlzLiBQcmVzZXJ2ZSB0aGF0IGNvcHlcbiAgICAgICAgICAgICAgICAgICAgLy8gcHJpdmF0ZWx5LCBidXQgbmV2ZXIgcm9sbCBiYWNrIHRoZSBjYW5vbmljYWwgZXh0ZW5zaW9uIHN0YXRlLlxuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cFtrZXldID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNsZWFudXAucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQWNrbm93bGVkZ2Ugb25seSBhZnRlciBDaHJvbWUgY29tbWl0cyBhbmQgYSByZWFkLWJhY2sgdmVyaWZpZXMgaXQuXG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5zZXQoc2VuZGVyLnRhYj8uaWQgPz8gJ25hdGl2ZTonICsgc2VuZGVyLnVybCwgeyBvcmlnaW4sIGRvY3VtZW50SWQ6IHNlbmRlci5kb2N1bWVudElkLCBzZW5kZXIgfSk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaXRlbXM6IGNvbW1pdHRlZC5pdGVtcywgY2xlYW51cCwgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoY29tbWl0dGVkKSB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtcHJ1bmUnKSB7XG4gICAgICAgICAgICAvLyBFeHBsaWNpdCBpcnJldmVyc2libGUgZGVsZXRpb24gb2YgT05FIGltbXV0YWJsZSBJRCwgbmV2ZXIgYSBidWxrIGNsZWFyLlxuICAgICAgICAgICAgLy8gS2VlcCBpdHMgZG9jdW1lbnQgZmVuY2UgYWZ0ZXIgZGVsZXRpb24sIGFuZCBuZXZlciByZWN5Y2xlIElEcyAoc3RhbGUgVUkvYWNrIHJldHJpZXMpLlxuICAgICAgICAgICAgY29uc3Qgc2VxdWVuY2UgPSBNYXRoLm1heChidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSB8fCAwLCAuLi4oYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UuY29uZmlybWVkICE9PSB0cnVlIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmlkKSB8fCBtZXNzYWdlLmlkIDwgMSB8fCBtZXNzYWdlLmlkID4gc2VxdWVuY2UpIHRocm93IEVycm9yKCdJbnZhbGlkIHBydW5lJyk7XG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGJ1Y2tldC5yZWNvdmVyaWVzPy5maW5kKGl0ZW0gPT4gaXRlbS5pZCA9PT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSA9IHNlcXVlbmNlO1xuICAgICAgICAgICAgaWYgKGVudHJ5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5LmRvY3VtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fD0gW107XG4gICAgICAgICAgICAgICAgICAgIGlmICghYnVja2V0LnJlY292ZXJ5RmVuY2VzLnNvbWUoKFtrZXksIGRvY3VtZW50XSkgPT4ga2V5ID09PSBlbnRyeS5rZXkgJiYgZG9jdW1lbnQgPT09IGVudHJ5LmRvY3VtZW50KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LnJlY292ZXJ5RmVuY2VzLnB1c2goW2VudHJ5LmtleSwgZW50cnkuZG9jdW1lbnRdKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBidWNrZXQucmVjb3ZlcmllcyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbHRlcihpdGVtID0+IGl0ZW0uaWQgIT09IG1lc3NhZ2UuaWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgY29tbWl0dGVkID0gYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDb21taXQoc3RvcmFnZUtleSwgYnVja2V0KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChjb21taXR0ZWQpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFsnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJywgJ21lbWNoYXQ6c3RvcmFnZS1yZXN0b3JlJ10uaW5jbHVkZXMobWVzc2FnZS50eXBlKSkge1xuICAgICAgICAgICAgY29uc3QgcmVzdG9yaW5nID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnO1xuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcnkgPSByZXN0b3JpbmcgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5pZClcbiAgICAgICAgICAgICAgICAmJiBidWNrZXQucmVjb3Zlcmllcz8uZmluZChlbnRyeSA9PiBlbnRyeS5pZCA9PT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmICFyZWNvdmVyeSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcmVjb3ZlcnknKTtcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlc3RvcmluZyA/IHJlY292ZXJ5LmtleSA6IG1lc3NhZ2Uua2V5LCByZXZpc2lvbiA9IG1lc3NhZ2UucmV2aXNpb247XG4gICAgICAgICAgICBjb25zdCByYXcgPSByZXN0b3JpbmcgPyByZWNvdmVyeS52YWx1ZSA6IG1lc3NhZ2UudmFsdWU7XG4gICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihyZXZpc2lvbikgfHwgcmV2aXNpb24gPCAwXG4gICAgICAgICAgICAgICAgfHwgcmV2aXNpb24gPj0gTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVJcbiAgICAgICAgICAgICAgICB8fCAocmF3ICE9PSBudWxsICYmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHdyaXRlJyk7XG4gICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGJ1Y2tldC5pdGVtc1trZXldIHx8IHsgdmFsdWU6IG51bGwsIHJldmlzaW9uOiAwIH07XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IHJhdyA9PT0gbnVsbCA/IG51bGwgOiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgcmF3KTtcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gc2VuZGVyLmRvY3VtZW50SWQgfHwgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgPyAnbmF0aXZlOicgKyBzZW5kZXIudXJsIDogJ3RhYjonICsgc2VuZGVyLnRhYi5pZCk7XG4gICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSBkb2N1bWVudCBmZW5jZSB3aXRoIHRoZSBmaXJzdCBjb25mbGljdC4gQWxyZWFkeSBzZW50XG4gICAgICAgICAgICAvLyBvcHRpbWlzdGljIHdyaXRlcyBjYW5ub3QgYWNjaWRlbnRhbGx5IG92ZXJ3cml0ZSB0aGUgd2lubmVyIGxhdGVyLFxuICAgICAgICAgICAgLy8gaW5jbHVkaW5nIGFmdGVyIHdvcmtlciBzdXNwZW5zaW9uLiBSZWxvYWQgY3JlYXRlcyBhIG5ldyBkb2N1bWVudC5cbiAgICAgICAgICAgIGNvbnN0IGJsb2NrZWQgPSAhcmVzdG9yaW5nICYmIChidWNrZXQucmVjb3Zlcmllcz8uc29tZShlbnRyeSA9PiBlbnRyeS5rZXkgPT09IGtleSAmJiBlbnRyeS5kb2N1bWVudCA9PT0gZG9jdW1lbnQpXG4gICAgICAgICAgICAgICAgfHwgYnVja2V0LnJlY292ZXJ5RmVuY2VzPy5zb21lKChbZmVuY2VkS2V5LCBmZW5jZWREb2N1bWVudF0pID0+IGZlbmNlZEtleSA9PT0ga2V5ICYmIGZlbmNlZERvY3VtZW50ID09PSBkb2N1bWVudCkpO1xuICAgICAgICAgICAgLy8gQSBjb25jdXJyZW50IHdyaXRlciBtYXkgaGF2ZSBjb21taXR0ZWQgdGhlIGlkZW50aWNhbCBkZXNpcmVkIHZhbHVlLlxuICAgICAgICAgICAgLy8gT25seSBhY2NlcHQgdGhlIGltbWVkaWF0ZWx5IHByZWNlZGluZyByZXZpc2lvbiBzbyBvcHRpbWlzdGljIHF1ZXVlZFxuICAgICAgICAgICAgLy8gd3JpdGVzIGNvbnRpbnVlIGZyb20gdGhlIHJldmlzaW9uIHRoZSBjb250ZW50IGFkYXB0ZXIgcHJlZGljdGVkLlxuICAgICAgICAgICAgaWYgKCFibG9ja2VkICYmICFyZXN0b3JpbmcgJiYgcHJldmlvdXMucmV2aXNpb24gPT09IHJldmlzaW9uICsgMSAmJiBwcmV2aW91cy52YWx1ZSA9PT0gdmFsdWUpIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtOiBwcmV2aW91cyB9O1xuICAgICAgICAgICAgaWYgKGJsb2NrZWQgfHwgcHJldmlvdXMucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IG1lc3NhZ2UucHJldmlvdXNWYWx1ZSAhPT0gcHJldmlvdXMudmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3RvcmluZykge1xuICAgICAgICAgICAgICAgICAgICBwcml2YXRlU3RvcmFnZVJlY292ZXIoYnVja2V0LCBrZXksIHZhbHVlLCByZXZpc2lvbiwgZG9jdW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjb25mbGljdCcsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgcmVjb3ZlcmVkOiB0cnVlLCBrZXksIGl0ZW06IHByZXZpb3VzLFxuICAgICAgICAgICAgICAgICAgICByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmIHByZXZpb3VzLnZhbHVlICE9PSB2YWx1ZSkgcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCBwcmV2aW91cy52YWx1ZSwgcHJldmlvdXMucmV2aXNpb24sIG51bGwpO1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHsgdmFsdWUsIHJldmlzaW9uOiByZXZpc2lvbiArIDEgfTtcbiAgICAgICAgICAgIGJ1Y2tldC5pdGVtc1trZXldID0gaXRlbTtcbiAgICAgICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICAvLyBCZXN0LWVmZm9ydCBwcml2YXRlIGludmFsaWRhdGlvbjsgY2xvc2VkL3JlcGxhY2VkIGRvY3VtZW50cyBhcmUgaWdub3JlZC5cbiAgICAgICAgICAgIGZvciAoY29uc3QgW3RhYklkLCBzdWJzY3JpYmVyXSBvZiBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRhYklkID09PSAoc2VuZGVyLnRhYj8uaWQgPz8gJ25hdGl2ZTonICsgc2VuZGVyLnVybCkgfHwgc3Vic2NyaWJlci5vcmlnaW4gIT09IG9yaWdpbikgY29udGludWU7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB0YWJJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHsgbmF0aXZlUnVudGltZU5vdGlmeShzdWJzY3JpYmVyLnNlbmRlciwgeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnLCBrZXksIGl0ZW0gfSk7IH1cbiAgICAgICAgICAgICAgICAgICAgY2F0Y2ggeyBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSh0YWJJZCk7IH1cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBzdWJzY3JpYmVyLmRvY3VtZW50SWQgPyB7IGRvY3VtZW50SWQ6IHN1YnNjcmliZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiAwIH07XG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1jaGFuZ2VkJywga2V5LCBpdGVtIH0sIG9wdGlvbnMpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZ2V0KHRhYklkKSA9PT0gc3Vic2NyaWJlcikgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUodGFiSWQpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGtleSwgaXRlbSwgLi4uKHJlc3RvcmluZyA/IHsgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoYnVja2V0KSB9IDoge30pIH07XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgRXJyb3IoJ0ludmFsaWQgb3BlcmF0aW9uJyk7XG4gICAgfSk7XG4gICAgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gICAgLy8gQW55IHJlamVjdGVkIHdyaXRlIGlzIHJlZnVzZWQgYmVmb3JlIGl0IGJlY29tZXMgZHVyYWJsZTsga2VlcCB0aGUga2V5IG9ubHksXG4gICAgLy8gbmV2ZXIgdGhlIHZhbHVlIG9yIHRoZSBlcnJvciB0ZXh0LlxuICAgIG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ3JlamVjdGVkJyxcbiAgICAgICAgICAgIGRldGFpbDogeyBrZXk6IHR5cGVvZiBtZXNzYWdlLmtleSA9PT0gJ3N0cmluZycgPyBtZXNzYWdlLmtleS5zbGljZSgwLCAxMjgpIDogbnVsbCB9IH0sICd3b3JrZXInKTtcbiAgICB9KTtcbiAgICByZXR1cm4gb3BlcmF0aW9uO1xufVxuIiwiLy8gRXh0ZW5zaW9uLXdpZGUgcmluZyBidWZmZXIgc2hhcmVkIGJ5IHRoZSB3b3JrZXIsIHRoZSBuYXRpdmUgcGFuZWwgYW5kIHRoZVxuLy8gY29udGVudCB3b3JsZC4gSXQgbGl2ZXMgaW4gY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbiBzbyB3b3JrZXIgc3VzcGVuc2lvbiBkb2VzXG4vLyBub3QgbG9zZSB0aGUgdHJhaWwgd2hpbGUgdGhlIGJyb3dzZXIgc3RheXMgb3Blbi4gTmV2ZXIgcHJlZmVyIGxvY2FsIHN0b3JhZ2U6XG4vLyB0aGUgbG9nIGlzIGRpYWdub3N0aWMgZGF0YSwgbm90IGR1cmFibGUgc3RhdGUsIGFuZCBtYXkgYmUgZXhwb3J0ZWQgYnkgYSB1c2VyLlxuY29uc3QgTUVNQ0hBVF9ERUJVR19MT0dfS0VZID0gJ21lbWNoYXREZWJ1Z0xvZ192MSc7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZID0gJ21lbWNoYXREZWJ1Z0VuYWJsZWRfdjEnO1xuY29uc3QgTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQgPSA1MDA7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xPR19NQVhfQUdFX01TID0gNyAqIDI0ICogNjAgKiA2MCAqIDEwMDA7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xFVkVMUyA9IE9iamVjdC5mcmVlemUoWydkZWJ1ZycsICdpbmZvJywgJ3dhcm4nLCAnZXJyb3InXSk7XG5jb25zdCBNRU1DSEFUX0RFQlVHX1dPUkxEUyA9IE9iamVjdC5mcmVlemUoWydwYW5lbCcsICdjb250ZW50JywgJ3J1bnRpbWUnLCAnd29ya2VyJ10pO1xuY29uc3QgTUVNQ0hBVF9ERUJVR19TRUNSRVRfS0VZID0gL3Rva2VufHBhc3N3b3JkfGF1dGhvcml6YXRpb258Y29va2llfHNlY3JldHxjcmVkZW50aWFsfGNzcmZ8YXBpa2V5fGFwaV9rZXl8c2Vzc2lvbnxiZWFyZXJ8c2lnbmF0dXJlfHByaXZhdGUvaTtcbi8vIFF1ZXJ5IHN0cmluZ3MgY2FycnkgYmVhcmVyLWxpa2UgdmFsdWVzICg/dG9rZW49LCA/YWNjZXNzX3Rva2VuPSwgc2lnbmVkIFVSTHMpXG4vLyBhbmQgdGhlIHBhdGggY2FuIGVtYmVkIGEgc2Vzc2lvbiBpZDsga2VlcCBvbmx5IG9yaWdpbitwYXRobmFtZSBmb3IgZGlhZ25vc3RpY3MuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdTYWZlVXJsKHJhdykge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoU3RyaW5nKHJhdykpO1xuICAgICAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyAmJiB1cmwucHJvdG9jb2wgIT09ICdodHRwOicpIHJldHVybiAnW1VSTF0nO1xuICAgICAgICByZXR1cm4gdXJsLm9yaWdpbiArIHVybC5wYXRobmFtZTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuICdbVVJMXSc7IH1cbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnU2FuaXRpemUodmFsdWUsIGtleSA9ICcnLCBkZXB0aCA9IDApIHtcbiAgICBpZiAoTUVNQ0hBVF9ERUJVR19TRUNSRVRfS0VZLnRlc3Qoa2V5KSkgcmV0dXJuICdbUkVEQUNURURdJztcbiAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJyB8fCB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSByZXR1cm4gdmFsdWU7XG4gICAgaWYgKGRlcHRoID49IDUpIHJldHVybiAnW01BWF9ERVBUSF0nO1xuICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4ge1xuICAgICAgICBuYW1lOiB2YWx1ZS5uYW1lLFxuICAgICAgICBtZXNzYWdlOiBtZW1jaGF0RGVidWdTYW5pdGl6ZShTdHJpbmcodmFsdWUubWVzc2FnZSB8fCAnJyksICdtZXNzYWdlJywgZGVwdGggKyAxKSxcbiAgICAgICAgc3RhY2s6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKFN0cmluZyh2YWx1ZS5zdGFjayB8fCAnJyksICdzdGFjaycsIGRlcHRoICsgMSlcbiAgICB9O1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZVxuICAgICAgICAgICAgLnJlcGxhY2UoL0JlYXJlclxccytbXlxcc1wiJ10rL2dpLCAnQmVhcmVyIFtSRURBQ1RFRF0nKVxuICAgICAgICAgICAgLnJlcGxhY2UoL1xcYig/OmV5SltcXHctXXsxMCx9XFwuW1xcdy1dezEwLH1cXC5bXFx3LV17NSx9KVxcYi9nLCAnW0pXVF0nKVxuICAgICAgICAgICAgLnJlcGxhY2UoL1xcYlswLTlhLWZdezMyLH1cXGIvZ2ksICdbSEVYXScpXG4gICAgICAgICAgICAucmVwbGFjZSgvKD88IVtcXGQrXSkoPzpcXCs/N3w4KVtcXHMoKS4tXSpcXGR7M31bXFxzKCkuLV0qXFxkezN9W1xccygpLi1dKlxcZHsyfVtcXHMoKS4tXSpcXGR7Mn1cXGIvZywgJ1tQSE9ORV0nKVxuICAgICAgICAgICAgLnNsaWNlKDAsIDMwMDApO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5zbGljZSgwLCA0MCkubWFwKGl0ZW0gPT4gbWVtY2hhdERlYnVnU2FuaXRpemUoaXRlbSwga2V5LCBkZXB0aCArIDEpKTtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXModmFsdWUpLnNsaWNlKDAsIDUwKS5mb3JFYWNoKGNoaWxkS2V5ID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkS2V5XSA9IC9eKHVybHxocmVmfG9yaWdpbnxyZWZlcnJlcikkL2kudGVzdChjaGlsZEtleSkgJiYgdHlwZW9mIHZhbHVlW2NoaWxkS2V5XSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAgICAgPyBtZW1jaGF0RGVidWdTYWZlVXJsKHZhbHVlW2NoaWxkS2V5XSlcbiAgICAgICAgICAgICAgICAgICAgOiBtZW1jaGF0RGVidWdTYW5pdGl6ZSh2YWx1ZVtjaGlsZEtleV0sIGNoaWxkS2V5LCBkZXB0aCArIDEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2F0Y2ggeyByZXN1bHRbY2hpbGRLZXldID0gJ1tVTlJFQURBQkxFXSc7IH1cbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcodmFsdWUpLnNsaWNlKDAsIDMwMDApO1xufVxuXG4vLyBJbi1tZW1vcnkgbWlycm9yIG9mIHRoZSBzZXNzaW9uIGJ1ZmZlci4gQWxsIG11dGF0aW9ucyBzaGFyZSBvbmUgcHJvbWlzZSBjaGFpblxuLy8gc28gYSBidXJzdCBvZiByZWNvcmRzIGNhbm5vdCBpbnRlcmxlYXZlIGEgcmVhZC1tb2RpZnktd3JpdGUgYW5kIGxvc2UgZW50cmllcy5cbmxldCBtZW1jaGF0RGVidWdFbnRyaWVzID0gW107XG5sZXQgbWVtY2hhdERlYnVnTG9hZGVkID0gZmFsc2U7XG5sZXQgbWVtY2hhdERlYnVnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmxldCBtZW1jaGF0RGVidWdTZXF1ZW5jZSA9IDA7XG5cbmZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0ZyZXNoKGVudHJpZXMpIHtcbiAgICBjb25zdCBjdXRvZmYgPSBEYXRlLm5vdygpIC0gTUVNQ0hBVF9ERUJVR19MT0dfTUFYX0FHRV9NUztcbiAgICByZXR1cm4gKEFycmF5LmlzQXJyYXkoZW50cmllcykgPyBlbnRyaWVzIDogW10pXG4gICAgICAgIC5maWx0ZXIoZW50cnkgPT4gZW50cnkgJiYgdHlwZW9mIGVudHJ5LmF0ID09PSAnbnVtYmVyJyAmJiBlbnRyeS5hdCA+PSBjdXRvZmYpXG4gICAgICAgIC5zbGljZSgtTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtZW1jaGF0RGVidWdIeWRyYXRlKCkge1xuICAgIGlmIChtZW1jaGF0RGVidWdMb2FkZWQpIHJldHVybiBtZW1jaGF0RGVidWdFbnRyaWVzO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KE1FTUNIQVRfREVCVUdfTE9HX0tFWSkpW01FTUNIQVRfREVCVUdfTE9HX0tFWV07XG4gICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChzYXZlZCk7XG4gICAgfSBjYXRjaCB7IG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBbXTsgfVxuICAgIG1lbWNoYXREZWJ1Z0xvYWRlZCA9IHRydWU7XG4gICAgcmV0dXJuIG1lbWNoYXREZWJ1Z0VudHJpZXM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0VuYWJsZWQoKSB7XG4gICAgdHJ5IHsgcmV0dXJuIChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTUVNQ0hBVF9ERUJVR19GTEFHX0tFWSkpW01FTUNIQVRfREVCVUdfRkxBR19LRVldID09PSAndHJ1ZSc7IH1cbiAgICBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBtZW1jaGF0RGVidWdTZXRFbmFibGVkKGVuYWJsZWQpIHtcbiAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhlbmFibGVkID09PSB0cnVlKTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV06IHZhbHVlIH0pO1xuICAgICAgICByZXR1cm4gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZKSlbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV0gPT09IHZhbHVlO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnUmVjb3JkKGVudHJ5LCB3b3JsZCA9ICd3b3JrZXInKSB7XG4gICAgY29uc3Qgd29yayA9IG1lbWNoYXREZWJ1Z0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbGV2ZWwgPSBNRU1DSEFUX0RFQlVHX0xFVkVMUy5pbmNsdWRlcyhlbnRyeT8ubGV2ZWwpID8gZW50cnkubGV2ZWwgOiAnaW5mbyc7XG4gICAgICAgICAgICAvLyBFcnJvcnMgYXJlIGFsd2F5cyBrZXB0OiB0aGV5IGFyZSB3aGF0IGEgdXNlciByZXBvcnRzLiBFdmVyeXRoaW5nXG4gICAgICAgICAgICAvLyBlbHNlIGlzIG9wdC1pbiBiZWNhdXNlIHRoZSBidWZmZXIgaXMgc2hhcmVkIGFuZCBtYXkgYmUgZXhwb3J0ZWQuXG4gICAgICAgICAgICBpZiAobGV2ZWwgIT09ICdlcnJvcicgJiYgIWF3YWl0IG1lbWNoYXREZWJ1Z0VuYWJsZWQoKSkgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IGF3YWl0IG1lbWNoYXREZWJ1Z0h5ZHJhdGUoKTtcbiAgICAgICAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICAgICAgICBlbnRyaWVzLnB1c2goe1xuICAgICAgICAgICAgICAgIGlkOiAnZGwtJyArIG5vdyArICctJyArICgrK21lbWNoYXREZWJ1Z1NlcXVlbmNlKSxcbiAgICAgICAgICAgICAgICBhdDogbm93LFxuICAgICAgICAgICAgICAgIHdvcmxkOiBNRU1DSEFUX0RFQlVHX1dPUkxEUy5pbmNsdWRlcyh3b3JsZCkgPyB3b3JsZCA6ICd3b3JrZXInLFxuICAgICAgICAgICAgICAgIGxldmVsLFxuICAgICAgICAgICAgICAgIHNjb3BlOiB0eXBlb2YgZW50cnk/LnNjb3BlID09PSAnc3RyaW5nJyA/IGVudHJ5LnNjb3BlLnNsaWNlKDAsIDY0KSA6ICdhcHAnLFxuICAgICAgICAgICAgICAgIGV2ZW50OiB0eXBlb2YgZW50cnk/LmV2ZW50ID09PSAnc3RyaW5nJyA/IGVudHJ5LmV2ZW50LnNsaWNlKDAsIDIwMCkgOiAnJyxcbiAgICAgICAgICAgICAgICBkZXRhaWw6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKGVudHJ5Py5kZXRhaWwpXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChlbnRyaWVzKTtcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW01FTUNIQVRfREVCVUdfTE9HX0tFWV06IG1lbWNoYXREZWJ1Z0VudHJpZXMgfSk7IH1cbiAgICAgICAgICAgIGNhdGNoIHsgLyogRGlhZ25vc3RpY3MgbXVzdCBuZXZlciBkaXN0dXJiIHRoZSBvcGVyYXRpb24gYmVpbmcgdHJhY2VkLiAqLyB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBTYW1lOiBhIGJyb2tlbiBidWZmZXIgY2Fubm90IGJyZWFrIGJ1c2luZXNzIGxvZ2ljLiAqLyB9XG4gICAgfSk7XG4gICAgbWVtY2hhdERlYnVnQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yaztcbn1cblxuLy8gRW50cmllcyBhcmUgcmV0dXJuZWQgbmV3ZXN0IGZpcnN0IHNvIGEgcGFzdGVkIGV4Y2VycHQgc3RhcnRzIGF0IHRoZSBsYXRlc3Rcbi8vIGZhaWx1cmUuIGBsaW1pdGAgaXMgY2xhbXBlZCB0byB0aGUgcmluZyBzaXplLlxuZnVuY3Rpb24gbWVtY2hhdERlYnVnUmVhZChvcHRpb25zID0ge30pIHtcbiAgICBjb25zdCB3b3JrID0gbWVtY2hhdERlYnVnQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdFbmFibGVkKCk7XG4gICAgICAgIGxldCBlbnRyaWVzO1xuICAgICAgICB0cnkgeyBlbnRyaWVzID0gbWVtY2hhdERlYnVnRnJlc2goYXdhaXQgbWVtY2hhdERlYnVnSHlkcmF0ZSgpKTsgbWVtY2hhdERlYnVnRW50cmllcyA9IGVudHJpZXM7IH1cbiAgICAgICAgY2F0Y2ggeyBlbnRyaWVzID0gW107IH1cbiAgICAgICAgY29uc3QgbGltaXQgPSBOdW1iZXIuaXNJbnRlZ2VyKG9wdGlvbnM/LmxpbWl0KVxuICAgICAgICAgICAgPyBNYXRoLm1pbihNYXRoLm1heChvcHRpb25zLmxpbWl0LCAxKSwgTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpIDogTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQ7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBlbmFibGVkLCBlbnRyaWVzOiBlbnRyaWVzLnNsaWNlKC1saW1pdCkucmV2ZXJzZSgpIH07XG4gICAgfSk7XG4gICAgbWVtY2hhdERlYnVnQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yay5jYXRjaCgoKSA9PiAoeyBvazogdHJ1ZSwgZW5hYmxlZDogZmFsc2UsIGVudHJpZXM6IFtdIH0pKTtcbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnQ2xlYXIoKSB7XG4gICAgY29uc3Qgd29yayA9IG1lbWNoYXREZWJ1Z0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBtZW1jaGF0RGVidWdFbnRyaWVzID0gW107XG4gICAgICAgIG1lbWNoYXREZWJ1Z0xvYWRlZCA9IHRydWU7XG4gICAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW01FTUNIQVRfREVCVUdfTE9HX0tFWV06IFtdIH0pOyB9XG4gICAgICAgIGNhdGNoIHsgLyogQ2xlYXJpbmcgaXMgYmVzdCBlZmZvcnQuICovIH1cbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgICBtZW1jaGF0RGVidWdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+ICh7IG9rOiB0cnVlIH0pKTtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxuY29uc3QgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcCgpO1xuY29uc3QgcnVsZXNSZWFkeSA9IGNocm9tZS5kZWNsYXJhdGl2ZU5ldFJlcXVlc3QudXBkYXRlU2Vzc2lvblJ1bGVzKHtcbiAgICByZW1vdmVSdWxlSWRzOiBbMSwgMl0sXG4gICAgYWRkUnVsZXM6IFtcbiAgICAgICAgeyBpZDogMSwgcHJpb3JpdHk6IDEsIGFjdGlvbjogeyB0eXBlOiAnbW9kaWZ5SGVhZGVycycsIHJlcXVlc3RIZWFkZXJzOiBbXG4gICAgICAgICAgICB7IGhlYWRlcjogJ09yaWdpbicsIG9wZXJhdGlvbjogJ3NldCcsIHZhbHVlOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIH0sXG4gICAgICAgICAgICB7IGhlYWRlcjogJ1JlZmVyZXInLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcgfVxuICAgICAgICBdIH0sIGNvbmRpdGlvbjogeyBpbml0aWF0b3JEb21haW5zOiBbY2hyb21lLnJ1bnRpbWUuaWRdLCB1cmxGaWx0ZXI6ICd8aHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvJywgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddIH0gfSxcbiAgICAgICAgeyBpZDogMiwgcHJpb3JpdHk6IDIsIGFjdGlvbjogeyB0eXBlOiAnYmxvY2snIH0sIGNvbmRpdGlvbjoge1xuICAgICAgICAgICAgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSxcbiAgICAgICAgICAgIGV4Y2x1ZGVkUmVxdWVzdERvbWFpbnM6IFsuLi5uZXcgU2V0KE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5uZXR3b3JrSG9zdHMubWFwKGhvc3QgPT4gaG9zdC5yZXBsYWNlKC9eXFwqXFwuLywgJycpKSldLFxuICAgICAgICAgICAgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddXG4gICAgICAgIH0gfVxuICAgIF1cbn0pO1xuLy8gRmFpbCBjbG9zZWQ6IGEgZmFpbGVkIEROUiBzZXR1cCBpcyBjYXVnaHQgaGVyZSBhbmQgYmxvY2tzIHN1YnNlcXVlbnQgcmVxdWVzdHMuXG5sZXQgcnVsZUZhaWx1cmUgPSBmYWxzZTtcbnJ1bGVzUmVhZHkuY2F0Y2goKCkgPT4geyBydWxlRmFpbHVyZSA9IHRydWU7IH0pO1xuXG5mdW5jdGlvbiBtYXRjaGVzSG9zdChob3N0bmFtZSwgcGF0dGVybikge1xuICAgIHJldHVybiBwYXR0ZXJuLnN0YXJ0c1dpdGgoJyouJylcbiAgICAgICAgPyBob3N0bmFtZSA9PT0gcGF0dGVybi5zbGljZSgyKSB8fCBob3N0bmFtZS5lbmRzV2l0aCgnLicgKyBwYXR0ZXJuLnNsaWNlKDIpKVxuICAgICAgICA6IGhvc3RuYW1lID09PSBwYXR0ZXJuO1xufVxuXG5mdW5jdGlvbiBhbGxvd2VkVXJsKHJhdykge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5wb3J0XG4gICAgICAgIHx8ICFNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLnNvbWUoaG9zdCA9PiBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIGhvc3QpKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VSTCBub3QgcGVybWl0dGVkJyk7XG4gICAgfVxuICAgIHJldHVybiB1cmw7XG59XG5cbmZ1bmN0aW9uIHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHNlbmRlci50YWI/LmlkKSB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VuZGVyLnVybCk7XG4gICAgICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiBNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcucGFnZU1hdGNoZXMuc29tZShwYXR0ZXJuID0+XG4gICAgICAgICAgICBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIG5ldyBVUkwocGF0dGVybi5yZXBsYWNlKCcqLicsICd3aWxkY2FyZC4nKSkuaG9zdG5hbWUucmVwbGFjZSgnd2lsZGNhcmQuJywgJyouJykpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RLZXkoc2VuZGVyLCBpZCkge1xuICAgIHJldHVybiB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpID8gYG5hdGl2ZToke3NlbmRlci51cmx9OiR7aWR9YCA6IGAke3NlbmRlci50YWIuaWR9OiR7c2VuZGVyLmZyYW1lSWR9OiR7aWR9YDtcbn1cblxuLy8gRGlzcGF0Y2ggTVMgcmVxdWVzdHMgZGlyZWN0bHkuIE9ubHkgYSBmYWlsZWQgcmVhZCB3YWl0cyBmb3IgaXRzIG93biByZXRyeTtcbi8vIG5vIHByb2ZpbGUtd2lkZSBxdW90YSBzdGF0ZSwgcmVzZXJ2YXRpb25zLCBjb25jdXJyZW5jeSBjYXAgb3IgcGFjaW5nLlxuZnVuY3Rpb24gaXNNc0pzb25BcGkodXJsKSB7XG4gICAgcmV0dXJuIHVybC5ob3N0bmFtZSA9PT0gJ2FwaS5tb3lza2xhZC5ydScgJiYgL15cXC9hcGlcXC9yZW1hcFxcLzFcXC4yKD86XFwvfCQpLy50ZXN0KHVybC5wYXRobmFtZSk7XG59XG5mdW5jdGlvbiBtc1JldHJ5RGVsYXkocmVzcG9uc2UsIHRleHQgPSAnJykge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICBsZXQgcXVvdGFFcnJvciA9IGZhbHNlO1xuICAgICAgICB0cnkgeyBxdW90YUVycm9yID0gSlNPTi5wYXJzZSh0ZXh0KT8uZXJyb3JzPy5zb21lKGVycm9yID0+IE51bWJlcihlcnJvci5jb2RlKSA9PT0gMTA3MykgPT09IHRydWU7IH0gY2F0Y2ggeyAvKiBOb3QgSlNPTi4gKi8gfVxuICAgICAgICBpZiAoIVs0MDgsIDQyOV0uaW5jbHVkZXMocmVzcG9uc2Uuc3RhdHVzKSAmJiByZXNwb25zZS5zdGF0dXMgPCA1MDAgJiYgIXF1b3RhRXJyb3IpIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBsb2duZXggPSBOdW1iZXIocmVzcG9uc2U/LmhlYWRlcnMuZ2V0KCdYLUxvZ25leC1SZXRyeS1BZnRlcicpIHx8IDApO1xuICAgIGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZT8uaGVhZGVycy5nZXQoJ1JldHJ5LUFmdGVyJyk7XG4gICAgY29uc3Qgc2Vjb25kcyA9IHJldHJ5QWZ0ZXI/LnRyaW0oKSA/IE51bWJlcihyZXRyeUFmdGVyKSA6IDA7XG4gICAgY29uc3Qgc3RhbmRhcmQgPSBOdW1iZXIuaXNGaW5pdGUoc2Vjb25kcykgPyBzZWNvbmRzICogMTAwMCA6IERhdGUucGFyc2UocmV0cnlBZnRlcikgLSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGRlbGF5ID0gTWF0aC5tYXgoNTAwLCBOdW1iZXIuaXNGaW5pdGUobG9nbmV4KSA/IGxvZ25leCA6IDAsIE51bWJlci5pc0Zpbml0ZShzdGFuZGFyZCkgPyBzdGFuZGFyZCA6IDApO1xuICAgIHJldHVybiBkZWxheTtcbn1cbmZ1bmN0aW9uIG1zV2FpdEZvclJldHJ5KHNpZ25hbCwgZGVsYXkpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgIGxldCByZW1haW5pbmcgPSBkZWxheTtcbiAgICAgICAgbGV0IHRpbWVyO1xuICAgICAgICBjb25zdCBkb25lID0gKCkgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBkb25lKTsgcmVzb2x2ZSgpOyB9O1xuICAgICAgICBjb25zdCBzY2hlZHVsZSA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNodW5rID0gTWF0aC5taW4ocmVtYWluaW5nLCAyMTQ3NDgzNjQ3KTtcbiAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVtYWluaW5nIC09IGNodW5rO1xuICAgICAgICAgICAgICAgIGlmIChyZW1haW5pbmcgPiAwKSBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgICAgIGVsc2UgZG9uZSgpO1xuICAgICAgICAgICAgfSwgY2h1bmspO1xuICAgICAgICB9O1xuICAgICAgICBzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBkb25lLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgZG9uZSgpO1xuICAgICAgICBlbHNlIHNjaGVkdWxlKCk7XG4gICAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1SZXF1ZXN0KG1lc3NhZ2UsIHNlbmRlciwgYmFja2dyb3VuZFNpZ25hbCwgYmFja2dyb3VuZENyZWRlbnRpYWxDdXJyZW50KSB7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UucmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhbGxvd2VkVXJsKHJlcXVlc3Q/LnVybCk7XG4gICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICghWydHRVQnLCAnSEVBRCcsICdQT1NUJywgJ1BVVCcsICdQQVRDSCcsICdERUxFVEUnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ01ldGhvZCBub3QgcGVybWl0dGVkJyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0JvZHkgbXVzdCBiZSB0ZXh0Jyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgYm9keScpO1xuICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSAmJiAhWyd0ZXh0JywgJ2pzb24nXS5pbmNsdWRlcyhyZXF1ZXN0LnJlc3BvbnNlVHlwZSkpIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgcmVzcG9uc2UgdHlwZScpO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycygpO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXF1ZXN0LmhlYWRlcnMgfHwge30pKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGVhZGVyJyk7XG4gICAgICAgIGlmICgvXmF1dGhvcml6YXRpb24kL2kudGVzdChuYW1lKSAmJiB1cmwuaG9zdG5hbWUgIT09ICdhcGkubW95c2tsYWQucnUnKSB0aHJvdyBuZXcgRXJyb3IoJ0F1dGhvcml6YXRpb24gaG9zdCBub3QgcGVybWl0dGVkJyk7XG4gICAgICAgIGlmICgvXihvcmlnaW58cmVmZXJlcnx1c2VyLWFnZW50fGNvb2tpZXxob3N0fGNvbnRlbnQtbGVuZ3RofGNvbm5lY3Rpb258YWNjZXB0LWVuY29kaW5nfHByb3h5LS4qfHNlYy0uKikkL2kudGVzdChuYW1lKSkgY29udGludWU7XG4gICAgICAgIGhlYWRlcnMuc2V0KG5hbWUsIHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgaXNNc0pzb25BcGkodXJsKSAmJiByZXF1ZXN0LmNyZWRlbnRpYWxHdWFyZCAhPT0gdHJ1ZSkgdGhyb3cgRXJyb3IoJ05hdGl2ZSBjcmVkZW50aWFscyBtdXN0IGJlIGd1YXJkZWQnKTtcbiAgICBjb25zdCBrZXkgPSByZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCk7XG4gICAgaWYgKHBlbmRpbmdSZXF1ZXN0cy5oYXMoa2V5KSkgdGhyb3cgbmV3IEVycm9yKCdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IGVudHJ5ID0geyBjb250cm9sbGVyOiBuZXcgQWJvcnRDb250cm9sbGVyKCksIGV2ZW50OiAnJyB9O1xuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoa2V5LCBlbnRyeSk7XG4gICAgY29uc3QgY2FuY2VsQmFja2dyb3VuZCA9ICgpID0+IHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH07XG4gICAgYmFja2dyb3VuZFNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgaWYgKGJhY2tncm91bmRTaWduYWw/LmFib3J0ZWQpIGNhbmNlbEJhY2tncm91bmQoKTtcbiAgICBjb25zdCB0aW1lb3V0ID0gTWF0aC5taW4oMzAwMDAsIE1hdGgubWF4KDEsIE51bWJlcihyZXF1ZXN0LnRpbWVvdXQpIHx8IDMwMDAwKSk7XG4gICAgbGV0IHRpbWVyO1xuICAgIGNvbnN0IGNoZWNrQ3VycmVudCA9IGJhY2tncm91bmRDcmVkZW50aWFsQ3VycmVudCA/IGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHsgaWYgKGF3YWl0IGJhY2tncm91bmRDcmVkZW50aWFsQ3VycmVudCgpKSByZXR1cm47IH0gY2F0Y2ggeyAvKiBGYWlsIGNsb3NlZC4gKi8gfVxuICAgICAgICBlbnRyeS5ldmVudCA9ICdhYm9ydCc7XG4gICAgICAgIGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICB9IDogcmVxdWVzdC5jcmVkZW50aWFsR3VhcmQgPT09IHRydWUgPyBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxldCBjaGVja1RpbWVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgICAgICB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpXG4gICAgICAgICAgICAgICAgICAgID8gbmF0aXZlUnVudGltZVJlcXVlc3QobmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlciksIHsgdHlwZTogJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50JywgaWQ6IG1lc3NhZ2UuaWQgfSlcbiAgICAgICAgICAgICAgICAgICAgOiBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShzZW5kZXIudGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0OnJlcXVlc3QtY3VycmVudCcsIGlkOiBtZXNzYWdlLmlkIH0sIHNlbmRlci5kb2N1bWVudElkID8geyBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiBzZW5kZXIuZnJhbWVJZCB9KSxcbiAgICAgICAgICAgICAgICBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgY2hlY2tUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShudWxsKSwgMTAwMCk7IH0pXG4gICAgICAgICAgICBdKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQ/LmN1cnJlbnQgPT09IHRydWUgJiYgKCFpc01zSnNvbkFwaSh1cmwpIHx8IHR5cGVvZiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50ICE9PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgfHwgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGhlYWRlcnMuZ2V0KCdhdXRob3JpemF0aW9uJykpKSkgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogTWlzc2luZy9pbnZhbGlkYXRlZCBjb250ZW50IHdvcmxkIGZhaWxzIGNsb3NlZC4gKi8gfVxuICAgICAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KGNoZWNrVGltZXIpOyB9XG4gICAgICAgIGVudHJ5LmV2ZW50ID0gJ2Fib3J0JztcbiAgICAgICAgZW50cnkuY29udHJvbGxlci5hYm9ydCgpO1xuICAgIH0gOiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgIGlmIChydWxlRmFpbHVyZSkgdGhyb3cgbmV3IEVycm9yKCdOZXR3b3JrIHJ1bGVzIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgIGlmICh1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmIHBhbmVsU2Vzc2lvbj8udGFiKSB7XG4gICAgICAgICAgICBpZiAoY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBwYW5lbFJlcXVlc3RWaWFUYWIoeyAuLi5yZXF1ZXN0LCBtZXRob2QgfSwgZW50cnkuY29udHJvbGxlci5zaWduYWwpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGNvbnN0IGNhblJldHJ5ID0gaXNNc0pzb25BcGkodXJsKSAmJiBbJ0dFVCcsICdIRUFEJ10uaW5jbHVkZXMobWV0aG9kKSAmJiBhdHRlbXB0ID09PSAwO1xuICAgICAgICAgICAgbGV0IHJldHJ5RGVsYXk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBlbnRyeS5jb250cm9sbGVyO1xuICAgICAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGVudHJ5LmV2ZW50ID0gJ3RpbWVvdXQnOyBjb250cm9sbGVyLmFib3J0KCk7IH0sIHRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLmhyZWYsIHtcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiByZXF1ZXN0LmRhdGEgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogcmVxdWVzdC5hbm9ueW1vdXMgPT09IHRydWUgPyAnb21pdCcgOiAnaW5jbHVkZScsXG4gICAgICAgICAgICAgICAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsIHJlZGlyZWN0OiBpc01zSnNvbkFwaSh1cmwpID8gJ2Vycm9yJyA6ICdmb2xsb3cnXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgLy8gRE5SIGJsb2NrcyByZWRpcmVjdHMgdG8gdW5ncmFudGVkIGhvc3RzIGJlZm9yZSBzZW5kaW5nIGJ5dGVzLlxuICAgICAgICAgICAgICAgIGFsbG93ZWRVcmwocmVzcG9uc2UudXJsIHx8IHVybC5ocmVmKTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHRocm93IG5ldyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IGNhblJldHJ5ID8gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCByZXNwb25zZVRleHQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICAvLyBQYXRoIG9ubHk6IHF1ZXJ5IHN0cmluZ3MgY2FuIGNhcnJ5IHNlYXJjaCB0ZXJtcyBvciBpZGVudGlmaWVycy5cbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID49IDQwMCkgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnbmV0d29yaycsIGV2ZW50OiAnaHR0cC1lcnJvcicsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyB1cmw6IHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWUsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCByZXRyeURlbGF5LCBhdHRlbXB0IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgICAgIGlmIChyZXRyeURlbGF5ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJzZWQgPSByZXNwb25zZVRleHQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyBwYXJzZWQgPSBudWxsOyB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgZXZlbnQ6ICdsb2FkJywgcmVzcG9uc2U6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LCByZXNwb25zZVRleHQsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZTogcGFyc2VkLCByZXNwb25zZUhlYWRlcnM6IFsuLi5yZXNwb25zZS5oZWFkZXJzXS5tYXAoKFtuYW1lLCB2YWx1ZV0pID0+IGAke25hbWV9OiAke3ZhbHVlfWApLmpvaW4oU3RyaW5nLmZyb21DaGFyQ29kZSgxMywgMTApKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbmFsVXJsOiByZXNwb25zZS51cmwgfHwgdXJsLmhyZWYsIHJlYWR5U3RhdGU6IDRcbiAgICAgICAgICAgICAgICAgICAgfSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIGlmIChlbnRyeS5ldmVudCAhPT0gJ2Fib3J0JykgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnbmV0d29yaycsIGV2ZW50OiAnbmV0d29yay1lcnJvcicsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyB1cmw6IHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWUsIHN0YXR1czogbnVsbCwgcmV0cnlEZWxheTogY2FuUmV0cnkgPyA1MDAgOiBudWxsLCBhdHRlbXB0IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgICAgIGlmICghY2FuUmV0cnkgfHwgZW50cnkuZXZlbnQgPT09ICdhYm9ydCcpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgICAgICAgICAgICAgIHJldHJ5RGVsYXkgPSA1MDA7XG4gICAgICAgICAgICB9IGZpbmFsbHkgeyBjbGVhclRpbWVvdXQodGltZXIpOyB9XG4gICAgICAgICAgICAvLyBBIHRpbWVvdXQgYWJvcnRzIGl0cyBhdHRlbXB0LCBub3QgdGhlIG5leHQgb25lLiBFeHBsaWNpdCBhYm9ydHMgYW5kXG4gICAgICAgICAgICAvLyBjcmVkZW50aWFsIGNoYW5nZXMgc3RpbGwgY2FuY2VsIHRoaXMgd2FpdCBhbmQgc3VwcHJlc3MgdGhlIHJldHJ5LlxuICAgICAgICAgICAgZW50cnkuZXZlbnQgPSAnJztcbiAgICAgICAgICAgIGVudHJ5LmNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgICAgICBhd2FpdCBtc1dhaXRGb3JSZXRyeShlbnRyeS5jb250cm9sbGVyLnNpZ25hbCwgcmV0cnlEZWxheSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHsgZXZlbnQ6IGVudHJ5LmV2ZW50IHx8ICdlcnJvcicsIGVycm9yOiAn0J7RiNC40LHQutCwINGB0LXRgtC4INGA0LDRgdGI0LjRgNC10L3QuNGPIE1lbWNoYXQnIH07XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgYmFja2dyb3VuZFNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kKTtcbiAgICAgICAgcGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShrZXkpO1xuICAgIH1cbn1cbiIsIi8vIEEgc2luZ2xlIHdvcmtlciBvd25zIHRoZSBQYW5lbCB0b2tlbi4gTmV2ZXIgcGVyc2lzdCBpdCBpbnRvIHBhZ2Ugc3RvcmFnZS5cbmNvbnN0IFBBTkVMX1NFU1NJT05fVFRMID0gMTIgKiA2MCAqIDEwMDA7XG5jb25zdCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQgPSAxNTAwMDtcbmxldCBwYW5lbFNlc3Npb24gPSBudWxsO1xubGV0IG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbmxldCBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuXG5mdW5jdGlvbiBleHRyYWN0UGFuZWxTZXNzaW9uVG9rZW4oaHRtbCkge1xuICAgIGNvbnN0IGNsZWFuID0gaHRtbC5yZXBsYWNlKC88IS0tW1xcc1xcU10qPy0tPnw8c2NyaXB0XFxiW14+XSo+W1xcc1xcU10qPzxcXC9zY3JpcHRcXHMqPi9naSwgJycpO1xuICAgIGlmICgvPGlucHV0XFxiW14+XSpcXGJ0eXBlXFxzKj1cXHMqW1wiJ10/cGFzc3dvcmRcXGIvaS50ZXN0KGNsZWFuKSkgcmV0dXJuICcnO1xuICAgIGZvciAoY29uc3QgdGFnIG9mIGNsZWFuLm1hdGNoKC88bWV0YVxcYltePl0qPi9naSkgfHwgW10pIHtcbiAgICAgICAgY29uc3QgYXR0cnMgPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBtYXRjaCBvZiB0YWcubWF0Y2hBbGwoLyhbXFx3LV0rKVxccyo9XFxzKig/OlwiKFteXCJdKilcInwnKFteJ10qKScpL2cpKSB7XG4gICAgICAgICAgICBhdHRyc1ttYXRjaFsxXS50b0xvd2VyQ2FzZSgpXSA9IG1hdGNoWzJdID8/IG1hdGNoWzNdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhdHRycy5uYW1lPy50b0xvd2VyQ2FzZSgpID09PSAnY3NyZi10b2tlbicgJiYgL15bQS1aYS16MC05Xy1dezE2LDUxMn0kLy50ZXN0KGF0dHJzLmNvbnRlbnQgfHwgJycpKSByZXR1cm4gYXR0cnMuY29udGVudDtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xufVxuXG5sZXQgcGFuZWxUYWJTZXF1ZW5jZSA9IDA7XG5mdW5jdGlvbiBwYW5lbFRhYlVybChyYXcpIHtcbiAgICB0cnkgeyBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7IHJldHVybiB1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmICF1cmwudXNlcm5hbWUgJiYgIXVybC5wYXNzd29yZCAmJiAhL15cXC9sb2dpblxcLz8kLy50ZXN0KHVybC5wYXRobmFtZSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuZnVuY3Rpb24gcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXF1ZXN0Py51cmwpLCBtZXRob2QgPSBTdHJpbmcocmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIHJldHVybiBwYW5lbFRhYlVybCh1cmwuaHJlZikgJiYgIXVybC5oYXNoICYmICF1cmwuc2VhcmNoICYmICgobWV0aG9kID09PSAnR0VUJ1xuICAgICAgICAgICAgJiYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2VhcmNoL2ZpbHRlcnMnIHx8IC9eXFwvYXBpXFwvYm9udXNlc1xcL2NoZWNrXFwvXFxkezEsMjB9JC8udGVzdCh1cmwucGF0aG5hbWUpKSlcbiAgICAgICAgICAgIHx8IChtZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaCcgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSA9PT0gJ3N0cmluZycgJiYgcmVxdWVzdC5kYXRhLmxlbmd0aCA8PSAzMjc2OCkpO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiTWVzc2FnZSh0YWJJZCwgcGF5bG9hZCwgc2lnbmFsKSB7XG4gICAgY29uc3QgaWQgPSAncGFuZWwtJyArIERhdGUubm93KCkgKyAnLScgKyAoKytwYW5lbFRhYlNlcXVlbmNlKTtcbiAgICBsZXQgdGltZXIsIGFib3J0O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgICAgIGFib3J0ID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6ICdtZW1jaGF0OnBhbmVsLXRhYicsIGlkLCBvcGVyYXRpb246ICdjYW5jZWwnIH0sIHsgZnJhbWVJZDogMCB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZShudWxsKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoYWJvcnQsIFBBTkVMX1NFU1NJT05fVElNRU9VVCk7XG4gICAgICAgICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgYWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChzaWduYWw/LmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5yYWNlKFtjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgLi4ucGF5bG9hZCB9LCB7IGZyYW1lSWQ6IDAgfSksIHRpbWVvdXRdKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0KTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gcmVjb3ZlclBhbmVsRnJvbVRhYihzaWduYWwpIHtcbiAgICBpZiAoIWNocm9tZS50YWJzPy5xdWVyeSB8fCAhY2hyb21lLnRhYnM/LmdldCB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFicyA9IChhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1LyonIH0pKS5maWx0ZXIodGFiID0+IE51bWJlci5pc0ludGVnZXIodGFiLmlkKSAmJiBwYW5lbFRhYlVybCh0YWIudXJsKSk7XG4gICAgICAgIHRhYnMuc29ydCgoYSwgYikgPT4gTnVtYmVyKCEhYi5hY3RpdmUpIC0gTnVtYmVyKCEhYS5hY3RpdmUpIHx8IChiLmxhc3RBY2Nlc3NlZCB8fCAwKSAtIChhLmxhc3RBY2Nlc3NlZCB8fCAwKSB8fCBhLmlkIC0gYi5pZCk7XG4gICAgICAgIGZvciAoY29uc3QgdGFiIG9mIHRhYnMuc2xpY2UoMCwgMykpIHtcbiAgICAgICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHBhbmVsVGFiTWVzc2FnZSh0YWIuaWQsIHsgb3BlcmF0aW9uOiAnc2Vzc2lvbicgfSwgc2lnbmFsKTtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBpZiAocmVwbHk/Lm9rICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChyZXBseS50b2tlbiB8fCAnJykgJiYgdHlwZW9mIHJlcGx5Lmluc3RhbmNlID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICYmIHJlcGx5Lmluc3RhbmNlLmxlbmd0aCA8PSAxMDAgJiYgcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW46IHJlcGx5LnRva2VuLCBzYXZlZEF0OiBEYXRlLm5vdygpLCB0YWI6IHsgaWQ6IHRhYi5pZCwgaW5zdGFuY2U6IHJlcGx5Lmluc3RhbmNlIH0gfTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdG9rZW46IHJlcGx5LnRva2VuIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogQ2xvc2VkL25hdmlnYXRlZCB0YWJzIGFyZSBub3QgYW4gYXV0aGVudGljYXRlZCBzZXNzaW9uLiAqLyB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFJlcXVlc3RWaWFUYWIocmVxdWVzdCwgc2lnbmFsKSB7XG4gICAgY29uc3Qgcm91dGUgPSBwYW5lbFNlc3Npb24/LnRhYjtcbiAgICBpZiAoIXJvdXRlIHx8ICFwYW5lbFRhYlJlcXVlc3RBbGxvd2VkKHJlcXVlc3QpKSByZXR1cm4geyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LfQsNC/0YDQvtGBINC+0YLQutC70L7QvdGR0L0nIH07XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFwYW5lbFRhYlVybChjdXJyZW50Py51cmwpIHx8IHNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBldmVudDogc2lnbmFsLmFib3J0ZWQgPyAnYWJvcnQnIDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LLQutC70LDQtNC60LAg0LfQsNC60YDRi9GC0LAg0LjQu9C4INC40LfQvNC10L3QtdC90LAuINCf0L7QstGC0L7RgNC40YLQtSDQv9GA0L7QstC10YDQutGDIHBhbmVsLicgfTtcbiAgICBjb25zdCByZXBseSA9IGF3YWl0IHBhbmVsVGFiTWVzc2FnZShyb3V0ZS5pZCwgeyBvcGVyYXRpb246ICdyZXF1ZXN0JywgaW5zdGFuY2U6IHJvdXRlLmluc3RhbmNlLCByZXF1ZXN0IH0sIHNpZ25hbCk7XG4gICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBldmVudDogJ2Fib3J0JyB9O1xuICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHJvdXRlLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICBpZiAoIXJlcGx5Py5vayB8fCByZXBseS5pbnN0YW5jZSAhPT0gcm91dGUuaW5zdGFuY2UgfHwgIXBhbmVsVGFiVXJsKGFmdGVyPy51cmwpIHx8IHJlcGx5LnJlc3VsdD8uZXZlbnQgIT09ICdsb2FkJ1xuICAgICAgICB8fCAhTnVtYmVyLmlzSW50ZWdlcihyZXBseS5yZXN1bHQucmVzcG9uc2U/LnN0YXR1cykgfHwgcmVwbHkucmVzdWx0LnJlc3BvbnNlPy5maW5hbFVybCAhPT0gcmVxdWVzdC51cmwpIHtcbiAgICAgICAgaWYgKHBhbmVsU2Vzc2lvbj8udGFiID09PSByb3V0ZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ3Nlc3Npb24tbG9zdCcsIGRldGFpbDogeyByZWFzb246ICdjb250ZXh0JyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC60L7QvdGC0LXQutGB0YIg0LLQutC70LDQtNC60Lgg0LjQt9C80LXQvdC40LvRgdGPLiDQndCw0LbQvNC40YLQtSBwYW5lbCDQtNC70Y8g0L/QvtCy0YLQvtGA0L3QvtC5INC/0YDQvtCy0LXRgNC60LguJyB9O1xuICAgIH1cbiAgICByZXR1cm4gcmVwbHkucmVzdWx0O1xufVxuXG5mdW5jdGlvbiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodChmb3JjZSkge1xuICAgIC8vIEEgcXVldWVkIG5vcm1hbCBmbGlnaHQgbWF5IGhhdmUgcG9wdWxhdGVkIHRoZSBjYWNoZSBzaW5jZSBmb3JjZSB3YXMgcmVxdWVzdGVkLlxuICAgIGlmIChmb3JjZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICBjb25zdCBmbGlnaHQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICBmbGlnaHQucHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIFBBTkVMX1NFU1NJT05fVElNRU9VVCk7XG4gICAgICAgIGNvbnN0IGZhaWx1cmUgPSBhc3luYyAocmVhc29uLCBlcnJvcikgPT4ge1xuICAgICAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ3Nlc3Npb24tZmFpbGVkJywgZGV0YWlsOiB7IHJlYXNvbiB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgIHJldHVybiAoYXdhaXQgcmVjb3ZlclBhbmVsRnJvbVRhYihjb250cm9sbGVyLnNpZ25hbCkpIHx8IHsgb2s6IGZhbHNlLCByZWFzb24sIGVycm9yIH07XG4gICAgICAgIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBydWxlc1JlYWR5O1xuICAgICAgICAgICAgaWYgKHJ1bGVGYWlsdXJlIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBFcnJvcignUGFuZWwgdW5hdmFpbGFibGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ3RleHQvaHRtbCcgfSwgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgICAgICBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsVXJsID0gbmV3IFVSTChyZXNwb25zZS51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcpO1xuICAgICAgICAgICAgaWYgKGZpbmFsVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB8fCAhL15cXC9zZWFyY2hcXC8/JC8udGVzdChmaW5hbFVybC5wYXRobmFtZSlcbiAgICAgICAgICAgICAgICB8fCByZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDRhNC+0L3QvtCy0YvQuSDQstGF0L7QtCDQvdC10LTQvtGB0YLRg9C/0LXQvS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQsiDRjdGC0L7QvCDQv9GA0L7RhNC40LvQtSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHRva2VuID0gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGF3YWl0IHJlc3BvbnNlLnRleHQoKSk7XG4gICAgICAgICAgICBpZiAoIXRva2VuIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0L7QtNGC0LLQtdGA0LTQuNGC0Ywg0LLRhdC+0LQuINCe0YLQutGA0L7QudGC0LUgcGFuZWwuaGF0aWtvLnJ1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgLy8gTGFyYXZlbCBpc3N1ZXMgQ1NSRiBldmVuIGZvciBhbm9ueW1vdXMgbG9naW4gcGFnZXMuIENvbmZpcm0gYWNjZXNzXG4gICAgICAgICAgICAvLyB0byBhbiBhY3R1YWwgcHJvdGVjdGVkIHJlYWQtb25seSBBUEkgd2l0aCB0aGUgc2FtZSBicm93c2VyIGNvb2tpZXMuXG4gICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLCAnWC1SZXF1ZXN0ZWQtV2l0aCc6ICdYTUxIdHRwUmVxdWVzdCcgfSxcbiAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLCBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGF1dGhVcmwgPSBuZXcgVVJMKGF1dGgudXJsIHx8ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9hcGkvc2VhcmNoL2ZpbHRlcnMnKTtcbiAgICAgICAgICAgIGlmIChhdXRoLnN0YXR1cyA8IDIwMCB8fCBhdXRoLnN0YXR1cyA+PSAzMDAgfHwgYXV0aFVybC5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydSdcbiAgICAgICAgICAgICAgICB8fCBhdXRoVXJsLnBhdGhuYW1lICE9PSAnL2FwaS9zZWFyY2gvZmlsdGVycycgfHwgIS9hcHBsaWNhdGlvblxcL2pzb24vaS50ZXN0KGF1dGguaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoYXV0aC5zdGF0dXMgPj0gNTAwID8gJ25ldHdvcmsnIDogJ2F1dGgnLCAnUGFuZWw6INC90LXRgiDQtNC+0YHRgtGD0L/QsCDQuiBBUEkuINCe0YLQutGA0L7QudGC0LUg0LDQstGC0L7RgNC40LfQvtCy0LDQvdC90YPRjiBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBwcm9vZiA9IGF3YWl0IGF1dGguanNvbigpO1xuICAgICAgICAgICAgaWYgKCFwcm9vZiB8fCB0eXBlb2YgcHJvb2YgIT09ICdvYmplY3QnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIFBhbmVsIGF1dGggcHJvb2YnKTtcbiAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbiB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCduZXR3b3JrJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0YDQvtCy0LXRgNC40YLRjCDQstGF0L7QtC4g0J/RgNC+0LLQtdGA0YzRgtC1INGB0L7QtdC00LjQvdC10L3QuNC1INC4INC+0YLQutGA0YvRgtGD0Y4g0LLQutC70LDQtNC60YMgcGFuZWwuaGF0aWtvLnJ1LicpO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIGlmIChmb3JjZSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID09PSBmbGlnaHQpIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG4gICAgICAgIH1cbiAgICB9KSgpO1xuICAgIGlmIChmb3JjZSkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIGVsc2Ugbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIHJldHVybiBmbGlnaHQucHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gZ2V0UGFuZWxTZXNzaW9uKGZvcmNlKSB7XG4gICAgaWYgKGZvcmNlKSBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAocXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0KSByZXR1cm4gcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7XG4gICAgaWYgKGZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkge1xuICAgICAgICBjb25zdCBxdWV1ZWQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICAgICAgcXVldWVkLnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7IH1cbiAgICAgICAgICAgIGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IHF1ZXVlZCkgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodCh0cnVlKTtcbiAgICAgICAgfSkoKTtcbiAgICAgICAgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gcXVldWVkO1xuICAgICAgICByZXR1cm4gcXVldWVkLnByb21pc2U7XG4gICAgfVxuICAgIGlmICghZm9yY2UgJiYgcGFuZWxTZXNzaW9uICYmIERhdGUubm93KCkgLSBwYW5lbFNlc3Npb24uc2F2ZWRBdCA8IFBBTkVMX1NFU1NJT05fVFRMKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IHRydWUsIHRva2VuOiBwYW5lbFNlc3Npb24udG9rZW4gfSk7XG4gICAgaWYgKCFmb3JjZSAmJiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICByZXR1cm4gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpO1xufVxuIiwiLy8gRXh0ZW5zaW9uLW93bmVkIHByZXNlbnRhdGlvbi4gTm8gc2l0ZSBET00sIHRva2Vucywgb3IgY29udGVudC10YWIgYXVkaW8uXG5jb25zdCBPUkRFUl9OT1RJRklDQVRJT05fSUQgPSAnbWVtY2hhdC1vcmRlcnMnO1xuY29uc3QgT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSA9ICdtZW1jaGF0LW9yZGVyLW5vdGlmaWNhdGlvbi1leHBpcmUnO1xuZnVuY3Rpb24gb3JkZXJCZWFySWNvbihzaXplKSB7XG4gICAgY29uc3QgY2FudmFzID0gbmV3IE9mZnNjcmVlbkNhbnZhcyhzaXplLCBzaXplKSwgY3R4ID0gY2FudmFzLmdldENvbnRleHQoJzJkJyksIHMgPSBzaXplIC8gMzI7XG4gICAgY29uc3Qgb3ZhbCA9ICh4LCB5LCByeCwgcnksIGNvbG9yKSA9PiB7IGN0eC5maWxsU3R5bGUgPSBjb2xvcjsgY3R4LmJlZ2luUGF0aCgpOyBjdHguZWxsaXBzZSh4ICogcywgeSAqIHMsIHJ4ICogcywgcnkgKiBzLCAwLCAwLCBNYXRoLlBJICogMik7IGN0eC5maWxsKCk7IH07XG4gICAgb3ZhbCg3LCA3LCA2LCA2LCAnIzcxM2YyYScpOyBvdmFsKDI1LCA3LCA2LCA2LCAnIzcxM2YyYScpO1xuICAgIG92YWwoNywgNywgMywgMywgJyNkOGFhNzgnKTsgb3ZhbCgyNSwgNywgMywgMywgJyNkOGFhNzgnKTtcbiAgICBvdmFsKDE2LCAxOCwgMTQsIDEzLCAnIzk4NjIzYicpO1xuICAgIG92YWwoMTYsIDI0LCA4LCA2LCAnI2VkYzk5YicpO1xuICAgIG92YWwoMTAsIDE3LCAyLCAyLjUsICcjMjMxNTBlJyk7IG92YWwoMjIsIDE3LCAyLCAyLjUsICcjMjMxNTBlJyk7XG4gICAgb3ZhbCgxNiwgMjIsIDMsIDIsICcjMjMxNTBlJyk7IG92YWwoMTYsIDI2LCAyLCAxLCAnIzcxM2YyYScpO1xuICAgIHJldHVybiBjdHguZ2V0SW1hZ2VEYXRhKDAsIDAsIHNpemUsIHNpemUpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJVcGRhdGVJY29uKCkge1xuICAgIGlmICghY2hyb21lLmFjdGlvbj8uc2V0SWNvbikgcmV0dXJuO1xuICAgIGNvbnN0IGVuYWJsZWQgPSBvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEljb24oZW5hYmxlZCA/IHsgaW1hZ2VEYXRhOiB7IDE2OiBvcmRlckJlYXJJY29uKDE2KSwgMzI6IG9yZGVyQmVhckljb24oMzIpIH0gfSA6IHsgcGF0aDogJ2ljb24ucG5nJyB9KTtcbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldFRpdGxlKHsgdGl0bGU6IGVuYWJsZWQgPyAn8J+QuyDQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0LrQu9GO0YfRkdC9IMK3INCe0YLQutGA0YvRgtGMINCx0L7QutC+0LLRg9GOINC/0LDQvdC10LvRjCBNZW1jaGF0JyA6ICfQntGC0LrRgNGL0YLRjCDQnNC10LzRh9Cw0YIg0LIg0LHQvtC60L7QstC+0Lkg0L/QsNC90LXQu9C4JyB9KTtcbn1cbmxldCBvcmRlckF1ZGlvQ3JlYXRpbmcgPSBudWxsO1xubGV0IG9yZGVyQXVkaW9HZW5lcmF0aW9uID0gMDtcbmFzeW5jIGZ1bmN0aW9uIG9yZGVyU3RvcEF1ZGlvKCkge1xuICAgIG9yZGVyQXVkaW9HZW5lcmF0aW9uKys7XG4gICAgaWYgKCFjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cykgcmV0dXJuO1xuICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgaWYgKGNvbnRleHRzLmxlbmd0aCkgYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0YXJnZXQ6ICdtZW1jaGF0LW9mZnNjcmVlbicsIHR5cGU6ICdtZW1jaGF0OmF1ZGlvLXN0b3AnIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJFbnN1cmVBdWRpbygpIHtcbiAgICBpZiAob3JkZXJBdWRpb0NyZWF0aW5nKSByZXR1cm4gb3JkZXJBdWRpb0NyZWF0aW5nO1xuICAgIG9yZGVyQXVkaW9DcmVhdGluZyA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgICAgIGlmICghY29udGV4dHMubGVuZ3RoKSBhd2FpdCBjaHJvbWUub2Zmc2NyZWVuLmNyZWF0ZURvY3VtZW50KHsgdXJsOiAnb2Zmc2NyZWVuLmh0bWwnLCByZWFzb25zOiBbJ0FVRElPX1BMQVlCQUNLJ10sIGp1c3RpZmljYXRpb246ICdPbmUgc2hhcmVkIE1lbWNoYXQgb3JkZXIgYWxhcm0sIGluZGVwZW5kZW50IG9mIG9wZW4gTW95U2tsYWQgdGFicy4nIH0pO1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyQXVkaW9DcmVhdGluZyA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckF1ZGlvQ3JlYXRpbmc7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclBsYXlBdWRpbyhpc0N1cnJlbnQgPSAoKSA9PiB0cnVlKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG9yZGVyQXVkaW9HZW5lcmF0aW9uO1xuICAgIGF3YWl0IG9yZGVyRW5zdXJlQXVkaW8oKTtcbiAgICBpZiAoIWlzQ3VycmVudCgpIHx8IGdlbmVyYXRpb24gIT09IG9yZGVyQXVkaW9HZW5lcmF0aW9uKSByZXR1cm47XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHRhcmdldDogJ21lbWNoYXQtb2Zmc2NyZWVuJywgdHlwZTogJ21lbWNoYXQ6YXVkaW8tcGxheScgfSk7XG4gICAgaWYgKCFyZXNwb25zZT8ub2spIHRocm93IEVycm9yKCfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJQcmVzZW50UmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgY3VycmVudCA9ICgpID0+IGNvbmZpZyA9PT0gb3JkZXJDb25maWcgJiYgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgJiYgIWNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQ7XG4gICAgaWYgKCFyZXN1bHQub3JkZXJzLmxlbmd0aCB8fCAhY3VycmVudCgpKSByZXR1cm4gW107XG4gICAgY29uc3Qgbm90aWZ5ID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuZ2V0UGVybWlzc2lvbkxldmVsKCk7XG4gICAgICAgIGlmICghY3VycmVudCgpKSByZXR1cm47XG4gICAgICAgIGlmIChwZXJtaXNzaW9uICE9PSAnZ3JhbnRlZCcpIHRocm93IEVycm9yKCfQo9Cy0LXQtNC+0LzQu9C10L3QuNGPINC+0YLQutC70Y7Rh9C10L3RiyDQsiDQsdGA0LDRg9C30LXRgNC1Jyk7XG4gICAgICAgIGNvbnN0IG9yZGVycyA9IHJlc3VsdC5vcmRlcnM7XG4gICAgICAgIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZShPUkRFUl9OT1RJRklDQVRJT05fSUQsIHsgdHlwZTogJ2Jhc2ljJywgaWNvblVybDogJ2ljb24ucG5nJyxcbiAgICAgICAgICAgIHRpdGxlOiAn8J+QuyBNZW1jaGF0IMK3INCX0LDQutCw0LfRizogJyArIG9yZGVycy5sZW5ndGgsXG4gICAgICAgICAgICBtZXNzYWdlOiBvcmRlcnMuc2xpY2UoMCwgMykubWFwKGl0ZW0gPT4gU3RyaW5nKGl0ZW0ubmFtZSkuc2xpY2UoMCwgODApICsgJyDCtyAnICsgU3RyaW5nKGl0ZW0ub3JnYW5pemF0aW9uTmFtZSkuc2xpY2UoMCwgODApKS5qb2luKCdcXG4nKSArIChyZXN1bHQucGFydGlhbCA/ICdcXG7imqAg0J7Qv9GA0L7RgSDQvdC10L/QvtC70L3Ri9C5JyA6ICcnKSxcbiAgICAgICAgICAgIHByaW9yaXR5OiAwLCBzaWxlbnQ6IHRydWUsIHJlcXVpcmVJbnRlcmFjdGlvbjogY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzID09PSAwIH0pO1xuICAgICAgICBpZiAoIWN1cnJlbnQoKSkgeyBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpOyByZXR1cm47IH1cbiAgICAgICAgaWYgKGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyA+IDApIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlksIHsgd2hlbjogRGF0ZS5ub3coKSArIGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyAqIDYwMDAwIH0pO1xuICAgICAgICBlbHNlIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgfTtcbiAgICBjb25zdCB0YXNrcyA9IFtub3RpZnkoKV07XG4gICAgaWYgKGNvbmZpZy5zZXR0aW5ncy5zb3VuZEVuYWJsZWQpIHRhc2tzLnB1c2gob3JkZXJQbGF5QXVkaW8oY3VycmVudCkpO1xuICAgIGNvbnN0IG91dGNvbWVzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRhc2tzKTtcbiAgICByZXR1cm4gb3V0Y29tZXMuZmxhdE1hcCgoaXRlbSwgaW5kZXgpID0+IGl0ZW0uc3RhdHVzID09PSAncmVqZWN0ZWQnID8gW2luZGV4ID09PSAwID8gJ9Ch0LjRgdGC0LXQvNC90YvQtSDRg9Cy0LXQtNC+0LzQu9C10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QvdGLJyA6ICfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvSddIDogW10pO1xufVxuaWYgKGNocm9tZS5ub3RpZmljYXRpb25zPy5vbkNsaWNrZWQpIGNocm9tZS5ub3RpZmljYXRpb25zLm9uQ2xpY2tlZC5hZGRMaXN0ZW5lcihpZCA9PiB7XG4gICAgaWYgKGlkICE9PSBPUkRFUl9OT1RJRklDQVRJT05fSUQpIHJldHVybjtcbiAgICBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydS9hcHAvI2N1c3RvbWVyb3JkZXInLCBhY3RpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKS5jYXRjaCgoKSA9PiB7fSk7XG59KTtcbiIsIi8vIFNoYXJlZCBvcmRlciBwb2xsaW5nIGlzIGluZGVwZW5kZW50IG9mIHRoZSBsaWZldGltZS9udW1iZXIgb2YgY29udGVudCB0YWJzLlxuLy8gU2Vzc2lvbiBzdG9yYWdlIGlzIGV4dGVuc2lvbi1wcml2YXRlOyBiZWFyZXIgbmV2ZXIgZW50ZXJzIGEgYnJvYWRjYXN0IG9yIGxvZ3MuXG5jb25zdCBPUkRFUl9TRVNTSU9OX0tFWSA9ICdtZW1jaGF0T3JkZXJTZXJ2aWNlX3YxJztcbmxldCBvcmRlckNvbmZpZyA9IG51bGw7XG5sZXQgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoKTtcbmxldCBvcmRlclJldmlzaW9uID0gMDtcbmxldCBvcmRlckZsaWdodCA9IG51bGw7XG5sZXQgb3JkZXJDb250cm9sbGVyID0gbnVsbDtcbmxldCBvcmRlckxhc3RSZXN1bHQgPSBudWxsO1xubGV0IG9yZGVyQ29uZmlnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmZ1bmN0aW9uIG9yZGVyTXV0YXRlKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgbmV4dCA9IG9yZGVyQ29uZmlnQ2hhaW4udGhlbihjYWxsYmFjayk7XG4gICAgb3JkZXJDb25maWdDaGFpbiA9IG5leHQuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBuZXh0O1xufVxuY29uc3Qgb3JkZXJSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoT1JERVJfU0VTU0lPTl9LRVkpKVtPUkRFUl9TRVNTSU9OX0tFWV07XG4gICAgICAgIGlmIChzYXZlZCkgeyBvcmRlckNvbmZpZyA9IHNhdmVkLmNvbmZpZzsgb3JkZXJSZXZpc2lvbiA9IHNhdmVkLnJldmlzaW9uIHx8IDA7IG9yZGVyU3Vic2NyaWJlcnMgPSBuZXcgU2V0KHNhdmVkLnN1YnNjcmliZXJzIHx8IFtdKTsgfVxuICAgICAgICBhd2FpdCBvcmRlclVwZGF0ZUljb24oKTtcbiAgICB9IGNhdGNoIHsgLyogQ29uZmlndXJlIG11c3Qgc3VjY2Vzc2Z1bGx5IHBlcnNpc3QgYmVmb3JlIGVuYWJsaW5nIHBvbGxpbmcuICovIH1cbn0pKCk7XG5mdW5jdGlvbiBvcmRlclB1YmxpY0NvbmZpZygpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgc2V0dGluZ3M6IG9yZGVyQ29uZmlnPy5zZXR0aW5ncywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gfTtcbn1cbmZ1bmN0aW9uIG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgbmV3IFJlZ0V4cCgnXmh0dHBzOi8vYXBpXFxcXC5tb3lza2xhZFxcXFwucnUvYXBpL3JlbWFwLzFcXFxcLjIvZW50aXR5LycgKyBraW5kICsgJy9bQS1aYS16MC05LV0rJCcpLnRlc3QodmFsdWUpO1xufVxuZnVuY3Rpb24gb3JkZXJTZXR0aW5ncyhyYXcpIHtcbiAgICBjb25zdCByZWZzID0gKHZhbHVlcywga2luZCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWVzKSB8fCAhdmFsdWVzLmV2ZXJ5KHZhbHVlID0+IG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHJlZmVyZW5jZXMnKTtcbiAgICAgICAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyldO1xuICAgIH07XG4gICAgcmV0dXJuIHsgZW5hYmxlZDogcmF3Py5lbmFibGVkICE9PSBmYWxzZSwgc291bmRFbmFibGVkOiByYXc/LnNvdW5kRW5hYmxlZCAhPT0gZmFsc2UsXG4gICAgICAgIGludGVydmFsTWludXRlczogTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChOdW1iZXIocmF3Py5pbnRlcnZhbE1pbnV0ZXMpIHx8IDEpKSksXG4gICAgICAgIHRvYXN0RHVyYXRpb25NaW51dGVzOiBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKE51bWJlcihyYXc/LnRvYXN0RHVyYXRpb25NaW51dGVzKSB8fCAwKSkpLFxuICAgICAgICBvcmdhbml6YXRpb25IcmVmczogcmVmcyhyYXc/Lm9yZ2FuaXphdGlvbkhyZWZzLCAnb3JnYW5pemF0aW9uJyksXG4gICAgICAgIHN0YXR1c0hyZWZzOiByZWZzKHJhdz8uc3RhdHVzSHJlZnMsICdjdXN0b21lcm9yZGVyL21ldGFkYXRhL3N0YXRlcycpIH07XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclNldEFsYXJtKCkge1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgfHwgIW9yZGVyQ29uZmlnLnNldHRpbmdzLnNvdW5kRW5hYmxlZCkgYXdhaXQgb3JkZXJTdG9wQXVkaW8oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCAmJiBjaHJvbWUubm90aWZpY2F0aW9ucz8uY2xlYXIpIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIC8vIFRvb2xiYXIgcHJlc2VudGF0aW9uIG11c3QgbmV2ZXIgcHJldmVudCBzY2hlZHVsaW5nIG9yIHBhdXNpbmcgdGhlIHNlcnZpY2UuXG4gICAgYXdhaXQgb3JkZXJVcGRhdGVJY29uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmICghY2hyb21lLmFsYXJtcykgcmV0dXJuO1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQpIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgaWYgKG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCAmJiBvcmRlckNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoJ21lbWNoYXQtb3JkZXJzJywgeyBwZXJpb2RJbk1pbnV0ZXM6IG9yZGVyQ29uZmlnLnNldHRpbmdzLmludGVydmFsTWludXRlcyB9KTtcbiAgICB9IGVsc2UgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcignbWVtY2hhdC1vcmRlcnMnKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgIGlmICh0eXBlb2YgbWVzc2FnZS50b2tlbiAhPT0gJ3N0cmluZycgfHwgIW1lc3NhZ2UudG9rZW4udHJpbSgpIHx8IG1lc3NhZ2UudG9rZW4ubGVuZ3RoID4gNDA5NikgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdG9rZW4nKTtcbiAgICBjb25zdCBzZXR0aW5ncyA9IG9yZGVyU2V0dGluZ3MobWVzc2FnZS5zZXR0aW5ncyk7XG4gICAgY29uc3QgdW5jaGFuZ2VkID0gb3JkZXJDb25maWc/LnRva2VuID09PSBtZXNzYWdlLnRva2VuICYmIEpTT04uc3RyaW5naWZ5KG9yZGVyQ29uZmlnLnNldHRpbmdzKSA9PT0gSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpO1xuICAgIGlmIChvcmRlckNvbmZpZyAmJiAobWVzc2FnZS51cGRhdGUgIT09IHRydWUgfHwgdW5jaGFuZ2VkKSkge1xuICAgICAgICBpZiAob3JkZXJDb25maWcudG9rZW4gIT09IG1lc3NhZ2UudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIGVycm9yOiAn0JTRgNGD0LPQvtC5IEJlYXJlciDQsiDRhNC+0L3QtS4g0KHQvtGF0YDQsNC90LjRgtC1INC90LDRgdGC0YDQvtC50LrQuCDRj9Cy0L3QviDQtNC70Y8g0YHQvNC10L3RiyDQsNC60LrQsNGD0L3RgtCwLicgfTtcbiAgICAgICAgaWYgKHNlbmRlci50YWIpIG9yZGVyU3Vic2NyaWJlcnMuYWRkKHNlbmRlci50YWIuaWQpO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnOiBvcmRlckNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgaWYgKGNocm9tZS5hbGFybXM/LmdldCAmJiAhKGF3YWl0IGNocm9tZS5hbGFybXMuZ2V0KCdtZW1jaGF0LW9yZGVycycpKSkgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBwb2xsUmVxdWlyZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChvcmRlckNvbmZpZyAmJiBtZXNzYWdlLnJldmlzaW9uICE9PSBvcmRlclJldmlzaW9uKSByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBvazogZmFsc2UsIGNvbmZsaWN0OiB0cnVlLCBlcnJvcjogJ9Cd0LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLINCyINC00YDRg9Cz0L7QuSDQstC60LvQsNC00LrQtS4g0J/QvtCy0YLQvtGA0LjRgtC1INC40LfQvNC10L3QtdC90LjQtS4nIH07XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gPyBuZXcgU2V0KG9yZGVyU3Vic2NyaWJlcnMpIDogbmV3IFNldCgpO1xuICAgIGlmIChzZW5kZXIudGFiKSBzdWJzY3JpYmVycy5hZGQoc2VuZGVyLnRhYi5pZCk7XG4gICAgY29uc3QgY29uZmlnID0geyB0b2tlbjogbWVzc2FnZS50b2tlbiwgc2V0dGluZ3MsIG9yZ2FuaXphdGlvbnM6IChBcnJheS5pc0FycmF5KG1lc3NhZ2Uub3JnYW5pemF0aW9ucykgPyBtZXNzYWdlLm9yZ2FuaXphdGlvbnMgOiBbXSlcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IHNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmluY2x1ZGVzKGl0ZW0/LmhyZWYpKS5tYXAoaXRlbSA9PiAoeyBocmVmOiBpdGVtLmhyZWYsIG5hbWU6IFN0cmluZyhpdGVtLm5hbWUgfHwgJycpLnNsaWNlKDAsIDMwMCkgfSkpIH07XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gKyAxLCBzdWJzY3JpYmVyczogWy4uLnN1YnNjcmliZXJzXSB9IH0pO1xuICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICBvcmRlckNvbmZpZyA9IGNvbmZpZzsgb3JkZXJTdWJzY3JpYmVycyA9IHN1YnNjcmliZXJzOyBvcmRlclJldmlzaW9uKys7IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG4gICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIHBvbGxSZXF1aXJlZDogdHJ1ZSB9O1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJHZXQocGF0aCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwZXJmb3JtUmVxdWVzdCh7IGlkOiAnYmFja2dyb3VuZC1vcmRlcnMnLCByZXF1ZXN0OiB7XG4gICAgICAgIHVybDogJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjInICsgcGF0aCwgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyICcgKyBjb25maWcudG9rZW4sIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfSxcbiAgICAgICAgYW5vbnltb3VzOiB0cnVlLCBiYWNrZ3JvdW5kT3JkZXI6IHRydWVcbiAgICB9IH0sIHsgdGFiOiB7IGlkOiAtMSB9LCBmcmFtZUlkOiAwIH0sIGNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSB0aHJvdyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgaWYgKHJlc3BvbnNlLmV2ZW50ICE9PSAnbG9hZCcpIHRocm93IEVycm9yKCfQntGI0LjQsdC60LAg0YHQvtC10LTQuNC90LXQvdC40Y8g0YEg0JzQvtC50KHQutC70LDQtCcpO1xuICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cztcbiAgICBpZiAoc3RhdHVzIDwgMjAwIHx8IHN0YXR1cyA+PSAzMDApIHsgY29uc3QgZXJyb3IgPSBFcnJvcign0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgc3RhdHVzKTsgZXJyb3Iuc3RhdHVzID0gc3RhdHVzOyB0aHJvdyBlcnJvcjsgfVxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7IGRhdGEgPSBKU09OLnBhcnNlKHJlc3BvbnNlLnJlc3BvbnNlLnJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyB0aHJvdyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INC+0YLQstC10YIg0JzQvtC50KHQutC70LDQtCcpOyB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGE/LnJvd3MpKSB0aHJvdyBFcnJvcign0J3QtdC/0L7Qu9C90YvQuSDQvtGC0LLQtdGCINGB0L/QuNGB0LrQsCDQt9Cw0LrQsNC30L7QsicpO1xuICAgIHJldHVybiBkYXRhO1xufVxuYXN5bmMgZnVuY3Rpb24gZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbikge1xuICAgIGlmICghY2hyb21lLnRhYnM/LnF1ZXJ5KSByZXR1cm47XG4gICAgY29uc3QgdGFicyA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHt9KTtcbiAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHRhYnMuZmlsdGVyKHRhYiA9PiBvcmRlclN1YnNjcmliZXJzLmhhcyh0YWIuaWQpICYmIHRydXN0ZWRDb250ZW50U2VuZGVyKHsgaWQ6IGNocm9tZS5ydW50aW1lLmlkLCB0YWIsIGZyYW1lSWQ6IDAsIHVybDogdGFiLnVybCB9KSk7XG4gICAgY2FuZGlkYXRlcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoISFiLmFjdGl2ZSkgLSBOdW1iZXIoISFhLmFjdGl2ZSkpO1xuICAgIGZvciAoY29uc3QgdGFiIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSwgeyBmcmFtZUlkOiAwIH0pO1xuICAgICAgICAgICAgaWYgKGFjaz8ub2spIHJldHVybjtcbiAgICAgICAgfSBjYXRjaCB7IC8qIFRyeSBhbm90aGVyIGxpdmUgY29udGVudCB3b3JsZCwgbm90IGV2ZXJ5IHRhYi4gKi8gfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hdGl2ZSBvZiBuYXRpdmVSdW50aW1lU2Vzc2lvbnMudmFsdWVzKCkpIHtcbiAgICAgICAgaWYgKG5hdGl2ZS5vcmRlclRva2VuICE9PSBjb25maWcudG9rZW4gfHwgbmF0aXZlLm9yZGVyUmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgY29udGludWU7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQobmF0aXZlLnNlbmRlciwgJ0JlYXJlciAnICsgY29uZmlnLnRva2VuKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBuYXRpdmVSdW50aW1lUmVxdWVzdChuYXRpdmUsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSk7XG4gICAgICAgICAgICBpZiAoYWNrPy5vaykgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogQSBjbG9zZWQgbmF0aXZlIGRvY3VtZW50IGlzIG5vdCBhbm90aGVyIHN1YnNjcmliZXIuICovIH1cbiAgICB9XG59XG5hc3luYyBmdW5jdGlvbiBwb2xsT3JkZXJzKCkge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgYXdhaXQgb3JkZXJDb25maWdDaGFpbjtcbiAgICBpZiAob3JkZXJGbGlnaHQpIHJldHVybiBvcmRlckZsaWdodDtcbiAgICBjb25zdCBjb25maWcgPSBvcmRlckNvbmZpZztcbiAgICBpZiAoIWNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCB8fCAhY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCB8fCAhY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLRi9C60LvRjtGH0LXQvSDQuNC70Lgg0L3QtSDQvdCw0YHRgtGA0L7QtdC9JyB9O1xuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHJldmlzaW9uID0gb3JkZXJSZXZpc2lvbjtcbiAgICAgICAgb3JkZXJDb250cm9sbGVyID0gY29udHJvbGxlcjtcbiAgICBvcmRlckZsaWdodCA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gbmV3IE1hcCgpLCBmYWlsZWQgPSBbXTtcbiAgICAgICAgbGV0IGF1dGhGYWlsZWQgPSBmYWxzZTtcbiAgICAgICAgZm9yIChjb25zdCBocmVmIG9mIGNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcykge1xuICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBjb25maWcub3JnYW5pemF0aW9ucy5maW5kKGl0ZW0gPT4gaXRlbS5ocmVmID09PSBocmVmKT8ubmFtZSB8fCAn0J7RgNCz0LDQvdC40LfQsNGG0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsCc7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICAgICAgbGV0IG9mZnNldCA9IDA7XG4gICAgICAgICAgICAgICAgZm9yICg7Oykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBmaWx0ZXIgPSBbJ29yZ2FuaXphdGlvbj0nICsgaHJlZiwgLi4uY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLm1hcChzdGF0ZSA9PiAnc3RhdGU9JyArIHN0YXRlKV0uam9pbignOycpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgb3JkZXJHZXQoJy9lbnRpdHkvY3VzdG9tZXJvcmRlcj9maWx0ZXI9JyArIGVuY29kZVVSSUNvbXBvbmVudChmaWx0ZXIpXG4gICAgICAgICAgICAgICAgICAgICAgICArICcmZXhwYW5kPXN0YXRlLG9yZ2FuaXphdGlvbiZvcmRlcj1tb21lbnQsZGVzYyZsaW1pdD0xMDAmb2Zmc2V0PScgKyBvZmZzZXQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gcm93cy5zaXplO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiBkYXRhLnJvd3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghcm93Py5pZCkgdGhyb3cgRXJyb3IoJ9CX0LDQutCw0Lcg0LHQtdC3INC40LTQtdC90YLQuNGE0LjQutCw0YLQvtGA0LAnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd3Muc2V0KHJvdy5pZCwgcm93KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBvZmZzZXQgKz0gZGF0YS5yb3dzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW9yZSA9ICEhZGF0YS5tZXRhPy5uZXh0SHJlZiB8fCAoTnVtYmVyLmlzRmluaXRlKGRhdGEubWV0YT8uc2l6ZSkgPyBvZmZzZXQgPCBkYXRhLm1ldGEuc2l6ZSA6IGRhdGEucm93cy5sZW5ndGggPj0gMTAwKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3JlKSBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFkYXRhLnJvd3MubGVuZ3RoIHx8IHJvd3Muc2l6ZSA9PT0gcHJldmlvdXMpIHRocm93IEVycm9yKCfQn9Cw0LPQuNC90LDRhtC40Y8g0LfQsNC60LDQt9C+0LIg0L3QtSDQv9GA0L7QtNCy0LjQs9Cw0LXRgtGB0Y8nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2Ygcm93cy52YWx1ZXMoKSkgaWYgKGNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5pbmNsdWRlcyhyb3cuc3RhdGU/Lm1ldGE/LmhyZWYpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kLnNldChyb3cuaWQsIHsgaWQ6IHJvdy5pZCwgbmFtZTogcm93Lm5hbWUgfHwgcm93LmlkLCBzdGF0ZU5hbWU6IHJvdy5zdGF0ZT8ubmFtZSB8fCAn0J3QvtCy0YvQuScsIG9yZ2FuaXphdGlvbk5hbWU6IGxhYmVsLCBvcmdhbml6YXRpb25IcmVmOiBocmVmIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L06INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLJyB9O1xuICAgICAgICAgICAgICAgIGZhaWxlZC5wdXNoKGxhYmVsICsgJyDigJQgJyArIChlcnJvci5tZXNzYWdlIHx8ICfQntGI0LjQsdC60LAg0LfQsNC/0YDQvtGB0LAnKSk7XG4gICAgICAgICAgICAgICAgaWYgKFs0MDEsIDQwM10uaW5jbHVkZXMoZXJyb3Iuc3RhdHVzKSkgeyBhdXRoRmFpbGVkID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScgfTtcbiAgICAgICAgaWYgKGF1dGhGYWlsZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICAgICAgICAgICAgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnLCByZXZpc2lvbjogKytvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L0nIH07XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHsgaWQ6IFN0cmluZyhEYXRlLm5vdygpKSArICctJyArIG9yZGVyUmV2aXNpb24sIG9yZGVyczogWy4uLmZvdW5kLnZhbHVlcygpXSwgZmFpbGVkLCBwYXJ0aWFsOiBmYWlsZWQubGVuZ3RoID4gMCxcbiAgICAgICAgICAgIGJlYXJlcjogYXV0aEZhaWxlZCA/ICdlcnJvcicgOiBmYWlsZWQubGVuZ3RoID09PSBjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoID8gJ3Vua25vd24nIDogJ29rJywgYXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgcmVzdWx0Lm9yZGVycy5mb3JFYWNoKG9yZGVyID0+IHsgb3JkZXIucGFydGlhbCA9IHJlc3VsdC5wYXJ0aWFsOyB9KTtcbiAgICAgICAgb3JkZXJMYXN0UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICByZXN1bHQuYWxlcnRXYXJuaW5ncyA9IGF3YWl0IG9yZGVyUHJlc2VudFJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9OiDQvdCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiycgfTtcbiAgICAgICAgYXdhaXQgZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbik7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZXN1bHQgfTtcbiAgICB9KSgpLmZpbmFsbHkoKCkgPT4geyBvcmRlckZsaWdodCA9IG51bGw7IGlmIChvcmRlckNvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIG9yZGVyQ29udHJvbGxlciA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckZsaWdodDtcbn1cbmlmIChjaHJvbWUuYWxhcm1zKSBjaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoYWxhcm0gPT4ge1xuICAgIGlmIChhbGFybS5uYW1lID09PSBPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKSByZXR1cm4gY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0lEKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKGFsYXJtLm5hbWUgPT09ICdtZW1jaGF0LW9yZGVycycpIHJldHVybiBwb2xsT3JkZXJzKCkuY2F0Y2goKCkgPT4ge30pO1xufSk7XG4iLCIvLyBOYXRpdmUgcnVudGltZSBpZGVudGl0aWVzIGFyZSByZWFsIENocm9tZSBNZXNzYWdlU2VuZGVycywgbmV2ZXIgc3ludGhldGljIHRhYnMuXG4vLyBBIG9uZS11c2UgY2FwYWJpbGl0eSwgZGVsaXZlcmVkIG9ubHkgdG8gYSB2ZXJpZmllZCBTSURFX1BBTkVMIGRvY3VtZW50LCBiaW5kc1xuLy8gaXRzIGNoaWxkIHBvcnQgdG8gb25lIHdpbmRvdy9vcmlnaW4gZm9yIGl0cyBlbnRpcmUgbGlmZXRpbWUuXG5jb25zdCBuYXRpdmVSdW50aW1lSWRlbnRpdGllcyA9IG5ldyBXZWFrTWFwKCk7XG5jb25zdCBuYXRpdmVSdW50aW1lU2Vzc2lvbnMgPSBuZXcgTWFwKCk7XG5jb25zdCBuYXRpdmVSdW50aW1lVGlja2V0cyA9IG5ldyBNYXAoKTtcbmxldCBuYXRpdmVEcmFmdENoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5jb25zdCBOQVRJVkVfTEFTVF9PUklHSU5fS0VZID0gJ21lbWNoYXROYXRpdmVMYXN0T3JpZ2luX3YxJztcbmxldCBuYXRpdmVTZWxlY3Rpb25DaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwob3JpZ2luKTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gPT09IG9yaWdpbiAmJiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmRcbiAgICAgICAgICAgICYmIE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5wYWdlTWF0Y2hlcy5zb21lKHBhdHRlcm4gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGhvc3QgPSBuZXcgVVJMKHBhdHRlcm4ucmVwbGFjZSgnKi4nLCAnd2lsZGNhcmQuJykpLmhvc3RuYW1lLnJlcGxhY2UoJ3dpbGRjYXJkLicsICcqLicpO1xuICAgICAgICAgICAgICAgIHJldHVybiBob3N0LnN0YXJ0c1dpdGgoJyouJykgPyB1cmwuaG9zdG5hbWUgPT09IGhvc3Quc2xpY2UoMikgfHwgdXJsLmhvc3RuYW1lLmVuZHNXaXRoKCcuJyArIGhvc3Quc2xpY2UoMikpIDogdXJsLmhvc3RuYW1lID09PSBob3N0O1xuICAgICAgICAgICAgfSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuZnVuY3Rpb24gbmF0aXZlRG9jdW1lbnRVcmwocmF3LCBxdWVyeSwgaGFzaCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gPT09IG5ldyBVUkwoY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpKS5vcmlnaW4gJiYgdXJsLnBhdGhuYW1lID09PSAnL29mZnNjcmVlbi5odG1sJ1xuICAgICAgICAgICAgJiYgdXJsLmhhc2ggPT09ICcjJyArIGhhc2ggJiYgbmV3IFJlZ0V4cCgnXlxcXFw/JyArIHF1ZXJ5ICsgJz1bYS1mMC05LV17MzZ9JCcpLnRlc3QodXJsLnNlYXJjaCk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuY29uc3QgbmF0aXZlUGFuZWxXaW5kb3dzID0gbmV3IE1hcCgpO1xuYXN5bmMgZnVuY3Rpb24gbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIHdpbmRvd0lkKSB7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHdpbmRvd0lkKSB8fCB3aW5kb3dJZCA8IDAgfHwgc2VuZGVyPy5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydTSURFX1BBTkVMJ10sIGRvY3VtZW50VXJsczogW3NlbmRlci51cmxdIH0pO1xuICAgIGNvbnN0IGNvbnRleHQgPSBjb250ZXh0cy5maW5kKGNvbnRleHQgPT4gY29udGV4dC5jb250ZXh0VHlwZSA9PT0gJ1NJREVfUEFORUwnICYmIGNvbnRleHQuZG9jdW1lbnRVcmwgPT09IHNlbmRlci51cmxcbiAgICAgICAgJiYgKCFzZW5kZXIuZG9jdW1lbnRJZCB8fCBjb250ZXh0LmRvY3VtZW50SWQgPT09IHNlbmRlci5kb2N1bWVudElkKSk7XG4gICAgaWYgKCFjb250ZXh0KSB7IG5hdGl2ZVBhbmVsV2luZG93cy5kZWxldGUoc2VuZGVyLnVybCk7IHJldHVybiBmYWxzZTsgfVxuICAgIC8vIENocm9tZSByZXBvcnRzIHdpbmRvd0lkPS0xIGZvciBhIGdsb2JhbCBTSURFX1BBTkVMIChvYnNlcnZlZCBpbiBDaHJvbWl1bSkuXG4gICAgLy8gT25seSBvdXIgdmVyaWZpZWQgbmF0aXZlIFVJIGNhbiBlc3RhYmxpc2ggdGhpcyBmaXJzdCBiaW5kaW5nOyBpdCBvYnRhaW5zXG4gICAgLy8gaXRzIHdpbmRvdyB2aWEgd2luZG93cy5nZXRDdXJyZW50KCkuIE5ldmVyIGxldCBhIGRvY3VtZW50IHJldGFyZ2V0IGxhdGVyLlxuICAgIGlmIChjb250ZXh0LndpbmRvd0lkICE9PSAtMSAmJiBjb250ZXh0LndpbmRvd0lkICE9PSB3aW5kb3dJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghbmF0aXZlUGFuZWxXaW5kb3dzLmhhcyhzZW5kZXIudXJsKSkgbmF0aXZlUGFuZWxXaW5kb3dzLnNldChzZW5kZXIudXJsLCB3aW5kb3dJZCk7XG4gICAgcmV0dXJuIG5hdGl2ZVBhbmVsV2luZG93cy5nZXQoc2VuZGVyLnVybCkgPT09IHdpbmRvd0lkO1xufVxuYXN5bmMgZnVuY3Rpb24gbmF0aXZlTGFzdE9yaWdpbigpIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IG5hdGl2ZVNlbGVjdGlvbkNoYWluO1xuICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV07XG4gICAgcmV0dXJuIG5hdGl2ZVN1cHBvcnRlZE9yaWdpbihzYXZlZCkgPyBzYXZlZCA6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydSc7XG59XG5mdW5jdGlvbiBuYXRpdmVSZW1lbWJlck9yaWdpbihvcmlnaW4pIHtcbiAgICBjb25zdCB3b3JrID0gbmF0aXZlU2VsZWN0aW9uQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmICghbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikpIHRocm93IEVycm9yKCdJbnZhbGlkIG9yaWdpbicpO1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV0gPT09IG9yaWdpbikgcmV0dXJuO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV06IG9yaWdpbiB9KTtcbiAgICAgICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTkFUSVZFX0xBU1RfT1JJR0lOX0tFWSkpW05BVElWRV9MQVNUX09SSUdJTl9LRVldICE9PSBvcmlnaW4pIHRocm93IEVycm9yKCdTZWxlY3Rpb24gbm90IGR1cmFibGUnKTtcbiAgICB9KTtcbiAgICBuYXRpdmVTZWxlY3Rpb25DaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrO1xufVxuYXN5bmMgZnVuY3Rpb24gbmF0aXZlUnVudGltZVRpY2tldChzZW5kZXIsIHdpbmRvd0lkLCBvcmlnaW4pIHtcbiAgICBpZiAoIW5hdGl2ZVN1cHBvcnRlZE9yaWdpbihvcmlnaW4pIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgd2luZG93SWQpKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgaWRlbnRpdHknKTtcbiAgICBmb3IgKGNvbnN0IFt0aWNrZXQsIGJpbmRpbmddIG9mIG5hdGl2ZVJ1bnRpbWVUaWNrZXRzKSBpZiAoYmluZGluZy5leHBpcmVzIDwgRGF0ZS5ub3coKSB8fCBiaW5kaW5nLnBhcmVudC51cmwgPT09IHNlbmRlci51cmwgJiYgYmluZGluZy5vcmlnaW4gPT09IG9yaWdpbikgbmF0aXZlUnVudGltZVRpY2tldHMuZGVsZXRlKHRpY2tldCk7XG4gICAgY29uc3QgdGlja2V0ID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICBuYXRpdmVSdW50aW1lVGlja2V0cy5zZXQodGlja2V0LCB7IHBhcmVudDogc2VuZGVyLCB3aW5kb3dJZCwgb3JpZ2luLCBleHBpcmVzOiBEYXRlLm5vdygpICsgMTUwMDAgfSk7XG4gICAgcmV0dXJuIHRpY2tldDtcbn1cbmZ1bmN0aW9uIHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgeyByZXR1cm4gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuaGFzKHNlbmRlcik7IH1cbmZ1bmN0aW9uIHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKSB7XG4gICAgY29uc3QgbmF0aXZlID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKG5hdGl2ZSkgcmV0dXJuIG5hdGl2ZS5vcmlnaW47XG4gICAgaWYgKHR5cGVvZiB0cnVzdGVkQ29udGVudFNlbmRlciA9PT0gJ2Z1bmN0aW9uJyAmJiB0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSByZXR1cm4gbmV3IFVSTChzZW5kZXIudXJsKS5vcmlnaW47XG4gICAgdGhyb3cgRXJyb3IoJ1VuYm91bmQgcnVudGltZSBpZGVudGl0eScpO1xufVxuLy8gVHJhY2sgYWN0dWFsIGZvY3VzZWQtc2l0ZSB1c2UsIG5vdCBwZXJpb2RpYyBzbmFwc2hvdHMgZnJvbSBhIGJhY2tncm91bmQgd2luZG93LlxubGV0IG5hdGl2ZUZvY3VzR2VuZXJhdGlvbiA9IDA7XG5hc3luYyBmdW5jdGlvbiBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyh3aW5kb3dJZCkge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSArK25hdGl2ZUZvY3VzR2VuZXJhdGlvbjtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB3aW5kb3cgPSBhd2FpdCBjaHJvbWUud2luZG93cy5nZXQod2luZG93SWQpO1xuICAgICAgICBpZiAoIXdpbmRvdy5mb2N1c2VkKSByZXR1cm47XG4gICAgICAgIGNvbnN0IFt0YWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkIH0pO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiA9PT0gbmF0aXZlRm9jdXNHZW5lcmF0aW9uICYmIHN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSBhd2FpdCBuYXRpdmVSZW1lbWJlck9yaWdpbihuZXcgVVJMKHRhYi51cmwpLm9yaWdpbik7XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC91bmF2YWlsYWJsZSB3aW5kb3cgbXVzdCBub3QgY2hhbmdlIHRoZSBzYXZlZCBzZWxlY3Rpb24uICovIH1cbn1cbmNocm9tZS50YWJzPy5vbkFjdGl2YXRlZD8uYWRkTGlzdGVuZXIoaW5mbyA9PiB7IHZvaWQgbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3coaW5mby53aW5kb3dJZCk7IH0pO1xuY2hyb21lLnRhYnM/Lm9uVXBkYXRlZD8uYWRkTGlzdGVuZXIoKGlkLCBjaGFuZ2UsIHRhYikgPT4geyBpZiAodGFiLmFjdGl2ZSAmJiBjaGFuZ2UudXJsKSB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHRhYi53aW5kb3dJZCk7IH0pO1xuY2hyb21lLndpbmRvd3M/Lm9uRm9jdXNDaGFuZ2VkPy5hZGRMaXN0ZW5lcih3aW5kb3dJZCA9PiB7IGlmICh3aW5kb3dJZCA+PSAwKSB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvd0lkKTsgZWxzZSBuYXRpdmVGb2N1c0dlbmVyYXRpb24rKzsgfSk7XG5pZiAoY2hyb21lLndpbmRvd3M/LmdldExhc3RGb2N1c2VkKSBjaHJvbWUud2luZG93cy5nZXRMYXN0Rm9jdXNlZCgpLnRoZW4od2luZG93ID0+IG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvdy5pZCksICgpID0+IHt9KTtcbmZ1bmN0aW9uIG5hdGl2ZURyYWZ0TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2xvc2VkKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoRXJyb3IoJ1VuYm91bmQgcnVudGltZScpKTtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdE5hdGl2ZURyYWZ0X3YxOicgKyBzZXNzaW9uLndpbmRvd0lkICsgJzonICsgc2Vzc2lvbi5vcmlnaW47XG4gICAgY29uc3Qgd29yayA9IG5hdGl2ZURyYWZ0Q2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om5hdGl2ZS1kcmFmdC13cml0ZScpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZS52YWx1ZSAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS52YWx1ZS5sZW5ndGggPiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgZHJhZnQnKTtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW2tleV06IG1lc3NhZ2UudmFsdWUgfSk7XG4gICAgICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KGtleSkpW2tleV0gIT09IG1lc3NhZ2UudmFsdWUpIHRocm93IEVycm9yKCdEcmFmdCBub3QgZHVyYWJsZScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHZhbHVlID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KGtleSkpW2tleV07XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyA/IHZhbHVlIDogJycgfTtcbiAgICB9KTtcbiAgICBuYXRpdmVEcmFmdENoYWluID0gd29yay5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHdvcms7XG59XG5mdW5jdGlvbiBuYXRpdmVSdW50aW1lU2Vzc2lvbktleShwYXJlbnQsIG9yaWdpbikgeyByZXR1cm4gcGFyZW50LnVybCArICc6JyArIG9yaWdpbjsgfVxuZnVuY3Rpb24gbmF0aXZlUnVudGltZVJlcXVlc3Qoc2Vzc2lvbiwgbWVzc2FnZSkge1xuICAgIGlmIChzZXNzaW9uLmNsb3NlZCkgcmV0dXJuIFByb21pc2UucmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTtcbiAgICBjb25zdCBpZCA9ICsrc2Vzc2lvbi5zZXF1ZW5jZTtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgc2Vzc2lvbi5wZW5kaW5nLmRlbGV0ZShpZCk7XG4gICAgICAgICAgICAvLyBLZWVwIHRoZSBkZWFkbGluZSByZWFzb24gZGlzdGluY3Qgc28gdGhlIHBhbmVsIGNhbiB0ZWxsIGEgZnJvemVuXG4gICAgICAgICAgICAvLyBydW50aW1lIGZyb20gYW4gb3JkaW5hcnkgZGlzY29ubmVjdCBpbnN0ZWFkIG9mIGJhY2tpbmcgb2ZmIGJsaW5kbHkuXG4gICAgICAgICAgICBjb25zdCBlcnJvciA9IEVycm9yKCdSdW50aW1lIHRpbWVkIG91dCcpO1xuICAgICAgICAgICAgZXJyb3IuY29kZSA9ICd0aW1lb3V0JztcbiAgICAgICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgIH0sIDUwMDApO1xuICAgICAgICBzZXNzaW9uLnBlbmRpbmcuc2V0KGlkLCB7IHJlc29sdmUsIHJlamVjdCwgdGltZXIgfSk7XG4gICAgICAgIHRyeSB7IHNlc3Npb24ucG9ydC5wb3N0TWVzc2FnZSh7IGNhbGw6IGlkLCBtZXNzYWdlIH0pOyB9XG4gICAgICAgIGNhdGNoIHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2Vzc2lvbi5wZW5kaW5nLmRlbGV0ZShpZCk7IHJlamVjdChFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKSk7IH1cbiAgICB9KTtcbn1cbmZ1bmN0aW9uIG5hdGl2ZVJ1bnRpbWVOb3RpZnkoc2VuZGVyLCBtZXNzYWdlKSB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmdldChzZW5kZXIpO1xuICAgIGlmICghc2Vzc2lvbiB8fCBzZXNzaW9uLmNsb3NlZCkgdGhyb3cgRXJyb3IoJ1J1bnRpbWUgZGlzY29ubmVjdGVkJyk7XG4gICAgc2Vzc2lvbi5wb3J0LnBvc3RNZXNzYWdlKHsgbWVzc2FnZSB9KTtcbn1cbmNocm9tZS5ydW50aW1lLm9uQ29ubmVjdC5hZGRMaXN0ZW5lcihwb3J0ID0+IHtcbiAgICBpZiAocG9ydC5uYW1lICE9PSAnbWVtY2hhdC1uYXRpdmUtcnVudGltZScpIHJldHVybjtcbiAgICBjb25zdCBzZW5kZXIgPSBwb3J0LnNlbmRlcjtcbiAgICBpZiAoc2VuZGVyPy5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncnVudGltZScsICdydW50aW1lJykpIHsgcG9ydC5kaXNjb25uZWN0KCk7IHJldHVybjsgfVxuICAgIGxldCBzZXNzaW9uLCBiaW5kaW5nID0gZmFsc2UsIGRpc2Nvbm5lY3RlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGNsb3NlID0gKCkgPT4ge1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBpZiAoIXNlc3Npb24gfHwgc2Vzc2lvbi5jbG9zZWQpIHJldHVybjtcbiAgICAgICAgc2Vzc2lvbi5jbG9zZWQgPSB0cnVlOyBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5kZWxldGUoc2VuZGVyKTtcbiAgICAgICAgaWYgKG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5nZXQoc2Vzc2lvbi5rZXkpID09PSBzZXNzaW9uKSBuYXRpdmVSdW50aW1lU2Vzc2lvbnMuZGVsZXRlKHNlc3Npb24ua2V5KTtcbiAgICAgICAgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUoJ25hdGl2ZTonICsgc2VuZGVyLnVybCk7XG4gICAgICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiBzZXNzaW9uLnBlbmRpbmcudmFsdWVzKCkpIHsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlamVjdChFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKSk7IH1cbiAgICAgICAgc2Vzc2lvbi5wZW5kaW5nLmNsZWFyKCk7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgcmVxdWVzdF0gb2YgcGVuZGluZ1JlcXVlc3RzKSBpZiAoa2V5LnN0YXJ0c1dpdGgoJ25hdGl2ZTonICsgc2VuZGVyLnVybCArICc6JykpIHsgcmVxdWVzdC5ldmVudCA9ICdhYm9ydCc7IHJlcXVlc3QuY29udHJvbGxlci5hYm9ydCgpOyB9XG4gICAgfTtcbiAgICBwb3J0Lm9uRGlzY29ubmVjdC5hZGRMaXN0ZW5lcihjbG9zZSk7XG4gICAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoYXN5bmMgcGFja2V0ID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgICAgICAgICAgIGlmIChiaW5kaW5nKSB0aHJvdyBFcnJvcignQWxyZWFkeSBiaW5kaW5nJyk7XG4gICAgICAgICAgICAgICAgYmluZGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgY29uc3QgY2FwYWJpbGl0eSA9IG5hdGl2ZVJ1bnRpbWVUaWNrZXRzLmdldChwYWNrZXQ/LnRpY2tldCk7XG4gICAgICAgICAgICAgICAgbmF0aXZlUnVudGltZVRpY2tldHMuZGVsZXRlKHBhY2tldD8udGlja2V0KTtcbiAgICAgICAgICAgICAgICBpZiAoIWNhcGFiaWxpdHkgfHwgY2FwYWJpbGl0eS5leHBpcmVzIDwgRGF0ZS5ub3coKSB8fCAhYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShjYXBhYmlsaXR5LnBhcmVudCwgY2FwYWJpbGl0eS53aW5kb3dJZCkgfHwgZGlzY29ubmVjdGVkKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgY2FwYWJpbGl0eScpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGtleSA9IG5hdGl2ZVJ1bnRpbWVTZXNzaW9uS2V5KGNhcGFiaWxpdHkucGFyZW50LCBjYXBhYmlsaXR5Lm9yaWdpbik7XG4gICAgICAgICAgICAgICAgaWYgKG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5oYXMoa2V5KSkgdGhyb3cgRXJyb3IoJ1J1bnRpbWUgYWxyZWFkeSBib3VuZCcpO1xuICAgICAgICAgICAgICAgIHNlc3Npb24gPSB7IC4uLmNhcGFiaWxpdHksIGtleSwgc2VuZGVyLCBwb3J0LCBwZW5kaW5nOiBuZXcgTWFwKCksIHNlcXVlbmNlOiAwLCBjbG9zZWQ6IGZhbHNlIH07XG4gICAgICAgICAgICAgICAgbmF0aXZlUnVudGltZUlkZW50aXRpZXMuc2V0KHNlbmRlciwgc2Vzc2lvbik7IG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5zZXQoa2V5LCBzZXNzaW9uKTtcbiAgICAgICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgcmVhZHk6IHRydWUgfSk7IHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChOdW1iZXIuaXNTYWZlSW50ZWdlcihwYWNrZXQ/LmFuc3dlcikpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBwZW5kaW5nID0gc2Vzc2lvbi5wZW5kaW5nLmdldChwYWNrZXQuYW5zd2VyKTtcbiAgICAgICAgICAgICAgICBpZiAocGVuZGluZykgeyBzZXNzaW9uLnBlbmRpbmcuZGVsZXRlKHBhY2tldC5hbnN3ZXIpOyBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7IHBlbmRpbmcucmVzb2x2ZShwYWNrZXQucmVwbHkpOyB9XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihwYWNrZXQ/LmlkKSB8fCBwYWNrZXQuaWQgPCAxIHx8ICFwYWNrZXQubWVzc2FnZSB8fCBzZXNzaW9uLmNsb3NlZCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbmF0aXZlIHBhY2tldCcpO1xuICAgICAgICAgICAgLy8gQ2hlY2sgdGhlIHBhcmVudCBpcyBzdGlsbCBhIG5hdGl2ZSBkb2N1bWVudCBpbiB0aGUgYm91bmQgd2luZG93LlxuICAgICAgICAgICAgaWYgKCFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlc3Npb24ucGFyZW50LCBzZXNzaW9uLndpbmRvd0lkKSB8fCBzZXNzaW9uLmNsb3NlZCkgdGhyb3cgRXJyb3IoJ05hdGl2ZSBwYXJlbnQgY2xvc2VkJyk7XG4gICAgICAgICAgICBsZXQgYW5zd2VyZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IGhhbmRsZWQgPSBleHRlbnNpb25IYW5kbGVNZXNzYWdlKHBhY2tldC5tZXNzYWdlLCBzZW5kZXIsIHJlcGx5ID0+IHtcbiAgICAgICAgICAgICAgICBhbnN3ZXJlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKCFzZXNzaW9uLmNsb3NlZCkgcG9ydC5wb3N0TWVzc2FnZSh7IGlkOiBwYWNrZXQuaWQsIHJlcGx5IH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAoIWhhbmRsZWQgJiYgIWFuc3dlcmVkKSBwb3J0LnBvc3RNZXNzYWdlKHsgaWQ6IHBhY2tldC5pZCwgcmVwbHk6IHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQt9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH0gfSk7XG4gICAgICAgIH0gY2F0Y2ggeyBjbG9zZSgpOyB0cnkgeyBwb3J0LmRpc2Nvbm5lY3QoKTsgfSBjYXRjaCB7IC8qIEFscmVhZHkgZ29uZS4gKi8gfSB9XG4gICAgfSk7XG59KTtcbiIsIi8vIEV4YWN0LXBhbmVsIHByaXZhdGUgcG9ydDogbmV2ZXIgYnJvYWRjYXN0IGhpc3RvcnkgYW5kIG5ldmVyIHBlcnNpc3QgaXQuXG5jb25zdCBzaWRlYmFySGlzdG9yeU93bmVycyA9IG5ldyBNYXAoKTtcbmNvbnN0IFNJREVCQVJfQ0hBVF9NT0RFUyA9IG5ldyBTZXQoWydjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLCAnY2FsY3VsYXRvcicsXG4gICAgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJ10pO1xuZnVuY3Rpb24gc2lkZWJhckhpc3RvcnlUYXJnZXQoc2VuZGVyKSB7XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHJldHVybiAnbmF0aXZlOicgKyBzZW5kZXIudXJsO1xuICAgIGlmICh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSByZXR1cm4gJ3RhYjonICsgc2VuZGVyLnRhYi5pZDtcbiAgICByZXR1cm4gbnVsbDtcbn1cbmZ1bmN0aW9uIHNpZGViYXJIaXN0b3J5QmluZChwYXJlbnQsIHRhcmdldCwgZG9jdW1lbnRUb2tlbikge1xuICAgIGNvbnN0IG93bmVyID0gc2lkZWJhckhpc3RvcnlPd25lcnMuZ2V0KHBhcmVudC51cmwpO1xuICAgIGlmICghb3duZXIgfHwgIXRhcmdldCB8fCB0eXBlb2YgZG9jdW1lbnRUb2tlbiAhPT0gJ3N0cmluZycpIHJldHVybjtcbiAgICBvd25lci50YXJnZXRzLnNldCh0YXJnZXQsIGRvY3VtZW50VG9rZW4pO1xufVxuY2hyb21lLnJ1bnRpbWUub25Db25uZWN0LmFkZExpc3RlbmVyKHBvcnQgPT4ge1xuICAgIGlmIChwb3J0Lm5hbWUgIT09ICdtZW1jaGF0LXNpZGViYXItaGlzdG9yeScpIHJldHVybjtcbiAgICBjb25zdCBzZW5kZXIgPSBwb3J0LnNlbmRlcjtcbiAgICBsZXQgb3duZXIsIGRpc2Nvbm5lY3RlZCA9IGZhbHNlLCBiaW5kaW5nID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGlmICghb3duZXIpIHJldHVybjtcbiAgICAgICAgaWYgKHNpZGViYXJIaXN0b3J5T3duZXJzLmdldChzZW5kZXIudXJsKSA9PT0gb3duZXIpIHNpZGViYXJIaXN0b3J5T3duZXJzLmRlbGV0ZShzZW5kZXIudXJsKTtcbiAgICAgICAgZm9yIChjb25zdCBwZW5kaW5nIG9mIG93bmVyLnBlbmRpbmcudmFsdWVzKCkpIHsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlc29sdmUoeyBvazogZmFsc2UsIGNsb3NlZDogdHJ1ZSB9KTsgfVxuICAgICAgICBvd25lci5wZW5kaW5nLmNsZWFyKCk7IG93bmVyLnRhcmdldHMuY2xlYXIoKTtcbiAgICB9O1xuICAgIHBvcnQub25EaXNjb25uZWN0LmFkZExpc3RlbmVyKGNsb3NlKTtcbiAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyBtZXNzYWdlID0+IHtcbiAgICAgICAgaWYgKGRpc2Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFvd25lcikge1xuICAgICAgICAgICAgICAgIGlmIChiaW5kaW5nIHx8IG1lc3NhZ2U/LnR5cGUgIT09ICdiaW5kJykgdGhyb3cgRXJyb3IoJ0ludmFsaWQgaGlzdG9yeSBiaW5kaW5nJyk7XG4gICAgICAgICAgICAgICAgYmluZGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKCFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkgfHwgZGlzY29ubmVjdGVkKSB0aHJvdyBFcnJvcignSW52YWxpZCBwYW5lbCcpO1xuICAgICAgICAgICAgICAgIC8vIEEgcmVwbGFjZW1lbnQgcG9ydCBtYXkgbm90IGhpamFjayBhbiBleGlzdGluZyBjb252ZXJzYXRpb24uXG4gICAgICAgICAgICAgICAgaWYgKHNpZGViYXJIaXN0b3J5T3duZXJzLmhhcyhzZW5kZXIudXJsKSkgdGhyb3cgRXJyb3IoJ0FscmVhZHkgYm91bmQnKTtcbiAgICAgICAgICAgICAgICBvd25lciA9IHsgaWQ6IGNyeXB0by5yYW5kb21VVUlEKCksIHNlbmRlciwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQsIHBvcnQsIHRhcmdldHM6IG5ldyBNYXAoKSwgcGVuZGluZzogbmV3IE1hcCgpIH07XG4gICAgICAgICAgICAgICAgc2lkZWJhckhpc3RvcnlPd25lcnMuc2V0KHNlbmRlci51cmwsIG93bmVyKTtcbiAgICAgICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHsgcmVhZHk6IHRydWUsIG93bmVyOiBvd25lci5pZCB9KTsgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKG1lc3NhZ2U/LnR5cGUgIT09ICdhY2snIHx8IHR5cGVvZiBtZXNzYWdlLmlkICE9PSAnc3RyaW5nJykgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgcGVuZGluZyA9IG93bmVyLnBlbmRpbmcuZ2V0KG1lc3NhZ2UuaWQpO1xuICAgICAgICAgICAgaWYgKHBlbmRpbmcpIHsgb3duZXIucGVuZGluZy5kZWxldGUobWVzc2FnZS5pZCk7IGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVyKTsgcGVuZGluZy5yZXNvbHZlKHsgb2s6IHRydWUgfSk7IH1cbiAgICAgICAgfSBjYXRjaCB7IGNsb3NlKCk7IHRyeSB7IHBvcnQuZGlzY29ubmVjdCgpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBjbG9zZWQgKi8gfSB9XG4gICAgfSk7XG59KTtcbmZ1bmN0aW9uIHNpZGViYXJIaXN0b3J5TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIsIHJlcGx5KSB7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgIT09ICdtZW1jaGF0OmNoYXQtZXZlbnQnKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcnVuID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBzaWRlYmFySGlzdG9yeVRhcmdldChzZW5kZXIpO1xuICAgICAgICBjb25zdCBvd25lciA9IFsuLi5zaWRlYmFySGlzdG9yeU93bmVycy52YWx1ZXMoKV0uZmluZCh2YWx1ZSA9PiB2YWx1ZS5pZCA9PT0gbWVzc2FnZS5vd25lcik7XG4gICAgICAgIGlmICghb3duZXIpIHJldHVybiB7IG9rOiBmYWxzZSwgY2xvc2VkOiB0cnVlIH07XG4gICAgICAgIGlmICghdGFyZ2V0IHx8IG93bmVyLnRhcmdldHMuZ2V0KHRhcmdldCkgIT09IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbiB8fCAhYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShvd25lci5zZW5kZXIsIG93bmVyLndpbmRvd0lkKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGlmICghU0lERUJBUl9DSEFUX01PREVTLmhhcyhtZXNzYWdlLmFjdGlvbikgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1lc3NhZ2UuZXBvY2gpIHx8IG1lc3NhZ2UuZXBvY2ggPCAwXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtZjAtOS1dezM2fSQvLnRlc3QobWVzc2FnZS5pZClcbiAgICAgICAgICAgIHx8ICFbJ2FwcGVuZCcsICdjbGVhciddLmluY2x1ZGVzKG1lc3NhZ2Uub3BlcmF0aW9uKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGlmIChtZXNzYWdlLm9wZXJhdGlvbiA9PT0gJ2FwcGVuZCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gbWVzc2FnZS5lbnRyeTtcbiAgICAgICAgICAgIGlmICghZW50cnkgfHwgZW50cnkuYWN0aW9uICE9PSBtZXNzYWdlLmFjdGlvbiB8fCAhWyd1c2VyJywgJ2JvdCcsICdzeXN0ZW0nXS5pbmNsdWRlcyhlbnRyeS5zZW5kZXIpXG4gICAgICAgICAgICAgICAgfHwgIVsnbWVzc2FnZScsICdlbW9qaScsICd0aW1lc3RhbXAnLCAncXVlcnknXS5ldmVyeShrZXkgPT4gdHlwZW9mIGVudHJ5W2tleV0gPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgICAgIHx8IEpTT04uc3RyaW5naWZ5KGVudHJ5KS5sZW5ndGggPiAxMDI0ICogMTAyNCkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG93bmVyLnBlbmRpbmcuaGFzKG1lc3NhZ2UuaWQpIHx8IG93bmVyLnBlbmRpbmcuc2l6ZSA+PSAxMjgpIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBvd25lci5wZW5kaW5nLmRlbGV0ZShtZXNzYWdlLmlkKTsgcmVzb2x2ZSh7IG9rOiBmYWxzZSB9KTsgfSwgNTAwMCk7XG4gICAgICAgICAgICBvd25lci5wZW5kaW5nLnNldChtZXNzYWdlLmlkLCB7IHJlc29sdmUsIHRpbWVyIH0pO1xuICAgICAgICAgICAgdHJ5IHsgb3duZXIucG9ydC5wb3N0TWVzc2FnZSh7IGV2ZW50OiB7IGlkOiBtZXNzYWdlLmlkLCBvcGVyYXRpb246IG1lc3NhZ2Uub3BlcmF0aW9uLFxuICAgICAgICAgICAgICAgIGVwb2NoOiBtZXNzYWdlLmVwb2NoLCBhY3Rpb246IG1lc3NhZ2UuYWN0aW9uLCBlbnRyeTogbWVzc2FnZS5lbnRyeSB9IH0pOyB9XG4gICAgICAgICAgICBjYXRjaCB7IGNsZWFyVGltZW91dCh0aW1lcik7IG93bmVyLnBlbmRpbmcuZGVsZXRlKG1lc3NhZ2UuaWQpOyByZXNvbHZlKHsgb2s6IGZhbHNlLCBjbG9zZWQ6IHRydWUgfSk7IH1cbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBydW4oKS50aGVuKHJlcGx5LCAoKSA9PiByZXBseSh7IG9rOiBmYWxzZSB9KSk7IHJldHVybiB0cnVlO1xufVxuIiwiLy8gUHJpdmF0ZSBuYXRpdmUtdmlldyBjaGFubmVsLiBOZXZlciBicm9hZGNhc3QgdmlldyBkYXRhOiByZXBsaWVzIGdvIG9ubHkgdG8gdGhlXG4vLyBleGFjdCByZXF1ZXN0aW5nIG5hdGl2ZSBwYW5lbC4gU2l0ZS9hY2NvdW50IHN0YXRlIHN0YXlzIGluIGl0cyBjb250ZW50IHdvcmxkLlxuY29uc3QgU0lERUJBUl9GRUFUVVJFUyA9IE9iamVjdC5mcmVlemUoWydjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLCAndG9kYXknLCAndG9tb3Jyb3cnLFxuICAgICdjYWxjdWxhdG9yJywgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJywgJ2hhY2tlcicsICdzZXR0aW5ncyddKTtcbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJEaXNwYXRjaChtZXNzYWdlKSB7XG4gICAgY29uc3QgW3RhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQgfSk7XG4gICAgaWYgKCFzdXBwb3J0ZWRBY3Rpb25UYWIodGFiKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICd1bnN1cHBvcnRlZCcgfTtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnICYmIHRhYi5pZCAhPT0gbWVzc2FnZS50YWJJZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIGNvbnN0IGNvbW1hbmQgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItc3RhdHVzJ1xuICAgICAgICA/IHsgdHlwZTogJ21lbWNoYXQ6ZmVhdHVyZS1zdGF0dXMnIH0gOiB7IHR5cGU6ICdtZW1jaGF0Om9wZW4tZmVhdHVyZScsIGZlYXR1cmU6IG1lc3NhZ2UuZmVhdHVyZSB9O1xuICAgIGxldCByZXBseTtcbiAgICB0cnkgeyByZXBseSA9IGF3YWl0IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgY29tbWFuZCwgeyBmcmFtZUlkOiAwIH0pOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07IH1cbiAgICBpZiAoIXJlcGx5Py5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFsnc3RvcmFnZScsICdjb25mbGljdCddLmluY2x1ZGVzKHJlcGx5Py5yZWFzb24pID8gcmVwbHkucmVhc29uIDogJ2ZhaWxlZCcgfTtcbiAgICAvLyBOZXZlciBmb3J3YXJkIGFuIGFyYml0cmFyeSBjb250ZW50IHJlcGx5LCB0YWIgdGl0bGUsIFVSTCBwYXRoL3F1ZXJ5IG9yIHBlcnNpc3RlZCBkYXRhLlxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKHRhYi51cmwpLmhvc3RuYW1lIH07XG59XG5cbi8vIEEgcGFuZWwncyB0YXJnZXQgaXMgY2FwdHVyZWQgb25jZSBhbmQgdGhlbiByZWFkLCBuZXZlciByZWNvbXB1dGVkIGZyb20gdGhlXG4vLyBsaXZlIHRhYiBVUkw6IHt0YWJJZCwgd2luZG93SWQsIG9yaWdpbiwgc3VwcG9ydGVkfS4gVGhlIG9yaWdpbiAoYW5kIHdpdGggaXRcbi8vIHRoZSBwcml2YXRlIGJ1Y2tldCkgdGhlcmVmb3JlIHN0YXlzIHB1dCB3aGlsZSB0aGUgYm91bmQgdGFiIG5hdmlnYXRlcywgbG9zZXNcbi8vIGZvY3VzIG9yIGlzIHJlc3RvcmVkLiBPbmx5IGFuIGV4cGxpY2l0IChyZSliaW5kIChubyB0YWJJZCkgb3IgYSB0YWIvd2luZG93XG4vLyBtaXNtYXRjaCByZXdyaXRlcyBpdDsgbGl2ZW5lc3MgaXMgY2hlY2tlZCBzZXBhcmF0ZWx5LlxuLy8gTVYzIGtpbGxzIHRoZSB3b3JrZXIgYWZ0ZXIgaWRsZSB0aW1lLCBzbyB0aGUgTWFwIGFsb25lIHdvdWxkIHJlc3RvcmUgZnJvbSB0aGVcbi8vIGdsb2JhbCBsYXN0LW9yaWdpbiBndWVzcyBvbiB3YWtlLiBBIGNvcHkgcGVyIHBhbmVsIGRvY3VtZW50IGxpdmVzIGluXG4vLyBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uIChicm93c2VyIGxpZmV0aW1lLCBuZXZlciBkaXNrKSBhbmQgaXMgcmVhZCBiYWNrIGZpcnN0LlxuY29uc3QgU0lERUJBUl9CSU5ESU5HX0tFWSA9ICdtZW1jaGF0U2lkZWJhckJpbmRpbmdfdjEnO1xuY29uc3QgU0lERUJBUl9CSU5ESU5HX01BWF9BR0VfTVMgPSAyNCAqIDYwICogNjAgKiAxMDAwO1xuY29uc3Qgc2lkZWJhckJpbmRpbmdzID0gbmV3IE1hcCgpO1xubGV0IHNpZGViYXJCaW5kaW5nUmVjb3JkcyA9IG51bGw7XG5sZXQgc2lkZWJhckJpbmRpbmdDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdMb2FkKCkge1xuICAgIGlmIChzaWRlYmFyQmluZGluZ1JlY29yZHMpIHJldHVybiBzaWRlYmFyQmluZGluZ1JlY29yZHM7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoU0lERUJBUl9CSU5ESU5HX0tFWSkpW1NJREVCQVJfQklORElOR19LRVldO1xuICAgICAgICBzaWRlYmFyQmluZGluZ1JlY29yZHMgPSBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KHNhdmVkKSA/IHNhdmVkIDoge307XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3NpZGViYXInLCBldmVudDogJ2JpbmRpbmctc3RvcmFnZScsIGRldGFpbDogeyByZWFzb246ICdyZWFkJyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdSZWNvcmRzID0ge307XG4gICAgfVxuICAgIHJldHVybiBzaWRlYmFyQmluZGluZ1JlY29yZHM7XG59XG5mdW5jdGlvbiBzaWRlYmFyQmluZGluZ1ZhbGlkKGJpbmRpbmcpIHtcbiAgICByZXR1cm4gISFiaW5kaW5nICYmIE51bWJlci5pc0ludGVnZXIoYmluZGluZy50YWJJZCkgJiYgYmluZGluZy50YWJJZCA+PSAwXG4gICAgICAgICYmIE51bWJlci5pc0ludGVnZXIoYmluZGluZy53aW5kb3dJZCkgJiYgYmluZGluZy53aW5kb3dJZCA+PSAwXG4gICAgICAgICYmIHR5cGVvZiBiaW5kaW5nLm9yaWdpbiA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIGJpbmRpbmcuc3VwcG9ydGVkID09PSAnYm9vbGVhbic7XG59XG4vLyBPbmUgb3duZXIsIG9uZSBhc3NpZ25tZW50OiBvbmx5IGFuIGV4cGxpY2l0IHJlYmluZCBvciBhIHBvc3Qtc2xlZXAgcmVidWlsZFxuLy8gd3JpdGVzLiBSZXdyaXRpbmcgYnkgcGFuZWwgVVJMIGJvdW5kcyB0aGUgcmVjb3JkIHNldDsgc3RhbGUgZW50cmllcyBhcmVcbi8vIGRyb3BwZWQgaGVyZSBpbnN0ZWFkIG9mIGJ5IGEgc2VwYXJhdGUgY29sbGVjdG9yLlxuZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdTYXZlKHBhbmVsVXJsLCBiaW5kaW5nKSB7XG4gICAgY29uc3Qgd29yayA9IHNpZGViYXJCaW5kaW5nQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBzaWRlYmFyQmluZGluZ0xvYWQoKTtcbiAgICAgICAgY29uc3QgY3V0b2ZmID0gRGF0ZS5ub3coKSAtIFNJREVCQVJfQklORElOR19NQVhfQUdFX01TO1xuICAgICAgICBjb25zdCBuZXh0ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZHMpKSB7XG4gICAgICAgICAgICBpZiAoa2V5ICE9PSBwYW5lbFVybCAmJiBzaWRlYmFyQmluZGluZ1ZhbGlkKHZhbHVlKSAmJiB0eXBlb2YgdmFsdWUuYXQgPT09ICdudW1iZXInICYmIHZhbHVlLmF0ID49IGN1dG9mZikgbmV4dFtrZXldID0gdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgbmV4dFtwYW5lbFVybF0gPSB7IHRhYklkOiBiaW5kaW5nLnRhYklkLCB3aW5kb3dJZDogYmluZGluZy53aW5kb3dJZCwgb3JpZ2luOiBiaW5kaW5nLm9yaWdpbixcbiAgICAgICAgICAgIHN1cHBvcnRlZDogYmluZGluZy5zdXBwb3J0ZWQsIGF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW1NJREVCQVJfQklORElOR19LRVldOiBuZXh0IH0pO1xuICAgICAgICBzaWRlYmFyQmluZGluZ1JlY29yZHMgPSBuZXh0O1xuICAgIH0pO1xuICAgIHNpZGViYXJCaW5kaW5nQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICAvLyBBIGZhaWxlZCB3cml0ZSBmYWxscyBiYWNrIHRvIHRoZSBpbi1tZW1vcnkgYmluZGluZyBmb3IgdGhpcyB3b3JrZXIncyBsaWZlLlxuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+IHtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1zdG9yYWdlJywgZGV0YWlsOiB7IHJlYXNvbjogJ3dyaXRlJyB9IH0sICd3b3JrZXInKTtcbiAgICB9KTtcbn1cbmZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsIHNvdXJjZSkge1xuICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnaW5mbycsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1jcmVhdGVkJywgZGV0YWlsOiB7XG4gICAgICAgIHRhYklkOiBiaW5kaW5nLnRhYklkLCBvcmlnaW46IGJpbmRpbmcub3JpZ2luLCBzdXBwb3J0ZWQ6IGJpbmRpbmcuc3VwcG9ydGVkLCBzb3VyY2VcbiAgICB9IH0sICd3b3JrZXInKTtcbn1cbmZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nTWlzbWF0Y2goZXhwZWN0ZWQsIGFjdHVhbCkge1xuICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnd2FybicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1taXNtYXRjaCcsIGRldGFpbDoge1xuICAgICAgICBleHBlY3RlZDogeyB0YWJJZDogZXhwZWN0ZWQudGFiSWQsIG9yaWdpbjogZXhwZWN0ZWQub3JpZ2luIH0sXG4gICAgICAgIGFjdHVhbDogeyB0YWJJZDogYWN0dWFsLnRhYklkLCB3aW5kb3dJZDogYWN0dWFsLndpbmRvd0lkIH1cbiAgICB9IH0sICd3b3JrZXInKTtcbn1cbmZ1bmN0aW9uIHNpZGViYXJEZWJ1Z0hvc3Qob3JpZ2luKSB7XG4gICAgdHJ5IHsgcmV0dXJuIHR5cGVvZiBvcmlnaW4gPT09ICdzdHJpbmcnID8gbmV3IFVSTChvcmlnaW4pLmhvc3RuYW1lIDogbnVsbDsgfVxuICAgIGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbn1cbmZ1bmN0aW9uIHNpZGViYXJDbGlja0lkKG1lc3NhZ2UpIHtcbiAgICBjb25zdCBpZCA9IG1lc3NhZ2UuY2xpY2tJZDtcbiAgICByZXR1cm4gbWVzc2FnZS5ldmVudCA9PT0gJ2NsaWNrJyAmJiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIC9eW2ctdl17MzJ9JC8udGVzdChpZCkgPyBpZCA6IG51bGw7XG59XG4vLyBBIGZhaWxlZCB2aWV3IGlzIHRoZSBzaWduYWwgYSBwYW5lbC1vbmx5IHJlcG9ydCB1c3VhbGx5IGxhY2tzOiBrZWVwIHRoZSBleGFjdFxuLy8gcmVhc29uIGFuZCB3aGljaCBjYXB0dXJlZCBiaW5kaW5nIHByb2R1Y2VkIGl0LCBuZXZlciBwYWdlIGNvbnRlbnQuXG5mdW5jdGlvbiBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsIHJlYXNvbikge1xuICAgIGNvbnN0IGNsaWNrSWQgPSBzaWRlYmFyQ2xpY2tJZChtZXNzYWdlKTtcbiAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICd2aWV3LWZhaWxlZCcsIGRldGFpbDoge1xuICAgICAgICByZWFzb24sIHRhYklkOiBOdW1iZXIuaXNJbnRlZ2VyKGJpbmRpbmc/LnRhYklkKSA/IGJpbmRpbmcudGFiSWQgOiAoTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSA/IG1lc3NhZ2UudGFiSWQgOiBudWxsKSxcbiAgICAgICAgc3VwcG9ydGVkOiBiaW5kaW5nPy5zdXBwb3J0ZWQgPT09IHRydWUsIGhvc3Q6IHNpZGViYXJEZWJ1Z0hvc3QoYmluZGluZz8ub3JpZ2luKSwgLi4uKGNsaWNrSWQgPyB7IGNsaWNrSWQgfSA6IHt9KVxuICAgIH0gfSwgJ3dvcmtlcicpO1xufVxuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdGb3IobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3QgY3VycmVudCA9IHNpZGViYXJCaW5kaW5ncy5nZXQoc2VuZGVyLnVybCk7XG4gICAgaWYgKG1lc3NhZ2UudGFiSWQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBbYWN0aXZlXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KTtcbiAgICAgICAgaWYgKCFhY3RpdmUpIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgIGNvbnN0IHN1cHBvcnRlZCA9IHN1cHBvcnRlZEFjdGlvblRhYihhY3RpdmUpO1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBzdXBwb3J0ZWQgPyBuZXcgVVJMKGFjdGl2ZS51cmwpLm9yaWdpbiA6IGF3YWl0IG5hdGl2ZUxhc3RPcmlnaW4oKTtcbiAgICAgICAgY29uc3QgYmluZGluZyA9IHsgdGFiSWQ6IGFjdGl2ZS5pZCwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQsIG9yaWdpbiwgc3VwcG9ydGVkIH07XG4gICAgICAgIHNpZGViYXJCaW5kaW5ncy5zZXQoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsICdleHBsaWNpdCcpO1xuICAgICAgICBhd2FpdCBzaWRlYmFyQmluZGluZ1NhdmUoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHJldHVybiB7IGJpbmRpbmcgfTtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnQpIHtcbiAgICAgICAgLy8gVGhlIGJpbmRpbmcgaXMgaW1tdXRhYmxlIGZvciBpdHMgbGlmZTsgYSBwb2xsIG5hbWluZyBhbm90aGVyIHRhYiBpcyBhXG4gICAgICAgIC8vIHN0YWxlIG9yIGZvcmVpZ24gcmVxdWVzdCwgbm90IGEgcmViaW5kLlxuICAgICAgICBpZiAoY3VycmVudC50YWJJZCAhPT0gbWVzc2FnZS50YWJJZCB8fCBjdXJyZW50LndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkKSB7XG4gICAgICAgICAgICBzaWRlYmFyQmluZGluZ01pc21hdGNoKGN1cnJlbnQsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBiaW5kaW5nOiBjdXJyZW50IH07XG4gICAgfVxuICAgIC8vIFRoZSB3b3JrZXIgc2xlcHQgb3IgcmVzdGFydGVkLiBSZWFkIHRoZSBwYW5lbCdzIG93biBjYXB0dXJlZCByZWNvcmQgZnJvbVxuICAgIC8vIHNlc3Npb24gc3RvcmFnZSBmaXJzdDogdGhhdCBjb3B5IGlzIHRoZSBmaXggZm9yIGEgc2lsZW50bHkgbW92aW5nIHByaXZhdGVcbiAgICAvLyBidWNrZXQuIE9ubHkgYSBwYW5lbCB3aXRob3V0IGFueSByZWNvcmQgaXMgcmVidWlsdCBmcm9tIGxpdmUgdGFiIHN0YXRlLlxuICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IHNpZGViYXJCaW5kaW5nTG9hZCgpKVtzZW5kZXIudXJsXTtcbiAgICBpZiAoc2lkZWJhckJpbmRpbmdWYWxpZChzYXZlZCkgJiYgc2F2ZWQud2luZG93SWQgPT09IG1lc3NhZ2Uud2luZG93SWQpIHtcbiAgICAgICAgaWYgKHNhdmVkLnRhYklkICE9PSBtZXNzYWdlLnRhYklkKSB7XG4gICAgICAgICAgICBzaWRlYmFyQmluZGluZ01pc21hdGNoKHNhdmVkLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmluZGluZyA9IHsgdGFiSWQ6IHNhdmVkLnRhYklkLCB3aW5kb3dJZDogc2F2ZWQud2luZG93SWQsIG9yaWdpbjogc2F2ZWQub3JpZ2luLCBzdXBwb3J0ZWQ6IHNhdmVkLnN1cHBvcnRlZCB9O1xuICAgICAgICBzaWRlYmFyQmluZGluZ3Muc2V0KHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgICAgICBzaWRlYmFyQmluZGluZ0xvZyhiaW5kaW5nLCAnc2Vzc2lvbicpO1xuICAgICAgICBhd2FpdCBzaWRlYmFyQmluZGluZ1NhdmUoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHJldHVybiB7IGJpbmRpbmcgfTtcbiAgICB9XG4gICAgbGV0IHRhYjtcbiAgICB0cnkgeyB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQobWVzc2FnZS50YWJJZCk7IH0gY2F0Y2gge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIG51bGwsICdjbG9zZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2xvc2VkJyB9O1xuICAgIH1cbiAgICBpZiAodGFiLndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkKSB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgeyB0YWJJZDogdGFiLmlkLCB3aW5kb3dJZDogdGFiLndpbmRvd0lkLCBvcmlnaW46IG51bGwsIHN1cHBvcnRlZDogZmFsc2UgfSwgJ2NoYW5nZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICB9XG4gICAgY29uc3Qgc3VwcG9ydGVkID0gc3VwcG9ydGVkQWN0aW9uVGFiKHRhYik7XG4gICAgY29uc3Qgb3JpZ2luID0gc3VwcG9ydGVkID8gbmV3IFVSTCh0YWIudXJsKS5vcmlnaW4gOiBhd2FpdCBuYXRpdmVMYXN0T3JpZ2luKCk7XG4gICAgY29uc3QgYmluZGluZyA9IHsgdGFiSWQ6IHRhYi5pZCwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQsIG9yaWdpbiwgc3VwcG9ydGVkIH07XG4gICAgc2lkZWJhckJpbmRpbmdzLnNldChzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAvLyBBIHJlY292ZXJlZCBiaW5kaW5nIHdhcyByZWJ1aWx0IGFmdGVyIHdvcmtlciBzdXNwZW5zaW9uIHdpdGhvdXQgYW55IHNhdmVkXG4gICAgLy8gcmVjb3JkOyB1bmxpa2UgYW4gZXhwbGljaXQgc2VsZWN0aW9uIGl0IHJlLXJlYWRzIGN1cnJlbnQgdGFiIHN0YXRlLCB3aGljaFxuICAgIC8vIGlzIHRoZSByaXNreSBjYXNlIGFuZCBzaG91bGQgc3RheSByYXJlLlxuICAgIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsICdyZWNvdmVyZWQnKTtcbiAgICBhd2FpdCBzaWRlYmFyQmluZGluZ1NhdmUoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgcmV0dXJuIHsgYmluZGluZyB9O1xufVxuLy8gQXZhaWxhYmlsaXR5IG9ubHk6IHRoZSB0YWIgZXhpc3RzLCBiZWxvbmdzIHRvIHRoZSBwYW5lbCdzIHdpbmRvdyBhbmQgaXMgbm90XG4vLyBkaXNjYXJkZWQvdW5sb2FkZWQuIFdoZXRoZXIgdGhlIHBhZ2UgaXMgYSBzdXBwb3J0ZWQgc2l0ZSBpcyBjYXB0dXJlZCBwb2xpY3kgaW5cbi8vIHRoZSBiaW5kaW5nLCBub3QgYSBsaXZlbmVzcyB0ZXN0LlxuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJvdW5kVGFiKG1lc3NhZ2UsIGJpbmRpbmcpIHtcbiAgICBsZXQgdGFiO1xuICAgIHRyeSB7IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChiaW5kaW5nLnRhYklkKTsgfSBjYXRjaCB7IHJldHVybiB7IHJlYXNvbjogJ2Nsb3NlZCcgfTsgfVxuICAgIGlmICh0YWIud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQpIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgaWYgKHRhYi5zdGF0dXMgPT09ICd1bmxvYWRlZCcgfHwgdGFiLmRpc2NhcmRlZCA9PT0gdHJ1ZSkgcmV0dXJuIHsgcmVhc29uOiAnbWlzc2luZycgfTtcbiAgICByZXR1cm4geyB0YWIgfTtcbn1cbi8vIFRoZSBVSSB2aWV3L2V2ZW50IGNoYW5uZWwgaXMgc2VydmVkIGV4Y2x1c2l2ZWx5IGJ5IHRoZSBwYW5lbCdzIG93blxuLy8gZXh0ZW5zaW9uLWhvc3RlZCBydW50aW1lLiBUaGUgYm91bmQgdGFiIGlzIG9ubHkgYW4gb3B0aW9uYWwgc2l0ZS1hY3Rpb24gdGFyZ2V0OlxuLy8gaXRzIGxpdmVuZXNzIGFuZCBzdXBwb3J0IGRlY2lkZSB0aGUgc2VwYXJhdGUgYHNpdGVgIGZsYWcsIG5ldmVyIHdoZXRoZXIgdGhlXG4vLyBwYW5lbCBrZWVwcyByZW5kZXJpbmcuIE5vIHJlcXVlc3QgaXMgZXZlciBkZWxpdmVyZWQgdG8gdGhlIHNpdGUgY29udGVudCB3b3JsZC5cbmZ1bmN0aW9uIHNpZGViYXJEb2N1bWVudENvbnRleHQodGFiKSB7XG4gICAgaWYgKCF0YWIgfHwgdHlwZW9mIHRhYi51cmwgIT09ICdzdHJpbmcnKSByZXR1cm4gbnVsbDtcbiAgICBsZXQgaGFzaDtcbiAgICB0cnkgeyBoYXNoID0gbmV3IFVSTCh0YWIudXJsKS5oYXNoOyB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgICBjb25zdCBtYXRjaCA9IGhhc2gubWF0Y2goL14jKGN1c3RvbWVyb3JkZXJ8ZGVtYW5kKVxcL2VkaXRcXD9pZD0oWzAtOWEtZkEtRi1dezgsNjR9KSQvKTtcbiAgICByZXR1cm4gbWF0Y2ggPyB7IHR5cGU6IG1hdGNoWzFdLCBpZDogbWF0Y2hbMl0gfSA6IG51bGw7XG59XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyVmlld0Rpc3BhdGNoKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgc2lkZWJhckJpbmRpbmdGb3IobWVzc2FnZSwgc2VuZGVyKTtcbiAgICBpZiAoIXJlc29sdmVkLmJpbmRpbmcpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBudWxsLCByZXNvbHZlZC5yZWFzb24gfHwgJ2NoYW5nZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IHJlc29sdmVkLnJlYXNvbiB8fCAnY2hhbmdlZCcgfTtcbiAgICB9XG4gICAgY29uc3QgYmluZGluZyA9IHJlc29sdmVkLmJpbmRpbmc7XG4gICAgY29uc3Qgb3JpZ2luID0gYmluZGluZy5vcmlnaW47XG4gICAgY29uc3QgYm91bmQgPSBhd2FpdCBzaWRlYmFyQm91bmRUYWIobWVzc2FnZSwgYmluZGluZyk7XG4gICAgY29uc3QgdGFiID0gYm91bmQudGFiO1xuICAgIC8vIFNpdGUgYXZhaWxhYmlsaXR5IGlzIGEgc2VwYXJhdGUgY2FwYWJpbGl0eS4gQSBtaXNzaW5nLCBkaXNjYXJkZWQgb3JcbiAgICAvLyBuYXZpZ2F0ZWQgcGFnZSBvbmx5IHJlbW92ZXMgdGhlIHNpdGUtYWN0aW9uIHRhcmdldCBhbmQgdGhlIGRvY3VtZW50IGNvbnRleHQ7XG4gICAgLy8gdGhlIGNhcHR1cmVkIG9yaWdpbiBrZWVwcyByZW5kZXJpbmcgdGhlIFVJIGZyb20gdGhlIHByaXZhdGUgcnVudGltZS5cbiAgICBpZiAoIXRhYiAmJiBib3VuZC5yZWFzb24gPT09ICdjaGFuZ2VkJykge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsICdjaGFuZ2VkJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICB9XG4gICAgY29uc3Qgc2l0ZSA9ICEhdGFiICYmIGJpbmRpbmcuc3VwcG9ydGVkICYmIHN1cHBvcnRlZEFjdGlvblRhYih0YWIpICYmIG5ldyBVUkwodGFiLnVybCkub3JpZ2luID09PSBvcmlnaW47XG4gICAgLy8gVGhlIGhpc3RvcnkgY2hhbm5lbCBpcyBhIHByaXZhdGUgcGVyLXBhbmVsIHNpbmssIG5ldmVyIGEgcHJlY29uZGl0aW9uIGZvclxuICAgIC8vIHJlbmRlcmluZzogYSBwYW5lbCB0aGF0IGxvc3QgaXQgc3RpbGwgc2hvd3MgdGhlIHZpZXcgYW5kIHJlcG9ydHMgaXRzIG93blxuICAgIC8vIGhpc3RvcnkgZXJyb3IsIGV4YWN0bHkgYXMgYSBtaXNzaW5nIGNyZWRlbnRpYWxzIHBhdGggbXVzdCBzdGF5IGZhaWwtY2xvc2VkXG4gICAgLy8gZm9yIHN0b3JhZ2UgYWxvbmUuXG4gICAgY29uc3QgaGlzdG9yeSA9IHNpZGViYXJIaXN0b3J5T3duZXJzLmdldChzZW5kZXIudXJsKTtcbiAgICBjb25zdCBjbGlja0lkID0gc2lkZWJhckNsaWNrSWQobWVzc2FnZSk7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3J1xuICAgICAgICA/IHsgdHlwZTogJ21lbWNoYXQ6dmlldy1zbmFwc2hvdCcgfVxuICAgICAgICA6IHsgdHlwZTogJ21lbWNoYXQ6dmlldy1ldmVudCcsIGRvY3VtZW50VG9rZW46IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbixcbiAgICAgICAgICAgIGtleTogbWVzc2FnZS5rZXksIGV2ZW50OiBtZXNzYWdlLmV2ZW50LCB2YWx1ZTogbWVzc2FnZS52YWx1ZSxcbiAgICAgICAgICAgIGNoZWNrZWQ6IG1lc3NhZ2UuY2hlY2tlZCwgc2VsZWN0ZWQ6IG1lc3NhZ2Uuc2VsZWN0ZWQsXG4gICAgICAgICAgICAuLi4obWVzc2FnZS5ldmVudCA9PT0gJ2NsaWNrJyAmJiBtZXNzYWdlLnRydXN0ZWRHZXN0dXJlID09PSB0cnVlID8geyB0cnVzdGVkR2VzdHVyZTogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgLi4uKGNsaWNrSWQgPyB7IGNsaWNrSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihtZXNzYWdlLmV2ZW50ID09PSAnZW50ZXInID8geyBldmVudElkOiBtZXNzYWdlLmV2ZW50SWQgfSA6IHt9KSB9O1xuICAgIC8vIEZvcndhcmQgdGhlIHBhbmVsJ3MgRVRhZyBvbmx5IG9uIHNuYXBzaG90IHBvbGxzOyBldmVudHMgYWx3YXlzIG5lZWQgdGhlXG4gICAgLy8gZnVsbCB2aWV3LiBVbmtub3duIGZpZWxkcyBzdGF5IGFic2VudCBzbyBvbGQgY29udGVudCB3b3JsZHMgc2VlIGFuXG4gICAgLy8gb3JkaW5hcnkgcmVxdWVzdC5cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnICYmIHR5cGVvZiBtZXNzYWdlLmtub3duSGFzaCA9PT0gJ3N0cmluZycpIHJlcXVlc3Qua25vd25IYXNoID0gbWVzc2FnZS5rbm93bkhhc2g7XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JyAmJiB0eXBlb2YgbWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW4gPT09ICdzdHJpbmcnKSByZXF1ZXN0Lmtub3duRG9jdW1lbnRUb2tlbiA9IG1lc3NhZ2Uua25vd25Eb2N1bWVudFRva2VuO1xuICAgIC8vIFRoZSBwYW5lbCdzIGNoYXQgbWVtb3J5IGlzIGFkZHJlc3NlZCBieSBvd25lciBpZCBwbHVzIHRoZSBleGFjdCBkb2N1bWVudFxuICAgIC8vIHRva2VuIHRoYXQgd2lsbCBhbnN3ZXIgaXQ7IGEgcmV3cml0dGVuIGVwb2NoIG1hcCBjYW4gbmVpdGhlciBtb3ZlIGFuXG4gICAgLy8gYW5zd2VyIGludG8gYW5vdGhlciBtb2RlIG5vciByZXZpdmUgYSBjbGVhcmVkIGhpc3RvcnkuXG4gICAgaWYgKGhpc3RvcnkpIHtcbiAgICAgICAgcmVxdWVzdC5oaXN0b3J5T3duZXIgPSBoaXN0b3J5LmlkO1xuICAgICAgICByZXF1ZXN0LmNoYXRNb2RlID0gU0lERUJBUl9GRUFUVVJFUy5pbmNsdWRlcyhtZXNzYWdlLmNoYXRNb2RlKSA/IG1lc3NhZ2UuY2hhdE1vZGUgOiBudWxsO1xuICAgICAgICByZXF1ZXN0LmNoYXRFcG9jaHMgPSBPYmplY3QuZnJvbUVudHJpZXMoWy4uLlNJREVCQVJfQ0hBVF9NT0RFU10ubWFwKG1vZGUgPT5cbiAgICAgICAgICAgIFttb2RlLCBOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmNoYXRFcG9jaHM/Llttb2RlXSkgJiYgbWVzc2FnZS5jaGF0RXBvY2hzW21vZGVdID49IDAgPyBtZXNzYWdlLmNoYXRFcG9jaHNbbW9kZV0gOiAwXSkpO1xuICAgIH1cbiAgICAvLyBUaGUgYm91bmRlZCBvcGVuLWRvY3VtZW50IGNvbnRleHQgaXMgZGVyaXZlZCBvbmx5IGZyb20gdGhlIGNhcHR1cmVkIHRhYiBVUkxcbiAgICAvLyBhbmQgb25seSB3aGlsZSB0aGF0IHBhZ2UgaXMgc3RpbGwgdGhlIHN1cHBvcnRlZCBzaXRlLiBObyBwYXRoL3F1ZXJ5LCB0aXRsZVxuICAgIC8vIG9yIHBhZ2Utc3VwcGxpZWQgc2VsZWN0b3IgY3Jvc3NlcyB0aGUgY2hhbm5lbC5cbiAgICByZXF1ZXN0LmRvY3VtZW50Q29udGV4dCA9IHNpdGUgPyBzaWRlYmFyRG9jdW1lbnRDb250ZXh0KHRhYikgOiBudWxsO1xuICAgIGxldCBoaXN0b3J5VGFyZ2V0O1xuICAgIGxldCB2aWV3O1xuICAgIGNvbnN0IHJlbGF5Q2xpY2tUcmFjZSA9IHJvdXRlID0+IHtcbiAgICAgICAgaWYgKGNsaWNrSWQpIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZGVidWcnLCBzY29wZTogJ3NpZGViYXInLCBldmVudDogJ2NsaWNrLXJlbGF5ZWQnLCBkZXRhaWw6IHsgY2xpY2tJZCwgcm91dGUgfSB9LCAnd29ya2VyJyk7XG4gICAgfTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZVNlc3Npb25zLmdldChuYXRpdmVSdW50aW1lU2Vzc2lvbktleShzZW5kZXIsIG9yaWdpbikpO1xuICAgICAgICBpZiAoIXNlc3Npb24pIHtcbiAgICAgICAgICAgIC8vIFRoZSBwYW5lbCdzIG93biBydW50aW1lIGlzIHRoZSBvbmx5IHZpZXcgaG9zdC4gSWYgaXQgaXMgbm90IGJvdW5kIHlldCxcbiAgICAgICAgICAgIC8vIGhhbmQgdGhlIHBhbmVsIGEgb25lLXVzZSBjYXBhYmlsaXR5IGluc3RlYWQgb2YgZXZlciBmYWxsaW5nIGJhY2sgdG9cbiAgICAgICAgICAgIC8vIHRoZSBzaXRlIGNvbnRlbnQgd29ybGQuXG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlICE9PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdGFiSWQ6IGJpbmRpbmcudGFiSWQsIGhvc3Q6IG5ldyBVUkwob3JpZ2luKS5ob3N0bmFtZSwgc2l0ZSwgbmF0aXZlOiAhc2l0ZSxcbiAgICAgICAgICAgICAgICBydW50aW1lOiB7IG9yaWdpbiwgdGlja2V0OiBhd2FpdCBuYXRpdmVSdW50aW1lVGlja2V0KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCwgb3JpZ2luKSB9IH07XG4gICAgICAgIH1cbiAgICAgICAgaGlzdG9yeVRhcmdldCA9ICduYXRpdmU6JyArIHNlc3Npb24uc2VuZGVyLnVybDtcbiAgICAgICAgcmVsYXlDbGlja1RyYWNlKCdydW50aW1lJyk7XG4gICAgICAgIHZpZXcgPSBhd2FpdCBuYXRpdmVSdW50aW1lUmVxdWVzdChzZXNzaW9uLCByZXF1ZXN0KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zdCByZWFzb24gPSBlcnJvcj8uY29kZSA9PT0gJ3RpbWVvdXQnID8gJ3RpbWVvdXQnIDogJ21pc3NpbmcnO1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsIHJlYXNvbik7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uIH07XG4gICAgfVxuICAgIGlmICghYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIG1lc3NhZ2Uud2luZG93SWQpKSB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgJ2NoYW5nZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIH1cbiAgICBpZiAoIXZpZXc/Lm9rKSB7XG4gICAgICAgIGNvbnN0IHJlYXNvbiA9IFsnc3RvcmFnZScsICdjb25mbGljdCcsICdjaGFuZ2VkJywgJ3RpbWVvdXQnLCAndG9vLWxhcmdlJ10uaW5jbHVkZXModmlldz8ucmVhc29uKSA/IHZpZXcucmVhc29uIDogJ2ZhaWxlZCc7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgcmVhc29uKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb24gfTtcbiAgICB9XG4gICAgLy8gT25seSBhIGZpcnN0IGJpbmRpbmcgb3IgYW4gZXZlbnQgZnJvbSB0aGUgdmlzaWJsZSBib3VuZCB0YWIgcmVjb3JkcyB0aGVcbiAgICAvLyBzZWxlY3Rpb247IGEgYmFja2dyb3VuZCBwb2xsIG9mIGEgbm9uLWFjdGl2ZSB0YWIgbXVzdCBub3Qgb3ZlcndyaXRlIGl0LlxuICAgIGNvbnN0IGFjdGl2ZUJvdW5kID0gbWVzc2FnZS50YWJJZCA9PT0gdW5kZWZpbmVkIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItZXZlbnQnXG4gICAgICAgICYmIChhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQgfSkpWzBdPy5pZCA9PT0gYmluZGluZy50YWJJZCk7XG4gICAgaWYgKHNpdGUgJiYgYWN0aXZlQm91bmQgJiYgKGF3YWl0IGNocm9tZS53aW5kb3dzLmdldChtZXNzYWdlLndpbmRvd0lkKSkuZm9jdXNlZCkgYXdhaXQgbmF0aXZlUmVtZW1iZXJPcmlnaW4ob3JpZ2luKTtcbiAgICAvLyBPbmx5IGEgdmlldyB0aGF0IHJlYWxseSBhbnN3ZXJlZCBtYXkgYmVjb21lIHRoZSB0YXJnZXQgb2YgdGhpcyBwYW5lbCdzXG4gICAgLy8gY2hhdCBzaW5rOyBhIHJlZnVzZWQgcmVxdWVzdCBtdXN0IG5vdCBiaW5kIGEgZG9jdW1lbnQgdGhhdCBuZXZlciByZW5kZXJlZC5cbiAgICBpZiAoaGlzdG9yeSkgc2lkZWJhckhpc3RvcnlCaW5kKHNlbmRlciwgaGlzdG9yeVRhcmdldCwgdmlldy5kb2N1bWVudFRva2VuKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdGFiSWQ6IGJpbmRpbmcudGFiSWQsIGhvc3Q6IG5ldyBVUkwob3JpZ2luKS5ob3N0bmFtZSwgc2l0ZSwgbmF0aXZlOiAhc2l0ZSwgdmlldyB9O1xufVxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgIGlmICghWydtZW1jaGF0OnNpZGViYXItc3RhdHVzJywgJ21lbWNoYXQ6c2lkZWJhci1jb21tYW5kJywgJ21lbWNoYXQ6c2lkZWJhci12aWV3JywgJ21lbWNoYXQ6c2lkZWJhci1ldmVudCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCAoc2VuZGVyLmZyYW1lSWQgIT09IHVuZGVmaW5lZCAmJiBzZW5kZXIuZnJhbWVJZCAhPT0gMClcbiAgICAgICAgfHwgIW5hdGl2ZURvY3VtZW50VXJsKHNlbmRlci51cmwsICdwYW5lbCcsICdzaWRlYmFyJylcbiAgICAgICAgfHwgIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS53aW5kb3dJZCkgfHwgbWVzc2FnZS53aW5kb3dJZCA8IDBcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1jb21tYW5kJyAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDBcbiAgICAgICAgICAgIHx8ICFTSURFQkFSX0ZFQVRVUkVTLmluY2x1ZGVzKG1lc3NhZ2UuZmVhdHVyZSkpKVxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnICYmIG1lc3NhZ2UudGFiSWQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDApKVxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnICYmICgobWVzc2FnZS5rbm93bkhhc2ggIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgJiYgKHR5cGVvZiBtZXNzYWdlLmtub3duSGFzaCAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS5rbm93bkhhc2gubGVuZ3RoID4gNjQpKVxuICAgICAgICAgICAgfHwgKG1lc3NhZ2Uua25vd25Eb2N1bWVudFRva2VuICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICYmICh0eXBlb2YgbWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW4gIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2Uua25vd25Eb2N1bWVudFRva2VuLmxlbmd0aCA+IDEwMCkpKSlcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1ldmVudCcgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpIHx8IG1lc3NhZ2UudGFiSWQgPCAwXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5kb2N1bWVudFRva2VuICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLmRvY3VtZW50VG9rZW4ubGVuZ3RoID4gMTAwXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5rZXkgIT09ICdzdHJpbmcnIHx8ICEvXlxcZHsxLDh9JC8udGVzdChtZXNzYWdlLmtleSlcbiAgICAgICAgICAgIHx8ICFbJ2NsaWNrJywgJ2lucHV0JywgJ2NoYW5nZScsICdlbnRlciddLmluY2x1ZGVzKG1lc3NhZ2UuZXZlbnQpXG4gICAgICAgICAgICB8fCAobWVzc2FnZS5ldmVudCA9PT0gJ2VudGVyJyAmJiAodHlwZW9mIG1lc3NhZ2UuZXZlbnRJZCAhPT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICB8fCAhL15bYS1mMC05LV17MSw2NH0kLy50ZXN0KG1lc3NhZ2UuZXZlbnRJZCkpKSkpKSB7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgcmVhc29uOiAnaW52YWxpZCcgfSk7IHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIG1lc3NhZ2Uud2luZG93SWQpLnRoZW4odmFsaWQgPT4gdmFsaWRcbiAgICAgICAgPyAoWydtZW1jaGF0OnNpZGViYXItdmlldycsICdtZW1jaGF0OnNpZGViYXItZXZlbnQnXS5pbmNsdWRlcyhtZXNzYWdlLnR5cGUpXG4gICAgICAgICAgICA/IHNpZGViYXJWaWV3RGlzcGF0Y2gobWVzc2FnZSwgc2VuZGVyKSA6IHNpZGViYXJEaXNwYXRjaChtZXNzYWdlKSlcbiAgICAgICAgOiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnaW52YWxpZCcgfSkudGhlbihzZW5kUmVzcG9uc2UsICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgcmVhc29uOiAnZmFpbGVkJyB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG59KTtcbiIsImNvbnN0IE1FTUNIQVRfUkVQUklDRV9BUEkgPSAnaHR0cHM6Ly9hcGkubW95c2tsYWQucnUvYXBpL3JlbWFwLzEuMic7XG5jb25zdCBNRU1DSEFUX1JFUFJJQ0VfUFJJQ0VfVFlQRVMgPSAnL2NvbnRleHQvY29tcGFueXNldHRpbmdzL3ByaWNldHlwZSc7XG5jb25zdCBNRU1DSEFUX1JFUFJJQ0VfVVVJRCA9IC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9JC87XG5jb25zdCBNRU1DSEFUX1JFUFJJQ0VfREVGQVVMVFMgPSBPYmplY3QuZnJlZXplKHsgbXVsdGlwbGllcjogJzEuMDQxJywgcm91bmRpbmc6ICd1cCcsIHN0ZXA6ICcxMDAnLCBzdWJ0cmFjdDogJzEwJyB9KTtcblxuZnVuY3Rpb24gbWVtY2hhdFJlcHJpY2VGb3JtdWxhKHJ1bGVzKSB7XG4gICAgY29uc3QgZGVjaW1hbCA9ICh2YWx1ZSwgcGxhY2VzKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8ICFuZXcgUmVnRXhwKGBeXFxcXGR7MSw4fSg/OlxcXFwuXFxcXGR7MSwke3BsYWNlc319KT8kYCkudGVzdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IEVycm9yKCfQktCy0LXQtNC40YLQtSDQtNC10YHRj9GC0LjRh9C90YvQtSDQt9C90LDRh9C10L3QuNGPINC60L7RjdGE0YTQuNGG0LjQtdC90YLQsCwg0YjQsNCz0LAg0Lgg0LLRi9GH0LjRgtCw0L3QuNGPLicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IFt3aG9sZSwgZnJhY3Rpb24gPSAnJ10gPSB2YWx1ZS5zcGxpdCgnLicpO1xuICAgICAgICBjb25zdCBzdWZmaXggPSBmcmFjdGlvbi5yZXBsYWNlKC8wKyQvLCAnJyk7XG4gICAgICAgIHJldHVybiBTdHJpbmcoTnVtYmVyKHdob2xlKSkgKyAoc3VmZml4ID8gJy4nICsgc3VmZml4IDogJycpO1xuICAgIH07XG4gICAgY29uc3QgbXVsdGlwbGllciA9IGRlY2ltYWwocnVsZXMubXVsdGlwbGllciwgNik7XG4gICAgY29uc3Qgc3RlcCA9IGRlY2ltYWwocnVsZXMuc3RlcCwgMik7XG4gICAgY29uc3Qgc3VidHJhY3QgPSBkZWNpbWFsKHJ1bGVzLnN1YnRyYWN0LCAyKTtcbiAgICBjb25zdCByb3VuZGluZyA9IHJ1bGVzLnJvdW5kaW5nO1xuICAgIGlmIChOdW1iZXIobXVsdGlwbGllcikgPD0gMCB8fCBOdW1iZXIoc3RlcCkgPD0gMCkgdGhyb3cgRXJyb3IoJ9Ca0L7RjdGE0YTQuNGG0LjQtdC90YIg0Lgg0YjQsNCzINC00L7Qu9C20L3RiyDQsdGL0YLRjCDQsdC+0LvRjNGI0LUg0L3Rg9C70Y8uJyk7XG4gICAgaWYgKCFbJ3VwJywgJ25lYXJlc3QnLCAnZG93biddLmluY2x1ZGVzKHJvdW5kaW5nKSkgdGhyb3cgRXJyb3IoJ9CS0YvQsdC10YDQuNGC0LUg0L3QsNC/0YDQsNCy0LvQtdC90LjQtSDQvtC60YDRg9Cz0LvQtdC90LjRjy4nKTtcbiAgICByZXR1cm4geyBtdWx0aXBsaWVyLCByb3VuZGluZywgc3RlcCwgc3VidHJhY3QgfTtcbn1cblxuZnVuY3Rpb24gbWVtY2hhdFJlcHJpY2VQcmljZVR5cGVzKHBheWxvYWQpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkocGF5bG9hZCkpIHRocm93IEVycm9yKCfQodC/0YDQsNCy0L7Rh9C90LjQuiDRgtC40L/QvtCyINGG0LXQvSDQvdC10LTQvtGB0YLRg9C/0LXQvS4nKTtcbiAgICBjb25zdCB0eXBlcyA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBwYXlsb2FkKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygcm93Py5pZCAhPT0gJ3N0cmluZycgfHwgIU1FTUNIQVRfUkVQUklDRV9VVUlELnRlc3Qocm93LmlkKSB8fCB0eXBlcy5oYXMocm93LmlkKVxuICAgICAgICAgICAgfHwgdHlwZW9mIHJvdy5uYW1lICE9PSAnc3RyaW5nJyB8fCAhcm93Lm5hbWUudHJpbSgpIHx8IHJvdy5uYW1lLmxlbmd0aCA+IDMwMFxuICAgICAgICAgICAgfHwgcm93Lm1ldGE/LmhyZWYgIT09IE1FTUNIQVRfUkVQUklDRV9BUEkgKyBNRU1DSEFUX1JFUFJJQ0VfUFJJQ0VfVFlQRVMgKyAnLycgKyByb3cuaWQpIHtcbiAgICAgICAgICAgIHRocm93IEVycm9yKCfQndC10LrQvtGA0YDQtdC60YLQvdGL0Lkg0YHQv9GA0LDQstC+0YfQvdC40Log0YLQuNC/0L7QsiDRhtC10L0uJyk7XG4gICAgICAgIH1cbiAgICAgICAgdHlwZXMuc2V0KHJvdy5pZCwgcm93Lm5hbWUpO1xuICAgIH1cbiAgICByZXR1cm4gdHlwZXM7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1lbWNoYXRSZXByaWNlU2VydmljZShjb25maWcpIHtcbiAgICAndXNlIHN0cmljdCc7XG5cbiAgICBjb25zdCBPUkRFUl9JRCA9IGNvbmZpZy5vcmRlcklkO1xuICAgIGNvbnN0IEJBU0VfUFJJQ0VfVFlQRV9JRCA9IGNvbmZpZy5iYXNlVHlwZUlkO1xuICAgIGNvbnN0IEJBU0VfUFJJQ0VfVFlQRV9OQU1FID0gY29uZmlnLmJhc2VUeXBlTmFtZTtcbiAgICBjb25zdCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCA9IGNvbmZpZy50YXJnZXRUeXBlSWQ7XG4gICAgY29uc3QgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSA9IGNvbmZpZy50YXJnZXRUeXBlTmFtZTtcbiAgICBjb25zdCBQUklDRV9UWVBFX0NPTlRFWFRfUEFUSCA9IE1FTUNIQVRfUkVQUklDRV9QUklDRV9UWVBFUztcbiAgICBjb25zdCBBUEkgPSBNRU1DSEFUX1JFUFJJQ0VfQVBJO1xuICAgIGNvbnN0IFBPU0lUSU9OU19MSU1JVCA9IDEwMDA7XG4gICAgY29uc3QgZm9ybXVsYSA9IG1lbWNoYXRSZXByaWNlRm9ybXVsYSh7IC4uLk1FTUNIQVRfUkVQUklDRV9ERUZBVUxUUywgLi4uY29uZmlnIH0pO1xuICAgIGNvbnN0IHNjYWxlZCA9ICh2YWx1ZSwgcGxhY2VzKSA9PiB7XG4gICAgICAgIGNvbnN0IFt3aG9sZSwgZnJhY3Rpb24gPSAnJ10gPSB2YWx1ZS5zcGxpdCgnLicpO1xuICAgICAgICByZXR1cm4gQmlnSW50KHdob2xlICsgZnJhY3Rpb24ucGFkRW5kKHBsYWNlcywgJzAnKSk7XG4gICAgfTtcbiAgICBjb25zdCBtdWx0aXBsaWVyID0gc2NhbGVkKGZvcm11bGEubXVsdGlwbGllciwgNik7XG4gICAgY29uc3Qgc3RlcCA9IHNjYWxlZChmb3JtdWxhLnN0ZXAsIDIpO1xuICAgIGNvbnN0IHN1YnRyYWN0ID0gc2NhbGVkKGZvcm11bGEuc3VidHJhY3QsIDIpO1xuICAgIGNvbnN0IGRpdmlzb3IgPSAxMDAwMDAwbiAqIHN0ZXA7XG4gICAgY29uc3QgVVVJRF9QQVRURVJOID0gTUVNQ0hBVF9SRVBSSUNFX1VVSUQ7XG4gICAgY29uc3QgQ0FSRF9WT0xBVElMRSA9IFsnbWV0YScsICdjb250ZXh0JywgJ3VwZGF0ZWQnLCAnc2FsZVByaWNlcyddO1xuICAgIGNvbnN0IERPQ1VNRU5UX1ZPTEFUSUxFID0gWydtZXRhJywgJ2NvbnRleHQnLCAncG9zaXRpb25zJywgJ3VwZGF0ZWQnXTtcblxuICAgIGZ1bmN0aW9uIGZhaWx1cmUoY29kZSwgbWVzc2FnZSkge1xuICAgICAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgZXJyb3IuY29kZSA9IGNvZGU7XG4gICAgICAgIHJldHVybiBlcnJvcjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBpbnZhbGlkKGNvZGUsIG1lc3NhZ2UpIHtcbiAgICAgICAgY29uc3QgZXJyb3IgPSBmYWlsdXJlKGNvZGUsIG1lc3NhZ2UpO1xuICAgICAgICBlcnJvci52YWxpZGF0aW9uID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIGVycm9yO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGludGVnZXIodmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcih2YWx1ZSkgPyB2YWx1ZSA6IG51bGw7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdiaWdpbnQnKSB7XG4gICAgICAgICAgICBjb25zdCBjb252ZXJ0ZWQgPSBOdW1iZXIodmFsdWUpO1xuICAgICAgICAgICAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKGNvbnZlcnRlZCkgPyBjb252ZXJ0ZWQgOiBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIC9eLT9cXGQrJC8udGVzdCh2YWx1ZS50cmltKCkpKSB7XG4gICAgICAgICAgICBjb25zdCBjb252ZXJ0ZWQgPSBOdW1iZXIodmFsdWUudHJpbSgpKTtcbiAgICAgICAgICAgIHJldHVybiBOdW1iZXIuaXNTYWZlSW50ZWdlcihjb252ZXJ0ZWQpID8gY29udmVydGVkIDogbnVsbDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjYWxjdWxhdGUoYmFzZUtvcGVja3MpIHtcbiAgICAgICAgY29uc3QgYmFzZSA9IGludGVnZXIoYmFzZUtvcGVja3MpO1xuICAgICAgICBpZiAoYmFzZSA9PT0gbnVsbCB8fCBiYXNlIDw9IDApIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2ludmFsaWQtYmFzZScsICfQkdCw0LfQvtCy0LDRjyDRhtC10L3QsCDQtNC+0LvQttC90LAg0LHRi9GC0Ywg0L/QvtC70L7QttC40YLQtdC70YzQvdGL0Lwg0YbQtdC70YvQvCDRh9C40YHQu9C+0Lwg0LrQvtC/0LXQtdC6Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgb2Zmc2V0ID0gZm9ybXVsYS5yb3VuZGluZyA9PT0gJ3VwJyA/IGRpdmlzb3IgLSAxbiA6IGZvcm11bGEucm91bmRpbmcgPT09ICduZWFyZXN0JyA/IGRpdmlzb3IgLyAybiA6IDBuO1xuICAgICAgICBjb25zdCByb3VuZGVkID0gKEJpZ0ludChiYXNlKSAqIG11bHRpcGxpZXIgKyBvZmZzZXQpIC8gZGl2aXNvcjtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcm91bmRlZCAqIHN0ZXAgLSBzdWJ0cmFjdDtcbiAgICAgICAgaWYgKHJlc3VsdCA8PSAwbiB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIoTnVtYmVyKHJlc3VsdCkpKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdvdXQtb2YtcmFuZ2UnLCAn0KDQsNGB0YHRh9C40YLQsNC90L3QsNGPINGG0LXQvdCwINC00L7Qu9C20L3QsCDQsdGL0YLRjCDQv9C+0LvQvtC20LjRgtC10LvRjNC90L7QuSDQuCDQsiDQsdC10LfQvtC/0LDRgdC90L7QvCDQtNC40LDQv9Cw0LfQvtC90LUnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gTnVtYmVyKHJlc3VsdCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2Fub25pY2FsKHZhbHVlKSB7XG4gICAgICAgIGlmICh2YWx1ZSA9PT0gdm9pZCAwKSByZXR1cm4gJ251bGwnO1xuICAgICAgICBpZiAodmFsdWUgPT09IG51bGwgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gJ1snICsgdmFsdWUubWFwKGNhbm9uaWNhbCkuam9pbignLCcpICsgJ10nO1xuICAgICAgICByZXR1cm4gJ3snICsgT2JqZWN0LmtleXModmFsdWUpLnNvcnQoKVxuICAgICAgICAgICAgLm1hcChrZXkgPT4gSlNPTi5zdHJpbmdpZnkoa2V5KSArICc6JyArIGNhbm9uaWNhbCh2YWx1ZVtrZXldKSkuam9pbignLCcpICsgJ30nO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNvcHkodmFsdWUpIHtcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBsYXN0U2VnbWVudChocmVmKSB7XG4gICAgICAgIGNvbnN0IHBhcnRzID0gU3RyaW5nKGhyZWYpLnNwbGl0KCc/JylbMF0uc3BsaXQoJy8nKTtcbiAgICAgICAgcmV0dXJuIHBhcnRzW3BhcnRzLmxlbmd0aCAtIDFdO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlYWRQYXRoKHBhdGgpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBwYXRoICE9PSAnc3RyaW5nJyB8fCBwYXRoLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaW52YWxpZC1yZWFkLXBhdGgnLCAn0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INCw0LTRgNC10YEg0YfRgtC10L3QuNGPINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGF0aCA9PT0gUFJJQ0VfVFlQRV9DT05URVhUX1BBVEgpIHJldHVybiBwYXRoO1xuICAgICAgICBpZiAoIXBhdGguc3RhcnRzV2l0aCgnL2VudGl0eS8nKSB8fCBwYXRoLmluZGV4T2YoJy8vJykgIT09IC0xKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpbnZhbGlkLXJlYWQtcGF0aCcsICfQp9GC0LXQvdC40LUg0YDQsNC30YDQtdGI0LXQvdC+INGC0L7Qu9GM0LrQviDQsiAvZW50aXR5Jyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHBhdGg7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gcmVhZEpzb24ocmVhZCwgcGF0aCkge1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVhZChyZWFkUGF0aChwYXRoKSk7XG4gICAgICAgIGlmIChkYXRhICYmIEFycmF5LmlzQXJyYXkoZGF0YS5lcnJvcnMpICYmIGRhdGEuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnYXBpLXJlc3BvbnNlJywgJ9Ce0YLQstC10YIg0JzQvtC50KHQutC70LDQtCDRgdC+0LTQtdGA0LbQuNGCINC+0YjQuNCx0LrQuCcpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBkYXRhO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGxpbmtCYXNlKGhyZWYsIG1hcmtlcikge1xuICAgICAgICBpZiAodHlwZW9mIGhyZWYgIT09ICdzdHJpbmcnIHx8ICFocmVmKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpZGVudGl0eScsICfQndC1INGD0LTQsNC70L7RgdGMINC+0L/RgNC10LTQtdC70LjRgtGMINCw0LTRgNC10YEgQVBJINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBjbGVhbiA9IGhyZWYuc3BsaXQoJz8nKVswXTtcbiAgICAgICAgaWYgKGNsZWFuICE9PSBBUEkgKyBtYXJrZXIpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2lkZW50aXR5JywgJ9Ch0YHRi9C70LrQsCDQstC90LUg0YHQvtCz0LvQsNGB0L7QstCw0L3QvdC+0LPQviDQsNC00YDQtdGB0LAg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBBUEk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gb3JkZXJCYXNlKG9yZGVyKSB7XG4gICAgICAgIHJldHVybiBsaW5rQmFzZShvcmRlciAmJiBvcmRlci5tZXRhICYmIG9yZGVyLm1ldGEuaHJlZixcbiAgICAgICAgICAgICcvZW50aXR5L2ludGVybmFsb3JkZXIvJyArIE9SREVSX0lEKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjYXJkQmFzZShjYXJkLCBpZCkge1xuICAgICAgICByZXR1cm4gbGlua0Jhc2UoY2FyZCAmJiBjYXJkLm1ldGEgJiYgY2FyZC5tZXRhLmhyZWYsICcvZW50aXR5L3Byb2R1Y3QvJyArIGlkKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWxhdGl2ZShocmVmLCBiYXNlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgaHJlZiAhPT0gJ3N0cmluZycgfHwgIWhyZWYpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3Njb3BlJywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90LDRjyDRgdGB0YvQu9C60LAg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChocmVmLmNoYXJBdCgwKSA9PT0gJy8nKSB7XG4gICAgICAgICAgICBpZiAoIWhyZWYuc3RhcnRzV2l0aCgnL2VudGl0eS8nKSB8fCBocmVmLmluZGV4T2YoJy8vJykgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnc2NvcGUnLCAn0KHRgdGL0LvQutCwINCy0L3QtSDRgdC+0LPQu9Cw0YHQvtCy0LDQvdC90L7Qs9C+IEFQSSDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gaHJlZjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWhyZWYuc3RhcnRzV2l0aChiYXNlICsgJy9lbnRpdHkvJykpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3Njb3BlJywgJ9Ch0YHRi9C70LrQsCDQstC90LUg0YHQvtCz0LvQsNGB0L7QstCw0L3QvdC+0LPQviBBUEkg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBocmVmLnNsaWNlKGJhc2UubGVuZ3RoKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBwcm9kdWN0UmVmKGhyZWYsIGJhc2UpIHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGhyZWYsIGJhc2UpO1xuICAgICAgICBjb25zdCBzZWdtZW50cyA9IHBhdGguc3BsaXQoJz8nKVswXS5zcGxpdCgnLycpO1xuICAgICAgICBpZiAoc2VnbWVudHMubGVuZ3RoICE9PSA0IHx8IHNlZ21lbnRzWzFdICE9PSAnZW50aXR5JyB8fCBzZWdtZW50c1syXSAhPT0gJ3Byb2R1Y3QnXG4gICAgICAgICAgICB8fCAhVVVJRF9QQVRURVJOLnRlc3Qoc2VnbWVudHNbM10pKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcm9kdWN0LXJlZicsICfQndC10LrQvtGA0YDQtdC60YLQvdCw0Y8g0YHRgdGL0LvQutCwIHByb2R1Y3QnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBpZDogc2VnbWVudHNbM10sIHBhdGggfTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBwcmljZVR5cGVJZChwcmljZSkge1xuICAgICAgICBjb25zdCBwcmljZVR5cGUgPSBwcmljZSAmJiBwcmljZS5wcmljZVR5cGU7XG4gICAgICAgIGlmICghcHJpY2VUeXBlKSByZXR1cm4gJyc7XG4gICAgICAgIGlmICh0eXBlb2YgcHJpY2VUeXBlLmlkID09PSAnc3RyaW5nJyAmJiBwcmljZVR5cGUuaWQpIHJldHVybiBwcmljZVR5cGUuaWQ7XG4gICAgICAgIHJldHVybiBwcmljZVR5cGUubWV0YSAmJiB0eXBlb2YgcHJpY2VUeXBlLm1ldGEuaHJlZiA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgID8gbGFzdFNlZ21lbnQocHJpY2VUeXBlLm1ldGEuaHJlZikgOiAnJztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzZWxlY3RQcmljZShjYXJkLCBpZCwgbmFtZSkge1xuICAgICAgICBpZiAoIWNhcmQgfHwgIUFycmF5LmlzQXJyYXkoY2FyZC5zYWxlUHJpY2VzKSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJpY2VzJywgJ9CSINC60LDRgNGC0L7Rh9C60LUg0L3QtdGCINGC0LjQv9C+0LIg0YbQtdC9Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbWF0Y2hlcyA9IGNhcmQuc2FsZVByaWNlcy5maWx0ZXIocHJpY2UgPT4gcHJpY2VUeXBlSWQocHJpY2UpID09PSBpZCk7XG4gICAgICAgIGlmIChtYXRjaGVzLmxlbmd0aCAhPT0gMSB8fCAobmFtZSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoZXNbMF0ucHJpY2VUeXBlPy5uYW1lICE9PSBuYW1lKVxuICAgICAgICAgICAgfHwgbWF0Y2hlc1swXS5wcmljZVR5cGU/Lm1ldGE/LmhyZWYgIT09IEFQSSArIFBSSUNFX1RZUEVfQ09OVEVYVF9QQVRIICsgJy8nICsgaWQpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3ByaWNlcycsICfQntGC0YHRg9GC0YHRgtCy0YPQtdGCINC40LvQuCDQv9C10YDQtdC40LzQtdC90L7QstCw0L0g0YLQuNC/INGG0LXQvdGLICcgKyBuYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwcmljZSA9IG1hdGNoZXNbMF07XG4gICAgICAgIGlmICghcHJpY2UuY3VycmVuY3kgfHwgIXByaWNlLmN1cnJlbmN5Lm1ldGFcbiAgICAgICAgICAgIHx8IHR5cGVvZiBwcmljZS5jdXJyZW5jeS5tZXRhLmhyZWYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdjdXJyZW5jeScsICfQoyDRgtC40L/QsCDRhtC10L3RiyDQvdC10YIg0LLQsNC70Y7RgtGLJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHByaWNlO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHJlcXVpcmVSdWJsZShyZWFkLCBwcmljZSwgYmFzZSwgY2FjaGUpIHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKHByaWNlLmN1cnJlbmN5Lm1ldGEuaHJlZiwgYmFzZSk7XG4gICAgICAgIGNvbnN0IHNlZ21lbnRzID0gcGF0aC5zcGxpdCgnPycpWzBdLnNwbGl0KCcvJyk7XG4gICAgICAgIGlmIChzZWdtZW50cy5sZW5ndGggIT09IDQgfHwgc2VnbWVudHNbMl0gIT09ICdjdXJyZW5jeSdcbiAgICAgICAgICAgIHx8ICFVVUlEX1BBVFRFUk4udGVzdChzZWdtZW50c1szXSkpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2N1cnJlbmN5JywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90LDRjyDRgdGB0YvQu9C60LAg0LLQsNC70Y7RgtGLJyk7XG4gICAgICAgIH1cbiAgICAgICAgbGV0IGlzbyA9IGNhY2hlLmdldChwYXRoKTtcbiAgICAgICAgaWYgKGlzbyA9PT0gdm9pZCAwKSB7XG4gICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgcGF0aCk7XG4gICAgICAgICAgICBpc28gPSBkYXRhICYmIGRhdGEuaXNvQ29kZTtcbiAgICAgICAgICAgIGNhY2hlLnNldChwYXRoLCBpc28pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpc28gIT09ICdSVUInKSB0aHJvdyBpbnZhbGlkKCdjdXJyZW5jeScsICfQktCw0LvRjtGC0LAg0YbQtdC90Ysg0L3QtSBSVUInKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBvdGhlclByaWNlcyhjYXJkKSB7XG4gICAgICAgIGNvbnN0IHByaWNlcyA9IGNhcmQgJiYgQXJyYXkuaXNBcnJheShjYXJkLnNhbGVQcmljZXMpID8gY2FyZC5zYWxlUHJpY2VzIDogW107XG4gICAgICAgIHJldHVybiBwcmljZXNcbiAgICAgICAgICAgIC5maWx0ZXIocHJpY2UgPT4gcHJpY2VUeXBlSWQocHJpY2UpICE9PSBUQVJHRVRfUFJJQ0VfVFlQRV9JRClcbiAgICAgICAgICAgIC5tYXAocHJpY2UgPT4gKHtcbiAgICAgICAgICAgICAgICBpZDogcHJpY2VUeXBlSWQocHJpY2UpLFxuICAgICAgICAgICAgICAgIHZhbHVlOiBOdW1iZXIocHJpY2UudmFsdWUpLFxuICAgICAgICAgICAgICAgIGN1cnJlbmN5OiBwcmljZS5jdXJyZW5jeSAmJiBwcmljZS5jdXJyZW5jeS5tZXRhXG4gICAgICAgICAgICAgICAgICAgID8gU3RyaW5nKHByaWNlLmN1cnJlbmN5Lm1ldGEuaHJlZikgOiAnJ1xuICAgICAgICAgICAgfSkpXG4gICAgICAgICAgICAuc29ydCgobGVmdCwgcmlnaHQpID0+IChsZWZ0LmlkIDwgcmlnaHQuaWQgPyAtMSA6IGxlZnQuaWQgPiByaWdodC5pZCA/IDEgOiAwKSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gYnVzaW5lc3NGaWVsZHMoY2FyZCkge1xuICAgICAgICBjb25zdCBmaWVsZHMgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXMoY2FyZCB8fCB7fSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgICAgaWYgKENBUkRfVk9MQVRJTEUuaW5kZXhPZihrZXkpID09PSAtMSkgZmllbGRzW2tleV0gPSBjYXJkW2tleV07XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gZmllbGRzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRvY3VtZW50U2lnbmF0dXJlKG9yZGVyLCBwb3NpdGlvbnMpIHtcbiAgICAgICAgY29uc3QgaGVhZGVyID0ge307XG4gICAgICAgIE9iamVjdC5rZXlzKG9yZGVyIHx8IHt9KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgICAgICBpZiAoRE9DVU1FTlRfVk9MQVRJTEUuaW5kZXhPZihrZXkpID09PSAtMSkgaGVhZGVyW2tleV0gPSBvcmRlcltrZXldO1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3Qgcm93cyA9IHBvc2l0aW9ucy5tYXAocG9zaXRpb24gPT4ge1xuICAgICAgICAgICAgY29uc3Qgcm93ID0ge307XG4gICAgICAgICAgICBPYmplY3Qua2V5cyhwb3NpdGlvbiB8fCB7fSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgIT09ICdtZXRhJyAmJiBrZXkgIT09ICdhc3NvcnRtZW50Jykgcm93W2tleV0gPSBwb3NpdGlvbltrZXldO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByb3cuYXNzb3J0bWVudCA9IHBvc2l0aW9uICYmIHBvc2l0aW9uLmFzc29ydG1lbnQgJiYgcG9zaXRpb24uYXNzb3J0bWVudC5tZXRhXG4gICAgICAgICAgICAgICAgPyBwb3NpdGlvbi5hc3NvcnRtZW50Lm1ldGEuaHJlZiA6IG51bGw7XG4gICAgICAgICAgICByZXR1cm4gcm93O1xuICAgICAgICB9KS5zb3J0KChsZWZ0LCByaWdodCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgYSA9IFN0cmluZyhsZWZ0LmlkID09PSB2b2lkIDAgPyAnJyA6IGxlZnQuaWQpO1xuICAgICAgICAgICAgY29uc3QgYiA9IFN0cmluZyhyaWdodC5pZCA9PT0gdm9pZCAwID8gJycgOiByaWdodC5pZCk7XG4gICAgICAgICAgICByZXR1cm4gYSA8IGIgPyAtMSA6IGEgPiBiID8gMSA6IDA7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gY2Fub25pY2FsKHsgaGVhZGVyLCBwb3NpdGlvbnM6IHJvd3MgfSk7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gY29sbGVjdFBhZ2VzKHJlYWQsIGZpcnN0LCBiYXNlLCBlbmRwb2ludCkge1xuICAgICAgICBjb25zdCByb3dzID0gW107XG4gICAgICAgIGNvbnN0IHZpc2l0ZWQgPSBuZXcgU2V0KCk7XG4gICAgICAgIGxldCBleHBlY3RlZFNpemU7XG4gICAgICAgIGxldCBuZXh0ID0gZmlyc3Q7XG4gICAgICAgIHdoaWxlIChuZXh0KSB7XG4gICAgICAgICAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUobmV4dCwgYmFzZSk7XG4gICAgICAgICAgICBpZiAocGF0aC5zcGxpdCgnPycpWzBdICE9PSBlbmRwb2ludCkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtdC60L7RgNGA0LXQutGC0L3QsNGPINC/0LDQs9C40L3QsNGG0LjRjyDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodmlzaXRlZC5oYXMocGF0aCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cf0L7QstGC0L7RgNC90LDRjyDRgdGC0YDQsNC90LjRhtCwINC/0LDQs9C40L3QsNGG0LjQuCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2aXNpdGVkLmFkZChwYXRoKTtcbiAgICAgICAgICAgIGNvbnN0IHBhZ2UgPSBhd2FpdCByZWFkSnNvbihyZWFkLCBwYXRoKTtcbiAgICAgICAgICAgIGlmICghcGFnZSB8fCAhQXJyYXkuaXNBcnJheShwYWdlLnJvd3MpIHx8ICFwYWdlLm1ldGEpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LXQv9C+0LvQvdCw0Y8g0YHRgtGA0LDQvdC40YbQsCDQv9Cw0LPQuNC90LDRhtC40Lgg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgc2l6ZSA9IGludGVnZXIocGFnZS5tZXRhLnNpemUpO1xuICAgICAgICAgICAgaWYgKHNpemUgPT09IG51bGwgfHwgc2l6ZSA8IDApIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LUg0YPQutCw0LfQsNC9INGA0LDQt9C80LXRgCDQstGL0LHQvtGA0LrQuCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocGFnZS5tZXRhLm9mZnNldCAhPT0gdm9pZCAwICYmIGludGVnZXIocGFnZS5tZXRhLm9mZnNldCkgIT09IHJvd3MubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC10LLQtdGA0L3QvtC1INGB0LzQtdGJ0LXQvdC40LUg0L/QsNCz0LjQvdCw0YbQuNC4INCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChleHBlY3RlZFNpemUgIT09IHZvaWQgMCAmJiBzaXplICE9PSBleHBlY3RlZFNpemUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cg0LDQt9C80LXRgCDQstGL0LHQvtGA0LrQuCDQuNC30LzQtdC90LjQu9GB0Y8g0LLQviDQstGA0LXQvNGPINGH0YLQtdC90LjRjyDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBleHBlY3RlZFNpemUgPSBzaXplO1xuICAgICAgICAgICAgcm93cy5wdXNoLmFwcGx5KHJvd3MsIHBhZ2Uucm93cyk7XG4gICAgICAgICAgICBpZiAocm93cy5sZW5ndGggPiBzaXplKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQm9C40YjQvdC40LUg0YHRgtGA0L7QutC4INCyINCy0YvQsdC+0YDQutC1INCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChwYWdlLm1ldGEubmV4dEhyZWYpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHBhZ2UubWV0YS5uZXh0SHJlZiAhPT0gJ3N0cmluZycgfHwgIXBhZ2Uucm93cy5sZW5ndGggfHwgcm93cy5sZW5ndGggPj0gc2l6ZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90L7QtSDQv9GA0L7QtNC+0LvQttC10L3QuNC1INC/0LDQs9C40L3QsNGG0LjQuCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5leHQgPSBwYWdlLm1ldGEubmV4dEhyZWY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChyb3dzLmxlbmd0aCAhPT0gc2l6ZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LXQv9C+0LvQvdCw0Y8g0LLRi9Cx0L7RgNC60LAg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBuZXh0ID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoZXhwZWN0ZWRTaXplID09PSB2b2lkIDApIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtdC/0L7Qu9C90LDRjyDQstGL0LHQvtGA0LrQsCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNoZWNrUHJpY2VUeXBlcyhwYXlsb2FkKSB7XG4gICAgICAgIGNvbnN0IHR5cGVzID0gbWVtY2hhdFJlcHJpY2VQcmljZVR5cGVzKHBheWxvYWQpO1xuICAgICAgICBpZiAoQkFTRV9QUklDRV9UWVBFX0lEID09PSBUQVJHRVRfUFJJQ0VfVFlQRV9JRCB8fCAhdHlwZXMuaGFzKEJBU0VfUFJJQ0VfVFlQRV9JRCkgfHwgIXR5cGVzLmhhcyhUQVJHRVRfUFJJQ0VfVFlQRV9JRClcbiAgICAgICAgICAgIHx8IHR5cGVzLmdldChCQVNFX1BSSUNFX1RZUEVfSUQpICE9PSBCQVNFX1BSSUNFX1RZUEVfTkFNRSB8fCB0eXBlcy5nZXQoVEFSR0VUX1BSSUNFX1RZUEVfSUQpICE9PSBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwcmljZXR5cGUtY29udGV4dCcsICfQotC40L8g0YbQtdC90Ysg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0L3QsNGB0YLRgNC+0LnQutC+0LkuINCe0LHQvdC+0LLQuNGC0LUg0L/RgNCw0LLQuNC70LAg0L/QtdGA0LXQvtGG0LXQvdC60LguJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBtYWtlUGxhbihyZWFkKSB7XG4gICAgICAgIGlmICh0eXBlb2YgcmVhZCAhPT0gJ2Z1bmN0aW9uJykgdGhyb3cgbmV3IFR5cGVFcnJvcigncGxhbiByZXF1aXJlcyBhIHJlYWQgZnVuY3Rpb24nKTtcbiAgICAgICAgaWYgKHR5cGVvZiBPUkRFUl9JRCAhPT0gJ3N0cmluZycgfHwgIVVVSURfUEFUVEVSTi50ZXN0KE9SREVSX0lEKSkgdGhyb3cgZmFpbHVyZSgnaWRlbnRpdHknLCAn0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INCy0L3Rg9GC0YDQtdC90L3QuNC5INC30LDQutCw0LcnKTtcbiAgICAgICAgY2hlY2tQcmljZVR5cGVzKGF3YWl0IHJlYWRKc29uKHJlYWQsIFBSSUNFX1RZUEVfQ09OVEVYVF9QQVRIKSk7XG5cbiAgICAgICAgY29uc3Qgb3JkZXIgPSBhd2FpdCByZWFkSnNvbihyZWFkLCAnL2VudGl0eS9pbnRlcm5hbG9yZGVyLycgKyBPUkRFUl9JRCk7XG4gICAgICAgIGNvbnN0IGJhc2UgPSBvcmRlckJhc2Uob3JkZXIpO1xuICAgICAgICBpZiAoIW9yZGVyIHx8IG9yZGVyLmlkICE9PSBPUkRFUl9JRCB8fCB0eXBlb2Ygb3JkZXIubmFtZSAhPT0gJ3N0cmluZycgfHwgIW9yZGVyLm5hbWUudHJpbSgpKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpZGVudGl0eScsICfQktC90YPRgtGA0LXQvdC90LjQuSDQt9Cw0LrQsNC3INC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGB0L4g0YHRgdGL0LvQutC+0LknKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBlbmRwb2ludCA9ICcvZW50aXR5L2ludGVybmFsb3JkZXIvJyArIE9SREVSX0lEICsgJy9wb3NpdGlvbnMnO1xuICAgICAgICBjb25zdCBwb3NpdGlvbnMgPSBhd2FpdCBjb2xsZWN0UGFnZXMocmVhZCxcbiAgICAgICAgICAgIGVuZHBvaW50ICsgJz9leHBhbmQ9YXNzb3J0bWVudCZsaW1pdD0nICsgUE9TSVRJT05TX0xJTUlULCBiYXNlLCBlbmRwb2ludCk7XG5cbiAgICAgICAgY29uc3QgZW50cmllcyA9IFtdO1xuICAgICAgICBjb25zdCBza2lwcGVkID0gW107XG4gICAgICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0KCk7XG4gICAgICAgIGNvbnN0IGNhY2hlID0gbmV3IE1hcCgpO1xuXG4gICAgICAgIGZvciAoY29uc3QgcG9zaXRpb24gb2YgcG9zaXRpb25zKSB7XG4gICAgICAgICAgICBjb25zdCBhc3NvcnRtZW50ID0gcG9zaXRpb24gJiYgcG9zaXRpb24uYXNzb3J0bWVudDtcbiAgICAgICAgICAgIGNvbnN0IGhyZWYgPSBhc3NvcnRtZW50ICYmIGFzc29ydG1lbnQubWV0YSAmJiBhc3NvcnRtZW50Lm1ldGEuaHJlZjtcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBhc3NvcnRtZW50ICYmIGFzc29ydG1lbnQubWV0YSAmJiBhc3NvcnRtZW50Lm1ldGEudHlwZTtcbiAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gYXNzb3J0bWVudCAmJiB0eXBlb2YgYXNzb3J0bWVudC5uYW1lID09PSAnc3RyaW5nJyAmJiBhc3NvcnRtZW50Lm5hbWVcbiAgICAgICAgICAgICAgICA/IGFzc29ydG1lbnQubmFtZSA6ICh0eXBlb2YgaHJlZiA9PT0gJ3N0cmluZycgPyBocmVmIDogJ9C/0L7Qt9C40YbQuNGPJyk7XG4gICAgICAgICAgICBpZiAodHlwZSAhPT0gJ3Byb2R1Y3QnIHx8IHR5cGVvZiBocmVmICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIHNraXBwZWQucHVzaCh7IG5hbWU6IGxhYmVsLCByZWFzb246ICfQv9C+0LTQtNC10YDQttC40LLQsNGO0YLRgdGPINGC0L7Qu9GM0LrQviDQutCw0YDRgtC+0YfQutC4IHByb2R1Y3QnIH0pO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IHByb2R1Y3Q7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHByb2R1Y3QgPSBwcm9kdWN0UmVmKGhyZWYsIGJhc2UpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IudmFsaWRhdGlvbiA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgICAgICBza2lwcGVkLnB1c2goeyBuYW1lOiBsYWJlbCwgcmVhc29uOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoc2Vlbi5oYXMocHJvZHVjdC5pZCkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgc2Vlbi5hZGQocHJvZHVjdC5pZCk7XG5cbiAgICAgICAgICAgIGNvbnN0IGNhcmQgPSBhd2FpdCByZWFkSnNvbihyZWFkLCBwcm9kdWN0LnBhdGgpO1xuICAgICAgICAgICAgaWYgKCFjYXJkIHx8IGNhcmQuaWQgIT09IHByb2R1Y3QuaWQgfHwgdHlwZW9mIGNhcmQubmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpZGVudGl0eScsICfQmtCw0YDRgtC+0YfQutCwINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINC/0L7Qt9C40YbQuNC10Lkg0LfQsNC60LDQt9CwJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIEJBU0VfUFJJQ0VfVFlQRV9JRCwgQkFTRV9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHRhcmdldFByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgVEFSR0VUX1BSSUNFX1RZUEVfSUQsIFRBUkdFVF9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCBiYXNlUHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgdGFyZ2V0UHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgICAgICAgICBjb25zdCBiYXNlS29wZWNrcyA9IGludGVnZXIoYmFzZVByaWNlLnZhbHVlKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFzZUtvcGVja3MgPT09IG51bGwgfHwgYmFzZUtvcGVja3MgPD0gMCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdiYXNlJywgJ9CR0LDQt9C+0LLQsNGPINGG0LXQvdCwINC00L7Qu9C20L3QsCDQsdGL0YLRjCDQv9C+0LvQvtC20LjRgtC10LvRjNC90L7QuSDQuCDRhtC10LvQvtC5Jyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG9sZCA9IGludGVnZXIodGFyZ2V0UHJpY2UudmFsdWUpO1xuICAgICAgICAgICAgICAgIGlmIChvbGQgPT09IG51bGwpIHRocm93IGludmFsaWQoJ3RhcmdldCcsICfQptC10L3QvdC40Log0LTQvtC70LbQtdC9INCx0YvRgtGMINGG0LXQu9GL0Lwg0YfQuNGB0LvQvtC8INC60L7Qv9C10LXQuicpO1xuICAgICAgICAgICAgICAgIGlmIChvbGQgPCAwKSB0aHJvdyBpbnZhbGlkKCd0YXJnZXQnLCAn0J7RgtGA0LjRhtCw0YLQtdC70YzQvdGL0Lkg0YLQtdC60YPRidC40Lkg0YbQtdC90L3QuNC6Jyk7XG4gICAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IE51bWJlcihjYWxjdWxhdGUoYmFzZUtvcGVja3MpKTtcbiAgICAgICAgICAgICAgICBlbnRyaWVzLnB1c2goeyBpZDogcHJvZHVjdC5pZCwgbmFtZTogY2FyZC5uYW1lLCBiYXNlOiBiYXNlS29wZWNrcywgb2xkLCBuZXc6IG5leHQgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGlmIChlcnJvciAmJiBlcnJvci52YWxpZGF0aW9uID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNraXBwZWQucHVzaCh7IG5hbWU6IGxhYmVsLCByZWFzb246IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBvcmRlck5hbWU6IG9yZGVyLm5hbWUsIHNpZ25hdHVyZTogZG9jdW1lbnRTaWduYXR1cmUob3JkZXIsIHBvc2l0aW9ucyksIGVudHJpZXMsIHNraXBwZWQgfTtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBwbGFuKHJlYWQpIHtcbiAgICAgICAgcmV0dXJuIG1ha2VQbGFuKHJlYWQpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpZmZlcmVuY2VzKGVudHJpZXMpIHtcbiAgICAgICAgY29uc3QgY2hhbmdlZCA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgICAgICAgIGlmIChlbnRyeSAmJiBlbnRyeS5uZXcgIT09IGVudHJ5Lm9sZCkge1xuICAgICAgICAgICAgICAgIGNoYW5nZWRbZW50cnkuaWRdID0geyBiYXNlOiBlbnRyeS5iYXNlLCBvbGQ6IGVudHJ5Lm9sZCwgbmV3OiBlbnRyeS5uZXcgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY2hhbmdlZDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBtZXRhQ29weShtZXRhKSB7XG4gICAgICAgIGlmICghbWV0YSB8fCB0eXBlb2YgbWV0YSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3ByaWNlcycsICfQndC10YIg0LzQtdGC0LDQtNCw0L3QvdGL0YUg0YLQuNC/0LAg0YbQtdC90YsnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXMobWV0YSkuZm9yRWFjaChrZXkgPT4geyByZXN1bHRba2V5XSA9IG1ldGFba2V5XTsgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcGF5bG9hZEZvcihlbnRyeSwgdGFyZ2V0UHJpY2UpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHNhbGVQcmljZXM6IFt7XG4gICAgICAgICAgICAgICAgdmFsdWU6IGVudHJ5Lm5ldyxcbiAgICAgICAgICAgICAgICBwcmljZVR5cGU6IHsgbWV0YTogbWV0YUNvcHkodGFyZ2V0UHJpY2UucHJpY2VUeXBlLm1ldGEpIH0sXG4gICAgICAgICAgICAgICAgY3VycmVuY3k6IHsgbWV0YTogbWV0YUNvcHkodGFyZ2V0UHJpY2UuY3VycmVuY3kubWV0YSkgfVxuICAgICAgICAgICAgfV1cbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiB2ZXJpZnlXcml0YWJsZShjYXJkLCBlbnRyeSwgYmVmb3JlKSB7XG4gICAgICAgIGlmICghY2FyZCB8fCBjYXJkLmlkICE9PSBlbnRyeS5pZCB8fCBjYXJkLm5hbWUgIT09IGVudHJ5Lm5hbWUpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2lkZW50aXR5JywgJ9Ca0LDRgNGC0L7Rh9C60LAg0LjQt9C80LXQvdC40LvQsNGB0Ywg0LLQviDQstGA0LXQvNGPINC/0LXRgNC10L7RhtC10L3QutC4Jyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmFzZVByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgQkFTRV9QUklDRV9UWVBFX0lELCBCQVNFX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgIGNvbnN0IHRhcmdldFByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgVEFSR0VUX1BSSUNFX1RZUEVfSUQsIFRBUkdFVF9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICBpZiAoaW50ZWdlcihiYXNlUHJpY2UudmFsdWUpICE9PSBlbnRyeS5iYXNlKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdiYXNlJywgJ9CR0LDQt9C+0LLQsNGPINGG0LXQvdCwINC40LfQvNC10L3QuNC70LDRgdGMINCy0L4g0LLRgNC10LzRjyDQv9C10YDQtdC+0YbQtdC90LrQuCcpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpbnRlZ2VyKHRhcmdldFByaWNlLnZhbHVlKSAhPT0gZW50cnkubmV3KSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCd0YXJnZXQnLCAn0KbQtdC90L3QuNC6INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvSDQvtCx0YDQsNGC0L3Ri9C8INGH0YLQtdC90LjQtdC8Jyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRhcmdldFByaWNlLmN1cnJlbmN5Lm1ldGEuaHJlZiAhPT0gc2VsZWN0UHJpY2UoYmVmb3JlLCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCwgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSkuY3VycmVuY3kubWV0YS5ocmVmKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdjdXJyZW5jeScsICfQmNC30LzQtdC90LjQu9Cw0YHRjCDQstCw0LvRjtGC0LAg0YbQtdC70LXQstC+0Lkg0YbQtdC90YsnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY2Fub25pY2FsKG90aGVyUHJpY2VzKGNhcmQpKSAhPT0gY2Fub25pY2FsKG90aGVyUHJpY2VzKGJlZm9yZSkpKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcmljZXMnLCAn0JjQt9C80LXQvdC40LvRgdGPINC00YDRg9Cz0L7QuSDRgtC40L8g0YbQtdC90YsnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY2Fub25pY2FsKGJ1c2luZXNzRmllbGRzKGNhcmQpKSAhPT0gY2Fub25pY2FsKGJ1c2luZXNzRmllbGRzKGJlZm9yZSkpKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdmaWVsZHMnLCAn0JjQt9C80LXQvdC40LvQuNGB0Ywg0LTRgNGD0LPQuNC1INC/0L7Qu9GPINC60LDRgNGC0L7Rh9C60LgnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHZlcmlmeVN0YWJsZShjYXJkLCBlbnRyeSwgZXhwZWN0ZWQsIHJlYWQsIGJhc2UsIGNhY2hlKSB7XG4gICAgICAgIGlmICghY2FyZCB8fCBjYXJkLmlkICE9PSBlbnRyeS5pZCB8fCBjYXJkLm5hbWUgIT09IGVudHJ5Lm5hbWUpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2lkZW50aXR5JywgJ9CY0YLQvtCz0L7QstCw0Y8g0LrQsNGA0YLQvtGH0LrQsCDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDQv9C70LDQvdC+0LwnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBiYXNlUHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBCQVNFX1BSSUNFX1RZUEVfSUQsIEJBU0VfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgY29uc3QgdGFyZ2V0UHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCwgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCBiYXNlUHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIHRhcmdldFByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgIGlmIChpbnRlZ2VyKGJhc2VQcmljZS52YWx1ZSkgIT09IGVudHJ5LmJhc2UpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2Jhc2UnLCAn0JjRgtC+0LPQvtCy0LDRjyDQsdCw0LfQvtCy0LDRjyDRhtC10L3QsCDQvdC1INGB0L7QstC/0LDQtNCw0LXRgicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpbnRlZ2VyKHRhcmdldFByaWNlLnZhbHVlKSAhPT0gZXhwZWN0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3RhcmdldCcsICfQmNGC0L7Qs9C+0LLRi9C5INGG0LXQvdC90LjQuiDQvdC1INGB0L7QstC/0LDQtNCw0LXRgicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbWFrZUpvdXJuYWwoZnJlc2gsIGNoYW5nZWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YXR1czogJ3dyaXRpbmcnLFxuICAgICAgICAgICAgY2hlY2tlZDogMCxcbiAgICAgICAgICAgIHZlcmlmaWVkOiAwLFxuICAgICAgICAgICAgc2lnbmF0dXJlOiBmcmVzaC5zaWduYXR1cmUsXG4gICAgICAgICAgICB0b3RhbDogZnJlc2guZW50cmllcy5sZW5ndGgsXG4gICAgICAgICAgICBjaGFuZ2VkOiBjaGFuZ2VkLmxlbmd0aCxcbiAgICAgICAgICAgIGludGVudDogbnVsbCxcbiAgICAgICAgICAgIHJlY29yZHM6IGNoYW5nZWQubWFwKGVudHJ5ID0+ICh7XG4gICAgICAgICAgICAgICAgaWQ6IGVudHJ5LmlkLFxuICAgICAgICAgICAgICAgIG5hbWU6IGVudHJ5Lm5hbWUsXG4gICAgICAgICAgICAgICAgb2xkOiBlbnRyeS5vbGQsXG4gICAgICAgICAgICAgICAgbmV3OiBlbnRyeS5uZXcsXG4gICAgICAgICAgICAgICAgb3V0Y29tZTogJ3BlbmRpbmcnXG4gICAgICAgICAgICB9KSksXG4gICAgICAgICAgICBlcnJvcjogbnVsbFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBwZXJzaXN0ICE9PSAnZnVuY3Rpb24nKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGNvbnN0IHNuYXBzaG90ID0gY29weShqb3VybmFsKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IHBlcnNpc3Qoc25hcHNob3QpO1xuICAgICAgICAgICAgcmV0dXJuIHN0b3JlZCAhPT0gbnVsbCAmJiB0eXBlb2Ygc3RvcmVkID09PSAnb2JqZWN0J1xuICAgICAgICAgICAgICAgICYmIGNhbm9uaWNhbChzdG9yZWQpID09PSBjYW5vbmljYWwoc25hcHNob3QpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc2V0T3V0Y29tZShqb3VybmFsLCBpZCwgb3V0Y29tZSkge1xuICAgICAgICBmb3IgKGNvbnN0IHJlY29yZCBvZiBqb3VybmFsLnJlY29yZHMpIHtcbiAgICAgICAgICAgIGlmIChyZWNvcmQuaWQgPT09IGlkKSByZWNvcmQub3V0Y29tZSA9IG91dGNvbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiByZWNvdW50KGpvdXJuYWwpIHtcbiAgICAgICAgbGV0IGNoZWNrZWQgPSAwO1xuICAgICAgICBsZXQgdmVyaWZpZWQgPSAwO1xuICAgICAgICBmb3IgKGNvbnN0IHJlY29yZCBvZiBqb3VybmFsLnJlY29yZHMpIHtcbiAgICAgICAgICAgIGlmIChyZWNvcmQub3V0Y29tZSA9PT0gJ3BlbmRpbmcnIHx8IHJlY29yZC5vdXRjb21lID09PSAnd3JpdGluZycpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY2hlY2tlZCArPSAxO1xuICAgICAgICAgICAgaWYgKHJlY29yZC5vdXRjb21lID09PSAndmVyaWZpZWQnIHx8IHJlY29yZC5vdXRjb21lID09PSAnYXBwbGllZCdcbiAgICAgICAgICAgICAgICB8fCByZWNvcmQub3V0Y29tZSA9PT0gJ2FwcGxpZWQtYWZ0ZXItZXJyb3InKSB2ZXJpZmllZCArPSAxO1xuICAgICAgICB9XG4gICAgICAgIGpvdXJuYWwuY2hlY2tlZCA9IGNoZWNrZWQ7XG4gICAgICAgIGpvdXJuYWwudmVyaWZpZWQgPSB2ZXJpZmllZDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBmYWlsdXJlU3RhdHVzKGpvdXJuYWwpIHtcbiAgICAgICAgcmV0dXJuIGpvdXJuYWwudmVyaWZpZWQgPiAwID8gJ2ludGVycnVwdGVkJyA6ICdmYWlsZWQnO1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIGZpbmFsQXVkaXQoam91cm5hbCwgcmVhZCwgZnJlc2gpIHtcbiAgICAgICAgbGV0IGNoZWNrZWQgPSAwO1xuICAgICAgICBsZXQgdmVyaWZpZWQgPSAwO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGZyZXNoLmVudHJpZXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBjYXJkID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgJy9lbnRpdHkvcHJvZHVjdC8nICsgZW50cnkuaWQpO1xuICAgICAgICAgICAgICAgIGNhcmRCYXNlKGNhcmQsIGVudHJ5LmlkKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB2ZXJpZnlTdGFibGUoY2FyZCwgZW50cnksIGVudHJ5Lm5ldywgcmVhZCwgQVBJLCBjYWNoZSk7XG4gICAgICAgICAgICAgICAgY2hlY2tlZCArPSAxO1xuICAgICAgICAgICAgICAgIHZlcmlmaWVkICs9IDE7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBvcmRlciA9IGF3YWl0IHJlYWRKc29uKHJlYWQsICcvZW50aXR5L2ludGVybmFsb3JkZXIvJyArIE9SREVSX0lEKTtcbiAgICAgICAgICAgIGNvbnN0IGJhc2UgPSBvcmRlckJhc2Uob3JkZXIpO1xuICAgICAgICAgICAgaWYgKCFvcmRlciB8fCBvcmRlci5pZCAhPT0gT1JERVJfSUQgfHwgb3JkZXIubmFtZSAhPT0gZnJlc2gub3JkZXJOYW1lKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnaWRlbnRpdHknLCAn0JjRgtC+0LPQvtCy0YvQuSDQstC90YPRgtGA0LXQvdC90LjQuSDQt9Cw0LrQsNC3INC90LUg0YHQvtCy0L/QsNC00LDQtdGCJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBlbmRwb2ludCA9ICcvZW50aXR5L2ludGVybmFsb3JkZXIvJyArIE9SREVSX0lEICsgJy9wb3NpdGlvbnMnO1xuICAgICAgICAgICAgY29uc3QgcG9zaXRpb25zID0gYXdhaXQgY29sbGVjdFBhZ2VzKHJlYWQsXG4gICAgICAgICAgICAgICAgZW5kcG9pbnQgKyAnP2V4cGFuZD1hc3NvcnRtZW50JmxpbWl0PScgKyBQT1NJVElPTlNfTElNSVQsIGJhc2UsIGVuZHBvaW50KTtcbiAgICAgICAgICAgIGlmIChkb2N1bWVudFNpZ25hdHVyZShvcmRlciwgcG9zaXRpb25zKSAhPT0gZnJlc2guc2lnbmF0dXJlKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSBmYWlsdXJlU3RhdHVzKGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuY2hlY2tlZCA9IGNoZWNrZWQ7XG4gICAgICAgICAgICAgICAgam91cm5hbC52ZXJpZmllZCA9IHZlcmlmaWVkO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAnc2lnbmF0dXJlLWNoYW5nZWQnO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgam91cm5hbC5jaGVja2VkID0gY2hlY2tlZDtcbiAgICAgICAgICAgIGpvdXJuYWwudmVyaWZpZWQgPSB2ZXJpZmllZDtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3ZlcmlmaWVkJztcbiAgICAgICAgICAgIGpvdXJuYWwuaW50ZW50ID0gbnVsbDtcbiAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSBudWxsO1xuICAgICAgICAgICAgZm9yIChjb25zdCByZWNvcmQgb2Ygam91cm5hbC5yZWNvcmRzKSByZWNvcmQub3V0Y29tZSA9ICd2ZXJpZmllZCc7XG4gICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gZmFpbHVyZVN0YXR1cyhqb3VybmFsKTtcbiAgICAgICAgICAgIGpvdXJuYWwuY2hlY2tlZCA9IGNoZWNrZWQ7XG4gICAgICAgICAgICBqb3VybmFsLnZlcmlmaWVkID0gdmVyaWZpZWQ7XG4gICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ2ZpbmFsLXJlYWQtZmFpbGVkJztcbiAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gZmluaXNoKGpvdXJuYWwsIHBlcnNpc3QpIHtcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgIGlmIChqb3VybmFsLnN0YXR1cyA9PT0gJ3ZlcmlmaWVkJyAmJiAhc3RvcmVkKSB7XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd1bmNlcnRhaW4nO1xuICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdwZXJzaXN0LWZhaWxlZCc7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gYXBwbHkocHJldmlldywgcG9ydHMpIHtcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHBvcnRzIHx8IHt9O1xuICAgICAgICBjb25zdCByZWFkID0gb3B0aW9ucy5yZWFkO1xuICAgICAgICBjb25zdCB3cml0ZSA9IG9wdGlvbnMud3JpdGU7XG4gICAgICAgIGNvbnN0IHBlcnNpc3QgPSBvcHRpb25zLnBlcnNpc3Q7XG4gICAgICAgIGlmICh0eXBlb2YgcmVhZCAhPT0gJ2Z1bmN0aW9uJyB8fCB0eXBlb2Ygd3JpdGUgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ2FwcGx5IHJlcXVpcmVzIHJlYWQgYW5kIHdyaXRlIGZ1bmN0aW9ucycpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcHJldmlldyB8fCB0eXBlb2YgcHJldmlldyAhPT0gJ29iamVjdCcgfHwgdHlwZW9mIHByZXZpZXcuc2lnbmF0dXJlICE9PSAnc3RyaW5nJ1xuICAgICAgICAgICAgfHwgIUFycmF5LmlzQXJyYXkocHJldmlldy5lbnRyaWVzKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignYXBwbHkgcmVxdWlyZXMgYW4gZXhwbGljaXRseSBjYXB0dXJlZCBwcmV2aWV3Jyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnJlc2g7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBmcmVzaCA9IGF3YWl0IG1ha2VQbGFuKHJlYWQpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdGF0dXM6ICdmYWlsZWQnLCBjaGVja2VkOiAwLCB2ZXJpZmllZDogMCxcbiAgICAgICAgICAgICAgICBzaWduYXR1cmU6IHByZXZpZXcuc2lnbmF0dXJlLCB0b3RhbDogMCwgY2hhbmdlZDogMCxcbiAgICAgICAgICAgICAgICBpbnRlbnQ6IG51bGwsIHJlY29yZHM6IFtdLCBlcnJvcjogJ3BsYW4tZmFpbGVkJ1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNoYW5nZWQgPSBmcmVzaC5lbnRyaWVzLmZpbHRlcihlbnRyeSA9PiBlbnRyeS5uZXcgIT09IGVudHJ5Lm9sZCk7XG4gICAgICAgIGNvbnN0IGpvdXJuYWwgPSBtYWtlSm91cm5hbChmcmVzaCwgY2hhbmdlZCk7XG4gICAgICAgIGNvbnN0IHNvcnRlZCA9IHJvd3MgPT4gcm93cy5zbGljZSgpLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0LmlkLmxvY2FsZUNvbXBhcmUocmlnaHQuaWQpKTtcbiAgICAgICAgY29uc3Qgc3RhbGUgPSBmcmVzaC5zaWduYXR1cmUgIT09IHByZXZpZXcuc2lnbmF0dXJlXG4gICAgICAgICAgICB8fCBjYW5vbmljYWwoc29ydGVkKGZyZXNoLmVudHJpZXMpKSAhPT0gY2Fub25pY2FsKHNvcnRlZChwcmV2aWV3LmVudHJpZXMpKVxuICAgICAgICAgICAgfHwgY2Fub25pY2FsKGZyZXNoLnNraXBwZWQpICE9PSBjYW5vbmljYWwocHJldmlldy5za2lwcGVkKTtcbiAgICAgICAgaWYgKHN0YWxlKSB7XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICdmYWlsZWQnO1xuICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdzdGFsZS1wcmV2aWV3JztcbiAgICAgICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWNoYW5nZWQubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCBhdWRpdGVkID0gYXdhaXQgZmluYWxBdWRpdChqb3VybmFsLCByZWFkLCBmcmVzaCk7XG4gICAgICAgICAgICByZXR1cm4gZmluaXNoKGF1ZGl0ZWQsIHBlcnNpc3QpO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBjaGFuZ2VkKSB7XG4gICAgICAgICAgICBjb25zdCBwYXRoID0gJy9lbnRpdHkvcHJvZHVjdC8nICsgZW50cnkuaWQ7XG4gICAgICAgICAgICBsZXQgYmVmb3JlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBiZWZvcmUgPSBhd2FpdCByZWFkSnNvbihyZWFkLCBwYXRoKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSBmYWlsdXJlU3RhdHVzKGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAncHJld3JpdGUtcmVhZC1mYWlsZWQnO1xuICAgICAgICAgICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0UHJpY2U7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmICghYmVmb3JlIHx8IGJlZm9yZS5pZCAhPT0gZW50cnkuaWQgfHwgYmVmb3JlLm5hbWUgIT09IGVudHJ5Lm5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnaWRlbnRpdHknLCAn0JrQsNGA0YLQvtGH0LrQsCDQuNC30LzQtdC90LjQu9Cw0YHRjCDQv9C+0YHQu9C1INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgNCwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VQcmljZSA9IHNlbGVjdFByaWNlKGJlZm9yZSwgQkFTRV9QUklDRV9UWVBFX0lELCBCQVNFX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgICAgICAgICAgdGFyZ2V0UHJpY2UgPSBzZWxlY3RQcmljZShiZWZvcmUsIFRBUkdFVF9QUklDRV9UWVBFX0lELCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgICAgICAgICBpZiAoaW50ZWdlcihiYXNlUHJpY2UudmFsdWUpICE9PSBlbnRyeS5iYXNlXG4gICAgICAgICAgICAgICAgICAgIHx8IGludGVnZXIodGFyZ2V0UHJpY2UudmFsdWUpICE9PSBlbnRyeS5vbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJldmlldycsICfQptC10L3QsCDQuNC30LzQtdC90LjQu9Cw0YHRjCDQv9C+0YHQu9C1INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgNCwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2UgPSBjYXJkQmFzZShiZWZvcmUsIGVudHJ5LmlkKTtcbiAgICAgICAgICAgICAgICBjb25zdCBjYWNoZSA9IG5ldyBNYXAoKTtcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgYmFzZVByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIHRhcmdldFByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gZmFpbHVyZVN0YXR1cyhqb3VybmFsKTtcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gZXJyb3IgJiYgZXJyb3IudmFsaWRhdGlvbiA9PT0gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICA/ICdwcmV3cml0ZS1taXNtYXRjaCcgOiAncHJld3JpdGUtcmVhZC1mYWlsZWQnO1xuICAgICAgICAgICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBqb3VybmFsLmludGVudCA9IHtcbiAgICAgICAgICAgICAgICBpZDogZW50cnkuaWQsXG4gICAgICAgICAgICAgICAgbmFtZTogZW50cnkubmFtZSxcbiAgICAgICAgICAgICAgICBwYXRoLFxuICAgICAgICAgICAgICAgIGJhc2U6IGVudHJ5LmJhc2UsXG4gICAgICAgICAgICAgICAgb2xkOiBlbnRyeS5vbGQsXG4gICAgICAgICAgICAgICAgbmV3OiBlbnRyeS5uZXcsXG4gICAgICAgICAgICAgICAgcHJpY2VUeXBlOiB7XG4gICAgICAgICAgICAgICAgICAgIGlkOiBUQVJHRVRfUFJJQ0VfVFlQRV9JRCxcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSxcbiAgICAgICAgICAgICAgICAgICAgaHJlZjogU3RyaW5nKHRhcmdldFByaWNlLnByaWNlVHlwZS5tZXRhLmhyZWYpXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBjdXJyZW5jeTogeyBocmVmOiBTdHJpbmcodGFyZ2V0UHJpY2UuY3VycmVuY3kubWV0YS5ocmVmKSB9LFxuICAgICAgICAgICAgICAgIG90aGVyczogb3RoZXJQcmljZXMoYmVmb3JlKSxcbiAgICAgICAgICAgICAgICBmaWVsZHM6IGNhbm9uaWNhbChidXNpbmVzc0ZpZWxkcyhiZWZvcmUpKVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3dyaXRpbmcnO1xuICAgICAgICAgICAgc2V0T3V0Y29tZShqb3VybmFsLCBlbnRyeS5pZCwgJ3dyaXRpbmcnKTtcbiAgICAgICAgICAgIHJlY291bnQoam91cm5hbCk7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAnZmFpbGVkJztcbiAgICAgICAgICAgICAgICBqb3VybmFsLmludGVudCA9IG51bGw7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdwZXJzaXN0LWZhaWxlZCc7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBwYXlsb2FkRm9yKGVudHJ5LCB0YXJnZXRQcmljZSk7XG4gICAgICAgICAgICBsZXQgd3JpdGVGYWlsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgd3JpdGUocGF0aCwgcGF5bG9hZCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHdyaXRlRmFpbGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGFmdGVyO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBhZnRlciA9IGF3YWl0IHJlYWRKc29uKHJlYWQsIHBhdGgpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICd1bmNlcnRhaW4nO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAncmVhZGJhY2stZmFpbGVkJztcbiAgICAgICAgICAgICAgICBzZXRPdXRjb21lKGpvdXJuYWwsIGVudHJ5LmlkLCAndW5jZXJ0YWluJyk7XG4gICAgICAgICAgICAgICAgcmVjb3VudChqb3VybmFsKTtcbiAgICAgICAgICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICB2ZXJpZnlXcml0YWJsZShhZnRlciwgZW50cnksIGJlZm9yZSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3VuY2VydGFpbic7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9IHdyaXRlRmFpbGVkID8gJ3dyaXRlLWZhaWxlZC11bnZlcmlmaWVkJyA6ICdyZWFkYmFjay1taXNtYXRjaCc7XG4gICAgICAgICAgICAgICAgc2V0T3V0Y29tZShqb3VybmFsLCBlbnRyeS5pZCwgJ3VuY2VydGFpbicpO1xuICAgICAgICAgICAgICAgIHJlY291bnQoam91cm5hbCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGpvdXJuYWwuaW50ZW50ID0gbnVsbDtcbiAgICAgICAgICAgIHNldE91dGNvbWUoam91cm5hbCwgZW50cnkuaWQsIHdyaXRlRmFpbGVkID8gJ2FwcGxpZWQtYWZ0ZXItZXJyb3InIDogJ3ZlcmlmaWVkJyk7XG4gICAgICAgICAgICByZWNvdW50KGpvdXJuYWwpO1xuICAgICAgICAgICAgaWYgKCFhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKSkge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3VuY2VydGFpbic7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdwZXJzaXN0LWZhaWxlZCc7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAod3JpdGVGYWlsZWQpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICdpbnRlcnJ1cHRlZCc7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICd3cml0ZS1mYWlsZWQtYXBwbGllZCc7XG4gICAgICAgICAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBhdWRpdGVkID0gYXdhaXQgZmluYWxBdWRpdChqb3VybmFsLCByZWFkLCBmcmVzaCk7XG4gICAgICAgIHJldHVybiBmaW5pc2goYXVkaXRlZCwgcGVyc2lzdCk7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gdW5yZXNvbHZlZChqb3VybmFsLCBwZXJzaXN0KSB7XG4gICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3VuY2VydGFpbic7XG4gICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3VtbWFyeTogJ2ludGVycnVwdGVkJywgc3RhdHVzOiBqb3VybmFsLnN0YXR1cywgcmVzb2x2ZWQ6IGZhbHNlLCBibG9ja2VkOiB0cnVlLFxuICAgICAgICAgICAgb3V0Y29tZTogJ3VucmVzb2x2ZWQnLCBjaGVja2VkOiBqb3VybmFsLmNoZWNrZWQsIHZlcmlmaWVkOiBqb3VybmFsLnZlcmlmaWVkLFxuICAgICAgICAgICAgaW50ZW50OiBqb3VybmFsLmludGVudFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHJlY29uY2lsZShqb3VybmFsLCBwb3J0cykge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gcG9ydHMgfHwge307XG4gICAgICAgIGNvbnN0IHJlYWQgPSBvcHRpb25zLnJlYWQ7XG4gICAgICAgIGNvbnN0IHBlcnNpc3QgPSBvcHRpb25zLnBlcnNpc3Q7XG4gICAgICAgIGlmICh0eXBlb2YgcmVhZCAhPT0gJ2Z1bmN0aW9uJykgdGhyb3cgbmV3IFR5cGVFcnJvcigncmVjb25jaWxlIHJlcXVpcmVzIGEgcmVhZCBmdW5jdGlvbicpO1xuICAgICAgICBpZiAoIWpvdXJuYWwgfHwgdHlwZW9mIGpvdXJuYWwgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZWNvbmNpbGUgcmVxdWlyZXMgYSBqb3VybmFsJyk7XG4gICAgICAgIH1cblxuICAgICAgICBqb3VybmFsID0gY29weShqb3VybmFsKTtcbiAgICAgICAgY29uc3QgaW50ZW50ID0gam91cm5hbC5pbnRlbnQ7XG4gICAgICAgIGlmIChqb3VybmFsLnN0YXR1cyA9PT0gJ3ZlcmlmaWVkJyAmJiAhaW50ZW50KSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHN1bW1hcnk6ICdmaW5pc2hlZCcsIHN0YXR1czogJ3ZlcmlmaWVkJywgcmVzb2x2ZWQ6IHRydWUsIGJsb2NrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG91dGNvbWU6ICd2ZXJpZmllZCcsIGNoZWNrZWQ6IGpvdXJuYWwuY2hlY2tlZCwgdmVyaWZpZWQ6IGpvdXJuYWwudmVyaWZpZWQsIGludGVudDogbnVsbFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWludGVudCkge1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAnaW50ZXJydXB0ZWQnO1xuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3VtbWFyeTogJ2ludGVycnVwdGVkJywgc3RhdHVzOiBqb3VybmFsLnN0YXR1cywgcmVzb2x2ZWQsIGJsb2NrZWQ6ICFyZXNvbHZlZCxcbiAgICAgICAgICAgICAgICBvdXRjb21lOiAnbm9uZScsIGNoZWNrZWQ6IGpvdXJuYWwuY2hlY2tlZCwgdmVyaWZpZWQ6IGpvdXJuYWwudmVyaWZpZWQsIGludGVudDogbnVsbFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjYXJkO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFVVUlEX1BBVFRFUk4udGVzdChpbnRlbnQuaWQpIHx8IGludGVudC5wYXRoICE9PSAnL2VudGl0eS9wcm9kdWN0LycgKyBpbnRlbnQuaWQpIHRocm93IEVycm9yKCfQndC10LrQvtGA0YDQtdC60YLQvdC+0LUg0L3QsNC80LXRgNC10L3QuNC1INC30LDQv9C40YHQuCcpO1xuICAgICAgICAgICAgY2FyZCA9IGF3YWl0IHJlYWRKc29uKHJlYWQsIGludGVudC5wYXRoKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB1bnJlc29sdmVkKGpvdXJuYWwsIHBlcnNpc3QpO1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICghY2FyZCB8fCBjYXJkLmlkICE9PSBpbnRlbnQuaWQgfHwgY2FyZC5uYW1lICE9PSBpbnRlbnQubmFtZSkge1xuICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2lkZW50aXR5JywgJ9Ca0LDRgNGC0L7Rh9C60LAg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0L3QsNC80LXRgNC10L3QuNC10LwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGJhc2UgPSBjYXJkQmFzZShjYXJkLCBpbnRlbnQuaWQpO1xuICAgICAgICAgICAgY29uc3QgYmFzZVByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgQkFTRV9QUklDRV9UWVBFX0lELCBCQVNFX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgICAgICBjb25zdCB0YXJnZXRQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIFRBUkdFVF9QUklDRV9UWVBFX0lELCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gbmV3IE1hcCgpO1xuICAgICAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIGJhc2VQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIHRhcmdldFByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgICAgICBpZiAoaW50ZWdlcihiYXNlUHJpY2UudmFsdWUpICE9PSBpbnRlbnQuYmFzZSkge1xuICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2Jhc2UnLCAn0JHQsNC30L7QstCw0Y8g0YbQtdC90LAg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0L3QsNC80LXRgNC10L3QuNC10LwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjYW5vbmljYWwob3RoZXJQcmljZXMoY2FyZCkpICE9PSBjYW5vbmljYWwoaW50ZW50Lm90aGVycykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcmljZXMnLCAn0JTRgNGD0LPQuNC1INGC0LjQv9GLINGG0LXQvSDQvdC1INGB0L7QstC/0LDQtNCw0Y7RgiDRgSDQvdCw0LzQtdGA0LXQvdC40LXQvCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGNhbm9uaWNhbChidXNpbmVzc0ZpZWxkcyhjYXJkKSkgIT09IGludGVudC5maWVsZHMgfHwgdGFyZ2V0UHJpY2UuY3VycmVuY3kubWV0YS5ocmVmICE9PSBpbnRlbnQuY3VycmVuY3kuaHJlZlxuICAgICAgICAgICAgICAgIHx8IHRhcmdldFByaWNlLnByaWNlVHlwZS5tZXRhLmhyZWYgIT09IGludGVudC5wcmljZVR5cGUuaHJlZikge1xuICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2ZpZWxkcycsICfQn9C+0LvRjyDQutCw0YDRgtC+0YfQutC4INC90LUg0YHQvtCy0L/QsNC00LDRjtGCINGBINC90LDQvNC10YDQtdC90LjQtdC8Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGludGVnZXIodGFyZ2V0UHJpY2UudmFsdWUpO1xuICAgICAgICAgICAgaWYgKHZhbHVlICE9PSBpbnRlbnQub2xkICYmIHZhbHVlICE9PSBpbnRlbnQubmV3KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgndGFyZ2V0JywgJ9Cm0LXQvdC90LjQuiDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDQvdC4INGB0L4g0YHRgtCw0YDRi9C8LCDQvdC4INGBINC90L7QstGL0Lwg0LfQvdCw0YfQtdC90LjQtdC8Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBhcHBsaWVkID0gdmFsdWUgPT09IGludGVudC5uZXc7XG4gICAgICAgICAgICBzZXRPdXRjb21lKGpvdXJuYWwsIGludGVudC5pZCwgYXBwbGllZCA/ICdhcHBsaWVkJyA6ICdub3QtYXBwbGllZCcpO1xuICAgICAgICAgICAgcmVjb3VudChqb3VybmFsKTtcbiAgICAgICAgICAgIGpvdXJuYWwuaW50ZW50ID0gbnVsbDtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ2ludGVycnVwdGVkJztcbiAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSBudWxsO1xuICAgICAgICAgICAgaWYgKCFhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIHN1bW1hcnk6ICdpbnRlcnJ1cHRlZCcsIHN0YXR1czogJ3VuY2VydGFpbicsIHJlc29sdmVkOiBmYWxzZSwgYmxvY2tlZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgb3V0Y29tZTogJ3VucmVzb2x2ZWQnLCBjaGVja2VkOiBqb3VybmFsLmNoZWNrZWQsIHZlcmlmaWVkOiBqb3VybmFsLnZlcmlmaWVkLFxuICAgICAgICAgICAgICAgICAgICBpbnRlbnQ6IHsgaWQ6IGludGVudC5pZCwgcGF0aDogaW50ZW50LnBhdGggfVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHN1bW1hcnk6ICdmaW5pc2hlZCcsIHN0YXR1czogJ2ludGVycnVwdGVkJywgcmVzb2x2ZWQ6IHRydWUsIGJsb2NrZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG91dGNvbWU6IGFwcGxpZWQgPyAnYXBwbGllZCcgOiAnbm90LWFwcGxpZWQnLFxuICAgICAgICAgICAgICAgIGNoZWNrZWQ6IGpvdXJuYWwuY2hlY2tlZCwgdmVyaWZpZWQ6IGpvdXJuYWwudmVyaWZpZWQsIGludGVudDogbnVsbFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB1bnJlc29sdmVkKGpvdXJuYWwsIHBlcnNpc3QpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIE9iamVjdC5mcmVlemUoeyBwbGFuLCBhcHBseSwgcmVjb25jaWxlLCBjYWxjdWxhdGUgfSk7XG59XG4iLCIvLyBPbmUgTWVtY2hhdCB3cml0ZXIgYWNyb3NzIGFsbCBuYXRpdmUgcGFuZWxzLiBBbiB1bmZpbmlzaGVkIGpvdXJuYWwgc3Vydml2ZXMgd29ya2VyIHJlc3RhcnRzLlxuY29uc3QgTUVNQ0hBVF9SRVBSSUNFX0pPVVJOQUwgPSAnbWVtY2hhdFJlcHJpY2VKb3VybmFsX3YxJztcblxuY29uc3QgcmVwcmljZVByZXZpZXdzID0gbmV3IE1hcCgpO1xuY29uc3QgcmVwcmljZVNldHRpbmdzID0gbmV3IE1hcCgpO1xuY29uc3QgcmVwcmljZVBlbmRpbmcgPSBuZXcgU2V0KCk7XG5sZXQgcmVwcmljZUJ1c3kgPSBmYWxzZTtcblxuZnVuY3Rpb24gcmVwcmljZU93bmVyKHNlbmRlcikge1xuICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSByZXR1cm4gJ25hdGl2ZTonICsgc2VuZGVyLnVybDtcbiAgICBpZiAodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSAmJiB0eXBlb2Ygc2VuZGVyLmRvY3VtZW50SWQgPT09ICdzdHJpbmcnICYmIHNlbmRlci5kb2N1bWVudElkKSB7XG4gICAgICAgIHJldHVybiBgY29udGVudDoke3NlbmRlci50YWIuaWR9OiR7c2VuZGVyLmRvY3VtZW50SWR9YDtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXByaWNlQWNjZXNzKHNlbmRlcikge1xuICAgIGlmICghcmVwcmljZU93bmVyKHNlbmRlcikpIHRocm93IEVycm9yKCfQn9Cw0L3QtdC70Ywg0L7RgtC60LvRjtGH0LXQvdCwJyk7XG4gICAgY29uc3Qgb3JpZ2luID0gcnVudGltZVNlbmRlck9yaWdpbihzZW5kZXIpO1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbjtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIG9yaWdpbjtcbiAgICBjb25zdCBidWNrZXQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgY29uc3QgYXBpID0gSlNPTi5wYXJzZShidWNrZXQ/Lml0ZW1zPy5bJ21lbWNoYXQ6aGFja2VyTXNBcGlfdjEnXT8udmFsdWUgfHwgJ3t9Jyk7XG4gICAgaWYgKCFyZXByaWNlT3duZXIoc2VuZGVyKSB8fCBhcGkuYmVhcmVyRW5hYmxlZCAhPT0gdHJ1ZSB8fCB0eXBlb2YgYXBpLnRva2VuICE9PSAnc3RyaW5nJyB8fCAhYXBpLnRva2VuLnRyaW0oKVxuICAgICAgICB8fCB0eXBlb2YgYXBpLnJlZmVyZW5jZVNjb3BlICE9PSAnc3RyaW5nJyB8fCAhYXBpLnJlZmVyZW5jZVNjb3BlKSB0aHJvdyBFcnJvcignQmVhcmVyINC90LXQtNC+0YHRgtGD0L/QtdC9Jyk7XG4gICAgcmV0dXJuIHsgb3JpZ2luLCBzY29wZTogYXBpLnJlZmVyZW5jZVNjb3BlLCB0b2tlbjogYXBpLnRva2VuIH07XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VTYW1lQWNjb3VudChsZWZ0LCByaWdodCkge1xuICAgIHJldHVybiBsZWZ0Lm9yaWdpbiA9PT0gcmlnaHQub3JpZ2luICYmIGxlZnQuc2NvcGUgPT09IHJpZ2h0LnNjb3BlO1xufVxuXG5sZXQgc2FsZXNTZXR0aW5nc0NoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5mdW5jdGlvbiBzYWxlc1NldHRpbmdzTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCB3b3JrID0gc2FsZXNTZXR0aW5nc0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IGFjY291bnRJZCB9ID0gbWVzc2FnZTtcbiAgICAgICAgY29uc3Qgc2F2ZSA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2FsZXMtc2V0dGluZ3Mtc2F2ZSc7XG4gICAgICAgIGlmICh0eXBlb2YgYWNjb3VudElkICE9PSAnc3RyaW5nJyB8fCAhTUVNQ0hBVF9SRVBSSUNFX1VVSUQudGVzdChhY2NvdW50SWQpKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgY29uc3QgY3JlZGVudGlhbCA9IGF3YWl0IHJlcHJpY2VBY2Nlc3Moc2VuZGVyKTtcbiAgICAgICAgY29uc3Qga2V5ID0gJ21lbWNoYXRTYWxlc1N0b3JlX3YxOicgKyBjcmVkZW50aWFsLm9yaWdpbiArICc6JyArIGFjY291bnRJZDtcbiAgICAgICAgY29uc3Qgc3RvcmVJZCA9IHNhdmUgPyBtZXNzYWdlLnN0b3JlSWQgOiAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgICAgIGlmICghc2F2ZSAmJiBzdG9yZUlkID09IG51bGwpIHJldHVybiB7IG9rOiB0cnVlLCBzdG9yZUlkOiBudWxsIH07XG4gICAgICAgIGlmICh0eXBlb2Ygc3RvcmVJZCAhPT0gJ3N0cmluZycgfHwgIU1FTUNIQVRfUkVQUklDRV9VVUlELnRlc3Qoc3RvcmVJZCkpIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgYWN0aXZlID0gYXdhaXQgcmVwcmljZUFjY2VzcyhzZW5kZXIpO1xuICAgICAgICAgICAgcmV0dXJuIHJlcHJpY2VTYW1lQWNjb3VudChhY3RpdmUsIGNyZWRlbnRpYWwpICYmIGFjdGl2ZS50b2tlbiA9PT0gY3JlZGVudGlhbC50b2tlbjtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwZXJmb3JtUmVxdWVzdCh7IGlkOiAnc2FsZXMtc3RvcmUtJyArIGNyeXB0by5yYW5kb21VVUlEKCksIHJlcXVlc3Q6IHtcbiAgICAgICAgICAgIHVybDogTUVNQ0hBVF9SRVBSSUNFX0FQSSArICcvZW50aXR5L3N0b3JlLycgKyBzdG9yZUlkLCBtZXRob2Q6ICdHRVQnLCBhbm9ueW1vdXM6IHRydWUsIGNyZWRlbnRpYWxHdWFyZDogdHJ1ZSxcbiAgICAgICAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciAnICsgY3JlZGVudGlhbC50b2tlbiwgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04JyB9LFxuICAgICAgICB9IH0sIHNlbmRlciwgdW5kZWZpbmVkLCBjdXJyZW50KTtcbiAgICAgICAgaWYgKHJlc3BvbnNlLmV2ZW50ICE9PSAnbG9hZCcgfHwgIWF3YWl0IGN1cnJlbnQoKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGlmICghc2F2ZSAmJiByZXNwb25zZS5yZXNwb25zZS5zdGF0dXMgPT09IDQwNCkgcmV0dXJuIHsgb2s6IHRydWUsIHN0b3JlSWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgY29uc3Qgc3RvcmUgPSBKU09OLnBhcnNlKHJlc3BvbnNlLnJlc3BvbnNlLnJlc3BvbnNlVGV4dCk7XG4gICAgICAgIGlmIChzdG9yZS5pZCAhPT0gc3RvcmVJZCB8fCBzdG9yZS5hY2NvdW50SWQgIT09IGFjY291bnRJZCB8fCBzdG9yZS5hcmNoaXZlZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHNhdmUgPyB7IG9rOiBmYWxzZSB9IDogeyBvazogdHJ1ZSwgc3RvcmVJZDogbnVsbCB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChzYXZlKSB7XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBba2V5XTogc3RvcmVJZCB9KTtcbiAgICAgICAgICAgIGlmICgoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV0gIT09IHN0b3JlSWQpIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzdG9yZUlkIH07XG4gICAgfSk7XG4gICAgc2FsZXNTZXR0aW5nc0NoYWluID0gd29yay5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHdvcmsuY2F0Y2goKCkgPT4gKHsgb2s6IGZhbHNlIH0pKTtcbn1cblxuZnVuY3Rpb24gcmVwcmljZVJ1bGVzS2V5KG9yaWdpbikgeyByZXR1cm4gJ21lbWNoYXRSZXByaWNlUnVsZXNfdjE6JyArIG9yaWdpbjsgfVxuXG5hc3luYyBmdW5jdGlvbiByZXByaWNlTG9hZFJ1bGVzKGFjY2Vzcykge1xuICAgIGNvbnN0IGtleSA9IHJlcHJpY2VSdWxlc0tleShhY2Nlc3Mub3JpZ2luKTtcbiAgICBjb25zdCByZWNvcmQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgaWYgKHJlY29yZD8uc2NvcGUgIT09IGFjY2Vzcy5zY29wZSkgcmV0dXJuIG51bGw7XG4gICAgaWYgKHR5cGVvZiByZWNvcmQucmV2aXNpb24gIT09ICdzdHJpbmcnIHx8ICFyZWNvcmQucnVsZXMpIHRocm93IEVycm9yKCfQn9GA0LDQstC40LvQsCDQv9C10YDQtdC+0YbQtdC90LrQuCDQvdC10LTQvtGB0YLRg9C/0L3Riy4nKTtcbiAgICByZXR1cm4gcmVjb3JkO1xufVxuXG5mdW5jdGlvbiByZXByaWNlT3JkZXJJZChyYXcpIHtcbiAgICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA+IDI1NikgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgcHJlZml4ID0gJ2h0dHBzOi8vb25saW5lLm1veXNrbGFkLnJ1L2FwcC8jaW50ZXJuYWxvcmRlci9lZGl0P2lkPSc7XG4gICAgY29uc3QgdXJsID0gcmF3LnRyaW0oKTtcbiAgICBjb25zdCBpZCA9IHVybC5zbGljZShwcmVmaXgubGVuZ3RoKTtcbiAgICByZXR1cm4gdXJsLnN0YXJ0c1dpdGgocHJlZml4KSAmJiBNRU1DSEFUX1JFUFJJQ0VfVVVJRC50ZXN0KGlkKSA/IGlkIDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVwcmljZUxpdmUoc2VuZGVyLCBvcmlnaW4pIHtcbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgcmV0dXJuIHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKSA9PT0gb3JpZ2luO1xuICAgIGxldCB0aW1lcjtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShzZW5kZXIudGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0OnJlcHJpY2UtY3VycmVudCcgfSwgeyBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9KSxcbiAgICAgICAgICAgIG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyB0aW1lciA9IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwMCk7IH0pXG4gICAgICAgIF0pO1xuICAgICAgICByZXR1cm4gcmVwbHk/LmN1cnJlbnQgPT09IHRydWUgJiYgcmVwbHkudXJsID09PSBzZW5kZXIudXJsICYmIG5ldyBVUkwocmVwbHkudXJsKS5vcmlnaW4gPT09IG9yaWdpbjtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IH1cbn1cblxuZnVuY3Rpb24gcmVwcmljZVJlbWVtYmVyKG1hcCwgb3duZXIsIHZhbHVlKSB7XG4gICAgbWFwLmRlbGV0ZShvd25lcik7XG4gICAgZm9yIChjb25zdCBba2V5LCBlbnRyeV0gb2YgbWFwKSBpZiAoZW50cnkuZXhwaXJlcyA8IERhdGUubm93KCkpIG1hcC5kZWxldGUoa2V5KTtcbiAgICBpZiAobWFwLnNpemUgPj0gMzIpIHJldHVybiBmYWxzZTtcbiAgICBtYXAuc2V0KG93bmVyLCB7IC4uLnZhbHVlLCBleHBpcmVzOiBEYXRlLm5vdygpICsgNSAqIDYwICogMTAwMCB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gcmVwcmljZVJlY292ZXJ5Q29uZmlnKHNhdmVkKSB7XG4gICAgaWYgKHNhdmVkLmNvbmZpZykgcmV0dXJuIHNhdmVkLmNvbmZpZztcbiAgICAvLyBWMSBqb3VybmFscyBwcmVkYXRlIGNvbmZpZ3VyYWJsZSBydWxlcy4gVXNlIG9ubHkgdGhlIElEcyBjYXB0dXJlZCBpbiB0aGVcbiAgICAvLyBvcmlnaW5hbCBqb3VybmFsOyB0aGUgbGVnYWN5IHNldHVwIGtleSBhbmQgY3VycmVudCBkZWZhdWx0cyBhcmUgbm90IG5lZWRlZC5cbiAgICBjb25zdCBvbGQgPSBKU09OLnBhcnNlKHNhdmVkLmNvbmZpZ0tleSB8fCAnbnVsbCcpO1xuICAgIGlmICghb2xkIHx8ICFbJ29yZGVySWQnLCAnYmFzZVR5cGVJZCcsICd0YXJnZXRUeXBlSWQnXS5ldmVyeShrZXkgPT5cbiAgICAgICAgdHlwZW9mIG9sZFtrZXldID09PSAnc3RyaW5nJyAmJiBNRU1DSEFUX1JFUFJJQ0VfVVVJRC50ZXN0KG9sZFtrZXldKSkgfHwgb2xkLmJhc2VUeXBlSWQgPT09IG9sZC50YXJnZXRUeXBlSWQpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ9CW0YPRgNC90LDQuyDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xuICAgIH1cbiAgICByZXR1cm4geyBvcmRlcklkOiBvbGQub3JkZXJJZCwgYmFzZVR5cGVJZDogb2xkLmJhc2VUeXBlSWQsIHRhcmdldFR5cGVJZDogb2xkLnRhcmdldFR5cGVJZCxcbiAgICAgICAgdGFyZ2V0VHlwZU5hbWU6IHNhdmVkLmpvdXJuYWwuaW50ZW50Py5wcmljZVR5cGU/Lm5hbWUgfTtcbn1cblxuZnVuY3Rpb24gcmVwcmljZVVuZmluaXNoZWQocmVjb3JkKSB7XG4gICAgcmV0dXJuICEhcmVjb3JkICYmIChyZWNvcmQuam91cm5hbD8uaW50ZW50ICE9IG51bGwgfHwgIVsndmVyaWZpZWQnLCAnaW50ZXJydXB0ZWQnLCAnZmFpbGVkJ10uaW5jbHVkZXMocmVjb3JkLmpvdXJuYWw/LnN0YXR1cykpO1xufVxuXG5mdW5jdGlvbiByZXByaWNlSm91cm5hbEpzb24odmFsdWUpIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUsIChfa2V5LCBpdGVtKSA9PiBpdGVtICYmIHR5cGVvZiBpdGVtID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShpdGVtKVxuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3Qua2V5cyhpdGVtKS5zb3J0KCkubWFwKGtleSA9PiBba2V5LCBpdGVtW2tleV1dKSkgOiBpdGVtKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVwcmljZUxvYWRKb3VybmFsKCkge1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgY29uc3QgcmVjb3JkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChNRU1DSEFUX1JFUFJJQ0VfSk9VUk5BTCkpW01FTUNIQVRfUkVQUklDRV9KT1VSTkFMXTtcbiAgICBpZiAocmVjb3JkID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgIGlmICghcmVjb3JkIHx8IHR5cGVvZiByZWNvcmQub3JpZ2luICE9PSAnc3RyaW5nJyB8fCB0eXBlb2YgcmVjb3JkLnNjb3BlICE9PSAnc3RyaW5nJyB8fCAhcmVjb3JkLmpvdXJuYWxcbiAgICAgICAgfHwgIVsnd3JpdGluZycsICd2ZXJpZmllZCcsICd1bmNlcnRhaW4nLCAnaW50ZXJydXB0ZWQnLCAnZmFpbGVkJ10uaW5jbHVkZXMocmVjb3JkLmpvdXJuYWwuc3RhdHVzKSkgdGhyb3cgRXJyb3IoJ9CW0YPRgNC90LDQuyDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xuICAgIHJldHVybiByZWNvcmQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcHJpY2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IGFjdGlvbiA9IG1lc3NhZ2UuYWN0aW9uO1xuICAgIGNvbnN0IHJlZnVzZSA9IChlcnJvciwgcmVjb3ZlcnkgPSBmYWxzZSkgPT4gKHsgb2s6IGZhbHNlLCBlcnJvciwgcmVjb3ZlcnkgfSk7XG4gICAgY29uc3Qgb3duZXIgPSByZXByaWNlT3duZXIoc2VuZGVyKTtcbiAgICBpZiAoIW93bmVyIHx8ICFbJ3ByZXZpZXcnLCAnYXBwbHknLCAncmVjb3ZlcicsICdzZXR0aW5ncy1sb2FkJywgJ3NldHRpbmdzLXNhdmUnXS5pbmNsdWRlcyhhY3Rpb24pKSB7XG4gICAgICAgIHJldHVybiByZWZ1c2UoJ9CX0LDQv9GA0L7RgSDQv9C10YDQtdC+0YbQtdC90LrQuCDQvtGC0LrQu9C+0L3RkdC9LicpO1xuICAgIH1cbiAgICBjb25zdCBzZXR0aW5ncyA9IGFjdGlvbi5zdGFydHNXaXRoKCdzZXR0aW5ncy0nKTtcbiAgICBjb25zdCBjaGFuZ2VzU3RhdGUgPSBbJ2FwcGx5JywgJ3JlY292ZXInLCAnc2V0dGluZ3Mtc2F2ZSddLmluY2x1ZGVzKGFjdGlvbik7XG4gICAgaWYgKHJlcHJpY2VCdXN5IHx8IHJlcHJpY2VQZW5kaW5nLmhhcyhvd25lcikpIHJldHVybiByZWZ1c2UoJ9CU0YDRg9Cz0L7QuSDQt9Cw0L/RgNC+0YEg0L/QtdGA0LXQvtGG0LXQvdC60Lgg0YPQttC1INCy0YvQv9C+0LvQvdGP0LXRgtGB0Y8uJyk7XG4gICAgY29uc3Qgb3JkZXJJZCA9IGFjdGlvbiA9PT0gJ3ByZXZpZXcnID8gcmVwcmljZU9yZGVySWQobWVzc2FnZS5vcmRlckxpbmspIDogbnVsbDtcbiAgICBpZiAoYWN0aW9uID09PSAncHJldmlldycpIHtcbiAgICAgICAgcmVwcmljZVByZXZpZXdzLmRlbGV0ZShvd25lcik7XG4gICAgICAgIGlmICghb3JkZXJJZCkgcmV0dXJuIHJlZnVzZSgn0JLRgdGC0LDQstGM0YLQtSDRgdGB0YvQu9C60YMg0L3QsCDQstC90YPRgtGA0LXQvdC90LjQuSDQt9Cw0LrQsNC3INC40Lcgb25saW5lLm1veXNrbGFkLnJ1LicpO1xuICAgIH1cbiAgICBpZiAoY2hhbmdlc1N0YXRlKSByZXByaWNlQnVzeSA9IHRydWU7XG4gICAgcmVwcmljZVBlbmRpbmcuYWRkKG93bmVyKTtcbiAgICBsZXQgZW50ZXJlZFNlcnZpY2UgPSBmYWxzZTtcbiAgICBsZXQgcnVuSWQgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNyZWRlbnRpYWwgPSBhd2FpdCByZXByaWNlQWNjZXNzKHNlbmRlcik7XG4gICAgICAgIGNvbnN0IHJ1bGVzUmVjb3JkID0gYWN0aW9uID09PSAncmVjb3ZlcicgPyBudWxsIDogYXdhaXQgcmVwcmljZUxvYWRSdWxlcyhjcmVkZW50aWFsKTtcbiAgICAgICAgY29uc3QgcmV2aXNpb24gPSBydWxlc1JlY29yZD8ucmV2aXNpb24gPz8gbnVsbDtcbiAgICAgICAgY29uc3QgaXNDdXJyZW50ID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFhd2FpdCByZXByaWNlTGl2ZShzZW5kZXIsIGNyZWRlbnRpYWwub3JpZ2luKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IHJlcHJpY2VBY2Nlc3Moc2VuZGVyKTtcbiAgICAgICAgICAgIGlmICghcmVwcmljZVNhbWVBY2NvdW50KGN1cnJlbnQsIGNyZWRlbnRpYWwpIHx8IGN1cnJlbnQudG9rZW4gIT09IGNyZWRlbnRpYWwudG9rZW4pIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IGxhdGVzdCA9IGFjdGlvbiA9PT0gJ3JlY292ZXInID8gbnVsbCA6IGF3YWl0IHJlcHJpY2VMb2FkUnVsZXMoY3VycmVudCk7XG4gICAgICAgICAgICByZXR1cm4gcmVwcmljZU93bmVyKHNlbmRlcikgPT09IG93bmVyICYmIChsYXRlc3Q/LnJldmlzaW9uID8/IG51bGwpID09PSByZXZpc2lvblxuICAgICAgICAgICAgICAgICYmIHJlcHJpY2VKb3VybmFsSnNvbihsYXRlc3Q/LnJ1bGVzID8/IG51bGwpID09PSByZXByaWNlSm91cm5hbEpzb24ocnVsZXNSZWNvcmQ/LnJ1bGVzID8/IG51bGwpO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCByZXF1ZXN0ID0gYXN5bmMgKG1ldGhvZCwgcGF0aCwgYm9keSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChNRU1DSEFUX1JFUFJJQ0VfQVBJICsgcGF0aCk7XG4gICAgICAgICAgICBpZiAodXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1JyB8fCAhL15cXC9hcGlcXC9yZW1hcFxcLzFcXC4yXFwvKD86ZW50aXR5fGNvbnRleHQpXFwvLy50ZXN0KHVybC5wYXRobmFtZSkgfHwgdXJsLmhhc2gpIHRocm93IEVycm9yKCdJbnZhbGlkIEFQSSBwYXRoJyk7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHBlcmZvcm1SZXF1ZXN0KHsgaWQ6ICdyZXByaWNlLScgKyBjcnlwdG8ucmFuZG9tVVVJRCgpLCByZXF1ZXN0OiB7XG4gICAgICAgICAgICAgICAgdXJsOiB1cmwuaHJlZiwgbWV0aG9kLCBhbm9ueW1vdXM6IHRydWUsIGNyZWRlbnRpYWxHdWFyZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246ICdCZWFyZXIgJyArIGNyZWRlbnRpYWwudG9rZW4sIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcsIC4uLihib2R5ID8geyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfSA6IHt9KSB9LFxuICAgICAgICAgICAgICAgIGRhdGE6IGJvZHkgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZFxuICAgICAgICAgICAgfSB9LCBzZW5kZXIsIHVuZGVmaW5lZCwgaXNDdXJyZW50KTtcbiAgICAgICAgICAgIGlmIChyZXNwb25zZS5ldmVudCAhPT0gJ2xvYWQnIHx8ICFhd2FpdCBpc0N1cnJlbnQoKSkgdGhyb3cgRXJyb3IoJ9Ch0L7QtdC00LjQvdC10L3QuNC1INGBINCc0L7QudCh0LrQu9Cw0LQg0L/QvtGC0LXRgNGP0L3QvicpO1xuICAgICAgICAgICAgY29uc3Qgc3RhdHVzID0gcmVzcG9uc2UucmVzcG9uc2Uuc3RhdHVzO1xuICAgICAgICAgICAgaWYgKHN0YXR1cyA8IDIwMCB8fCBzdGF0dXMgPj0gMzAwKSB7IGNvbnN0IGVycm9yID0gRXJyb3IoJ9Cc0L7QudCh0LrQu9Cw0LQ6IEhUVFAgJyArIHN0YXR1cyk7IGVycm9yLnN0YXR1cyA9IHN0YXR1czsgdGhyb3cgZXJyb3I7IH1cbiAgICAgICAgICAgIHJldHVybiBtZXRob2QgPT09ICdHRVQnID8gSlNPTi5wYXJzZShyZXNwb25zZS5yZXNwb25zZS5yZXNwb25zZVRleHQpIDogdW5kZWZpbmVkO1xuICAgICAgICB9O1xuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcbiAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdzZXR0aW5ncy1sb2FkJykge1xuICAgICAgICAgICAgICAgIHJlcHJpY2VTZXR0aW5ncy5kZWxldGUob3duZXIpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHR5cGVzID0gbWVtY2hhdFJlcHJpY2VQcmljZVR5cGVzKGF3YWl0IHJlcXVlc3QoJ0dFVCcsIE1FTUNIQVRfUkVQUklDRV9QUklDRV9UWVBFUykpO1xuICAgICAgICAgICAgICAgIGlmICh0eXBlcy5zaXplIDwgMikgcmV0dXJuIHJlZnVzZSgn0JIg0JzQvtC50KHQutC70LDQtCDQvdGD0LbQvdGLINGF0L7RgtGPINCx0Ysg0LTQstCwINGC0LjQv9CwINGG0LXQvS4nKTtcbiAgICAgICAgICAgICAgICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgICAgICAgICAgICAgaWYgKCFyZXByaWNlUmVtZW1iZXIocmVwcmljZVNldHRpbmdzLCBvd25lciwgeyBpZCwgY3JlZGVudGlhbCwgcmV2aXNpb24sIHR5cGVzLCBzb3VyY2VVcmw6IHNlbmRlci51cmwgfSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzZSgn0KHQu9C40YjQutC+0Lwg0LzQvdC+0LPQviDQvtGC0LrRgNGL0YLRi9GFINC90LDRgdGC0YDQvtC10LouINCf0L7QstGC0L7RgNC40YLQtSDQv9C+0LfQttC1LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaWQsIHJ1bGVzOiBydWxlc1JlY29yZD8ucnVsZXMgfHwgTUVNQ0hBVF9SRVBSSUNFX0RFRkFVTFRTLFxuICAgICAgICAgICAgICAgICAgICBwcmljZVR5cGVzOiBBcnJheS5mcm9tKHR5cGVzLCAoW2lkLCBuYW1lXSkgPT4gKHsgaWQsIG5hbWUgfSkpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBvcGVuZWQgPSByZXByaWNlU2V0dGluZ3MuZ2V0KG93bmVyKTtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLmNvbmZpcm1lZCAhPT0gdHJ1ZSB8fCAhb3BlbmVkIHx8IG9wZW5lZC5pZCAhPT0gbWVzc2FnZS5pZCB8fCBvcGVuZWQuZXhwaXJlcyA8IERhdGUubm93KClcbiAgICAgICAgICAgICAgICB8fCAhcmVwcmljZVNhbWVBY2NvdW50KG9wZW5lZC5jcmVkZW50aWFsLCBjcmVkZW50aWFsKSB8fCBvcGVuZWQuY3JlZGVudGlhbC50b2tlbiAhPT0gY3JlZGVudGlhbC50b2tlblxuICAgICAgICAgICAgICAgIHx8IG9wZW5lZC5yZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgb3BlbmVkLnNvdXJjZVVybCAhPT0gc2VuZGVyLnVybCkgcmV0dXJuIHJlZnVzZSgn0J3QsNGB0YLRgNC+0LnQutC4INGD0YHRgtCw0YDQtdC70LguINCX0LDQs9GA0YPQt9C40YLQtSDRgtC40L/RiyDRhtC10L0g0LfQsNC90L7QstC+LicpO1xuICAgICAgICAgICAgY29uc3QgeyBiYXNlVHlwZUlkLCB0YXJnZXRUeXBlSWQgfSA9IG1lc3NhZ2UucnVsZXMgPz8ge307XG4gICAgICAgICAgICBpZiAoIW9wZW5lZC50eXBlcy5oYXMoYmFzZVR5cGVJZCkgfHwgIW9wZW5lZC50eXBlcy5oYXModGFyZ2V0VHlwZUlkKSB8fCBiYXNlVHlwZUlkID09PSB0YXJnZXRUeXBlSWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVmdXNlKCfQktGL0LHQtdGA0LjRgtC1INC00LLQsCDRgNCw0LfQvdGL0YUg0YLQuNC/0LAg0YbQtdC9INC40Lcg0YHQv9GA0LDQstC+0YfQvdC40LrQsC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCBmb3JtdWxhO1xuICAgICAgICAgICAgdHJ5IHsgZm9ybXVsYSA9IG1lbWNoYXRSZXByaWNlRm9ybXVsYShtZXNzYWdlLnJ1bGVzKTsgfSBjYXRjaCAoZXJyb3IpIHsgcmV0dXJuIHJlZnVzZShlcnJvci5tZXNzYWdlKTsgfVxuICAgICAgICAgICAgY29uc3QgcnVsZXMgPSB7IGJhc2VUeXBlSWQsIGJhc2VUeXBlTmFtZTogb3BlbmVkLnR5cGVzLmdldChiYXNlVHlwZUlkKSwgdGFyZ2V0VHlwZUlkLFxuICAgICAgICAgICAgICAgIHRhcmdldFR5cGVOYW1lOiBvcGVuZWQudHlwZXMuZ2V0KHRhcmdldFR5cGVJZCksIC4uLmZvcm11bGEgfTtcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlcHJpY2VSdWxlc0tleShjcmVkZW50aWFsLm9yaWdpbik7XG4gICAgICAgICAgICBjb25zdCBleHBlY3RlZCA9IHsgc2NvcGU6IGNyZWRlbnRpYWwuc2NvcGUsIHJldmlzaW9uOiBjcnlwdG8ucmFuZG9tVVVJRCgpLCBydWxlcyB9O1xuICAgICAgICAgICAgaWYgKCFhd2FpdCBpc0N1cnJlbnQoKSkgcmV0dXJuIHJlZnVzZSgn0J3QsNGB0YLRgNC+0LnQutC4INGD0YHRgtCw0YDQtdC70LguINCX0LDQs9GA0YPQt9C40YLQtSDRgtC40L/RiyDRhtC10L0g0LfQsNC90L7QstC+LicpO1xuICAgICAgICAgICAgcmVwcmljZVNldHRpbmdzLmRlbGV0ZShvd25lcik7XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBba2V5XTogZXhwZWN0ZWQgfSk7XG4gICAgICAgICAgICBpZiAocmVwcmljZUpvdXJuYWxKc29uKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XSkgIT09IHJlcHJpY2VKb3VybmFsSnNvbihleHBlY3RlZCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVmdXNlKCfQodC+0YXRgNCw0L3QtdC90LjQtSDQv9GA0LDQstC40Lsg0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTQtdC90L4uINCe0YLQutGA0L7QudGC0LUg0L3QsNGB0YLRgNC+0LnQutC4INC30LDQvdC+0LLQvi4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBydWxlcyB9O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgcmVwcmljZUxvYWRKb3VybmFsKCk7XG4gICAgICAgIGNvbnN0IHVuZmluaXNoZWQgPSByZXByaWNlVW5maW5pc2hlZChzYXZlZCk7XG4gICAgICAgIGlmICh1bmZpbmlzaGVkICYmICFyZXByaWNlU2FtZUFjY291bnQoc2F2ZWQsIGNyZWRlbnRpYWwpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmdXNlKCfQldGB0YLRjCDQvdC10LfQsNCy0LXRgNGI0ZHQvdC90LDRjyDQv9C10YDQtdC+0YbQtdC90LrQsC4g0JTQu9GPINC/0YDQvtCy0LXRgNC60Lgg0L3Rg9C20LXQvSDQv9GA0LXQttC90LjQuSDQv9GA0L7RhNC40LvRjCBCZWFyZXIuJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHVuZmluaXNoZWQgJiYgYWN0aW9uICE9PSAncmVjb3ZlcicpIHJldHVybiByZWZ1c2UoJ9Cd0LXQt9Cw0LLQtdGA0YjRkdC90L3QsNGPINC/0LXRgNC10L7RhtC10L3QutCwLiDQodC90LDRh9Cw0LvQsCDQv9GA0L7QstC10YDRjNGC0LUg0LfQsNC/0LjRgdGMINCyINCc0L7QudCh0LrQu9Cw0LQuJywgdHJ1ZSk7XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdyZWNvdmVyJyAmJiAhdW5maW5pc2hlZCkgcmV0dXJuIHsgb2s6IHRydWUsIHN0YXR1czogJ25vbmUnLCB2ZXJpZmllZDogMCB9O1xuICAgICAgICBpZiAoYWN0aW9uICE9PSAncmVjb3ZlcicgJiYgIXJ1bGVzUmVjb3JkKSByZXR1cm4gcmVmdXNlKCfQktGL0LHQtdGA0LjRgtC1INC4INGB0L7RhdGA0LDQvdC40YLQtSDRgtC40L/RiyDRhtC10L0g0LIg0L3QsNGB0YLRgNC+0LnQutCw0YUg0L/QtdGA0LXQvtGG0LXQvdC60LguJyk7XG4gICAgICAgIGNvbnN0IHByZXZpZXcgPSBhY3Rpb24gPT09ICdhcHBseScgPyByZXByaWNlUHJldmlld3MuZ2V0KG93bmVyKSA6IG51bGw7XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdhcHBseScgJiYgKG1lc3NhZ2UuY29uZmlybWVkICE9PSB0cnVlIHx8ICFwcmV2aWV3IHx8IG1lc3NhZ2UuaWQgIT09IHByZXZpZXcuaWQgfHwgcHJldmlldy5leHBpcmVzIDwgRGF0ZS5ub3coKVxuICAgICAgICAgICAgfHwgIXJlcHJpY2VTYW1lQWNjb3VudChwcmV2aWV3LmNyZWRlbnRpYWwsIGNyZWRlbnRpYWwpIHx8IHByZXZpZXcuY3JlZGVudGlhbC50b2tlbiAhPT0gY3JlZGVudGlhbC50b2tlblxuICAgICAgICAgICAgfHwgcHJldmlldy5yZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgcHJldmlldy5zb3VyY2VVcmwgIT09IHNlbmRlci51cmxcbiAgICAgICAgICAgIHx8IHJlcHJpY2VKb3VybmFsSnNvbihwcmV2aWV3LnJ1bGVzKSAhPT0gcmVwcmljZUpvdXJuYWxKc29uKHJ1bGVzUmVjb3JkLnJ1bGVzKSkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZ1c2UoJ9Cf0YDQtdC00L/RgNC+0YHQvNC+0YLRgCDRg9GB0YLQsNGA0LXQuyDQuNC70Lgg0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTRkdC9LiDQl9Cw0LPRgNGD0LfQuNGC0LUg0LXQs9C+INGB0L3QvtCy0LAuJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY29uZmlnID0gYWN0aW9uID09PSAncmVjb3ZlcicgPyByZXByaWNlUmVjb3ZlcnlDb25maWcoc2F2ZWQpIDogeyAuLi5ydWxlc1JlY29yZC5ydWxlcywgb3JkZXJJZDogb3JkZXJJZCB8fCBwcmV2aWV3Lm9yZGVySWQgfTtcbiAgICAgICAgY29uc3QgcmVhZCA9IHBhdGggPT4gcmVxdWVzdCgnR0VUJywgcGF0aCk7XG4gICAgICAgIHJ1bklkID0gYWN0aW9uID09PSAncmVjb3ZlcicgPyBzYXZlZC5ydW4gOiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICAgICAgICBsZXQgZHVyYWJsZUludGVudCA9IG51bGw7XG4gICAgICAgIGNvbnN0IHBlcnNpc3QgPSBhc3luYyBqb3VybmFsID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkID0geyBvcmlnaW46IGNyZWRlbnRpYWwub3JpZ2luLCBzY29wZTogY3JlZGVudGlhbC5zY29wZSwgY29uZmlnLCBydW46IHJ1bklkLCBqb3VybmFsIH07XG4gICAgICAgICAgICBjb25zdCBlbmNvZGVkID0gcmVwcmljZUpvdXJuYWxKc29uKGV4cGVjdGVkKTtcbiAgICAgICAgICAgIGlmIChlbmNvZGVkLmxlbmd0aCA+IDEwMjQgKiAxMDI0KSB0aHJvdyBFcnJvcign0JbRg9GA0L3QsNC7INGB0LvQuNGI0LrQvtC8INCx0L7Qu9GM0YjQvtC5Jyk7XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTUVNQ0hBVF9SRVBSSUNFX0pPVVJOQUxdOiBKU09OLnBhcnNlKGVuY29kZWQpIH0pO1xuICAgICAgICAgICAgY29uc3QgY29tbWl0dGVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChNRU1DSEFUX1JFUFJJQ0VfSk9VUk5BTCkpW01FTUNIQVRfUkVQUklDRV9KT1VSTkFMXTtcbiAgICAgICAgICAgIGlmIChyZXByaWNlSm91cm5hbEpzb24oY29tbWl0dGVkKSAhPT0gZW5jb2RlZCkgdGhyb3cgRXJyb3IoJ9CW0YPRgNC90LDQuyDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0nKTtcbiAgICAgICAgICAgIGR1cmFibGVJbnRlbnQgPSBqb3VybmFsLmludGVudCA/IHsgcGF0aDogam91cm5hbC5pbnRlbnQucGF0aCwgdmFsdWU6IGpvdXJuYWwuaW50ZW50Lm5ldyB9IDogbnVsbDtcbiAgICAgICAgICAgIHJldHVybiBjb21taXR0ZWQuam91cm5hbDtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3Qgc2VydmljZSA9IGNyZWF0ZU1lbWNoYXRSZXByaWNlU2VydmljZShjb25maWcpO1xuICAgICAgICBpZiAoYWN0aW9uID09PSAncHJldmlldycpIHtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBzZXJ2aWNlLnBsYW4ocmVhZCk7XG4gICAgICAgICAgICBpZiAoZGF0YS5lbnRyaWVzLmxlbmd0aCArIGRhdGEuc2tpcHBlZC5sZW5ndGggPiA1MDApIHJldHVybiByZWZ1c2UoJ9CSINC30LDQutCw0LfQtSDQsdC+0LvRjNGI0LUgNTAwINC60LDRgNGC0L7Rh9C10LouINCf0LXRgNC10L7RhtC10L3QutCwINC90LUg0LfQsNC/0YPRidC10L3QsC4nKTtcbiAgICAgICAgICAgIGlmICghYXdhaXQgaXNDdXJyZW50KCkgfHwgcmVwcmljZUJ1c3kpIHJldHVybiByZWZ1c2UoJ9Cf0LvQsNC9INGD0YHRgtCw0YDQtdC7LiDQntCx0L3QvtCy0LjRgtC1INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgC4nKTtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICAgICAgICAgIGlmICghcmVwcmljZVJlbWVtYmVyKHJlcHJpY2VQcmV2aWV3cywgb3duZXIsIHsgaWQsIGRhdGEsIGNyZWRlbnRpYWwsIG9yZGVySWQsIHJldmlzaW9uLCBydWxlczogcnVsZXNSZWNvcmQucnVsZXMsIHNvdXJjZVVybDogc2VuZGVyLnVybCB9KSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWZ1c2UoJ9Ch0LvQuNGI0LrQvtC8INC80L3QvtCz0L4g0LDQutGC0LjQstC90YvRhSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YDQvtCyLiDQn9C+0LLRgtC+0YDQuNGC0LUg0YfQtdGA0LXQtyDQvdC10YHQutC+0LvRjNC60L4g0LzQuNC90YPRgi4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpZCwgb3JkZXJOYW1lOiBkYXRhLm9yZGVyTmFtZSwgYmFzZU5hbWU6IGNvbmZpZy5iYXNlVHlwZU5hbWUsIHRhcmdldE5hbWU6IGNvbmZpZy50YXJnZXRUeXBlTmFtZSxcbiAgICAgICAgICAgICAgICBlbnRyaWVzOiBkYXRhLmVudHJpZXMubWFwKCh7IGlkLCBuYW1lLCBiYXNlLCBvbGQsIG5ldzogbmV4dCB9KSA9PiAoeyBpZCwgbmFtZSwgYmFzZSwgb2xkLCBuZXh0IH0pKSwgc2tpcHBlZDogZGF0YS5za2lwcGVkIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFhd2FpdCBpc0N1cnJlbnQoKSkgcmV0dXJuIHJlZnVzZSgn0JTQvtC60YPQvNC10L3RgiDQuNC70Lgg0L3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QuNC70LjRgdGMLiDQn9C+0LLRgtC+0YDQuNGC0LUg0L/RgNC+0LLQtdGA0LrRgy4nLCB1bmZpbmlzaGVkKTtcbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3JlY292ZXInKSB7XG4gICAgICAgICAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgc2VydmljZS5yZWNvbmNpbGUoc2F2ZWQuam91cm5hbCwgeyByZWFkLCBwZXJzaXN0IH0pO1xuICAgICAgICAgICAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgcmVwcmljZUxvYWRKb3VybmFsKCk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgc3RhdHVzOiBsYXRlc3Q/LmpvdXJuYWwuc3RhdHVzIHx8IG91dGNvbWU/LnN0YXR1cywgdmVyaWZpZWQ6IGxhdGVzdD8uam91cm5hbC52ZXJpZmllZCB8fCAwLFxuICAgICAgICAgICAgICAgIHJlY292ZXJ5OiByZXByaWNlVW5maW5pc2hlZChsYXRlc3QpIH07XG4gICAgICAgIH1cbiAgICAgICAgcmVwcmljZVByZXZpZXdzLmRlbGV0ZShvd25lcik7XG4gICAgICAgIGNvbnN0IGNoYW5nZXMgPSBuZXcgTWFwKHByZXZpZXcuZGF0YS5lbnRyaWVzLmZpbHRlcihlbnRyeSA9PiBlbnRyeS5uZXcgIT09IGVudHJ5Lm9sZClcbiAgICAgICAgICAgIC5tYXAoZW50cnkgPT4gWycvZW50aXR5L3Byb2R1Y3QvJyArIGVudHJ5LmlkLCBlbnRyeS5uZXddKSk7XG4gICAgICAgIGlmICghY2hhbmdlcy5zaXplKSByZXR1cm4gcmVmdXNlKCfQkiDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YDQtSDQvdC10YIg0LjQt9C80LXQvdC10L3QuNC5LicpO1xuICAgICAgICBjb25zdCB3cml0ZSA9IChwYXRoLCBib2R5KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBsaW5lID0gYm9keT8uc2FsZVByaWNlcz8uWzBdO1xuICAgICAgICAgICAgaWYgKCEvXlxcL2VudGl0eVxcL3Byb2R1Y3RcXC9bYS1mMC05LV17MzZ9JC9pLnRlc3QocGF0aCkgfHwgIWNoYW5nZXMuaGFzKHBhdGgpXG4gICAgICAgICAgICAgICAgfHwgZHVyYWJsZUludGVudD8ucGF0aCAhPT0gcGF0aCB8fCBkdXJhYmxlSW50ZW50LnZhbHVlICE9PSBsaW5lPy52YWx1ZVxuICAgICAgICAgICAgICAgIHx8IE9iamVjdC5rZXlzKGJvZHkgfHwge30pLmxlbmd0aCAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShib2R5LnNhbGVQcmljZXMpIHx8IGJvZHkuc2FsZVByaWNlcy5sZW5ndGggIT09IDFcbiAgICAgICAgICAgICAgICB8fCBPYmplY3Qua2V5cyhsaW5lIHx8IHt9KS5sZW5ndGggIT09IDMgfHwgbGluZS52YWx1ZSAhPT0gY2hhbmdlcy5nZXQocGF0aClcbiAgICAgICAgICAgICAgICB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIobGluZS52YWx1ZSkgfHwgbGluZS52YWx1ZSA8PSAwXG4gICAgICAgICAgICAgICAgfHwgbGluZS5wcmljZVR5cGU/Lm1ldGE/LmhyZWYgIT09ICdodHRwczovL2FwaS5tb3lza2xhZC5ydS9hcGkvcmVtYXAvMS4yL2NvbnRleHQvY29tcGFueXNldHRpbmdzL3ByaWNldHlwZS8nICsgY29uZmlnLnRhcmdldFR5cGVJZFxuICAgICAgICAgICAgICAgIHx8ICEvXmh0dHBzOlxcL1xcL2FwaVxcLm1veXNrbGFkXFwucnVcXC9hcGlcXC9yZW1hcFxcLzFcXC4yXFwvZW50aXR5XFwvY3VycmVuY3lcXC9bYS1mMC05LV17MzZ9JC9pLnRlc3QobGluZS5jdXJyZW5jeT8ubWV0YT8uaHJlZikpIHRocm93IEVycm9yKCfQndC10LTQvtC/0YPRgdGC0LjQvNCw0Y8g0LfQsNC/0LjRgdGMINGG0LXQvdC90LjQutCwJyk7XG4gICAgICAgICAgICBjaGFuZ2VzLmRlbGV0ZShwYXRoKTsgLy8gTm8gc2Vjb25kIFBVVCBldmVuIGlmIGl0cyBmaXJzdCByZXNwb25zZSBpcyBhbWJpZ3VvdXMuXG4gICAgICAgICAgICBkdXJhYmxlSW50ZW50ID0gbnVsbDtcbiAgICAgICAgICAgIHJldHVybiByZXF1ZXN0KCdQVVQnLCBwYXRoLCBib2R5KTtcbiAgICAgICAgfTtcbiAgICAgICAgZW50ZXJlZFNlcnZpY2UgPSB0cnVlO1xuICAgICAgICBjb25zdCBqb3VybmFsID0gYXdhaXQgc2VydmljZS5hcHBseShwcmV2aWV3LmRhdGEsIHsgcmVhZCwgd3JpdGUsIHBlcnNpc3QgfSk7XG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IHJlcHJpY2VMb2FkSm91cm5hbCgpO1xuICAgICAgICBjb25zdCByZWNvdmVyeSA9IHJlcHJpY2VVbmZpbmlzaGVkKHN0b3JlZCk7XG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gam91cm5hbC52ZXJpZmllZDtcbiAgICAgICAgY29uc3QgZXJyb3IgPSByZWNvdmVyeSA/ICfQl9Cw0L/Rg9GB0Log0L3QtSDQt9Cw0LLQtdGA0YjRkdC9LiDQn9GA0L7QstC10YDRjNGC0LUg0L3QtdC30LDQstC10YDRiNGR0L3QvdGD0Y4g0LfQsNC/0LjRgdGMINCyINCc0L7QudCh0LrQu9Cw0LQuJ1xuICAgICAgICAgICAgOiBqb3VybmFsLmVycm9yID09PSAnc3RhbGUtcHJldmlldycgPyAn0J/Qu9Cw0L0g0LjQt9C80LXQvdC40LvRgdGPLiDQl9Cw0LPRgNGD0LfQuNGC0LUg0L3QvtCy0YvQuSDQv9GA0LXQtNC/0YDQvtGB0LzQvtGC0YAuJ1xuICAgICAgICAgICAgICAgIDogdmVyaWZpZWQgPyBg0J/QtdGA0LXQvtGG0LXQvdC60LAg0L7RgdGC0LDQvdC+0LLQu9C10L3QsC4g0KHQstC10YDQtdC90L4g0LTQviDQvtGB0YLQsNC90L7QstC60Lg6ICR7dmVyaWZpZWR9LiDQl9Cw0LPRgNGD0LfQuNGC0LUg0YHQstC10LbQuNC5INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgC5gXG4gICAgICAgICAgICAgICAgICAgIDogJ9Cf0LXRgNC10L7RhtC10L3QutCwINC90LUg0LfQsNCy0LXRgNGI0LXQvdCwLiDQn9GA0L7QstC10YDRjNGC0LUg0LTQsNC90L3Ri9C1INC4INC00L7RgdGC0YPQvyDQnNC+0LnQodC60LvQsNC0Lic7XG4gICAgICAgIHJldHVybiB7IG9rOiBqb3VybmFsLnN0YXR1cyA9PT0gJ3ZlcmlmaWVkJywgc3RhdHVzOiBqb3VybmFsLnN0YXR1cywgdmVyaWZpZWQ6IGpvdXJuYWwudmVyaWZpZWQsXG4gICAgICAgICAgICBjaGVja2VkOiBqb3VybmFsLmNoZWNrZWQsIGNoYW5nZWQ6IGpvdXJuYWwuY2hhbmdlZCwgcmVjb3ZlcnksXG4gICAgICAgICAgICAuLi4oam91cm5hbC5zdGF0dXMgPT09ICd2ZXJpZmllZCcgPyB7fSA6IHsgZXJyb3IgfSkgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoc2V0dGluZ3MpIHJldHVybiByZWZ1c2UoTnVtYmVyLmlzSW50ZWdlcihlcnJvcj8uc3RhdHVzKSA/ICfQnNC+0LnQodC60LvQsNC0OiBIVFRQICcgKyBlcnJvci5zdGF0dXMgKyAnLiDQn9GA0L7QstC10YDRjNGC0LUg0LTQvtGB0YLRg9C/IEJlYXJlci4nXG4gICAgICAgICAgICA6ICfQndC1INGD0LTQsNC70L7RgdGMINC30LDQs9GA0YPQt9C40YLRjCDQuNC70Lgg0YHQvtGF0YDQsNC90LjRgtGMINC/0YDQsNCy0LjQu9CwLiDQn9GA0L7QstC10YDRjNGC0LUg0LTQvtGB0YLRg9C/IEJlYXJlciDQuCDQvtGC0LrRgNC+0LnRgtC1INC90LDRgdGC0YDQvtC50LrQuCDQt9Cw0L3QvtCy0L4uJyk7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgcmVwcmljZUxvYWRKb3VybmFsKCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgIGNvbnN0IHVucmVzb2x2ZWQgPSByZXByaWNlVW5maW5pc2hlZChzYXZlZCk7XG4gICAgICAgIGNvbnN0IHBhcnRpYWwgPSBlbnRlcmVkU2VydmljZSAmJiBzYXZlZD8ucnVuID09PSBydW5JZCAmJiBzYXZlZC5qb3VybmFsLnZlcmlmaWVkID4gMDtcbiAgICAgICAgY29uc3Qgc3RhdHVzID0gZXJyb3I/LnN0YXR1cztcbiAgICAgICAgcmV0dXJuIHsgLi4ucmVmdXNlKHVucmVzb2x2ZWQgPyAn0JfQsNC/0YPRgdC6INC90LUg0LfQsNCy0LXRgNGI0ZHQvS4g0J/QtdGA0LXQtCDQv9C+0LLRgtC+0YDQvtC8INC/0YDQvtCy0LXRgNGM0YLQtSDQttGD0YDQvdCw0Ls6INGH0LDRgdGC0Ywg0YbQtdC9INC80L7Qs9C70LAg0LjQt9C80LXQvdC40YLRjNGB0Y8uJ1xuICAgICAgICAgICAgOiBwYXJ0aWFsID8gJ9Cf0LXRgNC10L7RhtC10L3QutCwINCy0YvQv9C+0LvQvdC10L3QsCDRh9Cw0YHRgtC40YfQvdC+LiDQl9Cw0LPRgNGD0LfQuNGC0LUg0YHQstC10LbQuNC5INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgC4nXG4gICAgICAgICAgICAgICAgOiBlcnJvcj8uY29kZSA9PT0gJ3ByaWNldHlwZS1jb250ZXh0JyA/ICfQotC40L8g0YbQtdC90Ysg0LjQt9C80LXQvdC40LvRgdGPLiDQntGC0LrRgNC+0LnRgtC1INC4INGB0L7RhdGA0LDQvdC40YLQtSDQvdCw0YHRgtGA0L7QudC60Lgg0L/QtdGA0LXQvtGG0LXQvdC60Lgg0LfQsNC90L7QstC+LidcbiAgICAgICAgICAgICAgICA6IE51bWJlci5pc0ludGVnZXIoc3RhdHVzKSA/ICfQnNC+0LnQodC60LvQsNC0OiBIVFRQICcgKyBzdGF0dXMgKyAnLiDQn9GA0L7QstC10YDRjNGC0LUg0LTQvtGB0YLRg9C/INC4INC/0LvQsNC9LidcbiAgICAgICAgICAgICAgICA6IGVudGVyZWRTZXJ2aWNlID8gJ9Cf0LvQsNC9INGD0YHRgtCw0YDQtdC7INC40LvQuCDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0uINCX0LDQs9GA0YPQt9C40YLQtSDQvdC+0LLRi9C5INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgC4nXG4gICAgICAgICAgICAgICAgICAgIDogJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0L/RgNC+0LLQtdGA0LjRgtGMINC30LDQutCw0LcsIEJlYXJlciDQuNC70Lgg0LbRg9GA0L3QsNC7INC/0LXRgNC10L7RhtC10L3QutC4LicsIHVucmVzb2x2ZWQgfHwgZW50ZXJlZFNlcnZpY2UpLFxuICAgICAgICAgICAgLi4uKHVucmVzb2x2ZWQgfHwgcGFydGlhbCA/IHsgdmVyaWZpZWQ6IHNhdmVkPy5qb3VybmFsPy52ZXJpZmllZCB8fCAwIH0gOiB7fSkgfTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICByZXByaWNlUGVuZGluZy5kZWxldGUob3duZXIpO1xuICAgICAgICBpZiAoY2hhbmdlc1N0YXRlKSByZXByaWNlQnVzeSA9IGZhbHNlO1xuICAgIH1cbn1cbiIsIid1c2Ugc3RyaWN0JztcblxuLy8gVGhlIHBhbmVsIGlzIGEgdmVyaWZpZWQgU0lERV9QQU5FTCBkb2N1bWVudDsgaXQgaGFzIG5vIHRhYiBhbmQgbm8gc3ViZnJhbWUuXG5mdW5jdGlvbiBkZWJ1Z1BhbmVsU2VuZGVyKHNlbmRlcikge1xuICAgIHJldHVybiBzZW5kZXI/LmlkID09PSBjaHJvbWUucnVudGltZS5pZCAmJiAhc2VuZGVyLnRhYlxuICAgICAgICAmJiAoc2VuZGVyLmZyYW1lSWQgPT09IHVuZGVmaW5lZCB8fCBzZW5kZXIuZnJhbWVJZCA9PT0gMClcbiAgICAgICAgJiYgbmF0aXZlRG9jdW1lbnRVcmwoc2VuZGVyLnVybCwgJ3BhbmVsJywgJ3NpZGViYXInKTtcbn1cbmZ1bmN0aW9uIGRlYnVnV29ybGRGb3Ioc2VuZGVyLCBwYW5lbCkge1xuICAgIGlmIChwYW5lbCkgcmV0dXJuICdwYW5lbCc7XG4gICAgaWYgKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHJldHVybiAnY29udGVudCc7XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHJldHVybiAncnVudGltZSc7XG4gICAgcmV0dXJuICd3b3JrZXInO1xufVxuYXN5bmMgZnVuY3Rpb24gZGVidWdNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgcGFuZWwpIHtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpkZWJ1Zy1mbGFnJykge1xuICAgICAgICBpZiAodHlwZW9mIG1lc3NhZ2UuZW5hYmxlZCAhPT0gJ2Jvb2xlYW4nKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC20YPRgNC90LDQuyDRgNCw0YHRiNC40YDQtdC90LjRjycgfTtcbiAgICAgICAgLy8gbWVtY2hhdERlYnVnU2V0RW5hYmxlZCByZXR1cm5zIHdoZXRoZXIgdGhlIHdyaXRlIHZlcmlmaWVkLCBub3QgdGhlIHZhbHVlLlxuICAgICAgICAvLyBSZWFkIHRoZSBwZXJzaXN0ZWQgZmxhZyBiYWNrIHNvIHR1cm5pbmcgdGhlIGxvZyBPRkYgaXMgYWxzbyBjb25maXJtZWQuXG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgbWVtY2hhdERlYnVnU2V0RW5hYmxlZChtZXNzYWdlLmVuYWJsZWQpO1xuICAgICAgICBjb25zdCBlbmFibGVkID0gYXdhaXQgbWVtY2hhdERlYnVnRW5hYmxlZCgpO1xuICAgICAgICByZXR1cm4gdmVyaWZpZWQgJiYgZW5hYmxlZCA9PT0gbWVzc2FnZS5lbmFibGVkXG4gICAgICAgICAgICA/IHsgb2s6IHRydWUsIGVuYWJsZWQgfVxuICAgICAgICAgICAgOiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQpNC70LDQsyDQttGD0YDQvdCw0LvQsCDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0nIH07XG4gICAgfVxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OmRlYnVnLXJlYWQnKSB7XG4gICAgICAgIGlmIChtZXNzYWdlLmxpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UubGltaXQpIHx8IG1lc3NhZ2UubGltaXQgPCAxXG4gICAgICAgICAgICB8fCBtZXNzYWdlLmxpbWl0ID4gTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC20YPRgNC90LDQuyDRgNCw0YHRiNC40YDQtdC90LjRjycgfTtcbiAgICAgICAgcmV0dXJuIG1lbWNoYXREZWJ1Z1JlYWQoeyBsaW1pdDogbWVzc2FnZS5saW1pdCB9KTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6ZGVidWctY2xlYXInKSByZXR1cm4gbWVtY2hhdERlYnVnQ2xlYXIoKTtcbiAgICAvLyBUaGUgd29ybGQgaXMgZGVyaXZlZCBmcm9tIHRoZSBhdXRoZW50aWNhdGVkIHNlbmRlciwgbmV2ZXIgdHJ1c3RlZCBmcm9tIHRoZVxuICAgIC8vIHBheWxvYWQ6IGEgY29udGVudCB3b3JsZCBjYW5ub3QgY2xhaW0gdG8gYmUgdGhlIHBhbmVsIG9yIHRoZSB3b3JrZXIuXG4gICAgaWYgKCFNRU1DSEFUX0RFQlVHX0xFVkVMUy5pbmNsdWRlcyhtZXNzYWdlLmxldmVsKVxuICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5zY29wZSAhPT0gJ3N0cmluZycgfHwgIS9eW2EtejAtOTotXXsxLDY0fSQvLnRlc3QobWVzc2FnZS5zY29wZSlcbiAgICAgICAgfHwgdHlwZW9mIG1lc3NhZ2UuZXZlbnQgIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2UuZXZlbnQubGVuZ3RoIDwgMSB8fCBtZXNzYWdlLmV2ZW50Lmxlbmd0aCA+IDIwMFxuICAgICAgICB8fCAobWVzc2FnZS53b3JsZCAhPT0gdW5kZWZpbmVkICYmICFNRU1DSEFUX0RFQlVHX1dPUkxEUy5pbmNsdWRlcyhtZXNzYWdlLndvcmxkKSkpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQttGD0YDQvdCw0Lsg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH07XG4gICAgfVxuICAgIGF3YWl0IG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiBtZXNzYWdlLmxldmVsLCBzY29wZTogbWVzc2FnZS5zY29wZSwgZXZlbnQ6IG1lc3NhZ2UuZXZlbnQsIGRldGFpbDogbWVzc2FnZS5kZXRhaWwgfSxcbiAgICAgICAgZGVidWdXb3JsZEZvcihzZW5kZXIsIHBhbmVsKSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gZXh0ZW5zaW9uSGFuZGxlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkge1xuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAnbWVtY2hhdDpjaGF0LWV2ZW50JykgcmV0dXJuIHNpZGViYXJIaXN0b3J5TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSk7XG4gICAgaWYgKFsnbWVtY2hhdDpyZXByaWNlJywgJ21lbWNoYXQ6c2FsZXMtc2V0dGluZ3MtZ2V0JywgJ21lbWNoYXQ6c2FsZXMtc2V0dGluZ3Mtc2F2ZSddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkpIHtcbiAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0L/QtdGA0LXQvtGG0LXQvdC60Lgg0L7RgtC60LvQvtC90ZHQvS4nIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG9wZXJhdGlvbiA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6cmVwcmljZScgPyByZXByaWNlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIDogc2FsZXNTZXR0aW5nc01lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKTtcbiAgICAgICAgb3BlcmF0aW9uLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cf0LXRgNC10L7RhtC10L3QutCwINC90LXQtNC+0YHRgtGD0L/QvdCwLicsIHJlY292ZXJ5OiB0cnVlIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChbJ21lbWNoYXQ6ZGVidWctbG9nJywgJ21lbWNoYXQ6ZGVidWctcmVhZCcsICdtZW1jaGF0OmRlYnVnLWNsZWFyJywgJ21lbWNoYXQ6ZGVidWctZmxhZyddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHBhbmVsID0gZGVidWdQYW5lbFNlbmRlcihzZW5kZXIpO1xuICAgICAgICAvLyBUaGUgdmVyYm9zZS1sb2cgc3dpdGNoIGxpdmVzIGluIHRoZSBzZXR0aW5ncyB3aW5kb3csIHdoaWNoIGlzIHJlbmRlcmVkIGJ5XG4gICAgICAgIC8vIG91ciBvd24gY29udGVudCBzY3JpcHQgKG9yIHRoZSBuYXRpdmUgcnVudGltZSksIG5vdCBieSB0aGUgcGFuZWwgZG9jdW1lbnQuXG4gICAgICAgIC8vIEEgcGFnZSBjYW5ub3QgZm9yZ2UgYW55IG9mIHRoZXNlIHNlbmRlcnM6IHNlbmRlci5pZCBtdXN0IGJlIG91ciBleHRlbnNpb24uXG4gICAgICAgIGNvbnN0IHRydXN0ZWQgPSBwYW5lbCB8fCB0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcik7XG4gICAgICAgIGlmICghdHJ1c3RlZCkge1xuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBkZWJ1Z01lc3NhZ2UobWVzc2FnZSwgc2VuZGVyLCBwYW5lbCkudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JbRg9GA0L3QsNC7INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9JyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0Om5hdGl2ZS1kcmFmdC1yZWFkJywgJ21lbWNoYXQ6bmF0aXZlLWRyYWZ0LXdyaXRlJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCF0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBuYXRpdmVEcmFmdE1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cn0LXRgNC90L7QstC40Log0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTRkdC9LiDQndC1INC30LDQutGA0YvQstCw0LnRgtC1INC/0LDQvdC10LvRjC4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtdGVzdC1zb3VuZCcpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgb3JkZXJQbGF5QXVkaW8oKS50aGVuKCgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQstGD0Log0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C10L0nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChbJ21lbWNoYXQ6c3RvcmFnZS1pbml0JywgJ21lbWNoYXQ6c3RvcmFnZS13cml0ZScsICdtZW1jaGF0OnN0b3JhZ2UtcmVzdG9yZScsICdtZW1jaGF0OnN0b3JhZ2UtcHJ1bmUnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBpZiAoISh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YXRgNCw0L3QuNC70LjRidCwINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgcHJpdmF0ZVN0b3JhZ2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JTQsNC90L3Ri9C1INC90LUg0L/QvtC00YLQstC10YDQttC00LXQvdGLINGF0YDQsNC90LjQu9C40YnQtdC8LiDQndC1INC30LDQutGA0YvQstCw0LnRgtC1INC4INC90LUg0L/QtdGA0LXQt9Cw0LPRgNGD0LbQsNC50YLQtSDQstC60LvQsNC00LrRgy4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChbJ21lbWNoYXQ6b3JkZXJzLWNvbmZpZ3VyZScsICdtZW1jaGF0Om9yZGVycy1wb2xsJywgJ21lbWNoYXQ6b3JkZXJzLXN0b3AnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBpZiAoISh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBjb25zdCB3b3JrID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgb3JkZXJSZWFkeTtcbiAgICAgICAgICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpICYmIG1lc3NhZ2UudHlwZSAhPT0gJ21lbWNoYXQ6b3JkZXJzLXN0b3AnXG4gICAgICAgICAgICAgICAgJiYgIWF3YWl0IHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQoc2VuZGVyLCAnQmVhcmVyICcgKyBtZXNzYWdlLnRva2VuKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cj0YfRkdGC0L3Ri9C1INC00LDQvdC90YvQtSDQuNC30LzQtdC90LXQvdGLLiDQn9C+0LTRgtCy0LXRgNC00LjRgtC1INC60LvRjtGHLicgfTtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JkZXJNdXRhdGUoKCkgPT4gY29uZmlndXJlT3JkZXJzKG1lc3NhZ2UsIHNlbmRlcikpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5hdGl2ZSA9IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmdldChzZW5kZXIpO1xuICAgICAgICAgICAgICAgIGlmIChuYXRpdmUgJiYgcmVzdWx0Lm9rKSB7IG5hdGl2ZS5vcmRlclRva2VuID0gbWVzc2FnZS50b2tlbjsgbmF0aXZlLm9yZGVyUmV2aXNpb24gPSByZXN1bHQucmV2aXNpb247IH1cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLXN0b3AnKSByZXR1cm4gb3JkZXJNdXRhdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghb3JkZXJDb25maWcgfHwgbWVzc2FnZS50b2tlbiAhPT0gb3JkZXJDb25maWcudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdCZWFyZXIg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0YTQvtC90L7QstGL0Lwg0L7Qv9GA0L7RgdC+0LwnIH07XG4gICAgICAgICAgICAgICAgb3JkZXJDb250cm9sbGVyPy5hYm9ydCgpO1xuICAgICAgICAgICAgICAgIG9yZGVyQ29uZmlnLnNldHRpbmdzLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnOiBvcmRlckNvbmZpZywgcmV2aXNpb246ICsrb3JkZXJSZXZpc2lvbiwgc3Vic2NyaWJlcnM6IFsuLi5vcmRlclN1YnNjcmliZXJzXSB9IH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gb3JkZXJQdWJsaWNDb25maWcoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYXdhaXQgb3JkZXJDb25maWdDaGFpbjtcbiAgICAgICAgICAgIGlmICghb3JkZXJDb25maWcgfHwgbWVzc2FnZS50b2tlbiAhPT0gb3JkZXJDb25maWcudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdCZWFyZXIg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0YTQvtC90L7QstGL0Lwg0L7Qv9GA0L7RgdC+0LwnIH07XG4gICAgICAgICAgICByZXR1cm4gcG9sbE9yZGVycygpO1xuICAgICAgICB9O1xuICAgICAgICB3b3JrKCkudGhlbihzZW5kUmVzcG9uc2UsICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC1INGD0LTQsNC70L7RgdGMINC90LDRgdGC0YDQvtC40YLRjCDRhNC+0L3QvtCy0YvQuSDQvtC/0YDQvtGBJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6cGFuZWwtY3NyZicpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSB8fCAobWVzc2FnZS5mb3JjZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBtZXNzYWdlLmZvcmNlICE9PSAnYm9vbGVhbicpKSB7XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGdldFBhbmVsU2Vzc2lvbihtZXNzYWdlLmZvcmNlID09PSB0cnVlKS50aGVuKHNlbmRSZXNwb25zZSxcbiAgICAgICAgICAgICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICdQYW5lbDog0YTQvtC90L7QstCw0Y8g0YHQtdGB0YHQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwLicgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKCFbJ21lbWNoYXQ6aHR0cCcsICdtZW1jaGF0OmFib3J0J10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoISh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHx8IHR5cGVvZiBtZXNzYWdlLmlkICE9PSAnc3RyaW5nJyB8fCAhL15bYS16QS1aMC05LV17MSw4MH0kLy50ZXN0KG1lc3NhZ2UuaWQpKSB7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDphYm9ydCcpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSBwZW5kaW5nUmVxdWVzdHMuZ2V0KHJlcXVlc3RLZXkoc2VuZGVyLCBtZXNzYWdlLmlkKSk7XG4gICAgICAgIGlmIChlbnRyeSkgeyBlbnRyeS5ldmVudCA9ICdhYm9ydCc7IGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTsgfVxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBwZXJmb3JtUmVxdWVzdChtZXNzYWdlLCBzZW5kZXIpLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdC5ldmVudCA9PT0gJ2xvYWQnICYmIFs0MDEsIDQwMywgNDE5XS5pbmNsdWRlcyhyZXN1bHQucmVzcG9uc2U/LnN0YXR1cylcbiAgICAgICAgICAgICYmIG5ldyBVUkwobWVzc2FnZS5yZXF1ZXN0LnVybCkub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnKSB7XG4gICAgICAgICAgICBjb25zdCBzZW50VG9rZW4gPSBuZXcgSGVhZGVycyhtZXNzYWdlLnJlcXVlc3QuaGVhZGVycyB8fCB7fSkuZ2V0KCd4LWNzcmYtdG9rZW4nKTtcbiAgICAgICAgICAgIGlmIChzZW50VG9rZW4gJiYgc2VudFRva2VuID09PSBwYW5lbFNlc3Npb24/LnRva2VuKSB7XG4gICAgICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgICAgICAgICByZXN1bHQucGFuZWxBdXRoTG9zdCA9IHRydWU7XG4gICAgICAgICAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ2F1dGgtbG9zdCcsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyBzdGF0dXM6IHJlc3VsdC5yZXNwb25zZT8uc3RhdHVzIH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHNlbmRSZXNwb25zZShyZXN1bHQpO1xuICAgIH0sICgpID0+IHNlbmRSZXNwb25zZSh7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQt9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn1cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihleHRlbnNpb25IYW5kbGVNZXNzYWdlKTtcblxuLy8gUmVnaXN0ZXIgdG9vbGJhci9jb250ZXh0LW1lbnUgbGlzdGVuZXJzIHN5bmNocm9ub3VzbHkgb24gZXZlcnkgd29ya2VyIHdha2UuXG5pbXBvcnRTY3JpcHRzKCdjb250cm9scy5qcycpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BTQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbHpCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4VEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSJ9
