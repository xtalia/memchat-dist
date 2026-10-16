'use strict';
importScripts('config.js');

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

// One scheduler for every content tab in this extension profile. Other hosts
// never enter this queue. 500ms is our safety margin, not an API quota claim.
const msQueue = [];
let msActive = 0;
let msNextAt = 0;
let msBlockedUntil = 0;
let msBudgetUntil = 0;
let msRemaining = null;
let msLastHttp = null;
let msLastApiCode = null;
let msRateHeaders = {};
let msQueueTimer = null;
const MS_SESSION_KEY = 'memchatMsQuota_v1';
const msLeases = new Set();
let msStorageFailed = false;
let msDispatching = false;
let msWriteChain = Promise.resolve();
const msReady = (async () => {
    try {
        const saved = (await chrome.storage.session.get(MS_SESSION_KEY))[MS_SESSION_KEY];
        const timestamp = value => Number.isFinite(value) && value > 0 ? value : 0;
        msNextAt = timestamp(saved?.nextAt);
        msBlockedUntil = Math.max(timestamp(saved?.blockedUntil), ...(saved?.leases || []).map(timestamp));
        msBudgetUntil = timestamp(saved?.budgetUntil);
        msRemaining = Number.isFinite(saved?.remaining) && saved.remaining >= 0 ? saved.remaining : null;
    } catch { msStorageFailed = true; }
})();
function msPersist() {
    const snapshot = { nextAt: msNextAt, blockedUntil: msBlockedUntil,
        budgetUntil: msBudgetUntil, remaining: msRemaining, leases: [...msLeases] };
    msWriteChain = msWriteChain.then(async () => {
        try { await chrome.storage.session.set({ [MS_SESSION_KEY]: snapshot }); }
        catch { msStorageFailed = true; }
    });
    return msWriteChain;
}
function msSchedulerStats() {
    return { ...msRateHeaders, inFlight: msActive, queued: msQueue.length, nextAt: msNextAt,
        blockedUntil: msBlockedUntil, budgetUntil: msBudgetUntil, remaining: msRemaining,
        httpStatus: msLastHttp, apiCode: msLastApiCode };
}
function isMsJsonApi(url) {
    return url.hostname === 'api.moysklad.ru' && /^\/api\/remap\/1\.2(?:\/|$)/.test(url.pathname);
}
function msRequestWeight(url, method) {
    // Reserve December's user-token cost now; a Bearer is not proof of a
    // published solution. Stock reports cost five units in every auth mode.
    return method === 'GET' && /^\/api\/remap\/1\.2\/report\/stock\/(all|bystore)\/?$/.test(url.pathname) ? 5 : 4;
}
function msObserve(response, text) {
    const number = name => {
        const raw = response.headers.get(name);
        const value = raw?.trim() ? Number(raw) : NaN;
        return Number.isFinite(value) && value >= 0 ? value : null;
    };
    const remaining = number('X-RateLimit-Remaining');
    const limit = number('X-RateLimit-Limit');
    const interval = number('X-Lognex-Retry-TimeInterval') || 3000;
    const reset = number('X-Lognex-Reset') || interval;
    const retry = number('X-Lognex-Retry-After') || 0;
    msRateHeaders = { limit, intervalMs: interval, resetMs: reset, retryAfterMs: retry, updatedAt: Date.now() };
    msLastHttp = response.status;
    try { msLastApiCode = Number(JSON.parse(text)?.errors?.[0]?.code) || null; }
    catch { msLastApiCode = null; }
    const limited = response.status === 429 || msLastApiCode === 1073;
    if (remaining !== null) {
        // Never replenish from an out-of-order response within this window.
        const available = Math.max(0, Math.min(remaining, limit ?? remaining) - Math.max(0, msActive - 1) * 5);
        msRemaining = Date.now() < msBudgetUntil && msRemaining !== null ? Math.min(msRemaining, available) : available;
        msBudgetUntil = Math.max(msBudgetUntil, Date.now() + reset);
        if (msRemaining < 5) msBlockedUntil = Math.max(msBlockedUntil, msBudgetUntil);
        else msNextAt = Math.max(msNextAt, Date.now() + Math.ceil(reset / Math.max(1, Math.floor(msRemaining / 5)) * 1.2));
    }
    if (limited) msBlockedUntil = Math.max(msBlockedUntil, Date.now() + Math.max(retry, reset, interval, 1000));
    return limited;
}
function msPump() {
    if (msQueueTimer) { clearTimeout(msQueueTimer); msQueueTimer = null; }
    if (!msQueue.length || msActive >= 2 || msDispatching) return;
    if (Date.now() >= msBudgetUntil) msRemaining = null;
    const delay = Math.max(msNextAt, msBlockedUntil) - Date.now();
    if (delay > 0) { msQueueTimer = setTimeout(msPump, delay); return; }
    const task = msQueue.shift();
    task.signal.removeEventListener('abort', task.cancel);
    msActive++;
    // Persist a maximum network deadline BEFORE dispatch. A new MV3 instance
    // waits out uncertain old flights, never replays them (especially writes).
    const lease = Date.now() + 30000;
    msLeases.add(lease);
    msDispatching = true;
    msPersist().then(async () => {
        // A request may have waited in the worker after content dispatch (or
        // between GET retries). Recheck its original scope over private runtime.
        if (!msStorageFailed && !task.signal.aborted && task.checkCurrent) await task.checkCurrent();
        // Saving a lease yields to other responses. Admission must use their
        // latest cooldown/budget, not the state from before the storage write.
        if (msStorageFailed || task.signal.aborted) {
            msLeases.delete(lease); msActive--;
            task.reject(new Error(msStorageFailed ? 'Quota state unavailable' : 'Cancelled'));
            await msPersist();
        } else if (Math.max(msNextAt, msBlockedUntil) > Date.now()) {
            msLeases.delete(lease); msActive--;
            task.signal.addEventListener('abort', task.cancel, { once: true });
            msQueue.unshift(task);
            await msPersist();
        } else {
            if (Date.now() >= msBudgetUntil) msRemaining = null;
            msNextAt = Math.max(msNextAt, Date.now() + 500 * task.weight / 4);
            if (msRemaining !== null) {
                msRemaining = Math.max(0, msRemaining - task.weight);
                if (msRemaining < 5) msBlockedUntil = Math.max(msBlockedUntil, msBudgetUntil);
            }
            const release = async () => {
                msLeases.delete(lease); msActive--;
                await msPersist();
                msPump();
            };
            release.deadline = lease;
            task.resolve(release);
        }
        msDispatching = false;
        msPump();
    });
}
async function msAcquire(signal, weight, checkCurrent) {
    await msReady;
    if (msStorageFailed) throw new Error('Quota state unavailable');
    return new Promise((resolve, reject) => {
        const task = { signal, weight, checkCurrent, resolve, reject, cancel: null };
        task.cancel = () => {
            const index = msQueue.indexOf(task);
            if (index >= 0) msQueue.splice(index, 1);
            reject(new Error('Cancelled'));
            msPump();
        };
        if (signal.aborted) { reject(new Error('Cancelled')); return; }
        signal.addEventListener('abort', task.cancel, { once: true });
        msQueue.push(task);
        msPump();
    });
}

