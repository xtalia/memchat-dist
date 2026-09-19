// ==UserScript==
// @name         Мемный чат с калькулятором
// @namespace    http://tampermonkey.net/
// @version      8.2.8-beta
// @description  Мемный чат: вкладки, история по режимам, расписание «Кто/Где», настройки вкладкой, ХатикоХакер
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
// @connect      api.moysklad.ru
// ==/UserScript==

// Production-файл собирается из js/memchat/src/*.js.


/* ===== 01-config-and-state.js ===== */

'use strict';

const MEMCHAT_VERSION = '8.2.8-beta';

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
let scheduleStateByDay = {
    today: { loading: false, parsed: null, textCopy: '', error: '', updatedAt: 0 },
    tomorrow: { loading: false, parsed: null, textCopy: '', error: '', updatedAt: 0 }
};
let currentHatikoPathname = '';
let lastHatikoResults = [];
let lastHatikoQuery = '';
let hatikoSearchMode = 'auto';
let activeRequestId = 0;
// Поведение кнопки 🔁: append — сохранить старый ответ, replace — заменить его.
let retryBehavior = 'append';

// API МойСклад для ХатикоХакера
let hackerBearerEnabled = false;
let hackerBearerToken = '';
let hackerApiValidated = false;
let hackerDefaultChannel = '';
let hackerQuickButtonsEnabled = true;
const HACKER_NOTIFIER_AUDIO_URL = 'https://www.myinstants.com/media/sounds/fnaf-animatronic-at-door.mp3';
const HACKER_NOTIFIER_DEFAULT_INTERVAL_MINUTES = 5;
let hackerNotifierSettings = {
    enabled: true,
    soundEnabled: true,
    intervalMinutes: HACKER_NOTIFIER_DEFAULT_INTERVAL_MINUTES,
    organizationHref: '',
    statusHrefs: []
};
let hackerNotifierOrganizations = [];
let hackerNotifierSeenByOrganization = {};
let hackerNotifierStatusSelectionInitialized = false;
let hackerNotifierTimer = null;
let hackerNotifierInFlight = false;
let hackerNotifierAudio = null;
// Экспериментальные API-кнопки создания документов временно скрыты.
// Рабочая панель, нажимающая штатные пункты меню МойСклад, остаётся включённой.
const HACKER_QUICK_API_ROW_ENABLED = false;

// 🪄 Правила заполнения штатных карточек документов МойСклад. Пустые обязательные
// значения пользователь выбирает в окне палочки перед сохранением документа.
const DEFAULT_MS_MAGIC_CONFIG = {
    demand: {
        copies: [{ field: 'Канал продаж', from: 0, to: [1], required: true }],
        values: []
    },
    cashin: {
        copies: [],
        values: [
            { field: 'Тип оплаты', value: 'Наличными', required: true },
            { field: 'Статус клиента', value: '', required: true }
        ]
    },
    paymentin: {
        copies: [],
        values: [{ field: 'Способ оплаты', value: '', required: true }]
    }
};
let msMagicConfig = JSON.parse(JSON.stringify(DEFAULT_MS_MAGIC_CONFIG));

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

// ─── Панель быстрых кнопок МойСклад (создать/печать) ─────────────────────────
// kind → пункты меню тулбара карточки. marker() определяет страницу по hash.
let msQuickPanelEnabled = true;
let msQuickObserver = null;
const MS_QUICK_PANEL_CONFIG = {
    customerorder: {
        marker: () => /^#customerorder\/edit/.test(location.hash),
        magic: false,
        create: ['Отгрузка', 'Входящий платеж', 'Приходный ордер'],
        print: ['[Сервис] Приемная квитанция A4 x2', '[Сервис] Товарный чек', '[Сервис] Договор купли-продажи +акт']
    },
    demand: {
        marker: () => /^#demand\/edit/.test(location.hash),
        magic: true,
        create: ['Входящий платеж', 'Приходный ордер', 'Возврат покупателя'],
        print: ['Товарный чек 5%', 'Товарный чек Патент', '[Сервис] Товарный чек А4', '[Сервис] Квитанция на б/у']
    },
    cashin: {
        marker: () => /^#cashin\/edit/.test(location.hash),
        magic: true,
        create: ['Отгрузка', 'Входящий платеж'],
        print: []
    },
    paymentin: {
        marker: () => /^#paymentin\/edit/.test(location.hash),
        magic: true,
        create: ['Отгрузка', 'Приходный ордер'],
        print: []
    }
};

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
        const reason = event.reason;
        debugError('promise', reason?.stack || reason?.message || reason);
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

function loadRetryBehavior() {
    try {
        const behavior = localStorage.getItem(storageKey('retryBehavior_v1'));
        return behavior === 'replace' ? 'replace' : 'append';
    } catch {
        return 'append';
    }
}

function saveRetryBehavior(behavior) {
    if (!['append', 'replace'].includes(behavior)) return;
    retryBehavior = behavior;
    try {
        localStorage.setItem(storageKey('retryBehavior_v1'), behavior);
    } catch (error) {
        debugError('storage', 'Не удалось сохранить поведение кнопки повтора', error);
    }
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

// ─── Панель быстрых кнопок МойСклад ──────────────────────────────────────────
function loadMsQuickPanelEnabled() {
    try {
        if (localStorage.getItem(storageKey('msQuickPanel_v1')) === 'false') msQuickPanelEnabled = false;
    } catch { /* по умолчанию включена */ }
}

function saveMsQuickPanelEnabled() {
    try {
        localStorage.setItem(storageKey('msQuickPanel_v1'), String(msQuickPanelEnabled));
    } catch (error) {
        debugError('storage', 'Не удалось сохранить настройку панели быстрых кнопок', error);
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
    // Bridge работает push-моделью: если токен уже пришёл — используем его.
    // Не ждём ответ на postMessage: это убирает задержку до 4 секунд при
    // закрытой/неактивной вкладке Panel. При отсутствии кэша идём напрямую.
    refreshPanelCsrf(onSuccess, error => {
        openPanelInBackground();
        onError?.(error);
    });
}

function schedulePanelCsrfRefresh() {
    if (panelCsrfRefreshing || typeof setInterval === 'undefined') return;
    panelCsrfRefreshing = true;
    // Проверяем кэш чаще, но сам токен обновляем только по TTL.
    setInterval(() => {
        if (loadPanelCsrf()) return;
        refreshPanelCsrf(() => {}, () => { clearPanelCsrf(); });
    }, 60 * 1000);
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
            refreshPanelCsrf(newCsrf => attempt(newCsrf, true), () => onError(new Error('Panel: авторизация истекла. Войдите в panel.hatiko.ru.')));
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
            refreshPanelCsrf(newCsrf => attempt(newCsrf, true), () => onError(new Error('Panel: авторизация истекла. Войдите в panel.hatiko.ru.')));
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
function removeRetryEntry(entry) {
    const history = chatHistoryByAction[currentAction] || [];
    const index = history.indexOf(entry);
    if (index < 0) return;

    // В режиме замены убираем ответ и его исходный запрос, чтобы новый запуск
    // не оставлял в ленте лишнюю пару user/bot.
    history.splice(index, 1);
    const previous = history[index - 1];
    if (previous?.sender === 'user' && previous.message === entry.query) history.splice(index - 1, 1);
    renderChat();
    saveChatHistory();
}

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

    // Повторяем тот же запрос в той же вкладке.
    if (currentAction !== entry.action) selectTab(entry.action);
    if (retryBehavior === 'replace') removeRetryEntry(entry);
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
// Вкладки «Сегодня»/«Завтра» показывают данные внутри Мемного чата.
function fetchWhoWorksToday()    { return fetchWhoWorks('today'); }
function fetchWhoWorksTomorrow() { return fetchWhoWorks('tomorrow'); }

function fetchWhoWorks(day) {
    const url     = `https://docs.google.com/spreadsheets/d/13KUmHtRXYbXjBE7KQ_4MFQ5VsgUYqu2heURY1y2NwiE/edit`;
    const jsonUrl = 'https://github.com/xtalia/hatiko/raw/refs/heads/main/js/wwPeoples.json';
    const state = scheduleStateByDay[day];
    if (!state || state.loading) return Promise.resolve(null);
    state.loading = true;
    state.error = '';
    renderScheduleTab(day);

    return fetch(jsonUrl)
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(loaded => loadTableWithReplacements(day, url, { ...scheduleReplacements, ...loaded }))
        .catch(() => loadTableWithReplacements(day, url, scheduleReplacements))
        .then(result => {
            state.loading = false;
            state.parsed = result.parsed;
            state.textCopy = result.textCopy;
            state.error = '';
            state.updatedAt = Date.now();
            renderScheduleTab(day);
            return result;
        })
        .catch(error => {
            state.loading = false;
            state.error = error.message || 'Ошибка сети при загрузке расписания';
            renderScheduleTab(day);
            return null;
        });
}

function loadTableWithReplacements(day, url, replacements) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload(response) {
            try {
                const regex = /🎯РАБОЧИЙ_ГРАФИК_ДАННЫЕ🎯([\s\S]*?)🎯/i;
                const match = response.responseText.match(regex);
                if (!match?.[1]) throw new Error('Не удалось найти данные в таблице');

                const parsedHtml = new DOMParser().parseFromString(match[1], 'text/html');
                const full = (parsedHtml.body.textContent || '').trim().replace(/\s+/g, ' ');
                const markers = {
                    today:    ['📅СЕГОДНЯ_НАЧАЛО📅', '📅СЕГОДНЯ_КОНЕЦ📅'],
                    tomorrow: ['📅ЗАВТРА_НАЧАЛО📅', '📅ЗАВТРА_КОНЕЦ📅']
                };
                const [sm, em] = markers[day];
                const si = full.indexOf(sm), ei = full.indexOf(em);
                if (si === -1 || ei === -1) throw new Error('Данные не найдены');
                const text = full.substring(si, ei).replace(sm, '').replace(em, '').trim();
                resolve({
                    parsed: parseScheduleLines(text, replacements, day),
                    textCopy: formatOutputWithReplacements(text, replacements, day)
                });
            } catch (error) {
                reject(error);
            }
        },
        onerror() { reject(new Error('Ошибка сети при загрузке расписания')); }
    }));
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

function renderScheduleTab(day) {
    const pane = document.getElementById('mcSpecialPane');
    if (!pane || currentAction !== day) return;
    const state = scheduleStateByDay[day];
    const dayName = day === 'today' ? 'Сегодня' : 'Завтра';
    pane.replaceChildren();

    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;flex:0 0 auto;';
    const title = document.createElement('strong');
    title.textContent = `${day === 'today' ? '🟢' : '🟡'} ${dayName}${state.parsed?.dateStr ? ` — ${state.parsed.dateStr}` : ''}`;
    title.style.cssText = 'flex:1;color:#334155;font-size:12px;';
    toolbar.appendChild(title);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'mc-btn mc-btn-blue';
    refresh.textContent = state.loading ? '⏳' : '↻ Обновить';
    refresh.disabled = state.loading;
    refresh.addEventListener('click', () => fetchWhoWorks(day));
    toolbar.appendChild(refresh);
    pane.appendChild(toolbar);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:9.5px;color:#94a3b8;';
    meta.textContent = state.updatedAt
        ? `Обновлено ${new Date(state.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${state.error ? ' · данные могут быть устаревшими' : ''}`
        : 'Нажмите «Обновить», чтобы загрузить расписание';
    pane.appendChild(meta);

    const list = document.createElement('div');
    list.style.cssText = 'flex:1 1 auto;overflow-y:auto;min-height:80px;';
    if (state.error) {
        const error = document.createElement('div');
        error.className = 'mc-overlay-error';
        error.textContent = state.error;
        list.appendChild(error);
    }
    if (state.parsed?.groups?.length) {
        state.parsed.groups.forEach(group => {
            const city = document.createElement('div');
            city.className = 'mc-sched-city';
            city.textContent = `🏙 ${group.city}`;
            list.appendChild(city);
            group.rows.forEach(item => {
                const row = document.createElement('div');
                row.className = 'mc-sched-row';
                row.textContent = `👤 ${item.person} — ${item.store}`;
                list.appendChild(row);
            });
        });
    }
    pane.appendChild(list);

    if (state.textCopy) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'mc-btn mc-btn-slate';
        copy.textContent = '📋 Копировать';
        copy.addEventListener('click', () => copyHatikoText(state.textCopy));
        pane.appendChild(copy);
    }
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

// ─── Панель быстрых кнопок МойСклад (создать/печать) ─────────────────────────
// Кнопки-дубли тулбара карточки: клик = открыть меню тулбара и выбрать пункт.
// Поддерживаются оба механизма меню: React-дропдауны и GWT-попапы.

function msGetToolbarButton(label) {
    // Новый дизайн МойСклад — настоящие <button>, старый (GWT) — DIV.btn
    return [...document.querySelectorAll('button, [role=button], .btn')]
        .find(b => (b.textContent || '').trim() === label && b.offsetHeight > 0 && !b.disabled);
}

// GWT/React-пункты меню игнорируют голый .click() — нужен полный жест мыши
function msSyntheticClick(el) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
}

function msClickMenuItem(buttonLabel, itemText) {
    return new Promise(resolve => {
        const btn = msGetToolbarButton(buttonLabel);
        if (!btn) { resolve({ ok: false, why: `Кнопка «${buttonLabel}» не найдена` }); return; }
        msSyntheticClick(btn);
        setTimeout(() => {
            // React-дропдаун: кликабельный div[class*="option"] с точным текстом
            let target = [...document.querySelectorAll('[class*="option"]')].reverse()
                .find(o => o.offsetHeight > 0 && o.children.length <= 1 && (o.textContent || '').trim() === itemText);
            // GWT-попап: TD.gwt-MenuItem
            if (!target) {
                target = [...document.querySelectorAll('.gwt-MenuItem')]
                    .find(i => i.offsetHeight > 0 && (i.textContent || '').trim() === itemText);
            }
            if (!target) {
                setStatusText(`⚠️ «${itemText}» не найдено в меню — выберите вручную`);
                resolve({ ok: false, why: 'пункт не найден' });
                return;
            }
            msSyntheticClick(target);
            setStatusText(`✅ ${itemText}`);
            resolve({ ok: true });
        }, 700);
    });
}

function hackerOpenQuickActionPopup(action, anchor) {
    if (!hackerCanRun()) return;
    const old = document.getElementById('mcHackerQuickPopup');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.id = 'mcHackerQuickPopup';
    box.style.cssText = 'position:fixed;z-index:2147483001;width:300px;padding:12px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 30px #0f172a40;font:12px Segoe UI,sans-serif;color:#334155;';
    const r = anchor?.getBoundingClientRect?.();
    box.style.left = `${Math.max(8, Math.min((r?.left || 20), window.innerWidth - 320))}px`;
    box.style.top = `${Math.min((r?.bottom || 80) + 5, window.innerHeight - 230)}px`;
    const title = document.createElement('div');
    title.textContent = action === 'demand' ? '⚡ Отгрузка' : action === 'cashin' ? '⚡ Приходный ордер' : action === 'paymentin' ? '⚡ Входящий платёж' : '⚡ Кредит/Рассрочка';
    title.style.cssText = 'font-weight:700;margin-bottom:8px;';
    box.appendChild(title);
    const addInput = (id, label, placeholder) => {
        const l = document.createElement('label'); l.textContent = label; l.style.cssText = 'display:block;margin:6px 0 3px;font-weight:600;';
        const i = document.createElement('input'); i.id = id; i.type = 'text'; i.placeholder = placeholder || ''; i.style.cssText = HACKER_INPUT_CSS; box.appendChild(l); box.appendChild(i); return i;
    };
    if (action === 'demand') {
        const hint = document.createElement('div'); hint.textContent = 'Канал продаж: как в заказе'; hint.style.color = '#64748b'; box.appendChild(hint);
    } else {
        addInput('hackerSaleSum', action === 'credit' ? 'Общая сумма' : 'Сумма', '0');
        if (action === 'cashin' || action === 'credit') {
            addInput('hackerCashAmount', 'Наличные', action === 'credit' ? '0' : '');
            const s = hackerSelect('hackerClientStatusSelect', 'Статус клиента'); s.style.cssText = HACKER_SELECT_CSS; box.appendChild(s); hackerRefreshClientStatuses(true);
        }
        if (action === 'paymentin' || action === 'credit') {
            const s = hackerSelect('hackerPayMethodSelect', 'Способ оплаты'); s.style.cssText = HACKER_SELECT_CSS; box.appendChild(s); hackerRefreshPayMethods(true);
        }
    }
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:5px;margin-top:10px;';
    const go = document.createElement('button'); go.textContent = 'Создать'; go.style.cssText = HACKER_BTN_CSS + 'background:#4f46e5;flex:1;';
    go.onclick = async () => { if (action === 'demand') await hackerCreateDemand(); else if (action === 'cashin') await hackerCreateCashin(); else if (action === 'paymentin') await hackerCreatePaymentin(); else await hackerCreateCredit(); box.remove(); };
    const cancel = document.createElement('button'); cancel.textContent = 'Отмена'; cancel.style.cssText = HACKER_MINI_BTN_CSS; cancel.onclick = () => box.remove();
    row.appendChild(go); row.appendChild(cancel); box.appendChild(row); document.body.appendChild(box);
    if (action !== 'demand') {
        if (action === 'cashin' || action === 'credit') hackerRefreshClientStatuses(true);
        if (action === 'paymentin' || action === 'credit') hackerRefreshPayMethods(true);
    }
}

function hackerOpenAgentQuickPopup(anchor) {
    if (!hackerCanRun()) return;
    const old = document.getElementById('mcHackerAgentPopup');
    if (old) { old.remove(); return; }
    const box = document.createElement('div');
    box.id = 'mcHackerAgentPopup';
    box.style.cssText = 'position:fixed;z-index:2147483001;width:300px;padding:12px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 30px #0f172a40;font:12px Segoe UI,sans-serif;color:#334155;';
    const r = anchor?.getBoundingClientRect?.();
    box.style.left = `${Math.max(8, Math.min((r?.left || 20), window.innerWidth - 320))}px`;
    box.style.top = `${Math.min((r?.bottom || 80) + 5, window.innerHeight - 230)}px`;
    box.innerHTML = '<b>⚡ Контрагент</b>';
    const add = (id, label, placeholder) => {
        const l = document.createElement('label'); l.textContent = label; l.style.cssText = 'display:block;margin:7px 0 3px;font-weight:600;';
        const i = document.createElement('input'); i.id = id; i.type = 'text'; i.placeholder = placeholder || ''; i.style.cssText = HACKER_INPUT_CSS; box.appendChild(l); box.appendChild(i); return i;
    };
    add('hackerAgentName', 'ФИО', 'Иванов Иван Иванович');
    add('hackerAgentPhone', 'Номер', '+7 900 000-00-00');
    const check = document.createElement('label'); check.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:7px;';
    check.innerHTML = '<input type="checkbox" id="hackerAgentCheckCreate"> если не найден, создать контрагента'; box.appendChild(check);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:5px;margin-top:10px;';
    const phone = () => document.getElementById('hackerAgentPhone')?.value.trim();
    const name = () => document.getElementById('hackerAgentName')?.value.trim();
    const checkCreate = () => document.getElementById('hackerAgentCheckCreate')?.checked;
    const assign = document.createElement('button'); assign.textContent = 'Поменять'; assign.style.cssText = HACKER_BTN_CSS + 'background:#4f46e5;flex:1;';
    assign.onclick = () => hackerFindAgentByPhone(phone()).then(rows => rows.length ? hackerAssignAgent(rows[0].meta.href).then(() => hackerLog('✅ Контрагент заменён', 'ok')) : hackerLog('Контрагент не найден', 'warn')).catch(error => hackerLog('Контрагент: ' + error.message, 'err'));
    const create = document.createElement('button'); create.textContent = 'Создать'; create.style.cssText = HACKER_BTN_CSS + 'background:#16a34a;flex:1;';
    create.onclick = () => hackerFindAgentByPhone(phone()).then(rows => { if (rows.length && !checkCreate()) return hackerLog('Контрагент уже найден; создание отменено', 'warn'); return hackerCreateAgent(name(), phone()).then(agent => hackerLog('✅ Контрагент создан', 'ok')); }).catch(error => hackerLog('Контрагент: ' + error.message, 'err'));
    const verify = document.createElement('button'); verify.textContent = 'Проверить'; verify.style.cssText = HACKER_MINI_BTN_CSS;
    verify.onclick = () => hackerAgentCheckClick();
    const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = HACKER_MINI_BTN_CSS; close.onclick = () => box.remove();
    row.appendChild(assign); row.appendChild(create); row.appendChild(verify); row.appendChild(close); box.appendChild(row); document.body.appendChild(box);
}

