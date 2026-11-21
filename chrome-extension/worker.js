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
    if (bucket.recoveries.length >= 128) throw Error('Recovery capacity exhausted');
    const id = Math.max(bucket.recoverySequence || 0, ...bucket.recoveries.map(entry => entry.id)) + 1;
    if (!Number.isSafeInteger(id)) throw Error('Recovery ID exhausted');
    bucket.recoverySequence = id;
    bucket.recoveries.push({ id, key, value, revision, document });
    if (JSON.stringify(bucket.recoveries).length > 5 * 1024 * 1024) throw Error('Recovery capacity exhausted');
}
function privateStorageRecoveryList(bucket) {
    // Never send recovery values (especially credentials/history) into a view.
    return (bucket.recoveries || []).map(({ id, key, value, revision }) => ({ id, key, deleted: value === null, revision }));
}
async function privateStorageCommit(storageKey, bucket) {
    await chrome.storage.local.set({ [storageKey]: bucket });
    const committed = (await chrome.storage.local.get(storageKey))[storageKey];
    if (!committed || privateStorageSnapshot(committed) !== privateStorageSnapshot(bucket)) throw Error('Storage verification failed');
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
    return operation;
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
        const failure = async (reason, error) => (await recoverPanelFromTab(controller.signal)) || { ok: false, reason, error };
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
const sidebarBindings = new Map();
async function sidebarBindingFor(message, sender) {
    const current = sidebarBindings.get(sender.url);
    if (message.tabId === undefined) {
        const [active] = await chrome.tabs.query({ active: true, windowId: message.windowId });
        if (!active) return { reason: 'changed' };
        const supported = supportedActionTab(active);
        const origin = supported ? new URL(active.url).origin : await nativeLastOrigin();
        const binding = { tabId: active.id, windowId: message.windowId, origin, supported };
        sidebarBindings.set(sender.url, binding);
        return { binding };
    }
    if (current) {
        // The binding is immutable for its life; a poll naming another tab is a
        // stale or foreign request, not a rebind.
        if (current.tabId !== message.tabId || current.windowId !== message.windowId) return { reason: 'changed' };
        return { binding: current };
    }
    // The worker slept or restarted: rebuild the record once from the current
    // tab state so the panel keeps serving across SW sleep/wake.
    let tab;
    try { tab = await chrome.tabs.get(message.tabId); } catch { return { reason: 'closed' }; }
    if (tab.windowId !== message.windowId) return { reason: 'changed' };
    const supported = supportedActionTab(tab);
    const origin = supported ? new URL(tab.url).origin : await nativeLastOrigin();
    const binding = { tabId: tab.id, windowId: message.windowId, origin, supported };
    sidebarBindings.set(sender.url, binding);
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
    if (!resolved.binding) return { ok: false, reason: resolved.reason || 'changed' };
    const binding = resolved.binding;
    const bound = await sidebarBoundTab(message, binding);
    if (!bound.tab) return { ok: false, reason: bound.reason };
    const tab = bound.tab;
    const origin = binding.origin;
    // A captured supported binding whose page has since left the supported origin
    // lost its content script. Never silently move to the fallback runtime/bucket:
    // report the transient missing state so the panel keeps its view and goes inert
    // until the user explicitly rebinds.
    if (binding.supported && (!supportedActionTab(tab) || new URL(tab.url).origin !== origin))
        return { ok: false, reason: 'missing' };
    const request = message.type === 'memchat:sidebar-view'
        ? { type: 'memchat:view-snapshot' }
        : { type: 'memchat:view-event', documentToken: message.documentToken,
            key: message.key, event: message.event, value: message.value,
            checked: message.checked, selected: message.selected };
    let view;
    try {
        if (binding.supported) view = await sidebarSendToTab(tab.id, request);
        else {
            const session = nativeRuntimeSessions.get(nativeRuntimeSessionKey(sender, origin));
            if (!session) {
                if (message.type !== 'memchat:sidebar-view') return { ok: false, reason: 'changed' };
                return { ok: true, tabId: tab.id, host: new URL(origin).hostname,
                    runtime: { origin, ticket: await nativeRuntimeTicket(sender, message.windowId, origin) } };
            }
            view = await nativeRuntimeRequest(session, request);
        }
    } catch { return { ok: false, reason: 'missing' }; }
    // The bound tab itself must still exist in the panel's window; never re-target
    // to whatever happens to be active. The content documentToken still pins events.
    let alive;
    try { alive = await chrome.tabs.get(tab.id); } catch { return { ok: false, reason: 'closed' }; }
    if (alive.windowId !== message.windowId || !await nativePanelIdentity(sender, message.windowId)) return { ok: false, reason: 'changed' };
    if (!view?.ok) return { ok: false, reason: ['storage', 'conflict', 'changed', 'timeout'].includes(view?.reason) ? view.reason : 'failed' };
    // Only a first binding or an event from the visible bound tab records the
    // selection; a background poll of a non-active tab must not overwrite it.
    const activeBound = message.tabId === undefined || (message.type === 'memchat:sidebar-event'
        && (await chrome.tabs.query({ active: true, windowId: message.windowId }))[0]?.id === tab.id);
    if (binding.supported && activeBound && (await chrome.windows.get(message.windowId)).focused) await nativeRememberOrigin(origin);
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
        || (message.type === 'memchat:sidebar-event' && (!Number.isInteger(message.tabId) || message.tabId < 0
            || typeof message.documentToken !== 'string' || message.documentToken.length > 100
            || typeof message.key !== 'string' || !/^\d{1,8}$/.test(message.key)
            || !['click', 'input', 'change', 'enter'].includes(message.event)))) {
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

function extensionHandleMessage(message, sender, sendResponse) {
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
            }
        }
        sendResponse(result);
    }, () => sendResponse({ event: 'error', error: 'Недопустимый запрос расширения' }));
    return true;
}
chrome.runtime.onMessage.addListener(extensionHandleMessage);

