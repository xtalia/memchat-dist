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
    const key = 'memchatPrivate_v1:' + new URL(sender.url || sender.tab.url).origin;
    const saved = (await chrome.storage.local.get(key))[key];
    const api = JSON.parse(saved?.items['memchat:hackerMsApi_v1']?.value || '{}');
    return api.bearerEnabled === true && typeof api.token === 'string' && authorization === 'Bearer ' + api.token;
}
function privateStorageMessage(message, sender) {
    const operation = privateStorageChain.then(async () => {
        await privateStorageReady;
        const origin = new URL(sender.url || sender.tab.url).origin;
        const storageKey = 'memchatPrivate_v1:' + origin;
        const saved = (await chrome.storage.local.get(storageKey))[storageKey];
        const bucket = saved || { version: 1, items: {}, legacyBackup: {} };
        if (bucket.version !== 1 || !bucket.items || typeof bucket.items !== 'object') throw Error('Invalid schema');
        if (message.type === 'memchat:storage-init') {
            const legacy = message.legacy;
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
            privateStorageSubscribers.set(sender.tab.id, { origin, documentId: sender.documentId });
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
            const document = sender.documentId || 'tab:' + sender.tab.id;
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
                if (tabId === sender.tab.id || subscriber.origin !== origin) continue;
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

function requestKey(sender, id) { return `${sender.tab.id}:${sender.frameId}:${id}`; }

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
                chrome.tabs.sendMessage(sender.tab.id, { type: 'memchat:request-current', id: message.id }, { frameId: sender.frameId }),
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
        orderSubscribers.add(sender.tab.id);
        await chrome.storage.session.set({ [ORDER_SESSION_KEY]: { config: orderConfig, revision: orderRevision, subscribers: [...orderSubscribers] } });
        if (chrome.alarms?.get && !(await chrome.alarms.get('memchat-orders'))) await orderSetAlarm();
        return { ...orderPublicConfig(), pollRequired: false };
    }
    if (orderConfig && message.revision !== orderRevision) return { ...orderPublicConfig(), ok: false, conflict: true, error: 'Настройки изменены в другой вкладке. Повторите изменение.' };
    const subscribers = orderConfig?.token === message.token ? new Set(orderSubscribers) : new Set();
    subscribers.add(sender.tab.id);
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
            if (ack?.ok) break;
        } catch { /* Try another live content world, not every tab. */ }
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
async function sidebarViewDispatch(message) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: message.windowId });
    if (!supportedActionTab(tab)) return { ok: false, reason: 'unsupported' };
    if (message.tabId !== undefined && tab.id !== message.tabId) return { ok: false, reason: 'changed' };
    const request = message.type === 'memchat:sidebar-view'
        ? { type: 'memchat:view-snapshot' }
        : { type: 'memchat:view-event', documentToken: message.documentToken,
            key: message.key, event: message.event, value: message.value,
            checked: message.checked, selected: message.selected };
    let view;
    try { view = await chrome.tabs.sendMessage(tab.id, request, { frameId: 0 }); }
    catch { return { ok: false, reason: 'missing' }; }
    const [active] = await chrome.tabs.query({ active: true, windowId: message.windowId });
    if (active?.id !== tab.id || active.url !== tab.url) return { ok: false, reason: 'changed' };
    if (!view?.ok) return { ok: false, reason: ['storage', 'conflict', 'changed'].includes(view?.reason) ? view.reason : 'failed' };
    return { ok: true, tabId: tab.id, host: new URL(tab.url).hostname, view };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!['memchat:sidebar-status', 'memchat:sidebar-command', 'memchat:sidebar-view', 'memchat:sidebar-event'].includes(message?.type)) return false;
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.frameId !== undefined && sender.frameId !== 0)
        || sender.url !== chrome.runtime.getURL('offscreen.html') + '#sidebar'
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
    (['memchat:sidebar-view', 'memchat:sidebar-event'].includes(message.type)
        ? sidebarViewDispatch(message) : sidebarDispatch(message)).then(sendResponse, () => sendResponse({ ok: false, reason: 'failed' }));
    return true;
});
/* module: extension/worker.js */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'memchat:orders-test-sound') {
        if (!trustedContentSender(sender)) { sendResponse({ ok: false, error: 'Запрос расширения отклонён' }); return false; }
        orderPlayAudio().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, error: 'Звук расширения недоступен' }));
        return true;
    }
    if (['memchat:storage-init', 'memchat:storage-write', 'memchat:storage-restore', 'memchat:storage-prune'].includes(message?.type)) {
        if (!trustedContentSender(sender)) { sendResponse({ ok: false, error: 'Запрос хранилища отклонён' }); return false; }
        privateStorageMessage(message, sender).then(sendResponse,
            () => sendResponse({ ok: false, error: 'Данные не подтверждены хранилищем. Не закрывайте и не перезагружайте вкладку.' }));
        return true;
    }
    if (['memchat:orders-configure', 'memchat:orders-poll', 'memchat:orders-stop'].includes(message?.type)) {
        if (!trustedContentSender(sender)) { sendResponse({ ok: false, error: 'Запрос расширения отклонён' }); return false; }
        const work = async () => {
            await orderReady;
            if (message.type === 'memchat:orders-configure') return orderMutate(() => configureOrders(message, sender));
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
        if (!trustedContentSender(sender) || (message.force !== undefined && typeof message.force !== 'boolean')) {
            sendResponse({ ok: false, error: 'Запрос расширения отклонён' });
            return false;
        }
        getPanelSession(message.force === true).then(sendResponse,
            () => sendResponse({ ok: false, error: 'Panel: фоновая сессия недоступна.' }));
        return true;
    }
    if (!['memchat:http', 'memchat:abort'].includes(message?.type)) return false;
    if (!trustedContentSender(sender) || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) {
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
});