async function performRequest(message, sender) {
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
    const timeout = Math.min(30000, Math.max(1, Number(request.timeout) || 30000));
    let timer;
    let release;
    const checkCurrent = request.credentialGuard === true ? async () => {
        let checkTimer;
        try {
            const result = await Promise.race([
                chrome.tabs.sendMessage(sender.tab.id, { type: 'memchat:request-current', id: message.id }, { frameId: sender.frameId }),
                new Promise(resolve => { checkTimer = setTimeout(() => resolve(null), 1000); })
            ]);
            if (result?.current === true) return;
        } catch { /* Missing/invalidated content world fails closed. */ }
        finally { clearTimeout(checkTimer); }
        entry.event = 'abort';
        entry.controller.abort();
    } : null;
    try {
        await rulesReady;
        if (ruleFailure) throw new Error('Network rules unavailable');
        for (let attempt = 0; ; attempt++) {
            if (entry.event) return { event: entry.event };
            if (isMsJsonApi(url)) release = await msAcquire(entry.controller.signal, msRequestWeight(url, method), checkCurrent);
            if (entry.event) return { event: entry.event };
            const networkTime = Math.min(timeout, release ? release.deadline - Date.now() : timeout);
            if (networkTime <= 0) return { event: 'timeout' };
            timer = setTimeout(() => { entry.event = 'timeout'; entry.controller.abort(); }, networkTime);
            const response = await fetch(url.href, {
                method, headers, body: request.data ?? undefined,
                credentials: request.anonymous === true ? 'omit' : 'include',
                signal: entry.controller.signal, redirect: isMsJsonApi(url) ? 'error' : 'follow'
            });
            // DNR blocks redirects to ungranted hosts before any bytes are sent there.
            allowedUrl(response.url || url.href);
            const responseText = await response.text();
            const limited = isMsJsonApi(url) && msObserve(response, responseText);
            if (entry.event) return { event: entry.event };
            if (limited && method === 'GET' && attempt < 2) {
                msBlockedUntil = Math.max(msBlockedUntil, Date.now() + 1000 * 2 ** attempt);
                clearTimeout(timer);
                await release?.();
                release = null;
                continue;
            }
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
        return { event: entry.event || 'error', error: 'Ошибка сети расширения Memchat' };
    } finally {
        clearTimeout(timer);
        await release?.();
        pendingRequests.delete(key);
    }
}

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

function startPanelSessionFlight(force) {
    // A queued normal flight may have populated the cache since force was requested.
    if (force) panelSession = null;
    const flight = { promise: null };
    flight.promise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PANEL_SESSION_TIMEOUT);
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
                return { ok: false, reason: 'auth', error: 'Panel: нет авторизации. Войдите в panel.hatiko.ru в этом профиле Chrome.' };
            }
            const token = extractPanelSessionToken(await response.text());
            if (!token || controller.signal.aborted) return { ok: false, reason: 'auth', error: 'Panel: нет авторизации. Войдите в panel.hatiko.ru в этом профиле Chrome.' };
            panelSession = { token, savedAt: Date.now() };
            return { ok: true, token };
        } catch {
            return { ok: false, reason: 'network', error: 'Panel: не удалось получить сессию в фоне. Проверьте соединение и вход в panel.hatiko.ru.' };
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    performRequest(message, sender).then(sendResponse, () => sendResponse({ event: 'error', error: 'Недопустимый запрос расширения' }));
    return true;
});

// Register toolbar/context-menu listeners synchronously on every worker wake.
importScripts('controls.js');