function buildMsHackerQuickRow(kind) {
    const row = document.createElement('div');
    row.id = 'mcHackerQuickRow';
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:2px 0;';
    [['demand','⚡+ отгрузка'],['cashin','⚡+ приходный ордер'],['paymentin','⚡+ входящий платёж'],['credit','⚡+ кредит'],['agent','⚡ Контрагент']].forEach(([action,label]) => {
        const b = document.createElement('button'); b.type='button'; b.textContent=label; b.style.cssText='padding:3px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font-size:11px;cursor:pointer;'; b.onclick=()=> action === 'agent' ? hackerOpenAgentQuickPopup(b) : hackerOpenQuickActionPopup(action, b); row.appendChild(b);
    });
    const sumBtn = document.createElement('button'); sumBtn.type='button'; sumBtn.textContent='🔄 Сумма'; sumBtn.title='Проверить и подставить актуальную сумму заказа'; sumBtn.style.cssText='padding:3px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font-size:11px;cursor:pointer;'; sumBtn.onclick=() => hackerCheckOrderSum(); row.appendChild(sumBtn);
    return row;
}

function buildMsQuickPanel() {
    if (!/online\.moysklad\.ru$/.test(location.hostname)) return;
    const old = document.getElementById('mcQuickPanel');
    const oldWrap = document.querySelector('[data-mc-quick-wrap]');
    const oldQuickRow = document.getElementById('mcHackerQuickRow');
    const kind = Object.keys(MS_QUICK_PANEL_CONFIG).find(k => MS_QUICK_PANEL_CONFIG[k].marker());
    const cfg = kind ? MS_QUICK_PANEL_CONFIG[kind] : null;
    const quickSignature = cfg ? [cfg.magic ? 'magic' : '', ...cfg.create, ...cfg.print].join('\u001f') : '';
    const expectedButtonCount = cfg ? cfg.create.length + cfg.print.length + (cfg.magic ? 1 : 0) : 0;
    const quickEnabled = HACKER_QUICK_API_ROW_ENABLED && hackerQuickButtonsEnabled;
    const panelHealthy = old && old.isConnected && old.dataset.kind === kind
        && old.dataset.quickSignature === quickSignature
        && old.querySelectorAll('button').length === expectedButtonCount
        && (!cfg?.magic || old.querySelector('#mcMagicPanelAction')?.isConnected)
        && (!quickEnabled || oldQuickRow?.isConnected);
    // Keep a complete pair stable across MutationObserver callbacks.
    if (panelHealthy) return;
    if (oldQuickRow) oldQuickRow.remove();
    if (!kind || !msQuickPanelEnabled) { if (oldWrap) oldWrap.remove(); else if (old) old.remove(); return; }

    if (oldWrap) oldWrap.remove(); else if (old) old.remove();
    // The old main panel may have been rebuilt by the SPA; create one fresh pair.

    const anchor = msGetToolbarButton('Создать документ') || msGetToolbarButton('Печать');
    if (!anchor) return;
    // минимальный общий контейнер тулбара (содержит и «Создать документ», и «Печать»)
    const printBtn = msGetToolbarButton('Печать');
    let bar = anchor.parentElement;
    while (bar && bar !== document.body && !(printBtn && bar.contains(printBtn))) {
        bar = bar.parentElement;
    }
    if (!bar || bar === document.body) return;

    if (!quickEnabled) { document.getElementById('mcHackerQuickRow')?.remove(); }
    const panel = document.createElement('div');
    panel.id = 'mcQuickPanel';
    panel.dataset.kind = kind;
    panel.dataset.quickSignature = quickSignature;
    panel.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:4px 0;';

    const mkBtn = (emoji, label, menuLabel) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${emoji} ${label}`;
        b.title = `${menuLabel}: ${label}`;
        b.style.cssText = 'padding:3px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;'
            + 'color:#334155;font-size:11px;cursor:pointer;white-space:nowrap;transition:all .15s;';
        b.addEventListener('mouseenter', () => { b.style.background = '#eef2ff'; b.style.borderColor = '#6366f1'; });
        b.addEventListener('mouseleave', () => { b.style.background = '#fff'; b.style.borderColor = '#cbd5e1'; });
        b.addEventListener('click', async () => {
            panel.querySelectorAll('button').forEach(x => { x.disabled = true; x.style.opacity = '.5'; });
            await msClickMenuItem(menuLabel, label);
            panel.querySelectorAll('button').forEach(x => { x.disabled = false; x.style.opacity = '1'; });
        });
        return b;
    };

    if (cfg.magic) {
        const magic = document.createElement('button');
        magic.id = 'mcMagicPanelAction';
        magic.type = 'button';
        magic.textContent = '🪄 Заполнить';
        magic.title = 'Заполнить настроенные поля и сохранить документ';
        magic.style.cssText = 'padding:3px 8px;border:1px solid #c4b5fd;border-radius:6px;background:#f5f3ff;'
            + 'color:#6d28d9;font-size:11px;cursor:pointer;white-space:nowrap;transition:all .15s;';
        magic.addEventListener('mouseenter', () => { magic.style.background = '#ede9fe'; magic.style.borderColor = '#8b5cf6'; });
        magic.addEventListener('mouseleave', () => { magic.style.background = '#f5f3ff'; magic.style.borderColor = '#c4b5fd'; });
        magic.addEventListener('click', () => openMsMagicPopup(magic));
        panel.appendChild(magic);
    }
    cfg.create.forEach(label => panel.appendChild(mkBtn('➕', label, 'Создать документ')));
    cfg.print.forEach(label => panel.appendChild(mkBtn('🖨', label, 'Печать')));

    const wrap = document.createElement('div');
    wrap.dataset.mcQuickWrap = '1';
    wrap.appendChild(panel);

    // GWT-документы (отгрузка и пр. старого дизайна): контейнер — TABLE, тулбар
    // в строке таблицы. Вставляем панель ОТДЕЛЬНОЙ строкой TR СРАЗУ ПОСЛЕ
    // строки тулбара (не после заголовка — там панели уезжают вниз формы).
    // ВАЖНО: b-editor-toolbar содержит вложенные таблицы; ищем ВНЕШНИЙ tbody,
    // где строка тулбара — прямой ребёнок.
    const toolbarTable = bar.closest('table.b-editor-toolbar');
    const extTbody = (() => {
        if (!toolbarTable) return null;
        let row = toolbarTable.closest('tr');
        while (row && row.parentElement && row.parentElement.tagName !== 'TBODY') row = row.parentElement.closest('tr');
        return row ? row.parentElement : null;
    })();
    if (extTbody) {
        const toolbarRow = [...extTbody.children].find(r => r.contains(toolbarTable));
        if (toolbarRow) {
            wrap.style.cssText = 'display:block;width:100%;padding:2px 8px;';
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = toolbarRow.children.length || 1;
            td.appendChild(wrap);
            tr.appendChild(td);
            toolbarRow.after(tr);
            if (!quickEnabled) return;
            const quickTr = document.createElement('tr');
            const quickTd = document.createElement('td');
            quickTd.colSpan = toolbarRow.children.length || 1;
            quickTd.appendChild(buildMsHackerQuickRow(kind));
            quickTr.appendChild(quickTd);
            tr.after(quickTr);
            return;
        }
    }

    // React-документы (новый дизайн): поднимаемся до последней flex-строки
    // и вставляем обёртку (block, width:100%) её следующим соседом.
    let flexRow = bar;
    while (flexRow.parentElement && getComputedStyle(flexRow.parentElement).display === 'flex') {
        flexRow = flexRow.parentElement;
    }
    const host = flexRow.parentElement;
    if (!host) return;
    wrap.style.cssText = 'display:block;width:100%;';
    host.insertBefore(wrap, flexRow.nextSibling);
    if (!quickEnabled) return;
    const quickRow = buildMsHackerQuickRow(kind);
    quickRow.style.cssText += 'width:100%;';
    host.insertBefore(quickRow, wrap.nextSibling);
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
            setClearTextEnabled(this.checked);
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

function setClearTextEnabled(enabled) {
    clearTextEnabled = !!enabled;
    localStorage.setItem('clearTextEnabled', String(clearTextEnabled));
    const cb = document.getElementById('clearTextCheckbox');
    if (cb) cb.checked = clearTextEnabled;
    updateClearTextButton();
}

function updateClearTextButton() {
    const btn = document.getElementById('mcClearTextToggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(clearTextEnabled));
    btn.dataset.tip = clearTextEnabled
        ? '🧹 Очистка поля после Enter включена'
        : '🧹 Очистка поля после Enter выключена';
    if (clearTextEnabled) {
        btn.style.background = '#dcfce7';
        btn.style.borderColor = '#22c55e';
        btn.style.color = '#166534';
    } else {
        btn.style.background = '#f8fafc';
        btn.style.borderColor = '#e2e8f0';
        btn.style.color = '#64748b';
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
                            display: flex; flex: 0 0 auto; min-height: 32px; align-items: stretch;
                            gap: 4px; overflow-x: auto; overflow-y: visible; flex-wrap: nowrap;
                            padding: 1px 0 3px; box-sizing: border-box;
                        }
                        #mcTabs::-webkit-scrollbar { height: 3px; }
                        .mc-tab {
                            flex: 0 0 auto; min-height: 28px; height: 28px; box-sizing: border-box;
                            display: inline-flex; align-items: center; justify-content: center;
                            padding: 4px 8px; border: 1px solid #e2e8f0; border-radius: 8px;
                            background: #f8fafc; color: #475569; font-size: 11px; font-weight: 600;
                            line-height: 18px; cursor: pointer; transition: all .15s ease; white-space: nowrap;
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
            resize:both; overflow:auto;
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
                        <div id="memchatBearerStatus" style="font-size:8.5px;color:#94a3b8;margin-top:1px;"></div>
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
                <button class="mc-tab" data-tab="today" data-tip="🟢 Кто работает сегодня">🟢</button>
                <button class="mc-tab" data-tab="tomorrow" data-tip="🟡 Кто работает завтра">🟡</button>
                <button class="mc-tab" data-tab="calculator" data-tip="🧮 Калькулятор — расчёт кредита">🧮</button>
                <button class="mc-tab" data-tab="calculator_reverse" data-tip="🔄 Реверс — обратный расчёт">🔄</button>
                <button class="mc-tab" data-tab="calculator_discount" data-tip="🎉 Скидка — скидка и наценка">🎉</button>
                <button class="mc-tab" data-tab="calculator_simple" data-tip="∑ Простой — простое выражение">∑</button>
                <button class="mc-tab" data-tab="hacker" data-tip="🐱‍💻 ХатикоХакер" hidden>🐱‍💻</button>
            </div>

            <!-- ── Поле ввода ── -->
            <div id="mcInputRegion" style="position:relative;">
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

            <div id="mcSpecialPane" style="display:none;flex:1 1 auto;min-height:120px;flex-direction:column;gap:8px;overflow:hidden;"></div>

            <!-- ── Нижняя панель: статус + действия + настройки + очистка ── -->
                        <div id="mcBottomBar" style="flex:0 0 auto;display:flex;justify-content:flex-end;gap:6px;align-items:center;">
                            <span id="mcStatusBar" class="mc-status-bar">Наведите на кнопку…</span>
                            <button id="mcClearTextToggle" class="mc-action-btn" type="button" aria-pressed="false" data-tip="🧹 Очищать активное поле после Enter">🧹</button>
                            <button id="mcActionSettings" class="mc-action-btn" type="button" data-tip="⚙️ Настройки">⚙️</button>
                            <button id="mcClearChatButton" class="mc-btn-clear" type="button" data-tip="🗑 Очистить историю этой вкладки">🗑</button>
                        </div>
                    `;

        document.body.appendChild(container);
        window.priceCheckContainer = container;
        document.getElementById('memchatVersion').textContent = `v${MEMCHAT_VERSION}${typeof MEMCHAT_BUILD !== 'undefined' ? `-${MEMCHAT_BUILD}` : ''}`;
        hackerValidateApiKey(() => hackerSyncAccessUi());
        setupEventListeners();
        updateClearTextButton();
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
        retryBehavior,
        msQuickPanelEnabled,
        msMagicConfig,
        hackerOrderNotifier: hackerNotifierSettings
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
    if (['append', 'replace'].includes(data.retryBehavior)) {
        saveRetryBehavior(data.retryBehavior);
        const sel = document.getElementById('retryBehavior');
        if (sel) sel.value = data.retryBehavior;
    }
    if (Array.isArray(data.hiddenFields)) {
        // Старые настройки выборочного скрытия больше не применяются: теперь
        // дополнительные поля открываются единым спойлером штатного блока.
        hiddenFields = [];
        saveHiddenFields();
        restoreMsFields();
        document.getElementById('mcMsRevealBtn')?.remove();
    }
    if (typeof data.msQuickPanelEnabled === 'boolean') {
        msQuickPanelEnabled = data.msQuickPanelEnabled;
        saveMsQuickPanelEnabled();
        const cb = document.getElementById('msQuickPanelCheckbox');
        if (cb) cb.checked = msQuickPanelEnabled;
        buildMsQuickPanel();
    }
    if (data.msMagicConfig && typeof data.msMagicConfig === 'object') {
        try {
            saveMsMagicConfig(data.msMagicConfig);
            const magicArea = document.getElementById('msMagicConfigJson');
            if (magicArea) magicArea.value = JSON.stringify(msMagicConfig, null, 2);
        } catch (error) {
            setStatusText(`⚠️ JSON 🪄: ${error.message}`);
            return false;
        }
    }
    if (data.hackerOrderNotifier && typeof data.hackerOrderNotifier === 'object') {
        hackerNotifierSettings = hackerNotifierNormalizeSettings(data.hackerOrderNotifier);
        hackerNotifierStatusSelectionInitialized = true;
        hackerNotifierSaveSettings();
        hackerNotifierFillControls();
        hackerNotifierMaybeStart();
    }

    const area = document.getElementById('mcImportArea');
    const actions = document.getElementById('mcImportActions');
    if (area) { area.style.display = 'none'; area.value = ''; area.style.borderColor = '#cbd5e1'; area.style.borderWidth = '1px'; }
    if (actions) actions.style.display = 'none';
    setStatusText('✅ Настройки импортированы');
    return true;
}

