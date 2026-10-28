(async () => {
'use strict';
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
/* module: extension/panel-tab-content.js */
// Runs only in the isolated extension world of an existing top-level Panel tab.
// Capture native fetch: the business transport's lexical fetch is a worker proxy.
const panelTabNativeFetch = globalThis.fetch.bind(globalThis);
const panelTabInstance = globalThis.crypto.randomUUID();
const panelTabControllers = new Map();
function panelTabReadRequest(request) {
    try {
        const url = new URL(request?.url);
        if (url.origin !== 'https://panel.hatiko.ru' || url.username || url.password || url.hash || url.search) return false;
        const method = String(request.method || 'GET').toUpperCase();
        return (method === 'GET' && (url.pathname === '/api/search/filters' || /^\/api\/bonuses\/check\/\d{1,20}$/.test(url.pathname)))
            || (method === 'POST' && url.pathname === '/api/search' && typeof request.data === 'string' && request.data.length <= 32768);
    } catch { return false; }
}
async function panelTabFetch(url, options, signal) {
    return panelTabNativeFetch(url, { ...options, credentials: 'include', cache: 'no-store', redirect: 'error', signal });
}
async function panelTabSession(signal) {
    const html = await panelTabFetch('/search', { headers: { Accept: 'text/html' } }, signal);
    const body = await html.text();
    if (!html.ok || /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body)) return { ok: false, reason: 'auth' };
    const parsed = new DOMParser().parseFromString(body, 'text/html');
    const token = parsed.querySelector('meta[name="csrf-token"]')?.content || '';
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) return { ok: false, reason: 'auth' };
    const auth = await panelTabFetch('/api/search/filters', { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }, signal);
    if (!auth.ok || !/application\/json/i.test(auth.headers.get('content-type') || '')) return { ok: false, reason: 'auth' };
    const proof = await auth.json();
    if (!proof || typeof proof !== 'object') return { ok: false, reason: 'auth' };
    return { ok: true, token, instance: panelTabInstance };
}
async function panelTabRequest(request, signal) {
    if (!panelTabReadRequest(request)) return { ok: false, reason: 'invalid' };
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    const csrf = new Headers(request.headers || {}).get('X-CSRF-TOKEN');
    if (csrf && /^[A-Za-z0-9_-]{16,512}$/.test(csrf)) headers['X-CSRF-TOKEN'] = csrf;
    if (request.method === 'POST') headers['Content-Type'] = 'application/json';
    const response = await panelTabFetch(request.url, { method: request.method || 'GET', headers, body: request.data }, signal);
    const responseText = await response.text();
    const contentType = response.headers.get('content-type') || '';
    return { ok: true, instance: panelTabInstance, result: { event: 'load', response: {
        status: response.ok && !/application\/json/i.test(contentType) ? 401 : response.status,
        statusText: response.statusText, responseText, response: responseText,
        responseHeaders: 'content-type: ' + contentType, finalUrl: request.url, readyState: 4
    } } };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'memchat:panel-tab' || location.origin !== 'https://panel.hatiko.ru' || window !== window.top
        || sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('worker.js'))
        || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id)) return false;
    if (message.operation === 'cancel') { panelTabControllers.get(message.id)?.abort(); respond({ ok: true }); return false; }
    if (!['session', 'request'].includes(message.operation) || (message.operation === 'request' && message.instance !== panelTabInstance)) {
        respond({ ok: false, reason: 'document' }); return false;
    }
    const controller = new AbortController();
    panelTabControllers.set(message.id, controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    const work = message.operation === 'session' ? panelTabSession(controller.signal) : panelTabRequest(message.request, controller.signal);
    work.then(result => respond(controller.signal.aborted ? { ok: false, reason: 'network' } : result),
        () => respond({ ok: false, reason: 'network' })).finally(() => {
        clearTimeout(timer); if (panelTabControllers.get(message.id) === controller) panelTabControllers.delete(message.id);
    });
    return true;
});
window.addEventListener('pagehide', () => { for (const controller of panelTabControllers.values()) controller.abort(); });
/* module: extension/storage-content.js */
// A synchronous Storage-shaped cache for the unchanged core. Only the worker
// persists it; websites cannot read chrome.storage or receive StorageEvents.
const extensionStorageGate = { ready: false, error: false };
extensionStorageGate.promise = new Promise(resolve => { extensionStorageGate.finish = resolve; });
let extensionStorageOnError = () => {};
let extensionStorageOnChange = () => {};
let extensionStorageFailed = false;
const extensionStorageItems = Object.create(null);
function extensionStorageError() {
    extensionStorageFailed = true;
    extensionStorageOnError();
    if (typeof document === 'undefined' || document.getElementById('memchatStorageError')) return;
    const warning = document.createElement('div'); warning.id = 'memchatStorageError';
    warning.setAttribute('role', 'alert');
    warning.textContent = 'Memchat: данные не сохранены или изменены в другой вкладке. Перезагрузите вкладку. Хранилище сайта не используется.';
    warning.style.cssText = 'position:fixed;top:4px;left:8px;right:8px;z-index:2147483647;padding:10px;background:#fff1f2;color:#9f1239;border:1px solid #fb7185;border-radius:8px;font:13px/1.4 sans-serif;';
    document.body?.appendChild(warning);
}
function extensionApplyStorageItem(key, item) {
    if (!MEMCHAT_STORAGE_KEYS.has(key) || !item || !Number.isSafeInteger(item.revision)
        || (item.value !== null && typeof item.value !== 'string')) return;
    if ((extensionStorageItems[key]?.revision || 0) > item.revision) return;
    extensionStorageItems[key] = item;
    extensionStorageOnChange(key);
}
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'memchat:storage-changed' || sender.id !== chrome.runtime.id || sender.tab
        || (sender.url && sender.url !== chrome.runtime.getURL('worker.js'))) return false;
    extensionApplyStorageItem(message.key, message.item);
    return false;
});
async function extensionInitStorage() {
    const pageStorage = window.localStorage;
    const legacy = {};
    for (const key of [...MEMCHAT_STORAGE_KEYS, ...MEMCHAT_RETIRED_STORAGE_KEYS]) {
        const value = pageStorage.getItem(key);
        if (value !== null) legacy[key] = value;
    }
    const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'memchat:storage-init', legacy }, reply => {
            if (chrome.runtime.lastError || !reply?.ok) reject(Error('Хранилище расширения недоступно'));
            else resolve(reply);
        });
    });
    for (const [key, item] of Object.entries(result.items)) extensionApplyStorageItem(key, item);
    // Do not delete a value concurrently changed by a still-enabled userscript.
    for (const key of result.cleanup) {
        if (Object.hasOwn(legacy, key) && pageStorage.getItem(key) === legacy[key]) pageStorage.removeItem(key);
    }
    function change(key, raw) {
        key = String(key);
        if (MEMCHAT_RETIRED_STORAGE_KEYS.has(key)) return;
        if (!MEMCHAT_STORAGE_KEYS.has(key) || extensionStorageFailed) throw Error('Хранилище Memchat недоступно');
        const value = raw === null ? null : extensionSanitizeStoredValue(key, String(raw));
        const previous = extensionStorageItems[key] || { value: null, revision: 0 };
        if (previous.value === value) return;
        extensionStorageItems[key] = { value, revision: previous.revision + 1 };
        // Send immediately, not from a debounced page timer that can die on unload.
        try { chrome.runtime.sendMessage({ type: 'memchat:storage-write', key, value,
            revision: previous.revision, previousValue: previous.value }, reply => {
            if (chrome.runtime.lastError || !reply?.ok) { extensionStorageError(); return; }
            extensionApplyStorageItem(key, reply.item);
        }); } catch { extensionStorageError(); }
    }
    return Object.freeze({
        getItem: key => extensionStorageItems[String(key)]?.value ?? null,
        setItem: (key, value) => change(key, String(value)),
        removeItem: key => change(key, null),
        key: index => Object.keys(extensionStorageItems).filter(key => extensionStorageItems[key].value !== null)[index] ?? null,
        get length() { return Object.values(extensionStorageItems).filter(item => item.value !== null).length; }
    });
}
try {
/* module: extension/bridge.js */
// This file and the production userscript share one isolated-world IIFE.
let extensionRequestSequence = 0;
const extensionRequestGuards = new Map();

function GM_xmlhttpRequest(options) {
    const id = `req-${Date.now()}-${++extensionRequestSequence}`;
    let finished = false;
    const finish = result => {
        if (finished) return;
        finished = true;
        extensionRequestGuards.delete(id);
        if (result?.panelAuthLost && typeof extensionPanelAuthLost === 'function') extensionPanelAuthLost();
        const callback = { load: 'onload', timeout: 'ontimeout', abort: 'onabort', error: 'onerror' }[result?.event] || 'onerror';
        options[callback]?.(result?.response || { status: 0, statusText: result?.error || 'Ошибка расширения Memchat' });
    };
    const request = {};
    if (typeof options.memchatIsCurrent === 'function') {
        extensionRequestGuards.set(id, options.memchatIsCurrent);
        request.credentialGuard = true;
    }
    for (const key of ['method', 'url', 'headers', 'data', 'timeout', 'anonymous', 'responseType']) {
        if (options[key] !== undefined) request[key] = options[key];
    }
    try {
        chrome.runtime.sendMessage({ type: 'memchat:http', id, request }, result => {
            if (chrome.runtime.lastError) finish({ event: 'error', error: 'Расширение обновлено или недоступно. Перезагрузите вкладку.' });
            else finish(result);
        });
    } catch { finish({ event: 'error', error: 'Расширение недоступно. Перезагрузите вкладку.' }); }
    return { abort() {
        if (finished) return;
        // Settle locally even when abort races the worker's initial validation.
        finish({ event: 'abort' });
        try { chrome.runtime.sendMessage({ type: 'memchat:abort', id }, () => { void chrome.runtime.lastError; }); } catch { /* context invalidated */ }
    } };
}

// Avoid nested retry loops: the MV3 worker owns profile-wide GET retries.
GM_xmlhttpRequest.memchatMsScheduler = true;

// Userscript menu registrations are intentionally not exposed by the extension.
// Toolbar toggle and the single action-context menu replace them; no debug item.
function GM_registerMenuCommand() { return null; }

// Only the schedule module uses fetch. Route it through the same privileged
// transport rather than relying on page-origin CORS permissions.
function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({ url: String(url), method: options.method || 'GET', headers: options.headers,
            data: options.body, anonymous: options.credentials === 'omit',
            onload: response => {
                try {
                    const headers = new Headers();
                    for (const line of (response.responseHeaders || '').split(/\r?\n/)) {
                        const colon = line.indexOf(':');
                        if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
                    }
                    resolve(new Response([204, 205, 304].includes(response.status) ? null : response.responseText,
                        { status: response.status, statusText: response.statusText, headers }));
                } catch { reject(new Error('Некорректный ответ расширения Memchat')); }
            },
            onerror: () => reject(new Error('Ошибка сети расширения Memchat')),
            ontimeout: () => reject(new Error('Таймаут расширения Memchat')),
            onabort: () => reject(new Error('Запрос отменён'))
        });
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab
        || (sender.url && sender.url !== chrome.runtime.getURL('worker.js'))) return false;
    if (message?.type === 'memchat:request-current') {
        let current = false;
        try { current = extensionRequestGuards.get(message.id)?.() === true; } catch { /* fail closed */ }
        sendResponse({ current });
        return false;
    }
    if (!['memchat:toggle', 'memchat:reset-position'].includes(message?.type)) return false;
    const control = () => {
        if (typeof extensionStorageGate !== 'undefined' && extensionStorageGate.error) { sendResponse({ ok: false, reason: 'storage' }); return; }
        const conflict = Boolean(document.getElementById('priceCheckContainer') && !window.priceCheckContainer);
        if (conflict) { sendResponse({ ok: false, reason: 'conflict' }); return; }
        try {
            if (message.type === 'memchat:toggle') {
                const main = window.priceCheckContainer;
                if (!main) createPriceCheckWindow();
                else main.style.display = getComputedStyle(main).display === 'none' ? 'flex' : 'none';
            } else {
                resetFloatWindowPos();
                const main = window.priceCheckContainer;
                if (main) Object.assign(main.style, { left: 'auto', top: '14px', right: '14px', bottom: 'auto' });
                document.querySelectorAll('.mc-float-window').forEach(element => {
                    ['left', 'top', 'right', 'bottom'].forEach(key => element.style.removeProperty(key));
                });
            }
            sendResponse({ ok: true });
        } catch {
            sendResponse({ ok: false, reason: 'failed' });
        }
    };
    if (typeof extensionStorageGate !== 'undefined' && !extensionStorageGate.ready) {
        extensionStorageGate.promise.then(control);
        return true;
    }
    control();
    return false;
});
const localStorage = await extensionInitStorage();
/* module: src/00-platform.js */
// Platform capabilities are configured BEFORE initialize(), never patched afterward.
// Standalone/DEV have no extension capabilities; legacy behavior remains local.
const memchatPlatform = { panel: null, directMs: false };
/* module: src/01-config-and-state.js */
'use strict';

const MEMCHAT_VERSION = '8.9.0-alpha.1';

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
let clearTextDelay = 500;
let globalClearKeypressBound = false;
let calcRules     = [];
let scheduleReplacements = {};
const SCHEDULE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let scheduleCacheEnabled = true;
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
    toastDurationMinutes: 5,
    organizationHrefs: [],
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

/* module: src/02-storage-and-transport.js */
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
    Object.entries(scheduleStateByDay).forEach(([day, state]) => {
        if (state.snapshot) applyScheduleSnapshot(day, state.snapshot);
        renderScheduleTab(day);
    });
}

function loadScheduleCacheEnabled() {
    try {
        scheduleCacheEnabled = localStorage.getItem(storageKey('scheduleCacheEnabled_v1')) !== 'false';
    } catch { scheduleCacheEnabled = true; }
}

function saveScheduleCacheEnabled(enabled) {
    scheduleCacheEnabled = !!enabled;
    try {
        localStorage.setItem(storageKey('scheduleCacheEnabled_v1'), String(scheduleCacheEnabled));
    } catch { /* Настройка продолжает действовать в текущей странице. */ }
}

function loadScheduleCache(day, targetDate) {
    if (!scheduleCacheEnabled) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey(`scheduleCache_v1_${day}`)) || 'null');
        const age = Date.now() - saved?.fetchedAt;
        if (saved?.schema !== 1 || saved.targetDate !== targetDate
            || !Number.isFinite(saved.fetchedAt) || age < 0 || age >= SCHEDULE_CACHE_TTL_MS
            || typeof saved.rawText !== 'string' || !saved.rawText.trim()
            || !saved.remoteReplacements || typeof saved.remoteReplacements !== 'object'
            || Array.isArray(saved.remoteReplacements)) return null;
        return saved;
    } catch { return null; }
}

function saveScheduleCache(day, snapshot) {
    if (!scheduleCacheEnabled) return;
    try {
        localStorage.setItem(storageKey(`scheduleCache_v1_${day}`), JSON.stringify(snapshot));
    } catch { /* Недоступное хранилище не мешает показать полученное расписание. */ }
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

function openPanelInBackground() {
    if (memchatPlatform.panel) return;
    try {
        const w = window.open('https://panel.hatiko.ru/', '_blank');
        if (w) w.blur();
    } catch (e) { debugError('panel-auth', 'Не удалось открыть панель', e); }
}

function loadPanelCsrf() {
    if (memchatPlatform.panel) return '';
    try {
        const saved = JSON.parse(localStorage.getItem(panelCsrfStorageKey()) || 'null');
        if (!saved?.token || !saved?.savedAt || Date.now() - saved.savedAt > PANEL_CSRF_TTL_MS) return '';
        return saved.token;
    } catch { return ''; }
}

function savePanelCsrf(token) {
    if (memchatPlatform.panel) return;
    if (!token) return;
    try { localStorage.setItem(panelCsrfStorageKey(), JSON.stringify({ token, savedAt: Date.now() })); }
    catch (error) { debugError('storage', 'Не удалось сохранить CSRF Panel', error); }
}

function clearPanelCsrf() {
    try { localStorage.removeItem(panelCsrfStorageKey()); } catch { /* storage unavailable */ }
}

function refreshPanelCsrf(onSuccess, onError, attempts = 2) {
    if (memchatPlatform.panel) return memchatPlatform.panel.ensure(onSuccess, onError, true);
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

function ensurePanelCsrf(onSuccess, onError, force = false) {
    if (memchatPlatform.panel) return memchatPlatform.panel.ensure(onSuccess, onError, force === true);
    if (force) { refreshPanelCsrf(onSuccess, onError); return; }
    const cached = loadPanelCsrf();
    if (cached) { onSuccess(cached); return; }
    refreshPanelCsrf(onSuccess, error => {
        openPanelInBackground();
        onError?.(error);
    });
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
            refreshPanelCsrf(newCsrf => attempt(newCsrf, true), () => {
                openPanelInBackground();
                onError(new Error('Panel: авторизация истекла. Войдите в panel.hatiko.ru.'));
            });
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
            refreshPanelCsrf(newCsrf => attempt(newCsrf, true), () => {
                openPanelInBackground();
                onError(new Error('Panel: авторизация истекла. Войдите в panel.hatiko.ru.'));
            });
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

/* module: src/03-chat.js */
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
        const ms = clearTextDelay;
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
/* module: src/04-hatiko.js */
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
    updateHatikoStatus('Ищу товары на сайтах Hatiko…');
    const searches = BASE_URLS.map(baseUrl => new Promise((resolve, reject) => {
        const searchUrl = `${baseUrl}/search/?query=${encodeURIComponent(query)}`;
        fetchServerData(searchUrl, response => resolve({ baseUrl, response }), reject);
    }));
    Promise.allSettled(searches).then(outcomes => {
        if (requestId !== activeRequestId) return;
        const productsByPath = new Map();
        const errors = [];
        outcomes.forEach(outcome => {
            if (outcome.status === 'rejected') {
                errors.push(outcome.reason);
                return;
            }
            const { baseUrl, response } = outcome.value;
            parseSearchResults(response.responseText, baseUrl).forEach(product => {
                if (!productsByPath.has(product.pathname)) productsByPath.set(product.pathname, product);
            });
        });
        const products = [...productsByPath.values()];
        if (!products.length) {
            updateHatikoStatus(errors.length === BASE_URLS.length ? 'Ошибка поиска' : 'Товары не найдены');
            addToChatHistory('bot', errors.length === BASE_URLS.length
                ? 'Не удалось выполнить поиск на сайтах Hatiko'
                : 'Товар не найден', '🐶 Hatiko', query);
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
                lastHatikoResults = results;
                lastHatikoQuery = query;
                if (results.length === 1) {
                    updateHatikoStatus('Готово');
                    addToChatHistory('bot', results[0].message, '🐶 Hatiko', query);
                } else {
                    updateHatikoStatus(`Готово: ${results.length} товара. Можно выбрать другой.`);
                    openHatikoProductPicker(results, query);
                }
            });
        });
    }).catch(error => {
        if (requestId !== activeRequestId) return;
        updateHatikoStatus('Ошибка поиска');
        addToChatHistory('bot', 'Ошибка поиска: ' + error, '🐶 Hatiko', query);
    });
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





/* module: src/05-calculator.js */
// ─── Калькулятор ──────────────────────────────────────────────────────────────
function calculateCredit() {
    const input = document.getElementById('priceCheckInput').value.trim();
    if (!input) return;
    addToChatHistory('user', input, '🧮 Калькулятор');

    const downPaymentMatch = input.match(/^\s*(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*$/);
    const total = downPaymentMatch ? Number(downPaymentMatch[1].replace(',', '.')) : null;
    const downPayment = downPaymentMatch ? Number(downPaymentMatch[2].replace(',', '.')) : null;
    const amount = downPaymentMatch ? total - downPayment : parseFloat(input);

    if (isNaN(amount) || amount <= 0) {
        const error = downPaymentMatch
            ? 'Ошибка: первоначальный взнос должен быть больше 0 и меньше общей суммы.'
            : 'Ошибка: введите корректную сумму.';
        addToChatHistory('bot', error, '🧮 Калькулятор', input);
        return;
    }
    if (downPaymentMatch && (!Number.isFinite(total) || !Number.isFinite(downPayment) || downPayment <= 0 || downPayment >= total)) {
        addToChatHistory('bot', 'Ошибка: первоначальный взнос должен быть больше 0 и меньше общей суммы.', '🧮 Калькулятор', input);
        return;
    }

    const lines = [];
    if (downPaymentMatch) {
        lines.push(`Первоначальный взнос: ${downPayment} руб.`, `Остаток: ${amount} руб.`);
    }
    lines.push(...calcRules.map(rule => {
        const result = applyRule(amount, rule);
        if (rule.isCashback) return `💸 ${rule.name}: ${result} баллами`;
        const totalWithDownPayment = downPaymentMatch ? ` (${result + downPayment} руб. с первоначальным взносом)` : '';
        return `🔹 ${rule.name}: ${result} руб.${totalWithDownPayment}`;
    }));
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
    const pct    = Number(Math.abs(diff / orig * 100).toFixed(2));
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

/* module: src/06-schedule.js */
// ─── Расписание ───────────────────────────────────────────────────────────────
// Вкладки «Сегодня»/«Завтра» показывают данные внутри Мемного чата.
function fetchWhoWorksToday()    { return fetchWhoWorks('today'); }
function fetchWhoWorksTomorrow() { return fetchWhoWorks('tomorrow'); }

function scheduleTargetDate(day, now = Date.now()) {
    const date = new Date(now);
    if (day === 'tomorrow') date.setDate(date.getDate() + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function applyScheduleSnapshot(day, snapshot) {
    const state = scheduleStateByDay[day];
    const replacements = { ...snapshot.remoteReplacements, ...scheduleReplacements };
    state.snapshot = snapshot;
    state.parsed = parseScheduleLines(snapshot.rawText, replacements, day);
    state.textCopy = formatOutputWithReplacements(snapshot.rawText, replacements, day);
    state.updatedAt = snapshot.fetchedAt;
}

function fetchWhoWorks(day, { force = false } = {}) {
    const url     = `https://docs.google.com/spreadsheets/d/13KUmHtRXYbXjBE7KQ_4MFQ5VsgUYqu2heURY1y2NwiE/edit`;
    const jsonUrl = 'https://github.com/xtalia/hatiko/raw/refs/heads/main/js/wwPeoples.json';
    const state = scheduleStateByDay[day];
    if (!state) return Promise.resolve(null);
    if (state.inFlight) {
        renderScheduleTab(day);
        return state.inFlight;
    }
    const targetDate = scheduleTargetDate(day);
    const cached = force ? null : loadScheduleCache(day, targetDate);
    if (cached) {
        applyScheduleSnapshot(day, cached);
        state.error = '';
        renderScheduleTab(day);
        return Promise.resolve(cached);
    }
    state.loading = true;
    state.error = '';
    renderScheduleTab(day);

    state.inFlight = Promise.resolve().then(() => fetch(jsonUrl))
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(loaded => {
            if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)
                || Object.values(loaded).some(value => typeof value !== 'string')) throw new Error('Неверный формат замен');
            return loaded;
        })
        .catch(() => ({}))
        .then(loaded => loadTableWithReplacements(day, url, { ...loaded, ...scheduleReplacements }, targetDate)
            .then(result => ({ ...result, remoteReplacements: loaded })))
        .then(result => {
            if (scheduleTargetDate(day) !== targetDate) throw new Error('Изменилась календарная дата — откройте день заново');
            state.loading = false;
            const snapshot = { schema: 1, targetDate, fetchedAt: Date.now(), rawText: result.rawText, remoteReplacements: result.remoteReplacements };
            applyScheduleSnapshot(day, snapshot);
            saveScheduleCache(day, snapshot);
            state.error = '';
            renderScheduleTab(day);
            return result;
        })
        .catch(error => {
            state.loading = false;
            state.error = error.message || 'Ошибка сети при загрузке расписания';
            renderScheduleTab(day);
            return null;
        })
        .finally(() => { state.inFlight = null; });
    return state.inFlight;
}

function loadTableWithReplacements(day, url, replacements, targetDate = scheduleTargetDate(day)) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'GET',
        timeout: 30000,
        url,
        onload(response) {
            try {
                if (response.status < 200 || response.status >= 300) throw new Error(`Ошибка загрузки расписания: HTTP ${response.status}`);
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
                if (si === -1 || ei <= si) throw new Error('Данные не найдены');
                const text = full.substring(si, ei).replace(sm, '').replace(em, '').trim();
                if (text.match(/\d{2}\.\d{2}\.\d{4}/)?.[0] !== targetDate.split('-').reverse().join('.')) {
                    throw new Error('Дата расписания не соответствует выбранному дню');
                }
                resolve({
                    rawText: text,
                    parsed: parseScheduleLines(text, replacements, day),
                    textCopy: formatOutputWithReplacements(text, replacements, day)
                });
            } catch (error) {
                reject(error);
            }
        },
        onerror() { reject(new Error('Ошибка сети при загрузке расписания')); },
        ontimeout() { reject(new Error('Время ожидания расписания истекло')); },
        onabort() { reject(new Error('Загрузка расписания отменена')); }
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
    if (state.snapshot && state.snapshot.targetDate !== scheduleTargetDate(day)) {
        state.snapshot = null;
        state.parsed = null;
        state.textCopy = '';
        state.updatedAt = 0;
    }
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
    refresh.addEventListener('click', () => fetchWhoWorks(day, { force: true }));
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
/* module: src/07-settings-panels.js */
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
    const assign = document.createElement('button'); assign.textContent = 'Поменять'; assign.style.cssText = HACKER_BTN_CSS + 'background:#4f46e5;flex:1;';
    assign.onclick = () => hackerFindAgentByPhone(phone()).then(rows => rows.length ? hackerAssignAgent(rows[0].meta.href).then(() => hackerLog('✅ Контрагент заменён', 'ok')) : hackerLog('Контрагент не найден', 'warn')).catch(error => hackerLog('Контрагент: ' + error.message, 'err'));
    const create = document.createElement('button'); create.textContent = 'Создать'; create.style.cssText = HACKER_BTN_CSS + 'background:#16a34a;flex:1;';
    create.id = 'hackerAgentCreate';
    create.disabled = hackerAgentCreatePending;
    create.onclick = () => hackerAgentCreateClick({ checkFirst: true });
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

/* module: src/08-field-clear.js */
// ─── Очистка текста ───────────────────────────────────────────────────────────
// Вызывается при каждом открытии окна настроек (элементы создаются заново),
// поэтому document-слушатель вешается один раз через флаг.
function loadClearTextDelay() {
    try {
        const value = Number(localStorage.getItem(storageKey('clearTextDelay_v1')));
        clearTextDelay = Number.isInteger(value) && value >= 1 && value <= 2000 ? value : 500;
    } catch { clearTextDelay = 500; }
    return clearTextDelay;
}

function saveClearTextDelay(value) {
    const delay = Number(value);
    if (!Number.isInteger(delay) || delay < 1 || delay > 2000) return;
    clearTextDelay = delay;
    if (!clearTextEnabled) return;
    try { localStorage.setItem(storageKey('clearTextDelay_v1'), String(delay)); }
    catch (error) { debugError('storage', 'Не удалось сохранить задержку очистки', error); }
}

const clearTextTimers = new Map();
function cancelClearTextTimer(target) {
    clearTimeout(clearTextTimers.get(target));
    clearTextTimers.delete(target);
}
function loadClearTextEnabled() {
    const key = storageKey('clearTextEnabled');
    let saved = localStorage.getItem(key);
    if (saved === null && typeof MEMCHAT_BUILD === 'undefined') {
        saved = localStorage.getItem('clearTextEnabled');
        if (saved !== null) {
            localStorage.setItem(key, saved);
            localStorage.removeItem('clearTextEnabled');
        }
    }
    clearTextEnabled = saved === 'true';
}
function setupGlobalClearTextFunctionality() {
    loadClearTextEnabled();
    if (!clearTextEnabled) for (const target of clearTextTimers.keys()) cancelClearTextTimer(target);
    loadClearTextDelay();
    const slider = document.getElementById('timeoutSlider');
    const label = document.getElementById('timeoutValue');
    if (slider) {
        slider.value = String(clearTextDelay);
        if (label) label.textContent = slider.value;
        if (!slider.dataset.memchatClearBound) slider.addEventListener('input', () => {
            if (label) label.textContent = slider.value;
            saveClearTextDelay(slider.value);
        });
        slider.dataset.memchatClearBound = 'true';
    }
    const cb = document.getElementById('clearTextCheckbox');
    if (cb) {
        cb.checked = clearTextEnabled;
        if (!cb.dataset.memchatClearBound) cb.addEventListener('change', function () {
            setClearTextEnabled(this.checked);
        });
        cb.dataset.memchatClearBound = 'true';
    }
    if (!globalClearKeypressBound) {
        globalClearKeypressBound = true;
        document.addEventListener('keypress', e => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && clearTextEnabled && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
                const target = e.target, value = target.value;
                cancelClearTextTimer(target);
                clearTextTimers.set(target, setTimeout(() => {
                    clearTextTimers.delete(target);
                    if (clearTextEnabled && target.isConnected && target.value === value) target.value = '';
                }, clearTextDelay));
            }
        });
        document.addEventListener('input', e => cancelClearTextTimer(e.target), true);
        document.addEventListener('compositionstart', e => cancelClearTextTimer(e.target), true);
        window.addEventListener('pagehide', () => { for (const target of clearTextTimers.keys()) cancelClearTextTimer(target); });
    }
    updateClearTextButton();
}

function setClearTextEnabled(enabled) {
    localStorage.setItem(storageKey('clearTextEnabled'), String(!!enabled));
    clearTextEnabled = !!enabled;
    if (!clearTextEnabled) for (const target of clearTextTimers.keys()) cancelClearTextTimer(target);
    if (clearTextEnabled) saveClearTextDelay(document.getElementById('timeoutSlider')?.value || clearTextDelay);
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
/* module: src/08-clear-and-actions.js */
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

/* module: src/09-ui.js */
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
    memchatPlatform.onMainCreated?.();
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
        scheduleCacheEnabled,
        clearTextEnabled,
        clearTimeout: parseInt(document.getElementById('timeoutSlider')?.value || 500, 10),
        showHatikoLinks: loadShowHatikoLinks(),
        hatikoSearchMode,
        retryBehavior,
        msQuickPanelEnabled,
        msMagicConfig,
        hackerOrderNotifier: hackerNotifierSettings,
        internalOrderCheck: internalOrderCheckSettings
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
    if (typeof data.scheduleCacheEnabled === 'boolean') {
        saveScheduleCacheEnabled(data.scheduleCacheEnabled);
        const cb = document.getElementById('scheduleCacheCheckbox');
        if (cb) cb.checked = scheduleCacheEnabled;
    }
    if (typeof data.clearTextEnabled === 'boolean') {
        clearTextEnabled = data.clearTextEnabled;
        localStorage.setItem(storageKey('clearTextEnabled'), String(clearTextEnabled));
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
    if (data.internalOrderCheck && typeof data.internalOrderCheck === 'object') {
        internalOrderCheckSettings = internalOrderCheckNormalizeSettings(data.internalOrderCheck);
        internalOrderCheckSaveSettings();
        internalOrderCheckFillOrganizations();
        internalOrderCheckFillWarehouses();
        internalOrderCheckFillStatuses('customerorder');
        internalOrderCheckFillStatuses('internalorder');
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
    [['status', 'Статус'], ['agent', 'Контрагент'], ['notifier', 'Новые заказы'], ['internalOrderCheck', 'Проверка заказов']].forEach(([key, label]) => {
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
        ['notifier', 'Новые заказы'],
        ['internalOrderCheck', 'Проверка заказов']
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
    if (memchatPlatform.diagnostics?.select(key)) return;
    // Old callers may still request the removed sale tab; never run its flow.
    if (!['status', 'agent', 'notifier', 'internalOrderCheck'].includes(key)) key = 'status';
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
    else if (key === 'notifier') pane = hackerBuildNotifierTab();
    else if (key === 'internalOrderCheck') pane = hackerBuildInternalOrderCheckTab();
    if (pane) panes.appendChild(pane);

    // Справочники загружаются при открытии соответствующей вкладки.
    if (key === 'status') hackerEnsureStates(true);
}

// ─── Окно «Настройки» ─────────────────────────────────────────────────────────
// Отдельное плавающее перетаскиваемое окно (позиция сохраняется).
function openSettingsWindow(initialTab = 'general') {
    if (memchatPlatform.diagnostics) {
        if (initialTab === 'internalOrderCheck') initialTab = 'general';

    }
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
        <label style="display:flex;align-items:center;gap:8px;color:#475569;font-size:12px;margin-bottom:10px;cursor:pointer;">
            <input type="checkbox" id="scheduleCacheCheckbox" style="accent-color:#6366f1;width:14px;height:14px;">
            Кешировать расписание на 12 часов
        </label>

        <div id="mcSettingsRulesPane" style="display:none;">
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

    const generalPane = document.createElement('div');
    generalPane.id = 'mcSettingsGeneralPane';
    while (body.firstChild) generalPane.appendChild(body.firstChild);
    const rulesPane = generalPane.querySelector('#mcSettingsRulesPane');
    rulesPane.remove();

    const settingsTabs = document.createElement('div');
    settingsTabs.id = 'mcSettingsTabs';
    settingsTabs.style.cssText = 'display:flex;gap:4px;margin-bottom:9px;';
    const settingsGeneralTab = document.createElement('button');
    settingsGeneralTab.id = 'mcSettingsTabGeneral';
    settingsGeneralTab.type = 'button';
    settingsGeneralTab.textContent = '⚙️ Общие';
    const settingsRulesTab = document.createElement('button');
    settingsRulesTab.id = 'mcSettingsTabRules';
    settingsRulesTab.type = 'button';
    settingsRulesTab.textContent = '📝 Правила и замены';
    const settingsOrderTab = document.createElement('button');
    settingsOrderTab.id = 'mcSettingsTabInternalOrderCheck';
    settingsOrderTab.type = 'button';
    settingsOrderTab.textContent = '📦 Проверка заказов';
    [settingsGeneralTab, settingsRulesTab, settingsOrderTab].forEach(button => {
        button.style.cssText = 'flex:1;padding:6px 5px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;color:#475569;font-size:11px;font-weight:600;cursor:pointer;';
        settingsTabs.appendChild(button);
    });

    const orderCheckPane = document.createElement('div');
    orderCheckPane.id = 'mcSettingsInternalOrderCheckPane';
    orderCheckPane.style.display = 'none';
    const ensureOrderCheckSettings = () => {
        if (!orderCheckPane.firstChild) orderCheckPane.appendChild(internalOrderCheckBuildSettingsPanel());
    };
    const activateSettingsTab = key => {
        if (key === 'internalOrderCheck') ensureOrderCheckSettings();
        [
            ['general', settingsGeneralTab, generalPane],
            ['rules', settingsRulesTab, rulesPane],
            ['internalOrderCheck', settingsOrderTab, orderCheckPane]
        ].forEach(([tabKey, button, pane]) => {
            const active = key === tabKey;
            pane.style.display = active ? 'block' : 'none';
            button.style.background = active ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : '#f8fafc';
            button.style.color = active ? '#fff' : '#475569';
        });
    };
    settingsGeneralTab.addEventListener('click', () => activateSettingsTab('general'));
    settingsRulesTab.addEventListener('click', () => activateSettingsTab('rules'));
    settingsOrderTab.addEventListener('click', () => activateSettingsTab('internalOrderCheck'));
    body.append(settingsTabs, generalPane, rulesPane, orderCheckPane);

    win.appendChild(body);

    // Сначала в DOM — иначе getElementById не найдёт элементы окна.
    document.body.appendChild(win);
    activateSettingsTab(initialTab === 'internalOrderCheck' ? 'internalOrderCheck' : 'general');

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
    const scheduleCacheCb = document.getElementById('scheduleCacheCheckbox');
    scheduleCacheCb.checked = scheduleCacheEnabled;
    scheduleCacheCb.addEventListener('change', () => saveScheduleCacheEnabled(scheduleCacheCb.checked));
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
        bearerCb.addEventListener('change', () => {
            hackerSetBearerEnabled(bearerCb.checked);
            hackerValidateApiKey();
        });
        bearerInp.addEventListener('input', () => hackerSetBearerToken(bearerInp.value));
        bearerInp.addEventListener('change', () => hackerValidateApiKey());
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
    memchatPlatform.diagnostics?.cleanSettings();
}
/* module: src/10-events-and-init.js */
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
        if (isSchedule) fetchWhoWorks(tab);
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
    loadScheduleCacheEnabled();
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

    GM_registerMenuCommand('Открыть мемный чат', createPriceCheckWindow);
        GM_registerMenuCommand('Закрыть мемный чат', closeChatWindow);
        GM_registerMenuCommand('Сбросить положение окон', resetFloatWindowPos);
        GM_registerMenuCommand('Переключить отладку мемного чата', toggleDebugMode);
    debugLog('init', 'initialized');
    console.log('Мемный чат v8.9.0-alpha.1 инициализирован');

    // Один наблюдатель обслуживает все контекстные встройки и SPA-переходы.
    if (/online\.moysklad\.ru$/.test(location.hostname)) {
        restoreMsFields(); // миграция со старого режима выборочного скрытия
        document.getElementById('mcMsRevealBtn')?.remove();
        startMsSpaObserver();
        if (hackerBearerEnabled && hackerBearerToken.trim()) hackerValidateApiKey();
    }
}
/* module: src/11-hacker.js */
// ─── ХатикоХакер (МойСклад API) ───────────────────────────────────────────────
// Встроенные и плавающие вкладки Хакера + консоль-лог внизу.
// Транспорт: GM_xmlhttpRequest → https://api.moysklad.ru/api/remap/1.2/
// Авторизация: Bearer-ключ из настроек (по умолчанию выкл — тогда cookies сессии).

const MS_API_BASE = 'https://api.moysklad.ru/api/remap/1.2';

let hackerTab            = 'status';
let hackerLogLines       = [];
let hackerStates         = [];  // [{name, href}] — статусы заказов покупателей
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
// Remote changes stop this tab, never migrate its old work to a new Bearer.
let hackerCredentialScopeBlocked = false;
let msReferenceScope = '';
let msReferenceCache = { lists: {}, attempted: false, errors: {} };
const msReferenceRequests = new Map();
let hackerValidationInFlight = null;

function msReferenceRestore() {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey('msReferenceCache_v1')) || 'null');
        const validLists = saved?.lists && !Array.isArray(saved.lists) && typeof saved.lists === 'object'
            && Object.entries(saved.lists).every(([kind, items]) =>
                ['organization', 'store', 'customerorder', 'internalorder'].includes(kind) && Array.isArray(items)
                && items.every(item => item && typeof item.name === 'string' && typeof item.href === 'string'));
        msReferenceCache = saved?.version === 1 && saved.scope === msReferenceScope && validLists
            ? saved : { lists: {}, attempted: false, errors: {} };
    } catch { msReferenceCache = { lists: {}, attempted: false, errors: {} }; }
    if (msReferenceScope) {
        hackerNotifierOrganizations = msReferenceCache.lists.organization || [];
        internalOrderCheckWarehouses = msReferenceCache.lists.store || [];
        hackerStates = msReferenceCache.lists.customerorder || [];
        internalOrderCheckStatuses = {
            customerorder: hackerStates,
            internalorder: msReferenceCache.lists.internalorder || []
        };
    }
}

function msReferenceSave() {
    localStorage.setItem(storageKey('msReferenceCache_v1'), JSON.stringify({
        ...msReferenceCache, version: 1, scope: msReferenceScope
    }));
}

function msReferenceFillControls() {
    hackerNotifierFillControls();
    internalOrderCheckFillOrganizations();
    internalOrderCheckFillWarehouses();
    internalOrderCheckFillStatuses('customerorder');
    internalOrderCheckFillStatuses('internalorder');
    hackerFillSelect(document.getElementById('hackerStateSelect'), hackerStates);
}

function msReferenceAssertCurrent(scope, generation) {
    if (scope !== msReferenceScope || generation !== msApiGeneration || !hackerCheckCredentialScope()) {
        throw new Error('Загрузка справочников отменена: изменены учётные данные');
    }
}

// One request per endpoint/generation, shared by validation and both settings panes.
function msReferenceFetch(kind) {
    const key = `${msApiGeneration}:${kind}`;
    if (msReferenceRequests.has(key)) return msReferenceRequests.get(key);
    const scope = msReferenceScope;
    const generation = msApiGeneration;
    const path = kind === 'organization' || kind === 'store'
        ? `/entity/${kind}?order=name&limit=1000` : `/entity/${kind}/metadata`;
    const request = (async () => {
        const rows = [];
        const visited = new Set();
        let next = path;
        do {
            msReferenceAssertCurrent(scope, generation);
            const normalized = hackerApiPath(next);
            if (!normalized || visited.has(normalized)) throw new Error('Некорректная пагинация справочника');
            visited.add(normalized);
            const data = await msApiP('GET', normalized);
            msReferenceAssertCurrent(scope, generation);
            const items = kind === 'organization' || kind === 'store'
                ? data?.rows : (Array.isArray(data?.states) ? data.states : data?.states?.rows);
            if (!Array.isArray(items)) throw new Error('Некорректный ответ справочника');
            rows.push(...items.map(item => ({ name: item.name, href: item.meta?.href, color: item.color }))
                .filter(item => item.name && item.href));
            next = kind === 'organization' || kind === 'store' ? data?.meta?.nextHref : '';
        } while (next);
        return rows;
    })();
    msReferenceRequests.set(key, request);
    request.finally(() => {
        if (msReferenceRequests.get(key) === request) msReferenceRequests.delete(key);
    }).catch(() => {});
    return request;
}

function msReferenceLoad(kind, { force = false, seed } = {}) {
    if (!force && Object.hasOwn(msReferenceCache.lists, kind)) return Promise.resolve(msReferenceCache.lists[kind]);
    const scope = msReferenceScope;
    const generation = msApiGeneration;
    return (seed ? Promise.resolve(seed) : msReferenceFetch(kind)).then(items => {
        msReferenceAssertCurrent(scope, generation);
        msReferenceCache.lists[kind] = items;
        msReferenceSave();
        hackerNotifierOrganizations = msReferenceCache.lists.organization || [];
        internalOrderCheckWarehouses = msReferenceCache.lists.store || [];
        hackerStates = msReferenceCache.lists.customerorder || [];
        internalOrderCheckStatuses.customerorder = hackerStates;
        internalOrderCheckStatuses.internalorder = msReferenceCache.lists.internalorder || [];
        msReferenceFillControls();
        return items;
    });
}

function msReferenceShowStatus(status = document.getElementById('hackerInternalOrderSettingsStatus')) {
    if (memchatPlatform.references?.showStatus) return memchatPlatform.references.showStatus(status);
    const labels = { organization: 'Организации', store: 'Склады', customerorder: 'Статусы заказов', internalorder: 'Статусы внутренних заказов' };
    const errors = Object.entries(msReferenceCache.errors || {});
    // attempted suppresses automatic retries; only present lists prove completeness.
    // A successful empty array is present, unlike a request interrupted by tab close.
    const missing = Object.keys(labels).filter(kind => !Object.hasOwn(msReferenceCache.lists, kind));
    const warnings = [];
    if (errors.length) warnings.push('⚠ Не обновлены: ' + errors.map(([kind, message]) => `${labels[kind]} — ${message}`).join('; '));
    if (missing.length && (msReferenceCache.attempted || Object.keys(msReferenceCache.lists).length)) {
        warnings.push('⚠ Не загружены: ' + missing.map(kind => labels[kind]).join('; ') + '. Нажмите «Загрузить справочники»');
    }
    const message = warnings.join('. ') || (missing.length ? '' : 'Справочники загружены');
    if (status) {
        status.textContent = message;
        status.style.color = warnings.length ? '#b91c1c' : '#166534';
    }
    if (warnings.length) hackerNotifierSetStatus(message, 'error');
}

async function msReferenceRefresh({ force = false, states, status } = {}) {
    if (memchatPlatform.references?.refresh) return memchatPlatform.references.refresh({ force, states, status });
    msReferenceCache.attempted = true;
    const scope = msReferenceScope;
    const generation = msApiGeneration;
    const kinds = ['organization', 'store', 'customerorder', 'internalorder'];
    const outcomes = await Promise.allSettled(kinds.map(kind => msReferenceLoad(kind,
        { force, seed: kind === 'customerorder' ? states : undefined })));
    msReferenceAssertCurrent(scope, generation);
    msReferenceCache.errors = Object.fromEntries(outcomes.flatMap((outcome, index) =>
        outcome.status === 'rejected' ? [[kinds[index], outcome.reason.status
            ? `HTTP ${outcome.reason.status}` : 'ошибка загрузки; повторите вручную']] : []));
    msReferenceSave();
    msReferenceShowStatus(status);
    return { ok: Object.keys(msReferenceCache.errors).length === 0, errors: msReferenceCache.errors };
}

function msReferenceBootstrap(states) {
    const scope = msReferenceScope;
    const generation = msApiGeneration;
    const bootstrap = () => {
        msReferenceAssertCurrent(scope, generation);
        // Another same-origin tab may have completed while this one waited.
        msReferenceRestore();
        if (!msReferenceCache.attempted) return msReferenceRefresh({ states });
        msReferenceFillControls();
        msReferenceShowStatus();
    };
    return navigator.locks?.request
        ? navigator.locks.request(storageKey('msReferenceBootstrap_v1:') + scope, bootstrap)
        : Promise.resolve().then(bootstrap);
}

function hackerLoadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(storageKey('hackerMsApi_v1')) || '{}');
        hackerBearerEnabled = !!s.bearerEnabled;
        hackerBearerToken = typeof s.token === 'string' ? s.token : '';
        msReferenceScope = s.referenceScope || (hackerBearerToken ? crypto.randomUUID() : '');
        if (msReferenceScope && !s.referenceScope) {
            // Bind pre-upgrade choices only to the credentials already on disk.
            for (const key of ['hackerOrderNotifier_v1', INTERNAL_ORDER_CHECK_STORAGE_KEY]) {
                try {
                    const raw = JSON.parse(localStorage.getItem(storageKey(key)) || 'null');
                    if (raw && !raw.referenceScope) localStorage.setItem(storageKey(key), JSON.stringify({ ...raw, referenceScope: msReferenceScope }));
                } catch { /* Invalid old settings are handled by their own loader. */ }
            }
            hackerSaveSettings();
        }
    } catch {
        hackerBearerEnabled = false;
        hackerBearerToken = '';
        msReferenceScope = '';
    }
    hackerCredentialScopeBlocked = false;
    hackerLoadCachedStates();
    hackerNotifierLoadSettings();
    internalOrderCheckLoadSettings();
    msReferenceRestore();
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
            token: hackerBearerToken,
            referenceScope: msReferenceScope
        }));
    } catch (error) {
        debugError('hacker', 'Не удалось сохранить настройки API', error);
    }
}

function hackerCheckCredentialScope() {
    if (hackerCredentialScopeBlocked) return false;
    let matches = false;
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey('hackerMsApi_v1')) || '{}');
        matches = !!saved.bearerEnabled === hackerBearerEnabled
            && (typeof saved.token === 'string' ? saved.token : '') === hackerBearerToken;
    } catch { /* Unreadable/removed credentials fail closed. */ }
    if (matches) return true;
    hackerCredentialScopeBlocked = true;
    hackerApiValidated = false;
    msApiCancelAll();
    hackerUpdateBearerStatus('—', 'настройки изменены в другой вкладке; подтвердите ключ');
    hackerSyncAccessUi();
    return false;
}

window.addEventListener('storage', event => {
    // Browser origin isolation plus storageKey keeps DEV/production separate.
    // Read current storage, not the event payload; ignore sessionStorage.
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key !== null && event.key !== storageKey('hackerMsApi_v1')) return;
    hackerCheckCredentialScope();
});

// Вызывается из окна настроек (09)
function hackerSetBearerEnabled(enabled) {
    if (hackerBearerEnabled !== !!enabled) msApiCancelAll();
    hackerBearerEnabled = !!enabled;
    hackerApiValidated = false;
    hackerSaveSettings();
    hackerCredentialScopeBlocked = false;
    const inp = document.getElementById('msBearerToken');
    if (inp) inp.style.display = hackerBearerEnabled ? 'block' : 'none';
    hackerSyncAccessUi();
}

function hackerSyncAccessUi() {
    memchatPlatform.onAccessUi?.();
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
    if (!hackerCheckCredentialScope() || !hackerBearerEnabled || !hackerBearerToken.trim()) {
        hackerApiValidated = false;
        hackerUpdateBearerStatus('—', 'выкл');
        hackerSyncAccessUi();
        onDone?.(false);
        return Promise.resolve(false);
    }
    if (hackerValidationInFlight?.generation === msApiGeneration) {
        return hackerValidationInFlight.promise.then(ok => { onDone?.(ok); return ok; });
    }
    const generation = msApiGeneration;
    const scope = msReferenceScope;
    const promise = msReferenceFetch('customerorder').then(async states => {
        msReferenceAssertCurrent(scope, generation);
        hackerApiValidated = true;
        hackerUpdateBearerStatus(200, 'валиден');
        hackerSyncAccessUi();
        onDone?.(true);
        await msReferenceBootstrap(states);
        msReferenceAssertCurrent(scope, generation);
        hackerNotifierMaybeStart();
        return true;
    }).catch(error => {
        if (generation !== msApiGeneration) return false;
        hackerApiValidated = false;
        hackerNotifierStop();
        hackerUpdateBearerStatus(error?.status || 401, 'ошибка');
        hackerSyncAccessUi();
        onDone?.(false);
        return false;
    }).finally(() => {
        if (hackerValidationInFlight?.promise === promise) hackerValidationInFlight = null;
    });
    hackerValidationInFlight = { generation, promise };
    return promise;
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
    const changed = hackerBearerToken !== String(value || '');
    if (changed) msApiCancelAll();
    hackerBearerToken = String(value || '');
    if (changed) msReferenceScope = hackerBearerToken ? crypto.randomUUID() : '';
    hackerApiValidated = false;
    hackerSaveSettings();
    hackerCredentialScopeBlocked = false;
    if (changed) {
        msReferenceRestore();
        hackerNotifierLoadSettings();
        internalOrderCheckLoadSettings();
        msReferenceFillControls();
    }
    hackerSyncAccessUi();
}

// ─── Транспорт ────────────────────────────────────────────────────────────────
function hackerEnsureBearer() {
    if (!hackerCheckCredentialScope()) throw new Error('Запрос к api.moysklad.ru отменён: подтвердите API-ключ в этой вкладке');
    if (!hackerBearerEnabled || !hackerBearerToken.trim()) {
        throw new Error('Включите Bearer и укажите API-ключ МойСклад');
    }
}

const MS_API_MAX_CONCURRENT_REQUESTS = 2;
const MS_API_RATE_SAFETY_FACTOR = 1.2;
const msApiRequestQueue = [];
const msApiRateLimitState = {
    limit: null,
    remaining: null,
    intervalMs: null,
    resetMs: null,
    retryAfterMs: null,
    updatedAt: null,
    parallelLimitErrors: 0
};
let msApiInFlight = 0;
let msApiNextRequestAt = 0;
let msApiBlockedUntil = 0;
let msApiParallelCooldownUntil = 0;
let msApiQueueTimer = null;

let msApiGeneration = 0;
const msApiTasks = new Set();

function msApiCancelAll() {
    msApiGeneration++;
    hackerNotifierStop();
    [...msApiTasks].forEach(task => task.cancel());
}

function msApiGetLimitStats() {
    return { ...msApiRateLimitState, inFlight: msApiInFlight, queued: msApiRequestQueue.length };
}

function msApiParseResponseHeaders(rawHeaders) {
    const headers = {};
    String(rawHeaders || '').split(String.fromCharCode(10)).forEach(rawLine => {
        const line = rawLine.trim();
        const separator = line.indexOf(':');
        if (separator < 1) return;
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    });
    return headers;
}

function msApiNumberHeader(headers, name) {
    const value = Number(headers[name]);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function msApiUpdateLimitState(response) {
    const headers = msApiParseResponseHeaders(response?.responseHeaders);
    const limit = msApiNumberHeader(headers, 'x-ratelimit-limit');
    const remaining = msApiNumberHeader(headers, 'x-ratelimit-remaining');
    const intervalMs = msApiNumberHeader(headers, 'x-lognex-retry-timeinterval');
    const resetMs = msApiNumberHeader(headers, 'x-lognex-reset');
    const retryAfterMs = msApiNumberHeader(headers, 'x-lognex-retry-after');

    if (limit !== null) msApiRateLimitState.limit = limit;
    if (remaining !== null) msApiRateLimitState.remaining = remaining;
    if (intervalMs !== null) msApiRateLimitState.intervalMs = intervalMs;
    if (resetMs !== null) msApiRateLimitState.resetMs = resetMs;
    if (retryAfterMs !== null) msApiRateLimitState.retryAfterMs = retryAfterMs;
    msApiRateLimitState.updatedAt = Date.now();

    if (limit !== null && limit > 0 && intervalMs !== null && intervalMs > 0) {

        // Header counts may be weighted units, not whole HTTP requests.
        const budget = Math.max(1, Math.floor((remaining ?? limit) / 5));
        msApiNextRequestAt = Math.max(msApiNextRequestAt, Date.now() + Math.max(500, Math.ceil((resetMs || intervalMs) / budget * MS_API_RATE_SAFETY_FACTOR)));
    }
    if (remaining === 0) {
        const waitMs = retryAfterMs || resetMs || intervalMs || 0;
        if (waitMs > 0) msApiBlockedUntil = Math.max(msApiBlockedUntil, Date.now() + waitMs);
    }
    return { headers, rateLimit: { limit, remaining, intervalMs, resetMs, retryAfterMs } };
}

function msApiScheduleQueue(waitMs) {
    if (msApiQueueTimer || !msApiRequestQueue.length) return;
    msApiQueueTimer = setTimeout(() => {
        msApiQueueTimer = null;
        msApiPumpQueue();
    }, Math.max(1, waitMs));
}

function msApiPumpQueue() {
    if (memchatPlatform.directMs) {
        if (!hackerCheckCredentialScope()) return;
        while (msApiRequestQueue.length) {
            const task = msApiRequestQueue.shift();
            if (task.generation !== msApiGeneration || task.signal?.aborted || task.token !== hackerBearerToken.trim()) task.cancel();
            else msApiStartTask(task);
        }
        return;
    }
    if (!msApiRequestQueue.length) return;
    if (!hackerCheckCredentialScope()) return;
    const now = Date.now();
    const cooldownUntil = Math.max(msApiBlockedUntil, msApiParallelCooldownUntil);
    if (now < cooldownUntil) {
        msApiScheduleQueue(cooldownUntil - now);
        return;
    }
    const concurrencyLimit = now < msApiParallelCooldownUntil ? 1 : MS_API_MAX_CONCURRENT_REQUESTS;
    while (msApiRequestQueue.length && msApiInFlight < concurrencyLimit) {
        const delay = msApiNextRequestAt - Date.now();
        if (delay > 0) {
            msApiScheduleQueue(delay);
            return;
        }
        const task = msApiRequestQueue.shift();
        if (task.generation !== msApiGeneration || task.signal?.aborted) { task.cancel(); continue; }
        const weight = task.method === 'GET' && /^\/report\/stock\/(all|bystore)(?:\?|\/?$)/.test(task.path) ? 5 : 4;
        msApiNextRequestAt = Date.now() + 500 * weight / 4;
        msApiStartTask(task);
    }
}

function msApiStartTask(task) {
    msApiInFlight += 1;
    let completed = false;
    const finish = (callback, value) => {
        if (completed) return;
        completed = true;
        msApiInFlight = Math.max(0, msApiInFlight - 1);
        msApiTasks.delete(task);
        task.signal?.removeEventListener('abort', task.abortListener);
        try { callback(value); } finally { msApiPumpQueue(); }
    };
    let handle;
    task.cancel = () => {
        if (completed) return;
        handle?.abort?.();
        finish(task.onError, new Error('Запрос к api.moysklad.ru отменён'));
    };
    const headers = { 'Accept': 'application/json;charset=utf-8' };
    if (task.body) headers['Content-Type'] = 'application/json;charset=utf-8';
    headers['Authorization'] = 'Bearer ' + task.token;

    try {
        handle = GM_xmlhttpRequest({
            method: task.method,
            url: MS_API_BASE + task.path,
            headers,
            data: task.body ? JSON.stringify(task.body) : undefined,
            timeout: 30000,
            anonymous: false,
            memchatIsCurrent: () => !completed && hackerCheckCredentialScope()
                && task.generation === msApiGeneration && !task.signal?.aborted,
            onload: response => {
                if (completed) return;
                if (!hackerCheckCredentialScope() || task.generation !== msApiGeneration || task.signal?.aborted) { task.cancel(); return; }
                const raw = response.responseText || '';
                let data = null;
                try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* не JSON */ }
                const limitInfo = msApiUpdateLimitState(response);
                if (response.status >= 200 && response.status < 300) {
                    if (data && typeof data === 'object') data._status = response.status;
                    finish(task.onSuccess, data);
                    return;
                }
                const apiError = data?.errors?.[0] || null;
                const apiMsg = apiError
                    ? (apiError.error || apiError.parameter || apiError.code || JSON.stringify(apiError))
                    : '';
                let msg = apiMsg || ('HTTP ' + response.status);
                if (response.status === 401 && !hackerBearerEnabled) {
                    msg += ' — включите «Bearer-ключ API» в настройках и вставьте API-ключ';
                }
                const error = new Error(msg);
                error.status = response.status;
                error.apiCode = apiError?.code ?? null;
                error.authCode = limitInfo.headers['x-lognex-auth'] || null;
                error.rateLimit = limitInfo.rateLimit;
                const isParallelLimit = response.status === 429
                    && (Number(error.apiCode) === 1073 || error.authCode === '429005');
                if (response.status === 429) {
                    const waitMs = limitInfo.rateLimit.retryAfterMs
                        || limitInfo.rateLimit.resetMs
                        || limitInfo.rateLimit.intervalMs
                        || 1000;
                    msApiBlockedUntil = Math.max(msApiBlockedUntil, Date.now() + waitMs);
                }
                if (isParallelLimit) {
                    msApiRateLimitState.parallelLimitErrors += 1;
                    msApiParallelCooldownUntil = Math.max(msApiParallelCooldownUntil, Date.now() + 10000);
                }
                if ((response.status === 429 || Number(error.apiCode) === 1073)
                    && task.method === 'GET' && task.attempt < 2 && !GM_xmlhttpRequest.memchatMsScheduler) {
                    msApiBlockedUntil = Math.max(msApiBlockedUntil, Date.now() + 1000 * 2 ** task.attempt);
                    completed = true;
                    msApiInFlight--;
                    task.attempt++;
                    task.cancel = task.cancelQueued;
                    msApiRequestQueue.push(task);
                    msApiPumpQueue();
                    return;
                }
                finish(task.onError, error);
            },
            onerror: () => finish(task.onError, new Error('Ошибка сети (api.moysklad.ru)')),
            ontimeout: () => finish(task.onError, new Error('Таймаут запроса к api.moysklad.ru')),
            onabort: () => finish(task.onError, new Error('Запрос к api.moysklad.ru отменён'))
        });
    } catch (error) {
        finish(task.onError, error);
    }
}

function msApi(method, path, body, onSuccess, onError, options = {}) {
    try { hackerEnsureBearer(); }
    catch (error) { onError(error); return; }
    const task = { method: method.toUpperCase(), path, body, onSuccess, onError,
        token: hackerBearerToken.trim(), generation: msApiGeneration, signal: options.signal, cancel: null, attempt: 0 };
    const cancel = () => task.cancel();
    task.cancel = () => {
        const index = msApiRequestQueue.indexOf(task);
        if (index >= 0) msApiRequestQueue.splice(index, 1);
        msApiTasks.delete(task);
        task.signal?.removeEventListener('abort', cancel);
        onError(new Error('Запрос к api.moysklad.ru отменён'));
    };
    // Keep the listener identity stable when queued cancellation becomes active.
    task.abortListener = cancel;
    task.cancelQueued = task.cancel;
    if (task.signal?.aborted) { task.cancel(); return; }
    task.signal?.addEventListener('abort', cancel, { once: true });
    msApiTasks.add(task);
    msApiRequestQueue.push(task);
    msApiPumpQueue();
}

function msApiP(method, path, body, options) {
    return new Promise((resolve, reject) => msApi(method, path, body, resolve, reject, options));
}

// ─── Консоль-лог ──────────────────────────────────────────────────────────────
function hackerLog(msg, kind, organizationName = '') {
    hackerLogLines.push({ time: new Date(), msg: String(msg), kind: kind || 'info', organizationName });
    if (hackerLogLines.length > 300) hackerLogLines.shift();
    hackerRenderLog();
    hackerRenderFloatingLog();
}

function hackerRenderFloatingLog() {
    const box = document.getElementById('mcHackerFloatingLog');
    if (!box) return;
    const body = box.querySelector('[data-hacker-floating-body]');
    if (!body) return;
    body.textContent = '';
    hackerLogLines.slice(-8).forEach(entry => {
        const t = entry.time.toTimeString().slice(0, 8);
        const line = document.createElement('div');
        line.textContent = `[${t}] ${entry.msg}`;
        if (entry.organizationName) line.appendChild(hackerNotifierOrganizationLabel(entry.organizationName));
        body.appendChild(line);
    });
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
        if (entry.organizationName) line.appendChild(hackerNotifierOrganizationLabel(entry.organizationName));
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
    return msReferenceLoad('customerorder', { force: true })
        .then(states => {
            hackerFillSelect(document.getElementById('hackerStateSelect'), hackerStates);
            if (!quiet) hackerLog(`Статусы обновлены: ${hackerStates.length} шт.`, 'ok');
            return states;
        })
        .catch(error => hackerLog('Статусы: ' + error.message, 'err'));
}

function hackerEnsureStates(quiet) {
    if (msReferenceScope || hackerStates.length) {
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

async function hackerFindAgentByPhone(raw) {
    const generation = msApiGeneration;
    const variants = hackerNormalizePhoneVariants(raw);
    if (!variants.length) throw new Error('Введите номер телефона');
    for (const phone of variants) {
        if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
        const data = await msApiP('GET', '/entity/counterparty?filter=phone=' + phone);
        if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
        if (!Array.isArray(data?.rows) || data.errors?.length) throw new Error('Проверка контрагента не выполнена: неполный ответ');
        if (data.rows.length) return data.rows;
        // An empty page is not proof of absence when the server advertises more data.
        if (data.meta?.size > 0 || data.meta?.nextHref || data.meta?.offset > 0) {
            throw new Error('Проверка контрагента не выполнена: неполный поиск');
        }
    }
    return [];
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

let hackerAgentCreatePending = false;

async function hackerAgentCreateClick(options = {}) {
    if (hackerAgentCreatePending) return;
    const phone = document.getElementById('hackerAgentPhone')?.value.trim();
    const name = document.getElementById('hackerAgentName')?.value.trim();
    const checkFirst = options.checkFirst === true || document.getElementById('hackerAgentCheckCreate')?.checked;
    if (!phone) { hackerLog('Введите номер телефона', 'warn'); return; }
    if (!name) { hackerLog('Введите ФИО (наименование контрагента)', 'warn'); return; }

    const generation = msApiGeneration;
    hackerAgentCreatePending = true;
    const button = document.getElementById('hackerAgentCreate');
    if (button) button.disabled = true;
    let checking = !!checkFirst;
    try {
        if (checkFirst) {
            hackerLog('Ищу контрагента по номеру…');
            const rows = await hackerFindAgentByPhone(phone);
            if (rows.length) {
                const a = rows[0];
                hackerLog(`Найден: ${a.name} (телефон ${a.phone || '—'})`, 'warn');
                hackerLog('Создание не требуется', 'info');
                return;
            }
        }
        checking = false;
        if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
        const agent = await hackerCreateAgent(name, phone);
        hackerLog(`✅ Контрагент создан: ${agent.name}`, 'ok');
    } catch (error) {
        hackerLog((checking ? 'Проверка не выполнена, создание отменено: ' : 'Создание: ') + error.message, 'err');
    } finally {
        hackerAgentCreatePending = false;
        if (button) button.disabled = false;
        const current = document.getElementById('hackerAgentCreate');
        if (current) current.disabled = false;
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
    return hackerFindAgentByPhone(phone).then(rows => {
        if (!rows.length) {
            hackerLog('Контрагент по этому номеру не найден', 'err');
            return;
        }
        const a = rows[0];
        return hackerAssignAgent(a.meta.href)
            .then(() => hackerLog(`✅ Контрагент заменён: ${a.name}`, 'ok'));
    }).catch(error => hackerLog('Замена: ' + error.message, 'err'));
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
    create.disabled = hackerAgentCreatePending;
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
    return wrap;
}

// ─── Общие справочники и helpers ручного создания документов ──────────────────
function hackerApiPath(href) {
    if (!href) return '';
    try {
        const value = String(href);
        const url = new URL(value.startsWith('/') ? MS_API_BASE + value : value, MS_API_BASE + '/');
        const base = new URL(MS_API_BASE);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + '/')) return '';
        return url.pathname.slice(base.pathname.length) + url.search;
    } catch { return ''; }
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
            hackerFillSelect(document.getElementById('hackerClientStatusSelect'), items, true);
            if (!quiet) hackerLog(`«Статус клиента» обновлён: ${items.length} шт.`, 'ok');
        })
        .catch(error => hackerLog('Статус клиента: ' + error.message, 'err'));
}

function hackerRefreshPayMethods(quiet) {
    return hackerFetchAttrValues('paymentin', HACKER_ATTR_PAY_METHOD)
        .then(items => {
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

// ─── Ручные операции: отгрузка / ПКО / входящий платёж ─────────────────────────
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
/* module: src/12-moysklad-ux.js */
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
/* module: src/13-order-notifier.js */
// ─── Оповещатель новых заказов ────────────────────────────────────────────────
// Периодически проверяет customerorder выбранной организации и подаёт сигнал
// на каждом опросе, если есть заказ в одном из выбранных статусов.

function hackerNotifierNormalizeSettings(raw) {
    const interval = Number(raw?.intervalMinutes);
    const toastDuration = Number(raw?.toastDurationMinutes);
    return {
        enabled: raw?.enabled !== false,
        soundEnabled: raw?.soundEnabled !== false,
        intervalMinutes: Number.isFinite(interval)
            ? Math.min(1440, Math.max(1, Math.round(interval)))
            : HACKER_NOTIFIER_DEFAULT_INTERVAL_MINUTES,
        toastDurationMinutes: Number.isFinite(toastDuration)
            ? Math.min(1440, Math.max(0, Math.round(toastDuration)))
            : 5,
        organizationHrefs: [...new Set((Array.isArray(raw?.organizationHrefs)
            ? raw.organizationHrefs : [raw?.organizationHref])
            .filter(value => typeof value === 'string' && value.trim()))],
        statusHrefs: Array.isArray(raw?.statusHrefs)
            ? [...new Set(raw.statusHrefs.filter(value => typeof value === 'string' && value))]
            : []
    };
}

function hackerNotifierLoadSettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(storageKey('hackerOrderNotifier_v1')) || '{}');
        const matches = (raw.referenceScope || '') === msReferenceScope;
        hackerNotifierSettings = hackerNotifierNormalizeSettings(matches ? raw : { ...raw, organizationHref: '', organizationHrefs: [], statusHrefs: [] });
        if (matches) hackerNotifierSaveSettings();
        hackerNotifierStatusSelectionInitialized = matches && Array.isArray(raw?.statusHrefs);
        const organizations = JSON.parse(localStorage.getItem(storageKey('hackerNotifierOrganizations_v1')) || '[]');
        hackerNotifierOrganizations = msReferenceScope ? (msReferenceCache.lists.organization || []) : Array.isArray(organizations)
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
        localStorage.setItem(storageKey('hackerOrderNotifier_v1'), JSON.stringify({
            ...hackerNotifierSettings, ...(msReferenceScope ? { referenceScope: msReferenceScope } : {})
        }));
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

function hackerNotifierFillControls(root = document) {
    const organization = root.querySelector('#hackerNotifierOrganization');
    if (organization) {
        const selected = hackerNotifierSettings.organizationHrefs;
        organization.innerHTML = '';
        hackerNotifierOrganizations.forEach(item => {
            const option = document.createElement('option');
            option.value = item.href;
            option.textContent = item.name;
            option.title = item.name;
            option.selected = selected.includes(item.href);
            organization.appendChild(option);
        });
        selected.forEach(href => internalOrderCheckAddSavedOption(organization, href, 'ая организация'));
    }

    const statuses = root.querySelector('#hackerNotifierStatuses');
    if (statuses) {
        statuses.innerHTML = '';
        hackerStates.forEach(item => {
            const option = document.createElement('option');
            option.value = item.href;
            option.textContent = item.name;
            option.selected = hackerNotifierSettings.statusHrefs.includes(item.href);
            statuses.appendChild(option);
        });
        hackerNotifierSettings.statusHrefs.forEach(href => internalOrderCheckAddSavedOption(statuses, href, 'ый статус'));
    }
    const enabled = root.querySelector('#hackerNotifierEnabled');
    if (enabled) enabled.checked = hackerNotifierSettings.enabled;
    const soundEnabled = root.querySelector('#hackerNotifierSoundEnabled');
    if (soundEnabled) soundEnabled.checked = hackerNotifierSettings.soundEnabled;
    const interval = root.querySelector('#hackerNotifierInterval');
    if (interval) interval.value = String(hackerNotifierSettings.intervalMinutes);
    const toastDuration = root.querySelector('#hackerNotifierToastDuration');
    if (toastDuration) toastDuration.value = String(hackerNotifierSettings.toastDurationMinutes);
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
    return msReferenceLoad('organization', { force: true })
        .then(items => {
            if (!quiet) hackerLog(`Организации обновлены: ${hackerNotifierOrganizations.length} шт.`, 'ok');
            return items;
        })
        .catch(error => {
            if (!quiet) hackerLog('Организации: ' + error.message, 'err');
            hackerNotifierSetStatus('⚠️ Не удалось загрузить организации', 'error');
            throw error;
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
    if (memchatPlatform.notifier) return memchatPlatform.notifier.indicator();
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

function hackerNotifierOrganizationLabel(name) {
    const label = document.createElement('span');
    label.className = 'hacker-notifier-organization';
    label.textContent = name || 'Организация недоступна';
    label.title = label.textContent;
    label.style.cssText = 'display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.85;';
    return label;
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
    const lifetime = hackerNotifierSettings.toastDurationMinutes * 60 * 1000;
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
    toast.append(title, name, hackerNotifierOrganizationLabel(order?.organizationName), status);
    if (order?.partial) {
        const warning = document.createElement('div');
        warning.style.cssText = 'margin-top:3px;color:#fbbf24;';
        warning.textContent = '⚠ Неполный опрос организаций';
        toast.appendChild(warning);
    }

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
        if (closed || paused || !lifetime) return;
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
    {
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.title = 'Удалить уведомление';
        close.style.cssText = 'position:absolute;top:5px;right:7px;padding:0;border:0;'
            + 'background:transparent;color:#fecaca;font-size:15px;line-height:1;cursor:pointer;';
        close.addEventListener('click', removeToast);
        toast.style.position = 'relative';
        toast.appendChild(close);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.textContent = 'Удалить';
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

let hackerNotifierPollController = null;
async function hackerNotifierFetchOrganization(organizationHref, signal) {
    const rows = new Map();
    let offset = 0;
    const limit = 100;
    while (!signal.aborted) {
        const filter = encodeURIComponent('organization=' + organizationHref);
        const path = `/entity/customerorder?filter=${filter}&expand=state,organization&order=moment,desc&limit=${limit}&offset=${offset}`;
        const data = await msApiP('GET', path, null, { signal });
        if (signal.aborted) return [];
        if (!Array.isArray(data?.rows)) throw new Error('Неполный ответ списка заказов');
        const previousSize = rows.size;
        data.rows.forEach(order => {
            const id = order?.id || order?.meta?.href;
            if (id) rows.set(id, order);
        });
        const nextOffset = offset + data.rows.length;
        const hasMore = !!data.meta?.nextHref || (Number.isFinite(data.meta?.size)
            ? nextOffset < data.meta.size : data.rows.length >= limit);
        if (!hasMore) return [...rows.values()];
        if (!data.rows.length || rows.size === previousSize) throw new Error('Пагинация заказов не продвигается');
        offset = nextOffset;
    }
    return [];
}

function hackerNotifierPoll() {
    if (memchatPlatform.notifier) return memchatPlatform.notifier.poll();
    if (hackerNotifierInFlight) {
        hackerNotifierTrace('Проверка пропущена: предыдущий запрос ещё выполняется', null, 'warn');
        return Promise.resolve([]);
    }
    if (!hackerNotifierSettings.enabled) {
        hackerNotifierTrace('Проверка пропущена: оповещатель выключен', null, 'warn');
        return Promise.resolve([]);
    }
    if (!hackerNotifierSettings.organizationHrefs.length) {
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
    const controller = new AbortController();
    hackerNotifierPollController = controller;
    const organizationHrefs = [...hackerNotifierSettings.organizationHrefs];
    const statusHrefs = [...hackerNotifierSettings.statusHrefs];
    const selectedStatusNames = hackerNotifierSelectedStatusNames();
    hackerNotifierTrace('Запрос заказов', {
        organizations: organizationHrefs.length,
        statusNames: selectedStatusNames
    });
    return (async () => {
            const matching = new Map();
            const failedOrganizations = [];
            for (const organizationHref of organizationHrefs) {
                let rows;
                try {
                    rows = await hackerNotifierFetchOrganization(organizationHref, controller.signal);
                } catch (error) {
                    if (controller.signal.aborted) return [];
                    const name = hackerNotifierOrganizations.find(item => item.href === organizationHref)?.name || 'Организация недоступна';
                    failedOrganizations.push(name);
                    hackerLog('⚠ Не удалось проверить организацию', 'warn', name);
                    continue;
                }
                if (controller.signal.aborted) return [];
                const cachedName = hackerNotifierOrganizations.find(item => item.href === organizationHref)?.name;
                const bucket = { initialized: true, orders: {} };
                rows.forEach(order => {
                    const id = order.id || order.meta?.href;
                    const stateHref = order.state?.meta?.href || '';
                    const stateName = order.state?.name || 'без статуса';
                    const matches = statusHrefs.includes(stateHref) || selectedStatusNames.some(name =>
                        String(name).trim().toLowerCase() === String(stateName).trim().toLowerCase());
                    if (matches && !matching.has(id)) matching.set(id, {
                        id, name: order.name || id, stateHref, stateName, organizationHref,
                        organizationName: cachedName || order.organization?.name || 'Организация недоступна'
                    });
                    bucket.orders[id] = { stateHref, stateName, updatedAt: Date.now() };
                });
                bucket.orders = Object.fromEntries(Object.entries(bucket.orders).slice(0, 500));
                hackerNotifierSeenByOrganization[organizationHref] = bucket;
            }
            hackerNotifierSaveSeen();
            const matchingOrders = [...matching.values()];
            const partial = failedOrganizations.length > 0;
            matchingOrders.forEach(order => { order.partial = partial; });
            hackerNotifierTrace('Ответ получен', { organizations: organizationHrefs.length, matchingOrders: matchingOrders.length });
            if (matchingOrders.length) {
                matchingOrders.forEach(order => {
                    hackerLog(`🔔 Заказ ${order.name} — ${order.stateName}${partial ? ' (неполный опрос)' : ''}`, partial ? 'warn' : 'ok', order.organizationName);
                    hackerNotifierShowToast(order);
                });
                if (hackerNotifierSettings.soundEnabled) hackerNotifierPlayAlarm();
                hackerNotifierSetStatus(`🔔 Заказов в выбранных статусах: ${matchingOrders.length}`, 'ok');
            } else if (!partial) {
                hackerNotifierTrace('Совпадений по выбранным статусам нет', {
                    selectedStatusNames,
                    selectedStatusHrefs: statusHrefs
                }, 'warn');
                hackerNotifierSetStatus(`Проверено: ${new Date().toLocaleTimeString()} — совпадений нет`, 'info');
            }
            if (partial) hackerNotifierSetStatus(`⚠ Неполный опрос: не проверены ${failedOrganizations.join(', ')}. Найдено заказов: ${matchingOrders.length}`, 'error');
            return matchingOrders;
        })()
        .catch(error => {
            if (controller.signal.aborted) return [];
            hackerNotifierTrace('Ошибка запроса', { message: error?.message || String(error), error }, 'error');
            hackerNotifierSetStatus('⚠️ Ошибка проверки: ' + error.message, 'error');
            return [];
        })
        .finally(() => {
            if (hackerNotifierPollController === controller) hackerNotifierPollController = null;
            hackerNotifierInFlight = false;
        });
}

function hackerNotifierStop() {
    if (memchatPlatform.notifier) return memchatPlatform.notifier.stop();
    hackerNotifierPollController?.abort();
    if (hackerNotifierTimer) clearInterval(hackerNotifierTimer);
    hackerNotifierTimer = null;
    hackerNotifierEnsureIndicator();
}

function hackerNotifierStart() {
    if (memchatPlatform.notifier) return memchatPlatform.notifier.start();
    hackerNotifierStop();
    if (!hackerApiValidated || !hackerNotifierSettings.enabled || !hackerNotifierSettings.organizationHrefs.length) return;
    hackerNotifierTimer = setInterval(hackerNotifierPoll, hackerNotifierSettings.intervalMinutes * 60 * 1000);
    hackerNotifierEnsureIndicator();
    hackerNotifierTrace('Таймер запущен', {
        intervalMinutes: hackerNotifierSettings.intervalMinutes,
        organizationHrefs: hackerNotifierSettings.organizationHrefs,
        statusHrefs: hackerNotifierSettings.statusHrefs,
        statusNames: hackerNotifierSelectedStatusNames()
    });
}

function hackerNotifierMaybeStart() {
    hackerNotifierSelectDefaultStatus();
    hackerNotifierStart();
}

function hackerNotifierReadControls() {
    memchatPlatform.notifier?.edit();
    const enabled = document.getElementById('hackerNotifierEnabled');
    const soundEnabled = document.getElementById('hackerNotifierSoundEnabled');
    const organization = document.getElementById('hackerNotifierOrganization');
    const statuses = document.getElementById('hackerNotifierStatuses');
    const interval = document.getElementById('hackerNotifierInterval');
    const toastDuration = document.getElementById('hackerNotifierToastDuration');
    hackerNotifierSettings = hackerNotifierNormalizeSettings({
        enabled: enabled?.checked,
        soundEnabled: soundEnabled ? soundEnabled.checked : hackerNotifierSettings.soundEnabled,
        organizationHrefs: organization ? [...organization.selectedOptions].map(option => option.value) : hackerNotifierSettings.organizationHrefs,
        statusHrefs: statuses ? [...statuses.selectedOptions].map(option => option.value) : hackerNotifierSettings.statusHrefs,
        intervalMinutes: interval?.value,
        toastDurationMinutes: toastDuration?.value
    });
    hackerNotifierStatusSelectionInitialized = true;
    hackerNotifierSaveSettings();
    hackerNotifierMaybeStart();
}

function hackerBuildNotifierTab() {
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabNotifier';

    wrap.appendChild(hackerEl('div', 'font-size:11px;color:#64748b;line-height:1.4;margin-bottom:7px;',
        'Проверяет заказы выбранных организаций по таймеру и подаёт один общий сигнал на каждом опросе, пока заказ находится в выбранном статусе.'));

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

    const orgLabel = hackerEl('label', 'display:block;font-size:11.5px;color:#475569;margin-bottom:3px;', 'Организации (Ctrl/⌘ — несколько):');
    orgLabel.htmlFor = 'hackerNotifierOrganization';
    wrap.appendChild(orgLabel);
    const orgRow = hackerEl('div', 'display:flex;align-items:flex-start;gap:4px;margin-bottom:6px;');
    const organization = hackerSelect('hackerNotifierOrganization', '— выберите организацию —');
    organization.multiple = true;
    organization.size = 4;
    organization.title = 'Ctrl/⌘ + клик — добавить или снять выбор; пустой выбор останавливает опрос';
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

    const toastDurationLabel = hackerEl('label', 'display:flex;align-items:center;gap:5px;font-size:11.5px;color:#475569;margin:5px 0 7px;', 'Показывать уведомление, минут:');
    const toastDuration = document.createElement('input');
    toastDuration.id = 'hackerNotifierToastDuration';
    toastDuration.type = 'number';
    toastDuration.min = '0';
    toastDuration.max = '1440';
    toastDuration.step = '1';
    toastDuration.title = '0 — показывать до нажатия «Удалить»';
    toastDuration.style.cssText = 'width:70px;padding:4px 6px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;';
    toastDurationLabel.appendChild(toastDuration);
    wrap.appendChild(toastDurationLabel);

    const buttons = hackerEl('div', 'display:flex;gap:4px;flex-wrap:wrap;');
    const save = hackerBtn('hackerNotifierSave', '💾 Сохранить и запустить', HACKER_BTN_CSS + 'background:#4f46e5;');
    const poll = hackerBtn('hackerNotifierPollNow', '⟳ Проверить сейчас', HACKER_MINI_BTN_CSS);
    const sound = hackerBtn('hackerNotifierTestSound', '🔊 Тест сигнала', HACKER_MINI_BTN_CSS);
    buttons.append(save, poll, sound);
    wrap.appendChild(buttons);
    const status = hackerEl('div', 'min-height:16px;margin-top:6px;font-size:10.5px;', '');
    status.id = 'hackerNotifierStatus';
    if (memchatPlatform.notifier) status.textContent = hackerNotifierSettings.enabled ? 'Опрос в фоне расширения · единый для всех вкладок' : 'Оповещатель выключен';
    wrap.appendChild(status);

    hackerNotifierFillControls(wrap);
    enabled.addEventListener('change', hackerNotifierReadControls);
    soundEnabled.addEventListener('change', hackerNotifierReadControls);
    organization.addEventListener('change', hackerNotifierReadControls);
    statuses.addEventListener('change', hackerNotifierReadControls);
    interval.addEventListener('input', hackerNotifierReadControls);
    interval.addEventListener('change', hackerNotifierReadControls);
    toastDuration.addEventListener('input', hackerNotifierReadControls);
    toastDuration.addEventListener('change', hackerNotifierReadControls);
    save.addEventListener('click', () => { hackerNotifierReadControls(); hackerNotifierPoll(); });
    poll.addEventListener('click', () => { hackerNotifierReadControls(); hackerNotifierPoll(); });
    sound.addEventListener('click', hackerNotifierPlayAlarm);
    refreshOrg.addEventListener('click', () => {
        hackerNotifierRefreshOrganizations(false).catch(() => {});
    });

    hackerNotifierSelectDefaultStatus();
    hackerNotifierFillControls(wrap);
    return wrap;
}
/* module: src/14-internal-order-check.js */
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
        internalOrderCheckSettings = internalOrderCheckNormalizeSettings((raw.referenceScope || '') === msReferenceScope ? raw : {});
        const warehouses = JSON.parse(localStorage.getItem(storageKey('hackerInternalOrderWarehouses_v1')) || '[]');
        internalOrderCheckWarehouses = msReferenceScope ? (msReferenceCache.lists.store || []) : Array.isArray(warehouses)
            ? warehouses.filter(item => item && typeof item.name === 'string' && typeof item.href === 'string')
            : [];
    } catch (error) {
        internalOrderCheckSettings = internalOrderCheckNormalizeSettings({});
        internalOrderCheckTrace('Не удалось загрузить настройки сравнения', error, 'err');
    }
}

function internalOrderCheckSaveSettings() {
    try {
        localStorage.setItem(storageKey(INTERNAL_ORDER_CHECK_STORAGE_KEY), JSON.stringify({
            ...internalOrderCheckSettings, ...(msReferenceScope ? { referenceScope: msReferenceScope } : {})
        }));
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

function internalOrderCheckAddSavedOption(select, value, label) {
    if (!value || [...select.options].some(option => option.value === value)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `⚠ Сохранённ${label} — отсутствует в справочнике`;
    option.dataset.savedSelection = 'true';
    option.selected = true;
    select.appendChild(option);
}

function internalOrderCheckFillOrganizations(root = document) {
    [
        ['hackerInternalCustomerOrganization', 'customerOrganizationHref'],
        ['hackerInternalOrderOrganization', 'internalOrganizationHref']
    ].forEach(([id, key]) => {
        const select = root.querySelector('#' + id);
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
        internalOrderCheckAddSavedOption(select, selected, 'ая организация');
        select.value = selected;
    });
}

function internalOrderCheckFillWarehouses(root = document) {
    [
        ['hackerInternalCustomerWarehouse', 'customerWarehouseHref'],
        ['hackerInternalOrderWarehouse', 'internalWarehouseHref']
    ].forEach(([id, key]) => {
        const select = root.querySelector('#' + id);
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
        internalOrderCheckAddSavedOption(select, selected, 'ый склад');
        select.value = selected;
    });
}

function internalOrderCheckFillStatuses(entity, root = document) {
    const config = INTERNAL_ORDER_CHECK_ENTITIES[entity];
    const select = root.querySelector(entity === 'customerorder'
        ? '#hackerInternalCustomerStatuses'
        : '#hackerInternalOrderStatuses');
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
    selected.forEach(href => internalOrderCheckAddSavedOption(select, href, 'ый статус'));
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
        customerOrganizationHref: customerOrganization ? customerOrganization.value : internalOrderCheckSettings.customerOrganizationHref,
        internalOrganizationHref: internalOrganization ? internalOrganization.value : internalOrderCheckSettings.internalOrganizationHref,
        customerWarehouseHref: customerWarehouse ? customerWarehouse.value : internalOrderCheckSettings.customerWarehouseHref,
        internalWarehouseHref: internalWarehouse ? internalWarehouse.value : internalOrderCheckSettings.internalWarehouseHref,
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
    return msReferenceLoad(entity, { force: true });
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
    return msReferenceLoad('store', { force: true });
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
    return msReferenceRefresh({ force: true, status });
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

function internalOrderCheckFetchAllPages(path, rows = [], visited = new Set(), generation = msApiGeneration) {
    if (generation !== msApiGeneration) return Promise.reject(new Error('Запрос к api.moysklad.ru отменён'));
    const normalizedPath = hackerApiPath(path);
    if (!normalizedPath || visited.has(normalizedPath)) {
        return Promise.reject(new Error('МойСклад вернул циклическую ссылку пагинации'));
    }
    visited.add(normalizedPath);
    return msApiP('GET', normalizedPath).then(page => {
        if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
        const pageRows = Array.isArray(page?.rows) ? page.rows : [];
        rows.push(...pageRows);
        const nextHref = page?.meta?.nextHref;
        return nextHref
            ? internalOrderCheckFetchAllPages(nextHref, rows, visited, generation)
            : rows;
    });
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
    return internalOrderCheckFetchAllPages(path).then(rows => {
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
    const initialRows = Array.isArray(document?.positions?.rows) ? document.positions.rows : [];
    const nextHref = document?.positions?.meta?.nextHref;
    if (nextHref) return internalOrderCheckFetchAllPages(nextHref, initialRows);
    if (Array.isArray(document?.positions?.rows)) return Promise.resolve(initialRows);
    const id = document?.id || document?.meta?.href?.split('/').pop();
    if (!id) return Promise.resolve([]);
    return internalOrderCheckFetchAllPages(`/entity/${entity}/${id}/positions?expand=assortment&limit=1000`);
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

function internalOrderCheckShowResult(result) {
    document.getElementById('hackerInternalOrderCheckResult')?.remove();
    const win = document.createElement('div');
    win.id = 'hackerInternalOrderCheckResult';
    win.className = 'mc-float-window';
    win.style.width = '430px';
    win.style.right = '460px';

    const header = document.createElement('div');
    header.className = 'mc-float-header';
    const title = document.createElement('div');
    title.className = 'mc-float-title';
    title.textContent = '📦 Результат проверки товаров';
    header.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mc-float-close';
    close.textContent = '✕';
    close.addEventListener('click', () => win.remove());
    header.appendChild(close);
    win.appendChild(header);

    const body = document.createElement('div');
    body.className = 'mc-float-body';
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:11px;color:#64748b;margin-bottom:8px;';
    summary.textContent = `Добавлено: ${result.added.length}; упущено: ${result.missed.length}`;
    body.appendChild(summary);

    const addSection = (titleText, items, color, emptyText) => {
        const section = document.createElement('section');
        section.style.cssText = 'margin-bottom:10px;';
        const heading = document.createElement('div');
        heading.style.cssText = `font-size:11.5px;font-weight:700;color:${color};margin-bottom:4px;`;
        heading.textContent = titleText;
        section.appendChild(heading);
        if (!items.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:7px 9px;border:1px solid #e5e7eb;border-radius:7px;color:#64748b;font-size:11px;';
            empty.textContent = emptyText;
            section.appendChild(empty);
        } else {
            items.forEach(item => {
                const row = document.createElement('div');
                row.style.cssText = 'padding:6px 9px;margin-top:4px;border:1px solid #e5e7eb;border-radius:7px;background:#fff;color:#1f2937;font-size:11.5px;';
                row.textContent = `${item.name} × ${item.quantity}`;
                section.appendChild(row);
            });
        }
        body.appendChild(section);
    };

    addSection('➕ Добавлено во внутренних заказах', result.added, '#166534', 'Нет лишних позиций');
    addSection('⚠️ Упущено во внутренних заказах', result.missed, '#b91c1c', 'Все позиции покрыты');
    win.appendChild(body);
    document.body.appendChild(win);
    makeMovable(win, header);
}

async function internalOrderCheckCollectGoods(entity, documents) {
    const generation = msApiGeneration;
    const outcomes = new Array(documents.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < documents.length) {
            if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
            const index = nextIndex++;
            const document = documents[index];
            try {
                const positions = await internalOrderCheckPositionRows(entity, document);
                if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
                internalOrderCheckTrace(`${document.name || document.id}: получено позиций — ${positions.length}`);
                outcomes[index] = { document, positions, error: null };
            } catch (error) {
                if (generation !== msApiGeneration) throw error;
                internalOrderCheckTrace(`${document.name || document.id}: не удалось получить позиции`, error, 'err');
                outcomes[index] = { document, positions: [], error };
            }
        }
    };
    const workerCount = Math.min(MS_API_MAX_CONCURRENT_REQUESTS, documents.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    const failures = outcomes.filter(outcome => outcome.error);
    if (failures.length) {
        const error = new Error(`Не удалось полностью загрузить позиции для ${failures.length} из ${documents.length} документов`);
        error.partialFailure = true;
        error.failedDocuments = failures.map(outcome => outcome.document.name || outcome.document.id || 'Без названия');
        throw error;
    }
    return internalOrderCheckAggregate(outcomes.flatMap(outcome => outcome.positions));
}

async function internalOrderCheckCompare() {
    const generation = msApiGeneration;
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
        // Do not switch accounts between list collection and position reads.
        if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
        const [customerGoods, internalGoods] = await Promise.all([
            internalOrderCheckCollectGoods('customerorder', customerOrders),
            internalOrderCheckCollectGoods('internalorder', internalOrders)
        ]);
        if (generation !== msApiGeneration) throw new Error('Запрос к api.moysklad.ru отменён');
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
        internalOrderCheckShowResult(result);
        setStatus(`Готово: добавлено ${result.added.length}, упущено ${result.missed.length}`);
        return result;
    } catch (error) {
        const message = error.partialFailure
            ? `Данные неполные, сравнение отменено. Ошибка загрузки: ${error.failedDocuments.join(', ')}`
            : error.message || String(error);
        internalOrderCheckTrace('Сравнение не выполнено', error, 'err');
        setStatus(message, 'err');
        return null;
    } finally {
        if (compare) compare.disabled = false;
    }
}

function internalOrderCheckBuildSettingsPanel() {
    internalOrderCheckLoadSettings();
    const wrap = hackerEl('div');
    wrap.id = 'hackerInternalOrderSettings';
    wrap.appendChild(hackerEl('div', 'font-size:11px;color:#64748b;line-height:1.4;margin-bottom:8px;',
        'Эти параметры используются вкладкой «Проверка заказов». Изменения сохраняются автоматически.'));

    const field = (label, select) => {
        const block = hackerEl('label', 'display:block;font-size:11px;color:#475569;margin-bottom:8px;', label);
        block.appendChild(select);
        return block;
    };
    const selectStyle = 'display:block;width:100%;margin-top:3px;padding:5px 6px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;color:#334155;font-size:11px;';
    const customerOrganization = hackerSelect('hackerInternalCustomerOrganization', '— организация заказов —');
    const internalOrganization = hackerSelect('hackerInternalOrderOrganization', '— организация внутренних заказов —');
    const customerWarehouse = hackerSelect('hackerInternalCustomerWarehouse', '— склад заказов —');
    const internalWarehouse = hackerSelect('hackerInternalOrderWarehouse', '— склад внутренних заказов —');
    [customerOrganization, internalOrganization, customerWarehouse, internalWarehouse].forEach(select => { select.style.cssText = selectStyle; });

    const customerStatuses = document.createElement('select');
    customerStatuses.id = 'hackerInternalCustomerStatuses';
    customerStatuses.multiple = true;
    customerStatuses.size = 4;
    customerStatuses.style.cssText = selectStyle + 'min-height:76px;';
    const internalStatuses = customerStatuses.cloneNode(false);
    internalStatuses.id = 'hackerInternalOrderStatuses';

    wrap.appendChild(field('Организация заказов:', customerOrganization));
    wrap.appendChild(field('Организация внутренних заказов:', internalOrganization));
    wrap.appendChild(field('Склад заказов:', customerWarehouse));
    wrap.appendChild(field('Склад внутренних заказов:', internalWarehouse));
    wrap.appendChild(field('Статусы заказов (Ctrl/⌘ — несколько):', customerStatuses));
    wrap.appendChild(field('Статусы внутренних заказов (Ctrl/⌘ — несколько):', internalStatuses));

    const refresh = hackerBtn('hackerInternalOrderRefresh', '⬇ Загрузить справочники', HACKER_MINI_BTN_CSS);
    wrap.appendChild(refresh);
    const status = hackerEl('div', 'min-height:16px;margin-top:6px;font-size:10.5px;', '');
    status.id = 'hackerInternalOrderSettingsStatus';
    wrap.appendChild(status);

    internalOrderCheckFillOrganizations(wrap);
    internalOrderCheckFillWarehouses(wrap);
    internalOrderCheckFillStatuses('customerorder', wrap);
    internalOrderCheckFillStatuses('internalorder', wrap);
    msReferenceShowStatus(status);
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
    return wrap;
}

function hackerBuildInternalOrderCheckTab() {
    internalOrderCheckLoadSettings();
    const wrap = hackerEl('div');
    wrap.id = 'hackerTabInternalOrderCheck';
    wrap.appendChild(hackerEl('div', 'font-size:11px;color:#64748b;line-height:1.4;margin-bottom:8px;',
        'Сравнивает товары из заказов покупателей с товарами из внутренних заказов по сохранённым параметрам.'));

    const buttons = hackerEl('div', 'display:flex;gap:4px;flex-wrap:wrap;');
    const settings = hackerBtn('hackerInternalOrderOpenSettings', '⚙️ Настроить проверку', HACKER_MINI_BTN_CSS);
    const compare = hackerBtn('hackerInternalOrderCompare', '🔎 Проверить товары', HACKER_BTN_CSS + 'background:#4f46e5;');
    buttons.append(settings, compare);
    wrap.appendChild(buttons);
    const status = hackerEl('div', 'min-height:16px;margin-top:6px;font-size:10.5px;', '');
    status.id = 'hackerInternalOrderCheckStatus';
    wrap.appendChild(status);

    settings.addEventListener('click', () => openSettingsWindow('internalOrderCheck'));
    compare.addEventListener('click', () => { internalOrderCheckCompare().catch(error => internalOrderCheckTrace('Сравнение: ' + error.message, error, 'err')); });
    return wrap;
}
/* module: extension/runtime.js */
// Private Panel adapter and startup/lifecycle capabilities. Configured before initialize.
let extensionPanelRequestSequence = 0;
let extensionPanelStateListener = () => {};
function extensionPanelAuthLost() {
    extensionPanelRequestSequence++;
    extensionPanelStateListener('error', 'Panel: сессия недоступна. Войдите в panel.hatiko.ru в этом профиле Chrome.');
}
function extensionPanelCsrf(onSuccess, onError, force) {
    let finished = false;
    const sequence = ++extensionPanelRequestSequence;
    extensionPanelStateListener('unknown', 'Panel: проверяем сессию…');
    const finish = result => {
        if (finished) return;
        finished = true;
        const error = chrome.runtime.lastError
            ? 'Расширение обновлено или недоступно. Перезагрузите вкладку.'
            : result?.ok && typeof result.token === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(result.token)
                ? '' : result?.error || 'Panel: фоновая сессия недоступна. Войдите в panel.hatiko.ru.';
        if (sequence === extensionPanelRequestSequence) extensionPanelStateListener(error ? 'error' : 'ok', error);
        if (error) onError?.(new Error(error)); else onSuccess?.(result.token);
    };
    try { chrome.runtime.sendMessage({ type: 'memchat:panel-csrf', force }, finish); }
    catch { finish({ ok: false, error: 'Расширение недоступно. Перезагрузите вкладку.' }); }
}
function configureExtensionPlatform(platform) {
    platform.panel = { ensure: extensionPanelCsrf };
    platform.directMs = true;
    clearPanelCsrf();
    if (typeof extensionConfigureOrders === 'function') extensionConfigureOrders(platform);
    if (typeof extensionConfigureDiagnostics === 'function') extensionConfigureDiagnostics(platform);
    // Cross-tab changes use private runtime messages, never site-readable StorageEvents.
    if (typeof extensionStorageOnChange !== 'undefined') {
        extensionStorageOnChange = key => {
            if (key === storageKey('hackerMsApi_v1')) hackerCheckCredentialScope();
            if ([storageKey('clearTextEnabled'), storageKey('clearTextDelay_v1')].includes(key)) setupGlobalClearTextFunctionality();
        };
        extensionStorageOnError = () => {
            hackerCredentialScopeBlocked = true;
            hackerApiValidated = false;
            msApiCancelAll();
            hackerSyncAccessUi();
        };
    }
}

configureExtensionPlatform(memchatPlatform);
/* module: extension/orders-runtime.js */
// Extension-only notifier: content tabs configure/render; the MV3 worker polls.
let extensionOrderRevision;
let extensionOrderToken = '';
let extensionOrderEdit = false;
let extensionOrderSync = Promise.resolve();
let extensionOrderLastShown = '';
const extensionConnectionState = { panel: 'unknown', bearer: 'unknown', panelError: '' };
function extensionMessage(message) {
    return new Promise((resolve, reject) => {
        try { chrome.runtime.sendMessage(message, result => {
            if (chrome.runtime.lastError) reject(Error('Расширение обновлено. Перезагрузите вкладку.'));
            else if (!result?.ok) {
                if (result?.conflict) extensionOrderRevision = result.revision;
                reject(Error(result?.error || 'Расширение недоступно'));
            } else resolve(result);
        }); } catch { reject(Error('Расширение недоступно. Перезагрузите вкладку.')); }
    });
}
function extensionRenderConnections() {
    const root = document.getElementById('memchatConnectionStatus');
    if (!root) return;
    extensionConnectionState.bearer = hackerApiValidated && hackerBearerEnabled ? 'ok' : 'error';
    for (const name of ['bearer', 'panel']) {
        const el = root.querySelector(`[data-connection="${name}"]`);
        const state = navigator.onLine === false ? 'unknown' : extensionConnectionState[name];
        const text = `${state === 'ok' ? '🟢' : state === 'error' ? '🔴' : '🟡'} ${name}`;
        if (el.textContent !== text) el.textContent = text;
        el.dataset.state = state;
        el.title = name === 'panel'
            ? (extensionConnectionState.panelError || 'Panel: подтверждён доступ к защищённому API.')
                + (state === 'error' ? ' Открыть panel.hatiko.ru в новой вкладке.' : ' Нажми для повторной проверки.')
            : 'Bearer: подтверждение ключа МойСклад в этой вкладке.';
        el.setAttribute('aria-label', el.title);
    }
}
function extensionAttachConnections() {
    const main = window.priceCheckContainer;
    if (!main || document.getElementById('memchatConnectionStatus')) return;
    const root = document.createElement('div');
    root.id = 'memchatConnectionStatus';
    root.style.cssText = 'display:flex;gap:9px;align-items:center;font:8.5px/1.4 Segoe UI,sans-serif;margin-top:2px;color:#475569;flex-wrap:wrap;';
    for (const name of ['bearer', 'panel']) {
        const el = document.createElement('button');
        el.type = 'button'; el.dataset.connection = name;
        el.style.cssText = 'border:0;background:transparent;padding:0;cursor:pointer;font:inherit;color:inherit;';
        el.addEventListener('click', () => {
            if (name === 'bearer') hackerValidateApiKey();
            else if (el.dataset.state === 'error') window.open('https://panel.hatiko.ru/', '_blank', 'noopener,noreferrer');
            else extensionCheckPanel(true);
        });
        root.appendChild(el);
    }
    const oldStatus = document.getElementById('memchatBearerStatus');
    if (oldStatus) oldStatus.replaceWith(root);
    else document.getElementById('memchatVersion')?.after(root);
    extensionRenderConnections();
    extensionCheckPanel(false);
}
function extensionCheckPanel(force) {
    return extensionPanelCsrf(() => {}, () => {}, force === true);
}
function extensionConfigureOrders(platform) {
    platform.onMainCreated = extensionAttachConnections;
    platform.onAccessUi = extensionRenderConnections;
    extensionPanelStateListener = (state, error) => {
        extensionConnectionState.panel = state;
        extensionConnectionState.panelError = error || '';
        extensionRenderConnections();
    };
    platform.notifier = { start: extensionNotifierStart, stop: extensionNotifierStop, poll: extensionNotifierPoll,
        indicator: extensionNotifierEnsureIndicator, edit: () => { extensionOrderEdit = true; } };
}
window.addEventListener('offline', extensionRenderConnections);
window.addEventListener('online', () => { extensionConnectionState.panel = 'unknown'; extensionRenderConnections(); });

function extensionNotifierEnsureIndicator() {
    let indicator = document.getElementById('hackerNotifierIndicator');
    const enabled = hackerApiValidated && hackerNotifierSettings.enabled && hackerNotifierSettings.organizationHrefs.length && hackerNotifierSettings.statusHrefs.length;
    if (!enabled) { indicator?.remove(); return; }
    if (!indicator) {
        indicator = document.createElement('span'); indicator.id = 'hackerNotifierIndicator'; indicator.textContent = '🐻';
        indicator.title = 'Опрос заказов выполняется в фоне расширения';
        indicator.style.cssText = 'position:fixed;right:14px;bottom:12px;opacity:.35;pointer-events:none;'; document.body.appendChild(indicator);
    }
};
function extensionNotifierStop() {
    extensionOrderToken = '';
    // This hook is called before a local credential change/failed validation.
    // Pagehide does not revoke the worker: closing a tab must not stop polling.
    if (hackerNotifierTimer) clearInterval(hackerNotifierTimer);
    hackerNotifierTimer = null;
    const token = hackerBearerToken;
    if (!token) return Promise.resolve();
    const pending = extensionOrderSync.then(() => extensionMessage({ type: 'memchat:orders-stop', token }))
        .then(result => { extensionOrderRevision = result.revision; }, () => {});
    extensionOrderSync = pending;
    return pending;
};
function extensionNotifierStart() {
    if (hackerNotifierTimer) clearInterval(hackerNotifierTimer);
    hackerNotifierTimer = null;
    if (!hackerApiValidated || !hackerBearerEnabled || !hackerBearerToken.trim()) return Promise.resolve();
    const update = extensionOrderEdit; extensionOrderEdit = false;
    const payload = { type: 'memchat:orders-configure', token: hackerBearerToken, settings: { ...hackerNotifierSettings },
        organizations: hackerNotifierOrganizations.map(item => ({ href: item.href, name: item.name })), update };
    const generation = msApiGeneration;
    const pending = extensionOrderSync.then(() => extensionMessage({ ...payload, revision: extensionOrderRevision }))
        .then(result => {
            if (generation !== msApiGeneration || payload.token !== hackerBearerToken || !hackerApiValidated || !hackerBearerEnabled) return false;
            extensionOrderRevision = result.revision;
            extensionOrderToken = payload.token;
            if (result.settings) hackerNotifierSettings = hackerNotifierNormalizeSettings(result.settings);
            hackerNotifierSaveSettings(); hackerNotifierFillControls(); hackerNotifierEnsureIndicator();
            const ready = hackerNotifierSettings.enabled && hackerNotifierSettings.organizationHrefs.length && hackerNotifierSettings.statusHrefs.length;
            hackerNotifierSetStatus(!hackerNotifierSettings.enabled ? 'Оповещатель выключен'
                : ready ? 'Проверяем заказы…' : 'Выберите организацию и статусы для оповещения', ready ? 'info' : 'warn');
            return !!ready;
        }).catch(error => { hackerNotifierSetStatus(error.message, 'error'); return false; });
    // Keep configuration separate from the poll: poll waits for this chain.
    extensionOrderSync = pending;
    return pending.then(ready => ready ? hackerNotifierPoll() : []);
};
async function extensionNotifierPoll() {
    try {
        await extensionOrderSync;
        const response = await extensionMessage({ type: 'memchat:orders-poll', token: hackerBearerToken });
        // Results/toasts are delivered to one tab by the worker, never per caller.
        const result = response.result;
        hackerNotifierSetStatus(result.partial ? '⚠ Неполный опрос: ' + result.failed.join(', ')
            : `Проверено: ${new Date(result.at).toLocaleTimeString()} · заказов: ${result.orders.length}`, result.partial ? 'error' : 'ok');
        return result.orders;
    } catch (error) { hackerNotifierSetStatus(error.message, 'error'); return []; }
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('worker.js'))) return false;
    if (message?.type !== 'memchat:orders-result') return false;
    if (!hackerApiValidated || !hackerBearerEnabled || extensionOrderToken !== hackerBearerToken || message.revision !== extensionOrderRevision) { respond({ ok: false }); return false; }
    const result = message.result;
    if (!result || !Array.isArray(result.orders)) return false;
    if (extensionOrderLastShown !== result.id) {
        extensionOrderLastShown = result.id;
        if (message.settings) hackerNotifierSettings = hackerNotifierNormalizeSettings(message.settings);
        if (result.bearer === 'error') { hackerApiValidated = false; hackerSyncAccessUi(); }
        result.orders.forEach(hackerNotifierShowToast);
        if (result.orders.length && hackerNotifierSettings.soundEnabled) hackerNotifierPlayAlarm();
        hackerNotifierSetStatus(result.partial ? '⚠ Неполный опрос: ' + result.failed.join(', ')
            : `Проверено: ${new Date(result.at).toLocaleTimeString()} · заказов: ${result.orders.length}`, result.partial ? 'error' : 'ok');
        hackerNotifierEnsureIndicator();
    }
    respond({ ok: true });
    return false;
});
extensionConfigureOrders(memchatPlatform);
/* module: extension/api-diagnostics.js */
// Extension-only read diagnostics. No writes, response persistence or credential output.
const extensionDiagnosticPresets = [
    ['Заказы покупателей', '/entity/customerorder?limit=1&expand=state,organization'],
    ['Статусы заказов', '/entity/customerorder/metadata'],
    ['Организации', '/entity/organization?limit=10'],
    ['Склады', '/entity/store?limit=10'],
    ['Товары', '/entity/product?limit=1'],
    ['Контрагенты', '/entity/counterparty?limit=1'],
    ['Свой GET-запрос', '']
];
const extensionDiagnosticSecretKey = /token|password|secret|authorization|credential|cookie|api.?key|session/i;
function extensionDiagnosticPath(raw) {
    const value = String(raw || '').trim();
    const url = new URL(value.startsWith('/') ? MS_API_BASE + value : value, MS_API_BASE + '/');
    const path = hackerApiPath(value);
    if (!path || !/^\/(entity|report)\//.test(path) || url.username || url.password || url.hash) throw Error('Доступны только GET entity/report API МойСклад без учётных данных в адресе');
    if ([...url.searchParams.keys()].some(key => extensionDiagnosticSecretKey.test(key))
        || (hackerBearerToken && value.includes(hackerBearerToken))) throw Error('Не добавляйте секреты в адрес запроса');
    return path;
}
function extensionDiagnosticText(value, token = hackerBearerToken) {
    const clean = text => {
        let result = token ? String(text).split(token).join('[REDACTED]') : String(text);
        return result.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
            .replace(/([?&](?:access_token|token|api_?key|password|secret)=)[^&#\s"']*/gi, '$1[REDACTED]');
    };
    if (typeof value === 'string') return clean(value);
    return JSON.stringify(value, (key, item) => key === '_status' ? undefined
        : extensionDiagnosticSecretKey.test(key) ? '[REDACTED]' : typeof item === 'string' ? clean(item) : item, 2);
}
async function extensionRunDiagnostic(raw, result, button) {
    const generation = msApiGeneration, token = hackerBearerToken, started = Date.now();
    button.disabled = true; result.textContent = 'Выполняется GET…';
    try {
        const path = extensionDiagnosticPath(raw);
        const data = await msApiP('GET', path);
        if (generation !== msApiGeneration || token !== hackerBearerToken || !result.isConnected) return;
        const body = extensionDiagnosticText(data, token) || 'Пустой ответ';
        result.textContent = extensionDiagnosticText(`GET ${path}\nHTTP ${data?._status || '2xx (пустой/не JSON)'} · ${Date.now() - started} мс\n`
            + `Строк: ${Array.isArray(data?.rows) ? data.rows.length : 'не список'} · Всего: ${data?.meta?.size ?? 'не указано'}\n\n`
            + body.slice(0, 80000) + (body.length > 80000 ? '\n[Показаны первые 80 000 символов]' : ''), token);
    } catch (error) {
        if (generation !== msApiGeneration || token !== hackerBearerToken || !result.isConnected) return;
        result.textContent = extensionDiagnosticText(`${error.status ? 'HTTP ' + error.status : 'Нет HTTP-ответа'} · ${Date.now() - started} мс\n${error.apiCode ? 'Код API: ' + error.apiCode + '\n' : ''}${error.message || 'Ошибка запроса'}`, token);
    } finally { button.disabled = false; }
}
async function extensionRunOrderDiagnostic(result, button) {
    const generation = msApiGeneration, token = hackerBearerToken;
    button.disabled = true; result.textContent = 'Опрашиваем выбранные организации и статусы…';
    try {
        await extensionOrderSync;
        const response = await extensionMessage({ type: 'memchat:orders-poll', token });
        if (generation !== msApiGeneration || token !== hackerBearerToken || !result.isConnected) return;
        const data = response.result;
        result.textContent = extensionDiagnosticText(`Оповещатель: ${data.partial ? 'НЕПОЛНЫЙ ОПРОС' : 'опрос завершён'}\n`
            + `Проверено: ${new Date(data.at).toLocaleTimeString()}\nЗаказов: ${data.orders.length}\nBearer: ${data.bearer}\n`
            + (data.failed.length ? 'Ошибки: ' + data.failed.join('; ') : 'Ошибок API при опросе нет'), token);
    } catch (error) {
        if (generation === msApiGeneration && token === hackerBearerToken && result.isConnected) result.textContent = extensionDiagnosticText(error.message, token);
    } finally { button.disabled = false; }
}
function extensionBuildDiagnostics() {
    const root = hackerEl('div', 'display:flex;flex-direction:column;gap:7px;padding-top:8px;');
    root.appendChild(hackerEl('div', 'font-size:11px;color:#475569;', 'Только чтение (GET). Ключ берётся из настроек, не выводится и не включается в адрес. Ответ не сохраняется.'));
    const preset = document.createElement('select'); preset.id = 'hackerApiDiagnosticPreset';
    const input = document.createElement('input'); input.id = 'hackerApiDiagnosticPath'; input.type = 'text';
    for (const [name, value] of extensionDiagnosticPresets) { const option = document.createElement('option'); option.textContent = name; option.value = value; preset.appendChild(option); }
    input.value = extensionDiagnosticPresets[0][1]; input.setAttribute('aria-label', 'Путь GET-запроса МойСклад');
    for (const el of [preset, input]) el.style.cssText = 'box-sizing:border-box;width:100%;padding:7px;border:1px solid #cbd5e1;border-radius:7px;font:11px Segoe UI,sans-serif;';
    preset.addEventListener('change', () => { input.value = preset.value || '/entity/customerorder?limit=1'; });
    const run = document.createElement('button'); run.type = 'button'; run.id = 'hackerApiDiagnosticRun'; run.textContent = 'Выполнить GET';
    const poll = document.createElement('button'); poll.type = 'button'; poll.id = 'hackerApiDiagnosticPoll'; poll.textContent = 'Проверить оповещатель сейчас';
    const toast = document.createElement('button'); toast.type = 'button'; toast.id = 'hackerApiDiagnosticToast'; toast.textContent = 'Тест уведомления';
    const result = document.createElement('pre'); result.id = 'hackerApiDiagnosticResult'; result.setAttribute('aria-live', 'polite');
    result.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:270px;overflow:auto;margin:0;padding:8px;border-radius:8px;background:#0f172a;color:#e2e8f0;font:10px/1.4 Consolas,monospace;';
    result.textContent = 'Выберите готовый запрос или укажите /entity/…?limit=1. Для точного фильтра оповещателя используйте отдельную кнопку.';
    for (const button of [run, poll, toast]) button.style.cssText = 'padding:7px;border:1px solid #cbd5e1;border-radius:7px;cursor:pointer;font:11px Segoe UI,sans-serif;';
    run.addEventListener('click', () => extensionRunDiagnostic(input.value, result, run));
    poll.addEventListener('click', () => extensionRunOrderDiagnostic(result, poll));
    toast.addEventListener('click', () => {
        hackerNotifierShowToast({ name: 'ТЕСТ — не реальный заказ', stateName: 'Проверка отображения', organizationName: 'Тест расширения' });
        if (hackerNotifierSettings.soundEnabled) hackerNotifierPlayAlarm();
    });
    root.append(preset, input, run, poll, toast, result);
    return root;
}
// Product comparison is absent from this package. Only notifier references are bootstrapped.
function extensionReferenceShowStatus(status = document.getElementById('hackerApiReferenceStatus')) {
    const labels = { organization: 'Организации', customerorder: 'Статусы заказов' };
    const errors = Object.entries(msReferenceCache.errors || {}).filter(([kind]) => Object.hasOwn(labels, kind));
    const missing = Object.keys(labels).filter(kind => !Object.hasOwn(msReferenceCache.lists, kind));
    const text = errors.length ? errors.map(([kind, message]) => `${labels[kind]} — ${message}`).join('; ')
        : missing.length ? 'Не загружены: ' + missing.map(kind => labels[kind]).join(', ') : 'Справочники оповещателя загружены';
    if (status) { status.textContent = text; status.style.color = errors.length || missing.length ? '#b91c1c' : '#166534'; }
    if (errors.length) hackerNotifierSetStatus(text, 'error');
};
async function extensionReferenceRefresh({ force = false, states, status } = {}) {
    const scope = msReferenceScope, generation = msApiGeneration;
    const kinds = ['organization', 'customerorder'];
    msReferenceCache.attempted = true;
    const outcomes = await Promise.allSettled(kinds.map(kind => msReferenceLoad(kind,
        { force, seed: kind === 'customerorder' ? states : undefined })));
    msReferenceAssertCurrent(scope, generation);
    msReferenceCache.errors = Object.fromEntries(outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
        ? [[kinds[index], outcome.reason.status ? `HTTP ${outcome.reason.status}` : 'ошибка загрузки; повторите вручную']] : []));
    msReferenceSave(); msReferenceShowStatus(status);
    return { ok: Object.keys(msReferenceCache.errors).length === 0, errors: msReferenceCache.errors };
};
function extensionCleanSettings() {
    document.getElementById('mcSettingsTabInternalOrderCheck')?.remove();
    document.getElementById('mcSettingsInternalOrderCheckPane')?.remove();
}
function extensionSelectDiagnostic(key) {
    const old = document.querySelector('[data-hacker-tab="internalOrderCheck"]');
    if (old) { old.dataset.hackerTab = 'requests'; old.textContent = 'Проверка запросов'; }
    if (key === 'internalOrderCheck') key = 'requests';
    if (key !== 'requests') return false;
    hackerTab = key;
    document.querySelectorAll('#hackerTabs [data-hacker-tab]').forEach(button => {
        const active = button.dataset.hackerTab === key;
        button.style.background = active ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : '#f8fafc';
        button.style.color = active ? '#fff' : '#475569'; button.style.borderColor = active ? 'transparent' : '#e2e8f0';
    });
    document.getElementById('hackerTabPanes')?.replaceChildren(extensionBuildDiagnostics());
    return true;
};

function extensionConfigureDiagnostics(platform) {
    platform.references = { refresh: extensionReferenceRefresh, showStatus: extensionReferenceShowStatus };
    platform.diagnostics = { select: extensionSelectDiagnostic, cleanSettings: extensionCleanSettings };
}
extensionConfigureDiagnostics(memchatPlatform);
/* module: extension/top-layer.js */
/* Extension-only Memchat UI promotion. Include after the production userscript body. */
(() => {
    'use strict';
    if (!document.body || typeof document.createElement('div').showPopover !== 'function' || document.querySelector('[data-memchat-top-layer]')) return;

    const ROOT_SELECTOR = [
        '#priceCheckContainer', '.mc-float-window', '.mc-overlay', '#hatikoProductPicker',
        '#mcHackerQuickPopup', '#mcHackerAgentPopup', '#mcHackerFloatingLog', '#mcMsToast',
        '#mcOrderStatusPopup', '#mcMagicPopup', '#hackerNotifierToastHost'
    ].join(',');
    const host = document.createElement('div');
    host.setAttribute('data-memchat-top-layer', '');
    host.setAttribute('popover', 'manual');
    host.setAttribute('aria-label', 'Memchat');
    const style = document.createElement('style');
    style.textContent = `
      [data-memchat-top-layer] { position:fixed !important; inset:0 !important; z-index:2147483647 !important; margin:0 !important; padding:0 !important; border:0 !important; width:auto !important; height:auto !important; max-width:none !important; max-height:none !important; overflow:visible !important; background:transparent !important; color:inherit; pointer-events:none !important; }
      [data-memchat-top-layer]::backdrop { background:transparent !important; pointer-events:none !important; }
      [data-memchat-top-layer] > * { pointer-events:auto !important; }
      [data-memchat-top-layer] > #hackerNotifierToastHost { pointer-events:none !important; }
    `;
    host.appendChild(style);
    document.body.appendChild(host);

    let scheduled = false;
    let forcePromotion = false;
    let scheduledTimer = 0;
    let lastModal = null;
    let lastFullscreen = null;
    let externalTopLayerTimer = 0;
    const modalOrder = [];

    function isModal(dialog) {
        try { return dialog.matches(':modal'); } catch (_) { return false; }
    }

    function activeModal() {
        const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
        const modals = dialogs.filter(isModal);
        for (let i = modalOrder.length - 1; i >= 0; i--) {
            if (!modals.includes(modalOrder[i])) modalOrder.splice(i, 1);
        }
        for (const dialog of modals) if (!modalOrder.includes(dialog)) modalOrder.push(dialog);
        const focused = document.activeElement;
        const focusedModals = modals.filter(dialog => dialog.contains(focused));
        if (focusedModals.length) {
            return focusedModals.reduce((deepest, dialog) => deepest.contains(dialog) ? dialog : deepest);
        }
        return modalOrder.length ? modalOrder[modalOrder.length - 1] : null;
    }

    function promote() {
        if (typeof host.showPopover !== 'function') return;
        try {
            if (host.matches(':popover-open')) host.hidePopover();
            host.showPopover();
        } catch (_) {
            // Leave the host mounted; unsupported/blocked popover APIs cannot be forced.
        }
    }

    function withOwnedFocus(action, ownedRoot = host) {
        const focused = ownedRoot.contains(document.activeElement) ? document.activeElement : null;
        const start = focused && typeof focused.selectionStart === 'number' ? focused.selectionStart : null;
        const end = focused && typeof focused.selectionEnd === 'number' ? focused.selectionEnd : null;
        const direction = focused && focused.selectionDirection;
        action();
        if (!focused || !focused.isConnected || document.activeElement === focused) return;
        // Reparenting and popover toggling may blur an owned control to body. Never
        // override a different page control that acquired focus during the action.
        if (document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
        try { focused.focus({ preventScroll: true }); } catch (_) { try { focused.focus(); } catch (_) {} }
        if (start !== null && typeof focused.setSelectionRange === 'function') {
            try { focused.setSelectionRange(start, end, direction); } catch (_) {}
        }
    }

    function moveHost(parent) {
        if (!parent || host.parentElement === parent) return;
        parent.appendChild(host);
    }

    function collectRoots() {
        for (const node of document.querySelectorAll(ROOT_SELECTOR)) {
            if (node === host || host.contains(node)) continue;
            withOwnedFocus(() => host.appendChild(node), node);
        }
    }

    function sync() {
        scheduled = false;
        scheduledTimer = 0;
        const shouldPromote = forcePromotion;
        forcePromotion = false;
        if (!document.body.isConnected) return;
        if (!host.isConnected) document.body.appendChild(host);
        const fullscreen = document.fullscreenElement || null;
        const modal = activeModal();
        const parent = fullscreen ? (modal && fullscreen.contains(modal) ? modal : fullscreen) : (modal || document.body);
        withOwnedFocus(() => {
            moveHost(parent);
            if (fullscreen !== lastFullscreen || modal !== lastModal || host.parentElement !== parent || shouldPromote) promote();
        });
        if (fullscreen !== lastFullscreen || modal !== lastModal || host.parentElement !== parent) {
            lastFullscreen = fullscreen;
            lastModal = modal;
        }
        collectRoots();
        if (!host.matches(':popover-open')) withOwnedFocus(promote);
    }

    function schedule(force = false) {
        forcePromotion = forcePromotion || force === true;
        if (scheduled) return;
        scheduled = true;
        scheduledTimer = window.setTimeout(sync, 0);
    }

    promote();
    collectRoots();
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type !== 'attributes' || record.attributeName !== 'open' || record.target.localName !== 'dialog') continue;
            const dialog = record.target;
            const index = modalOrder.indexOf(dialog);
            if (!dialog.hasAttribute('open') || !isModal(dialog)) {
                if (index !== -1) modalOrder.splice(index, 1);
            } else {
                if (index !== -1) modalOrder.splice(index, 1);
                modalOrder.push(dialog);
            }
        }
        schedule();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'style', 'class'] });
    document.addEventListener('toggle', schedule, true);
    document.addEventListener('fullscreenchange', schedule, true);
    document.addEventListener('webkitfullscreenchange', schedule, true);
    window.addEventListener('pagehide', () => {
        observer.disconnect();
        window.clearTimeout(scheduledTimer);
        window.clearTimeout(externalTopLayerTimer);
        scheduled = false;
    }, { once: true });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'style', 'class'] });
        schedule();
    });
    // A later page popover/dialog enters above an earlier popover. Re-promote after its toggle.
    document.addEventListener('toggle', event => {
        if (event.target === host || !event.target || host.contains(event.target)) return;
        window.clearTimeout(externalTopLayerTimer);
        externalTopLayerTimer = window.setTimeout(() => {
            const modal = activeModal();
            if (modal || document.fullscreenElement) schedule(true);
            else withOwnedFocus(promote);
        }, 0);
    }, true);
    window.__memchatTopLayer = { host, refresh: schedule };
})();
configureExtensionPlatform(memchatPlatform);
initialize();
extensionStorageGate.ready = true; extensionStorageGate.finish();
} catch { extensionStorageGate.error = true; extensionStorageGate.ready = true; extensionStorageGate.finish(); extensionStorageError(); }
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiZXh0ZW5zaW9uL3N0b3JhZ2Utc2NoZW1hLmpzIiwiZXh0ZW5zaW9uL3BhbmVsLXRhYi1jb250ZW50LmpzIiwiZXh0ZW5zaW9uL3N0b3JhZ2UtY29udGVudC5qcyIsImV4dGVuc2lvbi9icmlkZ2UuanMiLCJzcmMvMDAtcGxhdGZvcm0uanMiLCJzcmMvMDEtY29uZmlnLWFuZC1zdGF0ZS5qcyIsInNyYy8wMi1zdG9yYWdlLWFuZC10cmFuc3BvcnQuanMiLCJzcmMvMDMtY2hhdC5qcyIsInNyYy8wNC1oYXRpa28uanMiLCJzcmMvMDUtY2FsY3VsYXRvci5qcyIsInNyYy8wNi1zY2hlZHVsZS5qcyIsInNyYy8wNy1zZXR0aW5ncy1wYW5lbHMuanMiLCJzcmMvMDgtZmllbGQtY2xlYXIuanMiLCJzcmMvMDgtY2xlYXItYW5kLWFjdGlvbnMuanMiLCJzcmMvMDktdWkuanMiLCJzcmMvMTAtZXZlbnRzLWFuZC1pbml0LmpzIiwic3JjLzExLWhhY2tlci5qcyIsInNyYy8xMi1tb3lza2xhZC11eC5qcyIsInNyYy8xMy1vcmRlci1ub3RpZmllci5qcyIsInNyYy8xNC1pbnRlcm5hbC1vcmRlci1jaGVjay5qcyIsImV4dGVuc2lvbi9ydW50aW1lLmpzIiwiZXh0ZW5zaW9uL29yZGVycy1ydW50aW1lLmpzIiwiZXh0ZW5zaW9uL2FwaS1kaWFnbm9zdGljcy5qcyIsImV4dGVuc2lvbi90b3AtbGF5ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBSdW5zIG9ubHkgaW4gdGhlIGlzb2xhdGVkIGV4dGVuc2lvbiB3b3JsZCBvZiBhbiBleGlzdGluZyB0b3AtbGV2ZWwgUGFuZWwgdGFiLlxuLy8gQ2FwdHVyZSBuYXRpdmUgZmV0Y2g6IHRoZSBidXNpbmVzcyB0cmFuc3BvcnQncyBsZXhpY2FsIGZldGNoIGlzIGEgd29ya2VyIHByb3h5LlxuY29uc3QgcGFuZWxUYWJOYXRpdmVGZXRjaCA9IGdsb2JhbFRoaXMuZmV0Y2guYmluZChnbG9iYWxUaGlzKTtcbmNvbnN0IHBhbmVsVGFiSW5zdGFuY2UgPSBnbG9iYWxUaGlzLmNyeXB0by5yYW5kb21VVUlEKCk7XG5jb25zdCBwYW5lbFRhYkNvbnRyb2xsZXJzID0gbmV3IE1hcCgpO1xuZnVuY3Rpb24gcGFuZWxUYWJSZWFkUmVxdWVzdChyZXF1ZXN0KSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXF1ZXN0Py51cmwpO1xuICAgICAgICBpZiAodXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5oYXNoIHx8IHVybC5zZWFyY2gpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gKG1ldGhvZCA9PT0gJ0dFVCcgJiYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2VhcmNoL2ZpbHRlcnMnIHx8IC9eXFwvYXBpXFwvYm9udXNlc1xcL2NoZWNrXFwvXFxkezEsMjB9JC8udGVzdCh1cmwucGF0aG5hbWUpKSlcbiAgICAgICAgICAgIHx8IChtZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaCcgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSA9PT0gJ3N0cmluZycgJiYgcmVxdWVzdC5kYXRhLmxlbmd0aCA8PSAzMjc2OCk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxUYWJGZXRjaCh1cmwsIG9wdGlvbnMsIHNpZ25hbCkge1xuICAgIHJldHVybiBwYW5lbFRhYk5hdGl2ZUZldGNoKHVybCwgeyAuLi5vcHRpb25zLCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLCBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdlcnJvcicsIHNpZ25hbCB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiU2Vzc2lvbihzaWduYWwpIHtcbiAgICBjb25zdCBodG1sID0gYXdhaXQgcGFuZWxUYWJGZXRjaCgnL3NlYXJjaCcsIHsgaGVhZGVyczogeyBBY2NlcHQ6ICd0ZXh0L2h0bWwnIH0gfSwgc2lnbmFsKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgaHRtbC50ZXh0KCk7XG4gICAgaWYgKCFodG1sLm9rIHx8IC88aW5wdXRcXGJbXj5dKlxcYnR5cGVcXHMqPVxccypbXCInXT9wYXNzd29yZFxcYi9pLnRlc3QoYm9keSkpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnYXV0aCcgfTtcbiAgICBjb25zdCBwYXJzZWQgPSBuZXcgRE9NUGFyc2VyKCkucGFyc2VGcm9tU3RyaW5nKGJvZHksICd0ZXh0L2h0bWwnKTtcbiAgICBjb25zdCB0b2tlbiA9IHBhcnNlZC5xdWVyeVNlbGVjdG9yKCdtZXRhW25hbWU9XCJjc3JmLXRva2VuXCJdJyk/LmNvbnRlbnQgfHwgJyc7XG4gICAgaWYgKCEvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QodG9rZW4pKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2F1dGgnIH07XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IHBhbmVsVGFiRmV0Y2goJy9hcGkvc2VhcmNoL2ZpbHRlcnMnLCB7IGhlYWRlcnM6IHsgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsICdYLVJlcXVlc3RlZC1XaXRoJzogJ1hNTEh0dHBSZXF1ZXN0JyB9IH0sIHNpZ25hbCk7XG4gICAgaWYgKCFhdXRoLm9rIHx8ICEvYXBwbGljYXRpb25cXC9qc29uL2kudGVzdChhdXRoLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJykpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnYXV0aCcgfTtcbiAgICBjb25zdCBwcm9vZiA9IGF3YWl0IGF1dGguanNvbigpO1xuICAgIGlmICghcHJvb2YgfHwgdHlwZW9mIHByb29mICE9PSAnb2JqZWN0JykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdhdXRoJyB9O1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbiwgaW5zdGFuY2U6IHBhbmVsVGFiSW5zdGFuY2UgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiUmVxdWVzdChyZXF1ZXN0LCBzaWduYWwpIHtcbiAgICBpZiAoIXBhbmVsVGFiUmVhZFJlcXVlc3QocmVxdWVzdCkpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnaW52YWxpZCcgfTtcbiAgICBjb25zdCBoZWFkZXJzID0geyBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJywgJ1gtUmVxdWVzdGVkLVdpdGgnOiAnWE1MSHR0cFJlcXVlc3QnIH07XG4gICAgY29uc3QgY3NyZiA9IG5ldyBIZWFkZXJzKHJlcXVlc3QuaGVhZGVycyB8fCB7fSkuZ2V0KCdYLUNTUkYtVE9LRU4nKTtcbiAgICBpZiAoY3NyZiAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QoY3NyZikpIGhlYWRlcnNbJ1gtQ1NSRi1UT0tFTiddID0gY3NyZjtcbiAgICBpZiAocmVxdWVzdC5tZXRob2QgPT09ICdQT1NUJykgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwYW5lbFRhYkZldGNoKHJlcXVlc3QudXJsLCB7IG1ldGhvZDogcmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcsIGhlYWRlcnMsIGJvZHk6IHJlcXVlc3QuZGF0YSB9LCBzaWduYWwpO1xuICAgIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICBjb25zdCBjb250ZW50VHlwZSA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJztcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgaW5zdGFuY2U6IHBhbmVsVGFiSW5zdGFuY2UsIHJlc3VsdDogeyBldmVudDogJ2xvYWQnLCByZXNwb25zZToge1xuICAgICAgICBzdGF0dXM6IHJlc3BvbnNlLm9rICYmICEvYXBwbGljYXRpb25cXC9qc29uL2kudGVzdChjb250ZW50VHlwZSkgPyA0MDEgOiByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsIHJlc3BvbnNlVGV4dCwgcmVzcG9uc2U6IHJlc3BvbnNlVGV4dCxcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiAnY29udGVudC10eXBlOiAnICsgY29udGVudFR5cGUsIGZpbmFsVXJsOiByZXF1ZXN0LnVybCwgcmVhZHlTdGF0ZTogNFxuICAgIH0gfSB9O1xufVxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHJlc3BvbmQpID0+IHtcbiAgICBpZiAobWVzc2FnZT8udHlwZSAhPT0gJ21lbWNoYXQ6cGFuZWwtdGFiJyB8fCBsb2NhdGlvbi5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgfHwgd2luZG93ICE9PSB3aW5kb3cudG9wXG4gICAgICAgIHx8IHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCAoc2VuZGVyLnVybCAmJiBzZW5kZXIudXJsICE9PSBjaHJvbWUucnVudGltZS5nZXRVUkwoJ3dvcmtlci5qcycpKVxuICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtekEtWjAtOS1dezEsODB9JC8udGVzdChtZXNzYWdlLmlkKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChtZXNzYWdlLm9wZXJhdGlvbiA9PT0gJ2NhbmNlbCcpIHsgcGFuZWxUYWJDb250cm9sbGVycy5nZXQobWVzc2FnZS5pZCk/LmFib3J0KCk7IHJlc3BvbmQoeyBvazogdHJ1ZSB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgaWYgKCFbJ3Nlc3Npb24nLCAncmVxdWVzdCddLmluY2x1ZGVzKG1lc3NhZ2Uub3BlcmF0aW9uKSB8fCAobWVzc2FnZS5vcGVyYXRpb24gPT09ICdyZXF1ZXN0JyAmJiBtZXNzYWdlLmluc3RhbmNlICE9PSBwYW5lbFRhYkluc3RhbmNlKSkge1xuICAgICAgICByZXNwb25kKHsgb2s6IGZhbHNlLCByZWFzb246ICdkb2N1bWVudCcgfSk7IHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBwYW5lbFRhYkNvbnRyb2xsZXJzLnNldChtZXNzYWdlLmlkLCBjb250cm9sbGVyKTtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCAxMjAwMCk7XG4gICAgY29uc3Qgd29yayA9IG1lc3NhZ2Uub3BlcmF0aW9uID09PSAnc2Vzc2lvbicgPyBwYW5lbFRhYlNlc3Npb24oY29udHJvbGxlci5zaWduYWwpIDogcGFuZWxUYWJSZXF1ZXN0KG1lc3NhZ2UucmVxdWVzdCwgY29udHJvbGxlci5zaWduYWwpO1xuICAgIHdvcmsudGhlbihyZXN1bHQgPT4gcmVzcG9uZChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkID8geyBvazogZmFsc2UsIHJlYXNvbjogJ25ldHdvcmsnIH0gOiByZXN1bHQpLFxuICAgICAgICAoKSA9PiByZXNwb25kKHsgb2s6IGZhbHNlLCByZWFzb246ICduZXR3b3JrJyB9KSkuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7IGlmIChwYW5lbFRhYkNvbnRyb2xsZXJzLmdldChtZXNzYWdlLmlkKSA9PT0gY29udHJvbGxlcikgcGFuZWxUYWJDb250cm9sbGVycy5kZWxldGUobWVzc2FnZS5pZCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG59KTtcbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwYWdlaGlkZScsICgpID0+IHsgZm9yIChjb25zdCBjb250cm9sbGVyIG9mIHBhbmVsVGFiQ29udHJvbGxlcnMudmFsdWVzKCkpIGNvbnRyb2xsZXIuYWJvcnQoKTsgfSk7XG4iLCIvLyBBIHN5bmNocm9ub3VzIFN0b3JhZ2Utc2hhcGVkIGNhY2hlIGZvciB0aGUgdW5jaGFuZ2VkIGNvcmUuIE9ubHkgdGhlIHdvcmtlclxuLy8gcGVyc2lzdHMgaXQ7IHdlYnNpdGVzIGNhbm5vdCByZWFkIGNocm9tZS5zdG9yYWdlIG9yIHJlY2VpdmUgU3RvcmFnZUV2ZW50cy5cbmNvbnN0IGV4dGVuc2lvblN0b3JhZ2VHYXRlID0geyByZWFkeTogZmFsc2UsIGVycm9yOiBmYWxzZSB9O1xuZXh0ZW5zaW9uU3RvcmFnZUdhdGUucHJvbWlzZSA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyBleHRlbnNpb25TdG9yYWdlR2F0ZS5maW5pc2ggPSByZXNvbHZlOyB9KTtcbmxldCBleHRlbnNpb25TdG9yYWdlT25FcnJvciA9ICgpID0+IHt9O1xubGV0IGV4dGVuc2lvblN0b3JhZ2VPbkNoYW5nZSA9ICgpID0+IHt9O1xubGV0IGV4dGVuc2lvblN0b3JhZ2VGYWlsZWQgPSBmYWxzZTtcbmNvbnN0IGV4dGVuc2lvblN0b3JhZ2VJdGVtcyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5mdW5jdGlvbiBleHRlbnNpb25TdG9yYWdlRXJyb3IoKSB7XG4gICAgZXh0ZW5zaW9uU3RvcmFnZUZhaWxlZCA9IHRydWU7XG4gICAgZXh0ZW5zaW9uU3RvcmFnZU9uRXJyb3IoKTtcbiAgICBpZiAodHlwZW9mIGRvY3VtZW50ID09PSAndW5kZWZpbmVkJyB8fCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdFN0b3JhZ2VFcnJvcicpKSByZXR1cm47XG4gICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyB3YXJuaW5nLmlkID0gJ21lbWNoYXRTdG9yYWdlRXJyb3InO1xuICAgIHdhcm5pbmcuc2V0QXR0cmlidXRlKCdyb2xlJywgJ2FsZXJ0Jyk7XG4gICAgd2FybmluZy50ZXh0Q29udGVudCA9ICdNZW1jaGF0OiDQtNCw0L3QvdGL0LUg0L3QtSDRgdC+0YXRgNCw0L3QtdC90Ysg0LjQu9C4INC40LfQvNC10L3QtdC90Ysg0LIg0LTRgNGD0LPQvtC5INCy0LrQu9Cw0LTQutC1LiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDQstC60LvQsNC00LrRgy4g0KXRgNCw0L3QuNC70LjRidC1INGB0LDQudGC0LAg0L3QtSDQuNGB0L/QvtC70YzQt9GD0LXRgtGB0Y8uJztcbiAgICB3YXJuaW5nLnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7dG9wOjRweDtsZWZ0OjhweDtyaWdodDo4cHg7ei1pbmRleDoyMTQ3NDgzNjQ3O3BhZGRpbmc6MTBweDtiYWNrZ3JvdW5kOiNmZmYxZjI7Y29sb3I6IzlmMTIzOTtib3JkZXI6MXB4IHNvbGlkICNmYjcxODU7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udDoxM3B4LzEuNCBzYW5zLXNlcmlmOyc7XG4gICAgZG9jdW1lbnQuYm9keT8uYXBwZW5kQ2hpbGQod2FybmluZyk7XG59XG5mdW5jdGlvbiBleHRlbnNpb25BcHBseVN0b3JhZ2VJdGVtKGtleSwgaXRlbSkge1xuICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkgfHwgIWl0ZW0gfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGl0ZW0ucmV2aXNpb24pXG4gICAgICAgIHx8IChpdGVtLnZhbHVlICE9PSBudWxsICYmIHR5cGVvZiBpdGVtLnZhbHVlICE9PSAnc3RyaW5nJykpIHJldHVybjtcbiAgICBpZiAoKGV4dGVuc2lvblN0b3JhZ2VJdGVtc1trZXldPy5yZXZpc2lvbiB8fCAwKSA+IGl0ZW0ucmV2aXNpb24pIHJldHVybjtcbiAgICBleHRlbnNpb25TdG9yYWdlSXRlbXNba2V5XSA9IGl0ZW07XG4gICAgZXh0ZW5zaW9uU3RvcmFnZU9uQ2hhbmdlKGtleSk7XG59XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlcikgPT4ge1xuICAgIGlmIChtZXNzYWdlPy50eXBlICE9PSAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnIHx8IHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYlxuICAgICAgICB8fCAoc2VuZGVyLnVybCAmJiBzZW5kZXIudXJsICE9PSBjaHJvbWUucnVudGltZS5nZXRVUkwoJ3dvcmtlci5qcycpKSkgcmV0dXJuIGZhbHNlO1xuICAgIGV4dGVuc2lvbkFwcGx5U3RvcmFnZUl0ZW0obWVzc2FnZS5rZXksIG1lc3NhZ2UuaXRlbSk7XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG5hc3luYyBmdW5jdGlvbiBleHRlbnNpb25Jbml0U3RvcmFnZSgpIHtcbiAgICBjb25zdCBwYWdlU3RvcmFnZSA9IHdpbmRvdy5sb2NhbFN0b3JhZ2U7XG4gICAgY29uc3QgbGVnYWN5ID0ge307XG4gICAgZm9yIChjb25zdCBrZXkgb2YgWy4uLk1FTUNIQVRfU1RPUkFHRV9LRVlTLCAuLi5NRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTXSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHBhZ2VTdG9yYWdlLmdldEl0ZW0oa2V5KTtcbiAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSBsZWdhY3lba2V5XSA9IHZhbHVlO1xuICAgIH1cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1pbml0JywgbGVnYWN5IH0sIHJlcGx5ID0+IHtcbiAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IgfHwgIXJlcGx5Py5vaykgcmVqZWN0KEVycm9yKCfQpdGA0LDQvdC40LvQuNGJ0LUg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C90L4nKSk7XG4gICAgICAgICAgICBlbHNlIHJlc29sdmUocmVwbHkpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGl0ZW1dIG9mIE9iamVjdC5lbnRyaWVzKHJlc3VsdC5pdGVtcykpIGV4dGVuc2lvbkFwcGx5U3RvcmFnZUl0ZW0oa2V5LCBpdGVtKTtcbiAgICAvLyBEbyBub3QgZGVsZXRlIGEgdmFsdWUgY29uY3VycmVudGx5IGNoYW5nZWQgYnkgYSBzdGlsbC1lbmFibGVkIHVzZXJzY3JpcHQuXG4gICAgZm9yIChjb25zdCBrZXkgb2YgcmVzdWx0LmNsZWFudXApIHtcbiAgICAgICAgaWYgKE9iamVjdC5oYXNPd24obGVnYWN5LCBrZXkpICYmIHBhZ2VTdG9yYWdlLmdldEl0ZW0oa2V5KSA9PT0gbGVnYWN5W2tleV0pIHBhZ2VTdG9yYWdlLnJlbW92ZUl0ZW0oa2V5KTtcbiAgICB9XG4gICAgZnVuY3Rpb24gY2hhbmdlKGtleSwgcmF3KSB7XG4gICAgICAgIGtleSA9IFN0cmluZyhrZXkpO1xuICAgICAgICBpZiAoTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgcmV0dXJuO1xuICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpIHx8IGV4dGVuc2lvblN0b3JhZ2VGYWlsZWQpIHRocm93IEVycm9yKCfQpdGA0LDQvdC40LvQuNGJ0LUgTWVtY2hhdCDQvdC10LTQvtGB0YLRg9C/0L3QvicpO1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHJhdyA9PT0gbnVsbCA/IG51bGwgOiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgU3RyaW5nKHJhdykpO1xuICAgICAgICBjb25zdCBwcmV2aW91cyA9IGV4dGVuc2lvblN0b3JhZ2VJdGVtc1trZXldIHx8IHsgdmFsdWU6IG51bGwsIHJldmlzaW9uOiAwIH07XG4gICAgICAgIGlmIChwcmV2aW91cy52YWx1ZSA9PT0gdmFsdWUpIHJldHVybjtcbiAgICAgICAgZXh0ZW5zaW9uU3RvcmFnZUl0ZW1zW2tleV0gPSB7IHZhbHVlLCByZXZpc2lvbjogcHJldmlvdXMucmV2aXNpb24gKyAxIH07XG4gICAgICAgIC8vIFNlbmQgaW1tZWRpYXRlbHksIG5vdCBmcm9tIGEgZGVib3VuY2VkIHBhZ2UgdGltZXIgdGhhdCBjYW4gZGllIG9uIHVubG9hZC5cbiAgICAgICAgdHJ5IHsgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJywga2V5LCB2YWx1ZSxcbiAgICAgICAgICAgIHJldmlzaW9uOiBwcmV2aW91cy5yZXZpc2lvbiwgcHJldmlvdXNWYWx1ZTogcHJldmlvdXMudmFsdWUgfSwgcmVwbHkgPT4ge1xuICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvciB8fCAhcmVwbHk/Lm9rKSB7IGV4dGVuc2lvblN0b3JhZ2VFcnJvcigpOyByZXR1cm47IH1cbiAgICAgICAgICAgIGV4dGVuc2lvbkFwcGx5U3RvcmFnZUl0ZW0oa2V5LCByZXBseS5pdGVtKTtcbiAgICAgICAgfSk7IH0gY2F0Y2ggeyBleHRlbnNpb25TdG9yYWdlRXJyb3IoKTsgfVxuICAgIH1cbiAgICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIGdldEl0ZW06IGtleSA9PiBleHRlbnNpb25TdG9yYWdlSXRlbXNbU3RyaW5nKGtleSldPy52YWx1ZSA/PyBudWxsLFxuICAgICAgICBzZXRJdGVtOiAoa2V5LCB2YWx1ZSkgPT4gY2hhbmdlKGtleSwgU3RyaW5nKHZhbHVlKSksXG4gICAgICAgIHJlbW92ZUl0ZW06IGtleSA9PiBjaGFuZ2Uoa2V5LCBudWxsKSxcbiAgICAgICAga2V5OiBpbmRleCA9PiBPYmplY3Qua2V5cyhleHRlbnNpb25TdG9yYWdlSXRlbXMpLmZpbHRlcihrZXkgPT4gZXh0ZW5zaW9uU3RvcmFnZUl0ZW1zW2tleV0udmFsdWUgIT09IG51bGwpW2luZGV4XSA/PyBudWxsLFxuICAgICAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gT2JqZWN0LnZhbHVlcyhleHRlbnNpb25TdG9yYWdlSXRlbXMpLmZpbHRlcihpdGVtID0+IGl0ZW0udmFsdWUgIT09IG51bGwpLmxlbmd0aDsgfVxuICAgIH0pO1xufVxuIiwiLy8gVGhpcyBmaWxlIGFuZCB0aGUgcHJvZHVjdGlvbiB1c2Vyc2NyaXB0IHNoYXJlIG9uZSBpc29sYXRlZC13b3JsZCBJSUZFLlxubGV0IGV4dGVuc2lvblJlcXVlc3RTZXF1ZW5jZSA9IDA7XG5jb25zdCBleHRlbnNpb25SZXF1ZXN0R3VhcmRzID0gbmV3IE1hcCgpO1xuXG5mdW5jdGlvbiBHTV94bWxodHRwUmVxdWVzdChvcHRpb25zKSB7XG4gICAgY29uc3QgaWQgPSBgcmVxLSR7RGF0ZS5ub3coKX0tJHsrK2V4dGVuc2lvblJlcXVlc3RTZXF1ZW5jZX1gO1xuICAgIGxldCBmaW5pc2hlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGZpbmlzaCA9IHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChmaW5pc2hlZCkgcmV0dXJuO1xuICAgICAgICBmaW5pc2hlZCA9IHRydWU7XG4gICAgICAgIGV4dGVuc2lvblJlcXVlc3RHdWFyZHMuZGVsZXRlKGlkKTtcbiAgICAgICAgaWYgKHJlc3VsdD8ucGFuZWxBdXRoTG9zdCAmJiB0eXBlb2YgZXh0ZW5zaW9uUGFuZWxBdXRoTG9zdCA9PT0gJ2Z1bmN0aW9uJykgZXh0ZW5zaW9uUGFuZWxBdXRoTG9zdCgpO1xuICAgICAgICBjb25zdCBjYWxsYmFjayA9IHsgbG9hZDogJ29ubG9hZCcsIHRpbWVvdXQ6ICdvbnRpbWVvdXQnLCBhYm9ydDogJ29uYWJvcnQnLCBlcnJvcjogJ29uZXJyb3InIH1bcmVzdWx0Py5ldmVudF0gfHwgJ29uZXJyb3InO1xuICAgICAgICBvcHRpb25zW2NhbGxiYWNrXT8uKHJlc3VsdD8ucmVzcG9uc2UgfHwgeyBzdGF0dXM6IDAsIHN0YXR1c1RleHQ6IHJlc3VsdD8uZXJyb3IgfHwgJ9Ce0YjQuNCx0LrQsCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9KTtcbiAgICB9O1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7fTtcbiAgICBpZiAodHlwZW9mIG9wdGlvbnMubWVtY2hhdElzQ3VycmVudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBleHRlbnNpb25SZXF1ZXN0R3VhcmRzLnNldChpZCwgb3B0aW9ucy5tZW1jaGF0SXNDdXJyZW50KTtcbiAgICAgICAgcmVxdWVzdC5jcmVkZW50aWFsR3VhcmQgPSB0cnVlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ21ldGhvZCcsICd1cmwnLCAnaGVhZGVycycsICdkYXRhJywgJ3RpbWVvdXQnLCAnYW5vbnltb3VzJywgJ3Jlc3BvbnNlVHlwZSddKSB7XG4gICAgICAgIGlmIChvcHRpb25zW2tleV0gIT09IHVuZGVmaW5lZCkgcmVxdWVzdFtrZXldID0gb3B0aW9uc1trZXldO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdtZW1jaGF0Omh0dHAnLCBpZCwgcmVxdWVzdCB9LCByZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikgZmluaXNoKHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAn0KDQsNGB0YjQuNGA0LXQvdC40LUg0L7QsdC90L7QstC70LXQvdC+INC40LvQuCDQvdC10LTQvtGB0YLRg9C/0L3Qvi4g0J/QtdGA0LXQt9Cw0LPRgNGD0LfQuNGC0LUg0LLQutC70LDQtNC60YMuJyB9KTtcbiAgICAgICAgICAgIGVsc2UgZmluaXNoKHJlc3VsdCk7XG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggeyBmaW5pc2goeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQoNCw0YHRiNC40YDQtdC90LjQtSDQvdC10LTQvtGB0YLRg9C/0L3Qvi4g0J/QtdGA0LXQt9Cw0LPRgNGD0LfQuNGC0LUg0LLQutC70LDQtNC60YMuJyB9KTsgfVxuICAgIHJldHVybiB7IGFib3J0KCkge1xuICAgICAgICBpZiAoZmluaXNoZWQpIHJldHVybjtcbiAgICAgICAgLy8gU2V0dGxlIGxvY2FsbHkgZXZlbiB3aGVuIGFib3J0IHJhY2VzIHRoZSB3b3JrZXIncyBpbml0aWFsIHZhbGlkYXRpb24uXG4gICAgICAgIGZpbmlzaCh7IGV2ZW50OiAnYWJvcnQnIH0pO1xuICAgICAgICB0cnkgeyBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdtZW1jaGF0OmFib3J0JywgaWQgfSwgKCkgPT4geyB2b2lkIGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcjsgfSk7IH0gY2F0Y2ggeyAvKiBjb250ZXh0IGludmFsaWRhdGVkICovIH1cbiAgICB9IH07XG59XG5cbi8vIEF2b2lkIG5lc3RlZCByZXRyeSBsb29wczogdGhlIE1WMyB3b3JrZXIgb3ducyBwcm9maWxlLXdpZGUgR0VUIHJldHJpZXMuXG5HTV94bWxodHRwUmVxdWVzdC5tZW1jaGF0TXNTY2hlZHVsZXIgPSB0cnVlO1xuXG4vLyBVc2Vyc2NyaXB0IG1lbnUgcmVnaXN0cmF0aW9ucyBhcmUgaW50ZW50aW9uYWxseSBub3QgZXhwb3NlZCBieSB0aGUgZXh0ZW5zaW9uLlxuLy8gVG9vbGJhciB0b2dnbGUgYW5kIHRoZSBzaW5nbGUgYWN0aW9uLWNvbnRleHQgbWVudSByZXBsYWNlIHRoZW07IG5vIGRlYnVnIGl0ZW0uXG5mdW5jdGlvbiBHTV9yZWdpc3Rlck1lbnVDb21tYW5kKCkgeyByZXR1cm4gbnVsbDsgfVxuXG4vLyBPbmx5IHRoZSBzY2hlZHVsZSBtb2R1bGUgdXNlcyBmZXRjaC4gUm91dGUgaXQgdGhyb3VnaCB0aGUgc2FtZSBwcml2aWxlZ2VkXG4vLyB0cmFuc3BvcnQgcmF0aGVyIHRoYW4gcmVseWluZyBvbiBwYWdlLW9yaWdpbiBDT1JTIHBlcm1pc3Npb25zLlxuZnVuY3Rpb24gZmV0Y2godXJsLCBvcHRpb25zID0ge30pIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBHTV94bWxodHRwUmVxdWVzdCh7IHVybDogU3RyaW5nKHVybCksIG1ldGhvZDogb3B0aW9ucy5tZXRob2QgfHwgJ0dFVCcsIGhlYWRlcnM6IG9wdGlvbnMuaGVhZGVycyxcbiAgICAgICAgICAgIGRhdGE6IG9wdGlvbnMuYm9keSwgYW5vbnltb3VzOiBvcHRpb25zLmNyZWRlbnRpYWxzID09PSAnb21pdCcsXG4gICAgICAgICAgICBvbmxvYWQ6IHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBoZWFkZXJzID0gbmV3IEhlYWRlcnMoKTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIChyZXNwb25zZS5yZXNwb25zZUhlYWRlcnMgfHwgJycpLnNwbGl0KC9cXHI/XFxuLykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKCc6Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29sb24gPiAwKSBoZWFkZXJzLmFwcGVuZChsaW5lLnNsaWNlKDAsIGNvbG9uKSwgbGluZS5zbGljZShjb2xvbiArIDEpLnRyaW0oKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmVzb2x2ZShuZXcgUmVzcG9uc2UoWzIwNCwgMjA1LCAzMDRdLmluY2x1ZGVzKHJlc3BvbnNlLnN0YXR1cykgPyBudWxsIDogcmVzcG9uc2UucmVzcG9uc2VUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCwgaGVhZGVycyB9KSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7IHJlamVjdChuZXcgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQvtGC0LLQtdGCINGA0LDRgdGI0LjRgNC10L3QuNGPIE1lbWNoYXQnKSk7IH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBvbmVycm9yOiAoKSA9PiByZWplY3QobmV3IEVycm9yKCfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcpKSxcbiAgICAgICAgICAgIG9udGltZW91dDogKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign0KLQsNC50LzQsNGD0YIg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcpKSxcbiAgICAgICAgICAgIG9uYWJvcnQ6ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScpKVxuICAgICAgICB9KTtcbiAgICB9KTtcbn1cblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWJcbiAgICAgICAgfHwgKHNlbmRlci51cmwgJiYgc2VuZGVyLnVybCAhPT0gY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCd3b3JrZXIuanMnKSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50Jykge1xuICAgICAgICBsZXQgY3VycmVudCA9IGZhbHNlO1xuICAgICAgICB0cnkgeyBjdXJyZW50ID0gZXh0ZW5zaW9uUmVxdWVzdEd1YXJkcy5nZXQobWVzc2FnZS5pZCk/LigpID09PSB0cnVlOyB9IGNhdGNoIHsgLyogZmFpbCBjbG9zZWQgKi8gfVxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBjdXJyZW50IH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmICghWydtZW1jaGF0OnRvZ2dsZScsICdtZW1jaGF0OnJlc2V0LXBvc2l0aW9uJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBjb250cm9sID0gKCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGV4dGVuc2lvblN0b3JhZ2VHYXRlICE9PSAndW5kZWZpbmVkJyAmJiBleHRlbnNpb25TdG9yYWdlR2F0ZS5lcnJvcikgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ3N0b3JhZ2UnIH0pOyByZXR1cm47IH1cbiAgICAgICAgY29uc3QgY29uZmxpY3QgPSBCb29sZWFuKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrQ29udGFpbmVyJykgJiYgIXdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyKTtcbiAgICAgICAgaWYgKGNvbmZsaWN0KSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgcmVhc29uOiAnY29uZmxpY3QnIH0pOyByZXR1cm47IH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnRvZ2dsZScpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtYWluID0gd2luZG93LnByaWNlQ2hlY2tDb250YWluZXI7XG4gICAgICAgICAgICAgICAgaWYgKCFtYWluKSBjcmVhdGVQcmljZUNoZWNrV2luZG93KCk7XG4gICAgICAgICAgICAgICAgZWxzZSBtYWluLnN0eWxlLmRpc3BsYXkgPSBnZXRDb21wdXRlZFN0eWxlKG1haW4pLmRpc3BsYXkgPT09ICdub25lJyA/ICdmbGV4JyA6ICdub25lJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmVzZXRGbG9hdFdpbmRvd1BvcygpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1haW4gPSB3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lcjtcbiAgICAgICAgICAgICAgICBpZiAobWFpbikgT2JqZWN0LmFzc2lnbihtYWluLnN0eWxlLCB7IGxlZnQ6ICdhdXRvJywgdG9wOiAnMTRweCcsIHJpZ2h0OiAnMTRweCcsIGJvdHRvbTogJ2F1dG8nIH0pO1xuICAgICAgICAgICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tYy1mbG9hdC13aW5kb3cnKS5mb3JFYWNoKGVsZW1lbnQgPT4ge1xuICAgICAgICAgICAgICAgICAgICBbJ2xlZnQnLCAndG9wJywgJ3JpZ2h0JywgJ2JvdHRvbSddLmZvckVhY2goa2V5ID0+IGVsZW1lbnQuc3R5bGUucmVtb3ZlUHJvcGVydHkoa2V5KSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ2ZhaWxlZCcgfSk7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGlmICh0eXBlb2YgZXh0ZW5zaW9uU3RvcmFnZUdhdGUgIT09ICd1bmRlZmluZWQnICYmICFleHRlbnNpb25TdG9yYWdlR2F0ZS5yZWFkeSkge1xuICAgICAgICBleHRlbnNpb25TdG9yYWdlR2F0ZS5wcm9taXNlLnRoZW4oY29udHJvbCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb250cm9sKCk7XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG4iLCIvLyBQbGF0Zm9ybSBjYXBhYmlsaXRpZXMgYXJlIGNvbmZpZ3VyZWQgQkVGT1JFIGluaXRpYWxpemUoKSwgbmV2ZXIgcGF0Y2hlZCBhZnRlcndhcmQuXG4vLyBTdGFuZGFsb25lL0RFViBoYXZlIG5vIGV4dGVuc2lvbiBjYXBhYmlsaXRpZXM7IGxlZ2FjeSBiZWhhdmlvciByZW1haW5zIGxvY2FsLlxuY29uc3QgbWVtY2hhdFBsYXRmb3JtID0geyBwYW5lbDogbnVsbCwgZGlyZWN0TXM6IGZhbHNlIH07XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IE1FTUNIQVRfVkVSU0lPTiA9ICc4LjkuMC1hbHBoYS4xJztcblxuLy8g0KDQtdC20LjQvNC90YvQtSDQstC60LvQsNC00LrQuDogRW50ZXIg0LIg0L/QvtC70LUg0LLQstC+0LTQsCDQstGL0L/QvtC70L3Rj9C10YIg0LTQtdC50YHRgtCy0LjQtS4g0JLQutC70LDQtNC60Lgt0LTQtdC50YHRgtCy0LjRj1xuLy8gKHRvZGF5L3RvbW9ycm93L2hhY2tlcikg0LggwqvQndCw0YHRgtGA0L7QudC60LjCuyDQvtGC0LrRgNGL0LLQsNGO0YIg0L7QutC90L4v0LrQvtC90YLQtdC90YIg0L/QviDQutC70LjQutGDLlxuY29uc3QgTU9ERV9BQ1RJT05TID0gW1xuICAgICdjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLFxuICAgICdjYWxjdWxhdG9yJywgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJ1xuXTtcblxuLy8g4pSA4pSA4pSAINCa0L7QvdGB0YLQsNC90YLRiyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNvbnN0IEJBU0VfVVJMUyA9IFtcbiAgICBcImh0dHBzOi8vaGF0aWtvLnJ1XCIsXG4gICAgXCJodHRwczovL3Zvcm9uZXpoLmhhdGlrby5ydVwiLFxuICAgIFwiaHR0cHM6Ly9saXBldHNrLmhhdGlrby5ydVwiLFxuICAgIFwiaHR0cHM6Ly9iYWxha292by5oYXRpa28ucnVcIlxuXTtcbmNvbnN0IENJVFlfSUNPTlMgPSBbJ/CfhoInLCAn8J+GhScsICfwn4W7JywgJ/Cfl78nXTtcbmNvbnN0IENJVFlfTkFNRVMgPSBbJ9Ch0LDRgNCw0YLQvtCyJywgJ9CS0L7RgNC+0L3QtdC2JywgJ9Cb0LjQv9C10YbQuicsICfQkdCw0LvQsNC60L7QstC+J107XG5cbi8vIOKUgOKUgOKUgCDQn9GA0LDQstC40LvQsCDQutCw0LvRjNC60YPQu9GP0YLQvtGA0LAg0L/QviDRg9C80L7Qu9GH0LDQvdC40Y4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5jb25zdCBERUZBVUxUX0NBTENfUlVMRVMgPSBbXG4gICAgeyBuYW1lOiBcItCd0LDQu9C40YfQvdGL0LzQuFwiLCAgICAgIHBlcmNlbnQ6IDEwMCwgICByb3VuZDogMSwgICBleHRyYTogMCAgIH0sXG4gICAgeyBuYW1lOiBcIlFSXCIsICAgICAgICAgICAgIHBlcmNlbnQ6IDEwMS41LCByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCa0LDRgNGC0L7QuVwiLCAgICAgICAgIHBlcmNlbnQ6IDEwMiwgICByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCg0LDRgdGB0YDQvtGH0LrQsCA20LxcIiwgICBwZXJjZW50OiAxMDcsICAgcm91bmQ6IDEwMCwgZXh0cmE6IC0xMCB9LFxuICAgIHsgbmFtZTogXCLQoNCw0YHRgdGA0L7Rh9C60LAgMTDQvFwiLCAgcGVyY2VudDogMTA5LCAgIHJvdW5kOiAxMDAsIGV4dHJhOiAtMTAgfSxcbiAgICB7IG5hbWU6IFwi0KDQsNGB0YHRgNC+0YfQutCwIDEy0LxcIiwgIHBlcmNlbnQ6IDExMCwgICByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCg0LDRgdGB0YDQvtGH0LrQsCAxONC8XCIsICBwZXJjZW50OiAxMTMsICAgcm91bmQ6IDEwMCwgZXh0cmE6IC0xMCB9LFxuICAgIHsgbmFtZTogXCLQoNCw0YHRgdGA0L7Rh9C60LAgMjTQvFwiLCAgcGVyY2VudDogMTE2LCAgIHJvdW5kOiAxMDAsIGV4dHJhOiAtMTAgfSxcbiAgICB7IG5hbWU6IFwi0KDQsNGB0YHRgNC+0YfQutCwIDM20LxcIiwgIHBlcmNlbnQ6IDEyMCwgICByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCa0Y3RiNCx0Y3QuiAxJVwiLCAgICAgIHBlcmNlbnQ6IDEsICAgICByb3VuZDogMSwgICBleHRyYTogMCwgIGlzQ2FzaGJhY2s6IHRydWUgfVxuXTtcblxuLy8g4pSA4pSA4pSAINCX0LDQvNC10L3RiyDRgNCw0YHQv9C40YHQsNC90LjRjyDQv9C+INGD0LzQvtC70YfQsNC90LjRjiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNvbnN0IERFRkFVTFRfUkVQTEFDRU1FTlRTID0ge1xuICAgIFwi0KNcIjogICAgIFwi8J+YjiDQutCw0Log0KPQv9GA0LDQstC70Y/RjtGJ0LjQuVwiLFxuICAgIFwi0JxcIjogICAgIFwi8J+ZgiDQutCw0Log0JzQtdC90LXQtNC20LXRgFwiLFxuICAgIFwiTVwiOiAgICAgXCLwn5mCINC60LDQuiDQnNC10L3QtdC00LbQtdGAXCIsXG4gICAgXCLQoNCRXCI6ICAgIFwi8J+PqiDQsiDQotCmINCg0YPQsdC40L1cIixcbiAgICBcItCgXCI6ICAgICBcIvCfj6og0L3QsCDQoNCw0YXQvtCy0LBcIixcbiAgICBcItCaXCI6ICAgICBcIvCfj6og0L3QsCDQmtCw0LfQsNGH0YzQtdC5XCIsXG4gICAgXCLQp1wiOiAgICAgXCLwn4+qINC90LAg0KfQtdGA0L3Ri9GI0LXQstGB0LrQvtCz0L5cIixcbiAgICBcIkNcIjogICAgIFwi8J+PqiDQsiDQotCmINCh0LjRgtC40JzQvtC70LtcIixcbiAgICBcItChXCI6ICAgICBcIvCfj6og0LIg0KLQpiDQodC40YLQuNCc0L7Qu9C7XCIsXG4gICAgXCLQmFwiOiAgICAgXCLwn5ixINC60LDQuiBTTU1cIixcbiAgICBcIjFcIjogICAgIFwi8J+nkeKAjfCfkrwg0KDQsNCx0L7RgtCw0LXRglwiLFxuICAgIFwi0JBcIjogICAgIFwi8J+RgCDQqNCw0YLQsNC10YIg0JDQstC40YLQvlwiLFxuICAgIFwiMTE0XCI6ICAgXCLwn5ug77iPINC90LAg0KfQtdGA0L3Ri9GI0LXQstGB0LrQvtCz0L4g8J+TnjExNFwiLFxuICAgIFwiMTExXCI6ICAgXCLwn5ug77iPINCyINCi0KYg0KDRg9Cx0LjQvSDwn5OeMTExXCIsXG4gICAgXCIxMDRcIjogICBcIvCfm6DvuI8g0L3QsCDQmtCw0LfQsNGH0YzQtdC5IPCfk54xMDRcIixcbiAgICBcIjEwN1wiOiAgIFwi8J+boO+4jyDQvdCwINCa0LDQt9Cw0YfRjNC10LksINCh0YLQsNGA0YjQuNC5KC3QsNGPKSDwn5OeMTA3XCIsXG4gICAgXCLQmi0xMDBcIjogXCLwn4+qINC90LAg0JrQsNC30LDRh9GM0LXQuSDwn5OeMTAwXCIsXG4gICAgXCLQmi0xMDFcIjogXCLwn4+qINC90LAg0JrQsNC30LDRh9GM0LXQuSDwn5OeMTAxXCIsXG4gICAgXCLQoC0xMTZcIjogXCLwn4+qINC90LAg0KDQsNGF0L7QstCwIPCfk54xMTZcIixcbiAgICBcItCgLTExN1wiOiBcIvCfj6og0L3QsCDQoNCw0YXQvtCy0LAg8J+TnjExN1wiLFxuICAgIFwi0KDQkS0xMTFcIjpcIvCfj6og0LIg0KLQpiDQoNGD0LHQuNC9IPCfk54xMTdcIixcbiAgICBcItCnLTExNFwiOiBcIvCfj6og0J3QsCDQp9C10YDQvdGL0YjQtdCy0YHQutC+0LPQviDwn5OeMTE0XCIsXG4gICAgXCLQoTEzMFwiOiAgXCLwn4+qINCyINCi0KYg0KHQuNGC0LjQnNC+0LvQuyDwn5OeMTMxXCIsXG4gICAgXCLQoTEzMVwiOiAgXCLwn4+qINCyINCi0KYg0KHQuNGC0LjQnNC+0LvQuyDwn5OeMTMxXCIsXG4gICAgXCLQoTEzMlwiOiAgXCLwn4+qINCyINCi0KYg0KHQuNGC0LjQnNC+0LvQuyDwn5OeMTMyXCIsXG4gICAgXCIzMDBcIjogICBcIvCfj6og0J3QuNC60LjRgtC40L3RgdC60LDRjyA0NCDwn5OeMzAwXCIsXG4gICAgXCIzMTBcIjogICBcIuKbtSDQk9Cw0LvQtdGA0LXRjyDQp9C40LbQvtCy0LAg8J+TnjMxMFwiLFxuICAgIFwiMzExXCI6ICAgXCLim7Ug0JPQsNC70LXRgNC10Y8g0KfQuNC20L7QstCwIPCfk54zMTFcIlxufTtcblxuLy8g4pSA4pSA4pSAINCh0L7RgdGC0L7Rj9C90LjQtSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmxldCBpc0RyYWdnaW5nICAgID0gZmFsc2U7XG5sZXQgb2Zmc2V0ICAgICAgICA9IHsgeDogMCwgeTogMCB9O1xubGV0IGN1cnJlbnRBY3Rpb24gPSBudWxsO1xuLy8g0JjRgdGC0L7RgNC40Y8g0YfQsNGC0LA6INC/0L4g0LzQsNGB0YHQuNCy0YMg0L3QsCDQstC60LvQsNC00LrRgyAoc3dpdGNoLWtleSksINC20LjQstGR0YIg0YLQvtC70YzQutC+INCyINC/0LDQvNGP0YLQuCDRgdC10YHRgdC40LguXG4vLyDQktC60LvQsNC00LrRgyDCq9CR0L7QvdGD0YHRi8K7INC90LDQvNC10YDQtdC90L3QviDQvdC1INC/0LXRgNGB0LjRgdGC0LjQvCDigJQg0YLQsNC8INC90L7QvNC10YDQsCDRgtC10LvQtdGE0L7QvdC+0LIg0LrQu9C40LXQvdGC0L7QsiAo0J/QlNC9KS5cbmxldCBjaGF0SGlzdG9yeUJ5QWN0aW9uID0ge307XG5sZXQgY2xlYXJUZXh0RW5hYmxlZCA9IGZhbHNlO1xubGV0IGNsZWFyVGV4dERlbGF5ID0gNTAwO1xubGV0IGdsb2JhbENsZWFyS2V5cHJlc3NCb3VuZCA9IGZhbHNlO1xubGV0IGNhbGNSdWxlcyAgICAgPSBbXTtcbmxldCBzY2hlZHVsZVJlcGxhY2VtZW50cyA9IHt9O1xuY29uc3QgU0NIRURVTEVfQ0FDSEVfVFRMX01TID0gMTIgKiA2MCAqIDYwICogMTAwMDtcbmxldCBzY2hlZHVsZUNhY2hlRW5hYmxlZCA9IHRydWU7XG5sZXQgc2NoZWR1bGVTdGF0ZUJ5RGF5ID0ge1xuICAgIHRvZGF5OiB7IGxvYWRpbmc6IGZhbHNlLCBwYXJzZWQ6IG51bGwsIHRleHRDb3B5OiAnJywgZXJyb3I6ICcnLCB1cGRhdGVkQXQ6IDAgfSxcbiAgICB0b21vcnJvdzogeyBsb2FkaW5nOiBmYWxzZSwgcGFyc2VkOiBudWxsLCB0ZXh0Q29weTogJycsIGVycm9yOiAnJywgdXBkYXRlZEF0OiAwIH1cbn07XG5sZXQgY3VycmVudEhhdGlrb1BhdGhuYW1lID0gJyc7XG5sZXQgbGFzdEhhdGlrb1Jlc3VsdHMgPSBbXTtcbmxldCBsYXN0SGF0aWtvUXVlcnkgPSAnJztcbmxldCBoYXRpa29TZWFyY2hNb2RlID0gJ2F1dG8nO1xubGV0IGFjdGl2ZVJlcXVlc3RJZCA9IDA7XG4vLyDQn9C+0LLQtdC00LXQvdC40LUg0LrQvdC+0L/QutC4IPCflIE6IGFwcGVuZCDigJQg0YHQvtGF0YDQsNC90LjRgtGMINGB0YLQsNGA0YvQuSDQvtGC0LLQtdGCLCByZXBsYWNlIOKAlCDQt9Cw0LzQtdC90LjRgtGMINC10LPQvi5cbmxldCByZXRyeUJlaGF2aW9yID0gJ2FwcGVuZCc7XG5cbi8vIEFQSSDQnNC+0LnQodC60LvQsNC0INC00LvRjyDQpdCw0YLQuNC60L7QpdCw0LrQtdGA0LBcbmxldCBoYWNrZXJCZWFyZXJFbmFibGVkID0gZmFsc2U7XG5sZXQgaGFja2VyQmVhcmVyVG9rZW4gPSAnJztcbmxldCBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbmxldCBoYWNrZXJEZWZhdWx0Q2hhbm5lbCA9ICcnO1xubGV0IGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQgPSB0cnVlO1xuY29uc3QgSEFDS0VSX05PVElGSUVSX0FVRElPX1VSTCA9ICdodHRwczovL3d3dy5teWluc3RhbnRzLmNvbS9tZWRpYS9zb3VuZHMvZm5hZi1hbmltYXRyb25pYy1hdC1kb29yLm1wMyc7XG5jb25zdCBIQUNLRVJfTk9USUZJRVJfREVGQVVMVF9JTlRFUlZBTF9NSU5VVEVTID0gNTtcbmxldCBoYWNrZXJOb3RpZmllclNldHRpbmdzID0ge1xuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgc291bmRFbmFibGVkOiB0cnVlLFxuICAgIGludGVydmFsTWludXRlczogSEFDS0VSX05PVElGSUVSX0RFRkFVTFRfSU5URVJWQUxfTUlOVVRFUyxcbiAgICB0b2FzdER1cmF0aW9uTWludXRlczogNSxcbiAgICBvcmdhbml6YXRpb25IcmVmczogW10sXG4gICAgc3RhdHVzSHJlZnM6IFtdXG59O1xubGV0IGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucyA9IFtdO1xubGV0IGhhY2tlck5vdGlmaWVyU2VlbkJ5T3JnYW5pemF0aW9uID0ge307XG5sZXQgaGFja2VyTm90aWZpZXJTdGF0dXNTZWxlY3Rpb25Jbml0aWFsaXplZCA9IGZhbHNlO1xubGV0IGhhY2tlck5vdGlmaWVyVGltZXIgPSBudWxsO1xubGV0IGhhY2tlck5vdGlmaWVySW5GbGlnaHQgPSBmYWxzZTtcbmxldCBoYWNrZXJOb3RpZmllckF1ZGlvID0gbnVsbDtcbi8vINCt0LrRgdC/0LXRgNC40LzQtdC90YLQsNC70YzQvdGL0LUgQVBJLdC60L3QvtC/0LrQuCDRgdC+0LfQtNCw0L3QuNGPINC00L7QutGD0LzQtdC90YLQvtCyINCy0YDQtdC80LXQvdC90L4g0YHQutGA0YvRgtGLLlxuLy8g0KDQsNCx0L7Rh9Cw0Y8g0L/QsNC90LXQu9GMLCDQvdCw0LbQuNC80LDRjtGJ0LDRjyDRiNGC0LDRgtC90YvQtSDQv9GD0L3QutGC0Ysg0LzQtdC90Y4g0JzQvtC50KHQutC70LDQtCwg0L7RgdGC0LDRkdGC0YHRjyDQstC60LvRjtGH0ZHQvdC90L7QuS5cbmNvbnN0IEhBQ0tFUl9RVUlDS19BUElfUk9XX0VOQUJMRUQgPSBmYWxzZTtcblxuLy8g8J+qhCDQn9GA0LDQstC40LvQsCDQt9Cw0L/QvtC70L3QtdC90LjRjyDRiNGC0LDRgtC90YvRhSDQutCw0YDRgtC+0YfQtdC6INC00L7QutGD0LzQtdC90YLQvtCyINCc0L7QudCh0LrQu9Cw0LQuINCf0YPRgdGC0YvQtSDQvtCx0Y/Qt9Cw0YLQtdC70YzQvdGL0LVcbi8vINC30L3QsNGH0LXQvdC40Y8g0L/QvtC70YzQt9C+0LLQsNGC0LXQu9GMINCy0YvQsdC40YDQsNC10YIg0LIg0L7QutC90LUg0L/QsNC70L7Rh9C60Lgg0L/QtdGA0LXQtCDRgdC+0YXRgNCw0L3QtdC90LjQtdC8INC00L7QutGD0LzQtdC90YLQsC5cbmNvbnN0IERFRkFVTFRfTVNfTUFHSUNfQ09ORklHID0ge1xuICAgIGRlbWFuZDoge1xuICAgICAgICBjb3BpZXM6IFt7IGZpZWxkOiAn0JrQsNC90LDQuyDQv9GA0L7QtNCw0LYnLCBmcm9tOiAwLCB0bzogWzFdLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICAgICAgdmFsdWVzOiBbXVxuICAgIH0sXG4gICAgY2FzaGluOiB7XG4gICAgICAgIGNvcGllczogW10sXG4gICAgICAgIHZhbHVlczogW1xuICAgICAgICAgICAgeyBmaWVsZDogJ9Ci0LjQvyDQvtC/0LvQsNGC0YsnLCB2YWx1ZTogJ9Cd0LDQu9C40YfQvdGL0LzQuCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgICAgICB7IGZpZWxkOiAn0KHRgtCw0YLRg9GBINC60LvQuNC10L3RgtCwJywgdmFsdWU6ICcnLCByZXF1aXJlZDogdHJ1ZSB9XG4gICAgICAgIF1cbiAgICB9LFxuICAgIHBheW1lbnRpbjoge1xuICAgICAgICBjb3BpZXM6IFtdLFxuICAgICAgICB2YWx1ZXM6IFt7IGZpZWxkOiAn0KHQv9C+0YHQvtCxINC+0L/Qu9Cw0YLRiycsIHZhbHVlOiAnJywgcmVxdWlyZWQ6IHRydWUgfV1cbiAgICB9XG59O1xubGV0IG1zTWFnaWNDb25maWcgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfTVNfTUFHSUNfQ09ORklHKSk7XG5cbi8vIOKUgOKUgOKUgCDQodC60YDRi9GC0LjQtSDQv9C+0LvQtdC5INCc0L7QudCh0LrQu9Cw0LQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5sZXQgaGlkZGVuRmllbGRzID0gW107ICAgICAgICAvLyDQuNC80LXQvdCwINC/0L7Qu9C10LkgKNGC0L7Rh9C90YvQuSDRgtC10LrRgdGCINC70LXQudCx0LvQsCksINC/0YDRj9GH0LXQvNGL0YUg0L3QsCDQnNC+0LnQodC60LvQsNC0XG5sZXQgbXNGaWVsZHNSZXZlYWxlZCA9IGZhbHNlOyAvLyDCq9GA0LDRgdC60YDRi9GC0Ywg0LLRgdGRwrsg0YEg0L/Qu9Cw0LLQsNGO0YnQtdC5INC60L3QvtC/0LrQuCDwn5GBICjQstGA0LXQvNC10L3QvdC+KVxubGV0IG1zRmllbGRPYnNlcnZlciA9IG51bGw7XG5sZXQgbXNIaWRkZW5UYXJnZXRzID0gW107ICAgICAvLyBbe2VsLCBuYW1lfV0g4oCUINGA0LXQsNC70YzQvdC+INGB0L/RgNGP0YLQsNC90L3Ri9C1INGB0LXQudGH0LDRgSDRjdC70LXQvNC10L3RgtGLXG5jb25zdCBLTk9XTl9NU19GSUVMRFMgPSBbXG4gICAgJ9Ce0L/Qu9Cw0YfQtdC90L4g0LHQvtC90YPRgdCw0LzQuCcsICfQodGD0LzQvNCwINCd0JTQoScsICfQn9GA0L7QvNC10LbRg9GC0L7Rh9C90YvQuSDQuNGC0L7QsycsICfQntCx0YnQsNGPINGB0YLQvtC40LzQvtGB0YLRjCcsXG4gICAgJ9Ce0LHRitC10LwnLCAn0JLQtdGBJywgJ9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2JywgJ9Cf0YDQvtC10LrRgicsICfQkNC00YDQtdGBINC00L7RgdGC0LDQstC60LgnLCAn0JrQvtC80LzQtdC90YLQsNGA0LjQuScsXG4gICAgJ9Cd0L7QvNC10YAg0LfQsNC60LDQt9CwINC90LAg0YHQsNC50YLQtScsICfQn9C70LDQvS4g0LTQsNGC0LAg0L7RgtCz0YDRg9C30LrQuCcsICfQlNC+0LPQvtCy0L7RgCcsICfQktCw0LvRjtGC0LAg0LTQvtC60YPQvNC10L3RgtCwJ1xuXTtcblxuLy8g4pSA4pSA4pSAINCf0LDQvdC10LvRjCDQsdGL0YHRgtGA0YvRhSDQutC90L7Qv9C+0Log0JzQvtC50KHQutC70LDQtCAo0YHQvtC30LTQsNGC0Ywv0L/QtdGH0LDRgtGMKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIGtpbmQg4oaSINC/0YPQvdC60YLRiyDQvNC10L3RjiDRgtGD0LvQsdCw0YDQsCDQutCw0YDRgtC+0YfQutC4LiBtYXJrZXIoKSDQvtC/0YDQtdC00LXQu9GP0LXRgiDRgdGC0YDQsNC90LjRhtGDINC/0L4gaGFzaC5cbmxldCBtc1F1aWNrUGFuZWxFbmFibGVkID0gdHJ1ZTtcbmxldCBtc1F1aWNrT2JzZXJ2ZXIgPSBudWxsO1xuY29uc3QgTVNfUVVJQ0tfUEFORUxfQ09ORklHID0ge1xuICAgIGN1c3RvbWVyb3JkZXI6IHtcbiAgICAgICAgbWFya2VyOiAoKSA9PiAvXiNjdXN0b21lcm9yZGVyXFwvZWRpdC8udGVzdChsb2NhdGlvbi5oYXNoKSxcbiAgICAgICAgbWFnaWM6IGZhbHNlLFxuICAgICAgICBjcmVhdGU6IFsn0J7RgtCz0YDRg9C30LrQsCcsICfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0LXQticsICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCddLFxuICAgICAgICBwcmludDogWydb0KHQtdGA0LLQuNGBXSDQn9GA0LjQtdC80L3QsNGPINC60LLQuNGC0LDQvdGG0LjRjyBBNCB4MicsICdb0KHQtdGA0LLQuNGBXSDQotC+0LLQsNGA0L3Ri9C5INGH0LXQuicsICdb0KHQtdGA0LLQuNGBXSDQlNC+0LPQvtCy0L7RgCDQutGD0L/Qu9C4LdC/0YDQvtC00LDQttC4ICvQsNC60YInXVxuICAgIH0sXG4gICAgZGVtYW5kOiB7XG4gICAgICAgIG1hcmtlcjogKCkgPT4gL14jZGVtYW5kXFwvZWRpdC8udGVzdChsb2NhdGlvbi5oYXNoKSxcbiAgICAgICAgbWFnaWM6IHRydWUsXG4gICAgICAgIGNyZWF0ZTogWyfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0LXQticsICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCcsICfQktC+0LfQstGA0LDRgiDQv9C+0LrRg9C/0LDRgtC10LvRjyddLFxuICAgICAgICBwcmludDogWyfQotC+0LLQsNGA0L3Ri9C5INGH0LXQuiA1JScsICfQotC+0LLQsNGA0L3Ri9C5INGH0LXQuiDQn9Cw0YLQtdC90YInLCAnW9Ch0LXRgNCy0LjRgV0g0KLQvtCy0LDRgNC90YvQuSDRh9C10Log0JA0JywgJ1vQodC10YDQstC40YFdINCa0LLQuNGC0LDQvdGG0LjRjyDQvdCwINCxL9GDJ11cbiAgICB9LFxuICAgIGNhc2hpbjoge1xuICAgICAgICBtYXJrZXI6ICgpID0+IC9eI2Nhc2hpblxcL2VkaXQvLnRlc3QobG9jYXRpb24uaGFzaCksXG4gICAgICAgIG1hZ2ljOiB0cnVlLFxuICAgICAgICBjcmVhdGU6IFsn0J7RgtCz0YDRg9C30LrQsCcsICfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0LXQtiddLFxuICAgICAgICBwcmludDogW11cbiAgICB9LFxuICAgIHBheW1lbnRpbjoge1xuICAgICAgICBtYXJrZXI6ICgpID0+IC9eI3BheW1lbnRpblxcL2VkaXQvLnRlc3QobG9jYXRpb24uaGFzaCksXG4gICAgICAgIG1hZ2ljOiB0cnVlLFxuICAgICAgICBjcmVhdGU6IFsn0J7RgtCz0YDRg9C30LrQsCcsICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCddLFxuICAgICAgICBwcmludDogW11cbiAgICB9XG59O1xuXG5jb25zdCBERUJVR19TVE9SQUdFX0tFWSA9ICdtZW1jaGF0OmRlYnVnJztcblxuLy8g4pSA4pSA4pSAINCY0YHRgtC+0YDQuNGPINGH0LDRgtCwINC/0L4g0LLQutC70LDQtNC60LDQvCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhpc3RvcnlGb3IoYWN0aW9uKSB7XG4gICAgY29uc3Qga2V5ID0gYWN0aW9uIHx8ICdjaGVja0hhdGlrbyc7XG4gICAgaWYgKCFjaGF0SGlzdG9yeUJ5QWN0aW9uW2tleV0pIGNoYXRIaXN0b3J5QnlBY3Rpb25ba2V5XSA9IFtdO1xuICAgIHJldHVybiBjaGF0SGlzdG9yeUJ5QWN0aW9uW2tleV07XG59XG5cbmZ1bmN0aW9uIGFjdGl2ZUhpc3RvcnkoKSB7XG4gICAgcmV0dXJuIGhpc3RvcnlGb3IoY3VycmVudEFjdGlvbik7XG59XG5cbmZ1bmN0aW9uIGlzRGVidWdFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShERUJVR19TVE9SQUdFX0tFWSkgPT09ICd0cnVlJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZGVidWdMb2coc2NvcGUsIC4uLmFyZ3MpIHtcbiAgICBpZiAoaXNEZWJ1Z0VuYWJsZWQoKSkgY29uc29sZS5kZWJ1ZyhgW01lbWNoYXQ6JHtzY29wZX1dYCwgLi4uYXJncyk7XG59XG5cbmZ1bmN0aW9uIGRlYnVnRXJyb3Ioc2NvcGUsIC4uLmFyZ3MpIHtcbiAgICBjb25zb2xlLmVycm9yKGBbTWVtY2hhdDoke3Njb3BlfV1gLCAuLi5hcmdzKTtcbn1cblxuZnVuY3Rpb24gdG9nZ2xlRGVidWdNb2RlKCkge1xuICAgIGNvbnN0IGVuYWJsZWQgPSAhaXNEZWJ1Z0VuYWJsZWQoKTtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShERUJVR19TVE9SQUdFX0tFWSwgU3RyaW5nKGVuYWJsZWQpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdkZWJ1ZycsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDRgNC10LbQuNC8INC+0YLQu9Cw0LTQutC4JywgZXJyb3IpO1xuICAgIH1cbiAgICBjb25zb2xlLmluZm8oYFtNZW1jaGF0OmRlYnVnXSAke2VuYWJsZWQgPyAn0LLQutC70Y7Rh9C10L3QsCcgOiAn0LLRi9C60LvRjtGH0LXQvdCwJ31gKTtcbn1cblxuZnVuY3Rpb24gaW5zdGFsbERlYnVnSGFuZGxlcnMoKSB7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgZXZlbnQgPT4ge1xuICAgICAgICBkZWJ1Z0Vycm9yKCd1bmNhdWdodCcsIGV2ZW50LmVycm9yIHx8IGV2ZW50Lm1lc3NhZ2UsIGV2ZW50LmZpbGVuYW1lLCBldmVudC5saW5lbm8pO1xuICAgIH0pO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCd1bmhhbmRsZWRyZWplY3Rpb24nLCBldmVudCA9PiB7XG4gICAgICAgIGNvbnN0IHJlYXNvbiA9IGV2ZW50LnJlYXNvbjtcbiAgICAgICAgZGVidWdFcnJvcigncHJvbWlzZScsIHJlYXNvbj8uc3RhY2sgfHwgcmVhc29uPy5tZXNzYWdlIHx8IHJlYXNvbik7XG4gICAgfSk7XG59XG5cbiIsIi8vIOKUgOKUgOKUgCDQl9Cw0LPRgNGD0LfQutCwIC8g0YHQvtGF0YDQsNC90LXQvdC40LUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBzdG9yYWdlS2V5KGtleSkge1xuICAgIHJldHVybiBgJHt0eXBlb2YgTUVNQ0hBVF9CVUlMRCAhPT0gJ3VuZGVmaW5lZCcgPyBgbWVtY2hhdDoke01FTUNIQVRfQlVJTER9OmAgOiAnbWVtY2hhdDonfSR7a2V5fWA7XG59XG5cbmZ1bmN0aW9uIGxvYWRDYWxjUnVsZXMoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qga2V5ID0gc3RvcmFnZUtleSgnY2FsY1J1bGVzX3YyJyk7XG4gICAgICAgIGNvbnN0IGxlZ2FjeUtleSA9ICdjYWxjUnVsZXNfdjInO1xuICAgICAgICBjb25zdCBzID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KVxuICAgICAgICAgICAgfHwgKHR5cGVvZiBNRU1DSEFUX0JVSUxEID09PSAndW5kZWZpbmVkJyA/IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgOiBudWxsKTtcbiAgICAgICAgY2FsY1J1bGVzID0gcyA/IEpTT04ucGFyc2UocykgOiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfQ0FMQ19SVUxFUykpO1xuICAgICAgICBpZiAocyAmJiAhbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSkgc2F2ZUNhbGNSdWxlcygpO1xuICAgIH0gY2F0Y2ggeyBjYWxjUnVsZXMgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfQ0FMQ19SVUxFUykpOyB9XG59XG5mdW5jdGlvbiBzYXZlQ2FsY1J1bGVzKCkge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2NhbGNSdWxlc192MicpLCBKU09OLnN0cmluZ2lmeShjYWxjUnVsZXMpKTtcbn1cblxuZnVuY3Rpb24gbG9hZFNjaGVkdWxlUmVwbGFjZW1lbnRzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGtleSA9IHN0b3JhZ2VLZXkoJ3NjaGVkdWxlUmVwbGFjZW1lbnRzX3YxJyk7XG4gICAgICAgIGNvbnN0IGxlZ2FjeUtleSA9ICdzY2hlZHVsZVJlcGxhY2VtZW50c192MSc7XG4gICAgICAgIGNvbnN0IHMgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpXG4gICAgICAgICAgICB8fCAodHlwZW9mIE1FTUNIQVRfQlVJTEQgPT09ICd1bmRlZmluZWQnID8gbG9jYWxTdG9yYWdlLmdldEl0ZW0obGVnYWN5S2V5KSA6IG51bGwpO1xuICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50cyA9IHMgPyBKU09OLnBhcnNlKHMpIDogSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX1JFUExBQ0VNRU5UUykpO1xuICAgICAgICBpZiAocyAmJiAhbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSkgc2F2ZVNjaGVkdWxlUmVwbGFjZW1lbnRzKCk7XG4gICAgfSBjYXRjaCB7IHNjaGVkdWxlUmVwbGFjZW1lbnRzID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX1JFUExBQ0VNRU5UUykpOyB9XG59XG5mdW5jdGlvbiBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKSB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnKSwgSlNPTi5zdHJpbmdpZnkoc2NoZWR1bGVSZXBsYWNlbWVudHMpKTtcbiAgICBPYmplY3QuZW50cmllcyhzY2hlZHVsZVN0YXRlQnlEYXkpLmZvckVhY2goKFtkYXksIHN0YXRlXSkgPT4ge1xuICAgICAgICBpZiAoc3RhdGUuc25hcHNob3QpIGFwcGx5U2NoZWR1bGVTbmFwc2hvdChkYXksIHN0YXRlLnNuYXBzaG90KTtcbiAgICAgICAgcmVuZGVyU2NoZWR1bGVUYWIoZGF5KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gbG9hZFNjaGVkdWxlQ2FjaGVFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHNjaGVkdWxlQ2FjaGVFbmFibGVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnc2NoZWR1bGVDYWNoZUVuYWJsZWRfdjEnKSkgIT09ICdmYWxzZSc7XG4gICAgfSBjYXRjaCB7IHNjaGVkdWxlQ2FjaGVFbmFibGVkID0gdHJ1ZTsgfVxufVxuXG5mdW5jdGlvbiBzYXZlU2NoZWR1bGVDYWNoZUVuYWJsZWQoZW5hYmxlZCkge1xuICAgIHNjaGVkdWxlQ2FjaGVFbmFibGVkID0gISFlbmFibGVkO1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ3NjaGVkdWxlQ2FjaGVFbmFibGVkX3YxJyksIFN0cmluZyhzY2hlZHVsZUNhY2hlRW5hYmxlZCkpO1xuICAgIH0gY2F0Y2ggeyAvKiDQndCw0YHRgtGA0L7QudC60LAg0L/RgNC+0LTQvtC70LbQsNC10YIg0LTQtdC50YHRgtCy0L7QstCw0YLRjCDQsiDRgtC10LrRg9GJ0LXQuSDRgdGC0YDQsNC90LjRhtC1LiAqLyB9XG59XG5cbmZ1bmN0aW9uIGxvYWRTY2hlZHVsZUNhY2hlKGRheSwgdGFyZ2V0RGF0ZSkge1xuICAgIGlmICghc2NoZWR1bGVDYWNoZUVuYWJsZWQpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KGBzY2hlZHVsZUNhY2hlX3YxXyR7ZGF5fWApKSB8fCAnbnVsbCcpO1xuICAgICAgICBjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gc2F2ZWQ/LmZldGNoZWRBdDtcbiAgICAgICAgaWYgKHNhdmVkPy5zY2hlbWEgIT09IDEgfHwgc2F2ZWQudGFyZ2V0RGF0ZSAhPT0gdGFyZ2V0RGF0ZVxuICAgICAgICAgICAgfHwgIU51bWJlci5pc0Zpbml0ZShzYXZlZC5mZXRjaGVkQXQpIHx8IGFnZSA8IDAgfHwgYWdlID49IFNDSEVEVUxFX0NBQ0hFX1RUTF9NU1xuICAgICAgICAgICAgfHwgdHlwZW9mIHNhdmVkLnJhd1RleHQgIT09ICdzdHJpbmcnIHx8ICFzYXZlZC5yYXdUZXh0LnRyaW0oKVxuICAgICAgICAgICAgfHwgIXNhdmVkLnJlbW90ZVJlcGxhY2VtZW50cyB8fCB0eXBlb2Ygc2F2ZWQucmVtb3RlUmVwbGFjZW1lbnRzICE9PSAnb2JqZWN0J1xuICAgICAgICAgICAgfHwgQXJyYXkuaXNBcnJheShzYXZlZC5yZW1vdGVSZXBsYWNlbWVudHMpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIHNhdmVkO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxufVxuXG5mdW5jdGlvbiBzYXZlU2NoZWR1bGVDYWNoZShkYXksIHNuYXBzaG90KSB7XG4gICAgaWYgKCFzY2hlZHVsZUNhY2hlRW5hYmxlZCkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoYHNjaGVkdWxlQ2FjaGVfdjFfJHtkYXl9YCksIEpTT04uc3RyaW5naWZ5KHNuYXBzaG90KSk7XG4gICAgfSBjYXRjaCB7IC8qINCd0LXQtNC+0YHRgtGD0L/QvdC+0LUg0YXRgNCw0L3QuNC70LjRidC1INC90LUg0LzQtdGI0LDQtdGCINC/0L7QutCw0LfQsNGC0Ywg0L/QvtC70YPRh9C10L3QvdC+0LUg0YDQsNGB0L/QuNGB0LDQvdC40LUuICovIH1cbn1cblxuZnVuY3Rpb24gbG9hZFNlbGVjdGVkQWN0aW9uKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdzZWxlY3RlZEFjdGlvbl92MScpKSB8fCAnY2hlY2tIYXRpa28nO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gJ2NoZWNrSGF0aWtvJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVTZWxlY3RlZEFjdGlvbihhY3Rpb24pIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdzZWxlY3RlZEFjdGlvbl92MScpLCBhY3Rpb24pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0LLRi9Cx0YDQsNC90L3Ri9C5INGA0LXQttC40LwnLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBsb2FkU2hvd0hhdGlrb0xpbmtzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdzaG93SGF0aWtvTGlua3NfdjEnKSkgPT09ICd0cnVlJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gc2F2ZVNob3dIYXRpa29MaW5rcyhlbmFibGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnc2hvd0hhdGlrb0xpbmtzX3YxJyksIFN0cmluZyhlbmFibGVkKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQvdCw0YHRgtGA0L7QudC60YMg0YHRgdGL0LvQvtC6IEhhdGlrbycsIGVycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGxvYWRIYXRpa29TZWFyY2hNb2RlKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYXRpa29TZWFyY2hNb2RlX3YxJykpO1xuICAgICAgICByZXR1cm4gWydhdXRvJywgJ3BhbmVsJywgJ2hhdGlrbyddLmluY2x1ZGVzKG1vZGUpID8gbW9kZSA6ICdhdXRvJztcbiAgICB9IGNhdGNoIHsgcmV0dXJuICdhdXRvJzsgfVxufVxuXG5mdW5jdGlvbiBzYXZlSGF0aWtvU2VhcmNoTW9kZShtb2RlKSB7XG4gICAgaWYgKCFbJ2F1dG8nLCAncGFuZWwnLCAnaGF0aWtvJ10uaW5jbHVkZXMobW9kZSkpIHJldHVybjtcbiAgICBoYXRpa29TZWFyY2hNb2RlID0gbW9kZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYXRpa29TZWFyY2hNb2RlX3YxJyksIG1vZGUpO1xufVxuXG5mdW5jdGlvbiBsb2FkUmV0cnlCZWhhdmlvcigpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBiZWhhdmlvciA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ3JldHJ5QmVoYXZpb3JfdjEnKSk7XG4gICAgICAgIHJldHVybiBiZWhhdmlvciA9PT0gJ3JlcGxhY2UnID8gJ3JlcGxhY2UnIDogJ2FwcGVuZCc7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnYXBwZW5kJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVSZXRyeUJlaGF2aW9yKGJlaGF2aW9yKSB7XG4gICAgaWYgKCFbJ2FwcGVuZCcsICdyZXBsYWNlJ10uaW5jbHVkZXMoYmVoYXZpb3IpKSByZXR1cm47XG4gICAgcmV0cnlCZWhhdmlvciA9IGJlaGF2aW9yO1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ3JldHJ5QmVoYXZpb3JfdjEnKSwgYmVoYXZpb3IpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L/QvtCy0LXQtNC10L3QuNC1INC60L3QvtC/0LrQuCDQv9C+0LLRgtC+0YDQsCcsIGVycm9yKTtcbiAgICB9XG59XG5cbi8vIOKUgOKUgOKUgCDQodC60YDRi9GC0YvQtSDQv9C+0LvRjyDQnNC+0LnQodC60LvQsNC0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gbG9hZEhpZGRlbkZpZWxkcygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGlkZGVuRmllbGRzX3YxJykpO1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBzID8gSlNPTi5wYXJzZShzKSA6IFtdO1xuICAgICAgICBoaWRkZW5GaWVsZHMgPSBBcnJheS5pc0FycmF5KHBhcnNlZCkgPyBwYXJzZWQuZmlsdGVyKG4gPT4gdHlwZW9mIG4gPT09ICdzdHJpbmcnKSA6IFtdO1xuICAgIH0gY2F0Y2ggeyBoaWRkZW5GaWVsZHMgPSBbXTsgfVxufVxuXG5mdW5jdGlvbiBzYXZlSGlkZGVuRmllbGRzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hpZGRlbkZpZWxkc192MScpLCBKU09OLnN0cmluZ2lmeShoaWRkZW5GaWVsZHMpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdzdG9yYWdlJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINGB0L/QuNGB0L7QuiDRgdC60YDRi9GC0YvRhSDQv9C+0LvQtdC5JywgZXJyb3IpO1xuICAgIH1cbn1cblxuLy8g4pSA4pSA4pSAINCf0LDQvdC10LvRjCDQsdGL0YHRgtGA0YvRhSDQutC90L7Qv9C+0Log0JzQvtC50KHQutC70LDQtCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGxvYWRNc1F1aWNrUGFuZWxFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdtc1F1aWNrUGFuZWxfdjEnKSkgPT09ICdmYWxzZScpIG1zUXVpY2tQYW5lbEVuYWJsZWQgPSBmYWxzZTtcbiAgICB9IGNhdGNoIHsgLyog0L/QviDRg9C80L7Qu9GH0LDQvdC40Y4g0LLQutC70Y7Rh9C10L3QsCAqLyB9XG59XG5cbmZ1bmN0aW9uIHNhdmVNc1F1aWNrUGFuZWxFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ21zUXVpY2tQYW5lbF92MScpLCBTdHJpbmcobXNRdWlja1BhbmVsRW5hYmxlZCkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L3QsNGB0YLRgNC+0LnQutGDINC/0LDQvdC10LvQuCDQsdGL0YHRgtGA0YvRhSDQutC90L7Qv9C+0LonLCBlcnJvcik7XG4gICAgfVxufVxuXG4vLyDQn9C+0LfQuNGG0LjRjyDQv9C70LDQstCw0Y7RidC40YUg0L7QutC+0L0gKNGA0LDRgdC/0LjRgdCw0L3QuNC1LCDQvdCw0YHRgtGA0L7QudC60LgsINCl0LDQutC10YApIOKAlCDQvtCx0YnQsNGPINC4INC/0LXRgNC10LbQuNCy0LDQtdGCINGB0LXRgdGB0LjQuC5cbmZ1bmN0aW9uIGxvYWRGbG9hdFdpbmRvd1BvcygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdmbG9hdFdpbmRvd1Bvc192MScpKSB8fCAnbnVsbCcpO1xuICAgICAgICByZXR1cm4gKHAgJiYgdHlwZW9mIHAubGVmdCA9PT0gJ251bWJlcicgJiYgdHlwZW9mIHAudG9wID09PSAnbnVtYmVyJykgPyBwIDogbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBzYXZlRmxvYXRXaW5kb3dQb3MobGVmdCwgdG9wKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnZmxvYXRXaW5kb3dQb3NfdjEnKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgbGVmdDogcGFyc2VJbnQobGVmdCwgMTApLFxuICAgICAgICAgICAgdG9wOiBwYXJzZUludCh0b3AsIDEwKVxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQv9C+0LfQuNGG0LjRjiDQvtC60L3QsCcsIGVycm9yKTtcbiAgICB9XG59XG5cbi8vINCh0LHRgNC+0YEg0L/QvtC30LjRhtC40Lgg0L/Qu9Cw0LLQsNGO0YnQuNGFINC+0LrQvtC9ICjQtdGB0LvQuCDQvtC60L3QviDCq9GD0LXRhdCw0LvQvsK7INC30LAg0L/RgNC10LTQtdC70Ysg0Y3QutGA0LDQvdCwKS5cbmZ1bmN0aW9uIHJlc2V0RmxvYXRXaW5kb3dQb3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oc3RvcmFnZUtleSgnZmxvYXRXaW5kb3dQb3NfdjEnKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0LHRgNC+0YHQuNGC0Ywg0L/QvtC30LjRhtC40Y4g0L7QutC90LAnLCBlcnJvcik7XG4gICAgfVxufVxuXG4vLyDilIDilIDilIAg0J/QtdGA0YHQuNGB0YIg0LjRgdGC0L7RgNC40Lgg0YfQsNGC0LAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQktC60LvQsNC00LrRgyDCq9CR0L7QvdGD0YHRi8K7ICjQvdC+0LzQtdGA0LAg0YLQtdC70LXRhNC+0L3QvtCyINC60LvQuNC10L3RgtC+0LIsINCf0JTQvSkg0J3QlSDQv9C10YDRgdC40YHRgtC40LwuXG5jb25zdCBISVNUT1JZX1NUT1JBR0VfS0VZID0gJ2NoYXRIaXN0b3J5X3YxJztcbmNvbnN0IEhJU1RPUllfTUFYX1BFUl9UQUIgPSAxMDA7XG5cbmZ1bmN0aW9uIHNhdmVDaGF0SGlzdG9yeSgpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYWZlID0ge307XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKGNoYXRIaXN0b3J5QnlBY3Rpb24pLmZvckVhY2goKFthY3Rpb24sIGVudHJpZXNdKSA9PiB7XG4gICAgICAgICAgICBpZiAoYWN0aW9uID09PSAnY2hlY2tIYXRpa29Cb251c2VzJykgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGVudHJpZXMpKSByZXR1cm47XG4gICAgICAgICAgICBzYWZlW2FjdGlvbl0gPSBlbnRyaWVzLnNsaWNlKC1ISVNUT1JZX01BWF9QRVJfVEFCKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoSElTVE9SWV9TVE9SQUdFX0tFWSksIEpTT04uc3RyaW5naWZ5KHNhZmUpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdzdG9yYWdlJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC40YHRgtC+0YDQuNGOJywgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gbG9hZENoYXRIaXN0b3J5KCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoSElTVE9SWV9TVE9SQUdFX0tFWSkpO1xuICAgICAgICBpZiAoIXJhdykgcmV0dXJuO1xuICAgICAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKHNhdmVkKS5mb3JFYWNoKChbYWN0aW9uLCBlbnRyaWVzXSkgPT4ge1xuICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ2NoZWNrSGF0aWtvQm9udXNlcycpIHJldHVybjsgLy8g0J/QlNC9IOKAlCDQvdC1INCy0L7RgdGB0YLQsNC90LDQstC70LjQstCw0LXQvFxuICAgICAgICAgICAgaWYgKCFNT0RFX0FDVElPTlMuaW5jbHVkZXMoYWN0aW9uKSkgcmV0dXJuOyAgLy8g0YLQvtC70YzQutC+INGA0LXQttC40LzQvdGL0LUg0LLQutC70LDQtNC60LhcbiAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShlbnRyaWVzKSkgcmV0dXJuO1xuICAgICAgICAgICAgY2hhdEhpc3RvcnlCeUFjdGlvblthY3Rpb25dID0gZW50cmllc1xuICAgICAgICAgICAgICAgIC5maWx0ZXIoZSA9PiBlICYmIHR5cGVvZiBlLm1lc3NhZ2UgPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgICAgIC5zbGljZSgtSElTVE9SWV9NQVhfUEVSX1RBQik7XG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDQt9Cw0LPRgNGD0LfQuNGC0Ywg0LjRgdGC0L7RgNC40Y4nLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBwYW5lbENzcmZTdG9yYWdlS2V5KCkge1xuICAgIHJldHVybiBzdG9yYWdlS2V5KCdwYW5lbENzcmZfdjEnKTtcbn1cblxuY29uc3QgUEFORUxfQ1NSRl9UVExfTVMgPSAxMiAqIDYwICogMTAwMDsgLy8gMTIg0LzQuNC9OiBMYXJhdmVsLdGC0L7QutC10L3RiyDQttC40LLRg9GCINC90LXQtNC+0LvQs9C+LCDRgNC10YTRgNC10YjQuNC8INC30LDRgNCw0L3QtdC1XG5cbmZ1bmN0aW9uIG9wZW5QYW5lbEluQmFja2dyb3VuZCgpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnBhbmVsKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdyA9IHdpbmRvdy5vcGVuKCdodHRwczovL3BhbmVsLmhhdGlrby5ydS8nLCAnX2JsYW5rJyk7XG4gICAgICAgIGlmICh3KSB3LmJsdXIoKTtcbiAgICB9IGNhdGNoIChlKSB7IGRlYnVnRXJyb3IoJ3BhbmVsLWF1dGgnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvtGC0LrRgNGL0YLRjCDQv9Cw0L3QtdC70YwnLCBlKTsgfVxufVxuXG5mdW5jdGlvbiBsb2FkUGFuZWxDc3JmKCkge1xuICAgIGlmIChtZW1jaGF0UGxhdGZvcm0ucGFuZWwpIHJldHVybiAnJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0ocGFuZWxDc3JmU3RvcmFnZUtleSgpKSB8fCAnbnVsbCcpO1xuICAgICAgICBpZiAoIXNhdmVkPy50b2tlbiB8fCAhc2F2ZWQ/LnNhdmVkQXQgfHwgRGF0ZS5ub3coKSAtIHNhdmVkLnNhdmVkQXQgPiBQQU5FTF9DU1JGX1RUTF9NUykgcmV0dXJuICcnO1xuICAgICAgICByZXR1cm4gc2F2ZWQudG9rZW47XG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxufVxuXG5mdW5jdGlvbiBzYXZlUGFuZWxDc3JmKHRva2VuKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5wYW5lbCkgcmV0dXJuO1xuICAgIGlmICghdG9rZW4pIHJldHVybjtcbiAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShwYW5lbENzcmZTdG9yYWdlS2V5KCksIEpTT04uc3RyaW5naWZ5KHsgdG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCkgfSkpOyB9XG4gICAgY2F0Y2ggKGVycm9yKSB7IGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0YwgQ1NSRiBQYW5lbCcsIGVycm9yKTsgfVxufVxuXG5mdW5jdGlvbiBjbGVhclBhbmVsQ3NyZigpIHtcbiAgICB0cnkgeyBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShwYW5lbENzcmZTdG9yYWdlS2V5KCkpOyB9IGNhdGNoIHsgLyogc3RvcmFnZSB1bmF2YWlsYWJsZSAqLyB9XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hQYW5lbENzcmYob25TdWNjZXNzLCBvbkVycm9yLCBhdHRlbXB0cyA9IDIpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnBhbmVsKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLnBhbmVsLmVuc3VyZShvblN1Y2Nlc3MsIG9uRXJyb3IsIHRydWUpO1xuICAgIGNvbnN0IGF0dGVtcHRGZXRjaCA9IChsZWZ0KSA9PiB7XG4gICAgICAgIHBhbmVsUmVxdWVzdChgL3NlYXJjaD9fPSR7RGF0ZS5ub3coKX1gLCB7fSwgcmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgY29uc3QgdG9rZW4gPSBwYXJzZVBhbmVsQ3NyZihyZXNwb25zZS5yZXNwb25zZVRleHQpO1xuICAgICAgICAgICAgaWYgKCF0b2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0ID4gMCkgeyBzZXRUaW1lb3V0KCgpID0+IGF0dGVtcHRGZXRjaChsZWZ0IC0gMSksIDkwMCk7IHJldHVybjsgfVxuICAgICAgICAgICAgICAgIGNsZWFyUGFuZWxDc3JmKCk7XG4gICAgICAgICAgICAgICAgb25FcnJvcj8uKG5ldyBFcnJvcignUGFuZWw6INC90LXRgiDQsNCy0YLQvtGA0LjQt9Cw0YbQuNC4LiDQktC+0LnQtNC40YLQtSDQsiBwYW5lbC5oYXRpa28ucnUuJykpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNhdmVQYW5lbENzcmYodG9rZW4pO1xuICAgICAgICAgICAgZGVidWdMb2coJ3BhbmVsLWNzcmYnLCAn0L7QsdC90L7QstC70ZHQvScpO1xuICAgICAgICAgICAgb25TdWNjZXNzPy4odG9rZW4pO1xuICAgICAgICB9LCBlcnJvciA9PiB7XG4gICAgICAgICAgICBpZiAobGVmdCA+IDApIHsgc2V0VGltZW91dCgoKSA9PiBhdHRlbXB0RmV0Y2gobGVmdCAtIDEpLCA5MDApOyByZXR1cm47IH1cbiAgICAgICAgICAgIG9uRXJyb3I/LihlcnJvcik7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgYXR0ZW1wdEZldGNoKE1hdGgubWF4KDEsIGF0dGVtcHRzKSk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVBhbmVsQ3NyZihvblN1Y2Nlc3MsIG9uRXJyb3IsIGZvcmNlID0gZmFsc2UpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnBhbmVsKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLnBhbmVsLmVuc3VyZShvblN1Y2Nlc3MsIG9uRXJyb3IsIGZvcmNlID09PSB0cnVlKTtcbiAgICBpZiAoZm9yY2UpIHsgcmVmcmVzaFBhbmVsQ3NyZihvblN1Y2Nlc3MsIG9uRXJyb3IpOyByZXR1cm47IH1cbiAgICBjb25zdCBjYWNoZWQgPSBsb2FkUGFuZWxDc3JmKCk7XG4gICAgaWYgKGNhY2hlZCkgeyBvblN1Y2Nlc3MoY2FjaGVkKTsgcmV0dXJuOyB9XG4gICAgcmVmcmVzaFBhbmVsQ3NyZihvblN1Y2Nlc3MsIGVycm9yID0+IHtcbiAgICAgICAgb3BlblBhbmVsSW5CYWNrZ3JvdW5kKCk7XG4gICAgICAgIG9uRXJyb3I/LihlcnJvcik7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHBhbmVsUmVxdWVzdChwYXRoLCBvcHRpb25zLCBvblN1Y2Nlc3MsIG9uRXJyb3IpIHtcbiAgICBHTV94bWxodHRwUmVxdWVzdCh7XG4gICAgICAgIG1ldGhvZDogb3B0aW9ucz8ubWV0aG9kIHx8ICdHRVQnLFxuICAgICAgICB1cmw6IGBodHRwczovL3BhbmVsLmhhdGlrby5ydSR7cGF0aH1gLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uLCB0ZXh0L2h0bWw7cT0wLjknLFxuICAgICAgICAgICAgUmVmZXJlcjogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcsXG4gICAgICAgICAgICBPcmlnaW46ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScsXG4gICAgICAgICAgICAnVXNlci1BZ2VudCc6IHR5cGVvZiBuYXZpZ2F0b3IgIT09ICd1bmRlZmluZWQnID8gbmF2aWdhdG9yLnVzZXJBZ2VudCA6ICdNb3ppbGxhLzUuMCcsXG4gICAgICAgICAgICAnWC1SZXF1ZXN0ZWQtV2l0aCc6ICdYTUxIdHRwUmVxdWVzdCcsXG4gICAgICAgICAgICAuLi4ob3B0aW9ucz8uaGVhZGVycyB8fCB7fSlcbiAgICAgICAgfSxcbiAgICAgICAgZGF0YTogb3B0aW9ucz8uZGF0YSxcbiAgICAgICAgdGltZW91dDogMzAwMDAsXG4gICAgICAgIGFub255bW91czogZmFsc2UsXG4gICAgICAgIG9ubG9hZDogcmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgY29uc3QgY29udGVudFR5cGUgPSByZXNwb25zZS5yZXNwb25zZUhlYWRlcnM/Lm1hdGNoKC9jb250ZW50LXR5cGU6XFxzKihbXlxcclxcbl0rKS9pKT8uWzFdIHx8ICcnO1xuICAgICAgICAgICAgY29uc3QgcmF3ID0gcmVzcG9uc2UucmVzcG9uc2VUZXh0IHx8ICcnO1xuICAgICAgICAgICAgY29uc3QgaXNIdG1sID0gL15cXHMqPGh0bWwvaS50ZXN0KHJhdykgfHwgL25vaW5kZXgsIG5vYXJjaGl2ZXxhamF4bG9hZFxcLmluZm98Z29yaXpvbnRhbC12ZXJ0aWthbC9pLnRlc3QocmF3KTtcbiAgICAgICAgICAgIGRlYnVnTG9nKCdwYW5lbC1yZXNwb25zZScsIHsgcGF0aCwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGNvbnRlbnRUeXBlLCBpc0h0bWwgfSk7XG4gICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID49IDIwMCAmJiByZXNwb25zZS5zdGF0dXMgPCAzMDAgJiYgIWlzSHRtbCkge1xuICAgICAgICAgICAgICAgIG9uU3VjY2VzcyhyZXNwb25zZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGlzSHRtbCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGxvZ2luID0gL1xcL2xvZ2lufNCy0YXQvtC0fNCw0LLRgtC+0YDQuNC30LDRhi9pLnRlc3QocmF3KTtcbiAgICAgICAgICAgICAgICBvbkVycm9yKG5ldyBFcnJvcihsb2dpblxuICAgICAgICAgICAgICAgICAgICA/ICdQYW5lbDog0L3QtdGCINCw0LLRgtC+0YDQuNC30LDRhtC40LguINCS0L7QudC00LjRgtC1INCyIHBhbmVsLmhhdGlrby5ydS4nXG4gICAgICAgICAgICAgICAgICAgIDogJ1BhbmVsOiDQstC10YDQvdGD0LvQsCBIVE1MINCy0LzQtdGB0YLQviBKU09OLiDQn9GA0L7QstC10YDRjCDQsNCy0YLQvtGA0LjQt9Cw0YbQuNGOIFBhbmVsLicpLCByZXNwb25zZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9uRXJyb3IobmV3IEVycm9yKGBQYW5lbCBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApLCByZXNwb25zZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIG9udGltZW91dDogKCkgPT4gb25FcnJvcihuZXcgRXJyb3IoJ1BhbmVsOiDRgtCw0LnQvNCw0YPRgiDQt9Cw0L/RgNC+0YHQsCcpKSxcbiAgICAgICAgb25lcnJvcjogZXJyb3IgPT4gb25FcnJvcihuZXcgRXJyb3IoYFBhbmVsOiDQvtGI0LjQsdC60LAg0YHQtdGC0LggJHtlcnJvcn1gKSlcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQYW5lbENzcmYoaHRtbCkge1xuICAgIGNvbnN0IG1ldGEgPSBodG1sLm1hdGNoKC88bWV0YVxcYltePl0qbmFtZT1bXCInXWNzcmYtdG9rZW5bXCInXVtePl0qY29udGVudD1bXCInXShbXlwiJ10rKVtcIiddL2kpO1xuICAgIGlmIChtZXRhKSByZXR1cm4gbWV0YVsxXTtcbiAgICBjb25zdCBpbnB1dCA9IGh0bWwubWF0Y2goLzxpbnB1dFxcYltePl0qbmFtZT1bXCInXV90b2tlbltcIiddW14+XSp2YWx1ZT1bXCInXShbXlwiJ10rKVtcIiddL2kpO1xuICAgIHJldHVybiBpbnB1dCA/IGlucHV0WzFdIDogJyc7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFuZWxKc29uKHJlc3BvbnNlKSB7XG4gICAgY29uc3QgcmF3ID0gU3RyaW5nKHJlc3BvbnNlLnJlc3BvbnNlVGV4dCB8fCByZXNwb25zZS5yZXNwb25zZSB8fCAnJylcbiAgICAgICAgLnJlcGxhY2UoL15cXHVGRUZGLywgJycpXG4gICAgICAgIC50cmltKCk7XG4gICAgaWYgKCFyYXcpIHRocm93IG5ldyBFcnJvcignUGFuZWw6INC/0YPRgdGC0L7QuSDQvtGC0LLQtdGCJyk7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdwYW5lbC1qc29uJywge1xuICAgICAgICAgICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgICAgICBjb250ZW50VHlwZTogcmVzcG9uc2UucmVzcG9uc2VIZWFkZXJzPy5tYXRjaCgvY29udGVudC10eXBlOlxccyooW15cXFxcclxcXFxuXSspL2kpPy5bMV0gfHwgJycsXG4gICAgICAgICAgICBwcmV2aWV3OiByYXcuc2xpY2UoMCwgMTYwKVxuICAgICAgICB9KTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQYW5lbDog0L3QtdC60L7RgNGA0LXQutGC0L3Ri9C5IEpTT04t0L7RgtCy0LXRgicpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gcGFuZWxTZWFyY2gocXVlcnksIG9uU3VjY2Vzcywgb25FcnJvcikge1xuICAgIGNvbnN0IGF0dGVtcHQgPSAoY3NyZiwgcmV0cmllZCkgPT4gcGFuZWxSZXF1ZXN0KCcvYXBpL3NlYXJjaCcsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJywgJ1gtQ1NSRi1UT0tFTic6IGNzcmYgfSxcbiAgICAgICAgZGF0YTogSlNPTi5zdHJpbmdpZnkoeyBzZWFyY2hfdHlwZTogJ2FydGljbGUnLCBxdWVyeTogU3RyaW5nKHF1ZXJ5KS50cmltKCksIGNpdGllc19maWx0ZXI6IFtdLCBzdG9yZXNfZmlsdGVyOiBbXSwgc2hvd19leHRlcm5hbF9jb2RlOiB0cnVlIH0pXG4gICAgfSwgcmVzcG9uc2UgPT4ge1xuICAgICAgICB0cnkgeyBvblN1Y2Nlc3MocGFyc2VQYW5lbEpzb24ocmVzcG9uc2UpKTsgfVxuICAgICAgICBjYXRjaCAoZXJyb3IpIHsgb25FcnJvcihlcnJvcik7IH1cbiAgICB9LCAoZXJyb3IsIHJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGlmICgocmVzcG9uc2U/LnN0YXR1cyA9PT0gNDE5IHx8IHJlc3BvbnNlPy5zdGF0dXMgPT09IDQwMSB8fCByZXNwb25zZT8uc3RhdHVzID09PSA0MDMpICYmICFyZXRyaWVkKSB7XG4gICAgICAgICAgICBjbGVhclBhbmVsQ3NyZigpO1xuICAgICAgICAgICAgcmVmcmVzaFBhbmVsQ3NyZihuZXdDc3JmID0+IGF0dGVtcHQobmV3Q3NyZiwgdHJ1ZSksICgpID0+IHtcbiAgICAgICAgICAgICAgICBvcGVuUGFuZWxJbkJhY2tncm91bmQoKTtcbiAgICAgICAgICAgICAgICBvbkVycm9yKG5ldyBFcnJvcignUGFuZWw6INCw0LLRgtC+0YDQuNC30LDRhtC40Y8g0LjRgdGC0LXQutC70LAuINCS0L7QudC00LjRgtC1INCyIHBhbmVsLmhhdGlrby5ydS4nKSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBvbkVycm9yKGVycm9yKTtcbiAgICB9KTtcbiAgICBlbnN1cmVQYW5lbENzcmYoY3NyZiA9PiBhdHRlbXB0KGNzcmYsIGZhbHNlKSwgb25FcnJvcik7XG59XG5cbmZ1bmN0aW9uIHBhbmVsQ2hlY2tCb251c2VzKHBob25lLCBvblN1Y2Nlc3MsIG9uRXJyb3IpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHBob25lIHx8ICcnKS5yZXBsYWNlKC9cXEQvZywgJycpO1xuICAgIGlmICghbm9ybWFsaXplZCkge1xuICAgICAgICBvbkVycm9yKG5ldyBFcnJvcignUGFuZWw6INCy0LLQtdC00LjRgtC1INC90L7QvNC10YAg0YLQtdC70LXRhNC+0L3QsCcpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBhdHRlbXB0ID0gKGNzcmYsIHJldHJpZWQpID0+IHBhbmVsUmVxdWVzdChgL2FwaS9ib251c2VzL2NoZWNrLyR7ZW5jb2RlVVJJQ29tcG9uZW50KE51bWJlcihub3JtYWxpemVkKSl9YCwge1xuICAgICAgICBoZWFkZXJzOiB7ICdYLUNTUkYtVE9LRU4nOiBjc3JmIH1cbiAgICB9LCByZXNwb25zZSA9PiB7XG4gICAgICAgIHRyeSB7IG9uU3VjY2VzcyhwYXJzZVBhbmVsSnNvbihyZXNwb25zZSkpOyB9XG4gICAgICAgIGNhdGNoIChlcnJvcikgeyBvbkVycm9yKGVycm9yKTsgfVxuICAgIH0sIChlcnJvciwgcmVzcG9uc2UpID0+IHtcbiAgICAgICAgaWYgKChyZXNwb25zZT8uc3RhdHVzID09PSA0MTkgfHwgcmVzcG9uc2U/LnN0YXR1cyA9PT0gNDAxIHx8IHJlc3BvbnNlPy5zdGF0dXMgPT09IDQwMykgJiYgIXJldHJpZWQpIHtcbiAgICAgICAgICAgIGNsZWFyUGFuZWxDc3JmKCk7XG4gICAgICAgICAgICByZWZyZXNoUGFuZWxDc3JmKG5ld0NzcmYgPT4gYXR0ZW1wdChuZXdDc3JmLCB0cnVlKSwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIG9wZW5QYW5lbEluQmFja2dyb3VuZCgpO1xuICAgICAgICAgICAgICAgIG9uRXJyb3IobmV3IEVycm9yKCdQYW5lbDog0LDQstGC0L7RgNC40LfQsNGG0LjRjyDQuNGB0YLQtdC60LvQsC4g0JLQvtC50LTQuNGC0LUg0LIgcGFuZWwuaGF0aWtvLnJ1LicpKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIG9uRXJyb3IoZXJyb3IpO1xuICAgIH0pO1xuICAgIGVuc3VyZVBhbmVsQ3NyZihjc3JmID0+IGF0dGVtcHQoY3NyZiwgZmFsc2UpLCBvbkVycm9yKTtcbn1cblxuLy8g4pSA4pSA4pSAINCS0YHQv9C+0LzQvtCz0LDRgtC10LvRjNC90YvQtSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGZldGNoU2VydmVyRGF0YSh1cmwsIG9uU3VjY2Vzcywgb25FcnJvcikge1xuICAgIGRlYnVnTG9nKCdyZXF1ZXN0JywgJ0dFVCcsIHVybCk7XG4gICAgR01feG1saHR0cFJlcXVlc3Qoe1xuICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICB1cmwsXG4gICAgICAgIG9ubG9hZDogIHIgPT4ge1xuICAgICAgICAgICAgZGVidWdMb2coJ3Jlc3BvbnNlJywgci5zdGF0dXMsIHVybCk7XG4gICAgICAgICAgICByLnN0YXR1cyA9PT0gMjAwID8gb25TdWNjZXNzKHIpIDogb25FcnJvcihg0J7RiNC40LHQutCwOiAke3Iuc3RhdHVzVGV4dH1gKTtcbiAgICAgICAgfSxcbiAgICAgICAgb25lcnJvcjogZSA9PiB7XG4gICAgICAgICAgICBkZWJ1Z0Vycm9yKCdyZXF1ZXN0JywgdXJsLCBlKTtcbiAgICAgICAgICAgIG9uRXJyb3IoYNCe0YjQuNCx0LrQsCDQt9Cw0L/RgNC+0YHQsDogJHtlfWApO1xuICAgICAgICB9XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGFwcGx5UnVsZShjYXNoLCBydWxlKSB7XG4gICAgaWYgKHJ1bGUuaXNDYXNoYmFjaykgcmV0dXJuIE1hdGgucm91bmQoY2FzaCAqIHJ1bGUucGVyY2VudCAvIDEwMCk7XG4gICAgY29uc3Qgcm91bmRlZCA9IE1hdGgucm91bmQoY2FzaCAqIHJ1bGUucGVyY2VudCAvIDEwMCAvIHJ1bGUucm91bmQpICogcnVsZS5yb3VuZDtcbiAgICByZXR1cm4gcm91bmRlZCArIChydWxlLmV4dHJhIHx8IDApO1xufVxuXG4iLCIvLyDilIDilIDilIAgYWRkVG9DaGF0SGlzdG9yeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIHNlbmRlcjogdXNlciB8IGJvdCB8IHN5c3RlbTsgcXVlcnkg4oCUINGC0LXQutGB0YIg0LfQsNC/0YDQvtGB0LAgKNC00LvRjyDQutC90L7Qv9C60LggwqvQv9C+0LLRgtC+0YDQuNGC0YzCuykuXG5mdW5jdGlvbiBhZGRUb0NoYXRIaXN0b3J5KHNlbmRlciwgbWVzc2FnZSwgZW1vamkgPSAnJywgcXVlcnkpIHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCdydS1SVScsIHsgaG91cjogJzItZGlnaXQnLCBtaW51dGU6ICcyLWRpZ2l0JyB9KTtcbiAgICBjb25zdCBlbnRyeSA9IHsgc2VuZGVyLCBtZXNzYWdlLCBlbW9qaSwgdGltZXN0YW1wOiB0cywgYWN0aW9uOiBjdXJyZW50QWN0aW9uLCBxdWVyeTogcXVlcnkgfHwgJycgfTtcbiAgICBjb25zdCBoaXN0b3J5ID0gaGlzdG9yeUZvcihjdXJyZW50QWN0aW9uKTtcbiAgICBoaXN0b3J5LnB1c2goZW50cnkpO1xuICAgIGlmIChoaXN0b3J5Lmxlbmd0aCA+IDEwMCkgaGlzdG9yeS5zcGxpY2UoMCwgaGlzdG9yeS5sZW5ndGggLSAxMDApOyAvLyDQu9C40LzQuNGCINC90LAg0LLQutC70LDQtNC60YNcbiAgICBpZiAod2luZG93LnByaWNlQ2hlY2tDb250YWluZXIpIHJlbmRlckNoYXQoKTtcbiAgICBzYXZlQ2hhdEhpc3RvcnkoKTsgLy8g0L/QtdGA0YHQuNGB0YIgKNC60YDQvtC80LUg0LLQutC70LDQtNC60LggwqvQkdC+0L3Rg9GB0YvCuyDigJQg0J/QlNC9KVxuICAgIGlmIChzZW5kZXIgPT09ICd1c2VyJyAmJiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJUZXh0Q2hlY2tib3gnKT8uY2hlY2tlZCkge1xuICAgICAgICBjb25zdCBtcyA9IGNsZWFyVGV4dERlbGF5O1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHsgY29uc3QgaW5wID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpOyBpZiAoaW5wKSBpbnAudmFsdWUgPSAnJzsgfSwgbXMpO1xuICAgIH1cbn1cblxuLy8g4pSA4pSA4pSAINCg0LXQvdC00LXRgCDQu9C10L3RgtGLINCw0LrRgtC40LLQvdC+0Lkg0LLQutC70LDQtNC60Lgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiByZW5kZXJDaGF0KCkge1xuICAgIGNvbnN0IGxvZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0NoYXRMb2cnKTtcbiAgICBpZiAoIWxvZykgcmV0dXJuO1xuICAgIGxvZy5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBjb25zdCBlbnRyaWVzID0gY2hhdEhpc3RvcnlCeUFjdGlvbltjdXJyZW50QWN0aW9uXSB8fCBbXTtcbiAgICBlbnRyaWVzLmZvckVhY2goZW50cnkgPT4gbG9nLmFwcGVuZENoaWxkKHJlbmRlck1lc3NhZ2VCdWJibGUoZW50cnkpKSk7XG4gICAgbG9nLnNjcm9sbFRvcCA9IGxvZy5zY3JvbGxIZWlnaHQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlck1lc3NhZ2VCdWJibGUoZW50cnkpIHtcbiAgICBjb25zdCBidWJibGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBidWJibGUuY2xhc3NOYW1lID0gYG1jLW1zZyBtYy1tc2ctJHtlbnRyeS5zZW5kZXJ9YDtcblxuICAgIGlmIChlbnRyeS5zZW5kZXIgPT09ICdzeXN0ZW0nKSB7XG4gICAgICAgIGJ1YmJsZS50ZXh0Q29udGVudCA9IGAke2VudHJ5LmVtb2ppID8gZW50cnkuZW1vamkgKyAnICcgOiAnJ30ke2VudHJ5Lm1lc3NhZ2V9YDtcbiAgICAgICAgcmV0dXJuIGJ1YmJsZTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbWV0YS5jbGFzc05hbWUgPSAnbWMtbXNnLW1ldGEnO1xuICAgIG1ldGEudGV4dENvbnRlbnQgPSBgJHtlbnRyeS5lbW9qaSA/IGVudHJ5LmVtb2ppICsgJyAnIDogJyd9JHtlbnRyeS50aW1lc3RhbXB9YDtcbiAgICBidWJibGUuYXBwZW5kQ2hpbGQobWV0YSk7XG5cbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm9keS5jbGFzc05hbWUgPSAnbWMtbXNnLWJvZHknO1xuICAgIGJvZHkudGV4dENvbnRlbnQgPSBlbnRyeS5tZXNzYWdlOyAgICAgIC8vIHRleHRDb250ZW50IOKAlCDQt9Cw0YnQuNGC0LAg0L7RgiBIVE1MXG4gICAgYnViYmxlLmFwcGVuZENoaWxkKGJvZHkpO1xuXG4gICAgaWYgKGVudHJ5LnNlbmRlciA9PT0gJ2JvdCcpIHtcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBhY3Rpb25zLmNsYXNzTmFtZSA9ICdtYy1tc2ctYWN0aW9ucyc7XG5cbiAgICAgICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBjb3B5LnR5cGUgPSAnYnV0dG9uJztcbiAgICAgICAgY29weS5jbGFzc05hbWUgPSAnbWMtY29weS1idG4nO1xuICAgICAgICBjb3B5LmRhdGFzZXQuY29weSA9IGVudHJ5Lm1lc3NhZ2U7IC8vINGC0LXQutGB0YIg0LTQu9GPINC60L7Qv9C40YDQvtCy0LDQvdC40Y9cbiAgICAgICAgY29weS5kYXRhc2V0LnRpcCA9ICfwn5OLINCa0L7Qv9C40YDQvtCy0LDRgtGMJztcbiAgICAgICAgY29weS50ZXh0Q29udGVudCA9ICfwn5OLJztcbiAgICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb3B5KTtcblxuICAgICAgICAvLyDQn9C+0LLRgtC+0YDQuNGC0Ywg0LfQsNC/0YDQvtGBICjQtdGB0LvQuCDQuNC30LLQtdGB0YLQtdC9INC40YHRhdC+0LTQvdGL0Lkg0LfQsNC/0YDQvtGBINC4INGN0YLQviDRgNC10LbQuNC80L3QsNGPINCy0LrQu9Cw0LTQutCwKVxuICAgICAgICBpZiAoZW50cnkuYWN0aW9uICYmIE1PREVfQUNUSU9OUy5pbmNsdWRlcyhlbnRyeS5hY3Rpb24pICYmIGVudHJ5LnF1ZXJ5KSB7XG4gICAgICAgICAgICBjb25zdCByZXRyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICAgICAgcmV0cnkudHlwZSA9ICdidXR0b24nO1xuICAgICAgICAgICAgcmV0cnkuY2xhc3NOYW1lID0gJ21jLXJldHJ5LWJ0bic7XG4gICAgICAgICAgICByZXRyeS5kYXRhc2V0LnRpcCA9ICfwn5SBINCf0L7QstGC0L7RgNC40YLRjCDQt9Cw0L/RgNC+0YEnO1xuICAgICAgICAgICAgcmV0cnkudGV4dENvbnRlbnQgPSAn8J+UgSc7XG4gICAgICAgICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHJldHJ5KTtcbiAgICAgICAgfVxuICAgICAgICBidWJibGUuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gICAgfVxuICAgIHJldHVybiBidWJibGU7XG59XG5cbi8vINCU0LXQu9C10LPQuNGA0L7QstCw0L3QvdGL0Lkg0LrQu9C40Log0L/QviDQutC90L7Qv9C60LDQvCDCq9Ca0L7Qv9C40YDQvtCy0LDRgtGMwrsgLyDCq9Cf0L7QstGC0L7RgNC40YLRjMK7INCyINC70LXQvdGC0LUuXG5mdW5jdGlvbiByZW1vdmVSZXRyeUVudHJ5KGVudHJ5KSB7XG4gICAgY29uc3QgaGlzdG9yeSA9IGNoYXRIaXN0b3J5QnlBY3Rpb25bY3VycmVudEFjdGlvbl0gfHwgW107XG4gICAgY29uc3QgaW5kZXggPSBoaXN0b3J5LmluZGV4T2YoZW50cnkpO1xuICAgIGlmIChpbmRleCA8IDApIHJldHVybjtcblxuICAgIC8vINCSINGA0LXQttC40LzQtSDQt9Cw0LzQtdC90Ysg0YPQsdC40YDQsNC10Lwg0L7RgtCy0LXRgiDQuCDQtdCz0L4g0LjRgdGF0L7QtNC90YvQuSDQt9Cw0L/RgNC+0YEsINGH0YLQvtCx0Ysg0L3QvtCy0YvQuSDQt9Cw0L/Rg9GB0LpcbiAgICAvLyDQvdC1INC+0YHRgtCw0LLQu9GP0Lsg0LIg0LvQtdC90YLQtSDQu9C40YjQvdGO0Y4g0L/QsNGA0YMgdXNlci9ib3QuXG4gICAgaGlzdG9yeS5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIGNvbnN0IHByZXZpb3VzID0gaGlzdG9yeVtpbmRleCAtIDFdO1xuICAgIGlmIChwcmV2aW91cz8uc2VuZGVyID09PSAndXNlcicgJiYgcHJldmlvdXMubWVzc2FnZSA9PT0gZW50cnkucXVlcnkpIGhpc3Rvcnkuc3BsaWNlKGluZGV4IC0gMSwgMSk7XG4gICAgcmVuZGVyQ2hhdCgpO1xuICAgIHNhdmVDaGF0SGlzdG9yeSgpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVDaGF0TG9nQ2xpY2soZXZlbnQpIHtcbiAgICBjb25zdCBjb3B5QnRuID0gZXZlbnQudGFyZ2V0LmNsb3Nlc3QoJy5tYy1jb3B5LWJ0bicpO1xuICAgIGlmIChjb3B5QnRuKSB7XG4gICAgICAgIGNvcHlIYXRpa29UZXh0KGNvcHlCdG4uZGF0YXNldC5jb3B5IHx8ICcnKTtcbiAgICAgICAgY29weUJ0bi50ZXh0Q29udGVudCA9ICfinIUnO1xuICAgICAgICBjb3B5QnRuLmNsYXNzTGlzdC5hZGQoJ21jLWNvcHktZG9uZScpO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIGNvcHlCdG4udGV4dENvbnRlbnQgPSAn8J+Tiyc7XG4gICAgICAgICAgICBjb3B5QnRuLmNsYXNzTGlzdC5yZW1vdmUoJ21jLWNvcHktZG9uZScpO1xuICAgICAgICB9LCAxMjAwKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJldHJ5QnRuID0gZXZlbnQudGFyZ2V0LmNsb3Nlc3QoJy5tYy1yZXRyeS1idG4nKTtcbiAgICBpZiAoIXJldHJ5QnRuKSByZXR1cm47XG4gICAgY29uc3QgYnViYmxlID0gcmV0cnlCdG4uY2xvc2VzdCgnLm1jLW1zZycpO1xuICAgIGNvbnN0IGluZGV4ID0gQXJyYXkuZnJvbShidWJibGUucGFyZW50Tm9kZS5jaGlsZHJlbikuaW5kZXhPZihidWJibGUpO1xuICAgIGNvbnN0IGVudHJ5ID0gKGNoYXRIaXN0b3J5QnlBY3Rpb25bY3VycmVudEFjdGlvbl0gfHwgW10pW2luZGV4XTtcbiAgICBpZiAoIWVudHJ5KSByZXR1cm47XG5cbiAgICByZXRyeUJ0bi50ZXh0Q29udGVudCA9ICfinIUnO1xuICAgIHJldHJ5QnRuLmNsYXNzTGlzdC5hZGQoJ21jLWNvcHktZG9uZScpO1xuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZXRyeUJ0bi50ZXh0Q29udGVudCA9ICfwn5SBJztcbiAgICAgICAgcmV0cnlCdG4uY2xhc3NMaXN0LnJlbW92ZSgnbWMtY29weS1kb25lJyk7XG4gICAgfSwgMTIwMCk7XG5cbiAgICAvLyDQn9C+0LLRgtC+0YDRj9C10Lwg0YLQvtGCINC20LUg0LfQsNC/0YDQvtGBINCyINGC0L7QuSDQttC1INCy0LrQu9Cw0LTQutC1LlxuICAgIGlmIChjdXJyZW50QWN0aW9uICE9PSBlbnRyeS5hY3Rpb24pIHNlbGVjdFRhYihlbnRyeS5hY3Rpb24pO1xuICAgIGlmIChyZXRyeUJlaGF2aW9yID09PSAncmVwbGFjZScpIHJlbW92ZVJldHJ5RW50cnkoZW50cnkpO1xuICAgIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpO1xuICAgIGlmIChpbnB1dCkgaW5wdXQudmFsdWUgPSBlbnRyeS5xdWVyeTtcbiAgICBleGVjdXRlQ3VycmVudEFjdGlvbigpO1xufVxuXG5mdW5jdGlvbiBjbGVhckNoYXQoKSB7XG4gICAgLy8g0J7Rh9C40YnQsNC10YIg0YLQvtC70YzQutC+INC40YHRgtC+0YDQuNGOINCw0LrRgtC40LLQvdC+0Lkg0LLQutC70LDQtNC60LhcbiAgICBpZiAoY3VycmVudEFjdGlvbikgZGVsZXRlIGNoYXRIaXN0b3J5QnlBY3Rpb25bY3VycmVudEFjdGlvbl07XG4gICAgcmVuZGVyQ2hhdCgpO1xuICAgIHNhdmVDaGF0SGlzdG9yeSgpO1xufVxuXG5mdW5jdGlvbiBjbGVhclJlc3VsdEZvck5ld1JlcXVlc3QoKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb0xpbmtzUGFuZWwnKT8ucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb0xpbmtzUGFuZWwnKT8uc3R5bGUuc2V0UHJvcGVydHkoJ2Rpc3BsYXknLCAnbm9uZScpO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYXRpa29SZW9wZW5QaWNrZXJCdXR0b24nKT8uc3R5bGUuc2V0UHJvcGVydHkoJ2Rpc3BsYXknLCAnbm9uZScpO1xufSIsIi8vIOKUgOKUgOKUgCBIQVRJS08g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog0J/QsNGA0YHQuNGCINGB0YLRgNCw0L3QuNGG0YMg0L/QvtC40YHQutCwIEhhdGlrby5cbiAqINCS0L7Qt9Cy0YDQsNGJ0LDQtdGCOiB7IHRpdGxlLCBhcnRpY2xlTm8sIHByaWNlLCBwcm9kdWN0VXJsIH1cbiAqL1xuZnVuY3Rpb24gcGFyc2VTZWFyY2hQYWdlKGh0bWwsIGJhc2VVcmwpIHtcbiAgICBjb25zdCBwYXJzZXIgPSBuZXcgRE9NUGFyc2VyKCk7XG4gICAgY29uc3QgZG9jID0gcGFyc2VyLnBhcnNlRnJvbVN0cmluZyhodG1sLCAndGV4dC9odG1sJyk7XG5cbiAgICBjb25zdCBwcm9kdWN0ID0gZG9jLnF1ZXJ5U2VsZWN0b3IoJ2Eucy1wcm9kdWN0LWhlYWRlcicpO1xuICAgIGlmICghcHJvZHVjdCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCB0aXRsZSAgICAgICAgPSAocHJvZHVjdC5nZXRBdHRyaWJ1dGUoJ3RpdGxlJykgfHwgcHJvZHVjdC50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpO1xuICAgIGNvbnN0IHJlbGF0aXZlTGluayA9IHByb2R1Y3QuZ2V0QXR0cmlidXRlKCdocmVmJykgfHwgJyc7XG5cbiAgICAvLyDQn9GD0YLRjCDRgtC+0LLQsNGA0LAg4oCUINC+0LTQuNC9INC4INGC0L7RgiDQttC1INC00LvRjyDQstGB0LXRhSDQs9C+0YDQvtC00L7Qsiwg0YLQvtC70YzQutC+INC00L7QvNC10L0g0LzQtdC90Y/QtdGC0YHRj1xuICAgIGNvbnN0IHBhdGhuYW1lICAgPSByZWxhdGl2ZUxpbmsgPyBuZXcgVVJMKHJlbGF0aXZlTGluaywgYmFzZVVybCkucGF0aG5hbWUgOiAnJztcbiAgICBjb25zdCBwcm9kdWN0VXJsID0gcGF0aG5hbWUgPyBgJHtiYXNlVXJsfSR7cGF0aG5hbWV9YCA6IGJhc2VVcmw7XG5cbiAgICAvLyDQptC10L3QsDog0LjRidC10Lwgc3Bhbi5wcmljZS13cmFwcGVyIHNwYW4ucHJpY2Ug0LjQu9C4INC/0YDQvtGB0YLQviBzcGFuLnByaWNlXG4gICAgY29uc3QgcHJpY2VFbCA9IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnByaWNlLXdyYXBwZXIgc3Bhbi5wcmljZScpXG4gICAgICAgICAgICAgICAgIHx8IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnByaWNlJyk7XG4gICAgY29uc3QgcHJpY2UgICA9IHByaWNlRWxcbiAgICAgICAgPyBwcmljZUVsLnRleHRDb250ZW50LnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCkgKyAnIOKCvSdcbiAgICAgICAgOiAn4oCUJztcblxuICAgIHJldHVybiB7IHRpdGxlLCBwcmljZSwgcHJvZHVjdFVybCwgcGF0aG5hbWUgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VTZWFyY2hSZXN1bHRzKGh0bWwsIGJhc2VVcmwpIHtcbiAgICBjb25zdCBwYXJzZXIgPSBuZXcgRE9NUGFyc2VyKCk7XG4gICAgY29uc3QgZG9jID0gcGFyc2VyLnBhcnNlRnJvbVN0cmluZyhodG1sLCAndGV4dC9odG1sJyk7XG4gICAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0KCk7XG5cbiAgICBkb2MucXVlcnlTZWxlY3RvckFsbCgnYS5zLXByb2R1Y3QtaGVhZGVyJykuZm9yRWFjaChwcm9kdWN0ID0+IHtcbiAgICAgICAgY29uc3QgcmVsYXRpdmVMaW5rID0gcHJvZHVjdC5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSB8fCAnJztcbiAgICAgICAgaWYgKCFyZWxhdGl2ZUxpbmspIHJldHVybjtcblxuICAgICAgICBjb25zdCBwYXRobmFtZSA9IG5ldyBVUkwocmVsYXRpdmVMaW5rLCBiYXNlVXJsKS5wYXRobmFtZTtcbiAgICAgICAgaWYgKCFwYXRobmFtZSB8fCBzZWVuLmhhcyhwYXRobmFtZSkpIHJldHVybjtcbiAgICAgICAgc2Vlbi5hZGQocGF0aG5hbWUpO1xuXG4gICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgICB0aXRsZTogKHByb2R1Y3QuZ2V0QXR0cmlidXRlKCd0aXRsZScpIHx8IHByb2R1Y3QudGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKSxcbiAgICAgICAgICAgIHBhdGhuYW1lXG4gICAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHJvZHVjdFByaWNlKGh0bWwpIHtcbiAgICBjb25zdCBwYXJzZXIgPSBuZXcgRE9NUGFyc2VyKCk7XG4gICAgY29uc3QgZG9jID0gcGFyc2VyLnBhcnNlRnJvbVN0cmluZyhodG1sLCAndGV4dC9odG1sJyk7XG4gICAgY29uc3QgcHJpY2VFbCA9IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnMtcHJpY2Ugc3Bhbi5wcmljZS13cmFwcGVyIHNwYW4ucHJpY2UnKVxuICAgICAgICAgICAgICAgICB8fCBkb2MucXVlcnlTZWxlY3RvcignLnMtcHJpY2Ugc3Bhbi5wcmljZScpXG4gICAgICAgICAgICAgICAgIHx8IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnByaWNlLXdyYXBwZXIgc3Bhbi5wcmljZScpO1xuICAgIGlmICghcHJpY2VFbCkgcmV0dXJuICfigJQnO1xuICAgIGNvbnN0IHZhbHVlID0gcHJpY2VFbC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXHMrL2csICcgJykudHJpbSgpO1xuICAgIHJldHVybiB2YWx1ZSA/IGAke3ZhbHVlfSDigr1gIDogJ+KAlCc7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEhhdGlrb1Jlc3VsdCh0aXRsZSwgcHJpY2VzLCBwYXRobmFtZSkge1xuICAgIGN1cnJlbnRIYXRpa29QYXRobmFtZSA9IHBhdGhuYW1lO1xuICAgIGNvbnN0IGxpbmVzID0gW2Dwn6etICR7dGl0bGV9YCwgJyddO1xuICAgIEJBU0VfVVJMUy5mb3JFYWNoKChiYXNlVXJsLCBpKSA9PiB7XG4gICAgICAgIGxpbmVzLnB1c2goYPCfqpkke0NJVFlfSUNPTlNbaV19ICR7cHJpY2VzW2ldIHx8ICfigJQnfWApO1xuICAgIH0pO1xuICAgIHVwZGF0ZUhhdGlrb0xpbmtzUGFuZWwocGF0aG5hbWUpO1xuICAgIGxpbmVzLnB1c2goJycsICfQodC80L7QttC10Lw/INCQ0LrRgtGD0LDQu9GM0L3QsNGPINGG0LXQvdCwPycpO1xuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuXG4vKipcbiAqINCf0LDRgNGB0LjRgiDRgdGC0YDQsNC90LjRhtGDINCa0JDQoNCi0J7Qp9Ca0Jgg0YLQvtCy0LDRgNCwINC00LvRjyDQv9C+0LvRg9GH0LXQvdC40Y8g0YHRgtCw0YLRg9GB0LAg0L3QsNC70LjRh9C40Y8uXG4gKiDQktC+0LfQstGA0LDRidCw0LXRgiDRgdGC0YDQvtC60YMg0YHRgtCw0YLRg9GB0LAuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlUHJvZHVjdFBhZ2UoaHRtbCkge1xuICAgIGNvbnN0IHBhcnNlciA9IG5ldyBET01QYXJzZXIoKTtcbiAgICBjb25zdCBkb2MgPSBwYXJzZXIucGFyc2VGcm9tU3RyaW5nKGh0bWwsICd0ZXh0L2h0bWwnKTtcblxuICAgIC8vINCh0YLQsNGC0YPRgTogc3RvY2staGlnaCwgc3RvY2stbG93LCBzdG9jay1ub25lINC40LvQuCDQsNC90LDQu9C+0LPQuFxuICAgIGNvbnN0IHN0b2NrSGlnaCA9IGRvYy5xdWVyeVNlbGVjdG9yKCcuc3RvY2staGlnaCcpO1xuICAgIGNvbnN0IHN0b2NrTG93ICA9IGRvYy5xdWVyeVNlbGVjdG9yKCcuc3RvY2stbG93Jyk7XG4gICAgY29uc3Qgc3RvY2tOb25lID0gZG9jLnF1ZXJ5U2VsZWN0b3IoJy5zdG9jay1ub25lLCAuc3RvY2stb3V0Jyk7XG5cbiAgICBpZiAoc3RvY2tIaWdoKSByZXR1cm4gJ/Cfn6IgJyArIHN0b2NrSGlnaC50ZXh0Q29udGVudC50cmltKCk7XG4gICAgaWYgKHN0b2NrTG93KSAgcmV0dXJuICfwn5+hICcgKyBzdG9ja0xvdy50ZXh0Q29udGVudC50cmltKCk7XG4gICAgaWYgKHN0b2NrTm9uZSkgcmV0dXJuICfwn5S0ICcgKyBzdG9ja05vbmUudGV4dENvbnRlbnQudHJpbSgpO1xuXG4gICAgLy8g0JfQsNC/0LDRgdC90YvQtSDQstCw0YDQuNCw0L3RgtGLXG4gICAgY29uc3Qgc3RvY2tFbCA9IGRvYy5xdWVyeVNlbGVjdG9yKCdbY2xhc3MqPVwic3RvY2tcIl0sIFtjbGFzcyo9XCJhdmFpbGFiaWxpdHlcIl0sIFtjbGFzcyo9XCLQvdCw0LvQuNGH0LhcIl0nKTtcbiAgICBpZiAoc3RvY2tFbCkgcmV0dXJuICfwn5OmICcgKyBzdG9ja0VsLnRleHRDb250ZW50LnRyaW0oKTtcblxuICAgIHJldHVybiAn4p2TINCh0YLQsNGC0YPRgSDQvdC10LjQt9Cy0LXRgdGC0LXQvSc7XG59XG5cbmZ1bmN0aW9uIGNoZWNrSGF0aWtvKCkge1xuICAgIGNvbnN0IHF1ZXJ5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpLnZhbHVlLnRyaW0oKTtcbiAgICBpZiAoIXF1ZXJ5KSByZXR1cm47XG4gICAgY29uc3QgcmVxdWVzdElkID0gKythY3RpdmVSZXF1ZXN0SWQ7XG4gICAgY2xlYXJSZXN1bHRGb3JOZXdSZXF1ZXN0KCk7XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgndXNlcicsIHF1ZXJ5LCAn8J+QtiBIYXRpa28nKTtcbiAgICBpZiAoaGF0aWtvU2VhcmNoTW9kZSA9PT0gJ3BhbmVsJyB8fCAoaGF0aWtvU2VhcmNoTW9kZSA9PT0gJ2F1dG8nICYmIC9eXFxkKyQvLnRlc3QocXVlcnkpKSkge1xuICAgICAgICB1cGRhdGVIYXRpa29TdGF0dXMoJ9Cf0YDQvtCy0LXRgNGP0Y4gUGFuZWwgSGF0aWtv4oCmJyk7XG4gICAgICAgIHBhbmVsU2VhcmNoKHF1ZXJ5LCBkYXRhID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBmb3JtYXRQYW5lbFNlYXJjaFJlc3VsdChkYXRhKTtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCdQYW5lbDog0LPQvtGC0L7QstC+Jyk7XG4gICAgICAgICAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgbWVzc2FnZSwgJ/Cfj6ogUGFuZWwnLCBxdWVyeSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGhhdGlrb1NlYXJjaE1vZGUgPT09ICdhdXRvJykge1xuICAgICAgICAgICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cygnUGFuZWwg0L3QtSDQvdCw0YjRkdC7LCDQv9C10YDQtdC60LvRjtGH0LDRjtGB0Ywg0L3QsCBIYXRpa2/igKYnKTtcbiAgICAgICAgICAgICAgICBjaGVja0hhdGlrb1dlYnNpdGUocXVlcnksIHJlcXVlc3RJZCk7XG4gICAgICAgICAgICB9IGVsc2UgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ1BhbmVsOiDRgtC+0LLQsNGAINC90LUg0L3QsNC50LTQtdC9JywgJ/Cfj6ogUGFuZWwnLCBxdWVyeSk7XG4gICAgICAgIH0sIGVycm9yID0+IHtcbiAgICAgICAgICAgIGlmIChoYXRpa29TZWFyY2hNb2RlID09PSAnYXV0bycpIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVIYXRpa29TdGF0dXMoJ1BhbmVsINC90LXQtNC+0YHRgtGD0L/QvdCwLCDQv9C10YDQtdC60LvRjtGH0LDRjtGB0Ywg0L3QsCBIYXRpa2/igKYnKTtcbiAgICAgICAgICAgICAgICBjaGVja0hhdGlrb1dlYnNpdGUocXVlcnksIHJlcXVlc3RJZCk7XG4gICAgICAgICAgICB9IGVsc2UgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgZXJyb3IubWVzc2FnZSwgJ/Cfj6ogUGFuZWwnLCBxdWVyeSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNoZWNrSGF0aWtvV2Vic2l0ZShxdWVyeSwgcmVxdWVzdElkKTtcbn1cblxuZnVuY3Rpb24gY2hlY2tIYXRpa29XZWJzaXRlKHF1ZXJ5LCByZXF1ZXN0SWQpIHtcbiAgICB1cGRhdGVIYXRpa29TdGF0dXMoJ9CY0YnRgyDRgtC+0LLQsNGA0Ysg0L3QsCDRgdCw0LnRgtCw0YUgSGF0aWtv4oCmJyk7XG4gICAgY29uc3Qgc2VhcmNoZXMgPSBCQVNFX1VSTFMubWFwKGJhc2VVcmwgPT4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCBzZWFyY2hVcmwgPSBgJHtiYXNlVXJsfS9zZWFyY2gvP3F1ZXJ5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KX1gO1xuICAgICAgICBmZXRjaFNlcnZlckRhdGEoc2VhcmNoVXJsLCByZXNwb25zZSA9PiByZXNvbHZlKHsgYmFzZVVybCwgcmVzcG9uc2UgfSksIHJlamVjdCk7XG4gICAgfSkpO1xuICAgIFByb21pc2UuYWxsU2V0dGxlZChzZWFyY2hlcykudGhlbihvdXRjb21lcyA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0SWQgIT09IGFjdGl2ZVJlcXVlc3RJZCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBwcm9kdWN0c0J5UGF0aCA9IG5ldyBNYXAoKTtcbiAgICAgICAgY29uc3QgZXJyb3JzID0gW107XG4gICAgICAgIG91dGNvbWVzLmZvckVhY2gob3V0Y29tZSA9PiB7XG4gICAgICAgICAgICBpZiAob3V0Y29tZS5zdGF0dXMgPT09ICdyZWplY3RlZCcpIHtcbiAgICAgICAgICAgICAgICBlcnJvcnMucHVzaChvdXRjb21lLnJlYXNvbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgeyBiYXNlVXJsLCByZXNwb25zZSB9ID0gb3V0Y29tZS52YWx1ZTtcbiAgICAgICAgICAgIHBhcnNlU2VhcmNoUmVzdWx0cyhyZXNwb25zZS5yZXNwb25zZVRleHQsIGJhc2VVcmwpLmZvckVhY2gocHJvZHVjdCA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFwcm9kdWN0c0J5UGF0aC5oYXMocHJvZHVjdC5wYXRobmFtZSkpIHByb2R1Y3RzQnlQYXRoLnNldChwcm9kdWN0LnBhdGhuYW1lLCBwcm9kdWN0KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgcHJvZHVjdHMgPSBbLi4ucHJvZHVjdHNCeVBhdGgudmFsdWVzKCldO1xuICAgICAgICBpZiAoIXByb2R1Y3RzLmxlbmd0aCkge1xuICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKGVycm9ycy5sZW5ndGggPT09IEJBU0VfVVJMUy5sZW5ndGggPyAn0J7RiNC40LHQutCwINC/0L7QuNGB0LrQsCcgOiAn0KLQvtCy0LDRgNGLINC90LUg0L3QsNC50LTQtdC90YsnKTtcbiAgICAgICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIGVycm9ycy5sZW5ndGggPT09IEJBU0VfVVJMUy5sZW5ndGhcbiAgICAgICAgICAgICAgICA/ICfQndC1INGD0LTQsNC70L7RgdGMINCy0YvQv9C+0LvQvdC40YLRjCDQv9C+0LjRgdC6INC90LAg0YHQsNC50YLQsNGFIEhhdGlrbydcbiAgICAgICAgICAgICAgICA6ICfQotC+0LLQsNGAINC90LUg0L3QsNC50LTQtdC9JywgJ/CfkLYgSGF0aWtvJywgcXVlcnkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cyhg0J3QsNC50LTQtdC90L4g0YLQvtCy0LDRgNC+0LI6ICR7cHJvZHVjdHMubGVuZ3RofS4g0J/QvtC70YPRh9Cw0Y4g0YbQtdC90YvigKZgKTtcbiAgICAgICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShwcm9kdWN0cy5sZW5ndGgpO1xuICAgICAgICBsZXQgY29tcGxldGVkID0gMDtcbiAgICAgICAgcHJvZHVjdHMuZm9yRWFjaCgocHJvZHVjdCwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgIGNoZWNrSGF0aWtvUHJvZHVjdChwcm9kdWN0LCByZXN1bHQgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0SWQgIT09IGFjdGl2ZVJlcXVlc3RJZCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIHJlc3VsdHNbaW5kZXhdID0gcmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbXBsZXRlZCsrO1xuICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQgIT09IHByb2R1Y3RzLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGxhc3RIYXRpa29SZXN1bHRzID0gcmVzdWx0cztcbiAgICAgICAgICAgICAgICBsYXN0SGF0aWtvUXVlcnkgPSBxdWVyeTtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQk9C+0YLQvtCy0L4nKTtcbiAgICAgICAgICAgICAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgcmVzdWx0c1swXS5tZXNzYWdlLCAn8J+QtiBIYXRpa28nLCBxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKGDQk9C+0YLQvtCy0L46ICR7cmVzdWx0cy5sZW5ndGh9INGC0L7QstCw0YDQsC4g0JzQvtC20L3QviDQstGL0LHRgNCw0YLRjCDQtNGA0YPQs9C+0LkuYCk7XG4gICAgICAgICAgICAgICAgICAgIG9wZW5IYXRpa29Qcm9kdWN0UGlja2VyKHJlc3VsdHMsIHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdElkICE9PSBhY3RpdmVSZXF1ZXN0SWQpIHJldHVybjtcbiAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQntGI0LjQsdC60LAg0L/QvtC40YHQutCwJyk7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsICfQntGI0LjQsdC60LAg0L/QvtC40YHQutCwOiAnICsgZXJyb3IsICfwn5C2IEhhdGlrbycsIHF1ZXJ5KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0UGFuZWxTZWFyY2hSZXN1bHQoZGF0YSkge1xuICAgIGNvbnN0IHByb2R1Y3RzID0gZGF0YT8ucmVzdWx0cyB8fCBbXTtcbiAgICBpZiAoIXByb2R1Y3RzLmxlbmd0aCkgcmV0dXJuICcnO1xuICAgIHJldHVybiBwcm9kdWN0cy5tYXAocHJvZHVjdCA9PiBbXG4gICAgICAgIGDQkNGA0YLQuNC60YPQuzogJHtwcm9kdWN0LmFydGljbGUgfHwgJ+KAlCd9YCxcbiAgICAgICAgcHJvZHVjdC5leHRlcm5hbF9jb2RlID8gYNCS0Jo6ICR7cHJvZHVjdC5leHRlcm5hbF9jb2RlfWAgOiBudWxsLFxuICAgICAgICBwcm9kdWN0Lm5hbWUgfHwgJ+KAlCcsXG4gICAgICAgIGDQodGC0LDRgtGD0YE6ICR7cHJvZHVjdC5zdGF0dXMgfHwgJ+KAlCd9YCxcbiAgICAgICAgYNCd0LDQu9C40YfQuNC1OiAke3Byb2R1Y3QudG90YWxfc3RvY2sgPiAwID8gYCR7cHJvZHVjdC50b3RhbF9zdG9ja30g0YjRgi5gIDogJ9Cd0LXRgid9YCxcbiAgICAgICAgcHJvZHVjdC5zdXBwbGllcl9kZWNpc2lvbj8uaXpfbmFsaWNoaXlhID8gYNCY0Lcg0L3QsNC70LjRh9C40Y86ICR7cHJvZHVjdC5zdXBwbGllcl9kZWNpc2lvbi5pel9uYWxpY2hpeWF9YCA6IG51bGwsXG4gICAgICAgIE9iamVjdC5lbnRyaWVzKHByb2R1Y3QucHJpY2VzIHx8IHt9KS5tYXAoKFtjaXR5LCBwcmljZV0pID0+IGAke2NpdHl9OiAke3ByaWNlID8gYCR7cHJpY2V9IOKCvWAgOiAn4oCUJ31gKS5qb2luKCcgIOKAoiAgJyksXG4gICAgICAgIHByb2R1Y3Quc3RvY2tfZm9ybWF0dGVkID8gYFxcbiR7cHJvZHVjdC5zdG9ja19mb3JtYXR0ZWR9YCA6IG51bGxcbiAgICBdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcXG4nKSkuam9pbignXFxuXFxuLS0tXFxuXFxuJyk7XG59XG5cbmZ1bmN0aW9uIGNoZWNrSGF0aWtvQm9udXNlcygpIHtcbiAgICBjb25zdCBwaG9uZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFwaG9uZSkgcmV0dXJuO1xuICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ3VzZXInLCBwaG9uZSwgJ/CfjoEg0JHQvtC90YPRgdGLJyk7XG4gICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQn9GA0L7QstC10YDRj9GOINCx0L7QvdGD0YHRiyDQsiBQYW5lbOKApicpO1xuICAgIHBhbmVsQ2hlY2tCb251c2VzKHBob25lLCBkYXRhID0+IHtcbiAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQkdC+0L3Rg9GB0Ys6INCz0L7RgtC+0LLQvicpO1xuICAgICAgICBjb25zdCBib251cyA9IGRhdGEuYm9udXMgPz8gZGF0YS5ib251c2VzID8/IGRhdGEuYWZmaWxpYXRlX2JvbnVzID8/IDA7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIFtcbiAgICAgICAgICAgIGDQotC10LvQtdGE0L7QvTogJHtkYXRhLnBob25lIHx8IHBob25lfWAsXG4gICAgICAgICAgICBg0JrQu9C40LXQvdGCOiAke2RhdGEubmFtZSB8fCBkYXRhLmN1c3RvbWVyX25hbWUgfHwgJ+KAlCd9YCxcbiAgICAgICAgICAgIGDQkdC+0L3Rg9GB0Ys6ICR7TWF0aC5yb3VuZChOdW1iZXIoYm9udXMpKX1gXG4gICAgICAgIF0uam9pbignXFxuJyksICfwn46BINCR0L7QvdGD0YHRiycsIHBob25lKTtcbiAgICB9LCBlcnJvciA9PiB7XG4gICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cygn0J7RiNC40LHQutCwINC/0YDQvtCy0LXRgNC60Lgg0LHQvtC90YPRgdC+0LInKTtcbiAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgZXJyb3IubWVzc2FnZSwgJ/CfjoEg0JHQvtC90YPRgdGLJywgcGhvbmUpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBjaGVja0hhdGlrb1Byb2R1Y3QocHJvZHVjdCwgb25Db21wbGV0ZSkge1xuICAgIGNvbnN0IHsgdGl0bGUsIHBhdGhuYW1lIH0gPSBwcm9kdWN0O1xuICAgIGN1cnJlbnRIYXRpa29QYXRobmFtZSA9IHBhdGhuYW1lO1xuICAgIGNvbnN0IHByaWNlcyA9IG5ldyBBcnJheShCQVNFX1VSTFMubGVuZ3RoKS5maWxsKCfigJQnKTtcbiAgICBsZXQgcmVxdWVzdHNDb21wbGV0ZWQgPSAwO1xuXG4gICAgQkFTRV9VUkxTLmZvckVhY2goKGJhc2VVcmwsIGlkeCkgPT4ge1xuICAgICAgICBmZXRjaFNlcnZlckRhdGEoXG4gICAgICAgICAgICBgJHtiYXNlVXJsfSR7cGF0aG5hbWV9YCxcbiAgICAgICAgICAgIHByb2R1Y3RSZXNwID0+IHtcbiAgICAgICAgICAgICAgICBwcmljZXNbaWR4XSA9IHBhcnNlUHJvZHVjdFByaWNlKHByb2R1Y3RSZXNwLnJlc3BvbnNlVGV4dCk7XG4gICAgICAgICAgICAgICAgcmVxdWVzdHNDb21wbGV0ZWQrKztcbiAgICAgICAgICAgICAgICB1cGRhdGVIYXRpa29TdGF0dXMoYNCf0L7Qu9GD0YfQsNGOINGG0LXQvdGLOiAke3JlcXVlc3RzQ29tcGxldGVkfS8ke0JBU0VfVVJMUy5sZW5ndGh9INC00LvRjyDCqyR7dGl0bGV9wrtgKTtcbiAgICAgICAgICAgICAgICBpZiAocmVxdWVzdHNDb21wbGV0ZWQgPT09IEJBU0VfVVJMUy5sZW5ndGgpIGZpbmlzaCgpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICgpID0+IHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0c0NvbXBsZXRlZCsrO1xuICAgICAgICAgICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cyhg0J/QvtC70YPRh9Cw0Y4g0YbQtdC90Ys6ICR7cmVxdWVzdHNDb21wbGV0ZWR9LyR7QkFTRV9VUkxTLmxlbmd0aH0g0LTQu9GPIMKrJHt0aXRsZX3Cu2ApO1xuICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0c0NvbXBsZXRlZCA9PT0gQkFTRV9VUkxTLmxlbmd0aCkgZmluaXNoKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICk7XG4gICAgfSk7XG5cbiAgICBmdW5jdGlvbiBmaW5pc2goKSB7XG4gICAgICAgIC8vINCV0YHQu9C4INCz0L7RgNC+0LTRgdC60L7QuSDRgdCw0LnRgiDQvdC1INC+0YLQtNCw0Lsg0L7RgtC00LXQu9GM0L3Rg9GOINGG0LXQvdGDLCDQuNGB0L/QvtC70YzQt9GD0LXQvCDRhtC10L3Rg1xuICAgICAgICAvLyDQodCw0YDQsNGC0L7QstCwOiDRgyDQs9C+0YDQvtC00L7QsiDRh9Cw0YHRgtC+INC+0LHRidC40Lkg0LrQsNGC0LDQu9C+0LMg0Lgg0L/RgNCw0LnRgS5cbiAgICAgICAgY29uc3Qgc2FyYXRvdlByaWNlID0gcHJpY2VzWzBdO1xuICAgICAgICBjb25zdCBub3JtYWxpemVkUHJpY2VzID0gc2FyYXRvdlByaWNlICE9PSAn4oCUJ1xuICAgICAgICAgICAgPyBwcmljZXMubWFwKHByaWNlID0+IHByaWNlID09PSAn4oCUJyA/IHNhcmF0b3ZQcmljZSA6IHByaWNlKVxuICAgICAgICAgICAgOiBwcmljZXM7XG4gICAgICAgIG9uQ29tcGxldGUoe1xuICAgICAgICAgICAgdGl0bGUsXG4gICAgICAgICAgICBwYXRobmFtZSxcbiAgICAgICAgICAgIHByaWNlczogbm9ybWFsaXplZFByaWNlcyxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGZvcm1hdEhhdGlrb1Jlc3VsdCh0aXRsZSwgbm9ybWFsaXplZFByaWNlcywgcGF0aG5hbWUpXG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxuXG5cblxuXG4iLCIvLyDilIDilIDilIAg0JrQsNC70YzQutGD0LvRj9GC0L7RgCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGNhbGN1bGF0ZUNyZWRpdCgpIHtcbiAgICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFpbnB1dCkgcmV0dXJuO1xuICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ3VzZXInLCBpbnB1dCwgJ/Cfp64g0JrQsNC70YzQutGD0LvRj9GC0L7RgCcpO1xuXG4gICAgY29uc3QgZG93blBheW1lbnRNYXRjaCA9IGlucHV0Lm1hdGNoKC9eXFxzKihcXGQrKD86Wy4sXVxcZCspPylcXHMqLVxccyooXFxkKyg/OlsuLF1cXGQrKT8pXFxzKiQvKTtcbiAgICBjb25zdCB0b3RhbCA9IGRvd25QYXltZW50TWF0Y2ggPyBOdW1iZXIoZG93blBheW1lbnRNYXRjaFsxXS5yZXBsYWNlKCcsJywgJy4nKSkgOiBudWxsO1xuICAgIGNvbnN0IGRvd25QYXltZW50ID0gZG93blBheW1lbnRNYXRjaCA/IE51bWJlcihkb3duUGF5bWVudE1hdGNoWzJdLnJlcGxhY2UoJywnLCAnLicpKSA6IG51bGw7XG4gICAgY29uc3QgYW1vdW50ID0gZG93blBheW1lbnRNYXRjaCA/IHRvdGFsIC0gZG93blBheW1lbnQgOiBwYXJzZUZsb2F0KGlucHV0KTtcblxuICAgIGlmIChpc05hTihhbW91bnQpIHx8IGFtb3VudCA8PSAwKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gZG93blBheW1lbnRNYXRjaFxuICAgICAgICAgICAgPyAn0J7RiNC40LHQutCwOiDQv9C10YDQstC+0L3QsNGH0LDQu9GM0L3Ri9C5INCy0LfQvdC+0YEg0LTQvtC70LbQtdC9INCx0YvRgtGMINCx0L7Qu9GM0YjQtSAwINC4INC80LXQvdGM0YjQtSDQvtCx0YnQtdC5INGB0YPQvNC80YsuJ1xuICAgICAgICAgICAgOiAn0J7RiNC40LHQutCwOiDQstCy0LXQtNC40YLQtSDQutC+0YDRgNC10LrRgtC90YPRjiDRgdGD0LzQvNGDLic7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIGVycm9yLCAn8J+nriDQmtCw0LvRjNC60YPQu9GP0YLQvtGAJywgaW5wdXQpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChkb3duUGF5bWVudE1hdGNoICYmICghTnVtYmVyLmlzRmluaXRlKHRvdGFsKSB8fCAhTnVtYmVyLmlzRmluaXRlKGRvd25QYXltZW50KSB8fCBkb3duUGF5bWVudCA8PSAwIHx8IGRvd25QYXltZW50ID49IHRvdGFsKSkge1xuICAgICAgICBhZGRUb0NoYXRIaXN0b3J5KCdib3QnLCAn0J7RiNC40LHQutCwOiDQv9C10YDQstC+0L3QsNGH0LDQu9GM0L3Ri9C5INCy0LfQvdC+0YEg0LTQvtC70LbQtdC9INCx0YvRgtGMINCx0L7Qu9GM0YjQtSAwINC4INC80LXQvdGM0YjQtSDQvtCx0YnQtdC5INGB0YPQvNC80YsuJywgJ/Cfp64g0JrQsNC70YzQutGD0LvRj9GC0L7RgCcsIGlucHV0KTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGxpbmVzID0gW107XG4gICAgaWYgKGRvd25QYXltZW50TWF0Y2gpIHtcbiAgICAgICAgbGluZXMucHVzaChg0J/QtdGA0LLQvtC90LDRh9Cw0LvRjNC90YvQuSDQstC30L3QvtGBOiAke2Rvd25QYXltZW50fSDRgNGD0LEuYCwgYNCe0YHRgtCw0YLQvtC6OiAke2Ftb3VudH0g0YDRg9CxLmApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKC4uLmNhbGNSdWxlcy5tYXAocnVsZSA9PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGFwcGx5UnVsZShhbW91bnQsIHJ1bGUpO1xuICAgICAgICBpZiAocnVsZS5pc0Nhc2hiYWNrKSByZXR1cm4gYPCfkrggJHtydWxlLm5hbWV9OiAke3Jlc3VsdH0g0LHQsNC70LvQsNC80LhgO1xuICAgICAgICBjb25zdCB0b3RhbFdpdGhEb3duUGF5bWVudCA9IGRvd25QYXltZW50TWF0Y2ggPyBgICgke3Jlc3VsdCArIGRvd25QYXltZW50fSDRgNGD0LEuINGBINC/0LXRgNCy0L7QvdCw0YfQsNC70YzQvdGL0Lwg0LLQt9C90L7RgdC+0LwpYCA6ICcnO1xuICAgICAgICByZXR1cm4gYPCflLkgJHtydWxlLm5hbWV9OiAke3Jlc3VsdH0g0YDRg9CxLiR7dG90YWxXaXRoRG93blBheW1lbnR9YDtcbiAgICB9KSk7XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgbGluZXMuam9pbignXFxuJyksICfwn6euINCa0LDQu9GM0LrRg9C70Y/RgtC+0YAnLCBpbnB1dCk7XG59XG5cbmZ1bmN0aW9uIGNhbGN1bGF0ZVJldmVyc2UoKSB7XG4gICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykudmFsdWUudHJpbSgpO1xuICAgIGlmICghaW5wdXQpIHJldHVybjtcbiAgICBhZGRUb0NoYXRIaXN0b3J5KCd1c2VyJywgaW5wdXQsICfwn5SEINCg0LXQstC10YDRgScpO1xuICAgIGNvbnN0IGFtb3VudCA9IHBhcnNlRmxvYXQoaW5wdXQpO1xuICAgIGlmIChpc05hTihhbW91bnQpIHx8IGFtb3VudCA8PSAwKSB7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsICfQntGI0LjQsdC60LA6INCy0LLQtdC00LjRgtC1INC60L7RgNGA0LXQutGC0L3Rg9GOINGB0YPQvNC80YMuJywgJ/CflIQg0KDQtdCy0LXRgNGBJywgaW5wdXQpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGxpbmVzID0gY2FsY1J1bGVzXG4gICAgICAgIC5maWx0ZXIociA9PiAhci5pc0Nhc2hiYWNrICYmIHIucGVyY2VudCA+IDApXG4gICAgICAgIC5tYXAociA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcmlnaW5hbCA9IE1hdGgucm91bmQoKGFtb3VudCAtIChyLmV4dHJhIHx8IDApKSAvIHIucGVyY2VudCAqIDEwMCk7XG4gICAgICAgICAgICByZXR1cm4gYPCflLkgJHtyLm5hbWV9OiAke29yaWdpbmFsfSDRgNGD0LEuYDtcbiAgICAgICAgfSk7XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ/CflIQg0KDQldCS0JXQoNChINGA0LDRgdGH0ZHRgtCwOlxcbicgKyBsaW5lcy5qb2luKCdcXG4nKSwgJ/CflIQg0KDQtdCy0LXRgNGBJywgaW5wdXQpO1xufVxuXG4vKipcbiAqINCh0LrQuNC00LrQsCAvINCd0LDRhtC10L3QutCwXG4gKiDQpNC+0YDQvNCw0YLRizpcbiAqICAg0YbQtdC90LAgLSDRgdC60LjQtNC60LAgICDihpIg0LLRi9GH0LXRgdGC0YxcbiAqICAg0YbQtdC90LAgKyDQvdCw0YbQtdC90LrQsCAg4oaSINC/0YDQuNCx0LDQstC40YLRjFxuICovXG5mdW5jdGlvbiBhcHBseURpc2NvdW50T3JNYXJrdXAoKSB7XG4gICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykudmFsdWUudHJpbSgpO1xuICAgIGlmICghaW5wdXQpIHJldHVybjtcbiAgICBhZGRUb0NoYXRIaXN0b3J5KCd1c2VyJywgaW5wdXQsICfwn46JINCh0LrQuNC00LrQsC/QndCw0YbQtdC90LrQsCcpO1xuXG4gICAgLy8g0J7Qv9GA0LXQtNC10LvRj9C10Lwg0L7Qv9C10YDQsNGG0LjRjjogKyDQuNC70LggLVxuICAgIGNvbnN0IG1pbnVzSWR4ID0gaW5wdXQubGFzdEluZGV4T2YoJy0nKTtcbiAgICBjb25zdCBwbHVzSWR4ICA9IGlucHV0Lmxhc3RJbmRleE9mKCcrJyk7XG5cbiAgICBsZXQgb3AgPSBudWxsLCBzcGxpdElkeCA9IC0xO1xuICAgIGlmIChtaW51c0lkeCA+IDAgJiYgbWludXNJZHggPiBwbHVzSWR4KSB7IG9wID0gJy0nOyBzcGxpdElkeCA9IG1pbnVzSWR4OyB9XG4gICAgZWxzZSBpZiAocGx1c0lkeCA+IDApICAgICAgICAgICAgICAgICAgIHsgb3AgPSAnKyc7IHNwbGl0SWR4ID0gcGx1c0lkeDsgIH1cblxuICAgIGlmICghb3ApIHtcbiAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ9Ce0YjQuNCx0LrQsDog0YTQvtGA0LzQsNGCIOKAlCBcItGB0YPQvNC80LAgLSDRgdC60LjQtNC60LBcIiDQuNC70LggXCLRgdGD0LzQvNCwICsg0L3QsNGG0LXQvdC60LBcIicsICfwn46JJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBvcmlnID0gcGFyc2VGbG9hdChpbnB1dC5zdWJzdHJpbmcoMCwgc3BsaXRJZHgpLnRyaW0oKSk7XG4gICAgY29uc3QgZGlmZiA9IHBhcnNlRmxvYXQoaW5wdXQuc3Vic3RyaW5nKHNwbGl0SWR4ICsgMSkudHJpbSgpKTtcblxuICAgIGlmIChpc05hTihvcmlnKSB8fCBpc05hTihkaWZmKSkge1xuICAgICAgICBhZGRUb0NoYXRIaXN0b3J5KCdib3QnLCAn0J7RiNC40LHQutCwOiDQvdC10LrQvtGA0YDQtdC60YLQvdGL0LUg0YfQuNGB0LvQsCcsICfwn46JJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBvcCA9PT0gJy0nID8gb3JpZyAtIGRpZmYgOiBvcmlnICsgZGlmZjtcbiAgICBjb25zdCBwY3QgICAgPSBOdW1iZXIoTWF0aC5hYnMoZGlmZiAvIG9yaWcgKiAxMDApLnRvRml4ZWQoMikpO1xuICAgIGNvbnN0IGxhYmVsICA9IG9wID09PSAnLScgPyAn8J+OiSDQodC60LjQtNC60LAnIDogJ/Cfk4gg0J3QsNGG0LXQvdC60LAnO1xuICAgIGNvbnN0IHZlcmIgICA9IG9wID09PSAnLScgPyAn0KHQutC40LTQutCwJyAgICA6ICfQndCw0YbQtdC90LrQsCc7XG5cbiAgICBhZGRUb0NoYXRIaXN0b3J5KCdib3QnLFxuICAgICAgICAgICAgYCR7bGFiZWx9OlxcbmAgK1xuICAgICAgICAgICAgYPCflLkg0JHRi9C70L46ICR7b3JpZ30g0YDRg9CxLlxcbmAgK1xuICAgICAgICAgICAgYPCflLkgJHt2ZXJifTogJHtkaWZmfSDRgNGD0LEuICgke3BjdH0lKVxcbmAgK1xuICAgICAgICAgICAgYPCflLkg0JjRgtC+0LPQvjogJHtyZXN1bHR9INGA0YPQsS5gLFxuICAgICAgICAgICAgJ/CfjoknLCBpbnB1dCk7XG59XG5cbmZ1bmN0aW9uIGNhbGN1bGF0ZVNpbXBsZSgpIHtcbiAgICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFpbnB1dCkgcmV0dXJuO1xuICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ3VzZXInLCBpbnB1dCwgJ+KIkSDQn9GA0L7RgdGC0L7QuScpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IEZ1bmN0aW9uKCdcInVzZSBzdHJpY3RcIjsgcmV0dXJuICgnICsgaW5wdXQgKyAnKScpKCk7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIGDQoNC10LfRg9C70YzRgtCw0YI6ICR7cmVzdWx0fWAsICfiiJEg0J/RgNC+0YHRgtC+0LknLCBpbnB1dCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsICfQntGI0LjQsdC60LA6INC90LXQutC+0YDRgNC10LrRgtC90L7QtSDQstGL0YDQsNC20LXQvdC40LUnLCAn4oiRINCf0YDQvtGB0YLQvtC5Jyk7XG4gICAgfVxufVxuXG4iLCIvLyDilIDilIDilIAg0KDQsNGB0L/QuNGB0LDQvdC40LUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQktC60LvQsNC00LrQuCDCq9Ch0LXQs9C+0LTQvdGPwrsvwqvQl9Cw0LLRgtGA0LDCuyDQv9C+0LrQsNC30YvQstCw0Y7RgiDQtNCw0L3QvdGL0LUg0LLQvdGD0YLRgNC4INCc0LXQvNC90L7Qs9C+INGH0LDRgtCwLlxuZnVuY3Rpb24gZmV0Y2hXaG9Xb3Jrc1RvZGF5KCkgICAgeyByZXR1cm4gZmV0Y2hXaG9Xb3JrcygndG9kYXknKTsgfVxuZnVuY3Rpb24gZmV0Y2hXaG9Xb3Jrc1RvbW9ycm93KCkgeyByZXR1cm4gZmV0Y2hXaG9Xb3JrcygndG9tb3Jyb3cnKTsgfVxuXG5mdW5jdGlvbiBzY2hlZHVsZVRhcmdldERhdGUoZGF5LCBub3cgPSBEYXRlLm5vdygpKSB7XG4gICAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKG5vdyk7XG4gICAgaWYgKGRheSA9PT0gJ3RvbW9ycm93JykgZGF0ZS5zZXREYXRlKGRhdGUuZ2V0RGF0ZSgpICsgMSk7XG4gICAgcmV0dXJuIGAke2RhdGUuZ2V0RnVsbFllYXIoKX0tJHtTdHJpbmcoZGF0ZS5nZXRNb250aCgpICsgMSkucGFkU3RhcnQoMiwgJzAnKX0tJHtTdHJpbmcoZGF0ZS5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsICcwJyl9YDtcbn1cblxuZnVuY3Rpb24gYXBwbHlTY2hlZHVsZVNuYXBzaG90KGRheSwgc25hcHNob3QpIHtcbiAgICBjb25zdCBzdGF0ZSA9IHNjaGVkdWxlU3RhdGVCeURheVtkYXldO1xuICAgIGNvbnN0IHJlcGxhY2VtZW50cyA9IHsgLi4uc25hcHNob3QucmVtb3RlUmVwbGFjZW1lbnRzLCAuLi5zY2hlZHVsZVJlcGxhY2VtZW50cyB9O1xuICAgIHN0YXRlLnNuYXBzaG90ID0gc25hcHNob3Q7XG4gICAgc3RhdGUucGFyc2VkID0gcGFyc2VTY2hlZHVsZUxpbmVzKHNuYXBzaG90LnJhd1RleHQsIHJlcGxhY2VtZW50cywgZGF5KTtcbiAgICBzdGF0ZS50ZXh0Q29weSA9IGZvcm1hdE91dHB1dFdpdGhSZXBsYWNlbWVudHMoc25hcHNob3QucmF3VGV4dCwgcmVwbGFjZW1lbnRzLCBkYXkpO1xuICAgIHN0YXRlLnVwZGF0ZWRBdCA9IHNuYXBzaG90LmZldGNoZWRBdDtcbn1cblxuZnVuY3Rpb24gZmV0Y2hXaG9Xb3JrcyhkYXksIHsgZm9yY2UgPSBmYWxzZSB9ID0ge30pIHtcbiAgICBjb25zdCB1cmwgICAgID0gYGh0dHBzOi8vZG9jcy5nb29nbGUuY29tL3NwcmVhZHNoZWV0cy9kLzEzS1VtSHRSWFliWGpCRTdLUV80TUZRNVZzZ1VZcXUyaGVVUlkxeTJOd2lFL2VkaXRgO1xuICAgIGNvbnN0IGpzb25VcmwgPSAnaHR0cHM6Ly9naXRodWIuY29tL3h0YWxpYS9oYXRpa28vcmF3L3JlZnMvaGVhZHMvbWFpbi9qcy93d1Blb3BsZXMuanNvbic7XG4gICAgY29uc3Qgc3RhdGUgPSBzY2hlZHVsZVN0YXRlQnlEYXlbZGF5XTtcbiAgICBpZiAoIXN0YXRlKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuICAgIGlmIChzdGF0ZS5pbkZsaWdodCkge1xuICAgICAgICByZW5kZXJTY2hlZHVsZVRhYihkYXkpO1xuICAgICAgICByZXR1cm4gc3RhdGUuaW5GbGlnaHQ7XG4gICAgfVxuICAgIGNvbnN0IHRhcmdldERhdGUgPSBzY2hlZHVsZVRhcmdldERhdGUoZGF5KTtcbiAgICBjb25zdCBjYWNoZWQgPSBmb3JjZSA/IG51bGwgOiBsb2FkU2NoZWR1bGVDYWNoZShkYXksIHRhcmdldERhdGUpO1xuICAgIGlmIChjYWNoZWQpIHtcbiAgICAgICAgYXBwbHlTY2hlZHVsZVNuYXBzaG90KGRheSwgY2FjaGVkKTtcbiAgICAgICAgc3RhdGUuZXJyb3IgPSAnJztcbiAgICAgICAgcmVuZGVyU2NoZWR1bGVUYWIoZGF5KTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShjYWNoZWQpO1xuICAgIH1cbiAgICBzdGF0ZS5sb2FkaW5nID0gdHJ1ZTtcbiAgICBzdGF0ZS5lcnJvciA9ICcnO1xuICAgIHJlbmRlclNjaGVkdWxlVGFiKGRheSk7XG5cbiAgICBzdGF0ZS5pbkZsaWdodCA9IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oKCkgPT4gZmV0Y2goanNvblVybCkpXG4gICAgICAgIC50aGVuKHIgPT4geyBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcigpOyByZXR1cm4gci5qc29uKCk7IH0pXG4gICAgICAgIC50aGVuKGxvYWRlZCA9PiB7XG4gICAgICAgICAgICBpZiAoIWxvYWRlZCB8fCB0eXBlb2YgbG9hZGVkICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGxvYWRlZClcbiAgICAgICAgICAgICAgICB8fCBPYmplY3QudmFsdWVzKGxvYWRlZCkuc29tZSh2YWx1ZSA9PiB0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSkgdGhyb3cgbmV3IEVycm9yKCfQndC10LLQtdGA0L3Ri9C5INGE0L7RgNC80LDRgiDQt9Cw0LzQtdC9Jyk7XG4gICAgICAgICAgICByZXR1cm4gbG9hZGVkO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKCkgPT4gKHt9KSlcbiAgICAgICAgLnRoZW4obG9hZGVkID0+IGxvYWRUYWJsZVdpdGhSZXBsYWNlbWVudHMoZGF5LCB1cmwsIHsgLi4ubG9hZGVkLCAuLi5zY2hlZHVsZVJlcGxhY2VtZW50cyB9LCB0YXJnZXREYXRlKVxuICAgICAgICAgICAgLnRoZW4ocmVzdWx0ID0+ICh7IC4uLnJlc3VsdCwgcmVtb3RlUmVwbGFjZW1lbnRzOiBsb2FkZWQgfSkpKVxuICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHNjaGVkdWxlVGFyZ2V0RGF0ZShkYXkpICE9PSB0YXJnZXREYXRlKSB0aHJvdyBuZXcgRXJyb3IoJ9CY0LfQvNC10L3QuNC70LDRgdGMINC60LDQu9C10L3QtNCw0YDQvdCw0Y8g0LTQsNGC0LAg4oCUINC+0YLQutGA0L7QudGC0LUg0LTQtdC90Ywg0LfQsNC90L7QstC+Jyk7XG4gICAgICAgICAgICBzdGF0ZS5sb2FkaW5nID0gZmFsc2U7XG4gICAgICAgICAgICBjb25zdCBzbmFwc2hvdCA9IHsgc2NoZW1hOiAxLCB0YXJnZXREYXRlLCBmZXRjaGVkQXQ6IERhdGUubm93KCksIHJhd1RleHQ6IHJlc3VsdC5yYXdUZXh0LCByZW1vdGVSZXBsYWNlbWVudHM6IHJlc3VsdC5yZW1vdGVSZXBsYWNlbWVudHMgfTtcbiAgICAgICAgICAgIGFwcGx5U2NoZWR1bGVTbmFwc2hvdChkYXksIHNuYXBzaG90KTtcbiAgICAgICAgICAgIHNhdmVTY2hlZHVsZUNhY2hlKGRheSwgc25hcHNob3QpO1xuICAgICAgICAgICAgc3RhdGUuZXJyb3IgPSAnJztcbiAgICAgICAgICAgIHJlbmRlclNjaGVkdWxlVGFiKGRheSk7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgc3RhdGUubG9hZGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgc3RhdGUuZXJyb3IgPSBlcnJvci5tZXNzYWdlIHx8ICfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0L/RgNC4INC30LDQs9GA0YPQt9C60LUg0YDQsNGB0L/QuNGB0LDQvdC40Y8nO1xuICAgICAgICAgICAgcmVuZGVyU2NoZWR1bGVUYWIoZGF5KTtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7IHN0YXRlLmluRmxpZ2h0ID0gbnVsbDsgfSk7XG4gICAgcmV0dXJuIHN0YXRlLmluRmxpZ2h0O1xufVxuXG5mdW5jdGlvbiBsb2FkVGFibGVXaXRoUmVwbGFjZW1lbnRzKGRheSwgdXJsLCByZXBsYWNlbWVudHMsIHRhcmdldERhdGUgPSBzY2hlZHVsZVRhcmdldERhdGUoZGF5KSkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiBHTV94bWxodHRwUmVxdWVzdCh7XG4gICAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICAgIHRpbWVvdXQ6IDMwMDAwLFxuICAgICAgICB1cmwsXG4gICAgICAgIG9ubG9hZChyZXNwb25zZSkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzIDwgMjAwIHx8IHJlc3BvbnNlLnN0YXR1cyA+PSAzMDApIHRocm93IG5ldyBFcnJvcihg0J7RiNC40LHQutCwINC30LDQs9GA0YPQt9C60Lgg0YDQsNGB0L/QuNGB0LDQvdC40Y86IEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVnZXggPSAv8J+Or9Cg0JDQkdCe0KfQmNCZX9CT0KDQkNCk0JjQml/QlNCQ0J3QndCr0JXwn46vKFtcXHNcXFNdKj8p8J+Ory9pO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gcmVzcG9uc2UucmVzcG9uc2VUZXh0Lm1hdGNoKHJlZ2V4KTtcbiAgICAgICAgICAgICAgICBpZiAoIW1hdGNoPy5bMV0pIHRocm93IG5ldyBFcnJvcign0J3QtSDRg9C00LDQu9C+0YHRjCDQvdCw0LnRgtC4INC00LDQvdC90YvQtSDQsiDRgtCw0LHQu9C40YbQtScpO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgcGFyc2VkSHRtbCA9IG5ldyBET01QYXJzZXIoKS5wYXJzZUZyb21TdHJpbmcobWF0Y2hbMV0sICd0ZXh0L2h0bWwnKTtcbiAgICAgICAgICAgICAgICBjb25zdCBmdWxsID0gKHBhcnNlZEh0bWwuYm9keS50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpLnJlcGxhY2UoL1xccysvZywgJyAnKTtcbiAgICAgICAgICAgICAgICBjb25zdCBtYXJrZXJzID0ge1xuICAgICAgICAgICAgICAgICAgICB0b2RheTogICAgWyfwn5OF0KHQldCT0J7QlNCd0K9f0J3QkNCn0JDQm9Ce8J+ThScsICfwn5OF0KHQldCT0J7QlNCd0K9f0JrQntCd0JXQpvCfk4UnXSxcbiAgICAgICAgICAgICAgICAgICAgdG9tb3Jyb3c6IFsn8J+ThdCX0JDQktCi0KDQkF/QndCQ0KfQkNCb0J7wn5OFJywgJ/Cfk4XQl9CQ0JLQotCg0JBf0JrQntCd0JXQpvCfk4UnXVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgY29uc3QgW3NtLCBlbV0gPSBtYXJrZXJzW2RheV07XG4gICAgICAgICAgICAgICAgY29uc3Qgc2kgPSBmdWxsLmluZGV4T2Yoc20pLCBlaSA9IGZ1bGwuaW5kZXhPZihlbSk7XG4gICAgICAgICAgICAgICAgaWYgKHNpID09PSAtMSB8fCBlaSA8PSBzaSkgdGhyb3cgbmV3IEVycm9yKCfQlNCw0L3QvdGL0LUg0L3QtSDQvdCw0LnQtNC10L3RiycpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHRleHQgPSBmdWxsLnN1YnN0cmluZyhzaSwgZWkpLnJlcGxhY2Uoc20sICcnKS5yZXBsYWNlKGVtLCAnJykudHJpbSgpO1xuICAgICAgICAgICAgICAgIGlmICh0ZXh0Lm1hdGNoKC9cXGR7Mn1cXC5cXGR7Mn1cXC5cXGR7NH0vKT8uWzBdICE9PSB0YXJnZXREYXRlLnNwbGl0KCctJykucmV2ZXJzZSgpLmpvaW4oJy4nKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ9CU0LDRgtCwINGA0LDRgdC/0LjRgdCw0L3QuNGPINC90LUg0YHQvtC+0YLQstC10YLRgdGC0LLRg9C10YIg0LLRi9Cx0YDQsNC90L3QvtC80YMg0LTQvdGOJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJlc29sdmUoe1xuICAgICAgICAgICAgICAgICAgICByYXdUZXh0OiB0ZXh0LFxuICAgICAgICAgICAgICAgICAgICBwYXJzZWQ6IHBhcnNlU2NoZWR1bGVMaW5lcyh0ZXh0LCByZXBsYWNlbWVudHMsIGRheSksXG4gICAgICAgICAgICAgICAgICAgIHRleHRDb3B5OiBmb3JtYXRPdXRwdXRXaXRoUmVwbGFjZW1lbnRzKHRleHQsIHJlcGxhY2VtZW50cywgZGF5KVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBvbmVycm9yKCkgeyByZWplY3QobmV3IEVycm9yKCfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0L/RgNC4INC30LDQs9GA0YPQt9C60LUg0YDQsNGB0L/QuNGB0LDQvdC40Y8nKSk7IH0sXG4gICAgICAgIG9udGltZW91dCgpIHsgcmVqZWN0KG5ldyBFcnJvcign0JLRgNC10LzRjyDQvtC20LjQtNCw0L3QuNGPINGA0LDRgdC/0LjRgdCw0L3QuNGPINC40YHRgtC10LrQu9C+JykpOyB9LFxuICAgICAgICBvbmFib3J0KCkgeyByZWplY3QobmV3IEVycm9yKCfQl9Cw0LPRgNGD0LfQutCwINGA0LDRgdC/0LjRgdCw0L3QuNGPINC+0YLQvNC10L3QtdC90LAnKSk7IH1cbiAgICB9KSk7XG59XG5cbi8vINCg0LDQt9Cx0LjRgNCw0LXRgiDRgNCw0YHQv9C40YHQsNC90LjQtSDQvdCwINCz0YDRg9C/0L/RiyDQv9C+INCz0L7RgNC+0LTQsNC8LiDQktGF0L7QtCDigJQgwqvQv9C+0YfRgtC4INC+0LTQvdCwINGB0YLRgNC+0LrQsMK7INGBXG4vLyDQvNCw0YDQutC10YDQsNC80Lg6IPCfj6Iv8J+PmSDQvdCw0YfQuNC90LDRjtGCINCz0L7RgNC+0LQsIPCfkaQg4oCUINGH0LXQu9C+0LLQtdC60LAuINCg0LDQt9C00LXQu9C40YLQtdC70Lgg0YHRgtGA0L7QuiDQvdC1INC90YPQttC90YsuXG4vLyAgIFt7IGNpdHksIHJvd3M6IFt7IHBlcnNvbiwgc3RvcmUgfV0gfV1cbmZ1bmN0aW9uIHBhcnNlU2NoZWR1bGVMaW5lcyh0ZXh0LCByZXBsYWNlbWVudHMsIGRheSkge1xuICAgIGNvbnN0IGRhdGVNYXRjaCA9IHRleHQubWF0Y2goLyhcXGR7Mn1cXC5cXGR7Mn1cXC5cXGR7NH0pLyk7XG4gICAgY29uc3QgZGF0ZVN0ciA9IGRhdGVNYXRjaCA/IGRhdGVNYXRjaFsxXSA6ICcnO1xuICAgIGxldCBjbGVhbmVkID0gdGV4dC5yZXBsYWNlKGRhdGVTdHIsICcnKS5yZXBsYWNlKC/wn5OFL2csICcnKS5yZXBsYWNlKC9cXHwvZywgJyAtICcpLnRyaW0oKTtcblxuICAgIGNvbnN0IGdyb3VwcyA9IFtdO1xuICAgIGxldCBjdXJyZW50ID0gbnVsbDtcblxuICAgIC8vINCg0LXQttC10Lwg0L/QviDQvNCw0YDQutC10YDQsNC8LCDRgdC+0YXRgNCw0L3Rj9GPINC40YUg0LIg0L3QsNGH0LDQu9C1INGC0L7QutC10L3QsFxuICAgIGNvbnN0IHRva2VucyA9IGNsZWFuZWQuc3BsaXQoLyg/PfCfj6J88J+PmXzwn5GkKS8pLm1hcCh0ID0+IHQudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG5cbiAgICB0b2tlbnMuZm9yRWFjaCh0b2tlbiA9PiB7XG4gICAgICAgIGlmICgvXvCfj6J8XvCfj5kvLnRlc3QodG9rZW4pKSB7XG4gICAgICAgICAgICBjb25zdCBjaXR5ID0gdG9rZW4ucmVwbGFjZSgvXvCfj6J8XvCfj5kvLCAnJylcbiAgICAgICAgICAgICAgICAucmVwbGFjZSgvXtCSINCz0L7RgNC+0LTQtVxccyovaSwgJycpXG4gICAgICAgICAgICAgICAgLnRyaW0oKSB8fCAn4oCUJztcbiAgICAgICAgICAgIGN1cnJlbnQgPSB7IGNpdHksIHJvd3M6IFtdIH07XG4gICAgICAgICAgICBncm91cHMucHVzaChjdXJyZW50KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoL17wn5GkLy50ZXN0KHRva2VuKSkge1xuICAgICAgICAgICAgY29uc3QgYm9keSA9IHRva2VuLnJlcGxhY2UoL17wn5GkXFxzKi8sICcnKTtcbiAgICAgICAgICAgIGNvbnN0IFtpbmZvLCB2YWx1ZV0gPSBib2R5LmluY2x1ZGVzKCcgLSAnKSA/IGJvZHkuc3BsaXQoJyAtICcpIDogW2JvZHksICcnXTtcbiAgICAgICAgICAgIC8vINCY0LzRjyDQuCBlbWFpbCDRh9Cw0YHRgtC+INGB0LrQu9C10LXQvdGLINCx0LXQtyDQv9GA0L7QsdC10LvQsDogwqvQoNGD0YHQu9Cw0L1taWxpYmFldkBza2w0ZG3Cu1xuICAgICAgICAgICAgY29uc3QgcGVyc29uID0gaW5mb1xuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8oW9CwLdGP0JAt0K/QgdGRXSkoW2EtekEtWkBdKS9nLCAnJDEgJDInKVxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgICAgICAgICAgICAgICAudHJpbSgpO1xuICAgICAgICAgICAgbGV0IHN0b3JlID0gKHZhbHVlIHx8ICcnKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoc3RvcmUgJiYgcmVwbGFjZW1lbnRzW3N0b3JlXSkgc3RvcmUgPSByZXBsYWNlbWVudHNbc3RvcmVdO1xuICAgICAgICAgICAgaWYgKCFjdXJyZW50KSB7IGN1cnJlbnQgPSB7IGNpdHk6ICfigJQnLCByb3dzOiBbXSB9OyBncm91cHMucHVzaChjdXJyZW50KTsgfVxuICAgICAgICAgICAgY3VycmVudC5yb3dzLnB1c2goeyBwZXJzb246IHBlcnNvbiB8fCAn4oCUJywgc3RvcmU6IHN0b3JlIHx8ICfigJQnIH0pO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBkYXRlU3RyLCBncm91cHMgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyU2NoZWR1bGVUYWIoZGF5KSB7XG4gICAgY29uc3QgcGFuZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1NwZWNpYWxQYW5lJyk7XG4gICAgaWYgKCFwYW5lIHx8IGN1cnJlbnRBY3Rpb24gIT09IGRheSkgcmV0dXJuO1xuICAgIGNvbnN0IHN0YXRlID0gc2NoZWR1bGVTdGF0ZUJ5RGF5W2RheV07XG4gICAgaWYgKHN0YXRlLnNuYXBzaG90ICYmIHN0YXRlLnNuYXBzaG90LnRhcmdldERhdGUgIT09IHNjaGVkdWxlVGFyZ2V0RGF0ZShkYXkpKSB7XG4gICAgICAgIHN0YXRlLnNuYXBzaG90ID0gbnVsbDtcbiAgICAgICAgc3RhdGUucGFyc2VkID0gbnVsbDtcbiAgICAgICAgc3RhdGUudGV4dENvcHkgPSAnJztcbiAgICAgICAgc3RhdGUudXBkYXRlZEF0ID0gMDtcbiAgICB9XG4gICAgY29uc3QgZGF5TmFtZSA9IGRheSA9PT0gJ3RvZGF5JyA/ICfQodC10LPQvtC00L3RjycgOiAn0JfQsNCy0YLRgNCwJztcbiAgICBwYW5lLnJlcGxhY2VDaGlsZHJlbigpO1xuXG4gICAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRvb2xiYXIuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo2cHg7ZmxleDowIDAgYXV0bzsnO1xuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSBgJHtkYXkgPT09ICd0b2RheScgPyAn8J+foicgOiAn8J+foSd9ICR7ZGF5TmFtZX0ke3N0YXRlLnBhcnNlZD8uZGF0ZVN0ciA/IGAg4oCUICR7c3RhdGUucGFyc2VkLmRhdGVTdHJ9YCA6ICcnfWA7XG4gICAgdGl0bGUuc3R5bGUuY3NzVGV4dCA9ICdmbGV4OjE7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTJweDsnO1xuICAgIHRvb2xiYXIuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICAgIGNvbnN0IHJlZnJlc2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICByZWZyZXNoLnR5cGUgPSAnYnV0dG9uJztcbiAgICByZWZyZXNoLmNsYXNzTmFtZSA9ICdtYy1idG4gbWMtYnRuLWJsdWUnO1xuICAgIHJlZnJlc2gudGV4dENvbnRlbnQgPSBzdGF0ZS5sb2FkaW5nID8gJ+KPsycgOiAn4oa7INCe0LHQvdC+0LLQuNGC0YwnO1xuICAgIHJlZnJlc2guZGlzYWJsZWQgPSBzdGF0ZS5sb2FkaW5nO1xuICAgIHJlZnJlc2guYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBmZXRjaFdob1dvcmtzKGRheSwgeyBmb3JjZTogdHJ1ZSB9KSk7XG4gICAgdG9vbGJhci5hcHBlbmRDaGlsZChyZWZyZXNoKTtcbiAgICBwYW5lLmFwcGVuZENoaWxkKHRvb2xiYXIpO1xuXG4gICAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIG1ldGEuc3R5bGUuY3NzVGV4dCA9ICdmb250LXNpemU6OS41cHg7Y29sb3I6Izk0YTNiODsnO1xuICAgIG1ldGEudGV4dENvbnRlbnQgPSBzdGF0ZS51cGRhdGVkQXRcbiAgICAgICAgPyBg0J7QsdC90L7QstC70LXQvdC+ICR7bmV3IERhdGUoc3RhdGUudXBkYXRlZEF0KS50b0xvY2FsZVRpbWVTdHJpbmcoJ3J1LVJVJywgeyBob3VyOiAnMi1kaWdpdCcsIG1pbnV0ZTogJzItZGlnaXQnIH0pfSR7c3RhdGUuZXJyb3IgPyAnIMK3INC00LDQvdC90YvQtSDQvNC+0LPRg9GCINCx0YvRgtGMINGD0YHRgtCw0YDQtdCy0YjQuNC80LgnIDogJyd9YFxuICAgICAgICA6ICfQndCw0LbQvNC40YLQtSDCq9Ce0LHQvdC+0LLQuNGC0YzCuywg0YfRgtC+0LHRiyDQt9Cw0LPRgNGD0LfQuNGC0Ywg0YDQsNGB0L/QuNGB0LDQvdC40LUnO1xuICAgIHBhbmUuYXBwZW5kQ2hpbGQobWV0YSk7XG5cbiAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gJ2ZsZXg6MSAxIGF1dG87b3ZlcmZsb3cteTphdXRvO21pbi1oZWlnaHQ6ODBweDsnO1xuICAgIGlmIChzdGF0ZS5lcnJvcikge1xuICAgICAgICBjb25zdCBlcnJvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBlcnJvci5jbGFzc05hbWUgPSAnbWMtb3ZlcmxheS1lcnJvcic7XG4gICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gc3RhdGUuZXJyb3I7XG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZXJyb3IpO1xuICAgIH1cbiAgICBpZiAoc3RhdGUucGFyc2VkPy5ncm91cHM/Lmxlbmd0aCkge1xuICAgICAgICBzdGF0ZS5wYXJzZWQuZ3JvdXBzLmZvckVhY2goZ3JvdXAgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2l0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgY2l0eS5jbGFzc05hbWUgPSAnbWMtc2NoZWQtY2l0eSc7XG4gICAgICAgICAgICBjaXR5LnRleHRDb250ZW50ID0gYPCfj5kgJHtncm91cC5jaXR5fWA7XG4gICAgICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGNpdHkpO1xuICAgICAgICAgICAgZ3JvdXAucm93cy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgICAgIHJvdy5jbGFzc05hbWUgPSAnbWMtc2NoZWQtcm93JztcbiAgICAgICAgICAgICAgICByb3cudGV4dENvbnRlbnQgPSBg8J+RpCAke2l0ZW0ucGVyc29ufSDigJQgJHtpdGVtLnN0b3JlfWA7XG4gICAgICAgICAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChyb3cpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICBwYW5lLmFwcGVuZENoaWxkKGxpc3QpO1xuXG4gICAgaWYgKHN0YXRlLnRleHRDb3B5KSB7XG4gICAgICAgIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgY29weS50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIGNvcHkuY2xhc3NOYW1lID0gJ21jLWJ0biBtYy1idG4tc2xhdGUnO1xuICAgICAgICBjb3B5LnRleHRDb250ZW50ID0gJ/Cfk4sg0JrQvtC/0LjRgNC+0LLQsNGC0YwnO1xuICAgICAgICBjb3B5LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gY29weUhhdGlrb1RleHQoc3RhdGUudGV4dENvcHkpKTtcbiAgICAgICAgcGFuZS5hcHBlbmRDaGlsZChjb3B5KTtcbiAgICB9XG59XG5cbi8vINCf0LvQsNCy0LDRjtGJ0LXQtSDQv9C10YDQtdGC0LDRgdC60LjQstCw0LXQvNC+0LUg0L7QutC90L4g0YHQviDRgdC/0LjRgdC60L7QvCDCq9Ca0YLQvi/Qk9C00LXCuyAo0LHQtdC3INC30LDRgtC10LzQvdC10L3QuNGPKS5cbmZ1bmN0aW9uIG9wZW5TY2hlZHVsZVRhYmxlV2luZG93KGRheSwgcGFyc2VkLCB0ZXh0Q29weSkge1xuICAgIGNsb3NlTWVtY2hhdE92ZXJsYXkoKTtcblxuICAgIGNvbnN0IGRheU5hbWUgPSBkYXkgPT09ICd0b2RheScgPyAn0KHQtdCz0L7QtNC90Y8nIDogJ9CX0LDQstGC0YDQsCc7XG4gICAgY29uc3Qgd2luID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHdpbi5jbGFzc05hbWUgPSAnbWMtZmxvYXQtd2luZG93JztcbiAgICAgICAgYXBwbHlGbG9hdFdpbmRvd1Bvcyh3aW4pO1xuXG4gICAgLy8g4pSA4pSAINCX0LDQs9C+0LvQvtCy0L7QuiAo0LfQsCDQvdC10LPQviDQvNC+0LbQvdC+INGC0LDRgdC60LDRgtGMKSDilIDilIBcbiAgICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBoZWFkZXIuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWhlYWRlcic7XG4gICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB0aXRsZS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtdGl0bGUnO1xuICAgIHRpdGxlLnRleHRDb250ZW50ID0gYPCfk4UgJHtkYXlOYW1lfSR7cGFyc2VkPy5kYXRlU3RyID8gJyDigJQgJyArIHBhcnNlZC5kYXRlU3RyIDogJyd9YDtcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICAgIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgY2xvc2UudHlwZSA9ICdidXR0b24nO1xuICAgIGNsb3NlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1jbG9zZSc7XG4gICAgY2xvc2UudGV4dENvbnRlbnQgPSAn4pyVJztcbiAgICBjbG9zZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGNsb3NlTWVtY2hhdE92ZXJsYXkpO1xuICAgIGhlYWRlci5hcHBlbmRDaGlsZChjbG9zZSk7XG4gICAgd2luLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgICAvLyDilIDilIAg0KLQtdC70L46INGB0L/QuNGB0L7QuiDQv9C+INCz0L7RgNC+0LTQsNC8INC40LvQuCDQvtGI0LjQsdC60LAg4pSA4pSAXG4gICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGJvZHkuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWJvZHknO1xuICAgIGlmICghcGFyc2VkIHx8ICFwYXJzZWQuZ3JvdXBzLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBlcnIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgZXJyLnN0eWxlLmNzc1RleHQgPSAnY29sb3I6Izk5MWIxYjtiYWNrZ3JvdW5kOiNmZWUyZTI7Ym9yZGVyOjFweCBzb2xpZCAjZmVjYWNhO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHg7Zm9udC1zaXplOjEycHg7JztcbiAgICAgICAgZXJyLnRleHRDb250ZW50ID0gdGV4dENvcHkgfHwgJ9Cd0LXRgiDQtNCw0L3QvdGL0YUnO1xuICAgICAgICBib2R5LmFwcGVuZENoaWxkKGVycik7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcGFyc2VkLmdyb3Vwcy5mb3JFYWNoKGdyb3VwID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNpdHlIZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgICAgIGNpdHlIZWFkZXIuY2xhc3NOYW1lID0gJ21jLXNjaGVkLWNpdHknO1xuICAgICAgICAgICAgY2l0eUhlYWRlci50ZXh0Q29udGVudCA9IGDwn4+ZICR7Z3JvdXAuY2l0eX1gO1xuICAgICAgICAgICAgYm9keS5hcHBlbmRDaGlsZChjaXR5SGVhZGVyKTtcbiAgICAgICAgICAgIGdyb3VwLnJvd3MuZm9yRWFjaChyb3cgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgICAgICAgICBsaW5lLmNsYXNzTmFtZSA9ICdtYy1zY2hlZC1yb3cnO1xuICAgICAgICAgICAgICAgIGxpbmUudGV4dENvbnRlbnQgPSBg8J+RpCAke3Jvdy5wZXJzb259IOKAlCAke3Jvdy5zdG9yZX1gO1xuICAgICAgICAgICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQobGluZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHdpbi5hcHBlbmRDaGlsZChib2R5KTtcblxuICAgIC8vIOKUgOKUgCDQn9C+0LTQstCw0Ls6INC60L7Qv9C40YDQvtCy0LDRgtGMINGC0LXQutGB0YIg4pSA4pSAXG4gICAgY29uc3QgZm9vdGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgZm9vdGVyLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1mb290ZXInO1xuICAgIGNvbnN0IGNvcHlCdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBjb3B5QnRuLnR5cGUgPSAnYnV0dG9uJztcbiAgICBjb3B5QnRuLmNsYXNzTmFtZSA9ICdtYy1idG4gbWMtYnRuLWJsdWUnO1xuICAgIGNvcHlCdG4udGV4dENvbnRlbnQgPSAn8J+TiyDQmtC+0L/QuNGA0L7QstCw0YLRjCDRgtC10LrRgdGCJztcbiAgICBjb3B5QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBjb3B5SGF0aWtvVGV4dCh0ZXh0Q29weSB8fCAnJyk7XG4gICAgICAgIGNvcHlCdG4udGV4dENvbnRlbnQgPSAn4pyFINCh0LrQvtC/0LjRgNC+0LLQsNC90L4nO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHsgY29weUJ0bi50ZXh0Q29udGVudCA9ICfwn5OLINCa0L7Qv9C40YDQvtCy0LDRgtGMINGC0LXQutGB0YInOyB9LCAxMjAwKTtcbiAgICB9KTtcbiAgICBmb290ZXIuYXBwZW5kQ2hpbGQoY29weUJ0bik7XG4gICAgd2luLmFwcGVuZENoaWxkKGZvb3Rlcik7XG5cbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHdpbik7XG4gICAgbWFrZU1vdmFibGUod2luLCBoZWFkZXIpO1xufVxuXG5mdW5jdGlvbiBjbG9zZU1lbWNoYXRPdmVybGF5KCkge1xuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tYy1vdmVybGF5LCAubWMtZmxvYXQtd2luZG93JykuZm9yRWFjaChlbCA9PiBlbC5yZW1vdmUoKSk7XG59XG5cbi8vINCf0YDQuNC80LXQvdGP0LXRgiDRgdC+0YXRgNCw0L3RkdC90L3Rg9GOINC/0L7Qt9C40YbQuNGOINC6INC/0LvQsNCy0LDRjtGJ0LXQvNGDINC+0LrQvdGDICjQtdGB0LvQuCDQtdGB0YLRjCkuXG5mdW5jdGlvbiBhcHBseUZsb2F0V2luZG93UG9zKGVsKSB7XG4gICAgY29uc3QgcG9zID0gbG9hZEZsb2F0V2luZG93UG9zKCk7XG4gICAgaWYgKCFwb3MpIHJldHVybjtcbiAgICBlbC5zdHlsZS5sZWZ0ID0gYCR7cG9zLmxlZnR9cHhgO1xuICAgIGVsLnN0eWxlLnRvcCA9IGAke3Bvcy50b3B9cHhgO1xuICAgIGVsLnN0eWxlLnJpZ2h0ID0gJ2F1dG8nO1xufVxuXG4vLyDQlNC10LvQsNC10YIg0L7QutC90L4g0L/QtdGA0LXRgtCw0YHQutC40LLQsNC10LzRi9C8INC30LAg0L/QtdGA0LXQtNCw0L3QvdGL0Lkg0Y3Qu9C10LzQtdC90YIt0LfQsNCz0L7Qu9C+0LLQvtC6LlxuLy8g0J/QvtC30LjRhtC40Y8g0L/Qu9Cw0LLQsNGO0YnQuNGFINC+0LrQvtC9INGB0L7RhdGA0LDQvdGP0LXRgtGB0Y8g0LIgbG9jYWxTdG9yYWdlLlxuZnVuY3Rpb24gbWFrZU1vdmFibGUoZWwsIGhhbmRsZSkge1xuICAgIGhhbmRsZS5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWRvd24nLCBlID0+IHtcbiAgICAgICAgaWYgKGUudGFyZ2V0LmNsb3Nlc3QoJ2J1dHRvbiwgaW5wdXQsIHNlbGVjdCwgYScpKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHJlY3QgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgICAgY29uc3Qgb2Zmc2V0WCA9IGUuY2xpZW50WCAtIHJlY3QubGVmdDtcbiAgICAgICAgY29uc3Qgb2Zmc2V0WSA9IGUuY2xpZW50WSAtIHJlY3QudG9wO1xuICAgICAgICBjb25zdCBvbk1vdmUgPSBldiA9PiB7XG4gICAgICAgICAgICBlbC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5tYXgoMCwgZXYuY2xpZW50WCAtIG9mZnNldFgpfXB4YDtcbiAgICAgICAgICAgIGVsLnN0eWxlLnRvcCA9IGAke01hdGgubWF4KDAsIGV2LmNsaWVudFkgLSBvZmZzZXRZKX1weGA7XG4gICAgICAgICAgICBlbC5zdHlsZS5yaWdodCA9ICdhdXRvJztcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3Qgb25VcCA9ICgpID0+IHtcbiAgICAgICAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIG9uTW92ZSk7XG4gICAgICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgb25VcCk7XG4gICAgICAgICAgICBpZiAoZWwuY2xhc3NMaXN0LmNvbnRhaW5zKCdtYy1mbG9hdC13aW5kb3cnKSkge1xuICAgICAgICAgICAgICAgIHNhdmVGbG9hdFdpbmRvd1BvcyhlbC5zdHlsZS5sZWZ0LCBlbC5zdHlsZS50b3ApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCBvbk1vdmUpO1xuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgb25VcCk7XG4gICAgfSk7XG59XG5cbi8vINCi0LXQutGB0YLQvtCy0YvQuSDRhNC+0YDQvNCw0YIgKNC00LvRjyDCq9Ca0L7Qv9C40YDQvtCy0LDRgtGMINGC0LXQutGB0YLCuyDQuCDRgdC+0LLQvNC10YHRgtC40LzQvtGB0YLQuCDRgdC+INGB0YLQsNGA0YvQvCDQstGL0LLQvtC00L7QvCkuXG5mdW5jdGlvbiBmb3JtYXRPdXRwdXRXaXRoUmVwbGFjZW1lbnRzKHRleHQsIHJlcGxhY2VtZW50cywgZGF5KSB7XG4gICAgY29uc3QgZGF0ZU1hdGNoID0gdGV4dC5tYXRjaCgvKFxcZHsyfVxcLlxcZHsyfVxcLlxcZHs0fSkvKTtcbiAgICBjb25zdCBkYXRlU3RyID0gZGF0ZU1hdGNoID8gZGF0ZU1hdGNoWzFdIDogJyc7XG4gICAgaWYgKGRhdGVTdHIpIHRleHQgPSB0ZXh0LnJlcGxhY2UoZGF0ZVN0ciwgJycpLnRyaW0oKTtcblxuICAgIGxldCBmb3JtYXR0ZWQgPSB0ZXh0XG4gICAgICAgIC5yZXBsYWNlKC/wn4+iIC9nLCAnXFxuXFxu8J+PoiDQkiDQs9C+0YDQvtC00LUgJylcbiAgICAgICAgLnJlcGxhY2UoL/CfkaQgL2csICdcXG7wn5GkICcpXG4gICAgICAgIC5yZXBsYWNlKC9cXHwvZywgJyAtICcpXG4gICAgICAgIC50cmltKCk7XG5cbiAgICBjb25zdCBsaW5lcyA9IGZvcm1hdHRlZC5zcGxpdCgnXFxuJykuZmlsdGVyKGwgPT4gbC50cmltKCkpO1xuICAgIGNvbnN0IHByb2Nlc3NlZCA9IGxpbmVzLm1hcChsaW5lID0+IHtcbiAgICAgICAgaWYgKCFsaW5lLnN0YXJ0c1dpdGgoJ/CfkaQnKSkgcmV0dXJuIGxpbmU7XG4gICAgICAgIGxldCBbaW5mbywgdmFsdWVdID0gbGluZS5pbmNsdWRlcygnIC0gJykgPyBsaW5lLnNwbGl0KCcgLSAnKSA6IFtsaW5lLCAnJ107XG4gICAgICAgIGluZm8gPSBpbmZvLnJlcGxhY2UoL/CfkaRcXHMqLywgJ/CfkaQgJylcbiAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvKFvQsC3Rj9CQLdCvXSkoW2EtekEtWkBdKS9nLCAnJDEgJDInKVxuICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFwuKFthLXpBLVpdKS9nLCAnLiAkMScpLnRyaW0oKTtcbiAgICAgICAgdmFsdWUgPSAodmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKHZhbHVlICYmIHJlcGxhY2VtZW50c1t2YWx1ZV0pIHZhbHVlID0gcmVwbGFjZW1lbnRzW3ZhbHVlXTtcbiAgICAgICAgcmV0dXJuIHZhbHVlID8gYCR7aW5mb30gLSAke3ZhbHVlfWAgOiBpbmZvO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZGF5TmFtZSA9IGRheSA9PT0gJ3RvZGF5JyA/ICfQodC10LPQvtC00L3RjycgOiAn0JfQsNCy0YLRgNCwJztcbiAgICByZXR1cm4gYPCfk4UgJHtkYXlOYW1lfSAoJHtkYXRlU3RyfSlcXG5cXG4ke3Byb2Nlc3NlZC5qb2luKCdcXG4nKX1gO1xufSIsIi8vIOKUgOKUgOKUgCDQn9C10YDQtdGC0LDRgdC60LjQstCw0L3QuNC1IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gc3RhcnREcmFnKGUpIHtcbiAgICBpZiAoZS50YXJnZXQuY2xvc2VzdCgnYnV0dG9uLCBpbnB1dCwgdGV4dGFyZWEsIHNlbGVjdCcpKSByZXR1cm47XG4gICAgaXNEcmFnZ2luZyA9IHRydWU7XG4gICAgY29uc3QgcmVjdCA9IHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIG9mZnNldC54ID0gZS5jbGllbnRYIC0gcmVjdC5sZWZ0O1xuICAgIG9mZnNldC55ID0gZS5jbGllbnRZIC0gcmVjdC50b3A7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgZHJhZyk7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2V1cCcsIHN0b3BEcmFnKTtcbn1cbmZ1bmN0aW9uIGRyYWcoZSkge1xuICAgIGlmICghaXNEcmFnZ2luZykgcmV0dXJuO1xuICAgIHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyLnN0eWxlLnJpZ2h0ID0gJ2F1dG8nO1xuICAgIHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyLnN0eWxlLmxlZnQgID0gYCR7ZS5jbGllbnRYIC0gb2Zmc2V0Lnh9cHhgO1xuICAgIHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyLnN0eWxlLnRvcCAgID0gYCR7ZS5jbGllbnRZIC0gb2Zmc2V0Lnl9cHhgO1xufVxuZnVuY3Rpb24gc3RvcERyYWcoKSB7XG4gICAgaXNEcmFnZ2luZyA9IGZhbHNlO1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIGRyYWcpO1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNldXAnLCBzdG9wRHJhZyk7XG59XG5cbi8vIOKUgOKUgOKUgCDQn9Cw0L3QtdC70Ywg0L/RgNCw0LLQuNC7INC60LDQu9GM0LrRg9C70Y/RgtC+0YDQsCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGJ1aWxkQ2FsY1J1bGVzUGFuZWwoKSB7XG4gICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2FsY1J1bGVzUGFuZWwnKTtcbiAgICBpZiAoIXBhbmVsKSByZXR1cm47XG4gICAgcGFuZWwuaW5uZXJIVE1MID0gJyc7XG5cbiAgICBjb25zdCBoZHIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBoZHIuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciA3MnB4IDcycHggODhweCAzMHB4O2dhcDo0cHg7bWFyZ2luLWJvdHRvbTo2cHg7Zm9udC1zaXplOjEwcHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiM0NzU1Njk7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi40cHg7JztcbiAgICBoZHIuaW5uZXJIVE1MID0gJzxzcGFuPtCd0LDQt9Cy0LDQvdC40LU8L3NwYW4+PHNwYW4+JTwvc3Bhbj48c3Bhbj7QntC60YDRg9Cz0LsuPC9zcGFuPjxzcGFuPtCU0L7Qvy48L3NwYW4+PHNwYW4+PC9zcGFuPic7XG4gICAgcGFuZWwuYXBwZW5kQ2hpbGQoaGRyKTtcblxuICAgIGNhbGNSdWxlcy5mb3JFYWNoKChydWxlLCBpKSA9PiB7XG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciA3MnB4IDcycHggODhweCAzMHB4O2dhcDo0cHg7bWFyZ2luLWJvdHRvbTo0cHg7YWxpZ24taXRlbXM6Y2VudGVyOyc7XG5cbiAgICAgICAgY29uc3QgbWtJbnAgPSAodmFsLCBwbGFjZWhvbGRlciwgZmllbGQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGlucCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgICAgICAgICBpbnAudHlwZSA9ICd0ZXh0JzsgaW5wLnZhbHVlID0gdmFsOyBpbnAucGxhY2Vob2xkZXIgPSBwbGFjZWhvbGRlcjtcbiAgICAgICAgICAgIGlucC5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjEwMCU7cGFkZGluZzozcHggNnB4O2JhY2tncm91bmQ6IzFlMjkzYjtib3JkZXI6MXB4IHNvbGlkICMzMzQxNTU7Ym9yZGVyLXJhZGl1czo2cHg7Y29sb3I6I2UyZThmMDtmb250LXNpemU6MTFweDtib3gtc2l6aW5nOmJvcmRlci1ib3g7b3V0bGluZTpub25lO3RyYW5zaXRpb246Ym9yZGVyIC4xNXM7JztcbiAgICAgICAgICAgIGlucC5hZGRFdmVudExpc3RlbmVyKCdmb2N1cycsICgpID0+IGlucC5zdHlsZS5ib3JkZXJDb2xvciA9ICcjNjM2NmYxJyk7XG4gICAgICAgICAgICBpbnAuYWRkRXZlbnRMaXN0ZW5lcignYmx1cicsICAoKSA9PiBpbnAuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzMzNDE1NScpO1xuICAgICAgICAgICAgaW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGNhbGNSdWxlc1tpXVtmaWVsZF0gPSBmaWVsZCA9PT0gJ25hbWUnID8gaW5wLnZhbHVlIDogKHBhcnNlRmxvYXQoaW5wLnZhbHVlKSB8fCAwKTtcbiAgICAgICAgICAgICAgICBzYXZlQ2FsY1J1bGVzKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBpbnA7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3QgZGVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGRlbC50ZXh0Q29udGVudCA9ICfinJUnO1xuICAgICAgICBkZWwuc3R5bGUuY3NzVGV4dCA9ICd3aWR0aDoyNnB4O2hlaWdodDoyNHB4O2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCAjZWY0NDQ0O2JvcmRlci1yYWRpdXM6NXB4O2NvbG9yOiNlZjQ0NDQ7Zm9udC1zaXplOjEwcHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjE1czsnO1xuICAgICAgICBkZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsgZGVsLnN0eWxlLmJhY2tncm91bmQ9JyNlZjQ0NDQnOyBkZWwuc3R5bGUuY29sb3I9JyNmZmYnOyB9KTtcbiAgICAgICAgZGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiB7IGRlbC5zdHlsZS5iYWNrZ3JvdW5kPSd0cmFuc3BhcmVudCc7IGRlbC5zdHlsZS5jb2xvcj0nI2VmNDQ0NCc7IH0pO1xuICAgICAgICBkZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IGNhbGNSdWxlcy5zcGxpY2UoaSwxKTsgc2F2ZUNhbGNSdWxlcygpOyBidWlsZENhbGNSdWxlc1BhbmVsKCk7IH0pO1xuXG4gICAgICAgIGNvbnN0IGV4dHJhVmFsID0gcnVsZS5leHRyYSAhPT0gdW5kZWZpbmVkID8gKHJ1bGUuZXh0cmEgPj0gMCA/ICcrJyArIHJ1bGUuZXh0cmEgOiBTdHJpbmcocnVsZS5leHRyYSkpIDogJzAnO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQobWtJbnAocnVsZS5uYW1lLCAn0J3QsNC30LLQsNC90LjQtScsICduYW1lJykpO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQobWtJbnAocnVsZS5wZXJjZW50LCAnJScsICdwZXJjZW50JykpO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQobWtJbnAocnVsZS5yb3VuZCwgJ9Ce0LrRgNGD0LPQuy4nLCAncm91bmQnKSk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChta0lucChleHRyYVZhbCwgJysvLTAnLCAnZXh0cmEnKSk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChkZWwpO1xuICAgICAgICBwYW5lbC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIH0pO1xuXG4gICAgX2FwcGVuZFJ1bGVzUGFuZWxGb290ZXIocGFuZWwsICdjYWxjJyk7XG59XG5cbi8vIOKUgOKUgOKUgCDQn9Cw0L3QtdC70Ywg0LfQsNC80LXQvSDRgNCw0YHQv9C40YHQsNC90LjRjyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGJ1aWxkU2NoZWR1bGVQYW5lbCgpIHtcbiAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY2hlZHVsZVJ1bGVzUGFuZWwnKTtcbiAgICBpZiAoIXBhbmVsKSByZXR1cm47XG4gICAgcGFuZWwuaW5uZXJIVE1MID0gJyc7XG5cbiAgICBjb25zdCBoZHIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBoZHIuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjEwMHB4IDFmciAyOHB4O2dhcDo0cHg7bWFyZ2luLWJvdHRvbTo2cHg7Zm9udC1zaXplOjEwcHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiM0NzU1Njk7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi40cHg7JztcbiAgICBoZHIuaW5uZXJIVE1MID0gJzxzcGFuPtCa0LvRjtGHPC9zcGFuPjxzcGFuPtCX0L3QsNGH0LXQvdC40LUgKNC30LDQvNC10L3QsCk8L3NwYW4+PHNwYW4+PC9zcGFuPic7XG4gICAgcGFuZWwuYXBwZW5kQ2hpbGQoaGRyKTtcblxuICAgIE9iamVjdC5lbnRyaWVzKHNjaGVkdWxlUmVwbGFjZW1lbnRzKS5mb3JFYWNoKChba2V5LCB2YWxdKSA9PiB7XG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjEwMHB4IDFmciAyOHB4O2dhcDo0cHg7bWFyZ2luLWJvdHRvbTo0cHg7YWxpZ24taXRlbXM6Y2VudGVyOyc7XG5cbiAgICAgICAgY29uc3QgbWtJbnAgPSAodiwgcGgsIG9uQ2hhbmdlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBpbnAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgICAgICAgICAgaW5wLnR5cGUgPSAndGV4dCc7IGlucC52YWx1ZSA9IHY7IGlucC5wbGFjZWhvbGRlciA9IHBoO1xuICAgICAgICAgICAgaW5wLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MTAwJTtwYWRkaW5nOjNweCA2cHg7YmFja2dyb3VuZDojMWUyOTNiO2JvcmRlcjoxcHggc29saWQgIzMzNDE1NTtib3JkZXItcmFkaXVzOjZweDtjb2xvcjojZTJlOGYwO2ZvbnQtc2l6ZToxMXB4O2JveC1zaXppbmc6Ym9yZGVyLWJveDtvdXRsaW5lOm5vbmU7dHJhbnNpdGlvbjpib3JkZXIgLjE1czsnO1xuICAgICAgICAgICAgaW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4gaW5wLnN0eWxlLmJvcmRlckNvbG9yID0gJyM2MzY2ZjEnKTtcbiAgICAgICAgICAgIGlucC5hZGRFdmVudExpc3RlbmVyKCdibHVyJywgICgpID0+IGlucC5zdHlsZS5ib3JkZXJDb2xvciA9ICcjMzM0MTU1Jyk7XG4gICAgICAgICAgICBpbnAuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiBvbkNoYW5nZShpbnAudmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiBpbnA7XG4gICAgICAgIH07XG5cbiAgICAgICAgY29uc3Qgb2xkS2V5ID0ga2V5O1xuICAgICAgICBjb25zdCBrZXlJbnAgPSBta0lucChrZXksICfQutC70Y7RhycsIG5ld0tleSA9PiB7XG4gICAgICAgICAgICBpZiAobmV3S2V5ICE9PSBvbGRLZXkpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0bXAgPSB7IC4uLnNjaGVkdWxlUmVwbGFjZW1lbnRzIH07XG4gICAgICAgICAgICAgICAgZGVsZXRlIHRtcFtvbGRLZXldO1xuICAgICAgICAgICAgICAgIHRtcFtuZXdLZXldID0gc2NoZWR1bGVSZXBsYWNlbWVudHNbb2xkS2V5XTtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50cyA9IHRtcDtcbiAgICAgICAgICAgICAgICBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHZhbElucCA9IG1rSW5wKHZhbCwgJ9C30LDQvNC10L3QsCcsIG5ld1ZhbCA9PiB7XG4gICAgICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50c1trZXldID0gbmV3VmFsO1xuICAgICAgICAgICAgc2F2ZVNjaGVkdWxlUmVwbGFjZW1lbnRzKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGRlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBkZWwudGV4dENvbnRlbnQgPSAn4pyVJztcbiAgICAgICAgZGVsLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MjRweDtoZWlnaHQ6MjRweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgI2VmNDQ0NDtib3JkZXItcmFkaXVzOjVweDtjb2xvcjojZWY0NDQ0O2ZvbnQtc2l6ZToxMHB4O2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246YWxsIC4xNXM7ZmxleC1zaHJpbms6MDsnO1xuICAgICAgICBkZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsgZGVsLnN0eWxlLmJhY2tncm91bmQ9JyNlZjQ0NDQnOyBkZWwuc3R5bGUuY29sb3I9JyNmZmYnOyB9KTtcbiAgICAgICAgZGVsLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiB7IGRlbC5zdHlsZS5iYWNrZ3JvdW5kPSd0cmFuc3BhcmVudCc7IGRlbC5zdHlsZS5jb2xvcj0nI2VmNDQ0NCc7IH0pO1xuICAgICAgICBkZWwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBkZWxldGUgc2NoZWR1bGVSZXBsYWNlbWVudHNba2V5XTtcbiAgICAgICAgICAgIHNhdmVTY2hlZHVsZVJlcGxhY2VtZW50cygpO1xuICAgICAgICAgICAgYnVpbGRTY2hlZHVsZVBhbmVsKCk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChrZXlJbnApO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQodmFsSW5wKTtcbiAgICAgICAgcm93LmFwcGVuZENoaWxkKGRlbCk7XG4gICAgICAgIHBhbmVsLmFwcGVuZENoaWxkKHJvdyk7XG4gICAgfSk7XG5cbiAgICBfYXBwZW5kUnVsZXNQYW5lbEZvb3RlcihwYW5lbCwgJ3NjaGVkdWxlJyk7XG59XG5cbi8vINCe0LHRidC40LkgXCLQv9C+0LTQstCw0LtcIiDQv9Cw0L3QtdC70LXQuSDRgSDQutC90L7Qv9C60LDQvNC4ICsgSlNPTi3RgNC10LTQsNC60YLQvtGA0L7QvFxuZnVuY3Rpb24gX2FwcGVuZFJ1bGVzUGFuZWxGb290ZXIocGFuZWwsIHR5cGUpIHtcbiAgICBjb25zdCBpc0NhbGMgPSB0eXBlID09PSAnY2FsYyc7XG4gICAgY29uc3QganNvbkFyZWFJZCA9IGlzQ2FsYyA/ICdjYWxjUnVsZXNKc29uQXJlYScgOiAnc2NoZWR1bGVKc29uQXJlYSc7XG5cbiAgICBjb25zdCBhZGRSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBhZGRSb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjVweDttYXJnaW4tdG9wOjhweDtmbGV4LXdyYXA6d3JhcDsnO1xuXG4gICAgY29uc3QgbWtCdG4gPSAobGFiZWwsIGNzcywgb25DbGljaykgPT4ge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGIuaW5uZXJIVE1MID0gbGFiZWw7IGIuc3R5bGUuY3NzVGV4dCA9IGNzcztcbiAgICAgICAgYi5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4gYi5zdHlsZS5vcGFjaXR5ID0gJy44Jyk7XG4gICAgICAgIGIuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IGIuc3R5bGUub3BhY2l0eSA9ICcxJyk7XG4gICAgICAgIGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvbkNsaWNrKTtcbiAgICAgICAgcmV0dXJuIGI7XG4gICAgfTtcblxuICAgIGFkZFJvdy5hcHBlbmRDaGlsZChta0J0bign77yLINCU0L7QsdCw0LLQuNGC0YwnLFxuICAgICAgICAnZmxleDoxO3BhZGRpbmc6NHB4IDhweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzYzNjZmMSwjOGI1Y2Y2KTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojZmZmO2ZvbnQtc2l6ZToxMXB4O2N1cnNvcjpwb2ludGVyO2ZvbnQtd2VpZ2h0OjYwMDsnLFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoaXNDYWxjKSB7XG4gICAgICAgICAgICAgICAgY2FsY1J1bGVzLnB1c2goeyBuYW1lOiAn0J3QvtCy0L7QtScsIHBlcmNlbnQ6IDEwMCwgcm91bmQ6IDEsIGV4dHJhOiAwIH0pO1xuICAgICAgICAgICAgICAgIHNhdmVDYWxjUnVsZXMoKTsgYnVpbGRDYWxjUnVsZXNQYW5lbCgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50c1sn0L3QvtCy0YvQuV/QutC70Y7RhyddID0gJ9CX0LDQvNC10L3QsCc7XG4gICAgICAgICAgICAgICAgc2F2ZVNjaGVkdWxlUmVwbGFjZW1lbnRzKCk7IGJ1aWxkU2NoZWR1bGVQYW5lbCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgKSk7XG5cbiAgICBhZGRSb3cuYXBwZW5kQ2hpbGQobWtCdG4oJ+KGuiDQodCx0YDQvtGBJyxcbiAgICAgICAgJ3BhZGRpbmc6NHB4IDhweDtiYWNrZ3JvdW5kOiNmZmZmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7JyxcbiAgICAgICAgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFjb25maXJtKCfQodCx0YDQvtGB0LjRgtGMINC6INC30L3QsNGH0LXQvdC40Y/QvCDQv9C+INGD0LzQvtC70YfQsNC90LjRjj8nKSkgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKGlzQ2FsYykgeyBjYWxjUnVsZXMgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfQ0FMQ19SVUxFUykpOyBzYXZlQ2FsY1J1bGVzKCk7IGJ1aWxkQ2FsY1J1bGVzUGFuZWwoKTsgfVxuICAgICAgICAgICAgZWxzZSB7IHNjaGVkdWxlUmVwbGFjZW1lbnRzID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX1JFUExBQ0VNRU5UUykpOyBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKTsgYnVpbGRTY2hlZHVsZVBhbmVsKCk7IH1cbiAgICAgICAgfVxuICAgICkpO1xuXG4gICAgYWRkUm93LmFwcGVuZENoaWxkKG1rQnRuKCd7IH0gSlNPTicsXG4gICAgICAgICdwYWRkaW5nOjRweCA4cHg7YmFja2dyb3VuZDojZmZmZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMXB4O2N1cnNvcjpwb2ludGVyOycsXG4gICAgICAgICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGphID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoanNvbkFyZWFJZCk7XG4gICAgICAgICAgICBpZiAoamEuc3R5bGUuZGlzcGxheSA9PT0gJ25vbmUnKSB7XG4gICAgICAgICAgICAgICAgamEudmFsdWUgPSBKU09OLnN0cmluZ2lmeShpc0NhbGMgPyBjYWxjUnVsZXMgOiBzY2hlZHVsZVJlcGxhY2VtZW50cywgbnVsbCwgMik7XG4gICAgICAgICAgICAgICAgamEuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGphLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICApKTtcblxuICAgIHBhbmVsLmFwcGVuZENoaWxkKGFkZFJvdyk7XG5cbiAgICAvLyBKU09OIHRleHRhcmVhXG4gICAgY29uc3QgamEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0ZXh0YXJlYScpO1xuICAgIGphLmlkID0ganNvbkFyZWFJZDtcbiAgICBqYS5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6bm9uZTt3aWR0aDoxMDAlO2hlaWdodDoxMTBweDttYXJnaW4tdG9wOjdweDtwYWRkaW5nOjdweDtiYWNrZ3JvdW5kOiNmZmZmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6OHB4O2NvbG9yOiMzMzQxNTU7Zm9udC1zaXplOjExcHg7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2JveC1zaXppbmc6Ym9yZGVyLWJveDtyZXNpemU6dmVydGljYWw7b3V0bGluZTpub25lOyc7XG4gICAgamEuc3BlbGxjaGVjayA9IGZhbHNlO1xuICAgIGphLmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGphLnZhbHVlKTtcbiAgICAgICAgICAgIGlmIChpc0NhbGMpIHsgY2FsY1J1bGVzID0gcGFyc2VkOyBzYXZlQ2FsY1J1bGVzKCk7IGJ1aWxkQ2FsY1J1bGVzUGFuZWwoKTsgfVxuICAgICAgICAgICAgZWxzZSB7IHNjaGVkdWxlUmVwbGFjZW1lbnRzID0gcGFyc2VkOyBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKTsgYnVpbGRTY2hlZHVsZVBhbmVsKCk7IH1cbiAgICAgICAgICAgIGphLnN0eWxlLmJvcmRlckNvbG9yID0gJyMyMmM1NWUnO1xuICAgICAgICB9IGNhdGNoIHsgamEuc3R5bGUuYm9yZGVyQ29sb3IgPSAnI2VmNDQ0NCc7IH1cbiAgICB9KTtcbiAgICBwYW5lbC5hcHBlbmRDaGlsZChqYSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQodC60YDRi9GC0LjQtSDQv9C+0LvQtdC5INCc0L7QudCh0LrQu9Cw0LQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQn9C+0LvQtSDQv9GA0Y/Rh9C10YLRgdGPINC/0L4g0YLQvtGH0L3QvtC80YMg0YLQtdC60YHRgtGDINC70LXQudCx0LvQsC4g0J/QvtC00LTQtdGA0LbQuNCy0LDRjtGC0YHRjyDRgtGA0Lgg0YTQvtGA0LzRiyDQnNC+0LnQodC60LvQsNC0OlxuLy8gIGEpIFJlYWN0LdC/0L7Qu9C1INGE0L7RgNC80Ys6IC5mb3JtSXRlbVRpdGxlICjQu9C10LnQsdC7KSArINGB0LvQtdC00YPRjtGJ0LjQuSDQv9GD0YHRgtC+0LkgRElWICjQt9C90LDRh9C10L3QuNC1KVxuLy8gIGIpIFJlYWN0LdCx0LvQvtC6INC40YLQvtCz0L7Qsjog0LvQtdC50LHQuyArINC30L3QsNGH0LXQvdC40LUg4oCUINGB0L7RgdC10LTQvdC40LUgRElWINCy0L3Rg9GC0YDQuCBbY2xhc3MqPVwidG90YWxzV3JhcHBlclwiXVxuLy8gIGMpIEdXVC3RgtCw0LHQu9C40YbQsDog0YHRgtGA0L7QutCwIHRyINGBINGP0YfQtdC50LrQvtC5IFRELmxlZ2VuZFxuLy8g0KHQutGA0YvRgtGL0LUg0YbQtdC70Lgg0LfQsNC/0L7QvNC40L3QsNGO0YLRgdGPINCyIG1zSGlkZGVuVGFyZ2V0cywg0YfRgtC+0LHRiyDQvNC+0LbQvdC+INCx0YvQu9C+INCy0LXRgNC90YPRgtGMINC+0YLQvtCx0YDQsNC20LXQvdC40LUuXG5cbmZ1bmN0aW9uIG1zRmluZExhYmVsRWxlbWVudChuYW1lKSB7XG4gICAgY29uc3Qgd2Fsa2VyID0gZG9jdW1lbnQuY3JlYXRlVHJlZVdhbGtlcihkb2N1bWVudC5ib2R5LCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7XG4gICAgbGV0IG5vZGU7XG4gICAgd2hpbGUgKG5vZGUgPSB3YWxrZXIubmV4dE5vZGUoKSkge1xuICAgICAgICBpZiAoKG5vZGUudGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKSAhPT0gbmFtZSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGVsID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgICAgICBpZiAoIWVsIHx8IGVsLm9mZnNldEhlaWdodCA8PSAwKSBjb250aW51ZTtcbiAgICAgICAgLy8gYSkgUmVhY3Qt0L/QvtC70LUg0YTQvtGA0LzRi1xuICAgICAgICBpZiAoZWwuY2xvc2VzdCgnW2NsYXNzKj1cImZvcm1JdGVtVGl0bGVcIl0nKSkgcmV0dXJuIGVsLmNsb3Nlc3QoJ1tjbGFzcyo9XCJmb3JtSXRlbVRpdGxlXCJdJyk7XG4gICAgICAgIC8vIGIpIFJlYWN0LdCx0LvQvtC6INC40YLQvtCz0L7Qsjog0LvQtdC50LHQuyDigJQg0L/RgNGP0LzQvtC5INGA0LXQsdGR0L3QvtC6IHRvdGFsc1dyYXBwZXJcbiAgICAgICAgY29uc3Qgd3JhcCA9IGVsLmNsb3Nlc3QoJ1tjbGFzcyo9XCJ0b3RhbHNXcmFwcGVyXCJdJyk7XG4gICAgICAgIGlmICh3cmFwKSB7XG4gICAgICAgICAgICBsZXQgY3VyID0gZWw7XG4gICAgICAgICAgICB3aGlsZSAoY3VyLnBhcmVudEVsZW1lbnQgJiYgY3VyLnBhcmVudEVsZW1lbnQgIT09IHdyYXApIGN1ciA9IGN1ci5wYXJlbnRFbGVtZW50O1xuICAgICAgICAgICAgcmV0dXJuIGN1cjtcbiAgICAgICAgfVxuICAgICAgICAvLyBjKSBHV1Qt0YLQsNCx0LvQuNGG0LAgKNGP0YfQtdC50LrQsC3Qu9C10LPQtdC90LTQsClcbiAgICAgICAgY29uc3QgbGVnZW5kID0gZWwuY2xvc2VzdCgndGQubGVnZW5kJyk7XG4gICAgICAgIGlmIChsZWdlbmQpIHJldHVybiBsZWdlbmQ7XG4gICAgICAgIC8vIGZhbGxiYWNrOiDQu9C10LnQsdC7INCyINC90LXQuNC30LLQtdGB0YLQvdC+0Lkg0YHRgtGA0YPQutGC0YPRgNC1IOKAlCDQsdC10YDRkdC8INGB0LDQvCDRjdC70LXQvNC10L3RglxuICAgICAgICByZXR1cm4gZWw7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBtc0NvbGxlY3RUYXJnZXRzKG5hbWUpIHtcbiAgICBjb25zdCB0YXJnZXRzID0gW107XG4gICAgY29uc3QgdGl0bGUgPSBtc0ZpbmRMYWJlbEVsZW1lbnQobmFtZSk7XG4gICAgaWYgKCF0aXRsZSkgcmV0dXJuIHRhcmdldHM7XG5cbiAgICBjb25zdCBjbHMgPSBTdHJpbmcodGl0bGUuY2xhc3NOYW1lIHx8ICcnKTtcbiAgICBpZiAoY2xzLmluY2x1ZGVzKCdmb3JtSXRlbVRpdGxlJykpIHtcbiAgICAgICAgLy8gYSkg0LvQtdC50LHQuyArINGB0L7RgdC10LTQvdGP0Y8g0Y/Rh9C10LnQutCwINC30L3QsNGH0LXQvdC40Y9cbiAgICAgICAgY29uc3QgcGFyZW50ID0gdGl0bGUucGFyZW50RWxlbWVudDtcbiAgICAgICAgY29uc3QgaWR4ID0gQXJyYXkucHJvdG90eXBlLmluZGV4T2YuY2FsbChwYXJlbnQuY2hpbGRyZW4sIHRpdGxlKTtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBwYXJlbnQuY2hpbGRyZW5baWR4ICsgMV07XG4gICAgICAgIGlmICh2YWx1ZSAmJiAhU3RyaW5nKHZhbHVlLmNsYXNzTmFtZSB8fCAnJykuaW5jbHVkZXMoJ2Zvcm1JdGVtVGl0bGUnKSkge1xuICAgICAgICAgICAgdGFyZ2V0cy5wdXNoKHRpdGxlLCB2YWx1ZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0YXJnZXRzLnB1c2godGl0bGUpO1xuICAgICAgICB9XG4gICAgfSBlbHNlIGlmICh0aXRsZS50YWdOYW1lID09PSAnVEQnKSB7XG4gICAgICAgIC8vIGMpIEdXVDog0L/RgNGP0YfQtdC8INCy0YHRjiDRgdGC0YDQvtC60YMg0YLQsNCx0LvQuNGG0YtcbiAgICAgICAgY29uc3Qgcm93ID0gdGl0bGUuY2xvc2VzdCgndHInKTtcbiAgICAgICAgdGFyZ2V0cy5wdXNoKHJvdyB8fCB0aXRsZSk7XG4gICAgfSBlbHNlIGlmICh0aXRsZS5wYXJlbnRFbGVtZW50ICYmIFN0cmluZyh0aXRsZS5wYXJlbnRFbGVtZW50LmNsYXNzTmFtZSB8fCAnJykuaW5jbHVkZXMoJ3RvdGFsc1dyYXBwZXInKSkge1xuICAgICAgICAvLyBiKSDQuNGC0L7Qs9C4OiDQu9C10LnQsdC7ICsg0LfQvdCw0YfQtdC90LjQtS3RgdC+0YHQtdC0XG4gICAgICAgIHRhcmdldHMucHVzaCh0aXRsZSk7XG4gICAgICAgIGlmICh0aXRsZS5uZXh0RWxlbWVudFNpYmxpbmcpIHRhcmdldHMucHVzaCh0aXRsZS5uZXh0RWxlbWVudFNpYmxpbmcpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIGZhbGxiYWNrOiDQv9GA0Y/Rh9C10Lwg0YHQsNC8INGN0LvQtdC80LXQvdGCINC70LXQudCx0LvQsCArINGB0L7RgdC10LTQsC3Qt9C90LDRh9C10L3QuNC1XG4gICAgICAgIHRhcmdldHMucHVzaCh0aXRsZSk7XG4gICAgICAgIGlmICh0aXRsZS5uZXh0RWxlbWVudFNpYmxpbmcpIHRhcmdldHMucHVzaCh0aXRsZS5uZXh0RWxlbWVudFNpYmxpbmcpO1xuICAgIH1cbiAgICByZXR1cm4gdGFyZ2V0cy5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmZ1bmN0aW9uIGFwcGx5TXNIaWRkZW5GaWVsZHMoKSB7XG4gICAgaWYgKCEvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSByZXR1cm47XG4gICAgaWYgKG1zRmllbGRzUmV2ZWFsZWQgfHwgIWhpZGRlbkZpZWxkcy5sZW5ndGgpIHJldHVybjtcblxuICAgIG1zSGlkZGVuVGFyZ2V0cy5mb3JFYWNoKHQgPT4geyB0LmVsLnN0eWxlLmRpc3BsYXkgPSAnJzsgfSk7XG4gICAgbXNIaWRkZW5UYXJnZXRzID0gW107XG5cbiAgICBoaWRkZW5GaWVsZHMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgICAgbXNDb2xsZWN0VGFyZ2V0cyhuYW1lKS5mb3JFYWNoKGVsID0+IHtcbiAgICAgICAgICAgIGVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgICAgICBtc0hpZGRlblRhcmdldHMucHVzaCh7IGVsLCBuYW1lIH0pO1xuICAgICAgICB9KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzdG9yZU1zRmllbGRzKCkge1xuICAgIG1zSGlkZGVuVGFyZ2V0cy5mb3JFYWNoKHQgPT4geyB0LmVsLnN0eWxlLmRpc3BsYXkgPSAnJzsgfSk7XG4gICAgbXNIaWRkZW5UYXJnZXRzID0gW107XG59XG5cbmZ1bmN0aW9uIHRvZ2dsZU1zRmllbGRzUmV2ZWFsZWQoKSB7XG4gICAgbXNGaWVsZHNSZXZlYWxlZCA9ICFtc0ZpZWxkc1JldmVhbGVkO1xuICAgIGlmIChtc0ZpZWxkc1JldmVhbGVkKSB7XG4gICAgICAgIHJlc3RvcmVNc0ZpZWxkcygpO1xuICAgICAgICBzZXRTdGF0dXNUZXh0KCfwn5GBINCh0LrRgNGL0YLRi9C1INC/0L7Qu9GPINC/0L7QutCw0LfQsNC90YsgKNC90LDQttC80LjRgtC1INC10YnRkSDRgNCw0LcsINGH0YLQvtCx0Ysg0YHQv9GA0Y/RgtCw0YLRjCknKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBhcHBseU1zSGlkZGVuRmllbGRzKCk7XG4gICAgICAgIHNldFN0YXR1c1RleHQoJ/CfmYgg0KHQutGA0YvRgtGL0LUg0L/QvtC70Y8g0YHQv9GA0Y/RgtCw0L3RiycpO1xuICAgIH1cbiAgICB1cGRhdGVNc1JldmVhbEJ1dHRvbigpO1xufVxuXG4vLyDQn9Cw0L3QtdC70Ywg0L3QsNGB0YLRgNC+0LnQutC4INGB0LrRgNGL0YLRi9GFINC/0L7Qu9C10LkgKNCyINC+0LrQvdC1INC90LDRgdGC0YDQvtC10LopXG5mdW5jdGlvbiBidWlsZE1zRmllbGRzUGFuZWwoKSB7XG4gICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNGaWVsZHNQYW5lbCcpO1xuICAgIGlmICghcGFuZWwpIHJldHVybjtcbiAgICBwYW5lbC5pbm5lckhUTUwgPSAnJztcbiAgICBpZiAoIS9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIHtcbiAgICAgICAgY29uc3Qgbm90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBub3RlLnN0eWxlLmNzc1RleHQgPSAnZm9udC1zaXplOjExcHg7Y29sb3I6IzY0NzQ4YjtwYWRkaW5nOjRweCAwOyc7XG4gICAgICAgIG5vdGUudGV4dENvbnRlbnQgPSAn0JTQvtGB0YLRg9C/0L3QviDRgtC+0LvRjNC60L4g0L3QsCBvbmxpbmUubW95c2tsYWQucnUnO1xuICAgICAgICBwYW5lbC5hcHBlbmRDaGlsZChub3RlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGZpZWxkcyA9IFsuLi5LTk9XTl9NU19GSUVMRFNdO1xuICAgIGhpZGRlbkZpZWxkcy5mb3JFYWNoKG4gPT4geyBpZiAoIWZpZWxkcy5pbmNsdWRlcyhuKSkgZmllbGRzLnB1c2gobik7IH0pO1xuXG4gICAgZmllbGRzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcbiAgICAgICAgbGFiZWwuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTEuNXB4O21hcmdpbi1ib3R0b206NXB4O2N1cnNvcjpwb2ludGVyOyc7XG4gICAgICAgIGNvbnN0IGNiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICAgICAgY2IudHlwZSA9ICdjaGVja2JveCc7XG4gICAgICAgIGNiLmNoZWNrZWQgPSBoaWRkZW5GaWVsZHMuaW5jbHVkZXMobmFtZSk7XG4gICAgICAgIGNiLnN0eWxlLmNzc1RleHQgPSAnYWNjZW50LWNvbG9yOiM2MzY2ZjE7d2lkdGg6MTNweDtoZWlnaHQ6MTNweDsnO1xuICAgICAgICBjYi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoY2IuY2hlY2tlZCkge1xuICAgICAgICAgICAgICAgIGlmICghaGlkZGVuRmllbGRzLmluY2x1ZGVzKG5hbWUpKSBoaWRkZW5GaWVsZHMucHVzaChuYW1lKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaGlkZGVuRmllbGRzID0gaGlkZGVuRmllbGRzLmZpbHRlcihuID0+IG4gIT09IG5hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2F2ZUhpZGRlbkZpZWxkcygpO1xuICAgICAgICAgICAgaWYgKCFtc0ZpZWxkc1JldmVhbGVkKSBhcHBseU1zSGlkZGVuRmllbGRzKCk7IGVsc2UgcmVzdG9yZU1zRmllbGRzKCk7XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBzcGFuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xuICAgICAgICBzcGFuLnRleHRDb250ZW50ID0gbmFtZTtcbiAgICAgICAgbGFiZWwuYXBwZW5kQ2hpbGQoY2IpO1xuICAgICAgICBsYWJlbC5hcHBlbmRDaGlsZChzcGFuKTtcbiAgICAgICAgcGFuZWwuYXBwZW5kQ2hpbGQobGFiZWwpO1xuICAgIH0pO1xuXG4gICAgLy8g0JrQsNGB0YLQvtC80L3QvtC1INC/0L7Qu9C1OiDRgdCy0L7QuSDRgtC10LrRgdGCINC70LXQudCx0LvQsFxuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHJvdy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtnYXA6NXB4O21hcmdpbi10b3A6NnB4Oyc7XG4gICAgY29uc3QgaW5wID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICBpbnAudHlwZSA9ICd0ZXh0JztcbiAgICBpbnAucGxhY2Vob2xkZXIgPSAn0KHQstC+0ZEg0L/QvtC70LU6INGC0L7Rh9C90YvQuSDRgtC10LrRgdGCINC70LXQudCx0LvQsOKApic7XG4gICAgaW5wLnN0eWxlLmNzc1RleHQgPSAnZmxleDoxO3BhZGRpbmc6NHB4IDdweDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2NvbG9yOiMzMzQxNTU7Zm9udC1zaXplOjExcHg7b3V0bGluZTpub25lO2JveC1zaXppbmc6Ym9yZGVyLWJveDsnO1xuICAgIGNvbnN0IGFkZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGFkZC50ZXh0Q29udGVudCA9ICfvvIsnO1xuICAgIGFkZC5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjI4cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM2MzY2ZjEsIzhiNWNmNik7Ym9yZGVyOm5vbmU7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6I2ZmZjtmb250LXNpemU6MTNweDtjdXJzb3I6cG9pbnRlcjtmb250LXdlaWdodDo3MDA7JztcbiAgICBhZGQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHYgPSAoaW5wLnZhbHVlIHx8ICcnKS50cmltKCk7XG4gICAgICAgIGlmICghdikgcmV0dXJuO1xuICAgICAgICBpZiAoIWhpZGRlbkZpZWxkcy5pbmNsdWRlcyh2KSkgaGlkZGVuRmllbGRzLnB1c2godik7XG4gICAgICAgIHNhdmVIaWRkZW5GaWVsZHMoKTtcbiAgICAgICAgaWYgKCFtc0ZpZWxkc1JldmVhbGVkKSBhcHBseU1zSGlkZGVuRmllbGRzKCk7IGVsc2UgcmVzdG9yZU1zRmllbGRzKCk7XG4gICAgICAgIGJ1aWxkTXNGaWVsZHNQYW5lbCgpO1xuICAgICAgICBzZXRTdGF0dXNUZXh0KGDwn5GBINCf0L7Qu9C1IMKrJHt2fcK7INC00L7QsdCw0LLQu9C10L3QviDQsiDRgdC60YDRi9GC0YvQtWApO1xuICAgIH0pO1xuICAgIGlucC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZSA9PiB7IGlmIChlLmtleSA9PT0gJ0VudGVyJykgYWRkLmNsaWNrKCk7IH0pO1xuICAgIHJvdy5hcHBlbmRDaGlsZChpbnApO1xuICAgIHJvdy5hcHBlbmRDaGlsZChhZGQpO1xuICAgIHBhbmVsLmFwcGVuZENoaWxkKHJvdyk7XG59XG5cbi8vINCf0LvQsNCy0LDRjtGJ0LDRjyDQutC90L7Qv9C60LAg8J+RgSDCq9C/0L7QutCw0LfQsNGC0Ywg0YHQutGA0YvRgtGL0LXCuyDigJQg0L/QvtGP0LLQu9GP0LXRgtGB0Y8g0L3QsCDQnNC+0LnQodC60LvQsNC0LCDQutC+0LPQtNCwINC10YHRgtGMINGH0YLQviDQv9GA0Y/RgtCw0YLRjFxuZnVuY3Rpb24gdXBkYXRlTXNSZXZlYWxCdXR0b24oKSB7XG4gICAgaWYgKCEvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSByZXR1cm47XG4gICAgbGV0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY01zUmV2ZWFsQnRuJyk7XG4gICAgaWYgKCFoaWRkZW5GaWVsZHMubGVuZ3RoKSB7XG4gICAgICAgIGlmIChidG4pIGJ0bi5yZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWJ0bikge1xuICAgICAgICBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgYnRuLmlkID0gJ21jTXNSZXZlYWxCdG4nO1xuICAgICAgICBidG4udHlwZSA9ICdidXR0b24nO1xuICAgICAgICBidG4udGV4dENvbnRlbnQgPSAn8J+RgSc7XG4gICAgICAgIGJ0bi50aXRsZSA9ICfQn9C+0LrQsNC30LDRgtGML9GB0LrRgNGL0YLRjCDRgdC/0YDRj9GC0LDQvdC90YvQtSDQv9C+0LvRjyc7XG4gICAgICAgIGJ0bi5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO2xlZnQ6OHB4O2JvdHRvbTo4cHg7ei1pbmRleDoyMTQ3NDgzMDAwO3dpZHRoOjMwcHg7aGVpZ2h0OjMwcHg7J1xuICAgICAgICAgICAgKyAnYmFja2dyb3VuZDpyZ2JhKDE1LDIzLDQyLC44Mik7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDE0OCwxNjMsMTg0LC41KTtib3JkZXItcmFkaXVzOjUwJTsnXG4gICAgICAgICAgICArICdjb2xvcjojZTJlOGYwO2ZvbnQtc2l6ZToxNHB4O2N1cnNvcjpwb2ludGVyO29wYWNpdHk6LjU1O3RyYW5zaXRpb246b3BhY2l0eSAuMTVzOydcbiAgICAgICAgICAgICsgJ2JveC1zaGFkb3c6MCAycHggOHB4IHJnYmEoMCwwLDAsLjM1KTtwYWRkaW5nOjA7bGluZS1oZWlnaHQ6MTsnO1xuICAgICAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IGJ0bi5zdHlsZS5vcGFjaXR5ID0gJzEnKTtcbiAgICAgICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiBidG4uc3R5bGUub3BhY2l0eSA9ICcwLjU1Jyk7XG4gICAgICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHRvZ2dsZU1zRmllbGRzUmV2ZWFsZWQpO1xuICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGJ0bik7XG4gICAgfVxuICAgIGJ0bi50ZXh0Q29udGVudCA9IG1zRmllbGRzUmV2ZWFsZWQgPyAn8J+ZiCcgOiAn8J+RgSc7XG4gICAgYnRuLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xufVxuXG4vLyDilIDilIDilIAg0J/QsNC90LXQu9GMINCx0YvRgdGC0YDRi9GFINC60L3QvtC/0L7QuiDQnNC+0LnQodC60LvQsNC0ICjRgdC+0LfQtNCw0YLRjC/Qv9C10YfQsNGC0YwpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8g0JrQvdC+0L/QutC4LdC00YPQsdC70Lgg0YLRg9C70LHQsNGA0LAg0LrQsNGA0YLQvtGH0LrQuDog0LrQu9C40LogPSDQvtGC0LrRgNGL0YLRjCDQvNC10L3RjiDRgtGD0LvQsdCw0YDQsCDQuCDQstGL0LHRgNCw0YLRjCDQv9GD0L3QutGCLlxuLy8g0J/QvtC00LTQtdGA0LbQuNCy0LDRjtGC0YHRjyDQvtCx0LAg0LzQtdGF0LDQvdC40LfQvNCwINC80LXQvdGOOiBSZWFjdC3QtNGA0L7Qv9C00LDRg9C90Ysg0LggR1dULdC/0L7Qv9Cw0L/Riy5cblxuZnVuY3Rpb24gbXNHZXRUb29sYmFyQnV0dG9uKGxhYmVsKSB7XG4gICAgLy8g0J3QvtCy0YvQuSDQtNC40LfQsNC50L0g0JzQvtC50KHQutC70LDQtCDigJQg0L3QsNGB0YLQvtGP0YnQuNC1IDxidXR0b24+LCDRgdGC0LDRgNGL0LkgKEdXVCkg4oCUIERJVi5idG5cbiAgICByZXR1cm4gWy4uLmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbiwgW3JvbGU9YnV0dG9uXSwgLmJ0bicpXVxuICAgICAgICAuZmluZChiID0+IChiLnRleHRDb250ZW50IHx8ICcnKS50cmltKCkgPT09IGxhYmVsICYmIGIub2Zmc2V0SGVpZ2h0ID4gMCAmJiAhYi5kaXNhYmxlZCk7XG59XG5cbi8vIEdXVC9SZWFjdC3Qv9GD0L3QutGC0Ysg0LzQtdC90Y4g0LjQs9C90L7RgNC40YDRg9GO0YIg0LPQvtC70YvQuSAuY2xpY2soKSDigJQg0L3Rg9C20LXQvSDQv9C+0LvQvdGL0Lkg0LbQtdGB0YIg0LzRi9GI0LhcbmZ1bmN0aW9uIG1zU3ludGhldGljQ2xpY2soZWwpIHtcbiAgICBjb25zdCByID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgY29uc3Qgb3B0cyA9IHsgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZSwgY2xpZW50WDogci54ICsgci53aWR0aCAvIDIsIGNsaWVudFk6IHIueSArIHIuaGVpZ2h0IC8gMiB9O1xuICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IE1vdXNlRXZlbnQoJ21vdXNlZG93bicsIG9wdHMpKTtcbiAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBNb3VzZUV2ZW50KCdtb3VzZXVwJywgb3B0cykpO1xuICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IE1vdXNlRXZlbnQoJ2NsaWNrJywgb3B0cykpO1xufVxuXG5mdW5jdGlvbiBtc0NsaWNrTWVudUl0ZW0oYnV0dG9uTGFiZWwsIGl0ZW1UZXh0KSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgICBjb25zdCBidG4gPSBtc0dldFRvb2xiYXJCdXR0b24oYnV0dG9uTGFiZWwpO1xuICAgICAgICBpZiAoIWJ0bikgeyByZXNvbHZlKHsgb2s6IGZhbHNlLCB3aHk6IGDQmtC90L7Qv9C60LAgwqske2J1dHRvbkxhYmVsfcK7INC90LUg0L3QsNC50LTQtdC90LBgIH0pOyByZXR1cm47IH1cbiAgICAgICAgbXNTeW50aGV0aWNDbGljayhidG4pO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIC8vIFJlYWN0LdC00YDQvtC/0LTQsNGD0L06INC60LvQuNC60LDQsdC10LvRjNC90YvQuSBkaXZbY2xhc3MqPVwib3B0aW9uXCJdINGBINGC0L7Rh9C90YvQvCDRgtC10LrRgdGC0L7QvFxuICAgICAgICAgICAgbGV0IHRhcmdldCA9IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbY2xhc3MqPVwib3B0aW9uXCJdJyldLnJldmVyc2UoKVxuICAgICAgICAgICAgICAgIC5maW5kKG8gPT4gby5vZmZzZXRIZWlnaHQgPiAwICYmIG8uY2hpbGRyZW4ubGVuZ3RoIDw9IDEgJiYgKG8udGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKSA9PT0gaXRlbVRleHQpO1xuICAgICAgICAgICAgLy8gR1dULdC/0L7Qv9Cw0L86IFRELmd3dC1NZW51SXRlbVxuICAgICAgICAgICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgICAgICAgICAgICB0YXJnZXQgPSBbLi4uZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmd3dC1NZW51SXRlbScpXVxuICAgICAgICAgICAgICAgICAgICAuZmluZChpID0+IGkub2Zmc2V0SGVpZ2h0ID4gMCAmJiAoaS50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpID09PSBpdGVtVGV4dCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICAgICAgICAgIHNldFN0YXR1c1RleHQoYOKaoO+4jyDCqyR7aXRlbVRleHR9wrsg0L3QtSDQvdCw0LnQtNC10L3QviDQsiDQvNC10L3RjiDigJQg0LLRi9Cx0LXRgNC40YLQtSDQstGA0YPRh9C90YPRjmApO1xuICAgICAgICAgICAgICAgIHJlc29sdmUoeyBvazogZmFsc2UsIHdoeTogJ9C/0YPQvdC60YIg0L3QtSDQvdCw0LnQtNC10L0nIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG1zU3ludGhldGljQ2xpY2sodGFyZ2V0KTtcbiAgICAgICAgICAgIHNldFN0YXR1c1RleHQoYOKchSAke2l0ZW1UZXh0fWApO1xuICAgICAgICAgICAgcmVzb2x2ZSh7IG9rOiB0cnVlIH0pO1xuICAgICAgICB9LCA3MDApO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJPcGVuUXVpY2tBY3Rpb25Qb3B1cChhY3Rpb24sIGFuY2hvcikge1xuICAgIGlmICghaGFja2VyQ2FuUnVuKCkpIHJldHVybjtcbiAgICBjb25zdCBvbGQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNIYWNrZXJRdWlja1BvcHVwJyk7XG4gICAgaWYgKG9sZCkgeyBvbGQucmVtb3ZlKCk7IHJldHVybjsgfVxuICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGJveC5pZCA9ICdtY0hhY2tlclF1aWNrUG9wdXAnO1xuICAgIGJveC5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO3otaW5kZXg6MjE0NzQ4MzAwMTt3aWR0aDozMDBweDtwYWRkaW5nOjEycHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjEwcHg7Ym94LXNoYWRvdzowIDhweCAzMHB4ICMwZjE3MmE0MDtmb250OjEycHggU2Vnb2UgVUksc2Fucy1zZXJpZjtjb2xvcjojMzM0MTU1Oyc7XG4gICAgY29uc3QgciA9IGFuY2hvcj8uZ2V0Qm91bmRpbmdDbGllbnRSZWN0Py4oKTtcbiAgICBib3guc3R5bGUubGVmdCA9IGAke01hdGgubWF4KDgsIE1hdGgubWluKChyPy5sZWZ0IHx8IDIwKSwgd2luZG93LmlubmVyV2lkdGggLSAzMjApKX1weGA7XG4gICAgYm94LnN0eWxlLnRvcCA9IGAke01hdGgubWluKChyPy5ib3R0b20gfHwgODApICsgNSwgd2luZG93LmlubmVySGVpZ2h0IC0gMjMwKX1weGA7XG4gICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9IGFjdGlvbiA9PT0gJ2RlbWFuZCcgPyAn4pqhINCe0YLQs9GA0YPQt9C60LAnIDogYWN0aW9uID09PSAnY2FzaGluJyA/ICfimqEg0J/RgNC40YXQvtC00L3Ri9C5INC+0YDQtNC10YAnIDogYWN0aW9uID09PSAncGF5bWVudGluJyA/ICfimqEg0JLRhdC+0LTRj9GJ0LjQuSDQv9C70LDRgtGR0LYnIDogJ+KaoSDQmtGA0LXQtNC40YIv0KDQsNGB0YHRgNC+0YfQutCwJztcbiAgICB0aXRsZS5zdHlsZS5jc3NUZXh0ID0gJ2ZvbnQtd2VpZ2h0OjcwMDttYXJnaW4tYm90dG9tOjhweDsnO1xuICAgIGJveC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gICAgY29uc3QgYWRkSW5wdXQgPSAoaWQsIGxhYmVsLCBwbGFjZWhvbGRlcikgPT4ge1xuICAgICAgICBjb25zdCBsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTsgbC50ZXh0Q29udGVudCA9IGxhYmVsOyBsLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpibG9jazttYXJnaW46NnB4IDAgM3B4O2ZvbnQtd2VpZ2h0OjYwMDsnO1xuICAgICAgICBjb25zdCBpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTsgaS5pZCA9IGlkOyBpLnR5cGUgPSAndGV4dCc7IGkucGxhY2Vob2xkZXIgPSBwbGFjZWhvbGRlciB8fCAnJzsgaS5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX0lOUFVUX0NTUzsgYm94LmFwcGVuZENoaWxkKGwpOyBib3guYXBwZW5kQ2hpbGQoaSk7IHJldHVybiBpO1xuICAgIH07XG4gICAgaWYgKGFjdGlvbiA9PT0gJ2RlbWFuZCcpIHtcbiAgICAgICAgY29uc3QgaGludCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyBoaW50LnRleHRDb250ZW50ID0gJ9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2OiDQutCw0Log0LIg0LfQsNC60LDQt9C1JzsgaGludC5zdHlsZS5jb2xvciA9ICcjNjQ3NDhiJzsgYm94LmFwcGVuZENoaWxkKGhpbnQpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGFkZElucHV0KCdoYWNrZXJTYWxlU3VtJywgYWN0aW9uID09PSAnY3JlZGl0JyA/ICfQntCx0YnQsNGPINGB0YPQvNC80LAnIDogJ9Ch0YPQvNC80LAnLCAnMCcpO1xuICAgICAgICBpZiAoYWN0aW9uID09PSAnY2FzaGluJyB8fCBhY3Rpb24gPT09ICdjcmVkaXQnKSB7XG4gICAgICAgICAgICBhZGRJbnB1dCgnaGFja2VyQ2FzaEFtb3VudCcsICfQndCw0LvQuNGH0L3Ri9C1JywgYWN0aW9uID09PSAnY3JlZGl0JyA/ICcwJyA6ICcnKTtcbiAgICAgICAgICAgIGNvbnN0IHMgPSBoYWNrZXJTZWxlY3QoJ2hhY2tlckNsaWVudFN0YXR1c1NlbGVjdCcsICfQodGC0LDRgtGD0YEg0LrQu9C40LXQvdGC0LAnKTsgcy5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX1NFTEVDVF9DU1M7IGJveC5hcHBlbmRDaGlsZChzKTsgaGFja2VyUmVmcmVzaENsaWVudFN0YXR1c2VzKHRydWUpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdwYXltZW50aW4nIHx8IGFjdGlvbiA9PT0gJ2NyZWRpdCcpIHtcbiAgICAgICAgICAgIGNvbnN0IHMgPSBoYWNrZXJTZWxlY3QoJ2hhY2tlclBheU1ldGhvZFNlbGVjdCcsICfQodC/0L7RgdC+0LEg0L7Qv9C70LDRgtGLJyk7IHMuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9TRUxFQ1RfQ1NTOyBib3guYXBwZW5kQ2hpbGQocyk7IGhhY2tlclJlZnJlc2hQYXlNZXRob2RzKHRydWUpO1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjVweDttYXJnaW4tdG9wOjEwcHg7JztcbiAgICBjb25zdCBnbyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBnby50ZXh0Q29udGVudCA9ICfQodC+0LfQtNCw0YLRjCc7IGdvLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfQlROX0NTUyArICdiYWNrZ3JvdW5kOiM0ZjQ2ZTU7ZmxleDoxOyc7XG4gICAgZ28ub25jbGljayA9IGFzeW5jICgpID0+IHsgaWYgKGFjdGlvbiA9PT0gJ2RlbWFuZCcpIGF3YWl0IGhhY2tlckNyZWF0ZURlbWFuZCgpOyBlbHNlIGlmIChhY3Rpb24gPT09ICdjYXNoaW4nKSBhd2FpdCBoYWNrZXJDcmVhdGVDYXNoaW4oKTsgZWxzZSBpZiAoYWN0aW9uID09PSAncGF5bWVudGluJykgYXdhaXQgaGFja2VyQ3JlYXRlUGF5bWVudGluKCk7IGVsc2UgYXdhaXQgaGFja2VyQ3JlYXRlQ3JlZGl0KCk7IGJveC5yZW1vdmUoKTsgfTtcbiAgICBjb25zdCBjYW5jZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgY2FuY2VsLnRleHRDb250ZW50ID0gJ9Ce0YLQvNC10L3QsCc7IGNhbmNlbC5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX01JTklfQlROX0NTUzsgY2FuY2VsLm9uY2xpY2sgPSAoKSA9PiBib3gucmVtb3ZlKCk7XG4gICAgcm93LmFwcGVuZENoaWxkKGdvKTsgcm93LmFwcGVuZENoaWxkKGNhbmNlbCk7IGJveC5hcHBlbmRDaGlsZChyb3cpOyBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGJveCk7XG4gICAgaWYgKGFjdGlvbiAhPT0gJ2RlbWFuZCcpIHtcbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ2Nhc2hpbicgfHwgYWN0aW9uID09PSAnY3JlZGl0JykgaGFja2VyUmVmcmVzaENsaWVudFN0YXR1c2VzKHRydWUpO1xuICAgICAgICBpZiAoYWN0aW9uID09PSAncGF5bWVudGluJyB8fCBhY3Rpb24gPT09ICdjcmVkaXQnKSBoYWNrZXJSZWZyZXNoUGF5TWV0aG9kcyh0cnVlKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlck9wZW5BZ2VudFF1aWNrUG9wdXAoYW5jaG9yKSB7XG4gICAgaWYgKCFoYWNrZXJDYW5SdW4oKSkgcmV0dXJuO1xuICAgIGNvbnN0IG9sZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0hhY2tlckFnZW50UG9wdXAnKTtcbiAgICBpZiAob2xkKSB7IG9sZC5yZW1vdmUoKTsgcmV0dXJuOyB9XG4gICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm94LmlkID0gJ21jSGFja2VyQWdlbnRQb3B1cCc7XG4gICAgYm94LnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7ei1pbmRleDoyMTQ3NDgzMDAxO3dpZHRoOjMwMHB4O3BhZGRpbmc6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6MTBweDtib3gtc2hhZG93OjAgOHB4IDMwcHggIzBmMTcyYTQwO2ZvbnQ6MTJweCBTZWdvZSBVSSxzYW5zLXNlcmlmO2NvbG9yOiMzMzQxNTU7JztcbiAgICBjb25zdCByID0gYW5jaG9yPy5nZXRCb3VuZGluZ0NsaWVudFJlY3Q/LigpO1xuICAgIGJveC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5tYXgoOCwgTWF0aC5taW4oKHI/LmxlZnQgfHwgMjApLCB3aW5kb3cuaW5uZXJXaWR0aCAtIDMyMCkpfXB4YDtcbiAgICBib3guc3R5bGUudG9wID0gYCR7TWF0aC5taW4oKHI/LmJvdHRvbSB8fCA4MCkgKyA1LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSAyMzApfXB4YDtcbiAgICBib3guaW5uZXJIVE1MID0gJzxiPuKaoSDQmtC+0L3RgtGA0LDQs9C10L3RgjwvYj4nO1xuICAgIGNvbnN0IGFkZCA9IChpZCwgbGFiZWwsIHBsYWNlaG9sZGVyKSA9PiB7XG4gICAgICAgIGNvbnN0IGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpOyBsLnRleHRDb250ZW50ID0gbGFiZWw7IGwuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO21hcmdpbjo3cHggMCAzcHg7Zm9udC13ZWlnaHQ6NjAwOyc7XG4gICAgICAgIGNvbnN0IGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpOyBpLmlkID0gaWQ7IGkudHlwZSA9ICd0ZXh0JzsgaS5wbGFjZWhvbGRlciA9IHBsYWNlaG9sZGVyIHx8ICcnOyBpLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfSU5QVVRfQ1NTOyBib3guYXBwZW5kQ2hpbGQobCk7IGJveC5hcHBlbmRDaGlsZChpKTsgcmV0dXJuIGk7XG4gICAgfTtcbiAgICBhZGQoJ2hhY2tlckFnZW50TmFtZScsICfQpNCY0J4nLCAn0JjQstCw0L3QvtCyINCY0LLQsNC9INCY0LLQsNC90L7QstC40YcnKTtcbiAgICBhZGQoJ2hhY2tlckFnZW50UGhvbmUnLCAn0J3QvtC80LXRgCcsICcrNyA5MDAgMDAwLTAwLTAwJyk7XG4gICAgY29uc3QgY2hlY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpOyBjaGVjay5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtnYXA6NnB4O2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tdG9wOjdweDsnO1xuICAgIGNoZWNrLmlubmVySFRNTCA9ICc8aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgaWQ9XCJoYWNrZXJBZ2VudENoZWNrQ3JlYXRlXCI+INC10YHQu9C4INC90LUg0L3QsNC50LTQtdC9LCDRgdC+0LfQtNCw0YLRjCDQutC+0L3RgtGA0LDQs9C10L3RgtCwJzsgYm94LmFwcGVuZENoaWxkKGNoZWNrKTtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgcm93LnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2dhcDo1cHg7bWFyZ2luLXRvcDoxMHB4Oyc7XG4gICAgY29uc3QgcGhvbmUgPSAoKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQWdlbnRQaG9uZScpPy52YWx1ZS50cmltKCk7XG4gICAgY29uc3QgYXNzaWduID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IGFzc2lnbi50ZXh0Q29udGVudCA9ICfQn9C+0LzQtdC90Y/RgtGMJzsgYXNzaWduLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfQlROX0NTUyArICdiYWNrZ3JvdW5kOiM0ZjQ2ZTU7ZmxleDoxOyc7XG4gICAgYXNzaWduLm9uY2xpY2sgPSAoKSA9PiBoYWNrZXJGaW5kQWdlbnRCeVBob25lKHBob25lKCkpLnRoZW4ocm93cyA9PiByb3dzLmxlbmd0aCA/IGhhY2tlckFzc2lnbkFnZW50KHJvd3NbMF0ubWV0YS5ocmVmKS50aGVuKCgpID0+IGhhY2tlckxvZygn4pyFINCa0L7QvdGC0YDQsNCz0LXQvdGCINC30LDQvNC10L3RkdC9JywgJ29rJykpIDogaGFja2VyTG9nKCfQmtC+0L3RgtGA0LDQs9C10L3RgiDQvdC1INC90LDQudC00LXQvScsICd3YXJuJykpLmNhdGNoKGVycm9yID0+IGhhY2tlckxvZygn0JrQvtC90YLRgNCw0LPQtdC90YI6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJykpO1xuICAgIGNvbnN0IGNyZWF0ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBjcmVhdGUudGV4dENvbnRlbnQgPSAn0KHQvtC30LTQsNGC0YwnOyBjcmVhdGUuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6IzE2YTM0YTtmbGV4OjE7JztcbiAgICBjcmVhdGUuaWQgPSAnaGFja2VyQWdlbnRDcmVhdGUnO1xuICAgIGNyZWF0ZS5kaXNhYmxlZCA9IGhhY2tlckFnZW50Q3JlYXRlUGVuZGluZztcbiAgICBjcmVhdGUub25jbGljayA9ICgpID0+IGhhY2tlckFnZW50Q3JlYXRlQ2xpY2soeyBjaGVja0ZpcnN0OiB0cnVlIH0pO1xuICAgIGNvbnN0IHZlcmlmeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyB2ZXJpZnkudGV4dENvbnRlbnQgPSAn0J/RgNC+0LLQtdGA0LjRgtGMJzsgdmVyaWZ5LnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfTUlOSV9CVE5fQ1NTO1xuICAgIHZlcmlmeS5vbmNsaWNrID0gKCkgPT4gaGFja2VyQWdlbnRDaGVja0NsaWNrKCk7XG4gICAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgY2xvc2UudGV4dENvbnRlbnQgPSAn4pyVJzsgY2xvc2Uuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9NSU5JX0JUTl9DU1M7IGNsb3NlLm9uY2xpY2sgPSAoKSA9PiBib3gucmVtb3ZlKCk7XG4gICAgcm93LmFwcGVuZENoaWxkKGFzc2lnbik7IHJvdy5hcHBlbmRDaGlsZChjcmVhdGUpOyByb3cuYXBwZW5kQ2hpbGQodmVyaWZ5KTsgcm93LmFwcGVuZENoaWxkKGNsb3NlKTsgYm94LmFwcGVuZENoaWxkKHJvdyk7IGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYm94KTtcbn1cblxuZnVuY3Rpb24gYnVpbGRNc0hhY2tlclF1aWNrUm93KGtpbmQpIHtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICByb3cuaWQgPSAnbWNIYWNrZXJRdWlja1Jvdyc7XG4gICAgcm93LnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo0cHg7YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbjoycHggMDsnO1xuICAgIFtbJ2RlbWFuZCcsJ+KaoSsg0L7RgtCz0YDRg9C30LrQsCddLFsnY2FzaGluJywn4pqhKyDQv9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCddLFsncGF5bWVudGluJywn4pqhKyDQstGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0ZHQtiddLFsnY3JlZGl0Jywn4pqhKyDQutGA0LXQtNC40YInXSxbJ2FnZW50Jywn4pqhINCa0L7QvdGC0YDQsNCz0LXQvdGCJ11dLmZvckVhY2goKFthY3Rpb24sbGFiZWxdKSA9PiB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgYi50eXBlPSdidXR0b24nOyBiLnRleHRDb250ZW50PWxhYmVsOyBiLnN0eWxlLmNzc1RleHQ9J3BhZGRpbmc6M3B4IDhweDtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMzMzQxNTU7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7JzsgYi5vbmNsaWNrPSgpPT4gYWN0aW9uID09PSAnYWdlbnQnID8gaGFja2VyT3BlbkFnZW50UXVpY2tQb3B1cChiKSA6IGhhY2tlck9wZW5RdWlja0FjdGlvblBvcHVwKGFjdGlvbiwgYik7IHJvdy5hcHBlbmRDaGlsZChiKTtcbiAgICB9KTtcbiAgICBjb25zdCBzdW1CdG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgc3VtQnRuLnR5cGU9J2J1dHRvbic7IHN1bUJ0bi50ZXh0Q29udGVudD0n8J+UhCDQodGD0LzQvNCwJzsgc3VtQnRuLnRpdGxlPSfQn9GA0L7QstC10YDQuNGC0Ywg0Lgg0L/QvtC00YHRgtCw0LLQuNGC0Ywg0LDQutGC0YPQsNC70YzQvdGD0Y4g0YHRg9C80LzRgyDQt9Cw0LrQsNC30LAnOyBzdW1CdG4uc3R5bGUuY3NzVGV4dD0ncGFkZGluZzozcHggOHB4O2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDtjdXJzb3I6cG9pbnRlcjsnOyBzdW1CdG4ub25jbGljaz0oKSA9PiBoYWNrZXJDaGVja09yZGVyU3VtKCk7IHJvdy5hcHBlbmRDaGlsZChzdW1CdG4pO1xuICAgIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTXNRdWlja1BhbmVsKCkge1xuICAgIGlmICghL29ubGluZVxcLm1veXNrbGFkXFwucnUkLy50ZXN0KGxvY2F0aW9uLmhvc3RuYW1lKSkgcmV0dXJuO1xuICAgIGNvbnN0IG9sZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1F1aWNrUGFuZWwnKTtcbiAgICBjb25zdCBvbGRXcmFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtbWMtcXVpY2std3JhcF0nKTtcbiAgICBjb25zdCBvbGRRdWlja1JvdyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0hhY2tlclF1aWNrUm93Jyk7XG4gICAgY29uc3Qga2luZCA9IE9iamVjdC5rZXlzKE1TX1FVSUNLX1BBTkVMX0NPTkZJRykuZmluZChrID0+IE1TX1FVSUNLX1BBTkVMX0NPTkZJR1trXS5tYXJrZXIoKSk7XG4gICAgY29uc3QgY2ZnID0ga2luZCA/IE1TX1FVSUNLX1BBTkVMX0NPTkZJR1traW5kXSA6IG51bGw7XG4gICAgY29uc3QgcXVpY2tTaWduYXR1cmUgPSBjZmcgPyBbY2ZnLm1hZ2ljID8gJ21hZ2ljJyA6ICcnLCAuLi5jZmcuY3JlYXRlLCAuLi5jZmcucHJpbnRdLmpvaW4oJ1xcdTAwMWYnKSA6ICcnO1xuICAgIGNvbnN0IGV4cGVjdGVkQnV0dG9uQ291bnQgPSBjZmcgPyBjZmcuY3JlYXRlLmxlbmd0aCArIGNmZy5wcmludC5sZW5ndGggKyAoY2ZnLm1hZ2ljID8gMSA6IDApIDogMDtcbiAgICBjb25zdCBxdWlja0VuYWJsZWQgPSBIQUNLRVJfUVVJQ0tfQVBJX1JPV19FTkFCTEVEICYmIGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQ7XG4gICAgY29uc3QgcGFuZWxIZWFsdGh5ID0gb2xkICYmIG9sZC5pc0Nvbm5lY3RlZCAmJiBvbGQuZGF0YXNldC5raW5kID09PSBraW5kXG4gICAgICAgICYmIG9sZC5kYXRhc2V0LnF1aWNrU2lnbmF0dXJlID09PSBxdWlja1NpZ25hdHVyZVxuICAgICAgICAmJiBvbGQucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykubGVuZ3RoID09PSBleHBlY3RlZEJ1dHRvbkNvdW50XG4gICAgICAgICYmICghY2ZnPy5tYWdpYyB8fCBvbGQucXVlcnlTZWxlY3RvcignI21jTWFnaWNQYW5lbEFjdGlvbicpPy5pc0Nvbm5lY3RlZClcbiAgICAgICAgJiYgKCFxdWlja0VuYWJsZWQgfHwgb2xkUXVpY2tSb3c/LmlzQ29ubmVjdGVkKTtcbiAgICAvLyBLZWVwIGEgY29tcGxldGUgcGFpciBzdGFibGUgYWNyb3NzIE11dGF0aW9uT2JzZXJ2ZXIgY2FsbGJhY2tzLlxuICAgIGlmIChwYW5lbEhlYWx0aHkpIHJldHVybjtcbiAgICBpZiAob2xkUXVpY2tSb3cpIG9sZFF1aWNrUm93LnJlbW92ZSgpO1xuICAgIGlmICgha2luZCB8fCAhbXNRdWlja1BhbmVsRW5hYmxlZCkgeyBpZiAob2xkV3JhcCkgb2xkV3JhcC5yZW1vdmUoKTsgZWxzZSBpZiAob2xkKSBvbGQucmVtb3ZlKCk7IHJldHVybjsgfVxuXG4gICAgaWYgKG9sZFdyYXApIG9sZFdyYXAucmVtb3ZlKCk7IGVsc2UgaWYgKG9sZCkgb2xkLnJlbW92ZSgpO1xuICAgIC8vIFRoZSBvbGQgbWFpbiBwYW5lbCBtYXkgaGF2ZSBiZWVuIHJlYnVpbHQgYnkgdGhlIFNQQTsgY3JlYXRlIG9uZSBmcmVzaCBwYWlyLlxuXG4gICAgY29uc3QgYW5jaG9yID0gbXNHZXRUb29sYmFyQnV0dG9uKCfQodC+0LfQtNCw0YLRjCDQtNC+0LrRg9C80LXQvdGCJykgfHwgbXNHZXRUb29sYmFyQnV0dG9uKCfQn9C10YfQsNGC0YwnKTtcbiAgICBpZiAoIWFuY2hvcikgcmV0dXJuO1xuICAgIC8vINC80LjQvdC40LzQsNC70YzQvdGL0Lkg0L7QsdGJ0LjQuSDQutC+0L3RgtC10LnQvdC10YAg0YLRg9C70LHQsNGA0LAgKNGB0L7QtNC10YDQttC40YIg0LggwqvQodC+0LfQtNCw0YLRjCDQtNC+0LrRg9C80LXQvdGCwrssINC4IMKr0J/QtdGH0LDRgtGMwrspXG4gICAgY29uc3QgcHJpbnRCdG4gPSBtc0dldFRvb2xiYXJCdXR0b24oJ9Cf0LXRh9Cw0YLRjCcpO1xuICAgIGxldCBiYXIgPSBhbmNob3IucGFyZW50RWxlbWVudDtcbiAgICB3aGlsZSAoYmFyICYmIGJhciAhPT0gZG9jdW1lbnQuYm9keSAmJiAhKHByaW50QnRuICYmIGJhci5jb250YWlucyhwcmludEJ0bikpKSB7XG4gICAgICAgIGJhciA9IGJhci5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgICBpZiAoIWJhciB8fCBiYXIgPT09IGRvY3VtZW50LmJvZHkpIHJldHVybjtcblxuICAgIGlmICghcXVpY2tFbmFibGVkKSB7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0hhY2tlclF1aWNrUm93Jyk/LnJlbW92ZSgpOyB9XG4gICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBwYW5lbC5pZCA9ICdtY1F1aWNrUGFuZWwnO1xuICAgIHBhbmVsLmRhdGFzZXQua2luZCA9IGtpbmQ7XG4gICAgcGFuZWwuZGF0YXNldC5xdWlja1NpZ25hdHVyZSA9IHF1aWNrU2lnbmF0dXJlO1xuICAgIHBhbmVsLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo0cHg7YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbjo0cHggMDsnO1xuXG4gICAgY29uc3QgbWtCdG4gPSAoZW1vamksIGxhYmVsLCBtZW51TGFiZWwpID0+IHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBiLnR5cGUgPSAnYnV0dG9uJztcbiAgICAgICAgYi50ZXh0Q29udGVudCA9IGAke2Vtb2ppfSAke2xhYmVsfWA7XG4gICAgICAgIGIudGl0bGUgPSBgJHttZW51TGFiZWx9OiAke2xhYmVsfWA7XG4gICAgICAgIGIuc3R5bGUuY3NzVGV4dCA9ICdwYWRkaW5nOjNweCA4cHg7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6I2ZmZjsnXG4gICAgICAgICAgICArICdjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4O2N1cnNvcjpwb2ludGVyO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOmFsbCAuMTVzOyc7XG4gICAgICAgIGIuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsgYi5zdHlsZS5iYWNrZ3JvdW5kID0gJyNlZWYyZmYnOyBiLnN0eWxlLmJvcmRlckNvbG9yID0gJyM2MzY2ZjEnOyB9KTtcbiAgICAgICAgYi5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4geyBiLnN0eWxlLmJhY2tncm91bmQgPSAnI2ZmZic7IGIuc3R5bGUuYm9yZGVyQ29sb3IgPSAnI2NiZDVlMSc7IH0pO1xuICAgICAgICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgcGFuZWwucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykuZm9yRWFjaCh4ID0+IHsgeC5kaXNhYmxlZCA9IHRydWU7IHguc3R5bGUub3BhY2l0eSA9ICcuNSc7IH0pO1xuICAgICAgICAgICAgYXdhaXQgbXNDbGlja01lbnVJdGVtKG1lbnVMYWJlbCwgbGFiZWwpO1xuICAgICAgICAgICAgcGFuZWwucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykuZm9yRWFjaCh4ID0+IHsgeC5kaXNhYmxlZCA9IGZhbHNlOyB4LnN0eWxlLm9wYWNpdHkgPSAnMSc7IH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGI7XG4gICAgfTtcblxuICAgIGlmIChjZmcubWFnaWMpIHtcbiAgICAgICAgY29uc3QgbWFnaWMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgbWFnaWMuaWQgPSAnbWNNYWdpY1BhbmVsQWN0aW9uJztcbiAgICAgICAgbWFnaWMudHlwZSA9ICdidXR0b24nO1xuICAgICAgICBtYWdpYy50ZXh0Q29udGVudCA9ICfwn6qEINCX0LDQv9C+0LvQvdC40YLRjCc7XG4gICAgICAgIG1hZ2ljLnRpdGxlID0gJ9CX0LDQv9C+0LvQvdC40YLRjCDQvdCw0YHRgtGA0L7QtdC90L3Ri9C1INC/0L7Qu9GPINC4INGB0L7RhdGA0LDQvdC40YLRjCDQtNC+0LrRg9C80LXQvdGCJztcbiAgICAgICAgbWFnaWMuc3R5bGUuY3NzVGV4dCA9ICdwYWRkaW5nOjNweCA4cHg7Ym9yZGVyOjFweCBzb2xpZCAjYzRiNWZkO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6I2Y1ZjNmZjsnXG4gICAgICAgICAgICArICdjb2xvcjojNmQyOGQ5O2ZvbnQtc2l6ZToxMXB4O2N1cnNvcjpwb2ludGVyO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOmFsbCAuMTVzOyc7XG4gICAgICAgIG1hZ2ljLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiB7IG1hZ2ljLnN0eWxlLmJhY2tncm91bmQgPSAnI2VkZTlmZSc7IG1hZ2ljLnN0eWxlLmJvcmRlckNvbG9yID0gJyM4YjVjZjYnOyB9KTtcbiAgICAgICAgbWFnaWMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IHsgbWFnaWMuc3R5bGUuYmFja2dyb3VuZCA9ICcjZjVmM2ZmJzsgbWFnaWMuc3R5bGUuYm9yZGVyQ29sb3IgPSAnI2M0YjVmZCc7IH0pO1xuICAgICAgICBtYWdpYy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IG9wZW5Nc01hZ2ljUG9wdXAobWFnaWMpKTtcbiAgICAgICAgcGFuZWwuYXBwZW5kQ2hpbGQobWFnaWMpO1xuICAgIH1cbiAgICBjZmcuY3JlYXRlLmZvckVhY2gobGFiZWwgPT4gcGFuZWwuYXBwZW5kQ2hpbGQobWtCdG4oJ+KelScsIGxhYmVsLCAn0KHQvtC30LTQsNGC0Ywg0LTQvtC60YPQvNC10L3RgicpKSk7XG4gICAgY2ZnLnByaW50LmZvckVhY2gobGFiZWwgPT4gcGFuZWwuYXBwZW5kQ2hpbGQobWtCdG4oJ/CflqgnLCBsYWJlbCwgJ9Cf0LXRh9Cw0YLRjCcpKSk7XG5cbiAgICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgd3JhcC5kYXRhc2V0Lm1jUXVpY2tXcmFwID0gJzEnO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQocGFuZWwpO1xuXG4gICAgLy8gR1dULdC00L7QutGD0LzQtdC90YLRiyAo0L7RgtCz0YDRg9C30LrQsCDQuCDQv9GALiDRgdGC0LDRgNC+0LPQviDQtNC40LfQsNC50L3QsCk6INC60L7QvdGC0LXQudC90LXRgCDigJQgVEFCTEUsINGC0YPQu9Cx0LDRgFxuICAgIC8vINCyINGB0YLRgNC+0LrQtSDRgtCw0LHQu9C40YbRiy4g0JLRgdGC0LDQstC70Y/QtdC8INC/0LDQvdC10LvRjCDQntCi0JTQldCb0KzQndCe0Jkg0YHRgtGA0L7QutC+0LkgVFIg0KHQoNCQ0JfQoyDQn9Ce0KHQm9CVXG4gICAgLy8g0YHRgtGA0L7QutC4INGC0YPQu9Cx0LDRgNCwICjQvdC1INC/0L7RgdC70LUg0LfQsNCz0L7Qu9C+0LLQutCwIOKAlCDRgtCw0Lwg0L/QsNC90LXQu9C4INGD0LXQt9C20LDRjtGCINCy0L3QuNC3INGE0L7RgNC80YspLlxuICAgIC8vINCS0JDQltCd0J46IGItZWRpdG9yLXRvb2xiYXIg0YHQvtC00LXRgNC20LjRgiDQstC70L7QttC10L3QvdGL0LUg0YLQsNCx0LvQuNGG0Ys7INC40YnQtdC8INCS0J3QldCo0J3QmNCZIHRib2R5LFxuICAgIC8vINCz0LTQtSDRgdGC0YDQvtC60LAg0YLRg9C70LHQsNGA0LAg4oCUINC/0YDRj9C80L7QuSDRgNC10LHRkdC90L7Qui5cbiAgICBjb25zdCB0b29sYmFyVGFibGUgPSBiYXIuY2xvc2VzdCgndGFibGUuYi1lZGl0b3ItdG9vbGJhcicpO1xuICAgIGNvbnN0IGV4dFRib2R5ID0gKCgpID0+IHtcbiAgICAgICAgaWYgKCF0b29sYmFyVGFibGUpIHJldHVybiBudWxsO1xuICAgICAgICBsZXQgcm93ID0gdG9vbGJhclRhYmxlLmNsb3Nlc3QoJ3RyJyk7XG4gICAgICAgIHdoaWxlIChyb3cgJiYgcm93LnBhcmVudEVsZW1lbnQgJiYgcm93LnBhcmVudEVsZW1lbnQudGFnTmFtZSAhPT0gJ1RCT0RZJykgcm93ID0gcm93LnBhcmVudEVsZW1lbnQuY2xvc2VzdCgndHInKTtcbiAgICAgICAgcmV0dXJuIHJvdyA/IHJvdy5wYXJlbnRFbGVtZW50IDogbnVsbDtcbiAgICB9KSgpO1xuICAgIGlmIChleHRUYm9keSkge1xuICAgICAgICBjb25zdCB0b29sYmFyUm93ID0gWy4uLmV4dFRib2R5LmNoaWxkcmVuXS5maW5kKHIgPT4gci5jb250YWlucyh0b29sYmFyVGFibGUpKTtcbiAgICAgICAgaWYgKHRvb2xiYXJSb3cpIHtcbiAgICAgICAgICAgIHdyYXAuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7cGFkZGluZzoycHggOHB4Oyc7XG4gICAgICAgICAgICBjb25zdCB0ciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RyJyk7XG4gICAgICAgICAgICBjb25zdCB0ZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RkJyk7XG4gICAgICAgICAgICB0ZC5jb2xTcGFuID0gdG9vbGJhclJvdy5jaGlsZHJlbi5sZW5ndGggfHwgMTtcbiAgICAgICAgICAgIHRkLmFwcGVuZENoaWxkKHdyYXApO1xuICAgICAgICAgICAgdHIuYXBwZW5kQ2hpbGQodGQpO1xuICAgICAgICAgICAgdG9vbGJhclJvdy5hZnRlcih0cik7XG4gICAgICAgICAgICBpZiAoIXF1aWNrRW5hYmxlZCkgcmV0dXJuO1xuICAgICAgICAgICAgY29uc3QgcXVpY2tUciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RyJyk7XG4gICAgICAgICAgICBjb25zdCBxdWlja1RkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGQnKTtcbiAgICAgICAgICAgIHF1aWNrVGQuY29sU3BhbiA9IHRvb2xiYXJSb3cuY2hpbGRyZW4ubGVuZ3RoIHx8IDE7XG4gICAgICAgICAgICBxdWlja1RkLmFwcGVuZENoaWxkKGJ1aWxkTXNIYWNrZXJRdWlja1JvdyhraW5kKSk7XG4gICAgICAgICAgICBxdWlja1RyLmFwcGVuZENoaWxkKHF1aWNrVGQpO1xuICAgICAgICAgICAgdHIuYWZ0ZXIocXVpY2tUcik7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZWFjdC3QtNC+0LrRg9C80LXQvdGC0YsgKNC90L7QstGL0Lkg0LTQuNC30LDQudC9KTog0L/QvtC00L3QuNC80LDQtdC80YHRjyDQtNC+INC/0L7RgdC70LXQtNC90LXQuSBmbGV4LdGB0YLRgNC+0LrQuFxuICAgIC8vINC4INCy0YHRgtCw0LLQu9GP0LXQvCDQvtCx0ZHRgNGC0LrRgyAoYmxvY2ssIHdpZHRoOjEwMCUpINC10ZEg0YHQu9C10LTRg9GO0YnQuNC8INGB0L7RgdC10LTQvtC8LlxuICAgIGxldCBmbGV4Um93ID0gYmFyO1xuICAgIHdoaWxlIChmbGV4Um93LnBhcmVudEVsZW1lbnQgJiYgZ2V0Q29tcHV0ZWRTdHlsZShmbGV4Um93LnBhcmVudEVsZW1lbnQpLmRpc3BsYXkgPT09ICdmbGV4Jykge1xuICAgICAgICBmbGV4Um93ID0gZmxleFJvdy5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgICBjb25zdCBob3N0ID0gZmxleFJvdy5wYXJlbnRFbGVtZW50O1xuICAgIGlmICghaG9zdCkgcmV0dXJuO1xuICAgIHdyYXAuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7JztcbiAgICBob3N0Lmluc2VydEJlZm9yZSh3cmFwLCBmbGV4Um93Lm5leHRTaWJsaW5nKTtcbiAgICBpZiAoIXF1aWNrRW5hYmxlZCkgcmV0dXJuO1xuICAgIGNvbnN0IHF1aWNrUm93ID0gYnVpbGRNc0hhY2tlclF1aWNrUm93KGtpbmQpO1xuICAgIHF1aWNrUm93LnN0eWxlLmNzc1RleHQgKz0gJ3dpZHRoOjEwMCU7JztcbiAgICBob3N0Lmluc2VydEJlZm9yZShxdWlja1Jvdywgd3JhcC5uZXh0U2libGluZyk7XG59XG5cbiIsIi8vIOKUgOKUgOKUgCDQntGH0LjRgdGC0LrQsCDRgtC10LrRgdGC0LAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQktGL0LfRi9Cy0LDQtdGC0YHRjyDQv9GA0Lgg0LrQsNC20LTQvtC8INC+0YLQutGA0YvRgtC40Lgg0L7QutC90LAg0L3QsNGB0YLRgNC+0LXQuiAo0Y3Qu9C10LzQtdC90YLRiyDRgdC+0LfQtNCw0Y7RgtGB0Y8g0LfQsNC90L7QstC+KSxcbi8vINC/0L7RjdGC0L7QvNGDIGRvY3VtZW50LdGB0LvRg9GI0LDRgtC10LvRjCDQstC10YjQsNC10YLRgdGPINC+0LTQuNC9INGA0LDQtyDRh9C10YDQtdC3INGE0LvQsNCzLlxuZnVuY3Rpb24gbG9hZENsZWFyVGV4dERlbGF5KCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gTnVtYmVyKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2NsZWFyVGV4dERlbGF5X3YxJykpKTtcbiAgICAgICAgY2xlYXJUZXh0RGVsYXkgPSBOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSAmJiB2YWx1ZSA+PSAxICYmIHZhbHVlIDw9IDIwMDAgPyB2YWx1ZSA6IDUwMDtcbiAgICB9IGNhdGNoIHsgY2xlYXJUZXh0RGVsYXkgPSA1MDA7IH1cbiAgICByZXR1cm4gY2xlYXJUZXh0RGVsYXk7XG59XG5cbmZ1bmN0aW9uIHNhdmVDbGVhclRleHREZWxheSh2YWx1ZSkge1xuICAgIGNvbnN0IGRlbGF5ID0gTnVtYmVyKHZhbHVlKTtcbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoZGVsYXkpIHx8IGRlbGF5IDwgMSB8fCBkZWxheSA+IDIwMDApIHJldHVybjtcbiAgICBjbGVhclRleHREZWxheSA9IGRlbGF5O1xuICAgIGlmICghY2xlYXJUZXh0RW5hYmxlZCkgcmV0dXJuO1xuICAgIHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2NsZWFyVGV4dERlbGF5X3YxJyksIFN0cmluZyhkZWxheSkpOyB9XG4gICAgY2F0Y2ggKGVycm9yKSB7IGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0LfQsNC00LXRgNC20LrRgyDQvtGH0LjRgdGC0LrQuCcsIGVycm9yKTsgfVxufVxuXG5jb25zdCBjbGVhclRleHRUaW1lcnMgPSBuZXcgTWFwKCk7XG5mdW5jdGlvbiBjYW5jZWxDbGVhclRleHRUaW1lcih0YXJnZXQpIHtcbiAgICBjbGVhclRpbWVvdXQoY2xlYXJUZXh0VGltZXJzLmdldCh0YXJnZXQpKTtcbiAgICBjbGVhclRleHRUaW1lcnMuZGVsZXRlKHRhcmdldCk7XG59XG5mdW5jdGlvbiBsb2FkQ2xlYXJUZXh0RW5hYmxlZCgpIHtcbiAgICBjb25zdCBrZXkgPSBzdG9yYWdlS2V5KCdjbGVhclRleHRFbmFibGVkJyk7XG4gICAgbGV0IHNhdmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KTtcbiAgICBpZiAoc2F2ZWQgPT09IG51bGwgJiYgdHlwZW9mIE1FTUNIQVRfQlVJTEQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHNhdmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oJ2NsZWFyVGV4dEVuYWJsZWQnKTtcbiAgICAgICAgaWYgKHNhdmVkICE9PSBudWxsKSB7XG4gICAgICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIHNhdmVkKTtcbiAgICAgICAgICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKCdjbGVhclRleHRFbmFibGVkJyk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgY2xlYXJUZXh0RW5hYmxlZCA9IHNhdmVkID09PSAndHJ1ZSc7XG59XG5mdW5jdGlvbiBzZXR1cEdsb2JhbENsZWFyVGV4dEZ1bmN0aW9uYWxpdHkoKSB7XG4gICAgbG9hZENsZWFyVGV4dEVuYWJsZWQoKTtcbiAgICBpZiAoIWNsZWFyVGV4dEVuYWJsZWQpIGZvciAoY29uc3QgdGFyZ2V0IG9mIGNsZWFyVGV4dFRpbWVycy5rZXlzKCkpIGNhbmNlbENsZWFyVGV4dFRpbWVyKHRhcmdldCk7XG4gICAgbG9hZENsZWFyVGV4dERlbGF5KCk7XG4gICAgY29uc3Qgc2xpZGVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRTbGlkZXInKTtcbiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0aW1lb3V0VmFsdWUnKTtcbiAgICBpZiAoc2xpZGVyKSB7XG4gICAgICAgIHNsaWRlci52YWx1ZSA9IFN0cmluZyhjbGVhclRleHREZWxheSk7XG4gICAgICAgIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBzbGlkZXIudmFsdWU7XG4gICAgICAgIGlmICghc2xpZGVyLmRhdGFzZXQubWVtY2hhdENsZWFyQm91bmQpIHNsaWRlci5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHtcbiAgICAgICAgICAgIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBzbGlkZXIudmFsdWU7XG4gICAgICAgICAgICBzYXZlQ2xlYXJUZXh0RGVsYXkoc2xpZGVyLnZhbHVlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHNsaWRlci5kYXRhc2V0Lm1lbWNoYXRDbGVhckJvdW5kID0gJ3RydWUnO1xuICAgIH1cbiAgICBjb25zdCBjYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbGVhclRleHRDaGVja2JveCcpO1xuICAgIGlmIChjYikge1xuICAgICAgICBjYi5jaGVja2VkID0gY2xlYXJUZXh0RW5hYmxlZDtcbiAgICAgICAgaWYgKCFjYi5kYXRhc2V0Lm1lbWNoYXRDbGVhckJvdW5kKSBjYi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXRDbGVhclRleHRFbmFibGVkKHRoaXMuY2hlY2tlZCk7XG4gICAgICAgIH0pO1xuICAgICAgICBjYi5kYXRhc2V0Lm1lbWNoYXRDbGVhckJvdW5kID0gJ3RydWUnO1xuICAgIH1cbiAgICBpZiAoIWdsb2JhbENsZWFyS2V5cHJlc3NCb3VuZCkge1xuICAgICAgICBnbG9iYWxDbGVhcktleXByZXNzQm91bmQgPSB0cnVlO1xuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlwcmVzcycsIGUgPT4ge1xuICAgICAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmICFlLmlzQ29tcG9zaW5nICYmIGUua2V5Q29kZSAhPT0gMjI5ICYmIGNsZWFyVGV4dEVuYWJsZWQgJiYgKGUudGFyZ2V0LnRhZ05hbWUgPT09ICdJTlBVVCcgfHwgZS50YXJnZXQudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJykpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCwgdmFsdWUgPSB0YXJnZXQudmFsdWU7XG4gICAgICAgICAgICAgICAgY2FuY2VsQ2xlYXJUZXh0VGltZXIodGFyZ2V0KTtcbiAgICAgICAgICAgICAgICBjbGVhclRleHRUaW1lcnMuc2V0KHRhcmdldCwgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGV4dFRpbWVycy5kZWxldGUodGFyZ2V0KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNsZWFyVGV4dEVuYWJsZWQgJiYgdGFyZ2V0LmlzQ29ubmVjdGVkICYmIHRhcmdldC52YWx1ZSA9PT0gdmFsdWUpIHRhcmdldC52YWx1ZSA9ICcnO1xuICAgICAgICAgICAgICAgIH0sIGNsZWFyVGV4dERlbGF5KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIGUgPT4gY2FuY2VsQ2xlYXJUZXh0VGltZXIoZS50YXJnZXQpLCB0cnVlKTtcbiAgICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY29tcG9zaXRpb25zdGFydCcsIGUgPT4gY2FuY2VsQ2xlYXJUZXh0VGltZXIoZS50YXJnZXQpLCB0cnVlKTtcbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BhZ2VoaWRlJywgKCkgPT4geyBmb3IgKGNvbnN0IHRhcmdldCBvZiBjbGVhclRleHRUaW1lcnMua2V5cygpKSBjYW5jZWxDbGVhclRleHRUaW1lcih0YXJnZXQpOyB9KTtcbiAgICB9XG4gICAgdXBkYXRlQ2xlYXJUZXh0QnV0dG9uKCk7XG59XG5cbmZ1bmN0aW9uIHNldENsZWFyVGV4dEVuYWJsZWQoZW5hYmxlZCkge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2NsZWFyVGV4dEVuYWJsZWQnKSwgU3RyaW5nKCEhZW5hYmxlZCkpO1xuICAgIGNsZWFyVGV4dEVuYWJsZWQgPSAhIWVuYWJsZWQ7XG4gICAgaWYgKCFjbGVhclRleHRFbmFibGVkKSBmb3IgKGNvbnN0IHRhcmdldCBvZiBjbGVhclRleHRUaW1lcnMua2V5cygpKSBjYW5jZWxDbGVhclRleHRUaW1lcih0YXJnZXQpO1xuICAgIGlmIChjbGVhclRleHRFbmFibGVkKSBzYXZlQ2xlYXJUZXh0RGVsYXkoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRTbGlkZXInKT8udmFsdWUgfHwgY2xlYXJUZXh0RGVsYXkpO1xuICAgIGNvbnN0IGNiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyVGV4dENoZWNrYm94Jyk7XG4gICAgaWYgKGNiKSBjYi5jaGVja2VkID0gY2xlYXJUZXh0RW5hYmxlZDtcbiAgICB1cGRhdGVDbGVhclRleHRCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlQ2xlYXJUZXh0QnV0dG9uKCkge1xuICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0NsZWFyVGV4dFRvZ2dsZScpO1xuICAgIGlmICghYnRuKSByZXR1cm47XG4gICAgYnRuLnNldEF0dHJpYnV0ZSgnYXJpYS1wcmVzc2VkJywgU3RyaW5nKGNsZWFyVGV4dEVuYWJsZWQpKTtcbiAgICBidG4uZGF0YXNldC50aXAgPSBjbGVhclRleHRFbmFibGVkXG4gICAgICAgID8gJ/Cfp7kg0J7Rh9C40YHRgtC60LAg0L/QvtC70Y8g0L/QvtGB0LvQtSBFbnRlciDQstC60LvRjtGH0LXQvdCwJ1xuICAgICAgICA6ICfwn6e5INCe0YfQuNGB0YLQutCwINC/0L7Qu9GPINC/0L7RgdC70LUgRW50ZXIg0LLRi9C60LvRjtGH0LXQvdCwJztcbiAgICBpZiAoY2xlYXJUZXh0RW5hYmxlZCkge1xuICAgICAgICBidG4uc3R5bGUuYmFja2dyb3VuZCA9ICcjZGNmY2U3JztcbiAgICAgICAgYnRuLnN0eWxlLmJvcmRlckNvbG9yID0gJyMyMmM1NWUnO1xuICAgICAgICBidG4uc3R5bGUuY29sb3IgPSAnIzE2NjUzNCc7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgYnRuLnN0eWxlLmJhY2tncm91bmQgPSAnI2Y4ZmFmYyc7XG4gICAgICAgIGJ0bi5zdHlsZS5ib3JkZXJDb2xvciA9ICcjZTJlOGYwJztcbiAgICAgICAgYnRuLnN0eWxlLmNvbG9yID0gJyM2NDc0OGInO1xuICAgIH1cbn1cbiIsIi8vIOKUgOKUgOKUgCDQlNC40YHQv9C10YLRh9C10YAg0LTQtdC50YHRgtCy0LjQuSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGV4ZWN1dGVDdXJyZW50QWN0aW9uKCkge1xuICAgIC8vIEVudGVyINGA0LDQsdC+0YLQsNC10YIg0YLQvtC70YzQutC+INC90LAg0YDQtdC20LjQvNC90YvRhSDQstC60LvQsNC00LrQsNGFOyDQtNC70Y8g0LTQtdC50YHRgtCy0LjQuSDQuCDCq9Cd0LDRgdGC0YDQvtC10LrCuyDigJQgbm8tb3AuXG4gICAgZGVidWdMb2coJ2FjdGlvbicsIGN1cnJlbnRBY3Rpb24pO1xuICAgIHN3aXRjaCAoY3VycmVudEFjdGlvbikge1xuICAgICAgICBjYXNlICdjaGVja0hhdGlrbyc6ICAgICAgICAgIGNoZWNrSGF0aWtvKCk7ICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnY2hlY2tIYXRpa29Cb251c2VzJzogICBjaGVja0hhdGlrb0JvbnVzZXMoKTsgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ2NhbGN1bGF0b3InOiAgICAgICAgICAgY2FsY3VsYXRlQ3JlZGl0KCk7ICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdjYWxjdWxhdG9yX3JldmVyc2UnOiAgIGNhbGN1bGF0ZVJldmVyc2UoKTsgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnY2FsY3VsYXRvcl9kaXNjb3VudCc6ICBhcHBseURpc2NvdW50T3JNYXJrdXAoKTsgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ2NhbGN1bGF0b3Jfc2ltcGxlJzogICAgY2FsY3VsYXRlU2ltcGxlKCk7ICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OiAvKiBuby1vcCAqLztcbiAgICB9XG59XG5cbiIsIi8vIOKUgOKUgOKUgCDQodC+0LfQtNCw0L3QuNC1INC40L3RgtC10YDRhNC10LnRgdCwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gY3JlYXRlUHJpY2VDaGVja1dpbmRvdygpIHtcblxuICAgIGlmICghd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIpIHtcblxuICAgICAgICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7XG4gICAgICAgIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIge1xuICAgICAgICAgICAgICAgIGZvbnQtZmFtaWx5OiAnU2Vnb2UgVUknLCBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIHNhbnMtc2VyaWY7XG4gICAgICAgICAgICAgICAgZm9udC1zaXplOiAxM3B4O1xuICAgICAgICAgICAgICAgIGNvbG9yOiAjMWYyOTM3O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIgKjo6LXdlYmtpdC1zY3JvbGxiYXIgeyB3aWR0aDogNHB4OyBoZWlnaHQ6IDRweDsgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIgKjo6LXdlYmtpdC1zY3JvbGxiYXItdHJhY2sgeyBiYWNrZ3JvdW5kOiAjZjFmNWY5OyB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAqOjotd2Via2l0LXNjcm9sbGJhci10aHVtYiB7IGJhY2tncm91bmQ6ICNjYmQ1ZTE7IGJvcmRlci1yYWRpdXM6IDRweDsgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIgKjo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiAjNjM2NmYxOyB9XG5cbiAgICAgICAgICAgIC5tYy1idG4ge1xuICAgICAgICAgICAgICAgIHBhZGRpbmc6IDZweCAxMHB4OyBib3JkZXI6IG5vbmU7IGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgICAgICBjb2xvcjogI2ZmZjsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IDEycHg7IGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgICAgICAgICAgICAgdHJhbnNpdGlvbjogYWxsIC4xOHMgZWFzZTsgd2hpdGUtc3BhY2U6IG5vd3JhcDsgbGV0dGVyLXNwYWNpbmc6IC4ycHg7XG4gICAgICAgICAgICAgICAgbGluZS1oZWlnaHQ6IDEuMztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5tYy1idG46aG92ZXIgIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC0xcHgpOyBmaWx0ZXI6IGJyaWdodG5lc3MoMS4xNSk7IH1cbiAgICAgICAgICAgIC5tYy1idG46YWN0aXZlIHsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDApOyAgICBmaWx0ZXI6IGJyaWdodG5lc3MoLjk1KTsgIH1cbiAgICAgICAgICAgIC5tYy1idG4tZ3JlZW4gIHsgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyMmM1NWUsIzE2YTM0YSk7IGJveC1zaGFkb3c6MCAycHggOHB4ICMyMmM1NWUyODsgfVxuICAgICAgICAgICAgLm1jLWJ0bi1ibHVlICAgeyBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzNiODJmNiwjMjU2M2ViKTsgYm94LXNoYWRvdzowIDJweCA4cHggIzNiODJmNjI4OyB9XG4gICAgICAgICAgICAubWMtYnRuLXB1cnBsZSB7IGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjYTg1NWY3LCM3YzNhZWQpOyBib3gtc2hhZG93OjAgMnB4IDhweCAjYTg1NWY3Mjg7IH1cbiAgICAgICAgICAgIC5tYy1idG4tb3JhbmdlIHsgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCNmOTczMTYsI2VhNTgwYyk7IGJveC1zaGFkb3c6MCAycHggOHB4ICNmOTczMTYyODsgfVxuICAgICAgICAgICAgLm1jLWJ0bi10ZWFsICAgeyBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzE0YjhhNiwjMGQ5NDg4KTsgYm94LXNoYWRvdzowIDJweCA4cHggIzE0YjhhNjI4OyB9XG4gICAgICAgICAgICAubWMtYnRuLWluZGlnbyB7IGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCM0ZjQ2ZTUpOyBib3gtc2hhZG93OjAgMnB4IDhweCAjNjM2NmYxMjg7IH1cbiAgICAgICAgICAgIC5tYy1idG4tc2xhdGUgIHsgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM0NzU1NjksIzMzNDE1NSk7IGJvcmRlcjoxcHggc29saWQgIzQ3NTU2OTsgYm94LXNoYWRvdzpub25lOyB9XG4gICAgICAgICAgICAubWMtYnRuLWFjdGl2ZSB7XG4gICAgICAgICAgICAgICAgb3V0bGluZTogMnB4IHNvbGlkICNmZmYgIWltcG9ydGFudDtcbiAgICAgICAgICAgICAgICBvdXRsaW5lLW9mZnNldDogMnB4ICFpbXBvcnRhbnQ7XG4gICAgICAgICAgICAgICAgZmlsdGVyOiBicmlnaHRuZXNzKDEuMTUpICFpbXBvcnRhbnQ7XG4gICAgICAgICAgICAgICAgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC0xcHgpICFpbXBvcnRhbnQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAubWMtc2VjdGlvbi1sYWJlbCB7XG4gICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMHB4OyBmb250LXdlaWdodDogODAwOyBjb2xvcjogIzY0NzQ4YjtcbiAgICAgICAgICAgICAgICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogLjhweDtcbiAgICAgICAgICAgICAgICBtYXJnaW4tYm90dG9tOiA2cHg7IHBhZGRpbmctbGVmdDogMnB4O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLm1jLXBhbmVsIHtcbiAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZjhmYWZjOyBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViO1xuICAgICAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDEycHg7IHBhZGRpbmc6IDExcHg7XG4gICAgICAgICAgICAgICAgbWF4LWhlaWdodDogMzIwcHg7IG92ZXJmbG93LXk6IGF1dG87XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAubWMtcGFuZWwtdGl0bGUge1xuICAgICAgICAgICAgICAgIGZvbnQtc2l6ZTogMTBweDsgZm9udC13ZWlnaHQ6IDcwMDsgY29sb3I6ICM0ZjQ2ZTU7XG4gICAgICAgICAgICAgICAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6IC43cHg7XG4gICAgICAgICAgICAgICAgbWFyZ2luLWJvdHRvbTogMTBweDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICNwcmljZUNoZWNrSW5wdXQge1xuICAgICAgICAgICAgICAgIHdpZHRoOiAxMDAlOyBwYWRkaW5nOiA4cHggNDRweCA4cHggMTJweDtcbiAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZmZmZmZmOyBib3JkZXI6IDEuNXB4IHNvbGlkICNjYmQ1ZTE7XG4gICAgICAgICAgICAgICAgYm9yZGVyLXJhZGl1czogMTBweDsgY29sb3I6ICMxZjI5Mzc7IGZvbnQtc2l6ZTogMTNweDtcbiAgICAgICAgICAgICAgICBib3gtc2l6aW5nOiBib3JkZXItYm94OyBvdXRsaW5lOiBub25lO1xuICAgICAgICAgICAgICAgIHRyYW5zaXRpb246IGJvcmRlci1jb2xvciAuMnMsIGJveC1zaGFkb3cgLjJzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tJbnB1dDpmb2N1cyB7XG4gICAgICAgICAgICAgICAgYm9yZGVyLWNvbG9yOiAjNjM2NmYxOyBib3gtc2hhZG93OiAwIDAgMCAzcHggIzYzNjZmMTE4O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tJbnB1dDo6cGxhY2Vob2xkZXIgeyBjb2xvcjogIzk0YTNiODsgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIgc2VsZWN0LFxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIgaW5wdXRbdHlwZT1cInJhbmdlXCJdIHsgYWNjZW50LWNvbG9yOiM0ZjQ2ZTU7IH1cbiAgICAgICAgICAgICNwcmljZUNoZWNrQ29udGFpbmVyIGxhYmVsIHsgY29sb3I6IzQ3NTU2OSAhaW1wb3J0YW50OyB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAubWMtcGFuZWwgaW5wdXRbdHlwZT1cInRleHRcIl0sXG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAubWMtcGFuZWwgdGV4dGFyZWEsXG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAubWMtcGFuZWwgc2VsZWN0IHsgYmFja2dyb3VuZDojZmZmZmZmICFpbXBvcnRhbnQ7IGNvbG9yOiMzMzQxNTUgIWltcG9ydGFudDsgYm9yZGVyLWNvbG9yOiNjYmQ1ZTEgIWltcG9ydGFudDsgfVxuICAgICAgICAgICAgI2hhdGlrb1JlcXVlc3RTdGF0dXMgeyBkaXNwbGF5Om5vbmU7IGNvbG9yOiM0NzU1Njk7IGZvbnQtc2l6ZToxMHB4OyBtaW4taGVpZ2h0OjE0cHg7IHBhZGRpbmc6NXB4IDhweDsgYm9yZGVyLXJhZGl1czo3cHg7IGJhY2tncm91bmQ6I2YxZjVmOTsgYm9yZGVyOjFweCBzb2xpZCAjZTJlOGYwOyB9XG4gICAgICAgICAgICAjaGF0aWtvUmVxdWVzdFN0YXR1c1tkYXRhLXN0YXRlXSB7IGRpc3BsYXk6YmxvY2s7IH1cbiAgICAgICAgICAgICNoYXRpa29SZXF1ZXN0U3RhdHVzW2RhdGEtc3RhdGU9XCJidXN5XCJdIHsgY29sb3I6IzFkNGVkODsgYmFja2dyb3VuZDojZGJlYWZlOyB9XG4gICAgICAgICAgICAjaGF0aWtvUmVxdWVzdFN0YXR1c1tkYXRhLXN0YXRlPVwib2tcIl0geyBjb2xvcjojMTY2NTM0OyBiYWNrZ3JvdW5kOiNkY2ZjZTc7IH1cbiAgICAgICAgICAgICNoYXRpa29SZXF1ZXN0U3RhdHVzW2RhdGEtc3RhdGU9XCJ3YXJuXCJdIHsgY29sb3I6IzkyNDAwZTsgYmFja2dyb3VuZDojZmVmM2M3OyB9XG4gICAgICAgICAgICAjaGF0aWtvUmVxdWVzdFN0YXR1c1tkYXRhLXN0YXRlPVwiZXJyb3JcIl0geyBjb2xvcjojOTkxYjFiOyBiYWNrZ3JvdW5kOiNmZWUyZTI7IH1cbiAgICAgICAgICAgIC5tYy1saW5rcy1wYW5lbCB7XG4gICAgICAgICAgICAgICAgZGlzcGxheTpub25lOyBtYXgtaGVpZ2h0OjE1MHB4OyBvdmVyZmxvdy15OmF1dG87XG4gICAgICAgICAgICAgICAgYmFja2dyb3VuZDojZmZmZmZmOyBib3JkZXI6MXB4IHNvbGlkICNlNWU3ZWI7XG4gICAgICAgICAgICAgICAgYm9yZGVyLXJhZGl1czoxMHB4OyBwYWRkaW5nOjhweCAxMHB4OyBmb250LXNpemU6MTFweDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5tYy1saW5rcy1wYW5lbCBhIHsgZGlzcGxheTpibG9jazsgY29sb3I6IzI1NjNlYjsgbWFyZ2luOjRweCAwOyB3b3JkLWJyZWFrOmJyZWFrLWFsbDsgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvKiDilIDilIAg0JLQutC70LDQtNC60Lgg4pSA4pSAICovXG4gICAgICAgICAgICAgICAgICAgICAgICAjbWNUYWJzIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBmbGV4OyBmbGV4OiAwIDAgYXV0bzsgbWluLWhlaWdodDogMzJweDsgYWxpZ24taXRlbXM6IHN0cmV0Y2g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZ2FwOiA0cHg7IG92ZXJmbG93LXg6IGF1dG87IG92ZXJmbG93LXk6IHZpc2libGU7IGZsZXgtd3JhcDogbm93cmFwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZGRpbmc6IDFweCAwIDNweDsgYm94LXNpemluZzogYm9yZGVyLWJveDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICNtY1RhYnM6Oi13ZWJraXQtc2Nyb2xsYmFyIHsgaGVpZ2h0OiAzcHg7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy10YWIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZsZXg6IDAgMCBhdXRvOyBtaW4taGVpZ2h0OiAyOHB4OyBoZWlnaHQ6IDI4cHg7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogaW5saW5lLWZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZGRpbmc6IDRweCA4cHg7IGJvcmRlcjogMXB4IHNvbGlkICNlMmU4ZjA7IGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZjhmYWZjOyBjb2xvcjogIzQ3NTU2OTsgZm9udC1zaXplOiAxMXB4OyBmb250LXdlaWdodDogNjAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpbmUtaGVpZ2h0OiAxOHB4OyBjdXJzb3I6IHBvaW50ZXI7IHRyYW5zaXRpb246IGFsbCAuMTVzIGVhc2U7IHdoaXRlLXNwYWNlOiBub3dyYXA7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtdGFiOmhvdmVyIHsgYm9yZGVyLWNvbG9yOiAjNjM2NmYxOyBjb2xvcjogIzRmNDZlNTsgYmFja2dyb3VuZDogI2VlZjJmZjsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXRhYi1hY3RpdmUge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzYzNjZmMSwjOGI1Y2Y2KSAhaW1wb3J0YW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlci1jb2xvcjogdHJhbnNwYXJlbnQgIWltcG9ydGFudDsgY29sb3I6ICNmZmYgIWltcG9ydGFudDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3gtc2hhZG93OiAwIDJweCA4cHggIzYzNjZmMTM4O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvKiDilIDilIAg0JvQtdC9dGEg0YHQvtC+0LHRidC10L3QuNC5ICjQstC80LXRgdGCbyB0ZXh0YXJlYSkg4pSA4pSAICovXG4gICAgICAgICAgICAgICAgICAgICAgICAjbWNDaGF0TG9nIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmbGV4OiAxIDEgYXV0bzsgd2lkdGg6IDEwMCU7IG1pbi1oZWlnaHQ6IDgwcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogNnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG92ZXJmbG93LXk6IGF1dG87IHBhZGRpbmc6IDZweDsgYm94LXNpemluZzogYm9yZGVyLWJveDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZmZmZmZmOyBib3JkZXI6IDEuNXB4IHNvbGlkICNlNWU3ZWI7IGJvcmRlci1yYWRpdXM6IDEwcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAjbWNDaGF0TG9nOmVtcHR5OjphZnRlciB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudDogJ9CX0LDQv9GA0L7RgdGLINC/0L7Rj9Cy0Y/RgtGB0Y8g0LfQtNC10YHRjOKApic7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogYmxvY2s7IG1hcmdpbjogYXV0bzsgY29sb3I6ICM5NGEzYjg7IGZvbnQtc2l6ZTogMTFweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250LXN0eWxlOiBpdGFsaWM7IG9wYWNpdHk6IC44O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW1zZyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWF4LXdpZHRoOiA5MiU7IHBhZGRpbmc6IDVweCA5cHg7IGJvcmRlci1yYWRpdXM6IDEwcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMS41cHg7IGxpbmUtaGVpZ2h0OiAxLjU1OyB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnLW1ldGEge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnQtc2l6ZTogOC41cHg7IG9wYWNpdHk6IC42NTsgbGV0dGVyLXNwYWNpbmc6IC4zcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWFyZ2luLWJvdHRvbTogMnB4OyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW1zZy1ib2R5IHsgd2hpdGUtc3BhY2U6IHByZS13cmFwOyB3b3JkLWJyZWFrOiBicmVhay13b3JkOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnLXVzZXIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWduLXNlbGY6IGZsZXgtZW5kOyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM2MzY2ZjEsIzdjM2FlZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6ICNmZmY7IGJvcmRlci1ib3R0b20tcmlnaHQtcmFkaXVzOiAzcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnLXVzZXIgLm1jLW1zZy1tZXRhIHsgY29sb3I6ICNlMGU3ZmY7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1tc2ctYm90IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbGlnbi1zZWxmOiBmbGV4LXN0YXJ0OyBiYWNrZ3JvdW5kOiAjZjFmNWY5OyBjb2xvcjogIzFmMjkzNztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViOyBib3JkZXItYm90dG9tLWxlZnQtcmFkaXVzOiAzcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnLWJvdCAubWMtbXNnLW1ldGEgeyBjb2xvcjogIzYzNjZmMTsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW1zZy1zeXN0ZW0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWduLXNlbGY6IGNlbnRlcjsgYmFja2dyb3VuZDogI2ZlZjljMzsgY29sb3I6ICM4NTRkMGU7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyOiAxcHggc29saWQgI2ZkZTY4YTsgZm9udC1zaXplOiAxMC41cHg7IHRleHQtYWxpZ246IGNlbnRlcjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1jb3B5LWJ0biB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogaW5saW5lLWJsb2NrOyBtYXJnaW4tdG9wOiA1cHg7IHBhZGRpbmc6IDJweCA4cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyOiAxcHggc29saWQgI2M3ZDJmZTsgYm9yZGVyLXJhZGl1czogNnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmZmZmZmY7IGNvbG9yOiAjNGY0NmU1OyBmb250LXNpemU6IDkuNXB4OyBmb250LXdlaWdodDogNjAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYWxsIC4xNXM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWMtY29weS1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiAjZWVmMmZmOyBib3JkZXItY29sb3I6ICM4MThjZjg7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1jb3B5LWRvbmUgeyBiYWNrZ3JvdW5kOiAjZGNmY2U3ICFpbXBvcnRhbnQ7IGJvcmRlci1jb2xvcjogIzg2ZWZhYyAhaW1wb3J0YW50OyBjb2xvcjogIzE2NjUzNCAhaW1wb3J0YW50OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWMtcmV0cnktYnRuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IG1hcmdpbi10b3A6IDVweDsgcGFkZGluZzogMnB4IDhweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjYTVkNmYyOyBib3JkZXItcmFkaXVzOiA2cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDogI2ZmZmZmZjsgY29sb3I6ICMxZDRlZDg7IGZvbnQtc2l6ZTogOS41cHg7IGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3Vyc29yOiBwb2ludGVyOyB0cmFuc2l0aW9uOiBhbGwgLjE1cztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1yZXRyeS1idG46aG92ZXIgeyBiYWNrZ3JvdW5kOiAjZGJlYWZlOyBib3JkZXItY29sb3I6ICM2MGE1ZmE7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1tc2ctYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogNHB4OyBmbGV4LXdyYXA6IHdyYXA7IH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLyog4pSA4pSAINCd0LjQttC90Y/RjyDQv9Cw0L3QtdC70Ywg4pSA4pSAICovXG4gICAgICAgICAgICAgICAgICAgICAgICAjbWNCb3R0b21CYXIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZsZXg6IDAgMCBhdXRvOyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtZW5kOyBnYXA6IDZweDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1idG4tY2xlYXIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZGRpbmc6IDVweCAxMnB4OyBib3JkZXI6IDFweCBzb2xpZCAjZmNhNWE1OyBib3JkZXItcmFkaXVzOiA4cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDogI2ZmZmZmZjsgY29sb3I6ICNkYzI2MjY7IGZvbnQtc2l6ZTogMTFweDsgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJzb3I6IHBvaW50ZXI7IHRyYW5zaXRpb246IGFsbCAuMTVzO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWJ0bi1jbGVhcjpob3ZlciB7IGJhY2tncm91bmQ6ICNmZWYyZjI7IGJvcmRlci1jb2xvcjogI2VmNDQ0NDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWFjdGlvbi1idG4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZGRpbmc6IDRweCA5cHg7IGJvcmRlcjogMXB4IHNvbGlkICNlMmU4ZjA7IGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZjhmYWZjOyBmb250LXNpemU6IDEzcHg7IGxpbmUtaGVpZ2h0OiAxOyBjdXJzb3I6IHBvaW50ZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJhbnNpdGlvbjogYWxsIC4xNXM7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtYWN0aW9uLWJ0bjpob3ZlciB7IGJhY2tncm91bmQ6ICNlZWYyZmY7IGJvcmRlci1jb2xvcjogIzgxOGNmODsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKC0xcHgpOyB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8qIOKUgOKUgCDQodGC0LDRgtGD0YEt0LHQsNGAOiDQv9C+0LTRgdC60LDQt9C60Lgg0L/RgNC4INC90LDQstC10LTQtdC90LjQuCDilIDilIAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1zdGF0dXMtYmFyIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmbGV4OiAxIDEgYXV0bzsgbWluLXdpZHRoOiAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnQtc2l6ZTogMTBweDsgY29sb3I6ICM2NDc0OGI7IGxpbmUtaGVpZ2h0OiAxLjM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDsgb3ZlcmZsb3c6IGhpZGRlbjsgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdXNlci1zZWxlY3Q6IG5vbmU7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8qIOKUgOKUgCDQn9C70LDQstCw0Y7RidC40LUg0L7QutC90LAgKNGA0LDRgdC/0LjRgdCw0L3QuNC1LCDQpdCw0LrQtdGAKSDigJQg0LHQtdC3INC30LDRgtC10LzQvdC10L3QuNGPIOKUgOKUgCAqL1xuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWZsb2F0LXdpbmRvdyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IGZpeGVkOyB0b3A6IDkwcHg7IHJpZ2h0OiA0MHB4OyB3aWR0aDogMzgwcHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbWF4LWhlaWdodDogNzB2aDsgYmFja2dyb3VuZDogI2ZmZmZmZjsgYm9yZGVyOiAxcHggc29saWQgI2RiZTNlZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXItcmFkaXVzOiAxNHB4OyBib3gtc2hhZG93OiAwIDE0cHggNDBweCByZ2JhKDE1LDIzLDQyLC4xOCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiA4cHg7IHBhZGRpbmc6IDEycHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgei1pbmRleDogMTAwMDAwOyBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yOiAjMWYyOTM3OyBmb250LXNpemU6IDEyLjVweDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1mbG9hdC1oZWFkZXIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJzb3I6IG1vdmU7IHVzZXItc2VsZWN0OiBub25lOyBwYWRkaW5nLWJvdHRvbTogNnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZTJlOGYwO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWZsb2F0LXRpdGxlIHsgZm9udC1zaXplOiAxMy41cHg7IGZvbnQtd2VpZ2h0OiA3MDA7IGNvbG9yOiAjMTExODI3OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtZmxvYXQtY2xvc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMDsgYm9yZGVyLXJhZGl1czogN3B4OyBwYWRkaW5nOiA0cHggOHB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmMWY1Zjk7IGNvbG9yOiAjNjQ3NDhiOyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogMTJweDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1mbG9hdC1jbG9zZTpob3ZlciB7IGJhY2tncm91bmQ6ICNmZWUyZTI7IGNvbG9yOiAjZGMyNjI2OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtZmxvYXQtYm9keSB7IGZsZXg6IDEgMSBhdXRvOyBvdmVyZmxvdy15OiBhdXRvOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtZmxvYXQtZm9vdGVyIHsgZGlzcGxheTogZmxleDsganVzdGlmeS1jb250ZW50OiBmbGV4LWVuZDsgbWFyZ2luLXRvcDogOHB4OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtY2l0eSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMXB4OyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogIzRmNDZlNTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZWVmMmZmOyBib3JkZXI6IDFweCBzb2xpZCAjYzdkMmZlOyBib3JkZXItcmFkaXVzOiA4cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFkZGluZzogNHB4IDlweDsgbWFyZ2luLXRvcDogNnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXNjaGVkLXJvdyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMS41cHg7IHBhZGRpbmc6IDRweCA5cHg7IG1hcmdpbi10b3A6IDRweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViOyBib3JkZXItcmFkaXVzOiA3cHg7IGJhY2tncm91bmQ6ICNmZmZmZmY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6ICMxZjI5Mzc7IHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsgd29yZC1icmVhazogYnJlYWstd29yZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLyog4pSA4pSAINCe0LLQtdGA0LvQtdC4IOKUgOKUgCAqL1xuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW92ZXJsYXkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7IHotaW5kZXg6IDEwMDAwMDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYWRkaW5nOiAyMHB4OyBiYWNrZ3JvdW5kOiByZ2JhKDIsNiwyMywuNzIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW92ZXJsYXktbW9kYWwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBtaW4oNjIwcHgsIGNhbGMoMTAwdncgLSA0MHB4KSk7IG1heC1oZWlnaHQ6IDgwdmg7IG92ZXJmbG93OiBhdXRvO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZGRpbmc6IDE2cHg7IGJhY2tncm91bmQ6ICNmZmZmZmY7IGJvcmRlcjogMXB4IHNvbGlkICNkYmUzZWU7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyLXJhZGl1czogMTZweDsgYm94LXNoYWRvdzogMCAxOHB4IDYwcHggcmdiYSgwLDAsMCwuNik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6ICMxZjI5Mzc7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheS1oZWFkZXIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgbWFyZ2luLWJvdHRvbTogMTJweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250LXNpemU6IDE1cHg7IGNvbG9yOiAjMTExODI3O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW92ZXJsYXktY2xvc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMDsgYm9yZGVyLXJhZGl1czogN3B4OyBwYWRkaW5nOiA2cHggOXB4OyBiYWNrZ3JvdW5kOiAjZjFmNWY5OyBjb2xvcjogIzQ3NTU2OTsgY3Vyc29yOiBwb2ludGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW92ZXJsYXktY2xvc2U6aG92ZXIgeyBiYWNrZ3JvdW5kOiAjZmVlMmUyOyBjb2xvcjogI2RjMjYyNjsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW92ZXJsYXktZm9vdGVyIHsgZGlzcGxheTogZmxleDsganVzdGlmeS1jb250ZW50OiBmbGV4LWVuZDsgbWFyZ2luLXRvcDogMTJweDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW92ZXJsYXktZXJyb3IgeyBjb2xvcjogIzk5MWIxYjsgYmFja2dyb3VuZDogI2ZlZTJlMjsgYm9yZGVyOiAxcHggc29saWQgI2ZlY2FjYTsgYm9yZGVyLXJhZGl1czogMTBweDsgcGFkZGluZzogMTBweDsgZm9udC1zaXplOiAxMnB4OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtY2l0eSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMXB4OyBmb250LXdlaWdodDogNzAwOyBiYWNrZ3JvdW5kOiAjZjhmYWZjOyBib3JkZXI6IDFweCBzb2xpZCAjZTVlN2ViO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDhweCA4cHggMCAwOyBwYWRkaW5nOiA1cHggMTBweDsgbWFyZ2luLXRvcDogOHB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXNjaGVkLXRhYmxlIHsgd2lkdGg6IDEwMCU7IGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7IGZvbnQtc2l6ZTogMTEuNXB4OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtdGFibGUgdGgsIC5tYy1zY2hlZC10YWJsZSB0ZCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGV4dC1hbGlnbjogbGVmdDsgcGFkZGluZzogNXB4IDEwcHg7IGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtdGFibGUgdGggeyBiYWNrZ3JvdW5kOiAjZjFmNWY5OyBjb2xvcjogIzQ3NTU2OTsgZm9udC1zaXplOiAxMHB4OyB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogLjVweDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXNjaGVkLXRhYmxlIHRib2R5IHRyOm50aC1jaGlsZChvZGQpIHsgYmFja2dyb3VuZDogI2ZhZmJmZjsgfVxuICAgICAgICAgICAgICAgICAgICBgO1xuICAgICAgICBkb2N1bWVudC5oZWFkLmFwcGVuZENoaWxkKHN0eWxlKTtcblxuICAgICAgICBjb25zdCBjb250YWluZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgY29udGFpbmVyLmlkID0gJ3ByaWNlQ2hlY2tDb250YWluZXInO1xuICAgICAgICBjb250YWluZXIuc3R5bGUuY3NzVGV4dCA9IGBcbiAgICAgICAgICAgIHBvc2l0aW9uOmZpeGVkOyB0b3A6MTRweDsgcmlnaHQ6MTRweDsgd2lkdGg6NDMwcHg7XG4gICAgICAgICAgICBtaW4taGVpZ2h0OjU0MHB4OyBtYXgtaGVpZ2h0Ojkzdmg7XG4gICAgICAgICAgICBiYWNrZ3JvdW5kOiNmZmZmZmY7XG4gICAgICAgICAgICBib3JkZXI6MXB4IHNvbGlkICNkYmUzZWU7XG4gICAgICAgICAgICBib3JkZXItcmFkaXVzOjE4cHg7XG4gICAgICAgICAgICBib3gtc2hhZG93OjAgMTZweCA0NnB4IHJnYmEoMTUsMjMsNDIsLjIyKSwgMCAwIDAgMXB4IHJnYmEoMjU1LDI1NSwyNTUsLjkpO1xuICAgICAgICAgICAgcGFkZGluZzoxNHB4OyBkaXNwbGF5Om5vbmU7IHotaW5kZXg6OTk5OTk7XG4gICAgICAgICAgICBib3gtc2l6aW5nOmJvcmRlci1ib3g7IGZsZXgtZGlyZWN0aW9uOmNvbHVtbjsgZ2FwOjEwcHg7XG4gICAgICAgICAgICByZXNpemU6Ym90aDsgb3ZlcmZsb3c6YXV0bztcbiAgICAgICAgYDtcblxuICAgICAgICBjb250YWluZXIuaW5uZXJIVE1MID0gYFxuICAgICAgICAgICAgPCEtLSDilIDilIAg0KjQsNC/0LrQsCDilIDilIAgLS0+XG4gICAgICAgICAgICA8ZGl2IGlkPVwicHJpY2VDaGVja0hlYWRlclwiIHN0eWxlPVwiXG4gICAgICAgICAgICAgICAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtcbiAgICAgICAgICAgICAgICBjdXJzb3I6bW92ZTt1c2VyLXNlbGVjdDpub25lO3BhZGRpbmctYm90dG9tOjExcHg7XG4gICAgICAgICAgICAgICAgYm9yZGVyLWJvdHRvbToxcHggc29saWQgI2UyZThmMDtcbiAgICAgICAgICAgIFwiPlxuICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9XCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo5cHg7XCI+XG4gICAgICAgICAgICAgICAgICAgIDxkaXYgc3R5bGU9XCJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOjM0cHg7aGVpZ2h0OjM0cHg7Ym9yZGVyLXJhZGl1czo5cHg7ZmxleC1zaHJpbms6MDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCNhODU1ZjcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOjE3cHg7Ym94LXNoYWRvdzowIDNweCAxMHB4ICM2MzY2ZjEzODtcbiAgICAgICAgICAgICAgICAgICAgXCI+8J+QsTwvZGl2PlxuICAgICAgICAgICAgICAgICAgICA8ZGl2PlxuICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojMTExODI3O2xpbmUtaGVpZ2h0OjEuMjtcIj7QnNC10LzQvdGL0Lkg0YfQsNGCPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwibWVtY2hhdFRhYlRpdGxlXCIgc3R5bGU9XCJmb250LXNpemU6MTBweDtmb250LXdlaWdodDo2MDA7Y29sb3I6IzRmNDZlNTtsZXR0ZXItc3BhY2luZzouM3B4O21hcmdpbi10b3A6MXB4O1wiPvCfkLYgSGF0aWtvPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwibWVtY2hhdFZlcnNpb25cIiBzdHlsZT1cImZvbnQtc2l6ZTo4LjVweDtjb2xvcjojOTRhM2I4O2xldHRlci1zcGFjaW5nOi41cHg7bWFyZ2luLXRvcDoxcHg7XCI+PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwibWVtY2hhdEJlYXJlclN0YXR1c1wiIHN0eWxlPVwiZm9udC1zaXplOjguNXB4O2NvbG9yOiM5NGEzYjg7bWFyZ2luLXRvcDoxcHg7XCI+PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJwcmljZUNoZWNrQ2xvc2VCdXR0b25cIiBzdHlsZT1cIlxuICAgICAgICAgICAgICAgICAgICB3aWR0aDoyOXB4O2hlaWdodDoyOXB4O2JvcmRlci1yYWRpdXM6OHB4O2JvcmRlcjpub25lO1xuICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiNmMWY1Zjk7Y29sb3I6IzY0NzQ4Yjtmb250LXNpemU6MTNweDtcbiAgICAgICAgICAgICAgICAgICAgY3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjE4cztcbiAgICAgICAgICAgICAgICAgICAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2ZsZXgtc2hyaW5rOjA7XG4gICAgICAgICAgICAgICAgXCI+4pyVPC9idXR0b24+XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgPCEtLSDilIDilIAg0JLQutC70LDQtNC60LggKNGN0LzQvtC00LfQuDsg0L/QvtC70L3QvtC1INC90LDQt9Cy0LDQvdC40LUg4oCUINCyINC30LDQs9C+0LvQvtCy0LrQtSkg4pSA4pSAIC0tPlxuICAgICAgICAgICAgPGRpdiBpZD1cIm1jVGFic1wiIHJvbGU9XCJ0YWJsaXN0XCI+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1jLXRhYlwiIGRhdGEtdGFiPVwiY2hlY2tIYXRpa29cIiBkYXRhLXRpcD1cIvCfkLYgSGF0aWtvIOKAlCDQv9C+0LjRgdC6INC4INGG0LXQvdGLXCI+8J+QtjwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJtYy10YWJcIiBkYXRhLXRhYj1cImNoZWNrSGF0aWtvQm9udXNlc1wiIGRhdGEtdGlwPVwi8J+OgSDQkdC+0L3Rg9GB0Ysg4oCUINCx0L7QvdGD0YHRiyDQutC70LjQtdC90YLQsFwiPvCfjoE8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJ0b2RheVwiIGRhdGEtdGlwPVwi8J+foiDQmtGC0L4g0YDQsNCx0L7RgtCw0LXRgiDRgdC10LPQvtC00L3Rj1wiPvCfn6I8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJ0b21vcnJvd1wiIGRhdGEtdGlwPVwi8J+foSDQmtGC0L4g0YDQsNCx0L7RgtCw0LXRgiDQt9Cw0LLRgtGA0LBcIj7wn5+hPC9idXR0b24+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1jLXRhYlwiIGRhdGEtdGFiPVwiY2FsY3VsYXRvclwiIGRhdGEtdGlwPVwi8J+nriDQmtCw0LvRjNC60YPQu9GP0YLQvtGAIOKAlCDRgNCw0YHRh9GR0YIg0LrRgNC10LTQuNGC0LBcIj7wn6euPC9idXR0b24+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1jLXRhYlwiIGRhdGEtdGFiPVwiY2FsY3VsYXRvcl9yZXZlcnNlXCIgZGF0YS10aXA9XCLwn5SEINCg0LXQstC10YDRgSDigJQg0L7QsdGA0LDRgtC90YvQuSDRgNCw0YHRh9GR0YJcIj7wn5SEPC9idXR0b24+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1jLXRhYlwiIGRhdGEtdGFiPVwiY2FsY3VsYXRvcl9kaXNjb3VudFwiIGRhdGEtdGlwPVwi8J+OiSDQodC60LjQtNC60LAg4oCUINGB0LrQuNC00LrQsCDQuCDQvdCw0YbQtdC90LrQsFwiPvCfjok8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJjYWxjdWxhdG9yX3NpbXBsZVwiIGRhdGEtdGlwPVwi4oiRINCf0YDQvtGB0YLQvtC5IOKAlCDQv9GA0L7RgdGC0L7QtSDQstGL0YDQsNC20LXQvdC40LVcIj7iiJE8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJoYWNrZXJcIiBkYXRhLXRpcD1cIvCfkLHigI3wn5K7INCl0LDRgtC40LrQvtCl0LDQutC10YBcIiBoaWRkZW4+8J+QseKAjfCfkrs8L2J1dHRvbj5cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8IS0tIOKUgOKUgCDQn9C+0LvQtSDQstCy0L7QtNCwIOKUgOKUgCAtLT5cbiAgICAgICAgICAgIDxkaXYgaWQ9XCJtY0lucHV0UmVnaW9uXCIgc3R5bGU9XCJwb3NpdGlvbjpyZWxhdGl2ZTtcIj5cbiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cInRleHRcIiBpZD1cInByaWNlQ2hlY2tJbnB1dFwiIHBsYWNlaG9sZGVyPVwi0JDRgNGC0LjQutGD0LssINGC0L7QstCw0YAg0LjQu9C4INGB0YPQvNC80LDigKZcIj5cbiAgICAgICAgICAgICAgICA8c3BhbiBzdHlsZT1cIlxuICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjphYnNvbHV0ZTtyaWdodDoxMXB4O3RvcDo1MCU7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTUwJSk7XG4gICAgICAgICAgICAgICAgICAgIGZvbnQtc2l6ZTo5LjVweDtjb2xvcjojMjgzMzQ3O3BvaW50ZXItZXZlbnRzOm5vbmU7XG4gICAgICAgICAgICAgICAgXCI+RW50ZXIg4oa1PC9zcGFuPlxuICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIDwhLS0g4pSA4pSAINCb0L7QsyAvINGA0LXQt9GD0LvRjNGC0LDRgiDilIDilIAgLS0+XG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwibWNSZXN1bHRSZWdpb25cIiBzdHlsZT1cImZsZXg6MSAxIGF1dG87ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6OHB4O21pbi1oZWlnaHQ6ODBweDtcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwibWNDaGF0TG9nXCIgcm9sZT1cImxvZ1wiPjwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJoYXRpa29SZXF1ZXN0U3RhdHVzXCIgcm9sZT1cInN0YXR1c1wiIGFyaWEtbGl2ZT1cInBvbGl0ZVwiPjwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJoYXRpa29SZW9wZW5QaWNrZXJCdXR0b25cIiB0eXBlPVwiYnV0dG9uXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmU7cGFkZGluZzo1cHggOHB4O2JvcmRlcjoxcHggc29saWQgIzQ3NTU2OTtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzQ3NTU2OTtjdXJzb3I6cG9pbnRlcjtcIj7ihrYg0JLRi9Cx0YDQsNGC0Ywg0LTRgNGD0LPQvtC5INGC0L7QstCw0YA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwiaGF0aWtvTGlua3NQYW5lbFwiIGNsYXNzPVwibWMtbGlua3MtcGFuZWxcIj48L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8ZGl2IGlkPVwibWNTcGVjaWFsUGFuZVwiIHN0eWxlPVwiZGlzcGxheTpub25lO2ZsZXg6MSAxIGF1dG87bWluLWhlaWdodDoxMjBweDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtvdmVyZmxvdzpoaWRkZW47XCI+PC9kaXY+XG5cbiAgICAgICAgICAgIDwhLS0g4pSA4pSAINCd0LjQttC90Y/RjyDQv9Cw0L3QtdC70Yw6INGB0YLQsNGC0YPRgSArINC00LXQudGB0YLQstC40Y8gKyDQvdCw0YHRgtGA0L7QudC60LggKyDQvtGH0LjRgdGC0LrQsCDilIDilIAgLS0+XG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGlkPVwibWNCb3R0b21CYXJcIiBzdHlsZT1cImZsZXg6MCAwIGF1dG87ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpmbGV4LWVuZDtnYXA6NnB4O2FsaWduLWl0ZW1zOmNlbnRlcjtcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBpZD1cIm1jU3RhdHVzQmFyXCIgY2xhc3M9XCJtYy1zdGF0dXMtYmFyXCI+0J3QsNCy0LXQtNC40YLQtSDQvdCwINC60L3QvtC/0LrRg+KApjwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwibWNDbGVhclRleHRUb2dnbGVcIiBjbGFzcz1cIm1jLWFjdGlvbi1idG5cIiB0eXBlPVwiYnV0dG9uXCIgYXJpYS1wcmVzc2VkPVwiZmFsc2VcIiBkYXRhLXRpcD1cIvCfp7kg0J7Rh9C40YnQsNGC0Ywg0LDQutGC0LjQstC90L7QtSDQv9C+0LvQtSDQv9C+0YHQu9C1IEVudGVyXCI+8J+nuTwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJtY0FjdGlvblNldHRpbmdzXCIgY2xhc3M9XCJtYy1hY3Rpb24tYnRuXCIgdHlwZT1cImJ1dHRvblwiIGRhdGEtdGlwPVwi4pqZ77iPINCd0LDRgdGC0YDQvtC50LrQuFwiPuKame+4jzwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJtY0NsZWFyQ2hhdEJ1dHRvblwiIGNsYXNzPVwibWMtYnRuLWNsZWFyXCIgdHlwZT1cImJ1dHRvblwiIGRhdGEtdGlwPVwi8J+XkSDQntGH0LjRgdGC0LjRgtGMINC40YHRgtC+0YDQuNGOINGN0YLQvtC5INCy0LrQu9Cw0LTQutC4XCI+8J+XkTwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgIGA7XG5cbiAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChjb250YWluZXIpO1xuICAgICAgICB3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lciA9IGNvbnRhaW5lcjtcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21lbWNoYXRWZXJzaW9uJykudGV4dENvbnRlbnQgPSBgdiR7TUVNQ0hBVF9WRVJTSU9OfSR7dHlwZW9mIE1FTUNIQVRfQlVJTEQgIT09ICd1bmRlZmluZWQnID8gYC0ke01FTUNIQVRfQlVJTER9YCA6ICcnfWA7XG4gICAgICAgIGhhY2tlclZhbGlkYXRlQXBpS2V5KCgpID0+IGhhY2tlclN5bmNBY2Nlc3NVaSgpKTtcbiAgICAgICAgc2V0dXBFdmVudExpc3RlbmVycygpO1xuICAgICAgICB1cGRhdGVDbGVhclRleHRCdXR0b24oKTtcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb1Jlb3BlblBpY2tlckJ1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcmVvcGVuSGF0aWtvUHJvZHVjdFBpY2tlcik7XG4gICAgfVxuXG4gICAgd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIuc3R5bGUuZGlzcGxheSA9ICdmbGV4JztcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykuZm9jdXMoKTtcbiAgICByZXN0b3JlU2VsZWN0ZWRBY3Rpb24oKTtcbiAgICBtZW1jaGF0UGxhdGZvcm0ub25NYWluQ3JlYXRlZD8uKCk7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUhhdGlrb1N0YXR1cyhtZXNzYWdlKSB7XG4gICAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb1JlcXVlc3RTdGF0dXMnKTtcbiAgICBpZiAoc3RhdHVzKSB7XG4gICAgICAgIHN0YXR1cy50ZXh0Q29udGVudCA9IGDwn5C2ICR7bWVzc2FnZX1gO1xuICAgICAgICBjb25zdCBsb3dlciA9IFN0cmluZyhtZXNzYWdlKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICBzdGF0dXMuZGF0YXNldC5zdGF0ZSA9IC/QvtGI0LjQsdC60LB80L3QtSDQvdCw0LnQtNC10L180L3QtdC00L7RgdGC0YPQvy8udGVzdChsb3dlcikgPyAnZXJyb3InXG4gICAgICAgICAgICA6IC9mYWxsYmFja3zQv9C10YDQtdC60LvRjtGH0LDRjtGB0Yx80L3QtSDQsNCy0YLQvtGA0LjQty8udGVzdChsb3dlcikgPyAnd2FybidcbiAgICAgICAgICAgIDogL9Cz0L7RgtC+0LLQvi8udGVzdChsb3dlcikgPyAnb2snIDogJ2J1c3knO1xuICAgIH1cbiAgICBkZWJ1Z0xvZygnaGF0aWtvLXN0YXR1cycsIG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBzZXR1cEhhdGlrb1NlYXJjaE1vZGVTZXR0aW5nKCkge1xuICAgIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYXRpa29TZWFyY2hNb2RlJyk7XG4gICAgaWYgKCFzZWxlY3QpIHJldHVybjtcbiAgICBoYXRpa29TZWFyY2hNb2RlID0gbG9hZEhhdGlrb1NlYXJjaE1vZGUoKTtcbiAgICBzZWxlY3QudmFsdWUgPSBoYXRpa29TZWFyY2hNb2RlO1xuICAgIHNlbGVjdC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiBzYXZlSGF0aWtvU2VhcmNoTW9kZShzZWxlY3QudmFsdWUpKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlSGF0aWtvTGlua3NQYW5lbChwYXRobmFtZSkge1xuICAgIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb0xpbmtzUGFuZWwnKTtcbiAgICBpZiAoIXBhbmVsKSByZXR1cm47XG4gICAgcGFuZWwuaW5uZXJIVE1MID0gJyc7XG4gICAgaWYgKCFsb2FkU2hvd0hhdGlrb0xpbmtzKCkgfHwgIXBhdGhuYW1lKSB7XG4gICAgICAgIHBhbmVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgQkFTRV9VUkxTLmZvckVhY2goKGJhc2VVcmwsIGkpID0+IHtcbiAgICAgICAgY29uc3QgbGluayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTtcbiAgICAgICAgbGluay5ocmVmID0gYCR7YmFzZVVybH0ke3BhdGhuYW1lfWA7XG4gICAgICAgIGxpbmsudGFyZ2V0ID0gJ19ibGFuayc7XG4gICAgICAgIGxpbmsucmVsID0gJ25vb3BlbmVyIG5vcmVmZXJyZXInO1xuICAgICAgICBsaW5rLnRleHRDb250ZW50ID0gYPCfjJAke0NJVFlfSUNPTlNbaV19ICR7Q0lUWV9OQU1FU1tpXX06ICR7bGluay5ocmVmfWA7XG4gICAgICAgIHBhbmVsLmFwcGVuZENoaWxkKGxpbmspO1xuICAgIH0pO1xuICAgIHBhbmVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xufVxuXG5mdW5jdGlvbiBzZXR1cEhhdGlrb0xpbmtzU2V0dGluZygpIHtcbiAgICBjb25zdCBjaGVja2JveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzaG93SGF0aWtvTGlua3NDaGVja2JveCcpO1xuICAgIGlmICghY2hlY2tib3gpIHJldHVybjtcbiAgICBjaGVja2JveC5jaGVja2VkID0gbG9hZFNob3dIYXRpa29MaW5rcygpO1xuICAgIGNoZWNrYm94LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgc2F2ZVNob3dIYXRpa29MaW5rcyhjaGVja2JveC5jaGVja2VkKTtcbiAgICAgICAgdXBkYXRlSGF0aWtvTGlua3NQYW5lbChjdXJyZW50SGF0aWtvUGF0aG5hbWUpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBjbG9zZUhhdGlrb1Byb2R1Y3RQaWNrZXIoKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb1Byb2R1Y3RQaWNrZXInKT8ucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIHJlb3BlbkhhdGlrb1Byb2R1Y3RQaWNrZXIoKSB7XG4gICAgaWYgKGxhc3RIYXRpa29SZXN1bHRzLmxlbmd0aCA+IDEpIG9wZW5IYXRpa29Qcm9kdWN0UGlja2VyKGxhc3RIYXRpa29SZXN1bHRzLCBsYXN0SGF0aWtvUXVlcnkpO1xufVxuXG5mdW5jdGlvbiBjb3B5SGF0aWtvVGV4dCh0ZXh0KSB7XG4gICAgY29uc3QgZmFsbGJhY2sgPSAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHRleHRhcmVhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGV4dGFyZWEnKTtcbiAgICAgICAgdGV4dGFyZWEudmFsdWUgPSB0ZXh0O1xuICAgICAgICB0ZXh0YXJlYS5zdHlsZS5wb3NpdGlvbiA9ICdmaXhlZCc7XG4gICAgICAgIHRleHRhcmVhLnN0eWxlLm9wYWNpdHkgPSAnMCc7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQodGV4dGFyZWEpO1xuICAgICAgICB0ZXh0YXJlYS5zZWxlY3QoKTtcbiAgICAgICAgZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2NvcHknKTtcbiAgICAgICAgdGV4dGFyZWEucmVtb3ZlKCk7XG4gICAgfTtcblxuICAgIGlmIChuYXZpZ2F0b3IuY2xpcGJvYXJkPy53cml0ZVRleHQpIHtcbiAgICAgICAgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQodGV4dCkuY2F0Y2goZmFsbGJhY2spO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGZhbGxiYWNrKCk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHZhbHVlKSB7XG4gICAgcmV0dXJuIFN0cmluZyh2YWx1ZSkucmVwbGFjZSgvWyY8PidcXFwiXS9nLCBjaGFyID0+ICh7XG4gICAgICAgICcmJzogJyZhbXA7JywgJzwnOiAnJmx0OycsICc+JzogJyZndDsnLCBcIidcIjogJyYjMzk7JywgJ1xcXCInOiAnJnF1b3Q7J1xuICAgIH1bY2hhcl0pKTtcbn1cblxuZnVuY3Rpb24gb3BlbkhhdGlrb1Byb2R1Y3RQaWNrZXIocmVzdWx0cywgcXVlcnkpIHtcbiAgICBjbG9zZUhhdGlrb1Byb2R1Y3RQaWNrZXIoKTtcblxuICAgIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBvdmVybGF5LmlkID0gJ2hhdGlrb1Byb2R1Y3RQaWNrZXInO1xuICAgIG92ZXJsYXkuc3R5bGUuY3NzVGV4dCA9IGBcbiAgICAgICAgcG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDt6LWluZGV4OjEwMDAwMDtcbiAgICAgICAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO1xuICAgICAgICBwYWRkaW5nOjIwcHg7YmFja2dyb3VuZDpyZ2JhKDIsNiwyMywuNzIpO1xuICAgIGA7XG5cbiAgICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIG1vZGFsLnN0eWxlLmNzc1RleHQgPSBgXG4gICAgICAgIHdpZHRoOm1pbig3MjBweCwgY2FsYygxMDB2dyAtIDQwcHgpKTttYXgtaGVpZ2h0Ojgwdmg7b3ZlcmZsb3c6YXV0bztcbiAgICAgICAgcGFkZGluZzoxNnB4O2JhY2tncm91bmQ6IzExMTgyNztib3JkZXI6MXB4IHNvbGlkICMzMzQxNTU7XG4gICAgICAgIGJvcmRlci1yYWRpdXM6MTZweDtib3gtc2hhZG93OjAgMThweCA2MHB4IHJnYmEoMCwwLDAsLjYpO1xuICAgICAgICBjb2xvcjojZTJlOGYwO2ZvbnQtZmFtaWx5OidTZWdvZSBVSScsc3lzdGVtLXVpLHNhbnMtc2VyaWY7XG4gICAgYDtcblxuICAgIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWRlci5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLWJvdHRvbToxMnB4Oyc7XG4gICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfwn5C2INCS0YvQsdC10YDQuNGC0LUg0YLQvtCy0LDRgCDQtNC70Y8g0LrQvtC/0LjRgNC+0LLQsNC90LjRjyc7XG4gICAgdGl0bGUuc3R5bGUuZm9udFNpemUgPSAnMTVweCc7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKHRpdGxlKTtcblxuICAgIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgY2xvc2UudGV4dENvbnRlbnQgPSAn4pyVJztcbiAgICBjbG9zZS5zdHlsZS5jc3NUZXh0ID0gJ2JvcmRlcjowO2JvcmRlci1yYWRpdXM6N3B4O3BhZGRpbmc6NnB4IDlweDtiYWNrZ3JvdW5kOiMzMzQxNTU7Y29sb3I6I2UyZThmMDtjdXJzb3I6cG9pbnRlcjsnO1xuICAgIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgY2xvc2VIYXRpa29Qcm9kdWN0UGlja2VyKTtcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQoY2xvc2UpO1xuICAgIG1vZGFsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgICBjb25zdCBncmlkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgZ3JpZC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMTgwcHgsMWZyKSk7Z2FwOjEwcHg7JztcblxuICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGNhcmQudHlwZSA9ICdidXR0b24nO1xuICAgICAgICBjYXJkLnN0eWxlLmNzc1RleHQgPSBgXG4gICAgICAgICAgICBtaW4taGVpZ2h0OjEzMHB4O3BhZGRpbmc6MTJweDt0ZXh0LWFsaWduOmxlZnQ7Y3Vyc29yOnBvaW50ZXI7XG4gICAgICAgICAgICBib3JkZXI6MXB4IHNvbGlkICMzMzQxNTU7Ym9yZGVyLXJhZGl1czoxMnB4O2JhY2tncm91bmQ6IzFlMjkzYjtjb2xvcjojZTJlOGYwO1xuICAgICAgICAgICAgdHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjE1cyxib3JkZXItY29sb3IgLjE1cyxiYWNrZ3JvdW5kIC4xNXM7XG4gICAgICAgIGA7XG4gICAgICAgIGNvbnN0IGNhcmRUaXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0cm9uZycpO1xuICAgICAgICBjYXJkVGl0bGUudGV4dENvbnRlbnQgPSByZXN1bHQudGl0bGU7XG4gICAgICAgIGNhcmRUaXRsZS5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo4cHg7JztcbiAgICAgICAgY2FyZC5hcHBlbmRDaGlsZChjYXJkVGl0bGUpO1xuICAgICAgICBjb25zdCBwcmljZXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gICAgICAgIHByaWNlcy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7Y29sb3I6I2E1YjRmYztmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjU7d2hpdGUtc3BhY2U6cHJlLWxpbmU7JztcbiAgICAgICAgcHJpY2VzLnRleHRDb250ZW50ID0gcmVzdWx0LnByaWNlcy5tYXAoKHByaWNlLCBpKSA9PiBgJHtDSVRZX05BTUVTW2ldfTogJHtwcmljZX1gKS5qb2luKCdcXG4nKTtcbiAgICAgICAgY2FyZC5hcHBlbmRDaGlsZChwcmljZXMpO1xuICAgICAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiB7IGNhcmQuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzgxOGNmOCc7IGNhcmQuc3R5bGUudHJhbnNmb3JtID0gJ3RyYW5zbGF0ZVkoLTJweCknOyB9KTtcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4geyBjYXJkLnN0eWxlLmJvcmRlckNvbG9yID0gJyMzMzQxNTUnOyBjYXJkLnN0eWxlLnRyYW5zZm9ybSA9ICdub25lJzsgfSk7XG4gICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBjb3B5SGF0aWtvVGV4dChyZXN1bHQubWVzc2FnZSk7XG4gICAgICAgICAgICBhZGRUb0NoYXRIaXN0b3J5KCdib3QnLCByZXN1bHQubWVzc2FnZSwgJ/CfkLYgSGF0aWtvJywgcXVlcnkpO1xuICAgICAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnc3lzdGVtJywgJ9Ce0YLQstC10YIg0LLRi9Cx0YDQsNC90L3QvtCz0L4g0YLQvtCy0LDRgNCwINGB0LrQvtC/0LjRgNC+0LLQsNC9JywgJ/Cfk4snKTtcbiAgICAgICAgICAgIGNsb3NlSGF0aWtvUHJvZHVjdFBpY2tlcigpO1xuICAgICAgICAgICAgY29uc3QgcmVvcGVuQnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb1Jlb3BlblBpY2tlckJ1dHRvbicpO1xuICAgICAgICAgICAgaWYgKHJlb3BlbkJ1dHRvbikgcmVvcGVuQnV0dG9uLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3Qgd3JhcHBlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICB3cmFwcGVyLnN0eWxlLmNzc1RleHQgPSAnbWluLXdpZHRoOjA7JztcbiAgICAgICAgd3JhcHBlci5hcHBlbmRDaGlsZChjYXJkKTtcblxuICAgICAgICBjb25zdCBsaW5rcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBsaW5rcy5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbi10b3A6NXB4O2ZvbnQtc2l6ZToxMHB4O2xpbmUtaGVpZ2h0OjEuNTsnO1xuICAgICAgICBCQVNFX1VSTFMuZm9yRWFjaCgoYmFzZVVybCwgaSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgbGluayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTtcbiAgICAgICAgICAgIGxpbmsuaHJlZiA9IGAke2Jhc2VVcmx9JHtyZXN1bHQucGF0aG5hbWV9YDtcbiAgICAgICAgICAgIGxpbmsudGFyZ2V0ID0gJ19ibGFuayc7XG4gICAgICAgICAgICBsaW5rLnJlbCA9ICdub29wZW5lciBub3JlZmVycmVyJztcbiAgICAgICAgICAgIGxpbmsudGV4dENvbnRlbnQgPSBgJHtDSVRZX0lDT05TW2ldfSAke0NJVFlfTkFNRVNbaV19YDtcbiAgICAgICAgICAgIGxpbmsuc3R5bGUuY3NzVGV4dCA9ICdjb2xvcjojOTNjNWZkO21hcmdpbi1yaWdodDo3cHg7JztcbiAgICAgICAgICAgIGxpbmtzLmFwcGVuZENoaWxkKGxpbmspO1xuICAgICAgICB9KTtcbiAgICAgICAgd3JhcHBlci5hcHBlbmRDaGlsZChsaW5rcyk7XG4gICAgICAgIGdyaWQuYXBwZW5kQ2hpbGQod3JhcHBlcik7XG4gICAgfSk7XG5cbiAgICBtb2RhbC5hcHBlbmRDaGlsZChncmlkKTtcbiAgICBvdmVybGF5LmFwcGVuZENoaWxkKG1vZGFsKTtcbiAgICBvdmVybGF5LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZXZlbnQgPT4ge1xuICAgICAgICBpZiAoZXZlbnQudGFyZ2V0ID09PSBvdmVybGF5KSBjbG9zZUhhdGlrb1Byb2R1Y3RQaWNrZXIoKTtcbiAgICB9KTtcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xufVxuXG4vLyDilIDilIDilIAg0KHRgtCw0YLRg9GBLdCx0LDRgCAo0L/QvtC00YHQutCw0LfQutC4INC/0YDQuCDQvdCw0LLQtdC00LXQvdC40LgpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gc2V0U3RhdHVzVGV4dChtZXNzYWdlKSB7XG4gICAgY29uc3QgYmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jU3RhdHVzQmFyJyk7XG4gICAgaWYgKGJhcikgYmFyLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbn1cblxuLy8g4pSA4pSA4pSAINCt0LrRgdC/0L7RgNGCIC8g0LjQvNC/0L7RgNGCINC90LDRgdGC0YDQvtC10Log4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBidWlsZFNldHRpbmdzU25hcHNob3QoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgY2FsY1J1bGVzLFxuICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50cyxcbiAgICAgICAgc2NoZWR1bGVDYWNoZUVuYWJsZWQsXG4gICAgICAgIGNsZWFyVGV4dEVuYWJsZWQsXG4gICAgICAgIGNsZWFyVGltZW91dDogcGFyc2VJbnQoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRTbGlkZXInKT8udmFsdWUgfHwgNTAwLCAxMCksXG4gICAgICAgIHNob3dIYXRpa29MaW5rczogbG9hZFNob3dIYXRpa29MaW5rcygpLFxuICAgICAgICBoYXRpa29TZWFyY2hNb2RlLFxuICAgICAgICByZXRyeUJlaGF2aW9yLFxuICAgICAgICBtc1F1aWNrUGFuZWxFbmFibGVkLFxuICAgICAgICBtc01hZ2ljQ29uZmlnLFxuICAgICAgICBoYWNrZXJPcmRlck5vdGlmaWVyOiBoYWNrZXJOb3RpZmllclNldHRpbmdzLFxuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2s6IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gZXhwb3J0U2V0dGluZ3MoKSB7XG4gICAgY29weUhhdGlrb1RleHQoSlNPTi5zdHJpbmdpZnkoYnVpbGRTZXR0aW5nc1NuYXBzaG90KCksIG51bGwsIDIpKTtcbiAgICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXhwb3J0U2V0dGluZ3NCdG4nKTtcbiAgICBpZiAoYnRuKSB7XG4gICAgICAgIGNvbnN0IHByZXYgPSBidG4udGV4dENvbnRlbnQ7XG4gICAgICAgIGJ0bi50ZXh0Q29udGVudCA9ICfinIUg0KHQutC+0L/QuNGA0L7QstCw0L3Qvic7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBidG4udGV4dENvbnRlbnQgPSBwcmV2OyB9LCAxMjAwKTtcbiAgICB9XG4gICAgc2V0U3RhdHVzVGV4dCgn4pyFINCd0LDRgdGC0YDQvtC50LrQuCDRgdC60L7Qv9C40YDQvtCy0LDQvdGLINCyINCx0YPRhNC10YAnKTtcbn1cblxuZnVuY3Rpb24gaW1wb3J0U2V0dGluZ3MoanNvblRleHQpIHtcbiAgICBsZXQgZGF0YTtcbiAgICB0cnkge1xuICAgICAgICBkYXRhID0gSlNPTi5wYXJzZShqc29uVGV4dCk7XG4gICAgICAgIGlmICghZGF0YSB8fCB0eXBlb2YgZGF0YSAhPT0gJ29iamVjdCcpIHRocm93IG5ldyBFcnJvcignZW1wdHknKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnN0IGFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNJbXBvcnRBcmVhJyk7XG4gICAgICAgIGlmIChhcmVhKSB7IGFyZWEuc3R5bGUuYm9yZGVyQ29sb3IgPSAnI2VmNDQ0NCc7IGFyZWEuc3R5bGUuYm9yZGVyV2lkdGggPSAnMnB4JzsgfVxuICAgICAgICBzZXRTdGF0dXNUZXh0KCfimqDvuI8g0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5IEpTT04g0L3QsNGB0YLRgNC+0LXQuicpO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YS5jYWxjUnVsZXMpICYmIGRhdGEuY2FsY1J1bGVzLmV2ZXJ5KHIgPT4gciAmJiB0eXBlb2Ygci5uYW1lID09PSAnc3RyaW5nJykpIHtcbiAgICAgICAgY2FsY1J1bGVzID0gZGF0YS5jYWxjUnVsZXM7XG4gICAgICAgIHNhdmVDYWxjUnVsZXMoKTtcbiAgICAgICAgYnVpbGRDYWxjUnVsZXNQYW5lbCgpO1xuICAgIH1cbiAgICBpZiAoZGF0YS5zY2hlZHVsZVJlcGxhY2VtZW50cyAmJiB0eXBlb2YgZGF0YS5zY2hlZHVsZVJlcGxhY2VtZW50cyA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkoZGF0YS5zY2hlZHVsZVJlcGxhY2VtZW50cykpIHtcbiAgICAgICAgc2NoZWR1bGVSZXBsYWNlbWVudHMgPSBkYXRhLnNjaGVkdWxlUmVwbGFjZW1lbnRzO1xuICAgICAgICBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKTtcbiAgICAgICAgYnVpbGRTY2hlZHVsZVBhbmVsKCk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZGF0YS5zY2hlZHVsZUNhY2hlRW5hYmxlZCA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHNhdmVTY2hlZHVsZUNhY2hlRW5hYmxlZChkYXRhLnNjaGVkdWxlQ2FjaGVFbmFibGVkKTtcbiAgICAgICAgY29uc3QgY2IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NoZWR1bGVDYWNoZUNoZWNrYm94Jyk7XG4gICAgICAgIGlmIChjYikgY2IuY2hlY2tlZCA9IHNjaGVkdWxlQ2FjaGVFbmFibGVkO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGRhdGEuY2xlYXJUZXh0RW5hYmxlZCA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIGNsZWFyVGV4dEVuYWJsZWQgPSBkYXRhLmNsZWFyVGV4dEVuYWJsZWQ7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2NsZWFyVGV4dEVuYWJsZWQnKSwgU3RyaW5nKGNsZWFyVGV4dEVuYWJsZWQpKTtcbiAgICAgICAgY29uc3QgY2IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJUZXh0Q2hlY2tib3gnKTtcbiAgICAgICAgaWYgKGNiKSBjYi5jaGVja2VkID0gY2xlYXJUZXh0RW5hYmxlZDtcbiAgICAgICAgdXBkYXRlQ2xlYXJUZXh0QnV0dG9uKCk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZGF0YS5jbGVhclRpbWVvdXQgPT09ICdudW1iZXInICYmIGRhdGEuY2xlYXJUaW1lb3V0ID49IDEgJiYgZGF0YS5jbGVhclRpbWVvdXQgPD0gMjAwMCkge1xuICAgICAgICBjb25zdCBzbGlkZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGltZW91dFNsaWRlcicpO1xuICAgICAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0aW1lb3V0VmFsdWUnKTtcbiAgICAgICAgaWYgKHNsaWRlcikgc2xpZGVyLnZhbHVlID0gZGF0YS5jbGVhclRpbWVvdXQ7XG4gICAgICAgIGlmIChsYWJlbCkgbGFiZWwudGV4dENvbnRlbnQgPSBkYXRhLmNsZWFyVGltZW91dDtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBkYXRhLnNob3dIYXRpa29MaW5rcyA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHNhdmVTaG93SGF0aWtvTGlua3MoZGF0YS5zaG93SGF0aWtvTGlua3MpO1xuICAgICAgICBjb25zdCBjYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzaG93SGF0aWtvTGlua3NDaGVja2JveCcpO1xuICAgICAgICBpZiAoY2IpIGNiLmNoZWNrZWQgPSBkYXRhLnNob3dIYXRpa29MaW5rcztcbiAgICAgICAgdXBkYXRlSGF0aWtvTGlua3NQYW5lbChjdXJyZW50SGF0aWtvUGF0aG5hbWUpO1xuICAgIH1cbiAgICBpZiAoWydhdXRvJywgJ3BhbmVsJywgJ2hhdGlrbyddLmluY2x1ZGVzKGRhdGEuaGF0aWtvU2VhcmNoTW9kZSkpIHtcbiAgICAgICAgc2F2ZUhhdGlrb1NlYXJjaE1vZGUoZGF0YS5oYXRpa29TZWFyY2hNb2RlKTtcbiAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb1NlYXJjaE1vZGUnKTtcbiAgICAgICAgaWYgKHNlbCkgc2VsLnZhbHVlID0gZGF0YS5oYXRpa29TZWFyY2hNb2RlO1xuICAgIH1cbiAgICBpZiAoWydhcHBlbmQnLCAncmVwbGFjZSddLmluY2x1ZGVzKGRhdGEucmV0cnlCZWhhdmlvcikpIHtcbiAgICAgICAgc2F2ZVJldHJ5QmVoYXZpb3IoZGF0YS5yZXRyeUJlaGF2aW9yKTtcbiAgICAgICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JldHJ5QmVoYXZpb3InKTtcbiAgICAgICAgaWYgKHNlbCkgc2VsLnZhbHVlID0gZGF0YS5yZXRyeUJlaGF2aW9yO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhLmhpZGRlbkZpZWxkcykpIHtcbiAgICAgICAgLy8g0KHRgtCw0YDRi9C1INC90LDRgdGC0YDQvtC50LrQuCDQstGL0LHQvtGA0L7Rh9C90L7Qs9C+INGB0LrRgNGL0YLQuNGPINCx0L7Qu9GM0YjQtSDQvdC1INC/0YDQuNC80LXQvdGP0Y7RgtGB0Y86INGC0LXQv9C10YDRjFxuICAgICAgICAvLyDQtNC+0L/QvtC70L3QuNGC0LXQu9GM0L3Ri9C1INC/0L7Qu9GPINC+0YLQutGA0YvQstCw0Y7RgtGB0Y8g0LXQtNC40L3Ri9C8INGB0L/QvtC50LvQtdGA0L7QvCDRiNGC0LDRgtC90L7Qs9C+INCx0LvQvtC60LAuXG4gICAgICAgIGhpZGRlbkZpZWxkcyA9IFtdO1xuICAgICAgICBzYXZlSGlkZGVuRmllbGRzKCk7XG4gICAgICAgIHJlc3RvcmVNc0ZpZWxkcygpO1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNNc1JldmVhbEJ0bicpPy5yZW1vdmUoKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBkYXRhLm1zUXVpY2tQYW5lbEVuYWJsZWQgPT09ICdib29sZWFuJykge1xuICAgICAgICBtc1F1aWNrUGFuZWxFbmFibGVkID0gZGF0YS5tc1F1aWNrUGFuZWxFbmFibGVkO1xuICAgICAgICBzYXZlTXNRdWlja1BhbmVsRW5hYmxlZCgpO1xuICAgICAgICBjb25zdCBjYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtc1F1aWNrUGFuZWxDaGVja2JveCcpO1xuICAgICAgICBpZiAoY2IpIGNiLmNoZWNrZWQgPSBtc1F1aWNrUGFuZWxFbmFibGVkO1xuICAgICAgICBidWlsZE1zUXVpY2tQYW5lbCgpO1xuICAgIH1cbiAgICBpZiAoZGF0YS5tc01hZ2ljQ29uZmlnICYmIHR5cGVvZiBkYXRhLm1zTWFnaWNDb25maWcgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzYXZlTXNNYWdpY0NvbmZpZyhkYXRhLm1zTWFnaWNDb25maWcpO1xuICAgICAgICAgICAgY29uc3QgbWFnaWNBcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zTWFnaWNDb25maWdKc29uJyk7XG4gICAgICAgICAgICBpZiAobWFnaWNBcmVhKSBtYWdpY0FyZWEudmFsdWUgPSBKU09OLnN0cmluZ2lmeShtc01hZ2ljQ29uZmlnLCBudWxsLCAyKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIHNldFN0YXR1c1RleHQoYOKaoO+4jyBKU09OIPCfqoQ6ICR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoZGF0YS5oYWNrZXJPcmRlck5vdGlmaWVyICYmIHR5cGVvZiBkYXRhLmhhY2tlck9yZGVyTm90aWZpZXIgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2V0dGluZ3MgPSBoYWNrZXJOb3RpZmllck5vcm1hbGl6ZVNldHRpbmdzKGRhdGEuaGFja2VyT3JkZXJOb3RpZmllcik7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU3RhdHVzU2VsZWN0aW9uSW5pdGlhbGl6ZWQgPSB0cnVlO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNhdmVTZXR0aW5ncygpO1xuICAgICAgICBoYWNrZXJOb3RpZmllckZpbGxDb250cm9scygpO1xuICAgICAgICBoYWNrZXJOb3RpZmllck1heWJlU3RhcnQoKTtcbiAgICB9XG4gICAgaWYgKGRhdGEuaW50ZXJuYWxPcmRlckNoZWNrICYmIHR5cGVvZiBkYXRhLmludGVybmFsT3JkZXJDaGVjayA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MgPSBpbnRlcm5hbE9yZGVyQ2hlY2tOb3JtYWxpemVTZXR0aW5ncyhkYXRhLmludGVybmFsT3JkZXJDaGVjayk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1NhdmVTZXR0aW5ncygpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsT3JnYW5pemF0aW9ucygpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsV2FyZWhvdXNlcygpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsU3RhdHVzZXMoJ2N1c3RvbWVyb3JkZXInKTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbFN0YXR1c2VzKCdpbnRlcm5hbG9yZGVyJyk7XG4gICAgfVxuXG4gICAgY29uc3QgYXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydEFyZWEnKTtcbiAgICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QWN0aW9ucycpO1xuICAgIGlmIChhcmVhKSB7IGFyZWEuc3R5bGUuZGlzcGxheSA9ICdub25lJzsgYXJlYS52YWx1ZSA9ICcnOyBhcmVhLnN0eWxlLmJvcmRlckNvbG9yID0gJyNjYmQ1ZTEnOyBhcmVhLnN0eWxlLmJvcmRlcldpZHRoID0gJzFweCc7IH1cbiAgICBpZiAoYWN0aW9ucykgYWN0aW9ucy5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgIHNldFN0YXR1c1RleHQoJ+KchSDQndCw0YHRgtGA0L7QudC60Lgg0LjQvNC/0L7RgNGC0LjRgNC+0LLQsNC90YsnKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gcmVuZGVySGFja2VySW5saW5lVGFiKCkge1xuICAgIGNvbnN0IGhvc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNTcGVjaWFsUGFuZScpO1xuICAgIGlmICghaG9zdCB8fCBjdXJyZW50QWN0aW9uICE9PSAnaGFja2VyJykgcmV0dXJuO1xuICAgIGhvc3QucmVwbGFjZUNoaWxkcmVuKCk7XG5cbiAgICBjb25zdCB0YWJzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgdGFicy5pZCA9ICdoYWNrZXJUYWJzJztcbiAgICB0YWJzLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2dhcDo0cHg7ZmxleDowIDAgYXV0bzsnO1xuICAgIFtbJ3N0YXR1cycsICfQodGC0LDRgtGD0YEnXSwgWydhZ2VudCcsICfQmtC+0L3RgtGA0LDQs9C10L3RgiddLCBbJ25vdGlmaWVyJywgJ9Cd0L7QstGL0LUg0LfQsNC60LDQt9GLJ10sIFsnaW50ZXJuYWxPcmRlckNoZWNrJywgJ9Cf0YDQvtCy0LXRgNC60LAg0LfQsNC60LDQt9C+0LInXV0uZm9yRWFjaCgoW2tleSwgbGFiZWxdKSA9PiB7XG4gICAgICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBidG4udHlwZSA9ICdidXR0b24nO1xuICAgICAgICBidG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgYnRuLmRhdGFzZXQuaGFja2VyVGFiID0ga2V5O1xuICAgICAgICBidG4uc3R5bGUuY3NzVGV4dCA9ICdmbGV4OjE7cGFkZGluZzo1cHggNHB4O2JvcmRlcjoxcHggc29saWQgI2UyZThmMDtib3JkZXItcmFkaXVzOjhweDsnXG4gICAgICAgICAgICArICdiYWNrZ3JvdW5kOiNmOGZhZmM7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7d2hpdGUtc3BhY2U6bm93cmFwOyc7XG4gICAgICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGhhY2tlclNlbGVjdFRhYihrZXkpKTtcbiAgICAgICAgdGFicy5hcHBlbmRDaGlsZChidG4pO1xuICAgIH0pO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQodGFicyk7XG5cbiAgICBjb25zdCBwYW5lcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHBhbmVzLmlkID0gJ2hhY2tlclRhYlBhbmVzJztcbiAgICBwYW5lcy5zdHlsZS5jc3NUZXh0ID0gJ2ZsZXg6MCAwIGF1dG87JztcbiAgICBob3N0LmFwcGVuZENoaWxkKHBhbmVzKTtcblxuICAgIGNvbnN0IGxvZ0xhYmVsID0gaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTBweDtmb250LXdlaWdodDo4MDA7Y29sb3I6IzY0NzQ4Yjt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7J1xuICAgICAgICArICdsZXR0ZXItc3BhY2luZzouOHB4O21hcmdpbi10b3A6NHB4OycsICfQmtC+0L3RgdC+0LvRjCcpO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQobG9nTGFiZWwpO1xuICAgIGNvbnN0IGxvZ0JveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGxvZ0JveC5pZCA9ICdoYWNrZXJMb2dCb3gnO1xuICAgIGxvZ0JveC5zdHlsZS5jc3NUZXh0ID0gJ2ZsZXg6MSAxIGF1dG87bWluLWhlaWdodDo5MHB4O292ZXJmbG93LXk6YXV0bztiYWNrZ3JvdW5kOiMwZjE3MmE7Ym9yZGVyLXJhZGl1czoxMHB4OydcbiAgICAgICAgKyAncGFkZGluZzo3cHg7Zm9udC1zaXplOjEwLjVweDtsaW5lLWhlaWdodDoxLjU7Zm9udC1mYW1pbHk6Q29uc29sYXMsbW9ub3NwYWNlOyc7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChsb2dCb3gpO1xuXG4gICAgaGFja2VyU2VsZWN0VGFiKGhhY2tlclRhYik7XG4gICAgaGFja2VyUmVuZGVyTG9nKCk7XG4gICAgaGFja2VyRW5zdXJlU3RhdGVzKHRydWUpO1xuICAgIGlmICgvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSBoYWNrZXJMb2FkT3Blbk9yZGVyKHRydWUpO1xufVxuXG4vLyDilIDilIDilIAg0J7QutC90L4gwqvQpdCw0YLQuNC60L7QpdCw0LrQtdGAwrsgKNGB0YLQsNGA0YvQuSDRgdC+0LLQvNC10YHRgtC40LzRi9C5INGB0L/QvtGB0L7QsSDQvtGC0LrRgNGL0YLQuNGPKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIG9wZW5IYWNrZXJXaW5kb3coKSB7XG4gICAgY2xvc2VNZW1jaGF0T3ZlcmxheSgpO1xuXG4gICAgY29uc3Qgd2luID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgd2luLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC13aW5kb3cnO1xuICAgIGFwcGx5RmxvYXRXaW5kb3dQb3Mod2luKTtcblxuICAgIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWRlci5jbGFzc05hbWUgPSAnbWMtZmxvYXQtaGVhZGVyJztcbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRpdGxlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC10aXRsZSc7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSAn8J+QsfCfkajigI3wn5K7INCl0LDRgtC40LrQvtCl0LDQutC10YAnO1xuICAgIGhlYWRlci5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gICAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBjbG9zZS50eXBlID0gJ2J1dHRvbic7XG4gICAgY2xvc2UuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWNsb3NlJztcbiAgICBjbG9zZS50ZXh0Q29udGVudCA9ICfinJUnO1xuICAgIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgY2xvc2VNZW1jaGF0T3ZlcmxheSk7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKGNsb3NlKTtcbiAgICB3aW4uYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBib2R5LmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1ib2R5JztcblxuICAgIGNvbnN0IHRhYnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB0YWJzLmlkID0gJ2hhY2tlclRhYnMnO1xuICAgIHRhYnMuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjRweDttYXJnaW4tYm90dG9tOjhweDsnO1xuICAgIGNvbnN0IEhBQ0tFUl9UQUJTID0gW1xuICAgICAgICBbJ3N0YXR1cycsICfQodGC0LDRgtGD0YEnXSxcbiAgICAgICAgWydhZ2VudCcsICfQmtC+0L3RgtGA0LDQs9C10L3RgiddLFxuICAgICAgICBbJ25vdGlmaWVyJywgJ9Cd0L7QstGL0LUg0LfQsNC60LDQt9GLJ10sXG4gICAgICAgIFsnaW50ZXJuYWxPcmRlckNoZWNrJywgJ9Cf0YDQvtCy0LXRgNC60LAg0LfQsNC60LDQt9C+0LInXVxuICAgIF07XG4gICAgSEFDS0VSX1RBQlMuZm9yRWFjaCgoW2tleSwgbGFiZWxdLCBpKSA9PiB7XG4gICAgICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBidG4udHlwZSA9ICdidXR0b24nO1xuICAgICAgICBidG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgICAgYnRuLmRhdGFzZXQuaGFja2VyVGFiID0ga2V5O1xuICAgICAgICBidG4uc3R5bGUuY3NzVGV4dCA9ICdmbGV4OjE7cGFkZGluZzo1cHggNHB4O2JvcmRlcjoxcHggc29saWQgI2UyZThmMDtib3JkZXItcmFkaXVzOjhweDsnXG4gICAgICAgICAgICArICdiYWNrZ3JvdW5kOiNmOGZhZmM7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7J1xuICAgICAgICAgICAgKyAndHJhbnNpdGlvbjphbGwgLjE1czt3aGl0ZS1zcGFjZTpub3dyYXA7JztcbiAgICAgICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gaGFja2VyU2VsZWN0VGFiKGtleSkpO1xuICAgICAgICB0YWJzLmFwcGVuZENoaWxkKGJ0bik7XG4gICAgfSk7XG4gICAgYm9keS5hcHBlbmRDaGlsZCh0YWJzKTtcblxuICAgIGNvbnN0IHBhbmVzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgcGFuZXMuaWQgPSAnaGFja2VyVGFiUGFuZXMnO1xuICAgIGJvZHkuYXBwZW5kQ2hpbGQocGFuZXMpO1xuXG4gICAgLy8g0JrQvtC90YHQvtC70Ywg0LLQvdC40LfRg1xuICAgIGNvbnN0IGxvZ0xhYmVsID0gaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTBweDtmb250LXdlaWdodDo4MDA7Y29sb3I6IzY0NzQ4Yjt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7J1xuICAgICAgICArICdsZXR0ZXItc3BhY2luZzouOHB4O21hcmdpbjoxMHB4IDAgNHB4OycsICfQmtC+0L3RgdC+0LvRjCcpO1xuICAgIGJvZHkuYXBwZW5kQ2hpbGQobG9nTGFiZWwpO1xuICAgIGNvbnN0IGxvZ0JveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGxvZ0JveC5pZCA9ICdoYWNrZXJMb2dCb3gnO1xuICAgIGxvZ0JveC5zdHlsZS5jc3NUZXh0ID0gJ2hlaWdodDoxMjBweDtvdmVyZmxvdy15OmF1dG87YmFja2dyb3VuZDojMGYxNzJhO2JvcmRlci1yYWRpdXM6MTBweDsnXG4gICAgICAgICsgJ3BhZGRpbmc6N3B4O2ZvbnQtc2l6ZToxMC41cHg7bGluZS1oZWlnaHQ6MS41O2ZvbnQtZmFtaWx5OkNvbnNvbGFzLG1vbm9zcGFjZTsnO1xuICAgIGJvZHkuYXBwZW5kQ2hpbGQobG9nQm94KTtcblxuICAgIHdpbi5hcHBlbmRDaGlsZChib2R5KTtcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHdpbik7XG4gICAgbWFrZU1vdmFibGUod2luLCBoZWFkZXIpO1xuXG4gICAgaGFja2VyU2VsZWN0VGFiKGhhY2tlclRhYik7XG4gICAgaGFja2VyUmVuZGVyTG9nKCk7XG4gICAgaGFja2VyRW5zdXJlU3RhdGVzKHRydWUpO1xuICAgIGlmICgvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSBoYWNrZXJMb2FkT3Blbk9yZGVyKHRydWUpO1xufVxuXG4vLyDQn9C10YDQtdC60LvRjtGH0LXQvdC40LUg0LLQutC70LDQtNC+0Log0KXQsNC60LXRgNCwICjQv9Cw0L3QtdC70Lgg0YHRgtGA0L7Rj9GC0YHRjyDQsiAxMS1oYWNrZXIuanMpXG5mdW5jdGlvbiBoYWNrZXJTZWxlY3RUYWIoa2V5KSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5kaWFnbm9zdGljcz8uc2VsZWN0KGtleSkpIHJldHVybjtcbiAgICAvLyBPbGQgY2FsbGVycyBtYXkgc3RpbGwgcmVxdWVzdCB0aGUgcmVtb3ZlZCBzYWxlIHRhYjsgbmV2ZXIgcnVuIGl0cyBmbG93LlxuICAgIGlmICghWydzdGF0dXMnLCAnYWdlbnQnLCAnbm90aWZpZXInLCAnaW50ZXJuYWxPcmRlckNoZWNrJ10uaW5jbHVkZXMoa2V5KSkga2V5ID0gJ3N0YXR1cyc7XG4gICAgaGFja2VyVGFiID0ga2V5O1xuICAgIGNvbnN0IHRhYnNFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJUYWJzJyk7XG4gICAgaWYgKHRhYnNFbCkge1xuICAgICAgICB0YWJzRWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtaGFja2VyLXRhYl0nKS5mb3JFYWNoKHQgPT4ge1xuICAgICAgICAgICAgY29uc3QgYWN0aXZlID0gdC5kYXRhc2V0LmhhY2tlclRhYiA9PT0ga2V5O1xuICAgICAgICAgICAgdC5zdHlsZS5iYWNrZ3JvdW5kID0gYWN0aXZlID8gJ2xpbmVhci1ncmFkaWVudCgxMzVkZWcsIzYzNjZmMSwjOGI1Y2Y2KScgOiAnI2Y4ZmFmYyc7XG4gICAgICAgICAgICB0LnN0eWxlLmNvbG9yID0gYWN0aXZlID8gJyNmZmYnIDogJyM0NzU1NjknO1xuICAgICAgICAgICAgdC5zdHlsZS5ib3JkZXJDb2xvciA9IGFjdGl2ZSA/ICd0cmFuc3BhcmVudCcgOiAnI2UyZThmMCc7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCBwYW5lcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJUYWJQYW5lcycpO1xuICAgIGlmICghcGFuZXMpIHJldHVybjtcbiAgICBwYW5lcy5pbm5lckhUTUwgPSAnJztcbiAgICBsZXQgcGFuZSA9IG51bGw7XG4gICAgaWYgKGtleSA9PT0gJ3N0YXR1cycpIHBhbmUgPSBoYWNrZXJCdWlsZFN0YXR1c1RhYigpO1xuICAgIGVsc2UgaWYgKGtleSA9PT0gJ2FnZW50JykgcGFuZSA9IGhhY2tlckJ1aWxkQWdlbnRUYWIoKTtcbiAgICBlbHNlIGlmIChrZXkgPT09ICdub3RpZmllcicpIHBhbmUgPSBoYWNrZXJCdWlsZE5vdGlmaWVyVGFiKCk7XG4gICAgZWxzZSBpZiAoa2V5ID09PSAnaW50ZXJuYWxPcmRlckNoZWNrJykgcGFuZSA9IGhhY2tlckJ1aWxkSW50ZXJuYWxPcmRlckNoZWNrVGFiKCk7XG4gICAgaWYgKHBhbmUpIHBhbmVzLmFwcGVuZENoaWxkKHBhbmUpO1xuXG4gICAgLy8g0KHQv9GA0LDQstC+0YfQvdC40LrQuCDQt9Cw0LPRgNGD0LbQsNGO0YLRgdGPINC/0YDQuCDQvtGC0LrRgNGL0YLQuNC4INGB0L7QvtGC0LLQtdGC0YHRgtCy0YPRjtGJ0LXQuSDQstC60LvQsNC00LrQuC5cbiAgICBpZiAoa2V5ID09PSAnc3RhdHVzJykgaGFja2VyRW5zdXJlU3RhdGVzKHRydWUpO1xufVxuXG4vLyDilIDilIDilIAg0J7QutC90L4gwqvQndCw0YHRgtGA0L7QudC60LjCuyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCe0YLQtNC10LvRjNC90L7QtSDQv9C70LDQstCw0Y7RidC10LUg0L/QtdGA0LXRgtCw0YHQutC40LLQsNC10LzQvtC1INC+0LrQvdC+ICjQv9C+0LfQuNGG0LjRjyDRgdC+0YXRgNCw0L3Rj9C10YLRgdGPKS5cbmZ1bmN0aW9uIG9wZW5TZXR0aW5nc1dpbmRvdyhpbml0aWFsVGFiID0gJ2dlbmVyYWwnKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5kaWFnbm9zdGljcykge1xuICAgICAgICBpZiAoaW5pdGlhbFRhYiA9PT0gJ2ludGVybmFsT3JkZXJDaGVjaycpIGluaXRpYWxUYWIgPSAnZ2VuZXJhbCc7XG5cbiAgICB9XG4gICAgY2xvc2VNZW1jaGF0T3ZlcmxheSgpO1xuXG4gICAgY29uc3Qgd2luID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgd2luLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC13aW5kb3cnO1xuICAgIGFwcGx5RmxvYXRXaW5kb3dQb3Mod2luKTtcblxuICAgIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWRlci5jbGFzc05hbWUgPSAnbWMtZmxvYXQtaGVhZGVyJztcbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRpdGxlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC10aXRsZSc7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSAn4pqZ77iPINCd0LDRgdGC0YDQvtC50LrQuCc7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGNsb3NlLnR5cGUgPSAnYnV0dG9uJztcbiAgICBjbG9zZS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtY2xvc2UnO1xuICAgIGNsb3NlLnRleHRDb250ZW50ID0gJ+KclSc7XG4gICAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBjbG9zZU1lbWNoYXRPdmVybGF5KTtcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQoY2xvc2UpO1xuICAgIHdpbi5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGJvZHkuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWJvZHknO1xuICAgIGJvZHkuaW5uZXJIVE1MID0gYFxuICAgICAgICA8ZGl2IGNsYXNzPVwibWMtc2VjdGlvbi1sYWJlbFwiPtCe0YfQuNGB0YLQutCwINGC0LXQutGB0YLQsDwvZGl2PlxuICAgICAgICA8bGFiZWwgc3R5bGU9XCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDttYXJnaW4tYm90dG9tOjEwcHg7Y3Vyc29yOnBvaW50ZXI7XCI+XG4gICAgICAgICAgICA8aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgaWQ9XCJjbGVhclRleHRDaGVja2JveFwiIHN0eWxlPVwiYWNjZW50LWNvbG9yOiM2MzY2ZjE7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtcIj5cbiAgICAgICAgICAgINCT0LvQvtCx0LDQu9GM0L3QsNGPINC+0YfQuNGB0YLQutCwINGC0LXQutGB0YLQsCDQv9C+0YHQu9C1IEVudGVyXG4gICAgICAgIDwvbGFiZWw+XG4gICAgICAgIDxsYWJlbCBzdHlsZT1cImRpc3BsYXk6YmxvY2s7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDtcIj5cbiAgICAgICAgICAgINCX0LDQtNC10YDQttC60LA6IDxzcGFuIGlkPVwidGltZW91dFZhbHVlXCIgc3R5bGU9XCJjb2xvcjojNjM2NmYxO2ZvbnQtd2VpZ2h0OjcwMDtcIj41MDA8L3NwYW4+INC80YFcbiAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwicmFuZ2VcIiBpZD1cInRpbWVvdXRTbGlkZXJcIiBtaW49XCIxXCIgbWF4PVwiMjAwMFwiIHZhbHVlPVwiNTAwXCJcbiAgICAgICAgICAgICAgICBzdHlsZT1cIndpZHRoOjEwMCU7bWFyZ2luLXRvcDo1cHg7YWNjZW50LWNvbG9yOiM2MzY2ZjE7ZGlzcGxheTpibG9jaztcIj5cbiAgICAgICAgPC9sYWJlbD5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjEycHg7bWFyZ2luLXRvcDoxMHB4O2N1cnNvcjpwb2ludGVyO1wiPlxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGlkPVwic2hvd0hhdGlrb0xpbmtzQ2hlY2tib3hcIiBzdHlsZT1cImFjY2VudC1jb2xvcjojNjM2NmYxO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7XCI+XG4gICAgICAgICAgICDQn9C+0LrQsNC30YvQstCw0YLRjCDRgdGB0YvQu9C60LggSGF0aWtvXG4gICAgICAgIDwvbGFiZWw+XG4gICAgICAgIDxsYWJlbCBzdHlsZT1cImRpc3BsYXk6YmxvY2s7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjEwcHg7XCI+XG4gICAgICAgICAgICDQn9C+0LjRgdC6INGG0LjRhNGA0L7QstGL0YUg0LfQsNC/0YDQvtGB0L7QsjpcbiAgICAgICAgICAgIDxzZWxlY3QgaWQ9XCJoYXRpa29TZWFyY2hNb2RlXCIgc3R5bGU9XCJkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7bWFyZ2luLXRvcDo1cHg7cGFkZGluZzo1cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjZweDtjb2xvcjojMzM0MTU1O1wiPlxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJhdXRvXCI+0KHQvdCw0YfQsNC70LAgUGFuZWwsINC30LDRgtC10Lwg0YHQsNC50YI8L29wdGlvbj5cbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwicGFuZWxcIj7QotC+0LvRjNC60L4gUGFuZWw8L29wdGlvbj5cbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiaGF0aWtvXCI+0KLQvtC70YzQutC+INGB0LDQudGCIEhhdGlrbzwvb3B0aW9uPlxuICAgICAgICAgICAgPC9zZWxlY3Q+XG4gICAgICAgIDwvbGFiZWw+XG4gICAgICAgIDxsYWJlbCBzdHlsZT1cImRpc3BsYXk6YmxvY2s7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjEwcHg7XCI+XG4gICAgICAgICAgICDQn9C+0LLQtdC00LXQvdC40LUg0LrQvdC+0L/QutC4IPCflIE6XG4gICAgICAgICAgICA8c2VsZWN0IGlkPVwicmV0cnlCZWhhdmlvclwiIHN0eWxlPVwiZGlzcGxheTpibG9jazt3aWR0aDoxMDAlO21hcmdpbi10b3A6NXB4O3BhZGRpbmc6NXB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo2cHg7Y29sb3I6IzMzNDE1NTtcIj5cbiAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiYXBwZW5kXCI+0J3QtSDRg9C00LDQu9GP0YLRjCDRgdGC0LDRgNGL0Lkg0L7RgtCy0LXRgjwvb3B0aW9uPlxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJyZXBsYWNlXCI+0KPQtNCw0LvRj9GC0Ywg0YHRgtCw0YDRi9C5INC+0YLQstC10YIg0Lgg0L/QvtCy0YLQvtGA0Y/RgtGMPC9vcHRpb24+XG4gICAgICAgICAgICA8L3NlbGVjdD5cbiAgICAgICAgPC9sYWJlbD5cblxuICAgICAgICA8ZGl2IHN0eWxlPVwiaGVpZ2h0OjhweDtcIj48L2Rpdj5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbToxMHB4O2N1cnNvcjpwb2ludGVyO1wiPlxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGlkPVwic2NoZWR1bGVDYWNoZUNoZWNrYm94XCIgc3R5bGU9XCJhY2NlbnQtY29sb3I6IzYzNjZmMTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O1wiPlxuICAgICAgICAgICAg0JrQtdGI0LjRgNC+0LLQsNGC0Ywg0YDQsNGB0L/QuNGB0LDQvdC40LUg0L3QsCAxMiDRh9Cw0YHQvtCyXG4gICAgICAgIDwvbGFiZWw+XG5cbiAgICAgICAgPGRpdiBpZD1cIm1jU2V0dGluZ3NSdWxlc1BhbmVcIiBzdHlsZT1cImRpc3BsYXk6bm9uZTtcIj5cbiAgICAgICAgPGJ1dHRvbiBpZD1cImNhbGNTZXR0aW5nc0J0blwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1zbGF0ZVwiIHN0eWxlPVwid2lkdGg6MTAwJTtcIj7impnvuI8g0J/RgNCw0LLQuNC70LAg8J+nrjwvYnV0dG9uPlxuICAgICAgICA8ZGl2IGlkPVwiY2FsY1NldHRpbmdzUGFuZWxcIiBjbGFzcz1cIm1jLXBhbmVsXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmU7bWF4LWhlaWdodDpub25lO1wiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cIm1jLXBhbmVsLXRpdGxlXCI+4pqZ77iPINCf0YDQsNCy0LjQu9CwINC60LDQu9GM0LrRg9C70Y/RgtC+0YDQsFxuICAgICAgICAgICAgICAgIDxzcGFuIHN0eWxlPVwiZm9udC13ZWlnaHQ6NDAwO2NvbG9yOiMzMzQxNTU7dGV4dC10cmFuc2Zvcm06bm9uZTtsZXR0ZXItc3BhY2luZzowO21hcmdpbi1sZWZ0OjZweDtcIj5cbiAgICAgICAgICAgICAgICAgICAgcm91bmQo0YHRg9C80LzQsCDDlyAlIMO3IDEwMCDDtyDQvtC60YDRg9Cz0LsuKSDDlyDQvtC60YDRg9Cz0LsuICsg0LTQvtC/LlxuICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBpZD1cImNhbGNSdWxlc1BhbmVsXCI+PC9kaXY+XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgc3R5bGU9XCJoZWlnaHQ6OHB4O1wiPjwvZGl2PlxuICAgICAgICA8YnV0dG9uIGlkPVwic2NoZWR1bGVTZXR0aW5nc0J0blwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1zbGF0ZVwiIHN0eWxlPVwid2lkdGg6MTAwJTtcIj7impnvuI8g0JfQsNC80LXQvdGLIPCfk4U8L2J1dHRvbj5cbiAgICAgICAgPGRpdiBpZD1cInNjaGVkdWxlU2V0dGluZ3NQYW5lbFwiIGNsYXNzPVwibWMtcGFuZWxcIiBzdHlsZT1cImRpc3BsYXk6bm9uZTttYXgtaGVpZ2h0Om5vbmU7XCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwibWMtcGFuZWwtdGl0bGVcIj7impnvuI8g0JfQsNC80LXQvdGLINC00LvRjyDRgNCw0YHQv9C40YHQsNC90LjRjzwvZGl2PlxuICAgICAgICAgICAgPGRpdiBpZD1cInNjaGVkdWxlUnVsZXNQYW5lbFwiPjwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgPGRpdiBzdHlsZT1cImhlaWdodDo4cHg7XCI+PC9kaXY+XG4gICAgICAgIDxsYWJlbCBzdHlsZT1cImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMnB4O21hcmdpbi1ib3R0b206MTBweDtjdXJzb3I6cG9pbnRlcjtcIj5cbiAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBpZD1cIm1zUXVpY2tQYW5lbENoZWNrYm94XCIgc3R5bGU9XCJhY2NlbnQtY29sb3I6IzYzNjZmMTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O1wiPlxuICAgICAgICAgICAg0J/QsNC90LXQu9GMINCx0YvRgdGC0YDRi9GFINC60L3QvtC/0L7QuiAo0JzQvtC50KHQutC70LDQtClcbiAgICAgICAgPC9sYWJlbD5cblxuICAgICAgICA8ZGl2IHN0eWxlPVwiaGVpZ2h0OjhweDtcIj48L2Rpdj5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbToxMHB4O2N1cnNvcjpwb2ludGVyO1wiPlxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGlkPVwibXNCZWFyZXJDaGVja2JveFwiIHN0eWxlPVwiYWNjZW50LWNvbG9yOiM2MzY2ZjE7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtcIj5cbiAgICAgICAgICAgIEJlYXJlci3QutC70Y7RhyBBUEkg0JzQvtC50KHQutC70LDQtFxuICAgICAgICA8L2xhYmVsPlxuICAgICAgICA8aW5wdXQgdHlwZT1cInRleHRcIiBpZD1cIm1zQmVhcmVyVG9rZW5cIiBwbGFjZWhvbGRlcj1cIkFQSS3QutC70Y7RhyDQnNC+0LnQodC60LvQsNC0IChCZWFyZXIp4oCmXCIgc3BlbGxjaGVjaz1cImZhbHNlXCJcbiAgICAgICAgICAgIHN0eWxlPVwiZGlzcGxheTpub25lO3dpZHRoOjEwMCU7cGFkZGluZzo1cHggN3B4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDtvdXRsaW5lOm5vbmU7Ym94LXNpemluZzpib3JkZXItYm94O21hcmdpbi1ib3R0b206MTBweDtcIj5cblxuICAgICAgICA8YnV0dG9uIGlkPVwibXNNYWdpY1NldHRpbmdzQnRuXCIgY2xhc3M9XCJtYy1idG4gbWMtYnRuLXNsYXRlXCIgc3R5bGU9XCJ3aWR0aDoxMDAlO1wiPvCfqoQg0JDQstGC0L7Qt9Cw0L/QvtC70L3QtdC90LjQtSDQtNC+0LrRg9C80LXQvdGC0L7QsiAoSlNPTik8L2J1dHRvbj5cbiAgICAgICAgPGRpdiBpZD1cIm1zTWFnaWNTZXR0aW5nc1BhbmVsXCIgY2xhc3M9XCJtYy1wYW5lbFwiIHN0eWxlPVwiZGlzcGxheTpub25lO21heC1oZWlnaHQ6bm9uZTtcIj5cbiAgICAgICAgICAgIDxkaXYgc3R5bGU9XCJmb250LXNpemU6MTAuNXB4O2NvbG9yOiM2NDc0OGI7bWFyZ2luLWJvdHRvbTo2cHg7bGluZS1oZWlnaHQ6MS40O1wiPlxuICAgICAgICAgICAgICAgIGRlbWFuZCDigJQg0J7RgtCz0YDRg9C30LrQsCwgY2FzaGluIOKAlCDQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCwgcGF5bWVudGluIOKAlCDQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0ZHQti48YnI+XG4gICAgICAgICAgICAgICAgY29waWVzINC60L7Qv9C40YDRg9C10YIg0LfQvdCw0YfQtdC90LjQtSDQvNC10LbQtNGDINC+0LTQuNC90LDQutC+0LLRi9C80Lgg0L/QvtC70Y/QvNC4OyB2YWx1ZXMg0LfQsNC00LDRkdGCINGC0L7Rh9C90L7QtSDQt9C90LDRh9C10L3QuNC1INC40Lcg0YHQv9C40YHQutCwINCc0L7QudCh0LrQu9Cw0LQuXG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDx0ZXh0YXJlYSBpZD1cIm1zTWFnaWNDb25maWdKc29uXCIgc3BlbGxjaGVjaz1cImZhbHNlXCIgc3R5bGU9XCJ3aWR0aDoxMDAlO2hlaWdodDoyMTBweDtwYWRkaW5nOjdweDtib3gtc2l6aW5nOmJvcmRlci1ib3g7cmVzaXplOnZlcnRpY2FsO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzMzNDE1NTtmb250OjEwcHggQ29uc29sYXMsbW9ub3NwYWNlO1wiPjwvdGV4dGFyZWE+XG4gICAgICAgICAgICA8YnV0dG9uIGlkPVwibXNNYWdpY0NvbmZpZ1NhdmVcIiBjbGFzcz1cIm1jLWJ0biBtYy1idG4tZ3JlZW5cIiBzdHlsZT1cIndpZHRoOjEwMCU7bWFyZ2luLXRvcDo2cHg7XCI+0KHQvtGF0YDQsNC90LjRgtGMIEpTT048L2J1dHRvbj5cbiAgICAgICAgICAgIDxkaXYgaWQ9XCJtc01hZ2ljQ29uZmlnU3RhdHVzXCIgc3R5bGU9XCJtaW4taGVpZ2h0OjE2cHg7bWFyZ2luLXRvcDo1cHg7Zm9udC1zaXplOjEwLjVweDtjb2xvcjojNjQ3NDhiO1wiPjwvZGl2PlxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICA8ZGl2IHN0eWxlPVwiaGVpZ2h0OjhweDtcIj48L2Rpdj5cbiAgICAgICAgPGJ1dHRvbiBpZD1cInJlc2V0RmxvYXRQb3NCdG5cIiBjbGFzcz1cIm1jLWJ0biBtYy1idG4tb3JhbmdlXCIgc3R5bGU9XCJ3aWR0aDoxMDAlO1wiIGRhdGEtdGlwPVwi4oa6INCS0LXRgNC90YPRgtGMINC+0LrQvdCwINCyINC/0L7Qt9C40YbQuNGOINC/0L4g0YPQvNC+0LvRh9Cw0L3QuNGOXCI+4oa6INCh0LHRgNC+0YHQuNGC0Ywg0L/QvtC70L7QttC10L3QuNC1INC+0LrQvtC9PC9idXR0b24+XG5cbiAgICAgICAgPGRpdiBzdHlsZT1cImhlaWdodDo4cHg7XCI+PC9kaXY+XG4gICAgICAgIDxkaXYgc3R5bGU9XCJkaXNwbGF5OmZsZXg7Z2FwOjZweDtcIj5cbiAgICAgICAgICAgIDxidXR0b24gaWQ9XCJleHBvcnRTZXR0aW5nc0J0blwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1zbGF0ZVwiIHN0eWxlPVwiZmxleDoxO1wiIGRhdGEtdGlwPVwi8J+TiyDQodC60L7Qv9C40YDQvtCy0LDRgtGMINCy0YHQtSDQvdCw0YHRgtGA0L7QudC60Lgg0LIg0LHRg9GE0LXRgFwiPvCfk6Qg0K3QutGB0L/QvtGA0YI8L2J1dHRvbj5cbiAgICAgICAgICAgIDxidXR0b24gaWQ9XCJpbXBvcnRTZXR0aW5nc0J0blwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1zbGF0ZVwiIHN0eWxlPVwiZmxleDoxO1wiIGRhdGEtdGlwPVwi8J+TpSDQktGB0YLQsNCy0LjRgtGMINC90LDRgdGC0YDQvtC50LrQuCDQuNC3INCx0YPRhNC10YDQsFwiPvCfk6Ug0JjQvNC/0L7RgNGCPC9idXR0b24+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8dGV4dGFyZWEgaWQ9XCJtY0ltcG9ydEFyZWFcIiBzcGVsbGNoZWNrPVwiZmFsc2VcIiBwbGFjZWhvbGRlcj0n0JLRgdGC0LDQstGM0YLQtSDRgdGO0LTQsCBKU09OINC90LDRgdGC0YDQvtC10LrigKYnIHN0eWxlPVwiZGlzcGxheTpub25lO3dpZHRoOjEwMCU7aGVpZ2h0OjExMHB4O21hcmdpbi10b3A6NnB4O3BhZGRpbmc6N3B4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo4cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTAuNXB4O2ZvbnQtZmFtaWx5Om1vbm9zcGFjZTtib3gtc2l6aW5nOmJvcmRlci1ib3g7cmVzaXplOnZlcnRpY2FsO291dGxpbmU6bm9uZTtcIj48L3RleHRhcmVhPlxuICAgICAgICA8ZGl2IGlkPVwibWNJbXBvcnRBY3Rpb25zXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmU7Z2FwOjZweDttYXJnaW4tdG9wOjZweDtcIj5cbiAgICAgICAgICAgIDxidXR0b24gaWQ9XCJtY0ltcG9ydEFwcGx5XCIgY2xhc3M9XCJtYy1idG4gbWMtYnRuLWdyZWVuXCIgc3R5bGU9XCJmbGV4OjE7XCI+0J/RgNC40LzQtdC90LjRgtGMPC9idXR0b24+XG4gICAgICAgICAgICA8YnV0dG9uIGlkPVwibWNJbXBvcnRDYW5jZWxcIiBjbGFzcz1cIm1jLWJ0biBtYy1idG4tc2xhdGVcIiBzdHlsZT1cImZsZXg6MTtcIj7QntGC0LzQtdC90LA8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgYDtcblxuICAgIGNvbnN0IGdlbmVyYWxQYW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgZ2VuZXJhbFBhbmUuaWQgPSAnbWNTZXR0aW5nc0dlbmVyYWxQYW5lJztcbiAgICB3aGlsZSAoYm9keS5maXJzdENoaWxkKSBnZW5lcmFsUGFuZS5hcHBlbmRDaGlsZChib2R5LmZpcnN0Q2hpbGQpO1xuICAgIGNvbnN0IHJ1bGVzUGFuZSA9IGdlbmVyYWxQYW5lLnF1ZXJ5U2VsZWN0b3IoJyNtY1NldHRpbmdzUnVsZXNQYW5lJyk7XG4gICAgcnVsZXNQYW5lLnJlbW92ZSgpO1xuXG4gICAgY29uc3Qgc2V0dGluZ3NUYWJzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgc2V0dGluZ3NUYWJzLmlkID0gJ21jU2V0dGluZ3NUYWJzJztcbiAgICBzZXR0aW5nc1RhYnMuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjRweDttYXJnaW4tYm90dG9tOjlweDsnO1xuICAgIGNvbnN0IHNldHRpbmdzR2VuZXJhbFRhYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIHNldHRpbmdzR2VuZXJhbFRhYi5pZCA9ICdtY1NldHRpbmdzVGFiR2VuZXJhbCc7XG4gICAgc2V0dGluZ3NHZW5lcmFsVGFiLnR5cGUgPSAnYnV0dG9uJztcbiAgICBzZXR0aW5nc0dlbmVyYWxUYWIudGV4dENvbnRlbnQgPSAn4pqZ77iPINCe0LHRidC40LUnO1xuICAgIGNvbnN0IHNldHRpbmdzUnVsZXNUYWIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBzZXR0aW5nc1J1bGVzVGFiLmlkID0gJ21jU2V0dGluZ3NUYWJSdWxlcyc7XG4gICAgc2V0dGluZ3NSdWxlc1RhYi50eXBlID0gJ2J1dHRvbic7XG4gICAgc2V0dGluZ3NSdWxlc1RhYi50ZXh0Q29udGVudCA9ICfwn5OdINCf0YDQsNCy0LjQu9CwINC4INC30LDQvNC10L3Riyc7XG4gICAgY29uc3Qgc2V0dGluZ3NPcmRlclRhYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIHNldHRpbmdzT3JkZXJUYWIuaWQgPSAnbWNTZXR0aW5nc1RhYkludGVybmFsT3JkZXJDaGVjayc7XG4gICAgc2V0dGluZ3NPcmRlclRhYi50eXBlID0gJ2J1dHRvbic7XG4gICAgc2V0dGluZ3NPcmRlclRhYi50ZXh0Q29udGVudCA9ICfwn5OmINCf0YDQvtCy0LXRgNC60LAg0LfQsNC60LDQt9C+0LInO1xuICAgIFtzZXR0aW5nc0dlbmVyYWxUYWIsIHNldHRpbmdzUnVsZXNUYWIsIHNldHRpbmdzT3JkZXJUYWJdLmZvckVhY2goYnV0dG9uID0+IHtcbiAgICAgICAgYnV0dG9uLnN0eWxlLmNzc1RleHQgPSAnZmxleDoxO3BhZGRpbmc6NnB4IDVweDtib3JkZXI6MXB4IHNvbGlkICNlMmU4ZjA7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojZjhmYWZjO2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6NjAwO2N1cnNvcjpwb2ludGVyOyc7XG4gICAgICAgIHNldHRpbmdzVGFicy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH0pO1xuXG4gICAgY29uc3Qgb3JkZXJDaGVja1BhbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBvcmRlckNoZWNrUGFuZS5pZCA9ICdtY1NldHRpbmdzSW50ZXJuYWxPcmRlckNoZWNrUGFuZSc7XG4gICAgb3JkZXJDaGVja1BhbmUuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICBjb25zdCBlbnN1cmVPcmRlckNoZWNrU2V0dGluZ3MgPSAoKSA9PiB7XG4gICAgICAgIGlmICghb3JkZXJDaGVja1BhbmUuZmlyc3RDaGlsZCkgb3JkZXJDaGVja1BhbmUuYXBwZW5kQ2hpbGQoaW50ZXJuYWxPcmRlckNoZWNrQnVpbGRTZXR0aW5nc1BhbmVsKCkpO1xuICAgIH07XG4gICAgY29uc3QgYWN0aXZhdGVTZXR0aW5nc1RhYiA9IGtleSA9PiB7XG4gICAgICAgIGlmIChrZXkgPT09ICdpbnRlcm5hbE9yZGVyQ2hlY2snKSBlbnN1cmVPcmRlckNoZWNrU2V0dGluZ3MoKTtcbiAgICAgICAgW1xuICAgICAgICAgICAgWydnZW5lcmFsJywgc2V0dGluZ3NHZW5lcmFsVGFiLCBnZW5lcmFsUGFuZV0sXG4gICAgICAgICAgICBbJ3J1bGVzJywgc2V0dGluZ3NSdWxlc1RhYiwgcnVsZXNQYW5lXSxcbiAgICAgICAgICAgIFsnaW50ZXJuYWxPcmRlckNoZWNrJywgc2V0dGluZ3NPcmRlclRhYiwgb3JkZXJDaGVja1BhbmVdXG4gICAgICAgIF0uZm9yRWFjaCgoW3RhYktleSwgYnV0dG9uLCBwYW5lXSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgYWN0aXZlID0ga2V5ID09PSB0YWJLZXk7XG4gICAgICAgICAgICBwYW5lLnN0eWxlLmRpc3BsYXkgPSBhY3RpdmUgPyAnYmxvY2snIDogJ25vbmUnO1xuICAgICAgICAgICAgYnV0dG9uLnN0eWxlLmJhY2tncm91bmQgPSBhY3RpdmUgPyAnbGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCM4YjVjZjYpJyA6ICcjZjhmYWZjJztcbiAgICAgICAgICAgIGJ1dHRvbi5zdHlsZS5jb2xvciA9IGFjdGl2ZSA/ICcjZmZmJyA6ICcjNDc1NTY5JztcbiAgICAgICAgfSk7XG4gICAgfTtcbiAgICBzZXR0aW5nc0dlbmVyYWxUYWIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhY3RpdmF0ZVNldHRpbmdzVGFiKCdnZW5lcmFsJykpO1xuICAgIHNldHRpbmdzUnVsZXNUYWIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhY3RpdmF0ZVNldHRpbmdzVGFiKCdydWxlcycpKTtcbiAgICBzZXR0aW5nc09yZGVyVGFiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYWN0aXZhdGVTZXR0aW5nc1RhYignaW50ZXJuYWxPcmRlckNoZWNrJykpO1xuICAgIGJvZHkuYXBwZW5kKHNldHRpbmdzVGFicywgZ2VuZXJhbFBhbmUsIHJ1bGVzUGFuZSwgb3JkZXJDaGVja1BhbmUpO1xuXG4gICAgd2luLmFwcGVuZENoaWxkKGJvZHkpO1xuXG4gICAgLy8g0KHQvdCw0YfQsNC70LAg0LIgRE9NIOKAlCDQuNC90LDRh9C1IGdldEVsZW1lbnRCeUlkINC90LUg0L3QsNC50LTRkdGCINGN0LvQtdC80LXQvdGC0Ysg0L7QutC90LAuXG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh3aW4pO1xuICAgIGFjdGl2YXRlU2V0dGluZ3NUYWIoaW5pdGlhbFRhYiA9PT0gJ2ludGVybmFsT3JkZXJDaGVjaycgPyAnaW50ZXJuYWxPcmRlckNoZWNrJyA6ICdnZW5lcmFsJyk7XG5cbiAgICAvLyDQn9GA0LjQstGP0LfQutC4OiBzZXR1cC3RhNGD0L3QutGG0LjQuCDRgdC40L3RhdGA0L7QvdC40LfQuNGA0YPRjtGCINGB0L7RgdGC0L7Rj9C90LjQtSwg0LTQvtC60YPQvNC10L3Rgi3RgdC70YPRiNCw0YLQtdC70Ywg0LLQtdGI0LDQtdGC0YHRjyDQvtC00LjQvSDRgNCw0LcuXG4gICAgc2V0dXBHbG9iYWxDbGVhclRleHRGdW5jdGlvbmFsaXR5KCk7XG4gICAgc2V0dXBIYXRpa29MaW5rc1NldHRpbmcoKTtcbiAgICBzZXR1cEhhdGlrb1NlYXJjaE1vZGVTZXR0aW5nKCk7XG4gICAgY29uc3QgcmV0cnlTZWxlY3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmV0cnlCZWhhdmlvcicpO1xuICAgIGlmIChyZXRyeVNlbGVjdCkge1xuICAgICAgICByZXRyeVNlbGVjdC52YWx1ZSA9IHJldHJ5QmVoYXZpb3I7XG4gICAgICAgIHJldHJ5U2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHNhdmVSZXRyeUJlaGF2aW9yKHJldHJ5U2VsZWN0LnZhbHVlKSk7XG4gICAgfVxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0aW1lb3V0U2xpZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBlID0+IHtcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRWYWx1ZScpLnRleHRDb250ZW50ID0gZS50YXJnZXQudmFsdWU7XG4gICAgfSk7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbGNTZXR0aW5nc0J0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYWxjU2V0dGluZ3NQYW5lbCcpO1xuICAgICAgICBjb25zdCB3YXNIaWRkZW4gPSBwYW5lbC5zdHlsZS5kaXNwbGF5ID09PSAnbm9uZSc7XG4gICAgICAgIHRvZ2dsZVBhbmVsKCdjYWxjU2V0dGluZ3NQYW5lbCcpO1xuICAgICAgICBpZiAod2FzSGlkZGVuKSBidWlsZENhbGNSdWxlc1BhbmVsKCk7XG4gICAgfSk7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjaGVkdWxlU2V0dGluZ3NCdG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NoZWR1bGVTZXR0aW5nc1BhbmVsJyk7XG4gICAgICAgIGNvbnN0IHdhc0hpZGRlbiA9IHBhbmVsLnN0eWxlLmRpc3BsYXkgPT09ICdub25lJztcbiAgICAgICAgdG9nZ2xlUGFuZWwoJ3NjaGVkdWxlU2V0dGluZ3NQYW5lbCcpO1xuICAgICAgICBpZiAod2FzSGlkZGVuKSBidWlsZFNjaGVkdWxlUGFuZWwoKTtcbiAgICB9KTtcbiAgICBjb25zdCBzY2hlZHVsZUNhY2hlQ2IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NoZWR1bGVDYWNoZUNoZWNrYm94Jyk7XG4gICAgc2NoZWR1bGVDYWNoZUNiLmNoZWNrZWQgPSBzY2hlZHVsZUNhY2hlRW5hYmxlZDtcbiAgICBzY2hlZHVsZUNhY2hlQ2IuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gc2F2ZVNjaGVkdWxlQ2FjaGVFbmFibGVkKHNjaGVkdWxlQ2FjaGVDYi5jaGVja2VkKSk7XG4gICAgY29uc3QgbXNRdWlja0NiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zUXVpY2tQYW5lbENoZWNrYm94Jyk7XG4gICAgaWYgKG1zUXVpY2tDYikge1xuICAgICAgICBtc1F1aWNrQ2IuY2hlY2tlZCA9IG1zUXVpY2tQYW5lbEVuYWJsZWQ7XG4gICAgICAgIG1zUXVpY2tDYi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBtc1F1aWNrUGFuZWxFbmFibGVkID0gbXNRdWlja0NiLmNoZWNrZWQ7XG4gICAgICAgICAgICBzYXZlTXNRdWlja1BhbmVsRW5hYmxlZCgpO1xuICAgICAgICAgICAgYnVpbGRNc1F1aWNrUGFuZWwoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGRlZmF1bHRDaGFubmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckRlZmF1bHRDaGFubmVsJyk7XG4gICAgaWYgKGRlZmF1bHRDaGFubmVsKSB7XG4gICAgICAgIGRlZmF1bHRDaGFubmVsLnZhbHVlID0gaGFja2VyRGVmYXVsdENoYW5uZWw7XG4gICAgICAgIGhhY2tlclJlZnJlc2hTYWxlc0NoYW5uZWxzKHRydWUpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgaGFja2VyU2FsZXNDaGFubmVscy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOyBvcHRpb24udmFsdWUgPSBpdGVtLmhyZWY7IG9wdGlvbi50ZXh0Q29udGVudCA9IGl0ZW0ubmFtZTsgZGVmYXVsdENoYW5uZWwuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgZGVmYXVsdENoYW5uZWwudmFsdWUgPSBoYWNrZXJEZWZhdWx0Q2hhbm5lbDtcbiAgICAgICAgfSk7XG4gICAgICAgIGRlZmF1bHRDaGFubmVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsgaGFja2VyRGVmYXVsdENoYW5uZWwgPSBkZWZhdWx0Q2hhbm5lbC52YWx1ZTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyRGVmYXVsdENoYW5uZWxfdjEnKSwgaGFja2VyRGVmYXVsdENoYW5uZWwpOyB9KTtcbiAgICB9XG4gICAgY29uc3QgcXVpY2tDYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJRdWlja0J1dHRvbnNDaGVja2JveCcpO1xuICAgIGlmIChxdWlja0NiKSB7IHF1aWNrQ2IuY2hlY2tlZCA9IGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQ7IHF1aWNrQ2IuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyBoYWNrZXJRdWlja0J1dHRvbnNFbmFibGVkID0gcXVpY2tDYi5jaGVja2VkOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJRdWlja0J1dHRvbnNfdjEnKSwgU3RyaW5nKGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQpKTsgYnVpbGRNc1F1aWNrUGFuZWwoKTsgfSk7IH1cbiAgICBjb25zdCBtYWdpY0FyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNNYWdpY0NvbmZpZ0pzb24nKTtcbiAgICBjb25zdCBtYWdpY1N0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtc01hZ2ljQ29uZmlnU3RhdHVzJyk7XG4gICAgaWYgKG1hZ2ljQXJlYSkgbWFnaWNBcmVhLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkobXNNYWdpY0NvbmZpZywgbnVsbCwgMik7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zTWFnaWNTZXR0aW5nc0J0bicpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRvZ2dsZVBhbmVsKCdtc01hZ2ljU2V0dGluZ3NQYW5lbCcpKTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNNYWdpY0NvbmZpZ1NhdmUnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKG1hZ2ljQXJlYT8udmFsdWUgfHwgJycpO1xuICAgICAgICAgICAgc2F2ZU1zTWFnaWNDb25maWcocGFyc2VkKTtcbiAgICAgICAgICAgIGlmIChtYWdpY0FyZWEpIG1hZ2ljQXJlYS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KG1zTWFnaWNDb25maWcsIG51bGwsIDIpO1xuICAgICAgICAgICAgaWYgKG1hZ2ljU3RhdHVzKSB7IG1hZ2ljU3RhdHVzLnRleHRDb250ZW50ID0gJ+KchSDQodC+0YXRgNCw0L3QtdC90L4nOyBtYWdpY1N0YXR1cy5zdHlsZS5jb2xvciA9ICcjMTZhMzRhJzsgfVxuICAgICAgICAgICAgcmVjb25jaWxlTXNFbmhhbmNlbWVudHMoKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmIChtYWdpY1N0YXR1cykgeyBtYWdpY1N0YXR1cy50ZXh0Q29udGVudCA9IGDinYwg0J7RiNC40LHQutCwOiAke2Vycm9yLm1lc3NhZ2V9YDsgbWFnaWNTdGF0dXMuc3R5bGUuY29sb3IgPSAnI2RjMjYyNic7IH1cbiAgICAgICAgfVxuICAgIH0pO1xuICAgIGNvbnN0IGJlYXJlckNiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zQmVhcmVyQ2hlY2tib3gnKTtcbiAgICBjb25zdCBiZWFyZXJJbnAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNCZWFyZXJUb2tlbicpO1xuICAgIGlmIChiZWFyZXJDYiAmJiBiZWFyZXJJbnApIHtcbiAgICAgICAgYmVhcmVyQ2IuY2hlY2tlZCA9IGhhY2tlckJlYXJlckVuYWJsZWQ7XG4gICAgICAgIGJlYXJlcklucC5zdHlsZS5kaXNwbGF5ID0gaGFja2VyQmVhcmVyRW5hYmxlZCA/ICdibG9jaycgOiAnbm9uZSc7XG4gICAgICAgIGJlYXJlcklucC52YWx1ZSA9IGhhY2tlckJlYXJlclRva2VuO1xuICAgICAgICBiZWFyZXJDYi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XG4gICAgICAgICAgICBoYWNrZXJTZXRCZWFyZXJFbmFibGVkKGJlYXJlckNiLmNoZWNrZWQpO1xuICAgICAgICAgICAgaGFja2VyVmFsaWRhdGVBcGlLZXkoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGJlYXJlcklucC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IGhhY2tlclNldEJlYXJlclRva2VuKGJlYXJlcklucC52YWx1ZSkpO1xuICAgICAgICBiZWFyZXJJbnAuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gaGFja2VyVmFsaWRhdGVBcGlLZXkoKSk7XG4gICAgfVxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXNldEZsb2F0UG9zQnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHJlc2V0RmxvYXRXaW5kb3dQb3MoKTtcbiAgICAgICAgY2xvc2VNZW1jaGF0T3ZlcmxheSgpO1xuICAgICAgICBzZXRTdGF0dXNUZXh0KCfinIUg0J/QvtC70L7QttC10L3QuNC1INC+0LrQvtC9INGB0LHRgNC+0YjQtdC90L4nKTtcbiAgICB9KTtcblxuICAgIC8vINCt0LrRgdC/0L7RgNGCIC8g0LjQvNC/0L7RgNGCINC90LDRgdGC0YDQvtC10LpcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZXhwb3J0U2V0dGluZ3NCdG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGV4cG9ydFNldHRpbmdzKTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaW1wb3J0U2V0dGluZ3NCdG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgY29uc3QgYXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydEFyZWEnKTtcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydEFjdGlvbnMnKTtcbiAgICAgICAgaWYgKCFhcmVhIHx8ICFhY3Rpb25zKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHNob3dpbmcgPSBhcmVhLnN0eWxlLmRpc3BsYXkgIT09ICdub25lJztcbiAgICAgICAgYXJlYS5zdHlsZS5kaXNwbGF5ID0gc2hvd2luZyA/ICdub25lJyA6ICdibG9jayc7XG4gICAgICAgIGFjdGlvbnMuc3R5bGUuZGlzcGxheSA9IHNob3dpbmcgPyAnbm9uZScgOiAnZmxleCc7XG4gICAgICAgIGlmICghc2hvd2luZykgYXJlYS5mb2N1cygpO1xuICAgIH0pO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydEFwcGx5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGltcG9ydFNldHRpbmdzKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydEFyZWEnKT8udmFsdWUgfHwgJycpO1xuICAgIH0pO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydENhbmNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBjb25zdCBhcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QXJlYScpO1xuICAgICAgICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QWN0aW9ucycpO1xuICAgICAgICBpZiAoYXJlYSkgeyBhcmVhLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7IGFyZWEudmFsdWUgPSAnJzsgYXJlYS5zdHlsZS5ib3JkZXJDb2xvciA9ICcjY2JkNWUxJzsgYXJlYS5zdHlsZS5ib3JkZXJXaWR0aCA9ICcxcHgnOyB9XG4gICAgICAgIGlmIChhY3Rpb25zKSBhY3Rpb25zLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgIHNldFN0YXR1c1RleHQoJ9Cd0LDQstC10LTQuNGC0LUg0L3QsCDQutC90L7Qv9C60YPigKYnKTtcbiAgICB9KTtcbiAgICBidWlsZENhbGNSdWxlc1BhbmVsKCk7XG4gICAgYnVpbGRTY2hlZHVsZVBhbmVsKCk7XG5cbiAgICBtYWtlTW92YWJsZSh3aW4sIGhlYWRlcik7XG4gICAgbWVtY2hhdFBsYXRmb3JtLmRpYWdub3N0aWNzPy5jbGVhblNldHRpbmdzKCk7XG59XG4iLCIvLyDilIDilIDilIAg0J7QsdGA0LDQsdC+0YLRh9C40LrQuCDRgdC+0LHRi9GC0LjQuSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNvbnN0IFRBQl9MQUJFTFMgPSB7XG4gICAgY2hlY2tIYXRpa286ICfwn5C2IEhhdGlrbycsXG4gICAgY2hlY2tIYXRpa29Cb251c2VzOiAn8J+OgSDQkdC+0L3Rg9GB0YsnLFxuICAgIHRvZGF5OiAn8J+foiDQodC10LPQvtC00L3RjycsXG4gICAgdG9tb3Jyb3c6ICfwn5+hINCX0LDQstGC0YDQsCcsXG4gICAgaGFja2VyOiAn8J+QseKAjfCfkrsg0KXQsNGC0LjQutC+0KXQsNC60LXRgCcsXG4gICAgY2FsY3VsYXRvcjogJ/Cfp64g0JrQsNC70YzQutGD0LvRj9GC0L7RgCcsXG4gICAgY2FsY3VsYXRvcl9yZXZlcnNlOiAn8J+UhCDQoNC10LLQtdGA0YEnLFxuICAgIGNhbGN1bGF0b3JfZGlzY291bnQ6ICfwn46JINCh0LrQuNC00LrQsC8rJyxcbiAgICBjYWxjdWxhdG9yX3NpbXBsZTogJ+KIkSDQn9GA0L7RgdGC0L7QuSdcbn07XG5cbmZ1bmN0aW9uIHNldHVwRXZlbnRMaXN0ZW5lcnMoKSB7XG4gICAgY29uc3QgY29udGFpbmVyID0gd2luZG93LnByaWNlQ2hlY2tDb250YWluZXI7XG5cbiAgICAvLyDQn9C10YDQtdGC0LDRgdC60LjQstCw0L3QuNC1XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tIZWFkZXInKS5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWRvd24nLCBzdGFydERyYWcpO1xuXG4gICAgLy8gRW50ZXIg0LIg0L/QvtC70LUg0LLQstC+0LTQsCDigJQg0YDQsNCx0L7RgtCw0LXRgiDRgtC+0LvRjNC60L4g0L3QsCDRgNC10LbQuNC80L3Ri9GFINCy0LrQu9Cw0LTQutCw0YVcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykuYWRkRXZlbnRMaXN0ZW5lcigna2V5cHJlc3MnLCBlID0+IHtcbiAgICAgICAgaWYgKGUua2V5ID09PSAnRW50ZXInICYmIGN1cnJlbnRBY3Rpb24gJiYgTU9ERV9BQ1RJT05TLmluY2x1ZGVzKGN1cnJlbnRBY3Rpb24pKSB7XG4gICAgICAgICAgICBleGVjdXRlQ3VycmVudEFjdGlvbigpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGUgPT4ge1xuICAgICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSBlLmN1cnJlbnRUYXJnZXQudmFsdWUgPSAnJztcbiAgICB9KTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZSA9PiB7XG4gICAgICAgIGlmIChlLmtleSA9PT0gJ0VzY2FwZScpIHtcbiAgICAgICAgICAgIGNsb3NlSGF0aWtvUHJvZHVjdFBpY2tlcigpO1xuICAgICAgICAgICAgY2xvc2VNZW1jaGF0T3ZlcmxheSgpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyDQmtC70LjQuiDQv9C+INCy0LrQu9Cw0LTQutC1XG4gICAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRhYl0nKS5mb3JFYWNoKHRhYiA9PiB7XG4gICAgICAgIHRhYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHNlbGVjdFRhYih0YWIuZGF0YXNldC50YWIpKTtcbiAgICB9KTtcblxuICAgIC8vINCa0LvQuNC60Lgg0L/QviDQu9C10L3RgtC1ICjQutC90L7Qv9C60LggwqvQmtC+0L/QuNGA0L7QstCw0YLRjMK7KVxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0NoYXRMb2cnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGhhbmRsZUNoYXRMb2dDbGljayk7XG5cbiAgICAvLyDQmtC90L7Qv9C60LAgwqvQntGH0LjRgdGC0LjRgtGMwrsg4oCUINCw0LrRgtC40LLQvdGD0Y4g0LLQutC70LDQtNC60YNcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jQ2xlYXJDaGF0QnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBjbGVhckNoYXQpO1xuXG4gICAgICAgIC8vINCR0YvRgdGC0YDRi9C1INC00LXQudGB0YLQstC40Y8g0Lgg0L3QsNGB0YLRgNC+0LnQutC4ICjQvdC40LbQvdGP0Y8g0L/QsNC90LXQu9GMKVxuICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jQ2xlYXJUZXh0VG9nZ2xlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgc2V0Q2xlYXJUZXh0RW5hYmxlZCghY2xlYXJUZXh0RW5hYmxlZCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0FjdGlvblNldHRpbmdzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBvcGVuU2V0dGluZ3NXaW5kb3cpO1xuXG4gICAgICAgICAgICAvLyDQotGD0LvRgtC40L/RiyDihpIg0YHRgtCw0YLRg9GBLdCx0LDRgCAo0YLQtdC60YHRgiDQstC90LjQt9GDLCDRgNGP0LTQvtC8INGBINC60L3QvtC/0LrQsNC80LgpXG4gICAgICAgICAgICAgICAgY29udGFpbmVyLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlb3ZlcicsIGUgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBlbCA9IGUudGFyZ2V0LmNsb3Nlc3Q/LignW2RhdGEtdGlwXScpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZWwpIHNldFN0YXR1c1RleHQoZWwuZGF0YXNldC50aXApO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGNvbnRhaW5lci5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW91dCcsIGUgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoZS50YXJnZXQuY2xvc2VzdD8uKCdbZGF0YS10aXBdJykpIHNldFN0YXR1c1RleHQoJ9Cd0LDQstC10LTQuNGC0LUg0L3QsCDQutC90L7Qv9C60YPigKYnKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAvLyDQl9Cw0LrRgNGL0YLQuNC1XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tDbG9zZUJ1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICB3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lci5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgIH0pO1xuXG4gICAgLy8gSG92ZXIg0Y3RhNGE0LXQutGCINC60L3QvtC/0LrQuCDQt9Cw0LrRgNGL0YLQuNGPXG4gICAgY29uc3QgY2xvc2VCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0Nsb3NlQnV0dG9uJyk7XG4gICAgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsgY2xvc2VCdG4uc3R5bGUuYmFja2dyb3VuZCA9ICcjZWY0NDQ0JzsgY2xvc2VCdG4uc3R5bGUuY29sb3IgPSAnI2ZmZic7IH0pO1xuICAgIGNsb3NlQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiB7IGNsb3NlQnRuLnN0eWxlLmJhY2tncm91bmQgPSAnI2YxZjVmOSc7IGNsb3NlQnRuLnN0eWxlLmNvbG9yID0gJyM2NDc0OGInOyB9KTtcbn1cblxuLy8g4pSA4pSA4pSAINCf0LXRgNC10LrQu9GO0YfQtdC90LjQtSDQstC60LvQsNC00L7QuiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIHNlbGVjdFRhYih0YWIpIHtcbiAgICBjb25zdCB0YWJzRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNUYWJzJyk7XG4gICAgdGFic0VsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRhYl0nKS5mb3JFYWNoKHQgPT4ge1xuICAgICAgICB0LmNsYXNzTGlzdC50b2dnbGUoJ21jLXRhYi1hY3RpdmUnLCB0LmRhdGFzZXQudGFiID09PSB0YWIpO1xuICAgIH0pO1xuXG4gICAgY3VycmVudEFjdGlvbiA9IHRhYjtcbiAgICBpZiAoTU9ERV9BQ1RJT05TLmluY2x1ZGVzKHRhYikpIHNhdmVTZWxlY3RlZEFjdGlvbih0YWIpO1xuICAgIGRlYnVnTG9nKCd0YWInLCAnc2VsZWN0ZWQnLCB0YWIpO1xuXG4gICAgLy8g0J3QsNC30LLQsNC90LjQtSDQstC60LvQsNC00LrQuCDigJQg0LIg0LfQsNCz0L7Qu9C+0LLQutC1INC+0LrQvdCwXG4gICAgICAgIGNvbnN0IHRpdGxlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdFRhYlRpdGxlJyk7XG4gICAgICAgIGlmICh0aXRsZUVsKSB0aXRsZUVsLnRleHRDb250ZW50ID0gVEFCX0xBQkVMU1t0YWJdIHx8IHRhYjtcblxuICAgICAgICBjb25zdCBzcGVjaWFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jU3BlY2lhbFBhbmUnKTtcbiAgICAgICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNJbnB1dFJlZ2lvbicpO1xuICAgICAgICBjb25zdCByZXN1bHQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNSZXN1bHRSZWdpb24nKTtcbiAgICAgICAgY29uc3QgaXNTY2hlZHVsZSA9IHRhYiA9PT0gJ3RvZGF5JyB8fCB0YWIgPT09ICd0b21vcnJvdyc7XG4gICAgICAgIGNvbnN0IGlzU3BlY2lhbCA9IGlzU2NoZWR1bGUgfHwgdGFiID09PSAnaGFja2VyJztcbiAgICAgICAgaWYgKHNwZWNpYWwpIHNwZWNpYWwuc3R5bGUuZGlzcGxheSA9IGlzU3BlY2lhbCA/ICdmbGV4JyA6ICdub25lJztcbiAgICAgICAgaWYgKGlucHV0KSBpbnB1dC5zdHlsZS5kaXNwbGF5ID0gaXNTcGVjaWFsID8gJ25vbmUnIDogJ2Jsb2NrJztcbiAgICAgICAgaWYgKHJlc3VsdCkgcmVzdWx0LnN0eWxlLmRpc3BsYXkgPSBpc1NwZWNpYWwgPyAnbm9uZScgOiAnZmxleCc7XG4gICAgICAgIGlmIChpc1NjaGVkdWxlKSBmZXRjaFdob1dvcmtzKHRhYik7XG4gICAgICAgIGVsc2UgaWYgKHRhYiA9PT0gJ2hhY2tlcicpIHJlbmRlckhhY2tlcklubGluZVRhYigpO1xuICAgICAgICBlbHNlIHJlbmRlckNoYXQoKTtcbiAgICB9XG5cbi8vINCS0L7RgdGB0YLQsNC90L7QstC40YLRjCDQv9C+0YHQu9C10LTQvdC40Lkg0LLRi9Cx0YDQsNC90L3Ri9C5INGA0LXQttC40LwgKNGC0L7Qu9GM0LrQviDRgNC10LbQuNC80L3Ri9C1INCy0LrQu9Cw0LTQutC4KVxuZnVuY3Rpb24gcmVzdG9yZVNlbGVjdGVkQWN0aW9uKCkge1xuICAgIGNvbnN0IGFjdGlvbiA9IGxvYWRTZWxlY3RlZEFjdGlvbigpO1xuICAgIGNvbnN0IHRhYiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLXRhYj1cIiR7YWN0aW9ufVwiXWApXG4gICAgICAgIHx8IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRhYj1cImNoZWNrSGF0aWtvXCJdJyk7XG4gICAgaWYgKHRhYikgc2VsZWN0VGFiKHRhYi5kYXRhc2V0LnRhYik7XG59XG5cbmZ1bmN0aW9uIHRvZ2dsZVBhbmVsKGlkKSB7XG4gICAgY29uc3QgaWRzID0gWydjYWxjU2V0dGluZ3NQYW5lbCcsICdzY2hlZHVsZVNldHRpbmdzUGFuZWwnLCAnbXNGaWVsZHNQYW5lbCddO1xuICAgIGlkcy5mb3JFYWNoKHBpZCA9PiB7XG4gICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQocGlkKTtcbiAgICAgICAgaWYgKCFlbCkgcmV0dXJuO1xuICAgICAgICBlbC5zdHlsZS5kaXNwbGF5ID0gKHBpZCA9PT0gaWQgJiYgZWwuc3R5bGUuZGlzcGxheSA9PT0gJ25vbmUnKSA/ICdibG9jaycgOiAnbm9uZSc7XG4gICAgfSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQmNC90LjRhtC40LDQu9C40LfQsNGG0LjRjyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGNsb3NlQ2hhdFdpbmRvdygpIHtcbiAgICBpZiAod2luZG93LnByaWNlQ2hlY2tDb250YWluZXIpIHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm1jLWZsb2F0LXdpbmRvdywgLm1jLW92ZXJsYXksICNtY0hhY2tlclF1aWNrUG9wdXAsICNtY0hhY2tlckFnZW50UG9wdXAsICNtY0hhY2tlckZsb2F0aW5nTG9nJykuZm9yRWFjaChlbCA9PiBlbC5yZW1vdmUoKSk7XG59XG5cbmZ1bmN0aW9uIGluaXRpYWxpemUoKSB7XG4gICAgaW5zdGFsbERlYnVnSGFuZGxlcnMoKTtcbiAgICBsb2FkQ2FsY1J1bGVzKCk7XG4gICAgbG9hZFNjaGVkdWxlUmVwbGFjZW1lbnRzKCk7XG4gICAgbG9hZFNjaGVkdWxlQ2FjaGVFbmFibGVkKCk7XG4gICAgbG9hZENoYXRIaXN0b3J5KCk7XG4gICAgc2V0dXBHbG9iYWxDbGVhclRleHRGdW5jdGlvbmFsaXR5KCk7XG4gICAgbG9hZEhpZGRlbkZpZWxkcygpO1xuICAgIGlmIChoaWRkZW5GaWVsZHMubGVuZ3RoKSB7IGhpZGRlbkZpZWxkcyA9IFtdOyBzYXZlSGlkZGVuRmllbGRzKCk7IH1cbiAgICBsb2FkTXNRdWlja1BhbmVsRW5hYmxlZCgpO1xuICAgIHJldHJ5QmVoYXZpb3IgPSBsb2FkUmV0cnlCZWhhdmlvcigpO1xuICAgIGhhY2tlckxvYWRTZXR0aW5ncygpO1xuICAgIGxvYWRNc01hZ2ljQ29uZmlnKCk7XG4gICAgdHJ5IHtcbiAgICAgICAgaGFja2VyRGVmYXVsdENoYW5uZWwgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScpKSB8fCAnJztcbiAgICAgICAgaGFja2VyUXVpY2tCdXR0b25zRW5hYmxlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlclF1aWNrQnV0dG9uc192MScpKSAhPT0gJ2ZhbHNlJztcbiAgICB9IGNhdGNoIHsgLyogZGVmYXVsdHMgKi8gfVxuXG4gICAgR01fcmVnaXN0ZXJNZW51Q29tbWFuZCgn0J7RgtC60YDRi9GC0Ywg0LzQtdC80L3Ri9C5INGH0LDRgicsIGNyZWF0ZVByaWNlQ2hlY2tXaW5kb3cpO1xuICAgICAgICBHTV9yZWdpc3Rlck1lbnVDb21tYW5kKCfQl9Cw0LrRgNGL0YLRjCDQvNC10LzQvdGL0Lkg0YfQsNGCJywgY2xvc2VDaGF0V2luZG93KTtcbiAgICAgICAgR01fcmVnaXN0ZXJNZW51Q29tbWFuZCgn0KHQsdGA0L7RgdC40YLRjCDQv9C+0LvQvtC20LXQvdC40LUg0L7QutC+0L0nLCByZXNldEZsb2F0V2luZG93UG9zKTtcbiAgICAgICAgR01fcmVnaXN0ZXJNZW51Q29tbWFuZCgn0J/QtdGA0LXQutC70Y7Rh9C40YLRjCDQvtGC0LvQsNC00LrRgyDQvNC10LzQvdC+0LPQviDRh9Cw0YLQsCcsIHRvZ2dsZURlYnVnTW9kZSk7XG4gICAgZGVidWdMb2coJ2luaXQnLCAnaW5pdGlhbGl6ZWQnKTtcbiAgICBjb25zb2xlLmxvZygn0JzQtdC80L3Ri9C5INGH0LDRgiB2OC45LjAtYWxwaGEuMSDQuNC90LjRhtC40LDQu9C40LfQuNGA0L7QstCw0L0nKTtcblxuICAgIC8vINCe0LTQuNC9INC90LDQsdC70Y7QtNCw0YLQtdC70Ywg0L7QsdGB0LvRg9C20LjQstCw0LXRgiDQstGB0LUg0LrQvtC90YLQtdC60YHRgtC90YvQtSDQstGB0YLRgNC+0LnQutC4INC4IFNQQS3Qv9C10YDQtdGF0L7QtNGLLlxuICAgIGlmICgvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSB7XG4gICAgICAgIHJlc3RvcmVNc0ZpZWxkcygpOyAvLyDQvNC40LPRgNCw0YbQuNGPINGB0L4g0YHRgtCw0YDQvtCz0L4g0YDQtdC20LjQvNCwINCy0YvQsdC+0YDQvtGH0L3QvtCz0L4g0YHQutGA0YvRgtC40Y9cbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jTXNSZXZlYWxCdG4nKT8ucmVtb3ZlKCk7XG4gICAgICAgIHN0YXJ0TXNTcGFPYnNlcnZlcigpO1xuICAgICAgICBpZiAoaGFja2VyQmVhcmVyRW5hYmxlZCAmJiBoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkpIGhhY2tlclZhbGlkYXRlQXBpS2V5KCk7XG4gICAgfVxufSIsIi8vIOKUgOKUgOKUgCDQpdCw0YLQuNC60L7QpdCw0LrQtdGAICjQnNC+0LnQodC60LvQsNC0IEFQSSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQktGB0YLRgNC+0LXQvdC90YvQtSDQuCDQv9C70LDQstCw0Y7RidC40LUg0LLQutC70LDQtNC60Lgg0KXQsNC60LXRgNCwICsg0LrQvtC90YHQvtC70Ywt0LvQvtCzINCy0L3QuNC30YMuXG4vLyDQotGA0LDQvdGB0L/QvtGA0YI6IEdNX3htbGh0dHBSZXF1ZXN0IOKGkiBodHRwczovL2FwaS5tb3lza2xhZC5ydS9hcGkvcmVtYXAvMS4yL1xuLy8g0JDQstGC0L7RgNC40LfQsNGG0LjRjzogQmVhcmVyLdC60LvRjtGHINC40Lcg0L3QsNGB0YLRgNC+0LXQuiAo0L/QviDRg9C80L7Qu9GH0LDQvdC40Y4g0LLRi9C60Lsg4oCUINGC0L7Qs9C00LAgY29va2llcyDRgdC10YHRgdC40LgpLlxuXG5jb25zdCBNU19BUElfQkFTRSA9ICdodHRwczovL2FwaS5tb3lza2xhZC5ydS9hcGkvcmVtYXAvMS4yJztcblxubGV0IGhhY2tlclRhYiAgICAgICAgICAgID0gJ3N0YXR1cyc7XG5sZXQgaGFja2VyTG9nTGluZXMgICAgICAgPSBbXTtcbmxldCBoYWNrZXJTdGF0ZXMgICAgICAgICA9IFtdOyAgLy8gW3tuYW1lLCBocmVmfV0g4oCUINGB0YLQsNGC0YPRgdGLINC30LDQutCw0LfQvtCyINC/0L7QutGD0L/QsNGC0LXQu9C10LlcbmxldCBoYWNrZXJTYWxlc0NoYW5uZWxzICA9IFtdOyAgLy8gW3tuYW1lLCBocmVmfV1cbmxldCBoYWNrZXJPcmRlckluZm8gICAgICA9IG51bGw7XG5sZXQgaGFja2VyTGFzdERlbWFuZCAgICAgPSBudWxsO1xubGV0IGhhY2tlckNvbnRleHQgICAgICAgID0geyBjdXN0b21lck9yZGVySWQ6ICcnLCBkZW1hbmRJZDogJycgfTtcbmxldCBoYWNrZXJCdXN5ICAgICAgICAgICA9IGZhbHNlO1xuXG5jb25zdCBIQUNLRVJfQVRUUl9DTElFTlRfU1RBVFVTID0gJ9Ch0YLQsNGC0YPRgSDQutC70LjQtdC90YLQsCc7XG5jb25zdCBIQUNLRVJfQVRUUl9QQVlfTUVUSE9EICAgID0gJ9Ch0L/QvtGB0L7QsSDQvtC/0LvQsNGC0YsnO1xuY29uc3QgSEFDS0VSX0FUVFJfUEFZX1RZUEUgICAgICA9ICfQotC40L8g0L7Qv9C70LDRgtGLJztcbmNvbnN0IEhBQ0tFUl9DQVNIX1BBWV9OQU1FICAgICAgID0gJ9Cd0LDQu9C40YfQvdGL0LzQuCc7XG5cbi8vIOKUgOKUgOKUgCDQndCw0YHRgtGA0L7QudC60LggQVBJLdC60LvRjtGH0LAgKGxvY2FsU3RvcmFnZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBSZW1vdGUgY2hhbmdlcyBzdG9wIHRoaXMgdGFiLCBuZXZlciBtaWdyYXRlIGl0cyBvbGQgd29yayB0byBhIG5ldyBCZWFyZXIuXG5sZXQgaGFja2VyQ3JlZGVudGlhbFNjb3BlQmxvY2tlZCA9IGZhbHNlO1xubGV0IG1zUmVmZXJlbmNlU2NvcGUgPSAnJztcbmxldCBtc1JlZmVyZW5jZUNhY2hlID0geyBsaXN0czoge30sIGF0dGVtcHRlZDogZmFsc2UsIGVycm9yczoge30gfTtcbmNvbnN0IG1zUmVmZXJlbmNlUmVxdWVzdHMgPSBuZXcgTWFwKCk7XG5sZXQgaGFja2VyVmFsaWRhdGlvbkluRmxpZ2h0ID0gbnVsbDtcblxuZnVuY3Rpb24gbXNSZWZlcmVuY2VSZXN0b3JlKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdtc1JlZmVyZW5jZUNhY2hlX3YxJykpIHx8ICdudWxsJyk7XG4gICAgICAgIGNvbnN0IHZhbGlkTGlzdHMgPSBzYXZlZD8ubGlzdHMgJiYgIUFycmF5LmlzQXJyYXkoc2F2ZWQubGlzdHMpICYmIHR5cGVvZiBzYXZlZC5saXN0cyA9PT0gJ29iamVjdCdcbiAgICAgICAgICAgICYmIE9iamVjdC5lbnRyaWVzKHNhdmVkLmxpc3RzKS5ldmVyeSgoW2tpbmQsIGl0ZW1zXSkgPT5cbiAgICAgICAgICAgICAgICBbJ29yZ2FuaXphdGlvbicsICdzdG9yZScsICdjdXN0b21lcm9yZGVyJywgJ2ludGVybmFsb3JkZXInXS5pbmNsdWRlcyhraW5kKSAmJiBBcnJheS5pc0FycmF5KGl0ZW1zKVxuICAgICAgICAgICAgICAgICYmIGl0ZW1zLmV2ZXJ5KGl0ZW0gPT4gaXRlbSAmJiB0eXBlb2YgaXRlbS5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgaXRlbS5ocmVmID09PSAnc3RyaW5nJykpO1xuICAgICAgICBtc1JlZmVyZW5jZUNhY2hlID0gc2F2ZWQ/LnZlcnNpb24gPT09IDEgJiYgc2F2ZWQuc2NvcGUgPT09IG1zUmVmZXJlbmNlU2NvcGUgJiYgdmFsaWRMaXN0c1xuICAgICAgICAgICAgPyBzYXZlZCA6IHsgbGlzdHM6IHt9LCBhdHRlbXB0ZWQ6IGZhbHNlLCBlcnJvcnM6IHt9IH07XG4gICAgfSBjYXRjaCB7IG1zUmVmZXJlbmNlQ2FjaGUgPSB7IGxpc3RzOiB7fSwgYXR0ZW1wdGVkOiBmYWxzZSwgZXJyb3JzOiB7fSB9OyB9XG4gICAgaWYgKG1zUmVmZXJlbmNlU2NvcGUpIHtcbiAgICAgICAgaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zID0gbXNSZWZlcmVuY2VDYWNoZS5saXN0cy5vcmdhbml6YXRpb24gfHwgW107XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1dhcmVob3VzZXMgPSBtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLnN0b3JlIHx8IFtdO1xuICAgICAgICBoYWNrZXJTdGF0ZXMgPSBtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLmN1c3RvbWVyb3JkZXIgfHwgW107XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1N0YXR1c2VzID0ge1xuICAgICAgICAgICAgY3VzdG9tZXJvcmRlcjogaGFja2VyU3RhdGVzLFxuICAgICAgICAgICAgaW50ZXJuYWxvcmRlcjogbXNSZWZlcmVuY2VDYWNoZS5saXN0cy5pbnRlcm5hbG9yZGVyIHx8IFtdXG4gICAgICAgIH07XG4gICAgfVxufVxuXG5mdW5jdGlvbiBtc1JlZmVyZW5jZVNhdmUoKSB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnbXNSZWZlcmVuY2VDYWNoZV92MScpLCBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIC4uLm1zUmVmZXJlbmNlQ2FjaGUsIHZlcnNpb246IDEsIHNjb3BlOiBtc1JlZmVyZW5jZVNjb3BlXG4gICAgfSkpO1xufVxuXG5mdW5jdGlvbiBtc1JlZmVyZW5jZUZpbGxDb250cm9scygpIHtcbiAgICBoYWNrZXJOb3RpZmllckZpbGxDb250cm9scygpO1xuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxPcmdhbml6YXRpb25zKCk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbFdhcmVob3VzZXMoKTtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsU3RhdHVzZXMoJ2N1c3RvbWVyb3JkZXInKTtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsU3RhdHVzZXMoJ2ludGVybmFsb3JkZXInKTtcbiAgICBoYWNrZXJGaWxsU2VsZWN0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJTdGF0ZVNlbGVjdCcpLCBoYWNrZXJTdGF0ZXMpO1xufVxuXG5mdW5jdGlvbiBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pIHtcbiAgICBpZiAoc2NvcGUgIT09IG1zUmVmZXJlbmNlU2NvcGUgfHwgZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uIHx8ICFoYWNrZXJDaGVja0NyZWRlbnRpYWxTY29wZSgpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign0JfQsNCz0YDRg9C30LrQsCDRgdC/0YDQsNCy0L7Rh9C90LjQutC+0LIg0L7RgtC80LXQvdC10L3QsDog0LjQt9C80LXQvdC10L3RiyDRg9GH0ZHRgtC90YvQtSDQtNCw0L3QvdGL0LUnKTtcbiAgICB9XG59XG5cbi8vIE9uZSByZXF1ZXN0IHBlciBlbmRwb2ludC9nZW5lcmF0aW9uLCBzaGFyZWQgYnkgdmFsaWRhdGlvbiBhbmQgYm90aCBzZXR0aW5ncyBwYW5lcy5cbmZ1bmN0aW9uIG1zUmVmZXJlbmNlRmV0Y2goa2luZCkge1xuICAgIGNvbnN0IGtleSA9IGAke21zQXBpR2VuZXJhdGlvbn06JHtraW5kfWA7XG4gICAgaWYgKG1zUmVmZXJlbmNlUmVxdWVzdHMuaGFzKGtleSkpIHJldHVybiBtc1JlZmVyZW5jZVJlcXVlc3RzLmdldChrZXkpO1xuICAgIGNvbnN0IHNjb3BlID0gbXNSZWZlcmVuY2VTY29wZTtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIGNvbnN0IHBhdGggPSBraW5kID09PSAnb3JnYW5pemF0aW9uJyB8fCBraW5kID09PSAnc3RvcmUnXG4gICAgICAgID8gYC9lbnRpdHkvJHtraW5kfT9vcmRlcj1uYW1lJmxpbWl0PTEwMDBgIDogYC9lbnRpdHkvJHtraW5kfS9tZXRhZGF0YWA7XG4gICAgY29uc3QgcmVxdWVzdCA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJvd3MgPSBbXTtcbiAgICAgICAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQoKTtcbiAgICAgICAgbGV0IG5leHQgPSBwYXRoO1xuICAgICAgICBkbyB7XG4gICAgICAgICAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgICAgICAgICAgY29uc3Qgbm9ybWFsaXplZCA9IGhhY2tlckFwaVBhdGgobmV4dCk7XG4gICAgICAgICAgICBpZiAoIW5vcm1hbGl6ZWQgfHwgdmlzaXRlZC5oYXMobm9ybWFsaXplZCkpIHRocm93IG5ldyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3QsNGPINC/0LDQs9C40L3QsNGG0LjRjyDRgdC/0YDQsNCy0L7Rh9C90LjQutCwJyk7XG4gICAgICAgICAgICB2aXNpdGVkLmFkZChub3JtYWxpemVkKTtcbiAgICAgICAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBtc0FwaVAoJ0dFVCcsIG5vcm1hbGl6ZWQpO1xuICAgICAgICAgICAgbXNSZWZlcmVuY2VBc3NlcnRDdXJyZW50KHNjb3BlLCBnZW5lcmF0aW9uKTtcbiAgICAgICAgICAgIGNvbnN0IGl0ZW1zID0ga2luZCA9PT0gJ29yZ2FuaXphdGlvbicgfHwga2luZCA9PT0gJ3N0b3JlJ1xuICAgICAgICAgICAgICAgID8gZGF0YT8ucm93cyA6IChBcnJheS5pc0FycmF5KGRhdGE/LnN0YXRlcykgPyBkYXRhLnN0YXRlcyA6IGRhdGE/LnN0YXRlcz8ucm93cyk7XG4gICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoaXRlbXMpKSB0aHJvdyBuZXcgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQvtGC0LLQtdGCINGB0L/RgNCw0LLQvtGH0L3QuNC60LAnKTtcbiAgICAgICAgICAgIHJvd3MucHVzaCguLi5pdGVtcy5tYXAoaXRlbSA9PiAoeyBuYW1lOiBpdGVtLm5hbWUsIGhyZWY6IGl0ZW0ubWV0YT8uaHJlZiwgY29sb3I6IGl0ZW0uY29sb3IgfSkpXG4gICAgICAgICAgICAgICAgLmZpbHRlcihpdGVtID0+IGl0ZW0ubmFtZSAmJiBpdGVtLmhyZWYpKTtcbiAgICAgICAgICAgIG5leHQgPSBraW5kID09PSAnb3JnYW5pemF0aW9uJyB8fCBraW5kID09PSAnc3RvcmUnID8gZGF0YT8ubWV0YT8ubmV4dEhyZWYgOiAnJztcbiAgICAgICAgfSB3aGlsZSAobmV4dCk7XG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH0pKCk7XG4gICAgbXNSZWZlcmVuY2VSZXF1ZXN0cy5zZXQoa2V5LCByZXF1ZXN0KTtcbiAgICByZXF1ZXN0LmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBpZiAobXNSZWZlcmVuY2VSZXF1ZXN0cy5nZXQoa2V5KSA9PT0gcmVxdWVzdCkgbXNSZWZlcmVuY2VSZXF1ZXN0cy5kZWxldGUoa2V5KTtcbiAgICB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmZ1bmN0aW9uIG1zUmVmZXJlbmNlTG9hZChraW5kLCB7IGZvcmNlID0gZmFsc2UsIHNlZWQgfSA9IHt9KSB7XG4gICAgaWYgKCFmb3JjZSAmJiBPYmplY3QuaGFzT3duKG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMsIGtpbmQpKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG1zUmVmZXJlbmNlQ2FjaGUubGlzdHNba2luZF0pO1xuICAgIGNvbnN0IHNjb3BlID0gbXNSZWZlcmVuY2VTY29wZTtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIHJldHVybiAoc2VlZCA/IFByb21pc2UucmVzb2x2ZShzZWVkKSA6IG1zUmVmZXJlbmNlRmV0Y2goa2luZCkpLnRoZW4oaXRlbXMgPT4ge1xuICAgICAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgICAgICBtc1JlZmVyZW5jZUNhY2hlLmxpc3RzW2tpbmRdID0gaXRlbXM7XG4gICAgICAgIG1zUmVmZXJlbmNlU2F2ZSgpO1xuICAgICAgICBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMgPSBtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLm9yZ2FuaXphdGlvbiB8fCBbXTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrV2FyZWhvdXNlcyA9IG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMuc3RvcmUgfHwgW107XG4gICAgICAgIGhhY2tlclN0YXRlcyA9IG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMuY3VzdG9tZXJvcmRlciB8fCBbXTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzZXMuY3VzdG9tZXJvcmRlciA9IGhhY2tlclN0YXRlcztcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzZXMuaW50ZXJuYWxvcmRlciA9IG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMuaW50ZXJuYWxvcmRlciB8fCBbXTtcbiAgICAgICAgbXNSZWZlcmVuY2VGaWxsQ29udHJvbHMoKTtcbiAgICAgICAgcmV0dXJuIGl0ZW1zO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBtc1JlZmVyZW5jZVNob3dTdGF0dXMoc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsT3JkZXJTZXR0aW5nc1N0YXR1cycpKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5yZWZlcmVuY2VzPy5zaG93U3RhdHVzKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLnJlZmVyZW5jZXMuc2hvd1N0YXR1cyhzdGF0dXMpO1xuICAgIGNvbnN0IGxhYmVscyA9IHsgb3JnYW5pemF0aW9uOiAn0J7RgNCz0LDQvdC40LfQsNGG0LjQuCcsIHN0b3JlOiAn0KHQutC70LDQtNGLJywgY3VzdG9tZXJvcmRlcjogJ9Ch0YLQsNGC0YPRgdGLINC30LDQutCw0LfQvtCyJywgaW50ZXJuYWxvcmRlcjogJ9Ch0YLQsNGC0YPRgdGLINCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQvtCyJyB9O1xuICAgIGNvbnN0IGVycm9ycyA9IE9iamVjdC5lbnRyaWVzKG1zUmVmZXJlbmNlQ2FjaGUuZXJyb3JzIHx8IHt9KTtcbiAgICAvLyBhdHRlbXB0ZWQgc3VwcHJlc3NlcyBhdXRvbWF0aWMgcmV0cmllczsgb25seSBwcmVzZW50IGxpc3RzIHByb3ZlIGNvbXBsZXRlbmVzcy5cbiAgICAvLyBBIHN1Y2Nlc3NmdWwgZW1wdHkgYXJyYXkgaXMgcHJlc2VudCwgdW5saWtlIGEgcmVxdWVzdCBpbnRlcnJ1cHRlZCBieSB0YWIgY2xvc2UuXG4gICAgY29uc3QgbWlzc2luZyA9IE9iamVjdC5rZXlzKGxhYmVscykuZmlsdGVyKGtpbmQgPT4gIU9iamVjdC5oYXNPd24obXNSZWZlcmVuY2VDYWNoZS5saXN0cywga2luZCkpO1xuICAgIGNvbnN0IHdhcm5pbmdzID0gW107XG4gICAgaWYgKGVycm9ycy5sZW5ndGgpIHdhcm5pbmdzLnB1c2goJ+KaoCDQndC1INC+0LHQvdC+0LLQu9C10L3RizogJyArIGVycm9ycy5tYXAoKFtraW5kLCBtZXNzYWdlXSkgPT4gYCR7bGFiZWxzW2tpbmRdfSDigJQgJHttZXNzYWdlfWApLmpvaW4oJzsgJykpO1xuICAgIGlmIChtaXNzaW5nLmxlbmd0aCAmJiAobXNSZWZlcmVuY2VDYWNoZS5hdHRlbXB0ZWQgfHwgT2JqZWN0LmtleXMobXNSZWZlcmVuY2VDYWNoZS5saXN0cykubGVuZ3RoKSkge1xuICAgICAgICB3YXJuaW5ncy5wdXNoKCfimqAg0J3QtSDQt9Cw0LPRgNGD0LbQtdC90Ys6ICcgKyBtaXNzaW5nLm1hcChraW5kID0+IGxhYmVsc1traW5kXSkuam9pbignOyAnKSArICcuINCd0LDQttC80LjRgtC1IMKr0JfQsNCz0YDRg9C30LjRgtGMINGB0L/RgNCw0LLQvtGH0L3QuNC60LjCuycpO1xuICAgIH1cbiAgICBjb25zdCBtZXNzYWdlID0gd2FybmluZ3Muam9pbignLiAnKSB8fCAobWlzc2luZy5sZW5ndGggPyAnJyA6ICfQodC/0YDQsNCy0L7Rh9C90LjQutC4INC30LDQs9GA0YPQttC10L3RiycpO1xuICAgIGlmIChzdGF0dXMpIHtcbiAgICAgICAgc3RhdHVzLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgICAgICAgc3RhdHVzLnN0eWxlLmNvbG9yID0gd2FybmluZ3MubGVuZ3RoID8gJyNiOTFjMWMnIDogJyMxNjY1MzQnO1xuICAgIH1cbiAgICBpZiAod2FybmluZ3MubGVuZ3RoKSBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhtZXNzYWdlLCAnZXJyb3InKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbXNSZWZlcmVuY2VSZWZyZXNoKHsgZm9yY2UgPSBmYWxzZSwgc3RhdGVzLCBzdGF0dXMgfSA9IHt9KSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5yZWZlcmVuY2VzPy5yZWZyZXNoKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLnJlZmVyZW5jZXMucmVmcmVzaCh7IGZvcmNlLCBzdGF0ZXMsIHN0YXR1cyB9KTtcbiAgICBtc1JlZmVyZW5jZUNhY2hlLmF0dGVtcHRlZCA9IHRydWU7XG4gICAgY29uc3Qgc2NvcGUgPSBtc1JlZmVyZW5jZVNjb3BlO1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgY29uc3Qga2luZHMgPSBbJ29yZ2FuaXphdGlvbicsICdzdG9yZScsICdjdXN0b21lcm9yZGVyJywgJ2ludGVybmFsb3JkZXInXTtcbiAgICBjb25zdCBvdXRjb21lcyA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChraW5kcy5tYXAoa2luZCA9PiBtc1JlZmVyZW5jZUxvYWQoa2luZCxcbiAgICAgICAgeyBmb3JjZSwgc2VlZDoga2luZCA9PT0gJ2N1c3RvbWVyb3JkZXInID8gc3RhdGVzIDogdW5kZWZpbmVkIH0pKSk7XG4gICAgbXNSZWZlcmVuY2VBc3NlcnRDdXJyZW50KHNjb3BlLCBnZW5lcmF0aW9uKTtcbiAgICBtc1JlZmVyZW5jZUNhY2hlLmVycm9ycyA9IE9iamVjdC5mcm9tRW50cmllcyhvdXRjb21lcy5mbGF0TWFwKChvdXRjb21lLCBpbmRleCkgPT5cbiAgICAgICAgb3V0Y29tZS5zdGF0dXMgPT09ICdyZWplY3RlZCcgPyBbW2tpbmRzW2luZGV4XSwgb3V0Y29tZS5yZWFzb24uc3RhdHVzXG4gICAgICAgICAgICA/IGBIVFRQICR7b3V0Y29tZS5yZWFzb24uc3RhdHVzfWAgOiAn0L7RiNC40LHQutCwINC30LDQs9GA0YPQt9C60Lg7INC/0L7QstGC0L7RgNC40YLQtSDQstGA0YPRh9C90YPRjiddXSA6IFtdKSk7XG4gICAgbXNSZWZlcmVuY2VTYXZlKCk7XG4gICAgbXNSZWZlcmVuY2VTaG93U3RhdHVzKHN0YXR1cyk7XG4gICAgcmV0dXJuIHsgb2s6IE9iamVjdC5rZXlzKG1zUmVmZXJlbmNlQ2FjaGUuZXJyb3JzKS5sZW5ndGggPT09IDAsIGVycm9yczogbXNSZWZlcmVuY2VDYWNoZS5lcnJvcnMgfTtcbn1cblxuZnVuY3Rpb24gbXNSZWZlcmVuY2VCb290c3RyYXAoc3RhdGVzKSB7XG4gICAgY29uc3Qgc2NvcGUgPSBtc1JlZmVyZW5jZVNjb3BlO1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgY29uc3QgYm9vdHN0cmFwID0gKCkgPT4ge1xuICAgICAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgICAgICAvLyBBbm90aGVyIHNhbWUtb3JpZ2luIHRhYiBtYXkgaGF2ZSBjb21wbGV0ZWQgd2hpbGUgdGhpcyBvbmUgd2FpdGVkLlxuICAgICAgICBtc1JlZmVyZW5jZVJlc3RvcmUoKTtcbiAgICAgICAgaWYgKCFtc1JlZmVyZW5jZUNhY2hlLmF0dGVtcHRlZCkgcmV0dXJuIG1zUmVmZXJlbmNlUmVmcmVzaCh7IHN0YXRlcyB9KTtcbiAgICAgICAgbXNSZWZlcmVuY2VGaWxsQ29udHJvbHMoKTtcbiAgICAgICAgbXNSZWZlcmVuY2VTaG93U3RhdHVzKCk7XG4gICAgfTtcbiAgICByZXR1cm4gbmF2aWdhdG9yLmxvY2tzPy5yZXF1ZXN0XG4gICAgICAgID8gbmF2aWdhdG9yLmxvY2tzLnJlcXVlc3Qoc3RvcmFnZUtleSgnbXNSZWZlcmVuY2VCb290c3RyYXBfdjE6JykgKyBzY29wZSwgYm9vdHN0cmFwKVxuICAgICAgICA6IFByb21pc2UucmVzb2x2ZSgpLnRoZW4oYm9vdHN0cmFwKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTG9hZFNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHMgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck1zQXBpX3YxJykpIHx8ICd7fScpO1xuICAgICAgICBoYWNrZXJCZWFyZXJFbmFibGVkID0gISFzLmJlYXJlckVuYWJsZWQ7XG4gICAgICAgIGhhY2tlckJlYXJlclRva2VuID0gdHlwZW9mIHMudG9rZW4gPT09ICdzdHJpbmcnID8gcy50b2tlbiA6ICcnO1xuICAgICAgICBtc1JlZmVyZW5jZVNjb3BlID0gcy5yZWZlcmVuY2VTY29wZSB8fCAoaGFja2VyQmVhcmVyVG9rZW4gPyBjcnlwdG8ucmFuZG9tVVVJRCgpIDogJycpO1xuICAgICAgICBpZiAobXNSZWZlcmVuY2VTY29wZSAmJiAhcy5yZWZlcmVuY2VTY29wZSkge1xuICAgICAgICAgICAgLy8gQmluZCBwcmUtdXBncmFkZSBjaG9pY2VzIG9ubHkgdG8gdGhlIGNyZWRlbnRpYWxzIGFscmVhZHkgb24gZGlzay5cbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsnaGFja2VyT3JkZXJOb3RpZmllcl92MScsIElOVEVSTkFMX09SREVSX0NIRUNLX1NUT1JBR0VfS0VZXSkge1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleShrZXkpKSB8fCAnbnVsbCcpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmF3ICYmICFyYXcucmVmZXJlbmNlU2NvcGUpIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoa2V5KSwgSlNPTi5zdHJpbmdpZnkoeyAuLi5yYXcsIHJlZmVyZW5jZVNjb3BlOiBtc1JlZmVyZW5jZVNjb3BlIH0pKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIHsgLyogSW52YWxpZCBvbGQgc2V0dGluZ3MgYXJlIGhhbmRsZWQgYnkgdGhlaXIgb3duIGxvYWRlci4gKi8gfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaGFja2VyU2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgICAgaGFja2VyQmVhcmVyRW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICBoYWNrZXJCZWFyZXJUb2tlbiA9ICcnO1xuICAgICAgICBtc1JlZmVyZW5jZVNjb3BlID0gJyc7XG4gICAgfVxuICAgIGhhY2tlckNyZWRlbnRpYWxTY29wZUJsb2NrZWQgPSBmYWxzZTtcbiAgICBoYWNrZXJMb2FkQ2FjaGVkU3RhdGVzKCk7XG4gICAgaGFja2VyTm90aWZpZXJMb2FkU2V0dGluZ3MoKTtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tMb2FkU2V0dGluZ3MoKTtcbiAgICBtc1JlZmVyZW5jZVJlc3RvcmUoKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTG9hZENhY2hlZFN0YXRlcygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyU3RhdGVzX3YxJykpIHx8ICdbXScpO1xuICAgICAgICBoYWNrZXJTdGF0ZXMgPSBBcnJheS5pc0FycmF5KHNhdmVkKVxuICAgICAgICAgICAgPyBzYXZlZC5maWx0ZXIoc3RhdGUgPT4gc3RhdGUgJiYgdHlwZW9mIHN0YXRlLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBzdGF0ZS5ocmVmID09PSAnc3RyaW5nJyAmJiBzdGF0ZS5uYW1lICYmIHN0YXRlLmhyZWYpXG4gICAgICAgICAgICAgICAgLm1hcChzdGF0ZSA9PiAoeyBuYW1lOiBzdGF0ZS5uYW1lLCBocmVmOiBzdGF0ZS5ocmVmLCBjb2xvcjogc3RhdGUuY29sb3IgfSkpXG4gICAgICAgICAgICA6IFtdO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGhhY2tlclN0YXRlcyA9IFtdO1xuICAgICAgICBkZWJ1Z0Vycm9yKCdoYWNrZXInLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDQt9Cw0LPRgNGD0LfQuNGC0Ywg0LrRjdGIINGB0YLQsNGC0YPRgdC+0LInLCBlcnJvcik7XG4gICAgfVxuICAgIHJldHVybiBoYWNrZXJTdGF0ZXM7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclNhdmVTdGF0ZXMoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyU3RhdGVzX3YxJyksIEpTT04uc3RyaW5naWZ5KGhhY2tlclN0YXRlcykpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ2hhY2tlcicsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQutGN0Ygg0YHRgtCw0YLRg9GB0L7QsicsIGVycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlclNhdmVTZXR0aW5ncygpIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJNc0FwaV92MScpLCBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICBiZWFyZXJFbmFibGVkOiBoYWNrZXJCZWFyZXJFbmFibGVkLFxuICAgICAgICAgICAgdG9rZW46IGhhY2tlckJlYXJlclRva2VuLFxuICAgICAgICAgICAgcmVmZXJlbmNlU2NvcGU6IG1zUmVmZXJlbmNlU2NvcGVcbiAgICAgICAgfSkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ2hhY2tlcicsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQvdCw0YHRgtGA0L7QudC60LggQVBJJywgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKSB7XG4gICAgaWYgKGhhY2tlckNyZWRlbnRpYWxTY29wZUJsb2NrZWQpIHJldHVybiBmYWxzZTtcbiAgICBsZXQgbWF0Y2hlcyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJNc0FwaV92MScpKSB8fCAne30nKTtcbiAgICAgICAgbWF0Y2hlcyA9ICEhc2F2ZWQuYmVhcmVyRW5hYmxlZCA9PT0gaGFja2VyQmVhcmVyRW5hYmxlZFxuICAgICAgICAgICAgJiYgKHR5cGVvZiBzYXZlZC50b2tlbiA9PT0gJ3N0cmluZycgPyBzYXZlZC50b2tlbiA6ICcnKSA9PT0gaGFja2VyQmVhcmVyVG9rZW47XG4gICAgfSBjYXRjaCB7IC8qIFVucmVhZGFibGUvcmVtb3ZlZCBjcmVkZW50aWFscyBmYWlsIGNsb3NlZC4gKi8gfVxuICAgIGlmIChtYXRjaGVzKSByZXR1cm4gdHJ1ZTtcbiAgICBoYWNrZXJDcmVkZW50aWFsU2NvcGVCbG9ja2VkID0gdHJ1ZTtcbiAgICBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbiAgICBtc0FwaUNhbmNlbEFsbCgpO1xuICAgIGhhY2tlclVwZGF0ZUJlYXJlclN0YXR1cygn4oCUJywgJ9C90LDRgdGC0YDQvtC50LrQuCDQuNC30LzQtdC90LXQvdGLINCyINC00YDRg9Cz0L7QuSDQstC60LvQsNC00LrQtTsg0L/QvtC00YLQstC10YDQtNC40YLQtSDQutC70Y7RhycpO1xuICAgIGhhY2tlclN5bmNBY2Nlc3NVaSgpO1xuICAgIHJldHVybiBmYWxzZTtcbn1cblxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3N0b3JhZ2UnLCBldmVudCA9PiB7XG4gICAgLy8gQnJvd3NlciBvcmlnaW4gaXNvbGF0aW9uIHBsdXMgc3RvcmFnZUtleSBrZWVwcyBERVYvcHJvZHVjdGlvbiBzZXBhcmF0ZS5cbiAgICAvLyBSZWFkIGN1cnJlbnQgc3RvcmFnZSwgbm90IHRoZSBldmVudCBwYXlsb2FkOyBpZ25vcmUgc2Vzc2lvblN0b3JhZ2UuXG4gICAgaWYgKGV2ZW50LnN0b3JhZ2VBcmVhICYmIGV2ZW50LnN0b3JhZ2VBcmVhICE9PSBsb2NhbFN0b3JhZ2UpIHJldHVybjtcbiAgICBpZiAoZXZlbnQua2V5ICE9PSBudWxsICYmIGV2ZW50LmtleSAhPT0gc3RvcmFnZUtleSgnaGFja2VyTXNBcGlfdjEnKSkgcmV0dXJuO1xuICAgIGhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCk7XG59KTtcblxuLy8g0JLRi9C30YvQstCw0LXRgtGB0Y8g0LjQtyDQvtC60L3QsCDQvdCw0YHRgtGA0L7QtdC6ICgwOSlcbmZ1bmN0aW9uIGhhY2tlclNldEJlYXJlckVuYWJsZWQoZW5hYmxlZCkge1xuICAgIGlmIChoYWNrZXJCZWFyZXJFbmFibGVkICE9PSAhIWVuYWJsZWQpIG1zQXBpQ2FuY2VsQWxsKCk7XG4gICAgaGFja2VyQmVhcmVyRW5hYmxlZCA9ICEhZW5hYmxlZDtcbiAgICBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbiAgICBoYWNrZXJTYXZlU2V0dGluZ3MoKTtcbiAgICBoYWNrZXJDcmVkZW50aWFsU2NvcGVCbG9ja2VkID0gZmFsc2U7XG4gICAgY29uc3QgaW5wID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zQmVhcmVyVG9rZW4nKTtcbiAgICBpZiAoaW5wKSBpbnAuc3R5bGUuZGlzcGxheSA9IGhhY2tlckJlYXJlckVuYWJsZWQgPyAnYmxvY2snIDogJ25vbmUnO1xuICAgIGhhY2tlclN5bmNBY2Nlc3NVaSgpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJTeW5jQWNjZXNzVWkoKSB7XG4gICAgbWVtY2hhdFBsYXRmb3JtLm9uQWNjZXNzVWk/LigpO1xuICAgIGNvbnN0IGFsbG93ZWQgPSBoYWNrZXJCZWFyZXJFbmFibGVkICYmICEhaGFja2VyQmVhcmVyVG9rZW4udHJpbSgpICYmIGhhY2tlckFwaVZhbGlkYXRlZDtcbiAgICBjb25zdCB0YWIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcjbWNUYWJzIFtkYXRhLXRhYj1cImhhY2tlclwiXScpO1xuICAgIGlmICh0YWIpIHRhYi5oaWRkZW4gPSAhYWxsb3dlZDtcbiAgICBpZiAoIWFsbG93ZWQgJiYgY3VycmVudEFjdGlvbiA9PT0gJ2hhY2tlcicgJiYgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jVGFicycpKSB7XG4gICAgICAgIHNlbGVjdFRhYignY2hlY2tIYXRpa28nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiByZWNvbmNpbGVNc0VuaGFuY2VtZW50cyA9PT0gJ2Z1bmN0aW9uJykgcmVjb25jaWxlTXNFbmhhbmNlbWVudHMoKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyVXBkYXRlQmVhcmVyU3RhdHVzKGNvZGUsIHRleHQpIHtcbiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtZW1jaGF0QmVhcmVyU3RhdHVzJyk7XG4gICAgaWYgKCFlbCkgcmV0dXJuO1xuICAgIGVsLnRleHRDb250ZW50ID0gaGFja2VyQmVhcmVyRW5hYmxlZCA/IGBCZWFyZXI6ICR7Y29kZX0ke3RleHQgPyBgIOKAlCAke3RleHR9YCA6ICcnfWAgOiAnJztcbiAgICBlbC5zdHlsZS5jb2xvciA9IGNvZGUgPj0gMjAwICYmIGNvZGUgPCAzMDAgPyAnIzE2YTM0YScgOiAnI2RjMjYyNic7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclZhbGlkYXRlQXBpS2V5KG9uRG9uZSkge1xuICAgIGlmICghaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKSB8fCAhaGFja2VyQmVhcmVyRW5hYmxlZCB8fCAhaGFja2VyQmVhcmVyVG9rZW4udHJpbSgpKSB7XG4gICAgICAgIGhhY2tlckFwaVZhbGlkYXRlZCA9IGZhbHNlO1xuICAgICAgICBoYWNrZXJVcGRhdGVCZWFyZXJTdGF0dXMoJ+KAlCcsICfQstGL0LrQuycpO1xuICAgICAgICBoYWNrZXJTeW5jQWNjZXNzVWkoKTtcbiAgICAgICAgb25Eb25lPy4oZmFsc2UpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICB9XG4gICAgaWYgKGhhY2tlclZhbGlkYXRpb25JbkZsaWdodD8uZ2VuZXJhdGlvbiA9PT0gbXNBcGlHZW5lcmF0aW9uKSB7XG4gICAgICAgIHJldHVybiBoYWNrZXJWYWxpZGF0aW9uSW5GbGlnaHQucHJvbWlzZS50aGVuKG9rID0+IHsgb25Eb25lPy4ob2spOyByZXR1cm4gb2s7IH0pO1xuICAgIH1cbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIGNvbnN0IHNjb3BlID0gbXNSZWZlcmVuY2VTY29wZTtcbiAgICBjb25zdCBwcm9taXNlID0gbXNSZWZlcmVuY2VGZXRjaCgnY3VzdG9tZXJvcmRlcicpLnRoZW4oYXN5bmMgc3RhdGVzID0+IHtcbiAgICAgICAgbXNSZWZlcmVuY2VBc3NlcnRDdXJyZW50KHNjb3BlLCBnZW5lcmF0aW9uKTtcbiAgICAgICAgaGFja2VyQXBpVmFsaWRhdGVkID0gdHJ1ZTtcbiAgICAgICAgaGFja2VyVXBkYXRlQmVhcmVyU3RhdHVzKDIwMCwgJ9Cy0LDQu9C40LTQtdC9Jyk7XG4gICAgICAgIGhhY2tlclN5bmNBY2Nlc3NVaSgpO1xuICAgICAgICBvbkRvbmU/Lih0cnVlKTtcbiAgICAgICAgYXdhaXQgbXNSZWZlcmVuY2VCb290c3RyYXAoc3RhdGVzKTtcbiAgICAgICAgbXNSZWZlcmVuY2VBc3NlcnRDdXJyZW50KHNjb3BlLCBnZW5lcmF0aW9uKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJNYXliZVN0YXJ0KCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTdG9wKCk7XG4gICAgICAgIGhhY2tlclVwZGF0ZUJlYXJlclN0YXR1cyhlcnJvcj8uc3RhdHVzIHx8IDQwMSwgJ9C+0YjQuNCx0LrQsCcpO1xuICAgICAgICBoYWNrZXJTeW5jQWNjZXNzVWkoKTtcbiAgICAgICAgb25Eb25lPy4oZmFsc2UpO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfSkuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGlmIChoYWNrZXJWYWxpZGF0aW9uSW5GbGlnaHQ/LnByb21pc2UgPT09IHByb21pc2UpIGhhY2tlclZhbGlkYXRpb25JbkZsaWdodCA9IG51bGw7XG4gICAgfSk7XG4gICAgaGFja2VyVmFsaWRhdGlvbkluRmxpZ2h0ID0geyBnZW5lcmF0aW9uLCBwcm9taXNlIH07XG4gICAgcmV0dXJuIHByb21pc2U7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckNhblJ1bihvbkRlbmllZCkge1xuICAgIGlmICghaGFja2VyQmVhcmVyRW5hYmxlZCB8fCAhaGFja2VyQmVhcmVyVG9rZW4udHJpbSgpIHx8ICFoYWNrZXJBcGlWYWxpZGF0ZWQpIHtcbiAgICAgICAgaGFja2VyVmFsaWRhdGVBcGlLZXkob2sgPT4ge1xuICAgICAgICAgICAgaWYgKCFvaykge1xuICAgICAgICAgICAgICAgIGhhY2tlckxvZygn0JLQutC70Y7Rh9C40YLQtSBCZWFyZXIg0Lgg0YPQutCw0LbQuNGC0LUg0LTQtdC50YHRgtCy0YPRjtGJ0LjQuSBBUEkt0LrQu9GO0Ycg0JzQvtC50KHQutC70LDQtCcsICd3YXJuJyk7XG4gICAgICAgICAgICAgICAgb25EZW5pZWQ/LigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gaGFja2VyU2V0QmVhcmVyVG9rZW4odmFsdWUpIHtcbiAgICBjb25zdCBjaGFuZ2VkID0gaGFja2VyQmVhcmVyVG9rZW4gIT09IFN0cmluZyh2YWx1ZSB8fCAnJyk7XG4gICAgaWYgKGNoYW5nZWQpIG1zQXBpQ2FuY2VsQWxsKCk7XG4gICAgaGFja2VyQmVhcmVyVG9rZW4gPSBTdHJpbmcodmFsdWUgfHwgJycpO1xuICAgIGlmIChjaGFuZ2VkKSBtc1JlZmVyZW5jZVNjb3BlID0gaGFja2VyQmVhcmVyVG9rZW4gPyBjcnlwdG8ucmFuZG9tVVVJRCgpIDogJyc7XG4gICAgaGFja2VyQXBpVmFsaWRhdGVkID0gZmFsc2U7XG4gICAgaGFja2VyU2F2ZVNldHRpbmdzKCk7XG4gICAgaGFja2VyQ3JlZGVudGlhbFNjb3BlQmxvY2tlZCA9IGZhbHNlO1xuICAgIGlmIChjaGFuZ2VkKSB7XG4gICAgICAgIG1zUmVmZXJlbmNlUmVzdG9yZSgpO1xuICAgICAgICBoYWNrZXJOb3RpZmllckxvYWRTZXR0aW5ncygpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tMb2FkU2V0dGluZ3MoKTtcbiAgICAgICAgbXNSZWZlcmVuY2VGaWxsQ29udHJvbHMoKTtcbiAgICB9XG4gICAgaGFja2VyU3luY0FjY2Vzc1VpKCk7XG59XG5cbi8vIOKUgOKUgOKUgCDQotGA0LDQvdGB0L/QvtGA0YIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBoYWNrZXJFbnN1cmVCZWFyZXIoKSB7XG4gICAgaWYgKCFoYWNrZXJDaGVja0NyZWRlbnRpYWxTY29wZSgpKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L06INC/0L7QtNGC0LLQtdGA0LTQuNGC0LUgQVBJLdC60LvRjtGHINCyINGN0YLQvtC5INCy0LrQu9Cw0LTQutC1Jyk7XG4gICAgaWYgKCFoYWNrZXJCZWFyZXJFbmFibGVkIHx8ICFoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfQktC60LvRjtGH0LjRgtC1IEJlYXJlciDQuCDRg9C60LDQttC40YLQtSBBUEkt0LrQu9GO0Ycg0JzQvtC50KHQutC70LDQtCcpO1xuICAgIH1cbn1cblxuY29uc3QgTVNfQVBJX01BWF9DT05DVVJSRU5UX1JFUVVFU1RTID0gMjtcbmNvbnN0IE1TX0FQSV9SQVRFX1NBRkVUWV9GQUNUT1IgPSAxLjI7XG5jb25zdCBtc0FwaVJlcXVlc3RRdWV1ZSA9IFtdO1xuY29uc3QgbXNBcGlSYXRlTGltaXRTdGF0ZSA9IHtcbiAgICBsaW1pdDogbnVsbCxcbiAgICByZW1haW5pbmc6IG51bGwsXG4gICAgaW50ZXJ2YWxNczogbnVsbCxcbiAgICByZXNldE1zOiBudWxsLFxuICAgIHJldHJ5QWZ0ZXJNczogbnVsbCxcbiAgICB1cGRhdGVkQXQ6IG51bGwsXG4gICAgcGFyYWxsZWxMaW1pdEVycm9yczogMFxufTtcbmxldCBtc0FwaUluRmxpZ2h0ID0gMDtcbmxldCBtc0FwaU5leHRSZXF1ZXN0QXQgPSAwO1xubGV0IG1zQXBpQmxvY2tlZFVudGlsID0gMDtcbmxldCBtc0FwaVBhcmFsbGVsQ29vbGRvd25VbnRpbCA9IDA7XG5sZXQgbXNBcGlRdWV1ZVRpbWVyID0gbnVsbDtcblxubGV0IG1zQXBpR2VuZXJhdGlvbiA9IDA7XG5jb25zdCBtc0FwaVRhc2tzID0gbmV3IFNldCgpO1xuXG5mdW5jdGlvbiBtc0FwaUNhbmNlbEFsbCgpIHtcbiAgICBtc0FwaUdlbmVyYXRpb24rKztcbiAgICBoYWNrZXJOb3RpZmllclN0b3AoKTtcbiAgICBbLi4ubXNBcGlUYXNrc10uZm9yRWFjaCh0YXNrID0+IHRhc2suY2FuY2VsKCkpO1xufVxuXG5mdW5jdGlvbiBtc0FwaUdldExpbWl0U3RhdHMoKSB7XG4gICAgcmV0dXJuIHsgLi4ubXNBcGlSYXRlTGltaXRTdGF0ZSwgaW5GbGlnaHQ6IG1zQXBpSW5GbGlnaHQsIHF1ZXVlZDogbXNBcGlSZXF1ZXN0UXVldWUubGVuZ3RoIH07XG59XG5cbmZ1bmN0aW9uIG1zQXBpUGFyc2VSZXNwb25zZUhlYWRlcnMocmF3SGVhZGVycykge1xuICAgIGNvbnN0IGhlYWRlcnMgPSB7fTtcbiAgICBTdHJpbmcocmF3SGVhZGVycyB8fCAnJykuc3BsaXQoU3RyaW5nLmZyb21DaGFyQ29kZSgxMCkpLmZvckVhY2gocmF3TGluZSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSByYXdMaW5lLnRyaW0oKTtcbiAgICAgICAgY29uc3Qgc2VwYXJhdG9yID0gbGluZS5pbmRleE9mKCc6Jyk7XG4gICAgICAgIGlmIChzZXBhcmF0b3IgPCAxKSByZXR1cm47XG4gICAgICAgIGhlYWRlcnNbbGluZS5zbGljZSgwLCBzZXBhcmF0b3IpLnRyaW0oKS50b0xvd2VyQ2FzZSgpXSA9IGxpbmUuc2xpY2Uoc2VwYXJhdG9yICsgMSkudHJpbSgpO1xuICAgIH0pO1xuICAgIHJldHVybiBoZWFkZXJzO1xufVxuXG5mdW5jdGlvbiBtc0FwaU51bWJlckhlYWRlcihoZWFkZXJzLCBuYW1lKSB7XG4gICAgY29uc3QgdmFsdWUgPSBOdW1iZXIoaGVhZGVyc1tuYW1lXSk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPj0gMCA/IHZhbHVlIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gbXNBcGlVcGRhdGVMaW1pdFN0YXRlKHJlc3BvbnNlKSB7XG4gICAgY29uc3QgaGVhZGVycyA9IG1zQXBpUGFyc2VSZXNwb25zZUhlYWRlcnMocmVzcG9uc2U/LnJlc3BvbnNlSGVhZGVycyk7XG4gICAgY29uc3QgbGltaXQgPSBtc0FwaU51bWJlckhlYWRlcihoZWFkZXJzLCAneC1yYXRlbGltaXQtbGltaXQnKTtcbiAgICBjb25zdCByZW1haW5pbmcgPSBtc0FwaU51bWJlckhlYWRlcihoZWFkZXJzLCAneC1yYXRlbGltaXQtcmVtYWluaW5nJyk7XG4gICAgY29uc3QgaW50ZXJ2YWxNcyA9IG1zQXBpTnVtYmVySGVhZGVyKGhlYWRlcnMsICd4LWxvZ25leC1yZXRyeS10aW1laW50ZXJ2YWwnKTtcbiAgICBjb25zdCByZXNldE1zID0gbXNBcGlOdW1iZXJIZWFkZXIoaGVhZGVycywgJ3gtbG9nbmV4LXJlc2V0Jyk7XG4gICAgY29uc3QgcmV0cnlBZnRlck1zID0gbXNBcGlOdW1iZXJIZWFkZXIoaGVhZGVycywgJ3gtbG9nbmV4LXJldHJ5LWFmdGVyJyk7XG5cbiAgICBpZiAobGltaXQgIT09IG51bGwpIG1zQXBpUmF0ZUxpbWl0U3RhdGUubGltaXQgPSBsaW1pdDtcbiAgICBpZiAocmVtYWluaW5nICE9PSBudWxsKSBtc0FwaVJhdGVMaW1pdFN0YXRlLnJlbWFpbmluZyA9IHJlbWFpbmluZztcbiAgICBpZiAoaW50ZXJ2YWxNcyAhPT0gbnVsbCkgbXNBcGlSYXRlTGltaXRTdGF0ZS5pbnRlcnZhbE1zID0gaW50ZXJ2YWxNcztcbiAgICBpZiAocmVzZXRNcyAhPT0gbnVsbCkgbXNBcGlSYXRlTGltaXRTdGF0ZS5yZXNldE1zID0gcmVzZXRNcztcbiAgICBpZiAocmV0cnlBZnRlck1zICE9PSBudWxsKSBtc0FwaVJhdGVMaW1pdFN0YXRlLnJldHJ5QWZ0ZXJNcyA9IHJldHJ5QWZ0ZXJNcztcbiAgICBtc0FwaVJhdGVMaW1pdFN0YXRlLnVwZGF0ZWRBdCA9IERhdGUubm93KCk7XG5cbiAgICBpZiAobGltaXQgIT09IG51bGwgJiYgbGltaXQgPiAwICYmIGludGVydmFsTXMgIT09IG51bGwgJiYgaW50ZXJ2YWxNcyA+IDApIHtcblxuICAgICAgICAvLyBIZWFkZXIgY291bnRzIG1heSBiZSB3ZWlnaHRlZCB1bml0cywgbm90IHdob2xlIEhUVFAgcmVxdWVzdHMuXG4gICAgICAgIGNvbnN0IGJ1ZGdldCA9IE1hdGgubWF4KDEsIE1hdGguZmxvb3IoKHJlbWFpbmluZyA/PyBsaW1pdCkgLyA1KSk7XG4gICAgICAgIG1zQXBpTmV4dFJlcXVlc3RBdCA9IE1hdGgubWF4KG1zQXBpTmV4dFJlcXVlc3RBdCwgRGF0ZS5ub3coKSArIE1hdGgubWF4KDUwMCwgTWF0aC5jZWlsKChyZXNldE1zIHx8IGludGVydmFsTXMpIC8gYnVkZ2V0ICogTVNfQVBJX1JBVEVfU0FGRVRZX0ZBQ1RPUikpKTtcbiAgICB9XG4gICAgaWYgKHJlbWFpbmluZyA9PT0gMCkge1xuICAgICAgICBjb25zdCB3YWl0TXMgPSByZXRyeUFmdGVyTXMgfHwgcmVzZXRNcyB8fCBpbnRlcnZhbE1zIHx8IDA7XG4gICAgICAgIGlmICh3YWl0TXMgPiAwKSBtc0FwaUJsb2NrZWRVbnRpbCA9IE1hdGgubWF4KG1zQXBpQmxvY2tlZFVudGlsLCBEYXRlLm5vdygpICsgd2FpdE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgaGVhZGVycywgcmF0ZUxpbWl0OiB7IGxpbWl0LCByZW1haW5pbmcsIGludGVydmFsTXMsIHJlc2V0TXMsIHJldHJ5QWZ0ZXJNcyB9IH07XG59XG5cbmZ1bmN0aW9uIG1zQXBpU2NoZWR1bGVRdWV1ZSh3YWl0TXMpIHtcbiAgICBpZiAobXNBcGlRdWV1ZVRpbWVyIHx8ICFtc0FwaVJlcXVlc3RRdWV1ZS5sZW5ndGgpIHJldHVybjtcbiAgICBtc0FwaVF1ZXVlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgbXNBcGlRdWV1ZVRpbWVyID0gbnVsbDtcbiAgICAgICAgbXNBcGlQdW1wUXVldWUoKTtcbiAgICB9LCBNYXRoLm1heCgxLCB3YWl0TXMpKTtcbn1cblxuZnVuY3Rpb24gbXNBcGlQdW1wUXVldWUoKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5kaXJlY3RNcykge1xuICAgICAgICBpZiAoIWhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCkpIHJldHVybjtcbiAgICAgICAgd2hpbGUgKG1zQXBpUmVxdWVzdFF1ZXVlLmxlbmd0aCkge1xuICAgICAgICAgICAgY29uc3QgdGFzayA9IG1zQXBpUmVxdWVzdFF1ZXVlLnNoaWZ0KCk7XG4gICAgICAgICAgICBpZiAodGFzay5nZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24gfHwgdGFzay5zaWduYWw/LmFib3J0ZWQgfHwgdGFzay50b2tlbiAhPT0gaGFja2VyQmVhcmVyVG9rZW4udHJpbSgpKSB0YXNrLmNhbmNlbCgpO1xuICAgICAgICAgICAgZWxzZSBtc0FwaVN0YXJ0VGFzayh0YXNrKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghbXNBcGlSZXF1ZXN0UXVldWUubGVuZ3RoKSByZXR1cm47XG4gICAgaWYgKCFoYWNrZXJDaGVja0NyZWRlbnRpYWxTY29wZSgpKSByZXR1cm47XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBjb29sZG93blVudGlsID0gTWF0aC5tYXgobXNBcGlCbG9ja2VkVW50aWwsIG1zQXBpUGFyYWxsZWxDb29sZG93blVudGlsKTtcbiAgICBpZiAobm93IDwgY29vbGRvd25VbnRpbCkge1xuICAgICAgICBtc0FwaVNjaGVkdWxlUXVldWUoY29vbGRvd25VbnRpbCAtIG5vdyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY29uY3VycmVuY3lMaW1pdCA9IG5vdyA8IG1zQXBpUGFyYWxsZWxDb29sZG93blVudGlsID8gMSA6IE1TX0FQSV9NQVhfQ09OQ1VSUkVOVF9SRVFVRVNUUztcbiAgICB3aGlsZSAobXNBcGlSZXF1ZXN0UXVldWUubGVuZ3RoICYmIG1zQXBpSW5GbGlnaHQgPCBjb25jdXJyZW5jeUxpbWl0KSB7XG4gICAgICAgIGNvbnN0IGRlbGF5ID0gbXNBcGlOZXh0UmVxdWVzdEF0IC0gRGF0ZS5ub3coKTtcbiAgICAgICAgaWYgKGRlbGF5ID4gMCkge1xuICAgICAgICAgICAgbXNBcGlTY2hlZHVsZVF1ZXVlKGRlbGF5KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0YXNrID0gbXNBcGlSZXF1ZXN0UXVldWUuc2hpZnQoKTtcbiAgICAgICAgaWYgKHRhc2suZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uIHx8IHRhc2suc2lnbmFsPy5hYm9ydGVkKSB7IHRhc2suY2FuY2VsKCk7IGNvbnRpbnVlOyB9XG4gICAgICAgIGNvbnN0IHdlaWdodCA9IHRhc2subWV0aG9kID09PSAnR0VUJyAmJiAvXlxcL3JlcG9ydFxcL3N0b2NrXFwvKGFsbHxieXN0b3JlKSg/OlxcP3xcXC8/JCkvLnRlc3QodGFzay5wYXRoKSA/IDUgOiA0O1xuICAgICAgICBtc0FwaU5leHRSZXF1ZXN0QXQgPSBEYXRlLm5vdygpICsgNTAwICogd2VpZ2h0IC8gNDtcbiAgICAgICAgbXNBcGlTdGFydFRhc2sodGFzayk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBtc0FwaVN0YXJ0VGFzayh0YXNrKSB7XG4gICAgbXNBcGlJbkZsaWdodCArPSAxO1xuICAgIGxldCBjb21wbGV0ZWQgPSBmYWxzZTtcbiAgICBjb25zdCBmaW5pc2ggPSAoY2FsbGJhY2ssIHZhbHVlKSA9PiB7XG4gICAgICAgIGlmIChjb21wbGV0ZWQpIHJldHVybjtcbiAgICAgICAgY29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgbXNBcGlJbkZsaWdodCA9IE1hdGgubWF4KDAsIG1zQXBpSW5GbGlnaHQgLSAxKTtcbiAgICAgICAgbXNBcGlUYXNrcy5kZWxldGUodGFzayk7XG4gICAgICAgIHRhc2suc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIHRhc2suYWJvcnRMaXN0ZW5lcik7XG4gICAgICAgIHRyeSB7IGNhbGxiYWNrKHZhbHVlKTsgfSBmaW5hbGx5IHsgbXNBcGlQdW1wUXVldWUoKTsgfVxuICAgIH07XG4gICAgbGV0IGhhbmRsZTtcbiAgICB0YXNrLmNhbmNlbCA9ICgpID0+IHtcbiAgICAgICAgaWYgKGNvbXBsZXRlZCkgcmV0dXJuO1xuICAgICAgICBoYW5kbGU/LmFib3J0Py4oKTtcbiAgICAgICAgZmluaXNoKHRhc2sub25FcnJvciwgbmV3IEVycm9yKCfQl9Cw0L/RgNC+0YEg0LogYXBpLm1veXNrbGFkLnJ1INC+0YLQvNC10L3RkdC9JykpO1xuICAgIH07XG4gICAgY29uc3QgaGVhZGVycyA9IHsgJ0FjY2VwdCc6ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnIH07XG4gICAgaWYgKHRhc2suYm9keSkgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbjtjaGFyc2V0PXV0Zi04JztcbiAgICBoZWFkZXJzWydBdXRob3JpemF0aW9uJ10gPSAnQmVhcmVyICcgKyB0YXNrLnRva2VuO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgaGFuZGxlID0gR01feG1saHR0cFJlcXVlc3Qoe1xuICAgICAgICAgICAgbWV0aG9kOiB0YXNrLm1ldGhvZCxcbiAgICAgICAgICAgIHVybDogTVNfQVBJX0JBU0UgKyB0YXNrLnBhdGgsXG4gICAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgICAgZGF0YTogdGFzay5ib2R5ID8gSlNPTi5zdHJpbmdpZnkodGFzay5ib2R5KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHRpbWVvdXQ6IDMwMDAwLFxuICAgICAgICAgICAgYW5vbnltb3VzOiBmYWxzZSxcbiAgICAgICAgICAgIG1lbWNoYXRJc0N1cnJlbnQ6ICgpID0+ICFjb21wbGV0ZWQgJiYgaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKVxuICAgICAgICAgICAgICAgICYmIHRhc2suZ2VuZXJhdGlvbiA9PT0gbXNBcGlHZW5lcmF0aW9uICYmICF0YXNrLnNpZ25hbD8uYWJvcnRlZCxcbiAgICAgICAgICAgIG9ubG9hZDogcmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQpIHJldHVybjtcbiAgICAgICAgICAgICAgICBpZiAoIWhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCkgfHwgdGFzay5nZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24gfHwgdGFzay5zaWduYWw/LmFib3J0ZWQpIHsgdGFzay5jYW5jZWwoKTsgcmV0dXJuOyB9XG4gICAgICAgICAgICAgICAgY29uc3QgcmF3ID0gcmVzcG9uc2UucmVzcG9uc2VUZXh0IHx8ICcnO1xuICAgICAgICAgICAgICAgIGxldCBkYXRhID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0cnkgeyBkYXRhID0gcmF3ID8gSlNPTi5wYXJzZShyYXcpIDogbnVsbDsgfSBjYXRjaCAoZSkgeyAvKiDQvdC1IEpTT04gKi8gfVxuICAgICAgICAgICAgICAgIGNvbnN0IGxpbWl0SW5mbyA9IG1zQXBpVXBkYXRlTGltaXRTdGF0ZShyZXNwb25zZSk7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA+PSAyMDAgJiYgcmVzcG9uc2Uuc3RhdHVzIDwgMzAwKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkYXRhICYmIHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JykgZGF0YS5fc3RhdHVzID0gcmVzcG9uc2Uuc3RhdHVzO1xuICAgICAgICAgICAgICAgICAgICBmaW5pc2godGFzay5vblN1Y2Nlc3MsIGRhdGEpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGFwaUVycm9yID0gZGF0YT8uZXJyb3JzPy5bMF0gfHwgbnVsbDtcbiAgICAgICAgICAgICAgICBjb25zdCBhcGlNc2cgPSBhcGlFcnJvclxuICAgICAgICAgICAgICAgICAgICA/IChhcGlFcnJvci5lcnJvciB8fCBhcGlFcnJvci5wYXJhbWV0ZXIgfHwgYXBpRXJyb3IuY29kZSB8fCBKU09OLnN0cmluZ2lmeShhcGlFcnJvcikpXG4gICAgICAgICAgICAgICAgICAgIDogJyc7XG4gICAgICAgICAgICAgICAgbGV0IG1zZyA9IGFwaU1zZyB8fCAoJ0hUVFAgJyArIHJlc3BvbnNlLnN0YXR1cyk7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDAxICYmICFoYWNrZXJCZWFyZXJFbmFibGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIG1zZyArPSAnIOKAlCDQstC60LvRjtGH0LjRgtC1IMKrQmVhcmVyLdC60LvRjtGHIEFQScK7INCyINC90LDRgdGC0YDQvtC50LrQsNGFINC4INCy0YHRgtCw0LLRjNGC0LUgQVBJLdC60LvRjtGHJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IobXNnKTtcbiAgICAgICAgICAgICAgICBlcnJvci5zdGF0dXMgPSByZXNwb25zZS5zdGF0dXM7XG4gICAgICAgICAgICAgICAgZXJyb3IuYXBpQ29kZSA9IGFwaUVycm9yPy5jb2RlID8/IG51bGw7XG4gICAgICAgICAgICAgICAgZXJyb3IuYXV0aENvZGUgPSBsaW1pdEluZm8uaGVhZGVyc1sneC1sb2duZXgtYXV0aCddIHx8IG51bGw7XG4gICAgICAgICAgICAgICAgZXJyb3IucmF0ZUxpbWl0ID0gbGltaXRJbmZvLnJhdGVMaW1pdDtcbiAgICAgICAgICAgICAgICBjb25zdCBpc1BhcmFsbGVsTGltaXQgPSByZXNwb25zZS5zdGF0dXMgPT09IDQyOVxuICAgICAgICAgICAgICAgICAgICAmJiAoTnVtYmVyKGVycm9yLmFwaUNvZGUpID09PSAxMDczIHx8IGVycm9yLmF1dGhDb2RlID09PSAnNDI5MDA1Jyk7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5KSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHdhaXRNcyA9IGxpbWl0SW5mby5yYXRlTGltaXQucmV0cnlBZnRlck1zXG4gICAgICAgICAgICAgICAgICAgICAgICB8fCBsaW1pdEluZm8ucmF0ZUxpbWl0LnJlc2V0TXNcbiAgICAgICAgICAgICAgICAgICAgICAgIHx8IGxpbWl0SW5mby5yYXRlTGltaXQuaW50ZXJ2YWxNc1xuICAgICAgICAgICAgICAgICAgICAgICAgfHwgMTAwMDtcbiAgICAgICAgICAgICAgICAgICAgbXNBcGlCbG9ja2VkVW50aWwgPSBNYXRoLm1heChtc0FwaUJsb2NrZWRVbnRpbCwgRGF0ZS5ub3coKSArIHdhaXRNcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChpc1BhcmFsbGVsTGltaXQpIHtcbiAgICAgICAgICAgICAgICAgICAgbXNBcGlSYXRlTGltaXRTdGF0ZS5wYXJhbGxlbExpbWl0RXJyb3JzICs9IDE7XG4gICAgICAgICAgICAgICAgICAgIG1zQXBpUGFyYWxsZWxDb29sZG93blVudGlsID0gTWF0aC5tYXgobXNBcGlQYXJhbGxlbENvb2xkb3duVW50aWwsIERhdGUubm93KCkgKyAxMDAwMCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICgocmVzcG9uc2Uuc3RhdHVzID09PSA0MjkgfHwgTnVtYmVyKGVycm9yLmFwaUNvZGUpID09PSAxMDczKVxuICAgICAgICAgICAgICAgICAgICAmJiB0YXNrLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdGFzay5hdHRlbXB0IDwgMiAmJiAhR01feG1saHR0cFJlcXVlc3QubWVtY2hhdE1zU2NoZWR1bGVyKSB7XG4gICAgICAgICAgICAgICAgICAgIG1zQXBpQmxvY2tlZFVudGlsID0gTWF0aC5tYXgobXNBcGlCbG9ja2VkVW50aWwsIERhdGUubm93KCkgKyAxMDAwICogMiAqKiB0YXNrLmF0dGVtcHQpO1xuICAgICAgICAgICAgICAgICAgICBjb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBtc0FwaUluRmxpZ2h0LS07XG4gICAgICAgICAgICAgICAgICAgIHRhc2suYXR0ZW1wdCsrO1xuICAgICAgICAgICAgICAgICAgICB0YXNrLmNhbmNlbCA9IHRhc2suY2FuY2VsUXVldWVkO1xuICAgICAgICAgICAgICAgICAgICBtc0FwaVJlcXVlc3RRdWV1ZS5wdXNoKHRhc2spO1xuICAgICAgICAgICAgICAgICAgICBtc0FwaVB1bXBRdWV1ZSgpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZpbmlzaCh0YXNrLm9uRXJyb3IsIGVycm9yKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBvbmVycm9yOiAoKSA9PiBmaW5pc2godGFzay5vbkVycm9yLCBuZXcgRXJyb3IoJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCAoYXBpLm1veXNrbGFkLnJ1KScpKSxcbiAgICAgICAgICAgIG9udGltZW91dDogKCkgPT4gZmluaXNoKHRhc2sub25FcnJvciwgbmV3IEVycm9yKCfQotCw0LnQvNCw0YPRgiDQt9Cw0L/RgNC+0YHQsCDQuiBhcGkubW95c2tsYWQucnUnKSksXG4gICAgICAgICAgICBvbmFib3J0OiAoKSA9PiBmaW5pc2godGFzay5vbkVycm9yLCBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKSlcbiAgICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZmluaXNoKHRhc2sub25FcnJvciwgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gbXNBcGkobWV0aG9kLCBwYXRoLCBib2R5LCBvblN1Y2Nlc3MsIG9uRXJyb3IsIG9wdGlvbnMgPSB7fSkge1xuICAgIHRyeSB7IGhhY2tlckVuc3VyZUJlYXJlcigpOyB9XG4gICAgY2F0Y2ggKGVycm9yKSB7IG9uRXJyb3IoZXJyb3IpOyByZXR1cm47IH1cbiAgICBjb25zdCB0YXNrID0geyBtZXRob2Q6IG1ldGhvZC50b1VwcGVyQ2FzZSgpLCBwYXRoLCBib2R5LCBvblN1Y2Nlc3MsIG9uRXJyb3IsXG4gICAgICAgIHRva2VuOiBoYWNrZXJCZWFyZXJUb2tlbi50cmltKCksIGdlbmVyYXRpb246IG1zQXBpR2VuZXJhdGlvbiwgc2lnbmFsOiBvcHRpb25zLnNpZ25hbCwgY2FuY2VsOiBudWxsLCBhdHRlbXB0OiAwIH07XG4gICAgY29uc3QgY2FuY2VsID0gKCkgPT4gdGFzay5jYW5jZWwoKTtcbiAgICB0YXNrLmNhbmNlbCA9ICgpID0+IHtcbiAgICAgICAgY29uc3QgaW5kZXggPSBtc0FwaVJlcXVlc3RRdWV1ZS5pbmRleE9mKHRhc2spO1xuICAgICAgICBpZiAoaW5kZXggPj0gMCkgbXNBcGlSZXF1ZXN0UXVldWUuc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgbXNBcGlUYXNrcy5kZWxldGUodGFzayk7XG4gICAgICAgIHRhc2suc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbCk7XG4gICAgICAgIG9uRXJyb3IobmV3IEVycm9yKCfQl9Cw0L/RgNC+0YEg0LogYXBpLm1veXNrbGFkLnJ1INC+0YLQvNC10L3RkdC9JykpO1xuICAgIH07XG4gICAgLy8gS2VlcCB0aGUgbGlzdGVuZXIgaWRlbnRpdHkgc3RhYmxlIHdoZW4gcXVldWVkIGNhbmNlbGxhdGlvbiBiZWNvbWVzIGFjdGl2ZS5cbiAgICB0YXNrLmFib3J0TGlzdGVuZXIgPSBjYW5jZWw7XG4gICAgdGFzay5jYW5jZWxRdWV1ZWQgPSB0YXNrLmNhbmNlbDtcbiAgICBpZiAodGFzay5zaWduYWw/LmFib3J0ZWQpIHsgdGFzay5jYW5jZWwoKTsgcmV0dXJuOyB9XG4gICAgdGFzay5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgbXNBcGlUYXNrcy5hZGQodGFzayk7XG4gICAgbXNBcGlSZXF1ZXN0UXVldWUucHVzaCh0YXNrKTtcbiAgICBtc0FwaVB1bXBRdWV1ZSgpO1xufVxuXG5mdW5jdGlvbiBtc0FwaVAobWV0aG9kLCBwYXRoLCBib2R5LCBvcHRpb25zKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IG1zQXBpKG1ldGhvZCwgcGF0aCwgYm9keSwgcmVzb2x2ZSwgcmVqZWN0LCBvcHRpb25zKSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQmtC+0L3RgdC+0LvRjC3Qu9C+0LMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBoYWNrZXJMb2cobXNnLCBraW5kLCBvcmdhbml6YXRpb25OYW1lID0gJycpIHtcbiAgICBoYWNrZXJMb2dMaW5lcy5wdXNoKHsgdGltZTogbmV3IERhdGUoKSwgbXNnOiBTdHJpbmcobXNnKSwga2luZDoga2luZCB8fCAnaW5mbycsIG9yZ2FuaXphdGlvbk5hbWUgfSk7XG4gICAgaWYgKGhhY2tlckxvZ0xpbmVzLmxlbmd0aCA+IDMwMCkgaGFja2VyTG9nTGluZXMuc2hpZnQoKTtcbiAgICBoYWNrZXJSZW5kZXJMb2coKTtcbiAgICBoYWNrZXJSZW5kZXJGbG9hdGluZ0xvZygpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJSZW5kZXJGbG9hdGluZ0xvZygpIHtcbiAgICBjb25zdCBib3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNIYWNrZXJGbG9hdGluZ0xvZycpO1xuICAgIGlmICghYm94KSByZXR1cm47XG4gICAgY29uc3QgYm9keSA9IGJveC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1oYWNrZXItZmxvYXRpbmctYm9keV0nKTtcbiAgICBpZiAoIWJvZHkpIHJldHVybjtcbiAgICBib2R5LnRleHRDb250ZW50ID0gJyc7XG4gICAgaGFja2VyTG9nTGluZXMuc2xpY2UoLTgpLmZvckVhY2goZW50cnkgPT4ge1xuICAgICAgICBjb25zdCB0ID0gZW50cnkudGltZS50b1RpbWVTdHJpbmcoKS5zbGljZSgwLCA4KTtcbiAgICAgICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBsaW5lLnRleHRDb250ZW50ID0gYFske3R9XSAke2VudHJ5Lm1zZ31gO1xuICAgICAgICBpZiAoZW50cnkub3JnYW5pemF0aW9uTmFtZSkgbGluZS5hcHBlbmRDaGlsZChoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbkxhYmVsKGVudHJ5Lm9yZ2FuaXphdGlvbk5hbWUpKTtcbiAgICAgICAgYm9keS5hcHBlbmRDaGlsZChsaW5lKTtcbiAgICB9KTtcbiAgICBib2R5LnNjcm9sbFRvcCA9IGJvZHkuc2Nyb2xsSGVpZ2h0O1xufVxuXG5mdW5jdGlvbiBoYWNrZXJFbnN1cmVGbG9hdGluZ0xvZygpIHtcbiAgICBsZXQgYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSGFja2VyRmxvYXRpbmdMb2cnKTtcbiAgICBpZiAoYm94KSByZXR1cm4gYm94O1xuICAgIGJveCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGJveC5pZCA9ICdtY0hhY2tlckZsb2F0aW5nTG9nJztcbiAgICBib3guc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjpmaXhlZDtyaWdodDoxMnB4O2JvdHRvbToxMnB4O3otaW5kZXg6MjE0NzQ4MzAwMjt3aWR0aDozMTBweDtiYWNrZ3JvdW5kOiMwZjE3MmE7Y29sb3I6I2NiZDVlMTtib3JkZXI6MXB4IHNvbGlkICM0NzU1Njk7Ym9yZGVyLXJhZGl1czo5cHg7Ym94LXNoYWRvdzowIDhweCAzMHB4ICMwMDA1O2ZvbnQ6MTBweCBDb25zb2xhcyxtb25vc3BhY2U7JztcbiAgICBjb25zdCBoZWFkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaGVhZC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7cGFkZGluZzo2cHggOHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkICMzMzQxNTU7Y29sb3I6I2Y4ZmFmYztmb250OjYwMCAxMXB4IFNlZ29lIFVJLHNhbnMtc2VyaWY7JztcbiAgICBoZWFkLnRleHRDb250ZW50ID0gJ9Cl0LDRgtC40LrQvtCl0LDQutC10YAg4oCUINGB0YLQsNGC0YPRgSc7XG4gICAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgY2xvc2UudGV4dENvbnRlbnQgPSAn4pyVJzsgY2xvc2Uuc3R5bGUuY3NzVGV4dCA9ICdib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNjYmQ1ZTE7Y3Vyc29yOnBvaW50ZXI7JzsgY2xvc2Uub25jbGljayA9ICgpID0+IGJveC5yZW1vdmUoKTtcbiAgICBoZWFkLmFwcGVuZENoaWxkKGNsb3NlKTsgYm94LmFwcGVuZENoaWxkKGhlYWQpO1xuICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwcmUnKTsgYm9keS5kYXRhc2V0LmhhY2tlckZsb2F0aW5nQm9keSA9ICcxJzsgYm9keS5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbjowO3BhZGRpbmc6N3B4IDhweDtoZWlnaHQ6MTAwcHg7b3ZlcmZsb3c6YXV0bzt3aGl0ZS1zcGFjZTpwcmUtd3JhcDsnO1xuICAgIGJveC5hcHBlbmRDaGlsZChib2R5KTsgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChib3gpOyBoYWNrZXJSZW5kZXJGbG9hdGluZ0xvZygpOyByZXR1cm4gYm94O1xufVxuXG5mdW5jdGlvbiBoYWNrZXJSZW5kZXJMb2coKSB7XG4gICAgY29uc3QgYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckxvZ0JveCcpO1xuICAgIGlmICghYm94KSByZXR1cm47XG4gICAgYm94LmlubmVySFRNTCA9ICcnO1xuICAgIGNvbnN0IGNvbG9ycyA9IHsgaW5mbzogJyM5NGEzYjgnLCBvazogJyM0YWRlODAnLCBlcnI6ICcjZjg3MTcxJywgd2FybjogJyNmYmJmMjQnIH07XG4gICAgaGFja2VyTG9nTGluZXMuZm9yRWFjaChlbnRyeSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgY29uc3QgdCA9IGVudHJ5LnRpbWUudG9UaW1lU3RyaW5nKCkuc2xpY2UoMCwgOCk7XG4gICAgICAgIGxpbmUuc3R5bGUuY3NzVGV4dCA9ICd3aGl0ZS1zcGFjZTpwcmUtd3JhcDt3b3JkLWJyZWFrOmJyZWFrLXdvcmQ7JztcbiAgICAgICAgbGluZS5zdHlsZS5jb2xvciA9IGNvbG9yc1tlbnRyeS5raW5kXSB8fCBjb2xvcnMuaW5mbztcbiAgICAgICAgbGluZS50ZXh0Q29udGVudCA9IGBbJHt0fV0gJHtlbnRyeS5tc2d9YDtcbiAgICAgICAgaWYgKGVudHJ5Lm9yZ2FuaXphdGlvbk5hbWUpIGxpbmUuYXBwZW5kQ2hpbGQoaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25MYWJlbChlbnRyeS5vcmdhbml6YXRpb25OYW1lKSk7XG4gICAgICAgIGJveC5hcHBlbmRDaGlsZChsaW5lKTtcbiAgICB9KTtcbiAgICBib3guc2Nyb2xsVG9wID0gYm94LnNjcm9sbEhlaWdodDtcbn1cblxuLy8g4pSA4pSA4pSAINCS0YHQv9C+0LzQvtCz0LDRgtC10LvRjNC90YvQtSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCe0YLQutGA0YvRgtCw0Y8g0LrQsNGA0YLQvtGH0LrQsDog0LfQsNC60LDQtyDQv9C+0LrRg9C/0LDRgtC10LvRjyDQuNC70Lgg0L7RgtCz0YDRg9C30LrQsFxuZnVuY3Rpb24gaGFja2VyT3BlbkRvYygpIHtcbiAgICBjb25zdCBtID0gKGxvY2F0aW9uLmhhc2ggfHwgJycpLm1hdGNoKC9eIyhjdXN0b21lcm9yZGVyfGRlbWFuZClcXC9lZGl0XFw/aWQ9KFswLTlhLWZBLUYtXSspLyk7XG4gICAgcmV0dXJuIG0gPyB7IHR5cGU6IG1bMV0sIGlkOiBtWzJdIH0gOiBudWxsO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJFbCh0YWcsIGNzcywgdGV4dCkge1xuICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICAgIGlmIChjc3MpIGVsLnN0eWxlLmNzc1RleHQgPSBjc3M7XG4gICAgaWYgKHRleHQgIT09IHVuZGVmaW5lZCkgZWwudGV4dENvbnRlbnQgPSB0ZXh0O1xuICAgIHJldHVybiBlbDtcbn1cblxuZnVuY3Rpb24gaGFja2VyQnRuKGlkLCBsYWJlbCwgY3NzKSB7XG4gICAgY29uc3QgYiA9IGhhY2tlckVsKCdidXR0b24nLCBjc3MgfHwgJycsIGxhYmVsKTtcbiAgICBiLnR5cGUgPSAnYnV0dG9uJztcbiAgICBiLmlkID0gaWQ7XG4gICAgcmV0dXJuIGI7XG59XG5cbmNvbnN0IEhBQ0tFUl9TRUxFQ1RfQ1NTID0gJ2ZsZXg6MTtwYWRkaW5nOjRweCA2cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTsnXG4gICAgKyAnYm9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDtvdXRsaW5lOm5vbmU7bWluLXdpZHRoOjA7JztcbmNvbnN0IEhBQ0tFUl9JTlBVVF9DU1MgPSAnd2lkdGg6MTAwJTtwYWRkaW5nOjRweCA3cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTsnXG4gICAgKyAnYm9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTEuNXB4O291dGxpbmU6bm9uZTtib3gtc2l6aW5nOmJvcmRlci1ib3g7JztcbmNvbnN0IEhBQ0tFUl9CVE5fQ1NTID0gJ3BhZGRpbmc6NXB4IDEwcHg7Ym9yZGVyOm5vbmU7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6I2ZmZjtmb250LXNpemU6MTFweDsnXG4gICAgKyAnY3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NjAwO3RyYW5zaXRpb246ZmlsdGVyIC4xNXM7JztcbmNvbnN0IEhBQ0tFUl9NSU5JX0JUTl9DU1MgPSAncGFkZGluZzo0cHggOHB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7J1xuICAgICsgJ2JvcmRlci1yYWRpdXM6N3B4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NzAwOyc7XG5cbmZ1bmN0aW9uIGhhY2tlclNlbGVjdChpZCwgcGxhY2Vob2xkZXIpIHtcbiAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcbiAgICBzZWwuaWQgPSBpZDtcbiAgICBzZWwuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9TRUxFQ1RfQ1NTO1xuICAgIGlmIChwbGFjZWhvbGRlcikge1xuICAgICAgICBjb25zdCBvcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgb3B0LnZhbHVlID0gJyc7XG4gICAgICAgIG9wdC50ZXh0Q29udGVudCA9IHBsYWNlaG9sZGVyO1xuICAgICAgICBzZWwuYXBwZW5kQ2hpbGQob3B0KTtcbiAgICB9XG4gICAgcmV0dXJuIHNlbDtcbn1cblxuZnVuY3Rpb24gaGFja2VyRmlsbFNlbGVjdChzZWwsIGl0ZW1zLCBrZWVwRW1wdHlQbGFjZWhvbGRlcikge1xuICAgIC8vINCe0YLQstC10YIgQVBJINC80L7QttC10YIg0L/RgNC40LnRgtC4INC/0L7RgdC70LUg0L/QtdGA0LXQutC70Y7Rh9C10L3QuNGPINCy0LrQu9Cw0LTQutC4OiDRgdGC0LDRgNGL0Lkgc2VsZWN0INGD0LbQtSDRg9C00LDQu9GR0L0uXG4gICAgaWYgKCFzZWwgfHwgIXNlbC5pc0Nvbm5lY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IHBsYWNlaG9sZGVyID0ga2VlcEVtcHR5UGxhY2Vob2xkZXIgPyBzZWwucXVlcnlTZWxlY3Rvcignb3B0aW9uW3ZhbHVlPVwiXCJdJykgOiBudWxsO1xuICAgIHNlbC5pbm5lckhUTUwgPSAnJztcbiAgICBpZiAocGxhY2Vob2xkZXIpIHNlbC5hcHBlbmRDaGlsZChwbGFjZWhvbGRlcik7XG4gICAgaXRlbXMuZm9yRWFjaChpdGVtID0+IHtcbiAgICAgICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgIG9wdC52YWx1ZSA9IGl0ZW0uaHJlZjtcbiAgICAgICAgb3B0LnRleHRDb250ZW50ID0gaXRlbS5uYW1lO1xuICAgICAgICBzZWwuYXBwZW5kQ2hpbGQob3B0KTtcbiAgICB9KTtcbn1cblxuLy8g4pSA4pSA4pSAINCe0YLQutGA0YvRgtGL0Lkg0LfQsNC60LDQtzog0LfQsNCz0YDRg9C30LrQsCDQuCDQv9GA0LXQtNC30LDQv9C+0LvQvdC10L3QuNC1IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gaGFja2VyTG9hZE9wZW5PcmRlcihxdWlldCkge1xuICAgIGNvbnN0IGRvYyA9IGhhY2tlck9wZW5Eb2MoKTtcbiAgICBpZiAoIWRvYyB8fCBkb2MudHlwZSAhPT0gJ2N1c3RvbWVyb3JkZXInKSB7XG4gICAgICAgIGlmICghcXVpZXQpIGhhY2tlckxvZygn0J7RgtC60YDQvtC50YLQtSDQutCw0YDRgtC+0YfQutGDINC30LDQutCw0LfQsCDQv9C+0LrRg9C/0LDRgtC10LvRjycsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUobnVsbCk7XG4gICAgfVxuICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsICcvZW50aXR5L2N1c3RvbWVyb3JkZXIvJyArIGRvYy5pZCArICc/ZXhwYW5kPXBvc2l0aW9ucy5hc3NvcnRtZW50JylcbiAgICAgICAgLnRoZW4ob3JkZXIgPT4ge1xuICAgICAgICAgICAgaGFja2VyT3JkZXJJbmZvID0gb3JkZXI7XG4gICAgICAgICAgICBoYWNrZXJMb2coYNCX0LDQutCw0LcgJHtvcmRlci5uYW1lfTog0YHRg9C80LzQsCAkeyhvcmRlci5zdW0gLyAxMDApLnRvRml4ZWQoMil9IOKCvSwg0YHRgtCw0YLRg9GBOiAke29yZGVyLnN0YXRlPy5uYW1lIHx8ICfigJQnfWApO1xuICAgICAgICAgICAgLy8g0J/RgNC10LTQt9Cw0L/QvtC70L3QtdC90LjQtSDRgdGD0LzQvCDQuCDQutCw0L3QsNC70LBcbiAgICAgICAgICAgIGNvbnN0IHN1bVN0ciA9IChvcmRlci5zdW0gLyAxMDApLnRvRml4ZWQoMik7XG4gICAgICAgICAgICBbJ2hhY2tlckNhc2hpblN1bScsICdoYWNrZXJQYXlpblN1bSddLmZvckVhY2goaWQgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGlucCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTtcbiAgICAgICAgICAgICAgICBpZiAoaW5wICYmICFpbnAudmFsdWUudHJpbSgpKSBpbnAudmFsdWUgPSBzdW1TdHI7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmIChvcmRlci5zYWxlc0NoYW5uZWwgJiYgb3JkZXIuc2FsZXNDaGFubmVsLm1ldGEpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQ2hhbm5lbFNlbGVjdCcpO1xuICAgICAgICAgICAgICAgIGlmIChzZWwpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgaHJlZiA9IG9yZGVyLnNhbGVzQ2hhbm5lbC5tZXRhLmhyZWY7XG4gICAgICAgICAgICAgICAgICAgIGlmICghWy4uLnNlbC5vcHRpb25zXS5zb21lKG8gPT4gby52YWx1ZSA9PT0gaHJlZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgb3B0LnZhbHVlID0gaHJlZjtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9wdC50ZXh0Q29udGVudCA9IG9yZGVyLnNhbGVzQ2hhbm5lbC5uYW1lIHx8ICco0LrQsNC90LDQuyDQt9Cw0LrQsNC30LApJztcbiAgICAgICAgICAgICAgICAgICAgICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHNlbC52YWx1ZSA9IGhyZWY7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG9yZGVyO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgaGFja2VyTG9nKCfQndC1INGD0LTQsNC70L7RgdGMINC30LDQs9GA0YPQt9C40YLRjCDQt9Cw0LrQsNC3OiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpO1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH0pO1xufVxuXG4vLyDilIDilIDilIAg0JLQutC70LDQtNC60LAgwqvQodGC0LDRgtGD0YHCuyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhhY2tlclJlZnJlc2hTdGF0ZXMocXVpZXQpIHtcbiAgICByZXR1cm4gbXNSZWZlcmVuY2VMb2FkKCdjdXN0b21lcm9yZGVyJywgeyBmb3JjZTogdHJ1ZSB9KVxuICAgICAgICAudGhlbihzdGF0ZXMgPT4ge1xuICAgICAgICAgICAgaGFja2VyRmlsbFNlbGVjdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyU3RhdGVTZWxlY3QnKSwgaGFja2VyU3RhdGVzKTtcbiAgICAgICAgICAgIGlmICghcXVpZXQpIGhhY2tlckxvZyhg0KHRgtCw0YLRg9GB0Ysg0L7QsdC90L7QstC70LXQvdGLOiAke2hhY2tlclN0YXRlcy5sZW5ndGh9INGI0YIuYCwgJ29rJyk7XG4gICAgICAgICAgICByZXR1cm4gc3RhdGVzO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4gaGFja2VyTG9nKCfQodGC0LDRgtGD0YHRizogJyArIGVycm9yLm1lc3NhZ2UsICdlcnInKSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckVuc3VyZVN0YXRlcyhxdWlldCkge1xuICAgIGlmIChtc1JlZmVyZW5jZVNjb3BlIHx8IGhhY2tlclN0YXRlcy5sZW5ndGgpIHtcbiAgICAgICAgaGFja2VyRmlsbFNlbGVjdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyU3RhdGVTZWxlY3QnKSwgaGFja2VyU3RhdGVzKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShoYWNrZXJTdGF0ZXMpO1xuICAgIH1cbiAgICByZXR1cm4gaGFja2VyUmVmcmVzaFN0YXRlcyhxdWlldCkudGhlbigoKSA9PiBoYWNrZXJTdGF0ZXMpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJVcGRhdGVPcmRlclN0YXR1cyhvcmRlcklkLCBzdGF0ZUhyZWYpIHtcbiAgICBoYWNrZXJFbnN1cmVCZWFyZXIoKTtcbiAgICByZXR1cm4gbXNBcGlQKCdQVVQnLCBgL2VudGl0eS9jdXN0b21lcm9yZGVyLyR7b3JkZXJJZH1gLCB7XG4gICAgICAgIHN0YXRlOiB7IG1ldGE6IHsgaHJlZjogc3RhdGVIcmVmLCB0eXBlOiAnc3RhdGUnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyB9IH0sXG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckFwcGx5U3RhdHVzKCkge1xuICAgIGNvbnN0IGRvYyA9IGhhY2tlck9wZW5Eb2MoKTtcbiAgICBpZiAoIWRvYyB8fCBkb2MudHlwZSAhPT0gJ2N1c3RvbWVyb3JkZXInKSB7XG4gICAgICAgIGhhY2tlckxvZygn0J7RgtC60YDQvtC50YLQtSDQutCw0YDRgtC+0YfQutGDINC30LDQutCw0LfQsCDQv9C+0LrRg9C/0LDRgtC10LvRjycsICd3YXJuJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclN0YXRlU2VsZWN0Jyk7XG4gICAgY29uc3QgaHJlZiA9IHNlbCA/IHNlbC52YWx1ZSA6ICcnO1xuICAgIGlmICghaHJlZikge1xuICAgICAgICBoYWNrZXJMb2coJ9CS0YvQsdC10YDQuNGC0LUg0YHRgtCw0YLRg9GBICjQuNC70Lgg0L7QsdC90L7QstC40YLQtSDRgdC/0LjRgdC+0LopJywgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzdGF0ZU5hbWUgPSBoYWNrZXJTdGF0ZXMuZmluZChzID0+IHMuaHJlZiA9PT0gaHJlZik/Lm5hbWUgfHwgJyc7XG4gICAgbXNBcGkoJ1BVVCcsICcvZW50aXR5L2N1c3RvbWVyb3JkZXIvJyArIGRvYy5pZCwge1xuICAgICAgICBzdGF0ZTogeyBtZXRhOiB7IGhyZWYsIHR5cGU6ICdzdGF0ZScgfSB9XG4gICAgfSwgKCkgPT4ge1xuICAgICAgICBoYWNrZXJMb2coYOKchSDQodGC0LDRgtGD0YEg0LjQt9C80LXQvdGR0L06ICR7c3RhdGVOYW1lfWAsICdvaycpO1xuICAgIH0sIGVycm9yID0+IGhhY2tlckxvZygn0KHRgtCw0YLRg9GBOiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQnVpbGRTdGF0dXNUYWIoKSB7XG4gICAgY29uc3Qgd3JhcCA9IGhhY2tlckVsKCdkaXYnKTtcbiAgICB3cmFwLmlkID0gJ2hhY2tlclRhYlN0YXR1cyc7XG5cbiAgICBjb25zdCByb3cgPSBoYWNrZXJFbCgnZGl2JywgJ2Rpc3BsYXk6ZmxleDtnYXA6NHB4O21hcmdpbi1ib3R0b206NnB4OycpO1xuICAgIHJvdy5hcHBlbmRDaGlsZChoYWNrZXJTZWxlY3QoJ2hhY2tlclN0YXRlU2VsZWN0JywgJ+KAlCDQvtCx0L3QvtCy0LjRgtC1INGB0L/QuNGB0L7QuiDigJQnKSk7XG4gICAgY29uc3QgcmVmcmVzaCA9IGhhY2tlckJ0bignaGFja2VyU3RhdGVzUmVmcmVzaCcsICfin7MnLCBIQUNLRVJfTUlOSV9CVE5fQ1NTKTtcbiAgICByZWZyZXNoLnRpdGxlID0gJ9Ce0LHQvdC+0LLQuNGC0Ywg0YHQv9C40YHQvtC6INGB0YLQsNGC0YPRgdC+0LInO1xuICAgIHJlZnJlc2guYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBoYWNrZXJSZWZyZXNoU3RhdGVzKGZhbHNlKSk7XG4gICAgcm93LmFwcGVuZENoaWxkKHJlZnJlc2gpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQocm93KTtcblxuICAgIGNvbnN0IGFwcGx5ID0gaGFja2VyQnRuKCdoYWNrZXJTdGF0dXNBcHBseScsICfQn9C+0LzQtdC90Y/RgtGMINGB0YLQsNGC0YPRgScsXG4gICAgICAgIEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjM2I4MmY2LCMyNTYzZWIpO3dpZHRoOjEwMCU7Jyk7XG4gICAgYXBwbHkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBoYWNrZXJBcHBseVN0YXR1cyk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChhcHBseSk7XG4gICAgcmV0dXJuIHdyYXA7XG59XG5cbi8vIOKUgOKUgOKUgCDQktC60LvQsNC00LrQsCDCq9Ca0L7QvdGC0YDQsNCz0LXQvdGCwrsg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBoYWNrZXJOb3JtYWxpemVQaG9uZVZhcmlhbnRzKHJhdykge1xuICAgIGNvbnN0IGRpZ2l0cyA9IFN0cmluZyhyYXcgfHwgJycpLnJlcGxhY2UoL1xcRC9nLCAnJyk7XG4gICAgaWYgKCFkaWdpdHMpIHJldHVybiBbXTtcbiAgICBjb25zdCB2YXJpYW50cyA9IFtkaWdpdHNdO1xuICAgIGlmIChkaWdpdHMubGVuZ3RoID09PSAxMSAmJiBkaWdpdHNbMF0gPT09ICc4JykgdmFyaWFudHMucHVzaCgnNycgKyBkaWdpdHMuc2xpY2UoMSkpO1xuICAgIGlmIChkaWdpdHMubGVuZ3RoID09PSAxMSAmJiBkaWdpdHNbMF0gPT09ICc3JykgdmFyaWFudHMucHVzaCgnOCcgKyBkaWdpdHMuc2xpY2UoMSkpO1xuICAgIGlmIChkaWdpdHMubGVuZ3RoID09PSAxMCkgdmFyaWFudHMucHVzaCgnNycgKyBkaWdpdHMpO1xuICAgIHJldHVybiBbLi4ubmV3IFNldCh2YXJpYW50cyldO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJGaW5kQWdlbnRCeVBob25lKHJhdykge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgY29uc3QgdmFyaWFudHMgPSBoYWNrZXJOb3JtYWxpemVQaG9uZVZhcmlhbnRzKHJhdyk7XG4gICAgaWYgKCF2YXJpYW50cy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign0JLQstC10LTQuNGC0LUg0L3QvtC80LXRgCDRgtC10LvQtdGE0L7QvdCwJyk7XG4gICAgZm9yIChjb25zdCBwaG9uZSBvZiB2YXJpYW50cykge1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG1zQXBpUCgnR0VUJywgJy9lbnRpdHkvY291bnRlcnBhcnR5P2ZpbHRlcj1waG9uZT0nICsgcGhvbmUpO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRhdGE/LnJvd3MpIHx8IGRhdGEuZXJyb3JzPy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign0J/RgNC+0LLQtdGA0LrQsCDQutC+0L3RgtGA0LDQs9C10L3RgtCwINC90LUg0LLRi9C/0L7Qu9C90LXQvdCwOiDQvdC10L/QvtC70L3Ri9C5INC+0YLQstC10YInKTtcbiAgICAgICAgaWYgKGRhdGEucm93cy5sZW5ndGgpIHJldHVybiBkYXRhLnJvd3M7XG4gICAgICAgIC8vIEFuIGVtcHR5IHBhZ2UgaXMgbm90IHByb29mIG9mIGFic2VuY2Ugd2hlbiB0aGUgc2VydmVyIGFkdmVydGlzZXMgbW9yZSBkYXRhLlxuICAgICAgICBpZiAoZGF0YS5tZXRhPy5zaXplID4gMCB8fCBkYXRhLm1ldGE/Lm5leHRIcmVmIHx8IGRhdGEubWV0YT8ub2Zmc2V0ID4gMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfQn9GA0L7QstC10YDQutCwINC60L7QvdGC0YDQsNCz0LXQvdGC0LAg0L3QtSDQstGL0L/QvtC70L3QtdC90LA6INC90LXQv9C+0LvQvdGL0Lkg0L/QvtC40YHQuicpO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbXTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQ3JlYXRlQWdlbnQobmFtZSwgcGhvbmUpIHtcbiAgICByZXR1cm4gbXNBcGlQKCdQT1NUJywgJy9lbnRpdHkvY291bnRlcnBhcnR5JywgeyBuYW1lLCBwaG9uZSB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQXNzaWduQWdlbnQoYWdlbnRIcmVmKSB7XG4gICAgY29uc3QgZG9jID0gaGFja2VyT3BlbkRvYygpO1xuICAgIGlmICghZG9jKSB7XG4gICAgICAgIGhhY2tlckxvZygn0J7RgtC60YDQvtC50YLQtSDQutCw0YDRgtC+0YfQutGDINC30LDQutCw0LfQsCDQuNC70Lgg0L7RgtCz0YDRg9C30LrQuCcsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoJ9C90LXRgiDQvtGC0LrRgNGL0YLQvtCz0L4g0LTQvtC60YPQvNC10L3RgtCwJykpO1xuICAgIH1cbiAgICByZXR1cm4gbXNBcGlQKCdQVVQnLCAnL2VudGl0eS8nICsgZG9jLnR5cGUgKyAnLycgKyBkb2MuaWQsIHtcbiAgICAgICAgYWdlbnQ6IHtcbiAgICAgICAgICAgIG1ldGE6IHtcbiAgICAgICAgICAgICAgICBocmVmOiBhZ2VudEhyZWYsXG4gICAgICAgICAgICAgICAgdHlwZTogJ2NvdW50ZXJwYXJ0eScsXG4gICAgICAgICAgICAgICAgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24vanNvbidcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0pO1xufVxuXG5sZXQgaGFja2VyQWdlbnRDcmVhdGVQZW5kaW5nID0gZmFsc2U7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckFnZW50Q3JlYXRlQ2xpY2sob3B0aW9ucyA9IHt9KSB7XG4gICAgaWYgKGhhY2tlckFnZW50Q3JlYXRlUGVuZGluZykgcmV0dXJuO1xuICAgIGNvbnN0IHBob25lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFnZW50UGhvbmUnKT8udmFsdWUudHJpbSgpO1xuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQWdlbnROYW1lJyk/LnZhbHVlLnRyaW0oKTtcbiAgICBjb25zdCBjaGVja0ZpcnN0ID0gb3B0aW9ucy5jaGVja0ZpcnN0ID09PSB0cnVlIHx8IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJBZ2VudENoZWNrQ3JlYXRlJyk/LmNoZWNrZWQ7XG4gICAgaWYgKCFwaG9uZSkgeyBoYWNrZXJMb2coJ9CS0LLQtdC00LjRgtC1INC90L7QvNC10YAg0YLQtdC70LXRhNC+0L3QsCcsICd3YXJuJyk7IHJldHVybjsgfVxuICAgIGlmICghbmFtZSkgeyBoYWNrZXJMb2coJ9CS0LLQtdC00LjRgtC1INCk0JjQniAo0L3QsNC40LzQtdC90L7QstCw0L3QuNC1INC60L7QvdGC0YDQsNCz0LXQvdGC0LApJywgJ3dhcm4nKTsgcmV0dXJuOyB9XG5cbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIGhhY2tlckFnZW50Q3JlYXRlUGVuZGluZyA9IHRydWU7XG4gICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFnZW50Q3JlYXRlJyk7XG4gICAgaWYgKGJ1dHRvbikgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICBsZXQgY2hlY2tpbmcgPSAhIWNoZWNrRmlyc3Q7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGNoZWNrRmlyc3QpIHtcbiAgICAgICAgICAgIGhhY2tlckxvZygn0JjRidGDINC60L7QvdGC0YDQsNCz0LXQvdGC0LAg0L/QviDQvdC+0LzQtdGA0YPigKYnKTtcbiAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBhd2FpdCBoYWNrZXJGaW5kQWdlbnRCeVBob25lKHBob25lKTtcbiAgICAgICAgICAgIGlmIChyb3dzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGEgPSByb3dzWzBdO1xuICAgICAgICAgICAgICAgIGhhY2tlckxvZyhg0J3QsNC50LTQtdC9OiAke2EubmFtZX0gKNGC0LXQu9C10YTQvtC9ICR7YS5waG9uZSB8fCAn4oCUJ30pYCwgJ3dhcm4nKTtcbiAgICAgICAgICAgICAgICBoYWNrZXJMb2coJ9Ch0L7Qt9C00LDQvdC40LUg0L3QtSDRgtGA0LXQsdGD0LXRgtGB0Y8nLCAnaW5mbycpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjaGVja2luZyA9IGZhbHNlO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgY29uc3QgYWdlbnQgPSBhd2FpdCBoYWNrZXJDcmVhdGVBZ2VudChuYW1lLCBwaG9uZSk7XG4gICAgICAgIGhhY2tlckxvZyhg4pyFINCa0L7QvdGC0YDQsNCz0LXQvdGCINGB0L7Qt9C00LDQvTogJHthZ2VudC5uYW1lfWAsICdvaycpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGhhY2tlckxvZygoY2hlY2tpbmcgPyAn0J/RgNC+0LLQtdGA0LrQsCDQvdC1INCy0YvQv9C+0LvQvdC10L3QsCwg0YHQvtC30LTQsNC90LjQtSDQvtGC0LzQtdC90LXQvdC+OiAnIDogJ9Ch0L7Qt9C00LDQvdC40LU6ICcpICsgZXJyb3IubWVzc2FnZSwgJ2VycicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGhhY2tlckFnZW50Q3JlYXRlUGVuZGluZyA9IGZhbHNlO1xuICAgICAgICBpZiAoYnV0dG9uKSBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJBZ2VudENyZWF0ZScpO1xuICAgICAgICBpZiAoY3VycmVudCkgY3VycmVudC5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyQWdlbnRDaGVja0NsaWNrKCkge1xuICAgIGNvbnN0IHBob25lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFnZW50UGhvbmUnKT8udmFsdWUudHJpbSgpO1xuICAgIGlmICghcGhvbmUpIHsgaGFja2VyTG9nKCfQktCy0LXQtNC40YLQtSDQvdC+0LzQtdGAINGC0LXQu9C10YTQvtC90LAnLCAnd2FybicpOyByZXR1cm47IH1cbiAgICBoYWNrZXJMb2coJ9Cf0YDQvtCy0LXRgNGP0Y4g0LrQvtC90YLRgNCw0LPQtdC90YLQsCDQv9C+INC90L7QvNC10YDRg+KApicpO1xuICAgIGhhY2tlckZpbmRBZ2VudEJ5UGhvbmUocGhvbmUpLnRoZW4ocm93cyA9PiB7XG4gICAgICAgIGlmICghcm93cy5sZW5ndGgpIHtcbiAgICAgICAgICAgIGhhY2tlckxvZygn0JrQvtC90YLRgNCw0LPQtdC90YIg0L/QviDRjdGC0L7QvNGDINC90L7QvNC10YDRgyDQvdC1INC90LDQudC00LXQvScsICd3YXJuJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcm93cy5mb3JFYWNoKChhZ2VudCwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgIGhhY2tlckxvZyhg0J3QsNC50LTQtdC9ICR7aW5kZXggKyAxfTogJHthZ2VudC5uYW1lIHx8ICfQsdC10Lcg0LjQvNC10L3QuCd9IOKAlCAke2FnZW50LnBob25lIHx8IHBob25lfWAsICdvaycpO1xuICAgICAgICB9KTtcbiAgICB9KS5jYXRjaChlcnJvciA9PiBoYWNrZXJMb2coJ9Cf0YDQvtCy0LXRgNC60LA6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJykpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJBZ2VudEFzc2lnbkNsaWNrKCkge1xuICAgIGNvbnN0IHBob25lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFnZW50UGhvbmUnKT8udmFsdWUudHJpbSgpO1xuICAgIGlmICghcGhvbmUpIHsgaGFja2VyTG9nKCfQktCy0LXQtNC40YLQtSDQvdC+0LzQtdGAINGC0LXQu9C10YTQvtC90LAnLCAnd2FybicpOyByZXR1cm47IH1cbiAgICByZXR1cm4gaGFja2VyRmluZEFnZW50QnlQaG9uZShwaG9uZSkudGhlbihyb3dzID0+IHtcbiAgICAgICAgaWYgKCFyb3dzLmxlbmd0aCkge1xuICAgICAgICAgICAgaGFja2VyTG9nKCfQmtC+0L3RgtGA0LDQs9C10L3RgiDQv9C+INGN0YLQvtC80YMg0L3QvtC80LXRgNGDINC90LUg0L3QsNC50LTQtdC9JywgJ2VycicpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGEgPSByb3dzWzBdO1xuICAgICAgICByZXR1cm4gaGFja2VyQXNzaWduQWdlbnQoYS5tZXRhLmhyZWYpXG4gICAgICAgICAgICAudGhlbigoKSA9PiBoYWNrZXJMb2coYOKchSDQmtC+0L3RgtGA0LDQs9C10L3RgiDQt9Cw0LzQtdC90ZHQvTogJHthLm5hbWV9YCwgJ29rJykpO1xuICAgIH0pLmNhdGNoKGVycm9yID0+IGhhY2tlckxvZygn0JfQsNC80LXQvdCwOiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQnVpbGRBZ2VudFRhYigpIHtcbiAgICBjb25zdCB3cmFwID0gaGFja2VyRWwoJ2RpdicpO1xuICAgIHdyYXAuaWQgPSAnaGFja2VyVGFiU3RhdHVzX0FnZW50JztcblxuICAgIGNvbnN0IGxibFBob25lID0gaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTBweDtmb250LXdlaWdodDo3MDA7Y29sb3I6IzY0NzQ4YjttYXJnaW4tYm90dG9tOjNweDsnLCAn0J3QvtC80LXRgCDRgtC10LvQtdGE0L7QvdCwJyk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChsYmxQaG9uZSk7XG4gICAgY29uc3QgcGhvbmUgPSBoYWNrZXJFbCgnaW5wdXQnKTtcbiAgICBwaG9uZS5pZCA9ICdoYWNrZXJBZ2VudFBob25lJztcbiAgICBwaG9uZS50eXBlID0gJ3RleHQnO1xuICAgIHBob25lLnBsYWNlaG9sZGVyID0gJys3IDkwMCAwMDAtMDAtMDAnO1xuICAgIHBob25lLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfSU5QVVRfQ1NTICsgJ21hcmdpbi1ib3R0b206NnB4Oyc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChwaG9uZSk7XG5cbiAgICBjb25zdCBsYmxOYW1lID0gaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTBweDtmb250LXdlaWdodDo3MDA7Y29sb3I6IzY0NzQ4YjttYXJnaW4tYm90dG9tOjNweDsnLCAn0KTQmNCeICjQvdCw0LjQvNC10L3QvtCy0LDQvdC40LUpJyk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChsYmxOYW1lKTtcbiAgICBjb25zdCBuYW1lID0gaGFja2VyRWwoJ2lucHV0Jyk7XG4gICAgbmFtZS5pZCA9ICdoYWNrZXJBZ2VudE5hbWUnO1xuICAgIG5hbWUudHlwZSA9ICd0ZXh0JztcbiAgICBuYW1lLnBsYWNlaG9sZGVyID0gJ9CY0LLQsNC90L7QsiDQmNCy0LDQvSDQmNCy0LDQvdC+0LLQuNGHJztcbiAgICBuYW1lLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfSU5QVVRfQ1NTICsgJ21hcmdpbi1ib3R0b206NnB4Oyc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChuYW1lKTtcblxuICAgIGNvbnN0IHJvdyA9IGhhY2tlckVsKCdkaXYnLCAnZGlzcGxheTpmbGV4O2dhcDo1cHg7bWFyZ2luLWJvdHRvbTo4cHg7Jyk7XG4gICAgY29uc3QgY2hlY2sgPSBoYWNrZXJCdG4oJ2hhY2tlckFnZW50Q2hlY2snLCAn0J/RgNC+0LLQtdGA0LjRgtGMJyxcbiAgICAgICAgSEFDS0VSX0JUTl9DU1MgKyAnYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM2NDc0OGIsIzQ3NTU2OSk7ZmxleDoxOycpO1xuICAgIGNoZWNrLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaGFja2VyQWdlbnRDaGVja0NsaWNrKTtcbiAgICBjb25zdCBhc3NpZ24gPSBoYWNrZXJCdG4oJ2hhY2tlckFnZW50QXNzaWduJywgJ9Cf0L7QvNC10L3Rj9GC0YwnLFxuICAgICAgICBIQUNLRVJfQlROX0NTUyArICdiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzNiODJmNiwjMjU2M2ViKTtmbGV4OjE7Jyk7XG4gICAgYXNzaWduLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaGFja2VyQWdlbnRBc3NpZ25DbGljayk7XG4gICAgY29uc3QgY3JlYXRlID0gaGFja2VyQnRuKCdoYWNrZXJBZ2VudENyZWF0ZScsICfQodC+0LfQtNCw0YLRjCcsXG4gICAgICAgIEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMjJjNTVlLCMxNmEzNGEpO2ZsZXg6MTsnKTtcbiAgICBjcmVhdGUuZGlzYWJsZWQgPSBoYWNrZXJBZ2VudENyZWF0ZVBlbmRpbmc7XG4gICAgY3JlYXRlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaGFja2VyQWdlbnRDcmVhdGVDbGljayk7XG4gICAgcm93LmFwcGVuZENoaWxkKGNoZWNrKTtcbiAgICByb3cuYXBwZW5kQ2hpbGQoYXNzaWduKTtcbiAgICByb3cuYXBwZW5kQ2hpbGQoY3JlYXRlKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHJvdyk7XG5cbiAgICBjb25zdCBta0NoZWNrID0gKGlkLCBsYWJlbCkgPT4ge1xuICAgICAgICBjb25zdCBsYmwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjExcHg7bWFyZ2luLWJvdHRvbTo1cHg7Y3Vyc29yOnBvaW50ZXI7Jyk7XG4gICAgICAgIGNvbnN0IGNiID0gaGFja2VyRWwoJ2lucHV0Jyk7XG4gICAgICAgIGNiLnR5cGUgPSAnY2hlY2tib3gnO1xuICAgICAgICBjYi5pZCA9IGlkO1xuICAgICAgICBjYi5zdHlsZS5jc3NUZXh0ID0gJ2FjY2VudC1jb2xvcjojNjM2NmYxO3dpZHRoOjEzcHg7aGVpZ2h0OjEzcHg7JztcbiAgICAgICAgbGJsLmFwcGVuZENoaWxkKGNiKTtcbiAgICAgICAgbGJsLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKGxhYmVsKSk7XG4gICAgICAgIHJldHVybiBsYmw7XG4gICAgfTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKG1rQ2hlY2soJ2hhY2tlckFnZW50Q2hlY2tDcmVhdGUnLCAn0J/RgNC+0LLQtdGA0LjRgtGMINC4INC10YHQu9C4INC90LXRgiDigJQg0YHQvtC30LTQsNGC0YwnKSk7XG4gICAgcmV0dXJuIHdyYXA7XG59XG5cbi8vIOKUgOKUgOKUgCDQntCx0YnQuNC1INGB0L/RgNCw0LLQvtGH0L3QuNC60Lgg0LggaGVscGVycyDRgNGD0YfQvdC+0LPQviDRgdC+0LfQtNCw0L3QuNGPINC00L7QutGD0LzQtdC90YLQvtCyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gaGFja2VyQXBpUGF0aChocmVmKSB7XG4gICAgaWYgKCFocmVmKSByZXR1cm4gJyc7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBTdHJpbmcoaHJlZik7XG4gICAgICAgIGNvbnN0IHVybCA9IG5ldyBVUkwodmFsdWUuc3RhcnRzV2l0aCgnLycpID8gTVNfQVBJX0JBU0UgKyB2YWx1ZSA6IHZhbHVlLCBNU19BUElfQkFTRSArICcvJyk7XG4gICAgICAgIGNvbnN0IGJhc2UgPSBuZXcgVVJMKE1TX0FQSV9CQVNFKTtcbiAgICAgICAgaWYgKHVybC5vcmlnaW4gIT09IGJhc2Uub3JpZ2luIHx8ICF1cmwucGF0aG5hbWUuc3RhcnRzV2l0aChiYXNlLnBhdGhuYW1lICsgJy8nKSkgcmV0dXJuICcnO1xuICAgICAgICByZXR1cm4gdXJsLnBhdGhuYW1lLnNsaWNlKGJhc2UucGF0aG5hbWUubGVuZ3RoKSArIHVybC5zZWFyY2g7XG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJNZXRhUmVmKGhyZWYsIHR5cGUpIHtcbiAgICByZXR1cm4geyBocmVmLCB0eXBlLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyB9O1xufVxuXG5mdW5jdGlvbiBoYWNrZXJJc0R1cGxpY2F0ZU5hbWVFcnJvcihlcnJvcikge1xuICAgIHJldHVybiAv0LjQvNGPfNC90LDQt9Cy0LDQvXzQtNGD0LHQu9C40LrQsNGCfNGD0LbQtSDRgdGD0YnQtdGB0YLQstGD0LXRgnzQt9Cw0L3Rj9GCfGR1cGxpY2F0ZXxuYW1lL2kudGVzdChTdHJpbmcoZXJyb3I/Lm1lc3NhZ2UgfHwgZXJyb3IpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyUG9zdFdpdGhOYW1lUmV0cnkoZW50aXR5VHlwZSwgYm9keSwgYmFzZU5hbWUsIG1heEF0dGVtcHRzID0gMTApIHtcbiAgICBsZXQgbGFzdEVycm9yO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbWF4QXR0ZW1wdHM7IGkgKz0gMSkge1xuICAgICAgICBjb25zdCBuYW1lID0gaSA9PT0gMCA/IGJhc2VOYW1lIDogYCR7YmFzZU5hbWV9LSR7aX1gO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IG1zQXBpUCgnUE9TVCcsICcvZW50aXR5LycgKyBlbnRpdHlUeXBlLCB7IC4uLmJvZHksIG5hbWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsYXN0RXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICAgIGlmICghaGFja2VySXNEdXBsaWNhdGVOYW1lRXJyb3IoZXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIGhhY2tlckxvZyhg0JjQvNGPIMKrJHtuYW1lfcK7INC30LDQvdGP0YLQviwg0L/RgNC+0LHRg9GOIMKrJHtiYXNlTmFtZX0tJHtpICsgMX3Cu+KApmAsICd3YXJuJyk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgdGhyb3cgbGFzdEVycm9yIHx8IG5ldyBFcnJvcign0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0LfQtNCw0YLRjCDQtNC+0LrRg9C80LXQvdGCINGBINGD0L3QuNC60LDQu9GM0L3Ri9C8INC40LzQtdC90LXQvCcpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJGZXRjaE1ldGFkYXRhQXR0cmlidXRlKGVudGl0eVR5cGUsIGF0dHJOYW1lKSB7XG4gICAgcmV0dXJuIG1zQXBpUCgnR0VUJywgJy9lbnRpdHkvJyArIGVudGl0eVR5cGUgKyAnL21ldGFkYXRhJykudGhlbihtZXRhID0+IHtcbiAgICAgICAgY29uc3QgaHJlZiA9IG1ldGEuYXR0cmlidXRlcz8ubWV0YT8uaHJlZjtcbiAgICAgICAgaWYgKCFocmVmKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIG1zQXBpUCgnR0VUJywgaGFja2VyQXBpUGF0aChocmVmKSkudGhlbihkYXRhID0+XG4gICAgICAgICAgICAoZGF0YS5yb3dzIHx8IFtdKS5maW5kKGEgPT4gYS5uYW1lID09PSBhdHRyTmFtZSB8fCBuZXcgUmVnRXhwKGF0dHJOYW1lLCAnaScpLnRlc3QoYS5uYW1lIHx8ICcnKSkgfHwgbnVsbFxuICAgICAgICApO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJGZXRjaERlbWFuZENoYW5uZWxBdHRyaWJ1dGUob3JkZXIsIGNoYW5uZWxOYW1lKSB7XG4gICAgY29uc3Qgc291cmNlID0gKEFycmF5LmlzQXJyYXkob3JkZXIuYXR0cmlidXRlcykgPyBvcmRlci5hdHRyaWJ1dGVzIDogKG9yZGVyLmF0dHJpYnV0ZXM/LnJvd3MgfHwgW10pKVxuICAgICAgICAuZmluZChhID0+IC/QutCw0L3QsNC7INC/0YDQvtC00LDQti9pLnRlc3QoYS5uYW1lIHx8ICcnKSk7XG4gICAgcmV0dXJuIGhhY2tlckZldGNoTWV0YWRhdGFBdHRyaWJ1dGUoJ2RlbWFuZCcsICfQmtCw0L3QsNC7INC/0YDQvtC00LDQticpLnRoZW4oYXR0ciA9PiB7XG4gICAgICAgIGlmICghYXR0cj8ubWV0YT8uaHJlZiB8fCAhYXR0ci5jdXN0b21FbnRpdHlNZXRhPy5ocmVmKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIG1zQXBpUCgnR0VUJywgaGFja2VyQXBpUGF0aChhdHRyLmN1c3RvbUVudGl0eU1ldGEuaHJlZikpLnRoZW4oY3VzdG9tTWV0YSA9PiB7XG4gICAgICAgICAgICBjb25zdCB2YWx1ZXNIcmVmID0gY3VzdG9tTWV0YS5lbnRpdHlNZXRhPy5ocmVmO1xuICAgICAgICAgICAgaWYgKCF2YWx1ZXNIcmVmKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsIGhhY2tlckFwaVBhdGgodmFsdWVzSHJlZikpLnRoZW4odmFsdWVzID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByb3dzID0gdmFsdWVzLnJvd3MgfHwgW107XG4gICAgICAgICAgICAgICAgY29uc3Qgd2FudGVkID0gY2hhbm5lbE5hbWUgfHwgc291cmNlPy52YWx1ZT8ubmFtZSB8fCAnJztcbiAgICAgICAgICAgICAgICBjb25zdCBub3JtYWxpemUgPSB2YWx1ZSA9PiBTdHJpbmcodmFsdWUgfHwgJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gcm93cy5maW5kKHJvdyA9PiBub3JtYWxpemUocm93Lm5hbWUpID09PSBub3JtYWxpemUod2FudGVkKSlcbiAgICAgICAgICAgICAgICAgICAgfHwgcm93cy5maW5kKHJvdyA9PiBub3JtYWxpemUocm93Lm5hbWUpLmluY2x1ZGVzKG5vcm1hbGl6ZSh3YW50ZWQpKSB8fCBub3JtYWxpemUod2FudGVkKS5pbmNsdWRlcyhub3JtYWxpemUocm93Lm5hbWUpKSk7XG4gICAgICAgICAgICAgICAgaWYgKCFtYXRjaD8ubWV0YT8uaHJlZikgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgbWV0YTogaGFja2VyTWV0YVJlZihhdHRyLm1ldGEuaHJlZiwgJ2F0dHJpYnV0ZW1ldGFkYXRhJyksXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlOiB7IG1ldGE6IGhhY2tlck1ldGFSZWYobWF0Y2gubWV0YS5ocmVmLCAnY3VzdG9tZW50aXR5JykgfVxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckZldGNoQXR0clZhbHVlcyhlbnRpdHlUeXBlLCBhdHRyTmFtZSkge1xuICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsICcvZW50aXR5LycgKyBlbnRpdHlUeXBlICsgJy9tZXRhZGF0YScpLnRoZW4obWV0YSA9PiB7XG4gICAgICAgIC8vINCSINGA0LXQsNC70YzQvdC+0Lwg0L7RgtCy0LXRgtC1IG1ldGFkYXRhLmF0dHJpYnV0ZXMg4oCUIG1ldGEt0YHRgdGL0LvQutCwLCDQvdC1INC80LDRgdGB0LjQsi5cbiAgICAgICAgY29uc3QgYXR0cnNSZWYgPSBtZXRhLmF0dHJpYnV0ZXM/Lm1ldGE/LmhyZWY7XG4gICAgICAgIGNvbnN0IGF0dHJzUHJvbWlzZSA9IGF0dHJzUmVmXG4gICAgICAgICAgICA/IG1zQXBpUCgnR0VUJywgaGFja2VyQXBpUGF0aChhdHRyc1JlZikpXG4gICAgICAgICAgICA6IFByb21pc2UucmVzb2x2ZShtZXRhLmF0dHJpYnV0ZXMpO1xuICAgICAgICByZXR1cm4gYXR0cnNQcm9taXNlLnRoZW4oYXR0cnNEYXRhID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHJhd0F0dHJzID0gYXR0cnNEYXRhPy5yb3dzIHx8IGF0dHJzRGF0YTtcbiAgICAgICAgICAgIGNvbnN0IGF0dHJzID0gQXJyYXkuaXNBcnJheShyYXdBdHRycylcbiAgICAgICAgICAgICAgICA/IHJhd0F0dHJzXG4gICAgICAgICAgICAgICAgOiAocmF3QXR0cnMgJiYgdHlwZW9mIHJhd0F0dHJzID09PSAnb2JqZWN0JyA/IE9iamVjdC52YWx1ZXMocmF3QXR0cnMpIDogW10pO1xuICAgICAgICAgICAgY29uc3QgYXR0ciA9IGF0dHJzLmZpbmQoYSA9PiBhICYmIGEubmFtZSA9PT0gYXR0ck5hbWUpO1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tTWV0YUhyZWYgPSBhdHRyPy5jdXN0b21FbnRpdHlNZXRhPy5ocmVmO1xuICAgICAgICAgICAgaWYgKCFjdXN0b21NZXRhSHJlZikge1xuICAgICAgICAgICAgICAgIGhhY2tlckxvZyhg0KHQv9GA0LDQstC+0YfQvdC40Logwqske2F0dHJOYW1lfcK7INC90LUg0L3QsNC50LTQtdC9INCyIG1ldGFkYXRhICR7ZW50aXR5VHlwZX1gLCAnd2FybicpO1xuICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIGN1c3RvbUVudGl0eU1ldGEg4oCUINC80LXRgtCw0LTQsNC90L3Ri9C1LiDQl9C90LDRh9C10L3QuNGPINC70LXQttCw0YIg0L/QviBlbnRpdHlNZXRhLmhyZWYuXG4gICAgICAgICAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKGN1c3RvbU1ldGFIcmVmKSkudGhlbihjdXN0b21NZXRhID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZXNIcmVmID0gY3VzdG9tTWV0YS5lbnRpdHlNZXRhPy5ocmVmO1xuICAgICAgICAgICAgICAgIGlmICghdmFsdWVzSHJlZikge1xuICAgICAgICAgICAgICAgICAgICBoYWNrZXJMb2coYNCjINGB0L/RgNCw0LLQvtGH0L3QuNC60LAgwqske2F0dHJOYW1lfcK7INC90LXRgiDRgdGB0YvQu9C60Lgg0L3QsCDQt9C90LDRh9C10L3QuNGPYCwgJ3dhcm4nKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKHZhbHVlc0hyZWYpKS50aGVuKHZhbHVlcyA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJvd3MgPSBBcnJheS5pc0FycmF5KHZhbHVlcykgPyB2YWx1ZXMgOiAodmFsdWVzLnJvd3MgfHwgW10pO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcm93cy5tYXAociA9PiAoeyBuYW1lOiByLm5hbWUsIGhyZWY6IHIubWV0YT8uaHJlZiB9KSlcbiAgICAgICAgICAgICAgICAgICAgICAgIC5maWx0ZXIociA9PiByLmhyZWYpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJSZWZyZXNoQ2FzaFBheVR5cGUoKSB7XG4gICAgcmV0dXJuIGhhY2tlckZldGNoQXR0clZhbHVlcygnY2FzaGluJywgSEFDS0VSX0FUVFJfUEFZX1RZUEUpLnRoZW4oaXRlbXMgPT4ge1xuICAgICAgICBjb25zdCBjYXNoID0gaXRlbXMuZmluZChpdGVtID0+IGl0ZW0ubmFtZSA9PT0gSEFDS0VSX0NBU0hfUEFZX05BTUUgfHwgL9C90LDQu9C40YfQvS9pLnRlc3QoaXRlbS5uYW1lKSk7XG4gICAgICAgIHJldHVybiBjYXNoPy5ocmVmIHx8IG51bGw7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclJlZnJlc2hDbGllbnRTdGF0dXNlcyhxdWlldCkge1xuICAgIHJldHVybiBoYWNrZXJGZXRjaEF0dHJWYWx1ZXMoJ2Nhc2hpbicsIEhBQ0tFUl9BVFRSX0NMSUVOVF9TVEFUVVMpXG4gICAgICAgIC50aGVuKGl0ZW1zID0+IHtcbiAgICAgICAgICAgIGhhY2tlckZpbGxTZWxlY3QoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckNsaWVudFN0YXR1c1NlbGVjdCcpLCBpdGVtcywgdHJ1ZSk7XG4gICAgICAgICAgICBpZiAoIXF1aWV0KSBoYWNrZXJMb2coYMKr0KHRgtCw0YLRg9GBINC60LvQuNC10L3RgtCwwrsg0L7QsdC90L7QstC70ZHQvTogJHtpdGVtcy5sZW5ndGh9INGI0YIuYCwgJ29rJyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiBoYWNrZXJMb2coJ9Ch0YLQsNGC0YPRgSDQutC70LjQtdC90YLQsDogJyArIGVycm9yLm1lc3NhZ2UsICdlcnInKSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclJlZnJlc2hQYXlNZXRob2RzKHF1aWV0KSB7XG4gICAgcmV0dXJuIGhhY2tlckZldGNoQXR0clZhbHVlcygncGF5bWVudGluJywgSEFDS0VSX0FUVFJfUEFZX01FVEhPRClcbiAgICAgICAgLnRoZW4oaXRlbXMgPT4ge1xuICAgICAgICAgICAgaGFja2VyRmlsbFNlbGVjdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyUGF5TWV0aG9kU2VsZWN0JyksIGl0ZW1zLCB0cnVlKTtcbiAgICAgICAgICAgIGlmICghcXVpZXQpIGhhY2tlckxvZyhgwqvQodC/0L7RgdC+0LEg0L7Qv9C70LDRgtGLwrsg0L7QsdC90L7QstC70ZHQvTogJHtpdGVtcy5sZW5ndGh9INGI0YIuYCwgJ29rJyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiBoYWNrZXJMb2coJ9Ch0L/QvtGB0L7QsSDQvtC/0LvQsNGC0Ys6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJykpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJGZXRjaEN1c3RvbUNoYW5uZWxWYWx1ZXMoKSB7XG4gICAgcmV0dXJuIGhhY2tlckZldGNoTWV0YWRhdGFBdHRyaWJ1dGUoJ2RlbWFuZCcsICfQmtCw0L3QsNC7INC/0YDQvtC00LDQticpLnRoZW4oYXR0ciA9PiB7XG4gICAgICAgIGlmICghYXR0cj8uY3VzdG9tRW50aXR5TWV0YT8uaHJlZikgcmV0dXJuIFtdO1xuICAgICAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKGF0dHIuY3VzdG9tRW50aXR5TWV0YS5ocmVmKSkudGhlbihtZXRhID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGhyZWYgPSBtZXRhLmVudGl0eU1ldGE/LmhyZWY7XG4gICAgICAgICAgICByZXR1cm4gaHJlZiA/IG1zQXBpUCgnR0VUJywgaGFja2VyQXBpUGF0aChocmVmKSkgOiB7IHJvd3M6IFtdIH07XG4gICAgICAgIH0pLnRoZW4oZGF0YSA9PiAoZGF0YS5yb3dzIHx8IFtdKS5tYXAocm93ID0+ICh7XG4gICAgICAgICAgICBuYW1lOiByb3cubmFtZSxcbiAgICAgICAgICAgIGhyZWY6IHJvdy5tZXRhPy5ocmVmXG4gICAgICAgIH0pKS5maWx0ZXIocm93ID0+IHJvdy5ocmVmKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclJlZnJlc2hTYWxlc0NoYW5uZWxzKHF1aWV0KSB7XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKFtcbiAgICAgICAgbXNBcGlQKCdHRVQnLCAnL2VudGl0eS9zYWxlc2NoYW5uZWw/bGltaXQ9MTAwMCcpLFxuICAgICAgICBoYWNrZXJGZXRjaEN1c3RvbUNoYW5uZWxWYWx1ZXMoKVxuICAgIF0pLnRoZW4oKFtkYXRhLCBjdXN0b21WYWx1ZXNdKSA9PiB7XG4gICAgICAgIGNvbnN0IHN5c3RlbXMgPSBkYXRhLnJvd3MgfHwgW107XG4gICAgICAgIGhhY2tlclNhbGVzQ2hhbm5lbHMgPSBzeXN0ZW1zLm1hcChyb3cgPT4ge1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tID0gY3VzdG9tVmFsdWVzLmZpbmQodmFsdWUgPT4gdmFsdWUubmFtZSA9PT0gcm93Lm5hbWUpO1xuICAgICAgICAgICAgcmV0dXJuIHsgbmFtZTogcm93Lm5hbWUsIGhyZWY6IHJvdy5tZXRhPy5ocmVmLCBjdXN0b21IcmVmOiBjdXN0b20/LmhyZWYgfTtcbiAgICAgICAgfSkuZmlsdGVyKHJvdyA9PiByb3cuaHJlZik7XG4gICAgICAgIGhhY2tlckZpbGxTZWxlY3QoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckNoYW5uZWxTZWxlY3QnKSwgaGFja2VyU2FsZXNDaGFubmVscywgdHJ1ZSk7XG4gICAgICAgIGlmICghcXVpZXQpIGhhY2tlckxvZyhg0JrQsNC90LDQu9GLINC/0YDQvtC00LDQtiDQvtCx0L3QvtCy0LvQtdC90Ys6ICR7aGFja2VyU2FsZXNDaGFubmVscy5sZW5ndGh9INGI0YIuYCwgJ29rJyk7XG4gICAgfSkuY2F0Y2goZXJyb3IgPT4gaGFja2VyTG9nKCfQmtCw0L3QsNC70Ysg0L/RgNC+0LTQsNC2OiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpKTtcbn1cblxuLy8g4pSA4pSA4pSAINCg0YPRh9C90YvQtSDQvtC/0LXRgNCw0YbQuNC4OiDQvtGC0LPRgNGD0LfQutCwIC8g0J/QmtCeIC8g0LLRhdC+0LTRj9GJ0LjQuSDQv9C70LDRgtGR0LYg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBoYWNrZXJCdWlsZEF0dHJCb2R5KGVudGl0eVR5cGUsIGF0dHJOYW1lLCB2YWx1ZUhyZWYpIHtcbiAgICBpZiAoIXZhbHVlSHJlZikgcmV0dXJuIFByb21pc2UucmVzb2x2ZShudWxsKTtcbiAgICByZXR1cm4gaGFja2VyRmV0Y2hNZXRhZGF0YUF0dHJpYnV0ZShlbnRpdHlUeXBlLCBhdHRyTmFtZSkudGhlbihhdHRyID0+IHtcbiAgICAgICAgaWYgKCFhdHRyKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG1ldGE6IHtcbiAgICAgICAgICAgICAgICBocmVmOiBNU19BUElfQkFTRSArICcvZW50aXR5LycgKyBlbnRpdHlUeXBlICsgJy9tZXRhZGF0YS9hdHRyaWJ1dGVzLycgKyBhdHRyLmlkLFxuICAgICAgICAgICAgICAgIHR5cGU6ICdhdHRyaWJ1dGVtZXRhZGF0YScsXG4gICAgICAgICAgICAgICAgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24vanNvbidcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB2YWx1ZToge1xuICAgICAgICAgICAgICAgIG1ldGE6IHtcbiAgICAgICAgICAgICAgICAgICAgaHJlZjogdmFsdWVIcmVmLFxuICAgICAgICAgICAgICAgICAgICB0eXBlOiAnY3VzdG9tZW50aXR5JyxcbiAgICAgICAgICAgICAgICAgICAgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24vanNvbidcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck1hcmtSZXF1aXJlZFNlbGVjdChpZCwgbWVzc2FnZSkge1xuICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuICAgIGlmIChlbCkge1xuICAgICAgICBlbC5zdHlsZS5ib3JkZXJDb2xvciA9ICcjZWY0NDQ0JztcbiAgICAgICAgZWwuc3R5bGUuYm94U2hhZG93ID0gJzAgMCAwIDJweCAjZWY0NDQ0MzMnO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHsgaWYgKGVsLmlzQ29ubmVjdGVkKSB7IGVsLnN0eWxlLmJvcmRlckNvbG9yID0gJyNjYmQ1ZTEnOyBlbC5zdHlsZS5ib3hTaGFkb3cgPSAnJzsgfSB9LCAyNTAwKTtcbiAgICB9XG4gICAgaGFja2VyTG9nKG1lc3NhZ2UsICd3YXJuJyk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclNldEFjdGlvbkJ1c3koYnVzeSkge1xuICAgIGhhY2tlckJ1c3kgPSBidXN5O1xuICAgIFsnaGFja2VyQ3JlYXRlRGVtYW5kJywgJ2hhY2tlckNyZWF0ZUNhc2hpbicsICdoYWNrZXJDcmVhdGVQYXltZW50aW4nLCAnaGFja2VyQ3JlYXRlQ3JlZGl0J10uZm9yRWFjaChpZCA9PiB7XG4gICAgICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTtcbiAgICAgICAgaWYgKGJ1dHRvbikgeyBidXR0b24uZGlzYWJsZWQgPSBidXN5OyBidXR0b24uc3R5bGUub3BhY2l0eSA9IGJ1c3kgPyAnLjYnIDogJzEnOyB9XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckN1cnJlbnRPcmRlcigpIHtcbiAgICBjb25zdCBkb2MgPSBoYWNrZXJPcGVuRG9jKCk7XG4gICAgaWYgKCFkb2MgfHwgIVsnY3VzdG9tZXJvcmRlcicsICdkZW1hbmQnXS5pbmNsdWRlcyhkb2MudHlwZSkpIHtcbiAgICAgICAgaGFja2VyTG9nKCfQntGC0LrRgNC+0LnRgtC1INC60LDRgNGC0L7Rh9C60YMg0LfQsNC60LDQt9CwINC40LvQuCDQvtGC0LPRgNGD0LfQutC4JywgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiBkb2M7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckdldE9yZGVyKCkge1xuICAgIGNvbnN0IGRvYyA9IGhhY2tlckN1cnJlbnRPcmRlcigpO1xuICAgIGlmICghZG9jKSB0aHJvdyBuZXcgRXJyb3IoJ9C90LXRgiDQvtGC0LrRgNGL0YLQvtCz0L4g0LfQsNC60LDQt9CwINC40LvQuCDQvtGC0LPRgNGD0LfQutC4Jyk7XG4gICAgaWYgKGRvYy50eXBlID09PSAnZGVtYW5kJykge1xuICAgICAgICBjb25zdCBkZW1hbmQgPSBoYWNrZXJMYXN0RGVtYW5kPy5pZCA9PT0gZG9jLmlkXG4gICAgICAgICAgICA/IGhhY2tlckxhc3REZW1hbmRcbiAgICAgICAgICAgIDogYXdhaXQgbXNBcGlQKCdHRVQnLCAnL2VudGl0eS9kZW1hbmQvJyArIGRvYy5pZCArICc/ZXhwYW5kPWN1c3RvbWVyT3JkZXInKTtcbiAgICAgICAgaGFja2VyTGFzdERlbWFuZCA9IGRlbWFuZDtcbiAgICAgICAgY29uc3Qgb3JkZXJJZCA9IGRlbWFuZC5jdXN0b21lck9yZGVyPy5tZXRhPy5ocmVmPy5zcGxpdCgnLycpLnBvcCgpIHx8ICcnO1xuICAgICAgICBoYWNrZXJDb250ZXh0ID0geyBjdXN0b21lck9yZGVySWQ6IG9yZGVySWQsIGRlbWFuZElkOiBkb2MuaWQgfTtcbiAgICAgICAgcmV0dXJuIHsgZG9jLCBvcmRlcjogZGVtYW5kIH07XG4gICAgfVxuICAgIGNvbnN0IG9yZGVyID0gaGFja2VyT3JkZXJJbmZvICYmIGhhY2tlck9yZGVySW5mby5pZCA9PT0gZG9jLmlkXG4gICAgICAgID8gaGFja2VyT3JkZXJJbmZvXG4gICAgICAgIDogYXdhaXQgbXNBcGlQKCdHRVQnLCAnL2VudGl0eS9jdXN0b21lcm9yZGVyLycgKyBkb2MuaWQgKyAnP2V4cGFuZD1wb3NpdGlvbnMuYXNzb3J0bWVudCcpO1xuICAgIGhhY2tlck9yZGVySW5mbyA9IG9yZGVyO1xuICAgIGhhY2tlckNvbnRleHQgPSB7IGN1c3RvbWVyT3JkZXJJZDogZG9jLmlkLCBkZW1hbmRJZDogaGFja2VyQ29udGV4dC5jdXN0b21lck9yZGVySWQgPT09IGRvYy5pZCA/IGhhY2tlckNvbnRleHQuZGVtYW5kSWQgOiAnJyB9O1xuICAgIHJldHVybiB7IGRvYywgb3JkZXIgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyQnVpbGREZW1hbmRCb2R5KG9yZGVyLCBkb2MpIHtcbiAgICBjb25zdCBkZW1hbmRCb2R5ID0ge1xuICAgICAgICBtb21lbnQ6IG9yZGVyLm1vbWVudCxcbiAgICAgICAgb3JnYW5pemF0aW9uOiBvcmRlci5vcmdhbml6YXRpb24sXG4gICAgICAgIGFnZW50OiBvcmRlci5hZ2VudCxcbiAgICAgICAgc3RvcmU6IG9yZGVyLnN0b3JlLFxuICAgICAgICBjdXN0b21lck9yZGVyOiB7IG1ldGE6IGhhY2tlck1ldGFSZWYoTVNfQVBJX0JBU0UgKyAnL2VudGl0eS9jdXN0b21lcm9yZGVyLycgKyBkb2MuaWQsICdjdXN0b21lcm9yZGVyJykgfSxcbiAgICAgICAgcG9zaXRpb25zOiAoQXJyYXkuaXNBcnJheShvcmRlci5wb3NpdGlvbnMpID8gb3JkZXIucG9zaXRpb25zIDogKG9yZGVyLnBvc2l0aW9ucz8ucm93cyB8fCBbXSkpLm1hcChwb3NpdGlvbiA9PiB7XG4gICAgICAgICAgICBjb25zdCBjb3B5ID0geyBhc3NvcnRtZW50OiBwb3NpdGlvbi5hc3NvcnRtZW50LCBxdWFudGl0eTogcG9zaXRpb24ucXVhbnRpdHksIHByaWNlOiBwb3NpdGlvbi5wcmljZSB9O1xuICAgICAgICAgICAgWydkaXNjb3VudCcsICd2YXQnLCAncGFjaycsICd0aGluZ3MnLCAncmVzZXJ2ZSddLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAocG9zaXRpb25ba2V5XSAhPT0gdW5kZWZpbmVkKSBjb3B5W2tleV0gPSBwb3NpdGlvbltrZXldO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gY29weTtcbiAgICAgICAgfSlcbiAgICB9O1xuICAgIGxldCBjaGFubmVsSHJlZiA9IGhhY2tlckRlZmF1bHRDaGFubmVsIHx8IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJDaGFubmVsU2VsZWN0Jyk/LnZhbHVlIHx8ICcnO1xuICAgIGxldCBjaGFubmVsTm90ZSA9IGhhY2tlckRlZmF1bHRDaGFubmVsID8gJ9C/0L4g0YPQvNC+0LvRh9Cw0L3QuNGOJyA6ICfQutCw0Log0LLRi9Cx0YDQsNC90L4nO1xuICAgIGlmICghY2hhbm5lbEhyZWYgJiYgb3JkZXIuc2FsZXNDaGFubmVsPy5tZXRhPy5ocmVmKSB7XG4gICAgICAgIGNoYW5uZWxIcmVmID0gb3JkZXIuc2FsZXNDaGFubmVsLm1ldGEuaHJlZjtcbiAgICAgICAgY2hhbm5lbE5vdGUgPSAn0LrQsNC6INCyINC30LDQutCw0LfQtSc7XG4gICAgfVxuICAgIGlmICghY2hhbm5lbEhyZWYpIHtcbiAgICAgICAgaWYgKCFoYWNrZXJTYWxlc0NoYW5uZWxzLmxlbmd0aCkgYXdhaXQgaGFja2VyUmVmcmVzaFNhbGVzQ2hhbm5lbHModHJ1ZSk7XG4gICAgICAgIGNvbnN0IHJhbmRvbSA9IGhhY2tlclNhbGVzQ2hhbm5lbHNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogaGFja2VyU2FsZXNDaGFubmVscy5sZW5ndGgpXTtcbiAgICAgICAgY2hhbm5lbEhyZWYgPSByYW5kb20/LmhyZWYgfHwgJyc7XG4gICAgICAgIGNoYW5uZWxOb3RlID0gJ9GA0LDQvdC00L7QvCc7XG4gICAgfVxuICAgIGNvbnN0IHNlbGVjdGVkID0gaGFja2VyU2FsZXNDaGFubmVscy5maW5kKGl0ZW0gPT4gaXRlbS5ocmVmID09PSBjaGFubmVsSHJlZik7XG4gICAgaWYgKCFzZWxlY3RlZD8uY3VzdG9tSHJlZikgdGhyb3cgbmV3IEVycm9yKCfQlNC70Y8g0LLRi9Cx0YDQsNC90L3QvtCz0L4g0LrQsNC90LDQu9CwINC/0YDQvtC00LDQtiDQvdC1INC90LDQudC00LXQvdC+INC30L3QsNGH0LXQvdC40LUg0LDRgtGA0LjQsdGD0YLQsCDQvtGC0LPRgNGD0LfQutC4Jyk7XG4gICAgZGVtYW5kQm9keS5zYWxlc0NoYW5uZWwgPSB7IG1ldGE6IGhhY2tlck1ldGFSZWYoY2hhbm5lbEhyZWYsICdzYWxlc2NoYW5uZWwnKSB9O1xuICAgIGNvbnN0IGF0dHIgPSBhd2FpdCBoYWNrZXJGZXRjaE1ldGFkYXRhQXR0cmlidXRlKCdkZW1hbmQnLCAn0JrQsNC90LDQuyDQv9GA0L7QtNCw0LYnKTtcbiAgICBpZiAoIWF0dHI/Lm1ldGE/LmhyZWYpIHRocm93IG5ldyBFcnJvcign0JIg0L7RgtCz0YDRg9C30LrQtSDQvdC1INC90LDQudC00LXQvSDQvtCx0Y/Qt9Cw0YLQtdC70YzQvdGL0Lkg0LDRgtGA0LjQsdGD0YIgwqvQmtCw0L3QsNC7INC/0YDQvtC00LDQtsK7Jyk7XG4gICAgZGVtYW5kQm9keS5hdHRyaWJ1dGVzID0gW3tcbiAgICAgICAgbWV0YTogaGFja2VyTWV0YVJlZihhdHRyLm1ldGEuaHJlZiwgJ2F0dHJpYnV0ZW1ldGFkYXRhJyksXG4gICAgICAgIHZhbHVlOiB7IG1ldGE6IGhhY2tlck1ldGFSZWYoc2VsZWN0ZWQuY3VzdG9tSHJlZiwgJ2N1c3RvbWVudGl0eScpIH1cbiAgICB9XTtcbiAgICBoYWNrZXJMb2coYNCa0LDQvdCw0Lsg0L/RgNC+0LTQsNC2INC+0YLQs9GA0YPQt9C60Lg6ICR7Y2hhbm5lbE5vdGV9YCk7XG4gICAgaGFja2VyTG9nKCfQmtCw0L3QsNC7INC/0YDQvtC00LDQtiDQv9GA0L7QtNGD0LHQu9C40YDQvtCy0LDQvSDQsiDQsNGC0YDQuNCx0YPRgiDQvtGC0LPRgNGD0LfQutC4Jyk7XG4gICAgcmV0dXJuIGRlbWFuZEJvZHk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclBvc2l0aW9uS2V5KHBvc2l0aW9uKSB7XG4gICAgcmV0dXJuIHBvc2l0aW9uLmFzc29ydG1lbnQ/Lm1ldGE/LmhyZWYgfHwgcG9zaXRpb24uYXNzb3J0bWVudD8uaWQgfHwgJyc7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclBvc2l0aW9uc1NpZ25hdHVyZShkb2N1bWVudCkge1xuICAgIGNvbnN0IHJvd3MgPSBBcnJheS5pc0FycmF5KGRvY3VtZW50Py5wb3NpdGlvbnMpXG4gICAgICAgID8gZG9jdW1lbnQucG9zaXRpb25zXG4gICAgICAgIDogKGRvY3VtZW50Py5wb3NpdGlvbnM/LnJvd3MgfHwgW10pO1xuICAgIHJldHVybiByb3dzXG4gICAgICAgIC5tYXAocG9zaXRpb24gPT4gYCR7aGFja2VyUG9zaXRpb25LZXkocG9zaXRpb24pfToke051bWJlcihwb3NpdGlvbi5xdWFudGl0eSB8fCAwKX1gKVxuICAgICAgICAuc29ydCgpXG4gICAgICAgIC5qb2luKCd8Jyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckZpbmRFeGlzdGluZ0RlbWFuZChvcmRlciwgZG9jKSB7XG4gICAgY29uc3QgY3VzdG9tZXJPcmRlckhyZWYgPSBNU19BUElfQkFTRSArICcvZW50aXR5L2N1c3RvbWVyb3JkZXIvJyArIGRvYy5pZDtcbiAgICBjb25zdCBwYXRoID0gJy9lbnRpdHkvZGVtYW5kP2ZpbHRlcj1jdXN0b21lck9yZGVyPScgKyBlbmNvZGVVUklDb21wb25lbnQoY3VzdG9tZXJPcmRlckhyZWYpXG4gICAgICAgICsgJyZleHBhbmQ9cG9zaXRpb25zLmFzc29ydG1lbnQmbGltaXQ9MTAwJztcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgbXNBcGlQKCdHRVQnLCBwYXRoKTtcbiAgICBjb25zdCByb3dzID0gZGF0YS5yb3dzIHx8IFtdO1xuICAgIGNvbnN0IG9yZGVyU3VtID0gTnVtYmVyKG9yZGVyLnN1bSB8fCAwKTtcbiAgICBjb25zdCBvcmRlclBvc2l0aW9ucyA9IGhhY2tlclBvc2l0aW9uc1NpZ25hdHVyZShvcmRlcik7XG4gICAgcmV0dXJuIHJvd3MuZmlsdGVyKGRlbWFuZCA9PiBkZW1hbmQuYXBwbGljYWJsZSA9PT0gdHJ1ZSAmJiBOdW1iZXIoZGVtYW5kLnN1bSB8fCAwKSA9PT0gb3JkZXJTdW0pXG4gICAgICAgIC5tYXAoZGVtYW5kID0+ICh7XG4gICAgICAgICAgICBkZW1hbmQsXG4gICAgICAgICAgICBzYW1lUG9zaXRpb25zOiBoYWNrZXJQb3NpdGlvbnNTaWduYXR1cmUoZGVtYW5kKSA9PT0gb3JkZXJQb3NpdGlvbnNcbiAgICAgICAgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJDcmVhdGVEZW1hbmQoKSB7XG4gICAgaWYgKGhhY2tlckJ1c3kpIHJldHVybjtcbiAgICBjb25zdCBjdXJyZW50ID0gaGFja2VyT3BlbkRvYygpO1xuICAgIGlmICghY3VycmVudCB8fCBjdXJyZW50LnR5cGUgIT09ICdjdXN0b21lcm9yZGVyJykge1xuICAgICAgICBoYWNrZXJMb2coJ9CU0LvRjyDRgdC+0LfQtNCw0L3QuNGPINC+0YLQs9GA0YPQt9C60Lgg0L7RgtC60YDQvtC50YLQtSDQt9Cw0LrQsNC3INC/0L7QutGD0L/QsNGC0LXQu9GPJywgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBoYWNrZXJTZXRBY3Rpb25CdXN5KHRydWUpO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgZG9jLCBvcmRlciB9ID0gYXdhaXQgaGFja2VyR2V0T3JkZXIoKTtcbiAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBoYWNrZXJGaW5kRXhpc3RpbmdEZW1hbmQob3JkZXIsIGRvYyk7XG4gICAgICAgIGNvbnN0IGV4YWN0ID0gZXhpc3RpbmcuZmluZChpdGVtID0+IGl0ZW0uc2FtZVBvc2l0aW9ucyk7XG4gICAgICAgIGlmIChleGFjdCkge1xuICAgICAgICAgICAgaGFja2VyTGFzdERlbWFuZCA9IGV4YWN0LmRlbWFuZDtcbiAgICAgICAgICAgIGhhY2tlckxvZyhg4pqg77iPINCj0LbQtSDQtdGB0YLRjCDQv9GA0L7QstC10LTRkdC90L3QsNGPINC+0YLQs9GA0YPQt9C60LAgJHtleGFjdC5kZW1hbmQubmFtZX0g0L3QsCDRgdGD0LzQvNGDICR7KGV4YWN0LmRlbWFuZC5zdW0gLyAxMDApLnRvRml4ZWQoMil9IOKCvSDigJQg0L3QvtCy0LDRjyDQvdC1INGB0L7Qt9C00LDRkdGC0YHRj2AsICd3YXJuJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV4aXN0aW5nLmxlbmd0aCkge1xuICAgICAgICAgICAgaGFja2VyTG9nKCfQldGB0YLRjCDQv9GA0L7QstC10LTRkdC90L3QsNGPINC+0YLQs9GA0YPQt9C60LAg0YEg0YLQsNC60L7QuSDQttC1INGB0YPQvNC80L7QuSwg0L3QviDRgdC+0YHRgtCw0LIg0L/QvtC30LjRhtC40Lkg0L7RgtC70LjRh9Cw0LXRgtGB0Y8g4oCUINGB0L7Qt9C00LDRjiDQvdC+0LLRg9GOINC+0YLQs9GA0YPQt9C60YMnLCAnd2FybicpO1xuICAgICAgICB9XG4gICAgICAgIGhhY2tlckxvZygn0KHQvtC30LTQsNGOINC+0YLQs9GA0YPQt9C60YPigKYnKTtcbiAgICAgICAgaGFja2VyT3JkZXJJbmZvID0gb3JkZXI7XG4gICAgICAgIGNvbnN0IGRlbWFuZCA9IGF3YWl0IGhhY2tlclBvc3RXaXRoTmFtZVJldHJ5KCdkZW1hbmQnLCBhd2FpdCBoYWNrZXJCdWlsZERlbWFuZEJvZHkob3JkZXIsIGRvYyksIG9yZGVyLm5hbWUgfHwgKCfQkNCy0YLQvtC/0YDQvtC00LDQttCwICcgKyBkb2MuaWQpKTtcbiAgICAgICAgaGFja2VyTGFzdERlbWFuZCA9IGRlbWFuZDtcbiAgICAgICAgaGFja2VyQ29udGV4dCA9IHsgY3VzdG9tZXJPcmRlcklkOiBkb2MuaWQsIGRlbWFuZElkOiBkZW1hbmQuaWQgfTtcbiAgICAgICAgaGFja2VyTG9nKGDinIUg0J7RgtCz0YDRg9C30LrQsCDRgdC+0LfQtNCw0L3QsDogJHtkZW1hbmQubmFtZX1gLCAnb2snKTtcbiAgICAgICAgbG9jYXRpb24uaGFzaCA9ICcjZGVtYW5kL2VkaXQ/aWQ9JyArIGRlbWFuZC5pZDtcbiAgICB9IGNhdGNoIChlcnJvcikgeyBoYWNrZXJMb2coJ9Ce0YLQs9GA0YPQt9C60LA6ICcgKyAoZXJyb3IubWVzc2FnZSB8fCBlcnJvciksICdlcnInKTsgfVxuICAgIGZpbmFsbHkgeyBoYWNrZXJTZXRBY3Rpb25CdXN5KGZhbHNlKTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJDcmVhdGVQYXltZW50RG9jdW1lbnQoZW50aXR5VHlwZSkge1xuICAgIGNvbnN0IHN1bSA9IGhhY2tlclBhcnNlU3VtVG9Lb3BlY2tzKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJTYWxlU3VtJyk/LnZhbHVlKTtcbiAgICBpZiAoIXN1bSkgeyBoYWNrZXJMb2coYCR7ZW50aXR5VHlwZSA9PT0gJ2Nhc2hpbicgPyAn0J/RgNC40YXQvtC00L3Ri9C5INC+0YDQtNC10YAnIDogJ9CS0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2J306INGB0YPQvNC80LAg0L/Rg9GB0YLQsNGPLzAg4oCUINC/0YDQvtC/0YPRidC10L1gKTsgcmV0dXJuOyB9XG4gICAgY29uc3QgeyBkb2MsIG9yZGVyIH0gPSBhd2FpdCBoYWNrZXJHZXRPcmRlcigpO1xuICAgIGNvbnN0IGRlbWFuZCA9IGhhY2tlckxhc3REZW1hbmQ/LmlkID09PSBkb2MuaWQgPyBoYWNrZXJMYXN0RGVtYW5kIDogbnVsbDtcbiAgICBjb25zdCBib2R5ID0geyBvcmdhbml6YXRpb246IG9yZGVyLm9yZ2FuaXphdGlvbiwgYWdlbnQ6IG9yZGVyLmFnZW50LCBzdW0sIG1vbWVudDogb3JkZXIubW9tZW50IH07XG4gICAgY29uc3QgbGlua2VkRG9jdW1lbnQgPSBkZW1hbmQ/LmlkXG4gICAgICAgID8geyBpZDogZGVtYW5kLmlkLCB0eXBlOiAnZGVtYW5kJywgbGFiZWw6ICfQvtGC0LPRgNGD0LfQutC1JyB9XG4gICAgICAgIDogKGRvYy50eXBlID09PSAnY3VzdG9tZXJvcmRlcidcbiAgICAgICAgICAgID8geyBpZDogZG9jLmlkLCB0eXBlOiAnY3VzdG9tZXJvcmRlcicsIGxhYmVsOiAn0LfQsNC60LDQt9GDJyB9XG4gICAgICAgICAgICA6IHsgaWQ6IGRvYy5pZCwgdHlwZTogJ2RlbWFuZCcsIGxhYmVsOiAn0L7RgtCz0YDRg9C30LrQtScgfSk7XG4gICAgYm9keS5vcGVyYXRpb25zID0gW3tcbiAgICAgICAgbWV0YTogaGFja2VyTWV0YVJlZihNU19BUElfQkFTRSArICcvZW50aXR5LycgKyBsaW5rZWREb2N1bWVudC50eXBlICsgJy8nICsgbGlua2VkRG9jdW1lbnQuaWQsIGxpbmtlZERvY3VtZW50LnR5cGUpLFxuICAgICAgICBsaW5rZWRTdW06IHN1bVxuICAgIH1dO1xuICAgIGhhY2tlckxvZyhg0JTQvtC60YPQvNC10L3RgiDQsdGD0LTQtdGCINC/0YDQuNCy0Y/Qt9Cw0L0g0LogJHtsaW5rZWREb2N1bWVudC5sYWJlbH1gKTtcbiAgICBpZiAoZW50aXR5VHlwZSA9PT0gJ2Nhc2hpbicpIHtcbiAgICAgICAgY29uc3QgY2xpZW50SHJlZiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJDbGllbnRTdGF0dXNTZWxlY3QnKT8udmFsdWUgfHwgJyc7XG4gICAgICAgIGNvbnN0IGNhc2hUeXBlSHJlZiA9IGF3YWl0IGhhY2tlclJlZnJlc2hDYXNoUGF5VHlwZSgpO1xuICAgICAgICBib2R5LmF0dHJpYnV0ZXMgPSBbXG4gICAgICAgICAgICBhd2FpdCBoYWNrZXJCdWlsZEF0dHJCb2R5KCdjYXNoaW4nLCBIQUNLRVJfQVRUUl9DTElFTlRfU1RBVFVTLCBjbGllbnRIcmVmKSxcbiAgICAgICAgICAgIGF3YWl0IGhhY2tlckJ1aWxkQXR0ckJvZHkoJ2Nhc2hpbicsIEhBQ0tFUl9BVFRSX1BBWV9UWVBFLCBjYXNoVHlwZUhyZWYpXG4gICAgICAgIF0uZmlsdGVyKEJvb2xlYW4pO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IG1ldGhvZEhyZWYgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyUGF5TWV0aG9kU2VsZWN0Jyk/LnZhbHVlIHx8ICcnO1xuICAgICAgICBpZiAoIW1ldGhvZEhyZWYpIHsgaGFja2VyTWFya1JlcXVpcmVkU2VsZWN0KCdoYWNrZXJQYXlNZXRob2RTZWxlY3QnLCAn0JLRi9Cx0LXRgNC40YLQtSDCq9Ch0L/QvtGB0L7QsSDQvtC/0LvQsNGC0YvCuycpOyByZXR1cm47IH1cbiAgICAgICAgYm9keS5hdHRyaWJ1dGVzID0gW2F3YWl0IGhhY2tlckJ1aWxkQXR0ckJvZHkoJ3BheW1lbnRpbicsIEhBQ0tFUl9BVFRSX1BBWV9NRVRIT0QsIG1ldGhvZEhyZWYpXS5maWx0ZXIoQm9vbGVhbik7XG4gICAgfVxuICAgIHJldHVybiBoYWNrZXJQb3N0V2l0aE5hbWVSZXRyeShlbnRpdHlUeXBlLCBib2R5LCBvcmRlci5uYW1lIHx8ICgn0JDQstGC0L7Qv9GA0L7QtNCw0LbQsCAnICsgb3JkZXIuaWQpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyQ3JlYXRlQ2FzaGluKCkge1xuICAgIGlmIChoYWNrZXJCdXN5KSByZXR1cm47IGhhY2tlclNldEFjdGlvbkJ1c3kodHJ1ZSk7XG4gICAgdHJ5IHsgY29uc3QgaXRlbSA9IGF3YWl0IGhhY2tlckNyZWF0ZVBheW1lbnREb2N1bWVudCgnY2FzaGluJyk7IGlmIChpdGVtKSBoYWNrZXJMb2coYOKchSDQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCDRgdC+0LfQtNCw0L06ICR7aXRlbS5uYW1lfWAsICdvaycpOyB9XG4gICAgY2F0Y2ggKGVycm9yKSB7IGhhY2tlckxvZygn0J/RgNC40YXQvtC00L3Ri9C5INC+0YDQtNC10YA6ICcgKyAoZXJyb3IubWVzc2FnZSB8fCBlcnJvciksICdlcnInKTsgfVxuICAgIGZpbmFsbHkgeyBoYWNrZXJTZXRBY3Rpb25CdXN5KGZhbHNlKTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJDcmVhdGVDcmVkaXQoKSB7XG4gICAgaWYgKGhhY2tlckJ1c3kpIHJldHVybjtcbiAgICBjb25zdCB0b3RhbCA9IGhhY2tlclBhcnNlU3VtVG9Lb3BlY2tzKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJTYWxlU3VtJyk/LnZhbHVlKTtcbiAgICBjb25zdCBjYXNoID0gaGFja2VyUGFyc2VTdW1Ub0tvcGVja3MoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckNhc2hBbW91bnQnKT8udmFsdWUpO1xuICAgIGlmICghdG90YWwgfHwgIWNhc2gpIHsgaGFja2VyTG9nKCfQlNC70Y8g0LrRgNC10LTQuNGC0LAv0YDQsNGB0YHRgNC+0YfQutC4INGD0LrQsNC20LjRgtC1INC+0LHRidGD0Y4g0YHRg9C80LzRgyDQuCDRgdGD0LzQvNGDINC90LDQu9C40YfQvdGL0LzQuCcsICd3YXJuJyk7IHJldHVybjsgfVxuICAgIGlmIChjYXNoID49IHRvdGFsKSB7IGhhY2tlckxvZygn0KHRg9C80LzQsCDQvdCw0LvQuNGH0L3Ri9C80Lgg0LTQvtC70LbQvdCwINCx0YvRgtGMINC80LXQvdGM0YjQtSDQvtCx0YnQtdC5INGB0YPQvNC80YsnLCAnd2FybicpOyByZXR1cm47IH1cbiAgICBjb25zdCByZXN0ID0gdG90YWwgLSBjYXNoO1xuICAgIGhhY2tlclNldEFjdGlvbkJ1c3kodHJ1ZSk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYW1vdW50SW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyU2FsZVN1bScpO1xuICAgICAgICBjb25zdCBvbGRBbW91bnQgPSBhbW91bnRJbnB1dC52YWx1ZTtcbiAgICAgICAgYW1vdW50SW5wdXQudmFsdWUgPSBTdHJpbmcoY2FzaCAvIDEwMCk7XG4gICAgICAgIGNvbnN0IGNhc2hEb2MgPSBhd2FpdCBoYWNrZXJDcmVhdGVQYXltZW50RG9jdW1lbnQoJ2Nhc2hpbicpO1xuICAgICAgICBhbW91bnRJbnB1dC52YWx1ZSA9IG9sZEFtb3VudDtcbiAgICAgICAgaWYgKGNhc2hEb2MpIGhhY2tlckxvZyhg4pyFINCf0JrQniDQvdCwINC90LDQu9C40YfQvdGL0LUg0YHQvtC30LTQsNC9OiAke2Nhc2hEb2MubmFtZX1gLCAnb2snKTtcbiAgICAgICAgYW1vdW50SW5wdXQudmFsdWUgPSBTdHJpbmcocmVzdCAvIDEwMCk7XG4gICAgICAgIGNvbnN0IHBheURvYyA9IGF3YWl0IGhhY2tlckNyZWF0ZVBheW1lbnREb2N1bWVudCgncGF5bWVudGluJyk7XG4gICAgICAgIGFtb3VudElucHV0LnZhbHVlID0gb2xkQW1vdW50O1xuICAgICAgICBpZiAocGF5RG9jKSBoYWNrZXJMb2coYOKchSDQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0ZHQtiDQvdCwINC+0YHRgtCw0YLQvtC6INGB0L7Qt9C00LDQvTogJHtwYXlEb2MubmFtZX1gLCAnb2snKTtcbiAgICB9IGNhdGNoIChlcnJvcikgeyBoYWNrZXJMb2coJ9Ca0YDQtdC00LjRgi/RgNCw0YHRgdGA0L7Rh9C60LA6ICcgKyAoZXJyb3IubWVzc2FnZSB8fCBlcnJvciksICdlcnInKTsgfVxuICAgIGZpbmFsbHkgeyBoYWNrZXJTZXRBY3Rpb25CdXN5KGZhbHNlKTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJDcmVhdGVQYXltZW50aW4oKSB7XG4gICAgaWYgKGhhY2tlckJ1c3kpIHJldHVybjsgaGFja2VyU2V0QWN0aW9uQnVzeSh0cnVlKTtcbiAgICB0cnkgeyBjb25zdCBpdGVtID0gYXdhaXQgaGFja2VyQ3JlYXRlUGF5bWVudERvY3VtZW50KCdwYXltZW50aW4nKTsgaWYgKGl0ZW0pIGhhY2tlckxvZyhg4pyFINCS0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2INGB0L7Qt9C00LDQvTogJHtpdGVtLm5hbWV9YCwgJ29rJyk7IH1cbiAgICBjYXRjaCAoZXJyb3IpIHsgaGFja2VyTG9nKCfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0ZHQtjogJyArIChlcnJvci5tZXNzYWdlIHx8IGVycm9yKSwgJ2VycicpOyB9XG4gICAgZmluYWxseSB7IGhhY2tlclNldEFjdGlvbkJ1c3koZmFsc2UpOyB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckNoZWNrT3JkZXJTdW0oKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBvcmRlciB9ID0gYXdhaXQgaGFja2VyR2V0T3JkZXIoKTtcbiAgICAgICAgY29uc3Qgc3VtID0gKChvcmRlci5zdW0gfHwgMCkgLyAxMDApLnRvRml4ZWQoMik7XG4gICAgICAgIFsnaGFja2VyU2FsZVN1bScsICdoYWNrZXJDYXNoQW1vdW50J10uZm9yRWFjaChpZCA9PiB7XG4gICAgICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTtcbiAgICAgICAgICAgIGlmIChlbCAmJiBpZCA9PT0gJ2hhY2tlclNhbGVTdW0nKSBlbC52YWx1ZSA9IHN1bTtcbiAgICAgICAgfSk7XG4gICAgICAgIGhhY2tlckxvZyhg4pyFINCh0YPQvNC80LAg0LfQsNC60LDQt9CwINC+0LHQvdC+0LLQu9C10L3QsDogJHtzdW19IOKCvWAsICdvaycpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGhhY2tlckxvZygn0J/RgNC+0LLQtdGA0LrQsCDRgdGD0LzQvNGLOiAnICsgKGVycm9yLm1lc3NhZ2UgfHwgZXJyb3IpLCAnZXJyJyk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJQYXJzZVN1bVRvS29wZWNrcyh2YWx1ZSkge1xuICAgIGNvbnN0IG4gPSBwYXJzZUZsb2F0KFN0cmluZyh2YWx1ZSB8fCAnJykucmVwbGFjZSgnLCcsICcuJykucmVwbGFjZSgvXFxzL2csICcnKSk7XG4gICAgcmV0dXJuIChpc0Zpbml0ZShuKSAmJiBuID4gMCkgPyBNYXRoLnJvdW5kKG4gKiAxMDApIDogMDtcbn1cbiIsIi8vIOKUgOKUgOKUgCDQmtC+0L3RgtC10LrRgdGC0L3Ri9C5IFVYINCc0L7QudCh0LrQu9Cw0LQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQmNC00LXQvNC/0L7RgtC10L3RgtC90YvQtSBET00t0LLRgdGC0YDQvtC50LrQuCDQtNC70Y8g0LrQsNGA0YLQvtGH0LXQuiDQtNC+0LrRg9C80LXQvdGC0L7Qsi4g0JHQuNC30L3QtdGBLdC00LXQudGB0YLQstC40Y8g0LjRgdC/0L7Qu9GM0LfRg9GO0YJcbi8vINC70LjQsdC+INGI0YLQsNGC0L3Ri9C5IFVJINCc0L7QudCh0LrQu9Cw0LQsINC70LjQsdC+INC90LXQsdC+0LvRjNGI0LjQtSDQv9GA0L7QstC10YDQtdC90L3Ri9C1IEFQSS3QstGL0LfQvtCy0YsuXG5cbmxldCBtc1NwYU9ic2VydmVyID0gbnVsbDtcbmxldCBtc1NwYVJlY29uY2lsZVRpbWVyID0gbnVsbDtcbmxldCBtc1F1aWNrS2VlcGFsaXZlVGltZXIgPSBudWxsO1xuXG5mdW5jdGlvbiBtc0N1cnJlbnREb2N1bWVudCgpIHtcbiAgICBjb25zdCBtYXRjaCA9IGxvY2F0aW9uLmhhc2gubWF0Y2goL14jKGN1c3RvbWVyb3JkZXJ8ZGVtYW5kfGNhc2hpbnxwYXltZW50aW4pXFwvZWRpdFxcP1teI10qXFxiaWQ9KFswLTlhLWYtXSspL2kpO1xuICAgIHJldHVybiBtYXRjaCA/IHsgdHlwZTogbWF0Y2hbMV0udG9Mb3dlckNhc2UoKSwgaWQ6IG1hdGNoWzJdIH0gOiBudWxsO1xufVxuXG5mdW5jdGlvbiBtc1Zpc2libGUoZWxlbWVudCkge1xuICAgIHJldHVybiAhIWVsZW1lbnQgJiYgZWxlbWVudC5pc0Nvbm5lY3RlZCAmJiBlbGVtZW50Lm9mZnNldEhlaWdodCA+IDA7XG59XG5cbmZ1bmN0aW9uIG1zRXhhY3RUZXh0RWxlbWVudHModGV4dCkge1xuICAgIGNvbnN0IGZvdW5kID0gW107XG4gICAgY29uc3Qgd2Fsa2VyID0gZG9jdW1lbnQuY3JlYXRlVHJlZVdhbGtlcihkb2N1bWVudC5ib2R5LCBOb2RlRmlsdGVyLlNIT1dfVEVYVCk7XG4gICAgbGV0IG5vZGU7XG4gICAgd2hpbGUgKChub2RlID0gd2Fsa2VyLm5leHROb2RlKCkpKSB7XG4gICAgICAgIGlmICgobm9kZS50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpICE9PSB0ZXh0KSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZWxlbWVudCA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgICAgICAgaWYgKGVsZW1lbnQgJiYgbXNWaXNpYmxlKGVsZW1lbnQpICYmICFlbGVtZW50LmNsb3Nlc3QoJ1tpZF49XCJtY1wiXScpKSBmb3VuZC5wdXNoKGVsZW1lbnQpO1xuICAgIH1cbiAgICByZXR1cm4gZm91bmQ7XG59XG5cbmZ1bmN0aW9uIG1zRmllbGRIb3N0RnJvbUxhYmVsKGxhYmVsRWxlbWVudCkge1xuICAgIGlmICghbGFiZWxFbGVtZW50KSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB0aXRsZSA9IGxhYmVsRWxlbWVudC5jbG9zZXN0KCdbY2xhc3MqPVwiZm9ybUl0ZW1UaXRsZVwiXScpO1xuICAgIGlmICh0aXRsZSkge1xuICAgICAgICBjb25zdCBwYXJlbnQgPSB0aXRsZS5wYXJlbnRFbGVtZW50O1xuICAgICAgICBjb25zdCBpbmRleCA9IEFycmF5LnByb3RvdHlwZS5pbmRleE9mLmNhbGwocGFyZW50LmNoaWxkcmVuLCB0aXRsZSk7XG4gICAgICAgIHJldHVybiBwYXJlbnQuY2hpbGRyZW5baW5kZXggKyAxXSB8fCBudWxsO1xuICAgIH1cbiAgICBjb25zdCBsZWdlbmQgPSBsYWJlbEVsZW1lbnQuY2xvc2VzdCgndGQubGVnZW5kJykgfHwgbGFiZWxFbGVtZW50LmNsb3Nlc3QoJ3RkJyk7XG4gICAgaWYgKGxlZ2VuZD8ubmV4dEVsZW1lbnRTaWJsaW5nKSByZXR1cm4gbGVnZW5kLm5leHRFbGVtZW50U2libGluZztcbiAgICByZXR1cm4gbGFiZWxFbGVtZW50Lm5leHRFbGVtZW50U2libGluZyB8fCBsYWJlbEVsZW1lbnQucGFyZW50RWxlbWVudD8ubmV4dEVsZW1lbnRTaWJsaW5nIHx8IG51bGw7XG59XG5cbmZ1bmN0aW9uIG1zRmluZE9yZGVyU3RhdHVzQW5jaG9yKCkge1xuICAgIGlmIChtc0N1cnJlbnREb2N1bWVudCgpPy50eXBlICE9PSAnY3VzdG9tZXJvcmRlcicpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHRlc3RJZEFuY2hvciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3QtaWQ9XCJkb2Mtc3RhdHVzXCJdJyk7XG4gICAgaWYgKG1zVmlzaWJsZSh0ZXN0SWRBbmNob3IpKSByZXR1cm4gdGVzdElkQW5jaG9yO1xuICAgIGNvbnN0IGxhYmVsbGVkID0gbXNFeGFjdFRleHRFbGVtZW50cygn0KHRgtCw0YLRg9GBJylcbiAgICAgICAgLm1hcChlbGVtZW50ID0+IG1zRmllbGRIb3N0RnJvbUxhYmVsKGVsZW1lbnQpKVxuICAgICAgICAuZmluZChtc1Zpc2libGUpO1xuICAgIGlmIChsYWJlbGxlZCkgcmV0dXJuIGxhYmVsbGVkLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvbixbcm9sZT1cImJ1dHRvblwiXSwuYi1wb3B1cC1idXR0b24nKSB8fCBsYWJlbGxlZDtcblxuICAgIGNvbnN0IG5hbWVzID0gbmV3IFNldChoYWNrZXJTdGF0ZXMubWFwKHN0YXRlID0+IHN0YXRlLm5hbWUpKTtcbiAgICBpZiAoIW5hbWVzLnNpemUpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBbLi4uZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uLFtyb2xlPVwiYnV0dG9uXCJdLC5iLXBvcHVwLWJ1dHRvbicpXVxuICAgICAgICAuZmluZChlbGVtZW50ID0+IG1zVmlzaWJsZShlbGVtZW50KSAmJiBuYW1lcy5oYXMoKGVsZW1lbnQudGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKSkgJiYgIWVsZW1lbnQuY2xvc2VzdCgnW2lkXj1cIm1jXCJdJykpIHx8IG51bGw7XG59XG5cbmZ1bmN0aW9uIG1zVG9hc3QobWVzc2FnZSwga2luZCA9ICdpbmZvJykge1xuICAgIGxldCB0b2FzdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY01zVG9hc3QnKTtcbiAgICBpZiAoIXRvYXN0KSB7XG4gICAgICAgIHRvYXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHRvYXN0LmlkID0gJ21jTXNUb2FzdCc7XG4gICAgICAgIHRvYXN0LnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7cmlnaHQ6MTRweDtib3R0b206MTRweDt6LWluZGV4OjIxNDc0ODMwMDU7bWF4LXdpZHRoOjM2MHB4OydcbiAgICAgICAgICAgICsgJ3BhZGRpbmc6OXB4IDEycHg7Ym9yZGVyLXJhZGl1czo5cHg7Ym94LXNoYWRvdzowIDZweCAyNHB4ICMwZjE3MmE0MDtmb250OjEycHggU2Vnb2UgVUksc2Fucy1zZXJpZjsnO1xuICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHRvYXN0KTtcbiAgICB9XG4gICAgY29uc3QgY29sb3JzID0ga2luZCA9PT0gJ2Vycm9yJ1xuICAgICAgICA/IFsnI2ZlZTJlMicsICcjOTkxYjFiJywgJyNmZWNhY2EnXVxuICAgICAgICA6IGtpbmQgPT09ICdvaycgPyBbJyNkY2ZjZTcnLCAnIzE2NjUzNCcsICcjODZlZmFjJ10gOiBbJyNlZmY2ZmYnLCAnIzFkNGVkOCcsICcjYmZkYmZlJ107XG4gICAgdG9hc3Quc3R5bGUuYmFja2dyb3VuZCA9IGNvbG9yc1swXTtcbiAgICB0b2FzdC5zdHlsZS5jb2xvciA9IGNvbG9yc1sxXTtcbiAgICB0b2FzdC5zdHlsZS5ib3JkZXIgPSBgMXB4IHNvbGlkICR7Y29sb3JzWzJdfWA7XG4gICAgdG9hc3QudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICAgIGNsZWFyVGltZW91dChtc1RvYXN0Ll90aW1lcik7XG4gICAgbXNUb2FzdC5fdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRvYXN0LnJlbW92ZSgpLCBraW5kID09PSAnZXJyb3InID8gNjAwMCA6IDI1MDApO1xufVxuXG5mdW5jdGlvbiBtc0ZpbGxTdGF0dXNTZWxlY3Qoc2VsZWN0KSB7XG4gICAgaWYgKCFzZWxlY3QpIHJldHVybjtcbiAgICBjb25zdCBwcmV2aW91cyA9IHNlbGVjdC52YWx1ZTtcbiAgICBzZWxlY3QucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgY29uc3QgcGxhY2Vob2xkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICBwbGFjZWhvbGRlci52YWx1ZSA9ICcnO1xuICAgIHBsYWNlaG9sZGVyLnRleHRDb250ZW50ID0gJ+KAlCDQstGL0LHQtdGA0LjRgtC1INGB0YLQsNGC0YPRgSDigJQnO1xuICAgIHNlbGVjdC5hcHBlbmRDaGlsZChwbGFjZWhvbGRlcik7XG4gICAgaGFja2VyU3RhdGVzLmZvckVhY2goc3RhdGUgPT4ge1xuICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgb3B0aW9uLnZhbHVlID0gc3RhdGUuaHJlZjtcbiAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gc3RhdGUubmFtZTtcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gICAgfSk7XG4gICAgaWYgKFsuLi5zZWxlY3Qub3B0aW9uc10uc29tZShvcHRpb24gPT4gb3B0aW9uLnZhbHVlID09PSBwcmV2aW91cykpIHNlbGVjdC52YWx1ZSA9IHByZXZpb3VzO1xufVxuXG5mdW5jdGlvbiBjbG9zZU1zT3JkZXJTdGF0dXNQb3B1cCgpIHtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNPcmRlclN0YXR1c1BvcHVwJyk/LnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBvcGVuTXNPcmRlclN0YXR1c1BvcHVwKGFuY2hvcikge1xuICAgIGNvbnN0IG9sZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY09yZGVyU3RhdHVzUG9wdXAnKTtcbiAgICBpZiAob2xkKSB7IG9sZC5yZW1vdmUoKTsgcmV0dXJuOyB9XG4gICAgY29uc3QgcG9wdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBwb3B1cC5pZCA9ICdtY09yZGVyU3RhdHVzUG9wdXAnO1xuICAgIHBvcHVwLnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7ei1pbmRleDoyMTQ3NDgzMDA0O3dpZHRoOjI4MHB4O3BhZGRpbmc6MTBweDtiYWNrZ3JvdW5kOiNmZmY7J1xuICAgICAgICArICdib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czoxMHB4O2JveC1zaGFkb3c6MCA4cHggMzBweCAjMGYxNzJhNDA7Zm9udDoxMnB4IFNlZ29lIFVJLHNhbnMtc2VyaWY7Y29sb3I6IzMzNDE1NTsnO1xuICAgIGNvbnN0IHJlY3QgPSBhbmNob3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgcG9wdXAuc3R5bGUubGVmdCA9IGAke01hdGgubWF4KDgsIE1hdGgubWluKHJlY3QubGVmdCwgd2luZG93LmlubmVyV2lkdGggLSAyOTYpKX1weGA7XG4gICAgcG9wdXAuc3R5bGUudG9wID0gYCR7TWF0aC5taW4ocmVjdC5ib3R0b20gKyA1LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSAxOTApfXB4YDtcblxuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSAn8J+OryDQodC80LXQvdC40YLRjCDRgdGC0LDRgtGD0YEg0LfQsNC60LDQt9CwJztcbiAgICBwb3B1cC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgcm93LnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2dhcDo1cHg7bWFyZ2luLXRvcDo4cHg7JztcbiAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcbiAgICBzZWxlY3QuaWQgPSAnbWNPcmRlclN0YXR1c1NlbGVjdCc7XG4gICAgc2VsZWN0LnN0eWxlLmNzc1RleHQgPSAnZmxleDoxO21pbi13aWR0aDowO3BhZGRpbmc6NnB4O2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzMzNDE1NTsnO1xuICAgIHJvdy5hcHBlbmRDaGlsZChzZWxlY3QpO1xuICAgIG1zRmlsbFN0YXR1c1NlbGVjdChzZWxlY3QpO1xuICAgIGNvbnN0IHJlZnJlc2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICByZWZyZXNoLnR5cGUgPSAnYnV0dG9uJztcbiAgICByZWZyZXNoLnRleHRDb250ZW50ID0gJ+KGuyc7XG4gICAgcmVmcmVzaC50aXRsZSA9ICfQntCx0L3QvtCy0LjRgtGMINGB0L/QuNGB0L7QuiDRgdGC0LDRgtGD0YHQvtCyJztcbiAgICByZWZyZXNoLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MzJweDtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7YmFja2dyb3VuZDojZjhmYWZjO2N1cnNvcjpwb2ludGVyOyc7XG4gICAgcmVmcmVzaC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgcmVmcmVzaC5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIGhhY2tlclJlZnJlc2hTdGF0ZXModHJ1ZSkudGhlbigoKSA9PiBtc0ZpbGxTdGF0dXNTZWxlY3Qoc2VsZWN0KSkuZmluYWxseSgoKSA9PiB7IHJlZnJlc2guZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgfSk7XG4gICAgcm93LmFwcGVuZENoaWxkKHJlZnJlc2gpO1xuICAgIHBvcHVwLmFwcGVuZENoaWxkKHJvdyk7XG5cbiAgICBjb25zdCBlcnJvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGVycm9yLmlkID0gJ21jT3JkZXJTdGF0dXNFcnJvcic7XG4gICAgZXJyb3Iuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDo3cHg7Y29sb3I6Izk5MWIxYjtiYWNrZ3JvdW5kOiNmZWUyZTI7Ym9yZGVyLXJhZGl1czo2cHg7cGFkZGluZzo2cHg7JztcbiAgICBwb3B1cC5hcHBlbmRDaGlsZChlcnJvcik7XG4gICAgY29uc3QgYXBwbHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBhcHBseS50eXBlID0gJ2J1dHRvbic7XG4gICAgYXBwbHkudGV4dENvbnRlbnQgPSAn0J/QvtC80LXQvdGP0YLRjCDQuCDQvtCx0L3QvtCy0LjRgtGMINGB0YLRgNCw0L3QuNGG0YMnO1xuICAgIGFwcGx5LnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MTAwJTttYXJnaW4tdG9wOjhweDtwYWRkaW5nOjdweDtib3JkZXI6MDtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiMyNTYzZWI7Y29sb3I6I2ZmZjtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICBhcHBseS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgZG9jID0gbXNDdXJyZW50RG9jdW1lbnQoKTtcbiAgICAgICAgaWYgKCFkb2MgfHwgIXNlbGVjdC52YWx1ZSkge1xuICAgICAgICAgICAgZXJyb3IudGV4dENvbnRlbnQgPSAn0JLRi9Cx0LXRgNC40YLQtSDRgdGC0LDRgtGD0YEnO1xuICAgICAgICAgICAgZXJyb3Iuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgYXBwbHkuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICBlcnJvci5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgaGFja2VyVXBkYXRlT3JkZXJTdGF0dXMoZG9jLmlkLCBzZWxlY3QudmFsdWUpO1xuICAgICAgICAgICAgbXNUb2FzdCgn4pyFINCh0YLQsNGC0YPRgSDQuNC30LzQtdC90ZHQvS4g0J7QsdC90L7QstC70Y/RjiDRgdGC0YDQsNC90LjRhtGD4oCmJywgJ29rJyk7XG4gICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGxvY2F0aW9uLnJlbG9hZCgpLCAyNTApO1xuICAgICAgICB9IGNhdGNoIChyZWFzb24pIHtcbiAgICAgICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gcmVhc29uLm1lc3NhZ2UgfHwgU3RyaW5nKHJlYXNvbik7XG4gICAgICAgICAgICBlcnJvci5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICAgICAgICAgIGFwcGx5LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICB9KTtcbiAgICBwb3B1cC5hcHBlbmRDaGlsZChhcHBseSk7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChwb3B1cCk7XG4gICAgaWYgKCFoYWNrZXJTdGF0ZXMubGVuZ3RoKSByZWZyZXNoLmNsaWNrKCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTXNPcmRlclN0YXR1c0FjdGlvbigpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY09yZGVyU3RhdHVzQWN0aW9uJyk7XG4gICAgY29uc3QgYWxsb3dlZCA9IGhhY2tlckJlYXJlckVuYWJsZWQgJiYgISFoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkgJiYgaGFja2VyQXBpVmFsaWRhdGVkO1xuICAgIGlmICghYWxsb3dlZCB8fCBtc0N1cnJlbnREb2N1bWVudCgpPy50eXBlICE9PSAnY3VzdG9tZXJvcmRlcicpIHtcbiAgICAgICAgZXhpc3Rpbmc/LnJlbW92ZSgpO1xuICAgICAgICBjbG9zZU1zT3JkZXJTdGF0dXNQb3B1cCgpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChleGlzdGluZz8uaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICBjb25zdCBhbmNob3IgPSBtc0ZpbmRPcmRlclN0YXR1c0FuY2hvcigpO1xuICAgIGlmICghYW5jaG9yKSByZXR1cm47XG4gICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgYnV0dG9uLmlkID0gJ21jT3JkZXJTdGF0dXNBY3Rpb24nO1xuICAgIGJ1dHRvbi50eXBlID0gJ2J1dHRvbic7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gJ/Cfjq8nO1xuICAgIGJ1dHRvbi50aXRsZSA9ICfQkdGL0YHRgtGA0L4g0L/QvtC80LXQvdGP0YLRjCDRgdGC0LDRgtGD0YEg0LfQsNC60LDQt9CwJztcbiAgICBidXR0b24uc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO3dpZHRoOjI4cHg7aGVpZ2h0OjI0cHg7bWFyZ2luLXRvcDozcHg7cGFkZGluZzowO2JvcmRlcjoxcHggc29saWQgIzkzYzVmZDsnXG4gICAgICAgICsgJ2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6I2VmZjZmZjtjb2xvcjojMWQ0ZWQ4O2N1cnNvcjpwb2ludGVyO2xpbmUtaGVpZ2h0OjIycHg7JztcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBvcGVuTXNPcmRlclN0YXR1c1BvcHVwKGJ1dHRvbikpO1xuICAgIGFuY2hvci5pbnNlcnRBZGphY2VudEVsZW1lbnQoJ2FmdGVyZW5kJywgYnV0dG9uKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVNc01hZ2ljQ29uZmlnKGNvbmZpZykge1xuICAgIGlmICghY29uZmlnIHx8IHR5cGVvZiBjb25maWcgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoY29uZmlnKSkgdGhyb3cgbmV3IEVycm9yKCfQmtC+0YDQtdC90YwgSlNPTiDQtNC+0LvQttC10L0g0LHRi9GC0Ywg0L7QsdGK0LXQutGC0L7QvCcpO1xuICAgIFsnZGVtYW5kJywgJ2Nhc2hpbicsICdwYXltZW50aW4nXS5mb3JFYWNoKGtpbmQgPT4ge1xuICAgICAgICBpZiAoY29uZmlnW2tpbmRdID09IG51bGwpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2VjdGlvbiA9IGNvbmZpZ1traW5kXTtcbiAgICAgICAgaWYgKCFzZWN0aW9uIHx8IHR5cGVvZiBzZWN0aW9uICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHNlY3Rpb24pKSB0aHJvdyBuZXcgRXJyb3IoYCR7a2luZH06INC90YPQttC10L0g0L7QsdGK0LXQutGCYCk7XG4gICAgICAgIGlmIChzZWN0aW9uLmNvcGllcyAhPSBudWxsICYmICFBcnJheS5pc0FycmF5KHNlY3Rpb24uY29waWVzKSkgdGhyb3cgbmV3IEVycm9yKGAke2tpbmR9LmNvcGllczog0L3Rg9C20LXQvSDQvNCw0YHRgdC40LJgKTtcbiAgICAgICAgaWYgKHNlY3Rpb24udmFsdWVzICE9IG51bGwgJiYgIUFycmF5LmlzQXJyYXkoc2VjdGlvbi52YWx1ZXMpKSB0aHJvdyBuZXcgRXJyb3IoYCR7a2luZH0udmFsdWVzOiDQvdGD0LbQtdC9INC80LDRgdGB0LjQsmApO1xuICAgICAgICAoc2VjdGlvbi5jb3BpZXMgfHwgW10pLmZvckVhY2goKHJ1bGUsIGluZGV4KSA9PiB7XG4gICAgICAgICAgICBpZiAoIXJ1bGUgfHwgdHlwZW9mIHJ1bGUuZmllbGQgIT09ICdzdHJpbmcnIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHJ1bGUuZnJvbSkgfHwgIUFycmF5LmlzQXJyYXkocnVsZS50bykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7a2luZH0uY29waWVzWyR7aW5kZXh9XTog0L3Rg9C20L3RiyBmaWVsZCwgZnJvbSDQuCB0b2ApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgKHNlY3Rpb24udmFsdWVzIHx8IFtdKS5mb3JFYWNoKChydWxlLCBpbmRleCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFydWxlIHx8IHR5cGVvZiBydWxlLmZpZWxkICE9PSAnc3RyaW5nJyB8fCB0eXBlb2YgcnVsZS52YWx1ZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7a2luZH0udmFsdWVzWyR7aW5kZXh9XTog0L3Rg9C20L3RiyDRgdGC0YDQvtC60L7QstGL0LUgZmllbGQg0LggdmFsdWVgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGNvbmZpZztcbn1cblxuZnVuY3Rpb24gbG9hZE1zTWFnaWNDb25maWcoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdtc01hZ2ljQ29uZmlnX3YxJykpO1xuICAgICAgICBtc01hZ2ljQ29uZmlnID0gc2F2ZWQgPyB2YWxpZGF0ZU1zTWFnaWNDb25maWcoSlNPTi5wYXJzZShzYXZlZCkpIDogSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX01TX01BR0lDX0NPTkZJRykpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ21hZ2ljLWNvbmZpZycsIGVycm9yKTtcbiAgICAgICAgbXNNYWdpY0NvbmZpZyA9IEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkoREVGQVVMVF9NU19NQUdJQ19DT05GSUcpKTtcbiAgICB9XG4gICAgcmV0dXJuIG1zTWFnaWNDb25maWc7XG59XG5cbmZ1bmN0aW9uIHNhdmVNc01hZ2ljQ29uZmlnKGNvbmZpZykge1xuICAgIG1zTWFnaWNDb25maWcgPSB2YWxpZGF0ZU1zTWFnaWNDb25maWcoY29uZmlnKTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdtc01hZ2ljQ29uZmlnX3YxJyksIEpTT04uc3RyaW5naWZ5KG1zTWFnaWNDb25maWcpKTtcbiAgICByZXR1cm4gbXNNYWdpY0NvbmZpZztcbn1cblxuZnVuY3Rpb24gc2F2ZU1zTWFnaWNWYWx1ZU92ZXJyaWRlcyhraW5kLCBvdmVycmlkZXMpIHtcbiAgICBjb25zdCBjb25maWcgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KG1zTWFnaWNDb25maWcpKTtcbiAgICBjb25zdCBzZWN0aW9uID0gY29uZmlnW2tpbmRdIHx8IHsgY29waWVzOiBbXSwgdmFsdWVzOiBbXSB9O1xuICAgIHNlY3Rpb24udmFsdWVzID0gKHNlY3Rpb24udmFsdWVzIHx8IFtdKS5tYXAoKHJ1bGUsIGluZGV4KSA9PiAoXG4gICAgICAgIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvdmVycmlkZXMsIGluZGV4KVxuICAgICAgICAgICAgPyB7IC4uLnJ1bGUsIHZhbHVlOiBTdHJpbmcob3ZlcnJpZGVzW2luZGV4XSA/PyAnJykgfVxuICAgICAgICAgICAgOiBydWxlXG4gICAgKSk7XG4gICAgY29uZmlnW2tpbmRdID0gc2VjdGlvbjtcbiAgICByZXR1cm4gc2F2ZU1zTWFnaWNDb25maWcoY29uZmlnKTtcbn1cblxuZnVuY3Rpb24gbXNGaW5kRmllbGRIb3N0cyhmaWVsZE5hbWUpIHtcbiAgICByZXR1cm4gbXNFeGFjdFRleHRFbGVtZW50cyhmaWVsZE5hbWUpXG4gICAgICAgIC5tYXAobGFiZWwgPT4gbXNGaWVsZEhvc3RGcm9tTGFiZWwobGFiZWwpKVxuICAgICAgICAuZmlsdGVyKChob3N0LCBpbmRleCwgYWxsKSA9PiBob3N0ICYmIGFsbC5pbmRleE9mKGhvc3QpID09PSBpbmRleCk7XG59XG5cbmZ1bmN0aW9uIG1zRmllbGRDb250cm9sKGhvc3QpIHtcbiAgICBpZiAoIWhvc3QpIHJldHVybiBudWxsO1xuICAgIGlmIChob3N0Lm1hdGNoZXM/LignaW5wdXQsc2VsZWN0LHRleHRhcmVhLFtjb250ZW50ZWRpdGFibGU9XCJ0cnVlXCJdLFtyb2xlPVwiY29tYm9ib3hcIl0nKSkgcmV0dXJuIGhvc3Q7XG4gICAgcmV0dXJuIGhvc3QucXVlcnlTZWxlY3Rvcignc2VsZWN0LGlucHV0Om5vdChbdHlwZT1cImhpZGRlblwiXSksdGV4dGFyZWEsW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sW3JvbGU9XCJjb21ib2JveFwiXSxidXR0b24sLmItcG9wdXAtYnV0dG9uJykgfHwgaG9zdDtcbn1cblxuZnVuY3Rpb24gbXNDb250cm9sVmFsdWUoY29udHJvbCkge1xuICAgIGlmICghY29udHJvbCkgcmV0dXJuICcnO1xuICAgIGlmIChjb250cm9sIGluc3RhbmNlb2YgSFRNTFNlbGVjdEVsZW1lbnQpIHJldHVybiBjb250cm9sLnNlbGVjdGVkT3B0aW9uc1swXT8udGV4dENvbnRlbnQudHJpbSgpIHx8ICcnO1xuICAgIGlmICgndmFsdWUnIGluIGNvbnRyb2wgJiYgU3RyaW5nKGNvbnRyb2wudmFsdWUgfHwgJycpLnRyaW0oKSkgcmV0dXJuIFN0cmluZyhjb250cm9sLnZhbHVlKS50cmltKCk7XG4gICAgcmV0dXJuIChjb250cm9sLnRleHRDb250ZW50IHx8ICcnKS5yZXBsYWNlKC9bw5finJXilr7ilrxdL2csICcnKS50cmltKCk7XG59XG5cbmZ1bmN0aW9uIG1zRGlzcGF0Y2hDb250cm9sRXZlbnRzKGNvbnRyb2wpIHtcbiAgICBbJ2lucHV0JywgJ2NoYW5nZScsICdrZXl1cCcsICdibHVyJ10uZm9yRWFjaCh0eXBlID0+IGNvbnRyb2wuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQodHlwZSwgeyBidWJibGVzOiB0cnVlIH0pKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1zUGlja0N1c3RvbU9wdGlvbihvcGVuZXIsIHZhbHVlKSB7XG4gICAgb3BlbmVyLmNsaWNrKCk7XG4gICAgYXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDEwMCkpO1xuICAgIGNvbnN0IG9wdGlvbiA9IG1zRXhhY3RUZXh0RWxlbWVudHModmFsdWUpLmZpbmQoZWxlbWVudCA9PiB7XG4gICAgICAgIGNvbnN0IGNsaWNrYWJsZSA9IGVsZW1lbnQuY2xvc2VzdCgnW3JvbGU9XCJvcHRpb25cIl0sbGksYnV0dG9uLGEsdGQsZGl2Jyk7XG4gICAgICAgIHJldHVybiBjbGlja2FibGUgJiYgbXNWaXNpYmxlKGNsaWNrYWJsZSkgJiYgIWNsaWNrYWJsZS5jbG9zZXN0KCcjbWNNYWdpY1BvcHVwJykgJiYgIW9wZW5lci5jb250YWlucyhjbGlja2FibGUpO1xuICAgIH0pO1xuICAgIGNvbnN0IGNsaWNrYWJsZSA9IG9wdGlvbj8uY2xvc2VzdCgnW3JvbGU9XCJvcHRpb25cIl0sbGksYnV0dG9uLGEsdGQsZGl2Jyk7XG4gICAgaWYgKCFjbGlja2FibGUpIHJldHVybiBmYWxzZTtcbiAgICBjbGlja2FibGUuY2xpY2soKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgNjApKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbXNTZXRDb250cm9sVmFsdWUoY29udHJvbCwgdmFsdWUpIHtcbiAgICBpZiAoIWNvbnRyb2wgfHwgIXZhbHVlKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGNvbnRyb2wgaW5zdGFuY2VvZiBIVE1MU2VsZWN0RWxlbWVudCkge1xuICAgICAgICBjb25zdCBvcHRpb24gPSBbLi4uY29udHJvbC5vcHRpb25zXS5maW5kKGl0ZW0gPT4gaXRlbS50ZXh0Q29udGVudC50cmltKCkgPT09IHZhbHVlIHx8IGl0ZW0udmFsdWUgPT09IHZhbHVlKTtcbiAgICAgICAgaWYgKCFvcHRpb24pIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29udHJvbC52YWx1ZSA9IG9wdGlvbi52YWx1ZTtcbiAgICAgICAgbXNEaXNwYXRjaENvbnRyb2xFdmVudHMoY29udHJvbCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxJbnB1dEVsZW1lbnQgfHwgY29udHJvbCBpbnN0YW5jZW9mIEhUTUxUZXh0QXJlYUVsZW1lbnQpIHtcbiAgICAgICAgY29uc3QgY29tYm8gPSBjb250cm9sLmNsb3Nlc3QoJ1tyb2xlPVwiY29tYm9ib3hcIl0sW2NsYXNzKj1cImNvbWJvXCIgaV0sW2NsYXNzKj1cInNlbGVjdFwiIGldJyk7XG4gICAgICAgIGlmICgoY29udHJvbC5yZWFkT25seSB8fCBjb21ibykgJiYgYXdhaXQgbXNQaWNrQ3VzdG9tT3B0aW9uKGNvbWJvIHx8IGNvbnRyb2wsIHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gICAgICAgIGlmIChjb250cm9sLnJlYWRPbmx5KSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGNvbnN0IGRlc2NyaXB0b3IgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKE9iamVjdC5nZXRQcm90b3R5cGVPZihjb250cm9sKSwgJ3ZhbHVlJyk7XG4gICAgICAgIGlmIChkZXNjcmlwdG9yPy5zZXQpIGRlc2NyaXB0b3Iuc2V0LmNhbGwoY29udHJvbCwgdmFsdWUpOyBlbHNlIGNvbnRyb2wudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgbXNEaXNwYXRjaENvbnRyb2xFdmVudHMoY29udHJvbCk7XG4gICAgICAgIHJldHVybiBtc0NvbnRyb2xWYWx1ZShjb250cm9sKSA9PT0gdmFsdWU7XG4gICAgfVxuICAgIGlmIChjb250cm9sLmlzQ29udGVudEVkaXRhYmxlKSB7XG4gICAgICAgIGNvbnRyb2wudGV4dENvbnRlbnQgPSB2YWx1ZTtcbiAgICAgICAgbXNEaXNwYXRjaENvbnRyb2xFdmVudHMoY29udHJvbCk7XG4gICAgICAgIHJldHVybiBtc0NvbnRyb2xWYWx1ZShjb250cm9sKSA9PT0gdmFsdWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIG1zUGlja0N1c3RvbU9wdGlvbihjb250cm9sLCB2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIG1zTmF0aXZlU2F2ZUJ1dHRvbigpIHtcbiAgICByZXR1cm4gbXNFeGFjdFRleHRFbGVtZW50cygn0KHQvtGF0YDQsNC90LjRgtGMJylcbiAgICAgICAgLm1hcChlbGVtZW50ID0+IGVsZW1lbnQuY2xvc2VzdCgnYnV0dG9uLGEsW3JvbGU9XCJidXR0b25cIl0nKSB8fCBlbGVtZW50KVxuICAgICAgICAuZmluZChlbGVtZW50ID0+IG1zVmlzaWJsZShlbGVtZW50KSk7XG59XG5cbmZ1bmN0aW9uIG1zRG9jdW1lbnRNYWdpY1J1bGVzKGtpbmQsIG92ZXJyaWRlcyA9IHt9KSB7XG4gICAgY29uc3QgYmFzZSA9IG1zTWFnaWNDb25maWdba2luZF0gfHwge307XG4gICAgcmV0dXJuIHtcbiAgICAgICAgY29waWVzOiAoYmFzZS5jb3BpZXMgfHwgW10pLm1hcChydWxlID0+ICh7IC4uLnJ1bGUgfSkpLFxuICAgICAgICB2YWx1ZXM6IChiYXNlLnZhbHVlcyB8fCBbXSkubWFwKChydWxlLCBpbmRleCkgPT4gKHtcbiAgICAgICAgICAgIC4uLnJ1bGUsXG4gICAgICAgICAgICB2YWx1ZTogT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG92ZXJyaWRlcywgaW5kZXgpID8gb3ZlcnJpZGVzW2luZGV4XSA6IHJ1bGUudmFsdWUsXG4gICAgICAgIH0pKSxcbiAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBtc0FwcGx5TWFnaWNSdWxlcyh7IHNhdmUgPSBmYWxzZSwgb3ZlcnJpZGVzID0ge30gfSA9IHt9KSB7XG4gICAgY29uc3QgZG9jID0gbXNDdXJyZW50RG9jdW1lbnQoKTtcbiAgICBpZiAoIWRvYyB8fCAhWydkZW1hbmQnLCAnY2FzaGluJywgJ3BheW1lbnRpbiddLmluY2x1ZGVzKGRvYy50eXBlKSkge1xuICAgICAgICByZXR1cm4geyBjaGFuZ2VkOiAwLCBtaXNzaW5nOiBbJ9Ce0YLQutGA0L7QudGC0LUg0J7RgtCz0YDRg9C30LrRgywg0J/RgNC40YXQvtC00L3Ri9C5INC+0YDQtNC10YAg0LjQu9C4INCS0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2J10sIGZhaWxlZDogW10gfTtcbiAgICB9XG4gICAgY29uc3QgcnVsZXMgPSBtc0RvY3VtZW50TWFnaWNSdWxlcyhkb2MudHlwZSwgb3ZlcnJpZGVzKTtcbiAgICBjb25zdCByZXN1bHQgPSB7IGNoYW5nZWQ6IDAsIG1pc3Npbmc6IFtdLCBmYWlsZWQ6IFtdIH07XG5cbiAgICBmb3IgKGNvbnN0IHJ1bGUgb2YgcnVsZXMuY29waWVzKSB7XG4gICAgICAgIGNvbnN0IGhvc3RzID0gbXNGaW5kRmllbGRIb3N0cyhydWxlLmZpZWxkKTtcbiAgICAgICAgY29uc3Qgc291cmNlID0gbXNGaWVsZENvbnRyb2woaG9zdHNbcnVsZS5mcm9tXSk7XG4gICAgICAgIGNvbnN0IHNvdXJjZVZhbHVlID0gbXNDb250cm9sVmFsdWUoc291cmNlKTtcbiAgICAgICAgaWYgKCFzb3VyY2VWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKHJ1bGUucmVxdWlyZWQpIHJlc3VsdC5taXNzaW5nLnB1c2gocnVsZS5maWVsZCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IHRhcmdldEluZGV4IG9mIHJ1bGUudG8pIHtcbiAgICAgICAgICAgIGNvbnN0IHRhcmdldCA9IG1zRmllbGRDb250cm9sKGhvc3RzW3RhcmdldEluZGV4XSk7XG4gICAgICAgICAgICBpZiAoIXRhcmdldCB8fCB0YXJnZXQgPT09IHNvdXJjZSkge1xuICAgICAgICAgICAgICAgIHJlc3VsdC5mYWlsZWQucHVzaChydWxlLmZpZWxkKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhd2FpdCBtc1NldENvbnRyb2xWYWx1ZSh0YXJnZXQsIHNvdXJjZVZhbHVlKSkgcmVzdWx0LmNoYW5nZWQgKz0gMTtcbiAgICAgICAgICAgIGVsc2UgcmVzdWx0LmZhaWxlZC5wdXNoKHJ1bGUuZmllbGQpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHJ1bGVzLnZhbHVlcy5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICAgICAgY29uc3QgcnVsZSA9IHJ1bGVzLnZhbHVlc1tpbmRleF07XG4gICAgICAgIGNvbnN0IHZhbHVlID0gU3RyaW5nKHJ1bGUudmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICAgICAgaWYgKHJ1bGUucmVxdWlyZWQpIHJlc3VsdC5taXNzaW5nLnB1c2gocnVsZS5maWVsZCk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBob3N0ID0gbXNGaW5kRmllbGRIb3N0cyhydWxlLmZpZWxkKVtydWxlLm9jY3VycmVuY2UgfHwgMF07XG4gICAgICAgIGNvbnN0IGNvbnRyb2wgPSBtc0ZpZWxkQ29udHJvbChob3N0KTtcbiAgICAgICAgaWYgKGF3YWl0IG1zU2V0Q29udHJvbFZhbHVlKGNvbnRyb2wsIHZhbHVlKSkgcmVzdWx0LmNoYW5nZWQgKz0gMTtcbiAgICAgICAgZWxzZSByZXN1bHQuZmFpbGVkLnB1c2gocnVsZS5maWVsZCk7XG4gICAgfVxuXG4gICAgcmVzdWx0Lm1pc3NpbmcgPSBbLi4ubmV3IFNldChyZXN1bHQubWlzc2luZyldO1xuICAgIHJlc3VsdC5mYWlsZWQgPSBbLi4ubmV3IFNldChyZXN1bHQuZmFpbGVkKV07XG4gICAgaWYgKHNhdmUgJiYgIXJlc3VsdC5taXNzaW5nLmxlbmd0aCAmJiAhcmVzdWx0LmZhaWxlZC5sZW5ndGgpIHtcbiAgICAgICAgY29uc3Qgc2F2ZUJ1dHRvbiA9IG1zTmF0aXZlU2F2ZUJ1dHRvbigpO1xuICAgICAgICBpZiAoc2F2ZUJ1dHRvbikgc2F2ZUJ1dHRvbi5jbGljaygpOyBlbHNlIHJlc3VsdC5mYWlsZWQucHVzaCgn0JrQvdC+0L/QutCwIMKr0KHQvtGF0YDQsNC90LjRgtGMwrsnKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gY2xvc2VNc01hZ2ljUG9wdXAoKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jTWFnaWNQb3B1cCcpPy5yZW1vdmUoKTtcbn1cblxuZnVuY3Rpb24gb3Blbk1zTWFnaWNQb3B1cChhbmNob3IpIHtcbiAgICBjb25zdCBvbGQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNNYWdpY1BvcHVwJyk7XG4gICAgaWYgKG9sZCkgeyBvbGQucmVtb3ZlKCk7IHJldHVybjsgfVxuICAgIGNvbnN0IGRvYyA9IG1zQ3VycmVudERvY3VtZW50KCk7XG4gICAgaWYgKCFkb2MpIHJldHVybjtcbiAgICBjb25zdCBydWxlcyA9IG1zRG9jdW1lbnRNYWdpY1J1bGVzKGRvYy50eXBlKTtcbiAgICBjb25zdCBwb3B1cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHBvcHVwLmlkID0gJ21jTWFnaWNQb3B1cCc7XG4gICAgcG9wdXAuc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjIxNDc0ODMwMDQ7d2lkdGg6MzEwcHg7cGFkZGluZzoxMXB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7J1xuICAgICAgICArICdib3JkZXItcmFkaXVzOjEwcHg7Ym94LXNoYWRvdzowIDhweCAzMHB4ICMwZjE3MmE0MDtmb250OjEycHggU2Vnb2UgVUksc2Fucy1zZXJpZjtjb2xvcjojMzM0MTU1Oyc7XG4gICAgY29uc3QgcmVjdCA9IGFuY2hvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICBwb3B1cC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5tYXgoOCwgTWF0aC5taW4ocmVjdC5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIDMyOCkpfXB4YDtcbiAgICBwb3B1cC5zdHlsZS50b3AgPSBgJHtNYXRoLm1pbihyZWN0LmJvdHRvbSArIDUsIHdpbmRvdy5pbm5lckhlaWdodCAtIDI2MCl9cHhgO1xuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSAn8J+qhCDQl9Cw0L/QvtC70L3QuNGC0Ywg0LTQvtC60YPQvNC10L3Rgic7XG4gICAgcG9wdXAuYXBwZW5kQ2hpbGQodGl0bGUpO1xuXG4gICAgcnVsZXMuY29waWVzLmZvckVhY2gocnVsZSA9PiB7XG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdtYXJnaW4tdG9wOjhweDtwYWRkaW5nOjZweDtiYWNrZ3JvdW5kOiNmOGZhZmM7Ym9yZGVyLXJhZGl1czo2cHg7JztcbiAgICAgICAgcm93LnRleHRDb250ZW50ID0gYCR7cnVsZS5maWVsZH06INGB0LrQvtC/0LjRgNC+0LLQsNGC0Ywg0LfQvdCw0YfQtdC90LjQtSDQvNC10LbQtNGDINC/0L7Qu9GP0LzQuGA7XG4gICAgICAgIHBvcHVwLmFwcGVuZENoaWxkKHJvdyk7XG4gICAgfSk7XG4gICAgcnVsZXMudmFsdWVzLmZvckVhY2goKHJ1bGUsIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcbiAgICAgICAgbGFiZWwuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6OHB4O2ZvbnQtd2VpZ2h0OjYwMDsnO1xuICAgICAgICBsYWJlbC50ZXh0Q29udGVudCA9IHJ1bGUuZmllbGQ7XG4gICAgICAgIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICAgICAgaW5wdXQuZGF0YXNldC5tYWdpY1ZhbHVlSW5kZXggPSBTdHJpbmcoaW5kZXgpO1xuICAgICAgICBpbnB1dC52YWx1ZSA9IHJ1bGUudmFsdWUgfHwgJyc7XG4gICAgICAgIGlucHV0LnBsYWNlaG9sZGVyID0gJ9CS0LLQtdC00LjRgtC1INGC0L7Rh9C90L7QtSDQt9C90LDRh9C10L3QuNC1INC40Lcg0YHQv9C40YHQutCwINCc0L7QudCh0LrQu9Cw0LQnO1xuICAgICAgICBpbnB1dC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTtib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luLXRvcDozcHg7cGFkZGluZzo2cHg7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6NnB4Oyc7XG4gICAgICAgIGxhYmVsLmFwcGVuZENoaWxkKGlucHV0KTtcbiAgICAgICAgcG9wdXAuYXBwZW5kQ2hpbGQobGFiZWwpO1xuICAgIH0pO1xuICAgIGNvbnN0IGVycm9yID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgZXJyb3Iuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDo4cHg7cGFkZGluZzo2cHg7YmFja2dyb3VuZDojZmVlMmUyO2NvbG9yOiM5OTFiMWI7Ym9yZGVyLXJhZGl1czo2cHg7JztcbiAgICBwb3B1cC5hcHBlbmRDaGlsZChlcnJvcik7XG4gICAgY29uc3QgYXBwbHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBhcHBseS50eXBlID0gJ2J1dHRvbic7XG4gICAgYXBwbHkudGV4dENvbnRlbnQgPSAn8J+qhCDQl9Cw0L/QvtC70L3QuNGC0Ywg0Lgg0YHQvtGF0YDQsNC90LjRgtGMJztcbiAgICBhcHBseS5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjEwMCU7bWFyZ2luLXRvcDo5cHg7cGFkZGluZzo4cHg7Ym9yZGVyOjA7Ym9yZGVyLXJhZGl1czo3cHg7YmFja2dyb3VuZDojMTZhMzRhO2NvbG9yOiNmZmY7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyOyc7XG4gICAgYXBwbHkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGFwcGx5LmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgY29uc3Qgb3ZlcnJpZGVzID0ge307XG4gICAgICAgIHBvcHVwLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLW1hZ2ljLXZhbHVlLWluZGV4XScpLmZvckVhY2goaW5wdXQgPT4geyBvdmVycmlkZXNbaW5wdXQuZGF0YXNldC5tYWdpY1ZhbHVlSW5kZXhdID0gaW5wdXQudmFsdWU7IH0pO1xuICAgICAgICBzYXZlTXNNYWdpY1ZhbHVlT3ZlcnJpZGVzKGRvYy50eXBlLCBvdmVycmlkZXMpO1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBtc0FwcGx5TWFnaWNSdWxlcyh7IHNhdmU6IHRydWUsIG92ZXJyaWRlcyB9KTtcbiAgICAgICAgaWYgKHJlc3VsdC5taXNzaW5nLmxlbmd0aCB8fCByZXN1bHQuZmFpbGVkLmxlbmd0aCkge1xuICAgICAgICAgICAgY29uc3QgZGV0YWlscyA9IFtcbiAgICAgICAgICAgICAgICByZXN1bHQubWlzc2luZy5sZW5ndGggPyBg0JfQsNC/0L7Qu9C90LjRgtC1OiAke3Jlc3VsdC5taXNzaW5nLmpvaW4oJywgJyl9YCA6ICcnLFxuICAgICAgICAgICAgICAgIHJlc3VsdC5mYWlsZWQubGVuZ3RoID8gYNCd0LUg0YPQtNCw0LvQvtGB0Ywg0YPRgdGC0LDQvdC+0LLQuNGC0Yw6ICR7cmVzdWx0LmZhaWxlZC5qb2luKCcsICcpfWAgOiAnJ1xuICAgICAgICAgICAgXS5maWx0ZXIoQm9vbGVhbikuam9pbignLiAnKTtcbiAgICAgICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gZGV0YWlscztcbiAgICAgICAgICAgIGVycm9yLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xuICAgICAgICAgICAgYXBwbHkuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBtc1RvYXN0KGDinIUg0JfQsNC/0L7Qu9C90LXQvdC+INC/0L7Qu9C10Lk6ICR7cmVzdWx0LmNoYW5nZWR9LiDQodC+0YXRgNCw0L3Rj9GO4oCmYCwgJ29rJyk7XG4gICAgICAgIGNsb3NlTXNNYWdpY1BvcHVwKCk7XG4gICAgfSk7XG4gICAgcG9wdXAuYXBwZW5kQ2hpbGQoYXBwbHkpO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQocG9wdXApO1xufVxuXG5mdW5jdGlvbiBidWlsZE1zTWFnaWNGaWxsQWN0aW9uKCkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jTWFnaWNGaWxsQWN0aW9uJyk7XG4gICAgLy8g0JTQviA4LjAuMi1iZXRhINC/0LDQu9C+0YfQutCwINC20LjQu9CwINGA0Y/QtNC+0Lwg0YEg0L/QtdGA0LLRi9C8INC90LDRgdGC0YDQvtC10L3QvdGL0Lwg0L/QvtC70LXQvC4g0KPQtNCw0LvRj9C10LxcbiAgICAvLyDQvtGB0YLQsNCy0YjQuNC50YHRjyBET00g0YHRgtCw0YDQvtC5INCy0LXRgNGB0LjQuDog0YLQtdC/0LXRgNGMINC+0L3QsCDRgdGC0YDQvtC40YLRgdGPINCyINC+0LHRidC10LkgcXVpY2st0L/QsNC90LXQu9C4LlxuICAgIGlmIChleGlzdGluZykgeyBleGlzdGluZy5yZW1vdmUoKTsgY2xvc2VNc01hZ2ljUG9wdXAoKTsgfVxufVxuXG5mdW5jdGlvbiBidWlsZE1zRmllbGRzU3BvaWxlcigpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY01zRmllbGRzU3BvaWxlcicpO1xuICAgIGNvbnN0IGRvYyA9IG1zQ3VycmVudERvY3VtZW50KCk7XG4gICAgaWYgKCFkb2MpIHtcbiAgICAgICAgZXhpc3Rpbmc/LnJlbW92ZSgpO1xuICAgICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1tYy1uYXRpdmUtb3RoZXItZmllbGRzXScpLmZvckVhY2goZWxlbWVudCA9PiB7XG4gICAgICAgICAgICBlbGVtZW50LnN0eWxlLmRpc3BsYXkgPSBlbGVtZW50LmRhdGFzZXQubWNOYXRpdmVPdGhlckZpZWxkcztcbiAgICAgICAgICAgIGRlbGV0ZSBlbGVtZW50LmRhdGFzZXQubWNOYXRpdmVPdGhlckZpZWxkcztcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGV4aXN0aW5nPy5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgIGNvbnN0IGxhYmVsID0gbXNFeGFjdFRleHRFbGVtZW50cygn0JTRgNGD0LPQuNC1INC/0L7Qu9GPJylbMF07XG4gICAgY29uc3QgbmF0aXZlID0gbGFiZWw/LmNsb3Nlc3QoJ2J1dHRvbixbcm9sZT1cImJ1dHRvblwiXSxhJykgfHwgbGFiZWw7XG4gICAgaWYgKCFuYXRpdmUgfHwgIW5hdGl2ZS5wYXJlbnRFbGVtZW50KSByZXR1cm47XG5cbiAgICBjb25zdCBleHBhbmRlZCA9IG5hdGl2ZS5nZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnKSA9PT0gJ3RydWUnO1xuICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGJ1dHRvbi5pZCA9ICdtY01zRmllbGRzU3BvaWxlcic7XG4gICAgYnV0dG9uLnR5cGUgPSAnYnV0dG9uJztcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBgJHtleHBhbmRlZCA/ICfilr4nIDogJ+KWuCd9INCU0L7Qv9C+0LvQvdC40YLQtdC70YzQvdGL0LUg0L/QvtC70Y9gO1xuICAgIGJ1dHRvbi5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6bWluKDQ4MHB4LDEwMCUpO21hcmdpbjo3cHggMDtwYWRkaW5nOjdweCAxMHB4O3RleHQtYWxpZ246bGVmdDsnXG4gICAgICAgICsgJ2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiNmOGZhZmM7Y29sb3I6IzQ3NTU2OTtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIG5hdGl2ZS5jbGljaygpO1xuICAgICAgICBjb25zdCBub3dFeHBhbmRlZCA9IG5hdGl2ZS5nZXRBdHRyaWJ1dGUoJ2FyaWEtZXhwYW5kZWQnKSA9PT0gJ3RydWUnXG4gICAgICAgICAgICB8fCBidXR0b24uZGF0YXNldC5leHBhbmRlZCAhPT0gJ3RydWUnO1xuICAgICAgICBidXR0b24uZGF0YXNldC5leHBhbmRlZCA9IFN0cmluZyhub3dFeHBhbmRlZCk7XG4gICAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGAke25vd0V4cGFuZGVkID8gJ+KWvicgOiAn4pa4J30g0JTQvtC/0L7Qu9C90LjRgtC10LvRjNC90YvQtSDQv9C+0LvRj2A7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnKSwgU3RyaW5nKG5vd0V4cGFuZGVkKSk7XG4gICAgfSk7XG4gICAgbmF0aXZlLmluc2VydEFkamFjZW50RWxlbWVudCgnYWZ0ZXJlbmQnLCBidXR0b24pO1xuICAgIG5hdGl2ZS5kYXRhc2V0Lm1jTmF0aXZlT3RoZXJGaWVsZHMgPSBuYXRpdmUuc3R5bGUuZGlzcGxheSB8fCAnJztcbiAgICBuYXRpdmUuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbn1cblxuZnVuY3Rpb24gcmVjb25jaWxlTXNFbmhhbmNlbWVudHMoKSB7XG4gICAgaWYgKCEvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSByZXR1cm47XG4gICAgYnVpbGRNc1F1aWNrUGFuZWwoKTtcbiAgICBidWlsZE1zT3JkZXJTdGF0dXNBY3Rpb24oKTtcbiAgICBpZiAodHlwZW9mIGJ1aWxkTXNNYWdpY0ZpbGxBY3Rpb24gPT09ICdmdW5jdGlvbicpIGJ1aWxkTXNNYWdpY0ZpbGxBY3Rpb24oKTtcbiAgICBpZiAodHlwZW9mIGJ1aWxkTXNGaWVsZHNTcG9pbGVyID09PSAnZnVuY3Rpb24nKSBidWlsZE1zRmllbGRzU3BvaWxlcigpO1xufVxuXG5mdW5jdGlvbiBtc1F1aWNrUGFuZWxJc0hlYWx0aHkoKSB7XG4gICAgaWYgKCEvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpIHx8ICFtc1F1aWNrUGFuZWxFbmFibGVkKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCBraW5kID0gT2JqZWN0LmtleXMoTVNfUVVJQ0tfUEFORUxfQ09ORklHKS5maW5kKGsgPT4gTVNfUVVJQ0tfUEFORUxfQ09ORklHW2tdLm1hcmtlcigpKTtcbiAgICBpZiAoIWtpbmQpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IGNmZyA9IE1TX1FVSUNLX1BBTkVMX0NPTkZJR1traW5kXTtcbiAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1F1aWNrUGFuZWwnKTtcbiAgICBjb25zdCBzaWduYXR1cmUgPSBbY2ZnLm1hZ2ljID8gJ21hZ2ljJyA6ICcnLCAuLi5jZmcuY3JlYXRlLCAuLi5jZmcucHJpbnRdLmpvaW4oJ1xcdTAwMWYnKTtcbiAgICBjb25zdCBxdWlja0VuYWJsZWQgPSBIQUNLRVJfUVVJQ0tfQVBJX1JPV19FTkFCTEVEICYmIGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQ7XG4gICAgY29uc3QgZXhwZWN0ZWRCdXR0b25Db3VudCA9IGNmZy5jcmVhdGUubGVuZ3RoICsgY2ZnLnByaW50Lmxlbmd0aCArIChjZmcubWFnaWMgPyAxIDogMCk7XG4gICAgcmV0dXJuICEhcGFuZWwgJiYgcGFuZWwuaXNDb25uZWN0ZWQgJiYgcGFuZWwuZGF0YXNldC5raW5kID09PSBraW5kXG4gICAgICAgICYmIHBhbmVsLmRhdGFzZXQucXVpY2tTaWduYXR1cmUgPT09IHNpZ25hdHVyZVxuICAgICAgICAmJiBwYW5lbC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGggPT09IGV4cGVjdGVkQnV0dG9uQ291bnRcbiAgICAgICAgJiYgKCFjZmcubWFnaWMgfHwgcGFuZWwucXVlcnlTZWxlY3RvcignI21jTWFnaWNQYW5lbEFjdGlvbicpPy5pc0Nvbm5lY3RlZClcbiAgICAgICAgJiYgKCFxdWlja0VuYWJsZWQgfHwgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSGFja2VyUXVpY2tSb3cnKT8uaXNDb25uZWN0ZWQpO1xufVxuXG5mdW5jdGlvbiBzdGFydE1zUXVpY2tQYW5lbEtlZXBhbGl2ZSgpIHtcbiAgICBpZiAobXNRdWlja0tlZXBhbGl2ZVRpbWVyKSByZXR1cm47XG4gICAgbXNRdWlja0tlZXBhbGl2ZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoIW1zUXVpY2tQYW5lbElzSGVhbHRoeSgpKSBidWlsZE1zUXVpY2tQYW5lbCgpO1xuICAgIH0sIDEwMDApO1xufVxuXG5mdW5jdGlvbiBzdGFydE1zU3BhT2JzZXJ2ZXIoKSB7XG4gICAgaWYgKCEvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpIHx8IG1zU3BhT2JzZXJ2ZXIpIHJldHVybjtcbiAgICByZWNvbmNpbGVNc0VuaGFuY2VtZW50cygpO1xuICAgIHN0YXJ0TXNRdWlja1BhbmVsS2VlcGFsaXZlKCk7XG4gICAgbXNTcGFPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KG1zU3BhUmVjb25jaWxlVGltZXIpO1xuICAgICAgICBtc1NwYVJlY29uY2lsZVRpbWVyID0gc2V0VGltZW91dChyZWNvbmNpbGVNc0VuaGFuY2VtZW50cywgMzUwKTtcbiAgICB9KTtcbiAgICBtc1NwYU9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuYm9keSwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG59XG4iLCIvLyDilIDilIDilIAg0J7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDQvdC+0LLRi9GFINC30LDQutCw0LfQvtCyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8g0J/QtdGA0LjQvtC00LjRh9C10YHQutC4INC/0YDQvtCy0LXRgNGP0LXRgiBjdXN0b21lcm9yZGVyINCy0YvQsdGA0LDQvdC90L7QuSDQvtGA0LPQsNC90LjQt9Cw0YbQuNC4INC4INC/0L7QtNCw0ZHRgiDRgdC40LPQvdCw0Ltcbi8vINC90LAg0LrQsNC20LTQvtC8INC+0L/RgNC+0YHQtSwg0LXRgdC70Lgg0LXRgdGC0Ywg0LfQsNC60LDQtyDQsiDQvtC00L3QvtC8INC40Lcg0LLRi9Cx0YDQsNC90L3Ri9GFINGB0YLQsNGC0YPRgdC+0LIuXG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyTm9ybWFsaXplU2V0dGluZ3MocmF3KSB7XG4gICAgY29uc3QgaW50ZXJ2YWwgPSBOdW1iZXIocmF3Py5pbnRlcnZhbE1pbnV0ZXMpO1xuICAgIGNvbnN0IHRvYXN0RHVyYXRpb24gPSBOdW1iZXIocmF3Py50b2FzdER1cmF0aW9uTWludXRlcyk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZW5hYmxlZDogcmF3Py5lbmFibGVkICE9PSBmYWxzZSxcbiAgICAgICAgc291bmRFbmFibGVkOiByYXc/LnNvdW5kRW5hYmxlZCAhPT0gZmFsc2UsXG4gICAgICAgIGludGVydmFsTWludXRlczogTnVtYmVyLmlzRmluaXRlKGludGVydmFsKVxuICAgICAgICAgICAgPyBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGludGVydmFsKSkpXG4gICAgICAgICAgICA6IEhBQ0tFUl9OT1RJRklFUl9ERUZBVUxUX0lOVEVSVkFMX01JTlVURVMsXG4gICAgICAgIHRvYXN0RHVyYXRpb25NaW51dGVzOiBOdW1iZXIuaXNGaW5pdGUodG9hc3REdXJhdGlvbilcbiAgICAgICAgICAgID8gTWF0aC5taW4oMTQ0MCwgTWF0aC5tYXgoMCwgTWF0aC5yb3VuZCh0b2FzdER1cmF0aW9uKSkpXG4gICAgICAgICAgICA6IDUsXG4gICAgICAgIG9yZ2FuaXphdGlvbkhyZWZzOiBbLi4ubmV3IFNldCgoQXJyYXkuaXNBcnJheShyYXc/Lm9yZ2FuaXphdGlvbkhyZWZzKVxuICAgICAgICAgICAgPyByYXcub3JnYW5pemF0aW9uSHJlZnMgOiBbcmF3Py5vcmdhbml6YXRpb25IcmVmXSlcbiAgICAgICAgICAgIC5maWx0ZXIodmFsdWUgPT4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS50cmltKCkpKV0sXG4gICAgICAgIHN0YXR1c0hyZWZzOiBBcnJheS5pc0FycmF5KHJhdz8uc3RhdHVzSHJlZnMpXG4gICAgICAgICAgICA/IFsuLi5uZXcgU2V0KHJhdy5zdGF0dXNIcmVmcy5maWx0ZXIodmFsdWUgPT4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSkpXVxuICAgICAgICAgICAgOiBbXVxuICAgIH07XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyTG9hZFNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyT3JkZXJOb3RpZmllcl92MScpKSB8fCAne30nKTtcbiAgICAgICAgY29uc3QgbWF0Y2hlcyA9IChyYXcucmVmZXJlbmNlU2NvcGUgfHwgJycpID09PSBtc1JlZmVyZW5jZVNjb3BlO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNldHRpbmdzID0gaGFja2VyTm90aWZpZXJOb3JtYWxpemVTZXR0aW5ncyhtYXRjaGVzID8gcmF3IDogeyAuLi5yYXcsIG9yZ2FuaXphdGlvbkhyZWY6ICcnLCBvcmdhbml6YXRpb25IcmVmczogW10sIHN0YXR1c0hyZWZzOiBbXSB9KTtcbiAgICAgICAgaWYgKG1hdGNoZXMpIGhhY2tlck5vdGlmaWVyU2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU3RhdHVzU2VsZWN0aW9uSW5pdGlhbGl6ZWQgPSBtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkocmF3Py5zdGF0dXNIcmVmcyk7XG4gICAgICAgIGNvbnN0IG9yZ2FuaXphdGlvbnMgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9uc192MScpKSB8fCAnW10nKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zID0gbXNSZWZlcmVuY2VTY29wZSA/IChtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLm9yZ2FuaXphdGlvbiB8fCBbXSkgOiBBcnJheS5pc0FycmF5KG9yZ2FuaXphdGlvbnMpXG4gICAgICAgICAgICA/IG9yZ2FuaXphdGlvbnMuZmlsdGVyKGl0ZW0gPT4gaXRlbSAmJiB0eXBlb2YgaXRlbS5ocmVmID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgaXRlbS5uYW1lID09PSAnc3RyaW5nJylcbiAgICAgICAgICAgIDogW107XG4gICAgICAgIGNvbnN0IHNlZW4gPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScpKSB8fCAne30nKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTZWVuQnlPcmdhbml6YXRpb24gPSBzZWVuICYmIHR5cGVvZiBzZWVuID09PSAnb2JqZWN0JyA/IHNlZW4gOiB7fTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBoYWNrZXJOb3RpZmllclNldHRpbmdzID0gaGFja2VyTm90aWZpZXJOb3JtYWxpemVTZXR0aW5ncyh7fSk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucyA9IFtdO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNlZW5CeU9yZ2FuaXphdGlvbiA9IHt9O1xuICAgICAgICBoYWNrZXJOb3RpZmllclN0YXR1c1NlbGVjdGlvbkluaXRpYWxpemVkID0gZmFsc2U7XG4gICAgICAgIGRlYnVnRXJyb3IoJ2hhY2tlci1ub3RpZmllcicsICfQndC1INGD0LTQsNC70L7RgdGMINC30LDQs9GA0YPQt9C40YLRjCDQvdCw0YHRgtGA0L7QudC60LgnLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclNhdmVTZXR0aW5ncygpIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyksIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIC4uLmhhY2tlck5vdGlmaWVyU2V0dGluZ3MsIC4uLihtc1JlZmVyZW5jZVNjb3BlID8geyByZWZlcmVuY2VTY29wZTogbXNSZWZlcmVuY2VTY29wZSB9IDoge30pXG4gICAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdoYWNrZXItbm90aWZpZXInLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L3QsNGB0YLRgNC+0LnQutC4JywgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJTYXZlT3JnYW5pemF0aW9ucygpIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnNfdjEnKSwgSlNPTi5zdHJpbmdpZnkoaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignaGFja2VyLW5vdGlmaWVyJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC+0YDQs9Cw0L3QuNC30LDRhtC40LgnLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclNhdmVTZWVuKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScpLCBKU09OLnN0cmluZ2lmeShoYWNrZXJOb3RpZmllclNlZW5CeU9yZ2FuaXphdGlvbikpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ2hhY2tlci1ub3RpZmllcicsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQuNGB0YLQvtGA0LjRjiDQt9Cw0LrQsNC30L7QsicsIGVycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU2V0U3RhdHVzKG1lc3NhZ2UsIGtpbmQgPSAnaW5mbycpIHtcbiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllclN0YXR1cycpO1xuICAgIGlmICghZWwpIHJldHVybjtcbiAgICBlbC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gICAgZWwuc3R5bGUuY29sb3IgPSBraW5kID09PSAnZXJyb3InID8gJyNiOTFjMWMnIDoga2luZCA9PT0gJ29rJyA/ICcjMTY2NTM0JyA6ICcjNjQ3NDhiJztcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJGaWxsQ29udHJvbHMocm9vdCA9IGRvY3VtZW50KSB7XG4gICAgY29uc3Qgb3JnYW5pemF0aW9uID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcjaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb24nKTtcbiAgICBpZiAob3JnYW5pemF0aW9uKSB7XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gaGFja2VyTm90aWZpZXJTZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcztcbiAgICAgICAgb3JnYW5pemF0aW9uLmlubmVySFRNTCA9ICcnO1xuICAgICAgICBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMuZm9yRWFjaChpdGVtID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgICAgICAgICAgb3B0aW9uLnZhbHVlID0gaXRlbS5ocmVmO1xuICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gaXRlbS5uYW1lO1xuICAgICAgICAgICAgb3B0aW9uLnRpdGxlID0gaXRlbS5uYW1lO1xuICAgICAgICAgICAgb3B0aW9uLnNlbGVjdGVkID0gc2VsZWN0ZWQuaW5jbHVkZXMoaXRlbS5ocmVmKTtcbiAgICAgICAgICAgIG9yZ2FuaXphdGlvbi5hcHBlbmRDaGlsZChvcHRpb24pO1xuICAgICAgICB9KTtcbiAgICAgICAgc2VsZWN0ZWQuZm9yRWFjaChocmVmID0+IGludGVybmFsT3JkZXJDaGVja0FkZFNhdmVkT3B0aW9uKG9yZ2FuaXphdGlvbiwgaHJlZiwgJ9Cw0Y8g0L7RgNCz0LDQvdC40LfQsNGG0LjRjycpKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGF0dXNlcyA9IHJvb3QucXVlcnlTZWxlY3RvcignI2hhY2tlck5vdGlmaWVyU3RhdHVzZXMnKTtcbiAgICBpZiAoc3RhdHVzZXMpIHtcbiAgICAgICAgc3RhdHVzZXMuaW5uZXJIVE1MID0gJyc7XG4gICAgICAgIGhhY2tlclN0YXRlcy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgICAgICBvcHRpb24udmFsdWUgPSBpdGVtLmhyZWY7XG4gICAgICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSBpdGVtLm5hbWU7XG4gICAgICAgICAgICBvcHRpb24uc2VsZWN0ZWQgPSBoYWNrZXJOb3RpZmllclNldHRpbmdzLnN0YXR1c0hyZWZzLmluY2x1ZGVzKGl0ZW0uaHJlZik7XG4gICAgICAgICAgICBzdGF0dXNlcy5hcHBlbmRDaGlsZChvcHRpb24pO1xuICAgICAgICB9KTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zdGF0dXNIcmVmcy5mb3JFYWNoKGhyZWYgPT4gaW50ZXJuYWxPcmRlckNoZWNrQWRkU2F2ZWRPcHRpb24oc3RhdHVzZXMsIGhyZWYsICfRi9C5INGB0YLQsNGC0YPRgScpKTtcbiAgICB9XG4gICAgY29uc3QgZW5hYmxlZCA9IHJvb3QucXVlcnlTZWxlY3RvcignI2hhY2tlck5vdGlmaWVyRW5hYmxlZCcpO1xuICAgIGlmIChlbmFibGVkKSBlbmFibGVkLmNoZWNrZWQgPSBoYWNrZXJOb3RpZmllclNldHRpbmdzLmVuYWJsZWQ7XG4gICAgY29uc3Qgc291bmRFbmFibGVkID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcjaGFja2VyTm90aWZpZXJTb3VuZEVuYWJsZWQnKTtcbiAgICBpZiAoc291bmRFbmFibGVkKSBzb3VuZEVuYWJsZWQuY2hlY2tlZCA9IGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc291bmRFbmFibGVkO1xuICAgIGNvbnN0IGludGVydmFsID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcjaGFja2VyTm90aWZpZXJJbnRlcnZhbCcpO1xuICAgIGlmIChpbnRlcnZhbCkgaW50ZXJ2YWwudmFsdWUgPSBTdHJpbmcoaGFja2VyTm90aWZpZXJTZXR0aW5ncy5pbnRlcnZhbE1pbnV0ZXMpO1xuICAgIGNvbnN0IHRvYXN0RHVyYXRpb24gPSByb290LnF1ZXJ5U2VsZWN0b3IoJyNoYWNrZXJOb3RpZmllclRvYXN0RHVyYXRpb24nKTtcbiAgICBpZiAodG9hc3REdXJhdGlvbikgdG9hc3REdXJhdGlvbi52YWx1ZSA9IFN0cmluZyhoYWNrZXJOb3RpZmllclNldHRpbmdzLnRvYXN0RHVyYXRpb25NaW51dGVzKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJTZWxlY3REZWZhdWx0U3RhdHVzKCkge1xuICAgIGlmIChoYWNrZXJOb3RpZmllclN0YXR1c1NlbGVjdGlvbkluaXRpYWxpemVkIHx8ICFoYWNrZXJTdGF0ZXMubGVuZ3RoKSByZXR1cm47XG4gICAgY29uc3QgZnJlc2ggPSBoYWNrZXJTdGF0ZXMuZmluZChpdGVtID0+IFN0cmluZyhpdGVtLm5hbWUgfHwgJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpID09PSAn0L3QvtCy0YvQuScpO1xuICAgIGlmIChmcmVzaCkge1xuICAgICAgICBoYWNrZXJOb3RpZmllclNldHRpbmdzLnN0YXR1c0hyZWZzID0gW2ZyZXNoLmhyZWZdO1xuICAgICAgICBoYWNrZXJOb3RpZmllclN0YXR1c1NlbGVjdGlvbkluaXRpYWxpemVkID0gdHJ1ZTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTYXZlU2V0dGluZ3MoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyUmVmcmVzaE9yZ2FuaXphdGlvbnMocXVpZXQgPSBmYWxzZSkge1xuICAgIHJldHVybiBtc1JlZmVyZW5jZUxvYWQoJ29yZ2FuaXphdGlvbicsIHsgZm9yY2U6IHRydWUgfSlcbiAgICAgICAgLnRoZW4oaXRlbXMgPT4ge1xuICAgICAgICAgICAgaWYgKCFxdWlldCkgaGFja2VyTG9nKGDQntGA0LPQsNC90LjQt9Cw0YbQuNC4INC+0LHQvdC+0LLQu9C10L3RizogJHtoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMubGVuZ3RofSDRiNGCLmAsICdvaycpO1xuICAgICAgICAgICAgcmV0dXJuIGl0ZW1zO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgaWYgKCFxdWlldCkgaGFja2VyTG9nKCfQntGA0LPQsNC90LjQt9Cw0YbQuNC4OiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpO1xuICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoJ+KaoO+4jyDQndC1INGD0LTQsNC70L7RgdGMINC30LDQs9GA0YPQt9C40YLRjCDQvtGA0LPQsNC90LjQt9Cw0YbQuNC4JywgJ2Vycm9yJyk7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyUGxheUFsYXJtKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGlmICghaGFja2VyTm90aWZpZXJBdWRpbykgaGFja2VyTm90aWZpZXJBdWRpbyA9IG5ldyBBdWRpbyhIQUNLRVJfTk9USUZJRVJfQVVESU9fVVJMKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJBdWRpby5jdXJyZW50VGltZSA9IDA7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGhhY2tlck5vdGlmaWVyQXVkaW8ucGxheSgpO1xuICAgICAgICBpZiAocmVzdWx0Py5jYXRjaCkgcmVzdWx0LmNhdGNoKCgpID0+IHtcbiAgICAgICAgICAgIGhhY2tlck5vdGlmaWVyU2V0U3RhdHVzKCfimqDvuI8g0JHRgNCw0YPQt9C10YAg0LfQsNCx0LvQvtC60LjRgNC+0LLQsNC7INC30LLRg9C6IOKAlCDQvdCw0LbQvNC40YLQtSDCq9Ci0LXRgdGCINGB0LjQs9C90LDQu9CwwrsnLCAnZXJyb3InKTtcbiAgICAgICAgICAgIGhhY2tlckxvZygn0JfQstGD0Log0LfQsNCx0LvQvtC60LjRgNC+0LLQsNC9INCx0YDQsNGD0LfQtdGA0L7QvDsg0YDQsNC30YDQtdGI0LjRgtC1INCy0L7RgdC/0YDQvtC40LfQstC10LTQtdC90LjQtSDQutC90L7Qv9C60L7QuSDCq9Ci0LXRgdGCINGB0LjQs9C90LDQu9CwwrsnLCAnd2FybicpO1xuICAgICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBoYWNrZXJMb2coJ9CX0LLRg9C6OiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJFbnN1cmVJbmRpY2F0b3IoKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllcikgcmV0dXJuIG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllci5pbmRpY2F0b3IoKTtcbiAgICBsZXQgaW5kaWNhdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlck5vdGlmaWVySW5kaWNhdG9yJyk7XG4gICAgaWYgKCFoYWNrZXJOb3RpZmllclRpbWVyKSB7XG4gICAgICAgIGluZGljYXRvcj8ucmVtb3ZlKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGluZGljYXRvcikgcmV0dXJuO1xuICAgIGluZGljYXRvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcbiAgICBpbmRpY2F0b3IuaWQgPSAnaGFja2VyTm90aWZpZXJJbmRpY2F0b3InO1xuICAgIGluZGljYXRvci50ZXh0Q29udGVudCA9ICfwn5C7JztcbiAgICBpbmRpY2F0b3IudGl0bGUgPSAn0J7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDQvdC+0LLRi9GFINC30LDQutCw0LfQvtCyINCy0LrQu9GO0YfRkdC9JztcbiAgICBpbmRpY2F0b3Iuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgaW5kaWNhdG9yLnRpdGxlKTtcbiAgICBpbmRpY2F0b3Iuc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjpmaXhlZDtyaWdodDoxNHB4O2JvdHRvbToxMnB4O3otaW5kZXg6MjE0NzQ4MzAwMDsnXG4gICAgICAgICsgJ2ZvbnQtc2l6ZToxOHB4O2xpbmUtaGVpZ2h0OjE7b3BhY2l0eTouMjg7ZmlsdGVyOmdyYXlzY2FsZSguMzUpOydcbiAgICAgICAgKyAncG9pbnRlci1ldmVudHM6bm9uZTt1c2VyLXNlbGVjdDpub25lO3RyYW5zaXRpb246b3BhY2l0eSAuMnMsZmlsdGVyIC4yczsnO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaW5kaWNhdG9yKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJPcmRlclVybChvcmRlcikge1xuICAgIGNvbnN0IGlkID0gb3JkZXI/LmlkO1xuICAgIGlmICghaWQpIHJldHVybiAnJztcbiAgICBjb25zdCBvcmlnaW4gPSAvKF58XFwuKW9ubGluZVxcLm1veXNrbGFkXFwucnUkL2kudGVzdChsb2NhdGlvbi5ob3N0bmFtZSlcbiAgICAgICAgPyBsb2NhdGlvbi5vcmlnaW5cbiAgICAgICAgOiAnaHR0cHM6Ly9vbmxpbmUubW95c2tsYWQucnUnO1xuICAgIHJldHVybiBgJHtvcmlnaW59L2FwcC8jY3VzdG9tZXJvcmRlci9lZGl0P2lkPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGlkKX1gO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbkxhYmVsKG5hbWUpIHtcbiAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcbiAgICBsYWJlbC5jbGFzc05hbWUgPSAnaGFja2VyLW5vdGlmaWVyLW9yZ2FuaXphdGlvbic7XG4gICAgbGFiZWwudGV4dENvbnRlbnQgPSBuYW1lIHx8ICfQntGA0LPQsNC90LjQt9Cw0YbQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwJztcbiAgICBsYWJlbC50aXRsZSA9IGxhYmVsLnRleHRDb250ZW50O1xuICAgIGxhYmVsLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpibG9jazttYXgtd2lkdGg6MTAwJTtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpczt3aGl0ZS1zcGFjZTpub3dyYXA7Zm9udC1zaXplOjExcHg7b3BhY2l0eTouODU7JztcbiAgICByZXR1cm4gbGFiZWw7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU2hvd1RvYXN0KG9yZGVyKSB7XG4gICAgbGV0IGhvc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTm90aWZpZXJUb2FzdEhvc3QnKTtcbiAgICBpZiAoIWhvc3QpIHtcbiAgICAgICAgaG9zdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBob3N0LmlkID0gJ2hhY2tlck5vdGlmaWVyVG9hc3RIb3N0JztcbiAgICAgICAgaG9zdC5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO3RvcDoxOHB4O3JpZ2h0OjE4cHg7ei1pbmRleDoyMTQ3NDgzMDAyOydcbiAgICAgICAgICAgICsgJ2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6ZmxleC1lbmQ7Z2FwOjhweDsnXG4gICAgICAgICAgICArICd3aWR0aDptaW4oMzYwcHgsY2FsYygxMDB2dyAtIDM2cHgpKTtwb2ludGVyLWV2ZW50czpub25lOyc7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaG9zdCk7XG4gICAgfVxuXG4gICAgY29uc3QgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB0b2FzdC5jbGFzc05hbWUgPSAnaGFja2VyLW5vdGlmaWVyLXRvYXN0JztcbiAgICBjb25zdCBsaWZldGltZSA9IGhhY2tlck5vdGlmaWVyU2V0dGluZ3MudG9hc3REdXJhdGlvbk1pbnV0ZXMgKiA2MCAqIDEwMDA7XG4gICAgdG9hc3QuZGF0YXNldC5kaXNtaXNzTXMgPSBTdHJpbmcobGlmZXRpbWUpO1xuICAgIHRvYXN0LnN0eWxlLmNzc1RleHQgPSAnYm94LXNpemluZzpib3JkZXItYm94O3dpZHRoOjEwMCU7cGFkZGluZzoxMXB4IDEzcHggMTJweDsnXG4gICAgICAgICsgJ2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE0NWRlZywjMTExODI3LCMxZjI5MzcpOydcbiAgICAgICAgKyAnYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI0OCwxMTMsMTEzLC43Mik7Ym9yZGVyLWxlZnQ6NHB4IHNvbGlkICNlZjQ0NDQ7J1xuICAgICAgICArICdib3JkZXItcmFkaXVzOjEwcHg7Ym94LXNoYWRvdzowIDEwcHggMjhweCByZ2JhKDIsNiwyMywuMzUpOydcbiAgICAgICAgKyAnY29sb3I6I2Y4ZmFmYztmb250OjEycHgvMS4zNSBTZWdvZSBVSSxzYW5zLXNlcmlmO3BvaW50ZXItZXZlbnRzOmF1dG87J1xuICAgICAgICArICdvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMjJweCk7dHJhbnNpdGlvbjpvcGFjaXR5IC4xOHMgZWFzZSx0cmFuc2Zvcm0gLjE4cyBlYXNlOyc7XG5cbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRpdGxlLnN0eWxlLmNzc1RleHQgPSAnZm9udC13ZWlnaHQ6ODAwO2ZvbnQtc2l6ZToxM3B4O2xldHRlci1zcGFjaW5nOi4yNXB4O2NvbG9yOiNmZWNhY2E7JztcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfimqDvuI8g8J+Qu/CflLQg0J3QntCS0KvQmSDQl9CQ0JrQkNCXJztcbiAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbmFtZS5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbi10b3A6NXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojZmZmOyc7XG4gICAgY29uc3Qgb3JkZXJVcmwgPSBoYWNrZXJOb3RpZmllck9yZGVyVXJsKG9yZGVyKTtcbiAgICBpZiAob3JkZXJVcmwpIHtcbiAgICAgICAgY29uc3QgbGluayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTtcbiAgICAgICAgbGluay5ocmVmID0gb3JkZXJVcmw7XG4gICAgICAgIGxpbmsudGFyZ2V0ID0gJ19ibGFuayc7XG4gICAgICAgIGxpbmsucmVsID0gJ25vb3BlbmVyIG5vcmVmZXJyZXInO1xuICAgICAgICBsaW5rLnRleHRDb250ZW50ID0gb3JkZXI/Lm5hbWUgfHwgb3JkZXI/LmlkIHx8ICfQkdC10Lcg0L3QvtC80LXRgNCwJztcbiAgICAgICAgbGluay50aXRsZSA9ICfQntGC0LrRgNGL0YLRjCDQt9Cw0LrQsNC3INCyINC90L7QstC+0Lkg0LLQutC70LDQtNC60LUnO1xuICAgICAgICBsaW5rLnN0eWxlLmNzc1RleHQgPSAnY29sb3I6I2ZmZjt0ZXh0LWRlY29yYXRpb246dW5kZXJsaW5lO3RleHQtZGVjb3JhdGlvbi1jb2xvcjojZjg3MTcxOydcbiAgICAgICAgICAgICsgJ3RleHQtdW5kZXJsaW5lLW9mZnNldDoycHg7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICAgICAgbmFtZS5hcHBlbmRDaGlsZChsaW5rKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBuYW1lLnRleHRDb250ZW50ID0gb3JkZXI/Lm5hbWUgfHwgJ9CR0LXQtyDQvdC+0LzQtdGA0LAnO1xuICAgIH1cbiAgICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBzdGF0dXMuc3R5bGUuY3NzVGV4dCA9ICdtYXJnaW4tdG9wOjJweDtjb2xvcjojY2JkNWUxOyc7XG4gICAgc3RhdHVzLnRleHRDb250ZW50ID0gYNCh0YLQsNGC0YPRgTogJHtvcmRlcj8uc3RhdGVOYW1lIHx8ICfQndC+0LLRi9C5J31gO1xuICAgIHRvYXN0LmFwcGVuZCh0aXRsZSwgbmFtZSwgaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25MYWJlbChvcmRlcj8ub3JnYW5pemF0aW9uTmFtZSksIHN0YXR1cyk7XG4gICAgaWYgKG9yZGVyPy5wYXJ0aWFsKSB7XG4gICAgICAgIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgd2FybmluZy5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbi10b3A6M3B4O2NvbG9yOiNmYmJmMjQ7JztcbiAgICAgICAgd2FybmluZy50ZXh0Q29udGVudCA9ICfimqAg0J3QtdC/0L7Qu9C90YvQuSDQvtC/0YDQvtGBINC+0YDQs9Cw0L3QuNC30LDRhtC40LknO1xuICAgICAgICB0b2FzdC5hcHBlbmRDaGlsZCh3YXJuaW5nKTtcbiAgICB9XG5cbiAgICBsZXQgY2xvc2VkID0gZmFsc2U7XG4gICAgbGV0IHBhdXNlZCA9IGZhbHNlO1xuICAgIGxldCBkaXNtaXNzVGltZXIgPSBudWxsO1xuICAgIGxldCByZW1haW5pbmcgPSBsaWZldGltZTtcbiAgICBsZXQgdGltZXJTdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHJlbW92ZVRvYXN0ID0gKCkgPT4ge1xuICAgICAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgICAgIGNsb3NlZCA9IHRydWU7XG4gICAgICAgIGlmIChkaXNtaXNzVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQoZGlzbWlzc1RpbWVyKTtcbiAgICAgICAgdG9hc3QucmVtb3ZlKCk7XG4gICAgICAgIGlmICghaG9zdC5jaGlsZHJlbi5sZW5ndGgpIGhvc3QucmVtb3ZlKCk7XG4gICAgfTtcbiAgICBjb25zdCBmYWRlVG9hc3QgPSAoKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgY2xvc2VkID0gdHJ1ZTtcbiAgICAgICAgdG9hc3Quc3R5bGUub3BhY2l0eSA9ICcwJztcbiAgICAgICAgdG9hc3Quc3R5bGUudHJhbnNmb3JtID0gJ3RyYW5zbGF0ZVgoMjJweCknO1xuICAgICAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB0b2FzdC5yZW1vdmUoKTtcbiAgICAgICAgICAgIGlmICghaG9zdC5jaGlsZHJlbi5sZW5ndGgpIGhvc3QucmVtb3ZlKCk7XG4gICAgICAgIH0sIDIyMCk7XG4gICAgfTtcbiAgICBjb25zdCBzY2hlZHVsZURpc21pc3MgPSAoKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQgfHwgcGF1c2VkIHx8ICFsaWZldGltZSkgcmV0dXJuO1xuICAgICAgICB0aW1lclN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgICAgIGRpc21pc3NUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KGZhZGVUb2FzdCwgcmVtYWluaW5nKTtcbiAgICB9O1xuICAgIHRvYXN0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQgfHwgcGF1c2VkKSByZXR1cm47XG4gICAgICAgIHBhdXNlZCA9IHRydWU7XG4gICAgICAgIHRvYXN0LmRhdGFzZXQudGltZXJQYXVzZWQgPSAndHJ1ZSc7XG4gICAgICAgIGlmIChkaXNtaXNzVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQoZGlzbWlzc1RpbWVyKTtcbiAgICAgICAgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgcmVtYWluaW5nIC0gKERhdGUubm93KCkgLSB0aW1lclN0YXJ0ZWRBdCkpO1xuICAgIH0pO1xuICAgIHRvYXN0LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQgfHwgIXBhdXNlZCkgcmV0dXJuO1xuICAgICAgICBwYXVzZWQgPSBmYWxzZTtcbiAgICAgICAgdG9hc3QuZGF0YXNldC50aW1lclBhdXNlZCA9ICdmYWxzZSc7XG4gICAgICAgIHNjaGVkdWxlRGlzbWlzcygpO1xuICAgIH0pO1xuICAgIHtcbiAgICAgICAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgY2xvc2UudHlwZSA9ICdidXR0b24nO1xuICAgICAgICBjbG9zZS50ZXh0Q29udGVudCA9ICfinJUnO1xuICAgICAgICBjbG9zZS50aXRsZSA9ICfQo9C00LDQu9C40YLRjCDRg9Cy0LXQtNC+0LzQu9C10L3QuNC1JztcbiAgICAgICAgY2xvc2Uuc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjphYnNvbHV0ZTt0b3A6NXB4O3JpZ2h0OjdweDtwYWRkaW5nOjA7Ym9yZGVyOjA7J1xuICAgICAgICAgICAgKyAnYmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjojZmVjYWNhO2ZvbnQtc2l6ZToxNXB4O2xpbmUtaGVpZ2h0OjE7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICAgICAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZW1vdmVUb2FzdCk7XG4gICAgICAgIHRvYXN0LnN0eWxlLnBvc2l0aW9uID0gJ3JlbGF0aXZlJztcbiAgICAgICAgdG9hc3QuYXBwZW5kQ2hpbGQoY2xvc2UpO1xuXG4gICAgICAgIGNvbnN0IGNsb3NlQnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGNsb3NlQnV0dG9uLnR5cGUgPSAnYnV0dG9uJztcbiAgICAgICAgY2xvc2VCdXR0b24udGV4dENvbnRlbnQgPSAn0KPQtNCw0LvQuNGC0YwnO1xuICAgICAgICBjbG9zZUJ1dHRvbi5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbi10b3A6OHB4O3BhZGRpbmc6M3B4IDhweDtib3JkZXI6MXB4IHNvbGlkICM2NDc0OGI7J1xuICAgICAgICAgICAgKyAnYm9yZGVyLXJhZGl1czo1cHg7YmFja2dyb3VuZDojMzM0MTU1O2NvbG9yOiNmOGZhZmM7Zm9udC1zaXplOjEwcHg7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICAgICAgY2xvc2VCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZW1vdmVUb2FzdCk7XG4gICAgICAgIHRvYXN0LmFwcGVuZENoaWxkKGNsb3NlQnV0dG9uKTtcbiAgICB9XG4gICAgaG9zdC5hcHBlbmRDaGlsZCh0b2FzdCk7XG5cbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgICAgICB0b2FzdC5zdHlsZS5vcGFjaXR5ID0gJzEnO1xuICAgICAgICB0b2FzdC5zdHlsZS50cmFuc2Zvcm0gPSAndHJhbnNsYXRlWCgwKSc7XG4gICAgfSk7XG4gICAgc2NoZWR1bGVEaXNtaXNzKCk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyVHJhY2UobWVzc2FnZSwgZGV0YWlscyA9IG51bGwsIGtpbmQgPSAnaW5mbycpIHtcbiAgICBjb25zdCBwcmVmaXggPSAnW01lbWNoYXQ6bm90aWZpZXJdJztcbiAgICBpZiAoa2luZCA9PT0gJ2Vycm9yJykgY29uc29sZS5lcnJvcihwcmVmaXgsIG1lc3NhZ2UsIGRldGFpbHMgfHwgJycpO1xuICAgIGVsc2UgaWYgKGtpbmQgPT09ICd3YXJuJykgY29uc29sZS53YXJuKHByZWZpeCwgbWVzc2FnZSwgZGV0YWlscyB8fCAnJyk7XG4gICAgZWxzZSBjb25zb2xlLmluZm8ocHJlZml4LCBtZXNzYWdlLCBkZXRhaWxzIHx8ICcnKTtcbiAgICBoYWNrZXJMb2coYPCflI4gJHttZXNzYWdlfWAsIGtpbmQgPT09ICdlcnJvcicgPyAnZXJyJyA6IGtpbmQpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclNlbGVjdGVkU3RhdHVzTmFtZXMoKSB7XG4gICAgcmV0dXJuIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnNcbiAgICAgICAgLm1hcChocmVmID0+IGhhY2tlclN0YXRlcy5maW5kKHN0YXRlID0+IHN0YXRlLmhyZWYgPT09IGhyZWYpPy5uYW1lKVxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG5sZXQgaGFja2VyTm90aWZpZXJQb2xsQ29udHJvbGxlciA9IG51bGw7XG5hc3luYyBmdW5jdGlvbiBoYWNrZXJOb3RpZmllckZldGNoT3JnYW5pemF0aW9uKG9yZ2FuaXphdGlvbkhyZWYsIHNpZ25hbCkge1xuICAgIGNvbnN0IHJvd3MgPSBuZXcgTWFwKCk7XG4gICAgbGV0IG9mZnNldCA9IDA7XG4gICAgY29uc3QgbGltaXQgPSAxMDA7XG4gICAgd2hpbGUgKCFzaWduYWwuYWJvcnRlZCkge1xuICAgICAgICBjb25zdCBmaWx0ZXIgPSBlbmNvZGVVUklDb21wb25lbnQoJ29yZ2FuaXphdGlvbj0nICsgb3JnYW5pemF0aW9uSHJlZik7XG4gICAgICAgIGNvbnN0IHBhdGggPSBgL2VudGl0eS9jdXN0b21lcm9yZGVyP2ZpbHRlcj0ke2ZpbHRlcn0mZXhwYW5kPXN0YXRlLG9yZ2FuaXphdGlvbiZvcmRlcj1tb21lbnQsZGVzYyZsaW1pdD0ke2xpbWl0fSZvZmZzZXQ9JHtvZmZzZXR9YDtcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG1zQXBpUCgnR0VUJywgcGF0aCwgbnVsbCwgeyBzaWduYWwgfSk7XG4gICAgICAgIGlmIChzaWduYWwuYWJvcnRlZCkgcmV0dXJuIFtdO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YT8ucm93cykpIHRocm93IG5ldyBFcnJvcign0J3QtdC/0L7Qu9C90YvQuSDQvtGC0LLQtdGCINGB0L/QuNGB0LrQsCDQt9Cw0LrQsNC30L7QsicpO1xuICAgICAgICBjb25zdCBwcmV2aW91c1NpemUgPSByb3dzLnNpemU7XG4gICAgICAgIGRhdGEucm93cy5mb3JFYWNoKG9yZGVyID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gb3JkZXI/LmlkIHx8IG9yZGVyPy5tZXRhPy5ocmVmO1xuICAgICAgICAgICAgaWYgKGlkKSByb3dzLnNldChpZCwgb3JkZXIpO1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbmV4dE9mZnNldCA9IG9mZnNldCArIGRhdGEucm93cy5sZW5ndGg7XG4gICAgICAgIGNvbnN0IGhhc01vcmUgPSAhIWRhdGEubWV0YT8ubmV4dEhyZWYgfHwgKE51bWJlci5pc0Zpbml0ZShkYXRhLm1ldGE/LnNpemUpXG4gICAgICAgICAgICA/IG5leHRPZmZzZXQgPCBkYXRhLm1ldGEuc2l6ZSA6IGRhdGEucm93cy5sZW5ndGggPj0gbGltaXQpO1xuICAgICAgICBpZiAoIWhhc01vcmUpIHJldHVybiBbLi4ucm93cy52YWx1ZXMoKV07XG4gICAgICAgIGlmICghZGF0YS5yb3dzLmxlbmd0aCB8fCByb3dzLnNpemUgPT09IHByZXZpb3VzU2l6ZSkgdGhyb3cgbmV3IEVycm9yKCfQn9Cw0LPQuNC90LDRhtC40Y8g0LfQsNC60LDQt9C+0LIg0L3QtSDQv9GA0L7QtNCy0LjQs9Cw0LXRgtGB0Y8nKTtcbiAgICAgICAgb2Zmc2V0ID0gbmV4dE9mZnNldDtcbiAgICB9XG4gICAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclBvbGwoKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllcikgcmV0dXJuIG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllci5wb2xsKCk7XG4gICAgaWYgKGhhY2tlck5vdGlmaWVySW5GbGlnaHQpIHtcbiAgICAgICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0J/RgNC+0LLQtdGA0LrQsCDQv9GA0L7Qv9GD0YnQtdC90LA6INC/0YDQtdC00YvQtNGD0YnQuNC5INC30LDQv9GA0L7RgSDQtdGJ0ZEg0LLRi9C/0L7Qu9C90Y/QtdGC0YHRjycsIG51bGwsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICAgIH1cbiAgICBpZiAoIWhhY2tlck5vdGlmaWVyU2V0dGluZ3MuZW5hYmxlZCkge1xuICAgICAgICBoYWNrZXJOb3RpZmllclRyYWNlKCfQn9GA0L7QstC10YDQutCwINC/0YDQvtC/0YPRidC10L3QsDog0L7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDQstGL0LrQu9GO0YfQtdC9JywgbnVsbCwgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbXSk7XG4gICAgfVxuICAgIGlmICghaGFja2VyTm90aWZpZXJTZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGgpIHtcbiAgICAgICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0J/RgNC+0LLQtdGA0LrQsCDQv9GA0L7Qv9GD0YnQtdC90LA6INC+0YDQs9Cw0L3QuNC30LDRhtC40Y8g0L3QtSDQstGL0LHRgNCw0L3QsCcsIG51bGwsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICAgIH1cbiAgICBpZiAoIWhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnMubGVuZ3RoKSB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Cf0YDQvtCy0LXRgNC60LAg0L/RgNC+0L/Rg9GJ0LXQvdCwOiDRgdGC0LDRgtGD0YHRiyDQtNC70Y8g0L7Qv9C+0LLQtdGJ0LXQvdC40Y8g0L3QtSDQstGL0LHRgNCw0L3RiycsIG51bGwsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICAgIH1cbiAgICBpZiAoIWhhY2tlckFwaVZhbGlkYXRlZCkge1xuICAgICAgICBoYWNrZXJOb3RpZmllclRyYWNlKCfQn9GA0L7QstC10YDQutCwINC/0YDQvtC/0YPRidC10L3QsDogQVBJLdC60LvRjtGHINC10YnRkSDQvdC1INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0nLCBudWxsLCAnd2FybicpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgICB9XG4gICAgaGFja2VyTm90aWZpZXJJbkZsaWdodCA9IHRydWU7XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBoYWNrZXJOb3RpZmllclBvbGxDb250cm9sbGVyID0gY29udHJvbGxlcjtcbiAgICBjb25zdCBvcmdhbml6YXRpb25IcmVmcyA9IFsuLi5oYWNrZXJOb3RpZmllclNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzXTtcbiAgICBjb25zdCBzdGF0dXNIcmVmcyA9IFsuLi5oYWNrZXJOb3RpZmllclNldHRpbmdzLnN0YXR1c0hyZWZzXTtcbiAgICBjb25zdCBzZWxlY3RlZFN0YXR1c05hbWVzID0gaGFja2VyTm90aWZpZXJTZWxlY3RlZFN0YXR1c05hbWVzKCk7XG4gICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0JfQsNC/0YDQvtGBINC30LDQutCw0LfQvtCyJywge1xuICAgICAgICBvcmdhbml6YXRpb25zOiBvcmdhbml6YXRpb25IcmVmcy5sZW5ndGgsXG4gICAgICAgIHN0YXR1c05hbWVzOiBzZWxlY3RlZFN0YXR1c05hbWVzXG4gICAgfSk7XG4gICAgcmV0dXJuIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGluZyA9IG5ldyBNYXAoKTtcbiAgICAgICAgICAgIGNvbnN0IGZhaWxlZE9yZ2FuaXphdGlvbnMgPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3Qgb3JnYW5pemF0aW9uSHJlZiBvZiBvcmdhbml6YXRpb25IcmVmcykge1xuICAgICAgICAgICAgICAgIGxldCByb3dzO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIHJvd3MgPSBhd2FpdCBoYWNrZXJOb3RpZmllckZldGNoT3JnYW5pemF0aW9uKG9yZ2FuaXphdGlvbkhyZWYsIGNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zLmZpbmQoaXRlbSA9PiBpdGVtLmhyZWYgPT09IG9yZ2FuaXphdGlvbkhyZWYpPy5uYW1lIHx8ICfQntGA0LPQsNC90LjQt9Cw0YbQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwJztcbiAgICAgICAgICAgICAgICAgICAgZmFpbGVkT3JnYW5pemF0aW9ucy5wdXNoKG5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBoYWNrZXJMb2coJ+KaoCDQndC1INGD0LTQsNC70L7RgdGMINC/0YDQvtCy0LXRgNC40YLRjCDQvtGA0LPQsNC90LjQt9Cw0YbQuNGOJywgJ3dhcm4nLCBuYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4gW107XG4gICAgICAgICAgICAgICAgY29uc3QgY2FjaGVkTmFtZSA9IGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucy5maW5kKGl0ZW0gPT4gaXRlbS5ocmVmID09PSBvcmdhbml6YXRpb25IcmVmKT8ubmFtZTtcbiAgICAgICAgICAgICAgICBjb25zdCBidWNrZXQgPSB7IGluaXRpYWxpemVkOiB0cnVlLCBvcmRlcnM6IHt9IH07XG4gICAgICAgICAgICAgICAgcm93cy5mb3JFYWNoKG9yZGVyID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgaWQgPSBvcmRlci5pZCB8fCBvcmRlci5tZXRhPy5ocmVmO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBzdGF0ZUhyZWYgPSBvcmRlci5zdGF0ZT8ubWV0YT8uaHJlZiB8fCAnJztcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3RhdGVOYW1lID0gb3JkZXIuc3RhdGU/Lm5hbWUgfHwgJ9Cx0LXQtyDRgdGC0LDRgtGD0YHQsCc7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoZXMgPSBzdGF0dXNIcmVmcy5pbmNsdWRlcyhzdGF0ZUhyZWYpIHx8IHNlbGVjdGVkU3RhdHVzTmFtZXMuc29tZShuYW1lID0+XG4gICAgICAgICAgICAgICAgICAgICAgICBTdHJpbmcobmFtZSkudHJpbSgpLnRvTG93ZXJDYXNlKCkgPT09IFN0cmluZyhzdGF0ZU5hbWUpLnRyaW0oKS50b0xvd2VyQ2FzZSgpKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hdGNoZXMgJiYgIW1hdGNoaW5nLmhhcyhpZCkpIG1hdGNoaW5nLnNldChpZCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWQsIG5hbWU6IG9yZGVyLm5hbWUgfHwgaWQsIHN0YXRlSHJlZiwgc3RhdGVOYW1lLCBvcmdhbml6YXRpb25IcmVmLFxuICAgICAgICAgICAgICAgICAgICAgICAgb3JnYW5pemF0aW9uTmFtZTogY2FjaGVkTmFtZSB8fCBvcmRlci5vcmdhbml6YXRpb24/Lm5hbWUgfHwgJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAnXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBidWNrZXQub3JkZXJzW2lkXSA9IHsgc3RhdGVIcmVmLCBzdGF0ZU5hbWUsIHVwZGF0ZWRBdDogRGF0ZS5ub3coKSB9O1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGJ1Y2tldC5vcmRlcnMgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYnVja2V0Lm9yZGVycykuc2xpY2UoMCwgNTAwKSk7XG4gICAgICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZWVuQnlPcmdhbml6YXRpb25bb3JnYW5pemF0aW9uSHJlZl0gPSBidWNrZXQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllclNhdmVTZWVuKCk7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGluZ09yZGVycyA9IFsuLi5tYXRjaGluZy52YWx1ZXMoKV07XG4gICAgICAgICAgICBjb25zdCBwYXJ0aWFsID0gZmFpbGVkT3JnYW5pemF0aW9ucy5sZW5ndGggPiAwO1xuICAgICAgICAgICAgbWF0Y2hpbmdPcmRlcnMuZm9yRWFjaChvcmRlciA9PiB7IG9yZGVyLnBhcnRpYWwgPSBwYXJ0aWFsOyB9KTtcbiAgICAgICAgICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Ce0YLQstC10YIg0L/QvtC70YPRh9C10L0nLCB7IG9yZ2FuaXphdGlvbnM6IG9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCwgbWF0Y2hpbmdPcmRlcnM6IG1hdGNoaW5nT3JkZXJzLmxlbmd0aCB9KTtcbiAgICAgICAgICAgIGlmIChtYXRjaGluZ09yZGVycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBtYXRjaGluZ09yZGVycy5mb3JFYWNoKG9yZGVyID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaGFja2VyTG9nKGDwn5SUINCX0LDQutCw0LcgJHtvcmRlci5uYW1lfSDigJQgJHtvcmRlci5zdGF0ZU5hbWV9JHtwYXJ0aWFsID8gJyAo0L3QtdC/0L7Qu9C90YvQuSDQvtC/0YDQvtGBKScgOiAnJ31gLCBwYXJ0aWFsID8gJ3dhcm4nIDogJ29rJywgb3JkZXIub3JnYW5pemF0aW9uTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGhhY2tlck5vdGlmaWVyU2hvd1RvYXN0KG9yZGVyKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBpZiAoaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zb3VuZEVuYWJsZWQpIGhhY2tlck5vdGlmaWVyUGxheUFsYXJtKCk7XG4gICAgICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoYPCflJQg0JfQsNC60LDQt9C+0LIg0LIg0LLRi9Cx0YDQsNC90L3Ri9GFINGB0YLQsNGC0YPRgdCw0YU6ICR7bWF0Y2hpbmdPcmRlcnMubGVuZ3RofWAsICdvaycpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghcGFydGlhbCkge1xuICAgICAgICAgICAgICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Ch0L7QstC/0LDQtNC10L3QuNC5INC/0L4g0LLRi9Cx0YDQsNC90L3Ri9C8INGB0YLQsNGC0YPRgdCw0Lwg0L3QtdGCJywge1xuICAgICAgICAgICAgICAgICAgICBzZWxlY3RlZFN0YXR1c05hbWVzLFxuICAgICAgICAgICAgICAgICAgICBzZWxlY3RlZFN0YXR1c0hyZWZzOiBzdGF0dXNIcmVmc1xuICAgICAgICAgICAgICAgIH0sICd3YXJuJyk7XG4gICAgICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoYNCf0YDQvtCy0LXRgNC10L3QvjogJHtuZXcgRGF0ZSgpLnRvTG9jYWxlVGltZVN0cmluZygpfSDigJQg0YHQvtCy0L/QsNC00LXQvdC40Lkg0L3QtdGCYCwgJ2luZm8nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChwYXJ0aWFsKSBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhg4pqgINCd0LXQv9C+0LvQvdGL0Lkg0L7Qv9GA0L7RgTog0L3QtSDQv9GA0L7QstC10YDQtdC90YsgJHtmYWlsZWRPcmdhbml6YXRpb25zLmpvaW4oJywgJyl9LiDQndCw0LnQtNC10L3QviDQt9Cw0LrQsNC30L7QsjogJHttYXRjaGluZ09yZGVycy5sZW5ndGh9YCwgJ2Vycm9yJyk7XG4gICAgICAgICAgICByZXR1cm4gbWF0Y2hpbmdPcmRlcnM7XG4gICAgICAgIH0pKClcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4gW107XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllclRyYWNlKCfQntGI0LjQsdC60LAg0LfQsNC/0YDQvtGB0LAnLCB7IG1lc3NhZ2U6IGVycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvciksIGVycm9yIH0sICdlcnJvcicpO1xuICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoJ+KaoO+4jyDQntGI0LjQsdC60LAg0L/RgNC+0LLQtdGA0LrQuDogJyArIGVycm9yLm1lc3NhZ2UsICdlcnJvcicpO1xuICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgICBpZiAoaGFja2VyTm90aWZpZXJQb2xsQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgaGFja2VyTm90aWZpZXJQb2xsQ29udHJvbGxlciA9IG51bGw7XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllckluRmxpZ2h0ID0gZmFsc2U7XG4gICAgICAgIH0pO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclN0b3AoKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllcikgcmV0dXJuIG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllci5zdG9wKCk7XG4gICAgaGFja2VyTm90aWZpZXJQb2xsQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICBpZiAoaGFja2VyTm90aWZpZXJUaW1lcikgY2xlYXJJbnRlcnZhbChoYWNrZXJOb3RpZmllclRpbWVyKTtcbiAgICBoYWNrZXJOb3RpZmllclRpbWVyID0gbnVsbDtcbiAgICBoYWNrZXJOb3RpZmllckVuc3VyZUluZGljYXRvcigpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclN0YXJ0KCkge1xuICAgIGlmIChtZW1jaGF0UGxhdGZvcm0ubm90aWZpZXIpIHJldHVybiBtZW1jaGF0UGxhdGZvcm0ubm90aWZpZXIuc3RhcnQoKTtcbiAgICBoYWNrZXJOb3RpZmllclN0b3AoKTtcbiAgICBpZiAoIWhhY2tlckFwaVZhbGlkYXRlZCB8fCAhaGFja2VyTm90aWZpZXJTZXR0aW5ncy5lbmFibGVkIHx8ICFoYWNrZXJOb3RpZmllclNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCkgcmV0dXJuO1xuICAgIGhhY2tlck5vdGlmaWVyVGltZXIgPSBzZXRJbnRlcnZhbChoYWNrZXJOb3RpZmllclBvbGwsIGhhY2tlck5vdGlmaWVyU2V0dGluZ3MuaW50ZXJ2YWxNaW51dGVzICogNjAgKiAxMDAwKTtcbiAgICBoYWNrZXJOb3RpZmllckVuc3VyZUluZGljYXRvcigpO1xuICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Ci0LDQudC80LXRgCDQt9Cw0L/Rg9GJ0LXQvScsIHtcbiAgICAgICAgaW50ZXJ2YWxNaW51dGVzOiBoYWNrZXJOb3RpZmllclNldHRpbmdzLmludGVydmFsTWludXRlcyxcbiAgICAgICAgb3JnYW5pemF0aW9uSHJlZnM6IGhhY2tlck5vdGlmaWVyU2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMsXG4gICAgICAgIHN0YXR1c0hyZWZzOiBoYWNrZXJOb3RpZmllclNldHRpbmdzLnN0YXR1c0hyZWZzLFxuICAgICAgICBzdGF0dXNOYW1lczogaGFja2VyTm90aWZpZXJTZWxlY3RlZFN0YXR1c05hbWVzKClcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJNYXliZVN0YXJ0KCkge1xuICAgIGhhY2tlck5vdGlmaWVyU2VsZWN0RGVmYXVsdFN0YXR1cygpO1xuICAgIGhhY2tlck5vdGlmaWVyU3RhcnQoKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJSZWFkQ29udHJvbHMoKSB7XG4gICAgbWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyPy5lZGl0KCk7XG4gICAgY29uc3QgZW5hYmxlZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllckVuYWJsZWQnKTtcbiAgICBjb25zdCBzb3VuZEVuYWJsZWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTm90aWZpZXJTb3VuZEVuYWJsZWQnKTtcbiAgICBjb25zdCBvcmdhbml6YXRpb24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb24nKTtcbiAgICBjb25zdCBzdGF0dXNlcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllclN0YXR1c2VzJyk7XG4gICAgY29uc3QgaW50ZXJ2YWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTm90aWZpZXJJbnRlcnZhbCcpO1xuICAgIGNvbnN0IHRvYXN0RHVyYXRpb24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTm90aWZpZXJUb2FzdER1cmF0aW9uJyk7XG4gICAgaGFja2VyTm90aWZpZXJTZXR0aW5ncyA9IGhhY2tlck5vdGlmaWVyTm9ybWFsaXplU2V0dGluZ3Moe1xuICAgICAgICBlbmFibGVkOiBlbmFibGVkPy5jaGVja2VkLFxuICAgICAgICBzb3VuZEVuYWJsZWQ6IHNvdW5kRW5hYmxlZCA/IHNvdW5kRW5hYmxlZC5jaGVja2VkIDogaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zb3VuZEVuYWJsZWQsXG4gICAgICAgIG9yZ2FuaXphdGlvbkhyZWZzOiBvcmdhbml6YXRpb24gPyBbLi4ub3JnYW5pemF0aW9uLnNlbGVjdGVkT3B0aW9uc10ubWFwKG9wdGlvbiA9PiBvcHRpb24udmFsdWUpIDogaGFja2VyTm90aWZpZXJTZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcyxcbiAgICAgICAgc3RhdHVzSHJlZnM6IHN0YXR1c2VzID8gWy4uLnN0YXR1c2VzLnNlbGVjdGVkT3B0aW9uc10ubWFwKG9wdGlvbiA9PiBvcHRpb24udmFsdWUpIDogaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zdGF0dXNIcmVmcyxcbiAgICAgICAgaW50ZXJ2YWxNaW51dGVzOiBpbnRlcnZhbD8udmFsdWUsXG4gICAgICAgIHRvYXN0RHVyYXRpb25NaW51dGVzOiB0b2FzdER1cmF0aW9uPy52YWx1ZVxuICAgIH0pO1xuICAgIGhhY2tlck5vdGlmaWVyU3RhdHVzU2VsZWN0aW9uSW5pdGlhbGl6ZWQgPSB0cnVlO1xuICAgIGhhY2tlck5vdGlmaWVyU2F2ZVNldHRpbmdzKCk7XG4gICAgaGFja2VyTm90aWZpZXJNYXliZVN0YXJ0KCk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckJ1aWxkTm90aWZpZXJUYWIoKSB7XG4gICAgY29uc3Qgd3JhcCA9IGhhY2tlckVsKCdkaXYnKTtcbiAgICB3cmFwLmlkID0gJ2hhY2tlclRhYk5vdGlmaWVyJztcblxuICAgIHdyYXAuYXBwZW5kQ2hpbGQoaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTFweDtjb2xvcjojNjQ3NDhiO2xpbmUtaGVpZ2h0OjEuNDttYXJnaW4tYm90dG9tOjdweDsnLFxuICAgICAgICAn0J/RgNC+0LLQtdGA0Y/QtdGCINC30LDQutCw0LfRiyDQstGL0LHRgNCw0L3QvdGL0YUg0L7RgNCz0LDQvdC40LfQsNGG0LjQuSDQv9C+INGC0LDQudC80LXRgNGDINC4INC/0L7QtNCw0ZHRgiDQvtC00LjQvSDQvtCx0YnQuNC5INGB0LjQs9C90LDQuyDQvdCwINC60LDQttC00L7QvCDQvtC/0YDQvtGB0LUsINC/0L7QutCwINC30LDQutCw0Lcg0L3QsNGF0L7QtNC40YLRgdGPINCyINCy0YvQsdGA0LDQvdC90L7QvCDRgdGC0LDRgtGD0YHQtS4nKSk7XG5cbiAgICBjb25zdCBlbmFibGVkTGFiZWwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6IzQ3NTU2OTttYXJnaW4tYm90dG9tOjdweDtjdXJzb3I6cG9pbnRlcjsnKTtcbiAgICBjb25zdCBlbmFibGVkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICBlbmFibGVkLnR5cGUgPSAnY2hlY2tib3gnO1xuICAgIGVuYWJsZWQuaWQgPSAnaGFja2VyTm90aWZpZXJFbmFibGVkJztcbiAgICBlbmFibGVkLnN0eWxlLmFjY2VudENvbG9yID0gJyM2MzY2ZjEnO1xuICAgIGVuYWJsZWRMYWJlbC5hcHBlbmRDaGlsZChlbmFibGVkKTtcbiAgICBlbmFibGVkTGFiZWwuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoJ9CS0LrQu9GO0YfQuNGC0Ywg0L7Qv9C+0LLQtdGJ0LDRgtC10LvRjCcpKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGVuYWJsZWRMYWJlbCk7XG5cbiAgICBjb25zdCBzb3VuZExhYmVsID0gaGFja2VyRWwoJ2xhYmVsJywgJ2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweDtmb250LXNpemU6MTEuNXB4O2NvbG9yOiM0NzU1Njk7bWFyZ2luLWJvdHRvbTo3cHg7Y3Vyc29yOnBvaW50ZXI7Jyk7XG4gICAgY29uc3Qgc291bmRFbmFibGVkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICBzb3VuZEVuYWJsZWQudHlwZSA9ICdjaGVja2JveCc7XG4gICAgc291bmRFbmFibGVkLmlkID0gJ2hhY2tlck5vdGlmaWVyU291bmRFbmFibGVkJztcbiAgICBzb3VuZEVuYWJsZWQuc3R5bGUuYWNjZW50Q29sb3IgPSAnI2RjMjYyNic7XG4gICAgc291bmRMYWJlbC5hcHBlbmRDaGlsZChzb3VuZEVuYWJsZWQpO1xuICAgIHNvdW5kTGFiZWwuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoJ/CflIog0JfQstGD0LrQvtCy0L7QuSDRgdC40LPQvdCw0LsnKSk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChzb3VuZExhYmVsKTtcblxuICAgIGNvbnN0IG9yZ0xhYmVsID0gaGFja2VyRWwoJ2xhYmVsJywgJ2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjExLjVweDtjb2xvcjojNDc1NTY5O21hcmdpbi1ib3R0b206M3B4OycsICfQntGA0LPQsNC90LjQt9Cw0YbQuNC4IChDdHJsL+KMmCDigJQg0L3QtdGB0LrQvtC70YzQutC+KTonKTtcbiAgICBvcmdMYWJlbC5odG1sRm9yID0gJ2hhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9uJztcbiAgICB3cmFwLmFwcGVuZENoaWxkKG9yZ0xhYmVsKTtcbiAgICBjb25zdCBvcmdSb3cgPSBoYWNrZXJFbCgnZGl2JywgJ2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O2dhcDo0cHg7bWFyZ2luLWJvdHRvbTo2cHg7Jyk7XG4gICAgY29uc3Qgb3JnYW5pemF0aW9uID0gaGFja2VyU2VsZWN0KCdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbicsICfigJQg0LLRi9Cx0LXRgNC40YLQtSDQvtGA0LPQsNC90LjQt9Cw0YbQuNGOIOKAlCcpO1xuICAgIG9yZ2FuaXphdGlvbi5tdWx0aXBsZSA9IHRydWU7XG4gICAgb3JnYW5pemF0aW9uLnNpemUgPSA0O1xuICAgIG9yZ2FuaXphdGlvbi50aXRsZSA9ICdDdHJsL+KMmCArINC60LvQuNC6IOKAlCDQtNC+0LHQsNCy0LjRgtGMINC40LvQuCDRgdC90Y/RgtGMINCy0YvQsdC+0YA7INC/0YPRgdGC0L7QuSDQstGL0LHQvtGAINC+0YHRgtCw0L3QsNCy0LvQuNCy0LDQtdGCINC+0L/RgNC+0YEnO1xuICAgIG9yZ2FuaXphdGlvbi5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX1NFTEVDVF9DU1M7XG4gICAgb3JnUm93LmFwcGVuZENoaWxkKG9yZ2FuaXphdGlvbik7XG4gICAgY29uc3QgcmVmcmVzaE9yZyA9IGhhY2tlckJ0bignaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zUmVmcmVzaCcsICfin7MnLCBIQUNLRVJfTUlOSV9CVE5fQ1NTKTtcbiAgICByZWZyZXNoT3JnLnRpdGxlID0gJ9Ce0LHQvdC+0LLQuNGC0Ywg0YHQv9C40YHQvtC6INC+0YDQs9Cw0L3QuNC30LDRhtC40LknO1xuICAgIG9yZ1Jvdy5hcHBlbmRDaGlsZChyZWZyZXNoT3JnKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKG9yZ1Jvdyk7XG5cbiAgICBjb25zdCBzdGF0dXNlc0xhYmVsID0gaGFja2VyRWwoJ2xhYmVsJywgJ2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjExLjVweDtjb2xvcjojNDc1NTY5O21hcmdpbi1ib3R0b206NnB4OycsICfQodGC0LDRgtGD0YHRiyDQtNC70Y8g0L7Qv9C+0LLQtdGJ0LXQvdC40Y86Jyk7XG4gICAgY29uc3Qgc3RhdHVzZXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcbiAgICBzdGF0dXNlcy5pZCA9ICdoYWNrZXJOb3RpZmllclN0YXR1c2VzJztcbiAgICBzdGF0dXNlcy5tdWx0aXBsZSA9IHRydWU7XG4gICAgc3RhdHVzZXMuc2l6ZSA9IDQ7XG4gICAgc3RhdHVzZXMuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7bWFyZ2luLXRvcDozcHg7cGFkZGluZzo0cHggNnB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDsnO1xuICAgIHN0YXR1c2VzTGFiZWwuYXBwZW5kQ2hpbGQoc3RhdHVzZXMpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoc3RhdHVzZXNMYWJlbCk7XG5cbiAgICBjb25zdCBpbnRlcnZhbExhYmVsID0gaGFja2VyRWwoJ2xhYmVsJywgJ2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjVweDtmb250LXNpemU6MTEuNXB4O2NvbG9yOiM0NzU1Njk7bWFyZ2luOjVweCAwIDdweDsnLCAn0JjQvdGC0LXRgNCy0LDQuywg0LzQuNC90YPRgjonKTtcbiAgICBjb25zdCBpbnRlcnZhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgaW50ZXJ2YWwuaWQgPSAnaGFja2VyTm90aWZpZXJJbnRlcnZhbCc7XG4gICAgaW50ZXJ2YWwudHlwZSA9ICdudW1iZXInO1xuICAgIGludGVydmFsLm1pbiA9ICcxJztcbiAgICBpbnRlcnZhbC5tYXggPSAnMTQ0MCc7XG4gICAgaW50ZXJ2YWwuc3RlcCA9ICcxJztcbiAgICBpbnRlcnZhbC5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjcwcHg7cGFkZGluZzo0cHggNnB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDsnO1xuICAgIGludGVydmFsTGFiZWwuYXBwZW5kQ2hpbGQoaW50ZXJ2YWwpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoaW50ZXJ2YWxMYWJlbCk7XG5cbiAgICBjb25zdCB0b2FzdER1cmF0aW9uTGFiZWwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NXB4O2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6IzQ3NTU2OTttYXJnaW46NXB4IDAgN3B4OycsICfQn9C+0LrQsNC30YvQstCw0YLRjCDRg9Cy0LXQtNC+0LzQu9C10L3QuNC1LCDQvNC40L3Rg9GCOicpO1xuICAgIGNvbnN0IHRvYXN0RHVyYXRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgIHRvYXN0RHVyYXRpb24uaWQgPSAnaGFja2VyTm90aWZpZXJUb2FzdER1cmF0aW9uJztcbiAgICB0b2FzdER1cmF0aW9uLnR5cGUgPSAnbnVtYmVyJztcbiAgICB0b2FzdER1cmF0aW9uLm1pbiA9ICcwJztcbiAgICB0b2FzdER1cmF0aW9uLm1heCA9ICcxNDQwJztcbiAgICB0b2FzdER1cmF0aW9uLnN0ZXAgPSAnMSc7XG4gICAgdG9hc3REdXJhdGlvbi50aXRsZSA9ICcwIOKAlCDQv9C+0LrQsNC30YvQstCw0YLRjCDQtNC+INC90LDQttCw0YLQuNGPIMKr0KPQtNCw0LvQuNGC0YzCuyc7XG4gICAgdG9hc3REdXJhdGlvbi5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjcwcHg7cGFkZGluZzo0cHggNnB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDsnO1xuICAgIHRvYXN0RHVyYXRpb25MYWJlbC5hcHBlbmRDaGlsZCh0b2FzdER1cmF0aW9uKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHRvYXN0RHVyYXRpb25MYWJlbCk7XG5cbiAgICBjb25zdCBidXR0b25zID0gaGFja2VyRWwoJ2RpdicsICdkaXNwbGF5OmZsZXg7Z2FwOjRweDtmbGV4LXdyYXA6d3JhcDsnKTtcbiAgICBjb25zdCBzYXZlID0gaGFja2VyQnRuKCdoYWNrZXJOb3RpZmllclNhdmUnLCAn8J+SviDQodC+0YXRgNCw0L3QuNGC0Ywg0Lgg0LfQsNC/0YPRgdGC0LjRgtGMJywgSEFDS0VSX0JUTl9DU1MgKyAnYmFja2dyb3VuZDojNGY0NmU1OycpO1xuICAgIGNvbnN0IHBvbGwgPSBoYWNrZXJCdG4oJ2hhY2tlck5vdGlmaWVyUG9sbE5vdycsICfin7Mg0J/RgNC+0LLQtdGA0LjRgtGMINGB0LXQudGH0LDRgScsIEhBQ0tFUl9NSU5JX0JUTl9DU1MpO1xuICAgIGNvbnN0IHNvdW5kID0gaGFja2VyQnRuKCdoYWNrZXJOb3RpZmllclRlc3RTb3VuZCcsICfwn5SKINCi0LXRgdGCINGB0LjQs9C90LDQu9CwJywgSEFDS0VSX01JTklfQlROX0NTUyk7XG4gICAgYnV0dG9ucy5hcHBlbmQoc2F2ZSwgcG9sbCwgc291bmQpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoYnV0dG9ucyk7XG4gICAgY29uc3Qgc3RhdHVzID0gaGFja2VyRWwoJ2RpdicsICdtaW4taGVpZ2h0OjE2cHg7bWFyZ2luLXRvcDo2cHg7Zm9udC1zaXplOjEwLjVweDsnLCAnJyk7XG4gICAgc3RhdHVzLmlkID0gJ2hhY2tlck5vdGlmaWVyU3RhdHVzJztcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyKSBzdGF0dXMudGV4dENvbnRlbnQgPSBoYWNrZXJOb3RpZmllclNldHRpbmdzLmVuYWJsZWQgPyAn0J7Qv9GA0L7RgSDQsiDRhNC+0L3QtSDRgNCw0YHRiNC40YDQtdC90LjRjyDCtyDQtdC00LjQvdGL0Lkg0LTQu9GPINCy0YHQtdGFINCy0LrQu9Cw0LTQvtC6JyA6ICfQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0YvQutC70Y7Rh9C10L0nO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoc3RhdHVzKTtcblxuICAgIGhhY2tlck5vdGlmaWVyRmlsbENvbnRyb2xzKHdyYXApO1xuICAgIGVuYWJsZWQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaGFja2VyTm90aWZpZXJSZWFkQ29udHJvbHMpO1xuICAgIHNvdW5kRW5hYmxlZC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgb3JnYW5pemF0aW9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKTtcbiAgICBzdGF0dXNlcy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgaW50ZXJ2YWwuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgaW50ZXJ2YWwuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaGFja2VyTm90aWZpZXJSZWFkQ29udHJvbHMpO1xuICAgIHRvYXN0RHVyYXRpb24uYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgdG9hc3REdXJhdGlvbi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgc2F2ZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgaGFja2VyTm90aWZpZXJSZWFkQ29udHJvbHMoKTsgaGFja2VyTm90aWZpZXJQb2xsKCk7IH0pO1xuICAgIHBvbGwuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKCk7IGhhY2tlck5vdGlmaWVyUG9sbCgpOyB9KTtcbiAgICBzb3VuZC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGhhY2tlck5vdGlmaWVyUGxheUFsYXJtKTtcbiAgICByZWZyZXNoT3JnLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBoYWNrZXJOb3RpZmllclJlZnJlc2hPcmdhbml6YXRpb25zKGZhbHNlKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgfSk7XG5cbiAgICBoYWNrZXJOb3RpZmllclNlbGVjdERlZmF1bHRTdGF0dXMoKTtcbiAgICBoYWNrZXJOb3RpZmllckZpbGxDb250cm9scyh3cmFwKTtcbiAgICByZXR1cm4gd3JhcDtcbn1cbiIsIi8vIOKUgOKUgOKUgCDQn9GA0L7QstC10YDQutCwINGC0L7QstCw0YDQvtCyINCyINC30LDQutCw0LfQsNGFINC4INCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQsNGFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8g0KHRgNCw0LLQvdC40LLQsNC10YIg0LDQs9GA0LXQs9C40YDQvtCy0LDQvdC90YvQtSDQv9C+0LfQuNGG0LjQuCDQt9Cw0LrQsNC30L7QsiDQv9C+0LrRg9C/0LDRgtC10LvQtdC5INC4INCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQvtCyLlxuY29uc3QgSU5URVJOQUxfT1JERVJfQ0hFQ0tfU1RPUkFHRV9LRVkgPSAnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrX3YxJztcbmNvbnN0IElOVEVSTkFMX09SREVSX0NIRUNLX0RFRkFVTFRfU1RBVFVTID0gJ9Cd0L7QstGL0LknO1xuY29uc3QgSU5URVJOQUxfT1JERVJfQ0hFQ0tfRU5USVRJRVMgPSB7XG4gICAgY3VzdG9tZXJvcmRlcjoge1xuICAgICAgICBsYWJlbDogJ9CX0LDQutCw0LfRiyDQv9C+0LrRg9C/0LDRgtC10LvQtdC5JyxcbiAgICAgICAgb3JnYW5pemF0aW9uS2V5OiAnY3VzdG9tZXJPcmdhbml6YXRpb25IcmVmJyxcbiAgICAgICAgc3RhdHVzS2V5OiAnY3VzdG9tZXJTdGF0dXNIcmVmcydcbiAgICB9LFxuICAgIGludGVybmFsb3JkZXI6IHtcbiAgICAgICAgbGFiZWw6ICfQktC90YPRgtGA0LXQvdC90LjQtSDQt9Cw0LrQsNC30YsnLFxuICAgICAgICBvcmdhbml6YXRpb25LZXk6ICdpbnRlcm5hbE9yZ2FuaXphdGlvbkhyZWYnLFxuICAgICAgICBzdGF0dXNLZXk6ICdpbnRlcm5hbFN0YXR1c0hyZWZzJ1xuICAgIH1cbn07XG5sZXQgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MgPSB7XG4gICAgY3VzdG9tZXJPcmdhbml6YXRpb25IcmVmOiAnJyxcbiAgICBpbnRlcm5hbE9yZ2FuaXphdGlvbkhyZWY6ICcnLFxuICAgIGN1c3RvbWVyV2FyZWhvdXNlSHJlZjogJycsXG4gICAgaW50ZXJuYWxXYXJlaG91c2VIcmVmOiAnJyxcbiAgICBjdXN0b21lclN0YXR1c0hyZWZzOiBbXSxcbiAgICBpbnRlcm5hbFN0YXR1c0hyZWZzOiBbXVxufTtcbmxldCBpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlcyA9IHtcbiAgICBjdXN0b21lcm9yZGVyOiBbXSxcbiAgICBpbnRlcm5hbG9yZGVyOiBbXVxufTtcbmxldCBpbnRlcm5hbE9yZGVyQ2hlY2tXYXJlaG91c2VzID0gW107XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja05vcm1hbGl6ZVNldHRpbmdzKHJhdykge1xuICAgIGNvbnN0IGxpc3QgPSB2YWx1ZSA9PiBBcnJheS5pc0FycmF5KHZhbHVlKVxuICAgICAgICA/IFsuLi5uZXcgU2V0KHZhbHVlLmZpbHRlcihpdGVtID0+IHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJyAmJiBpdGVtKSldXG4gICAgICAgIDogW107XG4gICAgcmV0dXJuIHtcbiAgICAgICAgY3VzdG9tZXJPcmdhbml6YXRpb25IcmVmOiB0eXBlb2YgcmF3Py5jdXN0b21lck9yZ2FuaXphdGlvbkhyZWYgPT09ICdzdHJpbmcnID8gcmF3LmN1c3RvbWVyT3JnYW5pemF0aW9uSHJlZiA6ICcnLFxuICAgICAgICBpbnRlcm5hbE9yZ2FuaXphdGlvbkhyZWY6IHR5cGVvZiByYXc/LmludGVybmFsT3JnYW5pemF0aW9uSHJlZiA9PT0gJ3N0cmluZycgPyByYXcuaW50ZXJuYWxPcmdhbml6YXRpb25IcmVmIDogJycsXG4gICAgICAgIGN1c3RvbWVyV2FyZWhvdXNlSHJlZjogdHlwZW9mIHJhdz8uY3VzdG9tZXJXYXJlaG91c2VIcmVmID09PSAnc3RyaW5nJyA/IHJhdy5jdXN0b21lcldhcmVob3VzZUhyZWYgOiAnJyxcbiAgICAgICAgaW50ZXJuYWxXYXJlaG91c2VIcmVmOiB0eXBlb2YgcmF3Py5pbnRlcm5hbFdhcmVob3VzZUhyZWYgPT09ICdzdHJpbmcnID8gcmF3LmludGVybmFsV2FyZWhvdXNlSHJlZiA6ICcnLFxuICAgICAgICBjdXN0b21lclN0YXR1c0hyZWZzOiBsaXN0KHJhdz8uY3VzdG9tZXJTdGF0dXNIcmVmcyksXG4gICAgICAgIGludGVybmFsU3RhdHVzSHJlZnM6IGxpc3QocmF3Py5pbnRlcm5hbFN0YXR1c0hyZWZzKVxuICAgIH07XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0xvYWRTZXR0aW5ncygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByYXcgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoSU5URVJOQUxfT1JERVJfQ0hFQ0tfU1RPUkFHRV9LRVkpKSB8fCAne30nKTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MgPSBpbnRlcm5hbE9yZGVyQ2hlY2tOb3JtYWxpemVTZXR0aW5ncygocmF3LnJlZmVyZW5jZVNjb3BlIHx8ICcnKSA9PT0gbXNSZWZlcmVuY2VTY29wZSA/IHJhdyA6IHt9KTtcbiAgICAgICAgY29uc3Qgd2FyZWhvdXNlcyA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VySW50ZXJuYWxPcmRlcldhcmVob3VzZXNfdjEnKSkgfHwgJ1tdJyk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1dhcmVob3VzZXMgPSBtc1JlZmVyZW5jZVNjb3BlID8gKG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMuc3RvcmUgfHwgW10pIDogQXJyYXkuaXNBcnJheSh3YXJlaG91c2VzKVxuICAgICAgICAgICAgPyB3YXJlaG91c2VzLmZpbHRlcihpdGVtID0+IGl0ZW0gJiYgdHlwZW9mIGl0ZW0ubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIGl0ZW0uaHJlZiA9PT0gJ3N0cmluZycpXG4gICAgICAgICAgICA6IFtdO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzID0gaW50ZXJuYWxPcmRlckNoZWNrTm9ybWFsaXplU2V0dGluZ3Moe30pO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZSgn0J3QtSDRg9C00LDQu9C+0YHRjCDQt9Cw0LPRgNGD0LfQuNGC0Ywg0L3QsNGB0YLRgNC+0LnQutC4INGB0YDQsNCy0L3QtdC90LjRjycsIGVycm9yLCAnZXJyJyk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tTYXZlU2V0dGluZ3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleShJTlRFUk5BTF9PUkRFUl9DSEVDS19TVE9SQUdFX0tFWSksIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIC4uLmludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLCAuLi4obXNSZWZlcmVuY2VTY29wZSA/IHsgcmVmZXJlbmNlU2NvcGU6IG1zUmVmZXJlbmNlU2NvcGUgfSA6IHt9KVxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC90LDRgdGC0YDQvtC50LrQuCDRgdGA0LDQstC90LXQvdC40Y8nLCBlcnJvciwgJ2VycicpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrU2F2ZVdhcmVob3VzZXMoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VySW50ZXJuYWxPcmRlcldhcmVob3VzZXNfdjEnKSwgSlNPTi5zdHJpbmdpZnkoaW50ZXJuYWxPcmRlckNoZWNrV2FyZWhvdXNlcykpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKCfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDRgdC/0LjRgdC+0Log0YHQutC70LDQtNC+0LInLCBlcnJvciwgJ2VycicpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UobWVzc2FnZSwgZGV0YWlscyA9IG51bGwsIGtpbmQgPSAnaW5mbycpIHtcbiAgICBjb25zdCBwcmVmaXggPSAnW01lbWNoYXQ6aW50ZXJuYWwtb3JkZXJzXSc7XG4gICAgaWYgKGtpbmQgPT09ICdlcnInKSBjb25zb2xlLmVycm9yKHByZWZpeCwgbWVzc2FnZSwgZGV0YWlscyB8fCAnJyk7XG4gICAgZWxzZSBpZiAoa2luZCA9PT0gJ3dhcm4nKSBjb25zb2xlLndhcm4ocHJlZml4LCBtZXNzYWdlLCBkZXRhaWxzIHx8ICcnKTtcbiAgICBlbHNlIGNvbnNvbGUuaW5mbyhwcmVmaXgsIG1lc3NhZ2UsIGRldGFpbHMgfHwgJycpO1xuICAgIGlmICh0eXBlb2YgaGFja2VyTG9nID09PSAnZnVuY3Rpb24nKSBoYWNrZXJMb2coYPCfk6YgJHttZXNzYWdlfWAsIGtpbmQgPT09ICdlcnInID8gJ2VycicgOiBraW5kKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzZXNGcm9tTWV0YWRhdGEoZGF0YSkge1xuICAgIGNvbnN0IHN0YXRlcyA9IEFycmF5LmlzQXJyYXkoZGF0YT8uc3RhdGVzKSA/IGRhdGEuc3RhdGVzIDogKEFycmF5LmlzQXJyYXkoZGF0YT8uc3RhdGVzPy5yb3dzKSA/IGRhdGEuc3RhdGVzLnJvd3MgOiBbXSk7XG4gICAgcmV0dXJuIHN0YXRlcy5tYXAoc3RhdGUgPT4gKHtcbiAgICAgICAgbmFtZTogc3RhdGUubmFtZSxcbiAgICAgICAgaHJlZjogc3RhdGUubWV0YT8uaHJlZlxuICAgIH0pKS5maWx0ZXIoc3RhdGUgPT4gc3RhdGUubmFtZSAmJiBzdGF0ZS5ocmVmKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrQWRkU2F2ZWRPcHRpb24oc2VsZWN0LCB2YWx1ZSwgbGFiZWwpIHtcbiAgICBpZiAoIXZhbHVlIHx8IFsuLi5zZWxlY3Qub3B0aW9uc10uc29tZShvcHRpb24gPT4gb3B0aW9uLnZhbHVlID09PSB2YWx1ZSkpIHJldHVybjtcbiAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICBvcHRpb24udmFsdWUgPSB2YWx1ZTtcbiAgICBvcHRpb24udGV4dENvbnRlbnQgPSBg4pqgINCh0L7RhdGA0LDQvdGR0L3QvSR7bGFiZWx9IOKAlCDQvtGC0YHRg9GC0YHRgtCy0YPQtdGCINCyINGB0L/RgNCw0LLQvtGH0L3QuNC60LVgO1xuICAgIG9wdGlvbi5kYXRhc2V0LnNhdmVkU2VsZWN0aW9uID0gJ3RydWUnO1xuICAgIG9wdGlvbi5zZWxlY3RlZCA9IHRydWU7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0ZpbGxPcmdhbml6YXRpb25zKHJvb3QgPSBkb2N1bWVudCkge1xuICAgIFtcbiAgICAgICAgWydoYWNrZXJJbnRlcm5hbEN1c3RvbWVyT3JnYW5pemF0aW9uJywgJ2N1c3RvbWVyT3JnYW5pemF0aW9uSHJlZiddLFxuICAgICAgICBbJ2hhY2tlckludGVybmFsT3JkZXJPcmdhbml6YXRpb24nLCAnaW50ZXJuYWxPcmdhbml6YXRpb25IcmVmJ11cbiAgICBdLmZvckVhY2goKFtpZCwga2V5XSkgPT4ge1xuICAgICAgICBjb25zdCBzZWxlY3QgPSByb290LnF1ZXJ5U2VsZWN0b3IoJyMnICsgaWQpO1xuICAgICAgICBpZiAoIXNlbGVjdCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzW2tleV07XG4gICAgICAgIGNvbnN0IG9yZ2FuaXphdGlvbnMgPSBBcnJheS5pc0FycmF5KGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucykgPyBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMgOiBbXTtcbiAgICAgICAgc2VsZWN0LmlubmVySFRNTCA9ICcnO1xuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgICAgICBlbXB0eS52YWx1ZSA9ICcnO1xuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9IG9yZ2FuaXphdGlvbnMubGVuZ3RoXG4gICAgICAgICAgICA/ICfigJQg0LLRi9Cx0LXRgNC40YLQtSDQvtGA0LPQsNC90LjQt9Cw0YbQuNGOIOKAlCdcbiAgICAgICAgICAgIDogJ+KAlCDQvdCw0LbQvNC40YLQtSDCq9CX0LDQs9GA0YPQt9C40YLRjCDRgdC/0YDQsNCy0L7Rh9C90LjQutC4wrsg4oCUJztcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgb3JnYW5pemF0aW9ucy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgICAgICBvcHRpb24udmFsdWUgPSBpdGVtLmhyZWY7XG4gICAgICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSBpdGVtLm5hbWU7XG4gICAgICAgICAgICBvcHRpb24uc2VsZWN0ZWQgPSBpdGVtLmhyZWYgPT09IHNlbGVjdGVkO1xuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gICAgICAgIH0pO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tBZGRTYXZlZE9wdGlvbihzZWxlY3QsIHNlbGVjdGVkLCAn0LDRjyDQvtGA0LPQsNC90LjQt9Cw0YbQuNGPJyk7XG4gICAgICAgIHNlbGVjdC52YWx1ZSA9IHNlbGVjdGVkO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsV2FyZWhvdXNlcyhyb290ID0gZG9jdW1lbnQpIHtcbiAgICBbXG4gICAgICAgIFsnaGFja2VySW50ZXJuYWxDdXN0b21lcldhcmVob3VzZScsICdjdXN0b21lcldhcmVob3VzZUhyZWYnXSxcbiAgICAgICAgWydoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlJywgJ2ludGVybmFsV2FyZWhvdXNlSHJlZiddXG4gICAgXS5mb3JFYWNoKChbaWQsIGtleV0pID0+IHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcjJyArIGlkKTtcbiAgICAgICAgaWYgKCFzZWxlY3QpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5nc1trZXldO1xuICAgICAgICBjb25zdCB3YXJlaG91c2VzID0gQXJyYXkuaXNBcnJheShpbnRlcm5hbE9yZGVyQ2hlY2tXYXJlaG91c2VzKSA/IGludGVybmFsT3JkZXJDaGVja1dhcmVob3VzZXMgOiBbXTtcbiAgICAgICAgc2VsZWN0LmlubmVySFRNTCA9ICcnO1xuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgICAgICBlbXB0eS52YWx1ZSA9ICcnO1xuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9IHdhcmVob3VzZXMubGVuZ3RoXG4gICAgICAgICAgICA/ICfigJQg0LLRi9Cx0LXRgNC40YLQtSDRgdC60LvQsNC0IOKAlCdcbiAgICAgICAgICAgIDogJ+KAlCDQvdCw0LbQvNC40YLQtSDCq9CX0LDQs9GA0YPQt9C40YLRjCDRgdC/0YDQsNCy0L7Rh9C90LjQutC4wrsg4oCUJztcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgd2FyZWhvdXNlcy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgICAgICBvcHRpb24udmFsdWUgPSBpdGVtLmhyZWY7XG4gICAgICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSBpdGVtLm5hbWU7XG4gICAgICAgICAgICBvcHRpb24uc2VsZWN0ZWQgPSBpdGVtLmhyZWYgPT09IHNlbGVjdGVkO1xuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gICAgICAgIH0pO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tBZGRTYXZlZE9wdGlvbihzZWxlY3QsIHNlbGVjdGVkLCAn0YvQuSDRgdC60LvQsNC0Jyk7XG4gICAgICAgIHNlbGVjdC52YWx1ZSA9IHNlbGVjdGVkO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsU3RhdHVzZXMoZW50aXR5LCByb290ID0gZG9jdW1lbnQpIHtcbiAgICBjb25zdCBjb25maWcgPSBJTlRFUk5BTF9PUkRFUl9DSEVDS19FTlRJVElFU1tlbnRpdHldO1xuICAgIGNvbnN0IHNlbGVjdCA9IHJvb3QucXVlcnlTZWxlY3RvcihlbnRpdHkgPT09ICdjdXN0b21lcm9yZGVyJ1xuICAgICAgICA/ICcjaGFja2VySW50ZXJuYWxDdXN0b21lclN0YXR1c2VzJ1xuICAgICAgICA6ICcjaGFja2VySW50ZXJuYWxPcmRlclN0YXR1c2VzJyk7XG4gICAgaWYgKCFjb25maWcgfHwgIXNlbGVjdCkgcmV0dXJuO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3NbY29uZmlnLnN0YXR1c0tleV07XG4gICAgc2VsZWN0LmlubmVySFRNTCA9ICcnO1xuICAgIGludGVybmFsT3JkZXJDaGVja1N0YXR1c2VzW2VudGl0eV0uZm9yRWFjaChpdGVtID0+IHtcbiAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgIG9wdGlvbi52YWx1ZSA9IGl0ZW0uaHJlZjtcbiAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gaXRlbS5uYW1lO1xuICAgICAgICBvcHRpb24uc2VsZWN0ZWQgPSBzZWxlY3RlZC5pbmNsdWRlcyhpdGVtLmhyZWYpO1xuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgICB9KTtcbiAgICBzZWxlY3RlZC5mb3JFYWNoKGhyZWYgPT4gaW50ZXJuYWxPcmRlckNoZWNrQWRkU2F2ZWRPcHRpb24oc2VsZWN0LCBocmVmLCAn0YvQuSDRgdGC0LDRgtGD0YEnKSk7XG4gICAgaWYgKCFpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlc1tlbnRpdHldLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBoaW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgIGhpbnQuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICBoaW50LnRleHRDb250ZW50ID0gJ+KAlCDQvdCw0LbQvNC40YLQtSDCq9CX0LDQs9GA0YPQt9C40YLRjCDRgdC/0YDQsNCy0L7Rh9C90LjQutC4wrsg4oCUJztcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGhpbnQpO1xuICAgIH1cbiAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBkZWZhdWx0U3RhdGUgPSBpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlc1tlbnRpdHldLmZpbmQoaXRlbSA9PlxuICAgICAgICAgICAgU3RyaW5nKGl0ZW0ubmFtZSkudHJpbSgpLnRvTG93ZXJDYXNlKCkgPT09IElOVEVSTkFMX09SREVSX0NIRUNLX0RFRkFVTFRfU1RBVFVTLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgICBpZiAoZGVmYXVsdFN0YXRlKSB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBbLi4uc2VsZWN0Lm9wdGlvbnNdLmZpbmQoaXRlbSA9PiBpdGVtLnZhbHVlID09PSBkZWZhdWx0U3RhdGUuaHJlZik7XG4gICAgICAgICAgICBpZiAob3B0aW9uKSBvcHRpb24uc2VsZWN0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3NbY29uZmlnLnN0YXR1c0tleV0gPSBbZGVmYXVsdFN0YXRlLmhyZWZdO1xuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1JlYWRDb250cm9scygpIHtcbiAgICBjb25zdCBjdXN0b21lck9yZ2FuaXphdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJJbnRlcm5hbEN1c3RvbWVyT3JnYW5pemF0aW9uJyk7XG4gICAgY29uc3QgaW50ZXJuYWxPcmdhbml6YXRpb24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VySW50ZXJuYWxPcmRlck9yZ2FuaXphdGlvbicpO1xuICAgIGNvbnN0IGN1c3RvbWVyV2FyZWhvdXNlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsQ3VzdG9tZXJXYXJlaG91c2UnKTtcbiAgICBjb25zdCBpbnRlcm5hbFdhcmVob3VzZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlJyk7XG4gICAgY29uc3QgY3VzdG9tZXJTdGF0dXNlcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJJbnRlcm5hbEN1c3RvbWVyU3RhdHVzZXMnKTtcbiAgICBjb25zdCBpbnRlcm5hbFN0YXR1c2VzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsT3JkZXJTdGF0dXNlcycpO1xuICAgIGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzID0gaW50ZXJuYWxPcmRlckNoZWNrTm9ybWFsaXplU2V0dGluZ3Moe1xuICAgICAgICBjdXN0b21lck9yZ2FuaXphdGlvbkhyZWY6IGN1c3RvbWVyT3JnYW5pemF0aW9uID8gY3VzdG9tZXJPcmdhbml6YXRpb24udmFsdWUgOiBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5jdXN0b21lck9yZ2FuaXphdGlvbkhyZWYsXG4gICAgICAgIGludGVybmFsT3JnYW5pemF0aW9uSHJlZjogaW50ZXJuYWxPcmdhbml6YXRpb24gPyBpbnRlcm5hbE9yZ2FuaXphdGlvbi52YWx1ZSA6IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmludGVybmFsT3JnYW5pemF0aW9uSHJlZixcbiAgICAgICAgY3VzdG9tZXJXYXJlaG91c2VIcmVmOiBjdXN0b21lcldhcmVob3VzZSA/IGN1c3RvbWVyV2FyZWhvdXNlLnZhbHVlIDogaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuY3VzdG9tZXJXYXJlaG91c2VIcmVmLFxuICAgICAgICBpbnRlcm5hbFdhcmVob3VzZUhyZWY6IGludGVybmFsV2FyZWhvdXNlID8gaW50ZXJuYWxXYXJlaG91c2UudmFsdWUgOiBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5pbnRlcm5hbFdhcmVob3VzZUhyZWYsXG4gICAgICAgIGN1c3RvbWVyU3RhdHVzSHJlZnM6IGN1c3RvbWVyU3RhdHVzZXNcbiAgICAgICAgICAgID8gWy4uLmN1c3RvbWVyU3RhdHVzZXMuc2VsZWN0ZWRPcHRpb25zXS5tYXAob3B0aW9uID0+IG9wdGlvbi52YWx1ZSlcbiAgICAgICAgICAgIDogaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuY3VzdG9tZXJTdGF0dXNIcmVmcyxcbiAgICAgICAgaW50ZXJuYWxTdGF0dXNIcmVmczogaW50ZXJuYWxTdGF0dXNlc1xuICAgICAgICAgICAgPyBbLi4uaW50ZXJuYWxTdGF0dXNlcy5zZWxlY3RlZE9wdGlvbnNdLm1hcChvcHRpb24gPT4gb3B0aW9uLnZhbHVlKVxuICAgICAgICAgICAgOiBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5pbnRlcm5hbFN0YXR1c0hyZWZzXG4gICAgfSk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrU2F2ZVNldHRpbmdzKCk7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1JlZnJlc2hTdGF0dXNlcyhlbnRpdHkpIHtcbiAgICByZXR1cm4gbXNSZWZlcmVuY2VMb2FkKGVudGl0eSwgeyBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrUmVmcmVzaE9yZ2FuaXphdGlvbnMoKSB7XG4gICAgcmV0dXJuIGhhY2tlck5vdGlmaWVyUmVmcmVzaE9yZ2FuaXphdGlvbnModHJ1ZSlcbiAgICAgICAgLnRoZW4oaXRlbXMgPT4ge1xuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbE9yZ2FuaXphdGlvbnMoKTtcbiAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKGDQntGA0LPQsNC90LjQt9Cw0YbQuNC4INC+0LHQvdC+0LLQu9C10L3RiyDQtNC70Y8g0LTQstGD0YUg0YLQuNC/0L7QsiDQtNC+0LrRg9C80LXQvdGC0L7QsjogJHtpdGVtcy5sZW5ndGh9INGI0YIuYCk7XG4gICAgICAgICAgICByZXR1cm4gaXRlbXM7XG4gICAgICAgIH0pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tSZWZyZXNoV2FyZWhvdXNlcygpIHtcbiAgICByZXR1cm4gbXNSZWZlcmVuY2VMb2FkKCdzdG9yZScsIHsgZm9yY2U6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1JlZnJlc2hBbGxMaXN0cyhzdGF0dXMpIHtcbiAgICBpZiAoIWhhY2tlckJlYXJlckVuYWJsZWQgfHwgIWhhY2tlckJlYXJlclRva2VuLnRyaW0oKSkge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gJ9CU0LvRjyDQt9Cw0LPRgNGD0LfQutC4INC+0YDQs9Cw0L3QuNC30LDRhtC40LksINGB0LrQu9Cw0LTQvtCyINC4INGB0YLQsNGC0YPRgdC+0LIg0LLQutC70Y7Rh9C40YLQtSBCZWFyZXIg0Lgg0YPQutCw0LbQuNGC0LUgQVBJLdC60LvRjtGHINCc0L7QudCh0LrQu9Cw0LQuJztcbiAgICAgICAgaWYgKHN0YXR1cykge1xuICAgICAgICAgICAgc3RhdHVzLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgICAgICAgICAgIHN0YXR1cy5zdHlsZS5jb2xvciA9ICcjYjQ1MzA5JztcbiAgICAgICAgfVxuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShtZXNzYWdlLCBudWxsLCAnd2FybicpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgICB9XG4gICAgcmV0dXJuIG1zUmVmZXJlbmNlUmVmcmVzaCh7IGZvcmNlOiB0cnVlLCBzdGF0dXMgfSk7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1N0YXRlTmFtZXMoZW50aXR5LCBzdGF0dXNIcmVmcykge1xuICAgIHJldHVybiBzdGF0dXNIcmVmc1xuICAgICAgICAubWFwKGhyZWYgPT4gaW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzZXNbZW50aXR5XS5maW5kKHN0YXRlID0+IHN0YXRlLmhyZWYgPT09IGhyZWYpPy5uYW1lKVxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tNYXRjaGVzU3RhdHVzKHJvdywgc3RhdHVzSHJlZnMsIHN0YXR1c05hbWVzKSB7XG4gICAgY29uc3Qgc3RhdGVIcmVmID0gcm93Py5zdGF0ZT8ubWV0YT8uaHJlZiB8fCAnJztcbiAgICBjb25zdCBzdGF0ZU5hbWUgPSBTdHJpbmcocm93Py5zdGF0ZT8ubmFtZSB8fCAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIHN0YXR1c0hyZWZzLmluY2x1ZGVzKHN0YXRlSHJlZikgfHwgc3RhdHVzTmFtZXMuc29tZShuYW1lID0+IFN0cmluZyhuYW1lKS50cmltKCkudG9Mb3dlckNhc2UoKSA9PT0gc3RhdGVOYW1lKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrTWF0Y2hlc1dhcmVob3VzZShlbnRpdHksIHJvdywgd2FyZWhvdXNlSHJlZikge1xuICAgIGNvbnN0IHJlZmVyZW5jZXMgPSBlbnRpdHkgPT09ICdjdXN0b21lcm9yZGVyJ1xuICAgICAgICA/IFtyb3c/LnN0b3JlLCByb3c/LndhcmVob3VzZV1cbiAgICAgICAgOiBbcm93Py5zb3VyY2VTdG9yZSwgcm93Py50YXJnZXRTdG9yZSwgcm93Py5zdG9yZV07XG4gICAgcmV0dXJuIHJlZmVyZW5jZXMuc29tZShyZWZlcmVuY2UgPT4gcmVmZXJlbmNlPy5tZXRhPy5ocmVmID09PSB3YXJlaG91c2VIcmVmKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrRmV0Y2hBbGxQYWdlcyhwYXRoLCByb3dzID0gW10sIHZpc2l0ZWQgPSBuZXcgU2V0KCksIGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb24pIHtcbiAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKCfQl9Cw0L/RgNC+0YEg0LogYXBpLm1veXNrbGFkLnJ1INC+0YLQvNC10L3RkdC9JykpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRQYXRoID0gaGFja2VyQXBpUGF0aChwYXRoKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWRQYXRoIHx8IHZpc2l0ZWQuaGFzKG5vcm1hbGl6ZWRQYXRoKSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKCfQnNC+0LnQodC60LvQsNC0INCy0LXRgNC90YPQuyDRhtC40LrQu9C40YfQtdGB0LrRg9GOINGB0YHRi9C70LrRgyDQv9Cw0LPQuNC90LDRhtC40LgnKSk7XG4gICAgfVxuICAgIHZpc2l0ZWQuYWRkKG5vcm1hbGl6ZWRQYXRoKTtcbiAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCBub3JtYWxpemVkUGF0aCkudGhlbihwYWdlID0+IHtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbikgdGhyb3cgbmV3IEVycm9yKCfQl9Cw0L/RgNC+0YEg0LogYXBpLm1veXNrbGFkLnJ1INC+0YLQvNC10L3RkdC9Jyk7XG4gICAgICAgIGNvbnN0IHBhZ2VSb3dzID0gQXJyYXkuaXNBcnJheShwYWdlPy5yb3dzKSA/IHBhZ2Uucm93cyA6IFtdO1xuICAgICAgICByb3dzLnB1c2goLi4ucGFnZVJvd3MpO1xuICAgICAgICBjb25zdCBuZXh0SHJlZiA9IHBhZ2U/Lm1ldGE/Lm5leHRIcmVmO1xuICAgICAgICByZXR1cm4gbmV4dEhyZWZcbiAgICAgICAgICAgID8gaW50ZXJuYWxPcmRlckNoZWNrRmV0Y2hBbGxQYWdlcyhuZXh0SHJlZiwgcm93cywgdmlzaXRlZCwgZ2VuZXJhdGlvbilcbiAgICAgICAgICAgIDogcm93cztcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrRmV0Y2hEb2N1bWVudHMoZW50aXR5LCBvcmdhbml6YXRpb25IcmVmLCB3YXJlaG91c2VIcmVmLCBzdGF0dXNIcmVmcykge1xuICAgIGlmICghb3JnYW5pemF0aW9uSHJlZikgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcihg0J3QtSDQstGL0LHRgNCw0L3QsCDQvtGA0LPQsNC90LjQt9Cw0YbQuNGPOiAke0lOVEVSTkFMX09SREVSX0NIRUNLX0VOVElUSUVTW2VudGl0eV0ubGFiZWx9YCkpO1xuICAgIGlmICghd2FyZWhvdXNlSHJlZikgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcihg0J3QtSDQstGL0LHRgNCw0L0g0YHQutC70LDQtDogJHtJTlRFUk5BTF9PUkRFUl9DSEVDS19FTlRJVElFU1tlbnRpdHldLmxhYmVsfWApKTtcbiAgICBpZiAoIXN0YXR1c0hyZWZzLmxlbmd0aCkgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcihg0J3QtSDQstGL0LHRgNCw0L3RiyDRgdGC0LDRgtGD0YHRizogJHtJTlRFUk5BTF9PUkRFUl9DSEVDS19FTlRJVElFU1tlbnRpdHldLmxhYmVsfWApKTtcbiAgICBjb25zdCBmaWx0ZXIgPSBlbmNvZGVVUklDb21wb25lbnQoJ29yZ2FuaXphdGlvbj0nICsgb3JnYW5pemF0aW9uSHJlZik7XG4gICAgY29uc3QgcGF0aCA9IGAvZW50aXR5LyR7ZW50aXR5fT9maWx0ZXI9JHtmaWx0ZXJ9JmV4cGFuZD1zdGF0ZSxzdG9yZSxzb3VyY2VTdG9yZSx0YXJnZXRTdG9yZSZvcmRlcj1tb21lbnQsZGVzYyZsaW1pdD0xMDAwYDtcbiAgICBjb25zdCBzdGF0dXNOYW1lcyA9IGludGVybmFsT3JkZXJDaGVja1N0YXRlTmFtZXMoZW50aXR5LCBzdGF0dXNIcmVmcyk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoYNCf0L7Qu9GD0YfQsNGOICR7SU5URVJOQUxfT1JERVJfQ0hFQ0tfRU5USVRJRVNbZW50aXR5XS5sYWJlbH1gLCB7XG4gICAgICAgIG9yZ2FuaXphdGlvbkhyZWYsXG4gICAgICAgIHdhcmVob3VzZUhyZWYsXG4gICAgICAgIHN0YXR1c0hyZWZzLFxuICAgICAgICBzdGF0dXNOYW1lcyxcbiAgICAgICAgcGF0aFxuICAgIH0pO1xuICAgIHJldHVybiBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaEFsbFBhZ2VzKHBhdGgpLnRoZW4ocm93cyA9PiB7XG4gICAgICAgIGNvbnN0IG1hdGNoaW5nID0gcm93cy5maWx0ZXIocm93ID0+XG4gICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tNYXRjaGVzU3RhdHVzKHJvdywgc3RhdHVzSHJlZnMsIHN0YXR1c05hbWVzKVxuICAgICAgICAgICAgJiYgaW50ZXJuYWxPcmRlckNoZWNrTWF0Y2hlc1dhcmVob3VzZShlbnRpdHksIHJvdywgd2FyZWhvdXNlSHJlZikpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShgJHtJTlRFUk5BTF9PUkRFUl9DSEVDS19FTlRJVElFU1tlbnRpdHldLmxhYmVsfTog0L3QsNC50LTQtdC90L4g0LTQvtC60YPQvNC10L3RgtC+0LIg4oCUICR7bWF0Y2hpbmcubGVuZ3RofWAsIHtcbiAgICAgICAgICAgIHRvdGFsUm93czogcm93cy5sZW5ndGgsXG4gICAgICAgICAgICBtYXRjaGluZ05hbWVzOiBtYXRjaGluZy5tYXAocm93ID0+IHJvdy5uYW1lIHx8IHJvdy5pZClcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBtYXRjaGluZztcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrUG9zaXRpb25Sb3dzKGVudGl0eSwgZG9jdW1lbnQpIHtcbiAgICBjb25zdCBpbml0aWFsUm93cyA9IEFycmF5LmlzQXJyYXkoZG9jdW1lbnQ/LnBvc2l0aW9ucz8ucm93cykgPyBkb2N1bWVudC5wb3NpdGlvbnMucm93cyA6IFtdO1xuICAgIGNvbnN0IG5leHRIcmVmID0gZG9jdW1lbnQ/LnBvc2l0aW9ucz8ubWV0YT8ubmV4dEhyZWY7XG4gICAgaWYgKG5leHRIcmVmKSByZXR1cm4gaW50ZXJuYWxPcmRlckNoZWNrRmV0Y2hBbGxQYWdlcyhuZXh0SHJlZiwgaW5pdGlhbFJvd3MpO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGRvY3VtZW50Py5wb3NpdGlvbnM/LnJvd3MpKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGluaXRpYWxSb3dzKTtcbiAgICBjb25zdCBpZCA9IGRvY3VtZW50Py5pZCB8fCBkb2N1bWVudD8ubWV0YT8uaHJlZj8uc3BsaXQoJy8nKS5wb3AoKTtcbiAgICBpZiAoIWlkKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgICByZXR1cm4gaW50ZXJuYWxPcmRlckNoZWNrRmV0Y2hBbGxQYWdlcyhgL2VudGl0eS8ke2VudGl0eX0vJHtpZH0vcG9zaXRpb25zP2V4cGFuZD1hc3NvcnRtZW50JmxpbWl0PTEwMDBgKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrUG9zaXRpb25LZXkocG9zaXRpb24pIHtcbiAgICBjb25zdCBhc3NvcnRtZW50ID0gcG9zaXRpb24/LmFzc29ydG1lbnQgfHwgcG9zaXRpb24/LnByb2R1Y3QgfHwge307XG4gICAgcmV0dXJuIGFzc29ydG1lbnQubWV0YT8uaHJlZiB8fCBhc3NvcnRtZW50LmlkIHx8IGBuYW1lOiR7U3RyaW5nKGFzc29ydG1lbnQubmFtZSB8fCBwb3NpdGlvbj8ubmFtZSB8fCAn0JHQtdC3INC90LDQt9Cy0LDQvdC40Y8nKS50cmltKCkudG9Mb3dlckNhc2UoKX1gO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tQb3NpdGlvbk5hbWUocG9zaXRpb24pIHtcbiAgICBjb25zdCBhc3NvcnRtZW50ID0gcG9zaXRpb24/LmFzc29ydG1lbnQgfHwgcG9zaXRpb24/LnByb2R1Y3QgfHwge307XG4gICAgcmV0dXJuIGFzc29ydG1lbnQubmFtZSB8fCBwb3NpdGlvbj8ubmFtZSB8fCAn0JHQtdC3INC90LDQt9Cy0LDQvdC40Y8nO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tBZ2dyZWdhdGUocm93cykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xuICAgIHJvd3MuZm9yRWFjaChwb3NpdGlvbiA9PiB7XG4gICAgICAgIGNvbnN0IGtleSA9IGludGVybmFsT3JkZXJDaGVja1Bvc2l0aW9uS2V5KHBvc2l0aW9uKTtcbiAgICAgICAgY29uc3QgcXVhbnRpdHkgPSBOdW1iZXIocG9zaXRpb24/LnF1YW50aXR5KTtcbiAgICAgICAgY29uc3Qgc2FmZVF1YW50aXR5ID0gTnVtYmVyLmlzRmluaXRlKHF1YW50aXR5KSA/IHF1YW50aXR5IDogMDtcbiAgICAgICAgaWYgKCFyZXN1bHRba2V5XSkgcmVzdWx0W2tleV0gPSB7IGtleSwgbmFtZTogaW50ZXJuYWxPcmRlckNoZWNrUG9zaXRpb25OYW1lKHBvc2l0aW9uKSwgcXVhbnRpdHk6IDAgfTtcbiAgICAgICAgcmVzdWx0W2tleV0ucXVhbnRpdHkgKz0gc2FmZVF1YW50aXR5O1xuICAgIH0pO1xuICAgIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0NvbXBhcmVNYXBzKGN1c3RvbWVyR29vZHMsIGludGVybmFsR29vZHMpIHtcbiAgICBjb25zdCBrZXlzID0gbmV3IFNldChbLi4uT2JqZWN0LmtleXMoY3VzdG9tZXJHb29kcyksIC4uLk9iamVjdC5rZXlzKGludGVybmFsR29vZHMpXSk7XG4gICAgY29uc3QgYWRkZWQgPSBbXTtcbiAgICBjb25zdCBtaXNzZWQgPSBbXTtcbiAgICBrZXlzLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgY29uc3QgY3VzdG9tZXIgPSBjdXN0b21lckdvb2RzW2tleV0gfHwgeyBrZXksIG5hbWU6IGludGVybmFsR29vZHNba2V5XT8ubmFtZSB8fCBrZXksIHF1YW50aXR5OiAwIH07XG4gICAgICAgIGNvbnN0IGludGVybmFsID0gaW50ZXJuYWxHb29kc1trZXldIHx8IHsga2V5LCBuYW1lOiBjdXN0b21lci5uYW1lLCBxdWFudGl0eTogMCB9O1xuICAgICAgICBjb25zdCBkaWZmZXJlbmNlID0gaW50ZXJuYWwucXVhbnRpdHkgLSBjdXN0b21lci5xdWFudGl0eTtcbiAgICAgICAgaWYgKGRpZmZlcmVuY2UgPiAwKSBhZGRlZC5wdXNoKHsga2V5LCBuYW1lOiBpbnRlcm5hbC5uYW1lLCBxdWFudGl0eTogZGlmZmVyZW5jZSwgaW50ZXJuYWxRdWFudGl0eTogaW50ZXJuYWwucXVhbnRpdHksIGN1c3RvbWVyUXVhbnRpdHk6IGN1c3RvbWVyLnF1YW50aXR5IH0pO1xuICAgICAgICBpZiAoZGlmZmVyZW5jZSA8IDApIG1pc3NlZC5wdXNoKHsga2V5LCBuYW1lOiBjdXN0b21lci5uYW1lLCBxdWFudGl0eTogTWF0aC5hYnMoZGlmZmVyZW5jZSksIGludGVybmFsUXVhbnRpdHk6IGludGVybmFsLnF1YW50aXR5LCBjdXN0b21lclF1YW50aXR5OiBjdXN0b21lci5xdWFudGl0eSB9KTtcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgICBhZGRlZDogYWRkZWQuc29ydCgoYSwgYikgPT4gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lLCAncnUnKSksXG4gICAgICAgIG1pc3NlZDogbWlzc2VkLnNvcnQoKGEsIGIpID0+IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSwgJ3J1JykpXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrRm9ybWF0R29vZHMoaXRlbXMpIHtcbiAgICByZXR1cm4gaXRlbXMubGVuZ3RoXG4gICAgICAgID8gaXRlbXMubWFwKGl0ZW0gPT4gYCR7aXRlbS5uYW1lfSDDlyAke2l0ZW0ucXVhbnRpdHl9YCkuam9pbignOyAnKVxuICAgICAgICA6ICfQvdC10YInO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tTaG93UmVzdWx0KHJlc3VsdCkge1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJJbnRlcm5hbE9yZGVyQ2hlY2tSZXN1bHQnKT8ucmVtb3ZlKCk7XG4gICAgY29uc3Qgd2luID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgd2luLmlkID0gJ2hhY2tlckludGVybmFsT3JkZXJDaGVja1Jlc3VsdCc7XG4gICAgd2luLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC13aW5kb3cnO1xuICAgIHdpbi5zdHlsZS53aWR0aCA9ICc0MzBweCc7XG4gICAgd2luLnN0eWxlLnJpZ2h0ID0gJzQ2MHB4JztcblxuICAgIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWRlci5jbGFzc05hbWUgPSAnbWMtZmxvYXQtaGVhZGVyJztcbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRpdGxlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC10aXRsZSc7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSAn8J+TpiDQoNC10LfRg9C70YzRgtCw0YIg0L/RgNC+0LLQtdGA0LrQuCDRgtC+0LLQsNGA0L7Qsic7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGNsb3NlLnR5cGUgPSAnYnV0dG9uJztcbiAgICBjbG9zZS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtY2xvc2UnO1xuICAgIGNsb3NlLnRleHRDb250ZW50ID0gJ+KclSc7XG4gICAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB3aW4ucmVtb3ZlKCkpO1xuICAgIGhlYWRlci5hcHBlbmRDaGlsZChjbG9zZSk7XG4gICAgd2luLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm9keS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtYm9keSc7XG4gICAgY29uc3Qgc3VtbWFyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHN1bW1hcnkuc3R5bGUuY3NzVGV4dCA9ICdmb250LXNpemU6MTFweDtjb2xvcjojNjQ3NDhiO21hcmdpbi1ib3R0b206OHB4Oyc7XG4gICAgc3VtbWFyeS50ZXh0Q29udGVudCA9IGDQlNC+0LHQsNCy0LvQtdC90L46ICR7cmVzdWx0LmFkZGVkLmxlbmd0aH07INGD0L/Rg9GJ0LXQvdC+OiAke3Jlc3VsdC5taXNzZWQubGVuZ3RofWA7XG4gICAgYm9keS5hcHBlbmRDaGlsZChzdW1tYXJ5KTtcblxuICAgIGNvbnN0IGFkZFNlY3Rpb24gPSAodGl0bGVUZXh0LCBpdGVtcywgY29sb3IsIGVtcHR5VGV4dCkgPT4ge1xuICAgICAgICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VjdGlvbicpO1xuICAgICAgICBzZWN0aW9uLnN0eWxlLmNzc1RleHQgPSAnbWFyZ2luLWJvdHRvbToxMHB4Oyc7XG4gICAgICAgIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgaGVhZGluZy5zdHlsZS5jc3NUZXh0ID0gYGZvbnQtc2l6ZToxMS41cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiR7Y29sb3J9O21hcmdpbi1ib3R0b206NHB4O2A7XG4gICAgICAgIGhlYWRpbmcudGV4dENvbnRlbnQgPSB0aXRsZVRleHQ7XG4gICAgICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoaGVhZGluZyk7XG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9ICdwYWRkaW5nOjdweCA5cHg7Ym9yZGVyOjFweCBzb2xpZCAjZTVlN2ViO2JvcmRlci1yYWRpdXM6N3B4O2NvbG9yOiM2NDc0OGI7Zm9udC1zaXplOjExcHg7JztcbiAgICAgICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gZW1wdHlUZXh0O1xuICAgICAgICAgICAgc2VjdGlvbi5hcHBlbmRDaGlsZChlbXB0eSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpdGVtcy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgICAgIHJvdy5zdHlsZS5jc3NUZXh0ID0gJ3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjRweDtib3JkZXI6MXB4IHNvbGlkICNlNWU3ZWI7Ym9yZGVyLXJhZGl1czo3cHg7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxZjI5Mzc7Zm9udC1zaXplOjExLjVweDsnO1xuICAgICAgICAgICAgICAgIHJvdy50ZXh0Q29udGVudCA9IGAke2l0ZW0ubmFtZX0gw5cgJHtpdGVtLnF1YW50aXR5fWA7XG4gICAgICAgICAgICAgICAgc2VjdGlvbi5hcHBlbmRDaGlsZChyb3cpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgYm9keS5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgICB9O1xuXG4gICAgYWRkU2VjdGlvbign4p6VINCU0L7QsdCw0LLQu9C10L3QviDQstC+INCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQsNGFJywgcmVzdWx0LmFkZGVkLCAnIzE2NjUzNCcsICfQndC10YIg0LvQuNGI0L3QuNGFINC/0L7Qt9C40YbQuNC5Jyk7XG4gICAgYWRkU2VjdGlvbign4pqg77iPINCj0L/Rg9GJ0LXQvdC+INCy0L4g0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9Cw0YUnLCByZXN1bHQubWlzc2VkLCAnI2I5MWMxYycsICfQktGB0LUg0L/QvtC30LjRhtC40Lgg0L/QvtC60YDRi9GC0YsnKTtcbiAgICB3aW4uYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh3aW4pO1xuICAgIG1ha2VNb3ZhYmxlKHdpbiwgaGVhZGVyKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrQ29sbGVjdEdvb2RzKGVudGl0eSwgZG9jdW1lbnRzKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBjb25zdCBvdXRjb21lcyA9IG5ldyBBcnJheShkb2N1bWVudHMubGVuZ3RoKTtcbiAgICBsZXQgbmV4dEluZGV4ID0gMDtcbiAgICBjb25zdCB3b3JrZXIgPSBhc3luYyAoKSA9PiB7XG4gICAgICAgIHdoaWxlIChuZXh0SW5kZXggPCBkb2N1bWVudHMubGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgICAgIGNvbnN0IGluZGV4ID0gbmV4dEluZGV4Kys7XG4gICAgICAgICAgICBjb25zdCBkb2N1bWVudCA9IGRvY3VtZW50c1tpbmRleF07XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHBvc2l0aW9ucyA9IGF3YWl0IGludGVybmFsT3JkZXJDaGVja1Bvc2l0aW9uUm93cyhlbnRpdHksIGRvY3VtZW50KTtcbiAgICAgICAgICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShgJHtkb2N1bWVudC5uYW1lIHx8IGRvY3VtZW50LmlkfTog0L/QvtC70YPRh9C10L3QviDQv9C+0LfQuNGG0LjQuSDigJQgJHtwb3NpdGlvbnMubGVuZ3RofWApO1xuICAgICAgICAgICAgICAgIG91dGNvbWVzW2luZGV4XSA9IHsgZG9jdW1lbnQsIHBvc2l0aW9ucywgZXJyb3I6IG51bGwgfTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbikgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoYCR7ZG9jdW1lbnQubmFtZSB8fCBkb2N1bWVudC5pZH06INC90LUg0YPQtNCw0LvQvtGB0Ywg0L/QvtC70YPRh9C40YLRjCDQv9C+0LfQuNGG0LjQuGAsIGVycm9yLCAnZXJyJyk7XG4gICAgICAgICAgICAgICAgb3V0Y29tZXNbaW5kZXhdID0geyBkb2N1bWVudCwgcG9zaXRpb25zOiBbXSwgZXJyb3IgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG4gICAgY29uc3Qgd29ya2VyQ291bnQgPSBNYXRoLm1pbihNU19BUElfTUFYX0NPTkNVUlJFTlRfUkVRVUVTVFMsIGRvY3VtZW50cy5sZW5ndGgpO1xuICAgIGF3YWl0IFByb21pc2UuYWxsKEFycmF5LmZyb20oeyBsZW5ndGg6IHdvcmtlckNvdW50IH0sIHdvcmtlcikpO1xuICAgIGNvbnN0IGZhaWx1cmVzID0gb3V0Y29tZXMuZmlsdGVyKG91dGNvbWUgPT4gb3V0Y29tZS5lcnJvcik7XG4gICAgaWYgKGZhaWx1cmVzLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcihg0J3QtSDRg9C00LDQu9C+0YHRjCDQv9C+0LvQvdC+0YHRgtGM0Y4g0LfQsNCz0YDRg9C30LjRgtGMINC/0L7Qt9C40YbQuNC4INC00LvRjyAke2ZhaWx1cmVzLmxlbmd0aH0g0LjQtyAke2RvY3VtZW50cy5sZW5ndGh9INC00L7QutGD0LzQtdC90YLQvtCyYCk7XG4gICAgICAgIGVycm9yLnBhcnRpYWxGYWlsdXJlID0gdHJ1ZTtcbiAgICAgICAgZXJyb3IuZmFpbGVkRG9jdW1lbnRzID0gZmFpbHVyZXMubWFwKG91dGNvbWUgPT4gb3V0Y29tZS5kb2N1bWVudC5uYW1lIHx8IG91dGNvbWUuZG9jdW1lbnQuaWQgfHwgJ9CR0LXQtyDQvdCw0LfQstCw0L3QuNGPJyk7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICByZXR1cm4gaW50ZXJuYWxPcmRlckNoZWNrQWdncmVnYXRlKG91dGNvbWVzLmZsYXRNYXAob3V0Y29tZSA9PiBvdXRjb21lLnBvc2l0aW9ucykpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tDb21wYXJlKCkge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrUmVhZENvbnRyb2xzKCk7XG4gICAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsT3JkZXJDaGVja1N0YXR1cycpO1xuICAgIGNvbnN0IHNldFN0YXR1cyA9IChtZXNzYWdlLCBraW5kID0gJ2luZm8nKSA9PiB7XG4gICAgICAgIGlmIChzdGF0dXMpIHtcbiAgICAgICAgICAgIHN0YXR1cy50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gICAgICAgICAgICBzdGF0dXMuc3R5bGUuY29sb3IgPSBraW5kID09PSAnZXJyJyA/ICcjYjkxYzFjJyA6IGtpbmQgPT09ICd3YXJuJyA/ICcjYjQ1MzA5JyA6ICcjMTY2NTM0JztcbiAgICAgICAgfVxuICAgIH07XG4gICAgY29uc3QgY29tcGFyZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJJbnRlcm5hbE9yZGVyQ29tcGFyZScpO1xuICAgIGlmIChjb21wYXJlKSBjb21wYXJlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICBzZXRTdGF0dXMoJ9Cf0YDQvtCy0LXRgNGP0Y4g0LTQvtC60YPQvNC10L3RgtGLINC4INC/0L7Qt9C40YbQuNC44oCmJyk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgW2N1c3RvbWVyT3JkZXJzLCBpbnRlcm5hbE9yZGVyc10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaERvY3VtZW50cygnY3VzdG9tZXJvcmRlcicsIGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmN1c3RvbWVyT3JnYW5pemF0aW9uSHJlZiwgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuY3VzdG9tZXJXYXJlaG91c2VIcmVmLCBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5jdXN0b21lclN0YXR1c0hyZWZzKSxcbiAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja0ZldGNoRG9jdW1lbnRzKCdpbnRlcm5hbG9yZGVyJywgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuaW50ZXJuYWxPcmdhbml6YXRpb25IcmVmLCBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5pbnRlcm5hbFdhcmVob3VzZUhyZWYsIGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmludGVybmFsU3RhdHVzSHJlZnMpXG4gICAgICAgIF0pO1xuICAgICAgICAvLyBEbyBub3Qgc3dpdGNoIGFjY291bnRzIGJldHdlZW4gbGlzdCBjb2xsZWN0aW9uIGFuZCBwb3NpdGlvbiByZWFkcy5cbiAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbikgdGhyb3cgbmV3IEVycm9yKCfQl9Cw0L/RgNC+0YEg0LogYXBpLm1veXNrbGFkLnJ1INC+0YLQvNC10L3RkdC9Jyk7XG4gICAgICAgIGNvbnN0IFtjdXN0b21lckdvb2RzLCBpbnRlcm5hbEdvb2RzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja0NvbGxlY3RHb29kcygnY3VzdG9tZXJvcmRlcicsIGN1c3RvbWVyT3JkZXJzKSxcbiAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja0NvbGxlY3RHb29kcygnaW50ZXJuYWxvcmRlcicsIGludGVybmFsT3JkZXJzKVxuICAgICAgICBdKTtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbikgdGhyb3cgbmV3IEVycm9yKCfQl9Cw0L/RgNC+0YEg0LogYXBpLm1veXNrbGFkLnJ1INC+0YLQvNC10L3RkdC9Jyk7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGludGVybmFsT3JkZXJDaGVja0NvbXBhcmVNYXBzKGN1c3RvbWVyR29vZHMsIGludGVybmFsR29vZHMpO1xuICAgICAgICBjb25zdCBjdXN0b21lclRvdGFsID0gT2JqZWN0LnZhbHVlcyhjdXN0b21lckdvb2RzKS5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgaXRlbS5xdWFudGl0eSwgMCk7XG4gICAgICAgIGNvbnN0IGludGVybmFsVG90YWwgPSBPYmplY3QudmFsdWVzKGludGVybmFsR29vZHMpLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyBpdGVtLnF1YW50aXR5LCAwKTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoJ9Ch0YDQsNCy0L3QtdC90LjQtSDQt9Cw0LLQtdGA0YjQtdC90L4nLCB7XG4gICAgICAgICAgICBjdXN0b21lck9yZGVyczogY3VzdG9tZXJPcmRlcnMubGVuZ3RoLFxuICAgICAgICAgICAgaW50ZXJuYWxPcmRlcnM6IGludGVybmFsT3JkZXJzLmxlbmd0aCxcbiAgICAgICAgICAgIGN1c3RvbWVyUG9zaXRpb25zOiBjdXN0b21lclRvdGFsLFxuICAgICAgICAgICAgaW50ZXJuYWxQb3NpdGlvbnM6IGludGVybmFsVG90YWwsXG4gICAgICAgICAgICBhZGRlZDogcmVzdWx0LmFkZGVkLFxuICAgICAgICAgICAgbWlzc2VkOiByZXN1bHQubWlzc2VkXG4gICAgICAgIH0pO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShg4p6VINCU0L7QsdCw0LLQu9C10L3QviDQstC+INCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQsNGFOiAke2ludGVybmFsT3JkZXJDaGVja0Zvcm1hdEdvb2RzKHJlc3VsdC5hZGRlZCl9YCwgcmVzdWx0LmFkZGVkLmxlbmd0aCA/IHJlc3VsdC5hZGRlZCA6IG51bGwsIHJlc3VsdC5hZGRlZC5sZW5ndGggPyAnaW5mbycgOiAnd2FybicpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShg4pqg77iPINCj0L/Rg9GJ0LXQvdC+INCy0L4g0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9Cw0YU6ICR7aW50ZXJuYWxPcmRlckNoZWNrRm9ybWF0R29vZHMocmVzdWx0Lm1pc3NlZCl9YCwgcmVzdWx0Lm1pc3NlZC5sZW5ndGggPyByZXN1bHQubWlzc2VkIDogbnVsbCwgcmVzdWx0Lm1pc3NlZC5sZW5ndGggPyAnd2FybicgOiAnaW5mbycpO1xuICAgICAgICBpZiAoIXJlc3VsdC5hZGRlZC5sZW5ndGggJiYgIXJlc3VsdC5taXNzZWQubGVuZ3RoKSBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZSgn4pyFINCh0L/QuNGB0LrQuCDRgtC+0LLQsNGA0L7QsiDRgdC+0LLQv9Cw0LTQsNGO0YInLCBudWxsLCAnaW5mbycpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTaG93UmVzdWx0KHJlc3VsdCk7XG4gICAgICAgIHNldFN0YXR1cyhg0JPQvtGC0L7QstC+OiDQtNC+0LHQsNCy0LvQtdC90L4gJHtyZXN1bHQuYWRkZWQubGVuZ3RofSwg0YPQv9GD0YnQtdC90L4gJHtyZXN1bHQubWlzc2VkLmxlbmd0aH1gKTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IucGFydGlhbEZhaWx1cmVcbiAgICAgICAgICAgID8gYNCU0LDQvdC90YvQtSDQvdC10L/QvtC70L3Ri9C1LCDRgdGA0LDQstC90LXQvdC40LUg0L7RgtC80LXQvdC10L3Qvi4g0J7RiNC40LHQutCwINC30LDQs9GA0YPQt9C60Lg6ICR7ZXJyb3IuZmFpbGVkRG9jdW1lbnRzLmpvaW4oJywgJyl9YFxuICAgICAgICAgICAgOiBlcnJvci5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcik7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKCfQodGA0LDQstC90LXQvdC40LUg0L3QtSDQstGL0L/QvtC70L3QtdC90L4nLCBlcnJvciwgJ2VycicpO1xuICAgICAgICBzZXRTdGF0dXMobWVzc2FnZSwgJ2VycicpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAoY29tcGFyZSkgY29tcGFyZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrQnVpbGRTZXR0aW5nc1BhbmVsKCkge1xuICAgIGludGVybmFsT3JkZXJDaGVja0xvYWRTZXR0aW5ncygpO1xuICAgIGNvbnN0IHdyYXAgPSBoYWNrZXJFbCgnZGl2Jyk7XG4gICAgd3JhcC5pZCA9ICdoYWNrZXJJbnRlcm5hbE9yZGVyU2V0dGluZ3MnO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTFweDtjb2xvcjojNjQ3NDhiO2xpbmUtaGVpZ2h0OjEuNDttYXJnaW4tYm90dG9tOjhweDsnLFxuICAgICAgICAn0K3RgtC4INC/0LDRgNCw0LzQtdGC0YDRiyDQuNGB0L/QvtC70YzQt9GD0Y7RgtGB0Y8g0LLQutC70LDQtNC60L7QuSDCq9Cf0YDQvtCy0LXRgNC60LAg0LfQsNC60LDQt9C+0LLCuy4g0JjQt9C80LXQvdC10L3QuNGPINGB0L7RhdGA0LDQvdGP0Y7RgtGB0Y8g0LDQstGC0L7QvNCw0YLQuNGH0LXRgdC60LguJykpO1xuXG4gICAgY29uc3QgZmllbGQgPSAobGFiZWwsIHNlbGVjdCkgPT4ge1xuICAgICAgICBjb25zdCBibG9jayA9IGhhY2tlckVsKCdsYWJlbCcsICdkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM0NzU1Njk7bWFyZ2luLWJvdHRvbTo4cHg7JywgbGFiZWwpO1xuICAgICAgICBibG9jay5hcHBlbmRDaGlsZChzZWxlY3QpO1xuICAgICAgICByZXR1cm4gYmxvY2s7XG4gICAgfTtcbiAgICBjb25zdCBzZWxlY3RTdHlsZSA9ICdkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7bWFyZ2luLXRvcDozcHg7cGFkZGluZzo1cHggNnB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDsnO1xuICAgIGNvbnN0IGN1c3RvbWVyT3JnYW5pemF0aW9uID0gaGFja2VyU2VsZWN0KCdoYWNrZXJJbnRlcm5hbEN1c3RvbWVyT3JnYW5pemF0aW9uJywgJ+KAlCDQvtGA0LPQsNC90LjQt9Cw0YbQuNGPINC30LDQutCw0LfQvtCyIOKAlCcpO1xuICAgIGNvbnN0IGludGVybmFsT3JnYW5pemF0aW9uID0gaGFja2VyU2VsZWN0KCdoYWNrZXJJbnRlcm5hbE9yZGVyT3JnYW5pemF0aW9uJywgJ+KAlCDQvtGA0LPQsNC90LjQt9Cw0YbQuNGPINCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQvtCyIOKAlCcpO1xuICAgIGNvbnN0IGN1c3RvbWVyV2FyZWhvdXNlID0gaGFja2VyU2VsZWN0KCdoYWNrZXJJbnRlcm5hbEN1c3RvbWVyV2FyZWhvdXNlJywgJ+KAlCDRgdC60LvQsNC0INC30LDQutCw0LfQvtCyIOKAlCcpO1xuICAgIGNvbnN0IGludGVybmFsV2FyZWhvdXNlID0gaGFja2VyU2VsZWN0KCdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlJywgJ+KAlCDRgdC60LvQsNC0INCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQvtCyIOKAlCcpO1xuICAgIFtjdXN0b21lck9yZ2FuaXphdGlvbiwgaW50ZXJuYWxPcmdhbml6YXRpb24sIGN1c3RvbWVyV2FyZWhvdXNlLCBpbnRlcm5hbFdhcmVob3VzZV0uZm9yRWFjaChzZWxlY3QgPT4geyBzZWxlY3Quc3R5bGUuY3NzVGV4dCA9IHNlbGVjdFN0eWxlOyB9KTtcblxuICAgIGNvbnN0IGN1c3RvbWVyU3RhdHVzZXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcbiAgICBjdXN0b21lclN0YXR1c2VzLmlkID0gJ2hhY2tlckludGVybmFsQ3VzdG9tZXJTdGF0dXNlcyc7XG4gICAgY3VzdG9tZXJTdGF0dXNlcy5tdWx0aXBsZSA9IHRydWU7XG4gICAgY3VzdG9tZXJTdGF0dXNlcy5zaXplID0gNDtcbiAgICBjdXN0b21lclN0YXR1c2VzLnN0eWxlLmNzc1RleHQgPSBzZWxlY3RTdHlsZSArICdtaW4taGVpZ2h0Ojc2cHg7JztcbiAgICBjb25zdCBpbnRlcm5hbFN0YXR1c2VzID0gY3VzdG9tZXJTdGF0dXNlcy5jbG9uZU5vZGUoZmFsc2UpO1xuICAgIGludGVybmFsU3RhdHVzZXMuaWQgPSAnaGFja2VySW50ZXJuYWxPcmRlclN0YXR1c2VzJztcblxuICAgIHdyYXAuYXBwZW5kQ2hpbGQoZmllbGQoJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0LfQsNC60LDQt9C+0LI6JywgY3VzdG9tZXJPcmdhbml6YXRpb24pKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGZpZWxkKCfQntGA0LPQsNC90LjQt9Cw0YbQuNGPINCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQvtCyOicsIGludGVybmFsT3JnYW5pemF0aW9uKSk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChmaWVsZCgn0KHQutC70LDQtCDQt9Cw0LrQsNC30L7QsjonLCBjdXN0b21lcldhcmVob3VzZSkpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoZmllbGQoJ9Ch0LrQu9Cw0LQg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LI6JywgaW50ZXJuYWxXYXJlaG91c2UpKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGZpZWxkKCfQodGC0LDRgtGD0YHRiyDQt9Cw0LrQsNC30L7QsiAoQ3RybC/ijJgg4oCUINC90LXRgdC60L7Qu9GM0LrQvik6JywgY3VzdG9tZXJTdGF0dXNlcykpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoZmllbGQoJ9Ch0YLQsNGC0YPRgdGLINCy0L3Rg9GC0YDQtdC90L3QuNGFINC30LDQutCw0LfQvtCyIChDdHJsL+KMmCDigJQg0L3QtdGB0LrQvtC70YzQutC+KTonLCBpbnRlcm5hbFN0YXR1c2VzKSk7XG5cbiAgICBjb25zdCByZWZyZXNoID0gaGFja2VyQnRuKCdoYWNrZXJJbnRlcm5hbE9yZGVyUmVmcmVzaCcsICfirIcg0JfQsNCz0YDRg9C30LjRgtGMINGB0L/RgNCw0LLQvtGH0L3QuNC60LgnLCBIQUNLRVJfTUlOSV9CVE5fQ1NTKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHJlZnJlc2gpO1xuICAgIGNvbnN0IHN0YXR1cyA9IGhhY2tlckVsKCdkaXYnLCAnbWluLWhlaWdodDoxNnB4O21hcmdpbi10b3A6NnB4O2ZvbnQtc2l6ZToxMC41cHg7JywgJycpO1xuICAgIHN0YXR1cy5pZCA9ICdoYWNrZXJJbnRlcm5hbE9yZGVyU2V0dGluZ3NTdGF0dXMnO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoc3RhdHVzKTtcblxuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxPcmdhbml6YXRpb25zKHdyYXApO1xuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxXYXJlaG91c2VzKHdyYXApO1xuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxTdGF0dXNlcygnY3VzdG9tZXJvcmRlcicsIHdyYXApO1xuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxTdGF0dXNlcygnaW50ZXJuYWxvcmRlcicsIHdyYXApO1xuICAgIG1zUmVmZXJlbmNlU2hvd1N0YXR1cyhzdGF0dXMpO1xuICAgIGN1c3RvbWVyT3JnYW5pemF0aW9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGludGVybmFsT3JkZXJDaGVja1JlYWRDb250cm9scyk7XG4gICAgaW50ZXJuYWxPcmdhbml6YXRpb24uYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaW50ZXJuYWxPcmRlckNoZWNrUmVhZENvbnRyb2xzKTtcbiAgICBjdXN0b21lcldhcmVob3VzZS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBpbnRlcm5hbE9yZGVyQ2hlY2tSZWFkQ29udHJvbHMpO1xuICAgIGludGVybmFsV2FyZWhvdXNlLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGludGVybmFsT3JkZXJDaGVja1JlYWRDb250cm9scyk7XG4gICAgY3VzdG9tZXJTdGF0dXNlcy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBpbnRlcm5hbE9yZGVyQ2hlY2tSZWFkQ29udHJvbHMpO1xuICAgIGludGVybmFsU3RhdHVzZXMuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaW50ZXJuYWxPcmRlckNoZWNrUmVhZENvbnRyb2xzKTtcbiAgICByZWZyZXNoLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tSZWZyZXNoQWxsTGlzdHMoc3RhdHVzKVxuICAgICAgICAgICAgLmNhdGNoKGVycm9yID0+IGludGVybmFsT3JkZXJDaGVja1RyYWNlKCfQndC1INGD0LTQsNC70L7RgdGMINC+0LHQvdC+0LLQuNGC0Ywg0YHQv9C40YHQutC4JywgZXJyb3IsICdlcnInKSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHdyYXA7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckJ1aWxkSW50ZXJuYWxPcmRlckNoZWNrVGFiKCkge1xuICAgIGludGVybmFsT3JkZXJDaGVja0xvYWRTZXR0aW5ncygpO1xuICAgIGNvbnN0IHdyYXAgPSBoYWNrZXJFbCgnZGl2Jyk7XG4gICAgd3JhcC5pZCA9ICdoYWNrZXJUYWJJbnRlcm5hbE9yZGVyQ2hlY2snO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoaGFja2VyRWwoJ2RpdicsICdmb250LXNpemU6MTFweDtjb2xvcjojNjQ3NDhiO2xpbmUtaGVpZ2h0OjEuNDttYXJnaW4tYm90dG9tOjhweDsnLFxuICAgICAgICAn0KHRgNCw0LLQvdC40LLQsNC10YIg0YLQvtCy0LDRgNGLINC40Lcg0LfQsNC60LDQt9C+0LIg0L/QvtC60YPQv9Cw0YLQtdC70LXQuSDRgSDRgtC+0LLQsNGA0LDQvNC4INC40Lcg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LIg0L/QviDRgdC+0YXRgNCw0L3RkdC90L3Ri9C8INC/0LDRgNCw0LzQtdGC0YDQsNC8LicpKTtcblxuICAgIGNvbnN0IGJ1dHRvbnMgPSBoYWNrZXJFbCgnZGl2JywgJ2Rpc3BsYXk6ZmxleDtnYXA6NHB4O2ZsZXgtd3JhcDp3cmFwOycpO1xuICAgIGNvbnN0IHNldHRpbmdzID0gaGFja2VyQnRuKCdoYWNrZXJJbnRlcm5hbE9yZGVyT3BlblNldHRpbmdzJywgJ+Kame+4jyDQndCw0YHRgtGA0L7QuNGC0Ywg0L/RgNC+0LLQtdGA0LrRgycsIEhBQ0tFUl9NSU5JX0JUTl9DU1MpO1xuICAgIGNvbnN0IGNvbXBhcmUgPSBoYWNrZXJCdG4oJ2hhY2tlckludGVybmFsT3JkZXJDb21wYXJlJywgJ/CflI4g0J/RgNC+0LLQtdGA0LjRgtGMINGC0L7QstCw0YDRiycsIEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6IzRmNDZlNTsnKTtcbiAgICBidXR0b25zLmFwcGVuZChzZXR0aW5ncywgY29tcGFyZSk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChidXR0b25zKTtcbiAgICBjb25zdCBzdGF0dXMgPSBoYWNrZXJFbCgnZGl2JywgJ21pbi1oZWlnaHQ6MTZweDttYXJnaW4tdG9wOjZweDtmb250LXNpemU6MTAuNXB4OycsICcnKTtcbiAgICBzdGF0dXMuaWQgPSAnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzJztcbiAgICB3cmFwLmFwcGVuZENoaWxkKHN0YXR1cyk7XG5cbiAgICBzZXR0aW5ncy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IG9wZW5TZXR0aW5nc1dpbmRvdygnaW50ZXJuYWxPcmRlckNoZWNrJykpO1xuICAgIGNvbXBhcmUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IGludGVybmFsT3JkZXJDaGVja0NvbXBhcmUoKS5jYXRjaChlcnJvciA9PiBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZSgn0KHRgNCw0LLQvdC10L3QuNC1OiAnICsgZXJyb3IubWVzc2FnZSwgZXJyb3IsICdlcnInKSk7IH0pO1xuICAgIHJldHVybiB3cmFwO1xufVxuIiwiLy8gUHJpdmF0ZSBQYW5lbCBhZGFwdGVyIGFuZCBzdGFydHVwL2xpZmVjeWNsZSBjYXBhYmlsaXRpZXMuIENvbmZpZ3VyZWQgYmVmb3JlIGluaXRpYWxpemUuXG5sZXQgZXh0ZW5zaW9uUGFuZWxSZXF1ZXN0U2VxdWVuY2UgPSAwO1xubGV0IGV4dGVuc2lvblBhbmVsU3RhdGVMaXN0ZW5lciA9ICgpID0+IHt9O1xuZnVuY3Rpb24gZXh0ZW5zaW9uUGFuZWxBdXRoTG9zdCgpIHtcbiAgICBleHRlbnNpb25QYW5lbFJlcXVlc3RTZXF1ZW5jZSsrO1xuICAgIGV4dGVuc2lvblBhbmVsU3RhdGVMaXN0ZW5lcignZXJyb3InLCAnUGFuZWw6INGB0LXRgdGB0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsC4g0JLQvtC50LTQuNGC0LUg0LIgcGFuZWwuaGF0aWtvLnJ1INCyINGN0YLQvtC8INC/0YDQvtGE0LjQu9C1IENocm9tZS4nKTtcbn1cbmZ1bmN0aW9uIGV4dGVuc2lvblBhbmVsQ3NyZihvblN1Y2Nlc3MsIG9uRXJyb3IsIGZvcmNlKSB7XG4gICAgbGV0IGZpbmlzaGVkID0gZmFsc2U7XG4gICAgY29uc3Qgc2VxdWVuY2UgPSArK2V4dGVuc2lvblBhbmVsUmVxdWVzdFNlcXVlbmNlO1xuICAgIGV4dGVuc2lvblBhbmVsU3RhdGVMaXN0ZW5lcigndW5rbm93bicsICdQYW5lbDog0L/RgNC+0LLQtdGA0Y/QtdC8INGB0LXRgdGB0LjRjuKApicpO1xuICAgIGNvbnN0IGZpbmlzaCA9IHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChmaW5pc2hlZCkgcmV0dXJuO1xuICAgICAgICBmaW5pc2hlZCA9IHRydWU7XG4gICAgICAgIGNvbnN0IGVycm9yID0gY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yXG4gICAgICAgICAgICA/ICfQoNCw0YHRiNC40YDQtdC90LjQtSDQvtCx0L3QvtCy0LvQtdC90L4g0LjQu9C4INC90LXQtNC+0YHRgtGD0L/QvdC+LiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDQstC60LvQsNC00LrRgy4nXG4gICAgICAgICAgICA6IHJlc3VsdD8ub2sgJiYgdHlwZW9mIHJlc3VsdC50b2tlbiA9PT0gJ3N0cmluZycgJiYgL15bQS1aYS16MC05Xy1dezE2LDUxMn0kLy50ZXN0KHJlc3VsdC50b2tlbilcbiAgICAgICAgICAgICAgICA/ICcnIDogcmVzdWx0Py5lcnJvciB8fCAnUGFuZWw6INGE0L7QvdC+0LLQsNGPINGB0LXRgdGB0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsC4g0JLQvtC50LTQuNGC0LUg0LIgcGFuZWwuaGF0aWtvLnJ1Lic7XG4gICAgICAgIGlmIChzZXF1ZW5jZSA9PT0gZXh0ZW5zaW9uUGFuZWxSZXF1ZXN0U2VxdWVuY2UpIGV4dGVuc2lvblBhbmVsU3RhdGVMaXN0ZW5lcihlcnJvciA/ICdlcnJvcicgOiAnb2snLCBlcnJvcik7XG4gICAgICAgIGlmIChlcnJvcikgb25FcnJvcj8uKG5ldyBFcnJvcihlcnJvcikpOyBlbHNlIG9uU3VjY2Vzcz8uKHJlc3VsdC50b2tlbik7XG4gICAgfTtcbiAgICB0cnkgeyBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdtZW1jaGF0OnBhbmVsLWNzcmYnLCBmb3JjZSB9LCBmaW5pc2gpOyB9XG4gICAgY2F0Y2ggeyBmaW5pc2goeyBvazogZmFsc2UsIGVycm9yOiAn0KDQsNGB0YjQuNGA0LXQvdC40LUg0L3QtdC00L7RgdGC0YPQv9C90L4uINCf0LXRgNC10LfQsNCz0YDRg9C30LjRgtC1INCy0LrQu9Cw0LTQutGDLicgfSk7IH1cbn1cbmZ1bmN0aW9uIGNvbmZpZ3VyZUV4dGVuc2lvblBsYXRmb3JtKHBsYXRmb3JtKSB7XG4gICAgcGxhdGZvcm0ucGFuZWwgPSB7IGVuc3VyZTogZXh0ZW5zaW9uUGFuZWxDc3JmIH07XG4gICAgcGxhdGZvcm0uZGlyZWN0TXMgPSB0cnVlO1xuICAgIGNsZWFyUGFuZWxDc3JmKCk7XG4gICAgaWYgKHR5cGVvZiBleHRlbnNpb25Db25maWd1cmVPcmRlcnMgPT09ICdmdW5jdGlvbicpIGV4dGVuc2lvbkNvbmZpZ3VyZU9yZGVycyhwbGF0Zm9ybSk7XG4gICAgaWYgKHR5cGVvZiBleHRlbnNpb25Db25maWd1cmVEaWFnbm9zdGljcyA9PT0gJ2Z1bmN0aW9uJykgZXh0ZW5zaW9uQ29uZmlndXJlRGlhZ25vc3RpY3MocGxhdGZvcm0pO1xuICAgIC8vIENyb3NzLXRhYiBjaGFuZ2VzIHVzZSBwcml2YXRlIHJ1bnRpbWUgbWVzc2FnZXMsIG5ldmVyIHNpdGUtcmVhZGFibGUgU3RvcmFnZUV2ZW50cy5cbiAgICBpZiAodHlwZW9mIGV4dGVuc2lvblN0b3JhZ2VPbkNoYW5nZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgZXh0ZW5zaW9uU3RvcmFnZU9uQ2hhbmdlID0ga2V5ID0+IHtcbiAgICAgICAgICAgIGlmIChrZXkgPT09IHN0b3JhZ2VLZXkoJ2hhY2tlck1zQXBpX3YxJykpIGhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCk7XG4gICAgICAgICAgICBpZiAoW3N0b3JhZ2VLZXkoJ2NsZWFyVGV4dEVuYWJsZWQnKSwgc3RvcmFnZUtleSgnY2xlYXJUZXh0RGVsYXlfdjEnKV0uaW5jbHVkZXMoa2V5KSkgc2V0dXBHbG9iYWxDbGVhclRleHRGdW5jdGlvbmFsaXR5KCk7XG4gICAgICAgIH07XG4gICAgICAgIGV4dGVuc2lvblN0b3JhZ2VPbkVycm9yID0gKCkgPT4ge1xuICAgICAgICAgICAgaGFja2VyQ3JlZGVudGlhbFNjb3BlQmxvY2tlZCA9IHRydWU7XG4gICAgICAgICAgICBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIG1zQXBpQ2FuY2VsQWxsKCk7XG4gICAgICAgICAgICBoYWNrZXJTeW5jQWNjZXNzVWkoKTtcbiAgICAgICAgfTtcbiAgICB9XG59XG5cbmNvbmZpZ3VyZUV4dGVuc2lvblBsYXRmb3JtKG1lbWNoYXRQbGF0Zm9ybSk7XG4iLCIvLyBFeHRlbnNpb24tb25seSBub3RpZmllcjogY29udGVudCB0YWJzIGNvbmZpZ3VyZS9yZW5kZXI7IHRoZSBNVjMgd29ya2VyIHBvbGxzLlxubGV0IGV4dGVuc2lvbk9yZGVyUmV2aXNpb247XG5sZXQgZXh0ZW5zaW9uT3JkZXJUb2tlbiA9ICcnO1xubGV0IGV4dGVuc2lvbk9yZGVyRWRpdCA9IGZhbHNlO1xubGV0IGV4dGVuc2lvbk9yZGVyU3luYyA9IFByb21pc2UucmVzb2x2ZSgpO1xubGV0IGV4dGVuc2lvbk9yZGVyTGFzdFNob3duID0gJyc7XG5jb25zdCBleHRlbnNpb25Db25uZWN0aW9uU3RhdGUgPSB7IHBhbmVsOiAndW5rbm93bicsIGJlYXJlcjogJ3Vua25vd24nLCBwYW5lbEVycm9yOiAnJyB9O1xuZnVuY3Rpb24gZXh0ZW5zaW9uTWVzc2FnZShtZXNzYWdlKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgdHJ5IHsgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobWVzc2FnZSwgcmVzdWx0ID0+IHtcbiAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHJlamVjdChFcnJvcign0KDQsNGB0YjQuNGA0LXQvdC40LUg0L7QsdC90L7QstC70LXQvdC+LiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDQstC60LvQsNC00LrRgy4nKSk7XG4gICAgICAgICAgICBlbHNlIGlmICghcmVzdWx0Py5vaykge1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQ/LmNvbmZsaWN0KSBleHRlbnNpb25PcmRlclJldmlzaW9uID0gcmVzdWx0LnJldmlzaW9uO1xuICAgICAgICAgICAgICAgIHJlamVjdChFcnJvcihyZXN1bHQ/LmVycm9yIHx8ICfQoNCw0YHRiNC40YDQtdC90LjQtSDQvdC10LTQvtGB0YLRg9C/0L3QvicpKTtcbiAgICAgICAgICAgIH0gZWxzZSByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgIH0pOyB9IGNhdGNoIHsgcmVqZWN0KEVycm9yKCfQoNCw0YHRiNC40YDQtdC90LjQtSDQvdC10LTQvtGB0YLRg9C/0L3Qvi4g0J/QtdGA0LXQt9Cw0LPRgNGD0LfQuNGC0LUg0LLQutC70LDQtNC60YMuJykpOyB9XG4gICAgfSk7XG59XG5mdW5jdGlvbiBleHRlbnNpb25SZW5kZXJDb25uZWN0aW9ucygpIHtcbiAgICBjb25zdCByb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21lbWNoYXRDb25uZWN0aW9uU3RhdHVzJyk7XG4gICAgaWYgKCFyb290KSByZXR1cm47XG4gICAgZXh0ZW5zaW9uQ29ubmVjdGlvblN0YXRlLmJlYXJlciA9IGhhY2tlckFwaVZhbGlkYXRlZCAmJiBoYWNrZXJCZWFyZXJFbmFibGVkID8gJ29rJyA6ICdlcnJvcic7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFsnYmVhcmVyJywgJ3BhbmVsJ10pIHtcbiAgICAgICAgY29uc3QgZWwgPSByb290LnF1ZXJ5U2VsZWN0b3IoYFtkYXRhLWNvbm5lY3Rpb249XCIke25hbWV9XCJdYCk7XG4gICAgICAgIGNvbnN0IHN0YXRlID0gbmF2aWdhdG9yLm9uTGluZSA9PT0gZmFsc2UgPyAndW5rbm93bicgOiBleHRlbnNpb25Db25uZWN0aW9uU3RhdGVbbmFtZV07XG4gICAgICAgIGNvbnN0IHRleHQgPSBgJHtzdGF0ZSA9PT0gJ29rJyA/ICfwn5+iJyA6IHN0YXRlID09PSAnZXJyb3InID8gJ/CflLQnIDogJ/Cfn6EnfSAke25hbWV9YDtcbiAgICAgICAgaWYgKGVsLnRleHRDb250ZW50ICE9PSB0ZXh0KSBlbC50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgICAgIGVsLmRhdGFzZXQuc3RhdGUgPSBzdGF0ZTtcbiAgICAgICAgZWwudGl0bGUgPSBuYW1lID09PSAncGFuZWwnXG4gICAgICAgICAgICA/IChleHRlbnNpb25Db25uZWN0aW9uU3RhdGUucGFuZWxFcnJvciB8fCAnUGFuZWw6INC/0L7QtNGC0LLQtdGA0LbQtNGR0L0g0LTQvtGB0YLRg9C/INC6INC30LDRidC40YnRkdC90L3QvtC80YMgQVBJLicpXG4gICAgICAgICAgICAgICAgKyAoc3RhdGUgPT09ICdlcnJvcicgPyAnINCe0YLQutGA0YvRgtGMIHBhbmVsLmhhdGlrby5ydSDQsiDQvdC+0LLQvtC5INCy0LrQu9Cw0LTQutC1LicgOiAnINCd0LDQttC80Lgg0LTQu9GPINC/0L7QstGC0L7RgNC90L7QuSDQv9GA0L7QstC10YDQutC4LicpXG4gICAgICAgICAgICA6ICdCZWFyZXI6INC/0L7QtNGC0LLQtdGA0LbQtNC10L3QuNC1INC60LvRjtGH0LAg0JzQvtC50KHQutC70LDQtCDQsiDRjdGC0L7QuSDQstC60LvQsNC00LrQtS4nO1xuICAgICAgICBlbC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBlbC50aXRsZSk7XG4gICAgfVxufVxuZnVuY3Rpb24gZXh0ZW5zaW9uQXR0YWNoQ29ubmVjdGlvbnMoKSB7XG4gICAgY29uc3QgbWFpbiA9IHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyO1xuICAgIGlmICghbWFpbiB8fCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdENvbm5lY3Rpb25TdGF0dXMnKSkgcmV0dXJuO1xuICAgIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICByb290LmlkID0gJ21lbWNoYXRDb25uZWN0aW9uU3RhdHVzJztcbiAgICByb290LnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2dhcDo5cHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZvbnQ6OC41cHgvMS40IFNlZ29lIFVJLHNhbnMtc2VyaWY7bWFyZ2luLXRvcDoycHg7Y29sb3I6IzQ3NTU2OTtmbGV4LXdyYXA6d3JhcDsnO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbJ2JlYXJlcicsICdwYW5lbCddKSB7XG4gICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGVsLnR5cGUgPSAnYnV0dG9uJzsgZWwuZGF0YXNldC5jb25uZWN0aW9uID0gbmFtZTtcbiAgICAgICAgZWwuc3R5bGUuY3NzVGV4dCA9ICdib3JkZXI6MDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O3BhZGRpbmc6MDtjdXJzb3I6cG9pbnRlcjtmb250OmluaGVyaXQ7Y29sb3I6aW5oZXJpdDsnO1xuICAgICAgICBlbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIGlmIChuYW1lID09PSAnYmVhcmVyJykgaGFja2VyVmFsaWRhdGVBcGlLZXkoKTtcbiAgICAgICAgICAgIGVsc2UgaWYgKGVsLmRhdGFzZXQuc3RhdGUgPT09ICdlcnJvcicpIHdpbmRvdy5vcGVuKCdodHRwczovL3BhbmVsLmhhdGlrby5ydS8nLCAnX2JsYW5rJywgJ25vb3BlbmVyLG5vcmVmZXJyZXInKTtcbiAgICAgICAgICAgIGVsc2UgZXh0ZW5zaW9uQ2hlY2tQYW5lbCh0cnVlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoZWwpO1xuICAgIH1cbiAgICBjb25zdCBvbGRTdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdEJlYXJlclN0YXR1cycpO1xuICAgIGlmIChvbGRTdGF0dXMpIG9sZFN0YXR1cy5yZXBsYWNlV2l0aChyb290KTtcbiAgICBlbHNlIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtZW1jaGF0VmVyc2lvbicpPy5hZnRlcihyb290KTtcbiAgICBleHRlbnNpb25SZW5kZXJDb25uZWN0aW9ucygpO1xuICAgIGV4dGVuc2lvbkNoZWNrUGFuZWwoZmFsc2UpO1xufVxuZnVuY3Rpb24gZXh0ZW5zaW9uQ2hlY2tQYW5lbChmb3JjZSkge1xuICAgIHJldHVybiBleHRlbnNpb25QYW5lbENzcmYoKCkgPT4ge30sICgpID0+IHt9LCBmb3JjZSA9PT0gdHJ1ZSk7XG59XG5mdW5jdGlvbiBleHRlbnNpb25Db25maWd1cmVPcmRlcnMocGxhdGZvcm0pIHtcbiAgICBwbGF0Zm9ybS5vbk1haW5DcmVhdGVkID0gZXh0ZW5zaW9uQXR0YWNoQ29ubmVjdGlvbnM7XG4gICAgcGxhdGZvcm0ub25BY2Nlc3NVaSA9IGV4dGVuc2lvblJlbmRlckNvbm5lY3Rpb25zO1xuICAgIGV4dGVuc2lvblBhbmVsU3RhdGVMaXN0ZW5lciA9IChzdGF0ZSwgZXJyb3IpID0+IHtcbiAgICAgICAgZXh0ZW5zaW9uQ29ubmVjdGlvblN0YXRlLnBhbmVsID0gc3RhdGU7XG4gICAgICAgIGV4dGVuc2lvbkNvbm5lY3Rpb25TdGF0ZS5wYW5lbEVycm9yID0gZXJyb3IgfHwgJyc7XG4gICAgICAgIGV4dGVuc2lvblJlbmRlckNvbm5lY3Rpb25zKCk7XG4gICAgfTtcbiAgICBwbGF0Zm9ybS5ub3RpZmllciA9IHsgc3RhcnQ6IGV4dGVuc2lvbk5vdGlmaWVyU3RhcnQsIHN0b3A6IGV4dGVuc2lvbk5vdGlmaWVyU3RvcCwgcG9sbDogZXh0ZW5zaW9uTm90aWZpZXJQb2xsLFxuICAgICAgICBpbmRpY2F0b3I6IGV4dGVuc2lvbk5vdGlmaWVyRW5zdXJlSW5kaWNhdG9yLCBlZGl0OiAoKSA9PiB7IGV4dGVuc2lvbk9yZGVyRWRpdCA9IHRydWU7IH0gfTtcbn1cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdvZmZsaW5lJywgZXh0ZW5zaW9uUmVuZGVyQ29ubmVjdGlvbnMpO1xud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ29ubGluZScsICgpID0+IHsgZXh0ZW5zaW9uQ29ubmVjdGlvblN0YXRlLnBhbmVsID0gJ3Vua25vd24nOyBleHRlbnNpb25SZW5kZXJDb25uZWN0aW9ucygpOyB9KTtcblxuZnVuY3Rpb24gZXh0ZW5zaW9uTm90aWZpZXJFbnN1cmVJbmRpY2F0b3IoKSB7XG4gICAgbGV0IGluZGljYXRvciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllckluZGljYXRvcicpO1xuICAgIGNvbnN0IGVuYWJsZWQgPSBoYWNrZXJBcGlWYWxpZGF0ZWQgJiYgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5lbmFibGVkICYmIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoICYmIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnMubGVuZ3RoO1xuICAgIGlmICghZW5hYmxlZCkgeyBpbmRpY2F0b3I/LnJlbW92ZSgpOyByZXR1cm47IH1cbiAgICBpZiAoIWluZGljYXRvcikge1xuICAgICAgICBpbmRpY2F0b3IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7IGluZGljYXRvci5pZCA9ICdoYWNrZXJOb3RpZmllckluZGljYXRvcic7IGluZGljYXRvci50ZXh0Q29udGVudCA9ICfwn5C7JztcbiAgICAgICAgaW5kaWNhdG9yLnRpdGxlID0gJ9Ce0L/RgNC+0YEg0LfQsNC60LDQt9C+0LIg0LLRi9C/0L7Qu9C90Y/QtdGC0YHRjyDQsiDRhNC+0L3QtSDRgNCw0YHRiNC40YDQtdC90LjRjyc7XG4gICAgICAgIGluZGljYXRvci5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO3JpZ2h0OjE0cHg7Ym90dG9tOjEycHg7b3BhY2l0eTouMzU7cG9pbnRlci1ldmVudHM6bm9uZTsnOyBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGluZGljYXRvcik7XG4gICAgfVxufTtcbmZ1bmN0aW9uIGV4dGVuc2lvbk5vdGlmaWVyU3RvcCgpIHtcbiAgICBleHRlbnNpb25PcmRlclRva2VuID0gJyc7XG4gICAgLy8gVGhpcyBob29rIGlzIGNhbGxlZCBiZWZvcmUgYSBsb2NhbCBjcmVkZW50aWFsIGNoYW5nZS9mYWlsZWQgdmFsaWRhdGlvbi5cbiAgICAvLyBQYWdlaGlkZSBkb2VzIG5vdCByZXZva2UgdGhlIHdvcmtlcjogY2xvc2luZyBhIHRhYiBtdXN0IG5vdCBzdG9wIHBvbGxpbmcuXG4gICAgaWYgKGhhY2tlck5vdGlmaWVyVGltZXIpIGNsZWFySW50ZXJ2YWwoaGFja2VyTm90aWZpZXJUaW1lcik7XG4gICAgaGFja2VyTm90aWZpZXJUaW1lciA9IG51bGw7XG4gICAgY29uc3QgdG9rZW4gPSBoYWNrZXJCZWFyZXJUb2tlbjtcbiAgICBpZiAoIXRva2VuKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgY29uc3QgcGVuZGluZyA9IGV4dGVuc2lvbk9yZGVyU3luYy50aGVuKCgpID0+IGV4dGVuc2lvbk1lc3NhZ2UoeyB0eXBlOiAnbWVtY2hhdDpvcmRlcnMtc3RvcCcsIHRva2VuIH0pKVxuICAgICAgICAudGhlbihyZXN1bHQgPT4geyBleHRlbnNpb25PcmRlclJldmlzaW9uID0gcmVzdWx0LnJldmlzaW9uOyB9LCAoKSA9PiB7fSk7XG4gICAgZXh0ZW5zaW9uT3JkZXJTeW5jID0gcGVuZGluZztcbiAgICByZXR1cm4gcGVuZGluZztcbn07XG5mdW5jdGlvbiBleHRlbnNpb25Ob3RpZmllclN0YXJ0KCkge1xuICAgIGlmIChoYWNrZXJOb3RpZmllclRpbWVyKSBjbGVhckludGVydmFsKGhhY2tlck5vdGlmaWVyVGltZXIpO1xuICAgIGhhY2tlck5vdGlmaWVyVGltZXIgPSBudWxsO1xuICAgIGlmICghaGFja2VyQXBpVmFsaWRhdGVkIHx8ICFoYWNrZXJCZWFyZXJFbmFibGVkIHx8ICFoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBjb25zdCB1cGRhdGUgPSBleHRlbnNpb25PcmRlckVkaXQ7IGV4dGVuc2lvbk9yZGVyRWRpdCA9IGZhbHNlO1xuICAgIGNvbnN0IHBheWxvYWQgPSB7IHR5cGU6ICdtZW1jaGF0Om9yZGVycy1jb25maWd1cmUnLCB0b2tlbjogaGFja2VyQmVhcmVyVG9rZW4sIHNldHRpbmdzOiB7IC4uLmhhY2tlck5vdGlmaWVyU2V0dGluZ3MgfSxcbiAgICAgICAgb3JnYW5pemF0aW9uczogaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zLm1hcChpdGVtID0+ICh7IGhyZWY6IGl0ZW0uaHJlZiwgbmFtZTogaXRlbS5uYW1lIH0pKSwgdXBkYXRlIH07XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBjb25zdCBwZW5kaW5nID0gZXh0ZW5zaW9uT3JkZXJTeW5jLnRoZW4oKCkgPT4gZXh0ZW5zaW9uTWVzc2FnZSh7IC4uLnBheWxvYWQsIHJldmlzaW9uOiBleHRlbnNpb25PcmRlclJldmlzaW9uIH0pKVxuICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbiB8fCBwYXlsb2FkLnRva2VuICE9PSBoYWNrZXJCZWFyZXJUb2tlbiB8fCAhaGFja2VyQXBpVmFsaWRhdGVkIHx8ICFoYWNrZXJCZWFyZXJFbmFibGVkKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBleHRlbnNpb25PcmRlclJldmlzaW9uID0gcmVzdWx0LnJldmlzaW9uO1xuICAgICAgICAgICAgZXh0ZW5zaW9uT3JkZXJUb2tlbiA9IHBheWxvYWQudG9rZW47XG4gICAgICAgICAgICBpZiAocmVzdWx0LnNldHRpbmdzKSBoYWNrZXJOb3RpZmllclNldHRpbmdzID0gaGFja2VyTm90aWZpZXJOb3JtYWxpemVTZXR0aW5ncyhyZXN1bHQuc2V0dGluZ3MpO1xuICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTYXZlU2V0dGluZ3MoKTsgaGFja2VyTm90aWZpZXJGaWxsQ29udHJvbHMoKTsgaGFja2VyTm90aWZpZXJFbnN1cmVJbmRpY2F0b3IoKTtcbiAgICAgICAgICAgIGNvbnN0IHJlYWR5ID0gaGFja2VyTm90aWZpZXJTZXR0aW5ncy5lbmFibGVkICYmIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoICYmIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnMubGVuZ3RoO1xuICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoIWhhY2tlck5vdGlmaWVyU2V0dGluZ3MuZW5hYmxlZCA/ICfQntC/0L7QstC10YnQsNGC0LXQu9GMINCy0YvQutC70Y7Rh9C10L0nXG4gICAgICAgICAgICAgICAgOiByZWFkeSA/ICfQn9GA0L7QstC10YDRj9C10Lwg0LfQsNC60LDQt9GL4oCmJyA6ICfQktGL0LHQtdGA0LjRgtC1INC+0YDQs9Cw0L3QuNC30LDRhtC40Y4g0Lgg0YHRgtCw0YLRg9GB0Ysg0LTQu9GPINC+0L/QvtCy0LXRidC10L3QuNGPJywgcmVhZHkgPyAnaW5mbycgOiAnd2FybicpO1xuICAgICAgICAgICAgcmV0dXJuICEhcmVhZHk7XG4gICAgICAgIH0pLmNhdGNoKGVycm9yID0+IHsgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoZXJyb3IubWVzc2FnZSwgJ2Vycm9yJyk7IHJldHVybiBmYWxzZTsgfSk7XG4gICAgLy8gS2VlcCBjb25maWd1cmF0aW9uIHNlcGFyYXRlIGZyb20gdGhlIHBvbGw6IHBvbGwgd2FpdHMgZm9yIHRoaXMgY2hhaW4uXG4gICAgZXh0ZW5zaW9uT3JkZXJTeW5jID0gcGVuZGluZztcbiAgICByZXR1cm4gcGVuZGluZy50aGVuKHJlYWR5ID0+IHJlYWR5ID8gaGFja2VyTm90aWZpZXJQb2xsKCkgOiBbXSk7XG59O1xuYXN5bmMgZnVuY3Rpb24gZXh0ZW5zaW9uTm90aWZpZXJQb2xsKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGV4dGVuc2lvbk9yZGVyU3luYztcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBleHRlbnNpb25NZXNzYWdlKHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXBvbGwnLCB0b2tlbjogaGFja2VyQmVhcmVyVG9rZW4gfSk7XG4gICAgICAgIC8vIFJlc3VsdHMvdG9hc3RzIGFyZSBkZWxpdmVyZWQgdG8gb25lIHRhYiBieSB0aGUgd29ya2VyLCBuZXZlciBwZXIgY2FsbGVyLlxuICAgICAgICBjb25zdCByZXN1bHQgPSByZXNwb25zZS5yZXN1bHQ7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2V0U3RhdHVzKHJlc3VsdC5wYXJ0aWFsID8gJ+KaoCDQndC10L/QvtC70L3Ri9C5INC+0L/RgNC+0YE6ICcgKyByZXN1bHQuZmFpbGVkLmpvaW4oJywgJylcbiAgICAgICAgICAgIDogYNCf0YDQvtCy0LXRgNC10L3QvjogJHtuZXcgRGF0ZShyZXN1bHQuYXQpLnRvTG9jYWxlVGltZVN0cmluZygpfSDCtyDQt9Cw0LrQsNC30L7QsjogJHtyZXN1bHQub3JkZXJzLmxlbmd0aH1gLCByZXN1bHQucGFydGlhbCA/ICdlcnJvcicgOiAnb2snKTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdC5vcmRlcnM7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHsgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoZXJyb3IubWVzc2FnZSwgJ2Vycm9yJyk7IHJldHVybiBbXTsgfVxufTtcbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobWVzc2FnZSwgc2VuZGVyLCByZXNwb25kKSA9PiB7XG4gICAgaWYgKHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCAoc2VuZGVyLnVybCAmJiBzZW5kZXIudXJsICE9PSBjaHJvbWUucnVudGltZS5nZXRVUkwoJ3dvcmtlci5qcycpKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChtZXNzYWdlPy50eXBlICE9PSAnbWVtY2hhdDpvcmRlcnMtcmVzdWx0JykgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghaGFja2VyQXBpVmFsaWRhdGVkIHx8ICFoYWNrZXJCZWFyZXJFbmFibGVkIHx8IGV4dGVuc2lvbk9yZGVyVG9rZW4gIT09IGhhY2tlckJlYXJlclRva2VuIHx8IG1lc3NhZ2UucmV2aXNpb24gIT09IGV4dGVuc2lvbk9yZGVyUmV2aXNpb24pIHsgcmVzcG9uZCh7IG9rOiBmYWxzZSB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgY29uc3QgcmVzdWx0ID0gbWVzc2FnZS5yZXN1bHQ7XG4gICAgaWYgKCFyZXN1bHQgfHwgIUFycmF5LmlzQXJyYXkocmVzdWx0Lm9yZGVycykpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoZXh0ZW5zaW9uT3JkZXJMYXN0U2hvd24gIT09IHJlc3VsdC5pZCkge1xuICAgICAgICBleHRlbnNpb25PcmRlckxhc3RTaG93biA9IHJlc3VsdC5pZDtcbiAgICAgICAgaWYgKG1lc3NhZ2Uuc2V0dGluZ3MpIGhhY2tlck5vdGlmaWVyU2V0dGluZ3MgPSBoYWNrZXJOb3RpZmllck5vcm1hbGl6ZVNldHRpbmdzKG1lc3NhZ2Uuc2V0dGluZ3MpO1xuICAgICAgICBpZiAocmVzdWx0LmJlYXJlciA9PT0gJ2Vycm9yJykgeyBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTsgaGFja2VyU3luY0FjY2Vzc1VpKCk7IH1cbiAgICAgICAgcmVzdWx0Lm9yZGVycy5mb3JFYWNoKGhhY2tlck5vdGlmaWVyU2hvd1RvYXN0KTtcbiAgICAgICAgaWYgKHJlc3VsdC5vcmRlcnMubGVuZ3RoICYmIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc291bmRFbmFibGVkKSBoYWNrZXJOb3RpZmllclBsYXlBbGFybSgpO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhyZXN1bHQucGFydGlhbCA/ICfimqAg0J3QtdC/0L7Qu9C90YvQuSDQvtC/0YDQvtGBOiAnICsgcmVzdWx0LmZhaWxlZC5qb2luKCcsICcpXG4gICAgICAgICAgICA6IGDQn9GA0L7QstC10YDQtdC90L46ICR7bmV3IERhdGUocmVzdWx0LmF0KS50b0xvY2FsZVRpbWVTdHJpbmcoKX0gwrcg0LfQsNC60LDQt9C+0LI6ICR7cmVzdWx0Lm9yZGVycy5sZW5ndGh9YCwgcmVzdWx0LnBhcnRpYWwgPyAnZXJyb3InIDogJ29rJyk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyRW5zdXJlSW5kaWNhdG9yKCk7XG4gICAgfVxuICAgIHJlc3BvbmQoeyBvazogdHJ1ZSB9KTtcbiAgICByZXR1cm4gZmFsc2U7XG59KTtcbmV4dGVuc2lvbkNvbmZpZ3VyZU9yZGVycyhtZW1jaGF0UGxhdGZvcm0pO1xuIiwiLy8gRXh0ZW5zaW9uLW9ubHkgcmVhZCBkaWFnbm9zdGljcy4gTm8gd3JpdGVzLCByZXNwb25zZSBwZXJzaXN0ZW5jZSBvciBjcmVkZW50aWFsIG91dHB1dC5cbmNvbnN0IGV4dGVuc2lvbkRpYWdub3N0aWNQcmVzZXRzID0gW1xuICAgIFsn0JfQsNC60LDQt9GLINC/0L7QutGD0L/QsNGC0LXQu9C10LknLCAnL2VudGl0eS9jdXN0b21lcm9yZGVyP2xpbWl0PTEmZXhwYW5kPXN0YXRlLG9yZ2FuaXphdGlvbiddLFxuICAgIFsn0KHRgtCw0YLRg9GB0Ysg0LfQsNC60LDQt9C+0LInLCAnL2VudGl0eS9jdXN0b21lcm9yZGVyL21ldGFkYXRhJ10sXG4gICAgWyfQntGA0LPQsNC90LjQt9Cw0YbQuNC4JywgJy9lbnRpdHkvb3JnYW5pemF0aW9uP2xpbWl0PTEwJ10sXG4gICAgWyfQodC60LvQsNC00YsnLCAnL2VudGl0eS9zdG9yZT9saW1pdD0xMCddLFxuICAgIFsn0KLQvtCy0LDRgNGLJywgJy9lbnRpdHkvcHJvZHVjdD9saW1pdD0xJ10sXG4gICAgWyfQmtC+0L3RgtGA0LDQs9C10L3RgtGLJywgJy9lbnRpdHkvY291bnRlcnBhcnR5P2xpbWl0PTEnXSxcbiAgICBbJ9Ch0LLQvtC5IEdFVC3Qt9Cw0L/RgNC+0YEnLCAnJ11cbl07XG5jb25zdCBleHRlbnNpb25EaWFnbm9zdGljU2VjcmV0S2V5ID0gL3Rva2VufHBhc3N3b3JkfHNlY3JldHxhdXRob3JpemF0aW9ufGNyZWRlbnRpYWx8Y29va2llfGFwaS4/a2V5fHNlc3Npb24vaTtcbmZ1bmN0aW9uIGV4dGVuc2lvbkRpYWdub3N0aWNQYXRoKHJhdykge1xuICAgIGNvbnN0IHZhbHVlID0gU3RyaW5nKHJhdyB8fCAnJykudHJpbSgpO1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwodmFsdWUuc3RhcnRzV2l0aCgnLycpID8gTVNfQVBJX0JBU0UgKyB2YWx1ZSA6IHZhbHVlLCBNU19BUElfQkFTRSArICcvJyk7XG4gICAgY29uc3QgcGF0aCA9IGhhY2tlckFwaVBhdGgodmFsdWUpO1xuICAgIGlmICghcGF0aCB8fCAhL15cXC8oZW50aXR5fHJlcG9ydClcXC8vLnRlc3QocGF0aCkgfHwgdXJsLnVzZXJuYW1lIHx8IHVybC5wYXNzd29yZCB8fCB1cmwuaGFzaCkgdGhyb3cgRXJyb3IoJ9CU0L7RgdGC0YPQv9C90Ysg0YLQvtC70YzQutC+IEdFVCBlbnRpdHkvcmVwb3J0IEFQSSDQnNC+0LnQodC60LvQsNC0INCx0LXQtyDRg9GH0ZHRgtC90YvRhSDQtNCw0L3QvdGL0YUg0LIg0LDQtNGA0LXRgdC1Jyk7XG4gICAgaWYgKFsuLi51cmwuc2VhcmNoUGFyYW1zLmtleXMoKV0uc29tZShrZXkgPT4gZXh0ZW5zaW9uRGlhZ25vc3RpY1NlY3JldEtleS50ZXN0KGtleSkpXG4gICAgICAgIHx8IChoYWNrZXJCZWFyZXJUb2tlbiAmJiB2YWx1ZS5pbmNsdWRlcyhoYWNrZXJCZWFyZXJUb2tlbikpKSB0aHJvdyBFcnJvcign0J3QtSDQtNC+0LHQsNCy0LvRj9C50YLQtSDRgdC10LrRgNC10YLRiyDQsiDQsNC00YDQtdGBINC30LDQv9GA0L7RgdCwJyk7XG4gICAgcmV0dXJuIHBhdGg7XG59XG5mdW5jdGlvbiBleHRlbnNpb25EaWFnbm9zdGljVGV4dCh2YWx1ZSwgdG9rZW4gPSBoYWNrZXJCZWFyZXJUb2tlbikge1xuICAgIGNvbnN0IGNsZWFuID0gdGV4dCA9PiB7XG4gICAgICAgIGxldCByZXN1bHQgPSB0b2tlbiA/IFN0cmluZyh0ZXh0KS5zcGxpdCh0b2tlbikuam9pbignW1JFREFDVEVEXScpIDogU3RyaW5nKHRleHQpO1xuICAgICAgICByZXR1cm4gcmVzdWx0LnJlcGxhY2UoL0JlYXJlclxccytbXlxcc1wiJzw+XSsvZ2ksICdCZWFyZXIgW1JFREFDVEVEXScpXG4gICAgICAgICAgICAucmVwbGFjZSgvKFs/Jl0oPzphY2Nlc3NfdG9rZW58dG9rZW58YXBpXz9rZXl8cGFzc3dvcmR8c2VjcmV0KT0pW14mI1xcc1wiJ10qL2dpLCAnJDFbUkVEQUNURURdJyk7XG4gICAgfTtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykgcmV0dXJuIGNsZWFuKHZhbHVlKTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUsIChrZXksIGl0ZW0pID0+IGtleSA9PT0gJ19zdGF0dXMnID8gdW5kZWZpbmVkXG4gICAgICAgIDogZXh0ZW5zaW9uRGlhZ25vc3RpY1NlY3JldEtleS50ZXN0KGtleSkgPyAnW1JFREFDVEVEXScgOiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycgPyBjbGVhbihpdGVtKSA6IGl0ZW0sIDIpO1xufVxuYXN5bmMgZnVuY3Rpb24gZXh0ZW5zaW9uUnVuRGlhZ25vc3RpYyhyYXcsIHJlc3VsdCwgYnV0dG9uKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbiwgdG9rZW4gPSBoYWNrZXJCZWFyZXJUb2tlbiwgc3RhcnRlZCA9IERhdGUubm93KCk7XG4gICAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTsgcmVzdWx0LnRleHRDb250ZW50ID0gJ9CS0YvQv9C+0LvQvdGP0LXRgtGB0Y8gR0VU4oCmJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXRoID0gZXh0ZW5zaW9uRGlhZ25vc3RpY1BhdGgocmF3KTtcbiAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG1zQXBpUCgnR0VUJywgcGF0aCk7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24gfHwgdG9rZW4gIT09IGhhY2tlckJlYXJlclRva2VuIHx8ICFyZXN1bHQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgICAgY29uc3QgYm9keSA9IGV4dGVuc2lvbkRpYWdub3N0aWNUZXh0KGRhdGEsIHRva2VuKSB8fCAn0J/Rg9GB0YLQvtC5INC+0YLQstC10YInO1xuICAgICAgICByZXN1bHQudGV4dENvbnRlbnQgPSBleHRlbnNpb25EaWFnbm9zdGljVGV4dChgR0VUICR7cGF0aH1cXG5IVFRQICR7ZGF0YT8uX3N0YXR1cyB8fCAnMnh4ICjQv9GD0YHRgtC+0Lkv0L3QtSBKU09OKSd9IMK3ICR7RGF0ZS5ub3coKSAtIHN0YXJ0ZWR9INC80YFcXG5gXG4gICAgICAgICAgICArIGDQodGC0YDQvtC6OiAke0FycmF5LmlzQXJyYXkoZGF0YT8ucm93cykgPyBkYXRhLnJvd3MubGVuZ3RoIDogJ9C90LUg0YHQv9C40YHQvtC6J30gwrcg0JLRgdC10LPQvjogJHtkYXRhPy5tZXRhPy5zaXplID8/ICfQvdC1INGD0LrQsNC30LDQvdC+J31cXG5cXG5gXG4gICAgICAgICAgICArIGJvZHkuc2xpY2UoMCwgODAwMDApICsgKGJvZHkubGVuZ3RoID4gODAwMDAgPyAnXFxuW9Cf0L7QutCw0LfQsNC90Ysg0L/QtdGA0LLRi9C1IDgwIDAwMCDRgdC40LzQstC+0LvQvtCyXScgOiAnJyksIHRva2VuKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uIHx8IHRva2VuICE9PSBoYWNrZXJCZWFyZXJUb2tlbiB8fCAhcmVzdWx0LmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgIHJlc3VsdC50ZXh0Q29udGVudCA9IGV4dGVuc2lvbkRpYWdub3N0aWNUZXh0KGAke2Vycm9yLnN0YXR1cyA/ICdIVFRQICcgKyBlcnJvci5zdGF0dXMgOiAn0J3QtdGCIEhUVFAt0L7RgtCy0LXRgtCwJ30gwrcgJHtEYXRlLm5vdygpIC0gc3RhcnRlZH0g0LzRgVxcbiR7ZXJyb3IuYXBpQ29kZSA/ICfQmtC+0LQgQVBJOiAnICsgZXJyb3IuYXBpQ29kZSArICdcXG4nIDogJyd9JHtlcnJvci5tZXNzYWdlIHx8ICfQntGI0LjQsdC60LAg0LfQsNC/0YDQvtGB0LAnfWAsIHRva2VuKTtcbiAgICB9IGZpbmFsbHkgeyBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gZXh0ZW5zaW9uUnVuT3JkZXJEaWFnbm9zdGljKHJlc3VsdCwgYnV0dG9uKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbiwgdG9rZW4gPSBoYWNrZXJCZWFyZXJUb2tlbjtcbiAgICBidXR0b24uZGlzYWJsZWQgPSB0cnVlOyByZXN1bHQudGV4dENvbnRlbnQgPSAn0J7Qv9GA0LDRiNC40LLQsNC10Lwg0LLRi9Cx0YDQsNC90L3Ri9C1INC+0YDQs9Cw0L3QuNC30LDRhtC40Lgg0Lgg0YHRgtCw0YLRg9GB0YvigKYnO1xuICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGV4dGVuc2lvbk9yZGVyU3luYztcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBleHRlbnNpb25NZXNzYWdlKHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLXBvbGwnLCB0b2tlbiB9KTtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbiB8fCB0b2tlbiAhPT0gaGFja2VyQmVhcmVyVG9rZW4gfHwgIXJlc3VsdC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBkYXRhID0gcmVzcG9uc2UucmVzdWx0O1xuICAgICAgICByZXN1bHQudGV4dENvbnRlbnQgPSBleHRlbnNpb25EaWFnbm9zdGljVGV4dChg0J7Qv9C+0LLQtdGJ0LDRgtC10LvRjDogJHtkYXRhLnBhcnRpYWwgPyAn0J3QldCf0J7Qm9Cd0KvQmSDQntCf0KDQntChJyA6ICfQvtC/0YDQvtGBINC30LDQstC10YDRiNGR0L0nfVxcbmBcbiAgICAgICAgICAgICsgYNCf0YDQvtCy0LXRgNC10L3QvjogJHtuZXcgRGF0ZShkYXRhLmF0KS50b0xvY2FsZVRpbWVTdHJpbmcoKX1cXG7Ql9Cw0LrQsNC30L7QsjogJHtkYXRhLm9yZGVycy5sZW5ndGh9XFxuQmVhcmVyOiAke2RhdGEuYmVhcmVyfVxcbmBcbiAgICAgICAgICAgICsgKGRhdGEuZmFpbGVkLmxlbmd0aCA/ICfQntGI0LjQsdC60Lg6ICcgKyBkYXRhLmZhaWxlZC5qb2luKCc7ICcpIDogJ9Ce0YjQuNCx0L7QuiBBUEkg0L/RgNC4INC+0L/RgNC+0YHQtSDQvdC10YInKSwgdG9rZW4pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uID09PSBtc0FwaUdlbmVyYXRpb24gJiYgdG9rZW4gPT09IGhhY2tlckJlYXJlclRva2VuICYmIHJlc3VsdC5pc0Nvbm5lY3RlZCkgcmVzdWx0LnRleHRDb250ZW50ID0gZXh0ZW5zaW9uRGlhZ25vc3RpY1RleHQoZXJyb3IubWVzc2FnZSwgdG9rZW4pO1xuICAgIH0gZmluYWxseSB7IGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlOyB9XG59XG5mdW5jdGlvbiBleHRlbnNpb25CdWlsZERpYWdub3N0aWNzKCkge1xuICAgIGNvbnN0IHJvb3QgPSBoYWNrZXJFbCgnZGl2JywgJ2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjdweDtwYWRkaW5nLXRvcDo4cHg7Jyk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM0NzU1Njk7JywgJ9Ci0L7Qu9GM0LrQviDRh9GC0LXQvdC40LUgKEdFVCkuINCa0LvRjtGHINCx0LXRgNGR0YLRgdGPINC40Lcg0L3QsNGB0YLRgNC+0LXQuiwg0L3QtSDQstGL0LLQvtC00LjRgtGB0Y8g0Lgg0L3QtSDQstC60LvRjtGH0LDQtdGC0YHRjyDQsiDQsNC00YDQtdGBLiDQntGC0LLQtdGCINC90LUg0YHQvtGF0YDQsNC90Y/QtdGC0YHRjy4nKSk7XG4gICAgY29uc3QgcHJlc2V0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7IHByZXNldC5pZCA9ICdoYWNrZXJBcGlEaWFnbm9zdGljUHJlc2V0JztcbiAgICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7IGlucHV0LmlkID0gJ2hhY2tlckFwaURpYWdub3N0aWNQYXRoJzsgaW5wdXQudHlwZSA9ICd0ZXh0JztcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCB2YWx1ZV0gb2YgZXh0ZW5zaW9uRGlhZ25vc3RpY1ByZXNldHMpIHsgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7IG9wdGlvbi50ZXh0Q29udGVudCA9IG5hbWU7IG9wdGlvbi52YWx1ZSA9IHZhbHVlOyBwcmVzZXQuYXBwZW5kQ2hpbGQob3B0aW9uKTsgfVxuICAgIGlucHV0LnZhbHVlID0gZXh0ZW5zaW9uRGlhZ25vc3RpY1ByZXNldHNbMF1bMV07IGlucHV0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsICfQn9GD0YLRjCBHRVQt0LfQsNC/0YDQvtGB0LAg0JzQvtC50KHQutC70LDQtCcpO1xuICAgIGZvciAoY29uc3QgZWwgb2YgW3ByZXNldCwgaW5wdXRdKSBlbC5zdHlsZS5jc3NUZXh0ID0gJ2JveC1zaXppbmc6Ym9yZGVyLWJveDt3aWR0aDoxMDAlO3BhZGRpbmc6N3B4O2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtmb250OjExcHggU2Vnb2UgVUksc2Fucy1zZXJpZjsnO1xuICAgIHByZXNldC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IGlucHV0LnZhbHVlID0gcHJlc2V0LnZhbHVlIHx8ICcvZW50aXR5L2N1c3RvbWVyb3JkZXI/bGltaXQ9MSc7IH0pO1xuICAgIGNvbnN0IHJ1biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBydW4udHlwZSA9ICdidXR0b24nOyBydW4uaWQgPSAnaGFja2VyQXBpRGlhZ25vc3RpY1J1bic7IHJ1bi50ZXh0Q29udGVudCA9ICfQktGL0L/QvtC70L3QuNGC0YwgR0VUJztcbiAgICBjb25zdCBwb2xsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IHBvbGwudHlwZSA9ICdidXR0b24nOyBwb2xsLmlkID0gJ2hhY2tlckFwaURpYWdub3N0aWNQb2xsJzsgcG9sbC50ZXh0Q29udGVudCA9ICfQn9GA0L7QstC10YDQuNGC0Ywg0L7Qv9C+0LLQtdGJ0LDRgtC10LvRjCDRgdC10LnRh9Cw0YEnO1xuICAgIGNvbnN0IHRvYXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IHRvYXN0LnR5cGUgPSAnYnV0dG9uJzsgdG9hc3QuaWQgPSAnaGFja2VyQXBpRGlhZ25vc3RpY1RvYXN0JzsgdG9hc3QudGV4dENvbnRlbnQgPSAn0KLQtdGB0YIg0YPQstC10LTQvtC80LvQtdC90LjRjyc7XG4gICAgY29uc3QgcmVzdWx0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncHJlJyk7IHJlc3VsdC5pZCA9ICdoYWNrZXJBcGlEaWFnbm9zdGljUmVzdWx0JzsgcmVzdWx0LnNldEF0dHJpYnV0ZSgnYXJpYS1saXZlJywgJ3BvbGl0ZScpO1xuICAgIHJlc3VsdC5zdHlsZS5jc3NUZXh0ID0gJ3doaXRlLXNwYWNlOnByZS13cmFwO292ZXJmbG93LXdyYXA6YW55d2hlcmU7bWF4LWhlaWdodDoyNzBweDtvdmVyZmxvdzphdXRvO21hcmdpbjowO3BhZGRpbmc6OHB4O2JvcmRlci1yYWRpdXM6OHB4O2JhY2tncm91bmQ6IzBmMTcyYTtjb2xvcjojZTJlOGYwO2ZvbnQ6MTBweC8xLjQgQ29uc29sYXMsbW9ub3NwYWNlOyc7XG4gICAgcmVzdWx0LnRleHRDb250ZW50ID0gJ9CS0YvQsdC10YDQuNGC0LUg0LPQvtGC0L7QstGL0Lkg0LfQsNC/0YDQvtGBINC40LvQuCDRg9C60LDQttC40YLQtSAvZW50aXR5L+KApj9saW1pdD0xLiDQlNC70Y8g0YLQvtGH0L3QvtCz0L4g0YTQuNC70YzRgtGA0LAg0L7Qv9C+0LLQtdGJ0LDRgtC10LvRjyDQuNGB0L/QvtC70YzQt9GD0LnRgtC1INC+0YLQtNC10LvRjNC90YPRjiDQutC90L7Qv9C60YMuJztcbiAgICBmb3IgKGNvbnN0IGJ1dHRvbiBvZiBbcnVuLCBwb2xsLCB0b2FzdF0pIGJ1dHRvbi5zdHlsZS5jc3NUZXh0ID0gJ3BhZGRpbmc6N3B4O2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjdXJzb3I6cG9pbnRlcjtmb250OjExcHggU2Vnb2UgVUksc2Fucy1zZXJpZjsnO1xuICAgIHJ1bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGV4dGVuc2lvblJ1bkRpYWdub3N0aWMoaW5wdXQudmFsdWUsIHJlc3VsdCwgcnVuKSk7XG4gICAgcG9sbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGV4dGVuc2lvblJ1bk9yZGVyRGlhZ25vc3RpYyhyZXN1bHQsIHBvbGwpKTtcbiAgICB0b2FzdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTaG93VG9hc3QoeyBuYW1lOiAn0KLQldCh0KIg4oCUINC90LUg0YDQtdCw0LvRjNC90YvQuSDQt9Cw0LrQsNC3Jywgc3RhdGVOYW1lOiAn0J/RgNC+0LLQtdGA0LrQsCDQvtGC0L7QsdGA0LDQttC10L3QuNGPJywgb3JnYW5pemF0aW9uTmFtZTogJ9Ci0LXRgdGCINGA0LDRgdGI0LjRgNC10L3QuNGPJyB9KTtcbiAgICAgICAgaWYgKGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc291bmRFbmFibGVkKSBoYWNrZXJOb3RpZmllclBsYXlBbGFybSgpO1xuICAgIH0pO1xuICAgIHJvb3QuYXBwZW5kKHByZXNldCwgaW5wdXQsIHJ1biwgcG9sbCwgdG9hc3QsIHJlc3VsdCk7XG4gICAgcmV0dXJuIHJvb3Q7XG59XG4vLyBQcm9kdWN0IGNvbXBhcmlzb24gaXMgYWJzZW50IGZyb20gdGhpcyBwYWNrYWdlLiBPbmx5IG5vdGlmaWVyIHJlZmVyZW5jZXMgYXJlIGJvb3RzdHJhcHBlZC5cbmZ1bmN0aW9uIGV4dGVuc2lvblJlZmVyZW5jZVNob3dTdGF0dXMoc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFwaVJlZmVyZW5jZVN0YXR1cycpKSB7XG4gICAgY29uc3QgbGFiZWxzID0geyBvcmdhbml6YXRpb246ICfQntGA0LPQsNC90LjQt9Cw0YbQuNC4JywgY3VzdG9tZXJvcmRlcjogJ9Ch0YLQsNGC0YPRgdGLINC30LDQutCw0LfQvtCyJyB9O1xuICAgIGNvbnN0IGVycm9ycyA9IE9iamVjdC5lbnRyaWVzKG1zUmVmZXJlbmNlQ2FjaGUuZXJyb3JzIHx8IHt9KS5maWx0ZXIoKFtraW5kXSkgPT4gT2JqZWN0Lmhhc093bihsYWJlbHMsIGtpbmQpKTtcbiAgICBjb25zdCBtaXNzaW5nID0gT2JqZWN0LmtleXMobGFiZWxzKS5maWx0ZXIoa2luZCA9PiAhT2JqZWN0Lmhhc093bihtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLCBraW5kKSk7XG4gICAgY29uc3QgdGV4dCA9IGVycm9ycy5sZW5ndGggPyBlcnJvcnMubWFwKChba2luZCwgbWVzc2FnZV0pID0+IGAke2xhYmVsc1traW5kXX0g4oCUICR7bWVzc2FnZX1gKS5qb2luKCc7ICcpXG4gICAgICAgIDogbWlzc2luZy5sZW5ndGggPyAn0J3QtSDQt9Cw0LPRgNGD0LbQtdC90Ys6ICcgKyBtaXNzaW5nLm1hcChraW5kID0+IGxhYmVsc1traW5kXSkuam9pbignLCAnKSA6ICfQodC/0YDQsNCy0L7Rh9C90LjQutC4INC+0L/QvtCy0LXRidCw0YLQtdC70Y8g0LfQsNCz0YDRg9C20LXQvdGLJztcbiAgICBpZiAoc3RhdHVzKSB7IHN0YXR1cy50ZXh0Q29udGVudCA9IHRleHQ7IHN0YXR1cy5zdHlsZS5jb2xvciA9IGVycm9ycy5sZW5ndGggfHwgbWlzc2luZy5sZW5ndGggPyAnI2I5MWMxYycgOiAnIzE2NjUzNCc7IH1cbiAgICBpZiAoZXJyb3JzLmxlbmd0aCkgaGFja2VyTm90aWZpZXJTZXRTdGF0dXModGV4dCwgJ2Vycm9yJyk7XG59O1xuYXN5bmMgZnVuY3Rpb24gZXh0ZW5zaW9uUmVmZXJlbmNlUmVmcmVzaCh7IGZvcmNlID0gZmFsc2UsIHN0YXRlcywgc3RhdHVzIH0gPSB7fSkge1xuICAgIGNvbnN0IHNjb3BlID0gbXNSZWZlcmVuY2VTY29wZSwgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBjb25zdCBraW5kcyA9IFsnb3JnYW5pemF0aW9uJywgJ2N1c3RvbWVyb3JkZXInXTtcbiAgICBtc1JlZmVyZW5jZUNhY2hlLmF0dGVtcHRlZCA9IHRydWU7XG4gICAgY29uc3Qgb3V0Y29tZXMgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoa2luZHMubWFwKGtpbmQgPT4gbXNSZWZlcmVuY2VMb2FkKGtpbmQsXG4gICAgICAgIHsgZm9yY2UsIHNlZWQ6IGtpbmQgPT09ICdjdXN0b21lcm9yZGVyJyA/IHN0YXRlcyA6IHVuZGVmaW5lZCB9KSkpO1xuICAgIG1zUmVmZXJlbmNlQXNzZXJ0Q3VycmVudChzY29wZSwgZ2VuZXJhdGlvbik7XG4gICAgbXNSZWZlcmVuY2VDYWNoZS5lcnJvcnMgPSBPYmplY3QuZnJvbUVudHJpZXMob3V0Y29tZXMuZmxhdE1hcCgob3V0Y29tZSwgaW5kZXgpID0+IG91dGNvbWUuc3RhdHVzID09PSAncmVqZWN0ZWQnXG4gICAgICAgID8gW1traW5kc1tpbmRleF0sIG91dGNvbWUucmVhc29uLnN0YXR1cyA/IGBIVFRQICR7b3V0Y29tZS5yZWFzb24uc3RhdHVzfWAgOiAn0L7RiNC40LHQutCwINC30LDQs9GA0YPQt9C60Lg7INC/0L7QstGC0L7RgNC40YLQtSDQstGA0YPRh9C90YPRjiddXSA6IFtdKSk7XG4gICAgbXNSZWZlcmVuY2VTYXZlKCk7IG1zUmVmZXJlbmNlU2hvd1N0YXR1cyhzdGF0dXMpO1xuICAgIHJldHVybiB7IG9rOiBPYmplY3Qua2V5cyhtc1JlZmVyZW5jZUNhY2hlLmVycm9ycykubGVuZ3RoID09PSAwLCBlcnJvcnM6IG1zUmVmZXJlbmNlQ2FjaGUuZXJyb3JzIH07XG59O1xuZnVuY3Rpb24gZXh0ZW5zaW9uQ2xlYW5TZXR0aW5ncygpIHtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNTZXR0aW5nc1RhYkludGVybmFsT3JkZXJDaGVjaycpPy5yZW1vdmUoKTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNTZXR0aW5nc0ludGVybmFsT3JkZXJDaGVja1BhbmUnKT8ucmVtb3ZlKCk7XG59XG5mdW5jdGlvbiBleHRlbnNpb25TZWxlY3REaWFnbm9zdGljKGtleSkge1xuICAgIGNvbnN0IG9sZCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWhhY2tlci10YWI9XCJpbnRlcm5hbE9yZGVyQ2hlY2tcIl0nKTtcbiAgICBpZiAob2xkKSB7IG9sZC5kYXRhc2V0LmhhY2tlclRhYiA9ICdyZXF1ZXN0cyc7IG9sZC50ZXh0Q29udGVudCA9ICfQn9GA0L7QstC10YDQutCwINC30LDQv9GA0L7RgdC+0LInOyB9XG4gICAgaWYgKGtleSA9PT0gJ2ludGVybmFsT3JkZXJDaGVjaycpIGtleSA9ICdyZXF1ZXN0cyc7XG4gICAgaWYgKGtleSAhPT0gJ3JlcXVlc3RzJykgcmV0dXJuIGZhbHNlO1xuICAgIGhhY2tlclRhYiA9IGtleTtcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcjaGFja2VyVGFicyBbZGF0YS1oYWNrZXItdGFiXScpLmZvckVhY2goYnV0dG9uID0+IHtcbiAgICAgICAgY29uc3QgYWN0aXZlID0gYnV0dG9uLmRhdGFzZXQuaGFja2VyVGFiID09PSBrZXk7XG4gICAgICAgIGJ1dHRvbi5zdHlsZS5iYWNrZ3JvdW5kID0gYWN0aXZlID8gJ2xpbmVhci1ncmFkaWVudCgxMzVkZWcsIzYzNjZmMSwjOGI1Y2Y2KScgOiAnI2Y4ZmFmYyc7XG4gICAgICAgIGJ1dHRvbi5zdHlsZS5jb2xvciA9IGFjdGl2ZSA/ICcjZmZmJyA6ICcjNDc1NTY5JzsgYnV0dG9uLnN0eWxlLmJvcmRlckNvbG9yID0gYWN0aXZlID8gJ3RyYW5zcGFyZW50JyA6ICcjZTJlOGYwJztcbiAgICB9KTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyVGFiUGFuZXMnKT8ucmVwbGFjZUNoaWxkcmVuKGV4dGVuc2lvbkJ1aWxkRGlhZ25vc3RpY3MoKSk7XG4gICAgcmV0dXJuIHRydWU7XG59O1xuXG5mdW5jdGlvbiBleHRlbnNpb25Db25maWd1cmVEaWFnbm9zdGljcyhwbGF0Zm9ybSkge1xuICAgIHBsYXRmb3JtLnJlZmVyZW5jZXMgPSB7IHJlZnJlc2g6IGV4dGVuc2lvblJlZmVyZW5jZVJlZnJlc2gsIHNob3dTdGF0dXM6IGV4dGVuc2lvblJlZmVyZW5jZVNob3dTdGF0dXMgfTtcbiAgICBwbGF0Zm9ybS5kaWFnbm9zdGljcyA9IHsgc2VsZWN0OiBleHRlbnNpb25TZWxlY3REaWFnbm9zdGljLCBjbGVhblNldHRpbmdzOiBleHRlbnNpb25DbGVhblNldHRpbmdzIH07XG59XG5leHRlbnNpb25Db25maWd1cmVEaWFnbm9zdGljcyhtZW1jaGF0UGxhdGZvcm0pO1xuIiwiLyogRXh0ZW5zaW9uLW9ubHkgTWVtY2hhdCBVSSBwcm9tb3Rpb24uIEluY2x1ZGUgYWZ0ZXIgdGhlIHByb2R1Y3Rpb24gdXNlcnNjcmlwdCBib2R5LiAqL1xuKCgpID0+IHtcbiAgICAndXNlIHN0cmljdCc7XG4gICAgaWYgKCFkb2N1bWVudC5ib2R5IHx8IHR5cGVvZiBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKS5zaG93UG9wb3ZlciAhPT0gJ2Z1bmN0aW9uJyB8fCBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1tZW1jaGF0LXRvcC1sYXllcl0nKSkgcmV0dXJuO1xuXG4gICAgY29uc3QgUk9PVF9TRUxFQ1RPUiA9IFtcbiAgICAgICAgJyNwcmljZUNoZWNrQ29udGFpbmVyJywgJy5tYy1mbG9hdC13aW5kb3cnLCAnLm1jLW92ZXJsYXknLCAnI2hhdGlrb1Byb2R1Y3RQaWNrZXInLFxuICAgICAgICAnI21jSGFja2VyUXVpY2tQb3B1cCcsICcjbWNIYWNrZXJBZ2VudFBvcHVwJywgJyNtY0hhY2tlckZsb2F0aW5nTG9nJywgJyNtY01zVG9hc3QnLFxuICAgICAgICAnI21jT3JkZXJTdGF0dXNQb3B1cCcsICcjbWNNYWdpY1BvcHVwJywgJyNoYWNrZXJOb3RpZmllclRvYXN0SG9zdCdcbiAgICBdLmpvaW4oJywnKTtcbiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaG9zdC5zZXRBdHRyaWJ1dGUoJ2RhdGEtbWVtY2hhdC10b3AtbGF5ZXInLCAnJyk7XG4gICAgaG9zdC5zZXRBdHRyaWJ1dGUoJ3BvcG92ZXInLCAnbWFudWFsJyk7XG4gICAgaG9zdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCAnTWVtY2hhdCcpO1xuICAgIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3R5bGUnKTtcbiAgICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiAgICAgIFtkYXRhLW1lbWNoYXQtdG9wLWxheWVyXSB7IHBvc2l0aW9uOmZpeGVkICFpbXBvcnRhbnQ7IGluc2V0OjAgIWltcG9ydGFudDsgei1pbmRleDoyMTQ3NDgzNjQ3ICFpbXBvcnRhbnQ7IG1hcmdpbjowICFpbXBvcnRhbnQ7IHBhZGRpbmc6MCAhaW1wb3J0YW50OyBib3JkZXI6MCAhaW1wb3J0YW50OyB3aWR0aDphdXRvICFpbXBvcnRhbnQ7IGhlaWdodDphdXRvICFpbXBvcnRhbnQ7IG1heC13aWR0aDpub25lICFpbXBvcnRhbnQ7IG1heC1oZWlnaHQ6bm9uZSAhaW1wb3J0YW50OyBvdmVyZmxvdzp2aXNpYmxlICFpbXBvcnRhbnQ7IGJhY2tncm91bmQ6dHJhbnNwYXJlbnQgIWltcG9ydGFudDsgY29sb3I6aW5oZXJpdDsgcG9pbnRlci1ldmVudHM6bm9uZSAhaW1wb3J0YW50OyB9XG4gICAgICBbZGF0YS1tZW1jaGF0LXRvcC1sYXllcl06OmJhY2tkcm9wIHsgYmFja2dyb3VuZDp0cmFuc3BhcmVudCAhaW1wb3J0YW50OyBwb2ludGVyLWV2ZW50czpub25lICFpbXBvcnRhbnQ7IH1cbiAgICAgIFtkYXRhLW1lbWNoYXQtdG9wLWxheWVyXSA+ICogeyBwb2ludGVyLWV2ZW50czphdXRvICFpbXBvcnRhbnQ7IH1cbiAgICAgIFtkYXRhLW1lbWNoYXQtdG9wLWxheWVyXSA+ICNoYWNrZXJOb3RpZmllclRvYXN0SG9zdCB7IHBvaW50ZXItZXZlbnRzOm5vbmUgIWltcG9ydGFudDsgfVxuICAgIGA7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChzdHlsZSk7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChob3N0KTtcblxuICAgIGxldCBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICBsZXQgZm9yY2VQcm9tb3Rpb24gPSBmYWxzZTtcbiAgICBsZXQgc2NoZWR1bGVkVGltZXIgPSAwO1xuICAgIGxldCBsYXN0TW9kYWwgPSBudWxsO1xuICAgIGxldCBsYXN0RnVsbHNjcmVlbiA9IG51bGw7XG4gICAgbGV0IGV4dGVybmFsVG9wTGF5ZXJUaW1lciA9IDA7XG4gICAgY29uc3QgbW9kYWxPcmRlciA9IFtdO1xuXG4gICAgZnVuY3Rpb24gaXNNb2RhbChkaWFsb2cpIHtcbiAgICAgICAgdHJ5IHsgcmV0dXJuIGRpYWxvZy5tYXRjaGVzKCc6bW9kYWwnKTsgfSBjYXRjaCAoXykgeyByZXR1cm4gZmFsc2U7IH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBhY3RpdmVNb2RhbCgpIHtcbiAgICAgICAgY29uc3QgZGlhbG9ncyA9IEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnZGlhbG9nW29wZW5dJykpO1xuICAgICAgICBjb25zdCBtb2RhbHMgPSBkaWFsb2dzLmZpbHRlcihpc01vZGFsKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IG1vZGFsT3JkZXIubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgICAgICAgIGlmICghbW9kYWxzLmluY2x1ZGVzKG1vZGFsT3JkZXJbaV0pKSBtb2RhbE9yZGVyLnNwbGljZShpLCAxKTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGRpYWxvZyBvZiBtb2RhbHMpIGlmICghbW9kYWxPcmRlci5pbmNsdWRlcyhkaWFsb2cpKSBtb2RhbE9yZGVyLnB1c2goZGlhbG9nKTtcbiAgICAgICAgY29uc3QgZm9jdXNlZCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7XG4gICAgICAgIGNvbnN0IGZvY3VzZWRNb2RhbHMgPSBtb2RhbHMuZmlsdGVyKGRpYWxvZyA9PiBkaWFsb2cuY29udGFpbnMoZm9jdXNlZCkpO1xuICAgICAgICBpZiAoZm9jdXNlZE1vZGFscy5sZW5ndGgpIHtcbiAgICAgICAgICAgIHJldHVybiBmb2N1c2VkTW9kYWxzLnJlZHVjZSgoZGVlcGVzdCwgZGlhbG9nKSA9PiBkZWVwZXN0LmNvbnRhaW5zKGRpYWxvZykgPyBkaWFsb2cgOiBkZWVwZXN0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbW9kYWxPcmRlci5sZW5ndGggPyBtb2RhbE9yZGVyW21vZGFsT3JkZXIubGVuZ3RoIC0gMV0gOiBudWxsO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHByb21vdGUoKSB7XG4gICAgICAgIGlmICh0eXBlb2YgaG9zdC5zaG93UG9wb3ZlciAhPT0gJ2Z1bmN0aW9uJykgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKGhvc3QubWF0Y2hlcygnOnBvcG92ZXItb3BlbicpKSBob3N0LmhpZGVQb3BvdmVyKCk7XG4gICAgICAgICAgICBob3N0LnNob3dQb3BvdmVyKCk7XG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgICAgIC8vIExlYXZlIHRoZSBob3N0IG1vdW50ZWQ7IHVuc3VwcG9ydGVkL2Jsb2NrZWQgcG9wb3ZlciBBUElzIGNhbm5vdCBiZSBmb3JjZWQuXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiB3aXRoT3duZWRGb2N1cyhhY3Rpb24sIG93bmVkUm9vdCA9IGhvc3QpIHtcbiAgICAgICAgY29uc3QgZm9jdXNlZCA9IG93bmVkUm9vdC5jb250YWlucyhkb2N1bWVudC5hY3RpdmVFbGVtZW50KSA/IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgOiBudWxsO1xuICAgICAgICBjb25zdCBzdGFydCA9IGZvY3VzZWQgJiYgdHlwZW9mIGZvY3VzZWQuc2VsZWN0aW9uU3RhcnQgPT09ICdudW1iZXInID8gZm9jdXNlZC5zZWxlY3Rpb25TdGFydCA6IG51bGw7XG4gICAgICAgIGNvbnN0IGVuZCA9IGZvY3VzZWQgJiYgdHlwZW9mIGZvY3VzZWQuc2VsZWN0aW9uRW5kID09PSAnbnVtYmVyJyA/IGZvY3VzZWQuc2VsZWN0aW9uRW5kIDogbnVsbDtcbiAgICAgICAgY29uc3QgZGlyZWN0aW9uID0gZm9jdXNlZCAmJiBmb2N1c2VkLnNlbGVjdGlvbkRpcmVjdGlvbjtcbiAgICAgICAgYWN0aW9uKCk7XG4gICAgICAgIGlmICghZm9jdXNlZCB8fCAhZm9jdXNlZC5pc0Nvbm5lY3RlZCB8fCBkb2N1bWVudC5hY3RpdmVFbGVtZW50ID09PSBmb2N1c2VkKSByZXR1cm47XG4gICAgICAgIC8vIFJlcGFyZW50aW5nIGFuZCBwb3BvdmVyIHRvZ2dsaW5nIG1heSBibHVyIGFuIG93bmVkIGNvbnRyb2wgdG8gYm9keS4gTmV2ZXJcbiAgICAgICAgLy8gb3ZlcnJpZGUgYSBkaWZmZXJlbnQgcGFnZSBjb250cm9sIHRoYXQgYWNxdWlyZWQgZm9jdXMgZHVyaW5nIHRoZSBhY3Rpb24uXG4gICAgICAgIGlmIChkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9PSBkb2N1bWVudC5ib2R5ICYmIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgIT09IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCkgcmV0dXJuO1xuICAgICAgICB0cnkgeyBmb2N1c2VkLmZvY3VzKHsgcHJldmVudFNjcm9sbDogdHJ1ZSB9KTsgfSBjYXRjaCAoXykgeyB0cnkgeyBmb2N1c2VkLmZvY3VzKCk7IH0gY2F0Y2ggKF8pIHt9IH1cbiAgICAgICAgaWYgKHN0YXJ0ICE9PSBudWxsICYmIHR5cGVvZiBmb2N1c2VkLnNldFNlbGVjdGlvblJhbmdlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICB0cnkgeyBmb2N1c2VkLnNldFNlbGVjdGlvblJhbmdlKHN0YXJ0LCBlbmQsIGRpcmVjdGlvbik7IH0gY2F0Y2ggKF8pIHt9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBtb3ZlSG9zdChwYXJlbnQpIHtcbiAgICAgICAgaWYgKCFwYXJlbnQgfHwgaG9zdC5wYXJlbnRFbGVtZW50ID09PSBwYXJlbnQpIHJldHVybjtcbiAgICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGhvc3QpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNvbGxlY3RSb290cygpIHtcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoUk9PVF9TRUxFQ1RPUikpIHtcbiAgICAgICAgICAgIGlmIChub2RlID09PSBob3N0IHx8IGhvc3QuY29udGFpbnMobm9kZSkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgd2l0aE93bmVkRm9jdXMoKCkgPT4gaG9zdC5hcHBlbmRDaGlsZChub2RlKSwgbm9kZSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzeW5jKCkge1xuICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgICAgc2NoZWR1bGVkVGltZXIgPSAwO1xuICAgICAgICBjb25zdCBzaG91bGRQcm9tb3RlID0gZm9yY2VQcm9tb3Rpb247XG4gICAgICAgIGZvcmNlUHJvbW90aW9uID0gZmFsc2U7XG4gICAgICAgIGlmICghZG9jdW1lbnQuYm9keS5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICBpZiAoIWhvc3QuaXNDb25uZWN0ZWQpIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaG9zdCk7XG4gICAgICAgIGNvbnN0IGZ1bGxzY3JlZW4gPSBkb2N1bWVudC5mdWxsc2NyZWVuRWxlbWVudCB8fCBudWxsO1xuICAgICAgICBjb25zdCBtb2RhbCA9IGFjdGl2ZU1vZGFsKCk7XG4gICAgICAgIGNvbnN0IHBhcmVudCA9IGZ1bGxzY3JlZW4gPyAobW9kYWwgJiYgZnVsbHNjcmVlbi5jb250YWlucyhtb2RhbCkgPyBtb2RhbCA6IGZ1bGxzY3JlZW4pIDogKG1vZGFsIHx8IGRvY3VtZW50LmJvZHkpO1xuICAgICAgICB3aXRoT3duZWRGb2N1cygoKSA9PiB7XG4gICAgICAgICAgICBtb3ZlSG9zdChwYXJlbnQpO1xuICAgICAgICAgICAgaWYgKGZ1bGxzY3JlZW4gIT09IGxhc3RGdWxsc2NyZWVuIHx8IG1vZGFsICE9PSBsYXN0TW9kYWwgfHwgaG9zdC5wYXJlbnRFbGVtZW50ICE9PSBwYXJlbnQgfHwgc2hvdWxkUHJvbW90ZSkgcHJvbW90ZSgpO1xuICAgICAgICB9KTtcbiAgICAgICAgaWYgKGZ1bGxzY3JlZW4gIT09IGxhc3RGdWxsc2NyZWVuIHx8IG1vZGFsICE9PSBsYXN0TW9kYWwgfHwgaG9zdC5wYXJlbnRFbGVtZW50ICE9PSBwYXJlbnQpIHtcbiAgICAgICAgICAgIGxhc3RGdWxsc2NyZWVuID0gZnVsbHNjcmVlbjtcbiAgICAgICAgICAgIGxhc3RNb2RhbCA9IG1vZGFsO1xuICAgICAgICB9XG4gICAgICAgIGNvbGxlY3RSb290cygpO1xuICAgICAgICBpZiAoIWhvc3QubWF0Y2hlcygnOnBvcG92ZXItb3BlbicpKSB3aXRoT3duZWRGb2N1cyhwcm9tb3RlKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZShmb3JjZSA9IGZhbHNlKSB7XG4gICAgICAgIGZvcmNlUHJvbW90aW9uID0gZm9yY2VQcm9tb3Rpb24gfHwgZm9yY2UgPT09IHRydWU7XG4gICAgICAgIGlmIChzY2hlZHVsZWQpIHJldHVybjtcbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2NoZWR1bGVkVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dChzeW5jLCAwKTtcbiAgICB9XG5cbiAgICBwcm9tb3RlKCk7XG4gICAgY29sbGVjdFJvb3RzKCk7XG4gICAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihyZWNvcmRzID0+IHtcbiAgICAgICAgZm9yIChjb25zdCByZWNvcmQgb2YgcmVjb3Jkcykge1xuICAgICAgICAgICAgaWYgKHJlY29yZC50eXBlICE9PSAnYXR0cmlidXRlcycgfHwgcmVjb3JkLmF0dHJpYnV0ZU5hbWUgIT09ICdvcGVuJyB8fCByZWNvcmQudGFyZ2V0LmxvY2FsTmFtZSAhPT0gJ2RpYWxvZycpIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgZGlhbG9nID0gcmVjb3JkLnRhcmdldDtcbiAgICAgICAgICAgIGNvbnN0IGluZGV4ID0gbW9kYWxPcmRlci5pbmRleE9mKGRpYWxvZyk7XG4gICAgICAgICAgICBpZiAoIWRpYWxvZy5oYXNBdHRyaWJ1dGUoJ29wZW4nKSB8fCAhaXNNb2RhbChkaWFsb2cpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4ICE9PSAtMSkgbW9kYWxPcmRlci5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXggIT09IC0xKSBtb2RhbE9yZGVyLnNwbGljZShpbmRleCwgMSk7XG4gICAgICAgICAgICAgICAgbW9kYWxPcmRlci5wdXNoKGRpYWxvZyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgc2NoZWR1bGUoKTtcbiAgICB9KTtcbiAgICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBzdWJ0cmVlOiB0cnVlLCBjaGlsZExpc3Q6IHRydWUsIGF0dHJpYnV0ZXM6IHRydWUsIGF0dHJpYnV0ZUZpbHRlcjogWydvcGVuJywgJ3N0eWxlJywgJ2NsYXNzJ10gfSk7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndG9nZ2xlJywgc2NoZWR1bGUsIHRydWUpO1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2Z1bGxzY3JlZW5jaGFuZ2UnLCBzY2hlZHVsZSwgdHJ1ZSk7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignd2Via2l0ZnVsbHNjcmVlbmNoYW5nZScsIHNjaGVkdWxlLCB0cnVlKTtcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncGFnZWhpZGUnLCAoKSA9PiB7XG4gICAgICAgIG9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgd2luZG93LmNsZWFyVGltZW91dChzY2hlZHVsZWRUaW1lcik7XG4gICAgICAgIHdpbmRvdy5jbGVhclRpbWVvdXQoZXh0ZXJuYWxUb3BMYXllclRpbWVyKTtcbiAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgfSwgeyBvbmNlOiB0cnVlIH0pO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwYWdlc2hvdycsIGV2ZW50ID0+IHtcbiAgICAgICAgaWYgKCFldmVudC5wZXJzaXN0ZWQpIHJldHVybjtcbiAgICAgICAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgc3VidHJlZTogdHJ1ZSwgY2hpbGRMaXN0OiB0cnVlLCBhdHRyaWJ1dGVzOiB0cnVlLCBhdHRyaWJ1dGVGaWx0ZXI6IFsnb3BlbicsICdzdHlsZScsICdjbGFzcyddIH0pO1xuICAgICAgICBzY2hlZHVsZSgpO1xuICAgIH0pO1xuICAgIC8vIEEgbGF0ZXIgcGFnZSBwb3BvdmVyL2RpYWxvZyBlbnRlcnMgYWJvdmUgYW4gZWFybGllciBwb3BvdmVyLiBSZS1wcm9tb3RlIGFmdGVyIGl0cyB0b2dnbGUuXG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndG9nZ2xlJywgZXZlbnQgPT4ge1xuICAgICAgICBpZiAoZXZlbnQudGFyZ2V0ID09PSBob3N0IHx8ICFldmVudC50YXJnZXQgfHwgaG9zdC5jb250YWlucyhldmVudC50YXJnZXQpKSByZXR1cm47XG4gICAgICAgIHdpbmRvdy5jbGVhclRpbWVvdXQoZXh0ZXJuYWxUb3BMYXllclRpbWVyKTtcbiAgICAgICAgZXh0ZXJuYWxUb3BMYXllclRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgbW9kYWwgPSBhY3RpdmVNb2RhbCgpO1xuICAgICAgICAgICAgaWYgKG1vZGFsIHx8IGRvY3VtZW50LmZ1bGxzY3JlZW5FbGVtZW50KSBzY2hlZHVsZSh0cnVlKTtcbiAgICAgICAgICAgIGVsc2Ugd2l0aE93bmVkRm9jdXMocHJvbW90ZSk7XG4gICAgICAgIH0sIDApO1xuICAgIH0sIHRydWUpO1xuICAgIHdpbmRvdy5fX21lbWNoYXRUb3BMYXllciA9IHsgaG9zdCwgcmVmcmVzaDogc2NoZWR1bGUgfTtcbn0pKCk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUN2RUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDMUdBO0FBQ0E7QUFDQTs7QUNGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvYUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcElBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDblFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2pXQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDam9CQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbGtDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3RnQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeGxCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6a0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeEpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuSUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7In0=
