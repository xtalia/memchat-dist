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
    await chrome.action.setTitle({ title: enabled ? '🐻 Оповещатель включён · Показать / скрыть Мемчат' : 'Показать / скрыть Мемчат' });
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
/* module: extension/worker.js */
'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'memchat:orders-test-sound') {
        if (!trustedContentSender(sender)) { sendResponse({ ok: false, error: 'Запрос расширения отклонён' }); return false; }
        orderPlayAudio().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, error: 'Звук расширения недоступен' }));
        return true;
    }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2VyLmpzIiwic291cmNlcyI6WyJleHRlbnNpb24vc3RvcmFnZS1zY2hlbWEuanMiLCJleHRlbnNpb24vc3RvcmFnZS13b3JrZXIuanMiLCJleHRlbnNpb24vd29ya2VyL25ldHdvcmsuanMiLCJleHRlbnNpb24vd29ya2VyL3BhbmVsLXNlc3Npb24uanMiLCJleHRlbnNpb24vd29ya2VyL29yZGVyLWFsZXJ0cy5qcyIsImV4dGVuc2lvbi93b3JrZXIvb3JkZXJzLmpzIiwiZXh0ZW5zaW9uL3dvcmtlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBCdW5kbGVkIGludG8gd29ya2VyIGFuZCBpc29sYXRlZCBjb250ZW50OyBuZXZlciBleHBvc2VkIGluIHRoZSBwYWdlIHdvcmxkLlxuY29uc3QgTUVNQ0hBVF9TVE9SQUdFX0tFWVMgPSBuZXcgU2V0KFtcbiAgICAnZGVidWcnLCAnY2FsY1J1bGVzX3YyJywgJ3NjaGVkdWxlUmVwbGFjZW1lbnRzX3YxJywgJ3NjaGVkdWxlQ2FjaGVFbmFibGVkX3YxJyxcbiAgICAnc2NoZWR1bGVDYWNoZV92MV90b2RheScsICdzY2hlZHVsZUNhY2hlX3YxX3RvbW9ycm93JywgJ3NlbGVjdGVkQWN0aW9uX3YxJyxcbiAgICAnc2hvd0hhdGlrb0xpbmtzX3YxJywgJ2hhdGlrb1NlYXJjaE1vZGVfdjEnLCAncmV0cnlCZWhhdmlvcl92MScsICdoaWRkZW5GaWVsZHNfdjEnLFxuICAgICdtc1F1aWNrUGFuZWxfdjEnLCAnZmxvYXRXaW5kb3dQb3NfdjEnLCAnY2hhdEhpc3RvcnlfdjEnLCAnY2xlYXJUZXh0RGVsYXlfdjEnLFxuICAgICdjbGVhclRleHRFbmFibGVkJywgJ2hhY2tlckRlZmF1bHRDaGFubmVsX3YxJywgJ2hhY2tlclF1aWNrQnV0dG9uc192MScsXG4gICAgJ21zTWFnaWNDb25maWdfdjEnLCAnbXNGaWVsZHNTcG9pbGVyT3Blbl92MScsICdtc1JlZmVyZW5jZUNhY2hlX3YxJyxcbiAgICAnaGFja2VyTXNBcGlfdjEnLCAnaGFja2VyU3RhdGVzX3YxJywgJ2hhY2tlck9yZGVyTm90aWZpZXJfdjEnLFxuICAgICdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnNfdjEnLCAnaGFja2VyTm90aWZpZXJTZWVuX3YxJyxcbiAgICAnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrX3YxJywgJ2hhY2tlckludGVybmFsT3JkZXJXYXJlaG91c2VzX3YxJ1xuXS5tYXAoa2V5ID0+ICdtZW1jaGF0OicgKyBrZXkpLmNvbmNhdChbJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MSddKSk7XG5jb25zdCBNRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbJ21lbWNoYXQ6cGFuZWxDc3JmX3YxJywgJ2NsZWFyVGV4dEVuYWJsZWQnXSk7XG5mdW5jdGlvbiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgdmFsdWUpIHtcbiAgICBpZiAoa2V5ID09PSAnbWVtY2hhdDpjaGF0SGlzdG9yeV92MScpIHtcbiAgICAgICAgdHJ5IHsgY29uc3QgaGlzdG9yeSA9IEpTT04ucGFyc2UodmFsdWUpO1xuICAgICAgICAgICAgaWYgKGhpc3RvcnkgJiYgdHlwZW9mIGhpc3RvcnkgPT09ICdvYmplY3QnICYmICFBcnJheS5pc0FycmF5KGhpc3RvcnkpKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGhpc3RvcnkuY2hlY2tIYXRpa29Cb251c2VzO1xuICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShoaXN0b3J5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7IC8qIFByZXNlcnZlIG1hbGZvcm1lZCBleGlzdGluZyBkYXRhLCBub3QgYSBmYWJyaWNhdGVkIHJlcGxhY2VtZW50LiAqLyB9XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cbiIsIi8vIFByaXZhdGUgc3RvcmFnZSBpcyBvcmlnaW4tc2NvcGVkIHRvIHByZXNlcnZlIGV4aXN0aW5nIHNpdGUvYWNjb3VudCBzZXBhcmF0aW9uLlxuLy8gQ2hyb21lIG93bnMgcGVyc2lzdGVuY2U7IHBhZ2UgbG9jYWxTdG9yYWdlIGlzIHVzZWQgb25seSBmb3Igb25lLXRpbWUgbWlncmF0aW9uLlxuY29uc3QgcHJpdmF0ZVN0b3JhZ2VSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0QWNjZXNzTGV2ZWwoeyBhY2Nlc3NMZXZlbDogJ1RSVVNURURfQ09OVEVYVFMnIH0pO1xufSkoKTtcbi8vIEhhbmRsZSBpbml0aWFsaXphdGlvbiByZWplY3Rpb24gaW1tZWRpYXRlbHksIHdoaWxlIHJldGFpbmluZyBmYWlsLWNsb3NlZCBhd2FpdHMuXG5wcml2YXRlU3RvcmFnZVJlYWR5LmNhdGNoKCgpID0+IHt9KTtcbmxldCBwcml2YXRlU3RvcmFnZUNoYWluID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5jb25zdCBwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzID0gbmV3IE1hcCgpO1xuZnVuY3Rpb24gcHJpdmF0ZVN0b3JhZ2VTbmFwc2hvdChidWNrZXQpIHtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW2J1Y2tldC52ZXJzaW9uLCBPYmplY3Qua2V5cyhidWNrZXQuaXRlbXMpLnNvcnQoKS5tYXAoa2V5ID0+XG4gICAgICAgIFtrZXksIGJ1Y2tldC5pdGVtc1trZXldLnJldmlzaW9uLCBidWNrZXQuaXRlbXNba2V5XS52YWx1ZV0pLFxuICAgIE9iamVjdC5rZXlzKGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHwge30pLnNvcnQoKS5tYXAoa2V5ID0+IFtrZXksIGJ1Y2tldC5sZWdhY3lCYWNrdXBba2V5XV0pXSk7XG59XG5hc3luYyBmdW5jdGlvbiBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgYXV0aG9yaXphdGlvbikge1xuICAgIGF3YWl0IHByaXZhdGVTdG9yYWdlUmVhZHk7XG4gICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VDaGFpbjtcbiAgICBjb25zdCBrZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIG5ldyBVUkwoc2VuZGVyLnVybCB8fCBzZW5kZXIudGFiLnVybCkub3JpZ2luO1xuICAgIGNvbnN0IHNhdmVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChrZXkpKVtrZXldO1xuICAgIGNvbnN0IGFwaSA9IEpTT04ucGFyc2Uoc2F2ZWQ/Lml0ZW1zWydtZW1jaGF0OmhhY2tlck1zQXBpX3YxJ10/LnZhbHVlIHx8ICd7fScpO1xuICAgIHJldHVybiBhcGkuYmVhcmVyRW5hYmxlZCA9PT0gdHJ1ZSAmJiB0eXBlb2YgYXBpLnRva2VuID09PSAnc3RyaW5nJyAmJiBhdXRob3JpemF0aW9uID09PSAnQmVhcmVyICcgKyBhcGkudG9rZW47XG59XG5mdW5jdGlvbiBwcml2YXRlU3RvcmFnZU1lc3NhZ2UobWVzc2FnZSwgc2VuZGVyKSB7XG4gICAgY29uc3Qgb3BlcmF0aW9uID0gcHJpdmF0ZVN0b3JhZ2VDaGFpbi50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQgcHJpdmF0ZVN0b3JhZ2VSZWFkeTtcbiAgICAgICAgY29uc3Qgb3JpZ2luID0gbmV3IFVSTChzZW5kZXIudXJsIHx8IHNlbmRlci50YWIudXJsKS5vcmlnaW47XG4gICAgICAgIGNvbnN0IHN0b3JhZ2VLZXkgPSAnbWVtY2hhdFByaXZhdGVfdjE6JyArIG9yaWdpbjtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KHN0b3JhZ2VLZXkpKVtzdG9yYWdlS2V5XTtcbiAgICAgICAgY29uc3QgYnVja2V0ID0gc2F2ZWQgfHwgeyB2ZXJzaW9uOiAxLCBpdGVtczoge30sIGxlZ2FjeUJhY2t1cDoge30gfTtcbiAgICAgICAgaWYgKGJ1Y2tldC52ZXJzaW9uICE9PSAxIHx8ICFidWNrZXQuaXRlbXMgfHwgdHlwZW9mIGJ1Y2tldC5pdGVtcyAhPT0gJ29iamVjdCcpIHRocm93IEVycm9yKCdJbnZhbGlkIHNjaGVtYScpO1xuICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLWluaXQnKSB7XG4gICAgICAgICAgICBjb25zdCBsZWdhY3kgPSBtZXNzYWdlLmxlZ2FjeTtcbiAgICAgICAgICAgIGlmICghbGVnYWN5IHx8IHR5cGVvZiBsZWdhY3kgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkobGVnYWN5KSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgbGVnYWN5IHNuYXBzaG90Jyk7XG4gICAgICAgICAgICBjb25zdCBjbGVhbnVwID0gW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtrZXksIHJhd10gb2YgT2JqZWN0LmVudHJpZXMobGVnYWN5KSkge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgcmF3ICE9PSAnc3RyaW5nJyB8fCByYXcubGVuZ3RoID4gNSAqIDEwMjQgKiAxMDI0KSB0aHJvdyBFcnJvcignSW52YWxpZCB2YWx1ZScpO1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICdjbGVhclRleHRFbmFibGVkJyAmJiBbJ3RydWUnLCAnZmFsc2UnXS5pbmNsdWRlcyhyYXcpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghT2JqZWN0Lmhhc093bihidWNrZXQuaXRlbXMsICdtZW1jaGF0OmNsZWFyVGV4dEVuYWJsZWQnKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBbJ3RydWUnLCAnZmFsc2UnXS5pbmNsdWRlcyhsZWdhY3lbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddKSA/IGxlZ2FjeVsnbWVtY2hhdDpjbGVhclRleHRFbmFibGVkJ10gOiByYXc7XG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXQuaXRlbXNbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddID0geyB2YWx1ZSwgcmV2aXNpb246IDEgfTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChidWNrZXQuaXRlbXNbJ21lbWNoYXQ6Y2xlYXJUZXh0RW5hYmxlZCddLnZhbHVlICE9PSByYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHw9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0LmxlZ2FjeUJhY2t1cC5jbGVhclRleHRFbmFibGVkID0gcmF3O1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChNRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTLmhhcyhrZXkpKSB7IGNsZWFudXAucHVzaChrZXkpOyBjb250aW51ZTsgfVxuICAgICAgICAgICAgICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHJhdyk7XG4gICAgICAgICAgICAgICAgaWYgKCFzYXZlZCkgYnVja2V0Lml0ZW1zW2tleV0gPSB7IHZhbHVlLCByZXZpc2lvbjogMSB9O1xuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGJ1Y2tldC5pdGVtc1trZXldPy52YWx1ZSAhPT0gdmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQW4gb2xkZXIgdXNlcnNjcmlwdCBtYXkgcmVjcmVhdGUgb2xkIGtleXMuIFByZXNlcnZlIHRoYXQgY29weVxuICAgICAgICAgICAgICAgICAgICAvLyBwcml2YXRlbHksIGJ1dCBuZXZlciByb2xsIGJhY2sgdGhlIGNhbm9uaWNhbCBleHRlbnNpb24gc3RhdGUuXG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5sZWdhY3lCYWNrdXAgfHw9IHt9O1xuICAgICAgICAgICAgICAgICAgICBidWNrZXQubGVnYWN5QmFja3VwW2tleV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY2xlYW51cC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBBY2tub3dsZWRnZSBvbmx5IGFmdGVyIENocm9tZSBjb21taXRzIGFuZCBhIHJlYWQtYmFjayB2ZXJpZmllcyBpdC5cbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtzdG9yYWdlS2V5XTogYnVja2V0IH0pO1xuICAgICAgICAgICAgY29uc3QgY29tbWl0dGVkID0gKGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChzdG9yYWdlS2V5KSlbc3RvcmFnZUtleV07XG4gICAgICAgICAgICBpZiAoIWNvbW1pdHRlZCB8fCBwcml2YXRlU3RvcmFnZVNuYXBzaG90KGNvbW1pdHRlZCkgIT09IHByaXZhdGVTdG9yYWdlU25hcHNob3QoYnVja2V0KSkgdGhyb3cgRXJyb3IoJ1N0b3JhZ2UgdmVyaWZpY2F0aW9uIGZhaWxlZCcpO1xuICAgICAgICAgICAgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycy5zZXQoc2VuZGVyLnRhYi5pZCwgeyBvcmlnaW4sIGRvY3VtZW50SWQ6IHNlbmRlci5kb2N1bWVudElkIH0pO1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGl0ZW1zOiBjb21taXR0ZWQuaXRlbXMsIGNsZWFudXAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJykge1xuICAgICAgICAgICAgY29uc3QgeyBrZXksIHJldmlzaW9uIH0gPSBtZXNzYWdlO1xuICAgICAgICAgICAgaWYgKCFNRU1DSEFUX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIocmV2aXNpb24pIHx8IHJldmlzaW9uIDwgMFxuICAgICAgICAgICAgICAgIHx8IChtZXNzYWdlLnZhbHVlICE9PSBudWxsICYmICh0eXBlb2YgbWVzc2FnZS52YWx1ZSAhPT0gJ3N0cmluZycgfHwgbWVzc2FnZS52YWx1ZS5sZW5ndGggPiA1ICogMTAyNCAqIDEwMjQpKSkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgd3JpdGUnKTtcbiAgICAgICAgICAgIGNvbnN0IHByZXZpb3VzID0gYnVja2V0Lml0ZW1zW2tleV0gfHwgeyB2YWx1ZTogbnVsbCwgcmV2aXNpb246IDAgfTtcbiAgICAgICAgICAgIGlmIChwcmV2aW91cy5yZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgbWVzc2FnZS5wcmV2aW91c1ZhbHVlICE9PSBwcmV2aW91cy52YWx1ZSkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjb25mbGljdDogdHJ1ZSwgaXRlbTogcHJldmlvdXMsXG4gICAgICAgICAgICAgICAgZXJyb3I6ICfQndCw0YHRgtGA0L7QudC60Lgg0LjQt9C80LXQvdC10L3RiyDQsiDQtNGA0YPQs9C+0Lkg0LLQutC70LDQtNC60LUuINCf0LXRgNC10LfQsNCz0YDRg9C30LjRgtC1INGN0YLRgyDQstC60LvQsNC00LrRgy4nIH07XG4gICAgICAgICAgICBjb25zdCBpdGVtID0geyB2YWx1ZTogbWVzc2FnZS52YWx1ZSA9PT0gbnVsbCA/IG51bGwgOiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgbWVzc2FnZS52YWx1ZSksIHJldmlzaW9uOiByZXZpc2lvbiArIDEgfTtcbiAgICAgICAgICAgIGJ1Y2tldC5pdGVtc1trZXldID0gaXRlbTtcbiAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtzdG9yYWdlS2V5XTogYnVja2V0IH0pO1xuICAgICAgICAgICAgLy8gQmVzdC1lZmZvcnQgcHJpdmF0ZSBpbnZhbGlkYXRpb247IGNsb3NlZC9yZXBsYWNlZCBkb2N1bWVudHMgYXJlIGlnbm9yZWQuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFt0YWJJZCwgc3Vic2NyaWJlcl0gb2YgcHJpdmF0ZVN0b3JhZ2VTdWJzY3JpYmVycykge1xuICAgICAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gc2VuZGVyLnRhYi5pZCB8fCBzdWJzY3JpYmVyLm9yaWdpbiAhPT0gb3JpZ2luKSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb25zID0gc3Vic2NyaWJlci5kb2N1bWVudElkID8geyBkb2N1bWVudElkOiBzdWJzY3JpYmVyLmRvY3VtZW50SWQgfSA6IHsgZnJhbWVJZDogMCB9O1xuICAgICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6ICdtZW1jaGF0OnN0b3JhZ2UtY2hhbmdlZCcsIGtleSwgaXRlbSB9LCBvcHRpb25zKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwcml2YXRlU3RvcmFnZVN1YnNjcmliZXJzLmdldCh0YWJJZCkgPT09IHN1YnNjcmliZXIpIHByaXZhdGVTdG9yYWdlU3Vic2NyaWJlcnMuZGVsZXRlKHRhYklkKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBpdGVtIH07XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgRXJyb3IoJ0ludmFsaWQgb3BlcmF0aW9uJyk7XG4gICAgfSk7XG4gICAgcHJpdmF0ZVN0b3JhZ2VDaGFpbiA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIG9wZXJhdGlvbjtcbn1cbiIsIid1c2Ugc3RyaWN0JztcblxuY29uc3QgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcCgpO1xuY29uc3QgcnVsZXNSZWFkeSA9IGNocm9tZS5kZWNsYXJhdGl2ZU5ldFJlcXVlc3QudXBkYXRlU2Vzc2lvblJ1bGVzKHtcbiAgICByZW1vdmVSdWxlSWRzOiBbMSwgMl0sXG4gICAgYWRkUnVsZXM6IFtcbiAgICAgICAgeyBpZDogMSwgcHJpb3JpdHk6IDEsIGFjdGlvbjogeyB0eXBlOiAnbW9kaWZ5SGVhZGVycycsIHJlcXVlc3RIZWFkZXJzOiBbXG4gICAgICAgICAgICB7IGhlYWRlcjogJ09yaWdpbicsIG9wZXJhdGlvbjogJ3NldCcsIHZhbHVlOiAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIH0sXG4gICAgICAgICAgICB7IGhlYWRlcjogJ1JlZmVyZXInLCBvcGVyYXRpb246ICdzZXQnLCB2YWx1ZTogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcgfVxuICAgICAgICBdIH0sIGNvbmRpdGlvbjogeyBpbml0aWF0b3JEb21haW5zOiBbY2hyb21lLnJ1bnRpbWUuaWRdLCB1cmxGaWx0ZXI6ICd8aHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvJywgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddIH0gfSxcbiAgICAgICAgeyBpZDogMiwgcHJpb3JpdHk6IDIsIGFjdGlvbjogeyB0eXBlOiAnYmxvY2snIH0sIGNvbmRpdGlvbjoge1xuICAgICAgICAgICAgaW5pdGlhdG9yRG9tYWluczogW2Nocm9tZS5ydW50aW1lLmlkXSxcbiAgICAgICAgICAgIGV4Y2x1ZGVkUmVxdWVzdERvbWFpbnM6IFsuLi5uZXcgU2V0KE1FTUNIQVRfRVhURU5TSU9OX0NPTkZJRy5uZXR3b3JrSG9zdHMubWFwKGhvc3QgPT4gaG9zdC5yZXBsYWNlKC9eXFwqXFwuLywgJycpKSldLFxuICAgICAgICAgICAgcmVzb3VyY2VUeXBlczogWyd4bWxodHRwcmVxdWVzdCddXG4gICAgICAgIH0gfVxuICAgIF1cbn0pO1xuLy8gRmFpbCBjbG9zZWQ6IGEgZmFpbGVkIEROUiBzZXR1cCBpcyBjYXVnaHQgaGVyZSBhbmQgYmxvY2tzIHN1YnNlcXVlbnQgcmVxdWVzdHMuXG5sZXQgcnVsZUZhaWx1cmUgPSBmYWxzZTtcbnJ1bGVzUmVhZHkuY2F0Y2goKCkgPT4geyBydWxlRmFpbHVyZSA9IHRydWU7IH0pO1xuXG5mdW5jdGlvbiBtYXRjaGVzSG9zdChob3N0bmFtZSwgcGF0dGVybikge1xuICAgIHJldHVybiBwYXR0ZXJuLnN0YXJ0c1dpdGgoJyouJylcbiAgICAgICAgPyBob3N0bmFtZSA9PT0gcGF0dGVybi5zbGljZSgyKSB8fCBob3N0bmFtZS5lbmRzV2l0aCgnLicgKyBwYXR0ZXJuLnNsaWNlKDIpKVxuICAgICAgICA6IGhvc3RuYW1lID09PSBwYXR0ZXJuO1xufVxuXG5mdW5jdGlvbiBhbGxvd2VkVXJsKHJhdykge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLnByb3RvY29sICE9PSAnaHR0cHM6JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5wb3J0XG4gICAgICAgIHx8ICFNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcubmV0d29ya0hvc3RzLnNvbWUoaG9zdCA9PiBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIGhvc3QpKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VSTCBub3QgcGVybWl0dGVkJyk7XG4gICAgfVxuICAgIHJldHVybiB1cmw7XG59XG5cbmZ1bmN0aW9uIHRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHNlbmRlci50YWI/LmlkKSB8fCBzZW5kZXIuZnJhbWVJZCAhPT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VuZGVyLnVybCk7XG4gICAgICAgIHJldHVybiB1cmwucHJvdG9jb2wgPT09ICdodHRwczonICYmICF1cmwucG9ydCAmJiBNRU1DSEFUX0VYVEVOU0lPTl9DT05GSUcucGFnZU1hdGNoZXMuc29tZShwYXR0ZXJuID0+XG4gICAgICAgICAgICBtYXRjaGVzSG9zdCh1cmwuaG9zdG5hbWUsIG5ldyBVUkwocGF0dGVybi5yZXBsYWNlKCcqLicsICd3aWxkY2FyZC4nKSkuaG9zdG5hbWUucmVwbGFjZSgnd2lsZGNhcmQuJywgJyouJykpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5cbmZ1bmN0aW9uIHJlcXVlc3RLZXkoc2VuZGVyLCBpZCkgeyByZXR1cm4gYCR7c2VuZGVyLnRhYi5pZH06JHtzZW5kZXIuZnJhbWVJZH06JHtpZH1gOyB9XG5cbi8vIERpc3BhdGNoIE1TIHJlcXVlc3RzIGRpcmVjdGx5LiBPbmx5IGEgZmFpbGVkIHJlYWQgd2FpdHMgZm9yIGl0cyBvd24gcmV0cnk7XG4vLyBubyBwcm9maWxlLXdpZGUgcXVvdGEgc3RhdGUsIHJlc2VydmF0aW9ucywgY29uY3VycmVuY3kgY2FwIG9yIHBhY2luZy5cbmZ1bmN0aW9uIGlzTXNKc29uQXBpKHVybCkge1xuICAgIHJldHVybiB1cmwuaG9zdG5hbWUgPT09ICdhcGkubW95c2tsYWQucnUnICYmIC9eXFwvYXBpXFwvcmVtYXBcXC8xXFwuMig/OlxcL3wkKS8udGVzdCh1cmwucGF0aG5hbWUpO1xufVxuZnVuY3Rpb24gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCB0ZXh0ID0gJycpIHtcbiAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgICAgbGV0IHF1b3RhRXJyb3IgPSBmYWxzZTtcbiAgICAgICAgdHJ5IHsgcXVvdGFFcnJvciA9IEpTT04ucGFyc2UodGV4dCk/LmVycm9ycz8uc29tZShlcnJvciA9PiBOdW1iZXIoZXJyb3IuY29kZSkgPT09IDEwNzMpID09PSB0cnVlOyB9IGNhdGNoIHsgLyogTm90IEpTT04uICovIH1cbiAgICAgICAgaWYgKCFbNDA4LCA0MjldLmluY2x1ZGVzKHJlc3BvbnNlLnN0YXR1cykgJiYgcmVzcG9uc2Uuc3RhdHVzIDwgNTAwICYmICFxdW90YUVycm9yKSByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgbG9nbmV4ID0gTnVtYmVyKHJlc3BvbnNlPy5oZWFkZXJzLmdldCgnWC1Mb2duZXgtUmV0cnktQWZ0ZXInKSB8fCAwKTtcbiAgICBjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2U/LmhlYWRlcnMuZ2V0KCdSZXRyeS1BZnRlcicpO1xuICAgIGNvbnN0IHNlY29uZHMgPSByZXRyeUFmdGVyPy50cmltKCkgPyBOdW1iZXIocmV0cnlBZnRlcikgOiAwO1xuICAgIGNvbnN0IHN0YW5kYXJkID0gTnVtYmVyLmlzRmluaXRlKHNlY29uZHMpID8gc2Vjb25kcyAqIDEwMDAgOiBEYXRlLnBhcnNlKHJldHJ5QWZ0ZXIpIC0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBkZWxheSA9IE1hdGgubWF4KDUwMCwgTnVtYmVyLmlzRmluaXRlKGxvZ25leCkgPyBsb2duZXggOiAwLCBOdW1iZXIuaXNGaW5pdGUoc3RhbmRhcmQpID8gc3RhbmRhcmQgOiAwKTtcbiAgICByZXR1cm4gZGVsYXk7XG59XG5mdW5jdGlvbiBtc1dhaXRGb3JSZXRyeShzaWduYWwsIGRlbGF5KSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICBsZXQgcmVtYWluaW5nID0gZGVsYXk7XG4gICAgICAgIGxldCB0aW1lcjtcbiAgICAgICAgY29uc3QgZG9uZSA9ICgpID0+IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgc2lnbmFsLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgZG9uZSk7IHJlc29sdmUoKTsgfTtcbiAgICAgICAgY29uc3Qgc2NoZWR1bGUgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjaHVuayA9IE1hdGgubWluKHJlbWFpbmluZywgMjE0NzQ4MzY0Nyk7XG4gICAgICAgICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlbWFpbmluZyAtPSBjaHVuaztcbiAgICAgICAgICAgICAgICBpZiAocmVtYWluaW5nID4gMCkgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgICAgICBlbHNlIGRvbmUoKTtcbiAgICAgICAgICAgIH0sIGNodW5rKTtcbiAgICAgICAgfTtcbiAgICAgICAgc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgZG9uZSwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIGRvbmUoKTtcbiAgICAgICAgZWxzZSBzY2hlZHVsZSgpO1xuICAgIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwZXJmb3JtUmVxdWVzdChtZXNzYWdlLCBzZW5kZXIsIGJhY2tncm91bmRTaWduYWwpIHtcbiAgICBjb25zdCByZXF1ZXN0ID0gbWVzc2FnZS5yZXF1ZXN0O1xuICAgIGNvbnN0IHVybCA9IGFsbG93ZWRVcmwocmVxdWVzdD8udXJsKTtcbiAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcpLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKCFbJ0dFVCcsICdIRUFEJywgJ1BPU1QnLCAnUFVUJywgJ1BBVENIJywgJ0RFTEVURSddLmluY2x1ZGVzKG1ldGhvZCkpIHRocm93IG5ldyBFcnJvcignTWV0aG9kIG5vdCBwZXJtaXR0ZWQnKTtcbiAgICBpZiAocmVxdWVzdC5kYXRhICE9IG51bGwgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSAhPT0gJ3N0cmluZycpIHRocm93IG5ldyBFcnJvcignQm9keSBtdXN0IGJlIHRleHQnKTtcbiAgICBpZiAocmVxdWVzdC5kYXRhICE9IG51bGwgJiYgWydHRVQnLCAnSEVBRCddLmluY2x1ZGVzKG1ldGhvZCkpIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBib2R5Jyk7XG4gICAgaWYgKHJlcXVlc3QucmVzcG9uc2VUeXBlICYmICFbJ3RleHQnLCAnanNvbiddLmluY2x1ZGVzKHJlcXVlc3QucmVzcG9uc2VUeXBlKSkgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCByZXNwb25zZSB0eXBlJyk7XG4gICAgY29uc3QgaGVhZGVycyA9IG5ldyBIZWFkZXJzKCk7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHJlcXVlc3QuaGVhZGVycyB8fCB7fSkpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBoZWFkZXInKTtcbiAgICAgICAgaWYgKC9eYXV0aG9yaXphdGlvbiQvaS50ZXN0KG5hbWUpICYmIHVybC5ob3N0bmFtZSAhPT0gJ2FwaS5tb3lza2xhZC5ydScpIHRocm93IG5ldyBFcnJvcignQXV0aG9yaXphdGlvbiBob3N0IG5vdCBwZXJtaXR0ZWQnKTtcbiAgICAgICAgaWYgKC9eKG9yaWdpbnxyZWZlcmVyfHVzZXItYWdlbnR8Y29va2llfGhvc3R8Y29udGVudC1sZW5ndGh8Y29ubmVjdGlvbnxhY2NlcHQtZW5jb2Rpbmd8cHJveHktLip8c2VjLS4qKSQvaS50ZXN0KG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgaGVhZGVycy5zZXQobmFtZSwgdmFsdWUpO1xuICAgIH1cbiAgICBjb25zdCBrZXkgPSByZXF1ZXN0S2V5KHNlbmRlciwgbWVzc2FnZS5pZCk7XG4gICAgaWYgKHBlbmRpbmdSZXF1ZXN0cy5oYXMoa2V5KSkgdGhyb3cgbmV3IEVycm9yKCdEdXBsaWNhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IGVudHJ5ID0geyBjb250cm9sbGVyOiBuZXcgQWJvcnRDb250cm9sbGVyKCksIGV2ZW50OiAnJyB9O1xuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoa2V5LCBlbnRyeSk7XG4gICAgY29uc3QgY2FuY2VsQmFja2dyb3VuZCA9ICgpID0+IHsgZW50cnkuZXZlbnQgPSAnYWJvcnQnOyBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7IH07XG4gICAgYmFja2dyb3VuZFNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxCYWNrZ3JvdW5kLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgaWYgKGJhY2tncm91bmRTaWduYWw/LmFib3J0ZWQpIGNhbmNlbEJhY2tncm91bmQoKTtcbiAgICBjb25zdCB0aW1lb3V0ID0gTWF0aC5taW4oMzAwMDAsIE1hdGgubWF4KDEsIE51bWJlcihyZXF1ZXN0LnRpbWVvdXQpIHx8IDMwMDAwKSk7XG4gICAgbGV0IHRpbWVyO1xuICAgIGNvbnN0IGNoZWNrQ3VycmVudCA9IHJlcXVlc3QuY3JlZGVudGlhbEd1YXJkID09PSB0cnVlID8gYXN5bmMgKCkgPT4ge1xuICAgICAgICBsZXQgY2hlY2tUaW1lcjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgICAgICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2Uoc2VuZGVyLnRhYi5pZCwgeyB0eXBlOiAnbWVtY2hhdDpyZXF1ZXN0LWN1cnJlbnQnLCBpZDogbWVzc2FnZS5pZCB9LCB7IGZyYW1lSWQ6IHNlbmRlci5mcmFtZUlkIH0pLFxuICAgICAgICAgICAgICAgIG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyBjaGVja1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKG51bGwpLCAxMDAwKTsgfSlcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgaWYgKHJlc3VsdD8uY3VycmVudCA9PT0gdHJ1ZSAmJiAoIWlzTXNKc29uQXBpKHVybCkgfHwgdHlwZW9mIHByaXZhdGVTdG9yYWdlQ3JlZGVudGlhbEN1cnJlbnQgIT09ICdmdW5jdGlvbidcbiAgICAgICAgICAgICAgICB8fCBhd2FpdCBwcml2YXRlU3RvcmFnZUNyZWRlbnRpYWxDdXJyZW50KHNlbmRlciwgaGVhZGVycy5nZXQoJ2F1dGhvcml6YXRpb24nKSkpKSByZXR1cm47XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBNaXNzaW5nL2ludmFsaWRhdGVkIGNvbnRlbnQgd29ybGQgZmFpbHMgY2xvc2VkLiAqLyB9XG4gICAgICAgIGZpbmFsbHkgeyBjbGVhclRpbWVvdXQoY2hlY2tUaW1lcik7IH1cbiAgICAgICAgZW50cnkuZXZlbnQgPSAnYWJvcnQnO1xuICAgICAgICBlbnRyeS5jb250cm9sbGVyLmFib3J0KCk7XG4gICAgfSA6IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcnVsZXNSZWFkeTtcbiAgICAgICAgaWYgKHJ1bGVGYWlsdXJlKSB0aHJvdyBuZXcgRXJyb3IoJ05ldHdvcmsgcnVsZXMgdW5hdmFpbGFibGUnKTtcbiAgICAgICAgaWYgKHVybC5vcmlnaW4gPT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgJiYgcGFuZWxTZXNzaW9uPy50YWIpIHtcbiAgICAgICAgICAgIGlmIChjaGVja0N1cnJlbnQpIGF3YWl0IGNoZWNrQ3VycmVudCgpO1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHBhbmVsUmVxdWVzdFZpYVRhYih7IC4uLnJlcXVlc3QsIG1ldGhvZCB9LCBlbnRyeS5jb250cm9sbGVyLnNpZ25hbCk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IDsgYXR0ZW1wdCsrKSB7XG4gICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB9O1xuICAgICAgICAgICAgaWYgKGNoZWNrQ3VycmVudCkgYXdhaXQgY2hlY2tDdXJyZW50KCk7XG4gICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB9O1xuICAgICAgICAgICAgY29uc3QgY2FuUmV0cnkgPSBpc01zSnNvbkFwaSh1cmwpICYmIFsnR0VUJywgJ0hFQUQnXS5pbmNsdWRlcyhtZXRob2QpICYmIGF0dGVtcHQgPT09IDA7XG4gICAgICAgICAgICBsZXQgcmV0cnlEZWxheTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGVudHJ5LmNvbnRyb2xsZXI7XG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgZW50cnkuZXZlbnQgPSAndGltZW91dCc7IGNvbnRyb2xsZXIuYWJvcnQoKTsgfSwgdGltZW91dCk7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwuaHJlZiwge1xuICAgICAgICAgICAgICAgICAgICBtZXRob2QsIGhlYWRlcnMsIGJvZHk6IHJlcXVlc3QuZGF0YSA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxzOiByZXF1ZXN0LmFub255bW91cyA9PT0gdHJ1ZSA/ICdvbWl0JyA6ICdpbmNsdWRlJyxcbiAgICAgICAgICAgICAgICAgICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCwgcmVkaXJlY3Q6IGlzTXNKc29uQXBpKHVybCkgPyAnZXJyb3InIDogJ2ZvbGxvdydcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAvLyBETlIgYmxvY2tzIHJlZGlyZWN0cyB0byB1bmdyYW50ZWQgaG9zdHMgYmVmb3JlIHNlbmRpbmcgYnl0ZXMuXG4gICAgICAgICAgICAgICAgYWxsb3dlZFVybChyZXNwb25zZS51cmwgfHwgdXJsLmhyZWYpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICAgICAgICAgICAgICBpZiAoZW50cnkuZXZlbnQpIHRocm93IG5ldyBFcnJvcignQ2FuY2VsbGVkJyk7XG4gICAgICAgICAgICAgICAgcmV0cnlEZWxheSA9IGNhblJldHJ5ID8gbXNSZXRyeURlbGF5KHJlc3BvbnNlLCByZXNwb25zZVRleHQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAocmV0cnlEZWxheSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICBsZXQgcGFyc2VkID0gcmVzcG9uc2VUZXh0O1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVxdWVzdC5yZXNwb25zZVR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpOyB9IGNhdGNoIHsgcGFyc2VkID0gbnVsbDsgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGV2ZW50OiAnbG9hZCcsIHJlc3BvbnNlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCwgcmVzcG9uc2VUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2U6IHBhcnNlZCwgcmVzcG9uc2VIZWFkZXJzOiBbLi4ucmVzcG9uc2UuaGVhZGVyc10ubWFwKChbbmFtZSwgdmFsdWVdKSA9PiBgJHtuYW1lfTogJHt2YWx1ZX1gKS5qb2luKFN0cmluZy5mcm9tQ2hhckNvZGUoMTMsIDEwKSksXG4gICAgICAgICAgICAgICAgICAgICAgICBmaW5hbFVybDogcmVzcG9uc2UudXJsIHx8IHVybC5ocmVmLCByZWFkeVN0YXRlOiA0XG4gICAgICAgICAgICAgICAgICAgIH0gfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNhblJldHJ5IHx8IGVudHJ5LmV2ZW50ID09PSAnYWJvcnQnKSByZXR1cm4geyBldmVudDogZW50cnkuZXZlbnQgfHwgJ2Vycm9yJywgZXJyb3I6ICfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcgfTtcbiAgICAgICAgICAgICAgICByZXRyeURlbGF5ID0gNTAwO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgfVxuICAgICAgICAgICAgLy8gQSB0aW1lb3V0IGFib3J0cyBpdHMgYXR0ZW1wdCwgbm90IHRoZSBuZXh0IG9uZS4gRXhwbGljaXQgYWJvcnRzIGFuZFxuICAgICAgICAgICAgLy8gY3JlZGVudGlhbCBjaGFuZ2VzIHN0aWxsIGNhbmNlbCB0aGlzIHdhaXQgYW5kIHN1cHByZXNzIHRoZSByZXRyeS5cbiAgICAgICAgICAgIGVudHJ5LmV2ZW50ID0gJyc7XG4gICAgICAgICAgICBlbnRyeS5jb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICAgICAgYXdhaXQgbXNXYWl0Rm9yUmV0cnkoZW50cnkuY29udHJvbGxlci5zaWduYWwsIHJldHJ5RGVsYXkpO1xuICAgICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiBlbnRyeS5ldmVudCB8fCAnZXJyb3InLCBlcnJvcjogJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGJhY2tncm91bmRTaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsQmFja2dyb3VuZCk7XG4gICAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoa2V5KTtcbiAgICB9XG59XG4iLCIvLyBBIHNpbmdsZSB3b3JrZXIgb3ducyB0aGUgUGFuZWwgdG9rZW4uIE5ldmVyIHBlcnNpc3QgaXQgaW50byBwYWdlIHN0b3JhZ2UuXG5jb25zdCBQQU5FTF9TRVNTSU9OX1RUTCA9IDEyICogNjAgKiAxMDAwO1xuY29uc3QgUEFORUxfU0VTU0lPTl9USU1FT1VUID0gMTUwMDA7XG5sZXQgcGFuZWxTZXNzaW9uID0gbnVsbDtcbmxldCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xubGV0IGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9IG51bGw7XG5sZXQgcXVldWVkUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcblxuZnVuY3Rpb24gZXh0cmFjdFBhbmVsU2Vzc2lvblRva2VuKGh0bWwpIHtcbiAgICBjb25zdCBjbGVhbiA9IGh0bWwucmVwbGFjZSgvPCEtLVtcXHNcXFNdKj8tLT58PHNjcmlwdFxcYltePl0qPltcXHNcXFNdKj88XFwvc2NyaXB0XFxzKj4vZ2ksICcnKTtcbiAgICBpZiAoLzxpbnB1dFxcYltePl0qXFxidHlwZVxccyo9XFxzKltcIiddP3Bhc3N3b3JkXFxiL2kudGVzdChjbGVhbikpIHJldHVybiAnJztcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBjbGVhbi5tYXRjaCgvPG1ldGFcXGJbXj5dKj4vZ2kpIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IGF0dHJzID0ge307XG4gICAgICAgIGZvciAoY29uc3QgbWF0Y2ggb2YgdGFnLm1hdGNoQWxsKC8oW1xcdy1dKylcXHMqPVxccyooPzpcIihbXlwiXSopXCJ8JyhbXiddKiknKS9nKSkge1xuICAgICAgICAgICAgYXR0cnNbbWF0Y2hbMV0udG9Mb3dlckNhc2UoKV0gPSBtYXRjaFsyXSA/PyBtYXRjaFszXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYXR0cnMubmFtZT8udG9Mb3dlckNhc2UoKSA9PT0gJ2NzcmYtdG9rZW4nICYmIC9eW0EtWmEtejAtOV8tXXsxNiw1MTJ9JC8udGVzdChhdHRycy5jb250ZW50IHx8ICcnKSkgcmV0dXJuIGF0dHJzLmNvbnRlbnQ7XG4gICAgfVxuICAgIHJldHVybiAnJztcbn1cblxubGV0IHBhbmVsVGFiU2VxdWVuY2UgPSAwO1xuZnVuY3Rpb24gcGFuZWxUYWJVcmwocmF3KSB7XG4gICAgdHJ5IHsgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpOyByZXR1cm4gdXJsLm9yaWdpbiA9PT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyAmJiAhdXJsLnVzZXJuYW1lICYmICF1cmwucGFzc3dvcmQgJiYgIS9eXFwvbG9naW5cXC8/JC8udGVzdCh1cmwucGF0aG5hbWUpOyB9XG4gICAgY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cbn1cbmZ1bmN0aW9uIHBhbmVsVGFiUmVxdWVzdEFsbG93ZWQocmVxdWVzdCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxdWVzdD8udXJsKSwgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gcGFuZWxUYWJVcmwodXJsLmhyZWYpICYmICF1cmwuaGFzaCAmJiAhdXJsLnNlYXJjaCAmJiAoKG1ldGhvZCA9PT0gJ0dFVCdcbiAgICAgICAgICAgICYmICh1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAvXlxcL2FwaVxcL2JvbnVzZXNcXC9jaGVja1xcL1xcZHsxLDIwfSQvLnRlc3QodXJsLnBhdGhuYW1lKSkpXG4gICAgICAgICAgICB8fCAobWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZWFyY2gnICYmIHR5cGVvZiByZXF1ZXN0LmRhdGEgPT09ICdzdHJpbmcnICYmIHJlcXVlc3QuZGF0YS5sZW5ndGggPD0gMzI3NjgpKTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG59XG5hc3luYyBmdW5jdGlvbiBwYW5lbFRhYk1lc3NhZ2UodGFiSWQsIHBheWxvYWQsIHNpZ25hbCkge1xuICAgIGNvbnN0IGlkID0gJ3BhbmVsLScgKyBEYXRlLm5vdygpICsgJy0nICsgKCsrcGFuZWxUYWJTZXF1ZW5jZSk7XG4gICAgbGV0IHRpbWVyLCBhYm9ydDtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBhYm9ydCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiAnbWVtY2hhdDpwYW5lbC10YWInLCBpZCwgb3BlcmF0aW9uOiAnY2FuY2VsJyB9LCB7IGZyYW1lSWQ6IDAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgICAgICAgIHJlc29sdmUobnVsbCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KGFib3J0LCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICAgICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc2lnbmFsPy5hYm9ydGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIGF3YWl0IFByb21pc2UucmFjZShbY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiSWQsIHsgdHlwZTogJ21lbWNoYXQ6cGFuZWwtdGFiJywgaWQsIC4uLnBheWxvYWQgfSwgeyBmcmFtZUlkOiAwIH0pLCB0aW1lb3V0XSk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XG4gICAgZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBhYm9ydCk7IH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHJlY292ZXJQYW5lbEZyb21UYWIoc2lnbmFsKSB7XG4gICAgaWYgKCFjaHJvbWUudGFicz8ucXVlcnkgfHwgIWNocm9tZS50YWJzPy5nZXQgfHwgc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHRhYnMgPSAoYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6ICdodHRwczovL3BhbmVsLmhhdGlrby5ydS8qJyB9KSkuZmlsdGVyKHRhYiA9PiBOdW1iZXIuaXNJbnRlZ2VyKHRhYi5pZCkgJiYgcGFuZWxUYWJVcmwodGFiLnVybCkpO1xuICAgICAgICB0YWJzLnNvcnQoKGEsIGIpID0+IE51bWJlcighIWIuYWN0aXZlKSAtIE51bWJlcighIWEuYWN0aXZlKSB8fCAoYi5sYXN0QWNjZXNzZWQgfHwgMCkgLSAoYS5sYXN0QWNjZXNzZWQgfHwgMCkgfHwgYS5pZCAtIGIuaWQpO1xuICAgICAgICBmb3IgKGNvbnN0IHRhYiBvZiB0YWJzLnNsaWNlKDAsIDMpKSB7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2UodGFiLmlkLCB7IG9wZXJhdGlvbjogJ3Nlc3Npb24nIH0sIHNpZ25hbCk7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgY2hyb21lLnRhYnMuZ2V0KHRhYi5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgICAgICBpZiAoc2lnbmFsLmFib3J0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgaWYgKHJlcGx5Py5vayAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QocmVwbHkudG9rZW4gfHwgJycpICYmIHR5cGVvZiByZXBseS5pbnN0YW5jZSA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgICAgICAmJiByZXBseS5pbnN0YW5jZS5sZW5ndGggPD0gMTAwICYmIHBhbmVsVGFiVXJsKGN1cnJlbnQ/LnVybCkpIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSB7IHRva2VuOiByZXBseS50b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSwgdGFiOiB7IGlkOiB0YWIuaWQsIGluc3RhbmNlOiByZXBseS5pbnN0YW5jZSB9IH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuOiByZXBseS50b2tlbiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSBjYXRjaCB7IC8qIENsb3NlZC9uYXZpZ2F0ZWQgdGFicyBhcmUgbm90IGFuIGF1dGhlbnRpY2F0ZWQgc2Vzc2lvbi4gKi8gfVxuICAgIHJldHVybiBudWxsO1xufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxSZXF1ZXN0VmlhVGFiKHJlcXVlc3QsIHNpZ25hbCkge1xuICAgIGNvbnN0IHJvdXRlID0gcGFuZWxTZXNzaW9uPy50YWI7XG4gICAgaWYgKCFyb3V0ZSB8fCAhcGFuZWxUYWJSZXF1ZXN0QWxsb3dlZChyZXF1ZXN0KSkgcmV0dXJuIHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INC30LDQv9GA0L7RgSDQvtGC0LrQu9C+0L3RkdC9JyB9O1xuICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBjaHJvbWUudGFicy5nZXQocm91dGUuaWQpLmNhdGNoKCgpID0+IG51bGwpO1xuICAgIGlmICghcGFuZWxUYWJVcmwoY3VycmVudD8udXJsKSB8fCBzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6IHNpZ25hbC5hYm9ydGVkID8gJ2Fib3J0JyA6ICdlcnJvcicsIGVycm9yOiAnUGFuZWw6INCy0LrQu9Cw0LTQutCwINC30LDQutGA0YvRgtCwINC40LvQuCDQuNC30LzQtdC90LXQvdCwLiDQn9C+0LLRgtC+0YDQuNGC0LUg0L/RgNC+0LLQtdGA0LrRgyBwYW5lbC4nIH07XG4gICAgY29uc3QgcmVwbHkgPSBhd2FpdCBwYW5lbFRhYk1lc3NhZ2Uocm91dGUuaWQsIHsgb3BlcmF0aW9uOiAncmVxdWVzdCcsIGluc3RhbmNlOiByb3V0ZS5pbnN0YW5jZSwgcmVxdWVzdCB9LCBzaWduYWwpO1xuICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgZXZlbnQ6ICdhYm9ydCcgfTtcbiAgICBjb25zdCBhZnRlciA9IGF3YWl0IGNocm9tZS50YWJzLmdldChyb3V0ZS5pZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKCFyZXBseT8ub2sgfHwgcmVwbHkuaW5zdGFuY2UgIT09IHJvdXRlLmluc3RhbmNlIHx8ICFwYW5lbFRhYlVybChhZnRlcj8udXJsKSB8fCByZXBseS5yZXN1bHQ/LmV2ZW50ICE9PSAnbG9hZCdcbiAgICAgICAgfHwgIU51bWJlci5pc0ludGVnZXIocmVwbHkucmVzdWx0LnJlc3BvbnNlPy5zdGF0dXMpIHx8IHJlcGx5LnJlc3VsdC5yZXNwb25zZT8uZmluYWxVcmwgIT09IHJlcXVlc3QudXJsKSB7XG4gICAgICAgIGlmIChwYW5lbFNlc3Npb24/LnRhYiA9PT0gcm91dGUpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgICAgIHJldHVybiB7IGV2ZW50OiAnZXJyb3InLCBlcnJvcjogJ1BhbmVsOiDQutC+0L3RgtC10LrRgdGCINCy0LrQu9Cw0LTQutC4INC40LfQvNC10L3QuNC70YHRjy4g0J3QsNC20LzQuNGC0LUgcGFuZWwg0LTQu9GPINC/0L7QstGC0L7RgNC90L7QuSDQv9GA0L7QstC10YDQutC4LicgfTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcGx5LnJlc3VsdDtcbn1cblxuZnVuY3Rpb24gc3RhcnRQYW5lbFNlc3Npb25GbGlnaHQoZm9yY2UpIHtcbiAgICAvLyBBIHF1ZXVlZCBub3JtYWwgZmxpZ2h0IG1heSBoYXZlIHBvcHVsYXRlZCB0aGUgY2FjaGUgc2luY2UgZm9yY2Ugd2FzIHJlcXVlc3RlZC5cbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgY29uc3QgZmxpZ2h0ID0geyBwcm9taXNlOiBudWxsIH07XG4gICAgZmxpZ2h0LnByb21pc2UgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBQQU5FTF9TRVNTSU9OX1RJTUVPVVQpO1xuICAgICAgICBjb25zdCBmYWlsdXJlID0gYXN5bmMgKHJlYXNvbiwgZXJyb3IpID0+IChhd2FpdCByZWNvdmVyUGFuZWxGcm9tVGFiKGNvbnRyb2xsZXIuc2lnbmFsKSkgfHwgeyBvazogZmFsc2UsIHJlYXNvbiwgZXJyb3IgfTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHJ1bGVzUmVhZHk7XG4gICAgICAgICAgICBpZiAocnVsZUZhaWx1cmUgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IEVycm9yKCdQYW5lbCB1bmF2YWlsYWJsZScpO1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJywge1xuICAgICAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsIGhlYWRlcnM6IHsgQWNjZXB0OiAndGV4dC9odG1sJyB9LCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLFxuICAgICAgICAgICAgICAgIGNhY2hlOiAnbm8tc3RvcmUnLCByZWRpcmVjdDogJ2ZvbGxvdycsIHNpZ25hbDogY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgZmluYWxVcmwgPSBuZXcgVVJMKHJlc3BvbnNlLnVybCB8fCAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvc2VhcmNoJyk7XG4gICAgICAgICAgICBpZiAoZmluYWxVcmwub3JpZ2luICE9PSAnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUnIHx8ICEvXlxcL3NlYXJjaFxcLz8kLy50ZXN0KGZpbmFsVXJsLnBhdGhuYW1lKVxuICAgICAgICAgICAgICAgIHx8IHJlc3BvbnNlLnN0YXR1cyA8IDIwMCB8fCByZXNwb25zZS5zdGF0dXMgPj0gMzAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ2F1dGgnLCAnUGFuZWw6INGE0L7QvdC+0LLRi9C5INCy0YXQvtC0INC90LXQtNC+0YHRgtGD0L/QtdC9LiDQntGC0LrRgNC+0LnRgtC1INCw0LLRgtC+0YDQuNC30L7QstCw0L3QvdGD0Y4gcGFuZWwuaGF0aWtvLnJ1INCyINGN0YLQvtC8INC/0YDQvtGE0LjQu9C1INC4INC90LDQttC80LjRgtC1IHBhbmVsLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdG9rZW4gPSBleHRyYWN0UGFuZWxTZXNzaW9uVG9rZW4oYXdhaXQgcmVzcG9uc2UudGV4dCgpKTtcbiAgICAgICAgICAgIGlmICghdG9rZW4gfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ2F1dGgnLCAnUGFuZWw6INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/QvtC00YLQstC10YDQtNC40YLRjCDQstGF0L7QtC4g0J7RgtC60YDQvtC50YLQtSBwYW5lbC5oYXRpa28ucnUg0Lgg0L3QsNC20LzQuNGC0LUgcGFuZWwuJyk7XG4gICAgICAgICAgICAvLyBMYXJhdmVsIGlzc3VlcyBDU1JGIGV2ZW4gZm9yIGFub255bW91cyBsb2dpbiBwYWdlcy4gQ29uZmlybSBhY2Nlc3NcbiAgICAgICAgICAgIC8vIHRvIGFuIGFjdHVhbCBwcm90ZWN0ZWQgcmVhZC1vbmx5IEFQSSB3aXRoIHRoZSBzYW1lIGJyb3dzZXIgY29va2llcy5cbiAgICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9wYW5lbC5oYXRpa28ucnUvYXBpL3NlYXJjaC9maWx0ZXJzJywge1xuICAgICAgICAgICAgICAgIG1ldGhvZDogJ0dFVCcsIGhlYWRlcnM6IHsgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsICdYLVJlcXVlc3RlZC1XaXRoJzogJ1hNTEh0dHBSZXF1ZXN0JyB9LFxuICAgICAgICAgICAgICAgIGNyZWRlbnRpYWxzOiAnaW5jbHVkZScsIGNhY2hlOiAnbm8tc3RvcmUnLCByZWRpcmVjdDogJ2ZvbGxvdycsIHNpZ25hbDogY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgYXV0aFVybCA9IG5ldyBVUkwoYXV0aC51cmwgfHwgJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L2FwaS9zZWFyY2gvZmlsdGVycycpO1xuICAgICAgICAgICAgaWYgKGF1dGguc3RhdHVzIDwgMjAwIHx8IGF1dGguc3RhdHVzID49IDMwMCB8fCBhdXRoVXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1J1xuICAgICAgICAgICAgICAgIHx8IGF1dGhVcmwucGF0aG5hbWUgIT09ICcvYXBpL3NlYXJjaC9maWx0ZXJzJyB8fCAhL2FwcGxpY2F0aW9uXFwvanNvbi9pLnRlc3QoYXV0aC5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykgfHwgJycpKSB7XG4gICAgICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0gbnVsbDtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZmFpbHVyZShhdXRoLnN0YXR1cyA+PSA1MDAgPyAnbmV0d29yaycgOiAnYXV0aCcsICdQYW5lbDog0L3QtdGCINC00L7RgdGC0YPQv9CwINC6IEFQSS4g0J7RgtC60YDQvtC50YLQtSDQsNCy0YLQvtGA0LjQt9C+0LLQsNC90L3Rg9GOIHBhbmVsLmhhdGlrby5ydSDQuCDQvdCw0LbQvNC40YLQtSBwYW5lbC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHByb29mID0gYXdhaXQgYXV0aC5qc29uKCk7XG4gICAgICAgICAgICBpZiAoIXByb29mIHx8IHR5cGVvZiBwcm9vZiAhPT0gJ29iamVjdCcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgRXJyb3IoJ0ludmFsaWQgUGFuZWwgYXV0aCBwcm9vZicpO1xuICAgICAgICAgICAgcGFuZWxTZXNzaW9uID0geyB0b2tlbiwgc2F2ZWRBdDogRGF0ZS5ub3coKSB9O1xuICAgICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRva2VuIH07XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGZhaWx1cmUoJ25ldHdvcmsnLCAnUGFuZWw6INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/RgNC+0LLQtdGA0LjRgtGMINCy0YXQvtC0LiDQn9GA0L7QstC10YDRjNGC0LUg0YHQvtC10LTQuNC90LXQvdC40LUg0Lgg0L7RgtC60YDRi9GC0YPRjiDQstC60LvQsNC00LrRgyBwYW5lbC5oYXRpa28ucnUuJyk7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgaWYgKGZvcmNlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gZmxpZ2h0KSBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPT09IGZsaWdodCkgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0ID0gbnVsbDtcbiAgICAgICAgfVxuICAgIH0pKCk7XG4gICAgaWYgKGZvcmNlKSBmb3JjZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBmbGlnaHQ7XG4gICAgZWxzZSBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQgPSBmbGlnaHQ7XG4gICAgcmV0dXJuIGZsaWdodC5wcm9taXNlO1xufVxuXG5mdW5jdGlvbiBnZXRQYW5lbFNlc3Npb24oZm9yY2UpIHtcbiAgICBpZiAoZm9yY2UpIHBhbmVsU2Vzc2lvbiA9IG51bGw7XG4gICAgaWYgKGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIGZvcmNlZFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIGlmIChxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQpIHJldHVybiBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTtcbiAgICBpZiAoZm9yY2UgJiYgbm9ybWFsUGFuZWxTZXNzaW9uRmxpZ2h0KSB7XG4gICAgICAgIGNvbnN0IHF1ZXVlZCA9IHsgcHJvbWlzZTogbnVsbCB9O1xuICAgICAgICBxdWV1ZWQucHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBub3JtYWxQYW5lbFNlc3Npb25GbGlnaHQucHJvbWlzZTsgfVxuICAgICAgICAgICAgZmluYWxseSB7XG4gICAgICAgICAgICAgICAgaWYgKHF1ZXVlZFBhbmVsU2Vzc2lvbkZsaWdodCA9PT0gcXVldWVkKSBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0UGFuZWxTZXNzaW9uRmxpZ2h0KHRydWUpO1xuICAgICAgICB9KSgpO1xuICAgICAgICBxdWV1ZWRQYW5lbFNlc3Npb25GbGlnaHQgPSBxdWV1ZWQ7XG4gICAgICAgIHJldHVybiBxdWV1ZWQucHJvbWlzZTtcbiAgICB9XG4gICAgaWYgKCFmb3JjZSAmJiBwYW5lbFNlc3Npb24gJiYgRGF0ZS5ub3coKSAtIHBhbmVsU2Vzc2lvbi5zYXZlZEF0IDwgUEFORUxfU0VTU0lPTl9UVEwpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogdHJ1ZSwgdG9rZW46IHBhbmVsU2Vzc2lvbi50b2tlbiB9KTtcbiAgICBpZiAoIWZvcmNlICYmIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodCkgcmV0dXJuIG5vcm1hbFBhbmVsU2Vzc2lvbkZsaWdodC5wcm9taXNlO1xuICAgIHJldHVybiBzdGFydFBhbmVsU2Vzc2lvbkZsaWdodChmb3JjZSk7XG59XG4iLCIvLyBFeHRlbnNpb24tb3duZWQgcHJlc2VudGF0aW9uLiBObyBzaXRlIERPTSwgdG9rZW5zLCBvciBjb250ZW50LXRhYiBhdWRpby5cbmNvbnN0IE9SREVSX05PVElGSUNBVElPTl9JRCA9ICdtZW1jaGF0LW9yZGVycyc7XG5jb25zdCBPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZID0gJ21lbWNoYXQtb3JkZXItbm90aWZpY2F0aW9uLWV4cGlyZSc7XG5mdW5jdGlvbiBvcmRlckJlYXJJY29uKHNpemUpIHtcbiAgICBjb25zdCBjYW52YXMgPSBuZXcgT2Zmc2NyZWVuQ2FudmFzKHNpemUsIHNpemUpLCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnKSwgcyA9IHNpemUgLyAzMjtcbiAgICBjb25zdCBvdmFsID0gKHgsIHksIHJ4LCByeSwgY29sb3IpID0+IHsgY3R4LmZpbGxTdHlsZSA9IGNvbG9yOyBjdHguYmVnaW5QYXRoKCk7IGN0eC5lbGxpcHNlKHggKiBzLCB5ICogcywgcnggKiBzLCByeSAqIHMsIDAsIDAsIE1hdGguUEkgKiAyKTsgY3R4LmZpbGwoKTsgfTtcbiAgICBvdmFsKDcsIDcsIDYsIDYsICcjNzEzZjJhJyk7IG92YWwoMjUsIDcsIDYsIDYsICcjNzEzZjJhJyk7XG4gICAgb3ZhbCg3LCA3LCAzLCAzLCAnI2Q4YWE3OCcpOyBvdmFsKDI1LCA3LCAzLCAzLCAnI2Q4YWE3OCcpO1xuICAgIG92YWwoMTYsIDE4LCAxNCwgMTMsICcjOTg2MjNiJyk7XG4gICAgb3ZhbCgxNiwgMjQsIDgsIDYsICcjZWRjOTliJyk7XG4gICAgb3ZhbCgxMCwgMTcsIDIsIDIuNSwgJyMyMzE1MGUnKTsgb3ZhbCgyMiwgMTcsIDIsIDIuNSwgJyMyMzE1MGUnKTtcbiAgICBvdmFsKDE2LCAyMiwgMywgMiwgJyMyMzE1MGUnKTsgb3ZhbCgxNiwgMjYsIDIsIDEsICcjNzEzZjJhJyk7XG4gICAgcmV0dXJuIGN0eC5nZXRJbWFnZURhdGEoMCwgMCwgc2l6ZSwgc2l6ZSk7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclVwZGF0ZUljb24oKSB7XG4gICAgaWYgKCFjaHJvbWUuYWN0aW9uPy5zZXRJY29uKSByZXR1cm47XG4gICAgY29uc3QgZW5hYmxlZCA9IG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkID09PSB0cnVlO1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0SWNvbihlbmFibGVkID8geyBpbWFnZURhdGE6IHsgMTY6IG9yZGVyQmVhckljb24oMTYpLCAzMjogb3JkZXJCZWFySWNvbigzMikgfSB9IDogeyBwYXRoOiAnaWNvbi5wbmcnIH0pO1xuICAgIGF3YWl0IGNocm9tZS5hY3Rpb24uc2V0VGl0bGUoeyB0aXRsZTogZW5hYmxlZCA/ICfwn5C7INCe0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLQutC70Y7Rh9GR0L0gwrcg0J/QvtC60LDQt9Cw0YLRjCAvINGB0LrRgNGL0YLRjCDQnNC10LzRh9Cw0YInIDogJ9Cf0L7QutCw0LfQsNGC0YwgLyDRgdC60YDRi9GC0Ywg0JzQtdC80YfQsNGCJyB9KTtcbn1cbmxldCBvcmRlckF1ZGlvQ3JlYXRpbmcgPSBudWxsO1xubGV0IG9yZGVyQXVkaW9HZW5lcmF0aW9uID0gMDtcbmFzeW5jIGZ1bmN0aW9uIG9yZGVyU3RvcEF1ZGlvKCkge1xuICAgIG9yZGVyQXVkaW9HZW5lcmF0aW9uKys7XG4gICAgaWYgKCFjaHJvbWUucnVudGltZS5nZXRDb250ZXh0cykgcmV0dXJuO1xuICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgaWYgKGNvbnRleHRzLmxlbmd0aCkgYXdhaXQgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0YXJnZXQ6ICdtZW1jaGF0LW9mZnNjcmVlbicsIHR5cGU6ICdtZW1jaGF0OmF1ZGlvLXN0b3AnIH0pO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJFbnN1cmVBdWRpbygpIHtcbiAgICBpZiAob3JkZXJBdWRpb0NyZWF0aW5nKSByZXR1cm4gb3JkZXJBdWRpb0NyZWF0aW5nO1xuICAgIG9yZGVyQXVkaW9DcmVhdGluZyA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGNvbnRleHRzID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoeyBjb250ZXh0VHlwZXM6IFsnT0ZGU0NSRUVOX0RPQ1VNRU5UJ10sIGRvY3VtZW50VXJsczogW2Nocm9tZS5ydW50aW1lLmdldFVSTCgnb2Zmc2NyZWVuLmh0bWwnKV0gfSk7XG4gICAgICAgIGlmICghY29udGV4dHMubGVuZ3RoKSBhd2FpdCBjaHJvbWUub2Zmc2NyZWVuLmNyZWF0ZURvY3VtZW50KHsgdXJsOiAnb2Zmc2NyZWVuLmh0bWwnLCByZWFzb25zOiBbJ0FVRElPX1BMQVlCQUNLJ10sIGp1c3RpZmljYXRpb246ICdPbmUgc2hhcmVkIE1lbWNoYXQgb3JkZXIgYWxhcm0sIGluZGVwZW5kZW50IG9mIG9wZW4gTW95U2tsYWQgdGFicy4nIH0pO1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyQXVkaW9DcmVhdGluZyA9IG51bGw7IH0pO1xuICAgIHJldHVybiBvcmRlckF1ZGlvQ3JlYXRpbmc7XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclBsYXlBdWRpbyhpc0N1cnJlbnQgPSAoKSA9PiB0cnVlKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG9yZGVyQXVkaW9HZW5lcmF0aW9uO1xuICAgIGF3YWl0IG9yZGVyRW5zdXJlQXVkaW8oKTtcbiAgICBpZiAoIWlzQ3VycmVudCgpIHx8IGdlbmVyYXRpb24gIT09IG9yZGVyQXVkaW9HZW5lcmF0aW9uKSByZXR1cm47XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHRhcmdldDogJ21lbWNoYXQtb2Zmc2NyZWVuJywgdHlwZTogJ21lbWNoYXQ6YXVkaW8tcGxheScgfSk7XG4gICAgaWYgKCFyZXNwb25zZT8ub2spIHRocm93IEVycm9yKCfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScpO1xufVxuYXN5bmMgZnVuY3Rpb24gb3JkZXJQcmVzZW50UmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyKSB7XG4gICAgY29uc3QgY3VycmVudCA9ICgpID0+IGNvbmZpZyA9PT0gb3JkZXJDb25maWcgJiYgY29uZmlnLnNldHRpbmdzLmVuYWJsZWQgJiYgIWNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQ7XG4gICAgaWYgKCFyZXN1bHQub3JkZXJzLmxlbmd0aCB8fCAhY3VycmVudCgpKSByZXR1cm4gW107XG4gICAgY29uc3Qgbm90aWZ5ID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwZXJtaXNzaW9uID0gYXdhaXQgY2hyb21lLm5vdGlmaWNhdGlvbnMuZ2V0UGVybWlzc2lvbkxldmVsKCk7XG4gICAgICAgIGlmICghY3VycmVudCgpKSByZXR1cm47XG4gICAgICAgIGlmIChwZXJtaXNzaW9uICE9PSAnZ3JhbnRlZCcpIHRocm93IEVycm9yKCfQo9Cy0LXQtNC+0LzQu9C10L3QuNGPINC+0YLQutC70Y7Rh9C10L3RiyDQsiDQsdGA0LDRg9C30LXRgNC1Jyk7XG4gICAgICAgIGNvbnN0IG9yZGVycyA9IHJlc3VsdC5vcmRlcnM7XG4gICAgICAgIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNyZWF0ZShPUkRFUl9OT1RJRklDQVRJT05fSUQsIHsgdHlwZTogJ2Jhc2ljJywgaWNvblVybDogJ2ljb24ucG5nJyxcbiAgICAgICAgICAgIHRpdGxlOiAn8J+QuyBNZW1jaGF0IMK3INCX0LDQutCw0LfRizogJyArIG9yZGVycy5sZW5ndGgsXG4gICAgICAgICAgICBtZXNzYWdlOiBvcmRlcnMuc2xpY2UoMCwgMykubWFwKGl0ZW0gPT4gU3RyaW5nKGl0ZW0ubmFtZSkuc2xpY2UoMCwgODApICsgJyDCtyAnICsgU3RyaW5nKGl0ZW0ub3JnYW5pemF0aW9uTmFtZSkuc2xpY2UoMCwgODApKS5qb2luKCdcXG4nKSArIChyZXN1bHQucGFydGlhbCA/ICdcXG7imqAg0J7Qv9GA0L7RgSDQvdC10L/QvtC70L3Ri9C5JyA6ICcnKSxcbiAgICAgICAgICAgIHByaW9yaXR5OiAwLCBzaWxlbnQ6IHRydWUsIHJlcXVpcmVJbnRlcmFjdGlvbjogY29uZmlnLnNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzID09PSAwIH0pO1xuICAgICAgICBpZiAoIWN1cnJlbnQoKSkgeyBhd2FpdCBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpOyByZXR1cm47IH1cbiAgICAgICAgaWYgKGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyA+IDApIGF3YWl0IGNocm9tZS5hbGFybXMuY3JlYXRlKE9SREVSX05PVElGSUNBVElPTl9FWFBJUlksIHsgd2hlbjogRGF0ZS5ub3coKSArIGNvbmZpZy5zZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyAqIDYwMDAwIH0pO1xuICAgICAgICBlbHNlIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgfTtcbiAgICBjb25zdCB0YXNrcyA9IFtub3RpZnkoKV07XG4gICAgaWYgKGNvbmZpZy5zZXR0aW5ncy5zb3VuZEVuYWJsZWQpIHRhc2tzLnB1c2gob3JkZXJQbGF5QXVkaW8oY3VycmVudCkpO1xuICAgIGNvbnN0IG91dGNvbWVzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRhc2tzKTtcbiAgICByZXR1cm4gb3V0Y29tZXMuZmxhdE1hcCgoaXRlbSwgaW5kZXgpID0+IGl0ZW0uc3RhdHVzID09PSAncmVqZWN0ZWQnID8gW2luZGV4ID09PSAwID8gJ9Ch0LjRgdGC0LXQvNC90YvQtSDRg9Cy0LXQtNC+0LzQu9C10L3QuNGPINC90LXQtNC+0YHRgtGD0L/QvdGLJyA6ICfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvSddIDogW10pO1xufVxuaWYgKGNocm9tZS5ub3RpZmljYXRpb25zPy5vbkNsaWNrZWQpIGNocm9tZS5ub3RpZmljYXRpb25zLm9uQ2xpY2tlZC5hZGRMaXN0ZW5lcihpZCA9PiB7XG4gICAgaWYgKGlkICE9PSBPUkRFUl9OT1RJRklDQVRJT05fSUQpIHJldHVybjtcbiAgICBjaHJvbWUudGFicy5jcmVhdGUoeyB1cmw6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydS9hcHAvI2N1c3RvbWVyb3JkZXInLCBhY3RpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY2hyb21lLmFsYXJtcy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fRVhQSVJZKS5jYXRjaCgoKSA9PiB7fSk7XG59KTtcbiIsIi8vIFNoYXJlZCBvcmRlciBwb2xsaW5nIGlzIGluZGVwZW5kZW50IG9mIHRoZSBsaWZldGltZS9udW1iZXIgb2YgY29udGVudCB0YWJzLlxuLy8gU2Vzc2lvbiBzdG9yYWdlIGlzIGV4dGVuc2lvbi1wcml2YXRlOyBiZWFyZXIgbmV2ZXIgZW50ZXJzIGEgYnJvYWRjYXN0IG9yIGxvZ3MuXG5jb25zdCBPUkRFUl9TRVNTSU9OX0tFWSA9ICdtZW1jaGF0T3JkZXJTZXJ2aWNlX3YxJztcbmxldCBvcmRlckNvbmZpZyA9IG51bGw7XG5sZXQgb3JkZXJTdWJzY3JpYmVycyA9IG5ldyBTZXQoKTtcbmxldCBvcmRlclJldmlzaW9uID0gMDtcbmxldCBvcmRlckZsaWdodCA9IG51bGw7XG5sZXQgb3JkZXJDb250cm9sbGVyID0gbnVsbDtcbmxldCBvcmRlckxhc3RSZXN1bHQgPSBudWxsO1xubGV0IG9yZGVyQ29uZmlnQ2hhaW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmZ1bmN0aW9uIG9yZGVyTXV0YXRlKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgbmV4dCA9IG9yZGVyQ29uZmlnQ2hhaW4udGhlbihjYWxsYmFjayk7XG4gICAgb3JkZXJDb25maWdDaGFpbiA9IG5leHQuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBuZXh0O1xufVxuY29uc3Qgb3JkZXJSZWFkeSA9IChhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSAoYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5nZXQoT1JERVJfU0VTU0lPTl9LRVkpKVtPUkRFUl9TRVNTSU9OX0tFWV07XG4gICAgICAgIGlmIChzYXZlZCkgeyBvcmRlckNvbmZpZyA9IHNhdmVkLmNvbmZpZzsgb3JkZXJSZXZpc2lvbiA9IHNhdmVkLnJldmlzaW9uIHx8IDA7IG9yZGVyU3Vic2NyaWJlcnMgPSBuZXcgU2V0KHNhdmVkLnN1YnNjcmliZXJzIHx8IFtdKTsgfVxuICAgICAgICBhd2FpdCBvcmRlclVwZGF0ZUljb24oKTtcbiAgICB9IGNhdGNoIHsgLyogQ29uZmlndXJlIG11c3Qgc3VjY2Vzc2Z1bGx5IHBlcnNpc3QgYmVmb3JlIGVuYWJsaW5nIHBvbGxpbmcuICovIH1cbn0pKCk7XG5mdW5jdGlvbiBvcmRlclB1YmxpY0NvbmZpZygpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgc2V0dGluZ3M6IG9yZGVyQ29uZmlnPy5zZXR0aW5ncywgcmV2aXNpb246IG9yZGVyUmV2aXNpb24gfTtcbn1cbmZ1bmN0aW9uIG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgbmV3IFJlZ0V4cCgnXmh0dHBzOi8vYXBpXFxcXC5tb3lza2xhZFxcXFwucnUvYXBpL3JlbWFwLzFcXFxcLjIvZW50aXR5LycgKyBraW5kICsgJy9bQS1aYS16MC05LV0rJCcpLnRlc3QodmFsdWUpO1xufVxuZnVuY3Rpb24gb3JkZXJTZXR0aW5ncyhyYXcpIHtcbiAgICBjb25zdCByZWZzID0gKHZhbHVlcywga2luZCkgPT4ge1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWVzKSB8fCAhdmFsdWVzLmV2ZXJ5KHZhbHVlID0+IG9yZGVyUmVmZXJlbmNlKHZhbHVlLCBraW5kKSkpIHRocm93IEVycm9yKCdJbnZhbGlkIHJlZmVyZW5jZXMnKTtcbiAgICAgICAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhbHVlcyldO1xuICAgIH07XG4gICAgcmV0dXJuIHsgZW5hYmxlZDogcmF3Py5lbmFibGVkICE9PSBmYWxzZSwgc291bmRFbmFibGVkOiByYXc/LnNvdW5kRW5hYmxlZCAhPT0gZmFsc2UsXG4gICAgICAgIGludGVydmFsTWludXRlczogTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChOdW1iZXIocmF3Py5pbnRlcnZhbE1pbnV0ZXMpIHx8IDEpKSksXG4gICAgICAgIHRvYXN0RHVyYXRpb25NaW51dGVzOiBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKE51bWJlcihyYXc/LnRvYXN0RHVyYXRpb25NaW51dGVzKSB8fCAwKSkpLFxuICAgICAgICBvcmdhbml6YXRpb25IcmVmczogcmVmcyhyYXc/Lm9yZ2FuaXphdGlvbkhyZWZzLCAnb3JnYW5pemF0aW9uJyksXG4gICAgICAgIHN0YXR1c0hyZWZzOiByZWZzKHJhdz8uc3RhdHVzSHJlZnMsICdjdXN0b21lcm9yZGVyL21ldGFkYXRhL3N0YXRlcycpIH07XG59XG5hc3luYyBmdW5jdGlvbiBvcmRlclNldEFsYXJtKCkge1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQgfHwgIW9yZGVyQ29uZmlnLnNldHRpbmdzLnNvdW5kRW5hYmxlZCkgYXdhaXQgb3JkZXJTdG9wQXVkaW8oKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgaWYgKCFvcmRlckNvbmZpZz8uc2V0dGluZ3MuZW5hYmxlZCAmJiBjaHJvbWUubm90aWZpY2F0aW9ucz8uY2xlYXIpIGF3YWl0IGNocm9tZS5ub3RpZmljYXRpb25zLmNsZWFyKE9SREVSX05PVElGSUNBVElPTl9JRCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIC8vIFRvb2xiYXIgcHJlc2VudGF0aW9uIG11c3QgbmV2ZXIgcHJldmVudCBzY2hlZHVsaW5nIG9yIHBhdXNpbmcgdGhlIHNlcnZpY2UuXG4gICAgYXdhaXQgb3JkZXJVcGRhdGVJY29uKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGlmICghY2hyb21lLmFsYXJtcykgcmV0dXJuO1xuICAgIGlmICghb3JkZXJDb25maWc/LnNldHRpbmdzLmVuYWJsZWQpIGF3YWl0IGNocm9tZS5hbGFybXMuY2xlYXIoT1JERVJfTk9USUZJQ0FUSU9OX0VYUElSWSk7XG4gICAgaWYgKG9yZGVyQ29uZmlnPy5zZXR0aW5ncy5lbmFibGVkICYmIG9yZGVyQ29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCAmJiBvcmRlckNvbmZpZy5zZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHtcbiAgICAgICAgYXdhaXQgY2hyb21lLmFsYXJtcy5jcmVhdGUoJ21lbWNoYXQtb3JkZXJzJywgeyBwZXJpb2RJbk1pbnV0ZXM6IG9yZGVyQ29uZmlnLnNldHRpbmdzLmludGVydmFsTWludXRlcyB9KTtcbiAgICB9IGVsc2UgYXdhaXQgY2hyb21lLmFsYXJtcy5jbGVhcignbWVtY2hhdC1vcmRlcnMnKTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpIHtcbiAgICBhd2FpdCBvcmRlclJlYWR5O1xuICAgIGlmICh0eXBlb2YgbWVzc2FnZS50b2tlbiAhPT0gJ3N0cmluZycgfHwgIW1lc3NhZ2UudG9rZW4udHJpbSgpIHx8IG1lc3NhZ2UudG9rZW4ubGVuZ3RoID4gNDA5NikgdGhyb3cgRXJyb3IoJ0ludmFsaWQgdG9rZW4nKTtcbiAgICBjb25zdCBzZXR0aW5ncyA9IG9yZGVyU2V0dGluZ3MobWVzc2FnZS5zZXR0aW5ncyk7XG4gICAgY29uc3QgdW5jaGFuZ2VkID0gb3JkZXJDb25maWc/LnRva2VuID09PSBtZXNzYWdlLnRva2VuICYmIEpTT04uc3RyaW5naWZ5KG9yZGVyQ29uZmlnLnNldHRpbmdzKSA9PT0gSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpO1xuICAgIGlmIChvcmRlckNvbmZpZyAmJiAobWVzc2FnZS51cGRhdGUgIT09IHRydWUgfHwgdW5jaGFuZ2VkKSkge1xuICAgICAgICBpZiAob3JkZXJDb25maWcudG9rZW4gIT09IG1lc3NhZ2UudG9rZW4pIHJldHVybiB7IG9rOiBmYWxzZSwgcmV2aXNpb246IG9yZGVyUmV2aXNpb24sIGVycm9yOiAn0JTRgNGD0LPQvtC5IEJlYXJlciDQsiDRhNC+0L3QtS4g0KHQvtGF0YDQsNC90LjRgtC1INC90LDRgdGC0YDQvtC50LrQuCDRj9Cy0L3QviDQtNC70Y8g0YHQvNC10L3RiyDQsNC60LrQsNGD0L3RgtCwLicgfTtcbiAgICAgICAgb3JkZXJTdWJzY3JpYmVycy5hZGQoc2VuZGVyLnRhYi5pZCk7XG4gICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWc6IG9yZGVyQ29uZmlnLCByZXZpc2lvbjogb3JkZXJSZXZpc2lvbiwgc3Vic2NyaWJlcnM6IFsuLi5vcmRlclN1YnNjcmliZXJzXSB9IH0pO1xuICAgICAgICBpZiAoY2hyb21lLmFsYXJtcz8uZ2V0ICYmICEoYXdhaXQgY2hyb21lLmFsYXJtcy5nZXQoJ21lbWNoYXQtb3JkZXJzJykpKSBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIHBvbGxSZXF1aXJlZDogZmFsc2UgfTtcbiAgICB9XG4gICAgaWYgKG9yZGVyQ29uZmlnICYmIG1lc3NhZ2UucmV2aXNpb24gIT09IG9yZGVyUmV2aXNpb24pIHJldHVybiB7IC4uLm9yZGVyUHVibGljQ29uZmlnKCksIG9rOiBmYWxzZSwgY29uZmxpY3Q6IHRydWUsIGVycm9yOiAn0J3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90Ysg0LIg0LTRgNGD0LPQvtC5INCy0LrQu9Cw0LTQutC1LiDQn9C+0LLRgtC+0YDQuNGC0LUg0LjQt9C80LXQvdC10L3QuNC1LicgfTtcbiAgICBjb25zdCBzdWJzY3JpYmVycyA9IG9yZGVyQ29uZmlnPy50b2tlbiA9PT0gbWVzc2FnZS50b2tlbiA/IG5ldyBTZXQob3JkZXJTdWJzY3JpYmVycykgOiBuZXcgU2V0KCk7XG4gICAgc3Vic2NyaWJlcnMuYWRkKHNlbmRlci50YWIuaWQpO1xuICAgIGNvbnN0IGNvbmZpZyA9IHsgdG9rZW46IG1lc3NhZ2UudG9rZW4sIHNldHRpbmdzLCBvcmdhbml6YXRpb25zOiAoQXJyYXkuaXNBcnJheShtZXNzYWdlLm9yZ2FuaXphdGlvbnMpID8gbWVzc2FnZS5vcmdhbml6YXRpb25zIDogW10pXG4gICAgICAgIC5maWx0ZXIoaXRlbSA9PiBzZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5pbmNsdWRlcyhpdGVtPy5ocmVmKSkubWFwKGl0ZW0gPT4gKHsgaHJlZjogaXRlbS5ocmVmLCBuYW1lOiBTdHJpbmcoaXRlbS5uYW1lIHx8ICcnKS5zbGljZSgwLCAzMDApIH0pKSB9O1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWcsIHJldmlzaW9uOiBvcmRlclJldmlzaW9uICsgMSwgc3Vic2NyaWJlcnM6IFsuLi5zdWJzY3JpYmVyc10gfSB9KTtcbiAgICBvcmRlckNvbnRyb2xsZXI/LmFib3J0KCk7XG4gICAgb3JkZXJDb25maWcgPSBjb25maWc7IG9yZGVyU3Vic2NyaWJlcnMgPSBzdWJzY3JpYmVyczsgb3JkZXJSZXZpc2lvbisrOyBvcmRlckxhc3RSZXN1bHQgPSBudWxsO1xuICAgIGF3YWl0IG9yZGVyU2V0QWxhcm0oKTtcbiAgICByZXR1cm4geyAuLi5vcmRlclB1YmxpY0NvbmZpZygpLCBwb2xsUmVxdWlyZWQ6IHRydWUgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIG9yZGVyR2V0KHBhdGgsIGNvbmZpZywgY29udHJvbGxlcikge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcGVyZm9ybVJlcXVlc3QoeyBpZDogJ2JhY2tncm91bmQtb3JkZXJzJywgcmVxdWVzdDoge1xuICAgICAgICB1cmw6ICdodHRwczovL2FwaS5tb3lza2xhZC5ydS9hcGkvcmVtYXAvMS4yJyArIHBhdGgsIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIGhlYWRlcnM6IHsgQXV0aG9yaXphdGlvbjogJ0JlYXJlciAnICsgY29uZmlnLnRva2VuLCBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnIH0sXG4gICAgICAgIGFub255bW91czogdHJ1ZSwgYmFja2dyb3VuZE9yZGVyOiB0cnVlXG4gICAgfSB9LCB7IHRhYjogeyBpZDogLTEgfSwgZnJhbWVJZDogMCB9LCBjb250cm9sbGVyLnNpZ25hbCk7XG4gICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgfHwgY29uZmlnICE9PSBvcmRlckNvbmZpZykgdGhyb3cgRXJyb3IoJ0NhbmNlbGxlZCcpO1xuICAgIGlmIChyZXNwb25zZS5ldmVudCAhPT0gJ2xvYWQnKSB0aHJvdyBFcnJvcign0J7RiNC40LHQutCwINGB0L7QtdC00LjQvdC10L3QuNGPINGBINCc0L7QudCh0LrQu9Cw0LQnKTtcbiAgICBjb25zdCBzdGF0dXMgPSByZXNwb25zZS5yZXNwb25zZS5zdGF0dXM7XG4gICAgaWYgKHN0YXR1cyA8IDIwMCB8fCBzdGF0dXMgPj0gMzAwKSB7IGNvbnN0IGVycm9yID0gRXJyb3IoJ9Cc0L7QudCh0LrQu9Cw0LQ6IEhUVFAgJyArIHN0YXR1cyk7IGVycm9yLnN0YXR1cyA9IHN0YXR1czsgdGhyb3cgZXJyb3I7IH1cbiAgICBsZXQgZGF0YTtcbiAgICB0cnkgeyBkYXRhID0gSlNPTi5wYXJzZShyZXNwb25zZS5yZXNwb25zZS5yZXNwb25zZVRleHQpOyB9IGNhdGNoIHsgdGhyb3cgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQvtGC0LLQtdGCINCc0L7QudCh0LrQu9Cw0LQnKTsgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhPy5yb3dzKSkgdGhyb3cgRXJyb3IoJ9Cd0LXQv9C+0LvQvdGL0Lkg0L7RgtCy0LXRgiDRgdC/0LjRgdC60LAg0LfQsNC60LDQt9C+0LInKTtcbiAgICByZXR1cm4gZGF0YTtcbn1cbmFzeW5jIGZ1bmN0aW9uIGRlbGl2ZXJPcmRlclJlc3VsdChyZXN1bHQsIGNvbmZpZywgY29udHJvbGxlciwgcmV2aXNpb24pIHtcbiAgICBpZiAoIWNocm9tZS50YWJzPy5xdWVyeSkgcmV0dXJuO1xuICAgIGNvbnN0IHRhYnMgPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7fSk7XG4gICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSB0YWJzLmZpbHRlcih0YWIgPT4gb3JkZXJTdWJzY3JpYmVycy5oYXModGFiLmlkKSAmJiB0cnVzdGVkQ29udGVudFNlbmRlcih7IGlkOiBjaHJvbWUucnVudGltZS5pZCwgdGFiLCBmcmFtZUlkOiAwLCB1cmw6IHRhYi51cmwgfSkpO1xuICAgIGNhbmRpZGF0ZXMuc29ydCgoYSwgYikgPT4gTnVtYmVyKCEhYi5hY3RpdmUpIC0gTnVtYmVyKCEhYS5hY3RpdmUpKTtcbiAgICBmb3IgKGNvbnN0IHRhYiBvZiBjYW5kaWRhdGVzKSB7XG4gICAgICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgYWNrID0gYXdhaXQgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IHR5cGU6ICdtZW1jaGF0Om9yZGVycy1yZXN1bHQnLCByZXN1bHQsIHJldmlzaW9uLCBzZXR0aW5nczogY29uZmlnLnNldHRpbmdzIH0sIHsgZnJhbWVJZDogMCB9KTtcbiAgICAgICAgICAgIGlmIChhY2s/Lm9rKSBicmVhaztcbiAgICAgICAgfSBjYXRjaCB7IC8qIFRyeSBhbm90aGVyIGxpdmUgY29udGVudCB3b3JsZCwgbm90IGV2ZXJ5IHRhYi4gKi8gfVxuICAgIH1cbn1cbmFzeW5jIGZ1bmN0aW9uIHBvbGxPcmRlcnMoKSB7XG4gICAgYXdhaXQgb3JkZXJSZWFkeTtcbiAgICBhd2FpdCBvcmRlckNvbmZpZ0NoYWluO1xuICAgIGlmIChvcmRlckZsaWdodCkgcmV0dXJuIG9yZGVyRmxpZ2h0O1xuICAgIGNvbnN0IGNvbmZpZyA9IG9yZGVyQ29uZmlnO1xuICAgIGlmICghY29uZmlnPy5zZXR0aW5ncy5lbmFibGVkIHx8ICFjb25maWcuc2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoIHx8ICFjb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMubGVuZ3RoKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDQstGL0LrQu9GO0YfQtdC9INC40LvQuCDQvdC1INC90LDRgdGC0YDQvtC10L0nIH07XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgY29uc3QgcmV2aXNpb24gPSBvcmRlclJldmlzaW9uO1xuICAgICAgICBvcmRlckNvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xuICAgIG9yZGVyRmxpZ2h0ID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgZm91bmQgPSBuZXcgTWFwKCksIGZhaWxlZCA9IFtdO1xuICAgICAgICBsZXQgYXV0aEZhaWxlZCA9IGZhbHNlO1xuICAgICAgICBmb3IgKGNvbnN0IGhyZWYgb2YgY29uZmlnLnNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzKSB7XG4gICAgICAgICAgICBjb25zdCBsYWJlbCA9IGNvbmZpZy5vcmdhbml6YXRpb25zLmZpbmQoaXRlbSA9PiBpdGVtLmhyZWYgPT09IGhyZWYpPy5uYW1lIHx8ICfQntGA0LPQsNC90LjQt9Cw0YbQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwJztcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgcm93cyA9IG5ldyBNYXAoKTtcbiAgICAgICAgICAgICAgICBsZXQgb2Zmc2V0ID0gMDtcbiAgICAgICAgICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbHRlciA9IFsnb3JnYW5pemF0aW9uPScgKyBocmVmLCAuLi5jb25maWcuc2V0dGluZ3Muc3RhdHVzSHJlZnMubWFwKHN0YXRlID0+ICdzdGF0ZT0nICsgc3RhdGUpXS5qb2luKCc7Jyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBvcmRlckdldCgnL2VudGl0eS9jdXN0b21lcm9yZGVyP2ZpbHRlcj0nICsgZW5jb2RlVVJJQ29tcG9uZW50KGZpbHRlcilcbiAgICAgICAgICAgICAgICAgICAgICAgICsgJyZleHBhbmQ9c3RhdGUsb3JnYW5pemF0aW9uJm9yZGVyPW1vbWVudCxkZXNjJmxpbWl0PTEwMCZvZmZzZXQ9JyArIG9mZnNldCwgY29uZmlnLCBjb250cm9sbGVyKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSByb3dzLnNpemU7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3Qgcm93IG9mIGRhdGEucm93cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFyb3c/LmlkKSB0aHJvdyBFcnJvcign0JfQsNC60LDQtyDQsdC10Lcg0LjQtNC10L3RgtC40YTQuNC60LDRgtC+0YDQsCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93cy5zZXQocm93LmlkLCByb3cpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIG9mZnNldCArPSBkYXRhLnJvd3MubGVuZ3RoO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3JlID0gISFkYXRhLm1ldGE/Lm5leHRIcmVmIHx8IChOdW1iZXIuaXNGaW5pdGUoZGF0YS5tZXRhPy5zaXplKSA/IG9mZnNldCA8IGRhdGEubWV0YS5zaXplIDogZGF0YS5yb3dzLmxlbmd0aCA+PSAxMDApO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIW1vcmUpIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWRhdGEucm93cy5sZW5ndGggfHwgcm93cy5zaXplID09PSBwcmV2aW91cykgdGhyb3cgRXJyb3IoJ9Cf0LDQs9C40L3QsNGG0LjRjyDQt9Cw0LrQsNC30L7QsiDQvdC1INC/0YDQvtC00LLQuNCz0LDQtdGC0YHRjycpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHJvdyBvZiByb3dzLnZhbHVlcygpKSBpZiAoY29uZmlnLnNldHRpbmdzLnN0YXR1c0hyZWZzLmluY2x1ZGVzKHJvdy5zdGF0ZT8ubWV0YT8uaHJlZikpIHtcbiAgICAgICAgICAgICAgICAgICAgZm91bmQuc2V0KHJvdy5pZCwgeyBpZDogcm93LmlkLCBuYW1lOiByb3cubmFtZSB8fCByb3cuaWQsIHN0YXRlTmFtZTogcm93LnN0YXRlPy5uYW1lIHx8ICfQndC+0LLRi9C5Jywgb3JnYW5pemF0aW9uTmFtZTogbGFiZWwsIG9yZ2FuaXphdGlvbkhyZWY6IGhyZWYgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCB8fCBjb25maWcgIT09IG9yZGVyQ29uZmlnKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvTog0L3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90YsnIH07XG4gICAgICAgICAgICAgICAgZmFpbGVkLnB1c2gobGFiZWwgKyAnIOKAlCAnICsgKGVycm9yLm1lc3NhZ2UgfHwgJ9Ce0YjQuNCx0LrQsCDQt9Cw0L/RgNC+0YHQsCcpKTtcbiAgICAgICAgICAgICAgICBpZiAoWzQwMSwgNDAzXS5pbmNsdWRlcyhlcnJvci5zdGF0dXMpKSB7IGF1dGhGYWlsZWQgPSB0cnVlOyBicmVhazsgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8IGNvbmZpZyAhPT0gb3JkZXJDb25maWcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICfQntC/0YDQvtGBINC+0YLQvNC10L3RkdC9JyB9O1xuICAgICAgICBpZiAoYXV0aEZhaWxlZCkge1xuICAgICAgICAgICAgYXdhaXQgb3JkZXJNdXRhdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjb25maWcgIT09IG9yZGVyQ29uZmlnIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgICAgICAgICAgICBjb25maWcuc2V0dGluZ3MuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLnNlc3Npb24uc2V0KHsgW09SREVSX1NFU1NJT05fS0VZXTogeyBjb25maWcsIHJldmlzaW9uOiArK29yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29uZmlnICE9PSBvcmRlckNvbmZpZyB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAn0J7Qv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScgfTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0geyBpZDogU3RyaW5nKERhdGUubm93KCkpICsgJy0nICsgb3JkZXJSZXZpc2lvbiwgb3JkZXJzOiBbLi4uZm91bmQudmFsdWVzKCldLCBmYWlsZWQsIHBhcnRpYWw6IGZhaWxlZC5sZW5ndGggPiAwLFxuICAgICAgICAgICAgYmVhcmVyOiBhdXRoRmFpbGVkID8gJ2Vycm9yJyA6IGZhaWxlZC5sZW5ndGggPT09IGNvbmZpZy5zZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggPyAndW5rbm93bicgOiAnb2snLCBhdDogRGF0ZS5ub3coKSB9O1xuICAgICAgICByZXN1bHQub3JkZXJzLmZvckVhY2gob3JkZXIgPT4geyBvcmRlci5wYXJ0aWFsID0gcmVzdWx0LnBhcnRpYWw7IH0pO1xuICAgICAgICBvcmRlckxhc3RSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgIHJlc3VsdC5hbGVydFdhcm5pbmdzID0gYXdhaXQgb3JkZXJQcmVzZW50UmVzdWx0KHJlc3VsdCwgY29uZmlnLCBjb250cm9sbGVyKTtcbiAgICAgICAgaWYgKGNvbmZpZyAhPT0gb3JkZXJDb25maWcgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ9Ce0L/RgNC+0YEg0L7RgtC80LXQvdGR0L06INC90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLJyB9O1xuICAgICAgICBhd2FpdCBkZWxpdmVyT3JkZXJSZXN1bHQocmVzdWx0LCBjb25maWcsIGNvbnRyb2xsZXIsIHJldmlzaW9uKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlc3VsdCB9O1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IG9yZGVyRmxpZ2h0ID0gbnVsbDsgaWYgKG9yZGVyQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgb3JkZXJDb250cm9sbGVyID0gbnVsbDsgfSk7XG4gICAgcmV0dXJuIG9yZGVyRmxpZ2h0O1xufVxuaWYgKGNocm9tZS5hbGFybXMpIGNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihhbGFybSA9PiB7XG4gICAgaWYgKGFsYXJtLm5hbWUgPT09IE9SREVSX05PVElGSUNBVElPTl9FWFBJUlkpIHJldHVybiBjaHJvbWUubm90aWZpY2F0aW9ucy5jbGVhcihPUkRFUl9OT1RJRklDQVRJT05fSUQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBpZiAoYWxhcm0ubmFtZSA9PT0gJ21lbWNoYXQtb3JkZXJzJykgcmV0dXJuIHBvbGxPcmRlcnMoKS5jYXRjaCgoKSA9PiB7fSk7XG59KTtcbiIsIid1c2Ugc3RyaWN0JztcblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtdGVzdC1zb3VuZCcpIHtcbiAgICAgICAgaWYgKCF0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L7RgtC60LvQvtC90ZHQvScgfSk7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICBvcmRlclBsYXlBdWRpbygpLnRoZW4oKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSksICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cy0YPQuiDRgNCw0YHRiNC40YDQtdC90LjRjyDQvdC10LTQvtGB0YLRg9C/0LXQvScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpzdG9yYWdlLWluaXQnLCAnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHtcbiAgICAgICAgaWYgKCF0cnVzdGVkQ29udGVudFNlbmRlcihzZW5kZXIpKSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQl9Cw0L/RgNC+0YEg0YXRgNCw0L3QuNC70LjRidCwINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgcHJpdmF0ZVN0b3JhZ2VNZXNzYWdlKG1lc3NhZ2UsIHNlbmRlcikudGhlbihzZW5kUmVzcG9uc2UsXG4gICAgICAgICAgICAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0LTQsNC90L3Ri9C1INGA0LDRgdGI0LjRgNC10L3QuNGPLiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDQstC60LvQsNC00LrRgzsg0YHRgtCw0YDRi9C1INC00LDQvdC90YvQtSDQvdC1INGD0LTQsNC70LXQvdGLLicgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKFsnbWVtY2hhdDpvcmRlcnMtY29uZmlndXJlJywgJ21lbWNoYXQ6b3JkZXJzLXBvbGwnLCAnbWVtY2hhdDpvcmRlcnMtc3RvcCddLmluY2x1ZGVzKG1lc3NhZ2U/LnR5cGUpKSB7XG4gICAgICAgIGlmICghdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSkgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgY29uc3Qgd29yayA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyUmVhZHk7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnbWVtY2hhdDpvcmRlcnMtY29uZmlndXJlJykgcmV0dXJuIG9yZGVyTXV0YXRlKCgpID0+IGNvbmZpZ3VyZU9yZGVycyhtZXNzYWdlLCBzZW5kZXIpKTtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0Om9yZGVycy1zdG9wJykgcmV0dXJuIG9yZGVyTXV0YXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgICAgIG9yZGVyQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICAgICAgICAgICAgICBvcmRlckNvbmZpZy5zZXR0aW5ncy5lbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc2Vzc2lvbi5zZXQoeyBbT1JERVJfU0VTU0lPTl9LRVldOiB7IGNvbmZpZzogb3JkZXJDb25maWcsIHJldmlzaW9uOiArK29yZGVyUmV2aXNpb24sIHN1YnNjcmliZXJzOiBbLi4ub3JkZXJTdWJzY3JpYmVyc10gfSB9KTtcbiAgICAgICAgICAgICAgICBhd2FpdCBvcmRlclNldEFsYXJtKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9yZGVyUHVibGljQ29uZmlnKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IG9yZGVyQ29uZmlnQ2hhaW47XG4gICAgICAgICAgICBpZiAoIW9yZGVyQ29uZmlnIHx8IG1lc3NhZ2UudG9rZW4gIT09IG9yZGVyQ29uZmlnLnRva2VuKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnQmVhcmVyINC90LUg0YHQvtCy0L/QsNC00LDQtdGCINGBINGE0L7QvdC+0LLRi9C8INC+0L/RgNC+0YHQvtC8JyB9O1xuICAgICAgICAgICAgcmV0dXJuIHBvbGxPcmRlcnMoKTtcbiAgICAgICAgfTtcbiAgICAgICAgd29yaygpLnRoZW4oc2VuZFJlc3BvbnNlLCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvdCw0YHRgtGA0L7QuNGC0Ywg0YTQvtC90L7QstGL0Lkg0L7Qv9GA0L7RgScgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICdtZW1jaGF0OnBhbmVsLWNzcmYnKSB7XG4gICAgICAgIGlmICghdHJ1c3RlZENvbnRlbnRTZW5kZXIoc2VuZGVyKSB8fCAobWVzc2FnZS5mb3JjZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBtZXNzYWdlLmZvcmNlICE9PSAnYm9vbGVhbicpKSB7XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGdldFBhbmVsU2Vzc2lvbihtZXNzYWdlLmZvcmNlID09PSB0cnVlKS50aGVuKHNlbmRSZXNwb25zZSxcbiAgICAgICAgICAgICgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgZXJyb3I6ICdQYW5lbDog0YTQvtC90L7QstCw0Y8g0YHQtdGB0YHQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwLicgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKCFbJ21lbWNoYXQ6aHR0cCcsICdtZW1jaGF0OmFib3J0J10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoIXRydXN0ZWRDb250ZW50U2VuZGVyKHNlbmRlcikgfHwgdHlwZW9mIG1lc3NhZ2UuaWQgIT09ICdzdHJpbmcnIHx8ICEvXlthLXpBLVowLTktXXsxLDgwfSQvLnRlc3QobWVzc2FnZS5pZCkpIHtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAn0JfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPINC+0YLQutC70L7QvdGR0L0nIH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OmFib3J0Jykge1xuICAgICAgICBjb25zdCBlbnRyeSA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQocmVxdWVzdEtleShzZW5kZXIsIG1lc3NhZ2UuaWQpKTtcbiAgICAgICAgaWYgKGVudHJ5KSB7IGVudHJ5LmV2ZW50ID0gJ2Fib3J0JzsgZW50cnkuY29udHJvbGxlci5hYm9ydCgpOyB9XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHBlcmZvcm1SZXF1ZXN0KG1lc3NhZ2UsIHNlbmRlcikudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBpZiAocmVzdWx0LmV2ZW50ID09PSAnbG9hZCcgJiYgWzQwMSwgNDAzLCA0MTldLmluY2x1ZGVzKHJlc3VsdC5yZXNwb25zZT8uc3RhdHVzKVxuICAgICAgICAgICAgJiYgbmV3IFVSTChtZXNzYWdlLnJlcXVlc3QudXJsKS5vcmlnaW4gPT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScpIHtcbiAgICAgICAgICAgIGNvbnN0IHNlbnRUb2tlbiA9IG5ldyBIZWFkZXJzKG1lc3NhZ2UucmVxdWVzdC5oZWFkZXJzIHx8IHt9KS5nZXQoJ3gtY3NyZi10b2tlbicpO1xuICAgICAgICAgICAgaWYgKHNlbnRUb2tlbiAmJiBzZW50VG9rZW4gPT09IHBhbmVsU2Vzc2lvbj8udG9rZW4pIHtcbiAgICAgICAgICAgICAgICBwYW5lbFNlc3Npb24gPSBudWxsO1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wYW5lbEF1dGhMb3N0ID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzZW5kUmVzcG9uc2UocmVzdWx0KTtcbiAgICB9LCAoKSA9PiBzZW5kUmVzcG9uc2UoeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQndC10LTQvtC/0YPRgdGC0LjQvNGL0Lkg0LfQsNC/0YDQvtGBINGA0LDRgdGI0LjRgNC10L3QuNGPJyB9KSk7XG4gICAgcmV0dXJuIHRydWU7XG59KTtcblxuLy8gUmVnaXN0ZXIgdG9vbGJhci9jb250ZXh0LW1lbnUgbGlzdGVuZXJzIHN5bmNocm9ub3VzbHkgb24gZXZlcnkgd29ya2VyIHdha2UuXG5pbXBvcnRTY3JpcHRzKCdjb250cm9scy5qcycpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EifQ==
