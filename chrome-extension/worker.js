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
            ...(message.event === 'click' && message.trustedGesture === true ? { trustedGesture: true } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL2RlYnVnLWxvZy5qcyIsImV4dGVuc2lvbi93b3JrZXIvbmV0d29yay5qcyIsImV4dGVuc2lvbi93b3JrZXIvcGFuZWwtc2Vzc2lvbi5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXItYWxlcnRzLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci9vcmRlcnMuanMiLCJleHRlbnNpb24vbmF0aXZlLXJ1bnRpbWUtd29ya2VyLmpzIiwiZXh0ZW5zaW9uL2hpc3Rvcnktd29ya2VyLmpzIiwiZXh0ZW5zaW9uL3NpZGViYXItd29ya2VyLmpzIiwic3JjL2ZlYXR1cmVzL3JlcHJpY2Uvc2VydmljZS5qcyIsImV4dGVuc2lvbi93b3JrZXIvcmVwcmljZS5qcyIsImV4dGVuc2lvbi93b3JrZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBQcml2YXRlIHN0b3JhZ2UgaXMgb3JpZ2luLXNjb3BlZCB0byBwcmVzZXJ2ZSBleGlzdGluZyBzaXRlL2FjY291bnQgc2VwYXJhdGlvbi5cbi8vIENocm9tZSBvd25zIHBlcnNpc3RlbmNlOyBwYWdlIGxvY2FsU3RvcmFnZSBpcyB1c2VkIG9ubHkgZm9yIG9uZS10aW1lIG1pZ3JhdGlvbi5cbmNvbnN0IHByaXZhdGVTdG9yYWdlUmVhZHkgPSAoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldEFjY2Vzc0xldmVsKHsgYWNjZXNzTGV2ZWw6ICdUUlVTVEVEX0NPTlRFWFRTJyB9KTtcbn0pKCk7XG4vLyBIYW5kbGUgaW5pdGlhbGl6YXRpb24gcmVqZWN0aW9uIGltbWVkaWF0ZWx5LCB3aGlsZSByZXRhaW5pbmcgZmFpbC1jbG9zZWQgYXdhaXRzLlxucHJpdmF0ZVN0b3JhZ2VSZWFkeS5jYXRjaCgoKSA9PiB7fSk7XG5sZXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycyA9IG5ldyBNYXAoKTtcbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtidWNrZXQudmVyc2lvbiwgT2JqZWN0LmtleXMoYnVja2V0Lml0ZW1zKS5zb3J0KCkubWFwKGtleSA9PlxuICAgICAgICBba2V5LCBidWNrZXQuaXRlbXNba2V5XS5yZXZpc2lvbiwgYnVja2V0Lml0ZW1zW2tleV0udmFsdWVdKSxcbiAgICBPYmplY3Qua2V5cyhidWNrZXQubGVnYWN5QmFja3VwIHx8IHt9KS5zb3J0KCkubWFwKGtleSA9PiBba2V5LCBidWNrZXQubGVnYWN5QmFja3VwW2tleV1dKSxcbiAgICAoYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBbZW50cnkuaWQsIGVudHJ5LmtleSwgZW50cnkudmFsdWUsIGVudHJ5LmRvY3VtZW50LCBlbnRyeS5yZXZpc2lvbl0pLFxuICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fCBbXV0pO1xufVxuLy8gUHJpdmF0ZSB2YXJpYW50cyBhcHBlbmQgbm9ybWFsbHk7IG9ubHkgZXhwbGljaXQgY29uZmlybWVkIHBydW5lIGRlbGV0ZXMgb25lLlxuLy8gTm8gYXV0b21hdGljIGV2aWN0aW9uOiBleGhhdXN0aW9uIGZhaWxzIGNsb3NlZCxcbi8vIGFuZCBjb250ZW50IG11c3QgZXhwbGljaXRseSB3YXJuIHRoYXQgdGhlIG5ld2VzdCBlZGl0IGlzIE5PVCB5ZXQgZHVyYWJsZS5cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCkge1xuICAgIGJ1Y2tldC5yZWNvdmVyaWVzIHx8PSBbXTtcbiAgICBjb25zdCBleGlzdGluZyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbmQoZW50cnkgPT4gZW50cnkua2V5ID09PSBrZXkgJiYgZW50cnkudmFsdWUgPT09IHZhbHVlXG4gICAgICAgICYmIGVudHJ5LmRvY3VtZW50ID09PSBkb2N1bWVudCAmJiBlbnRyeS5yZXZpc2lvbiA9PT0gcmV2aXNpb24pO1xuICAgIGlmIChleGlzdGluZykgcmV0dXJuO1xuICAgIGlmIChidWNrZXQucmVjb3Zlcmllcy5sZW5ndGggPj0gMTI4KSB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ2NhcGFjaXR5JywgZGV0YWlsOiB7IGtleSB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1JlY292ZXJ5IGNhcGFjaXR5IGV4aGF1c3RlZCcpO1xuICAgIH1cbiAgICBjb25zdCBpZCA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLmJ1Y2tldC5yZWNvdmVyaWVzLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpICsgMTtcbiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGlkKSkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjYXBhY2l0eScsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHRocm93IEVycm9yKCdSZWNvdmVyeSBJRCBleGhhdXN0ZWQnKTtcbiAgICB9XG4gICAgYnVja2V0LnJlY292ZXJ5U2VxdWVuY2UgPSBpZDtcbiAgICBidWNrZXQucmVjb3Zlcmllcy5wdXNoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCB9KTtcbiAgICBpZiAoSlNPTi5zdHJpbmdpZnkoYnVja2V0LnJlY292ZXJpZXMpLmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjYXBhY2l0eScsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgIHRocm93IEVycm9yKCdSZWNvdmVyeSBjYXBhY2l0eSBleGhhdXN0ZWQnKTtcbiAgICB9XG59XG5mdW5jdGlvbiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIHtcbiAgICAvLyBOZXZlciBzZW5kIHJlY292ZXJ5IHZhbHVlcyAoZXNwZWNpYWxseSBjcmVkZW50aWFscy9oaXN0b3J5KSBpbnRvIGEgdmlldy5cbiAgICByZXR1cm4gKGJ1Y2tldC5yZWNvdmVyaWVzIHx8IFtdKS5tYXAoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uIH0pID0+ICh7IGlkLCBrZXksIGRlbGV0ZWQ6IHZhbHVlID09PSBudWxsLCByZXZpc2lvbiB9KSk7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpIHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGJ1Y2tldCB9KTtcbiAgICBjb25zdCBjb21taXR0ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICBpZiAoIWNvbW1pdHRlZCB8fCBwcml2YXRlU3RvcmFnZVNuYXBzaG90KGNvbW1pdHRlZCkgIT09IHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSkge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICd2ZXJpZmljYXRpb24nLCBkZXRhaWw6IHt9IH0sICd3b3JrZXInKTtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ1N0b3JhZ2UgdmVyaWZpY2F0aW9uIGZhaWxlZCcpO1xuICAgIH1cbiAgICByZXR1cm4gY29tbWl0dGVkO1xufVxuYXN5bmMgZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGF1dGhvcml6YXRpb24pIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ2hhaW47XG4gICAgY29uc3Qga2V5ID0gJ21lbWNoYXRQcml2YXRlX3YxOicgKyBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgY29uc3QgYXBpID0gSlNPTi5wYXJzZShzYXZlZD8uaXRlbXNbJ21lbWNoYXQ6aGFja2VyTXNBcGlfdjEnXT8udmFsdWUgfHwgJ3t9Jyk7XG4gICAgcmV0dXJuIGFwaS5iZWFyZXJFbmFibGVkID09PSB0cnVlICYmIHR5cGVvZiBhcGkudG9rZW4gPT09ICdzdHJpbmcnICYmIGF1dGhvcml6YXRpb24gPT09ICdCZWFyZXIgJyArIGFwaS50b2tlbjtcbn1cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBvcGVyYXRpb24gPSBwcml2YXRlU3RvcmFnZUNoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgICAgIGNvbnN0IHN0b3JhZ2VLZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIG9yaWdpbjtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICAgICAgY29uc3QgYnVja2V0ID0gc2F2ZWQgfHwgeyB2ZXJzaW9uOiAxLCBpdGVtczoge30sIGxlZ2FjeUJhY2t1cDoge30gfTtcbiAgICAgICAgaWYgKGJ1Y2tldC52ZXJzaW9uICE9PSAxIHx8ICFidWNrZXQuaXRlbXMgfHwgdHlwZW9mIGJ1Y2tldC5pdGVtcyAhPT0gJ29iamVjdCcpIHRocm93IEVycm9yKCdJbnZhbGlkIHNjaGVtYScpO1xuICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLWluaXQnKSB7XG4gICAgICAgICAgICBjb25zdCBsZWdhY3kgPSBtZXNzYWdlLmxlZ2FjeTtcbiAgICAgICAgICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpICYmIE9iamVjdC5rZXlzKGxlZ2FjeSB8fCB7fSkubGVuZ3RoKSB0aHJvdyBFcnJvcignTmF0aXZlIHJ1bnRpbWUgY2Fubm90IG1pZ3JhdGUgcGFnZSBkYXRhJyk7XG4gICAgICAgICAgICBpZiAoIWxlZ2FjeSB8fCB0eXBlb2YgbGVnYWN5ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGxlZ2FjeSkpIHRocm93IEVycm9yKCdJbnZhbGlkIGxlZ2FjeSBzbmFwc2hvdCcpO1xuICAgICAgICAgICAgY29uc3QgY2xlYW51cCA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCBba2V5LCByYXddIG9mIE9iamVjdC5lbnRyaWVzKGxlZ2FjeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdmFsdWUnKTtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnY2xlYXJUZXh0RW5hYmxlZCcgJiYgWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMocmF3KSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIU9iamVjdC5oYXNPd24oYnVja2V0Lml0ZW1zLCAnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMobGVnYWN5WydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSkgPyBsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddIDogcmF3O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSA9IHsgdmFsdWUsIHJldmlzaW9uOiAxIH07XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXS52YWx1ZSAhPT0gcmF3KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAuY2xlYXJUZXh0RW5hYmxlZCA9IHJhdztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgeyBjbGVhbnVwLnB1c2goa2V5KTsgY29udGludWU7IH1cbiAgICAgICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgICAgIGlmICghc2F2ZWQpIGJ1Y2tldC5pdGVtc1trZXldID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICBlbHNlIGlmIChidWNrZXQuaXRlbXNba2V5XT8udmFsdWUgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEFuIG9sZGVyIHVzZXJzY3JpcHQgbWF5IHJlY3JlYXRlIG9sZCBrZXlzLiBQcmVzZXJ2ZSB0aGF0IGNvcHlcbiAgICAgICAgICAgICAgICAgICAgLy8gcHJpdmF0ZWx5LCBidXQgbmV2ZXIgcm9sbCBiYWNrIHRoZSBjYW5vbmljYWwgZXh0ZW5zaW9uIHN0YXRlLlxuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cFtrZXldID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNsZWFudXAucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQWNrbm93bGVkZ2Ugb25seSBhZnRlciBDaHJvbWUgY29tbWl0cyBhbmQgYSByZWFkLWJhY2sgdmVyaWZpZXMgaXQuXG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5zZXQoc2VuZGVyLnRhYj8uaWQgPz8gJ25hdGl2ZTonICsgc2VuZGVyLnVybCwgeyBvcmlnaW4sIGRvY3VtZW50SWQ6IHNlbmRlci5kb2N1bWVudElkLCBzZW5kZXIgfSk7XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaXRlbXM6IGNvbW1pdHRlZC5pdGVtcywgY2xlYW51cCwgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoY29tbWl0dGVkKSB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtcHJ1bmUnKSB7XG4gICAgICAgICAgICAvLyBFeHBsaWNpdCBpcnJldmVyc2libGUgZGVsZXRpb24gb2YgT05FIGltbXV0YWJsZSBJRCwgbmV2ZXIgYSBidWxrIGNsZWFyLlxuICAgICAgICAgICAgLy8gS2VlcCBpdHMgZG9jdW1lbnQgZmVuY2UgYWZ0ZXIgZGVsZXRpb24sIGFuZCBuZXZlciByZWN5Y2xlIElEcyAoc3RhbGUgVUkvYWNrIHJldHJpZXMpLlxuICAgICAgICAgICAgY29uc3Qgc2VxdWVuY2UgPSBNYXRoLm1heChidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSB8fCAwLCAuLi4oYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UuY29uZmlybWVkICE9PSB0cnVlIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmlkKSB8fCBtZXNzYWdlLmlkIDwgMSB8fCBtZXNzYWdlLmlkID4gc2VxdWVuY2UpIHRocm93IEVycm9yKCdJbnZhbGlkIHBydW5lJyk7XG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGJ1Y2tldC5yZWNvdmVyaWVzPy5maW5kKGl0ZW0gPT4gaXRlbS5pZCA9PT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSA9IHNlcXVlbmNlO1xuICAgICAgICAgICAgaWYgKGVudHJ5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5LmRvY3VtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fD0gW107XG4gICAgICAgICAgICAgICAgICAgIGlmICghYnVja2V0LnJlY292ZXJ5RmVuY2VzLnNvbWUoKFtrZXksIGRvY3VtZW50XSkgPT4ga2V5ID09PSBlbnRyeS5rZXkgJiYgZG9jdW1lbnQgPT09IGVudHJ5LmRvY3VtZW50KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LnJlY292ZXJ5RmVuY2VzLnB1c2goW2VudHJ5LmtleSwgZW50cnkuZG9jdW1lbnRdKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBidWNrZXQucmVjb3ZlcmllcyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbHRlcihpdGVtID0+IGl0ZW0uaWQgIT09IG1lc3NhZ2UuaWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgY29tbWl0dGVkID0gYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDb21taXQoc3RvcmFnZUtleSwgYnVja2V0KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChjb21taXR0ZWQpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFsnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJywgJ21lbWNoYXQ6c3RvcmFnZS1yZXN0b3JlJ10uaW5jbHVkZXMobWVzc2FnZS50eXBlKSkge1xuICAgICAgICAgICAgY29uc3QgcmVzdG9yaW5nID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnO1xuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcnkgPSByZXN0b3JpbmcgJiYgTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5pZClcbiAgICAgICAgICAgICAgICAmJiBidWNrZXQucmVjb3Zlcmllcz8uZmluZChlbnRyeSA9PiBlbnRyeS5pZCA9PT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmICFyZWNvdmVyeSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcmVjb3ZlcnknKTtcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlc3RvcmluZyA/IHJlY292ZXJ5LmtleSA6IG1lc3NhZ2Uua2V5LCByZXZpc2lvbiA9IG1lc3NhZ2UucmV2aXNpb247XG4gICAgICAgICAgICBjb25zdCByYXcgPSByZXN0b3JpbmcgPyByZWNvdmVyeS52YWx1ZSA6IG1lc3NhZ2UudmFsdWU7XG4gICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihyZXZpc2lvbikgfHwgcmV2aXNpb24gPCAwXG4gICAgICAgICAgICAgICAgfHwgcmV2aXNpb24gPj0gTnVtYmVyLk1BWF9TQUZFX0lOVEVHRVJcbiAgICAgICAgICAgICAgICB8fCAocmF3ICE9PSBudWxsICYmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHdyaXRlJyk7XG4gICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGJ1Y2tldC5pdGVtc1trZXldIHx8IHsgdmFsdWU6IG51bGwsIHJldmlzaW9uOiAwIH07XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IHJhdyA9PT0gbnVsbCA/IG51bGwgOiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgcmF3KTtcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gc2VuZGVyLmRvY3VtZW50SWQgfHwgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgPyAnbmF0aXZlOicgKyBzZW5kZXIudXJsIDogJ3RhYjonICsgc2VuZGVyLnRhYi5pZCk7XG4gICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSBkb2N1bWVudCBmZW5jZSB3aXRoIHRoZSBmaXJzdCBjb25mbGljdC4gQWxyZWFkeSBzZW50XG4gICAgICAgICAgICAvLyBvcHRpbWlzdGljIHdyaXRlcyBjYW5ub3QgYWNjaWRlbnRhbGx5IG92ZXJ3cml0ZSB0aGUgd2lubmVyIGxhdGVyLFxuICAgICAgICAgICAgLy8gaW5jbHVkaW5nIGFmdGVyIHdvcmtlciBzdXNwZW5zaW9uLiBSZWxvYWQgY3JlYXRlcyBhIG5ldyBkb2N1bWVudC5cbiAgICAgICAgICAgIGNvbnN0IGJsb2NrZWQgPSAhcmVzdG9yaW5nICYmIChidWNrZXQucmVjb3Zlcmllcz8uc29tZShlbnRyeSA9PiBlbnRyeS5rZXkgPT09IGtleSAmJiBlbnRyeS5kb2N1bWVudCA9PT0gZG9jdW1lbnQpXG4gICAgICAgICAgICAgICAgfHwgYnVja2V0LnJlY292ZXJ5RmVuY2VzPy5zb21lKChbZmVuY2VkS2V5LCBmZW5jZWREb2N1bWVudF0pID0+IGZlbmNlZEtleSA9PT0ga2V5ICYmIGZlbmNlZERvY3VtZW50ID09PSBkb2N1bWVudCkpO1xuICAgICAgICAgICAgLy8gQSBjb25jdXJyZW50IHdyaXRlciBtYXkgaGF2ZSBjb21taXR0ZWQgdGhlIGlkZW50aWNhbCBkZXNpcmVkIHZhbHVlLlxuICAgICAgICAgICAgLy8gT25seSBhY2NlcHQgdGhlIGltbWVkaWF0ZWx5IHByZWNlZGluZyByZXZpc2lvbiBzbyBvcHRpbWlzdGljIHF1ZXVlZFxuICAgICAgICAgICAgLy8gd3JpdGVzIGNvbnRpbnVlIGZyb20gdGhlIHJldmlzaW9uIHRoZSBjb250ZW50IGFkYXB0ZXIgcHJlZGljdGVkLlxuICAgICAgICAgICAgaWYgKCFibG9ja2VkICYmICFyZXN0b3JpbmcgJiYgcHJldmlvdXMucmV2aXNpb24gPT09IHJldmlzaW9uICsgMSAmJiBwcmV2aW91cy52YWx1ZSA9PT0gdmFsdWUpIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtOiBwcmV2aW91cyB9O1xuICAgICAgICAgICAgaWYgKGJsb2NrZWQgfHwgcHJldmlvdXMucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IG1lc3NhZ2UucHJldmlvdXNWYWx1ZSAhPT0gcHJldmlvdXMudmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3RvcmluZykge1xuICAgICAgICAgICAgICAgICAgICBwcml2YXRlU3RvcmFnZVJlY292ZXIoYnVja2V0LCBrZXksIHZhbHVlLCByZXZpc2lvbiwgZG9jdW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzdG9yYWdlJywgZXZlbnQ6ICdjb25mbGljdCcsIGRldGFpbDogeyBrZXkgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgcmVjb3ZlcmVkOiB0cnVlLCBrZXksIGl0ZW06IHByZXZpb3VzLFxuICAgICAgICAgICAgICAgICAgICByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmIHByZXZpb3VzLnZhbHVlICE9PSB2YWx1ZSkgcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCBwcmV2aW91cy52YWx1ZSwgcHJldmlvdXMucmV2aXNpb24sIG51bGwpO1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHsgdmFsdWUsIHJldmlzaW9uOiByZXZpc2lvbiArIDEgfTtcbiAgICAgICAgICAgIGJ1Y2tldC5pdGVtc1trZXldID0gaXRlbTtcbiAgICAgICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICAvLyBCZXN0LWVmZm9ydCBwcml2YXRlIGludmFsaWRhdGlvbjsgY2xvc2VkL3JlcGxhY2VkIGRvY3VtZW50cyBhcmUgaWdub3JlZC5cbiAgICAgICAgICAgIGZvciAoY29uc3QgW3RhYklkLCBzdWJzY3JpYmVyXSBvZiBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRhYklkID09PSAoc2VuZGVyLnRhYj8uaWQgPz8gJ25hdGl2ZTonICsgc2VuZGVyLnVybCkgfHwgc3Vic2NyaWJlci5vcmlnaW4gIT09IG9yaWdpbikgY29udGludWU7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB0YWJJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHsgbmF0aXZlUnVudGltZU5vdGlmeShzdWJzY3JpYmVyLnNlbmRlciwgeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnLCBrZXksIGl0ZW0gfSk7IH1cbiAgICAgICAgICAgICAgICAgICAgY2F0Y2ggeyBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSh0YWJJZCk7IH1cbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBzdWJzY3JpYmVyLmRvY3VtZW50SWQgPyB7IGRvY3VtZW50SWQ6IHN1YnNjcmliZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiAwIH07XG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1jaGFuZ2VkJywga2V5LCBpdGVtIH0sIG9wdGlvbnMpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZ2V0KHRhYklkKSA9PT0gc3Vic2NyaWJlcikgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUodGFiSWQpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGtleSwgaXRlbSwgLi4uKHJlc3RvcmluZyA/IHsgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoYnVja2V0KSB9IDoge30pIH07XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgRXJyb3IoJ0ludmFsaWQgb3BlcmF0aW9uJyk7XG4gICAgfSk7XG4gICAgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gICAgLy8gQW55IHJlamVjdGVkIHdyaXRlIGlzIHJlZnVzZWQgYmVmb3JlIGl0IGJlY29tZXMgZHVyYWJsZTsga2VlcCB0aGUga2V5IG9ubHksXG4gICAgLy8gbmV2ZXIgdGhlIHZhbHVlIG9yIHRoZSBlcnJvciB0ZXh0LlxuICAgIG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7XG4gICAgICAgIG1lbWNoYXREZWJ1Z1JlY29yZCh7IGxldmVsOiAnZXJyb3InLCBzY29wZTogJ3N0b3JhZ2UnLCBldmVudDogJ3JlamVjdGVkJyxcbiAgICAgICAgICAgIGRldGFpbDogeyBrZXk6IHR5cGVvZiBtZXNzYWdlLmtleSA9PT0gJ3N0cmluZycgPyBtZXNzYWdlLmtleS5zbGljZSgwLCAxMjgpIDogbnVsbCB9IH0sICd3b3JrZXInKTtcbiAgICB9KTtcbiAgICByZXR1cm4gb3BlcmF0aW9uO1xufVxuIiwiLy8gRXh0ZW5zaW9uLXdpZGUgcmluZyBidWZmZXIgc2hhcmVkIGJ5IHRoZSB3b3JrZXIsIHRoZSBuYXRpdmUgcGFuZWwgYW5kIHRoZVxuLy8gY29udGVudCB3b3JsZC4gSXQgbGl2ZXMgaW4gY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbiBzbyB3b3JrZXIgc3VzcGVuc2lvbiBkb2VzXG4vLyBub3QgbG9zZSB0aGUgdHJhaWwgd2hpbGUgdGhlIGJyb3dzZXIgc3RheXMgb3Blbi4gTmV2ZXIgcHJlZmVyIGxvY2FsIHN0b3JhZ2U6XG4vLyB0aGUgbG9nIGlzIGRpYWdub3N0aWMgZGF0YSwgbm90IGR1cmFibGUgc3RhdGUsIGFuZCBtYXkgYmUgZXhwb3J0ZWQgYnkgYSB1c2VyLlxuY29uc3QgTUVNQ0hBVF9ERUJVR19MT0dfS0VZID0gJ21lbWNoYXREZWJ1Z0xvZ192MSc7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZID0gJ21lbWNoYXREZWJ1Z0VuYWJsZWRfdjEnO1xuY29uc3QgTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQgPSA1MDA7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xPR19NQVhfQUdFX01TID0gNyAqIDI0ICogNjAgKiA2MCAqIDEwMDA7XG5jb25zdCBNRU1DSEFUX0RFQlVHX0xFVkVMUyA9IE9iamVjdC5mcmVlemUoWydkZWJ1ZycsICdpbmZvJywgJ3dhcm4nLCAnZXJyb3InXSk7XG5jb25zdCBNRU1DSEFUX0RFQlVHX1dPUkxEUyA9IE9iamVjdC5mcmVlemUoWydwYW5lbCcsICdjb250ZW50JywgJ3J1bnRpbWUnLCAnd29ya2VyJ10pO1xuY29uc3QgTUVNQ0hBVF9ERUJVR19TRUNSRVRfS0VZID0gL3Rva2VufHBhc3N3b3JkfGF1dGhvcml6YXRpb258Y29va2llfHNlY3JldHxjcmVkZW50aWFsfGNzcmZ8YXBpa2V5fGFwaV9rZXl8c2Vzc2lvbnxiZWFyZXJ8c2lnbmF0dXJlfHByaXZhdGUvaTtcbi8vIFF1ZXJ5IHN0cmluZ3MgY2FycnkgYmVhcmVyLWxpa2UgdmFsdWVzICg/dG9rZW49LCA/YWNjZXNzX3Rva2VuPSwgc2lnbmVkIFVSTHMpXG4vLyBhbmQgdGhlIHBhdGggY2FuIGVtYmVkIGEgc2Vzc2lvbiBpZDsga2VlcCBvbmx5IG9yaWdpbitwYXRobmFtZSBmb3IgZGlhZ25vc3RpY3MuXG5mdW5jdGlvbiBtZW1jaGF0RGVidWdTYWZlVXJsKHJhdykge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoU3RyaW5nKHJhdykpO1xuICAgICAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyAmJiB1cmwucHJvdG9jb2wgIT09ICdodHRwOicpIHJldHVybiAnW1VSTF0nO1xuICAgICAgICByZXR1cm4gdXJsLm9yaWdpbiArIHVybC5wYXRobmFtZTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuICdbVVJMXSc7IH1cbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnU2FuaXRpemUodmFsdWUsIGtleSA9ICcnLCBkZXB0aCA9IDApIHtcbiAgICBpZiAoTUVNQ0hBVF9ERUJVR19TRUNSRVRfS0VZLnRlc3Qoa2V5KSkgcmV0dXJuICdbUkVEQUNURURdJztcbiAgICBpZiAodmFsdWUgPT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJyB8fCB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSByZXR1cm4gdmFsdWU7XG4gICAgaWYgKGRlcHRoID49IDUpIHJldHVybiAnW01BWF9ERVBUSF0nO1xuICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4ge1xuICAgICAgICBuYW1lOiB2YWx1ZS5uYW1lLFxuICAgICAgICBtZXNzYWdlOiBtZW1jaGF0RGVidWdTYW5pdGl6ZShTdHJpbmcodmFsdWUubWVzc2FnZSB8fCAnJyksICdtZXNzYWdlJywgZGVwdGggKyAxKSxcbiAgICAgICAgc3RhY2s6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKFN0cmluZyh2YWx1ZS5zdGFjayB8fCAnJyksICdzdGFjaycsIGRlcHRoICsgMSlcbiAgICB9O1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJldHVybiB2YWx1ZVxuICAgICAgICAgICAgLnJlcGxhY2UoL0JlYXJlclxccytbXlxcc1wiJ10rL2dpLCAnQmVhcmVyIFtSRURBQ1RFRF0nKVxuICAgICAgICAgICAgLnJlcGxhY2UoL1xcYig/OmV5SltcXHctXXsxMCx9XFwuW1xcdy1dezEwLH1cXC5bXFx3LV17NSx9KVxcYi9nLCAnW0pXVF0nKVxuICAgICAgICAgICAgLnJlcGxhY2UoL1xcYlswLTlhLWZdezMyLH1cXGIvZ2ksICdbSEVYXScpXG4gICAgICAgICAgICAucmVwbGFjZSgvKD88IVtcXGQrXSkoPzpcXCs/N3w4KVtcXHMoKS4tXSpcXGR7M31bXFxzKCkuLV0qXFxkezN9W1xccygpLi1dKlxcZHsyfVtcXHMoKS4tXSpcXGR7Mn1cXGIvZywgJ1tQSE9ORV0nKVxuICAgICAgICAgICAgLnNsaWNlKDAsIDMwMDApO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiB2YWx1ZS5zbGljZSgwLCA0MCkubWFwKGl0ZW0gPT4gbWVtY2hhdERlYnVnU2FuaXRpemUoaXRlbSwga2V5LCBkZXB0aCArIDEpKTtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXModmFsdWUpLnNsaWNlKDAsIDUwKS5mb3JFYWNoKGNoaWxkS2V5ID0+IHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2NoaWxkS2V5XSA9IC9eKHVybHxocmVmfG9yaWdpbnxyZWZlcnJlcikkL2kudGVzdChjaGlsZEtleSkgJiYgdHlwZW9mIHZhbHVlW2NoaWxkS2V5XSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAgICAgPyBtZW1jaGF0RGVidWdTYWZlVXJsKHZhbHVlW2NoaWxkS2V5XSlcbiAgICAgICAgICAgICAgICAgICAgOiBtZW1jaGF0RGVidWdTYW5pdGl6ZSh2YWx1ZVtjaGlsZEtleV0sIGNoaWxkS2V5LCBkZXB0aCArIDEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY2F0Y2ggeyByZXN1bHRbY2hpbGRLZXldID0gJ1tVTlJFQURBQkxFXSc7IH1cbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuICAgIHJldHVybiBTdHJpbmcodmFsdWUpLnNsaWNlKDAsIDMwMDApO1xufVxuXG4vLyBJbi1tZW1vcnkgbWlycm9yIG9mIHRoZSBzZXNzaW9uIGJ1ZmZlci4gQWxsIG11dGF0aW9ucyBzaGFyZSBvbmUgcHJvbWlzZSBjaGFpblxuLy8gc28gYSBidXJzdCBvZiByZWNvcmRzIGNhbm5vdCBpbnRlcmxlYXZlIGEgcmVhZC1tb2RpZnktd3JpdGUgYW5kIGxvc2UgZW50cmllcy5cbmxldCBtZW1jaGF0RGVidWdFbnRyaWVzID0gW107XG5sZXQgbWVtY2hhdERlYnVnTG9hZGVkID0gZmFsc2U7XG5sZXQgbWVtY2hhdERlYnVnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmxldCBtZW1jaGF0RGVidWdTZXF1ZW5jZSA9IDA7XG5cbmZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0ZyZXNoKGVudHJpZXMpIHtcbiAgICBjb25zdCBjdXRvZmYgPSBEYXRlLm5vdygpIC0gTUVNQ0hBVF9ERUJVR19MT0dfTUFYX0FHRV9NUztcbiAgICByZXR1cm4gKEFycmF5LmlzQXJyYXkoZW50cmllcykgPyBlbnRyaWVzIDogW10pXG4gICAgICAgIC5maWx0ZXIoZW50cnkgPT4gZW50cnkgJiYgdHlwZW9mIGVudHJ5LmF0ID09PSAnbnVtYmVyJyAmJiBlbnRyeS5hdCA+PSBjdXRvZmYpXG4gICAgICAgIC5zbGljZSgtTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtZW1jaGF0RGVidWdIeWRyYXRlKCkge1xuICAgIGlmIChtZW1jaGF0RGVidWdMb2FkZWQpIHJldHVybiBtZW1jaGF0RGVidWdFbnRyaWVzO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KE1FTUNIQVRfREVCVUdfTE9HX0tFWSkpW01FTUNIQVRfREVCVUdfTE9HX0tFWV07XG4gICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChzYXZlZCk7XG4gICAgfSBjYXRjaCB7IG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBbXTsgfVxuICAgIG1lbWNoYXREZWJ1Z0xvYWRlZCA9IHRydWU7XG4gICAgcmV0dXJuIG1lbWNoYXREZWJ1Z0VudHJpZXM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1lbWNoYXREZWJ1Z0VuYWJsZWQoKSB7XG4gICAgdHJ5IHsgcmV0dXJuIChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTUVNQ0hBVF9ERUJVR19GTEFHX0tFWSkpW01FTUNIQVRfREVCVUdfRkxBR19LRVldID09PSAndHJ1ZSc7IH1cbiAgICBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBtZW1jaGF0RGVidWdTZXRFbmFibGVkKGVuYWJsZWQpIHtcbiAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhlbmFibGVkID09PSB0cnVlKTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV06IHZhbHVlIH0pO1xuICAgICAgICByZXR1cm4gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChNRU1DSEFUX0RFQlVHX0ZMQUdfS0VZKSlbTUVNQ0hBVF9ERUJVR19GTEFHX0tFWV0gPT09IHZhbHVlO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnUmVjb3JkKGVudHJ5LCB3b3JsZCA9ICd3b3JrZXInKSB7XG4gICAgY29uc3Qgd29yayA9IG1lbWNoYXREZWJ1Z0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbGV2ZWwgPSBNRU1DSEFUX0RFQlVHX0xFVkVMUy5pbmNsdWRlcyhlbnRyeT8ubGV2ZWwpID8gZW50cnkubGV2ZWwgOiAnaW5mbyc7XG4gICAgICAgICAgICAvLyBFcnJvcnMgYXJlIGFsd2F5cyBrZXB0OiB0aGV5IGFyZSB3aGF0IGEgdXNlciByZXBvcnRzLiBFdmVyeXRoaW5nXG4gICAgICAgICAgICAvLyBlbHNlIGlzIG9wdC1pbiBiZWNhdXNlIHRoZSBidWZmZXIgaXMgc2hhcmVkIGFuZCBtYXkgYmUgZXhwb3J0ZWQuXG4gICAgICAgICAgICBpZiAobGV2ZWwgIT09ICdlcnJvcicgJiYgIWF3YWl0IG1lbWNoYXREZWJ1Z0VuYWJsZWQoKSkgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgZW50cmllcyA9IGF3YWl0IG1lbWNoYXREZWJ1Z0h5ZHJhdGUoKTtcbiAgICAgICAgICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgICAgICAgICBlbnRyaWVzLnB1c2goe1xuICAgICAgICAgICAgICAgIGlkOiAnZGwtJyArIG5vdyArICctJyArICgrK21lbWNoYXREZWJ1Z1NlcXVlbmNlKSxcbiAgICAgICAgICAgICAgICBhdDogbm93LFxuICAgICAgICAgICAgICAgIHdvcmxkOiBNRU1DSEFUX0RFQlVHX1dPUkxEUy5pbmNsdWRlcyh3b3JsZCkgPyB3b3JsZCA6ICd3b3JrZXInLFxuICAgICAgICAgICAgICAgIGxldmVsLFxuICAgICAgICAgICAgICAgIHNjb3BlOiB0eXBlb2YgZW50cnk/LnNjb3BlID09PSAnc3RyaW5nJyA/IGVudHJ5LnNjb3BlLnNsaWNlKDAsIDY0KSA6ICdhcHAnLFxuICAgICAgICAgICAgICAgIGV2ZW50OiB0eXBlb2YgZW50cnk/LmV2ZW50ID09PSAnc3RyaW5nJyA/IGVudHJ5LmV2ZW50LnNsaWNlKDAsIDIwMCkgOiAnJyxcbiAgICAgICAgICAgICAgICBkZXRhaWw6IG1lbWNoYXREZWJ1Z1Nhbml0aXplKGVudHJ5Py5kZXRhaWwpXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIG1lbWNoYXREZWJ1Z0VudHJpZXMgPSBtZW1jaGF0RGVidWdGcmVzaChlbnRyaWVzKTtcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW01FTUNIQVRfREVCVUdfTE9HX0tFWV06IG1lbWNoYXREZWJ1Z0VudHJpZXMgfSk7IH1cbiAgICAgICAgICAgIGNhdGNoIHsgLyogRGlhZ25vc3RpY3MgbXVzdCBuZXZlciBkaXN0dXJiIHRoZSBvcGVyYXRpb24gYmVpbmcgdHJhY2VkLiAqLyB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBTYW1lOiBhIGJyb2tlbiBidWZmZXIgY2Fubm90IGJyZWFrIGJ1c2luZXNzIGxvZ2ljLiAqLyB9XG4gICAgfSk7XG4gICAgbWVtY2hhdERlYnVnQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yaztcbn1cblxuLy8gRW50cmllcyBhcmUgcmV0dXJuZWQgbmV3ZXN0IGZpcnN0IHNvIGEgcGFzdGVkIGV4Y2VycHQgc3RhcnRzIGF0IHRoZSBsYXRlc3Rcbi8vIGZhaWx1cmUuIGBsaW1pdGAgaXMgY2xhbXBlZCB0byB0aGUgcmluZyBzaXplLlxuZnVuY3Rpb24gbWVtY2hhdERlYnVnUmVhZChvcHRpb25zID0ge30pIHtcbiAgICBjb25zdCB3b3JrID0gbWVtY2hhdERlYnVnQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdFbmFibGVkKCk7XG4gICAgICAgIGxldCBlbnRyaWVzO1xuICAgICAgICB0cnkgeyBlbnRyaWVzID0gbWVtY2hhdERlYnVnRnJlc2goYXdhaXQgbWVtY2hhdERlYnVnSHlkcmF0ZSgpKTsgbWVtY2hhdERlYnVnRW50cmllcyA9IGVudHJpZXM7IH1cbiAgICAgICAgY2F0Y2ggeyBlbnRyaWVzID0gW107IH1cbiAgICAgICAgY29uc3QgbGltaXQgPSBOdW1iZXIuaXNJbnRlZ2VyKG9wdGlvbnM/LmxpbWl0KVxuICAgICAgICAgICAgPyBNYXRoLm1pbihNYXRoLm1heChvcHRpb25zLmxpbWl0LCAxKSwgTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQpIDogTUVNQ0hBVF9ERUJVR19MT0dfTElNSVQ7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBlbmFibGVkLCBlbnRyaWVzOiBlbnRyaWVzLnNsaWNlKC1saW1pdCkucmV2ZXJzZSgpIH07XG4gICAgfSk7XG4gICAgbWVtY2hhdERlYnVnQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yay5jYXRjaCgoKSA9PiAoeyBvazogdHJ1ZSwgZW5hYmxlZDogZmFsc2UsIGVudHJpZXM6IFtdIH0pKTtcbn1cblxuZnVuY3Rpb24gbWVtY2hhdERlYnVnQ2xlYXIoKSB7XG4gICAgY29uc3Qgd29yayA9IG1lbWNoYXREZWJ1Z0NoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBtZW1jaGF0RGVidWdFbnRyaWVzID0gW107XG4gICAgICAgIG1lbWNoYXREZWJ1Z0xvYWRlZCA9IHRydWU7XG4gICAgICAgIHRyeSB7IGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW01FTUNIQVRfREVCVUdfTE9HX0tFWV06IFtdIH0pOyB9XG4gICAgICAgIGNhdGNoIHsgLyogQ2xlYXJpbmcgaXMgYmVzdCBlZmZvcnQuICovIH1cbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgICBtZW1jaGF0RGVidWdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrLmNhdGNoKCgpID0+ICh7IG9rOiB0cnVlIH0pKTtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxuY29uc3QgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcCgpO1xuY29uc3QgcnVsZXNSZWFkeSA9IGNocm9tZS5kZWNsYXJhdGl2ZU5ldFJlcXVlc3QudXBkYXRlU2Vzc2lvblJ1bGVzKHtcbiAgICByZW1vdmVSdWxlSWRzOiBbMSwgMl0sXG4gICAgYWRkUnVsZXM6IFtcbiAgICAgICAgeyBpZDogMSwgcHJpb3JpdHk6IDEsIGFjdGlvbjogeyB0eXBlOiAnbW9kaWZ5SGVhZGVycycsIHJlcXVlc3RIZWFkZXJzOiBbXG4gICAgICAgICAgICB7IGhlYWRlcjogJ09yaWdpbicsIG9wZXJhdGlvbjogJ3NldCcsIHZhbHVlOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIH0sXG4gICAgICAgICAgICB7IGhlYWRlcjogJ1JlZmVyZXInLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcgfVxuICAgICAgICBdIH0sIGNvbmRpdGlvbjogeyBpbml0aWF0b3JEb21haW5zOiBbY2hyb21lLnJ1bnRpbWUuaWRdLCB1cmxGaWx0ZXI6ICd8aHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvJywgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddIH0gfSxcbiAgICAgICAgeyBpZDogMiwgcHJpb3JpdHk6IDIsIGFjdGlvbjogeyB0eXBlOiAnYmxvY2snIH0sIGNvbmRpdGlvbjoge1xuICAgICAgICAgICAgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSxcbiAgICAgICAgICAgIGV4Y2x1ZGVkUmVxdWVzdERvbWFpbnM6IFsuLi5uZXcgU2V0KE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5uZXR3b3JrSG9zdHMubWFwKGhvc3QgPT4gaG9zdC5yZXBsYWNlKC9eXFwqXFwuLywgJycpKSldLFxuICAgICAgICAgICAgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddXG4gICAgICAgIH0gfVxuICAgIF1cbn0pO1xuLy8gRmFpbCBjbG9zZWQ6IGEgZmFpbGVkIEROUiBzZXR1cCBpcyBjYXVnaHQgaGVyZSBhbmQgYmxvY2tzIHN1YnNlcXVlbnQgcmVxdWVzdHMuXG5sZXQgcnVsZUZhaWx1cmUgPSBmYWxzZTtcbnJ1bGVzUmVhZHkuY2F0Y2goKCkgPT4geyBydWxlRmFpbHVyZSA9IHRydWU7IH0pO1xuXG5mdW5jdGlvbiBtYXRjaGVzSG9zdChob3N0bmFtZSwgcGF0dGVybikge1xuICAgIHJldHVybiBwYXR0ZXJuLnN0YXJ0c1dpdGgoJyouJylcbiAgICAgICAgPyBob3N0bmFtZSA9PT0gcGF0dGVybi5zbGljZSgyKSB8fCBob3N0bmFtZS5lbmRzV2l0aCgnLicgKyBwYXR0ZXJuLnNsaWNlKDIpKVxuICAgICAgICA6IGhvc3RuYW1lID09PSBwYXR0ZXJuO1xufVxuXG5mdW5jdGlvbiBhbGxvd2VkVXJsKHJhdykge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5wb3J0XG4gICAgICAgIHx8ICFNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLnNvbWUoaG9zdCA9PiBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIGhvc3QpKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VSTCBub3QgcGVybWl0dGVkJyk7XG4gICAgfVxuICAgIHJldHVybiB1cmw7XG59XG5cbmZ1bmN0aW9uIHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHNlbmRlci50YWI/LmlkKSB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VuZGVyLnVybCk7XG4gICAgICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiBNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcucGFnZU1hdGNoZXMuc29tZShwYXR0ZXJuID0+XG4gICAgICAgICAgICBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIG5ldyBVUkwocGF0dGVybi5yZXBsYWNlKCcqLicsICd3aWxkY2FyZC4nKSkuaG9zdG5hbWUucmVwbGFjZSgnd2lsZGNhcmQuJywgJyouJykpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RLZXkoc2VuZGVyLCBpZCkge1xuICAgIHJldHVybiB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpID8gYG5hdGl2ZToke3NlbmRlci51cmx9OiR7aWR9YCA6IGAke3NlbmRlci50YWIuaWR9OiR7c2VuZGVyLmZyYW1lSWR9OiR7aWR9YDtcbn1cblxuLy8gRGlzcGF0Y2ggTVMgcmVxdWVzdHMgZGlyZWN0bHkuIE9ubHkgYSBmYWlsZWQgcmVhZCB3YWl0cyBmb3IgaXRzIG93biByZXRyeTtcbi8vIG5vIHByb2ZpbGUtd2lkZSBxdW90YSBzdGF0ZSwgcmVzZXJ2YXRpb25zLCBjb25jdXJyZW5jeSBjYXAgb3IgcGFjaW5nLlxuZnVuY3Rpb24gaXNNc0pzb25BcGkodXJsKSB7XG4gICAgcmV0dXJuIHVybC5ob3N0bmFtZSA9PT0gJ2FwaS5tb3lza2xhZC5ydScgJiYgL15cXC9hcGlcXC9yZW1hcFxcLzFcXC4yKD86XFwvfCQpLy50ZXN0KHVybC5wYXRobmFtZSk7XG59XG5mdW5jdGlvbiBtc1JldHJ5RGVsYXkocmVzcG9uc2UsIHRleHQgPSAnJykge1xuICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICBsZXQgcXVvdGFFcnJvciA9IGZhbHNlO1xuICAgICAgICB0cnkgeyBxdW90YUVycm9yID0gSlNPTi5wYXJzZSh0ZXh0KT8uZXJyb3JzPy5zb21lKGVycm9yID0+IE51bWJlcihlcnJvci5jb2RlKSA9PT0gMTA3MykgPT09IHRydWU7IH0gY2F0Y2ggeyAvKiBOb3QgSlNPTi4gKi8gfVxuICAgICAgICBpZiAoIVs0MDgsIDQyOV0uaW5jbHVkZXMocmVzcG9uc2Uuc3RhdHVzKSAmJiByZXNwb25zZS5zdGF0dXMgPCA1MDAgJiYgIXF1b3RhRXJyb3IpIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBsb2duZXggPSBOdW1iZXIocmVzcG9uc2U/LmhlYWRlcnMuZ2V0KCdYLUxvZ25leC1SZXRyeS1BZnRlcicpIHx8IDApO1xuICAgIGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZT8uaGVhZGVycy5nZXQoJ1JldHJ5LUFmdGVyJyk7XG4gICAgY29uc3Qgc2Vjb25kcyA9IHJldHJ5QWZ0ZXI/LnRyaW0oKSA/IE51bWJlcihyZXRyeUFmdGVyKSA6IDA7XG4gICAgY29uc3Qgc3RhbmRhcmQgPSBOdW1iZXIuaXNGaW5pdGUoc2Vjb25kcykgPyBzZWNvbmRzICogMTAwMCA6IERhdGUucGFyc2UocmV0cnlBZnRlcikgLSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGRlbGF5ID0gTWF0aC5tYXgoNTAwLCBOdW1iZXIuaXNGaW5pdGUobG9nbmV4KSA/IGxvZ25leCA6IDAsIE51bWJlci5pc0Zpbml0ZShzdGFuZGFyZCkgPyBzdGFuZGFyZCA6IDApO1xuICAgIHJldHVybiBkZWxheTtcbn1cbmZ1bmN0aW9uIG1zV2FpdEZvclJldHJ5KHNpZ25hbCwgZGVsYXkpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgIGxldCByZW1haW5pbmcgPSBkZWxheTtcbiAgICAgICAgbGV0IHRpbWVyO1xuICAgICAgICBjb25zdCBkb25lID0gKCkgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBkb25lKTsgcmVzb2x2ZSgpOyB9O1xuICAgICAgICBjb25zdCBzY2hlZHVsZSA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNodW5rID0gTWF0aC5taW4ocmVtYWluaW5nLCAyMTQ3NDgzNjQ3KTtcbiAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVtYWluaW5nIC09IGNodW5rO1xuICAgICAgICAgICAgICAgIGlmIChyZW1haW5pbmcgPiAwKSBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgICAgIGVsc2UgZG9uZSgpO1xuICAgICAgICAgICAgfSwgY2h1bmspO1xuICAgICAgICB9O1xuICAgICAgICBzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBkb25lLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgZG9uZSgpO1xuICAgICAgICBlbHNlIHNjaGVkdWxlKCk7XG4gICAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1SZXF1ZXN0KG1lc3NhZ2UsIHNlbmRlciwgYmFja2dyb3VuZFNpZ25hbCwgYmFja2dyb3VuZENyZWRlbnRpYWxDdXJyZW50KSB7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UucmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhbGxvd2VkVXJsKHJlcXVlc3Q/LnVybCk7XG4gICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICghWydHRVQnLCAnSEVBRCcsICdQT1NUJywgJ1BVVCcsICdQQVRDSCcsICdERUxFVEUnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ01ldGhvZCBub3QgcGVybWl0dGVkJyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0JvZHkgbXVzdCBiZSB0ZXh0Jyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgYm9keScpO1xuICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSAmJiAhWyd0ZXh0JywgJ2pzb24nXS5pbmNsdWRlcyhyZXF1ZXN0LnJlc3BvbnNlVHlwZSkpIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgcmVzcG9uc2UgdHlwZScpO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycygpO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXF1ZXN0LmhlYWRlcnMgfHwge30pKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGVhZGVyJyk7XG4gICAgICAgIGlmICgvXmF1dGhvcml6YXRpb24kL2kudGVzdChuYW1lKSAmJiB1cmwuaG9zdG5hbWUgIT09ICdhcGkubW95c2tsYWQucnUnKSB0aHJvdyBuZXcgRXJyb3IoJ0F1dGhvcml6YXRpb24gaG9zdCBub3QgcGVybWl0dGVkJyk7XG4gICAgICAgIGlmICgvXihvcmlnaW58cmVmZXJlcnx1c2VyLWFnZW50fGNvb2tpZXxob3N0fGNvbnRlbnQtbGVuZ3RofGNvbm5lY3Rpb258YWNjZXB0LWVuY29kaW5nfHByb3h5LS4qfHNlYy0uKikkL2kudGVzdChuYW1lKSkgY29udGludWU7XG4gICAgICAgIGhlYWRlcnMuc2V0KG5hbWUsIHZhbHVlKTtcbiAgICB9XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgaXNNc0pzb25BcGkodXJsKSAmJiByZXF1ZXN0LmNyZWRlbnRpYWxHdWFyZCAhPT0gdHJ1ZSkgdGhyb3cgRXJyb3IoJ05hdGl2ZSBjcmVkZW50aWFscyBtdXN0IGJlIGd1YXJkZWQnKTtcbiAgICBjb25zdCBrZXkgPSByZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCk7XG4gICAgaWYgKHBlbmRpbmdSZXF1ZXN0cy5oYXMoa2V5KSkgdGhyb3cgbmV3IEVycm9yKCdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IGVudHJ5ID0geyBjb250cm9sbGVyOiBuZXcgQWJvcnRDb250cm9sbGVyKCksIGV2ZW50OiAnJyB9O1xuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoa2V5LCBlbnRyeSk7XG4gICAgY29uc3QgY2FuY2VsQmFja2dyb3VuZCA9ICgpID0+IHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH07XG4gICAgYmFja2dyb3VuZFNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgaWYgKGJhY2tncm91bmRTaWduYWw/LmFib3J0ZWQpIGNhbmNlbEJhY2tncm91bmQoKTtcbiAgICBjb25zdCB0aW1lb3V0ID0gTWF0aC5taW4oMzAwMDAsIE1hdGgubWF4KDEsIE51bWJlcihyZXF1ZXN0LnRpbWVvdXQpIHx8IDMwMDAwKSk7XG4gICAgbGV0IHRpbWVyO1xuICAgIGNvbnN0IGNoZWNrQ3VycmVudCA9IGJhY2tncm91bmRDcmVkZW50aWFsQ3VycmVudCA/IGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHsgaWYgKGF3YWl0IGJhY2tncm91bmRDcmVkZW50aWFsQ3VycmVudCgpKSByZXR1cm47IH0gY2F0Y2ggeyAvKiBGYWlsIGNsb3NlZC4gKi8gfVxuICAgICAgICBlbnRyeS5ldmVudCA9ICdhYm9ydCc7XG4gICAgICAgIGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICB9IDogcmVxdWVzdC5jcmVkZW50aWFsR3VhcmQgPT09IHRydWUgPyBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxldCBjaGVja1RpbWVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgICAgICB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpXG4gICAgICAgICAgICAgICAgICAgID8gbmF0aXZlUnVudGltZVJlcXVlc3QobmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlciksIHsgdHlwZTogJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50JywgaWQ6IG1lc3NhZ2UuaWQgfSlcbiAgICAgICAgICAgICAgICAgICAgOiBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShzZW5kZXIudGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0OnJlcXVlc3QtY3VycmVudCcsIGlkOiBtZXNzYWdlLmlkIH0sIHNlbmRlci5kb2N1bWVudElkID8geyBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiBzZW5kZXIuZnJhbWVJZCB9KSxcbiAgICAgICAgICAgICAgICBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgY2hlY2tUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShudWxsKSwgMTAwMCk7IH0pXG4gICAgICAgICAgICBdKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQ/LmN1cnJlbnQgPT09IHRydWUgJiYgKCFpc01zSnNvbkFwaSh1cmwpIHx8IHR5cGVvZiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50ICE9PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgfHwgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGhlYWRlcnMuZ2V0KCdhdXRob3JpemF0aW9uJykpKSkgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogTWlzc2luZy9pbnZhbGlkYXRlZCBjb250ZW50IHdvcmxkIGZhaWxzIGNsb3NlZC4gKi8gfVxuICAgICAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KGNoZWNrVGltZXIpOyB9XG4gICAgICAgIGVudHJ5LmV2ZW50ID0gJ2Fib3J0JztcbiAgICAgICAgZW50cnkuY29udHJvbGxlci5hYm9ydCgpO1xuICAgIH0gOiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgIGlmIChydWxlRmFpbHVyZSkgdGhyb3cgbmV3IEVycm9yKCdOZXR3b3JrIHJ1bGVzIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgIGlmICh1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmIHBhbmVsU2Vzc2lvbj8udGFiKSB7XG4gICAgICAgICAgICBpZiAoY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBwYW5lbFJlcXVlc3RWaWFUYWIoeyAuLi5yZXF1ZXN0LCBtZXRob2QgfSwgZW50cnkuY29udHJvbGxlci5zaWduYWwpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGNvbnN0IGNhblJldHJ5ID0gaXNNc0pzb25BcGkodXJsKSAmJiBbJ0dFVCcsICdIRUFEJ10uaW5jbHVkZXMobWV0aG9kKSAmJiBhdHRlbXB0ID09PSAwO1xuICAgICAgICAgICAgbGV0IHJldHJ5RGVsYXk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBlbnRyeS5jb250cm9sbGVyO1xuICAgICAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGVudHJ5LmV2ZW50ID0gJ3RpbWVvdXQnOyBjb250cm9sbGVyLmFib3J0KCk7IH0sIHRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLmhyZWYsIHtcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiByZXF1ZXN0LmRhdGEgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogcmVxdWVzdC5hbm9ueW1vdXMgPT09IHRydWUgPyAnb21pdCcgOiAnaW5jbHVkZScsXG4gICAgICAgICAgICAgICAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsIHJlZGlyZWN0OiBpc01zSnNvbkFwaSh1cmwpID8gJ2Vycm9yJyA6ICdmb2xsb3cnXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgLy8gRE5SIGJsb2NrcyByZWRpcmVjdHMgdG8gdW5ncmFudGVkIGhvc3RzIGJlZm9yZSBzZW5kaW5nIGJ5dGVzLlxuICAgICAgICAgICAgICAgIGFsbG93ZWRVcmwocmVzcG9uc2UudXJsIHx8IHVybC5ocmVmKTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHRocm93IG5ldyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IGNhblJldHJ5ID8gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCByZXNwb25zZVRleHQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICAvLyBQYXRoIG9ubHk6IHF1ZXJ5IHN0cmluZ3MgY2FuIGNhcnJ5IHNlYXJjaCB0ZXJtcyBvciBpZGVudGlmaWVycy5cbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID49IDQwMCkgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnbmV0d29yaycsIGV2ZW50OiAnaHR0cC1lcnJvcicsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyB1cmw6IHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWUsIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCByZXRyeURlbGF5LCBhdHRlbXB0IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgICAgIGlmIChyZXRyeURlbGF5ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBwYXJzZWQgPSByZXNwb25zZVRleHQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyBwYXJzZWQgPSBudWxsOyB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgZXZlbnQ6ICdsb2FkJywgcmVzcG9uc2U6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN0YXR1czogcmVzcG9uc2Uuc3RhdHVzLCBzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LCByZXNwb25zZVRleHQsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNwb25zZTogcGFyc2VkLCByZXNwb25zZUhlYWRlcnM6IFsuLi5yZXNwb25zZS5oZWFkZXJzXS5tYXAoKFtuYW1lLCB2YWx1ZV0pID0+IGAke25hbWV9OiAke3ZhbHVlfWApLmpvaW4oU3RyaW5nLmZyb21DaGFyQ29kZSgxMywgMTApKSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbmFsVXJsOiByZXNwb25zZS51cmwgfHwgdXJsLmhyZWYsIHJlYWR5U3RhdGU6IDRcbiAgICAgICAgICAgICAgICAgICAgfSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIGlmIChlbnRyeS5ldmVudCAhPT0gJ2Fib3J0JykgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnbmV0d29yaycsIGV2ZW50OiAnbmV0d29yay1lcnJvcicsXG4gICAgICAgICAgICAgICAgICAgIGRldGFpbDogeyB1cmw6IHVybC5vcmlnaW4gKyB1cmwucGF0aG5hbWUsIHN0YXR1czogbnVsbCwgcmV0cnlEZWxheTogY2FuUmV0cnkgPyA1MDAgOiBudWxsLCBhdHRlbXB0IH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICAgICAgICAgIGlmICghY2FuUmV0cnkgfHwgZW50cnkuZXZlbnQgPT09ICdhYm9ydCcpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgICAgICAgICAgICAgIHJldHJ5RGVsYXkgPSA1MDA7XG4gICAgICAgICAgICB9IGZpbmFsbHkgeyBjbGVhclRpbWVvdXQodGltZXIpOyB9XG4gICAgICAgICAgICAvLyBBIHRpbWVvdXQgYWJvcnRzIGl0cyBhdHRlbXB0LCBub3QgdGhlIG5leHQgb25lLiBFeHBsaWNpdCBhYm9ydHMgYW5kXG4gICAgICAgICAgICAvLyBjcmVkZW50aWFsIGNoYW5nZXMgc3RpbGwgY2FuY2VsIHRoaXMgd2FpdCBhbmQgc3VwcHJlc3MgdGhlIHJldHJ5LlxuICAgICAgICAgICAgZW50cnkuZXZlbnQgPSAnJztcbiAgICAgICAgICAgIGVudHJ5LmNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgICAgICBhd2FpdCBtc1dhaXRGb3JSZXRyeShlbnRyeS5jb250cm9sbGVyLnNpZ25hbCwgcmV0cnlEZWxheSk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHsgZXZlbnQ6IGVudHJ5LmV2ZW50IHx8ICdlcnJvcicsIGVycm9yOiAn0J7RiNC40LHQutCwINGB0LXRgtC4INGA0LDRgdGI0LjRgNC10L3QuNGPIE1lbWNoYXQnIH07XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgYmFja2dyb3VuZFNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kKTtcbiAgICAgICAgcGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShrZXkpO1xuICAgIH1cbn1cbiIsIi8vIEEgc2luZ2xlIHdvcmtlciBvd25zIHRoZSBQYW5lbCB0b2tlbi4gTmV2ZXIgcGVyc2lzdCBpdCBpbnRvIHBhZ2Ugc3RvcmFnZS5cbmNvbnN0IFBBTkVMX1NFU1NJT05fVFRMID0gMTIgKiA2MCAqIDEwMDA7XG5jb25zdCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQgPSAxNTAwMDtcbmxldCBwYW5lbFNlc3Npb24gPSBudWxsO1xubGV0IG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbmxldCBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuXG5mdW5jdGlvbiBleHRyYWN0UGFuZWxTZXNzaW9uVG9rZW4oaHRtbCkge1xuICAgIGNvbnN0IGNsZWFuID0gaHRtbC5yZXBsYWNlKC88IS0tW1xcc1xcU10qPy0tPnw8c2NyaXB0XFxiW14+XSo+W1xcc1xcU10qPzxcXC9zY3JpcHRcXHMqPi9naSwgJycpO1xuICAgIGlmICgvPGlucHV0XFxiW14+XSpcXGJ0eXBlXFxzKj1cXHMqW1wiJ10/cGFzc3dvcmRcXGIvaS50ZXN0KGNsZWFuKSkgcmV0dXJuICcnO1xuICAgIGZvciAoY29uc3QgdGFnIG9mIGNsZWFuLm1hdGNoKC88bWV0YVxcYltePl0qPi9naSkgfHwgW10pIHtcbiAgICAgICAgY29uc3QgYXR0cnMgPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBtYXRjaCBvZiB0YWcubWF0Y2hBbGwoLyhbXFx3LV0rKVxccyo9XFxzKig/OlwiKFteXCJdKilcInwnKFteJ10qKScpL2cpKSB7XG4gICAgICAgICAgICBhdHRyc1ttYXRjaFsxXS50b0xvd2VyQ2FzZSgpXSA9IG1hdGNoWzJdID8/IG1hdGNoWzNdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhdHRycy5uYW1lPy50b0xvd2VyQ2FzZSgpID09PSAnY3NyZi10b2tlbicgJiYgL15bQS1aYS16MC05Xy1dezE2LDUxMn0kLy50ZXN0KGF0dHJzLmNvbnRlbnQgfHwgJycpKSByZXR1cm4gYXR0cnMuY29udGVudDtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xufVxuXG5sZXQgcGFuZWxUYWJTZXF1ZW5jZSA9IDA7XG5mdW5jdGlvbiBwYW5lbFRhYlVybChyYXcpIHtcbiAgICB0cnkgeyBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7IHJldHVybiB1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmICF1cmwudXNlcm5hbWUgJiYgIXVybC5wYXNzd29yZCAmJiAhL15cXC9sb2dpblxcLz8kLy50ZXN0KHVybC5wYXRobmFtZSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuZnVuY3Rpb24gcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXF1ZXN0Py51cmwpLCBtZXRob2QgPSBTdHJpbmcocmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIHJldHVybiBwYW5lbFRhYlVybCh1cmwuaHJlZikgJiYgIXVybC5oYXNoICYmICF1cmwuc2VhcmNoICYmICgobWV0aG9kID09PSAnR0VUJ1xuICAgICAgICAgICAgJiYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2VhcmNoL2ZpbHRlcnMnIHx8IC9eXFwvYXBpXFwvYm9udXNlc1xcL2NoZWNrXFwvXFxkezEsMjB9JC8udGVzdCh1cmwucGF0aG5hbWUpKSlcbiAgICAgICAgICAgIHx8IChtZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaCcgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSA9PT0gJ3N0cmluZycgJiYgcmVxdWVzdC5kYXRhLmxlbmd0aCA8PSAzMjc2OCkpO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiTWVzc2FnZSh0YWJJZCwgcGF5bG9hZCwgc2lnbmFsKSB7XG4gICAgY29uc3QgaWQgPSAncGFuZWwtJyArIERhdGUubm93KCkgKyAnLScgKyAoKytwYW5lbFRhYlNlcXVlbmNlKTtcbiAgICBsZXQgdGltZXIsIGFib3J0O1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgICAgIGFib3J0ID0gKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6ICdtZW1jaGF0OnBhbmVsLXRhYicsIGlkLCBvcGVyYXRpb246ICdjYW5jZWwnIH0sIHsgZnJhbWVJZDogMCB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZShudWxsKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoYWJvcnQsIFBBTkVMX1NFU1NJT05fVElNRU9VVCk7XG4gICAgICAgICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgYWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChzaWduYWw/LmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5yYWNlKFtjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgLi4ucGF5bG9hZCB9LCB7IGZyYW1lSWQ6IDAgfSksIHRpbWVvdXRdKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0KTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gcmVjb3ZlclBhbmVsRnJvbVRhYihzaWduYWwpIHtcbiAgICBpZiAoIWNocm9tZS50YWJzPy5xdWVyeSB8fCAhY2hyb21lLnRhYnM/LmdldCB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFicyA9IChhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1LyonIH0pKS5maWx0ZXIodGFiID0+IE51bWJlci5pc0ludGVnZXIodGFiLmlkKSAmJiBwYW5lbFRhYlVybCh0YWIudXJsKSk7XG4gICAgICAgIHRhYnMuc29ydCgoYSwgYikgPT4gTnVtYmVyKCEhYi5hY3RpdmUpIC0gTnVtYmVyKCEhYS5hY3RpdmUpIHx8IChiLmxhc3RBY2Nlc3NlZCB8fCAwKSAtIChhLmxhc3RBY2Nlc3NlZCB8fCAwKSB8fCBhLmlkIC0gYi5pZCk7XG4gICAgICAgIGZvciAoY29uc3QgdGFiIG9mIHRhYnMuc2xpY2UoMCwgMykpIHtcbiAgICAgICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHBhbmVsVGFiTWVzc2FnZSh0YWIuaWQsIHsgb3BlcmF0aW9uOiAnc2Vzc2lvbicgfSwgc2lnbmFsKTtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICBpZiAocmVwbHk/Lm9rICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChyZXBseS50b2tlbiB8fCAnJykgJiYgdHlwZW9mIHJlcGx5Lmluc3RhbmNlID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgICYmIHJlcGx5Lmluc3RhbmNlLmxlbmd0aCA8PSAxMDAgJiYgcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW46IHJlcGx5LnRva2VuLCBzYXZlZEF0OiBEYXRlLm5vdygpLCB0YWI6IHsgaWQ6IHRhYi5pZCwgaW5zdGFuY2U6IHJlcGx5Lmluc3RhbmNlIH0gfTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdG9rZW46IHJlcGx5LnRva2VuIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogQ2xvc2VkL25hdmlnYXRlZCB0YWJzIGFyZSBub3QgYW4gYXV0aGVudGljYXRlZCBzZXNzaW9uLiAqLyB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFJlcXVlc3RWaWFUYWIocmVxdWVzdCwgc2lnbmFsKSB7XG4gICAgY29uc3Qgcm91dGUgPSBwYW5lbFNlc3Npb24/LnRhYjtcbiAgICBpZiAoIXJvdXRlIHx8ICFwYW5lbFRhYlJlcXVlc3RBbGxvd2VkKHJlcXVlc3QpKSByZXR1cm4geyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LfQsNC/0YDQvtGBINC+0YLQutC70L7QvdGR0L0nIH07XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFwYW5lbFRhYlVybChjdXJyZW50Py51cmwpIHx8IHNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBldmVudDogc2lnbmFsLmFib3J0ZWQgPyAnYWJvcnQnIDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LLQutC70LDQtNC60LAg0LfQsNC60YDRi9GC0LAg0LjQu9C4INC40LfQvNC10L3QtdC90LAuINCf0L7QstGC0L7RgNC40YLQtSDQv9GA0L7QstC10YDQutGDIHBhbmVsLicgfTtcbiAgICBjb25zdCByZXBseSA9IGF3YWl0IHBhbmVsVGFiTWVzc2FnZShyb3V0ZS5pZCwgeyBvcGVyYXRpb246ICdyZXF1ZXN0JywgaW5zdGFuY2U6IHJvdXRlLmluc3RhbmNlLCByZXF1ZXN0IH0sIHNpZ25hbCk7XG4gICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBldmVudDogJ2Fib3J0JyB9O1xuICAgIGNvbnN0IGFmdGVyID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHJvdXRlLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICBpZiAoIXJlcGx5Py5vayB8fCByZXBseS5pbnN0YW5jZSAhPT0gcm91dGUuaW5zdGFuY2UgfHwgIXBhbmVsVGFiVXJsKGFmdGVyPy51cmwpIHx8IHJlcGx5LnJlc3VsdD8uZXZlbnQgIT09ICdsb2FkJ1xuICAgICAgICB8fCAhTnVtYmVyLmlzSW50ZWdlcihyZXBseS5yZXN1bHQucmVzcG9uc2U/LnN0YXR1cykgfHwgcmVwbHkucmVzdWx0LnJlc3BvbnNlPy5maW5hbFVybCAhPT0gcmVxdWVzdC51cmwpIHtcbiAgICAgICAgaWYgKHBhbmVsU2Vzc2lvbj8udGFiID09PSByb3V0ZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ3Nlc3Npb24tbG9zdCcsIGRldGFpbDogeyByZWFzb246ICdjb250ZXh0JyB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC60L7QvdGC0LXQutGB0YIg0LLQutC70LDQtNC60Lgg0LjQt9C80LXQvdC40LvRgdGPLiDQndCw0LbQvNC40YLQtSBwYW5lbCDQtNC70Y8g0L/QvtCy0YLQvtGA0L3QvtC5INC/0YDQvtCy0LXRgNC60LguJyB9O1xuICAgIH1cbiAgICByZXR1cm4gcmVwbHkucmVzdWx0O1xufVxuXG5mdW5jdGlvbiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodChmb3JjZSkge1xuICAgIC8vIEEgcXVldWVkIG5vcm1hbCBmbGlnaHQgbWF5IGhhdmUgcG9wdWxhdGVkIHRoZSBjYWNoZSBzaW5jZSBmb3JjZSB3YXMgcmVxdWVzdGVkLlxuICAgIGlmIChmb3JjZSkgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICBjb25zdCBmbGlnaHQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICBmbGlnaHQucHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIFBBTkVMX1NFU1NJT05fVElNRU9VVCk7XG4gICAgICAgIGNvbnN0IGZhaWx1cmUgPSBhc3luYyAocmVhc29uLCBlcnJvcikgPT4ge1xuICAgICAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAncGFuZWwnLCBldmVudDogJ3Nlc3Npb24tZmFpbGVkJywgZGV0YWlsOiB7IHJlYXNvbiB9IH0sICd3b3JrZXInKTtcbiAgICAgICAgICAgIHJldHVybiAoYXdhaXQgcmVjb3ZlclBhbmVsRnJvbVRhYihjb250cm9sbGVyLnNpZ25hbCkpIHx8IHsgb2s6IGZhbHNlLCByZWFzb24sIGVycm9yIH07XG4gICAgICAgIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBydWxlc1JlYWR5O1xuICAgICAgICAgICAgaWYgKHJ1bGVGYWlsdXJlIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBFcnJvcignUGFuZWwgdW5hdmFpbGFibGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ3RleHQvaHRtbCcgfSwgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgICAgICBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsVXJsID0gbmV3IFVSTChyZXNwb25zZS51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcpO1xuICAgICAgICAgICAgaWYgKGZpbmFsVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB8fCAhL15cXC9zZWFyY2hcXC8/JC8udGVzdChmaW5hbFVybC5wYXRobmFtZSlcbiAgICAgICAgICAgICAgICB8fCByZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDRhNC+0L3QvtCy0YvQuSDQstGF0L7QtCDQvdC10LTQvtGB0YLRg9C/0LXQvS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQsiDRjdGC0L7QvCDQv9GA0L7RhNC40LvQtSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHRva2VuID0gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGF3YWl0IHJlc3BvbnNlLnRleHQoKSk7XG4gICAgICAgICAgICBpZiAoIXRva2VuIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0L7QtNGC0LLQtdGA0LTQuNGC0Ywg0LLRhdC+0LQuINCe0YLQutGA0L7QudGC0LUgcGFuZWwuaGF0aWtvLnJ1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgLy8gTGFyYXZlbCBpc3N1ZXMgQ1NSRiBldmVuIGZvciBhbm9ueW1vdXMgbG9naW4gcGFnZXMuIENvbmZpcm0gYWNjZXNzXG4gICAgICAgICAgICAvLyB0byBhbiBhY3R1YWwgcHJvdGVjdGVkIHJlYWQtb25seSBBUEkgd2l0aCB0aGUgc2FtZSBicm93c2VyIGNvb2tpZXMuXG4gICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLCAnWC1SZXF1ZXN0ZWQtV2l0aCc6ICdYTUxIdHRwUmVxdWVzdCcgfSxcbiAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLCBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGF1dGhVcmwgPSBuZXcgVVJMKGF1dGgudXJsIHx8ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9hcGkvc2VhcmNoL2ZpbHRlcnMnKTtcbiAgICAgICAgICAgIGlmIChhdXRoLnN0YXR1cyA8IDIwMCB8fCBhdXRoLnN0YXR1cyA+PSAzMDAgfHwgYXV0aFVybC5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydSdcbiAgICAgICAgICAgICAgICB8fCBhdXRoVXJsLnBhdGhuYW1lICE9PSAnL2FwaS9zZWFyY2gvZmlsdGVycycgfHwgIS9hcHBsaWNhdGlvblxcL2pzb24vaS50ZXN0KGF1dGguaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoYXV0aC5zdGF0dXMgPj0gNTAwID8gJ25ldHdvcmsnIDogJ2F1dGgnLCAnUGFuZWw6INC90LXRgiDQtNC+0YHRgtGD0L/QsCDQuiBBUEkuINCe0YLQutGA0L7QudGC0LUg0LDQstGC0L7RgNC40LfQvtCy0LDQvdC90YPRjiBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBwcm9vZiA9IGF3YWl0IGF1dGguanNvbigpO1xuICAgICAgICAgICAgaWYgKCFwcm9vZiB8fCB0eXBlb2YgcHJvb2YgIT09ICdvYmplY3QnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIFBhbmVsIGF1dGggcHJvb2YnKTtcbiAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbiB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCduZXR3b3JrJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0YDQvtCy0LXRgNC40YLRjCDQstGF0L7QtC4g0J/RgNC+0LLQtdGA0YzRgtC1INGB0L7QtdC00LjQvdC10L3QuNC1INC4INC+0YLQutGA0YvRgtGD0Y4g0LLQutC70LDQtNC60YMgcGFuZWwuaGF0aWtvLnJ1LicpO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIGlmIChmb3JjZSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID09PSBmbGlnaHQpIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG4gICAgICAgIH1cbiAgICB9KSgpO1xuICAgIGlmIChmb3JjZSkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIGVsc2Ugbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIHJldHVybiBmbGlnaHQucHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gZ2V0UGFuZWxTZXNzaW9uKGZvcmNlKSB7XG4gICAgaWYgKGZvcmNlKSBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAocXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0KSByZXR1cm4gcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7XG4gICAgaWYgKGZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkge1xuICAgICAgICBjb25zdCBxdWV1ZWQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICAgICAgcXVldWVkLnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7IH1cbiAgICAgICAgICAgIGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IHF1ZXVlZCkgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodCh0cnVlKTtcbiAgICAgICAgfSkoKTtcbiAgICAgICAgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gcXVldWVkO1xuICAgICAgICByZXR1cm4gcXVldWVkLnByb21pc2U7XG4gICAgfVxuICAgIGlmICghZm9yY2UgJiYgcGFuZWxTZXNzaW9uICYmIERhdGUubm93KCkgLSBwYW5lbFNlc3Npb24uc2F2ZWRBdCA8IFBBTkVMX1NFU1NJT05fVFRMKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IHRydWUsIHRva2VuOiBwYW5lbFNlc3Npb24udG9rZW4gfSk7XG4gICAgaWYgKCFmb3JjZSAmJiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICByZXR1cm4gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpO1xufVxuIiwiLy8gRXh0ZW5zaW9uLW93bmVkIHByZXNlbnRhdGlvbi4gTm8gc2l0ZSBET00sIHRva2Vucywgb3IgY29udGVudC10YWIgYXVkaW8uXG5jb25zdCBPUkRFUl9OT1RJRklDQVRJT05fSUQgPSAnbWVtY2hhdC1vcmRlcnMnO1xuY29uc3QgT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSA9ICdtZW1jaGF0LW9yZGVyLW5vdGlmaWNhdGlvbi1leHBpcmUnO1xuZnVuY3Rpb24gb3JkZXJCZWFySWNvbihzaXplKSB7XG4gICAgY29uc3QgY2FudmFzID0gbmV3IE9mZnNjcmVlbkNhbnZhcyhzaXplLCBzaXplKSwgY3R4ID0gY2FudmFzLmdldENvbnRleHQoJzJkJyksIHMgPSBzaXplIC8gMzI7XG4gICAgY29uc3Qgb3ZhbCA9ICh4LCB5LCByeCwgcnksIGNvbG9yKSA9PiB7IGN0eC5maWxsU3R5bGUgPSBjb2xvcjsgY3R4LmJlZ2luUGF0aCgpOyBjdHguZWxsaXBzZSh4ICogcywgeSAqIHMsIHJ4ICogcywgcnkgKiBzLCAwLCAwLCBNYXRoLlBJICogMik7IGN0eC5maWxsKCk7IH07XG4gICAgb3ZhbCg3LCA3LCA2LCA2LCAnIzcxM2YyYScpOyBvdmFsKDI1LCA3LCA2LCA2LCAnIzcxM2YyYScpO1xuICAgIG92YWwoNywgNywgMywgMywgJyNkOGFhNzgnKTsgb3ZhbCgyNSwgNywgMywgMywgJyNkOGFhNzgnKTtcbiAgICBvdmFsKDE2LCAxOCwgMTQsIDEzLCAnIzk4NjIzYicpO1xuICAgIG92YWwoMTYsIDI0LCA4LCA2LCAnI2VkYzk5YicpO1xuICAgIG92YWwoMTAsIDE3LCAyLCAyLjUsICcjMjMxNTBlJyk7IG92YWwoMjIsIDE3LCAyLCAyLjUsICcjMjMxNTBlJyk7XG4gICAgb3ZhbCgxNiwgMjIsIDMsIDIsICcjMjMxNTBlJyk7IG92YWwoMTYsIDI2LCAyLCAxLCAnIzcxM2YyYScpO1xuICAgIHJldHVybiBjdHguZ2V0SW1hZ2VEYXRhKDAsIDAsIHNpemUsIHNpemUpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJVcGRhdGVJY29uKCkge1xuICAgIGlmICghY2hyb21lLmFjdGlvbj8uc2V0SWNvbikgcmV0dXJuO1xuICAgIGNvbnN0IGVuYWJsZWQgPSBvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldEljb24oZW5hYmxlZCA/IHsgaW1hZ2VEYXRhOiB7IDE2OiBvcmRlckJlYXJJY29uKDE2KSwgMzI6IG9yZGVyQmVhckljb24oMzIpIH0gfSA6IHsgcGF0aDogJ2ljb24ucG5nJyB9KTtcbiAgICBhd2FpdCBjaHJvbWUuYWN0aW9uLnNldFRpdGxlKHsgdGl0bGU6IGVuYWJsZWQgPyAn8J+QuyDQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0LrQu9GO0YfRkdC9IMK3INCe0YLQutGA0YvRgtGMINCx0L7QutC+0LLRg9GOINC/0LDQvdC10LvRjCBNZW1jaGF0JyA6ICfQntGC0LrRgNGL0YLRjCDQnNC10LzRh9Cw0YIg0LIg0LHQvtC60L7QstC+0Lkg0L/QsNC90LXQu9C4JyB9KTtcbn1cbmxldCBvcmRlckF1ZGlvQ3JlYXRpbmcgPSBudWxsO1xubGV0IG9yZGVyQXVkaW9HZW5lcmF0aW9uID0gMDtcbmFzeW5jIGZ1bmN0aW9uIG9yZGVyU3RvcEF1ZGlvKCkge1xuICAgIG9yZGVyQXVkaW9HZW5lcmF0aW9uKys7XG4gICAgaWYgKCFjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cykgcmV0dXJuO1xuICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgaWYgKGNvbnRleHRzLmxlbmd0aCkgYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0YXJnZXQ6ICdtZW1jaGF0LW9mZnNjcmVlbicsIHR5cGU6ICdtZW1jaGF0OmF1ZGlvLXN0b3AnIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJFbnN1cmVBdWRpbygpIHtcbiAgICBpZiAob3JkZXJBdWRpb0NyZWF0aW5nKSByZXR1cm4gb3JkZXJBdWRpb0NyZWF0aW5nO1xuICAgIG9yZGVyQXVkaW9DcmVhdGluZyA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgICAgIGlmICghY29udGV4dHMubGVuZ3RoKSBhd2FpdCBjaHJvbWUub2Zmc2NyZWVuLmNyZWF0ZURvY3VtZW50KHsgdXJsOiAnb2Zmc2NyZWVuLmh0bWwnLCByZWFzb25zOiBbJ0FVRElPX1BMQVlCQUNLJ10sIGp1c3RpZmljYXRpb246ICdPbmUgc2hhcmVkIE1lbWNoYXQgb3JkZXIgYWxhcm0sIGluZGVwZW5kZW50IG9mIG9wZW4gTW95U2tsYWQgdGFicy4nIH0pO1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyQXVkaW9DcmVhdGluZyA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckF1ZGlvQ3JlYXRpbmc7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclBsYXlBdWRpbyhpc0N1cnJlbnQgPSAoKSA9PiB0cnVlKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG9yZGVyQXVkaW9HZW5lcmF0aW9uO1xuICAgIGF3YWl0IG9yZGVyRW5zdXJlQXVkaW8oKTtcbiAgICBpZiAoIWlzQ3VycmVudCgpIHx8IGdlbmVyYXRpb24gIT09IG9yZGVyQXVkaW9HZW5lcmF0aW9uKSByZXR1cm47XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHRhcmdldDogJ21lbWNoYXQtb2Zmc2NyZWVuJywgdHlwZTogJ21lbWNoYXQ6YXVkaW8tcGxheScgfSk7XG4gICAgaWYgKCFyZXNwb25zZT8ub2spIHRocm93IEVycm9yKCfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJQcmVzZW50UmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgY3VycmVudCA9ICgpID0+IGNvbmZpZyA9PT0gb3JkZXJDb25maWcgJiYgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgJiYgIWNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQ7XG4gICAgaWYgKCFyZXN1bHQub3JkZXJzLmxlbmd0aCB8fCAhY3VycmVudCgpKSByZXR1cm4gW107XG4gICAgY29uc3Qgbm90aWZ5ID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuZ2V0UGVybWlzc2lvbkxldmVsKCk7XG4gICAgICAgIGlmICghY3VycmVudCgpKSByZXR1cm47XG4gICAgICAgIGlmIChwZXJtaXNzaW9uICE9PSAnZ3JhbnRlZCcpIHRocm93IEVycm9yKCfQo9Cy0LXQtNC+0LzQu9C10L3QuNGPINC+0YLQutC70Y7Rh9C10L3RiyDQsiDQsdGA0LDRg9C30LXRgNC1Jyk7XG4gICAgICAgIGNvbnN0IG9yZGVycyA9IHJlc3VsdC5vcmRlcnM7XG4gICAgICAgIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZShPUkRFUl9OT1RJRklDQVRJT05fSUQsIHsgdHlwZTogJ2Jhc2ljJywgaWNvblVybDogJ2ljb24ucG5nJyxcbiAgICAgICAgICAgIHRpdGxlOiAn8J+QuyBNZW1jaGF0IMK3INCX0LDQutCw0LfRizogJyArIG9yZGVycy5sZW5ndGgsXG4gICAgICAgICAgICBtZXNzYWdlOiBvcmRlcnMuc2xpY2UoMCwgMykubWFwKGl0ZW0gPT4gU3RyaW5nKGl0ZW0ubmFtZSkuc2xpY2UoMCwgODApICsgJyDCtyAnICsgU3RyaW5nKGl0ZW0ub3JnYW5pemF0aW9uTmFtZSkuc2xpY2UoMCwgODApKS5qb2luKCdcXG4nKSArIChyZXN1bHQucGFydGlhbCA/ICdcXG7imqAg0J7Qv9GA0L7RgSDQvdC10L/QvtC70L3Ri9C5JyA6ICcnKSxcbiAgICAgICAgICAgIHByaW9yaXR5OiAwLCBzaWxlbnQ6IHRydWUsIHJlcXVpcmVJbnRlcmFjdGlvbjogY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzID09PSAwIH0pO1xuICAgICAgICBpZiAoIWN1cnJlbnQoKSkgeyBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpOyByZXR1cm47IH1cbiAgICAgICAgaWYgKGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyA+IDApIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlksIHsgd2hlbjogRGF0ZS5ub3coKSArIGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyAqIDYwMDAwIH0pO1xuICAgICAgICBlbHNlIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgfTtcbiAgICBjb25zdCB0YXNrcyA9IFtub3RpZnkoKV07XG4gICAgaWYgKGNvbmZpZy5zZXR0aW5ncy5zb3VuZEVuYWJsZWQpIHRhc2tzLnB1c2gob3JkZXJQbGF5QXVkaW8oY3VycmVudCkpO1xuICAgIGNvbnN0IG91dGNvbWVzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRhc2tzKTtcbiAgICByZXR1cm4gb3V0Y29tZXMuZmxhdE1hcCgoaXRlbSwgaW5kZXgpID0+IGl0ZW0uc3RhdHVzID09PSAncmVqZWN0ZWQnID8gW2luZGV4ID09PSAwID8gJ9Ch0LjRgdGC0LXQvNC90YvQtSDRg9Cy0LXQtNC+0LzQu9C10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QvdGLJyA6ICfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvSddIDogW10pO1xufVxuaWYgKGNocm9tZS5ub3RpZmljYXRpb25zPy5vbkNsaWNrZWQpIGNocm9tZS5ub3RpZmljYXRpb25zLm9uQ2xpY2tlZC5hZGRMaXN0ZW5lcihpZCA9PiB7XG4gICAgaWYgKGlkICE9PSBPUkRFUl9OT1RJRklDQVRJT05fSUQpIHJldHVybjtcbiAgICBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydS9hcHAvI2N1c3RvbWVyb3JkZXInLCBhY3RpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKS5jYXRjaCgoKSA9PiB7fSk7XG59KTtcbiIsIi8vIFNoYXJlZCBvcmRlciBwb2xsaW5nIGlzIGluZGVwZW5kZW50IG9mIHRoZSBsaWZldGltZS9udW1iZXIgb2YgY29udGVudCB0YWJzLlxuLy8gU2Vzc2lvbiBzdG9yYWdlIGlzIGV4dGVuc2lvbi1wcml2YXRlOyBiZWFyZXIgbmV2ZXIgZW50ZXJzIGEgYnJvYWRjYXN0IG9yIGxvZ3MuXG5jb25zdCBPUkRFUl9TRVNTSU9OX0tFWSA9ICdtZW1jaGF0T3JkZXJTZXJ2aWNlX3YxJztcbmxldCBvcmRlckNvbmZpZyA9IG51bGw7XG5sZXQgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoKTtcbmxldCBvcmRlclJldmlzaW9uID0gMDtcbmxldCBvcmRlckZsaWdodCA9IG51bGw7XG5sZXQgb3JkZXJDb250cm9sbGVyID0gbnVsbDtcbmxldCBvcmRlckxhc3RSZXN1bHQgPSBudWxsO1xubGV0IG9yZGVyQ29uZmlnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmZ1bmN0aW9uIG9yZGVyTXV0YXRlKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgbmV4dCA9IG9yZGVyQ29uZmlnQ2hhaW4udGhlbihjYWxsYmFjayk7XG4gICAgb3JkZXJDb25maWdDaGFpbiA9IG5leHQuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBuZXh0O1xufVxuY29uc3Qgb3JkZXJSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoT1JERVJfU0VTU0lPTl9LRVkpKVtPUkRFUl9TRVNTSU9OX0tFWV07XG4gICAgICAgIGlmIChzYXZlZCkgeyBvcmRlckNvbmZpZyA9IHNhdmVkLmNvbmZpZzsgb3JkZXJSZXZpc2lvbiA9IHNhdmVkLnJldmlzaW9uIHx8IDA7IG9yZGVyU3Vic2NyaWJlcnMgPSBuZXcgU2V0KHNhdmVkLnN1YnNjcmliZXJzIHx8IFtdKTsgfVxuICAgICAgICBhd2FpdCBvcmRlclVwZGF0ZUljb24oKTtcbiAgICB9IGNhdGNoIHsgLyogQ29uZmlndXJlIG11c3Qgc3VjY2Vzc2Z1bGx5IHBlcnNpc3QgYmVmb3JlIGVuYWJsaW5nIHBvbGxpbmcuICovIH1cbn0pKCk7XG5mdW5jdGlvbiBvcmRlclB1YmxpY0NvbmZpZygpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgc2V0dGluZ3M6IG9yZGVyQ29uZmlnPy5zZXR0aW5ncywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gfTtcbn1cbmZ1bmN0aW9uIG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgbmV3IFJlZ0V4cCgnXmh0dHBzOi8vYXBpXFxcXC5tb3lza2xhZFxcXFwucnUvYXBpL3JlbWFwLzFcXFxcLjIvZW50aXR5LycgKyBraW5kICsgJy9bQS1aYS16MC05LV0rJCcpLnRlc3QodmFsdWUpO1xufVxuZnVuY3Rpb24gb3JkZXJTZXR0aW5ncyhyYXcpIHtcbiAgICBjb25zdCByZWZzID0gKHZhbHVlcywga2luZCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWVzKSB8fCAhdmFsdWVzLmV2ZXJ5KHZhbHVlID0+IG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHJlZmVyZW5jZXMnKTtcbiAgICAgICAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyldO1xuICAgIH07XG4gICAgcmV0dXJuIHsgZW5hYmxlZDogcmF3Py5lbmFibGVkICE9PSBmYWxzZSwgc291bmRFbmFibGVkOiByYXc/LnNvdW5kRW5hYmxlZCAhPT0gZmFsc2UsXG4gICAgICAgIGludGVydmFsTWludXRlczogTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChOdW1iZXIocmF3Py5pbnRlcnZhbE1pbnV0ZXMpIHx8IDEpKSksXG4gICAgICAgIHRvYXN0RHVyYXRpb25NaW51dGVzOiBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKE51bWJlcihyYXc/LnRvYXN0RHVyYXRpb25NaW51dGVzKSB8fCAwKSkpLFxuICAgICAgICBvcmdhbml6YXRpb25IcmVmczogcmVmcyhyYXc/Lm9yZ2FuaXphdGlvbkhyZWZzLCAnb3JnYW5pemF0aW9uJyksXG4gICAgICAgIHN0YXR1c0hyZWZzOiByZWZzKHJhdz8uc3RhdHVzSHJlZnMsICdjdXN0b21lcm9yZGVyL21ldGFkYXRhL3N0YXRlcycpIH07XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclNldEFsYXJtKCkge1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgfHwgIW9yZGVyQ29uZmlnLnNldHRpbmdzLnNvdW5kRW5hYmxlZCkgYXdhaXQgb3JkZXJTdG9wQXVkaW8oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCAmJiBjaHJvbWUubm90aWZpY2F0aW9ucz8uY2xlYXIpIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIC8vIFRvb2xiYXIgcHJlc2VudGF0aW9uIG11c3QgbmV2ZXIgcHJldmVudCBzY2hlZHVsaW5nIG9yIHBhdXNpbmcgdGhlIHNlcnZpY2UuXG4gICAgYXdhaXQgb3JkZXJVcGRhdGVJY29uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmICghY2hyb21lLmFsYXJtcykgcmV0dXJuO1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQpIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgaWYgKG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCAmJiBvcmRlckNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoJ21lbWNoYXQtb3JkZXJzJywgeyBwZXJpb2RJbk1pbnV0ZXM6IG9yZGVyQ29uZmlnLnNldHRpbmdzLmludGVydmFsTWludXRlcyB9KTtcbiAgICB9IGVsc2UgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcignbWVtY2hhdC1vcmRlcnMnKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgIGlmICh0eXBlb2YgbWVzc2FnZS50b2tlbiAhPT0gJ3N0cmluZycgfHwgIW1lc3NhZ2UudG9rZW4udHJpbSgpIHx8IG1lc3NhZ2UudG9rZW4ubGVuZ3RoID4gNDA5NikgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdG9rZW4nKTtcbiAgICBjb25zdCBzZXR0aW5ncyA9IG9yZGVyU2V0dGluZ3MobWVzc2FnZS5zZXR0aW5ncyk7XG4gICAgY29uc3QgdW5jaGFuZ2VkID0gb3JkZXJDb25maWc/LnRva2VuID09PSBtZXNzYWdlLnRva2VuICYmIEpTT04uc3RyaW5naWZ5KG9yZGVyQ29uZmlnLnNldHRpbmdzKSA9PT0gSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpO1xuICAgIGlmIChvcmRlckNvbmZpZyAmJiAobWVzc2FnZS51cGRhdGUgIT09IHRydWUgfHwgdW5jaGFuZ2VkKSkge1xuICAgICAgICBpZiAob3JkZXJDb25maWcudG9rZW4gIT09IG1lc3NhZ2UudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIGVycm9yOiAn0JTRgNGD0LPQvtC5IEJlYXJlciDQsiDRhNC+0L3QtS4g0KHQvtGF0YDQsNC90LjRgtC1INC90LDRgdGC0YDQvtC50LrQuCDRj9Cy0L3QviDQtNC70Y8g0YHQvNC10L3RiyDQsNC60LrQsNGD0L3RgtCwLicgfTtcbiAgICAgICAgaWYgKHNlbmRlci50YWIpIG9yZGVyU3Vic2NyaWJlcnMuYWRkKHNlbmRlci50YWIuaWQpO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnOiBvcmRlckNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgaWYgKGNocm9tZS5hbGFybXM/LmdldCAmJiAhKGF3YWl0IGNocm9tZS5hbGFybXMuZ2V0KCdtZW1jaGF0LW9yZGVycycpKSkgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBwb2xsUmVxdWlyZWQ6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChvcmRlckNvbmZpZyAmJiBtZXNzYWdlLnJldmlzaW9uICE9PSBvcmRlclJldmlzaW9uKSByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBvazogZmFsc2UsIGNvbmZsaWN0OiB0cnVlLCBlcnJvcjogJ9Cd0LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLINCyINC00YDRg9Cz0L7QuSDQstC60LvQsNC00LrQtS4g0J/QvtCy0YLQvtGA0LjRgtC1INC40LfQvNC10L3QtdC90LjQtS4nIH07XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gPyBuZXcgU2V0KG9yZGVyU3Vic2NyaWJlcnMpIDogbmV3IFNldCgpO1xuICAgIGlmIChzZW5kZXIudGFiKSBzdWJzY3JpYmVycy5hZGQoc2VuZGVyLnRhYi5pZCk7XG4gICAgY29uc3QgY29uZmlnID0geyB0b2tlbjogbWVzc2FnZS50b2tlbiwgc2V0dGluZ3MsIG9yZ2FuaXphdGlvbnM6IChBcnJheS5pc0FycmF5KG1lc3NhZ2Uub3JnYW5pemF0aW9ucykgPyBtZXNzYWdlLm9yZ2FuaXphdGlvbnMgOiBbXSlcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IHNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmluY2x1ZGVzKGl0ZW0/LmhyZWYpKS5tYXAoaXRlbSA9PiAoeyBocmVmOiBpdGVtLmhyZWYsIG5hbWU6IFN0cmluZyhpdGVtLm5hbWUgfHwgJycpLnNsaWNlKDAsIDMwMCkgfSkpIH07XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gKyAxLCBzdWJzY3JpYmVyczogWy4uLnN1YnNjcmliZXJzXSB9IH0pO1xuICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICBvcmRlckNvbmZpZyA9IGNvbmZpZzsgb3JkZXJTdWJzY3JpYmVycyA9IHN1YnNjcmliZXJzOyBvcmRlclJldmlzaW9uKys7IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG4gICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIHBvbGxSZXF1aXJlZDogdHJ1ZSB9O1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJHZXQocGF0aCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwZXJmb3JtUmVxdWVzdCh7IGlkOiAnYmFja2dyb3VuZC1vcmRlcnMnLCByZXF1ZXN0OiB7XG4gICAgICAgIHVybDogJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjInICsgcGF0aCwgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyICcgKyBjb25maWcudG9rZW4sIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfSxcbiAgICAgICAgYW5vbnltb3VzOiB0cnVlLCBiYWNrZ3JvdW5kT3JkZXI6IHRydWVcbiAgICB9IH0sIHsgdGFiOiB7IGlkOiAtMSB9LCBmcmFtZUlkOiAwIH0sIGNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSB0aHJvdyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgaWYgKHJlc3BvbnNlLmV2ZW50ICE9PSAnbG9hZCcpIHRocm93IEVycm9yKCfQntGI0LjQsdC60LAg0YHQvtC10LTQuNC90LXQvdC40Y8g0YEg0JzQvtC50KHQutC70LDQtCcpO1xuICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cztcbiAgICBpZiAoc3RhdHVzIDwgMjAwIHx8IHN0YXR1cyA+PSAzMDApIHsgY29uc3QgZXJyb3IgPSBFcnJvcign0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgc3RhdHVzKTsgZXJyb3Iuc3RhdHVzID0gc3RhdHVzOyB0aHJvdyBlcnJvcjsgfVxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7IGRhdGEgPSBKU09OLnBhcnNlKHJlc3BvbnNlLnJlc3BvbnNlLnJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyB0aHJvdyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INC+0YLQstC10YIg0JzQvtC50KHQutC70LDQtCcpOyB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGE/LnJvd3MpKSB0aHJvdyBFcnJvcign0J3QtdC/0L7Qu9C90YvQuSDQvtGC0LLQtdGCINGB0L/QuNGB0LrQsCDQt9Cw0LrQsNC30L7QsicpO1xuICAgIHJldHVybiBkYXRhO1xufVxuYXN5bmMgZnVuY3Rpb24gZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbikge1xuICAgIGlmICghY2hyb21lLnRhYnM/LnF1ZXJ5KSByZXR1cm47XG4gICAgY29uc3QgdGFicyA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHt9KTtcbiAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHRhYnMuZmlsdGVyKHRhYiA9PiBvcmRlclN1YnNjcmliZXJzLmhhcyh0YWIuaWQpICYmIHRydXN0ZWRDb250ZW50U2VuZGVyKHsgaWQ6IGNocm9tZS5ydW50aW1lLmlkLCB0YWIsIGZyYW1lSWQ6IDAsIHVybDogdGFiLnVybCB9KSk7XG4gICAgY2FuZGlkYXRlcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoISFiLmFjdGl2ZSkgLSBOdW1iZXIoISFhLmFjdGl2ZSkpO1xuICAgIGZvciAoY29uc3QgdGFiIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSwgeyBmcmFtZUlkOiAwIH0pO1xuICAgICAgICAgICAgaWYgKGFjaz8ub2spIHJldHVybjtcbiAgICAgICAgfSBjYXRjaCB7IC8qIFRyeSBhbm90aGVyIGxpdmUgY29udGVudCB3b3JsZCwgbm90IGV2ZXJ5IHRhYi4gKi8gfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IG5hdGl2ZSBvZiBuYXRpdmVSdW50aW1lU2Vzc2lvbnMudmFsdWVzKCkpIHtcbiAgICAgICAgaWYgKG5hdGl2ZS5vcmRlclRva2VuICE9PSBjb25maWcudG9rZW4gfHwgbmF0aXZlLm9yZGVyUmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgY29udGludWU7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQobmF0aXZlLnNlbmRlciwgJ0JlYXJlciAnICsgY29uZmlnLnRva2VuKSkgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBuYXRpdmVSdW50aW1lUmVxdWVzdChuYXRpdmUsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSk7XG4gICAgICAgICAgICBpZiAoYWNrPy5vaykgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogQSBjbG9zZWQgbmF0aXZlIGRvY3VtZW50IGlzIG5vdCBhbm90aGVyIHN1YnNjcmliZXIuICovIH1cbiAgICB9XG59XG5hc3luYyBmdW5jdGlvbiBwb2xsT3JkZXJzKCkge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgYXdhaXQgb3JkZXJDb25maWdDaGFpbjtcbiAgICBpZiAob3JkZXJGbGlnaHQpIHJldHVybiBvcmRlckZsaWdodDtcbiAgICBjb25zdCBjb25maWcgPSBvcmRlckNvbmZpZztcbiAgICBpZiAoIWNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCB8fCAhY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCB8fCAhY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLRi9C60LvRjtGH0LXQvSDQuNC70Lgg0L3QtSDQvdCw0YHRgtGA0L7QtdC9JyB9O1xuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHJldmlzaW9uID0gb3JkZXJSZXZpc2lvbjtcbiAgICAgICAgb3JkZXJDb250cm9sbGVyID0gY29udHJvbGxlcjtcbiAgICBvcmRlckZsaWdodCA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gbmV3IE1hcCgpLCBmYWlsZWQgPSBbXTtcbiAgICAgICAgbGV0IGF1dGhGYWlsZWQgPSBmYWxzZTtcbiAgICAgICAgZm9yIChjb25zdCBocmVmIG9mIGNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcykge1xuICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBjb25maWcub3JnYW5pemF0aW9ucy5maW5kKGl0ZW0gPT4gaXRlbS5ocmVmID09PSBocmVmKT8ubmFtZSB8fCAn0J7RgNCz0LDQvdC40LfQsNGG0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsCc7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICAgICAgbGV0IG9mZnNldCA9IDA7XG4gICAgICAgICAgICAgICAgZm9yICg7Oykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBmaWx0ZXIgPSBbJ29yZ2FuaXphdGlvbj0nICsgaHJlZiwgLi4uY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLm1hcChzdGF0ZSA9PiAnc3RhdGU9JyArIHN0YXRlKV0uam9pbignOycpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgb3JkZXJHZXQoJy9lbnRpdHkvY3VzdG9tZXJvcmRlcj9maWx0ZXI9JyArIGVuY29kZVVSSUNvbXBvbmVudChmaWx0ZXIpXG4gICAgICAgICAgICAgICAgICAgICAgICArICcmZXhwYW5kPXN0YXRlLG9yZ2FuaXphdGlvbiZvcmRlcj1tb21lbnQsZGVzYyZsaW1pdD0xMDAmb2Zmc2V0PScgKyBvZmZzZXQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gcm93cy5zaXplO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiBkYXRhLnJvd3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghcm93Py5pZCkgdGhyb3cgRXJyb3IoJ9CX0LDQutCw0Lcg0LHQtdC3INC40LTQtdC90YLQuNGE0LjQutCw0YLQvtGA0LAnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd3Muc2V0KHJvdy5pZCwgcm93KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBvZmZzZXQgKz0gZGF0YS5yb3dzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW9yZSA9ICEhZGF0YS5tZXRhPy5uZXh0SHJlZiB8fCAoTnVtYmVyLmlzRmluaXRlKGRhdGEubWV0YT8uc2l6ZSkgPyBvZmZzZXQgPCBkYXRhLm1ldGEuc2l6ZSA6IGRhdGEucm93cy5sZW5ndGggPj0gMTAwKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3JlKSBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFkYXRhLnJvd3MubGVuZ3RoIHx8IHJvd3Muc2l6ZSA9PT0gcHJldmlvdXMpIHRocm93IEVycm9yKCfQn9Cw0LPQuNC90LDRhtC40Y8g0LfQsNC60LDQt9C+0LIg0L3QtSDQv9GA0L7QtNCy0LjQs9Cw0LXRgtGB0Y8nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2Ygcm93cy52YWx1ZXMoKSkgaWYgKGNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5pbmNsdWRlcyhyb3cuc3RhdGU/Lm1ldGE/LmhyZWYpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kLnNldChyb3cuaWQsIHsgaWQ6IHJvdy5pZCwgbmFtZTogcm93Lm5hbWUgfHwgcm93LmlkLCBzdGF0ZU5hbWU6IHJvdy5zdGF0ZT8ubmFtZSB8fCAn0J3QvtCy0YvQuScsIG9yZ2FuaXphdGlvbk5hbWU6IGxhYmVsLCBvcmdhbml6YXRpb25IcmVmOiBocmVmIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L06INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLJyB9O1xuICAgICAgICAgICAgICAgIGZhaWxlZC5wdXNoKGxhYmVsICsgJyDigJQgJyArIChlcnJvci5tZXNzYWdlIHx8ICfQntGI0LjQsdC60LAg0LfQsNC/0YDQvtGB0LAnKSk7XG4gICAgICAgICAgICAgICAgaWYgKFs0MDEsIDQwM10uaW5jbHVkZXMoZXJyb3Iuc3RhdHVzKSkgeyBhdXRoRmFpbGVkID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScgfTtcbiAgICAgICAgaWYgKGF1dGhGYWlsZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICAgICAgICAgICAgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnLCByZXZpc2lvbjogKytvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L0nIH07XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHsgaWQ6IFN0cmluZyhEYXRlLm5vdygpKSArICctJyArIG9yZGVyUmV2aXNpb24sIG9yZGVyczogWy4uLmZvdW5kLnZhbHVlcygpXSwgZmFpbGVkLCBwYXJ0aWFsOiBmYWlsZWQubGVuZ3RoID4gMCxcbiAgICAgICAgICAgIGJlYXJlcjogYXV0aEZhaWxlZCA/ICdlcnJvcicgOiBmYWlsZWQubGVuZ3RoID09PSBjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoID8gJ3Vua25vd24nIDogJ29rJywgYXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgcmVzdWx0Lm9yZGVycy5mb3JFYWNoKG9yZGVyID0+IHsgb3JkZXIucGFydGlhbCA9IHJlc3VsdC5wYXJ0aWFsOyB9KTtcbiAgICAgICAgb3JkZXJMYXN0UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICByZXN1bHQuYWxlcnRXYXJuaW5ncyA9IGF3YWl0IG9yZGVyUHJlc2VudFJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9OiDQvdCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiycgfTtcbiAgICAgICAgYXdhaXQgZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbik7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCByZXN1bHQgfTtcbiAgICB9KSgpLmZpbmFsbHkoKCkgPT4geyBvcmRlckZsaWdodCA9IG51bGw7IGlmIChvcmRlckNvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIG9yZGVyQ29udHJvbGxlciA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckZsaWdodDtcbn1cbmlmIChjaHJvbWUuYWxhcm1zKSBjaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoYWxhcm0gPT4ge1xuICAgIGlmIChhbGFybS5uYW1lID09PSBPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKSByZXR1cm4gY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0lEKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKGFsYXJtLm5hbWUgPT09ICdtZW1jaGF0LW9yZGVycycpIHJldHVybiBwb2xsT3JkZXJzKCkuY2F0Y2goKCkgPT4ge30pO1xufSk7XG4iLCIvLyBOYXRpdmUgcnVudGltZSBpZGVudGl0aWVzIGFyZSByZWFsIENocm9tZSBNZXNzYWdlU2VuZGVycywgbmV2ZXIgc3ludGhldGljIHRhYnMuXG4vLyBBIG9uZS11c2UgY2FwYWJpbGl0eSwgZGVsaXZlcmVkIG9ubHkgdG8gYSB2ZXJpZmllZCBTSURFX1BBTkVMIGRvY3VtZW50LCBiaW5kc1xuLy8gaXRzIGNoaWxkIHBvcnQgdG8gb25lIHdpbmRvdy9vcmlnaW4gZm9yIGl0cyBlbnRpcmUgbGlmZXRpbWUuXG5jb25zdCBuYXRpdmVSdW50aW1lSWRlbnRpdGllcyA9IG5ldyBXZWFrTWFwKCk7XG5jb25zdCBuYXRpdmVSdW50aW1lU2Vzc2lvbnMgPSBuZXcgTWFwKCk7XG5jb25zdCBuYXRpdmVSdW50aW1lVGlja2V0cyA9IG5ldyBNYXAoKTtcbmxldCBuYXRpdmVEcmFmdENoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5jb25zdCBOQVRJVkVfTEFTVF9PUklHSU5fS0VZID0gJ21lbWNoYXROYXRpdmVMYXN0T3JpZ2luX3YxJztcbmxldCBuYXRpdmVTZWxlY3Rpb25DaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwob3JpZ2luKTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gPT09IG9yaWdpbiAmJiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmRcbiAgICAgICAgICAgICYmIE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5wYWdlTWF0Y2hlcy5zb21lKHBhdHRlcm4gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGhvc3QgPSBuZXcgVVJMKHBhdHRlcm4ucmVwbGFjZSgnKi4nLCAnd2lsZGNhcmQuJykpLmhvc3RuYW1lLnJlcGxhY2UoJ3dpbGRjYXJkLicsICcqLicpO1xuICAgICAgICAgICAgICAgIHJldHVybiBob3N0LnN0YXJ0c1dpdGgoJyouJykgPyB1cmwuaG9zdG5hbWUgPT09IGhvc3Quc2xpY2UoMikgfHwgdXJsLmhvc3RuYW1lLmVuZHNXaXRoKCcuJyArIGhvc3Quc2xpY2UoMikpIDogdXJsLmhvc3RuYW1lID09PSBob3N0O1xuICAgICAgICAgICAgfSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuZnVuY3Rpb24gbmF0aXZlRG9jdW1lbnRVcmwocmF3LCBxdWVyeSwgaGFzaCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICAgICAgcmV0dXJuIHVybC5vcmlnaW4gPT09IG5ldyBVUkwoY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpKS5vcmlnaW4gJiYgdXJsLnBhdGhuYW1lID09PSAnL29mZnNjcmVlbi5odG1sJ1xuICAgICAgICAgICAgJiYgdXJsLmhhc2ggPT09ICcjJyArIGhhc2ggJiYgbmV3IFJlZ0V4cCgnXlxcXFw/JyArIHF1ZXJ5ICsgJz1bYS1mMC05LV17MzZ9JCcpLnRlc3QodXJsLnNlYXJjaCk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuY29uc3QgbmF0aXZlUGFuZWxXaW5kb3dzID0gbmV3IE1hcCgpO1xuYXN5bmMgZnVuY3Rpb24gbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIHdpbmRvd0lkKSB7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHdpbmRvd0lkKSB8fCB3aW5kb3dJZCA8IDAgfHwgc2VuZGVyPy5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydTSURFX1BBTkVMJ10sIGRvY3VtZW50VXJsczogW3NlbmRlci51cmxdIH0pO1xuICAgIGNvbnN0IGNvbnRleHQgPSBjb250ZXh0cy5maW5kKGNvbnRleHQgPT4gY29udGV4dC5jb250ZXh0VHlwZSA9PT0gJ1NJREVfUEFORUwnICYmIGNvbnRleHQuZG9jdW1lbnRVcmwgPT09IHNlbmRlci51cmxcbiAgICAgICAgJiYgKCFzZW5kZXIuZG9jdW1lbnRJZCB8fCBjb250ZXh0LmRvY3VtZW50SWQgPT09IHNlbmRlci5kb2N1bWVudElkKSk7XG4gICAgaWYgKCFjb250ZXh0KSB7IG5hdGl2ZVBhbmVsV2luZG93cy5kZWxldGUoc2VuZGVyLnVybCk7IHJldHVybiBmYWxzZTsgfVxuICAgIC8vIENocm9tZSByZXBvcnRzIHdpbmRvd0lkPS0xIGZvciBhIGdsb2JhbCBTSURFX1BBTkVMIChvYnNlcnZlZCBpbiBDaHJvbWl1bSkuXG4gICAgLy8gT25seSBvdXIgdmVyaWZpZWQgbmF0aXZlIFVJIGNhbiBlc3RhYmxpc2ggdGhpcyBmaXJzdCBiaW5kaW5nOyBpdCBvYnRhaW5zXG4gICAgLy8gaXRzIHdpbmRvdyB2aWEgd2luZG93cy5nZXRDdXJyZW50KCkuIE5ldmVyIGxldCBhIGRvY3VtZW50IHJldGFyZ2V0IGxhdGVyLlxuICAgIGlmIChjb250ZXh0LndpbmRvd0lkICE9PSAtMSAmJiBjb250ZXh0LndpbmRvd0lkICE9PSB3aW5kb3dJZCkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghbmF0aXZlUGFuZWxXaW5kb3dzLmhhcyhzZW5kZXIudXJsKSkgbmF0aXZlUGFuZWxXaW5kb3dzLnNldChzZW5kZXIudXJsLCB3aW5kb3dJZCk7XG4gICAgcmV0dXJuIG5hdGl2ZVBhbmVsV2luZG93cy5nZXQoc2VuZGVyLnVybCkgPT09IHdpbmRvd0lkO1xufVxuYXN5bmMgZnVuY3Rpb24gbmF0aXZlTGFzdE9yaWdpbigpIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IG5hdGl2ZVNlbGVjdGlvbkNoYWluO1xuICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV07XG4gICAgcmV0dXJuIG5hdGl2ZVN1cHBvcnRlZE9yaWdpbihzYXZlZCkgPyBzYXZlZCA6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydSc7XG59XG5mdW5jdGlvbiBuYXRpdmVSZW1lbWJlck9yaWdpbihvcmlnaW4pIHtcbiAgICBjb25zdCB3b3JrID0gbmF0aXZlU2VsZWN0aW9uQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmICghbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikpIHRocm93IEVycm9yKCdJbnZhbGlkIG9yaWdpbicpO1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV0gPT09IG9yaWdpbikgcmV0dXJuO1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV06IG9yaWdpbiB9KTtcbiAgICAgICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoTkFUSVZFX0xBU1RfT1JJR0lOX0tFWSkpW05BVElWRV9MQVNUX09SSUdJTl9LRVldICE9PSBvcmlnaW4pIHRocm93IEVycm9yKCdTZWxlY3Rpb24gbm90IGR1cmFibGUnKTtcbiAgICB9KTtcbiAgICBuYXRpdmVTZWxlY3Rpb25DaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiB3b3JrO1xufVxuYXN5bmMgZnVuY3Rpb24gbmF0aXZlUnVudGltZVRpY2tldChzZW5kZXIsIHdpbmRvd0lkLCBvcmlnaW4pIHtcbiAgICBpZiAoIW5hdGl2ZVN1cHBvcnRlZE9yaWdpbihvcmlnaW4pIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgd2luZG93SWQpKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgaWRlbnRpdHknKTtcbiAgICBmb3IgKGNvbnN0IFt0aWNrZXQsIGJpbmRpbmddIG9mIG5hdGl2ZVJ1bnRpbWVUaWNrZXRzKSBpZiAoYmluZGluZy5leHBpcmVzIDwgRGF0ZS5ub3coKSB8fCBiaW5kaW5nLnBhcmVudC51cmwgPT09IHNlbmRlci51cmwgJiYgYmluZGluZy5vcmlnaW4gPT09IG9yaWdpbikgbmF0aXZlUnVudGltZVRpY2tldHMuZGVsZXRlKHRpY2tldCk7XG4gICAgY29uc3QgdGlja2V0ID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICBuYXRpdmVSdW50aW1lVGlja2V0cy5zZXQodGlja2V0LCB7IHBhcmVudDogc2VuZGVyLCB3aW5kb3dJZCwgb3JpZ2luLCBleHBpcmVzOiBEYXRlLm5vdygpICsgMTUwMDAgfSk7XG4gICAgcmV0dXJuIHRpY2tldDtcbn1cbmZ1bmN0aW9uIHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgeyByZXR1cm4gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuaGFzKHNlbmRlcik7IH1cbmZ1bmN0aW9uIHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKSB7XG4gICAgY29uc3QgbmF0aXZlID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKG5hdGl2ZSkgcmV0dXJuIG5hdGl2ZS5vcmlnaW47XG4gICAgaWYgKHR5cGVvZiB0cnVzdGVkQ29udGVudFNlbmRlciA9PT0gJ2Z1bmN0aW9uJyAmJiB0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSByZXR1cm4gbmV3IFVSTChzZW5kZXIudXJsKS5vcmlnaW47XG4gICAgdGhyb3cgRXJyb3IoJ1VuYm91bmQgcnVudGltZSBpZGVudGl0eScpO1xufVxuLy8gVHJhY2sgYWN0dWFsIGZvY3VzZWQtc2l0ZSB1c2UsIG5vdCBwZXJpb2RpYyBzbmFwc2hvdHMgZnJvbSBhIGJhY2tncm91bmQgd2luZG93LlxubGV0IG5hdGl2ZUZvY3VzR2VuZXJhdGlvbiA9IDA7XG5hc3luYyBmdW5jdGlvbiBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyh3aW5kb3dJZCkge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSArK25hdGl2ZUZvY3VzR2VuZXJhdGlvbjtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB3aW5kb3cgPSBhd2FpdCBjaHJvbWUud2luZG93cy5nZXQod2luZG93SWQpO1xuICAgICAgICBpZiAoIXdpbmRvdy5mb2N1c2VkKSByZXR1cm47XG4gICAgICAgIGNvbnN0IFt0YWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkIH0pO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiA9PT0gbmF0aXZlRm9jdXNHZW5lcmF0aW9uICYmIHN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSBhd2FpdCBuYXRpdmVSZW1lbWJlck9yaWdpbihuZXcgVVJMKHRhYi51cmwpLm9yaWdpbik7XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC91bmF2YWlsYWJsZSB3aW5kb3cgbXVzdCBub3QgY2hhbmdlIHRoZSBzYXZlZCBzZWxlY3Rpb24uICovIH1cbn1cbmNocm9tZS50YWJzPy5vbkFjdGl2YXRlZD8uYWRkTGlzdGVuZXIoaW5mbyA9PiB7IHZvaWQgbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3coaW5mby53aW5kb3dJZCk7IH0pO1xuY2hyb21lLnRhYnM/Lm9uVXBkYXRlZD8uYWRkTGlzdGVuZXIoKGlkLCBjaGFuZ2UsIHRhYikgPT4geyBpZiAodGFiLmFjdGl2ZSAmJiBjaGFuZ2UudXJsKSB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHRhYi53aW5kb3dJZCk7IH0pO1xuY2hyb21lLndpbmRvd3M/Lm9uRm9jdXNDaGFuZ2VkPy5hZGRMaXN0ZW5lcih3aW5kb3dJZCA9PiB7IGlmICh3aW5kb3dJZCA+PSAwKSB2b2lkIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvd0lkKTsgZWxzZSBuYXRpdmVGb2N1c0dlbmVyYXRpb24rKzsgfSk7XG5pZiAoY2hyb21lLndpbmRvd3M/LmdldExhc3RGb2N1c2VkKSBjaHJvbWUud2luZG93cy5nZXRMYXN0Rm9jdXNlZCgpLnRoZW4od2luZG93ID0+IG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvdy5pZCksICgpID0+IHt9KTtcbmZ1bmN0aW9uIG5hdGl2ZURyYWZ0TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2xvc2VkKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoRXJyb3IoJ1VuYm91bmQgcnVudGltZScpKTtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdE5hdGl2ZURyYWZ0X3YxOicgKyBzZXNzaW9uLndpbmRvd0lkICsgJzonICsgc2Vzc2lvbi5vcmlnaW47XG4gICAgY29uc3Qgd29yayA9IG5hdGl2ZURyYWZ0Q2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om5hdGl2ZS1kcmFmdC13cml0ZScpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZS52YWx1ZSAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS52YWx1ZS5sZW5ndGggPiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgZHJhZnQnKTtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW2tleV06IG1lc3NhZ2UudmFsdWUgfSk7XG4gICAgICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KGtleSkpW2tleV0gIT09IG1lc3NhZ2UudmFsdWUpIHRocm93IEVycm9yKCdEcmFmdCBub3QgZHVyYWJsZScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHZhbHVlID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uZ2V0KGtleSkpW2tleV07XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyA/IHZhbHVlIDogJycgfTtcbiAgICB9KTtcbiAgICBuYXRpdmVEcmFmdENoYWluID0gd29yay5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHdvcms7XG59XG5mdW5jdGlvbiBuYXRpdmVSdW50aW1lU2Vzc2lvbktleShwYXJlbnQsIG9yaWdpbikgeyByZXR1cm4gcGFyZW50LnVybCArICc6JyArIG9yaWdpbjsgfVxuZnVuY3Rpb24gbmF0aXZlUnVudGltZVJlcXVlc3Qoc2Vzc2lvbiwgbWVzc2FnZSkge1xuICAgIGlmIChzZXNzaW9uLmNsb3NlZCkgcmV0dXJuIFByb21pc2UucmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTtcbiAgICBjb25zdCBpZCA9ICsrc2Vzc2lvbi5zZXF1ZW5jZTtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBzZXNzaW9uLnBlbmRpbmcuZGVsZXRlKGlkKTsgcmVqZWN0KEVycm9yKCdSdW50aW1lIHRpbWVkIG91dCcpKTsgfSwgNTAwMCk7XG4gICAgICAgIHNlc3Npb24ucGVuZGluZy5zZXQoaWQsIHsgcmVzb2x2ZSwgcmVqZWN0LCB0aW1lciB9KTtcbiAgICAgICAgdHJ5IHsgc2Vzc2lvbi5wb3J0LnBvc3RNZXNzYWdlKHsgY2FsbDogaWQsIG1lc3NhZ2UgfSk7IH1cbiAgICAgICAgY2F0Y2ggeyBjbGVhclRpbWVvdXQodGltZXIpOyBzZXNzaW9uLnBlbmRpbmcuZGVsZXRlKGlkKTsgcmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTsgfVxuICAgIH0pO1xufVxuZnVuY3Rpb24gbmF0aXZlUnVudGltZU5vdGlmeShzZW5kZXIsIG1lc3NhZ2UpIHtcbiAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2xvc2VkKSB0aHJvdyBFcnJvcignUnVudGltZSBkaXNjb25uZWN0ZWQnKTtcbiAgICBzZXNzaW9uLnBvcnQucG9zdE1lc3NhZ2UoeyBtZXNzYWdlIH0pO1xufVxuY2hyb21lLnJ1bnRpbWUub25Db25uZWN0LmFkZExpc3RlbmVyKHBvcnQgPT4ge1xuICAgIGlmIChwb3J0Lm5hbWUgIT09ICdtZW1jaGF0LW5hdGl2ZS1ydW50aW1lJykgcmV0dXJuO1xuICAgIGNvbnN0IHNlbmRlciA9IHBvcnQuc2VuZGVyO1xuICAgIGlmIChzZW5kZXI/LmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCBzZW5kZXIudGFiIHx8IHNlbmRlci5mcmFtZUlkICE9PSB1bmRlZmluZWQgJiYgc2VuZGVyLmZyYW1lSWQgIT09IDBcbiAgICAgICAgfHwgIW5hdGl2ZURvY3VtZW50VXJsKHNlbmRlci51cmwsICdydW50aW1lJywgJ3J1bnRpbWUnKSkgeyBwb3J0LmRpc2Nvbm5lY3QoKTsgcmV0dXJuOyB9XG4gICAgbGV0IHNlc3Npb24sIGJpbmRpbmcgPSBmYWxzZSwgZGlzY29ubmVjdGVkID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAoKSA9PiB7XG4gICAgICAgIGRpc2Nvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGlmICghc2Vzc2lvbiB8fCBzZXNzaW9uLmNsb3NlZCkgcmV0dXJuO1xuICAgICAgICBzZXNzaW9uLmNsb3NlZCA9IHRydWU7IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLmRlbGV0ZShzZW5kZXIpO1xuICAgICAgICBpZiAobmF0aXZlUnVudGltZVNlc3Npb25zLmdldChzZXNzaW9uLmtleSkgPT09IHNlc3Npb24pIG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy5kZWxldGUoc2Vzc2lvbi5rZXkpO1xuICAgICAgICBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSgnbmF0aXZlOicgKyBzZW5kZXIudXJsKTtcbiAgICAgICAgZm9yIChjb25zdCBwZW5kaW5nIG9mIHNlc3Npb24ucGVuZGluZy52YWx1ZXMoKSkgeyBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7IHBlbmRpbmcucmVqZWN0KEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpKTsgfVxuICAgICAgICBzZXNzaW9uLnBlbmRpbmcuY2xlYXIoKTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCByZXF1ZXN0XSBvZiBwZW5kaW5nUmVxdWVzdHMpIGlmIChrZXkuc3RhcnRzV2l0aCgnbmF0aXZlOicgKyBzZW5kZXIudXJsICsgJzonKSkgeyByZXF1ZXN0LmV2ZW50ID0gJ2Fib3J0JzsgcmVxdWVzdC5jb250cm9sbGVyLmFib3J0KCk7IH1cbiAgICB9O1xuICAgIHBvcnQub25EaXNjb25uZWN0LmFkZExpc3RlbmVyKGNsb3NlKTtcbiAgICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyBwYWNrZXQgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKGJpbmRpbmcpIHRocm93IEVycm9yKCdBbHJlYWR5IGJpbmRpbmcnKTtcbiAgICAgICAgICAgICAgICBiaW5kaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBjYXBhYmlsaXR5ID0gbmF0aXZlUnVudGltZVRpY2tldHMuZ2V0KHBhY2tldD8udGlja2V0KTtcbiAgICAgICAgICAgICAgICBuYXRpdmVSdW50aW1lVGlja2V0cy5kZWxldGUocGFja2V0Py50aWNrZXQpO1xuICAgICAgICAgICAgICAgIGlmICghY2FwYWJpbGl0eSB8fCBjYXBhYmlsaXR5LmV4cGlyZXMgPCBEYXRlLm5vdygpIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KGNhcGFiaWxpdHkucGFyZW50LCBjYXBhYmlsaXR5LndpbmRvd0lkKSB8fCBkaXNjb25uZWN0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIG5hdGl2ZSBjYXBhYmlsaXR5Jyk7XG4gICAgICAgICAgICAgICAgY29uc3Qga2V5ID0gbmF0aXZlUnVudGltZVNlc3Npb25LZXkoY2FwYWJpbGl0eS5wYXJlbnQsIGNhcGFiaWxpdHkub3JpZ2luKTtcbiAgICAgICAgICAgICAgICBpZiAobmF0aXZlUnVudGltZVNlc3Npb25zLmhhcyhrZXkpKSB0aHJvdyBFcnJvcignUnVudGltZSBhbHJlYWR5IGJvdW5kJyk7XG4gICAgICAgICAgICAgICAgc2Vzc2lvbiA9IHsgLi4uY2FwYWJpbGl0eSwga2V5LCBzZW5kZXIsIHBvcnQsIHBlbmRpbmc6IG5ldyBNYXAoKSwgc2VxdWVuY2U6IDAsIGNsb3NlZDogZmFsc2UgfTtcbiAgICAgICAgICAgICAgICBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5zZXQoc2VuZGVyLCBzZXNzaW9uKTsgbmF0aXZlUnVudGltZVNlc3Npb25zLnNldChrZXksIHNlc3Npb24pO1xuICAgICAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2UoeyByZWFkeTogdHJ1ZSB9KTsgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKE51bWJlci5pc1NhZmVJbnRlZ2VyKHBhY2tldD8uYW5zd2VyKSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBlbmRpbmcgPSBzZXNzaW9uLnBlbmRpbmcuZ2V0KHBhY2tldC5hbnN3ZXIpO1xuICAgICAgICAgICAgICAgIGlmIChwZW5kaW5nKSB7IHNlc3Npb24ucGVuZGluZy5kZWxldGUocGFja2V0LmFuc3dlcik7IGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVyKTsgcGVuZGluZy5yZXNvbHZlKHBhY2tldC5yZXBseSk7IH1cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKHBhY2tldD8uaWQpIHx8IHBhY2tldC5pZCA8IDEgfHwgIXBhY2tldC5tZXNzYWdlIHx8IHNlc3Npb24uY2xvc2VkKSB0aHJvdyBFcnJvcignSW52YWxpZCBuYXRpdmUgcGFja2V0Jyk7XG4gICAgICAgICAgICAvLyBDaGVjayB0aGUgcGFyZW50IGlzIHN0aWxsIGEgbmF0aXZlIGRvY3VtZW50IGluIHRoZSBib3VuZCB3aW5kb3cuXG4gICAgICAgICAgICBpZiAoIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2Vzc2lvbi5wYXJlbnQsIHNlc3Npb24ud2luZG93SWQpIHx8IHNlc3Npb24uY2xvc2VkKSB0aHJvdyBFcnJvcignTmF0aXZlIHBhcmVudCBjbG9zZWQnKTtcbiAgICAgICAgICAgIGxldCBhbnN3ZXJlZCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc3QgaGFuZGxlZCA9IGV4dGVuc2lvbkhhbmRsZU1lc3NhZ2UocGFja2V0Lm1lc3NhZ2UsIHNlbmRlciwgcmVwbHkgPT4ge1xuICAgICAgICAgICAgICAgIGFuc3dlcmVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoIXNlc3Npb24uY2xvc2VkKSBwb3J0LnBvc3RNZXNzYWdlKHsgaWQ6IHBhY2tldC5pZCwgcmVwbHkgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmICghaGFuZGxlZCAmJiAhYW5zd2VyZWQpIHBvcnQucG9zdE1lc3NhZ2UoeyBpZDogcGFja2V0LmlkLCByZXBseTogeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC30LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjycgfSB9KTtcbiAgICAgICAgfSBjYXRjaCB7IGNsb3NlKCk7IHRyeSB7IHBvcnQuZGlzY29ubmVjdCgpOyB9IGNhdGNoIHsgLyogQWxyZWFkeSBnb25lLiAqLyB9IH1cbiAgICB9KTtcbn0pO1xuIiwiLy8gRXhhY3QtcGFuZWwgcHJpdmF0ZSBwb3J0OiBuZXZlciBicm9hZGNhc3QgaGlzdG9yeSBhbmQgbmV2ZXIgcGVyc2lzdCBpdC5cbmNvbnN0IHNpZGViYXJIaXN0b3J5T3duZXJzID0gbmV3IE1hcCgpO1xuY29uc3QgU0lERUJBUl9DSEFUX01PREVTID0gbmV3IFNldChbJ2NoZWNrSGF0aWtvJywgJ2NoZWNrSGF0aWtvQm9udXNlcycsICdjYWxjdWxhdG9yJyxcbiAgICAnY2FsY3VsYXRvcl9yZXZlcnNlJywgJ2NhbGN1bGF0b3JfZGlzY291bnQnLCAnY2FsY3VsYXRvcl9zaW1wbGUnXSk7XG5mdW5jdGlvbiBzaWRlYmFySGlzdG9yeVRhcmdldChzZW5kZXIpIHtcbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICduYXRpdmU6JyArIHNlbmRlci51cmw7XG4gICAgaWYgKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHJldHVybiAndGFiOicgKyBzZW5kZXIudGFiLmlkO1xuICAgIHJldHVybiBudWxsO1xufVxuZnVuY3Rpb24gc2lkZWJhckhpc3RvcnlCaW5kKHBhcmVudCwgdGFyZ2V0LCBkb2N1bWVudFRva2VuKSB7XG4gICAgY29uc3Qgb3duZXIgPSBzaWRlYmFySGlzdG9yeU93bmVycy5nZXQocGFyZW50LnVybCk7XG4gICAgaWYgKCFvd25lciB8fCAhdGFyZ2V0IHx8IHR5cGVvZiBkb2N1bWVudFRva2VuICE9PSAnc3RyaW5nJykgcmV0dXJuO1xuICAgIG93bmVyLnRhcmdldHMuc2V0KHRhcmdldCwgZG9jdW1lbnRUb2tlbik7XG59XG5jaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIocG9ydCA9PiB7XG4gICAgaWYgKHBvcnQubmFtZSAhPT0gJ21lbWNoYXQtc2lkZWJhci1oaXN0b3J5JykgcmV0dXJuO1xuICAgIGNvbnN0IHNlbmRlciA9IHBvcnQuc2VuZGVyO1xuICAgIGxldCBvd25lciwgZGlzY29ubmVjdGVkID0gZmFsc2UsIGJpbmRpbmcgPSBmYWxzZTtcbiAgICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKCFvd25lcikgcmV0dXJuO1xuICAgICAgICBpZiAoc2lkZWJhckhpc3RvcnlPd25lcnMuZ2V0KHNlbmRlci51cmwpID09PSBvd25lcikgc2lkZWJhckhpc3RvcnlPd25lcnMuZGVsZXRlKHNlbmRlci51cmwpO1xuICAgICAgICBmb3IgKGNvbnN0IHBlbmRpbmcgb2Ygb3duZXIucGVuZGluZy52YWx1ZXMoKSkgeyBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7IHBlbmRpbmcucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY2xvc2VkOiB0cnVlIH0pOyB9XG4gICAgICAgIG93bmVyLnBlbmRpbmcuY2xlYXIoKTsgb3duZXIudGFyZ2V0cy5jbGVhcigpO1xuICAgIH07XG4gICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoY2xvc2UpO1xuICAgIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKGFzeW5jIG1lc3NhZ2UgPT4ge1xuICAgICAgICBpZiAoZGlzY29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIW93bmVyKSB7XG4gICAgICAgICAgICAgICAgaWYgKGJpbmRpbmcgfHwgbWVzc2FnZT8udHlwZSAhPT0gJ2JpbmQnKSB0aHJvdyBFcnJvcignSW52YWxpZCBoaXN0b3J5IGJpbmRpbmcnKTtcbiAgICAgICAgICAgICAgICBiaW5kaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkKSB8fCBkaXNjb25uZWN0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIHBhbmVsJyk7XG4gICAgICAgICAgICAgICAgLy8gQSByZXBsYWNlbWVudCBwb3J0IG1heSBub3QgaGlqYWNrIGFuIGV4aXN0aW5nIGNvbnZlcnNhdGlvbi5cbiAgICAgICAgICAgICAgICBpZiAoc2lkZWJhckhpc3RvcnlPd25lcnMuaGFzKHNlbmRlci51cmwpKSB0aHJvdyBFcnJvcignQWxyZWFkeSBib3VuZCcpO1xuICAgICAgICAgICAgICAgIG93bmVyID0geyBpZDogY3J5cHRvLnJhbmRvbVVVSUQoKSwgc2VuZGVyLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCwgcG9ydCwgdGFyZ2V0czogbmV3IE1hcCgpLCBwZW5kaW5nOiBuZXcgTWFwKCkgfTtcbiAgICAgICAgICAgICAgICBzaWRlYmFySGlzdG9yeU93bmVycy5zZXQoc2VuZGVyLnVybCwgb3duZXIpO1xuICAgICAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2UoeyByZWFkeTogdHJ1ZSwgb3duZXI6IG93bmVyLmlkIH0pOyByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobWVzc2FnZT8udHlwZSAhPT0gJ2FjaycgfHwgdHlwZW9mIG1lc3NhZ2UuaWQgIT09ICdzdHJpbmcnKSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBwZW5kaW5nID0gb3duZXIucGVuZGluZy5nZXQobWVzc2FnZS5pZCk7XG4gICAgICAgICAgICBpZiAocGVuZGluZykgeyBvd25lci5wZW5kaW5nLmRlbGV0ZShtZXNzYWdlLmlkKTsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlc29sdmUoeyBvazogdHJ1ZSB9KTsgfVxuICAgICAgICB9IGNhdGNoIHsgY2xvc2UoKTsgdHJ5IHsgcG9ydC5kaXNjb25uZWN0KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGNsb3NlZCAqLyB9IH1cbiAgICB9KTtcbn0pO1xuZnVuY3Rpb24gc2lkZWJhckhpc3RvcnlNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgcmVwbHkpIHtcbiAgICBpZiAobWVzc2FnZT8udHlwZSAhPT0gJ21lbWNoYXQ6Y2hhdC1ldmVudCcpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBydW4gPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IHNpZGViYXJIaXN0b3J5VGFyZ2V0KHNlbmRlcik7XG4gICAgICAgIGNvbnN0IG93bmVyID0gWy4uLnNpZGViYXJIaXN0b3J5T3duZXJzLnZhbHVlcygpXS5maW5kKHZhbHVlID0+IHZhbHVlLmlkID09PSBtZXNzYWdlLm93bmVyKTtcbiAgICAgICAgaWYgKCFvd25lcikgcmV0dXJuIHsgb2s6IGZhbHNlLCBjbG9zZWQ6IHRydWUgfTtcbiAgICAgICAgaWYgKCF0YXJnZXQgfHwgb3duZXIudGFyZ2V0cy5nZXQodGFyZ2V0KSAhPT0gbWVzc2FnZS5kb2N1bWVudFRva2VuIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KG93bmVyLnNlbmRlciwgb3duZXIud2luZG93SWQpKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgaWYgKCFTSURFQkFSX0NIQVRfTU9ERVMuaGFzKG1lc3NhZ2UuYWN0aW9uKSB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5lcG9jaCkgfHwgbWVzc2FnZS5lcG9jaCA8IDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmlkICE9PSAnc3RyaW5nJyB8fCAhL15bYS1mMC05LV17MzZ9JC8udGVzdChtZXNzYWdlLmlkKVxuICAgICAgICAgICAgfHwgIVsnYXBwZW5kJywgJ2NsZWFyJ10uaW5jbHVkZXMobWVzc2FnZS5vcGVyYXRpb24pKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgaWYgKG1lc3NhZ2Uub3BlcmF0aW9uID09PSAnYXBwZW5kJykge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBtZXNzYWdlLmVudHJ5O1xuICAgICAgICAgICAgaWYgKCFlbnRyeSB8fCBlbnRyeS5hY3Rpb24gIT09IG1lc3NhZ2UuYWN0aW9uIHx8ICFbJ3VzZXInLCAnYm90JywgJ3N5c3RlbSddLmluY2x1ZGVzKGVudHJ5LnNlbmRlcilcbiAgICAgICAgICAgICAgICB8fCAhWydtZXNzYWdlJywgJ2Vtb2ppJywgJ3RpbWVzdGFtcCcsICdxdWVyeSddLmV2ZXJ5KGtleSA9PiB0eXBlb2YgZW50cnlba2V5XSA9PT0gJ3N0cmluZycpXG4gICAgICAgICAgICAgICAgfHwgSlNPTi5zdHJpbmdpZnkoZW50cnkpLmxlbmd0aCA+IDEwMjQgKiAxMDI0KSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob3duZXIucGVuZGluZy5oYXMobWVzc2FnZS5pZCkgfHwgb3duZXIucGVuZGluZy5zaXplID49IDEyOCkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IG93bmVyLnBlbmRpbmcuZGVsZXRlKG1lc3NhZ2UuaWQpOyByZXNvbHZlKHsgb2s6IGZhbHNlIH0pOyB9LCA1MDAwKTtcbiAgICAgICAgICAgIG93bmVyLnBlbmRpbmcuc2V0KG1lc3NhZ2UuaWQsIHsgcmVzb2x2ZSwgdGltZXIgfSk7XG4gICAgICAgICAgICB0cnkgeyBvd25lci5wb3J0LnBvc3RNZXNzYWdlKHsgZXZlbnQ6IHsgaWQ6IG1lc3NhZ2UuaWQsIG9wZXJhdGlvbjogbWVzc2FnZS5vcGVyYXRpb24sXG4gICAgICAgICAgICAgICAgZXBvY2g6IG1lc3NhZ2UuZXBvY2gsIGFjdGlvbjogbWVzc2FnZS5hY3Rpb24sIGVudHJ5OiBtZXNzYWdlLmVudHJ5IH0gfSk7IH1cbiAgICAgICAgICAgIGNhdGNoIHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgb3duZXIucGVuZGluZy5kZWxldGUobWVzc2FnZS5pZCk7IHJlc29sdmUoeyBvazogZmFsc2UsIGNsb3NlZDogdHJ1ZSB9KTsgfVxuICAgICAgICB9KTtcbiAgICB9O1xuICAgIHJ1bigpLnRoZW4ocmVwbHksICgpID0+IHJlcGx5KHsgb2s6IGZhbHNlIH0pKTsgcmV0dXJuIHRydWU7XG59XG4iLCIvLyBQcml2YXRlIG5hdGl2ZS12aWV3IGNoYW5uZWwuIE5ldmVyIGJyb2FkY2FzdCB2aWV3IGRhdGE6IHJlcGxpZXMgZ28gb25seSB0byB0aGVcbi8vIGV4YWN0IHJlcXVlc3RpbmcgbmF0aXZlIHBhbmVsLiBTaXRlL2FjY291bnQgc3RhdGUgc3RheXMgaW4gaXRzIGNvbnRlbnQgd29ybGQuXG5jb25zdCBTSURFQkFSX0ZFQVRVUkVTID0gT2JqZWN0LmZyZWV6ZShbJ2NoZWNrSGF0aWtvJywgJ2NoZWNrSGF0aWtvQm9udXNlcycsICd0b2RheScsICd0b21vcnJvdycsXG4gICAgJ2NhbGN1bGF0b3InLCAnY2FsY3VsYXRvcl9yZXZlcnNlJywgJ2NhbGN1bGF0b3JfZGlzY291bnQnLCAnY2FsY3VsYXRvcl9zaW1wbGUnLCAnaGFja2VyJywgJ3NldHRpbmdzJ10pO1xuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpIHtcbiAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KTtcbiAgICBpZiAoIXN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ3Vuc3VwcG9ydGVkJyB9O1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcgJiYgdGFiLmlkICE9PSBtZXNzYWdlLnRhYklkKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgY29uc3QgY29tbWFuZCA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1zdGF0dXMnXG4gICAgICAgID8geyB0eXBlOiAnbWVtY2hhdDpmZWF0dXJlLXN0YXR1cycgfSA6IHsgdHlwZTogJ21lbWNoYXQ6b3Blbi1mZWF0dXJlJywgZmVhdHVyZTogbWVzc2FnZS5mZWF0dXJlIH07XG4gICAgbGV0IHJlcGx5O1xuICAgIHRyeSB7IHJlcGx5ID0gYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCBjb21tYW5kLCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTsgfVxuICAgIGlmICghcmVwbHk/Lm9rKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogWydzdG9yYWdlJywgJ2NvbmZsaWN0J10uaW5jbHVkZXMocmVwbHk/LnJlYXNvbikgPyByZXBseS5yZWFzb24gOiAnZmFpbGVkJyB9O1xuICAgIC8vIE5ldmVyIGZvcndhcmQgYW4gYXJiaXRyYXJ5IGNvbnRlbnQgcmVwbHksIHRhYiB0aXRsZSwgVVJMIHBhdGgvcXVlcnkgb3IgcGVyc2lzdGVkIGRhdGEuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRhYklkOiB0YWIuaWQsIGhvc3Q6IG5ldyBVUkwodGFiLnVybCkuaG9zdG5hbWUgfTtcbn1cbi8vIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlIGhhcyBubyB0aW1lb3V0IG9mIGl0cyBvd246IGEgZnJvemVuIGJhY2tncm91bmQgdGFiXG4vLyAoQ2hyb21lIEZyZWV6aW5nKSBvciBhIHN0dWNrIGNvbnRlbnQgaGFuZGxlciB3b3VsZCBob2xkIHRoZSBwYW5lbCB1bnRpbCBpdHNcbi8vIG93biA4IHMgZGVhZGxpbmUgd2l0aCBhIHZhZ3VlIHRpbWVvdXQuIEFuc3dlciB0aGUgcGFuZWwgZmlyc3QgaW5zdGVhZC5cbmxldCBTSURFQkFSX1ZJRVdfREVBRExJTkVfTVMgPSA0MDAwO1xuZnVuY3Rpb24gc2lkZWJhclNlbmRUb1RhYih0YWJJZCwgbWVzc2FnZSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoeyBvazogZmFsc2UsIHJlYXNvbjogJ3RpbWVvdXQnIH0pLCBTSURFQkFSX1ZJRVdfREVBRExJTkVfTVMpO1xuICAgICAgICBsZXQgc2VudDtcbiAgICAgICAgdHJ5IHsgc2VudCA9IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCBtZXNzYWdlLCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICAgICAgY2F0Y2ggeyBjbGVhclRpbWVvdXQodGltZXIpOyByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9KTsgcmV0dXJuOyB9XG4gICAgICAgIC8vIFRoZXJlIGlzIG5vIEFib3J0Q29udHJvbGxlciBmb3Igc2VuZE1lc3NhZ2UuIFRoZSBsb3NpbmcgcHJvbWlzZSBzdGlsbFxuICAgICAgICAvLyBzZXR0bGVzIGxhdGVyLCBzbyBib3RoIGEgbGF0ZSByZXBseSBhbmQgYSBsYXRlIHJlamVjdGlvbiBhcmUgYWJzb3JiZWQuXG4gICAgICAgIFByb21pc2UucmVzb2x2ZShzZW50KS50aGVuKHJlcGx5ID0+IHJlc29sdmUocmVwbHkpLCAoKSA9PiByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9KSlcbiAgICAgICAgICAgIC5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lcikpO1xuICAgIH0pO1xufVxuLy8gQSBwYW5lbCdzIHRhcmdldCBpcyBjYXB0dXJlZCBvbmNlIGFuZCB0aGVuIHJlYWQsIG5ldmVyIHJlY29tcHV0ZWQgZnJvbSB0aGVcbi8vIGxpdmUgdGFiIFVSTDoge3RhYklkLCB3aW5kb3dJZCwgb3JpZ2luLCBzdXBwb3J0ZWR9LiBUaGUgb3JpZ2luIChhbmQgd2l0aCBpdFxuLy8gdGhlIHByaXZhdGUgYnVja2V0KSB0aGVyZWZvcmUgc3RheXMgcHV0IHdoaWxlIHRoZSBib3VuZCB0YWIgbmF2aWdhdGVzLCBsb3Nlc1xuLy8gZm9jdXMgb3IgaXMgcmVzdG9yZWQuIE9ubHkgYW4gZXhwbGljaXQgKHJlKWJpbmQgKG5vIHRhYklkKSBvciBhIHRhYi93aW5kb3dcbi8vIG1pc21hdGNoIHJld3JpdGVzIGl0OyBsaXZlbmVzcyBpcyBjaGVja2VkIHNlcGFyYXRlbHkuXG4vLyBNVjMga2lsbHMgdGhlIHdvcmtlciBhZnRlciBpZGxlIHRpbWUsIHNvIHRoZSBNYXAgYWxvbmUgd291bGQgcmVzdG9yZSBmcm9tIHRoZVxuLy8gZ2xvYmFsIGxhc3Qtb3JpZ2luIGd1ZXNzIG9uIHdha2UuIEEgY29weSBwZXIgcGFuZWwgZG9jdW1lbnQgbGl2ZXMgaW5cbi8vIGNocm9tZS5zdG9yYWdlLnNlc3Npb24gKGJyb3dzZXIgbGlmZXRpbWUsIG5ldmVyIGRpc2spIGFuZCBpcyByZWFkIGJhY2sgZmlyc3QuXG5jb25zdCBTSURFQkFSX0JJTkRJTkdfS0VZID0gJ21lbWNoYXRTaWRlYmFyQmluZGluZ192MSc7XG5jb25zdCBTSURFQkFSX0JJTkRJTkdfTUFYX0FHRV9NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XG5jb25zdCBzaWRlYmFyQmluZGluZ3MgPSBuZXcgTWFwKCk7XG5sZXQgc2lkZWJhckJpbmRpbmdSZWNvcmRzID0gbnVsbDtcbmxldCBzaWRlYmFyQmluZGluZ0NoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyQmluZGluZ0xvYWQoKSB7XG4gICAgaWYgKHNpZGViYXJCaW5kaW5nUmVjb3JkcykgcmV0dXJuIHNpZGViYXJCaW5kaW5nUmVjb3JkcztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChTSURFQkFSX0JJTkRJTkdfS0VZKSlbU0lERUJBUl9CSU5ESU5HX0tFWV07XG4gICAgICAgIHNpZGViYXJCaW5kaW5nUmVjb3JkcyA9IHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkoc2F2ZWQpID8gc2F2ZWQgOiB7fTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdlcnJvcicsIHNjb3BlOiAnc2lkZWJhcicsIGV2ZW50OiAnYmluZGluZy1zdG9yYWdlJywgZGV0YWlsOiB7IHJlYXNvbjogJ3JlYWQnIH0gfSwgJ3dvcmtlcicpO1xuICAgICAgICBzaWRlYmFyQmluZGluZ1JlY29yZHMgPSB7fTtcbiAgICB9XG4gICAgcmV0dXJuIHNpZGViYXJCaW5kaW5nUmVjb3Jkcztcbn1cbmZ1bmN0aW9uIHNpZGViYXJCaW5kaW5nVmFsaWQoYmluZGluZykge1xuICAgIHJldHVybiAhIWJpbmRpbmcgJiYgTnVtYmVyLmlzSW50ZWdlcihiaW5kaW5nLnRhYklkKSAmJiBiaW5kaW5nLnRhYklkID49IDBcbiAgICAgICAgJiYgTnVtYmVyLmlzSW50ZWdlcihiaW5kaW5nLndpbmRvd0lkKSAmJiBiaW5kaW5nLndpbmRvd0lkID49IDBcbiAgICAgICAgJiYgdHlwZW9mIGJpbmRpbmcub3JpZ2luID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgYmluZGluZy5zdXBwb3J0ZWQgPT09ICdib29sZWFuJztcbn1cbi8vIE9uZSBvd25lciwgb25lIGFzc2lnbm1lbnQ6IG9ubHkgYW4gZXhwbGljaXQgcmViaW5kIG9yIGEgcG9zdC1zbGVlcCByZWJ1aWxkXG4vLyB3cml0ZXMuIFJld3JpdGluZyBieSBwYW5lbCBVUkwgYm91bmRzIHRoZSByZWNvcmQgc2V0OyBzdGFsZSBlbnRyaWVzIGFyZVxuLy8gZHJvcHBlZCBoZXJlIGluc3RlYWQgb2YgYnkgYSBzZXBhcmF0ZSBjb2xsZWN0b3IuXG5mdW5jdGlvbiBzaWRlYmFyQmluZGluZ1NhdmUocGFuZWxVcmwsIGJpbmRpbmcpIHtcbiAgICBjb25zdCB3b3JrID0gc2lkZWJhckJpbmRpbmdDaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IHNpZGViYXJCaW5kaW5nTG9hZCgpO1xuICAgICAgICBjb25zdCBjdXRvZmYgPSBEYXRlLm5vdygpIC0gU0lERUJBUl9CSU5ESU5HX01BWF9BR0VfTVM7XG4gICAgICAgIGNvbnN0IG5leHQgPSB7fTtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkcykpIHtcbiAgICAgICAgICAgIGlmIChrZXkgIT09IHBhbmVsVXJsICYmIHNpZGViYXJCaW5kaW5nVmFsaWQodmFsdWUpICYmIHR5cGVvZiB2YWx1ZS5hdCA9PT0gJ251bWJlcicgJiYgdmFsdWUuYXQgPj0gY3V0b2ZmKSBuZXh0W2tleV0gPSB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBuZXh0W3BhbmVsVXJsXSA9IHsgdGFiSWQ6IGJpbmRpbmcudGFiSWQsIHdpbmRvd0lkOiBiaW5kaW5nLndpbmRvd0lkLCBvcmlnaW46IGJpbmRpbmcub3JpZ2luLFxuICAgICAgICAgICAgc3VwcG9ydGVkOiBiaW5kaW5nLnN1cHBvcnRlZCwgYXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbU0lERUJBUl9CSU5ESU5HX0tFWV06IG5leHQgfSk7XG4gICAgICAgIHNpZGViYXJCaW5kaW5nUmVjb3JkcyA9IG5leHQ7XG4gICAgfSk7XG4gICAgc2lkZWJhckJpbmRpbmdDaGFpbiA9IHdvcmsuY2F0Y2goKCkgPT4ge30pO1xuICAgIC8vIEEgZmFpbGVkIHdyaXRlIGZhbGxzIGJhY2sgdG8gdGhlIGluLW1lbW9yeSBiaW5kaW5nIGZvciB0aGlzIHdvcmtlcidzIGxpZmUuXG4gICAgcmV0dXJuIHdvcmsuY2F0Y2goKCkgPT4ge1xuICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICdiaW5kaW5nLXN0b3JhZ2UnLCBkZXRhaWw6IHsgcmVhc29uOiAnd3JpdGUnIH0gfSwgJ3dvcmtlcicpO1xuICAgIH0pO1xufVxuZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdMb2coYmluZGluZywgc291cmNlKSB7XG4gICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICdpbmZvJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICdiaW5kaW5nLWNyZWF0ZWQnLCBkZXRhaWw6IHtcbiAgICAgICAgdGFiSWQ6IGJpbmRpbmcudGFiSWQsIG9yaWdpbjogYmluZGluZy5vcmlnaW4sIHN1cHBvcnRlZDogYmluZGluZy5zdXBwb3J0ZWQsIHNvdXJjZVxuICAgIH0gfSwgJ3dvcmtlcicpO1xufVxuZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdNaXNtYXRjaChleHBlY3RlZCwgYWN0dWFsKSB7XG4gICAgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6ICd3YXJuJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICdiaW5kaW5nLW1pc21hdGNoJywgZGV0YWlsOiB7XG4gICAgICAgIGV4cGVjdGVkOiB7IHRhYklkOiBleHBlY3RlZC50YWJJZCwgb3JpZ2luOiBleHBlY3RlZC5vcmlnaW4gfSxcbiAgICAgICAgYWN0dWFsOiB7IHRhYklkOiBhY3R1YWwudGFiSWQsIHdpbmRvd0lkOiBhY3R1YWwud2luZG93SWQgfVxuICAgIH0gfSwgJ3dvcmtlcicpO1xufVxuZnVuY3Rpb24gc2lkZWJhckRlYnVnSG9zdChvcmlnaW4pIHtcbiAgICB0cnkgeyByZXR1cm4gdHlwZW9mIG9yaWdpbiA9PT0gJ3N0cmluZycgPyBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUgOiBudWxsOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxufVxuLy8gQSBmYWlsZWQgdmlldyBpcyB0aGUgc2lnbmFsIGEgcGFuZWwtb25seSByZXBvcnQgdXN1YWxseSBsYWNrczoga2VlcCB0aGUgZXhhY3Rcbi8vIHJlYXNvbiBhbmQgd2hpY2ggY2FwdHVyZWQgYmluZGluZyBwcm9kdWNlZCBpdCwgbmV2ZXIgcGFnZSBjb250ZW50LlxuZnVuY3Rpb24gc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCByZWFzb24pIHtcbiAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdzaWRlYmFyJywgZXZlbnQ6ICd2aWV3LWZhaWxlZCcsIGRldGFpbDoge1xuICAgICAgICByZWFzb24sIHRhYklkOiBOdW1iZXIuaXNJbnRlZ2VyKGJpbmRpbmc/LnRhYklkKSA/IGJpbmRpbmcudGFiSWQgOiAoTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSA/IG1lc3NhZ2UudGFiSWQgOiBudWxsKSxcbiAgICAgICAgc3VwcG9ydGVkOiBiaW5kaW5nPy5zdXBwb3J0ZWQgPT09IHRydWUsIGhvc3Q6IHNpZGViYXJEZWJ1Z0hvc3QoYmluZGluZz8ub3JpZ2luKVxuICAgIH0gfSwgJ3dvcmtlcicpO1xufVxuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJpbmRpbmdGb3IobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3QgY3VycmVudCA9IHNpZGViYXJCaW5kaW5ncy5nZXQoc2VuZGVyLnVybCk7XG4gICAgaWYgKG1lc3NhZ2UudGFiSWQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBbYWN0aXZlXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KTtcbiAgICAgICAgaWYgKCFhY3RpdmUpIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgIGNvbnN0IHN1cHBvcnRlZCA9IHN1cHBvcnRlZEFjdGlvblRhYihhY3RpdmUpO1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBzdXBwb3J0ZWQgPyBuZXcgVVJMKGFjdGl2ZS51cmwpLm9yaWdpbiA6IGF3YWl0IG5hdGl2ZUxhc3RPcmlnaW4oKTtcbiAgICAgICAgY29uc3QgYmluZGluZyA9IHsgdGFiSWQ6IGFjdGl2ZS5pZCwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQsIG9yaWdpbiwgc3VwcG9ydGVkIH07XG4gICAgICAgIHNpZGViYXJCaW5kaW5ncy5zZXQoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsICdleHBsaWNpdCcpO1xuICAgICAgICBhd2FpdCBzaWRlYmFyQmluZGluZ1NhdmUoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHJldHVybiB7IGJpbmRpbmcgfTtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnQpIHtcbiAgICAgICAgLy8gVGhlIGJpbmRpbmcgaXMgaW1tdXRhYmxlIGZvciBpdHMgbGlmZTsgYSBwb2xsIG5hbWluZyBhbm90aGVyIHRhYiBpcyBhXG4gICAgICAgIC8vIHN0YWxlIG9yIGZvcmVpZ24gcmVxdWVzdCwgbm90IGEgcmViaW5kLlxuICAgICAgICBpZiAoY3VycmVudC50YWJJZCAhPT0gbWVzc2FnZS50YWJJZCB8fCBjdXJyZW50LndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkKSB7XG4gICAgICAgICAgICBzaWRlYmFyQmluZGluZ01pc21hdGNoKGN1cnJlbnQsIG1lc3NhZ2UpO1xuICAgICAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBiaW5kaW5nOiBjdXJyZW50IH07XG4gICAgfVxuICAgIC8vIFRoZSB3b3JrZXIgc2xlcHQgb3IgcmVzdGFydGVkLiBSZWFkIHRoZSBwYW5lbCdzIG93biBjYXB0dXJlZCByZWNvcmQgZnJvbVxuICAgIC8vIHNlc3Npb24gc3RvcmFnZSBmaXJzdDogdGhhdCBjb3B5IGlzIHRoZSBmaXggZm9yIGEgc2lsZW50bHkgbW92aW5nIHByaXZhdGVcbiAgICAvLyBidWNrZXQuIE9ubHkgYSBwYW5lbCB3aXRob3V0IGFueSByZWNvcmQgaXMgcmVidWlsdCBmcm9tIGxpdmUgdGFiIHN0YXRlLlxuICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IHNpZGViYXJCaW5kaW5nTG9hZCgpKVtzZW5kZXIudXJsXTtcbiAgICBpZiAoc2lkZWJhckJpbmRpbmdWYWxpZChzYXZlZCkgJiYgc2F2ZWQud2luZG93SWQgPT09IG1lc3NhZ2Uud2luZG93SWQpIHtcbiAgICAgICAgaWYgKHNhdmVkLnRhYklkICE9PSBtZXNzYWdlLnRhYklkKSB7XG4gICAgICAgICAgICBzaWRlYmFyQmluZGluZ01pc21hdGNoKHNhdmVkLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmluZGluZyA9IHsgdGFiSWQ6IHNhdmVkLnRhYklkLCB3aW5kb3dJZDogc2F2ZWQud2luZG93SWQsIG9yaWdpbjogc2F2ZWQub3JpZ2luLCBzdXBwb3J0ZWQ6IHNhdmVkLnN1cHBvcnRlZCB9O1xuICAgICAgICBzaWRlYmFyQmluZGluZ3Muc2V0KHNlbmRlci51cmwsIGJpbmRpbmcpO1xuICAgICAgICBzaWRlYmFyQmluZGluZ0xvZyhiaW5kaW5nLCAnc2Vzc2lvbicpO1xuICAgICAgICBhd2FpdCBzaWRlYmFyQmluZGluZ1NhdmUoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgICAgIHJldHVybiB7IGJpbmRpbmcgfTtcbiAgICB9XG4gICAgbGV0IHRhYjtcbiAgICB0cnkgeyB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQobWVzc2FnZS50YWJJZCk7IH0gY2F0Y2gge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIG51bGwsICdjbG9zZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2xvc2VkJyB9O1xuICAgIH1cbiAgICBpZiAodGFiLndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkKSB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgeyB0YWJJZDogdGFiLmlkLCB3aW5kb3dJZDogdGFiLndpbmRvd0lkLCBvcmlnaW46IG51bGwsIHN1cHBvcnRlZDogZmFsc2UgfSwgJ2NoYW5nZWQnKTtcbiAgICAgICAgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICB9XG4gICAgY29uc3Qgc3VwcG9ydGVkID0gc3VwcG9ydGVkQWN0aW9uVGFiKHRhYik7XG4gICAgY29uc3Qgb3JpZ2luID0gc3VwcG9ydGVkID8gbmV3IFVSTCh0YWIudXJsKS5vcmlnaW4gOiBhd2FpdCBuYXRpdmVMYXN0T3JpZ2luKCk7XG4gICAgY29uc3QgYmluZGluZyA9IHsgdGFiSWQ6IHRhYi5pZCwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQsIG9yaWdpbiwgc3VwcG9ydGVkIH07XG4gICAgc2lkZWJhckJpbmRpbmdzLnNldChzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAvLyBBIHJlY292ZXJlZCBiaW5kaW5nIHdhcyByZWJ1aWx0IGFmdGVyIHdvcmtlciBzdXNwZW5zaW9uIHdpdGhvdXQgYW55IHNhdmVkXG4gICAgLy8gcmVjb3JkOyB1bmxpa2UgYW4gZXhwbGljaXQgc2VsZWN0aW9uIGl0IHJlLXJlYWRzIGN1cnJlbnQgdGFiIHN0YXRlLCB3aGljaFxuICAgIC8vIGlzIHRoZSByaXNreSBjYXNlIGFuZCBzaG91bGQgc3RheSByYXJlLlxuICAgIHNpZGViYXJCaW5kaW5nTG9nKGJpbmRpbmcsICdyZWNvdmVyZWQnKTtcbiAgICBhd2FpdCBzaWRlYmFyQmluZGluZ1NhdmUoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgcmV0dXJuIHsgYmluZGluZyB9O1xufVxuLy8gQXZhaWxhYmlsaXR5IG9ubHk6IHRoZSB0YWIgZXhpc3RzLCBiZWxvbmdzIHRvIHRoZSBwYW5lbCdzIHdpbmRvdyBhbmQgaXMgbm90XG4vLyBkaXNjYXJkZWQvdW5sb2FkZWQuIFdoZXRoZXIgdGhlIHBhZ2UgaXMgYSBzdXBwb3J0ZWQgc2l0ZSBpcyBjYXB0dXJlZCBwb2xpY3kgaW5cbi8vIHRoZSBiaW5kaW5nLCBub3QgYSBsaXZlbmVzcyB0ZXN0LlxuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJvdW5kVGFiKG1lc3NhZ2UsIGJpbmRpbmcpIHtcbiAgICBsZXQgdGFiO1xuICAgIHRyeSB7IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChiaW5kaW5nLnRhYklkKTsgfSBjYXRjaCB7IHJldHVybiB7IHJlYXNvbjogJ2Nsb3NlZCcgfTsgfVxuICAgIGlmICh0YWIud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQpIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgaWYgKHRhYi5zdGF0dXMgPT09ICd1bmxvYWRlZCcgfHwgdGFiLmRpc2NhcmRlZCA9PT0gdHJ1ZSkgcmV0dXJuIHsgcmVhc29uOiAnbWlzc2luZycgfTtcbiAgICByZXR1cm4geyB0YWIgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJWaWV3RGlzcGF0Y2gobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBzaWRlYmFyQmluZGluZ0ZvcihtZXNzYWdlLCBzZW5kZXIpO1xuICAgIGlmICghcmVzb2x2ZWQuYmluZGluZykge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIG51bGwsIHJlc29sdmVkLnJlYXNvbiB8fCAnY2hhbmdlZCcpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogcmVzb2x2ZWQucmVhc29uIHx8ICdjaGFuZ2VkJyB9O1xuICAgIH1cbiAgICBjb25zdCBiaW5kaW5nID0gcmVzb2x2ZWQuYmluZGluZztcbiAgICBjb25zdCBib3VuZCA9IGF3YWl0IHNpZGViYXJCb3VuZFRhYihtZXNzYWdlLCBiaW5kaW5nKTtcbiAgICBpZiAoIWJvdW5kLnRhYikge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsIGJvdW5kLnJlYXNvbik7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBib3VuZC5yZWFzb24gfTtcbiAgICB9XG4gICAgY29uc3QgdGFiID0gYm91bmQudGFiO1xuICAgIGNvbnN0IG9yaWdpbiA9IGJpbmRpbmcub3JpZ2luO1xuICAgIC8vIEEgY2FwdHVyZWQgc3VwcG9ydGVkIGJpbmRpbmcgd2hvc2UgcGFnZSBoYXMgc2luY2UgbGVmdCB0aGUgc3VwcG9ydGVkIG9yaWdpblxuICAgIC8vIGxvc3QgaXRzIGNvbnRlbnQgc2NyaXB0LiBOZXZlciBzaWxlbnRseSBtb3ZlIHRvIHRoZSBmYWxsYmFjayBydW50aW1lL2J1Y2tldDpcbiAgICAvLyByZXBvcnQgdGhlIHRyYW5zaWVudCBtaXNzaW5nIHN0YXRlIHNvIHRoZSBwYW5lbCBrZWVwcyBpdHMgdmlldyBhbmQgZ29lcyBpbmVydFxuICAgIC8vIHVudGlsIHRoZSB1c2VyIGV4cGxpY2l0bHkgcmViaW5kcy5cbiAgICBpZiAoYmluZGluZy5zdXBwb3J0ZWQgJiYgKCFzdXBwb3J0ZWRBY3Rpb25UYWIodGFiKSB8fCBuZXcgVVJMKHRhYi51cmwpLm9yaWdpbiAhPT0gb3JpZ2luKSkge1xuICAgICAgICBzaWRlYmFyRGVidWdGYWlsdXJlKG1lc3NhZ2UsIGJpbmRpbmcsICdtaXNzaW5nJyk7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTtcbiAgICB9XG4gICAgLy8gVGhlIGhpc3RvcnkgY2hhbm5lbCBpcyBhIHByaXZhdGUgcGVyLXBhbmVsIHNpbmssIG5ldmVyIGEgcHJlY29uZGl0aW9uIGZvclxuICAgIC8vIHJlbmRlcmluZzogYSBwYW5lbCB0aGF0IGxvc3QgaXQgc3RpbGwgc2hvd3MgdGhlIHZpZXcgYW5kIHJlcG9ydHMgaXRzIG93blxuICAgIC8vIGhpc3RvcnkgZXJyb3IsIGV4YWN0bHkgYXMgYSBtaXNzaW5nIGNyZWRlbnRpYWxzIHBhdGggbXVzdCBzdGF5IGZhaWwtY2xvc2VkXG4gICAgLy8gZm9yIHN0b3JhZ2UgYWxvbmUuXG4gICAgY29uc3QgaGlzdG9yeSA9IHNpZGViYXJIaXN0b3J5T3duZXJzLmdldChzZW5kZXIudXJsKTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnXG4gICAgICAgID8geyB0eXBlOiAnbWVtY2hhdDp2aWV3LXNuYXBzaG90JyB9XG4gICAgICAgIDogeyB0eXBlOiAnbWVtY2hhdDp2aWV3LWV2ZW50JywgZG9jdW1lbnRUb2tlbjogbWVzc2FnZS5kb2N1bWVudFRva2VuLFxuICAgICAgICAgICAga2V5OiBtZXNzYWdlLmtleSwgZXZlbnQ6IG1lc3NhZ2UuZXZlbnQsIHZhbHVlOiBtZXNzYWdlLnZhbHVlLFxuICAgICAgICAgICAgY2hlY2tlZDogbWVzc2FnZS5jaGVja2VkLCBzZWxlY3RlZDogbWVzc2FnZS5zZWxlY3RlZCxcbiAgICAgICAgICAgIC4uLihtZXNzYWdlLmV2ZW50ID09PSAnY2xpY2snICYmIG1lc3NhZ2UudHJ1c3RlZEdlc3R1cmUgPT09IHRydWUgPyB7IHRydXN0ZWRHZXN0dXJlOiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4obWVzc2FnZS5ldmVudCA9PT0gJ2VudGVyJyA/IHsgZXZlbnRJZDogbWVzc2FnZS5ldmVudElkIH0gOiB7fSkgfTtcbiAgICAvLyBGb3J3YXJkIHRoZSBwYW5lbCdzIEVUYWcgb25seSBvbiBzbmFwc2hvdCBwb2xsczsgZXZlbnRzIGFsd2F5cyBuZWVkIHRoZVxuICAgIC8vIGZ1bGwgdmlldy4gVW5rbm93biBmaWVsZHMgc3RheSBhYnNlbnQgc28gb2xkIGNvbnRlbnQgd29ybGRzIHNlZSBhblxuICAgIC8vIG9yZGluYXJ5IHJlcXVlc3QuXG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JyAmJiB0eXBlb2YgbWVzc2FnZS5rbm93bkhhc2ggPT09ICdzdHJpbmcnKSByZXF1ZXN0Lmtub3duSGFzaCA9IG1lc3NhZ2Uua25vd25IYXNoO1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgdHlwZW9mIG1lc3NhZ2Uua25vd25Eb2N1bWVudFRva2VuID09PSAnc3RyaW5nJykgcmVxdWVzdC5rbm93bkRvY3VtZW50VG9rZW4gPSBtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbjtcbiAgICAvLyBUaGUgcGFuZWwncyBjaGF0IG1lbW9yeSBpcyBhZGRyZXNzZWQgYnkgb3duZXIgaWQgcGx1cyB0aGUgZXhhY3QgZG9jdW1lbnRcbiAgICAvLyB0b2tlbiB0aGF0IHdpbGwgYW5zd2VyIGl0OyBhIHJld3JpdHRlbiBlcG9jaCBtYXAgY2FuIG5laXRoZXIgbW92ZSBhblxuICAgIC8vIGFuc3dlciBpbnRvIGFub3RoZXIgbW9kZSBub3IgcmV2aXZlIGEgY2xlYXJlZCBoaXN0b3J5LlxuICAgIGlmIChoaXN0b3J5KSB7XG4gICAgICAgIHJlcXVlc3QuaGlzdG9yeU93bmVyID0gaGlzdG9yeS5pZDtcbiAgICAgICAgcmVxdWVzdC5jaGF0TW9kZSA9IFNJREVCQVJfRkVBVFVSRVMuaW5jbHVkZXMobWVzc2FnZS5jaGF0TW9kZSkgPyBtZXNzYWdlLmNoYXRNb2RlIDogbnVsbDtcbiAgICAgICAgcmVxdWVzdC5jaGF0RXBvY2hzID0gT2JqZWN0LmZyb21FbnRyaWVzKFsuLi5TSURFQkFSX0NIQVRfTU9ERVNdLm1hcChtb2RlID0+XG4gICAgICAgICAgICBbbW9kZSwgTnVtYmVyLmlzU2FmZUludGVnZXIobWVzc2FnZS5jaGF0RXBvY2hzPy5bbW9kZV0pICYmIG1lc3NhZ2UuY2hhdEVwb2Noc1ttb2RlXSA+PSAwID8gbWVzc2FnZS5jaGF0RXBvY2hzW21vZGVdIDogMF0pKTtcbiAgICB9XG4gICAgbGV0IGhpc3RvcnlUYXJnZXQ7XG4gICAgbGV0IHZpZXc7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGJpbmRpbmcuc3VwcG9ydGVkKSB7IGhpc3RvcnlUYXJnZXQgPSAndGFiOicgKyB0YWIuaWQ7IHZpZXcgPSBhd2FpdCBzaWRlYmFyU2VuZFRvVGFiKHRhYi5pZCwgcmVxdWVzdCk7IH1cbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZVNlc3Npb25zLmdldChuYXRpdmVSdW50aW1lU2Vzc2lvbktleShzZW5kZXIsIG9yaWdpbikpO1xuICAgICAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHJ1bnRpbWU6IHsgb3JpZ2luLCB0aWNrZXQ6IGF3YWl0IG5hdGl2ZVJ1bnRpbWVUaWNrZXQoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4pIH0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGhpc3RvcnlUYXJnZXQgPSAnbmF0aXZlOicgKyBzZXNzaW9uLnNlbmRlci51cmw7XG4gICAgICAgICAgICB2aWV3ID0gYXdhaXQgbmF0aXZlUnVudGltZVJlcXVlc3Qoc2Vzc2lvbiwgcmVxdWVzdCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCAnbWlzc2luZycpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07XG4gICAgfVxuICAgIC8vIFRoZSBib3VuZCB0YWIgaXRzZWxmIG11c3Qgc3RpbGwgZXhpc3QgaW4gdGhlIHBhbmVsJ3Mgd2luZG93OyBuZXZlciByZS10YXJnZXRcbiAgICAvLyB0byB3aGF0ZXZlciBoYXBwZW5zIHRvIGJlIGFjdGl2ZS4gVGhlIGNvbnRlbnQgZG9jdW1lbnRUb2tlbiBzdGlsbCBwaW5zIGV2ZW50cy5cbiAgICBsZXQgYWxpdmU7XG4gICAgdHJ5IHsgYWxpdmUgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQodGFiLmlkKTsgfSBjYXRjaCB7XG4gICAgICAgIHNpZGViYXJEZWJ1Z0ZhaWx1cmUobWVzc2FnZSwgYmluZGluZywgJ2Nsb3NlZCcpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2Nsb3NlZCcgfTtcbiAgICB9XG4gICAgaWYgKGFsaXZlLndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkIHx8ICFhd2FpdCBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkpIHtcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCAnY2hhbmdlZCcpO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgfVxuICAgIGlmICghdmlldz8ub2spIHtcbiAgICAgICAgY29uc3QgcmVhc29uID0gWydzdG9yYWdlJywgJ2NvbmZsaWN0JywgJ2NoYW5nZWQnLCAndGltZW91dCcsICd0b28tbGFyZ2UnXS5pbmNsdWRlcyh2aWV3Py5yZWFzb24pID8gdmlldy5yZWFzb24gOiAnZmFpbGVkJztcbiAgICAgICAgc2lkZWJhckRlYnVnRmFpbHVyZShtZXNzYWdlLCBiaW5kaW5nLCByZWFzb24pO1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbiB9O1xuICAgIH1cbiAgICAvLyBPbmx5IGEgZmlyc3QgYmluZGluZyBvciBhbiBldmVudCBmcm9tIHRoZSB2aXNpYmxlIGJvdW5kIHRhYiByZWNvcmRzIHRoZVxuICAgIC8vIHNlbGVjdGlvbjsgYSBiYWNrZ3JvdW5kIHBvbGwgb2YgYSBub24tYWN0aXZlIHRhYiBtdXN0IG5vdCBvdmVyd3JpdGUgaXQuXG4gICAgY29uc3QgYWN0aXZlQm91bmQgPSBtZXNzYWdlLnRhYklkID09PSB1bmRlZmluZWQgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1ldmVudCdcbiAgICAgICAgJiYgKGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KSlbMF0/LmlkID09PSB0YWIuaWQpO1xuICAgIGlmIChiaW5kaW5nLnN1cHBvcnRlZCAmJiBhY3RpdmVCb3VuZCAmJiAoYXdhaXQgY2hyb21lLndpbmRvd3MuZ2V0KG1lc3NhZ2Uud2luZG93SWQpKS5mb2N1c2VkKSBhd2FpdCBuYXRpdmVSZW1lbWJlck9yaWdpbihvcmlnaW4pO1xuICAgIC8vIE9ubHkgYSB2aWV3IHRoYXQgcmVhbGx5IGFuc3dlcmVkIG1heSBiZWNvbWUgdGhlIHRhcmdldCBvZiB0aGlzIHBhbmVsJ3NcbiAgICAvLyBjaGF0IHNpbms7IGEgcmVmdXNlZCByZXF1ZXN0IG11c3Qgbm90IGJpbmQgYSBkb2N1bWVudCB0aGF0IG5ldmVyIHJlbmRlcmVkLlxuICAgIGlmIChoaXN0b3J5KSBzaWRlYmFySGlzdG9yeUJpbmQoc2VuZGVyLCBoaXN0b3J5VGFyZ2V0LCB2aWV3LmRvY3VtZW50VG9rZW4pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUsIG5hdGl2ZTogIWJpbmRpbmcuc3VwcG9ydGVkLCB2aWV3IH07XG59XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gICAgaWYgKCFbJ21lbWNoYXQ6c2lkZWJhci1zdGF0dXMnLCAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnLCAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnLCAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50J10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoc2VuZGVyLmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCBzZW5kZXIudGFiIHx8IChzZW5kZXIuZnJhbWVJZCAhPT0gdW5kZWZpbmVkICYmIHNlbmRlci5mcmFtZUlkICE9PSAwKVxuICAgICAgICB8fCAhbmF0aXZlRG9jdW1lbnRVcmwoc2VuZGVyLnVybCwgJ3BhbmVsJywgJ3NpZGViYXInKVxuICAgICAgICB8fCAhTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLndpbmRvd0lkKSB8fCBtZXNzYWdlLndpbmRvd0lkIDwgMFxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnICYmICghTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSB8fCBtZXNzYWdlLnRhYklkIDwgMFxuICAgICAgICAgICAgfHwgIVNJREVCQVJfRkVBVFVSRVMuaW5jbHVkZXMobWVzc2FnZS5mZWF0dXJlKSkpXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgbWVzc2FnZS50YWJJZCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzSW50ZWdlcihtZXNzYWdlLnRhYklkKSB8fCBtZXNzYWdlLnRhYklkIDwgMCkpXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItdmlldycgJiYgKChtZXNzYWdlLmtub3duSGFzaCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAmJiAodHlwZW9mIG1lc3NhZ2Uua25vd25IYXNoICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLmtub3duSGFzaC5sZW5ndGggPiA2NCkpXG4gICAgICAgICAgICB8fCAobWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW4gIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgJiYgKHR5cGVvZiBtZXNzYWdlLmtub3duRG9jdW1lbnRUb2tlbiAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS5rbm93bkRvY3VtZW50VG9rZW4ubGVuZ3RoID4gMTAwKSkpKVxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50JyAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmRvY3VtZW50VG9rZW4gIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbi5sZW5ndGggPiAxMDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmtleSAhPT0gJ3N0cmluZycgfHwgIS9eXFxkezEsOH0kLy50ZXN0KG1lc3NhZ2Uua2V5KVxuICAgICAgICAgICAgfHwgIVsnY2xpY2snLCAnaW5wdXQnLCAnY2hhbmdlJywgJ2VudGVyJ10uaW5jbHVkZXMobWVzc2FnZS5ldmVudClcbiAgICAgICAgICAgIHx8IChtZXNzYWdlLmV2ZW50ID09PSAnZW50ZXInICYmICh0eXBlb2YgbWVzc2FnZS5ldmVudElkICE9PSAnc3RyaW5nJ1xuICAgICAgICAgICAgICAgIHx8ICEvXlthLWYwLTktXXsxLDY0fSQvLnRlc3QobWVzc2FnZS5ldmVudElkKSkpKSkpIHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdpbnZhbGlkJyB9KTsgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkudGhlbih2YWxpZCA9PiB2YWxpZFxuICAgICAgICA/IChbJ21lbWNoYXQ6c2lkZWJhci12aWV3JywgJ21lbWNoYXQ6c2lkZWJhci1ldmVudCddLmluY2x1ZGVzKG1lc3NhZ2UudHlwZSlcbiAgICAgICAgICAgID8gc2lkZWJhclZpZXdEaXNwYXRjaChtZXNzYWdlLCBzZW5kZXIpIDogc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpKVxuICAgICAgICA6IHsgb2s6IGZhbHNlLCByZWFzb246ICdpbnZhbGlkJyB9KS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdmYWlsZWQnIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn0pO1xuIiwiY29uc3QgTUVNQ0hBVF9SRVBSSUNFX0FQSSA9ICdodHRwczovL2FwaS5tb3lza2xhZC5ydS9hcGkvcmVtYXAvMS4yJztcbmNvbnN0IE1FTUNIQVRfUkVQUklDRV9QUklDRV9UWVBFUyA9ICcvY29udGV4dC9jb21wYW55c2V0dGluZ3MvcHJpY2V0eXBlJztcbmNvbnN0IE1FTUNIQVRfUkVQUklDRV9VVUlEID0gL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXsxMn0kLztcbmNvbnN0IE1FTUNIQVRfUkVQUklDRV9ERUZBVUxUUyA9IE9iamVjdC5mcmVlemUoeyBtdWx0aXBsaWVyOiAnMS4wNDEnLCByb3VuZGluZzogJ3VwJywgc3RlcDogJzEwMCcsIHN1YnRyYWN0OiAnMTAnIH0pO1xuXG5mdW5jdGlvbiBtZW1jaGF0UmVwcmljZUZvcm11bGEocnVsZXMpIHtcbiAgICBjb25zdCBkZWNpbWFsID0gKHZhbHVlLCBwbGFjZXMpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgfHwgIW5ldyBSZWdFeHAoYF5cXFxcZHsxLDh9KD86XFxcXC5cXFxcZHsxLCR7cGxhY2VzfX0pPyRgKS50ZXN0KHZhbHVlKSkge1xuICAgICAgICAgICAgdGhyb3cgRXJyb3IoJ9CS0LLQtdC00LjRgtC1INC00LXRgdGP0YLQuNGH0L3Ri9C1INC30L3QsNGH0LXQvdC40Y8g0LrQvtGN0YTRhNC40YbQuNC10L3RgtCwLCDRiNCw0LPQsCDQuCDQstGL0YfQuNGC0LDQvdC40Y8uJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgW3dob2xlLCBmcmFjdGlvbiA9ICcnXSA9IHZhbHVlLnNwbGl0KCcuJyk7XG4gICAgICAgIGNvbnN0IHN1ZmZpeCA9IGZyYWN0aW9uLnJlcGxhY2UoLzArJC8sICcnKTtcbiAgICAgICAgcmV0dXJuIFN0cmluZyhOdW1iZXIod2hvbGUpKSArIChzdWZmaXggPyAnLicgKyBzdWZmaXggOiAnJyk7XG4gICAgfTtcbiAgICBjb25zdCBtdWx0aXBsaWVyID0gZGVjaW1hbChydWxlcy5tdWx0aXBsaWVyLCA2KTtcbiAgICBjb25zdCBzdGVwID0gZGVjaW1hbChydWxlcy5zdGVwLCAyKTtcbiAgICBjb25zdCBzdWJ0cmFjdCA9IGRlY2ltYWwocnVsZXMuc3VidHJhY3QsIDIpO1xuICAgIGNvbnN0IHJvdW5kaW5nID0gcnVsZXMucm91bmRpbmc7XG4gICAgaWYgKE51bWJlcihtdWx0aXBsaWVyKSA8PSAwIHx8IE51bWJlcihzdGVwKSA8PSAwKSB0aHJvdyBFcnJvcign0JrQvtGN0YTRhNC40YbQuNC10L3RgiDQuCDRiNCw0LMg0LTQvtC70LbQvdGLINCx0YvRgtGMINCx0L7Qu9GM0YjQtSDQvdGD0LvRjy4nKTtcbiAgICBpZiAoIVsndXAnLCAnbmVhcmVzdCcsICdkb3duJ10uaW5jbHVkZXMocm91bmRpbmcpKSB0aHJvdyBFcnJvcign0JLRi9Cx0LXRgNC40YLQtSDQvdCw0L/RgNCw0LLQu9C10L3QuNC1INC+0LrRgNGD0LPQu9C10L3QuNGPLicpO1xuICAgIHJldHVybiB7IG11bHRpcGxpZXIsIHJvdW5kaW5nLCBzdGVwLCBzdWJ0cmFjdCB9O1xufVxuXG5mdW5jdGlvbiBtZW1jaGF0UmVwcmljZVByaWNlVHlwZXMocGF5bG9hZCkge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShwYXlsb2FkKSkgdGhyb3cgRXJyb3IoJ9Ch0L/RgNCw0LLQvtGH0L3QuNC6INGC0LjQv9C+0LIg0YbQtdC9INC90LXQtNC+0YHRgtGD0L/QtdC9LicpO1xuICAgIGNvbnN0IHR5cGVzID0gbmV3IE1hcCgpO1xuICAgIGZvciAoY29uc3Qgcm93IG9mIHBheWxvYWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByb3c/LmlkICE9PSAnc3RyaW5nJyB8fCAhTUVNQ0hBVF9SRVBSSUNFX1VVSUQudGVzdChyb3cuaWQpIHx8IHR5cGVzLmhhcyhyb3cuaWQpXG4gICAgICAgICAgICB8fCB0eXBlb2Ygcm93Lm5hbWUgIT09ICdzdHJpbmcnIHx8ICFyb3cubmFtZS50cmltKCkgfHwgcm93Lm5hbWUubGVuZ3RoID4gMzAwXG4gICAgICAgICAgICB8fCByb3cubWV0YT8uaHJlZiAhPT0gTUVNQ0hBVF9SRVBSSUNFX0FQSSArIE1FTUNIQVRfUkVQUklDRV9QUklDRV9UWVBFUyArICcvJyArIHJvdy5pZCkge1xuICAgICAgICAgICAgdGhyb3cgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDRgdC/0YDQsNCy0L7Rh9C90LjQuiDRgtC40L/QvtCyINGG0LXQvS4nKTtcbiAgICAgICAgfVxuICAgICAgICB0eXBlcy5zZXQocm93LmlkLCByb3cubmFtZSk7XG4gICAgfVxuICAgIHJldHVybiB0eXBlcztcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWVtY2hhdFJlcHJpY2VTZXJ2aWNlKGNvbmZpZykge1xuICAgICd1c2Ugc3RyaWN0JztcblxuICAgIGNvbnN0IE9SREVSX0lEID0gY29uZmlnLm9yZGVySWQ7XG4gICAgY29uc3QgQkFTRV9QUklDRV9UWVBFX0lEID0gY29uZmlnLmJhc2VUeXBlSWQ7XG4gICAgY29uc3QgQkFTRV9QUklDRV9UWVBFX05BTUUgPSBjb25maWcuYmFzZVR5cGVOYW1lO1xuICAgIGNvbnN0IFRBUkdFVF9QUklDRV9UWVBFX0lEID0gY29uZmlnLnRhcmdldFR5cGVJZDtcbiAgICBjb25zdCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FID0gY29uZmlnLnRhcmdldFR5cGVOYW1lO1xuICAgIGNvbnN0IFBSSUNFX1RZUEVfQ09OVEVYVF9QQVRIID0gTUVNQ0hBVF9SRVBSSUNFX1BSSUNFX1RZUEVTO1xuICAgIGNvbnN0IEFQSSA9IE1FTUNIQVRfUkVQUklDRV9BUEk7XG4gICAgY29uc3QgUE9TSVRJT05TX0xJTUlUID0gMTAwMDtcbiAgICBjb25zdCBmb3JtdWxhID0gbWVtY2hhdFJlcHJpY2VGb3JtdWxhKHsgLi4uTUVNQ0hBVF9SRVBSSUNFX0RFRkFVTFRTLCAuLi5jb25maWcgfSk7XG4gICAgY29uc3Qgc2NhbGVkID0gKHZhbHVlLCBwbGFjZXMpID0+IHtcbiAgICAgICAgY29uc3QgW3dob2xlLCBmcmFjdGlvbiA9ICcnXSA9IHZhbHVlLnNwbGl0KCcuJyk7XG4gICAgICAgIHJldHVybiBCaWdJbnQod2hvbGUgKyBmcmFjdGlvbi5wYWRFbmQocGxhY2VzLCAnMCcpKTtcbiAgICB9O1xuICAgIGNvbnN0IG11bHRpcGxpZXIgPSBzY2FsZWQoZm9ybXVsYS5tdWx0aXBsaWVyLCA2KTtcbiAgICBjb25zdCBzdGVwID0gc2NhbGVkKGZvcm11bGEuc3RlcCwgMik7XG4gICAgY29uc3Qgc3VidHJhY3QgPSBzY2FsZWQoZm9ybXVsYS5zdWJ0cmFjdCwgMik7XG4gICAgY29uc3QgZGl2aXNvciA9IDEwMDAwMDBuICogc3RlcDtcbiAgICBjb25zdCBVVUlEX1BBVFRFUk4gPSBNRU1DSEFUX1JFUFJJQ0VfVVVJRDtcbiAgICBjb25zdCBDQVJEX1ZPTEFUSUxFID0gWydtZXRhJywgJ2NvbnRleHQnLCAndXBkYXRlZCcsICdzYWxlUHJpY2VzJ107XG4gICAgY29uc3QgRE9DVU1FTlRfVk9MQVRJTEUgPSBbJ21ldGEnLCAnY29udGV4dCcsICdwb3NpdGlvbnMnLCAndXBkYXRlZCddO1xuXG4gICAgZnVuY3Rpb24gZmFpbHVyZShjb2RlLCBtZXNzYWdlKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICBlcnJvci5jb2RlID0gY29kZTtcbiAgICAgICAgcmV0dXJuIGVycm9yO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGludmFsaWQoY29kZSwgbWVzc2FnZSkge1xuICAgICAgICBjb25zdCBlcnJvciA9IGZhaWx1cmUoY29kZSwgbWVzc2FnZSk7XG4gICAgICAgIGVycm9yLnZhbGlkYXRpb24gPSB0cnVlO1xuICAgICAgICByZXR1cm4gZXJyb3I7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaW50ZWdlcih2YWx1ZSkge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlKSA/IHZhbHVlIDogbnVsbDtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2JpZ2ludCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbnZlcnRlZCA9IE51bWJlcih2YWx1ZSk7XG4gICAgICAgICAgICByZXR1cm4gTnVtYmVyLmlzU2FmZUludGVnZXIoY29udmVydGVkKSA/IGNvbnZlcnRlZCA6IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgL14tP1xcZCskLy50ZXN0KHZhbHVlLnRyaW0oKSkpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbnZlcnRlZCA9IE51bWJlcih2YWx1ZS50cmltKCkpO1xuICAgICAgICAgICAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKGNvbnZlcnRlZCkgPyBjb252ZXJ0ZWQgOiBudWxsO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNhbGN1bGF0ZShiYXNlS29wZWNrcykge1xuICAgICAgICBjb25zdCBiYXNlID0gaW50ZWdlcihiYXNlS29wZWNrcyk7XG4gICAgICAgIGlmIChiYXNlID09PSBudWxsIHx8IGJhc2UgPD0gMCkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaW52YWxpZC1iYXNlJywgJ9CR0LDQt9C+0LLQsNGPINGG0LXQvdCwINC00L7Qu9C20L3QsCDQsdGL0YLRjCDQv9C+0LvQvtC20LjRgtC10LvRjNC90YvQvCDRhtC10LvRi9C8INGH0LjRgdC70L7QvCDQutC+0L/QtdC10LonKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBvZmZzZXQgPSBmb3JtdWxhLnJvdW5kaW5nID09PSAndXAnID8gZGl2aXNvciAtIDFuIDogZm9ybXVsYS5yb3VuZGluZyA9PT0gJ25lYXJlc3QnID8gZGl2aXNvciAvIDJuIDogMG47XG4gICAgICAgIGNvbnN0IHJvdW5kZWQgPSAoQmlnSW50KGJhc2UpICogbXVsdGlwbGllciArIG9mZnNldCkgLyBkaXZpc29yO1xuICAgICAgICBjb25zdCByZXN1bHQgPSByb3VuZGVkICogc3RlcCAtIHN1YnRyYWN0O1xuICAgICAgICBpZiAocmVzdWx0IDw9IDBuIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihOdW1iZXIocmVzdWx0KSkpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ291dC1vZi1yYW5nZScsICfQoNCw0YHRgdGH0LjRgtCw0L3QvdCw0Y8g0YbQtdC90LAg0LTQvtC70LbQvdCwINCx0YvRgtGMINC/0L7Qu9C+0LbQuNGC0LXQu9GM0L3QvtC5INC4INCyINCx0LXQt9C+0L/QsNGB0L3QvtC8INC00LjQsNC/0LDQt9C+0L3QtScpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBOdW1iZXIocmVzdWx0KTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjYW5vbmljYWwodmFsdWUpIHtcbiAgICAgICAgaWYgKHZhbHVlID09PSB2b2lkIDApIHJldHVybiAnbnVsbCc7XG4gICAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHJldHVybiAnWycgKyB2YWx1ZS5tYXAoY2Fub25pY2FsKS5qb2luKCcsJykgKyAnXSc7XG4gICAgICAgIHJldHVybiAneycgKyBPYmplY3Qua2V5cyh2YWx1ZSkuc29ydCgpXG4gICAgICAgICAgICAubWFwKGtleSA9PiBKU09OLnN0cmluZ2lmeShrZXkpICsgJzonICsgY2Fub25pY2FsKHZhbHVlW2tleV0pKS5qb2luKCcsJykgKyAnfSc7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY29weSh2YWx1ZSkge1xuICAgICAgICByZXR1cm4gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGxhc3RTZWdtZW50KGhyZWYpIHtcbiAgICAgICAgY29uc3QgcGFydHMgPSBTdHJpbmcoaHJlZikuc3BsaXQoJz8nKVswXS5zcGxpdCgnLycpO1xuICAgICAgICByZXR1cm4gcGFydHNbcGFydHMubGVuZ3RoIC0gMV07XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcmVhZFBhdGgocGF0aCkge1xuICAgICAgICBpZiAodHlwZW9mIHBhdGggIT09ICdzdHJpbmcnIHx8IHBhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdpbnZhbGlkLXJlYWQtcGF0aCcsICfQndC10LrQvtGA0YDQtdC60YLQvdGL0Lkg0LDQtNGA0LXRgSDRh9GC0LXQvdC40Y8g0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXRoID09PSBQUklDRV9UWVBFX0NPTlRFWFRfUEFUSCkgcmV0dXJuIHBhdGg7XG4gICAgICAgIGlmICghcGF0aC5zdGFydHNXaXRoKCcvZW50aXR5LycpIHx8IHBhdGguaW5kZXhPZignLy8nKSAhPT0gLTEpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2ludmFsaWQtcmVhZC1wYXRoJywgJ9Cn0YLQtdC90LjQtSDRgNCw0LfRgNC10YjQtdC90L4g0YLQvtC70YzQutC+INCyIC9lbnRpdHknKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcGF0aDtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiByZWFkSnNvbihyZWFkLCBwYXRoKSB7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZWFkKHJlYWRQYXRoKHBhdGgpKTtcbiAgICAgICAgaWYgKGRhdGEgJiYgQXJyYXkuaXNBcnJheShkYXRhLmVycm9ycykgJiYgZGF0YS5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdhcGktcmVzcG9uc2UnLCAn0J7RgtCy0LXRgiDQnNC+0LnQodC60LvQsNC0INGB0L7QtNC10YDQttC40YIg0L7RiNC40LHQutC4Jyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGRhdGE7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbGlua0Jhc2UoaHJlZiwgbWFya2VyKSB7XG4gICAgICAgIGlmICh0eXBlb2YgaHJlZiAhPT0gJ3N0cmluZycgfHwgIWhyZWYpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2lkZW50aXR5JywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0L7Qv9GA0LXQtNC10LvQuNGC0Ywg0LDQtNGA0LXRgSBBUEkg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNsZWFuID0gaHJlZi5zcGxpdCgnPycpWzBdO1xuICAgICAgICBpZiAoY2xlYW4gIT09IEFQSSArIG1hcmtlcikge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnaWRlbnRpdHknLCAn0KHRgdGL0LvQutCwINCy0L3QtSDRgdC+0LPQu9Cw0YHQvtCy0LDQvdC90L7Qs9C+INCw0LTRgNC10YHQsCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEFQSTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBvcmRlckJhc2Uob3JkZXIpIHtcbiAgICAgICAgcmV0dXJuIGxpbmtCYXNlKG9yZGVyICYmIG9yZGVyLm1ldGEgJiYgb3JkZXIubWV0YS5ocmVmLFxuICAgICAgICAgICAgJy9lbnRpdHkvaW50ZXJuYWxvcmRlci8nICsgT1JERVJfSUQpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNhcmRCYXNlKGNhcmQsIGlkKSB7XG4gICAgICAgIHJldHVybiBsaW5rQmFzZShjYXJkICYmIGNhcmQubWV0YSAmJiBjYXJkLm1ldGEuaHJlZiwgJy9lbnRpdHkvcHJvZHVjdC8nICsgaWQpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlbGF0aXZlKGhyZWYsIGJhc2UpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBocmVmICE9PSAnc3RyaW5nJyB8fCAhaHJlZikge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnc2NvcGUnLCAn0J3QtdC60L7RgNGA0LXQutGC0L3QsNGPINGB0YHRi9C70LrQsCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGhyZWYuY2hhckF0KDApID09PSAnLycpIHtcbiAgICAgICAgICAgIGlmICghaHJlZi5zdGFydHNXaXRoKCcvZW50aXR5LycpIHx8IGhyZWYuaW5kZXhPZignLy8nKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdzY29wZScsICfQodGB0YvQu9C60LAg0LLQvdC1INGB0L7Qs9C70LDRgdC+0LLQsNC90L3QvtCz0L4gQVBJINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBocmVmO1xuICAgICAgICB9XG4gICAgICAgIGlmICghaHJlZi5zdGFydHNXaXRoKGJhc2UgKyAnL2VudGl0eS8nKSkge1xuICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgnc2NvcGUnLCAn0KHRgdGL0LvQutCwINCy0L3QtSDRgdC+0LPQu9Cw0YHQvtCy0LDQvdC90L7Qs9C+IEFQSSDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGhyZWYuc2xpY2UoYmFzZS5sZW5ndGgpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHByb2R1Y3RSZWYoaHJlZiwgYmFzZSkge1xuICAgICAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoaHJlZiwgYmFzZSk7XG4gICAgICAgIGNvbnN0IHNlZ21lbnRzID0gcGF0aC5zcGxpdCgnPycpWzBdLnNwbGl0KCcvJyk7XG4gICAgICAgIGlmIChzZWdtZW50cy5sZW5ndGggIT09IDQgfHwgc2VnbWVudHNbMV0gIT09ICdlbnRpdHknIHx8IHNlZ21lbnRzWzJdICE9PSAncHJvZHVjdCdcbiAgICAgICAgICAgIHx8ICFVVUlEX1BBVFRFUk4udGVzdChzZWdtZW50c1szXSkpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3Byb2R1Y3QtcmVmJywgJ9Cd0LXQutC+0YDRgNC10LrRgtC90LDRjyDRgdGB0YvQu9C60LAgcHJvZHVjdCcpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IGlkOiBzZWdtZW50c1szXSwgcGF0aCB9O1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHByaWNlVHlwZUlkKHByaWNlKSB7XG4gICAgICAgIGNvbnN0IHByaWNlVHlwZSA9IHByaWNlICYmIHByaWNlLnByaWNlVHlwZTtcbiAgICAgICAgaWYgKCFwcmljZVR5cGUpIHJldHVybiAnJztcbiAgICAgICAgaWYgKHR5cGVvZiBwcmljZVR5cGUuaWQgPT09ICdzdHJpbmcnICYmIHByaWNlVHlwZS5pZCkgcmV0dXJuIHByaWNlVHlwZS5pZDtcbiAgICAgICAgcmV0dXJuIHByaWNlVHlwZS5tZXRhICYmIHR5cGVvZiBwcmljZVR5cGUubWV0YS5ocmVmID09PSAnc3RyaW5nJ1xuICAgICAgICAgICAgPyBsYXN0U2VnbWVudChwcmljZVR5cGUubWV0YS5ocmVmKSA6ICcnO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNlbGVjdFByaWNlKGNhcmQsIGlkLCBuYW1lKSB7XG4gICAgICAgIGlmICghY2FyZCB8fCAhQXJyYXkuaXNBcnJheShjYXJkLnNhbGVQcmljZXMpKSB7XG4gICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcmljZXMnLCAn0JIg0LrQsNGA0YLQvtGH0LrQtSDQvdC10YIg0YLQuNC/0L7QsiDRhtC10L0nKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtYXRjaGVzID0gY2FyZC5zYWxlUHJpY2VzLmZpbHRlcihwcmljZSA9PiBwcmljZVR5cGVJZChwcmljZSkgPT09IGlkKTtcbiAgICAgICAgaWYgKG1hdGNoZXMubGVuZ3RoICE9PSAxIHx8IChuYW1lICE9PSB1bmRlZmluZWQgJiYgbWF0Y2hlc1swXS5wcmljZVR5cGU/Lm5hbWUgIT09IG5hbWUpXG4gICAgICAgICAgICB8fCBtYXRjaGVzWzBdLnByaWNlVHlwZT8ubWV0YT8uaHJlZiAhPT0gQVBJICsgUFJJQ0VfVFlQRV9DT05URVhUX1BBVEggKyAnLycgKyBpZCkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJpY2VzJywgJ9Ce0YLRgdGD0YLRgdGC0LLRg9C10YIg0LjQu9C4INC/0LXRgNC10LjQvNC10L3QvtCy0LDQvSDRgtC40L8g0YbQtdC90YsgJyArIG5hbWUpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHByaWNlID0gbWF0Y2hlc1swXTtcbiAgICAgICAgaWYgKCFwcmljZS5jdXJyZW5jeSB8fCAhcHJpY2UuY3VycmVuY3kubWV0YVxuICAgICAgICAgICAgfHwgdHlwZW9mIHByaWNlLmN1cnJlbmN5Lm1ldGEuaHJlZiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2N1cnJlbmN5JywgJ9CjINGC0LjQv9CwINGG0LXQvdGLINC90LXRgiDQstCw0LvRjtGC0YsnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcHJpY2U7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gcmVxdWlyZVJ1YmxlKHJlYWQsIHByaWNlLCBiYXNlLCBjYWNoZSkge1xuICAgICAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUocHJpY2UuY3VycmVuY3kubWV0YS5ocmVmLCBiYXNlKTtcbiAgICAgICAgY29uc3Qgc2VnbWVudHMgPSBwYXRoLnNwbGl0KCc/JylbMF0uc3BsaXQoJy8nKTtcbiAgICAgICAgaWYgKHNlZ21lbnRzLmxlbmd0aCAhPT0gNCB8fCBzZWdtZW50c1syXSAhPT0gJ2N1cnJlbmN5J1xuICAgICAgICAgICAgfHwgIVVVSURfUEFUVEVSTi50ZXN0KHNlZ21lbnRzWzNdKSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnY3VycmVuY3knLCAn0J3QtdC60L7RgNGA0LXQutGC0L3QsNGPINGB0YHRi9C70LrQsCDQstCw0LvRjtGC0YsnKTtcbiAgICAgICAgfVxuICAgICAgICBsZXQgaXNvID0gY2FjaGUuZ2V0KHBhdGgpO1xuICAgICAgICBpZiAoaXNvID09PSB2b2lkIDApIHtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZWFkSnNvbihyZWFkLCBwYXRoKTtcbiAgICAgICAgICAgIGlzbyA9IGRhdGEgJiYgZGF0YS5pc29Db2RlO1xuICAgICAgICAgICAgY2FjaGUuc2V0KHBhdGgsIGlzbyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzbyAhPT0gJ1JVQicpIHRocm93IGludmFsaWQoJ2N1cnJlbmN5JywgJ9CS0LDQu9GO0YLQsCDRhtC10L3RiyDQvdC1IFJVQicpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG90aGVyUHJpY2VzKGNhcmQpIHtcbiAgICAgICAgY29uc3QgcHJpY2VzID0gY2FyZCAmJiBBcnJheS5pc0FycmF5KGNhcmQuc2FsZVByaWNlcykgPyBjYXJkLnNhbGVQcmljZXMgOiBbXTtcbiAgICAgICAgcmV0dXJuIHByaWNlc1xuICAgICAgICAgICAgLmZpbHRlcihwcmljZSA9PiBwcmljZVR5cGVJZChwcmljZSkgIT09IFRBUkdFVF9QUklDRV9UWVBFX0lEKVxuICAgICAgICAgICAgLm1hcChwcmljZSA9PiAoe1xuICAgICAgICAgICAgICAgIGlkOiBwcmljZVR5cGVJZChwcmljZSksXG4gICAgICAgICAgICAgICAgdmFsdWU6IE51bWJlcihwcmljZS52YWx1ZSksXG4gICAgICAgICAgICAgICAgY3VycmVuY3k6IHByaWNlLmN1cnJlbmN5ICYmIHByaWNlLmN1cnJlbmN5Lm1ldGFcbiAgICAgICAgICAgICAgICAgICAgPyBTdHJpbmcocHJpY2UuY3VycmVuY3kubWV0YS5ocmVmKSA6ICcnXG4gICAgICAgICAgICB9KSlcbiAgICAgICAgICAgIC5zb3J0KChsZWZ0LCByaWdodCkgPT4gKGxlZnQuaWQgPCByaWdodC5pZCA/IC0xIDogbGVmdC5pZCA+IHJpZ2h0LmlkID8gMSA6IDApKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBidXNpbmVzc0ZpZWxkcyhjYXJkKSB7XG4gICAgICAgIGNvbnN0IGZpZWxkcyA9IHt9O1xuICAgICAgICBPYmplY3Qua2V5cyhjYXJkIHx8IHt9KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgICAgICBpZiAoQ0FSRF9WT0xBVElMRS5pbmRleE9mKGtleSkgPT09IC0xKSBmaWVsZHNba2V5XSA9IGNhcmRba2V5XTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBmaWVsZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZG9jdW1lbnRTaWduYXR1cmUob3JkZXIsIHBvc2l0aW9ucykge1xuICAgICAgICBjb25zdCBoZWFkZXIgPSB7fTtcbiAgICAgICAgT2JqZWN0LmtleXMob3JkZXIgfHwge30pLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgIGlmIChET0NVTUVOVF9WT0xBVElMRS5pbmRleE9mKGtleSkgPT09IC0xKSBoZWFkZXJba2V5XSA9IG9yZGVyW2tleV07XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCByb3dzID0gcG9zaXRpb25zLm1hcChwb3NpdGlvbiA9PiB7XG4gICAgICAgICAgICBjb25zdCByb3cgPSB7fTtcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKHBvc2l0aW9uIHx8IHt9KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSAhPT0gJ21ldGEnICYmIGtleSAhPT0gJ2Fzc29ydG1lbnQnKSByb3dba2V5XSA9IHBvc2l0aW9uW2tleV07XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJvdy5hc3NvcnRtZW50ID0gcG9zaXRpb24gJiYgcG9zaXRpb24uYXNzb3J0bWVudCAmJiBwb3NpdGlvbi5hc3NvcnRtZW50Lm1ldGFcbiAgICAgICAgICAgICAgICA/IHBvc2l0aW9uLmFzc29ydG1lbnQubWV0YS5ocmVmIDogbnVsbDtcbiAgICAgICAgICAgIHJldHVybiByb3c7XG4gICAgICAgIH0pLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhID0gU3RyaW5nKGxlZnQuaWQgPT09IHZvaWQgMCA/ICcnIDogbGVmdC5pZCk7XG4gICAgICAgICAgICBjb25zdCBiID0gU3RyaW5nKHJpZ2h0LmlkID09PSB2b2lkIDAgPyAnJyA6IHJpZ2h0LmlkKTtcbiAgICAgICAgICAgIHJldHVybiBhIDwgYiA/IC0xIDogYSA+IGIgPyAxIDogMDtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBjYW5vbmljYWwoeyBoZWFkZXIsIHBvc2l0aW9uczogcm93cyB9KTtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBjb2xsZWN0UGFnZXMocmVhZCwgZmlyc3QsIGJhc2UsIGVuZHBvaW50KSB7XG4gICAgICAgIGNvbnN0IHJvd3MgPSBbXTtcbiAgICAgICAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQoKTtcbiAgICAgICAgbGV0IGV4cGVjdGVkU2l6ZTtcbiAgICAgICAgbGV0IG5leHQgPSBmaXJzdDtcbiAgICAgICAgd2hpbGUgKG5leHQpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShuZXh0LCBiYXNlKTtcbiAgICAgICAgICAgIGlmIChwYXRoLnNwbGl0KCc/JylbMF0gIT09IGVuZHBvaW50KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC10LrQvtGA0YDQtdC60YLQvdCw0Y8g0L/QsNCz0LjQvdCw0YbQuNGPINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2aXNpdGVkLmhhcyhwYXRoKSkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J/QvtCy0YLQvtGA0L3QsNGPINGB0YLRgNCw0L3QuNGG0LAg0L/QsNCz0LjQvdCw0YbQuNC4INCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZpc2l0ZWQuYWRkKHBhdGgpO1xuICAgICAgICAgICAgY29uc3QgcGFnZSA9IGF3YWl0IHJlYWRKc29uKHJlYWQsIHBhdGgpO1xuICAgICAgICAgICAgaWYgKCFwYWdlIHx8ICFBcnJheS5pc0FycmF5KHBhZ2Uucm93cykgfHwgIXBhZ2UubWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtdC/0L7Qu9C90LDRjyDRgdGC0YDQsNC90LjRhtCwINC/0LDQs9C40L3QsNGG0LjQuCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBzaXplID0gaW50ZWdlcihwYWdlLm1ldGEuc2l6ZSk7XG4gICAgICAgICAgICBpZiAoc2l6ZSA9PT0gbnVsbCB8fCBzaXplIDwgMCkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtSDRg9C60LDQt9Cw0L0g0YDQsNC30LzQtdGAINCy0YvQsdC+0YDQutC4INCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChwYWdlLm1ldGEub2Zmc2V0ICE9PSB2b2lkIDAgJiYgaW50ZWdlcihwYWdlLm1ldGEub2Zmc2V0KSAhPT0gcm93cy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cd0LXQstC10YDQvdC+0LUg0YHQvNC10YnQtdC90LjQtSDQv9Cw0LPQuNC90LDRhtC40Lgg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGV4cGVjdGVkU2l6ZSAhPT0gdm9pZCAwICYmIHNpemUgIT09IGV4cGVjdGVkU2l6ZSkge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0KDQsNC30LzQtdGAINCy0YvQsdC+0YDQutC4INC40LfQvNC10L3QuNC70YHRjyDQstC+INCy0YDQtdC80Y8g0YfRgtC10L3QuNGPINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGV4cGVjdGVkU2l6ZSA9IHNpemU7XG4gICAgICAgICAgICByb3dzLnB1c2guYXBwbHkocm93cywgcGFnZS5yb3dzKTtcbiAgICAgICAgICAgIGlmIChyb3dzLmxlbmd0aCA+IHNpemUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBmYWlsdXJlKCdwYWdpbmF0aW9uJywgJ9Cb0LjRiNC90LjQtSDRgdGC0YDQvtC60Lgg0LIg0LLRi9Cx0L7RgNC60LUg0JzQvtC50KHQutC70LDQtCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHBhZ2UubWV0YS5uZXh0SHJlZikge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgcGFnZS5tZXRhLm5leHRIcmVmICE9PSAnc3RyaW5nJyB8fCAhcGFnZS5yb3dzLmxlbmd0aCB8fCByb3dzLmxlbmd0aCA+PSBzaXplKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtdC60L7RgNGA0LXQutGC0L3QvtC1INC/0YDQvtC00L7Qu9C20LXQvdC40LUg0L/QsNCz0LjQvdCw0YbQuNC4INCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbmV4dCA9IHBhZ2UubWV0YS5uZXh0SHJlZjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKHJvd3MubGVuZ3RoICE9PSBzaXplKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3BhZ2luYXRpb24nLCAn0J3QtdC/0L7Qu9C90LDRjyDQstGL0LHQvtGA0LrQsCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG5leHQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChleHBlY3RlZFNpemUgPT09IHZvaWQgMCkgdGhyb3cgZmFpbHVyZSgncGFnaW5hdGlvbicsICfQndC10L/QvtC70L3QsNGPINCy0YvQsdC+0YDQutCwINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2hlY2tQcmljZVR5cGVzKHBheWxvYWQpIHtcbiAgICAgICAgY29uc3QgdHlwZXMgPSBtZW1jaGF0UmVwcmljZVByaWNlVHlwZXMocGF5bG9hZCk7XG4gICAgICAgIGlmIChCQVNFX1BSSUNFX1RZUEVfSUQgPT09IFRBUkdFVF9QUklDRV9UWVBFX0lEIHx8ICF0eXBlcy5oYXMoQkFTRV9QUklDRV9UWVBFX0lEKSB8fCAhdHlwZXMuaGFzKFRBUkdFVF9QUklDRV9UWVBFX0lEKVxuICAgICAgICAgICAgfHwgdHlwZXMuZ2V0KEJBU0VfUFJJQ0VfVFlQRV9JRCkgIT09IEJBU0VfUFJJQ0VfVFlQRV9OQU1FIHx8IHR5cGVzLmdldChUQVJHRVRfUFJJQ0VfVFlQRV9JRCkgIT09IFRBUkdFVF9QUklDRV9UWVBFX05BTUUpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ3ByaWNldHlwZS1jb250ZXh0JywgJ9Ci0LjQvyDRhtC10L3RiyDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDQvdCw0YHRgtGA0L7QudC60L7QuS4g0J7QsdC90L7QstC40YLQtSDQv9GA0LDQstC40LvQsCDQv9C10YDQtdC+0YbQtdC90LrQuC4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIG1ha2VQbGFuKHJlYWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZiByZWFkICE9PSAnZnVuY3Rpb24nKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdwbGFuIHJlcXVpcmVzIGEgcmVhZCBmdW5jdGlvbicpO1xuICAgICAgICBpZiAodHlwZW9mIE9SREVSX0lEICE9PSAnc3RyaW5nJyB8fCAhVVVJRF9QQVRURVJOLnRlc3QoT1JERVJfSUQpKSB0aHJvdyBmYWlsdXJlKCdpZGVudGl0eScsICfQndC10LrQvtGA0YDQtdC60YLQvdGL0Lkg0LLQvdGD0YLRgNC10L3QvdC40Lkg0LfQsNC60LDQtycpO1xuICAgICAgICBjaGVja1ByaWNlVHlwZXMoYXdhaXQgcmVhZEpzb24ocmVhZCwgUFJJQ0VfVFlQRV9DT05URVhUX1BBVEgpKTtcblxuICAgICAgICBjb25zdCBvcmRlciA9IGF3YWl0IHJlYWRKc29uKHJlYWQsICcvZW50aXR5L2ludGVybmFsb3JkZXIvJyArIE9SREVSX0lEKTtcbiAgICAgICAgY29uc3QgYmFzZSA9IG9yZGVyQmFzZShvcmRlcik7XG4gICAgICAgIGlmICghb3JkZXIgfHwgb3JkZXIuaWQgIT09IE9SREVSX0lEIHx8IHR5cGVvZiBvcmRlci5uYW1lICE9PSAnc3RyaW5nJyB8fCAhb3JkZXIubmFtZS50cmltKCkpIHtcbiAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2lkZW50aXR5JywgJ9CS0L3Rg9GC0YDQtdC90L3QuNC5INC30LDQutCw0Lcg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YHQviDRgdGB0YvQu9C60L7QuScpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGVuZHBvaW50ID0gJy9lbnRpdHkvaW50ZXJuYWxvcmRlci8nICsgT1JERVJfSUQgKyAnL3Bvc2l0aW9ucyc7XG4gICAgICAgIGNvbnN0IHBvc2l0aW9ucyA9IGF3YWl0IGNvbGxlY3RQYWdlcyhyZWFkLFxuICAgICAgICAgICAgZW5kcG9pbnQgKyAnP2V4cGFuZD1hc3NvcnRtZW50JmxpbWl0PScgKyBQT1NJVElPTlNfTElNSVQsIGJhc2UsIGVuZHBvaW50KTtcblxuICAgICAgICBjb25zdCBlbnRyaWVzID0gW107XG4gICAgICAgIGNvbnN0IHNraXBwZWQgPSBbXTtcbiAgICAgICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQoKTtcbiAgICAgICAgY29uc3QgY2FjaGUgPSBuZXcgTWFwKCk7XG5cbiAgICAgICAgZm9yIChjb25zdCBwb3NpdGlvbiBvZiBwb3NpdGlvbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IGFzc29ydG1lbnQgPSBwb3NpdGlvbiAmJiBwb3NpdGlvbi5hc3NvcnRtZW50O1xuICAgICAgICAgICAgY29uc3QgaHJlZiA9IGFzc29ydG1lbnQgJiYgYXNzb3J0bWVudC5tZXRhICYmIGFzc29ydG1lbnQubWV0YS5ocmVmO1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IGFzc29ydG1lbnQgJiYgYXNzb3J0bWVudC5tZXRhICYmIGFzc29ydG1lbnQubWV0YS50eXBlO1xuICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBhc3NvcnRtZW50ICYmIHR5cGVvZiBhc3NvcnRtZW50Lm5hbWUgPT09ICdzdHJpbmcnICYmIGFzc29ydG1lbnQubmFtZVxuICAgICAgICAgICAgICAgID8gYXNzb3J0bWVudC5uYW1lIDogKHR5cGVvZiBocmVmID09PSAnc3RyaW5nJyA/IGhyZWYgOiAn0L/QvtC30LjRhtC40Y8nKTtcbiAgICAgICAgICAgIGlmICh0eXBlICE9PSAncHJvZHVjdCcgfHwgdHlwZW9mIGhyZWYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgc2tpcHBlZC5wdXNoKHsgbmFtZTogbGFiZWwsIHJlYXNvbjogJ9C/0L7QtNC00LXRgNC20LjQstCw0Y7RgtGB0Y8g0YLQvtC70YzQutC+INC60LDRgNGC0L7Rh9C60LggcHJvZHVjdCcgfSk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgcHJvZHVjdDtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcHJvZHVjdCA9IHByb2R1Y3RSZWYoaHJlZiwgYmFzZSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGlmIChlcnJvciAmJiBlcnJvci52YWxpZGF0aW9uID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNraXBwZWQucHVzaCh7IG5hbWU6IGxhYmVsLCByZWFzb246IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChzZWVuLmhhcyhwcm9kdWN0LmlkKSkgY29udGludWU7XG4gICAgICAgICAgICBzZWVuLmFkZChwcm9kdWN0LmlkKTtcblxuICAgICAgICAgICAgY29uc3QgY2FyZCA9IGF3YWl0IHJlYWRKc29uKHJlYWQsIHByb2R1Y3QucGF0aCk7XG4gICAgICAgICAgICBpZiAoIWNhcmQgfHwgY2FyZC5pZCAhPT0gcHJvZHVjdC5pZCB8fCB0eXBlb2YgY2FyZC5uYW1lICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIHRocm93IGZhaWx1cmUoJ2lkZW50aXR5JywgJ9Ca0LDRgNGC0L7Rh9C60LAg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0L/QvtC30LjRhtC40LXQuSDQt9Cw0LrQsNC30LAnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYmFzZVByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgQkFTRV9QUklDRV9UWVBFX0lELCBCQVNFX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgICAgICAgICAgY29uc3QgdGFyZ2V0UHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCwgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIGJhc2VQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCB0YXJnZXRQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGJhc2VLb3BlY2tzID0gaW50ZWdlcihiYXNlUHJpY2UudmFsdWUpO1xuICAgICAgICAgICAgICAgIGlmIChiYXNlS29wZWNrcyA9PT0gbnVsbCB8fCBiYXNlS29wZWNrcyA8PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2Jhc2UnLCAn0JHQsNC30L7QstCw0Y8g0YbQtdC90LAg0LTQvtC70LbQvdCwINCx0YvRgtGMINC/0L7Qu9C+0LbQuNGC0LXQu9GM0L3QvtC5INC4INGG0LXQu9C+0LknKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3Qgb2xkID0gaW50ZWdlcih0YXJnZXRQcmljZS52YWx1ZSk7XG4gICAgICAgICAgICAgICAgaWYgKG9sZCA9PT0gbnVsbCkgdGhyb3cgaW52YWxpZCgndGFyZ2V0JywgJ9Cm0LXQvdC90LjQuiDQtNC+0LvQttC10L0g0LHRi9GC0Ywg0YbQtdC70YvQvCDRh9C40YHQu9C+0Lwg0LrQvtC/0LXQtdC6Jyk7XG4gICAgICAgICAgICAgICAgaWYgKG9sZCA8IDApIHRocm93IGludmFsaWQoJ3RhcmdldCcsICfQntGC0YDQuNGG0LDRgtC10LvRjNC90YvQuSDRgtC10LrRg9GJ0LjQuSDRhtC10L3QvdC40LonKTtcbiAgICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gTnVtYmVyKGNhbGN1bGF0ZShiYXNlS29wZWNrcykpO1xuICAgICAgICAgICAgICAgIGVudHJpZXMucHVzaCh7IGlkOiBwcm9kdWN0LmlkLCBuYW1lOiBjYXJkLm5hbWUsIGJhc2U6IGJhc2VLb3BlY2tzLCBvbGQsIG5ldzogbmV4dCB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLnZhbGlkYXRpb24gPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc2tpcHBlZC5wdXNoKHsgbmFtZTogbGFiZWwsIHJlYXNvbjogZXJyb3IubWVzc2FnZSB9KTtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9yZGVyTmFtZTogb3JkZXIubmFtZSwgc2lnbmF0dXJlOiBkb2N1bWVudFNpZ25hdHVyZShvcmRlciwgcG9zaXRpb25zKSwgZW50cmllcywgc2tpcHBlZCB9O1xuICAgIH1cblxuICAgIGFzeW5jIGZ1bmN0aW9uIHBsYW4ocmVhZCkge1xuICAgICAgICByZXR1cm4gbWFrZVBsYW4ocmVhZCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGlmZmVyZW5jZXMoZW50cmllcykge1xuICAgICAgICBjb25zdCBjaGFuZ2VkID0ge307XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgICAgaWYgKGVudHJ5ICYmIGVudHJ5Lm5ldyAhPT0gZW50cnkub2xkKSB7XG4gICAgICAgICAgICAgICAgY2hhbmdlZFtlbnRyeS5pZF0gPSB7IGJhc2U6IGVudHJ5LmJhc2UsIG9sZDogZW50cnkub2xkLCBuZXc6IGVudHJ5Lm5ldyB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjaGFuZ2VkO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG1ldGFDb3B5KG1ldGEpIHtcbiAgICAgICAgaWYgKCFtZXRhIHx8IHR5cGVvZiBtZXRhICE9PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgncHJpY2VzJywgJ9Cd0LXRgiDQvNC10YLQsNC00LDQvdC90YvRhSDRgtC40L/QsCDRhtC10L3RiycpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xuICAgICAgICBPYmplY3Qua2V5cyhtZXRhKS5mb3JFYWNoKGtleSA9PiB7IHJlc3VsdFtrZXldID0gbWV0YVtrZXldOyB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBwYXlsb2FkRm9yKGVudHJ5LCB0YXJnZXRQcmljZSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc2FsZVByaWNlczogW3tcbiAgICAgICAgICAgICAgICB2YWx1ZTogZW50cnkubmV3LFxuICAgICAgICAgICAgICAgIHByaWNlVHlwZTogeyBtZXRhOiBtZXRhQ29weSh0YXJnZXRQcmljZS5wcmljZVR5cGUubWV0YSkgfSxcbiAgICAgICAgICAgICAgICBjdXJyZW5jeTogeyBtZXRhOiBtZXRhQ29weSh0YXJnZXRQcmljZS5jdXJyZW5jeS5tZXRhKSB9XG4gICAgICAgICAgICB9XVxuICAgICAgICB9O1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHZlcmlmeVdyaXRhYmxlKGNhcmQsIGVudHJ5LCBiZWZvcmUpIHtcbiAgICAgICAgaWYgKCFjYXJkIHx8IGNhcmQuaWQgIT09IGVudHJ5LmlkIHx8IGNhcmQubmFtZSAhPT0gZW50cnkubmFtZSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnaWRlbnRpdHknLCAn0JrQsNGA0YLQvtGH0LrQsCDQuNC30LzQtdC90LjQu9Cw0YHRjCDQstC+INCy0YDQtdC80Y8g0L/QtdGA0LXQvtGG0LXQvdC60LgnKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBiYXNlUHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBCQVNFX1BSSUNFX1RZUEVfSUQsIEJBU0VfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgY29uc3QgdGFyZ2V0UHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBUQVJHRVRfUFJJQ0VfVFlQRV9JRCwgVEFSR0VUX1BSSUNFX1RZUEVfTkFNRSk7XG4gICAgICAgIGlmIChpbnRlZ2VyKGJhc2VQcmljZS52YWx1ZSkgIT09IGVudHJ5LmJhc2UpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2Jhc2UnLCAn0JHQsNC30L7QstCw0Y8g0YbQtdC90LAg0LjQt9C80LXQvdC40LvQsNGB0Ywg0LLQviDQstGA0LXQvNGPINC/0LXRgNC10L7RhtC10L3QutC4Jyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGludGVnZXIodGFyZ2V0UHJpY2UudmFsdWUpICE9PSBlbnRyeS5uZXcpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3RhcmdldCcsICfQptC10L3QvdC40Log0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTRkdC9INC+0LHRgNCw0YLQvdGL0Lwg0YfRgtC10L3QuNC10LwnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGFyZ2V0UHJpY2UuY3VycmVuY3kubWV0YS5ocmVmICE9PSBzZWxlY3RQcmljZShiZWZvcmUsIFRBUkdFVF9QUklDRV9UWVBFX0lELCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKS5jdXJyZW5jeS5tZXRhLmhyZWYpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2N1cnJlbmN5JywgJ9CY0LfQvNC10L3QuNC70LDRgdGMINCy0LDQu9GO0YLQsCDRhtC10LvQtdCy0L7QuSDRhtC10L3RiycpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjYW5vbmljYWwob3RoZXJQcmljZXMoY2FyZCkpICE9PSBjYW5vbmljYWwob3RoZXJQcmljZXMoYmVmb3JlKSkpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3ByaWNlcycsICfQmNC30LzQtdC90LjQu9GB0Y8g0LTRgNGD0LPQvtC5INGC0LjQvyDRhtC10L3RiycpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjYW5vbmljYWwoYnVzaW5lc3NGaWVsZHMoY2FyZCkpICE9PSBjYW5vbmljYWwoYnVzaW5lc3NGaWVsZHMoYmVmb3JlKSkpIHtcbiAgICAgICAgICAgIHRocm93IGludmFsaWQoJ2ZpZWxkcycsICfQmNC30LzQtdC90LjQu9C40YHRjCDQtNGA0YPQs9C40LUg0L/QvtC70Y8g0LrQsNGA0YLQvtGH0LrQuCcpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gdmVyaWZ5U3RhYmxlKGNhcmQsIGVudHJ5LCBleHBlY3RlZCwgcmVhZCwgYmFzZSwgY2FjaGUpIHtcbiAgICAgICAgaWYgKCFjYXJkIHx8IGNhcmQuaWQgIT09IGVudHJ5LmlkIHx8IGNhcmQubmFtZSAhPT0gZW50cnkubmFtZSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnaWRlbnRpdHknLCAn0JjRgtC+0LPQvtCy0LDRjyDQutCw0YDRgtC+0YfQutCwINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINC/0LvQsNC90L7QvCcpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGJhc2VQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIEJBU0VfUFJJQ0VfVFlQRV9JRCwgQkFTRV9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICBjb25zdCB0YXJnZXRQcmljZSA9IHNlbGVjdFByaWNlKGNhcmQsIFRBUkdFVF9QUklDRV9UWVBFX0lELCBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgYXdhaXQgcmVxdWlyZVJ1YmxlKHJlYWQsIGJhc2VQcmljZSwgYmFzZSwgY2FjaGUpO1xuICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgdGFyZ2V0UHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgaWYgKGludGVnZXIoYmFzZVByaWNlLnZhbHVlKSAhPT0gZW50cnkuYmFzZSkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnYmFzZScsICfQmNGC0L7Qs9C+0LLQsNGPINCx0LDQt9C+0LLQsNGPINGG0LXQvdCwINC90LUg0YHQvtCy0L/QsNC00LDQtdGCJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGludGVnZXIodGFyZ2V0UHJpY2UudmFsdWUpICE9PSBleHBlY3RlZCkge1xuICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgndGFyZ2V0JywgJ9CY0YLQvtCz0L7QstGL0Lkg0YbQtdC90L3QuNC6INC90LUg0YHQvtCy0L/QsNC00LDQtdGCJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBtYWtlSm91cm5hbChmcmVzaCwgY2hhbmdlZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc3RhdHVzOiAnd3JpdGluZycsXG4gICAgICAgICAgICBjaGVja2VkOiAwLFxuICAgICAgICAgICAgdmVyaWZpZWQ6IDAsXG4gICAgICAgICAgICBzaWduYXR1cmU6IGZyZXNoLnNpZ25hdHVyZSxcbiAgICAgICAgICAgIHRvdGFsOiBmcmVzaC5lbnRyaWVzLmxlbmd0aCxcbiAgICAgICAgICAgIGNoYW5nZWQ6IGNoYW5nZWQubGVuZ3RoLFxuICAgICAgICAgICAgaW50ZW50OiBudWxsLFxuICAgICAgICAgICAgcmVjb3JkczogY2hhbmdlZC5tYXAoZW50cnkgPT4gKHtcbiAgICAgICAgICAgICAgICBpZDogZW50cnkuaWQsXG4gICAgICAgICAgICAgICAgbmFtZTogZW50cnkubmFtZSxcbiAgICAgICAgICAgICAgICBvbGQ6IGVudHJ5Lm9sZCxcbiAgICAgICAgICAgICAgICBuZXc6IGVudHJ5Lm5ldyxcbiAgICAgICAgICAgICAgICBvdXRjb21lOiAncGVuZGluZydcbiAgICAgICAgICAgIH0pKSxcbiAgICAgICAgICAgIGVycm9yOiBudWxsXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCkge1xuICAgICAgICBpZiAodHlwZW9mIHBlcnNpc3QgIT09ICdmdW5jdGlvbicpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3Qgc25hcHNob3QgPSBjb3B5KGpvdXJuYWwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgcGVyc2lzdChzbmFwc2hvdCk7XG4gICAgICAgICAgICByZXR1cm4gc3RvcmVkICE9PSBudWxsICYmIHR5cGVvZiBzdG9yZWQgPT09ICdvYmplY3QnXG4gICAgICAgICAgICAgICAgJiYgY2Fub25pY2FsKHN0b3JlZCkgPT09IGNhbm9uaWNhbChzbmFwc2hvdCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzZXRPdXRjb21lKGpvdXJuYWwsIGlkLCBvdXRjb21lKSB7XG4gICAgICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGpvdXJuYWwucmVjb3Jkcykge1xuICAgICAgICAgICAgaWYgKHJlY29yZC5pZCA9PT0gaWQpIHJlY29yZC5vdXRjb21lID0gb3V0Y29tZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJlY291bnQoam91cm5hbCkge1xuICAgICAgICBsZXQgY2hlY2tlZCA9IDA7XG4gICAgICAgIGxldCB2ZXJpZmllZCA9IDA7XG4gICAgICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGpvdXJuYWwucmVjb3Jkcykge1xuICAgICAgICAgICAgaWYgKHJlY29yZC5vdXRjb21lID09PSAncGVuZGluZycgfHwgcmVjb3JkLm91dGNvbWUgPT09ICd3cml0aW5nJykgY29udGludWU7XG4gICAgICAgICAgICBjaGVja2VkICs9IDE7XG4gICAgICAgICAgICBpZiAocmVjb3JkLm91dGNvbWUgPT09ICd2ZXJpZmllZCcgfHwgcmVjb3JkLm91dGNvbWUgPT09ICdhcHBsaWVkJ1xuICAgICAgICAgICAgICAgIHx8IHJlY29yZC5vdXRjb21lID09PSAnYXBwbGllZC1hZnRlci1lcnJvcicpIHZlcmlmaWVkICs9IDE7XG4gICAgICAgIH1cbiAgICAgICAgam91cm5hbC5jaGVja2VkID0gY2hlY2tlZDtcbiAgICAgICAgam91cm5hbC52ZXJpZmllZCA9IHZlcmlmaWVkO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGZhaWx1cmVTdGF0dXMoam91cm5hbCkge1xuICAgICAgICByZXR1cm4gam91cm5hbC52ZXJpZmllZCA+IDAgPyAnaW50ZXJydXB0ZWQnIDogJ2ZhaWxlZCc7XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gZmluYWxBdWRpdChqb3VybmFsLCByZWFkLCBmcmVzaCkge1xuICAgICAgICBsZXQgY2hlY2tlZCA9IDA7XG4gICAgICAgIGxldCB2ZXJpZmllZCA9IDA7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBjYWNoZSA9IG5ldyBNYXAoKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZnJlc2guZW50cmllcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhcmQgPSBhd2FpdCByZWFkSnNvbihyZWFkLCAnL2VudGl0eS9wcm9kdWN0LycgKyBlbnRyeS5pZCk7XG4gICAgICAgICAgICAgICAgY2FyZEJhc2UoY2FyZCwgZW50cnkuaWQpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHZlcmlmeVN0YWJsZShjYXJkLCBlbnRyeSwgZW50cnkubmV3LCByZWFkLCBBUEksIGNhY2hlKTtcbiAgICAgICAgICAgICAgICBjaGVja2VkICs9IDE7XG4gICAgICAgICAgICAgICAgdmVyaWZpZWQgKz0gMTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IG9yZGVyID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgJy9lbnRpdHkvaW50ZXJuYWxvcmRlci8nICsgT1JERVJfSUQpO1xuICAgICAgICAgICAgY29uc3QgYmFzZSA9IG9yZGVyQmFzZShvcmRlcik7XG4gICAgICAgICAgICBpZiAoIW9yZGVyIHx8IG9yZGVyLmlkICE9PSBPUkRFUl9JRCB8fCBvcmRlci5uYW1lICE9PSBmcmVzaC5vcmRlck5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdpZGVudGl0eScsICfQmNGC0L7Qs9C+0LLRi9C5INCy0L3Rg9GC0YDQtdC90L3QuNC5INC30LDQutCw0Lcg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGVuZHBvaW50ID0gJy9lbnRpdHkvaW50ZXJuYWxvcmRlci8nICsgT1JERVJfSUQgKyAnL3Bvc2l0aW9ucyc7XG4gICAgICAgICAgICBjb25zdCBwb3NpdGlvbnMgPSBhd2FpdCBjb2xsZWN0UGFnZXMocmVhZCxcbiAgICAgICAgICAgICAgICBlbmRwb2ludCArICc/ZXhwYW5kPWFzc29ydG1lbnQmbGltaXQ9JyArIFBPU0lUSU9OU19MSU1JVCwgYmFzZSwgZW5kcG9pbnQpO1xuICAgICAgICAgICAgaWYgKGRvY3VtZW50U2lnbmF0dXJlKG9yZGVyLCBwb3NpdGlvbnMpICE9PSBmcmVzaC5zaWduYXR1cmUpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9IGZhaWx1cmVTdGF0dXMoam91cm5hbCk7XG4gICAgICAgICAgICAgICAgam91cm5hbC5jaGVja2VkID0gY2hlY2tlZDtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnZlcmlmaWVkID0gdmVyaWZpZWQ7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdzaWduYXR1cmUtY2hhbmdlZCc7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBqb3VybmFsLmNoZWNrZWQgPSBjaGVja2VkO1xuICAgICAgICAgICAgam91cm5hbC52ZXJpZmllZCA9IHZlcmlmaWVkO1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAndmVyaWZpZWQnO1xuICAgICAgICAgICAgam91cm5hbC5pbnRlbnQgPSBudWxsO1xuICAgICAgICAgICAgam91cm5hbC5lcnJvciA9IG51bGw7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJlY29yZCBvZiBqb3VybmFsLnJlY29yZHMpIHJlY29yZC5vdXRjb21lID0gJ3ZlcmlmaWVkJztcbiAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSBmYWlsdXJlU3RhdHVzKGpvdXJuYWwpO1xuICAgICAgICAgICAgam91cm5hbC5jaGVja2VkID0gY2hlY2tlZDtcbiAgICAgICAgICAgIGpvdXJuYWwudmVyaWZpZWQgPSB2ZXJpZmllZDtcbiAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSAnZmluYWwtcmVhZC1mYWlsZWQnO1xuICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBmaW5pc2goam91cm5hbCwgcGVyc2lzdCkge1xuICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgaWYgKGpvdXJuYWwuc3RhdHVzID09PSAndmVyaWZpZWQnICYmICFzdG9yZWQpIHtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3VuY2VydGFpbic7XG4gICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3BlcnNpc3QtZmFpbGVkJztcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiBhcHBseShwcmV2aWV3LCBwb3J0cykge1xuICAgICAgICBjb25zdCBvcHRpb25zID0gcG9ydHMgfHwge307XG4gICAgICAgIGNvbnN0IHJlYWQgPSBvcHRpb25zLnJlYWQ7XG4gICAgICAgIGNvbnN0IHdyaXRlID0gb3B0aW9ucy53cml0ZTtcbiAgICAgICAgY29uc3QgcGVyc2lzdCA9IG9wdGlvbnMucGVyc2lzdDtcbiAgICAgICAgaWYgKHR5cGVvZiByZWFkICE9PSAnZnVuY3Rpb24nIHx8IHR5cGVvZiB3cml0ZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignYXBwbHkgcmVxdWlyZXMgcmVhZCBhbmQgd3JpdGUgZnVuY3Rpb25zJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFwcmV2aWV3IHx8IHR5cGVvZiBwcmV2aWV3ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgcHJldmlldy5zaWduYXR1cmUgIT09ICdzdHJpbmcnXG4gICAgICAgICAgICB8fCAhQXJyYXkuaXNBcnJheShwcmV2aWV3LmVudHJpZXMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdhcHBseSByZXF1aXJlcyBhbiBleHBsaWNpdGx5IGNhcHR1cmVkIHByZXZpZXcnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmcmVzaDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZyZXNoID0gYXdhaXQgbWFrZVBsYW4ocmVhZCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIHN0YXR1czogJ2ZhaWxlZCcsIGNoZWNrZWQ6IDAsIHZlcmlmaWVkOiAwLFxuICAgICAgICAgICAgICAgIHNpZ25hdHVyZTogcHJldmlldy5zaWduYXR1cmUsIHRvdGFsOiAwLCBjaGFuZ2VkOiAwLFxuICAgICAgICAgICAgICAgIGludGVudDogbnVsbCwgcmVjb3JkczogW10sIGVycm9yOiAncGxhbi1mYWlsZWQnXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY2hhbmdlZCA9IGZyZXNoLmVudHJpZXMuZmlsdGVyKGVudHJ5ID0+IGVudHJ5Lm5ldyAhPT0gZW50cnkub2xkKTtcbiAgICAgICAgY29uc3Qgam91cm5hbCA9IG1ha2VKb3VybmFsKGZyZXNoLCBjaGFuZ2VkKTtcbiAgICAgICAgY29uc3Qgc29ydGVkID0gcm93cyA9PiByb3dzLnNsaWNlKCkuc29ydCgobGVmdCwgcmlnaHQpID0+IGxlZnQuaWQubG9jYWxlQ29tcGFyZShyaWdodC5pZCkpO1xuICAgICAgICBjb25zdCBzdGFsZSA9IGZyZXNoLnNpZ25hdHVyZSAhPT0gcHJldmlldy5zaWduYXR1cmVcbiAgICAgICAgICAgIHx8IGNhbm9uaWNhbChzb3J0ZWQoZnJlc2guZW50cmllcykpICE9PSBjYW5vbmljYWwoc29ydGVkKHByZXZpZXcuZW50cmllcykpXG4gICAgICAgICAgICB8fCBjYW5vbmljYWwoZnJlc2guc2tpcHBlZCkgIT09IGNhbm9uaWNhbChwcmV2aWV3LnNraXBwZWQpO1xuICAgICAgICBpZiAoc3RhbGUpIHtcbiAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ2ZhaWxlZCc7XG4gICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3N0YWxlLXByZXZpZXcnO1xuICAgICAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghY2hhbmdlZC5sZW5ndGgpIHtcbiAgICAgICAgICAgIGNvbnN0IGF1ZGl0ZWQgPSBhd2FpdCBmaW5hbEF1ZGl0KGpvdXJuYWwsIHJlYWQsIGZyZXNoKTtcbiAgICAgICAgICAgIHJldHVybiBmaW5pc2goYXVkaXRlZCwgcGVyc2lzdCk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGNoYW5nZWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSAnL2VudGl0eS9wcm9kdWN0LycgKyBlbnRyeS5pZDtcbiAgICAgICAgICAgIGxldCBiZWZvcmU7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGJlZm9yZSA9IGF3YWl0IHJlYWRKc29uKHJlYWQsIHBhdGgpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9IGZhaWx1cmVTdGF0dXMoam91cm5hbCk7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdwcmV3cml0ZS1yZWFkLWZhaWxlZCc7XG4gICAgICAgICAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRQcmljZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaWYgKCFiZWZvcmUgfHwgYmVmb3JlLmlkICE9PSBlbnRyeS5pZCB8fCBiZWZvcmUubmFtZSAhPT0gZW50cnkubmFtZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdpZGVudGl0eScsICfQmtCw0YDRgtC+0YfQutCwINC40LfQvNC10L3QuNC70LDRgdGMINC/0L7RgdC70LUg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGA0LAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgYmFzZVByaWNlID0gc2VsZWN0UHJpY2UoYmVmb3JlLCBCQVNFX1BSSUNFX1RZUEVfSUQsIEJBU0VfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgICAgICAgICB0YXJnZXRQcmljZSA9IHNlbGVjdFByaWNlKGJlZm9yZSwgVEFSR0VUX1BSSUNFX1RZUEVfSUQsIFRBUkdFVF9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICAgICAgICAgIGlmIChpbnRlZ2VyKGJhc2VQcmljZS52YWx1ZSkgIT09IGVudHJ5LmJhc2VcbiAgICAgICAgICAgICAgICAgICAgfHwgaW50ZWdlcih0YXJnZXRQcmljZS52YWx1ZSkgIT09IGVudHJ5Lm9sZCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCdwcmV2aWV3JywgJ9Cm0LXQvdCwINC40LfQvNC10L3QuNC70LDRgdGMINC/0L7RgdC70LUg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGA0LAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgYmFzZSA9IGNhcmRCYXNlKGJlZm9yZSwgZW50cnkuaWQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhY2hlID0gbmV3IE1hcCgpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVpcmVSdWJsZShyZWFkLCBiYXNlUHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgdGFyZ2V0UHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSBmYWlsdXJlU3RhdHVzKGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuZXJyb3IgPSBlcnJvciAmJiBlcnJvci52YWxpZGF0aW9uID09PSB0cnVlXG4gICAgICAgICAgICAgICAgICAgID8gJ3ByZXdyaXRlLW1pc21hdGNoJyA6ICdwcmV3cml0ZS1yZWFkLWZhaWxlZCc7XG4gICAgICAgICAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGpvdXJuYWw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGpvdXJuYWwuaW50ZW50ID0ge1xuICAgICAgICAgICAgICAgIGlkOiBlbnRyeS5pZCxcbiAgICAgICAgICAgICAgICBuYW1lOiBlbnRyeS5uYW1lLFxuICAgICAgICAgICAgICAgIHBhdGgsXG4gICAgICAgICAgICAgICAgYmFzZTogZW50cnkuYmFzZSxcbiAgICAgICAgICAgICAgICBvbGQ6IGVudHJ5Lm9sZCxcbiAgICAgICAgICAgICAgICBuZXc6IGVudHJ5Lm5ldyxcbiAgICAgICAgICAgICAgICBwcmljZVR5cGU6IHtcbiAgICAgICAgICAgICAgICAgICAgaWQ6IFRBUkdFVF9QUklDRV9UWVBFX0lELFxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBUQVJHRVRfUFJJQ0VfVFlQRV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICBocmVmOiBTdHJpbmcodGFyZ2V0UHJpY2UucHJpY2VUeXBlLm1ldGEuaHJlZilcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGN1cnJlbmN5OiB7IGhyZWY6IFN0cmluZyh0YXJnZXRQcmljZS5jdXJyZW5jeS5tZXRhLmhyZWYpIH0sXG4gICAgICAgICAgICAgICAgb3RoZXJzOiBvdGhlclByaWNlcyhiZWZvcmUpLFxuICAgICAgICAgICAgICAgIGZpZWxkczogY2Fub25pY2FsKGJ1c2luZXNzRmllbGRzKGJlZm9yZSkpXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAnd3JpdGluZyc7XG4gICAgICAgICAgICBzZXRPdXRjb21lKGpvdXJuYWwsIGVudHJ5LmlkLCAnd3JpdGluZycpO1xuICAgICAgICAgICAgcmVjb3VudChqb3VybmFsKTtcbiAgICAgICAgICAgIGlmICghYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCkpIHtcbiAgICAgICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICdmYWlsZWQnO1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuaW50ZW50ID0gbnVsbDtcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3BlcnNpc3QtZmFpbGVkJztcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IHBheWxvYWRGb3IoZW50cnksIHRhcmdldFByaWNlKTtcbiAgICAgICAgICAgIGxldCB3cml0ZUZhaWxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBhd2FpdCB3cml0ZShwYXRoLCBwYXlsb2FkKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgd3JpdGVGYWlsZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgYWZ0ZXI7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGFmdGVyID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgcGF0aCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ3VuY2VydGFpbic7XG4gICAgICAgICAgICAgICAgam91cm5hbC5lcnJvciA9ICdyZWFkYmFjay1mYWlsZWQnO1xuICAgICAgICAgICAgICAgIHNldE91dGNvbWUoam91cm5hbCwgZW50cnkuaWQsICd1bmNlcnRhaW4nKTtcbiAgICAgICAgICAgICAgICByZWNvdW50KGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgICAgIHJldHVybiBqb3VybmFsO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHZlcmlmeVdyaXRhYmxlKGFmdGVyLCBlbnRyeSwgYmVmb3JlKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAndW5jZXJ0YWluJztcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gd3JpdGVGYWlsZWQgPyAnd3JpdGUtZmFpbGVkLXVudmVyaWZpZWQnIDogJ3JlYWRiYWNrLW1pc21hdGNoJztcbiAgICAgICAgICAgICAgICBzZXRPdXRjb21lKGpvdXJuYWwsIGVudHJ5LmlkLCAndW5jZXJ0YWluJyk7XG4gICAgICAgICAgICAgICAgcmVjb3VudChqb3VybmFsKTtcbiAgICAgICAgICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgam91cm5hbC5pbnRlbnQgPSBudWxsO1xuICAgICAgICAgICAgc2V0T3V0Y29tZShqb3VybmFsLCBlbnRyeS5pZCwgd3JpdGVGYWlsZWQgPyAnYXBwbGllZC1hZnRlci1lcnJvcicgOiAndmVyaWZpZWQnKTtcbiAgICAgICAgICAgIHJlY291bnQoam91cm5hbCk7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpKSB7XG4gICAgICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAndW5jZXJ0YWluJztcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3BlcnNpc3QtZmFpbGVkJztcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh3cml0ZUZhaWxlZCkge1xuICAgICAgICAgICAgICAgIGpvdXJuYWwuc3RhdHVzID0gJ2ludGVycnVwdGVkJztcbiAgICAgICAgICAgICAgICBqb3VybmFsLmVycm9yID0gJ3dyaXRlLWZhaWxlZC1hcHBsaWVkJztcbiAgICAgICAgICAgICAgICBhd2FpdCBzYXZlSm91cm5hbChwZXJzaXN0LCBqb3VybmFsKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gam91cm5hbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGF1ZGl0ZWQgPSBhd2FpdCBmaW5hbEF1ZGl0KGpvdXJuYWwsIHJlYWQsIGZyZXNoKTtcbiAgICAgICAgcmV0dXJuIGZpbmlzaChhdWRpdGVkLCBwZXJzaXN0KTtcbiAgICB9XG5cbiAgICBhc3luYyBmdW5jdGlvbiB1bnJlc29sdmVkKGpvdXJuYWwsIHBlcnNpc3QpIHtcbiAgICAgICAgam91cm5hbC5zdGF0dXMgPSAndW5jZXJ0YWluJztcbiAgICAgICAgYXdhaXQgc2F2ZUpvdXJuYWwocGVyc2lzdCwgam91cm5hbCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdW1tYXJ5OiAnaW50ZXJydXB0ZWQnLCBzdGF0dXM6IGpvdXJuYWwuc3RhdHVzLCByZXNvbHZlZDogZmFsc2UsIGJsb2NrZWQ6IHRydWUsXG4gICAgICAgICAgICBvdXRjb21lOiAndW5yZXNvbHZlZCcsIGNoZWNrZWQ6IGpvdXJuYWwuY2hlY2tlZCwgdmVyaWZpZWQ6IGpvdXJuYWwudmVyaWZpZWQsXG4gICAgICAgICAgICBpbnRlbnQ6IGpvdXJuYWwuaW50ZW50XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgYXN5bmMgZnVuY3Rpb24gcmVjb25jaWxlKGpvdXJuYWwsIHBvcnRzKSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBwb3J0cyB8fCB7fTtcbiAgICAgICAgY29uc3QgcmVhZCA9IG9wdGlvbnMucmVhZDtcbiAgICAgICAgY29uc3QgcGVyc2lzdCA9IG9wdGlvbnMucGVyc2lzdDtcbiAgICAgICAgaWYgKHR5cGVvZiByZWFkICE9PSAnZnVuY3Rpb24nKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdyZWNvbmNpbGUgcmVxdWlyZXMgYSByZWFkIGZ1bmN0aW9uJyk7XG4gICAgICAgIGlmICgham91cm5hbCB8fCB0eXBlb2Ygam91cm5hbCAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3JlY29uY2lsZSByZXF1aXJlcyBhIGpvdXJuYWwnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGpvdXJuYWwgPSBjb3B5KGpvdXJuYWwpO1xuICAgICAgICBjb25zdCBpbnRlbnQgPSBqb3VybmFsLmludGVudDtcbiAgICAgICAgaWYgKGpvdXJuYWwuc3RhdHVzID09PSAndmVyaWZpZWQnICYmICFpbnRlbnQpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3VtbWFyeTogJ2ZpbmlzaGVkJywgc3RhdHVzOiAndmVyaWZpZWQnLCByZXNvbHZlZDogdHJ1ZSwgYmxvY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgb3V0Y29tZTogJ3ZlcmlmaWVkJywgY2hlY2tlZDogam91cm5hbC5jaGVja2VkLCB2ZXJpZmllZDogam91cm5hbC52ZXJpZmllZCwgaW50ZW50OiBudWxsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGlmICghaW50ZW50KSB7XG4gICAgICAgICAgICBqb3VybmFsLnN0YXR1cyA9ICdpbnRlcnJ1cHRlZCc7XG4gICAgICAgICAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBzdW1tYXJ5OiAnaW50ZXJydXB0ZWQnLCBzdGF0dXM6IGpvdXJuYWwuc3RhdHVzLCByZXNvbHZlZCwgYmxvY2tlZDogIXJlc29sdmVkLFxuICAgICAgICAgICAgICAgIG91dGNvbWU6ICdub25lJywgY2hlY2tlZDogam91cm5hbC5jaGVja2VkLCB2ZXJpZmllZDogam91cm5hbC52ZXJpZmllZCwgaW50ZW50OiBudWxsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNhcmQ7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIVVVSURfUEFUVEVSTi50ZXN0KGludGVudC5pZCkgfHwgaW50ZW50LnBhdGggIT09ICcvZW50aXR5L3Byb2R1Y3QvJyArIGludGVudC5pZCkgdGhyb3cgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90L7QtSDQvdCw0LzQtdGA0LXQvdC40LUg0LfQsNC/0LjRgdC4Jyk7XG4gICAgICAgICAgICBjYXJkID0gYXdhaXQgcmVhZEpzb24ocmVhZCwgaW50ZW50LnBhdGgpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHVucmVzb2x2ZWQoam91cm5hbCwgcGVyc2lzdCk7XG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKCFjYXJkIHx8IGNhcmQuaWQgIT09IGludGVudC5pZCB8fCBjYXJkLm5hbWUgIT09IGludGVudC5uYW1lKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnaWRlbnRpdHknLCAn0JrQsNGA0YLQvtGH0LrQsCDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDQvdCw0LzQtdGA0LXQvdC40LXQvCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYmFzZSA9IGNhcmRCYXNlKGNhcmQsIGludGVudC5pZCk7XG4gICAgICAgICAgICBjb25zdCBiYXNlUHJpY2UgPSBzZWxlY3RQcmljZShjYXJkLCBCQVNFX1BSSUNFX1RZUEVfSUQsIEJBU0VfUFJJQ0VfVFlQRV9OQU1FKTtcbiAgICAgICAgICAgIGNvbnN0IHRhcmdldFByaWNlID0gc2VsZWN0UHJpY2UoY2FyZCwgVEFSR0VUX1BSSUNFX1RZUEVfSUQsIFRBUkdFVF9QUklDRV9UWVBFX05BTUUpO1xuICAgICAgICAgICAgY29uc3QgY2FjaGUgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgYmFzZVByaWNlLCBiYXNlLCBjYWNoZSk7XG4gICAgICAgICAgICBhd2FpdCByZXF1aXJlUnVibGUocmVhZCwgdGFyZ2V0UHJpY2UsIGJhc2UsIGNhY2hlKTtcbiAgICAgICAgICAgIGlmIChpbnRlZ2VyKGJhc2VQcmljZS52YWx1ZSkgIT09IGludGVudC5iYXNlKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnYmFzZScsICfQkdCw0LfQvtCy0LDRjyDRhtC10L3QsCDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDQvdCw0LzQtdGA0LXQvdC40LXQvCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGNhbm9uaWNhbChvdGhlclByaWNlcyhjYXJkKSkgIT09IGNhbm9uaWNhbChpbnRlbnQub3RoZXJzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IGludmFsaWQoJ3ByaWNlcycsICfQlNGA0YPQs9C40LUg0YLQuNC/0Ysg0YbQtdC9INC90LUg0YHQvtCy0L/QsNC00LDRjtGCINGBINC90LDQvNC10YDQtdC90LjQtdC8Jyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoY2Fub25pY2FsKGJ1c2luZXNzRmllbGRzKGNhcmQpKSAhPT0gaW50ZW50LmZpZWxkcyB8fCB0YXJnZXRQcmljZS5jdXJyZW5jeS5tZXRhLmhyZWYgIT09IGludGVudC5jdXJyZW5jeS5ocmVmXG4gICAgICAgICAgICAgICAgfHwgdGFyZ2V0UHJpY2UucHJpY2VUeXBlLm1ldGEuaHJlZiAhPT0gaW50ZW50LnByaWNlVHlwZS5ocmVmKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgaW52YWxpZCgnZmllbGRzJywgJ9Cf0L7Qu9GPINC60LDRgNGC0L7Rh9C60Lgg0L3QtSDRgdC+0LLQv9Cw0LTQsNGO0YIg0YEg0L3QsNC80LXRgNC10L3QuNC10LwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gaW50ZWdlcih0YXJnZXRQcmljZS52YWx1ZSk7XG4gICAgICAgICAgICBpZiAodmFsdWUgIT09IGludGVudC5vbGQgJiYgdmFsdWUgIT09IGludGVudC5uZXcpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBpbnZhbGlkKCd0YXJnZXQnLCAn0KbQtdC90L3QuNC6INC90LUg0YHQvtCy0L/QsNC00LDQtdGCINC90Lgg0YHQviDRgdGC0LDRgNGL0LwsINC90Lgg0YEg0L3QvtCy0YvQvCDQt9C90LDRh9C10L3QuNC10LwnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGFwcGxpZWQgPSB2YWx1ZSA9PT0gaW50ZW50Lm5ldztcbiAgICAgICAgICAgIHNldE91dGNvbWUoam91cm5hbCwgaW50ZW50LmlkLCBhcHBsaWVkID8gJ2FwcGxpZWQnIDogJ25vdC1hcHBsaWVkJyk7XG4gICAgICAgICAgICByZWNvdW50KGpvdXJuYWwpO1xuICAgICAgICAgICAgam91cm5hbC5pbnRlbnQgPSBudWxsO1xuICAgICAgICAgICAgam91cm5hbC5zdGF0dXMgPSAnaW50ZXJydXB0ZWQnO1xuICAgICAgICAgICAgam91cm5hbC5lcnJvciA9IG51bGw7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHNhdmVKb3VybmFsKHBlcnNpc3QsIGpvdXJuYWwpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgc3VtbWFyeTogJ2ludGVycnVwdGVkJywgc3RhdHVzOiAndW5jZXJ0YWluJywgcmVzb2x2ZWQ6IGZhbHNlLCBibG9ja2VkOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBvdXRjb21lOiAndW5yZXNvbHZlZCcsIGNoZWNrZWQ6IGpvdXJuYWwuY2hlY2tlZCwgdmVyaWZpZWQ6IGpvdXJuYWwudmVyaWZpZWQsXG4gICAgICAgICAgICAgICAgICAgIGludGVudDogeyBpZDogaW50ZW50LmlkLCBwYXRoOiBpbnRlbnQucGF0aCB9XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgc3VtbWFyeTogJ2ZpbmlzaGVkJywgc3RhdHVzOiAnaW50ZXJydXB0ZWQnLCByZXNvbHZlZDogdHJ1ZSwgYmxvY2tlZDogZmFsc2UsXG4gICAgICAgICAgICAgICAgb3V0Y29tZTogYXBwbGllZCA/ICdhcHBsaWVkJyA6ICdub3QtYXBwbGllZCcsXG4gICAgICAgICAgICAgICAgY2hlY2tlZDogam91cm5hbC5jaGVja2VkLCB2ZXJpZmllZDogam91cm5hbC52ZXJpZmllZCwgaW50ZW50OiBudWxsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHVucmVzb2x2ZWQoam91cm5hbCwgcGVyc2lzdCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7IHBsYW4sIGFwcGx5LCByZWNvbmNpbGUsIGNhbGN1bGF0ZSB9KTtcbn1cbiIsIi8vIE9uZSBNZW1jaGF0IHdyaXRlciBhY3Jvc3MgYWxsIG5hdGl2ZSBwYW5lbHMuIEFuIHVuZmluaXNoZWQgam91cm5hbCBzdXJ2aXZlcyB3b3JrZXIgcmVzdGFydHMuXG5jb25zdCBNRU1DSEFUX1JFUFJJQ0VfSk9VUk5BTCA9ICdtZW1jaGF0UmVwcmljZUpvdXJuYWxfdjEnO1xuXG5jb25zdCByZXByaWNlUHJldmlld3MgPSBuZXcgTWFwKCk7XG5jb25zdCByZXByaWNlU2V0dGluZ3MgPSBuZXcgTWFwKCk7XG5jb25zdCByZXByaWNlUGVuZGluZyA9IG5ldyBTZXQoKTtcbmxldCByZXByaWNlQnVzeSA9IGZhbHNlO1xuXG5mdW5jdGlvbiByZXByaWNlT3duZXIoc2VuZGVyKSB7XG4gICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHJldHVybiAnbmF0aXZlOicgKyBzZW5kZXIudXJsO1xuICAgIGlmICh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpICYmIHR5cGVvZiBzZW5kZXIuZG9jdW1lbnRJZCA9PT0gJ3N0cmluZycgJiYgc2VuZGVyLmRvY3VtZW50SWQpIHtcbiAgICAgICAgcmV0dXJuIGBjb250ZW50OiR7c2VuZGVyLnRhYi5pZH06JHtzZW5kZXIuZG9jdW1lbnRJZH1gO1xuICAgIH1cbiAgICByZXR1cm4gJyc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcHJpY2VBY2Nlc3Moc2VuZGVyKSB7XG4gICAgaWYgKCFyZXByaWNlT3duZXIoc2VuZGVyKSkgdGhyb3cgRXJyb3IoJ9Cf0LDQvdC10LvRjCDQvtGC0LrQu9GO0YfQtdC90LAnKTtcbiAgICBjb25zdCBvcmlnaW4gPSBydW50aW1lU2VuZGVyT3JpZ2luKHNlbmRlcik7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VSZWFkeTtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZUNoYWluO1xuICAgIGNvbnN0IGtleSA9ICdtZW1jaGF0UHJpdmF0ZV92MTonICsgb3JpZ2luO1xuICAgIGNvbnN0IGJ1Y2tldCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XTtcbiAgICBjb25zdCBhcGkgPSBKU09OLnBhcnNlKGJ1Y2tldD8uaXRlbXM/LlsnbWVtY2hhdDpoYWNrZXJNc0FwaV92MSddPy52YWx1ZSB8fCAne30nKTtcbiAgICBpZiAoIXJlcHJpY2VPd25lcihzZW5kZXIpIHx8IGFwaS5iZWFyZXJFbmFibGVkICE9PSB0cnVlIHx8IHR5cGVvZiBhcGkudG9rZW4gIT09ICdzdHJpbmcnIHx8ICFhcGkudG9rZW4udHJpbSgpXG4gICAgICAgIHx8IHR5cGVvZiBhcGkucmVmZXJlbmNlU2NvcGUgIT09ICdzdHJpbmcnIHx8ICFhcGkucmVmZXJlbmNlU2NvcGUpIHRocm93IEVycm9yKCdCZWFyZXIg0L3QtdC00L7RgdGC0YPQv9C10L0nKTtcbiAgICByZXR1cm4geyBvcmlnaW4sIHNjb3BlOiBhcGkucmVmZXJlbmNlU2NvcGUsIHRva2VuOiBhcGkudG9rZW4gfTtcbn1cblxuZnVuY3Rpb24gcmVwcmljZVNhbWVBY2NvdW50KGxlZnQsIHJpZ2h0KSB7XG4gICAgcmV0dXJuIGxlZnQub3JpZ2luID09PSByaWdodC5vcmlnaW4gJiYgbGVmdC5zY29wZSA9PT0gcmlnaHQuc2NvcGU7XG59XG5cbmxldCBzYWxlc1NldHRpbmdzQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmZ1bmN0aW9uIHNhbGVzU2V0dGluZ3NNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IHdvcmsgPSBzYWxlc1NldHRpbmdzQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgYWNjb3VudElkIH0gPSBtZXNzYWdlO1xuICAgICAgICBjb25zdCBzYXZlID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzYWxlcy1zZXR0aW5ncy1zYXZlJztcbiAgICAgICAgaWYgKHR5cGVvZiBhY2NvdW50SWQgIT09ICdzdHJpbmcnIHx8ICFNRU1DSEFUX1JFUFJJQ0VfVVVJRC50ZXN0KGFjY291bnRJZCkpIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICBjb25zdCBjcmVkZW50aWFsID0gYXdhaXQgcmVwcmljZUFjY2VzcyhzZW5kZXIpO1xuICAgICAgICBjb25zdCBrZXkgPSAnbWVtY2hhdFNhbGVzU3RvcmVfdjE6JyArIGNyZWRlbnRpYWwub3JpZ2luICsgJzonICsgYWNjb3VudElkO1xuICAgICAgICBjb25zdCBzdG9yZUlkID0gc2F2ZSA/IG1lc3NhZ2Uuc3RvcmVJZCA6IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XTtcbiAgICAgICAgaWYgKCFzYXZlICYmIHN0b3JlSWQgPT0gbnVsbCkgcmV0dXJuIHsgb2s6IHRydWUsIHN0b3JlSWQ6IG51bGwgfTtcbiAgICAgICAgaWYgKHR5cGVvZiBzdG9yZUlkICE9PSAnc3RyaW5nJyB8fCAhTUVNQ0hBVF9SRVBSSUNFX1VVSUQudGVzdChzdG9yZUlkKSkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhY3RpdmUgPSBhd2FpdCByZXByaWNlQWNjZXNzKHNlbmRlcik7XG4gICAgICAgICAgICByZXR1cm4gcmVwcmljZVNhbWVBY2NvdW50KGFjdGl2ZSwgY3JlZGVudGlhbCkgJiYgYWN0aXZlLnRva2VuID09PSBjcmVkZW50aWFsLnRva2VuO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHBlcmZvcm1SZXF1ZXN0KHsgaWQ6ICdzYWxlcy1zdG9yZS0nICsgY3J5cHRvLnJhbmRvbVVVSUQoKSwgcmVxdWVzdDoge1xuICAgICAgICAgICAgdXJsOiBNRU1DSEFUX1JFUFJJQ0VfQVBJICsgJy9lbnRpdHkvc3RvcmUvJyArIHN0b3JlSWQsIG1ldGhvZDogJ0dFVCcsIGFub255bW91czogdHJ1ZSwgY3JlZGVudGlhbEd1YXJkOiB0cnVlLFxuICAgICAgICAgICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyICcgKyBjcmVkZW50aWFsLnRva2VuLCBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnIH0sXG4gICAgICAgIH0gfSwgc2VuZGVyLCB1bmRlZmluZWQsIGN1cnJlbnQpO1xuICAgICAgICBpZiAocmVzcG9uc2UuZXZlbnQgIT09ICdsb2FkJyB8fCAhYXdhaXQgY3VycmVudCgpKSByZXR1cm4geyBvazogZmFsc2UgfTtcbiAgICAgICAgaWYgKCFzYXZlICYmIHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cyA9PT0gNDA0KSByZXR1cm4geyBvazogdHJ1ZSwgc3RvcmVJZDogbnVsbCB9O1xuICAgICAgICBpZiAocmVzcG9uc2UucmVzcG9uc2Uuc3RhdHVzICE9PSAyMDApIHJldHVybiB7IG9rOiBmYWxzZSB9O1xuICAgICAgICBjb25zdCBzdG9yZSA9IEpTT04ucGFyc2UocmVzcG9uc2UucmVzcG9uc2UucmVzcG9uc2VUZXh0KTtcbiAgICAgICAgaWYgKHN0b3JlLmlkICE9PSBzdG9yZUlkIHx8IHN0b3JlLmFjY291bnRJZCAhPT0gYWNjb3VudElkIHx8IHN0b3JlLmFyY2hpdmVkID09PSB0cnVlKSB7XG4gICAgICAgICAgICByZXR1cm4gc2F2ZSA/IHsgb2s6IGZhbHNlIH0gOiB7IG9rOiB0cnVlLCBzdG9yZUlkOiBudWxsIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNhdmUpIHtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtrZXldOiBzdG9yZUlkIH0pO1xuICAgICAgICAgICAgaWYgKChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XSAhPT0gc3RvcmVJZCkgcmV0dXJuIHsgb2s6IGZhbHNlIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHN0b3JlSWQgfTtcbiAgICB9KTtcbiAgICBzYWxlc1NldHRpbmdzQ2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yay5jYXRjaCgoKSA9PiAoeyBvazogZmFsc2UgfSkpO1xufVxuXG5mdW5jdGlvbiByZXByaWNlUnVsZXNLZXkob3JpZ2luKSB7IHJldHVybiAnbWVtY2hhdFJlcHJpY2VSdWxlc192MTonICsgb3JpZ2luOyB9XG5cbmFzeW5jIGZ1bmN0aW9uIHJlcHJpY2VMb2FkUnVsZXMoYWNjZXNzKSB7XG4gICAgY29uc3Qga2V5ID0gcmVwcmljZVJ1bGVzS2V5KGFjY2Vzcy5vcmlnaW4pO1xuICAgIGNvbnN0IHJlY29yZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XTtcbiAgICBpZiAocmVjb3JkPy5zY29wZSAhPT0gYWNjZXNzLnNjb3BlKSByZXR1cm4gbnVsbDtcbiAgICBpZiAodHlwZW9mIHJlY29yZC5yZXZpc2lvbiAhPT0gJ3N0cmluZycgfHwgIXJlY29yZC5ydWxlcykgdGhyb3cgRXJyb3IoJ9Cf0YDQsNCy0LjQu9CwINC/0LXRgNC10L7RhtC10L3QutC4INC90LXQtNC+0YHRgtGD0L/QvdGLLicpO1xuICAgIHJldHVybiByZWNvcmQ7XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VPcmRlcklkKHJhdykge1xuICAgIGlmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gMjU2KSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBwcmVmaXggPSAnaHR0cHM6Ly9vbmxpbmUubW95c2tsYWQucnUvYXBwLyNpbnRlcm5hbG9yZGVyL2VkaXQ/aWQ9JztcbiAgICBjb25zdCB1cmwgPSByYXcudHJpbSgpO1xuICAgIGNvbnN0IGlkID0gdXJsLnNsaWNlKHByZWZpeC5sZW5ndGgpO1xuICAgIHJldHVybiB1cmwuc3RhcnRzV2l0aChwcmVmaXgpICYmIE1FTUNIQVRfUkVQUklDRV9VVUlELnRlc3QoaWQpID8gaWQgOiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXByaWNlTGl2ZShzZW5kZXIsIG9yaWdpbikge1xuICAgIGlmICh0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSByZXR1cm4gcnVudGltZVNlbmRlck9yaWdpbihzZW5kZXIpID09PSBvcmlnaW47XG4gICAgbGV0IHRpbWVyO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHNlbmRlci50YWIuaWQsIHsgdHlwZTogJ21lbWNoYXQ6cmVwcmljZS1jdXJyZW50JyB9LCB7IGRvY3VtZW50SWQ6IHNlbmRlci5kb2N1bWVudElkIH0pLFxuICAgICAgICAgICAgbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7IHRpbWVyID0gc2V0VGltZW91dChyZXNvbHZlLCAxMDAwKTsgfSlcbiAgICAgICAgXSk7XG4gICAgICAgIHJldHVybiByZXBseT8uY3VycmVudCA9PT0gdHJ1ZSAmJiByZXBseS51cmwgPT09IHNlbmRlci51cmwgJiYgbmV3IFVSTChyZXBseS51cmwpLm9yaWdpbiA9PT0gb3JpZ2luO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbiAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgfVxufVxuXG5mdW5jdGlvbiByZXByaWNlUmVtZW1iZXIobWFwLCBvd25lciwgdmFsdWUpIHtcbiAgICBtYXAuZGVsZXRlKG93bmVyKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiBtYXApIGlmIChlbnRyeS5leHBpcmVzIDwgRGF0ZS5ub3coKSkgbWFwLmRlbGV0ZShrZXkpO1xuICAgIGlmIChtYXAuc2l6ZSA+PSAzMikgcmV0dXJuIGZhbHNlO1xuICAgIG1hcC5zZXQob3duZXIsIHsgLi4udmFsdWUsIGV4cGlyZXM6IERhdGUubm93KCkgKyA1ICogNjAgKiAxMDAwIH0pO1xuICAgIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiByZXByaWNlUmVjb3ZlcnlDb25maWcoc2F2ZWQpIHtcbiAgICBpZiAoc2F2ZWQuY29uZmlnKSByZXR1cm4gc2F2ZWQuY29uZmlnO1xuICAgIC8vIFYxIGpvdXJuYWxzIHByZWRhdGUgY29uZmlndXJhYmxlIHJ1bGVzLiBVc2Ugb25seSB0aGUgSURzIGNhcHR1cmVkIGluIHRoZVxuICAgIC8vIG9yaWdpbmFsIGpvdXJuYWw7IHRoZSBsZWdhY3kgc2V0dXAga2V5IGFuZCBjdXJyZW50IGRlZmF1bHRzIGFyZSBub3QgbmVlZGVkLlxuICAgIGNvbnN0IG9sZCA9IEpTT04ucGFyc2Uoc2F2ZWQuY29uZmlnS2V5IHx8ICdudWxsJyk7XG4gICAgaWYgKCFvbGQgfHwgIVsnb3JkZXJJZCcsICdiYXNlVHlwZUlkJywgJ3RhcmdldFR5cGVJZCddLmV2ZXJ5KGtleSA9PlxuICAgICAgICB0eXBlb2Ygb2xkW2tleV0gPT09ICdzdHJpbmcnICYmIE1FTUNIQVRfUkVQUklDRV9VVUlELnRlc3Qob2xkW2tleV0pKSB8fCBvbGQuYmFzZVR5cGVJZCA9PT0gb2xkLnRhcmdldFR5cGVJZCkge1xuICAgICAgICB0aHJvdyBFcnJvcign0JbRg9GA0L3QsNC7INC90LXQtNC+0YHRgtGD0L/QtdC9Jyk7XG4gICAgfVxuICAgIHJldHVybiB7IG9yZGVySWQ6IG9sZC5vcmRlcklkLCBiYXNlVHlwZUlkOiBvbGQuYmFzZVR5cGVJZCwgdGFyZ2V0VHlwZUlkOiBvbGQudGFyZ2V0VHlwZUlkLFxuICAgICAgICB0YXJnZXRUeXBlTmFtZTogc2F2ZWQuam91cm5hbC5pbnRlbnQ/LnByaWNlVHlwZT8ubmFtZSB9O1xufVxuXG5mdW5jdGlvbiByZXByaWNlVW5maW5pc2hlZChyZWNvcmQpIHtcbiAgICByZXR1cm4gISFyZWNvcmQgJiYgKHJlY29yZC5qb3VybmFsPy5pbnRlbnQgIT0gbnVsbCB8fCAhWyd2ZXJpZmllZCcsICdpbnRlcnJ1cHRlZCcsICdmYWlsZWQnXS5pbmNsdWRlcyhyZWNvcmQuam91cm5hbD8uc3RhdHVzKSk7XG59XG5cbmZ1bmN0aW9uIHJlcHJpY2VKb3VybmFsSnNvbih2YWx1ZSkge1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSwgKF9rZXksIGl0ZW0pID0+IGl0ZW0gJiYgdHlwZW9mIGl0ZW0gPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KGl0ZW0pXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5rZXlzKGl0ZW0pLnNvcnQoKS5tYXAoa2V5ID0+IFtrZXksIGl0ZW1ba2V5XV0pKSA6IGl0ZW0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXByaWNlTG9hZEpvdXJuYWwoKSB7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VSZWFkeTtcbiAgICBjb25zdCByZWNvcmQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KE1FTUNIQVRfUkVQUklDRV9KT1VSTkFMKSlbTUVNQ0hBVF9SRVBSSUNFX0pPVVJOQUxdO1xuICAgIGlmIChyZWNvcmQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gICAgaWYgKCFyZWNvcmQgfHwgdHlwZW9mIHJlY29yZC5vcmlnaW4gIT09ICdzdHJpbmcnIHx8IHR5cGVvZiByZWNvcmQuc2NvcGUgIT09ICdzdHJpbmcnIHx8ICFyZWNvcmQuam91cm5hbFxuICAgICAgICB8fCAhWyd3cml0aW5nJywgJ3ZlcmlmaWVkJywgJ3VuY2VydGFpbicsICdpbnRlcnJ1cHRlZCcsICdmYWlsZWQnXS5pbmNsdWRlcyhyZWNvcmQuam91cm5hbC5zdGF0dXMpKSB0aHJvdyBFcnJvcign0JbRg9GA0L3QsNC7INC90LXQtNC+0YHRgtGD0L/QtdC9Jyk7XG4gICAgcmV0dXJuIHJlY29yZDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVwcmljZU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3QgYWN0aW9uID0gbWVzc2FnZS5hY3Rpb247XG4gICAgY29uc3QgcmVmdXNlID0gKGVycm9yLCByZWNvdmVyeSA9IGZhbHNlKSA9PiAoeyBvazogZmFsc2UsIGVycm9yLCByZWNvdmVyeSB9KTtcbiAgICBjb25zdCBvd25lciA9IHJlcHJpY2VPd25lcihzZW5kZXIpO1xuICAgIGlmICghb3duZXIgfHwgIVsncHJldmlldycsICdhcHBseScsICdyZWNvdmVyJywgJ3NldHRpbmdzLWxvYWQnLCAnc2V0dGluZ3Mtc2F2ZSddLmluY2x1ZGVzKGFjdGlvbikpIHtcbiAgICAgICAgcmV0dXJuIHJlZnVzZSgn0JfQsNC/0YDQvtGBINC/0LXRgNC10L7RhtC10L3QutC4INC+0YLQutC70L7QvdGR0L0uJyk7XG4gICAgfVxuICAgIGNvbnN0IHNldHRpbmdzID0gYWN0aW9uLnN0YXJ0c1dpdGgoJ3NldHRpbmdzLScpO1xuICAgIGNvbnN0IGNoYW5nZXNTdGF0ZSA9IFsnYXBwbHknLCAncmVjb3ZlcicsICdzZXR0aW5ncy1zYXZlJ10uaW5jbHVkZXMoYWN0aW9uKTtcbiAgICBpZiAocmVwcmljZUJ1c3kgfHwgcmVwcmljZVBlbmRpbmcuaGFzKG93bmVyKSkgcmV0dXJuIHJlZnVzZSgn0JTRgNGD0LPQvtC5INC30LDQv9GA0L7RgSDQv9C10YDQtdC+0YbQtdC90LrQuCDRg9C20LUg0LLRi9C/0L7Qu9C90Y/QtdGC0YHRjy4nKTtcbiAgICBjb25zdCBvcmRlcklkID0gYWN0aW9uID09PSAncHJldmlldycgPyByZXByaWNlT3JkZXJJZChtZXNzYWdlLm9yZGVyTGluaykgOiBudWxsO1xuICAgIGlmIChhY3Rpb24gPT09ICdwcmV2aWV3Jykge1xuICAgICAgICByZXByaWNlUHJldmlld3MuZGVsZXRlKG93bmVyKTtcbiAgICAgICAgaWYgKCFvcmRlcklkKSByZXR1cm4gcmVmdXNlKCfQktGB0YLQsNCy0YzRgtC1INGB0YHRi9C70LrRgyDQvdCwINCy0L3Rg9GC0YDQtdC90L3QuNC5INC30LDQutCw0Lcg0LjQtyBvbmxpbmUubW95c2tsYWQucnUuJyk7XG4gICAgfVxuICAgIGlmIChjaGFuZ2VzU3RhdGUpIHJlcHJpY2VCdXN5ID0gdHJ1ZTtcbiAgICByZXByaWNlUGVuZGluZy5hZGQob3duZXIpO1xuICAgIGxldCBlbnRlcmVkU2VydmljZSA9IGZhbHNlO1xuICAgIGxldCBydW5JZCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY3JlZGVudGlhbCA9IGF3YWl0IHJlcHJpY2VBY2Nlc3Moc2VuZGVyKTtcbiAgICAgICAgY29uc3QgcnVsZXNSZWNvcmQgPSBhY3Rpb24gPT09ICdyZWNvdmVyJyA/IG51bGwgOiBhd2FpdCByZXByaWNlTG9hZFJ1bGVzKGNyZWRlbnRpYWwpO1xuICAgICAgICBjb25zdCByZXZpc2lvbiA9IHJ1bGVzUmVjb3JkPy5yZXZpc2lvbiA/PyBudWxsO1xuICAgICAgICBjb25zdCBpc0N1cnJlbnQgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIWF3YWl0IHJlcHJpY2VMaXZlKHNlbmRlciwgY3JlZGVudGlhbC5vcmlnaW4pKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgcmVwcmljZUFjY2VzcyhzZW5kZXIpO1xuICAgICAgICAgICAgaWYgKCFyZXByaWNlU2FtZUFjY291bnQoY3VycmVudCwgY3JlZGVudGlhbCkgfHwgY3VycmVudC50b2tlbiAhPT0gY3JlZGVudGlhbC50b2tlbikgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgY29uc3QgbGF0ZXN0ID0gYWN0aW9uID09PSAncmVjb3ZlcicgPyBudWxsIDogYXdhaXQgcmVwcmljZUxvYWRSdWxlcyhjdXJyZW50KTtcbiAgICAgICAgICAgIHJldHVybiByZXByaWNlT3duZXIoc2VuZGVyKSA9PT0gb3duZXIgJiYgKGxhdGVzdD8ucmV2aXNpb24gPz8gbnVsbCkgPT09IHJldmlzaW9uXG4gICAgICAgICAgICAgICAgJiYgcmVwcmljZUpvdXJuYWxKc29uKGxhdGVzdD8ucnVsZXMgPz8gbnVsbCkgPT09IHJlcHJpY2VKb3VybmFsSnNvbihydWxlc1JlY29yZD8ucnVsZXMgPz8gbnVsbCk7XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHJlcXVlc3QgPSBhc3luYyAobWV0aG9kLCBwYXRoLCBib2R5KSA9PiB7XG4gICAgICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKE1FTUNIQVRfUkVQUklDRV9BUEkgKyBwYXRoKTtcbiAgICAgICAgICAgIGlmICh1cmwub3JpZ2luICE9PSAnaHR0cHM6Ly9hcGkubW95c2tsYWQucnUnIHx8ICEvXlxcL2FwaVxcL3JlbWFwXFwvMVxcLjJcXC8oPzplbnRpdHl8Y29udGV4dClcXC8vLnRlc3QodXJsLnBhdGhuYW1lKSB8fCB1cmwuaGFzaCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgQVBJIHBhdGgnKTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcGVyZm9ybVJlcXVlc3QoeyBpZDogJ3JlcHJpY2UtJyArIGNyeXB0by5yYW5kb21VVUlEKCksIHJlcXVlc3Q6IHtcbiAgICAgICAgICAgICAgICB1cmw6IHVybC5ocmVmLCBtZXRob2QsIGFub255bW91czogdHJ1ZSwgY3JlZGVudGlhbEd1YXJkOiB0cnVlLFxuICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciAnICsgY3JlZGVudGlhbC50b2tlbiwgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04JywgLi4uKGJvZHkgPyB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04JyB9IDoge30pIH0sXG4gICAgICAgICAgICAgICAgZGF0YTogYm9keSA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkXG4gICAgICAgICAgICB9IH0sIHNlbmRlciwgdW5kZWZpbmVkLCBpc0N1cnJlbnQpO1xuICAgICAgICAgICAgaWYgKHJlc3BvbnNlLmV2ZW50ICE9PSAnbG9hZCcgfHwgIWF3YWl0IGlzQ3VycmVudCgpKSB0aHJvdyBFcnJvcign0KHQvtC10LTQuNC90LXQvdC40LUg0YEg0JzQvtC50KHQutC70LDQtCDQv9C+0YLQtdGA0Y/QvdC+Jyk7XG4gICAgICAgICAgICBjb25zdCBzdGF0dXMgPSByZXNwb25zZS5yZXNwb25zZS5zdGF0dXM7XG4gICAgICAgICAgICBpZiAoc3RhdHVzIDwgMjAwIHx8IHN0YXR1cyA+PSAzMDApIHsgY29uc3QgZXJyb3IgPSBFcnJvcign0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgc3RhdHVzKTsgZXJyb3Iuc3RhdHVzID0gc3RhdHVzOyB0aHJvdyBlcnJvcjsgfVxuICAgICAgICAgICAgcmV0dXJuIG1ldGhvZCA9PT0gJ0dFVCcgPyBKU09OLnBhcnNlKHJlc3BvbnNlLnJlc3BvbnNlLnJlc3BvbnNlVGV4dCkgOiB1bmRlZmluZWQ7XG4gICAgICAgIH07XG4gICAgICAgIGlmIChzZXR0aW5ncykge1xuICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3NldHRpbmdzLWxvYWQnKSB7XG4gICAgICAgICAgICAgICAgcmVwcmljZVNldHRpbmdzLmRlbGV0ZShvd25lcik7XG4gICAgICAgICAgICAgICAgY29uc3QgdHlwZXMgPSBtZW1jaGF0UmVwcmljZVByaWNlVHlwZXMoYXdhaXQgcmVxdWVzdCgnR0VUJywgTUVNQ0hBVF9SRVBSSUNFX1BSSUNFX1RZUEVTKSk7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVzLnNpemUgPCAyKSByZXR1cm4gcmVmdXNlKCfQkiDQnNC+0LnQodC60LvQsNC0INC90YPQttC90Ysg0YXQvtGC0Y8g0LHRiyDQtNCy0LAg0YLQuNC/0LAg0YbQtdC9LicpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGlkID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgICAgICAgICAgICAgICBpZiAoIXJlcHJpY2VSZW1lbWJlcihyZXByaWNlU2V0dGluZ3MsIG93bmVyLCB7IGlkLCBjcmVkZW50aWFsLCByZXZpc2lvbiwgdHlwZXMsIHNvdXJjZVVybDogc2VuZGVyLnVybCB9KSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVmdXNlKCfQodC70LjRiNC60L7QvCDQvNC90L7Qs9C+INC+0YLQutGA0YvRgtGL0YUg0L3QsNGB0YLRgNC+0LXQui4g0J/QvtCy0YLQvtGA0LjRgtC1INC/0L7Qt9C20LUuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpZCwgcnVsZXM6IHJ1bGVzUmVjb3JkPy5ydWxlcyB8fCBNRU1DSEFUX1JFUFJJQ0VfREVGQVVMVFMsXG4gICAgICAgICAgICAgICAgICAgIHByaWNlVHlwZXM6IEFycmF5LmZyb20odHlwZXMsIChbaWQsIG5hbWVdKSA9PiAoeyBpZCwgbmFtZSB9KSkgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IG9wZW5lZCA9IHJlcHJpY2VTZXR0aW5ncy5nZXQob3duZXIpO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UuY29uZmlybWVkICE9PSB0cnVlIHx8ICFvcGVuZWQgfHwgb3BlbmVkLmlkICE9PSBtZXNzYWdlLmlkIHx8IG9wZW5lZC5leHBpcmVzIDwgRGF0ZS5ub3coKVxuICAgICAgICAgICAgICAgIHx8ICFyZXByaWNlU2FtZUFjY291bnQob3BlbmVkLmNyZWRlbnRpYWwsIGNyZWRlbnRpYWwpIHx8IG9wZW5lZC5jcmVkZW50aWFsLnRva2VuICE9PSBjcmVkZW50aWFsLnRva2VuXG4gICAgICAgICAgICAgICAgfHwgb3BlbmVkLnJldmlzaW9uICE9PSByZXZpc2lvbiB8fCBvcGVuZWQuc291cmNlVXJsICE9PSBzZW5kZXIudXJsKSByZXR1cm4gcmVmdXNlKCfQndCw0YHRgtGA0L7QudC60Lgg0YPRgdGC0LDRgNC10LvQuC4g0JfQsNCz0YDRg9C30LjRgtC1INGC0LjQv9GLINGG0LXQvSDQt9Cw0L3QvtCy0L4uJyk7XG4gICAgICAgICAgICBjb25zdCB7IGJhc2VUeXBlSWQsIHRhcmdldFR5cGVJZCB9ID0gbWVzc2FnZS5ydWxlcyA/PyB7fTtcbiAgICAgICAgICAgIGlmICghb3BlbmVkLnR5cGVzLmhhcyhiYXNlVHlwZUlkKSB8fCAhb3BlbmVkLnR5cGVzLmhhcyh0YXJnZXRUeXBlSWQpIHx8IGJhc2VUeXBlSWQgPT09IHRhcmdldFR5cGVJZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWZ1c2UoJ9CS0YvQsdC10YDQuNGC0LUg0LTQstCwINGA0LDQt9C90YvRhSDRgtC40L/QsCDRhtC10L0g0LjQtyDRgdC/0YDQsNCy0L7Rh9C90LjQutCwLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IGZvcm11bGE7XG4gICAgICAgICAgICB0cnkgeyBmb3JtdWxhID0gbWVtY2hhdFJlcHJpY2VGb3JtdWxhKG1lc3NhZ2UucnVsZXMpOyB9IGNhdGNoIChlcnJvcikgeyByZXR1cm4gcmVmdXNlKGVycm9yLm1lc3NhZ2UpOyB9XG4gICAgICAgICAgICBjb25zdCBydWxlcyA9IHsgYmFzZVR5cGVJZCwgYmFzZVR5cGVOYW1lOiBvcGVuZWQudHlwZXMuZ2V0KGJhc2VUeXBlSWQpLCB0YXJnZXRUeXBlSWQsXG4gICAgICAgICAgICAgICAgdGFyZ2V0VHlwZU5hbWU6IG9wZW5lZC50eXBlcy5nZXQodGFyZ2V0VHlwZUlkKSwgLi4uZm9ybXVsYSB9O1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVwcmljZVJ1bGVzS2V5KGNyZWRlbnRpYWwub3JpZ2luKTtcbiAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkID0geyBzY29wZTogY3JlZGVudGlhbC5zY29wZSwgcmV2aXNpb246IGNyeXB0by5yYW5kb21VVUlEKCksIHJ1bGVzIH07XG4gICAgICAgICAgICBpZiAoIWF3YWl0IGlzQ3VycmVudCgpKSByZXR1cm4gcmVmdXNlKCfQndCw0YHRgtGA0L7QudC60Lgg0YPRgdGC0LDRgNC10LvQuC4g0JfQsNCz0YDRg9C30LjRgtC1INGC0LjQv9GLINGG0LXQvSDQt9Cw0L3QvtCy0L4uJyk7XG4gICAgICAgICAgICByZXByaWNlU2V0dGluZ3MuZGVsZXRlKG93bmVyKTtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtrZXldOiBleHBlY3RlZCB9KTtcbiAgICAgICAgICAgIGlmIChyZXByaWNlSm91cm5hbEpzb24oKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldKSAhPT0gcmVwcmljZUpvdXJuYWxKc29uKGV4cGVjdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWZ1c2UoJ9Ch0L7RhdGA0LDQvdC10L3QuNC1INC/0YDQsNCy0LjQuyDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNC10L3Qvi4g0J7RgtC60YDQvtC50YLQtSDQvdCw0YHRgtGA0L7QudC60Lgg0LfQsNC90L7QstC+LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJ1bGVzIH07XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCByZXByaWNlTG9hZEpvdXJuYWwoKTtcbiAgICAgICAgY29uc3QgdW5maW5pc2hlZCA9IHJlcHJpY2VVbmZpbmlzaGVkKHNhdmVkKTtcbiAgICAgICAgaWYgKHVuZmluaXNoZWQgJiYgIXJlcHJpY2VTYW1lQWNjb3VudChzYXZlZCwgY3JlZGVudGlhbCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZ1c2UoJ9CV0YHRgtGMINC90LXQt9Cw0LLQtdGA0YjRkdC90L3QsNGPINC/0LXRgNC10L7RhtC10L3QutCwLiDQlNC70Y8g0L/RgNC+0LLQtdGA0LrQuCDQvdGD0LbQtdC9INC/0YDQtdC20L3QuNC5INC/0YDQvtGE0LjQu9GMIEJlYXJlci4nKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodW5maW5pc2hlZCAmJiBhY3Rpb24gIT09ICdyZWNvdmVyJykgcmV0dXJuIHJlZnVzZSgn0J3QtdC30LDQstC10YDRiNGR0L3QvdCw0Y8g0L/QtdGA0LXQvtGG0LXQvdC60LAuINCh0L3QsNGH0LDQu9CwINC/0YDQvtCy0LXRgNGM0YLQtSDQt9Cw0L/QuNGB0Ywg0LIg0JzQvtC50KHQutC70LDQtC4nLCB0cnVlKTtcbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3JlY292ZXInICYmICF1bmZpbmlzaGVkKSByZXR1cm4geyBvazogdHJ1ZSwgc3RhdHVzOiAnbm9uZScsIHZlcmlmaWVkOiAwIH07XG4gICAgICAgIGlmIChhY3Rpb24gIT09ICdyZWNvdmVyJyAmJiAhcnVsZXNSZWNvcmQpIHJldHVybiByZWZ1c2UoJ9CS0YvQsdC10YDQuNGC0LUg0Lgg0YHQvtGF0YDQsNC90LjRgtC1INGC0LjQv9GLINGG0LXQvSDQsiDQvdCw0YHRgtGA0L7QudC60LDRhSDQv9C10YDQtdC+0YbQtdC90LrQuC4nKTtcbiAgICAgICAgY29uc3QgcHJldmlldyA9IGFjdGlvbiA9PT0gJ2FwcGx5JyA/IHJlcHJpY2VQcmV2aWV3cy5nZXQob3duZXIpIDogbnVsbDtcbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ2FwcGx5JyAmJiAobWVzc2FnZS5jb25maXJtZWQgIT09IHRydWUgfHwgIXByZXZpZXcgfHwgbWVzc2FnZS5pZCAhPT0gcHJldmlldy5pZCB8fCBwcmV2aWV3LmV4cGlyZXMgPCBEYXRlLm5vdygpXG4gICAgICAgICAgICB8fCAhcmVwcmljZVNhbWVBY2NvdW50KHByZXZpZXcuY3JlZGVudGlhbCwgY3JlZGVudGlhbCkgfHwgcHJldmlldy5jcmVkZW50aWFsLnRva2VuICE9PSBjcmVkZW50aWFsLnRva2VuXG4gICAgICAgICAgICB8fCBwcmV2aWV3LnJldmlzaW9uICE9PSByZXZpc2lvbiB8fCBwcmV2aWV3LnNvdXJjZVVybCAhPT0gc2VuZGVyLnVybFxuICAgICAgICAgICAgfHwgcmVwcmljZUpvdXJuYWxKc29uKHByZXZpZXcucnVsZXMpICE9PSByZXByaWNlSm91cm5hbEpzb24ocnVsZXNSZWNvcmQucnVsZXMpKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZnVzZSgn0J/RgNC10LTQv9GA0L7RgdC80L7RgtGAINGD0YHRgtCw0YDQtdC7INC40LvQuCDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0uINCX0LDQs9GA0YPQt9C40YLQtSDQtdCz0L4g0YHQvdC+0LLQsC4nKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBjb25maWcgPSBhY3Rpb24gPT09ICdyZWNvdmVyJyA/IHJlcHJpY2VSZWNvdmVyeUNvbmZpZyhzYXZlZCkgOiB7IC4uLnJ1bGVzUmVjb3JkLnJ1bGVzLCBvcmRlcklkOiBvcmRlcklkIHx8IHByZXZpZXcub3JkZXJJZCB9O1xuICAgICAgICBjb25zdCByZWFkID0gcGF0aCA9PiByZXF1ZXN0KCdHRVQnLCBwYXRoKTtcbiAgICAgICAgcnVuSWQgPSBhY3Rpb24gPT09ICdyZWNvdmVyJyA/IHNhdmVkLnJ1biA6IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgICAgIGxldCBkdXJhYmxlSW50ZW50ID0gbnVsbDtcbiAgICAgICAgY29uc3QgcGVyc2lzdCA9IGFzeW5jIGpvdXJuYWwgPT4ge1xuICAgICAgICAgICAgY29uc3QgZXhwZWN0ZWQgPSB7IG9yaWdpbjogY3JlZGVudGlhbC5vcmlnaW4sIHNjb3BlOiBjcmVkZW50aWFsLnNjb3BlLCBjb25maWcsIHJ1bjogcnVuSWQsIGpvdXJuYWwgfTtcbiAgICAgICAgICAgIGNvbnN0IGVuY29kZWQgPSByZXByaWNlSm91cm5hbEpzb24oZXhwZWN0ZWQpO1xuICAgICAgICAgICAgaWYgKGVuY29kZWQubGVuZ3RoID4gMTAyNCAqIDEwMjQpIHRocm93IEVycm9yKCfQltGD0YDQvdCw0Lsg0YHQu9C40YjQutC+0Lwg0LHQvtC70YzRiNC+0LknKTtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtNRU1DSEFUX1JFUFJJQ0VfSk9VUk5BTF06IEpTT04ucGFyc2UoZW5jb2RlZCkgfSk7XG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KE1FTUNIQVRfUkVQUklDRV9KT1VSTkFMKSlbTUVNQ0hBVF9SRVBSSUNFX0pPVVJOQUxdO1xuICAgICAgICAgICAgaWYgKHJlcHJpY2VKb3VybmFsSnNvbihjb21taXR0ZWQpICE9PSBlbmNvZGVkKSB0aHJvdyBFcnJvcign0JbRg9GA0L3QsNC7INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvScpO1xuICAgICAgICAgICAgZHVyYWJsZUludGVudCA9IGpvdXJuYWwuaW50ZW50ID8geyBwYXRoOiBqb3VybmFsLmludGVudC5wYXRoLCB2YWx1ZTogam91cm5hbC5pbnRlbnQubmV3IH0gOiBudWxsO1xuICAgICAgICAgICAgcmV0dXJuIGNvbW1pdHRlZC5qb3VybmFsO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBzZXJ2aWNlID0gY3JlYXRlTWVtY2hhdFJlcHJpY2VTZXJ2aWNlKGNvbmZpZyk7XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdwcmV2aWV3Jykge1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHNlcnZpY2UucGxhbihyZWFkKTtcbiAgICAgICAgICAgIGlmIChkYXRhLmVudHJpZXMubGVuZ3RoICsgZGF0YS5za2lwcGVkLmxlbmd0aCA+IDUwMCkgcmV0dXJuIHJlZnVzZSgn0JIg0LfQsNC60LDQt9C1INCx0L7Qu9GM0YjQtSA1MDAg0LrQsNGA0YLQvtGH0LXQui4g0J/QtdGA0LXQvtGG0LXQvdC60LAg0L3QtSDQt9Cw0L/Rg9GJ0LXQvdCwLicpO1xuICAgICAgICAgICAgaWYgKCFhd2FpdCBpc0N1cnJlbnQoKSB8fCByZXByaWNlQnVzeSkgcmV0dXJuIHJlZnVzZSgn0J/Qu9Cw0L0g0YPRgdGC0LDRgNC10LsuINCe0LHQvdC+0LLQuNGC0LUg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGALicpO1xuICAgICAgICAgICAgY29uc3QgaWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICAgICAgICAgICAgaWYgKCFyZXByaWNlUmVtZW1iZXIocmVwcmljZVByZXZpZXdzLCBvd25lciwgeyBpZCwgZGF0YSwgY3JlZGVudGlhbCwgb3JkZXJJZCwgcmV2aXNpb24sIHJ1bGVzOiBydWxlc1JlY29yZC5ydWxlcywgc291cmNlVXJsOiBzZW5kZXIudXJsIH0pKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlZnVzZSgn0KHQu9C40YjQutC+0Lwg0LzQvdC+0LPQviDQsNC60YLQuNCy0L3Ri9GFINC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgNC+0LIuINCf0L7QstGC0L7RgNC40YLQtSDRh9C10YDQtdC3INC90LXRgdC60L7Qu9GM0LrQviDQvNC40L3Rg9GCLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGlkLCBvcmRlck5hbWU6IGRhdGEub3JkZXJOYW1lLCBiYXNlTmFtZTogY29uZmlnLmJhc2VUeXBlTmFtZSwgdGFyZ2V0TmFtZTogY29uZmlnLnRhcmdldFR5cGVOYW1lLFxuICAgICAgICAgICAgICAgIGVudHJpZXM6IGRhdGEuZW50cmllcy5tYXAoKHsgaWQsIG5hbWUsIGJhc2UsIG9sZCwgbmV3OiBuZXh0IH0pID0+ICh7IGlkLCBuYW1lLCBiYXNlLCBvbGQsIG5leHQgfSkpLCBza2lwcGVkOiBkYXRhLnNraXBwZWQgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWF3YWl0IGlzQ3VycmVudCgpKSByZXR1cm4gcmVmdXNlKCfQlNC+0LrRg9C80LXQvdGCINC40LvQuCDQvdCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC40LvQuNGB0YwuINCf0L7QstGC0L7RgNC40YLQtSDQv9GA0L7QstC10YDQutGDLicsIHVuZmluaXNoZWQpO1xuICAgICAgICBpZiAoYWN0aW9uID09PSAncmVjb3ZlcicpIHtcbiAgICAgICAgICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBzZXJ2aWNlLnJlY29uY2lsZShzYXZlZC5qb3VybmFsLCB7IHJlYWQsIHBlcnNpc3QgfSk7XG4gICAgICAgICAgICBjb25zdCBsYXRlc3QgPSBhd2FpdCByZXByaWNlTG9hZEpvdXJuYWwoKTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzdGF0dXM6IGxhdGVzdD8uam91cm5hbC5zdGF0dXMgfHwgb3V0Y29tZT8uc3RhdHVzLCB2ZXJpZmllZDogbGF0ZXN0Py5qb3VybmFsLnZlcmlmaWVkIHx8IDAsXG4gICAgICAgICAgICAgICAgcmVjb3Zlcnk6IHJlcHJpY2VVbmZpbmlzaGVkKGxhdGVzdCkgfTtcbiAgICAgICAgfVxuICAgICAgICByZXByaWNlUHJldmlld3MuZGVsZXRlKG93bmVyKTtcbiAgICAgICAgY29uc3QgY2hhbmdlcyA9IG5ldyBNYXAocHJldmlldy5kYXRhLmVudHJpZXMuZmlsdGVyKGVudHJ5ID0+IGVudHJ5Lm5ldyAhPT0gZW50cnkub2xkKVxuICAgICAgICAgICAgLm1hcChlbnRyeSA9PiBbJy9lbnRpdHkvcHJvZHVjdC8nICsgZW50cnkuaWQsIGVudHJ5Lm5ld10pKTtcbiAgICAgICAgaWYgKCFjaGFuZ2VzLnNpemUpIHJldHVybiByZWZ1c2UoJ9CSINC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgNC1INC90LXRgiDQuNC30LzQtdC90LXQvdC40LkuJyk7XG4gICAgICAgIGNvbnN0IHdyaXRlID0gKHBhdGgsIGJvZHkpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBib2R5Py5zYWxlUHJpY2VzPy5bMF07XG4gICAgICAgICAgICBpZiAoIS9eXFwvZW50aXR5XFwvcHJvZHVjdFxcL1thLWYwLTktXXszNn0kL2kudGVzdChwYXRoKSB8fCAhY2hhbmdlcy5oYXMocGF0aClcbiAgICAgICAgICAgICAgICB8fCBkdXJhYmxlSW50ZW50Py5wYXRoICE9PSBwYXRoIHx8IGR1cmFibGVJbnRlbnQudmFsdWUgIT09IGxpbmU/LnZhbHVlXG4gICAgICAgICAgICAgICAgfHwgT2JqZWN0LmtleXMoYm9keSB8fCB7fSkubGVuZ3RoICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KGJvZHkuc2FsZVByaWNlcykgfHwgYm9keS5zYWxlUHJpY2VzLmxlbmd0aCAhPT0gMVxuICAgICAgICAgICAgICAgIHx8IE9iamVjdC5rZXlzKGxpbmUgfHwge30pLmxlbmd0aCAhPT0gMyB8fCBsaW5lLnZhbHVlICE9PSBjaGFuZ2VzLmdldChwYXRoKVxuICAgICAgICAgICAgICAgIHx8ICFOdW1iZXIuaXNTYWZlSW50ZWdlcihsaW5lLnZhbHVlKSB8fCBsaW5lLnZhbHVlIDw9IDBcbiAgICAgICAgICAgICAgICB8fCBsaW5lLnByaWNlVHlwZT8ubWV0YT8uaHJlZiAhPT0gJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjIvY29udGV4dC9jb21wYW55c2V0dGluZ3MvcHJpY2V0eXBlLycgKyBjb25maWcudGFyZ2V0VHlwZUlkXG4gICAgICAgICAgICAgICAgfHwgIS9eaHR0cHM6XFwvXFwvYXBpXFwubW95c2tsYWRcXC5ydVxcL2FwaVxcL3JlbWFwXFwvMVxcLjJcXC9lbnRpdHlcXC9jdXJyZW5jeVxcL1thLWYwLTktXXszNn0kL2kudGVzdChsaW5lLmN1cnJlbmN5Py5tZXRhPy5ocmVmKSkgdGhyb3cgRXJyb3IoJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80LDRjyDQt9Cw0L/QuNGB0Ywg0YbQtdC90L3QuNC60LAnKTtcbiAgICAgICAgICAgIGNoYW5nZXMuZGVsZXRlKHBhdGgpOyAvLyBObyBzZWNvbmQgUFVUIGV2ZW4gaWYgaXRzIGZpcnN0IHJlc3BvbnNlIGlzIGFtYmlndW91cy5cbiAgICAgICAgICAgIGR1cmFibGVJbnRlbnQgPSBudWxsO1xuICAgICAgICAgICAgcmV0dXJuIHJlcXVlc3QoJ1BVVCcsIHBhdGgsIGJvZHkpO1xuICAgICAgICB9O1xuICAgICAgICBlbnRlcmVkU2VydmljZSA9IHRydWU7XG4gICAgICAgIGNvbnN0IGpvdXJuYWwgPSBhd2FpdCBzZXJ2aWNlLmFwcGx5KHByZXZpZXcuZGF0YSwgeyByZWFkLCB3cml0ZSwgcGVyc2lzdCB9KTtcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgcmVwcmljZUxvYWRKb3VybmFsKCk7XG4gICAgICAgIGNvbnN0IHJlY292ZXJ5ID0gcmVwcmljZVVuZmluaXNoZWQoc3RvcmVkKTtcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBqb3VybmFsLnZlcmlmaWVkO1xuICAgICAgICBjb25zdCBlcnJvciA9IHJlY292ZXJ5ID8gJ9CX0LDQv9GD0YHQuiDQvdC1INC30LDQstC10YDRiNGR0L0uINCf0YDQvtCy0LXRgNGM0YLQtSDQvdC10LfQsNCy0LXRgNGI0ZHQvdC90YPRjiDQt9Cw0L/QuNGB0Ywg0LIg0JzQvtC50KHQutC70LDQtC4nXG4gICAgICAgICAgICA6IGpvdXJuYWwuZXJyb3IgPT09ICdzdGFsZS1wcmV2aWV3JyA/ICfQn9C70LDQvSDQuNC30LzQtdC90LjQu9GB0Y8uINCX0LDQs9GA0YPQt9C40YLQtSDQvdC+0LLRi9C5INC/0YDQtdC00L/RgNC+0YHQvNC+0YLRgC4nXG4gICAgICAgICAgICAgICAgOiB2ZXJpZmllZCA/IGDQn9C10YDQtdC+0YbQtdC90LrQsCDQvtGB0YLQsNC90L7QstC70LXQvdCwLiDQodCy0LXRgNC10L3QviDQtNC+INC+0YHRgtCw0L3QvtCy0LrQuDogJHt2ZXJpZmllZH0uINCX0LDQs9GA0YPQt9C40YLQtSDRgdCy0LXQttC40Lkg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGALmBcbiAgICAgICAgICAgICAgICAgICAgOiAn0J/QtdGA0LXQvtGG0LXQvdC60LAg0L3QtSDQt9Cw0LLQtdGA0YjQtdC90LAuINCf0YDQvtCy0LXRgNGM0YLQtSDQtNCw0L3QvdGL0LUg0Lgg0LTQvtGB0YLRg9C/INCc0L7QudCh0LrQu9Cw0LQuJztcbiAgICAgICAgcmV0dXJuIHsgb2s6IGpvdXJuYWwuc3RhdHVzID09PSAndmVyaWZpZWQnLCBzdGF0dXM6IGpvdXJuYWwuc3RhdHVzLCB2ZXJpZmllZDogam91cm5hbC52ZXJpZmllZCxcbiAgICAgICAgICAgIGNoZWNrZWQ6IGpvdXJuYWwuY2hlY2tlZCwgY2hhbmdlZDogam91cm5hbC5jaGFuZ2VkLCByZWNvdmVyeSxcbiAgICAgICAgICAgIC4uLihqb3VybmFsLnN0YXR1cyA9PT0gJ3ZlcmlmaWVkJyA/IHt9IDogeyBlcnJvciB9KSB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChzZXR0aW5ncykgcmV0dXJuIHJlZnVzZShOdW1iZXIuaXNJbnRlZ2VyKGVycm9yPy5zdGF0dXMpID8gJ9Cc0L7QudCh0LrQu9Cw0LQ6IEhUVFAgJyArIGVycm9yLnN0YXR1cyArICcuINCf0YDQvtCy0LXRgNGM0YLQtSDQtNC+0YHRgtGD0L8gQmVhcmVyLidcbiAgICAgICAgICAgIDogJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0LfQsNCz0YDRg9C30LjRgtGMINC40LvQuCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L/RgNCw0LLQuNC70LAuINCf0YDQvtCy0LXRgNGM0YLQtSDQtNC+0YHRgtGD0L8gQmVhcmVyINC4INC+0YLQutGA0L7QudGC0LUg0L3QsNGB0YLRgNC+0LnQutC4INC30LDQvdC+0LLQvi4nKTtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCByZXByaWNlTG9hZEpvdXJuYWwoKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgICAgY29uc3QgdW5yZXNvbHZlZCA9IHJlcHJpY2VVbmZpbmlzaGVkKHNhdmVkKTtcbiAgICAgICAgY29uc3QgcGFydGlhbCA9IGVudGVyZWRTZXJ2aWNlICYmIHNhdmVkPy5ydW4gPT09IHJ1bklkICYmIHNhdmVkLmpvdXJuYWwudmVyaWZpZWQgPiAwO1xuICAgICAgICBjb25zdCBzdGF0dXMgPSBlcnJvcj8uc3RhdHVzO1xuICAgICAgICByZXR1cm4geyAuLi5yZWZ1c2UodW5yZXNvbHZlZCA/ICfQl9Cw0L/Rg9GB0Log0L3QtSDQt9Cw0LLQtdGA0YjRkdC9LiDQn9C10YDQtdC0INC/0L7QstGC0L7RgNC+0Lwg0L/RgNC+0LLQtdGA0YzRgtC1INC20YPRgNC90LDQuzog0YfQsNGB0YLRjCDRhtC10L0g0LzQvtCz0LvQsCDQuNC30LzQtdC90LjRgtGM0YHRjy4nXG4gICAgICAgICAgICA6IHBhcnRpYWwgPyAn0J/QtdGA0LXQvtGG0LXQvdC60LAg0LLRi9C/0L7Qu9C90LXQvdCwINGH0LDRgdGC0LjRh9C90L4uINCX0LDQs9GA0YPQt9C40YLQtSDRgdCy0LXQttC40Lkg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGALidcbiAgICAgICAgICAgICAgICA6IGVycm9yPy5jb2RlID09PSAncHJpY2V0eXBlLWNvbnRleHQnID8gJ9Ci0LjQvyDRhtC10L3RiyDQuNC30LzQtdC90LjQu9GB0Y8uINCe0YLQutGA0L7QudGC0LUg0Lgg0YHQvtGF0YDQsNC90LjRgtC1INC90LDRgdGC0YDQvtC50LrQuCDQv9C10YDQtdC+0YbQtdC90LrQuCDQt9Cw0L3QvtCy0L4uJ1xuICAgICAgICAgICAgICAgIDogTnVtYmVyLmlzSW50ZWdlcihzdGF0dXMpID8gJ9Cc0L7QudCh0LrQu9Cw0LQ6IEhUVFAgJyArIHN0YXR1cyArICcuINCf0YDQvtCy0LXRgNGM0YLQtSDQtNC+0YHRgtGD0L8g0Lgg0L/Qu9Cw0L0uJ1xuICAgICAgICAgICAgICAgIDogZW50ZXJlZFNlcnZpY2UgPyAn0J/Qu9Cw0L0g0YPRgdGC0LDRgNC10Lsg0LjQu9C4INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvS4g0JfQsNCz0YDRg9C30LjRgtC1INC90L7QstGL0Lkg0L/RgNC10LTQv9GA0L7RgdC80L7RgtGALidcbiAgICAgICAgICAgICAgICAgICAgOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDQv9GA0L7QstC10YDQuNGC0Ywg0LfQsNC60LDQtywgQmVhcmVyINC40LvQuCDQttGD0YDQvdCw0Lsg0L/QtdGA0LXQvtGG0LXQvdC60LguJywgdW5yZXNvbHZlZCB8fCBlbnRlcmVkU2VydmljZSksXG4gICAgICAgICAgICAuLi4odW5yZXNvbHZlZCB8fCBwYXJ0aWFsID8geyB2ZXJpZmllZDogc2F2ZWQ/LmpvdXJuYWw/LnZlcmlmaWVkIHx8IDAgfSA6IHt9KSB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJlcHJpY2VQZW5kaW5nLmRlbGV0ZShvd25lcik7XG4gICAgICAgIGlmIChjaGFuZ2VzU3RhdGUpIHJlcHJpY2VCdXN5ID0gZmFsc2U7XG4gICAgfVxufVxuIiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBUaGUgcGFuZWwgaXMgYSB2ZXJpZmllZCBTSURFX1BBTkVMIGRvY3VtZW50OyBpdCBoYXMgbm8gdGFiIGFuZCBubyBzdWJmcmFtZS5cbmZ1bmN0aW9uIGRlYnVnUGFuZWxTZW5kZXIoc2VuZGVyKSB7XG4gICAgcmV0dXJuIHNlbmRlcj8uaWQgPT09IGNocm9tZS5ydW50aW1lLmlkICYmICFzZW5kZXIudGFiXG4gICAgICAgICYmIChzZW5kZXIuZnJhbWVJZCA9PT0gdW5kZWZpbmVkIHx8IHNlbmRlci5mcmFtZUlkID09PSAwKVxuICAgICAgICAmJiBuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpO1xufVxuZnVuY3Rpb24gZGVidWdXb3JsZEZvcihzZW5kZXIsIHBhbmVsKSB7XG4gICAgaWYgKHBhbmVsKSByZXR1cm4gJ3BhbmVsJztcbiAgICBpZiAodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICdjb250ZW50JztcbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgcmV0dXJuICdydW50aW1lJztcbiAgICByZXR1cm4gJ3dvcmtlcic7XG59XG5hc3luYyBmdW5jdGlvbiBkZWJ1Z01lc3NhZ2UobWVzc2FnZSwgc2VuZGVyLCBwYW5lbCkge1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OmRlYnVnLWZsYWcnKSB7XG4gICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZS5lbmFibGVkICE9PSAnYm9vbGVhbicpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LbRg9GA0L3QsNC7INGA0LDRgdGI0LjRgNC10L3QuNGPJyB9O1xuICAgICAgICAvLyBtZW1jaGF0RGVidWdTZXRFbmFibGVkIHJldHVybnMgd2hldGhlciB0aGUgd3JpdGUgdmVyaWZpZWQsIG5vdCB0aGUgdmFsdWUuXG4gICAgICAgIC8vIFJlYWQgdGhlIHBlcnNpc3RlZCBmbGFnIGJhY2sgc28gdHVybmluZyB0aGUgbG9nIE9GRiBpcyBhbHNvIGNvbmZpcm1lZC5cbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdTZXRFbmFibGVkKG1lc3NhZ2UuZW5hYmxlZCk7XG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBhd2FpdCBtZW1jaGF0RGVidWdFbmFibGVkKCk7XG4gICAgICAgIHJldHVybiB2ZXJpZmllZCAmJiBlbmFibGVkID09PSBtZXNzYWdlLmVuYWJsZWRcbiAgICAgICAgICAgID8geyBvazogdHJ1ZSwgZW5hYmxlZCB9XG4gICAgICAgICAgICA6IHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ck0LvQsNCzINC20YPRgNC90LDQu9CwINC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvScgfTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6ZGVidWctcmVhZCcpIHtcbiAgICAgICAgaWYgKG1lc3NhZ2UubGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS5saW1pdCkgfHwgbWVzc2FnZS5saW1pdCA8IDFcbiAgICAgICAgICAgIHx8IG1lc3NhZ2UubGltaXQgPiBNRU1DSEFUX0RFQlVHX0xPR19MSU1JVCkpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LbRg9GA0L3QsNC7INGA0LDRgdGI0LjRgNC10L3QuNGPJyB9O1xuICAgICAgICByZXR1cm4gbWVtY2hhdERlYnVnUmVhZCh7IGxpbWl0OiBtZXNzYWdlLmxpbWl0IH0pO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpkZWJ1Zy1jbGVhcicpIHJldHVybiBtZW1jaGF0RGVidWdDbGVhcigpO1xuICAgIC8vIFRoZSB3b3JsZCBpcyBkZXJpdmVkIGZyb20gdGhlIGF1dGhlbnRpY2F0ZWQgc2VuZGVyLCBuZXZlciB0cnVzdGVkIGZyb20gdGhlXG4gICAgLy8gcGF5bG9hZDogYSBjb250ZW50IHdvcmxkIGNhbm5vdCBjbGFpbSB0byBiZSB0aGUgcGFuZWwgb3IgdGhlIHdvcmtlci5cbiAgICBpZiAoIU1FTUNIQVRfREVCVUdfTEVWRUxTLmluY2x1ZGVzKG1lc3NhZ2UubGV2ZWwpXG4gICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLnNjb3BlICE9PSAnc3RyaW5nJyB8fCAhL15bYS16MC05Oi1dezEsNjR9JC8udGVzdChtZXNzYWdlLnNjb3BlKVxuICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5ldmVudCAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS5ldmVudC5sZW5ndGggPCAxIHx8IG1lc3NhZ2UuZXZlbnQubGVuZ3RoID4gMjAwXG4gICAgICAgIHx8IChtZXNzYWdlLndvcmxkICE9PSB1bmRlZmluZWQgJiYgIU1FTUNIQVRfREVCVUdfV09STERTLmluY2x1ZGVzKG1lc3NhZ2Uud29ybGQpKSkge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC20YPRgNC90LDQuyDRgNCw0YHRiNC40YDQtdC90LjRjycgfTtcbiAgICB9XG4gICAgYXdhaXQgbWVtY2hhdERlYnVnUmVjb3JkKHsgbGV2ZWw6IG1lc3NhZ2UubGV2ZWwsIHNjb3BlOiBtZXNzYWdlLnNjb3BlLCBldmVudDogbWVzc2FnZS5ldmVudCwgZGV0YWlsOiBtZXNzYWdlLmRldGFpbCB9LFxuICAgICAgICBkZWJ1Z1dvcmxkRm9yKHNlbmRlciwgcGFuZWwpKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xufVxuXG5mdW5jdGlvbiBleHRlbnNpb25IYW5kbGVNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSB7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0OmNoYXQtZXZlbnQnKSByZXR1cm4gc2lkZWJhckhpc3RvcnlNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKTtcbiAgICBpZiAoWydtZW1jaGF0OnJlcHJpY2UnLCAnbWVtY2hhdDpzYWxlcy1zZXR0aW5ncy1nZXQnLCAnbWVtY2hhdDpzYWxlcy1zZXR0aW5ncy1zYXZlJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkge1xuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDQv9C10YDQtdC+0YbQtdC90LrQuCDQvtGC0LrQu9C+0L3RkdC9LicgfSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgb3BlcmF0aW9uID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpyZXByaWNlJyA/IHJlcHJpY2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikgOiBzYWxlc1NldHRpbmdzTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpO1xuICAgICAgICBvcGVyYXRpb24udGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0J/QtdGA0LXQvtGG0LXQvdC60LAg0L3QtdC00L7RgdGC0YPQv9C90LAuJywgcmVjb3Zlcnk6IHRydWUgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpkZWJ1Zy1sb2cnLCAnbWVtY2hhdDpkZWJ1Zy1yZWFkJywgJ21lbWNoYXQ6ZGVidWctY2xlYXInLCAnbWVtY2hhdDpkZWJ1Zy1mbGFnJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgY29uc3QgcGFuZWwgPSBkZWJ1Z1BhbmVsU2VuZGVyKHNlbmRlcik7XG4gICAgICAgIC8vIFRoZSB2ZXJib3NlLWxvZyBzd2l0Y2ggbGl2ZXMgaW4gdGhlIHNldHRpbmdzIHdpbmRvdywgd2hpY2ggaXMgcmVuZGVyZWQgYnlcbiAgICAgICAgLy8gb3VyIG93biBjb250ZW50IHNjcmlwdCAob3IgdGhlIG5hdGl2ZSBydW50aW1lKSwgbm90IGJ5IHRoZSBwYW5lbCBkb2N1bWVudC5cbiAgICAgICAgLy8gQSBwYWdlIGNhbm5vdCBmb3JnZSBhbnkgb2YgdGhlc2Ugc2VuZGVyczogc2VuZGVyLmlkIG11c3QgYmUgb3VyIGV4dGVuc2lvbi5cbiAgICAgICAgY29uc3QgdHJ1c3RlZCA9IHBhbmVsIHx8IHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKTtcbiAgICAgICAgaWYgKCF0cnVzdGVkKSB7XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGRlYnVnTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIsIHBhbmVsKS50aGVuKHNlbmRSZXNwb25zZSxcbiAgICAgICAgICAgICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQltGD0YDQvdCw0Lsg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C10L0nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChbJ21lbWNoYXQ6bmF0aXZlLWRyYWZ0LXJlYWQnLCAnbWVtY2hhdDpuYXRpdmUtZHJhZnQtd3JpdGUnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBpZiAoIXRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIG5hdGl2ZURyYWZ0TWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpLnRoZW4oc2VuZFJlc3BvbnNlLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0KfQtdGA0L3QvtCy0LjQuiDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0uINCd0LUg0LfQsNC60YDRi9Cy0LDQudGC0LUg0L/QsNC90LXQu9GMLicgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy10ZXN0LXNvdW5kJykge1xuICAgICAgICBpZiAoISh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBvcmRlclBsYXlBdWRpbygpLnRoZW4oKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSksICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpzdG9yYWdlLWluaXQnLCAnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJywgJ21lbWNoYXQ6c3RvcmFnZS1yZXN0b3JlJywgJ21lbWNoYXQ6c3RvcmFnZS1wcnVuZSddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRhdGA0LDQvdC40LvQuNGJ0LAg0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBwcml2YXRlU3RvcmFnZU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKS50aGVuKHNlbmRSZXNwb25zZSxcbiAgICAgICAgICAgICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQlNCw0L3QvdGL0LUg0L3QtSDQv9C+0LTRgtCy0LXRgNC20LTQtdC90Ysg0YXRgNCw0L3QuNC70LjRidC10LwuINCd0LUg0LfQsNC60YDRi9Cy0LDQudGC0LUg0Lgg0L3QtSDQv9C10YDQtdC30LDQs9GA0YPQttCw0LnRgtC1INCy0LrQu9Cw0LTQutGDLicgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpvcmRlcnMtY29uZmlndXJlJywgJ21lbWNoYXQ6b3JkZXJzLXBvbGwnLCAnbWVtY2hhdDpvcmRlcnMtc3RvcCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIGNvbnN0IHdvcmsgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgbWVzc2FnZS50eXBlICE9PSAnbWVtY2hhdDpvcmRlcnMtc3RvcCdcbiAgICAgICAgICAgICAgICAmJiAhYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsICdCZWFyZXIgJyArIG1lc3NhZ2UudG9rZW4pKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0KPRh9GR0YLQvdGL0LUg0LTQsNC90L3Ri9C1INC40LfQvNC10L3QtdC90YsuINCf0L7QtNGC0LLQtdGA0LTQuNGC0LUg0LrQu9GO0YcuJyB9O1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLWNvbmZpZ3VyZScpIHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBvcmRlck11dGF0ZSgoKSA9PiBjb25maWd1cmVPcmRlcnMobWVzc2FnZSwgc2VuZGVyKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgbmF0aXZlID0gbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlcik7XG4gICAgICAgICAgICAgICAgaWYgKG5hdGl2ZSAmJiByZXN1bHQub2spIHsgbmF0aXZlLm9yZGVyVG9rZW4gPSBtZXNzYWdlLnRva2VuOyBuYXRpdmUub3JkZXJSZXZpc2lvbiA9IHJlc3VsdC5yZXZpc2lvbjsgfVxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtc3RvcCcpIHJldHVybiBvcmRlck11dGF0ZShhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFvcmRlckNvbmZpZyB8fCBtZXNzYWdlLnRva2VuICE9PSBvcmRlckNvbmZpZy50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ0JlYXJlciDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDRhNC+0L3QvtCy0YvQvCDQvtC/0YDQvtGB0L7QvCcgfTtcbiAgICAgICAgICAgICAgICBvcmRlckNvbnRyb2xsZXI/LmFib3J0KCk7XG4gICAgICAgICAgICAgICAgb3JkZXJDb25maWcuc2V0dGluZ3MuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWc6IG9yZGVyQ29uZmlnLCByZXZpc2lvbjogKytvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICAgICAgICAgIHJldHVybiBvcmRlclB1YmxpY0NvbmZpZygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCBvcmRlckNvbmZpZ0NoYWluO1xuICAgICAgICAgICAgaWYgKCFvcmRlckNvbmZpZyB8fCBtZXNzYWdlLnRva2VuICE9PSBvcmRlckNvbmZpZy50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ0JlYXJlciDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDRhNC+0L3QvtCy0YvQvCDQvtC/0YDQvtGB0L7QvCcgfTtcbiAgICAgICAgICAgIHJldHVybiBwb2xsT3JkZXJzKCk7XG4gICAgICAgIH07XG4gICAgICAgIHdvcmsoKS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0L3QsNGB0YLRgNC+0LjRgtGMINGE0L7QvdC+0LLRi9C5INC+0L/RgNC+0YEnIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAnbWVtY2hhdDpwYW5lbC1jc3JmJykge1xuICAgICAgICBpZiAoISh0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikpIHx8IChtZXNzYWdlLmZvcmNlICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG1lc3NhZ2UuZm9yY2UgIT09ICdib29sZWFuJykpIHtcbiAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgZ2V0UGFuZWxTZXNzaW9uKG1lc3NhZ2UuZm9yY2UgPT09IHRydWUpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ1BhbmVsOiDRhNC+0L3QvtCy0LDRjyDRgdC10YHRgdC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoIVsnbWVtY2hhdDpodHRwJywgJ21lbWNoYXQ6YWJvcnQnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgfHwgdHlwZW9mIG1lc3NhZ2UuaWQgIT09ICdzdHJpbmcnIHx8ICEvXlthLXpBLVowLTktXXsxLDgwfSQvLnRlc3QobWVzc2FnZS5pZCkpIHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OmFib3J0Jykge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQocmVxdWVzdEtleShzZW5kZXIsIG1lc3NhZ2UuaWQpKTtcbiAgICAgICAgaWYgKGVudHJ5KSB7IGVudHJ5LmV2ZW50ID0gJ2Fib3J0JzsgZW50cnkuY29udHJvbGxlci5hYm9ydCgpOyB9XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHBlcmZvcm1SZXF1ZXN0KG1lc3NhZ2UsIHNlbmRlcikudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAocmVzdWx0LmV2ZW50ID09PSAnbG9hZCcgJiYgWzQwMSwgNDAzLCA0MTldLmluY2x1ZGVzKHJlc3VsdC5yZXNwb25zZT8uc3RhdHVzKVxuICAgICAgICAgICAgJiYgbmV3IFVSTChtZXNzYWdlLnJlcXVlc3QudXJsKS5vcmlnaW4gPT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScpIHtcbiAgICAgICAgICAgIGNvbnN0IHNlbnRUb2tlbiA9IG5ldyBIZWFkZXJzKG1lc3NhZ2UucmVxdWVzdC5oZWFkZXJzIHx8IHt9KS5nZXQoJ3gtY3NyZi10b2tlbicpO1xuICAgICAgICAgICAgaWYgKHNlbnRUb2tlbiAmJiBzZW50VG9rZW4gPT09IHBhbmVsU2Vzc2lvbj8udG9rZW4pIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wYW5lbEF1dGhMb3N0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBtZW1jaGF0RGVidWdSZWNvcmQoeyBsZXZlbDogJ2Vycm9yJywgc2NvcGU6ICdwYW5lbCcsIGV2ZW50OiAnYXV0aC1sb3N0JyxcbiAgICAgICAgICAgICAgICAgICAgZGV0YWlsOiB7IHN0YXR1czogcmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMgfSB9LCAnd29ya2VyJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHJlc3VsdCk7XG4gICAgfSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC30LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjycgfSkpO1xuICAgIHJldHVybiB0cnVlO1xufVxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKGV4dGVuc2lvbkhhbmRsZU1lc3NhZ2UpO1xuXG4vLyBSZWdpc3RlciB0b29sYmFyL2NvbnRleHQtbWVudSBsaXN0ZW5lcnMgc3luY2hyb25vdXNseSBvbiBldmVyeSB3b3JrZXIgd2FrZS5cbmltcG9ydFNjcmlwdHMoJ2NvbnRyb2xzLmpzJyk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9MQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaktBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuU0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2x6QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeFRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EifQ==