// Register toolbar/context-menu listeners synchronously on every worker wake.
importScripts('controls.js');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL25ldHdvcmsuanMiLCJleHRlbnNpb24vd29ya2VyL3BhbmVsLXNlc3Npb24uanMiLCJleHRlbnNpb24vd29ya2VyL29yZGVyLWFsZXJ0cy5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXJzLmpzIiwiZXh0ZW5zaW9uL25hdGl2ZS1ydW50aW1lLXdvcmtlci5qcyIsImV4dGVuc2lvbi9zaWRlYmFyLXdvcmtlci5qcyIsImV4dGVuc2lvbi93b3JrZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBQcml2YXRlIHN0b3JhZ2UgaXMgb3JpZ2luLXNjb3BlZCB0byBwcmVzZXJ2ZSBleGlzdGluZyBzaXRlL2FjY291bnQgc2VwYXJhdGlvbi5cbi8vIENocm9tZSBvd25zIHBlcnNpc3RlbmNlOyBwYWdlIGxvY2FsU3RvcmFnZSBpcyB1c2VkIG9ubHkgZm9yIG9uZS10aW1lIG1pZ3JhdGlvbi5cbmNvbnN0IHByaXZhdGVTdG9yYWdlUmVhZHkgPSAoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldEFjY2Vzc0xldmVsKHsgYWNjZXNzTGV2ZWw6ICdUUlVTVEVEX0NPTlRFWFRTJyB9KTtcbn0pKCk7XG4vLyBIYW5kbGUgaW5pdGlhbGl6YXRpb24gcmVqZWN0aW9uIGltbWVkaWF0ZWx5LCB3aGlsZSByZXRhaW5pbmcgZmFpbC1jbG9zZWQgYXdhaXRzLlxucHJpdmF0ZVN0b3JhZ2VSZWFkeS5jYXRjaCgoKSA9PiB7fSk7XG5sZXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycyA9IG5ldyBNYXAoKTtcbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtidWNrZXQudmVyc2lvbiwgT2JqZWN0LmtleXMoYnVja2V0Lml0ZW1zKS5zb3J0KCkubWFwKGtleSA9PlxuICAgICAgICBba2V5LCBidWNrZXQuaXRlbXNba2V5XS5yZXZpc2lvbiwgYnVja2V0Lml0ZW1zW2tleV0udmFsdWVdKSxcbiAgICBPYmplY3Qua2V5cyhidWNrZXQubGVnYWN5QmFja3VwIHx8IHt9KS5zb3J0KCkubWFwKGtleSA9PiBba2V5LCBidWNrZXQubGVnYWN5QmFja3VwW2tleV1dKSxcbiAgICAoYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcChlbnRyeSA9PiBbZW50cnkuaWQsIGVudHJ5LmtleSwgZW50cnkudmFsdWUsIGVudHJ5LmRvY3VtZW50LCBlbnRyeS5yZXZpc2lvbl0pLFxuICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIGJ1Y2tldC5yZWNvdmVyeUZlbmNlcyB8fCBbXV0pO1xufVxuLy8gUHJpdmF0ZSB2YXJpYW50cyBhcHBlbmQgbm9ybWFsbHk7IG9ubHkgZXhwbGljaXQgY29uZmlybWVkIHBydW5lIGRlbGV0ZXMgb25lLlxuLy8gTm8gYXV0b21hdGljIGV2aWN0aW9uOiBleGhhdXN0aW9uIGZhaWxzIGNsb3NlZCxcbi8vIGFuZCBjb250ZW50IG11c3QgZXhwbGljaXRseSB3YXJuIHRoYXQgdGhlIG5ld2VzdCBlZGl0IGlzIE5PVCB5ZXQgZHVyYWJsZS5cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCkge1xuICAgIGJ1Y2tldC5yZWNvdmVyaWVzIHx8PSBbXTtcbiAgICBjb25zdCBleGlzdGluZyA9IGJ1Y2tldC5yZWNvdmVyaWVzLmZpbmQoZW50cnkgPT4gZW50cnkua2V5ID09PSBrZXkgJiYgZW50cnkudmFsdWUgPT09IHZhbHVlXG4gICAgICAgICYmIGVudHJ5LmRvY3VtZW50ID09PSBkb2N1bWVudCAmJiBlbnRyeS5yZXZpc2lvbiA9PT0gcmV2aXNpb24pO1xuICAgIGlmIChleGlzdGluZykgcmV0dXJuO1xuICAgIGlmIChidWNrZXQucmVjb3Zlcmllcy5sZW5ndGggPj0gMTI4KSB0aHJvdyBFcnJvcignUmVjb3ZlcnkgY2FwYWNpdHkgZXhoYXVzdGVkJyk7XG4gICAgY29uc3QgaWQgPSBNYXRoLm1heChidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSB8fCAwLCAuLi5idWNrZXQucmVjb3Zlcmllcy5tYXAoZW50cnkgPT4gZW50cnkuaWQpKSArIDE7XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcihpZCkpIHRocm93IEVycm9yKCdSZWNvdmVyeSBJRCBleGhhdXN0ZWQnKTtcbiAgICBidWNrZXQucmVjb3ZlcnlTZXF1ZW5jZSA9IGlkO1xuICAgIGJ1Y2tldC5yZWNvdmVyaWVzLnB1c2goeyBpZCwga2V5LCB2YWx1ZSwgcmV2aXNpb24sIGRvY3VtZW50IH0pO1xuICAgIGlmIChKU09OLnN0cmluZ2lmeShidWNrZXQucmVjb3ZlcmllcykubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSB0aHJvdyBFcnJvcignUmVjb3ZlcnkgY2FwYWNpdHkgZXhoYXVzdGVkJyk7XG59XG5mdW5jdGlvbiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIHtcbiAgICAvLyBOZXZlciBzZW5kIHJlY292ZXJ5IHZhbHVlcyAoZXNwZWNpYWxseSBjcmVkZW50aWFscy9oaXN0b3J5KSBpbnRvIGEgdmlldy5cbiAgICByZXR1cm4gKGJ1Y2tldC5yZWNvdmVyaWVzIHx8IFtdKS5tYXAoKHsgaWQsIGtleSwgdmFsdWUsIHJldmlzaW9uIH0pID0+ICh7IGlkLCBrZXksIGRlbGV0ZWQ6IHZhbHVlID09PSBudWxsLCByZXZpc2lvbiB9KSk7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpIHtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGJ1Y2tldCB9KTtcbiAgICBjb25zdCBjb21taXR0ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICBpZiAoIWNvbW1pdHRlZCB8fCBwcml2YXRlU3RvcmFnZVNuYXBzaG90KGNvbW1pdHRlZCkgIT09IHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSkgdGhyb3cgRXJyb3IoJ1N0b3JhZ2UgdmVyaWZpY2F0aW9uIGZhaWxlZCcpO1xuICAgIHJldHVybiBjb21taXR0ZWQ7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgYXV0aG9yaXphdGlvbikge1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbjtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKTtcbiAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XTtcbiAgICBjb25zdCBhcGkgPSBKU09OLnBhcnNlKHNhdmVkPy5pdGVtc1snbWVtY2hhdDpoYWNrZXJNc0FwaV92MSddPy52YWx1ZSB8fCAne30nKTtcbiAgICByZXR1cm4gYXBpLmJlYXJlckVuYWJsZWQgPT09IHRydWUgJiYgdHlwZW9mIGFwaS50b2tlbiA9PT0gJ3N0cmluZycgJiYgYXV0aG9yaXphdGlvbiA9PT0gJ0JlYXJlciAnICsgYXBpLnRva2VuO1xufVxuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IG9wZXJhdGlvbiA9IHByaXZhdGVTdG9yYWdlQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IHJ1bnRpbWVTZW5kZXJPcmlnaW4oc2VuZGVyKTtcbiAgICAgICAgY29uc3Qgc3RvcmFnZUtleSA9ICdtZW1jaGF0UHJpdmF0ZV92MTonICsgb3JpZ2luO1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoc3RvcmFnZUtleSkpW3N0b3JhZ2VLZXldO1xuICAgICAgICBjb25zdCBidWNrZXQgPSBzYXZlZCB8fCB7IHZlcnNpb246IDEsIGl0ZW1zOiB7fSwgbGVnYWN5QmFja3VwOiB7fSB9O1xuICAgICAgICBpZiAoYnVja2V0LnZlcnNpb24gIT09IDEgfHwgIWJ1Y2tldC5pdGVtcyB8fCB0eXBlb2YgYnVja2V0Lml0ZW1zICE9PSAnb2JqZWN0JykgdGhyb3cgRXJyb3IoJ0ludmFsaWQgc2NoZW1hJyk7XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtaW5pdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGxlZ2FjeSA9IG1lc3NhZ2UubGVnYWN5O1xuICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgT2JqZWN0LmtleXMobGVnYWN5IHx8IHt9KS5sZW5ndGgpIHRocm93IEVycm9yKCdOYXRpdmUgcnVudGltZSBjYW5ub3QgbWlncmF0ZSBwYWdlIGRhdGEnKTtcbiAgICAgICAgICAgIGlmICghbGVnYWN5IHx8IHR5cGVvZiBsZWdhY3kgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkobGVnYWN5KSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbGVnYWN5IHNuYXBzaG90Jyk7XG4gICAgICAgICAgICBjb25zdCBjbGVhbnVwID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHJhd10gb2YgT2JqZWN0LmVudHJpZXMobGVnYWN5KSkge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSB0aHJvdyBFcnJvcignSW52YWxpZCB2YWx1ZScpO1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICdjbGVhclRleHRFbmFibGVkJyAmJiBbJ3RydWUnLCAnZmFsc2UnXS5pbmNsdWRlcyhyYXcpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghT2JqZWN0Lmhhc093bihidWNrZXQuaXRlbXMsICdtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBbJ3RydWUnLCAnZmFsc2UnXS5pbmNsdWRlcyhsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddKSA/IGxlZ2FjeVsnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJ10gOiByYXc7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQuaXRlbXNbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChidWNrZXQuaXRlbXNbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddLnZhbHVlICE9PSByYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHw9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cC5jbGVhclRleHRFbmFibGVkID0gcmF3O1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChNRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSB7IGNsZWFudXAucHVzaChrZXkpOyBjb250aW51ZTsgfVxuICAgICAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHJhdyk7XG4gICAgICAgICAgICAgICAgaWYgKCFzYXZlZCkgYnVja2V0Lml0ZW1zW2tleV0gPSB7IHZhbHVlLCByZXZpc2lvbjogMSB9O1xuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGJ1Y2tldC5pdGVtc1trZXldPy52YWx1ZSAhPT0gdmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQW4gb2xkZXIgdXNlcnNjcmlwdCBtYXkgcmVjcmVhdGUgb2xkIGtleXMuIFByZXNlcnZlIHRoYXQgY29weVxuICAgICAgICAgICAgICAgICAgICAvLyBwcml2YXRlbHksIGJ1dCBuZXZlciByb2xsIGJhY2sgdGhlIGNhbm9uaWNhbCBleHRlbnNpb24gc3RhdGUuXG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHw9IHt9O1xuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY2xlYW51cC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBBY2tub3dsZWRnZSBvbmx5IGFmdGVyIENocm9tZSBjb21taXRzIGFuZCBhIHJlYWQtYmFjayB2ZXJpZmllcyBpdC5cbiAgICAgICAgICAgIGNvbnN0IGNvbW1pdHRlZCA9IGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLnNldChzZW5kZXIudGFiPy5pZCA/PyAnbmF0aXZlOicgKyBzZW5kZXIudXJsLCB7IG9yaWdpbiwgZG9jdW1lbnRJZDogc2VuZGVyLmRvY3VtZW50SWQsIHNlbmRlciB9KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtczogY29tbWl0dGVkLml0ZW1zLCBjbGVhbnVwLCByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChjb21taXR0ZWQpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c3RvcmFnZS1wcnVuZScpIHtcbiAgICAgICAgICAgIC8vIEV4cGxpY2l0IGlycmV2ZXJzaWJsZSBkZWxldGlvbiBvZiBPTkUgaW1tdXRhYmxlIElELCBuZXZlciBhIGJ1bGsgY2xlYXIuXG4gICAgICAgICAgICAvLyBLZWVwIGl0cyBkb2N1bWVudCBmZW5jZSBhZnRlciBkZWxldGlvbiwgYW5kIG5ldmVyIHJlY3ljbGUgSURzIChzdGFsZSBVSS9hY2sgcmV0cmllcykuXG4gICAgICAgICAgICBjb25zdCBzZXF1ZW5jZSA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLihidWNrZXQucmVjb3ZlcmllcyB8fCBbXSkubWFwKGVudHJ5ID0+IGVudHJ5LmlkKSk7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5jb25maXJtZWQgIT09IHRydWUgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1lc3NhZ2UuaWQpIHx8IG1lc3NhZ2UuaWQgPCAxIHx8IG1lc3NhZ2UuaWQgPiBzZXF1ZW5jZSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcHJ1bmUnKTtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gYnVja2V0LnJlY292ZXJpZXM/LmZpbmQoaXRlbSA9PiBpdGVtLmlkID09PSBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlID0gc2VxdWVuY2U7XG4gICAgICAgICAgICBpZiAoZW50cnkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZG9jdW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LnJlY292ZXJ5RmVuY2VzIHx8PSBbXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFidWNrZXQucmVjb3ZlcnlGZW5jZXMuc29tZSgoW2tleSwgZG9jdW1lbnRdKSA9PiBrZXkgPT09IGVudHJ5LmtleSAmJiBkb2N1bWVudCA9PT0gZW50cnkuZG9jdW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQucmVjb3ZlcnlGZW5jZXMucHVzaChbZW50cnkua2V5LCBlbnRyeS5kb2N1bWVudF0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyaWVzID0gYnVja2V0LnJlY292ZXJpZXMuZmlsdGVyKGl0ZW0gPT4gaXRlbS5pZCAhPT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlY292ZXJpZXM6IHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGNvbW1pdHRlZCkgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnXS5pbmNsdWRlcyhtZXNzYWdlLnR5cGUpKSB7XG4gICAgICAgICAgICBjb25zdCByZXN0b3JpbmcgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtcmVzdG9yZSc7XG4gICAgICAgICAgICBjb25zdCByZWNvdmVyeSA9IHJlc3RvcmluZyAmJiBOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmlkKVxuICAgICAgICAgICAgICAgICYmIGJ1Y2tldC5yZWNvdmVyaWVzPy5maW5kKGVudHJ5ID0+IGVudHJ5LmlkID09PSBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIGlmIChyZXN0b3JpbmcgJiYgIXJlY292ZXJ5KSB0aHJvdyBFcnJvcignSW52YWxpZCByZWNvdmVyeScpO1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzdG9yaW5nID8gcmVjb3Zlcnkua2V5IDogbWVzc2FnZS5rZXksIHJldmlzaW9uID0gbWVzc2FnZS5yZXZpc2lvbjtcbiAgICAgICAgICAgIGNvbnN0IHJhdyA9IHJlc3RvcmluZyA/IHJlY292ZXJ5LnZhbHVlIDogbWVzc2FnZS52YWx1ZTtcbiAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHJldmlzaW9uKSB8fCByZXZpc2lvbiA8IDBcbiAgICAgICAgICAgICAgICB8fCByZXZpc2lvbiA+PSBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUlxuICAgICAgICAgICAgICAgIHx8IChyYXcgIT09IG51bGwgJiYgKHR5cGVvZiByYXcgIT09ICdzdHJpbmcnIHx8IHJhdy5sZW5ndGggPiA1ICogMTAyNCAqIDEwMjQpKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgd3JpdGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gYnVja2V0Lml0ZW1zW2tleV0gfHwgeyB2YWx1ZTogbnVsbCwgcmV2aXNpb246IDAgfTtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gcmF3ID09PSBudWxsID8gbnVsbCA6IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBzZW5kZXIuZG9jdW1lbnRJZCB8fCAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSA/ICduYXRpdmU6JyArIHNlbmRlci51cmwgOiAndGFiOicgKyBzZW5kZXIudGFiLmlkKTtcbiAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIGRvY3VtZW50IGZlbmNlIHdpdGggdGhlIGZpcnN0IGNvbmZsaWN0LiBBbHJlYWR5IHNlbnRcbiAgICAgICAgICAgIC8vIG9wdGltaXN0aWMgd3JpdGVzIGNhbm5vdCBhY2NpZGVudGFsbHkgb3ZlcndyaXRlIHRoZSB3aW5uZXIgbGF0ZXIsXG4gICAgICAgICAgICAvLyBpbmNsdWRpbmcgYWZ0ZXIgd29ya2VyIHN1c3BlbnNpb24uIFJlbG9hZCBjcmVhdGVzIGEgbmV3IGRvY3VtZW50LlxuICAgICAgICAgICAgY29uc3QgYmxvY2tlZCA9ICFyZXN0b3JpbmcgJiYgKGJ1Y2tldC5yZWNvdmVyaWVzPy5zb21lKGVudHJ5ID0+IGVudHJ5LmtleSA9PT0ga2V5ICYmIGVudHJ5LmRvY3VtZW50ID09PSBkb2N1bWVudClcbiAgICAgICAgICAgICAgICB8fCBidWNrZXQucmVjb3ZlcnlGZW5jZXM/LnNvbWUoKFtmZW5jZWRLZXksIGZlbmNlZERvY3VtZW50XSkgPT4gZmVuY2VkS2V5ID09PSBrZXkgJiYgZmVuY2VkRG9jdW1lbnQgPT09IGRvY3VtZW50KSk7XG4gICAgICAgICAgICAvLyBBIGNvbmN1cnJlbnQgd3JpdGVyIG1heSBoYXZlIGNvbW1pdHRlZCB0aGUgaWRlbnRpY2FsIGRlc2lyZWQgdmFsdWUuXG4gICAgICAgICAgICAvLyBPbmx5IGFjY2VwdCB0aGUgaW1tZWRpYXRlbHkgcHJlY2VkaW5nIHJldmlzaW9uIHNvIG9wdGltaXN0aWMgcXVldWVkXG4gICAgICAgICAgICAvLyB3cml0ZXMgY29udGludWUgZnJvbSB0aGUgcmV2aXNpb24gdGhlIGNvbnRlbnQgYWRhcHRlciBwcmVkaWN0ZWQuXG4gICAgICAgICAgICBpZiAoIWJsb2NrZWQgJiYgIXJlc3RvcmluZyAmJiBwcmV2aW91cy5yZXZpc2lvbiA9PT0gcmV2aXNpb24gKyAxICYmIHByZXZpb3VzLnZhbHVlID09PSB2YWx1ZSkgcmV0dXJuIHsgb2s6IHRydWUsIGl0ZW06IHByZXZpb3VzIH07XG4gICAgICAgICAgICBpZiAoYmxvY2tlZCB8fCBwcmV2aW91cy5yZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgbWVzc2FnZS5wcmV2aW91c1ZhbHVlICE9PSBwcmV2aW91cy52YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmICghcmVzdG9yaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgdmFsdWUsIHJldmlzaW9uLCBkb2N1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgY29uZmxpY3Q6IHRydWUsIHJlY292ZXJlZDogdHJ1ZSwga2V5LCBpdGVtOiBwcmV2aW91cyxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoYnVja2V0KSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlc3RvcmluZyAmJiBwcmV2aW91cy52YWx1ZSAhPT0gdmFsdWUpIHByaXZhdGVTdG9yYWdlUmVjb3ZlcihidWNrZXQsIGtleSwgcHJldmlvdXMudmFsdWUsIHByZXZpb3VzLnJldmlzaW9uLCBudWxsKTtcbiAgICAgICAgICAgIGNvbnN0IGl0ZW0gPSB7IHZhbHVlLCByZXZpc2lvbjogcmV2aXNpb24gKyAxIH07XG4gICAgICAgICAgICBidWNrZXQuaXRlbXNba2V5XSA9IGl0ZW07XG4gICAgICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgLy8gQmVzdC1lZmZvcnQgcHJpdmF0ZSBpbnZhbGlkYXRpb247IGNsb3NlZC9yZXBsYWNlZCBkb2N1bWVudHMgYXJlIGlnbm9yZWQuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFt0YWJJZCwgc3Vic2NyaWJlcl0gb2YgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycykge1xuICAgICAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gKHNlbmRlci50YWI/LmlkID8/ICduYXRpdmU6JyArIHNlbmRlci51cmwpIHx8IHN1YnNjcmliZXIub3JpZ2luICE9PSBvcmlnaW4pIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdGFiSWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7IG5hdGl2ZVJ1bnRpbWVOb3RpZnkoc3Vic2NyaWJlci5zZW5kZXIsIHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1jaGFuZ2VkJywga2V5LCBpdGVtIH0pOyB9XG4gICAgICAgICAgICAgICAgICAgIGNhdGNoIHsgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUodGFiSWQpOyB9XG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb25zID0gc3Vic2NyaWJlci5kb2N1bWVudElkID8geyBkb2N1bWVudElkOiBzdWJzY3JpYmVyLmRvY3VtZW50SWQgfSA6IHsgZnJhbWVJZDogMCB9O1xuICAgICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6ICdtZW1jaGF0OnN0b3JhZ2UtY2hhbmdlZCcsIGtleSwgaXRlbSB9LCBvcHRpb25zKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmdldCh0YWJJZCkgPT09IHN1YnNjcmliZXIpIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZGVsZXRlKHRhYklkKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBrZXksIGl0ZW0sIC4uLihyZXN0b3JpbmcgPyB7IHJlY292ZXJpZXM6IHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGJ1Y2tldCkgfSA6IHt9KSB9O1xuICAgICAgICB9XG4gICAgICAgIHRocm93IEVycm9yKCdJbnZhbGlkIG9wZXJhdGlvbicpO1xuICAgIH0pO1xuICAgIHByaXZhdGVTdG9yYWdlQ2hhaW4gPSBvcGVyYXRpb24uY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBvcGVyYXRpb247XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IHBlbmRpbmdSZXF1ZXN0cyA9IG5ldyBNYXAoKTtcbmNvbnN0IHJ1bGVzUmVhZHkgPSBjaHJvbWUuZGVjbGFyYXRpdmVOZXRSZXF1ZXN0LnVwZGF0ZVNlc3Npb25SdWxlcyh7XG4gICAgcmVtb3ZlUnVsZUlkczogWzEsIDJdLFxuICAgIGFkZFJ1bGVzOiBbXG4gICAgICAgIHsgaWQ6IDEsIHByaW9yaXR5OiAxLCBhY3Rpb246IHsgdHlwZTogJ21vZGlmeUhlYWRlcnMnLCByZXF1ZXN0SGVhZGVyczogW1xuICAgICAgICAgICAgeyBoZWFkZXI6ICdPcmlnaW4nLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB9LFxuICAgICAgICAgICAgeyBoZWFkZXI6ICdSZWZlcmVyJywgb3BlcmF0aW9uOiAnc2V0JywgdmFsdWU6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9zZWFyY2gnIH1cbiAgICAgICAgXSB9LCBjb25kaXRpb246IHsgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSwgdXJsRmlsdGVyOiAnfGh0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1LycsIHJlc291cmNlVHlwZXM6IFsneG1saHR0cHJlcXVlc3QnXSB9IH0sXG4gICAgICAgIHsgaWQ6IDIsIHByaW9yaXR5OiAyLCBhY3Rpb246IHsgdHlwZTogJ2Jsb2NrJyB9LCBjb25kaXRpb246IHtcbiAgICAgICAgICAgIGluaXRpYXRvckRvbWFpbnM6IFtjaHJvbWUucnVudGltZS5pZF0sXG4gICAgICAgICAgICBleGNsdWRlZFJlcXVlc3REb21haW5zOiBbLi4ubmV3IFNldChNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLm1hcChob3N0ID0+IGhvc3QucmVwbGFjZSgvXlxcKlxcLi8sICcnKSkpXSxcbiAgICAgICAgICAgIHJlc291cmNlVHlwZXM6IFsneG1saHR0cHJlcXVlc3QnXVxuICAgICAgICB9IH1cbiAgICBdXG59KTtcbi8vIEZhaWwgY2xvc2VkOiBhIGZhaWxlZCBETlIgc2V0dXAgaXMgY2F1Z2h0IGhlcmUgYW5kIGJsb2NrcyBzdWJzZXF1ZW50IHJlcXVlc3RzLlxubGV0IHJ1bGVGYWlsdXJlID0gZmFsc2U7XG5ydWxlc1JlYWR5LmNhdGNoKCgpID0+IHsgcnVsZUZhaWx1cmUgPSB0cnVlOyB9KTtcblxuZnVuY3Rpb24gbWF0Y2hlc0hvc3QoaG9zdG5hbWUsIHBhdHRlcm4pIHtcbiAgICByZXR1cm4gcGF0dGVybi5zdGFydHNXaXRoKCcqLicpXG4gICAgICAgID8gaG9zdG5hbWUgPT09IHBhdHRlcm4uc2xpY2UoMikgfHwgaG9zdG5hbWUuZW5kc1dpdGgoJy4nICsgcGF0dGVybi5zbGljZSgyKSlcbiAgICAgICAgOiBob3N0bmFtZSA9PT0gcGF0dGVybjtcbn1cblxuZnVuY3Rpb24gYWxsb3dlZFVybChyYXcpIHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgaWYgKHVybC5wcm90b2NvbCAhPT0gJ2h0dHBzOicgfHwgdXJsLnVzZXJuYW1lIHx8IHVybC5wYXNzd29yZCB8fCB1cmwucG9ydFxuICAgICAgICB8fCAhTUVNQ0hBVF9FWFRFTlNJT05fQ09ORklHLm5ldHdvcmtIb3N0cy5zb21lKGhvc3QgPT4gbWF0Y2hlc0hvc3QodXJsLmhvc3RuYW1lLCBob3N0KSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVUkwgbm90IHBlcm1pdHRlZCcpO1xuICAgIH1cbiAgICByZXR1cm4gdXJsO1xufVxuXG5mdW5jdGlvbiB0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHtcbiAgICBpZiAoc2VuZGVyLmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCAhTnVtYmVyLmlzSW50ZWdlcihzZW5kZXIudGFiPy5pZCkgfHwgc2VuZGVyLmZyYW1lSWQgIT09IDApIHJldHVybiBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlbmRlci51cmwpO1xuICAgICAgICByZXR1cm4gdXJsLnByb3RvY29sID09PSAnaHR0cHM6JyAmJiAhdXJsLnBvcnQgJiYgTUVNQ0hBVF9FWFRFTlNJT05fQ09ORklHLnBhZ2VNYXRjaGVzLnNvbWUocGF0dGVybiA9PlxuICAgICAgICAgICAgbWF0Y2hlc0hvc3QodXJsLmhvc3RuYW1lLCBuZXcgVVJMKHBhdHRlcm4ucmVwbGFjZSgnKi4nLCAnd2lsZGNhcmQuJykpLmhvc3RuYW1lLnJlcGxhY2UoJ3dpbGRjYXJkLicsICcqLicpKSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuXG5mdW5jdGlvbiByZXF1ZXN0S2V5KHNlbmRlciwgaWQpIHtcbiAgICByZXR1cm4gdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSA/IGBuYXRpdmU6JHtzZW5kZXIudXJsfToke2lkfWAgOiBgJHtzZW5kZXIudGFiLmlkfToke3NlbmRlci5mcmFtZUlkfToke2lkfWA7XG59XG5cbi8vIERpc3BhdGNoIE1TIHJlcXVlc3RzIGRpcmVjdGx5LiBPbmx5IGEgZmFpbGVkIHJlYWQgd2FpdHMgZm9yIGl0cyBvd24gcmV0cnk7XG4vLyBubyBwcm9maWxlLXdpZGUgcXVvdGEgc3RhdGUsIHJlc2VydmF0aW9ucywgY29uY3VycmVuY3kgY2FwIG9yIHBhY2luZy5cbmZ1bmN0aW9uIGlzTXNKc29uQXBpKHVybCkge1xuICAgIHJldHVybiB1cmwuaG9zdG5hbWUgPT09ICdhcGkubW95c2tsYWQucnUnICYmIC9eXFwvYXBpXFwvcmVtYXBcXC8xXFwuMig/OlxcL3wkKS8udGVzdCh1cmwucGF0aG5hbWUpO1xufVxuZnVuY3Rpb24gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCB0ZXh0ID0gJycpIHtcbiAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgICAgbGV0IHF1b3RhRXJyb3IgPSBmYWxzZTtcbiAgICAgICAgdHJ5IHsgcXVvdGFFcnJvciA9IEpTT04ucGFyc2UodGV4dCk/LmVycm9ycz8uc29tZShlcnJvciA9PiBOdW1iZXIoZXJyb3IuY29kZSkgPT09IDEwNzMpID09PSB0cnVlOyB9IGNhdGNoIHsgLyogTm90IEpTT04uICovIH1cbiAgICAgICAgaWYgKCFbNDA4LCA0MjldLmluY2x1ZGVzKHJlc3BvbnNlLnN0YXR1cykgJiYgcmVzcG9uc2Uuc3RhdHVzIDwgNTAwICYmICFxdW90YUVycm9yKSByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgbG9nbmV4ID0gTnVtYmVyKHJlc3BvbnNlPy5oZWFkZXJzLmdldCgnWC1Mb2duZXgtUmV0cnktQWZ0ZXInKSB8fCAwKTtcbiAgICBjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2U/LmhlYWRlcnMuZ2V0KCdSZXRyeS1BZnRlcicpO1xuICAgIGNvbnN0IHNlY29uZHMgPSByZXRyeUFmdGVyPy50cmltKCkgPyBOdW1iZXIocmV0cnlBZnRlcikgOiAwO1xuICAgIGNvbnN0IHN0YW5kYXJkID0gTnVtYmVyLmlzRmluaXRlKHNlY29uZHMpID8gc2Vjb25kcyAqIDEwMDAgOiBEYXRlLnBhcnNlKHJldHJ5QWZ0ZXIpIC0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBkZWxheSA9IE1hdGgubWF4KDUwMCwgTnVtYmVyLmlzRmluaXRlKGxvZ25leCkgPyBsb2duZXggOiAwLCBOdW1iZXIuaXNGaW5pdGUoc3RhbmRhcmQpID8gc3RhbmRhcmQgOiAwKTtcbiAgICByZXR1cm4gZGVsYXk7XG59XG5mdW5jdGlvbiBtc1dhaXRGb3JSZXRyeShzaWduYWwsIGRlbGF5KSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICBsZXQgcmVtYWluaW5nID0gZGVsYXk7XG4gICAgICAgIGxldCB0aW1lcjtcbiAgICAgICAgY29uc3QgZG9uZSA9ICgpID0+IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgZG9uZSk7IHJlc29sdmUoKTsgfTtcbiAgICAgICAgY29uc3Qgc2NoZWR1bGUgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjaHVuayA9IE1hdGgubWluKHJlbWFpbmluZywgMjE0NzQ4MzY0Nyk7XG4gICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlbWFpbmluZyAtPSBjaHVuaztcbiAgICAgICAgICAgICAgICBpZiAocmVtYWluaW5nID4gMCkgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgICAgICBlbHNlIGRvbmUoKTtcbiAgICAgICAgICAgIH0sIGNodW5rKTtcbiAgICAgICAgfTtcbiAgICAgICAgc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgZG9uZSwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIGRvbmUoKTtcbiAgICAgICAgZWxzZSBzY2hlZHVsZSgpO1xuICAgIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwZXJmb3JtUmVxdWVzdChtZXNzYWdlLCBzZW5kZXIsIGJhY2tncm91bmRTaWduYWwpIHtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWVzc2FnZS5yZXF1ZXN0O1xuICAgIGNvbnN0IHVybCA9IGFsbG93ZWRVcmwocmVxdWVzdD8udXJsKTtcbiAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKCFbJ0dFVCcsICdIRUFEJywgJ1BPU1QnLCAnUFVUJywgJ1BBVENIJywgJ0RFTEVURSddLmluY2x1ZGVzKG1ldGhvZCkpIHRocm93IG5ldyBFcnJvcignTWV0aG9kIG5vdCBwZXJtaXR0ZWQnKTtcbiAgICBpZiAocmVxdWVzdC5kYXRhICE9IG51bGwgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSAhPT0gJ3N0cmluZycpIHRocm93IG5ldyBFcnJvcignQm9keSBtdXN0IGJlIHRleHQnKTtcbiAgICBpZiAocmVxdWVzdC5kYXRhICE9IG51bGwgJiYgWydHRVQnLCAnSEVBRCddLmluY2x1ZGVzKG1ldGhvZCkpIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBib2R5Jyk7XG4gICAgaWYgKHJlcXVlc3QucmVzcG9uc2VUeXBlICYmICFbJ3RleHQnLCAnanNvbiddLmluY2x1ZGVzKHJlcXVlc3QucmVzcG9uc2VUeXBlKSkgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCByZXNwb25zZSB0eXBlJyk7XG4gICAgY29uc3QgaGVhZGVycyA9IG5ldyBIZWFkZXJzKCk7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHJlcXVlc3QuaGVhZGVycyB8fCB7fSkpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBoZWFkZXInKTtcbiAgICAgICAgaWYgKC9eYXV0aG9yaXphdGlvbiQvaS50ZXN0KG5hbWUpICYmIHVybC5ob3N0bmFtZSAhPT0gJ2FwaS5tb3lza2xhZC5ydScpIHRocm93IG5ldyBFcnJvcignQXV0aG9yaXphdGlvbiBob3N0IG5vdCBwZXJtaXR0ZWQnKTtcbiAgICAgICAgaWYgKC9eKG9yaWdpbnxyZWZlcmVyfHVzZXItYWdlbnR8Y29va2llfGhvc3R8Y29udGVudC1sZW5ndGh8Y29ubmVjdGlvbnxhY2NlcHQtZW5jb2Rpbmd8cHJveHktLip8c2VjLS4qKSQvaS50ZXN0KG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgaGVhZGVycy5zZXQobmFtZSwgdmFsdWUpO1xuICAgIH1cbiAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSAmJiBpc01zSnNvbkFwaSh1cmwpICYmIHJlcXVlc3QuY3JlZGVudGlhbEd1YXJkICE9PSB0cnVlKSB0aHJvdyBFcnJvcignTmF0aXZlIGNyZWRlbnRpYWxzIG11c3QgYmUgZ3VhcmRlZCcpO1xuICAgIGNvbnN0IGtleSA9IHJlcXVlc3RLZXkoc2VuZGVyLCBtZXNzYWdlLmlkKTtcbiAgICBpZiAocGVuZGluZ1JlcXVlc3RzLmhhcyhrZXkpKSB0aHJvdyBuZXcgRXJyb3IoJ0R1cGxpY2F0ZSByZXF1ZXN0Jyk7XG4gICAgY29uc3QgZW50cnkgPSB7IGNvbnRyb2xsZXI6IG5ldyBBYm9ydENvbnRyb2xsZXIoKSwgZXZlbnQ6ICcnIH07XG4gICAgcGVuZGluZ1JlcXVlc3RzLnNldChrZXksIGVudHJ5KTtcbiAgICBjb25zdCBjYW5jZWxCYWNrZ3JvdW5kID0gKCkgPT4geyBlbnRyeS5ldmVudCA9ICdhYm9ydCc7IGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTsgfTtcbiAgICBiYWNrZ3JvdW5kU2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbEJhY2tncm91bmQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICBpZiAoYmFja2dyb3VuZFNpZ25hbD8uYWJvcnRlZCkgY2FuY2VsQmFja2dyb3VuZCgpO1xuICAgIGNvbnN0IHRpbWVvdXQgPSBNYXRoLm1pbigzMDAwMCwgTWF0aC5tYXgoMSwgTnVtYmVyKHJlcXVlc3QudGltZW91dCkgfHwgMzAwMDApKTtcbiAgICBsZXQgdGltZXI7XG4gICAgY29uc3QgY2hlY2tDdXJyZW50ID0gcmVxdWVzdC5jcmVkZW50aWFsR3VhcmQgPT09IHRydWUgPyBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxldCBjaGVja1RpbWVyO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICAgICAgICB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpXG4gICAgICAgICAgICAgICAgICAgID8gbmF0aXZlUnVudGltZVJlcXVlc3QobmF0aXZlUnVudGltZUlkZW50aXRpZXMuZ2V0KHNlbmRlciksIHsgdHlwZTogJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50JywgaWQ6IG1lc3NhZ2UuaWQgfSlcbiAgICAgICAgICAgICAgICAgICAgOiBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShzZW5kZXIudGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0OnJlcXVlc3QtY3VycmVudCcsIGlkOiBtZXNzYWdlLmlkIH0sIHNlbmRlci5kb2N1bWVudElkID8geyBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiBzZW5kZXIuZnJhbWVJZCB9KSxcbiAgICAgICAgICAgICAgICBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgY2hlY2tUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShudWxsKSwgMTAwMCk7IH0pXG4gICAgICAgICAgICBdKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQ/LmN1cnJlbnQgPT09IHRydWUgJiYgKCFpc01zSnNvbkFwaSh1cmwpIHx8IHR5cGVvZiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50ICE9PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgfHwgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGhlYWRlcnMuZ2V0KCdhdXRob3JpemF0aW9uJykpKSkgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogTWlzc2luZy9pbnZhbGlkYXRlZCBjb250ZW50IHdvcmxkIGZhaWxzIGNsb3NlZC4gKi8gfVxuICAgICAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KGNoZWNrVGltZXIpOyB9XG4gICAgICAgIGVudHJ5LmV2ZW50ID0gJ2Fib3J0JztcbiAgICAgICAgZW50cnkuY29udHJvbGxlci5hYm9ydCgpO1xuICAgIH0gOiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgIGlmIChydWxlRmFpbHVyZSkgdGhyb3cgbmV3IEVycm9yKCdOZXR3b3JrIHJ1bGVzIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgIGlmICh1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmIHBhbmVsU2Vzc2lvbj8udGFiKSB7XG4gICAgICAgICAgICBpZiAoY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBwYW5lbFJlcXVlc3RWaWFUYWIoeyAuLi5yZXF1ZXN0LCBtZXRob2QgfSwgZW50cnkuY29udHJvbGxlci5zaWduYWwpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGNvbnN0IGNhblJldHJ5ID0gaXNNc0pzb25BcGkodXJsKSAmJiBbJ0dFVCcsICdIRUFEJ10uaW5jbHVkZXMobWV0aG9kKSAmJiBhdHRlbXB0ID09PSAwO1xuICAgICAgICAgICAgbGV0IHJldHJ5RGVsYXk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBlbnRyeS5jb250cm9sbGVyO1xuICAgICAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGVudHJ5LmV2ZW50ID0gJ3RpbWVvdXQnOyBjb250cm9sbGVyLmFib3J0KCk7IH0sIHRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLmhyZWYsIHtcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiByZXF1ZXN0LmRhdGEgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogcmVxdWVzdC5hbm9ueW1vdXMgPT09IHRydWUgPyAnb21pdCcgOiAnaW5jbHVkZScsXG4gICAgICAgICAgICAgICAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsIHJlZGlyZWN0OiBpc01zSnNvbkFwaSh1cmwpID8gJ2Vycm9yJyA6ICdmb2xsb3cnXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgLy8gRE5SIGJsb2NrcyByZWRpcmVjdHMgdG8gdW5ncmFudGVkIGhvc3RzIGJlZm9yZSBzZW5kaW5nIGJ5dGVzLlxuICAgICAgICAgICAgICAgIGFsbG93ZWRVcmwocmVzcG9uc2UudXJsIHx8IHVybC5ocmVmKTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICAgICAgaWYgKHRydXN0ZWROYXRpdmVSdW50aW1lU2VuZGVyKHNlbmRlcikgJiYgY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHRocm93IG5ldyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IGNhblJldHJ5ID8gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCByZXNwb25zZVRleHQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAocmV0cnlEZWxheSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgcGFyc2VkID0gcmVzcG9uc2VUZXh0O1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVxdWVzdC5yZXNwb25zZVR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpOyB9IGNhdGNoIHsgcGFyc2VkID0gbnVsbDsgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGV2ZW50OiAnbG9hZCcsIHJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCwgcmVzcG9uc2VUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2U6IHBhcnNlZCwgcmVzcG9uc2VIZWFkZXJzOiBbLi4ucmVzcG9uc2UuaGVhZGVyc10ubWFwKChbbmFtZSwgdmFsdWVdKSA9PiBgJHtuYW1lfTogJHt2YWx1ZX1gKS5qb2luKFN0cmluZy5mcm9tQ2hhckNvZGUoMTMsIDEwKSksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaW5hbFVybDogcmVzcG9uc2UudXJsIHx8IHVybC5ocmVmLCByZWFkeVN0YXRlOiA0XG4gICAgICAgICAgICAgICAgICAgIH0gfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNhblJldHJ5IHx8IGVudHJ5LmV2ZW50ID09PSAnYWJvcnQnKSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfHwgJ2Vycm9yJywgZXJyb3I6ICfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcgfTtcbiAgICAgICAgICAgICAgICByZXRyeURlbGF5ID0gNTAwO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgfVxuICAgICAgICAgICAgLy8gQSB0aW1lb3V0IGFib3J0cyBpdHMgYXR0ZW1wdCwgbm90IHRoZSBuZXh0IG9uZS4gRXhwbGljaXQgYWJvcnRzIGFuZFxuICAgICAgICAgICAgLy8gY3JlZGVudGlhbCBjaGFuZ2VzIHN0aWxsIGNhbmNlbCB0aGlzIHdhaXQgYW5kIHN1cHByZXNzIHRoZSByZXRyeS5cbiAgICAgICAgICAgIGVudHJ5LmV2ZW50ID0gJyc7XG4gICAgICAgICAgICBlbnRyeS5jb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICAgICAgYXdhaXQgbXNXYWl0Rm9yUmV0cnkoZW50cnkuY29udHJvbGxlci5zaWduYWwsIHJldHJ5RGVsYXkpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGJhY2tncm91bmRTaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsQmFja2dyb3VuZCk7XG4gICAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoa2V5KTtcbiAgICB9XG59XG4iLCIvLyBBIHNpbmdsZSB3b3JrZXIgb3ducyB0aGUgUGFuZWwgdG9rZW4uIE5ldmVyIHBlcnNpc3QgaXQgaW50byBwYWdlIHN0b3JhZ2UuXG5jb25zdCBQQU5FTF9TRVNTSU9OX1RUTCA9IDEyICogNjAgKiAxMDAwO1xuY29uc3QgUEFORUxfU0VTU0lPTl9USU1FT1VUID0gMTUwMDA7XG5sZXQgcGFuZWxTZXNzaW9uID0gbnVsbDtcbmxldCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xubGV0IGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcblxuZnVuY3Rpb24gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGh0bWwpIHtcbiAgICBjb25zdCBjbGVhbiA9IGh0bWwucmVwbGFjZSgvPCEtLVtcXHNcXFNdKj8tLT58PHNjcmlwdFxcYltePl0qPltcXHNcXFNdKj88XFwvc2NyaXB0XFxzKj4vZ2ksICcnKTtcbiAgICBpZiAoLzxpbnB1dFxcYltePl0qXFxidHlwZVxccyo9XFxzKltcIiddP3Bhc3N3b3JkXFxiL2kudGVzdChjbGVhbikpIHJldHVybiAnJztcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBjbGVhbi5tYXRjaCgvPG1ldGFcXGJbXj5dKj4vZ2kpIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IGF0dHJzID0ge307XG4gICAgICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgdGFnLm1hdGNoQWxsKC8oW1xcdy1dKylcXHMqPVxccyooPzpcIihbXlwiXSopXCJ8JyhbXiddKiknKS9nKSkge1xuICAgICAgICAgICAgYXR0cnNbbWF0Y2hbMV0udG9Mb3dlckNhc2UoKV0gPSBtYXRjaFsyXSA/PyBtYXRjaFszXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXR0cnMubmFtZT8udG9Mb3dlckNhc2UoKSA9PT0gJ2NzcmYtdG9rZW4nICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChhdHRycy5jb250ZW50IHx8ICcnKSkgcmV0dXJuIGF0dHJzLmNvbnRlbnQ7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cblxubGV0IHBhbmVsVGFiU2VxdWVuY2UgPSAwO1xuZnVuY3Rpb24gcGFuZWxUYWJVcmwocmF3KSB7XG4gICAgdHJ5IHsgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpOyByZXR1cm4gdXJsLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmQgJiYgIS9eXFwvbG9naW5cXC8/JC8udGVzdCh1cmwucGF0aG5hbWUpOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmZ1bmN0aW9uIHBhbmVsVGFiUmVxdWVzdEFsbG93ZWQocmVxdWVzdCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxdWVzdD8udXJsKSwgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gcGFuZWxUYWJVcmwodXJsLmhyZWYpICYmICF1cmwuaGFzaCAmJiAhdXJsLnNlYXJjaCAmJiAoKG1ldGhvZCA9PT0gJ0dFVCdcbiAgICAgICAgICAgICYmICh1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAvXlxcL2FwaVxcL2JvbnVzZXNcXC9jaGVja1xcL1xcZHsxLDIwfSQvLnRlc3QodXJsLnBhdGhuYW1lKSkpXG4gICAgICAgICAgICB8fCAobWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZWFyY2gnICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgPT09ICdzdHJpbmcnICYmIHJlcXVlc3QuZGF0YS5sZW5ndGggPD0gMzI3NjgpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFRhYk1lc3NhZ2UodGFiSWQsIHBheWxvYWQsIHNpZ25hbCkge1xuICAgIGNvbnN0IGlkID0gJ3BhbmVsLScgKyBEYXRlLm5vdygpICsgJy0nICsgKCsrcGFuZWxUYWJTZXF1ZW5jZSk7XG4gICAgbGV0IHRpbWVyLCBhYm9ydDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBhYm9ydCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgb3BlcmF0aW9uOiAnY2FuY2VsJyB9LCB7IGZyYW1lSWQ6IDAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgICAgICAgIHJlc29sdmUobnVsbCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KGFib3J0LCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc2lnbmFsPy5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IFByb21pc2UucmFjZShbY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6cGFuZWwtdGFiJywgaWQsIC4uLnBheWxvYWQgfSwgeyBmcmFtZUlkOiAwIH0pLCB0aW1lb3V0XSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XG4gICAgZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBhYm9ydCk7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHJlY292ZXJQYW5lbEZyb21UYWIoc2lnbmFsKSB7XG4gICAgaWYgKCFjaHJvbWUudGFicz8ucXVlcnkgfHwgIWNocm9tZS50YWJzPy5nZXQgfHwgc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRhYnMgPSAoYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS8qJyB9KSkuZmlsdGVyKHRhYiA9PiBOdW1iZXIuaXNJbnRlZ2VyKHRhYi5pZCkgJiYgcGFuZWxUYWJVcmwodGFiLnVybCkpO1xuICAgICAgICB0YWJzLnNvcnQoKGEsIGIpID0+IE51bWJlcighIWIuYWN0aXZlKSAtIE51bWJlcighIWEuYWN0aXZlKSB8fCAoYi5sYXN0QWNjZXNzZWQgfHwgMCkgLSAoYS5sYXN0QWNjZXNzZWQgfHwgMCkgfHwgYS5pZCAtIGIuaWQpO1xuICAgICAgICBmb3IgKGNvbnN0IHRhYiBvZiB0YWJzLnNsaWNlKDAsIDMpKSB7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2UodGFiLmlkLCB7IG9wZXJhdGlvbjogJ3Nlc3Npb24nIH0sIHNpZ25hbCk7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYi5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgaWYgKHJlcGx5Py5vayAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QocmVwbHkudG9rZW4gfHwgJycpICYmIHR5cGVvZiByZXBseS5pbnN0YW5jZSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAmJiByZXBseS5pbnN0YW5jZS5sZW5ndGggPD0gMTAwICYmIHBhbmVsVGFiVXJsKGN1cnJlbnQ/LnVybCkpIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSB7IHRva2VuOiByZXBseS50b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSwgdGFiOiB7IGlkOiB0YWIuaWQsIGluc3RhbmNlOiByZXBseS5pbnN0YW5jZSB9IH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuOiByZXBseS50b2tlbiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC9uYXZpZ2F0ZWQgdGFicyBhcmUgbm90IGFuIGF1dGhlbnRpY2F0ZWQgc2Vzc2lvbi4gKi8gfVxuICAgIHJldHVybiBudWxsO1xufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxSZXF1ZXN0VmlhVGFiKHJlcXVlc3QsIHNpZ25hbCkge1xuICAgIGNvbnN0IHJvdXRlID0gcGFuZWxTZXNzaW9uPy50YWI7XG4gICAgaWYgKCFyb3V0ZSB8fCAhcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSkgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC30LDQv9GA0L7RgSDQvtGC0LrQu9C+0L3RkdC9JyB9O1xuICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQocm91dGUuaWQpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmICghcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6IHNpZ25hbC5hYm9ydGVkID8gJ2Fib3J0JyA6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INCy0LrQu9Cw0LTQutCwINC30LDQutGA0YvRgtCwINC40LvQuCDQuNC30LzQtdC90LXQvdCwLiDQn9C+0LLRgtC+0YDQuNGC0LUg0L/RgNC+0LLQtdGA0LrRgyBwYW5lbC4nIH07XG4gICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2Uocm91dGUuaWQsIHsgb3BlcmF0aW9uOiAncmVxdWVzdCcsIGluc3RhbmNlOiByb3V0ZS5pbnN0YW5jZSwgcmVxdWVzdCB9LCBzaWduYWwpO1xuICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6ICdhYm9ydCcgfTtcbiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFyZXBseT8ub2sgfHwgcmVwbHkuaW5zdGFuY2UgIT09IHJvdXRlLmluc3RhbmNlIHx8ICFwYW5lbFRhYlVybChhZnRlcj8udXJsKSB8fCByZXBseS5yZXN1bHQ/LmV2ZW50ICE9PSAnbG9hZCdcbiAgICAgICAgfHwgIU51bWJlci5pc0ludGVnZXIocmVwbHkucmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpIHx8IHJlcGx5LnJlc3VsdC5yZXNwb25zZT8uZmluYWxVcmwgIT09IHJlcXVlc3QudXJsKSB7XG4gICAgICAgIGlmIChwYW5lbFNlc3Npb24/LnRhYiA9PT0gcm91dGUpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ1BhbmVsOiDQutC+0L3RgtC10LrRgdGCINCy0LrQu9Cw0LTQutC4INC40LfQvNC10L3QuNC70YHRjy4g0J3QsNC20LzQuNGC0LUgcGFuZWwg0LTQu9GPINC/0L7QstGC0L7RgNC90L7QuSDQv9GA0L7QstC10YDQutC4LicgfTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcGx5LnJlc3VsdDtcbn1cblxuZnVuY3Rpb24gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpIHtcbiAgICAvLyBBIHF1ZXVlZCBub3JtYWwgZmxpZ2h0IG1heSBoYXZlIHBvcHVsYXRlZCB0aGUgY2FjaGUgc2luY2UgZm9yY2Ugd2FzIHJlcXVlc3RlZC5cbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgY29uc3QgZmxpZ2h0ID0geyBwcm9taXNlOiBudWxsIH07XG4gICAgZmxpZ2h0LnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICBjb25zdCBmYWlsdXJlID0gYXN5bmMgKHJlYXNvbiwgZXJyb3IpID0+IChhd2FpdCByZWNvdmVyUGFuZWxGcm9tVGFiKGNvbnRyb2xsZXIuc2lnbmFsKSkgfHwgeyBvazogZmFsc2UsIHJlYXNvbiwgZXJyb3IgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgICAgICBpZiAocnVsZUZhaWx1cmUgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IEVycm9yKCdQYW5lbCB1bmF2YWlsYWJsZScpO1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJywge1xuICAgICAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsIGhlYWRlcnM6IHsgQWNjZXB0OiAndGV4dC9odG1sJyB9LCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLFxuICAgICAgICAgICAgICAgIGNhY2hlOiAnbm8tc3RvcmUnLCByZWRpcmVjdDogJ2ZvbGxvdycsIHNpZ25hbDogY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgZmluYWxVcmwgPSBuZXcgVVJMKHJlc3BvbnNlLnVybCB8fCAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJyk7XG4gICAgICAgICAgICBpZiAoZmluYWxVcmwub3JpZ2luICE9PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIHx8ICEvXlxcL3NlYXJjaFxcLz8kLy50ZXN0KGZpbmFsVXJsLnBhdGhuYW1lKVxuICAgICAgICAgICAgICAgIHx8IHJlc3BvbnNlLnN0YXR1cyA8IDIwMCB8fCByZXNwb25zZS5zdGF0dXMgPj0gMzAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ2F1dGgnLCAnUGFuZWw6INGE0L7QvdC+0LLRi9C5INCy0YXQvtC0INC90LXQtNC+0YHRgtGD0L/QtdC9LiDQntGC0LrRgNC+0LnRgtC1INCw0LLRgtC+0YDQuNC30L7QstCw0L3QvdGD0Y4gcGFuZWwuaGF0aWtvLnJ1INCyINGN0YLQvtC8INC/0YDQvtGE0LjQu9C1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdG9rZW4gPSBleHRyYWN0UGFuZWxTZXNzaW9uVG9rZW4oYXdhaXQgcmVzcG9uc2UudGV4dCgpKTtcbiAgICAgICAgICAgIGlmICghdG9rZW4gfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ2F1dGgnLCAnUGFuZWw6INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/QvtC00YLQstC10YDQtNC40YLRjCDQstGF0L7QtC4g0J7RgtC60YDQvtC50YLQtSBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICAvLyBMYXJhdmVsIGlzc3VlcyBDU1JGIGV2ZW4gZm9yIGFub255bW91cyBsb2dpbiBwYWdlcy4gQ29uZmlybSBhY2Nlc3NcbiAgICAgICAgICAgIC8vIHRvIGFuIGFjdHVhbCBwcm90ZWN0ZWQgcmVhZC1vbmx5IEFQSSB3aXRoIHRoZSBzYW1lIGJyb3dzZXIgY29va2llcy5cbiAgICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvYXBpL3NlYXJjaC9maWx0ZXJzJywge1xuICAgICAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsIGhlYWRlcnM6IHsgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsICdYLVJlcXVlc3RlZC1XaXRoJzogJ1hNTEh0dHBSZXF1ZXN0JyB9LFxuICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsIGNhY2hlOiAnbm8tc3RvcmUnLCByZWRpcmVjdDogJ2ZvbGxvdycsIHNpZ25hbDogY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgYXV0aFVybCA9IG5ldyBVUkwoYXV0aC51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycpO1xuICAgICAgICAgICAgaWYgKGF1dGguc3RhdHVzIDwgMjAwIHx8IGF1dGguc3RhdHVzID49IDMwMCB8fCBhdXRoVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1J1xuICAgICAgICAgICAgICAgIHx8IGF1dGhVcmwucGF0aG5hbWUgIT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAhL2FwcGxpY2F0aW9uXFwvanNvbi9pLnRlc3QoYXV0aC5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykgfHwgJycpKSB7XG4gICAgICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZmFpbHVyZShhdXRoLnN0YXR1cyA+PSA1MDAgPyAnbmV0d29yaycgOiAnYXV0aCcsICdQYW5lbDog0L3QtdGCINC00L7RgdGC0YPQv9CwINC6IEFQSS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHByb29mID0gYXdhaXQgYXV0aC5qc29uKCk7XG4gICAgICAgICAgICBpZiAoIXByb29mIHx8IHR5cGVvZiBwcm9vZiAhPT0gJ29iamVjdCcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgUGFuZWwgYXV0aCBwcm9vZicpO1xuICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0geyB0b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSB9O1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuIH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ25ldHdvcmsnLCAnUGFuZWw6INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/RgNC+0LLQtdGA0LjRgtGMINCy0YXQvtC0LiDQn9GA0L7QstC10YDRjNGC0LUg0YHQvtC10LTQuNC90LXQvdC40LUg0Lgg0L7RgtC60YDRi9GC0YPRjiDQstC60LvQsNC00LrRgyBwYW5lbC5oYXRpa28ucnUuJyk7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgaWYgKGZvcmNlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gZmxpZ2h0KSBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgfVxuICAgIH0pKCk7XG4gICAgaWYgKGZvcmNlKSBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBmbGlnaHQ7XG4gICAgZWxzZSBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBmbGlnaHQ7XG4gICAgcmV0dXJuIGZsaWdodC5wcm9taXNlO1xufVxuXG5mdW5jdGlvbiBnZXRQYW5lbFNlc3Npb24oZm9yY2UpIHtcbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgaWYgKGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAoZm9yY2UgJiYgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0KSB7XG4gICAgICAgIGNvbnN0IHF1ZXVlZCA9IHsgcHJvbWlzZTogbnVsbCB9O1xuICAgICAgICBxdWV1ZWQucHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTsgfVxuICAgICAgICAgICAgZmluYWxseSB7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gcXVldWVkKSBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0UGFuZWxTZXNzaW9uRmxpZ2h0KHRydWUpO1xuICAgICAgICB9KSgpO1xuICAgICAgICBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBxdWV1ZWQ7XG4gICAgICAgIHJldHVybiBxdWV1ZWQucHJvbWlzZTtcbiAgICB9XG4gICAgaWYgKCFmb3JjZSAmJiBwYW5lbFNlc3Npb24gJiYgRGF0ZS5ub3coKSAtIHBhbmVsU2Vzc2lvbi5zYXZlZEF0IDwgUEFORUxfU0VTU0lPTl9UVEwpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogdHJ1ZSwgdG9rZW46IHBhbmVsU2Vzc2lvbi50b2tlbiB9KTtcbiAgICBpZiAoIWZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodChmb3JjZSk7XG59XG4iLCIvLyBFeHRlbnNpb24tb3duZWQgcHJlc2VudGF0aW9uLiBObyBzaXRlIERPTSwgdG9rZW5zLCBvciBjb250ZW50LXRhYiBhdWRpby5cbmNvbnN0IE9SREVSX05PVElGSUNBVElPTl9JRCA9ICdtZW1jaGF0LW9yZGVycyc7XG5jb25zdCBPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZID0gJ21lbWNoYXQtb3JkZXItbm90aWZpY2F0aW9uLWV4cGlyZSc7XG5mdW5jdGlvbiBvcmRlckJlYXJJY29uKHNpemUpIHtcbiAgICBjb25zdCBjYW52YXMgPSBuZXcgT2Zmc2NyZWVuQ2FudmFzKHNpemUsIHNpemUpLCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKSwgcyA9IHNpemUgLyAzMjtcbiAgICBjb25zdCBvdmFsID0gKHgsIHksIHJ4LCByeSwgY29sb3IpID0+IHsgY3R4LmZpbGxTdHlsZSA9IGNvbG9yOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5lbGxpcHNlKHggKiBzLCB5ICogcywgcnggKiBzLCByeSAqIHMsIDAsIDAsIE1hdGguUEkgKiAyKTsgY3R4LmZpbGwoKTsgfTtcbiAgICBvdmFsKDcsIDcsIDYsIDYsICcjNzEzZjJhJyk7IG92YWwoMjUsIDcsIDYsIDYsICcjNzEzZjJhJyk7XG4gICAgb3ZhbCg3LCA3LCAzLCAzLCAnI2Q4YWE3OCcpOyBvdmFsKDI1LCA3LCAzLCAzLCAnI2Q4YWE3OCcpO1xuICAgIG92YWwoMTYsIDE4LCAxNCwgMTMsICcjOTg2MjNiJyk7XG4gICAgb3ZhbCgxNiwgMjQsIDgsIDYsICcjZWRjOTliJyk7XG4gICAgb3ZhbCgxMCwgMTcsIDIsIDIuNSwgJyMyMzE1MGUnKTsgb3ZhbCgyMiwgMTcsIDIsIDIuNSwgJyMyMzE1MGUnKTtcbiAgICBvdmFsKDE2LCAyMiwgMywgMiwgJyMyMzE1MGUnKTsgb3ZhbCgxNiwgMjYsIDIsIDEsICcjNzEzZjJhJyk7XG4gICAgcmV0dXJuIGN0eC5nZXRJbWFnZURhdGEoMCwgMCwgc2l6ZSwgc2l6ZSk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclVwZGF0ZUljb24oKSB7XG4gICAgaWYgKCFjaHJvbWUuYWN0aW9uPy5zZXRJY29uKSByZXR1cm47XG4gICAgY29uc3QgZW5hYmxlZCA9IG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkID09PSB0cnVlO1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0SWNvbihlbmFibGVkID8geyBpbWFnZURhdGE6IHsgMTY6IG9yZGVyQmVhckljb24oMTYpLCAzMjogb3JkZXJCZWFySWNvbigzMikgfSB9IDogeyBwYXRoOiAnaWNvbi5wbmcnIH0pO1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoeyB0aXRsZTogZW5hYmxlZCA/ICfwn5C7INCe0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLQutC70Y7Rh9GR0L0gwrcg0J7RgtC60YDRi9GC0Ywg0LHQvtC60L7QstGD0Y4g0L/QsNC90LXQu9GMIE1lbWNoYXQnIDogJ9Ce0YLQutGA0YvRgtGMINCc0LXQvNGH0LDRgiDQsiDQsdC+0LrQvtCy0L7QuSDQv9Cw0L3QtdC70LgnIH0pO1xufVxubGV0IG9yZGVyQXVkaW9DcmVhdGluZyA9IG51bGw7XG5sZXQgb3JkZXJBdWRpb0dlbmVyYXRpb24gPSAwO1xuYXN5bmMgZnVuY3Rpb24gb3JkZXJTdG9wQXVkaW8oKSB7XG4gICAgb3JkZXJBdWRpb0dlbmVyYXRpb24rKztcbiAgICBpZiAoIWNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydPRkZTQ1JFRU5fRE9DVU1FTlQnXSwgZG9jdW1lbnRVcmxzOiBbY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpXSB9KTtcbiAgICBpZiAoY29udGV4dHMubGVuZ3RoKSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHRhcmdldDogJ21lbWNoYXQtb2Zmc2NyZWVuJywgdHlwZTogJ21lbWNoYXQ6YXVkaW8tc3RvcCcgfSk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlckVuc3VyZUF1ZGlvKCkge1xuICAgIGlmIChvcmRlckF1ZGlvQ3JlYXRpbmcpIHJldHVybiBvcmRlckF1ZGlvQ3JlYXRpbmc7XG4gICAgb3JkZXJBdWRpb0NyZWF0aW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydPRkZTQ1JFRU5fRE9DVU1FTlQnXSwgZG9jdW1lbnRVcmxzOiBbY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpXSB9KTtcbiAgICAgICAgaWYgKCFjb250ZXh0cy5sZW5ndGgpIGF3YWl0IGNocm9tZS5vZmZzY3JlZW4uY3JlYXRlRG9jdW1lbnQoeyB1cmw6ICdvZmZzY3JlZW4uaHRtbCcsIHJlYXNvbnM6IFsnQVVESU9fUExBWUJBQ0snXSwganVzdGlmaWNhdGlvbjogJ09uZSBzaGFyZWQgTWVtY2hhdCBvcmRlciBhbGFybSwgaW5kZXBlbmRlbnQgb2Ygb3BlbiBNb3lTa2xhZCB0YWJzLicgfSk7XG4gICAgfSkoKS5maW5hbGx5KCgpID0+IHsgb3JkZXJBdWRpb0NyZWF0aW5nID0gbnVsbDsgfSk7XG4gICAgcmV0dXJuIG9yZGVyQXVkaW9DcmVhdGluZztcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyUGxheUF1ZGlvKGlzQ3VycmVudCA9ICgpID0+IHRydWUpIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gb3JkZXJBdWRpb0dlbmVyYXRpb247XG4gICAgYXdhaXQgb3JkZXJFbnN1cmVBdWRpbygpO1xuICAgIGlmICghaXNDdXJyZW50KCkgfHwgZ2VuZXJhdGlvbiAhPT0gb3JkZXJBdWRpb0dlbmVyYXRpb24pIHJldHVybjtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdGFyZ2V0OiAnbWVtY2hhdC1vZmZzY3JlZW4nLCB0eXBlOiAnbWVtY2hhdDphdWRpby1wbGF5JyB9KTtcbiAgICBpZiAoIXJlc3BvbnNlPy5vaykgdGhyb3cgRXJyb3IoJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9Jyk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclByZXNlbnRSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gKCkgPT4gY29uZmlnID09PSBvcmRlckNvbmZpZyAmJiBjb25maWcuc2V0dGluZ3MuZW5hYmxlZCAmJiAhY29udHJvbGxlci5zaWduYWwuYWJvcnRlZDtcbiAgICBpZiAoIXJlc3VsdC5vcmRlcnMubGVuZ3RoIHx8ICFjdXJyZW50KCkpIHJldHVybiBbXTtcbiAgICBjb25zdCBub3RpZnkgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5nZXRQZXJtaXNzaW9uTGV2ZWwoKTtcbiAgICAgICAgaWYgKCFjdXJyZW50KCkpIHJldHVybjtcbiAgICAgICAgaWYgKHBlcm1pc3Npb24gIT09ICdncmFudGVkJykgdGhyb3cgRXJyb3IoJ9Cj0LLQtdC00L7QvNC70LXQvdC40Y8g0L7RgtC60LvRjtGH0LXQvdGLINCyINCx0YDQsNGD0LfQtdGA0LUnKTtcbiAgICAgICAgY29uc3Qgb3JkZXJzID0gcmVzdWx0Lm9yZGVycztcbiAgICAgICAgYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKE9SREVSX05PVElGSUNBVElPTl9JRCwgeyB0eXBlOiAnYmFzaWMnLCBpY29uVXJsOiAnaWNvbi5wbmcnLFxuICAgICAgICAgICAgdGl0bGU6ICfwn5C7IE1lbWNoYXQgwrcg0JfQsNC60LDQt9GLOiAnICsgb3JkZXJzLmxlbmd0aCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IG9yZGVycy5zbGljZSgwLCAzKS5tYXAoaXRlbSA9PiBTdHJpbmcoaXRlbS5uYW1lKS5zbGljZSgwLCA4MCkgKyAnIMK3ICcgKyBTdHJpbmcoaXRlbS5vcmdhbml6YXRpb25OYW1lKS5zbGljZSgwLCA4MCkpLmpvaW4oJ1xcbicpICsgKHJlc3VsdC5wYXJ0aWFsID8gJ1xcbuKaoCDQntC/0YDQvtGBINC90LXQv9C+0LvQvdGL0LknIDogJycpLFxuICAgICAgICAgICAgcHJpb3JpdHk6IDAsIHNpbGVudDogdHJ1ZSwgcmVxdWlyZUludGVyYWN0aW9uOiBjb25maWcuc2V0dGluZ3MudG9hc3REdXJhdGlvbk1pbnV0ZXMgPT09IDAgfSk7XG4gICAgICAgIGlmICghY3VycmVudCgpKSB7IGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCk7IHJldHVybjsgfVxuICAgICAgICBpZiAoY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzID4gMCkgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSwgeyB3aGVuOiBEYXRlLm5vdygpICsgY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzICogNjAwMDAgfSk7XG4gICAgICAgIGVsc2UgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKTtcbiAgICB9O1xuICAgIGNvbnN0IHRhc2tzID0gW25vdGlmeSgpXTtcbiAgICBpZiAoY29uZmlnLnNldHRpbmdzLnNvdW5kRW5hYmxlZCkgdGFza3MucHVzaChvcmRlclBsYXlBdWRpbyhjdXJyZW50KSk7XG4gICAgY29uc3Qgb3V0Y29tZXMgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MpO1xuICAgIHJldHVybiBvdXRjb21lcy5mbGF0TWFwKChpdGVtLCBpbmRleCkgPT4gaXRlbS5zdGF0dXMgPT09ICdyZWplY3RlZCcgPyBbaW5kZXggPT09IDAgPyAn0KHQuNGB0YLQtdC80L3Ri9C1INGD0LLQtdC00L7QvNC70LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C90YsnIDogJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9J10gOiBbXSk7XG59XG5pZiAoY2hyb21lLm5vdGlmaWNhdGlvbnM/Lm9uQ2xpY2tlZCkgY2hyb21lLm5vdGlmaWNhdGlvbnMub25DbGlja2VkLmFkZExpc3RlbmVyKGlkID0+IHtcbiAgICBpZiAoaWQgIT09IE9SREVSX05PVElGSUNBVElPTl9JRCkgcmV0dXJuO1xuICAgIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogJ2h0dHBzOi8vb25saW5lLm1veXNrbGFkLnJ1L2FwcC8jY3VzdG9tZXJvcmRlcicsIGFjdGl2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoaWQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBjaHJvbWUuYWxhcm1zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkpLmNhdGNoKCgpID0+IHt9KTtcbn0pO1xuIiwiLy8gU2hhcmVkIG9yZGVyIHBvbGxpbmcgaXMgaW5kZXBlbmRlbnQgb2YgdGhlIGxpZmV0aW1lL251bWJlciBvZiBjb250ZW50IHRhYnMuXG4vLyBTZXNzaW9uIHN0b3JhZ2UgaXMgZXh0ZW5zaW9uLXByaXZhdGU7IGJlYXJlciBuZXZlciBlbnRlcnMgYSBicm9hZGNhc3Qgb3IgbG9ncy5cbmNvbnN0IE9SREVSX1NFU1NJT05fS0VZID0gJ21lbWNoYXRPcmRlclNlcnZpY2VfdjEnO1xubGV0IG9yZGVyQ29uZmlnID0gbnVsbDtcbmxldCBvcmRlclN1YnNjcmliZXJzID0gbmV3IFNldCgpO1xubGV0IG9yZGVyUmV2aXNpb24gPSAwO1xubGV0IG9yZGVyRmxpZ2h0ID0gbnVsbDtcbmxldCBvcmRlckNvbnRyb2xsZXIgPSBudWxsO1xubGV0IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG5sZXQgb3JkZXJDb25maWdDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gb3JkZXJNdXRhdGUoY2FsbGJhY2spIHtcbiAgICBjb25zdCBuZXh0ID0gb3JkZXJDb25maWdDaGFpbi50aGVuKGNhbGxiYWNrKTtcbiAgICBvcmRlckNvbmZpZ0NoYWluID0gbmV4dC5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIG5leHQ7XG59XG5jb25zdCBvcmRlclJlYWR5ID0gKGFzeW5jICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChPUkRFUl9TRVNTSU9OX0tFWSkpW09SREVSX1NFU1NJT05fS0VZXTtcbiAgICAgICAgaWYgKHNhdmVkKSB7IG9yZGVyQ29uZmlnID0gc2F2ZWQuY29uZmlnOyBvcmRlclJldmlzaW9uID0gc2F2ZWQucmV2aXNpb24gfHwgMDsgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoc2F2ZWQuc3Vic2NyaWJlcnMgfHwgW10pOyB9XG4gICAgICAgIGF3YWl0IG9yZGVyVXBkYXRlSWNvbigpO1xuICAgIH0gY2F0Y2ggeyAvKiBDb25maWd1cmUgbXVzdCBzdWNjZXNzZnVsbHkgcGVyc2lzdCBiZWZvcmUgZW5hYmxpbmcgcG9sbGluZy4gKi8gfVxufSkoKTtcbmZ1bmN0aW9uIG9yZGVyUHVibGljQ29uZmlnKCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXR0aW5nczogb3JkZXJDb25maWc/LnNldHRpbmdzLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiB9O1xufVxuZnVuY3Rpb24gb3JkZXJSZWZlcmVuY2UodmFsdWUsIGtpbmQpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiBuZXcgUmVnRXhwKCdeaHR0cHM6Ly9hcGlcXFxcLm1veXNrbGFkXFxcXC5ydS9hcGkvcmVtYXAvMVxcXFwuMi9lbnRpdHkvJyArIGtpbmQgKyAnL1tBLVphLXowLTktXSskJykudGVzdCh2YWx1ZSk7XG59XG5mdW5jdGlvbiBvcmRlclNldHRpbmdzKHJhdykge1xuICAgIGNvbnN0IHJlZnMgPSAodmFsdWVzLCBraW5kKSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZXMpIHx8ICF2YWx1ZXMuZXZlcnkodmFsdWUgPT4gb3JkZXJSZWZlcmVuY2UodmFsdWUsIGtpbmQpKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcmVmZXJlbmNlcycpO1xuICAgICAgICByZXR1cm4gWy4uLm5ldyBTZXQodmFsdWVzKV07XG4gICAgfTtcbiAgICByZXR1cm4geyBlbmFibGVkOiByYXc/LmVuYWJsZWQgIT09IGZhbHNlLCBzb3VuZEVuYWJsZWQ6IHJhdz8uc291bmRFbmFibGVkICE9PSBmYWxzZSxcbiAgICAgICAgaW50ZXJ2YWxNaW51dGVzOiBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKE51bWJlcihyYXc/LmludGVydmFsTWludXRlcykgfHwgMSkpKSxcbiAgICAgICAgdG9hc3REdXJhdGlvbk1pbnV0ZXM6IE1hdGgubWluKDE0NDAsIE1hdGgubWF4KDAsIE1hdGgucm91bmQoTnVtYmVyKHJhdz8udG9hc3REdXJhdGlvbk1pbnV0ZXMpIHx8IDApKSksXG4gICAgICAgIG9yZ2FuaXphdGlvbkhyZWZzOiByZWZzKHJhdz8ub3JnYW5pemF0aW9uSHJlZnMsICdvcmdhbml6YXRpb24nKSxcbiAgICAgICAgc3RhdHVzSHJlZnM6IHJlZnMocmF3Py5zdGF0dXNIcmVmcywgJ2N1c3RvbWVyb3JkZXIvbWV0YWRhdGEvc3RhdGVzJykgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyU2V0QWxhcm0oKSB7XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCB8fCAhb3JkZXJDb25maWcuc2V0dGluZ3Muc291bmRFbmFibGVkKSBhd2FpdCBvcmRlclN0b3BBdWRpbygpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBpZiAoIW9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkICYmIGNocm9tZS5ub3RpZmljYXRpb25zPy5jbGVhcikgYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0lEKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgLy8gVG9vbGJhciBwcmVzZW50YXRpb24gbXVzdCBuZXZlciBwcmV2ZW50IHNjaGVkdWxpbmcgb3IgcGF1c2luZyB0aGUgc2VydmljZS5cbiAgICBhd2FpdCBvcmRlclVwZGF0ZUljb24oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKCFjaHJvbWUuYWxhcm1zKSByZXR1cm47XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCkgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKTtcbiAgICBpZiAob3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgJiYgb3JkZXJDb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWxhcm1zLmNyZWF0ZSgnbWVtY2hhdC1vcmRlcnMnLCB7IHBlcmlvZEluTWludXRlczogb3JkZXJDb25maWcuc2V0dGluZ3MuaW50ZXJ2YWxNaW51dGVzIH0pO1xuICAgIH0gZWxzZSBhd2FpdCBjaHJvbWUuYWxhcm1zLmNsZWFyKCdtZW1jaGF0LW9yZGVycycpO1xufVxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlT3JkZXJzKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgaWYgKHR5cGVvZiBtZXNzYWdlLnRva2VuICE9PSAnc3RyaW5nJyB8fCAhbWVzc2FnZS50b2tlbi50cmltKCkgfHwgbWVzc2FnZS50b2tlbi5sZW5ndGggPiA0MDk2KSB0aHJvdyBFcnJvcignSW52YWxpZCB0b2tlbicpO1xuICAgIGNvbnN0IHNldHRpbmdzID0gb3JkZXJTZXR0aW5ncyhtZXNzYWdlLnNldHRpbmdzKTtcbiAgICBjb25zdCB1bmNoYW5nZWQgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gJiYgSlNPTi5zdHJpbmdpZnkob3JkZXJDb25maWcuc2V0dGluZ3MpID09PSBKU09OLnN0cmluZ2lmeShzZXR0aW5ncyk7XG4gICAgaWYgKG9yZGVyQ29uZmlnICYmIChtZXNzYWdlLnVwZGF0ZSAhPT0gdHJ1ZSB8fCB1bmNoYW5nZWQpKSB7XG4gICAgICAgIGlmIChvcmRlckNvbmZpZy50b2tlbiAhPT0gbWVzc2FnZS50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiwgZXJyb3I6ICfQlNGA0YPQs9C+0LkgQmVhcmVyINCyINGE0L7QvdC1LiDQodC+0YXRgNCw0L3QuNGC0LUg0L3QsNGB0YLRgNC+0LnQutC4INGP0LLQvdC+INC00LvRjyDRgdC80LXQvdGLINCw0LrQutCw0YPQvdGC0LAuJyB9O1xuICAgICAgICBpZiAoc2VuZGVyLnRhYikgb3JkZXJTdWJzY3JpYmVycy5hZGQoc2VuZGVyLnRhYi5pZCk7XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWc6IG9yZGVyQ29uZmlnLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiwgc3Vic2NyaWJlcnM6IFsuLi5vcmRlclN1YnNjcmliZXJzXSB9IH0pO1xuICAgICAgICBpZiAoY2hyb21lLmFsYXJtcz8uZ2V0ICYmICEoYXdhaXQgY2hyb21lLmFsYXJtcy5nZXQoJ21lbWNoYXQtb3JkZXJzJykpKSBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIHBvbGxSZXF1aXJlZDogZmFsc2UgfTtcbiAgICB9XG4gICAgaWYgKG9yZGVyQ29uZmlnICYmIG1lc3NhZ2UucmV2aXNpb24gIT09IG9yZGVyUmV2aXNpb24pIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIG9rOiBmYWxzZSwgY29uZmxpY3Q6IHRydWUsIGVycm9yOiAn0J3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90Ysg0LIg0LTRgNGD0LPQvtC5INCy0LrQu9Cw0LTQutC1LiDQn9C+0LLRgtC+0YDQuNGC0LUg0LjQt9C80LXQvdC10L3QuNC1LicgfTtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9yZGVyQ29uZmlnPy50b2tlbiA9PT0gbWVzc2FnZS50b2tlbiA/IG5ldyBTZXQob3JkZXJTdWJzY3JpYmVycykgOiBuZXcgU2V0KCk7XG4gICAgaWYgKHNlbmRlci50YWIpIHN1YnNjcmliZXJzLmFkZChzZW5kZXIudGFiLmlkKTtcbiAgICBjb25zdCBjb25maWcgPSB7IHRva2VuOiBtZXNzYWdlLnRva2VuLCBzZXR0aW5ncywgb3JnYW5pemF0aW9uczogKEFycmF5LmlzQXJyYXkobWVzc2FnZS5vcmdhbml6YXRpb25zKSA/IG1lc3NhZ2Uub3JnYW5pemF0aW9ucyA6IFtdKVxuICAgICAgICAuZmlsdGVyKGl0ZW0gPT4gc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMuaW5jbHVkZXMoaXRlbT8uaHJlZikpLm1hcChpdGVtID0+ICh7IGhyZWY6IGl0ZW0uaHJlZiwgbmFtZTogU3RyaW5nKGl0ZW0ubmFtZSB8fCAnJykuc2xpY2UoMCwgMzAwKSB9KSkgfTtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiArIDEsIHN1YnNjcmliZXJzOiBbLi4uc3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgb3JkZXJDb250cm9sbGVyPy5hYm9ydCgpO1xuICAgIG9yZGVyQ29uZmlnID0gY29uZmlnOyBvcmRlclN1YnNjcmliZXJzID0gc3Vic2NyaWJlcnM7IG9yZGVyUmV2aXNpb24rKzsgb3JkZXJMYXN0UmVzdWx0ID0gbnVsbDtcbiAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgcmV0dXJuIHsgLi4ub3JkZXJQdWJsaWNDb25maWcoKSwgcG9sbFJlcXVpcmVkOiB0cnVlIH07XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlckdldChwYXRoLCBjb25maWcsIGNvbnRyb2xsZXIpIHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHBlcmZvcm1SZXF1ZXN0KHsgaWQ6ICdiYWNrZ3JvdW5kLW9yZGVycycsIHJlcXVlc3Q6IHtcbiAgICAgICAgdXJsOiAnaHR0cHM6Ly9hcGkubW95c2tsYWQucnUvYXBpL3JlbWFwLzEuMicgKyBwYXRoLCBtZXRob2Q6ICdHRVQnLFxuICAgICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246ICdCZWFyZXIgJyArIGNvbmZpZy50b2tlbiwgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04JyB9LFxuICAgICAgICBhbm9ueW1vdXM6IHRydWUsIGJhY2tncm91bmRPcmRlcjogdHJ1ZVxuICAgIH0gfSwgeyB0YWI6IHsgaWQ6IC0xIH0sIGZyYW1lSWQ6IDAgfSwgY29udHJvbGxlci5zaWduYWwpO1xuICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcpIHRocm93IEVycm9yKCdDYW5jZWxsZWQnKTtcbiAgICBpZiAocmVzcG9uc2UuZXZlbnQgIT09ICdsb2FkJykgdGhyb3cgRXJyb3IoJ9Ce0YjQuNCx0LrQsCDRgdC+0LXQtNC40L3QtdC90LjRjyDRgSDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgY29uc3Qgc3RhdHVzID0gcmVzcG9uc2UucmVzcG9uc2Uuc3RhdHVzO1xuICAgIGlmIChzdGF0dXMgPCAyMDAgfHwgc3RhdHVzID49IDMwMCkgeyBjb25zdCBlcnJvciA9IEVycm9yKCfQnNC+0LnQodC60LvQsNC0OiBIVFRQICcgKyBzdGF0dXMpOyBlcnJvci5zdGF0dXMgPSBzdGF0dXM7IHRocm93IGVycm9yOyB9XG4gICAgbGV0IGRhdGE7XG4gICAgdHJ5IHsgZGF0YSA9IEpTT04ucGFyc2UocmVzcG9uc2UucmVzcG9uc2UucmVzcG9uc2VUZXh0KTsgfSBjYXRjaCB7IHRocm93IEVycm9yKCfQndC10LrQvtGA0YDQtdC60YLQvdGL0Lkg0L7RgtCy0LXRgiDQnNC+0LnQodC60LvQsNC0Jyk7IH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YT8ucm93cykpIHRocm93IEVycm9yKCfQndC10L/QvtC70L3Ri9C5INC+0YLQstC10YIg0YHQv9C40YHQutCwINC30LDQutCw0LfQvtCyJyk7XG4gICAgcmV0dXJuIGRhdGE7XG59XG5hc3luYyBmdW5jdGlvbiBkZWxpdmVyT3JkZXJSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIsIHJldmlzaW9uKSB7XG4gICAgaWYgKCFjaHJvbWUudGFicz8ucXVlcnkpIHJldHVybjtcbiAgICBjb25zdCB0YWJzID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoe30pO1xuICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gdGFicy5maWx0ZXIodGFiID0+IG9yZGVyU3Vic2NyaWJlcnMuaGFzKHRhYi5pZCkgJiYgdHJ1c3RlZENvbnRlbnRTZW5kZXIoeyBpZDogY2hyb21lLnJ1bnRpbWUuaWQsIHRhYiwgZnJhbWVJZDogMCwgdXJsOiB0YWIudXJsIH0pKTtcbiAgICBjYW5kaWRhdGVzLnNvcnQoKGEsIGIpID0+IE51bWJlcighIWIuYWN0aXZlKSAtIE51bWJlcighIWEuYWN0aXZlKSk7XG4gICAgZm9yIChjb25zdCB0YWIgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGFjayA9IGF3YWl0IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgeyB0eXBlOiAnbWVtY2hhdDpvcmRlcnMtcmVzdWx0JywgcmVzdWx0LCByZXZpc2lvbiwgc2V0dGluZ3M6IGNvbmZpZy5zZXR0aW5ncyB9LCB7IGZyYW1lSWQ6IDAgfSk7XG4gICAgICAgICAgICBpZiAoYWNrPy5vaykgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogVHJ5IGFub3RoZXIgbGl2ZSBjb250ZW50IHdvcmxkLCBub3QgZXZlcnkgdGFiLiAqLyB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgbmF0aXZlIG9mIG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucy52YWx1ZXMoKSkge1xuICAgICAgICBpZiAobmF0aXZlLm9yZGVyVG9rZW4gIT09IGNvbmZpZy50b2tlbiB8fCBuYXRpdmUub3JkZXJSZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSBjb250aW51ZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICghYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChuYXRpdmUuc2VuZGVyLCAnQmVhcmVyICcgKyBjb25maWcudG9rZW4pKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IGFjayA9IGF3YWl0IG5hdGl2ZVJ1bnRpbWVSZXF1ZXN0KG5hdGl2ZSwgeyB0eXBlOiAnbWVtY2hhdDpvcmRlcnMtcmVzdWx0JywgcmVzdWx0LCByZXZpc2lvbiwgc2V0dGluZ3M6IGNvbmZpZy5zZXR0aW5ncyB9KTtcbiAgICAgICAgICAgIGlmIChhY2s/Lm9rKSByZXR1cm47XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBBIGNsb3NlZCBuYXRpdmUgZG9jdW1lbnQgaXMgbm90IGFub3RoZXIgc3Vic2NyaWJlci4gKi8gfVxuICAgIH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHBvbGxPcmRlcnMoKSB7XG4gICAgYXdhaXQgb3JkZXJSZWFkeTtcbiAgICBhd2FpdCBvcmRlckNvbmZpZ0NoYWluO1xuICAgIGlmIChvcmRlckZsaWdodCkgcmV0dXJuIG9yZGVyRmxpZ2h0O1xuICAgIGNvbnN0IGNvbmZpZyA9IG9yZGVyQ29uZmlnO1xuICAgIGlmICghY29uZmlnPy5zZXR0aW5ncy5lbmFibGVkIHx8ICFjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoIHx8ICFjb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMubGVuZ3RoKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDQstGL0LrQu9GO0YfQtdC9INC40LvQuCDQvdC1INC90LDRgdGC0YDQvtC10L0nIH07XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgY29uc3QgcmV2aXNpb24gPSBvcmRlclJldmlzaW9uO1xuICAgICAgICBvcmRlckNvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xuICAgIG9yZGVyRmxpZ2h0ID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgZm91bmQgPSBuZXcgTWFwKCksIGZhaWxlZCA9IFtdO1xuICAgICAgICBsZXQgYXV0aEZhaWxlZCA9IGZhbHNlO1xuICAgICAgICBmb3IgKGNvbnN0IGhyZWYgb2YgY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzKSB7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IGNvbmZpZy5vcmdhbml6YXRpb25zLmZpbmQoaXRlbSA9PiBpdGVtLmhyZWYgPT09IGhyZWYpPy5uYW1lIHx8ICfQntGA0LPQsNC90LjQt9Cw0YbQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwJztcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgcm93cyA9IG5ldyBNYXAoKTtcbiAgICAgICAgICAgICAgICBsZXQgb2Zmc2V0ID0gMDtcbiAgICAgICAgICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbHRlciA9IFsnb3JnYW5pemF0aW9uPScgKyBocmVmLCAuLi5jb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMubWFwKHN0YXRlID0+ICdzdGF0ZT0nICsgc3RhdGUpXS5qb2luKCc7Jyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBvcmRlckdldCgnL2VudGl0eS9jdXN0b21lcm9yZGVyP2ZpbHRlcj0nICsgZW5jb2RlVVJJQ29tcG9uZW50KGZpbHRlcilcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJyZleHBhbmQ9c3RhdGUsb3JnYW5pemF0aW9uJm9yZGVyPW1vbWVudCxkZXNjJmxpbWl0PTEwMCZvZmZzZXQ9JyArIG9mZnNldCwgY29uZmlnLCBjb250cm9sbGVyKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSByb3dzLnNpemU7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3Qgcm93IG9mIGRhdGEucm93cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFyb3c/LmlkKSB0aHJvdyBFcnJvcign0JfQsNC60LDQtyDQsdC10Lcg0LjQtNC10L3RgtC40YTQuNC60LDRgtC+0YDQsCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93cy5zZXQocm93LmlkLCByb3cpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIG9mZnNldCArPSBkYXRhLnJvd3MubGVuZ3RoO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3JlID0gISFkYXRhLm1ldGE/Lm5leHRIcmVmIHx8IChOdW1iZXIuaXNGaW5pdGUoZGF0YS5tZXRhPy5zaXplKSA/IG9mZnNldCA8IGRhdGEubWV0YS5zaXplIDogZGF0YS5yb3dzLmxlbmd0aCA+PSAxMDApO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW1vcmUpIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWRhdGEucm93cy5sZW5ndGggfHwgcm93cy5zaXplID09PSBwcmV2aW91cykgdGhyb3cgRXJyb3IoJ9Cf0LDQs9C40L3QsNGG0LjRjyDQt9Cw0LrQsNC30L7QsiDQvdC1INC/0YDQvtC00LLQuNCz0LDQtdGC0YHRjycpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiByb3dzLnZhbHVlcygpKSBpZiAoY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmluY2x1ZGVzKHJvdy5zdGF0ZT8ubWV0YT8uaHJlZikpIHtcbiAgICAgICAgICAgICAgICAgICAgZm91bmQuc2V0KHJvdy5pZCwgeyBpZDogcm93LmlkLCBuYW1lOiByb3cubmFtZSB8fCByb3cuaWQsIHN0YXRlTmFtZTogcm93LnN0YXRlPy5uYW1lIHx8ICfQndC+0LLRi9C5Jywgb3JnYW5pemF0aW9uTmFtZTogbGFiZWwsIG9yZ2FuaXphdGlvbkhyZWY6IGhyZWYgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvTog0L3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90YsnIH07XG4gICAgICAgICAgICAgICAgZmFpbGVkLnB1c2gobGFiZWwgKyAnIOKAlCAnICsgKGVycm9yLm1lc3NhZ2UgfHwgJ9Ce0YjQuNCx0LrQsCDQt9Cw0L/RgNC+0YHQsCcpKTtcbiAgICAgICAgICAgICAgICBpZiAoWzQwMSwgNDAzXS5pbmNsdWRlcyhlcnJvci5zdGF0dXMpKSB7IGF1dGhGYWlsZWQgPSB0cnVlOyBicmVhazsgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9JyB9O1xuICAgICAgICBpZiAoYXV0aEZhaWxlZCkge1xuICAgICAgICAgICAgYXdhaXQgb3JkZXJNdXRhdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgICAgICAgICAgICBjb25maWcuc2V0dGluZ3MuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWcsIHJldmlzaW9uOiArK29yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScgfTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0geyBpZDogU3RyaW5nKERhdGUubm93KCkpICsgJy0nICsgb3JkZXJSZXZpc2lvbiwgb3JkZXJzOiBbLi4uZm91bmQudmFsdWVzKCldLCBmYWlsZWQsIHBhcnRpYWw6IGZhaWxlZC5sZW5ndGggPiAwLFxuICAgICAgICAgICAgYmVhcmVyOiBhdXRoRmFpbGVkID8gJ2Vycm9yJyA6IGZhaWxlZC5sZW5ndGggPT09IGNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggPyAndW5rbm93bicgOiAnb2snLCBhdDogRGF0ZS5ub3coKSB9O1xuICAgICAgICByZXN1bHQub3JkZXJzLmZvckVhY2gob3JkZXIgPT4geyBvcmRlci5wYXJ0aWFsID0gcmVzdWx0LnBhcnRpYWw7IH0pO1xuICAgICAgICBvcmRlckxhc3RSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgIHJlc3VsdC5hbGVydFdhcm5pbmdzID0gYXdhaXQgb3JkZXJQcmVzZW50UmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyKTtcbiAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L06INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLJyB9O1xuICAgICAgICBhd2FpdCBkZWxpdmVyT3JkZXJSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIsIHJldmlzaW9uKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlc3VsdCB9O1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyRmxpZ2h0ID0gbnVsbDsgaWYgKG9yZGVyQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgb3JkZXJDb250cm9sbGVyID0gbnVsbDsgfSk7XG4gICAgcmV0dXJuIG9yZGVyRmxpZ2h0O1xufVxuaWYgKGNocm9tZS5hbGFybXMpIGNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihhbGFybSA9PiB7XG4gICAgaWYgKGFsYXJtLm5hbWUgPT09IE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkpIHJldHVybiBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBpZiAoYWxhcm0ubmFtZSA9PT0gJ21lbWNoYXQtb3JkZXJzJykgcmV0dXJuIHBvbGxPcmRlcnMoKS5jYXRjaCgoKSA9PiB7fSk7XG59KTtcbiIsIi8vIE5hdGl2ZSBydW50aW1lIGlkZW50aXRpZXMgYXJlIHJlYWwgQ2hyb21lIE1lc3NhZ2VTZW5kZXJzLCBuZXZlciBzeW50aGV0aWMgdGFicy5cbi8vIEEgb25lLXVzZSBjYXBhYmlsaXR5LCBkZWxpdmVyZWQgb25seSB0byBhIHZlcmlmaWVkIFNJREVfUEFORUwgZG9jdW1lbnQsIGJpbmRzXG4vLyBpdHMgY2hpbGQgcG9ydCB0byBvbmUgd2luZG93L29yaWdpbiBmb3IgaXRzIGVudGlyZSBsaWZldGltZS5cbmNvbnN0IG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzID0gbmV3IFdlYWtNYXAoKTtcbmNvbnN0IG5hdGl2ZVJ1bnRpbWVTZXNzaW9ucyA9IG5ldyBNYXAoKTtcbmNvbnN0IG5hdGl2ZVJ1bnRpbWVUaWNrZXRzID0gbmV3IE1hcCgpO1xubGV0IG5hdGl2ZURyYWZ0Q2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmNvbnN0IE5BVElWRV9MQVNUX09SSUdJTl9LRVkgPSAnbWVtY2hhdE5hdGl2ZUxhc3RPcmlnaW5fdjEnO1xubGV0IG5hdGl2ZVNlbGVjdGlvbkNoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5mdW5jdGlvbiBuYXRpdmVTdXBwb3J0ZWRPcmlnaW4ob3JpZ2luKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChvcmlnaW4pO1xuICAgICAgICByZXR1cm4gdXJsLm9yaWdpbiA9PT0gb3JpZ2luICYmIHVybC5wcm90b2NvbCA9PT0gJ2h0dHBzOicgJiYgIXVybC5wb3J0ICYmICF1cmwudXNlcm5hbWUgJiYgIXVybC5wYXNzd29yZFxuICAgICAgICAgICAgJiYgTUVNQ0hBVF9FWFRFTlNJT05fQ09ORklHLnBhZ2VNYXRjaGVzLnNvbWUocGF0dGVybiA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgaG9zdCA9IG5ldyBVUkwocGF0dGVybi5yZXBsYWNlKCcqLicsICd3aWxkY2FyZC4nKSkuaG9zdG5hbWUucmVwbGFjZSgnd2lsZGNhcmQuJywgJyouJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGhvc3Quc3RhcnRzV2l0aCgnKi4nKSA/IHVybC5ob3N0bmFtZSA9PT0gaG9zdC5zbGljZSgyKSB8fCB1cmwuaG9zdG5hbWUuZW5kc1dpdGgoJy4nICsgaG9zdC5zbGljZSgyKSkgOiB1cmwuaG9zdG5hbWUgPT09IGhvc3Q7XG4gICAgICAgICAgICB9KTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5mdW5jdGlvbiBuYXRpdmVEb2N1bWVudFVybChyYXcsIHF1ZXJ5LCBoYXNoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpO1xuICAgICAgICByZXR1cm4gdXJsLm9yaWdpbiA9PT0gbmV3IFVSTChjaHJvbWUucnVudGltZS5nZXRVUkwoJ29mZnNjcmVlbi5odG1sJykpLm9yaWdpbiAmJiB1cmwucGF0aG5hbWUgPT09ICcvb2Zmc2NyZWVuLmh0bWwnXG4gICAgICAgICAgICAmJiB1cmwuaGFzaCA9PT0gJyMnICsgaGFzaCAmJiBuZXcgUmVnRXhwKCdeXFxcXD8nICsgcXVlcnkgKyAnPVthLWYwLTktXXszNn0kJykudGVzdCh1cmwuc2VhcmNoKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5jb25zdCBuYXRpdmVQYW5lbFdpbmRvd3MgPSBuZXcgTWFwKCk7XG5hc3luYyBmdW5jdGlvbiBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgd2luZG93SWQpIHtcbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIod2luZG93SWQpIHx8IHdpbmRvd0lkIDwgMCB8fCBzZW5kZXI/LmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCBzZW5kZXIudGFiIHx8IHNlbmRlci5mcmFtZUlkICE9PSB1bmRlZmluZWQgJiYgc2VuZGVyLmZyYW1lSWQgIT09IDBcbiAgICAgICAgfHwgIW5hdGl2ZURvY3VtZW50VXJsKHNlbmRlci51cmwsICdwYW5lbCcsICdzaWRlYmFyJykpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBjb250ZXh0cyA9IGF3YWl0IGNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKHsgY29udGV4dFR5cGVzOiBbJ1NJREVfUEFORUwnXSwgZG9jdW1lbnRVcmxzOiBbc2VuZGVyLnVybF0gfSk7XG4gICAgY29uc3QgY29udGV4dCA9IGNvbnRleHRzLmZpbmQoY29udGV4dCA9PiBjb250ZXh0LmNvbnRleHRUeXBlID09PSAnU0lERV9QQU5FTCcgJiYgY29udGV4dC5kb2N1bWVudFVybCA9PT0gc2VuZGVyLnVybFxuICAgICAgICAmJiAoIXNlbmRlci5kb2N1bWVudElkIHx8IGNvbnRleHQuZG9jdW1lbnRJZCA9PT0gc2VuZGVyLmRvY3VtZW50SWQpKTtcbiAgICBpZiAoIWNvbnRleHQpIHsgbmF0aXZlUGFuZWxXaW5kb3dzLmRlbGV0ZShzZW5kZXIudXJsKTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgLy8gQ2hyb21lIHJlcG9ydHMgd2luZG93SWQ9LTEgZm9yIGEgZ2xvYmFsIFNJREVfUEFORUwgKG9ic2VydmVkIGluIENocm9taXVtKS5cbiAgICAvLyBPbmx5IG91ciB2ZXJpZmllZCBuYXRpdmUgVUkgY2FuIGVzdGFibGlzaCB0aGlzIGZpcnN0IGJpbmRpbmc7IGl0IG9idGFpbnNcbiAgICAvLyBpdHMgd2luZG93IHZpYSB3aW5kb3dzLmdldEN1cnJlbnQoKS4gTmV2ZXIgbGV0IGEgZG9jdW1lbnQgcmV0YXJnZXQgbGF0ZXIuXG4gICAgaWYgKGNvbnRleHQud2luZG93SWQgIT09IC0xICYmIGNvbnRleHQud2luZG93SWQgIT09IHdpbmRvd0lkKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCFuYXRpdmVQYW5lbFdpbmRvd3MuaGFzKHNlbmRlci51cmwpKSBuYXRpdmVQYW5lbFdpbmRvd3Muc2V0KHNlbmRlci51cmwsIHdpbmRvd0lkKTtcbiAgICByZXR1cm4gbmF0aXZlUGFuZWxXaW5kb3dzLmdldChzZW5kZXIudXJsKSA9PT0gd2luZG93SWQ7XG59XG5hc3luYyBmdW5jdGlvbiBuYXRpdmVMYXN0T3JpZ2luKCkge1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgYXdhaXQgbmF0aXZlU2VsZWN0aW9uQ2hhaW47XG4gICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KE5BVElWRV9MQVNUX09SSUdJTl9LRVkpKVtOQVRJVkVfTEFTVF9PUklHSU5fS0VZXTtcbiAgICByZXR1cm4gbmF0aXZlU3VwcG9ydGVkT3JpZ2luKHNhdmVkKSA/IHNhdmVkIDogJ2h0dHBzOi8vb25saW5lLm1veXNrbGFkLnJ1Jztcbn1cbmZ1bmN0aW9uIG5hdGl2ZVJlbWVtYmVyT3JpZ2luKG9yaWdpbikge1xuICAgIGNvbnN0IHdvcmsgPSBuYXRpdmVTZWxlY3Rpb25DaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgaWYgKCFuYXRpdmVTdXBwb3J0ZWRPcmlnaW4ob3JpZ2luKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgb3JpZ2luJyk7XG4gICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgICAgIGlmICgoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KE5BVElWRV9MQVNUX09SSUdJTl9LRVkpKVtOQVRJVkVfTEFTVF9PUklHSU5fS0VZXSA9PT0gb3JpZ2luKSByZXR1cm47XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtOQVRJVkVfTEFTVF9PUklHSU5fS0VZXTogb3JpZ2luIH0pO1xuICAgICAgICBpZiAoKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChOQVRJVkVfTEFTVF9PUklHSU5fS0VZKSlbTkFUSVZFX0xBU1RfT1JJR0lOX0tFWV0gIT09IG9yaWdpbikgdGhyb3cgRXJyb3IoJ1NlbGVjdGlvbiBub3QgZHVyYWJsZScpO1xuICAgIH0pO1xuICAgIG5hdGl2ZVNlbGVjdGlvbkNoYWluID0gd29yay5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHdvcms7XG59XG5hc3luYyBmdW5jdGlvbiBuYXRpdmVSdW50aW1lVGlja2V0KHNlbmRlciwgd2luZG93SWQsIG9yaWdpbikge1xuICAgIGlmICghbmF0aXZlU3VwcG9ydGVkT3JpZ2luKG9yaWdpbikgfHwgIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoc2VuZGVyLCB3aW5kb3dJZCkpIHRocm93IEVycm9yKCdJbnZhbGlkIG5hdGl2ZSBpZGVudGl0eScpO1xuICAgIGZvciAoY29uc3QgW3RpY2tldCwgYmluZGluZ10gb2YgbmF0aXZlUnVudGltZVRpY2tldHMpIGlmIChiaW5kaW5nLmV4cGlyZXMgPCBEYXRlLm5vdygpIHx8IGJpbmRpbmcucGFyZW50LnVybCA9PT0gc2VuZGVyLnVybCAmJiBiaW5kaW5nLm9yaWdpbiA9PT0gb3JpZ2luKSBuYXRpdmVSdW50aW1lVGlja2V0cy5kZWxldGUodGlja2V0KTtcbiAgICBjb25zdCB0aWNrZXQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICAgIG5hdGl2ZVJ1bnRpbWVUaWNrZXRzLnNldCh0aWNrZXQsIHsgcGFyZW50OiBzZW5kZXIsIHdpbmRvd0lkLCBvcmlnaW4sIGV4cGlyZXM6IERhdGUubm93KCkgKyAxNTAwMCB9KTtcbiAgICByZXR1cm4gdGlja2V0O1xufVxuZnVuY3Rpb24gdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSB7IHJldHVybiBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5oYXMoc2VuZGVyKTsgfVxuZnVuY3Rpb24gcnVudGltZVNlbmRlck9yaWdpbihzZW5kZXIpIHtcbiAgICBjb25zdCBuYXRpdmUgPSBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5nZXQoc2VuZGVyKTtcbiAgICBpZiAobmF0aXZlKSByZXR1cm4gbmF0aXZlLm9yaWdpbjtcbiAgICBpZiAodHlwZW9mIHRydXN0ZWRDb250ZW50U2VuZGVyID09PSAnZnVuY3Rpb24nICYmIHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHJldHVybiBuZXcgVVJMKHNlbmRlci51cmwpLm9yaWdpbjtcbiAgICB0aHJvdyBFcnJvcignVW5ib3VuZCBydW50aW1lIGlkZW50aXR5Jyk7XG59XG4vLyBUcmFjayBhY3R1YWwgZm9jdXNlZC1zaXRlIHVzZSwgbm90IHBlcmlvZGljIHNuYXBzaG90cyBmcm9tIGEgYmFja2dyb3VuZCB3aW5kb3cuXG5sZXQgbmF0aXZlRm9jdXNHZW5lcmF0aW9uID0gMDtcbmFzeW5jIGZ1bmN0aW9uIG5hdGl2ZVRyYWNrQWN0aXZlV2luZG93KHdpbmRvd0lkKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9ICsrbmF0aXZlRm9jdXNHZW5lcmF0aW9uO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHdpbmRvdyA9IGF3YWl0IGNocm9tZS53aW5kb3dzLmdldCh3aW5kb3dJZCk7XG4gICAgICAgIGlmICghd2luZG93LmZvY3VzZWQpIHJldHVybjtcbiAgICAgICAgY29uc3QgW3RhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgd2luZG93SWQgfSk7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uID09PSBuYXRpdmVGb2N1c0dlbmVyYXRpb24gJiYgc3VwcG9ydGVkQWN0aW9uVGFiKHRhYikpIGF3YWl0IG5hdGl2ZVJlbWVtYmVyT3JpZ2luKG5ldyBVUkwodGFiLnVybCkub3JpZ2luKTtcbiAgICB9IGNhdGNoIHsgLyogQ2xvc2VkL3VuYXZhaWxhYmxlIHdpbmRvdyBtdXN0IG5vdCBjaGFuZ2UgdGhlIHNhdmVkIHNlbGVjdGlvbi4gKi8gfVxufVxuY2hyb21lLnRhYnM/Lm9uQWN0aXZhdGVkPy5hZGRMaXN0ZW5lcihpbmZvID0+IHsgdm9pZCBuYXRpdmVUcmFja0FjdGl2ZVdpbmRvdyhpbmZvLndpbmRvd0lkKTsgfSk7XG5jaHJvbWUudGFicz8ub25VcGRhdGVkPy5hZGRMaXN0ZW5lcigoaWQsIGNoYW5nZSwgdGFiKSA9PiB7IGlmICh0YWIuYWN0aXZlICYmIGNoYW5nZS51cmwpIHZvaWQgbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3codGFiLndpbmRvd0lkKTsgfSk7XG5jaHJvbWUud2luZG93cz8ub25Gb2N1c0NoYW5nZWQ/LmFkZExpc3RlbmVyKHdpbmRvd0lkID0+IHsgaWYgKHdpbmRvd0lkID49IDApIHZvaWQgbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3cod2luZG93SWQpOyBlbHNlIG5hdGl2ZUZvY3VzR2VuZXJhdGlvbisrOyB9KTtcbmlmIChjaHJvbWUud2luZG93cz8uZ2V0TGFzdEZvY3VzZWQpIGNocm9tZS53aW5kb3dzLmdldExhc3RGb2N1c2VkKCkudGhlbih3aW5kb3cgPT4gbmF0aXZlVHJhY2tBY3RpdmVXaW5kb3cod2luZG93LmlkKSwgKCkgPT4ge30pO1xuZnVuY3Rpb24gbmF0aXZlRHJhZnRNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IHNlc3Npb24gPSBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5nZXQoc2VuZGVyKTtcbiAgICBpZiAoIXNlc3Npb24gfHwgc2Vzc2lvbi5jbG9zZWQpIHJldHVybiBQcm9taXNlLnJlamVjdChFcnJvcignVW5ib3VuZCBydW50aW1lJykpO1xuICAgIGNvbnN0IGtleSA9ICdtZW1jaGF0TmF0aXZlRHJhZnRfdjE6JyArIHNlc3Npb24ud2luZG93SWQgKyAnOicgKyBzZXNzaW9uLm9yaWdpbjtcbiAgICBjb25zdCB3b3JrID0gbmF0aXZlRHJhZnRDaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6bmF0aXZlLWRyYWZ0LXdyaXRlJykge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBtZXNzYWdlLnZhbHVlICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLnZhbHVlLmxlbmd0aCA+IDEwMjQgKiAxMDI0KSB0aHJvdyBFcnJvcignSW52YWxpZCBkcmFmdCcpO1xuICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBba2V5XTogbWVzc2FnZS52YWx1ZSB9KTtcbiAgICAgICAgICAgIGlmICgoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoa2V5KSlba2V5XSAhPT0gbWVzc2FnZS52YWx1ZSkgdGhyb3cgRXJyb3IoJ0RyYWZ0IG5vdCBkdXJhYmxlJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdmFsdWUgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoa2V5KSlba2V5XTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUgOiAnJyB9O1xuICAgIH0pO1xuICAgIG5hdGl2ZURyYWZ0Q2hhaW4gPSB3b3JrLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gd29yaztcbn1cbmZ1bmN0aW9uIG5hdGl2ZVJ1bnRpbWVTZXNzaW9uS2V5KHBhcmVudCwgb3JpZ2luKSB7IHJldHVybiBwYXJlbnQudXJsICsgJzonICsgb3JpZ2luOyB9XG5mdW5jdGlvbiBuYXRpdmVSdW50aW1lUmVxdWVzdChzZXNzaW9uLCBtZXNzYWdlKSB7XG4gICAgaWYgKHNlc3Npb24uY2xvc2VkKSByZXR1cm4gUHJvbWlzZS5yZWplY3QoRXJyb3IoJ1J1bnRpbWUgZGlzY29ubmVjdGVkJykpO1xuICAgIGNvbnN0IGlkID0gKytzZXNzaW9uLnNlcXVlbmNlO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IHNlc3Npb24ucGVuZGluZy5kZWxldGUoaWQpOyByZWplY3QoRXJyb3IoJ1J1bnRpbWUgdGltZWQgb3V0JykpOyB9LCA1MDAwKTtcbiAgICAgICAgc2Vzc2lvbi5wZW5kaW5nLnNldChpZCwgeyByZXNvbHZlLCByZWplY3QsIHRpbWVyIH0pO1xuICAgICAgICB0cnkgeyBzZXNzaW9uLnBvcnQucG9zdE1lc3NhZ2UoeyBjYWxsOiBpZCwgbWVzc2FnZSB9KTsgfVxuICAgICAgICBjYXRjaCB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNlc3Npb24ucGVuZGluZy5kZWxldGUoaWQpOyByZWplY3QoRXJyb3IoJ1J1bnRpbWUgZGlzY29ubmVjdGVkJykpOyB9XG4gICAgfSk7XG59XG5mdW5jdGlvbiBuYXRpdmVSdW50aW1lTm90aWZ5KHNlbmRlciwgbWVzc2FnZSkge1xuICAgIGNvbnN0IHNlc3Npb24gPSBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5nZXQoc2VuZGVyKTtcbiAgICBpZiAoIXNlc3Npb24gfHwgc2Vzc2lvbi5jbG9zZWQpIHRocm93IEVycm9yKCdSdW50aW1lIGRpc2Nvbm5lY3RlZCcpO1xuICAgIHNlc3Npb24ucG9ydC5wb3N0TWVzc2FnZSh7IG1lc3NhZ2UgfSk7XG59XG5jaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIocG9ydCA9PiB7XG4gICAgaWYgKHBvcnQubmFtZSAhPT0gJ21lbWNoYXQtbmF0aXZlLXJ1bnRpbWUnKSByZXR1cm47XG4gICAgY29uc3Qgc2VuZGVyID0gcG9ydC5zZW5kZXI7XG4gICAgaWYgKHNlbmRlcj8uaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWIgfHwgc2VuZGVyLmZyYW1lSWQgIT09IHVuZGVmaW5lZCAmJiBzZW5kZXIuZnJhbWVJZCAhPT0gMFxuICAgICAgICB8fCAhbmF0aXZlRG9jdW1lbnRVcmwoc2VuZGVyLnVybCwgJ3J1bnRpbWUnLCAncnVudGltZScpKSB7IHBvcnQuZGlzY29ubmVjdCgpOyByZXR1cm47IH1cbiAgICBsZXQgc2Vzc2lvbiwgYmluZGluZyA9IGZhbHNlLCBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcbiAgICBjb25zdCBjbG9zZSA9ICgpID0+IHtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2xvc2VkKSByZXR1cm47XG4gICAgICAgIHNlc3Npb24uY2xvc2VkID0gdHJ1ZTsgbmF0aXZlUnVudGltZUlkZW50aXRpZXMuZGVsZXRlKHNlbmRlcik7XG4gICAgICAgIGlmIChuYXRpdmVSdW50aW1lU2Vzc2lvbnMuZ2V0KHNlc3Npb24ua2V5KSA9PT0gc2Vzc2lvbikgbmF0aXZlUnVudGltZVNlc3Npb25zLmRlbGV0ZShzZXNzaW9uLmtleSk7XG4gICAgICAgIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZGVsZXRlKCduYXRpdmU6JyArIHNlbmRlci51cmwpO1xuICAgICAgICBmb3IgKGNvbnN0IHBlbmRpbmcgb2Ygc2Vzc2lvbi5wZW5kaW5nLnZhbHVlcygpKSB7IGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVyKTsgcGVuZGluZy5yZWplY3QoRXJyb3IoJ1J1bnRpbWUgZGlzY29ubmVjdGVkJykpOyB9XG4gICAgICAgIHNlc3Npb24ucGVuZGluZy5jbGVhcigpO1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHJlcXVlc3RdIG9mIHBlbmRpbmdSZXF1ZXN0cykgaWYgKGtleS5zdGFydHNXaXRoKCduYXRpdmU6JyArIHNlbmRlci51cmwgKyAnOicpKSB7IHJlcXVlc3QuZXZlbnQgPSAnYWJvcnQnOyByZXF1ZXN0LmNvbnRyb2xsZXIuYWJvcnQoKTsgfVxuICAgIH07XG4gICAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoY2xvc2UpO1xuICAgIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKGFzeW5jIHBhY2tldCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoIXNlc3Npb24pIHtcbiAgICAgICAgICAgICAgICBpZiAoYmluZGluZykgdGhyb3cgRXJyb3IoJ0FscmVhZHkgYmluZGluZycpO1xuICAgICAgICAgICAgICAgIGJpbmRpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhcGFiaWxpdHkgPSBuYXRpdmVSdW50aW1lVGlja2V0cy5nZXQocGFja2V0Py50aWNrZXQpO1xuICAgICAgICAgICAgICAgIG5hdGl2ZVJ1bnRpbWVUaWNrZXRzLmRlbGV0ZShwYWNrZXQ/LnRpY2tldCk7XG4gICAgICAgICAgICAgICAgaWYgKCFjYXBhYmlsaXR5IHx8IGNhcGFiaWxpdHkuZXhwaXJlcyA8IERhdGUubm93KCkgfHwgIWF3YWl0IG5hdGl2ZVBhbmVsSWRlbnRpdHkoY2FwYWJpbGl0eS5wYXJlbnQsIGNhcGFiaWxpdHkud2luZG93SWQpIHx8IGRpc2Nvbm5lY3RlZCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbmF0aXZlIGNhcGFiaWxpdHknKTtcbiAgICAgICAgICAgICAgICBjb25zdCBrZXkgPSBuYXRpdmVSdW50aW1lU2Vzc2lvbktleShjYXBhYmlsaXR5LnBhcmVudCwgY2FwYWJpbGl0eS5vcmlnaW4pO1xuICAgICAgICAgICAgICAgIGlmIChuYXRpdmVSdW50aW1lU2Vzc2lvbnMuaGFzKGtleSkpIHRocm93IEVycm9yKCdSdW50aW1lIGFscmVhZHkgYm91bmQnKTtcbiAgICAgICAgICAgICAgICBzZXNzaW9uID0geyAuLi5jYXBhYmlsaXR5LCBrZXksIHNlbmRlciwgcG9ydCwgcGVuZGluZzogbmV3IE1hcCgpLCBzZXF1ZW5jZTogMCwgY2xvc2VkOiBmYWxzZSB9O1xuICAgICAgICAgICAgICAgIG5hdGl2ZVJ1bnRpbWVJZGVudGl0aWVzLnNldChzZW5kZXIsIHNlc3Npb24pOyBuYXRpdmVSdW50aW1lU2Vzc2lvbnMuc2V0KGtleSwgc2Vzc2lvbik7XG4gICAgICAgICAgICAgICAgcG9ydC5wb3N0TWVzc2FnZSh7IHJlYWR5OiB0cnVlIH0pOyByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIocGFja2V0Py5hbnN3ZXIpKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcGVuZGluZyA9IHNlc3Npb24ucGVuZGluZy5nZXQocGFja2V0LmFuc3dlcik7XG4gICAgICAgICAgICAgICAgaWYgKHBlbmRpbmcpIHsgc2Vzc2lvbi5wZW5kaW5nLmRlbGV0ZShwYWNrZXQuYW5zd2VyKTsgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZXIpOyBwZW5kaW5nLnJlc29sdmUocGFja2V0LnJlcGx5KTsgfVxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghTnVtYmVyLmlzU2FmZUludGVnZXIocGFja2V0Py5pZCkgfHwgcGFja2V0LmlkIDwgMSB8fCAhcGFja2V0Lm1lc3NhZ2UgfHwgc2Vzc2lvbi5jbG9zZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIG5hdGl2ZSBwYWNrZXQnKTtcbiAgICAgICAgICAgIC8vIENoZWNrIHRoZSBwYXJlbnQgaXMgc3RpbGwgYSBuYXRpdmUgZG9jdW1lbnQgaW4gdGhlIGJvdW5kIHdpbmRvdy5cbiAgICAgICAgICAgIGlmICghYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShzZXNzaW9uLnBhcmVudCwgc2Vzc2lvbi53aW5kb3dJZCkgfHwgc2Vzc2lvbi5jbG9zZWQpIHRocm93IEVycm9yKCdOYXRpdmUgcGFyZW50IGNsb3NlZCcpO1xuICAgICAgICAgICAgbGV0IGFuc3dlcmVkID0gZmFsc2U7XG4gICAgICAgICAgICBjb25zdCBoYW5kbGVkID0gZXh0ZW5zaW9uSGFuZGxlTWVzc2FnZShwYWNrZXQubWVzc2FnZSwgc2VuZGVyLCByZXBseSA9PiB7XG4gICAgICAgICAgICAgICAgYW5zd2VyZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGlmICghc2Vzc2lvbi5jbG9zZWQpIHBvcnQucG9zdE1lc3NhZ2UoeyBpZDogcGFja2V0LmlkLCByZXBseSB9KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKCFoYW5kbGVkICYmICFhbnN3ZXJlZCkgcG9ydC5wb3N0TWVzc2FnZSh7IGlkOiBwYWNrZXQuaWQsIHJlcGx5OiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPJyB9IH0pO1xuICAgICAgICB9IGNhdGNoIHsgY2xvc2UoKTsgdHJ5IHsgcG9ydC5kaXNjb25uZWN0KCk7IH0gY2F0Y2ggeyAvKiBBbHJlYWR5IGdvbmUuICovIH0gfVxuICAgIH0pO1xufSk7XG4iLCIvLyBQcml2YXRlIG5hdGl2ZS12aWV3IGNoYW5uZWwuIE5ldmVyIGJyb2FkY2FzdCB2aWV3IGRhdGE6IHJlcGxpZXMgZ28gb25seSB0byB0aGVcbi8vIGV4YWN0IHJlcXVlc3RpbmcgbmF0aXZlIHBhbmVsLiBTaXRlL2FjY291bnQgc3RhdGUgc3RheXMgaW4gaXRzIGNvbnRlbnQgd29ybGQuXG5jb25zdCBTSURFQkFSX0ZFQVRVUkVTID0gT2JqZWN0LmZyZWV6ZShbJ2NoZWNrSGF0aWtvJywgJ2NoZWNrSGF0aWtvQm9udXNlcycsICd0b2RheScsICd0b21vcnJvdycsXG4gICAgJ2NhbGN1bGF0b3InLCAnY2FsY3VsYXRvcl9yZXZlcnNlJywgJ2NhbGN1bGF0b3JfZGlzY291bnQnLCAnY2FsY3VsYXRvcl9zaW1wbGUnLCAnaGFja2VyJywgJ3NldHRpbmdzJ10pO1xuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpIHtcbiAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KTtcbiAgICBpZiAoIXN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ3Vuc3VwcG9ydGVkJyB9O1xuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcgJiYgdGFiLmlkICE9PSBtZXNzYWdlLnRhYklkKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgY29uc3QgY29tbWFuZCA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1zdGF0dXMnXG4gICAgICAgID8geyB0eXBlOiAnbWVtY2hhdDpmZWF0dXJlLXN0YXR1cycgfSA6IHsgdHlwZTogJ21lbWNoYXQ6b3Blbi1mZWF0dXJlJywgZmVhdHVyZTogbWVzc2FnZS5mZWF0dXJlIH07XG4gICAgbGV0IHJlcGx5O1xuICAgIHRyeSB7IHJlcGx5ID0gYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCBjb21tYW5kLCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTsgfVxuICAgIGlmICghcmVwbHk/Lm9rKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogWydzdG9yYWdlJywgJ2NvbmZsaWN0J10uaW5jbHVkZXMocmVwbHk/LnJlYXNvbikgPyByZXBseS5yZWFzb24gOiAnZmFpbGVkJyB9O1xuICAgIC8vIE5ldmVyIGZvcndhcmQgYW4gYXJiaXRyYXJ5IGNvbnRlbnQgcmVwbHksIHRhYiB0aXRsZSwgVVJMIHBhdGgvcXVlcnkgb3IgcGVyc2lzdGVkIGRhdGEuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRhYklkOiB0YWIuaWQsIGhvc3Q6IG5ldyBVUkwodGFiLnVybCkuaG9zdG5hbWUgfTtcbn1cbi8vIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlIGhhcyBubyB0aW1lb3V0IG9mIGl0cyBvd246IGEgZnJvemVuIGJhY2tncm91bmQgdGFiXG4vLyAoQ2hyb21lIEZyZWV6aW5nKSBvciBhIHN0dWNrIGNvbnRlbnQgaGFuZGxlciB3b3VsZCBob2xkIHRoZSBwYW5lbCB1bnRpbCBpdHNcbi8vIG93biA4IHMgZGVhZGxpbmUgd2l0aCBhIHZhZ3VlIHRpbWVvdXQuIEFuc3dlciB0aGUgcGFuZWwgZmlyc3QgaW5zdGVhZC5cbmxldCBTSURFQkFSX1ZJRVdfREVBRExJTkVfTVMgPSA0MDAwO1xuZnVuY3Rpb24gc2lkZWJhclNlbmRUb1RhYih0YWJJZCwgbWVzc2FnZSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoeyBvazogZmFsc2UsIHJlYXNvbjogJ3RpbWVvdXQnIH0pLCBTSURFQkFSX1ZJRVdfREVBRExJTkVfTVMpO1xuICAgICAgICBsZXQgc2VudDtcbiAgICAgICAgdHJ5IHsgc2VudCA9IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCBtZXNzYWdlLCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICAgICAgY2F0Y2ggeyBjbGVhclRpbWVvdXQodGltZXIpOyByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9KTsgcmV0dXJuOyB9XG4gICAgICAgIC8vIFRoZXJlIGlzIG5vIEFib3J0Q29udHJvbGxlciBmb3Igc2VuZE1lc3NhZ2UuIFRoZSBsb3NpbmcgcHJvbWlzZSBzdGlsbFxuICAgICAgICAvLyBzZXR0bGVzIGxhdGVyLCBzbyBib3RoIGEgbGF0ZSByZXBseSBhbmQgYSBsYXRlIHJlamVjdGlvbiBhcmUgYWJzb3JiZWQuXG4gICAgICAgIFByb21pc2UucmVzb2x2ZShzZW50KS50aGVuKHJlcGx5ID0+IHJlc29sdmUocmVwbHkpLCAoKSA9PiByZXNvbHZlKHsgb2s6IGZhbHNlLCByZWFzb246ICdtaXNzaW5nJyB9KSlcbiAgICAgICAgICAgIC5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lcikpO1xuICAgIH0pO1xufVxuLy8gQSBwYW5lbCdzIHRhcmdldCBpcyBjYXB0dXJlZCBvbmNlIGFuZCB0aGVuIHJlYWQsIG5ldmVyIHJlY29tcHV0ZWQgZnJvbSB0aGVcbi8vIGxpdmUgdGFiIFVSTDoge3RhYklkLCB3aW5kb3dJZCwgb3JpZ2luLCBzdXBwb3J0ZWR9LiBUaGUgb3JpZ2luIChhbmQgd2l0aCBpdFxuLy8gdGhlIHByaXZhdGUgYnVja2V0KSB0aGVyZWZvcmUgc3RheXMgcHV0IHdoaWxlIHRoZSBib3VuZCB0YWIgbmF2aWdhdGVzLCBsb3Nlc1xuLy8gZm9jdXMgb3IgaXMgcmVzdG9yZWQuIE9ubHkgYW4gZXhwbGljaXQgKHJlKWJpbmQgKG5vIHRhYklkKSBvciBhIHRhYi93aW5kb3dcbi8vIG1pc21hdGNoIHJld3JpdGVzIGl0OyBsaXZlbmVzcyBpcyBjaGVja2VkIHNlcGFyYXRlbHkuXG5jb25zdCBzaWRlYmFyQmluZGluZ3MgPSBuZXcgTWFwKCk7XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyQmluZGluZ0ZvcihtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gc2lkZWJhckJpbmRpbmdzLmdldChzZW5kZXIudXJsKTtcbiAgICBpZiAobWVzc2FnZS50YWJJZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IFthY3RpdmVdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkIH0pO1xuICAgICAgICBpZiAoIWFjdGl2ZSkgcmV0dXJuIHsgcmVhc29uOiAnY2hhbmdlZCcgfTtcbiAgICAgICAgY29uc3Qgc3VwcG9ydGVkID0gc3VwcG9ydGVkQWN0aW9uVGFiKGFjdGl2ZSk7XG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IHN1cHBvcnRlZCA/IG5ldyBVUkwoYWN0aXZlLnVybCkub3JpZ2luIDogYXdhaXQgbmF0aXZlTGFzdE9yaWdpbigpO1xuICAgICAgICBjb25zdCBiaW5kaW5nID0geyB0YWJJZDogYWN0aXZlLmlkLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCwgb3JpZ2luLCBzdXBwb3J0ZWQgfTtcbiAgICAgICAgc2lkZWJhckJpbmRpbmdzLnNldChzZW5kZXIudXJsLCBiaW5kaW5nKTtcbiAgICAgICAgcmV0dXJuIHsgYmluZGluZyB9O1xuICAgIH1cbiAgICBpZiAoY3VycmVudCkge1xuICAgICAgICAvLyBUaGUgYmluZGluZyBpcyBpbW11dGFibGUgZm9yIGl0cyBsaWZlOyBhIHBvbGwgbmFtaW5nIGFub3RoZXIgdGFiIGlzIGFcbiAgICAgICAgLy8gc3RhbGUgb3IgZm9yZWlnbiByZXF1ZXN0LCBub3QgYSByZWJpbmQuXG4gICAgICAgIGlmIChjdXJyZW50LnRhYklkICE9PSBtZXNzYWdlLnRhYklkIHx8IGN1cnJlbnQud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQpIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgICAgIHJldHVybiB7IGJpbmRpbmc6IGN1cnJlbnQgfTtcbiAgICB9XG4gICAgLy8gVGhlIHdvcmtlciBzbGVwdCBvciByZXN0YXJ0ZWQ6IHJlYnVpbGQgdGhlIHJlY29yZCBvbmNlIGZyb20gdGhlIGN1cnJlbnRcbiAgICAvLyB0YWIgc3RhdGUgc28gdGhlIHBhbmVsIGtlZXBzIHNlcnZpbmcgYWNyb3NzIFNXIHNsZWVwL3dha2UuXG4gICAgbGV0IHRhYjtcbiAgICB0cnkgeyB0YWIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQobWVzc2FnZS50YWJJZCk7IH0gY2F0Y2ggeyByZXR1cm4geyByZWFzb246ICdjbG9zZWQnIH07IH1cbiAgICBpZiAodGFiLndpbmRvd0lkICE9PSBtZXNzYWdlLndpbmRvd0lkKSByZXR1cm4geyByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIGNvbnN0IHN1cHBvcnRlZCA9IHN1cHBvcnRlZEFjdGlvblRhYih0YWIpO1xuICAgIGNvbnN0IG9yaWdpbiA9IHN1cHBvcnRlZCA/IG5ldyBVUkwodGFiLnVybCkub3JpZ2luIDogYXdhaXQgbmF0aXZlTGFzdE9yaWdpbigpO1xuICAgIGNvbnN0IGJpbmRpbmcgPSB7IHRhYklkOiB0YWIuaWQsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4sIHN1cHBvcnRlZCB9O1xuICAgIHNpZGViYXJCaW5kaW5ncy5zZXQoc2VuZGVyLnVybCwgYmluZGluZyk7XG4gICAgcmV0dXJuIHsgYmluZGluZyB9O1xufVxuLy8gQXZhaWxhYmlsaXR5IG9ubHk6IHRoZSB0YWIgZXhpc3RzLCBiZWxvbmdzIHRvIHRoZSBwYW5lbCdzIHdpbmRvdyBhbmQgaXMgbm90XG4vLyBkaXNjYXJkZWQvdW5sb2FkZWQuIFdoZXRoZXIgdGhlIHBhZ2UgaXMgYSBzdXBwb3J0ZWQgc2l0ZSBpcyBjYXB0dXJlZCBwb2xpY3kgaW5cbi8vIHRoZSBiaW5kaW5nLCBub3QgYSBsaXZlbmVzcyB0ZXN0LlxuYXN5bmMgZnVuY3Rpb24gc2lkZWJhckJvdW5kVGFiKG1lc3NhZ2UsIGJpbmRpbmcpIHtcbiAgICBsZXQgdGFiO1xuICAgIHRyeSB7IHRhYiA9IGF3YWl0IGNocm9tZS50YWJzLmdldChiaW5kaW5nLnRhYklkKTsgfSBjYXRjaCB7IHJldHVybiB7IHJlYXNvbjogJ2Nsb3NlZCcgfTsgfVxuICAgIGlmICh0YWIud2luZG93SWQgIT09IG1lc3NhZ2Uud2luZG93SWQpIHJldHVybiB7IHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgaWYgKHRhYi5zdGF0dXMgPT09ICd1bmxvYWRlZCcgfHwgdGFiLmRpc2NhcmRlZCA9PT0gdHJ1ZSkgcmV0dXJuIHsgcmVhc29uOiAnbWlzc2luZycgfTtcbiAgICByZXR1cm4geyB0YWIgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJWaWV3RGlzcGF0Y2gobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBzaWRlYmFyQmluZGluZ0ZvcihtZXNzYWdlLCBzZW5kZXIpO1xuICAgIGlmICghcmVzb2x2ZWQuYmluZGluZykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IHJlc29sdmVkLnJlYXNvbiB8fCAnY2hhbmdlZCcgfTtcbiAgICBjb25zdCBiaW5kaW5nID0gcmVzb2x2ZWQuYmluZGluZztcbiAgICBjb25zdCBib3VuZCA9IGF3YWl0IHNpZGViYXJCb3VuZFRhYihtZXNzYWdlLCBiaW5kaW5nKTtcbiAgICBpZiAoIWJvdW5kLnRhYikgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IGJvdW5kLnJlYXNvbiB9O1xuICAgIGNvbnN0IHRhYiA9IGJvdW5kLnRhYjtcbiAgICBjb25zdCBvcmlnaW4gPSBiaW5kaW5nLm9yaWdpbjtcbiAgICAvLyBBIGNhcHR1cmVkIHN1cHBvcnRlZCBiaW5kaW5nIHdob3NlIHBhZ2UgaGFzIHNpbmNlIGxlZnQgdGhlIHN1cHBvcnRlZCBvcmlnaW5cbiAgICAvLyBsb3N0IGl0cyBjb250ZW50IHNjcmlwdC4gTmV2ZXIgc2lsZW50bHkgbW92ZSB0byB0aGUgZmFsbGJhY2sgcnVudGltZS9idWNrZXQ6XG4gICAgLy8gcmVwb3J0IHRoZSB0cmFuc2llbnQgbWlzc2luZyBzdGF0ZSBzbyB0aGUgcGFuZWwga2VlcHMgaXRzIHZpZXcgYW5kIGdvZXMgaW5lcnRcbiAgICAvLyB1bnRpbCB0aGUgdXNlciBleHBsaWNpdGx5IHJlYmluZHMuXG4gICAgaWYgKGJpbmRpbmcuc3VwcG9ydGVkICYmICghc3VwcG9ydGVkQWN0aW9uVGFiKHRhYikgfHwgbmV3IFVSTCh0YWIudXJsKS5vcmlnaW4gIT09IG9yaWdpbikpXG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnXG4gICAgICAgID8geyB0eXBlOiAnbWVtY2hhdDp2aWV3LXNuYXBzaG90JyB9XG4gICAgICAgIDogeyB0eXBlOiAnbWVtY2hhdDp2aWV3LWV2ZW50JywgZG9jdW1lbnRUb2tlbjogbWVzc2FnZS5kb2N1bWVudFRva2VuLFxuICAgICAgICAgICAga2V5OiBtZXNzYWdlLmtleSwgZXZlbnQ6IG1lc3NhZ2UuZXZlbnQsIHZhbHVlOiBtZXNzYWdlLnZhbHVlLFxuICAgICAgICAgICAgY2hlY2tlZDogbWVzc2FnZS5jaGVja2VkLCBzZWxlY3RlZDogbWVzc2FnZS5zZWxlY3RlZCB9O1xuICAgIGxldCB2aWV3O1xuICAgIHRyeSB7XG4gICAgICAgIGlmIChiaW5kaW5nLnN1cHBvcnRlZCkgdmlldyA9IGF3YWl0IHNpZGViYXJTZW5kVG9UYWIodGFiLmlkLCByZXF1ZXN0KTtcbiAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBzZXNzaW9uID0gbmF0aXZlUnVudGltZVNlc3Npb25zLmdldChuYXRpdmVSdW50aW1lU2Vzc2lvbktleShzZW5kZXIsIG9yaWdpbikpO1xuICAgICAgICAgICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKG9yaWdpbikuaG9zdG5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHJ1bnRpbWU6IHsgb3JpZ2luLCB0aWNrZXQ6IGF3YWl0IG5hdGl2ZVJ1bnRpbWVUaWNrZXQoc2VuZGVyLCBtZXNzYWdlLndpbmRvd0lkLCBvcmlnaW4pIH0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZpZXcgPSBhd2FpdCBuYXRpdmVSdW50aW1lUmVxdWVzdChzZXNzaW9uLCByZXF1ZXN0KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07IH1cbiAgICAvLyBUaGUgYm91bmQgdGFiIGl0c2VsZiBtdXN0IHN0aWxsIGV4aXN0IGluIHRoZSBwYW5lbCdzIHdpbmRvdzsgbmV2ZXIgcmUtdGFyZ2V0XG4gICAgLy8gdG8gd2hhdGV2ZXIgaGFwcGVucyB0byBiZSBhY3RpdmUuIFRoZSBjb250ZW50IGRvY3VtZW50VG9rZW4gc3RpbGwgcGlucyBldmVudHMuXG4gICAgbGV0IGFsaXZlO1xuICAgIHRyeSB7IGFsaXZlID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYi5pZCk7IH0gY2F0Y2ggeyByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2Nsb3NlZCcgfTsgfVxuICAgIGlmIChhbGl2ZS53aW5kb3dJZCAhPT0gbWVzc2FnZS53aW5kb3dJZCB8fCAhYXdhaXQgbmF0aXZlUGFuZWxJZGVudGl0eShzZW5kZXIsIG1lc3NhZ2Uud2luZG93SWQpKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgaWYgKCF2aWV3Py5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFsnc3RvcmFnZScsICdjb25mbGljdCcsICdjaGFuZ2VkJywgJ3RpbWVvdXQnXS5pbmNsdWRlcyh2aWV3Py5yZWFzb24pID8gdmlldy5yZWFzb24gOiAnZmFpbGVkJyB9O1xuICAgIC8vIE9ubHkgYSBmaXJzdCBiaW5kaW5nIG9yIGFuIGV2ZW50IGZyb20gdGhlIHZpc2libGUgYm91bmQgdGFiIHJlY29yZHMgdGhlXG4gICAgLy8gc2VsZWN0aW9uOyBhIGJhY2tncm91bmQgcG9sbCBvZiBhIG5vbi1hY3RpdmUgdGFiIG11c3Qgbm90IG92ZXJ3cml0ZSBpdC5cbiAgICBjb25zdCBhY3RpdmVCb3VuZCA9IG1lc3NhZ2UudGFiSWQgPT09IHVuZGVmaW5lZCB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50J1xuICAgICAgICAmJiAoYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkIH0pKVswXT8uaWQgPT09IHRhYi5pZCk7XG4gICAgaWYgKGJpbmRpbmcuc3VwcG9ydGVkICYmIGFjdGl2ZUJvdW5kICYmIChhd2FpdCBjaHJvbWUud2luZG93cy5nZXQobWVzc2FnZS53aW5kb3dJZCkpLmZvY3VzZWQpIGF3YWl0IG5hdGl2ZVJlbWVtYmVyT3JpZ2luKG9yaWdpbik7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRhYklkOiB0YWIuaWQsIGhvc3Q6IG5ldyBVUkwob3JpZ2luKS5ob3N0bmFtZSwgbmF0aXZlOiAhYmluZGluZy5zdXBwb3J0ZWQsIHZpZXcgfTtcbn1cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZSwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICBpZiAoIVsnbWVtY2hhdDpzaWRlYmFyLXN0YXR1cycsICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcsICdtZW1jaGF0OnNpZGViYXItdmlldycsICdtZW1jaGF0OnNpZGViYXItZXZlbnQnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWIgfHwgKHNlbmRlci5mcmFtZUlkICE9PSB1bmRlZmluZWQgJiYgc2VuZGVyLmZyYW1lSWQgIT09IDApXG4gICAgICAgIHx8ICFuYXRpdmVEb2N1bWVudFVybChzZW5kZXIudXJsLCAncGFuZWwnLCAnc2lkZWJhcicpXG4gICAgICAgIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2Uud2luZG93SWQpIHx8IG1lc3NhZ2Uud2luZG93SWQgPCAwXG4gICAgICAgIHx8IChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpIHx8IG1lc3NhZ2UudGFiSWQgPCAwXG4gICAgICAgICAgICB8fCAhU0lERUJBUl9GRUFUVVJFUy5pbmNsdWRlcyhtZXNzYWdlLmZlYXR1cmUpKSlcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3JyAmJiBtZXNzYWdlLnRhYklkICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpIHx8IG1lc3NhZ2UudGFiSWQgPCAwKSlcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1ldmVudCcgJiYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1lc3NhZ2UudGFiSWQpIHx8IG1lc3NhZ2UudGFiSWQgPCAwXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5kb2N1bWVudFRva2VuICE9PSAnc3RyaW5nJyB8fCBtZXNzYWdlLmRvY3VtZW50VG9rZW4ubGVuZ3RoID4gMTAwXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5rZXkgIT09ICdzdHJpbmcnIHx8ICEvXlxcZHsxLDh9JC8udGVzdChtZXNzYWdlLmtleSlcbiAgICAgICAgICAgIHx8ICFbJ2NsaWNrJywgJ2lucHV0JywgJ2NoYW5nZScsICdlbnRlciddLmluY2x1ZGVzKG1lc3NhZ2UuZXZlbnQpKSkpIHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdpbnZhbGlkJyB9KTsgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBuYXRpdmVQYW5lbElkZW50aXR5KHNlbmRlciwgbWVzc2FnZS53aW5kb3dJZCkudGhlbih2YWxpZCA9PiB2YWxpZFxuICAgICAgICA/IChbJ21lbWNoYXQ6c2lkZWJhci12aWV3JywgJ21lbWNoYXQ6c2lkZWJhci1ldmVudCddLmluY2x1ZGVzKG1lc3NhZ2UudHlwZSlcbiAgICAgICAgICAgID8gc2lkZWJhclZpZXdEaXNwYXRjaChtZXNzYWdlLCBzZW5kZXIpIDogc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpKVxuICAgICAgICA6IHsgb2s6IGZhbHNlLCByZWFzb246ICdpbnZhbGlkJyB9KS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdmYWlsZWQnIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn0pO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5mdW5jdGlvbiBleHRlbnNpb25IYW5kbGVNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSB7XG4gICAgaWYgKFsnbWVtY2hhdDpuYXRpdmUtZHJhZnQtcmVhZCcsICdtZW1jaGF0Om5hdGl2ZS1kcmFmdC13cml0ZSddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgbmF0aXZlRHJhZnRNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikudGhlbihzZW5kUmVzcG9uc2UsICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQp9C10YDQvdC+0LLQuNC6INC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvS4g0J3QtSDQt9Cw0LrRgNGL0LLQsNC50YLQtSDQv9Cw0L3QtdC70YwuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLXRlc3Qtc291bmQnKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIG9yZGVyUGxheUF1ZGlvKCkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9JyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2UtaW5pdCcsICdtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnLCAnbWVtY2hhdDpzdG9yYWdlLXBydW5lJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGF0YDQsNC90LjQu9C40YnQsCDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CU0LDQvdC90YvQtSDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNC10L3RiyDRhdGA0LDQvdC40LvQuNGJ0LXQvC4g0J3QtSDQt9Cw0LrRgNGL0LLQsNC50YLQtSDQuCDQvdC1INC/0LXRgNC10LfQsNCz0YDRg9C20LDQudGC0LUg0LLQutC70LDQtNC60YMuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnLCAnbWVtY2hhdDpvcmRlcnMtcG9sbCcsICdtZW1jaGF0Om9yZGVycy1zdG9wJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgY29uc3Qgd29yayA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgICAgICAgICBpZiAodHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSAmJiBtZXNzYWdlLnR5cGUgIT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJ1xuICAgICAgICAgICAgICAgICYmICFhd2FpdCBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgJ0JlYXJlciAnICsgbWVzc2FnZS50b2tlbikpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQo9GH0ZHRgtC90YvQtSDQtNCw0L3QvdGL0LUg0LjQt9C80LXQvdC10L3Riy4g0J/QvtC00YLQstC10YDQtNC40YLQtSDQutC70Y7Rhy4nIH07XG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtY29uZmlndXJlJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yZGVyTXV0YXRlKCgpID0+IGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpKTtcbiAgICAgICAgICAgICAgICBjb25zdCBuYXRpdmUgPSBuYXRpdmVSdW50aW1lSWRlbnRpdGllcy5nZXQoc2VuZGVyKTtcbiAgICAgICAgICAgICAgICBpZiAobmF0aXZlICYmIHJlc3VsdC5vaykgeyBuYXRpdmUub3JkZXJUb2tlbiA9IG1lc3NhZ2UudG9rZW47IG5hdGl2ZS5vcmRlclJldmlzaW9uID0gcmVzdWx0LnJldmlzaW9uOyB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJykgcmV0dXJuIG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICAgICAgICAgICAgICBvcmRlckNvbmZpZy5zZXR0aW5ncy5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiArK29yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9yZGVyUHVibGljQ29uZmlnKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyQ29uZmlnQ2hhaW47XG4gICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgcmV0dXJuIHBvbGxPcmRlcnMoKTtcbiAgICAgICAgfTtcbiAgICAgICAgd29yaygpLnRoZW4oc2VuZFJlc3BvbnNlLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvdCw0YHRgtGA0L7QuNGC0Ywg0YTQvtC90L7QstGL0Lkg0L7Qv9GA0L7RgScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0OnBhbmVsLWNzcmYnKSB7XG4gICAgICAgIGlmICghKHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHJ1c3RlZE5hdGl2ZVJ1bnRpbWVTZW5kZXIoc2VuZGVyKSkgfHwgKG1lc3NhZ2UuZm9yY2UgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgbWVzc2FnZS5mb3JjZSAhPT0gJ2Jvb2xlYW4nKSkge1xuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBnZXRQYW5lbFNlc3Npb24obWVzc2FnZS5mb3JjZSA9PT0gdHJ1ZSkudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAnUGFuZWw6INGE0L7QvdC+0LLQsNGPINGB0LXRgdGB0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsC4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmICghWydtZW1jaGF0Omh0dHAnLCAnbWVtY2hhdDphYm9ydCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCEodHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0cnVzdGVkTmF0aXZlUnVudGltZVNlbmRlcihzZW5kZXIpKSB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtekEtWjAtOS1dezEsODB9JC8udGVzdChtZXNzYWdlLmlkKSkge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6YWJvcnQnKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCkpO1xuICAgICAgICBpZiAoZW50cnkpIHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcGVyZm9ybVJlcXVlc3QobWVzc2FnZSwgc2VuZGVyKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQuZXZlbnQgPT09ICdsb2FkJyAmJiBbNDAxLCA0MDMsIDQxOV0uaW5jbHVkZXMocmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpXG4gICAgICAgICAgICAmJiBuZXcgVVJMKG1lc3NhZ2UucmVxdWVzdC51cmwpLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1Jykge1xuICAgICAgICAgICAgY29uc3Qgc2VudFRva2VuID0gbmV3IEhlYWRlcnMobWVzc2FnZS5yZXF1ZXN0LmhlYWRlcnMgfHwge30pLmdldCgneC1jc3JmLXRva2VuJyk7XG4gICAgICAgICAgICBpZiAoc2VudFRva2VuICYmIHNlbnRUb2tlbiA9PT0gcGFuZWxTZXNzaW9uPy50b2tlbikge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmVzdWx0LnBhbmVsQXV0aExvc3QgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHNlbmRSZXNwb25zZShyZXN1bHQpO1xuICAgIH0sICgpID0+IHNlbmRSZXNwb25zZSh7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQt9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn1cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihleHRlbnNpb25IYW5kbGVNZXNzYWdlKTtcblxuLy8gUmVnaXN0ZXIgdG9vbGJhci9jb250ZXh0LW1lbnUgbGlzdGVuZXJzIHN5bmNocm9ub3VzbHkgb24gZXZlcnkgd29ya2VyIHdha2UuXG5pbXBvcnRTY3JpcHRzKCdjb250cm9scy5qcycpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbEtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSJ9