function renderHackerInlineTab() {
    const host = document.getElementById('mcSpecialPane');
    if (!host || currentAction !== 'hacker') return;
    host.replaceChildren();

    const tabs = document.createElement('div');
    tabs.id = 'hackerTabs';
    tabs.style.cssText = 'display:flex;gap:4px;flex:0 0 auto;';
    [['status', 'Статус'], ['agent', 'Контрагент'], ['sale', 'Автопродажа'], ['notifier', 'Новые заказы'], ['internalOrderCheck', 'Проверка товаров']].forEach(([key, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.dataset.hackerTab = key;
        btn.style.cssText = 'flex:1;padding:5px 4px;border:1px solid #e2e8f0;border-radius:8px;'
            + 'background:#f8fafc;color:#475569;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;';
        btn.addEventListener('click', () => hackerSelectTab(key));
        tabs.appendChild(btn);
    });
    host.appendChild(tabs);

    const panes = document.createElement('div');
    panes.id = 'hackerTabPanes';
    panes.style.cssText = 'flex:0 0 auto;';
    host.appendChild(panes);

    const logLabel = hackerEl('div', 'font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;'
        + 'letter-spacing:.8px;margin-top:4px;', 'Консоль');
    host.appendChild(logLabel);
    const logBox = document.createElement('div');
    logBox.id = 'hackerLogBox';
    logBox.style.cssText = 'flex:1 1 auto;min-height:90px;overflow-y:auto;background:#0f172a;border-radius:10px;'
        + 'padding:7px;font-size:10.5px;line-height:1.5;font-family:Consolas,monospace;';
    host.appendChild(logBox);

    hackerSelectTab(hackerTab);
    hackerRenderLog();
    hackerEnsureStates(true);
    if (/online\.moysklad\.ru$/.test(location.hostname)) hackerLoadOpenOrder(true);
}

// ─── Окно «ХатикоХакер» (старый совместимый способ открытия) ──────────────────
function openHackerWindow() {
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

    const tabs = document.createElement('div');
    tabs.id = 'hackerTabs';
    tabs.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;';
    const HACKER_TABS = [
        ['status', 'Статус'],
        ['agent', 'Контрагент'],
        ['sale', 'Автопродажа'],
        ['notifier', 'Новые заказы'],
        ['internalOrderCheck', 'Проверка товаров']
    ];
    HACKER_TABS.forEach(([key, label], i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.dataset.hackerTab = key;
        btn.style.cssText = 'flex:1;padding:5px 4px;border:1px solid #e2e8f0;border-radius:8px;'
            + 'background:#f8fafc;color:#475569;font-size:11px;font-weight:600;cursor:pointer;'
            + 'transition:all .15s;white-space:nowrap;';
        btn.addEventListener('click', () => hackerSelectTab(key));
        tabs.appendChild(btn);
    });
    body.appendChild(tabs);

    const panes = document.createElement('div');
    panes.id = 'hackerTabPanes';
    body.appendChild(panes);

    // Консоль внизу
    const logLabel = hackerEl('div', 'font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;'
        + 'letter-spacing:.8px;margin:10px 0 4px;', 'Консоль');
    body.appendChild(logLabel);
    const logBox = document.createElement('div');
    logBox.id = 'hackerLogBox';
    logBox.style.cssText = 'height:120px;overflow-y:auto;background:#0f172a;border-radius:10px;'
        + 'padding:7px;font-size:10.5px;line-height:1.5;font-family:Consolas,monospace;';
    body.appendChild(logBox);

    win.appendChild(body);
    document.body.appendChild(win);
    makeMovable(win, header);

    hackerSelectTab(hackerTab);
    hackerRenderLog();
    hackerEnsureStates(true);
    if (/online\.moysklad\.ru$/.test(location.hostname)) hackerLoadOpenOrder(true);
}

// Переключение вкладок Хакера (панели строятся в 11-hacker.js)
function hackerSelectTab(key) {
    hackerTab = key;
    const tabsEl = document.getElementById('hackerTabs');
    if (tabsEl) {
        tabsEl.querySelectorAll('[data-hacker-tab]').forEach(t => {
            const active = t.dataset.hackerTab === key;
            t.style.background = active ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : '#f8fafc';
            t.style.color = active ? '#fff' : '#475569';
            t.style.borderColor = active ? 'transparent' : '#e2e8f0';
        });
    }
    const panes = document.getElementById('hackerTabPanes');
    if (!panes) return;
    panes.innerHTML = '';
    let pane = null;
    if (key === 'status') pane = hackerBuildStatusTab();
    else if (key === 'agent') pane = hackerBuildAgentTab();
    else if (key === 'sale') pane = hackerBuildSaleTab();
    else if (key === 'notifier') pane = hackerBuildNotifierTab();
    else if (key === 'internalOrderCheck') pane = hackerBuildInternalOrderCheckTab();
    if (pane) panes.appendChild(pane);

    // Справочники загружаются при открытии соответствующей вкладки.
    if (key === 'status') hackerEnsureStates(true);
    if (key === 'sale') {
        hackerRefreshClientStatuses(true);
        hackerRefreshPayMethods(true);
        hackerRefreshSalesChannels(true);
        hackerLoadOpenOrder(true);
    }
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
        <label style="display:block;color:#475569;font-size:12px;margin-top:10px;">
            Поведение кнопки 🔁:
            <select id="retryBehavior" style="display:block;width:100%;margin-top:5px;padding:5px;background:#fff;border:1px solid #cbd5e1;border-radius:6px;color:#334155;">
                <option value="append">Не удалять старый ответ</option>
                <option value="replace">Удалять старый ответ и повторять</option>
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
        <label style="display:flex;align-items:center;gap:8px;color:#475569;font-size:12px;margin-bottom:10px;cursor:pointer;">
            <input type="checkbox" id="msQuickPanelCheckbox" style="accent-color:#6366f1;width:14px;height:14px;">
            Панель быстрых кнопок (МойСклад)
        </label>

        <div style="height:8px;"></div>
        <label style="display:flex;align-items:center;gap:8px;color:#475569;font-size:12px;margin-bottom:10px;cursor:pointer;">
            <input type="checkbox" id="msBearerCheckbox" style="accent-color:#6366f1;width:14px;height:14px;">
            Bearer-ключ API МойСклад
        </label>
        <input type="text" id="msBearerToken" placeholder="API-ключ МойСклад (Bearer)…" spellcheck="false"
            style="display:none;width:100%;padding:5px 7px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;outline:none;box-sizing:border-box;margin-bottom:10px;">

        <button id="msMagicSettingsBtn" class="mc-btn mc-btn-slate" style="width:100%;">🪄 Автозаполнение документов (JSON)</button>
        <div id="msMagicSettingsPanel" class="mc-panel" style="display:none;max-height:none;">
            <div style="font-size:10.5px;color:#64748b;margin-bottom:6px;line-height:1.4;">
                demand — Отгрузка, cashin — Приходный ордер, paymentin — Входящий платёж.<br>
                copies копирует значение между одинаковыми полями; values задаёт точное значение из списка МойСклад.
            </div>
            <textarea id="msMagicConfigJson" spellcheck="false" style="width:100%;height:210px;padding:7px;box-sizing:border-box;resize:vertical;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;font:10px Consolas,monospace;"></textarea>
            <button id="msMagicConfigSave" class="mc-btn mc-btn-green" style="width:100%;margin-top:6px;">Сохранить JSON</button>
            <div id="msMagicConfigStatus" style="min-height:16px;margin-top:5px;font-size:10.5px;color:#64748b;"></div>
        </div>

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
    const retrySelect = document.getElementById('retryBehavior');
    if (retrySelect) {
        retrySelect.value = retryBehavior;
        retrySelect.addEventListener('change', () => saveRetryBehavior(retrySelect.value));
    }
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
    const msQuickCb = document.getElementById('msQuickPanelCheckbox');
    if (msQuickCb) {
        msQuickCb.checked = msQuickPanelEnabled;
        msQuickCb.addEventListener('change', () => {
            msQuickPanelEnabled = msQuickCb.checked;
            saveMsQuickPanelEnabled();
            buildMsQuickPanel();
        });
    }
    const defaultChannel = document.getElementById('hackerDefaultChannel');
    if (defaultChannel) {
        defaultChannel.value = hackerDefaultChannel;
        hackerRefreshSalesChannels(true).then(() => {
            hackerSalesChannels.forEach(item => {
                const option = document.createElement('option'); option.value = item.href; option.textContent = item.name; defaultChannel.appendChild(option);
            });
            defaultChannel.value = hackerDefaultChannel;
        });
        defaultChannel.addEventListener('change', () => { hackerDefaultChannel = defaultChannel.value; localStorage.setItem(storageKey('hackerDefaultChannel_v1'), hackerDefaultChannel); });
    }
    const quickCb = document.getElementById('hackerQuickButtonsCheckbox');
    if (quickCb) { quickCb.checked = hackerQuickButtonsEnabled; quickCb.addEventListener('change', () => { hackerQuickButtonsEnabled = quickCb.checked; localStorage.setItem(storageKey('hackerQuickButtons_v1'), String(hackerQuickButtonsEnabled)); buildMsQuickPanel(); }); }
    const magicArea = document.getElementById('msMagicConfigJson');
    const magicStatus = document.getElementById('msMagicConfigStatus');
    if (magicArea) magicArea.value = JSON.stringify(msMagicConfig, null, 2);
    document.getElementById('msMagicSettingsBtn')?.addEventListener('click', () => togglePanel('msMagicSettingsPanel'));
    document.getElementById('msMagicConfigSave')?.addEventListener('click', () => {
        try {
            const parsed = JSON.parse(magicArea?.value || '');
            saveMsMagicConfig(parsed);
            if (magicArea) magicArea.value = JSON.stringify(msMagicConfig, null, 2);
            if (magicStatus) { magicStatus.textContent = '✅ Сохранено'; magicStatus.style.color = '#16a34a'; }
            reconcileMsEnhancements();
        } catch (error) {
            if (magicStatus) { magicStatus.textContent = `❌ Ошибка: ${error.message}`; magicStatus.style.color = '#dc2626'; }
        }
    });
    const bearerCb = document.getElementById('msBearerCheckbox');
    const bearerInp = document.getElementById('msBearerToken');
    if (bearerCb && bearerInp) {
        bearerCb.checked = hackerBearerEnabled;
        bearerInp.style.display = hackerBearerEnabled ? 'block' : 'none';
        bearerInp.value = hackerBearerToken;
        bearerCb.addEventListener('change', () => hackerSetBearerEnabled(bearerCb.checked));
        bearerInp.addEventListener('input', () => hackerSetBearerToken(bearerInp.value));
    }
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
    today: '🟢 Сегодня',
    tomorrow: '🟡 Завтра',
    hacker: '🐱‍💻 ХатикоХакер',
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
            document.getElementById('mcClearTextToggle').addEventListener('click', () => {
                setClearTextEnabled(!clearTextEnabled);
            });
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

        const special = document.getElementById('mcSpecialPane');
        const input = document.getElementById('mcInputRegion');
        const result = document.getElementById('mcResultRegion');
        const isSchedule = tab === 'today' || tab === 'tomorrow';
        const isSpecial = isSchedule || tab === 'hacker';
        if (special) special.style.display = isSpecial ? 'flex' : 'none';
        if (input) input.style.display = isSpecial ? 'none' : 'block';
        if (result) result.style.display = isSpecial ? 'none' : 'flex';
        if (isSchedule) renderScheduleTab(tab);
        else if (tab === 'hacker') renderHackerInlineTab();
        else renderChat();
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
    document.querySelectorAll('.mc-float-window, .mc-overlay, #mcHackerQuickPopup, #mcHackerAgentPopup, #mcHackerFloatingLog').forEach(el => el.remove());
}

function initialize() {
    installDebugHandlers();
    loadCalcRules();
    loadScheduleReplacements();
    loadChatHistory();
    setupGlobalClearTextFunctionality();
    loadHiddenFields();
    if (hiddenFields.length) { hiddenFields = []; saveHiddenFields(); }
    loadMsQuickPanelEnabled();
    retryBehavior = loadRetryBehavior();
    hackerLoadSettings();
    loadMsMagicConfig();
    try {
        hackerDefaultChannel = localStorage.getItem(storageKey('hackerDefaultChannel_v1')) || '';
        hackerQuickButtonsEnabled = localStorage.getItem(storageKey('hackerQuickButtons_v1')) !== 'false';
    } catch { /* defaults */ }
    startPanelBridgeListener();
    schedulePanelCsrfRefresh();
    GM_registerMenuCommand('Открыть мемный чат', createPriceCheckWindow);
        GM_registerMenuCommand('Закрыть мемный чат', closeChatWindow);
        GM_registerMenuCommand('Сбросить положение окон', resetFloatWindowPos);
        GM_registerMenuCommand('Переключить отладку мемного чата', toggleDebugMode);
    debugLog('init', 'initialized');
    console.log('Мемный чат v8.2.8-beta инициализирован');

    // Один наблюдатель обслуживает все контекстные встройки и SPA-переходы.
    if (/online\.moysklad\.ru$/.test(location.hostname)) {
        restoreMsFields(); // миграция со старого режима выборочного скрытия
        document.getElementById('mcMsRevealBtn')?.remove();
        startMsSpaObserver();
        if (hackerBearerEnabled && hackerBearerToken.trim()) hackerValidateApiKey();
    }
}

/* ===== 11-hacker.js ===== */

// ─── ХатикоХакер (МойСклад API) ───────────────────────────────────────────────
// Плавающее окно: вкладки «Статус», «Контрагент», «Автопродажа» + консоль-лог внизу.
// Транспорт: GM_xmlhttpRequest → https://api.moysklad.ru/api/remap/1.2/
// Авторизация: Bearer-ключ из настроек (по умолчанию выкл — тогда cookies сессии).

const MS_API_BASE = 'https://api.moysklad.ru/api/remap/1.2';

let hackerTab            = 'status';
let hackerLogLines       = [];
let hackerStates         = [];  // [{name, href}] — статусы заказов покупателей
let hackerClientStatuses = [];  // [{name, href}] — атрибут cashin «Статус клиента»
let hackerPayMethods     = [];  // [{name, href}] — атрибут paymentin «Способ оплаты»
let hackerSalesChannels  = [];  // [{name, href}]
let hackerOrderInfo      = null;
let hackerLastDemand     = null;
let hackerContext        = { customerOrderId: '', demandId: '' };
let hackerBusy           = false;

const HACKER_ATTR_CLIENT_STATUS = 'Статус клиента';
const HACKER_ATTR_PAY_METHOD    = 'Способ оплаты';
const HACKER_ATTR_PAY_TYPE      = 'Тип оплаты';
const HACKER_CASH_PAY_NAME       = 'Наличными';

// ─── Настройки API-ключа (localStorage) ───────────────────────────────────────
function hackerLoadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(storageKey('hackerMsApi_v1')) || '{}');
        hackerBearerEnabled = !!s.bearerEnabled;
        hackerBearerToken = typeof s.token === 'string' ? s.token : '';
    } catch {
        hackerBearerEnabled = false;
        hackerBearerToken = '';
    }
    hackerLoadCachedStates();
    hackerNotifierLoadSettings();
}

function hackerLoadCachedStates() {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey('hackerStates_v1')) || '[]');
        hackerStates = Array.isArray(saved)
            ? saved.filter(state => state && typeof state.name === 'string' && typeof state.href === 'string' && state.name && state.href)
                .map(state => ({ name: state.name, href: state.href, color: state.color }))
            : [];
    } catch (error) {
        hackerStates = [];
        debugError('hacker', 'Не удалось загрузить кэш статусов', error);
    }
    return hackerStates;
}

function hackerSaveStates() {
    try {
        localStorage.setItem(storageKey('hackerStates_v1'), JSON.stringify(hackerStates));
    } catch (error) {
        debugError('hacker', 'Не удалось сохранить кэш статусов', error);
    }
}

function hackerSaveSettings() {
    try {
        localStorage.setItem(storageKey('hackerMsApi_v1'), JSON.stringify({
            bearerEnabled: hackerBearerEnabled,
            token: hackerBearerToken
        }));
    } catch (error) {
        debugError('hacker', 'Не удалось сохранить настройки API', error);
    }
}

// Вызывается из окна настроек (09)
function hackerSetBearerEnabled(enabled) {
    hackerBearerEnabled = !!enabled;
    hackerApiValidated = false;
    hackerSaveSettings();
    const inp = document.getElementById('msBearerToken');
    if (inp) inp.style.display = hackerBearerEnabled ? 'block' : 'none';
    hackerSyncAccessUi();
}

function hackerSyncAccessUi() {
    const allowed = hackerBearerEnabled && !!hackerBearerToken.trim() && hackerApiValidated;
    const tab = document.querySelector('#mcTabs [data-tab="hacker"]');
    if (tab) tab.hidden = !allowed;
    if (!allowed && currentAction === 'hacker' && document.getElementById('mcTabs')) {
        selectTab('checkHatiko');
    }
    if (typeof reconcileMsEnhancements === 'function') reconcileMsEnhancements();
}

function hackerUpdateBearerStatus(code, text) {
    const el = document.getElementById('memchatBearerStatus');
    if (!el) return;
    el.textContent = hackerBearerEnabled ? `Bearer: ${code}${text ? ` — ${text}` : ''}` : '';
    el.style.color = code >= 200 && code < 300 ? '#16a34a' : '#dc2626';
}

function hackerValidateApiKey(onDone) {
    if (!hackerBearerEnabled || !hackerBearerToken.trim()) {
        hackerApiValidated = false;
        hackerUpdateBearerStatus('—', 'выкл');
        hackerSyncAccessUi();
        onDone?.(false);
        return;
    }
    msApi('GET', '/entity/customerorder/metadata', null, response => {
        hackerApiValidated = true;
        const states = Array.isArray(response?.states) ? response.states : (response?.states?.rows || []);
        hackerStates = states.map(state => ({
            name: state.name,
            href: state.meta?.href,
            color: state.color,
        })).filter(state => state.name && state.href);
        hackerSaveStates();
        hackerUpdateBearerStatus(response?._status || 200, 'валиден');
        hackerSyncAccessUi();
        hackerNotifierMaybeStart();
        onDone?.(true);
    }, error => {
        hackerApiValidated = false;
        hackerNotifierStop();
        hackerUpdateBearerStatus(error?.status || 401, 'ошибка');
        hackerSyncAccessUi();
        onDone?.(false);
    });
}

function hackerCanRun(onDenied) {
    if (!hackerBearerEnabled || !hackerBearerToken.trim() || !hackerApiValidated) {
        hackerValidateApiKey(ok => {
            if (!ok) {
                hackerLog('Включите Bearer и укажите действующий API-ключ МойСклад', 'warn');
                onDenied?.();
            }
        });
        return false;
    }
    return true;
}

function hackerSetBearerToken(value) {
    hackerBearerToken = String(value || '');
    hackerApiValidated = false;
    hackerSaveSettings();
    hackerSyncAccessUi();
}

// ─── Транспорт ────────────────────────────────────────────────────────────────
function hackerEnsureBearer() {
    if (!hackerBearerEnabled || !hackerBearerToken.trim()) {
        throw new Error('Включите Bearer и укажите API-ключ МойСклад');
    }
}

function msApi(method, path, body, onSuccess, onError) {
    try { hackerEnsureBearer(); }
    catch (error) { onError(error); return; }
    const headers = { 'Accept': 'application/json;charset=utf-8' };
    if (body) headers['Content-Type'] = 'application/json;charset=utf-8';
    headers['Authorization'] = 'Bearer ' + hackerBearerToken.trim();
    GM_xmlhttpRequest({
        method,
        url: MS_API_BASE + path,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 30000,
        anonymous: false,
        onload: response => {
            const raw = response.responseText || '';
            let data = null;
            try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* не JSON */ }
            if (response.status >= 200 && response.status < 300) {
                if (data && typeof data === 'object') data._status = response.status;
                onSuccess(data);
            } else {
                const apiMsg = data && data.errors && data.errors[0]
                    ? (data.errors[0].error || data.errors[0].parameter || data.errors[0].code || JSON.stringify(data.errors[0]))
                    : '';
                let msg = apiMsg || ('HTTP ' + response.status);
                if (response.status === 401 && !hackerBearerEnabled) {
                    msg += ' — включите «Bearer-ключ API» в настройках и вставьте API-ключ';
                }
                const err = new Error(msg); err.status = response.status; onError(err);
            }
        },
        onerror: () => onError(new Error('Ошибка сети (api.moysklad.ru)')),
        ontimeout: () => onError(new Error('Таймаут запроса к api.moysklad.ru'))
    });
}

function msApiP(method, path, body) {
    return new Promise((resolve, reject) => msApi(method, path, body, resolve, reject));
}

// ─── Консоль-лог ──────────────────────────────────────────────────────────────
function hackerLog(msg, kind) {
    hackerLogLines.push({ time: new Date(), msg: String(msg), kind: kind || 'info' });
    if (hackerLogLines.length > 300) hackerLogLines.shift();
    hackerRenderLog();
    hackerRenderFloatingLog();
}

function hackerRenderFloatingLog() {
    const box = document.getElementById('mcHackerFloatingLog');
    if (!box) return;
    const body = box.querySelector('[data-hacker-floating-body]');
    if (!body) return;
    body.textContent = hackerLogLines.slice(-8).map(entry => {
        const t = entry.time.toTimeString().slice(0, 8);
        return `[${t}] ${entry.msg}`;
    }).join('\n');
    body.scrollTop = body.scrollHeight;
}

function hackerEnsureFloatingLog() {
    let box = document.getElementById('mcHackerFloatingLog');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'mcHackerFloatingLog';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483002;width:310px;background:#0f172a;color:#cbd5e1;border:1px solid #475569;border-radius:9px;box-shadow:0 8px 30px #0005;font:10px Consolas,monospace;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid #334155;color:#f8fafc;font:600 11px Segoe UI,sans-serif;';
    head.textContent = 'ХатикоХакер — статус';
    const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'border:0;background:transparent;color:#cbd5e1;cursor:pointer;'; close.onclick = () => box.remove();
    head.appendChild(close); box.appendChild(head);
    const body = document.createElement('pre'); body.dataset.hackerFloatingBody = '1'; body.style.cssText = 'margin:0;padding:7px 8px;height:100px;overflow:auto;white-space:pre-wrap;';
    box.appendChild(body); document.body.appendChild(box); hackerRenderFloatingLog(); return box;
}

function hackerRenderLog() {
    const box = document.getElementById('hackerLogBox');
    if (!box) return;
    box.innerHTML = '';
    const colors = { info: '#94a3b8', ok: '#4ade80', err: '#f87171', warn: '#fbbf24' };
    hackerLogLines.forEach(entry => {
        const line = document.createElement('div');
        const t = entry.time.toTimeString().slice(0, 8);
        line.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
        line.style.color = colors[entry.kind] || colors.info;
        line.textContent = `[${t}] ${entry.msg}`;
        box.appendChild(line);
    });
    box.scrollTop = box.scrollHeight;
}

// ─── Вспомогательные ──────────────────────────────────────────────────────────
// Открытая карточка: заказ покупателя или отгрузка
function hackerOpenDoc() {
    const m = (location.hash || '').match(/^#(customerorder|demand)\/edit\?id=([0-9a-fA-F-]+)/);
    return m ? { type: m[1], id: m[2] } : null;
}

function hackerEl(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
}

function hackerBtn(id, label, css) {
    const b = hackerEl('button', css || '', label);
    b.type = 'button';
    b.id = id;
    return b;
}

const HACKER_SELECT_CSS = 'flex:1;padding:4px 6px;background:#fff;border:1px solid #cbd5e1;'
    + 'border-radius:7px;color:#334155;font-size:11px;outline:none;min-width:0;';
const HACKER_INPUT_CSS = 'width:100%;padding:4px 7px;background:#fff;border:1px solid #cbd5e1;'
    + 'border-radius:7px;color:#334155;font-size:11.5px;outline:none;box-sizing:border-box;';
const HACKER_BTN_CSS = 'padding:5px 10px;border:none;border-radius:7px;color:#fff;font-size:11px;'
    + 'cursor:pointer;font-weight:600;transition:filter .15s;';
const HACKER_MINI_BTN_CSS = 'padding:4px 8px;background:#fff;border:1px solid #cbd5e1;'
    + 'border-radius:7px;color:#475569;font-size:11px;cursor:pointer;font-weight:700;';

function hackerSelect(id, placeholder) {
    const sel = document.createElement('select');
    sel.id = id;
    sel.style.cssText = HACKER_SELECT_CSS;
    if (placeholder) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = placeholder;
        sel.appendChild(opt);
    }
    return sel;
}

function hackerFillSelect(sel, items, keepEmptyPlaceholder) {
    // Ответ API может прийти после переключения вкладки: старый select уже удалён.
    if (!sel || !sel.isConnected) return false;
    const placeholder = keepEmptyPlaceholder ? sel.querySelector('option[value=""]') : null;
    sel.innerHTML = '';
    if (placeholder) sel.appendChild(placeholder);
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.href;
        opt.textContent = item.name;
        sel.appendChild(opt);
    });
}

