// ==UserScript==
// @name         Мемный чат с калькулятором
// @namespace    http://tampermonkey.net/
// @version      6.4.0
// @description  Мемный чат: вкладки, история по режимам, расписание «Кто/Где», настройки вкладкой
// @match        https://online.moysklad.ru/*
// @match        https://*.bitrix24.ru/*
// @match        https://*.hatiko.ru/*
// @downloadURL  https://raw.githubusercontent.com/xtalia/memchat-dist/main/memchat.user.js
// @updateURL    https://raw.githubusercontent.com/xtalia/memchat-dist/main/memchat.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      hatiko.ru
// @connect      *.hatiko.ru
// @connect      panel.hatiko.ru
// @connect      docs.google.com
// @connect      github.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

// Production-файл собирается из js/memchat/src/*.js.


/* ===== 01-config-and-state.js ===== */

'use strict';

const MEMCHAT_VERSION = '6.4.0';

// Режимные вкладки: Enter в поле ввода выполняет действие. Вкладки-действия
// (today/tomorrow/hacker) и «Настройки» открывают окно/контент по клику.
const MODE_ACTIONS = [
    'checkHatiko', 'checkHatikoBonuses',
    'calculator', 'calculator_reverse', 'calculator_discount', 'calculator_simple'
];

// ─── Константы ───────────────────────────────────────────────────────────────
const BASE_URLS = [
    "https://hatiko.ru",
    "https://voronezh.hatiko.ru",
    "https://lipetsk.hatiko.ru",
    "https://balakovo.hatiko.ru"
];
const CITY_ICONS = ['🆂', '🆅', '🅻', '🗿'];
const CITY_NAMES = ['Саратов', 'Воронеж', 'Липецк', 'Балаково'];

// ─── Правила калькулятора по умолчанию ───────────────────────────────────────
const DEFAULT_CALC_RULES = [
    { name: "Наличными",      percent: 100,   round: 1,   extra: 0   },
    { name: "QR",             percent: 101.5, round: 100, extra: -10 },
    { name: "Картой",         percent: 102,   round: 100, extra: -10 },
    { name: "Рассрочка 6м",   percent: 107,   round: 100, extra: -10 },
    { name: "Рассрочка 10м",  percent: 109,   round: 100, extra: -10 },
    { name: "Рассрочка 12м",  percent: 110,   round: 100, extra: -10 },
    { name: "Рассрочка 18м",  percent: 113,   round: 100, extra: -10 },
    { name: "Рассрочка 24м",  percent: 116,   round: 100, extra: -10 },
    { name: "Рассрочка 36м",  percent: 120,   round: 100, extra: -10 },
    { name: "Кэшбэк 1%",      percent: 1,     round: 1,   extra: 0,  isCashback: true }
];

// ─── Замены расписания по умолчанию ──────────────────────────────────────────
const DEFAULT_REPLACEMENTS = {
    "У":     "😎 как Управляющий",
    "М":     "🙂 как Менеджер",
    "M":     "🙂 как Менеджер",
    "РБ":    "🏪 в ТЦ Рубин",
    "Р":     "🏪 на Рахова",
    "К":     "🏪 на Казачьей",
    "Ч":     "🏪 на Чернышевского",
    "C":     "🏪 в ТЦ СитиМолл",
    "С":     "🏪 в ТЦ СитиМолл",
    "И":     "😱 как SMM",
    "1":     "🧑‍💼 Работает",
    "А":     "👀 Шатает Авито",
    "114":   "🛠️ на Чернышевского 📞114",
    "111":   "🛠️ в ТЦ Рубин 📞111",
    "104":   "🛠️ на Казачьей 📞104",
    "107":   "🛠️ на Казачьей, Старший(-ая) 📞107",
    "К-100": "🏪 на Казачьей 📞100",
    "К-101": "🏪 на Казачьей 📞101",
    "Р-116": "🏪 на Рахова 📞116",
    "Р-117": "🏪 на Рахова 📞117",
    "РБ-111":"🏪 в ТЦ Рубин 📞117",
    "Ч-114": "🏪 На Чернышевского 📞114",
    "С130":  "🏪 в ТЦ СитиМолл 📞131",
    "С131":  "🏪 в ТЦ СитиМолл 📞131",
    "С132":  "🏪 в ТЦ СитиМолл 📞132",
    "300":   "🏪 Никитинская 44 📞300",
    "310":   "⛵ Галерея Чижова 📞310",
    "311":   "⛵ Галерея Чижова 📞311"
};

// ─── Состояние ────────────────────────────────────────────────────────────────
let isDragging    = false;
let offset        = { x: 0, y: 0 };
let currentAction = null;
// История чата: по массиву на вкладку (switch-key), живёт только в памяти сессии.
// Вкладку «Бонусы» намеренно не персистим — там номера телефонов клиентов (ПДн).
let chatHistoryByAction = {};
let clearTextEnabled = false;
let globalClearKeypressBound = false;
let calcRules     = [];
let scheduleReplacements = {};
let currentHatikoPathname = '';
let lastHatikoResults = [];
let lastHatikoQuery = '';
let hatikoSearchMode = 'auto';
let activeRequestId = 0;

// ─── Скрытие полей МойСклад ──────────────────────────────────────────────────
let hiddenFields = [];        // имена полей (точный текст лейбла), прячемых на МойСклад
let msFieldsRevealed = false; // «раскрыть всё» с плавающей кнопки 👁 (временно)
let msFieldObserver = null;
let msHiddenTargets = [];     // [{el, name}] — реально спрятанные сейчас элементы
const KNOWN_MS_FIELDS = [
    'Оплачено бонусами', 'Сумма НДС', 'Промежуточный итог', 'Общая стоимость',
    'Объем', 'Вес', 'Канал продаж', 'Проект', 'Адрес доставки', 'Комментарий',
    'Номер заказа на сайте', 'План. дата отгрузки', 'Договор', 'Валюта документа'
];

const DEBUG_STORAGE_KEY = 'memchat:debug';

// ─── История чата по вкладкам ─────────────────────────────────────────────────
function historyFor(action) {
    const key = action || 'checkHatiko';
    if (!chatHistoryByAction[key]) chatHistoryByAction[key] = [];
    return chatHistoryByAction[key];
}

function activeHistory() {
    return historyFor(currentAction);
}