// Register toolbar/context-menu listeners synchronously on every worker wake.
importScripts('controls.js');
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL25ldHdvcmsuanMiLCJleHRlbnNpb24vd29ya2VyL3BhbmVsLXNlc3Npb24uanMiLCJleHRlbnNpb24vd29ya2VyL29yZGVyLWFsZXJ0cy5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXJzLmpzIiwiZXh0ZW5zaW9uL3NpZGViYXItd29ya2VyLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBCdW5kbGVkIGludG8gd29ya2VyIGFuZCBpc29sYXRlZCBjb250ZW50OyBuZXZlciBleHBvc2VkIGluIHRoZSBwYWdlIHdvcmxkLlxuY29uc3QgTUVNQ0hBVF9TVE9SQUdFX0tFWVMgPSBuZXcgU2V0KFtcbiAgICAnZGVidWcnLCAnY2FsY1J1bGVzX3YyJywgJ3NjaGVkdWxlUmVwbGFjZW1lbnRzX3YxJywgJ3NjaGVkdWxlQ2FjaGVFbmFibGVkX3YxJyxcbiAgICAnc2NoZWR1bGVDYWNoZV92MV90b2RheScsICdzY2hlZHVsZUNhY2hlX3YxX3RvbW9ycm93JywgJ3NlbGVjdGVkQWN0aW9uX3YxJyxcbiAgICAnc2hvd0hhdGlrb0xpbmtzX3YxJywgJ2hhdGlrb1NlYXJjaE1vZGVfdjEnLCAncmV0cnlCZWhhdmlvcl92MScsICdoaWRkZW5GaWVsZHNfdjEnLFxuICAgICdtc1F1aWNrUGFuZWxfdjEnLCAnZmxvYXRXaW5kb3dQb3NfdjEnLCAnY2hhdEhpc3RvcnlfdjEnLCAnY2xlYXJUZXh0RGVsYXlfdjEnLFxuICAgICdjbGVhclRleHRFbmFibGVkJywgJ2hhY2tlckRlZmF1bHRDaGFubmVsX3YxJywgJ2hhY2tlclF1aWNrQnV0dG9uc192MScsXG4gICAgJ21zTWFnaWNDb25maWdfdjEnLCAnbXNGaWVsZHNTcG9pbGVyT3Blbl92MScsICdtc1JlZmVyZW5jZUNhY2hlX3YxJyxcbiAgICAnaGFja2VyTXNBcGlfdjEnLCAnaGFja2VyU3RhdGVzX3YxJywgJ2hhY2tlck9yZGVyTm90aWZpZXJfdjEnLFxuICAgICdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnNfdjEnLCAnaGFja2VyTm90aWZpZXJTZWVuX3YxJyxcbiAgICAnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrX3YxJywgJ2hhY2tlckludGVybmFsT3JkZXJXYXJlaG91c2VzX3YxJ1xuXS5tYXAoa2V5ID0+ICdtZW1jaGF0OicgKyBrZXkpLmNvbmNhdChbJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MSddKSk7XG5jb25zdCBNRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbJ21lbWNoYXQ6cGFuZWxDc3JmX3YxJywgJ2NsZWFyVGV4dEVuYWJsZWQnXSk7XG5mdW5jdGlvbiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgdmFsdWUpIHtcbiAgICBpZiAoa2V5ID09PSAnbWVtY2hhdDpjaGF0SGlzdG9yeV92MScpIHtcbiAgICAgICAgdHJ5IHsgY29uc3QgaGlzdG9yeSA9IEpTT04ucGFyc2UodmFsdWUpO1xuICAgICAgICAgICAgaWYgKGhpc3RvcnkgJiYgdHlwZW9mIGhpc3RvcnkgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KGhpc3RvcnkpKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGhpc3RvcnkuY2hlY2tIYXRpa29Cb251c2VzO1xuICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShoaXN0b3J5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIFByZXNlcnZlIG1hbGZvcm1lZCBleGlzdGluZyBkYXRhLCBub3QgYSBmYWJyaWNhdGVkIHJlcGxhY2VtZW50LiAqLyB9XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cbiIsIi8vIFByaXZhdGUgc3RvcmFnZSBpcyBvcmlnaW4tc2NvcGVkIHRvIHByZXNlcnZlIGV4aXN0aW5nIHNpdGUvYWNjb3VudCBzZXBhcmF0aW9uLlxuLy8gQ2hyb21lIG93bnMgcGVyc2lzdGVuY2U7IHBhZ2UgbG9jYWxTdG9yYWdlIGlzIHVzZWQgb25seSBmb3Igb25lLXRpbWUgbWlncmF0aW9uLlxuY29uc3QgcHJpdmF0ZVN0b3JhZ2VSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0QWNjZXNzTGV2ZWwoeyBhY2Nlc3NMZXZlbDogJ1RSVVNURURfQ09OVEVYVFMnIH0pO1xufSkoKTtcbi8vIEhhbmRsZSBpbml0aWFsaXphdGlvbiByZWplY3Rpb24gaW1tZWRpYXRlbHksIHdoaWxlIHJldGFpbmluZyBmYWlsLWNsb3NlZCBhd2FpdHMuXG5wcml2YXRlU3RvcmFnZVJlYWR5LmNhdGNoKCgpID0+IHt9KTtcbmxldCBwcml2YXRlU3RvcmFnZUNoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5jb25zdCBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzID0gbmV3IE1hcCgpO1xuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VTbmFwc2hvdChidWNrZXQpIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW2J1Y2tldC52ZXJzaW9uLCBPYmplY3Qua2V5cyhidWNrZXQuaXRlbXMpLnNvcnQoKS5tYXAoa2V5ID0+XG4gICAgICAgIFtrZXksIGJ1Y2tldC5pdGVtc1trZXldLnJldmlzaW9uLCBidWNrZXQuaXRlbXNba2V5XS52YWx1ZV0pLFxuICAgIE9iamVjdC5rZXlzKGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHwge30pLnNvcnQoKS5tYXAoa2V5ID0+IFtrZXksIGJ1Y2tldC5sZWdhY3lCYWNrdXBba2V5XV0pLFxuICAgIChidWNrZXQucmVjb3ZlcmllcyB8fCBbXSkubWFwKGVudHJ5ID0+IFtlbnRyeS5pZCwgZW50cnkua2V5LCBlbnRyeS52YWx1ZSwgZW50cnkuZG9jdW1lbnQsIGVudHJ5LnJldmlzaW9uXSksXG4gICAgYnVja2V0LnJlY292ZXJ5U2VxdWVuY2UgfHwgMCwgYnVja2V0LnJlY292ZXJ5RmVuY2VzIHx8IFtdXSk7XG59XG4vLyBQcml2YXRlIHZhcmlhbnRzIGFwcGVuZCBub3JtYWxseTsgb25seSBleHBsaWNpdCBjb25maXJtZWQgcHJ1bmUgZGVsZXRlcyBvbmUuXG4vLyBObyBhdXRvbWF0aWMgZXZpY3Rpb246IGV4aGF1c3Rpb24gZmFpbHMgY2xvc2VkLFxuLy8gYW5kIGNvbnRlbnQgbXVzdCBleHBsaWNpdGx5IHdhcm4gdGhhdCB0aGUgbmV3ZXN0IGVkaXQgaXMgTk9UIHlldCBkdXJhYmxlLlxuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCB2YWx1ZSwgcmV2aXNpb24sIGRvY3VtZW50KSB7XG4gICAgYnVja2V0LnJlY292ZXJpZXMgfHw9IFtdO1xuICAgIGNvbnN0IGV4aXN0aW5nID0gYnVja2V0LnJlY292ZXJpZXMuZmluZChlbnRyeSA9PiBlbnRyeS5rZXkgPT09IGtleSAmJiBlbnRyeS52YWx1ZSA9PT0gdmFsdWVcbiAgICAgICAgJiYgZW50cnkuZG9jdW1lbnQgPT09IGRvY3VtZW50ICYmIGVudHJ5LnJldmlzaW9uID09PSByZXZpc2lvbik7XG4gICAgaWYgKGV4aXN0aW5nKSByZXR1cm47XG4gICAgaWYgKGJ1Y2tldC5yZWNvdmVyaWVzLmxlbmd0aCA+PSAxMjgpIHRocm93IEVycm9yKCdSZWNvdmVyeSBjYXBhY2l0eSBleGhhdXN0ZWQnKTtcbiAgICBjb25zdCBpZCA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLmJ1Y2tldC5yZWNvdmVyaWVzLm1hcChlbnRyeSA9PiBlbnRyeS5pZCkpICsgMTtcbiAgICBpZiAoIU51bWJlci5pc1NhZmVJbnRlZ2VyKGlkKSkgdGhyb3cgRXJyb3IoJ1JlY292ZXJ5IElEIGV4aGF1c3RlZCcpO1xuICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlID0gaWQ7XG4gICAgYnVja2V0LnJlY292ZXJpZXMucHVzaCh7IGlkLCBrZXksIHZhbHVlLCByZXZpc2lvbiwgZG9jdW1lbnQgfSk7XG4gICAgaWYgKEpTT04uc3RyaW5naWZ5KGJ1Y2tldC5yZWNvdmVyaWVzKS5sZW5ndGggPiA1ICogMTAyNCAqIDEwMjQpIHRocm93IEVycm9yKCdSZWNvdmVyeSBjYXBhY2l0eSBleGhhdXN0ZWQnKTtcbn1cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGJ1Y2tldCkge1xuICAgIC8vIE5ldmVyIHNlbmQgcmVjb3ZlcnkgdmFsdWVzIChlc3BlY2lhbGx5IGNyZWRlbnRpYWxzL2hpc3RvcnkpIGludG8gYSB2aWV3LlxuICAgIHJldHVybiAoYnVja2V0LnJlY292ZXJpZXMgfHwgW10pLm1hcCgoeyBpZCwga2V5LCB2YWx1ZSwgcmV2aXNpb24gfSkgPT4gKHsgaWQsIGtleSwgZGVsZXRlZDogdmFsdWUgPT09IG51bGwsIHJldmlzaW9uIH0pKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCkge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtzdG9yYWdlS2V5XTogYnVja2V0IH0pO1xuICAgIGNvbnN0IGNvbW1pdHRlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoc3RvcmFnZUtleSkpW3N0b3JhZ2VLZXldO1xuICAgIGlmICghY29tbWl0dGVkIHx8IHByaXZhdGVTdG9yYWdlU25hcHNob3QoY29tbWl0dGVkKSAhPT0gcHJpdmF0ZVN0b3JhZ2VTbmFwc2hvdChidWNrZXQpKSB0aHJvdyBFcnJvcignU3RvcmFnZSB2ZXJpZmljYXRpb24gZmFpbGVkJyk7XG4gICAgcmV0dXJuIGNvbW1pdHRlZDtcbn1cbmFzeW5jIGZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQoc2VuZGVyLCBhdXRob3JpemF0aW9uKSB7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VSZWFkeTtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZUNoYWluO1xuICAgIGNvbnN0IGtleSA9ICdtZW1jaGF0UHJpdmF0ZV92MTonICsgbmV3IFVSTChzZW5kZXIudXJsIHx8IHNlbmRlci50YWIudXJsKS5vcmlnaW47XG4gICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KGtleSkpW2tleV07XG4gICAgY29uc3QgYXBpID0gSlNPTi5wYXJzZShzYXZlZD8uaXRlbXNbJ21lbWNoYXQ6aGFja2VyTXNBcGlfdjEnXT8udmFsdWUgfHwgJ3t9Jyk7XG4gICAgcmV0dXJuIGFwaS5iZWFyZXJFbmFibGVkID09PSB0cnVlICYmIHR5cGVvZiBhcGkudG9rZW4gPT09ICdzdHJpbmcnICYmIGF1dGhvcml6YXRpb24gPT09ICdCZWFyZXIgJyArIGFwaS50b2tlbjtcbn1cbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlTWVzc2FnZShtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBjb25zdCBvcGVyYXRpb24gPSBwcml2YXRlU3RvcmFnZUNoYWluLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgICAgICBjb25zdCBvcmlnaW4gPSBuZXcgVVJMKHNlbmRlci51cmwgfHwgc2VuZGVyLnRhYi51cmwpLm9yaWdpbjtcbiAgICAgICAgY29uc3Qgc3RvcmFnZUtleSA9ICdtZW1jaGF0UHJpdmF0ZV92MTonICsgb3JpZ2luO1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoc3RvcmFnZUtleSkpW3N0b3JhZ2VLZXldO1xuICAgICAgICBjb25zdCBidWNrZXQgPSBzYXZlZCB8fCB7IHZlcnNpb246IDEsIGl0ZW1zOiB7fSwgbGVnYWN5QmFja3VwOiB7fSB9O1xuICAgICAgICBpZiAoYnVja2V0LnZlcnNpb24gIT09IDEgfHwgIWJ1Y2tldC5pdGVtcyB8fCB0eXBlb2YgYnVja2V0Lml0ZW1zICE9PSAnb2JqZWN0JykgdGhyb3cgRXJyb3IoJ0ludmFsaWQgc2NoZW1hJyk7XG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtaW5pdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGxlZ2FjeSA9IG1lc3NhZ2UubGVnYWN5O1xuICAgICAgICAgICAgaWYgKCFsZWdhY3kgfHwgdHlwZW9mIGxlZ2FjeSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShsZWdhY3kpKSB0aHJvdyBFcnJvcignSW52YWxpZCBsZWdhY3kgc25hcHNob3QnKTtcbiAgICAgICAgICAgIGNvbnN0IGNsZWFudXAgPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2tleSwgcmF3XSBvZiBPYmplY3QuZW50cmllcyhsZWdhY3kpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiByYXcgIT09ICdzdHJpbmcnIHx8IHJhdy5sZW5ndGggPiA1ICogMTAyNCAqIDEwMjQpIHRocm93IEVycm9yKCdJbnZhbGlkIHZhbHVlJyk7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJ2NsZWFyVGV4dEVuYWJsZWQnICYmIFsndHJ1ZScsICdmYWxzZSddLmluY2x1ZGVzKHJhdykpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFPYmplY3QuaGFzT3duKGJ1Y2tldC5pdGVtcywgJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCcpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IFsndHJ1ZScsICdmYWxzZSddLmluY2x1ZGVzKGxlZ2FjeVsnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJ10pID8gbGVnYWN5WydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSA6IHJhdztcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5pdGVtc1snbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJ10gPSB7IHZhbHVlLCByZXZpc2lvbjogMSB9O1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJ1Y2tldC5pdGVtc1snbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJ10udmFsdWUgIT09IHJhdykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cCB8fD0ge307XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwLmNsZWFyVGV4dEVuYWJsZWQgPSByYXc7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKE1FTUNIQVRfUkVUSVJFRF9TVE9SQUdFX0tFWVMuaGFzKGtleSkpIHsgY2xlYW51cC5wdXNoKGtleSk7IGNvbnRpbnVlOyB9XG4gICAgICAgICAgICAgICAgaWYgKCFNRU1DSEFUX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgcmF3KTtcbiAgICAgICAgICAgICAgICBpZiAoIXNhdmVkKSBidWNrZXQuaXRlbXNba2V5XSA9IHsgdmFsdWUsIHJldmlzaW9uOiAxIH07XG4gICAgICAgICAgICAgICAgZWxzZSBpZiAoYnVja2V0Lml0ZW1zW2tleV0/LnZhbHVlICE9PSB2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBBbiBvbGRlciB1c2Vyc2NyaXB0IG1heSByZWNyZWF0ZSBvbGQga2V5cy4gUHJlc2VydmUgdGhhdCBjb3B5XG4gICAgICAgICAgICAgICAgICAgIC8vIHByaXZhdGVseSwgYnV0IG5ldmVyIHJvbGwgYmFjayB0aGUgY2Fub25pY2FsIGV4dGVuc2lvbiBzdGF0ZS5cbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cCB8fD0ge307XG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXBba2V5XSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjbGVhbnVwLnB1c2goa2V5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIEFja25vd2xlZGdlIG9ubHkgYWZ0ZXIgQ2hyb21lIGNvbW1pdHMgYW5kIGEgcmVhZC1iYWNrIHZlcmlmaWVzIGl0LlxuICAgICAgICAgICAgY29uc3QgY29tbWl0dGVkID0gYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDb21taXQoc3RvcmFnZUtleSwgYnVja2V0KTtcbiAgICAgICAgICAgIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuc2V0KHNlbmRlci50YWIuaWQsIHsgb3JpZ2luLCBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtczogY29tbWl0dGVkLml0ZW1zLCBjbGVhbnVwLCByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChjb21taXR0ZWQpIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c3RvcmFnZS1wcnVuZScpIHtcbiAgICAgICAgICAgIC8vIEV4cGxpY2l0IGlycmV2ZXJzaWJsZSBkZWxldGlvbiBvZiBPTkUgaW1tdXRhYmxlIElELCBuZXZlciBhIGJ1bGsgY2xlYXIuXG4gICAgICAgICAgICAvLyBLZWVwIGl0cyBkb2N1bWVudCBmZW5jZSBhZnRlciBkZWxldGlvbiwgYW5kIG5ldmVyIHJlY3ljbGUgSURzIChzdGFsZSBVSS9hY2sgcmV0cmllcykuXG4gICAgICAgICAgICBjb25zdCBzZXF1ZW5jZSA9IE1hdGgubWF4KGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlIHx8IDAsIC4uLihidWNrZXQucmVjb3ZlcmllcyB8fCBbXSkubWFwKGVudHJ5ID0+IGVudHJ5LmlkKSk7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5jb25maXJtZWQgIT09IHRydWUgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKG1lc3NhZ2UuaWQpIHx8IG1lc3NhZ2UuaWQgPCAxIHx8IG1lc3NhZ2UuaWQgPiBzZXF1ZW5jZSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcHJ1bmUnKTtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gYnVja2V0LnJlY292ZXJpZXM/LmZpbmQoaXRlbSA9PiBpdGVtLmlkID09PSBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyeVNlcXVlbmNlID0gc2VxdWVuY2U7XG4gICAgICAgICAgICBpZiAoZW50cnkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZG9jdW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LnJlY292ZXJ5RmVuY2VzIHx8PSBbXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFidWNrZXQucmVjb3ZlcnlGZW5jZXMuc29tZSgoW2tleSwgZG9jdW1lbnRdKSA9PiBrZXkgPT09IGVudHJ5LmtleSAmJiBkb2N1bWVudCA9PT0gZW50cnkuZG9jdW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQucmVjb3ZlcnlGZW5jZXMucHVzaChbZW50cnkua2V5LCBlbnRyeS5kb2N1bWVudF0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJ1Y2tldC5yZWNvdmVyaWVzID0gYnVja2V0LnJlY292ZXJpZXMuZmlsdGVyKGl0ZW0gPT4gaXRlbS5pZCAhPT0gbWVzc2FnZS5pZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBjb21taXR0ZWQgPSBhd2FpdCBwcml2YXRlU3RvcmFnZUNvbW1pdChzdG9yYWdlS2V5LCBidWNrZXQpO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlY292ZXJpZXM6IHByaXZhdGVTdG9yYWdlUmVjb3ZlcnlMaXN0KGNvbW1pdHRlZCkgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnXS5pbmNsdWRlcyhtZXNzYWdlLnR5cGUpKSB7XG4gICAgICAgICAgICBjb25zdCByZXN0b3JpbmcgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnN0b3JhZ2UtcmVzdG9yZSc7XG4gICAgICAgICAgICBjb25zdCByZWNvdmVyeSA9IHJlc3RvcmluZyAmJiBOdW1iZXIuaXNTYWZlSW50ZWdlcihtZXNzYWdlLmlkKVxuICAgICAgICAgICAgICAgICYmIGJ1Y2tldC5yZWNvdmVyaWVzPy5maW5kKGVudHJ5ID0+IGVudHJ5LmlkID09PSBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgIGlmIChyZXN0b3JpbmcgJiYgIXJlY292ZXJ5KSB0aHJvdyBFcnJvcignSW52YWxpZCByZWNvdmVyeScpO1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzdG9yaW5nID8gcmVjb3Zlcnkua2V5IDogbWVzc2FnZS5rZXksIHJldmlzaW9uID0gbWVzc2FnZS5yZXZpc2lvbjtcbiAgICAgICAgICAgIGNvbnN0IHJhdyA9IHJlc3RvcmluZyA/IHJlY292ZXJ5LnZhbHVlIDogbWVzc2FnZS52YWx1ZTtcbiAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHJldmlzaW9uKSB8fCByZXZpc2lvbiA8IDBcbiAgICAgICAgICAgICAgICB8fCByZXZpc2lvbiA+PSBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUlxuICAgICAgICAgICAgICAgIHx8IChyYXcgIT09IG51bGwgJiYgKHR5cGVvZiByYXcgIT09ICdzdHJpbmcnIHx8IHJhdy5sZW5ndGggPiA1ICogMTAyNCAqIDEwMjQpKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgd3JpdGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gYnVja2V0Lml0ZW1zW2tleV0gfHwgeyB2YWx1ZTogbnVsbCwgcmV2aXNpb246IDAgfTtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gcmF3ID09PSBudWxsID8gbnVsbCA6IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBzZW5kZXIuZG9jdW1lbnRJZCB8fCAndGFiOicgKyBzZW5kZXIudGFiLmlkO1xuICAgICAgICAgICAgLy8gUGVyc2lzdCB0aGUgZG9jdW1lbnQgZmVuY2Ugd2l0aCB0aGUgZmlyc3QgY29uZmxpY3QuIEFscmVhZHkgc2VudFxuICAgICAgICAgICAgLy8gb3B0aW1pc3RpYyB3cml0ZXMgY2Fubm90IGFjY2lkZW50YWxseSBvdmVyd3JpdGUgdGhlIHdpbm5lciBsYXRlcixcbiAgICAgICAgICAgIC8vIGluY2x1ZGluZyBhZnRlciB3b3JrZXIgc3VzcGVuc2lvbi4gUmVsb2FkIGNyZWF0ZXMgYSBuZXcgZG9jdW1lbnQuXG4gICAgICAgICAgICBjb25zdCBibG9ja2VkID0gIXJlc3RvcmluZyAmJiAoYnVja2V0LnJlY292ZXJpZXM/LnNvbWUoZW50cnkgPT4gZW50cnkua2V5ID09PSBrZXkgJiYgZW50cnkuZG9jdW1lbnQgPT09IGRvY3VtZW50KVxuICAgICAgICAgICAgICAgIHx8IGJ1Y2tldC5yZWNvdmVyeUZlbmNlcz8uc29tZSgoW2ZlbmNlZEtleSwgZmVuY2VkRG9jdW1lbnRdKSA9PiBmZW5jZWRLZXkgPT09IGtleSAmJiBmZW5jZWREb2N1bWVudCA9PT0gZG9jdW1lbnQpKTtcbiAgICAgICAgICAgIC8vIEEgY29uY3VycmVudCB3cml0ZXIgbWF5IGhhdmUgY29tbWl0dGVkIHRoZSBpZGVudGljYWwgZGVzaXJlZCB2YWx1ZS5cbiAgICAgICAgICAgIC8vIE9ubHkgYWNjZXB0IHRoZSBpbW1lZGlhdGVseSBwcmVjZWRpbmcgcmV2aXNpb24gc28gb3B0aW1pc3RpYyBxdWV1ZWRcbiAgICAgICAgICAgIC8vIHdyaXRlcyBjb250aW51ZSBmcm9tIHRoZSByZXZpc2lvbiB0aGUgY29udGVudCBhZGFwdGVyIHByZWRpY3RlZC5cbiAgICAgICAgICAgIGlmICghYmxvY2tlZCAmJiAhcmVzdG9yaW5nICYmIHByZXZpb3VzLnJldmlzaW9uID09PSByZXZpc2lvbiArIDEgJiYgcHJldmlvdXMudmFsdWUgPT09IHZhbHVlKSByZXR1cm4geyBvazogdHJ1ZSwgaXRlbTogcHJldmlvdXMgfTtcbiAgICAgICAgICAgIGlmIChibG9ja2VkIHx8IHByZXZpb3VzLnJldmlzaW9uICE9PSByZXZpc2lvbiB8fCBtZXNzYWdlLnByZXZpb3VzVmFsdWUgIT09IHByZXZpb3VzLnZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFyZXN0b3JpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCB2YWx1ZSwgcmV2aXNpb24sIGRvY3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDb21taXQoc3RvcmFnZUtleSwgYnVja2V0KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgcmVjb3ZlcmVkOiB0cnVlLCBrZXksIGl0ZW06IHByZXZpb3VzLFxuICAgICAgICAgICAgICAgICAgICByZWNvdmVyaWVzOiBwcml2YXRlU3RvcmFnZVJlY292ZXJ5TGlzdChidWNrZXQpIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzdG9yaW5nICYmIHByZXZpb3VzLnZhbHVlICE9PSB2YWx1ZSkgcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyKGJ1Y2tldCwga2V5LCBwcmV2aW91cy52YWx1ZSwgcHJldmlvdXMucmV2aXNpb24sIG51bGwpO1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHsgdmFsdWUsIHJldmlzaW9uOiByZXZpc2lvbiArIDEgfTtcbiAgICAgICAgICAgIGJ1Y2tldC5pdGVtc1trZXldID0gaXRlbTtcbiAgICAgICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ29tbWl0KHN0b3JhZ2VLZXksIGJ1Y2tldCk7XG4gICAgICAgICAgICAvLyBCZXN0LWVmZm9ydCBwcml2YXRlIGludmFsaWRhdGlvbjsgY2xvc2VkL3JlcGxhY2VkIGRvY3VtZW50cyBhcmUgaWdub3JlZC5cbiAgICAgICAgICAgIGZvciAoY29uc3QgW3RhYklkLCBzdWJzY3JpYmVyXSBvZiBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRhYklkID09PSBzZW5kZXIudGFiLmlkIHx8IHN1YnNjcmliZXIub3JpZ2luICE9PSBvcmlnaW4pIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbnMgPSBzdWJzY3JpYmVyLmRvY3VtZW50SWQgPyB7IGRvY3VtZW50SWQ6IHN1YnNjcmliZXIuZG9jdW1lbnRJZCB9IDogeyBmcmFtZUlkOiAwIH07XG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1jaGFuZ2VkJywga2V5LCBpdGVtIH0sIG9wdGlvbnMpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZ2V0KHRhYklkKSA9PT0gc3Vic2NyaWJlcikgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5kZWxldGUodGFiSWQpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGtleSwgaXRlbSwgLi4uKHJlc3RvcmluZyA/IHsgcmVjb3ZlcmllczogcHJpdmF0ZVN0b3JhZ2VSZWNvdmVyeUxpc3QoYnVja2V0KSB9IDoge30pIH07XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgRXJyb3IoJ0ludmFsaWQgb3BlcmF0aW9uJyk7XG4gICAgfSk7XG4gICAgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIG9wZXJhdGlvbjtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxuY29uc3QgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcCgpO1xuY29uc3QgcnVsZXNSZWFkeSA9IGNocm9tZS5kZWNsYXJhdGl2ZU5ldFJlcXVlc3QudXBkYXRlU2Vzc2lvblJ1bGVzKHtcbiAgICByZW1vdmVSdWxlSWRzOiBbMSwgMl0sXG4gICAgYWRkUnVsZXM6IFtcbiAgICAgICAgeyBpZDogMSwgcHJpb3JpdHk6IDEsIGFjdGlvbjogeyB0eXBlOiAnbW9kaWZ5SGVhZGVycycsIHJlcXVlc3RIZWFkZXJzOiBbXG4gICAgICAgICAgICB7IGhlYWRlcjogJ09yaWdpbicsIG9wZXJhdGlvbjogJ3NldCcsIHZhbHVlOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIH0sXG4gICAgICAgICAgICB7IGhlYWRlcjogJ1JlZmVyZXInLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcgfVxuICAgICAgICBdIH0sIGNvbmRpdGlvbjogeyBpbml0aWF0b3JEb21haW5zOiBbY2hyb21lLnJ1bnRpbWUuaWRdLCB1cmxGaWx0ZXI6ICd8aHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvJywgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddIH0gfSxcbiAgICAgICAgeyBpZDogMiwgcHJpb3JpdHk6IDIsIGFjdGlvbjogeyB0eXBlOiAnYmxvY2snIH0sIGNvbmRpdGlvbjoge1xuICAgICAgICAgICAgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSxcbiAgICAgICAgICAgIGV4Y2x1ZGVkUmVxdWVzdERvbWFpbnM6IFsuLi5uZXcgU2V0KE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5uZXR3b3JrSG9zdHMubWFwKGhvc3QgPT4gaG9zdC5yZXBsYWNlKC9eXFwqXFwuLywgJycpKSldLFxuICAgICAgICAgICAgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddXG4gICAgICAgIH0gfVxuICAgIF1cbn0pO1xuLy8gRmFpbCBjbG9zZWQ6IGEgZmFpbGVkIEROUiBzZXR1cCBpcyBjYXVnaHQgaGVyZSBhbmQgYmxvY2tzIHN1YnNlcXVlbnQgcmVxdWVzdHMuXG5sZXQgcnVsZUZhaWx1cmUgPSBmYWxzZTtcbnJ1bGVzUmVhZHkuY2F0Y2goKCkgPT4geyBydWxlRmFpbHVyZSA9IHRydWU7IH0pO1xuXG5mdW5jdGlvbiBtYXRjaGVzSG9zdChob3N0bmFtZSwgcGF0dGVybikge1xuICAgIHJldHVybiBwYXR0ZXJuLnN0YXJ0c1dpdGgoJyouJylcbiAgICAgICAgPyBob3N0bmFtZSA9PT0gcGF0dGVybi5zbGljZSgyKSB8fCBob3N0bmFtZS5lbmRzV2l0aCgnLicgKyBwYXR0ZXJuLnNsaWNlKDIpKVxuICAgICAgICA6IGhvc3RuYW1lID09PSBwYXR0ZXJuO1xufVxuXG5mdW5jdGlvbiBhbGxvd2VkVXJsKHJhdykge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5wb3J0XG4gICAgICAgIHx8ICFNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLnNvbWUoaG9zdCA9PiBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIGhvc3QpKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VSTCBub3QgcGVybWl0dGVkJyk7XG4gICAgfVxuICAgIHJldHVybiB1cmw7XG59XG5cbmZ1bmN0aW9uIHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHNlbmRlci50YWI/LmlkKSB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VuZGVyLnVybCk7XG4gICAgICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiBNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcucGFnZU1hdGNoZXMuc29tZShwYXR0ZXJuID0+XG4gICAgICAgICAgICBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIG5ldyBVUkwocGF0dGVybi5yZXBsYWNlKCcqLicsICd3aWxkY2FyZC4nKSkuaG9zdG5hbWUucmVwbGFjZSgnd2lsZGNhcmQuJywgJyouJykpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RLZXkoc2VuZGVyLCBpZCkgeyByZXR1cm4gYCR7c2VuZGVyLnRhYi5pZH06JHtzZW5kZXIuZnJhbWVJZH06JHtpZH1gOyB9XG5cbi8vIERpc3BhdGNoIE1TIHJlcXVlc3RzIGRpcmVjdGx5LiBPbmx5IGEgZmFpbGVkIHJlYWQgd2FpdHMgZm9yIGl0cyBvd24gcmV0cnk7XG4vLyBubyBwcm9maWxlLXdpZGUgcXVvdGEgc3RhdGUsIHJlc2VydmF0aW9ucywgY29uY3VycmVuY3kgY2FwIG9yIHBhY2luZy5cbmZ1bmN0aW9uIGlzTXNKc29uQXBpKHVybCkge1xuICAgIHJldHVybiB1cmwuaG9zdG5hbWUgPT09ICdhcGkubW95c2tsYWQucnUnICYmIC9eXFwvYXBpXFwvcmVtYXBcXC8xXFwuMig/OlxcL3wkKS8udGVzdCh1cmwucGF0aG5hbWUpO1xufVxuZnVuY3Rpb24gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCB0ZXh0ID0gJycpIHtcbiAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgICAgbGV0IHF1b3RhRXJyb3IgPSBmYWxzZTtcbiAgICAgICAgdHJ5IHsgcXVvdGFFcnJvciA9IEpTT04ucGFyc2UodGV4dCk/LmVycm9ycz8uc29tZShlcnJvciA9PiBOdW1iZXIoZXJyb3IuY29kZSkgPT09IDEwNzMpID09PSB0cnVlOyB9IGNhdGNoIHsgLyogTm90IEpTT04uICovIH1cbiAgICAgICAgaWYgKCFbNDA4LCA0MjldLmluY2x1ZGVzKHJlc3BvbnNlLnN0YXR1cykgJiYgcmVzcG9uc2Uuc3RhdHVzIDwgNTAwICYmICFxdW90YUVycm9yKSByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgbG9nbmV4ID0gTnVtYmVyKHJlc3BvbnNlPy5oZWFkZXJzLmdldCgnWC1Mb2duZXgtUmV0cnktQWZ0ZXInKSB8fCAwKTtcbiAgICBjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2U/LmhlYWRlcnMuZ2V0KCdSZXRyeS1BZnRlcicpO1xuICAgIGNvbnN0IHNlY29uZHMgPSByZXRyeUFmdGVyPy50cmltKCkgPyBOdW1iZXIocmV0cnlBZnRlcikgOiAwO1xuICAgIGNvbnN0IHN0YW5kYXJkID0gTnVtYmVyLmlzRmluaXRlKHNlY29uZHMpID8gc2Vjb25kcyAqIDEwMDAgOiBEYXRlLnBhcnNlKHJldHJ5QWZ0ZXIpIC0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBkZWxheSA9IE1hdGgubWF4KDUwMCwgTnVtYmVyLmlzRmluaXRlKGxvZ25leCkgPyBsb2duZXggOiAwLCBOdW1iZXIuaXNGaW5pdGUoc3RhbmRhcmQpID8gc3RhbmRhcmQgOiAwKTtcbiAgICByZXR1cm4gZGVsYXk7XG59XG5mdW5jdGlvbiBtc1dhaXRGb3JSZXRyeShzaWduYWwsIGRlbGF5KSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICBsZXQgcmVtYWluaW5nID0gZGVsYXk7XG4gICAgICAgIGxldCB0aW1lcjtcbiAgICAgICAgY29uc3QgZG9uZSA9ICgpID0+IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgZG9uZSk7IHJlc29sdmUoKTsgfTtcbiAgICAgICAgY29uc3Qgc2NoZWR1bGUgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjaHVuayA9IE1hdGgubWluKHJlbWFpbmluZywgMjE0NzQ4MzY0Nyk7XG4gICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlbWFpbmluZyAtPSBjaHVuaztcbiAgICAgICAgICAgICAgICBpZiAocmVtYWluaW5nID4gMCkgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgICAgICBlbHNlIGRvbmUoKTtcbiAgICAgICAgICAgIH0sIGNodW5rKTtcbiAgICAgICAgfTtcbiAgICAgICAgc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgZG9uZSwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIGRvbmUoKTtcbiAgICAgICAgZWxzZSBzY2hlZHVsZSgpO1xuICAgIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwZXJmb3JtUmVxdWVzdChtZXNzYWdlLCBzZW5kZXIsIGJhY2tncm91bmRTaWduYWwpIHtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWVzc2FnZS5yZXF1ZXN0O1xuICAgIGNvbnN0IHVybCA9IGFsbG93ZWRVcmwocmVxdWVzdD8udXJsKTtcbiAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKCFbJ0dFVCcsICdIRUFEJywgJ1BPU1QnLCAnUFVUJywgJ1BBVENIJywgJ0RFTEVURSddLmluY2x1ZGVzKG1ldGhvZCkpIHRocm93IG5ldyBFcnJvcignTWV0aG9kIG5vdCBwZXJtaXR0ZWQnKTtcbiAgICBpZiAocmVxdWVzdC5kYXRhICE9IG51bGwgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSAhPT0gJ3N0cmluZycpIHRocm93IG5ldyBFcnJvcignQm9keSBtdXN0IGJlIHRleHQnKTtcbiAgICBpZiAocmVxdWVzdC5kYXRhICE9IG51bGwgJiYgWydHRVQnLCAnSEVBRCddLmluY2x1ZGVzKG1ldGhvZCkpIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBib2R5Jyk7XG4gICAgaWYgKHJlcXVlc3QucmVzcG9uc2VUeXBlICYmICFbJ3RleHQnLCAnanNvbiddLmluY2x1ZGVzKHJlcXVlc3QucmVzcG9uc2VUeXBlKSkgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCByZXNwb25zZSB0eXBlJyk7XG4gICAgY29uc3QgaGVhZGVycyA9IG5ldyBIZWFkZXJzKCk7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHJlcXVlc3QuaGVhZGVycyB8fCB7fSkpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBoZWFkZXInKTtcbiAgICAgICAgaWYgKC9eYXV0aG9yaXphdGlvbiQvaS50ZXN0KG5hbWUpICYmIHVybC5ob3N0bmFtZSAhPT0gJ2FwaS5tb3lza2xhZC5ydScpIHRocm93IG5ldyBFcnJvcignQXV0aG9yaXphdGlvbiBob3N0IG5vdCBwZXJtaXR0ZWQnKTtcbiAgICAgICAgaWYgKC9eKG9yaWdpbnxyZWZlcmVyfHVzZXItYWdlbnR8Y29va2llfGhvc3R8Y29udGVudC1sZW5ndGh8Y29ubmVjdGlvbnxhY2NlcHQtZW5jb2Rpbmd8cHJveHktLip8c2VjLS4qKSQvaS50ZXN0KG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgaGVhZGVycy5zZXQobmFtZSwgdmFsdWUpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSByZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCk7XG4gICAgaWYgKHBlbmRpbmdSZXF1ZXN0cy5oYXMoa2V5KSkgdGhyb3cgbmV3IEVycm9yKCdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IGVudHJ5ID0geyBjb250cm9sbGVyOiBuZXcgQWJvcnRDb250cm9sbGVyKCksIGV2ZW50OiAnJyB9O1xuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoa2V5LCBlbnRyeSk7XG4gICAgY29uc3QgY2FuY2VsQmFja2dyb3VuZCA9ICgpID0+IHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH07XG4gICAgYmFja2dyb3VuZFNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgaWYgKGJhY2tncm91bmRTaWduYWw/LmFib3J0ZWQpIGNhbmNlbEJhY2tncm91bmQoKTtcbiAgICBjb25zdCB0aW1lb3V0ID0gTWF0aC5taW4oMzAwMDAsIE1hdGgubWF4KDEsIE51bWJlcihyZXF1ZXN0LnRpbWVvdXQpIHx8IDMwMDAwKSk7XG4gICAgbGV0IHRpbWVyO1xuICAgIGNvbnN0IGNoZWNrQ3VycmVudCA9IHJlcXVlc3QuY3JlZGVudGlhbEd1YXJkID09PSB0cnVlID8gYXN5bmMgKCkgPT4ge1xuICAgICAgICBsZXQgY2hlY2tUaW1lcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2Uoc2VuZGVyLnRhYi5pZCwgeyB0eXBlOiAnbWVtY2hhdDpyZXF1ZXN0LWN1cnJlbnQnLCBpZDogbWVzc2FnZS5pZCB9LCB7IGZyYW1lSWQ6IHNlbmRlci5mcmFtZUlkIH0pLFxuICAgICAgICAgICAgICAgIG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyBjaGVja1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKG51bGwpLCAxMDAwKTsgfSlcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgaWYgKHJlc3VsdD8uY3VycmVudCA9PT0gdHJ1ZSAmJiAoIWlzTXNKc29uQXBpKHVybCkgfHwgdHlwZW9mIHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQgIT09ICdmdW5jdGlvbidcbiAgICAgICAgICAgICAgICB8fCBhd2FpdCBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgaGVhZGVycy5nZXQoJ2F1dGhvcml6YXRpb24nKSkpKSByZXR1cm47XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBNaXNzaW5nL2ludmFsaWRhdGVkIGNvbnRlbnQgd29ybGQgZmFpbHMgY2xvc2VkLiAqLyB9XG4gICAgICAgIGZpbmFsbHkgeyBjbGVhclRpbWVvdXQoY2hlY2tUaW1lcik7IH1cbiAgICAgICAgZW50cnkuZXZlbnQgPSAnYWJvcnQnO1xuICAgICAgICBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7XG4gICAgfSA6IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcnVsZXNSZWFkeTtcbiAgICAgICAgaWYgKHJ1bGVGYWlsdXJlKSB0aHJvdyBuZXcgRXJyb3IoJ05ldHdvcmsgcnVsZXMgdW5hdmFpbGFibGUnKTtcbiAgICAgICAgaWYgKHVybC5vcmlnaW4gPT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgJiYgcGFuZWxTZXNzaW9uPy50YWIpIHtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHBhbmVsUmVxdWVzdFZpYVRhYih7IC4uLnJlcXVlc3QsIG1ldGhvZCB9LCBlbnRyeS5jb250cm9sbGVyLnNpZ25hbCk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IDsgYXR0ZW1wdCsrKSB7XG4gICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB9O1xuICAgICAgICAgICAgaWYgKGNoZWNrQ3VycmVudCkgYXdhaXQgY2hlY2tDdXJyZW50KCk7XG4gICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB9O1xuICAgICAgICAgICAgY29uc3QgY2FuUmV0cnkgPSBpc01zSnNvbkFwaSh1cmwpICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpICYmIGF0dGVtcHQgPT09IDA7XG4gICAgICAgICAgICBsZXQgcmV0cnlEZWxheTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGVudHJ5LmNvbnRyb2xsZXI7XG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgZW50cnkuZXZlbnQgPSAndGltZW91dCc7IGNvbnRyb2xsZXIuYWJvcnQoKTsgfSwgdGltZW91dCk7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwuaHJlZiwge1xuICAgICAgICAgICAgICAgICAgICBtZXRob2QsIGhlYWRlcnMsIGJvZHk6IHJlcXVlc3QuZGF0YSA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmFub255bW91cyA9PT0gdHJ1ZSA/ICdvbWl0JyA6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgICAgICAgICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCwgcmVkaXJlY3Q6IGlzTXNKc29uQXBpKHVybCkgPyAnZXJyb3InIDogJ2ZvbGxvdydcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAvLyBETlIgYmxvY2tzIHJlZGlyZWN0cyB0byB1bmdyYW50ZWQgaG9zdHMgYmVmb3JlIHNlbmRpbmcgYnl0ZXMuXG4gICAgICAgICAgICAgICAgYWxsb3dlZFVybChyZXNwb25zZS51cmwgfHwgdXJsLmhyZWYpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHRocm93IG5ldyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IGNhblJldHJ5ID8gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCByZXNwb25zZVRleHQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAocmV0cnlEZWxheSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgcGFyc2VkID0gcmVzcG9uc2VUZXh0O1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVxdWVzdC5yZXNwb25zZVR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpOyB9IGNhdGNoIHsgcGFyc2VkID0gbnVsbDsgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGV2ZW50OiAnbG9hZCcsIHJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCwgcmVzcG9uc2VUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2U6IHBhcnNlZCwgcmVzcG9uc2VIZWFkZXJzOiBbLi4ucmVzcG9uc2UuaGVhZGVyc10ubWFwKChbbmFtZSwgdmFsdWVdKSA9PiBgJHtuYW1lfTogJHt2YWx1ZX1gKS5qb2luKFN0cmluZy5mcm9tQ2hhckNvZGUoMTMsIDEwKSksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaW5hbFVybDogcmVzcG9uc2UudXJsIHx8IHVybC5ocmVmLCByZWFkeVN0YXRlOiA0XG4gICAgICAgICAgICAgICAgICAgIH0gfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNhblJldHJ5IHx8IGVudHJ5LmV2ZW50ID09PSAnYWJvcnQnKSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfHwgJ2Vycm9yJywgZXJyb3I6ICfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcgfTtcbiAgICAgICAgICAgICAgICByZXRyeURlbGF5ID0gNTAwO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgfVxuICAgICAgICAgICAgLy8gQSB0aW1lb3V0IGFib3J0cyBpdHMgYXR0ZW1wdCwgbm90IHRoZSBuZXh0IG9uZS4gRXhwbGljaXQgYWJvcnRzIGFuZFxuICAgICAgICAgICAgLy8gY3JlZGVudGlhbCBjaGFuZ2VzIHN0aWxsIGNhbmNlbCB0aGlzIHdhaXQgYW5kIHN1cHByZXNzIHRoZSByZXRyeS5cbiAgICAgICAgICAgIGVudHJ5LmV2ZW50ID0gJyc7XG4gICAgICAgICAgICBlbnRyeS5jb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICAgICAgYXdhaXQgbXNXYWl0Rm9yUmV0cnkoZW50cnkuY29udHJvbGxlci5zaWduYWwsIHJldHJ5RGVsYXkpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGJhY2tncm91bmRTaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsQmFja2dyb3VuZCk7XG4gICAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoa2V5KTtcbiAgICB9XG59XG4iLCIvLyBBIHNpbmdsZSB3b3JrZXIgb3ducyB0aGUgUGFuZWwgdG9rZW4uIE5ldmVyIHBlcnNpc3QgaXQgaW50byBwYWdlIHN0b3JhZ2UuXG5jb25zdCBQQU5FTF9TRVNTSU9OX1RUTCA9IDEyICogNjAgKiAxMDAwO1xuY29uc3QgUEFORUxfU0VTU0lPTl9USU1FT1VUID0gMTUwMDA7XG5sZXQgcGFuZWxTZXNzaW9uID0gbnVsbDtcbmxldCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xubGV0IGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcblxuZnVuY3Rpb24gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGh0bWwpIHtcbiAgICBjb25zdCBjbGVhbiA9IGh0bWwucmVwbGFjZSgvPCEtLVtcXHNcXFNdKj8tLT58PHNjcmlwdFxcYltePl0qPltcXHNcXFNdKj88XFwvc2NyaXB0XFxzKj4vZ2ksICcnKTtcbiAgICBpZiAoLzxpbnB1dFxcYltePl0qXFxidHlwZVxccyo9XFxzKltcIiddP3Bhc3N3b3JkXFxiL2kudGVzdChjbGVhbikpIHJldHVybiAnJztcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBjbGVhbi5tYXRjaCgvPG1ldGFcXGJbXj5dKj4vZ2kpIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IGF0dHJzID0ge307XG4gICAgICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgdGFnLm1hdGNoQWxsKC8oW1xcdy1dKylcXHMqPVxccyooPzpcIihbXlwiXSopXCJ8JyhbXiddKiknKS9nKSkge1xuICAgICAgICAgICAgYXR0cnNbbWF0Y2hbMV0udG9Mb3dlckNhc2UoKV0gPSBtYXRjaFsyXSA/PyBtYXRjaFszXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXR0cnMubmFtZT8udG9Mb3dlckNhc2UoKSA9PT0gJ2NzcmYtdG9rZW4nICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChhdHRycy5jb250ZW50IHx8ICcnKSkgcmV0dXJuIGF0dHJzLmNvbnRlbnQ7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cblxubGV0IHBhbmVsVGFiU2VxdWVuY2UgPSAwO1xuZnVuY3Rpb24gcGFuZWxUYWJVcmwocmF3KSB7XG4gICAgdHJ5IHsgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpOyByZXR1cm4gdXJsLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmQgJiYgIS9eXFwvbG9naW5cXC8/JC8udGVzdCh1cmwucGF0aG5hbWUpOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmZ1bmN0aW9uIHBhbmVsVGFiUmVxdWVzdEFsbG93ZWQocmVxdWVzdCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxdWVzdD8udXJsKSwgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gcGFuZWxUYWJVcmwodXJsLmhyZWYpICYmICF1cmwuaGFzaCAmJiAhdXJsLnNlYXJjaCAmJiAoKG1ldGhvZCA9PT0gJ0dFVCdcbiAgICAgICAgICAgICYmICh1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAvXlxcL2FwaVxcL2JvbnVzZXNcXC9jaGVja1xcL1xcZHsxLDIwfSQvLnRlc3QodXJsLnBhdGhuYW1lKSkpXG4gICAgICAgICAgICB8fCAobWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZWFyY2gnICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgPT09ICdzdHJpbmcnICYmIHJlcXVlc3QuZGF0YS5sZW5ndGggPD0gMzI3NjgpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFRhYk1lc3NhZ2UodGFiSWQsIHBheWxvYWQsIHNpZ25hbCkge1xuICAgIGNvbnN0IGlkID0gJ3BhbmVsLScgKyBEYXRlLm5vdygpICsgJy0nICsgKCsrcGFuZWxUYWJTZXF1ZW5jZSk7XG4gICAgbGV0IHRpbWVyLCBhYm9ydDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBhYm9ydCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgb3BlcmF0aW9uOiAnY2FuY2VsJyB9LCB7IGZyYW1lSWQ6IDAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgICAgICAgIHJlc29sdmUobnVsbCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KGFib3J0LCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc2lnbmFsPy5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IFByb21pc2UucmFjZShbY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6cGFuZWwtdGFiJywgaWQsIC4uLnBheWxvYWQgfSwgeyBmcmFtZUlkOiAwIH0pLCB0aW1lb3V0XSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XG4gICAgZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBhYm9ydCk7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHJlY292ZXJQYW5lbEZyb21UYWIoc2lnbmFsKSB7XG4gICAgaWYgKCFjaHJvbWUudGFicz8ucXVlcnkgfHwgIWNocm9tZS50YWJzPy5nZXQgfHwgc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRhYnMgPSAoYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS8qJyB9KSkuZmlsdGVyKHRhYiA9PiBOdW1iZXIuaXNJbnRlZ2VyKHRhYi5pZCkgJiYgcGFuZWxUYWJVcmwodGFiLnVybCkpO1xuICAgICAgICB0YWJzLnNvcnQoKGEsIGIpID0+IE51bWJlcighIWIuYWN0aXZlKSAtIE51bWJlcighIWEuYWN0aXZlKSB8fCAoYi5sYXN0QWNjZXNzZWQgfHwgMCkgLSAoYS5sYXN0QWNjZXNzZWQgfHwgMCkgfHwgYS5pZCAtIGIuaWQpO1xuICAgICAgICBmb3IgKGNvbnN0IHRhYiBvZiB0YWJzLnNsaWNlKDAsIDMpKSB7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2UodGFiLmlkLCB7IG9wZXJhdGlvbjogJ3Nlc3Npb24nIH0sIHNpZ25hbCk7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYi5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgaWYgKHJlcGx5Py5vayAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QocmVwbHkudG9rZW4gfHwgJycpICYmIHR5cGVvZiByZXBseS5pbnN0YW5jZSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAmJiByZXBseS5pbnN0YW5jZS5sZW5ndGggPD0gMTAwICYmIHBhbmVsVGFiVXJsKGN1cnJlbnQ/LnVybCkpIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSB7IHRva2VuOiByZXBseS50b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSwgdGFiOiB7IGlkOiB0YWIuaWQsIGluc3RhbmNlOiByZXBseS5pbnN0YW5jZSB9IH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuOiByZXBseS50b2tlbiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC9uYXZpZ2F0ZWQgdGFicyBhcmUgbm90IGFuIGF1dGhlbnRpY2F0ZWQgc2Vzc2lvbi4gKi8gfVxuICAgIHJldHVybiBudWxsO1xufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxSZXF1ZXN0VmlhVGFiKHJlcXVlc3QsIHNpZ25hbCkge1xuICAgIGNvbnN0IHJvdXRlID0gcGFuZWxTZXNzaW9uPy50YWI7XG4gICAgaWYgKCFyb3V0ZSB8fCAhcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSkgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC30LDQv9GA0L7RgSDQvtGC0LrQu9C+0L3RkdC9JyB9O1xuICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQocm91dGUuaWQpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmICghcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6IHNpZ25hbC5hYm9ydGVkID8gJ2Fib3J0JyA6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INCy0LrQu9Cw0LTQutCwINC30LDQutGA0YvRgtCwINC40LvQuCDQuNC30LzQtdC90LXQvdCwLiDQn9C+0LLRgtC+0YDQuNGC0LUg0L/RgNC+0LLQtdGA0LrRgyBwYW5lbC4nIH07XG4gICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2Uocm91dGUuaWQsIHsgb3BlcmF0aW9uOiAncmVxdWVzdCcsIGluc3RhbmNlOiByb3V0ZS5pbnN0YW5jZSwgcmVxdWVzdCB9LCBzaWduYWwpO1xuICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6ICdhYm9ydCcgfTtcbiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFyZXBseT8ub2sgfHwgcmVwbHkuaW5zdGFuY2UgIT09IHJvdXRlLmluc3RhbmNlIHx8ICFwYW5lbFRhYlVybChhZnRlcj8udXJsKSB8fCByZXBseS5yZXN1bHQ/LmV2ZW50ICE9PSAnbG9hZCdcbiAgICAgICAgfHwgIU51bWJlci5pc0ludGVnZXIocmVwbHkucmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpIHx8IHJlcGx5LnJlc3VsdC5yZXNwb25zZT8uZmluYWxVcmwgIT09IHJlcXVlc3QudXJsKSB7XG4gICAgICAgIGlmIChwYW5lbFNlc3Npb24/LnRhYiA9PT0gcm91dGUpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ1BhbmVsOiDQutC+0L3RgtC10LrRgdGCINCy0LrQu9Cw0LTQutC4INC40LfQvNC10L3QuNC70YHRjy4g0J3QsNC20LzQuNGC0LUgcGFuZWwg0LTQu9GPINC/0L7QstGC0L7RgNC90L7QuSDQv9GA0L7QstC10YDQutC4LicgfTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcGx5LnJlc3VsdDtcbn1cblxuZnVuY3Rpb24gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpIHtcbiAgICAvLyBBIHF1ZXVlZCBub3JtYWwgZmxpZ2h0IG1heSBoYXZlIHBvcHVsYXRlZCB0aGUgY2FjaGUgc2luY2UgZm9yY2Ugd2FzIHJlcXVlc3RlZC5cbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgY29uc3QgZmxpZ2h0ID0geyBwcm9taXNlOiBudWxsIH07XG4gICAgZmxpZ2h0LnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICBjb25zdCBmYWlsdXJlID0gYXN5bmMgKHJlYXNvbiwgZXJyb3IpID0+IChhd2FpdCByZWNvdmVyUGFuZWxGcm9tVGFiKGNvbnRyb2xsZXIuc2lnbmFsKSkgfHwgeyBvazogZmFsc2UsIHJlYXNvbiwgZXJyb3IgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgICAgICBpZiAocnVsZUZhaWx1cmUgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IEVycm9yKCdQYW5lbCB1bmF2YWlsYWJsZScpO1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJywge1xuICAgICAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsIGhlYWRlcnM6IHsgQWNjZXB0OiAndGV4dC9odG1sJyB9LCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLFxuICAgICAgICAgICAgICAgIGNhY2hlOiAnbm8tc3RvcmUnLCByZWRpcmVjdDogJ2ZvbGxvdycsIHNpZ25hbDogY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgZmluYWxVcmwgPSBuZXcgVVJMKHJlc3BvbnNlLnVybCB8fCAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJyk7XG4gICAgICAgICAgICBpZiAoZmluYWxVcmwub3JpZ2luICE9PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIHx8ICEvXlxcL3NlYXJjaFxcLz8kLy50ZXN0KGZpbmFsVXJsLnBhdGhuYW1lKVxuICAgICAgICAgICAgICAgIHx8IHJlc3BvbnNlLnN0YXR1cyA8IDIwMCB8fCByZXNwb25zZS5zdGF0dXMgPj0gMzAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ2F1dGgnLCAnUGFuZWw6INGE0L7QvdC+0LLRi9C5INCy0YXQvtC0INC90LXQtNC+0YHRgtGD0L/QtdC9LiDQntGC0LrRgNC+0LnRgtC1INCw0LLRgtC+0YDQuNC30L7QstCw0L3QvdGD0Y4gcGFuZWwuaGF0aWtvLnJ1INCyINGN0YLQvtC8INC/0YDQvtGE0LjQu9C1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdG9rZW4gPSBleHRyYWN0UGFuZWxTZXNzaW9uVG9rZW4oYXdhaXQgcmVzcG9uc2UudGV4dCgpKTtcbiAgICAgICAgICAgIGlmICghdG9rZW4gfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ2F1dGgnLCAnUGFuZWw6INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/QvtC00YLQstC10YDQtNC40YLRjCDQstGF0L7QtC4g0J7RgtC60YDQvtC50YLQtSBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICAvLyBMYXJhdmVsIGlzc3VlcyBDU1JGIGV2ZW4gZm9yIGFub255bW91cyBsb2dpbiBwYWdlcy4gQ29uZmlybSBhY2Nlc3NcbiAgICAgICAgICAgIC8vIHRvIGFuIGFjdHVhbCBwcm90ZWN0ZWQgcmVhZC1vbmx5IEFQSSB3aXRoIHRoZSBzYW1lIGJyb3dzZXIgY29va2llcy5cbiAgICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvYXBpL3NlYXJjaC9maWx0ZXJzJywge1xuICAgICAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsIGhlYWRlcnM6IHsgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsICdYLVJlcXVlc3RlZC1XaXRoJzogJ1hNTEh0dHBSZXF1ZXN0JyB9LFxuICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsIGNhY2hlOiAnbm8tc3RvcmUnLCByZWRpcmVjdDogJ2ZvbGxvdycsIHNpZ25hbDogY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgYXV0aFVybCA9IG5ldyBVUkwoYXV0aC51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycpO1xuICAgICAgICAgICAgaWYgKGF1dGguc3RhdHVzIDwgMjAwIHx8IGF1dGguc3RhdHVzID49IDMwMCB8fCBhdXRoVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1J1xuICAgICAgICAgICAgICAgIHx8IGF1dGhVcmwucGF0aG5hbWUgIT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAhL2FwcGxpY2F0aW9uXFwvanNvbi9pLnRlc3QoYXV0aC5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykgfHwgJycpKSB7XG4gICAgICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZmFpbHVyZShhdXRoLnN0YXR1cyA+PSA1MDAgPyAnbmV0d29yaycgOiAnYXV0aCcsICdQYW5lbDog0L3QtdGCINC00L7RgdGC0YPQv9CwINC6IEFQSS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHByb29mID0gYXdhaXQgYXV0aC5qc29uKCk7XG4gICAgICAgICAgICBpZiAoIXByb29mIHx8IHR5cGVvZiBwcm9vZiAhPT0gJ29iamVjdCcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgUGFuZWwgYXV0aCBwcm9vZicpO1xuICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0geyB0b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSB9O1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuIH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ25ldHdvcmsnLCAnUGFuZWw6INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/RgNC+0LLQtdGA0LjRgtGMINCy0YXQvtC0LiDQn9GA0L7QstC10YDRjNGC0LUg0YHQvtC10LTQuNC90LXQvdC40LUg0Lgg0L7RgtC60YDRi9GC0YPRjiDQstC60LvQsNC00LrRgyBwYW5lbC5oYXRpa28ucnUuJyk7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgaWYgKGZvcmNlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gZmxpZ2h0KSBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgfVxuICAgIH0pKCk7XG4gICAgaWYgKGZvcmNlKSBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBmbGlnaHQ7XG4gICAgZWxzZSBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBmbGlnaHQ7XG4gICAgcmV0dXJuIGZsaWdodC5wcm9taXNlO1xufVxuXG5mdW5jdGlvbiBnZXRQYW5lbFNlc3Npb24oZm9yY2UpIHtcbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgaWYgKGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAoZm9yY2UgJiYgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0KSB7XG4gICAgICAgIGNvbnN0IHF1ZXVlZCA9IHsgcHJvbWlzZTogbnVsbCB9O1xuICAgICAgICBxdWV1ZWQucHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTsgfVxuICAgICAgICAgICAgZmluYWxseSB7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gcXVldWVkKSBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0UGFuZWxTZXNzaW9uRmxpZ2h0KHRydWUpO1xuICAgICAgICB9KSgpO1xuICAgICAgICBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBxdWV1ZWQ7XG4gICAgICAgIHJldHVybiBxdWV1ZWQucHJvbWlzZTtcbiAgICB9XG4gICAgaWYgKCFmb3JjZSAmJiBwYW5lbFNlc3Npb24gJiYgRGF0ZS5ub3coKSAtIHBhbmVsU2Vzc2lvbi5zYXZlZEF0IDwgUEFORUxfU0VTU0lPTl9UVEwpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogdHJ1ZSwgdG9rZW46IHBhbmVsU2Vzc2lvbi50b2tlbiB9KTtcbiAgICBpZiAoIWZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodChmb3JjZSk7XG59XG4iLCIvLyBFeHRlbnNpb24tb3duZWQgcHJlc2VudGF0aW9uLiBObyBzaXRlIERPTSwgdG9rZW5zLCBvciBjb250ZW50LXRhYiBhdWRpby5cbmNvbnN0IE9SREVSX05PVElGSUNBVElPTl9JRCA9ICdtZW1jaGF0LW9yZGVycyc7XG5jb25zdCBPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZID0gJ21lbWNoYXQtb3JkZXItbm90aWZpY2F0aW9uLWV4cGlyZSc7XG5mdW5jdGlvbiBvcmRlckJlYXJJY29uKHNpemUpIHtcbiAgICBjb25zdCBjYW52YXMgPSBuZXcgT2Zmc2NyZWVuQ2FudmFzKHNpemUsIHNpemUpLCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKSwgcyA9IHNpemUgLyAzMjtcbiAgICBjb25zdCBvdmFsID0gKHgsIHksIHJ4LCByeSwgY29sb3IpID0+IHsgY3R4LmZpbGxTdHlsZSA9IGNvbG9yOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5lbGxpcHNlKHggKiBzLCB5ICogcywgcnggKiBzLCByeSAqIHMsIDAsIDAsIE1hdGguUEkgKiAyKTsgY3R4LmZpbGwoKTsgfTtcbiAgICBvdmFsKDcsIDcsIDYsIDYsICcjNzEzZjJhJyk7IG92YWwoMjUsIDcsIDYsIDYsICcjNzEzZjJhJyk7XG4gICAgb3ZhbCg3LCA3LCAzLCAzLCAnI2Q4YWE3OCcpOyBvdmFsKDI1LCA3LCAzLCAzLCAnI2Q4YWE3OCcpO1xuICAgIG92YWwoMTYsIDE4LCAxNCwgMTMsICcjOTg2MjNiJyk7XG4gICAgb3ZhbCgxNiwgMjQsIDgsIDYsICcjZWRjOTliJyk7XG4gICAgb3ZhbCgxMCwgMTcsIDIsIDIuNSwgJyMyMzE1MGUnKTsgb3ZhbCgyMiwgMTcsIDIsIDIuNSwgJyMyMzE1MGUnKTtcbiAgICBvdmFsKDE2LCAyMiwgMywgMiwgJyMyMzE1MGUnKTsgb3ZhbCgxNiwgMjYsIDIsIDEsICcjNzEzZjJhJyk7XG4gICAgcmV0dXJuIGN0eC5nZXRJbWFnZURhdGEoMCwgMCwgc2l6ZSwgc2l6ZSk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclVwZGF0ZUljb24oKSB7XG4gICAgaWYgKCFjaHJvbWUuYWN0aW9uPy5zZXRJY29uKSByZXR1cm47XG4gICAgY29uc3QgZW5hYmxlZCA9IG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkID09PSB0cnVlO1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0SWNvbihlbmFibGVkID8geyBpbWFnZURhdGE6IHsgMTY6IG9yZGVyQmVhckljb24oMTYpLCAzMjogb3JkZXJCZWFySWNvbigzMikgfSB9IDogeyBwYXRoOiAnaWNvbi5wbmcnIH0pO1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoeyB0aXRsZTogZW5hYmxlZCA/ICfwn5C7INCe0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLQutC70Y7Rh9GR0L0gwrcg0J7RgtC60YDRi9GC0Ywg0LHQvtC60L7QstGD0Y4g0L/QsNC90LXQu9GMIE1lbWNoYXQnIDogJ9Ce0YLQutGA0YvRgtGMINCc0LXQvNGH0LDRgiDQsiDQsdC+0LrQvtCy0L7QuSDQv9Cw0L3QtdC70LgnIH0pO1xufVxubGV0IG9yZGVyQXVkaW9DcmVhdGluZyA9IG51bGw7XG5sZXQgb3JkZXJBdWRpb0dlbmVyYXRpb24gPSAwO1xuYXN5bmMgZnVuY3Rpb24gb3JkZXJTdG9wQXVkaW8oKSB7XG4gICAgb3JkZXJBdWRpb0dlbmVyYXRpb24rKztcbiAgICBpZiAoIWNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKSByZXR1cm47XG4gICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydPRkZTQ1JFRU5fRE9DVU1FTlQnXSwgZG9jdW1lbnRVcmxzOiBbY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpXSB9KTtcbiAgICBpZiAoY29udGV4dHMubGVuZ3RoKSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHRhcmdldDogJ21lbWNoYXQtb2Zmc2NyZWVuJywgdHlwZTogJ21lbWNoYXQ6YXVkaW8tc3RvcCcgfSk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlckVuc3VyZUF1ZGlvKCkge1xuICAgIGlmIChvcmRlckF1ZGlvQ3JlYXRpbmcpIHJldHVybiBvcmRlckF1ZGlvQ3JlYXRpbmc7XG4gICAgb3JkZXJBdWRpb0NyZWF0aW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgY29udGV4dHMgPSBhd2FpdCBjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cyh7IGNvbnRleHRUeXBlczogWydPRkZTQ1JFRU5fRE9DVU1FTlQnXSwgZG9jdW1lbnRVcmxzOiBbY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCdvZmZzY3JlZW4uaHRtbCcpXSB9KTtcbiAgICAgICAgaWYgKCFjb250ZXh0cy5sZW5ndGgpIGF3YWl0IGNocm9tZS5vZmZzY3JlZW4uY3JlYXRlRG9jdW1lbnQoeyB1cmw6ICdvZmZzY3JlZW4uaHRtbCcsIHJlYXNvbnM6IFsnQVVESU9fUExBWUJBQ0snXSwganVzdGlmaWNhdGlvbjogJ09uZSBzaGFyZWQgTWVtY2hhdCBvcmRlciBhbGFybSwgaW5kZXBlbmRlbnQgb2Ygb3BlbiBNb3lTa2xhZCB0YWJzLicgfSk7XG4gICAgfSkoKS5maW5hbGx5KCgpID0+IHsgb3JkZXJBdWRpb0NyZWF0aW5nID0gbnVsbDsgfSk7XG4gICAgcmV0dXJuIG9yZGVyQXVkaW9DcmVhdGluZztcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyUGxheUF1ZGlvKGlzQ3VycmVudCA9ICgpID0+IHRydWUpIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gb3JkZXJBdWRpb0dlbmVyYXRpb247XG4gICAgYXdhaXQgb3JkZXJFbnN1cmVBdWRpbygpO1xuICAgIGlmICghaXNDdXJyZW50KCkgfHwgZ2VuZXJhdGlvbiAhPT0gb3JkZXJBdWRpb0dlbmVyYXRpb24pIHJldHVybjtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdGFyZ2V0OiAnbWVtY2hhdC1vZmZzY3JlZW4nLCB0eXBlOiAnbWVtY2hhdDphdWRpby1wbGF5JyB9KTtcbiAgICBpZiAoIXJlc3BvbnNlPy5vaykgdGhyb3cgRXJyb3IoJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9Jyk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclByZXNlbnRSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIpIHtcbiAgICBjb25zdCBjdXJyZW50ID0gKCkgPT4gY29uZmlnID09PSBvcmRlckNvbmZpZyAmJiBjb25maWcuc2V0dGluZ3MuZW5hYmxlZCAmJiAhY29udHJvbGxlci5zaWduYWwuYWJvcnRlZDtcbiAgICBpZiAoIXJlc3VsdC5vcmRlcnMubGVuZ3RoIHx8ICFjdXJyZW50KCkpIHJldHVybiBbXTtcbiAgICBjb25zdCBub3RpZnkgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5nZXRQZXJtaXNzaW9uTGV2ZWwoKTtcbiAgICAgICAgaWYgKCFjdXJyZW50KCkpIHJldHVybjtcbiAgICAgICAgaWYgKHBlcm1pc3Npb24gIT09ICdncmFudGVkJykgdGhyb3cgRXJyb3IoJ9Cj0LLQtdC00L7QvNC70LXQvdC40Y8g0L7RgtC60LvRjtGH0LXQvdGLINCyINCx0YDQsNGD0LfQtdGA0LUnKTtcbiAgICAgICAgY29uc3Qgb3JkZXJzID0gcmVzdWx0Lm9yZGVycztcbiAgICAgICAgYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuY3JlYXRlKE9SREVSX05PVElGSUNBVElPTl9JRCwgeyB0eXBlOiAnYmFzaWMnLCBpY29uVXJsOiAnaWNvbi5wbmcnLFxuICAgICAgICAgICAgdGl0bGU6ICfwn5C7IE1lbWNoYXQgwrcg0JfQsNC60LDQt9GLOiAnICsgb3JkZXJzLmxlbmd0aCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IG9yZGVycy5zbGljZSgwLCAzKS5tYXAoaXRlbSA9PiBTdHJpbmcoaXRlbS5uYW1lKS5zbGljZSgwLCA4MCkgKyAnIMK3ICcgKyBTdHJpbmcoaXRlbS5vcmdhbml6YXRpb25OYW1lKS5zbGljZSgwLCA4MCkpLmpvaW4oJ1xcbicpICsgKHJlc3VsdC5wYXJ0aWFsID8gJ1xcbuKaoCDQntC/0YDQvtGBINC90LXQv9C+0LvQvdGL0LknIDogJycpLFxuICAgICAgICAgICAgcHJpb3JpdHk6IDAsIHNpbGVudDogdHJ1ZSwgcmVxdWlyZUludGVyYWN0aW9uOiBjb25maWcuc2V0dGluZ3MudG9hc3REdXJhdGlvbk1pbnV0ZXMgPT09IDAgfSk7XG4gICAgICAgIGlmICghY3VycmVudCgpKSB7IGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCk7IHJldHVybjsgfVxuICAgICAgICBpZiAoY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzID4gMCkgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSwgeyB3aGVuOiBEYXRlLm5vdygpICsgY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzICogNjAwMDAgfSk7XG4gICAgICAgIGVsc2UgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKTtcbiAgICB9O1xuICAgIGNvbnN0IHRhc2tzID0gW25vdGlmeSgpXTtcbiAgICBpZiAoY29uZmlnLnNldHRpbmdzLnNvdW5kRW5hYmxlZCkgdGFza3MucHVzaChvcmRlclBsYXlBdWRpbyhjdXJyZW50KSk7XG4gICAgY29uc3Qgb3V0Y29tZXMgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGFza3MpO1xuICAgIHJldHVybiBvdXRjb21lcy5mbGF0TWFwKChpdGVtLCBpbmRleCkgPT4gaXRlbS5zdGF0dXMgPT09ICdyZWplY3RlZCcgPyBbaW5kZXggPT09IDAgPyAn0KHQuNGB0YLQtdC80L3Ri9C1INGD0LLQtdC00L7QvNC70LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C90YsnIDogJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9J10gOiBbXSk7XG59XG5pZiAoY2hyb21lLm5vdGlmaWNhdGlvbnM/Lm9uQ2xpY2tlZCkgY2hyb21lLm5vdGlmaWNhdGlvbnMub25DbGlja2VkLmFkZExpc3RlbmVyKGlkID0+IHtcbiAgICBpZiAoaWQgIT09IE9SREVSX05PVElGSUNBVElPTl9JRCkgcmV0dXJuO1xuICAgIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogJ2h0dHBzOi8vb25saW5lLm1veXNrbGFkLnJ1L2FwcC8jY3VzdG9tZXJvcmRlcicsIGFjdGl2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoaWQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBjaHJvbWUuYWxhcm1zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkpLmNhdGNoKCgpID0+IHt9KTtcbn0pO1xuIiwiLy8gU2hhcmVkIG9yZGVyIHBvbGxpbmcgaXMgaW5kZXBlbmRlbnQgb2YgdGhlIGxpZmV0aW1lL251bWJlciBvZiBjb250ZW50IHRhYnMuXG4vLyBTZXNzaW9uIHN0b3JhZ2UgaXMgZXh0ZW5zaW9uLXByaXZhdGU7IGJlYXJlciBuZXZlciBlbnRlcnMgYSBicm9hZGNhc3Qgb3IgbG9ncy5cbmNvbnN0IE9SREVSX1NFU1NJT05fS0VZID0gJ21lbWNoYXRPcmRlclNlcnZpY2VfdjEnO1xubGV0IG9yZGVyQ29uZmlnID0gbnVsbDtcbmxldCBvcmRlclN1YnNjcmliZXJzID0gbmV3IFNldCgpO1xubGV0IG9yZGVyUmV2aXNpb24gPSAwO1xubGV0IG9yZGVyRmxpZ2h0ID0gbnVsbDtcbmxldCBvcmRlckNvbnRyb2xsZXIgPSBudWxsO1xubGV0IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG5sZXQgb3JkZXJDb25maWdDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gb3JkZXJNdXRhdGUoY2FsbGJhY2spIHtcbiAgICBjb25zdCBuZXh0ID0gb3JkZXJDb25maWdDaGFpbi50aGVuKGNhbGxiYWNrKTtcbiAgICBvcmRlckNvbmZpZ0NoYWluID0gbmV4dC5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIG5leHQ7XG59XG5jb25zdCBvcmRlclJlYWR5ID0gKGFzeW5jICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChPUkRFUl9TRVNTSU9OX0tFWSkpW09SREVSX1NFU1NJT05fS0VZXTtcbiAgICAgICAgaWYgKHNhdmVkKSB7IG9yZGVyQ29uZmlnID0gc2F2ZWQuY29uZmlnOyBvcmRlclJldmlzaW9uID0gc2F2ZWQucmV2aXNpb24gfHwgMDsgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoc2F2ZWQuc3Vic2NyaWJlcnMgfHwgW10pOyB9XG4gICAgICAgIGF3YWl0IG9yZGVyVXBkYXRlSWNvbigpO1xuICAgIH0gY2F0Y2ggeyAvKiBDb25maWd1cmUgbXVzdCBzdWNjZXNzZnVsbHkgcGVyc2lzdCBiZWZvcmUgZW5hYmxpbmcgcG9sbGluZy4gKi8gfVxufSkoKTtcbmZ1bmN0aW9uIG9yZGVyUHVibGljQ29uZmlnKCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzZXR0aW5nczogb3JkZXJDb25maWc/LnNldHRpbmdzLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiB9O1xufVxuZnVuY3Rpb24gb3JkZXJSZWZlcmVuY2UodmFsdWUsIGtpbmQpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiBuZXcgUmVnRXhwKCdeaHR0cHM6Ly9hcGlcXFxcLm1veXNrbGFkXFxcXC5ydS9hcGkvcmVtYXAvMVxcXFwuMi9lbnRpdHkvJyArIGtpbmQgKyAnL1tBLVphLXowLTktXSskJykudGVzdCh2YWx1ZSk7XG59XG5mdW5jdGlvbiBvcmRlclNldHRpbmdzKHJhdykge1xuICAgIGNvbnN0IHJlZnMgPSAodmFsdWVzLCBraW5kKSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZXMpIHx8ICF2YWx1ZXMuZXZlcnkodmFsdWUgPT4gb3JkZXJSZWZlcmVuY2UodmFsdWUsIGtpbmQpKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgcmVmZXJlbmNlcycpO1xuICAgICAgICByZXR1cm4gWy4uLm5ldyBTZXQodmFsdWVzKV07XG4gICAgfTtcbiAgICByZXR1cm4geyBlbmFibGVkOiByYXc/LmVuYWJsZWQgIT09IGZhbHNlLCBzb3VuZEVuYWJsZWQ6IHJhdz8uc291bmRFbmFibGVkICE9PSBmYWxzZSxcbiAgICAgICAgaW50ZXJ2YWxNaW51dGVzOiBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKE51bWJlcihyYXc/LmludGVydmFsTWludXRlcykgfHwgMSkpKSxcbiAgICAgICAgdG9hc3REdXJhdGlvbk1pbnV0ZXM6IE1hdGgubWluKDE0NDAsIE1hdGgubWF4KDAsIE1hdGgucm91bmQoTnVtYmVyKHJhdz8udG9hc3REdXJhdGlvbk1pbnV0ZXMpIHx8IDApKSksXG4gICAgICAgIG9yZ2FuaXphdGlvbkhyZWZzOiByZWZzKHJhdz8ub3JnYW5pemF0aW9uSHJlZnMsICdvcmdhbml6YXRpb24nKSxcbiAgICAgICAgc3RhdHVzSHJlZnM6IHJlZnMocmF3Py5zdGF0dXNIcmVmcywgJ2N1c3RvbWVyb3JkZXIvbWV0YWRhdGEvc3RhdGVzJykgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyU2V0QWxhcm0oKSB7XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCB8fCAhb3JkZXJDb25maWcuc2V0dGluZ3Muc291bmRFbmFibGVkKSBhd2FpdCBvcmRlclN0b3BBdWRpbygpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBpZiAoIW9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkICYmIGNocm9tZS5ub3RpZmljYXRpb25zPy5jbGVhcikgYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0lEKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgLy8gVG9vbGJhciBwcmVzZW50YXRpb24gbXVzdCBuZXZlciBwcmV2ZW50IHNjaGVkdWxpbmcgb3IgcGF1c2luZyB0aGUgc2VydmljZS5cbiAgICBhd2FpdCBvcmRlclVwZGF0ZUljb24oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKCFjaHJvbWUuYWxhcm1zKSByZXR1cm47XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCkgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKTtcbiAgICBpZiAob3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgJiYgb3JkZXJDb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWxhcm1zLmNyZWF0ZSgnbWVtY2hhdC1vcmRlcnMnLCB7IHBlcmlvZEluTWludXRlczogb3JkZXJDb25maWcuc2V0dGluZ3MuaW50ZXJ2YWxNaW51dGVzIH0pO1xuICAgIH0gZWxzZSBhd2FpdCBjaHJvbWUuYWxhcm1zLmNsZWFyKCdtZW1jaGF0LW9yZGVycycpO1xufVxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlT3JkZXJzKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgaWYgKHR5cGVvZiBtZXNzYWdlLnRva2VuICE9PSAnc3RyaW5nJyB8fCAhbWVzc2FnZS50b2tlbi50cmltKCkgfHwgbWVzc2FnZS50b2tlbi5sZW5ndGggPiA0MDk2KSB0aHJvdyBFcnJvcignSW52YWxpZCB0b2tlbicpO1xuICAgIGNvbnN0IHNldHRpbmdzID0gb3JkZXJTZXR0aW5ncyhtZXNzYWdlLnNldHRpbmdzKTtcbiAgICBjb25zdCB1bmNoYW5nZWQgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gJiYgSlNPTi5zdHJpbmdpZnkob3JkZXJDb25maWcuc2V0dGluZ3MpID09PSBKU09OLnN0cmluZ2lmeShzZXR0aW5ncyk7XG4gICAgaWYgKG9yZGVyQ29uZmlnICYmIChtZXNzYWdlLnVwZGF0ZSAhPT0gdHJ1ZSB8fCB1bmNoYW5nZWQpKSB7XG4gICAgICAgIGlmIChvcmRlckNvbmZpZy50b2tlbiAhPT0gbWVzc2FnZS50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiwgZXJyb3I6ICfQlNGA0YPQs9C+0LkgQmVhcmVyINCyINGE0L7QvdC1LiDQodC+0YXRgNCw0L3QuNGC0LUg0L3QsNGB0YLRgNC+0LnQutC4INGP0LLQvdC+INC00LvRjyDRgdC80LXQvdGLINCw0LrQutCw0YPQvdGC0LAuJyB9O1xuICAgICAgICBvcmRlclN1YnNjcmliZXJzLmFkZChzZW5kZXIudGFiLmlkKTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgIGlmIChjaHJvbWUuYWxhcm1zPy5nZXQgJiYgIShhd2FpdCBjaHJvbWUuYWxhcm1zLmdldCgnbWVtY2hhdC1vcmRlcnMnKSkpIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgcmV0dXJuIHsgLi4ub3JkZXJQdWJsaWNDb25maWcoKSwgcG9sbFJlcXVpcmVkOiBmYWxzZSB9O1xuICAgIH1cbiAgICBpZiAob3JkZXJDb25maWcgJiYgbWVzc2FnZS5yZXZpc2lvbiAhPT0gb3JkZXJSZXZpc2lvbikgcmV0dXJuIHsgLi4ub3JkZXJQdWJsaWNDb25maWcoKSwgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgZXJyb3I6ICfQndCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiyDQsiDQtNGA0YPQs9C+0Lkg0LLQutC70LDQtNC60LUuINCf0L7QstGC0L7RgNC40YLQtSDQuNC30LzQtdC90LXQvdC40LUuJyB9O1xuICAgIGNvbnN0IHN1YnNjcmliZXJzID0gb3JkZXJDb25maWc/LnRva2VuID09PSBtZXNzYWdlLnRva2VuID8gbmV3IFNldChvcmRlclN1YnNjcmliZXJzKSA6IG5ldyBTZXQoKTtcbiAgICBzdWJzY3JpYmVycy5hZGQoc2VuZGVyLnRhYi5pZCk7XG4gICAgY29uc3QgY29uZmlnID0geyB0b2tlbjogbWVzc2FnZS50b2tlbiwgc2V0dGluZ3MsIG9yZ2FuaXphdGlvbnM6IChBcnJheS5pc0FycmF5KG1lc3NhZ2Uub3JnYW5pemF0aW9ucykgPyBtZXNzYWdlLm9yZ2FuaXphdGlvbnMgOiBbXSlcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IHNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmluY2x1ZGVzKGl0ZW0/LmhyZWYpKS5tYXAoaXRlbSA9PiAoeyBocmVmOiBpdGVtLmhyZWYsIG5hbWU6IFN0cmluZyhpdGVtLm5hbWUgfHwgJycpLnNsaWNlKDAsIDMwMCkgfSkpIH07XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gKyAxLCBzdWJzY3JpYmVyczogWy4uLnN1YnNjcmliZXJzXSB9IH0pO1xuICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICBvcmRlckNvbmZpZyA9IGNvbmZpZzsgb3JkZXJTdWJzY3JpYmVycyA9IHN1YnNjcmliZXJzOyBvcmRlclJldmlzaW9uKys7IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG4gICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIHBvbGxSZXF1aXJlZDogdHJ1ZSB9O1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJHZXQocGF0aCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwZXJmb3JtUmVxdWVzdCh7IGlkOiAnYmFja2dyb3VuZC1vcmRlcnMnLCByZXF1ZXN0OiB7XG4gICAgICAgIHVybDogJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjInICsgcGF0aCwgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiAnQmVhcmVyICcgKyBjb25maWcudG9rZW4sIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfSxcbiAgICAgICAgYW5vbnltb3VzOiB0cnVlLCBiYWNrZ3JvdW5kT3JkZXI6IHRydWVcbiAgICB9IH0sIHsgdGFiOiB7IGlkOiAtMSB9LCBmcmFtZUlkOiAwIH0sIGNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSB0aHJvdyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgaWYgKHJlc3BvbnNlLmV2ZW50ICE9PSAnbG9hZCcpIHRocm93IEVycm9yKCfQntGI0LjQsdC60LAg0YHQvtC10LTQuNC90LXQvdC40Y8g0YEg0JzQvtC50KHQutC70LDQtCcpO1xuICAgIGNvbnN0IHN0YXR1cyA9IHJlc3BvbnNlLnJlc3BvbnNlLnN0YXR1cztcbiAgICBpZiAoc3RhdHVzIDwgMjAwIHx8IHN0YXR1cyA+PSAzMDApIHsgY29uc3QgZXJyb3IgPSBFcnJvcign0JzQvtC50KHQutC70LDQtDogSFRUUCAnICsgc3RhdHVzKTsgZXJyb3Iuc3RhdHVzID0gc3RhdHVzOyB0aHJvdyBlcnJvcjsgfVxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7IGRhdGEgPSBKU09OLnBhcnNlKHJlc3BvbnNlLnJlc3BvbnNlLnJlc3BvbnNlVGV4dCk7IH0gY2F0Y2ggeyB0aHJvdyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INC+0YLQstC10YIg0JzQvtC50KHQutC70LDQtCcpOyB9XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGE/LnJvd3MpKSB0aHJvdyBFcnJvcign0J3QtdC/0L7Qu9C90YvQuSDQvtGC0LLQtdGCINGB0L/QuNGB0LrQsCDQt9Cw0LrQsNC30L7QsicpO1xuICAgIHJldHVybiBkYXRhO1xufVxuYXN5bmMgZnVuY3Rpb24gZGVsaXZlck9yZGVyUmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyLCByZXZpc2lvbikge1xuICAgIGlmICghY2hyb21lLnRhYnM/LnF1ZXJ5KSByZXR1cm47XG4gICAgY29uc3QgdGFicyA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHt9KTtcbiAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHRhYnMuZmlsdGVyKHRhYiA9PiBvcmRlclN1YnNjcmliZXJzLmhhcyh0YWIuaWQpICYmIHRydXN0ZWRDb250ZW50U2VuZGVyKHsgaWQ6IGNocm9tZS5ydW50aW1lLmlkLCB0YWIsIGZyYW1lSWQ6IDAsIHVybDogdGFiLnVybCB9KSk7XG4gICAgY2FuZGlkYXRlcy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoISFiLmFjdGl2ZSkgLSBOdW1iZXIoISFhLmFjdGl2ZSkpO1xuICAgIGZvciAoY29uc3QgdGFiIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICAgICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBhY2sgPSBhd2FpdCBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXJlc3VsdCcsIHJlc3VsdCwgcmV2aXNpb24sIHNldHRpbmdzOiBjb25maWcuc2V0dGluZ3MgfSwgeyBmcmFtZUlkOiAwIH0pO1xuICAgICAgICAgICAgaWYgKGFjaz8ub2spIGJyZWFrO1xuICAgICAgICB9IGNhdGNoIHsgLyogVHJ5IGFub3RoZXIgbGl2ZSBjb250ZW50IHdvcmxkLCBub3QgZXZlcnkgdGFiLiAqLyB9XG4gICAgfVxufVxuYXN5bmMgZnVuY3Rpb24gcG9sbE9yZGVycygpIHtcbiAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgIGF3YWl0IG9yZGVyQ29uZmlnQ2hhaW47XG4gICAgaWYgKG9yZGVyRmxpZ2h0KSByZXR1cm4gb3JkZXJGbGlnaHQ7XG4gICAgY29uc3QgY29uZmlnID0gb3JkZXJDb25maWc7XG4gICAgaWYgKCFjb25maWc/LnNldHRpbmdzLmVuYWJsZWQgfHwgIWNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggfHwgIWNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0YvQutC70Y7Rh9C10L0g0LjQu9C4INC90LUg0L3QsNGB0YLRgNC+0LXQvScgfTtcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCByZXZpc2lvbiA9IG9yZGVyUmV2aXNpb247XG4gICAgICAgIG9yZGVyQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XG4gICAgb3JkZXJGbGlnaHQgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBmb3VuZCA9IG5ldyBNYXAoKSwgZmFpbGVkID0gW107XG4gICAgICAgIGxldCBhdXRoRmFpbGVkID0gZmFsc2U7XG4gICAgICAgIGZvciAoY29uc3QgaHJlZiBvZiBjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMpIHtcbiAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gY29uZmlnLm9yZ2FuaXphdGlvbnMuZmluZChpdGVtID0+IGl0ZW0uaHJlZiA9PT0gaHJlZik/Lm5hbWUgfHwgJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAnO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByb3dzID0gbmV3IE1hcCgpO1xuICAgICAgICAgICAgICAgIGxldCBvZmZzZXQgPSAwO1xuICAgICAgICAgICAgICAgIGZvciAoOzspIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZmlsdGVyID0gWydvcmdhbml6YXRpb249JyArIGhyZWYsIC4uLmNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5tYXAoc3RhdGUgPT4gJ3N0YXRlPScgKyBzdGF0ZSldLmpvaW4oJzsnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG9yZGVyR2V0KCcvZW50aXR5L2N1c3RvbWVyb3JkZXI/ZmlsdGVyPScgKyBlbmNvZGVVUklDb21wb25lbnQoZmlsdGVyKVxuICAgICAgICAgICAgICAgICAgICAgICAgKyAnJmV4cGFuZD1zdGF0ZSxvcmdhbml6YXRpb24mb3JkZXI9bW9tZW50LGRlc2MmbGltaXQ9MTAwJm9mZnNldD0nICsgb2Zmc2V0LCBjb25maWcsIGNvbnRyb2xsZXIpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IHJvd3Muc2l6ZTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2YgZGF0YS5yb3dzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIXJvdz8uaWQpIHRocm93IEVycm9yKCfQl9Cw0LrQsNC3INCx0LXQtyDQuNC00LXQvdGC0LjRhNC40LrQsNGC0L7RgNCwJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dzLnNldChyb3cuaWQsIHJvdyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgb2Zmc2V0ICs9IGRhdGEucm93cy5sZW5ndGg7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1vcmUgPSAhIWRhdGEubWV0YT8ubmV4dEhyZWYgfHwgKE51bWJlci5pc0Zpbml0ZShkYXRhLm1ldGE/LnNpemUpID8gb2Zmc2V0IDwgZGF0YS5tZXRhLnNpemUgOiBkYXRhLnJvd3MubGVuZ3RoID49IDEwMCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghbW9yZSkgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZGF0YS5yb3dzLmxlbmd0aCB8fCByb3dzLnNpemUgPT09IHByZXZpb3VzKSB0aHJvdyBFcnJvcign0J/QsNCz0LjQvdCw0YbQuNGPINC30LDQutCw0LfQvtCyINC90LUg0L/RgNC+0LTQstC40LPQsNC10YLRgdGPJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZvciAoY29uc3Qgcm93IG9mIHJvd3MudmFsdWVzKCkpIGlmIChjb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMuaW5jbHVkZXMocm93LnN0YXRlPy5tZXRhPy5ocmVmKSkge1xuICAgICAgICAgICAgICAgICAgICBmb3VuZC5zZXQocm93LmlkLCB7IGlkOiByb3cuaWQsIG5hbWU6IHJvdy5uYW1lIHx8IHJvdy5pZCwgc3RhdGVOYW1lOiByb3cuc3RhdGU/Lm5hbWUgfHwgJ9Cd0L7QstGL0LknLCBvcmdhbml6YXRpb25OYW1lOiBsYWJlbCwgb3JnYW5pemF0aW9uSHJlZjogaHJlZiB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9OiDQvdCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiycgfTtcbiAgICAgICAgICAgICAgICBmYWlsZWQucHVzaChsYWJlbCArICcg4oCUICcgKyAoZXJyb3IubWVzc2FnZSB8fCAn0J7RiNC40LHQutCwINC30LDQv9GA0L7RgdCwJykpO1xuICAgICAgICAgICAgICAgIGlmIChbNDAxLCA0MDNdLmluY2x1ZGVzKGVycm9yLnN0YXR1cykpIHsgYXV0aEZhaWxlZCA9IHRydWU7IGJyZWFrOyB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L0nIH07XG4gICAgICAgIGlmIChhdXRoRmFpbGVkKSB7XG4gICAgICAgICAgICBhd2FpdCBvcmRlck11dGF0ZShhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGNvbmZpZy5zZXR0aW5ncy5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZywgcmV2aXNpb246ICsrb3JkZXJSZXZpc2lvbiwgc3Vic2NyaWJlcnM6IFsuLi5vcmRlclN1YnNjcmliZXJzXSB9IH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9JyB9O1xuICAgICAgICBjb25zdCByZXN1bHQgPSB7IGlkOiBTdHJpbmcoRGF0ZS5ub3coKSkgKyAnLScgKyBvcmRlclJldmlzaW9uLCBvcmRlcnM6IFsuLi5mb3VuZC52YWx1ZXMoKV0sIGZhaWxlZCwgcGFydGlhbDogZmFpbGVkLmxlbmd0aCA+IDAsXG4gICAgICAgICAgICBiZWFyZXI6IGF1dGhGYWlsZWQgPyAnZXJyb3InIDogZmFpbGVkLmxlbmd0aCA9PT0gY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCA/ICd1bmtub3duJyA6ICdvaycsIGF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgIHJlc3VsdC5vcmRlcnMuZm9yRWFjaChvcmRlciA9PiB7IG9yZGVyLnBhcnRpYWwgPSByZXN1bHQucGFydGlhbDsgfSk7XG4gICAgICAgIG9yZGVyTGFzdFJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgcmVzdWx0LmFsZXJ0V2FybmluZ3MgPSBhd2FpdCBvcmRlclByZXNlbnRSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIpO1xuICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvTog0L3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90YsnIH07XG4gICAgICAgIGF3YWl0IGRlbGl2ZXJPcmRlclJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlciwgcmV2aXNpb24pO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcmVzdWx0IH07XG4gICAgfSkoKS5maW5hbGx5KCgpID0+IHsgb3JkZXJGbGlnaHQgPSBudWxsOyBpZiAob3JkZXJDb250cm9sbGVyID09PSBjb250cm9sbGVyKSBvcmRlckNvbnRyb2xsZXIgPSBudWxsOyB9KTtcbiAgICByZXR1cm4gb3JkZXJGbGlnaHQ7XG59XG5pZiAoY2hyb21lLmFsYXJtcykgY2hyb21lLmFsYXJtcy5vbkFsYXJtLmFkZExpc3RlbmVyKGFsYXJtID0+IHtcbiAgICBpZiAoYWxhcm0ubmFtZSA9PT0gT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSkgcmV0dXJuIGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmIChhbGFybS5uYW1lID09PSAnbWVtY2hhdC1vcmRlcnMnKSByZXR1cm4gcG9sbE9yZGVycygpLmNhdGNoKCgpID0+IHt9KTtcbn0pO1xuIiwiLy8gUHJpdmF0ZSBuYXRpdmUtdmlldyBjaGFubmVsLiBOZXZlciBicm9hZGNhc3QgdmlldyBkYXRhOiByZXBsaWVzIGdvIG9ubHkgdG8gdGhlXG4vLyBleGFjdCByZXF1ZXN0aW5nIG5hdGl2ZSBwYW5lbC4gU2l0ZS9hY2NvdW50IHN0YXRlIHN0YXlzIGluIGl0cyBjb250ZW50IHdvcmxkLlxuY29uc3QgU0lERUJBUl9GRUFUVVJFUyA9IE9iamVjdC5mcmVlemUoWydjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLCAndG9kYXknLCAndG9tb3Jyb3cnLFxuICAgICdjYWxjdWxhdG9yJywgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJywgJ2hhY2tlcicsICdzZXR0aW5ncyddKTtcbmFzeW5jIGZ1bmN0aW9uIHNpZGViYXJEaXNwYXRjaChtZXNzYWdlKSB7XG4gICAgY29uc3QgW3RhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgd2luZG93SWQ6IG1lc3NhZ2Uud2luZG93SWQgfSk7XG4gICAgaWYgKCFzdXBwb3J0ZWRBY3Rpb25UYWIodGFiKSkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICd1bnN1cHBvcnRlZCcgfTtcbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWNvbW1hbmQnICYmIHRhYi5pZCAhPT0gbWVzc2FnZS50YWJJZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIGNvbnN0IGNvbW1hbmQgPSBtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnNpZGViYXItc3RhdHVzJ1xuICAgICAgICA/IHsgdHlwZTogJ21lbWNoYXQ6ZmVhdHVyZS1zdGF0dXMnIH0gOiB7IHR5cGU6ICdtZW1jaGF0Om9wZW4tZmVhdHVyZScsIGZlYXR1cmU6IG1lc3NhZ2UuZmVhdHVyZSB9O1xuICAgIGxldCByZXBseTtcbiAgICB0cnkgeyByZXBseSA9IGF3YWl0IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgY29tbWFuZCwgeyBmcmFtZUlkOiAwIH0pOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ21pc3NpbmcnIH07IH1cbiAgICBpZiAoIXJlcGx5Py5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFsnc3RvcmFnZScsICdjb25mbGljdCddLmluY2x1ZGVzKHJlcGx5Py5yZWFzb24pID8gcmVwbHkucmVhc29uIDogJ2ZhaWxlZCcgfTtcbiAgICAvLyBOZXZlciBmb3J3YXJkIGFuIGFyYml0cmFyeSBjb250ZW50IHJlcGx5LCB0YWIgdGl0bGUsIFVSTCBwYXRoL3F1ZXJ5IG9yIHBlcnNpc3RlZCBkYXRhLlxuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0YWJJZDogdGFiLmlkLCBob3N0OiBuZXcgVVJMKHRhYi51cmwpLmhvc3RuYW1lIH07XG59XG5hc3luYyBmdW5jdGlvbiBzaWRlYmFyVmlld0Rpc3BhdGNoKG1lc3NhZ2UpIHtcbiAgICBjb25zdCBbdGFiXSA9IGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCB3aW5kb3dJZDogbWVzc2FnZS53aW5kb3dJZCB9KTtcbiAgICBpZiAoIXN1cHBvcnRlZEFjdGlvblRhYih0YWIpKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ3Vuc3VwcG9ydGVkJyB9O1xuICAgIGlmIChtZXNzYWdlLnRhYklkICE9PSB1bmRlZmluZWQgJiYgdGFiLmlkICE9PSBtZXNzYWdlLnRhYklkKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2NoYW5nZWQnIH07XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci12aWV3J1xuICAgICAgICA/IHsgdHlwZTogJ21lbWNoYXQ6dmlldy1zbmFwc2hvdCcgfVxuICAgICAgICA6IHsgdHlwZTogJ21lbWNoYXQ6dmlldy1ldmVudCcsIGRvY3VtZW50VG9rZW46IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbixcbiAgICAgICAgICAgIGtleTogbWVzc2FnZS5rZXksIGV2ZW50OiBtZXNzYWdlLmV2ZW50LCB2YWx1ZTogbWVzc2FnZS52YWx1ZSxcbiAgICAgICAgICAgIGNoZWNrZWQ6IG1lc3NhZ2UuY2hlY2tlZCwgc2VsZWN0ZWQ6IG1lc3NhZ2Uuc2VsZWN0ZWQgfTtcbiAgICBsZXQgdmlldztcbiAgICB0cnkgeyB2aWV3ID0gYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCByZXF1ZXN0LCB7IGZyYW1lSWQ6IDAgfSk7IH1cbiAgICBjYXRjaCB7IHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnbWlzc2luZycgfTsgfVxuICAgIGNvbnN0IFthY3RpdmVdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIHdpbmRvd0lkOiBtZXNzYWdlLndpbmRvd0lkIH0pO1xuICAgIGlmIChhY3RpdmU/LmlkICE9PSB0YWIuaWQgfHwgYWN0aXZlLnVybCAhPT0gdGFiLnVybCkgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdjaGFuZ2VkJyB9O1xuICAgIGlmICghdmlldz8ub2spIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBbJ3N0b3JhZ2UnLCAnY29uZmxpY3QnLCAnY2hhbmdlZCddLmluY2x1ZGVzKHZpZXc/LnJlYXNvbikgPyB2aWV3LnJlYXNvbiA6ICdmYWlsZWQnIH07XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHRhYklkOiB0YWIuaWQsIGhvc3Q6IG5ldyBVUkwodGFiLnVybCkuaG9zdG5hbWUsIHZpZXcgfTtcbn1cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZSwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICBpZiAoIVsnbWVtY2hhdDpzaWRlYmFyLXN0YXR1cycsICdtZW1jaGF0OnNpZGViYXItY29tbWFuZCcsICdtZW1jaGF0OnNpZGViYXItdmlldycsICdtZW1jaGF0OnNpZGViYXItZXZlbnQnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWIgfHwgKHNlbmRlci5mcmFtZUlkICE9PSB1bmRlZmluZWQgJiYgc2VuZGVyLmZyYW1lSWQgIT09IDApXG4gICAgICAgIHx8IHNlbmRlci51cmwgIT09IGNocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKSArICcjc2lkZWJhcidcbiAgICAgICAgfHwgIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS53aW5kb3dJZCkgfHwgbWVzc2FnZS53aW5kb3dJZCA8IDBcbiAgICAgICAgfHwgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c2lkZWJhci1jb21tYW5kJyAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDBcbiAgICAgICAgICAgIHx8ICFTSURFQkFSX0ZFQVRVUkVTLmluY2x1ZGVzKG1lc3NhZ2UuZmVhdHVyZSkpKVxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLXZpZXcnICYmIG1lc3NhZ2UudGFiSWQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDApKVxuICAgICAgICB8fCAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzaWRlYmFyLWV2ZW50JyAmJiAoIU51bWJlci5pc0ludGVnZXIobWVzc2FnZS50YWJJZCkgfHwgbWVzc2FnZS50YWJJZCA8IDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmRvY3VtZW50VG9rZW4gIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2UuZG9jdW1lbnRUb2tlbi5sZW5ndGggPiAxMDBcbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZXNzYWdlLmtleSAhPT0gJ3N0cmluZycgfHwgIS9eXFxkezEsOH0kLy50ZXN0KG1lc3NhZ2Uua2V5KVxuICAgICAgICAgICAgfHwgIVsnY2xpY2snLCAnaW5wdXQnLCAnY2hhbmdlJywgJ2VudGVyJ10uaW5jbHVkZXMobWVzc2FnZS5ldmVudCkpKSkge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ2ludmFsaWQnIH0pOyByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIChbJ21lbWNoYXQ6c2lkZWJhci12aWV3JywgJ21lbWNoYXQ6c2lkZWJhci1ldmVudCddLmluY2x1ZGVzKG1lc3NhZ2UudHlwZSlcbiAgICAgICAgPyBzaWRlYmFyVmlld0Rpc3BhdGNoKG1lc3NhZ2UpIDogc2lkZWJhckRpc3BhdGNoKG1lc3NhZ2UpKS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCByZWFzb246ICdmYWlsZWQnIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn0pO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy10ZXN0LXNvdW5kJykge1xuICAgICAgICBpZiAoIXRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIG9yZGVyUGxheUF1ZGlvKCkudGhlbigoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LLRg9C6INGA0LDRgdGI0LjRgNC10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QtdC9JyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2UtaW5pdCcsICdtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnLCAnbWVtY2hhdDpzdG9yYWdlLXJlc3RvcmUnLCAnbWVtY2hhdDpzdG9yYWdlLXBydW5lJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCF0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YXRgNCw0L3QuNC70LjRidCwINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgcHJpdmF0ZVN0b3JhZ2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JTQsNC90L3Ri9C1INC90LUg0L/QvtC00YLQstC10YDQttC00LXQvdGLINGF0YDQsNC90LjQu9C40YnQtdC8LiDQndC1INC30LDQutGA0YvQstCw0LnRgtC1INC4INC90LUg0L/QtdGA0LXQt9Cw0LPRgNGD0LbQsNC50YLQtSDQstC60LvQsNC00LrRgy4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChbJ21lbWNoYXQ6b3JkZXJzLWNvbmZpZ3VyZScsICdtZW1jaGF0Om9yZGVycy1wb2xsJywgJ21lbWNoYXQ6b3JkZXJzLXN0b3AnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBpZiAoIXRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgIGNvbnN0IHdvcmsgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLWNvbmZpZ3VyZScpIHJldHVybiBvcmRlck11dGF0ZSgoKSA9PiBjb25maWd1cmVPcmRlcnMobWVzc2FnZSwgc2VuZGVyKSk7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtc3RvcCcpIHJldHVybiBvcmRlck11dGF0ZShhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFvcmRlckNvbmZpZyB8fCBtZXNzYWdlLnRva2VuICE9PSBvcmRlckNvbmZpZy50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ0JlYXJlciDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDRhNC+0L3QvtCy0YvQvCDQvtC/0YDQvtGB0L7QvCcgfTtcbiAgICAgICAgICAgICAgICBvcmRlckNvbnRyb2xsZXI/LmFib3J0KCk7XG4gICAgICAgICAgICAgICAgb3JkZXJDb25maWcuc2V0dGluZ3MuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWc6IG9yZGVyQ29uZmlnLCByZXZpc2lvbjogKytvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICAgICAgICAgIHJldHVybiBvcmRlclB1YmxpY0NvbmZpZygpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBhd2FpdCBvcmRlckNvbmZpZ0NoYWluO1xuICAgICAgICAgICAgaWYgKCFvcmRlckNvbmZpZyB8fCBtZXNzYWdlLnRva2VuICE9PSBvcmRlckNvbmZpZy50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ0JlYXJlciDQvdC1INGB0L7QstC/0LDQtNCw0LXRgiDRgSDRhNC+0L3QvtCy0YvQvCDQvtC/0YDQvtGB0L7QvCcgfTtcbiAgICAgICAgICAgIHJldHVybiBwb2xsT3JkZXJzKCk7XG4gICAgICAgIH07XG4gICAgICAgIHdvcmsoKS50aGVuKHNlbmRSZXNwb25zZSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0L3QsNGB0YLRgNC+0LjRgtGMINGE0L7QvdC+0LLRi9C5INC+0L/RgNC+0YEnIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAnbWVtY2hhdDpwYW5lbC1jc3JmJykge1xuICAgICAgICBpZiAoIXRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgKG1lc3NhZ2UuZm9yY2UgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgbWVzc2FnZS5mb3JjZSAhPT0gJ2Jvb2xlYW4nKSkge1xuICAgICAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBnZXRQYW5lbFNlc3Npb24obWVzc2FnZS5mb3JjZSA9PT0gdHJ1ZSkudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAnUGFuZWw6INGE0L7QvdC+0LLQsNGPINGB0LXRgdGB0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsC4nIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmICghWydtZW1jaGF0Omh0dHAnLCAnbWVtY2hhdDphYm9ydCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCF0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IHR5cGVvZiBtZXNzYWdlLmlkICE9PSAnc3RyaW5nJyB8fCAhL15bYS16QS1aMC05LV17MSw4MH0kLy50ZXN0KG1lc3NhZ2UuaWQpKSB7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjyDQvtGC0LrQu9C+0L3RkdC9JyB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDphYm9ydCcpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSBwZW5kaW5nUmVxdWVzdHMuZ2V0KHJlcXVlc3RLZXkoc2VuZGVyLCBtZXNzYWdlLmlkKSk7XG4gICAgICAgIGlmIChlbnRyeSkgeyBlbnRyeS5ldmVudCA9ICdhYm9ydCc7IGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTsgfVxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBwZXJmb3JtUmVxdWVzdChtZXNzYWdlLCBzZW5kZXIpLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdC5ldmVudCA9PT0gJ2xvYWQnICYmIFs0MDEsIDQwMywgNDE5XS5pbmNsdWRlcyhyZXN1bHQucmVzcG9uc2U/LnN0YXR1cylcbiAgICAgICAgICAgICYmIG5ldyBVUkwobWVzc2FnZS5yZXF1ZXN0LnVybCkub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnKSB7XG4gICAgICAgICAgICBjb25zdCBzZW50VG9rZW4gPSBuZXcgSGVhZGVycyhtZXNzYWdlLnJlcXVlc3QuaGVhZGVycyB8fCB7fSkuZ2V0KCd4LWNzcmYtdG9rZW4nKTtcbiAgICAgICAgICAgIGlmIChzZW50VG9rZW4gJiYgc2VudFRva2VuID09PSBwYW5lbFNlc3Npb24/LnRva2VuKSB7XG4gICAgICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgICAgICAgICByZXN1bHQucGFuZWxBdXRoTG9zdCA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHJlc3VsdCk7XG4gICAgfSwgKCkgPT4gc2VuZFJlc3BvbnNlKHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAn0J3QtdC00L7Qv9GD0YHRgtC40LzRi9C5INC30LDQv9GA0L7RgSDRgNCw0YHRiNC40YDQtdC90LjRjycgfSkpO1xuICAgIHJldHVybiB0cnVlO1xufSk7XG5cbi8vIFJlZ2lzdGVyIHRvb2xiYXIvY29udGV4dC1tZW51IGxpc3RlbmVycyBzeW5jaHJvbm91c2x5IG9uIGV2ZXJ5IHdvcmtlciB3YWtlLlxuaW1wb3J0U2NyaXB0cygnY29udHJvbHMuanMnKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EifQ==