// ─── Открытый заказ: загрузка и предзаполнение ────────────────────────────────
function hackerLoadOpenOrder(quiet) {
    const doc = hackerOpenDoc();
    if (!doc || doc.type !== 'customerorder') {
        if (!quiet) hackerLog('Откройте карточку заказа покупателя', 'warn');
        return Promise.resolve(null);
    }
    return msApiP('GET', '/entity/customerorder/' + doc.id + '?expand=positions.assortment')
        .then(order => {
            hackerOrderInfo = order;
            hackerLog(`Заказ ${order.name}: сумма ${(order.sum / 100).toFixed(2)} ₽, статус: ${order.state?.name || '—'}`);
            // Предзаполнение сумм и канала
            const sumStr = (order.sum / 100).toFixed(2);
            ['hackerCashinSum', 'hackerPayinSum'].forEach(id => {
                const inp = document.getElementById(id);
                if (inp && !inp.value.trim()) inp.value = sumStr;
            });
            if (order.salesChannel && order.salesChannel.meta) {
                const sel = document.getElementById('hackerChannelSelect');
                if (sel) {
                    const href = order.salesChannel.meta.href;
                    if (![...sel.options].some(o => o.value === href)) {
                        const opt = document.createElement('option');
                        opt.value = href;
                        opt.textContent = order.salesChannel.name || '(канал заказа)';
                        sel.appendChild(opt);
                    }
                    sel.value = href;
                }
            }
            return order;
        })
        .catch(error => {
            hackerLog('Не удалось загрузить заказ: ' + error.message, 'err');
            return null;
        });
}

// ─── Вкладка «Статус» ─────────────────────────────────────────────────────────
function hackerRefreshStates(quiet) {
    return msApiP('GET', '/entity/customerorder/metadata')
        .then(meta => {
            const states = Array.isArray(meta.states) ? meta.states : (meta.states?.rows || []);
            hackerStates = states.map(s => ({
                name: s.name,
                href: s.meta?.href
            })).filter(s => s.href);
            hackerSaveStates();
            hackerFillSelect(document.getElementById('hackerStateSelect'), hackerStates);
            if (!quiet) hackerLog(`Статусы обновлены: ${hackerStates.length} шт.`, 'ok');
        })
        .catch(error => hackerLog('Статусы: ' + error.message, 'err'));
}

function hackerEnsureStates(quiet) {
    if (hackerStates.length) {
        hackerFillSelect(document.getElementById('hackerStateSelect'), hackerStates);
        return Promise.resolve(hackerStates);
    }
    return hackerRefreshStates(quiet).then(() => hackerStates);
}

function hackerUpdateOrderStatus(orderId, stateHref) {
    hackerEnsureBearer();
    return msApiP('PUT', `/entity/customerorder/${orderId}`, {
        state: { meta: { href: stateHref, type: 'state', mediaType: 'application/json' } },
    });
}

function hackerApplyStatus() {
    const doc = hackerOpenDoc();
    if (!doc || doc.type !== 'customerorder') {
        hackerLog('Откройте карточку заказа покупателя', 'warn');
        return;
    }
    const sel = document.getElementById('hackerStateSelect');
    const href = sel ? sel.value : '';
    if (!href) {
        hackerLog('Выберите статус (или обновите список)', 'warn');
        return;
    }
    const stateName = hackerStates.find(s => s.href === href)?.name || '';
    msApi('PUT', '/entity/customerorder/' + doc.id, {
        state: { meta: { href, type: 'state' } }
    }, () => {
        hackerLog(`✅ Статус изменён: ${stateName}`, 'ok');
    }, error => hackerLog('Статус: ' + error.message, 'err'));
}

function hackerBuildStatusTab() {
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabStatus';

    const row = hackerEl('div', 'display:flex;gap:4px;margin-bottom:6px;');
    row.appendChild(hackerSelect('hackerStateSelect', '— обновите список —'));
    const refresh = hackerBtn('hackerStatesRefresh', '⟳', HACKER_MINI_BTN_CSS);
    refresh.title = 'Обновить список статусов';
    refresh.addEventListener('click', () => hackerRefreshStates(false));
    row.appendChild(refresh);
    wrap.appendChild(row);

    const apply = hackerBtn('hackerStatusApply', 'Поменять статус',
        HACKER_BTN_CSS + 'background:linear-gradient(135deg,#3b82f6,#2563eb);width:100%;');
    apply.addEventListener('click', hackerApplyStatus);
    wrap.appendChild(apply);
    return wrap;
}

// ─── Вкладка «Контрагент» ─────────────────────────────────────────────────────
function hackerNormalizePhoneVariants(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return [];
    const variants = [digits];
    if (digits.length === 11 && digits[0] === '8') variants.push('7' + digits.slice(1));
    if (digits.length === 11 && digits[0] === '7') variants.push('8' + digits.slice(1));
    if (digits.length === 10) variants.push('7' + digits);
    return [...new Set(variants)];
}

function hackerFindAgentByPhone(raw) {
    const variants = hackerNormalizePhoneVariants(raw);
    const tryNext = (i) => {
        if (i >= variants.length) return Promise.resolve([]);
        return msApiP('GET', '/entity/counterparty?filter=phone=' + variants[i])
            .then(data => (data.rows && data.rows.length) ? data.rows : tryNext(i + 1))
            .catch(() => tryNext(i + 1));
    };
    return tryNext(0);
}

function hackerCreateAgent(name, phone) {
    return msApiP('POST', '/entity/counterparty', { name, phone });
}

function hackerAssignAgent(agentHref) {
    const doc = hackerOpenDoc();
    if (!doc) {
        hackerLog('Откройте карточку заказа или отгрузки', 'warn');
        return Promise.reject(new Error('нет открытого документа'));
    }
    return msApiP('PUT', '/entity/' + doc.type + '/' + doc.id, {
        agent: {
            meta: {
                href: agentHref,
                type: 'counterparty',
                mediaType: 'application/json'
            }
        }
    });
}

function hackerAgentCreateClick() {
    const phone = document.getElementById('hackerAgentPhone')?.value.trim();
    const name = document.getElementById('hackerAgentName')?.value.trim();
    const checkFirst = document.getElementById('hackerAgentCheckCreate')?.checked;
    const createAndAssign = document.getElementById('hackerAgentCreateAssign')?.checked;
    if (!phone) { hackerLog('Введите номер телефона', 'warn'); return; }
    if (!name) { hackerLog('Введите ФИО (наименование контрагента)', 'warn'); return; }

    const doCreate = () => hackerCreateAgent(name, phone)
        .then(agent => {
            hackerLog(`✅ Контрагент создан: ${agent.name}`, 'ok');
            if (createAndAssign) {
                return hackerAssignAgent(agent.meta.href)
                    .then(() => hackerLog('✅ Привязан к документу', 'ok'))
                    .catch(error => hackerLog('Привязка: ' + error.message, 'err'));
            }
        })
        .catch(error => hackerLog('Создание: ' + error.message, 'err'));

    if (checkFirst) {
        hackerLog('Ищу контрагента по номеру…');
        hackerFindAgentByPhone(phone).then(rows => {
            if (rows.length) {
                const a = rows[0];
                hackerLog(`Найден: ${a.name} (телефон ${a.phone || '—'})`, 'warn');
                if (createAndAssign) {
                    hackerAssignAgent(a.meta.href)
                        .then(() => hackerLog('✅ Привязан к документу', 'ok'))
                        .catch(error => hackerLog('Привязка: ' + error.message, 'err'));
                } else {
                    hackerLog('Создание не требуется', 'info');
                }
                return;
            }
            doCreate();
        });
    } else {
        doCreate();
    }
}

function hackerAgentCheckClick() {
    const phone = document.getElementById('hackerAgentPhone')?.value.trim();
    if (!phone) { hackerLog('Введите номер телефона', 'warn'); return; }
    hackerLog('Проверяю контрагента по номеру…');
    hackerFindAgentByPhone(phone).then(rows => {
        if (!rows.length) {
            hackerLog('Контрагент по этому номеру не найден', 'warn');
            return;
        }
        rows.forEach((agent, index) => {
            hackerLog(`Найден ${index + 1}: ${agent.name || 'без имени'} — ${agent.phone || phone}`, 'ok');
        });
    }).catch(error => hackerLog('Проверка: ' + error.message, 'err'));
}

function hackerAgentAssignClick() {
    const phone = document.getElementById('hackerAgentPhone')?.value.trim();
    if (!phone) { hackerLog('Введите номер телефона', 'warn'); return; }
    hackerFindAgentByPhone(phone).then(rows => {
        if (!rows.length) {
            hackerLog('Контрагент по этому номеру не найден', 'err');
            return;
        }
        const a = rows[0];
        hackerAssignAgent(a.meta.href)
            .then(() => hackerLog(`✅ Контрагент заменён: ${a.name}`, 'ok'))
            .catch(error => hackerLog('Замена: ' + error.message, 'err'));
    });
}

function hackerBuildAgentTab() {
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabStatus_Agent';

    const lblPhone = hackerEl('div', 'font-size:10px;font-weight:700;color:#64748b;margin-bottom:3px;', 'Номер телефона');
    wrap.appendChild(lblPhone);
    const phone = hackerEl('input');
    phone.id = 'hackerAgentPhone';
    phone.type = 'text';
    phone.placeholder = '+7 900 000-00-00';
    phone.style.cssText = HACKER_INPUT_CSS + 'margin-bottom:6px;';
    wrap.appendChild(phone);

    const lblName = hackerEl('div', 'font-size:10px;font-weight:700;color:#64748b;margin-bottom:3px;', 'ФИО (наименование)');
    wrap.appendChild(lblName);
    const name = hackerEl('input');
    name.id = 'hackerAgentName';
    name.type = 'text';
    name.placeholder = 'Иванов Иван Иванович';
    name.style.cssText = HACKER_INPUT_CSS + 'margin-bottom:6px;';
    wrap.appendChild(name);

    const row = hackerEl('div', 'display:flex;gap:5px;margin-bottom:8px;');
    const check = hackerBtn('hackerAgentCheck', 'Проверить',
        HACKER_BTN_CSS + 'background:linear-gradient(135deg,#64748b,#475569);flex:1;');
    check.addEventListener('click', hackerAgentCheckClick);
    const assign = hackerBtn('hackerAgentAssign', 'Поменять',
        HACKER_BTN_CSS + 'background:linear-gradient(135deg,#3b82f6,#2563eb);flex:1;');
    assign.addEventListener('click', hackerAgentAssignClick);
    const create = hackerBtn('hackerAgentCreate', 'Создать',
        HACKER_BTN_CSS + 'background:linear-gradient(135deg,#22c55e,#16a34a);flex:1;');
    create.addEventListener('click', hackerAgentCreateClick);
    row.appendChild(check);
    row.appendChild(assign);
    row.appendChild(create);
    wrap.appendChild(row);

    const mkCheck = (id, label) => {
        const lbl = hackerEl('label', 'display:flex;align-items:center;gap:7px;color:#475569;font-size:11px;margin-bottom:5px;cursor:pointer;');
        const cb = hackerEl('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.style.cssText = 'accent-color:#6366f1;width:13px;height:13px;';
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(label));
        return lbl;
    };
    wrap.appendChild(mkCheck('hackerAgentCheckCreate', 'Проверить и если нет — создать'));
    wrap.appendChild(mkCheck('hackerAgentCreateAssign', 'Создать и поменять контрагента'));
    return wrap;
}

// ─── Справочники для «Автопродажи» ────────────────────────────────────────────
function hackerApiPath(href) {
    if (!href) return '';
    return href.startsWith(MS_API_BASE) ? href.slice(MS_API_BASE.length) : href;
}

function hackerMetaRef(href, type) {
    return { href, type, mediaType: 'application/json' };
}

function hackerIsDuplicateNameError(error) {
    return /имя|назван|дубликат|уже существует|занят|duplicate|name/i.test(String(error?.message || error));
}

async function hackerPostWithNameRetry(entityType, body, baseName, maxAttempts = 10) {
    let lastError;
    for (let i = 0; i < maxAttempts; i += 1) {
        const name = i === 0 ? baseName : `${baseName}-${i}`;
        try {
            return await msApiP('POST', '/entity/' + entityType, { ...body, name });
        } catch (error) {
            lastError = error;
            if (!hackerIsDuplicateNameError(error)) throw error;
            hackerLog(`Имя «${name}» занято, пробую «${baseName}-${i + 1}»…`, 'warn');
        }
    }
    throw lastError || new Error('Не удалось создать документ с уникальным именем');
}

function hackerFetchMetadataAttribute(entityType, attrName) {
    return msApiP('GET', '/entity/' + entityType + '/metadata').then(meta => {
        const href = meta.attributes?.meta?.href;
        if (!href) return null;
        return msApiP('GET', hackerApiPath(href)).then(data =>
            (data.rows || []).find(a => a.name === attrName || new RegExp(attrName, 'i').test(a.name || '')) || null
        );
    });
}

function hackerFetchDemandChannelAttribute(order, channelName) {
    const source = (Array.isArray(order.attributes) ? order.attributes : (order.attributes?.rows || []))
        .find(a => /канал продаж/i.test(a.name || ''));
    return hackerFetchMetadataAttribute('demand', 'Канал продаж').then(attr => {
        if (!attr?.meta?.href || !attr.customEntityMeta?.href) return null;
        return msApiP('GET', hackerApiPath(attr.customEntityMeta.href)).then(customMeta => {
            const valuesHref = customMeta.entityMeta?.href;
            if (!valuesHref) return null;
            return msApiP('GET', hackerApiPath(valuesHref)).then(values => {
                const rows = values.rows || [];
                const wanted = channelName || source?.value?.name || '';
                const normalize = value => String(value || '').trim().toLowerCase();
                const match = rows.find(row => normalize(row.name) === normalize(wanted))
                    || rows.find(row => normalize(row.name).includes(normalize(wanted)) || normalize(wanted).includes(normalize(row.name)));
                if (!match?.meta?.href) return null;
                return {
                    meta: hackerMetaRef(attr.meta.href, 'attributemetadata'),
                    value: { meta: hackerMetaRef(match.meta.href, 'customentity') }
                };
            });
        });
    });
}

function hackerFetchAttrValues(entityType, attrName) {
    return msApiP('GET', '/entity/' + entityType + '/metadata').then(meta => {
        // В реальном ответе metadata.attributes — meta-ссылка, не массив.
        const attrsRef = meta.attributes?.meta?.href;
        const attrsPromise = attrsRef
            ? msApiP('GET', hackerApiPath(attrsRef))
            : Promise.resolve(meta.attributes);
        return attrsPromise.then(attrsData => {
            const rawAttrs = attrsData?.rows || attrsData;
            const attrs = Array.isArray(rawAttrs)
                ? rawAttrs
                : (rawAttrs && typeof rawAttrs === 'object' ? Object.values(rawAttrs) : []);
            const attr = attrs.find(a => a && a.name === attrName);
            const customMetaHref = attr?.customEntityMeta?.href;
            if (!customMetaHref) {
                hackerLog(`Справочник «${attrName}» не найден в metadata ${entityType}`, 'warn');
                return [];
            }
            // customEntityMeta — метаданные. Значения лежат по entityMeta.href.
            return msApiP('GET', hackerApiPath(customMetaHref)).then(customMeta => {
                const valuesHref = customMeta.entityMeta?.href;
                if (!valuesHref) {
                    hackerLog(`У справочника «${attrName}» нет ссылки на значения`, 'warn');
                    return [];
                }
                return msApiP('GET', hackerApiPath(valuesHref)).then(values => {
                    const rows = Array.isArray(values) ? values : (values.rows || []);
                    return rows.map(r => ({ name: r.name, href: r.meta?.href }))
                        .filter(r => r.href);
                });
            });
        });
    });
}

function hackerRefreshCashPayType() {
    return hackerFetchAttrValues('cashin', HACKER_ATTR_PAY_TYPE).then(items => {
        const cash = items.find(item => item.name === HACKER_CASH_PAY_NAME || /наличн/i.test(item.name));
        return cash?.href || null;
    });
}

function hackerRefreshClientStatuses(quiet) {
    return hackerFetchAttrValues('cashin', HACKER_ATTR_CLIENT_STATUS)
        .then(items => {
            hackerClientStatuses = items;
            hackerFillSelect(document.getElementById('hackerClientStatusSelect'), items, true);
            if (!quiet) hackerLog(`«Статус клиента» обновлён: ${items.length} шт.`, 'ok');
        })
        .catch(error => hackerLog('Статус клиента: ' + error.message, 'err'));
}

function hackerRefreshPayMethods(quiet) {
    return hackerFetchAttrValues('paymentin', HACKER_ATTR_PAY_METHOD)
        .then(items => {
            hackerPayMethods = items;
            hackerFillSelect(document.getElementById('hackerPayMethodSelect'), items, true);
            if (!quiet) hackerLog(`«Способ оплаты» обновлён: ${items.length} шт.`, 'ok');
        })
        .catch(error => hackerLog('Способ оплаты: ' + error.message, 'err'));
}

function hackerFetchCustomChannelValues() {
    return hackerFetchMetadataAttribute('demand', 'Канал продаж').then(attr => {
        if (!attr?.customEntityMeta?.href) return [];
        return msApiP('GET', hackerApiPath(attr.customEntityMeta.href)).then(meta => {
            const href = meta.entityMeta?.href;
            return href ? msApiP('GET', hackerApiPath(href)) : { rows: [] };
        }).then(data => (data.rows || []).map(row => ({
            name: row.name,
            href: row.meta?.href
        })).filter(row => row.href));
    });
}

function hackerRefreshSalesChannels(quiet) {
    return Promise.all([
        msApiP('GET', '/entity/saleschannel?limit=1000'),
        hackerFetchCustomChannelValues()
    ]).then(([data, customValues]) => {
        const systems = data.rows || [];
        hackerSalesChannels = systems.map(row => {
            const custom = customValues.find(value => value.name === row.name);
            return { name: row.name, href: row.meta?.href, customHref: custom?.href };
        }).filter(row => row.href);
        hackerFillSelect(document.getElementById('hackerChannelSelect'), hackerSalesChannels, true);
        if (!quiet) hackerLog(`Каналы продаж обновлены: ${hackerSalesChannels.length} шт.`, 'ok');
    }).catch(error => hackerLog('Каналы продаж: ' + error.message, 'err'));
}

// ─── Вкладка «Автопродажа» ────────────────────────────────────────────────────
function hackerBuildSaleTab() {
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabStatus_Sale';

    const amountLabel = hackerEl('div', 'font-size:10px;font-weight:700;color:#64748b;margin-bottom:3px;', 'Сумма');
    wrap.appendChild(amountLabel);
    const amount = hackerEl('input');
    amount.id = 'hackerSaleSum';
    amount.type = 'text';
    amount.placeholder = 'сумма, пусто/0 = не создавать';
    amount.style.cssText = 'width:100%;padding:5px 7px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;outline:none;box-sizing:border-box;margin-bottom:7px;';
    wrap.appendChild(amount);

    const mkRow = (labelText, selectId, btnId) => {
        const row = hackerEl('div', 'display:flex;gap:4px;margin-bottom:6px;');
        const label = hackerEl('span', 'flex:0 0 145px;padding:5px 0;font-size:10px;font-weight:700;color:#64748b;', labelText);
        row.appendChild(label);
        row.appendChild(hackerSelect(selectId, '—'));
        const btn = hackerBtn(btnId, '⟳', HACKER_MINI_BTN_CSS);
        row.appendChild(btn);
        wrap.appendChild(row);
        return btn;
    };
    mkRow('Приходный — Статус клиента', 'hackerClientStatusSelect', 'hackerClientStatusRefresh')
        .addEventListener('click', () => hackerRefreshClientStatuses(false));
    mkRow('Входящий — Способ оплаты', 'hackerPayMethodSelect', 'hackerPayMethodRefresh')
        .addEventListener('click', () => hackerRefreshPayMethods(false));

    const cashLabel = hackerEl('div', 'font-size:10px;font-weight:700;color:#64748b;margin:2px 0 3px;', 'Наличные');
    wrap.appendChild(cashLabel);
    const cashAmount = hackerEl('input');
    cashAmount.id = 'hackerCashAmount';
    cashAmount.type = 'text';
    cashAmount.placeholder = 'сумма наличными для кредита/рассрочки';
    cashAmount.style.cssText = 'width:100%;padding:5px 7px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;outline:none;box-sizing:border-box;margin-bottom:7px;';
    wrap.appendChild(cashAmount);

    const lblChannel = hackerEl('div', 'font-size:10px;font-weight:700;color:#64748b;margin-bottom:3px;', 'Канал продаж');
    wrap.appendChild(lblChannel);
    const rowChannel = hackerEl('div', 'display:flex;gap:4px;margin-bottom:8px;');
    const channelSel = hackerSelect('hackerChannelSelect', '— как в заказе / рандом —');
    rowChannel.appendChild(channelSel);
    const channelBtn = hackerBtn('hackerChannelRefresh', '⟳', HACKER_MINI_BTN_CSS);
    channelBtn.addEventListener('click', () => hackerRefreshSalesChannels(false));
    rowChannel.appendChild(channelBtn);
    wrap.appendChild(rowChannel);

    if (HACKER_QUICK_API_ROW_ENABLED) {
        const actions = hackerEl('div', 'display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;');
        const demandBtn = hackerBtn('hackerCreateDemand', 'Создать отгрузку',
            HACKER_BTN_CSS + 'background:linear-gradient(135deg,#6366f1,#4f46e5);flex:1;');
        demandBtn.addEventListener('click', hackerCreateDemand);
        const cashinBtn = hackerBtn('hackerCreateCashin', 'Создать приходный ордер',
            HACKER_BTN_CSS + 'background:linear-gradient(135deg,#22c55e,#16a34a);flex:1;');
        cashinBtn.addEventListener('click', hackerCreateCashin);
        const payinBtn = hackerBtn('hackerCreatePaymentin', 'Создать входящий платёж',
            HACKER_BTN_CSS + 'background:linear-gradient(135deg,#f97316,#ea580c);flex:1;');
        payinBtn.addEventListener('click', hackerCreatePaymentin);
        const creditBtn = hackerBtn('hackerCreateCredit', 'Кредит/Рассрочка',
            HACKER_BTN_CSS + 'background:linear-gradient(135deg,#8b5cf6,#6d28d9);flex:1;');
        creditBtn.addEventListener('click', hackerCreateCredit);
        actions.appendChild(demandBtn);
        actions.appendChild(cashinBtn);
        actions.appendChild(payinBtn);
        actions.appendChild(creditBtn);
        wrap.appendChild(actions);
    }
    return wrap;
}