function isDebugEnabled() {
    try {
        return localStorage.getItem(DEBUG_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

function debugLog(scope, ...args) {
    if (isDebugEnabled()) console.debug(`[Memchat:${scope}]`, ...args);
}

function debugError(scope, ...args) {
    console.error(`[Memchat:${scope}]`, ...args);
}

function toggleDebugMode() {
    const enabled = !isDebugEnabled();
    try {
        localStorage.setItem(DEBUG_STORAGE_KEY, String(enabled));
    } catch (error) {
        debugError('debug', 'Не удалось сохранить режим отладки', error);
    }
    console.info(`[Memchat:debug] ${enabled ? 'включена' : 'выключена'}`);
}

function installDebugHandlers() {
    window.addEventListener('error', event => {
        debugError('uncaught', event.error || event.message, event.filename, event.lineno);
    });
    window.addEventListener('unhandledrejection', event => {
        debugError('promise', event.reason);
    });
}

/* ===== 02-storage-and-transport.js ===== */

// ─── Загрузка / сохранение ────────────────────────────────────────────────────
function storageKey(key) {
    return `${typeof MEMCHAT_BUILD !== 'undefined' ? `memchat:${MEMCHAT_BUILD}:` : 'memchat:'}${key}`;
}

function loadCalcRules() {
    try {
        const key = storageKey('calcRules_v2');
        const legacyKey = 'calcRules_v2';
        const s = localStorage.getItem(key)
            || (typeof MEMCHAT_BUILD === 'undefined' ? localStorage.getItem(legacyKey) : null);
        calcRules = s ? JSON.parse(s) : JSON.parse(JSON.stringify(DEFAULT_CALC_RULES));
        if (s && !localStorage.getItem(key)) saveCalcRules();
    } catch { calcRules = JSON.parse(JSON.stringify(DEFAULT_CALC_RULES)); }
}
function saveCalcRules() {
    localStorage.setItem(storageKey('calcRules_v2'), JSON.stringify(calcRules));
}

function loadScheduleReplacements() {
    try {
        const key = storageKey('scheduleReplacements_v1');
        const legacyKey = 'scheduleReplacements_v1';
        const s = localStorage.getItem(key)
            || (typeof MEMCHAT_BUILD === 'undefined' ? localStorage.getItem(legacyKey) : null);
        scheduleReplacements = s ? JSON.parse(s) : JSON.parse(JSON.stringify(DEFAULT_REPLACEMENTS));
        if (s && !localStorage.getItem(key)) saveScheduleReplacements();
    } catch { scheduleReplacements = JSON.parse(JSON.stringify(DEFAULT_REPLACEMENTS)); }
}
function saveScheduleReplacements() {
    localStorage.setItem(storageKey('scheduleReplacements_v1'), JSON.stringify(scheduleReplacements));
}

function loadSelectedAction() {
    try {
        return localStorage.getItem(storageKey('selectedAction_v1')) || 'checkHatiko';
    } catch {
        return 'checkHatiko';
    }
}

function saveSelectedAction(action) {
    try {
        localStorage.setItem(storageKey('selectedAction_v1'), action);
    } catch (error) {
        debugError('storage', 'Не удалось сохранить выбранный режим', error);
    }
}

function loadShowHatikoLinks() {
    try {
        return localStorage.getItem(storageKey('showHatikoLinks_v1')) === 'true';
    } catch {
        return false;
    }
}

function saveShowHatikoLinks(enabled) {
    try {
        localStorage.setItem(storageKey('showHatikoLinks_v1'), String(enabled));
    } catch (error) {
        debugError('storage', 'Не удалось сохранить настройку ссылок Hatiko', error);
    }
}

function loadHatikoSearchMode() {
    try {
        const mode = localStorage.getItem(storageKey('hatikoSearchMode_v1'));
        return ['auto', 'panel', 'hatiko'].includes(mode) ? mode : 'auto';
    } catch { return 'auto'; }
}

function saveHatikoSearchMode(mode) {
    if (!['auto', 'panel', 'hatiko'].includes(mode)) return;
    hatikoSearchMode = mode;
    localStorage.setItem(storageKey('hatikoSearchMode_v1'), mode);
}

// ─── Скрытые поля МойСклад ───────────────────────────────────────────────────
function loadHiddenFields() {
    try {
        const s = localStorage.getItem(storageKey('hiddenFields_v1'));
        const parsed = s ? JSON.parse(s) : [];
        hiddenFields = Array.isArray(parsed) ? parsed.filter(n => typeof n === 'string') : [];
    } catch { hiddenFields = []; }
}

function saveHiddenFields() {
    try {
        localStorage.setItem(storageKey('hiddenFields_v1'), JSON.stringify(hiddenFields));
    } catch (error) {
        debugError('storage', 'Не удалось сохранить список скрытых полей', error);
    }
}

// Позиция плавающих окон (расписание, настройки, Хакер) — общая и переживает сессии.
function loadFloatWindowPos() {
    try {
        const p = JSON.parse(localStorage.getItem(storageKey('floatWindowPos_v1')) || 'null');
        return (p && typeof p.left === 'number' && typeof p.top === 'number') ? p : null;
    } catch {
        return null;
    }
}

function saveFloatWindowPos(left, top) {
    try {
        localStorage.setItem(storageKey('floatWindowPos_v1'), JSON.stringify({
            left: parseInt(left, 10),
            top: parseInt(top, 10)
        }));
    } catch (error) {
        debugError('storage', 'Не удалось сохранить позицию окна', error);
    }
}

// Сброс позиции плавающих окон (если окно «уехало» за пределы экрана).
function resetFloatWindowPos() {
    try {
        localStorage.removeItem(storageKey('floatWindowPos_v1'));
    } catch (error) {
        debugError('storage', 'Не удалось сбросить позицию окна', error);
    }
}

// ─── Персист истории чата ─────────────────────────────────────────────────────
// Вкладку «Бонусы» (номера телефонов клиентов, ПДн) НЕ персистим.
const HISTORY_STORAGE_KEY = 'chatHistory_v1';
const HISTORY_MAX_PER_TAB = 100;

function saveChatHistory() {
    try {
        const safe = {};
        Object.entries(chatHistoryByAction).forEach(([action, entries]) => {
            if (action === 'checkHatikoBonuses') return;
            if (!Array.isArray(entries)) return;
            safe[action] = entries.slice(-HISTORY_MAX_PER_TAB);
        });
        localStorage.setItem(storageKey(HISTORY_STORAGE_KEY), JSON.stringify(safe));
    } catch (error) {
        debugError('storage', 'Не удалось сохранить историю', error);
    }
}

function loadChatHistory() {
    try {
        const raw = localStorage.getItem(storageKey(HISTORY_STORAGE_KEY));
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return;
        Object.entries(saved).forEach(([action, entries]) => {
            if (action === 'checkHatikoBonuses') return; // ПДн — не восстанавливаем
            if (!MODE_ACTIONS.includes(action)) return;  // только режимные вкладки
            if (!Array.isArray(entries)) return;
            chatHistoryByAction[action] = entries
                .filter(e => e && typeof e.message === 'string')
                .slice(-HISTORY_MAX_PER_TAB);
        });
    } catch (error) {
        debugError('storage', 'Не удалось загрузить историю', error);
    }
}

function panelCsrfStorageKey() {
    return storageKey('panelCsrf_v1');
}

const PANEL_CSRF_TTL_MS = 12 * 60 * 1000; // 12 мин: Laravel-токены живут недолго, рефрешим заранее
const PANEL_CSRF_REFRESH_INTERVAL_MS = 6 * 60 * 1000; // фоновый рефреш каждые 6 минут
let panelCsrfRefreshing = false;
let panelBridgeListening = false;

function panelBridgeOrigins() {
    return ['https://online.moysklad.ru', 'https://hatiko.ru', 'https://voronezh.hatiko.ru', 'https://lipetsk.hatiko.ru', 'https://balakovo.hatiko.ru'];
}

function startPanelBridgeListener() {
    if (panelBridgeListening || typeof window === 'undefined' || typeof addEventListener === 'undefined') return;
    panelBridgeListening = true;
    window.addEventListener('message', event => {
        const data = event.data;
        if (!data || data.source !== 'hatiko-panel-bridge' || data.type !== 'panelCsrfResponse') return;
        if (!panelBridgeOrigins().includes(event.origin) && event.origin !== 'https://panel.hatiko.ru') return;
        if (data.ok && data.token) savePanelCsrf(data.token);
        if (!data.authorized && data.ok === false) clearPanelCsrf();
    });
}

function requestPanelCsrfViaBridge(onSuccess, onError) {
    panelBridgeOrigins().forEach(origin => {
        try { window.postMessage({ source: 'memchat-main', type: 'panel-token-request' }, origin); } catch (e) { /* ignore */ }
    });
    let answered = false;
    const handler = event => {
        const d = event.data;
        if (!d || d.source !== 'hatiko-panel-bridge' || d.type !== 'panelCsrfResponse') return;
        if (answered) return;
        answered = true;
        window.removeEventListener('message', handler);
        if (d.ok && d.token) { savePanelCsrf(d.token); onSuccess?.(d.token); }
        else onError?.(new Error(d.authorized === false ? 'Panel: нет авторизации. Войдите в panel.hatiko.ru.' : 'Panel: bridge не вернул токен'));
    };
    window.addEventListener('message', handler);
    setTimeout(() => { if (!answered) { window.removeEventListener('message', handler); onError?.(new Error('Panel: bridge не ответил. Откройте panel.hatiko.ru.')); } }, 4000);
}

function openPanelInBackground() {
    try {
        const w = window.open('https://panel.hatiko.ru/', '_blank');
        if (w) w.blur();
    } catch (e) { debugError('panel-bridge', 'Не удалось открыть панель', e); }
}

function loadPanelCsrf() {
    try {
        const saved = JSON.parse(localStorage.getItem(panelCsrfStorageKey()) || 'null');
        if (!saved?.token || !saved?.savedAt || Date.now() - saved.savedAt > PANEL_CSRF_TTL_MS) return '';
        return saved.token;
    } catch { return ''; }
}

function savePanelCsrf(token) {
    if (!token) return;
    try { localStorage.setItem(panelCsrfStorageKey(), JSON.stringify({ token, savedAt: Date.now() })); }
    catch (error) { debugError('storage', 'Не удалось сохранить CSRF Panel', error); }
}

function clearPanelCsrf() {
    try { localStorage.removeItem(panelCsrfStorageKey()); } catch { /* storage unavailable */ }
}

function refreshPanelCsrf(onSuccess, onError, attempts = 2) {
    const attemptFetch = (left) => {
        panelRequest(`/search?_=${Date.now()}`, {}, response => {
            const token = parsePanelCsrf(response.responseText);
            if (!token) {
                if (left > 0) { setTimeout(() => attemptFetch(left - 1), 900); return; }
                clearPanelCsrf();
                onError?.(new Error('Panel: нет авторизации. Войдите в panel.hatiko.ru.'));
                return;
            }
            savePanelCsrf(token);
            debugLog('panel-csrf', 'обновлён');
            onSuccess?.(token);
        }, error => {
            if (left > 0) { setTimeout(() => attemptFetch(left - 1), 900); return; }
            onError?.(error);
        });
    };
    attemptFetch(Math.max(1, attempts));
}

function ensurePanelCsrf(onSuccess, onError, force = false, viaBridgeOnly = false) {
    if (force && viaBridgeOnly) { requestPanelCsrfViaBridge(onSuccess, onError); return; }
    if (force) { refreshPanelCsrf(onSuccess, onError); return; }
    const cached = loadPanelCsrf();
    if (cached) { onSuccess(cached); return; }
    // Сначала bridge (токен из живой вкладки Panel), затем прямой с retry
    requestPanelCsrfViaBridge(token => onSuccess(token), () => {
        refreshPanelCsrf(onSuccess, error => {
            openPanelInBackground();
            onError?.(error);
        });
    });
}

function schedulePanelCsrfRefresh() {
    if (panelCsrfRefreshing || typeof setInterval === 'undefined') return;
    panelCsrfRefreshing = true;
    setInterval(() => {
        if (loadPanelCsrf()) {
            refreshPanelCsrf(() => {}, () => { clearPanelCsrf(); });
        }
    }, PANEL_CSRF_REFRESH_INTERVAL_MS);
}

function panelRequest(path, options, onSuccess, onError) {
    GM_xmlhttpRequest({
        method: options?.method || 'GET',
        url: `https://panel.hatiko.ru${path}`,
        headers: {
            Accept: 'application/json, text/html;q=0.9',
            Referer: 'https://panel.hatiko.ru/search',
            Origin: 'https://panel.hatiko.ru',
            'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : 'Mozilla/5.0',
            'X-Requested-With': 'XMLHttpRequest',
            ...(options?.headers || {})
        },
        data: options?.data,
        timeout: 30000,
        anonymous: false,
        onload: response => {
            const contentType = response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '';
            const raw = response.responseText || '';
            const isHtml = /^\s*<html/i.test(raw) || /noindex, noarchive|ajaxload\.info|gorizontal-vertikal/i.test(raw);
            debugLog('panel-response', { path, status: response.status, contentType, isHtml });
            if (response.status >= 200 && response.status < 300 && !isHtml) {
                onSuccess(response);
            } else if (isHtml) {
                const login = /\/login|вход|авторизац/i.test(raw);
                onError(new Error(login
                    ? 'Panel: нет авторизации. Войдите в panel.hatiko.ru.'
                    : 'Panel: вернула HTML вместо JSON. Проверь авторизацию Panel.'), response);
            } else {
                onError(new Error(`Panel HTTP ${response.status}`), response);
            }
        },
        ontimeout: () => onError(new Error('Panel: таймаут запроса')),
        onerror: error => onError(new Error(`Panel: ошибка сети ${error}`))
    });
}

function parsePanelCsrf(html) {
    const meta = html.match(/<meta\b[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
    if (meta) return meta[1];
    const input = html.match(/<input\b[^>]*name=["']_token["'][^>]*value=["']([^"']+)["']/i);
    return input ? input[1] : '';
}

function parsePanelJson(response) {
    const raw = String(response.responseText || response.response || '')
        .replace(/^\uFEFF/, '')
        .trim();
    if (!raw) throw new Error('Panel: пустой ответ');
    try {
        return JSON.parse(raw);
    } catch (error) {
        debugError('panel-json', {
            status: response.status,
            contentType: response.responseHeaders?.match(/content-type:\s*([^\\r\\n]+)/i)?.[1] || '',
            preview: raw.slice(0, 160)
        });
        throw new Error('Panel: некорректный JSON-ответ');
    }
}

function panelSearch(query, onSuccess, onError) {
    const attempt = (csrf, retried) => panelRequest('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
        data: JSON.stringify({ search_type: 'article', query: String(query).trim(), cities_filter: [], stores_filter: [], show_external_code: true })
    }, response => {
        try { onSuccess(parsePanelJson(response)); }
        catch (error) { onError(error); }
    }, (error, response) => {
        if ((response?.status === 419 || response?.status === 401 || response?.status === 403) && !retried) {
            clearPanelCsrf();
            requestPanelCsrfViaBridge(newCsrf => attempt(newCsrf, true), () => refreshPanelCsrf(newCsrf => attempt(newCsrf, true), () => onError(new Error('Panel: авторизация истекла. Войдите в panel.hatiko.ru.'))));
            return;
        }
        onError(error);
    });
    ensurePanelCsrf(csrf => attempt(csrf, false), onError);
}

function panelCheckBonuses(phone, onSuccess, onError) {
    const normalized = String(phone || '').replace(/\D/g, '');
    if (!normalized) {
        onError(new Error('Panel: введите номер телефона'));
        return;
    }
    const attempt = (csrf, retried) => panelRequest(`/api/bonuses/check/${encodeURIComponent(Number(normalized))}`, {
        headers: { 'X-CSRF-TOKEN': csrf }
    }, response => {
        try { onSuccess(parsePanelJson(response)); }
        catch (error) { onError(error); }
    }, (error, response) => {
        if ((response?.status === 419 || response?.status === 401 || response?.status === 403) && !retried) {
            clearPanelCsrf();
            requestPanelCsrfViaBridge(newCsrf => attempt(newCsrf, true), () => refreshPanelCsrf(newCsrf => attempt(newCsrf, true), () => onError(new Error('Panel: авторизация истекла. Войдите в panel.hatiko.ru.'))));
            return;
        }
        onError(error);
    });
    ensurePanelCsrf(csrf => attempt(csrf, false), onError);
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────
function fetchServerData(url, onSuccess, onError) {
    debugLog('request', 'GET', url);
    GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload:  r => {
            debugLog('response', r.status, url);
            r.status === 200 ? onSuccess(r) : onError(`Ошибка: ${r.statusText}`);
        },
        onerror: e => {
            debugError('request', url, e);
            onError(`Ошибка запроса: ${e}`);
        }
    });
}

function applyRule(cash, rule) {
    if (rule.isCashback) return Math.round(cash * rule.percent / 100);
    const rounded = Math.round(cash * rule.percent / 100 / rule.round) * rule.round;
    return rounded + (rule.extra || 0);
}

/* ===== 03-chat.js ===== */

// ─── addToChatHistory ─────────────────────────────────────────────────────────
// sender: user | bot | system; query — текст запроса (для кнопки «повторить»).
function addToChatHistory(sender, message, emoji = '', query) {
    const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const entry = { sender, message, emoji, timestamp: ts, action: currentAction, query: query || '' };
    const history = historyFor(currentAction);
    history.push(entry);
    if (history.length > 100) history.splice(0, history.length - 100); // лимит на вкладку
    if (window.priceCheckContainer) renderChat();
    saveChatHistory(); // персист (кроме вкладки «Бонусы» — ПДн)
    if (sender === 'user' && document.getElementById('clearTextCheckbox')?.checked) {
        const ms = parseInt(document.getElementById('timeoutSlider')?.value || 500, 10);
        setTimeout(() => { const inp = document.getElementById('priceCheckInput'); if (inp) inp.value = ''; }, ms);
    }
}

// ─── Рендер ленты активной вкладки ────────────────────────────────────────────
function renderChat() {
    const log = document.getElementById('mcChatLog');
    if (!log) return;
    log.replaceChildren();
    const entries = chatHistoryByAction[currentAction] || [];
    entries.forEach(entry => log.appendChild(renderMessageBubble(entry)));
    log.scrollTop = log.scrollHeight;
}

function renderMessageBubble(entry) {
    const bubble = document.createElement('div');
    bubble.className = `mc-msg mc-msg-${entry.sender}`;

    if (entry.sender === 'system') {
        bubble.textContent = `${entry.emoji ? entry.emoji + ' ' : ''}${entry.message}`;
        return bubble;
    }

    const meta = document.createElement('div');
    meta.className = 'mc-msg-meta';
    meta.textContent = `${entry.emoji ? entry.emoji + ' ' : ''}${entry.timestamp}`;
    bubble.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'mc-msg-body';
    body.textContent = entry.message;      // textContent — защита от HTML
    bubble.appendChild(body);

    if (entry.sender === 'bot') {
        const actions = document.createElement('div');
        actions.className = 'mc-msg-actions';

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'mc-copy-btn';
        copy.dataset.copy = entry.message; // текст для копирования
        copy.dataset.tip = '📋 Копировать';
        copy.textContent = '📋';
        actions.appendChild(copy);

        // Повторить запрос (если известен исходный запрос и это режимная вкладка)
        if (entry.action && MODE_ACTIONS.includes(entry.action) && entry.query) {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'mc-retry-btn';
            retry.dataset.tip = '🔁 Повторить запрос';
            retry.textContent = '🔁';
            actions.appendChild(retry);
        }
        bubble.appendChild(actions);
    }
    return bubble;
}

// Делегированный клик по кнопкам «Копировать» / «Повторить» в ленте.
function handleChatLogClick(event) {
    const copyBtn = event.target.closest('.mc-copy-btn');
    if (copyBtn) {
        copyHatikoText(copyBtn.dataset.copy || '');
        copyBtn.textContent = '✅';
        copyBtn.classList.add('mc-copy-done');
        setTimeout(() => {
            copyBtn.textContent = '📋';
            copyBtn.classList.remove('mc-copy-done');
        }, 1200);
        return;
    }

    const retryBtn = event.target.closest('.mc-retry-btn');
    if (!retryBtn) return;
    const bubble = retryBtn.closest('.mc-msg');
    const index = Array.from(bubble.parentNode.children).indexOf(bubble);
    const entry = (chatHistoryByAction[currentAction] || [])[index];
    if (!entry) return;

    retryBtn.textContent = '✅';
    retryBtn.classList.add('mc-copy-done');
    setTimeout(() => {
        retryBtn.textContent = '🔁';
        retryBtn.classList.remove('mc-copy-done');
    }, 1200);

    // Повторяем тот же запрос в той же вкладке
    if (currentAction !== entry.action) selectTab(entry.action);
    const input = document.getElementById('priceCheckInput');
    if (input) input.value = entry.query;
    executeCurrentAction();
}

function clearChat() {
    // Очищает только историю активной вкладки
    if (currentAction) delete chatHistoryByAction[currentAction];
    renderChat();
    saveChatHistory();
}

function clearResultForNewRequest() {
    document.getElementById('hatikoLinksPanel')?.replaceChildren();
    document.getElementById('hatikoLinksPanel')?.style.setProperty('display', 'none');
    document.getElementById('hatikoReopenPickerButton')?.style.setProperty('display', 'none');
}

/* ===== 04-hatiko.js ===== */

// ─── HATIKO ───────────────────────────────────────────────────────────────────

/**
 * Парсит страницу поиска Hatiko.
 * Возвращает: { title, articleNo, price, productUrl }
 */
function parseSearchPage(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const product = doc.querySelector('a.s-product-header');
    if (!product) return null;

    const title        = (product.getAttribute('title') || product.textContent || '').trim();
    const relativeLink = product.getAttribute('href') || '';

    // Путь товара — один и тот же для всех городов, только домен меняется
    const pathname   = relativeLink ? new URL(relativeLink, baseUrl).pathname : '';
    const productUrl = pathname ? `${baseUrl}${pathname}` : baseUrl;

    // Цена: ищем span.price-wrapper span.price или просто span.price
    const priceEl = doc.querySelector('span.price-wrapper span.price')
                 || doc.querySelector('span.price');
    const price   = priceEl
        ? priceEl.textContent.replace(/\s+/g, ' ').trim() + ' ₽'
        : '—';

    return { title, price, productUrl, pathname };
}

function parseSearchResults(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const results = [];
    const seen = new Set();

    doc.querySelectorAll('a.s-product-header').forEach(product => {
        const relativeLink = product.getAttribute('href') || '';
        if (!relativeLink) return;

        const pathname = new URL(relativeLink, baseUrl).pathname;
        if (!pathname || seen.has(pathname)) return;
        seen.add(pathname);

        results.push({
            title: (product.getAttribute('title') || product.textContent || '').trim(),
            pathname
        });
    });

    return results;
}

function parseProductPrice(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const priceEl = doc.querySelector('span.s-price span.price-wrapper span.price')
                 || doc.querySelector('.s-price span.price')
                 || doc.querySelector('span.price-wrapper span.price');
    if (!priceEl) return '—';
    const value = priceEl.textContent.replace(/\s+/g, ' ').trim();
    return value ? `${value} ₽` : '—';
}

function formatHatikoResult(title, prices, pathname) {
    currentHatikoPathname = pathname;
    const lines = [`🧭 ${title}`, ''];
    BASE_URLS.forEach((baseUrl, i) => {
        lines.push(`🪙${CITY_ICONS[i]} ${prices[i] || '—'}`);
    });
    updateHatikoLinksPanel(pathname);
    lines.push('', 'Сможем? Актуальная цена?');
    return lines.join('\n');
}


/**
 * Парсит страницу КАРТОЧКИ товара для получения статуса наличия.
 * Возвращает строку статуса.
 */
function parseProductPage(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Статус: stock-high, stock-low, stock-none или аналоги
    const stockHigh = doc.querySelector('.stock-high');
    const stockLow  = doc.querySelector('.stock-low');
    const stockNone = doc.querySelector('.stock-none, .stock-out');

    if (stockHigh) return '🟢 ' + stockHigh.textContent.trim();
    if (stockLow)  return '🟡 ' + stockLow.textContent.trim();
    if (stockNone) return '🔴 ' + stockNone.textContent.trim();

    // Запасные варианты
    const stockEl = doc.querySelector('[class*="stock"], [class*="availability"], [class*="наличи"]');
    if (stockEl) return '📦 ' + stockEl.textContent.trim();

    return '❓ Статус неизвестен';
}

function checkHatiko() {
    const query = document.getElementById('priceCheckInput').value.trim();
    if (!query) return;
    const requestId = ++activeRequestId;
    clearResultForNewRequest();
    addToChatHistory('user', query, '🐶 Hatiko');
    if (hatikoSearchMode === 'panel' || (hatikoSearchMode === 'auto' && /^\d+$/.test(query))) {
        updateHatikoStatus('Проверяю Panel Hatiko…');
        panelSearch(query, data => {
            const message = formatPanelSearchResult(data);
            if (message) {
                updateHatikoStatus('Panel: готово');
                addToChatHistory('bot', message, '🏪 Panel', query);
            } else if (hatikoSearchMode === 'auto') {
                updateHatikoStatus('Panel не нашёл, переключаюсь на Hatiko…');
                checkHatikoWebsite(query, requestId);
            } else addToChatHistory('bot', 'Panel: товар не найден', '🏪 Panel', query);
        }, error => {
            if (hatikoSearchMode === 'auto') {
                updateHatikoStatus('Panel недоступна, переключаюсь на Hatiko…');
                checkHatikoWebsite(query, requestId);
            } else addToChatHistory('bot', error.message, '🏪 Panel', query);
        });
        return;
    }
    checkHatikoWebsite(query, requestId);
}

function checkHatikoWebsite(query, requestId) {
    updateHatikoStatus('Ищу товары…');

    // Шаг 1: ищем товар через поиск Саратова
    const searchUrl = `${BASE_URLS[0]}/search/?query=${encodeURIComponent(query)}`;

    fetchServerData(
        searchUrl,
        (searchResp) => {
            if (requestId !== activeRequestId) return;
            const products = parseSearchResults(searchResp.responseText, BASE_URLS[0]);

            if (!products.length) {
                updateHatikoStatus('Товары не найдены');
                addToChatHistory('bot', 'Товар не найден', '🐶 Hatiko', query);
                return;
            }

            updateHatikoStatus(`Найдено товаров: ${products.length}. Получаю цены…`);

            const results = new Array(products.length);
            let completed = 0;

            products.forEach((product, index) => {
                checkHatikoProduct(product, result => {
                    if (requestId !== activeRequestId) return;
                    results[index] = result;
                    completed++;
                    if (completed !== products.length) return;

                    if (results.length === 1) {
                        lastHatikoResults = results;
                        lastHatikoQuery = query;
                        updateHatikoStatus('Готово');
                        addToChatHistory('bot', results[0].message, '🐶 Hatiko', query);
                    } else {
                        lastHatikoResults = results;
                        lastHatikoQuery = query;
                        updateHatikoStatus(`Готово: ${results.length} товара. Можно выбрать другой.`);
                        openHatikoProductPicker(results, query);
                    }
                });
            });
        },
        (err) => {
            updateHatikoStatus('Ошибка поиска');
            addToChatHistory('bot', 'Ошибка поиска: ' + err, '🐶 Hatiko', query);
        }
    );
}

function formatPanelSearchResult(data) {
    const products = data?.results || [];
    if (!products.length) return '';
    return products.map(product => [
        `Артикул: ${product.article || '—'}`,
        product.external_code ? `ВК: ${product.external_code}` : null,
        product.name || '—',
        `Статус: ${product.status || '—'}`,
        `Наличие: ${product.total_stock > 0 ? `${product.total_stock} шт.` : 'Нет'}`,
        product.supplier_decision?.iz_nalichiya ? `Из наличия: ${product.supplier_decision.iz_nalichiya}` : null,
        Object.entries(product.prices || {}).map(([city, price]) => `${city}: ${price ? `${price} ₽` : '—'}`).join('  •  '),
        product.stock_formatted ? `\n${product.stock_formatted}` : null
    ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

function checkHatikoBonuses() {
    const phone = document.getElementById('priceCheckInput').value.trim();
    if (!phone) return;
    addToChatHistory('user', phone, '🎁 Бонусы');
    updateHatikoStatus('Проверяю бонусы в Panel…');
    panelCheckBonuses(phone, data => {
        updateHatikoStatus('Бонусы: готово');
        const bonus = data.bonus ?? data.bonuses ?? data.affiliate_bonus ?? 0;
        addToChatHistory('bot', [
            `Телефон: ${data.phone || phone}`,
            `Клиент: ${data.name || data.customer_name || '—'}`,
            `Бонусы: ${Math.round(Number(bonus))}`
        ].join('\n'), '🎁 Бонусы', phone);
    }, error => {
        updateHatikoStatus('Ошибка проверки бонусов');
        addToChatHistory('bot', error.message, '🎁 Бонусы', phone);
    });
}

function checkHatikoProduct(product, onComplete) {
    const { title, pathname } = product;
    currentHatikoPathname = pathname;
    const prices = new Array(BASE_URLS.length).fill('—');
    let requestsCompleted = 0;

    BASE_URLS.forEach((baseUrl, idx) => {
        fetchServerData(
            `${baseUrl}${pathname}`,
            productResp => {
                prices[idx] = parseProductPrice(productResp.responseText);
                requestsCompleted++;
                updateHatikoStatus(`Получаю цены: ${requestsCompleted}/${BASE_URLS.length} для «${title}»`);
                if (requestsCompleted === BASE_URLS.length) finish();
            },
            () => {
                requestsCompleted++;
                updateHatikoStatus(`Получаю цены: ${requestsCompleted}/${BASE_URLS.length} для «${title}»`);
                if (requestsCompleted === BASE_URLS.length) finish();
            }
        );
    });

    function finish() {
        // Если городской сайт не отдал отдельную цену, используем цену
        // Саратова: у городов часто общий каталог и прайс.
        const saratovPrice = prices[0];
        const normalizedPrices = saratovPrice !== '—'
            ? prices.map(price => price === '—' ? saratovPrice : price)
            : prices;
        onComplete({
            title,
            pathname,
            prices: normalizedPrices,
            message: formatHatikoResult(title, normalizedPrices, pathname)
        });
    }
}

/* ===== 05-calculator.js ===== */

// ─── Калькулятор ──────────────────────────────────────────────────────────────
function calculateCredit() {
    const input = document.getElementById('priceCheckInput').value.trim();
    if (!input) return;
    addToChatHistory('user', input, '🧮 Калькулятор');
    const cash = parseFloat(input);
    if (isNaN(cash) || cash <= 0) {
        addToChatHistory('bot', 'Ошибка: введите корректную сумму.', '🧮 Калькулятор', input);
        return;
    }
    const lines = calcRules.map(rule => {
            const result = applyRule(cash, rule);
            return rule.isCashback
                ? `💸 ${rule.name}: ${result} баллами`
                : `🔹 ${rule.name}: ${result} руб.`;
        });
        addToChatHistory('bot', lines.join('\n'), '🧮 Калькулятор', input);
    }

function calculateReverse() {
    const input = document.getElementById('priceCheckInput').value.trim();
    if (!input) return;
    addToChatHistory('user', input, '🔄 Реверс');
    const amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0) {
        addToChatHistory('bot', 'Ошибка: введите корректную сумму.', '🔄 Реверс', input);
        return;
    }
    const lines = calcRules
        .filter(r => !r.isCashback && r.percent > 0)
        .map(r => {
            const original = Math.round((amount - (r.extra || 0)) / r.percent * 100);
            return `🔹 ${r.name}: ${original} руб.`;
        });
    addToChatHistory('bot', '🔄 РЕВЕРС расчёта:\n' + lines.join('\n'), '🔄 Реверс', input);
}

/**
 * Скидка / Наценка
 * Форматы:
 *   цена - скидка   → вычесть
 *   цена + наценка  → прибавить
 */
function applyDiscountOrMarkup() {
    const input = document.getElementById('priceCheckInput').value.trim();
    if (!input) return;
    addToChatHistory('user', input, '🎉 Скидка/Наценка');

    // Определяем операцию: + или -
    const minusIdx = input.lastIndexOf('-');
    const plusIdx  = input.lastIndexOf('+');

    let op = null, splitIdx = -1;
    if (minusIdx > 0 && minusIdx > plusIdx) { op = '-'; splitIdx = minusIdx; }
    else if (plusIdx > 0)                   { op = '+'; splitIdx = plusIdx;  }

    if (!op) {
        addToChatHistory('bot', 'Ошибка: формат — "сумма - скидка" или "сумма + наценка"', '🎉');
        return;
    }

    const orig = parseFloat(input.substring(0, splitIdx).trim());
    const diff = parseFloat(input.substring(splitIdx + 1).trim());

    if (isNaN(orig) || isNaN(diff)) {
        addToChatHistory('bot', 'Ошибка: некорректные числа', '🎉');
        return;
    }

    const result = op === '-' ? orig - diff : orig + diff;
    const pct    = Math.abs(diff / orig * 100).toFixed(10);
    const label  = op === '-' ? '🎉 Скидка' : '📈 Наценка';
    const verb   = op === '-' ? 'Скидка'    : 'Наценка';

    addToChatHistory('bot',
            `${label}:\n` +
            `🔹 Было: ${orig} руб.\n` +
            `🔹 ${verb}: ${diff} руб. (${pct}%)\n` +
            `🔹 Итого: ${result} руб.`,
            '🎉', input);
}

function calculateSimple() {
    const input = document.getElementById('priceCheckInput').value.trim();
    if (!input) return;
    addToChatHistory('user', input, '∑ Простой');
    try {
        const result = Function('"use strict"; return (' + input + ')')();
        addToChatHistory('bot', `Результат: ${result}`, '∑ Простой', input);
    } catch {
        addToChatHistory('bot', 'Ошибка: некорректное выражение', '∑ Простой');
    }
}

/* ===== 06-schedule.js ===== */

// ─── Расписание ───────────────────────────────────────────────────────────────
// Вкладки «Сегодня»/«Завтра» открывают модальное окно с таблицей «Кто/Где».
function fetchWhoWorksToday()    { fetchWhoWorks('today'); }
function fetchWhoWorksTomorrow() { fetchWhoWorks('tomorrow'); }

function fetchWhoWorks(day) {
    const url     = `https://docs.google.com/spreadsheets/d/13KUmHtRXYbXjBE7KQ_4MFQ5VsgUYqu2heURY1y2NwiE/edit`;
    const jsonUrl = 'https://github.com/xtalia/hatiko/raw/refs/heads/main/js/wwPeoples.json';

    fetch(jsonUrl)
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(loaded => loadTableWithReplacements(day, url, { ...scheduleReplacements, ...loaded }))
        .catch(()    => loadTableWithReplacements(day, url, scheduleReplacements));
}

function loadTableWithReplacements(day, url, replacements) {
    GM_xmlhttpRequest({
        method: 'GET', url,
        onload(response) {
            const regex = /🎯РАБОЧИЙ_ГРАФИК_ДАННЫЕ🎯([\s\S]*?)🎯/i;
            const match = response.responseText.match(regex);
            if (!match?.[1]) { openScheduleTableWindow(day, null, 'Не удалось найти данные в таблице'); return; }

            const tmp = document.createElement('div');
            tmp.innerHTML = match[1];
            let full = (tmp.textContent || '').trim().replace(/\s+/g, ' ');

            const markers = {
                today:    ['📅СЕГОДНЯ_НАЧАЛО📅', '📅СЕГОДНЯ_КОНЕЦ📅'],
                tomorrow: ['📅ЗАВТРА_НАЧАЛО📅',   '📅ЗАВТРА_КОНЕЦ📅']
            };
            const [sm, em] = markers[day];
            const si = full.indexOf(sm), ei = full.indexOf(em);
            if (si === -1 || ei === -1) { openScheduleTableWindow(day, null, 'Данные не найдены'); return; }

            let text = full.substring(si, ei).replace(sm, '').replace(em, '').trim();
            const parsed = parseScheduleLines(text, replacements, day);
            const textCopy = formatOutputWithReplacements(text, replacements, day);
            openScheduleTableWindow(day, parsed, textCopy);
        },
        onerror() { openScheduleTableWindow(day, null, 'Ошибка сети при загрузке расписания'); }
    });
}

// Разбирает расписание на группы по городам. Вход — «почти одна строка» с
// маркерами: 🏢/🏙 начинают город, 👤 — человека. Разделители строк не нужны.
//   [{ city, rows: [{ person, store }] }]
function parseScheduleLines(text, replacements, day) {
    const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
    const dateStr = dateMatch ? dateMatch[1] : '';
    let cleaned = text.replace(dateStr, '').replace(/📅/g, '').replace(/\|/g, ' - ').trim();

    const groups = [];
    let current = null;

    // Режем по маркерам, сохраняя их в начале токена
    const tokens = cleaned.split(/(?=🏢|🏙|👤)/).map(t => t.trim()).filter(Boolean);

    tokens.forEach(token => {
        if (/^🏢|^🏙/.test(token)) {
            const city = token.replace(/^🏢|^🏙/, '')
                .replace(/^В городе\s*/i, '')
                .trim() || '—';
            current = { city, rows: [] };
            groups.push(current);
            return;
        }
        if (/^👤/.test(token)) {
            const body = token.replace(/^👤\s*/, '');
            const [info, value] = body.includes(' - ') ? body.split(' - ') : [body, ''];
            // Имя и email часто склеены без пробела: «Русланmilibaev@skl4dm»
            const person = info
                .replace(/([а-яА-ЯЁё])([a-zA-Z@])/g, '$1 $2')
                .replace(/\s+/g, ' ')
                .trim();
            let store = (value || '').trim();
            if (store && replacements[store]) store = replacements[store];
            if (!current) { current = { city: '—', rows: [] }; groups.push(current); }
            current.rows.push({ person: person || '—', store: store || '—' });
        }
    });

    return { dateStr, groups };
}

// Плавающее перетаскиваемое окно со списком «Кто/Где» (без затемнения).
function openScheduleTableWindow(day, parsed, textCopy) {
    closeMemchatOverlay();

    const dayName = day === 'today' ? 'Сегодня' : 'Завтра';
    const win = document.createElement('div');
        win.className = 'mc-float-window';
        applyFloatWindowPos(win);

    // ── Заголовок (за него можно таскать) ──
    const header = document.createElement('div');
    header.className = 'mc-float-header';
    const title = document.createElement('div');
    title.className = 'mc-float-title';
    title.textContent = `📅 ${dayName}${parsed?.dateStr ? ' — ' + parsed.dateStr : ''}`;
    header.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mc-float-close';
    close.textContent = '✕';
    close.addEventListener('click', closeMemchatOverlay);
    header.appendChild(close);
    win.appendChild(header);

    // ── Тело: список по городам или ошибка ──
    const body = document.createElement('div');
    body.className = 'mc-float-body';
    if (!parsed || !parsed.groups.length) {
        const err = document.createElement('div');
        err.style.cssText = 'color:#991b1b;background:#fee2e2;border:1px solid #fecaca;border-radius:10px;padding:10px;font-size:12px;';
        err.textContent = textCopy || 'Нет данных';
        body.appendChild(err);
    } else {
        parsed.groups.forEach(group => {
            const cityHeader = document.createElement('div');
            cityHeader.className = 'mc-sched-city';
            cityHeader.textContent = `🏙 ${group.city}`;
            body.appendChild(cityHeader);
            group.rows.forEach(row => {
                const line = document.createElement('div');
                line.className = 'mc-sched-row';
                line.textContent = `👤 ${row.person} — ${row.store}`;
                body.appendChild(line);
            });
        });
    }
    win.appendChild(body);

    // ── Подвал: копировать текст ──
    const footer = document.createElement('div');
    footer.className = 'mc-float-footer';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mc-btn mc-btn-blue';
    copyBtn.textContent = '📋 Копировать текст';
    copyBtn.addEventListener('click', () => {
        copyHatikoText(textCopy || '');
        copyBtn.textContent = '✅ Скопировано';
        setTimeout(() => { copyBtn.textContent = '📋 Копировать текст'; }, 1200);
    });
    footer.appendChild(copyBtn);
    win.appendChild(footer);

    document.body.appendChild(win);
    makeMovable(win, header);
}

function closeMemchatOverlay() {
    document.querySelectorAll('.mc-overlay, .mc-float-window').forEach(el => el.remove());
}

// Применяет сохранённую позицию к плавающему окну (если есть).
function applyFloatWindowPos(el) {
    const pos = loadFloatWindowPos();
    if (!pos) return;
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
    el.style.right = 'auto';
}

// Делает окно перетаскиваемым за переданный элемент-заголовок.
// Позиция плавающих окон сохраняется в localStorage.
function makeMovable(el, handle) {
    handle.addEventListener('mousedown', e => {
        if (e.target.closest('button, input, select, a')) return;
        const rect = el.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const onMove = ev => {
            el.style.left = `${Math.max(0, ev.clientX - offsetX)}px`;
            el.style.top = `${Math.max(0, ev.clientY - offsetY)}px`;
            el.style.right = 'auto';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (el.classList.contains('mc-float-window')) {
                saveFloatWindowPos(el.style.left, el.style.top);
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// Текстовый формат (для «Копировать текст» и совместимости со старым выводом).
function formatOutputWithReplacements(text, replacements, day) {
    const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
    const dateStr = dateMatch ? dateMatch[1] : '';
    if (dateStr) text = text.replace(dateStr, '').trim();

    let formatted = text
        .replace(/🏢 /g, '\n\n🏢 В городе ')
        .replace(/👤 /g, '\n👤 ')
        .replace(/\|/g, ' - ')
        .trim();

    const lines = formatted.split('\n').filter(l => l.trim());
    const processed = lines.map(line => {
        if (!line.startsWith('👤')) return line;
        let [info, value] = line.includes(' - ') ? line.split(' - ') : [line, ''];
        info = info.replace(/👤\s*/, '👤 ')
                   .replace(/([а-яА-Я])([a-zA-Z@])/g, '$1 $2')
                   .replace(/\s+/g, ' ')
                   .replace(/\.([a-zA-Z])/g, '. $1').trim();
        value = (value || '').trim();
        if (value && replacements[value]) value = replacements[value];
        return value ? `${info} - ${value}` : info;
    });

    const dayName = day === 'today' ? 'Сегодня' : 'Завтра';
    return `📅 ${dayName} (${dateStr})\n\n${processed.join('\n')}`;
}

/* ===== 07-settings-panels.js ===== */

// ─── Перетаскивание ───────────────────────────────────────────────────────────
function startDrag(e) {
    if (e.target.closest('button, input, textarea, select')) return;
    isDragging = true;
    const rect = window.priceCheckContainer.getBoundingClientRect();
    offset.x = e.clientX - rect.left;
    offset.y = e.clientY - rect.top;
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
}
function drag(e) {
    if (!isDragging) return;
    window.priceCheckContainer.style.right = 'auto';
    window.priceCheckContainer.style.left  = `${e.clientX - offset.x}px`;
    window.priceCheckContainer.style.top   = `${e.clientY - offset.y}px`;
}
function stopDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('mouseup', stopDrag);
}

// ─── Панель правил калькулятора ───────────────────────────────────────────────
function buildCalcRulesPanel() {
    const panel = document.getElementById('calcRulesPanel');
    if (!panel) return;
    panel.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:grid;grid-template-columns:1fr 72px 72px 88px 30px;gap:4px;margin-bottom:6px;font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.4px;';
    hdr.innerHTML = '<span>Название</span><span>%</span><span>Округл.</span><span>Доп.</span><span></span>';
    panel.appendChild(hdr);

    calcRules.forEach((rule, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 72px 72px 88px 30px;gap:4px;margin-bottom:4px;align-items:center;';

        const mkInp = (val, placeholder, field) => {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = val; inp.placeholder = placeholder;
            inp.style.cssText = 'width:100%;padding:3px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:11px;box-sizing:border-box;outline:none;transition:border .15s;';
            inp.addEventListener('focus', () => inp.style.borderColor = '#6366f1');
            inp.addEventListener('blur',  () => inp.style.borderColor = '#334155');
            inp.addEventListener('input', () => {
                calcRules[i][field] = field === 'name' ? inp.value : (parseFloat(inp.value) || 0);
                saveCalcRules();
            });
            return inp;
        };

        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'width:26px;height:24px;background:transparent;border:1px solid #ef4444;border-radius:5px;color:#ef4444;font-size:10px;cursor:pointer;transition:all .15s;';
        del.addEventListener('mouseenter', () => { del.style.background='#ef4444'; del.style.color='#fff'; });
        del.addEventListener('mouseleave', () => { del.style.background='transparent'; del.style.color='#ef4444'; });
        del.addEventListener('click', () => { calcRules.splice(i,1); saveCalcRules(); buildCalcRulesPanel(); });

        const extraVal = rule.extra !== undefined ? (rule.extra >= 0 ? '+' + rule.extra : String(rule.extra)) : '0';
        row.appendChild(mkInp(rule.name, 'Название', 'name'));
        row.appendChild(mkInp(rule.percent, '%', 'percent'));
        row.appendChild(mkInp(rule.round, 'Округл.', 'round'));
        row.appendChild(mkInp(extraVal, '+/-0', 'extra'));
        row.appendChild(del);
        panel.appendChild(row);
    });

    _appendRulesPanelFooter(panel, 'calc');
}

// ─── Панель замен расписания ──────────────────────────────────────────────────
function buildSchedulePanel() {
    const panel = document.getElementById('scheduleRulesPanel');
    if (!panel) return;
    panel.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:grid;grid-template-columns:100px 1fr 28px;gap:4px;margin-bottom:6px;font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.4px;';
    hdr.innerHTML = '<span>Ключ</span><span>Значение (замена)</span><span></span>';
    panel.appendChild(hdr);

    Object.entries(scheduleReplacements).forEach(([key, val]) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:100px 1fr 28px;gap:4px;margin-bottom:4px;align-items:center;';

        const mkInp = (v, ph, onChange) => {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = v; inp.placeholder = ph;
            inp.style.cssText = 'width:100%;padding:3px 6px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:11px;box-sizing:border-box;outline:none;transition:border .15s;';
            inp.addEventListener('focus', () => inp.style.borderColor = '#6366f1');
            inp.addEventListener('blur',  () => inp.style.borderColor = '#334155');
            inp.addEventListener('input', () => onChange(inp.value));
            return inp;
        };

        const oldKey = key;
        const keyInp = mkInp(key, 'ключ', newKey => {
            if (newKey !== oldKey) {
                const tmp = { ...scheduleReplacements };
                delete tmp[oldKey];
                tmp[newKey] = scheduleReplacements[oldKey];
                scheduleReplacements = tmp;
                saveScheduleReplacements();
            }
        });
        const valInp = mkInp(val, 'замена', newVal => {
            scheduleReplacements[key] = newVal;
            saveScheduleReplacements();
        });

        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'width:24px;height:24px;background:transparent;border:1px solid #ef4444;border-radius:5px;color:#ef4444;font-size:10px;cursor:pointer;transition:all .15s;flex-shrink:0;';
        del.addEventListener('mouseenter', () => { del.style.background='#ef4444'; del.style.color='#fff'; });
        del.addEventListener('mouseleave', () => { del.style.background='transparent'; del.style.color='#ef4444'; });
        del.addEventListener('click', () => {
            delete scheduleReplacements[key];
            saveScheduleReplacements();
            buildSchedulePanel();
        });

        row.appendChild(keyInp);
        row.appendChild(valInp);
        row.appendChild(del);
        panel.appendChild(row);
    });

    _appendRulesPanelFooter(panel, 'schedule');
}

// Общий "подвал" панелей с кнопками + JSON-редактором
function _appendRulesPanelFooter(panel, type) {
    const isCalc = type === 'calc';
    const jsonAreaId = isCalc ? 'calcRulesJsonArea' : 'scheduleJsonArea';

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;';

    const mkBtn = (label, css, onClick) => {
        const b = document.createElement('button');
        b.innerHTML = label; b.style.cssText = css;
        b.addEventListener('mouseenter', () => b.style.opacity = '.8');
        b.addEventListener('mouseleave', () => b.style.opacity = '1');
        b.addEventListener('click', onClick);
        return b;
    };

    addRow.appendChild(mkBtn('＋ Добавить',
        'flex:1;padding:4px 8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:7px;color:#fff;font-size:11px;cursor:pointer;font-weight:600;',
        () => {
            if (isCalc) {
                calcRules.push({ name: 'Новое', percent: 100, round: 1, extra: 0 });
                saveCalcRules(); buildCalcRulesPanel();
            } else {
                scheduleReplacements['новый_ключ'] = 'Замена';
                saveScheduleReplacements(); buildSchedulePanel();
            }
        }
    ));

    addRow.appendChild(mkBtn('↺ Сброс',
        'padding:4px 8px;background:#ffffff;border:1px solid #cbd5e1;border-radius:7px;color:#475569;font-size:11px;cursor:pointer;',
        () => {
            if (!confirm('Сбросить к значениям по умолчанию?')) return;
            if (isCalc) { calcRules = JSON.parse(JSON.stringify(DEFAULT_CALC_RULES)); saveCalcRules(); buildCalcRulesPanel(); }
            else { scheduleReplacements = JSON.parse(JSON.stringify(DEFAULT_REPLACEMENTS)); saveScheduleReplacements(); buildSchedulePanel(); }
        }
    ));

    addRow.appendChild(mkBtn('{ } JSON',
        'padding:4px 8px;background:#ffffff;border:1px solid #cbd5e1;border-radius:7px;color:#475569;font-size:11px;cursor:pointer;',
        () => {
            const ja = document.getElementById(jsonAreaId);
            if (ja.style.display === 'none') {
                ja.value = JSON.stringify(isCalc ? calcRules : scheduleReplacements, null, 2);
                ja.style.display = 'block';
            } else {
                ja.style.display = 'none';
            }
        }
    ));

    panel.appendChild(addRow);

    // JSON textarea
    const ja = document.createElement('textarea');
    ja.id = jsonAreaId;
    ja.style.cssText = 'display:none;width:100%;height:110px;margin-top:7px;padding:7px;background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;color:#334155;font-size:11px;font-family:monospace;box-sizing:border-box;resize:vertical;outline:none;';
    ja.spellcheck = false;
    ja.addEventListener('blur', () => {
        try {
            const parsed = JSON.parse(ja.value);
            if (isCalc) { calcRules = parsed; saveCalcRules(); buildCalcRulesPanel(); }
            else { scheduleReplacements = parsed; saveScheduleReplacements(); buildSchedulePanel(); }
            ja.style.borderColor = '#22c55e';
        } catch { ja.style.borderColor = '#ef4444'; }
    });
    panel.appendChild(ja);
}

// ─── Скрытие полей МойСклад ──────────────────────────────────────────────────
// Поле прячется по точному тексту лейбла. Поддерживаются три формы МойСклад:
//  a) React-поле формы: .formItemTitle (лейбл) + следующий пустой DIV (значение)
//  b) React-блок итогов: лейбл + значение — соседние DIV внутри [class*="totalsWrapper"]
//  c) GWT-таблица: строка tr с ячейкой TD.legend
// Скрытые цели запоминаются в msHiddenTargets, чтобы можно было вернуть отображение.

function msFindLabelElement(name) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
        if ((node.textContent || '').trim() !== name) continue;
        const el = node.parentElement;
        if (!el || el.offsetHeight <= 0) continue;
        // a) React-поле формы
        if (el.closest('[class*="formItemTitle"]')) return el.closest('[class*="formItemTitle"]');
        // b) React-блок итогов: лейбл — прямой ребёнок totalsWrapper
        const wrap = el.closest('[class*="totalsWrapper"]');
        if (wrap) {
            let cur = el;
            while (cur.parentElement && cur.parentElement !== wrap) cur = cur.parentElement;
            return cur;
        }
        // c) GWT-таблица (ячейка-легенда)
        const legend = el.closest('td.legend');
        if (legend) return legend;
        // fallback: лейбл в неизвестной структуре — берём сам элемент
        return el;
    }
    return null;
}

function msCollectTargets(name) {
    const targets = [];
    const title = msFindLabelElement(name);
    if (!title) return targets;

    const cls = String(title.className || '');
    if (cls.includes('formItemTitle')) {
        // a) лейбл + соседняя ячейка значения
        const parent = title.parentElement;
        const idx = Array.prototype.indexOf.call(parent.children, title);
        const value = parent.children[idx + 1];
        if (value && !String(value.className || '').includes('formItemTitle')) {
            targets.push(title, value);
        } else {
            targets.push(title);
        }
    } else if (title.tagName === 'TD') {
        // c) GWT: прячем всю строку таблицы
        const row = title.closest('tr');
        targets.push(row || title);
    } else if (title.parentElement && String(title.parentElement.className || '').includes('totalsWrapper')) {
        // b) итоги: лейбл + значение-сосед
        targets.push(title);
        if (title.nextElementSibling) targets.push(title.nextElementSibling);
    } else {
        // fallback: прячем сам элемент лейбла + соседа-значение
        targets.push(title);
        if (title.nextElementSibling) targets.push(title.nextElementSibling);
    }
    return targets.filter(Boolean);
}

function applyMsHiddenFields() {
    if (!/online\.moysklad\.ru$/.test(location.hostname)) return;
    if (msFieldsRevealed || !hiddenFields.length) return;

    msHiddenTargets.forEach(t => { t.el.style.display = ''; });
    msHiddenTargets = [];

    hiddenFields.forEach(name => {
        msCollectTargets(name).forEach(el => {
            el.style.display = 'none';
            msHiddenTargets.push({ el, name });
        });
    });
}

function restoreMsFields() {
    msHiddenTargets.forEach(t => { t.el.style.display = ''; });
    msHiddenTargets = [];
}

function toggleMsFieldsRevealed() {
    msFieldsRevealed = !msFieldsRevealed;
    if (msFieldsRevealed) {
        restoreMsFields();
        setStatusText('👁 Скрытые поля показаны (нажмите ещё раз, чтобы спрятать)');
    } else {
        applyMsHiddenFields();
        setStatusText('🙈 Скрытые поля спрятаны');
    }
    updateMsRevealButton();
}

// Панель настройки скрытых полей (в окне настроек)
function buildMsFieldsPanel() {
    const panel = document.getElementById('msFieldsPanel');
    if (!panel) return;
    panel.innerHTML = '';
    if (!/online\.moysklad\.ru$/.test(location.hostname)) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px;color:#64748b;padding:4px 0;';
        note.textContent = 'Доступно только на online.moysklad.ru';
        panel.appendChild(note);
        return;
    }

    const fields = [...KNOWN_MS_FIELDS];
    hiddenFields.forEach(n => { if (!fields.includes(n)) fields.push(n); });

    fields.forEach(name => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;color:#475569;font-size:11.5px;margin-bottom:5px;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = hiddenFields.includes(name);
        cb.style.cssText = 'accent-color:#6366f1;width:13px;height:13px;';
        cb.addEventListener('change', () => {
            if (cb.checked) {
                if (!hiddenFields.includes(name)) hiddenFields.push(name);
            } else {
                hiddenFields = hiddenFields.filter(n => n !== name);
            }
            saveHiddenFields();
            if (!msFieldsRevealed) applyMsHiddenFields(); else restoreMsFields();
        });
        const span = document.createElement('span');
        span.textContent = name;
        label.appendChild(cb);
        label.appendChild(span);
        panel.appendChild(label);
    });

    // Кастомное поле: свой текст лейбла
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:5px;margin-top:6px;';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Своё поле: точный текст лейбла…';
    inp.style.cssText = 'flex:1;padding:4px 7px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;outline:none;box-sizing:border-box;';
    const add = document.createElement('button');
    add.textContent = '＋';
    add.style.cssText = 'width:28px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:7px;color:#fff;font-size:13px;cursor:pointer;font-weight:700;';
    add.addEventListener('click', () => {
        const v = (inp.value || '').trim();
        if (!v) return;
        if (!hiddenFields.includes(v)) hiddenFields.push(v);
        saveHiddenFields();
        if (!msFieldsRevealed) applyMsHiddenFields(); else restoreMsFields();
        buildMsFieldsPanel();
        setStatusText(`👁 Поле «${v}» добавлено в скрытые`);
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') add.click(); });
    row.appendChild(inp);
    row.appendChild(add);
    panel.appendChild(row);
}

// Плавающая кнопка 👁 «показать скрытые» — появляется на МойСклад, когда есть что прятать
function updateMsRevealButton() {
    if (!/online\.moysklad\.ru$/.test(location.hostname)) return;
    let btn = document.getElementById('mcMsRevealBtn');
    if (!hiddenFields.length) {
        if (btn) btn.remove();
        return;
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'mcMsRevealBtn';
        btn.type = 'button';
        btn.textContent = '👁';
        btn.title = 'Показать/скрыть спрятанные поля';
        btn.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;width:30px;height:30px;'
            + 'background:rgba(15,23,42,.82);border:1px solid rgba(148,163,184,.5);border-radius:50%;'
            + 'color:#e2e8f0;font-size:14px;cursor:pointer;opacity:.55;transition:opacity .15s;'
            + 'box-shadow:0 2px 8px rgba(0,0,0,.35);padding:0;line-height:1;';
        btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
        btn.addEventListener('mouseleave', () => btn.style.opacity = '0.55');
        btn.addEventListener('click', toggleMsFieldsRevealed);
        document.body.appendChild(btn);
    }
    btn.textContent = msFieldsRevealed ? '🙈' : '👁';
    btn.style.display = 'block';
}

/* ===== 08-clear-and-actions.js ===== */

// ─── Очистка текста ───────────────────────────────────────────────────────────
// Вызывается при каждом открытии окна настроек (элементы создаются заново),
// поэтому document-слушатель вешается один раз через флаг.
function setupGlobalClearTextFunctionality() {
    const saved = localStorage.getItem('clearTextEnabled');
    if (saved !== null) clearTextEnabled = saved === 'true';
    const cb = document.getElementById('clearTextCheckbox');
    if (cb) {
        cb.checked = clearTextEnabled;
        cb.addEventListener('change', function () {
            clearTextEnabled = this.checked;
            localStorage.setItem('clearTextEnabled', clearTextEnabled);
            updateClearTextButton();
        });
    }
    if (!globalClearKeypressBound) {
        globalClearKeypressBound = true;
        document.addEventListener('keypress', e => {
            if (e.key === 'Enter' && clearTextEnabled && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
                const ms = parseInt(document.getElementById('timeoutSlider')?.value || 500, 10);
                setTimeout(() => { e.target.value = ''; }, ms);
            }
        });
    }
    updateClearTextButton();
}

function updateClearTextButton() {
    // Кнопка-индикатор убрана в 6.0.0 (очистка текста — чекбокс во вкладке «Настройки»).
    const btn = document.getElementById('clearTextButton');
    if (!btn) return;
    if (clearTextEnabled) {
        btn.style.background = 'linear-gradient(135deg,#22c55e,#16a34a)';
        btn.style.boxShadow  = '0 2px 8px #22c55e30';
        btn.textContent = '🧹 Вкл';
    } else {
        btn.style.background = 'linear-gradient(135deg,#ef4444,#dc2626)';
        btn.style.boxShadow  = '0 2px 8px #ef444430';
        btn.textContent = '🧹 Выкл';
    }
}

// ─── Диспетчер действий ───────────────────────────────────────────────────────
function executeCurrentAction() {
    // Enter работает только на режимных вкладках; для действий и «Настроек» — no-op.
    debugLog('action', currentAction);
    switch (currentAction) {
        case 'checkHatiko':          checkHatiko();              break;
        case 'checkHatikoBonuses':   checkHatikoBonuses();       break;
        case 'calculator':           calculateCredit();          break;
        case 'calculator_reverse':   calculateReverse();         break;
        case 'calculator_discount':  applyDiscountOrMarkup();    break;
        case 'calculator_simple':    calculateSimple();          break;
        default: /* no-op */;
    }
}

/* ===== 09-ui.js ===== */

// ─── Создание интерфейса ──────────────────────────────────────────────────────
function createPriceCheckWindow() {
    if (!window.priceCheckContainer) {

        const style = document.createElement('style');
        style.textContent = `
            #priceCheckContainer {
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                font-size: 13px;
                color: #1f2937;
            }
            #priceCheckContainer *::-webkit-scrollbar { width: 4px; height: 4px; }
            #priceCheckContainer *::-webkit-scrollbar-track { background: #f1f5f9; }
            #priceCheckContainer *::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
            #priceCheckContainer *::-webkit-scrollbar-thumb:hover { background: #6366f1; }

            .mc-btn {
                padding: 6px 10px; border: none; border-radius: 8px;
                color: #fff; cursor: pointer; font-size: 12px; font-weight: 600;
                transition: all .18s ease; white-space: nowrap; letter-spacing: .2px;
                line-height: 1.3;
            }
            .mc-btn:hover  { transform: translateY(-1px); filter: brightness(1.15); }
            .mc-btn:active { transform: translateY(0);    filter: brightness(.95);  }
            .mc-btn-green  { background:linear-gradient(135deg,#22c55e,#16a34a); box-shadow:0 2px 8px #22c55e28; }
            .mc-btn-blue   { background:linear-gradient(135deg,#3b82f6,#2563eb); box-shadow:0 2px 8px #3b82f628; }
            .mc-btn-purple { background:linear-gradient(135deg,#a855f7,#7c3aed); box-shadow:0 2px 8px #a855f728; }
            .mc-btn-orange { background:linear-gradient(135deg,#f97316,#ea580c); box-shadow:0 2px 8px #f9731628; }
            .mc-btn-teal   { background:linear-gradient(135deg,#14b8a6,#0d9488); box-shadow:0 2px 8px #14b8a628; }
            .mc-btn-indigo { background:linear-gradient(135deg,#6366f1,#4f46e5); box-shadow:0 2px 8px #6366f128; }
            .mc-btn-slate  { background:linear-gradient(135deg,#475569,#334155); border:1px solid #475569; box-shadow:none; }
            .mc-btn-active {
                outline: 2px solid #fff !important;
                outline-offset: 2px !important;
                filter: brightness(1.15) !important;
                transform: translateY(-1px) !important;
            }
            .mc-section-label {
                font-size: 10px; font-weight: 800; color: #64748b;
                text-transform: uppercase; letter-spacing: .8px;
                margin-bottom: 6px; padding-left: 2px;
            }
            .mc-panel {
                background: #f8fafc; border: 1px solid #e5e7eb;
                border-radius: 12px; padding: 11px;
                max-height: 320px; overflow-y: auto;
            }
            .mc-panel-title {
                font-size: 10px; font-weight: 700; color: #4f46e5;
                text-transform: uppercase; letter-spacing: .7px;
                margin-bottom: 10px;
            }
            #priceCheckInput {
                width: 100%; padding: 8px 44px 8px 12px;
                background: #ffffff; border: 1.5px solid #cbd5e1;
                border-radius: 10px; color: #1f2937; font-size: 13px;
                box-sizing: border-box; outline: none;
                transition: border-color .2s, box-shadow .2s;
            }
            #priceCheckInput:focus {
                border-color: #6366f1; box-shadow: 0 0 0 3px #6366f118;
            }
            #priceCheckInput::placeholder { color: #94a3b8; }
            #priceCheckContainer select,
            #priceCheckContainer input[type="range"] { accent-color:#4f46e5; }
            #priceCheckContainer label { color:#475569 !important; }
            #priceCheckContainer .mc-panel input[type="text"],
            #priceCheckContainer .mc-panel textarea,
            #priceCheckContainer .mc-panel select { background:#ffffff !important; color:#334155 !important; border-color:#cbd5e1 !important; }
            #hatikoRequestStatus { display:none; color:#475569; font-size:10px; min-height:14px; padding:5px 8px; border-radius:7px; background:#f1f5f9; border:1px solid #e2e8f0; }
            #hatikoRequestStatus[data-state] { display:block; }
            #hatikoRequestStatus[data-state="busy"] { color:#1d4ed8; background:#dbeafe; }
            #hatikoRequestStatus[data-state="ok"] { color:#166534; background:#dcfce7; }
            #hatikoRequestStatus[data-state="warn"] { color:#92400e; background:#fef3c7; }
            #hatikoRequestStatus[data-state="error"] { color:#991b1b; background:#fee2e2; }
            .mc-links-panel {
                display:none; max-height:150px; overflow-y:auto;
                background:#ffffff; border:1px solid #e5e7eb;
                border-radius:10px; padding:8px 10px; font-size:11px;
            }
            .mc-links-panel a { display:block; color:#2563eb; margin:4px 0; word-break:break-all; }

                        /* ── Вкладки ── */
                        #mcTabs {
                            display: flex; gap: 4px; overflow-x: auto; flex-wrap: nowrap;
                            padding-bottom: 2px;
                        }
                        #mcTabs::-webkit-scrollbar { height: 3px; }
                        .mc-tab {
                            flex: 0 0 auto;
                            padding: 5px 8px; border: 1px solid #e2e8f0; border-radius: 8px;
                            background: #f8fafc; color: #475569; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all .15s ease; white-space: nowrap;
                        }
                        .mc-tab:hover { border-color: #6366f1; color: #4f46e5; background: #eef2ff; }
                        .mc-tab-active {
                            background: linear-gradient(135deg,#6366f1,#8b5cf6) !important;
                            border-color: transparent !important; color: #fff !important;
                            box-shadow: 0 2px 8px #6366f138;
                        }

                        /* ── Ленta сообщений (вместo textarea) ── */
                        #mcChatLog {
                            flex: 1 1 auto; width: 100%; min-height: 80px;
                                            display: flex; flex-direction: column; gap: 6px;
                            overflow-y: auto; padding: 6px; box-sizing: border-box;
                            background: #ffffff; border: 1.5px solid #e5e7eb; border-radius: 10px;
                        }
                        #mcChatLog:empty::after {
                            content: 'Запросы появятся здесь…';
                            display: block; margin: auto; color: #94a3b8; font-size: 11px;
                            font-style: italic; opacity: .8;
                        }
                        .mc-msg {
                            max-width: 92%; padding: 5px 9px; border-radius: 10px;
                            font-size: 11.5px; line-height: 1.55; word-break: break-word;
                            box-sizing: border-box;
                        }
                        .mc-msg-meta {
                            font-size: 8.5px; opacity: .65; letter-spacing: .3px;
                            margin-bottom: 2px; text-transform: uppercase;
                        }
                        .mc-msg-body { white-space: pre-wrap; word-break: break-word; }
                        .mc-msg-user {
                            align-self: flex-end; background: linear-gradient(135deg,#6366f1,#7c3aed);
                            color: #fff; border-bottom-right-radius: 3px;
                        }
                        .mc-msg-user .mc-msg-meta { color: #e0e7ff; }
                        .mc-msg-bot {
                            align-self: flex-start; background: #f1f5f9; color: #1f2937;
                            border: 1px solid #e5e7eb; border-bottom-left-radius: 3px;
                        }
                        .mc-msg-bot .mc-msg-meta { color: #6366f1; }
                        .mc-msg-system {
                            align-self: center; background: #fef9c3; color: #854d0e;
                            border: 1px solid #fde68a; font-size: 10.5px; text-align: center;
                        }
                        .mc-copy-btn {
                                        display: inline-block; margin-top: 5px; padding: 2px 8px;
                                        border: 1px solid #c7d2fe; border-radius: 6px;
                                        background: #ffffff; color: #4f46e5; font-size: 9.5px; font-weight: 600;
                                        cursor: pointer; transition: all .15s;
                                    }
                                    .mc-copy-btn:hover { background: #eef2ff; border-color: #818cf8; }
                                                            .mc-copy-done { background: #dcfce7 !important; border-color: #86efac !important; color: #166534 !important; }
                                                            .mc-retry-btn {
                                                                display: inline-block; margin-top: 5px; padding: 2px 8px;
                                                                border: 1px solid #a5d6f2; border-radius: 6px;
                                                                background: #ffffff; color: #1d4ed8; font-size: 9.5px; font-weight: 600;
                                                                cursor: pointer; transition: all .15s;
                                                            }
                                                            .mc-retry-btn:hover { background: #dbeafe; border-color: #60a5fa; }
                                                            .mc-msg-actions { display: flex; gap: 4px; flex-wrap: wrap; }

                        /* ── Нижняя панель ── */
                        #mcBottomBar {
                            flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 6px;
                        }
                        .mc-btn-clear {
                            padding: 5px 12px; border: 1px solid #fca5a5; border-radius: 8px;
                            background: #ffffff; color: #dc2626; font-size: 11px; font-weight: 600;
                            cursor: pointer; transition: all .15s;
                        }
                        .mc-btn-clear:hover { background: #fef2f2; border-color: #ef4444; }
                        .mc-action-btn {
                            padding: 4px 9px; border: 1px solid #e2e8f0; border-radius: 8px;
                            background: #f8fafc; font-size: 13px; line-height: 1; cursor: pointer;
                            transition: all .15s;
                        }
                        .mc-action-btn:hover { background: #eef2ff; border-color: #818cf8; transform: translateY(-1px); }

                        /* ── Статус-бар: подсказки при наведении ── */
                        .mc-status-bar {
                            flex: 1 1 auto; min-width: 0;
                            font-size: 10px; color: #64748b; line-height: 1.3;
                            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                            user-select: none;
                        }

                        /* ── Плавающие окна (расписание, Хакер) — без затемнения ── */
                        .mc-float-window {
                            position: fixed; top: 90px; right: 40px; width: 380px;
                            max-height: 70vh; background: #ffffff; border: 1px solid #dbe3ee;
                            border-radius: 14px; box-shadow: 0 14px 40px rgba(15,23,42,.18);
                            display: flex; flex-direction: column; gap: 8px; padding: 12px;
                            z-index: 100000; box-sizing: border-box;
                            color: #1f2937; font-size: 12.5px;
                        }
                        .mc-float-header {
                            display: flex; align-items: center; justify-content: space-between;
                            cursor: move; user-select: none; padding-bottom: 6px;
                            border-bottom: 1px solid #e2e8f0;
                        }
                        .mc-float-title { font-size: 13.5px; font-weight: 700; color: #111827; }
                        .mc-float-close {
                            border: 0; border-radius: 7px; padding: 4px 8px;
                            background: #f1f5f9; color: #64748b; cursor: pointer; font-size: 12px;
                        }
                        .mc-float-close:hover { background: #fee2e2; color: #dc2626; }
                        .mc-float-body { flex: 1 1 auto; overflow-y: auto; }
                        .mc-float-footer { display: flex; justify-content: flex-end; margin-top: 8px; }
                        .mc-sched-city {
                            font-size: 11px; font-weight: 700; color: #4f46e5;
                            background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px;
                            padding: 4px 9px; margin-top: 6px;
                        }
                        .mc-sched-row {
                            font-size: 11.5px; padding: 4px 9px; margin-top: 4px;
                            border: 1px solid #e5e7eb; border-radius: 7px; background: #ffffff;
                            color: #1f2937; white-space: pre-wrap; word-break: break-word;
                        }

                        /* ── Оверлеи ── */
                        .mc-overlay {
                            position: fixed; inset: 0; z-index: 100000;
                            display: flex; align-items: center; justify-content: center;
                            padding: 20px; background: rgba(2,6,23,.72);
                        }
                        .mc-overlay-modal {
                            width: min(620px, calc(100vw - 40px)); max-height: 80vh; overflow: auto;
                            padding: 16px; background: #ffffff; border: 1px solid #dbe3ee;
                            border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.6);
                            color: #1f2937;
                        }
                        .mc-overlay-header {
                                        display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
                                        font-size: 15px; color: #111827;
                                    }
                                    .mc-overlay-close {
                                        border: 0; border-radius: 7px; padding: 6px 9px; background: #f1f5f9; color: #475569; cursor: pointer;
                                    }
                                    .mc-overlay-close:hover { background: #fee2e2; color: #dc2626; }
                                    .mc-overlay-footer { display: flex; justify-content: flex-end; margin-top: 12px; }
                                    .mc-overlay-error { color: #991b1b; background: #fee2e2; border: 1px solid #fecaca; border-radius: 10px; padding: 10px; font-size: 12px; }
                        .mc-sched-city {
                            font-size: 11px; font-weight: 700; background: #f8fafc; border: 1px solid #e5e7eb;
                            border-radius: 8px 8px 0 0; padding: 5px 10px; margin-top: 8px;
                        }
                        .mc-sched-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
                        .mc-sched-table th, .mc-sched-table td {
                            text-align: left; padding: 5px 10px; border: 1px solid #e5e7eb;
                        }
                        .mc-sched-table th { background: #f1f5f9; color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
                        .mc-sched-table tbody tr:nth-child(odd) { background: #fafbff; }
                    `;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.id = 'priceCheckContainer';
        container.style.cssText = `
            position:fixed; top:14px; right:14px; width:430px;
            min-height:540px; max-height:93vh;
            background:#ffffff;
            border:1px solid #dbe3ee;
            border-radius:18px;
            box-shadow:0 16px 46px rgba(15,23,42,.22), 0 0 0 1px rgba(255,255,255,.9);
            padding:14px; display:none; z-index:99999;
            box-sizing:border-box; flex-direction:column; gap:10px;
            resize:both; overflow:hidden;
        `;

        container.innerHTML = `
            <!-- ── Шапка ── -->
            <div id="priceCheckHeader" style="
                display:flex;align-items:center;justify-content:space-between;
                cursor:move;user-select:none;padding-bottom:11px;
                border-bottom:1px solid #e2e8f0;
            ">
                <div style="display:flex;align-items:center;gap:9px;">
                    <div style="
                        width:34px;height:34px;border-radius:9px;flex-shrink:0;
                        background:linear-gradient(135deg,#6366f1,#a855f7);
                        display:flex;align-items:center;justify-content:center;
                        font-size:17px;box-shadow:0 3px 10px #6366f138;
                    ">🐱</div>
                    <div>
                        <div style="font-size:14px;font-weight:700;color:#111827;line-height:1.2;">Мемный чат</div>
                        <div id="memchatTabTitle" style="font-size:10px;font-weight:600;color:#4f46e5;letter-spacing:.3px;margin-top:1px;">🐶 Hatiko</div>
                        <div id="memchatVersion" style="font-size:8.5px;color:#94a3b8;letter-spacing:.5px;margin-top:1px;"></div>
                    </div>
                </div>
                <button id="priceCheckCloseButton" style="
                    width:29px;height:29px;border-radius:8px;border:none;
                    background:#f1f5f9;color:#64748b;font-size:13px;
                    cursor:pointer;transition:all .18s;
                    display:flex;align-items:center;justify-content:center;flex-shrink:0;
                ">✕</button>
            </div>

            <!-- ── Вкладки (эмодзи; полное название — в заголовке) ── -->
            <div id="mcTabs" role="tablist">
                <button class="mc-tab" data-tab="checkHatiko" data-tip="🐶 Hatiko — поиск и цены">🐶</button>
                <button class="mc-tab" data-tab="checkHatikoBonuses" data-tip="🎁 Бонусы — бонусы клиента">🎁</button>
                <button class="mc-tab" data-tab="calculator" data-tip="🧮 Калькулятор — расчёт кредита">🧮</button>
                <button class="mc-tab" data-tab="calculator_reverse" data-tip="🔄 Реверс — обратный расчёт">🔄</button>
                <button class="mc-tab" data-tab="calculator_discount" data-tip="🎉 Скидка — скидка и наценка">🎉</button>
                <button class="mc-tab" data-tab="calculator_simple" data-tip="∑ Простой — простое выражение">∑</button>
            </div>

            <!-- ── Поле ввода ── -->
            <div style="position:relative;">
                <input type="text" id="priceCheckInput" placeholder="Артикул, товар или сумма…">
                <span style="
                    position:absolute;right:11px;top:50%;transform:translateY(-50%);
                    font-size:9.5px;color:#283347;pointer-events:none;
                ">Enter ↵</span>
            </div>

            <!-- ── Лог / результат ── -->
                        <div id="mcResultRegion" style="flex:1 1 auto;display:flex;flex-direction:column;gap:8px;min-height:80px;">
                            <div id="mcChatLog" role="log"></div>
                            <div id="hatikoRequestStatus" role="status" aria-live="polite"></div>
                            <button id="hatikoReopenPickerButton" type="button" style="display:none;padding:5px 8px;border:1px solid #475569;border-radius:7px;background:#fff;color:#475569;cursor:pointer;">↶ Выбрать другой товар</button>
                            <div id="hatikoLinksPanel" class="mc-links-panel"></div>
                        </div>

            <!-- ── Нижняя панель: статус + действия + настройки + очистка ── -->
                        <div id="mcBottomBar" style="flex:0 0 auto;display:flex;justify-content:flex-end;gap:6px;align-items:center;">
                            <span id="mcStatusBar" class="mc-status-bar">Наведите на кнопку…</span>
                            <button id="mcActionToday" class="mc-action-btn" type="button" data-tip="👨‍💼 Кто работает сегодня">🟢📅</button>
                            <button id="mcActionTomorrow" class="mc-action-btn" type="button" data-tip="📅 Кто работает завтра">🟡📅</button>
                            <button id="mcActionHacker" class="mc-action-btn" type="button" data-tip="🐱‍👨‍💻 ХатикоХакер — будущие задачи">🐱‍👨‍💻</button>
                            <button id="mcActionSettings" class="mc-action-btn" type="button" data-tip="⚙️ Настройки">⚙️</button>
                            <button id="mcClearChatButton" class="mc-btn-clear" type="button" data-tip="🗑 Очистить историю этой вкладки">🗑</button>
                        </div>
                    `;

        document.body.appendChild(container);
        window.priceCheckContainer = container;
        document.getElementById('memchatVersion').textContent = `v${MEMCHAT_VERSION}${typeof MEMCHAT_BUILD !== 'undefined' ? `-${MEMCHAT_BUILD}` : ''}`;
        setupEventListeners();
        document.getElementById('hatikoReopenPickerButton').addEventListener('click', reopenHatikoProductPicker);
    }

    window.priceCheckContainer.style.display = 'flex';
    document.getElementById('priceCheckInput').focus();
    restoreSelectedAction();
}

function updateHatikoStatus(message) {
    const status = document.getElementById('hatikoRequestStatus');
    if (status) {
        status.textContent = `🐶 ${message}`;
        const lower = String(message).toLowerCase();
        status.dataset.state = /ошибка|не найден|недоступ/.test(lower) ? 'error'
            : /fallback|переключаюсь|не авториз/.test(lower) ? 'warn'
            : /готово/.test(lower) ? 'ok' : 'busy';
    }
    debugLog('hatiko-status', message);
}

function setupHatikoSearchModeSetting() {
    const select = document.getElementById('hatikoSearchMode');
    if (!select) return;
    hatikoSearchMode = loadHatikoSearchMode();
    select.value = hatikoSearchMode;
    select.addEventListener('change', () => saveHatikoSearchMode(select.value));
}

function updateHatikoLinksPanel(pathname) {
    const panel = document.getElementById('hatikoLinksPanel');
    if (!panel) return;
    panel.innerHTML = '';
    if (!loadShowHatikoLinks() || !pathname) {
        panel.style.display = 'none';
        return;
    }
    BASE_URLS.forEach((baseUrl, i) => {
        const link = document.createElement('a');
        link.href = `${baseUrl}${pathname}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `🌐${CITY_ICONS[i]} ${CITY_NAMES[i]}: ${link.href}`;
        panel.appendChild(link);
    });
    panel.style.display = 'block';
}

function setupHatikoLinksSetting() {
    const checkbox = document.getElementById('showHatikoLinksCheckbox');
    if (!checkbox) return;
    checkbox.checked = loadShowHatikoLinks();
    checkbox.addEventListener('change', () => {
        saveShowHatikoLinks(checkbox.checked);
        updateHatikoLinksPanel(currentHatikoPathname);
    });
}

function closeHatikoProductPicker() {
    document.getElementById('hatikoProductPicker')?.remove();
}

function reopenHatikoProductPicker() {
    if (lastHatikoResults.length > 1) openHatikoProductPicker(lastHatikoResults, lastHatikoQuery);
}

function copyHatikoText(text) {
    const fallback = () => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    };

    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(fallback);
    } else {
        fallback();
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'\"]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;'
    }[char]));
}

function openHatikoProductPicker(results, query) {
    closeHatikoProductPicker();

    const overlay = document.createElement('div');
    overlay.id = 'hatikoProductPicker';
    overlay.style.cssText = `
        position:fixed;inset:0;z-index:100000;
        display:flex;align-items:center;justify-content:center;
        padding:20px;background:rgba(2,6,23,.72);
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        width:min(720px, calc(100vw - 40px));max-height:80vh;overflow:auto;
        padding:16px;background:#111827;border:1px solid #334155;
        border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.6);
        color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;';
    const title = document.createElement('strong');
    title.textContent = '🐶 Выберите товар для копирования';
    title.style.fontSize = '15px';
    header.appendChild(title);

    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'border:0;border-radius:7px;padding:6px 9px;background:#334155;color:#e2e8f0;cursor:pointer;';
    close.addEventListener('click', closeHatikoProductPicker);
    header.appendChild(close);
    modal.appendChild(header);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;';

    results.forEach(result => {
        const card = document.createElement('button');
        card.type = 'button';
        card.style.cssText = `
            min-height:130px;padding:12px;text-align:left;cursor:pointer;
            border:1px solid #334155;border-radius:12px;background:#1e293b;color:#e2e8f0;
            transition:transform .15s,border-color .15s,background .15s;
        `;
        const cardTitle = document.createElement('strong');
        cardTitle.textContent = result.title;
        cardTitle.style.cssText = 'display:block;margin-bottom:8px;';
        card.appendChild(cardTitle);
        const prices = document.createElement('span');
        prices.style.cssText = 'display:block;color:#a5b4fc;font-size:12px;line-height:1.5;white-space:pre-line;';
        prices.textContent = result.prices.map((price, i) => `${CITY_NAMES[i]}: ${price}`).join('\n');
        card.appendChild(prices);
        card.addEventListener('mouseenter', () => { card.style.borderColor = '#818cf8'; card.style.transform = 'translateY(-2px)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = '#334155'; card.style.transform = 'none'; });
        card.addEventListener('click', () => {
            copyHatikoText(result.message);
            addToChatHistory('bot', result.message, '🐶 Hatiko', query);
            addToChatHistory('system', 'Ответ выбранного товара скопирован', '📋');
            closeHatikoProductPicker();
            const reopenButton = document.getElementById('hatikoReopenPickerButton');
            if (reopenButton) reopenButton.style.display = 'block';
        });
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'min-width:0;';
        wrapper.appendChild(card);

        const links = document.createElement('div');
        links.style.cssText = 'margin-top:5px;font-size:10px;line-height:1.5;';
        BASE_URLS.forEach((baseUrl, i) => {
            const link = document.createElement('a');
            link.href = `${baseUrl}${result.pathname}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = `${CITY_ICONS[i]} ${CITY_NAMES[i]}`;
            link.style.cssText = 'color:#93c5fd;margin-right:7px;';
            links.appendChild(link);
        });
        wrapper.appendChild(links);
        grid.appendChild(wrapper);
    });

    modal.appendChild(grid);
    overlay.appendChild(modal);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) closeHatikoProductPicker();
    });
    document.body.appendChild(overlay);
}

// ─── Статус-бар (подсказки при наведении) ────────────────────────────────────
function setStatusText(message) {
    const bar = document.getElementById('mcStatusBar');
    if (bar) bar.textContent = message;
}

// ─── Экспорт / импорт настроек ────────────────────────────────────────────────
function buildSettingsSnapshot() {
    return {
        calcRules,
        scheduleReplacements,
        clearTextEnabled,
        clearTimeout: parseInt(document.getElementById('timeoutSlider')?.value || 500, 10),
        showHatikoLinks: loadShowHatikoLinks(),
        hatikoSearchMode,
        hiddenFields: [...hiddenFields]
    };
}

function exportSettings() {
    copyHatikoText(JSON.stringify(buildSettingsSnapshot(), null, 2));
    const btn = document.getElementById('exportSettingsBtn');
    if (btn) {
        const prev = btn.textContent;
        btn.textContent = '✅ Скопировано';
        setTimeout(() => { btn.textContent = prev; }, 1200);
    }
    setStatusText('✅ Настройки скопированы в буфер');
}

function importSettings(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
        if (!data || typeof data !== 'object') throw new Error('empty');
    } catch (e) {
        const area = document.getElementById('mcImportArea');
        if (area) { area.style.borderColor = '#ef4444'; area.style.borderWidth = '2px'; }
        setStatusText('⚠️ Некорректный JSON настроек');
        return false;
    }

    if (Array.isArray(data.calcRules) && data.calcRules.every(r => r && typeof r.name === 'string')) {
        calcRules = data.calcRules;
        saveCalcRules();
        buildCalcRulesPanel();
    }
    if (data.scheduleReplacements && typeof data.scheduleReplacements === 'object' && !Array.isArray(data.scheduleReplacements)) {
        scheduleReplacements = data.scheduleReplacements;
        saveScheduleReplacements();
        buildSchedulePanel();
    }
    if (typeof data.clearTextEnabled === 'boolean') {
        clearTextEnabled = data.clearTextEnabled;
        localStorage.setItem('clearTextEnabled', String(clearTextEnabled));
        const cb = document.getElementById('clearTextCheckbox');
        if (cb) cb.checked = clearTextEnabled;
        updateClearTextButton();
    }
    if (typeof data.clearTimeout === 'number' && data.clearTimeout >= 1 && data.clearTimeout <= 2000) {
        const slider = document.getElementById('timeoutSlider');
        const label = document.getElementById('timeoutValue');
        if (slider) slider.value = data.clearTimeout;
        if (label) label.textContent = data.clearTimeout;
    }
    if (typeof data.showHatikoLinks === 'boolean') {
        saveShowHatikoLinks(data.showHatikoLinks);
        const cb = document.getElementById('showHatikoLinksCheckbox');
        if (cb) cb.checked = data.showHatikoLinks;
        updateHatikoLinksPanel(currentHatikoPathname);
    }
    if (['auto', 'panel', 'hatiko'].includes(data.hatikoSearchMode)) {
        saveHatikoSearchMode(data.hatikoSearchMode);
        const sel = document.getElementById('hatikoSearchMode');
        if (sel) sel.value = data.hatikoSearchMode;
    }
    if (Array.isArray(data.hiddenFields)) {
        hiddenFields = data.hiddenFields.filter(n => typeof n === 'string');
        saveHiddenFields();
        if (!msFieldsRevealed) applyMsHiddenFields(); else restoreMsFields();
        buildMsFieldsPanel();
        updateMsRevealButton();
    }

    const area = document.getElementById('mcImportArea');
    const actions = document.getElementById('mcImportActions');
    if (area) { area.style.display = 'none'; area.value = ''; area.style.borderColor = '#cbd5e1'; area.style.borderWidth = '1px'; }
    if (actions) actions.style.display = 'none';
    setStatusText('✅ Настройки импортированы');
    return true;
}

// ─── Заглушка «ХатикоХакер» ───────────────────────────────────────────────────
function openHackerStubWindow() {
    closeMemchatOverlay();

    const win = document.createElement('div');
    win.className = 'mc-float-window';
    applyFloatWindowPos(win);

    const header = document.createElement('div');
    header.className = 'mc-float-header';
    const title = document.createElement('div');
    title.className = 'mc-float-title';
    title.textContent = '🐱👨‍💻 ХатикоХакер';
    header.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mc-float-close';
    close.textContent = '✕';
    close.addEventListener('click', closeMemchatOverlay);
    header.appendChild(close);
    win.appendChild(header);

    const body = document.createElement('div');
    body.className = 'mc-float-body';

    const stub = document.createElement('div');
    stub.style.textAlign = 'center';
    stub.style.padding = '18px 0 6px';
    stub.innerHTML = '<div style="font-size:40px;">🔧</div>'
        + '<p style="margin:10px 0 6px;font-size:14px;font-weight:700;color:#111827;">Заглушка для будущих задач</p>'
        + '<p style="margin:0;font-size:12px;color:#64748b;">Здесь появится автоматизация «Хатико-Техники»: реверс-инжиниринг, серверные интеграции и всё, что мы придумаем дальше.</p>';
    body.appendChild(stub);

    win.appendChild(body);
    document.body.appendChild(win);
    makeMovable(win, header);
}

// ─── Окно «Настройки» ─────────────────────────────────────────────────────────
// Отдельное плавающее перетаскиваемое окно (позиция сохраняется).
function openSettingsWindow() {
    closeMemchatOverlay();

    const win = document.createElement('div');
    win.className = 'mc-float-window';
    applyFloatWindowPos(win);

    const header = document.createElement('div');
    header.className = 'mc-float-header';
    const title = document.createElement('div');
    title.className = 'mc-float-title';
    title.textContent = '⚙️ Настройки';
    header.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mc-float-close';
    close.textContent = '✕';
    close.addEventListener('click', closeMemchatOverlay);
    header.appendChild(close);
    win.appendChild(header);

    const body = document.createElement('div');
    body.className = 'mc-float-body';
    body.innerHTML = `
        <div class="mc-section-label">Очистка текста</div>
        <label style="display:flex;align-items:center;gap:8px;color:#475569;font-size:12px;margin-bottom:10px;cursor:pointer;">
            <input type="checkbox" id="clearTextCheckbox" style="accent-color:#6366f1;width:14px;height:14px;">
            Глобальная очистка текста после Enter
        </label>
        <label style="display:block;color:#475569;font-size:12px;">
            Задержка: <span id="timeoutValue" style="color:#6366f1;font-weight:700;">500</span> мс
            <input type="range" id="timeoutSlider" min="1" max="2000" value="500"
                style="width:100%;margin-top:5px;accent-color:#6366f1;display:block;">
        </label>
        <label style="display:flex;align-items:center;gap:8px;color:#475569;font-size:12px;margin-top:10px;cursor:pointer;">
            <input type="checkbox" id="showHatikoLinksCheckbox" style="accent-color:#6366f1;width:14px;height:14px;">
            Показывать ссылки Hatiko
        </label>
        <label style="display:block;color:#475569;font-size:12px;margin-top:10px;">
            Поиск цифровых запросов:
            <select id="hatikoSearchMode" style="display:block;width:100%;margin-top:5px;padding:5px;background:#fff;border:1px solid #cbd5e1;border-radius:6px;color:#334155;">
                <option value="auto">Сначала Panel, затем сайт</option>
                <option value="panel">Только Panel</option>
                <option value="hatiko">Только сайт Hatiko</option>
            </select>
        </label>

        <div style="height:8px;"></div>
        <button id="calcSettingsBtn" class="mc-btn mc-btn-slate" style="width:100%;">⚙️ Правила 🧮</button>
        <div id="calcSettingsPanel" class="mc-panel" style="display:none;max-height:none;">
            <div class="mc-panel-title">⚙️ Правила калькулятора
                <span style="font-weight:400;color:#334155;text-transform:none;letter-spacing:0;margin-left:6px;">
                    round(сумма × % ÷ 100 ÷ округл.) × округл. + доп.
                </span>
            </div>
            <div id="calcRulesPanel"></div>
        </div>

        <div style="height:8px;"></div>
        <button id="scheduleSettingsBtn" class="mc-btn mc-btn-slate" style="width:100%;">⚙️ Замены 📅</button>
        <div id="scheduleSettingsPanel" class="mc-panel" style="display:none;max-height:none;">
            <div class="mc-panel-title">⚙️ Замены для расписания</div>
            <div id="scheduleRulesPanel"></div>
        </div>

        <div style="height:8px;"></div>
        <button id="msFieldsSettingsBtn" class="mc-btn mc-btn-slate" style="width:100%;">⚙️ Скрытые поля МойСклад</button>
        <div id="msFieldsPanel" class="mc-panel" style="display:none;max-height:none;"></div>

        <div style="height:8px;"></div>
        <button id="resetFloatPosBtn" class="mc-btn mc-btn-orange" style="width:100%;" data-tip="↺ Вернуть окна в позицию по умолчанию">↺ Сбросить положение окон</button>

        <div style="height:8px;"></div>
        <div style="display:flex;gap:6px;">
            <button id="exportSettingsBtn" class="mc-btn mc-btn-slate" style="flex:1;" data-tip="📋 Скопировать все настройки в буфер">📤 Экспорт</button>
            <button id="importSettingsBtn" class="mc-btn mc-btn-slate" style="flex:1;" data-tip="📥 Вставить настройки из буфера">📥 Импорт</button>
        </div>
        <textarea id="mcImportArea" spellcheck="false" placeholder='Вставьте сюда JSON настроек…' style="display:none;width:100%;height:110px;margin-top:6px;padding:7px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;color:#334155;font-size:10.5px;font-family:monospace;box-sizing:border-box;resize:vertical;outline:none;"></textarea>
        <div id="mcImportActions" style="display:none;gap:6px;margin-top:6px;">
            <button id="mcImportApply" class="mc-btn mc-btn-green" style="flex:1;">Применить</button>
            <button id="mcImportCancel" class="mc-btn mc-btn-slate" style="flex:1;">Отмена</button>
        </div>
    `;
    win.appendChild(body);

    // Сначала в DOM — иначе getElementById не найдёт элементы окна.
    document.body.appendChild(win);

    // Привязки: setup-функции синхронизируют состояние, документ-слушатель вешается один раз.
    setupGlobalClearTextFunctionality();
    setupHatikoLinksSetting();
    setupHatikoSearchModeSetting();
    document.getElementById('timeoutSlider').addEventListener('input', e => {
        document.getElementById('timeoutValue').textContent = e.target.value;
    });
    document.getElementById('calcSettingsBtn').addEventListener('click', () => {
        const panel = document.getElementById('calcSettingsPanel');
        const wasHidden = panel.style.display === 'none';
        togglePanel('calcSettingsPanel');
        if (wasHidden) buildCalcRulesPanel();
    });
    document.getElementById('scheduleSettingsBtn').addEventListener('click', () => {
        const panel = document.getElementById('scheduleSettingsPanel');
        const wasHidden = panel.style.display === 'none';
        togglePanel('scheduleSettingsPanel');
        if (wasHidden) buildSchedulePanel();
    });
    document.getElementById('msFieldsSettingsBtn').addEventListener('click', () => {
        const panel = document.getElementById('msFieldsPanel');
        const wasHidden = panel.style.display === 'none';
        togglePanel('msFieldsPanel');
        if (wasHidden) buildMsFieldsPanel();
    });
    document.getElementById('resetFloatPosBtn').addEventListener('click', () => {
        resetFloatWindowPos();
        closeMemchatOverlay();
        setStatusText('✅ Положение окон сброшено');
    });

    // Экспорт / импорт настроек
    document.getElementById('exportSettingsBtn').addEventListener('click', exportSettings);
    document.getElementById('importSettingsBtn').addEventListener('click', () => {
        const area = document.getElementById('mcImportArea');
        const actions = document.getElementById('mcImportActions');
        if (!area || !actions) return;
        const showing = area.style.display !== 'none';
        area.style.display = showing ? 'none' : 'block';
        actions.style.display = showing ? 'none' : 'flex';
        if (!showing) area.focus();
    });
    document.getElementById('mcImportApply').addEventListener('click', () => {
        importSettings(document.getElementById('mcImportArea')?.value || '');
    });
    document.getElementById('mcImportCancel').addEventListener('click', () => {
        const area = document.getElementById('mcImportArea');
        const actions = document.getElementById('mcImportActions');
        if (area) { area.style.display = 'none'; area.value = ''; area.style.borderColor = '#cbd5e1'; area.style.borderWidth = '1px'; }
        if (actions) actions.style.display = 'none';
        setStatusText('Наведите на кнопку…');
    });
    buildCalcRulesPanel();
    buildSchedulePanel();

    makeMovable(win, header);
}

/* ===== 10-events-and-init.js ===== */

// ─── Обработчики событий ─────────────────────────────────────────────────────
const TAB_LABELS = {
    checkHatiko: '🐶 Hatiko',
    checkHatikoBonuses: '🎁 Бонусы',
    calculator: '🧮 Калькулятор',
    calculator_reverse: '🔄 Реверс',
    calculator_discount: '🎉 Скидка/+',
    calculator_simple: '∑ Простой'
};

function setupEventListeners() {
    const container = window.priceCheckContainer;

    // Перетаскивание
    document.getElementById('priceCheckHeader').addEventListener('mousedown', startDrag);

    // Enter в поле ввода — работает только на режимных вкладках
    document.getElementById('priceCheckInput').addEventListener('keypress', e => {
        if (e.key === 'Enter' && currentAction && MODE_ACTIONS.includes(currentAction)) {
            executeCurrentAction();
        }
    });

    document.getElementById('priceCheckInput').addEventListener('keydown', e => {
        if (e.key === 'Escape') e.currentTarget.value = '';
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeHatikoProductPicker();
            closeMemchatOverlay();
        }
    });

    // Клик по вкладке
    container.querySelectorAll('[data-tab]').forEach(tab => {
        tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    });

    // Клики по ленте (кнопки «Копировать»)
    document.getElementById('mcChatLog').addEventListener('click', handleChatLogClick);

    // Кнопка «Очистить» — активную вкладку
        document.getElementById('mcClearChatButton').addEventListener('click', clearChat);

        // Быстрые действия и настройки (нижняя панель)
            document.getElementById('mcActionToday').addEventListener('click', fetchWhoWorksToday);
            document.getElementById('mcActionTomorrow').addEventListener('click', fetchWhoWorksTomorrow);
            document.getElementById('mcActionHacker').addEventListener('click', openHackerStubWindow);
            document.getElementById('mcActionSettings').addEventListener('click', openSettingsWindow);

            // Тултипы → статус-бар (текст внизу, рядом с кнопками)
                container.addEventListener('mouseover', e => {
                    const el = e.target.closest?.('[data-tip]');
                    if (el) setStatusText(el.dataset.tip);
                });
                container.addEventListener('mouseout', e => {
                    if (e.target.closest?.('[data-tip]')) setStatusText('Наведите на кнопку…');
                });

        // Закрытие
    document.getElementById('priceCheckCloseButton').addEventListener('click', () => {
        window.priceCheckContainer.style.display = 'none';
    });

    // Hover эффект кнопки закрытия
    const closeBtn = document.getElementById('priceCheckCloseButton');
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#ef4444'; closeBtn.style.color = '#fff'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = '#f1f5f9'; closeBtn.style.color = '#64748b'; });
}

// ─── Переключение вкладок ─────────────────────────────────────────────────────
function selectTab(tab) {
    const tabsEl = document.getElementById('mcTabs');
    tabsEl.querySelectorAll('[data-tab]').forEach(t => {
        t.classList.toggle('mc-tab-active', t.dataset.tab === tab);
    });

    currentAction = tab;
    if (MODE_ACTIONS.includes(tab)) saveSelectedAction(tab);
    debugLog('tab', 'selected', tab);

    // Название вкладки — в заголовке окна
        const titleEl = document.getElementById('memchatTabTitle');
        if (titleEl) titleEl.textContent = TAB_LABELS[tab] || tab;

        renderChat();
    }

// Восстановить последний выбранный режим (только режимные вкладки)
function restoreSelectedAction() {
    const action = loadSelectedAction();
    const tab = document.querySelector(`[data-tab="${action}"]`)
        || document.querySelector('[data-tab="checkHatiko"]');
    if (tab) selectTab(tab.dataset.tab);
}

function togglePanel(id) {
    const ids = ['calcSettingsPanel', 'scheduleSettingsPanel', 'msFieldsPanel'];
    ids.forEach(pid => {
        const el = document.getElementById(pid);
        if (!el) return;
        el.style.display = (pid === id && el.style.display === 'none') ? 'block' : 'none';
    });
}

// ─── Инициализация ────────────────────────────────────────────────────────────
function closeChatWindow() {
    if (window.priceCheckContainer) window.priceCheckContainer.style.display = 'none';
}

function initialize() {
    installDebugHandlers();
    loadCalcRules();
    loadScheduleReplacements();
    loadChatHistory();
    loadHiddenFields();
    startPanelBridgeListener();
    schedulePanelCsrfRefresh();
    GM_registerMenuCommand('Открыть мемный чат', createPriceCheckWindow);
        GM_registerMenuCommand('Закрыть мемный чат', closeChatWindow);
        GM_registerMenuCommand('Сбросить положение окон', resetFloatWindowPos);
        GM_registerMenuCommand('Переключить отладку мемного чата', toggleDebugMode);
        if (/online\.moysklad\.ru$/.test(location.hostname)) {
            GM_registerMenuCommand('👁 Показать/скрыть поля МойСклад', toggleMsFieldsRevealed);
        }
    debugLog('init', 'initialized');
    console.log('Мемный чат v6.4.0 инициализирован');

    // Скрытие полей МойСклад: применить и следить за перерисовками SPA
    if (/online\.moysklad\.ru$/.test(location.hostname) && hiddenFields.length) {
        applyMsHiddenFields();
        updateMsRevealButton();
        msFieldObserver = new MutationObserver(() => {
            // Дебаунс: SPA-перерисовки шквалом меняют DOM
            clearTimeout(msFieldObserver._t);
            msFieldObserver._t = setTimeout(() => {
                if (msFieldsRevealed) return;
                msHiddenTargets.forEach(t => { if (!t.el.isConnected) t.el.style.display = ''; });
                msHiddenTargets = msHiddenTargets.filter(t => t.el.isConnected);
                applyMsHiddenFields();
            }, 300);
        });
        msFieldObserver.observe(document.body, { childList: true, subtree: true });
    }
}

// ─── Production entrypoint ───────────────────────────────────────────────────
initialize();
