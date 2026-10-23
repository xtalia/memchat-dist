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
    Object.keys(bucket.legacyBackup || {}).sort().map(key => [key, bucket.legacyBackup[key]])]);
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
            await chrome.storage.local.set({ [storageKey]: bucket });
            const committed = (await chrome.storage.local.get(storageKey))[storageKey];
            if (!committed || privateStorageSnapshot(committed) !== privateStorageSnapshot(bucket)) throw Error('Storage verification failed');
            privateStorageSubscribers.set(sender.tab.id, { origin, documentId: sender.documentId });
            return { ok: true, items: committed.items, cleanup };
        }
        if (message.type === 'memchat:storage-write') {
            const { key, revision } = message;
            if (!MEMCHAT_STORAGE_KEYS.has(key) || !Number.isSafeInteger(revision) || revision < 0
                || (message.value !== null && (typeof message.value !== 'string' || message.value.length > 5 * 1024 * 1024))) throw Error('Invalid write');
            const previous = bucket.items[key] || { value: null, revision: 0 };
            if (previous.revision !== revision || message.previousValue !== previous.value) return { ok: false, conflict: true, item: previous,
                error: 'Настройки изменены в другой вкладке. Перезагрузите эту вкладку.' };
            const item = { value: message.value === null ? null : extensionSanitizeStoredValue(key, message.value), revision: revision + 1 };
            bucket.items[key] = item;
            await chrome.storage.local.set({ [storageKey]: bucket });
            // Best-effort private invalidation; closed/replaced documents are ignored.
            for (const [tabId, subscriber] of privateStorageSubscribers) {
                if (tabId === sender.tab.id || subscriber.origin !== origin) continue;
                const options = subscriber.documentId ? { documentId: subscriber.documentId } : { frameId: 0 };
                chrome.tabs.sendMessage(tabId, { type: 'memchat:storage-changed', key, item }, options).catch(() => {
                    if (privateStorageSubscribers.get(tabId) === subscriber) privateStorageSubscribers.delete(tabId);
                });
            }
            return { ok: true, item };
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
    if (!chrome.alarms) return;
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
        return orderPublicConfig();
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
    return orderPublicConfig();
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
        await deliverOrderResult(result, config, controller, revision);
        return { ok: true, result };
    })().finally(() => { orderFlight = null; if (orderController === controller) orderController = null; });
    return orderFlight;
}
if (chrome.alarms) chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'memchat-orders') return pollOrders().catch(() => {});
});
/* module: extension/worker.js */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (['memchat:storage-init', 'memchat:storage-write'].includes(message?.type)) {
        if (!trustedContentSender(sender)) { sendResponse({ ok: false, error: 'Запрос хранилища отклонён' }); return false; }
        privateStorageMessage(message, sender).then(sendResponse,
            () => sendResponse({ ok: false, error: 'Не удалось сохранить данные расширения. Перезагрузите вкладку; старые данные не удалены.' }));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL25ldHdvcmsuanMiLCJleHRlbnNpb24vd29ya2VyL3BhbmVsLXNlc3Npb24uanMiLCJleHRlbnNpb24vd29ya2VyL29yZGVycy5qcyIsImV4dGVuc2lvbi93b3JrZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBQcml2YXRlIHN0b3JhZ2UgaXMgb3JpZ2luLXNjb3BlZCB0byBwcmVzZXJ2ZSBleGlzdGluZyBzaXRlL2FjY291bnQgc2VwYXJhdGlvbi5cbi8vIENocm9tZSBvd25zIHBlcnNpc3RlbmNlOyBwYWdlIGxvY2FsU3RvcmFnZSBpcyB1c2VkIG9ubHkgZm9yIG9uZS10aW1lIG1pZ3JhdGlvbi5cbmNvbnN0IHByaXZhdGVTdG9yYWdlUmVhZHkgPSAoYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldEFjY2Vzc0xldmVsKHsgYWNjZXNzTGV2ZWw6ICdUUlVTVEVEX0NPTlRFWFRTJyB9KTtcbn0pKCk7XG4vLyBIYW5kbGUgaW5pdGlhbGl6YXRpb24gcmVqZWN0aW9uIGltbWVkaWF0ZWx5LCB3aGlsZSByZXRhaW5pbmcgZmFpbC1jbG9zZWQgYXdhaXRzLlxucHJpdmF0ZVN0b3JhZ2VSZWFkeS5jYXRjaCgoKSA9PiB7fSk7XG5sZXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycyA9IG5ldyBNYXAoKTtcbmZ1bmN0aW9uIHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSB7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtidWNrZXQudmVyc2lvbiwgT2JqZWN0LmtleXMoYnVja2V0Lml0ZW1zKS5zb3J0KCkubWFwKGtleSA9PlxuICAgICAgICBba2V5LCBidWNrZXQuaXRlbXNba2V5XS5yZXZpc2lvbiwgYnVja2V0Lml0ZW1zW2tleV0udmFsdWVdKSxcbiAgICBPYmplY3Qua2V5cyhidWNrZXQubGVnYWN5QmFja3VwIHx8IHt9KS5zb3J0KCkubWFwKGtleSA9PiBba2V5LCBidWNrZXQubGVnYWN5QmFja3VwW2tleV1dKV0pO1xufVxuYXN5bmMgZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGF1dGhvcml6YXRpb24pIHtcbiAgICBhd2FpdCBwcml2YXRlU3RvcmFnZVJlYWR5O1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlQ2hhaW47XG4gICAgY29uc3Qga2V5ID0gJ21lbWNoYXRQcml2YXRlX3YxOicgKyBuZXcgVVJMKHNlbmRlci51cmwgfHwgc2VuZGVyLnRhYi51cmwpLm9yaWdpbjtcbiAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoa2V5KSlba2V5XTtcbiAgICBjb25zdCBhcGkgPSBKU09OLnBhcnNlKHNhdmVkPy5pdGVtc1snbWVtY2hhdDpoYWNrZXJNc0FwaV92MSddPy52YWx1ZSB8fCAne30nKTtcbiAgICByZXR1cm4gYXBpLmJlYXJlckVuYWJsZWQgPT09IHRydWUgJiYgdHlwZW9mIGFwaS50b2tlbiA9PT0gJ3N0cmluZycgJiYgYXV0aG9yaXphdGlvbiA9PT0gJ0JlYXJlciAnICsgYXBpLnRva2VuO1xufVxuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGNvbnN0IG9wZXJhdGlvbiA9IHByaXZhdGVTdG9yYWdlQ2hhaW4udGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgICAgIGNvbnN0IG9yaWdpbiA9IG5ldyBVUkwoc2VuZGVyLnVybCB8fCBzZW5kZXIudGFiLnVybCkub3JpZ2luO1xuICAgICAgICBjb25zdCBzdG9yYWdlS2V5ID0gJ21lbWNoYXRQcml2YXRlX3YxOicgKyBvcmlnaW47XG4gICAgICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChzdG9yYWdlS2V5KSlbc3RvcmFnZUtleV07XG4gICAgICAgIGNvbnN0IGJ1Y2tldCA9IHNhdmVkIHx8IHsgdmVyc2lvbjogMSwgaXRlbXM6IHt9LCBsZWdhY3lCYWNrdXA6IHt9IH07XG4gICAgICAgIGlmIChidWNrZXQudmVyc2lvbiAhPT0gMSB8fCAhYnVja2V0Lml0ZW1zIHx8IHR5cGVvZiBidWNrZXQuaXRlbXMgIT09ICdvYmplY3QnKSB0aHJvdyBFcnJvcignSW52YWxpZCBzY2hlbWEnKTtcbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c3RvcmFnZS1pbml0Jykge1xuICAgICAgICAgICAgY29uc3QgbGVnYWN5ID0gbWVzc2FnZS5sZWdhY3k7XG4gICAgICAgICAgICBpZiAoIWxlZ2FjeSB8fCB0eXBlb2YgbGVnYWN5ICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGxlZ2FjeSkpIHRocm93IEVycm9yKCdJbnZhbGlkIGxlZ2FjeSBzbmFwc2hvdCcpO1xuICAgICAgICAgICAgY29uc3QgY2xlYW51cCA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCBba2V5LCByYXddIG9mIE9iamVjdC5lbnRyaWVzKGxlZ2FjeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHJhdyAhPT0gJ3N0cmluZycgfHwgcmF3Lmxlbmd0aCA+IDUgKiAxMDI0ICogMTAyNCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdmFsdWUnKTtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnY2xlYXJUZXh0RW5hYmxlZCcgJiYgWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMocmF3KSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIU9iamVjdC5oYXNPd24oYnVja2V0Lml0ZW1zLCAnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gWyd0cnVlJywgJ2ZhbHNlJ10uaW5jbHVkZXMobGVnYWN5WydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSkgPyBsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddIDogcmF3O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXSA9IHsgdmFsdWUsIHJldmlzaW9uOiAxIH07XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYnVja2V0Lml0ZW1zWydtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnXS52YWx1ZSAhPT0gcmF3KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAuY2xlYXJUZXh0RW5hYmxlZCA9IHJhdztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgeyBjbGVhbnVwLnB1c2goa2V5KTsgY29udGludWU7IH1cbiAgICAgICAgICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGV4dGVuc2lvblNhbml0aXplU3RvcmVkVmFsdWUoa2V5LCByYXcpO1xuICAgICAgICAgICAgICAgIGlmICghc2F2ZWQpIGJ1Y2tldC5pdGVtc1trZXldID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICBlbHNlIGlmIChidWNrZXQuaXRlbXNba2V5XT8udmFsdWUgIT09IHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIEFuIG9sZGVyIHVzZXJzY3JpcHQgbWF5IHJlY3JlYXRlIG9sZCBrZXlzLiBQcmVzZXJ2ZSB0aGF0IGNvcHlcbiAgICAgICAgICAgICAgICAgICAgLy8gcHJpdmF0ZWx5LCBidXQgbmV2ZXIgcm9sbCBiYWNrIHRoZSBjYW5vbmljYWwgZXh0ZW5zaW9uIHN0YXRlLlxuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwIHx8PSB7fTtcbiAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cFtrZXldID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNsZWFudXAucHVzaChrZXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQWNrbm93bGVkZ2Ugb25seSBhZnRlciBDaHJvbWUgY29tbWl0cyBhbmQgYSByZWFkLWJhY2sgdmVyaWZpZXMgaXQuXG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGJ1Y2tldCB9KTtcbiAgICAgICAgICAgIGNvbnN0IGNvbW1pdHRlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoc3RvcmFnZUtleSkpW3N0b3JhZ2VLZXldO1xuICAgICAgICAgICAgaWYgKCFjb21taXR0ZWQgfHwgcHJpdmF0ZVN0b3JhZ2VTbmFwc2hvdChjb21taXR0ZWQpICE9PSBwcml2YXRlU3RvcmFnZVNuYXBzaG90KGJ1Y2tldCkpIHRocm93IEVycm9yKCdTdG9yYWdlIHZlcmlmaWNhdGlvbiBmYWlsZWQnKTtcbiAgICAgICAgICAgIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuc2V0KHNlbmRlci50YWIuaWQsIHsgb3JpZ2luLCBkb2N1bWVudElkOiBzZW5kZXIuZG9jdW1lbnRJZCB9KTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtczogY29tbWl0dGVkLml0ZW1zLCBjbGVhbnVwIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6c3RvcmFnZS13cml0ZScpIHtcbiAgICAgICAgICAgIGNvbnN0IHsga2V5LCByZXZpc2lvbiB9ID0gbWVzc2FnZTtcbiAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHJldmlzaW9uKSB8fCByZXZpc2lvbiA8IDBcbiAgICAgICAgICAgICAgICB8fCAobWVzc2FnZS52YWx1ZSAhPT0gbnVsbCAmJiAodHlwZW9mIG1lc3NhZ2UudmFsdWUgIT09ICdzdHJpbmcnIHx8IG1lc3NhZ2UudmFsdWUubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHdyaXRlJyk7XG4gICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGJ1Y2tldC5pdGVtc1trZXldIHx8IHsgdmFsdWU6IG51bGwsIHJldmlzaW9uOiAwIH07XG4gICAgICAgICAgICBpZiAocHJldmlvdXMucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IG1lc3NhZ2UucHJldmlvdXNWYWx1ZSAhPT0gcHJldmlvdXMudmFsdWUpIHJldHVybiB7IG9rOiBmYWxzZSwgY29uZmxpY3Q6IHRydWUsIGl0ZW06IHByZXZpb3VzLFxuICAgICAgICAgICAgICAgIGVycm9yOiAn0J3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90Ysg0LIg0LTRgNGD0LPQvtC5INCy0LrQu9Cw0LTQutC1LiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDRjdGC0YMg0LLQutC70LDQtNC60YMuJyB9O1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHsgdmFsdWU6IG1lc3NhZ2UudmFsdWUgPT09IG51bGwgPyBudWxsIDogZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIG1lc3NhZ2UudmFsdWUpLCByZXZpc2lvbjogcmV2aXNpb24gKyAxIH07XG4gICAgICAgICAgICBidWNrZXQuaXRlbXNba2V5XSA9IGl0ZW07XG4gICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbc3RvcmFnZUtleV06IGJ1Y2tldCB9KTtcbiAgICAgICAgICAgIC8vIEJlc3QtZWZmb3J0IHByaXZhdGUgaW52YWxpZGF0aW9uOyBjbG9zZWQvcmVwbGFjZWQgZG9jdW1lbnRzIGFyZSBpZ25vcmVkLlxuICAgICAgICAgICAgZm9yIChjb25zdCBbdGFiSWQsIHN1YnNjcmliZXJdIG9mIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMpIHtcbiAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IHNlbmRlci50YWIuaWQgfHwgc3Vic2NyaWJlci5vcmlnaW4gIT09IG9yaWdpbikgY29udGludWU7XG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHN1YnNjcmliZXIuZG9jdW1lbnRJZCA/IHsgZG9jdW1lbnRJZDogc3Vic2NyaWJlci5kb2N1bWVudElkIH0gOiB7IGZyYW1lSWQ6IDAgfTtcbiAgICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnLCBrZXksIGl0ZW0gfSwgb3B0aW9ucykuY2F0Y2goKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAocHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5nZXQodGFiSWQpID09PSBzdWJzY3JpYmVyKSBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmRlbGV0ZSh0YWJJZCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgaXRlbSB9O1xuICAgICAgICB9XG4gICAgICAgIHRocm93IEVycm9yKCdJbnZhbGlkIG9wZXJhdGlvbicpO1xuICAgIH0pO1xuICAgIHByaXZhdGVTdG9yYWdlQ2hhaW4gPSBvcGVyYXRpb24uY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBvcGVyYXRpb247XG59XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IHBlbmRpbmdSZXF1ZXN0cyA9IG5ldyBNYXAoKTtcbmNvbnN0IHJ1bGVzUmVhZHkgPSBjaHJvbWUuZGVjbGFyYXRpdmVOZXRSZXF1ZXN0LnVwZGF0ZVNlc3Npb25SdWxlcyh7XG4gICAgcmVtb3ZlUnVsZUlkczogWzEsIDJdLFxuICAgIGFkZFJ1bGVzOiBbXG4gICAgICAgIHsgaWQ6IDEsIHByaW9yaXR5OiAxLCBhY3Rpb246IHsgdHlwZTogJ21vZGlmeUhlYWRlcnMnLCByZXF1ZXN0SGVhZGVyczogW1xuICAgICAgICAgICAgeyBoZWFkZXI6ICdPcmlnaW4nLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB9LFxuICAgICAgICAgICAgeyBoZWFkZXI6ICdSZWZlcmVyJywgb3BlcmF0aW9uOiAnc2V0JywgdmFsdWU6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9zZWFyY2gnIH1cbiAgICAgICAgXSB9LCBjb25kaXRpb246IHsgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSwgdXJsRmlsdGVyOiAnfGh0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1LycsIHJlc291cmNlVHlwZXM6IFsneG1saHR0cHJlcXVlc3QnXSB9IH0sXG4gICAgICAgIHsgaWQ6IDIsIHByaW9yaXR5OiAyLCBhY3Rpb246IHsgdHlwZTogJ2Jsb2NrJyB9LCBjb25kaXRpb246IHtcbiAgICAgICAgICAgIGluaXRpYXRvckRvbWFpbnM6IFtjaHJvbWUucnVudGltZS5pZF0sXG4gICAgICAgICAgICBleGNsdWRlZFJlcXVlc3REb21haW5zOiBbLi4ubmV3IFNldChNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLm1hcChob3N0ID0+IGhvc3QucmVwbGFjZSgvXlxcKlxcLi8sICcnKSkpXSxcbiAgICAgICAgICAgIHJlc291cmNlVHlwZXM6IFsneG1saHR0cHJlcXVlc3QnXVxuICAgICAgICB9IH1cbiAgICBdXG59KTtcbi8vIEZhaWwgY2xvc2VkOiBhIGZhaWxlZCBETlIgc2V0dXAgaXMgY2F1Z2h0IGhlcmUgYW5kIGJsb2NrcyBzdWJzZXF1ZW50IHJlcXVlc3RzLlxubGV0IHJ1bGVGYWlsdXJlID0gZmFsc2U7XG5ydWxlc1JlYWR5LmNhdGNoKCgpID0+IHsgcnVsZUZhaWx1cmUgPSB0cnVlOyB9KTtcblxuZnVuY3Rpb24gbWF0Y2hlc0hvc3QoaG9zdG5hbWUsIHBhdHRlcm4pIHtcbiAgICByZXR1cm4gcGF0dGVybi5zdGFydHNXaXRoKCcqLicpXG4gICAgICAgID8gaG9zdG5hbWUgPT09IHBhdHRlcm4uc2xpY2UoMikgfHwgaG9zdG5hbWUuZW5kc1dpdGgoJy4nICsgcGF0dGVybi5zbGljZSgyKSlcbiAgICAgICAgOiBob3N0bmFtZSA9PT0gcGF0dGVybjtcbn1cblxuZnVuY3Rpb24gYWxsb3dlZFVybChyYXcpIHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgaWYgKHVybC5wcm90b2NvbCAhPT0gJ2h0dHBzOicgfHwgdXJsLnVzZXJuYW1lIHx8IHVybC5wYXNzd29yZCB8fCB1cmwucG9ydFxuICAgICAgICB8fCAhTUVNQ0hBVF9FWFRFTlNJT05fQ09ORklHLm5ldHdvcmtIb3N0cy5zb21lKGhvc3QgPT4gbWF0Y2hlc0hvc3QodXJsLmhvc3RuYW1lLCBob3N0KSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVUkwgbm90IHBlcm1pdHRlZCcpO1xuICAgIH1cbiAgICByZXR1cm4gdXJsO1xufVxuXG5mdW5jdGlvbiB0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHtcbiAgICBpZiAoc2VuZGVyLmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCAhTnVtYmVyLmlzSW50ZWdlcihzZW5kZXIudGFiPy5pZCkgfHwgc2VuZGVyLmZyYW1lSWQgIT09IDApIHJldHVybiBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHNlbmRlci51cmwpO1xuICAgICAgICByZXR1cm4gdXJsLnByb3RvY29sID09PSAnaHR0cHM6JyAmJiAhdXJsLnBvcnQgJiYgTUVNQ0hBVF9FWFRFTlNJT05fQ09ORklHLnBhZ2VNYXRjaGVzLnNvbWUocGF0dGVybiA9PlxuICAgICAgICAgICAgbWF0Y2hlc0hvc3QodXJsLmhvc3RuYW1lLCBuZXcgVVJMKHBhdHRlcm4ucmVwbGFjZSgnKi4nLCAnd2lsZGNhcmQuJykpLmhvc3RuYW1lLnJlcGxhY2UoJ3dpbGRjYXJkLicsICcqLicpKSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuXG5mdW5jdGlvbiByZXF1ZXN0S2V5KHNlbmRlciwgaWQpIHsgcmV0dXJuIGAke3NlbmRlci50YWIuaWR9OiR7c2VuZGVyLmZyYW1lSWR9OiR7aWR9YDsgfVxuXG4vLyBEaXNwYXRjaCBNUyByZXF1ZXN0cyBkaXJlY3RseS4gT25seSBhIGZhaWxlZCByZWFkIHdhaXRzIGZvciBpdHMgb3duIHJldHJ5O1xuLy8gbm8gcHJvZmlsZS13aWRlIHF1b3RhIHN0YXRlLCByZXNlcnZhdGlvbnMsIGNvbmN1cnJlbmN5IGNhcCBvciBwYWNpbmcuXG5mdW5jdGlvbiBpc01zSnNvbkFwaSh1cmwpIHtcbiAgICByZXR1cm4gdXJsLmhvc3RuYW1lID09PSAnYXBpLm1veXNrbGFkLnJ1JyAmJiAvXlxcL2FwaVxcL3JlbWFwXFwvMVxcLjIoPzpcXC98JCkvLnRlc3QodXJsLnBhdGhuYW1lKTtcbn1cbmZ1bmN0aW9uIG1zUmV0cnlEZWxheShyZXNwb25zZSwgdGV4dCA9ICcnKSB7XG4gICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgIGxldCBxdW90YUVycm9yID0gZmFsc2U7XG4gICAgICAgIHRyeSB7IHF1b3RhRXJyb3IgPSBKU09OLnBhcnNlKHRleHQpPy5lcnJvcnM/LnNvbWUoZXJyb3IgPT4gTnVtYmVyKGVycm9yLmNvZGUpID09PSAxMDczKSA9PT0gdHJ1ZTsgfSBjYXRjaCB7IC8qIE5vdCBKU09OLiAqLyB9XG4gICAgICAgIGlmICghWzQwOCwgNDI5XS5pbmNsdWRlcyhyZXNwb25zZS5zdGF0dXMpICYmIHJlc3BvbnNlLnN0YXR1cyA8IDUwMCAmJiAhcXVvdGFFcnJvcikgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGxvZ25leCA9IE51bWJlcihyZXNwb25zZT8uaGVhZGVycy5nZXQoJ1gtTG9nbmV4LVJldHJ5LUFmdGVyJykgfHwgMCk7XG4gICAgY29uc3QgcmV0cnlBZnRlciA9IHJlc3BvbnNlPy5oZWFkZXJzLmdldCgnUmV0cnktQWZ0ZXInKTtcbiAgICBjb25zdCBzZWNvbmRzID0gcmV0cnlBZnRlcj8udHJpbSgpID8gTnVtYmVyKHJldHJ5QWZ0ZXIpIDogMDtcbiAgICBjb25zdCBzdGFuZGFyZCA9IE51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSA/IHNlY29uZHMgKiAxMDAwIDogRGF0ZS5wYXJzZShyZXRyeUFmdGVyKSAtIERhdGUubm93KCk7XG4gICAgY29uc3QgZGVsYXkgPSBNYXRoLm1heCg1MDAsIE51bWJlci5pc0Zpbml0ZShsb2duZXgpID8gbG9nbmV4IDogMCwgTnVtYmVyLmlzRmluaXRlKHN0YW5kYXJkKSA/IHN0YW5kYXJkIDogMCk7XG4gICAgcmV0dXJuIGRlbGF5O1xufVxuZnVuY3Rpb24gbXNXYWl0Rm9yUmV0cnkoc2lnbmFsLCBkZWxheSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgbGV0IHJlbWFpbmluZyA9IGRlbGF5O1xuICAgICAgICBsZXQgdGltZXI7XG4gICAgICAgIGNvbnN0IGRvbmUgPSAoKSA9PiB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGRvbmUpOyByZXNvbHZlKCk7IH07XG4gICAgICAgIGNvbnN0IHNjaGVkdWxlID0gKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2h1bmsgPSBNYXRoLm1pbihyZW1haW5pbmcsIDIxNDc0ODM2NDcpO1xuICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgICAgICByZW1haW5pbmcgLT0gY2h1bms7XG4gICAgICAgICAgICAgICAgaWYgKHJlbWFpbmluZyA+IDApIHNjaGVkdWxlKCk7XG4gICAgICAgICAgICAgICAgZWxzZSBkb25lKCk7XG4gICAgICAgICAgICB9LCBjaHVuayk7XG4gICAgICAgIH07XG4gICAgICAgIHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGRvbmUsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgICAgaWYgKHNpZ25hbC5hYm9ydGVkKSBkb25lKCk7XG4gICAgICAgIGVsc2Ugc2NoZWR1bGUoKTtcbiAgICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybVJlcXVlc3QobWVzc2FnZSwgc2VuZGVyLCBiYWNrZ3JvdW5kU2lnbmFsKSB7XG4gICAgY29uc3QgcmVxdWVzdCA9IG1lc3NhZ2UucmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhbGxvd2VkVXJsKHJlcXVlc3Q/LnVybCk7XG4gICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICghWydHRVQnLCAnSEVBRCcsICdQT1NUJywgJ1BVVCcsICdQQVRDSCcsICdERUxFVEUnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ01ldGhvZCBub3QgcGVybWl0dGVkJyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0JvZHkgbXVzdCBiZSB0ZXh0Jyk7XG4gICAgaWYgKHJlcXVlc3QuZGF0YSAhPSBudWxsICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpKSB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgYm9keScpO1xuICAgIGlmIChyZXF1ZXN0LnJlc3BvbnNlVHlwZSAmJiAhWyd0ZXh0JywgJ2pzb24nXS5pbmNsdWRlcyhyZXF1ZXN0LnJlc3BvbnNlVHlwZSkpIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgcmVzcG9uc2UgdHlwZScpO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycygpO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXF1ZXN0LmhlYWRlcnMgfHwge30pKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgaGVhZGVyJyk7XG4gICAgICAgIGlmICgvXmF1dGhvcml6YXRpb24kL2kudGVzdChuYW1lKSAmJiB1cmwuaG9zdG5hbWUgIT09ICdhcGkubW95c2tsYWQucnUnKSB0aHJvdyBuZXcgRXJyb3IoJ0F1dGhvcml6YXRpb24gaG9zdCBub3QgcGVybWl0dGVkJyk7XG4gICAgICAgIGlmICgvXihvcmlnaW58cmVmZXJlcnx1c2VyLWFnZW50fGNvb2tpZXxob3N0fGNvbnRlbnQtbGVuZ3RofGNvbm5lY3Rpb258YWNjZXB0LWVuY29kaW5nfHByb3h5LS4qfHNlYy0uKikkL2kudGVzdChuYW1lKSkgY29udGludWU7XG4gICAgICAgIGhlYWRlcnMuc2V0KG5hbWUsIHZhbHVlKTtcbiAgICB9XG4gICAgY29uc3Qga2V5ID0gcmVxdWVzdEtleShzZW5kZXIsIG1lc3NhZ2UuaWQpO1xuICAgIGlmIChwZW5kaW5nUmVxdWVzdHMuaGFzKGtleSkpIHRocm93IG5ldyBFcnJvcignRHVwbGljYXRlIHJlcXVlc3QnKTtcbiAgICBjb25zdCBlbnRyeSA9IHsgY29udHJvbGxlcjogbmV3IEFib3J0Q29udHJvbGxlcigpLCBldmVudDogJycgfTtcbiAgICBwZW5kaW5nUmVxdWVzdHMuc2V0KGtleSwgZW50cnkpO1xuICAgIGNvbnN0IGNhbmNlbEJhY2tncm91bmQgPSAoKSA9PiB7IGVudHJ5LmV2ZW50ID0gJ2Fib3J0JzsgZW50cnkuY29udHJvbGxlci5hYm9ydCgpOyB9O1xuICAgIGJhY2tncm91bmRTaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsQmFja2dyb3VuZCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgIGlmIChiYWNrZ3JvdW5kU2lnbmFsPy5hYm9ydGVkKSBjYW5jZWxCYWNrZ3JvdW5kKCk7XG4gICAgY29uc3QgdGltZW91dCA9IE1hdGgubWluKDMwMDAwLCBNYXRoLm1heCgxLCBOdW1iZXIocmVxdWVzdC50aW1lb3V0KSB8fCAzMDAwMCkpO1xuICAgIGxldCB0aW1lcjtcbiAgICBjb25zdCBjaGVja0N1cnJlbnQgPSByZXF1ZXN0LmNyZWRlbnRpYWxHdWFyZCA9PT0gdHJ1ZSA/IGFzeW5jICgpID0+IHtcbiAgICAgICAgbGV0IGNoZWNrVGltZXI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHNlbmRlci50YWIuaWQsIHsgdHlwZTogJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50JywgaWQ6IG1lc3NhZ2UuaWQgfSwgeyBmcmFtZUlkOiBzZW5kZXIuZnJhbWVJZCB9KSxcbiAgICAgICAgICAgICAgICBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHsgY2hlY2tUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShudWxsKSwgMTAwMCk7IH0pXG4gICAgICAgICAgICBdKTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQ/LmN1cnJlbnQgPT09IHRydWUgJiYgKCFpc01zSnNvbkFwaSh1cmwpIHx8IHR5cGVvZiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50ICE9PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgfHwgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDcmVkZW50aWFsQ3VycmVudChzZW5kZXIsIGhlYWRlcnMuZ2V0KCdhdXRob3JpemF0aW9uJykpKSkgcmV0dXJuO1xuICAgICAgICB9IGNhdGNoIHsgLyogTWlzc2luZy9pbnZhbGlkYXRlZCBjb250ZW50IHdvcmxkIGZhaWxzIGNsb3NlZC4gKi8gfVxuICAgICAgICBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KGNoZWNrVGltZXIpOyB9XG4gICAgICAgIGVudHJ5LmV2ZW50ID0gJ2Fib3J0JztcbiAgICAgICAgZW50cnkuY29udHJvbGxlci5hYm9ydCgpO1xuICAgIH0gOiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgIGlmIChydWxlRmFpbHVyZSkgdGhyb3cgbmV3IEVycm9yKCdOZXR3b3JrIHJ1bGVzIHVuYXZhaWxhYmxlJyk7XG4gICAgICAgIGlmICh1cmwub3JpZ2luID09PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnICYmIHBhbmVsU2Vzc2lvbj8udGFiKSB7XG4gICAgICAgICAgICBpZiAoY2hlY2tDdXJyZW50KSBhd2FpdCBjaGVja0N1cnJlbnQoKTtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBwYW5lbFJlcXVlc3RWaWFUYWIoeyAuLi5yZXF1ZXN0LCBtZXRob2QgfSwgZW50cnkuY29udHJvbGxlci5zaWduYWwpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyA7IGF0dGVtcHQrKykge1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfTtcbiAgICAgICAgICAgIGNvbnN0IGNhblJldHJ5ID0gaXNNc0pzb25BcGkodXJsKSAmJiBbJ0dFVCcsICdIRUFEJ10uaW5jbHVkZXMobWV0aG9kKSAmJiBhdHRlbXB0ID09PSAwO1xuICAgICAgICAgICAgbGV0IHJldHJ5RGVsYXk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBlbnRyeS5jb250cm9sbGVyO1xuICAgICAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGVudHJ5LmV2ZW50ID0gJ3RpbWVvdXQnOyBjb250cm9sbGVyLmFib3J0KCk7IH0sIHRpbWVvdXQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsLmhyZWYsIHtcbiAgICAgICAgICAgICAgICAgICAgbWV0aG9kLCBoZWFkZXJzLCBib2R5OiByZXF1ZXN0LmRhdGEgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogcmVxdWVzdC5hbm9ueW1vdXMgPT09IHRydWUgPyAnb21pdCcgOiAnaW5jbHVkZScsXG4gICAgICAgICAgICAgICAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsIHJlZGlyZWN0OiBpc01zSnNvbkFwaSh1cmwpID8gJ2Vycm9yJyA6ICdmb2xsb3cnXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgLy8gRE5SIGJsb2NrcyByZWRpcmVjdHMgdG8gdW5ncmFudGVkIGhvc3RzIGJlZm9yZSBzZW5kaW5nIGJ5dGVzLlxuICAgICAgICAgICAgICAgIGFsbG93ZWRVcmwocmVzcG9uc2UudXJsIHx8IHVybC5ocmVmKTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICAgICAgICAgICAgaWYgKGVudHJ5LmV2ZW50KSB0aHJvdyBuZXcgRXJyb3IoJ0NhbmNlbGxlZCcpO1xuICAgICAgICAgICAgICAgIHJldHJ5RGVsYXkgPSBjYW5SZXRyeSA/IG1zUmV0cnlEZWxheShyZXNwb25zZSwgcmVzcG9uc2VUZXh0KSA6IG51bGw7XG4gICAgICAgICAgICAgICAgaWYgKHJldHJ5RGVsYXkgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHBhcnNlZCA9IHJlc3BvbnNlVGV4dDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlcXVlc3QucmVzcG9uc2VUeXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KTsgfSBjYXRjaCB7IHBhcnNlZCA9IG51bGw7IH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4geyBldmVudDogJ2xvYWQnLCByZXNwb25zZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsIHJlc3BvbnNlVGV4dCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlOiBwYXJzZWQsIHJlc3BvbnNlSGVhZGVyczogWy4uLnJlc3BvbnNlLmhlYWRlcnNdLm1hcCgoW25hbWUsIHZhbHVlXSkgPT4gYCR7bmFtZX06ICR7dmFsdWV9YCkuam9pbihTdHJpbmcuZnJvbUNoYXJDb2RlKDEzLCAxMCkpLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmluYWxVcmw6IHJlc3BvbnNlLnVybCB8fCB1cmwuaHJlZiwgcmVhZHlTdGF0ZTogNFxuICAgICAgICAgICAgICAgICAgICB9IH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgICAgaWYgKCFjYW5SZXRyeSB8fCBlbnRyeS5ldmVudCA9PT0gJ2Fib3J0JykgcmV0dXJuIHsgZXZlbnQ6IGVudHJ5LmV2ZW50IHx8ICdlcnJvcicsIGVycm9yOiAn0J7RiNC40LHQutCwINGB0LXRgtC4INGA0LDRgdGI0LjRgNC10L3QuNGPIE1lbWNoYXQnIH07XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IDUwMDtcbiAgICAgICAgICAgIH0gZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IH1cbiAgICAgICAgICAgIC8vIEEgdGltZW91dCBhYm9ydHMgaXRzIGF0dGVtcHQsIG5vdCB0aGUgbmV4dCBvbmUuIEV4cGxpY2l0IGFib3J0cyBhbmRcbiAgICAgICAgICAgIC8vIGNyZWRlbnRpYWwgY2hhbmdlcyBzdGlsbCBjYW5jZWwgdGhpcyB3YWl0IGFuZCBzdXBwcmVzcyB0aGUgcmV0cnkuXG4gICAgICAgICAgICBlbnRyeS5ldmVudCA9ICcnO1xuICAgICAgICAgICAgZW50cnkuY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgICAgIGF3YWl0IG1zV2FpdEZvclJldHJ5KGVudHJ5LmNvbnRyb2xsZXIuc2lnbmFsLCByZXRyeURlbGF5KTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfHwgJ2Vycm9yJywgZXJyb3I6ICfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcgfTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICBiYWNrZ3JvdW5kU2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbEJhY2tncm91bmQpO1xuICAgICAgICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGtleSk7XG4gICAgfVxufVxuIiwiLy8gQSBzaW5nbGUgd29ya2VyIG93bnMgdGhlIFBhbmVsIHRva2VuLiBOZXZlciBwZXJzaXN0IGl0IGludG8gcGFnZSBzdG9yYWdlLlxuY29uc3QgUEFORUxfU0VTU0lPTl9UVEwgPSAxMiAqIDYwICogMTAwMDtcbmNvbnN0IFBBTkVMX1NFU1NJT05fVElNRU9VVCA9IDE1MDAwO1xubGV0IHBhbmVsU2Vzc2lvbiA9IG51bGw7XG5sZXQgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbmxldCBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xubGV0IHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5cbmZ1bmN0aW9uIGV4dHJhY3RQYW5lbFNlc3Npb25Ub2tlbihodG1sKSB7XG4gICAgY29uc3QgY2xlYW4gPSBodG1sLnJlcGxhY2UoLzwhLS1bXFxzXFxTXSo/LS0+fDxzY3JpcHRcXGJbXj5dKj5bXFxzXFxTXSo/PFxcL3NjcmlwdFxccyo+L2dpLCAnJyk7XG4gICAgaWYgKC88aW5wdXRcXGJbXj5dKlxcYnR5cGVcXHMqPVxccypbXCInXT9wYXNzd29yZFxcYi9pLnRlc3QoY2xlYW4pKSByZXR1cm4gJyc7XG4gICAgZm9yIChjb25zdCB0YWcgb2YgY2xlYW4ubWF0Y2goLzxtZXRhXFxiW14+XSo+L2dpKSB8fCBbXSkge1xuICAgICAgICBjb25zdCBhdHRycyA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIHRhZy5tYXRjaEFsbCgvKFtcXHctXSspXFxzKj1cXHMqKD86XCIoW15cIl0qKVwifCcoW14nXSopJykvZykpIHtcbiAgICAgICAgICAgIGF0dHJzW21hdGNoWzFdLnRvTG93ZXJDYXNlKCldID0gbWF0Y2hbMl0gPz8gbWF0Y2hbM107XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGF0dHJzLm5hbWU/LnRvTG93ZXJDYXNlKCkgPT09ICdjc3JmLXRva2VuJyAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QoYXR0cnMuY29udGVudCB8fCAnJykpIHJldHVybiBhdHRycy5jb250ZW50O1xuICAgIH1cbiAgICByZXR1cm4gJyc7XG59XG5cbmxldCBwYW5lbFRhYlNlcXVlbmNlID0gMDtcbmZ1bmN0aW9uIHBhbmVsVGFiVXJsKHJhdykge1xuICAgIHRyeSB7IGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTsgcmV0dXJuIHVybC5vcmlnaW4gPT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgJiYgIXVybC51c2VybmFtZSAmJiAhdXJsLnBhc3N3b3JkICYmICEvXlxcL2xvZ2luXFwvPyQvLnRlc3QodXJsLnBhdGhuYW1lKTsgfVxuICAgIGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5mdW5jdGlvbiBwYW5lbFRhYlJlcXVlc3RBbGxvd2VkKHJlcXVlc3QpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcXVlc3Q/LnVybCksIG1ldGhvZCA9IFN0cmluZyhyZXF1ZXN0Lm1ldGhvZCB8fCAnR0VUJykudG9VcHBlckNhc2UoKTtcbiAgICAgICAgcmV0dXJuIHBhbmVsVGFiVXJsKHVybC5ocmVmKSAmJiAhdXJsLmhhc2ggJiYgIXVybC5zZWFyY2ggJiYgKChtZXRob2QgPT09ICdHRVQnXG4gICAgICAgICAgICAmJiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZWFyY2gvZmlsdGVycycgfHwgL15cXC9hcGlcXC9ib251c2VzXFwvY2hlY2tcXC9cXGR7MSwyMH0kLy50ZXN0KHVybC5wYXRobmFtZSkpKVxuICAgICAgICAgICAgfHwgKG1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2VhcmNoJyAmJiB0eXBlb2YgcmVxdWVzdC5kYXRhID09PSAnc3RyaW5nJyAmJiByZXF1ZXN0LmRhdGEubGVuZ3RoIDw9IDMyNzY4KSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxUYWJNZXNzYWdlKHRhYklkLCBwYXlsb2FkLCBzaWduYWwpIHtcbiAgICBjb25zdCBpZCA9ICdwYW5lbC0nICsgRGF0ZS5ub3coKSArICctJyArICgrK3BhbmVsVGFiU2VxdWVuY2UpO1xuICAgIGxldCB0aW1lciwgYWJvcnQ7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGltZW91dCA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICAgICAgYWJvcnQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6cGFuZWwtdGFiJywgaWQsIG9wZXJhdGlvbjogJ2NhbmNlbCcgfSwgeyBmcmFtZUlkOiAwIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICAgICAgICByZXNvbHZlKG51bGwpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHRpbWVyID0gc2V0VGltZW91dChhYm9ydCwgUEFORUxfU0VTU0lPTl9USU1FT1VUKTtcbiAgICAgICAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBhYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiBhd2FpdCBQcm9taXNlLnJhY2UoW2Nocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6ICdtZW1jaGF0OnBhbmVsLXRhYicsIGlkLCAuLi5wYXlsb2FkIH0sIHsgZnJhbWVJZDogMCB9KSwgdGltZW91dF0pO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxuICAgIGZpbmFsbHkgeyBjbGVhclRpbWVvdXQodGltZXIpOyBzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgYWJvcnQpOyB9XG59XG5hc3luYyBmdW5jdGlvbiByZWNvdmVyUGFuZWxGcm9tVGFiKHNpZ25hbCkge1xuICAgIGlmICghY2hyb21lLnRhYnM/LnF1ZXJ5IHx8ICFjaHJvbWUudGFicz8uZ2V0IHx8IHNpZ25hbC5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0YWJzID0gKGF3YWl0IGNocm9tZS50YWJzLnF1ZXJ5KHsgdXJsOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvKicgfSkpLmZpbHRlcih0YWIgPT4gTnVtYmVyLmlzSW50ZWdlcih0YWIuaWQpICYmIHBhbmVsVGFiVXJsKHRhYi51cmwpKTtcbiAgICAgICAgdGFicy5zb3J0KChhLCBiKSA9PiBOdW1iZXIoISFiLmFjdGl2ZSkgLSBOdW1iZXIoISFhLmFjdGl2ZSkgfHwgKGIubGFzdEFjY2Vzc2VkIHx8IDApIC0gKGEubGFzdEFjY2Vzc2VkIHx8IDApIHx8IGEuaWQgLSBiLmlkKTtcbiAgICAgICAgZm9yIChjb25zdCB0YWIgb2YgdGFicy5zbGljZSgwLCAzKSkge1xuICAgICAgICAgICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgcGFuZWxUYWJNZXNzYWdlKHRhYi5pZCwgeyBvcGVyYXRpb246ICdzZXNzaW9uJyB9LCBzaWduYWwpO1xuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGNocm9tZS50YWJzLmdldCh0YWIuaWQpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgICAgICAgICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIGlmIChyZXBseT8ub2sgJiYgL15bQS1aYS16MC05Xy1dezE2LDUxMn0kLy50ZXN0KHJlcGx5LnRva2VuIHx8ICcnKSAmJiB0eXBlb2YgcmVwbHkuaW5zdGFuY2UgPT09ICdzdHJpbmcnXG4gICAgICAgICAgICAgICAgJiYgcmVwbHkuaW5zdGFuY2UubGVuZ3RoIDw9IDEwMCAmJiBwYW5lbFRhYlVybChjdXJyZW50Py51cmwpKSB7XG4gICAgICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0geyB0b2tlbjogcmVwbHkudG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCksIHRhYjogeyBpZDogdGFiLmlkLCBpbnN0YW5jZTogcmVwbHkuaW5zdGFuY2UgfSB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbjogcmVwbHkudG9rZW4gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggeyAvKiBDbG9zZWQvbmF2aWdhdGVkIHRhYnMgYXJlIG5vdCBhbiBhdXRoZW50aWNhdGVkIHNlc3Npb24uICovIH1cbiAgICByZXR1cm4gbnVsbDtcbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsUmVxdWVzdFZpYVRhYihyZXF1ZXN0LCBzaWduYWwpIHtcbiAgICBjb25zdCByb3V0ZSA9IHBhbmVsU2Vzc2lvbj8udGFiO1xuICAgIGlmICghcm91dGUgfHwgIXBhbmVsVGFiUmVxdWVzdEFsbG93ZWQocmVxdWVzdCkpIHJldHVybiB7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ1BhbmVsOiDQt9Cw0L/RgNC+0YEg0L7RgtC60LvQvtC90ZHQvScgfTtcbiAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHJvdXRlLmlkKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICBpZiAoIXBhbmVsVGFiVXJsKGN1cnJlbnQ/LnVybCkgfHwgc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IGV2ZW50OiBzaWduYWwuYWJvcnRlZCA/ICdhYm9ydCcgOiAnZXJyb3InLCBlcnJvcjogJ1BhbmVsOiDQstC60LvQsNC00LrQsCDQt9Cw0LrRgNGL0YLQsCDQuNC70Lgg0LjQt9C80LXQvdC10L3QsC4g0J/QvtCy0YLQvtGA0LjRgtC1INC/0YDQvtCy0LXRgNC60YMgcGFuZWwuJyB9O1xuICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgcGFuZWxUYWJNZXNzYWdlKHJvdXRlLmlkLCB7IG9wZXJhdGlvbjogJ3JlcXVlc3QnLCBpbnN0YW5jZTogcm91dGUuaW5zdGFuY2UsIHJlcXVlc3QgfSwgc2lnbmFsKTtcbiAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiB7IGV2ZW50OiAnYWJvcnQnIH07XG4gICAgY29uc3QgYWZ0ZXIgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQocm91dGUuaWQpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmICghcmVwbHk/Lm9rIHx8IHJlcGx5Lmluc3RhbmNlICE9PSByb3V0ZS5pbnN0YW5jZSB8fCAhcGFuZWxUYWJVcmwoYWZ0ZXI/LnVybCkgfHwgcmVwbHkucmVzdWx0Py5ldmVudCAhPT0gJ2xvYWQnXG4gICAgICAgIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHJlcGx5LnJlc3VsdC5yZXNwb25zZT8uc3RhdHVzKSB8fCByZXBseS5yZXN1bHQucmVzcG9uc2U/LmZpbmFsVXJsICE9PSByZXF1ZXN0LnVybCkge1xuICAgICAgICBpZiAocGFuZWxTZXNzaW9uPy50YWIgPT09IHJvdXRlKSBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgICAgICByZXR1cm4geyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICdQYW5lbDog0LrQvtC90YLQtdC60YHRgiDQstC60LvQsNC00LrQuCDQuNC30LzQtdC90LjQu9GB0Y8uINCd0LDQttC80LjRgtC1IHBhbmVsINC00LvRjyDQv9C+0LLRgtC+0YDQvdC+0Lkg0L/RgNC+0LLQtdGA0LrQuC4nIH07XG4gICAgfVxuICAgIHJldHVybiByZXBseS5yZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0UGFuZWxTZXNzaW9uRmxpZ2h0KGZvcmNlKSB7XG4gICAgLy8gQSBxdWV1ZWQgbm9ybWFsIGZsaWdodCBtYXkgaGF2ZSBwb3B1bGF0ZWQgdGhlIGNhY2hlIHNpbmNlIGZvcmNlIHdhcyByZXF1ZXN0ZWQuXG4gICAgaWYgKGZvcmNlKSBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgIGNvbnN0IGZsaWdodCA9IHsgcHJvbWlzZTogbnVsbCB9O1xuICAgIGZsaWdodC5wcm9taXNlID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgUEFORUxfU0VTU0lPTl9USU1FT1VUKTtcbiAgICAgICAgY29uc3QgZmFpbHVyZSA9IGFzeW5jIChyZWFzb24sIGVycm9yKSA9PiAoYXdhaXQgcmVjb3ZlclBhbmVsRnJvbVRhYihjb250cm9sbGVyLnNpZ25hbCkpIHx8IHsgb2s6IGZhbHNlLCByZWFzb24sIGVycm9yIH07XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBydWxlc1JlYWR5O1xuICAgICAgICAgICAgaWYgKHJ1bGVGYWlsdXJlIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBFcnJvcignUGFuZWwgdW5hdmFpbGFibGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ3RleHQvaHRtbCcgfSwgY3JlZGVudGlhbHM6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgICAgICBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsVXJsID0gbmV3IFVSTChyZXNwb25zZS51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcpO1xuICAgICAgICAgICAgaWYgKGZpbmFsVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB8fCAhL15cXC9zZWFyY2hcXC8/JC8udGVzdChmaW5hbFVybC5wYXRobmFtZSlcbiAgICAgICAgICAgICAgICB8fCByZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDRhNC+0L3QvtCy0YvQuSDQstGF0L7QtCDQvdC10LTQvtGB0YLRg9C/0LXQvS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQsiDRjdGC0L7QvCDQv9GA0L7RhNC40LvQtSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHRva2VuID0gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGF3YWl0IHJlc3BvbnNlLnRleHQoKSk7XG4gICAgICAgICAgICBpZiAoIXRva2VuIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiBhd2FpdCBmYWlsdXJlKCdhdXRoJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0L7QtNGC0LLQtdGA0LTQuNGC0Ywg0LLRhdC+0LQuINCe0YLQutGA0L7QudGC0LUgcGFuZWwuaGF0aWtvLnJ1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgLy8gTGFyYXZlbCBpc3N1ZXMgQ1NSRiBldmVuIGZvciBhbm9ueW1vdXMgbG9naW4gcGFnZXMuIENvbmZpcm0gYWNjZXNzXG4gICAgICAgICAgICAvLyB0byBhbiBhY3R1YWwgcHJvdGVjdGVkIHJlYWQtb25seSBBUEkgd2l0aCB0aGUgc2FtZSBicm93c2VyIGNvb2tpZXMuXG4gICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgZmV0Y2goJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycsIHtcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdHRVQnLCBoZWFkZXJzOiB7IEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLCAnWC1SZXF1ZXN0ZWQtV2l0aCc6ICdYTUxIdHRwUmVxdWVzdCcgfSxcbiAgICAgICAgICAgICAgICBjcmVkZW50aWFsczogJ2luY2x1ZGUnLCBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdmb2xsb3cnLCBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IGF1dGhVcmwgPSBuZXcgVVJMKGF1dGgudXJsIHx8ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS9hcGkvc2VhcmNoL2ZpbHRlcnMnKTtcbiAgICAgICAgICAgIGlmIChhdXRoLnN0YXR1cyA8IDIwMCB8fCBhdXRoLnN0YXR1cyA+PSAzMDAgfHwgYXV0aFVybC5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydSdcbiAgICAgICAgICAgICAgICB8fCBhdXRoVXJsLnBhdGhuYW1lICE9PSAnL2FwaS9zZWFyY2gvZmlsdGVycycgfHwgIS9hcHBsaWNhdGlvblxcL2pzb24vaS50ZXN0KGF1dGguaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnKSkge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoYXV0aC5zdGF0dXMgPj0gNTAwID8gJ25ldHdvcmsnIDogJ2F1dGgnLCAnUGFuZWw6INC90LXRgiDQtNC+0YHRgtGD0L/QsCDQuiBBUEkuINCe0YLQutGA0L7QudGC0LUg0LDQstGC0L7RgNC40LfQvtCy0LDQvdC90YPRjiBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBwcm9vZiA9IGF3YWl0IGF1dGguanNvbigpO1xuICAgICAgICAgICAgaWYgKCFwcm9vZiB8fCB0eXBlb2YgcHJvb2YgIT09ICdvYmplY3QnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IEVycm9yKCdJbnZhbGlkIFBhbmVsIGF1dGggcHJvb2YnKTtcbiAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IHsgdG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbiB9O1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBmYWlsdXJlKCduZXR3b3JrJywgJ1BhbmVsOiDQvdC1INGD0LTQsNC70L7RgdGMINC/0YDQvtCy0LXRgNC40YLRjCDQstGF0L7QtC4g0J/RgNC+0LLQtdGA0YzRgtC1INGB0L7QtdC00LjQvdC10L3QuNC1INC4INC+0YLQutGA0YvRgtGD0Y4g0LLQutC70LDQtNC60YMgcGFuZWwuaGF0aWtvLnJ1LicpO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgIGlmIChmb3JjZSkge1xuICAgICAgICAgICAgICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID09PSBmbGlnaHQpIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG4gICAgICAgIH1cbiAgICB9KSgpO1xuICAgIGlmIChmb3JjZSkgZm9yY2VkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIGVsc2Ugbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gZmxpZ2h0O1xuICAgIHJldHVybiBmbGlnaHQucHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gZ2V0UGFuZWxTZXNzaW9uKGZvcmNlKSB7XG4gICAgaWYgKGZvcmNlKSBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgIGlmIChmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAocXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0KSByZXR1cm4gcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7XG4gICAgaWYgKGZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkge1xuICAgICAgICBjb25zdCBxdWV1ZWQgPSB7IHByb21pc2U6IG51bGwgfTtcbiAgICAgICAgcXVldWVkLnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0LnByb21pc2U7IH1cbiAgICAgICAgICAgIGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPT09IHF1ZXVlZCkgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodCh0cnVlKTtcbiAgICAgICAgfSkoKTtcbiAgICAgICAgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gcXVldWVkO1xuICAgICAgICByZXR1cm4gcXVldWVkLnByb21pc2U7XG4gICAgfVxuICAgIGlmICghZm9yY2UgJiYgcGFuZWxTZXNzaW9uICYmIERhdGUubm93KCkgLSBwYW5lbFNlc3Npb24uc2F2ZWRBdCA8IFBBTkVMX1NFU1NJT05fVFRMKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IHRydWUsIHRva2VuOiBwYW5lbFNlc3Npb24udG9rZW4gfSk7XG4gICAgaWYgKCFmb3JjZSAmJiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICByZXR1cm4gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpO1xufVxuIiwiLy8gU2hhcmVkIG9yZGVyIHBvbGxpbmcgaXMgaW5kZXBlbmRlbnQgb2YgdGhlIGxpZmV0aW1lL251bWJlciBvZiBjb250ZW50IHRhYnMuXG4vLyBTZXNzaW9uIHN0b3JhZ2UgaXMgZXh0ZW5zaW9uLXByaXZhdGU7IGJlYXJlciBuZXZlciBlbnRlcnMgYSBicm9hZGNhc3Qgb3IgbG9ncy5cbmNvbnN0IE9SREVSX1NFU1NJT05fS0VZID0gJ21lbWNoYXRPcmRlclNlcnZpY2VfdjEnO1xubGV0IG9yZGVyQ29uZmlnID0gbnVsbDtcbmxldCBvcmRlclN1YnNjcmliZXJzID0gbmV3IFNldCgpO1xubGV0IG9yZGVyUmV2aXNpb24gPSAwO1xubGV0IG9yZGVyRmxpZ2h0ID0gbnVsbDtcbmxldCBvcmRlckNvbnRyb2xsZXIgPSBudWxsO1xubGV0IG9yZGVyTGFzdFJlc3VsdCA9IG51bGw7XG5sZXQgb3JkZXJDb25maWdDaGFpbiA9IFByb21pc2UucmVzb2x2ZSgpO1xuZnVuY3Rpb24gb3JkZXJNdXRhdGUoY2FsbGJhY2spIHtcbiAgICBjb25zdCBuZXh0ID0gb3JkZXJDb25maWdDaGFpbi50aGVuKGNhbGxiYWNrKTtcbiAgICBvcmRlckNvbmZpZ0NoYWluID0gbmV4dC5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIG5leHQ7XG59XG5jb25zdCBvcmRlclJlYWR5ID0gKGFzeW5jICgpID0+IHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IChhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLmdldChPUkRFUl9TRVNTSU9OX0tFWSkpW09SREVSX1NFU1NJT05fS0VZXTtcbiAgICAgICAgaWYgKHNhdmVkKSB7IG9yZGVyQ29uZmlnID0gc2F2ZWQuY29uZmlnOyBvcmRlclJldmlzaW9uID0gc2F2ZWQucmV2aXNpb24gfHwgMDsgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoc2F2ZWQuc3Vic2NyaWJlcnMgfHwgW10pOyB9XG4gICAgfSBjYXRjaCB7IC8qIENvbmZpZ3VyZSBtdXN0IHN1Y2Nlc3NmdWxseSBwZXJzaXN0IGJlZm9yZSBlbmFibGluZyBwb2xsaW5nLiAqLyB9XG59KSgpO1xuZnVuY3Rpb24gb3JkZXJQdWJsaWNDb25maWcoKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNldHRpbmdzOiBvcmRlckNvbmZpZz8uc2V0dGluZ3MsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uIH07XG59XG5mdW5jdGlvbiBvcmRlclJlZmVyZW5jZSh2YWx1ZSwga2luZCkge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIG5ldyBSZWdFeHAoJ15odHRwczovL2FwaVxcXFwubW95c2tsYWRcXFxcLnJ1L2FwaS9yZW1hcC8xXFxcXC4yL2VudGl0eS8nICsga2luZCArICcvW0EtWmEtejAtOS1dKyQnKS50ZXN0KHZhbHVlKTtcbn1cbmZ1bmN0aW9uIG9yZGVyU2V0dGluZ3MocmF3KSB7XG4gICAgY29uc3QgcmVmcyA9ICh2YWx1ZXMsIGtpbmQpID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlcykgfHwgIXZhbHVlcy5ldmVyeSh2YWx1ZSA9PiBvcmRlclJlZmVyZW5jZSh2YWx1ZSwga2luZCkpKSB0aHJvdyBFcnJvcignSW52YWxpZCByZWZlcmVuY2VzJyk7XG4gICAgICAgIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMpXTtcbiAgICB9O1xuICAgIHJldHVybiB7IGVuYWJsZWQ6IHJhdz8uZW5hYmxlZCAhPT0gZmFsc2UsIHNvdW5kRW5hYmxlZDogcmF3Py5zb3VuZEVuYWJsZWQgIT09IGZhbHNlLFxuICAgICAgICBpbnRlcnZhbE1pbnV0ZXM6IE1hdGgubWluKDE0NDAsIE1hdGgubWF4KDEsIE1hdGgucm91bmQoTnVtYmVyKHJhdz8uaW50ZXJ2YWxNaW51dGVzKSB8fCAxKSkpLFxuICAgICAgICB0b2FzdER1cmF0aW9uTWludXRlczogTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChOdW1iZXIocmF3Py50b2FzdER1cmF0aW9uTWludXRlcykgfHwgMCkpKSxcbiAgICAgICAgb3JnYW5pemF0aW9uSHJlZnM6IHJlZnMocmF3Py5vcmdhbml6YXRpb25IcmVmcywgJ29yZ2FuaXphdGlvbicpLFxuICAgICAgICBzdGF0dXNIcmVmczogcmVmcyhyYXc/LnN0YXR1c0hyZWZzLCAnY3VzdG9tZXJvcmRlci9tZXRhZGF0YS9zdGF0ZXMnKSB9O1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJTZXRBbGFybSgpIHtcbiAgICBpZiAoIWNocm9tZS5hbGFybXMpIHJldHVybjtcbiAgICBpZiAob3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgJiYgb3JkZXJDb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuYWxhcm1zLmNyZWF0ZSgnbWVtY2hhdC1vcmRlcnMnLCB7IHBlcmlvZEluTWludXRlczogb3JkZXJDb25maWcuc2V0dGluZ3MuaW50ZXJ2YWxNaW51dGVzIH0pO1xuICAgIH0gZWxzZSBhd2FpdCBjaHJvbWUuYWxhcm1zLmNsZWFyKCdtZW1jaGF0LW9yZGVycycpO1xufVxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlT3JkZXJzKG1lc3NhZ2UsIHNlbmRlcikge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgaWYgKHR5cGVvZiBtZXNzYWdlLnRva2VuICE9PSAnc3RyaW5nJyB8fCAhbWVzc2FnZS50b2tlbi50cmltKCkgfHwgbWVzc2FnZS50b2tlbi5sZW5ndGggPiA0MDk2KSB0aHJvdyBFcnJvcignSW52YWxpZCB0b2tlbicpO1xuICAgIGNvbnN0IHNldHRpbmdzID0gb3JkZXJTZXR0aW5ncyhtZXNzYWdlLnNldHRpbmdzKTtcbiAgICBjb25zdCB1bmNoYW5nZWQgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gJiYgSlNPTi5zdHJpbmdpZnkob3JkZXJDb25maWcuc2V0dGluZ3MpID09PSBKU09OLnN0cmluZ2lmeShzZXR0aW5ncyk7XG4gICAgaWYgKG9yZGVyQ29uZmlnICYmIChtZXNzYWdlLnVwZGF0ZSAhPT0gdHJ1ZSB8fCB1bmNoYW5nZWQpKSB7XG4gICAgICAgIGlmIChvcmRlckNvbmZpZy50b2tlbiAhPT0gbWVzc2FnZS50b2tlbikgcmV0dXJuIHsgb2s6IGZhbHNlLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiwgZXJyb3I6ICfQlNGA0YPQs9C+0LkgQmVhcmVyINCyINGE0L7QvdC1LiDQodC+0YXRgNCw0L3QuNGC0LUg0L3QsNGB0YLRgNC+0LnQutC4INGP0LLQvdC+INC00LvRjyDRgdC80LXQvdGLINCw0LrQutCw0YPQvdGC0LAuJyB9O1xuICAgICAgICBvcmRlclN1YnNjcmliZXJzLmFkZChzZW5kZXIudGFiLmlkKTtcbiAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgIGlmIChjaHJvbWUuYWxhcm1zPy5nZXQgJiYgIShhd2FpdCBjaHJvbWUuYWxhcm1zLmdldCgnbWVtY2hhdC1vcmRlcnMnKSkpIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgcmV0dXJuIG9yZGVyUHVibGljQ29uZmlnKCk7XG4gICAgfVxuICAgIGlmIChvcmRlckNvbmZpZyAmJiBtZXNzYWdlLnJldmlzaW9uICE9PSBvcmRlclJldmlzaW9uKSByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBvazogZmFsc2UsIGNvbmZsaWN0OiB0cnVlLCBlcnJvcjogJ9Cd0LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLINCyINC00YDRg9Cz0L7QuSDQstC60LvQsNC00LrQtS4g0J/QvtCy0YLQvtGA0LjRgtC1INC40LfQvNC10L3QtdC90LjQtS4nIH07XG4gICAgY29uc3Qgc3Vic2NyaWJlcnMgPSBvcmRlckNvbmZpZz8udG9rZW4gPT09IG1lc3NhZ2UudG9rZW4gPyBuZXcgU2V0KG9yZGVyU3Vic2NyaWJlcnMpIDogbmV3IFNldCgpO1xuICAgIHN1YnNjcmliZXJzLmFkZChzZW5kZXIudGFiLmlkKTtcbiAgICBjb25zdCBjb25maWcgPSB7IHRva2VuOiBtZXNzYWdlLnRva2VuLCBzZXR0aW5ncywgb3JnYW5pemF0aW9uczogKEFycmF5LmlzQXJyYXkobWVzc2FnZS5vcmdhbml6YXRpb25zKSA/IG1lc3NhZ2Uub3JnYW5pemF0aW9ucyA6IFtdKVxuICAgICAgICAuZmlsdGVyKGl0ZW0gPT4gc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMuaW5jbHVkZXMoaXRlbT8uaHJlZikpLm1hcChpdGVtID0+ICh7IGhyZWY6IGl0ZW0uaHJlZiwgbmFtZTogU3RyaW5nKGl0ZW0ubmFtZSB8fCAnJykuc2xpY2UoMCwgMzAwKSB9KSkgfTtcbiAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiArIDEsIHN1YnNjcmliZXJzOiBbLi4uc3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgb3JkZXJDb250cm9sbGVyPy5hYm9ydCgpO1xuICAgIG9yZGVyQ29uZmlnID0gY29uZmlnOyBvcmRlclN1YnNjcmliZXJzID0gc3Vic2NyaWJlcnM7IG9yZGVyUmV2aXNpb24rKzsgb3JkZXJMYXN0UmVzdWx0ID0gbnVsbDtcbiAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgcmV0dXJuIG9yZGVyUHVibGljQ29uZmlnKCk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlckdldChwYXRoLCBjb25maWcsIGNvbnRyb2xsZXIpIHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHBlcmZvcm1SZXF1ZXN0KHsgaWQ6ICdiYWNrZ3JvdW5kLW9yZGVycycsIHJlcXVlc3Q6IHtcbiAgICAgICAgdXJsOiAnaHR0cHM6Ly9hcGkubW95c2tsYWQucnUvYXBpL3JlbWFwLzEuMicgKyBwYXRoLCBtZXRob2Q6ICdHRVQnLFxuICAgICAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246ICdCZWFyZXIgJyArIGNvbmZpZy50b2tlbiwgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04JyB9LFxuICAgICAgICBhbm9ueW1vdXM6IHRydWUsIGJhY2tncm91bmRPcmRlcjogdHJ1ZVxuICAgIH0gfSwgeyB0YWI6IHsgaWQ6IC0xIH0sIGZyYW1lSWQ6IDAgfSwgY29udHJvbGxlci5zaWduYWwpO1xuICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcpIHRocm93IEVycm9yKCdDYW5jZWxsZWQnKTtcbiAgICBpZiAocmVzcG9uc2UuZXZlbnQgIT09ICdsb2FkJykgdGhyb3cgRXJyb3IoJ9Ce0YjQuNCx0LrQsCDRgdC+0LXQtNC40L3QtdC90LjRjyDRgSDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgY29uc3Qgc3RhdHVzID0gcmVzcG9uc2UucmVzcG9uc2Uuc3RhdHVzO1xuICAgIGlmIChzdGF0dXMgPCAyMDAgfHwgc3RhdHVzID49IDMwMCkgeyBjb25zdCBlcnJvciA9IEVycm9yKCfQnNC+0LnQodC60LvQsNC0OiBIVFRQICcgKyBzdGF0dXMpOyBlcnJvci5zdGF0dXMgPSBzdGF0dXM7IHRocm93IGVycm9yOyB9XG4gICAgbGV0IGRhdGE7XG4gICAgdHJ5IHsgZGF0YSA9IEpTT04ucGFyc2UocmVzcG9uc2UucmVzcG9uc2UucmVzcG9uc2VUZXh0KTsgfSBjYXRjaCB7IHRocm93IEVycm9yKCfQndC10LrQvtGA0YDQtdC60YLQvdGL0Lkg0L7RgtCy0LXRgiDQnNC+0LnQodC60LvQsNC0Jyk7IH1cbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YT8ucm93cykpIHRocm93IEVycm9yKCfQndC10L/QvtC70L3Ri9C5INC+0YLQstC10YIg0YHQv9C40YHQutCwINC30LDQutCw0LfQvtCyJyk7XG4gICAgcmV0dXJuIGRhdGE7XG59XG5hc3luYyBmdW5jdGlvbiBkZWxpdmVyT3JkZXJSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIsIHJldmlzaW9uKSB7XG4gICAgaWYgKCFjaHJvbWUudGFicz8ucXVlcnkpIHJldHVybjtcbiAgICBjb25zdCB0YWJzID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoe30pO1xuICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gdGFicy5maWx0ZXIodGFiID0+IG9yZGVyU3Vic2NyaWJlcnMuaGFzKHRhYi5pZCkgJiYgdHJ1c3RlZENvbnRlbnRTZW5kZXIoeyBpZDogY2hyb21lLnJ1bnRpbWUuaWQsIHRhYiwgZnJhbWVJZDogMCwgdXJsOiB0YWIudXJsIH0pKTtcbiAgICBjYW5kaWRhdGVzLnNvcnQoKGEsIGIpID0+IE51bWJlcighIWIuYWN0aXZlKSAtIE51bWJlcighIWEuYWN0aXZlKSk7XG4gICAgZm9yIChjb25zdCB0YWIgb2YgY2FuZGlkYXRlcykge1xuICAgICAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGFjayA9IGF3YWl0IGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgeyB0eXBlOiAnbWVtY2hhdDpvcmRlcnMtcmVzdWx0JywgcmVzdWx0LCByZXZpc2lvbiwgc2V0dGluZ3M6IGNvbmZpZy5zZXR0aW5ncyB9LCB7IGZyYW1lSWQ6IDAgfSk7XG4gICAgICAgICAgICBpZiAoYWNrPy5vaykgYnJlYWs7XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBUcnkgYW5vdGhlciBsaXZlIGNvbnRlbnQgd29ybGQsIG5vdCBldmVyeSB0YWIuICovIH1cbiAgICB9XG59XG5hc3luYyBmdW5jdGlvbiBwb2xsT3JkZXJzKCkge1xuICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgYXdhaXQgb3JkZXJDb25maWdDaGFpbjtcbiAgICBpZiAob3JkZXJGbGlnaHQpIHJldHVybiBvcmRlckZsaWdodDtcbiAgICBjb25zdCBjb25maWcgPSBvcmRlckNvbmZpZztcbiAgICBpZiAoIWNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCB8fCAhY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCB8fCAhY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmxlbmd0aCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLRi9C60LvRjtGH0LXQvSDQuNC70Lgg0L3QtSDQvdCw0YHRgtGA0L7QtdC9JyB9O1xuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IHJldmlzaW9uID0gb3JkZXJSZXZpc2lvbjtcbiAgICAgICAgb3JkZXJDb250cm9sbGVyID0gY29udHJvbGxlcjtcbiAgICBvcmRlckZsaWdodCA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gbmV3IE1hcCgpLCBmYWlsZWQgPSBbXTtcbiAgICAgICAgbGV0IGF1dGhGYWlsZWQgPSBmYWxzZTtcbiAgICAgICAgZm9yIChjb25zdCBocmVmIG9mIGNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcykge1xuICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBjb25maWcub3JnYW5pemF0aW9ucy5maW5kKGl0ZW0gPT4gaXRlbS5ocmVmID09PSBocmVmKT8ubmFtZSB8fCAn0J7RgNCz0LDQvdC40LfQsNGG0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsCc7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBuZXcgTWFwKCk7XG4gICAgICAgICAgICAgICAgbGV0IG9mZnNldCA9IDA7XG4gICAgICAgICAgICAgICAgZm9yICg7Oykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBmaWx0ZXIgPSBbJ29yZ2FuaXphdGlvbj0nICsgaHJlZiwgLi4uY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLm1hcChzdGF0ZSA9PiAnc3RhdGU9JyArIHN0YXRlKV0uam9pbignOycpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgb3JkZXJHZXQoJy9lbnRpdHkvY3VzdG9tZXJvcmRlcj9maWx0ZXI9JyArIGVuY29kZVVSSUNvbXBvbmVudChmaWx0ZXIpXG4gICAgICAgICAgICAgICAgICAgICAgICArICcmZXhwYW5kPXN0YXRlLG9yZ2FuaXphdGlvbiZvcmRlcj1tb21lbnQsZGVzYyZsaW1pdD0xMDAmb2Zmc2V0PScgKyBvZmZzZXQsIGNvbmZpZywgY29udHJvbGxlcik7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gcm93cy5zaXplO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiBkYXRhLnJvd3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghcm93Py5pZCkgdGhyb3cgRXJyb3IoJ9CX0LDQutCw0Lcg0LHQtdC3INC40LTQtdC90YLQuNGE0LjQutCw0YLQvtGA0LAnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd3Muc2V0KHJvdy5pZCwgcm93KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBvZmZzZXQgKz0gZGF0YS5yb3dzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW9yZSA9ICEhZGF0YS5tZXRhPy5uZXh0SHJlZiB8fCAoTnVtYmVyLmlzRmluaXRlKGRhdGEubWV0YT8uc2l6ZSkgPyBvZmZzZXQgPCBkYXRhLm1ldGEuc2l6ZSA6IGRhdGEucm93cy5sZW5ndGggPj0gMTAwKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3JlKSBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFkYXRhLnJvd3MubGVuZ3RoIHx8IHJvd3Muc2l6ZSA9PT0gcHJldmlvdXMpIHRocm93IEVycm9yKCfQn9Cw0LPQuNC90LDRhtC40Y8g0LfQsNC60LDQt9C+0LIg0L3QtSDQv9GA0L7QtNCy0LjQs9Cw0LXRgtGB0Y8nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCByb3cgb2Ygcm93cy52YWx1ZXMoKSkgaWYgKGNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5pbmNsdWRlcyhyb3cuc3RhdGU/Lm1ldGE/LmhyZWYpKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvdW5kLnNldChyb3cuaWQsIHsgaWQ6IHJvdy5pZCwgbmFtZTogcm93Lm5hbWUgfHwgcm93LmlkLCBzdGF0ZU5hbWU6IHJvdy5zdGF0ZT8ubmFtZSB8fCAn0J3QvtCy0YvQuScsIG9yZ2FuaXphdGlvbk5hbWU6IGxhYmVsLCBvcmdhbml6YXRpb25IcmVmOiBocmVmIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L06INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLJyB9O1xuICAgICAgICAgICAgICAgIGZhaWxlZC5wdXNoKGxhYmVsICsgJyDigJQgJyArIChlcnJvci5tZXNzYWdlIHx8ICfQntGI0LjQsdC60LAg0LfQsNC/0YDQvtGB0LAnKSk7XG4gICAgICAgICAgICAgICAgaWYgKFs0MDEsIDQwM10uaW5jbHVkZXMoZXJyb3Iuc3RhdHVzKSkgeyBhdXRoRmFpbGVkID0gdHJ1ZTsgYnJlYWs7IH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScgfTtcbiAgICAgICAgaWYgKGF1dGhGYWlsZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICAgICAgICAgICAgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnLCByZXZpc2lvbjogKytvcmRlclJldmlzaW9uLCBzdWJzY3JpYmVyczogWy4uLm9yZGVyU3Vic2NyaWJlcnNdIH0gfSk7XG4gICAgICAgICAgICAgICAgYXdhaXQgb3JkZXJTZXRBbGFybSgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L0nIH07XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHsgaWQ6IFN0cmluZyhEYXRlLm5vdygpKSArICctJyArIG9yZGVyUmV2aXNpb24sIG9yZGVyczogWy4uLmZvdW5kLnZhbHVlcygpXSwgZmFpbGVkLCBwYXJ0aWFsOiBmYWlsZWQubGVuZ3RoID4gMCxcbiAgICAgICAgICAgIGJlYXJlcjogYXV0aEZhaWxlZCA/ICdlcnJvcicgOiBmYWlsZWQubGVuZ3RoID09PSBjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoID8gJ3Vua25vd24nIDogJ29rJywgYXQ6IERhdGUubm93KCkgfTtcbiAgICAgICAgcmVzdWx0Lm9yZGVycy5mb3JFYWNoKG9yZGVyID0+IHsgb3JkZXIucGFydGlhbCA9IHJlc3VsdC5wYXJ0aWFsOyB9KTtcbiAgICAgICAgb3JkZXJMYXN0UmVzdWx0ID0gcmVzdWx0O1xuICAgICAgICBhd2FpdCBkZWxpdmVyT3JkZXJSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIsIHJldmlzaW9uKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlc3VsdCB9O1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyRmxpZ2h0ID0gbnVsbDsgaWYgKG9yZGVyQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgb3JkZXJDb250cm9sbGVyID0gbnVsbDsgfSk7XG4gICAgcmV0dXJuIG9yZGVyRmxpZ2h0O1xufVxuaWYgKGNocm9tZS5hbGFybXMpIGNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihhbGFybSA9PiB7XG4gICAgaWYgKGFsYXJtLm5hbWUgPT09ICdtZW1jaGF0LW9yZGVycycpIHJldHVybiBwb2xsT3JkZXJzKCkuY2F0Y2goKCkgPT4ge30pO1xufSk7XG4iLCIndXNlIHN0cmljdCc7XG5cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZSwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgICBpZiAoWydtZW1jaGF0OnN0b3JhZ2UtaW5pdCcsICdtZW1jaGF0OnN0b3JhZ2Utd3JpdGUnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkge1xuICAgICAgICBpZiAoIXRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikpIHsgc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ9CX0LDQv9GA0L7RgSDRhdGA0LDQvdC40LvQuNGJ0LAg0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBwcml2YXRlU3RvcmFnZU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKS50aGVuKHNlbmRSZXNwb25zZSxcbiAgICAgICAgICAgICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQtNCw0L3QvdGL0LUg0YDQsNGB0YjQuNGA0LXQvdC40Y8uINCf0LXRgNC10LfQsNCz0YDRg9C30LjRgtC1INCy0LrQu9Cw0LTQutGDOyDRgdGC0LDRgNGL0LUg0LTQsNC90L3Ri9C1INC90LUg0YPQtNCw0LvQtdC90YsuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoWydtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnLCAnbWVtY2hhdDpvcmRlcnMtcG9sbCcsICdtZW1jaGF0Om9yZGVycy1zdG9wJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCF0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBjb25zdCB3b3JrID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgb3JkZXJSZWFkeTtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnKSByZXR1cm4gb3JkZXJNdXRhdGUoKCkgPT4gY29uZmlndXJlT3JkZXJzKG1lc3NhZ2UsIHNlbmRlcikpO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6b3JkZXJzLXN0b3AnKSByZXR1cm4gb3JkZXJNdXRhdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghb3JkZXJDb25maWcgfHwgbWVzc2FnZS50b2tlbiAhPT0gb3JkZXJDb25maWcudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdCZWFyZXIg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0YTQvtC90L7QstGL0Lwg0L7Qv9GA0L7RgdC+0LwnIH07XG4gICAgICAgICAgICAgICAgb3JkZXJDb250cm9sbGVyPy5hYm9ydCgpO1xuICAgICAgICAgICAgICAgIG9yZGVyQ29uZmlnLnNldHRpbmdzLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zZXNzaW9uLnNldCh7IFtPUkRFUl9TRVNTSU9OX0tFWV06IHsgY29uZmlnOiBvcmRlckNvbmZpZywgcmV2aXNpb246ICsrb3JkZXJSZXZpc2lvbiwgc3Vic2NyaWJlcnM6IFsuLi5vcmRlclN1YnNjcmliZXJzXSB9IH0pO1xuICAgICAgICAgICAgICAgIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gb3JkZXJQdWJsaWNDb25maWcoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYXdhaXQgb3JkZXJDb25maWdDaGFpbjtcbiAgICAgICAgICAgIGlmICghb3JkZXJDb25maWcgfHwgbWVzc2FnZS50b2tlbiAhPT0gb3JkZXJDb25maWcudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdCZWFyZXIg0L3QtSDRgdC+0LLQv9Cw0LTQsNC10YIg0YEg0YTQvtC90L7QstGL0Lwg0L7Qv9GA0L7RgdC+0LwnIH07XG4gICAgICAgICAgICByZXR1cm4gcG9sbE9yZGVycygpO1xuICAgICAgICB9O1xuICAgICAgICB3b3JrKCkudGhlbihzZW5kUmVzcG9uc2UsICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQndC1INGD0LTQsNC70L7RgdGMINC90LDRgdGC0YDQvtC40YLRjCDRhNC+0L3QvtCy0YvQuSDQvtC/0YDQvtGBJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6cGFuZWwtY3NyZicpIHtcbiAgICAgICAgaWYgKCF0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpIHx8IChtZXNzYWdlLmZvcmNlICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIG1lc3NhZ2UuZm9yY2UgIT09ICdib29sZWFuJykpIHtcbiAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgZ2V0UGFuZWxTZXNzaW9uKG1lc3NhZ2UuZm9yY2UgPT09IHRydWUpLnRoZW4oc2VuZFJlc3BvbnNlLFxuICAgICAgICAgICAgKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IGZhbHNlLCBlcnJvcjogJ1BhbmVsOiDRhNC+0L3QvtCy0LDRjyDRgdC10YHRgdC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAuJyB9KSk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoIVsnbWVtY2hhdDpodHRwJywgJ21lbWNoYXQ6YWJvcnQnXS5pbmNsdWRlcyhtZXNzYWdlPy50eXBlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtekEtWjAtOS1dezEsODB9JC8udGVzdChtZXNzYWdlLmlkKSkge1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ21lbWNoYXQ6YWJvcnQnKSB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCkpO1xuICAgICAgICBpZiAoZW50cnkpIHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH1cbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcGVyZm9ybVJlcXVlc3QobWVzc2FnZSwgc2VuZGVyKS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQuZXZlbnQgPT09ICdsb2FkJyAmJiBbNDAxLCA0MDMsIDQxOV0uaW5jbHVkZXMocmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpXG4gICAgICAgICAgICAmJiBuZXcgVVJMKG1lc3NhZ2UucmVxdWVzdC51cmwpLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1Jykge1xuICAgICAgICAgICAgY29uc3Qgc2VudFRva2VuID0gbmV3IEhlYWRlcnMobWVzc2FnZS5yZXF1ZXN0LmhlYWRlcnMgfHwge30pLmdldCgneC1jc3JmLXRva2VuJyk7XG4gICAgICAgICAgICBpZiAoc2VudFRva2VuICYmIHNlbnRUb2tlbiA9PT0gcGFuZWxTZXNzaW9uPy50b2tlbikge1xuICAgICAgICAgICAgICAgIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgICAgICAgICAgcmVzdWx0LnBhbmVsQXV0aExvc3QgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHNlbmRSZXNwb25zZShyZXN1bHQpO1xuICAgIH0sICgpID0+IHNlbmRSZXNwb25zZSh7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ9Cd0LXQtNC+0L/Rg9GB0YLQuNC80YvQuSDQt9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn0pO1xuXG4vLyBSZWdpc3RlciB0b29sYmFyL2NvbnRleHQtbWVudSBsaXN0ZW5lcnMgc3luY2hyb25vdXNseSBvbiBldmVyeSB3b3JrZXIgd2FrZS5cbmltcG9ydFNjcmlwdHMoJ2NvbnRyb2xzLmpzJyk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EifQ==