// ─── INVOKE: отгрузка + ПКО + входящий платёж ─────────────────────────────────
function hackerBuildAttrBody(entityType, attrName, valueHref) {
    if (!valueHref) return Promise.resolve(null);
    return hackerFetchMetadataAttribute(entityType, attrName).then(attr => {
        if (!attr) return null;
        return {
            meta: {
                href: MS_API_BASE + '/entity/' + entityType + '/metadata/attributes/' + attr.id,
                type: 'attributemetadata',
                mediaType: 'application/json'
            },
            value: {
                meta: {
                    href: valueHref,
                    type: 'customentity',
                    mediaType: 'application/json'
                }
            }
        };
    });
}

function hackerMarkRequiredSelect(id, message) {
    const el = document.getElementById(id);
    if (el) {
        el.style.borderColor = '#ef4444';
        el.style.boxShadow = '0 0 0 2px #ef444433';
        setTimeout(() => { if (el.isConnected) { el.style.borderColor = '#cbd5e1'; el.style.boxShadow = ''; } }, 2500);
    }
    hackerLog(message, 'warn');
}

function hackerSetActionBusy(busy) {
    hackerBusy = busy;
    ['hackerCreateDemand', 'hackerCreateCashin', 'hackerCreatePaymentin', 'hackerCreateCredit'].forEach(id => {
        const button = document.getElementById(id);
        if (button) { button.disabled = busy; button.style.opacity = busy ? '.6' : '1'; }
    });
}

function hackerCurrentOrder() {
    const doc = hackerOpenDoc();
    if (!doc || !['customerorder', 'demand'].includes(doc.type)) {
        hackerLog('Откройте карточку заказа или отгрузки', 'warn');
        return null;
    }
    return doc;
}

async function hackerGetOrder() {
    const doc = hackerCurrentOrder();
    if (!doc) throw new Error('нет открытого заказа или отгрузки');
    if (doc.type === 'demand') {
        const demand = hackerLastDemand?.id === doc.id
            ? hackerLastDemand
            : await msApiP('GET', '/entity/demand/' + doc.id + '?expand=customerOrder');
        hackerLastDemand = demand;
        const orderId = demand.customerOrder?.meta?.href?.split('/').pop() || '';
        hackerContext = { customerOrderId: orderId, demandId: doc.id };
        return { doc, order: demand };
    }
    const order = hackerOrderInfo && hackerOrderInfo.id === doc.id
        ? hackerOrderInfo
        : await msApiP('GET', '/entity/customerorder/' + doc.id + '?expand=positions.assortment');
    hackerOrderInfo = order;
    hackerContext = { customerOrderId: doc.id, demandId: hackerContext.customerOrderId === doc.id ? hackerContext.demandId : '' };
    return { doc, order };
}

async function hackerBuildDemandBody(order, doc) {
    const demandBody = {
        moment: order.moment,
        organization: order.organization,
        agent: order.agent,
        store: order.store,
        customerOrder: { meta: hackerMetaRef(MS_API_BASE + '/entity/customerorder/' + doc.id, 'customerorder') },
        positions: (Array.isArray(order.positions) ? order.positions : (order.positions?.rows || [])).map(position => {
            const copy = { assortment: position.assortment, quantity: position.quantity, price: position.price };
            ['discount', 'vat', 'pack', 'things', 'reserve'].forEach(key => {
                if (position[key] !== undefined) copy[key] = position[key];
            });
            return copy;
        })
    };
    let channelHref = hackerDefaultChannel || document.getElementById('hackerChannelSelect')?.value || '';
    let channelNote = hackerDefaultChannel ? 'по умолчанию' : 'как выбрано';
    if (!channelHref && order.salesChannel?.meta?.href) {
        channelHref = order.salesChannel.meta.href;
        channelNote = 'как в заказе';
    }
    if (!channelHref) {
        if (!hackerSalesChannels.length) await hackerRefreshSalesChannels(true);
        const random = hackerSalesChannels[Math.floor(Math.random() * hackerSalesChannels.length)];
        channelHref = random?.href || '';
        channelNote = 'рандом';
    }
    const selected = hackerSalesChannels.find(item => item.href === channelHref);
    if (!selected?.customHref) throw new Error('Для выбранного канала продаж не найдено значение атрибута отгрузки');
    demandBody.salesChannel = { meta: hackerMetaRef(channelHref, 'saleschannel') };
    const attr = await hackerFetchMetadataAttribute('demand', 'Канал продаж');
    if (!attr?.meta?.href) throw new Error('В отгрузке не найден обязательный атрибут «Канал продаж»');
    demandBody.attributes = [{
        meta: hackerMetaRef(attr.meta.href, 'attributemetadata'),
        value: { meta: hackerMetaRef(selected.customHref, 'customentity') }
    }];
    hackerLog(`Канал продаж отгрузки: ${channelNote}`);
    hackerLog('Канал продаж продублирован в атрибут отгрузки');
    return demandBody;
}

function hackerPositionKey(position) {
    return position.assortment?.meta?.href || position.assortment?.id || '';
}

function hackerPositionsSignature(document) {
    const rows = Array.isArray(document?.positions)
        ? document.positions
        : (document?.positions?.rows || []);
    return rows
        .map(position => `${hackerPositionKey(position)}:${Number(position.quantity || 0)}`)
        .sort()
        .join('|');
}

async function hackerFindExistingDemand(order, doc) {
    const customerOrderHref = MS_API_BASE + '/entity/customerorder/' + doc.id;
    const path = '/entity/demand?filter=customerOrder=' + encodeURIComponent(customerOrderHref)
        + '&expand=positions.assortment&limit=100';
    const data = await msApiP('GET', path);
    const rows = data.rows || [];
    const orderSum = Number(order.sum || 0);
    const orderPositions = hackerPositionsSignature(order);
    return rows.filter(demand => demand.applicable === true && Number(demand.sum || 0) === orderSum)
        .map(demand => ({
            demand,
            samePositions: hackerPositionsSignature(demand) === orderPositions
        }));
}

async function hackerCreateDemand() {
    if (hackerBusy) return;
    const current = hackerOpenDoc();
    if (!current || current.type !== 'customerorder') {
        hackerLog('Для создания отгрузки откройте заказ покупателя', 'warn');
        return;
    }
    hackerSetActionBusy(true);
    try {
        const { doc, order } = await hackerGetOrder();
        const existing = await hackerFindExistingDemand(order, doc);
        const exact = existing.find(item => item.samePositions);
        if (exact) {
            hackerLastDemand = exact.demand;
            hackerLog(`⚠️ Уже есть проведённая отгрузка ${exact.demand.name} на сумму ${(exact.demand.sum / 100).toFixed(2)} ₽ — новая не создаётся`, 'warn');
            return;
        }
        if (existing.length) {
            hackerLog('Есть проведённая отгрузка с такой же суммой, но состав позиций отличается — создаю новую отгрузку', 'warn');
        }
        hackerLog('Создаю отгрузку…');
        hackerOrderInfo = order;
        const demand = await hackerPostWithNameRetry('demand', await hackerBuildDemandBody(order, doc), order.name || ('Автопродажа ' + doc.id));
        hackerLastDemand = demand;
        hackerContext = { customerOrderId: doc.id, demandId: demand.id };
        hackerLog(`✅ Отгрузка создана: ${demand.name}`, 'ok');
        location.hash = '#demand/edit?id=' + demand.id;
    } catch (error) { hackerLog('Отгрузка: ' + (error.message || error), 'err'); }
    finally { hackerSetActionBusy(false); }
}

async function hackerCreatePaymentDocument(entityType) {
    const sum = hackerParseSumToKopecks(document.getElementById('hackerSaleSum')?.value);
    if (!sum) { hackerLog(`${entityType === 'cashin' ? 'Приходный ордер' : 'Входящий платёж'}: сумма пустая/0 — пропущен`); return; }
    const { doc, order } = await hackerGetOrder();
    const demand = hackerLastDemand?.id === doc.id ? hackerLastDemand : null;
    const body = { organization: order.organization, agent: order.agent, sum, moment: order.moment };
    const linkedDocument = demand?.id
        ? { id: demand.id, type: 'demand', label: 'отгрузке' }
        : (doc.type === 'customerorder'
            ? { id: doc.id, type: 'customerorder', label: 'заказу' }
            : { id: doc.id, type: 'demand', label: 'отгрузке' });
    body.operations = [{
        meta: hackerMetaRef(MS_API_BASE + '/entity/' + linkedDocument.type + '/' + linkedDocument.id, linkedDocument.type),
        linkedSum: sum
    }];
    hackerLog(`Документ будет привязан к ${linkedDocument.label}`);
    if (entityType === 'cashin') {
        const clientHref = document.getElementById('hackerClientStatusSelect')?.value || '';
        const cashTypeHref = await hackerRefreshCashPayType();
        body.attributes = [
            await hackerBuildAttrBody('cashin', HACKER_ATTR_CLIENT_STATUS, clientHref),
            await hackerBuildAttrBody('cashin', HACKER_ATTR_PAY_TYPE, cashTypeHref)
        ].filter(Boolean);
    } else {
        const methodHref = document.getElementById('hackerPayMethodSelect')?.value || '';
        if (!methodHref) { hackerMarkRequiredSelect('hackerPayMethodSelect', 'Выберите «Способ оплаты»'); return; }
        body.attributes = [await hackerBuildAttrBody('paymentin', HACKER_ATTR_PAY_METHOD, methodHref)].filter(Boolean);
    }
    return hackerPostWithNameRetry(entityType, body, order.name || ('Автопродажа ' + order.id));
}

async function hackerCreateCashin() {
    if (hackerBusy) return; hackerSetActionBusy(true);
    try { const item = await hackerCreatePaymentDocument('cashin'); if (item) hackerLog(`✅ Приходный ордер создан: ${item.name}`, 'ok'); }
    catch (error) { hackerLog('Приходный ордер: ' + (error.message || error), 'err'); }
    finally { hackerSetActionBusy(false); }
}

async function hackerCreateCredit() {
    if (hackerBusy) return;
    const total = hackerParseSumToKopecks(document.getElementById('hackerSaleSum')?.value);
    const cash = hackerParseSumToKopecks(document.getElementById('hackerCashAmount')?.value);
    if (!total || !cash) { hackerLog('Для кредита/рассрочки укажите общую сумму и сумму наличными', 'warn'); return; }
    if (cash >= total) { hackerLog('Сумма наличными должна быть меньше общей суммы', 'warn'); return; }
    const rest = total - cash;
    hackerSetActionBusy(true);
    try {
        const amountInput = document.getElementById('hackerSaleSum');
        const oldAmount = amountInput.value;
        amountInput.value = String(cash / 100);
        const cashDoc = await hackerCreatePaymentDocument('cashin');
        amountInput.value = oldAmount;
        if (cashDoc) hackerLog(`✅ ПКО на наличные создан: ${cashDoc.name}`, 'ok');
        amountInput.value = String(rest / 100);
        const payDoc = await hackerCreatePaymentDocument('paymentin');
        amountInput.value = oldAmount;
        if (payDoc) hackerLog(`✅ Входящий платёж на остаток создан: ${payDoc.name}`, 'ok');
    } catch (error) { hackerLog('Кредит/рассрочка: ' + (error.message || error), 'err'); }
    finally { hackerSetActionBusy(false); }
}

async function hackerCreatePaymentin() {
    if (hackerBusy) return; hackerSetActionBusy(true);
    try { const item = await hackerCreatePaymentDocument('paymentin'); if (item) hackerLog(`✅ Входящий платёж создан: ${item.name}`, 'ok'); }
    catch (error) { hackerLog('Входящий платёж: ' + (error.message || error), 'err'); }
    finally { hackerSetActionBusy(false); }
}

async function hackerCheckOrderSum() {
    try {
        const { order } = await hackerGetOrder();
        const sum = ((order.sum || 0) / 100).toFixed(2);
        ['hackerSaleSum', 'hackerCashAmount'].forEach(id => {
            const el = document.getElementById(id);
            if (el && id === 'hackerSaleSum') el.value = sum;
        });
        hackerLog(`✅ Сумма заказа обновлена: ${sum} ₽`, 'ok');
    } catch (error) {
        hackerLog('Проверка суммы: ' + (error.message || error), 'err');
    }
}

function hackerParseSumToKopecks(value) {
    const n = parseFloat(String(value || '').replace(',', '.').replace(/\s/g, ''));
    return (isFinite(n) && n > 0) ? Math.round(n * 100) : 0;
}

/* ===== 12-moysklad-ux.js ===== */

// ─── Контекстный UX МойСклад ─────────────────────────────────────────────────
// Идемпотентные DOM-встройки для карточек документов. Бизнес-действия используют
// либо штатный UI МойСклад, либо небольшие проверенные API-вызовы.

let msSpaObserver = null;
let msSpaReconcileTimer = null;
let msQuickKeepaliveTimer = null;

function msCurrentDocument() {
    const match = location.hash.match(/^#(customerorder|demand|cashin|paymentin)\/edit\?[^#]*\bid=([0-9a-f-]+)/i);
    return match ? { type: match[1].toLowerCase(), id: match[2] } : null;
}

function msVisible(element) {
    return !!element && element.isConnected && element.offsetHeight > 0;
}

function msExactTextElements(text) {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        if ((node.textContent || '').trim() !== text) continue;
        const element = node.parentElement;
        if (element && msVisible(element) && !element.closest('[id^="mc"]')) found.push(element);
    }
    return found;
}

function msFieldHostFromLabel(labelElement) {
    if (!labelElement) return null;
    const title = labelElement.closest('[class*="formItemTitle"]');
    if (title) {
        const parent = title.parentElement;
        const index = Array.prototype.indexOf.call(parent.children, title);
        return parent.children[index + 1] || null;
    }
    const legend = labelElement.closest('td.legend') || labelElement.closest('td');
    if (legend?.nextElementSibling) return legend.nextElementSibling;
    return labelElement.nextElementSibling || labelElement.parentElement?.nextElementSibling || null;
}

function msFindOrderStatusAnchor() {
    if (msCurrentDocument()?.type !== 'customerorder') return null;
    const testIdAnchor = document.querySelector('[data-test-id="doc-status"]');
    if (msVisible(testIdAnchor)) return testIdAnchor;
    const labelled = msExactTextElements('Статус')
        .map(element => msFieldHostFromLabel(element))
        .find(msVisible);
    if (labelled) return labelled.querySelector('button,[role="button"],.b-popup-button') || labelled;

    const names = new Set(hackerStates.map(state => state.name));
    if (!names.size) return null;
    return [...document.querySelectorAll('button,[role="button"],.b-popup-button')]
        .find(element => msVisible(element) && names.has((element.textContent || '').trim()) && !element.closest('[id^="mc"]')) || null;
}

function msToast(message, kind = 'info') {
    let toast = document.getElementById('mcMsToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mcMsToast';
        toast.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483005;max-width:360px;'
            + 'padding:9px 12px;border-radius:9px;box-shadow:0 6px 24px #0f172a40;font:12px Segoe UI,sans-serif;';
        document.body.appendChild(toast);
    }
    const colors = kind === 'error'
        ? ['#fee2e2', '#991b1b', '#fecaca']
        : kind === 'ok' ? ['#dcfce7', '#166534', '#86efac'] : ['#eff6ff', '#1d4ed8', '#bfdbfe'];
    toast.style.background = colors[0];
    toast.style.color = colors[1];
    toast.style.border = `1px solid ${colors[2]}`;
    toast.textContent = message;
    clearTimeout(msToast._timer);
    msToast._timer = setTimeout(() => toast.remove(), kind === 'error' ? 6000 : 2500);
}

function msFillStatusSelect(select) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— выберите статус —';
    select.appendChild(placeholder);
    hackerStates.forEach(state => {
        const option = document.createElement('option');
        option.value = state.href;
        option.textContent = state.name;
        select.appendChild(option);
    });
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

function closeMsOrderStatusPopup() {
    document.getElementById('mcOrderStatusPopup')?.remove();
}

function openMsOrderStatusPopup(anchor) {
    const old = document.getElementById('mcOrderStatusPopup');
    if (old) { old.remove(); return; }
    const popup = document.createElement('div');
    popup.id = 'mcOrderStatusPopup';
    popup.style.cssText = 'position:fixed;z-index:2147483004;width:280px;padding:10px;background:#fff;'
        + 'border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 30px #0f172a40;font:12px Segoe UI,sans-serif;color:#334155;';
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 296))}px`;
    popup.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - 190)}px`;

    const title = document.createElement('strong');
    title.textContent = '🎯 Сменить статус заказа';
    popup.appendChild(title);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:5px;margin-top:8px;';
    const select = document.createElement('select');
    select.id = 'mcOrderStatusSelect';
    select.style.cssText = 'flex:1;min-width:0;padding:6px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;';
    row.appendChild(select);
    msFillStatusSelect(select);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '↻';
    refresh.title = 'Обновить список статусов';
    refresh.style.cssText = 'width:32px;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;cursor:pointer;';
    refresh.addEventListener('click', () => {
        refresh.disabled = true;
        hackerRefreshStates(true).then(() => msFillStatusSelect(select)).finally(() => { refresh.disabled = false; });
    });
    row.appendChild(refresh);
    popup.appendChild(row);

    const error = document.createElement('div');
    error.id = 'mcOrderStatusError';
    error.style.cssText = 'display:none;margin-top:7px;color:#991b1b;background:#fee2e2;border-radius:6px;padding:6px;';
    popup.appendChild(error);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = 'Поменять и обновить страницу';
    apply.style.cssText = 'width:100%;margin-top:8px;padding:7px;border:0;border-radius:7px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;';
    apply.addEventListener('click', async () => {
        const doc = msCurrentDocument();
        if (!doc || !select.value) {
            error.textContent = 'Выберите статус';
            error.style.display = 'block';
            return;
        }
        apply.disabled = true;
        error.style.display = 'none';
        try {
            await hackerUpdateOrderStatus(doc.id, select.value);
            msToast('✅ Статус изменён. Обновляю страницу…', 'ok');
            setTimeout(() => location.reload(), 250);
        } catch (reason) {
            error.textContent = reason.message || String(reason);
            error.style.display = 'block';
            apply.disabled = false;
        }
    });
    popup.appendChild(apply);
    document.body.appendChild(popup);
    if (!hackerStates.length) refresh.click();
}

function buildMsOrderStatusAction() {
    const existing = document.getElementById('mcOrderStatusAction');
    const allowed = hackerBearerEnabled && !!hackerBearerToken.trim() && hackerApiValidated;
    if (!allowed || msCurrentDocument()?.type !== 'customerorder') {
        existing?.remove();
        closeMsOrderStatusPopup();
        return;
    }
    if (existing?.isConnected) return;
    const anchor = msFindOrderStatusAnchor();
    if (!anchor) return;
    const button = document.createElement('button');
    button.id = 'mcOrderStatusAction';
    button.type = 'button';
    button.textContent = '🎯';
    button.title = 'Быстро поменять статус заказа';
    button.style.cssText = 'display:block;width:28px;height:24px;margin-top:3px;padding:0;border:1px solid #93c5fd;'
        + 'border-radius:6px;background:#eff6ff;color:#1d4ed8;cursor:pointer;line-height:22px;';
    button.addEventListener('click', () => openMsOrderStatusPopup(button));
    anchor.insertAdjacentElement('afterend', button);
}

function validateMsMagicConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Корень JSON должен быть объектом');
    ['demand', 'cashin', 'paymentin'].forEach(kind => {
        if (config[kind] == null) return;
        const section = config[kind];
        if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`${kind}: нужен объект`);
        if (section.copies != null && !Array.isArray(section.copies)) throw new Error(`${kind}.copies: нужен массив`);
        if (section.values != null && !Array.isArray(section.values)) throw new Error(`${kind}.values: нужен массив`);
        (section.copies || []).forEach((rule, index) => {
            if (!rule || typeof rule.field !== 'string' || !Number.isInteger(rule.from) || !Array.isArray(rule.to)) {
                throw new Error(`${kind}.copies[${index}]: нужны field, from и to`);
            }
        });
        (section.values || []).forEach((rule, index) => {
            if (!rule || typeof rule.field !== 'string' || typeof rule.value !== 'string') {
                throw new Error(`${kind}.values[${index}]: нужны строковые field и value`);
            }
        });
    });
    return config;
}

function loadMsMagicConfig() {
    try {
        const saved = localStorage.getItem(storageKey('msMagicConfig_v1'));
        msMagicConfig = saved ? validateMsMagicConfig(JSON.parse(saved)) : JSON.parse(JSON.stringify(DEFAULT_MS_MAGIC_CONFIG));
    } catch (error) {
        debugError('magic-config', error);
        msMagicConfig = JSON.parse(JSON.stringify(DEFAULT_MS_MAGIC_CONFIG));
    }
    return msMagicConfig;
}

function saveMsMagicConfig(config) {
    msMagicConfig = validateMsMagicConfig(config);
    localStorage.setItem(storageKey('msMagicConfig_v1'), JSON.stringify(msMagicConfig));
    return msMagicConfig;
}

function saveMsMagicValueOverrides(kind, overrides) {
    const config = JSON.parse(JSON.stringify(msMagicConfig));
    const section = config[kind] || { copies: [], values: [] };
    section.values = (section.values || []).map((rule, index) => (
        Object.prototype.hasOwnProperty.call(overrides, index)
            ? { ...rule, value: String(overrides[index] ?? '') }
            : rule
    ));
    config[kind] = section;
    return saveMsMagicConfig(config);
}

function msFindFieldHosts(fieldName) {
    return msExactTextElements(fieldName)
        .map(label => msFieldHostFromLabel(label))
        .filter((host, index, all) => host && all.indexOf(host) === index);
}

function msFieldControl(host) {
    if (!host) return null;
    if (host.matches?.('input,select,textarea,[contenteditable="true"],[role="combobox"]')) return host;
    return host.querySelector('select,input:not([type="hidden"]),textarea,[contenteditable="true"],[role="combobox"],button,.b-popup-button') || host;
}

function msControlValue(control) {
    if (!control) return '';
    if (control instanceof HTMLSelectElement) return control.selectedOptions[0]?.textContent.trim() || '';
    if ('value' in control && String(control.value || '').trim()) return String(control.value).trim();
    return (control.textContent || '').replace(/[×✕▾▼]/g, '').trim();
}

function msDispatchControlEvents(control) {
    ['input', 'change', 'keyup', 'blur'].forEach(type => control.dispatchEvent(new Event(type, { bubbles: true })));
}

async function msPickCustomOption(opener, value) {
    opener.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    const option = msExactTextElements(value).find(element => {
        const clickable = element.closest('[role="option"],li,button,a,td,div');
        return clickable && msVisible(clickable) && !clickable.closest('#mcMagicPopup') && !opener.contains(clickable);
    });
    const clickable = option?.closest('[role="option"],li,button,a,td,div');
    if (!clickable) return false;
    clickable.click();
    await new Promise(resolve => setTimeout(resolve, 60));
    return true;
}

async function msSetControlValue(control, value) {
    if (!control || !value) return false;
    if (control instanceof HTMLSelectElement) {
        const option = [...control.options].find(item => item.textContent.trim() === value || item.value === value);
        if (!option) return false;
        control.value = option.value;
        msDispatchControlEvents(control);
        return true;
    }
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        const combo = control.closest('[role="combobox"],[class*="combo" i],[class*="select" i]');
        if ((control.readOnly || combo) && await msPickCustomOption(combo || control, value)) return true;
        if (control.readOnly) return false;
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value');
        if (descriptor?.set) descriptor.set.call(control, value); else control.value = value;
        msDispatchControlEvents(control);
        return msControlValue(control) === value;
    }
    if (control.isContentEditable) {
        control.textContent = value;
        msDispatchControlEvents(control);
        return msControlValue(control) === value;
    }

    return msPickCustomOption(control, value);
}

function msNativeSaveButton() {
    return msExactTextElements('Сохранить')
        .map(element => element.closest('button,a,[role="button"]') || element)
        .find(element => msVisible(element));
}

function msDocumentMagicRules(kind, overrides = {}) {
    const base = msMagicConfig[kind] || {};
    return {
        copies: (base.copies || []).map(rule => ({ ...rule })),
        values: (base.values || []).map((rule, index) => ({
            ...rule,
            value: Object.prototype.hasOwnProperty.call(overrides, index) ? overrides[index] : rule.value,
        })),
    };
}

async function msApplyMagicRules({ save = false, overrides = {} } = {}) {
    const doc = msCurrentDocument();
    if (!doc || !['demand', 'cashin', 'paymentin'].includes(doc.type)) {
        return { changed: 0, missing: ['Откройте Отгрузку, Приходный ордер или Входящий платёж'], failed: [] };
    }
    const rules = msDocumentMagicRules(doc.type, overrides);
    const result = { changed: 0, missing: [], failed: [] };

    for (const rule of rules.copies) {
        const hosts = msFindFieldHosts(rule.field);
        const source = msFieldControl(hosts[rule.from]);
        const sourceValue = msControlValue(source);
        if (!sourceValue) {
            if (rule.required) result.missing.push(rule.field);
            continue;
        }
        for (const targetIndex of rule.to) {
            const target = msFieldControl(hosts[targetIndex]);
            if (!target || target === source) {
                result.failed.push(rule.field);
                continue;
            }
            if (await msSetControlValue(target, sourceValue)) result.changed += 1;
            else result.failed.push(rule.field);
        }
    }

    for (let index = 0; index < rules.values.length; index += 1) {
        const rule = rules.values[index];
        const value = String(rule.value || '').trim();
        if (!value) {
            if (rule.required) result.missing.push(rule.field);
            continue;
        }
        const host = msFindFieldHosts(rule.field)[rule.occurrence || 0];
        const control = msFieldControl(host);
        if (await msSetControlValue(control, value)) result.changed += 1;
        else result.failed.push(rule.field);
    }

    result.missing = [...new Set(result.missing)];
    result.failed = [...new Set(result.failed)];
    if (save && !result.missing.length && !result.failed.length) {
        const saveButton = msNativeSaveButton();
        if (saveButton) saveButton.click(); else result.failed.push('Кнопка «Сохранить»');
    }
    return result;
}

function closeMsMagicPopup() {
    document.getElementById('mcMagicPopup')?.remove();
}

function openMsMagicPopup(anchor) {
    const old = document.getElementById('mcMagicPopup');
    if (old) { old.remove(); return; }
    const doc = msCurrentDocument();
    if (!doc) return;
    const rules = msDocumentMagicRules(doc.type);
    const popup = document.createElement('div');
    popup.id = 'mcMagicPopup';
    popup.style.cssText = 'position:fixed;z-index:2147483004;width:310px;padding:11px;background:#fff;border:1px solid #cbd5e1;'
        + 'border-radius:10px;box-shadow:0 8px 30px #0f172a40;font:12px Segoe UI,sans-serif;color:#334155;';
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`;
    popup.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - 260)}px`;
    const title = document.createElement('strong');
    title.textContent = '🪄 Заполнить документ';
    popup.appendChild(title);

    rules.copies.forEach(rule => {
        const row = document.createElement('div');
        row.style.cssText = 'margin-top:8px;padding:6px;background:#f8fafc;border-radius:6px;';
        row.textContent = `${rule.field}: скопировать значение между полями`;
        popup.appendChild(row);
    });
    rules.values.forEach((rule, index) => {
        const label = document.createElement('label');
        label.style.cssText = 'display:block;margin-top:8px;font-weight:600;';
        label.textContent = rule.field;
        const input = document.createElement('input');
        input.dataset.magicValueIndex = String(index);
        input.value = rule.value || '';
        input.placeholder = 'Введите точное значение из списка МойСклад';
        input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border:1px solid #cbd5e1;border-radius:6px;';
        label.appendChild(input);
        popup.appendChild(label);
    });
    const error = document.createElement('div');
    error.style.cssText = 'display:none;margin-top:8px;padding:6px;background:#fee2e2;color:#991b1b;border-radius:6px;';
    popup.appendChild(error);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.textContent = '🪄 Заполнить и сохранить';
    apply.style.cssText = 'width:100%;margin-top:9px;padding:8px;border:0;border-radius:7px;background:#16a34a;color:#fff;font-weight:700;cursor:pointer;';
    apply.addEventListener('click', async () => {
        apply.disabled = true;
        const overrides = {};
        popup.querySelectorAll('[data-magic-value-index]').forEach(input => { overrides[input.dataset.magicValueIndex] = input.value; });
        saveMsMagicValueOverrides(doc.type, overrides);
        const result = await msApplyMagicRules({ save: true, overrides });
        if (result.missing.length || result.failed.length) {
            const details = [
                result.missing.length ? `Заполните: ${result.missing.join(', ')}` : '',
                result.failed.length ? `Не удалось установить: ${result.failed.join(', ')}` : ''
            ].filter(Boolean).join('. ');
            error.textContent = details;
            error.style.display = 'block';
            apply.disabled = false;
            return;
        }
        msToast(`✅ Заполнено полей: ${result.changed}. Сохраняю…`, 'ok');
        closeMsMagicPopup();
    });
    popup.appendChild(apply);
    document.body.appendChild(popup);
}

function buildMsMagicFillAction() {
    const existing = document.getElementById('mcMagicFillAction');
    // До 8.0.2-beta палочка жила рядом с первым настроенным полем. Удаляем
    // оставшийся DOM старой версии: теперь она строится в общей quick-панели.
    if (existing) { existing.remove(); closeMsMagicPopup(); }
}

function buildMsFieldsSpoiler() {
    const existing = document.getElementById('mcMsFieldsSpoiler');
    const doc = msCurrentDocument();
    if (!doc) {
        existing?.remove();
        document.querySelectorAll('[data-mc-native-other-fields]').forEach(element => {
            element.style.display = element.dataset.mcNativeOtherFields;
            delete element.dataset.mcNativeOtherFields;
        });
        return;
    }
    if (existing?.isConnected) return;
    const label = msExactTextElements('Другие поля')[0];
    const native = label?.closest('button,[role="button"],a') || label;
    if (!native || !native.parentElement) return;

    const expanded = native.getAttribute('aria-expanded') === 'true';
    const button = document.createElement('button');
    button.id = 'mcMsFieldsSpoiler';
    button.type = 'button';
    button.textContent = `${expanded ? '▾' : '▸'} Дополнительные поля`;
    button.style.cssText = 'display:block;width:min(480px,100%);margin:7px 0;padding:7px 10px;text-align:left;'
        + 'border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;color:#475569;font-weight:600;cursor:pointer;';
    button.addEventListener('click', () => {
        native.click();
        const nowExpanded = native.getAttribute('aria-expanded') === 'true'
            || button.dataset.expanded !== 'true';
        button.dataset.expanded = String(nowExpanded);
        button.textContent = `${nowExpanded ? '▾' : '▸'} Дополнительные поля`;
        localStorage.setItem(storageKey('msFieldsSpoilerOpen_v1'), String(nowExpanded));
    });
    native.insertAdjacentElement('afterend', button);
    native.dataset.mcNativeOtherFields = native.style.display || '';
    native.style.display = 'none';
}

function reconcileMsEnhancements() {
    if (!/online\.moysklad\.ru$/.test(location.hostname)) return;
    buildMsQuickPanel();
    buildMsOrderStatusAction();
    if (typeof buildMsMagicFillAction === 'function') buildMsMagicFillAction();
    if (typeof buildMsFieldsSpoiler === 'function') buildMsFieldsSpoiler();
}

function msQuickPanelIsHealthy() {
    if (!/online\.moysklad\.ru$/.test(location.hostname) || !msQuickPanelEnabled) return true;
    const kind = Object.keys(MS_QUICK_PANEL_CONFIG).find(k => MS_QUICK_PANEL_CONFIG[k].marker());
    if (!kind) return true;
    const cfg = MS_QUICK_PANEL_CONFIG[kind];
    const panel = document.getElementById('mcQuickPanel');
    const signature = [cfg.magic ? 'magic' : '', ...cfg.create, ...cfg.print].join('\u001f');
    const quickEnabled = HACKER_QUICK_API_ROW_ENABLED && hackerQuickButtonsEnabled;
    const expectedButtonCount = cfg.create.length + cfg.print.length + (cfg.magic ? 1 : 0);
    return !!panel && panel.isConnected && panel.dataset.kind === kind
        && panel.dataset.quickSignature === signature
        && panel.querySelectorAll('button').length === expectedButtonCount
        && (!cfg.magic || panel.querySelector('#mcMagicPanelAction')?.isConnected)
        && (!quickEnabled || document.getElementById('mcHackerQuickRow')?.isConnected);
}

function startMsQuickPanelKeepalive() {
    if (msQuickKeepaliveTimer) return;
    msQuickKeepaliveTimer = setInterval(() => {
        if (!msQuickPanelIsHealthy()) buildMsQuickPanel();
    }, 1000);
}

function startMsSpaObserver() {
    if (!/online\.moysklad\.ru$/.test(location.hostname) || msSpaObserver) return;
    reconcileMsEnhancements();
    startMsQuickPanelKeepalive();
    msSpaObserver = new MutationObserver(() => {
        clearTimeout(msSpaReconcileTimer);
        msSpaReconcileTimer = setTimeout(reconcileMsEnhancements, 350);
    });
    msSpaObserver.observe(document.body, { childList: true, subtree: true });
}

/* ===== 13-order-notifier.js ===== */

// ─── Оповещатель новых заказов ────────────────────────────────────────────────
// Периодически проверяет customerorder выбранной организации и подаёт сигнал
// на каждом опросе, если есть заказ в одном из выбранных статусов.

function hackerNotifierNormalizeSettings(raw) {
    const interval = Number(raw?.intervalMinutes);
    return {
        enabled: raw?.enabled !== false,
        soundEnabled: raw?.soundEnabled !== false,
        intervalMinutes: Number.isFinite(interval)
            ? Math.min(1440, Math.max(1, Math.round(interval)))
            : HACKER_NOTIFIER_DEFAULT_INTERVAL_MINUTES,
        organizationHref: typeof raw?.organizationHref === 'string' ? raw.organizationHref : '',
        statusHrefs: Array.isArray(raw?.statusHrefs)
            ? [...new Set(raw.statusHrefs.filter(value => typeof value === 'string' && value))]
            : []
    };
}

function hackerNotifierLoadSettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(storageKey('hackerOrderNotifier_v1')) || '{}');
        hackerNotifierSettings = hackerNotifierNormalizeSettings(raw);
        hackerNotifierStatusSelectionInitialized = Array.isArray(raw?.statusHrefs);
        const organizations = JSON.parse(localStorage.getItem(storageKey('hackerNotifierOrganizations_v1')) || '[]');
        hackerNotifierOrganizations = Array.isArray(organizations)
            ? organizations.filter(item => item && typeof item.href === 'string' && typeof item.name === 'string')
            : [];
        const seen = JSON.parse(localStorage.getItem(storageKey('hackerNotifierSeen_v1')) || '{}');
        hackerNotifierSeenByOrganization = seen && typeof seen === 'object' ? seen : {};
    } catch (error) {
        hackerNotifierSettings = hackerNotifierNormalizeSettings({});
        hackerNotifierOrganizations = [];
        hackerNotifierSeenByOrganization = {};
        hackerNotifierStatusSelectionInitialized = false;
        debugError('hacker-notifier', 'Не удалось загрузить настройки', error);
    }
}

function hackerNotifierSaveSettings() {
    try {
        localStorage.setItem(storageKey('hackerOrderNotifier_v1'), JSON.stringify(hackerNotifierSettings));
    } catch (error) {
        debugError('hacker-notifier', 'Не удалось сохранить настройки', error);
    }
}

function hackerNotifierSaveOrganizations() {
    try {
        localStorage.setItem(storageKey('hackerNotifierOrganizations_v1'), JSON.stringify(hackerNotifierOrganizations));
    } catch (error) {
        debugError('hacker-notifier', 'Не удалось сохранить организации', error);
    }
}

function hackerNotifierSaveSeen() {
    try {
        localStorage.setItem(storageKey('hackerNotifierSeen_v1'), JSON.stringify(hackerNotifierSeenByOrganization));
    } catch (error) {
        debugError('hacker-notifier', 'Не удалось сохранить историю заказов', error);
    }
}

function hackerNotifierSetStatus(message, kind = 'info') {
    const el = document.getElementById('hackerNotifierStatus');
    if (!el) return;
    el.textContent = message;
    el.style.color = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#166534' : '#64748b';
}

function hackerNotifierFillControls() {
    const organization = document.getElementById('hackerNotifierOrganization');
    if (organization) {
        const selected = hackerNotifierSettings.organizationHref;
        organization.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '— выберите организацию —';
        organization.appendChild(empty);
        hackerNotifierOrganizations.forEach(item => {
            const option = document.createElement('option');
            option.value = item.href;
            option.textContent = item.name;
            organization.appendChild(option);
        });
        organization.value = selected;
    }

    const statuses = document.getElementById('hackerNotifierStatuses');
    if (statuses) {
        statuses.innerHTML = '';
        hackerStates.forEach(item => {
            const option = document.createElement('option');
            option.value = item.href;
            option.textContent = item.name;
            option.selected = hackerNotifierSettings.statusHrefs.includes(item.href);
            statuses.appendChild(option);
        });
    }
    const enabled = document.getElementById('hackerNotifierEnabled');
    if (enabled) enabled.checked = hackerNotifierSettings.enabled;
    const soundEnabled = document.getElementById('hackerNotifierSoundEnabled');
    if (soundEnabled) soundEnabled.checked = hackerNotifierSettings.soundEnabled;
    const interval = document.getElementById('hackerNotifierInterval');
    if (interval) interval.value = String(hackerNotifierSettings.intervalMinutes);
}

function hackerNotifierSelectDefaultStatus() {
    if (hackerNotifierStatusSelectionInitialized || !hackerStates.length) return;
    const fresh = hackerStates.find(item => String(item.name || '').trim().toLowerCase() === 'новый');
    if (fresh) {
        hackerNotifierSettings.statusHrefs = [fresh.href];
        hackerNotifierStatusSelectionInitialized = true;
        hackerNotifierSaveSettings();
    }
}

function hackerNotifierRefreshOrganizations(quiet = false) {
    return msApiP('GET', '/entity/organization?order=name&limit=100')
        .then(data => {
            hackerNotifierOrganizations = (Array.isArray(data?.rows) ? data.rows : [])
                .map(item => ({ name: item.name, href: item.meta?.href }))
                .filter(item => item.name && item.href);
            hackerNotifierSaveOrganizations();
            hackerNotifierFillControls();
            if (!quiet) hackerLog(`Организации обновлены: ${hackerNotifierOrganizations.length} шт.`, 'ok');
            return hackerNotifierOrganizations;
        })
        .catch(error => {
            if (!quiet) hackerLog('Организации: ' + error.message, 'err');
            hackerNotifierSetStatus('⚠️ Не удалось загрузить организации', 'error');
            return hackerNotifierOrganizations;
        });
}

function hackerNotifierPlayAlarm() {
    try {
        if (!hackerNotifierAudio) hackerNotifierAudio = new Audio(HACKER_NOTIFIER_AUDIO_URL);
        hackerNotifierAudio.currentTime = 0;
        const result = hackerNotifierAudio.play();
        if (result?.catch) result.catch(() => {
            hackerNotifierSetStatus('⚠️ Браузер заблокировал звук — нажмите «Тест сигнала»', 'error');
            hackerLog('Звук заблокирован браузером; разрешите воспроизведение кнопкой «Тест сигнала»', 'warn');
        });
    } catch (error) {
        hackerLog('Звук: ' + error.message, 'err');
    }
}

function hackerNotifierEnsureIndicator() {
    let indicator = document.getElementById('hackerNotifierIndicator');
    if (!hackerNotifierTimer) {
        indicator?.remove();
        return;
    }
    if (indicator) return;
    indicator = document.createElement('span');
    indicator.id = 'hackerNotifierIndicator';
    indicator.textContent = '🐻';
    indicator.title = 'Оповещатель новых заказов включён';
    indicator.setAttribute('aria-label', indicator.title);
    indicator.style.cssText = 'position:fixed;right:14px;bottom:12px;z-index:2147483000;'
        + 'font-size:18px;line-height:1;opacity:.28;filter:grayscale(.35);'
        + 'pointer-events:none;user-select:none;transition:opacity .2s,filter .2s;';
    document.body.appendChild(indicator);
}

function hackerNotifierOrderUrl(order) {
    const id = order?.id;
    if (!id) return '';
    const origin = /(^|\.)online\.moysklad\.ru$/i.test(location.hostname)
        ? location.origin
        : 'https://online.moysklad.ru';
    return `${origin}/app/#customerorder/edit?id=${encodeURIComponent(id)}`;
}

function hackerNotifierShowToast(order) {
    let host = document.getElementById('hackerNotifierToastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'hackerNotifierToastHost';
        host.style.cssText = 'position:fixed;top:18px;right:18px;z-index:2147483002;'
            + 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;'
            + 'width:min(360px,calc(100vw - 36px));pointer-events:none;';
        document.body.appendChild(host);
    }

    const toast = document.createElement('div');
    toast.className = 'hacker-notifier-toast';
    const lifetime = hackerNotifierSettings.soundEnabled ? 5000 : 30000;
    toast.dataset.dismissMs = String(lifetime);
    toast.style.cssText = 'box-sizing:border-box;width:100%;padding:11px 13px 12px;'
        + 'background:linear-gradient(145deg,#111827,#1f2937);'
        + 'border:1px solid rgba(248,113,113,.72);border-left:4px solid #ef4444;'
        + 'border-radius:10px;box-shadow:0 10px 28px rgba(2,6,23,.35);'
        + 'color:#f8fafc;font:12px/1.35 Segoe UI,sans-serif;pointer-events:auto;'
        + 'opacity:0;transform:translateX(22px);transition:opacity .18s ease,transform .18s ease;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:800;font-size:13px;letter-spacing:.25px;color:#fecaca;';
    title.textContent = '⚠️ 🐻🔴 НОВЫЙ ЗАКАЗ';
    const name = document.createElement('div');
    name.style.cssText = 'margin-top:5px;font-weight:700;color:#fff;';
    const orderUrl = hackerNotifierOrderUrl(order);
    if (orderUrl) {
        const link = document.createElement('a');
        link.href = orderUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = order?.name || order?.id || 'Без номера';
        link.title = 'Открыть заказ в новой вкладке';
        link.style.cssText = 'color:#fff;text-decoration:underline;text-decoration-color:#f87171;'
            + 'text-underline-offset:2px;cursor:pointer;';
        name.appendChild(link);
    } else {
        name.textContent = order?.name || 'Без номера';
    }
    const status = document.createElement('div');
    status.style.cssText = 'margin-top:2px;color:#cbd5e1;';
    status.textContent = `Статус: ${order?.stateName || 'Новый'}`;
    toast.append(title, name, status);

    let closed = false;
    let paused = false;
    let dismissTimer = null;
    let remaining = lifetime;
    let timerStartedAt = Date.now();
    const removeToast = () => {
        if (closed) return;
        closed = true;
        if (dismissTimer) window.clearTimeout(dismissTimer);
        toast.remove();
        if (!host.children.length) host.remove();
    };
    const fadeToast = () => {
        if (closed) return;
        closed = true;
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(22px)';
        window.setTimeout(() => {
            toast.remove();
            if (!host.children.length) host.remove();
        }, 220);
    };
    const scheduleDismiss = () => {
        if (closed || paused) return;
        timerStartedAt = Date.now();
        dismissTimer = window.setTimeout(fadeToast, remaining);
    };
    toast.addEventListener('mouseenter', () => {
        if (closed || paused) return;
        paused = true;
        toast.dataset.timerPaused = 'true';
        if (dismissTimer) window.clearTimeout(dismissTimer);
        remaining = Math.max(0, remaining - (Date.now() - timerStartedAt));
    });
    toast.addEventListener('mouseleave', () => {
        if (closed || !paused) return;
        paused = false;
        toast.dataset.timerPaused = 'false';
        scheduleDismiss();
    });
    if (!hackerNotifierSettings.soundEnabled) {
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.title = 'Закрыть уведомление';
        close.style.cssText = 'position:absolute;top:5px;right:7px;padding:0;border:0;'
            + 'background:transparent;color:#fecaca;font-size:15px;line-height:1;cursor:pointer;';
        close.addEventListener('click', removeToast);
        toast.style.position = 'relative';
        toast.appendChild(close);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = 'Закрыть';
        closeButton.style.cssText = 'margin-top:8px;padding:3px 8px;border:1px solid #64748b;'
            + 'border-radius:5px;background:#334155;color:#f8fafc;font-size:10px;cursor:pointer;';
        closeButton.addEventListener('click', removeToast);
        toast.appendChild(closeButton);
    }
    host.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
    });
    scheduleDismiss();
}

function hackerNotifierTrace(message, details = null, kind = 'info') {
    const prefix = '[Memchat:notifier]';
    if (kind === 'error') console.error(prefix, message, details || '');
    else if (kind === 'warn') console.warn(prefix, message, details || '');
    else console.info(prefix, message, details || '');
    hackerLog(`🔎 ${message}`, kind === 'error' ? 'err' : kind);
}

function hackerNotifierSelectedStatusNames() {
    return hackerNotifierSettings.statusHrefs
        .map(href => hackerStates.find(state => state.href === href)?.name)
        .filter(Boolean);
}

function hackerNotifierPoll() {
    if (hackerNotifierInFlight) {
        hackerNotifierTrace('Проверка пропущена: предыдущий запрос ещё выполняется', null, 'warn');
        return Promise.resolve([]);
    }
    if (!hackerNotifierSettings.enabled) {
        hackerNotifierTrace('Проверка пропущена: оповещатель выключен', null, 'warn');
        return Promise.resolve([]);
    }
    if (!hackerNotifierSettings.organizationHref) {
        hackerNotifierTrace('Проверка пропущена: организация не выбрана', null, 'warn');
        return Promise.resolve([]);
    }
    if (!hackerNotifierSettings.statusHrefs.length) {
        hackerNotifierTrace('Проверка пропущена: статусы для оповещения не выбраны', null, 'warn');
        return Promise.resolve([]);
    }
    if (!hackerApiValidated) {
        hackerNotifierTrace('Проверка пропущена: API-ключ ещё не подтверждён', null, 'warn');
        return Promise.resolve([]);
    }
    hackerNotifierInFlight = true;
    const organizationHref = hackerNotifierSettings.organizationHref;
    const filter = encodeURIComponent('organization=' + organizationHref);
    const path = `/entity/customerorder?filter=${filter}&expand=state&order=moment,desc&limit=100`;
    const selectedStatusNames = hackerNotifierSelectedStatusNames();
    hackerNotifierTrace('Запрос заказов', {
        organizationHref,
        statusHrefs: hackerNotifierSettings.statusHrefs,
        statusNames: selectedStatusNames,
        path
    });
    return msApiP('GET', path)
        .then(data => {
            const rows = Array.isArray(data?.rows) ? data.rows : [];
            const saved = hackerNotifierSeenByOrganization[organizationHref];
            const bucket = saved && typeof saved === 'object' && saved.orders && typeof saved.orders === 'object'
                ? saved
                : { initialized: false, orders: {} };
            const matchingOrders = [];
            const stateCounts = {};

            rows.forEach(order => {
                const id = order?.id || order?.meta?.href;
                if (!id) return;
                const stateHref = order.state?.meta?.href || '';
                const stateName = order.state?.name || 'без статуса';
                const stateKey = `${stateName} [${stateHref || 'без href'}]`;
                stateCounts[stateKey] = (stateCounts[stateKey] || 0) + 1;
                const matchesByHref = hackerNotifierSettings.statusHrefs.includes(stateHref);
                const matchesByName = selectedStatusNames.some(name =>
                    String(name).trim().toLowerCase() === String(stateName).trim().toLowerCase());
                const matches = matchesByHref || matchesByName;
                if (matches) matchingOrders.push({ id, name: order.name || id, stateName, stateHref });
                bucket.orders[id] = { stateHref, stateName, updatedAt: Date.now() };
            });

            bucket.initialized = true;
            bucket.orders = Object.fromEntries(Object.entries(bucket.orders)
                .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
                .slice(0, 500));
            hackerNotifierSeenByOrganization[organizationHref] = bucket;
            hackerNotifierSaveSeen();

            hackerNotifierTrace('Ответ получен', {
                httpStatus: data?._status || 'unknown',
                totalRows: rows.length,
                stateCounts,
                matchingOrders: matchingOrders.map(order => ({
                    id: order.id,
                    name: order.name,
                    stateName: order.stateName,
                    stateHref: order.stateHref
                }))
            });
            if (matchingOrders.length) {
                matchingOrders.forEach(order => {
                    hackerLog(`🔔 Заказ ${order.name} — ${order.stateName}`, 'ok');
                    hackerNotifierShowToast(order);
                });
                if (hackerNotifierSettings.soundEnabled) hackerNotifierPlayAlarm();
                hackerNotifierSetStatus(`🔔 Заказов в выбранных статусах: ${matchingOrders.length}`, 'ok');
            } else {
                hackerNotifierTrace('Совпадений по выбранным статусам нет', {
                    totalRows: rows.length,
                    selectedStatusNames,
                    selectedStatusHrefs: hackerNotifierSettings.statusHrefs
                }, 'warn');
                hackerNotifierSetStatus(`Проверено: ${new Date().toLocaleTimeString()} — совпадений нет`, 'info');
            }
            return matchingOrders;
        })
        .catch(error => {
            hackerNotifierTrace('Ошибка запроса', { message: error?.message || String(error), error }, 'error');
            hackerNotifierSetStatus('⚠️ Ошибка проверки: ' + error.message, 'error');
            return [];
        })
        .finally(() => { hackerNotifierInFlight = false; });
}

function hackerNotifierStop() {
    if (hackerNotifierTimer) clearInterval(hackerNotifierTimer);
    hackerNotifierTimer = null;
    hackerNotifierEnsureIndicator();
}

function hackerNotifierStart() {
    hackerNotifierStop();
    if (!hackerApiValidated || !hackerNotifierSettings.enabled || !hackerNotifierSettings.organizationHref) return;
    hackerNotifierTimer = setInterval(hackerNotifierPoll, hackerNotifierSettings.intervalMinutes * 60 * 1000);
    hackerNotifierEnsureIndicator();
    hackerNotifierTrace('Таймер запущен', {
        intervalMinutes: hackerNotifierSettings.intervalMinutes,
        organizationHref: hackerNotifierSettings.organizationHref,
        statusHrefs: hackerNotifierSettings.statusHrefs,
        statusNames: hackerNotifierSelectedStatusNames()
    });
}

function hackerNotifierMaybeStart() {
    hackerNotifierSelectDefaultStatus();
    hackerNotifierStart();
}

function hackerNotifierReadControls() {
    const enabled = document.getElementById('hackerNotifierEnabled');
    const soundEnabled = document.getElementById('hackerNotifierSoundEnabled');
    const organization = document.getElementById('hackerNotifierOrganization');
    const statuses = document.getElementById('hackerNotifierStatuses');
    const interval = document.getElementById('hackerNotifierInterval');
    hackerNotifierSettings = hackerNotifierNormalizeSettings({
        enabled: enabled?.checked,
        soundEnabled: soundEnabled ? soundEnabled.checked : hackerNotifierSettings.soundEnabled,
        organizationHref: organization?.value || '',
        statusHrefs: statuses ? [...statuses.selectedOptions].map(option => option.value) : hackerNotifierSettings.statusHrefs,
        intervalMinutes: interval?.value
    });
    hackerNotifierStatusSelectionInitialized = true;
    hackerNotifierSaveSettings();
    hackerNotifierMaybeStart();
}

function hackerBuildNotifierTab() {
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabNotifier';

    wrap.appendChild(hackerEl('div', 'font-size:11px;color:#64748b;line-height:1.4;margin-bottom:7px;',
        'Проверяет заказы выбранной организации по таймеру и подаёт сигнал на каждом опросе, пока заказ находится в выбранном статусе.'));

    const enabledLabel = hackerEl('label', 'display:flex;align-items:center;gap:7px;font-size:11.5px;color:#475569;margin-bottom:7px;cursor:pointer;');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.id = 'hackerNotifierEnabled';
    enabled.style.accentColor = '#6366f1';
    enabledLabel.appendChild(enabled);
    enabledLabel.appendChild(document.createTextNode('Включить оповещатель'));
    wrap.appendChild(enabledLabel);

    const soundLabel = hackerEl('label', 'display:flex;align-items:center;gap:7px;font-size:11.5px;color:#475569;margin-bottom:7px;cursor:pointer;');
    const soundEnabled = document.createElement('input');
    soundEnabled.type = 'checkbox';
    soundEnabled.id = 'hackerNotifierSoundEnabled';
    soundEnabled.style.accentColor = '#dc2626';
    soundLabel.appendChild(soundEnabled);
    soundLabel.appendChild(document.createTextNode('🔊 Звуковой сигнал'));
    wrap.appendChild(soundLabel);

    const orgRow = hackerEl('div', 'display:flex;gap:4px;margin-bottom:6px;');
    const organization = hackerSelect('hackerNotifierOrganization', '— выберите организацию —');
    organization.style.cssText = HACKER_SELECT_CSS;
    orgRow.appendChild(organization);
    const refreshOrg = hackerBtn('hackerNotifierOrganizationsRefresh', '⟳', HACKER_MINI_BTN_CSS);
    refreshOrg.title = 'Обновить список организаций';
    orgRow.appendChild(refreshOrg);
    wrap.appendChild(orgRow);

    const statusesLabel = hackerEl('label', 'display:block;font-size:11.5px;color:#475569;margin-bottom:6px;', 'Статусы для оповещения:');
    const statuses = document.createElement('select');
    statuses.id = 'hackerNotifierStatuses';
    statuses.multiple = true;
    statuses.size = 4;
    statuses.style.cssText = 'display:block;width:100%;margin-top:3px;padding:4px 6px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;';
    statusesLabel.appendChild(statuses);
    wrap.appendChild(statusesLabel);

    const intervalLabel = hackerEl('label', 'display:flex;align-items:center;gap:5px;font-size:11.5px;color:#475569;margin:5px 0 7px;', 'Интервал, минут:');
    const interval = document.createElement('input');
    interval.id = 'hackerNotifierInterval';
    interval.type = 'number';
    interval.min = '1';
    interval.max = '1440';
    interval.step = '1';
    interval.style.cssText = 'width:70px;padding:4px 6px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;';
    intervalLabel.appendChild(interval);
    wrap.appendChild(intervalLabel);

    const buttons = hackerEl('div', 'display:flex;gap:4px;flex-wrap:wrap;');
    const save = hackerBtn('hackerNotifierSave', '💾 Сохранить и запустить', HACKER_BTN_CSS + 'background:#4f46e5;');
    const poll = hackerBtn('hackerNotifierPollNow', '⟳ Проверить сейчас', HACKER_MINI_BTN_CSS);
    const sound = hackerBtn('hackerNotifierTestSound', '🔊 Тест сигнала', HACKER_MINI_BTN_CSS);
    buttons.append(save, poll, sound);
    wrap.appendChild(buttons);
    const status = hackerEl('div', 'min-height:16px;margin-top:6px;font-size:10.5px;', '');
    status.id = 'hackerNotifierStatus';
    wrap.appendChild(status);

    hackerNotifierFillControls();
    enabled.addEventListener('change', hackerNotifierReadControls);
    soundEnabled.addEventListener('change', hackerNotifierReadControls);
    organization.addEventListener('change', hackerNotifierReadControls);
    statuses.addEventListener('change', hackerNotifierReadControls);
    interval.addEventListener('input', hackerNotifierReadControls);
    interval.addEventListener('change', hackerNotifierReadControls);
    save.addEventListener('click', () => { hackerNotifierReadControls(); hackerNotifierPoll(); });
    poll.addEventListener('click', () => { hackerNotifierReadControls(); hackerNotifierPoll(); });
    sound.addEventListener('click', hackerNotifierPlayAlarm);
    refreshOrg.addEventListener('click', () => hackerNotifierRefreshOrganizations(false));

    hackerNotifierSelectDefaultStatus();
    hackerNotifierFillControls();
    Promise.all([hackerEnsureStates(true), hackerNotifierRefreshOrganizations(true)]).then(() => {
        hackerNotifierSelectDefaultStatus();
        hackerNotifierFillControls();
    }).catch(error => {
        hackerNotifierSetStatus('⚠️ Не удалось загрузить настройки оповещателя', 'error');
        hackerLog('Оповещатель: ' + error.message, 'err');
    });
    return wrap;
}

/* ===== 14-internal-order-check.js ===== */

// ─── Проверка товаров в заказах и внутренних заказах ─────────────────────────
// Сравнивает агрегированные позиции заказов покупателей и внутренних заказов.
const INTERNAL_ORDER_CHECK_STORAGE_KEY = 'hackerInternalOrderCheck_v1';
const INTERNAL_ORDER_CHECK_DEFAULT_STATUS = 'Новый';
const INTERNAL_ORDER_CHECK_ENTITIES = {
    customerorder: {
        label: 'Заказы покупателей',
        organizationKey: 'customerOrganizationHref',
        statusKey: 'customerStatusHrefs'
    },
    internalorder: {
        label: 'Внутренние заказы',
        organizationKey: 'internalOrganizationHref',
        statusKey: 'internalStatusHrefs'
    }
};
let internalOrderCheckSettings = {
    customerOrganizationHref: '',
    internalOrganizationHref: '',
    customerWarehouseHref: '',
    internalWarehouseHref: '',
    customerStatusHrefs: [],
    internalStatusHrefs: []
};
let internalOrderCheckStatuses = {
    customerorder: [],
    internalorder: []
};
let internalOrderCheckWarehouses = [];

function internalOrderCheckNormalizeSettings(raw) {
    const list = value => Array.isArray(value)
        ? [...new Set(value.filter(item => typeof item === 'string' && item))]
        : [];
    return {
        customerOrganizationHref: typeof raw?.customerOrganizationHref === 'string' ? raw.customerOrganizationHref : '',
        internalOrganizationHref: typeof raw?.internalOrganizationHref === 'string' ? raw.internalOrganizationHref : '',
        customerWarehouseHref: typeof raw?.customerWarehouseHref === 'string' ? raw.customerWarehouseHref : '',
        internalWarehouseHref: typeof raw?.internalWarehouseHref === 'string' ? raw.internalWarehouseHref : '',
        customerStatusHrefs: list(raw?.customerStatusHrefs),
        internalStatusHrefs: list(raw?.internalStatusHrefs)
    };
}

function internalOrderCheckLoadSettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(storageKey(INTERNAL_ORDER_CHECK_STORAGE_KEY)) || '{}');
        internalOrderCheckSettings = internalOrderCheckNormalizeSettings(raw);
        const warehouses = JSON.parse(localStorage.getItem(storageKey('hackerInternalOrderWarehouses_v1')) || '[]');
        internalOrderCheckWarehouses = Array.isArray(warehouses)
            ? warehouses.filter(item => item && typeof item.name === 'string' && typeof item.href === 'string')
            : [];
    } catch (error) {
        internalOrderCheckSettings = internalOrderCheckNormalizeSettings({});
        internalOrderCheckTrace('Не удалось загрузить настройки сравнения', error, 'err');
    }
}

function internalOrderCheckSaveSettings() {
    try {
        localStorage.setItem(storageKey(INTERNAL_ORDER_CHECK_STORAGE_KEY), JSON.stringify(internalOrderCheckSettings));
    } catch (error) {
        internalOrderCheckTrace('Не удалось сохранить настройки сравнения', error, 'err');
    }
}

function internalOrderCheckSaveWarehouses() {
    try {
        localStorage.setItem(storageKey('hackerInternalOrderWarehouses_v1'), JSON.stringify(internalOrderCheckWarehouses));
    } catch (error) {
        internalOrderCheckTrace('Не удалось сохранить список складов', error, 'err');
    }
}

function internalOrderCheckTrace(message, details = null, kind = 'info') {
    const prefix = '[Memchat:internal-orders]';
    if (kind === 'err') console.error(prefix, message, details || '');
    else if (kind === 'warn') console.warn(prefix, message, details || '');
    else console.info(prefix, message, details || '');
    if (typeof hackerLog === 'function') hackerLog(`📦 ${message}`, kind === 'err' ? 'err' : kind);
}

function internalOrderCheckStatusesFromMetadata(data) {
    const states = Array.isArray(data?.states) ? data.states : (Array.isArray(data?.states?.rows) ? data.states.rows : []);
    return states.map(state => ({
        name: state.name,
        href: state.meta?.href
    })).filter(state => state.name && state.href);
}

function internalOrderCheckFillOrganizations() {
    [
        ['hackerInternalCustomerOrganization', 'customerOrganizationHref'],
        ['hackerInternalOrderOrganization', 'internalOrganizationHref']
    ].forEach(([id, key]) => {
        const select = document.getElementById(id);
        if (!select) return;
        const selected = internalOrderCheckSettings[key];
        const organizations = Array.isArray(hackerNotifierOrganizations) ? hackerNotifierOrganizations : [];
        select.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = organizations.length
            ? '— выберите организацию —'
            : '— нажмите «Загрузить справочники» —';
        select.appendChild(empty);
        organizations.forEach(item => {
            const option = document.createElement('option');
            option.value = item.href;
            option.textContent = item.name;
            option.selected = item.href === selected;
            select.appendChild(option);
        });
        select.value = selected;
    });
}

function internalOrderCheckFillWarehouses() {
    [
        ['hackerInternalCustomerWarehouse', 'customerWarehouseHref'],
        ['hackerInternalOrderWarehouse', 'internalWarehouseHref']
    ].forEach(([id, key]) => {
        const select = document.getElementById(id);
        if (!select) return;
        const selected = internalOrderCheckSettings[key];
        const warehouses = Array.isArray(internalOrderCheckWarehouses) ? internalOrderCheckWarehouses : [];
        select.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = warehouses.length
            ? '— выберите склад —'
            : '— нажмите «Загрузить справочники» —';
        select.appendChild(empty);
        warehouses.forEach(item => {
            const option = document.createElement('option');
            option.value = item.href;
            option.textContent = item.name;
            option.selected = item.href === selected;
            select.appendChild(option);
        });
        select.value = selected;
    });
}

function internalOrderCheckFillStatuses(entity) {
    const config = INTERNAL_ORDER_CHECK_ENTITIES[entity];
    const select = document.getElementById(entity === 'customerorder'
        ? 'hackerInternalCustomerStatuses'
        : 'hackerInternalOrderStatuses');
    if (!config || !select) return;
    const selected = internalOrderCheckSettings[config.statusKey];
    select.innerHTML = '';
    internalOrderCheckStatuses[entity].forEach(item => {
        const option = document.createElement('option');
        option.value = item.href;
        option.textContent = item.name;
        option.selected = selected.includes(item.href);
        select.appendChild(option);
    });
    if (!internalOrderCheckStatuses[entity].length) {
        const hint = document.createElement('option');
        hint.disabled = true;
        hint.textContent = '— нажмите «Загрузить справочники» —';
        select.appendChild(hint);
    }
    if (!selected.length) {
        const defaultState = internalOrderCheckStatuses[entity].find(item =>
            String(item.name).trim().toLowerCase() === INTERNAL_ORDER_CHECK_DEFAULT_STATUS.toLowerCase());
        if (defaultState) {
            const option = [...select.options].find(item => item.value === defaultState.href);
            if (option) option.selected = true;
            internalOrderCheckSettings[config.statusKey] = [defaultState.href];
            internalOrderCheckSaveSettings();
        }
    }
}

function internalOrderCheckReadControls() {
    const customerOrganization = document.getElementById('hackerInternalCustomerOrganization');
    const internalOrganization = document.getElementById('hackerInternalOrderOrganization');
    const customerWarehouse = document.getElementById('hackerInternalCustomerWarehouse');
    const internalWarehouse = document.getElementById('hackerInternalOrderWarehouse');
    const customerStatuses = document.getElementById('hackerInternalCustomerStatuses');
    const internalStatuses = document.getElementById('hackerInternalOrderStatuses');
    internalOrderCheckSettings = internalOrderCheckNormalizeSettings({
        customerOrganizationHref: customerOrganization?.value || '',
        internalOrganizationHref: internalOrganization?.value || '',
        customerWarehouseHref: customerWarehouse?.value || '',
        internalWarehouseHref: internalWarehouse?.value || '',
        customerStatusHrefs: customerStatuses
            ? [...customerStatuses.selectedOptions].map(option => option.value)
            : internalOrderCheckSettings.customerStatusHrefs,
        internalStatusHrefs: internalStatuses
            ? [...internalStatuses.selectedOptions].map(option => option.value)
            : internalOrderCheckSettings.internalStatusHrefs
    });
    internalOrderCheckSaveSettings();
}

function internalOrderCheckRefreshStatuses(entity) {
    const path = `/entity/${entity}/metadata`;
    return msApiP('GET', path)
        .then(data => {
            internalOrderCheckStatuses[entity] = internalOrderCheckStatusesFromMetadata(data);
            internalOrderCheckFillStatuses(entity);
            internalOrderCheckTrace(`${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}: статусы обновлены — ${internalOrderCheckStatuses[entity].length}`);
            return internalOrderCheckStatuses[entity];
        })
        .catch(error => {
            internalOrderCheckTrace(`${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}: не удалось загрузить статусы`, error, 'err');
            return internalOrderCheckStatuses[entity];
        });
}

function internalOrderCheckRefreshOrganizations() {
    return hackerNotifierRefreshOrganizations(true)
        .then(items => {
            internalOrderCheckFillOrganizations();
            internalOrderCheckTrace(`Организации обновлены для двух типов документов: ${items.length} шт.`);
            return items;
        });
}

function internalOrderCheckRefreshWarehouses() {
    return msApiP('GET', '/entity/store?order=name&limit=1000')
        .then(data => {
            internalOrderCheckWarehouses = (Array.isArray(data?.rows) ? data.rows : [])
                .map(item => ({ name: item.name, href: item.meta?.href }))
                .filter(item => item.name && item.href);
            internalOrderCheckSaveWarehouses();
            internalOrderCheckFillWarehouses();
            internalOrderCheckTrace(`Склады обновлены: ${internalOrderCheckWarehouses.length} шт.`);
            return internalOrderCheckWarehouses;
        })
        .catch(error => {
            internalOrderCheckTrace('Не удалось загрузить склады', error, 'err');
            return internalOrderCheckWarehouses;
        });
}

function internalOrderCheckRefreshAllLists(status) {
    if (!hackerBearerEnabled || !hackerBearerToken.trim()) {
        const message = 'Для загрузки организаций, складов и статусов включите Bearer и укажите API-ключ МойСклад.';
        if (status) {
            status.textContent = message;
            status.style.color = '#b45309';
        }
        internalOrderCheckTrace(message, null, 'warn');
        return Promise.resolve([]);
    }
    return Promise.all([
        internalOrderCheckRefreshOrganizations(),
        internalOrderCheckRefreshWarehouses(),
        internalOrderCheckRefreshStatuses('customerorder'),
        internalOrderCheckRefreshStatuses('internalorder')
    ]);
}

function internalOrderCheckStateNames(entity, statusHrefs) {
    return statusHrefs
        .map(href => internalOrderCheckStatuses[entity].find(state => state.href === href)?.name)
        .filter(Boolean);
}

function internalOrderCheckMatchesStatus(row, statusHrefs, statusNames) {
    const stateHref = row?.state?.meta?.href || '';
    const stateName = String(row?.state?.name || '').trim().toLowerCase();
    return statusHrefs.includes(stateHref) || statusNames.some(name => String(name).trim().toLowerCase() === stateName);
}

function internalOrderCheckMatchesWarehouse(entity, row, warehouseHref) {
    const references = entity === 'customerorder'
        ? [row?.store, row?.warehouse]
        : [row?.sourceStore, row?.targetStore, row?.store];
    return references.some(reference => reference?.meta?.href === warehouseHref);
}

function internalOrderCheckFetchDocuments(entity, organizationHref, warehouseHref, statusHrefs) {
    if (!organizationHref) return Promise.reject(new Error(`Не выбрана организация: ${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}`));
    if (!warehouseHref) return Promise.reject(new Error(`Не выбран склад: ${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}`));
    if (!statusHrefs.length) return Promise.reject(new Error(`Не выбраны статусы: ${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}`));
    const filter = encodeURIComponent('organization=' + organizationHref);
    const path = `/entity/${entity}?filter=${filter}&expand=state,store,sourceStore,targetStore&order=moment,desc&limit=1000`;
    const statusNames = internalOrderCheckStateNames(entity, statusHrefs);
    internalOrderCheckTrace(`Получаю ${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}`, {
        organizationHref,
        warehouseHref,
        statusHrefs,
        statusNames,
        path
    });
    return msApiP('GET', path).then(data => {
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        const matching = rows.filter(row =>
            internalOrderCheckMatchesStatus(row, statusHrefs, statusNames)
            && internalOrderCheckMatchesWarehouse(entity, row, warehouseHref));
        internalOrderCheckTrace(`${INTERNAL_ORDER_CHECK_ENTITIES[entity].label}: найдено документов — ${matching.length}`, {
            totalRows: rows.length,
            matchingNames: matching.map(row => row.name || row.id)
        });
        return matching;
    });
}

function internalOrderCheckPositionRows(entity, document) {
    if (Array.isArray(document?.positions?.rows)) return Promise.resolve(document.positions.rows);
    const id = document?.id || document?.meta?.href?.split('/').pop();
    if (!id) return Promise.resolve([]);
    return msApiP('GET', `/entity/${entity}/${id}/positions?expand=assortment&limit=1000`)
        .then(data => Array.isArray(data?.rows) ? data.rows : []);
}

function internalOrderCheckPositionKey(position) {
    const assortment = position?.assortment || position?.product || {};
    return assortment.meta?.href || assortment.id || `name:${String(assortment.name || position?.name || 'Без названия').trim().toLowerCase()}`;
}

function internalOrderCheckPositionName(position) {
    const assortment = position?.assortment || position?.product || {};
    return assortment.name || position?.name || 'Без названия';
}

function internalOrderCheckAggregate(rows) {
    const result = {};
    rows.forEach(position => {
        const key = internalOrderCheckPositionKey(position);
        const quantity = Number(position?.quantity);
        const safeQuantity = Number.isFinite(quantity) ? quantity : 0;
        if (!result[key]) result[key] = { key, name: internalOrderCheckPositionName(position), quantity: 0 };
        result[key].quantity += safeQuantity;
    });
    return result;
}

function internalOrderCheckCompareMaps(customerGoods, internalGoods) {
    const keys = new Set([...Object.keys(customerGoods), ...Object.keys(internalGoods)]);
    const added = [];
    const missed = [];
    keys.forEach(key => {
        const customer = customerGoods[key] || { key, name: internalGoods[key]?.name || key, quantity: 0 };
        const internal = internalGoods[key] || { key, name: customer.name, quantity: 0 };
        const difference = internal.quantity - customer.quantity;
        if (difference > 0) added.push({ key, name: internal.name, quantity: difference, internalQuantity: internal.quantity, customerQuantity: customer.quantity });
        if (difference < 0) missed.push({ key, name: customer.name, quantity: Math.abs(difference), internalQuantity: internal.quantity, customerQuantity: customer.quantity });
    });
    return {
        added: added.sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        missed: missed.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    };
}

function internalOrderCheckFormatGoods(items) {
    return items.length
        ? items.map(item => `${item.name} × ${item.quantity}`).join('; ')
        : 'нет';
}

async function internalOrderCheckCollectGoods(entity, documents) {
    const goods = [];
    for (const document of documents) {
        try {
            const positions = await internalOrderCheckPositionRows(entity, document);
            goods.push(...positions);
            internalOrderCheckTrace(`${document.name || document.id}: получено позиций — ${positions.length}`);
        } catch (error) {
            internalOrderCheckTrace(`${document.name || document.id}: не удалось получить позиции`, error, 'err');
        }
    }
    return internalOrderCheckAggregate(goods);
}

async function internalOrderCheckCompare() {
    internalOrderCheckReadControls();
    const status = document.getElementById('hackerInternalOrderCheckStatus');
    const setStatus = (message, kind = 'info') => {
        if (status) {
            status.textContent = message;
            status.style.color = kind === 'err' ? '#b91c1c' : kind === 'warn' ? '#b45309' : '#166534';
        }
    };
    const compare = document.getElementById('hackerInternalOrderCompare');
    if (compare) compare.disabled = true;
    setStatus('Проверяю документы и позиции…');
    try {
        const [customerOrders, internalOrders] = await Promise.all([
            internalOrderCheckFetchDocuments('customerorder', internalOrderCheckSettings.customerOrganizationHref, internalOrderCheckSettings.customerWarehouseHref, internalOrderCheckSettings.customerStatusHrefs),
            internalOrderCheckFetchDocuments('internalorder', internalOrderCheckSettings.internalOrganizationHref, internalOrderCheckSettings.internalWarehouseHref, internalOrderCheckSettings.internalStatusHrefs)
        ]);
        const [customerGoods, internalGoods] = await Promise.all([
            internalOrderCheckCollectGoods('customerorder', customerOrders),
            internalOrderCheckCollectGoods('internalorder', internalOrders)
        ]);
        const result = internalOrderCheckCompareMaps(customerGoods, internalGoods);
        const customerTotal = Object.values(customerGoods).reduce((sum, item) => sum + item.quantity, 0);
        const internalTotal = Object.values(internalGoods).reduce((sum, item) => sum + item.quantity, 0);
        internalOrderCheckTrace('Сравнение завершено', {
            customerOrders: customerOrders.length,
            internalOrders: internalOrders.length,
            customerPositions: customerTotal,
            internalPositions: internalTotal,
            added: result.added,
            missed: result.missed
        });
        internalOrderCheckTrace(`➕ Добавлено во внутренних заказах: ${internalOrderCheckFormatGoods(result.added)}`, result.added.length ? result.added : null, result.added.length ? 'info' : 'warn');
        internalOrderCheckTrace(`⚠️ Упущено во внутренних заказах: ${internalOrderCheckFormatGoods(result.missed)}`, result.missed.length ? result.missed : null, result.missed.length ? 'warn' : 'info');
        if (!result.added.length && !result.missed.length) internalOrderCheckTrace('✅ Списки товаров совпадают', null, 'info');
        setStatus(`Готово: добавлено ${result.added.length}, упущено ${result.missed.length}`);
        return result;
    } catch (error) {
        internalOrderCheckTrace('Сравнение не выполнено', error, 'err');
        setStatus(error.message || String(error), 'err');
        return null;
    } finally {
        if (compare) compare.disabled = false;
    }
}

function hackerBuildInternalOrderCheckTab() {
    internalOrderCheckLoadSettings();
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabInternalOrderCheck';
    wrap.appendChild(hackerEl('div', 'font-size:11px;color:#64748b;line-height:1.4;margin-bottom:7px;',
        'Сравнивает товары из заказов покупателей с товарами из внутренних заказов по выбранным организациям и статусам.'));

    const field = (label, select) => {
        const block = hackerEl('label', 'display:block;font-size:11px;color:#475569;margin-bottom:7px;', label);
        block.appendChild(select);
        return block;
    };
    const customerOrganization = hackerSelect('hackerInternalCustomerOrganization', '— организация заказов —');
    const internalOrganization = hackerSelect('hackerInternalOrderOrganization', '— организация внутренних заказов —');
    const customerWarehouse = hackerSelect('hackerInternalCustomerWarehouse', '— склад заказов —');
    const internalWarehouse = hackerSelect('hackerInternalOrderWarehouse', '— склад внутренних заказов —');
    const customerStatuses = document.createElement('select');
    customerStatuses.id = 'hackerInternalCustomerStatuses';
    customerStatuses.multiple = true;
    customerStatuses.size = 4;
    customerStatuses.style.cssText = 'display:block;width:100%;margin-top:3px;padding:4px 6px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;';
    const internalStatuses = customerStatuses.cloneNode(false);
    internalStatuses.id = 'hackerInternalOrderStatuses';

    wrap.appendChild(field('Организация заказов:', customerOrganization));
    wrap.appendChild(field('Организация внутренних заказов:', internalOrganization));
    wrap.appendChild(field('Склад заказов:', customerWarehouse));
    wrap.appendChild(field('Склад внутренних заказов:', internalWarehouse));
    wrap.appendChild(field('Статусы заказов:', customerStatuses));
    wrap.appendChild(field('Статусы внутренних заказов:', internalStatuses));

    const buttons = hackerEl('div', 'display:flex;gap:4px;flex-wrap:wrap;');
    const refresh = hackerBtn('hackerInternalOrderRefresh', '⬇ Загрузить справочники', HACKER_MINI_BTN_CSS);
    const compare = hackerBtn('hackerInternalOrderCompare', '🔎 Проверить товары', HACKER_BTN_CSS + 'background:#4f46e5;');
    buttons.append(refresh, compare);
    wrap.appendChild(buttons);
    const status = hackerEl('div', 'min-height:16px;margin-top:6px;font-size:10.5px;', '');
    status.id = 'hackerInternalOrderCheckStatus';
    wrap.appendChild(status);

    internalOrderCheckFillOrganizations();
    internalOrderCheckFillWarehouses();
    internalOrderCheckFillStatuses('customerorder');
    internalOrderCheckFillStatuses('internalorder');
    customerOrganization.addEventListener('change', internalOrderCheckReadControls);
    internalOrganization.addEventListener('change', internalOrderCheckReadControls);
    customerWarehouse.addEventListener('change', internalOrderCheckReadControls);
    internalWarehouse.addEventListener('change', internalOrderCheckReadControls);
    customerStatuses.addEventListener('change', internalOrderCheckReadControls);
    internalStatuses.addEventListener('change', internalOrderCheckReadControls);
    refresh.addEventListener('click', () => {
        internalOrderCheckRefreshAllLists(status)
            .catch(error => internalOrderCheckTrace('Не удалось обновить списки', error, 'err'));
    });
    compare.addEventListener('click', () => { internalOrderCheckCompare().catch(error => internalOrderCheckTrace('Сравнение: ' + error.message, error, 'err')); });
    internalOrderCheckRefreshAllLists(status)
        .catch(error => internalOrderCheckTrace('Не удалось загрузить списки для сравнения', error, 'err'));
    return wrap;
}

// ─── Production entrypoint ───────────────────────────────────────────────────
initialize();
