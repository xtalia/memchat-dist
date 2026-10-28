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
    const pct    = Math.abs(diff / orig * 100);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiZXh0ZW5zaW9uL3N0b3JhZ2Utc2NoZW1hLmpzIiwiZXh0ZW5zaW9uL3BhbmVsLXRhYi1jb250ZW50LmpzIiwiZXh0ZW5zaW9uL3N0b3JhZ2UtY29udGVudC5qcyIsImV4dGVuc2lvbi9icmlkZ2UuanMiLCJzcmMvMDAtcGxhdGZvcm0uanMiLCJzcmMvMDEtY29uZmlnLWFuZC1zdGF0ZS5qcyIsInNyYy8wMi1zdG9yYWdlLWFuZC10cmFuc3BvcnQuanMiLCJzcmMvMDMtY2hhdC5qcyIsInNyYy8wNC1oYXRpa28uanMiLCJzcmMvMDUtY2FsY3VsYXRvci5qcyIsInNyYy8wNi1zY2hlZHVsZS5qcyIsInNyYy8wNy1zZXR0aW5ncy1wYW5lbHMuanMiLCJzcmMvMDgtZmllbGQtY2xlYXIuanMiLCJzcmMvMDgtY2xlYXItYW5kLWFjdGlvbnMuanMiLCJzcmMvMDktdWkuanMiLCJzcmMvMTAtZXZlbnRzLWFuZC1pbml0LmpzIiwic3JjLzExLWhhY2tlci5qcyIsInNyYy8xMi1tb3lza2xhZC11eC5qcyIsInNyYy8xMy1vcmRlci1ub3RpZmllci5qcyIsInNyYy8xNC1pbnRlcm5hbC1vcmRlci1jaGVjay5qcyIsImV4dGVuc2lvbi9ydW50aW1lLmpzIiwiZXh0ZW5zaW9uL29yZGVycy1ydW50aW1lLmpzIiwiZXh0ZW5zaW9uL2FwaS1kaWFnbm9zdGljcy5qcyIsImV4dGVuc2lvbi90b3AtbGF5ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQnVuZGxlZCBpbnRvIHdvcmtlciBhbmQgaXNvbGF0ZWQgY29udGVudDsgbmV2ZXIgZXhwb3NlZCBpbiB0aGUgcGFnZSB3b3JsZC5cbmNvbnN0IE1FTUNIQVRfU1RPUkFHRV9LRVlTID0gbmV3IFNldChbXG4gICAgJ2RlYnVnJywgJ2NhbGNSdWxlc192MicsICdzY2hlZHVsZVJlcGxhY2VtZW50c192MScsICdzY2hlZHVsZUNhY2hlRW5hYmxlZF92MScsXG4gICAgJ3NjaGVkdWxlQ2FjaGVfdjFfdG9kYXknLCAnc2NoZWR1bGVDYWNoZV92MV90b21vcnJvdycsICdzZWxlY3RlZEFjdGlvbl92MScsXG4gICAgJ3Nob3dIYXRpa29MaW5rc192MScsICdoYXRpa29TZWFyY2hNb2RlX3YxJywgJ3JldHJ5QmVoYXZpb3JfdjEnLCAnaGlkZGVuRmllbGRzX3YxJyxcbiAgICAnbXNRdWlja1BhbmVsX3YxJywgJ2Zsb2F0V2luZG93UG9zX3YxJywgJ2NoYXRIaXN0b3J5X3YxJywgJ2NsZWFyVGV4dERlbGF5X3YxJyxcbiAgICAnY2xlYXJUZXh0RW5hYmxlZCcsICdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScsICdoYWNrZXJRdWlja0J1dHRvbnNfdjEnLFxuICAgICdtc01hZ2ljQ29uZmlnX3YxJywgJ21zRmllbGRzU3BvaWxlck9wZW5fdjEnLCAnbXNSZWZlcmVuY2VDYWNoZV92MScsXG4gICAgJ2hhY2tlck1zQXBpX3YxJywgJ2hhY2tlclN0YXRlc192MScsICdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJyxcbiAgICAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJywgJ2hhY2tlck5vdGlmaWVyU2Vlbl92MScsXG4gICAgJ2hhY2tlckludGVybmFsT3JkZXJDaGVja192MScsICdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MSdcbl0ubWFwKGtleSA9PiAnbWVtY2hhdDonICsga2V5KS5jb25jYXQoWydjYWxjUnVsZXNfdjInLCAnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnXSkpO1xuY29uc3QgTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUyA9IG5ldyBTZXQoWydtZW1jaGF0OnBhbmVsQ3NyZl92MScsICdjbGVhclRleHRFbmFibGVkJ10pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uU2FuaXRpemVTdG9yZWRWYWx1ZShrZXksIHZhbHVlKSB7XG4gICAgaWYgKGtleSA9PT0gJ21lbWNoYXQ6Y2hhdEhpc3RvcnlfdjEnKSB7XG4gICAgICAgIHRyeSB7IGNvbnN0IGhpc3RvcnkgPSBKU09OLnBhcnNlKHZhbHVlKTtcbiAgICAgICAgICAgIGlmIChoaXN0b3J5ICYmIHR5cGVvZiBoaXN0b3J5ID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShoaXN0b3J5KSkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBoaXN0b3J5LmNoZWNrSGF0aWtvQm9udXNlcztcbiAgICAgICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoaGlzdG9yeSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSBtYWxmb3JtZWQgZXhpc3RpbmcgZGF0YSwgbm90IGEgZmFicmljYXRlZCByZXBsYWNlbWVudC4gKi8gfVxuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG4iLCIvLyBSdW5zIG9ubHkgaW4gdGhlIGlzb2xhdGVkIGV4dGVuc2lvbiB3b3JsZCBvZiBhbiBleGlzdGluZyB0b3AtbGV2ZWwgUGFuZWwgdGFiLlxuLy8gQ2FwdHVyZSBuYXRpdmUgZmV0Y2g6IHRoZSBidXNpbmVzcyB0cmFuc3BvcnQncyBsZXhpY2FsIGZldGNoIGlzIGEgd29ya2VyIHByb3h5LlxuY29uc3QgcGFuZWxUYWJOYXRpdmVGZXRjaCA9IGdsb2JhbFRoaXMuZmV0Y2guYmluZChnbG9iYWxUaGlzKTtcbmNvbnN0IHBhbmVsVGFiSW5zdGFuY2UgPSBnbG9iYWxUaGlzLmNyeXB0by5yYW5kb21VVUlEKCk7XG5jb25zdCBwYW5lbFRhYkNvbnRyb2xsZXJzID0gbmV3IE1hcCgpO1xuZnVuY3Rpb24gcGFuZWxUYWJSZWFkUmVxdWVzdChyZXF1ZXN0KSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXF1ZXN0Py51cmwpO1xuICAgICAgICBpZiAodXJsLm9yaWdpbiAhPT0gJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1JyB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5oYXNoIHx8IHVybC5zZWFyY2gpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJlcXVlc3QubWV0aG9kIHx8ICdHRVQnKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICByZXR1cm4gKG1ldGhvZCA9PT0gJ0dFVCcgJiYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2VhcmNoL2ZpbHRlcnMnIHx8IC9eXFwvYXBpXFwvYm9udXNlc1xcL2NoZWNrXFwvXFxkezEsMjB9JC8udGVzdCh1cmwucGF0aG5hbWUpKSlcbiAgICAgICAgICAgIHx8IChtZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3NlYXJjaCcgJiYgdHlwZW9mIHJlcXVlc3QuZGF0YSA9PT0gJ3N0cmluZycgJiYgcmVxdWVzdC5kYXRhLmxlbmd0aCA8PSAzMjc2OCk7XG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxufVxuYXN5bmMgZnVuY3Rpb24gcGFuZWxUYWJGZXRjaCh1cmwsIG9wdGlvbnMsIHNpZ25hbCkge1xuICAgIHJldHVybiBwYW5lbFRhYk5hdGl2ZUZldGNoKHVybCwgeyAuLi5vcHRpb25zLCBjcmVkZW50aWFsczogJ2luY2x1ZGUnLCBjYWNoZTogJ25vLXN0b3JlJywgcmVkaXJlY3Q6ICdlcnJvcicsIHNpZ25hbCB9KTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiU2Vzc2lvbihzaWduYWwpIHtcbiAgICBjb25zdCBodG1sID0gYXdhaXQgcGFuZWxUYWJGZXRjaCgnL3NlYXJjaCcsIHsgaGVhZGVyczogeyBBY2NlcHQ6ICd0ZXh0L2h0bWwnIH0gfSwgc2lnbmFsKTtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgaHRtbC50ZXh0KCk7XG4gICAgaWYgKCFodG1sLm9rIHx8IC88aW5wdXRcXGJbXj5dKlxcYnR5cGVcXHMqPVxccypbXCInXT9wYXNzd29yZFxcYi9pLnRlc3QoYm9keSkpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnYXV0aCcgfTtcbiAgICBjb25zdCBwYXJzZWQgPSBuZXcgRE9NUGFyc2VyKCkucGFyc2VGcm9tU3RyaW5nKGJvZHksICd0ZXh0L2h0bWwnKTtcbiAgICBjb25zdCB0b2tlbiA9IHBhcnNlZC5xdWVyeVNlbGVjdG9yKCdtZXRhW25hbWU9XCJjc3JmLXRva2VuXCJdJyk/LmNvbnRlbnQgfHwgJyc7XG4gICAgaWYgKCEvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QodG9rZW4pKSByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogJ2F1dGgnIH07XG4gICAgY29uc3QgYXV0aCA9IGF3YWl0IHBhbmVsVGFiRmV0Y2goJy9hcGkvc2VhcmNoL2ZpbHRlcnMnLCB7IGhlYWRlcnM6IHsgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsICdYLVJlcXVlc3RlZC1XaXRoJzogJ1hNTEh0dHBSZXF1ZXN0JyB9IH0sIHNpZ25hbCk7XG4gICAgaWYgKCFhdXRoLm9rIHx8ICEvYXBwbGljYXRpb25cXC9qc29uL2kudGVzdChhdXRoLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJykpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnYXV0aCcgfTtcbiAgICBjb25zdCBwcm9vZiA9IGF3YWl0IGF1dGguanNvbigpO1xuICAgIGlmICghcHJvb2YgfHwgdHlwZW9mIHByb29mICE9PSAnb2JqZWN0JykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246ICdhdXRoJyB9O1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB0b2tlbiwgaW5zdGFuY2U6IHBhbmVsVGFiSW5zdGFuY2UgfTtcbn1cbmFzeW5jIGZ1bmN0aW9uIHBhbmVsVGFiUmVxdWVzdChyZXF1ZXN0LCBzaWduYWwpIHtcbiAgICBpZiAoIXBhbmVsVGFiUmVhZFJlcXVlc3QocmVxdWVzdCkpIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiAnaW52YWxpZCcgfTtcbiAgICBjb25zdCBoZWFkZXJzID0geyBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJywgJ1gtUmVxdWVzdGVkLVdpdGgnOiAnWE1MSHR0cFJlcXVlc3QnIH07XG4gICAgY29uc3QgY3NyZiA9IG5ldyBIZWFkZXJzKHJlcXVlc3QuaGVhZGVycyB8fCB7fSkuZ2V0KCdYLUNTUkYtVE9LRU4nKTtcbiAgICBpZiAoY3NyZiAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QoY3NyZikpIGhlYWRlcnNbJ1gtQ1NSRi1UT0tFTiddID0gY3NyZjtcbiAgICBpZiAocmVxdWVzdC5tZXRob2QgPT09ICdQT1NUJykgaGVhZGVyc1snQ29udGVudC1UeXBlJ10gPSAnYXBwbGljYXRpb24vanNvbic7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBwYW5lbFRhYkZldGNoKHJlcXVlc3QudXJsLCB7IG1ldGhvZDogcmVxdWVzdC5tZXRob2QgfHwgJ0dFVCcsIGhlYWRlcnMsIGJvZHk6IHJlcXVlc3QuZGF0YSB9LCBzaWduYWwpO1xuICAgIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcbiAgICBjb25zdCBjb250ZW50VHlwZSA9IHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJztcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgaW5zdGFuY2U6IHBhbmVsVGFiSW5zdGFuY2UsIHJlc3VsdDogeyBldmVudDogJ2xvYWQnLCByZXNwb25zZToge1xuICAgICAgICBzdGF0dXM6IHJlc3BvbnNlLm9rICYmICEvYXBwbGljYXRpb25cXC9qc29uL2kudGVzdChjb250ZW50VHlwZSkgPyA0MDEgOiByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgIHN0YXR1c1RleHQ6IHJlc3BvbnNlLnN0YXR1c1RleHQsIHJlc3BvbnNlVGV4dCwgcmVzcG9uc2U6IHJlc3BvbnNlVGV4dCxcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiAnY29udGVudC10eXBlOiAnICsgY29udGVudFR5cGUsIGZpbmFsVXJsOiByZXF1ZXN0LnVybCwgcmVhZHlTdGF0ZTogNFxuICAgIH0gfSB9O1xufVxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHJlc3BvbmQpID0+IHtcbiAgICBpZiAobWVzc2FnZT8udHlwZSAhPT0gJ21lbWNoYXQ6cGFuZWwtdGFiJyB8fCBsb2NhdGlvbi5vcmlnaW4gIT09ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScgfHwgd2luZG93ICE9PSB3aW5kb3cudG9wXG4gICAgICAgIHx8IHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYiB8fCAoc2VuZGVyLnVybCAmJiBzZW5kZXIudXJsICE9PSBjaHJvbWUucnVudGltZS5nZXRVUkwoJ3dvcmtlci5qcycpKVxuICAgICAgICB8fCB0eXBlb2YgbWVzc2FnZS5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW2EtekEtWjAtOS1dezEsODB9JC8udGVzdChtZXNzYWdlLmlkKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChtZXNzYWdlLm9wZXJhdGlvbiA9PT0gJ2NhbmNlbCcpIHsgcGFuZWxUYWJDb250cm9sbGVycy5nZXQobWVzc2FnZS5pZCk/LmFib3J0KCk7IHJlc3BvbmQoeyBvazogdHJ1ZSB9KTsgcmV0dXJuIGZhbHNlOyB9XG4gICAgaWYgKCFbJ3Nlc3Npb24nLCAncmVxdWVzdCddLmluY2x1ZGVzKG1lc3NhZ2Uub3BlcmF0aW9uKSB8fCAobWVzc2FnZS5vcGVyYXRpb24gPT09ICdyZXF1ZXN0JyAmJiBtZXNzYWdlLmluc3RhbmNlICE9PSBwYW5lbFRhYkluc3RhbmNlKSkge1xuICAgICAgICByZXNwb25kKHsgb2s6IGZhbHNlLCByZWFzb246ICdkb2N1bWVudCcgfSk7IHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBwYW5lbFRhYkNvbnRyb2xsZXJzLnNldChtZXNzYWdlLmlkLCBjb250cm9sbGVyKTtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCAxMjAwMCk7XG4gICAgY29uc3Qgd29yayA9IG1lc3NhZ2Uub3BlcmF0aW9uID09PSAnc2Vzc2lvbicgPyBwYW5lbFRhYlNlc3Npb24oY29udHJvbGxlci5zaWduYWwpIDogcGFuZWxUYWJSZXF1ZXN0KG1lc3NhZ2UucmVxdWVzdCwgY29udHJvbGxlci5zaWduYWwpO1xuICAgIHdvcmsudGhlbihyZXN1bHQgPT4gcmVzcG9uZChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkID8geyBvazogZmFsc2UsIHJlYXNvbjogJ25ldHdvcmsnIH0gOiByZXN1bHQpLFxuICAgICAgICAoKSA9PiByZXNwb25kKHsgb2s6IGZhbHNlLCByZWFzb246ICduZXR3b3JrJyB9KSkuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7IGlmIChwYW5lbFRhYkNvbnRyb2xsZXJzLmdldChtZXNzYWdlLmlkKSA9PT0gY29udHJvbGxlcikgcGFuZWxUYWJDb250cm9sbGVycy5kZWxldGUobWVzc2FnZS5pZCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG59KTtcbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwYWdlaGlkZScsICgpID0+IHsgZm9yIChjb25zdCBjb250cm9sbGVyIG9mIHBhbmVsVGFiQ29udHJvbGxlcnMudmFsdWVzKCkpIGNvbnRyb2xsZXIuYWJvcnQoKTsgfSk7XG4iLCIvLyBBIHN5bmNocm9ub3VzIFN0b3JhZ2Utc2hhcGVkIGNhY2hlIGZvciB0aGUgdW5jaGFuZ2VkIGNvcmUuIE9ubHkgdGhlIHdvcmtlclxuLy8gcGVyc2lzdHMgaXQ7IHdlYnNpdGVzIGNhbm5vdCByZWFkIGNocm9tZS5zdG9yYWdlIG9yIHJlY2VpdmUgU3RvcmFnZUV2ZW50cy5cbmNvbnN0IGV4dGVuc2lvblN0b3JhZ2VHYXRlID0geyByZWFkeTogZmFsc2UsIGVycm9yOiBmYWxzZSB9O1xuZXh0ZW5zaW9uU3RvcmFnZUdhdGUucHJvbWlzZSA9IG5ldyBQcm9taXNlKHJlc29sdmUgPT4geyBleHRlbnNpb25TdG9yYWdlR2F0ZS5maW5pc2ggPSByZXNvbHZlOyB9KTtcbmxldCBleHRlbnNpb25TdG9yYWdlT25FcnJvciA9ICgpID0+IHt9O1xubGV0IGV4dGVuc2lvblN0b3JhZ2VPbkNoYW5nZSA9ICgpID0+IHt9O1xubGV0IGV4dGVuc2lvblN0b3JhZ2VGYWlsZWQgPSBmYWxzZTtcbmNvbnN0IGV4dGVuc2lvblN0b3JhZ2VJdGVtcyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5mdW5jdGlvbiBleHRlbnNpb25TdG9yYWdlRXJyb3IoKSB7XG4gICAgZXh0ZW5zaW9uU3RvcmFnZUZhaWxlZCA9IHRydWU7XG4gICAgZXh0ZW5zaW9uU3RvcmFnZU9uRXJyb3IoKTtcbiAgICBpZiAodHlwZW9mIGRvY3VtZW50ID09PSAndW5kZWZpbmVkJyB8fCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdFN0b3JhZ2VFcnJvcicpKSByZXR1cm47XG4gICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyB3YXJuaW5nLmlkID0gJ21lbWNoYXRTdG9yYWdlRXJyb3InO1xuICAgIHdhcm5pbmcuc2V0QXR0cmlidXRlKCdyb2xlJywgJ2FsZXJ0Jyk7XG4gICAgd2FybmluZy50ZXh0Q29udGVudCA9ICdNZW1jaGF0OiDQtNCw0L3QvdGL0LUg0L3QtSDRgdC+0YXRgNCw0L3QtdC90Ysg0LjQu9C4INC40LfQvNC10L3QtdC90Ysg0LIg0LTRgNGD0LPQvtC5INCy0LrQu9Cw0LTQutC1LiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDQstC60LvQsNC00LrRgy4g0KXRgNCw0L3QuNC70LjRidC1INGB0LDQudGC0LAg0L3QtSDQuNGB0L/QvtC70YzQt9GD0LXRgtGB0Y8uJztcbiAgICB3YXJuaW5nLnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7dG9wOjRweDtsZWZ0OjhweDtyaWdodDo4cHg7ei1pbmRleDoyMTQ3NDgzNjQ3O3BhZGRpbmc6MTBweDtiYWNrZ3JvdW5kOiNmZmYxZjI7Y29sb3I6IzlmMTIzOTtib3JkZXI6MXB4IHNvbGlkICNmYjcxODU7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udDoxM3B4LzEuNCBzYW5zLXNlcmlmOyc7XG4gICAgZG9jdW1lbnQuYm9keT8uYXBwZW5kQ2hpbGQod2FybmluZyk7XG59XG5mdW5jdGlvbiBleHRlbnNpb25BcHBseVN0b3JhZ2VJdGVtKGtleSwgaXRlbSkge1xuICAgIGlmICghTUVNQ0hBVF9TVE9SQUdFX0tFWVMuaGFzKGtleSkgfHwgIWl0ZW0gfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGl0ZW0ucmV2aXNpb24pXG4gICAgICAgIHx8IChpdGVtLnZhbHVlICE9PSBudWxsICYmIHR5cGVvZiBpdGVtLnZhbHVlICE9PSAnc3RyaW5nJykpIHJldHVybjtcbiAgICBpZiAoKGV4dGVuc2lvblN0b3JhZ2VJdGVtc1trZXldPy5yZXZpc2lvbiB8fCAwKSA+IGl0ZW0ucmV2aXNpb24pIHJldHVybjtcbiAgICBleHRlbnNpb25TdG9yYWdlSXRlbXNba2V5XSA9IGl0ZW07XG4gICAgZXh0ZW5zaW9uU3RvcmFnZU9uQ2hhbmdlKGtleSk7XG59XG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlcikgPT4ge1xuICAgIGlmIChtZXNzYWdlPy50eXBlICE9PSAnbWVtY2hhdDpzdG9yYWdlLWNoYW5nZWQnIHx8IHNlbmRlci5pZCAhPT0gY2hyb21lLnJ1bnRpbWUuaWQgfHwgc2VuZGVyLnRhYlxuICAgICAgICB8fCAoc2VuZGVyLnVybCAmJiBzZW5kZXIudXJsICE9PSBjaHJvbWUucnVudGltZS5nZXRVUkwoJ3dvcmtlci5qcycpKSkgcmV0dXJuIGZhbHNlO1xuICAgIGV4dGVuc2lvbkFwcGx5U3RvcmFnZUl0ZW0obWVzc2FnZS5rZXksIG1lc3NhZ2UuaXRlbSk7XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG5hc3luYyBmdW5jdGlvbiBleHRlbnNpb25Jbml0U3RvcmFnZSgpIHtcbiAgICBjb25zdCBwYWdlU3RvcmFnZSA9IHdpbmRvdy5sb2NhbFN0b3JhZ2U7XG4gICAgY29uc3QgbGVnYWN5ID0ge307XG4gICAgZm9yIChjb25zdCBrZXkgb2YgWy4uLk1FTUNIQVRfU1RPUkFHRV9LRVlTLCAuLi5NRU1DSEFUX1JFVElSRURfU1RPUkFHRV9LRVlTXSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHBhZ2VTdG9yYWdlLmdldEl0ZW0oa2V5KTtcbiAgICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSBsZWdhY3lba2V5XSA9IHZhbHVlO1xuICAgIH1cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdHlwZTogJ21lbWNoYXQ6c3RvcmFnZS1pbml0JywgbGVnYWN5IH0sIHJlcGx5ID0+IHtcbiAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IgfHwgIXJlcGx5Py5vaykgcmVqZWN0KEVycm9yKCfQpdGA0LDQvdC40LvQuNGJ0LUg0YDQsNGB0YjQuNGA0LXQvdC40Y8g0L3QtdC00L7RgdGC0YPQv9C90L4nKSk7XG4gICAgICAgICAgICBlbHNlIHJlc29sdmUocmVwbHkpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGl0ZW1dIG9mIE9iamVjdC5lbnRyaWVzKHJlc3VsdC5pdGVtcykpIGV4dGVuc2lvbkFwcGx5U3RvcmFnZUl0ZW0oa2V5LCBpdGVtKTtcbiAgICAvLyBEbyBub3QgZGVsZXRlIGEgdmFsdWUgY29uY3VycmVudGx5IGNoYW5nZWQgYnkgYSBzdGlsbC1lbmFibGVkIHVzZXJzY3JpcHQuXG4gICAgZm9yIChjb25zdCBrZXkgb2YgcmVzdWx0LmNsZWFudXApIHtcbiAgICAgICAgaWYgKE9iamVjdC5oYXNPd24obGVnYWN5LCBrZXkpICYmIHBhZ2VTdG9yYWdlLmdldEl0ZW0oa2V5KSA9PT0gbGVnYWN5W2tleV0pIHBhZ2VTdG9yYWdlLnJlbW92ZUl0ZW0oa2V5KTtcbiAgICB9XG4gICAgZnVuY3Rpb24gY2hhbmdlKGtleSwgcmF3KSB7XG4gICAgICAgIGtleSA9IFN0cmluZyhrZXkpO1xuICAgICAgICBpZiAoTUVNQ0hBVF9SRVRJUkVEX1NUT1JBR0VfS0VZUy5oYXMoa2V5KSkgcmV0dXJuO1xuICAgICAgICBpZiAoIU1FTUNIQVRfU1RPUkFHRV9LRVlTLmhhcyhrZXkpIHx8IGV4dGVuc2lvblN0b3JhZ2VGYWlsZWQpIHRocm93IEVycm9yKCfQpdGA0LDQvdC40LvQuNGJ0LUgTWVtY2hhdCDQvdC10LTQvtGB0YLRg9C/0L3QvicpO1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHJhdyA9PT0gbnVsbCA/IG51bGwgOiBleHRlbnNpb25TYW5pdGl6ZVN0b3JlZFZhbHVlKGtleSwgU3RyaW5nKHJhdykpO1xuICAgICAgICBjb25zdCBwcmV2aW91cyA9IGV4dGVuc2lvblN0b3JhZ2VJdGVtc1trZXldIHx8IHsgdmFsdWU6IG51bGwsIHJldmlzaW9uOiAwIH07XG4gICAgICAgIGlmIChwcmV2aW91cy52YWx1ZSA9PT0gdmFsdWUpIHJldHVybjtcbiAgICAgICAgZXh0ZW5zaW9uU3RvcmFnZUl0ZW1zW2tleV0gPSB7IHZhbHVlLCByZXZpc2lvbjogcHJldmlvdXMucmV2aXNpb24gKyAxIH07XG4gICAgICAgIC8vIFNlbmQgaW1tZWRpYXRlbHksIG5vdCBmcm9tIGEgZGVib3VuY2VkIHBhZ2UgdGltZXIgdGhhdCBjYW4gZGllIG9uIHVubG9hZC5cbiAgICAgICAgdHJ5IHsgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoeyB0eXBlOiAnbWVtY2hhdDpzdG9yYWdlLXdyaXRlJywga2V5LCB2YWx1ZSxcbiAgICAgICAgICAgIHJldmlzaW9uOiBwcmV2aW91cy5yZXZpc2lvbiwgcHJldmlvdXNWYWx1ZTogcHJldmlvdXMudmFsdWUgfSwgcmVwbHkgPT4ge1xuICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvciB8fCAhcmVwbHk/Lm9rKSB7IGV4dGVuc2lvblN0b3JhZ2VFcnJvcigpOyByZXR1cm47IH1cbiAgICAgICAgICAgIGV4dGVuc2lvbkFwcGx5U3RvcmFnZUl0ZW0oa2V5LCByZXBseS5pdGVtKTtcbiAgICAgICAgfSk7IH0gY2F0Y2ggeyBleHRlbnNpb25TdG9yYWdlRXJyb3IoKTsgfVxuICAgIH1cbiAgICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIGdldEl0ZW06IGtleSA9PiBleHRlbnNpb25TdG9yYWdlSXRlbXNbU3RyaW5nKGtleSldPy52YWx1ZSA/PyBudWxsLFxuICAgICAgICBzZXRJdGVtOiAoa2V5LCB2YWx1ZSkgPT4gY2hhbmdlKGtleSwgU3RyaW5nKHZhbHVlKSksXG4gICAgICAgIHJlbW92ZUl0ZW06IGtleSA9PiBjaGFuZ2Uoa2V5LCBudWxsKSxcbiAgICAgICAga2V5OiBpbmRleCA9PiBPYmplY3Qua2V5cyhleHRlbnNpb25TdG9yYWdlSXRlbXMpLmZpbHRlcihrZXkgPT4gZXh0ZW5zaW9uU3RvcmFnZUl0ZW1zW2tleV0udmFsdWUgIT09IG51bGwpW2luZGV4XSA/PyBudWxsLFxuICAgICAgICBnZXQgbGVuZ3RoKCkgeyByZXR1cm4gT2JqZWN0LnZhbHVlcyhleHRlbnNpb25TdG9yYWdlSXRlbXMpLmZpbHRlcihpdGVtID0+IGl0ZW0udmFsdWUgIT09IG51bGwpLmxlbmd0aDsgfVxuICAgIH0pO1xufVxuIiwiLy8gVGhpcyBmaWxlIGFuZCB0aGUgcHJvZHVjdGlvbiB1c2Vyc2NyaXB0IHNoYXJlIG9uZSBpc29sYXRlZC13b3JsZCBJSUZFLlxubGV0IGV4dGVuc2lvblJlcXVlc3RTZXF1ZW5jZSA9IDA7XG5jb25zdCBleHRlbnNpb25SZXF1ZXN0R3VhcmRzID0gbmV3IE1hcCgpO1xuXG5mdW5jdGlvbiBHTV94bWxodHRwUmVxdWVzdChvcHRpb25zKSB7XG4gICAgY29uc3QgaWQgPSBgcmVxLSR7RGF0ZS5ub3coKX0tJHsrK2V4dGVuc2lvblJlcXVlc3RTZXF1ZW5jZX1gO1xuICAgIGxldCBmaW5pc2hlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGZpbmlzaCA9IHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChmaW5pc2hlZCkgcmV0dXJuO1xuICAgICAgICBmaW5pc2hlZCA9IHRydWU7XG4gICAgICAgIGV4dGVuc2lvblJlcXVlc3RHdWFyZHMuZGVsZXRlKGlkKTtcbiAgICAgICAgaWYgKHJlc3VsdD8ucGFuZWxBdXRoTG9zdCAmJiB0eXBlb2YgZXh0ZW5zaW9uUGFuZWxBdXRoTG9zdCA9PT0gJ2Z1bmN0aW9uJykgZXh0ZW5zaW9uUGFuZWxBdXRoTG9zdCgpO1xuICAgICAgICBjb25zdCBjYWxsYmFjayA9IHsgbG9hZDogJ29ubG9hZCcsIHRpbWVvdXQ6ICdvbnRpbWVvdXQnLCBhYm9ydDogJ29uYWJvcnQnLCBlcnJvcjogJ29uZXJyb3InIH1bcmVzdWx0Py5ldmVudF0gfHwgJ29uZXJyb3InO1xuICAgICAgICBvcHRpb25zW2NhbGxiYWNrXT8uKHJlc3VsdD8ucmVzcG9uc2UgfHwgeyBzdGF0dXM6IDAsIHN0YXR1c1RleHQ6IHJlc3VsdD8uZXJyb3IgfHwgJ9Ce0YjQuNCx0LrQsCDRgNCw0YHRiNC40YDQtdC90LjRjyBNZW1jaGF0JyB9KTtcbiAgICB9O1xuICAgIGNvbnN0IHJlcXVlc3QgPSB7fTtcbiAgICBpZiAodHlwZW9mIG9wdGlvbnMubWVtY2hhdElzQ3VycmVudCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICBleHRlbnNpb25SZXF1ZXN0R3VhcmRzLnNldChpZCwgb3B0aW9ucy5tZW1jaGF0SXNDdXJyZW50KTtcbiAgICAgICAgcmVxdWVzdC5jcmVkZW50aWFsR3VhcmQgPSB0cnVlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ21ldGhvZCcsICd1cmwnLCAnaGVhZGVycycsICdkYXRhJywgJ3RpbWVvdXQnLCAnYW5vbnltb3VzJywgJ3Jlc3BvbnNlVHlwZSddKSB7XG4gICAgICAgIGlmIChvcHRpb25zW2tleV0gIT09IHVuZGVmaW5lZCkgcmVxdWVzdFtrZXldID0gb3B0aW9uc1trZXldO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdtZW1jaGF0Omh0dHAnLCBpZCwgcmVxdWVzdCB9LCByZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikgZmluaXNoKHsgZXZlbnQ6ICdlcnJvcicsIGVycm9yOiAn0KDQsNGB0YjQuNGA0LXQvdC40LUg0L7QsdC90L7QstC70LXQvdC+INC40LvQuCDQvdC10LTQvtGB0YLRg9C/0L3Qvi4g0J/QtdGA0LXQt9Cw0LPRgNGD0LfQuNGC0LUg0LLQutC70LDQtNC60YMuJyB9KTtcbiAgICAgICAgICAgIGVsc2UgZmluaXNoKHJlc3VsdCk7XG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggeyBmaW5pc2goeyBldmVudDogJ2Vycm9yJywgZXJyb3I6ICfQoNCw0YHRiNC40YDQtdC90LjQtSDQvdC10LTQvtGB0YLRg9C/0L3Qvi4g0J/QtdGA0LXQt9Cw0LPRgNGD0LfQuNGC0LUg0LLQutC70LDQtNC60YMuJyB9KTsgfVxuICAgIHJldHVybiB7IGFib3J0KCkge1xuICAgICAgICBpZiAoZmluaXNoZWQpIHJldHVybjtcbiAgICAgICAgLy8gU2V0dGxlIGxvY2FsbHkgZXZlbiB3aGVuIGFib3J0IHJhY2VzIHRoZSB3b3JrZXIncyBpbml0aWFsIHZhbGlkYXRpb24uXG4gICAgICAgIGZpbmlzaCh7IGV2ZW50OiAnYWJvcnQnIH0pO1xuICAgICAgICB0cnkgeyBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZSh7IHR5cGU6ICdtZW1jaGF0OmFib3J0JywgaWQgfSwgKCkgPT4geyB2b2lkIGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcjsgfSk7IH0gY2F0Y2ggeyAvKiBjb250ZXh0IGludmFsaWRhdGVkICovIH1cbiAgICB9IH07XG59XG5cbi8vIEF2b2lkIG5lc3RlZCByZXRyeSBsb29wczogdGhlIE1WMyB3b3JrZXIgb3ducyBwcm9maWxlLXdpZGUgR0VUIHJldHJpZXMuXG5HTV94bWxodHRwUmVxdWVzdC5tZW1jaGF0TXNTY2hlZHVsZXIgPSB0cnVlO1xuXG4vLyBVc2Vyc2NyaXB0IG1lbnUgcmVnaXN0cmF0aW9ucyBhcmUgaW50ZW50aW9uYWxseSBub3QgZXhwb3NlZCBieSB0aGUgZXh0ZW5zaW9uLlxuLy8gVG9vbGJhciB0b2dnbGUgYW5kIHRoZSBzaW5nbGUgYWN0aW9uLWNvbnRleHQgbWVudSByZXBsYWNlIHRoZW07IG5vIGRlYnVnIGl0ZW0uXG5mdW5jdGlvbiBHTV9yZWdpc3Rlck1lbnVDb21tYW5kKCkgeyByZXR1cm4gbnVsbDsgfVxuXG4vLyBPbmx5IHRoZSBzY2hlZHVsZSBtb2R1bGUgdXNlcyBmZXRjaC4gUm91dGUgaXQgdGhyb3VnaCB0aGUgc2FtZSBwcml2aWxlZ2VkXG4vLyB0cmFuc3BvcnQgcmF0aGVyIHRoYW4gcmVseWluZyBvbiBwYWdlLW9yaWdpbiBDT1JTIHBlcm1pc3Npb25zLlxuZnVuY3Rpb24gZmV0Y2godXJsLCBvcHRpb25zID0ge30pIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBHTV94bWxodHRwUmVxdWVzdCh7IHVybDogU3RyaW5nKHVybCksIG1ldGhvZDogb3B0aW9ucy5tZXRob2QgfHwgJ0dFVCcsIGhlYWRlcnM6IG9wdGlvbnMuaGVhZGVycyxcbiAgICAgICAgICAgIGRhdGE6IG9wdGlvbnMuYm9keSwgYW5vbnltb3VzOiBvcHRpb25zLmNyZWRlbnRpYWxzID09PSAnb21pdCcsXG4gICAgICAgICAgICBvbmxvYWQ6IHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBoZWFkZXJzID0gbmV3IEhlYWRlcnMoKTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIChyZXNwb25zZS5yZXNwb25zZUhlYWRlcnMgfHwgJycpLnNwbGl0KC9cXHI/XFxuLykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKCc6Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29sb24gPiAwKSBoZWFkZXJzLmFwcGVuZChsaW5lLnNsaWNlKDAsIGNvbG9uKSwgbGluZS5zbGljZShjb2xvbiArIDEpLnRyaW0oKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmVzb2x2ZShuZXcgUmVzcG9uc2UoWzIwNCwgMjA1LCAzMDRdLmluY2x1ZGVzKHJlc3BvbnNlLnN0YXR1cykgPyBudWxsIDogcmVzcG9uc2UucmVzcG9uc2VUZXh0LFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBzdGF0dXM6IHJlc3BvbnNlLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzcG9uc2Uuc3RhdHVzVGV4dCwgaGVhZGVycyB9KSk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7IHJlamVjdChuZXcgRXJyb3IoJ9Cd0LXQutC+0YDRgNC10LrRgtC90YvQuSDQvtGC0LLQtdGCINGA0LDRgdGI0LjRgNC10L3QuNGPIE1lbWNoYXQnKSk7IH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBvbmVycm9yOiAoKSA9PiByZWplY3QobmV3IEVycm9yKCfQntGI0LjQsdC60LAg0YHQtdGC0Lgg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcpKSxcbiAgICAgICAgICAgIG9udGltZW91dDogKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign0KLQsNC50LzQsNGD0YIg0YDQsNGB0YjQuNGA0LXQvdC40Y8gTWVtY2hhdCcpKSxcbiAgICAgICAgICAgIG9uYWJvcnQ6ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQvtGC0LzQtdC90ZHQvScpKVxuICAgICAgICB9KTtcbiAgICB9KTtcbn1cblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgIGlmIChzZW5kZXIuaWQgIT09IGNocm9tZS5ydW50aW1lLmlkIHx8IHNlbmRlci50YWJcbiAgICAgICAgfHwgKHNlbmRlci51cmwgJiYgc2VuZGVyLnVybCAhPT0gY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKCd3b3JrZXIuanMnKSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ21lbWNoYXQ6cmVxdWVzdC1jdXJyZW50Jykge1xuICAgICAgICBsZXQgY3VycmVudCA9IGZhbHNlO1xuICAgICAgICB0cnkgeyBjdXJyZW50ID0gZXh0ZW5zaW9uUmVxdWVzdEd1YXJkcy5nZXQobWVzc2FnZS5pZCk/LigpID09PSB0cnVlOyB9IGNhdGNoIHsgLyogZmFpbCBjbG9zZWQgKi8gfVxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBjdXJyZW50IH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmICghWydtZW1jaGF0OnRvZ2dsZScsICdtZW1jaGF0OnJlc2V0LXBvc2l0aW9uJ10uaW5jbHVkZXMobWVzc2FnZT8udHlwZSkpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBjb250cm9sID0gKCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGV4dGVuc2lvblN0b3JhZ2VHYXRlICE9PSAndW5kZWZpbmVkJyAmJiBleHRlbnNpb25TdG9yYWdlR2F0ZS5lcnJvcikgeyBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ3N0b3JhZ2UnIH0pOyByZXR1cm47IH1cbiAgICAgICAgY29uc3QgY29uZmxpY3QgPSBCb29sZWFuKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrQ29udGFpbmVyJykgJiYgIXdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyKTtcbiAgICAgICAgaWYgKGNvbmZsaWN0KSB7IHNlbmRSZXNwb25zZSh7IG9rOiBmYWxzZSwgcmVhc29uOiAnY29uZmxpY3QnIH0pOyByZXR1cm47IH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdtZW1jaGF0OnRvZ2dsZScpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBtYWluID0gd2luZG93LnByaWNlQ2hlY2tDb250YWluZXI7XG4gICAgICAgICAgICAgICAgaWYgKCFtYWluKSBjcmVhdGVQcmljZUNoZWNrV2luZG93KCk7XG4gICAgICAgICAgICAgICAgZWxzZSBtYWluLnN0eWxlLmRpc3BsYXkgPSBnZXRDb21wdXRlZFN0eWxlKG1haW4pLmRpc3BsYXkgPT09ICdub25lJyA/ICdmbGV4JyA6ICdub25lJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmVzZXRGbG9hdFdpbmRvd1BvcygpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1haW4gPSB3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lcjtcbiAgICAgICAgICAgICAgICBpZiAobWFpbikgT2JqZWN0LmFzc2lnbihtYWluLnN0eWxlLCB7IGxlZnQ6ICdhdXRvJywgdG9wOiAnMTRweCcsIHJpZ2h0OiAnMTRweCcsIGJvdHRvbTogJ2F1dG8nIH0pO1xuICAgICAgICAgICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tYy1mbG9hdC13aW5kb3cnKS5mb3JFYWNoKGVsZW1lbnQgPT4ge1xuICAgICAgICAgICAgICAgICAgICBbJ2xlZnQnLCAndG9wJywgJ3JpZ2h0JywgJ2JvdHRvbSddLmZvckVhY2goa2V5ID0+IGVsZW1lbnQuc3R5bGUucmVtb3ZlUHJvcGVydHkoa2V5KSk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogdHJ1ZSB9KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyBvazogZmFsc2UsIHJlYXNvbjogJ2ZhaWxlZCcgfSk7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGlmICh0eXBlb2YgZXh0ZW5zaW9uU3RvcmFnZUdhdGUgIT09ICd1bmRlZmluZWQnICYmICFleHRlbnNpb25TdG9yYWdlR2F0ZS5yZWFkeSkge1xuICAgICAgICBleHRlbnNpb25TdG9yYWdlR2F0ZS5wcm9taXNlLnRoZW4oY29udHJvbCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb250cm9sKCk7XG4gICAgcmV0dXJuIGZhbHNlO1xufSk7XG4iLCIvLyBQbGF0Zm9ybSBjYXBhYmlsaXRpZXMgYXJlIGNvbmZpZ3VyZWQgQkVGT1JFIGluaXRpYWxpemUoKSwgbmV2ZXIgcGF0Y2hlZCBhZnRlcndhcmQuXG4vLyBTdGFuZGFsb25lL0RFViBoYXZlIG5vIGV4dGVuc2lvbiBjYXBhYmlsaXRpZXM7IGxlZ2FjeSBiZWhhdmlvciByZW1haW5zIGxvY2FsLlxuY29uc3QgbWVtY2hhdFBsYXRmb3JtID0geyBwYW5lbDogbnVsbCwgZGlyZWN0TXM6IGZhbHNlIH07XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IE1FTUNIQVRfVkVSU0lPTiA9ICc4LjkuMC1hbHBoYS4xJztcblxuLy8g0KDQtdC20LjQvNC90YvQtSDQstC60LvQsNC00LrQuDogRW50ZXIg0LIg0L/QvtC70LUg0LLQstC+0LTQsCDQstGL0L/QvtC70L3Rj9C10YIg0LTQtdC50YHRgtCy0LjQtS4g0JLQutC70LDQtNC60Lgt0LTQtdC50YHRgtCy0LjRj1xuLy8gKHRvZGF5L3RvbW9ycm93L2hhY2tlcikg0LggwqvQndCw0YHRgtGA0L7QudC60LjCuyDQvtGC0LrRgNGL0LLQsNGO0YIg0L7QutC90L4v0LrQvtC90YLQtdC90YIg0L/QviDQutC70LjQutGDLlxuY29uc3QgTU9ERV9BQ1RJT05TID0gW1xuICAgICdjaGVja0hhdGlrbycsICdjaGVja0hhdGlrb0JvbnVzZXMnLFxuICAgICdjYWxjdWxhdG9yJywgJ2NhbGN1bGF0b3JfcmV2ZXJzZScsICdjYWxjdWxhdG9yX2Rpc2NvdW50JywgJ2NhbGN1bGF0b3Jfc2ltcGxlJ1xuXTtcblxuLy8g4pSA4pSA4pSAINCa0L7QvdGB0YLQsNC90YLRiyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNvbnN0IEJBU0VfVVJMUyA9IFtcbiAgICBcImh0dHBzOi8vaGF0aWtvLnJ1XCIsXG4gICAgXCJodHRwczovL3Zvcm9uZXpoLmhhdGlrby5ydVwiLFxuICAgIFwiaHR0cHM6Ly9saXBldHNrLmhhdGlrby5ydVwiLFxuICAgIFwiaHR0cHM6Ly9iYWxha292by5oYXRpa28ucnVcIlxuXTtcbmNvbnN0IENJVFlfSUNPTlMgPSBbJ/CfhoInLCAn8J+GhScsICfwn4W7JywgJ/Cfl78nXTtcbmNvbnN0IENJVFlfTkFNRVMgPSBbJ9Ch0LDRgNCw0YLQvtCyJywgJ9CS0L7RgNC+0L3QtdC2JywgJ9Cb0LjQv9C10YbQuicsICfQkdCw0LvQsNC60L7QstC+J107XG5cbi8vIOKUgOKUgOKUgCDQn9GA0LDQstC40LvQsCDQutCw0LvRjNC60YPQu9GP0YLQvtGA0LAg0L/QviDRg9C80L7Qu9GH0LDQvdC40Y4g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5jb25zdCBERUZBVUxUX0NBTENfUlVMRVMgPSBbXG4gICAgeyBuYW1lOiBcItCd0LDQu9C40YfQvdGL0LzQuFwiLCAgICAgIHBlcmNlbnQ6IDEwMCwgICByb3VuZDogMSwgICBleHRyYTogMCAgIH0sXG4gICAgeyBuYW1lOiBcIlFSXCIsICAgICAgICAgICAgIHBlcmNlbnQ6IDEwMS41LCByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCa0LDRgNGC0L7QuVwiLCAgICAgICAgIHBlcmNlbnQ6IDEwMiwgICByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCg0LDRgdGB0YDQvtGH0LrQsCA20LxcIiwgICBwZXJjZW50OiAxMDcsICAgcm91bmQ6IDEwMCwgZXh0cmE6IC0xMCB9LFxuICAgIHsgbmFtZTogXCLQoNCw0YHRgdGA0L7Rh9C60LAgMTDQvFwiLCAgcGVyY2VudDogMTA5LCAgIHJvdW5kOiAxMDAsIGV4dHJhOiAtMTAgfSxcbiAgICB7IG5hbWU6IFwi0KDQsNGB0YHRgNC+0YfQutCwIDEy0LxcIiwgIHBlcmNlbnQ6IDExMCwgICByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCg0LDRgdGB0YDQvtGH0LrQsCAxONC8XCIsICBwZXJjZW50OiAxMTMsICAgcm91bmQ6IDEwMCwgZXh0cmE6IC0xMCB9LFxuICAgIHsgbmFtZTogXCLQoNCw0YHRgdGA0L7Rh9C60LAgMjTQvFwiLCAgcGVyY2VudDogMTE2LCAgIHJvdW5kOiAxMDAsIGV4dHJhOiAtMTAgfSxcbiAgICB7IG5hbWU6IFwi0KDQsNGB0YHRgNC+0YfQutCwIDM20LxcIiwgIHBlcmNlbnQ6IDEyMCwgICByb3VuZDogMTAwLCBleHRyYTogLTEwIH0sXG4gICAgeyBuYW1lOiBcItCa0Y3RiNCx0Y3QuiAxJVwiLCAgICAgIHBlcmNlbnQ6IDEsICAgICByb3VuZDogMSwgICBleHRyYTogMCwgIGlzQ2FzaGJhY2s6IHRydWUgfVxuXTtcblxuLy8g4pSA4pSA4pSAINCX0LDQvNC10L3RiyDRgNCw0YHQv9C40YHQsNC90LjRjyDQv9C+INGD0LzQvtC70YfQsNC90LjRjiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmNvbnN0IERFRkFVTFRfUkVQTEFDRU1FTlRTID0ge1xuICAgIFwi0KNcIjogICAgIFwi8J+YjiDQutCw0Log0KPQv9GA0LDQstC70Y/RjtGJ0LjQuVwiLFxuICAgIFwi0JxcIjogICAgIFwi8J+ZgiDQutCw0Log0JzQtdC90LXQtNC20LXRgFwiLFxuICAgIFwiTVwiOiAgICAgXCLwn5mCINC60LDQuiDQnNC10L3QtdC00LbQtdGAXCIsXG4gICAgXCLQoNCRXCI6ICAgIFwi8J+PqiDQsiDQotCmINCg0YPQsdC40L1cIixcbiAgICBcItCgXCI6ICAgICBcIvCfj6og0L3QsCDQoNCw0YXQvtCy0LBcIixcbiAgICBcItCaXCI6ICAgICBcIvCfj6og0L3QsCDQmtCw0LfQsNGH0YzQtdC5XCIsXG4gICAgXCLQp1wiOiAgICAgXCLwn4+qINC90LAg0KfQtdGA0L3Ri9GI0LXQstGB0LrQvtCz0L5cIixcbiAgICBcIkNcIjogICAgIFwi8J+PqiDQsiDQotCmINCh0LjRgtC40JzQvtC70LtcIixcbiAgICBcItChXCI6ICAgICBcIvCfj6og0LIg0KLQpiDQodC40YLQuNCc0L7Qu9C7XCIsXG4gICAgXCLQmFwiOiAgICAgXCLwn5ixINC60LDQuiBTTU1cIixcbiAgICBcIjFcIjogICAgIFwi8J+nkeKAjfCfkrwg0KDQsNCx0L7RgtCw0LXRglwiLFxuICAgIFwi0JBcIjogICAgIFwi8J+RgCDQqNCw0YLQsNC10YIg0JDQstC40YLQvlwiLFxuICAgIFwiMTE0XCI6ICAgXCLwn5ug77iPINC90LAg0KfQtdGA0L3Ri9GI0LXQstGB0LrQvtCz0L4g8J+TnjExNFwiLFxuICAgIFwiMTExXCI6ICAgXCLwn5ug77iPINCyINCi0KYg0KDRg9Cx0LjQvSDwn5OeMTExXCIsXG4gICAgXCIxMDRcIjogICBcIvCfm6DvuI8g0L3QsCDQmtCw0LfQsNGH0YzQtdC5IPCfk54xMDRcIixcbiAgICBcIjEwN1wiOiAgIFwi8J+boO+4jyDQvdCwINCa0LDQt9Cw0YfRjNC10LksINCh0YLQsNGA0YjQuNC5KC3QsNGPKSDwn5OeMTA3XCIsXG4gICAgXCLQmi0xMDBcIjogXCLwn4+qINC90LAg0JrQsNC30LDRh9GM0LXQuSDwn5OeMTAwXCIsXG4gICAgXCLQmi0xMDFcIjogXCLwn4+qINC90LAg0JrQsNC30LDRh9GM0LXQuSDwn5OeMTAxXCIsXG4gICAgXCLQoC0xMTZcIjogXCLwn4+qINC90LAg0KDQsNGF0L7QstCwIPCfk54xMTZcIixcbiAgICBcItCgLTExN1wiOiBcIvCfj6og0L3QsCDQoNCw0YXQvtCy0LAg8J+TnjExN1wiLFxuICAgIFwi0KDQkS0xMTFcIjpcIvCfj6og0LIg0KLQpiDQoNGD0LHQuNC9IPCfk54xMTdcIixcbiAgICBcItCnLTExNFwiOiBcIvCfj6og0J3QsCDQp9C10YDQvdGL0YjQtdCy0YHQutC+0LPQviDwn5OeMTE0XCIsXG4gICAgXCLQoTEzMFwiOiAgXCLwn4+qINCyINCi0KYg0KHQuNGC0LjQnNC+0LvQuyDwn5OeMTMxXCIsXG4gICAgXCLQoTEzMVwiOiAgXCLwn4+qINCyINCi0KYg0KHQuNGC0LjQnNC+0LvQuyDwn5OeMTMxXCIsXG4gICAgXCLQoTEzMlwiOiAgXCLwn4+qINCyINCi0KYg0KHQuNGC0LjQnNC+0LvQuyDwn5OeMTMyXCIsXG4gICAgXCIzMDBcIjogICBcIvCfj6og0J3QuNC60LjRgtC40L3RgdC60LDRjyA0NCDwn5OeMzAwXCIsXG4gICAgXCIzMTBcIjogICBcIuKbtSDQk9Cw0LvQtdGA0LXRjyDQp9C40LbQvtCy0LAg8J+TnjMxMFwiLFxuICAgIFwiMzExXCI6ICAgXCLim7Ug0JPQsNC70LXRgNC10Y8g0KfQuNC20L7QstCwIPCfk54zMTFcIlxufTtcblxuLy8g4pSA4pSA4pSAINCh0L7RgdGC0L7Rj9C90LjQtSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmxldCBpc0RyYWdnaW5nICAgID0gZmFsc2U7XG5sZXQgb2Zmc2V0ICAgICAgICA9IHsgeDogMCwgeTogMCB9O1xubGV0IGN1cnJlbnRBY3Rpb24gPSBudWxsO1xuLy8g0JjRgdGC0L7RgNC40Y8g0YfQsNGC0LA6INC/0L4g0LzQsNGB0YHQuNCy0YMg0L3QsCDQstC60LvQsNC00LrRgyAoc3dpdGNoLWtleSksINC20LjQstGR0YIg0YLQvtC70YzQutC+INCyINC/0LDQvNGP0YLQuCDRgdC10YHRgdC40LguXG4vLyDQktC60LvQsNC00LrRgyDCq9CR0L7QvdGD0YHRi8K7INC90LDQvNC10YDQtdC90L3QviDQvdC1INC/0LXRgNGB0LjRgdGC0LjQvCDigJQg0YLQsNC8INC90L7QvNC10YDQsCDRgtC10LvQtdGE0L7QvdC+0LIg0LrQu9C40LXQvdGC0L7QsiAo0J/QlNC9KS5cbmxldCBjaGF0SGlzdG9yeUJ5QWN0aW9uID0ge307XG5sZXQgY2xlYXJUZXh0RW5hYmxlZCA9IGZhbHNlO1xubGV0IGNsZWFyVGV4dERlbGF5ID0gNTAwO1xubGV0IGdsb2JhbENsZWFyS2V5cHJlc3NCb3VuZCA9IGZhbHNlO1xubGV0IGNhbGNSdWxlcyAgICAgPSBbXTtcbmxldCBzY2hlZHVsZVJlcGxhY2VtZW50cyA9IHt9O1xuY29uc3QgU0NIRURVTEVfQ0FDSEVfVFRMX01TID0gMTIgKiA2MCAqIDYwICogMTAwMDtcbmxldCBzY2hlZHVsZUNhY2hlRW5hYmxlZCA9IHRydWU7XG5sZXQgc2NoZWR1bGVTdGF0ZUJ5RGF5ID0ge1xuICAgIHRvZGF5OiB7IGxvYWRpbmc6IGZhbHNlLCBwYXJzZWQ6IG51bGwsIHRleHRDb3B5OiAnJywgZXJyb3I6ICcnLCB1cGRhdGVkQXQ6IDAgfSxcbiAgICB0b21vcnJvdzogeyBsb2FkaW5nOiBmYWxzZSwgcGFyc2VkOiBudWxsLCB0ZXh0Q29weTogJycsIGVycm9yOiAnJywgdXBkYXRlZEF0OiAwIH1cbn07XG5sZXQgY3VycmVudEhhdGlrb1BhdGhuYW1lID0gJyc7XG5sZXQgbGFzdEhhdGlrb1Jlc3VsdHMgPSBbXTtcbmxldCBsYXN0SGF0aWtvUXVlcnkgPSAnJztcbmxldCBoYXRpa29TZWFyY2hNb2RlID0gJ2F1dG8nO1xubGV0IGFjdGl2ZVJlcXVlc3RJZCA9IDA7XG4vLyDQn9C+0LLQtdC00LXQvdC40LUg0LrQvdC+0L/QutC4IPCflIE6IGFwcGVuZCDigJQg0YHQvtGF0YDQsNC90LjRgtGMINGB0YLQsNGA0YvQuSDQvtGC0LLQtdGCLCByZXBsYWNlIOKAlCDQt9Cw0LzQtdC90LjRgtGMINC10LPQvi5cbmxldCByZXRyeUJlaGF2aW9yID0gJ2FwcGVuZCc7XG5cbi8vIEFQSSDQnNC+0LnQodC60LvQsNC0INC00LvRjyDQpdCw0YLQuNC60L7QpdCw0LrQtdGA0LBcbmxldCBoYWNrZXJCZWFyZXJFbmFibGVkID0gZmFsc2U7XG5sZXQgaGFja2VyQmVhcmVyVG9rZW4gPSAnJztcbmxldCBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbmxldCBoYWNrZXJEZWZhdWx0Q2hhbm5lbCA9ICcnO1xubGV0IGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQgPSB0cnVlO1xuY29uc3QgSEFDS0VSX05PVElGSUVSX0FVRElPX1VSTCA9ICdodHRwczovL3d3dy5teWluc3RhbnRzLmNvbS9tZWRpYS9zb3VuZHMvZm5hZi1hbmltYXRyb25pYy1hdC1kb29yLm1wMyc7XG5jb25zdCBIQUNLRVJfTk9USUZJRVJfREVGQVVMVF9JTlRFUlZBTF9NSU5VVEVTID0gNTtcbmxldCBoYWNrZXJOb3RpZmllclNldHRpbmdzID0ge1xuICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgc291bmRFbmFibGVkOiB0cnVlLFxuICAgIGludGVydmFsTWludXRlczogSEFDS0VSX05PVElGSUVSX0RFRkFVTFRfSU5URVJWQUxfTUlOVVRFUyxcbiAgICB0b2FzdER1cmF0aW9uTWludXRlczogNSxcbiAgICBvcmdhbml6YXRpb25IcmVmczogW10sXG4gICAgc3RhdHVzSHJlZnM6IFtdXG59O1xubGV0IGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucyA9IFtdO1xubGV0IGhhY2tlck5vdGlmaWVyU2VlbkJ5T3JnYW5pemF0aW9uID0ge307XG5sZXQgaGFja2VyTm90aWZpZXJTdGF0dXNTZWxlY3Rpb25Jbml0aWFsaXplZCA9IGZhbHNlO1xubGV0IGhhY2tlck5vdGlmaWVyVGltZXIgPSBudWxsO1xubGV0IGhhY2tlck5vdGlmaWVySW5GbGlnaHQgPSBmYWxzZTtcbmxldCBoYWNrZXJOb3RpZmllckF1ZGlvID0gbnVsbDtcbi8vINCt0LrRgdC/0LXRgNC40LzQtdC90YLQsNC70YzQvdGL0LUgQVBJLdC60L3QvtC/0LrQuCDRgdC+0LfQtNCw0L3QuNGPINC00L7QutGD0LzQtdC90YLQvtCyINCy0YDQtdC80LXQvdC90L4g0YHQutGA0YvRgtGLLlxuLy8g0KDQsNCx0L7Rh9Cw0Y8g0L/QsNC90LXQu9GMLCDQvdCw0LbQuNC80LDRjtGJ0LDRjyDRiNGC0LDRgtC90YvQtSDQv9GD0L3QutGC0Ysg0LzQtdC90Y4g0JzQvtC50KHQutC70LDQtCwg0L7RgdGC0LDRkdGC0YHRjyDQstC60LvRjtGH0ZHQvdC90L7QuS5cbmNvbnN0IEhBQ0tFUl9RVUlDS19BUElfUk9XX0VOQUJMRUQgPSBmYWxzZTtcblxuLy8g8J+qhCDQn9GA0LDQstC40LvQsCDQt9Cw0L/QvtC70L3QtdC90LjRjyDRiNGC0LDRgtC90YvRhSDQutCw0YDRgtC+0YfQtdC6INC00L7QutGD0LzQtdC90YLQvtCyINCc0L7QudCh0LrQu9Cw0LQuINCf0YPRgdGC0YvQtSDQvtCx0Y/Qt9Cw0YLQtdC70YzQvdGL0LVcbi8vINC30L3QsNGH0LXQvdC40Y8g0L/QvtC70YzQt9C+0LLQsNGC0LXQu9GMINCy0YvQsdC40YDQsNC10YIg0LIg0L7QutC90LUg0L/QsNC70L7Rh9C60Lgg0L/QtdGA0LXQtCDRgdC+0YXRgNCw0L3QtdC90LjQtdC8INC00L7QutGD0LzQtdC90YLQsC5cbmNvbnN0IERFRkFVTFRfTVNfTUFHSUNfQ09ORklHID0ge1xuICAgIGRlbWFuZDoge1xuICAgICAgICBjb3BpZXM6IFt7IGZpZWxkOiAn0JrQsNC90LDQuyDQv9GA0L7QtNCw0LYnLCBmcm9tOiAwLCB0bzogWzFdLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICAgICAgdmFsdWVzOiBbXVxuICAgIH0sXG4gICAgY2FzaGluOiB7XG4gICAgICAgIGNvcGllczogW10sXG4gICAgICAgIHZhbHVlczogW1xuICAgICAgICAgICAgeyBmaWVsZDogJ9Ci0LjQvyDQvtC/0LvQsNGC0YsnLCB2YWx1ZTogJ9Cd0LDQu9C40YfQvdGL0LzQuCcsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICAgICAgICB7IGZpZWxkOiAn0KHRgtCw0YLRg9GBINC60LvQuNC10L3RgtCwJywgdmFsdWU6ICcnLCByZXF1aXJlZDogdHJ1ZSB9XG4gICAgICAgIF1cbiAgICB9LFxuICAgIHBheW1lbnRpbjoge1xuICAgICAgICBjb3BpZXM6IFtdLFxuICAgICAgICB2YWx1ZXM6IFt7IGZpZWxkOiAn0KHQv9C+0YHQvtCxINC+0L/Qu9Cw0YLRiycsIHZhbHVlOiAnJywgcmVxdWlyZWQ6IHRydWUgfV1cbiAgICB9XG59O1xubGV0IG1zTWFnaWNDb25maWcgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfTVNfTUFHSUNfQ09ORklHKSk7XG5cbi8vIOKUgOKUgOKUgCDQodC60YDRi9GC0LjQtSDQv9C+0LvQtdC5INCc0L7QudCh0LrQu9Cw0LQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5sZXQgaGlkZGVuRmllbGRzID0gW107ICAgICAgICAvLyDQuNC80LXQvdCwINC/0L7Qu9C10LkgKNGC0L7Rh9C90YvQuSDRgtC10LrRgdGCINC70LXQudCx0LvQsCksINC/0YDRj9GH0LXQvNGL0YUg0L3QsCDQnNC+0LnQodC60LvQsNC0XG5sZXQgbXNGaWVsZHNSZXZlYWxlZCA9IGZhbHNlOyAvLyDCq9GA0LDRgdC60YDRi9GC0Ywg0LLRgdGRwrsg0YEg0L/Qu9Cw0LLQsNGO0YnQtdC5INC60L3QvtC/0LrQuCDwn5GBICjQstGA0LXQvNC10L3QvdC+KVxubGV0IG1zRmllbGRPYnNlcnZlciA9IG51bGw7XG5sZXQgbXNIaWRkZW5UYXJnZXRzID0gW107ICAgICAvLyBbe2VsLCBuYW1lfV0g4oCUINGA0LXQsNC70YzQvdC+INGB0L/RgNGP0YLQsNC90L3Ri9C1INGB0LXQudGH0LDRgSDRjdC70LXQvNC10L3RgtGLXG5jb25zdCBLTk9XTl9NU19GSUVMRFMgPSBbXG4gICAgJ9Ce0L/Qu9Cw0YfQtdC90L4g0LHQvtC90YPRgdCw0LzQuCcsICfQodGD0LzQvNCwINCd0JTQoScsICfQn9GA0L7QvNC10LbRg9GC0L7Rh9C90YvQuSDQuNGC0L7QsycsICfQntCx0YnQsNGPINGB0YLQvtC40LzQvtGB0YLRjCcsXG4gICAgJ9Ce0LHRitC10LwnLCAn0JLQtdGBJywgJ9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2JywgJ9Cf0YDQvtC10LrRgicsICfQkNC00YDQtdGBINC00L7RgdGC0LDQstC60LgnLCAn0JrQvtC80LzQtdC90YLQsNGA0LjQuScsXG4gICAgJ9Cd0L7QvNC10YAg0LfQsNC60LDQt9CwINC90LAg0YHQsNC50YLQtScsICfQn9C70LDQvS4g0LTQsNGC0LAg0L7RgtCz0YDRg9C30LrQuCcsICfQlNC+0LPQvtCy0L7RgCcsICfQktCw0LvRjtGC0LAg0LTQvtC60YPQvNC10L3RgtCwJ1xuXTtcblxuLy8g4pSA4pSA4pSAINCf0LDQvdC10LvRjCDQsdGL0YHRgtGA0YvRhSDQutC90L7Qv9C+0Log0JzQvtC50KHQutC70LDQtCAo0YHQvtC30LTQsNGC0Ywv0L/QtdGH0LDRgtGMKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIGtpbmQg4oaSINC/0YPQvdC60YLRiyDQvNC10L3RjiDRgtGD0LvQsdCw0YDQsCDQutCw0YDRgtC+0YfQutC4LiBtYXJrZXIoKSDQvtC/0YDQtdC00LXQu9GP0LXRgiDRgdGC0YDQsNC90LjRhtGDINC/0L4gaGFzaC5cbmxldCBtc1F1aWNrUGFuZWxFbmFibGVkID0gdHJ1ZTtcbmxldCBtc1F1aWNrT2JzZXJ2ZXIgPSBudWxsO1xuY29uc3QgTVNfUVVJQ0tfUEFORUxfQ09ORklHID0ge1xuICAgIGN1c3RvbWVyb3JkZXI6IHtcbiAgICAgICAgbWFya2VyOiAoKSA9PiAvXiNjdXN0b21lcm9yZGVyXFwvZWRpdC8udGVzdChsb2NhdGlvbi5oYXNoKSxcbiAgICAgICAgbWFnaWM6IGZhbHNlLFxuICAgICAgICBjcmVhdGU6IFsn0J7RgtCz0YDRg9C30LrQsCcsICfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0LXQticsICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCddLFxuICAgICAgICBwcmludDogWydb0KHQtdGA0LLQuNGBXSDQn9GA0LjQtdC80L3QsNGPINC60LLQuNGC0LDQvdGG0LjRjyBBNCB4MicsICdb0KHQtdGA0LLQuNGBXSDQotC+0LLQsNGA0L3Ri9C5INGH0LXQuicsICdb0KHQtdGA0LLQuNGBXSDQlNC+0LPQvtCy0L7RgCDQutGD0L/Qu9C4LdC/0YDQvtC00LDQttC4ICvQsNC60YInXVxuICAgIH0sXG4gICAgZGVtYW5kOiB7XG4gICAgICAgIG1hcmtlcjogKCkgPT4gL14jZGVtYW5kXFwvZWRpdC8udGVzdChsb2NhdGlvbi5oYXNoKSxcbiAgICAgICAgbWFnaWM6IHRydWUsXG4gICAgICAgIGNyZWF0ZTogWyfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0LXQticsICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCcsICfQktC+0LfQstGA0LDRgiDQv9C+0LrRg9C/0LDRgtC10LvRjyddLFxuICAgICAgICBwcmludDogWyfQotC+0LLQsNGA0L3Ri9C5INGH0LXQuiA1JScsICfQotC+0LLQsNGA0L3Ri9C5INGH0LXQuiDQn9Cw0YLQtdC90YInLCAnW9Ch0LXRgNCy0LjRgV0g0KLQvtCy0LDRgNC90YvQuSDRh9C10Log0JA0JywgJ1vQodC10YDQstC40YFdINCa0LLQuNGC0LDQvdGG0LjRjyDQvdCwINCxL9GDJ11cbiAgICB9LFxuICAgIGNhc2hpbjoge1xuICAgICAgICBtYXJrZXI6ICgpID0+IC9eI2Nhc2hpblxcL2VkaXQvLnRlc3QobG9jYXRpb24uaGFzaCksXG4gICAgICAgIG1hZ2ljOiB0cnVlLFxuICAgICAgICBjcmVhdGU6IFsn0J7RgtCz0YDRg9C30LrQsCcsICfQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0LXQtiddLFxuICAgICAgICBwcmludDogW11cbiAgICB9LFxuICAgIHBheW1lbnRpbjoge1xuICAgICAgICBtYXJrZXI6ICgpID0+IC9eI3BheW1lbnRpblxcL2VkaXQvLnRlc3QobG9jYXRpb24uaGFzaCksXG4gICAgICAgIG1hZ2ljOiB0cnVlLFxuICAgICAgICBjcmVhdGU6IFsn0J7RgtCz0YDRg9C30LrQsCcsICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCddLFxuICAgICAgICBwcmludDogW11cbiAgICB9XG59O1xuXG5jb25zdCBERUJVR19TVE9SQUdFX0tFWSA9ICdtZW1jaGF0OmRlYnVnJztcblxuLy8g4pSA4pSA4pSAINCY0YHRgtC+0YDQuNGPINGH0LDRgtCwINC/0L4g0LLQutC70LDQtNC60LDQvCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhpc3RvcnlGb3IoYWN0aW9uKSB7XG4gICAgY29uc3Qga2V5ID0gYWN0aW9uIHx8ICdjaGVja0hhdGlrbyc7XG4gICAgaWYgKCFjaGF0SGlzdG9yeUJ5QWN0aW9uW2tleV0pIGNoYXRIaXN0b3J5QnlBY3Rpb25ba2V5XSA9IFtdO1xuICAgIHJldHVybiBjaGF0SGlzdG9yeUJ5QWN0aW9uW2tleV07XG59XG5cbmZ1bmN0aW9uIGFjdGl2ZUhpc3RvcnkoKSB7XG4gICAgcmV0dXJuIGhpc3RvcnlGb3IoY3VycmVudEFjdGlvbik7XG59XG5cbmZ1bmN0aW9uIGlzRGVidWdFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShERUJVR19TVE9SQUdFX0tFWSkgPT09ICd0cnVlJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZGVidWdMb2coc2NvcGUsIC4uLmFyZ3MpIHtcbiAgICBpZiAoaXNEZWJ1Z0VuYWJsZWQoKSkgY29uc29sZS5kZWJ1ZyhgW01lbWNoYXQ6JHtzY29wZX1dYCwgLi4uYXJncyk7XG59XG5cbmZ1bmN0aW9uIGRlYnVnRXJyb3Ioc2NvcGUsIC4uLmFyZ3MpIHtcbiAgICBjb25zb2xlLmVycm9yKGBbTWVtY2hhdDoke3Njb3BlfV1gLCAuLi5hcmdzKTtcbn1cblxuZnVuY3Rpb24gdG9nZ2xlRGVidWdNb2RlKCkge1xuICAgIGNvbnN0IGVuYWJsZWQgPSAhaXNEZWJ1Z0VuYWJsZWQoKTtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShERUJVR19TVE9SQUdFX0tFWSwgU3RyaW5nKGVuYWJsZWQpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdkZWJ1ZycsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDRgNC10LbQuNC8INC+0YLQu9Cw0LTQutC4JywgZXJyb3IpO1xuICAgIH1cbiAgICBjb25zb2xlLmluZm8oYFtNZW1jaGF0OmRlYnVnXSAke2VuYWJsZWQgPyAn0LLQutC70Y7Rh9C10L3QsCcgOiAn0LLRi9C60LvRjtGH0LXQvdCwJ31gKTtcbn1cblxuZnVuY3Rpb24gaW5zdGFsbERlYnVnSGFuZGxlcnMoKSB7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgZXZlbnQgPT4ge1xuICAgICAgICBkZWJ1Z0Vycm9yKCd1bmNhdWdodCcsIGV2ZW50LmVycm9yIHx8IGV2ZW50Lm1lc3NhZ2UsIGV2ZW50LmZpbGVuYW1lLCBldmVudC5saW5lbm8pO1xuICAgIH0pO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCd1bmhhbmRsZWRyZWplY3Rpb24nLCBldmVudCA9PiB7XG4gICAgICAgIGNvbnN0IHJlYXNvbiA9IGV2ZW50LnJlYXNvbjtcbiAgICAgICAgZGVidWdFcnJvcigncHJvbWlzZScsIHJlYXNvbj8uc3RhY2sgfHwgcmVhc29uPy5tZXNzYWdlIHx8IHJlYXNvbik7XG4gICAgfSk7XG59XG5cbiIsIi8vIOKUgOKUgOKUgCDQl9Cw0LPRgNGD0LfQutCwIC8g0YHQvtGF0YDQsNC90LXQvdC40LUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBzdG9yYWdlS2V5KGtleSkge1xuICAgIHJldHVybiBgJHt0eXBlb2YgTUVNQ0hBVF9CVUlMRCAhPT0gJ3VuZGVmaW5lZCcgPyBgbWVtY2hhdDoke01FTUNIQVRfQlVJTER9OmAgOiAnbWVtY2hhdDonfSR7a2V5fWA7XG59XG5cbmZ1bmN0aW9uIGxvYWRDYWxjUnVsZXMoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qga2V5ID0gc3RvcmFnZUtleSgnY2FsY1J1bGVzX3YyJyk7XG4gICAgICAgIGNvbnN0IGxlZ2FjeUtleSA9ICdjYWxjUnVsZXNfdjInO1xuICAgICAgICBjb25zdCBzID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KVxuICAgICAgICAgICAgfHwgKHR5cGVvZiBNRU1DSEFUX0JVSUxEID09PSAndW5kZWZpbmVkJyA/IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUtleSkgOiBudWxsKTtcbiAgICAgICAgY2FsY1J1bGVzID0gcyA/IEpTT04ucGFyc2UocykgOiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfQ0FMQ19SVUxFUykpO1xuICAgICAgICBpZiAocyAmJiAhbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSkgc2F2ZUNhbGNSdWxlcygpO1xuICAgIH0gY2F0Y2ggeyBjYWxjUnVsZXMgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfQ0FMQ19SVUxFUykpOyB9XG59XG5mdW5jdGlvbiBzYXZlQ2FsY1J1bGVzKCkge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2NhbGNSdWxlc192MicpLCBKU09OLnN0cmluZ2lmeShjYWxjUnVsZXMpKTtcbn1cblxuZnVuY3Rpb24gbG9hZFNjaGVkdWxlUmVwbGFjZW1lbnRzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGtleSA9IHN0b3JhZ2VLZXkoJ3NjaGVkdWxlUmVwbGFjZW1lbnRzX3YxJyk7XG4gICAgICAgIGNvbnN0IGxlZ2FjeUtleSA9ICdzY2hlZHVsZVJlcGxhY2VtZW50c192MSc7XG4gICAgICAgIGNvbnN0IHMgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpXG4gICAgICAgICAgICB8fCAodHlwZW9mIE1FTUNIQVRfQlVJTEQgPT09ICd1bmRlZmluZWQnID8gbG9jYWxTdG9yYWdlLmdldEl0ZW0obGVnYWN5S2V5KSA6IG51bGwpO1xuICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50cyA9IHMgPyBKU09OLnBhcnNlKHMpIDogSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX1JFUExBQ0VNRU5UUykpO1xuICAgICAgICBpZiAocyAmJiAhbG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSkgc2F2ZVNjaGVkdWxlUmVwbGFjZW1lbnRzKCk7XG4gICAgfSBjYXRjaCB7IHNjaGVkdWxlUmVwbGFjZW1lbnRzID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX1JFUExBQ0VNRU5UUykpOyB9XG59XG5mdW5jdGlvbiBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKSB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnc2NoZWR1bGVSZXBsYWNlbWVudHNfdjEnKSwgSlNPTi5zdHJpbmdpZnkoc2NoZWR1bGVSZXBsYWNlbWVudHMpKTtcbiAgICBPYmplY3QuZW50cmllcyhzY2hlZHVsZVN0YXRlQnlEYXkpLmZvckVhY2goKFtkYXksIHN0YXRlXSkgPT4ge1xuICAgICAgICBpZiAoc3RhdGUuc25hcHNob3QpIGFwcGx5U2NoZWR1bGVTbmFwc2hvdChkYXksIHN0YXRlLnNuYXBzaG90KTtcbiAgICAgICAgcmVuZGVyU2NoZWR1bGVUYWIoZGF5KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gbG9hZFNjaGVkdWxlQ2FjaGVFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHNjaGVkdWxlQ2FjaGVFbmFibGVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnc2NoZWR1bGVDYWNoZUVuYWJsZWRfdjEnKSkgIT09ICdmYWxzZSc7XG4gICAgfSBjYXRjaCB7IHNjaGVkdWxlQ2FjaGVFbmFibGVkID0gdHJ1ZTsgfVxufVxuXG5mdW5jdGlvbiBzYXZlU2NoZWR1bGVDYWNoZUVuYWJsZWQoZW5hYmxlZCkge1xuICAgIHNjaGVkdWxlQ2FjaGVFbmFibGVkID0gISFlbmFibGVkO1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ3NjaGVkdWxlQ2FjaGVFbmFibGVkX3YxJyksIFN0cmluZyhzY2hlZHVsZUNhY2hlRW5hYmxlZCkpO1xuICAgIH0gY2F0Y2ggeyAvKiDQndCw0YHRgtGA0L7QudC60LAg0L/RgNC+0LTQvtC70LbQsNC10YIg0LTQtdC50YHRgtCy0L7QstCw0YLRjCDQsiDRgtC10LrRg9GJ0LXQuSDRgdGC0YDQsNC90LjRhtC1LiAqLyB9XG59XG5cbmZ1bmN0aW9uIGxvYWRTY2hlZHVsZUNhY2hlKGRheSwgdGFyZ2V0RGF0ZSkge1xuICAgIGlmICghc2NoZWR1bGVDYWNoZUVuYWJsZWQpIHJldHVybiBudWxsO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KGBzY2hlZHVsZUNhY2hlX3YxXyR7ZGF5fWApKSB8fCAnbnVsbCcpO1xuICAgICAgICBjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gc2F2ZWQ/LmZldGNoZWRBdDtcbiAgICAgICAgaWYgKHNhdmVkPy5zY2hlbWEgIT09IDEgfHwgc2F2ZWQudGFyZ2V0RGF0ZSAhPT0gdGFyZ2V0RGF0ZVxuICAgICAgICAgICAgfHwgIU51bWJlci5pc0Zpbml0ZShzYXZlZC5mZXRjaGVkQXQpIHx8IGFnZSA8IDAgfHwgYWdlID49IFNDSEVEVUxFX0NBQ0hFX1RUTF9NU1xuICAgICAgICAgICAgfHwgdHlwZW9mIHNhdmVkLnJhd1RleHQgIT09ICdzdHJpbmcnIHx8ICFzYXZlZC5yYXdUZXh0LnRyaW0oKVxuICAgICAgICAgICAgfHwgIXNhdmVkLnJlbW90ZVJlcGxhY2VtZW50cyB8fCB0eXBlb2Ygc2F2ZWQucmVtb3RlUmVwbGFjZW1lbnRzICE9PSAnb2JqZWN0J1xuICAgICAgICAgICAgfHwgQXJyYXkuaXNBcnJheShzYXZlZC5yZW1vdGVSZXBsYWNlbWVudHMpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIHNhdmVkO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxufVxuXG5mdW5jdGlvbiBzYXZlU2NoZWR1bGVDYWNoZShkYXksIHNuYXBzaG90KSB7XG4gICAgaWYgKCFzY2hlZHVsZUNhY2hlRW5hYmxlZCkgcmV0dXJuO1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoYHNjaGVkdWxlQ2FjaGVfdjFfJHtkYXl9YCksIEpTT04uc3RyaW5naWZ5KHNuYXBzaG90KSk7XG4gICAgfSBjYXRjaCB7IC8qINCd0LXQtNC+0YHRgtGD0L/QvdC+0LUg0YXRgNCw0L3QuNC70LjRidC1INC90LUg0LzQtdGI0LDQtdGCINC/0L7QutCw0LfQsNGC0Ywg0L/QvtC70YPRh9C10L3QvdC+0LUg0YDQsNGB0L/QuNGB0LDQvdC40LUuICovIH1cbn1cblxuZnVuY3Rpb24gbG9hZFNlbGVjdGVkQWN0aW9uKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdzZWxlY3RlZEFjdGlvbl92MScpKSB8fCAnY2hlY2tIYXRpa28nO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gJ2NoZWNrSGF0aWtvJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVTZWxlY3RlZEFjdGlvbihhY3Rpb24pIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdzZWxlY3RlZEFjdGlvbl92MScpLCBhY3Rpb24pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0LLRi9Cx0YDQsNC90L3Ri9C5INGA0LXQttC40LwnLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBsb2FkU2hvd0hhdGlrb0xpbmtzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdzaG93SGF0aWtvTGlua3NfdjEnKSkgPT09ICd0cnVlJztcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gc2F2ZVNob3dIYXRpa29MaW5rcyhlbmFibGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnc2hvd0hhdGlrb0xpbmtzX3YxJyksIFN0cmluZyhlbmFibGVkKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQvdCw0YHRgtGA0L7QudC60YMg0YHRgdGL0LvQvtC6IEhhdGlrbycsIGVycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGxvYWRIYXRpa29TZWFyY2hNb2RlKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1vZGUgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYXRpa29TZWFyY2hNb2RlX3YxJykpO1xuICAgICAgICByZXR1cm4gWydhdXRvJywgJ3BhbmVsJywgJ2hhdGlrbyddLmluY2x1ZGVzKG1vZGUpID8gbW9kZSA6ICdhdXRvJztcbiAgICB9IGNhdGNoIHsgcmV0dXJuICdhdXRvJzsgfVxufVxuXG5mdW5jdGlvbiBzYXZlSGF0aWtvU2VhcmNoTW9kZShtb2RlKSB7XG4gICAgaWYgKCFbJ2F1dG8nLCAncGFuZWwnLCAnaGF0aWtvJ10uaW5jbHVkZXMobW9kZSkpIHJldHVybjtcbiAgICBoYXRpa29TZWFyY2hNb2RlID0gbW9kZTtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYXRpa29TZWFyY2hNb2RlX3YxJyksIG1vZGUpO1xufVxuXG5mdW5jdGlvbiBsb2FkUmV0cnlCZWhhdmlvcigpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBiZWhhdmlvciA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ3JldHJ5QmVoYXZpb3JfdjEnKSk7XG4gICAgICAgIHJldHVybiBiZWhhdmlvciA9PT0gJ3JlcGxhY2UnID8gJ3JlcGxhY2UnIDogJ2FwcGVuZCc7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiAnYXBwZW5kJztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVSZXRyeUJlaGF2aW9yKGJlaGF2aW9yKSB7XG4gICAgaWYgKCFbJ2FwcGVuZCcsICdyZXBsYWNlJ10uaW5jbHVkZXMoYmVoYXZpb3IpKSByZXR1cm47XG4gICAgcmV0cnlCZWhhdmlvciA9IGJlaGF2aW9yO1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ3JldHJ5QmVoYXZpb3JfdjEnKSwgYmVoYXZpb3IpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L/QvtCy0LXQtNC10L3QuNC1INC60L3QvtC/0LrQuCDQv9C+0LLRgtC+0YDQsCcsIGVycm9yKTtcbiAgICB9XG59XG5cbi8vIOKUgOKUgOKUgCDQodC60YDRi9GC0YvQtSDQv9C+0LvRjyDQnNC+0LnQodC60LvQsNC0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gbG9hZEhpZGRlbkZpZWxkcygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGlkZGVuRmllbGRzX3YxJykpO1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBzID8gSlNPTi5wYXJzZShzKSA6IFtdO1xuICAgICAgICBoaWRkZW5GaWVsZHMgPSBBcnJheS5pc0FycmF5KHBhcnNlZCkgPyBwYXJzZWQuZmlsdGVyKG4gPT4gdHlwZW9mIG4gPT09ICdzdHJpbmcnKSA6IFtdO1xuICAgIH0gY2F0Y2ggeyBoaWRkZW5GaWVsZHMgPSBbXTsgfVxufVxuXG5mdW5jdGlvbiBzYXZlSGlkZGVuRmllbGRzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hpZGRlbkZpZWxkc192MScpLCBKU09OLnN0cmluZ2lmeShoaWRkZW5GaWVsZHMpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdzdG9yYWdlJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINGB0L/QuNGB0L7QuiDRgdC60YDRi9GC0YvRhSDQv9C+0LvQtdC5JywgZXJyb3IpO1xuICAgIH1cbn1cblxuLy8g4pSA4pSA4pSAINCf0LDQvdC10LvRjCDQsdGL0YHRgtGA0YvRhSDQutC90L7Qv9C+0Log0JzQvtC50KHQutC70LDQtCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGxvYWRNc1F1aWNrUGFuZWxFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdtc1F1aWNrUGFuZWxfdjEnKSkgPT09ICdmYWxzZScpIG1zUXVpY2tQYW5lbEVuYWJsZWQgPSBmYWxzZTtcbiAgICB9IGNhdGNoIHsgLyog0L/QviDRg9C80L7Qu9GH0LDQvdC40Y4g0LLQutC70Y7Rh9C10L3QsCAqLyB9XG59XG5cbmZ1bmN0aW9uIHNhdmVNc1F1aWNrUGFuZWxFbmFibGVkKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ21zUXVpY2tQYW5lbF92MScpLCBTdHJpbmcobXNRdWlja1BhbmVsRW5hYmxlZCkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L3QsNGB0YLRgNC+0LnQutGDINC/0LDQvdC10LvQuCDQsdGL0YHRgtGA0YvRhSDQutC90L7Qv9C+0LonLCBlcnJvcik7XG4gICAgfVxufVxuXG4vLyDQn9C+0LfQuNGG0LjRjyDQv9C70LDQstCw0Y7RidC40YUg0L7QutC+0L0gKNGA0LDRgdC/0LjRgdCw0L3QuNC1LCDQvdCw0YHRgtGA0L7QudC60LgsINCl0LDQutC10YApIOKAlCDQvtCx0YnQsNGPINC4INC/0LXRgNC10LbQuNCy0LDQtdGCINGB0LXRgdGB0LjQuC5cbmZ1bmN0aW9uIGxvYWRGbG9hdFdpbmRvd1BvcygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdmbG9hdFdpbmRvd1Bvc192MScpKSB8fCAnbnVsbCcpO1xuICAgICAgICByZXR1cm4gKHAgJiYgdHlwZW9mIHAubGVmdCA9PT0gJ251bWJlcicgJiYgdHlwZW9mIHAudG9wID09PSAnbnVtYmVyJykgPyBwIDogbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBzYXZlRmxvYXRXaW5kb3dQb3MobGVmdCwgdG9wKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnZmxvYXRXaW5kb3dQb3NfdjEnKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgbGVmdDogcGFyc2VJbnQobGVmdCwgMTApLFxuICAgICAgICAgICAgdG9wOiBwYXJzZUludCh0b3AsIDEwKVxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQv9C+0LfQuNGG0LjRjiDQvtC60L3QsCcsIGVycm9yKTtcbiAgICB9XG59XG5cbi8vINCh0LHRgNC+0YEg0L/QvtC30LjRhtC40Lgg0L/Qu9Cw0LLQsNGO0YnQuNGFINC+0LrQvtC9ICjQtdGB0LvQuCDQvtC60L3QviDCq9GD0LXRhdCw0LvQvsK7INC30LAg0L/RgNC10LTQtdC70Ysg0Y3QutGA0LDQvdCwKS5cbmZ1bmN0aW9uIHJlc2V0RmxvYXRXaW5kb3dQb3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oc3RvcmFnZUtleSgnZmxvYXRXaW5kb3dQb3NfdjEnKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0LHRgNC+0YHQuNGC0Ywg0L/QvtC30LjRhtC40Y4g0L7QutC90LAnLCBlcnJvcik7XG4gICAgfVxufVxuXG4vLyDilIDilIDilIAg0J/QtdGA0YHQuNGB0YIg0LjRgdGC0L7RgNC40Lgg0YfQsNGC0LAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQktC60LvQsNC00LrRgyDCq9CR0L7QvdGD0YHRi8K7ICjQvdC+0LzQtdGA0LAg0YLQtdC70LXRhNC+0L3QvtCyINC60LvQuNC10L3RgtC+0LIsINCf0JTQvSkg0J3QlSDQv9C10YDRgdC40YHRgtC40LwuXG5jb25zdCBISVNUT1JZX1NUT1JBR0VfS0VZID0gJ2NoYXRIaXN0b3J5X3YxJztcbmNvbnN0IEhJU1RPUllfTUFYX1BFUl9UQUIgPSAxMDA7XG5cbmZ1bmN0aW9uIHNhdmVDaGF0SGlzdG9yeSgpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYWZlID0ge307XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKGNoYXRIaXN0b3J5QnlBY3Rpb24pLmZvckVhY2goKFthY3Rpb24sIGVudHJpZXNdKSA9PiB7XG4gICAgICAgICAgICBpZiAoYWN0aW9uID09PSAnY2hlY2tIYXRpa29Cb251c2VzJykgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGVudHJpZXMpKSByZXR1cm47XG4gICAgICAgICAgICBzYWZlW2FjdGlvbl0gPSBlbnRyaWVzLnNsaWNlKC1ISVNUT1JZX01BWF9QRVJfVEFCKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoSElTVE9SWV9TVE9SQUdFX0tFWSksIEpTT04uc3RyaW5naWZ5KHNhZmUpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdzdG9yYWdlJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC40YHRgtC+0YDQuNGOJywgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gbG9hZENoYXRIaXN0b3J5KCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoSElTVE9SWV9TVE9SQUdFX0tFWSkpO1xuICAgICAgICBpZiAoIXJhdykgcmV0dXJuO1xuICAgICAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSByZXR1cm47XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKHNhdmVkKS5mb3JFYWNoKChbYWN0aW9uLCBlbnRyaWVzXSkgPT4ge1xuICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ2NoZWNrSGF0aWtvQm9udXNlcycpIHJldHVybjsgLy8g0J/QlNC9IOKAlCDQvdC1INCy0L7RgdGB0YLQsNC90LDQstC70LjQstCw0LXQvFxuICAgICAgICAgICAgaWYgKCFNT0RFX0FDVElPTlMuaW5jbHVkZXMoYWN0aW9uKSkgcmV0dXJuOyAgLy8g0YLQvtC70YzQutC+INGA0LXQttC40LzQvdGL0LUg0LLQutC70LDQtNC60LhcbiAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShlbnRyaWVzKSkgcmV0dXJuO1xuICAgICAgICAgICAgY2hhdEhpc3RvcnlCeUFjdGlvblthY3Rpb25dID0gZW50cmllc1xuICAgICAgICAgICAgICAgIC5maWx0ZXIoZSA9PiBlICYmIHR5cGVvZiBlLm1lc3NhZ2UgPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgICAgIC5zbGljZSgtSElTVE9SWV9NQVhfUEVSX1RBQik7XG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDQt9Cw0LPRgNGD0LfQuNGC0Ywg0LjRgdGC0L7RgNC40Y4nLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBwYW5lbENzcmZTdG9yYWdlS2V5KCkge1xuICAgIHJldHVybiBzdG9yYWdlS2V5KCdwYW5lbENzcmZfdjEnKTtcbn1cblxuY29uc3QgUEFORUxfQ1NSRl9UVExfTVMgPSAxMiAqIDYwICogMTAwMDsgLy8gMTIg0LzQuNC9OiBMYXJhdmVsLdGC0L7QutC10L3RiyDQttC40LLRg9GCINC90LXQtNC+0LvQs9C+LCDRgNC10YTRgNC10YjQuNC8INC30LDRgNCw0L3QtdC1XG5cbmZ1bmN0aW9uIG9wZW5QYW5lbEluQmFja2dyb3VuZCgpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnBhbmVsKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdyA9IHdpbmRvdy5vcGVuKCdodHRwczovL3BhbmVsLmhhdGlrby5ydS8nLCAnX2JsYW5rJyk7XG4gICAgICAgIGlmICh3KSB3LmJsdXIoKTtcbiAgICB9IGNhdGNoIChlKSB7IGRlYnVnRXJyb3IoJ3BhbmVsLWF1dGgnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDQvtGC0LrRgNGL0YLRjCDQv9Cw0L3QtdC70YwnLCBlKTsgfVxufVxuXG5mdW5jdGlvbiBsb2FkUGFuZWxDc3JmKCkge1xuICAgIGlmIChtZW1jaGF0UGxhdGZvcm0ucGFuZWwpIHJldHVybiAnJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0ocGFuZWxDc3JmU3RvcmFnZUtleSgpKSB8fCAnbnVsbCcpO1xuICAgICAgICBpZiAoIXNhdmVkPy50b2tlbiB8fCAhc2F2ZWQ/LnNhdmVkQXQgfHwgRGF0ZS5ub3coKSAtIHNhdmVkLnNhdmVkQXQgPiBQQU5FTF9DU1JGX1RUTF9NUykgcmV0dXJuICcnO1xuICAgICAgICByZXR1cm4gc2F2ZWQudG9rZW47XG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxufVxuXG5mdW5jdGlvbiBzYXZlUGFuZWxDc3JmKHRva2VuKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5wYW5lbCkgcmV0dXJuO1xuICAgIGlmICghdG9rZW4pIHJldHVybjtcbiAgICB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShwYW5lbENzcmZTdG9yYWdlS2V5KCksIEpTT04uc3RyaW5naWZ5KHsgdG9rZW4sIHNhdmVkQXQ6IERhdGUubm93KCkgfSkpOyB9XG4gICAgY2F0Y2ggKGVycm9yKSB7IGRlYnVnRXJyb3IoJ3N0b3JhZ2UnLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0YwgQ1NSRiBQYW5lbCcsIGVycm9yKTsgfVxufVxuXG5mdW5jdGlvbiBjbGVhclBhbmVsQ3NyZigpIHtcbiAgICB0cnkgeyBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShwYW5lbENzcmZTdG9yYWdlS2V5KCkpOyB9IGNhdGNoIHsgLyogc3RvcmFnZSB1bmF2YWlsYWJsZSAqLyB9XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hQYW5lbENzcmYob25TdWNjZXNzLCBvbkVycm9yLCBhdHRlbXB0cyA9IDIpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnBhbmVsKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLnBhbmVsLmVuc3VyZShvblN1Y2Nlc3MsIG9uRXJyb3IsIHRydWUpO1xuICAgIGNvbnN0IGF0dGVtcHRGZXRjaCA9IChsZWZ0KSA9PiB7XG4gICAgICAgIHBhbmVsUmVxdWVzdChgL3NlYXJjaD9fPSR7RGF0ZS5ub3coKX1gLCB7fSwgcmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgY29uc3QgdG9rZW4gPSBwYXJzZVBhbmVsQ3NyZihyZXNwb25zZS5yZXNwb25zZVRleHQpO1xuICAgICAgICAgICAgaWYgKCF0b2tlbikge1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0ID4gMCkgeyBzZXRUaW1lb3V0KCgpID0+IGF0dGVtcHRGZXRjaChsZWZ0IC0gMSksIDkwMCk7IHJldHVybjsgfVxuICAgICAgICAgICAgICAgIGNsZWFyUGFuZWxDc3JmKCk7XG4gICAgICAgICAgICAgICAgb25FcnJvcj8uKG5ldyBFcnJvcignUGFuZWw6INC90LXRgiDQsNCy0YLQvtGA0LjQt9Cw0YbQuNC4LiDQktC+0LnQtNC40YLQtSDQsiBwYW5lbC5oYXRpa28ucnUuJykpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNhdmVQYW5lbENzcmYodG9rZW4pO1xuICAgICAgICAgICAgZGVidWdMb2coJ3BhbmVsLWNzcmYnLCAn0L7QsdC90L7QstC70ZHQvScpO1xuICAgICAgICAgICAgb25TdWNjZXNzPy4odG9rZW4pO1xuICAgICAgICB9LCBlcnJvciA9PiB7XG4gICAgICAgICAgICBpZiAobGVmdCA+IDApIHsgc2V0VGltZW91dCgoKSA9PiBhdHRlbXB0RmV0Y2gobGVmdCAtIDEpLCA5MDApOyByZXR1cm47IH1cbiAgICAgICAgICAgIG9uRXJyb3I/LihlcnJvcik7XG4gICAgICAgIH0pO1xuICAgIH07XG4gICAgYXR0ZW1wdEZldGNoKE1hdGgubWF4KDEsIGF0dGVtcHRzKSk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVBhbmVsQ3NyZihvblN1Y2Nlc3MsIG9uRXJyb3IsIGZvcmNlID0gZmFsc2UpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnBhbmVsKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLnBhbmVsLmVuc3VyZShvblN1Y2Nlc3MsIG9uRXJyb3IsIGZvcmNlID09PSB0cnVlKTtcbiAgICBpZiAoZm9yY2UpIHsgcmVmcmVzaFBhbmVsQ3NyZihvblN1Y2Nlc3MsIG9uRXJyb3IpOyByZXR1cm47IH1cbiAgICBjb25zdCBjYWNoZWQgPSBsb2FkUGFuZWxDc3JmKCk7XG4gICAgaWYgKGNhY2hlZCkgeyBvblN1Y2Nlc3MoY2FjaGVkKTsgcmV0dXJuOyB9XG4gICAgcmVmcmVzaFBhbmVsQ3NyZihvblN1Y2Nlc3MsIGVycm9yID0+IHtcbiAgICAgICAgb3BlblBhbmVsSW5CYWNrZ3JvdW5kKCk7XG4gICAgICAgIG9uRXJyb3I/LihlcnJvcik7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHBhbmVsUmVxdWVzdChwYXRoLCBvcHRpb25zLCBvblN1Y2Nlc3MsIG9uRXJyb3IpIHtcbiAgICBHTV94bWxodHRwUmVxdWVzdCh7XG4gICAgICAgIG1ldGhvZDogb3B0aW9ucz8ubWV0aG9kIHx8ICdHRVQnLFxuICAgICAgICB1cmw6IGBodHRwczovL3BhbmVsLmhhdGlrby5ydSR7cGF0aH1gLFxuICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uLCB0ZXh0L2h0bWw7cT0wLjknLFxuICAgICAgICAgICAgUmVmZXJlcjogJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1L3NlYXJjaCcsXG4gICAgICAgICAgICBPcmlnaW46ICdodHRwczovL3BhbmVsLmhhdGlrby5ydScsXG4gICAgICAgICAgICAnVXNlci1BZ2VudCc6IHR5cGVvZiBuYXZpZ2F0b3IgIT09ICd1bmRlZmluZWQnID8gbmF2aWdhdG9yLnVzZXJBZ2VudCA6ICdNb3ppbGxhLzUuMCcsXG4gICAgICAgICAgICAnWC1SZXF1ZXN0ZWQtV2l0aCc6ICdYTUxIdHRwUmVxdWVzdCcsXG4gICAgICAgICAgICAuLi4ob3B0aW9ucz8uaGVhZGVycyB8fCB7fSlcbiAgICAgICAgfSxcbiAgICAgICAgZGF0YTogb3B0aW9ucz8uZGF0YSxcbiAgICAgICAgdGltZW91dDogMzAwMDAsXG4gICAgICAgIGFub255bW91czogZmFsc2UsXG4gICAgICAgIG9ubG9hZDogcmVzcG9uc2UgPT4ge1xuICAgICAgICAgICAgY29uc3QgY29udGVudFR5cGUgPSByZXNwb25zZS5yZXNwb25zZUhlYWRlcnM/Lm1hdGNoKC9jb250ZW50LXR5cGU6XFxzKihbXlxcclxcbl0rKS9pKT8uWzFdIHx8ICcnO1xuICAgICAgICAgICAgY29uc3QgcmF3ID0gcmVzcG9uc2UucmVzcG9uc2VUZXh0IHx8ICcnO1xuICAgICAgICAgICAgY29uc3QgaXNIdG1sID0gL15cXHMqPGh0bWwvaS50ZXN0KHJhdykgfHwgL25vaW5kZXgsIG5vYXJjaGl2ZXxhamF4bG9hZFxcLmluZm98Z29yaXpvbnRhbC12ZXJ0aWthbC9pLnRlc3QocmF3KTtcbiAgICAgICAgICAgIGRlYnVnTG9nKCdwYW5lbC1yZXNwb25zZScsIHsgcGF0aCwgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsIGNvbnRlbnRUeXBlLCBpc0h0bWwgfSk7XG4gICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID49IDIwMCAmJiByZXNwb25zZS5zdGF0dXMgPCAzMDAgJiYgIWlzSHRtbCkge1xuICAgICAgICAgICAgICAgIG9uU3VjY2VzcyhyZXNwb25zZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGlzSHRtbCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGxvZ2luID0gL1xcL2xvZ2lufNCy0YXQvtC0fNCw0LLRgtC+0YDQuNC30LDRhi9pLnRlc3QocmF3KTtcbiAgICAgICAgICAgICAgICBvbkVycm9yKG5ldyBFcnJvcihsb2dpblxuICAgICAgICAgICAgICAgICAgICA/ICdQYW5lbDog0L3QtdGCINCw0LLRgtC+0YDQuNC30LDRhtC40LguINCS0L7QudC00LjRgtC1INCyIHBhbmVsLmhhdGlrby5ydS4nXG4gICAgICAgICAgICAgICAgICAgIDogJ1BhbmVsOiDQstC10YDQvdGD0LvQsCBIVE1MINCy0LzQtdGB0YLQviBKU09OLiDQn9GA0L7QstC10YDRjCDQsNCy0YLQvtGA0LjQt9Cw0YbQuNGOIFBhbmVsLicpLCByZXNwb25zZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9uRXJyb3IobmV3IEVycm9yKGBQYW5lbCBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfWApLCByZXNwb25zZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIG9udGltZW91dDogKCkgPT4gb25FcnJvcihuZXcgRXJyb3IoJ1BhbmVsOiDRgtCw0LnQvNCw0YPRgiDQt9Cw0L/RgNC+0YHQsCcpKSxcbiAgICAgICAgb25lcnJvcjogZXJyb3IgPT4gb25FcnJvcihuZXcgRXJyb3IoYFBhbmVsOiDQvtGI0LjQsdC60LAg0YHQtdGC0LggJHtlcnJvcn1gKSlcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQYW5lbENzcmYoaHRtbCkge1xuICAgIGNvbnN0IG1ldGEgPSBodG1sLm1hdGNoKC88bWV0YVxcYltePl0qbmFtZT1bXCInXWNzcmYtdG9rZW5bXCInXVtePl0qY29udGVudD1bXCInXShbXlwiJ10rKVtcIiddL2kpO1xuICAgIGlmIChtZXRhKSByZXR1cm4gbWV0YVsxXTtcbiAgICBjb25zdCBpbnB1dCA9IGh0bWwubWF0Y2goLzxpbnB1dFxcYltePl0qbmFtZT1bXCInXV90b2tlbltcIiddW14+XSp2YWx1ZT1bXCInXShbXlwiJ10rKVtcIiddL2kpO1xuICAgIHJldHVybiBpbnB1dCA/IGlucHV0WzFdIDogJyc7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGFuZWxKc29uKHJlc3BvbnNlKSB7XG4gICAgY29uc3QgcmF3ID0gU3RyaW5nKHJlc3BvbnNlLnJlc3BvbnNlVGV4dCB8fCByZXNwb25zZS5yZXNwb25zZSB8fCAnJylcbiAgICAgICAgLnJlcGxhY2UoL15cXHVGRUZGLywgJycpXG4gICAgICAgIC50cmltKCk7XG4gICAgaWYgKCFyYXcpIHRocm93IG5ldyBFcnJvcignUGFuZWw6INC/0YPRgdGC0L7QuSDQvtGC0LLQtdGCJyk7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdwYW5lbC1qc29uJywge1xuICAgICAgICAgICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgICAgICBjb250ZW50VHlwZTogcmVzcG9uc2UucmVzcG9uc2VIZWFkZXJzPy5tYXRjaCgvY29udGVudC10eXBlOlxccyooW15cXFxcclxcXFxuXSspL2kpPy5bMV0gfHwgJycsXG4gICAgICAgICAgICBwcmV2aWV3OiByYXcuc2xpY2UoMCwgMTYwKVxuICAgICAgICB9KTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQYW5lbDog0L3QtdC60L7RgNGA0LXQutGC0L3Ri9C5IEpTT04t0L7RgtCy0LXRgicpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gcGFuZWxTZWFyY2gocXVlcnksIG9uU3VjY2Vzcywgb25FcnJvcikge1xuICAgIGNvbnN0IGF0dGVtcHQgPSAoY3NyZiwgcmV0cmllZCkgPT4gcGFuZWxSZXF1ZXN0KCcvYXBpL3NlYXJjaCcsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJywgJ1gtQ1NSRi1UT0tFTic6IGNzcmYgfSxcbiAgICAgICAgZGF0YTogSlNPTi5zdHJpbmdpZnkoeyBzZWFyY2hfdHlwZTogJ2FydGljbGUnLCBxdWVyeTogU3RyaW5nKHF1ZXJ5KS50cmltKCksIGNpdGllc19maWx0ZXI6IFtdLCBzdG9yZXNfZmlsdGVyOiBbXSwgc2hvd19leHRlcm5hbF9jb2RlOiB0cnVlIH0pXG4gICAgfSwgcmVzcG9uc2UgPT4ge1xuICAgICAgICB0cnkgeyBvblN1Y2Nlc3MocGFyc2VQYW5lbEpzb24ocmVzcG9uc2UpKTsgfVxuICAgICAgICBjYXRjaCAoZXJyb3IpIHsgb25FcnJvcihlcnJvcik7IH1cbiAgICB9LCAoZXJyb3IsIHJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGlmICgocmVzcG9uc2U/LnN0YXR1cyA9PT0gNDE5IHx8IHJlc3BvbnNlPy5zdGF0dXMgPT09IDQwMSB8fCByZXNwb25zZT8uc3RhdHVzID09PSA0MDMpICYmICFyZXRyaWVkKSB7XG4gICAgICAgICAgICBjbGVhclBhbmVsQ3NyZigpO1xuICAgICAgICAgICAgcmVmcmVzaFBhbmVsQ3NyZihuZXdDc3JmID0+IGF0dGVtcHQobmV3Q3NyZiwgdHJ1ZSksICgpID0+IHtcbiAgICAgICAgICAgICAgICBvcGVuUGFuZWxJbkJhY2tncm91bmQoKTtcbiAgICAgICAgICAgICAgICBvbkVycm9yKG5ldyBFcnJvcignUGFuZWw6INCw0LLRgtC+0YDQuNC30LDRhtC40Y8g0LjRgdGC0LXQutC70LAuINCS0L7QudC00LjRgtC1INCyIHBhbmVsLmhhdGlrby5ydS4nKSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBvbkVycm9yKGVycm9yKTtcbiAgICB9KTtcbiAgICBlbnN1cmVQYW5lbENzcmYoY3NyZiA9PiBhdHRlbXB0KGNzcmYsIGZhbHNlKSwgb25FcnJvcik7XG59XG5cbmZ1bmN0aW9uIHBhbmVsQ2hlY2tCb251c2VzKHBob25lLCBvblN1Y2Nlc3MsIG9uRXJyb3IpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHBob25lIHx8ICcnKS5yZXBsYWNlKC9cXEQvZywgJycpO1xuICAgIGlmICghbm9ybWFsaXplZCkge1xuICAgICAgICBvbkVycm9yKG5ldyBFcnJvcignUGFuZWw6INCy0LLQtdC00LjRgtC1INC90L7QvNC10YAg0YLQtdC70LXRhNC+0L3QsCcpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBhdHRlbXB0ID0gKGNzcmYsIHJldHJpZWQpID0+IHBhbmVsUmVxdWVzdChgL2FwaS9ib251c2VzL2NoZWNrLyR7ZW5jb2RlVVJJQ29tcG9uZW50KE51bWJlcihub3JtYWxpemVkKSl9YCwge1xuICAgICAgICBoZWFkZXJzOiB7ICdYLUNTUkYtVE9LRU4nOiBjc3JmIH1cbiAgICB9LCByZXNwb25zZSA9PiB7XG4gICAgICAgIHRyeSB7IG9uU3VjY2VzcyhwYXJzZVBhbmVsSnNvbihyZXNwb25zZSkpOyB9XG4gICAgICAgIGNhdGNoIChlcnJvcikgeyBvbkVycm9yKGVycm9yKTsgfVxuICAgIH0sIChlcnJvciwgcmVzcG9uc2UpID0+IHtcbiAgICAgICAgaWYgKChyZXNwb25zZT8uc3RhdHVzID09PSA0MTkgfHwgcmVzcG9uc2U/LnN0YXR1cyA9PT0gNDAxIHx8IHJlc3BvbnNlPy5zdGF0dXMgPT09IDQwMykgJiYgIXJldHJpZWQpIHtcbiAgICAgICAgICAgIGNsZWFyUGFuZWxDc3JmKCk7XG4gICAgICAgICAgICByZWZyZXNoUGFuZWxDc3JmKG5ld0NzcmYgPT4gYXR0ZW1wdChuZXdDc3JmLCB0cnVlKSwgKCkgPT4ge1xuICAgICAgICAgICAgICAgIG9wZW5QYW5lbEluQmFja2dyb3VuZCgpO1xuICAgICAgICAgICAgICAgIG9uRXJyb3IobmV3IEVycm9yKCdQYW5lbDog0LDQstGC0L7RgNC40LfQsNGG0LjRjyDQuNGB0YLQtdC60LvQsC4g0JLQvtC50LTQuNGC0LUg0LIgcGFuZWwuaGF0aWtvLnJ1LicpKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIG9uRXJyb3IoZXJyb3IpO1xuICAgIH0pO1xuICAgIGVuc3VyZVBhbmVsQ3NyZihjc3JmID0+IGF0dGVtcHQoY3NyZiwgZmFsc2UpLCBvbkVycm9yKTtcbn1cblxuLy8g4pSA4pSA4pSAINCS0YHQv9C+0LzQvtCz0LDRgtC10LvRjNC90YvQtSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGZldGNoU2VydmVyRGF0YSh1cmwsIG9uU3VjY2Vzcywgb25FcnJvcikge1xuICAgIGRlYnVnTG9nKCdyZXF1ZXN0JywgJ0dFVCcsIHVybCk7XG4gICAgR01feG1saHR0cFJlcXVlc3Qoe1xuICAgICAgICBtZXRob2Q6ICdHRVQnLFxuICAgICAgICB1cmwsXG4gICAgICAgIG9ubG9hZDogIHIgPT4ge1xuICAgICAgICAgICAgZGVidWdMb2coJ3Jlc3BvbnNlJywgci5zdGF0dXMsIHVybCk7XG4gICAgICAgICAgICByLnN0YXR1cyA9PT0gMjAwID8gb25TdWNjZXNzKHIpIDogb25FcnJvcihg0J7RiNC40LHQutCwOiAke3Iuc3RhdHVzVGV4dH1gKTtcbiAgICAgICAgfSxcbiAgICAgICAgb25lcnJvcjogZSA9PiB7XG4gICAgICAgICAgICBkZWJ1Z0Vycm9yKCdyZXF1ZXN0JywgdXJsLCBlKTtcbiAgICAgICAgICAgIG9uRXJyb3IoYNCe0YjQuNCx0LrQsCDQt9Cw0L/RgNC+0YHQsDogJHtlfWApO1xuICAgICAgICB9XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGFwcGx5UnVsZShjYXNoLCBydWxlKSB7XG4gICAgaWYgKHJ1bGUuaXNDYXNoYmFjaykgcmV0dXJuIE1hdGgucm91bmQoY2FzaCAqIHJ1bGUucGVyY2VudCAvIDEwMCk7XG4gICAgY29uc3Qgcm91bmRlZCA9IE1hdGgucm91bmQoY2FzaCAqIHJ1bGUucGVyY2VudCAvIDEwMCAvIHJ1bGUucm91bmQpICogcnVsZS5yb3VuZDtcbiAgICByZXR1cm4gcm91bmRlZCArIChydWxlLmV4dHJhIHx8IDApO1xufVxuXG4iLCIvLyDilIDilIDilIAgYWRkVG9DaGF0SGlzdG9yeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIHNlbmRlcjogdXNlciB8IGJvdCB8IHN5c3RlbTsgcXVlcnkg4oCUINGC0LXQutGB0YIg0LfQsNC/0YDQvtGB0LAgKNC00LvRjyDQutC90L7Qv9C60LggwqvQv9C+0LLRgtC+0YDQuNGC0YzCuykuXG5mdW5jdGlvbiBhZGRUb0NoYXRIaXN0b3J5KHNlbmRlciwgbWVzc2FnZSwgZW1vamkgPSAnJywgcXVlcnkpIHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCdydS1SVScsIHsgaG91cjogJzItZGlnaXQnLCBtaW51dGU6ICcyLWRpZ2l0JyB9KTtcbiAgICBjb25zdCBlbnRyeSA9IHsgc2VuZGVyLCBtZXNzYWdlLCBlbW9qaSwgdGltZXN0YW1wOiB0cywgYWN0aW9uOiBjdXJyZW50QWN0aW9uLCBxdWVyeTogcXVlcnkgfHwgJycgfTtcbiAgICBjb25zdCBoaXN0b3J5ID0gaGlzdG9yeUZvcihjdXJyZW50QWN0aW9uKTtcbiAgICBoaXN0b3J5LnB1c2goZW50cnkpO1xuICAgIGlmIChoaXN0b3J5Lmxlbmd0aCA+IDEwMCkgaGlzdG9yeS5zcGxpY2UoMCwgaGlzdG9yeS5sZW5ndGggLSAxMDApOyAvLyDQu9C40LzQuNGCINC90LAg0LLQutC70LDQtNC60YNcbiAgICBpZiAod2luZG93LnByaWNlQ2hlY2tDb250YWluZXIpIHJlbmRlckNoYXQoKTtcbiAgICBzYXZlQ2hhdEhpc3RvcnkoKTsgLy8g0L/QtdGA0YHQuNGB0YIgKNC60YDQvtC80LUg0LLQutC70LDQtNC60LggwqvQkdC+0L3Rg9GB0YvCuyDigJQg0J/QlNC9KVxuICAgIGlmIChzZW5kZXIgPT09ICd1c2VyJyAmJiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJUZXh0Q2hlY2tib3gnKT8uY2hlY2tlZCkge1xuICAgICAgICBjb25zdCBtcyA9IGNsZWFyVGV4dERlbGF5O1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHsgY29uc3QgaW5wID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpOyBpZiAoaW5wKSBpbnAudmFsdWUgPSAnJzsgfSwgbXMpO1xuICAgIH1cbn1cblxuLy8g4pSA4pSA4pSAINCg0LXQvdC00LXRgCDQu9C10L3RgtGLINCw0LrRgtC40LLQvdC+0Lkg0LLQutC70LDQtNC60Lgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiByZW5kZXJDaGF0KCkge1xuICAgIGNvbnN0IGxvZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0NoYXRMb2cnKTtcbiAgICBpZiAoIWxvZykgcmV0dXJuO1xuICAgIGxvZy5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBjb25zdCBlbnRyaWVzID0gY2hhdEhpc3RvcnlCeUFjdGlvbltjdXJyZW50QWN0aW9uXSB8fCBbXTtcbiAgICBlbnRyaWVzLmZvckVhY2goZW50cnkgPT4gbG9nLmFwcGVuZENoaWxkKHJlbmRlck1lc3NhZ2VCdWJibGUoZW50cnkpKSk7XG4gICAgbG9nLnNjcm9sbFRvcCA9IGxvZy5zY3JvbGxIZWlnaHQ7XG59XG5cbmZ1bmN0aW9uIHJlbmRlck1lc3NhZ2VCdWJibGUoZW50cnkpIHtcbiAgICBjb25zdCBidWJibGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBidWJibGUuY2xhc3NOYW1lID0gYG1jLW1zZyBtYy1tc2ctJHtlbnRyeS5zZW5kZXJ9YDtcblxuICAgIGlmIChlbnRyeS5zZW5kZXIgPT09ICdzeXN0ZW0nKSB7XG4gICAgICAgIGJ1YmJsZS50ZXh0Q29udGVudCA9IGAke2VudHJ5LmVtb2ppID8gZW50cnkuZW1vamkgKyAnICcgOiAnJ30ke2VudHJ5Lm1lc3NhZ2V9YDtcbiAgICAgICAgcmV0dXJuIGJ1YmJsZTtcbiAgICB9XG5cbiAgICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbWV0YS5jbGFzc05hbWUgPSAnbWMtbXNnLW1ldGEnO1xuICAgIG1ldGEudGV4dENvbnRlbnQgPSBgJHtlbnRyeS5lbW9qaSA/IGVudHJ5LmVtb2ppICsgJyAnIDogJyd9JHtlbnRyeS50aW1lc3RhbXB9YDtcbiAgICBidWJibGUuYXBwZW5kQ2hpbGQobWV0YSk7XG5cbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm9keS5jbGFzc05hbWUgPSAnbWMtbXNnLWJvZHknO1xuICAgIGJvZHkudGV4dENvbnRlbnQgPSBlbnRyeS5tZXNzYWdlOyAgICAgIC8vIHRleHRDb250ZW50IOKAlCDQt9Cw0YnQuNGC0LAg0L7RgiBIVE1MXG4gICAgYnViYmxlLmFwcGVuZENoaWxkKGJvZHkpO1xuXG4gICAgaWYgKGVudHJ5LnNlbmRlciA9PT0gJ2JvdCcpIHtcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBhY3Rpb25zLmNsYXNzTmFtZSA9ICdtYy1tc2ctYWN0aW9ucyc7XG5cbiAgICAgICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBjb3B5LnR5cGUgPSAnYnV0dG9uJztcbiAgICAgICAgY29weS5jbGFzc05hbWUgPSAnbWMtY29weS1idG4nO1xuICAgICAgICBjb3B5LmRhdGFzZXQuY29weSA9IGVudHJ5Lm1lc3NhZ2U7IC8vINGC0LXQutGB0YIg0LTQu9GPINC60L7Qv9C40YDQvtCy0LDQvdC40Y9cbiAgICAgICAgY29weS5kYXRhc2V0LnRpcCA9ICfwn5OLINCa0L7Qv9C40YDQvtCy0LDRgtGMJztcbiAgICAgICAgY29weS50ZXh0Q29udGVudCA9ICfwn5OLJztcbiAgICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb3B5KTtcblxuICAgICAgICAvLyDQn9C+0LLRgtC+0YDQuNGC0Ywg0LfQsNC/0YDQvtGBICjQtdGB0LvQuCDQuNC30LLQtdGB0YLQtdC9INC40YHRhdC+0LTQvdGL0Lkg0LfQsNC/0YDQvtGBINC4INGN0YLQviDRgNC10LbQuNC80L3QsNGPINCy0LrQu9Cw0LTQutCwKVxuICAgICAgICBpZiAoZW50cnkuYWN0aW9uICYmIE1PREVfQUNUSU9OUy5pbmNsdWRlcyhlbnRyeS5hY3Rpb24pICYmIGVudHJ5LnF1ZXJ5KSB7XG4gICAgICAgICAgICBjb25zdCByZXRyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICAgICAgcmV0cnkudHlwZSA9ICdidXR0b24nO1xuICAgICAgICAgICAgcmV0cnkuY2xhc3NOYW1lID0gJ21jLXJldHJ5LWJ0bic7XG4gICAgICAgICAgICByZXRyeS5kYXRhc2V0LnRpcCA9ICfwn5SBINCf0L7QstGC0L7RgNC40YLRjCDQt9Cw0L/RgNC+0YEnO1xuICAgICAgICAgICAgcmV0cnkudGV4dENvbnRlbnQgPSAn8J+UgSc7XG4gICAgICAgICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHJldHJ5KTtcbiAgICAgICAgfVxuICAgICAgICBidWJibGUuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gICAgfVxuICAgIHJldHVybiBidWJibGU7XG59XG5cbi8vINCU0LXQu9C10LPQuNGA0L7QstCw0L3QvdGL0Lkg0LrQu9C40Log0L/QviDQutC90L7Qv9C60LDQvCDCq9Ca0L7Qv9C40YDQvtCy0LDRgtGMwrsgLyDCq9Cf0L7QstGC0L7RgNC40YLRjMK7INCyINC70LXQvdGC0LUuXG5mdW5jdGlvbiByZW1vdmVSZXRyeUVudHJ5KGVudHJ5KSB7XG4gICAgY29uc3QgaGlzdG9yeSA9IGNoYXRIaXN0b3J5QnlBY3Rpb25bY3VycmVudEFjdGlvbl0gfHwgW107XG4gICAgY29uc3QgaW5kZXggPSBoaXN0b3J5LmluZGV4T2YoZW50cnkpO1xuICAgIGlmIChpbmRleCA8IDApIHJldHVybjtcblxuICAgIC8vINCSINGA0LXQttC40LzQtSDQt9Cw0LzQtdC90Ysg0YPQsdC40YDQsNC10Lwg0L7RgtCy0LXRgiDQuCDQtdCz0L4g0LjRgdGF0L7QtNC90YvQuSDQt9Cw0L/RgNC+0YEsINGH0YLQvtCx0Ysg0L3QvtCy0YvQuSDQt9Cw0L/Rg9GB0LpcbiAgICAvLyDQvdC1INC+0YHRgtCw0LLQu9GP0Lsg0LIg0LvQtdC90YLQtSDQu9C40YjQvdGO0Y4g0L/QsNGA0YMgdXNlci9ib3QuXG4gICAgaGlzdG9yeS5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIGNvbnN0IHByZXZpb3VzID0gaGlzdG9yeVtpbmRleCAtIDFdO1xuICAgIGlmIChwcmV2aW91cz8uc2VuZGVyID09PSAndXNlcicgJiYgcHJldmlvdXMubWVzc2FnZSA9PT0gZW50cnkucXVlcnkpIGhpc3Rvcnkuc3BsaWNlKGluZGV4IC0gMSwgMSk7XG4gICAgcmVuZGVyQ2hhdCgpO1xuICAgIHNhdmVDaGF0SGlzdG9yeSgpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVDaGF0TG9nQ2xpY2soZXZlbnQpIHtcbiAgICBjb25zdCBjb3B5QnRuID0gZXZlbnQudGFyZ2V0LmNsb3Nlc3QoJy5tYy1jb3B5LWJ0bicpO1xuICAgIGlmIChjb3B5QnRuKSB7XG4gICAgICAgIGNvcHlIYXRpa29UZXh0KGNvcHlCdG4uZGF0YXNldC5jb3B5IHx8ICcnKTtcbiAgICAgICAgY29weUJ0bi50ZXh0Q29udGVudCA9ICfinIUnO1xuICAgICAgICBjb3B5QnRuLmNsYXNzTGlzdC5hZGQoJ21jLWNvcHktZG9uZScpO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIGNvcHlCdG4udGV4dENvbnRlbnQgPSAn8J+Tiyc7XG4gICAgICAgICAgICBjb3B5QnRuLmNsYXNzTGlzdC5yZW1vdmUoJ21jLWNvcHktZG9uZScpO1xuICAgICAgICB9LCAxMjAwKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJldHJ5QnRuID0gZXZlbnQudGFyZ2V0LmNsb3Nlc3QoJy5tYy1yZXRyeS1idG4nKTtcbiAgICBpZiAoIXJldHJ5QnRuKSByZXR1cm47XG4gICAgY29uc3QgYnViYmxlID0gcmV0cnlCdG4uY2xvc2VzdCgnLm1jLW1zZycpO1xuICAgIGNvbnN0IGluZGV4ID0gQXJyYXkuZnJvbShidWJibGUucGFyZW50Tm9kZS5jaGlsZHJlbikuaW5kZXhPZihidWJibGUpO1xuICAgIGNvbnN0IGVudHJ5ID0gKGNoYXRIaXN0b3J5QnlBY3Rpb25bY3VycmVudEFjdGlvbl0gfHwgW10pW2luZGV4XTtcbiAgICBpZiAoIWVudHJ5KSByZXR1cm47XG5cbiAgICByZXRyeUJ0bi50ZXh0Q29udGVudCA9ICfinIUnO1xuICAgIHJldHJ5QnRuLmNsYXNzTGlzdC5hZGQoJ21jLWNvcHktZG9uZScpO1xuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZXRyeUJ0bi50ZXh0Q29udGVudCA9ICfwn5SBJztcbiAgICAgICAgcmV0cnlCdG4uY2xhc3NMaXN0LnJlbW92ZSgnbWMtY29weS1kb25lJyk7XG4gICAgfSwgMTIwMCk7XG5cbiAgICAvLyDQn9C+0LLRgtC+0YDRj9C10Lwg0YLQvtGCINC20LUg0LfQsNC/0YDQvtGBINCyINGC0L7QuSDQttC1INCy0LrQu9Cw0LTQutC1LlxuICAgIGlmIChjdXJyZW50QWN0aW9uICE9PSBlbnRyeS5hY3Rpb24pIHNlbGVjdFRhYihlbnRyeS5hY3Rpb24pO1xuICAgIGlmIChyZXRyeUJlaGF2aW9yID09PSAncmVwbGFjZScpIHJlbW92ZVJldHJ5RW50cnkoZW50cnkpO1xuICAgIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpO1xuICAgIGlmIChpbnB1dCkgaW5wdXQudmFsdWUgPSBlbnRyeS5xdWVyeTtcbiAgICBleGVjdXRlQ3VycmVudEFjdGlvbigpO1xufVxuXG5mdW5jdGlvbiBjbGVhckNoYXQoKSB7XG4gICAgLy8g0J7Rh9C40YnQsNC10YIg0YLQvtC70YzQutC+INC40YHRgtC+0YDQuNGOINCw0LrRgtC40LLQvdC+0Lkg0LLQutC70LDQtNC60LhcbiAgICBpZiAoY3VycmVudEFjdGlvbikgZGVsZXRlIGNoYXRIaXN0b3J5QnlBY3Rpb25bY3VycmVudEFjdGlvbl07XG4gICAgcmVuZGVyQ2hhdCgpO1xuICAgIHNhdmVDaGF0SGlzdG9yeSgpO1xufVxuXG5mdW5jdGlvbiBjbGVhclJlc3VsdEZvck5ld1JlcXVlc3QoKSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb0xpbmtzUGFuZWwnKT8ucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb0xpbmtzUGFuZWwnKT8uc3R5bGUuc2V0UHJvcGVydHkoJ2Rpc3BsYXknLCAnbm9uZScpO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYXRpa29SZW9wZW5QaWNrZXJCdXR0b24nKT8uc3R5bGUuc2V0UHJvcGVydHkoJ2Rpc3BsYXknLCAnbm9uZScpO1xufSIsIi8vIOKUgOKUgOKUgCBIQVRJS08g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog0J/QsNGA0YHQuNGCINGB0YLRgNCw0L3QuNGG0YMg0L/QvtC40YHQutCwIEhhdGlrby5cbiAqINCS0L7Qt9Cy0YDQsNGJ0LDQtdGCOiB7IHRpdGxlLCBhcnRpY2xlTm8sIHByaWNlLCBwcm9kdWN0VXJsIH1cbiAqL1xuZnVuY3Rpb24gcGFyc2VTZWFyY2hQYWdlKGh0bWwsIGJhc2VVcmwpIHtcbiAgICBjb25zdCBwYXJzZXIgPSBuZXcgRE9NUGFyc2VyKCk7XG4gICAgY29uc3QgZG9jID0gcGFyc2VyLnBhcnNlRnJvbVN0cmluZyhodG1sLCAndGV4dC9odG1sJyk7XG5cbiAgICBjb25zdCBwcm9kdWN0ID0gZG9jLnF1ZXJ5U2VsZWN0b3IoJ2Eucy1wcm9kdWN0LWhlYWRlcicpO1xuICAgIGlmICghcHJvZHVjdCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCB0aXRsZSAgICAgICAgPSAocHJvZHVjdC5nZXRBdHRyaWJ1dGUoJ3RpdGxlJykgfHwgcHJvZHVjdC50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpO1xuICAgIGNvbnN0IHJlbGF0aXZlTGluayA9IHByb2R1Y3QuZ2V0QXR0cmlidXRlKCdocmVmJykgfHwgJyc7XG5cbiAgICAvLyDQn9GD0YLRjCDRgtC+0LLQsNGA0LAg4oCUINC+0LTQuNC9INC4INGC0L7RgiDQttC1INC00LvRjyDQstGB0LXRhSDQs9C+0YDQvtC00L7Qsiwg0YLQvtC70YzQutC+INC00L7QvNC10L0g0LzQtdC90Y/QtdGC0YHRj1xuICAgIGNvbnN0IHBhdGhuYW1lICAgPSByZWxhdGl2ZUxpbmsgPyBuZXcgVVJMKHJlbGF0aXZlTGluaywgYmFzZVVybCkucGF0aG5hbWUgOiAnJztcbiAgICBjb25zdCBwcm9kdWN0VXJsID0gcGF0aG5hbWUgPyBgJHtiYXNlVXJsfSR7cGF0aG5hbWV9YCA6IGJhc2VVcmw7XG5cbiAgICAvLyDQptC10L3QsDog0LjRidC10Lwgc3Bhbi5wcmljZS13cmFwcGVyIHNwYW4ucHJpY2Ug0LjQu9C4INC/0YDQvtGB0YLQviBzcGFuLnByaWNlXG4gICAgY29uc3QgcHJpY2VFbCA9IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnByaWNlLXdyYXBwZXIgc3Bhbi5wcmljZScpXG4gICAgICAgICAgICAgICAgIHx8IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnByaWNlJyk7XG4gICAgY29uc3QgcHJpY2UgICA9IHByaWNlRWxcbiAgICAgICAgPyBwcmljZUVsLnRleHRDb250ZW50LnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCkgKyAnIOKCvSdcbiAgICAgICAgOiAn4oCUJztcblxuICAgIHJldHVybiB7IHRpdGxlLCBwcmljZSwgcHJvZHVjdFVybCwgcGF0aG5hbWUgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VTZWFyY2hSZXN1bHRzKGh0bWwsIGJhc2VVcmwpIHtcbiAgICBjb25zdCBwYXJzZXIgPSBuZXcgRE9NUGFyc2VyKCk7XG4gICAgY29uc3QgZG9jID0gcGFyc2VyLnBhcnNlRnJvbVN0cmluZyhodG1sLCAndGV4dC9odG1sJyk7XG4gICAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0KCk7XG5cbiAgICBkb2MucXVlcnlTZWxlY3RvckFsbCgnYS5zLXByb2R1Y3QtaGVhZGVyJykuZm9yRWFjaChwcm9kdWN0ID0+IHtcbiAgICAgICAgY29uc3QgcmVsYXRpdmVMaW5rID0gcHJvZHVjdC5nZXRBdHRyaWJ1dGUoJ2hyZWYnKSB8fCAnJztcbiAgICAgICAgaWYgKCFyZWxhdGl2ZUxpbmspIHJldHVybjtcblxuICAgICAgICBjb25zdCBwYXRobmFtZSA9IG5ldyBVUkwocmVsYXRpdmVMaW5rLCBiYXNlVXJsKS5wYXRobmFtZTtcbiAgICAgICAgaWYgKCFwYXRobmFtZSB8fCBzZWVuLmhhcyhwYXRobmFtZSkpIHJldHVybjtcbiAgICAgICAgc2Vlbi5hZGQocGF0aG5hbWUpO1xuXG4gICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgICB0aXRsZTogKHByb2R1Y3QuZ2V0QXR0cmlidXRlKCd0aXRsZScpIHx8IHByb2R1Y3QudGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKSxcbiAgICAgICAgICAgIHBhdGhuYW1lXG4gICAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUHJvZHVjdFByaWNlKGh0bWwpIHtcbiAgICBjb25zdCBwYXJzZXIgPSBuZXcgRE9NUGFyc2VyKCk7XG4gICAgY29uc3QgZG9jID0gcGFyc2VyLnBhcnNlRnJvbVN0cmluZyhodG1sLCAndGV4dC9odG1sJyk7XG4gICAgY29uc3QgcHJpY2VFbCA9IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnMtcHJpY2Ugc3Bhbi5wcmljZS13cmFwcGVyIHNwYW4ucHJpY2UnKVxuICAgICAgICAgICAgICAgICB8fCBkb2MucXVlcnlTZWxlY3RvcignLnMtcHJpY2Ugc3Bhbi5wcmljZScpXG4gICAgICAgICAgICAgICAgIHx8IGRvYy5xdWVyeVNlbGVjdG9yKCdzcGFuLnByaWNlLXdyYXBwZXIgc3Bhbi5wcmljZScpO1xuICAgIGlmICghcHJpY2VFbCkgcmV0dXJuICfigJQnO1xuICAgIGNvbnN0IHZhbHVlID0gcHJpY2VFbC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXHMrL2csICcgJykudHJpbSgpO1xuICAgIHJldHVybiB2YWx1ZSA/IGAke3ZhbHVlfSDigr1gIDogJ+KAlCc7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEhhdGlrb1Jlc3VsdCh0aXRsZSwgcHJpY2VzLCBwYXRobmFtZSkge1xuICAgIGN1cnJlbnRIYXRpa29QYXRobmFtZSA9IHBhdGhuYW1lO1xuICAgIGNvbnN0IGxpbmVzID0gW2Dwn6etICR7dGl0bGV9YCwgJyddO1xuICAgIEJBU0VfVVJMUy5mb3JFYWNoKChiYXNlVXJsLCBpKSA9PiB7XG4gICAgICAgIGxpbmVzLnB1c2goYPCfqpkke0NJVFlfSUNPTlNbaV19ICR7cHJpY2VzW2ldIHx8ICfigJQnfWApO1xuICAgIH0pO1xuICAgIHVwZGF0ZUhhdGlrb0xpbmtzUGFuZWwocGF0aG5hbWUpO1xuICAgIGxpbmVzLnB1c2goJycsICfQodC80L7QttC10Lw/INCQ0LrRgtGD0LDQu9GM0L3QsNGPINGG0LXQvdCwPycpO1xuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbn1cblxuXG4vKipcbiAqINCf0LDRgNGB0LjRgiDRgdGC0YDQsNC90LjRhtGDINCa0JDQoNCi0J7Qp9Ca0Jgg0YLQvtCy0LDRgNCwINC00LvRjyDQv9C+0LvRg9GH0LXQvdC40Y8g0YHRgtCw0YLRg9GB0LAg0L3QsNC70LjRh9C40Y8uXG4gKiDQktC+0LfQstGA0LDRidCw0LXRgiDRgdGC0YDQvtC60YMg0YHRgtCw0YLRg9GB0LAuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlUHJvZHVjdFBhZ2UoaHRtbCkge1xuICAgIGNvbnN0IHBhcnNlciA9IG5ldyBET01QYXJzZXIoKTtcbiAgICBjb25zdCBkb2MgPSBwYXJzZXIucGFyc2VGcm9tU3RyaW5nKGh0bWwsICd0ZXh0L2h0bWwnKTtcblxuICAgIC8vINCh0YLQsNGC0YPRgTogc3RvY2staGlnaCwgc3RvY2stbG93LCBzdG9jay1ub25lINC40LvQuCDQsNC90LDQu9C+0LPQuFxuICAgIGNvbnN0IHN0b2NrSGlnaCA9IGRvYy5xdWVyeVNlbGVjdG9yKCcuc3RvY2staGlnaCcpO1xuICAgIGNvbnN0IHN0b2NrTG93ICA9IGRvYy5xdWVyeVNlbGVjdG9yKCcuc3RvY2stbG93Jyk7XG4gICAgY29uc3Qgc3RvY2tOb25lID0gZG9jLnF1ZXJ5U2VsZWN0b3IoJy5zdG9jay1ub25lLCAuc3RvY2stb3V0Jyk7XG5cbiAgICBpZiAoc3RvY2tIaWdoKSByZXR1cm4gJ/Cfn6IgJyArIHN0b2NrSGlnaC50ZXh0Q29udGVudC50cmltKCk7XG4gICAgaWYgKHN0b2NrTG93KSAgcmV0dXJuICfwn5+hICcgKyBzdG9ja0xvdy50ZXh0Q29udGVudC50cmltKCk7XG4gICAgaWYgKHN0b2NrTm9uZSkgcmV0dXJuICfwn5S0ICcgKyBzdG9ja05vbmUudGV4dENvbnRlbnQudHJpbSgpO1xuXG4gICAgLy8g0JfQsNC/0LDRgdC90YvQtSDQstCw0YDQuNCw0L3RgtGLXG4gICAgY29uc3Qgc3RvY2tFbCA9IGRvYy5xdWVyeVNlbGVjdG9yKCdbY2xhc3MqPVwic3RvY2tcIl0sIFtjbGFzcyo9XCJhdmFpbGFiaWxpdHlcIl0sIFtjbGFzcyo9XCLQvdCw0LvQuNGH0LhcIl0nKTtcbiAgICBpZiAoc3RvY2tFbCkgcmV0dXJuICfwn5OmICcgKyBzdG9ja0VsLnRleHRDb250ZW50LnRyaW0oKTtcblxuICAgIHJldHVybiAn4p2TINCh0YLQsNGC0YPRgSDQvdC10LjQt9Cy0LXRgdGC0LXQvSc7XG59XG5cbmZ1bmN0aW9uIGNoZWNrSGF0aWtvKCkge1xuICAgIGNvbnN0IHF1ZXJ5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpLnZhbHVlLnRyaW0oKTtcbiAgICBpZiAoIXF1ZXJ5KSByZXR1cm47XG4gICAgY29uc3QgcmVxdWVzdElkID0gKythY3RpdmVSZXF1ZXN0SWQ7XG4gICAgY2xlYXJSZXN1bHRGb3JOZXdSZXF1ZXN0KCk7XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgndXNlcicsIHF1ZXJ5LCAn8J+QtiBIYXRpa28nKTtcbiAgICBpZiAoaGF0aWtvU2VhcmNoTW9kZSA9PT0gJ3BhbmVsJyB8fCAoaGF0aWtvU2VhcmNoTW9kZSA9PT0gJ2F1dG8nICYmIC9eXFxkKyQvLnRlc3QocXVlcnkpKSkge1xuICAgICAgICB1cGRhdGVIYXRpa29TdGF0dXMoJ9Cf0YDQvtCy0LXRgNGP0Y4gUGFuZWwgSGF0aWtv4oCmJyk7XG4gICAgICAgIHBhbmVsU2VhcmNoKHF1ZXJ5LCBkYXRhID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBmb3JtYXRQYW5lbFNlYXJjaFJlc3VsdChkYXRhKTtcbiAgICAgICAgICAgIGlmIChtZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCdQYW5lbDog0LPQvtGC0L7QstC+Jyk7XG4gICAgICAgICAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgbWVzc2FnZSwgJ/Cfj6ogUGFuZWwnLCBxdWVyeSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGhhdGlrb1NlYXJjaE1vZGUgPT09ICdhdXRvJykge1xuICAgICAgICAgICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cygnUGFuZWwg0L3QtSDQvdCw0YjRkdC7LCDQv9C10YDQtdC60LvRjtGH0LDRjtGB0Ywg0L3QsCBIYXRpa2/igKYnKTtcbiAgICAgICAgICAgICAgICBjaGVja0hhdGlrb1dlYnNpdGUocXVlcnksIHJlcXVlc3RJZCk7XG4gICAgICAgICAgICB9IGVsc2UgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ1BhbmVsOiDRgtC+0LLQsNGAINC90LUg0L3QsNC50LTQtdC9JywgJ/Cfj6ogUGFuZWwnLCBxdWVyeSk7XG4gICAgICAgIH0sIGVycm9yID0+IHtcbiAgICAgICAgICAgIGlmIChoYXRpa29TZWFyY2hNb2RlID09PSAnYXV0bycpIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVIYXRpa29TdGF0dXMoJ1BhbmVsINC90LXQtNC+0YHRgtGD0L/QvdCwLCDQv9C10YDQtdC60LvRjtGH0LDRjtGB0Ywg0L3QsCBIYXRpa2/igKYnKTtcbiAgICAgICAgICAgICAgICBjaGVja0hhdGlrb1dlYnNpdGUocXVlcnksIHJlcXVlc3RJZCk7XG4gICAgICAgICAgICB9IGVsc2UgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgZXJyb3IubWVzc2FnZSwgJ/Cfj6ogUGFuZWwnLCBxdWVyeSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNoZWNrSGF0aWtvV2Vic2l0ZShxdWVyeSwgcmVxdWVzdElkKTtcbn1cblxuZnVuY3Rpb24gY2hlY2tIYXRpa29XZWJzaXRlKHF1ZXJ5LCByZXF1ZXN0SWQpIHtcbiAgICB1cGRhdGVIYXRpa29TdGF0dXMoJ9CY0YnRgyDRgtC+0LLQsNGA0Ysg0L3QsCDRgdCw0LnRgtCw0YUgSGF0aWtv4oCmJyk7XG4gICAgY29uc3Qgc2VhcmNoZXMgPSBCQVNFX1VSTFMubWFwKGJhc2VVcmwgPT4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICBjb25zdCBzZWFyY2hVcmwgPSBgJHtiYXNlVXJsfS9zZWFyY2gvP3F1ZXJ5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KX1gO1xuICAgICAgICBmZXRjaFNlcnZlckRhdGEoc2VhcmNoVXJsLCByZXNwb25zZSA9PiByZXNvbHZlKHsgYmFzZVVybCwgcmVzcG9uc2UgfSksIHJlamVjdCk7XG4gICAgfSkpO1xuICAgIFByb21pc2UuYWxsU2V0dGxlZChzZWFyY2hlcykudGhlbihvdXRjb21lcyA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0SWQgIT09IGFjdGl2ZVJlcXVlc3RJZCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBwcm9kdWN0c0J5UGF0aCA9IG5ldyBNYXAoKTtcbiAgICAgICAgY29uc3QgZXJyb3JzID0gW107XG4gICAgICAgIG91dGNvbWVzLmZvckVhY2gob3V0Y29tZSA9PiB7XG4gICAgICAgICAgICBpZiAob3V0Y29tZS5zdGF0dXMgPT09ICdyZWplY3RlZCcpIHtcbiAgICAgICAgICAgICAgICBlcnJvcnMucHVzaChvdXRjb21lLnJlYXNvbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgeyBiYXNlVXJsLCByZXNwb25zZSB9ID0gb3V0Y29tZS52YWx1ZTtcbiAgICAgICAgICAgIHBhcnNlU2VhcmNoUmVzdWx0cyhyZXNwb25zZS5yZXNwb25zZVRleHQsIGJhc2VVcmwpLmZvckVhY2gocHJvZHVjdCA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFwcm9kdWN0c0J5UGF0aC5oYXMocHJvZHVjdC5wYXRobmFtZSkpIHByb2R1Y3RzQnlQYXRoLnNldChwcm9kdWN0LnBhdGhuYW1lLCBwcm9kdWN0KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgcHJvZHVjdHMgPSBbLi4ucHJvZHVjdHNCeVBhdGgudmFsdWVzKCldO1xuICAgICAgICBpZiAoIXByb2R1Y3RzLmxlbmd0aCkge1xuICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKGVycm9ycy5sZW5ndGggPT09IEJBU0VfVVJMUy5sZW5ndGggPyAn0J7RiNC40LHQutCwINC/0L7QuNGB0LrQsCcgOiAn0KLQvtCy0LDRgNGLINC90LUg0L3QsNC50LTQtdC90YsnKTtcbiAgICAgICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIGVycm9ycy5sZW5ndGggPT09IEJBU0VfVVJMUy5sZW5ndGhcbiAgICAgICAgICAgICAgICA/ICfQndC1INGD0LTQsNC70L7RgdGMINCy0YvQv9C+0LvQvdC40YLRjCDQv9C+0LjRgdC6INC90LAg0YHQsNC50YLQsNGFIEhhdGlrbydcbiAgICAgICAgICAgICAgICA6ICfQotC+0LLQsNGAINC90LUg0L3QsNC50LTQtdC9JywgJ/CfkLYgSGF0aWtvJywgcXVlcnkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cyhg0J3QsNC50LTQtdC90L4g0YLQvtCy0LDRgNC+0LI6ICR7cHJvZHVjdHMubGVuZ3RofS4g0J/QvtC70YPRh9Cw0Y4g0YbQtdC90YvigKZgKTtcbiAgICAgICAgY29uc3QgcmVzdWx0cyA9IG5ldyBBcnJheShwcm9kdWN0cy5sZW5ndGgpO1xuICAgICAgICBsZXQgY29tcGxldGVkID0gMDtcbiAgICAgICAgcHJvZHVjdHMuZm9yRWFjaCgocHJvZHVjdCwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgIGNoZWNrSGF0aWtvUHJvZHVjdChwcm9kdWN0LCByZXN1bHQgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0SWQgIT09IGFjdGl2ZVJlcXVlc3RJZCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIHJlc3VsdHNbaW5kZXhdID0gcmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbXBsZXRlZCsrO1xuICAgICAgICAgICAgICAgIGlmIChjb21wbGV0ZWQgIT09IHByb2R1Y3RzLmxlbmd0aCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGxhc3RIYXRpa29SZXN1bHRzID0gcmVzdWx0cztcbiAgICAgICAgICAgICAgICBsYXN0SGF0aWtvUXVlcnkgPSBxdWVyeTtcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQk9C+0YLQvtCy0L4nKTtcbiAgICAgICAgICAgICAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgcmVzdWx0c1swXS5tZXNzYWdlLCAn8J+QtiBIYXRpa28nLCBxdWVyeSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKGDQk9C+0YLQvtCy0L46ICR7cmVzdWx0cy5sZW5ndGh9INGC0L7QstCw0YDQsC4g0JzQvtC20L3QviDQstGL0LHRgNCw0YLRjCDQtNGA0YPQs9C+0LkuYCk7XG4gICAgICAgICAgICAgICAgICAgIG9wZW5IYXRpa29Qcm9kdWN0UGlja2VyKHJlc3VsdHMsIHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAocmVxdWVzdElkICE9PSBhY3RpdmVSZXF1ZXN0SWQpIHJldHVybjtcbiAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQntGI0LjQsdC60LAg0L/QvtC40YHQutCwJyk7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsICfQntGI0LjQsdC60LAg0L/QvtC40YHQutCwOiAnICsgZXJyb3IsICfwn5C2IEhhdGlrbycsIHF1ZXJ5KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0UGFuZWxTZWFyY2hSZXN1bHQoZGF0YSkge1xuICAgIGNvbnN0IHByb2R1Y3RzID0gZGF0YT8ucmVzdWx0cyB8fCBbXTtcbiAgICBpZiAoIXByb2R1Y3RzLmxlbmd0aCkgcmV0dXJuICcnO1xuICAgIHJldHVybiBwcm9kdWN0cy5tYXAocHJvZHVjdCA9PiBbXG4gICAgICAgIGDQkNGA0YLQuNC60YPQuzogJHtwcm9kdWN0LmFydGljbGUgfHwgJ+KAlCd9YCxcbiAgICAgICAgcHJvZHVjdC5leHRlcm5hbF9jb2RlID8gYNCS0Jo6ICR7cHJvZHVjdC5leHRlcm5hbF9jb2RlfWAgOiBudWxsLFxuICAgICAgICBwcm9kdWN0Lm5hbWUgfHwgJ+KAlCcsXG4gICAgICAgIGDQodGC0LDRgtGD0YE6ICR7cHJvZHVjdC5zdGF0dXMgfHwgJ+KAlCd9YCxcbiAgICAgICAgYNCd0LDQu9C40YfQuNC1OiAke3Byb2R1Y3QudG90YWxfc3RvY2sgPiAwID8gYCR7cHJvZHVjdC50b3RhbF9zdG9ja30g0YjRgi5gIDogJ9Cd0LXRgid9YCxcbiAgICAgICAgcHJvZHVjdC5zdXBwbGllcl9kZWNpc2lvbj8uaXpfbmFsaWNoaXlhID8gYNCY0Lcg0L3QsNC70LjRh9C40Y86ICR7cHJvZHVjdC5zdXBwbGllcl9kZWNpc2lvbi5pel9uYWxpY2hpeWF9YCA6IG51bGwsXG4gICAgICAgIE9iamVjdC5lbnRyaWVzKHByb2R1Y3QucHJpY2VzIHx8IHt9KS5tYXAoKFtjaXR5LCBwcmljZV0pID0+IGAke2NpdHl9OiAke3ByaWNlID8gYCR7cHJpY2V9IOKCvWAgOiAn4oCUJ31gKS5qb2luKCcgIOKAoiAgJyksXG4gICAgICAgIHByb2R1Y3Quc3RvY2tfZm9ybWF0dGVkID8gYFxcbiR7cHJvZHVjdC5zdG9ja19mb3JtYXR0ZWR9YCA6IG51bGxcbiAgICBdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcXG4nKSkuam9pbignXFxuXFxuLS0tXFxuXFxuJyk7XG59XG5cbmZ1bmN0aW9uIGNoZWNrSGF0aWtvQm9udXNlcygpIHtcbiAgICBjb25zdCBwaG9uZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFwaG9uZSkgcmV0dXJuO1xuICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ3VzZXInLCBwaG9uZSwgJ/CfjoEg0JHQvtC90YPRgdGLJyk7XG4gICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQn9GA0L7QstC10YDRj9GOINCx0L7QvdGD0YHRiyDQsiBQYW5lbOKApicpO1xuICAgIHBhbmVsQ2hlY2tCb251c2VzKHBob25lLCBkYXRhID0+IHtcbiAgICAgICAgdXBkYXRlSGF0aWtvU3RhdHVzKCfQkdC+0L3Rg9GB0Ys6INCz0L7RgtC+0LLQvicpO1xuICAgICAgICBjb25zdCBib251cyA9IGRhdGEuYm9udXMgPz8gZGF0YS5ib251c2VzID8/IGRhdGEuYWZmaWxpYXRlX2JvbnVzID8/IDA7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIFtcbiAgICAgICAgICAgIGDQotC10LvQtdGE0L7QvTogJHtkYXRhLnBob25lIHx8IHBob25lfWAsXG4gICAgICAgICAgICBg0JrQu9C40LXQvdGCOiAke2RhdGEubmFtZSB8fCBkYXRhLmN1c3RvbWVyX25hbWUgfHwgJ+KAlCd9YCxcbiAgICAgICAgICAgIGDQkdC+0L3Rg9GB0Ys6ICR7TWF0aC5yb3VuZChOdW1iZXIoYm9udXMpKX1gXG4gICAgICAgIF0uam9pbignXFxuJyksICfwn46BINCR0L7QvdGD0YHRiycsIHBob25lKTtcbiAgICB9LCBlcnJvciA9PiB7XG4gICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cygn0J7RiNC40LHQutCwINC/0YDQvtCy0LXRgNC60Lgg0LHQvtC90YPRgdC+0LInKTtcbiAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgZXJyb3IubWVzc2FnZSwgJ/CfjoEg0JHQvtC90YPRgdGLJywgcGhvbmUpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBjaGVja0hhdGlrb1Byb2R1Y3QocHJvZHVjdCwgb25Db21wbGV0ZSkge1xuICAgIGNvbnN0IHsgdGl0bGUsIHBhdGhuYW1lIH0gPSBwcm9kdWN0O1xuICAgIGN1cnJlbnRIYXRpa29QYXRobmFtZSA9IHBhdGhuYW1lO1xuICAgIGNvbnN0IHByaWNlcyA9IG5ldyBBcnJheShCQVNFX1VSTFMubGVuZ3RoKS5maWxsKCfigJQnKTtcbiAgICBsZXQgcmVxdWVzdHNDb21wbGV0ZWQgPSAwO1xuXG4gICAgQkFTRV9VUkxTLmZvckVhY2goKGJhc2VVcmwsIGlkeCkgPT4ge1xuICAgICAgICBmZXRjaFNlcnZlckRhdGEoXG4gICAgICAgICAgICBgJHtiYXNlVXJsfSR7cGF0aG5hbWV9YCxcbiAgICAgICAgICAgIHByb2R1Y3RSZXNwID0+IHtcbiAgICAgICAgICAgICAgICBwcmljZXNbaWR4XSA9IHBhcnNlUHJvZHVjdFByaWNlKHByb2R1Y3RSZXNwLnJlc3BvbnNlVGV4dCk7XG4gICAgICAgICAgICAgICAgcmVxdWVzdHNDb21wbGV0ZWQrKztcbiAgICAgICAgICAgICAgICB1cGRhdGVIYXRpa29TdGF0dXMoYNCf0L7Qu9GD0YfQsNGOINGG0LXQvdGLOiAke3JlcXVlc3RzQ29tcGxldGVkfS8ke0JBU0VfVVJMUy5sZW5ndGh9INC00LvRjyDCqyR7dGl0bGV9wrtgKTtcbiAgICAgICAgICAgICAgICBpZiAocmVxdWVzdHNDb21wbGV0ZWQgPT09IEJBU0VfVVJMUy5sZW5ndGgpIGZpbmlzaCgpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICgpID0+IHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0c0NvbXBsZXRlZCsrO1xuICAgICAgICAgICAgICAgIHVwZGF0ZUhhdGlrb1N0YXR1cyhg0J/QvtC70YPRh9Cw0Y4g0YbQtdC90Ys6ICR7cmVxdWVzdHNDb21wbGV0ZWR9LyR7QkFTRV9VUkxTLmxlbmd0aH0g0LTQu9GPIMKrJHt0aXRsZX3Cu2ApO1xuICAgICAgICAgICAgICAgIGlmIChyZXF1ZXN0c0NvbXBsZXRlZCA9PT0gQkFTRV9VUkxTLmxlbmd0aCkgZmluaXNoKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICk7XG4gICAgfSk7XG5cbiAgICBmdW5jdGlvbiBmaW5pc2goKSB7XG4gICAgICAgIC8vINCV0YHQu9C4INCz0L7RgNC+0LTRgdC60L7QuSDRgdCw0LnRgiDQvdC1INC+0YLQtNCw0Lsg0L7RgtC00LXQu9GM0L3Rg9GOINGG0LXQvdGDLCDQuNGB0L/QvtC70YzQt9GD0LXQvCDRhtC10L3Rg1xuICAgICAgICAvLyDQodCw0YDQsNGC0L7QstCwOiDRgyDQs9C+0YDQvtC00L7QsiDRh9Cw0YHRgtC+INC+0LHRidC40Lkg0LrQsNGC0LDQu9C+0LMg0Lgg0L/RgNCw0LnRgS5cbiAgICAgICAgY29uc3Qgc2FyYXRvdlByaWNlID0gcHJpY2VzWzBdO1xuICAgICAgICBjb25zdCBub3JtYWxpemVkUHJpY2VzID0gc2FyYXRvdlByaWNlICE9PSAn4oCUJ1xuICAgICAgICAgICAgPyBwcmljZXMubWFwKHByaWNlID0+IHByaWNlID09PSAn4oCUJyA/IHNhcmF0b3ZQcmljZSA6IHByaWNlKVxuICAgICAgICAgICAgOiBwcmljZXM7XG4gICAgICAgIG9uQ29tcGxldGUoe1xuICAgICAgICAgICAgdGl0bGUsXG4gICAgICAgICAgICBwYXRobmFtZSxcbiAgICAgICAgICAgIHByaWNlczogbm9ybWFsaXplZFByaWNlcyxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGZvcm1hdEhhdGlrb1Jlc3VsdCh0aXRsZSwgbm9ybWFsaXplZFByaWNlcywgcGF0aG5hbWUpXG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxuXG5cblxuXG4iLCIvLyDilIDilIDilIAg0JrQsNC70YzQutGD0LvRj9GC0L7RgCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGNhbGN1bGF0ZUNyZWRpdCgpIHtcbiAgICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFpbnB1dCkgcmV0dXJuO1xuICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ3VzZXInLCBpbnB1dCwgJ/Cfp64g0JrQsNC70YzQutGD0LvRj9GC0L7RgCcpO1xuXG4gICAgY29uc3QgZG93blBheW1lbnRNYXRjaCA9IGlucHV0Lm1hdGNoKC9eXFxzKihcXGQrKD86Wy4sXVxcZCspPylcXHMqLVxccyooXFxkKyg/OlsuLF1cXGQrKT8pXFxzKiQvKTtcbiAgICBjb25zdCB0b3RhbCA9IGRvd25QYXltZW50TWF0Y2ggPyBOdW1iZXIoZG93blBheW1lbnRNYXRjaFsxXS5yZXBsYWNlKCcsJywgJy4nKSkgOiBudWxsO1xuICAgIGNvbnN0IGRvd25QYXltZW50ID0gZG93blBheW1lbnRNYXRjaCA/IE51bWJlcihkb3duUGF5bWVudE1hdGNoWzJdLnJlcGxhY2UoJywnLCAnLicpKSA6IG51bGw7XG4gICAgY29uc3QgYW1vdW50ID0gZG93blBheW1lbnRNYXRjaCA/IHRvdGFsIC0gZG93blBheW1lbnQgOiBwYXJzZUZsb2F0KGlucHV0KTtcblxuICAgIGlmIChpc05hTihhbW91bnQpIHx8IGFtb3VudCA8PSAwKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gZG93blBheW1lbnRNYXRjaFxuICAgICAgICAgICAgPyAn0J7RiNC40LHQutCwOiDQv9C10YDQstC+0L3QsNGH0LDQu9GM0L3Ri9C5INCy0LfQvdC+0YEg0LTQvtC70LbQtdC9INCx0YvRgtGMINCx0L7Qu9GM0YjQtSAwINC4INC80LXQvdGM0YjQtSDQvtCx0YnQtdC5INGB0YPQvNC80YsuJ1xuICAgICAgICAgICAgOiAn0J7RiNC40LHQutCwOiDQstCy0LXQtNC40YLQtSDQutC+0YDRgNC10LrRgtC90YPRjiDRgdGD0LzQvNGDLic7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIGVycm9yLCAn8J+nriDQmtCw0LvRjNC60YPQu9GP0YLQvtGAJywgaW5wdXQpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChkb3duUGF5bWVudE1hdGNoICYmICghTnVtYmVyLmlzRmluaXRlKHRvdGFsKSB8fCAhTnVtYmVyLmlzRmluaXRlKGRvd25QYXltZW50KSB8fCBkb3duUGF5bWVudCA8PSAwIHx8IGRvd25QYXltZW50ID49IHRvdGFsKSkge1xuICAgICAgICBhZGRUb0NoYXRIaXN0b3J5KCdib3QnLCAn0J7RiNC40LHQutCwOiDQv9C10YDQstC+0L3QsNGH0LDQu9GM0L3Ri9C5INCy0LfQvdC+0YEg0LTQvtC70LbQtdC9INCx0YvRgtGMINCx0L7Qu9GM0YjQtSAwINC4INC80LXQvdGM0YjQtSDQvtCx0YnQtdC5INGB0YPQvNC80YsuJywgJ/Cfp64g0JrQsNC70YzQutGD0LvRj9GC0L7RgCcsIGlucHV0KTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGxpbmVzID0gW107XG4gICAgaWYgKGRvd25QYXltZW50TWF0Y2gpIHtcbiAgICAgICAgbGluZXMucHVzaChg0J/QtdGA0LLQvtC90LDRh9Cw0LvRjNC90YvQuSDQstC30L3QvtGBOiAke2Rvd25QYXltZW50fSDRgNGD0LEuYCwgYNCe0YHRgtCw0YLQvtC6OiAke2Ftb3VudH0g0YDRg9CxLmApO1xuICAgIH1cbiAgICBsaW5lcy5wdXNoKC4uLmNhbGNSdWxlcy5tYXAocnVsZSA9PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGFwcGx5UnVsZShhbW91bnQsIHJ1bGUpO1xuICAgICAgICBpZiAocnVsZS5pc0Nhc2hiYWNrKSByZXR1cm4gYPCfkrggJHtydWxlLm5hbWV9OiAke3Jlc3VsdH0g0LHQsNC70LvQsNC80LhgO1xuICAgICAgICBjb25zdCB0b3RhbFdpdGhEb3duUGF5bWVudCA9IGRvd25QYXltZW50TWF0Y2ggPyBgICgke3Jlc3VsdCArIGRvd25QYXltZW50fSDRgNGD0LEuINGBINC/0LXRgNCy0L7QvdCw0YfQsNC70YzQvdGL0Lwg0LLQt9C90L7RgdC+0LwpYCA6ICcnO1xuICAgICAgICByZXR1cm4gYPCflLkgJHtydWxlLm5hbWV9OiAke3Jlc3VsdH0g0YDRg9CxLiR7dG90YWxXaXRoRG93blBheW1lbnR9YDtcbiAgICB9KSk7XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgbGluZXMuam9pbignXFxuJyksICfwn6euINCa0LDQu9GM0LrRg9C70Y/RgtC+0YAnLCBpbnB1dCk7XG59XG5cbmZ1bmN0aW9uIGNhbGN1bGF0ZVJldmVyc2UoKSB7XG4gICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykudmFsdWUudHJpbSgpO1xuICAgIGlmICghaW5wdXQpIHJldHVybjtcbiAgICBhZGRUb0NoYXRIaXN0b3J5KCd1c2VyJywgaW5wdXQsICfwn5SEINCg0LXQstC10YDRgScpO1xuICAgIGNvbnN0IGFtb3VudCA9IHBhcnNlRmxvYXQoaW5wdXQpO1xuICAgIGlmIChpc05hTihhbW91bnQpIHx8IGFtb3VudCA8PSAwKSB7XG4gICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsICfQntGI0LjQsdC60LA6INCy0LLQtdC00LjRgtC1INC60L7RgNGA0LXQutGC0L3Rg9GOINGB0YPQvNC80YMuJywgJ/CflIQg0KDQtdCy0LXRgNGBJywgaW5wdXQpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGxpbmVzID0gY2FsY1J1bGVzXG4gICAgICAgIC5maWx0ZXIociA9PiAhci5pc0Nhc2hiYWNrICYmIHIucGVyY2VudCA+IDApXG4gICAgICAgIC5tYXAociA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcmlnaW5hbCA9IE1hdGgucm91bmQoKGFtb3VudCAtIChyLmV4dHJhIHx8IDApKSAvIHIucGVyY2VudCAqIDEwMCk7XG4gICAgICAgICAgICByZXR1cm4gYPCflLkgJHtyLm5hbWV9OiAke29yaWdpbmFsfSDRgNGD0LEuYDtcbiAgICAgICAgfSk7XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ/CflIQg0KDQldCS0JXQoNChINGA0LDRgdGH0ZHRgtCwOlxcbicgKyBsaW5lcy5qb2luKCdcXG4nKSwgJ/CflIQg0KDQtdCy0LXRgNGBJywgaW5wdXQpO1xufVxuXG4vKipcbiAqINCh0LrQuNC00LrQsCAvINCd0LDRhtC10L3QutCwXG4gKiDQpNC+0YDQvNCw0YLRizpcbiAqICAg0YbQtdC90LAgLSDRgdC60LjQtNC60LAgICDihpIg0LLRi9GH0LXRgdGC0YxcbiAqICAg0YbQtdC90LAgKyDQvdCw0YbQtdC90LrQsCAg4oaSINC/0YDQuNCx0LDQstC40YLRjFxuICovXG5mdW5jdGlvbiBhcHBseURpc2NvdW50T3JNYXJrdXAoKSB7XG4gICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0lucHV0JykudmFsdWUudHJpbSgpO1xuICAgIGlmICghaW5wdXQpIHJldHVybjtcbiAgICBhZGRUb0NoYXRIaXN0b3J5KCd1c2VyJywgaW5wdXQsICfwn46JINCh0LrQuNC00LrQsC/QndCw0YbQtdC90LrQsCcpO1xuXG4gICAgLy8g0J7Qv9GA0LXQtNC10LvRj9C10Lwg0L7Qv9C10YDQsNGG0LjRjjogKyDQuNC70LggLVxuICAgIGNvbnN0IG1pbnVzSWR4ID0gaW5wdXQubGFzdEluZGV4T2YoJy0nKTtcbiAgICBjb25zdCBwbHVzSWR4ICA9IGlucHV0Lmxhc3RJbmRleE9mKCcrJyk7XG5cbiAgICBsZXQgb3AgPSBudWxsLCBzcGxpdElkeCA9IC0xO1xuICAgIGlmIChtaW51c0lkeCA+IDAgJiYgbWludXNJZHggPiBwbHVzSWR4KSB7IG9wID0gJy0nOyBzcGxpdElkeCA9IG1pbnVzSWR4OyB9XG4gICAgZWxzZSBpZiAocGx1c0lkeCA+IDApICAgICAgICAgICAgICAgICAgIHsgb3AgPSAnKyc7IHNwbGl0SWR4ID0gcGx1c0lkeDsgIH1cblxuICAgIGlmICghb3ApIHtcbiAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ9Ce0YjQuNCx0LrQsDog0YTQvtGA0LzQsNGCIOKAlCBcItGB0YPQvNC80LAgLSDRgdC60LjQtNC60LBcIiDQuNC70LggXCLRgdGD0LzQvNCwICsg0L3QsNGG0LXQvdC60LBcIicsICfwn46JJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBvcmlnID0gcGFyc2VGbG9hdChpbnB1dC5zdWJzdHJpbmcoMCwgc3BsaXRJZHgpLnRyaW0oKSk7XG4gICAgY29uc3QgZGlmZiA9IHBhcnNlRmxvYXQoaW5wdXQuc3Vic3RyaW5nKHNwbGl0SWR4ICsgMSkudHJpbSgpKTtcblxuICAgIGlmIChpc05hTihvcmlnKSB8fCBpc05hTihkaWZmKSkge1xuICAgICAgICBhZGRUb0NoYXRIaXN0b3J5KCdib3QnLCAn0J7RiNC40LHQutCwOiDQvdC10LrQvtGA0YDQtdC60YLQvdGL0LUg0YfQuNGB0LvQsCcsICfwn46JJyk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBvcCA9PT0gJy0nID8gb3JpZyAtIGRpZmYgOiBvcmlnICsgZGlmZjtcbiAgICBjb25zdCBwY3QgICAgPSBNYXRoLmFicyhkaWZmIC8gb3JpZyAqIDEwMCk7XG4gICAgY29uc3QgbGFiZWwgID0gb3AgPT09ICctJyA/ICfwn46JINCh0LrQuNC00LrQsCcgOiAn8J+TiCDQndCw0YbQtdC90LrQsCc7XG4gICAgY29uc3QgdmVyYiAgID0gb3AgPT09ICctJyA/ICfQodC60LjQtNC60LAnICAgIDogJ9Cd0LDRhtC10L3QutCwJztcblxuICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsXG4gICAgICAgICAgICBgJHtsYWJlbH06XFxuYCArXG4gICAgICAgICAgICBg8J+UuSDQkdGL0LvQvjogJHtvcmlnfSDRgNGD0LEuXFxuYCArXG4gICAgICAgICAgICBg8J+UuSAke3ZlcmJ9OiAke2RpZmZ9INGA0YPQsS4gKCR7cGN0fSUpXFxuYCArXG4gICAgICAgICAgICBg8J+UuSDQmNGC0L7Qs9C+OiAke3Jlc3VsdH0g0YDRg9CxLmAsXG4gICAgICAgICAgICAn8J+OiScsIGlucHV0KTtcbn1cblxuZnVuY3Rpb24gY2FsY3VsYXRlU2ltcGxlKCkge1xuICAgIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ByaWNlQ2hlY2tJbnB1dCcpLnZhbHVlLnRyaW0oKTtcbiAgICBpZiAoIWlucHV0KSByZXR1cm47XG4gICAgYWRkVG9DaGF0SGlzdG9yeSgndXNlcicsIGlucHV0LCAn4oiRINCf0YDQvtGB0YLQvtC5Jyk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gRnVuY3Rpb24oJ1widXNlIHN0cmljdFwiOyByZXR1cm4gKCcgKyBpbnB1dCArICcpJykoKTtcbiAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgYNCg0LXQt9GD0LvRjNGC0LDRgjogJHtyZXN1bHR9YCwgJ+KIkSDQn9GA0L7RgdGC0L7QuScsIGlucHV0KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgICAgYWRkVG9DaGF0SGlzdG9yeSgnYm90JywgJ9Ce0YjQuNCx0LrQsDog0L3QtdC60L7RgNGA0LXQutGC0L3QvtC1INCy0YvRgNCw0LbQtdC90LjQtScsICfiiJEg0J/RgNC+0YHRgtC+0LknKTtcbiAgICB9XG59XG5cbiIsIi8vIOKUgOKUgOKUgCDQoNCw0YHQv9C40YHQsNC90LjQtSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCS0LrQu9Cw0LTQutC4IMKr0KHQtdCz0L7QtNC90Y/Cuy/Cq9CX0LDQstGC0YDQsMK7INC/0L7QutCw0LfRi9Cy0LDRjtGCINC00LDQvdC90YvQtSDQstC90YPRgtGA0Lgg0JzQtdC80L3QvtCz0L4g0YfQsNGC0LAuXG5mdW5jdGlvbiBmZXRjaFdob1dvcmtzVG9kYXkoKSAgICB7IHJldHVybiBmZXRjaFdob1dvcmtzKCd0b2RheScpOyB9XG5mdW5jdGlvbiBmZXRjaFdob1dvcmtzVG9tb3Jyb3coKSB7IHJldHVybiBmZXRjaFdob1dvcmtzKCd0b21vcnJvdycpOyB9XG5cbmZ1bmN0aW9uIHNjaGVkdWxlVGFyZ2V0RGF0ZShkYXksIG5vdyA9IERhdGUubm93KCkpIHtcbiAgICBjb25zdCBkYXRlID0gbmV3IERhdGUobm93KTtcbiAgICBpZiAoZGF5ID09PSAndG9tb3Jyb3cnKSBkYXRlLnNldERhdGUoZGF0ZS5nZXREYXRlKCkgKyAxKTtcbiAgICByZXR1cm4gYCR7ZGF0ZS5nZXRGdWxsWWVhcigpfS0ke1N0cmluZyhkYXRlLmdldE1vbnRoKCkgKyAxKS5wYWRTdGFydCgyLCAnMCcpfS0ke1N0cmluZyhkYXRlLmdldERhdGUoKSkucGFkU3RhcnQoMiwgJzAnKX1gO1xufVxuXG5mdW5jdGlvbiBhcHBseVNjaGVkdWxlU25hcHNob3QoZGF5LCBzbmFwc2hvdCkge1xuICAgIGNvbnN0IHN0YXRlID0gc2NoZWR1bGVTdGF0ZUJ5RGF5W2RheV07XG4gICAgY29uc3QgcmVwbGFjZW1lbnRzID0geyAuLi5zbmFwc2hvdC5yZW1vdGVSZXBsYWNlbWVudHMsIC4uLnNjaGVkdWxlUmVwbGFjZW1lbnRzIH07XG4gICAgc3RhdGUuc25hcHNob3QgPSBzbmFwc2hvdDtcbiAgICBzdGF0ZS5wYXJzZWQgPSBwYXJzZVNjaGVkdWxlTGluZXMoc25hcHNob3QucmF3VGV4dCwgcmVwbGFjZW1lbnRzLCBkYXkpO1xuICAgIHN0YXRlLnRleHRDb3B5ID0gZm9ybWF0T3V0cHV0V2l0aFJlcGxhY2VtZW50cyhzbmFwc2hvdC5yYXdUZXh0LCByZXBsYWNlbWVudHMsIGRheSk7XG4gICAgc3RhdGUudXBkYXRlZEF0ID0gc25hcHNob3QuZmV0Y2hlZEF0O1xufVxuXG5mdW5jdGlvbiBmZXRjaFdob1dvcmtzKGRheSwgeyBmb3JjZSA9IGZhbHNlIH0gPSB7fSkge1xuICAgIGNvbnN0IHVybCAgICAgPSBgaHR0cHM6Ly9kb2NzLmdvb2dsZS5jb20vc3ByZWFkc2hlZXRzL2QvMTNLVW1IdFJYWWJYakJFN0tRXzRNRlE1VnNnVVlxdTJoZVVSWTF5Mk53aUUvZWRpdGA7XG4gICAgY29uc3QganNvblVybCA9ICdodHRwczovL2dpdGh1Yi5jb20veHRhbGlhL2hhdGlrby9yYXcvcmVmcy9oZWFkcy9tYWluL2pzL3d3UGVvcGxlcy5qc29uJztcbiAgICBjb25zdCBzdGF0ZSA9IHNjaGVkdWxlU3RhdGVCeURheVtkYXldO1xuICAgIGlmICghc3RhdGUpIHJldHVybiBQcm9taXNlLnJlc29sdmUobnVsbCk7XG4gICAgaWYgKHN0YXRlLmluRmxpZ2h0KSB7XG4gICAgICAgIHJlbmRlclNjaGVkdWxlVGFiKGRheSk7XG4gICAgICAgIHJldHVybiBzdGF0ZS5pbkZsaWdodDtcbiAgICB9XG4gICAgY29uc3QgdGFyZ2V0RGF0ZSA9IHNjaGVkdWxlVGFyZ2V0RGF0ZShkYXkpO1xuICAgIGNvbnN0IGNhY2hlZCA9IGZvcmNlID8gbnVsbCA6IGxvYWRTY2hlZHVsZUNhY2hlKGRheSwgdGFyZ2V0RGF0ZSk7XG4gICAgaWYgKGNhY2hlZCkge1xuICAgICAgICBhcHBseVNjaGVkdWxlU25hcHNob3QoZGF5LCBjYWNoZWQpO1xuICAgICAgICBzdGF0ZS5lcnJvciA9ICcnO1xuICAgICAgICByZW5kZXJTY2hlZHVsZVRhYihkYXkpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGNhY2hlZCk7XG4gICAgfVxuICAgIHN0YXRlLmxvYWRpbmcgPSB0cnVlO1xuICAgIHN0YXRlLmVycm9yID0gJyc7XG4gICAgcmVuZGVyU2NoZWR1bGVUYWIoZGF5KTtcblxuICAgIHN0YXRlLmluRmxpZ2h0ID0gUHJvbWlzZS5yZXNvbHZlKCkudGhlbigoKSA9PiBmZXRjaChqc29uVXJsKSlcbiAgICAgICAgLnRoZW4ociA9PiB7IGlmICghci5vaykgdGhyb3cgbmV3IEVycm9yKCk7IHJldHVybiByLmpzb24oKTsgfSlcbiAgICAgICAgLnRoZW4obG9hZGVkID0+IHtcbiAgICAgICAgICAgIGlmICghbG9hZGVkIHx8IHR5cGVvZiBsb2FkZWQgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkobG9hZGVkKVxuICAgICAgICAgICAgICAgIHx8IE9iamVjdC52YWx1ZXMobG9hZGVkKS5zb21lKHZhbHVlID0+IHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycpKSB0aHJvdyBuZXcgRXJyb3IoJ9Cd0LXQstC10YDQvdGL0Lkg0YTQvtGA0LzQsNGCINC30LDQvNC10L0nKTtcbiAgICAgICAgICAgIHJldHVybiBsb2FkZWQ7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoKSA9PiAoe30pKVxuICAgICAgICAudGhlbihsb2FkZWQgPT4gbG9hZFRhYmxlV2l0aFJlcGxhY2VtZW50cyhkYXksIHVybCwgeyAuLi5sb2FkZWQsIC4uLnNjaGVkdWxlUmVwbGFjZW1lbnRzIH0sIHRhcmdldERhdGUpXG4gICAgICAgICAgICAudGhlbihyZXN1bHQgPT4gKHsgLi4ucmVzdWx0LCByZW1vdGVSZXBsYWNlbWVudHM6IGxvYWRlZCB9KSkpXG4gICAgICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgICAgICBpZiAoc2NoZWR1bGVUYXJnZXREYXRlKGRheSkgIT09IHRhcmdldERhdGUpIHRocm93IG5ldyBFcnJvcign0JjQt9C80LXQvdC40LvQsNGB0Ywg0LrQsNC70LXQvdC00LDRgNC90LDRjyDQtNCw0YLQsCDigJQg0L7RgtC60YDQvtC50YLQtSDQtNC10L3RjCDQt9Cw0L3QvtCy0L4nKTtcbiAgICAgICAgICAgIHN0YXRlLmxvYWRpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IHNuYXBzaG90ID0geyBzY2hlbWE6IDEsIHRhcmdldERhdGUsIGZldGNoZWRBdDogRGF0ZS5ub3coKSwgcmF3VGV4dDogcmVzdWx0LnJhd1RleHQsIHJlbW90ZVJlcGxhY2VtZW50czogcmVzdWx0LnJlbW90ZVJlcGxhY2VtZW50cyB9O1xuICAgICAgICAgICAgYXBwbHlTY2hlZHVsZVNuYXBzaG90KGRheSwgc25hcHNob3QpO1xuICAgICAgICAgICAgc2F2ZVNjaGVkdWxlQ2FjaGUoZGF5LCBzbmFwc2hvdCk7XG4gICAgICAgICAgICBzdGF0ZS5lcnJvciA9ICcnO1xuICAgICAgICAgICAgcmVuZGVyU2NoZWR1bGVUYWIoZGF5KTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICBzdGF0ZS5sb2FkaW5nID0gZmFsc2U7XG4gICAgICAgICAgICBzdGF0ZS5lcnJvciA9IGVycm9yLm1lc3NhZ2UgfHwgJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDQv9GA0Lgg0LfQsNCz0YDRg9C30LrQtSDRgNCw0YHQv9C40YHQsNC90LjRjyc7XG4gICAgICAgICAgICByZW5kZXJTY2hlZHVsZVRhYihkYXkpO1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHsgc3RhdGUuaW5GbGlnaHQgPSBudWxsOyB9KTtcbiAgICByZXR1cm4gc3RhdGUuaW5GbGlnaHQ7XG59XG5cbmZ1bmN0aW9uIGxvYWRUYWJsZVdpdGhSZXBsYWNlbWVudHMoZGF5LCB1cmwsIHJlcGxhY2VtZW50cywgdGFyZ2V0RGF0ZSA9IHNjaGVkdWxlVGFyZ2V0RGF0ZShkYXkpKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IEdNX3htbGh0dHBSZXF1ZXN0KHtcbiAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgdGltZW91dDogMzAwMDAsXG4gICAgICAgIHVybCxcbiAgICAgICAgb25sb2FkKHJlc3BvbnNlKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPCAyMDAgfHwgcmVzcG9uc2Uuc3RhdHVzID49IDMwMCkgdGhyb3cgbmV3IEVycm9yKGDQntGI0LjQsdC60LAg0LfQsNCz0YDRg9C30LrQuCDRgNCw0YHQv9C40YHQsNC90LjRjzogSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICAgICAgICAgICAgICBjb25zdCByZWdleCA9IC/wn46v0KDQkNCR0J7Qp9CY0Jlf0JPQoNCQ0KTQmNCaX9CU0JDQndCd0KvQlfCfjq8oW1xcc1xcU10qPynwn46vL2k7XG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSByZXNwb25zZS5yZXNwb25zZVRleHQubWF0Y2gocmVnZXgpO1xuICAgICAgICAgICAgICAgIGlmICghbWF0Y2g/LlsxXSkgdGhyb3cgbmV3IEVycm9yKCfQndC1INGD0LTQsNC70L7RgdGMINC90LDQudGC0Lgg0LTQsNC90L3Ri9C1INCyINGC0LDQsdC70LjRhtC1Jyk7XG5cbiAgICAgICAgICAgICAgICBjb25zdCBwYXJzZWRIdG1sID0gbmV3IERPTVBhcnNlcigpLnBhcnNlRnJvbVN0cmluZyhtYXRjaFsxXSwgJ3RleHQvaHRtbCcpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGZ1bGwgPSAocGFyc2VkSHRtbC5ib2R5LnRleHRDb250ZW50IHx8ICcnKS50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1hcmtlcnMgPSB7XG4gICAgICAgICAgICAgICAgICAgIHRvZGF5OiAgICBbJ/Cfk4XQodCV0JPQntCU0J3Qr1/QndCQ0KfQkNCb0J7wn5OFJywgJ/Cfk4XQodCV0JPQntCU0J3Qr1/QmtCe0J3QldCm8J+ThSddLFxuICAgICAgICAgICAgICAgICAgICB0b21vcnJvdzogWyfwn5OF0JfQkNCS0KLQoNCQX9Cd0JDQp9CQ0JvQnvCfk4UnLCAn8J+ThdCX0JDQktCi0KDQkF/QmtCe0J3QldCm8J+ThSddXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBjb25zdCBbc20sIGVtXSA9IG1hcmtlcnNbZGF5XTtcbiAgICAgICAgICAgICAgICBjb25zdCBzaSA9IGZ1bGwuaW5kZXhPZihzbSksIGVpID0gZnVsbC5pbmRleE9mKGVtKTtcbiAgICAgICAgICAgICAgICBpZiAoc2kgPT09IC0xIHx8IGVpIDw9IHNpKSB0aHJvdyBuZXcgRXJyb3IoJ9CU0LDQvdC90YvQtSDQvdC1INC90LDQudC00LXQvdGLJyk7XG4gICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IGZ1bGwuc3Vic3RyaW5nKHNpLCBlaSkucmVwbGFjZShzbSwgJycpLnJlcGxhY2UoZW0sICcnKS50cmltKCk7XG4gICAgICAgICAgICAgICAgaWYgKHRleHQubWF0Y2goL1xcZHsyfVxcLlxcZHsyfVxcLlxcZHs0fS8pPy5bMF0gIT09IHRhcmdldERhdGUuc3BsaXQoJy0nKS5yZXZlcnNlKCkuam9pbignLicpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign0JTQsNGC0LAg0YDQsNGB0L/QuNGB0LDQvdC40Y8g0L3QtSDRgdC+0L7RgtCy0LXRgtGB0YLQstGD0LXRgiDQstGL0LHRgNCw0L3QvdC+0LzRgyDQtNC90Y4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmVzb2x2ZSh7XG4gICAgICAgICAgICAgICAgICAgIHJhd1RleHQ6IHRleHQsXG4gICAgICAgICAgICAgICAgICAgIHBhcnNlZDogcGFyc2VTY2hlZHVsZUxpbmVzKHRleHQsIHJlcGxhY2VtZW50cywgZGF5KSxcbiAgICAgICAgICAgICAgICAgICAgdGV4dENvcHk6IGZvcm1hdE91dHB1dFdpdGhSZXBsYWNlbWVudHModGV4dCwgcmVwbGFjZW1lbnRzLCBkYXkpXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIG9uZXJyb3IoKSB7IHJlamVjdChuZXcgRXJyb3IoJ9Ce0YjQuNCx0LrQsCDRgdC10YLQuCDQv9GA0Lgg0LfQsNCz0YDRg9C30LrQtSDRgNCw0YHQv9C40YHQsNC90LjRjycpKTsgfSxcbiAgICAgICAgb250aW1lb3V0KCkgeyByZWplY3QobmV3IEVycm9yKCfQktGA0LXQvNGPINC+0LbQuNC00LDQvdC40Y8g0YDQsNGB0L/QuNGB0LDQvdC40Y8g0LjRgdGC0LXQutC70L4nKSk7IH0sXG4gICAgICAgIG9uYWJvcnQoKSB7IHJlamVjdChuZXcgRXJyb3IoJ9CX0LDQs9GA0YPQt9C60LAg0YDQsNGB0L/QuNGB0LDQvdC40Y8g0L7RgtC80LXQvdC10L3QsCcpKTsgfVxuICAgIH0pKTtcbn1cblxuLy8g0KDQsNC30LHQuNGA0LDQtdGCINGA0LDRgdC/0LjRgdCw0L3QuNC1INC90LAg0LPRgNGD0L/Qv9GLINC/0L4g0LPQvtGA0L7QtNCw0LwuINCS0YXQvtC0IOKAlCDCq9C/0L7Rh9GC0Lgg0L7QtNC90LAg0YHRgtGA0L7QutCwwrsg0YFcbi8vINC80LDRgNC60LXRgNCw0LzQuDog8J+Poi/wn4+ZINC90LDRh9C40L3QsNGO0YIg0LPQvtGA0L7QtCwg8J+RpCDigJQg0YfQtdC70L7QstC10LrQsC4g0KDQsNC30LTQtdC70LjRgtC10LvQuCDRgdGC0YDQvtC6INC90LUg0L3Rg9C20L3Riy5cbi8vICAgW3sgY2l0eSwgcm93czogW3sgcGVyc29uLCBzdG9yZSB9XSB9XVxuZnVuY3Rpb24gcGFyc2VTY2hlZHVsZUxpbmVzKHRleHQsIHJlcGxhY2VtZW50cywgZGF5KSB7XG4gICAgY29uc3QgZGF0ZU1hdGNoID0gdGV4dC5tYXRjaCgvKFxcZHsyfVxcLlxcZHsyfVxcLlxcZHs0fSkvKTtcbiAgICBjb25zdCBkYXRlU3RyID0gZGF0ZU1hdGNoID8gZGF0ZU1hdGNoWzFdIDogJyc7XG4gICAgbGV0IGNsZWFuZWQgPSB0ZXh0LnJlcGxhY2UoZGF0ZVN0ciwgJycpLnJlcGxhY2UoL/Cfk4UvZywgJycpLnJlcGxhY2UoL1xcfC9nLCAnIC0gJykudHJpbSgpO1xuXG4gICAgY29uc3QgZ3JvdXBzID0gW107XG4gICAgbGV0IGN1cnJlbnQgPSBudWxsO1xuXG4gICAgLy8g0KDQtdC20LXQvCDQv9C+INC80LDRgNC60LXRgNCw0LwsINGB0L7RhdGA0LDQvdGP0Y8g0LjRhSDQsiDQvdCw0YfQsNC70LUg0YLQvtC60LXQvdCwXG4gICAgY29uc3QgdG9rZW5zID0gY2xlYW5lZC5zcGxpdCgvKD898J+Ponzwn4+ZfPCfkaQpLykubWFwKHQgPT4gdC50cmltKCkpLmZpbHRlcihCb29sZWFuKTtcblxuICAgIHRva2Vucy5mb3JFYWNoKHRva2VuID0+IHtcbiAgICAgICAgaWYgKC9e8J+Ponxe8J+PmS8udGVzdCh0b2tlbikpIHtcbiAgICAgICAgICAgIGNvbnN0IGNpdHkgPSB0b2tlbi5yZXBsYWNlKC9e8J+Ponxe8J+PmS8sICcnKVxuICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9e0JIg0LPQvtGA0L7QtNC1XFxzKi9pLCAnJylcbiAgICAgICAgICAgICAgICAudHJpbSgpIHx8ICfigJQnO1xuICAgICAgICAgICAgY3VycmVudCA9IHsgY2l0eSwgcm93czogW10gfTtcbiAgICAgICAgICAgIGdyb3Vwcy5wdXNoKGN1cnJlbnQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICgvXvCfkaQvLnRlc3QodG9rZW4pKSB7XG4gICAgICAgICAgICBjb25zdCBib2R5ID0gdG9rZW4ucmVwbGFjZSgvXvCfkaRcXHMqLywgJycpO1xuICAgICAgICAgICAgY29uc3QgW2luZm8sIHZhbHVlXSA9IGJvZHkuaW5jbHVkZXMoJyAtICcpID8gYm9keS5zcGxpdCgnIC0gJykgOiBbYm9keSwgJyddO1xuICAgICAgICAgICAgLy8g0JjQvNGPINC4IGVtYWlsINGH0LDRgdGC0L4g0YHQutC70LXQtdC90Ysg0LHQtdC3INC/0YDQvtCx0LXQu9CwOiDCq9Cg0YPRgdC70LDQvW1pbGliYWV2QHNrbDRkbcK7XG4gICAgICAgICAgICBjb25zdCBwZXJzb24gPSBpbmZvXG4gICAgICAgICAgICAgICAgLnJlcGxhY2UoLyhb0LAt0Y/QkC3Qr9CB0ZFdKShbYS16QS1aQF0pL2csICckMSAkMicpXG4gICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xccysvZywgJyAnKVxuICAgICAgICAgICAgICAgIC50cmltKCk7XG4gICAgICAgICAgICBsZXQgc3RvcmUgPSAodmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChzdG9yZSAmJiByZXBsYWNlbWVudHNbc3RvcmVdKSBzdG9yZSA9IHJlcGxhY2VtZW50c1tzdG9yZV07XG4gICAgICAgICAgICBpZiAoIWN1cnJlbnQpIHsgY3VycmVudCA9IHsgY2l0eTogJ+KAlCcsIHJvd3M6IFtdIH07IGdyb3Vwcy5wdXNoKGN1cnJlbnQpOyB9XG4gICAgICAgICAgICBjdXJyZW50LnJvd3MucHVzaCh7IHBlcnNvbjogcGVyc29uIHx8ICfigJQnLCBzdG9yZTogc3RvcmUgfHwgJ+KAlCcgfSk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiB7IGRhdGVTdHIsIGdyb3VwcyB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJTY2hlZHVsZVRhYihkYXkpIHtcbiAgICBjb25zdCBwYW5lID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jU3BlY2lhbFBhbmUnKTtcbiAgICBpZiAoIXBhbmUgfHwgY3VycmVudEFjdGlvbiAhPT0gZGF5KSByZXR1cm47XG4gICAgY29uc3Qgc3RhdGUgPSBzY2hlZHVsZVN0YXRlQnlEYXlbZGF5XTtcbiAgICBpZiAoc3RhdGUuc25hcHNob3QgJiYgc3RhdGUuc25hcHNob3QudGFyZ2V0RGF0ZSAhPT0gc2NoZWR1bGVUYXJnZXREYXRlKGRheSkpIHtcbiAgICAgICAgc3RhdGUuc25hcHNob3QgPSBudWxsO1xuICAgICAgICBzdGF0ZS5wYXJzZWQgPSBudWxsO1xuICAgICAgICBzdGF0ZS50ZXh0Q29weSA9ICcnO1xuICAgICAgICBzdGF0ZS51cGRhdGVkQXQgPSAwO1xuICAgIH1cbiAgICBjb25zdCBkYXlOYW1lID0gZGF5ID09PSAndG9kYXknID8gJ9Ch0LXQs9C+0LTQvdGPJyA6ICfQl9Cw0LLRgtGA0LAnO1xuICAgIHBhbmUucmVwbGFjZUNoaWxkcmVuKCk7XG5cbiAgICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgdG9vbGJhci5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjZweDtmbGV4OjAgMCBhdXRvOyc7XG4gICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9IGAke2RheSA9PT0gJ3RvZGF5JyA/ICfwn5+iJyA6ICfwn5+hJ30gJHtkYXlOYW1lfSR7c3RhdGUucGFyc2VkPy5kYXRlU3RyID8gYCDigJQgJHtzdGF0ZS5wYXJzZWQuZGF0ZVN0cn1gIDogJyd9YDtcbiAgICB0aXRsZS5zdHlsZS5jc3NUZXh0ID0gJ2ZsZXg6MTtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMnB4Oyc7XG4gICAgdG9vbGJhci5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gICAgY29uc3QgcmVmcmVzaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIHJlZnJlc2gudHlwZSA9ICdidXR0b24nO1xuICAgIHJlZnJlc2guY2xhc3NOYW1lID0gJ21jLWJ0biBtYy1idG4tYmx1ZSc7XG4gICAgcmVmcmVzaC50ZXh0Q29udGVudCA9IHN0YXRlLmxvYWRpbmcgPyAn4o+zJyA6ICfihrsg0J7QsdC90L7QstC40YLRjCc7XG4gICAgcmVmcmVzaC5kaXNhYmxlZCA9IHN0YXRlLmxvYWRpbmc7XG4gICAgcmVmcmVzaC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGZldGNoV2hvV29ya3MoZGF5LCB7IGZvcmNlOiB0cnVlIH0pKTtcbiAgICB0b29sYmFyLmFwcGVuZENoaWxkKHJlZnJlc2gpO1xuICAgIHBhbmUuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbWV0YS5zdHlsZS5jc3NUZXh0ID0gJ2ZvbnQtc2l6ZTo5LjVweDtjb2xvcjojOTRhM2I4Oyc7XG4gICAgbWV0YS50ZXh0Q29udGVudCA9IHN0YXRlLnVwZGF0ZWRBdFxuICAgICAgICA/IGDQntCx0L3QvtCy0LvQtdC90L4gJHtuZXcgRGF0ZShzdGF0ZS51cGRhdGVkQXQpLnRvTG9jYWxlVGltZVN0cmluZygncnUtUlUnLCB7IGhvdXI6ICcyLWRpZ2l0JywgbWludXRlOiAnMi1kaWdpdCcgfSl9JHtzdGF0ZS5lcnJvciA/ICcgwrcg0LTQsNC90L3Ri9C1INC80L7Qs9GD0YIg0LHRi9GC0Ywg0YPRgdGC0LDRgNC10LLRiNC40LzQuCcgOiAnJ31gXG4gICAgICAgIDogJ9Cd0LDQttC80LjRgtC1IMKr0J7QsdC90L7QstC40YLRjMK7LCDRh9GC0L7QsdGLINC30LDQs9GA0YPQt9C40YLRjCDRgNCw0YHQv9C40YHQsNC90LjQtSc7XG4gICAgcGFuZS5hcHBlbmRDaGlsZChtZXRhKTtcblxuICAgIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBsaXN0LnN0eWxlLmNzc1RleHQgPSAnZmxleDoxIDEgYXV0bztvdmVyZmxvdy15OmF1dG87bWluLWhlaWdodDo4MHB4Oyc7XG4gICAgaWYgKHN0YXRlLmVycm9yKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGVycm9yLmNsYXNzTmFtZSA9ICdtYy1vdmVybGF5LWVycm9yJztcbiAgICAgICAgZXJyb3IudGV4dENvbnRlbnQgPSBzdGF0ZS5lcnJvcjtcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChlcnJvcik7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5wYXJzZWQ/Lmdyb3Vwcz8ubGVuZ3RoKSB7XG4gICAgICAgIHN0YXRlLnBhcnNlZC5ncm91cHMuZm9yRWFjaChncm91cCA9PiB7XG4gICAgICAgICAgICBjb25zdCBjaXR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICBjaXR5LmNsYXNzTmFtZSA9ICdtYy1zY2hlZC1jaXR5JztcbiAgICAgICAgICAgIGNpdHkudGV4dENvbnRlbnQgPSBg8J+PmSAke2dyb3VwLmNpdHl9YDtcbiAgICAgICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoY2l0eSk7XG4gICAgICAgICAgICBncm91cC5yb3dzLmZvckVhY2goaXRlbSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdtYy1zY2hlZC1yb3cnO1xuICAgICAgICAgICAgICAgIHJvdy50ZXh0Q29udGVudCA9IGDwn5GkICR7aXRlbS5wZXJzb259IOKAlCAke2l0ZW0uc3RvcmV9YDtcbiAgICAgICAgICAgICAgICBsaXN0LmFwcGVuZENoaWxkKHJvdyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIHBhbmUuYXBwZW5kQ2hpbGQobGlzdCk7XG5cbiAgICBpZiAoc3RhdGUudGV4dENvcHkpIHtcbiAgICAgICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBjb3B5LnR5cGUgPSAnYnV0dG9uJztcbiAgICAgICAgY29weS5jbGFzc05hbWUgPSAnbWMtYnRuIG1jLWJ0bi1zbGF0ZSc7XG4gICAgICAgIGNvcHkudGV4dENvbnRlbnQgPSAn8J+TiyDQmtC+0L/QuNGA0L7QstCw0YLRjCc7XG4gICAgICAgIGNvcHkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBjb3B5SGF0aWtvVGV4dChzdGF0ZS50ZXh0Q29weSkpO1xuICAgICAgICBwYW5lLmFwcGVuZENoaWxkKGNvcHkpO1xuICAgIH1cbn1cblxuLy8g0J/Qu9Cw0LLQsNGO0YnQtdC1INC/0LXRgNC10YLQsNGB0LrQuNCy0LDQtdC80L7QtSDQvtC60L3QviDRgdC+INGB0L/QuNGB0LrQvtC8IMKr0JrRgtC+L9CT0LTQtcK7ICjQsdC10Lcg0LfQsNGC0LXQvNC90LXQvdC40Y8pLlxuZnVuY3Rpb24gb3BlblNjaGVkdWxlVGFibGVXaW5kb3coZGF5LCBwYXJzZWQsIHRleHRDb3B5KSB7XG4gICAgY2xvc2VNZW1jaGF0T3ZlcmxheSgpO1xuXG4gICAgY29uc3QgZGF5TmFtZSA9IGRheSA9PT0gJ3RvZGF5JyA/ICfQodC10LPQvtC00L3RjycgOiAn0JfQsNCy0YLRgNCwJztcbiAgICBjb25zdCB3aW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgd2luLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC13aW5kb3cnO1xuICAgICAgICBhcHBseUZsb2F0V2luZG93UG9zKHdpbik7XG5cbiAgICAvLyDilIDilIAg0JfQsNCz0L7Qu9C+0LLQvtC6ICjQt9CwINC90LXQs9C+INC80L7QttC90L4g0YLQsNGB0LrQsNGC0YwpIOKUgOKUgFxuICAgIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhlYWRlci5jbGFzc05hbWUgPSAnbWMtZmxvYXQtaGVhZGVyJztcbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRpdGxlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC10aXRsZSc7XG4gICAgdGl0bGUudGV4dENvbnRlbnQgPSBg8J+ThSAke2RheU5hbWV9JHtwYXJzZWQ/LmRhdGVTdHIgPyAnIOKAlCAnICsgcGFyc2VkLmRhdGVTdHIgOiAnJ31gO1xuICAgIGhlYWRlci5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gICAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBjbG9zZS50eXBlID0gJ2J1dHRvbic7XG4gICAgY2xvc2UuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWNsb3NlJztcbiAgICBjbG9zZS50ZXh0Q29udGVudCA9ICfinJUnO1xuICAgIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgY2xvc2VNZW1jaGF0T3ZlcmxheSk7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKGNsb3NlKTtcbiAgICB3aW4uYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICAgIC8vIOKUgOKUgCDQotC10LvQvjog0YHQv9C40YHQvtC6INC/0L4g0LPQvtGA0L7QtNCw0Lwg0LjQu9C4INC+0YjQuNCx0LrQsCDilIDilIBcbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm9keS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtYm9keSc7XG4gICAgaWYgKCFwYXJzZWQgfHwgIXBhcnNlZC5ncm91cHMubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGVyciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBlcnIuc3R5bGUuY3NzVGV4dCA9ICdjb2xvcjojOTkxYjFiO2JhY2tncm91bmQ6I2ZlZTJlMjtib3JkZXI6MXB4IHNvbGlkICNmZWNhY2E7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6MTBweDtmb250LXNpemU6MTJweDsnO1xuICAgICAgICBlcnIudGV4dENvbnRlbnQgPSB0ZXh0Q29weSB8fCAn0J3QtdGCINC00LDQvdC90YvRhSc7XG4gICAgICAgIGJvZHkuYXBwZW5kQ2hpbGQoZXJyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBwYXJzZWQuZ3JvdXBzLmZvckVhY2goZ3JvdXAgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2l0eUhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgY2l0eUhlYWRlci5jbGFzc05hbWUgPSAnbWMtc2NoZWQtY2l0eSc7XG4gICAgICAgICAgICBjaXR5SGVhZGVyLnRleHRDb250ZW50ID0gYPCfj5kgJHtncm91cC5jaXR5fWA7XG4gICAgICAgICAgICBib2R5LmFwcGVuZENoaWxkKGNpdHlIZWFkZXIpO1xuICAgICAgICAgICAgZ3JvdXAucm93cy5mb3JFYWNoKHJvdyA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICAgICAgICAgIGxpbmUuY2xhc3NOYW1lID0gJ21jLXNjaGVkLXJvdyc7XG4gICAgICAgICAgICAgICAgbGluZS50ZXh0Q29udGVudCA9IGDwn5GkICR7cm93LnBlcnNvbn0g4oCUICR7cm93LnN0b3JlfWA7XG4gICAgICAgICAgICAgICAgYm9keS5hcHBlbmRDaGlsZChsaW5lKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgd2luLmFwcGVuZENoaWxkKGJvZHkpO1xuXG4gICAgLy8g4pSA4pSAINCf0L7QtNCy0LDQuzog0LrQvtC/0LjRgNC+0LLQsNGC0Ywg0YLQtdC60YHRgiDilIDilIBcbiAgICBjb25zdCBmb290ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBmb290ZXIuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWZvb3Rlcic7XG4gICAgY29uc3QgY29weUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGNvcHlCdG4udHlwZSA9ICdidXR0b24nO1xuICAgIGNvcHlCdG4uY2xhc3NOYW1lID0gJ21jLWJ0biBtYy1idG4tYmx1ZSc7XG4gICAgY29weUJ0bi50ZXh0Q29udGVudCA9ICfwn5OLINCa0L7Qv9C40YDQvtCy0LDRgtGMINGC0LXQutGB0YInO1xuICAgIGNvcHlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGNvcHlIYXRpa29UZXh0KHRleHRDb3B5IHx8ICcnKTtcbiAgICAgICAgY29weUJ0bi50ZXh0Q29udGVudCA9ICfinIUg0KHQutC+0L/QuNGA0L7QstCw0L3Qvic7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBjb3B5QnRuLnRleHRDb250ZW50ID0gJ/Cfk4sg0JrQvtC/0LjRgNC+0LLQsNGC0Ywg0YLQtdC60YHRgic7IH0sIDEyMDApO1xuICAgIH0pO1xuICAgIGZvb3Rlci5hcHBlbmRDaGlsZChjb3B5QnRuKTtcbiAgICB3aW4uYXBwZW5kQ2hpbGQoZm9vdGVyKTtcblxuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQod2luKTtcbiAgICBtYWtlTW92YWJsZSh3aW4sIGhlYWRlcik7XG59XG5cbmZ1bmN0aW9uIGNsb3NlTWVtY2hhdE92ZXJsYXkoKSB7XG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm1jLW92ZXJsYXksIC5tYy1mbG9hdC13aW5kb3cnKS5mb3JFYWNoKGVsID0+IGVsLnJlbW92ZSgpKTtcbn1cblxuLy8g0J/RgNC40LzQtdC90Y/QtdGCINGB0L7RhdGA0LDQvdGR0L3QvdGD0Y4g0L/QvtC30LjRhtC40Y4g0Log0L/Qu9Cw0LLQsNGO0YnQtdC80YMg0L7QutC90YMgKNC10YHQu9C4INC10YHRgtGMKS5cbmZ1bmN0aW9uIGFwcGx5RmxvYXRXaW5kb3dQb3MoZWwpIHtcbiAgICBjb25zdCBwb3MgPSBsb2FkRmxvYXRXaW5kb3dQb3MoKTtcbiAgICBpZiAoIXBvcykgcmV0dXJuO1xuICAgIGVsLnN0eWxlLmxlZnQgPSBgJHtwb3MubGVmdH1weGA7XG4gICAgZWwuc3R5bGUudG9wID0gYCR7cG9zLnRvcH1weGA7XG4gICAgZWwuc3R5bGUucmlnaHQgPSAnYXV0byc7XG59XG5cbi8vINCU0LXQu9Cw0LXRgiDQvtC60L3QviDQv9C10YDQtdGC0LDRgdC60LjQstCw0LXQvNGL0Lwg0LfQsCDQv9C10YDQtdC00LDQvdC90YvQuSDRjdC70LXQvNC10L3Rgi3Qt9Cw0LPQvtC70L7QstC+0LouXG4vLyDQn9C+0LfQuNGG0LjRjyDQv9C70LDQstCw0Y7RidC40YUg0L7QutC+0L0g0YHQvtGF0YDQsNC90Y/QtdGC0YHRjyDQsiBsb2NhbFN0b3JhZ2UuXG5mdW5jdGlvbiBtYWtlTW92YWJsZShlbCwgaGFuZGxlKSB7XG4gICAgaGFuZGxlLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsIGUgPT4ge1xuICAgICAgICBpZiAoZS50YXJnZXQuY2xvc2VzdCgnYnV0dG9uLCBpbnB1dCwgc2VsZWN0LCBhJykpIHJldHVybjtcbiAgICAgICAgY29uc3QgcmVjdCA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICBjb25zdCBvZmZzZXRYID0gZS5jbGllbnRYIC0gcmVjdC5sZWZ0O1xuICAgICAgICBjb25zdCBvZmZzZXRZID0gZS5jbGllbnRZIC0gcmVjdC50b3A7XG4gICAgICAgIGNvbnN0IG9uTW92ZSA9IGV2ID0+IHtcbiAgICAgICAgICAgIGVsLnN0eWxlLmxlZnQgPSBgJHtNYXRoLm1heCgwLCBldi5jbGllbnRYIC0gb2Zmc2V0WCl9cHhgO1xuICAgICAgICAgICAgZWwuc3R5bGUudG9wID0gYCR7TWF0aC5tYXgoMCwgZXYuY2xpZW50WSAtIG9mZnNldFkpfXB4YDtcbiAgICAgICAgICAgIGVsLnN0eWxlLnJpZ2h0ID0gJ2F1dG8nO1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBvblVwID0gKCkgPT4ge1xuICAgICAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgb25Nb3ZlKTtcbiAgICAgICAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNldXAnLCBvblVwKTtcbiAgICAgICAgICAgIGlmIChlbC5jbGFzc0xpc3QuY29udGFpbnMoJ21jLWZsb2F0LXdpbmRvdycpKSB7XG4gICAgICAgICAgICAgICAgc2F2ZUZsb2F0V2luZG93UG9zKGVsLnN0eWxlLmxlZnQsIGVsLnN0eWxlLnRvcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIG9uTW92ZSk7XG4gICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNldXAnLCBvblVwKTtcbiAgICB9KTtcbn1cblxuLy8g0KLQtdC60YHRgtC+0LLRi9C5INGE0L7RgNC80LDRgiAo0LTQu9GPIMKr0JrQvtC/0LjRgNC+0LLQsNGC0Ywg0YLQtdC60YHRgsK7INC4INGB0L7QstC80LXRgdGC0LjQvNC+0YHRgtC4INGB0L4g0YHRgtCw0YDRi9C8INCy0YvQstC+0LTQvtC8KS5cbmZ1bmN0aW9uIGZvcm1hdE91dHB1dFdpdGhSZXBsYWNlbWVudHModGV4dCwgcmVwbGFjZW1lbnRzLCBkYXkpIHtcbiAgICBjb25zdCBkYXRlTWF0Y2ggPSB0ZXh0Lm1hdGNoKC8oXFxkezJ9XFwuXFxkezJ9XFwuXFxkezR9KS8pO1xuICAgIGNvbnN0IGRhdGVTdHIgPSBkYXRlTWF0Y2ggPyBkYXRlTWF0Y2hbMV0gOiAnJztcbiAgICBpZiAoZGF0ZVN0cikgdGV4dCA9IHRleHQucmVwbGFjZShkYXRlU3RyLCAnJykudHJpbSgpO1xuXG4gICAgbGV0IGZvcm1hdHRlZCA9IHRleHRcbiAgICAgICAgLnJlcGxhY2UoL/Cfj6IgL2csICdcXG5cXG7wn4+iINCSINCz0L7RgNC+0LTQtSAnKVxuICAgICAgICAucmVwbGFjZSgv8J+RpCAvZywgJ1xcbvCfkaQgJylcbiAgICAgICAgLnJlcGxhY2UoL1xcfC9nLCAnIC0gJylcbiAgICAgICAgLnRyaW0oKTtcblxuICAgIGNvbnN0IGxpbmVzID0gZm9ybWF0dGVkLnNwbGl0KCdcXG4nKS5maWx0ZXIobCA9PiBsLnRyaW0oKSk7XG4gICAgY29uc3QgcHJvY2Vzc2VkID0gbGluZXMubWFwKGxpbmUgPT4ge1xuICAgICAgICBpZiAoIWxpbmUuc3RhcnRzV2l0aCgn8J+RpCcpKSByZXR1cm4gbGluZTtcbiAgICAgICAgbGV0IFtpbmZvLCB2YWx1ZV0gPSBsaW5lLmluY2x1ZGVzKCcgLSAnKSA/IGxpbmUuc3BsaXQoJyAtICcpIDogW2xpbmUsICcnXTtcbiAgICAgICAgaW5mbyA9IGluZm8ucmVwbGFjZSgv8J+RpFxccyovLCAn8J+RpCAnKVxuICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8oW9CwLdGP0JAt0K9dKShbYS16QS1aQF0pL2csICckMSAkMicpXG4gICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xccysvZywgJyAnKVxuICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXC4oW2EtekEtWl0pL2csICcuICQxJykudHJpbSgpO1xuICAgICAgICB2YWx1ZSA9ICh2YWx1ZSB8fCAnJykudHJpbSgpO1xuICAgICAgICBpZiAodmFsdWUgJiYgcmVwbGFjZW1lbnRzW3ZhbHVlXSkgdmFsdWUgPSByZXBsYWNlbWVudHNbdmFsdWVdO1xuICAgICAgICByZXR1cm4gdmFsdWUgPyBgJHtpbmZvfSAtICR7dmFsdWV9YCA6IGluZm87XG4gICAgfSk7XG5cbiAgICBjb25zdCBkYXlOYW1lID0gZGF5ID09PSAndG9kYXknID8gJ9Ch0LXQs9C+0LTQvdGPJyA6ICfQl9Cw0LLRgtGA0LAnO1xuICAgIHJldHVybiBg8J+ThSAke2RheU5hbWV9ICgke2RhdGVTdHJ9KVxcblxcbiR7cHJvY2Vzc2VkLmpvaW4oJ1xcbicpfWA7XG59IiwiLy8g4pSA4pSA4pSAINCf0LXRgNC10YLQsNGB0LrQuNCy0LDQvdC40LUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBzdGFydERyYWcoZSkge1xuICAgIGlmIChlLnRhcmdldC5jbG9zZXN0KCdidXR0b24sIGlucHV0LCB0ZXh0YXJlYSwgc2VsZWN0JykpIHJldHVybjtcbiAgICBpc0RyYWdnaW5nID0gdHJ1ZTtcbiAgICBjb25zdCByZWN0ID0gd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgb2Zmc2V0LnggPSBlLmNsaWVudFggLSByZWN0LmxlZnQ7XG4gICAgb2Zmc2V0LnkgPSBlLmNsaWVudFkgLSByZWN0LnRvcDtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZW1vdmUnLCBkcmFnKTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgc3RvcERyYWcpO1xufVxuZnVuY3Rpb24gZHJhZyhlKSB7XG4gICAgaWYgKCFpc0RyYWdnaW5nKSByZXR1cm47XG4gICAgd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIuc3R5bGUucmlnaHQgPSAnYXV0byc7XG4gICAgd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIuc3R5bGUubGVmdCAgPSBgJHtlLmNsaWVudFggLSBvZmZzZXQueH1weGA7XG4gICAgd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIuc3R5bGUudG9wICAgPSBgJHtlLmNsaWVudFkgLSBvZmZzZXQueX1weGA7XG59XG5mdW5jdGlvbiBzdG9wRHJhZygpIHtcbiAgICBpc0RyYWdnaW5nID0gZmFsc2U7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgZHJhZyk7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2V1cCcsIHN0b3BEcmFnKTtcbn1cblxuLy8g4pSA4pSA4pSAINCf0LDQvdC10LvRjCDQv9GA0LDQstC40Lsg0LrQsNC70YzQutGD0LvRj9GC0L7RgNCwIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gYnVpbGRDYWxjUnVsZXNQYW5lbCgpIHtcbiAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYWxjUnVsZXNQYW5lbCcpO1xuICAgIGlmICghcGFuZWwpIHJldHVybjtcbiAgICBwYW5lbC5pbm5lckhUTUwgPSAnJztcblxuICAgIGNvbnN0IGhkciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhkci5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDcycHggNzJweCA4OHB4IDMwcHg7Z2FwOjRweDttYXJnaW4tYm90dG9tOjZweDtmb250LXNpemU6MTBweDtmb250LXdlaWdodDo3MDA7Y29sb3I6IzQ3NTU2OTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjRweDsnO1xuICAgIGhkci5pbm5lckhUTUwgPSAnPHNwYW4+0J3QsNC30LLQsNC90LjQtTwvc3Bhbj48c3Bhbj4lPC9zcGFuPjxzcGFuPtCe0LrRgNGD0LPQuy48L3NwYW4+PHNwYW4+0JTQvtC/Ljwvc3Bhbj48c3Bhbj48L3NwYW4+JztcbiAgICBwYW5lbC5hcHBlbmRDaGlsZChoZHIpO1xuXG4gICAgY2FsY1J1bGVzLmZvckVhY2goKHJ1bGUsIGkpID0+IHtcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHJvdy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIDcycHggNzJweCA4OHB4IDMwcHg7Z2FwOjRweDttYXJnaW4tYm90dG9tOjRweDthbGlnbi1pdGVtczpjZW50ZXI7JztcblxuICAgICAgICBjb25zdCBta0lucCA9ICh2YWwsIHBsYWNlaG9sZGVyLCBmaWVsZCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgaW5wID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICAgICAgICAgIGlucC50eXBlID0gJ3RleHQnOyBpbnAudmFsdWUgPSB2YWw7IGlucC5wbGFjZWhvbGRlciA9IHBsYWNlaG9sZGVyO1xuICAgICAgICAgICAgaW5wLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MTAwJTtwYWRkaW5nOjNweCA2cHg7YmFja2dyb3VuZDojMWUyOTNiO2JvcmRlcjoxcHggc29saWQgIzMzNDE1NTtib3JkZXItcmFkaXVzOjZweDtjb2xvcjojZTJlOGYwO2ZvbnQtc2l6ZToxMXB4O2JveC1zaXppbmc6Ym9yZGVyLWJveDtvdXRsaW5lOm5vbmU7dHJhbnNpdGlvbjpib3JkZXIgLjE1czsnO1xuICAgICAgICAgICAgaW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2ZvY3VzJywgKCkgPT4gaW5wLnN0eWxlLmJvcmRlckNvbG9yID0gJyM2MzY2ZjEnKTtcbiAgICAgICAgICAgIGlucC5hZGRFdmVudExpc3RlbmVyKCdibHVyJywgICgpID0+IGlucC5zdHlsZS5ib3JkZXJDb2xvciA9ICcjMzM0MTU1Jyk7XG4gICAgICAgICAgICBpbnAuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgY2FsY1J1bGVzW2ldW2ZpZWxkXSA9IGZpZWxkID09PSAnbmFtZScgPyBpbnAudmFsdWUgOiAocGFyc2VGbG9hdChpbnAudmFsdWUpIHx8IDApO1xuICAgICAgICAgICAgICAgIHNhdmVDYWxjUnVsZXMoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGlucDtcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCBkZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgZGVsLnRleHRDb250ZW50ID0gJ+KclSc7XG4gICAgICAgIGRlbC5zdHlsZS5jc3NUZXh0ID0gJ3dpZHRoOjI2cHg7aGVpZ2h0OjI0cHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkICNlZjQ0NDQ7Ym9yZGVyLXJhZGl1czo1cHg7Y29sb3I6I2VmNDQ0NDtmb250LXNpemU6MTBweDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOmFsbCAuMTVzOyc7XG4gICAgICAgIGRlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4geyBkZWwuc3R5bGUuYmFja2dyb3VuZD0nI2VmNDQ0NCc7IGRlbC5zdHlsZS5jb2xvcj0nI2ZmZic7IH0pO1xuICAgICAgICBkZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IHsgZGVsLnN0eWxlLmJhY2tncm91bmQ9J3RyYW5zcGFyZW50JzsgZGVsLnN0eWxlLmNvbG9yPScjZWY0NDQ0JzsgfSk7XG4gICAgICAgIGRlbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgY2FsY1J1bGVzLnNwbGljZShpLDEpOyBzYXZlQ2FsY1J1bGVzKCk7IGJ1aWxkQ2FsY1J1bGVzUGFuZWwoKTsgfSk7XG5cbiAgICAgICAgY29uc3QgZXh0cmFWYWwgPSBydWxlLmV4dHJhICE9PSB1bmRlZmluZWQgPyAocnVsZS5leHRyYSA+PSAwID8gJysnICsgcnVsZS5leHRyYSA6IFN0cmluZyhydWxlLmV4dHJhKSkgOiAnMCc7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChta0lucChydWxlLm5hbWUsICfQndCw0LfQstCw0L3QuNC1JywgJ25hbWUnKSk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChta0lucChydWxlLnBlcmNlbnQsICclJywgJ3BlcmNlbnQnKSk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZChta0lucChydWxlLnJvdW5kLCAn0J7QutGA0YPQs9C7LicsICdyb3VuZCcpKTtcbiAgICAgICAgcm93LmFwcGVuZENoaWxkKG1rSW5wKGV4dHJhVmFsLCAnKy8tMCcsICdleHRyYScpKTtcbiAgICAgICAgcm93LmFwcGVuZENoaWxkKGRlbCk7XG4gICAgICAgIHBhbmVsLmFwcGVuZENoaWxkKHJvdyk7XG4gICAgfSk7XG5cbiAgICBfYXBwZW5kUnVsZXNQYW5lbEZvb3RlcihwYW5lbCwgJ2NhbGMnKTtcbn1cblxuLy8g4pSA4pSA4pSAINCf0LDQvdC10LvRjCDQt9Cw0LzQtdC9INGA0LDRgdC/0LjRgdCw0L3QuNGPIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gYnVpbGRTY2hlZHVsZVBhbmVsKCkge1xuICAgIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjaGVkdWxlUnVsZXNQYW5lbCcpO1xuICAgIGlmICghcGFuZWwpIHJldHVybjtcbiAgICBwYW5lbC5pbm5lckhUTUwgPSAnJztcblxuICAgIGNvbnN0IGhkciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGhkci5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MTAwcHggMWZyIDI4cHg7Z2FwOjRweDttYXJnaW4tYm90dG9tOjZweDtmb250LXNpemU6MTBweDtmb250LXdlaWdodDo3MDA7Y29sb3I6IzQ3NTU2OTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjRweDsnO1xuICAgIGhkci5pbm5lckhUTUwgPSAnPHNwYW4+0JrQu9GO0Yc8L3NwYW4+PHNwYW4+0JfQvdCw0YfQtdC90LjQtSAo0LfQsNC80LXQvdCwKTwvc3Bhbj48c3Bhbj48L3NwYW4+JztcbiAgICBwYW5lbC5hcHBlbmRDaGlsZChoZHIpO1xuXG4gICAgT2JqZWN0LmVudHJpZXMoc2NoZWR1bGVSZXBsYWNlbWVudHMpLmZvckVhY2goKFtrZXksIHZhbF0pID0+IHtcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHJvdy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MTAwcHggMWZyIDI4cHg7Z2FwOjRweDttYXJnaW4tYm90dG9tOjRweDthbGlnbi1pdGVtczpjZW50ZXI7JztcblxuICAgICAgICBjb25zdCBta0lucCA9ICh2LCBwaCwgb25DaGFuZ2UpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGlucCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgICAgICAgICBpbnAudHlwZSA9ICd0ZXh0JzsgaW5wLnZhbHVlID0gdjsgaW5wLnBsYWNlaG9sZGVyID0gcGg7XG4gICAgICAgICAgICBpbnAuc3R5bGUuY3NzVGV4dCA9ICd3aWR0aDoxMDAlO3BhZGRpbmc6M3B4IDZweDtiYWNrZ3JvdW5kOiMxZTI5M2I7Ym9yZGVyOjFweCBzb2xpZCAjMzM0MTU1O2JvcmRlci1yYWRpdXM6NnB4O2NvbG9yOiNlMmU4ZjA7Zm9udC1zaXplOjExcHg7Ym94LXNpemluZzpib3JkZXItYm94O291dGxpbmU6bm9uZTt0cmFuc2l0aW9uOmJvcmRlciAuMTVzOyc7XG4gICAgICAgICAgICBpbnAuYWRkRXZlbnRMaXN0ZW5lcignZm9jdXMnLCAoKSA9PiBpbnAuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzYzNjZmMScpO1xuICAgICAgICAgICAgaW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCAgKCkgPT4gaW5wLnN0eWxlLmJvcmRlckNvbG9yID0gJyMzMzQxNTUnKTtcbiAgICAgICAgICAgIGlucC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IG9uQ2hhbmdlKGlucC52YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIGlucDtcbiAgICAgICAgfTtcblxuICAgICAgICBjb25zdCBvbGRLZXkgPSBrZXk7XG4gICAgICAgIGNvbnN0IGtleUlucCA9IG1rSW5wKGtleSwgJ9C60LvRjtGHJywgbmV3S2V5ID0+IHtcbiAgICAgICAgICAgIGlmIChuZXdLZXkgIT09IG9sZEtleSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRtcCA9IHsgLi4uc2NoZWR1bGVSZXBsYWNlbWVudHMgfTtcbiAgICAgICAgICAgICAgICBkZWxldGUgdG1wW29sZEtleV07XG4gICAgICAgICAgICAgICAgdG1wW25ld0tleV0gPSBzY2hlZHVsZVJlcGxhY2VtZW50c1tvbGRLZXldO1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlUmVwbGFjZW1lbnRzID0gdG1wO1xuICAgICAgICAgICAgICAgIHNhdmVTY2hlZHVsZVJlcGxhY2VtZW50cygpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgdmFsSW5wID0gbWtJbnAodmFsLCAn0LfQsNC80LXQvdCwJywgbmV3VmFsID0+IHtcbiAgICAgICAgICAgIHNjaGVkdWxlUmVwbGFjZW1lbnRzW2tleV0gPSBuZXdWYWw7XG4gICAgICAgICAgICBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY29uc3QgZGVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGRlbC50ZXh0Q29udGVudCA9ICfinJUnO1xuICAgICAgICBkZWwuc3R5bGUuY3NzVGV4dCA9ICd3aWR0aDoyNHB4O2hlaWdodDoyNHB4O2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCAjZWY0NDQ0O2JvcmRlci1yYWRpdXM6NXB4O2NvbG9yOiNlZjQ0NDQ7Zm9udC1zaXplOjEwcHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjE1cztmbGV4LXNocmluazowOyc7XG4gICAgICAgIGRlbC5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4geyBkZWwuc3R5bGUuYmFja2dyb3VuZD0nI2VmNDQ0NCc7IGRlbC5zdHlsZS5jb2xvcj0nI2ZmZic7IH0pO1xuICAgICAgICBkZWwuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IHsgZGVsLnN0eWxlLmJhY2tncm91bmQ9J3RyYW5zcGFyZW50JzsgZGVsLnN0eWxlLmNvbG9yPScjZWY0NDQ0JzsgfSk7XG4gICAgICAgIGRlbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIGRlbGV0ZSBzY2hlZHVsZVJlcGxhY2VtZW50c1trZXldO1xuICAgICAgICAgICAgc2F2ZVNjaGVkdWxlUmVwbGFjZW1lbnRzKCk7XG4gICAgICAgICAgICBidWlsZFNjaGVkdWxlUGFuZWwoKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcm93LmFwcGVuZENoaWxkKGtleUlucCk7XG4gICAgICAgIHJvdy5hcHBlbmRDaGlsZCh2YWxJbnApO1xuICAgICAgICByb3cuYXBwZW5kQ2hpbGQoZGVsKTtcbiAgICAgICAgcGFuZWwuYXBwZW5kQ2hpbGQocm93KTtcbiAgICB9KTtcblxuICAgIF9hcHBlbmRSdWxlc1BhbmVsRm9vdGVyKHBhbmVsLCAnc2NoZWR1bGUnKTtcbn1cblxuLy8g0J7QsdGJ0LjQuSBcItC/0L7QtNCy0LDQu1wiINC/0LDQvdC10LvQtdC5INGBINC60L3QvtC/0LrQsNC80LggKyBKU09OLdGA0LXQtNCw0LrRgtC+0YDQvtC8XG5mdW5jdGlvbiBfYXBwZW5kUnVsZXNQYW5lbEZvb3RlcihwYW5lbCwgdHlwZSkge1xuICAgIGNvbnN0IGlzQ2FsYyA9IHR5cGUgPT09ICdjYWxjJztcbiAgICBjb25zdCBqc29uQXJlYUlkID0gaXNDYWxjID8gJ2NhbGNSdWxlc0pzb25BcmVhJyA6ICdzY2hlZHVsZUpzb25BcmVhJztcblxuICAgIGNvbnN0IGFkZFJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGFkZFJvdy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtnYXA6NXB4O21hcmdpbi10b3A6OHB4O2ZsZXgtd3JhcDp3cmFwOyc7XG5cbiAgICBjb25zdCBta0J0biA9IChsYWJlbCwgY3NzLCBvbkNsaWNrKSA9PiB7XG4gICAgICAgIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgYi5pbm5lckhUTUwgPSBsYWJlbDsgYi5zdHlsZS5jc3NUZXh0ID0gY3NzO1xuICAgICAgICBiLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZW50ZXInLCAoKSA9PiBiLnN0eWxlLm9wYWNpdHkgPSAnLjgnKTtcbiAgICAgICAgYi5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4gYi5zdHlsZS5vcGFjaXR5ID0gJzEnKTtcbiAgICAgICAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9uQ2xpY2spO1xuICAgICAgICByZXR1cm4gYjtcbiAgICB9O1xuXG4gICAgYWRkUm93LmFwcGVuZENoaWxkKG1rQnRuKCfvvIsg0JTQvtCx0LDQstC40YLRjCcsXG4gICAgICAgICdmbGV4OjE7cGFkZGluZzo0cHggOHB4O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCM4YjVjZjYpO2JvcmRlcjpub25lO2JvcmRlci1yYWRpdXM6N3B4O2NvbG9yOiNmZmY7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NjAwOycsXG4gICAgICAgICgpID0+IHtcbiAgICAgICAgICAgIGlmIChpc0NhbGMpIHtcbiAgICAgICAgICAgICAgICBjYWxjUnVsZXMucHVzaCh7IG5hbWU6ICfQndC+0LLQvtC1JywgcGVyY2VudDogMTAwLCByb3VuZDogMSwgZXh0cmE6IDAgfSk7XG4gICAgICAgICAgICAgICAgc2F2ZUNhbGNSdWxlcygpOyBidWlsZENhbGNSdWxlc1BhbmVsKCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlUmVwbGFjZW1lbnRzWyfQvdC+0LLRi9C5X9C60LvRjtGHJ10gPSAn0JfQsNC80LXQvdCwJztcbiAgICAgICAgICAgICAgICBzYXZlU2NoZWR1bGVSZXBsYWNlbWVudHMoKTsgYnVpbGRTY2hlZHVsZVBhbmVsKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICApKTtcblxuICAgIGFkZFJvdy5hcHBlbmRDaGlsZChta0J0bign4oa6INCh0LHRgNC+0YEnLFxuICAgICAgICAncGFkZGluZzo0cHggOHB4O2JhY2tncm91bmQ6I2ZmZmZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTFweDtjdXJzb3I6cG9pbnRlcjsnLFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIWNvbmZpcm0oJ9Ch0LHRgNC+0YHQuNGC0Ywg0Log0LfQvdCw0YfQtdC90LjRj9C8INC/0L4g0YPQvNC+0LvRh9Cw0L3QuNGOPycpKSByZXR1cm47XG4gICAgICAgICAgICBpZiAoaXNDYWxjKSB7IGNhbGNSdWxlcyA9IEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkoREVGQVVMVF9DQUxDX1JVTEVTKSk7IHNhdmVDYWxjUnVsZXMoKTsgYnVpbGRDYWxjUnVsZXNQYW5lbCgpOyB9XG4gICAgICAgICAgICBlbHNlIHsgc2NoZWR1bGVSZXBsYWNlbWVudHMgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfUkVQTEFDRU1FTlRTKSk7IHNhdmVTY2hlZHVsZVJlcGxhY2VtZW50cygpOyBidWlsZFNjaGVkdWxlUGFuZWwoKTsgfVxuICAgICAgICB9XG4gICAgKSk7XG5cbiAgICBhZGRSb3cuYXBwZW5kQ2hpbGQobWtCdG4oJ3sgfSBKU09OJyxcbiAgICAgICAgJ3BhZGRpbmc6NHB4IDhweDtiYWNrZ3JvdW5kOiNmZmZmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7JyxcbiAgICAgICAgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgamEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChqc29uQXJlYUlkKTtcbiAgICAgICAgICAgIGlmIChqYS5zdHlsZS5kaXNwbGF5ID09PSAnbm9uZScpIHtcbiAgICAgICAgICAgICAgICBqYS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KGlzQ2FsYyA/IGNhbGNSdWxlcyA6IHNjaGVkdWxlUmVwbGFjZW1lbnRzLCBudWxsLCAyKTtcbiAgICAgICAgICAgICAgICBqYS5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgamEuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICkpO1xuXG4gICAgcGFuZWwuYXBwZW5kQ2hpbGQoYWRkUm93KTtcblxuICAgIC8vIEpTT04gdGV4dGFyZWFcbiAgICBjb25zdCBqYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RleHRhcmVhJyk7XG4gICAgamEuaWQgPSBqc29uQXJlYUlkO1xuICAgIGphLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpub25lO3dpZHRoOjEwMCU7aGVpZ2h0OjExMHB4O21hcmdpbi10b3A6N3B4O3BhZGRpbmc6N3B4O2JhY2tncm91bmQ6I2ZmZmZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo4cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDtmb250LWZhbWlseTptb25vc3BhY2U7Ym94LXNpemluZzpib3JkZXItYm94O3Jlc2l6ZTp2ZXJ0aWNhbDtvdXRsaW5lOm5vbmU7JztcbiAgICBqYS5zcGVsbGNoZWNrID0gZmFsc2U7XG4gICAgamEuYWRkRXZlbnRMaXN0ZW5lcignYmx1cicsICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoamEudmFsdWUpO1xuICAgICAgICAgICAgaWYgKGlzQ2FsYykgeyBjYWxjUnVsZXMgPSBwYXJzZWQ7IHNhdmVDYWxjUnVsZXMoKTsgYnVpbGRDYWxjUnVsZXNQYW5lbCgpOyB9XG4gICAgICAgICAgICBlbHNlIHsgc2NoZWR1bGVSZXBsYWNlbWVudHMgPSBwYXJzZWQ7IHNhdmVTY2hlZHVsZVJlcGxhY2VtZW50cygpOyBidWlsZFNjaGVkdWxlUGFuZWwoKTsgfVxuICAgICAgICAgICAgamEuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzIyYzU1ZSc7XG4gICAgICAgIH0gY2F0Y2ggeyBqYS5zdHlsZS5ib3JkZXJDb2xvciA9ICcjZWY0NDQ0JzsgfVxuICAgIH0pO1xuICAgIHBhbmVsLmFwcGVuZENoaWxkKGphKTtcbn1cblxuLy8g4pSA4pSA4pSAINCh0LrRgNGL0YLQuNC1INC/0L7Qu9C10Lkg0JzQvtC50KHQutC70LDQtCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCf0L7Qu9C1INC/0YDRj9GH0LXRgtGB0Y8g0L/QviDRgtC+0YfQvdC+0LzRgyDRgtC10LrRgdGC0YMg0LvQtdC50LHQu9CwLiDQn9C+0LTQtNC10YDQttC40LLQsNGO0YLRgdGPINGC0YDQuCDRhNC+0YDQvNGLINCc0L7QudCh0LrQu9Cw0LQ6XG4vLyAgYSkgUmVhY3Qt0L/QvtC70LUg0YTQvtGA0LzRizogLmZvcm1JdGVtVGl0bGUgKNC70LXQudCx0LspICsg0YHQu9C10LTRg9GO0YnQuNC5INC/0YPRgdGC0L7QuSBESVYgKNC30L3QsNGH0LXQvdC40LUpXG4vLyAgYikgUmVhY3Qt0LHQu9C+0Log0LjRgtC+0LPQvtCyOiDQu9C10LnQsdC7ICsg0LfQvdCw0YfQtdC90LjQtSDigJQg0YHQvtGB0LXQtNC90LjQtSBESVYg0LLQvdGD0YLRgNC4IFtjbGFzcyo9XCJ0b3RhbHNXcmFwcGVyXCJdXG4vLyAgYykgR1dULdGC0LDQsdC70LjRhtCwOiDRgdGC0YDQvtC60LAgdHIg0YEg0Y/Rh9C10LnQutC+0LkgVEQubGVnZW5kXG4vLyDQodC60YDRi9GC0YvQtSDRhtC10LvQuCDQt9Cw0L/QvtC80LjQvdCw0Y7RgtGB0Y8g0LIgbXNIaWRkZW5UYXJnZXRzLCDRh9GC0L7QsdGLINC80L7QttC90L4g0LHRi9C70L4g0LLQtdGA0L3Rg9GC0Ywg0L7RgtC+0LHRgNCw0LbQtdC90LjQtS5cblxuZnVuY3Rpb24gbXNGaW5kTGFiZWxFbGVtZW50KG5hbWUpIHtcbiAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGRvY3VtZW50LmJvZHksIE5vZGVGaWx0ZXIuU0hPV19URVhUKTtcbiAgICBsZXQgbm9kZTtcbiAgICB3aGlsZSAobm9kZSA9IHdhbGtlci5uZXh0Tm9kZSgpKSB7XG4gICAgICAgIGlmICgobm9kZS50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpICE9PSBuYW1lKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZWwgPSBub2RlLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgIGlmICghZWwgfHwgZWwub2Zmc2V0SGVpZ2h0IDw9IDApIGNvbnRpbnVlO1xuICAgICAgICAvLyBhKSBSZWFjdC3Qv9C+0LvQtSDRhNC+0YDQvNGLXG4gICAgICAgIGlmIChlbC5jbG9zZXN0KCdbY2xhc3MqPVwiZm9ybUl0ZW1UaXRsZVwiXScpKSByZXR1cm4gZWwuY2xvc2VzdCgnW2NsYXNzKj1cImZvcm1JdGVtVGl0bGVcIl0nKTtcbiAgICAgICAgLy8gYikgUmVhY3Qt0LHQu9C+0Log0LjRgtC+0LPQvtCyOiDQu9C10LnQsdC7IOKAlCDQv9GA0Y/QvNC+0Lkg0YDQtdCx0ZHQvdC+0LogdG90YWxzV3JhcHBlclxuICAgICAgICBjb25zdCB3cmFwID0gZWwuY2xvc2VzdCgnW2NsYXNzKj1cInRvdGFsc1dyYXBwZXJcIl0nKTtcbiAgICAgICAgaWYgKHdyYXApIHtcbiAgICAgICAgICAgIGxldCBjdXIgPSBlbDtcbiAgICAgICAgICAgIHdoaWxlIChjdXIucGFyZW50RWxlbWVudCAmJiBjdXIucGFyZW50RWxlbWVudCAhPT0gd3JhcCkgY3VyID0gY3VyLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgICAgICByZXR1cm4gY3VyO1xuICAgICAgICB9XG4gICAgICAgIC8vIGMpIEdXVC3RgtCw0LHQu9C40YbQsCAo0Y/Rh9C10LnQutCwLdC70LXQs9C10L3QtNCwKVxuICAgICAgICBjb25zdCBsZWdlbmQgPSBlbC5jbG9zZXN0KCd0ZC5sZWdlbmQnKTtcbiAgICAgICAgaWYgKGxlZ2VuZCkgcmV0dXJuIGxlZ2VuZDtcbiAgICAgICAgLy8gZmFsbGJhY2s6INC70LXQudCx0Lsg0LIg0L3QtdC40LfQstC10YHRgtC90L7QuSDRgdGC0YDRg9C60YLRg9GA0LUg4oCUINCx0LXRgNGR0Lwg0YHQsNC8INGN0LvQtdC80LXQvdGCXG4gICAgICAgIHJldHVybiBlbDtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG1zQ29sbGVjdFRhcmdldHMobmFtZSkge1xuICAgIGNvbnN0IHRhcmdldHMgPSBbXTtcbiAgICBjb25zdCB0aXRsZSA9IG1zRmluZExhYmVsRWxlbWVudChuYW1lKTtcbiAgICBpZiAoIXRpdGxlKSByZXR1cm4gdGFyZ2V0cztcblxuICAgIGNvbnN0IGNscyA9IFN0cmluZyh0aXRsZS5jbGFzc05hbWUgfHwgJycpO1xuICAgIGlmIChjbHMuaW5jbHVkZXMoJ2Zvcm1JdGVtVGl0bGUnKSkge1xuICAgICAgICAvLyBhKSDQu9C10LnQsdC7ICsg0YHQvtGB0LXQtNC90Y/RjyDRj9GH0LXQudC60LAg0LfQvdCw0YfQtdC90LjRj1xuICAgICAgICBjb25zdCBwYXJlbnQgPSB0aXRsZS5wYXJlbnRFbGVtZW50O1xuICAgICAgICBjb25zdCBpZHggPSBBcnJheS5wcm90b3R5cGUuaW5kZXhPZi5jYWxsKHBhcmVudC5jaGlsZHJlbiwgdGl0bGUpO1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHBhcmVudC5jaGlsZHJlbltpZHggKyAxXTtcbiAgICAgICAgaWYgKHZhbHVlICYmICFTdHJpbmcodmFsdWUuY2xhc3NOYW1lIHx8ICcnKS5pbmNsdWRlcygnZm9ybUl0ZW1UaXRsZScpKSB7XG4gICAgICAgICAgICB0YXJnZXRzLnB1c2godGl0bGUsIHZhbHVlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRhcmdldHMucHVzaCh0aXRsZSk7XG4gICAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHRpdGxlLnRhZ05hbWUgPT09ICdURCcpIHtcbiAgICAgICAgLy8gYykgR1dUOiDQv9GA0Y/Rh9C10Lwg0LLRgdGOINGB0YLRgNC+0LrRgyDRgtCw0LHQu9C40YbRi1xuICAgICAgICBjb25zdCByb3cgPSB0aXRsZS5jbG9zZXN0KCd0cicpO1xuICAgICAgICB0YXJnZXRzLnB1c2gocm93IHx8IHRpdGxlKTtcbiAgICB9IGVsc2UgaWYgKHRpdGxlLnBhcmVudEVsZW1lbnQgJiYgU3RyaW5nKHRpdGxlLnBhcmVudEVsZW1lbnQuY2xhc3NOYW1lIHx8ICcnKS5pbmNsdWRlcygndG90YWxzV3JhcHBlcicpKSB7XG4gICAgICAgIC8vIGIpINC40YLQvtCz0Lg6INC70LXQudCx0LsgKyDQt9C90LDRh9C10L3QuNC1LdGB0L7RgdC10LRcbiAgICAgICAgdGFyZ2V0cy5wdXNoKHRpdGxlKTtcbiAgICAgICAgaWYgKHRpdGxlLm5leHRFbGVtZW50U2libGluZykgdGFyZ2V0cy5wdXNoKHRpdGxlLm5leHRFbGVtZW50U2libGluZyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgLy8gZmFsbGJhY2s6INC/0YDRj9GH0LXQvCDRgdCw0Lwg0Y3Qu9C10LzQtdC90YIg0LvQtdC50LHQu9CwICsg0YHQvtGB0LXQtNCwLdC30L3QsNGH0LXQvdC40LVcbiAgICAgICAgdGFyZ2V0cy5wdXNoKHRpdGxlKTtcbiAgICAgICAgaWYgKHRpdGxlLm5leHRFbGVtZW50U2libGluZykgdGFyZ2V0cy5wdXNoKHRpdGxlLm5leHRFbGVtZW50U2libGluZyk7XG4gICAgfVxuICAgIHJldHVybiB0YXJnZXRzLmZpbHRlcihCb29sZWFuKTtcbn1cblxuZnVuY3Rpb24gYXBwbHlNc0hpZGRlbkZpZWxkcygpIHtcbiAgICBpZiAoIS9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIHJldHVybjtcbiAgICBpZiAobXNGaWVsZHNSZXZlYWxlZCB8fCAhaGlkZGVuRmllbGRzLmxlbmd0aCkgcmV0dXJuO1xuXG4gICAgbXNIaWRkZW5UYXJnZXRzLmZvckVhY2godCA9PiB7IHQuZWwuc3R5bGUuZGlzcGxheSA9ICcnOyB9KTtcbiAgICBtc0hpZGRlblRhcmdldHMgPSBbXTtcblxuICAgIGhpZGRlbkZpZWxkcy5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgICBtc0NvbGxlY3RUYXJnZXRzKG5hbWUpLmZvckVhY2goZWwgPT4ge1xuICAgICAgICAgICAgZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgICAgIG1zSGlkZGVuVGFyZ2V0cy5wdXNoKHsgZWwsIG5hbWUgfSk7XG4gICAgICAgIH0pO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiByZXN0b3JlTXNGaWVsZHMoKSB7XG4gICAgbXNIaWRkZW5UYXJnZXRzLmZvckVhY2godCA9PiB7IHQuZWwuc3R5bGUuZGlzcGxheSA9ICcnOyB9KTtcbiAgICBtc0hpZGRlblRhcmdldHMgPSBbXTtcbn1cblxuZnVuY3Rpb24gdG9nZ2xlTXNGaWVsZHNSZXZlYWxlZCgpIHtcbiAgICBtc0ZpZWxkc1JldmVhbGVkID0gIW1zRmllbGRzUmV2ZWFsZWQ7XG4gICAgaWYgKG1zRmllbGRzUmV2ZWFsZWQpIHtcbiAgICAgICAgcmVzdG9yZU1zRmllbGRzKCk7XG4gICAgICAgIHNldFN0YXR1c1RleHQoJ/CfkYEg0KHQutGA0YvRgtGL0LUg0L/QvtC70Y8g0L/QvtC60LDQt9Cw0L3RiyAo0L3QsNC20LzQuNGC0LUg0LXRidGRINGA0LDQtywg0YfRgtC+0LHRiyDRgdC/0YDRj9GC0LDRgtGMKScpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGFwcGx5TXNIaWRkZW5GaWVsZHMoKTtcbiAgICAgICAgc2V0U3RhdHVzVGV4dCgn8J+ZiCDQodC60YDRi9GC0YvQtSDQv9C+0LvRjyDRgdC/0YDRj9GC0LDQvdGLJyk7XG4gICAgfVxuICAgIHVwZGF0ZU1zUmV2ZWFsQnV0dG9uKCk7XG59XG5cbi8vINCf0LDQvdC10LvRjCDQvdCw0YHRgtGA0L7QudC60Lgg0YHQutGA0YvRgtGL0YUg0L/QvtC70LXQuSAo0LIg0L7QutC90LUg0L3QsNGB0YLRgNC+0LXQuilcbmZ1bmN0aW9uIGJ1aWxkTXNGaWVsZHNQYW5lbCgpIHtcbiAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtc0ZpZWxkc1BhbmVsJyk7XG4gICAgaWYgKCFwYW5lbCkgcmV0dXJuO1xuICAgIHBhbmVsLmlubmVySFRNTCA9ICcnO1xuICAgIGlmICghL29ubGluZVxcLm1veXNrbGFkXFwucnUkLy50ZXN0KGxvY2F0aW9uLmhvc3RuYW1lKSkge1xuICAgICAgICBjb25zdCBub3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIG5vdGUuc3R5bGUuY3NzVGV4dCA9ICdmb250LXNpemU6MTFweDtjb2xvcjojNjQ3NDhiO3BhZGRpbmc6NHB4IDA7JztcbiAgICAgICAgbm90ZS50ZXh0Q29udGVudCA9ICfQlNC+0YHRgtGD0L/QvdC+INGC0L7Qu9GM0LrQviDQvdCwIG9ubGluZS5tb3lza2xhZC5ydSc7XG4gICAgICAgIHBhbmVsLmFwcGVuZENoaWxkKG5vdGUpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZmllbGRzID0gWy4uLktOT1dOX01TX0ZJRUxEU107XG4gICAgaGlkZGVuRmllbGRzLmZvckVhY2gobiA9PiB7IGlmICghZmllbGRzLmluY2x1ZGVzKG4pKSBmaWVsZHMucHVzaChuKTsgfSk7XG5cbiAgICBmaWVsZHMuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xuICAgICAgICBsYWJlbC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMS41cHg7bWFyZ2luLWJvdHRvbTo1cHg7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICAgICAgY29uc3QgY2IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgICAgICBjYi50eXBlID0gJ2NoZWNrYm94JztcbiAgICAgICAgY2IuY2hlY2tlZCA9IGhpZGRlbkZpZWxkcy5pbmNsdWRlcyhuYW1lKTtcbiAgICAgICAgY2Iuc3R5bGUuY3NzVGV4dCA9ICdhY2NlbnQtY29sb3I6IzYzNjZmMTt3aWR0aDoxM3B4O2hlaWdodDoxM3B4Oyc7XG4gICAgICAgIGNiLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIGlmIChjYi5jaGVja2VkKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFoaWRkZW5GaWVsZHMuaW5jbHVkZXMobmFtZSkpIGhpZGRlbkZpZWxkcy5wdXNoKG5hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBoaWRkZW5GaWVsZHMgPSBoaWRkZW5GaWVsZHMuZmlsdGVyKG4gPT4gbiAhPT0gbmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzYXZlSGlkZGVuRmllbGRzKCk7XG4gICAgICAgICAgICBpZiAoIW1zRmllbGRzUmV2ZWFsZWQpIGFwcGx5TXNIaWRkZW5GaWVsZHMoKTsgZWxzZSByZXN0b3JlTXNGaWVsZHMoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gICAgICAgIHNwYW4udGV4dENvbnRlbnQgPSBuYW1lO1xuICAgICAgICBsYWJlbC5hcHBlbmRDaGlsZChjYik7XG4gICAgICAgIGxhYmVsLmFwcGVuZENoaWxkKHNwYW4pO1xuICAgICAgICBwYW5lbC5hcHBlbmRDaGlsZChsYWJlbCk7XG4gICAgfSk7XG5cbiAgICAvLyDQmtCw0YHRgtC+0LzQvdC+0LUg0L/QvtC70LU6INGB0LLQvtC5INGC0LXQutGB0YIg0LvQtdC50LHQu9CwXG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgcm93LnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2dhcDo1cHg7bWFyZ2luLXRvcDo2cHg7JztcbiAgICBjb25zdCBpbnAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgIGlucC50eXBlID0gJ3RleHQnO1xuICAgIGlucC5wbGFjZWhvbGRlciA9ICfQodCy0L7RkSDQv9C+0LvQtTog0YLQvtGH0L3Ri9C5INGC0LXQutGB0YIg0LvQtdC50LHQu9Cw4oCmJztcbiAgICBpbnAuc3R5bGUuY3NzVGV4dCA9ICdmbGV4OjE7cGFkZGluZzo0cHggN3B4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDtvdXRsaW5lOm5vbmU7Ym94LXNpemluZzpib3JkZXItYm94Oyc7XG4gICAgY29uc3QgYWRkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgYWRkLnRleHRDb250ZW50ID0gJ++8iyc7XG4gICAgYWRkLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MjhweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzYzNjZmMSwjOGI1Y2Y2KTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojZmZmO2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyO2ZvbnQtd2VpZ2h0OjcwMDsnO1xuICAgIGFkZC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgY29uc3QgdiA9IChpbnAudmFsdWUgfHwgJycpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF2KSByZXR1cm47XG4gICAgICAgIGlmICghaGlkZGVuRmllbGRzLmluY2x1ZGVzKHYpKSBoaWRkZW5GaWVsZHMucHVzaCh2KTtcbiAgICAgICAgc2F2ZUhpZGRlbkZpZWxkcygpO1xuICAgICAgICBpZiAoIW1zRmllbGRzUmV2ZWFsZWQpIGFwcGx5TXNIaWRkZW5GaWVsZHMoKTsgZWxzZSByZXN0b3JlTXNGaWVsZHMoKTtcbiAgICAgICAgYnVpbGRNc0ZpZWxkc1BhbmVsKCk7XG4gICAgICAgIHNldFN0YXR1c1RleHQoYPCfkYEg0J/QvtC70LUgwqske3Z9wrsg0LTQvtCx0LDQstC70LXQvdC+INCyINGB0LrRgNGL0YLRi9C1YCk7XG4gICAgfSk7XG4gICAgaW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBlID0+IHsgaWYgKGUua2V5ID09PSAnRW50ZXInKSBhZGQuY2xpY2soKTsgfSk7XG4gICAgcm93LmFwcGVuZENoaWxkKGlucCk7XG4gICAgcm93LmFwcGVuZENoaWxkKGFkZCk7XG4gICAgcGFuZWwuYXBwZW5kQ2hpbGQocm93KTtcbn1cblxuLy8g0J/Qu9Cw0LLQsNGO0YnQsNGPINC60L3QvtC/0LrQsCDwn5GBIMKr0L/QvtC60LDQt9Cw0YLRjCDRgdC60YDRi9GC0YvQtcK7IOKAlCDQv9C+0Y/QstC70Y/QtdGC0YHRjyDQvdCwINCc0L7QudCh0LrQu9Cw0LQsINC60L7Qs9C00LAg0LXRgdGC0Ywg0YfRgtC+INC/0YDRj9GC0LDRgtGMXG5mdW5jdGlvbiB1cGRhdGVNc1JldmVhbEJ1dHRvbigpIHtcbiAgICBpZiAoIS9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIHJldHVybjtcbiAgICBsZXQgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jTXNSZXZlYWxCdG4nKTtcbiAgICBpZiAoIWhpZGRlbkZpZWxkcy5sZW5ndGgpIHtcbiAgICAgICAgaWYgKGJ0bikgYnRuLnJlbW92ZSgpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghYnRuKSB7XG4gICAgICAgIGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBidG4uaWQgPSAnbWNNc1JldmVhbEJ0bic7XG4gICAgICAgIGJ0bi50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIGJ0bi50ZXh0Q29udGVudCA9ICfwn5GBJztcbiAgICAgICAgYnRuLnRpdGxlID0gJ9Cf0L7QutCw0LfQsNGC0Ywv0YHQutGA0YvRgtGMINGB0L/RgNGP0YLQsNC90L3Ri9C1INC/0L7Qu9GPJztcbiAgICAgICAgYnRuLnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7bGVmdDo4cHg7Ym90dG9tOjhweDt6LWluZGV4OjIxNDc0ODMwMDA7d2lkdGg6MzBweDtoZWlnaHQ6MzBweDsnXG4gICAgICAgICAgICArICdiYWNrZ3JvdW5kOnJnYmEoMTUsMjMsNDIsLjgyKTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMTQ4LDE2MywxODQsLjUpO2JvcmRlci1yYWRpdXM6NTAlOydcbiAgICAgICAgICAgICsgJ2NvbG9yOiNlMmU4ZjA7Zm9udC1zaXplOjE0cHg7Y3Vyc29yOnBvaW50ZXI7b3BhY2l0eTouNTU7dHJhbnNpdGlvbjpvcGFjaXR5IC4xNXM7J1xuICAgICAgICAgICAgKyAnYm94LXNoYWRvdzowIDJweCA4cHggcmdiYSgwLDAsMCwuMzUpO3BhZGRpbmc6MDtsaW5lLWhlaWdodDoxOyc7XG4gICAgICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4gYnRuLnN0eWxlLm9wYWNpdHkgPSAnMScpO1xuICAgICAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IGJ0bi5zdHlsZS5vcGFjaXR5ID0gJzAuNTUnKTtcbiAgICAgICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdG9nZ2xlTXNGaWVsZHNSZXZlYWxlZCk7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgICB9XG4gICAgYnRuLnRleHRDb250ZW50ID0gbXNGaWVsZHNSZXZlYWxlZCA/ICfwn5mIJyA6ICfwn5GBJztcbiAgICBidG4uc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG59XG5cbi8vIOKUgOKUgOKUgCDQn9Cw0L3QtdC70Ywg0LHRi9GB0YLRgNGL0YUg0LrQvdC+0L/QvtC6INCc0L7QudCh0LrQu9Cw0LQgKNGB0L7Qt9C00LDRgtGML9C/0LXRh9Cw0YLRjCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQmtC90L7Qv9C60Lgt0LTRg9Cx0LvQuCDRgtGD0LvQsdCw0YDQsCDQutCw0YDRgtC+0YfQutC4OiDQutC70LjQuiA9INC+0YLQutGA0YvRgtGMINC80LXQvdGOINGC0YPQu9Cx0LDRgNCwINC4INCy0YvQsdGA0LDRgtGMINC/0YPQvdC60YIuXG4vLyDQn9C+0LTQtNC10YDQttC40LLQsNGO0YLRgdGPINC+0LHQsCDQvNC10YXQsNC90LjQt9C80LAg0LzQtdC90Y46IFJlYWN0LdC00YDQvtC/0LTQsNGD0L3RiyDQuCBHV1Qt0L/QvtC/0LDQv9GLLlxuXG5mdW5jdGlvbiBtc0dldFRvb2xiYXJCdXR0b24obGFiZWwpIHtcbiAgICAvLyDQndC+0LLRi9C5INC00LjQt9Cw0LnQvSDQnNC+0LnQodC60LvQsNC0IOKAlCDQvdCw0YHRgtC+0Y/RidC40LUgPGJ1dHRvbj4sINGB0YLQsNGA0YvQuSAoR1dUKSDigJQgRElWLmJ0blxuICAgIHJldHVybiBbLi4uZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uLCBbcm9sZT1idXR0b25dLCAuYnRuJyldXG4gICAgICAgIC5maW5kKGIgPT4gKGIudGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKSA9PT0gbGFiZWwgJiYgYi5vZmZzZXRIZWlnaHQgPiAwICYmICFiLmRpc2FibGVkKTtcbn1cblxuLy8gR1dUL1JlYWN0LdC/0YPQvdC60YLRiyDQvNC10L3RjiDQuNCz0L3QvtGA0LjRgNGD0Y7RgiDQs9C+0LvRi9C5IC5jbGljaygpIOKAlCDQvdGD0LbQtdC9INC/0L7Qu9C90YvQuSDQttC10YHRgiDQvNGL0YjQuFxuZnVuY3Rpb24gbXNTeW50aGV0aWNDbGljayhlbCkge1xuICAgIGNvbnN0IHIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICBjb25zdCBvcHRzID0geyBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlLCBjbGllbnRYOiByLnggKyByLndpZHRoIC8gMiwgY2xpZW50WTogci55ICsgci5oZWlnaHQgLyAyIH07XG4gICAgZWwuZGlzcGF0Y2hFdmVudChuZXcgTW91c2VFdmVudCgnbW91c2Vkb3duJywgb3B0cykpO1xuICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IE1vdXNlRXZlbnQoJ21vdXNldXAnLCBvcHRzKSk7XG4gICAgZWwuZGlzcGF0Y2hFdmVudChuZXcgTW91c2VFdmVudCgnY2xpY2snLCBvcHRzKSk7XG59XG5cbmZ1bmN0aW9uIG1zQ2xpY2tNZW51SXRlbShidXR0b25MYWJlbCwgaXRlbVRleHQpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgICAgIGNvbnN0IGJ0biA9IG1zR2V0VG9vbGJhckJ1dHRvbihidXR0b25MYWJlbCk7XG4gICAgICAgIGlmICghYnRuKSB7IHJlc29sdmUoeyBvazogZmFsc2UsIHdoeTogYNCa0L3QvtC/0LrQsCDCqyR7YnV0dG9uTGFiZWx9wrsg0L3QtSDQvdCw0LnQtNC10L3QsGAgfSk7IHJldHVybjsgfVxuICAgICAgICBtc1N5bnRoZXRpY0NsaWNrKGJ0bik7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgLy8gUmVhY3Qt0LTRgNC+0L/QtNCw0YPQvTog0LrQu9C40LrQsNCx0LXQu9GM0L3Ri9C5IGRpdltjbGFzcyo9XCJvcHRpb25cIl0g0YEg0YLQvtGH0L3Ri9C8INGC0LXQutGB0YLQvtC8XG4gICAgICAgICAgICBsZXQgdGFyZ2V0ID0gWy4uLmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tjbGFzcyo9XCJvcHRpb25cIl0nKV0ucmV2ZXJzZSgpXG4gICAgICAgICAgICAgICAgLmZpbmQobyA9PiBvLm9mZnNldEhlaWdodCA+IDAgJiYgby5jaGlsZHJlbi5sZW5ndGggPD0gMSAmJiAoby50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpID09PSBpdGVtVGV4dCk7XG4gICAgICAgICAgICAvLyBHV1Qt0L/QvtC/0LDQvzogVEQuZ3d0LU1lbnVJdGVtXG4gICAgICAgICAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICAgICAgICAgIHRhcmdldCA9IFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZ3d0LU1lbnVJdGVtJyldXG4gICAgICAgICAgICAgICAgICAgIC5maW5kKGkgPT4gaS5vZmZzZXRIZWlnaHQgPiAwICYmIChpLnRleHRDb250ZW50IHx8ICcnKS50cmltKCkgPT09IGl0ZW1UZXh0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICAgICAgICAgICAgc2V0U3RhdHVzVGV4dChg4pqg77iPIMKrJHtpdGVtVGV4dH3CuyDQvdC1INC90LDQudC00LXQvdC+INCyINC80LXQvdGOIOKAlCDQstGL0LHQtdGA0LjRgtC1INCy0YDRg9GH0L3Rg9GOYCk7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZSh7IG9rOiBmYWxzZSwgd2h5OiAn0L/Rg9C90LrRgiDQvdC1INC90LDQudC00LXQvScgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbXNTeW50aGV0aWNDbGljayh0YXJnZXQpO1xuICAgICAgICAgICAgc2V0U3RhdHVzVGV4dChg4pyFICR7aXRlbVRleHR9YCk7XG4gICAgICAgICAgICByZXNvbHZlKHsgb2s6IHRydWUgfSk7XG4gICAgICAgIH0sIDcwMCk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck9wZW5RdWlja0FjdGlvblBvcHVwKGFjdGlvbiwgYW5jaG9yKSB7XG4gICAgaWYgKCFoYWNrZXJDYW5SdW4oKSkgcmV0dXJuO1xuICAgIGNvbnN0IG9sZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0hhY2tlclF1aWNrUG9wdXAnKTtcbiAgICBpZiAob2xkKSB7IG9sZC5yZW1vdmUoKTsgcmV0dXJuOyB9XG4gICAgY29uc3QgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm94LmlkID0gJ21jSGFja2VyUXVpY2tQb3B1cCc7XG4gICAgYm94LnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7ei1pbmRleDoyMTQ3NDgzMDAxO3dpZHRoOjMwMHB4O3BhZGRpbmc6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6MTBweDtib3gtc2hhZG93OjAgOHB4IDMwcHggIzBmMTcyYTQwO2ZvbnQ6MTJweCBTZWdvZSBVSSxzYW5zLXNlcmlmO2NvbG9yOiMzMzQxNTU7JztcbiAgICBjb25zdCByID0gYW5jaG9yPy5nZXRCb3VuZGluZ0NsaWVudFJlY3Q/LigpO1xuICAgIGJveC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5tYXgoOCwgTWF0aC5taW4oKHI/LmxlZnQgfHwgMjApLCB3aW5kb3cuaW5uZXJXaWR0aCAtIDMyMCkpfXB4YDtcbiAgICBib3guc3R5bGUudG9wID0gYCR7TWF0aC5taW4oKHI/LmJvdHRvbSB8fCA4MCkgKyA1LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSAyMzApfXB4YDtcbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRpdGxlLnRleHRDb250ZW50ID0gYWN0aW9uID09PSAnZGVtYW5kJyA/ICfimqEg0J7RgtCz0YDRg9C30LrQsCcgOiBhY3Rpb24gPT09ICdjYXNoaW4nID8gJ+KaoSDQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCcgOiBhY3Rpb24gPT09ICdwYXltZW50aW4nID8gJ+KaoSDQktGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0ZHQticgOiAn4pqhINCa0YDQtdC00LjRgi/QoNCw0YHRgdGA0L7Rh9C60LAnO1xuICAgIHRpdGxlLnN0eWxlLmNzc1RleHQgPSAnZm9udC13ZWlnaHQ6NzAwO21hcmdpbi1ib3R0b206OHB4Oyc7XG4gICAgYm94LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgICBjb25zdCBhZGRJbnB1dCA9IChpZCwgbGFiZWwsIHBsYWNlaG9sZGVyKSA9PiB7XG4gICAgICAgIGNvbnN0IGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpOyBsLnRleHRDb250ZW50ID0gbGFiZWw7IGwuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO21hcmdpbjo2cHggMCAzcHg7Zm9udC13ZWlnaHQ6NjAwOyc7XG4gICAgICAgIGNvbnN0IGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpOyBpLmlkID0gaWQ7IGkudHlwZSA9ICd0ZXh0JzsgaS5wbGFjZWhvbGRlciA9IHBsYWNlaG9sZGVyIHx8ICcnOyBpLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfSU5QVVRfQ1NTOyBib3guYXBwZW5kQ2hpbGQobCk7IGJveC5hcHBlbmRDaGlsZChpKTsgcmV0dXJuIGk7XG4gICAgfTtcbiAgICBpZiAoYWN0aW9uID09PSAnZGVtYW5kJykge1xuICAgICAgICBjb25zdCBoaW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGhpbnQudGV4dENvbnRlbnQgPSAn0JrQsNC90LDQuyDQv9GA0L7QtNCw0LY6INC60LDQuiDQsiDQt9Cw0LrQsNC30LUnOyBoaW50LnN0eWxlLmNvbG9yID0gJyM2NDc0OGInOyBib3guYXBwZW5kQ2hpbGQoaGludCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgYWRkSW5wdXQoJ2hhY2tlclNhbGVTdW0nLCBhY3Rpb24gPT09ICdjcmVkaXQnID8gJ9Ce0LHRidCw0Y8g0YHRg9C80LzQsCcgOiAn0KHRg9C80LzQsCcsICcwJyk7XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdjYXNoaW4nIHx8IGFjdGlvbiA9PT0gJ2NyZWRpdCcpIHtcbiAgICAgICAgICAgIGFkZElucHV0KCdoYWNrZXJDYXNoQW1vdW50JywgJ9Cd0LDQu9C40YfQvdGL0LUnLCBhY3Rpb24gPT09ICdjcmVkaXQnID8gJzAnIDogJycpO1xuICAgICAgICAgICAgY29uc3QgcyA9IGhhY2tlclNlbGVjdCgnaGFja2VyQ2xpZW50U3RhdHVzU2VsZWN0JywgJ9Ch0YLQsNGC0YPRgSDQutC70LjQtdC90YLQsCcpOyBzLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfU0VMRUNUX0NTUzsgYm94LmFwcGVuZENoaWxkKHMpOyBoYWNrZXJSZWZyZXNoQ2xpZW50U3RhdHVzZXModHJ1ZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3BheW1lbnRpbicgfHwgYWN0aW9uID09PSAnY3JlZGl0Jykge1xuICAgICAgICAgICAgY29uc3QgcyA9IGhhY2tlclNlbGVjdCgnaGFja2VyUGF5TWV0aG9kU2VsZWN0JywgJ9Ch0L/QvtGB0L7QsSDQvtC/0LvQsNGC0YsnKTsgcy5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX1NFTEVDVF9DU1M7IGJveC5hcHBlbmRDaGlsZChzKTsgaGFja2VyUmVmcmVzaFBheU1ldGhvZHModHJ1ZSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IHJvdy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtnYXA6NXB4O21hcmdpbi10b3A6MTBweDsnO1xuICAgIGNvbnN0IGdvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IGdvLnRleHRDb250ZW50ID0gJ9Ch0L7Qt9C00LDRgtGMJzsgZ28uc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6IzRmNDZlNTtmbGV4OjE7JztcbiAgICBnby5vbmNsaWNrID0gYXN5bmMgKCkgPT4geyBpZiAoYWN0aW9uID09PSAnZGVtYW5kJykgYXdhaXQgaGFja2VyQ3JlYXRlRGVtYW5kKCk7IGVsc2UgaWYgKGFjdGlvbiA9PT0gJ2Nhc2hpbicpIGF3YWl0IGhhY2tlckNyZWF0ZUNhc2hpbigpOyBlbHNlIGlmIChhY3Rpb24gPT09ICdwYXltZW50aW4nKSBhd2FpdCBoYWNrZXJDcmVhdGVQYXltZW50aW4oKTsgZWxzZSBhd2FpdCBoYWNrZXJDcmVhdGVDcmVkaXQoKTsgYm94LnJlbW92ZSgpOyB9O1xuICAgIGNvbnN0IGNhbmNlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBjYW5jZWwudGV4dENvbnRlbnQgPSAn0J7RgtC80LXQvdCwJzsgY2FuY2VsLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfTUlOSV9CVE5fQ1NTOyBjYW5jZWwub25jbGljayA9ICgpID0+IGJveC5yZW1vdmUoKTtcbiAgICByb3cuYXBwZW5kQ2hpbGQoZ28pOyByb3cuYXBwZW5kQ2hpbGQoY2FuY2VsKTsgYm94LmFwcGVuZENoaWxkKHJvdyk7IGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYm94KTtcbiAgICBpZiAoYWN0aW9uICE9PSAnZGVtYW5kJykge1xuICAgICAgICBpZiAoYWN0aW9uID09PSAnY2FzaGluJyB8fCBhY3Rpb24gPT09ICdjcmVkaXQnKSBoYWNrZXJSZWZyZXNoQ2xpZW50U3RhdHVzZXModHJ1ZSk7XG4gICAgICAgIGlmIChhY3Rpb24gPT09ICdwYXltZW50aW4nIHx8IGFjdGlvbiA9PT0gJ2NyZWRpdCcpIGhhY2tlclJlZnJlc2hQYXlNZXRob2RzKHRydWUpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyT3BlbkFnZW50UXVpY2tQb3B1cChhbmNob3IpIHtcbiAgICBpZiAoIWhhY2tlckNhblJ1bigpKSByZXR1cm47XG4gICAgY29uc3Qgb2xkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSGFja2VyQWdlbnRQb3B1cCcpO1xuICAgIGlmIChvbGQpIHsgb2xkLnJlbW92ZSgpOyByZXR1cm47IH1cbiAgICBjb25zdCBib3ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBib3guaWQgPSAnbWNIYWNrZXJBZ2VudFBvcHVwJztcbiAgICBib3guc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjIxNDc0ODMwMDE7d2lkdGg6MzAwcHg7cGFkZGluZzoxMnB4O2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czoxMHB4O2JveC1zaGFkb3c6MCA4cHggMzBweCAjMGYxNzJhNDA7Zm9udDoxMnB4IFNlZ29lIFVJLHNhbnMtc2VyaWY7Y29sb3I6IzMzNDE1NTsnO1xuICAgIGNvbnN0IHIgPSBhbmNob3I/LmdldEJvdW5kaW5nQ2xpZW50UmVjdD8uKCk7XG4gICAgYm94LnN0eWxlLmxlZnQgPSBgJHtNYXRoLm1heCg4LCBNYXRoLm1pbigocj8ubGVmdCB8fCAyMCksIHdpbmRvdy5pbm5lcldpZHRoIC0gMzIwKSl9cHhgO1xuICAgIGJveC5zdHlsZS50b3AgPSBgJHtNYXRoLm1pbigocj8uYm90dG9tIHx8IDgwKSArIDUsIHdpbmRvdy5pbm5lckhlaWdodCAtIDIzMCl9cHhgO1xuICAgIGJveC5pbm5lckhUTUwgPSAnPGI+4pqhINCa0L7QvdGC0YDQsNCz0LXQvdGCPC9iPic7XG4gICAgY29uc3QgYWRkID0gKGlkLCBsYWJlbCwgcGxhY2Vob2xkZXIpID0+IHtcbiAgICAgICAgY29uc3QgbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7IGwudGV4dENvbnRlbnQgPSBsYWJlbDsgbC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7bWFyZ2luOjdweCAwIDNweDtmb250LXdlaWdodDo2MDA7JztcbiAgICAgICAgY29uc3QgaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7IGkuaWQgPSBpZDsgaS50eXBlID0gJ3RleHQnOyBpLnBsYWNlaG9sZGVyID0gcGxhY2Vob2xkZXIgfHwgJyc7IGkuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9JTlBVVF9DU1M7IGJveC5hcHBlbmRDaGlsZChsKTsgYm94LmFwcGVuZENoaWxkKGkpOyByZXR1cm4gaTtcbiAgICB9O1xuICAgIGFkZCgnaGFja2VyQWdlbnROYW1lJywgJ9Ck0JjQnicsICfQmNCy0LDQvdC+0LIg0JjQstCw0L0g0JjQstCw0L3QvtCy0LjRhycpO1xuICAgIGFkZCgnaGFja2VyQWdlbnRQaG9uZScsICfQndC+0LzQtdGAJywgJys3IDkwMCAwMDAtMDAtMDAnKTtcbiAgICBjb25zdCBjaGVjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7IGNoZWNrLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi10b3A6N3B4Oyc7XG4gICAgY2hlY2suaW5uZXJIVE1MID0gJzxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBpZD1cImhhY2tlckFnZW50Q2hlY2tDcmVhdGVcIj4g0LXRgdC70Lgg0L3QtSDQvdCw0LnQtNC10L0sINGB0L7Qt9C00LDRgtGMINC60L7QvdGC0YDQsNCz0LXQvdGC0LAnOyBib3guYXBwZW5kQ2hpbGQoY2hlY2spO1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjVweDttYXJnaW4tdG9wOjEwcHg7JztcbiAgICBjb25zdCBwaG9uZSA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJBZ2VudFBob25lJyk/LnZhbHVlLnRyaW0oKTtcbiAgICBjb25zdCBhc3NpZ24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgYXNzaWduLnRleHRDb250ZW50ID0gJ9Cf0L7QvNC10L3Rj9GC0YwnOyBhc3NpZ24uc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6IzRmNDZlNTtmbGV4OjE7JztcbiAgICBhc3NpZ24ub25jbGljayA9ICgpID0+IGhhY2tlckZpbmRBZ2VudEJ5UGhvbmUocGhvbmUoKSkudGhlbihyb3dzID0+IHJvd3MubGVuZ3RoID8gaGFja2VyQXNzaWduQWdlbnQocm93c1swXS5tZXRhLmhyZWYpLnRoZW4oKCkgPT4gaGFja2VyTG9nKCfinIUg0JrQvtC90YLRgNCw0LPQtdC90YIg0LfQsNC80LXQvdGR0L0nLCAnb2snKSkgOiBoYWNrZXJMb2coJ9Ca0L7QvdGC0YDQsNCz0LXQvdGCINC90LUg0L3QsNC50LTQtdC9JywgJ3dhcm4nKSkuY2F0Y2goZXJyb3IgPT4gaGFja2VyTG9nKCfQmtC+0L3RgtGA0LDQs9C10L3RgjogJyArIGVycm9yLm1lc3NhZ2UsICdlcnInKSk7XG4gICAgY29uc3QgY3JlYXRlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IGNyZWF0ZS50ZXh0Q29udGVudCA9ICfQodC+0LfQtNCw0YLRjCc7IGNyZWF0ZS5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX0JUTl9DU1MgKyAnYmFja2dyb3VuZDojMTZhMzRhO2ZsZXg6MTsnO1xuICAgIGNyZWF0ZS5pZCA9ICdoYWNrZXJBZ2VudENyZWF0ZSc7XG4gICAgY3JlYXRlLmRpc2FibGVkID0gaGFja2VyQWdlbnRDcmVhdGVQZW5kaW5nO1xuICAgIGNyZWF0ZS5vbmNsaWNrID0gKCkgPT4gaGFja2VyQWdlbnRDcmVhdGVDbGljayh7IGNoZWNrRmlyc3Q6IHRydWUgfSk7XG4gICAgY29uc3QgdmVyaWZ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IHZlcmlmeS50ZXh0Q29udGVudCA9ICfQn9GA0L7QstC10YDQuNGC0YwnOyB2ZXJpZnkuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9NSU5JX0JUTl9DU1M7XG4gICAgdmVyaWZ5Lm9uY2xpY2sgPSAoKSA9PiBoYWNrZXJBZ2VudENoZWNrQ2xpY2soKTtcbiAgICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBjbG9zZS50ZXh0Q29udGVudCA9ICfinJUnOyBjbG9zZS5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX01JTklfQlROX0NTUzsgY2xvc2Uub25jbGljayA9ICgpID0+IGJveC5yZW1vdmUoKTtcbiAgICByb3cuYXBwZW5kQ2hpbGQoYXNzaWduKTsgcm93LmFwcGVuZENoaWxkKGNyZWF0ZSk7IHJvdy5hcHBlbmRDaGlsZCh2ZXJpZnkpOyByb3cuYXBwZW5kQ2hpbGQoY2xvc2UpOyBib3guYXBwZW5kQ2hpbGQocm93KTsgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChib3gpO1xufVxuXG5mdW5jdGlvbiBidWlsZE1zSGFja2VyUXVpY2tSb3coa2luZCkge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHJvdy5pZCA9ICdtY0hhY2tlclF1aWNrUm93JztcbiAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjRweDthbGlnbi1pdGVtczpjZW50ZXI7bWFyZ2luOjJweCAwOyc7XG4gICAgW1snZGVtYW5kJywn4pqhKyDQvtGC0LPRgNGD0LfQutCwJ10sWydjYXNoaW4nLCfimqErINC/0YDQuNGF0L7QtNC90YvQuSDQvtGA0LTQtdGAJ10sWydwYXltZW50aW4nLCfimqErINCy0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2J10sWydjcmVkaXQnLCfimqErINC60YDQtdC00LjRgiddLFsnYWdlbnQnLCfimqEg0JrQvtC90YLRgNCw0LPQtdC90YInXV0uZm9yRWFjaCgoW2FjdGlvbixsYWJlbF0pID0+IHtcbiAgICAgICAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBiLnR5cGU9J2J1dHRvbic7IGIudGV4dENvbnRlbnQ9bGFiZWw7IGIuc3R5bGUuY3NzVGV4dD0ncGFkZGluZzozcHggOHB4O2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzMzNDE1NTtmb250LXNpemU6MTFweDtjdXJzb3I6cG9pbnRlcjsnOyBiLm9uY2xpY2s9KCk9PiBhY3Rpb24gPT09ICdhZ2VudCcgPyBoYWNrZXJPcGVuQWdlbnRRdWlja1BvcHVwKGIpIDogaGFja2VyT3BlblF1aWNrQWN0aW9uUG9wdXAoYWN0aW9uLCBiKTsgcm93LmFwcGVuZENoaWxkKGIpO1xuICAgIH0pO1xuICAgIGNvbnN0IHN1bUJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBzdW1CdG4udHlwZT0nYnV0dG9uJzsgc3VtQnRuLnRleHRDb250ZW50PSfwn5SEINCh0YPQvNC80LAnOyBzdW1CdG4udGl0bGU9J9Cf0YDQvtCy0LXRgNC40YLRjCDQuCDQv9C+0LTRgdGC0LDQstC40YLRjCDQsNC60YLRg9Cw0LvRjNC90YPRjiDRgdGD0LzQvNGDINC30LDQutCw0LfQsCc7IHN1bUJ0bi5zdHlsZS5jc3NUZXh0PSdwYWRkaW5nOjNweCA4cHg7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6I2ZmZjtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4O2N1cnNvcjpwb2ludGVyOyc7IHN1bUJ0bi5vbmNsaWNrPSgpID0+IGhhY2tlckNoZWNrT3JkZXJTdW0oKTsgcm93LmFwcGVuZENoaWxkKHN1bUJ0bik7XG4gICAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gYnVpbGRNc1F1aWNrUGFuZWwoKSB7XG4gICAgaWYgKCEvb25saW5lXFwubW95c2tsYWRcXC5ydSQvLnRlc3QobG9jYXRpb24uaG9zdG5hbWUpKSByZXR1cm47XG4gICAgY29uc3Qgb2xkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jUXVpY2tQYW5lbCcpO1xuICAgIGNvbnN0IG9sZFdyYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1tYy1xdWljay13cmFwXScpO1xuICAgIGNvbnN0IG9sZFF1aWNrUm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSGFja2VyUXVpY2tSb3cnKTtcbiAgICBjb25zdCBraW5kID0gT2JqZWN0LmtleXMoTVNfUVVJQ0tfUEFORUxfQ09ORklHKS5maW5kKGsgPT4gTVNfUVVJQ0tfUEFORUxfQ09ORklHW2tdLm1hcmtlcigpKTtcbiAgICBjb25zdCBjZmcgPSBraW5kID8gTVNfUVVJQ0tfUEFORUxfQ09ORklHW2tpbmRdIDogbnVsbDtcbiAgICBjb25zdCBxdWlja1NpZ25hdHVyZSA9IGNmZyA/IFtjZmcubWFnaWMgPyAnbWFnaWMnIDogJycsIC4uLmNmZy5jcmVhdGUsIC4uLmNmZy5wcmludF0uam9pbignXFx1MDAxZicpIDogJyc7XG4gICAgY29uc3QgZXhwZWN0ZWRCdXR0b25Db3VudCA9IGNmZyA/IGNmZy5jcmVhdGUubGVuZ3RoICsgY2ZnLnByaW50Lmxlbmd0aCArIChjZmcubWFnaWMgPyAxIDogMCkgOiAwO1xuICAgIGNvbnN0IHF1aWNrRW5hYmxlZCA9IEhBQ0tFUl9RVUlDS19BUElfUk9XX0VOQUJMRUQgJiYgaGFja2VyUXVpY2tCdXR0b25zRW5hYmxlZDtcbiAgICBjb25zdCBwYW5lbEhlYWx0aHkgPSBvbGQgJiYgb2xkLmlzQ29ubmVjdGVkICYmIG9sZC5kYXRhc2V0LmtpbmQgPT09IGtpbmRcbiAgICAgICAgJiYgb2xkLmRhdGFzZXQucXVpY2tTaWduYXR1cmUgPT09IHF1aWNrU2lnbmF0dXJlXG4gICAgICAgICYmIG9sZC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGggPT09IGV4cGVjdGVkQnV0dG9uQ291bnRcbiAgICAgICAgJiYgKCFjZmc/Lm1hZ2ljIHx8IG9sZC5xdWVyeVNlbGVjdG9yKCcjbWNNYWdpY1BhbmVsQWN0aW9uJyk/LmlzQ29ubmVjdGVkKVxuICAgICAgICAmJiAoIXF1aWNrRW5hYmxlZCB8fCBvbGRRdWlja1Jvdz8uaXNDb25uZWN0ZWQpO1xuICAgIC8vIEtlZXAgYSBjb21wbGV0ZSBwYWlyIHN0YWJsZSBhY3Jvc3MgTXV0YXRpb25PYnNlcnZlciBjYWxsYmFja3MuXG4gICAgaWYgKHBhbmVsSGVhbHRoeSkgcmV0dXJuO1xuICAgIGlmIChvbGRRdWlja1Jvdykgb2xkUXVpY2tSb3cucmVtb3ZlKCk7XG4gICAgaWYgKCFraW5kIHx8ICFtc1F1aWNrUGFuZWxFbmFibGVkKSB7IGlmIChvbGRXcmFwKSBvbGRXcmFwLnJlbW92ZSgpOyBlbHNlIGlmIChvbGQpIG9sZC5yZW1vdmUoKTsgcmV0dXJuOyB9XG5cbiAgICBpZiAob2xkV3JhcCkgb2xkV3JhcC5yZW1vdmUoKTsgZWxzZSBpZiAob2xkKSBvbGQucmVtb3ZlKCk7XG4gICAgLy8gVGhlIG9sZCBtYWluIHBhbmVsIG1heSBoYXZlIGJlZW4gcmVidWlsdCBieSB0aGUgU1BBOyBjcmVhdGUgb25lIGZyZXNoIHBhaXIuXG5cbiAgICBjb25zdCBhbmNob3IgPSBtc0dldFRvb2xiYXJCdXR0b24oJ9Ch0L7Qt9C00LDRgtGMINC00L7QutGD0LzQtdC90YInKSB8fCBtc0dldFRvb2xiYXJCdXR0b24oJ9Cf0LXRh9Cw0YLRjCcpO1xuICAgIGlmICghYW5jaG9yKSByZXR1cm47XG4gICAgLy8g0LzQuNC90LjQvNCw0LvRjNC90YvQuSDQvtCx0YnQuNC5INC60L7QvdGC0LXQudC90LXRgCDRgtGD0LvQsdCw0YDQsCAo0YHQvtC00LXRgNC20LjRgiDQuCDCq9Ch0L7Qt9C00LDRgtGMINC00L7QutGD0LzQtdC90YLCuywg0LggwqvQn9C10YfQsNGC0YzCuylcbiAgICBjb25zdCBwcmludEJ0biA9IG1zR2V0VG9vbGJhckJ1dHRvbign0J/QtdGH0LDRgtGMJyk7XG4gICAgbGV0IGJhciA9IGFuY2hvci5wYXJlbnRFbGVtZW50O1xuICAgIHdoaWxlIChiYXIgJiYgYmFyICE9PSBkb2N1bWVudC5ib2R5ICYmICEocHJpbnRCdG4gJiYgYmFyLmNvbnRhaW5zKHByaW50QnRuKSkpIHtcbiAgICAgICAgYmFyID0gYmFyLnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICAgIGlmICghYmFyIHx8IGJhciA9PT0gZG9jdW1lbnQuYm9keSkgcmV0dXJuO1xuXG4gICAgaWYgKCFxdWlja0VuYWJsZWQpIHsgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSGFja2VyUXVpY2tSb3cnKT8ucmVtb3ZlKCk7IH1cbiAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHBhbmVsLmlkID0gJ21jUXVpY2tQYW5lbCc7XG4gICAgcGFuZWwuZGF0YXNldC5raW5kID0ga2luZDtcbiAgICBwYW5lbC5kYXRhc2V0LnF1aWNrU2lnbmF0dXJlID0gcXVpY2tTaWduYXR1cmU7XG4gICAgcGFuZWwuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjRweDthbGlnbi1pdGVtczpjZW50ZXI7bWFyZ2luOjRweCAwOyc7XG5cbiAgICBjb25zdCBta0J0biA9IChlbW9qaSwgbGFiZWwsIG1lbnVMYWJlbCkgPT4ge1xuICAgICAgICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGIudHlwZSA9ICdidXR0b24nO1xuICAgICAgICBiLnRleHRDb250ZW50ID0gYCR7ZW1vaml9ICR7bGFiZWx9YDtcbiAgICAgICAgYi50aXRsZSA9IGAke21lbnVMYWJlbH06ICR7bGFiZWx9YDtcbiAgICAgICAgYi5zdHlsZS5jc3NUZXh0ID0gJ3BhZGRpbmc6M3B4IDhweDtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojZmZmOydcbiAgICAgICAgICAgICsgJ2NvbG9yOiMzMzQxNTU7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7d2hpdGUtc3BhY2U6bm93cmFwO3RyYW5zaXRpb246YWxsIC4xNXM7JztcbiAgICAgICAgYi5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4geyBiLnN0eWxlLmJhY2tncm91bmQgPSAnI2VlZjJmZic7IGIuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzYzNjZmMSc7IH0pO1xuICAgICAgICBiLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiB7IGIuc3R5bGUuYmFja2dyb3VuZCA9ICcjZmZmJzsgYi5zdHlsZS5ib3JkZXJDb2xvciA9ICcjY2JkNWUxJzsgfSk7XG4gICAgICAgIGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBwYW5lbC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5mb3JFYWNoKHggPT4geyB4LmRpc2FibGVkID0gdHJ1ZTsgeC5zdHlsZS5vcGFjaXR5ID0gJy41JzsgfSk7XG4gICAgICAgICAgICBhd2FpdCBtc0NsaWNrTWVudUl0ZW0obWVudUxhYmVsLCBsYWJlbCk7XG4gICAgICAgICAgICBwYW5lbC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5mb3JFYWNoKHggPT4geyB4LmRpc2FibGVkID0gZmFsc2U7IHguc3R5bGUub3BhY2l0eSA9ICcxJzsgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gYjtcbiAgICB9O1xuXG4gICAgaWYgKGNmZy5tYWdpYykge1xuICAgICAgICBjb25zdCBtYWdpYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBtYWdpYy5pZCA9ICdtY01hZ2ljUGFuZWxBY3Rpb24nO1xuICAgICAgICBtYWdpYy50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIG1hZ2ljLnRleHRDb250ZW50ID0gJ/CfqoQg0JfQsNC/0L7Qu9C90LjRgtGMJztcbiAgICAgICAgbWFnaWMudGl0bGUgPSAn0JfQsNC/0L7Qu9C90LjRgtGMINC90LDRgdGC0YDQvtC10L3QvdGL0LUg0L/QvtC70Y8g0Lgg0YHQvtGF0YDQsNC90LjRgtGMINC00L7QutGD0LzQtdC90YInO1xuICAgICAgICBtYWdpYy5zdHlsZS5jc3NUZXh0ID0gJ3BhZGRpbmc6M3B4IDhweDtib3JkZXI6MXB4IHNvbGlkICNjNGI1ZmQ7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojZjVmM2ZmOydcbiAgICAgICAgICAgICsgJ2NvbG9yOiM2ZDI4ZDk7Zm9udC1zaXplOjExcHg7Y3Vyc29yOnBvaW50ZXI7d2hpdGUtc3BhY2U6bm93cmFwO3RyYW5zaXRpb246YWxsIC4xNXM7JztcbiAgICAgICAgbWFnaWMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsgbWFnaWMuc3R5bGUuYmFja2dyb3VuZCA9ICcjZWRlOWZlJzsgbWFnaWMuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzhiNWNmNic7IH0pO1xuICAgICAgICBtYWdpYy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWxlYXZlJywgKCkgPT4geyBtYWdpYy5zdHlsZS5iYWNrZ3JvdW5kID0gJyNmNWYzZmYnOyBtYWdpYy5zdHlsZS5ib3JkZXJDb2xvciA9ICcjYzRiNWZkJzsgfSk7XG4gICAgICAgIG1hZ2ljLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gb3Blbk1zTWFnaWNQb3B1cChtYWdpYykpO1xuICAgICAgICBwYW5lbC5hcHBlbmRDaGlsZChtYWdpYyk7XG4gICAgfVxuICAgIGNmZy5jcmVhdGUuZm9yRWFjaChsYWJlbCA9PiBwYW5lbC5hcHBlbmRDaGlsZChta0J0bign4p6VJywgbGFiZWwsICfQodC+0LfQtNCw0YLRjCDQtNC+0LrRg9C80LXQvdGCJykpKTtcbiAgICBjZmcucHJpbnQuZm9yRWFjaChsYWJlbCA9PiBwYW5lbC5hcHBlbmRDaGlsZChta0J0bign8J+WqCcsIGxhYmVsLCAn0J/QtdGH0LDRgtGMJykpKTtcblxuICAgIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB3cmFwLmRhdGFzZXQubWNRdWlja1dyYXAgPSAnMSc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChwYW5lbCk7XG5cbiAgICAvLyBHV1Qt0LTQvtC60YPQvNC10L3RgtGLICjQvtGC0LPRgNGD0LfQutCwINC4INC/0YAuINGB0YLQsNGA0L7Qs9C+INC00LjQt9Cw0LnQvdCwKTog0LrQvtC90YLQtdC50L3QtdGAIOKAlCBUQUJMRSwg0YLRg9C70LHQsNGAXG4gICAgLy8g0LIg0YHRgtGA0L7QutC1INGC0LDQsdC70LjRhtGLLiDQktGB0YLQsNCy0LvRj9C10Lwg0L/QsNC90LXQu9GMINCe0KLQlNCV0JvQrNCd0J7QmSDRgdGC0YDQvtC60L7QuSBUUiDQodCg0JDQl9CjINCf0J7QodCb0JVcbiAgICAvLyDRgdGC0YDQvtC60Lgg0YLRg9C70LHQsNGA0LAgKNC90LUg0L/QvtGB0LvQtSDQt9Cw0LPQvtC70L7QstC60LAg4oCUINGC0LDQvCDQv9Cw0L3QtdC70Lgg0YPQtdC30LbQsNGO0YIg0LLQvdC40Lcg0YTQvtGA0LzRiykuXG4gICAgLy8g0JLQkNCW0J3QnjogYi1lZGl0b3ItdG9vbGJhciDRgdC+0LTQtdGA0LbQuNGCINCy0LvQvtC20LXQvdC90YvQtSDRgtCw0LHQu9C40YbRizsg0LjRidC10Lwg0JLQndCV0KjQndCY0JkgdGJvZHksXG4gICAgLy8g0LPQtNC1INGB0YLRgNC+0LrQsCDRgtGD0LvQsdCw0YDQsCDigJQg0L/RgNGP0LzQvtC5INGA0LXQsdGR0L3QvtC6LlxuICAgIGNvbnN0IHRvb2xiYXJUYWJsZSA9IGJhci5jbG9zZXN0KCd0YWJsZS5iLWVkaXRvci10b29sYmFyJyk7XG4gICAgY29uc3QgZXh0VGJvZHkgPSAoKCkgPT4ge1xuICAgICAgICBpZiAoIXRvb2xiYXJUYWJsZSkgcmV0dXJuIG51bGw7XG4gICAgICAgIGxldCByb3cgPSB0b29sYmFyVGFibGUuY2xvc2VzdCgndHInKTtcbiAgICAgICAgd2hpbGUgKHJvdyAmJiByb3cucGFyZW50RWxlbWVudCAmJiByb3cucGFyZW50RWxlbWVudC50YWdOYW1lICE9PSAnVEJPRFknKSByb3cgPSByb3cucGFyZW50RWxlbWVudC5jbG9zZXN0KCd0cicpO1xuICAgICAgICByZXR1cm4gcm93ID8gcm93LnBhcmVudEVsZW1lbnQgOiBudWxsO1xuICAgIH0pKCk7XG4gICAgaWYgKGV4dFRib2R5KSB7XG4gICAgICAgIGNvbnN0IHRvb2xiYXJSb3cgPSBbLi4uZXh0VGJvZHkuY2hpbGRyZW5dLmZpbmQociA9PiByLmNvbnRhaW5zKHRvb2xiYXJUYWJsZSkpO1xuICAgICAgICBpZiAodG9vbGJhclJvdykge1xuICAgICAgICAgICAgd3JhcC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTtwYWRkaW5nOjJweCA4cHg7JztcbiAgICAgICAgICAgIGNvbnN0IHRyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndHInKTtcbiAgICAgICAgICAgIGNvbnN0IHRkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGQnKTtcbiAgICAgICAgICAgIHRkLmNvbFNwYW4gPSB0b29sYmFyUm93LmNoaWxkcmVuLmxlbmd0aCB8fCAxO1xuICAgICAgICAgICAgdGQuYXBwZW5kQ2hpbGQod3JhcCk7XG4gICAgICAgICAgICB0ci5hcHBlbmRDaGlsZCh0ZCk7XG4gICAgICAgICAgICB0b29sYmFyUm93LmFmdGVyKHRyKTtcbiAgICAgICAgICAgIGlmICghcXVpY2tFbmFibGVkKSByZXR1cm47XG4gICAgICAgICAgICBjb25zdCBxdWlja1RyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndHInKTtcbiAgICAgICAgICAgIGNvbnN0IHF1aWNrVGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0ZCcpO1xuICAgICAgICAgICAgcXVpY2tUZC5jb2xTcGFuID0gdG9vbGJhclJvdy5jaGlsZHJlbi5sZW5ndGggfHwgMTtcbiAgICAgICAgICAgIHF1aWNrVGQuYXBwZW5kQ2hpbGQoYnVpbGRNc0hhY2tlclF1aWNrUm93KGtpbmQpKTtcbiAgICAgICAgICAgIHF1aWNrVHIuYXBwZW5kQ2hpbGQocXVpY2tUZCk7XG4gICAgICAgICAgICB0ci5hZnRlcihxdWlja1RyKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJlYWN0LdC00L7QutGD0LzQtdC90YLRiyAo0L3QvtCy0YvQuSDQtNC40LfQsNC50L0pOiDQv9C+0LTQvdC40LzQsNC10LzRgdGPINC00L4g0L/QvtGB0LvQtdC00L3QtdC5IGZsZXgt0YHRgtGA0L7QutC4XG4gICAgLy8g0Lgg0LLRgdGC0LDQstC70Y/QtdC8INC+0LHRkdGA0YLQutGDIChibG9jaywgd2lkdGg6MTAwJSkg0LXRkSDRgdC70LXQtNGD0Y7RidC40Lwg0YHQvtGB0LXQtNC+0LwuXG4gICAgbGV0IGZsZXhSb3cgPSBiYXI7XG4gICAgd2hpbGUgKGZsZXhSb3cucGFyZW50RWxlbWVudCAmJiBnZXRDb21wdXRlZFN0eWxlKGZsZXhSb3cucGFyZW50RWxlbWVudCkuZGlzcGxheSA9PT0gJ2ZsZXgnKSB7XG4gICAgICAgIGZsZXhSb3cgPSBmbGV4Um93LnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICAgIGNvbnN0IGhvc3QgPSBmbGV4Um93LnBhcmVudEVsZW1lbnQ7XG4gICAgaWYgKCFob3N0KSByZXR1cm47XG4gICAgd3JhcC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTsnO1xuICAgIGhvc3QuaW5zZXJ0QmVmb3JlKHdyYXAsIGZsZXhSb3cubmV4dFNpYmxpbmcpO1xuICAgIGlmICghcXVpY2tFbmFibGVkKSByZXR1cm47XG4gICAgY29uc3QgcXVpY2tSb3cgPSBidWlsZE1zSGFja2VyUXVpY2tSb3coa2luZCk7XG4gICAgcXVpY2tSb3cuc3R5bGUuY3NzVGV4dCArPSAnd2lkdGg6MTAwJTsnO1xuICAgIGhvc3QuaW5zZXJ0QmVmb3JlKHF1aWNrUm93LCB3cmFwLm5leHRTaWJsaW5nKTtcbn1cblxuIiwiLy8g4pSA4pSA4pSAINCe0YfQuNGB0YLQutCwINGC0LXQutGB0YLQsCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCS0YvQt9GL0LLQsNC10YLRgdGPINC/0YDQuCDQutCw0LbQtNC+0Lwg0L7RgtC60YDRi9GC0LjQuCDQvtC60L3QsCDQvdCw0YHRgtGA0L7QtdC6ICjRjdC70LXQvNC10L3RgtGLINGB0L7Qt9C00LDRjtGC0YHRjyDQt9Cw0L3QvtCy0L4pLFxuLy8g0L/QvtGN0YLQvtC80YMgZG9jdW1lbnQt0YHQu9GD0YjQsNGC0LXQu9GMINCy0LXRiNCw0LXRgtGB0Y8g0L7QtNC40L0g0YDQsNC3INGH0LXRgNC10Lcg0YTQu9Cw0LMuXG5mdW5jdGlvbiBsb2FkQ2xlYXJUZXh0RGVsYXkoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBOdW1iZXIobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnY2xlYXJUZXh0RGVsYXlfdjEnKSkpO1xuICAgICAgICBjbGVhclRleHREZWxheSA9IE51bWJlci5pc0ludGVnZXIodmFsdWUpICYmIHZhbHVlID49IDEgJiYgdmFsdWUgPD0gMjAwMCA/IHZhbHVlIDogNTAwO1xuICAgIH0gY2F0Y2ggeyBjbGVhclRleHREZWxheSA9IDUwMDsgfVxuICAgIHJldHVybiBjbGVhclRleHREZWxheTtcbn1cblxuZnVuY3Rpb24gc2F2ZUNsZWFyVGV4dERlbGF5KHZhbHVlKSB7XG4gICAgY29uc3QgZGVsYXkgPSBOdW1iZXIodmFsdWUpO1xuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihkZWxheSkgfHwgZGVsYXkgPCAxIHx8IGRlbGF5ID4gMjAwMCkgcmV0dXJuO1xuICAgIGNsZWFyVGV4dERlbGF5ID0gZGVsYXk7XG4gICAgaWYgKCFjbGVhclRleHRFbmFibGVkKSByZXR1cm47XG4gICAgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnY2xlYXJUZXh0RGVsYXlfdjEnKSwgU3RyaW5nKGRlbGF5KSk7IH1cbiAgICBjYXRjaCAoZXJyb3IpIHsgZGVidWdFcnJvcignc3RvcmFnZScsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQt9Cw0LTQtdGA0LbQutGDINC+0YfQuNGB0YLQutC4JywgZXJyb3IpOyB9XG59XG5cbmNvbnN0IGNsZWFyVGV4dFRpbWVycyA9IG5ldyBNYXAoKTtcbmZ1bmN0aW9uIGNhbmNlbENsZWFyVGV4dFRpbWVyKHRhcmdldCkge1xuICAgIGNsZWFyVGltZW91dChjbGVhclRleHRUaW1lcnMuZ2V0KHRhcmdldCkpO1xuICAgIGNsZWFyVGV4dFRpbWVycy5kZWxldGUodGFyZ2V0KTtcbn1cbmZ1bmN0aW9uIGxvYWRDbGVhclRleHRFbmFibGVkKCkge1xuICAgIGNvbnN0IGtleSA9IHN0b3JhZ2VLZXkoJ2NsZWFyVGV4dEVuYWJsZWQnKTtcbiAgICBsZXQgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpO1xuICAgIGlmIChzYXZlZCA9PT0gbnVsbCAmJiB0eXBlb2YgTUVNQ0hBVF9CVUlMRCA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnY2xlYXJUZXh0RW5hYmxlZCcpO1xuICAgICAgICBpZiAoc2F2ZWQgIT09IG51bGwpIHtcbiAgICAgICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGtleSwgc2F2ZWQpO1xuICAgICAgICAgICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oJ2NsZWFyVGV4dEVuYWJsZWQnKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBjbGVhclRleHRFbmFibGVkID0gc2F2ZWQgPT09ICd0cnVlJztcbn1cbmZ1bmN0aW9uIHNldHVwR2xvYmFsQ2xlYXJUZXh0RnVuY3Rpb25hbGl0eSgpIHtcbiAgICBsb2FkQ2xlYXJUZXh0RW5hYmxlZCgpO1xuICAgIGlmICghY2xlYXJUZXh0RW5hYmxlZCkgZm9yIChjb25zdCB0YXJnZXQgb2YgY2xlYXJUZXh0VGltZXJzLmtleXMoKSkgY2FuY2VsQ2xlYXJUZXh0VGltZXIodGFyZ2V0KTtcbiAgICBsb2FkQ2xlYXJUZXh0RGVsYXkoKTtcbiAgICBjb25zdCBzbGlkZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGltZW91dFNsaWRlcicpO1xuICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRWYWx1ZScpO1xuICAgIGlmIChzbGlkZXIpIHtcbiAgICAgICAgc2xpZGVyLnZhbHVlID0gU3RyaW5nKGNsZWFyVGV4dERlbGF5KTtcbiAgICAgICAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IHNsaWRlci52YWx1ZTtcbiAgICAgICAgaWYgKCFzbGlkZXIuZGF0YXNldC5tZW1jaGF0Q2xlYXJCb3VuZCkgc2xpZGVyLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IHNsaWRlci52YWx1ZTtcbiAgICAgICAgICAgIHNhdmVDbGVhclRleHREZWxheShzbGlkZXIudmFsdWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgc2xpZGVyLmRhdGFzZXQubWVtY2hhdENsZWFyQm91bmQgPSAndHJ1ZSc7XG4gICAgfVxuICAgIGNvbnN0IGNiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyVGV4dENoZWNrYm94Jyk7XG4gICAgaWYgKGNiKSB7XG4gICAgICAgIGNiLmNoZWNrZWQgPSBjbGVhclRleHRFbmFibGVkO1xuICAgICAgICBpZiAoIWNiLmRhdGFzZXQubWVtY2hhdENsZWFyQm91bmQpIGNiLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHNldENsZWFyVGV4dEVuYWJsZWQodGhpcy5jaGVja2VkKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNiLmRhdGFzZXQubWVtY2hhdENsZWFyQm91bmQgPSAndHJ1ZSc7XG4gICAgfVxuICAgIGlmICghZ2xvYmFsQ2xlYXJLZXlwcmVzc0JvdW5kKSB7XG4gICAgICAgIGdsb2JhbENsZWFyS2V5cHJlc3NCb3VuZCA9IHRydWU7XG4gICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2tleXByZXNzJywgZSA9PiB7XG4gICAgICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgIWUuaXNDb21wb3NpbmcgJiYgZS5rZXlDb2RlICE9PSAyMjkgJiYgY2xlYXJUZXh0RW5hYmxlZCAmJiAoZS50YXJnZXQudGFnTmFtZSA9PT0gJ0lOUFVUJyB8fCBlLnRhcmdldC50YWdOYW1lID09PSAnVEVYVEFSRUEnKSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0LCB2YWx1ZSA9IHRhcmdldC52YWx1ZTtcbiAgICAgICAgICAgICAgICBjYW5jZWxDbGVhclRleHRUaW1lcih0YXJnZXQpO1xuICAgICAgICAgICAgICAgIGNsZWFyVGV4dFRpbWVycy5zZXQodGFyZ2V0LCBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUZXh0VGltZXJzLmRlbGV0ZSh0YXJnZXQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoY2xlYXJUZXh0RW5hYmxlZCAmJiB0YXJnZXQuaXNDb25uZWN0ZWQgJiYgdGFyZ2V0LnZhbHVlID09PSB2YWx1ZSkgdGFyZ2V0LnZhbHVlID0gJyc7XG4gICAgICAgICAgICAgICAgfSwgY2xlYXJUZXh0RGVsYXkpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgZSA9PiBjYW5jZWxDbGVhclRleHRUaW1lcihlLnRhcmdldCksIHRydWUpO1xuICAgICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdjb21wb3NpdGlvbnN0YXJ0JywgZSA9PiBjYW5jZWxDbGVhclRleHRUaW1lcihlLnRhcmdldCksIHRydWUpO1xuICAgICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncGFnZWhpZGUnLCAoKSA9PiB7IGZvciAoY29uc3QgdGFyZ2V0IG9mIGNsZWFyVGV4dFRpbWVycy5rZXlzKCkpIGNhbmNlbENsZWFyVGV4dFRpbWVyKHRhcmdldCk7IH0pO1xuICAgIH1cbiAgICB1cGRhdGVDbGVhclRleHRCdXR0b24oKTtcbn1cblxuZnVuY3Rpb24gc2V0Q2xlYXJUZXh0RW5hYmxlZChlbmFibGVkKSB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnY2xlYXJUZXh0RW5hYmxlZCcpLCBTdHJpbmcoISFlbmFibGVkKSk7XG4gICAgY2xlYXJUZXh0RW5hYmxlZCA9ICEhZW5hYmxlZDtcbiAgICBpZiAoIWNsZWFyVGV4dEVuYWJsZWQpIGZvciAoY29uc3QgdGFyZ2V0IG9mIGNsZWFyVGV4dFRpbWVycy5rZXlzKCkpIGNhbmNlbENsZWFyVGV4dFRpbWVyKHRhcmdldCk7XG4gICAgaWYgKGNsZWFyVGV4dEVuYWJsZWQpIHNhdmVDbGVhclRleHREZWxheShkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGltZW91dFNsaWRlcicpPy52YWx1ZSB8fCBjbGVhclRleHREZWxheSk7XG4gICAgY29uc3QgY2IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJUZXh0Q2hlY2tib3gnKTtcbiAgICBpZiAoY2IpIGNiLmNoZWNrZWQgPSBjbGVhclRleHRFbmFibGVkO1xuICAgIHVwZGF0ZUNsZWFyVGV4dEJ1dHRvbigpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVDbGVhclRleHRCdXR0b24oKSB7XG4gICAgY29uc3QgYnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jQ2xlYXJUZXh0VG9nZ2xlJyk7XG4gICAgaWYgKCFidG4pIHJldHVybjtcbiAgICBidG4uc2V0QXR0cmlidXRlKCdhcmlhLXByZXNzZWQnLCBTdHJpbmcoY2xlYXJUZXh0RW5hYmxlZCkpO1xuICAgIGJ0bi5kYXRhc2V0LnRpcCA9IGNsZWFyVGV4dEVuYWJsZWRcbiAgICAgICAgPyAn8J+nuSDQntGH0LjRgdGC0LrQsCDQv9C+0LvRjyDQv9C+0YHQu9C1IEVudGVyINCy0LrQu9GO0YfQtdC90LAnXG4gICAgICAgIDogJ/Cfp7kg0J7Rh9C40YHRgtC60LAg0L/QvtC70Y8g0L/QvtGB0LvQtSBFbnRlciDQstGL0LrQu9GO0YfQtdC90LAnO1xuICAgIGlmIChjbGVhclRleHRFbmFibGVkKSB7XG4gICAgICAgIGJ0bi5zdHlsZS5iYWNrZ3JvdW5kID0gJyNkY2ZjZTcnO1xuICAgICAgICBidG4uc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzIyYzU1ZSc7XG4gICAgICAgIGJ0bi5zdHlsZS5jb2xvciA9ICcjMTY2NTM0JztcbiAgICB9IGVsc2Uge1xuICAgICAgICBidG4uc3R5bGUuYmFja2dyb3VuZCA9ICcjZjhmYWZjJztcbiAgICAgICAgYnRuLnN0eWxlLmJvcmRlckNvbG9yID0gJyNlMmU4ZjAnO1xuICAgICAgICBidG4uc3R5bGUuY29sb3IgPSAnIzY0NzQ4Yic7XG4gICAgfVxufVxuIiwiLy8g4pSA4pSA4pSAINCU0LjRgdC/0LXRgtGH0LXRgCDQtNC10LnRgdGC0LLQuNC5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gZXhlY3V0ZUN1cnJlbnRBY3Rpb24oKSB7XG4gICAgLy8gRW50ZXIg0YDQsNCx0L7RgtCw0LXRgiDRgtC+0LvRjNC60L4g0L3QsCDRgNC10LbQuNC80L3Ri9GFINCy0LrQu9Cw0LTQutCw0YU7INC00LvRjyDQtNC10LnRgdGC0LLQuNC5INC4IMKr0J3QsNGB0YLRgNC+0LXQusK7IOKAlCBuby1vcC5cbiAgICBkZWJ1Z0xvZygnYWN0aW9uJywgY3VycmVudEFjdGlvbik7XG4gICAgc3dpdGNoIChjdXJyZW50QWN0aW9uKSB7XG4gICAgICAgIGNhc2UgJ2NoZWNrSGF0aWtvJzogICAgICAgICAgY2hlY2tIYXRpa28oKTsgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdjaGVja0hhdGlrb0JvbnVzZXMnOiAgIGNoZWNrSGF0aWtvQm9udXNlcygpOyAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnY2FsY3VsYXRvcic6ICAgICAgICAgICBjYWxjdWxhdGVDcmVkaXQoKTsgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ2NhbGN1bGF0b3JfcmV2ZXJzZSc6ICAgY2FsY3VsYXRlUmV2ZXJzZSgpOyAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdjYWxjdWxhdG9yX2Rpc2NvdW50JzogIGFwcGx5RGlzY291bnRPck1hcmt1cCgpOyAgICBicmVhaztcbiAgICAgICAgY2FzZSAnY2FsY3VsYXRvcl9zaW1wbGUnOiAgICBjYWxjdWxhdGVTaW1wbGUoKTsgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6IC8qIG5vLW9wICovO1xuICAgIH1cbn1cblxuIiwiLy8g4pSA4pSA4pSAINCh0L7Qt9C00LDQvdC40LUg0LjQvdGC0LXRgNGE0LXQudGB0LAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBjcmVhdGVQcmljZUNoZWNrV2luZG93KCkge1xuXG4gICAgaWYgKCF3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lcikge1xuXG4gICAgICAgIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3R5bGUnKTtcbiAgICAgICAgc3R5bGUudGV4dENvbnRlbnQgPSBgXG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciB7XG4gICAgICAgICAgICAgICAgZm9udC1mYW1pbHk6ICdTZWdvZSBVSScsIHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgc2Fucy1zZXJpZjtcbiAgICAgICAgICAgICAgICBmb250LXNpemU6IDEzcHg7XG4gICAgICAgICAgICAgICAgY29sb3I6ICMxZjI5Mzc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAqOjotd2Via2l0LXNjcm9sbGJhciB7IHdpZHRoOiA0cHg7IGhlaWdodDogNHB4OyB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAqOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6ICNmMWY1Zjk7IH1cbiAgICAgICAgICAgICNwcmljZUNoZWNrQ29udGFpbmVyICo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogI2NiZDVlMTsgYm9yZGVyLXJhZGl1czogNHB4OyB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciAqOjotd2Via2l0LXNjcm9sbGJhci10aHVtYjpob3ZlciB7IGJhY2tncm91bmQ6ICM2MzY2ZjE7IH1cblxuICAgICAgICAgICAgLm1jLWJ0biB7XG4gICAgICAgICAgICAgICAgcGFkZGluZzogNnB4IDEwcHg7IGJvcmRlcjogbm9uZTsgYm9yZGVyLXJhZGl1czogOHB4O1xuICAgICAgICAgICAgICAgIGNvbG9yOiAjZmZmOyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogMTJweDsgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgICAgICAgICB0cmFuc2l0aW9uOiBhbGwgLjE4cyBlYXNlOyB3aGl0ZS1zcGFjZTogbm93cmFwOyBsZXR0ZXItc3BhY2luZzogLjJweDtcbiAgICAgICAgICAgICAgICBsaW5lLWhlaWdodDogMS4zO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLm1jLWJ0bjpob3ZlciAgeyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTFweCk7IGZpbHRlcjogYnJpZ2h0bmVzcygxLjE1KTsgfVxuICAgICAgICAgICAgLm1jLWJ0bjphY3RpdmUgeyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoMCk7ICAgIGZpbHRlcjogYnJpZ2h0bmVzcyguOTUpOyAgfVxuICAgICAgICAgICAgLm1jLWJ0bi1ncmVlbiAgeyBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzIyYzU1ZSwjMTZhMzRhKTsgYm94LXNoYWRvdzowIDJweCA4cHggIzIyYzU1ZTI4OyB9XG4gICAgICAgICAgICAubWMtYnRuLWJsdWUgICB7IGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjM2I4MmY2LCMyNTYzZWIpOyBib3gtc2hhZG93OjAgMnB4IDhweCAjM2I4MmY2Mjg7IH1cbiAgICAgICAgICAgIC5tYy1idG4tcHVycGxlIHsgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCNhODU1ZjcsIzdjM2FlZCk7IGJveC1zaGFkb3c6MCAycHggOHB4ICNhODU1ZjcyODsgfVxuICAgICAgICAgICAgLm1jLWJ0bi1vcmFuZ2UgeyBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsI2Y5NzMxNiwjZWE1ODBjKTsgYm94LXNoYWRvdzowIDJweCA4cHggI2Y5NzMxNjI4OyB9XG4gICAgICAgICAgICAubWMtYnRuLXRlYWwgICB7IGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjMTRiOGE2LCMwZDk0ODgpOyBib3gtc2hhZG93OjAgMnB4IDhweCAjMTRiOGE2Mjg7IH1cbiAgICAgICAgICAgIC5tYy1idG4taW5kaWdvIHsgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM2MzY2ZjEsIzRmNDZlNSk7IGJveC1zaGFkb3c6MCAycHggOHB4ICM2MzY2ZjEyODsgfVxuICAgICAgICAgICAgLm1jLWJ0bi1zbGF0ZSAgeyBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzQ3NTU2OSwjMzM0MTU1KTsgYm9yZGVyOjFweCBzb2xpZCAjNDc1NTY5OyBib3gtc2hhZG93Om5vbmU7IH1cbiAgICAgICAgICAgIC5tYy1idG4tYWN0aXZlIHtcbiAgICAgICAgICAgICAgICBvdXRsaW5lOiAycHggc29saWQgI2ZmZiAhaW1wb3J0YW50O1xuICAgICAgICAgICAgICAgIG91dGxpbmUtb2Zmc2V0OiAycHggIWltcG9ydGFudDtcbiAgICAgICAgICAgICAgICBmaWx0ZXI6IGJyaWdodG5lc3MoMS4xNSkgIWltcG9ydGFudDtcbiAgICAgICAgICAgICAgICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTFweCkgIWltcG9ydGFudDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5tYy1zZWN0aW9uLWxhYmVsIHtcbiAgICAgICAgICAgICAgICBmb250LXNpemU6IDEwcHg7IGZvbnQtd2VpZ2h0OiA4MDA7IGNvbG9yOiAjNjQ3NDhiO1xuICAgICAgICAgICAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAuOHB4O1xuICAgICAgICAgICAgICAgIG1hcmdpbi1ib3R0b206IDZweDsgcGFkZGluZy1sZWZ0OiAycHg7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAubWMtcGFuZWwge1xuICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmOGZhZmM7IGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7XG4gICAgICAgICAgICAgICAgYm9yZGVyLXJhZGl1czogMTJweDsgcGFkZGluZzogMTFweDtcbiAgICAgICAgICAgICAgICBtYXgtaGVpZ2h0OiAzMjBweDsgb3ZlcmZsb3cteTogYXV0bztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC5tYy1wYW5lbC10aXRsZSB7XG4gICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMHB4OyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogIzRmNDZlNTtcbiAgICAgICAgICAgICAgICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOyBsZXR0ZXItc3BhY2luZzogLjdweDtcbiAgICAgICAgICAgICAgICBtYXJnaW4tYm90dG9tOiAxMHB4O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tJbnB1dCB7XG4gICAgICAgICAgICAgICAgd2lkdGg6IDEwMCU7IHBhZGRpbmc6IDhweCA0NHB4IDhweCAxMnB4O1xuICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmZmZmZmY7IGJvcmRlcjogMS41cHggc29saWQgI2NiZDVlMTtcbiAgICAgICAgICAgICAgICBib3JkZXItcmFkaXVzOiAxMHB4OyBjb2xvcjogIzFmMjkzNzsgZm9udC1zaXplOiAxM3B4O1xuICAgICAgICAgICAgICAgIGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG91dGxpbmU6IG5vbmU7XG4gICAgICAgICAgICAgICAgdHJhbnNpdGlvbjogYm9yZGVyLWNvbG9yIC4ycywgYm94LXNoYWRvdyAuMnM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0lucHV0OmZvY3VzIHtcbiAgICAgICAgICAgICAgICBib3JkZXItY29sb3I6ICM2MzY2ZjE7IGJveC1zaGFkb3c6IDAgMCAwIDNweCAjNjM2NmYxMTg7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0lucHV0OjpwbGFjZWhvbGRlciB7IGNvbG9yOiAjOTRhM2I4OyB9XG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciBzZWxlY3QsXG4gICAgICAgICAgICAjcHJpY2VDaGVja0NvbnRhaW5lciBpbnB1dFt0eXBlPVwicmFuZ2VcIl0geyBhY2NlbnQtY29sb3I6IzRmNDZlNTsgfVxuICAgICAgICAgICAgI3ByaWNlQ2hlY2tDb250YWluZXIgbGFiZWwgeyBjb2xvcjojNDc1NTY5ICFpbXBvcnRhbnQ7IH1cbiAgICAgICAgICAgICNwcmljZUNoZWNrQ29udGFpbmVyIC5tYy1wYW5lbCBpbnB1dFt0eXBlPVwidGV4dFwiXSxcbiAgICAgICAgICAgICNwcmljZUNoZWNrQ29udGFpbmVyIC5tYy1wYW5lbCB0ZXh0YXJlYSxcbiAgICAgICAgICAgICNwcmljZUNoZWNrQ29udGFpbmVyIC5tYy1wYW5lbCBzZWxlY3QgeyBiYWNrZ3JvdW5kOiNmZmZmZmYgIWltcG9ydGFudDsgY29sb3I6IzMzNDE1NSAhaW1wb3J0YW50OyBib3JkZXItY29sb3I6I2NiZDVlMSAhaW1wb3J0YW50OyB9XG4gICAgICAgICAgICAjaGF0aWtvUmVxdWVzdFN0YXR1cyB7IGRpc3BsYXk6bm9uZTsgY29sb3I6IzQ3NTU2OTsgZm9udC1zaXplOjEwcHg7IG1pbi1oZWlnaHQ6MTRweDsgcGFkZGluZzo1cHggOHB4OyBib3JkZXItcmFkaXVzOjdweDsgYmFja2dyb3VuZDojZjFmNWY5OyBib3JkZXI6MXB4IHNvbGlkICNlMmU4ZjA7IH1cbiAgICAgICAgICAgICNoYXRpa29SZXF1ZXN0U3RhdHVzW2RhdGEtc3RhdGVdIHsgZGlzcGxheTpibG9jazsgfVxuICAgICAgICAgICAgI2hhdGlrb1JlcXVlc3RTdGF0dXNbZGF0YS1zdGF0ZT1cImJ1c3lcIl0geyBjb2xvcjojMWQ0ZWQ4OyBiYWNrZ3JvdW5kOiNkYmVhZmU7IH1cbiAgICAgICAgICAgICNoYXRpa29SZXF1ZXN0U3RhdHVzW2RhdGEtc3RhdGU9XCJva1wiXSB7IGNvbG9yOiMxNjY1MzQ7IGJhY2tncm91bmQ6I2RjZmNlNzsgfVxuICAgICAgICAgICAgI2hhdGlrb1JlcXVlc3RTdGF0dXNbZGF0YS1zdGF0ZT1cIndhcm5cIl0geyBjb2xvcjojOTI0MDBlOyBiYWNrZ3JvdW5kOiNmZWYzYzc7IH1cbiAgICAgICAgICAgICNoYXRpa29SZXF1ZXN0U3RhdHVzW2RhdGEtc3RhdGU9XCJlcnJvclwiXSB7IGNvbG9yOiM5OTFiMWI7IGJhY2tncm91bmQ6I2ZlZTJlMjsgfVxuICAgICAgICAgICAgLm1jLWxpbmtzLXBhbmVsIHtcbiAgICAgICAgICAgICAgICBkaXNwbGF5Om5vbmU7IG1heC1oZWlnaHQ6MTUwcHg7IG92ZXJmbG93LXk6YXV0bztcbiAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiNmZmZmZmY7IGJvcmRlcjoxcHggc29saWQgI2U1ZTdlYjtcbiAgICAgICAgICAgICAgICBib3JkZXItcmFkaXVzOjEwcHg7IHBhZGRpbmc6OHB4IDEwcHg7IGZvbnQtc2l6ZToxMXB4O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLm1jLWxpbmtzLXBhbmVsIGEgeyBkaXNwbGF5OmJsb2NrOyBjb2xvcjojMjU2M2ViOyBtYXJnaW46NHB4IDA7IHdvcmQtYnJlYWs6YnJlYWstYWxsOyB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8qIOKUgOKUgCDQktC60LvQsNC00LrQuCDilIDilIAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgICNtY1RhYnMge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7IGZsZXg6IDAgMCBhdXRvOyBtaW4taGVpZ2h0OiAzMnB4OyBhbGlnbi1pdGVtczogc3RyZXRjaDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBnYXA6IDRweDsgb3ZlcmZsb3cteDogYXV0bzsgb3ZlcmZsb3cteTogdmlzaWJsZTsgZmxleC13cmFwOiBub3dyYXA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFkZGluZzogMXB4IDAgM3B4OyBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgI21jVGFiczo6LXdlYmtpdC1zY3JvbGxiYXIgeyBoZWlnaHQ6IDNweDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXRhYiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmxleDogMCAwIGF1dG87IG1pbi1oZWlnaHQ6IDI4cHg7IGhlaWdodDogMjhweDsgYm94LXNpemluZzogYm9yZGVyLWJveDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFkZGluZzogNHB4IDhweDsgYm9yZGVyOiAxcHggc29saWQgI2UyZThmMDsgYm9yZGVyLXJhZGl1czogOHB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmOGZhZmM7IGNvbG9yOiAjNDc1NTY5OyBmb250LXNpemU6IDExcHg7IGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGluZS1oZWlnaHQ6IDE4cHg7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYWxsIC4xNXMgZWFzZTsgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy10YWI6aG92ZXIgeyBib3JkZXItY29sb3I6ICM2MzY2ZjE7IGNvbG9yOiAjNGY0NmU1OyBiYWNrZ3JvdW5kOiAjZWVmMmZmOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtdGFiLWFjdGl2ZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCM4YjVjZjYpICFpbXBvcnRhbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyLWNvbG9yOiB0cmFuc3BhcmVudCAhaW1wb3J0YW50OyBjb2xvcjogI2ZmZiAhaW1wb3J0YW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJveC1zaGFkb3c6IDAgMnB4IDhweCAjNjM2NmYxMzg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8qIOKUgOKUgCDQm9C10L10YSDRgdC+0L7QsdGJ0LXQvdC40LkgKNCy0LzQtdGB0YJvIHRleHRhcmVhKSDilIDilIAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgICNtY0NoYXRMb2cge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZsZXg6IDEgMSBhdXRvOyB3aWR0aDogMTAwJTsgbWluLWhlaWdodDogODBweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiA2cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogNnB4OyBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmZmZmZmY7IGJvcmRlcjogMS41cHggc29saWQgI2U1ZTdlYjsgYm9yZGVyLXJhZGl1czogMTBweDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICNtY0NoYXRMb2c6ZW1wdHk6OmFmdGVyIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50OiAn0JfQsNC/0YDQvtGB0Ysg0L/QvtGP0LLRj9GC0YHRjyDQt9C00LXRgdGM4oCmJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBibG9jazsgbWFyZ2luOiBhdXRvOyBjb2xvcjogIzk0YTNiODsgZm9udC1zaXplOiAxMXB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnQtc3R5bGU6IGl0YWxpYzsgb3BhY2l0eTogLjg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYXgtd2lkdGg6IDkyJTsgcGFkZGluZzogNXB4IDlweDsgYm9yZGVyLXJhZGl1czogMTBweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250LXNpemU6IDExLjVweDsgbGluZS1oZWlnaHQ6IDEuNTU7IHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm94LXNpemluZzogYm9yZGVyLWJveDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1tc2ctbWV0YSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOiA4LjVweDsgb3BhY2l0eTogLjY1OyBsZXR0ZXItc3BhY2luZzogLjNweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYXJnaW4tYm90dG9tOiAycHg7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnLWJvZHkgeyB3aGl0ZS1zcGFjZTogcHJlLXdyYXA7IHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1tc2ctdXNlciB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpZ24tc2VsZjogZmxleC1lbmQ7IGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzYzNjZmMSwjN2MzYWVkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcjogI2ZmZjsgYm9yZGVyLWJvdHRvbS1yaWdodC1yYWRpdXM6IDNweDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1tc2ctdXNlciAubWMtbXNnLW1ldGEgeyBjb2xvcjogI2UwZTdmZjsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW1zZy1ib3Qge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFsaWduLXNlbGY6IGZsZXgtc3RhcnQ7IGJhY2tncm91bmQ6ICNmMWY1Zjk7IGNvbG9yOiAjMWYyOTM3O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7IGJvcmRlci1ib3R0b20tbGVmdC1yYWRpdXM6IDNweDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1tc2ctYm90IC5tYy1tc2ctbWV0YSB7IGNvbG9yOiAjNjM2NmYxOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtbXNnLXN5c3RlbSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpZ24tc2VsZjogY2VudGVyOyBiYWNrZ3JvdW5kOiAjZmVmOWMzOyBjb2xvcjogIzg1NGQwZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjZmRlNjhhOyBmb250LXNpemU6IDEwLjVweDsgdGV4dC1hbGlnbjogY2VudGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWNvcHktYnRuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IG1hcmdpbi10b3A6IDVweDsgcGFkZGluZzogMnB4IDhweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDFweCBzb2xpZCAjYzdkMmZlOyBib3JkZXItcmFkaXVzOiA2cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDogI2ZmZmZmZjsgY29sb3I6ICM0ZjQ2ZTU7IGZvbnQtc2l6ZTogOS41cHg7IGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3Vyc29yOiBwb2ludGVyOyB0cmFuc2l0aW9uOiBhbGwgLjE1cztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1jb3B5LWJ0bjpob3ZlciB7IGJhY2tncm91bmQ6ICNlZWYyZmY7IGJvcmRlci1jb2xvcjogIzgxOGNmODsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWNvcHktZG9uZSB7IGJhY2tncm91bmQ6ICNkY2ZjZTcgIWltcG9ydGFudDsgYm9yZGVyLWNvbG9yOiAjODZlZmFjICFpbXBvcnRhbnQ7IGNvbG9yOiAjMTY2NTM0ICFpbXBvcnRhbnQ7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1yZXRyeS1idG4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGlubGluZS1ibG9jazsgbWFyZ2luLXRvcDogNXB4OyBwYWRkaW5nOiAycHggOHB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMXB4IHNvbGlkICNhNWQ2ZjI7IGJvcmRlci1yYWRpdXM6IDZweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZmZmZmZmOyBjb2xvcjogIzFkNGVkODsgZm9udC1zaXplOiA5LjVweDsgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJzb3I6IHBvaW50ZXI7IHRyYW5zaXRpb246IGFsbCAuMTVzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXJldHJ5LWJ0bjpob3ZlciB7IGJhY2tncm91bmQ6ICNkYmVhZmU7IGJvcmRlci1jb2xvcjogIzYwYTVmYTsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLm1jLW1zZy1hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiA0cHg7IGZsZXgtd3JhcDogd3JhcDsgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvKiDilIDilIAg0J3QuNC20L3Rj9GPINC/0LDQvdC10LvRjCDilIDilIAgKi9cbiAgICAgICAgICAgICAgICAgICAgICAgICNtY0JvdHRvbUJhciB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmxleDogMCAwIGF1dG87IGRpc3BsYXk6IGZsZXg7IGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7IGdhcDogNnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWJ0bi1jbGVhciB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFkZGluZzogNXB4IDEycHg7IGJvcmRlcjogMXB4IHNvbGlkICNmY2E1YTU7IGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kOiAjZmZmZmZmOyBjb2xvcjogI2RjMjYyNjsgZm9udC1zaXplOiAxMXB4OyBmb250LXdlaWdodDogNjAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYWxsIC4xNXM7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtYnRuLWNsZWFyOmhvdmVyIHsgYmFja2dyb3VuZDogI2ZlZjJmMjsgYm9yZGVyLWNvbG9yOiAjZWY0NDQ0OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtYWN0aW9uLWJ0biB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFkZGluZzogNHB4IDlweDsgYm9yZGVyOiAxcHggc29saWQgI2UyZThmMDsgYm9yZGVyLXJhZGl1czogOHB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNmOGZhZmM7IGZvbnQtc2l6ZTogMTNweDsgbGluZS1oZWlnaHQ6IDE7IGN1cnNvcjogcG9pbnRlcjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmFuc2l0aW9uOiBhbGwgLjE1cztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1hY3Rpb24tYnRuOmhvdmVyIHsgYmFja2dyb3VuZDogI2VlZjJmZjsgYm9yZGVyLWNvbG9yOiAjODE4Y2Y4OyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoLTFweCk7IH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLyog4pSA4pSAINCh0YLQsNGC0YPRgS3QsdCw0YA6INC/0L7QtNGB0LrQsNC30LrQuCDQv9GA0Lgg0L3QsNCy0LXQtNC10L3QuNC4IOKUgOKUgCAqL1xuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLXN0YXR1cy1iYXIge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZsZXg6IDEgMSBhdXRvOyBtaW4td2lkdGg6IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOiAxMHB4OyBjb2xvcjogIzY0NzQ4YjsgbGluZS1oZWlnaHQ6IDEuMztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aGl0ZS1zcGFjZTogbm93cmFwOyBvdmVyZmxvdzogaGlkZGVuOyB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB1c2VyLXNlbGVjdDogbm9uZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLyog4pSA4pSAINCf0LvQsNCy0LDRjtGJ0LjQtSDQvtC60L3QsCAo0YDQsNGB0L/QuNGB0LDQvdC40LUsINCl0LDQutC10YApIOKAlCDQsdC10Lcg0LfQsNGC0LXQvNC90LXQvdC40Y8g4pSA4pSAICovXG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtZmxvYXQtd2luZG93IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwb3NpdGlvbjogZml4ZWQ7IHRvcDogOTBweDsgcmlnaHQ6IDQwcHg7IHdpZHRoOiAzODBweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBtYXgtaGVpZ2h0OiA3MHZoOyBiYWNrZ3JvdW5kOiAjZmZmZmZmOyBib3JkZXI6IDFweCBzb2xpZCAjZGJlM2VlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDE0cHg7IGJveC1zaGFkb3c6IDAgMTRweCA0MHB4IHJnYmEoMTUsMjMsNDIsLjE4KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDhweDsgcGFkZGluZzogMTJweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB6LWluZGV4OiAxMDAwMDA7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6ICMxZjI5Mzc7IGZvbnQtc2l6ZTogMTIuNXB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWZsb2F0LWhlYWRlciB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnNvcjogbW92ZTsgdXNlci1zZWxlY3Q6IG5vbmU7IHBhZGRpbmctYm90dG9tOiA2cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNlMmU4ZjA7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtZmxvYXQtdGl0bGUgeyBmb250LXNpemU6IDEzLjVweDsgZm9udC13ZWlnaHQ6IDcwMDsgY29sb3I6ICMxMTE4Mjc7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1mbG9hdC1jbG9zZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiA3cHg7IHBhZGRpbmc6IDRweCA4cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDogI2YxZjVmOTsgY29sb3I6ICM2NDc0OGI7IGN1cnNvcjogcG9pbnRlcjsgZm9udC1zaXplOiAxMnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1jLWZsb2F0LWNsb3NlOmhvdmVyIHsgYmFja2dyb3VuZDogI2ZlZTJlMjsgY29sb3I6ICNkYzI2MjY7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1mbG9hdC1ib2R5IHsgZmxleDogMSAxIGF1dG87IG92ZXJmbG93LXk6IGF1dG87IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1mbG9hdC1mb290ZXIgeyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtZW5kOyBtYXJnaW4tdG9wOiA4cHg7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1zY2hlZC1jaXR5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250LXNpemU6IDExcHg7IGZvbnQtd2VpZ2h0OiA3MDA7IGNvbG9yOiAjNGY0NmU1O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6ICNlZWYyZmY7IGJvcmRlcjogMXB4IHNvbGlkICNjN2QyZmU7IGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYWRkaW5nOiA0cHggOXB4OyBtYXJnaW4tdG9wOiA2cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtcm93IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250LXNpemU6IDExLjVweDsgcGFkZGluZzogNHB4IDlweDsgbWFyZ2luLXRvcDogNHB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7IGJvcmRlci1yYWRpdXM6IDdweDsgYmFja2dyb3VuZDogI2ZmZmZmZjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcjogIzFmMjkzNzsgd2hpdGUtc3BhY2U6IHByZS13cmFwOyB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvKiDilIDilIAg0J7QstC10YDQu9C10Lgg4pSA4pSAICovXG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcG9zaXRpb246IGZpeGVkOyBpbnNldDogMDsgei1pbmRleDogMTAwMDAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhZGRpbmc6IDIwcHg7IGJhY2tncm91bmQ6IHJnYmEoMiw2LDIzLC43Mik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheS1tb2RhbCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IG1pbig2MjBweCwgY2FsYygxMDB2dyAtIDQwcHgpKTsgbWF4LWhlaWdodDogODB2aDsgb3ZlcmZsb3c6IGF1dG87XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFkZGluZzogMTZweDsgYmFja2dyb3VuZDogI2ZmZmZmZjsgYm9yZGVyOiAxcHggc29saWQgI2RiZTNlZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXItcmFkaXVzOiAxNnB4OyBib3gtc2hhZG93OiAwIDE4cHggNjBweCByZ2JhKDAsMCwwLC42KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcjogIzFmMjkzNztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1vdmVybGF5LWhlYWRlciB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBtYXJnaW4tYm90dG9tOiAxMnB4O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnQtc2l6ZTogMTVweDsgY29sb3I6ICMxMTE4Mjc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheS1jbG9zZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyOiAwOyBib3JkZXItcmFkaXVzOiA3cHg7IHBhZGRpbmc6IDZweCA5cHg7IGJhY2tncm91bmQ6ICNmMWY1Zjk7IGNvbG9yOiAjNDc1NTY5OyBjdXJzb3I6IHBvaW50ZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheS1jbG9zZTpob3ZlciB7IGJhY2tncm91bmQ6ICNmZWUyZTI7IGNvbG9yOiAjZGMyNjI2OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheS1mb290ZXIgeyBkaXNwbGF5OiBmbGV4OyBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtZW5kOyBtYXJnaW4tdG9wOiAxMnB4OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWMtb3ZlcmxheS1lcnJvciB7IGNvbG9yOiAjOTkxYjFiOyBiYWNrZ3JvdW5kOiAjZmVlMmUyOyBib3JkZXI6IDFweCBzb2xpZCAjZmVjYWNhOyBib3JkZXItcmFkaXVzOiAxMHB4OyBwYWRkaW5nOiAxMHB4OyBmb250LXNpemU6IDEycHg7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1zY2hlZC1jaXR5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250LXNpemU6IDExcHg7IGZvbnQtd2VpZ2h0OiA3MDA7IGJhY2tncm91bmQ6ICNmOGZhZmM7IGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyLXJhZGl1czogOHB4IDhweCAwIDA7IHBhZGRpbmc6IDVweCAxMHB4OyBtYXJnaW4tdG9wOiA4cHg7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtdGFibGUgeyB3aWR0aDogMTAwJTsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTsgZm9udC1zaXplOiAxMS41cHg7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1zY2hlZC10YWJsZSB0aCwgLm1jLXNjaGVkLXRhYmxlIHRkIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0ZXh0LWFsaWduOiBsZWZ0OyBwYWRkaW5nOiA1cHggMTBweDsgYm9yZGVyOiAxcHggc29saWQgI2U1ZTdlYjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYy1zY2hlZC10YWJsZSB0aCB7IGJhY2tncm91bmQ6ICNmMWY1Zjk7IGNvbG9yOiAjNDc1NTY5OyBmb250LXNpemU6IDEwcHg7IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOiAuNXB4OyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAubWMtc2NoZWQtdGFibGUgdGJvZHkgdHI6bnRoLWNoaWxkKG9kZCkgeyBiYWNrZ3JvdW5kOiAjZmFmYmZmOyB9XG4gICAgICAgICAgICAgICAgICAgIGA7XG4gICAgICAgIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xuXG4gICAgICAgIGNvbnN0IGNvbnRhaW5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBjb250YWluZXIuaWQgPSAncHJpY2VDaGVja0NvbnRhaW5lcic7XG4gICAgICAgIGNvbnRhaW5lci5zdHlsZS5jc3NUZXh0ID0gYFxuICAgICAgICAgICAgcG9zaXRpb246Zml4ZWQ7IHRvcDoxNHB4OyByaWdodDoxNHB4OyB3aWR0aDo0MzBweDtcbiAgICAgICAgICAgIG1pbi1oZWlnaHQ6NTQwcHg7IG1heC1oZWlnaHQ6OTN2aDtcbiAgICAgICAgICAgIGJhY2tncm91bmQ6I2ZmZmZmZjtcbiAgICAgICAgICAgIGJvcmRlcjoxcHggc29saWQgI2RiZTNlZTtcbiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6MThweDtcbiAgICAgICAgICAgIGJveC1zaGFkb3c6MCAxNnB4IDQ2cHggcmdiYSgxNSwyMyw0MiwuMjIpLCAwIDAgMCAxcHggcmdiYSgyNTUsMjU1LDI1NSwuOSk7XG4gICAgICAgICAgICBwYWRkaW5nOjE0cHg7IGRpc3BsYXk6bm9uZTsgei1pbmRleDo5OTk5OTtcbiAgICAgICAgICAgIGJveC1zaXppbmc6Ym9yZGVyLWJveDsgZmxleC1kaXJlY3Rpb246Y29sdW1uOyBnYXA6MTBweDtcbiAgICAgICAgICAgIHJlc2l6ZTpib3RoOyBvdmVyZmxvdzphdXRvO1xuICAgICAgICBgO1xuXG4gICAgICAgIGNvbnRhaW5lci5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgICA8IS0tIOKUgOKUgCDQqNCw0L/QutCwIOKUgOKUgCAtLT5cbiAgICAgICAgICAgIDxkaXYgaWQ9XCJwcmljZUNoZWNrSGVhZGVyXCIgc3R5bGU9XCJcbiAgICAgICAgICAgICAgICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO1xuICAgICAgICAgICAgICAgIGN1cnNvcjptb3ZlO3VzZXItc2VsZWN0Om5vbmU7cGFkZGluZy1ib3R0b206MTFweDtcbiAgICAgICAgICAgICAgICBib3JkZXItYm90dG9tOjFweCBzb2xpZCAjZTJlOGYwO1xuICAgICAgICAgICAgXCI+XG4gICAgICAgICAgICAgICAgPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjlweDtcIj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBzdHlsZT1cIlxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6MzRweDtoZWlnaHQ6MzRweDtib3JkZXItcmFkaXVzOjlweDtmbGV4LXNocmluazowO1xuICAgICAgICAgICAgICAgICAgICAgICAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM2MzY2ZjEsI2E4NTVmNyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7XG4gICAgICAgICAgICAgICAgICAgICAgICBmb250LXNpemU6MTdweDtib3gtc2hhZG93OjAgM3B4IDEwcHggIzYzNjZmMTM4O1xuICAgICAgICAgICAgICAgICAgICBcIj7wn5CxPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgIDxkaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IHN0eWxlPVwiZm9udC1zaXplOjE0cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiMxMTE4Mjc7bGluZS1oZWlnaHQ6MS4yO1wiPtCc0LXQvNC90YvQuSDRh9Cw0YI8L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJtZW1jaGF0VGFiVGl0bGVcIiBzdHlsZT1cImZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjojNGY0NmU1O2xldHRlci1zcGFjaW5nOi4zcHg7bWFyZ2luLXRvcDoxcHg7XCI+8J+QtiBIYXRpa288L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJtZW1jaGF0VmVyc2lvblwiIHN0eWxlPVwiZm9udC1zaXplOjguNXB4O2NvbG9yOiM5NGEzYjg7bGV0dGVyLXNwYWNpbmc6LjVweDttYXJnaW4tdG9wOjFweDtcIj48L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJtZW1jaGF0QmVhcmVyU3RhdHVzXCIgc3R5bGU9XCJmb250LXNpemU6OC41cHg7Y29sb3I6Izk0YTNiODttYXJnaW4tdG9wOjFweDtcIj48L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cInByaWNlQ2hlY2tDbG9zZUJ1dHRvblwiIHN0eWxlPVwiXG4gICAgICAgICAgICAgICAgICAgIHdpZHRoOjI5cHg7aGVpZ2h0OjI5cHg7Ym9yZGVyLXJhZGl1czo4cHg7Ym9yZGVyOm5vbmU7XG4gICAgICAgICAgICAgICAgICAgIGJhY2tncm91bmQ6I2YxZjVmOTtjb2xvcjojNjQ3NDhiO2ZvbnQtc2l6ZToxM3B4O1xuICAgICAgICAgICAgICAgICAgICBjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOmFsbCAuMThzO1xuICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7ZmxleC1zaHJpbms6MDtcbiAgICAgICAgICAgICAgICBcIj7inJU8L2J1dHRvbj5cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8IS0tIOKUgOKUgCDQktC60LvQsNC00LrQuCAo0Y3QvNC+0LTQt9C4OyDQv9C+0LvQvdC+0LUg0L3QsNC30LLQsNC90LjQtSDigJQg0LIg0LfQsNCz0L7Qu9C+0LLQutC1KSDilIDilIAgLS0+XG4gICAgICAgICAgICA8ZGl2IGlkPVwibWNUYWJzXCIgcm9sZT1cInRhYmxpc3RcIj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJjaGVja0hhdGlrb1wiIGRhdGEtdGlwPVwi8J+QtiBIYXRpa28g4oCUINC/0L7QuNGB0Log0Lgg0YbQtdC90YtcIj7wn5C2PC9idXR0b24+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cIm1jLXRhYlwiIGRhdGEtdGFiPVwiY2hlY2tIYXRpa29Cb251c2VzXCIgZGF0YS10aXA9XCLwn46BINCR0L7QvdGD0YHRiyDigJQg0LHQvtC90YPRgdGLINC60LvQuNC10L3RgtCwXCI+8J+OgTwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJtYy10YWJcIiBkYXRhLXRhYj1cInRvZGF5XCIgZGF0YS10aXA9XCLwn5+iINCa0YLQviDRgNCw0LHQvtGC0LDQtdGCINGB0LXQs9C+0LTQvdGPXCI+8J+fojwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJtYy10YWJcIiBkYXRhLXRhYj1cInRvbW9ycm93XCIgZGF0YS10aXA9XCLwn5+hINCa0YLQviDRgNCw0LHQvtGC0LDQtdGCINC30LDQstGC0YDQsFwiPvCfn6E8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJjYWxjdWxhdG9yXCIgZGF0YS10aXA9XCLwn6euINCa0LDQu9GM0LrRg9C70Y/RgtC+0YAg4oCUINGA0LDRgdGH0ZHRgiDQutGA0LXQtNC40YLQsFwiPvCfp648L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJjYWxjdWxhdG9yX3JldmVyc2VcIiBkYXRhLXRpcD1cIvCflIQg0KDQtdCy0LXRgNGBIOKAlCDQvtCx0YDQsNGC0L3Ri9C5INGA0LDRgdGH0ZHRglwiPvCflIQ8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwibWMtdGFiXCIgZGF0YS10YWI9XCJjYWxjdWxhdG9yX2Rpc2NvdW50XCIgZGF0YS10aXA9XCLwn46JINCh0LrQuNC00LrQsCDigJQg0YHQutC40LTQutCwINC4INC90LDRhtC10L3QutCwXCI+8J+OiTwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJtYy10YWJcIiBkYXRhLXRhYj1cImNhbGN1bGF0b3Jfc2ltcGxlXCIgZGF0YS10aXA9XCLiiJEg0J/RgNC+0YHRgtC+0Lkg4oCUINC/0YDQvtGB0YLQvtC1INCy0YvRgNCw0LbQtdC90LjQtVwiPuKIkTwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJtYy10YWJcIiBkYXRhLXRhYj1cImhhY2tlclwiIGRhdGEtdGlwPVwi8J+QseKAjfCfkrsg0KXQsNGC0LjQutC+0KXQsNC60LXRgFwiIGhpZGRlbj7wn5Cx4oCN8J+SuzwvYnV0dG9uPlxuICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIDwhLS0g4pSA4pSAINCf0L7Qu9C1INCy0LLQvtC00LAg4pSA4pSAIC0tPlxuICAgICAgICAgICAgPGRpdiBpZD1cIm1jSW5wdXRSZWdpb25cIiBzdHlsZT1cInBvc2l0aW9uOnJlbGF0aXZlO1wiPlxuICAgICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwidGV4dFwiIGlkPVwicHJpY2VDaGVja0lucHV0XCIgcGxhY2Vob2xkZXI9XCLQkNGA0YLQuNC60YPQuywg0YLQvtCy0LDRgCDQuNC70Lgg0YHRg9C80LzQsOKAplwiPlxuICAgICAgICAgICAgICAgIDxzcGFuIHN0eWxlPVwiXG4gICAgICAgICAgICAgICAgICAgIHBvc2l0aW9uOmFic29sdXRlO3JpZ2h0OjExcHg7dG9wOjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNTAlKTtcbiAgICAgICAgICAgICAgICAgICAgZm9udC1zaXplOjkuNXB4O2NvbG9yOiMyODMzNDc7cG9pbnRlci1ldmVudHM6bm9uZTtcbiAgICAgICAgICAgICAgICBcIj5FbnRlciDihrU8L3NwYW4+XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgPCEtLSDilIDilIAg0JvQvtCzIC8g0YDQtdC30YPQu9GM0YLQsNGCIOKUgOKUgCAtLT5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJtY1Jlc3VsdFJlZ2lvblwiIHN0eWxlPVwiZmxleDoxIDEgYXV0bztkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo4cHg7bWluLWhlaWdodDo4MHB4O1wiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJtY0NoYXRMb2dcIiByb2xlPVwibG9nXCI+PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBpZD1cImhhdGlrb1JlcXVlc3RTdGF0dXNcIiByb2xlPVwic3RhdHVzXCIgYXJpYS1saXZlPVwicG9saXRlXCI+PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cImhhdGlrb1Jlb3BlblBpY2tlckJ1dHRvblwiIHR5cGU9XCJidXR0b25cIiBzdHlsZT1cImRpc3BsYXk6bm9uZTtwYWRkaW5nOjVweCA4cHg7Ym9yZGVyOjFweCBzb2xpZCAjNDc1NTY5O2JvcmRlci1yYWRpdXM6N3B4O2JhY2tncm91bmQ6I2ZmZjtjb2xvcjojNDc1NTY5O2N1cnNvcjpwb2ludGVyO1wiPuKGtiDQktGL0LHRgNCw0YLRjCDQtNGA0YPQs9C+0Lkg0YLQvtCy0LDRgDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJoYXRpa29MaW5rc1BhbmVsXCIgY2xhc3M9XCJtYy1saW5rcy1wYW5lbFwiPjwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIDxkaXYgaWQ9XCJtY1NwZWNpYWxQYW5lXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmU7ZmxleDoxIDEgYXV0bzttaW4taGVpZ2h0OjEyMHB4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6OHB4O292ZXJmbG93OmhpZGRlbjtcIj48L2Rpdj5cblxuICAgICAgICAgICAgPCEtLSDilIDilIAg0J3QuNC20L3Rj9GPINC/0LDQvdC10LvRjDog0YHRgtCw0YLRg9GBICsg0LTQtdC50YHRgtCy0LjRjyArINC90LDRgdGC0YDQvtC50LrQuCArINC+0YfQuNGB0YLQutCwIOKUgOKUgCAtLT5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgaWQ9XCJtY0JvdHRvbUJhclwiIHN0eWxlPVwiZmxleDowIDAgYXV0bztkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OmZsZXgtZW5kO2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO1wiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxzcGFuIGlkPVwibWNTdGF0dXNCYXJcIiBjbGFzcz1cIm1jLXN0YXR1cy1iYXJcIj7QndCw0LLQtdC00LjRgtC1INC90LAg0LrQvdC+0L/QutGD4oCmPC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJtY0NsZWFyVGV4dFRvZ2dsZVwiIGNsYXNzPVwibWMtYWN0aW9uLWJ0blwiIHR5cGU9XCJidXR0b25cIiBhcmlhLXByZXNzZWQ9XCJmYWxzZVwiIGRhdGEtdGlwPVwi8J+nuSDQntGH0LjRidCw0YLRjCDQsNC60YLQuNCy0L3QvtC1INC/0L7Qu9C1INC/0L7RgdC70LUgRW50ZXJcIj7wn6e5PC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cIm1jQWN0aW9uU2V0dGluZ3NcIiBjbGFzcz1cIm1jLWFjdGlvbi1idG5cIiB0eXBlPVwiYnV0dG9uXCIgZGF0YS10aXA9XCLimpnvuI8g0J3QsNGB0YLRgNC+0LnQutC4XCI+4pqZ77iPPC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cIm1jQ2xlYXJDaGF0QnV0dG9uXCIgY2xhc3M9XCJtYy1idG4tY2xlYXJcIiB0eXBlPVwiYnV0dG9uXCIgZGF0YS10aXA9XCLwn5eRINCe0YfQuNGB0YLQuNGC0Ywg0LjRgdGC0L7RgNC40Y4g0Y3RgtC+0Lkg0LLQutC70LDQtNC60LhcIj7wn5eRPC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgYDtcblxuICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGNvbnRhaW5lcik7XG4gICAgICAgIHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyID0gY29udGFpbmVyO1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdFZlcnNpb24nKS50ZXh0Q29udGVudCA9IGB2JHtNRU1DSEFUX1ZFUlNJT059JHt0eXBlb2YgTUVNQ0hBVF9CVUlMRCAhPT0gJ3VuZGVmaW5lZCcgPyBgLSR7TUVNQ0hBVF9CVUlMRH1gIDogJyd9YDtcbiAgICAgICAgaGFja2VyVmFsaWRhdGVBcGlLZXkoKCkgPT4gaGFja2VyU3luY0FjY2Vzc1VpKCkpO1xuICAgICAgICBzZXR1cEV2ZW50TGlzdGVuZXJzKCk7XG4gICAgICAgIHVwZGF0ZUNsZWFyVGV4dEJ1dHRvbigpO1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGF0aWtvUmVvcGVuUGlja2VyQnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZW9wZW5IYXRpa29Qcm9kdWN0UGlja2VyKTtcbiAgICB9XG5cbiAgICB3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lci5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS5mb2N1cygpO1xuICAgIHJlc3RvcmVTZWxlY3RlZEFjdGlvbigpO1xuICAgIG1lbWNoYXRQbGF0Zm9ybS5vbk1haW5DcmVhdGVkPy4oKTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlSGF0aWtvU3RhdHVzKG1lc3NhZ2UpIHtcbiAgICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGF0aWtvUmVxdWVzdFN0YXR1cycpO1xuICAgIGlmIChzdGF0dXMpIHtcbiAgICAgICAgc3RhdHVzLnRleHRDb250ZW50ID0gYPCfkLYgJHttZXNzYWdlfWA7XG4gICAgICAgIGNvbnN0IGxvd2VyID0gU3RyaW5nKG1lc3NhZ2UpLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgIHN0YXR1cy5kYXRhc2V0LnN0YXRlID0gL9C+0YjQuNCx0LrQsHzQvdC1INC90LDQudC00LXQvXzQvdC10LTQvtGB0YLRg9C/Ly50ZXN0KGxvd2VyKSA/ICdlcnJvcidcbiAgICAgICAgICAgIDogL2ZhbGxiYWNrfNC/0LXRgNC10LrQu9GO0YfQsNGO0YHRjHzQvdC1INCw0LLRgtC+0YDQuNC3Ly50ZXN0KGxvd2VyKSA/ICd3YXJuJ1xuICAgICAgICAgICAgOiAv0LPQvtGC0L7QstC+Ly50ZXN0KGxvd2VyKSA/ICdvaycgOiAnYnVzeSc7XG4gICAgfVxuICAgIGRlYnVnTG9nKCdoYXRpa28tc3RhdHVzJywgbWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHNldHVwSGF0aWtvU2VhcmNoTW9kZVNldHRpbmcoKSB7XG4gICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhdGlrb1NlYXJjaE1vZGUnKTtcbiAgICBpZiAoIXNlbGVjdCkgcmV0dXJuO1xuICAgIGhhdGlrb1NlYXJjaE1vZGUgPSBsb2FkSGF0aWtvU2VhcmNoTW9kZSgpO1xuICAgIHNlbGVjdC52YWx1ZSA9IGhhdGlrb1NlYXJjaE1vZGU7XG4gICAgc2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHNhdmVIYXRpa29TZWFyY2hNb2RlKHNlbGVjdC52YWx1ZSkpO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVIYXRpa29MaW5rc1BhbmVsKHBhdGhuYW1lKSB7XG4gICAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGF0aWtvTGlua3NQYW5lbCcpO1xuICAgIGlmICghcGFuZWwpIHJldHVybjtcbiAgICBwYW5lbC5pbm5lckhUTUwgPSAnJztcbiAgICBpZiAoIWxvYWRTaG93SGF0aWtvTGlua3MoKSB8fCAhcGF0aG5hbWUpIHtcbiAgICAgICAgcGFuZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBCQVNFX1VSTFMuZm9yRWFjaCgoYmFzZVVybCwgaSkgPT4ge1xuICAgICAgICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpO1xuICAgICAgICBsaW5rLmhyZWYgPSBgJHtiYXNlVXJsfSR7cGF0aG5hbWV9YDtcbiAgICAgICAgbGluay50YXJnZXQgPSAnX2JsYW5rJztcbiAgICAgICAgbGluay5yZWwgPSAnbm9vcGVuZXIgbm9yZWZlcnJlcic7XG4gICAgICAgIGxpbmsudGV4dENvbnRlbnQgPSBg8J+MkCR7Q0lUWV9JQ09OU1tpXX0gJHtDSVRZX05BTUVTW2ldfTogJHtsaW5rLmhyZWZ9YDtcbiAgICAgICAgcGFuZWwuYXBwZW5kQ2hpbGQobGluayk7XG4gICAgfSk7XG4gICAgcGFuZWwuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG59XG5cbmZ1bmN0aW9uIHNldHVwSGF0aWtvTGlua3NTZXR0aW5nKCkge1xuICAgIGNvbnN0IGNoZWNrYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nob3dIYXRpa29MaW5rc0NoZWNrYm94Jyk7XG4gICAgaWYgKCFjaGVja2JveCkgcmV0dXJuO1xuICAgIGNoZWNrYm94LmNoZWNrZWQgPSBsb2FkU2hvd0hhdGlrb0xpbmtzKCk7XG4gICAgY2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICBzYXZlU2hvd0hhdGlrb0xpbmtzKGNoZWNrYm94LmNoZWNrZWQpO1xuICAgICAgICB1cGRhdGVIYXRpa29MaW5rc1BhbmVsKGN1cnJlbnRIYXRpa29QYXRobmFtZSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGNsb3NlSGF0aWtvUHJvZHVjdFBpY2tlcigpIHtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGF0aWtvUHJvZHVjdFBpY2tlcicpPy5yZW1vdmUoKTtcbn1cblxuZnVuY3Rpb24gcmVvcGVuSGF0aWtvUHJvZHVjdFBpY2tlcigpIHtcbiAgICBpZiAobGFzdEhhdGlrb1Jlc3VsdHMubGVuZ3RoID4gMSkgb3BlbkhhdGlrb1Byb2R1Y3RQaWNrZXIobGFzdEhhdGlrb1Jlc3VsdHMsIGxhc3RIYXRpa29RdWVyeSk7XG59XG5cbmZ1bmN0aW9uIGNvcHlIYXRpa29UZXh0KHRleHQpIHtcbiAgICBjb25zdCBmYWxsYmFjayA9ICgpID0+IHtcbiAgICAgICAgY29uc3QgdGV4dGFyZWEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0ZXh0YXJlYScpO1xuICAgICAgICB0ZXh0YXJlYS52YWx1ZSA9IHRleHQ7XG4gICAgICAgIHRleHRhcmVhLnN0eWxlLnBvc2l0aW9uID0gJ2ZpeGVkJztcbiAgICAgICAgdGV4dGFyZWEuc3R5bGUub3BhY2l0eSA9ICcwJztcbiAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh0ZXh0YXJlYSk7XG4gICAgICAgIHRleHRhcmVhLnNlbGVjdCgpO1xuICAgICAgICBkb2N1bWVudC5leGVjQ29tbWFuZCgnY29weScpO1xuICAgICAgICB0ZXh0YXJlYS5yZW1vdmUoKTtcbiAgICB9O1xuXG4gICAgaWYgKG5hdmlnYXRvci5jbGlwYm9hcmQ/LndyaXRlVGV4dCkge1xuICAgICAgICBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh0ZXh0KS5jYXRjaChmYWxsYmFjayk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgZmFsbGJhY2soKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodmFsdWUpIHtcbiAgICByZXR1cm4gU3RyaW5nKHZhbHVlKS5yZXBsYWNlKC9bJjw+J1xcXCJdL2csIGNoYXIgPT4gKHtcbiAgICAgICAgJyYnOiAnJmFtcDsnLCAnPCc6ICcmbHQ7JywgJz4nOiAnJmd0OycsIFwiJ1wiOiAnJiMzOTsnLCAnXFxcIic6ICcmcXVvdDsnXG4gICAgfVtjaGFyXSkpO1xufVxuXG5mdW5jdGlvbiBvcGVuSGF0aWtvUHJvZHVjdFBpY2tlcihyZXN1bHRzLCBxdWVyeSkge1xuICAgIGNsb3NlSGF0aWtvUHJvZHVjdFBpY2tlcigpO1xuXG4gICAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIG92ZXJsYXkuaWQgPSAnaGF0aWtvUHJvZHVjdFBpY2tlcic7XG4gICAgb3ZlcmxheS5zdHlsZS5jc3NUZXh0ID0gYFxuICAgICAgICBwb3NpdGlvbjpmaXhlZDtpbnNldDowO3otaW5kZXg6MTAwMDAwO1xuICAgICAgICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7XG4gICAgICAgIHBhZGRpbmc6MjBweDtiYWNrZ3JvdW5kOnJnYmEoMiw2LDIzLC43Mik7XG4gICAgYDtcblxuICAgIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbW9kYWwuc3R5bGUuY3NzVGV4dCA9IGBcbiAgICAgICAgd2lkdGg6bWluKDcyMHB4LCBjYWxjKDEwMHZ3IC0gNDBweCkpO21heC1oZWlnaHQ6ODB2aDtvdmVyZmxvdzphdXRvO1xuICAgICAgICBwYWRkaW5nOjE2cHg7YmFja2dyb3VuZDojMTExODI3O2JvcmRlcjoxcHggc29saWQgIzMzNDE1NTtcbiAgICAgICAgYm9yZGVyLXJhZGl1czoxNnB4O2JveC1zaGFkb3c6MCAxOHB4IDYwcHggcmdiYSgwLDAsMCwuNik7XG4gICAgICAgIGNvbG9yOiNlMmU4ZjA7Zm9udC1mYW1pbHk6J1NlZ29lIFVJJyxzeXN0ZW0tdWksc2Fucy1zZXJpZjtcbiAgICBgO1xuXG4gICAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaGVhZGVyLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjttYXJnaW4tYm90dG9tOjEycHg7JztcbiAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0cm9uZycpO1xuICAgIHRpdGxlLnRleHRDb250ZW50ID0gJ/CfkLYg0JLRi9Cx0LXRgNC40YLQtSDRgtC+0LLQsNGAINC00LvRjyDQutC+0L/QuNGA0L7QstCw0L3QuNGPJztcbiAgICB0aXRsZS5zdHlsZS5mb250U2l6ZSA9ICcxNXB4JztcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGUpO1xuXG4gICAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBjbG9zZS50ZXh0Q29udGVudCA9ICfinJUnO1xuICAgIGNsb3NlLnN0eWxlLmNzc1RleHQgPSAnYm9yZGVyOjA7Ym9yZGVyLXJhZGl1czo3cHg7cGFkZGluZzo2cHggOXB4O2JhY2tncm91bmQ6IzMzNDE1NTtjb2xvcjojZTJlOGYwO2N1cnNvcjpwb2ludGVyOyc7XG4gICAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBjbG9zZUhhdGlrb1Byb2R1Y3RQaWNrZXIpO1xuICAgIGhlYWRlci5hcHBlbmRDaGlsZChjbG9zZSk7XG4gICAgbW9kYWwuYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBncmlkLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgxODBweCwxZnIpKTtnYXA6MTBweDsnO1xuXG4gICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgY2FyZC50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIGNhcmQuc3R5bGUuY3NzVGV4dCA9IGBcbiAgICAgICAgICAgIG1pbi1oZWlnaHQ6MTMwcHg7cGFkZGluZzoxMnB4O3RleHQtYWxpZ246bGVmdDtjdXJzb3I6cG9pbnRlcjtcbiAgICAgICAgICAgIGJvcmRlcjoxcHggc29saWQgIzMzNDE1NTtib3JkZXItcmFkaXVzOjEycHg7YmFja2dyb3VuZDojMWUyOTNiO2NvbG9yOiNlMmU4ZjA7XG4gICAgICAgICAgICB0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMTVzLGJvcmRlci1jb2xvciAuMTVzLGJhY2tncm91bmQgLjE1cztcbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgY2FyZFRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XG4gICAgICAgIGNhcmRUaXRsZS50ZXh0Q29udGVudCA9IHJlc3VsdC50aXRsZTtcbiAgICAgICAgY2FyZFRpdGxlLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpibG9jazttYXJnaW4tYm90dG9tOjhweDsnO1xuICAgICAgICBjYXJkLmFwcGVuZENoaWxkKGNhcmRUaXRsZSk7XG4gICAgICAgIGNvbnN0IHByaWNlcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcbiAgICAgICAgcHJpY2VzLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpibG9jaztjb2xvcjojYTViNGZjO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTt3aGl0ZS1zcGFjZTpwcmUtbGluZTsnO1xuICAgICAgICBwcmljZXMudGV4dENvbnRlbnQgPSByZXN1bHQucHJpY2VzLm1hcCgocHJpY2UsIGkpID0+IGAke0NJVFlfTkFNRVNbaV19OiAke3ByaWNlfWApLmpvaW4oJ1xcbicpO1xuICAgICAgICBjYXJkLmFwcGVuZENoaWxkKHByaWNlcyk7XG4gICAgICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHsgY2FyZC5zdHlsZS5ib3JkZXJDb2xvciA9ICcjODE4Y2Y4JzsgY2FyZC5zdHlsZS50cmFuc2Zvcm0gPSAndHJhbnNsYXRlWSgtMnB4KSc7IH0pO1xuICAgICAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbGVhdmUnLCAoKSA9PiB7IGNhcmQuc3R5bGUuYm9yZGVyQ29sb3IgPSAnIzMzNDE1NSc7IGNhcmQuc3R5bGUudHJhbnNmb3JtID0gJ25vbmUnOyB9KTtcbiAgICAgICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgIGNvcHlIYXRpa29UZXh0KHJlc3VsdC5tZXNzYWdlKTtcbiAgICAgICAgICAgIGFkZFRvQ2hhdEhpc3RvcnkoJ2JvdCcsIHJlc3VsdC5tZXNzYWdlLCAn8J+QtiBIYXRpa28nLCBxdWVyeSk7XG4gICAgICAgICAgICBhZGRUb0NoYXRIaXN0b3J5KCdzeXN0ZW0nLCAn0J7RgtCy0LXRgiDQstGL0LHRgNCw0L3QvdC+0LPQviDRgtC+0LLQsNGA0LAg0YHQutC+0L/QuNGA0L7QstCw0L0nLCAn8J+TiycpO1xuICAgICAgICAgICAgY2xvc2VIYXRpa29Qcm9kdWN0UGlja2VyKCk7XG4gICAgICAgICAgICBjb25zdCByZW9wZW5CdXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGF0aWtvUmVvcGVuUGlja2VyQnV0dG9uJyk7XG4gICAgICAgICAgICBpZiAocmVvcGVuQnV0dG9uKSByZW9wZW5CdXR0b24uc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCB3cmFwcGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHdyYXBwZXIuc3R5bGUuY3NzVGV4dCA9ICdtaW4td2lkdGg6MDsnO1xuICAgICAgICB3cmFwcGVyLmFwcGVuZENoaWxkKGNhcmQpO1xuXG4gICAgICAgIGNvbnN0IGxpbmtzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxpbmtzLnN0eWxlLmNzc1RleHQgPSAnbWFyZ2luLXRvcDo1cHg7Zm9udC1zaXplOjEwcHg7bGluZS1oZWlnaHQ6MS41Oyc7XG4gICAgICAgIEJBU0VfVVJMUy5mb3JFYWNoKChiYXNlVXJsLCBpKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpO1xuICAgICAgICAgICAgbGluay5ocmVmID0gYCR7YmFzZVVybH0ke3Jlc3VsdC5wYXRobmFtZX1gO1xuICAgICAgICAgICAgbGluay50YXJnZXQgPSAnX2JsYW5rJztcbiAgICAgICAgICAgIGxpbmsucmVsID0gJ25vb3BlbmVyIG5vcmVmZXJyZXInO1xuICAgICAgICAgICAgbGluay50ZXh0Q29udGVudCA9IGAke0NJVFlfSUNPTlNbaV19ICR7Q0lUWV9OQU1FU1tpXX1gO1xuICAgICAgICAgICAgbGluay5zdHlsZS5jc3NUZXh0ID0gJ2NvbG9yOiM5M2M1ZmQ7bWFyZ2luLXJpZ2h0OjdweDsnO1xuICAgICAgICAgICAgbGlua3MuYXBwZW5kQ2hpbGQobGluayk7XG4gICAgICAgIH0pO1xuICAgICAgICB3cmFwcGVyLmFwcGVuZENoaWxkKGxpbmtzKTtcbiAgICAgICAgZ3JpZC5hcHBlbmRDaGlsZCh3cmFwcGVyKTtcbiAgICB9KTtcblxuICAgIG1vZGFsLmFwcGVuZENoaWxkKGdyaWQpO1xuICAgIG92ZXJsYXkuYXBwZW5kQ2hpbGQobW9kYWwpO1xuICAgIG92ZXJsYXkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBldmVudCA9PiB7XG4gICAgICAgIGlmIChldmVudC50YXJnZXQgPT09IG92ZXJsYXkpIGNsb3NlSGF0aWtvUHJvZHVjdFBpY2tlcigpO1xuICAgIH0pO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQodGC0LDRgtGD0YEt0LHQsNGAICjQv9C+0LTRgdC60LDQt9C60Lgg0L/RgNC4INC90LDQstC10LTQtdC90LjQuCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBzZXRTdGF0dXNUZXh0KG1lc3NhZ2UpIHtcbiAgICBjb25zdCBiYXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNTdGF0dXNCYXInKTtcbiAgICBpZiAoYmFyKSBiYXIudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xufVxuXG4vLyDilIDilIDilIAg0K3QutGB0L/QvtGA0YIgLyDQuNC80L/QvtGA0YIg0L3QsNGB0YLRgNC+0LXQuiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGJ1aWxkU2V0dGluZ3NTbmFwc2hvdCgpIHtcbiAgICByZXR1cm4ge1xuICAgICAgICBjYWxjUnVsZXMsXG4gICAgICAgIHNjaGVkdWxlUmVwbGFjZW1lbnRzLFxuICAgICAgICBzY2hlZHVsZUNhY2hlRW5hYmxlZCxcbiAgICAgICAgY2xlYXJUZXh0RW5hYmxlZCxcbiAgICAgICAgY2xlYXJUaW1lb3V0OiBwYXJzZUludChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGltZW91dFNsaWRlcicpPy52YWx1ZSB8fCA1MDAsIDEwKSxcbiAgICAgICAgc2hvd0hhdGlrb0xpbmtzOiBsb2FkU2hvd0hhdGlrb0xpbmtzKCksXG4gICAgICAgIGhhdGlrb1NlYXJjaE1vZGUsXG4gICAgICAgIHJldHJ5QmVoYXZpb3IsXG4gICAgICAgIG1zUXVpY2tQYW5lbEVuYWJsZWQsXG4gICAgICAgIG1zTWFnaWNDb25maWcsXG4gICAgICAgIGhhY2tlck9yZGVyTm90aWZpZXI6IGhhY2tlck5vdGlmaWVyU2V0dGluZ3MsXG4gICAgICAgIGludGVybmFsT3JkZXJDaGVjazogaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3NcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBleHBvcnRTZXR0aW5ncygpIHtcbiAgICBjb3B5SGF0aWtvVGV4dChKU09OLnN0cmluZ2lmeShidWlsZFNldHRpbmdzU25hcHNob3QoKSwgbnVsbCwgMikpO1xuICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdleHBvcnRTZXR0aW5nc0J0bicpO1xuICAgIGlmIChidG4pIHtcbiAgICAgICAgY29uc3QgcHJldiA9IGJ0bi50ZXh0Q29udGVudDtcbiAgICAgICAgYnRuLnRleHRDb250ZW50ID0gJ+KchSDQodC60L7Qv9C40YDQvtCy0LDQvdC+JztcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7IGJ0bi50ZXh0Q29udGVudCA9IHByZXY7IH0sIDEyMDApO1xuICAgIH1cbiAgICBzZXRTdGF0dXNUZXh0KCfinIUg0J3QsNGB0YLRgNC+0LnQutC4INGB0LrQvtC/0LjRgNC+0LLQsNC90Ysg0LIg0LHRg9GE0LXRgCcpO1xufVxuXG5mdW5jdGlvbiBpbXBvcnRTZXR0aW5ncyhqc29uVGV4dCkge1xuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7XG4gICAgICAgIGRhdGEgPSBKU09OLnBhcnNlKGpzb25UZXh0KTtcbiAgICAgICAgaWYgKCFkYXRhIHx8IHR5cGVvZiBkYXRhICE9PSAnb2JqZWN0JykgdGhyb3cgbmV3IEVycm9yKCdlbXB0eScpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc3QgYXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0ltcG9ydEFyZWEnKTtcbiAgICAgICAgaWYgKGFyZWEpIHsgYXJlYS5zdHlsZS5ib3JkZXJDb2xvciA9ICcjZWY0NDQ0JzsgYXJlYS5zdHlsZS5ib3JkZXJXaWR0aCA9ICcycHgnOyB9XG4gICAgICAgIHNldFN0YXR1c1RleHQoJ+KaoO+4jyDQndC10LrQvtGA0YDQtdC60YLQvdGL0LkgSlNPTiDQvdCw0YHRgtGA0L7QtdC6Jyk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhLmNhbGNSdWxlcykgJiYgZGF0YS5jYWxjUnVsZXMuZXZlcnkociA9PiByICYmIHR5cGVvZiByLm5hbWUgPT09ICdzdHJpbmcnKSkge1xuICAgICAgICBjYWxjUnVsZXMgPSBkYXRhLmNhbGNSdWxlcztcbiAgICAgICAgc2F2ZUNhbGNSdWxlcygpO1xuICAgICAgICBidWlsZENhbGNSdWxlc1BhbmVsKCk7XG4gICAgfVxuICAgIGlmIChkYXRhLnNjaGVkdWxlUmVwbGFjZW1lbnRzICYmIHR5cGVvZiBkYXRhLnNjaGVkdWxlUmVwbGFjZW1lbnRzID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShkYXRhLnNjaGVkdWxlUmVwbGFjZW1lbnRzKSkge1xuICAgICAgICBzY2hlZHVsZVJlcGxhY2VtZW50cyA9IGRhdGEuc2NoZWR1bGVSZXBsYWNlbWVudHM7XG4gICAgICAgIHNhdmVTY2hlZHVsZVJlcGxhY2VtZW50cygpO1xuICAgICAgICBidWlsZFNjaGVkdWxlUGFuZWwoKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBkYXRhLnNjaGVkdWxlQ2FjaGVFbmFibGVkID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgc2F2ZVNjaGVkdWxlQ2FjaGVFbmFibGVkKGRhdGEuc2NoZWR1bGVDYWNoZUVuYWJsZWQpO1xuICAgICAgICBjb25zdCBjYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY2hlZHVsZUNhY2hlQ2hlY2tib3gnKTtcbiAgICAgICAgaWYgKGNiKSBjYi5jaGVja2VkID0gc2NoZWR1bGVDYWNoZUVuYWJsZWQ7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZGF0YS5jbGVhclRleHRFbmFibGVkID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgY2xlYXJUZXh0RW5hYmxlZCA9IGRhdGEuY2xlYXJUZXh0RW5hYmxlZDtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnY2xlYXJUZXh0RW5hYmxlZCcpLCBTdHJpbmcoY2xlYXJUZXh0RW5hYmxlZCkpO1xuICAgICAgICBjb25zdCBjYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbGVhclRleHRDaGVja2JveCcpO1xuICAgICAgICBpZiAoY2IpIGNiLmNoZWNrZWQgPSBjbGVhclRleHRFbmFibGVkO1xuICAgICAgICB1cGRhdGVDbGVhclRleHRCdXR0b24oKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBkYXRhLmNsZWFyVGltZW91dCA9PT0gJ251bWJlcicgJiYgZGF0YS5jbGVhclRpbWVvdXQgPj0gMSAmJiBkYXRhLmNsZWFyVGltZW91dCA8PSAyMDAwKSB7XG4gICAgICAgIGNvbnN0IHNsaWRlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0aW1lb3V0U2xpZGVyJyk7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRWYWx1ZScpO1xuICAgICAgICBpZiAoc2xpZGVyKSBzbGlkZXIudmFsdWUgPSBkYXRhLmNsZWFyVGltZW91dDtcbiAgICAgICAgaWYgKGxhYmVsKSBsYWJlbC50ZXh0Q29udGVudCA9IGRhdGEuY2xlYXJUaW1lb3V0O1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGRhdGEuc2hvd0hhdGlrb0xpbmtzID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgc2F2ZVNob3dIYXRpa29MaW5rcyhkYXRhLnNob3dIYXRpa29MaW5rcyk7XG4gICAgICAgIGNvbnN0IGNiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Nob3dIYXRpa29MaW5rc0NoZWNrYm94Jyk7XG4gICAgICAgIGlmIChjYikgY2IuY2hlY2tlZCA9IGRhdGEuc2hvd0hhdGlrb0xpbmtzO1xuICAgICAgICB1cGRhdGVIYXRpa29MaW5rc1BhbmVsKGN1cnJlbnRIYXRpa29QYXRobmFtZSk7XG4gICAgfVxuICAgIGlmIChbJ2F1dG8nLCAncGFuZWwnLCAnaGF0aWtvJ10uaW5jbHVkZXMoZGF0YS5oYXRpa29TZWFyY2hNb2RlKSkge1xuICAgICAgICBzYXZlSGF0aWtvU2VhcmNoTW9kZShkYXRhLmhhdGlrb1NlYXJjaE1vZGUpO1xuICAgICAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGF0aWtvU2VhcmNoTW9kZScpO1xuICAgICAgICBpZiAoc2VsKSBzZWwudmFsdWUgPSBkYXRhLmhhdGlrb1NlYXJjaE1vZGU7XG4gICAgfVxuICAgIGlmIChbJ2FwcGVuZCcsICdyZXBsYWNlJ10uaW5jbHVkZXMoZGF0YS5yZXRyeUJlaGF2aW9yKSkge1xuICAgICAgICBzYXZlUmV0cnlCZWhhdmlvcihkYXRhLnJldHJ5QmVoYXZpb3IpO1xuICAgICAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmV0cnlCZWhhdmlvcicpO1xuICAgICAgICBpZiAoc2VsKSBzZWwudmFsdWUgPSBkYXRhLnJldHJ5QmVoYXZpb3I7XG4gICAgfVxuICAgIGlmIChBcnJheS5pc0FycmF5KGRhdGEuaGlkZGVuRmllbGRzKSkge1xuICAgICAgICAvLyDQodGC0LDRgNGL0LUg0L3QsNGB0YLRgNC+0LnQutC4INCy0YvQsdC+0YDQvtGH0L3QvtCz0L4g0YHQutGA0YvRgtC40Y8g0LHQvtC70YzRiNC1INC90LUg0L/RgNC40LzQtdC90Y/RjtGC0YHRjzog0YLQtdC/0LXRgNGMXG4gICAgICAgIC8vINC00L7Qv9C+0LvQvdC40YLQtdC70YzQvdGL0LUg0L/QvtC70Y8g0L7RgtC60YDRi9Cy0LDRjtGC0YHRjyDQtdC00LjQvdGL0Lwg0YHQv9C+0LnQu9C10YDQvtC8INGI0YLQsNGC0L3QvtCz0L4g0LHQu9C+0LrQsC5cbiAgICAgICAgaGlkZGVuRmllbGRzID0gW107XG4gICAgICAgIHNhdmVIaWRkZW5GaWVsZHMoKTtcbiAgICAgICAgcmVzdG9yZU1zRmllbGRzKCk7XG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY01zUmV2ZWFsQnRuJyk/LnJlbW92ZSgpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGRhdGEubXNRdWlja1BhbmVsRW5hYmxlZCA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIG1zUXVpY2tQYW5lbEVuYWJsZWQgPSBkYXRhLm1zUXVpY2tQYW5lbEVuYWJsZWQ7XG4gICAgICAgIHNhdmVNc1F1aWNrUGFuZWxFbmFibGVkKCk7XG4gICAgICAgIGNvbnN0IGNiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zUXVpY2tQYW5lbENoZWNrYm94Jyk7XG4gICAgICAgIGlmIChjYikgY2IuY2hlY2tlZCA9IG1zUXVpY2tQYW5lbEVuYWJsZWQ7XG4gICAgICAgIGJ1aWxkTXNRdWlja1BhbmVsKCk7XG4gICAgfVxuICAgIGlmIChkYXRhLm1zTWFnaWNDb25maWcgJiYgdHlwZW9mIGRhdGEubXNNYWdpY0NvbmZpZyA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHNhdmVNc01hZ2ljQ29uZmlnKGRhdGEubXNNYWdpY0NvbmZpZyk7XG4gICAgICAgICAgICBjb25zdCBtYWdpY0FyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNNYWdpY0NvbmZpZ0pzb24nKTtcbiAgICAgICAgICAgIGlmIChtYWdpY0FyZWEpIG1hZ2ljQXJlYS52YWx1ZSA9IEpTT04uc3RyaW5naWZ5KG1zTWFnaWNDb25maWcsIG51bGwsIDIpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgc2V0U3RhdHVzVGV4dChg4pqg77iPIEpTT04g8J+qhDogJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChkYXRhLmhhY2tlck9yZGVyTm90aWZpZXIgJiYgdHlwZW9mIGRhdGEuaGFja2VyT3JkZXJOb3RpZmllciA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTZXR0aW5ncyA9IGhhY2tlck5vdGlmaWVyTm9ybWFsaXplU2V0dGluZ3MoZGF0YS5oYWNrZXJPcmRlck5vdGlmaWVyKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTdGF0dXNTZWxlY3Rpb25Jbml0aWFsaXplZCA9IHRydWU7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyRmlsbENvbnRyb2xzKCk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyTWF5YmVTdGFydCgpO1xuICAgIH1cbiAgICBpZiAoZGF0YS5pbnRlcm5hbE9yZGVyQ2hlY2sgJiYgdHlwZW9mIGRhdGEuaW50ZXJuYWxPcmRlckNoZWNrID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncyA9IGludGVybmFsT3JkZXJDaGVja05vcm1hbGl6ZVNldHRpbmdzKGRhdGEuaW50ZXJuYWxPcmRlckNoZWNrKTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxPcmdhbml6YXRpb25zKCk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxXYXJlaG91c2VzKCk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxTdGF0dXNlcygnY3VzdG9tZXJvcmRlcicpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsU3RhdHVzZXMoJ2ludGVybmFsb3JkZXInKTtcbiAgICB9XG5cbiAgICBjb25zdCBhcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QXJlYScpO1xuICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNJbXBvcnRBY3Rpb25zJyk7XG4gICAgaWYgKGFyZWEpIHsgYXJlYS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOyBhcmVhLnZhbHVlID0gJyc7IGFyZWEuc3R5bGUuYm9yZGVyQ29sb3IgPSAnI2NiZDVlMSc7IGFyZWEuc3R5bGUuYm9yZGVyV2lkdGggPSAnMXB4JzsgfVxuICAgIGlmIChhY3Rpb25zKSBhY3Rpb25zLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgc2V0U3RhdHVzVGV4dCgn4pyFINCd0LDRgdGC0YDQvtC50LrQuCDQuNC80L/QvtGA0YLQuNGA0L7QstCw0L3RiycpO1xuICAgIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJIYWNrZXJJbmxpbmVUYWIoKSB7XG4gICAgY29uc3QgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1NwZWNpYWxQYW5lJyk7XG4gICAgaWYgKCFob3N0IHx8IGN1cnJlbnRBY3Rpb24gIT09ICdoYWNrZXInKSByZXR1cm47XG4gICAgaG9zdC5yZXBsYWNlQ2hpbGRyZW4oKTtcblxuICAgIGNvbnN0IHRhYnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB0YWJzLmlkID0gJ2hhY2tlclRhYnMnO1xuICAgIHRhYnMuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjRweDtmbGV4OjAgMCBhdXRvOyc7XG4gICAgW1snc3RhdHVzJywgJ9Ch0YLQsNGC0YPRgSddLCBbJ2FnZW50JywgJ9Ca0L7QvdGC0YDQsNCz0LXQvdGCJ10sIFsnbm90aWZpZXInLCAn0J3QvtCy0YvQtSDQt9Cw0LrQsNC30YsnXSwgWydpbnRlcm5hbE9yZGVyQ2hlY2snLCAn0J/RgNC+0LLQtdGA0LrQsCDQt9Cw0LrQsNC30L7QsiddXS5mb3JFYWNoKChba2V5LCBsYWJlbF0pID0+IHtcbiAgICAgICAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGJ0bi50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBidG4uZGF0YXNldC5oYWNrZXJUYWIgPSBrZXk7XG4gICAgICAgIGJ0bi5zdHlsZS5jc3NUZXh0ID0gJ2ZsZXg6MTtwYWRkaW5nOjVweCA0cHg7Ym9yZGVyOjFweCBzb2xpZCAjZTJlOGYwO2JvcmRlci1yYWRpdXM6OHB4OydcbiAgICAgICAgICAgICsgJ2JhY2tncm91bmQ6I2Y4ZmFmYztjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjt3aGl0ZS1zcGFjZTpub3dyYXA7JztcbiAgICAgICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gaGFja2VyU2VsZWN0VGFiKGtleSkpO1xuICAgICAgICB0YWJzLmFwcGVuZENoaWxkKGJ0bik7XG4gICAgfSk7XG4gICAgaG9zdC5hcHBlbmRDaGlsZCh0YWJzKTtcblxuICAgIGNvbnN0IHBhbmVzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgcGFuZXMuaWQgPSAnaGFja2VyVGFiUGFuZXMnO1xuICAgIHBhbmVzLnN0eWxlLmNzc1RleHQgPSAnZmxleDowIDAgYXV0bzsnO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQocGFuZXMpO1xuXG4gICAgY29uc3QgbG9nTGFiZWwgPSBoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjojNjQ3NDhiO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsnXG4gICAgICAgICsgJ2xldHRlci1zcGFjaW5nOi44cHg7bWFyZ2luLXRvcDo0cHg7JywgJ9Ca0L7QvdGB0L7Qu9GMJyk7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChsb2dMYWJlbCk7XG4gICAgY29uc3QgbG9nQm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbG9nQm94LmlkID0gJ2hhY2tlckxvZ0JveCc7XG4gICAgbG9nQm94LnN0eWxlLmNzc1RleHQgPSAnZmxleDoxIDEgYXV0bzttaW4taGVpZ2h0OjkwcHg7b3ZlcmZsb3cteTphdXRvO2JhY2tncm91bmQ6IzBmMTcyYTtib3JkZXItcmFkaXVzOjEwcHg7J1xuICAgICAgICArICdwYWRkaW5nOjdweDtmb250LXNpemU6MTAuNXB4O2xpbmUtaGVpZ2h0OjEuNTtmb250LWZhbWlseTpDb25zb2xhcyxtb25vc3BhY2U7JztcbiAgICBob3N0LmFwcGVuZENoaWxkKGxvZ0JveCk7XG5cbiAgICBoYWNrZXJTZWxlY3RUYWIoaGFja2VyVGFiKTtcbiAgICBoYWNrZXJSZW5kZXJMb2coKTtcbiAgICBoYWNrZXJFbnN1cmVTdGF0ZXModHJ1ZSk7XG4gICAgaWYgKC9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIGhhY2tlckxvYWRPcGVuT3JkZXIodHJ1ZSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQntC60L3QviDCq9Cl0LDRgtC40LrQvtCl0LDQutC10YDCuyAo0YHRgtCw0YDRi9C5INGB0L7QstC80LXRgdGC0LjQvNGL0Lkg0YHQv9C+0YHQvtCxINC+0YLQutGA0YvRgtC40Y8pIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gb3BlbkhhY2tlcldpbmRvdygpIHtcbiAgICBjbG9zZU1lbWNoYXRPdmVybGF5KCk7XG5cbiAgICBjb25zdCB3aW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB3aW4uY2xhc3NOYW1lID0gJ21jLWZsb2F0LXdpbmRvdyc7XG4gICAgYXBwbHlGbG9hdFdpbmRvd1Bvcyh3aW4pO1xuXG4gICAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaGVhZGVyLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1oZWFkZXInO1xuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgdGl0bGUuY2xhc3NOYW1lID0gJ21jLWZsb2F0LXRpdGxlJztcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfwn5Cx8J+RqOKAjfCfkrsg0KXQsNGC0LjQutC+0KXQsNC60LXRgCc7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGNsb3NlLnR5cGUgPSAnYnV0dG9uJztcbiAgICBjbG9zZS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtY2xvc2UnO1xuICAgIGNsb3NlLnRleHRDb250ZW50ID0gJ+KclSc7XG4gICAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBjbG9zZU1lbWNoYXRPdmVybGF5KTtcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQoY2xvc2UpO1xuICAgIHdpbi5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIGJvZHkuY2xhc3NOYW1lID0gJ21jLWZsb2F0LWJvZHknO1xuXG4gICAgY29uc3QgdGFicyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRhYnMuaWQgPSAnaGFja2VyVGFicyc7XG4gICAgdGFicy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtnYXA6NHB4O21hcmdpbi1ib3R0b206OHB4Oyc7XG4gICAgY29uc3QgSEFDS0VSX1RBQlMgPSBbXG4gICAgICAgIFsnc3RhdHVzJywgJ9Ch0YLQsNGC0YPRgSddLFxuICAgICAgICBbJ2FnZW50JywgJ9Ca0L7QvdGC0YDQsNCz0LXQvdGCJ10sXG4gICAgICAgIFsnbm90aWZpZXInLCAn0J3QvtCy0YvQtSDQt9Cw0LrQsNC30YsnXSxcbiAgICAgICAgWydpbnRlcm5hbE9yZGVyQ2hlY2snLCAn0J/RgNC+0LLQtdGA0LrQsCDQt9Cw0LrQsNC30L7QsiddXG4gICAgXTtcbiAgICBIQUNLRVJfVEFCUy5mb3JFYWNoKChba2V5LCBsYWJlbF0sIGkpID0+IHtcbiAgICAgICAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgICAgIGJ0bi50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgICBidG4uZGF0YXNldC5oYWNrZXJUYWIgPSBrZXk7XG4gICAgICAgIGJ0bi5zdHlsZS5jc3NUZXh0ID0gJ2ZsZXg6MTtwYWRkaW5nOjVweCA0cHg7Ym9yZGVyOjFweCBzb2xpZCAjZTJlOGYwO2JvcmRlci1yYWRpdXM6OHB4OydcbiAgICAgICAgICAgICsgJ2JhY2tncm91bmQ6I2Y4ZmFmYztjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjsnXG4gICAgICAgICAgICArICd0cmFuc2l0aW9uOmFsbCAuMTVzO3doaXRlLXNwYWNlOm5vd3JhcDsnO1xuICAgICAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBoYWNrZXJTZWxlY3RUYWIoa2V5KSk7XG4gICAgICAgIHRhYnMuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgICB9KTtcbiAgICBib2R5LmFwcGVuZENoaWxkKHRhYnMpO1xuXG4gICAgY29uc3QgcGFuZXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBwYW5lcy5pZCA9ICdoYWNrZXJUYWJQYW5lcyc7XG4gICAgYm9keS5hcHBlbmRDaGlsZChwYW5lcyk7XG5cbiAgICAvLyDQmtC+0L3RgdC+0LvRjCDQstC90LjQt9GDXG4gICAgY29uc3QgbG9nTGFiZWwgPSBoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjojNjQ3NDhiO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsnXG4gICAgICAgICsgJ2xldHRlci1zcGFjaW5nOi44cHg7bWFyZ2luOjEwcHggMCA0cHg7JywgJ9Ca0L7QvdGB0L7Qu9GMJyk7XG4gICAgYm9keS5hcHBlbmRDaGlsZChsb2dMYWJlbCk7XG4gICAgY29uc3QgbG9nQm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgbG9nQm94LmlkID0gJ2hhY2tlckxvZ0JveCc7XG4gICAgbG9nQm94LnN0eWxlLmNzc1RleHQgPSAnaGVpZ2h0OjEyMHB4O292ZXJmbG93LXk6YXV0bztiYWNrZ3JvdW5kOiMwZjE3MmE7Ym9yZGVyLXJhZGl1czoxMHB4OydcbiAgICAgICAgKyAncGFkZGluZzo3cHg7Zm9udC1zaXplOjEwLjVweDtsaW5lLWhlaWdodDoxLjU7Zm9udC1mYW1pbHk6Q29uc29sYXMsbW9ub3NwYWNlOyc7XG4gICAgYm9keS5hcHBlbmRDaGlsZChsb2dCb3gpO1xuXG4gICAgd2luLmFwcGVuZENoaWxkKGJvZHkpO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQod2luKTtcbiAgICBtYWtlTW92YWJsZSh3aW4sIGhlYWRlcik7XG5cbiAgICBoYWNrZXJTZWxlY3RUYWIoaGFja2VyVGFiKTtcbiAgICBoYWNrZXJSZW5kZXJMb2coKTtcbiAgICBoYWNrZXJFbnN1cmVTdGF0ZXModHJ1ZSk7XG4gICAgaWYgKC9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIGhhY2tlckxvYWRPcGVuT3JkZXIodHJ1ZSk7XG59XG5cbi8vINCf0LXRgNC10LrQu9GO0YfQtdC90LjQtSDQstC60LvQsNC00L7QuiDQpdCw0LrQtdGA0LAgKNC/0LDQvdC10LvQuCDRgdGC0YDQvtGP0YLRgdGPINCyIDExLWhhY2tlci5qcylcbmZ1bmN0aW9uIGhhY2tlclNlbGVjdFRhYihrZXkpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLmRpYWdub3N0aWNzPy5zZWxlY3Qoa2V5KSkgcmV0dXJuO1xuICAgIC8vIE9sZCBjYWxsZXJzIG1heSBzdGlsbCByZXF1ZXN0IHRoZSByZW1vdmVkIHNhbGUgdGFiOyBuZXZlciBydW4gaXRzIGZsb3cuXG4gICAgaWYgKCFbJ3N0YXR1cycsICdhZ2VudCcsICdub3RpZmllcicsICdpbnRlcm5hbE9yZGVyQ2hlY2snXS5pbmNsdWRlcyhrZXkpKSBrZXkgPSAnc3RhdHVzJztcbiAgICBoYWNrZXJUYWIgPSBrZXk7XG4gICAgY29uc3QgdGFic0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclRhYnMnKTtcbiAgICBpZiAodGFic0VsKSB7XG4gICAgICAgIHRhYnNFbC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1oYWNrZXItdGFiXScpLmZvckVhY2godCA9PiB7XG4gICAgICAgICAgICBjb25zdCBhY3RpdmUgPSB0LmRhdGFzZXQuaGFja2VyVGFiID09PSBrZXk7XG4gICAgICAgICAgICB0LnN0eWxlLmJhY2tncm91bmQgPSBhY3RpdmUgPyAnbGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCM4YjVjZjYpJyA6ICcjZjhmYWZjJztcbiAgICAgICAgICAgIHQuc3R5bGUuY29sb3IgPSBhY3RpdmUgPyAnI2ZmZicgOiAnIzQ3NTU2OSc7XG4gICAgICAgICAgICB0LnN0eWxlLmJvcmRlckNvbG9yID0gYWN0aXZlID8gJ3RyYW5zcGFyZW50JyA6ICcjZTJlOGYwJztcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IHBhbmVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclRhYlBhbmVzJyk7XG4gICAgaWYgKCFwYW5lcykgcmV0dXJuO1xuICAgIHBhbmVzLmlubmVySFRNTCA9ICcnO1xuICAgIGxldCBwYW5lID0gbnVsbDtcbiAgICBpZiAoa2V5ID09PSAnc3RhdHVzJykgcGFuZSA9IGhhY2tlckJ1aWxkU3RhdHVzVGFiKCk7XG4gICAgZWxzZSBpZiAoa2V5ID09PSAnYWdlbnQnKSBwYW5lID0gaGFja2VyQnVpbGRBZ2VudFRhYigpO1xuICAgIGVsc2UgaWYgKGtleSA9PT0gJ25vdGlmaWVyJykgcGFuZSA9IGhhY2tlckJ1aWxkTm90aWZpZXJUYWIoKTtcbiAgICBlbHNlIGlmIChrZXkgPT09ICdpbnRlcm5hbE9yZGVyQ2hlY2snKSBwYW5lID0gaGFja2VyQnVpbGRJbnRlcm5hbE9yZGVyQ2hlY2tUYWIoKTtcbiAgICBpZiAocGFuZSkgcGFuZXMuYXBwZW5kQ2hpbGQocGFuZSk7XG5cbiAgICAvLyDQodC/0YDQsNCy0L7Rh9C90LjQutC4INC30LDQs9GA0YPQttCw0Y7RgtGB0Y8g0L/RgNC4INC+0YLQutGA0YvRgtC40Lgg0YHQvtC+0YLQstC10YLRgdGC0LLRg9GO0YnQtdC5INCy0LrQu9Cw0LTQutC4LlxuICAgIGlmIChrZXkgPT09ICdzdGF0dXMnKSBoYWNrZXJFbnN1cmVTdGF0ZXModHJ1ZSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQntC60L3QviDCq9Cd0LDRgdGC0YDQvtC50LrQuMK7IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8g0J7RgtC00LXQu9GM0L3QvtC1INC/0LvQsNCy0LDRjtGJ0LXQtSDQv9C10YDQtdGC0LDRgdC60LjQstCw0LXQvNC+0LUg0L7QutC90L4gKNC/0L7Qt9C40YbQuNGPINGB0L7RhdGA0LDQvdGP0LXRgtGB0Y8pLlxuZnVuY3Rpb24gb3BlblNldHRpbmdzV2luZG93KGluaXRpYWxUYWIgPSAnZ2VuZXJhbCcpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLmRpYWdub3N0aWNzKSB7XG4gICAgICAgIGlmIChpbml0aWFsVGFiID09PSAnaW50ZXJuYWxPcmRlckNoZWNrJykgaW5pdGlhbFRhYiA9ICdnZW5lcmFsJztcblxuICAgIH1cbiAgICBjbG9zZU1lbWNoYXRPdmVybGF5KCk7XG5cbiAgICBjb25zdCB3aW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB3aW4uY2xhc3NOYW1lID0gJ21jLWZsb2F0LXdpbmRvdyc7XG4gICAgYXBwbHlGbG9hdFdpbmRvd1Bvcyh3aW4pO1xuXG4gICAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaGVhZGVyLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1oZWFkZXInO1xuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgdGl0bGUuY2xhc3NOYW1lID0gJ21jLWZsb2F0LXRpdGxlJztcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfimpnvuI8g0J3QsNGB0YLRgNC+0LnQutC4JztcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICAgIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgY2xvc2UudHlwZSA9ICdidXR0b24nO1xuICAgIGNsb3NlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1jbG9zZSc7XG4gICAgY2xvc2UudGV4dENvbnRlbnQgPSAn4pyVJztcbiAgICBjbG9zZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGNsb3NlTWVtY2hhdE92ZXJsYXkpO1xuICAgIGhlYWRlci5hcHBlbmRDaGlsZChjbG9zZSk7XG4gICAgd2luLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm9keS5jbGFzc05hbWUgPSAnbWMtZmxvYXQtYm9keSc7XG4gICAgYm9keS5pbm5lckhUTUwgPSBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJtYy1zZWN0aW9uLWxhYmVsXCI+0J7Rh9C40YHRgtC60LAg0YLQtdC60YHRgtCwPC9kaXY+XG4gICAgICAgIDxsYWJlbCBzdHlsZT1cImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMnB4O21hcmdpbi1ib3R0b206MTBweDtjdXJzb3I6cG9pbnRlcjtcIj5cbiAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBpZD1cImNsZWFyVGV4dENoZWNrYm94XCIgc3R5bGU9XCJhY2NlbnQtY29sb3I6IzYzNjZmMTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O1wiPlxuICAgICAgICAgICAg0JPQu9C+0LHQsNC70YzQvdCw0Y8g0L7Rh9C40YHRgtC60LAg0YLQtdC60YHRgtCwINC/0L7RgdC70LUgRW50ZXJcbiAgICAgICAgPC9sYWJlbD5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpibG9jaztjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMnB4O1wiPlxuICAgICAgICAgICAg0JfQsNC00LXRgNC20LrQsDogPHNwYW4gaWQ9XCJ0aW1lb3V0VmFsdWVcIiBzdHlsZT1cImNvbG9yOiM2MzY2ZjE7Zm9udC13ZWlnaHQ6NzAwO1wiPjUwMDwvc3Bhbj4g0LzRgVxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJyYW5nZVwiIGlkPVwidGltZW91dFNsaWRlclwiIG1pbj1cIjFcIiBtYXg9XCIyMDAwXCIgdmFsdWU9XCI1MDBcIlxuICAgICAgICAgICAgICAgIHN0eWxlPVwid2lkdGg6MTAwJTttYXJnaW4tdG9wOjVweDthY2NlbnQtY29sb3I6IzYzNjZmMTtkaXNwbGF5OmJsb2NrO1wiPlxuICAgICAgICA8L2xhYmVsPlxuICAgICAgICA8bGFiZWwgc3R5bGU9XCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjEwcHg7Y3Vyc29yOnBvaW50ZXI7XCI+XG4gICAgICAgICAgICA8aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgaWQ9XCJzaG93SGF0aWtvTGlua3NDaGVja2JveFwiIHN0eWxlPVwiYWNjZW50LWNvbG9yOiM2MzY2ZjE7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtcIj5cbiAgICAgICAgICAgINCf0L7QutCw0LfRi9Cy0LDRgtGMINGB0YHRi9C70LrQuCBIYXRpa29cbiAgICAgICAgPC9sYWJlbD5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpibG9jaztjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMnB4O21hcmdpbi10b3A6MTBweDtcIj5cbiAgICAgICAgICAgINCf0L7QuNGB0Log0YbQuNGE0YDQvtCy0YvRhSDQt9Cw0L/RgNC+0YHQvtCyOlxuICAgICAgICAgICAgPHNlbGVjdCBpZD1cImhhdGlrb1NlYXJjaE1vZGVcIiBzdHlsZT1cImRpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTttYXJnaW4tdG9wOjVweDtwYWRkaW5nOjVweDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6NnB4O2NvbG9yOiMzMzQxNTU7XCI+XG4gICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cImF1dG9cIj7QodC90LDRh9Cw0LvQsCBQYW5lbCwg0LfQsNGC0LXQvCDRgdCw0LnRgjwvb3B0aW9uPlxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJwYW5lbFwiPtCi0L7Qu9GM0LrQviBQYW5lbDwvb3B0aW9uPlxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJoYXRpa29cIj7QotC+0LvRjNC60L4g0YHQsNC50YIgSGF0aWtvPC9vcHRpb24+XG4gICAgICAgICAgICA8L3NlbGVjdD5cbiAgICAgICAgPC9sYWJlbD5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpibG9jaztjb2xvcjojNDc1NTY5O2ZvbnQtc2l6ZToxMnB4O21hcmdpbi10b3A6MTBweDtcIj5cbiAgICAgICAgICAgINCf0L7QstC10LTQtdC90LjQtSDQutC90L7Qv9C60Lgg8J+UgTpcbiAgICAgICAgICAgIDxzZWxlY3QgaWQ9XCJyZXRyeUJlaGF2aW9yXCIgc3R5bGU9XCJkaXNwbGF5OmJsb2NrO3dpZHRoOjEwMCU7bWFyZ2luLXRvcDo1cHg7cGFkZGluZzo1cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjZweDtjb2xvcjojMzM0MTU1O1wiPlxuICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJhcHBlbmRcIj7QndC1INGD0LTQsNC70Y/RgtGMINGB0YLQsNGA0YvQuSDQvtGC0LLQtdGCPC9vcHRpb24+XG4gICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cInJlcGxhY2VcIj7Qo9C00LDQu9GP0YLRjCDRgdGC0LDRgNGL0Lkg0L7RgtCy0LXRgiDQuCDQv9C+0LLRgtC+0YDRj9GC0Yw8L29wdGlvbj5cbiAgICAgICAgICAgIDwvc2VsZWN0PlxuICAgICAgICA8L2xhYmVsPlxuXG4gICAgICAgIDxkaXYgc3R5bGU9XCJoZWlnaHQ6OHB4O1wiPjwvZGl2PlxuICAgICAgICA8bGFiZWwgc3R5bGU9XCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDttYXJnaW4tYm90dG9tOjEwcHg7Y3Vyc29yOnBvaW50ZXI7XCI+XG4gICAgICAgICAgICA8aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgaWQ9XCJzY2hlZHVsZUNhY2hlQ2hlY2tib3hcIiBzdHlsZT1cImFjY2VudC1jb2xvcjojNjM2NmYxO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7XCI+XG4gICAgICAgICAgICDQmtC10YjQuNGA0L7QstCw0YLRjCDRgNCw0YHQv9C40YHQsNC90LjQtSDQvdCwIDEyINGH0LDRgdC+0LJcbiAgICAgICAgPC9sYWJlbD5cblxuICAgICAgICA8ZGl2IGlkPVwibWNTZXR0aW5nc1J1bGVzUGFuZVwiIHN0eWxlPVwiZGlzcGxheTpub25lO1wiPlxuICAgICAgICA8YnV0dG9uIGlkPVwiY2FsY1NldHRpbmdzQnRuXCIgY2xhc3M9XCJtYy1idG4gbWMtYnRuLXNsYXRlXCIgc3R5bGU9XCJ3aWR0aDoxMDAlO1wiPuKame+4jyDQn9GA0LDQstC40LvQsCDwn6euPC9idXR0b24+XG4gICAgICAgIDxkaXYgaWQ9XCJjYWxjU2V0dGluZ3NQYW5lbFwiIGNsYXNzPVwibWMtcGFuZWxcIiBzdHlsZT1cImRpc3BsYXk6bm9uZTttYXgtaGVpZ2h0Om5vbmU7XCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwibWMtcGFuZWwtdGl0bGVcIj7impnvuI8g0J/RgNCw0LLQuNC70LAg0LrQsNC70YzQutGD0LvRj9GC0L7RgNCwXG4gICAgICAgICAgICAgICAgPHNwYW4gc3R5bGU9XCJmb250LXdlaWdodDo0MDA7Y29sb3I6IzMzNDE1NTt0ZXh0LXRyYW5zZm9ybTpub25lO2xldHRlci1zcGFjaW5nOjA7bWFyZ2luLWxlZnQ6NnB4O1wiPlxuICAgICAgICAgICAgICAgICAgICByb3VuZCjRgdGD0LzQvNCwIMOXICUgw7cgMTAwIMO3INC+0LrRgNGD0LPQuy4pIMOXINC+0LrRgNGD0LPQuy4gKyDQtNC+0L8uXG4gICAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGlkPVwiY2FsY1J1bGVzUGFuZWxcIj48L2Rpdj5cbiAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgPGRpdiBzdHlsZT1cImhlaWdodDo4cHg7XCI+PC9kaXY+XG4gICAgICAgIDxidXR0b24gaWQ9XCJzY2hlZHVsZVNldHRpbmdzQnRuXCIgY2xhc3M9XCJtYy1idG4gbWMtYnRuLXNsYXRlXCIgc3R5bGU9XCJ3aWR0aDoxMDAlO1wiPuKame+4jyDQl9Cw0LzQtdC90Ysg8J+ThTwvYnV0dG9uPlxuICAgICAgICA8ZGl2IGlkPVwic2NoZWR1bGVTZXR0aW5nc1BhbmVsXCIgY2xhc3M9XCJtYy1wYW5lbFwiIHN0eWxlPVwiZGlzcGxheTpub25lO21heC1oZWlnaHQ6bm9uZTtcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJtYy1wYW5lbC10aXRsZVwiPuKame+4jyDQl9Cw0LzQtdC90Ysg0LTQu9GPINGA0LDRgdC/0LjRgdCw0L3QuNGPPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGlkPVwic2NoZWR1bGVSdWxlc1BhbmVsXCI+PC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICA8ZGl2IHN0eWxlPVwiaGVpZ2h0OjhweDtcIj48L2Rpdj5cbiAgICAgICAgPGxhYmVsIHN0eWxlPVwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O2NvbG9yOiM0NzU1Njk7Zm9udC1zaXplOjEycHg7bWFyZ2luLWJvdHRvbToxMHB4O2N1cnNvcjpwb2ludGVyO1wiPlxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGlkPVwibXNRdWlja1BhbmVsQ2hlY2tib3hcIiBzdHlsZT1cImFjY2VudC1jb2xvcjojNjM2NmYxO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7XCI+XG4gICAgICAgICAgICDQn9Cw0L3QtdC70Ywg0LHRi9GB0YLRgNGL0YUg0LrQvdC+0L/QvtC6ICjQnNC+0LnQodC60LvQsNC0KVxuICAgICAgICA8L2xhYmVsPlxuXG4gICAgICAgIDxkaXYgc3R5bGU9XCJoZWlnaHQ6OHB4O1wiPjwvZGl2PlxuICAgICAgICA8bGFiZWwgc3R5bGU9XCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTJweDttYXJnaW4tYm90dG9tOjEwcHg7Y3Vyc29yOnBvaW50ZXI7XCI+XG4gICAgICAgICAgICA8aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgaWQ9XCJtc0JlYXJlckNoZWNrYm94XCIgc3R5bGU9XCJhY2NlbnQtY29sb3I6IzYzNjZmMTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O1wiPlxuICAgICAgICAgICAgQmVhcmVyLdC60LvRjtGHIEFQSSDQnNC+0LnQodC60LvQsNC0XG4gICAgICAgIDwvbGFiZWw+XG4gICAgICAgIDxpbnB1dCB0eXBlPVwidGV4dFwiIGlkPVwibXNCZWFyZXJUb2tlblwiIHBsYWNlaG9sZGVyPVwiQVBJLdC60LvRjtGHINCc0L7QudCh0LrQu9Cw0LQgKEJlYXJlcinigKZcIiBzcGVsbGNoZWNrPVwiZmFsc2VcIlxuICAgICAgICAgICAgc3R5bGU9XCJkaXNwbGF5Om5vbmU7d2lkdGg6MTAwJTtwYWRkaW5nOjVweCA3cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4O291dGxpbmU6bm9uZTtib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luLWJvdHRvbToxMHB4O1wiPlxuXG4gICAgICAgIDxidXR0b24gaWQ9XCJtc01hZ2ljU2V0dGluZ3NCdG5cIiBjbGFzcz1cIm1jLWJ0biBtYy1idG4tc2xhdGVcIiBzdHlsZT1cIndpZHRoOjEwMCU7XCI+8J+qhCDQkNCy0YLQvtC30LDQv9C+0LvQvdC10L3QuNC1INC00L7QutGD0LzQtdC90YLQvtCyIChKU09OKTwvYnV0dG9uPlxuICAgICAgICA8ZGl2IGlkPVwibXNNYWdpY1NldHRpbmdzUGFuZWxcIiBjbGFzcz1cIm1jLXBhbmVsXCIgc3R5bGU9XCJkaXNwbGF5Om5vbmU7bWF4LWhlaWdodDpub25lO1wiPlxuICAgICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQtc2l6ZToxMC41cHg7Y29sb3I6IzY0NzQ4YjttYXJnaW4tYm90dG9tOjZweDtsaW5lLWhlaWdodDoxLjQ7XCI+XG4gICAgICAgICAgICAgICAgZGVtYW5kIOKAlCDQntGC0LPRgNGD0LfQutCwLCBjYXNoaW4g4oCUINCf0YDQuNGF0L7QtNC90YvQuSDQvtGA0LTQtdGALCBwYXltZW50aW4g4oCUINCS0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2Ljxicj5cbiAgICAgICAgICAgICAgICBjb3BpZXMg0LrQvtC/0LjRgNGD0LXRgiDQt9C90LDRh9C10L3QuNC1INC80LXQttC00YMg0L7QtNC40L3QsNC60L7QstGL0LzQuCDQv9C+0LvRj9C80Lg7IHZhbHVlcyDQt9Cw0LTQsNGR0YIg0YLQvtGH0L3QvtC1INC30L3QsNGH0LXQvdC40LUg0LjQtyDRgdC/0LjRgdC60LAg0JzQvtC50KHQutC70LDQtC5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPHRleHRhcmVhIGlkPVwibXNNYWdpY0NvbmZpZ0pzb25cIiBzcGVsbGNoZWNrPVwiZmFsc2VcIiBzdHlsZT1cIndpZHRoOjEwMCU7aGVpZ2h0OjIxMHB4O3BhZGRpbmc6N3B4O2JveC1zaXppbmc6Ym9yZGVyLWJveDtyZXNpemU6dmVydGljYWw7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2JhY2tncm91bmQ6I2ZmZjtjb2xvcjojMzM0MTU1O2ZvbnQ6MTBweCBDb25zb2xhcyxtb25vc3BhY2U7XCI+PC90ZXh0YXJlYT5cbiAgICAgICAgICAgIDxidXR0b24gaWQ9XCJtc01hZ2ljQ29uZmlnU2F2ZVwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1ncmVlblwiIHN0eWxlPVwid2lkdGg6MTAwJTttYXJnaW4tdG9wOjZweDtcIj7QodC+0YXRgNCw0L3QuNGC0YwgSlNPTjwvYnV0dG9uPlxuICAgICAgICAgICAgPGRpdiBpZD1cIm1zTWFnaWNDb25maWdTdGF0dXNcIiBzdHlsZT1cIm1pbi1oZWlnaHQ6MTZweDttYXJnaW4tdG9wOjVweDtmb250LXNpemU6MTAuNXB4O2NvbG9yOiM2NDc0OGI7XCI+PC9kaXY+XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgc3R5bGU9XCJoZWlnaHQ6OHB4O1wiPjwvZGl2PlxuICAgICAgICA8YnV0dG9uIGlkPVwicmVzZXRGbG9hdFBvc0J0blwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1vcmFuZ2VcIiBzdHlsZT1cIndpZHRoOjEwMCU7XCIgZGF0YS10aXA9XCLihrog0JLQtdGA0L3Rg9GC0Ywg0L7QutC90LAg0LIg0L/QvtC30LjRhtC40Y4g0L/QviDRg9C80L7Qu9GH0LDQvdC40Y5cIj7ihrog0KHQsdGA0L7RgdC40YLRjCDQv9C+0LvQvtC20LXQvdC40LUg0L7QutC+0L08L2J1dHRvbj5cblxuICAgICAgICA8ZGl2IHN0eWxlPVwiaGVpZ2h0OjhweDtcIj48L2Rpdj5cbiAgICAgICAgPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDtnYXA6NnB4O1wiPlxuICAgICAgICAgICAgPGJ1dHRvbiBpZD1cImV4cG9ydFNldHRpbmdzQnRuXCIgY2xhc3M9XCJtYy1idG4gbWMtYnRuLXNsYXRlXCIgc3R5bGU9XCJmbGV4OjE7XCIgZGF0YS10aXA9XCLwn5OLINCh0LrQvtC/0LjRgNC+0LLQsNGC0Ywg0LLRgdC1INC90LDRgdGC0YDQvtC50LrQuCDQsiDQsdGD0YTQtdGAXCI+8J+TpCDQrdC60YHQv9C+0YDRgjwvYnV0dG9uPlxuICAgICAgICAgICAgPGJ1dHRvbiBpZD1cImltcG9ydFNldHRpbmdzQnRuXCIgY2xhc3M9XCJtYy1idG4gbWMtYnRuLXNsYXRlXCIgc3R5bGU9XCJmbGV4OjE7XCIgZGF0YS10aXA9XCLwn5OlINCS0YHRgtCw0LLQuNGC0Ywg0L3QsNGB0YLRgNC+0LnQutC4INC40Lcg0LHRg9GE0LXRgNCwXCI+8J+TpSDQmNC80L/QvtGA0YI8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDx0ZXh0YXJlYSBpZD1cIm1jSW1wb3J0QXJlYVwiIHNwZWxsY2hlY2s9XCJmYWxzZVwiIHBsYWNlaG9sZGVyPSfQktGB0YLQsNCy0YzRgtC1INGB0Y7QtNCwIEpTT04g0L3QsNGB0YLRgNC+0LXQuuKApicgc3R5bGU9XCJkaXNwbGF5Om5vbmU7d2lkdGg6MTAwJTtoZWlnaHQ6MTEwcHg7bWFyZ2luLXRvcDo2cHg7cGFkZGluZzo3cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjhweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMC41cHg7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2JveC1zaXppbmc6Ym9yZGVyLWJveDtyZXNpemU6dmVydGljYWw7b3V0bGluZTpub25lO1wiPjwvdGV4dGFyZWE+XG4gICAgICAgIDxkaXYgaWQ9XCJtY0ltcG9ydEFjdGlvbnNcIiBzdHlsZT1cImRpc3BsYXk6bm9uZTtnYXA6NnB4O21hcmdpbi10b3A6NnB4O1wiPlxuICAgICAgICAgICAgPGJ1dHRvbiBpZD1cIm1jSW1wb3J0QXBwbHlcIiBjbGFzcz1cIm1jLWJ0biBtYy1idG4tZ3JlZW5cIiBzdHlsZT1cImZsZXg6MTtcIj7Qn9GA0LjQvNC10L3QuNGC0Yw8L2J1dHRvbj5cbiAgICAgICAgICAgIDxidXR0b24gaWQ9XCJtY0ltcG9ydENhbmNlbFwiIGNsYXNzPVwibWMtYnRuIG1jLWJ0bi1zbGF0ZVwiIHN0eWxlPVwiZmxleDoxO1wiPtCe0YLQvNC10L3QsDwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gICAgY29uc3QgZ2VuZXJhbFBhbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBnZW5lcmFsUGFuZS5pZCA9ICdtY1NldHRpbmdzR2VuZXJhbFBhbmUnO1xuICAgIHdoaWxlIChib2R5LmZpcnN0Q2hpbGQpIGdlbmVyYWxQYW5lLmFwcGVuZENoaWxkKGJvZHkuZmlyc3RDaGlsZCk7XG4gICAgY29uc3QgcnVsZXNQYW5lID0gZ2VuZXJhbFBhbmUucXVlcnlTZWxlY3RvcignI21jU2V0dGluZ3NSdWxlc1BhbmUnKTtcbiAgICBydWxlc1BhbmUucmVtb3ZlKCk7XG5cbiAgICBjb25zdCBzZXR0aW5nc1RhYnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBzZXR0aW5nc1RhYnMuaWQgPSAnbWNTZXR0aW5nc1RhYnMnO1xuICAgIHNldHRpbmdzVGFicy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6ZmxleDtnYXA6NHB4O21hcmdpbi1ib3R0b206OXB4Oyc7XG4gICAgY29uc3Qgc2V0dGluZ3NHZW5lcmFsVGFiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgc2V0dGluZ3NHZW5lcmFsVGFiLmlkID0gJ21jU2V0dGluZ3NUYWJHZW5lcmFsJztcbiAgICBzZXR0aW5nc0dlbmVyYWxUYWIudHlwZSA9ICdidXR0b24nO1xuICAgIHNldHRpbmdzR2VuZXJhbFRhYi50ZXh0Q29udGVudCA9ICfimpnvuI8g0J7QsdGJ0LjQtSc7XG4gICAgY29uc3Qgc2V0dGluZ3NSdWxlc1RhYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIHNldHRpbmdzUnVsZXNUYWIuaWQgPSAnbWNTZXR0aW5nc1RhYlJ1bGVzJztcbiAgICBzZXR0aW5nc1J1bGVzVGFiLnR5cGUgPSAnYnV0dG9uJztcbiAgICBzZXR0aW5nc1J1bGVzVGFiLnRleHRDb250ZW50ID0gJ/Cfk50g0J/RgNCw0LLQuNC70LAg0Lgg0LfQsNC80LXQvdGLJztcbiAgICBjb25zdCBzZXR0aW5nc09yZGVyVGFiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgc2V0dGluZ3NPcmRlclRhYi5pZCA9ICdtY1NldHRpbmdzVGFiSW50ZXJuYWxPcmRlckNoZWNrJztcbiAgICBzZXR0aW5nc09yZGVyVGFiLnR5cGUgPSAnYnV0dG9uJztcbiAgICBzZXR0aW5nc09yZGVyVGFiLnRleHRDb250ZW50ID0gJ/Cfk6Yg0J/RgNC+0LLQtdGA0LrQsCDQt9Cw0LrQsNC30L7Qsic7XG4gICAgW3NldHRpbmdzR2VuZXJhbFRhYiwgc2V0dGluZ3NSdWxlc1RhYiwgc2V0dGluZ3NPcmRlclRhYl0uZm9yRWFjaChidXR0b24gPT4ge1xuICAgICAgICBidXR0b24uc3R5bGUuY3NzVGV4dCA9ICdmbGV4OjE7cGFkZGluZzo2cHggNXB4O2JvcmRlcjoxcHggc29saWQgI2UyZThmMDtib3JkZXItcmFkaXVzOjhweDtiYWNrZ3JvdW5kOiNmOGZhZmM7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICAgICAgc2V0dGluZ3NUYWJzLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gICAgfSk7XG5cbiAgICBjb25zdCBvcmRlckNoZWNrUGFuZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIG9yZGVyQ2hlY2tQYW5lLmlkID0gJ21jU2V0dGluZ3NJbnRlcm5hbE9yZGVyQ2hlY2tQYW5lJztcbiAgICBvcmRlckNoZWNrUGFuZS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgIGNvbnN0IGVuc3VyZU9yZGVyQ2hlY2tTZXR0aW5ncyA9ICgpID0+IHtcbiAgICAgICAgaWYgKCFvcmRlckNoZWNrUGFuZS5maXJzdENoaWxkKSBvcmRlckNoZWNrUGFuZS5hcHBlbmRDaGlsZChpbnRlcm5hbE9yZGVyQ2hlY2tCdWlsZFNldHRpbmdzUGFuZWwoKSk7XG4gICAgfTtcbiAgICBjb25zdCBhY3RpdmF0ZVNldHRpbmdzVGFiID0ga2V5ID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ2ludGVybmFsT3JkZXJDaGVjaycpIGVuc3VyZU9yZGVyQ2hlY2tTZXR0aW5ncygpO1xuICAgICAgICBbXG4gICAgICAgICAgICBbJ2dlbmVyYWwnLCBzZXR0aW5nc0dlbmVyYWxUYWIsIGdlbmVyYWxQYW5lXSxcbiAgICAgICAgICAgIFsncnVsZXMnLCBzZXR0aW5nc1J1bGVzVGFiLCBydWxlc1BhbmVdLFxuICAgICAgICAgICAgWydpbnRlcm5hbE9yZGVyQ2hlY2snLCBzZXR0aW5nc09yZGVyVGFiLCBvcmRlckNoZWNrUGFuZV1cbiAgICAgICAgXS5mb3JFYWNoKChbdGFiS2V5LCBidXR0b24sIHBhbmVdKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhY3RpdmUgPSBrZXkgPT09IHRhYktleTtcbiAgICAgICAgICAgIHBhbmUuc3R5bGUuZGlzcGxheSA9IGFjdGl2ZSA/ICdibG9jaycgOiAnbm9uZSc7XG4gICAgICAgICAgICBidXR0b24uc3R5bGUuYmFja2dyb3VuZCA9IGFjdGl2ZSA/ICdsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCM2MzY2ZjEsIzhiNWNmNiknIDogJyNmOGZhZmMnO1xuICAgICAgICAgICAgYnV0dG9uLnN0eWxlLmNvbG9yID0gYWN0aXZlID8gJyNmZmYnIDogJyM0NzU1NjknO1xuICAgICAgICB9KTtcbiAgICB9O1xuICAgIHNldHRpbmdzR2VuZXJhbFRhYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGFjdGl2YXRlU2V0dGluZ3NUYWIoJ2dlbmVyYWwnKSk7XG4gICAgc2V0dGluZ3NSdWxlc1RhYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGFjdGl2YXRlU2V0dGluZ3NUYWIoJ3J1bGVzJykpO1xuICAgIHNldHRpbmdzT3JkZXJUYWIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhY3RpdmF0ZVNldHRpbmdzVGFiKCdpbnRlcm5hbE9yZGVyQ2hlY2snKSk7XG4gICAgYm9keS5hcHBlbmQoc2V0dGluZ3NUYWJzLCBnZW5lcmFsUGFuZSwgcnVsZXNQYW5lLCBvcmRlckNoZWNrUGFuZSk7XG5cbiAgICB3aW4uYXBwZW5kQ2hpbGQoYm9keSk7XG5cbiAgICAvLyDQodC90LDRh9Cw0LvQsCDQsiBET00g4oCUINC40L3QsNGH0LUgZ2V0RWxlbWVudEJ5SWQg0L3QtSDQvdCw0LnQtNGR0YIg0Y3Qu9C10LzQtdC90YLRiyDQvtC60L3QsC5cbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHdpbik7XG4gICAgYWN0aXZhdGVTZXR0aW5nc1RhYihpbml0aWFsVGFiID09PSAnaW50ZXJuYWxPcmRlckNoZWNrJyA/ICdpbnRlcm5hbE9yZGVyQ2hlY2snIDogJ2dlbmVyYWwnKTtcblxuICAgIC8vINCf0YDQuNCy0Y/Qt9C60Lg6IHNldHVwLdGE0YPQvdC60YbQuNC4INGB0LjQvdGF0YDQvtC90LjQt9C40YDRg9GO0YIg0YHQvtGB0YLQvtGP0L3QuNC1LCDQtNC+0LrRg9C80LXQvdGCLdGB0LvRg9GI0LDRgtC10LvRjCDQstC10YjQsNC10YLRgdGPINC+0LTQuNC9INGA0LDQty5cbiAgICBzZXR1cEdsb2JhbENsZWFyVGV4dEZ1bmN0aW9uYWxpdHkoKTtcbiAgICBzZXR1cEhhdGlrb0xpbmtzU2V0dGluZygpO1xuICAgIHNldHVwSGF0aWtvU2VhcmNoTW9kZVNldHRpbmcoKTtcbiAgICBjb25zdCByZXRyeVNlbGVjdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXRyeUJlaGF2aW9yJyk7XG4gICAgaWYgKHJldHJ5U2VsZWN0KSB7XG4gICAgICAgIHJldHJ5U2VsZWN0LnZhbHVlID0gcmV0cnlCZWhhdmlvcjtcbiAgICAgICAgcmV0cnlTZWxlY3QuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4gc2F2ZVJldHJ5QmVoYXZpb3IocmV0cnlTZWxlY3QudmFsdWUpKTtcbiAgICB9XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RpbWVvdXRTbGlkZXInKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIGUgPT4ge1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndGltZW91dFZhbHVlJykudGV4dENvbnRlbnQgPSBlLnRhcmdldC52YWx1ZTtcbiAgICB9KTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2FsY1NldHRpbmdzQnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbGNTZXR0aW5nc1BhbmVsJyk7XG4gICAgICAgIGNvbnN0IHdhc0hpZGRlbiA9IHBhbmVsLnN0eWxlLmRpc3BsYXkgPT09ICdub25lJztcbiAgICAgICAgdG9nZ2xlUGFuZWwoJ2NhbGNTZXR0aW5nc1BhbmVsJyk7XG4gICAgICAgIGlmICh3YXNIaWRkZW4pIGJ1aWxkQ2FsY1J1bGVzUGFuZWwoKTtcbiAgICB9KTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NoZWR1bGVTZXR0aW5nc0J0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY2hlZHVsZVNldHRpbmdzUGFuZWwnKTtcbiAgICAgICAgY29uc3Qgd2FzSGlkZGVuID0gcGFuZWwuc3R5bGUuZGlzcGxheSA9PT0gJ25vbmUnO1xuICAgICAgICB0b2dnbGVQYW5lbCgnc2NoZWR1bGVTZXR0aW5nc1BhbmVsJyk7XG4gICAgICAgIGlmICh3YXNIaWRkZW4pIGJ1aWxkU2NoZWR1bGVQYW5lbCgpO1xuICAgIH0pO1xuICAgIGNvbnN0IHNjaGVkdWxlQ2FjaGVDYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY2hlZHVsZUNhY2hlQ2hlY2tib3gnKTtcbiAgICBzY2hlZHVsZUNhY2hlQ2IuY2hlY2tlZCA9IHNjaGVkdWxlQ2FjaGVFbmFibGVkO1xuICAgIHNjaGVkdWxlQ2FjaGVDYi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiBzYXZlU2NoZWR1bGVDYWNoZUVuYWJsZWQoc2NoZWR1bGVDYWNoZUNiLmNoZWNrZWQpKTtcbiAgICBjb25zdCBtc1F1aWNrQ2IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNRdWlja1BhbmVsQ2hlY2tib3gnKTtcbiAgICBpZiAobXNRdWlja0NiKSB7XG4gICAgICAgIG1zUXVpY2tDYi5jaGVja2VkID0gbXNRdWlja1BhbmVsRW5hYmxlZDtcbiAgICAgICAgbXNRdWlja0NiLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIG1zUXVpY2tQYW5lbEVuYWJsZWQgPSBtc1F1aWNrQ2IuY2hlY2tlZDtcbiAgICAgICAgICAgIHNhdmVNc1F1aWNrUGFuZWxFbmFibGVkKCk7XG4gICAgICAgICAgICBidWlsZE1zUXVpY2tQYW5lbCgpO1xuICAgICAgICB9KTtcbiAgICB9XG4gICAgY29uc3QgZGVmYXVsdENoYW5uZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyRGVmYXVsdENoYW5uZWwnKTtcbiAgICBpZiAoZGVmYXVsdENoYW5uZWwpIHtcbiAgICAgICAgZGVmYXVsdENoYW5uZWwudmFsdWUgPSBoYWNrZXJEZWZhdWx0Q2hhbm5lbDtcbiAgICAgICAgaGFja2VyUmVmcmVzaFNhbGVzQ2hhbm5lbHModHJ1ZSkudGhlbigoKSA9PiB7XG4gICAgICAgICAgICBoYWNrZXJTYWxlc0NoYW5uZWxzLmZvckVhY2goaXRlbSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7IG9wdGlvbi52YWx1ZSA9IGl0ZW0uaHJlZjsgb3B0aW9uLnRleHRDb250ZW50ID0gaXRlbS5uYW1lOyBkZWZhdWx0Q2hhbm5lbC5hcHBlbmRDaGlsZChvcHRpb24pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBkZWZhdWx0Q2hhbm5lbC52YWx1ZSA9IGhhY2tlckRlZmF1bHRDaGFubmVsO1xuICAgICAgICB9KTtcbiAgICAgICAgZGVmYXVsdENoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4geyBoYWNrZXJEZWZhdWx0Q2hhbm5lbCA9IGRlZmF1bHRDaGFubmVsLnZhbHVlOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJEZWZhdWx0Q2hhbm5lbF92MScpLCBoYWNrZXJEZWZhdWx0Q2hhbm5lbCk7IH0pO1xuICAgIH1cbiAgICBjb25zdCBxdWlja0NiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclF1aWNrQnV0dG9uc0NoZWNrYm94Jyk7XG4gICAgaWYgKHF1aWNrQ2IpIHsgcXVpY2tDYi5jaGVja2VkID0gaGFja2VyUXVpY2tCdXR0b25zRW5hYmxlZDsgcXVpY2tDYi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7IGhhY2tlclF1aWNrQnV0dG9uc0VuYWJsZWQgPSBxdWlja0NiLmNoZWNrZWQ7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlclF1aWNrQnV0dG9uc192MScpLCBTdHJpbmcoaGFja2VyUXVpY2tCdXR0b25zRW5hYmxlZCkpOyBidWlsZE1zUXVpY2tQYW5lbCgpOyB9KTsgfVxuICAgIGNvbnN0IG1hZ2ljQXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtc01hZ2ljQ29uZmlnSnNvbicpO1xuICAgIGNvbnN0IG1hZ2ljU3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21zTWFnaWNDb25maWdTdGF0dXMnKTtcbiAgICBpZiAobWFnaWNBcmVhKSBtYWdpY0FyZWEudmFsdWUgPSBKU09OLnN0cmluZ2lmeShtc01hZ2ljQ29uZmlnLCBudWxsLCAyKTtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNNYWdpY1NldHRpbmdzQnRuJyk/LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdG9nZ2xlUGFuZWwoJ21zTWFnaWNTZXR0aW5nc1BhbmVsJykpO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtc01hZ2ljQ29uZmlnU2F2ZScpPy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobWFnaWNBcmVhPy52YWx1ZSB8fCAnJyk7XG4gICAgICAgICAgICBzYXZlTXNNYWdpY0NvbmZpZyhwYXJzZWQpO1xuICAgICAgICAgICAgaWYgKG1hZ2ljQXJlYSkgbWFnaWNBcmVhLnZhbHVlID0gSlNPTi5zdHJpbmdpZnkobXNNYWdpY0NvbmZpZywgbnVsbCwgMik7XG4gICAgICAgICAgICBpZiAobWFnaWNTdGF0dXMpIHsgbWFnaWNTdGF0dXMudGV4dENvbnRlbnQgPSAn4pyFINCh0L7RhdGA0LDQvdC10L3Qvic7IG1hZ2ljU3RhdHVzLnN0eWxlLmNvbG9yID0gJyMxNmEzNGEnOyB9XG4gICAgICAgICAgICByZWNvbmNpbGVNc0VuaGFuY2VtZW50cygpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKG1hZ2ljU3RhdHVzKSB7IG1hZ2ljU3RhdHVzLnRleHRDb250ZW50ID0gYOKdjCDQntGI0LjQsdC60LA6ICR7ZXJyb3IubWVzc2FnZX1gOyBtYWdpY1N0YXR1cy5zdHlsZS5jb2xvciA9ICcjZGMyNjI2JzsgfVxuICAgICAgICB9XG4gICAgfSk7XG4gICAgY29uc3QgYmVhcmVyQ2IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNCZWFyZXJDaGVja2JveCcpO1xuICAgIGNvbnN0IGJlYXJlcklucCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtc0JlYXJlclRva2VuJyk7XG4gICAgaWYgKGJlYXJlckNiICYmIGJlYXJlcklucCkge1xuICAgICAgICBiZWFyZXJDYi5jaGVja2VkID0gaGFja2VyQmVhcmVyRW5hYmxlZDtcbiAgICAgICAgYmVhcmVySW5wLnN0eWxlLmRpc3BsYXkgPSBoYWNrZXJCZWFyZXJFbmFibGVkID8gJ2Jsb2NrJyA6ICdub25lJztcbiAgICAgICAgYmVhcmVySW5wLnZhbHVlID0gaGFja2VyQmVhcmVyVG9rZW47XG4gICAgICAgIGJlYXJlckNiLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcbiAgICAgICAgICAgIGhhY2tlclNldEJlYXJlckVuYWJsZWQoYmVhcmVyQ2IuY2hlY2tlZCk7XG4gICAgICAgICAgICBoYWNrZXJWYWxpZGF0ZUFwaUtleSgpO1xuICAgICAgICB9KTtcbiAgICAgICAgYmVhcmVySW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4gaGFja2VyU2V0QmVhcmVyVG9rZW4oYmVhcmVySW5wLnZhbHVlKSk7XG4gICAgICAgIGJlYXJlcklucC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiBoYWNrZXJWYWxpZGF0ZUFwaUtleSgpKTtcbiAgICB9XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc2V0RmxvYXRQb3NCdG4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgcmVzZXRGbG9hdFdpbmRvd1BvcygpO1xuICAgICAgICBjbG9zZU1lbWNoYXRPdmVybGF5KCk7XG4gICAgICAgIHNldFN0YXR1c1RleHQoJ+KchSDQn9C+0LvQvtC20LXQvdC40LUg0L7QutC+0L0g0YHQsdGA0L7RiNC10L3QvicpO1xuICAgIH0pO1xuXG4gICAgLy8g0K3QutGB0L/QvtGA0YIgLyDQuNC80L/QvtGA0YIg0L3QsNGB0YLRgNC+0LXQulxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdleHBvcnRTZXR0aW5nc0J0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZXhwb3J0U2V0dGluZ3MpO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdpbXBvcnRTZXR0aW5nc0J0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBjb25zdCBhcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QXJlYScpO1xuICAgICAgICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QWN0aW9ucycpO1xuICAgICAgICBpZiAoIWFyZWEgfHwgIWFjdGlvbnMpIHJldHVybjtcbiAgICAgICAgY29uc3Qgc2hvd2luZyA9IGFyZWEuc3R5bGUuZGlzcGxheSAhPT0gJ25vbmUnO1xuICAgICAgICBhcmVhLnN0eWxlLmRpc3BsYXkgPSBzaG93aW5nID8gJ25vbmUnIDogJ2Jsb2NrJztcbiAgICAgICAgYWN0aW9ucy5zdHlsZS5kaXNwbGF5ID0gc2hvd2luZyA/ICdub25lJyA6ICdmbGV4JztcbiAgICAgICAgaWYgKCFzaG93aW5nKSBhcmVhLmZvY3VzKCk7XG4gICAgfSk7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QXBwbHknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgaW1wb3J0U2V0dGluZ3MoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0QXJlYScpPy52YWx1ZSB8fCAnJyk7XG4gICAgfSk7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jSW1wb3J0Q2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNJbXBvcnRBcmVhJyk7XG4gICAgICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNJbXBvcnRBY3Rpb25zJyk7XG4gICAgICAgIGlmIChhcmVhKSB7IGFyZWEuc3R5bGUuZGlzcGxheSA9ICdub25lJzsgYXJlYS52YWx1ZSA9ICcnOyBhcmVhLnN0eWxlLmJvcmRlckNvbG9yID0gJyNjYmQ1ZTEnOyBhcmVhLnN0eWxlLmJvcmRlcldpZHRoID0gJzFweCc7IH1cbiAgICAgICAgaWYgKGFjdGlvbnMpIGFjdGlvbnMuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICAgICAgc2V0U3RhdHVzVGV4dCgn0J3QsNCy0LXQtNC40YLQtSDQvdCwINC60L3QvtC/0LrRg+KApicpO1xuICAgIH0pO1xuICAgIGJ1aWxkQ2FsY1J1bGVzUGFuZWwoKTtcbiAgICBidWlsZFNjaGVkdWxlUGFuZWwoKTtcblxuICAgIG1ha2VNb3ZhYmxlKHdpbiwgaGVhZGVyKTtcbiAgICBtZW1jaGF0UGxhdGZvcm0uZGlhZ25vc3RpY3M/LmNsZWFuU2V0dGluZ3MoKTtcbn1cbiIsIi8vIOKUgOKUgOKUgCDQntCx0YDQsNCx0L7RgtGH0LjQutC4INGB0L7QsdGL0YLQuNC5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuY29uc3QgVEFCX0xBQkVMUyA9IHtcbiAgICBjaGVja0hhdGlrbzogJ/CfkLYgSGF0aWtvJyxcbiAgICBjaGVja0hhdGlrb0JvbnVzZXM6ICfwn46BINCR0L7QvdGD0YHRiycsXG4gICAgdG9kYXk6ICfwn5+iINCh0LXQs9C+0LTQvdGPJyxcbiAgICB0b21vcnJvdzogJ/Cfn6Eg0JfQsNCy0YLRgNCwJyxcbiAgICBoYWNrZXI6ICfwn5Cx4oCN8J+SuyDQpdCw0YLQuNC60L7QpdCw0LrQtdGAJyxcbiAgICBjYWxjdWxhdG9yOiAn8J+nriDQmtCw0LvRjNC60YPQu9GP0YLQvtGAJyxcbiAgICBjYWxjdWxhdG9yX3JldmVyc2U6ICfwn5SEINCg0LXQstC10YDRgScsXG4gICAgY2FsY3VsYXRvcl9kaXNjb3VudDogJ/Cfjokg0KHQutC40LTQutCwLysnLFxuICAgIGNhbGN1bGF0b3Jfc2ltcGxlOiAn4oiRINCf0YDQvtGB0YLQvtC5J1xufTtcblxuZnVuY3Rpb24gc2V0dXBFdmVudExpc3RlbmVycygpIHtcbiAgICBjb25zdCBjb250YWluZXIgPSB3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lcjtcblxuICAgIC8vINCf0LXRgNC10YLQsNGB0LrQuNCy0LDQvdC40LVcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0hlYWRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsIHN0YXJ0RHJhZyk7XG5cbiAgICAvLyBFbnRlciDQsiDQv9C+0LvQtSDQstCy0L7QtNCwIOKAlCDRgNCw0LHQvtGC0LDQtdGCINGC0L7Qu9GM0LrQviDQvdCwINGA0LXQttC40LzQvdGL0YUg0LLQutC70LDQtNC60LDRhVxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlwcmVzcycsIGUgPT4ge1xuICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicgJiYgY3VycmVudEFjdGlvbiAmJiBNT0RFX0FDVElPTlMuaW5jbHVkZXMoY3VycmVudEFjdGlvbikpIHtcbiAgICAgICAgICAgIGV4ZWN1dGVDdXJyZW50QWN0aW9uKCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrSW5wdXQnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZSA9PiB7XG4gICAgICAgIGlmIChlLmtleSA9PT0gJ0VzY2FwZScpIGUuY3VycmVudFRhcmdldC52YWx1ZSA9ICcnO1xuICAgIH0pO1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBlID0+IHtcbiAgICAgICAgaWYgKGUua2V5ID09PSAnRXNjYXBlJykge1xuICAgICAgICAgICAgY2xvc2VIYXRpa29Qcm9kdWN0UGlja2VyKCk7XG4gICAgICAgICAgICBjbG9zZU1lbWNoYXRPdmVybGF5KCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vINCa0LvQuNC6INC/0L4g0LLQutC70LDQtNC60LVcbiAgICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGFiXScpLmZvckVhY2godGFiID0+IHtcbiAgICAgICAgdGFiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gc2VsZWN0VGFiKHRhYi5kYXRhc2V0LnRhYikpO1xuICAgIH0pO1xuXG4gICAgLy8g0JrQu9C40LrQuCDQv9C+INC70LXQvdGC0LUgKNC60L3QvtC/0LrQuCDCq9Ca0L7Qv9C40YDQvtCy0LDRgtGMwrspXG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jQ2hhdExvZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaGFuZGxlQ2hhdExvZ0NsaWNrKTtcblxuICAgIC8vINCa0L3QvtC/0LrQsCDCq9Ce0YfQuNGB0YLQuNGC0YzCuyDigJQg0LDQutGC0LjQstC90YPRjiDQstC60LvQsNC00LrRg1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNDbGVhckNoYXRCdXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGNsZWFyQ2hhdCk7XG5cbiAgICAgICAgLy8g0JHRi9GB0YLRgNGL0LUg0LTQtdC50YHRgtCy0LjRjyDQuCDQvdCw0YHRgtGA0L7QudC60LggKNC90LjQttC90Y/RjyDQv9Cw0L3QtdC70YwpXG4gICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNDbGVhclRleHRUb2dnbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgICAgICBzZXRDbGVhclRleHRFbmFibGVkKCFjbGVhclRleHRFbmFibGVkKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jQWN0aW9uU2V0dGluZ3MnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIG9wZW5TZXR0aW5nc1dpbmRvdyk7XG5cbiAgICAgICAgICAgIC8vINCi0YPQu9GC0LjQv9GLIOKGkiDRgdGC0LDRgtGD0YEt0LHQsNGAICjRgtC10LrRgdGCINCy0L3QuNC30YMsINGA0Y/QtNC+0Lwg0YEg0LrQvdC+0L/QutCw0LzQuClcbiAgICAgICAgICAgICAgICBjb250YWluZXIuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VvdmVyJywgZSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGVsID0gZS50YXJnZXQuY2xvc2VzdD8uKCdbZGF0YS10aXBdJyk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlbCkgc2V0U3RhdHVzVGV4dChlbC5kYXRhc2V0LnRpcCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgY29udGFpbmVyLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlb3V0JywgZSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChlLnRhcmdldC5jbG9zZXN0Py4oJ1tkYXRhLXRpcF0nKSkgc2V0U3RhdHVzVGV4dCgn0J3QsNCy0LXQtNC40YLQtSDQvdCwINC60L3QvtC/0LrRg+KApicpO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgIC8vINCX0LDQutGA0YvRgtC40LVcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJpY2VDaGVja0Nsb3NlQnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHdpbmRvdy5wcmljZUNoZWNrQ29udGFpbmVyLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgfSk7XG5cbiAgICAvLyBIb3ZlciDRjdGE0YTQtdC60YIg0LrQvdC+0L/QutC4INC30LDQutGA0YvRgtC40Y9cbiAgICBjb25zdCBjbG9zZUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcmljZUNoZWNrQ2xvc2VCdXR0b24nKTtcbiAgICBjbG9zZUJ0bi5hZGRFdmVudExpc3RlbmVyKCdtb3VzZWVudGVyJywgKCkgPT4geyBjbG9zZUJ0bi5zdHlsZS5iYWNrZ3JvdW5kID0gJyNlZjQ0NDQnOyBjbG9zZUJ0bi5zdHlsZS5jb2xvciA9ICcjZmZmJzsgfSk7XG4gICAgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IHsgY2xvc2VCdG4uc3R5bGUuYmFja2dyb3VuZCA9ICcjZjFmNWY5JzsgY2xvc2VCdG4uc3R5bGUuY29sb3IgPSAnIzY0NzQ4Yic7IH0pO1xufVxuXG4vLyDilIDilIDilIAg0J/QtdGA0LXQutC70Y7Rh9C10L3QuNC1INCy0LrQu9Cw0LTQvtC6IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gc2VsZWN0VGFiKHRhYikge1xuICAgIGNvbnN0IHRhYnNFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1RhYnMnKTtcbiAgICB0YWJzRWwucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGFiXScpLmZvckVhY2godCA9PiB7XG4gICAgICAgIHQuY2xhc3NMaXN0LnRvZ2dsZSgnbWMtdGFiLWFjdGl2ZScsIHQuZGF0YXNldC50YWIgPT09IHRhYik7XG4gICAgfSk7XG5cbiAgICBjdXJyZW50QWN0aW9uID0gdGFiO1xuICAgIGlmIChNT0RFX0FDVElPTlMuaW5jbHVkZXModGFiKSkgc2F2ZVNlbGVjdGVkQWN0aW9uKHRhYik7XG4gICAgZGVidWdMb2coJ3RhYicsICdzZWxlY3RlZCcsIHRhYik7XG5cbiAgICAvLyDQndCw0LfQstCw0L3QuNC1INCy0LrQu9Cw0LTQutC4IOKAlCDQsiDQt9Cw0LPQvtC70L7QstC60LUg0L7QutC90LBcbiAgICAgICAgY29uc3QgdGl0bGVFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtZW1jaGF0VGFiVGl0bGUnKTtcbiAgICAgICAgaWYgKHRpdGxlRWwpIHRpdGxlRWwudGV4dENvbnRlbnQgPSBUQUJfTEFCRUxTW3RhYl0gfHwgdGFiO1xuXG4gICAgICAgIGNvbnN0IHNwZWNpYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNTcGVjaWFsUGFuZScpO1xuICAgICAgICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0lucHV0UmVnaW9uJyk7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1Jlc3VsdFJlZ2lvbicpO1xuICAgICAgICBjb25zdCBpc1NjaGVkdWxlID0gdGFiID09PSAndG9kYXknIHx8IHRhYiA9PT0gJ3RvbW9ycm93JztcbiAgICAgICAgY29uc3QgaXNTcGVjaWFsID0gaXNTY2hlZHVsZSB8fCB0YWIgPT09ICdoYWNrZXInO1xuICAgICAgICBpZiAoc3BlY2lhbCkgc3BlY2lhbC5zdHlsZS5kaXNwbGF5ID0gaXNTcGVjaWFsID8gJ2ZsZXgnIDogJ25vbmUnO1xuICAgICAgICBpZiAoaW5wdXQpIGlucHV0LnN0eWxlLmRpc3BsYXkgPSBpc1NwZWNpYWwgPyAnbm9uZScgOiAnYmxvY2snO1xuICAgICAgICBpZiAocmVzdWx0KSByZXN1bHQuc3R5bGUuZGlzcGxheSA9IGlzU3BlY2lhbCA/ICdub25lJyA6ICdmbGV4JztcbiAgICAgICAgaWYgKGlzU2NoZWR1bGUpIGZldGNoV2hvV29ya3ModGFiKTtcbiAgICAgICAgZWxzZSBpZiAodGFiID09PSAnaGFja2VyJykgcmVuZGVySGFja2VySW5saW5lVGFiKCk7XG4gICAgICAgIGVsc2UgcmVuZGVyQ2hhdCgpO1xuICAgIH1cblxuLy8g0JLQvtGB0YHRgtCw0L3QvtCy0LjRgtGMINC/0L7RgdC70LXQtNC90LjQuSDQstGL0LHRgNCw0L3QvdGL0Lkg0YDQtdC20LjQvCAo0YLQvtC70YzQutC+INGA0LXQttC40LzQvdGL0LUg0LLQutC70LDQtNC60LgpXG5mdW5jdGlvbiByZXN0b3JlU2VsZWN0ZWRBY3Rpb24oKSB7XG4gICAgY29uc3QgYWN0aW9uID0gbG9hZFNlbGVjdGVkQWN0aW9uKCk7XG4gICAgY29uc3QgdGFiID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgW2RhdGEtdGFiPVwiJHthY3Rpb259XCJdYClcbiAgICAgICAgfHwgZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGFiPVwiY2hlY2tIYXRpa29cIl0nKTtcbiAgICBpZiAodGFiKSBzZWxlY3RUYWIodGFiLmRhdGFzZXQudGFiKTtcbn1cblxuZnVuY3Rpb24gdG9nZ2xlUGFuZWwoaWQpIHtcbiAgICBjb25zdCBpZHMgPSBbJ2NhbGNTZXR0aW5nc1BhbmVsJywgJ3NjaGVkdWxlU2V0dGluZ3NQYW5lbCcsICdtc0ZpZWxkc1BhbmVsJ107XG4gICAgaWRzLmZvckVhY2gocGlkID0+IHtcbiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChwaWQpO1xuICAgICAgICBpZiAoIWVsKSByZXR1cm47XG4gICAgICAgIGVsLnN0eWxlLmRpc3BsYXkgPSAocGlkID09PSBpZCAmJiBlbC5zdHlsZS5kaXNwbGF5ID09PSAnbm9uZScpID8gJ2Jsb2NrJyA6ICdub25lJztcbiAgICB9KTtcbn1cblxuLy8g4pSA4pSA4pSAINCY0L3QuNGG0LjQsNC70LjQt9Cw0YbQuNGPIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gY2xvc2VDaGF0V2luZG93KCkge1xuICAgIGlmICh3aW5kb3cucHJpY2VDaGVja0NvbnRhaW5lcikgd2luZG93LnByaWNlQ2hlY2tDb250YWluZXIuc3R5bGUuZGlzcGxheSA9ICdub25lJztcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubWMtZmxvYXQtd2luZG93LCAubWMtb3ZlcmxheSwgI21jSGFja2VyUXVpY2tQb3B1cCwgI21jSGFja2VyQWdlbnRQb3B1cCwgI21jSGFja2VyRmxvYXRpbmdMb2cnKS5mb3JFYWNoKGVsID0+IGVsLnJlbW92ZSgpKTtcbn1cblxuZnVuY3Rpb24gaW5pdGlhbGl6ZSgpIHtcbiAgICBpbnN0YWxsRGVidWdIYW5kbGVycygpO1xuICAgIGxvYWRDYWxjUnVsZXMoKTtcbiAgICBsb2FkU2NoZWR1bGVSZXBsYWNlbWVudHMoKTtcbiAgICBsb2FkU2NoZWR1bGVDYWNoZUVuYWJsZWQoKTtcbiAgICBsb2FkQ2hhdEhpc3RvcnkoKTtcbiAgICBzZXR1cEdsb2JhbENsZWFyVGV4dEZ1bmN0aW9uYWxpdHkoKTtcbiAgICBsb2FkSGlkZGVuRmllbGRzKCk7XG4gICAgaWYgKGhpZGRlbkZpZWxkcy5sZW5ndGgpIHsgaGlkZGVuRmllbGRzID0gW107IHNhdmVIaWRkZW5GaWVsZHMoKTsgfVxuICAgIGxvYWRNc1F1aWNrUGFuZWxFbmFibGVkKCk7XG4gICAgcmV0cnlCZWhhdmlvciA9IGxvYWRSZXRyeUJlaGF2aW9yKCk7XG4gICAgaGFja2VyTG9hZFNldHRpbmdzKCk7XG4gICAgbG9hZE1zTWFnaWNDb25maWcoKTtcbiAgICB0cnkge1xuICAgICAgICBoYWNrZXJEZWZhdWx0Q2hhbm5lbCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlckRlZmF1bHRDaGFubmVsX3YxJykpIHx8ICcnO1xuICAgICAgICBoYWNrZXJRdWlja0J1dHRvbnNFbmFibGVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyUXVpY2tCdXR0b25zX3YxJykpICE9PSAnZmFsc2UnO1xuICAgIH0gY2F0Y2ggeyAvKiBkZWZhdWx0cyAqLyB9XG5cbiAgICBHTV9yZWdpc3Rlck1lbnVDb21tYW5kKCfQntGC0LrRgNGL0YLRjCDQvNC10LzQvdGL0Lkg0YfQsNGCJywgY3JlYXRlUHJpY2VDaGVja1dpbmRvdyk7XG4gICAgICAgIEdNX3JlZ2lzdGVyTWVudUNvbW1hbmQoJ9CX0LDQutGA0YvRgtGMINC80LXQvNC90YvQuSDRh9Cw0YInLCBjbG9zZUNoYXRXaW5kb3cpO1xuICAgICAgICBHTV9yZWdpc3Rlck1lbnVDb21tYW5kKCfQodCx0YDQvtGB0LjRgtGMINC/0L7Qu9C+0LbQtdC90LjQtSDQvtC60L7QvScsIHJlc2V0RmxvYXRXaW5kb3dQb3MpO1xuICAgICAgICBHTV9yZWdpc3Rlck1lbnVDb21tYW5kKCfQn9C10YDQtdC60LvRjtGH0LjRgtGMINC+0YLQu9Cw0LTQutGDINC80LXQvNC90L7Qs9C+INGH0LDRgtCwJywgdG9nZ2xlRGVidWdNb2RlKTtcbiAgICBkZWJ1Z0xvZygnaW5pdCcsICdpbml0aWFsaXplZCcpO1xuICAgIGNvbnNvbGUubG9nKCfQnNC10LzQvdGL0Lkg0YfQsNGCIHY4LjkuMC1hbHBoYS4xINC40L3QuNGG0LjQsNC70LjQt9C40YDQvtCy0LDQvScpO1xuXG4gICAgLy8g0J7QtNC40L0g0L3QsNCx0LvRjtC00LDRgtC10LvRjCDQvtCx0YHQu9GD0LbQuNCy0LDQtdGCINCy0YHQtSDQutC+0L3RgtC10LrRgdGC0L3Ri9C1INCy0YHRgtGA0L7QudC60Lgg0LggU1BBLdC/0LXRgNC10YXQvtC00YsuXG4gICAgaWYgKC9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIHtcbiAgICAgICAgcmVzdG9yZU1zRmllbGRzKCk7IC8vINC80LjQs9GA0LDRhtC40Y8g0YHQviDRgdGC0LDRgNC+0LPQviDRgNC10LbQuNC80LAg0LLRi9Cx0L7RgNC+0YfQvdC+0LPQviDRgdC60YDRi9GC0LjRj1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNNc1JldmVhbEJ0bicpPy5yZW1vdmUoKTtcbiAgICAgICAgc3RhcnRNc1NwYU9ic2VydmVyKCk7XG4gICAgICAgIGlmIChoYWNrZXJCZWFyZXJFbmFibGVkICYmIGhhY2tlckJlYXJlclRva2VuLnRyaW0oKSkgaGFja2VyVmFsaWRhdGVBcGlLZXkoKTtcbiAgICB9XG59IiwiLy8g4pSA4pSA4pSAINCl0LDRgtC40LrQvtCl0LDQutC10YAgKNCc0L7QudCh0LrQu9Cw0LQgQVBJKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCS0YHRgtGA0L7QtdC90L3Ri9C1INC4INC/0LvQsNCy0LDRjtGJ0LjQtSDQstC60LvQsNC00LrQuCDQpdCw0LrQtdGA0LAgKyDQutC+0L3RgdC+0LvRjC3Qu9C+0LMg0LLQvdC40LfRgy5cbi8vINCi0YDQsNC90YHQv9C+0YDRgjogR01feG1saHR0cFJlcXVlc3Qg4oaSIGh0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjIvXG4vLyDQkNCy0YLQvtGA0LjQt9Cw0YbQuNGPOiBCZWFyZXIt0LrQu9GO0Ycg0LjQtyDQvdCw0YHRgtGA0L7QtdC6ICjQv9C+INGD0LzQvtC70YfQsNC90LjRjiDQstGL0LrQuyDigJQg0YLQvtCz0LTQsCBjb29raWVzINGB0LXRgdGB0LjQuCkuXG5cbmNvbnN0IE1TX0FQSV9CQVNFID0gJ2h0dHBzOi8vYXBpLm1veXNrbGFkLnJ1L2FwaS9yZW1hcC8xLjInO1xuXG5sZXQgaGFja2VyVGFiICAgICAgICAgICAgPSAnc3RhdHVzJztcbmxldCBoYWNrZXJMb2dMaW5lcyAgICAgICA9IFtdO1xubGV0IGhhY2tlclN0YXRlcyAgICAgICAgID0gW107ICAvLyBbe25hbWUsIGhyZWZ9XSDigJQg0YHRgtCw0YLRg9GB0Ysg0LfQsNC60LDQt9C+0LIg0L/QvtC60YPQv9Cw0YLQtdC70LXQuVxubGV0IGhhY2tlclNhbGVzQ2hhbm5lbHMgID0gW107ICAvLyBbe25hbWUsIGhyZWZ9XVxubGV0IGhhY2tlck9yZGVySW5mbyAgICAgID0gbnVsbDtcbmxldCBoYWNrZXJMYXN0RGVtYW5kICAgICA9IG51bGw7XG5sZXQgaGFja2VyQ29udGV4dCAgICAgICAgPSB7IGN1c3RvbWVyT3JkZXJJZDogJycsIGRlbWFuZElkOiAnJyB9O1xubGV0IGhhY2tlckJ1c3kgICAgICAgICAgID0gZmFsc2U7XG5cbmNvbnN0IEhBQ0tFUl9BVFRSX0NMSUVOVF9TVEFUVVMgPSAn0KHRgtCw0YLRg9GBINC60LvQuNC10L3RgtCwJztcbmNvbnN0IEhBQ0tFUl9BVFRSX1BBWV9NRVRIT0QgICAgPSAn0KHQv9C+0YHQvtCxINC+0L/Qu9Cw0YLRiyc7XG5jb25zdCBIQUNLRVJfQVRUUl9QQVlfVFlQRSAgICAgID0gJ9Ci0LjQvyDQvtC/0LvQsNGC0YsnO1xuY29uc3QgSEFDS0VSX0NBU0hfUEFZX05BTUUgICAgICAgPSAn0J3QsNC70LjRh9C90YvQvNC4JztcblxuLy8g4pSA4pSA4pSAINCd0LDRgdGC0YDQvtC50LrQuCBBUEkt0LrQu9GO0YfQsCAobG9jYWxTdG9yYWdlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFJlbW90ZSBjaGFuZ2VzIHN0b3AgdGhpcyB0YWIsIG5ldmVyIG1pZ3JhdGUgaXRzIG9sZCB3b3JrIHRvIGEgbmV3IEJlYXJlci5cbmxldCBoYWNrZXJDcmVkZW50aWFsU2NvcGVCbG9ja2VkID0gZmFsc2U7XG5sZXQgbXNSZWZlcmVuY2VTY29wZSA9ICcnO1xubGV0IG1zUmVmZXJlbmNlQ2FjaGUgPSB7IGxpc3RzOiB7fSwgYXR0ZW1wdGVkOiBmYWxzZSwgZXJyb3JzOiB7fSB9O1xuY29uc3QgbXNSZWZlcmVuY2VSZXF1ZXN0cyA9IG5ldyBNYXAoKTtcbmxldCBoYWNrZXJWYWxpZGF0aW9uSW5GbGlnaHQgPSBudWxsO1xuXG5mdW5jdGlvbiBtc1JlZmVyZW5jZVJlc3RvcmUoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ21zUmVmZXJlbmNlQ2FjaGVfdjEnKSkgfHwgJ251bGwnKTtcbiAgICAgICAgY29uc3QgdmFsaWRMaXN0cyA9IHNhdmVkPy5saXN0cyAmJiAhQXJyYXkuaXNBcnJheShzYXZlZC5saXN0cykgJiYgdHlwZW9mIHNhdmVkLmxpc3RzID09PSAnb2JqZWN0J1xuICAgICAgICAgICAgJiYgT2JqZWN0LmVudHJpZXMoc2F2ZWQubGlzdHMpLmV2ZXJ5KChba2luZCwgaXRlbXNdKSA9PlxuICAgICAgICAgICAgICAgIFsnb3JnYW5pemF0aW9uJywgJ3N0b3JlJywgJ2N1c3RvbWVyb3JkZXInLCAnaW50ZXJuYWxvcmRlciddLmluY2x1ZGVzKGtpbmQpICYmIEFycmF5LmlzQXJyYXkoaXRlbXMpXG4gICAgICAgICAgICAgICAgJiYgaXRlbXMuZXZlcnkoaXRlbSA9PiBpdGVtICYmIHR5cGVvZiBpdGVtLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBpdGVtLmhyZWYgPT09ICdzdHJpbmcnKSk7XG4gICAgICAgIG1zUmVmZXJlbmNlQ2FjaGUgPSBzYXZlZD8udmVyc2lvbiA9PT0gMSAmJiBzYXZlZC5zY29wZSA9PT0gbXNSZWZlcmVuY2VTY29wZSAmJiB2YWxpZExpc3RzXG4gICAgICAgICAgICA/IHNhdmVkIDogeyBsaXN0czoge30sIGF0dGVtcHRlZDogZmFsc2UsIGVycm9yczoge30gfTtcbiAgICB9IGNhdGNoIHsgbXNSZWZlcmVuY2VDYWNoZSA9IHsgbGlzdHM6IHt9LCBhdHRlbXB0ZWQ6IGZhbHNlLCBlcnJvcnM6IHt9IH07IH1cbiAgICBpZiAobXNSZWZlcmVuY2VTY29wZSkge1xuICAgICAgICBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMgPSBtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLm9yZ2FuaXphdGlvbiB8fCBbXTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrV2FyZWhvdXNlcyA9IG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMuc3RvcmUgfHwgW107XG4gICAgICAgIGhhY2tlclN0YXRlcyA9IG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMuY3VzdG9tZXJvcmRlciB8fCBbXTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzZXMgPSB7XG4gICAgICAgICAgICBjdXN0b21lcm9yZGVyOiBoYWNrZXJTdGF0ZXMsXG4gICAgICAgICAgICBpbnRlcm5hbG9yZGVyOiBtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLmludGVybmFsb3JkZXIgfHwgW11cbiAgICAgICAgfTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIG1zUmVmZXJlbmNlU2F2ZSgpIHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdtc1JlZmVyZW5jZUNhY2hlX3YxJyksIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgLi4ubXNSZWZlcmVuY2VDYWNoZSwgdmVyc2lvbjogMSwgc2NvcGU6IG1zUmVmZXJlbmNlU2NvcGVcbiAgICB9KSk7XG59XG5cbmZ1bmN0aW9uIG1zUmVmZXJlbmNlRmlsbENvbnRyb2xzKCkge1xuICAgIGhhY2tlck5vdGlmaWVyRmlsbENvbnRyb2xzKCk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbE9yZ2FuaXphdGlvbnMoKTtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsV2FyZWhvdXNlcygpO1xuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxTdGF0dXNlcygnY3VzdG9tZXJvcmRlcicpO1xuICAgIGludGVybmFsT3JkZXJDaGVja0ZpbGxTdGF0dXNlcygnaW50ZXJuYWxvcmRlcicpO1xuICAgIGhhY2tlckZpbGxTZWxlY3QoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclN0YXRlU2VsZWN0JyksIGhhY2tlclN0YXRlcyk7XG59XG5cbmZ1bmN0aW9uIG1zUmVmZXJlbmNlQXNzZXJ0Q3VycmVudChzY29wZSwgZ2VuZXJhdGlvbikge1xuICAgIGlmIChzY29wZSAhPT0gbXNSZWZlcmVuY2VTY29wZSB8fCBnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24gfHwgIWhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfQl9Cw0LPRgNGD0LfQutCwINGB0L/RgNCw0LLQvtGH0L3QuNC60L7QsiDQvtGC0LzQtdC90LXQvdCwOiDQuNC30LzQtdC90LXQvdGLINGD0YfRkdGC0L3Ri9C1INC00LDQvdC90YvQtScpO1xuICAgIH1cbn1cblxuLy8gT25lIHJlcXVlc3QgcGVyIGVuZHBvaW50L2dlbmVyYXRpb24sIHNoYXJlZCBieSB2YWxpZGF0aW9uIGFuZCBib3RoIHNldHRpbmdzIHBhbmVzLlxuZnVuY3Rpb24gbXNSZWZlcmVuY2VGZXRjaChraW5kKSB7XG4gICAgY29uc3Qga2V5ID0gYCR7bXNBcGlHZW5lcmF0aW9ufToke2tpbmR9YDtcbiAgICBpZiAobXNSZWZlcmVuY2VSZXF1ZXN0cy5oYXMoa2V5KSkgcmV0dXJuIG1zUmVmZXJlbmNlUmVxdWVzdHMuZ2V0KGtleSk7XG4gICAgY29uc3Qgc2NvcGUgPSBtc1JlZmVyZW5jZVNjb3BlO1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgY29uc3QgcGF0aCA9IGtpbmQgPT09ICdvcmdhbml6YXRpb24nIHx8IGtpbmQgPT09ICdzdG9yZSdcbiAgICAgICAgPyBgL2VudGl0eS8ke2tpbmR9P29yZGVyPW5hbWUmbGltaXQ9MTAwMGAgOiBgL2VudGl0eS8ke2tpbmR9L21ldGFkYXRhYDtcbiAgICBjb25zdCByZXF1ZXN0ID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3Qgcm93cyA9IFtdO1xuICAgICAgICBjb25zdCB2aXNpdGVkID0gbmV3IFNldCgpO1xuICAgICAgICBsZXQgbmV4dCA9IHBhdGg7XG4gICAgICAgIGRvIHtcbiAgICAgICAgICAgIG1zUmVmZXJlbmNlQXNzZXJ0Q3VycmVudChzY29wZSwgZ2VuZXJhdGlvbik7XG4gICAgICAgICAgICBjb25zdCBub3JtYWxpemVkID0gaGFja2VyQXBpUGF0aChuZXh0KTtcbiAgICAgICAgICAgIGlmICghbm9ybWFsaXplZCB8fCB2aXNpdGVkLmhhcyhub3JtYWxpemVkKSkgdGhyb3cgbmV3IEVycm9yKCfQndC10LrQvtGA0YDQtdC60YLQvdCw0Y8g0L/QsNCz0LjQvdCw0YbQuNGPINGB0L/RgNCw0LLQvtGH0L3QuNC60LAnKTtcbiAgICAgICAgICAgIHZpc2l0ZWQuYWRkKG5vcm1hbGl6ZWQpO1xuICAgICAgICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG1zQXBpUCgnR0VUJywgbm9ybWFsaXplZCk7XG4gICAgICAgICAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgICAgICAgICAgY29uc3QgaXRlbXMgPSBraW5kID09PSAnb3JnYW5pemF0aW9uJyB8fCBraW5kID09PSAnc3RvcmUnXG4gICAgICAgICAgICAgICAgPyBkYXRhPy5yb3dzIDogKEFycmF5LmlzQXJyYXkoZGF0YT8uc3RhdGVzKSA/IGRhdGEuc3RhdGVzIDogZGF0YT8uc3RhdGVzPy5yb3dzKTtcbiAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShpdGVtcykpIHRocm93IG5ldyBFcnJvcign0J3QtdC60L7RgNGA0LXQutGC0L3Ri9C5INC+0YLQstC10YIg0YHQv9GA0LDQstC+0YfQvdC40LrQsCcpO1xuICAgICAgICAgICAgcm93cy5wdXNoKC4uLml0ZW1zLm1hcChpdGVtID0+ICh7IG5hbWU6IGl0ZW0ubmFtZSwgaHJlZjogaXRlbS5tZXRhPy5ocmVmLCBjb2xvcjogaXRlbS5jb2xvciB9KSlcbiAgICAgICAgICAgICAgICAuZmlsdGVyKGl0ZW0gPT4gaXRlbS5uYW1lICYmIGl0ZW0uaHJlZikpO1xuICAgICAgICAgICAgbmV4dCA9IGtpbmQgPT09ICdvcmdhbml6YXRpb24nIHx8IGtpbmQgPT09ICdzdG9yZScgPyBkYXRhPy5tZXRhPy5uZXh0SHJlZiA6ICcnO1xuICAgICAgICB9IHdoaWxlIChuZXh0KTtcbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfSkoKTtcbiAgICBtc1JlZmVyZW5jZVJlcXVlc3RzLnNldChrZXksIHJlcXVlc3QpO1xuICAgIHJlcXVlc3QuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGlmIChtc1JlZmVyZW5jZVJlcXVlc3RzLmdldChrZXkpID09PSByZXF1ZXN0KSBtc1JlZmVyZW5jZVJlcXVlc3RzLmRlbGV0ZShrZXkpO1xuICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZnVuY3Rpb24gbXNSZWZlcmVuY2VMb2FkKGtpbmQsIHsgZm9yY2UgPSBmYWxzZSwgc2VlZCB9ID0ge30pIHtcbiAgICBpZiAoIWZvcmNlICYmIE9iamVjdC5oYXNPd24obXNSZWZlcmVuY2VDYWNoZS5saXN0cywga2luZCkpIHJldHVybiBQcm9taXNlLnJlc29sdmUobXNSZWZlcmVuY2VDYWNoZS5saXN0c1traW5kXSk7XG4gICAgY29uc3Qgc2NvcGUgPSBtc1JlZmVyZW5jZVNjb3BlO1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgcmV0dXJuIChzZWVkID8gUHJvbWlzZS5yZXNvbHZlKHNlZWQpIDogbXNSZWZlcmVuY2VGZXRjaChraW5kKSkudGhlbihpdGVtcyA9PiB7XG4gICAgICAgIG1zUmVmZXJlbmNlQXNzZXJ0Q3VycmVudChzY29wZSwgZ2VuZXJhdGlvbik7XG4gICAgICAgIG1zUmVmZXJlbmNlQ2FjaGUubGlzdHNba2luZF0gPSBpdGVtcztcbiAgICAgICAgbXNSZWZlcmVuY2VTYXZlKCk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucyA9IG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMub3JnYW5pemF0aW9uIHx8IFtdO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tXYXJlaG91c2VzID0gbXNSZWZlcmVuY2VDYWNoZS5saXN0cy5zdG9yZSB8fCBbXTtcbiAgICAgICAgaGFja2VyU3RhdGVzID0gbXNSZWZlcmVuY2VDYWNoZS5saXN0cy5jdXN0b21lcm9yZGVyIHx8IFtdO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlcy5jdXN0b21lcm9yZGVyID0gaGFja2VyU3RhdGVzO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlcy5pbnRlcm5hbG9yZGVyID0gbXNSZWZlcmVuY2VDYWNoZS5saXN0cy5pbnRlcm5hbG9yZGVyIHx8IFtdO1xuICAgICAgICBtc1JlZmVyZW5jZUZpbGxDb250cm9scygpO1xuICAgICAgICByZXR1cm4gaXRlbXM7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIG1zUmVmZXJlbmNlU2hvd1N0YXR1cyhzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VySW50ZXJuYWxPcmRlclNldHRpbmdzU3RhdHVzJykpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnJlZmVyZW5jZXM/LnNob3dTdGF0dXMpIHJldHVybiBtZW1jaGF0UGxhdGZvcm0ucmVmZXJlbmNlcy5zaG93U3RhdHVzKHN0YXR1cyk7XG4gICAgY29uc3QgbGFiZWxzID0geyBvcmdhbml6YXRpb246ICfQntGA0LPQsNC90LjQt9Cw0YbQuNC4Jywgc3RvcmU6ICfQodC60LvQsNC00YsnLCBjdXN0b21lcm9yZGVyOiAn0KHRgtCw0YLRg9GB0Ysg0LfQsNC60LDQt9C+0LInLCBpbnRlcm5hbG9yZGVyOiAn0KHRgtCw0YLRg9GB0Ysg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LInIH07XG4gICAgY29uc3QgZXJyb3JzID0gT2JqZWN0LmVudHJpZXMobXNSZWZlcmVuY2VDYWNoZS5lcnJvcnMgfHwge30pO1xuICAgIC8vIGF0dGVtcHRlZCBzdXBwcmVzc2VzIGF1dG9tYXRpYyByZXRyaWVzOyBvbmx5IHByZXNlbnQgbGlzdHMgcHJvdmUgY29tcGxldGVuZXNzLlxuICAgIC8vIEEgc3VjY2Vzc2Z1bCBlbXB0eSBhcnJheSBpcyBwcmVzZW50LCB1bmxpa2UgYSByZXF1ZXN0IGludGVycnVwdGVkIGJ5IHRhYiBjbG9zZS5cbiAgICBjb25zdCBtaXNzaW5nID0gT2JqZWN0LmtleXMobGFiZWxzKS5maWx0ZXIoa2luZCA9PiAhT2JqZWN0Lmhhc093bihtc1JlZmVyZW5jZUNhY2hlLmxpc3RzLCBraW5kKSk7XG4gICAgY29uc3Qgd2FybmluZ3MgPSBbXTtcbiAgICBpZiAoZXJyb3JzLmxlbmd0aCkgd2FybmluZ3MucHVzaCgn4pqgINCd0LUg0L7QsdC90L7QstC70LXQvdGLOiAnICsgZXJyb3JzLm1hcCgoW2tpbmQsIG1lc3NhZ2VdKSA9PiBgJHtsYWJlbHNba2luZF19IOKAlCAke21lc3NhZ2V9YCkuam9pbignOyAnKSk7XG4gICAgaWYgKG1pc3NpbmcubGVuZ3RoICYmIChtc1JlZmVyZW5jZUNhY2hlLmF0dGVtcHRlZCB8fCBPYmplY3Qua2V5cyhtc1JlZmVyZW5jZUNhY2hlLmxpc3RzKS5sZW5ndGgpKSB7XG4gICAgICAgIHdhcm5pbmdzLnB1c2goJ+KaoCDQndC1INC30LDQs9GA0YPQttC10L3RizogJyArIG1pc3NpbmcubWFwKGtpbmQgPT4gbGFiZWxzW2tpbmRdKS5qb2luKCc7ICcpICsgJy4g0J3QsNC20LzQuNGC0LUgwqvQl9Cw0LPRgNGD0LfQuNGC0Ywg0YHQv9GA0LDQstC+0YfQvdC40LrQuMK7Jyk7XG4gICAgfVxuICAgIGNvbnN0IG1lc3NhZ2UgPSB3YXJuaW5ncy5qb2luKCcuICcpIHx8IChtaXNzaW5nLmxlbmd0aCA/ICcnIDogJ9Ch0L/RgNCw0LLQvtGH0L3QuNC60Lgg0LfQsNCz0YDRg9C20LXQvdGLJyk7XG4gICAgaWYgKHN0YXR1cykge1xuICAgICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICAgICAgICBzdGF0dXMuc3R5bGUuY29sb3IgPSB3YXJuaW5ncy5sZW5ndGggPyAnI2I5MWMxYycgOiAnIzE2NjUzNCc7XG4gICAgfVxuICAgIGlmICh3YXJuaW5ncy5sZW5ndGgpIGhhY2tlck5vdGlmaWVyU2V0U3RhdHVzKG1lc3NhZ2UsICdlcnJvcicpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtc1JlZmVyZW5jZVJlZnJlc2goeyBmb3JjZSA9IGZhbHNlLCBzdGF0ZXMsIHN0YXR1cyB9ID0ge30pIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLnJlZmVyZW5jZXM/LnJlZnJlc2gpIHJldHVybiBtZW1jaGF0UGxhdGZvcm0ucmVmZXJlbmNlcy5yZWZyZXNoKHsgZm9yY2UsIHN0YXRlcywgc3RhdHVzIH0pO1xuICAgIG1zUmVmZXJlbmNlQ2FjaGUuYXR0ZW1wdGVkID0gdHJ1ZTtcbiAgICBjb25zdCBzY29wZSA9IG1zUmVmZXJlbmNlU2NvcGU7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBjb25zdCBraW5kcyA9IFsnb3JnYW5pemF0aW9uJywgJ3N0b3JlJywgJ2N1c3RvbWVyb3JkZXInLCAnaW50ZXJuYWxvcmRlciddO1xuICAgIGNvbnN0IG91dGNvbWVzID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKGtpbmRzLm1hcChraW5kID0+IG1zUmVmZXJlbmNlTG9hZChraW5kLFxuICAgICAgICB7IGZvcmNlLCBzZWVkOiBraW5kID09PSAnY3VzdG9tZXJvcmRlcicgPyBzdGF0ZXMgOiB1bmRlZmluZWQgfSkpKTtcbiAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgIG1zUmVmZXJlbmNlQ2FjaGUuZXJyb3JzID0gT2JqZWN0LmZyb21FbnRyaWVzKG91dGNvbWVzLmZsYXRNYXAoKG91dGNvbWUsIGluZGV4KSA9PlxuICAgICAgICBvdXRjb21lLnN0YXR1cyA9PT0gJ3JlamVjdGVkJyA/IFtba2luZHNbaW5kZXhdLCBvdXRjb21lLnJlYXNvbi5zdGF0dXNcbiAgICAgICAgICAgID8gYEhUVFAgJHtvdXRjb21lLnJlYXNvbi5zdGF0dXN9YCA6ICfQvtGI0LjQsdC60LAg0LfQsNCz0YDRg9C30LrQuDsg0L/QvtCy0YLQvtGA0LjRgtC1INCy0YDRg9GH0L3Rg9GOJ11dIDogW10pKTtcbiAgICBtc1JlZmVyZW5jZVNhdmUoKTtcbiAgICBtc1JlZmVyZW5jZVNob3dTdGF0dXMoc3RhdHVzKTtcbiAgICByZXR1cm4geyBvazogT2JqZWN0LmtleXMobXNSZWZlcmVuY2VDYWNoZS5lcnJvcnMpLmxlbmd0aCA9PT0gMCwgZXJyb3JzOiBtc1JlZmVyZW5jZUNhY2hlLmVycm9ycyB9O1xufVxuXG5mdW5jdGlvbiBtc1JlZmVyZW5jZUJvb3RzdHJhcChzdGF0ZXMpIHtcbiAgICBjb25zdCBzY29wZSA9IG1zUmVmZXJlbmNlU2NvcGU7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBjb25zdCBib290c3RyYXAgPSAoKSA9PiB7XG4gICAgICAgIG1zUmVmZXJlbmNlQXNzZXJ0Q3VycmVudChzY29wZSwgZ2VuZXJhdGlvbik7XG4gICAgICAgIC8vIEFub3RoZXIgc2FtZS1vcmlnaW4gdGFiIG1heSBoYXZlIGNvbXBsZXRlZCB3aGlsZSB0aGlzIG9uZSB3YWl0ZWQuXG4gICAgICAgIG1zUmVmZXJlbmNlUmVzdG9yZSgpO1xuICAgICAgICBpZiAoIW1zUmVmZXJlbmNlQ2FjaGUuYXR0ZW1wdGVkKSByZXR1cm4gbXNSZWZlcmVuY2VSZWZyZXNoKHsgc3RhdGVzIH0pO1xuICAgICAgICBtc1JlZmVyZW5jZUZpbGxDb250cm9scygpO1xuICAgICAgICBtc1JlZmVyZW5jZVNob3dTdGF0dXMoKTtcbiAgICB9O1xuICAgIHJldHVybiBuYXZpZ2F0b3IubG9ja3M/LnJlcXVlc3RcbiAgICAgICAgPyBuYXZpZ2F0b3IubG9ja3MucmVxdWVzdChzdG9yYWdlS2V5KCdtc1JlZmVyZW5jZUJvb3RzdHJhcF92MTonKSArIHNjb3BlLCBib290c3RyYXApXG4gICAgICAgIDogUHJvbWlzZS5yZXNvbHZlKCkudGhlbihib290c3RyYXApO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJMb2FkU2V0dGluZ3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcyA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyTXNBcGlfdjEnKSkgfHwgJ3t9Jyk7XG4gICAgICAgIGhhY2tlckJlYXJlckVuYWJsZWQgPSAhIXMuYmVhcmVyRW5hYmxlZDtcbiAgICAgICAgaGFja2VyQmVhcmVyVG9rZW4gPSB0eXBlb2Ygcy50b2tlbiA9PT0gJ3N0cmluZycgPyBzLnRva2VuIDogJyc7XG4gICAgICAgIG1zUmVmZXJlbmNlU2NvcGUgPSBzLnJlZmVyZW5jZVNjb3BlIHx8IChoYWNrZXJCZWFyZXJUb2tlbiA/IGNyeXB0by5yYW5kb21VVUlEKCkgOiAnJyk7XG4gICAgICAgIGlmIChtc1JlZmVyZW5jZVNjb3BlICYmICFzLnJlZmVyZW5jZVNjb3BlKSB7XG4gICAgICAgICAgICAvLyBCaW5kIHByZS11cGdyYWRlIGNob2ljZXMgb25seSB0byB0aGUgY3JlZGVudGlhbHMgYWxyZWFkeSBvbiBkaXNrLlxuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgWydoYWNrZXJPcmRlck5vdGlmaWVyX3YxJywgSU5URVJOQUxfT1JERVJfQ0hFQ0tfU1RPUkFHRV9LRVldKSB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KGtleSkpIHx8ICdudWxsJyk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyYXcgJiYgIXJhdy5yZWZlcmVuY2VTY29wZSkgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleShrZXkpLCBKU09OLnN0cmluZ2lmeSh7IC4uLnJhdywgcmVmZXJlbmNlU2NvcGU6IG1zUmVmZXJlbmNlU2NvcGUgfSkpO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBJbnZhbGlkIG9sZCBzZXR0aW5ncyBhcmUgaGFuZGxlZCBieSB0aGVpciBvd24gbG9hZGVyLiAqLyB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBoYWNrZXJTYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgICBoYWNrZXJCZWFyZXJFbmFibGVkID0gZmFsc2U7XG4gICAgICAgIGhhY2tlckJlYXJlclRva2VuID0gJyc7XG4gICAgICAgIG1zUmVmZXJlbmNlU2NvcGUgPSAnJztcbiAgICB9XG4gICAgaGFja2VyQ3JlZGVudGlhbFNjb3BlQmxvY2tlZCA9IGZhbHNlO1xuICAgIGhhY2tlckxvYWRDYWNoZWRTdGF0ZXMoKTtcbiAgICBoYWNrZXJOb3RpZmllckxvYWRTZXR0aW5ncygpO1xuICAgIGludGVybmFsT3JkZXJDaGVja0xvYWRTZXR0aW5ncygpO1xuICAgIG1zUmVmZXJlbmNlUmVzdG9yZSgpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJMb2FkQ2FjaGVkU3RhdGVzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNhdmVkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJTdGF0ZXNfdjEnKSkgfHwgJ1tdJyk7XG4gICAgICAgIGhhY2tlclN0YXRlcyA9IEFycmF5LmlzQXJyYXkoc2F2ZWQpXG4gICAgICAgICAgICA/IHNhdmVkLmZpbHRlcihzdGF0ZSA9PiBzdGF0ZSAmJiB0eXBlb2Ygc3RhdGUubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIHN0YXRlLmhyZWYgPT09ICdzdHJpbmcnICYmIHN0YXRlLm5hbWUgJiYgc3RhdGUuaHJlZilcbiAgICAgICAgICAgICAgICAubWFwKHN0YXRlID0+ICh7IG5hbWU6IHN0YXRlLm5hbWUsIGhyZWY6IHN0YXRlLmhyZWYsIGNvbG9yOiBzdGF0ZS5jb2xvciB9KSlcbiAgICAgICAgICAgIDogW107XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaGFja2VyU3RhdGVzID0gW107XG4gICAgICAgIGRlYnVnRXJyb3IoJ2hhY2tlcicsICfQndC1INGD0LTQsNC70L7RgdGMINC30LDQs9GA0YPQt9C40YLRjCDQutGN0Ygg0YHRgtCw0YLRg9GB0L7QsicsIGVycm9yKTtcbiAgICB9XG4gICAgcmV0dXJuIGhhY2tlclN0YXRlcztcbn1cblxuZnVuY3Rpb24gaGFja2VyU2F2ZVN0YXRlcygpIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJTdGF0ZXNfdjEnKSwgSlNPTi5zdHJpbmdpZnkoaGFja2VyU3RhdGVzKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignaGFja2VyJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC60Y3RiCDRgdGC0LDRgtGD0YHQvtCyJywgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyU2F2ZVNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck1zQXBpX3YxJyksIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIGJlYXJlckVuYWJsZWQ6IGhhY2tlckJlYXJlckVuYWJsZWQsXG4gICAgICAgICAgICB0b2tlbjogaGFja2VyQmVhcmVyVG9rZW4sXG4gICAgICAgICAgICByZWZlcmVuY2VTY29wZTogbXNSZWZlcmVuY2VTY29wZVxuICAgICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignaGFja2VyJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC90LDRgdGC0YDQvtC50LrQuCBBUEknLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJDaGVja0NyZWRlbnRpYWxTY29wZSgpIHtcbiAgICBpZiAoaGFja2VyQ3JlZGVudGlhbFNjb3BlQmxvY2tlZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCBtYXRjaGVzID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck1zQXBpX3YxJykpIHx8ICd7fScpO1xuICAgICAgICBtYXRjaGVzID0gISFzYXZlZC5iZWFyZXJFbmFibGVkID09PSBoYWNrZXJCZWFyZXJFbmFibGVkXG4gICAgICAgICAgICAmJiAodHlwZW9mIHNhdmVkLnRva2VuID09PSAnc3RyaW5nJyA/IHNhdmVkLnRva2VuIDogJycpID09PSBoYWNrZXJCZWFyZXJUb2tlbjtcbiAgICB9IGNhdGNoIHsgLyogVW5yZWFkYWJsZS9yZW1vdmVkIGNyZWRlbnRpYWxzIGZhaWwgY2xvc2VkLiAqLyB9XG4gICAgaWYgKG1hdGNoZXMpIHJldHVybiB0cnVlO1xuICAgIGhhY2tlckNyZWRlbnRpYWxTY29wZUJsb2NrZWQgPSB0cnVlO1xuICAgIGhhY2tlckFwaVZhbGlkYXRlZCA9IGZhbHNlO1xuICAgIG1zQXBpQ2FuY2VsQWxsKCk7XG4gICAgaGFja2VyVXBkYXRlQmVhcmVyU3RhdHVzKCfigJQnLCAn0L3QsNGB0YLRgNC+0LnQutC4INC40LfQvNC10L3QtdC90Ysg0LIg0LTRgNGD0LPQvtC5INCy0LrQu9Cw0LTQutC1OyDQv9C+0LTRgtCy0LXRgNC00LjRgtC1INC60LvRjtGHJyk7XG4gICAgaGFja2VyU3luY0FjY2Vzc1VpKCk7XG4gICAgcmV0dXJuIGZhbHNlO1xufVxuXG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignc3RvcmFnZScsIGV2ZW50ID0+IHtcbiAgICAvLyBCcm93c2VyIG9yaWdpbiBpc29sYXRpb24gcGx1cyBzdG9yYWdlS2V5IGtlZXBzIERFVi9wcm9kdWN0aW9uIHNlcGFyYXRlLlxuICAgIC8vIFJlYWQgY3VycmVudCBzdG9yYWdlLCBub3QgdGhlIGV2ZW50IHBheWxvYWQ7IGlnbm9yZSBzZXNzaW9uU3RvcmFnZS5cbiAgICBpZiAoZXZlbnQuc3RvcmFnZUFyZWEgJiYgZXZlbnQuc3RvcmFnZUFyZWEgIT09IGxvY2FsU3RvcmFnZSkgcmV0dXJuO1xuICAgIGlmIChldmVudC5rZXkgIT09IG51bGwgJiYgZXZlbnQua2V5ICE9PSBzdG9yYWdlS2V5KCdoYWNrZXJNc0FwaV92MScpKSByZXR1cm47XG4gICAgaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKTtcbn0pO1xuXG4vLyDQktGL0LfRi9Cy0LDQtdGC0YHRjyDQuNC3INC+0LrQvdCwINC90LDRgdGC0YDQvtC10LogKDA5KVxuZnVuY3Rpb24gaGFja2VyU2V0QmVhcmVyRW5hYmxlZChlbmFibGVkKSB7XG4gICAgaWYgKGhhY2tlckJlYXJlckVuYWJsZWQgIT09ICEhZW5hYmxlZCkgbXNBcGlDYW5jZWxBbGwoKTtcbiAgICBoYWNrZXJCZWFyZXJFbmFibGVkID0gISFlbmFibGVkO1xuICAgIGhhY2tlckFwaVZhbGlkYXRlZCA9IGZhbHNlO1xuICAgIGhhY2tlclNhdmVTZXR0aW5ncygpO1xuICAgIGhhY2tlckNyZWRlbnRpYWxTY29wZUJsb2NrZWQgPSBmYWxzZTtcbiAgICBjb25zdCBpbnAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbXNCZWFyZXJUb2tlbicpO1xuICAgIGlmIChpbnApIGlucC5zdHlsZS5kaXNwbGF5ID0gaGFja2VyQmVhcmVyRW5hYmxlZCA/ICdibG9jaycgOiAnbm9uZSc7XG4gICAgaGFja2VyU3luY0FjY2Vzc1VpKCk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclN5bmNBY2Nlc3NVaSgpIHtcbiAgICBtZW1jaGF0UGxhdGZvcm0ub25BY2Nlc3NVaT8uKCk7XG4gICAgY29uc3QgYWxsb3dlZCA9IGhhY2tlckJlYXJlckVuYWJsZWQgJiYgISFoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkgJiYgaGFja2VyQXBpVmFsaWRhdGVkO1xuICAgIGNvbnN0IHRhYiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJyNtY1RhYnMgW2RhdGEtdGFiPVwiaGFja2VyXCJdJyk7XG4gICAgaWYgKHRhYikgdGFiLmhpZGRlbiA9ICFhbGxvd2VkO1xuICAgIGlmICghYWxsb3dlZCAmJiBjdXJyZW50QWN0aW9uID09PSAnaGFja2VyJyAmJiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNUYWJzJykpIHtcbiAgICAgICAgc2VsZWN0VGFiKCdjaGVja0hhdGlrbycpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHJlY29uY2lsZU1zRW5oYW5jZW1lbnRzID09PSAnZnVuY3Rpb24nKSByZWNvbmNpbGVNc0VuaGFuY2VtZW50cygpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJVcGRhdGVCZWFyZXJTdGF0dXMoY29kZSwgdGV4dCkge1xuICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21lbWNoYXRCZWFyZXJTdGF0dXMnKTtcbiAgICBpZiAoIWVsKSByZXR1cm47XG4gICAgZWwudGV4dENvbnRlbnQgPSBoYWNrZXJCZWFyZXJFbmFibGVkID8gYEJlYXJlcjogJHtjb2RlfSR7dGV4dCA/IGAg4oCUICR7dGV4dH1gIDogJyd9YCA6ICcnO1xuICAgIGVsLnN0eWxlLmNvbG9yID0gY29kZSA+PSAyMDAgJiYgY29kZSA8IDMwMCA/ICcjMTZhMzRhJyA6ICcjZGMyNjI2Jztcbn1cblxuZnVuY3Rpb24gaGFja2VyVmFsaWRhdGVBcGlLZXkob25Eb25lKSB7XG4gICAgaWYgKCFoYWNrZXJDaGVja0NyZWRlbnRpYWxTY29wZSgpIHx8ICFoYWNrZXJCZWFyZXJFbmFibGVkIHx8ICFoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkpIHtcbiAgICAgICAgaGFja2VyQXBpVmFsaWRhdGVkID0gZmFsc2U7XG4gICAgICAgIGhhY2tlclVwZGF0ZUJlYXJlclN0YXR1cygn4oCUJywgJ9Cy0YvQutC7Jyk7XG4gICAgICAgIGhhY2tlclN5bmNBY2Nlc3NVaSgpO1xuICAgICAgICBvbkRvbmU/LihmYWxzZSk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgIH1cbiAgICBpZiAoaGFja2VyVmFsaWRhdGlvbkluRmxpZ2h0Py5nZW5lcmF0aW9uID09PSBtc0FwaUdlbmVyYXRpb24pIHtcbiAgICAgICAgcmV0dXJuIGhhY2tlclZhbGlkYXRpb25JbkZsaWdodC5wcm9taXNlLnRoZW4ob2sgPT4geyBvbkRvbmU/Lihvayk7IHJldHVybiBvazsgfSk7XG4gICAgfVxuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgY29uc3Qgc2NvcGUgPSBtc1JlZmVyZW5jZVNjb3BlO1xuICAgIGNvbnN0IHByb21pc2UgPSBtc1JlZmVyZW5jZUZldGNoKCdjdXN0b21lcm9yZGVyJykudGhlbihhc3luYyBzdGF0ZXMgPT4ge1xuICAgICAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgICAgICBoYWNrZXJBcGlWYWxpZGF0ZWQgPSB0cnVlO1xuICAgICAgICBoYWNrZXJVcGRhdGVCZWFyZXJTdGF0dXMoMjAwLCAn0LLQsNC70LjQtNC10L0nKTtcbiAgICAgICAgaGFja2VyU3luY0FjY2Vzc1VpKCk7XG4gICAgICAgIG9uRG9uZT8uKHRydWUpO1xuICAgICAgICBhd2FpdCBtc1JlZmVyZW5jZUJvb3RzdHJhcChzdGF0ZXMpO1xuICAgICAgICBtc1JlZmVyZW5jZUFzc2VydEN1cnJlbnQoc2NvcGUsIGdlbmVyYXRpb24pO1xuICAgICAgICBoYWNrZXJOb3RpZmllck1heWJlU3RhcnQoKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGhhY2tlckFwaVZhbGlkYXRlZCA9IGZhbHNlO1xuICAgICAgICBoYWNrZXJOb3RpZmllclN0b3AoKTtcbiAgICAgICAgaGFja2VyVXBkYXRlQmVhcmVyU3RhdHVzKGVycm9yPy5zdGF0dXMgfHwgNDAxLCAn0L7RiNC40LHQutCwJyk7XG4gICAgICAgIGhhY2tlclN5bmNBY2Nlc3NVaSgpO1xuICAgICAgICBvbkRvbmU/LihmYWxzZSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9KS5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgaWYgKGhhY2tlclZhbGlkYXRpb25JbkZsaWdodD8ucHJvbWlzZSA9PT0gcHJvbWlzZSkgaGFja2VyVmFsaWRhdGlvbkluRmxpZ2h0ID0gbnVsbDtcbiAgICB9KTtcbiAgICBoYWNrZXJWYWxpZGF0aW9uSW5GbGlnaHQgPSB7IGdlbmVyYXRpb24sIHByb21pc2UgfTtcbiAgICByZXR1cm4gcHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQ2FuUnVuKG9uRGVuaWVkKSB7XG4gICAgaWYgKCFoYWNrZXJCZWFyZXJFbmFibGVkIHx8ICFoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkgfHwgIWhhY2tlckFwaVZhbGlkYXRlZCkge1xuICAgICAgICBoYWNrZXJWYWxpZGF0ZUFwaUtleShvayA9PiB7XG4gICAgICAgICAgICBpZiAoIW9rKSB7XG4gICAgICAgICAgICAgICAgaGFja2VyTG9nKCfQktC60LvRjtGH0LjRgtC1IEJlYXJlciDQuCDRg9C60LDQttC40YLQtSDQtNC10LnRgdGC0LLRg9GO0YnQuNC5IEFQSS3QutC70Y7RhyDQnNC+0LnQodC60LvQsNC0JywgJ3dhcm4nKTtcbiAgICAgICAgICAgICAgICBvbkRlbmllZD8uKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJTZXRCZWFyZXJUb2tlbih2YWx1ZSkge1xuICAgIGNvbnN0IGNoYW5nZWQgPSBoYWNrZXJCZWFyZXJUb2tlbiAhPT0gU3RyaW5nKHZhbHVlIHx8ICcnKTtcbiAgICBpZiAoY2hhbmdlZCkgbXNBcGlDYW5jZWxBbGwoKTtcbiAgICBoYWNrZXJCZWFyZXJUb2tlbiA9IFN0cmluZyh2YWx1ZSB8fCAnJyk7XG4gICAgaWYgKGNoYW5nZWQpIG1zUmVmZXJlbmNlU2NvcGUgPSBoYWNrZXJCZWFyZXJUb2tlbiA/IGNyeXB0by5yYW5kb21VVUlEKCkgOiAnJztcbiAgICBoYWNrZXJBcGlWYWxpZGF0ZWQgPSBmYWxzZTtcbiAgICBoYWNrZXJTYXZlU2V0dGluZ3MoKTtcbiAgICBoYWNrZXJDcmVkZW50aWFsU2NvcGVCbG9ja2VkID0gZmFsc2U7XG4gICAgaWYgKGNoYW5nZWQpIHtcbiAgICAgICAgbXNSZWZlcmVuY2VSZXN0b3JlKCk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyTG9hZFNldHRpbmdzKCk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja0xvYWRTZXR0aW5ncygpO1xuICAgICAgICBtc1JlZmVyZW5jZUZpbGxDb250cm9scygpO1xuICAgIH1cbiAgICBoYWNrZXJTeW5jQWNjZXNzVWkoKTtcbn1cblxuLy8g4pSA4pSA4pSAINCi0YDQsNC90YHQv9C+0YDRgiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhhY2tlckVuc3VyZUJlYXJlcigpIHtcbiAgICBpZiAoIWhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCkpIHRocm93IG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvTog0L/QvtC00YLQstC10YDQtNC40YLQtSBBUEkt0LrQu9GO0Ycg0LIg0Y3RgtC+0Lkg0LLQutC70LDQtNC60LUnKTtcbiAgICBpZiAoIWhhY2tlckJlYXJlckVuYWJsZWQgfHwgIWhhY2tlckJlYXJlclRva2VuLnRyaW0oKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ9CS0LrQu9GO0YfQuNGC0LUgQmVhcmVyINC4INGD0LrQsNC20LjRgtC1IEFQSS3QutC70Y7RhyDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgfVxufVxuXG5jb25zdCBNU19BUElfTUFYX0NPTkNVUlJFTlRfUkVRVUVTVFMgPSAyO1xuY29uc3QgTVNfQVBJX1JBVEVfU0FGRVRZX0ZBQ1RPUiA9IDEuMjtcbmNvbnN0IG1zQXBpUmVxdWVzdFF1ZXVlID0gW107XG5jb25zdCBtc0FwaVJhdGVMaW1pdFN0YXRlID0ge1xuICAgIGxpbWl0OiBudWxsLFxuICAgIHJlbWFpbmluZzogbnVsbCxcbiAgICBpbnRlcnZhbE1zOiBudWxsLFxuICAgIHJlc2V0TXM6IG51bGwsXG4gICAgcmV0cnlBZnRlck1zOiBudWxsLFxuICAgIHVwZGF0ZWRBdDogbnVsbCxcbiAgICBwYXJhbGxlbExpbWl0RXJyb3JzOiAwXG59O1xubGV0IG1zQXBpSW5GbGlnaHQgPSAwO1xubGV0IG1zQXBpTmV4dFJlcXVlc3RBdCA9IDA7XG5sZXQgbXNBcGlCbG9ja2VkVW50aWwgPSAwO1xubGV0IG1zQXBpUGFyYWxsZWxDb29sZG93blVudGlsID0gMDtcbmxldCBtc0FwaVF1ZXVlVGltZXIgPSBudWxsO1xuXG5sZXQgbXNBcGlHZW5lcmF0aW9uID0gMDtcbmNvbnN0IG1zQXBpVGFza3MgPSBuZXcgU2V0KCk7XG5cbmZ1bmN0aW9uIG1zQXBpQ2FuY2VsQWxsKCkge1xuICAgIG1zQXBpR2VuZXJhdGlvbisrO1xuICAgIGhhY2tlck5vdGlmaWVyU3RvcCgpO1xuICAgIFsuLi5tc0FwaVRhc2tzXS5mb3JFYWNoKHRhc2sgPT4gdGFzay5jYW5jZWwoKSk7XG59XG5cbmZ1bmN0aW9uIG1zQXBpR2V0TGltaXRTdGF0cygpIHtcbiAgICByZXR1cm4geyAuLi5tc0FwaVJhdGVMaW1pdFN0YXRlLCBpbkZsaWdodDogbXNBcGlJbkZsaWdodCwgcXVldWVkOiBtc0FwaVJlcXVlc3RRdWV1ZS5sZW5ndGggfTtcbn1cblxuZnVuY3Rpb24gbXNBcGlQYXJzZVJlc3BvbnNlSGVhZGVycyhyYXdIZWFkZXJzKSB7XG4gICAgY29uc3QgaGVhZGVycyA9IHt9O1xuICAgIFN0cmluZyhyYXdIZWFkZXJzIHx8ICcnKS5zcGxpdChTdHJpbmcuZnJvbUNoYXJDb2RlKDEwKSkuZm9yRWFjaChyYXdMaW5lID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IHJhd0xpbmUudHJpbSgpO1xuICAgICAgICBjb25zdCBzZXBhcmF0b3IgPSBsaW5lLmluZGV4T2YoJzonKTtcbiAgICAgICAgaWYgKHNlcGFyYXRvciA8IDEpIHJldHVybjtcbiAgICAgICAgaGVhZGVyc1tsaW5lLnNsaWNlKDAsIHNlcGFyYXRvcikudHJpbSgpLnRvTG93ZXJDYXNlKCldID0gbGluZS5zbGljZShzZXBhcmF0b3IgKyAxKS50cmltKCk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGhlYWRlcnM7XG59XG5cbmZ1bmN0aW9uIG1zQXBpTnVtYmVySGVhZGVyKGhlYWRlcnMsIG5hbWUpIHtcbiAgICBjb25zdCB2YWx1ZSA9IE51bWJlcihoZWFkZXJzW25hbWVdKTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSAmJiB2YWx1ZSA+PSAwID8gdmFsdWUgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBtc0FwaVVwZGF0ZUxpbWl0U3RhdGUocmVzcG9uc2UpIHtcbiAgICBjb25zdCBoZWFkZXJzID0gbXNBcGlQYXJzZVJlc3BvbnNlSGVhZGVycyhyZXNwb25zZT8ucmVzcG9uc2VIZWFkZXJzKTtcbiAgICBjb25zdCBsaW1pdCA9IG1zQXBpTnVtYmVySGVhZGVyKGhlYWRlcnMsICd4LXJhdGVsaW1pdC1saW1pdCcpO1xuICAgIGNvbnN0IHJlbWFpbmluZyA9IG1zQXBpTnVtYmVySGVhZGVyKGhlYWRlcnMsICd4LXJhdGVsaW1pdC1yZW1haW5pbmcnKTtcbiAgICBjb25zdCBpbnRlcnZhbE1zID0gbXNBcGlOdW1iZXJIZWFkZXIoaGVhZGVycywgJ3gtbG9nbmV4LXJldHJ5LXRpbWVpbnRlcnZhbCcpO1xuICAgIGNvbnN0IHJlc2V0TXMgPSBtc0FwaU51bWJlckhlYWRlcihoZWFkZXJzLCAneC1sb2duZXgtcmVzZXQnKTtcbiAgICBjb25zdCByZXRyeUFmdGVyTXMgPSBtc0FwaU51bWJlckhlYWRlcihoZWFkZXJzLCAneC1sb2duZXgtcmV0cnktYWZ0ZXInKTtcblxuICAgIGlmIChsaW1pdCAhPT0gbnVsbCkgbXNBcGlSYXRlTGltaXRTdGF0ZS5saW1pdCA9IGxpbWl0O1xuICAgIGlmIChyZW1haW5pbmcgIT09IG51bGwpIG1zQXBpUmF0ZUxpbWl0U3RhdGUucmVtYWluaW5nID0gcmVtYWluaW5nO1xuICAgIGlmIChpbnRlcnZhbE1zICE9PSBudWxsKSBtc0FwaVJhdGVMaW1pdFN0YXRlLmludGVydmFsTXMgPSBpbnRlcnZhbE1zO1xuICAgIGlmIChyZXNldE1zICE9PSBudWxsKSBtc0FwaVJhdGVMaW1pdFN0YXRlLnJlc2V0TXMgPSByZXNldE1zO1xuICAgIGlmIChyZXRyeUFmdGVyTXMgIT09IG51bGwpIG1zQXBpUmF0ZUxpbWl0U3RhdGUucmV0cnlBZnRlck1zID0gcmV0cnlBZnRlck1zO1xuICAgIG1zQXBpUmF0ZUxpbWl0U3RhdGUudXBkYXRlZEF0ID0gRGF0ZS5ub3coKTtcblxuICAgIGlmIChsaW1pdCAhPT0gbnVsbCAmJiBsaW1pdCA+IDAgJiYgaW50ZXJ2YWxNcyAhPT0gbnVsbCAmJiBpbnRlcnZhbE1zID4gMCkge1xuXG4gICAgICAgIC8vIEhlYWRlciBjb3VudHMgbWF5IGJlIHdlaWdodGVkIHVuaXRzLCBub3Qgd2hvbGUgSFRUUCByZXF1ZXN0cy5cbiAgICAgICAgY29uc3QgYnVkZ2V0ID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcigocmVtYWluaW5nID8/IGxpbWl0KSAvIDUpKTtcbiAgICAgICAgbXNBcGlOZXh0UmVxdWVzdEF0ID0gTWF0aC5tYXgobXNBcGlOZXh0UmVxdWVzdEF0LCBEYXRlLm5vdygpICsgTWF0aC5tYXgoNTAwLCBNYXRoLmNlaWwoKHJlc2V0TXMgfHwgaW50ZXJ2YWxNcykgLyBidWRnZXQgKiBNU19BUElfUkFURV9TQUZFVFlfRkFDVE9SKSkpO1xuICAgIH1cbiAgICBpZiAocmVtYWluaW5nID09PSAwKSB7XG4gICAgICAgIGNvbnN0IHdhaXRNcyA9IHJldHJ5QWZ0ZXJNcyB8fCByZXNldE1zIHx8IGludGVydmFsTXMgfHwgMDtcbiAgICAgICAgaWYgKHdhaXRNcyA+IDApIG1zQXBpQmxvY2tlZFVudGlsID0gTWF0aC5tYXgobXNBcGlCbG9ja2VkVW50aWwsIERhdGUubm93KCkgKyB3YWl0TXMpO1xuICAgIH1cbiAgICByZXR1cm4geyBoZWFkZXJzLCByYXRlTGltaXQ6IHsgbGltaXQsIHJlbWFpbmluZywgaW50ZXJ2YWxNcywgcmVzZXRNcywgcmV0cnlBZnRlck1zIH0gfTtcbn1cblxuZnVuY3Rpb24gbXNBcGlTY2hlZHVsZVF1ZXVlKHdhaXRNcykge1xuICAgIGlmIChtc0FwaVF1ZXVlVGltZXIgfHwgIW1zQXBpUmVxdWVzdFF1ZXVlLmxlbmd0aCkgcmV0dXJuO1xuICAgIG1zQXBpUXVldWVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBtc0FwaVF1ZXVlVGltZXIgPSBudWxsO1xuICAgICAgICBtc0FwaVB1bXBRdWV1ZSgpO1xuICAgIH0sIE1hdGgubWF4KDEsIHdhaXRNcykpO1xufVxuXG5mdW5jdGlvbiBtc0FwaVB1bXBRdWV1ZSgpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLmRpcmVjdE1zKSB7XG4gICAgICAgIGlmICghaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKSkgcmV0dXJuO1xuICAgICAgICB3aGlsZSAobXNBcGlSZXF1ZXN0UXVldWUubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCB0YXNrID0gbXNBcGlSZXF1ZXN0UXVldWUuc2hpZnQoKTtcbiAgICAgICAgICAgIGlmICh0YXNrLmdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbiB8fCB0YXNrLnNpZ25hbD8uYWJvcnRlZCB8fCB0YXNrLnRva2VuICE9PSBoYWNrZXJCZWFyZXJUb2tlbi50cmltKCkpIHRhc2suY2FuY2VsKCk7XG4gICAgICAgICAgICBlbHNlIG1zQXBpU3RhcnRUYXNrKHRhc2spO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFtc0FwaVJlcXVlc3RRdWV1ZS5sZW5ndGgpIHJldHVybjtcbiAgICBpZiAoIWhhY2tlckNoZWNrQ3JlZGVudGlhbFNjb3BlKCkpIHJldHVybjtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IGNvb2xkb3duVW50aWwgPSBNYXRoLm1heChtc0FwaUJsb2NrZWRVbnRpbCwgbXNBcGlQYXJhbGxlbENvb2xkb3duVW50aWwpO1xuICAgIGlmIChub3cgPCBjb29sZG93blVudGlsKSB7XG4gICAgICAgIG1zQXBpU2NoZWR1bGVRdWV1ZShjb29sZG93blVudGlsIC0gbm93KTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjb25jdXJyZW5jeUxpbWl0ID0gbm93IDwgbXNBcGlQYXJhbGxlbENvb2xkb3duVW50aWwgPyAxIDogTVNfQVBJX01BWF9DT05DVVJSRU5UX1JFUVVFU1RTO1xuICAgIHdoaWxlIChtc0FwaVJlcXVlc3RRdWV1ZS5sZW5ndGggJiYgbXNBcGlJbkZsaWdodCA8IGNvbmN1cnJlbmN5TGltaXQpIHtcbiAgICAgICAgY29uc3QgZGVsYXkgPSBtc0FwaU5leHRSZXF1ZXN0QXQgLSBEYXRlLm5vdygpO1xuICAgICAgICBpZiAoZGVsYXkgPiAwKSB7XG4gICAgICAgICAgICBtc0FwaVNjaGVkdWxlUXVldWUoZGVsYXkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHRhc2sgPSBtc0FwaVJlcXVlc3RRdWV1ZS5zaGlmdCgpO1xuICAgICAgICBpZiAodGFzay5nZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24gfHwgdGFzay5zaWduYWw/LmFib3J0ZWQpIHsgdGFzay5jYW5jZWwoKTsgY29udGludWU7IH1cbiAgICAgICAgY29uc3Qgd2VpZ2h0ID0gdGFzay5tZXRob2QgPT09ICdHRVQnICYmIC9eXFwvcmVwb3J0XFwvc3RvY2tcXC8oYWxsfGJ5c3RvcmUpKD86XFw/fFxcLz8kKS8udGVzdCh0YXNrLnBhdGgpID8gNSA6IDQ7XG4gICAgICAgIG1zQXBpTmV4dFJlcXVlc3RBdCA9IERhdGUubm93KCkgKyA1MDAgKiB3ZWlnaHQgLyA0O1xuICAgICAgICBtc0FwaVN0YXJ0VGFzayh0YXNrKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIG1zQXBpU3RhcnRUYXNrKHRhc2spIHtcbiAgICBtc0FwaUluRmxpZ2h0ICs9IDE7XG4gICAgbGV0IGNvbXBsZXRlZCA9IGZhbHNlO1xuICAgIGNvbnN0IGZpbmlzaCA9IChjYWxsYmFjaywgdmFsdWUpID0+IHtcbiAgICAgICAgaWYgKGNvbXBsZXRlZCkgcmV0dXJuO1xuICAgICAgICBjb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICBtc0FwaUluRmxpZ2h0ID0gTWF0aC5tYXgoMCwgbXNBcGlJbkZsaWdodCAtIDEpO1xuICAgICAgICBtc0FwaVRhc2tzLmRlbGV0ZSh0YXNrKTtcbiAgICAgICAgdGFzay5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgdGFzay5hYm9ydExpc3RlbmVyKTtcbiAgICAgICAgdHJ5IHsgY2FsbGJhY2sodmFsdWUpOyB9IGZpbmFsbHkgeyBtc0FwaVB1bXBRdWV1ZSgpOyB9XG4gICAgfTtcbiAgICBsZXQgaGFuZGxlO1xuICAgIHRhc2suY2FuY2VsID0gKCkgPT4ge1xuICAgICAgICBpZiAoY29tcGxldGVkKSByZXR1cm47XG4gICAgICAgIGhhbmRsZT8uYWJvcnQ/LigpO1xuICAgICAgICBmaW5pc2godGFzay5vbkVycm9yLCBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKSk7XG4gICAgfTtcbiAgICBjb25zdCBoZWFkZXJzID0geyAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb247Y2hhcnNldD11dGYtOCcgfTtcbiAgICBpZiAodGFzay5ib2R5KSBoZWFkZXJzWydDb250ZW50LVR5cGUnXSA9ICdhcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTgnO1xuICAgIGhlYWRlcnNbJ0F1dGhvcml6YXRpb24nXSA9ICdCZWFyZXIgJyArIHRhc2sudG9rZW47XG5cbiAgICB0cnkge1xuICAgICAgICBoYW5kbGUgPSBHTV94bWxodHRwUmVxdWVzdCh7XG4gICAgICAgICAgICBtZXRob2Q6IHRhc2subWV0aG9kLFxuICAgICAgICAgICAgdXJsOiBNU19BUElfQkFTRSArIHRhc2sucGF0aCxcbiAgICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgICBkYXRhOiB0YXNrLmJvZHkgPyBKU09OLnN0cmluZ2lmeSh0YXNrLmJvZHkpIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgdGltZW91dDogMzAwMDAsXG4gICAgICAgICAgICBhbm9ueW1vdXM6IGZhbHNlLFxuICAgICAgICAgICAgbWVtY2hhdElzQ3VycmVudDogKCkgPT4gIWNvbXBsZXRlZCAmJiBoYWNrZXJDaGVja0NyZWRlbnRpYWxTY29wZSgpXG4gICAgICAgICAgICAgICAgJiYgdGFzay5nZW5lcmF0aW9uID09PSBtc0FwaUdlbmVyYXRpb24gJiYgIXRhc2suc2lnbmFsPy5hYm9ydGVkLFxuICAgICAgICAgICAgb25sb2FkOiByZXNwb25zZSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbXBsZXRlZCkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIGlmICghaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKSB8fCB0YXNrLmdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbiB8fCB0YXNrLnNpZ25hbD8uYWJvcnRlZCkgeyB0YXNrLmNhbmNlbCgpOyByZXR1cm47IH1cbiAgICAgICAgICAgICAgICBjb25zdCByYXcgPSByZXNwb25zZS5yZXNwb25zZVRleHQgfHwgJyc7XG4gICAgICAgICAgICAgICAgbGV0IGRhdGEgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRyeSB7IGRhdGEgPSByYXcgPyBKU09OLnBhcnNlKHJhdykgOiBudWxsOyB9IGNhdGNoIChlKSB7IC8qINC90LUgSlNPTiAqLyB9XG4gICAgICAgICAgICAgICAgY29uc3QgbGltaXRJbmZvID0gbXNBcGlVcGRhdGVMaW1pdFN0YXRlKHJlc3BvbnNlKTtcbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID49IDIwMCAmJiByZXNwb25zZS5zdGF0dXMgPCAzMDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRhdGEgJiYgdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnKSBkYXRhLl9zdGF0dXMgPSByZXNwb25zZS5zdGF0dXM7XG4gICAgICAgICAgICAgICAgICAgIGZpbmlzaCh0YXNrLm9uU3VjY2VzcywgZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgYXBpRXJyb3IgPSBkYXRhPy5lcnJvcnM/LlswXSB8fCBudWxsO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFwaU1zZyA9IGFwaUVycm9yXG4gICAgICAgICAgICAgICAgICAgID8gKGFwaUVycm9yLmVycm9yIHx8IGFwaUVycm9yLnBhcmFtZXRlciB8fCBhcGlFcnJvci5jb2RlIHx8IEpTT04uc3RyaW5naWZ5KGFwaUVycm9yKSlcbiAgICAgICAgICAgICAgICAgICAgOiAnJztcbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYXBpTXNnIHx8ICgnSFRUUCAnICsgcmVzcG9uc2Uuc3RhdHVzKTtcbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MDEgJiYgIWhhY2tlckJlYXJlckVuYWJsZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgbXNnICs9ICcg4oCUINCy0LrQu9GO0YfQuNGC0LUgwqtCZWFyZXIt0LrQu9GO0YcgQVBJwrsg0LIg0L3QsNGB0YLRgNC+0LnQutCw0YUg0Lgg0LLRgdGC0LDQstGM0YLQtSBBUEkt0LrQu9GO0YcnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcihtc2cpO1xuICAgICAgICAgICAgICAgIGVycm9yLnN0YXR1cyA9IHJlc3BvbnNlLnN0YXR1cztcbiAgICAgICAgICAgICAgICBlcnJvci5hcGlDb2RlID0gYXBpRXJyb3I/LmNvZGUgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICBlcnJvci5hdXRoQ29kZSA9IGxpbWl0SW5mby5oZWFkZXJzWyd4LWxvZ25leC1hdXRoJ10gfHwgbnVsbDtcbiAgICAgICAgICAgICAgICBlcnJvci5yYXRlTGltaXQgPSBsaW1pdEluZm8ucmF0ZUxpbWl0O1xuICAgICAgICAgICAgICAgIGNvbnN0IGlzUGFyYWxsZWxMaW1pdCA9IHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5XG4gICAgICAgICAgICAgICAgICAgICYmIChOdW1iZXIoZXJyb3IuYXBpQ29kZSkgPT09IDEwNzMgfHwgZXJyb3IuYXV0aENvZGUgPT09ICc0MjkwMDUnKTtcbiAgICAgICAgICAgICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzID09PSA0MjkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgd2FpdE1zID0gbGltaXRJbmZvLnJhdGVMaW1pdC5yZXRyeUFmdGVyTXNcbiAgICAgICAgICAgICAgICAgICAgICAgIHx8IGxpbWl0SW5mby5yYXRlTGltaXQucmVzZXRNc1xuICAgICAgICAgICAgICAgICAgICAgICAgfHwgbGltaXRJbmZvLnJhdGVMaW1pdC5pbnRlcnZhbE1zXG4gICAgICAgICAgICAgICAgICAgICAgICB8fCAxMDAwO1xuICAgICAgICAgICAgICAgICAgICBtc0FwaUJsb2NrZWRVbnRpbCA9IE1hdGgubWF4KG1zQXBpQmxvY2tlZFVudGlsLCBEYXRlLm5vdygpICsgd2FpdE1zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGlzUGFyYWxsZWxMaW1pdCkge1xuICAgICAgICAgICAgICAgICAgICBtc0FwaVJhdGVMaW1pdFN0YXRlLnBhcmFsbGVsTGltaXRFcnJvcnMgKz0gMTtcbiAgICAgICAgICAgICAgICAgICAgbXNBcGlQYXJhbGxlbENvb2xkb3duVW50aWwgPSBNYXRoLm1heChtc0FwaVBhcmFsbGVsQ29vbGRvd25VbnRpbCwgRGF0ZS5ub3coKSArIDEwMDAwKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSB8fCBOdW1iZXIoZXJyb3IuYXBpQ29kZSkgPT09IDEwNzMpXG4gICAgICAgICAgICAgICAgICAgICYmIHRhc2subWV0aG9kID09PSAnR0VUJyAmJiB0YXNrLmF0dGVtcHQgPCAyICYmICFHTV94bWxodHRwUmVxdWVzdC5tZW1jaGF0TXNTY2hlZHVsZXIpIHtcbiAgICAgICAgICAgICAgICAgICAgbXNBcGlCbG9ja2VkVW50aWwgPSBNYXRoLm1heChtc0FwaUJsb2NrZWRVbnRpbCwgRGF0ZS5ub3coKSArIDEwMDAgKiAyICoqIHRhc2suYXR0ZW1wdCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbXBsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIG1zQXBpSW5GbGlnaHQtLTtcbiAgICAgICAgICAgICAgICAgICAgdGFzay5hdHRlbXB0Kys7XG4gICAgICAgICAgICAgICAgICAgIHRhc2suY2FuY2VsID0gdGFzay5jYW5jZWxRdWV1ZWQ7XG4gICAgICAgICAgICAgICAgICAgIG1zQXBpUmVxdWVzdFF1ZXVlLnB1c2godGFzayk7XG4gICAgICAgICAgICAgICAgICAgIG1zQXBpUHVtcFF1ZXVlKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZmluaXNoKHRhc2sub25FcnJvciwgZXJyb3IpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIG9uZXJyb3I6ICgpID0+IGZpbmlzaCh0YXNrLm9uRXJyb3IsIG5ldyBFcnJvcign0J7RiNC40LHQutCwINGB0LXRgtC4IChhcGkubW95c2tsYWQucnUpJykpLFxuICAgICAgICAgICAgb250aW1lb3V0OiAoKSA9PiBmaW5pc2godGFzay5vbkVycm9yLCBuZXcgRXJyb3IoJ9Ci0LDQudC80LDRg9GCINC30LDQv9GA0L7RgdCwINC6IGFwaS5tb3lza2xhZC5ydScpKSxcbiAgICAgICAgICAgIG9uYWJvcnQ6ICgpID0+IGZpbmlzaCh0YXNrLm9uRXJyb3IsIG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvScpKVxuICAgICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmaW5pc2godGFzay5vbkVycm9yLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBtc0FwaShtZXRob2QsIHBhdGgsIGJvZHksIG9uU3VjY2Vzcywgb25FcnJvciwgb3B0aW9ucyA9IHt9KSB7XG4gICAgdHJ5IHsgaGFja2VyRW5zdXJlQmVhcmVyKCk7IH1cbiAgICBjYXRjaCAoZXJyb3IpIHsgb25FcnJvcihlcnJvcik7IHJldHVybjsgfVxuICAgIGNvbnN0IHRhc2sgPSB7IG1ldGhvZDogbWV0aG9kLnRvVXBwZXJDYXNlKCksIHBhdGgsIGJvZHksIG9uU3VjY2Vzcywgb25FcnJvcixcbiAgICAgICAgdG9rZW46IGhhY2tlckJlYXJlclRva2VuLnRyaW0oKSwgZ2VuZXJhdGlvbjogbXNBcGlHZW5lcmF0aW9uLCBzaWduYWw6IG9wdGlvbnMuc2lnbmFsLCBjYW5jZWw6IG51bGwsIGF0dGVtcHQ6IDAgfTtcbiAgICBjb25zdCBjYW5jZWwgPSAoKSA9PiB0YXNrLmNhbmNlbCgpO1xuICAgIHRhc2suY2FuY2VsID0gKCkgPT4ge1xuICAgICAgICBjb25zdCBpbmRleCA9IG1zQXBpUmVxdWVzdFF1ZXVlLmluZGV4T2YodGFzayk7XG4gICAgICAgIGlmIChpbmRleCA+PSAwKSBtc0FwaVJlcXVlc3RRdWV1ZS5zcGxpY2UoaW5kZXgsIDEpO1xuICAgICAgICBtc0FwaVRhc2tzLmRlbGV0ZSh0YXNrKTtcbiAgICAgICAgdGFzay5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsKTtcbiAgICAgICAgb25FcnJvcihuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKSk7XG4gICAgfTtcbiAgICAvLyBLZWVwIHRoZSBsaXN0ZW5lciBpZGVudGl0eSBzdGFibGUgd2hlbiBxdWV1ZWQgY2FuY2VsbGF0aW9uIGJlY29tZXMgYWN0aXZlLlxuICAgIHRhc2suYWJvcnRMaXN0ZW5lciA9IGNhbmNlbDtcbiAgICB0YXNrLmNhbmNlbFF1ZXVlZCA9IHRhc2suY2FuY2VsO1xuICAgIGlmICh0YXNrLnNpZ25hbD8uYWJvcnRlZCkgeyB0YXNrLmNhbmNlbCgpOyByZXR1cm47IH1cbiAgICB0YXNrLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWwsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICBtc0FwaVRhc2tzLmFkZCh0YXNrKTtcbiAgICBtc0FwaVJlcXVlc3RRdWV1ZS5wdXNoKHRhc2spO1xuICAgIG1zQXBpUHVtcFF1ZXVlKCk7XG59XG5cbmZ1bmN0aW9uIG1zQXBpUChtZXRob2QsIHBhdGgsIGJvZHksIG9wdGlvbnMpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gbXNBcGkobWV0aG9kLCBwYXRoLCBib2R5LCByZXNvbHZlLCByZWplY3QsIG9wdGlvbnMpKTtcbn1cblxuLy8g4pSA4pSA4pSAINCa0L7QvdGB0L7Qu9GMLdC70L7QsyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhhY2tlckxvZyhtc2csIGtpbmQsIG9yZ2FuaXphdGlvbk5hbWUgPSAnJykge1xuICAgIGhhY2tlckxvZ0xpbmVzLnB1c2goeyB0aW1lOiBuZXcgRGF0ZSgpLCBtc2c6IFN0cmluZyhtc2cpLCBraW5kOiBraW5kIHx8ICdpbmZvJywgb3JnYW5pemF0aW9uTmFtZSB9KTtcbiAgICBpZiAoaGFja2VyTG9nTGluZXMubGVuZ3RoID4gMzAwKSBoYWNrZXJMb2dMaW5lcy5zaGlmdCgpO1xuICAgIGhhY2tlclJlbmRlckxvZygpO1xuICAgIGhhY2tlclJlbmRlckZsb2F0aW5nTG9nKCk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclJlbmRlckZsb2F0aW5nTG9nKCkge1xuICAgIGNvbnN0IGJveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY0hhY2tlckZsb2F0aW5nTG9nJyk7XG4gICAgaWYgKCFib3gpIHJldHVybjtcbiAgICBjb25zdCBib2R5ID0gYm94LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWhhY2tlci1mbG9hdGluZy1ib2R5XScpO1xuICAgIGlmICghYm9keSkgcmV0dXJuO1xuICAgIGJvZHkudGV4dENvbnRlbnQgPSAnJztcbiAgICBoYWNrZXJMb2dMaW5lcy5zbGljZSgtOCkuZm9yRWFjaChlbnRyeSA9PiB7XG4gICAgICAgIGNvbnN0IHQgPSBlbnRyeS50aW1lLnRvVGltZVN0cmluZygpLnNsaWNlKDAsIDgpO1xuICAgICAgICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGxpbmUudGV4dENvbnRlbnQgPSBgWyR7dH1dICR7ZW50cnkubXNnfWA7XG4gICAgICAgIGlmIChlbnRyeS5vcmdhbml6YXRpb25OYW1lKSBsaW5lLmFwcGVuZENoaWxkKGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9uTGFiZWwoZW50cnkub3JnYW5pemF0aW9uTmFtZSkpO1xuICAgICAgICBib2R5LmFwcGVuZENoaWxkKGxpbmUpO1xuICAgIH0pO1xuICAgIGJvZHkuc2Nyb2xsVG9wID0gYm9keS5zY3JvbGxIZWlnaHQ7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckVuc3VyZUZsb2F0aW5nTG9nKCkge1xuICAgIGxldCBib3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNIYWNrZXJGbG9hdGluZ0xvZycpO1xuICAgIGlmIChib3gpIHJldHVybiBib3g7XG4gICAgYm94ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgYm94LmlkID0gJ21jSGFja2VyRmxvYXRpbmdMb2cnO1xuICAgIGJveC5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO3JpZ2h0OjEycHg7Ym90dG9tOjEycHg7ei1pbmRleDoyMTQ3NDgzMDAyO3dpZHRoOjMxMHB4O2JhY2tncm91bmQ6IzBmMTcyYTtjb2xvcjojY2JkNWUxO2JvcmRlcjoxcHggc29saWQgIzQ3NTU2OTtib3JkZXItcmFkaXVzOjlweDtib3gtc2hhZG93OjAgOHB4IDMwcHggIzAwMDU7Zm9udDoxMHB4IENvbnNvbGFzLG1vbm9zcGFjZTsnO1xuICAgIGNvbnN0IGhlYWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBoZWFkLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtwYWRkaW5nOjZweCA4cHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgIzMzNDE1NTtjb2xvcjojZjhmYWZjO2ZvbnQ6NjAwIDExcHggU2Vnb2UgVUksc2Fucy1zZXJpZjsnO1xuICAgIGhlYWQudGV4dENvbnRlbnQgPSAn0KXQsNGC0LjQutC+0KXQsNC60LXRgCDigJQg0YHRgtCw0YLRg9GBJztcbiAgICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOyBjbG9zZS50ZXh0Q29udGVudCA9ICfinJUnOyBjbG9zZS5zdHlsZS5jc3NUZXh0ID0gJ2JvcmRlcjowO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6I2NiZDVlMTtjdXJzb3I6cG9pbnRlcjsnOyBjbG9zZS5vbmNsaWNrID0gKCkgPT4gYm94LnJlbW92ZSgpO1xuICAgIGhlYWQuYXBwZW5kQ2hpbGQoY2xvc2UpOyBib3guYXBwZW5kQ2hpbGQoaGVhZCk7XG4gICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3ByZScpOyBib2R5LmRhdGFzZXQuaGFja2VyRmxvYXRpbmdCb2R5ID0gJzEnOyBib2R5LnN0eWxlLmNzc1RleHQgPSAnbWFyZ2luOjA7cGFkZGluZzo3cHggOHB4O2hlaWdodDoxMDBweDtvdmVyZmxvdzphdXRvO3doaXRlLXNwYWNlOnByZS13cmFwOyc7XG4gICAgYm94LmFwcGVuZENoaWxkKGJvZHkpOyBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGJveCk7IGhhY2tlclJlbmRlckZsb2F0aW5nTG9nKCk7IHJldHVybiBib3g7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclJlbmRlckxvZygpIHtcbiAgICBjb25zdCBib3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTG9nQm94Jyk7XG4gICAgaWYgKCFib3gpIHJldHVybjtcbiAgICBib3guaW5uZXJIVE1MID0gJyc7XG4gICAgY29uc3QgY29sb3JzID0geyBpbmZvOiAnIzk0YTNiOCcsIG9rOiAnIzRhZGU4MCcsIGVycjogJyNmODcxNzEnLCB3YXJuOiAnI2ZiYmYyNCcgfTtcbiAgICBoYWNrZXJMb2dMaW5lcy5mb3JFYWNoKGVudHJ5ID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBjb25zdCB0ID0gZW50cnkudGltZS50b1RpbWVTdHJpbmcoKS5zbGljZSgwLCA4KTtcbiAgICAgICAgbGluZS5zdHlsZS5jc3NUZXh0ID0gJ3doaXRlLXNwYWNlOnByZS13cmFwO3dvcmQtYnJlYWs6YnJlYWstd29yZDsnO1xuICAgICAgICBsaW5lLnN0eWxlLmNvbG9yID0gY29sb3JzW2VudHJ5LmtpbmRdIHx8IGNvbG9ycy5pbmZvO1xuICAgICAgICBsaW5lLnRleHRDb250ZW50ID0gYFske3R9XSAke2VudHJ5Lm1zZ31gO1xuICAgICAgICBpZiAoZW50cnkub3JnYW5pemF0aW9uTmFtZSkgbGluZS5hcHBlbmRDaGlsZChoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbkxhYmVsKGVudHJ5Lm9yZ2FuaXphdGlvbk5hbWUpKTtcbiAgICAgICAgYm94LmFwcGVuZENoaWxkKGxpbmUpO1xuICAgIH0pO1xuICAgIGJveC5zY3JvbGxUb3AgPSBib3guc2Nyb2xsSGVpZ2h0O1xufVxuXG4vLyDilIDilIDilIAg0JLRgdC/0L7QvNC+0LPQsNGC0LXQu9GM0L3Ri9C1IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8g0J7RgtC60YDRi9GC0LDRjyDQutCw0YDRgtC+0YfQutCwOiDQt9Cw0LrQsNC3INC/0L7QutGD0L/QsNGC0LXQu9GPINC40LvQuCDQvtGC0LPRgNGD0LfQutCwXG5mdW5jdGlvbiBoYWNrZXJPcGVuRG9jKCkge1xuICAgIGNvbnN0IG0gPSAobG9jYXRpb24uaGFzaCB8fCAnJykubWF0Y2goL14jKGN1c3RvbWVyb3JkZXJ8ZGVtYW5kKVxcL2VkaXRcXD9pZD0oWzAtOWEtZkEtRi1dKykvKTtcbiAgICByZXR1cm4gbSA/IHsgdHlwZTogbVsxXSwgaWQ6IG1bMl0gfSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckVsKHRhZywgY3NzLCB0ZXh0KSB7XG4gICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XG4gICAgaWYgKGNzcykgZWwuc3R5bGUuY3NzVGV4dCA9IGNzcztcbiAgICBpZiAodGV4dCAhPT0gdW5kZWZpbmVkKSBlbC50ZXh0Q29udGVudCA9IHRleHQ7XG4gICAgcmV0dXJuIGVsO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJCdG4oaWQsIGxhYmVsLCBjc3MpIHtcbiAgICBjb25zdCBiID0gaGFja2VyRWwoJ2J1dHRvbicsIGNzcyB8fCAnJywgbGFiZWwpO1xuICAgIGIudHlwZSA9ICdidXR0b24nO1xuICAgIGIuaWQgPSBpZDtcbiAgICByZXR1cm4gYjtcbn1cblxuY29uc3QgSEFDS0VSX1NFTEVDVF9DU1MgPSAnZmxleDoxO3BhZGRpbmc6NHB4IDZweDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxOydcbiAgICArICdib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4O291dGxpbmU6bm9uZTttaW4td2lkdGg6MDsnO1xuY29uc3QgSEFDS0VSX0lOUFVUX0NTUyA9ICd3aWR0aDoxMDAlO3BhZGRpbmc6NHB4IDdweDtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxOydcbiAgICArICdib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMS41cHg7b3V0bGluZTpub25lO2JveC1zaXppbmc6Ym9yZGVyLWJveDsnO1xuY29uc3QgSEFDS0VSX0JUTl9DU1MgPSAncGFkZGluZzo1cHggMTBweDtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojZmZmO2ZvbnQtc2l6ZToxMXB4OydcbiAgICArICdjdXJzb3I6cG9pbnRlcjtmb250LXdlaWdodDo2MDA7dHJhbnNpdGlvbjpmaWx0ZXIgLjE1czsnO1xuY29uc3QgSEFDS0VSX01JTklfQlROX0NTUyA9ICdwYWRkaW5nOjRweCA4cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTsnXG4gICAgKyAnYm9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTFweDtjdXJzb3I6cG9pbnRlcjtmb250LXdlaWdodDo3MDA7JztcblxuZnVuY3Rpb24gaGFja2VyU2VsZWN0KGlkLCBwbGFjZWhvbGRlcikge1xuICAgIGNvbnN0IHNlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xuICAgIHNlbC5pZCA9IGlkO1xuICAgIHNlbC5zdHlsZS5jc3NUZXh0ID0gSEFDS0VSX1NFTEVDVF9DU1M7XG4gICAgaWYgKHBsYWNlaG9sZGVyKSB7XG4gICAgICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgICAgICBvcHQudmFsdWUgPSAnJztcbiAgICAgICAgb3B0LnRleHRDb250ZW50ID0gcGxhY2Vob2xkZXI7XG4gICAgICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpO1xuICAgIH1cbiAgICByZXR1cm4gc2VsO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJGaWxsU2VsZWN0KHNlbCwgaXRlbXMsIGtlZXBFbXB0eVBsYWNlaG9sZGVyKSB7XG4gICAgLy8g0J7RgtCy0LXRgiBBUEkg0LzQvtC20LXRgiDQv9GA0LjQudGC0Lgg0L/QvtGB0LvQtSDQv9C10YDQtdC60LvRjtGH0LXQvdC40Y8g0LLQutC70LDQtNC60Lg6INGB0YLQsNGA0YvQuSBzZWxlY3Qg0YPQttC1INGD0LTQsNC70ZHQvS5cbiAgICBpZiAoIXNlbCB8fCAhc2VsLmlzQ29ubmVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcGxhY2Vob2xkZXIgPSBrZWVwRW1wdHlQbGFjZWhvbGRlciA/IHNlbC5xdWVyeVNlbGVjdG9yKCdvcHRpb25bdmFsdWU9XCJcIl0nKSA6IG51bGw7XG4gICAgc2VsLmlubmVySFRNTCA9ICcnO1xuICAgIGlmIChwbGFjZWhvbGRlcikgc2VsLmFwcGVuZENoaWxkKHBsYWNlaG9sZGVyKTtcbiAgICBpdGVtcy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICBjb25zdCBvcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgb3B0LnZhbHVlID0gaXRlbS5ocmVmO1xuICAgICAgICBvcHQudGV4dENvbnRlbnQgPSBpdGVtLm5hbWU7XG4gICAgICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpO1xuICAgIH0pO1xufVxuXG4vLyDilIDilIDilIAg0J7RgtC60YDRi9GC0YvQuSDQt9Cw0LrQsNC3OiDQt9Cw0LPRgNGD0LfQutCwINC4INC/0YDQtdC00LfQsNC/0L7Qu9C90LXQvdC40LUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBoYWNrZXJMb2FkT3Blbk9yZGVyKHF1aWV0KSB7XG4gICAgY29uc3QgZG9jID0gaGFja2VyT3BlbkRvYygpO1xuICAgIGlmICghZG9jIHx8IGRvYy50eXBlICE9PSAnY3VzdG9tZXJvcmRlcicpIHtcbiAgICAgICAgaWYgKCFxdWlldCkgaGFja2VyTG9nKCfQntGC0LrRgNC+0LnRgtC1INC60LDRgNGC0L7Rh9C60YMg0LfQsNC60LDQt9CwINC/0L7QutGD0L/QsNGC0LXQu9GPJywgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShudWxsKTtcbiAgICB9XG4gICAgcmV0dXJuIG1zQXBpUCgnR0VUJywgJy9lbnRpdHkvY3VzdG9tZXJvcmRlci8nICsgZG9jLmlkICsgJz9leHBhbmQ9cG9zaXRpb25zLmFzc29ydG1lbnQnKVxuICAgICAgICAudGhlbihvcmRlciA9PiB7XG4gICAgICAgICAgICBoYWNrZXJPcmRlckluZm8gPSBvcmRlcjtcbiAgICAgICAgICAgIGhhY2tlckxvZyhg0JfQsNC60LDQtyAke29yZGVyLm5hbWV9OiDRgdGD0LzQvNCwICR7KG9yZGVyLnN1bSAvIDEwMCkudG9GaXhlZCgyKX0g4oK9LCDRgdGC0LDRgtGD0YE6ICR7b3JkZXIuc3RhdGU/Lm5hbWUgfHwgJ+KAlCd9YCk7XG4gICAgICAgICAgICAvLyDQn9GA0LXQtNC30LDQv9C+0LvQvdC10L3QuNC1INGB0YPQvNC8INC4INC60LDQvdCw0LvQsFxuICAgICAgICAgICAgY29uc3Qgc3VtU3RyID0gKG9yZGVyLnN1bSAvIDEwMCkudG9GaXhlZCgyKTtcbiAgICAgICAgICAgIFsnaGFja2VyQ2FzaGluU3VtJywgJ2hhY2tlclBheWluU3VtJ10uZm9yRWFjaChpZCA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgaW5wID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuICAgICAgICAgICAgICAgIGlmIChpbnAgJiYgIWlucC52YWx1ZS50cmltKCkpIGlucC52YWx1ZSA9IHN1bVN0cjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKG9yZGVyLnNhbGVzQ2hhbm5lbCAmJiBvcmRlci5zYWxlc0NoYW5uZWwubWV0YSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJDaGFubmVsU2VsZWN0Jyk7XG4gICAgICAgICAgICAgICAgaWYgKHNlbCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBocmVmID0gb3JkZXIuc2FsZXNDaGFubmVsLm1ldGEuaHJlZjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFbLi4uc2VsLm9wdGlvbnNdLnNvbWUobyA9PiBvLnZhbHVlID09PSBocmVmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBvcHQudmFsdWUgPSBocmVmO1xuICAgICAgICAgICAgICAgICAgICAgICAgb3B0LnRleHRDb250ZW50ID0gb3JkZXIuc2FsZXNDaGFubmVsLm5hbWUgfHwgJyjQutCw0L3QsNC7INC30LDQutCw0LfQsCknO1xuICAgICAgICAgICAgICAgICAgICAgICAgc2VsLmFwcGVuZENoaWxkKG9wdCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgc2VsLnZhbHVlID0gaHJlZjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gb3JkZXI7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICBoYWNrZXJMb2coJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0LfQsNCz0YDRg9C30LjRgtGMINC30LDQutCw0Lc6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJyk7XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfSk7XG59XG5cbi8vIOKUgOKUgOKUgCDQktC60LvQsNC00LrQsCDCq9Ch0YLQsNGC0YPRgcK7IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gaGFja2VyUmVmcmVzaFN0YXRlcyhxdWlldCkge1xuICAgIHJldHVybiBtc1JlZmVyZW5jZUxvYWQoJ2N1c3RvbWVyb3JkZXInLCB7IGZvcmNlOiB0cnVlIH0pXG4gICAgICAgIC50aGVuKHN0YXRlcyA9PiB7XG4gICAgICAgICAgICBoYWNrZXJGaWxsU2VsZWN0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJTdGF0ZVNlbGVjdCcpLCBoYWNrZXJTdGF0ZXMpO1xuICAgICAgICAgICAgaWYgKCFxdWlldCkgaGFja2VyTG9nKGDQodGC0LDRgtGD0YHRiyDQvtCx0L3QvtCy0LvQtdC90Ys6ICR7aGFja2VyU3RhdGVzLmxlbmd0aH0g0YjRgi5gLCAnb2snKTtcbiAgICAgICAgICAgIHJldHVybiBzdGF0ZXM7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiBoYWNrZXJMb2coJ9Ch0YLQsNGC0YPRgdGLOiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyRW5zdXJlU3RhdGVzKHF1aWV0KSB7XG4gICAgaWYgKG1zUmVmZXJlbmNlU2NvcGUgfHwgaGFja2VyU3RhdGVzLmxlbmd0aCkge1xuICAgICAgICBoYWNrZXJGaWxsU2VsZWN0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJTdGF0ZVNlbGVjdCcpLCBoYWNrZXJTdGF0ZXMpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGhhY2tlclN0YXRlcyk7XG4gICAgfVxuICAgIHJldHVybiBoYWNrZXJSZWZyZXNoU3RhdGVzKHF1aWV0KS50aGVuKCgpID0+IGhhY2tlclN0YXRlcyk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclVwZGF0ZU9yZGVyU3RhdHVzKG9yZGVySWQsIHN0YXRlSHJlZikge1xuICAgIGhhY2tlckVuc3VyZUJlYXJlcigpO1xuICAgIHJldHVybiBtc0FwaVAoJ1BVVCcsIGAvZW50aXR5L2N1c3RvbWVyb3JkZXIvJHtvcmRlcklkfWAsIHtcbiAgICAgICAgc3RhdGU6IHsgbWV0YTogeyBocmVmOiBzdGF0ZUhyZWYsIHR5cGU6ICdzdGF0ZScsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nIH0gfSxcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQXBwbHlTdGF0dXMoKSB7XG4gICAgY29uc3QgZG9jID0gaGFja2VyT3BlbkRvYygpO1xuICAgIGlmICghZG9jIHx8IGRvYy50eXBlICE9PSAnY3VzdG9tZXJvcmRlcicpIHtcbiAgICAgICAgaGFja2VyTG9nKCfQntGC0LrRgNC+0LnRgtC1INC60LDRgNGC0L7Rh9C60YMg0LfQsNC60LDQt9CwINC/0L7QutGD0L/QsNGC0LXQu9GPJywgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBzZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyU3RhdGVTZWxlY3QnKTtcbiAgICBjb25zdCBocmVmID0gc2VsID8gc2VsLnZhbHVlIDogJyc7XG4gICAgaWYgKCFocmVmKSB7XG4gICAgICAgIGhhY2tlckxvZygn0JLRi9Cx0LXRgNC40YLQtSDRgdGC0LDRgtGD0YEgKNC40LvQuCDQvtCx0L3QvtCy0LjRgtC1INGB0L/QuNGB0L7QuiknLCAnd2FybicpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHN0YXRlTmFtZSA9IGhhY2tlclN0YXRlcy5maW5kKHMgPT4gcy5ocmVmID09PSBocmVmKT8ubmFtZSB8fCAnJztcbiAgICBtc0FwaSgnUFVUJywgJy9lbnRpdHkvY3VzdG9tZXJvcmRlci8nICsgZG9jLmlkLCB7XG4gICAgICAgIHN0YXRlOiB7IG1ldGE6IHsgaHJlZiwgdHlwZTogJ3N0YXRlJyB9IH1cbiAgICB9LCAoKSA9PiB7XG4gICAgICAgIGhhY2tlckxvZyhg4pyFINCh0YLQsNGC0YPRgSDQuNC30LzQtdC90ZHQvTogJHtzdGF0ZU5hbWV9YCwgJ29rJyk7XG4gICAgfSwgZXJyb3IgPT4gaGFja2VyTG9nKCfQodGC0LDRgtGD0YE6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJykpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJCdWlsZFN0YXR1c1RhYigpIHtcbiAgICBjb25zdCB3cmFwID0gaGFja2VyRWwoJ2RpdicpO1xuICAgIHdyYXAuaWQgPSAnaGFja2VyVGFiU3RhdHVzJztcblxuICAgIGNvbnN0IHJvdyA9IGhhY2tlckVsKCdkaXYnLCAnZGlzcGxheTpmbGV4O2dhcDo0cHg7bWFyZ2luLWJvdHRvbTo2cHg7Jyk7XG4gICAgcm93LmFwcGVuZENoaWxkKGhhY2tlclNlbGVjdCgnaGFja2VyU3RhdGVTZWxlY3QnLCAn4oCUINC+0LHQvdC+0LLQuNGC0LUg0YHQv9C40YHQvtC6IOKAlCcpKTtcbiAgICBjb25zdCByZWZyZXNoID0gaGFja2VyQnRuKCdoYWNrZXJTdGF0ZXNSZWZyZXNoJywgJ+KfsycsIEhBQ0tFUl9NSU5JX0JUTl9DU1MpO1xuICAgIHJlZnJlc2gudGl0bGUgPSAn0J7QsdC90L7QstC40YLRjCDRgdC/0LjRgdC+0Log0YHRgtCw0YLRg9GB0L7Qsic7XG4gICAgcmVmcmVzaC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGhhY2tlclJlZnJlc2hTdGF0ZXMoZmFsc2UpKTtcbiAgICByb3cuYXBwZW5kQ2hpbGQocmVmcmVzaCk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChyb3cpO1xuXG4gICAgY29uc3QgYXBwbHkgPSBoYWNrZXJCdG4oJ2hhY2tlclN0YXR1c0FwcGx5JywgJ9Cf0L7QvNC10L3Rj9GC0Ywg0YHRgtCw0YLRg9GBJyxcbiAgICAgICAgSEFDS0VSX0JUTl9DU1MgKyAnYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMzYjgyZjYsIzI1NjNlYik7d2lkdGg6MTAwJTsnKTtcbiAgICBhcHBseS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGhhY2tlckFwcGx5U3RhdHVzKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGFwcGx5KTtcbiAgICByZXR1cm4gd3JhcDtcbn1cblxuLy8g4pSA4pSA4pSAINCS0LrQu9Cw0LTQutCwIMKr0JrQvtC90YLRgNCw0LPQtdC90YLCuyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhhY2tlck5vcm1hbGl6ZVBob25lVmFyaWFudHMocmF3KSB7XG4gICAgY29uc3QgZGlnaXRzID0gU3RyaW5nKHJhdyB8fCAnJykucmVwbGFjZSgvXFxEL2csICcnKTtcbiAgICBpZiAoIWRpZ2l0cykgcmV0dXJuIFtdO1xuICAgIGNvbnN0IHZhcmlhbnRzID0gW2RpZ2l0c107XG4gICAgaWYgKGRpZ2l0cy5sZW5ndGggPT09IDExICYmIGRpZ2l0c1swXSA9PT0gJzgnKSB2YXJpYW50cy5wdXNoKCc3JyArIGRpZ2l0cy5zbGljZSgxKSk7XG4gICAgaWYgKGRpZ2l0cy5sZW5ndGggPT09IDExICYmIGRpZ2l0c1swXSA9PT0gJzcnKSB2YXJpYW50cy5wdXNoKCc4JyArIGRpZ2l0cy5zbGljZSgxKSk7XG4gICAgaWYgKGRpZ2l0cy5sZW5ndGggPT09IDEwKSB2YXJpYW50cy5wdXNoKCc3JyArIGRpZ2l0cyk7XG4gICAgcmV0dXJuIFsuLi5uZXcgU2V0KHZhcmlhbnRzKV07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckZpbmRBZ2VudEJ5UGhvbmUocmF3KSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBjb25zdCB2YXJpYW50cyA9IGhhY2tlck5vcm1hbGl6ZVBob25lVmFyaWFudHMocmF3KTtcbiAgICBpZiAoIXZhcmlhbnRzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfQktCy0LXQtNC40YLQtSDQvdC+0LzQtdGAINGC0LXQu9C10YTQvtC90LAnKTtcbiAgICBmb3IgKGNvbnN0IHBob25lIG9mIHZhcmlhbnRzKSB7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24pIHRocm93IG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvScpO1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgbXNBcGlQKCdHRVQnLCAnL2VudGl0eS9jb3VudGVycGFydHk/ZmlsdGVyPXBob25lPScgKyBwaG9uZSk7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24pIHRocm93IG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvScpO1xuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoZGF0YT8ucm93cykgfHwgZGF0YS5lcnJvcnM/Lmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfQn9GA0L7QstC10YDQutCwINC60L7QvdGC0YDQsNCz0LXQvdGC0LAg0L3QtSDQstGL0L/QvtC70L3QtdC90LA6INC90LXQv9C+0LvQvdGL0Lkg0L7RgtCy0LXRgicpO1xuICAgICAgICBpZiAoZGF0YS5yb3dzLmxlbmd0aCkgcmV0dXJuIGRhdGEucm93cztcbiAgICAgICAgLy8gQW4gZW1wdHkgcGFnZSBpcyBub3QgcHJvb2Ygb2YgYWJzZW5jZSB3aGVuIHRoZSBzZXJ2ZXIgYWR2ZXJ0aXNlcyBtb3JlIGRhdGEuXG4gICAgICAgIGlmIChkYXRhLm1ldGE/LnNpemUgPiAwIHx8IGRhdGEubWV0YT8ubmV4dEhyZWYgfHwgZGF0YS5tZXRhPy5vZmZzZXQgPiAwKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ9Cf0YDQvtCy0LXRgNC60LAg0LrQvtC90YLRgNCw0LPQtdC90YLQsCDQvdC1INCy0YvQv9C+0LvQvdC10L3QsDog0L3QtdC/0L7Qu9C90YvQuSDQv9C+0LjRgdC6Jyk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJDcmVhdGVBZ2VudChuYW1lLCBwaG9uZSkge1xuICAgIHJldHVybiBtc0FwaVAoJ1BPU1QnLCAnL2VudGl0eS9jb3VudGVycGFydHknLCB7IG5hbWUsIHBob25lIH0pO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJBc3NpZ25BZ2VudChhZ2VudEhyZWYpIHtcbiAgICBjb25zdCBkb2MgPSBoYWNrZXJPcGVuRG9jKCk7XG4gICAgaWYgKCFkb2MpIHtcbiAgICAgICAgaGFja2VyTG9nKCfQntGC0LrRgNC+0LnRgtC1INC60LDRgNGC0L7Rh9C60YMg0LfQsNC60LDQt9CwINC40LvQuCDQvtGC0LPRgNGD0LfQutC4JywgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcign0L3QtdGCINC+0YLQutGA0YvRgtC+0LPQviDQtNC+0LrRg9C80LXQvdGC0LAnKSk7XG4gICAgfVxuICAgIHJldHVybiBtc0FwaVAoJ1BVVCcsICcvZW50aXR5LycgKyBkb2MudHlwZSArICcvJyArIGRvYy5pZCwge1xuICAgICAgICBhZ2VudDoge1xuICAgICAgICAgICAgbWV0YToge1xuICAgICAgICAgICAgICAgIGhyZWY6IGFnZW50SHJlZixcbiAgICAgICAgICAgICAgICB0eXBlOiAnY291bnRlcnBhcnR5JyxcbiAgICAgICAgICAgICAgICBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJ1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSk7XG59XG5cbmxldCBoYWNrZXJBZ2VudENyZWF0ZVBlbmRpbmcgPSBmYWxzZTtcblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyQWdlbnRDcmVhdGVDbGljayhvcHRpb25zID0ge30pIHtcbiAgICBpZiAoaGFja2VyQWdlbnRDcmVhdGVQZW5kaW5nKSByZXR1cm47XG4gICAgY29uc3QgcGhvbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQWdlbnRQaG9uZScpPy52YWx1ZS50cmltKCk7XG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJBZ2VudE5hbWUnKT8udmFsdWUudHJpbSgpO1xuICAgIGNvbnN0IGNoZWNrRmlyc3QgPSBvcHRpb25zLmNoZWNrRmlyc3QgPT09IHRydWUgfHwgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFnZW50Q2hlY2tDcmVhdGUnKT8uY2hlY2tlZDtcbiAgICBpZiAoIXBob25lKSB7IGhhY2tlckxvZygn0JLQstC10LTQuNGC0LUg0L3QvtC80LXRgCDRgtC10LvQtdGE0L7QvdCwJywgJ3dhcm4nKTsgcmV0dXJuOyB9XG4gICAgaWYgKCFuYW1lKSB7IGhhY2tlckxvZygn0JLQstC10LTQuNGC0LUg0KTQmNCeICjQvdCw0LjQvNC10L3QvtCy0LDQvdC40LUg0LrQvtC90YLRgNCw0LPQtdC90YLQsCknLCAnd2FybicpOyByZXR1cm47IH1cblxuICAgIGNvbnN0IGdlbmVyYXRpb24gPSBtc0FwaUdlbmVyYXRpb247XG4gICAgaGFja2VyQWdlbnRDcmVhdGVQZW5kaW5nID0gdHJ1ZTtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQWdlbnRDcmVhdGUnKTtcbiAgICBpZiAoYnV0dG9uKSBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICAgIGxldCBjaGVja2luZyA9ICEhY2hlY2tGaXJzdDtcbiAgICB0cnkge1xuICAgICAgICBpZiAoY2hlY2tGaXJzdCkge1xuICAgICAgICAgICAgaGFja2VyTG9nKCfQmNGJ0YMg0LrQvtC90YLRgNCw0LPQtdC90YLQsCDQv9C+INC90L7QvNC10YDRg+KApicpO1xuICAgICAgICAgICAgY29uc3Qgcm93cyA9IGF3YWl0IGhhY2tlckZpbmRBZ2VudEJ5UGhvbmUocGhvbmUpO1xuICAgICAgICAgICAgaWYgKHJvd3MubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgYSA9IHJvd3NbMF07XG4gICAgICAgICAgICAgICAgaGFja2VyTG9nKGDQndCw0LnQtNC10L06ICR7YS5uYW1lfSAo0YLQtdC70LXRhNC+0L0gJHthLnBob25lIHx8ICfigJQnfSlgLCAnd2FybicpO1xuICAgICAgICAgICAgICAgIGhhY2tlckxvZygn0KHQvtC30LTQsNC90LjQtSDQvdC1INGC0YDQtdCx0YPQtdGC0YHRjycsICdpbmZvJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNoZWNraW5nID0gZmFsc2U7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24pIHRocm93IG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvScpO1xuICAgICAgICBjb25zdCBhZ2VudCA9IGF3YWl0IGhhY2tlckNyZWF0ZUFnZW50KG5hbWUsIHBob25lKTtcbiAgICAgICAgaGFja2VyTG9nKGDinIUg0JrQvtC90YLRgNCw0LPQtdC90YIg0YHQvtC30LTQsNC9OiAke2FnZW50Lm5hbWV9YCwgJ29rJyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaGFja2VyTG9nKChjaGVja2luZyA/ICfQn9GA0L7QstC10YDQutCwINC90LUg0LLRi9C/0L7Qu9C90LXQvdCwLCDRgdC+0LfQtNCw0L3QuNC1INC+0YLQvNC10L3QtdC90L46ICcgOiAn0KHQvtC30LTQsNC90LjQtTogJykgKyBlcnJvci5tZXNzYWdlLCAnZXJyJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaGFja2VyQWdlbnRDcmVhdGVQZW5kaW5nID0gZmFsc2U7XG4gICAgICAgIGlmIChidXR0b24pIGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckFnZW50Q3JlYXRlJyk7XG4gICAgICAgIGlmIChjdXJyZW50KSBjdXJyZW50LmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJBZ2VudENoZWNrQ2xpY2soKSB7XG4gICAgY29uc3QgcGhvbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQWdlbnRQaG9uZScpPy52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFwaG9uZSkgeyBoYWNrZXJMb2coJ9CS0LLQtdC00LjRgtC1INC90L7QvNC10YAg0YLQtdC70LXRhNC+0L3QsCcsICd3YXJuJyk7IHJldHVybjsgfVxuICAgIGhhY2tlckxvZygn0J/RgNC+0LLQtdGA0Y/RjiDQutC+0L3RgtGA0LDQs9C10L3RgtCwINC/0L4g0L3QvtC80LXRgNGD4oCmJyk7XG4gICAgaGFja2VyRmluZEFnZW50QnlQaG9uZShwaG9uZSkudGhlbihyb3dzID0+IHtcbiAgICAgICAgaWYgKCFyb3dzLmxlbmd0aCkge1xuICAgICAgICAgICAgaGFja2VyTG9nKCfQmtC+0L3RgtGA0LDQs9C10L3RgiDQv9C+INGN0YLQvtC80YMg0L3QvtC80LXRgNGDINC90LUg0L3QsNC50LTQtdC9JywgJ3dhcm4nKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByb3dzLmZvckVhY2goKGFnZW50LCBpbmRleCkgPT4ge1xuICAgICAgICAgICAgaGFja2VyTG9nKGDQndCw0LnQtNC10L0gJHtpbmRleCArIDF9OiAke2FnZW50Lm5hbWUgfHwgJ9Cx0LXQtyDQuNC80LXQvdC4J30g4oCUICR7YWdlbnQucGhvbmUgfHwgcGhvbmV9YCwgJ29rJyk7XG4gICAgICAgIH0pO1xuICAgIH0pLmNhdGNoKGVycm9yID0+IGhhY2tlckxvZygn0J/RgNC+0LLQtdGA0LrQsDogJyArIGVycm9yLm1lc3NhZ2UsICdlcnInKSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckFnZW50QXNzaWduQ2xpY2soKSB7XG4gICAgY29uc3QgcGhvbmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQWdlbnRQaG9uZScpPy52YWx1ZS50cmltKCk7XG4gICAgaWYgKCFwaG9uZSkgeyBoYWNrZXJMb2coJ9CS0LLQtdC00LjRgtC1INC90L7QvNC10YAg0YLQtdC70LXRhNC+0L3QsCcsICd3YXJuJyk7IHJldHVybjsgfVxuICAgIHJldHVybiBoYWNrZXJGaW5kQWdlbnRCeVBob25lKHBob25lKS50aGVuKHJvd3MgPT4ge1xuICAgICAgICBpZiAoIXJvd3MubGVuZ3RoKSB7XG4gICAgICAgICAgICBoYWNrZXJMb2coJ9Ca0L7QvdGC0YDQsNCz0LXQvdGCINC/0L4g0Y3RgtC+0LzRgyDQvdC+0LzQtdGA0YMg0L3QtSDQvdCw0LnQtNC10L0nLCAnZXJyJyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYSA9IHJvd3NbMF07XG4gICAgICAgIHJldHVybiBoYWNrZXJBc3NpZ25BZ2VudChhLm1ldGEuaHJlZilcbiAgICAgICAgICAgIC50aGVuKCgpID0+IGhhY2tlckxvZyhg4pyFINCa0L7QvdGC0YDQsNCz0LXQvdGCINC30LDQvNC10L3RkdC9OiAke2EubmFtZX1gLCAnb2snKSk7XG4gICAgfSkuY2F0Y2goZXJyb3IgPT4gaGFja2VyTG9nKCfQl9Cw0LzQtdC90LA6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJykpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJCdWlsZEFnZW50VGFiKCkge1xuICAgIGNvbnN0IHdyYXAgPSBoYWNrZXJFbCgnZGl2Jyk7XG4gICAgd3JhcC5pZCA9ICdoYWNrZXJUYWJTdGF0dXNfQWdlbnQnO1xuXG4gICAgY29uc3QgbGJsUGhvbmUgPSBoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojNjQ3NDhiO21hcmdpbi1ib3R0b206M3B4OycsICfQndC+0LzQtdGAINGC0LXQu9C10YTQvtC90LAnKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGxibFBob25lKTtcbiAgICBjb25zdCBwaG9uZSA9IGhhY2tlckVsKCdpbnB1dCcpO1xuICAgIHBob25lLmlkID0gJ2hhY2tlckFnZW50UGhvbmUnO1xuICAgIHBob25lLnR5cGUgPSAndGV4dCc7XG4gICAgcGhvbmUucGxhY2Vob2xkZXIgPSAnKzcgOTAwIDAwMC0wMC0wMCc7XG4gICAgcGhvbmUuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9JTlBVVF9DU1MgKyAnbWFyZ2luLWJvdHRvbTo2cHg7JztcbiAgICB3cmFwLmFwcGVuZENoaWxkKHBob25lKTtcblxuICAgIGNvbnN0IGxibE5hbWUgPSBoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMHB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjojNjQ3NDhiO21hcmdpbi1ib3R0b206M3B4OycsICfQpNCY0J4gKNC90LDQuNC80LXQvdC+0LLQsNC90LjQtSknKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGxibE5hbWUpO1xuICAgIGNvbnN0IG5hbWUgPSBoYWNrZXJFbCgnaW5wdXQnKTtcbiAgICBuYW1lLmlkID0gJ2hhY2tlckFnZW50TmFtZSc7XG4gICAgbmFtZS50eXBlID0gJ3RleHQnO1xuICAgIG5hbWUucGxhY2Vob2xkZXIgPSAn0JjQstCw0L3QvtCyINCY0LLQsNC9INCY0LLQsNC90L7QstC40YcnO1xuICAgIG5hbWUuc3R5bGUuY3NzVGV4dCA9IEhBQ0tFUl9JTlBVVF9DU1MgKyAnbWFyZ2luLWJvdHRvbTo2cHg7JztcbiAgICB3cmFwLmFwcGVuZENoaWxkKG5hbWUpO1xuXG4gICAgY29uc3Qgcm93ID0gaGFja2VyRWwoJ2RpdicsICdkaXNwbGF5OmZsZXg7Z2FwOjVweDttYXJnaW4tYm90dG9tOjhweDsnKTtcbiAgICBjb25zdCBjaGVjayA9IGhhY2tlckJ0bignaGFja2VyQWdlbnRDaGVjaycsICfQn9GA0L7QstC10YDQuNGC0YwnLFxuICAgICAgICBIQUNLRVJfQlROX0NTUyArICdiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzY0NzQ4YiwjNDc1NTY5KTtmbGV4OjE7Jyk7XG4gICAgY2hlY2suYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBoYWNrZXJBZ2VudENoZWNrQ2xpY2spO1xuICAgIGNvbnN0IGFzc2lnbiA9IGhhY2tlckJ0bignaGFja2VyQWdlbnRBc3NpZ24nLCAn0J/QvtC80LXQvdGP0YLRjCcsXG4gICAgICAgIEhBQ0tFUl9CVE5fQ1NTICsgJ2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZywjM2I4MmY2LCMyNTYzZWIpO2ZsZXg6MTsnKTtcbiAgICBhc3NpZ24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBoYWNrZXJBZ2VudEFzc2lnbkNsaWNrKTtcbiAgICBjb25zdCBjcmVhdGUgPSBoYWNrZXJCdG4oJ2hhY2tlckFnZW50Q3JlYXRlJywgJ9Ch0L7Qt9C00LDRgtGMJyxcbiAgICAgICAgSEFDS0VSX0JUTl9DU1MgKyAnYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMyMmM1NWUsIzE2YTM0YSk7ZmxleDoxOycpO1xuICAgIGNyZWF0ZS5kaXNhYmxlZCA9IGhhY2tlckFnZW50Q3JlYXRlUGVuZGluZztcbiAgICBjcmVhdGUuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBoYWNrZXJBZ2VudENyZWF0ZUNsaWNrKTtcbiAgICByb3cuYXBwZW5kQ2hpbGQoY2hlY2spO1xuICAgIHJvdy5hcHBlbmRDaGlsZChhc3NpZ24pO1xuICAgIHJvdy5hcHBlbmRDaGlsZChjcmVhdGUpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQocm93KTtcblxuICAgIGNvbnN0IG1rQ2hlY2sgPSAoaWQsIGxhYmVsKSA9PiB7XG4gICAgICAgIGNvbnN0IGxibCA9IGhhY2tlckVsKCdsYWJlbCcsICdkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHg7Y29sb3I6IzQ3NTU2OTtmb250LXNpemU6MTFweDttYXJnaW4tYm90dG9tOjVweDtjdXJzb3I6cG9pbnRlcjsnKTtcbiAgICAgICAgY29uc3QgY2IgPSBoYWNrZXJFbCgnaW5wdXQnKTtcbiAgICAgICAgY2IudHlwZSA9ICdjaGVja2JveCc7XG4gICAgICAgIGNiLmlkID0gaWQ7XG4gICAgICAgIGNiLnN0eWxlLmNzc1RleHQgPSAnYWNjZW50LWNvbG9yOiM2MzY2ZjE7d2lkdGg6MTNweDtoZWlnaHQ6MTNweDsnO1xuICAgICAgICBsYmwuYXBwZW5kQ2hpbGQoY2IpO1xuICAgICAgICBsYmwuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUobGFiZWwpKTtcbiAgICAgICAgcmV0dXJuIGxibDtcbiAgICB9O1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQobWtDaGVjaygnaGFja2VyQWdlbnRDaGVja0NyZWF0ZScsICfQn9GA0L7QstC10YDQuNGC0Ywg0Lgg0LXRgdC70Lgg0L3QtdGCIOKAlCDRgdC+0LfQtNCw0YLRjCcpKTtcbiAgICByZXR1cm4gd3JhcDtcbn1cblxuLy8g4pSA4pSA4pSAINCe0LHRidC40LUg0YHQv9GA0LDQstC+0YfQvdC40LrQuCDQuCBoZWxwZXJzINGA0YPRh9C90L7Qs9C+INGB0L7Qt9C00LDQvdC40Y8g0LTQvtC60YPQvNC10L3RgtC+0LIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiBoYWNrZXJBcGlQYXRoKGhyZWYpIHtcbiAgICBpZiAoIWhyZWYpIHJldHVybiAnJztcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhocmVmKTtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTCh2YWx1ZS5zdGFydHNXaXRoKCcvJykgPyBNU19BUElfQkFTRSArIHZhbHVlIDogdmFsdWUsIE1TX0FQSV9CQVNFICsgJy8nKTtcbiAgICAgICAgY29uc3QgYmFzZSA9IG5ldyBVUkwoTVNfQVBJX0JBU0UpO1xuICAgICAgICBpZiAodXJsLm9yaWdpbiAhPT0gYmFzZS5vcmlnaW4gfHwgIXVybC5wYXRobmFtZS5zdGFydHNXaXRoKGJhc2UucGF0aG5hbWUgKyAnLycpKSByZXR1cm4gJyc7XG4gICAgICAgIHJldHVybiB1cmwucGF0aG5hbWUuc2xpY2UoYmFzZS5wYXRobmFtZS5sZW5ndGgpICsgdXJsLnNlYXJjaDtcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlck1ldGFSZWYoaHJlZiwgdHlwZSkge1xuICAgIHJldHVybiB7IGhyZWYsIHR5cGUsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL2pzb24nIH07XG59XG5cbmZ1bmN0aW9uIGhhY2tlcklzRHVwbGljYXRlTmFtZUVycm9yKGVycm9yKSB7XG4gICAgcmV0dXJuIC/QuNC80Y980L3QsNC30LLQsNC9fNC00YPQsdC70LjQutCw0YJ80YPQttC1INGB0YPRidC10YHRgtCy0YPQtdGCfNC30LDQvdGP0YJ8ZHVwbGljYXRlfG5hbWUvaS50ZXN0KFN0cmluZyhlcnJvcj8ubWVzc2FnZSB8fCBlcnJvcikpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJQb3N0V2l0aE5hbWVSZXRyeShlbnRpdHlUeXBlLCBib2R5LCBiYXNlTmFtZSwgbWF4QXR0ZW1wdHMgPSAxMCkge1xuICAgIGxldCBsYXN0RXJyb3I7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBtYXhBdHRlbXB0czsgaSArPSAxKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBpID09PSAwID8gYmFzZU5hbWUgOiBgJHtiYXNlTmFtZX0tJHtpfWA7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgbXNBcGlQKCdQT1NUJywgJy9lbnRpdHkvJyArIGVudGl0eVR5cGUsIHsgLi4uYm9keSwgbmFtZSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xuICAgICAgICAgICAgaWYgKCFoYWNrZXJJc0R1cGxpY2F0ZU5hbWVFcnJvcihlcnJvcikpIHRocm93IGVycm9yO1xuICAgICAgICAgICAgaGFja2VyTG9nKGDQmNC80Y8gwqske25hbWV9wrsg0LfQsNC90Y/RgtC+LCDQv9GA0L7QsdGD0Y4gwqske2Jhc2VOYW1lfS0ke2kgKyAxfcK74oCmYCwgJ3dhcm4nKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICB0aHJvdyBsYXN0RXJyb3IgfHwgbmV3IEVycm9yKCfQndC1INGD0LTQsNC70L7RgdGMINGB0L7Qt9C00LDRgtGMINC00L7QutGD0LzQtdC90YIg0YEg0YPQvdC40LrQsNC70YzQvdGL0Lwg0LjQvNC10L3QtdC8Jyk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckZldGNoTWV0YWRhdGFBdHRyaWJ1dGUoZW50aXR5VHlwZSwgYXR0ck5hbWUpIHtcbiAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCAnL2VudGl0eS8nICsgZW50aXR5VHlwZSArICcvbWV0YWRhdGEnKS50aGVuKG1ldGEgPT4ge1xuICAgICAgICBjb25zdCBocmVmID0gbWV0YS5hdHRyaWJ1dGVzPy5tZXRhPy5ocmVmO1xuICAgICAgICBpZiAoIWhyZWYpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKGhyZWYpKS50aGVuKGRhdGEgPT5cbiAgICAgICAgICAgIChkYXRhLnJvd3MgfHwgW10pLmZpbmQoYSA9PiBhLm5hbWUgPT09IGF0dHJOYW1lIHx8IG5ldyBSZWdFeHAoYXR0ck5hbWUsICdpJykudGVzdChhLm5hbWUgfHwgJycpKSB8fCBudWxsXG4gICAgICAgICk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckZldGNoRGVtYW5kQ2hhbm5lbEF0dHJpYnV0ZShvcmRlciwgY2hhbm5lbE5hbWUpIHtcbiAgICBjb25zdCBzb3VyY2UgPSAoQXJyYXkuaXNBcnJheShvcmRlci5hdHRyaWJ1dGVzKSA/IG9yZGVyLmF0dHJpYnV0ZXMgOiAob3JkZXIuYXR0cmlidXRlcz8ucm93cyB8fCBbXSkpXG4gICAgICAgIC5maW5kKGEgPT4gL9C60LDQvdCw0Lsg0L/RgNC+0LTQsNC2L2kudGVzdChhLm5hbWUgfHwgJycpKTtcbiAgICByZXR1cm4gaGFja2VyRmV0Y2hNZXRhZGF0YUF0dHJpYnV0ZSgnZGVtYW5kJywgJ9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2JykudGhlbihhdHRyID0+IHtcbiAgICAgICAgaWYgKCFhdHRyPy5tZXRhPy5ocmVmIHx8ICFhdHRyLmN1c3RvbUVudGl0eU1ldGE/LmhyZWYpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKGF0dHIuY3VzdG9tRW50aXR5TWV0YS5ocmVmKSkudGhlbihjdXN0b21NZXRhID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlc0hyZWYgPSBjdXN0b21NZXRhLmVudGl0eU1ldGE/LmhyZWY7XG4gICAgICAgICAgICBpZiAoIXZhbHVlc0hyZWYpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgcmV0dXJuIG1zQXBpUCgnR0VUJywgaGFja2VyQXBpUGF0aCh2YWx1ZXNIcmVmKSkudGhlbih2YWx1ZXMgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvd3MgPSB2YWx1ZXMucm93cyB8fCBbXTtcbiAgICAgICAgICAgICAgICBjb25zdCB3YW50ZWQgPSBjaGFubmVsTmFtZSB8fCBzb3VyY2U/LnZhbHVlPy5uYW1lIHx8ICcnO1xuICAgICAgICAgICAgICAgIGNvbnN0IG5vcm1hbGl6ZSA9IHZhbHVlID0+IFN0cmluZyh2YWx1ZSB8fCAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSByb3dzLmZpbmQocm93ID0+IG5vcm1hbGl6ZShyb3cubmFtZSkgPT09IG5vcm1hbGl6ZSh3YW50ZWQpKVxuICAgICAgICAgICAgICAgICAgICB8fCByb3dzLmZpbmQocm93ID0+IG5vcm1hbGl6ZShyb3cubmFtZSkuaW5jbHVkZXMobm9ybWFsaXplKHdhbnRlZCkpIHx8IG5vcm1hbGl6ZSh3YW50ZWQpLmluY2x1ZGVzKG5vcm1hbGl6ZShyb3cubmFtZSkpKTtcbiAgICAgICAgICAgICAgICBpZiAoIW1hdGNoPy5tZXRhPy5ocmVmKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBtZXRhOiBoYWNrZXJNZXRhUmVmKGF0dHIubWV0YS5ocmVmLCAnYXR0cmlidXRlbWV0YWRhdGEnKSxcbiAgICAgICAgICAgICAgICAgICAgdmFsdWU6IHsgbWV0YTogaGFja2VyTWV0YVJlZihtYXRjaC5tZXRhLmhyZWYsICdjdXN0b21lbnRpdHknKSB9XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyRmV0Y2hBdHRyVmFsdWVzKGVudGl0eVR5cGUsIGF0dHJOYW1lKSB7XG4gICAgcmV0dXJuIG1zQXBpUCgnR0VUJywgJy9lbnRpdHkvJyArIGVudGl0eVR5cGUgKyAnL21ldGFkYXRhJykudGhlbihtZXRhID0+IHtcbiAgICAgICAgLy8g0JIg0YDQtdCw0LvRjNC90L7QvCDQvtGC0LLQtdGC0LUgbWV0YWRhdGEuYXR0cmlidXRlcyDigJQgbWV0YS3RgdGB0YvQu9C60LAsINC90LUg0LzQsNGB0YHQuNCyLlxuICAgICAgICBjb25zdCBhdHRyc1JlZiA9IG1ldGEuYXR0cmlidXRlcz8ubWV0YT8uaHJlZjtcbiAgICAgICAgY29uc3QgYXR0cnNQcm9taXNlID0gYXR0cnNSZWZcbiAgICAgICAgICAgID8gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKGF0dHJzUmVmKSlcbiAgICAgICAgICAgIDogUHJvbWlzZS5yZXNvbHZlKG1ldGEuYXR0cmlidXRlcyk7XG4gICAgICAgIHJldHVybiBhdHRyc1Byb21pc2UudGhlbihhdHRyc0RhdGEgPT4ge1xuICAgICAgICAgICAgY29uc3QgcmF3QXR0cnMgPSBhdHRyc0RhdGE/LnJvd3MgfHwgYXR0cnNEYXRhO1xuICAgICAgICAgICAgY29uc3QgYXR0cnMgPSBBcnJheS5pc0FycmF5KHJhd0F0dHJzKVxuICAgICAgICAgICAgICAgID8gcmF3QXR0cnNcbiAgICAgICAgICAgICAgICA6IChyYXdBdHRycyAmJiB0eXBlb2YgcmF3QXR0cnMgPT09ICdvYmplY3QnID8gT2JqZWN0LnZhbHVlcyhyYXdBdHRycykgOiBbXSk7XG4gICAgICAgICAgICBjb25zdCBhdHRyID0gYXR0cnMuZmluZChhID0+IGEgJiYgYS5uYW1lID09PSBhdHRyTmFtZSk7XG4gICAgICAgICAgICBjb25zdCBjdXN0b21NZXRhSHJlZiA9IGF0dHI/LmN1c3RvbUVudGl0eU1ldGE/LmhyZWY7XG4gICAgICAgICAgICBpZiAoIWN1c3RvbU1ldGFIcmVmKSB7XG4gICAgICAgICAgICAgICAgaGFja2VyTG9nKGDQodC/0YDQsNCy0L7Rh9C90LjQuiDCqyR7YXR0ck5hbWV9wrsg0L3QtSDQvdCw0LnQtNC10L0g0LIgbWV0YWRhdGEgJHtlbnRpdHlUeXBlfWAsICd3YXJuJyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gY3VzdG9tRW50aXR5TWV0YSDigJQg0LzQtdGC0LDQtNCw0L3QvdGL0LUuINCX0L3QsNGH0LXQvdC40Y8g0LvQtdC20LDRgiDQv9C+IGVudGl0eU1ldGEuaHJlZi5cbiAgICAgICAgICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsIGhhY2tlckFwaVBhdGgoY3VzdG9tTWV0YUhyZWYpKS50aGVuKGN1c3RvbU1ldGEgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlc0hyZWYgPSBjdXN0b21NZXRhLmVudGl0eU1ldGE/LmhyZWY7XG4gICAgICAgICAgICAgICAgaWYgKCF2YWx1ZXNIcmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhY2tlckxvZyhg0KMg0YHQv9GA0LDQstC+0YfQvdC40LrQsCDCqyR7YXR0ck5hbWV9wrsg0L3QtdGCINGB0YHRi9C70LrQuCDQvdCwINC30L3QsNGH0LXQvdC40Y9gLCAnd2FybicpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsIGhhY2tlckFwaVBhdGgodmFsdWVzSHJlZikpLnRoZW4odmFsdWVzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6ICh2YWx1ZXMucm93cyB8fCBbXSk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByb3dzLm1hcChyID0+ICh7IG5hbWU6IHIubmFtZSwgaHJlZjogci5tZXRhPy5ocmVmIH0pKVxuICAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihyID0+IHIuaHJlZik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlclJlZnJlc2hDYXNoUGF5VHlwZSgpIHtcbiAgICByZXR1cm4gaGFja2VyRmV0Y2hBdHRyVmFsdWVzKCdjYXNoaW4nLCBIQUNLRVJfQVRUUl9QQVlfVFlQRSkudGhlbihpdGVtcyA9PiB7XG4gICAgICAgIGNvbnN0IGNhc2ggPSBpdGVtcy5maW5kKGl0ZW0gPT4gaXRlbS5uYW1lID09PSBIQUNLRVJfQ0FTSF9QQVlfTkFNRSB8fCAv0L3QsNC70LjRh9C9L2kudGVzdChpdGVtLm5hbWUpKTtcbiAgICAgICAgcmV0dXJuIGNhc2g/LmhyZWYgfHwgbnVsbDtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyUmVmcmVzaENsaWVudFN0YXR1c2VzKHF1aWV0KSB7XG4gICAgcmV0dXJuIGhhY2tlckZldGNoQXR0clZhbHVlcygnY2FzaGluJywgSEFDS0VSX0FUVFJfQ0xJRU5UX1NUQVRVUylcbiAgICAgICAgLnRoZW4oaXRlbXMgPT4ge1xuICAgICAgICAgICAgaGFja2VyRmlsbFNlbGVjdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQ2xpZW50U3RhdHVzU2VsZWN0JyksIGl0ZW1zLCB0cnVlKTtcbiAgICAgICAgICAgIGlmICghcXVpZXQpIGhhY2tlckxvZyhgwqvQodGC0LDRgtGD0YEg0LrQu9C40LXQvdGC0LDCuyDQvtCx0L3QvtCy0LvRkdC9OiAke2l0ZW1zLmxlbmd0aH0g0YjRgi5gLCAnb2snKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IGhhY2tlckxvZygn0KHRgtCw0YLRg9GBINC60LvQuNC10L3RgtCwOiAnICsgZXJyb3IubWVzc2FnZSwgJ2VycicpKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyUmVmcmVzaFBheU1ldGhvZHMocXVpZXQpIHtcbiAgICByZXR1cm4gaGFja2VyRmV0Y2hBdHRyVmFsdWVzKCdwYXltZW50aW4nLCBIQUNLRVJfQVRUUl9QQVlfTUVUSE9EKVxuICAgICAgICAudGhlbihpdGVtcyA9PiB7XG4gICAgICAgICAgICBoYWNrZXJGaWxsU2VsZWN0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJQYXlNZXRob2RTZWxlY3QnKSwgaXRlbXMsIHRydWUpO1xuICAgICAgICAgICAgaWYgKCFxdWlldCkgaGFja2VyTG9nKGDCq9Ch0L/QvtGB0L7QsSDQvtC/0LvQsNGC0YvCuyDQvtCx0L3QvtCy0LvRkdC9OiAke2l0ZW1zLmxlbmd0aH0g0YjRgi5gLCAnb2snKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IGhhY2tlckxvZygn0KHQv9C+0YHQvtCxINC+0L/Qu9Cw0YLRizogJyArIGVycm9yLm1lc3NhZ2UsICdlcnInKSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlckZldGNoQ3VzdG9tQ2hhbm5lbFZhbHVlcygpIHtcbiAgICByZXR1cm4gaGFja2VyRmV0Y2hNZXRhZGF0YUF0dHJpYnV0ZSgnZGVtYW5kJywgJ9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2JykudGhlbihhdHRyID0+IHtcbiAgICAgICAgaWYgKCFhdHRyPy5jdXN0b21FbnRpdHlNZXRhPy5ocmVmKSByZXR1cm4gW107XG4gICAgICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsIGhhY2tlckFwaVBhdGgoYXR0ci5jdXN0b21FbnRpdHlNZXRhLmhyZWYpKS50aGVuKG1ldGEgPT4ge1xuICAgICAgICAgICAgY29uc3QgaHJlZiA9IG1ldGEuZW50aXR5TWV0YT8uaHJlZjtcbiAgICAgICAgICAgIHJldHVybiBocmVmID8gbXNBcGlQKCdHRVQnLCBoYWNrZXJBcGlQYXRoKGhyZWYpKSA6IHsgcm93czogW10gfTtcbiAgICAgICAgfSkudGhlbihkYXRhID0+IChkYXRhLnJvd3MgfHwgW10pLm1hcChyb3cgPT4gKHtcbiAgICAgICAgICAgIG5hbWU6IHJvdy5uYW1lLFxuICAgICAgICAgICAgaHJlZjogcm93Lm1ldGE/LmhyZWZcbiAgICAgICAgfSkpLmZpbHRlcihyb3cgPT4gcm93LmhyZWYpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyUmVmcmVzaFNhbGVzQ2hhbm5lbHMocXVpZXQpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgICBtc0FwaVAoJ0dFVCcsICcvZW50aXR5L3NhbGVzY2hhbm5lbD9saW1pdD0xMDAwJyksXG4gICAgICAgIGhhY2tlckZldGNoQ3VzdG9tQ2hhbm5lbFZhbHVlcygpXG4gICAgXSkudGhlbigoW2RhdGEsIGN1c3RvbVZhbHVlc10pID0+IHtcbiAgICAgICAgY29uc3Qgc3lzdGVtcyA9IGRhdGEucm93cyB8fCBbXTtcbiAgICAgICAgaGFja2VyU2FsZXNDaGFubmVscyA9IHN5c3RlbXMubWFwKHJvdyA9PiB7XG4gICAgICAgICAgICBjb25zdCBjdXN0b20gPSBjdXN0b21WYWx1ZXMuZmluZCh2YWx1ZSA9PiB2YWx1ZS5uYW1lID09PSByb3cubmFtZSk7XG4gICAgICAgICAgICByZXR1cm4geyBuYW1lOiByb3cubmFtZSwgaHJlZjogcm93Lm1ldGE/LmhyZWYsIGN1c3RvbUhyZWY6IGN1c3RvbT8uaHJlZiB9O1xuICAgICAgICB9KS5maWx0ZXIocm93ID0+IHJvdy5ocmVmKTtcbiAgICAgICAgaGFja2VyRmlsbFNlbGVjdChkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQ2hhbm5lbFNlbGVjdCcpLCBoYWNrZXJTYWxlc0NoYW5uZWxzLCB0cnVlKTtcbiAgICAgICAgaWYgKCFxdWlldCkgaGFja2VyTG9nKGDQmtCw0L3QsNC70Ysg0L/RgNC+0LTQsNC2INC+0LHQvdC+0LLQu9C10L3RizogJHtoYWNrZXJTYWxlc0NoYW5uZWxzLmxlbmd0aH0g0YjRgi5gLCAnb2snKTtcbiAgICB9KS5jYXRjaChlcnJvciA9PiBoYWNrZXJMb2coJ9Ca0LDQvdCw0LvRiyDQv9GA0L7QtNCw0LY6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJykpO1xufVxuXG4vLyDilIDilIDilIAg0KDRg9GH0L3Ri9C1INC+0L/QtdGA0LDRhtC40Lg6INC+0YLQs9GA0YPQt9C60LAgLyDQn9Ca0J4gLyDQstGF0L7QtNGP0YnQuNC5INC/0LvQsNGC0ZHQtiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIGhhY2tlckJ1aWxkQXR0ckJvZHkoZW50aXR5VHlwZSwgYXR0ck5hbWUsIHZhbHVlSHJlZikge1xuICAgIGlmICghdmFsdWVIcmVmKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuICAgIHJldHVybiBoYWNrZXJGZXRjaE1ldGFkYXRhQXR0cmlidXRlKGVudGl0eVR5cGUsIGF0dHJOYW1lKS50aGVuKGF0dHIgPT4ge1xuICAgICAgICBpZiAoIWF0dHIpIHJldHVybiBudWxsO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbWV0YToge1xuICAgICAgICAgICAgICAgIGhyZWY6IE1TX0FQSV9CQVNFICsgJy9lbnRpdHkvJyArIGVudGl0eVR5cGUgKyAnL21ldGFkYXRhL2F0dHJpYnV0ZXMvJyArIGF0dHIuaWQsXG4gICAgICAgICAgICAgICAgdHlwZTogJ2F0dHJpYnV0ZW1ldGFkYXRhJyxcbiAgICAgICAgICAgICAgICBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJ1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgICAgICAgbWV0YToge1xuICAgICAgICAgICAgICAgICAgICBocmVmOiB2YWx1ZUhyZWYsXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdjdXN0b21lbnRpdHknLFxuICAgICAgICAgICAgICAgICAgICBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJ1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTWFya1JlcXVpcmVkU2VsZWN0KGlkLCBtZXNzYWdlKSB7XG4gICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gICAgaWYgKGVsKSB7XG4gICAgICAgIGVsLnN0eWxlLmJvcmRlckNvbG9yID0gJyNlZjQ0NDQnO1xuICAgICAgICBlbC5zdHlsZS5ib3hTaGFkb3cgPSAnMCAwIDAgMnB4ICNlZjQ0NDQzMyc7XG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBpZiAoZWwuaXNDb25uZWN0ZWQpIHsgZWwuc3R5bGUuYm9yZGVyQ29sb3IgPSAnI2NiZDVlMSc7IGVsLnN0eWxlLmJveFNoYWRvdyA9ICcnOyB9IH0sIDI1MDApO1xuICAgIH1cbiAgICBoYWNrZXJMb2cobWVzc2FnZSwgJ3dhcm4nKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyU2V0QWN0aW9uQnVzeShidXN5KSB7XG4gICAgaGFja2VyQnVzeSA9IGJ1c3k7XG4gICAgWydoYWNrZXJDcmVhdGVEZW1hbmQnLCAnaGFja2VyQ3JlYXRlQ2FzaGluJywgJ2hhY2tlckNyZWF0ZVBheW1lbnRpbicsICdoYWNrZXJDcmVhdGVDcmVkaXQnXS5mb3JFYWNoKGlkID0+IHtcbiAgICAgICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuICAgICAgICBpZiAoYnV0dG9uKSB7IGJ1dHRvbi5kaXNhYmxlZCA9IGJ1c3k7IGJ1dHRvbi5zdHlsZS5vcGFjaXR5ID0gYnVzeSA/ICcuNicgOiAnMSc7IH1cbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQ3VycmVudE9yZGVyKCkge1xuICAgIGNvbnN0IGRvYyA9IGhhY2tlck9wZW5Eb2MoKTtcbiAgICBpZiAoIWRvYyB8fCAhWydjdXN0b21lcm9yZGVyJywgJ2RlbWFuZCddLmluY2x1ZGVzKGRvYy50eXBlKSkge1xuICAgICAgICBoYWNrZXJMb2coJ9Ce0YLQutGA0L7QudGC0LUg0LrQsNGA0YLQvtGH0LrRgyDQt9Cw0LrQsNC30LAg0LjQu9C4INC+0YLQs9GA0YPQt9C60LgnLCAnd2FybicpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIGRvYztcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyR2V0T3JkZXIoKSB7XG4gICAgY29uc3QgZG9jID0gaGFja2VyQ3VycmVudE9yZGVyKCk7XG4gICAgaWYgKCFkb2MpIHRocm93IG5ldyBFcnJvcign0L3QtdGCINC+0YLQutGA0YvRgtC+0LPQviDQt9Cw0LrQsNC30LAg0LjQu9C4INC+0YLQs9GA0YPQt9C60LgnKTtcbiAgICBpZiAoZG9jLnR5cGUgPT09ICdkZW1hbmQnKSB7XG4gICAgICAgIGNvbnN0IGRlbWFuZCA9IGhhY2tlckxhc3REZW1hbmQ/LmlkID09PSBkb2MuaWRcbiAgICAgICAgICAgID8gaGFja2VyTGFzdERlbWFuZFxuICAgICAgICAgICAgOiBhd2FpdCBtc0FwaVAoJ0dFVCcsICcvZW50aXR5L2RlbWFuZC8nICsgZG9jLmlkICsgJz9leHBhbmQ9Y3VzdG9tZXJPcmRlcicpO1xuICAgICAgICBoYWNrZXJMYXN0RGVtYW5kID0gZGVtYW5kO1xuICAgICAgICBjb25zdCBvcmRlcklkID0gZGVtYW5kLmN1c3RvbWVyT3JkZXI/Lm1ldGE/LmhyZWY/LnNwbGl0KCcvJykucG9wKCkgfHwgJyc7XG4gICAgICAgIGhhY2tlckNvbnRleHQgPSB7IGN1c3RvbWVyT3JkZXJJZDogb3JkZXJJZCwgZGVtYW5kSWQ6IGRvYy5pZCB9O1xuICAgICAgICByZXR1cm4geyBkb2MsIG9yZGVyOiBkZW1hbmQgfTtcbiAgICB9XG4gICAgY29uc3Qgb3JkZXIgPSBoYWNrZXJPcmRlckluZm8gJiYgaGFja2VyT3JkZXJJbmZvLmlkID09PSBkb2MuaWRcbiAgICAgICAgPyBoYWNrZXJPcmRlckluZm9cbiAgICAgICAgOiBhd2FpdCBtc0FwaVAoJ0dFVCcsICcvZW50aXR5L2N1c3RvbWVyb3JkZXIvJyArIGRvYy5pZCArICc/ZXhwYW5kPXBvc2l0aW9ucy5hc3NvcnRtZW50Jyk7XG4gICAgaGFja2VyT3JkZXJJbmZvID0gb3JkZXI7XG4gICAgaGFja2VyQ29udGV4dCA9IHsgY3VzdG9tZXJPcmRlcklkOiBkb2MuaWQsIGRlbWFuZElkOiBoYWNrZXJDb250ZXh0LmN1c3RvbWVyT3JkZXJJZCA9PT0gZG9jLmlkID8gaGFja2VyQ29udGV4dC5kZW1hbmRJZCA6ICcnIH07XG4gICAgcmV0dXJuIHsgZG9jLCBvcmRlciB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJCdWlsZERlbWFuZEJvZHkob3JkZXIsIGRvYykge1xuICAgIGNvbnN0IGRlbWFuZEJvZHkgPSB7XG4gICAgICAgIG1vbWVudDogb3JkZXIubW9tZW50LFxuICAgICAgICBvcmdhbml6YXRpb246IG9yZGVyLm9yZ2FuaXphdGlvbixcbiAgICAgICAgYWdlbnQ6IG9yZGVyLmFnZW50LFxuICAgICAgICBzdG9yZTogb3JkZXIuc3RvcmUsXG4gICAgICAgIGN1c3RvbWVyT3JkZXI6IHsgbWV0YTogaGFja2VyTWV0YVJlZihNU19BUElfQkFTRSArICcvZW50aXR5L2N1c3RvbWVyb3JkZXIvJyArIGRvYy5pZCwgJ2N1c3RvbWVyb3JkZXInKSB9LFxuICAgICAgICBwb3NpdGlvbnM6IChBcnJheS5pc0FycmF5KG9yZGVyLnBvc2l0aW9ucykgPyBvcmRlci5wb3NpdGlvbnMgOiAob3JkZXIucG9zaXRpb25zPy5yb3dzIHx8IFtdKSkubWFwKHBvc2l0aW9uID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNvcHkgPSB7IGFzc29ydG1lbnQ6IHBvc2l0aW9uLmFzc29ydG1lbnQsIHF1YW50aXR5OiBwb3NpdGlvbi5xdWFudGl0eSwgcHJpY2U6IHBvc2l0aW9uLnByaWNlIH07XG4gICAgICAgICAgICBbJ2Rpc2NvdW50JywgJ3ZhdCcsICdwYWNrJywgJ3RoaW5ncycsICdyZXNlcnZlJ10uZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChwb3NpdGlvbltrZXldICE9PSB1bmRlZmluZWQpIGNvcHlba2V5XSA9IHBvc2l0aW9uW2tleV07XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBjb3B5O1xuICAgICAgICB9KVxuICAgIH07XG4gICAgbGV0IGNoYW5uZWxIcmVmID0gaGFja2VyRGVmYXVsdENoYW5uZWwgfHwgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckNoYW5uZWxTZWxlY3QnKT8udmFsdWUgfHwgJyc7XG4gICAgbGV0IGNoYW5uZWxOb3RlID0gaGFja2VyRGVmYXVsdENoYW5uZWwgPyAn0L/QviDRg9C80L7Qu9GH0LDQvdC40Y4nIDogJ9C60LDQuiDQstGL0LHRgNCw0L3Qvic7XG4gICAgaWYgKCFjaGFubmVsSHJlZiAmJiBvcmRlci5zYWxlc0NoYW5uZWw/Lm1ldGE/LmhyZWYpIHtcbiAgICAgICAgY2hhbm5lbEhyZWYgPSBvcmRlci5zYWxlc0NoYW5uZWwubWV0YS5ocmVmO1xuICAgICAgICBjaGFubmVsTm90ZSA9ICfQutCw0Log0LIg0LfQsNC60LDQt9C1JztcbiAgICB9XG4gICAgaWYgKCFjaGFubmVsSHJlZikge1xuICAgICAgICBpZiAoIWhhY2tlclNhbGVzQ2hhbm5lbHMubGVuZ3RoKSBhd2FpdCBoYWNrZXJSZWZyZXNoU2FsZXNDaGFubmVscyh0cnVlKTtcbiAgICAgICAgY29uc3QgcmFuZG9tID0gaGFja2VyU2FsZXNDaGFubmVsc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBoYWNrZXJTYWxlc0NoYW5uZWxzLmxlbmd0aCldO1xuICAgICAgICBjaGFubmVsSHJlZiA9IHJhbmRvbT8uaHJlZiB8fCAnJztcbiAgICAgICAgY2hhbm5lbE5vdGUgPSAn0YDQsNC90LTQvtC8JztcbiAgICB9XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBoYWNrZXJTYWxlc0NoYW5uZWxzLmZpbmQoaXRlbSA9PiBpdGVtLmhyZWYgPT09IGNoYW5uZWxIcmVmKTtcbiAgICBpZiAoIXNlbGVjdGVkPy5jdXN0b21IcmVmKSB0aHJvdyBuZXcgRXJyb3IoJ9CU0LvRjyDQstGL0LHRgNCw0L3QvdC+0LPQviDQutCw0L3QsNC70LAg0L/RgNC+0LTQsNC2INC90LUg0L3QsNC50LTQtdC90L4g0LfQvdCw0YfQtdC90LjQtSDQsNGC0YDQuNCx0YPRgtCwINC+0YLQs9GA0YPQt9C60LgnKTtcbiAgICBkZW1hbmRCb2R5LnNhbGVzQ2hhbm5lbCA9IHsgbWV0YTogaGFja2VyTWV0YVJlZihjaGFubmVsSHJlZiwgJ3NhbGVzY2hhbm5lbCcpIH07XG4gICAgY29uc3QgYXR0ciA9IGF3YWl0IGhhY2tlckZldGNoTWV0YWRhdGFBdHRyaWJ1dGUoJ2RlbWFuZCcsICfQmtCw0L3QsNC7INC/0YDQvtC00LDQticpO1xuICAgIGlmICghYXR0cj8ubWV0YT8uaHJlZikgdGhyb3cgbmV3IEVycm9yKCfQkiDQvtGC0LPRgNGD0LfQutC1INC90LUg0L3QsNC50LTQtdC9INC+0LHRj9C30LDRgtC10LvRjNC90YvQuSDQsNGC0YDQuNCx0YPRgiDCq9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2wrsnKTtcbiAgICBkZW1hbmRCb2R5LmF0dHJpYnV0ZXMgPSBbe1xuICAgICAgICBtZXRhOiBoYWNrZXJNZXRhUmVmKGF0dHIubWV0YS5ocmVmLCAnYXR0cmlidXRlbWV0YWRhdGEnKSxcbiAgICAgICAgdmFsdWU6IHsgbWV0YTogaGFja2VyTWV0YVJlZihzZWxlY3RlZC5jdXN0b21IcmVmLCAnY3VzdG9tZW50aXR5JykgfVxuICAgIH1dO1xuICAgIGhhY2tlckxvZyhg0JrQsNC90LDQuyDQv9GA0L7QtNCw0LYg0L7RgtCz0YDRg9C30LrQuDogJHtjaGFubmVsTm90ZX1gKTtcbiAgICBoYWNrZXJMb2coJ9Ca0LDQvdCw0Lsg0L/RgNC+0LTQsNC2INC/0YDQvtC00YPQsdC70LjRgNC+0LLQsNC9INCyINCw0YLRgNC40LHRg9GCINC+0YLQs9GA0YPQt9C60LgnKTtcbiAgICByZXR1cm4gZGVtYW5kQm9keTtcbn1cblxuZnVuY3Rpb24gaGFja2VyUG9zaXRpb25LZXkocG9zaXRpb24pIHtcbiAgICByZXR1cm4gcG9zaXRpb24uYXNzb3J0bWVudD8ubWV0YT8uaHJlZiB8fCBwb3NpdGlvbi5hc3NvcnRtZW50Py5pZCB8fCAnJztcbn1cblxuZnVuY3Rpb24gaGFja2VyUG9zaXRpb25zU2lnbmF0dXJlKGRvY3VtZW50KSB7XG4gICAgY29uc3Qgcm93cyA9IEFycmF5LmlzQXJyYXkoZG9jdW1lbnQ/LnBvc2l0aW9ucylcbiAgICAgICAgPyBkb2N1bWVudC5wb3NpdGlvbnNcbiAgICAgICAgOiAoZG9jdW1lbnQ/LnBvc2l0aW9ucz8ucm93cyB8fCBbXSk7XG4gICAgcmV0dXJuIHJvd3NcbiAgICAgICAgLm1hcChwb3NpdGlvbiA9PiBgJHtoYWNrZXJQb3NpdGlvbktleShwb3NpdGlvbil9OiR7TnVtYmVyKHBvc2l0aW9uLnF1YW50aXR5IHx8IDApfWApXG4gICAgICAgIC5zb3J0KClcbiAgICAgICAgLmpvaW4oJ3wnKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyRmluZEV4aXN0aW5nRGVtYW5kKG9yZGVyLCBkb2MpIHtcbiAgICBjb25zdCBjdXN0b21lck9yZGVySHJlZiA9IE1TX0FQSV9CQVNFICsgJy9lbnRpdHkvY3VzdG9tZXJvcmRlci8nICsgZG9jLmlkO1xuICAgIGNvbnN0IHBhdGggPSAnL2VudGl0eS9kZW1hbmQ/ZmlsdGVyPWN1c3RvbWVyT3JkZXI9JyArIGVuY29kZVVSSUNvbXBvbmVudChjdXN0b21lck9yZGVySHJlZilcbiAgICAgICAgKyAnJmV4cGFuZD1wb3NpdGlvbnMuYXNzb3J0bWVudCZsaW1pdD0xMDAnO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBtc0FwaVAoJ0dFVCcsIHBhdGgpO1xuICAgIGNvbnN0IHJvd3MgPSBkYXRhLnJvd3MgfHwgW107XG4gICAgY29uc3Qgb3JkZXJTdW0gPSBOdW1iZXIob3JkZXIuc3VtIHx8IDApO1xuICAgIGNvbnN0IG9yZGVyUG9zaXRpb25zID0gaGFja2VyUG9zaXRpb25zU2lnbmF0dXJlKG9yZGVyKTtcbiAgICByZXR1cm4gcm93cy5maWx0ZXIoZGVtYW5kID0+IGRlbWFuZC5hcHBsaWNhYmxlID09PSB0cnVlICYmIE51bWJlcihkZW1hbmQuc3VtIHx8IDApID09PSBvcmRlclN1bSlcbiAgICAgICAgLm1hcChkZW1hbmQgPT4gKHtcbiAgICAgICAgICAgIGRlbWFuZCxcbiAgICAgICAgICAgIHNhbWVQb3NpdGlvbnM6IGhhY2tlclBvc2l0aW9uc1NpZ25hdHVyZShkZW1hbmQpID09PSBvcmRlclBvc2l0aW9uc1xuICAgICAgICB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckNyZWF0ZURlbWFuZCgpIHtcbiAgICBpZiAoaGFja2VyQnVzeSkgcmV0dXJuO1xuICAgIGNvbnN0IGN1cnJlbnQgPSBoYWNrZXJPcGVuRG9jKCk7XG4gICAgaWYgKCFjdXJyZW50IHx8IGN1cnJlbnQudHlwZSAhPT0gJ2N1c3RvbWVyb3JkZXInKSB7XG4gICAgICAgIGhhY2tlckxvZygn0JTQu9GPINGB0L7Qt9C00LDQvdC40Y8g0L7RgtCz0YDRg9C30LrQuCDQvtGC0LrRgNC+0LnRgtC1INC30LDQutCw0Lcg0L/QvtC60YPQv9Cw0YLQtdC70Y8nLCAnd2FybicpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGhhY2tlclNldEFjdGlvbkJ1c3kodHJ1ZSk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBkb2MsIG9yZGVyIH0gPSBhd2FpdCBoYWNrZXJHZXRPcmRlcigpO1xuICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGhhY2tlckZpbmRFeGlzdGluZ0RlbWFuZChvcmRlciwgZG9jKTtcbiAgICAgICAgY29uc3QgZXhhY3QgPSBleGlzdGluZy5maW5kKGl0ZW0gPT4gaXRlbS5zYW1lUG9zaXRpb25zKTtcbiAgICAgICAgaWYgKGV4YWN0KSB7XG4gICAgICAgICAgICBoYWNrZXJMYXN0RGVtYW5kID0gZXhhY3QuZGVtYW5kO1xuICAgICAgICAgICAgaGFja2VyTG9nKGDimqDvuI8g0KPQttC1INC10YHRgtGMINC/0YDQvtCy0LXQtNGR0L3QvdCw0Y8g0L7RgtCz0YDRg9C30LrQsCAke2V4YWN0LmRlbWFuZC5uYW1lfSDQvdCwINGB0YPQvNC80YMgJHsoZXhhY3QuZGVtYW5kLnN1bSAvIDEwMCkudG9GaXhlZCgyKX0g4oK9IOKAlCDQvdC+0LLQsNGPINC90LUg0YHQvtC30LTQsNGR0YLRgdGPYCwgJ3dhcm4nKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZXhpc3RpbmcubGVuZ3RoKSB7XG4gICAgICAgICAgICBoYWNrZXJMb2coJ9CV0YHRgtGMINC/0YDQvtCy0LXQtNGR0L3QvdCw0Y8g0L7RgtCz0YDRg9C30LrQsCDRgSDRgtCw0LrQvtC5INC20LUg0YHRg9C80LzQvtC5LCDQvdC+INGB0L7RgdGC0LDQsiDQv9C+0LfQuNGG0LjQuSDQvtGC0LvQuNGH0LDQtdGC0YHRjyDigJQg0YHQvtC30LTQsNGOINC90L7QstGD0Y4g0L7RgtCz0YDRg9C30LrRgycsICd3YXJuJyk7XG4gICAgICAgIH1cbiAgICAgICAgaGFja2VyTG9nKCfQodC+0LfQtNCw0Y4g0L7RgtCz0YDRg9C30LrRg+KApicpO1xuICAgICAgICBoYWNrZXJPcmRlckluZm8gPSBvcmRlcjtcbiAgICAgICAgY29uc3QgZGVtYW5kID0gYXdhaXQgaGFja2VyUG9zdFdpdGhOYW1lUmV0cnkoJ2RlbWFuZCcsIGF3YWl0IGhhY2tlckJ1aWxkRGVtYW5kQm9keShvcmRlciwgZG9jKSwgb3JkZXIubmFtZSB8fCAoJ9CQ0LLRgtC+0L/RgNC+0LTQsNC20LAgJyArIGRvYy5pZCkpO1xuICAgICAgICBoYWNrZXJMYXN0RGVtYW5kID0gZGVtYW5kO1xuICAgICAgICBoYWNrZXJDb250ZXh0ID0geyBjdXN0b21lck9yZGVySWQ6IGRvYy5pZCwgZGVtYW5kSWQ6IGRlbWFuZC5pZCB9O1xuICAgICAgICBoYWNrZXJMb2coYOKchSDQntGC0LPRgNGD0LfQutCwINGB0L7Qt9C00LDQvdCwOiAke2RlbWFuZC5uYW1lfWAsICdvaycpO1xuICAgICAgICBsb2NhdGlvbi5oYXNoID0gJyNkZW1hbmQvZWRpdD9pZD0nICsgZGVtYW5kLmlkO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7IGhhY2tlckxvZygn0J7RgtCz0YDRg9C30LrQsDogJyArIChlcnJvci5tZXNzYWdlIHx8IGVycm9yKSwgJ2VycicpOyB9XG4gICAgZmluYWxseSB7IGhhY2tlclNldEFjdGlvbkJ1c3koZmFsc2UpOyB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckNyZWF0ZVBheW1lbnREb2N1bWVudChlbnRpdHlUeXBlKSB7XG4gICAgY29uc3Qgc3VtID0gaGFja2VyUGFyc2VTdW1Ub0tvcGVja3MoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclNhbGVTdW0nKT8udmFsdWUpO1xuICAgIGlmICghc3VtKSB7IGhhY2tlckxvZyhgJHtlbnRpdHlUeXBlID09PSAnY2FzaGluJyA/ICfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCcgOiAn0JLRhdC+0LTRj9GJ0LjQuSDQv9C70LDRgtGR0LYnfTog0YHRg9C80LzQsCDQv9GD0YHRgtCw0Y8vMCDigJQg0L/RgNC+0L/Rg9GJ0LXQvWApOyByZXR1cm47IH1cbiAgICBjb25zdCB7IGRvYywgb3JkZXIgfSA9IGF3YWl0IGhhY2tlckdldE9yZGVyKCk7XG4gICAgY29uc3QgZGVtYW5kID0gaGFja2VyTGFzdERlbWFuZD8uaWQgPT09IGRvYy5pZCA/IGhhY2tlckxhc3REZW1hbmQgOiBudWxsO1xuICAgIGNvbnN0IGJvZHkgPSB7IG9yZ2FuaXphdGlvbjogb3JkZXIub3JnYW5pemF0aW9uLCBhZ2VudDogb3JkZXIuYWdlbnQsIHN1bSwgbW9tZW50OiBvcmRlci5tb21lbnQgfTtcbiAgICBjb25zdCBsaW5rZWREb2N1bWVudCA9IGRlbWFuZD8uaWRcbiAgICAgICAgPyB7IGlkOiBkZW1hbmQuaWQsIHR5cGU6ICdkZW1hbmQnLCBsYWJlbDogJ9C+0YLQs9GA0YPQt9C60LUnIH1cbiAgICAgICAgOiAoZG9jLnR5cGUgPT09ICdjdXN0b21lcm9yZGVyJ1xuICAgICAgICAgICAgPyB7IGlkOiBkb2MuaWQsIHR5cGU6ICdjdXN0b21lcm9yZGVyJywgbGFiZWw6ICfQt9Cw0LrQsNC30YMnIH1cbiAgICAgICAgICAgIDogeyBpZDogZG9jLmlkLCB0eXBlOiAnZGVtYW5kJywgbGFiZWw6ICfQvtGC0LPRgNGD0LfQutC1JyB9KTtcbiAgICBib2R5Lm9wZXJhdGlvbnMgPSBbe1xuICAgICAgICBtZXRhOiBoYWNrZXJNZXRhUmVmKE1TX0FQSV9CQVNFICsgJy9lbnRpdHkvJyArIGxpbmtlZERvY3VtZW50LnR5cGUgKyAnLycgKyBsaW5rZWREb2N1bWVudC5pZCwgbGlua2VkRG9jdW1lbnQudHlwZSksXG4gICAgICAgIGxpbmtlZFN1bTogc3VtXG4gICAgfV07XG4gICAgaGFja2VyTG9nKGDQlNC+0LrRg9C80LXQvdGCINCx0YPQtNC10YIg0L/RgNC40LLRj9C30LDQvSDQuiAke2xpbmtlZERvY3VtZW50LmxhYmVsfWApO1xuICAgIGlmIChlbnRpdHlUeXBlID09PSAnY2FzaGluJykge1xuICAgICAgICBjb25zdCBjbGllbnRIcmVmID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckNsaWVudFN0YXR1c1NlbGVjdCcpPy52YWx1ZSB8fCAnJztcbiAgICAgICAgY29uc3QgY2FzaFR5cGVIcmVmID0gYXdhaXQgaGFja2VyUmVmcmVzaENhc2hQYXlUeXBlKCk7XG4gICAgICAgIGJvZHkuYXR0cmlidXRlcyA9IFtcbiAgICAgICAgICAgIGF3YWl0IGhhY2tlckJ1aWxkQXR0ckJvZHkoJ2Nhc2hpbicsIEhBQ0tFUl9BVFRSX0NMSUVOVF9TVEFUVVMsIGNsaWVudEhyZWYpLFxuICAgICAgICAgICAgYXdhaXQgaGFja2VyQnVpbGRBdHRyQm9keSgnY2FzaGluJywgSEFDS0VSX0FUVFJfUEFZX1RZUEUsIGNhc2hUeXBlSHJlZilcbiAgICAgICAgXS5maWx0ZXIoQm9vbGVhbik7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgbWV0aG9kSHJlZiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJQYXlNZXRob2RTZWxlY3QnKT8udmFsdWUgfHwgJyc7XG4gICAgICAgIGlmICghbWV0aG9kSHJlZikgeyBoYWNrZXJNYXJrUmVxdWlyZWRTZWxlY3QoJ2hhY2tlclBheU1ldGhvZFNlbGVjdCcsICfQktGL0LHQtdGA0LjRgtC1IMKr0KHQv9C+0YHQvtCxINC+0L/Qu9Cw0YLRi8K7Jyk7IHJldHVybjsgfVxuICAgICAgICBib2R5LmF0dHJpYnV0ZXMgPSBbYXdhaXQgaGFja2VyQnVpbGRBdHRyQm9keSgncGF5bWVudGluJywgSEFDS0VSX0FUVFJfUEFZX01FVEhPRCwgbWV0aG9kSHJlZildLmZpbHRlcihCb29sZWFuKTtcbiAgICB9XG4gICAgcmV0dXJuIGhhY2tlclBvc3RXaXRoTmFtZVJldHJ5KGVudGl0eVR5cGUsIGJvZHksIG9yZGVyLm5hbWUgfHwgKCfQkNCy0YLQvtC/0YDQvtC00LDQttCwICcgKyBvcmRlci5pZCkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYWNrZXJDcmVhdGVDYXNoaW4oKSB7XG4gICAgaWYgKGhhY2tlckJ1c3kpIHJldHVybjsgaGFja2VyU2V0QWN0aW9uQnVzeSh0cnVlKTtcbiAgICB0cnkgeyBjb25zdCBpdGVtID0gYXdhaXQgaGFja2VyQ3JlYXRlUGF5bWVudERvY3VtZW50KCdjYXNoaW4nKTsgaWYgKGl0ZW0pIGhhY2tlckxvZyhg4pyFINCf0YDQuNGF0L7QtNC90YvQuSDQvtGA0LTQtdGAINGB0L7Qt9C00LDQvTogJHtpdGVtLm5hbWV9YCwgJ29rJyk7IH1cbiAgICBjYXRjaCAoZXJyb3IpIHsgaGFja2VyTG9nKCfQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgDogJyArIChlcnJvci5tZXNzYWdlIHx8IGVycm9yKSwgJ2VycicpOyB9XG4gICAgZmluYWxseSB7IGhhY2tlclNldEFjdGlvbkJ1c3koZmFsc2UpOyB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckNyZWF0ZUNyZWRpdCgpIHtcbiAgICBpZiAoaGFja2VyQnVzeSkgcmV0dXJuO1xuICAgIGNvbnN0IHRvdGFsID0gaGFja2VyUGFyc2VTdW1Ub0tvcGVja3MoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlclNhbGVTdW0nKT8udmFsdWUpO1xuICAgIGNvbnN0IGNhc2ggPSBoYWNrZXJQYXJzZVN1bVRvS29wZWNrcyhkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQ2FzaEFtb3VudCcpPy52YWx1ZSk7XG4gICAgaWYgKCF0b3RhbCB8fCAhY2FzaCkgeyBoYWNrZXJMb2coJ9CU0LvRjyDQutGA0LXQtNC40YLQsC/RgNCw0YHRgdGA0L7Rh9C60Lgg0YPQutCw0LbQuNGC0LUg0L7QsdGJ0YPRjiDRgdGD0LzQvNGDINC4INGB0YPQvNC80YMg0L3QsNC70LjRh9C90YvQvNC4JywgJ3dhcm4nKTsgcmV0dXJuOyB9XG4gICAgaWYgKGNhc2ggPj0gdG90YWwpIHsgaGFja2VyTG9nKCfQodGD0LzQvNCwINC90LDQu9C40YfQvdGL0LzQuCDQtNC+0LvQttC90LAg0LHRi9GC0Ywg0LzQtdC90YzRiNC1INC+0LHRidC10Lkg0YHRg9C80LzRiycsICd3YXJuJyk7IHJldHVybjsgfVxuICAgIGNvbnN0IHJlc3QgPSB0b3RhbCAtIGNhc2g7XG4gICAgaGFja2VyU2V0QWN0aW9uQnVzeSh0cnVlKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBhbW91bnRJbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJTYWxlU3VtJyk7XG4gICAgICAgIGNvbnN0IG9sZEFtb3VudCA9IGFtb3VudElucHV0LnZhbHVlO1xuICAgICAgICBhbW91bnRJbnB1dC52YWx1ZSA9IFN0cmluZyhjYXNoIC8gMTAwKTtcbiAgICAgICAgY29uc3QgY2FzaERvYyA9IGF3YWl0IGhhY2tlckNyZWF0ZVBheW1lbnREb2N1bWVudCgnY2FzaGluJyk7XG4gICAgICAgIGFtb3VudElucHV0LnZhbHVlID0gb2xkQW1vdW50O1xuICAgICAgICBpZiAoY2FzaERvYykgaGFja2VyTG9nKGDinIUg0J/QmtCeINC90LAg0L3QsNC70LjRh9C90YvQtSDRgdC+0LfQtNCw0L06ICR7Y2FzaERvYy5uYW1lfWAsICdvaycpO1xuICAgICAgICBhbW91bnRJbnB1dC52YWx1ZSA9IFN0cmluZyhyZXN0IC8gMTAwKTtcbiAgICAgICAgY29uc3QgcGF5RG9jID0gYXdhaXQgaGFja2VyQ3JlYXRlUGF5bWVudERvY3VtZW50KCdwYXltZW50aW4nKTtcbiAgICAgICAgYW1vdW50SW5wdXQudmFsdWUgPSBvbGRBbW91bnQ7XG4gICAgICAgIGlmIChwYXlEb2MpIGhhY2tlckxvZyhg4pyFINCS0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2INC90LAg0L7RgdGC0LDRgtC+0Log0YHQvtC30LTQsNC9OiAke3BheURvYy5uYW1lfWAsICdvaycpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7IGhhY2tlckxvZygn0JrRgNC10LTQuNGCL9GA0LDRgdGB0YDQvtGH0LrQsDogJyArIChlcnJvci5tZXNzYWdlIHx8IGVycm9yKSwgJ2VycicpOyB9XG4gICAgZmluYWxseSB7IGhhY2tlclNldEFjdGlvbkJ1c3koZmFsc2UpOyB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhY2tlckNyZWF0ZVBheW1lbnRpbigpIHtcbiAgICBpZiAoaGFja2VyQnVzeSkgcmV0dXJuOyBoYWNrZXJTZXRBY3Rpb25CdXN5KHRydWUpO1xuICAgIHRyeSB7IGNvbnN0IGl0ZW0gPSBhd2FpdCBoYWNrZXJDcmVhdGVQYXltZW50RG9jdW1lbnQoJ3BheW1lbnRpbicpOyBpZiAoaXRlbSkgaGFja2VyTG9nKGDinIUg0JLRhdC+0LTRj9GJ0LjQuSDQv9C70LDRgtGR0LYg0YHQvtC30LTQsNC9OiAke2l0ZW0ubmFtZX1gLCAnb2snKTsgfVxuICAgIGNhdGNoIChlcnJvcikgeyBoYWNrZXJMb2coJ9CS0YXQvtC00Y/RidC40Lkg0L/Qu9Cw0YLRkdC2OiAnICsgKGVycm9yLm1lc3NhZ2UgfHwgZXJyb3IpLCAnZXJyJyk7IH1cbiAgICBmaW5hbGx5IHsgaGFja2VyU2V0QWN0aW9uQnVzeShmYWxzZSk7IH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFja2VyQ2hlY2tPcmRlclN1bSgpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCB7IG9yZGVyIH0gPSBhd2FpdCBoYWNrZXJHZXRPcmRlcigpO1xuICAgICAgICBjb25zdCBzdW0gPSAoKG9yZGVyLnN1bSB8fCAwKSAvIDEwMCkudG9GaXhlZCgyKTtcbiAgICAgICAgWydoYWNrZXJTYWxlU3VtJywgJ2hhY2tlckNhc2hBbW91bnQnXS5mb3JFYWNoKGlkID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuICAgICAgICAgICAgaWYgKGVsICYmIGlkID09PSAnaGFja2VyU2FsZVN1bScpIGVsLnZhbHVlID0gc3VtO1xuICAgICAgICB9KTtcbiAgICAgICAgaGFja2VyTG9nKGDinIUg0KHRg9C80LzQsCDQt9Cw0LrQsNC30LAg0L7QsdC90L7QstC70LXQvdCwOiAke3N1bX0g4oK9YCwgJ29rJyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaGFja2VyTG9nKCfQn9GA0L7QstC10YDQutCwINGB0YPQvNC80Ys6ICcgKyAoZXJyb3IubWVzc2FnZSB8fCBlcnJvciksICdlcnInKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlclBhcnNlU3VtVG9Lb3BlY2tzKHZhbHVlKSB7XG4gICAgY29uc3QgbiA9IHBhcnNlRmxvYXQoU3RyaW5nKHZhbHVlIHx8ICcnKS5yZXBsYWNlKCcsJywgJy4nKS5yZXBsYWNlKC9cXHMvZywgJycpKTtcbiAgICByZXR1cm4gKGlzRmluaXRlKG4pICYmIG4gPiAwKSA/IE1hdGgucm91bmQobiAqIDEwMCkgOiAwO1xufVxuIiwiLy8g4pSA4pSA4pSAINCa0L7QvdGC0LXQutGB0YLQvdGL0LkgVVgg0JzQvtC50KHQutC70LDQtCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vINCY0LTQtdC80L/QvtGC0LXQvdGC0L3Ri9C1IERPTS3QstGB0YLRgNC+0LnQutC4INC00LvRjyDQutCw0YDRgtC+0YfQtdC6INC00L7QutGD0LzQtdC90YLQvtCyLiDQkdC40LfQvdC10YEt0LTQtdC50YHRgtCy0LjRjyDQuNGB0L/QvtC70YzQt9GD0Y7RglxuLy8g0LvQuNCx0L4g0YjRgtCw0YLQvdGL0LkgVUkg0JzQvtC50KHQutC70LDQtCwg0LvQuNCx0L4g0L3QtdCx0L7Qu9GM0YjQuNC1INC/0YDQvtCy0LXRgNC10L3QvdGL0LUgQVBJLdCy0YvQt9C+0LLRiy5cblxubGV0IG1zU3BhT2JzZXJ2ZXIgPSBudWxsO1xubGV0IG1zU3BhUmVjb25jaWxlVGltZXIgPSBudWxsO1xubGV0IG1zUXVpY2tLZWVwYWxpdmVUaW1lciA9IG51bGw7XG5cbmZ1bmN0aW9uIG1zQ3VycmVudERvY3VtZW50KCkge1xuICAgIGNvbnN0IG1hdGNoID0gbG9jYXRpb24uaGFzaC5tYXRjaCgvXiMoY3VzdG9tZXJvcmRlcnxkZW1hbmR8Y2FzaGlufHBheW1lbnRpbilcXC9lZGl0XFw/W14jXSpcXGJpZD0oWzAtOWEtZi1dKykvaSk7XG4gICAgcmV0dXJuIG1hdGNoID8geyB0eXBlOiBtYXRjaFsxXS50b0xvd2VyQ2FzZSgpLCBpZDogbWF0Y2hbMl0gfSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIG1zVmlzaWJsZShlbGVtZW50KSB7XG4gICAgcmV0dXJuICEhZWxlbWVudCAmJiBlbGVtZW50LmlzQ29ubmVjdGVkICYmIGVsZW1lbnQub2Zmc2V0SGVpZ2h0ID4gMDtcbn1cblxuZnVuY3Rpb24gbXNFeGFjdFRleHRFbGVtZW50cyh0ZXh0KSB7XG4gICAgY29uc3QgZm91bmQgPSBbXTtcbiAgICBjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKGRvY3VtZW50LmJvZHksIE5vZGVGaWx0ZXIuU0hPV19URVhUKTtcbiAgICBsZXQgbm9kZTtcbiAgICB3aGlsZSAoKG5vZGUgPSB3YWxrZXIubmV4dE5vZGUoKSkpIHtcbiAgICAgICAgaWYgKChub2RlLnRleHRDb250ZW50IHx8ICcnKS50cmltKCkgIT09IHRleHQpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBlbGVtZW50ID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgICAgICBpZiAoZWxlbWVudCAmJiBtc1Zpc2libGUoZWxlbWVudCkgJiYgIWVsZW1lbnQuY2xvc2VzdCgnW2lkXj1cIm1jXCJdJykpIGZvdW5kLnB1c2goZWxlbWVudCk7XG4gICAgfVxuICAgIHJldHVybiBmb3VuZDtcbn1cblxuZnVuY3Rpb24gbXNGaWVsZEhvc3RGcm9tTGFiZWwobGFiZWxFbGVtZW50KSB7XG4gICAgaWYgKCFsYWJlbEVsZW1lbnQpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHRpdGxlID0gbGFiZWxFbGVtZW50LmNsb3Nlc3QoJ1tjbGFzcyo9XCJmb3JtSXRlbVRpdGxlXCJdJyk7XG4gICAgaWYgKHRpdGxlKSB7XG4gICAgICAgIGNvbnN0IHBhcmVudCA9IHRpdGxlLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgIGNvbnN0IGluZGV4ID0gQXJyYXkucHJvdG90eXBlLmluZGV4T2YuY2FsbChwYXJlbnQuY2hpbGRyZW4sIHRpdGxlKTtcbiAgICAgICAgcmV0dXJuIHBhcmVudC5jaGlsZHJlbltpbmRleCArIDFdIHx8IG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGxlZ2VuZCA9IGxhYmVsRWxlbWVudC5jbG9zZXN0KCd0ZC5sZWdlbmQnKSB8fCBsYWJlbEVsZW1lbnQuY2xvc2VzdCgndGQnKTtcbiAgICBpZiAobGVnZW5kPy5uZXh0RWxlbWVudFNpYmxpbmcpIHJldHVybiBsZWdlbmQubmV4dEVsZW1lbnRTaWJsaW5nO1xuICAgIHJldHVybiBsYWJlbEVsZW1lbnQubmV4dEVsZW1lbnRTaWJsaW5nIHx8IGxhYmVsRWxlbWVudC5wYXJlbnRFbGVtZW50Py5uZXh0RWxlbWVudFNpYmxpbmcgfHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gbXNGaW5kT3JkZXJTdGF0dXNBbmNob3IoKSB7XG4gICAgaWYgKG1zQ3VycmVudERvY3VtZW50KCk/LnR5cGUgIT09ICdjdXN0b21lcm9yZGVyJykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgdGVzdElkQW5jaG9yID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdC1pZD1cImRvYy1zdGF0dXNcIl0nKTtcbiAgICBpZiAobXNWaXNpYmxlKHRlc3RJZEFuY2hvcikpIHJldHVybiB0ZXN0SWRBbmNob3I7XG4gICAgY29uc3QgbGFiZWxsZWQgPSBtc0V4YWN0VGV4dEVsZW1lbnRzKCfQodGC0LDRgtGD0YEnKVxuICAgICAgICAubWFwKGVsZW1lbnQgPT4gbXNGaWVsZEhvc3RGcm9tTGFiZWwoZWxlbWVudCkpXG4gICAgICAgIC5maW5kKG1zVmlzaWJsZSk7XG4gICAgaWYgKGxhYmVsbGVkKSByZXR1cm4gbGFiZWxsZWQucXVlcnlTZWxlY3RvcignYnV0dG9uLFtyb2xlPVwiYnV0dG9uXCJdLC5iLXBvcHVwLWJ1dHRvbicpIHx8IGxhYmVsbGVkO1xuXG4gICAgY29uc3QgbmFtZXMgPSBuZXcgU2V0KGhhY2tlclN0YXRlcy5tYXAoc3RhdGUgPT4gc3RhdGUubmFtZSkpO1xuICAgIGlmICghbmFtZXMuc2l6ZSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIFsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24sW3JvbGU9XCJidXR0b25cIl0sLmItcG9wdXAtYnV0dG9uJyldXG4gICAgICAgIC5maW5kKGVsZW1lbnQgPT4gbXNWaXNpYmxlKGVsZW1lbnQpICYmIG5hbWVzLmhhcygoZWxlbWVudC50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpKSAmJiAhZWxlbWVudC5jbG9zZXN0KCdbaWRePVwibWNcIl0nKSkgfHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gbXNUb2FzdChtZXNzYWdlLCBraW5kID0gJ2luZm8nKSB7XG4gICAgbGV0IHRvYXN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jTXNUb2FzdCcpO1xuICAgIGlmICghdG9hc3QpIHtcbiAgICAgICAgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICAgICAgdG9hc3QuaWQgPSAnbWNNc1RvYXN0JztcbiAgICAgICAgdG9hc3Quc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjpmaXhlZDtyaWdodDoxNHB4O2JvdHRvbToxNHB4O3otaW5kZXg6MjE0NzQ4MzAwNTttYXgtd2lkdGg6MzYwcHg7J1xuICAgICAgICAgICAgKyAncGFkZGluZzo5cHggMTJweDtib3JkZXItcmFkaXVzOjlweDtib3gtc2hhZG93OjAgNnB4IDI0cHggIzBmMTcyYTQwO2ZvbnQ6MTJweCBTZWdvZSBVSSxzYW5zLXNlcmlmOyc7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQodG9hc3QpO1xuICAgIH1cbiAgICBjb25zdCBjb2xvcnMgPSBraW5kID09PSAnZXJyb3InXG4gICAgICAgID8gWycjZmVlMmUyJywgJyM5OTFiMWInLCAnI2ZlY2FjYSddXG4gICAgICAgIDoga2luZCA9PT0gJ29rJyA/IFsnI2RjZmNlNycsICcjMTY2NTM0JywgJyM4NmVmYWMnXSA6IFsnI2VmZjZmZicsICcjMWQ0ZWQ4JywgJyNiZmRiZmUnXTtcbiAgICB0b2FzdC5zdHlsZS5iYWNrZ3JvdW5kID0gY29sb3JzWzBdO1xuICAgIHRvYXN0LnN0eWxlLmNvbG9yID0gY29sb3JzWzFdO1xuICAgIHRvYXN0LnN0eWxlLmJvcmRlciA9IGAxcHggc29saWQgJHtjb2xvcnNbMl19YDtcbiAgICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gICAgY2xlYXJUaW1lb3V0KG1zVG9hc3QuX3RpbWVyKTtcbiAgICBtc1RvYXN0Ll90aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdG9hc3QucmVtb3ZlKCksIGtpbmQgPT09ICdlcnJvcicgPyA2MDAwIDogMjUwMCk7XG59XG5cbmZ1bmN0aW9uIG1zRmlsbFN0YXR1c1NlbGVjdChzZWxlY3QpIHtcbiAgICBpZiAoIXNlbGVjdCkgcmV0dXJuO1xuICAgIGNvbnN0IHByZXZpb3VzID0gc2VsZWN0LnZhbHVlO1xuICAgIHNlbGVjdC5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBjb25zdCBwbGFjZWhvbGRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgIHBsYWNlaG9sZGVyLnZhbHVlID0gJyc7XG4gICAgcGxhY2Vob2xkZXIudGV4dENvbnRlbnQgPSAn4oCUINCy0YvQsdC10YDQuNGC0LUg0YHRgtCw0YLRg9GBIOKAlCc7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKHBsYWNlaG9sZGVyKTtcbiAgICBoYWNrZXJTdGF0ZXMuZm9yRWFjaChzdGF0ZSA9PiB7XG4gICAgICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgICAgICBvcHRpb24udmFsdWUgPSBzdGF0ZS5ocmVmO1xuICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSBzdGF0ZS5uYW1lO1xuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgICB9KTtcbiAgICBpZiAoWy4uLnNlbGVjdC5vcHRpb25zXS5zb21lKG9wdGlvbiA9PiBvcHRpb24udmFsdWUgPT09IHByZXZpb3VzKSkgc2VsZWN0LnZhbHVlID0gcHJldmlvdXM7XG59XG5cbmZ1bmN0aW9uIGNsb3NlTXNPcmRlclN0YXR1c1BvcHVwKCkge1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY09yZGVyU3RhdHVzUG9wdXAnKT8ucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIG9wZW5Nc09yZGVyU3RhdHVzUG9wdXAoYW5jaG9yKSB7XG4gICAgY29uc3Qgb2xkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jT3JkZXJTdGF0dXNQb3B1cCcpO1xuICAgIGlmIChvbGQpIHsgb2xkLnJlbW92ZSgpOyByZXR1cm47IH1cbiAgICBjb25zdCBwb3B1cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHBvcHVwLmlkID0gJ21jT3JkZXJTdGF0dXNQb3B1cCc7XG4gICAgcG9wdXAuc3R5bGUuY3NzVGV4dCA9ICdwb3NpdGlvbjpmaXhlZDt6LWluZGV4OjIxNDc0ODMwMDQ7d2lkdGg6MjgwcHg7cGFkZGluZzoxMHB4O2JhY2tncm91bmQ6I2ZmZjsnXG4gICAgICAgICsgJ2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjEwcHg7Ym94LXNoYWRvdzowIDhweCAzMHB4ICMwZjE3MmE0MDtmb250OjEycHggU2Vnb2UgVUksc2Fucy1zZXJpZjtjb2xvcjojMzM0MTU1Oyc7XG4gICAgY29uc3QgcmVjdCA9IGFuY2hvci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICBwb3B1cC5zdHlsZS5sZWZ0ID0gYCR7TWF0aC5tYXgoOCwgTWF0aC5taW4ocmVjdC5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIDI5NikpfXB4YDtcbiAgICBwb3B1cC5zdHlsZS50b3AgPSBgJHtNYXRoLm1pbihyZWN0LmJvdHRvbSArIDUsIHdpbmRvdy5pbm5lckhlaWdodCAtIDE5MCl9cHhgO1xuXG4gICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfwn46vINCh0LzQtdC90LjRgtGMINGB0YLQsNGC0YPRgSDQt9Cw0LrQsNC30LAnO1xuICAgIHBvcHVwLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICByb3cuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjVweDttYXJnaW4tdG9wOjhweDsnO1xuICAgIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xuICAgIHNlbGVjdC5pZCA9ICdtY09yZGVyU3RhdHVzU2VsZWN0JztcbiAgICBzZWxlY3Quc3R5bGUuY3NzVGV4dCA9ICdmbGV4OjE7bWluLXdpZHRoOjA7cGFkZGluZzo2cHg7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2JhY2tncm91bmQ6I2ZmZjtjb2xvcjojMzM0MTU1Oyc7XG4gICAgcm93LmFwcGVuZENoaWxkKHNlbGVjdCk7XG4gICAgbXNGaWxsU3RhdHVzU2VsZWN0KHNlbGVjdCk7XG4gICAgY29uc3QgcmVmcmVzaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIHJlZnJlc2gudHlwZSA9ICdidXR0b24nO1xuICAgIHJlZnJlc2gudGV4dENvbnRlbnQgPSAn4oa7JztcbiAgICByZWZyZXNoLnRpdGxlID0gJ9Ce0LHQvdC+0LLQuNGC0Ywg0YHQv9C40YHQvtC6INGB0YLQsNGC0YPRgdC+0LInO1xuICAgIHJlZnJlc2guc3R5bGUuY3NzVGV4dCA9ICd3aWR0aDozMnB4O2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiNmOGZhZmM7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICByZWZyZXNoLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICByZWZyZXNoLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgaGFja2VyUmVmcmVzaFN0YXRlcyh0cnVlKS50aGVuKCgpID0+IG1zRmlsbFN0YXR1c1NlbGVjdChzZWxlY3QpKS5maW5hbGx5KCgpID0+IHsgcmVmcmVzaC5kaXNhYmxlZCA9IGZhbHNlOyB9KTtcbiAgICB9KTtcbiAgICByb3cuYXBwZW5kQ2hpbGQocmVmcmVzaCk7XG4gICAgcG9wdXAuYXBwZW5kQ2hpbGQocm93KTtcblxuICAgIGNvbnN0IGVycm9yID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgZXJyb3IuaWQgPSAnbWNPcmRlclN0YXR1c0Vycm9yJztcbiAgICBlcnJvci5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjdweDtjb2xvcjojOTkxYjFiO2JhY2tncm91bmQ6I2ZlZTJlMjtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjZweDsnO1xuICAgIHBvcHVwLmFwcGVuZENoaWxkKGVycm9yKTtcbiAgICBjb25zdCBhcHBseSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGFwcGx5LnR5cGUgPSAnYnV0dG9uJztcbiAgICBhcHBseS50ZXh0Q29udGVudCA9ICfQn9C+0LzQtdC90Y/RgtGMINC4INC+0LHQvdC+0LLQuNGC0Ywg0YHRgtGA0LDQvdC40YbRgyc7XG4gICAgYXBwbHkuc3R5bGUuY3NzVGV4dCA9ICd3aWR0aDoxMDAlO21hcmdpbi10b3A6OHB4O3BhZGRpbmc6N3B4O2JvcmRlcjowO2JvcmRlci1yYWRpdXM6N3B4O2JhY2tncm91bmQ6IzI1NjNlYjtjb2xvcjojZmZmO2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjsnO1xuICAgIGFwcGx5LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBkb2MgPSBtc0N1cnJlbnREb2N1bWVudCgpO1xuICAgICAgICBpZiAoIWRvYyB8fCAhc2VsZWN0LnZhbHVlKSB7XG4gICAgICAgICAgICBlcnJvci50ZXh0Q29udGVudCA9ICfQktGL0LHQtdGA0LjRgtC1INGB0YLQsNGC0YPRgSc7XG4gICAgICAgICAgICBlcnJvci5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJztcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBhcHBseS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIGVycm9yLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBoYWNrZXJVcGRhdGVPcmRlclN0YXR1cyhkb2MuaWQsIHNlbGVjdC52YWx1ZSk7XG4gICAgICAgICAgICBtc1RvYXN0KCfinIUg0KHRgtCw0YLRg9GBINC40LfQvNC10L3RkdC9LiDQntCx0L3QvtCy0LvRj9GOINGB0YLRgNCw0L3QuNGG0YPigKYnLCAnb2snKTtcbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gbG9jYXRpb24ucmVsb2FkKCksIDI1MCk7XG4gICAgICAgIH0gY2F0Y2ggKHJlYXNvbikge1xuICAgICAgICAgICAgZXJyb3IudGV4dENvbnRlbnQgPSByZWFzb24ubWVzc2FnZSB8fCBTdHJpbmcocmVhc29uKTtcbiAgICAgICAgICAgIGVycm9yLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xuICAgICAgICAgICAgYXBwbHkuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgIH0pO1xuICAgIHBvcHVwLmFwcGVuZENoaWxkKGFwcGx5KTtcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHBvcHVwKTtcbiAgICBpZiAoIWhhY2tlclN0YXRlcy5sZW5ndGgpIHJlZnJlc2guY2xpY2soKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRNc09yZGVyU3RhdHVzQWN0aW9uKCkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jT3JkZXJTdGF0dXNBY3Rpb24nKTtcbiAgICBjb25zdCBhbGxvd2VkID0gaGFja2VyQmVhcmVyRW5hYmxlZCAmJiAhIWhhY2tlckJlYXJlclRva2VuLnRyaW0oKSAmJiBoYWNrZXJBcGlWYWxpZGF0ZWQ7XG4gICAgaWYgKCFhbGxvd2VkIHx8IG1zQ3VycmVudERvY3VtZW50KCk/LnR5cGUgIT09ICdjdXN0b21lcm9yZGVyJykge1xuICAgICAgICBleGlzdGluZz8ucmVtb3ZlKCk7XG4gICAgICAgIGNsb3NlTXNPcmRlclN0YXR1c1BvcHVwKCk7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGV4aXN0aW5nPy5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgIGNvbnN0IGFuY2hvciA9IG1zRmluZE9yZGVyU3RhdHVzQW5jaG9yKCk7XG4gICAgaWYgKCFhbmNob3IpIHJldHVybjtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICBidXR0b24uaWQgPSAnbWNPcmRlclN0YXR1c0FjdGlvbic7XG4gICAgYnV0dG9uLnR5cGUgPSAnYnV0dG9uJztcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSAn8J+Oryc7XG4gICAgYnV0dG9uLnRpdGxlID0gJ9CR0YvRgdGC0YDQviDQv9C+0LzQtdC90Y/RgtGMINGB0YLQsNGC0YPRgSDQt9Cw0LrQsNC30LAnO1xuICAgIGJ1dHRvbi5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6MjhweDtoZWlnaHQ6MjRweDttYXJnaW4tdG9wOjNweDtwYWRkaW5nOjA7Ym9yZGVyOjFweCBzb2xpZCAjOTNjNWZkOydcbiAgICAgICAgKyAnYm9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojZWZmNmZmO2NvbG9yOiMxZDRlZDg7Y3Vyc29yOnBvaW50ZXI7bGluZS1oZWlnaHQ6MjJweDsnO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IG9wZW5Nc09yZGVyU3RhdHVzUG9wdXAoYnV0dG9uKSk7XG4gICAgYW5jaG9yLmluc2VydEFkamFjZW50RWxlbWVudCgnYWZ0ZXJlbmQnLCBidXR0b24pO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZU1zTWFnaWNDb25maWcoY29uZmlnKSB7XG4gICAgaWYgKCFjb25maWcgfHwgdHlwZW9mIGNvbmZpZyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShjb25maWcpKSB0aHJvdyBuZXcgRXJyb3IoJ9Ca0L7RgNC10L3RjCBKU09OINC00L7Qu9C20LXQvSDQsdGL0YLRjCDQvtCx0YrQtdC60YLQvtC8Jyk7XG4gICAgWydkZW1hbmQnLCAnY2FzaGluJywgJ3BheW1lbnRpbiddLmZvckVhY2goa2luZCA9PiB7XG4gICAgICAgIGlmIChjb25maWdba2luZF0gPT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWN0aW9uID0gY29uZmlnW2tpbmRdO1xuICAgICAgICBpZiAoIXNlY3Rpb24gfHwgdHlwZW9mIHNlY3Rpb24gIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkoc2VjdGlvbikpIHRocm93IG5ldyBFcnJvcihgJHtraW5kfTog0L3Rg9C20LXQvSDQvtCx0YrQtdC60YJgKTtcbiAgICAgICAgaWYgKHNlY3Rpb24uY29waWVzICE9IG51bGwgJiYgIUFycmF5LmlzQXJyYXkoc2VjdGlvbi5jb3BpZXMpKSB0aHJvdyBuZXcgRXJyb3IoYCR7a2luZH0uY29waWVzOiDQvdGD0LbQtdC9INC80LDRgdGB0LjQsmApO1xuICAgICAgICBpZiAoc2VjdGlvbi52YWx1ZXMgIT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheShzZWN0aW9uLnZhbHVlcykpIHRocm93IG5ldyBFcnJvcihgJHtraW5kfS52YWx1ZXM6INC90YPQttC10L0g0LzQsNGB0YHQuNCyYCk7XG4gICAgICAgIChzZWN0aW9uLmNvcGllcyB8fCBbXSkuZm9yRWFjaCgocnVsZSwgaW5kZXgpID0+IHtcbiAgICAgICAgICAgIGlmICghcnVsZSB8fCB0eXBlb2YgcnVsZS5maWVsZCAhPT0gJ3N0cmluZycgfHwgIU51bWJlci5pc0ludGVnZXIocnVsZS5mcm9tKSB8fCAhQXJyYXkuaXNBcnJheShydWxlLnRvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtraW5kfS5jb3BpZXNbJHtpbmRleH1dOiDQvdGD0LbQvdGLIGZpZWxkLCBmcm9tINC4IHRvYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICAoc2VjdGlvbi52YWx1ZXMgfHwgW10pLmZvckVhY2goKHJ1bGUsIGluZGV4KSA9PiB7XG4gICAgICAgICAgICBpZiAoIXJ1bGUgfHwgdHlwZW9mIHJ1bGUuZmllbGQgIT09ICdzdHJpbmcnIHx8IHR5cGVvZiBydWxlLnZhbHVlICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtraW5kfS52YWx1ZXNbJHtpbmRleH1dOiDQvdGD0LbQvdGLINGB0YLRgNC+0LrQvtCy0YvQtSBmaWVsZCDQuCB2YWx1ZWApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICByZXR1cm4gY29uZmlnO1xufVxuXG5mdW5jdGlvbiBsb2FkTXNNYWdpY0NvbmZpZygpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKHN0b3JhZ2VLZXkoJ21zTWFnaWNDb25maWdfdjEnKSk7XG4gICAgICAgIG1zTWFnaWNDb25maWcgPSBzYXZlZCA/IHZhbGlkYXRlTXNNYWdpY0NvbmZpZyhKU09OLnBhcnNlKHNhdmVkKSkgOiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KERFRkFVTFRfTVNfTUFHSUNfQ09ORklHKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignbWFnaWMtY29uZmlnJywgZXJyb3IpO1xuICAgICAgICBtc01hZ2ljQ29uZmlnID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShERUZBVUxUX01TX01BR0lDX0NPTkZJRykpO1xuICAgIH1cbiAgICByZXR1cm4gbXNNYWdpY0NvbmZpZztcbn1cblxuZnVuY3Rpb24gc2F2ZU1zTWFnaWNDb25maWcoY29uZmlnKSB7XG4gICAgbXNNYWdpY0NvbmZpZyA9IHZhbGlkYXRlTXNNYWdpY0NvbmZpZyhjb25maWcpO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ21zTWFnaWNDb25maWdfdjEnKSwgSlNPTi5zdHJpbmdpZnkobXNNYWdpY0NvbmZpZykpO1xuICAgIHJldHVybiBtc01hZ2ljQ29uZmlnO1xufVxuXG5mdW5jdGlvbiBzYXZlTXNNYWdpY1ZhbHVlT3ZlcnJpZGVzKGtpbmQsIG92ZXJyaWRlcykge1xuICAgIGNvbnN0IGNvbmZpZyA9IEpTT04ucGFyc2UoSlNPTi5zdHJpbmdpZnkobXNNYWdpY0NvbmZpZykpO1xuICAgIGNvbnN0IHNlY3Rpb24gPSBjb25maWdba2luZF0gfHwgeyBjb3BpZXM6IFtdLCB2YWx1ZXM6IFtdIH07XG4gICAgc2VjdGlvbi52YWx1ZXMgPSAoc2VjdGlvbi52YWx1ZXMgfHwgW10pLm1hcCgocnVsZSwgaW5kZXgpID0+IChcbiAgICAgICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG92ZXJyaWRlcywgaW5kZXgpXG4gICAgICAgICAgICA/IHsgLi4ucnVsZSwgdmFsdWU6IFN0cmluZyhvdmVycmlkZXNbaW5kZXhdID8/ICcnKSB9XG4gICAgICAgICAgICA6IHJ1bGVcbiAgICApKTtcbiAgICBjb25maWdba2luZF0gPSBzZWN0aW9uO1xuICAgIHJldHVybiBzYXZlTXNNYWdpY0NvbmZpZyhjb25maWcpO1xufVxuXG5mdW5jdGlvbiBtc0ZpbmRGaWVsZEhvc3RzKGZpZWxkTmFtZSkge1xuICAgIHJldHVybiBtc0V4YWN0VGV4dEVsZW1lbnRzKGZpZWxkTmFtZSlcbiAgICAgICAgLm1hcChsYWJlbCA9PiBtc0ZpZWxkSG9zdEZyb21MYWJlbChsYWJlbCkpXG4gICAgICAgIC5maWx0ZXIoKGhvc3QsIGluZGV4LCBhbGwpID0+IGhvc3QgJiYgYWxsLmluZGV4T2YoaG9zdCkgPT09IGluZGV4KTtcbn1cblxuZnVuY3Rpb24gbXNGaWVsZENvbnRyb2woaG9zdCkge1xuICAgIGlmICghaG9zdCkgcmV0dXJuIG51bGw7XG4gICAgaWYgKGhvc3QubWF0Y2hlcz8uKCdpbnB1dCxzZWxlY3QsdGV4dGFyZWEsW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sW3JvbGU9XCJjb21ib2JveFwiXScpKSByZXR1cm4gaG9zdDtcbiAgICByZXR1cm4gaG9zdC5xdWVyeVNlbGVjdG9yKCdzZWxlY3QsaW5wdXQ6bm90KFt0eXBlPVwiaGlkZGVuXCJdKSx0ZXh0YXJlYSxbY29udGVudGVkaXRhYmxlPVwidHJ1ZVwiXSxbcm9sZT1cImNvbWJvYm94XCJdLGJ1dHRvbiwuYi1wb3B1cC1idXR0b24nKSB8fCBob3N0O1xufVxuXG5mdW5jdGlvbiBtc0NvbnRyb2xWYWx1ZShjb250cm9sKSB7XG4gICAgaWYgKCFjb250cm9sKSByZXR1cm4gJyc7XG4gICAgaWYgKGNvbnRyb2wgaW5zdGFuY2VvZiBIVE1MU2VsZWN0RWxlbWVudCkgcmV0dXJuIGNvbnRyb2wuc2VsZWN0ZWRPcHRpb25zWzBdPy50ZXh0Q29udGVudC50cmltKCkgfHwgJyc7XG4gICAgaWYgKCd2YWx1ZScgaW4gY29udHJvbCAmJiBTdHJpbmcoY29udHJvbC52YWx1ZSB8fCAnJykudHJpbSgpKSByZXR1cm4gU3RyaW5nKGNvbnRyb2wudmFsdWUpLnRyaW0oKTtcbiAgICByZXR1cm4gKGNvbnRyb2wudGV4dENvbnRlbnQgfHwgJycpLnJlcGxhY2UoL1vDl+KcleKWvuKWvF0vZywgJycpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gbXNEaXNwYXRjaENvbnRyb2xFdmVudHMoY29udHJvbCkge1xuICAgIFsnaW5wdXQnLCAnY2hhbmdlJywgJ2tleXVwJywgJ2JsdXInXS5mb3JFYWNoKHR5cGUgPT4gY29udHJvbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCh0eXBlLCB7IGJ1YmJsZXM6IHRydWUgfSkpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbXNQaWNrQ3VzdG9tT3B0aW9uKG9wZW5lciwgdmFsdWUpIHtcbiAgICBvcGVuZXIuY2xpY2soKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwKSk7XG4gICAgY29uc3Qgb3B0aW9uID0gbXNFeGFjdFRleHRFbGVtZW50cyh2YWx1ZSkuZmluZChlbGVtZW50ID0+IHtcbiAgICAgICAgY29uc3QgY2xpY2thYmxlID0gZWxlbWVudC5jbG9zZXN0KCdbcm9sZT1cIm9wdGlvblwiXSxsaSxidXR0b24sYSx0ZCxkaXYnKTtcbiAgICAgICAgcmV0dXJuIGNsaWNrYWJsZSAmJiBtc1Zpc2libGUoY2xpY2thYmxlKSAmJiAhY2xpY2thYmxlLmNsb3Nlc3QoJyNtY01hZ2ljUG9wdXAnKSAmJiAhb3BlbmVyLmNvbnRhaW5zKGNsaWNrYWJsZSk7XG4gICAgfSk7XG4gICAgY29uc3QgY2xpY2thYmxlID0gb3B0aW9uPy5jbG9zZXN0KCdbcm9sZT1cIm9wdGlvblwiXSxsaSxidXR0b24sYSx0ZCxkaXYnKTtcbiAgICBpZiAoIWNsaWNrYWJsZSkgcmV0dXJuIGZhbHNlO1xuICAgIGNsaWNrYWJsZS5jbGljaygpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCA2MCkpO1xuICAgIHJldHVybiB0cnVlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBtc1NldENvbnRyb2xWYWx1ZShjb250cm9sLCB2YWx1ZSkge1xuICAgIGlmICghY29udHJvbCB8fCAhdmFsdWUpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxTZWxlY3RFbGVtZW50KSB7XG4gICAgICAgIGNvbnN0IG9wdGlvbiA9IFsuLi5jb250cm9sLm9wdGlvbnNdLmZpbmQoaXRlbSA9PiBpdGVtLnRleHRDb250ZW50LnRyaW0oKSA9PT0gdmFsdWUgfHwgaXRlbS52YWx1ZSA9PT0gdmFsdWUpO1xuICAgICAgICBpZiAoIW9wdGlvbikgcmV0dXJuIGZhbHNlO1xuICAgICAgICBjb250cm9sLnZhbHVlID0gb3B0aW9uLnZhbHVlO1xuICAgICAgICBtc0Rpc3BhdGNoQ29udHJvbEV2ZW50cyhjb250cm9sKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChjb250cm9sIGluc3RhbmNlb2YgSFRNTElucHV0RWxlbWVudCB8fCBjb250cm9sIGluc3RhbmNlb2YgSFRNTFRleHRBcmVhRWxlbWVudCkge1xuICAgICAgICBjb25zdCBjb21ibyA9IGNvbnRyb2wuY2xvc2VzdCgnW3JvbGU9XCJjb21ib2JveFwiXSxbY2xhc3MqPVwiY29tYm9cIiBpXSxbY2xhc3MqPVwic2VsZWN0XCIgaV0nKTtcbiAgICAgICAgaWYgKChjb250cm9sLnJlYWRPbmx5IHx8IGNvbWJvKSAmJiBhd2FpdCBtc1BpY2tDdXN0b21PcHRpb24oY29tYm8gfHwgY29udHJvbCwgdmFsdWUpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgaWYgKGNvbnRyb2wucmVhZE9ubHkpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3QgZGVzY3JpcHRvciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoT2JqZWN0LmdldFByb3RvdHlwZU9mKGNvbnRyb2wpLCAndmFsdWUnKTtcbiAgICAgICAgaWYgKGRlc2NyaXB0b3I/LnNldCkgZGVzY3JpcHRvci5zZXQuY2FsbChjb250cm9sLCB2YWx1ZSk7IGVsc2UgY29udHJvbC52YWx1ZSA9IHZhbHVlO1xuICAgICAgICBtc0Rpc3BhdGNoQ29udHJvbEV2ZW50cyhjb250cm9sKTtcbiAgICAgICAgcmV0dXJuIG1zQ29udHJvbFZhbHVlKGNvbnRyb2wpID09PSB2YWx1ZTtcbiAgICB9XG4gICAgaWYgKGNvbnRyb2wuaXNDb250ZW50RWRpdGFibGUpIHtcbiAgICAgICAgY29udHJvbC50ZXh0Q29udGVudCA9IHZhbHVlO1xuICAgICAgICBtc0Rpc3BhdGNoQ29udHJvbEV2ZW50cyhjb250cm9sKTtcbiAgICAgICAgcmV0dXJuIG1zQ29udHJvbFZhbHVlKGNvbnRyb2wpID09PSB2YWx1ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gbXNQaWNrQ3VzdG9tT3B0aW9uKGNvbnRyb2wsIHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gbXNOYXRpdmVTYXZlQnV0dG9uKCkge1xuICAgIHJldHVybiBtc0V4YWN0VGV4dEVsZW1lbnRzKCfQodC+0YXRgNCw0L3QuNGC0YwnKVxuICAgICAgICAubWFwKGVsZW1lbnQgPT4gZWxlbWVudC5jbG9zZXN0KCdidXR0b24sYSxbcm9sZT1cImJ1dHRvblwiXScpIHx8IGVsZW1lbnQpXG4gICAgICAgIC5maW5kKGVsZW1lbnQgPT4gbXNWaXNpYmxlKGVsZW1lbnQpKTtcbn1cblxuZnVuY3Rpb24gbXNEb2N1bWVudE1hZ2ljUnVsZXMoa2luZCwgb3ZlcnJpZGVzID0ge30pIHtcbiAgICBjb25zdCBiYXNlID0gbXNNYWdpY0NvbmZpZ1traW5kXSB8fCB7fTtcbiAgICByZXR1cm4ge1xuICAgICAgICBjb3BpZXM6IChiYXNlLmNvcGllcyB8fCBbXSkubWFwKHJ1bGUgPT4gKHsgLi4ucnVsZSB9KSksXG4gICAgICAgIHZhbHVlczogKGJhc2UudmFsdWVzIHx8IFtdKS5tYXAoKHJ1bGUsIGluZGV4KSA9PiAoe1xuICAgICAgICAgICAgLi4ucnVsZSxcbiAgICAgICAgICAgIHZhbHVlOiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob3ZlcnJpZGVzLCBpbmRleCkgPyBvdmVycmlkZXNbaW5kZXhdIDogcnVsZS52YWx1ZSxcbiAgICAgICAgfSkpLFxuICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1zQXBwbHlNYWdpY1J1bGVzKHsgc2F2ZSA9IGZhbHNlLCBvdmVycmlkZXMgPSB7fSB9ID0ge30pIHtcbiAgICBjb25zdCBkb2MgPSBtc0N1cnJlbnREb2N1bWVudCgpO1xuICAgIGlmICghZG9jIHx8ICFbJ2RlbWFuZCcsICdjYXNoaW4nLCAncGF5bWVudGluJ10uaW5jbHVkZXMoZG9jLnR5cGUpKSB7XG4gICAgICAgIHJldHVybiB7IGNoYW5nZWQ6IDAsIG1pc3Npbmc6IFsn0J7RgtC60YDQvtC50YLQtSDQntGC0LPRgNGD0LfQutGDLCDQn9GA0LjRhdC+0LTQvdGL0Lkg0L7RgNC00LXRgCDQuNC70Lgg0JLRhdC+0LTRj9GJ0LjQuSDQv9C70LDRgtGR0LYnXSwgZmFpbGVkOiBbXSB9O1xuICAgIH1cbiAgICBjb25zdCBydWxlcyA9IG1zRG9jdW1lbnRNYWdpY1J1bGVzKGRvYy50eXBlLCBvdmVycmlkZXMpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHsgY2hhbmdlZDogMCwgbWlzc2luZzogW10sIGZhaWxlZDogW10gfTtcblxuICAgIGZvciAoY29uc3QgcnVsZSBvZiBydWxlcy5jb3BpZXMpIHtcbiAgICAgICAgY29uc3QgaG9zdHMgPSBtc0ZpbmRGaWVsZEhvc3RzKHJ1bGUuZmllbGQpO1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBtc0ZpZWxkQ29udHJvbChob3N0c1tydWxlLmZyb21dKTtcbiAgICAgICAgY29uc3Qgc291cmNlVmFsdWUgPSBtc0NvbnRyb2xWYWx1ZShzb3VyY2UpO1xuICAgICAgICBpZiAoIXNvdXJjZVZhbHVlKSB7XG4gICAgICAgICAgICBpZiAocnVsZS5yZXF1aXJlZCkgcmVzdWx0Lm1pc3NpbmcucHVzaChydWxlLmZpZWxkKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgdGFyZ2V0SW5kZXggb2YgcnVsZS50bykge1xuICAgICAgICAgICAgY29uc3QgdGFyZ2V0ID0gbXNGaWVsZENvbnRyb2woaG9zdHNbdGFyZ2V0SW5kZXhdKTtcbiAgICAgICAgICAgIGlmICghdGFyZ2V0IHx8IHRhcmdldCA9PT0gc291cmNlKSB7XG4gICAgICAgICAgICAgICAgcmVzdWx0LmZhaWxlZC5wdXNoKHJ1bGUuZmllbGQpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGF3YWl0IG1zU2V0Q29udHJvbFZhbHVlKHRhcmdldCwgc291cmNlVmFsdWUpKSByZXN1bHQuY2hhbmdlZCArPSAxO1xuICAgICAgICAgICAgZWxzZSByZXN1bHQuZmFpbGVkLnB1c2gocnVsZS5maWVsZCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgcnVsZXMudmFsdWVzLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgICAgICBjb25zdCBydWxlID0gcnVsZXMudmFsdWVzW2luZGV4XTtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBTdHJpbmcocnVsZS52YWx1ZSB8fCAnJykudHJpbSgpO1xuICAgICAgICBpZiAoIXZhbHVlKSB7XG4gICAgICAgICAgICBpZiAocnVsZS5yZXF1aXJlZCkgcmVzdWx0Lm1pc3NpbmcucHVzaChydWxlLmZpZWxkKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGhvc3QgPSBtc0ZpbmRGaWVsZEhvc3RzKHJ1bGUuZmllbGQpW3J1bGUub2NjdXJyZW5jZSB8fCAwXTtcbiAgICAgICAgY29uc3QgY29udHJvbCA9IG1zRmllbGRDb250cm9sKGhvc3QpO1xuICAgICAgICBpZiAoYXdhaXQgbXNTZXRDb250cm9sVmFsdWUoY29udHJvbCwgdmFsdWUpKSByZXN1bHQuY2hhbmdlZCArPSAxO1xuICAgICAgICBlbHNlIHJlc3VsdC5mYWlsZWQucHVzaChydWxlLmZpZWxkKTtcbiAgICB9XG5cbiAgICByZXN1bHQubWlzc2luZyA9IFsuLi5uZXcgU2V0KHJlc3VsdC5taXNzaW5nKV07XG4gICAgcmVzdWx0LmZhaWxlZCA9IFsuLi5uZXcgU2V0KHJlc3VsdC5mYWlsZWQpXTtcbiAgICBpZiAoc2F2ZSAmJiAhcmVzdWx0Lm1pc3NpbmcubGVuZ3RoICYmICFyZXN1bHQuZmFpbGVkLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBzYXZlQnV0dG9uID0gbXNOYXRpdmVTYXZlQnV0dG9uKCk7XG4gICAgICAgIGlmIChzYXZlQnV0dG9uKSBzYXZlQnV0dG9uLmNsaWNrKCk7IGVsc2UgcmVzdWx0LmZhaWxlZC5wdXNoKCfQmtC90L7Qv9C60LAgwqvQodC+0YXRgNCw0L3QuNGC0YzCuycpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBjbG9zZU1zTWFnaWNQb3B1cCgpIHtcbiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNNYWdpY1BvcHVwJyk/LnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBvcGVuTXNNYWdpY1BvcHVwKGFuY2hvcikge1xuICAgIGNvbnN0IG9sZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY01hZ2ljUG9wdXAnKTtcbiAgICBpZiAob2xkKSB7IG9sZC5yZW1vdmUoKTsgcmV0dXJuOyB9XG4gICAgY29uc3QgZG9jID0gbXNDdXJyZW50RG9jdW1lbnQoKTtcbiAgICBpZiAoIWRvYykgcmV0dXJuO1xuICAgIGNvbnN0IHJ1bGVzID0gbXNEb2N1bWVudE1hZ2ljUnVsZXMoZG9jLnR5cGUpO1xuICAgIGNvbnN0IHBvcHVwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgcG9wdXAuaWQgPSAnbWNNYWdpY1BvcHVwJztcbiAgICBwb3B1cC5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO3otaW5kZXg6MjE0NzQ4MzAwNDt3aWR0aDozMTBweDtwYWRkaW5nOjExcHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTsnXG4gICAgICAgICsgJ2JvcmRlci1yYWRpdXM6MTBweDtib3gtc2hhZG93OjAgOHB4IDMwcHggIzBmMTcyYTQwO2ZvbnQ6MTJweCBTZWdvZSBVSSxzYW5zLXNlcmlmO2NvbG9yOiMzMzQxNTU7JztcbiAgICBjb25zdCByZWN0ID0gYW5jaG9yLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIHBvcHVwLnN0eWxlLmxlZnQgPSBgJHtNYXRoLm1heCg4LCBNYXRoLm1pbihyZWN0LmxlZnQsIHdpbmRvdy5pbm5lcldpZHRoIC0gMzI4KSl9cHhgO1xuICAgIHBvcHVwLnN0eWxlLnRvcCA9IGAke01hdGgubWluKHJlY3QuYm90dG9tICsgNSwgd2luZG93LmlubmVySGVpZ2h0IC0gMjYwKX1weGA7XG4gICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfwn6qEINCX0LDQv9C+0LvQvdC40YLRjCDQtNC+0LrRg9C80LXQvdGCJztcbiAgICBwb3B1cC5hcHBlbmRDaGlsZCh0aXRsZSk7XG5cbiAgICBydWxlcy5jb3BpZXMuZm9yRWFjaChydWxlID0+IHtcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIHJvdy5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbi10b3A6OHB4O3BhZGRpbmc6NnB4O2JhY2tncm91bmQ6I2Y4ZmFmYztib3JkZXItcmFkaXVzOjZweDsnO1xuICAgICAgICByb3cudGV4dENvbnRlbnQgPSBgJHtydWxlLmZpZWxkfTog0YHQutC+0L/QuNGA0L7QstCw0YLRjCDQt9C90LDRh9C10L3QuNC1INC80LXQttC00YMg0L/QvtC70Y/QvNC4YDtcbiAgICAgICAgcG9wdXAuYXBwZW5kQ2hpbGQocm93KTtcbiAgICB9KTtcbiAgICBydWxlcy52YWx1ZXMuZm9yRWFjaCgocnVsZSwgaW5kZXgpID0+IHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xuICAgICAgICBsYWJlbC5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7bWFyZ2luLXRvcDo4cHg7Zm9udC13ZWlnaHQ6NjAwOyc7XG4gICAgICAgIGxhYmVsLnRleHRDb250ZW50ID0gcnVsZS5maWVsZDtcbiAgICAgICAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgICAgICBpbnB1dC5kYXRhc2V0Lm1hZ2ljVmFsdWVJbmRleCA9IFN0cmluZyhpbmRleCk7XG4gICAgICAgIGlucHV0LnZhbHVlID0gcnVsZS52YWx1ZSB8fCAnJztcbiAgICAgICAgaW5wdXQucGxhY2Vob2xkZXIgPSAn0JLQstC10LTQuNGC0LUg0YLQvtGH0L3QvtC1INC30L3QsNGH0LXQvdC40LUg0LjQtyDRgdC/0LjRgdC60LAg0JzQvtC50KHQutC70LDQtCc7XG4gICAgICAgIGlucHV0LnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpibG9jazt3aWR0aDoxMDAlO2JveC1zaXppbmc6Ym9yZGVyLWJveDttYXJnaW4tdG9wOjNweDtwYWRkaW5nOjZweDtib3JkZXI6MXB4IHNvbGlkICNjYmQ1ZTE7Ym9yZGVyLXJhZGl1czo2cHg7JztcbiAgICAgICAgbGFiZWwuYXBwZW5kQ2hpbGQoaW5wdXQpO1xuICAgICAgICBwb3B1cC5hcHBlbmRDaGlsZChsYWJlbCk7XG4gICAgfSk7XG4gICAgY29uc3QgZXJyb3IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBlcnJvci5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6bm9uZTttYXJnaW4tdG9wOjhweDtwYWRkaW5nOjZweDtiYWNrZ3JvdW5kOiNmZWUyZTI7Y29sb3I6Izk5MWIxYjtib3JkZXItcmFkaXVzOjZweDsnO1xuICAgIHBvcHVwLmFwcGVuZENoaWxkKGVycm9yKTtcbiAgICBjb25zdCBhcHBseSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgIGFwcGx5LnR5cGUgPSAnYnV0dG9uJztcbiAgICBhcHBseS50ZXh0Q29udGVudCA9ICfwn6qEINCX0LDQv9C+0LvQvdC40YLRjCDQuCDRgdC+0YXRgNCw0L3QuNGC0YwnO1xuICAgIGFwcGx5LnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6MTAwJTttYXJnaW4tdG9wOjlweDtwYWRkaW5nOjhweDtib3JkZXI6MDtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiMxNmEzNGE7Y29sb3I6I2ZmZjtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXI7JztcbiAgICBhcHBseS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcbiAgICAgICAgYXBwbHkuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICBjb25zdCBvdmVycmlkZXMgPSB7fTtcbiAgICAgICAgcG9wdXAucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtbWFnaWMtdmFsdWUtaW5kZXhdJykuZm9yRWFjaChpbnB1dCA9PiB7IG92ZXJyaWRlc1tpbnB1dC5kYXRhc2V0Lm1hZ2ljVmFsdWVJbmRleF0gPSBpbnB1dC52YWx1ZTsgfSk7XG4gICAgICAgIHNhdmVNc01hZ2ljVmFsdWVPdmVycmlkZXMoZG9jLnR5cGUsIG92ZXJyaWRlcyk7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG1zQXBwbHlNYWdpY1J1bGVzKHsgc2F2ZTogdHJ1ZSwgb3ZlcnJpZGVzIH0pO1xuICAgICAgICBpZiAocmVzdWx0Lm1pc3NpbmcubGVuZ3RoIHx8IHJlc3VsdC5mYWlsZWQubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCBkZXRhaWxzID0gW1xuICAgICAgICAgICAgICAgIHJlc3VsdC5taXNzaW5nLmxlbmd0aCA/IGDQl9Cw0L/QvtC70L3QuNGC0LU6ICR7cmVzdWx0Lm1pc3Npbmcuam9pbignLCAnKX1gIDogJycsXG4gICAgICAgICAgICAgICAgcmVzdWx0LmZhaWxlZC5sZW5ndGggPyBg0J3QtSDRg9C00LDQu9C+0YHRjCDRg9GB0YLQsNC90L7QstC40YLRjDogJHtyZXN1bHQuZmFpbGVkLmpvaW4oJywgJyl9YCA6ICcnXG4gICAgICAgICAgICBdLmZpbHRlcihCb29sZWFuKS5qb2luKCcuICcpO1xuICAgICAgICAgICAgZXJyb3IudGV4dENvbnRlbnQgPSBkZXRhaWxzO1xuICAgICAgICAgICAgZXJyb3Iuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7XG4gICAgICAgICAgICBhcHBseS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIG1zVG9hc3QoYOKchSDQl9Cw0L/QvtC70L3QtdC90L4g0L/QvtC70LXQuTogJHtyZXN1bHQuY2hhbmdlZH0uINCh0L7RhdGA0LDQvdGP0Y7igKZgLCAnb2snKTtcbiAgICAgICAgY2xvc2VNc01hZ2ljUG9wdXAoKTtcbiAgICB9KTtcbiAgICBwb3B1cC5hcHBlbmRDaGlsZChhcHBseSk7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChwb3B1cCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTXNNYWdpY0ZpbGxBY3Rpb24oKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNNYWdpY0ZpbGxBY3Rpb24nKTtcbiAgICAvLyDQlNC+IDguMC4yLWJldGEg0L/QsNC70L7Rh9C60LAg0LbQuNC70LAg0YDRj9C00L7QvCDRgSDQv9C10YDQstGL0Lwg0L3QsNGB0YLRgNC+0LXQvdC90YvQvCDQv9C+0LvQtdC8LiDQo9C00LDQu9GP0LXQvFxuICAgIC8vINC+0YHRgtCw0LLRiNC40LnRgdGPIERPTSDRgdGC0LDRgNC+0Lkg0LLQtdGA0YHQuNC4OiDRgtC10L/QtdGA0Ywg0L7QvdCwINGB0YLRgNC+0LjRgtGB0Y8g0LIg0L7QsdGJ0LXQuSBxdWljay3Qv9Cw0L3QtdC70LguXG4gICAgaWYgKGV4aXN0aW5nKSB7IGV4aXN0aW5nLnJlbW92ZSgpOyBjbG9zZU1zTWFnaWNQb3B1cCgpOyB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTXNGaWVsZHNTcG9pbGVyKCkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jTXNGaWVsZHNTcG9pbGVyJyk7XG4gICAgY29uc3QgZG9jID0gbXNDdXJyZW50RG9jdW1lbnQoKTtcbiAgICBpZiAoIWRvYykge1xuICAgICAgICBleGlzdGluZz8ucmVtb3ZlKCk7XG4gICAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLW1jLW5hdGl2ZS1vdGhlci1maWVsZHNdJykuZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgICAgIGVsZW1lbnQuc3R5bGUuZGlzcGxheSA9IGVsZW1lbnQuZGF0YXNldC5tY05hdGl2ZU90aGVyRmllbGRzO1xuICAgICAgICAgICAgZGVsZXRlIGVsZW1lbnQuZGF0YXNldC5tY05hdGl2ZU90aGVyRmllbGRzO1xuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZXhpc3Rpbmc/LmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgY29uc3QgbGFiZWwgPSBtc0V4YWN0VGV4dEVsZW1lbnRzKCfQlNGA0YPQs9C40LUg0L/QvtC70Y8nKVswXTtcbiAgICBjb25zdCBuYXRpdmUgPSBsYWJlbD8uY2xvc2VzdCgnYnV0dG9uLFtyb2xlPVwiYnV0dG9uXCJdLGEnKSB8fCBsYWJlbDtcbiAgICBpZiAoIW5hdGl2ZSB8fCAhbmF0aXZlLnBhcmVudEVsZW1lbnQpIHJldHVybjtcblxuICAgIGNvbnN0IGV4cGFuZGVkID0gbmF0aXZlLmdldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcpID09PSAndHJ1ZSc7XG4gICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgYnV0dG9uLmlkID0gJ21jTXNGaWVsZHNTcG9pbGVyJztcbiAgICBidXR0b24udHlwZSA9ICdidXR0b24nO1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGAke2V4cGFuZGVkID8gJ+KWvicgOiAn4pa4J30g0JTQvtC/0L7Qu9C90LjRgtC10LvRjNC90YvQtSDQv9C+0LvRj2A7XG4gICAgYnV0dG9uLnN0eWxlLmNzc1RleHQgPSAnZGlzcGxheTpibG9jazt3aWR0aDptaW4oNDgwcHgsMTAwJSk7bWFyZ2luOjdweCAwO3BhZGRpbmc6N3B4IDEwcHg7dGV4dC1hbGlnbjpsZWZ0OydcbiAgICAgICAgKyAnYm9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2JhY2tncm91bmQ6I2Y4ZmFmYztjb2xvcjojNDc1NTY5O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjsnO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgbmF0aXZlLmNsaWNrKCk7XG4gICAgICAgIGNvbnN0IG5vd0V4cGFuZGVkID0gbmF0aXZlLmdldEF0dHJpYnV0ZSgnYXJpYS1leHBhbmRlZCcpID09PSAndHJ1ZSdcbiAgICAgICAgICAgIHx8IGJ1dHRvbi5kYXRhc2V0LmV4cGFuZGVkICE9PSAndHJ1ZSc7XG4gICAgICAgIGJ1dHRvbi5kYXRhc2V0LmV4cGFuZGVkID0gU3RyaW5nKG5vd0V4cGFuZGVkKTtcbiAgICAgICAgYnV0dG9uLnRleHRDb250ZW50ID0gYCR7bm93RXhwYW5kZWQgPyAn4pa+JyA6ICfilrgnfSDQlNC+0L/QvtC70L3QuNGC0LXQu9GM0L3Ri9C1INC/0L7Qu9GPYDtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnbXNGaWVsZHNTcG9pbGVyT3Blbl92MScpLCBTdHJpbmcobm93RXhwYW5kZWQpKTtcbiAgICB9KTtcbiAgICBuYXRpdmUuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KCdhZnRlcmVuZCcsIGJ1dHRvbik7XG4gICAgbmF0aXZlLmRhdGFzZXQubWNOYXRpdmVPdGhlckZpZWxkcyA9IG5hdGl2ZS5zdHlsZS5kaXNwbGF5IHx8ICcnO1xuICAgIG5hdGl2ZS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xufVxuXG5mdW5jdGlvbiByZWNvbmNpbGVNc0VuaGFuY2VtZW50cygpIHtcbiAgICBpZiAoIS9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkpIHJldHVybjtcbiAgICBidWlsZE1zUXVpY2tQYW5lbCgpO1xuICAgIGJ1aWxkTXNPcmRlclN0YXR1c0FjdGlvbigpO1xuICAgIGlmICh0eXBlb2YgYnVpbGRNc01hZ2ljRmlsbEFjdGlvbiA9PT0gJ2Z1bmN0aW9uJykgYnVpbGRNc01hZ2ljRmlsbEFjdGlvbigpO1xuICAgIGlmICh0eXBlb2YgYnVpbGRNc0ZpZWxkc1Nwb2lsZXIgPT09ICdmdW5jdGlvbicpIGJ1aWxkTXNGaWVsZHNTcG9pbGVyKCk7XG59XG5cbmZ1bmN0aW9uIG1zUXVpY2tQYW5lbElzSGVhbHRoeSgpIHtcbiAgICBpZiAoIS9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkgfHwgIW1zUXVpY2tQYW5lbEVuYWJsZWQpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IGtpbmQgPSBPYmplY3Qua2V5cyhNU19RVUlDS19QQU5FTF9DT05GSUcpLmZpbmQoayA9PiBNU19RVUlDS19QQU5FTF9DT05GSUdba10ubWFya2VyKCkpO1xuICAgIGlmICgha2luZCkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgY2ZnID0gTVNfUVVJQ0tfUEFORUxfQ09ORklHW2tpbmRdO1xuICAgIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21jUXVpY2tQYW5lbCcpO1xuICAgIGNvbnN0IHNpZ25hdHVyZSA9IFtjZmcubWFnaWMgPyAnbWFnaWMnIDogJycsIC4uLmNmZy5jcmVhdGUsIC4uLmNmZy5wcmludF0uam9pbignXFx1MDAxZicpO1xuICAgIGNvbnN0IHF1aWNrRW5hYmxlZCA9IEhBQ0tFUl9RVUlDS19BUElfUk9XX0VOQUJMRUQgJiYgaGFja2VyUXVpY2tCdXR0b25zRW5hYmxlZDtcbiAgICBjb25zdCBleHBlY3RlZEJ1dHRvbkNvdW50ID0gY2ZnLmNyZWF0ZS5sZW5ndGggKyBjZmcucHJpbnQubGVuZ3RoICsgKGNmZy5tYWdpYyA/IDEgOiAwKTtcbiAgICByZXR1cm4gISFwYW5lbCAmJiBwYW5lbC5pc0Nvbm5lY3RlZCAmJiBwYW5lbC5kYXRhc2V0LmtpbmQgPT09IGtpbmRcbiAgICAgICAgJiYgcGFuZWwuZGF0YXNldC5xdWlja1NpZ25hdHVyZSA9PT0gc2lnbmF0dXJlXG4gICAgICAgICYmIHBhbmVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gZXhwZWN0ZWRCdXR0b25Db3VudFxuICAgICAgICAmJiAoIWNmZy5tYWdpYyB8fCBwYW5lbC5xdWVyeVNlbGVjdG9yKCcjbWNNYWdpY1BhbmVsQWN0aW9uJyk/LmlzQ29ubmVjdGVkKVxuICAgICAgICAmJiAoIXF1aWNrRW5hYmxlZCB8fCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWNIYWNrZXJRdWlja1JvdycpPy5pc0Nvbm5lY3RlZCk7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0TXNRdWlja1BhbmVsS2VlcGFsaXZlKCkge1xuICAgIGlmIChtc1F1aWNrS2VlcGFsaXZlVGltZXIpIHJldHVybjtcbiAgICBtc1F1aWNrS2VlcGFsaXZlVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICAgIGlmICghbXNRdWlja1BhbmVsSXNIZWFsdGh5KCkpIGJ1aWxkTXNRdWlja1BhbmVsKCk7XG4gICAgfSwgMTAwMCk7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0TXNTcGFPYnNlcnZlcigpIHtcbiAgICBpZiAoIS9vbmxpbmVcXC5tb3lza2xhZFxcLnJ1JC8udGVzdChsb2NhdGlvbi5ob3N0bmFtZSkgfHwgbXNTcGFPYnNlcnZlcikgcmV0dXJuO1xuICAgIHJlY29uY2lsZU1zRW5oYW5jZW1lbnRzKCk7XG4gICAgc3RhcnRNc1F1aWNrUGFuZWxLZWVwYWxpdmUoKTtcbiAgICBtc1NwYU9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQobXNTcGFSZWNvbmNpbGVUaW1lcik7XG4gICAgICAgIG1zU3BhUmVjb25jaWxlVGltZXIgPSBzZXRUaW1lb3V0KHJlY29uY2lsZU1zRW5oYW5jZW1lbnRzLCAzNTApO1xuICAgIH0pO1xuICAgIG1zU3BhT2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbn1cbiIsIi8vIOKUgOKUgOKUgCDQntC/0L7QstC10YnQsNGC0LXQu9GMINC90L7QstGL0YUg0LfQsNC60LDQt9C+0LIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQn9C10YDQuNC+0LTQuNGH0LXRgdC60Lgg0L/RgNC+0LLQtdGA0Y/QtdGCIGN1c3RvbWVyb3JkZXIg0LLRi9Cx0YDQsNC90L3QvtC5INC+0YDQs9Cw0L3QuNC30LDRhtC40Lgg0Lgg0L/QvtC00LDRkdGCINGB0LjQs9C90LDQu1xuLy8g0L3QsCDQutCw0LbQtNC+0Lwg0L7Qv9GA0L7RgdC1LCDQtdGB0LvQuCDQtdGB0YLRjCDQt9Cw0LrQsNC3INCyINC+0LTQvdC+0Lwg0LjQtyDQstGL0LHRgNCw0L3QvdGL0YUg0YHRgtCw0YLRg9GB0L7Qsi5cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJOb3JtYWxpemVTZXR0aW5ncyhyYXcpIHtcbiAgICBjb25zdCBpbnRlcnZhbCA9IE51bWJlcihyYXc/LmludGVydmFsTWludXRlcyk7XG4gICAgY29uc3QgdG9hc3REdXJhdGlvbiA9IE51bWJlcihyYXc/LnRvYXN0RHVyYXRpb25NaW51dGVzKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBlbmFibGVkOiByYXc/LmVuYWJsZWQgIT09IGZhbHNlLFxuICAgICAgICBzb3VuZEVuYWJsZWQ6IHJhdz8uc291bmRFbmFibGVkICE9PSBmYWxzZSxcbiAgICAgICAgaW50ZXJ2YWxNaW51dGVzOiBOdW1iZXIuaXNGaW5pdGUoaW50ZXJ2YWwpXG4gICAgICAgICAgICA/IE1hdGgubWluKDE0NDAsIE1hdGgubWF4KDEsIE1hdGgucm91bmQoaW50ZXJ2YWwpKSlcbiAgICAgICAgICAgIDogSEFDS0VSX05PVElGSUVSX0RFRkFVTFRfSU5URVJWQUxfTUlOVVRFUyxcbiAgICAgICAgdG9hc3REdXJhdGlvbk1pbnV0ZXM6IE51bWJlci5pc0Zpbml0ZSh0b2FzdER1cmF0aW9uKVxuICAgICAgICAgICAgPyBNYXRoLm1pbigxNDQwLCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKHRvYXN0RHVyYXRpb24pKSlcbiAgICAgICAgICAgIDogNSxcbiAgICAgICAgb3JnYW5pemF0aW9uSHJlZnM6IFsuLi5uZXcgU2V0KChBcnJheS5pc0FycmF5KHJhdz8ub3JnYW5pemF0aW9uSHJlZnMpXG4gICAgICAgICAgICA/IHJhdy5vcmdhbml6YXRpb25IcmVmcyA6IFtyYXc/Lm9yZ2FuaXphdGlvbkhyZWZdKVxuICAgICAgICAgICAgLmZpbHRlcih2YWx1ZSA9PiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLnRyaW0oKSkpXSxcbiAgICAgICAgc3RhdHVzSHJlZnM6IEFycmF5LmlzQXJyYXkocmF3Py5zdGF0dXNIcmVmcylcbiAgICAgICAgICAgID8gWy4uLm5ldyBTZXQocmF3LnN0YXR1c0hyZWZzLmZpbHRlcih2YWx1ZSA9PiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlKSldXG4gICAgICAgICAgICA6IFtdXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJMb2FkU2V0dGluZ3MoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmF3ID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJPcmRlck5vdGlmaWVyX3YxJykpIHx8ICd7fScpO1xuICAgICAgICBjb25zdCBtYXRjaGVzID0gKHJhdy5yZWZlcmVuY2VTY29wZSB8fCAnJykgPT09IG1zUmVmZXJlbmNlU2NvcGU7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2V0dGluZ3MgPSBoYWNrZXJOb3RpZmllck5vcm1hbGl6ZVNldHRpbmdzKG1hdGNoZXMgPyByYXcgOiB7IC4uLnJhdywgb3JnYW5pemF0aW9uSHJlZjogJycsIG9yZ2FuaXphdGlvbkhyZWZzOiBbXSwgc3RhdHVzSHJlZnM6IFtdIH0pO1xuICAgICAgICBpZiAobWF0Y2hlcykgaGFja2VyTm90aWZpZXJTYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTdGF0dXNTZWxlY3Rpb25Jbml0aWFsaXplZCA9IG1hdGNoZXMgJiYgQXJyYXkuaXNBcnJheShyYXc/LnN0YXR1c0hyZWZzKTtcbiAgICAgICAgY29uc3Qgb3JnYW5pemF0aW9ucyA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zX3YxJykpIHx8ICdbXScpO1xuICAgICAgICBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMgPSBtc1JlZmVyZW5jZVNjb3BlID8gKG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMub3JnYW5pemF0aW9uIHx8IFtdKSA6IEFycmF5LmlzQXJyYXkob3JnYW5pemF0aW9ucylcbiAgICAgICAgICAgID8gb3JnYW5pemF0aW9ucy5maWx0ZXIoaXRlbSA9PiBpdGVtICYmIHR5cGVvZiBpdGVtLmhyZWYgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBpdGVtLm5hbWUgPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgOiBbXTtcbiAgICAgICAgY29uc3Qgc2VlbiA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyTm90aWZpZXJTZWVuX3YxJykpIHx8ICd7fScpO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNlZW5CeU9yZ2FuaXphdGlvbiA9IHNlZW4gJiYgdHlwZW9mIHNlZW4gPT09ICdvYmplY3QnID8gc2VlbiA6IHt9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2V0dGluZ3MgPSBoYWNrZXJOb3RpZmllck5vcm1hbGl6ZVNldHRpbmdzKHt9KTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zID0gW107XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2VlbkJ5T3JnYW5pemF0aW9uID0ge307XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU3RhdHVzU2VsZWN0aW9uSW5pdGlhbGl6ZWQgPSBmYWxzZTtcbiAgICAgICAgZGVidWdFcnJvcignaGFja2VyLW5vdGlmaWVyJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0LfQsNCz0YDRg9C30LjRgtGMINC90LDRgdGC0YDQvtC50LrQuCcsIGVycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU2F2ZVNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck9yZGVyTm90aWZpZXJfdjEnKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgLi4uaGFja2VyTm90aWZpZXJTZXR0aW5ncywgLi4uKG1zUmVmZXJlbmNlU2NvcGUgPyB7IHJlZmVyZW5jZVNjb3BlOiBtc1JlZmVyZW5jZVNjb3BlIH0gOiB7fSlcbiAgICAgICAgfSkpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGRlYnVnRXJyb3IoJ2hhY2tlci1ub3RpZmllcicsICfQndC1INGD0LTQsNC70L7RgdGMINGB0L7RhdGA0LDQvdC40YLRjCDQvdCw0YHRgtGA0L7QudC60LgnLCBlcnJvcik7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclNhdmVPcmdhbml6YXRpb25zKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKHN0b3JhZ2VLZXkoJ2hhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9uc192MScpLCBKU09OLnN0cmluZ2lmeShoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBkZWJ1Z0Vycm9yKCdoYWNrZXItbm90aWZpZXInLCAn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L7RgNCz0LDQvdC40LfQsNGG0LjQuCcsIGVycm9yKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU2F2ZVNlZW4oKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oc3RvcmFnZUtleSgnaGFja2VyTm90aWZpZXJTZWVuX3YxJyksIEpTT04uc3RyaW5naWZ5KGhhY2tlck5vdGlmaWVyU2VlbkJ5T3JnYW5pemF0aW9uKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgZGVidWdFcnJvcignaGFja2VyLW5vdGlmaWVyJywgJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINC40YHRgtC+0YDQuNGOINC30LDQutCw0LfQvtCyJywgZXJyb3IpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJTZXRTdGF0dXMobWVzc2FnZSwga2luZCA9ICdpbmZvJykge1xuICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlck5vdGlmaWVyU3RhdHVzJyk7XG4gICAgaWYgKCFlbCkgcmV0dXJuO1xuICAgIGVsLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgICBlbC5zdHlsZS5jb2xvciA9IGtpbmQgPT09ICdlcnJvcicgPyAnI2I5MWMxYycgOiBraW5kID09PSAnb2snID8gJyMxNjY1MzQnIDogJyM2NDc0OGInO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllckZpbGxDb250cm9scyhyb290ID0gZG9jdW1lbnQpIHtcbiAgICBjb25zdCBvcmdhbml6YXRpb24gPSByb290LnF1ZXJ5U2VsZWN0b3IoJyNoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbicpO1xuICAgIGlmIChvcmdhbml6YXRpb24pIHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBoYWNrZXJOb3RpZmllclNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzO1xuICAgICAgICBvcmdhbml6YXRpb24uaW5uZXJIVE1MID0gJyc7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucy5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgICAgICBvcHRpb24udmFsdWUgPSBpdGVtLmhyZWY7XG4gICAgICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSBpdGVtLm5hbWU7XG4gICAgICAgICAgICBvcHRpb24udGl0bGUgPSBpdGVtLm5hbWU7XG4gICAgICAgICAgICBvcHRpb24uc2VsZWN0ZWQgPSBzZWxlY3RlZC5pbmNsdWRlcyhpdGVtLmhyZWYpO1xuICAgICAgICAgICAgb3JnYW5pemF0aW9uLmFwcGVuZENoaWxkKG9wdGlvbik7XG4gICAgICAgIH0pO1xuICAgICAgICBzZWxlY3RlZC5mb3JFYWNoKGhyZWYgPT4gaW50ZXJuYWxPcmRlckNoZWNrQWRkU2F2ZWRPcHRpb24ob3JnYW5pemF0aW9uLCBocmVmLCAn0LDRjyDQvtGA0LPQsNC90LjQt9Cw0YbQuNGPJykpO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YXR1c2VzID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcjaGFja2VyTm90aWZpZXJTdGF0dXNlcycpO1xuICAgIGlmIChzdGF0dXNlcykge1xuICAgICAgICBzdGF0dXNlcy5pbm5lckhUTUwgPSAnJztcbiAgICAgICAgaGFja2VyU3RhdGVzLmZvckVhY2goaXRlbSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IGl0ZW0uaHJlZjtcbiAgICAgICAgICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGl0ZW0ubmFtZTtcbiAgICAgICAgICAgIG9wdGlvbi5zZWxlY3RlZCA9IGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnMuaW5jbHVkZXMoaXRlbS5ocmVmKTtcbiAgICAgICAgICAgIHN0YXR1c2VzLmFwcGVuZENoaWxkKG9wdGlvbik7XG4gICAgICAgIH0pO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNldHRpbmdzLnN0YXR1c0hyZWZzLmZvckVhY2goaHJlZiA9PiBpbnRlcm5hbE9yZGVyQ2hlY2tBZGRTYXZlZE9wdGlvbihzdGF0dXNlcywgaHJlZiwgJ9GL0Lkg0YHRgtCw0YLRg9GBJykpO1xuICAgIH1cbiAgICBjb25zdCBlbmFibGVkID0gcm9vdC5xdWVyeVNlbGVjdG9yKCcjaGFja2VyTm90aWZpZXJFbmFibGVkJyk7XG4gICAgaWYgKGVuYWJsZWQpIGVuYWJsZWQuY2hlY2tlZCA9IGhhY2tlck5vdGlmaWVyU2V0dGluZ3MuZW5hYmxlZDtcbiAgICBjb25zdCBzb3VuZEVuYWJsZWQgPSByb290LnF1ZXJ5U2VsZWN0b3IoJyNoYWNrZXJOb3RpZmllclNvdW5kRW5hYmxlZCcpO1xuICAgIGlmIChzb3VuZEVuYWJsZWQpIHNvdW5kRW5hYmxlZC5jaGVja2VkID0gaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zb3VuZEVuYWJsZWQ7XG4gICAgY29uc3QgaW50ZXJ2YWwgPSByb290LnF1ZXJ5U2VsZWN0b3IoJyNoYWNrZXJOb3RpZmllckludGVydmFsJyk7XG4gICAgaWYgKGludGVydmFsKSBpbnRlcnZhbC52YWx1ZSA9IFN0cmluZyhoYWNrZXJOb3RpZmllclNldHRpbmdzLmludGVydmFsTWludXRlcyk7XG4gICAgY29uc3QgdG9hc3REdXJhdGlvbiA9IHJvb3QucXVlcnlTZWxlY3RvcignI2hhY2tlck5vdGlmaWVyVG9hc3REdXJhdGlvbicpO1xuICAgIGlmICh0b2FzdER1cmF0aW9uKSB0b2FzdER1cmF0aW9uLnZhbHVlID0gU3RyaW5nKGhhY2tlck5vdGlmaWVyU2V0dGluZ3MudG9hc3REdXJhdGlvbk1pbnV0ZXMpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclNlbGVjdERlZmF1bHRTdGF0dXMoKSB7XG4gICAgaWYgKGhhY2tlck5vdGlmaWVyU3RhdHVzU2VsZWN0aW9uSW5pdGlhbGl6ZWQgfHwgIWhhY2tlclN0YXRlcy5sZW5ndGgpIHJldHVybjtcbiAgICBjb25zdCBmcmVzaCA9IGhhY2tlclN0YXRlcy5maW5kKGl0ZW0gPT4gU3RyaW5nKGl0ZW0ubmFtZSB8fCAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCkgPT09ICfQvdC+0LLRi9C5Jyk7XG4gICAgaWYgKGZyZXNoKSB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnMgPSBbZnJlc2guaHJlZl07XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU3RhdHVzU2VsZWN0aW9uSW5pdGlhbGl6ZWQgPSB0cnVlO1xuICAgICAgICBoYWNrZXJOb3RpZmllclNhdmVTZXR0aW5ncygpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJSZWZyZXNoT3JnYW5pemF0aW9ucyhxdWlldCA9IGZhbHNlKSB7XG4gICAgcmV0dXJuIG1zUmVmZXJlbmNlTG9hZCgnb3JnYW5pemF0aW9uJywgeyBmb3JjZTogdHJ1ZSB9KVxuICAgICAgICAudGhlbihpdGVtcyA9PiB7XG4gICAgICAgICAgICBpZiAoIXF1aWV0KSBoYWNrZXJMb2coYNCe0YDQs9Cw0L3QuNC30LDRhtC40Lgg0L7QsdC90L7QstC70LXQvdGLOiAke2hhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucy5sZW5ndGh9INGI0YIuYCwgJ29rJyk7XG4gICAgICAgICAgICByZXR1cm4gaXRlbXM7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICBpZiAoIXF1aWV0KSBoYWNrZXJMb2coJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Lg6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJyk7XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllclNldFN0YXR1cygn4pqg77iPINCd0LUg0YPQtNCw0LvQvtGB0Ywg0LfQsNCz0YDRg9C30LjRgtGMINC+0YDQs9Cw0L3QuNC30LDRhtC40LgnLCAnZXJyb3InKTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJQbGF5QWxhcm0oKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKCFoYWNrZXJOb3RpZmllckF1ZGlvKSBoYWNrZXJOb3RpZmllckF1ZGlvID0gbmV3IEF1ZGlvKEhBQ0tFUl9OT1RJRklFUl9BVURJT19VUkwpO1xuICAgICAgICBoYWNrZXJOb3RpZmllckF1ZGlvLmN1cnJlbnRUaW1lID0gMDtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gaGFja2VyTm90aWZpZXJBdWRpby5wbGF5KCk7XG4gICAgICAgIGlmIChyZXN1bHQ/LmNhdGNoKSByZXN1bHQuY2F0Y2goKCkgPT4ge1xuICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMoJ+KaoO+4jyDQkdGA0LDRg9C30LXRgCDQt9Cw0LHQu9C+0LrQuNGA0L7QstCw0Lsg0LfQstGD0Log4oCUINC90LDQttC80LjRgtC1IMKr0KLQtdGB0YIg0YHQuNCz0L3QsNC70LDCuycsICdlcnJvcicpO1xuICAgICAgICAgICAgaGFja2VyTG9nKCfQl9Cy0YPQuiDQt9Cw0LHQu9C+0LrQuNGA0L7QstCw0L0g0LHRgNCw0YPQt9C10YDQvtC8OyDRgNCw0LfRgNC10YjQuNGC0LUg0LLQvtGB0L/RgNC+0LjQt9Cy0LXQtNC10L3QuNC1INC60L3QvtC/0LrQvtC5IMKr0KLQtdGB0YIg0YHQuNCz0L3QsNC70LDCuycsICd3YXJuJyk7XG4gICAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGhhY2tlckxvZygn0JfQstGD0Lo6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyJyk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllckVuc3VyZUluZGljYXRvcigpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyLmluZGljYXRvcigpO1xuICAgIGxldCBpbmRpY2F0b3IgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyTm90aWZpZXJJbmRpY2F0b3InKTtcbiAgICBpZiAoIWhhY2tlck5vdGlmaWVyVGltZXIpIHtcbiAgICAgICAgaW5kaWNhdG9yPy5yZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoaW5kaWNhdG9yKSByZXR1cm47XG4gICAgaW5kaWNhdG9yID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xuICAgIGluZGljYXRvci5pZCA9ICdoYWNrZXJOb3RpZmllckluZGljYXRvcic7XG4gICAgaW5kaWNhdG9yLnRleHRDb250ZW50ID0gJ/CfkLsnO1xuICAgIGluZGljYXRvci50aXRsZSA9ICfQntC/0L7QstC10YnQsNGC0LXQu9GMINC90L7QstGL0YUg0LfQsNC60LDQt9C+0LIg0LLQutC70Y7Rh9GR0L0nO1xuICAgIGluZGljYXRvci5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBpbmRpY2F0b3IudGl0bGUpO1xuICAgIGluZGljYXRvci5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmZpeGVkO3JpZ2h0OjE0cHg7Ym90dG9tOjEycHg7ei1pbmRleDoyMTQ3NDgzMDAwOydcbiAgICAgICAgKyAnZm9udC1zaXplOjE4cHg7bGluZS1oZWlnaHQ6MTtvcGFjaXR5Oi4yODtmaWx0ZXI6Z3JheXNjYWxlKC4zNSk7J1xuICAgICAgICArICdwb2ludGVyLWV2ZW50czpub25lO3VzZXItc2VsZWN0Om5vbmU7dHJhbnNpdGlvbjpvcGFjaXR5IC4ycyxmaWx0ZXIgLjJzOyc7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChpbmRpY2F0b3IpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllck9yZGVyVXJsKG9yZGVyKSB7XG4gICAgY29uc3QgaWQgPSBvcmRlcj8uaWQ7XG4gICAgaWYgKCFpZCkgcmV0dXJuICcnO1xuICAgIGNvbnN0IG9yaWdpbiA9IC8oXnxcXC4pb25saW5lXFwubW95c2tsYWRcXC5ydSQvaS50ZXN0KGxvY2F0aW9uLmhvc3RuYW1lKVxuICAgICAgICA/IGxvY2F0aW9uLm9yaWdpblxuICAgICAgICA6ICdodHRwczovL29ubGluZS5tb3lza2xhZC5ydSc7XG4gICAgcmV0dXJuIGAke29yaWdpbn0vYXBwLyNjdXN0b21lcm9yZGVyL2VkaXQ/aWQ9JHtlbmNvZGVVUklDb21wb25lbnQoaWQpfWA7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9uTGFiZWwobmFtZSkge1xuICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xuICAgIGxhYmVsLmNsYXNzTmFtZSA9ICdoYWNrZXItbm90aWZpZXItb3JnYW5pemF0aW9uJztcbiAgICBsYWJlbC50ZXh0Q29udGVudCA9IG5hbWUgfHwgJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAnO1xuICAgIGxhYmVsLnRpdGxlID0gbGFiZWwudGV4dENvbnRlbnQ7XG4gICAgbGFiZWwuc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmJsb2NrO21heC13aWR0aDoxMDAlO292ZXJmbG93OmhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzO3doaXRlLXNwYWNlOm5vd3JhcDtmb250LXNpemU6MTFweDtvcGFjaXR5Oi44NTsnO1xuICAgIHJldHVybiBsYWJlbDtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJTaG93VG9hc3Qob3JkZXIpIHtcbiAgICBsZXQgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllclRvYXN0SG9zdCcpO1xuICAgIGlmICghaG9zdCkge1xuICAgICAgICBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgIGhvc3QuaWQgPSAnaGFja2VyTm90aWZpZXJUb2FzdEhvc3QnO1xuICAgICAgICBob3N0LnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7dG9wOjE4cHg7cmlnaHQ6MThweDt6LWluZGV4OjIxNDc0ODMwMDI7J1xuICAgICAgICAgICAgKyAnZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpmbGV4LWVuZDtnYXA6OHB4OydcbiAgICAgICAgICAgICsgJ3dpZHRoOm1pbigzNjBweCxjYWxjKDEwMHZ3IC0gMzZweCkpO3BvaW50ZXItZXZlbnRzOm5vbmU7JztcbiAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChob3N0KTtcbiAgICB9XG5cbiAgICBjb25zdCB0b2FzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRvYXN0LmNsYXNzTmFtZSA9ICdoYWNrZXItbm90aWZpZXItdG9hc3QnO1xuICAgIGNvbnN0IGxpZmV0aW1lID0gaGFja2VyTm90aWZpZXJTZXR0aW5ncy50b2FzdER1cmF0aW9uTWludXRlcyAqIDYwICogMTAwMDtcbiAgICB0b2FzdC5kYXRhc2V0LmRpc21pc3NNcyA9IFN0cmluZyhsaWZldGltZSk7XG4gICAgdG9hc3Quc3R5bGUuY3NzVGV4dCA9ICdib3gtc2l6aW5nOmJvcmRlci1ib3g7d2lkdGg6MTAwJTtwYWRkaW5nOjExcHggMTNweCAxMnB4OydcbiAgICAgICAgKyAnYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTQ1ZGVnLCMxMTE4MjcsIzFmMjkzNyk7J1xuICAgICAgICArICdib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjQ4LDExMywxMTMsLjcyKTtib3JkZXItbGVmdDo0cHggc29saWQgI2VmNDQ0NDsnXG4gICAgICAgICsgJ2JvcmRlci1yYWRpdXM6MTBweDtib3gtc2hhZG93OjAgMTBweCAyOHB4IHJnYmEoMiw2LDIzLC4zNSk7J1xuICAgICAgICArICdjb2xvcjojZjhmYWZjO2ZvbnQ6MTJweC8xLjM1IFNlZ29lIFVJLHNhbnMtc2VyaWY7cG9pbnRlci1ldmVudHM6YXV0bzsnXG4gICAgICAgICsgJ29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWCgyMnB4KTt0cmFuc2l0aW9uOm9wYWNpdHkgLjE4cyBlYXNlLHRyYW5zZm9ybSAuMThzIGVhc2U7JztcblxuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgdGl0bGUuc3R5bGUuY3NzVGV4dCA9ICdmb250LXdlaWdodDo4MDA7Zm9udC1zaXplOjEzcHg7bGV0dGVyLXNwYWNpbmc6LjI1cHg7Y29sb3I6I2ZlY2FjYTsnO1xuICAgIHRpdGxlLnRleHRDb250ZW50ID0gJ+KaoO+4jyDwn5C78J+UtCDQndCe0JLQq9CZINCX0JDQmtCQ0JcnO1xuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBuYW1lLnN0eWxlLmNzc1RleHQgPSAnbWFyZ2luLXRvcDo1cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOiNmZmY7JztcbiAgICBjb25zdCBvcmRlclVybCA9IGhhY2tlck5vdGlmaWVyT3JkZXJVcmwob3JkZXIpO1xuICAgIGlmIChvcmRlclVybCkge1xuICAgICAgICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYScpO1xuICAgICAgICBsaW5rLmhyZWYgPSBvcmRlclVybDtcbiAgICAgICAgbGluay50YXJnZXQgPSAnX2JsYW5rJztcbiAgICAgICAgbGluay5yZWwgPSAnbm9vcGVuZXIgbm9yZWZlcnJlcic7XG4gICAgICAgIGxpbmsudGV4dENvbnRlbnQgPSBvcmRlcj8ubmFtZSB8fCBvcmRlcj8uaWQgfHwgJ9CR0LXQtyDQvdC+0LzQtdGA0LAnO1xuICAgICAgICBsaW5rLnRpdGxlID0gJ9Ce0YLQutGA0YvRgtGMINC30LDQutCw0Lcg0LIg0L3QvtCy0L7QuSDQstC60LvQsNC00LrQtSc7XG4gICAgICAgIGxpbmsuc3R5bGUuY3NzVGV4dCA9ICdjb2xvcjojZmZmO3RleHQtZGVjb3JhdGlvbjp1bmRlcmxpbmU7dGV4dC1kZWNvcmF0aW9uLWNvbG9yOiNmODcxNzE7J1xuICAgICAgICAgICAgKyAndGV4dC11bmRlcmxpbmUtb2Zmc2V0OjJweDtjdXJzb3I6cG9pbnRlcjsnO1xuICAgICAgICBuYW1lLmFwcGVuZENoaWxkKGxpbmspO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIG5hbWUudGV4dENvbnRlbnQgPSBvcmRlcj8ubmFtZSB8fCAn0JHQtdC3INC90L7QvNC10YDQsCc7XG4gICAgfVxuICAgIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHN0YXR1cy5zdHlsZS5jc3NUZXh0ID0gJ21hcmdpbi10b3A6MnB4O2NvbG9yOiNjYmQ1ZTE7JztcbiAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBg0KHRgtCw0YLRg9GBOiAke29yZGVyPy5zdGF0ZU5hbWUgfHwgJ9Cd0L7QstGL0LknfWA7XG4gICAgdG9hc3QuYXBwZW5kKHRpdGxlLCBuYW1lLCBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbkxhYmVsKG9yZGVyPy5vcmdhbml6YXRpb25OYW1lKSwgc3RhdHVzKTtcbiAgICBpZiAob3JkZXI/LnBhcnRpYWwpIHtcbiAgICAgICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICB3YXJuaW5nLnN0eWxlLmNzc1RleHQgPSAnbWFyZ2luLXRvcDozcHg7Y29sb3I6I2ZiYmYyNDsnO1xuICAgICAgICB3YXJuaW5nLnRleHRDb250ZW50ID0gJ+KaoCDQndC10L/QvtC70L3Ri9C5INC+0L/RgNC+0YEg0L7RgNCz0LDQvdC40LfQsNGG0LjQuSc7XG4gICAgICAgIHRvYXN0LmFwcGVuZENoaWxkKHdhcm5pbmcpO1xuICAgIH1cblxuICAgIGxldCBjbG9zZWQgPSBmYWxzZTtcbiAgICBsZXQgcGF1c2VkID0gZmFsc2U7XG4gICAgbGV0IGRpc21pc3NUaW1lciA9IG51bGw7XG4gICAgbGV0IHJlbWFpbmluZyA9IGxpZmV0aW1lO1xuICAgIGxldCB0aW1lclN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgY29uc3QgcmVtb3ZlVG9hc3QgPSAoKSA9PiB7XG4gICAgICAgIGlmIChjbG9zZWQpIHJldHVybjtcbiAgICAgICAgY2xvc2VkID0gdHJ1ZTtcbiAgICAgICAgaWYgKGRpc21pc3NUaW1lcikgd2luZG93LmNsZWFyVGltZW91dChkaXNtaXNzVGltZXIpO1xuICAgICAgICB0b2FzdC5yZW1vdmUoKTtcbiAgICAgICAgaWYgKCFob3N0LmNoaWxkcmVuLmxlbmd0aCkgaG9zdC5yZW1vdmUoKTtcbiAgICB9O1xuICAgIGNvbnN0IGZhZGVUb2FzdCA9ICgpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICBjbG9zZWQgPSB0cnVlO1xuICAgICAgICB0b2FzdC5zdHlsZS5vcGFjaXR5ID0gJzAnO1xuICAgICAgICB0b2FzdC5zdHlsZS50cmFuc2Zvcm0gPSAndHJhbnNsYXRlWCgyMnB4KSc7XG4gICAgICAgIHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHRvYXN0LnJlbW92ZSgpO1xuICAgICAgICAgICAgaWYgKCFob3N0LmNoaWxkcmVuLmxlbmd0aCkgaG9zdC5yZW1vdmUoKTtcbiAgICAgICAgfSwgMjIwKTtcbiAgICB9O1xuICAgIGNvbnN0IHNjaGVkdWxlRGlzbWlzcyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCB8fCBwYXVzZWQgfHwgIWxpZmV0aW1lKSByZXR1cm47XG4gICAgICAgIHRpbWVyU3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgZGlzbWlzc1RpbWVyID0gd2luZG93LnNldFRpbWVvdXQoZmFkZVRvYXN0LCByZW1haW5pbmcpO1xuICAgIH07XG4gICAgdG9hc3QuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VlbnRlcicsICgpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCB8fCBwYXVzZWQpIHJldHVybjtcbiAgICAgICAgcGF1c2VkID0gdHJ1ZTtcbiAgICAgICAgdG9hc3QuZGF0YXNldC50aW1lclBhdXNlZCA9ICd0cnVlJztcbiAgICAgICAgaWYgKGRpc21pc3NUaW1lcikgd2luZG93LmNsZWFyVGltZW91dChkaXNtaXNzVGltZXIpO1xuICAgICAgICByZW1haW5pbmcgPSBNYXRoLm1heCgwLCByZW1haW5pbmcgLSAoRGF0ZS5ub3coKSAtIHRpbWVyU3RhcnRlZEF0KSk7XG4gICAgfSk7XG4gICAgdG9hc3QuYWRkRXZlbnRMaXN0ZW5lcignbW91c2VsZWF2ZScsICgpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCB8fCAhcGF1c2VkKSByZXR1cm47XG4gICAgICAgIHBhdXNlZCA9IGZhbHNlO1xuICAgICAgICB0b2FzdC5kYXRhc2V0LnRpbWVyUGF1c2VkID0gJ2ZhbHNlJztcbiAgICAgICAgc2NoZWR1bGVEaXNtaXNzKCk7XG4gICAgfSk7XG4gICAge1xuICAgICAgICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgICBjbG9zZS50eXBlID0gJ2J1dHRvbic7XG4gICAgICAgIGNsb3NlLnRleHRDb250ZW50ID0gJ+KclSc7XG4gICAgICAgIGNsb3NlLnRpdGxlID0gJ9Cj0LTQsNC70LjRgtGMINGD0LLQtdC00L7QvNC70LXQvdC40LUnO1xuICAgICAgICBjbG9zZS5zdHlsZS5jc3NUZXh0ID0gJ3Bvc2l0aW9uOmFic29sdXRlO3RvcDo1cHg7cmlnaHQ6N3B4O3BhZGRpbmc6MDtib3JkZXI6MDsnXG4gICAgICAgICAgICArICdiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOiNmZWNhY2E7Zm9udC1zaXplOjE1cHg7bGluZS1oZWlnaHQ6MTtjdXJzb3I6cG9pbnRlcjsnO1xuICAgICAgICBjbG9zZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHJlbW92ZVRvYXN0KTtcbiAgICAgICAgdG9hc3Quc3R5bGUucG9zaXRpb24gPSAncmVsYXRpdmUnO1xuICAgICAgICB0b2FzdC5hcHBlbmRDaGlsZChjbG9zZSk7XG5cbiAgICAgICAgY29uc3QgY2xvc2VCdXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgY2xvc2VCdXR0b24udHlwZSA9ICdidXR0b24nO1xuICAgICAgICBjbG9zZUJ1dHRvbi50ZXh0Q29udGVudCA9ICfQo9C00LDQu9C40YLRjCc7XG4gICAgICAgIGNsb3NlQnV0dG9uLnN0eWxlLmNzc1RleHQgPSAnbWFyZ2luLXRvcDo4cHg7cGFkZGluZzozcHggOHB4O2JvcmRlcjoxcHggc29saWQgIzY0NzQ4YjsnXG4gICAgICAgICAgICArICdib3JkZXItcmFkaXVzOjVweDtiYWNrZ3JvdW5kOiMzMzQxNTU7Y29sb3I6I2Y4ZmFmYztmb250LXNpemU6MTBweDtjdXJzb3I6cG9pbnRlcjsnO1xuICAgICAgICBjbG9zZUJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHJlbW92ZVRvYXN0KTtcbiAgICAgICAgdG9hc3QuYXBwZW5kQ2hpbGQoY2xvc2VCdXR0b24pO1xuICAgIH1cbiAgICBob3N0LmFwcGVuZENoaWxkKHRvYXN0KTtcblxuICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgIHRvYXN0LnN0eWxlLm9wYWNpdHkgPSAnMSc7XG4gICAgICAgIHRvYXN0LnN0eWxlLnRyYW5zZm9ybSA9ICd0cmFuc2xhdGVYKDApJztcbiAgICB9KTtcbiAgICBzY2hlZHVsZURpc21pc3MoKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyTm90aWZpZXJUcmFjZShtZXNzYWdlLCBkZXRhaWxzID0gbnVsbCwga2luZCA9ICdpbmZvJykge1xuICAgIGNvbnN0IHByZWZpeCA9ICdbTWVtY2hhdDpub3RpZmllcl0nO1xuICAgIGlmIChraW5kID09PSAnZXJyb3InKSBjb25zb2xlLmVycm9yKHByZWZpeCwgbWVzc2FnZSwgZGV0YWlscyB8fCAnJyk7XG4gICAgZWxzZSBpZiAoa2luZCA9PT0gJ3dhcm4nKSBjb25zb2xlLndhcm4ocHJlZml4LCBtZXNzYWdlLCBkZXRhaWxzIHx8ICcnKTtcbiAgICBlbHNlIGNvbnNvbGUuaW5mbyhwcmVmaXgsIG1lc3NhZ2UsIGRldGFpbHMgfHwgJycpO1xuICAgIGhhY2tlckxvZyhg8J+UjiAke21lc3NhZ2V9YCwga2luZCA9PT0gJ2Vycm9yJyA/ICdlcnInIDoga2luZCk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU2VsZWN0ZWRTdGF0dXNOYW1lcygpIHtcbiAgICByZXR1cm4gaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zdGF0dXNIcmVmc1xuICAgICAgICAubWFwKGhyZWYgPT4gaGFja2VyU3RhdGVzLmZpbmQoc3RhdGUgPT4gc3RhdGUuaHJlZiA9PT0gaHJlZik/Lm5hbWUpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmxldCBoYWNrZXJOb3RpZmllclBvbGxDb250cm9sbGVyID0gbnVsbDtcbmFzeW5jIGZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyRmV0Y2hPcmdhbml6YXRpb24ob3JnYW5pemF0aW9uSHJlZiwgc2lnbmFsKSB7XG4gICAgY29uc3Qgcm93cyA9IG5ldyBNYXAoKTtcbiAgICBsZXQgb2Zmc2V0ID0gMDtcbiAgICBjb25zdCBsaW1pdCA9IDEwMDtcbiAgICB3aGlsZSAoIXNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICAgIGNvbnN0IGZpbHRlciA9IGVuY29kZVVSSUNvbXBvbmVudCgnb3JnYW5pemF0aW9uPScgKyBvcmdhbml6YXRpb25IcmVmKTtcbiAgICAgICAgY29uc3QgcGF0aCA9IGAvZW50aXR5L2N1c3RvbWVyb3JkZXI/ZmlsdGVyPSR7ZmlsdGVyfSZleHBhbmQ9c3RhdGUsb3JnYW5pemF0aW9uJm9yZGVyPW1vbWVudCxkZXNjJmxpbWl0PSR7bGltaXR9Jm9mZnNldD0ke29mZnNldH1gO1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgbXNBcGlQKCdHRVQnLCBwYXRoLCBudWxsLCB7IHNpZ25hbCB9KTtcbiAgICAgICAgaWYgKHNpZ25hbC5hYm9ydGVkKSByZXR1cm4gW107XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkYXRhPy5yb3dzKSkgdGhyb3cgbmV3IEVycm9yKCfQndC10L/QvtC70L3Ri9C5INC+0YLQstC10YIg0YHQv9C40YHQutCwINC30LDQutCw0LfQvtCyJyk7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzU2l6ZSA9IHJvd3Muc2l6ZTtcbiAgICAgICAgZGF0YS5yb3dzLmZvckVhY2gob3JkZXIgPT4ge1xuICAgICAgICAgICAgY29uc3QgaWQgPSBvcmRlcj8uaWQgfHwgb3JkZXI/Lm1ldGE/LmhyZWY7XG4gICAgICAgICAgICBpZiAoaWQpIHJvd3Muc2V0KGlkLCBvcmRlcik7XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBuZXh0T2Zmc2V0ID0gb2Zmc2V0ICsgZGF0YS5yb3dzLmxlbmd0aDtcbiAgICAgICAgY29uc3QgaGFzTW9yZSA9ICEhZGF0YS5tZXRhPy5uZXh0SHJlZiB8fCAoTnVtYmVyLmlzRmluaXRlKGRhdGEubWV0YT8uc2l6ZSlcbiAgICAgICAgICAgID8gbmV4dE9mZnNldCA8IGRhdGEubWV0YS5zaXplIDogZGF0YS5yb3dzLmxlbmd0aCA+PSBsaW1pdCk7XG4gICAgICAgIGlmICghaGFzTW9yZSkgcmV0dXJuIFsuLi5yb3dzLnZhbHVlcygpXTtcbiAgICAgICAgaWYgKCFkYXRhLnJvd3MubGVuZ3RoIHx8IHJvd3Muc2l6ZSA9PT0gcHJldmlvdXNTaXplKSB0aHJvdyBuZXcgRXJyb3IoJ9Cf0LDQs9C40L3QsNGG0LjRjyDQt9Cw0LrQsNC30L7QsiDQvdC1INC/0YDQvtC00LLQuNCz0LDQtdGC0YHRjycpO1xuICAgICAgICBvZmZzZXQgPSBuZXh0T2Zmc2V0O1xuICAgIH1cbiAgICByZXR1cm4gW107XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyUG9sbCgpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyLnBvbGwoKTtcbiAgICBpZiAoaGFja2VyTm90aWZpZXJJbkZsaWdodCkge1xuICAgICAgICBoYWNrZXJOb3RpZmllclRyYWNlKCfQn9GA0L7QstC10YDQutCwINC/0YDQvtC/0YPRidC10L3QsDog0L/RgNC10LTRi9C00YPRidC40Lkg0LfQsNC/0YDQvtGBINC10YnRkSDQstGL0L/QvtC70L3Rj9C10YLRgdGPJywgbnVsbCwgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbXSk7XG4gICAgfVxuICAgIGlmICghaGFja2VyTm90aWZpZXJTZXR0aW5ncy5lbmFibGVkKSB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Cf0YDQvtCy0LXRgNC60LAg0L/RgNC+0L/Rg9GJ0LXQvdCwOiDQvtC/0L7QstC10YnQsNGC0LXQu9GMINCy0YvQutC70Y7Rh9C10L0nLCBudWxsLCAnd2FybicpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgICB9XG4gICAgaWYgKCFoYWNrZXJOb3RpZmllclNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCkge1xuICAgICAgICBoYWNrZXJOb3RpZmllclRyYWNlKCfQn9GA0L7QstC10YDQutCwINC/0YDQvtC/0YPRidC10L3QsDog0L7RgNCz0LDQvdC40LfQsNGG0LjRjyDQvdC1INCy0YvQsdGA0LDQvdCwJywgbnVsbCwgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbXSk7XG4gICAgfVxuICAgIGlmICghaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGgpIHtcbiAgICAgICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0J/RgNC+0LLQtdGA0LrQsCDQv9GA0L7Qv9GD0YnQtdC90LA6INGB0YLQsNGC0YPRgdGLINC00LvRjyDQvtC/0L7QstC10YnQtdC90LjRjyDQvdC1INCy0YvQsdGA0LDQvdGLJywgbnVsbCwgJ3dhcm4nKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbXSk7XG4gICAgfVxuICAgIGlmICghaGFja2VyQXBpVmFsaWRhdGVkKSB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Cf0YDQvtCy0LXRgNC60LAg0L/RgNC+0L/Rg9GJ0LXQvdCwOiBBUEkt0LrQu9GO0Ycg0LXRidGRINC90LUg0L/QvtC00YLQstC10YDQttC00ZHQvScsIG51bGwsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICAgIH1cbiAgICBoYWNrZXJOb3RpZmllckluRmxpZ2h0ID0gdHJ1ZTtcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgIGhhY2tlck5vdGlmaWVyUG9sbENvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xuICAgIGNvbnN0IG9yZ2FuaXphdGlvbkhyZWZzID0gWy4uLmhhY2tlck5vdGlmaWVyU2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnNdO1xuICAgIGNvbnN0IHN0YXR1c0hyZWZzID0gWy4uLmhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnNdO1xuICAgIGNvbnN0IHNlbGVjdGVkU3RhdHVzTmFtZXMgPSBoYWNrZXJOb3RpZmllclNlbGVjdGVkU3RhdHVzTmFtZXMoKTtcbiAgICBoYWNrZXJOb3RpZmllclRyYWNlKCfQl9Cw0L/RgNC+0YEg0LfQsNC60LDQt9C+0LInLCB7XG4gICAgICAgIG9yZ2FuaXphdGlvbnM6IG9yZ2FuaXphdGlvbkhyZWZzLmxlbmd0aCxcbiAgICAgICAgc3RhdHVzTmFtZXM6IHNlbGVjdGVkU3RhdHVzTmFtZXNcbiAgICB9KTtcbiAgICByZXR1cm4gKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoaW5nID0gbmV3IE1hcCgpO1xuICAgICAgICAgICAgY29uc3QgZmFpbGVkT3JnYW5pemF0aW9ucyA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCBvcmdhbml6YXRpb25IcmVmIG9mIG9yZ2FuaXphdGlvbkhyZWZzKSB7XG4gICAgICAgICAgICAgICAgbGV0IHJvd3M7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgcm93cyA9IGF3YWl0IGhhY2tlck5vdGlmaWVyRmV0Y2hPcmdhbml6YXRpb24ob3JnYW5pemF0aW9uSHJlZiwgY29udHJvbGxlci5zaWduYWwpO1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSByZXR1cm4gW107XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMuZmluZChpdGVtID0+IGl0ZW0uaHJlZiA9PT0gb3JnYW5pemF0aW9uSHJlZik/Lm5hbWUgfHwgJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0L3QtdC00L7RgdGC0YPQv9C90LAnO1xuICAgICAgICAgICAgICAgICAgICBmYWlsZWRPcmdhbml6YXRpb25zLnB1c2gobmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIGhhY2tlckxvZygn4pqgINCd0LUg0YPQtNCw0LvQvtGB0Ywg0L/RgNC+0LLQtdGA0LjRgtGMINC+0YDQs9Cw0L3QuNC30LDRhtC40Y4nLCAnd2FybicsIG5hbWUpO1xuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWROYW1lID0gaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zLmZpbmQoaXRlbSA9PiBpdGVtLmhyZWYgPT09IG9yZ2FuaXphdGlvbkhyZWYpPy5uYW1lO1xuICAgICAgICAgICAgICAgIGNvbnN0IGJ1Y2tldCA9IHsgaW5pdGlhbGl6ZWQ6IHRydWUsIG9yZGVyczoge30gfTtcbiAgICAgICAgICAgICAgICByb3dzLmZvckVhY2gob3JkZXIgPT4ge1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBpZCA9IG9yZGVyLmlkIHx8IG9yZGVyLm1ldGE/LmhyZWY7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YXRlSHJlZiA9IG9yZGVyLnN0YXRlPy5tZXRhPy5ocmVmIHx8ICcnO1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBzdGF0ZU5hbWUgPSBvcmRlci5zdGF0ZT8ubmFtZSB8fCAn0LHQtdC3INGB0YLQsNGC0YPRgdCwJztcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWF0Y2hlcyA9IHN0YXR1c0hyZWZzLmluY2x1ZGVzKHN0YXRlSHJlZikgfHwgc2VsZWN0ZWRTdGF0dXNOYW1lcy5zb21lKG5hbWUgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgIFN0cmluZyhuYW1lKS50cmltKCkudG9Mb3dlckNhc2UoKSA9PT0gU3RyaW5nKHN0YXRlTmFtZSkudHJpbSgpLnRvTG93ZXJDYXNlKCkpO1xuICAgICAgICAgICAgICAgICAgICBpZiAobWF0Y2hlcyAmJiAhbWF0Y2hpbmcuaGFzKGlkKSkgbWF0Y2hpbmcuc2V0KGlkLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZCwgbmFtZTogb3JkZXIubmFtZSB8fCBpZCwgc3RhdGVIcmVmLCBzdGF0ZU5hbWUsIG9yZ2FuaXphdGlvbkhyZWYsXG4gICAgICAgICAgICAgICAgICAgICAgICBvcmdhbml6YXRpb25OYW1lOiBjYWNoZWROYW1lIHx8IG9yZGVyLm9yZ2FuaXphdGlvbj8ubmFtZSB8fCAn0J7RgNCz0LDQvdC40LfQsNGG0LjRjyDQvdC10LTQvtGB0YLRg9C/0L3QsCdcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIGJ1Y2tldC5vcmRlcnNbaWRdID0geyBzdGF0ZUhyZWYsIHN0YXRlTmFtZSwgdXBkYXRlZEF0OiBEYXRlLm5vdygpIH07XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgYnVja2V0Lm9yZGVycyA9IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhidWNrZXQub3JkZXJzKS5zbGljZSgwLCA1MDApKTtcbiAgICAgICAgICAgICAgICBoYWNrZXJOb3RpZmllclNlZW5CeU9yZ2FuaXphdGlvbltvcmdhbml6YXRpb25IcmVmXSA9IGJ1Y2tldDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGhhY2tlck5vdGlmaWVyU2F2ZVNlZW4oKTtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoaW5nT3JkZXJzID0gWy4uLm1hdGNoaW5nLnZhbHVlcygpXTtcbiAgICAgICAgICAgIGNvbnN0IHBhcnRpYWwgPSBmYWlsZWRPcmdhbml6YXRpb25zLmxlbmd0aCA+IDA7XG4gICAgICAgICAgICBtYXRjaGluZ09yZGVycy5mb3JFYWNoKG9yZGVyID0+IHsgb3JkZXIucGFydGlhbCA9IHBhcnRpYWw7IH0pO1xuICAgICAgICAgICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0J7RgtCy0LXRgiDQv9C+0LvRg9GH0LXQvScsIHsgb3JnYW5pemF0aW9uczogb3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoLCBtYXRjaGluZ09yZGVyczogbWF0Y2hpbmdPcmRlcnMubGVuZ3RoIH0pO1xuICAgICAgICAgICAgaWYgKG1hdGNoaW5nT3JkZXJzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIG1hdGNoaW5nT3JkZXJzLmZvckVhY2gob3JkZXIgPT4ge1xuICAgICAgICAgICAgICAgICAgICBoYWNrZXJMb2coYPCflJQg0JfQsNC60LDQtyAke29yZGVyLm5hbWV9IOKAlCAke29yZGVyLnN0YXRlTmFtZX0ke3BhcnRpYWwgPyAnICjQvdC10L/QvtC70L3Ri9C5INC+0L/RgNC+0YEpJyA6ICcnfWAsIHBhcnRpYWwgPyAnd2FybicgOiAnb2snLCBvcmRlci5vcmdhbml6YXRpb25OYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaGFja2VyTm90aWZpZXJTaG93VG9hc3Qob3JkZXIpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGlmIChoYWNrZXJOb3RpZmllclNldHRpbmdzLnNvdW5kRW5hYmxlZCkgaGFja2VyTm90aWZpZXJQbGF5QWxhcm0oKTtcbiAgICAgICAgICAgICAgICBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhg8J+UlCDQl9Cw0LrQsNC30L7QsiDQsiDQstGL0LHRgNCw0L3QvdGL0YUg0YHRgtCw0YLRg9GB0LDRhTogJHttYXRjaGluZ09yZGVycy5sZW5ndGh9YCwgJ29rJyk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFwYXJ0aWFsKSB7XG4gICAgICAgICAgICAgICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0KHQvtCy0L/QsNC00LXQvdC40Lkg0L/QviDQstGL0LHRgNCw0L3QvdGL0Lwg0YHRgtCw0YLRg9GB0LDQvCDQvdC10YInLCB7XG4gICAgICAgICAgICAgICAgICAgIHNlbGVjdGVkU3RhdHVzTmFtZXMsXG4gICAgICAgICAgICAgICAgICAgIHNlbGVjdGVkU3RhdHVzSHJlZnM6IHN0YXR1c0hyZWZzXG4gICAgICAgICAgICAgICAgfSwgJ3dhcm4nKTtcbiAgICAgICAgICAgICAgICBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhg0J/RgNC+0LLQtdGA0LXQvdC+OiAke25ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9IOKAlCDRgdC+0LLQv9Cw0LTQtdC90LjQuSDQvdC10YJgLCAnaW5mbycpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHBhcnRpYWwpIGhhY2tlck5vdGlmaWVyU2V0U3RhdHVzKGDimqAg0J3QtdC/0L7Qu9C90YvQuSDQvtC/0YDQvtGBOiDQvdC1INC/0YDQvtCy0LXRgNC10L3RiyAke2ZhaWxlZE9yZ2FuaXphdGlvbnMuam9pbignLCAnKX0uINCd0LDQudC00LXQvdC+INC30LDQutCw0LfQvtCyOiAke21hdGNoaW5nT3JkZXJzLmxlbmd0aH1gLCAnZXJyb3InKTtcbiAgICAgICAgICAgIHJldHVybiBtYXRjaGluZ09yZGVycztcbiAgICAgICAgfSkoKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHJldHVybiBbXTtcbiAgICAgICAgICAgIGhhY2tlck5vdGlmaWVyVHJhY2UoJ9Ce0YjQuNCx0LrQsCDQt9Cw0L/RgNC+0YHQsCcsIHsgbWVzc2FnZTogZXJyb3I/Lm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKSwgZXJyb3IgfSwgJ2Vycm9yJyk7XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllclNldFN0YXR1cygn4pqg77iPINCe0YjQuNCx0LrQsCDQv9GA0L7QstC10YDQutC4OiAnICsgZXJyb3IubWVzc2FnZSwgJ2Vycm9yJyk7XG4gICAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgIH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICAgIGlmIChoYWNrZXJOb3RpZmllclBvbGxDb250cm9sbGVyID09PSBjb250cm9sbGVyKSBoYWNrZXJOb3RpZmllclBvbGxDb250cm9sbGVyID0gbnVsbDtcbiAgICAgICAgICAgIGhhY2tlck5vdGlmaWVySW5GbGlnaHQgPSBmYWxzZTtcbiAgICAgICAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU3RvcCgpIHtcbiAgICBpZiAobWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyKSByZXR1cm4gbWVtY2hhdFBsYXRmb3JtLm5vdGlmaWVyLnN0b3AoKTtcbiAgICBoYWNrZXJOb3RpZmllclBvbGxDb250cm9sbGVyPy5hYm9ydCgpO1xuICAgIGlmIChoYWNrZXJOb3RpZmllclRpbWVyKSBjbGVhckludGVydmFsKGhhY2tlck5vdGlmaWVyVGltZXIpO1xuICAgIGhhY2tlck5vdGlmaWVyVGltZXIgPSBudWxsO1xuICAgIGhhY2tlck5vdGlmaWVyRW5zdXJlSW5kaWNhdG9yKCk7XG59XG5cbmZ1bmN0aW9uIGhhY2tlck5vdGlmaWVyU3RhcnQoKSB7XG4gICAgaWYgKG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllcikgcmV0dXJuIG1lbWNoYXRQbGF0Zm9ybS5ub3RpZmllci5zdGFydCgpO1xuICAgIGhhY2tlck5vdGlmaWVyU3RvcCgpO1xuICAgIGlmICghaGFja2VyQXBpVmFsaWRhdGVkIHx8ICFoYWNrZXJOb3RpZmllclNldHRpbmdzLmVuYWJsZWQgfHwgIWhhY2tlck5vdGlmaWVyU2V0dGluZ3Mub3JnYW5pemF0aW9uSHJlZnMubGVuZ3RoKSByZXR1cm47XG4gICAgaGFja2VyTm90aWZpZXJUaW1lciA9IHNldEludGVydmFsKGhhY2tlck5vdGlmaWVyUG9sbCwgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5pbnRlcnZhbE1pbnV0ZXMgKiA2MCAqIDEwMDApO1xuICAgIGhhY2tlck5vdGlmaWVyRW5zdXJlSW5kaWNhdG9yKCk7XG4gICAgaGFja2VyTm90aWZpZXJUcmFjZSgn0KLQsNC50LzQtdGAINC30LDQv9GD0YnQtdC9Jywge1xuICAgICAgICBpbnRlcnZhbE1pbnV0ZXM6IGhhY2tlck5vdGlmaWVyU2V0dGluZ3MuaW50ZXJ2YWxNaW51dGVzLFxuICAgICAgICBvcmdhbml6YXRpb25IcmVmczogaGFja2VyTm90aWZpZXJTZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcyxcbiAgICAgICAgc3RhdHVzSHJlZnM6IGhhY2tlck5vdGlmaWVyU2V0dGluZ3Muc3RhdHVzSHJlZnMsXG4gICAgICAgIHN0YXR1c05hbWVzOiBoYWNrZXJOb3RpZmllclNlbGVjdGVkU3RhdHVzTmFtZXMoKVxuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllck1heWJlU3RhcnQoKSB7XG4gICAgaGFja2VyTm90aWZpZXJTZWxlY3REZWZhdWx0U3RhdHVzKCk7XG4gICAgaGFja2VyTm90aWZpZXJTdGFydCgpO1xufVxuXG5mdW5jdGlvbiBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scygpIHtcbiAgICBtZW1jaGF0UGxhdGZvcm0ubm90aWZpZXI/LmVkaXQoKTtcbiAgICBjb25zdCBlbmFibGVkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlck5vdGlmaWVyRW5hYmxlZCcpO1xuICAgIGNvbnN0IHNvdW5kRW5hYmxlZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllclNvdW5kRW5hYmxlZCcpO1xuICAgIGNvbnN0IG9yZ2FuaXphdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbicpO1xuICAgIGNvbnN0IHN0YXR1c2VzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlck5vdGlmaWVyU3RhdHVzZXMnKTtcbiAgICBjb25zdCBpbnRlcnZhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllckludGVydmFsJyk7XG4gICAgY29uc3QgdG9hc3REdXJhdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJOb3RpZmllclRvYXN0RHVyYXRpb24nKTtcbiAgICBoYWNrZXJOb3RpZmllclNldHRpbmdzID0gaGFja2VyTm90aWZpZXJOb3JtYWxpemVTZXR0aW5ncyh7XG4gICAgICAgIGVuYWJsZWQ6IGVuYWJsZWQ/LmNoZWNrZWQsXG4gICAgICAgIHNvdW5kRW5hYmxlZDogc291bmRFbmFibGVkID8gc291bmRFbmFibGVkLmNoZWNrZWQgOiBoYWNrZXJOb3RpZmllclNldHRpbmdzLnNvdW5kRW5hYmxlZCxcbiAgICAgICAgb3JnYW5pemF0aW9uSHJlZnM6IG9yZ2FuaXphdGlvbiA/IFsuLi5vcmdhbml6YXRpb24uc2VsZWN0ZWRPcHRpb25zXS5tYXAob3B0aW9uID0+IG9wdGlvbi52YWx1ZSkgOiBoYWNrZXJOb3RpZmllclNldHRpbmdzLm9yZ2FuaXphdGlvbkhyZWZzLFxuICAgICAgICBzdGF0dXNIcmVmczogc3RhdHVzZXMgPyBbLi4uc3RhdHVzZXMuc2VsZWN0ZWRPcHRpb25zXS5tYXAob3B0aW9uID0+IG9wdGlvbi52YWx1ZSkgOiBoYWNrZXJOb3RpZmllclNldHRpbmdzLnN0YXR1c0hyZWZzLFxuICAgICAgICBpbnRlcnZhbE1pbnV0ZXM6IGludGVydmFsPy52YWx1ZSxcbiAgICAgICAgdG9hc3REdXJhdGlvbk1pbnV0ZXM6IHRvYXN0RHVyYXRpb24/LnZhbHVlXG4gICAgfSk7XG4gICAgaGFja2VyTm90aWZpZXJTdGF0dXNTZWxlY3Rpb25Jbml0aWFsaXplZCA9IHRydWU7XG4gICAgaGFja2VyTm90aWZpZXJTYXZlU2V0dGluZ3MoKTtcbiAgICBoYWNrZXJOb3RpZmllck1heWJlU3RhcnQoKTtcbn1cblxuZnVuY3Rpb24gaGFja2VyQnVpbGROb3RpZmllclRhYigpIHtcbiAgICBjb25zdCB3cmFwID0gaGFja2VyRWwoJ2RpdicpO1xuICAgIHdyYXAuaWQgPSAnaGFja2VyVGFiTm90aWZpZXInO1xuXG4gICAgd3JhcC5hcHBlbmRDaGlsZChoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM2NDc0OGI7bGluZS1oZWlnaHQ6MS40O21hcmdpbi1ib3R0b206N3B4OycsXG4gICAgICAgICfQn9GA0L7QstC10YDRj9C10YIg0LfQsNC60LDQt9GLINCy0YvQsdGA0LDQvdC90YvRhSDQvtGA0LPQsNC90LjQt9Cw0YbQuNC5INC/0L4g0YLQsNC50LzQtdGA0YMg0Lgg0L/QvtC00LDRkdGCINC+0LTQuNC9INC+0LHRidC40Lkg0YHQuNCz0L3QsNC7INC90LAg0LrQsNC20LTQvtC8INC+0L/RgNC+0YHQtSwg0L/QvtC60LAg0LfQsNC60LDQtyDQvdCw0YXQvtC00LjRgtGB0Y8g0LIg0LLRi9Cx0YDQsNC90L3QvtC8INGB0YLQsNGC0YPRgdC1LicpKTtcblxuICAgIGNvbnN0IGVuYWJsZWRMYWJlbCA9IGhhY2tlckVsKCdsYWJlbCcsICdkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHg7Zm9udC1zaXplOjExLjVweDtjb2xvcjojNDc1NTY5O21hcmdpbi1ib3R0b206N3B4O2N1cnNvcjpwb2ludGVyOycpO1xuICAgIGNvbnN0IGVuYWJsZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgIGVuYWJsZWQudHlwZSA9ICdjaGVja2JveCc7XG4gICAgZW5hYmxlZC5pZCA9ICdoYWNrZXJOb3RpZmllckVuYWJsZWQnO1xuICAgIGVuYWJsZWQuc3R5bGUuYWNjZW50Q29sb3IgPSAnIzYzNjZmMSc7XG4gICAgZW5hYmxlZExhYmVsLmFwcGVuZENoaWxkKGVuYWJsZWQpO1xuICAgIGVuYWJsZWRMYWJlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSgn0JLQutC70Y7Rh9C40YLRjCDQvtC/0L7QstC10YnQsNGC0LXQu9GMJykpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoZW5hYmxlZExhYmVsKTtcblxuICAgIGNvbnN0IHNvdW5kTGFiZWwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4O2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6IzQ3NTU2OTttYXJnaW4tYm90dG9tOjdweDtjdXJzb3I6cG9pbnRlcjsnKTtcbiAgICBjb25zdCBzb3VuZEVuYWJsZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xuICAgIHNvdW5kRW5hYmxlZC50eXBlID0gJ2NoZWNrYm94JztcbiAgICBzb3VuZEVuYWJsZWQuaWQgPSAnaGFja2VyTm90aWZpZXJTb3VuZEVuYWJsZWQnO1xuICAgIHNvdW5kRW5hYmxlZC5zdHlsZS5hY2NlbnRDb2xvciA9ICcjZGMyNjI2JztcbiAgICBzb3VuZExhYmVsLmFwcGVuZENoaWxkKHNvdW5kRW5hYmxlZCk7XG4gICAgc291bmRMYWJlbC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSgn8J+UiiDQl9Cy0YPQutC+0LLQvtC5INGB0LjQs9C90LDQuycpKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHNvdW5kTGFiZWwpO1xuXG4gICAgY29uc3Qgb3JnTGFiZWwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpibG9jaztmb250LXNpemU6MTEuNXB4O2NvbG9yOiM0NzU1Njk7bWFyZ2luLWJvdHRvbTozcHg7JywgJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40LggKEN0cmwv4oyYIOKAlCDQvdC10YHQutC+0LvRjNC60L4pOicpO1xuICAgIG9yZ0xhYmVsLmh0bWxGb3IgPSAnaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb24nO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQob3JnTGFiZWwpO1xuICAgIGNvbnN0IG9yZ1JvdyA9IGhhY2tlckVsKCdkaXYnLCAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7Z2FwOjRweDttYXJnaW4tYm90dG9tOjZweDsnKTtcbiAgICBjb25zdCBvcmdhbml6YXRpb24gPSBoYWNrZXJTZWxlY3QoJ2hhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9uJywgJ+KAlCDQstGL0LHQtdGA0LjRgtC1INC+0YDQs9Cw0L3QuNC30LDRhtC40Y4g4oCUJyk7XG4gICAgb3JnYW5pemF0aW9uLm11bHRpcGxlID0gdHJ1ZTtcbiAgICBvcmdhbml6YXRpb24uc2l6ZSA9IDQ7XG4gICAgb3JnYW5pemF0aW9uLnRpdGxlID0gJ0N0cmwv4oyYICsg0LrQu9C40Log4oCUINC00L7QsdCw0LLQuNGC0Ywg0LjQu9C4INGB0L3Rj9GC0Ywg0LLRi9Cx0L7RgDsg0L/Rg9GB0YLQvtC5INCy0YvQsdC+0YAg0L7RgdGC0LDQvdCw0LLQu9C40LLQsNC10YIg0L7Qv9GA0L7RgSc7XG4gICAgb3JnYW5pemF0aW9uLnN0eWxlLmNzc1RleHQgPSBIQUNLRVJfU0VMRUNUX0NTUztcbiAgICBvcmdSb3cuYXBwZW5kQ2hpbGQob3JnYW5pemF0aW9uKTtcbiAgICBjb25zdCByZWZyZXNoT3JnID0gaGFja2VyQnRuKCdoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnNSZWZyZXNoJywgJ+KfsycsIEhBQ0tFUl9NSU5JX0JUTl9DU1MpO1xuICAgIHJlZnJlc2hPcmcudGl0bGUgPSAn0J7QsdC90L7QstC40YLRjCDRgdC/0LjRgdC+0Log0L7RgNCz0LDQvdC40LfQsNGG0LjQuSc7XG4gICAgb3JnUm93LmFwcGVuZENoaWxkKHJlZnJlc2hPcmcpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQob3JnUm93KTtcblxuICAgIGNvbnN0IHN0YXR1c2VzTGFiZWwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpibG9jaztmb250LXNpemU6MTEuNXB4O2NvbG9yOiM0NzU1Njk7bWFyZ2luLWJvdHRvbTo2cHg7JywgJ9Ch0YLQsNGC0YPRgdGLINC00LvRjyDQvtC/0L7QstC10YnQtdC90LjRjzonKTtcbiAgICBjb25zdCBzdGF0dXNlcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xuICAgIHN0YXR1c2VzLmlkID0gJ2hhY2tlck5vdGlmaWVyU3RhdHVzZXMnO1xuICAgIHN0YXR1c2VzLm11bHRpcGxlID0gdHJ1ZTtcbiAgICBzdGF0dXNlcy5zaXplID0gNDtcbiAgICBzdGF0dXNlcy5zdHlsZS5jc3NUZXh0ID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTttYXJnaW4tdG9wOjNweDtwYWRkaW5nOjRweCA2cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4Oyc7XG4gICAgc3RhdHVzZXNMYWJlbC5hcHBlbmRDaGlsZChzdGF0dXNlcyk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChzdGF0dXNlc0xhYmVsKTtcblxuICAgIGNvbnN0IGludGVydmFsTGFiZWwgPSBoYWNrZXJFbCgnbGFiZWwnLCAnZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NXB4O2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6IzQ3NTU2OTttYXJnaW46NXB4IDAgN3B4OycsICfQmNC90YLQtdGA0LLQsNC7LCDQvNC40L3Rg9GCOicpO1xuICAgIGNvbnN0IGludGVydmFsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcbiAgICBpbnRlcnZhbC5pZCA9ICdoYWNrZXJOb3RpZmllckludGVydmFsJztcbiAgICBpbnRlcnZhbC50eXBlID0gJ251bWJlcic7XG4gICAgaW50ZXJ2YWwubWluID0gJzEnO1xuICAgIGludGVydmFsLm1heCA9ICcxNDQwJztcbiAgICBpbnRlcnZhbC5zdGVwID0gJzEnO1xuICAgIGludGVydmFsLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6NzBweDtwYWRkaW5nOjRweCA2cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4Oyc7XG4gICAgaW50ZXJ2YWxMYWJlbC5hcHBlbmRDaGlsZChpbnRlcnZhbCk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChpbnRlcnZhbExhYmVsKTtcblxuICAgIGNvbnN0IHRvYXN0RHVyYXRpb25MYWJlbCA9IGhhY2tlckVsKCdsYWJlbCcsICdkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo1cHg7Zm9udC1zaXplOjExLjVweDtjb2xvcjojNDc1NTY5O21hcmdpbjo1cHggMCA3cHg7JywgJ9Cf0L7QutCw0LfRi9Cy0LDRgtGMINGD0LLQtdC00L7QvNC70LXQvdC40LUsINC80LjQvdGD0YI6Jyk7XG4gICAgY29uc3QgdG9hc3REdXJhdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XG4gICAgdG9hc3REdXJhdGlvbi5pZCA9ICdoYWNrZXJOb3RpZmllclRvYXN0RHVyYXRpb24nO1xuICAgIHRvYXN0RHVyYXRpb24udHlwZSA9ICdudW1iZXInO1xuICAgIHRvYXN0RHVyYXRpb24ubWluID0gJzAnO1xuICAgIHRvYXN0RHVyYXRpb24ubWF4ID0gJzE0NDAnO1xuICAgIHRvYXN0RHVyYXRpb24uc3RlcCA9ICcxJztcbiAgICB0b2FzdER1cmF0aW9uLnRpdGxlID0gJzAg4oCUINC/0L7QutCw0LfRi9Cy0LDRgtGMINC00L4g0L3QsNC20LDRgtC40Y8gwqvQo9C00LDQu9C40YLRjMK7JztcbiAgICB0b2FzdER1cmF0aW9uLnN0eWxlLmNzc1RleHQgPSAnd2lkdGg6NzBweDtwYWRkaW5nOjRweCA2cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4Oyc7XG4gICAgdG9hc3REdXJhdGlvbkxhYmVsLmFwcGVuZENoaWxkKHRvYXN0RHVyYXRpb24pO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQodG9hc3REdXJhdGlvbkxhYmVsKTtcblxuICAgIGNvbnN0IGJ1dHRvbnMgPSBoYWNrZXJFbCgnZGl2JywgJ2Rpc3BsYXk6ZmxleDtnYXA6NHB4O2ZsZXgtd3JhcDp3cmFwOycpO1xuICAgIGNvbnN0IHNhdmUgPSBoYWNrZXJCdG4oJ2hhY2tlck5vdGlmaWVyU2F2ZScsICfwn5K+INCh0L7RhdGA0LDQvdC40YLRjCDQuCDQt9Cw0L/Rg9GB0YLQuNGC0YwnLCBIQUNLRVJfQlROX0NTUyArICdiYWNrZ3JvdW5kOiM0ZjQ2ZTU7Jyk7XG4gICAgY29uc3QgcG9sbCA9IGhhY2tlckJ0bignaGFja2VyTm90aWZpZXJQb2xsTm93JywgJ+KfsyDQn9GA0L7QstC10YDQuNGC0Ywg0YHQtdC50YfQsNGBJywgSEFDS0VSX01JTklfQlROX0NTUyk7XG4gICAgY29uc3Qgc291bmQgPSBoYWNrZXJCdG4oJ2hhY2tlck5vdGlmaWVyVGVzdFNvdW5kJywgJ/CflIog0KLQtdGB0YIg0YHQuNCz0L3QsNC70LAnLCBIQUNLRVJfTUlOSV9CVE5fQ1NTKTtcbiAgICBidXR0b25zLmFwcGVuZChzYXZlLCBwb2xsLCBzb3VuZCk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChidXR0b25zKTtcbiAgICBjb25zdCBzdGF0dXMgPSBoYWNrZXJFbCgnZGl2JywgJ21pbi1oZWlnaHQ6MTZweDttYXJnaW4tdG9wOjZweDtmb250LXNpemU6MTAuNXB4OycsICcnKTtcbiAgICBzdGF0dXMuaWQgPSAnaGFja2VyTm90aWZpZXJTdGF0dXMnO1xuICAgIGlmIChtZW1jaGF0UGxhdGZvcm0ubm90aWZpZXIpIHN0YXR1cy50ZXh0Q29udGVudCA9IGhhY2tlck5vdGlmaWVyU2V0dGluZ3MuZW5hYmxlZCA/ICfQntC/0YDQvtGBINCyINGE0L7QvdC1INGA0LDRgdGI0LjRgNC10L3QuNGPIMK3INC10LTQuNC90YvQuSDQtNC70Y8g0LLRgdC10YUg0LLQutC70LDQtNC+0LonIDogJ9Ce0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLRi9C60LvRjtGH0LXQvSc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChzdGF0dXMpO1xuXG4gICAgaGFja2VyTm90aWZpZXJGaWxsQ29udHJvbHMod3JhcCk7XG4gICAgZW5hYmxlZC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgc291bmRFbmFibGVkLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKTtcbiAgICBvcmdhbml6YXRpb24uYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaGFja2VyTm90aWZpZXJSZWFkQ29udHJvbHMpO1xuICAgIHN0YXR1c2VzLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKTtcbiAgICBpbnRlcnZhbC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKTtcbiAgICBpbnRlcnZhbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scyk7XG4gICAgdG9hc3REdXJhdGlvbi5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKTtcbiAgICB0b2FzdER1cmF0aW9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGhhY2tlck5vdGlmaWVyUmVhZENvbnRyb2xzKTtcbiAgICBzYXZlLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4geyBoYWNrZXJOb3RpZmllclJlYWRDb250cm9scygpOyBoYWNrZXJOb3RpZmllclBvbGwoKTsgfSk7XG4gICAgcG9sbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgaGFja2VyTm90aWZpZXJSZWFkQ29udHJvbHMoKTsgaGFja2VyTm90aWZpZXJQb2xsKCk7IH0pO1xuICAgIHNvdW5kLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaGFja2VyTm90aWZpZXJQbGF5QWxhcm0pO1xuICAgIHJlZnJlc2hPcmcuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyUmVmcmVzaE9yZ2FuaXphdGlvbnMoZmFsc2UpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9KTtcblxuICAgIGhhY2tlck5vdGlmaWVyU2VsZWN0RGVmYXVsdFN0YXR1cygpO1xuICAgIGhhY2tlck5vdGlmaWVyRmlsbENvbnRyb2xzKHdyYXApO1xuICAgIHJldHVybiB3cmFwO1xufVxuIiwiLy8g4pSA4pSA4pSAINCf0YDQvtCy0LXRgNC60LAg0YLQvtCy0LDRgNC+0LIg0LIg0LfQsNC60LDQt9Cw0YUg0Lgg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9Cw0YUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyDQodGA0LDQstC90LjQstCw0LXRgiDQsNCz0YDQtdCz0LjRgNC+0LLQsNC90L3Ri9C1INC/0L7Qt9C40YbQuNC4INC30LDQutCw0LfQvtCyINC/0L7QutGD0L/QsNGC0LXQu9C10Lkg0Lgg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LIuXG5jb25zdCBJTlRFUk5BTF9PUkRFUl9DSEVDS19TVE9SQUdFX0tFWSA9ICdoYWNrZXJJbnRlcm5hbE9yZGVyQ2hlY2tfdjEnO1xuY29uc3QgSU5URVJOQUxfT1JERVJfQ0hFQ0tfREVGQVVMVF9TVEFUVVMgPSAn0J3QvtCy0YvQuSc7XG5jb25zdCBJTlRFUk5BTF9PUkRFUl9DSEVDS19FTlRJVElFUyA9IHtcbiAgICBjdXN0b21lcm9yZGVyOiB7XG4gICAgICAgIGxhYmVsOiAn0JfQsNC60LDQt9GLINC/0L7QutGD0L/QsNGC0LXQu9C10LknLFxuICAgICAgICBvcmdhbml6YXRpb25LZXk6ICdjdXN0b21lck9yZ2FuaXphdGlvbkhyZWYnLFxuICAgICAgICBzdGF0dXNLZXk6ICdjdXN0b21lclN0YXR1c0hyZWZzJ1xuICAgIH0sXG4gICAgaW50ZXJuYWxvcmRlcjoge1xuICAgICAgICBsYWJlbDogJ9CS0L3Rg9GC0YDQtdC90L3QuNC1INC30LDQutCw0LfRiycsXG4gICAgICAgIG9yZ2FuaXphdGlvbktleTogJ2ludGVybmFsT3JnYW5pemF0aW9uSHJlZicsXG4gICAgICAgIHN0YXR1c0tleTogJ2ludGVybmFsU3RhdHVzSHJlZnMnXG4gICAgfVxufTtcbmxldCBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncyA9IHtcbiAgICBjdXN0b21lck9yZ2FuaXphdGlvbkhyZWY6ICcnLFxuICAgIGludGVybmFsT3JnYW5pemF0aW9uSHJlZjogJycsXG4gICAgY3VzdG9tZXJXYXJlaG91c2VIcmVmOiAnJyxcbiAgICBpbnRlcm5hbFdhcmVob3VzZUhyZWY6ICcnLFxuICAgIGN1c3RvbWVyU3RhdHVzSHJlZnM6IFtdLFxuICAgIGludGVybmFsU3RhdHVzSHJlZnM6IFtdXG59O1xubGV0IGludGVybmFsT3JkZXJDaGVja1N0YXR1c2VzID0ge1xuICAgIGN1c3RvbWVyb3JkZXI6IFtdLFxuICAgIGludGVybmFsb3JkZXI6IFtdXG59O1xubGV0IGludGVybmFsT3JkZXJDaGVja1dhcmVob3VzZXMgPSBbXTtcblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrTm9ybWFsaXplU2V0dGluZ3MocmF3KSB7XG4gICAgY29uc3QgbGlzdCA9IHZhbHVlID0+IEFycmF5LmlzQXJyYXkodmFsdWUpXG4gICAgICAgID8gWy4uLm5ldyBTZXQodmFsdWUuZmlsdGVyKGl0ZW0gPT4gdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnICYmIGl0ZW0pKV1cbiAgICAgICAgOiBbXTtcbiAgICByZXR1cm4ge1xuICAgICAgICBjdXN0b21lck9yZ2FuaXphdGlvbkhyZWY6IHR5cGVvZiByYXc/LmN1c3RvbWVyT3JnYW5pemF0aW9uSHJlZiA9PT0gJ3N0cmluZycgPyByYXcuY3VzdG9tZXJPcmdhbml6YXRpb25IcmVmIDogJycsXG4gICAgICAgIGludGVybmFsT3JnYW5pemF0aW9uSHJlZjogdHlwZW9mIHJhdz8uaW50ZXJuYWxPcmdhbml6YXRpb25IcmVmID09PSAnc3RyaW5nJyA/IHJhdy5pbnRlcm5hbE9yZ2FuaXphdGlvbkhyZWYgOiAnJyxcbiAgICAgICAgY3VzdG9tZXJXYXJlaG91c2VIcmVmOiB0eXBlb2YgcmF3Py5jdXN0b21lcldhcmVob3VzZUhyZWYgPT09ICdzdHJpbmcnID8gcmF3LmN1c3RvbWVyV2FyZWhvdXNlSHJlZiA6ICcnLFxuICAgICAgICBpbnRlcm5hbFdhcmVob3VzZUhyZWY6IHR5cGVvZiByYXc/LmludGVybmFsV2FyZWhvdXNlSHJlZiA9PT0gJ3N0cmluZycgPyByYXcuaW50ZXJuYWxXYXJlaG91c2VIcmVmIDogJycsXG4gICAgICAgIGN1c3RvbWVyU3RhdHVzSHJlZnM6IGxpc3QocmF3Py5jdXN0b21lclN0YXR1c0hyZWZzKSxcbiAgICAgICAgaW50ZXJuYWxTdGF0dXNIcmVmczogbGlzdChyYXc/LmludGVybmFsU3RhdHVzSHJlZnMpXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrTG9hZFNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJhdyA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oc3RvcmFnZUtleShJTlRFUk5BTF9PUkRFUl9DSEVDS19TVE9SQUdFX0tFWSkpIHx8ICd7fScpO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncyA9IGludGVybmFsT3JkZXJDaGVja05vcm1hbGl6ZVNldHRpbmdzKChyYXcucmVmZXJlbmNlU2NvcGUgfHwgJycpID09PSBtc1JlZmVyZW5jZVNjb3BlID8gcmF3IDoge30pO1xuICAgICAgICBjb25zdCB3YXJlaG91c2VzID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MScpKSB8fCAnW10nKTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrV2FyZWhvdXNlcyA9IG1zUmVmZXJlbmNlU2NvcGUgPyAobXNSZWZlcmVuY2VDYWNoZS5saXN0cy5zdG9yZSB8fCBbXSkgOiBBcnJheS5pc0FycmF5KHdhcmVob3VzZXMpXG4gICAgICAgICAgICA/IHdhcmVob3VzZXMuZmlsdGVyKGl0ZW0gPT4gaXRlbSAmJiB0eXBlb2YgaXRlbS5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgaXRlbS5ocmVmID09PSAnc3RyaW5nJylcbiAgICAgICAgICAgIDogW107XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MgPSBpbnRlcm5hbE9yZGVyQ2hlY2tOb3JtYWxpemVTZXR0aW5ncyh7fSk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKCfQndC1INGD0LTQsNC70L7RgdGMINC30LDQs9GA0YPQt9C40YLRjCDQvdCw0YHRgtGA0L7QudC60Lgg0YHRgNCw0LLQvdC10L3QuNGPJywgZXJyb3IsICdlcnInKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1NhdmVTZXR0aW5ncygpIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KElOVEVSTkFMX09SREVSX0NIRUNLX1NUT1JBR0VfS0VZKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgLi4uaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MsIC4uLihtc1JlZmVyZW5jZVNjb3BlID8geyByZWZlcmVuY2VTY29wZTogbXNSZWZlcmVuY2VTY29wZSB9IDoge30pXG4gICAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZSgn0J3QtSDRg9C00LDQu9C+0YHRjCDRgdC+0YXRgNCw0L3QuNGC0Ywg0L3QsNGB0YLRgNC+0LnQutC4INGB0YDQsNCy0L3QtdC90LjRjycsIGVycm9yLCAnZXJyJyk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tTYXZlV2FyZWhvdXNlcygpIHtcbiAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShzdG9yYWdlS2V5KCdoYWNrZXJJbnRlcm5hbE9yZGVyV2FyZWhvdXNlc192MScpLCBKU09OLnN0cmluZ2lmeShpbnRlcm5hbE9yZGVyQ2hlY2tXYXJlaG91c2VzKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0YHQvtGF0YDQsNC90LjRgtGMINGB0L/QuNGB0L7QuiDRgdC60LvQsNC00L7QsicsIGVycm9yLCAnZXJyJyk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShtZXNzYWdlLCBkZXRhaWxzID0gbnVsbCwga2luZCA9ICdpbmZvJykge1xuICAgIGNvbnN0IHByZWZpeCA9ICdbTWVtY2hhdDppbnRlcm5hbC1vcmRlcnNdJztcbiAgICBpZiAoa2luZCA9PT0gJ2VycicpIGNvbnNvbGUuZXJyb3IocHJlZml4LCBtZXNzYWdlLCBkZXRhaWxzIHx8ICcnKTtcbiAgICBlbHNlIGlmIChraW5kID09PSAnd2FybicpIGNvbnNvbGUud2FybihwcmVmaXgsIG1lc3NhZ2UsIGRldGFpbHMgfHwgJycpO1xuICAgIGVsc2UgY29uc29sZS5pbmZvKHByZWZpeCwgbWVzc2FnZSwgZGV0YWlscyB8fCAnJyk7XG4gICAgaWYgKHR5cGVvZiBoYWNrZXJMb2cgPT09ICdmdW5jdGlvbicpIGhhY2tlckxvZyhg8J+TpiAke21lc3NhZ2V9YCwga2luZCA9PT0gJ2VycicgPyAnZXJyJyA6IGtpbmQpO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlc0Zyb21NZXRhZGF0YShkYXRhKSB7XG4gICAgY29uc3Qgc3RhdGVzID0gQXJyYXkuaXNBcnJheShkYXRhPy5zdGF0ZXMpID8gZGF0YS5zdGF0ZXMgOiAoQXJyYXkuaXNBcnJheShkYXRhPy5zdGF0ZXM/LnJvd3MpID8gZGF0YS5zdGF0ZXMucm93cyA6IFtdKTtcbiAgICByZXR1cm4gc3RhdGVzLm1hcChzdGF0ZSA9PiAoe1xuICAgICAgICBuYW1lOiBzdGF0ZS5uYW1lLFxuICAgICAgICBocmVmOiBzdGF0ZS5tZXRhPy5ocmVmXG4gICAgfSkpLmZpbHRlcihzdGF0ZSA9PiBzdGF0ZS5uYW1lICYmIHN0YXRlLmhyZWYpO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tBZGRTYXZlZE9wdGlvbihzZWxlY3QsIHZhbHVlLCBsYWJlbCkge1xuICAgIGlmICghdmFsdWUgfHwgWy4uLnNlbGVjdC5vcHRpb25zXS5zb21lKG9wdGlvbiA9PiBvcHRpb24udmFsdWUgPT09IHZhbHVlKSkgcmV0dXJuO1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xuICAgIG9wdGlvbi52YWx1ZSA9IHZhbHVlO1xuICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGDimqAg0KHQvtGF0YDQsNC90ZHQvdC9JHtsYWJlbH0g4oCUINC+0YLRgdGD0YLRgdGC0LLRg9C10YIg0LIg0YHQv9GA0LDQstC+0YfQvdC40LrQtWA7XG4gICAgb3B0aW9uLmRhdGFzZXQuc2F2ZWRTZWxlY3Rpb24gPSAndHJ1ZSc7XG4gICAgb3B0aW9uLnNlbGVjdGVkID0gdHJ1ZTtcbiAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrRmlsbE9yZ2FuaXphdGlvbnMocm9vdCA9IGRvY3VtZW50KSB7XG4gICAgW1xuICAgICAgICBbJ2hhY2tlckludGVybmFsQ3VzdG9tZXJPcmdhbml6YXRpb24nLCAnY3VzdG9tZXJPcmdhbml6YXRpb25IcmVmJ10sXG4gICAgICAgIFsnaGFja2VySW50ZXJuYWxPcmRlck9yZ2FuaXphdGlvbicsICdpbnRlcm5hbE9yZ2FuaXphdGlvbkhyZWYnXVxuICAgIF0uZm9yRWFjaCgoW2lkLCBrZXldKSA9PiB7XG4gICAgICAgIGNvbnN0IHNlbGVjdCA9IHJvb3QucXVlcnlTZWxlY3RvcignIycgKyBpZCk7XG4gICAgICAgIGlmICghc2VsZWN0KSByZXR1cm47XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3Nba2V5XTtcbiAgICAgICAgY29uc3Qgb3JnYW5pemF0aW9ucyA9IEFycmF5LmlzQXJyYXkoaGFja2VyTm90aWZpZXJPcmdhbml6YXRpb25zKSA/IGhhY2tlck5vdGlmaWVyT3JnYW5pemF0aW9ucyA6IFtdO1xuICAgICAgICBzZWxlY3QuaW5uZXJIVE1MID0gJyc7XG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgIGVtcHR5LnZhbHVlID0gJyc7XG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gb3JnYW5pemF0aW9ucy5sZW5ndGhcbiAgICAgICAgICAgID8gJ+KAlCDQstGL0LHQtdGA0LjRgtC1INC+0YDQs9Cw0L3QuNC30LDRhtC40Y4g4oCUJ1xuICAgICAgICAgICAgOiAn4oCUINC90LDQttC80LjRgtC1IMKr0JfQsNCz0YDRg9C30LjRgtGMINGB0L/RgNCw0LLQvtGH0L3QuNC60LjCuyDigJQnO1xuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xuICAgICAgICBvcmdhbml6YXRpb25zLmZvckVhY2goaXRlbSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IGl0ZW0uaHJlZjtcbiAgICAgICAgICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGl0ZW0ubmFtZTtcbiAgICAgICAgICAgIG9wdGlvbi5zZWxlY3RlZCA9IGl0ZW0uaHJlZiA9PT0gc2VsZWN0ZWQ7XG4gICAgICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja0FkZFNhdmVkT3B0aW9uKHNlbGVjdCwgc2VsZWN0ZWQsICfQsNGPINC+0YDQs9Cw0L3QuNC30LDRhtC40Y8nKTtcbiAgICAgICAgc2VsZWN0LnZhbHVlID0gc2VsZWN0ZWQ7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0ZpbGxXYXJlaG91c2VzKHJvb3QgPSBkb2N1bWVudCkge1xuICAgIFtcbiAgICAgICAgWydoYWNrZXJJbnRlcm5hbEN1c3RvbWVyV2FyZWhvdXNlJywgJ2N1c3RvbWVyV2FyZWhvdXNlSHJlZiddLFxuICAgICAgICBbJ2hhY2tlckludGVybmFsT3JkZXJXYXJlaG91c2UnLCAnaW50ZXJuYWxXYXJlaG91c2VIcmVmJ11cbiAgICBdLmZvckVhY2goKFtpZCwga2V5XSkgPT4ge1xuICAgICAgICBjb25zdCBzZWxlY3QgPSByb290LnF1ZXJ5U2VsZWN0b3IoJyMnICsgaWQpO1xuICAgICAgICBpZiAoIXNlbGVjdCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzW2tleV07XG4gICAgICAgIGNvbnN0IHdhcmVob3VzZXMgPSBBcnJheS5pc0FycmF5KGludGVybmFsT3JkZXJDaGVja1dhcmVob3VzZXMpID8gaW50ZXJuYWxPcmRlckNoZWNrV2FyZWhvdXNlcyA6IFtdO1xuICAgICAgICBzZWxlY3QuaW5uZXJIVE1MID0gJyc7XG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XG4gICAgICAgIGVtcHR5LnZhbHVlID0gJyc7XG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gd2FyZWhvdXNlcy5sZW5ndGhcbiAgICAgICAgICAgID8gJ+KAlCDQstGL0LHQtdGA0LjRgtC1INGB0LrQu9Cw0LQg4oCUJ1xuICAgICAgICAgICAgOiAn4oCUINC90LDQttC80LjRgtC1IMKr0JfQsNCz0YDRg9C30LjRgtGMINGB0L/RgNCw0LLQvtGH0L3QuNC60LjCuyDigJQnO1xuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xuICAgICAgICB3YXJlaG91c2VzLmZvckVhY2goaXRlbSA9PiB7XG4gICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IGl0ZW0uaHJlZjtcbiAgICAgICAgICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IGl0ZW0ubmFtZTtcbiAgICAgICAgICAgIG9wdGlvbi5zZWxlY3RlZCA9IGl0ZW0uaHJlZiA9PT0gc2VsZWN0ZWQ7XG4gICAgICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja0FkZFNhdmVkT3B0aW9uKHNlbGVjdCwgc2VsZWN0ZWQsICfRi9C5INGB0LrQu9Cw0LQnKTtcbiAgICAgICAgc2VsZWN0LnZhbHVlID0gc2VsZWN0ZWQ7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0ZpbGxTdGF0dXNlcyhlbnRpdHksIHJvb3QgPSBkb2N1bWVudCkge1xuICAgIGNvbnN0IGNvbmZpZyA9IElOVEVSTkFMX09SREVSX0NIRUNLX0VOVElUSUVTW2VudGl0eV07XG4gICAgY29uc3Qgc2VsZWN0ID0gcm9vdC5xdWVyeVNlbGVjdG9yKGVudGl0eSA9PT0gJ2N1c3RvbWVyb3JkZXInXG4gICAgICAgID8gJyNoYWNrZXJJbnRlcm5hbEN1c3RvbWVyU3RhdHVzZXMnXG4gICAgICAgIDogJyNoYWNrZXJJbnRlcm5hbE9yZGVyU3RhdHVzZXMnKTtcbiAgICBpZiAoIWNvbmZpZyB8fCAhc2VsZWN0KSByZXR1cm47XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5nc1tjb25maWcuc3RhdHVzS2V5XTtcbiAgICBzZWxlY3QuaW5uZXJIVE1MID0gJyc7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzZXNbZW50aXR5XS5mb3JFYWNoKGl0ZW0gPT4ge1xuICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgb3B0aW9uLnZhbHVlID0gaXRlbS5ocmVmO1xuICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSBpdGVtLm5hbWU7XG4gICAgICAgIG9wdGlvbi5zZWxlY3RlZCA9IHNlbGVjdGVkLmluY2x1ZGVzKGl0ZW0uaHJlZik7XG4gICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24pO1xuICAgIH0pO1xuICAgIHNlbGVjdGVkLmZvckVhY2goaHJlZiA9PiBpbnRlcm5hbE9yZGVyQ2hlY2tBZGRTYXZlZE9wdGlvbihzZWxlY3QsIGhyZWYsICfRi9C5INGB0YLQsNGC0YPRgScpKTtcbiAgICBpZiAoIWludGVybmFsT3JkZXJDaGVja1N0YXR1c2VzW2VudGl0eV0ubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGhpbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcbiAgICAgICAgaGludC5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIGhpbnQudGV4dENvbnRlbnQgPSAn4oCUINC90LDQttC80LjRgtC1IMKr0JfQsNCz0YDRg9C30LjRgtGMINGB0L/RgNCw0LLQvtGH0L3QuNC60LjCuyDigJQnO1xuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQoaGludCk7XG4gICAgfVxuICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGRlZmF1bHRTdGF0ZSA9IGludGVybmFsT3JkZXJDaGVja1N0YXR1c2VzW2VudGl0eV0uZmluZChpdGVtID0+XG4gICAgICAgICAgICBTdHJpbmcoaXRlbS5uYW1lKS50cmltKCkudG9Mb3dlckNhc2UoKSA9PT0gSU5URVJOQUxfT1JERVJfQ0hFQ0tfREVGQVVMVF9TVEFUVVMudG9Mb3dlckNhc2UoKSk7XG4gICAgICAgIGlmIChkZWZhdWx0U3RhdGUpIHtcbiAgICAgICAgICAgIGNvbnN0IG9wdGlvbiA9IFsuLi5zZWxlY3Qub3B0aW9uc10uZmluZChpdGVtID0+IGl0ZW0udmFsdWUgPT09IGRlZmF1bHRTdGF0ZS5ocmVmKTtcbiAgICAgICAgICAgIGlmIChvcHRpb24pIG9wdGlvbi5zZWxlY3RlZCA9IHRydWU7XG4gICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5nc1tjb25maWcuc3RhdHVzS2V5XSA9IFtkZWZhdWx0U3RhdGUuaHJlZl07XG4gICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrUmVhZENvbnRyb2xzKCkge1xuICAgIGNvbnN0IGN1c3RvbWVyT3JnYW5pemF0aW9uID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsQ3VzdG9tZXJPcmdhbml6YXRpb24nKTtcbiAgICBjb25zdCBpbnRlcm5hbE9yZ2FuaXphdGlvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJJbnRlcm5hbE9yZGVyT3JnYW5pemF0aW9uJyk7XG4gICAgY29uc3QgY3VzdG9tZXJXYXJlaG91c2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VySW50ZXJuYWxDdXN0b21lcldhcmVob3VzZScpO1xuICAgIGNvbnN0IGludGVybmFsV2FyZWhvdXNlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsT3JkZXJXYXJlaG91c2UnKTtcbiAgICBjb25zdCBjdXN0b21lclN0YXR1c2VzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsQ3VzdG9tZXJTdGF0dXNlcycpO1xuICAgIGNvbnN0IGludGVybmFsU3RhdHVzZXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VySW50ZXJuYWxPcmRlclN0YXR1c2VzJyk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MgPSBpbnRlcm5hbE9yZGVyQ2hlY2tOb3JtYWxpemVTZXR0aW5ncyh7XG4gICAgICAgIGN1c3RvbWVyT3JnYW5pemF0aW9uSHJlZjogY3VzdG9tZXJPcmdhbml6YXRpb24gPyBjdXN0b21lck9yZ2FuaXphdGlvbi52YWx1ZSA6IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmN1c3RvbWVyT3JnYW5pemF0aW9uSHJlZixcbiAgICAgICAgaW50ZXJuYWxPcmdhbml6YXRpb25IcmVmOiBpbnRlcm5hbE9yZ2FuaXphdGlvbiA/IGludGVybmFsT3JnYW5pemF0aW9uLnZhbHVlIDogaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuaW50ZXJuYWxPcmdhbml6YXRpb25IcmVmLFxuICAgICAgICBjdXN0b21lcldhcmVob3VzZUhyZWY6IGN1c3RvbWVyV2FyZWhvdXNlID8gY3VzdG9tZXJXYXJlaG91c2UudmFsdWUgOiBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5jdXN0b21lcldhcmVob3VzZUhyZWYsXG4gICAgICAgIGludGVybmFsV2FyZWhvdXNlSHJlZjogaW50ZXJuYWxXYXJlaG91c2UgPyBpbnRlcm5hbFdhcmVob3VzZS52YWx1ZSA6IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmludGVybmFsV2FyZWhvdXNlSHJlZixcbiAgICAgICAgY3VzdG9tZXJTdGF0dXNIcmVmczogY3VzdG9tZXJTdGF0dXNlc1xuICAgICAgICAgICAgPyBbLi4uY3VzdG9tZXJTdGF0dXNlcy5zZWxlY3RlZE9wdGlvbnNdLm1hcChvcHRpb24gPT4gb3B0aW9uLnZhbHVlKVxuICAgICAgICAgICAgOiBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5jdXN0b21lclN0YXR1c0hyZWZzLFxuICAgICAgICBpbnRlcm5hbFN0YXR1c0hyZWZzOiBpbnRlcm5hbFN0YXR1c2VzXG4gICAgICAgICAgICA/IFsuLi5pbnRlcm5hbFN0YXR1c2VzLnNlbGVjdGVkT3B0aW9uc10ubWFwKG9wdGlvbiA9PiBvcHRpb24udmFsdWUpXG4gICAgICAgICAgICA6IGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmludGVybmFsU3RhdHVzSHJlZnNcbiAgICB9KTtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tTYXZlU2V0dGluZ3MoKTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrUmVmcmVzaFN0YXR1c2VzKGVudGl0eSkge1xuICAgIHJldHVybiBtc1JlZmVyZW5jZUxvYWQoZW50aXR5LCB7IGZvcmNlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tSZWZyZXNoT3JnYW5pemF0aW9ucygpIHtcbiAgICByZXR1cm4gaGFja2VyTm90aWZpZXJSZWZyZXNoT3JnYW5pemF0aW9ucyh0cnVlKVxuICAgICAgICAudGhlbihpdGVtcyA9PiB7XG4gICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tGaWxsT3JnYW5pemF0aW9ucygpO1xuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoYNCe0YDQs9Cw0L3QuNC30LDRhtC40Lgg0L7QsdC90L7QstC70LXQvdGLINC00LvRjyDQtNCy0YPRhSDRgtC40L/QvtCyINC00L7QutGD0LzQtdC90YLQvtCyOiAke2l0ZW1zLmxlbmd0aH0g0YjRgi5gKTtcbiAgICAgICAgICAgIHJldHVybiBpdGVtcztcbiAgICAgICAgfSk7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1JlZnJlc2hXYXJlaG91c2VzKCkge1xuICAgIHJldHVybiBtc1JlZmVyZW5jZUxvYWQoJ3N0b3JlJywgeyBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrUmVmcmVzaEFsbExpc3RzKHN0YXR1cykge1xuICAgIGlmICghaGFja2VyQmVhcmVyRW5hYmxlZCB8fCAhaGFja2VyQmVhcmVyVG9rZW4udHJpbSgpKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSAn0JTQu9GPINC30LDQs9GA0YPQt9C60Lgg0L7RgNCz0LDQvdC40LfQsNGG0LjQuSwg0YHQutC70LDQtNC+0LIg0Lgg0YHRgtCw0YLRg9GB0L7QsiDQstC60LvRjtGH0LjRgtC1IEJlYXJlciDQuCDRg9C60LDQttC40YLQtSBBUEkt0LrQu9GO0Ycg0JzQvtC50KHQutC70LDQtC4nO1xuICAgICAgICBpZiAoc3RhdHVzKSB7XG4gICAgICAgICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICAgICAgICAgICAgc3RhdHVzLnN0eWxlLmNvbG9yID0gJyNiNDUzMDknO1xuICAgICAgICB9XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKG1lc3NhZ2UsIG51bGwsICd3YXJuJyk7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICAgIH1cbiAgICByZXR1cm4gbXNSZWZlcmVuY2VSZWZyZXNoKHsgZm9yY2U6IHRydWUsIHN0YXR1cyB9KTtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrU3RhdGVOYW1lcyhlbnRpdHksIHN0YXR1c0hyZWZzKSB7XG4gICAgcmV0dXJuIHN0YXR1c0hyZWZzXG4gICAgICAgIC5tYXAoaHJlZiA9PiBpbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXNlc1tlbnRpdHldLmZpbmQoc3RhdGUgPT4gc3RhdGUuaHJlZiA9PT0gaHJlZik/Lm5hbWUpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja01hdGNoZXNTdGF0dXMocm93LCBzdGF0dXNIcmVmcywgc3RhdHVzTmFtZXMpIHtcbiAgICBjb25zdCBzdGF0ZUhyZWYgPSByb3c/LnN0YXRlPy5tZXRhPy5ocmVmIHx8ICcnO1xuICAgIGNvbnN0IHN0YXRlTmFtZSA9IFN0cmluZyhyb3c/LnN0YXRlPy5uYW1lIHx8ICcnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICByZXR1cm4gc3RhdHVzSHJlZnMuaW5jbHVkZXMoc3RhdGVIcmVmKSB8fCBzdGF0dXNOYW1lcy5zb21lKG5hbWUgPT4gU3RyaW5nKG5hbWUpLnRyaW0oKS50b0xvd2VyQ2FzZSgpID09PSBzdGF0ZU5hbWUpO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tNYXRjaGVzV2FyZWhvdXNlKGVudGl0eSwgcm93LCB3YXJlaG91c2VIcmVmKSB7XG4gICAgY29uc3QgcmVmZXJlbmNlcyA9IGVudGl0eSA9PT0gJ2N1c3RvbWVyb3JkZXInXG4gICAgICAgID8gW3Jvdz8uc3RvcmUsIHJvdz8ud2FyZWhvdXNlXVxuICAgICAgICA6IFtyb3c/LnNvdXJjZVN0b3JlLCByb3c/LnRhcmdldFN0b3JlLCByb3c/LnN0b3JlXTtcbiAgICByZXR1cm4gcmVmZXJlbmNlcy5zb21lKHJlZmVyZW5jZSA9PiByZWZlcmVuY2U/Lm1ldGE/LmhyZWYgPT09IHdhcmVob3VzZUhyZWYpO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaEFsbFBhZ2VzKHBhdGgsIHJvd3MgPSBbXSwgdmlzaXRlZCA9IG5ldyBTZXQoKSwgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbikge1xuICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24pIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKSk7XG4gICAgY29uc3Qgbm9ybWFsaXplZFBhdGggPSBoYWNrZXJBcGlQYXRoKHBhdGgpO1xuICAgIGlmICghbm9ybWFsaXplZFBhdGggfHwgdmlzaXRlZC5oYXMobm9ybWFsaXplZFBhdGgpKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoJ9Cc0L7QudCh0LrQu9Cw0LQg0LLQtdGA0L3Rg9C7INGG0LjQutC70LjRh9C10YHQutGD0Y4g0YHRgdGL0LvQutGDINC/0LDQs9C40L3QsNGG0LjQuCcpKTtcbiAgICB9XG4gICAgdmlzaXRlZC5hZGQobm9ybWFsaXplZFBhdGgpO1xuICAgIHJldHVybiBtc0FwaVAoJ0dFVCcsIG5vcm1hbGl6ZWRQYXRoKS50aGVuKHBhZ2UgPT4ge1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgY29uc3QgcGFnZVJvd3MgPSBBcnJheS5pc0FycmF5KHBhZ2U/LnJvd3MpID8gcGFnZS5yb3dzIDogW107XG4gICAgICAgIHJvd3MucHVzaCguLi5wYWdlUm93cyk7XG4gICAgICAgIGNvbnN0IG5leHRIcmVmID0gcGFnZT8ubWV0YT8ubmV4dEhyZWY7XG4gICAgICAgIHJldHVybiBuZXh0SHJlZlxuICAgICAgICAgICAgPyBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaEFsbFBhZ2VzKG5leHRIcmVmLCByb3dzLCB2aXNpdGVkLCBnZW5lcmF0aW9uKVxuICAgICAgICAgICAgOiByb3dzO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaERvY3VtZW50cyhlbnRpdHksIG9yZ2FuaXphdGlvbkhyZWYsIHdhcmVob3VzZUhyZWYsIHN0YXR1c0hyZWZzKSB7XG4gICAgaWYgKCFvcmdhbml6YXRpb25IcmVmKSByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKGDQndC1INCy0YvQsdGA0LDQvdCwINC+0YDQs9Cw0L3QuNC30LDRhtC40Y86ICR7SU5URVJOQUxfT1JERVJfQ0hFQ0tfRU5USVRJRVNbZW50aXR5XS5sYWJlbH1gKSk7XG4gICAgaWYgKCF3YXJlaG91c2VIcmVmKSByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKGDQndC1INCy0YvQsdGA0LDQvSDRgdC60LvQsNC0OiAke0lOVEVSTkFMX09SREVSX0NIRUNLX0VOVElUSUVTW2VudGl0eV0ubGFiZWx9YCkpO1xuICAgIGlmICghc3RhdHVzSHJlZnMubGVuZ3RoKSByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKGDQndC1INCy0YvQsdGA0LDQvdGLINGB0YLQsNGC0YPRgdGLOiAke0lOVEVSTkFMX09SREVSX0NIRUNLX0VOVElUSUVTW2VudGl0eV0ubGFiZWx9YCkpO1xuICAgIGNvbnN0IGZpbHRlciA9IGVuY29kZVVSSUNvbXBvbmVudCgnb3JnYW5pemF0aW9uPScgKyBvcmdhbml6YXRpb25IcmVmKTtcbiAgICBjb25zdCBwYXRoID0gYC9lbnRpdHkvJHtlbnRpdHl9P2ZpbHRlcj0ke2ZpbHRlcn0mZXhwYW5kPXN0YXRlLHN0b3JlLHNvdXJjZVN0b3JlLHRhcmdldFN0b3JlJm9yZGVyPW1vbWVudCxkZXNjJmxpbWl0PTEwMDBgO1xuICAgIGNvbnN0IHN0YXR1c05hbWVzID0gaW50ZXJuYWxPcmRlckNoZWNrU3RhdGVOYW1lcyhlbnRpdHksIHN0YXR1c0hyZWZzKTtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShg0J/QvtC70YPRh9Cw0Y4gJHtJTlRFUk5BTF9PUkRFUl9DSEVDS19FTlRJVElFU1tlbnRpdHldLmxhYmVsfWAsIHtcbiAgICAgICAgb3JnYW5pemF0aW9uSHJlZixcbiAgICAgICAgd2FyZWhvdXNlSHJlZixcbiAgICAgICAgc3RhdHVzSHJlZnMsXG4gICAgICAgIHN0YXR1c05hbWVzLFxuICAgICAgICBwYXRoXG4gICAgfSk7XG4gICAgcmV0dXJuIGludGVybmFsT3JkZXJDaGVja0ZldGNoQWxsUGFnZXMocGF0aCkudGhlbihyb3dzID0+IHtcbiAgICAgICAgY29uc3QgbWF0Y2hpbmcgPSByb3dzLmZpbHRlcihyb3cgPT5cbiAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja01hdGNoZXNTdGF0dXMocm93LCBzdGF0dXNIcmVmcywgc3RhdHVzTmFtZXMpXG4gICAgICAgICAgICAmJiBpbnRlcm5hbE9yZGVyQ2hlY2tNYXRjaGVzV2FyZWhvdXNlKGVudGl0eSwgcm93LCB3YXJlaG91c2VIcmVmKSk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKGAke0lOVEVSTkFMX09SREVSX0NIRUNLX0VOVElUSUVTW2VudGl0eV0ubGFiZWx9OiDQvdCw0LnQtNC10L3QviDQtNC+0LrRg9C80LXQvdGC0L7QsiDigJQgJHttYXRjaGluZy5sZW5ndGh9YCwge1xuICAgICAgICAgICAgdG90YWxSb3dzOiByb3dzLmxlbmd0aCxcbiAgICAgICAgICAgIG1hdGNoaW5nTmFtZXM6IG1hdGNoaW5nLm1hcChyb3cgPT4gcm93Lm5hbWUgfHwgcm93LmlkKVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tQb3NpdGlvblJvd3MoZW50aXR5LCBkb2N1bWVudCkge1xuICAgIGNvbnN0IGluaXRpYWxSb3dzID0gQXJyYXkuaXNBcnJheShkb2N1bWVudD8ucG9zaXRpb25zPy5yb3dzKSA/IGRvY3VtZW50LnBvc2l0aW9ucy5yb3dzIDogW107XG4gICAgY29uc3QgbmV4dEhyZWYgPSBkb2N1bWVudD8ucG9zaXRpb25zPy5tZXRhPy5uZXh0SHJlZjtcbiAgICBpZiAobmV4dEhyZWYpIHJldHVybiBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaEFsbFBhZ2VzKG5leHRIcmVmLCBpbml0aWFsUm93cyk7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZG9jdW1lbnQ/LnBvc2l0aW9ucz8ucm93cykpIHJldHVybiBQcm9taXNlLnJlc29sdmUoaW5pdGlhbFJvd3MpO1xuICAgIGNvbnN0IGlkID0gZG9jdW1lbnQ/LmlkIHx8IGRvY3VtZW50Py5tZXRhPy5ocmVmPy5zcGxpdCgnLycpLnBvcCgpO1xuICAgIGlmICghaWQpIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICAgIHJldHVybiBpbnRlcm5hbE9yZGVyQ2hlY2tGZXRjaEFsbFBhZ2VzKGAvZW50aXR5LyR7ZW50aXR5fS8ke2lkfS9wb3NpdGlvbnM/ZXhwYW5kPWFzc29ydG1lbnQmbGltaXQ9MTAwMGApO1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tQb3NpdGlvbktleShwb3NpdGlvbikge1xuICAgIGNvbnN0IGFzc29ydG1lbnQgPSBwb3NpdGlvbj8uYXNzb3J0bWVudCB8fCBwb3NpdGlvbj8ucHJvZHVjdCB8fCB7fTtcbiAgICByZXR1cm4gYXNzb3J0bWVudC5tZXRhPy5ocmVmIHx8IGFzc29ydG1lbnQuaWQgfHwgYG5hbWU6JHtTdHJpbmcoYXNzb3J0bWVudC5uYW1lIHx8IHBvc2l0aW9uPy5uYW1lIHx8ICfQkdC10Lcg0L3QsNC30LLQsNC90LjRjycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpfWA7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1Bvc2l0aW9uTmFtZShwb3NpdGlvbikge1xuICAgIGNvbnN0IGFzc29ydG1lbnQgPSBwb3NpdGlvbj8uYXNzb3J0bWVudCB8fCBwb3NpdGlvbj8ucHJvZHVjdCB8fCB7fTtcbiAgICByZXR1cm4gYXNzb3J0bWVudC5uYW1lIHx8IHBvc2l0aW9uPy5uYW1lIHx8ICfQkdC10Lcg0L3QsNC30LLQsNC90LjRjyc7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0FnZ3JlZ2F0ZShyb3dzKSB7XG4gICAgY29uc3QgcmVzdWx0ID0ge307XG4gICAgcm93cy5mb3JFYWNoKHBvc2l0aW9uID0+IHtcbiAgICAgICAgY29uc3Qga2V5ID0gaW50ZXJuYWxPcmRlckNoZWNrUG9zaXRpb25LZXkocG9zaXRpb24pO1xuICAgICAgICBjb25zdCBxdWFudGl0eSA9IE51bWJlcihwb3NpdGlvbj8ucXVhbnRpdHkpO1xuICAgICAgICBjb25zdCBzYWZlUXVhbnRpdHkgPSBOdW1iZXIuaXNGaW5pdGUocXVhbnRpdHkpID8gcXVhbnRpdHkgOiAwO1xuICAgICAgICBpZiAoIXJlc3VsdFtrZXldKSByZXN1bHRba2V5XSA9IHsga2V5LCBuYW1lOiBpbnRlcm5hbE9yZGVyQ2hlY2tQb3NpdGlvbk5hbWUocG9zaXRpb24pLCBxdWFudGl0eTogMCB9O1xuICAgICAgICByZXN1bHRba2V5XS5xdWFudGl0eSArPSBzYWZlUXVhbnRpdHk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gaW50ZXJuYWxPcmRlckNoZWNrQ29tcGFyZU1hcHMoY3VzdG9tZXJHb29kcywgaW50ZXJuYWxHb29kcykge1xuICAgIGNvbnN0IGtleXMgPSBuZXcgU2V0KFsuLi5PYmplY3Qua2V5cyhjdXN0b21lckdvb2RzKSwgLi4uT2JqZWN0LmtleXMoaW50ZXJuYWxHb29kcyldKTtcbiAgICBjb25zdCBhZGRlZCA9IFtdO1xuICAgIGNvbnN0IG1pc3NlZCA9IFtdO1xuICAgIGtleXMuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICBjb25zdCBjdXN0b21lciA9IGN1c3RvbWVyR29vZHNba2V5XSB8fCB7IGtleSwgbmFtZTogaW50ZXJuYWxHb29kc1trZXldPy5uYW1lIHx8IGtleSwgcXVhbnRpdHk6IDAgfTtcbiAgICAgICAgY29uc3QgaW50ZXJuYWwgPSBpbnRlcm5hbEdvb2RzW2tleV0gfHwgeyBrZXksIG5hbWU6IGN1c3RvbWVyLm5hbWUsIHF1YW50aXR5OiAwIH07XG4gICAgICAgIGNvbnN0IGRpZmZlcmVuY2UgPSBpbnRlcm5hbC5xdWFudGl0eSAtIGN1c3RvbWVyLnF1YW50aXR5O1xuICAgICAgICBpZiAoZGlmZmVyZW5jZSA+IDApIGFkZGVkLnB1c2goeyBrZXksIG5hbWU6IGludGVybmFsLm5hbWUsIHF1YW50aXR5OiBkaWZmZXJlbmNlLCBpbnRlcm5hbFF1YW50aXR5OiBpbnRlcm5hbC5xdWFudGl0eSwgY3VzdG9tZXJRdWFudGl0eTogY3VzdG9tZXIucXVhbnRpdHkgfSk7XG4gICAgICAgIGlmIChkaWZmZXJlbmNlIDwgMCkgbWlzc2VkLnB1c2goeyBrZXksIG5hbWU6IGN1c3RvbWVyLm5hbWUsIHF1YW50aXR5OiBNYXRoLmFicyhkaWZmZXJlbmNlKSwgaW50ZXJuYWxRdWFudGl0eTogaW50ZXJuYWwucXVhbnRpdHksIGN1c3RvbWVyUXVhbnRpdHk6IGN1c3RvbWVyLnF1YW50aXR5IH0pO1xuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICAgIGFkZGVkOiBhZGRlZC5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUsICdydScpKSxcbiAgICAgICAgbWlzc2VkOiBtaXNzZWQuc29ydCgoYSwgYikgPT4gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lLCAncnUnKSlcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tGb3JtYXRHb29kcyhpdGVtcykge1xuICAgIHJldHVybiBpdGVtcy5sZW5ndGhcbiAgICAgICAgPyBpdGVtcy5tYXAoaXRlbSA9PiBgJHtpdGVtLm5hbWV9IMOXICR7aXRlbS5xdWFudGl0eX1gKS5qb2luKCc7ICcpXG4gICAgICAgIDogJ9C90LXRgic7XG59XG5cbmZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja1Nob3dSZXN1bHQocmVzdWx0KSB7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsT3JkZXJDaGVja1Jlc3VsdCcpPy5yZW1vdmUoKTtcbiAgICBjb25zdCB3aW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICB3aW4uaWQgPSAnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrUmVzdWx0JztcbiAgICB3aW4uY2xhc3NOYW1lID0gJ21jLWZsb2F0LXdpbmRvdyc7XG4gICAgd2luLnN0eWxlLndpZHRoID0gJzQzMHB4JztcbiAgICB3aW4uc3R5bGUucmlnaHQgPSAnNDYwcHgnO1xuXG4gICAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaGVhZGVyLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1oZWFkZXInO1xuICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgdGl0bGUuY2xhc3NOYW1lID0gJ21jLWZsb2F0LXRpdGxlJztcbiAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfwn5OmINCg0LXQt9GD0LvRjNGC0LDRgiDQv9GA0L7QstC10YDQutC4INGC0L7QstCw0YDQvtCyJztcbiAgICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICAgIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XG4gICAgY2xvc2UudHlwZSA9ICdidXR0b24nO1xuICAgIGNsb3NlLmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1jbG9zZSc7XG4gICAgY2xvc2UudGV4dENvbnRlbnQgPSAn4pyVJztcbiAgICBjbG9zZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHdpbi5yZW1vdmUoKSk7XG4gICAgaGVhZGVyLmFwcGVuZENoaWxkKGNsb3NlKTtcbiAgICB3aW4uYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBib2R5LmNsYXNzTmFtZSA9ICdtYy1mbG9hdC1ib2R5JztcbiAgICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgc3VtbWFyeS5zdHlsZS5jc3NUZXh0ID0gJ2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM2NDc0OGI7bWFyZ2luLWJvdHRvbTo4cHg7JztcbiAgICBzdW1tYXJ5LnRleHRDb250ZW50ID0gYNCU0L7QsdCw0LLQu9C10L3QvjogJHtyZXN1bHQuYWRkZWQubGVuZ3RofTsg0YPQv9GD0YnQtdC90L46ICR7cmVzdWx0Lm1pc3NlZC5sZW5ndGh9YDtcbiAgICBib2R5LmFwcGVuZENoaWxkKHN1bW1hcnkpO1xuXG4gICAgY29uc3QgYWRkU2VjdGlvbiA9ICh0aXRsZVRleHQsIGl0ZW1zLCBjb2xvciwgZW1wdHlUZXh0KSA9PiB7XG4gICAgICAgIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWN0aW9uJyk7XG4gICAgICAgIHNlY3Rpb24uc3R5bGUuY3NzVGV4dCA9ICdtYXJnaW4tYm90dG9tOjEwcHg7JztcbiAgICAgICAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgICAgICBoZWFkaW5nLnN0eWxlLmNzc1RleHQgPSBgZm9udC1zaXplOjExLjVweDtmb250LXdlaWdodDo3MDA7Y29sb3I6JHtjb2xvcn07bWFyZ2luLWJvdHRvbTo0cHg7YDtcbiAgICAgICAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlVGV4dDtcbiAgICAgICAgc2VjdGlvbi5hcHBlbmRDaGlsZChoZWFkaW5nKTtcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICBlbXB0eS5zdHlsZS5jc3NUZXh0ID0gJ3BhZGRpbmc6N3B4IDlweDtib3JkZXI6MXB4IHNvbGlkICNlNWU3ZWI7Ym9yZGVyLXJhZGl1czo3cHg7Y29sb3I6IzY0NzQ4Yjtmb250LXNpemU6MTFweDsnO1xuICAgICAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSBlbXB0eVRleHQ7XG4gICAgICAgICAgICBzZWN0aW9uLmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGl0ZW1zLmZvckVhY2goaXRlbSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICAgICAgICAgICAgcm93LnN0eWxlLmNzc1RleHQgPSAncGFkZGluZzo2cHggOXB4O21hcmdpbi10b3A6NHB4O2JvcmRlcjoxcHggc29saWQgI2U1ZTdlYjtib3JkZXItcmFkaXVzOjdweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzFmMjkzNztmb250LXNpemU6MTEuNXB4Oyc7XG4gICAgICAgICAgICAgICAgcm93LnRleHRDb250ZW50ID0gYCR7aXRlbS5uYW1lfSDDlyAke2l0ZW0ucXVhbnRpdHl9YDtcbiAgICAgICAgICAgICAgICBzZWN0aW9uLmFwcGVuZENoaWxkKHJvdyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBib2R5LmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICAgIH07XG5cbiAgICBhZGRTZWN0aW9uKCfinpUg0JTQvtCx0LDQstC70LXQvdC+INCy0L4g0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9Cw0YUnLCByZXN1bHQuYWRkZWQsICcjMTY2NTM0JywgJ9Cd0LXRgiDQu9C40YjQvdC40YUg0L/QvtC30LjRhtC40LknKTtcbiAgICBhZGRTZWN0aW9uKCfimqDvuI8g0KPQv9GD0YnQtdC90L4g0LLQviDQstC90YPRgtGA0LXQvdC90LjRhSDQt9Cw0LrQsNC30LDRhScsIHJlc3VsdC5taXNzZWQsICcjYjkxYzFjJywgJ9CS0YHQtSDQv9C+0LfQuNGG0LjQuCDQv9C+0LrRgNGL0YLRiycpO1xuICAgIHdpbi5hcHBlbmRDaGlsZChib2R5KTtcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHdpbik7XG4gICAgbWFrZU1vdmFibGUod2luLCBoZWFkZXIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tDb2xsZWN0R29vZHMoZW50aXR5LCBkb2N1bWVudHMpIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIGNvbnN0IG91dGNvbWVzID0gbmV3IEFycmF5KGRvY3VtZW50cy5sZW5ndGgpO1xuICAgIGxldCBuZXh0SW5kZXggPSAwO1xuICAgIGNvbnN0IHdvcmtlciA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgd2hpbGUgKG5leHRJbmRleCA8IGRvY3VtZW50cy5sZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24pIHRocm93IG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvScpO1xuICAgICAgICAgICAgY29uc3QgaW5kZXggPSBuZXh0SW5kZXgrKztcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gZG9jdW1lbnRzW2luZGV4XTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcG9zaXRpb25zID0gYXdhaXQgaW50ZXJuYWxPcmRlckNoZWNrUG9zaXRpb25Sb3dzKGVudGl0eSwgZG9jdW1lbnQpO1xuICAgICAgICAgICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24pIHRocm93IG5ldyBFcnJvcign0JfQsNC/0YDQvtGBINC6IGFwaS5tb3lza2xhZC5ydSDQvtGC0LzQtdC90ZHQvScpO1xuICAgICAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKGAke2RvY3VtZW50Lm5hbWUgfHwgZG9jdW1lbnQuaWR9OiDQv9C+0LvRg9GH0LXQvdC+INC/0L7Qt9C40YbQuNC5IOKAlCAke3Bvc2l0aW9ucy5sZW5ndGh9YCk7XG4gICAgICAgICAgICAgICAgb3V0Y29tZXNbaW5kZXhdID0geyBkb2N1bWVudCwgcG9zaXRpb25zLCBlcnJvcjogbnVsbCB9O1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZShgJHtkb2N1bWVudC5uYW1lIHx8IGRvY3VtZW50LmlkfTog0L3QtSDRg9C00LDQu9C+0YHRjCDQv9C+0LvRg9GH0LjRgtGMINC/0L7Qt9C40YbQuNC4YCwgZXJyb3IsICdlcnInKTtcbiAgICAgICAgICAgICAgICBvdXRjb21lc1tpbmRleF0gPSB7IGRvY3VtZW50LCBwb3NpdGlvbnM6IFtdLCBlcnJvciB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcbiAgICBjb25zdCB3b3JrZXJDb3VudCA9IE1hdGgubWluKE1TX0FQSV9NQVhfQ09OQ1VSUkVOVF9SRVFVRVNUUywgZG9jdW1lbnRzLmxlbmd0aCk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogd29ya2VyQ291bnQgfSwgd29ya2VyKSk7XG4gICAgY29uc3QgZmFpbHVyZXMgPSBvdXRjb21lcy5maWx0ZXIob3V0Y29tZSA9PiBvdXRjb21lLmVycm9yKTtcbiAgICBpZiAoZmFpbHVyZXMubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKGDQndC1INGD0LTQsNC70L7RgdGMINC/0L7Qu9C90L7RgdGC0YzRjiDQt9Cw0LPRgNGD0LfQuNGC0Ywg0L/QvtC30LjRhtC40Lgg0LTQu9GPICR7ZmFpbHVyZXMubGVuZ3RofSDQuNC3ICR7ZG9jdW1lbnRzLmxlbmd0aH0g0LTQvtC60YPQvNC10L3RgtC+0LJgKTtcbiAgICAgICAgZXJyb3IucGFydGlhbEZhaWx1cmUgPSB0cnVlO1xuICAgICAgICBlcnJvci5mYWlsZWREb2N1bWVudHMgPSBmYWlsdXJlcy5tYXAob3V0Y29tZSA9PiBvdXRjb21lLmRvY3VtZW50Lm5hbWUgfHwgb3V0Y29tZS5kb2N1bWVudC5pZCB8fCAn0JHQtdC3INC90LDQt9Cy0LDQvdC40Y8nKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICAgIHJldHVybiBpbnRlcm5hbE9yZGVyQ2hlY2tBZ2dyZWdhdGUob3V0Y29tZXMuZmxhdE1hcChvdXRjb21lID0+IG91dGNvbWUucG9zaXRpb25zKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGludGVybmFsT3JkZXJDaGVja0NvbXBhcmUoKSB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9IG1zQXBpR2VuZXJhdGlvbjtcbiAgICBpbnRlcm5hbE9yZGVyQ2hlY2tSZWFkQ29udHJvbHMoKTtcbiAgICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VySW50ZXJuYWxPcmRlckNoZWNrU3RhdHVzJyk7XG4gICAgY29uc3Qgc2V0U3RhdHVzID0gKG1lc3NhZ2UsIGtpbmQgPSAnaW5mbycpID0+IHtcbiAgICAgICAgaWYgKHN0YXR1cykge1xuICAgICAgICAgICAgc3RhdHVzLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgICAgICAgICAgIHN0YXR1cy5zdHlsZS5jb2xvciA9IGtpbmQgPT09ICdlcnInID8gJyNiOTFjMWMnIDoga2luZCA9PT0gJ3dhcm4nID8gJyNiNDUzMDknIDogJyMxNjY1MzQnO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBjb21wYXJlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlckludGVybmFsT3JkZXJDb21wYXJlJyk7XG4gICAgaWYgKGNvbXBhcmUpIGNvbXBhcmUuZGlzYWJsZWQgPSB0cnVlO1xuICAgIHNldFN0YXR1cygn0J/RgNC+0LLQtdGA0Y/RjiDQtNC+0LrRg9C80LXQvdGC0Ysg0Lgg0L/QvtC30LjRhtC40LjigKYnKTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBbY3VzdG9tZXJPcmRlcnMsIGludGVybmFsT3JkZXJzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgICAgIGludGVybmFsT3JkZXJDaGVja0ZldGNoRG9jdW1lbnRzKCdjdXN0b21lcm9yZGVyJywgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuY3VzdG9tZXJPcmdhbml6YXRpb25IcmVmLCBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5jdXN0b21lcldhcmVob3VzZUhyZWYsIGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmN1c3RvbWVyU3RhdHVzSHJlZnMpLFxuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrRmV0Y2hEb2N1bWVudHMoJ2ludGVybmFsb3JkZXInLCBpbnRlcm5hbE9yZGVyQ2hlY2tTZXR0aW5ncy5pbnRlcm5hbE9yZ2FuaXphdGlvbkhyZWYsIGludGVybmFsT3JkZXJDaGVja1NldHRpbmdzLmludGVybmFsV2FyZWhvdXNlSHJlZiwgaW50ZXJuYWxPcmRlckNoZWNrU2V0dGluZ3MuaW50ZXJuYWxTdGF0dXNIcmVmcylcbiAgICAgICAgXSk7XG4gICAgICAgIC8vIERvIG5vdCBzd2l0Y2ggYWNjb3VudHMgYmV0d2VlbiBsaXN0IGNvbGxlY3Rpb24gYW5kIHBvc2l0aW9uIHJlYWRzLlxuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgY29uc3QgW2N1c3RvbWVyR29vZHMsIGludGVybmFsR29vZHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrQ29sbGVjdEdvb2RzKCdjdXN0b21lcm9yZGVyJywgY3VzdG9tZXJPcmRlcnMpLFxuICAgICAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrQ29sbGVjdEdvb2RzKCdpbnRlcm5hbG9yZGVyJywgaW50ZXJuYWxPcmRlcnMpXG4gICAgICAgIF0pO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uKSB0aHJvdyBuZXcgRXJyb3IoJ9CX0LDQv9GA0L7RgSDQuiBhcGkubW95c2tsYWQucnUg0L7RgtC80LXQvdGR0L0nKTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gaW50ZXJuYWxPcmRlckNoZWNrQ29tcGFyZU1hcHMoY3VzdG9tZXJHb29kcywgaW50ZXJuYWxHb29kcyk7XG4gICAgICAgIGNvbnN0IGN1c3RvbWVyVG90YWwgPSBPYmplY3QudmFsdWVzKGN1c3RvbWVyR29vZHMpLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyBpdGVtLnF1YW50aXR5LCAwKTtcbiAgICAgICAgY29uc3QgaW50ZXJuYWxUb3RhbCA9IE9iamVjdC52YWx1ZXMoaW50ZXJuYWxHb29kcykucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIGl0ZW0ucXVhbnRpdHksIDApO1xuICAgICAgICBpbnRlcm5hbE9yZGVyQ2hlY2tUcmFjZSgn0KHRgNCw0LLQvdC10L3QuNC1INC30LDQstC10YDRiNC10L3QvicsIHtcbiAgICAgICAgICAgIGN1c3RvbWVyT3JkZXJzOiBjdXN0b21lck9yZGVycy5sZW5ndGgsXG4gICAgICAgICAgICBpbnRlcm5hbE9yZGVyczogaW50ZXJuYWxPcmRlcnMubGVuZ3RoLFxuICAgICAgICAgICAgY3VzdG9tZXJQb3NpdGlvbnM6IGN1c3RvbWVyVG90YWwsXG4gICAgICAgICAgICBpbnRlcm5hbFBvc2l0aW9uczogaW50ZXJuYWxUb3RhbCxcbiAgICAgICAgICAgIGFkZGVkOiByZXN1bHQuYWRkZWQsXG4gICAgICAgICAgICBtaXNzZWQ6IHJlc3VsdC5taXNzZWRcbiAgICAgICAgfSk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKGDinpUg0JTQvtCx0LDQstC70LXQvdC+INCy0L4g0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9Cw0YU6ICR7aW50ZXJuYWxPcmRlckNoZWNrRm9ybWF0R29vZHMocmVzdWx0LmFkZGVkKX1gLCByZXN1bHQuYWRkZWQubGVuZ3RoID8gcmVzdWx0LmFkZGVkIDogbnVsbCwgcmVzdWx0LmFkZGVkLmxlbmd0aCA/ICdpbmZvJyA6ICd3YXJuJyk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1RyYWNlKGDimqDvuI8g0KPQv9GD0YnQtdC90L4g0LLQviDQstC90YPRgtGA0LXQvdC90LjRhSDQt9Cw0LrQsNC30LDRhTogJHtpbnRlcm5hbE9yZGVyQ2hlY2tGb3JtYXRHb29kcyhyZXN1bHQubWlzc2VkKX1gLCByZXN1bHQubWlzc2VkLmxlbmd0aCA/IHJlc3VsdC5taXNzZWQgOiBudWxsLCByZXN1bHQubWlzc2VkLmxlbmd0aCA/ICd3YXJuJyA6ICdpbmZvJyk7XG4gICAgICAgIGlmICghcmVzdWx0LmFkZGVkLmxlbmd0aCAmJiAhcmVzdWx0Lm1pc3NlZC5sZW5ndGgpIGludGVybmFsT3JkZXJDaGVja1RyYWNlKCfinIUg0KHQv9C40YHQutC4INGC0L7QstCw0YDQvtCyINGB0L7QstC/0LDQtNCw0Y7RgicsIG51bGwsICdpbmZvJyk7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1Nob3dSZXN1bHQocmVzdWx0KTtcbiAgICAgICAgc2V0U3RhdHVzKGDQk9C+0YLQvtCy0L46INC00L7QsdCw0LLQu9C10L3QviAke3Jlc3VsdC5hZGRlZC5sZW5ndGh9LCDRg9C/0YPRidC10L3QviAke3Jlc3VsdC5taXNzZWQubGVuZ3RofWApO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvci5wYXJ0aWFsRmFpbHVyZVxuICAgICAgICAgICAgPyBg0JTQsNC90L3Ri9C1INC90LXQv9C+0LvQvdGL0LUsINGB0YDQsNCy0L3QtdC90LjQtSDQvtGC0LzQtdC90LXQvdC+LiDQntGI0LjQsdC60LAg0LfQsNCz0YDRg9C30LrQuDogJHtlcnJvci5mYWlsZWREb2N1bWVudHMuam9pbignLCAnKX1gXG4gICAgICAgICAgICA6IGVycm9yLm1lc3NhZ2UgfHwgU3RyaW5nKGVycm9yKTtcbiAgICAgICAgaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoJ9Ch0YDQsNCy0L3QtdC90LjQtSDQvdC1INCy0YvQv9C+0LvQvdC10L3QvicsIGVycm9yLCAnZXJyJyk7XG4gICAgICAgIHNldFN0YXR1cyhtZXNzYWdlLCAnZXJyJyk7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmIChjb21wYXJlKSBjb21wYXJlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBpbnRlcm5hbE9yZGVyQ2hlY2tCdWlsZFNldHRpbmdzUGFuZWwoKSB7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrTG9hZFNldHRpbmdzKCk7XG4gICAgY29uc3Qgd3JhcCA9IGhhY2tlckVsKCdkaXYnKTtcbiAgICB3cmFwLmlkID0gJ2hhY2tlckludGVybmFsT3JkZXJTZXR0aW5ncyc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM2NDc0OGI7bGluZS1oZWlnaHQ6MS40O21hcmdpbi1ib3R0b206OHB4OycsXG4gICAgICAgICfQrdGC0Lgg0L/QsNGA0LDQvNC10YLRgNGLINC40YHQv9C+0LvRjNC30YPRjtGC0YHRjyDQstC60LvQsNC00LrQvtC5IMKr0J/RgNC+0LLQtdGA0LrQsCDQt9Cw0LrQsNC30L7QssK7LiDQmNC30LzQtdC90LXQvdC40Y8g0YHQvtGF0YDQsNC90Y/RjtGC0YHRjyDQsNCy0YLQvtC80LDRgtC40YfQtdGB0LrQuC4nKSk7XG5cbiAgICBjb25zdCBmaWVsZCA9IChsYWJlbCwgc2VsZWN0KSA9PiB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gaGFja2VyRWwoJ2xhYmVsJywgJ2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjExcHg7Y29sb3I6IzQ3NTU2OTttYXJnaW4tYm90dG9tOjhweDsnLCBsYWJlbCk7XG4gICAgICAgIGJsb2NrLmFwcGVuZENoaWxkKHNlbGVjdCk7XG4gICAgICAgIHJldHVybiBibG9jaztcbiAgICB9O1xuICAgIGNvbnN0IHNlbGVjdFN0eWxlID0gJ2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTAwJTttYXJnaW4tdG9wOjNweDtwYWRkaW5nOjVweCA2cHg7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoxcHggc29saWQgI2NiZDVlMTtib3JkZXItcmFkaXVzOjdweDtjb2xvcjojMzM0MTU1O2ZvbnQtc2l6ZToxMXB4Oyc7XG4gICAgY29uc3QgY3VzdG9tZXJPcmdhbml6YXRpb24gPSBoYWNrZXJTZWxlY3QoJ2hhY2tlckludGVybmFsQ3VzdG9tZXJPcmdhbml6YXRpb24nLCAn4oCUINC+0YDQs9Cw0L3QuNC30LDRhtC40Y8g0LfQsNC60LDQt9C+0LIg4oCUJyk7XG4gICAgY29uc3QgaW50ZXJuYWxPcmdhbml6YXRpb24gPSBoYWNrZXJTZWxlY3QoJ2hhY2tlckludGVybmFsT3JkZXJPcmdhbml6YXRpb24nLCAn4oCUINC+0YDQs9Cw0L3QuNC30LDRhtC40Y8g0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LIg4oCUJyk7XG4gICAgY29uc3QgY3VzdG9tZXJXYXJlaG91c2UgPSBoYWNrZXJTZWxlY3QoJ2hhY2tlckludGVybmFsQ3VzdG9tZXJXYXJlaG91c2UnLCAn4oCUINGB0LrQu9Cw0LQg0LfQsNC60LDQt9C+0LIg4oCUJyk7XG4gICAgY29uc3QgaW50ZXJuYWxXYXJlaG91c2UgPSBoYWNrZXJTZWxlY3QoJ2hhY2tlckludGVybmFsT3JkZXJXYXJlaG91c2UnLCAn4oCUINGB0LrQu9Cw0LQg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LIg4oCUJyk7XG4gICAgW2N1c3RvbWVyT3JnYW5pemF0aW9uLCBpbnRlcm5hbE9yZ2FuaXphdGlvbiwgY3VzdG9tZXJXYXJlaG91c2UsIGludGVybmFsV2FyZWhvdXNlXS5mb3JFYWNoKHNlbGVjdCA9PiB7IHNlbGVjdC5zdHlsZS5jc3NUZXh0ID0gc2VsZWN0U3R5bGU7IH0pO1xuXG4gICAgY29uc3QgY3VzdG9tZXJTdGF0dXNlcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xuICAgIGN1c3RvbWVyU3RhdHVzZXMuaWQgPSAnaGFja2VySW50ZXJuYWxDdXN0b21lclN0YXR1c2VzJztcbiAgICBjdXN0b21lclN0YXR1c2VzLm11bHRpcGxlID0gdHJ1ZTtcbiAgICBjdXN0b21lclN0YXR1c2VzLnNpemUgPSA0O1xuICAgIGN1c3RvbWVyU3RhdHVzZXMuc3R5bGUuY3NzVGV4dCA9IHNlbGVjdFN0eWxlICsgJ21pbi1oZWlnaHQ6NzZweDsnO1xuICAgIGNvbnN0IGludGVybmFsU3RhdHVzZXMgPSBjdXN0b21lclN0YXR1c2VzLmNsb25lTm9kZShmYWxzZSk7XG4gICAgaW50ZXJuYWxTdGF0dXNlcy5pZCA9ICdoYWNrZXJJbnRlcm5hbE9yZGVyU3RhdHVzZXMnO1xuXG4gICAgd3JhcC5hcHBlbmRDaGlsZChmaWVsZCgn0J7RgNCz0LDQvdC40LfQsNGG0LjRjyDQt9Cw0LrQsNC30L7QsjonLCBjdXN0b21lck9yZ2FuaXphdGlvbikpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoZmllbGQoJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40Y8g0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LI6JywgaW50ZXJuYWxPcmdhbml6YXRpb24pKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGZpZWxkKCfQodC60LvQsNC0INC30LDQutCw0LfQvtCyOicsIGN1c3RvbWVyV2FyZWhvdXNlKSk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChmaWVsZCgn0KHQutC70LDQtCDQstC90YPRgtGA0LXQvdC90LjRhSDQt9Cw0LrQsNC30L7QsjonLCBpbnRlcm5hbFdhcmVob3VzZSkpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoZmllbGQoJ9Ch0YLQsNGC0YPRgdGLINC30LDQutCw0LfQvtCyIChDdHJsL+KMmCDigJQg0L3QtdGB0LrQvtC70YzQutC+KTonLCBjdXN0b21lclN0YXR1c2VzKSk7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChmaWVsZCgn0KHRgtCw0YLRg9GB0Ysg0LLQvdGD0YLRgNC10L3QvdC40YUg0LfQsNC60LDQt9C+0LIgKEN0cmwv4oyYIOKAlCDQvdC10YHQutC+0LvRjNC60L4pOicsIGludGVybmFsU3RhdHVzZXMpKTtcblxuICAgIGNvbnN0IHJlZnJlc2ggPSBoYWNrZXJCdG4oJ2hhY2tlckludGVybmFsT3JkZXJSZWZyZXNoJywgJ+KshyDQl9Cw0LPRgNGD0LfQuNGC0Ywg0YHQv9GA0LDQstC+0YfQvdC40LrQuCcsIEhBQ0tFUl9NSU5JX0JUTl9DU1MpO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQocmVmcmVzaCk7XG4gICAgY29uc3Qgc3RhdHVzID0gaGFja2VyRWwoJ2RpdicsICdtaW4taGVpZ2h0OjE2cHg7bWFyZ2luLXRvcDo2cHg7Zm9udC1zaXplOjEwLjVweDsnLCAnJyk7XG4gICAgc3RhdHVzLmlkID0gJ2hhY2tlckludGVybmFsT3JkZXJTZXR0aW5nc1N0YXR1cyc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChzdGF0dXMpO1xuXG4gICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbE9yZ2FuaXphdGlvbnMod3JhcCk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbFdhcmVob3VzZXMod3JhcCk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbFN0YXR1c2VzKCdjdXN0b21lcm9yZGVyJywgd3JhcCk7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrRmlsbFN0YXR1c2VzKCdpbnRlcm5hbG9yZGVyJywgd3JhcCk7XG4gICAgbXNSZWZlcmVuY2VTaG93U3RhdHVzKHN0YXR1cyk7XG4gICAgY3VzdG9tZXJPcmdhbml6YXRpb24uYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaW50ZXJuYWxPcmRlckNoZWNrUmVhZENvbnRyb2xzKTtcbiAgICBpbnRlcm5hbE9yZ2FuaXphdGlvbi5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBpbnRlcm5hbE9yZGVyQ2hlY2tSZWFkQ29udHJvbHMpO1xuICAgIGN1c3RvbWVyV2FyZWhvdXNlLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGludGVybmFsT3JkZXJDaGVja1JlYWRDb250cm9scyk7XG4gICAgaW50ZXJuYWxXYXJlaG91c2UuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaW50ZXJuYWxPcmRlckNoZWNrUmVhZENvbnRyb2xzKTtcbiAgICBjdXN0b21lclN0YXR1c2VzLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGludGVybmFsT3JkZXJDaGVja1JlYWRDb250cm9scyk7XG4gICAgaW50ZXJuYWxTdGF0dXNlcy5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBpbnRlcm5hbE9yZGVyQ2hlY2tSZWFkQ29udHJvbHMpO1xuICAgIHJlZnJlc2guYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIGludGVybmFsT3JkZXJDaGVja1JlZnJlc2hBbGxMaXN0cyhzdGF0dXMpXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4gaW50ZXJuYWxPcmRlckNoZWNrVHJhY2UoJ9Cd0LUg0YPQtNCw0LvQvtGB0Ywg0L7QsdC90L7QstC40YLRjCDRgdC/0LjRgdC60LgnLCBlcnJvciwgJ2VycicpKTtcbiAgICB9KTtcbiAgICByZXR1cm4gd3JhcDtcbn1cblxuZnVuY3Rpb24gaGFja2VyQnVpbGRJbnRlcm5hbE9yZGVyQ2hlY2tUYWIoKSB7XG4gICAgaW50ZXJuYWxPcmRlckNoZWNrTG9hZFNldHRpbmdzKCk7XG4gICAgY29uc3Qgd3JhcCA9IGhhY2tlckVsKCdkaXYnKTtcbiAgICB3cmFwLmlkID0gJ2hhY2tlclRhYkludGVybmFsT3JkZXJDaGVjayc7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChoYWNrZXJFbCgnZGl2JywgJ2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM2NDc0OGI7bGluZS1oZWlnaHQ6MS40O21hcmdpbi1ib3R0b206OHB4OycsXG4gICAgICAgICfQodGA0LDQstC90LjQstCw0LXRgiDRgtC+0LLQsNGA0Ysg0LjQtyDQt9Cw0LrQsNC30L7QsiDQv9C+0LrRg9C/0LDRgtC10LvQtdC5INGBINGC0L7QstCw0YDQsNC80Lgg0LjQtyDQstC90YPRgtGA0LXQvdC90LjRhSDQt9Cw0LrQsNC30L7QsiDQv9C+INGB0L7RhdGA0LDQvdGR0L3QvdGL0Lwg0L/QsNGA0LDQvNC10YLRgNCw0LwuJykpO1xuXG4gICAgY29uc3QgYnV0dG9ucyA9IGhhY2tlckVsKCdkaXYnLCAnZGlzcGxheTpmbGV4O2dhcDo0cHg7ZmxleC13cmFwOndyYXA7Jyk7XG4gICAgY29uc3Qgc2V0dGluZ3MgPSBoYWNrZXJCdG4oJ2hhY2tlckludGVybmFsT3JkZXJPcGVuU2V0dGluZ3MnLCAn4pqZ77iPINCd0LDRgdGC0YDQvtC40YLRjCDQv9GA0L7QstC10YDQutGDJywgSEFDS0VSX01JTklfQlROX0NTUyk7XG4gICAgY29uc3QgY29tcGFyZSA9IGhhY2tlckJ0bignaGFja2VySW50ZXJuYWxPcmRlckNvbXBhcmUnLCAn8J+UjiDQn9GA0L7QstC10YDQuNGC0Ywg0YLQvtCy0LDRgNGLJywgSEFDS0VSX0JUTl9DU1MgKyAnYmFja2dyb3VuZDojNGY0NmU1OycpO1xuICAgIGJ1dHRvbnMuYXBwZW5kKHNldHRpbmdzLCBjb21wYXJlKTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGJ1dHRvbnMpO1xuICAgIGNvbnN0IHN0YXR1cyA9IGhhY2tlckVsKCdkaXYnLCAnbWluLWhlaWdodDoxNnB4O21hcmdpbi10b3A6NnB4O2ZvbnQtc2l6ZToxMC41cHg7JywgJycpO1xuICAgIHN0YXR1cy5pZCA9ICdoYWNrZXJJbnRlcm5hbE9yZGVyQ2hlY2tTdGF0dXMnO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoc3RhdHVzKTtcblxuICAgIHNldHRpbmdzLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gb3BlblNldHRpbmdzV2luZG93KCdpbnRlcm5hbE9yZGVyQ2hlY2snKSk7XG4gICAgY29tcGFyZS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgaW50ZXJuYWxPcmRlckNoZWNrQ29tcGFyZSgpLmNhdGNoKGVycm9yID0+IGludGVybmFsT3JkZXJDaGVja1RyYWNlKCfQodGA0LDQstC90LXQvdC40LU6ICcgKyBlcnJvci5tZXNzYWdlLCBlcnJvciwgJ2VycicpKTsgfSk7XG4gICAgcmV0dXJuIHdyYXA7XG59XG4iLCIvLyBQcml2YXRlIFBhbmVsIGFkYXB0ZXIgYW5kIHN0YXJ0dXAvbGlmZWN5Y2xlIGNhcGFiaWxpdGllcy4gQ29uZmlndXJlZCBiZWZvcmUgaW5pdGlhbGl6ZS5cbmxldCBleHRlbnNpb25QYW5lbFJlcXVlc3RTZXF1ZW5jZSA9IDA7XG5sZXQgZXh0ZW5zaW9uUGFuZWxTdGF0ZUxpc3RlbmVyID0gKCkgPT4ge307XG5mdW5jdGlvbiBleHRlbnNpb25QYW5lbEF1dGhMb3N0KCkge1xuICAgIGV4dGVuc2lvblBhbmVsUmVxdWVzdFNlcXVlbmNlKys7XG4gICAgZXh0ZW5zaW9uUGFuZWxTdGF0ZUxpc3RlbmVyKCdlcnJvcicsICdQYW5lbDog0YHQtdGB0YHQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwLiDQktC+0LnQtNC40YLQtSDQsiBwYW5lbC5oYXRpa28ucnUg0LIg0Y3RgtC+0Lwg0L/RgNC+0YTQuNC70LUgQ2hyb21lLicpO1xufVxuZnVuY3Rpb24gZXh0ZW5zaW9uUGFuZWxDc3JmKG9uU3VjY2Vzcywgb25FcnJvciwgZm9yY2UpIHtcbiAgICBsZXQgZmluaXNoZWQgPSBmYWxzZTtcbiAgICBjb25zdCBzZXF1ZW5jZSA9ICsrZXh0ZW5zaW9uUGFuZWxSZXF1ZXN0U2VxdWVuY2U7XG4gICAgZXh0ZW5zaW9uUGFuZWxTdGF0ZUxpc3RlbmVyKCd1bmtub3duJywgJ1BhbmVsOiDQv9GA0L7QstC10YDRj9C10Lwg0YHQtdGB0YHQuNGO4oCmJyk7XG4gICAgY29uc3QgZmluaXNoID0gcmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKGZpbmlzaGVkKSByZXR1cm47XG4gICAgICAgIGZpbmlzaGVkID0gdHJ1ZTtcbiAgICAgICAgY29uc3QgZXJyb3IgPSBjaHJvbWUucnVudGltZS5sYXN0RXJyb3JcbiAgICAgICAgICAgID8gJ9Cg0LDRgdGI0LjRgNC10L3QuNC1INC+0LHQvdC+0LLQu9C10L3QviDQuNC70Lgg0L3QtdC00L7RgdGC0YPQv9C90L4uINCf0LXRgNC10LfQsNCz0YDRg9C30LjRgtC1INCy0LrQu9Cw0LTQutGDLidcbiAgICAgICAgICAgIDogcmVzdWx0Py5vayAmJiB0eXBlb2YgcmVzdWx0LnRva2VuID09PSAnc3RyaW5nJyAmJiAvXltBLVphLXowLTlfLV17MTYsNTEyfSQvLnRlc3QocmVzdWx0LnRva2VuKVxuICAgICAgICAgICAgICAgID8gJycgOiByZXN1bHQ/LmVycm9yIHx8ICdQYW5lbDog0YTQvtC90L7QstCw0Y8g0YHQtdGB0YHQuNGPINC90LXQtNC+0YHRgtGD0L/QvdCwLiDQktC+0LnQtNC40YLQtSDQsiBwYW5lbC5oYXRpa28ucnUuJztcbiAgICAgICAgaWYgKHNlcXVlbmNlID09PSBleHRlbnNpb25QYW5lbFJlcXVlc3RTZXF1ZW5jZSkgZXh0ZW5zaW9uUGFuZWxTdGF0ZUxpc3RlbmVyKGVycm9yID8gJ2Vycm9yJyA6ICdvaycsIGVycm9yKTtcbiAgICAgICAgaWYgKGVycm9yKSBvbkVycm9yPy4obmV3IEVycm9yKGVycm9yKSk7IGVsc2Ugb25TdWNjZXNzPy4ocmVzdWx0LnRva2VuKTtcbiAgICB9O1xuICAgIHRyeSB7IGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKHsgdHlwZTogJ21lbWNoYXQ6cGFuZWwtY3NyZicsIGZvcmNlIH0sIGZpbmlzaCk7IH1cbiAgICBjYXRjaCB7IGZpbmlzaCh7IG9rOiBmYWxzZSwgZXJyb3I6ICfQoNCw0YHRiNC40YDQtdC90LjQtSDQvdC10LTQvtGB0YLRg9C/0L3Qvi4g0J/QtdGA0LXQt9Cw0LPRgNGD0LfQuNGC0LUg0LLQutC70LDQtNC60YMuJyB9KTsgfVxufVxuZnVuY3Rpb24gY29uZmlndXJlRXh0ZW5zaW9uUGxhdGZvcm0ocGxhdGZvcm0pIHtcbiAgICBwbGF0Zm9ybS5wYW5lbCA9IHsgZW5zdXJlOiBleHRlbnNpb25QYW5lbENzcmYgfTtcbiAgICBwbGF0Zm9ybS5kaXJlY3RNcyA9IHRydWU7XG4gICAgY2xlYXJQYW5lbENzcmYoKTtcbiAgICBpZiAodHlwZW9mIGV4dGVuc2lvbkNvbmZpZ3VyZU9yZGVycyA9PT0gJ2Z1bmN0aW9uJykgZXh0ZW5zaW9uQ29uZmlndXJlT3JkZXJzKHBsYXRmb3JtKTtcbiAgICBpZiAodHlwZW9mIGV4dGVuc2lvbkNvbmZpZ3VyZURpYWdub3N0aWNzID09PSAnZnVuY3Rpb24nKSBleHRlbnNpb25Db25maWd1cmVEaWFnbm9zdGljcyhwbGF0Zm9ybSk7XG4gICAgLy8gQ3Jvc3MtdGFiIGNoYW5nZXMgdXNlIHByaXZhdGUgcnVudGltZSBtZXNzYWdlcywgbmV2ZXIgc2l0ZS1yZWFkYWJsZSBTdG9yYWdlRXZlbnRzLlxuICAgIGlmICh0eXBlb2YgZXh0ZW5zaW9uU3RvcmFnZU9uQ2hhbmdlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICBleHRlbnNpb25TdG9yYWdlT25DaGFuZ2UgPSBrZXkgPT4ge1xuICAgICAgICAgICAgaWYgKGtleSA9PT0gc3RvcmFnZUtleSgnaGFja2VyTXNBcGlfdjEnKSkgaGFja2VyQ2hlY2tDcmVkZW50aWFsU2NvcGUoKTtcbiAgICAgICAgICAgIGlmIChbc3RvcmFnZUtleSgnY2xlYXJUZXh0RW5hYmxlZCcpLCBzdG9yYWdlS2V5KCdjbGVhclRleHREZWxheV92MScpXS5pbmNsdWRlcyhrZXkpKSBzZXR1cEdsb2JhbENsZWFyVGV4dEZ1bmN0aW9uYWxpdHkoKTtcbiAgICAgICAgfTtcbiAgICAgICAgZXh0ZW5zaW9uU3RvcmFnZU9uRXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgICBoYWNrZXJDcmVkZW50aWFsU2NvcGVCbG9ja2VkID0gdHJ1ZTtcbiAgICAgICAgICAgIGhhY2tlckFwaVZhbGlkYXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgbXNBcGlDYW5jZWxBbGwoKTtcbiAgICAgICAgICAgIGhhY2tlclN5bmNBY2Nlc3NVaSgpO1xuICAgICAgICB9O1xuICAgIH1cbn1cblxuY29uZmlndXJlRXh0ZW5zaW9uUGxhdGZvcm0obWVtY2hhdFBsYXRmb3JtKTtcbiIsIi8vIEV4dGVuc2lvbi1vbmx5IG5vdGlmaWVyOiBjb250ZW50IHRhYnMgY29uZmlndXJlL3JlbmRlcjsgdGhlIE1WMyB3b3JrZXIgcG9sbHMuXG5sZXQgZXh0ZW5zaW9uT3JkZXJSZXZpc2lvbjtcbmxldCBleHRlbnNpb25PcmRlclRva2VuID0gJyc7XG5sZXQgZXh0ZW5zaW9uT3JkZXJFZGl0ID0gZmFsc2U7XG5sZXQgZXh0ZW5zaW9uT3JkZXJTeW5jID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5sZXQgZXh0ZW5zaW9uT3JkZXJMYXN0U2hvd24gPSAnJztcbmNvbnN0IGV4dGVuc2lvbkNvbm5lY3Rpb25TdGF0ZSA9IHsgcGFuZWw6ICd1bmtub3duJywgYmVhcmVyOiAndW5rbm93bicsIHBhbmVsRXJyb3I6ICcnIH07XG5mdW5jdGlvbiBleHRlbnNpb25NZXNzYWdlKG1lc3NhZ2UpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICB0cnkgeyBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShtZXNzYWdlLCByZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikgcmVqZWN0KEVycm9yKCfQoNCw0YHRiNC40YDQtdC90LjQtSDQvtCx0L3QvtCy0LvQtdC90L4uINCf0LXRgNC10LfQsNCz0YDRg9C30LjRgtC1INCy0LrQu9Cw0LTQutGDLicpKTtcbiAgICAgICAgICAgIGVsc2UgaWYgKCFyZXN1bHQ/Lm9rKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdD8uY29uZmxpY3QpIGV4dGVuc2lvbk9yZGVyUmV2aXNpb24gPSByZXN1bHQucmV2aXNpb247XG4gICAgICAgICAgICAgICAgcmVqZWN0KEVycm9yKHJlc3VsdD8uZXJyb3IgfHwgJ9Cg0LDRgdGI0LjRgNC10L3QuNC1INC90LXQtNC+0YHRgtGD0L/QvdC+JykpO1xuICAgICAgICAgICAgfSBlbHNlIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgfSk7IH0gY2F0Y2ggeyByZWplY3QoRXJyb3IoJ9Cg0LDRgdGI0LjRgNC10L3QuNC1INC90LXQtNC+0YHRgtGD0L/QvdC+LiDQn9C10YDQtdC30LDQs9GA0YPQt9C40YLQtSDQstC60LvQsNC00LrRgy4nKSk7IH1cbiAgICB9KTtcbn1cbmZ1bmN0aW9uIGV4dGVuc2lvblJlbmRlckNvbm5lY3Rpb25zKCkge1xuICAgIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbWVtY2hhdENvbm5lY3Rpb25TdGF0dXMnKTtcbiAgICBpZiAoIXJvb3QpIHJldHVybjtcbiAgICBleHRlbnNpb25Db25uZWN0aW9uU3RhdGUuYmVhcmVyID0gaGFja2VyQXBpVmFsaWRhdGVkICYmIGhhY2tlckJlYXJlckVuYWJsZWQgPyAnb2snIDogJ2Vycm9yJztcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgWydiZWFyZXInLCAncGFuZWwnXSkge1xuICAgICAgICBjb25zdCBlbCA9IHJvb3QucXVlcnlTZWxlY3RvcihgW2RhdGEtY29ubmVjdGlvbj1cIiR7bmFtZX1cIl1gKTtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBuYXZpZ2F0b3Iub25MaW5lID09PSBmYWxzZSA/ICd1bmtub3duJyA6IGV4dGVuc2lvbkNvbm5lY3Rpb25TdGF0ZVtuYW1lXTtcbiAgICAgICAgY29uc3QgdGV4dCA9IGAke3N0YXRlID09PSAnb2snID8gJ/Cfn6InIDogc3RhdGUgPT09ICdlcnJvcicgPyAn8J+UtCcgOiAn8J+foSd9ICR7bmFtZX1gO1xuICAgICAgICBpZiAoZWwudGV4dENvbnRlbnQgIT09IHRleHQpIGVsLnRleHRDb250ZW50ID0gdGV4dDtcbiAgICAgICAgZWwuZGF0YXNldC5zdGF0ZSA9IHN0YXRlO1xuICAgICAgICBlbC50aXRsZSA9IG5hbWUgPT09ICdwYW5lbCdcbiAgICAgICAgICAgID8gKGV4dGVuc2lvbkNvbm5lY3Rpb25TdGF0ZS5wYW5lbEVycm9yIHx8ICdQYW5lbDog0L/QvtC00YLQstC10YDQttC00ZHQvSDQtNC+0YHRgtGD0L8g0Log0LfQsNGJ0LjRidGR0L3QvdC+0LzRgyBBUEkuJylcbiAgICAgICAgICAgICAgICArIChzdGF0ZSA9PT0gJ2Vycm9yJyA/ICcg0J7RgtC60YDRi9GC0YwgcGFuZWwuaGF0aWtvLnJ1INCyINC90L7QstC+0Lkg0LLQutC70LDQtNC60LUuJyA6ICcg0J3QsNC20LzQuCDQtNC70Y8g0L/QvtCy0YLQvtGA0L3QvtC5INC/0YDQvtCy0LXRgNC60LguJylcbiAgICAgICAgICAgIDogJ0JlYXJlcjog0L/QvtC00YLQstC10YDQttC00LXQvdC40LUg0LrQu9GO0YfQsCDQnNC+0LnQodC60LvQsNC0INCyINGN0YLQvtC5INCy0LrQu9Cw0LTQutC1Lic7XG4gICAgICAgIGVsLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGVsLnRpdGxlKTtcbiAgICB9XG59XG5mdW5jdGlvbiBleHRlbnNpb25BdHRhY2hDb25uZWN0aW9ucygpIHtcbiAgICBjb25zdCBtYWluID0gd2luZG93LnByaWNlQ2hlY2tDb250YWluZXI7XG4gICAgaWYgKCFtYWluIHx8IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtZW1jaGF0Q29ubmVjdGlvblN0YXR1cycpKSByZXR1cm47XG4gICAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHJvb3QuaWQgPSAnbWVtY2hhdENvbm5lY3Rpb25TdGF0dXMnO1xuICAgIHJvb3Quc3R5bGUuY3NzVGV4dCA9ICdkaXNwbGF5OmZsZXg7Z2FwOjlweDthbGlnbi1pdGVtczpjZW50ZXI7Zm9udDo4LjVweC8xLjQgU2Vnb2UgVUksc2Fucy1zZXJpZjttYXJnaW4tdG9wOjJweDtjb2xvcjojNDc1NTY5O2ZsZXgtd3JhcDp3cmFwOyc7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIFsnYmVhcmVyJywgJ3BhbmVsJ10pIHtcbiAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcbiAgICAgICAgZWwudHlwZSA9ICdidXR0b24nOyBlbC5kYXRhc2V0LmNvbm5lY3Rpb24gPSBuYW1lO1xuICAgICAgICBlbC5zdHlsZS5jc3NUZXh0ID0gJ2JvcmRlcjowO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7cGFkZGluZzowO2N1cnNvcjpwb2ludGVyO2ZvbnQ6aW5oZXJpdDtjb2xvcjppbmhlcml0Oyc7XG4gICAgICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5hbWUgPT09ICdiZWFyZXInKSBoYWNrZXJWYWxpZGF0ZUFwaUtleSgpO1xuICAgICAgICAgICAgZWxzZSBpZiAoZWwuZGF0YXNldC5zdGF0ZSA9PT0gJ2Vycm9yJykgd2luZG93Lm9wZW4oJ2h0dHBzOi8vcGFuZWwuaGF0aWtvLnJ1LycsICdfYmxhbmsnLCAnbm9vcGVuZXIsbm9yZWZlcnJlcicpO1xuICAgICAgICAgICAgZWxzZSBleHRlbnNpb25DaGVja1BhbmVsKHRydWUpO1xuICAgICAgICB9KTtcbiAgICAgICAgcm9vdC5hcHBlbmRDaGlsZChlbCk7XG4gICAgfVxuICAgIGNvbnN0IG9sZFN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtZW1jaGF0QmVhcmVyU3RhdHVzJyk7XG4gICAgaWYgKG9sZFN0YXR1cykgb2xkU3RhdHVzLnJlcGxhY2VXaXRoKHJvb3QpO1xuICAgIGVsc2UgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21lbWNoYXRWZXJzaW9uJyk/LmFmdGVyKHJvb3QpO1xuICAgIGV4dGVuc2lvblJlbmRlckNvbm5lY3Rpb25zKCk7XG4gICAgZXh0ZW5zaW9uQ2hlY2tQYW5lbChmYWxzZSk7XG59XG5mdW5jdGlvbiBleHRlbnNpb25DaGVja1BhbmVsKGZvcmNlKSB7XG4gICAgcmV0dXJuIGV4dGVuc2lvblBhbmVsQ3NyZigoKSA9PiB7fSwgKCkgPT4ge30sIGZvcmNlID09PSB0cnVlKTtcbn1cbmZ1bmN0aW9uIGV4dGVuc2lvbkNvbmZpZ3VyZU9yZGVycyhwbGF0Zm9ybSkge1xuICAgIHBsYXRmb3JtLm9uTWFpbkNyZWF0ZWQgPSBleHRlbnNpb25BdHRhY2hDb25uZWN0aW9ucztcbiAgICBwbGF0Zm9ybS5vbkFjY2Vzc1VpID0gZXh0ZW5zaW9uUmVuZGVyQ29ubmVjdGlvbnM7XG4gICAgZXh0ZW5zaW9uUGFuZWxTdGF0ZUxpc3RlbmVyID0gKHN0YXRlLCBlcnJvcikgPT4ge1xuICAgICAgICBleHRlbnNpb25Db25uZWN0aW9uU3RhdGUucGFuZWwgPSBzdGF0ZTtcbiAgICAgICAgZXh0ZW5zaW9uQ29ubmVjdGlvblN0YXRlLnBhbmVsRXJyb3IgPSBlcnJvciB8fCAnJztcbiAgICAgICAgZXh0ZW5zaW9uUmVuZGVyQ29ubmVjdGlvbnMoKTtcbiAgICB9O1xuICAgIHBsYXRmb3JtLm5vdGlmaWVyID0geyBzdGFydDogZXh0ZW5zaW9uTm90aWZpZXJTdGFydCwgc3RvcDogZXh0ZW5zaW9uTm90aWZpZXJTdG9wLCBwb2xsOiBleHRlbnNpb25Ob3RpZmllclBvbGwsXG4gICAgICAgIGluZGljYXRvcjogZXh0ZW5zaW9uTm90aWZpZXJFbnN1cmVJbmRpY2F0b3IsIGVkaXQ6ICgpID0+IHsgZXh0ZW5zaW9uT3JkZXJFZGl0ID0gdHJ1ZTsgfSB9O1xufVxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ29mZmxpbmUnLCBleHRlbnNpb25SZW5kZXJDb25uZWN0aW9ucyk7XG53aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcignb25saW5lJywgKCkgPT4geyBleHRlbnNpb25Db25uZWN0aW9uU3RhdGUucGFuZWwgPSAndW5rbm93bic7IGV4dGVuc2lvblJlbmRlckNvbm5lY3Rpb25zKCk7IH0pO1xuXG5mdW5jdGlvbiBleHRlbnNpb25Ob3RpZmllckVuc3VyZUluZGljYXRvcigpIHtcbiAgICBsZXQgaW5kaWNhdG9yID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2hhY2tlck5vdGlmaWVySW5kaWNhdG9yJyk7XG4gICAgY29uc3QgZW5hYmxlZCA9IGhhY2tlckFwaVZhbGlkYXRlZCAmJiBoYWNrZXJOb3RpZmllclNldHRpbmdzLmVuYWJsZWQgJiYgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggJiYgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGg7XG4gICAgaWYgKCFlbmFibGVkKSB7IGluZGljYXRvcj8ucmVtb3ZlKCk7IHJldHVybjsgfVxuICAgIGlmICghaW5kaWNhdG9yKSB7XG4gICAgICAgIGluZGljYXRvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTsgaW5kaWNhdG9yLmlkID0gJ2hhY2tlck5vdGlmaWVySW5kaWNhdG9yJzsgaW5kaWNhdG9yLnRleHRDb250ZW50ID0gJ/CfkLsnO1xuICAgICAgICBpbmRpY2F0b3IudGl0bGUgPSAn0J7Qv9GA0L7RgSDQt9Cw0LrQsNC30L7QsiDQstGL0L/QvtC70L3Rj9C10YLRgdGPINCyINGE0L7QvdC1INGA0LDRgdGI0LjRgNC10L3QuNGPJztcbiAgICAgICAgaW5kaWNhdG9yLnN0eWxlLmNzc1RleHQgPSAncG9zaXRpb246Zml4ZWQ7cmlnaHQ6MTRweDtib3R0b206MTJweDtvcGFjaXR5Oi4zNTtwb2ludGVyLWV2ZW50czpub25lOyc7IGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaW5kaWNhdG9yKTtcbiAgICB9XG59O1xuZnVuY3Rpb24gZXh0ZW5zaW9uTm90aWZpZXJTdG9wKCkge1xuICAgIGV4dGVuc2lvbk9yZGVyVG9rZW4gPSAnJztcbiAgICAvLyBUaGlzIGhvb2sgaXMgY2FsbGVkIGJlZm9yZSBhIGxvY2FsIGNyZWRlbnRpYWwgY2hhbmdlL2ZhaWxlZCB2YWxpZGF0aW9uLlxuICAgIC8vIFBhZ2VoaWRlIGRvZXMgbm90IHJldm9rZSB0aGUgd29ya2VyOiBjbG9zaW5nIGEgdGFiIG11c3Qgbm90IHN0b3AgcG9sbGluZy5cbiAgICBpZiAoaGFja2VyTm90aWZpZXJUaW1lcikgY2xlYXJJbnRlcnZhbChoYWNrZXJOb3RpZmllclRpbWVyKTtcbiAgICBoYWNrZXJOb3RpZmllclRpbWVyID0gbnVsbDtcbiAgICBjb25zdCB0b2tlbiA9IGhhY2tlckJlYXJlclRva2VuO1xuICAgIGlmICghdG9rZW4pIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBjb25zdCBwZW5kaW5nID0gZXh0ZW5zaW9uT3JkZXJTeW5jLnRoZW4oKCkgPT4gZXh0ZW5zaW9uTWVzc2FnZSh7IHR5cGU6ICdtZW1jaGF0Om9yZGVycy1zdG9wJywgdG9rZW4gfSkpXG4gICAgICAgIC50aGVuKHJlc3VsdCA9PiB7IGV4dGVuc2lvbk9yZGVyUmV2aXNpb24gPSByZXN1bHQucmV2aXNpb247IH0sICgpID0+IHt9KTtcbiAgICBleHRlbnNpb25PcmRlclN5bmMgPSBwZW5kaW5nO1xuICAgIHJldHVybiBwZW5kaW5nO1xufTtcbmZ1bmN0aW9uIGV4dGVuc2lvbk5vdGlmaWVyU3RhcnQoKSB7XG4gICAgaWYgKGhhY2tlck5vdGlmaWVyVGltZXIpIGNsZWFySW50ZXJ2YWwoaGFja2VyTm90aWZpZXJUaW1lcik7XG4gICAgaGFja2VyTm90aWZpZXJUaW1lciA9IG51bGw7XG4gICAgaWYgKCFoYWNrZXJBcGlWYWxpZGF0ZWQgfHwgIWhhY2tlckJlYXJlckVuYWJsZWQgfHwgIWhhY2tlckJlYXJlclRva2VuLnRyaW0oKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGNvbnN0IHVwZGF0ZSA9IGV4dGVuc2lvbk9yZGVyRWRpdDsgZXh0ZW5zaW9uT3JkZXJFZGl0ID0gZmFsc2U7XG4gICAgY29uc3QgcGF5bG9hZCA9IHsgdHlwZTogJ21lbWNoYXQ6b3JkZXJzLWNvbmZpZ3VyZScsIHRva2VuOiBoYWNrZXJCZWFyZXJUb2tlbiwgc2V0dGluZ3M6IHsgLi4uaGFja2VyTm90aWZpZXJTZXR0aW5ncyB9LFxuICAgICAgICBvcmdhbml6YXRpb25zOiBoYWNrZXJOb3RpZmllck9yZ2FuaXphdGlvbnMubWFwKGl0ZW0gPT4gKHsgaHJlZjogaXRlbS5ocmVmLCBuYW1lOiBpdGVtLm5hbWUgfSkpLCB1cGRhdGUgfTtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIGNvbnN0IHBlbmRpbmcgPSBleHRlbnNpb25PcmRlclN5bmMudGhlbigoKSA9PiBleHRlbnNpb25NZXNzYWdlKHsgLi4ucGF5bG9hZCwgcmV2aXNpb246IGV4dGVuc2lvbk9yZGVyUmV2aXNpb24gfSkpXG4gICAgICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uIHx8IHBheWxvYWQudG9rZW4gIT09IGhhY2tlckJlYXJlclRva2VuIHx8ICFoYWNrZXJBcGlWYWxpZGF0ZWQgfHwgIWhhY2tlckJlYXJlckVuYWJsZWQpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGV4dGVuc2lvbk9yZGVyUmV2aXNpb24gPSByZXN1bHQucmV2aXNpb247XG4gICAgICAgICAgICBleHRlbnNpb25PcmRlclRva2VuID0gcGF5bG9hZC50b2tlbjtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuc2V0dGluZ3MpIGhhY2tlck5vdGlmaWVyU2V0dGluZ3MgPSBoYWNrZXJOb3RpZmllck5vcm1hbGl6ZVNldHRpbmdzKHJlc3VsdC5zZXR0aW5ncyk7XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllclNhdmVTZXR0aW5ncygpOyBoYWNrZXJOb3RpZmllckZpbGxDb250cm9scygpOyBoYWNrZXJOb3RpZmllckVuc3VyZUluZGljYXRvcigpO1xuICAgICAgICAgICAgY29uc3QgcmVhZHkgPSBoYWNrZXJOb3RpZmllclNldHRpbmdzLmVuYWJsZWQgJiYgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5vcmdhbml6YXRpb25IcmVmcy5sZW5ndGggJiYgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zdGF0dXNIcmVmcy5sZW5ndGg7XG4gICAgICAgICAgICBoYWNrZXJOb3RpZmllclNldFN0YXR1cyghaGFja2VyTm90aWZpZXJTZXR0aW5ncy5lbmFibGVkID8gJ9Ce0L/QvtCy0LXRidCw0YLQtdC70Ywg0LLRi9C60LvRjtGH0LXQvSdcbiAgICAgICAgICAgICAgICA6IHJlYWR5ID8gJ9Cf0YDQvtCy0LXRgNGP0LXQvCDQt9Cw0LrQsNC30YvigKYnIDogJ9CS0YvQsdC10YDQuNGC0LUg0L7RgNCz0LDQvdC40LfQsNGG0LjRjiDQuCDRgdGC0LDRgtGD0YHRiyDQtNC70Y8g0L7Qv9C+0LLQtdGJ0LXQvdC40Y8nLCByZWFkeSA/ICdpbmZvJyA6ICd3YXJuJyk7XG4gICAgICAgICAgICByZXR1cm4gISFyZWFkeTtcbiAgICAgICAgfSkuY2F0Y2goZXJyb3IgPT4geyBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhlcnJvci5tZXNzYWdlLCAnZXJyb3InKTsgcmV0dXJuIGZhbHNlOyB9KTtcbiAgICAvLyBLZWVwIGNvbmZpZ3VyYXRpb24gc2VwYXJhdGUgZnJvbSB0aGUgcG9sbDogcG9sbCB3YWl0cyBmb3IgdGhpcyBjaGFpbi5cbiAgICBleHRlbnNpb25PcmRlclN5bmMgPSBwZW5kaW5nO1xuICAgIHJldHVybiBwZW5kaW5nLnRoZW4ocmVhZHkgPT4gcmVhZHkgPyBoYWNrZXJOb3RpZmllclBvbGwoKSA6IFtdKTtcbn07XG5hc3luYyBmdW5jdGlvbiBleHRlbnNpb25Ob3RpZmllclBvbGwoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZXh0ZW5zaW9uT3JkZXJTeW5jO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGV4dGVuc2lvbk1lc3NhZ2UoeyB0eXBlOiAnbWVtY2hhdDpvcmRlcnMtcG9sbCcsIHRva2VuOiBoYWNrZXJCZWFyZXJUb2tlbiB9KTtcbiAgICAgICAgLy8gUmVzdWx0cy90b2FzdHMgYXJlIGRlbGl2ZXJlZCB0byBvbmUgdGFiIGJ5IHRoZSB3b3JrZXIsIG5ldmVyIHBlciBjYWxsZXIuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHJlc3BvbnNlLnJlc3VsdDtcbiAgICAgICAgaGFja2VyTm90aWZpZXJTZXRTdGF0dXMocmVzdWx0LnBhcnRpYWwgPyAn4pqgINCd0LXQv9C+0LvQvdGL0Lkg0L7Qv9GA0L7RgTogJyArIHJlc3VsdC5mYWlsZWQuam9pbignLCAnKVxuICAgICAgICAgICAgOiBg0J/RgNC+0LLQtdGA0LXQvdC+OiAke25ldyBEYXRlKHJlc3VsdC5hdCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9IMK3INC30LDQutCw0LfQvtCyOiAke3Jlc3VsdC5vcmRlcnMubGVuZ3RofWAsIHJlc3VsdC5wYXJ0aWFsID8gJ2Vycm9yJyA6ICdvaycpO1xuICAgICAgICByZXR1cm4gcmVzdWx0Lm9yZGVycztcbiAgICB9IGNhdGNoIChlcnJvcikgeyBoYWNrZXJOb3RpZmllclNldFN0YXR1cyhlcnJvci5tZXNzYWdlLCAnZXJyb3InKTsgcmV0dXJuIFtdOyB9XG59O1xuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHJlc3BvbmQpID0+IHtcbiAgICBpZiAoc2VuZGVyLmlkICE9PSBjaHJvbWUucnVudGltZS5pZCB8fCBzZW5kZXIudGFiIHx8IChzZW5kZXIudXJsICYmIHNlbmRlci51cmwgIT09IGNocm9tZS5ydW50aW1lLmdldFVSTCgnd29ya2VyLmpzJykpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgIT09ICdtZW1jaGF0Om9yZGVycy1yZXN1bHQnKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCFoYWNrZXJBcGlWYWxpZGF0ZWQgfHwgIWhhY2tlckJlYXJlckVuYWJsZWQgfHwgZXh0ZW5zaW9uT3JkZXJUb2tlbiAhPT0gaGFja2VyQmVhcmVyVG9rZW4gfHwgbWVzc2FnZS5yZXZpc2lvbiAhPT0gZXh0ZW5zaW9uT3JkZXJSZXZpc2lvbikgeyByZXNwb25kKHsgb2s6IGZhbHNlIH0pOyByZXR1cm4gZmFsc2U7IH1cbiAgICBjb25zdCByZXN1bHQgPSBtZXNzYWdlLnJlc3VsdDtcbiAgICBpZiAoIXJlc3VsdCB8fCAhQXJyYXkuaXNBcnJheShyZXN1bHQub3JkZXJzKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChleHRlbnNpb25PcmRlckxhc3RTaG93biAhPT0gcmVzdWx0LmlkKSB7XG4gICAgICAgIGV4dGVuc2lvbk9yZGVyTGFzdFNob3duID0gcmVzdWx0LmlkO1xuICAgICAgICBpZiAobWVzc2FnZS5zZXR0aW5ncykgaGFja2VyTm90aWZpZXJTZXR0aW5ncyA9IGhhY2tlck5vdGlmaWVyTm9ybWFsaXplU2V0dGluZ3MobWVzc2FnZS5zZXR0aW5ncyk7XG4gICAgICAgIGlmIChyZXN1bHQuYmVhcmVyID09PSAnZXJyb3InKSB7IGhhY2tlckFwaVZhbGlkYXRlZCA9IGZhbHNlOyBoYWNrZXJTeW5jQWNjZXNzVWkoKTsgfVxuICAgICAgICByZXN1bHQub3JkZXJzLmZvckVhY2goaGFja2VyTm90aWZpZXJTaG93VG9hc3QpO1xuICAgICAgICBpZiAocmVzdWx0Lm9yZGVycy5sZW5ndGggJiYgaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zb3VuZEVuYWJsZWQpIGhhY2tlck5vdGlmaWVyUGxheUFsYXJtKCk7XG4gICAgICAgIGhhY2tlck5vdGlmaWVyU2V0U3RhdHVzKHJlc3VsdC5wYXJ0aWFsID8gJ+KaoCDQndC10L/QvtC70L3Ri9C5INC+0L/RgNC+0YE6ICcgKyByZXN1bHQuZmFpbGVkLmpvaW4oJywgJylcbiAgICAgICAgICAgIDogYNCf0YDQvtCy0LXRgNC10L3QvjogJHtuZXcgRGF0ZShyZXN1bHQuYXQpLnRvTG9jYWxlVGltZVN0cmluZygpfSDCtyDQt9Cw0LrQsNC30L7QsjogJHtyZXN1bHQub3JkZXJzLmxlbmd0aH1gLCByZXN1bHQucGFydGlhbCA/ICdlcnJvcicgOiAnb2snKTtcbiAgICAgICAgaGFja2VyTm90aWZpZXJFbnN1cmVJbmRpY2F0b3IoKTtcbiAgICB9XG4gICAgcmVzcG9uZCh7IG9rOiB0cnVlIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbn0pO1xuZXh0ZW5zaW9uQ29uZmlndXJlT3JkZXJzKG1lbWNoYXRQbGF0Zm9ybSk7XG4iLCIvLyBFeHRlbnNpb24tb25seSByZWFkIGRpYWdub3N0aWNzLiBObyB3cml0ZXMsIHJlc3BvbnNlIHBlcnNpc3RlbmNlIG9yIGNyZWRlbnRpYWwgb3V0cHV0LlxuY29uc3QgZXh0ZW5zaW9uRGlhZ25vc3RpY1ByZXNldHMgPSBbXG4gICAgWyfQl9Cw0LrQsNC30Ysg0L/QvtC60YPQv9Cw0YLQtdC70LXQuScsICcvZW50aXR5L2N1c3RvbWVyb3JkZXI/bGltaXQ9MSZleHBhbmQ9c3RhdGUsb3JnYW5pemF0aW9uJ10sXG4gICAgWyfQodGC0LDRgtGD0YHRiyDQt9Cw0LrQsNC30L7QsicsICcvZW50aXR5L2N1c3RvbWVyb3JkZXIvbWV0YWRhdGEnXSxcbiAgICBbJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40LgnLCAnL2VudGl0eS9vcmdhbml6YXRpb24/bGltaXQ9MTAnXSxcbiAgICBbJ9Ch0LrQu9Cw0LTRiycsICcvZW50aXR5L3N0b3JlP2xpbWl0PTEwJ10sXG4gICAgWyfQotC+0LLQsNGA0YsnLCAnL2VudGl0eS9wcm9kdWN0P2xpbWl0PTEnXSxcbiAgICBbJ9Ca0L7QvdGC0YDQsNCz0LXQvdGC0YsnLCAnL2VudGl0eS9jb3VudGVycGFydHk/bGltaXQ9MSddLFxuICAgIFsn0KHQstC+0LkgR0VULdC30LDQv9GA0L7RgScsICcnXVxuXTtcbmNvbnN0IGV4dGVuc2lvbkRpYWdub3N0aWNTZWNyZXRLZXkgPSAvdG9rZW58cGFzc3dvcmR8c2VjcmV0fGF1dGhvcml6YXRpb258Y3JlZGVudGlhbHxjb29raWV8YXBpLj9rZXl8c2Vzc2lvbi9pO1xuZnVuY3Rpb24gZXh0ZW5zaW9uRGlhZ25vc3RpY1BhdGgocmF3KSB7XG4gICAgY29uc3QgdmFsdWUgPSBTdHJpbmcocmF3IHx8ICcnKS50cmltKCk7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTCh2YWx1ZS5zdGFydHNXaXRoKCcvJykgPyBNU19BUElfQkFTRSArIHZhbHVlIDogdmFsdWUsIE1TX0FQSV9CQVNFICsgJy8nKTtcbiAgICBjb25zdCBwYXRoID0gaGFja2VyQXBpUGF0aCh2YWx1ZSk7XG4gICAgaWYgKCFwYXRoIHx8ICEvXlxcLyhlbnRpdHl8cmVwb3J0KVxcLy8udGVzdChwYXRoKSB8fCB1cmwudXNlcm5hbWUgfHwgdXJsLnBhc3N3b3JkIHx8IHVybC5oYXNoKSB0aHJvdyBFcnJvcign0JTQvtGB0YLRg9C/0L3RiyDRgtC+0LvRjNC60L4gR0VUIGVudGl0eS9yZXBvcnQgQVBJINCc0L7QudCh0LrQu9Cw0LQg0LHQtdC3INGD0YfRkdGC0L3Ri9GFINC00LDQvdC90YvRhSDQsiDQsNC00YDQtdGB0LUnKTtcbiAgICBpZiAoWy4uLnVybC5zZWFyY2hQYXJhbXMua2V5cygpXS5zb21lKGtleSA9PiBleHRlbnNpb25EaWFnbm9zdGljU2VjcmV0S2V5LnRlc3Qoa2V5KSlcbiAgICAgICAgfHwgKGhhY2tlckJlYXJlclRva2VuICYmIHZhbHVlLmluY2x1ZGVzKGhhY2tlckJlYXJlclRva2VuKSkpIHRocm93IEVycm9yKCfQndC1INC00L7QsdCw0LLQu9GP0LnRgtC1INGB0LXQutGA0LXRgtGLINCyINCw0LTRgNC10YEg0LfQsNC/0YDQvtGB0LAnKTtcbiAgICByZXR1cm4gcGF0aDtcbn1cbmZ1bmN0aW9uIGV4dGVuc2lvbkRpYWdub3N0aWNUZXh0KHZhbHVlLCB0b2tlbiA9IGhhY2tlckJlYXJlclRva2VuKSB7XG4gICAgY29uc3QgY2xlYW4gPSB0ZXh0ID0+IHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHRva2VuID8gU3RyaW5nKHRleHQpLnNwbGl0KHRva2VuKS5qb2luKCdbUkVEQUNURURdJykgOiBTdHJpbmcodGV4dCk7XG4gICAgICAgIHJldHVybiByZXN1bHQucmVwbGFjZSgvQmVhcmVyXFxzK1teXFxzXCInPD5dKy9naSwgJ0JlYXJlciBbUkVEQUNURURdJylcbiAgICAgICAgICAgIC5yZXBsYWNlKC8oWz8mXSg/OmFjY2Vzc190b2tlbnx0b2tlbnxhcGlfP2tleXxwYXNzd29yZHxzZWNyZXQpPSlbXiYjXFxzXCInXSovZ2ksICckMVtSRURBQ1RFRF0nKTtcbiAgICB9O1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSByZXR1cm4gY2xlYW4odmFsdWUpO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSwgKGtleSwgaXRlbSkgPT4ga2V5ID09PSAnX3N0YXR1cycgPyB1bmRlZmluZWRcbiAgICAgICAgOiBleHRlbnNpb25EaWFnbm9zdGljU2VjcmV0S2V5LnRlc3Qoa2V5KSA/ICdbUkVEQUNURURdJyA6IHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJyA/IGNsZWFuKGl0ZW0pIDogaXRlbSwgMik7XG59XG5hc3luYyBmdW5jdGlvbiBleHRlbnNpb25SdW5EaWFnbm9zdGljKHJhdywgcmVzdWx0LCBidXR0b24pIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uLCB0b2tlbiA9IGhhY2tlckJlYXJlclRva2VuLCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgICBidXR0b24uZGlzYWJsZWQgPSB0cnVlOyByZXN1bHQudGV4dENvbnRlbnQgPSAn0JLRi9C/0L7Qu9C90Y/QtdGC0YHRjyBHRVTigKYnO1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBleHRlbnNpb25EaWFnbm9zdGljUGF0aChyYXcpO1xuICAgICAgICBjb25zdCBkYXRhID0gYXdhaXQgbXNBcGlQKCdHRVQnLCBwYXRoKTtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gIT09IG1zQXBpR2VuZXJhdGlvbiB8fCB0b2tlbiAhPT0gaGFja2VyQmVhcmVyVG9rZW4gfHwgIXJlc3VsdC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBib2R5ID0gZXh0ZW5zaW9uRGlhZ25vc3RpY1RleHQoZGF0YSwgdG9rZW4pIHx8ICfQn9GD0YHRgtC+0Lkg0L7RgtCy0LXRgic7XG4gICAgICAgIHJlc3VsdC50ZXh0Q29udGVudCA9IGV4dGVuc2lvbkRpYWdub3N0aWNUZXh0KGBHRVQgJHtwYXRofVxcbkhUVFAgJHtkYXRhPy5fc3RhdHVzIHx8ICcyeHggKNC/0YPRgdGC0L7QuS/QvdC1IEpTT04pJ30gwrcgJHtEYXRlLm5vdygpIC0gc3RhcnRlZH0g0LzRgVxcbmBcbiAgICAgICAgICAgICsgYNCh0YLRgNC+0Lo6ICR7QXJyYXkuaXNBcnJheShkYXRhPy5yb3dzKSA/IGRhdGEucm93cy5sZW5ndGggOiAn0L3QtSDRgdC/0LjRgdC+0LonfSDCtyDQktGB0LXQs9C+OiAke2RhdGE/Lm1ldGE/LnNpemUgPz8gJ9C90LUg0YPQutCw0LfQsNC90L4nfVxcblxcbmBcbiAgICAgICAgICAgICsgYm9keS5zbGljZSgwLCA4MDAwMCkgKyAoYm9keS5sZW5ndGggPiA4MDAwMCA/ICdcXG5b0J/QvtC60LDQt9Cw0L3RiyDQv9C10YDQstGL0LUgODAgMDAwINGB0LjQvNCy0L7Qu9C+0LJdJyA6ICcnKSwgdG9rZW4pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChnZW5lcmF0aW9uICE9PSBtc0FwaUdlbmVyYXRpb24gfHwgdG9rZW4gIT09IGhhY2tlckJlYXJlclRva2VuIHx8ICFyZXN1bHQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgICAgcmVzdWx0LnRleHRDb250ZW50ID0gZXh0ZW5zaW9uRGlhZ25vc3RpY1RleHQoYCR7ZXJyb3Iuc3RhdHVzID8gJ0hUVFAgJyArIGVycm9yLnN0YXR1cyA6ICfQndC10YIgSFRUUC3QvtGC0LLQtdGC0LAnfSDCtyAke0RhdGUubm93KCkgLSBzdGFydGVkfSDQvNGBXFxuJHtlcnJvci5hcGlDb2RlID8gJ9Ca0L7QtCBBUEk6ICcgKyBlcnJvci5hcGlDb2RlICsgJ1xcbicgOiAnJ30ke2Vycm9yLm1lc3NhZ2UgfHwgJ9Ce0YjQuNCx0LrQsCDQt9Cw0L/RgNC+0YHQsCd9YCwgdG9rZW4pO1xuICAgIH0gZmluYWxseSB7IGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlOyB9XG59XG5hc3luYyBmdW5jdGlvbiBleHRlbnNpb25SdW5PcmRlckRpYWdub3N0aWMocmVzdWx0LCBidXR0b24pIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uLCB0b2tlbiA9IGhhY2tlckJlYXJlclRva2VuO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7IHJlc3VsdC50ZXh0Q29udGVudCA9ICfQntC/0YDQsNGI0LjQstCw0LXQvCDQstGL0LHRgNCw0L3QvdGL0LUg0L7RgNCz0LDQvdC40LfQsNGG0LjQuCDQuCDRgdGC0LDRgtGD0YHRi+KApic7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZXh0ZW5zaW9uT3JkZXJTeW5jO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGV4dGVuc2lvbk1lc3NhZ2UoeyB0eXBlOiAnbWVtY2hhdDpvcmRlcnMtcG9sbCcsIHRva2VuIH0pO1xuICAgICAgICBpZiAoZ2VuZXJhdGlvbiAhPT0gbXNBcGlHZW5lcmF0aW9uIHx8IHRva2VuICE9PSBoYWNrZXJCZWFyZXJUb2tlbiB8fCAhcmVzdWx0LmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgIGNvbnN0IGRhdGEgPSByZXNwb25zZS5yZXN1bHQ7XG4gICAgICAgIHJlc3VsdC50ZXh0Q29udGVudCA9IGV4dGVuc2lvbkRpYWdub3N0aWNUZXh0KGDQntC/0L7QstC10YnQsNGC0LXQu9GMOiAke2RhdGEucGFydGlhbCA/ICfQndCV0J/QntCb0J3Qq9CZINCe0J/QoNCe0KEnIDogJ9C+0L/RgNC+0YEg0LfQsNCy0LXRgNGI0ZHQvSd9XFxuYFxuICAgICAgICAgICAgKyBg0J/RgNC+0LLQtdGA0LXQvdC+OiAke25ldyBEYXRlKGRhdGEuYXQpLnRvTG9jYWxlVGltZVN0cmluZygpfVxcbtCX0LDQutCw0LfQvtCyOiAke2RhdGEub3JkZXJzLmxlbmd0aH1cXG5CZWFyZXI6ICR7ZGF0YS5iZWFyZXJ9XFxuYFxuICAgICAgICAgICAgKyAoZGF0YS5mYWlsZWQubGVuZ3RoID8gJ9Ce0YjQuNCx0LrQuDogJyArIGRhdGEuZmFpbGVkLmpvaW4oJzsgJykgOiAn0J7RiNC40LHQvtC6IEFQSSDQv9GA0Lgg0L7Qv9GA0L7RgdC1INC90LXRgicpLCB0b2tlbik7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKGdlbmVyYXRpb24gPT09IG1zQXBpR2VuZXJhdGlvbiAmJiB0b2tlbiA9PT0gaGFja2VyQmVhcmVyVG9rZW4gJiYgcmVzdWx0LmlzQ29ubmVjdGVkKSByZXN1bHQudGV4dENvbnRlbnQgPSBleHRlbnNpb25EaWFnbm9zdGljVGV4dChlcnJvci5tZXNzYWdlLCB0b2tlbik7XG4gICAgfSBmaW5hbGx5IHsgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7IH1cbn1cbmZ1bmN0aW9uIGV4dGVuc2lvbkJ1aWxkRGlhZ25vc3RpY3MoKSB7XG4gICAgY29uc3Qgcm9vdCA9IGhhY2tlckVsKCdkaXYnLCAnZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6N3B4O3BhZGRpbmctdG9wOjhweDsnKTtcbiAgICByb290LmFwcGVuZENoaWxkKGhhY2tlckVsKCdkaXYnLCAnZm9udC1zaXplOjExcHg7Y29sb3I6IzQ3NTU2OTsnLCAn0KLQvtC70YzQutC+INGH0YLQtdC90LjQtSAoR0VUKS4g0JrQu9GO0Ycg0LHQtdGA0ZHRgtGB0Y8g0LjQtyDQvdCw0YHRgtGA0L7QtdC6LCDQvdC1INCy0YvQstC+0LTQuNGC0YHRjyDQuCDQvdC1INCy0LrQu9GO0YfQsNC10YLRgdGPINCyINCw0LTRgNC10YEuINCe0YLQstC10YIg0L3QtSDRgdC+0YXRgNCw0L3Rj9C10YLRgdGPLicpKTtcbiAgICBjb25zdCBwcmVzZXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTsgcHJlc2V0LmlkID0gJ2hhY2tlckFwaURpYWdub3N0aWNQcmVzZXQnO1xuICAgIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTsgaW5wdXQuaWQgPSAnaGFja2VyQXBpRGlhZ25vc3RpY1BhdGgnOyBpbnB1dC50eXBlID0gJ3RleHQnO1xuICAgIGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBleHRlbnNpb25EaWFnbm9zdGljUHJlc2V0cykgeyBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTsgb3B0aW9uLnRleHRDb250ZW50ID0gbmFtZTsgb3B0aW9uLnZhbHVlID0gdmFsdWU7IHByZXNldC5hcHBlbmRDaGlsZChvcHRpb24pOyB9XG4gICAgaW5wdXQudmFsdWUgPSBleHRlbnNpb25EaWFnbm9zdGljUHJlc2V0c1swXVsxXTsgaW5wdXQuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgJ9Cf0YPRgtGMIEdFVC3Qt9Cw0L/RgNC+0YHQsCDQnNC+0LnQodC60LvQsNC0Jyk7XG4gICAgZm9yIChjb25zdCBlbCBvZiBbcHJlc2V0LCBpbnB1dF0pIGVsLnN0eWxlLmNzc1RleHQgPSAnYm94LXNpemluZzpib3JkZXItYm94O3dpZHRoOjEwMCU7cGFkZGluZzo3cHg7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2ZvbnQ6MTFweCBTZWdvZSBVSSxzYW5zLXNlcmlmOyc7XG4gICAgcHJlc2V0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHsgaW5wdXQudmFsdWUgPSBwcmVzZXQudmFsdWUgfHwgJy9lbnRpdHkvY3VzdG9tZXJvcmRlcj9saW1pdD0xJzsgfSk7XG4gICAgY29uc3QgcnVuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7IHJ1bi50eXBlID0gJ2J1dHRvbic7IHJ1bi5pZCA9ICdoYWNrZXJBcGlEaWFnbm9zdGljUnVuJzsgcnVuLnRleHRDb250ZW50ID0gJ9CS0YvQv9C+0LvQvdC40YLRjCBHRVQnO1xuICAgIGNvbnN0IHBvbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgcG9sbC50eXBlID0gJ2J1dHRvbic7IHBvbGwuaWQgPSAnaGFja2VyQXBpRGlhZ25vc3RpY1BvbGwnOyBwb2xsLnRleHRDb250ZW50ID0gJ9Cf0YDQvtCy0LXRgNC40YLRjCDQvtC/0L7QstC10YnQsNGC0LXQu9GMINGB0LXQudGH0LDRgSc7XG4gICAgY29uc3QgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsgdG9hc3QudHlwZSA9ICdidXR0b24nOyB0b2FzdC5pZCA9ICdoYWNrZXJBcGlEaWFnbm9zdGljVG9hc3QnOyB0b2FzdC50ZXh0Q29udGVudCA9ICfQotC10YHRgiDRg9Cy0LXQtNC+0LzQu9C10L3QuNGPJztcbiAgICBjb25zdCByZXN1bHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwcmUnKTsgcmVzdWx0LmlkID0gJ2hhY2tlckFwaURpYWdub3N0aWNSZXN1bHQnOyByZXN1bHQuc2V0QXR0cmlidXRlKCdhcmlhLWxpdmUnLCAncG9saXRlJyk7XG4gICAgcmVzdWx0LnN0eWxlLmNzc1RleHQgPSAnd2hpdGUtc3BhY2U6cHJlLXdyYXA7b3ZlcmZsb3ctd3JhcDphbnl3aGVyZTttYXgtaGVpZ2h0OjI3MHB4O292ZXJmbG93OmF1dG87bWFyZ2luOjA7cGFkZGluZzo4cHg7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojMGYxNzJhO2NvbG9yOiNlMmU4ZjA7Zm9udDoxMHB4LzEuNCBDb25zb2xhcyxtb25vc3BhY2U7JztcbiAgICByZXN1bHQudGV4dENvbnRlbnQgPSAn0JLRi9Cx0LXRgNC40YLQtSDQs9C+0YLQvtCy0YvQuSDQt9Cw0L/RgNC+0YEg0LjQu9C4INGD0LrQsNC20LjRgtC1IC9lbnRpdHkv4oCmP2xpbWl0PTEuINCU0LvRjyDRgtC+0YfQvdC+0LPQviDRhNC40LvRjNGC0YDQsCDQvtC/0L7QstC10YnQsNGC0LXQu9GPINC40YHQv9C+0LvRjNC30YPQudGC0LUg0L7RgtC00LXQu9GM0L3Rg9GOINC60L3QvtC/0LrRgy4nO1xuICAgIGZvciAoY29uc3QgYnV0dG9uIG9mIFtydW4sIHBvbGwsIHRvYXN0XSkgYnV0dG9uLnN0eWxlLmNzc1RleHQgPSAncGFkZGluZzo3cHg7Ym9yZGVyOjFweCBzb2xpZCAjY2JkNWUxO2JvcmRlci1yYWRpdXM6N3B4O2N1cnNvcjpwb2ludGVyO2ZvbnQ6MTFweCBTZWdvZSBVSSxzYW5zLXNlcmlmOyc7XG4gICAgcnVuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gZXh0ZW5zaW9uUnVuRGlhZ25vc3RpYyhpbnB1dC52YWx1ZSwgcmVzdWx0LCBydW4pKTtcbiAgICBwb2xsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gZXh0ZW5zaW9uUnVuT3JkZXJEaWFnbm9zdGljKHJlc3VsdCwgcG9sbCkpO1xuICAgIHRvYXN0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICBoYWNrZXJOb3RpZmllclNob3dUb2FzdCh7IG5hbWU6ICfQotCV0KHQoiDigJQg0L3QtSDRgNC10LDQu9GM0L3Ri9C5INC30LDQutCw0LcnLCBzdGF0ZU5hbWU6ICfQn9GA0L7QstC10YDQutCwINC+0YLQvtCx0YDQsNC20LXQvdC40Y8nLCBvcmdhbml6YXRpb25OYW1lOiAn0KLQtdGB0YIg0YDQsNGB0YjQuNGA0LXQvdC40Y8nIH0pO1xuICAgICAgICBpZiAoaGFja2VyTm90aWZpZXJTZXR0aW5ncy5zb3VuZEVuYWJsZWQpIGhhY2tlck5vdGlmaWVyUGxheUFsYXJtKCk7XG4gICAgfSk7XG4gICAgcm9vdC5hcHBlbmQocHJlc2V0LCBpbnB1dCwgcnVuLCBwb2xsLCB0b2FzdCwgcmVzdWx0KTtcbiAgICByZXR1cm4gcm9vdDtcbn1cbi8vIFByb2R1Y3QgY29tcGFyaXNvbiBpcyBhYnNlbnQgZnJvbSB0aGlzIHBhY2thZ2UuIE9ubHkgbm90aWZpZXIgcmVmZXJlbmNlcyBhcmUgYm9vdHN0cmFwcGVkLlxuZnVuY3Rpb24gZXh0ZW5zaW9uUmVmZXJlbmNlU2hvd1N0YXR1cyhzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnaGFja2VyQXBpUmVmZXJlbmNlU3RhdHVzJykpIHtcbiAgICBjb25zdCBsYWJlbHMgPSB7IG9yZ2FuaXphdGlvbjogJ9Ce0YDQs9Cw0L3QuNC30LDRhtC40LgnLCBjdXN0b21lcm9yZGVyOiAn0KHRgtCw0YLRg9GB0Ysg0LfQsNC60LDQt9C+0LInIH07XG4gICAgY29uc3QgZXJyb3JzID0gT2JqZWN0LmVudHJpZXMobXNSZWZlcmVuY2VDYWNoZS5lcnJvcnMgfHwge30pLmZpbHRlcigoW2tpbmRdKSA9PiBPYmplY3QuaGFzT3duKGxhYmVscywga2luZCkpO1xuICAgIGNvbnN0IG1pc3NpbmcgPSBPYmplY3Qua2V5cyhsYWJlbHMpLmZpbHRlcihraW5kID0+ICFPYmplY3QuaGFzT3duKG1zUmVmZXJlbmNlQ2FjaGUubGlzdHMsIGtpbmQpKTtcbiAgICBjb25zdCB0ZXh0ID0gZXJyb3JzLmxlbmd0aCA/IGVycm9ycy5tYXAoKFtraW5kLCBtZXNzYWdlXSkgPT4gYCR7bGFiZWxzW2tpbmRdfSDigJQgJHttZXNzYWdlfWApLmpvaW4oJzsgJylcbiAgICAgICAgOiBtaXNzaW5nLmxlbmd0aCA/ICfQndC1INC30LDQs9GA0YPQttC10L3RizogJyArIG1pc3NpbmcubWFwKGtpbmQgPT4gbGFiZWxzW2tpbmRdKS5qb2luKCcsICcpIDogJ9Ch0L/RgNCw0LLQvtGH0L3QuNC60Lgg0L7Qv9C+0LLQtdGJ0LDRgtC10LvRjyDQt9Cw0LPRgNGD0LbQtdC90YsnO1xuICAgIGlmIChzdGF0dXMpIHsgc3RhdHVzLnRleHRDb250ZW50ID0gdGV4dDsgc3RhdHVzLnN0eWxlLmNvbG9yID0gZXJyb3JzLmxlbmd0aCB8fCBtaXNzaW5nLmxlbmd0aCA/ICcjYjkxYzFjJyA6ICcjMTY2NTM0JzsgfVxuICAgIGlmIChlcnJvcnMubGVuZ3RoKSBoYWNrZXJOb3RpZmllclNldFN0YXR1cyh0ZXh0LCAnZXJyb3InKTtcbn07XG5hc3luYyBmdW5jdGlvbiBleHRlbnNpb25SZWZlcmVuY2VSZWZyZXNoKHsgZm9yY2UgPSBmYWxzZSwgc3RhdGVzLCBzdGF0dXMgfSA9IHt9KSB7XG4gICAgY29uc3Qgc2NvcGUgPSBtc1JlZmVyZW5jZVNjb3BlLCBnZW5lcmF0aW9uID0gbXNBcGlHZW5lcmF0aW9uO1xuICAgIGNvbnN0IGtpbmRzID0gWydvcmdhbml6YXRpb24nLCAnY3VzdG9tZXJvcmRlciddO1xuICAgIG1zUmVmZXJlbmNlQ2FjaGUuYXR0ZW1wdGVkID0gdHJ1ZTtcbiAgICBjb25zdCBvdXRjb21lcyA9IGF3YWl0IFByb21pc2UuYWxsU2V0dGxlZChraW5kcy5tYXAoa2luZCA9PiBtc1JlZmVyZW5jZUxvYWQoa2luZCxcbiAgICAgICAgeyBmb3JjZSwgc2VlZDoga2luZCA9PT0gJ2N1c3RvbWVyb3JkZXInID8gc3RhdGVzIDogdW5kZWZpbmVkIH0pKSk7XG4gICAgbXNSZWZlcmVuY2VBc3NlcnRDdXJyZW50KHNjb3BlLCBnZW5lcmF0aW9uKTtcbiAgICBtc1JlZmVyZW5jZUNhY2hlLmVycm9ycyA9IE9iamVjdC5mcm9tRW50cmllcyhvdXRjb21lcy5mbGF0TWFwKChvdXRjb21lLCBpbmRleCkgPT4gb3V0Y29tZS5zdGF0dXMgPT09ICdyZWplY3RlZCdcbiAgICAgICAgPyBbW2tpbmRzW2luZGV4XSwgb3V0Y29tZS5yZWFzb24uc3RhdHVzID8gYEhUVFAgJHtvdXRjb21lLnJlYXNvbi5zdGF0dXN9YCA6ICfQvtGI0LjQsdC60LAg0LfQsNCz0YDRg9C30LrQuDsg0L/QvtCy0YLQvtGA0LjRgtC1INCy0YDRg9GH0L3Rg9GOJ11dIDogW10pKTtcbiAgICBtc1JlZmVyZW5jZVNhdmUoKTsgbXNSZWZlcmVuY2VTaG93U3RhdHVzKHN0YXR1cyk7XG4gICAgcmV0dXJuIHsgb2s6IE9iamVjdC5rZXlzKG1zUmVmZXJlbmNlQ2FjaGUuZXJyb3JzKS5sZW5ndGggPT09IDAsIGVycm9yczogbXNSZWZlcmVuY2VDYWNoZS5lcnJvcnMgfTtcbn07XG5mdW5jdGlvbiBleHRlbnNpb25DbGVhblNldHRpbmdzKCkge1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1NldHRpbmdzVGFiSW50ZXJuYWxPcmRlckNoZWNrJyk/LnJlbW92ZSgpO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtY1NldHRpbmdzSW50ZXJuYWxPcmRlckNoZWNrUGFuZScpPy5yZW1vdmUoKTtcbn1cbmZ1bmN0aW9uIGV4dGVuc2lvblNlbGVjdERpYWdub3N0aWMoa2V5KSB7XG4gICAgY29uc3Qgb2xkID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtaGFja2VyLXRhYj1cImludGVybmFsT3JkZXJDaGVja1wiXScpO1xuICAgIGlmIChvbGQpIHsgb2xkLmRhdGFzZXQuaGFja2VyVGFiID0gJ3JlcXVlc3RzJzsgb2xkLnRleHRDb250ZW50ID0gJ9Cf0YDQvtCy0LXRgNC60LAg0LfQsNC/0YDQvtGB0L7Qsic7IH1cbiAgICBpZiAoa2V5ID09PSAnaW50ZXJuYWxPcmRlckNoZWNrJykga2V5ID0gJ3JlcXVlc3RzJztcbiAgICBpZiAoa2V5ICE9PSAncmVxdWVzdHMnKSByZXR1cm4gZmFsc2U7XG4gICAgaGFja2VyVGFiID0ga2V5O1xuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyNoYWNrZXJUYWJzIFtkYXRhLWhhY2tlci10YWJdJykuZm9yRWFjaChidXR0b24gPT4ge1xuICAgICAgICBjb25zdCBhY3RpdmUgPSBidXR0b24uZGF0YXNldC5oYWNrZXJUYWIgPT09IGtleTtcbiAgICAgICAgYnV0dG9uLnN0eWxlLmJhY2tncm91bmQgPSBhY3RpdmUgPyAnbGluZWFyLWdyYWRpZW50KDEzNWRlZywjNjM2NmYxLCM4YjVjZjYpJyA6ICcjZjhmYWZjJztcbiAgICAgICAgYnV0dG9uLnN0eWxlLmNvbG9yID0gYWN0aXZlID8gJyNmZmYnIDogJyM0NzU1NjknOyBidXR0b24uc3R5bGUuYm9yZGVyQ29sb3IgPSBhY3RpdmUgPyAndHJhbnNwYXJlbnQnIDogJyNlMmU4ZjAnO1xuICAgIH0pO1xuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYWNrZXJUYWJQYW5lcycpPy5yZXBsYWNlQ2hpbGRyZW4oZXh0ZW5zaW9uQnVpbGREaWFnbm9zdGljcygpKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn07XG5cbmZ1bmN0aW9uIGV4dGVuc2lvbkNvbmZpZ3VyZURpYWdub3N0aWNzKHBsYXRmb3JtKSB7XG4gICAgcGxhdGZvcm0ucmVmZXJlbmNlcyA9IHsgcmVmcmVzaDogZXh0ZW5zaW9uUmVmZXJlbmNlUmVmcmVzaCwgc2hvd1N0YXR1czogZXh0ZW5zaW9uUmVmZXJlbmNlU2hvd1N0YXR1cyB9O1xuICAgIHBsYXRmb3JtLmRpYWdub3N0aWNzID0geyBzZWxlY3Q6IGV4dGVuc2lvblNlbGVjdERpYWdub3N0aWMsIGNsZWFuU2V0dGluZ3M6IGV4dGVuc2lvbkNsZWFuU2V0dGluZ3MgfTtcbn1cbmV4dGVuc2lvbkNvbmZpZ3VyZURpYWdub3N0aWNzKG1lbWNoYXRQbGF0Zm9ybSk7XG4iLCIvKiBFeHRlbnNpb24tb25seSBNZW1jaGF0IFVJIHByb21vdGlvbi4gSW5jbHVkZSBhZnRlciB0aGUgcHJvZHVjdGlvbiB1c2Vyc2NyaXB0IGJvZHkuICovXG4oKCkgPT4ge1xuICAgICd1c2Ugc3RyaWN0JztcbiAgICBpZiAoIWRvY3VtZW50LmJvZHkgfHwgdHlwZW9mIGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpLnNob3dQb3BvdmVyICE9PSAnZnVuY3Rpb24nIHx8IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLW1lbWNoYXQtdG9wLWxheWVyXScpKSByZXR1cm47XG5cbiAgICBjb25zdCBST09UX1NFTEVDVE9SID0gW1xuICAgICAgICAnI3ByaWNlQ2hlY2tDb250YWluZXInLCAnLm1jLWZsb2F0LXdpbmRvdycsICcubWMtb3ZlcmxheScsICcjaGF0aWtvUHJvZHVjdFBpY2tlcicsXG4gICAgICAgICcjbWNIYWNrZXJRdWlja1BvcHVwJywgJyNtY0hhY2tlckFnZW50UG9wdXAnLCAnI21jSGFja2VyRmxvYXRpbmdMb2cnLCAnI21jTXNUb2FzdCcsXG4gICAgICAgICcjbWNPcmRlclN0YXR1c1BvcHVwJywgJyNtY01hZ2ljUG9wdXAnLCAnI2hhY2tlck5vdGlmaWVyVG9hc3RIb3N0J1xuICAgIF0uam9pbignLCcpO1xuICAgIGNvbnN0IGhvc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBob3N0LnNldEF0dHJpYnV0ZSgnZGF0YS1tZW1jaGF0LXRvcC1sYXllcicsICcnKTtcbiAgICBob3N0LnNldEF0dHJpYnV0ZSgncG9wb3ZlcicsICdtYW51YWwnKTtcbiAgICBob3N0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsICdNZW1jaGF0Jyk7XG4gICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xuICAgIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgICAgW2RhdGEtbWVtY2hhdC10b3AtbGF5ZXJdIHsgcG9zaXRpb246Zml4ZWQgIWltcG9ydGFudDsgaW5zZXQ6MCAhaW1wb3J0YW50OyB6LWluZGV4OjIxNDc0ODM2NDcgIWltcG9ydGFudDsgbWFyZ2luOjAgIWltcG9ydGFudDsgcGFkZGluZzowICFpbXBvcnRhbnQ7IGJvcmRlcjowICFpbXBvcnRhbnQ7IHdpZHRoOmF1dG8gIWltcG9ydGFudDsgaGVpZ2h0OmF1dG8gIWltcG9ydGFudDsgbWF4LXdpZHRoOm5vbmUgIWltcG9ydGFudDsgbWF4LWhlaWdodDpub25lICFpbXBvcnRhbnQ7IG92ZXJmbG93OnZpc2libGUgIWltcG9ydGFudDsgYmFja2dyb3VuZDp0cmFuc3BhcmVudCAhaW1wb3J0YW50OyBjb2xvcjppbmhlcml0OyBwb2ludGVyLWV2ZW50czpub25lICFpbXBvcnRhbnQ7IH1cbiAgICAgIFtkYXRhLW1lbWNoYXQtdG9wLWxheWVyXTo6YmFja2Ryb3AgeyBiYWNrZ3JvdW5kOnRyYW5zcGFyZW50ICFpbXBvcnRhbnQ7IHBvaW50ZXItZXZlbnRzOm5vbmUgIWltcG9ydGFudDsgfVxuICAgICAgW2RhdGEtbWVtY2hhdC10b3AtbGF5ZXJdID4gKiB7IHBvaW50ZXItZXZlbnRzOmF1dG8gIWltcG9ydGFudDsgfVxuICAgICAgW2RhdGEtbWVtY2hhdC10b3AtbGF5ZXJdID4gI2hhY2tlck5vdGlmaWVyVG9hc3RIb3N0IHsgcG9pbnRlci1ldmVudHM6bm9uZSAhaW1wb3J0YW50OyB9XG4gICAgYDtcbiAgICBob3N0LmFwcGVuZENoaWxkKHN0eWxlKTtcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGhvc3QpO1xuXG4gICAgbGV0IHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgIGxldCBmb3JjZVByb21vdGlvbiA9IGZhbHNlO1xuICAgIGxldCBzY2hlZHVsZWRUaW1lciA9IDA7XG4gICAgbGV0IGxhc3RNb2RhbCA9IG51bGw7XG4gICAgbGV0IGxhc3RGdWxsc2NyZWVuID0gbnVsbDtcbiAgICBsZXQgZXh0ZXJuYWxUb3BMYXllclRpbWVyID0gMDtcbiAgICBjb25zdCBtb2RhbE9yZGVyID0gW107XG5cbiAgICBmdW5jdGlvbiBpc01vZGFsKGRpYWxvZykge1xuICAgICAgICB0cnkgeyByZXR1cm4gZGlhbG9nLm1hdGNoZXMoJzptb2RhbCcpOyB9IGNhdGNoIChfKSB7IHJldHVybiBmYWxzZTsgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGFjdGl2ZU1vZGFsKCkge1xuICAgICAgICBjb25zdCBkaWFsb2dzID0gQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdkaWFsb2dbb3Blbl0nKSk7XG4gICAgICAgIGNvbnN0IG1vZGFscyA9IGRpYWxvZ3MuZmlsdGVyKGlzTW9kYWwpO1xuICAgICAgICBmb3IgKGxldCBpID0gbW9kYWxPcmRlci5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgICAgICAgICAgaWYgKCFtb2RhbHMuaW5jbHVkZXMobW9kYWxPcmRlcltpXSkpIG1vZGFsT3JkZXIuc3BsaWNlKGksIDEpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgZGlhbG9nIG9mIG1vZGFscykgaWYgKCFtb2RhbE9yZGVyLmluY2x1ZGVzKGRpYWxvZykpIG1vZGFsT3JkZXIucHVzaChkaWFsb2cpO1xuICAgICAgICBjb25zdCBmb2N1c2VkID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudDtcbiAgICAgICAgY29uc3QgZm9jdXNlZE1vZGFscyA9IG1vZGFscy5maWx0ZXIoZGlhbG9nID0+IGRpYWxvZy5jb250YWlucyhmb2N1c2VkKSk7XG4gICAgICAgIGlmIChmb2N1c2VkTW9kYWxzLmxlbmd0aCkge1xuICAgICAgICAgICAgcmV0dXJuIGZvY3VzZWRNb2RhbHMucmVkdWNlKChkZWVwZXN0LCBkaWFsb2cpID0+IGRlZXBlc3QuY29udGFpbnMoZGlhbG9nKSA/IGRpYWxvZyA6IGRlZXBlc3QpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBtb2RhbE9yZGVyLmxlbmd0aCA/IG1vZGFsT3JkZXJbbW9kYWxPcmRlci5sZW5ndGggLSAxXSA6IG51bGw7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcHJvbW90ZSgpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBob3N0LnNob3dQb3BvdmVyICE9PSAnZnVuY3Rpb24nKSByZXR1cm47XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoaG9zdC5tYXRjaGVzKCc6cG9wb3Zlci1vcGVuJykpIGhvc3QuaGlkZVBvcG92ZXIoKTtcbiAgICAgICAgICAgIGhvc3Quc2hvd1BvcG92ZXIoKTtcbiAgICAgICAgfSBjYXRjaCAoXykge1xuICAgICAgICAgICAgLy8gTGVhdmUgdGhlIGhvc3QgbW91bnRlZDsgdW5zdXBwb3J0ZWQvYmxvY2tlZCBwb3BvdmVyIEFQSXMgY2Fubm90IGJlIGZvcmNlZC5cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHdpdGhPd25lZEZvY3VzKGFjdGlvbiwgb3duZWRSb290ID0gaG9zdCkge1xuICAgICAgICBjb25zdCBmb2N1c2VkID0gb3duZWRSb290LmNvbnRhaW5zKGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQpID8gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCA6IG51bGw7XG4gICAgICAgIGNvbnN0IHN0YXJ0ID0gZm9jdXNlZCAmJiB0eXBlb2YgZm9jdXNlZC5zZWxlY3Rpb25TdGFydCA9PT0gJ251bWJlcicgPyBmb2N1c2VkLnNlbGVjdGlvblN0YXJ0IDogbnVsbDtcbiAgICAgICAgY29uc3QgZW5kID0gZm9jdXNlZCAmJiB0eXBlb2YgZm9jdXNlZC5zZWxlY3Rpb25FbmQgPT09ICdudW1iZXInID8gZm9jdXNlZC5zZWxlY3Rpb25FbmQgOiBudWxsO1xuICAgICAgICBjb25zdCBkaXJlY3Rpb24gPSBmb2N1c2VkICYmIGZvY3VzZWQuc2VsZWN0aW9uRGlyZWN0aW9uO1xuICAgICAgICBhY3Rpb24oKTtcbiAgICAgICAgaWYgKCFmb2N1c2VkIHx8ICFmb2N1c2VkLmlzQ29ubmVjdGVkIHx8IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgPT09IGZvY3VzZWQpIHJldHVybjtcbiAgICAgICAgLy8gUmVwYXJlbnRpbmcgYW5kIHBvcG92ZXIgdG9nZ2xpbmcgbWF5IGJsdXIgYW4gb3duZWQgY29udHJvbCB0byBib2R5LiBOZXZlclxuICAgICAgICAvLyBvdmVycmlkZSBhIGRpZmZlcmVudCBwYWdlIGNvbnRyb2wgdGhhdCBhY3F1aXJlZCBmb2N1cyBkdXJpbmcgdGhlIGFjdGlvbi5cbiAgICAgICAgaWYgKGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgIT09IGRvY3VtZW50LmJvZHkgJiYgZG9jdW1lbnQuYWN0aXZlRWxlbWVudCAhPT0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50KSByZXR1cm47XG4gICAgICAgIHRyeSB7IGZvY3VzZWQuZm9jdXMoeyBwcmV2ZW50U2Nyb2xsOiB0cnVlIH0pOyB9IGNhdGNoIChfKSB7IHRyeSB7IGZvY3VzZWQuZm9jdXMoKTsgfSBjYXRjaCAoXykge30gfVxuICAgICAgICBpZiAoc3RhcnQgIT09IG51bGwgJiYgdHlwZW9mIGZvY3VzZWQuc2V0U2VsZWN0aW9uUmFuZ2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgIHRyeSB7IGZvY3VzZWQuc2V0U2VsZWN0aW9uUmFuZ2Uoc3RhcnQsIGVuZCwgZGlyZWN0aW9uKTsgfSBjYXRjaCAoXykge31cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIG1vdmVIb3N0KHBhcmVudCkge1xuICAgICAgICBpZiAoIXBhcmVudCB8fCBob3N0LnBhcmVudEVsZW1lbnQgPT09IHBhcmVudCkgcmV0dXJuO1xuICAgICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoaG9zdCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY29sbGVjdFJvb3RzKCkge1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChST09UX1NFTEVDVE9SKSkge1xuICAgICAgICAgICAgaWYgKG5vZGUgPT09IGhvc3QgfHwgaG9zdC5jb250YWlucyhub2RlKSkgY29udGludWU7XG4gICAgICAgICAgICB3aXRoT3duZWRGb2N1cygoKSA9PiBob3N0LmFwcGVuZENoaWxkKG5vZGUpLCBub2RlKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHN5bmMoKSB7XG4gICAgICAgIHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgICAgICBzY2hlZHVsZWRUaW1lciA9IDA7XG4gICAgICAgIGNvbnN0IHNob3VsZFByb21vdGUgPSBmb3JjZVByb21vdGlvbjtcbiAgICAgICAgZm9yY2VQcm9tb3Rpb24gPSBmYWxzZTtcbiAgICAgICAgaWYgKCFkb2N1bWVudC5ib2R5LmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgIGlmICghaG9zdC5pc0Nvbm5lY3RlZCkgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChob3N0KTtcbiAgICAgICAgY29uc3QgZnVsbHNjcmVlbiA9IGRvY3VtZW50LmZ1bGxzY3JlZW5FbGVtZW50IHx8IG51bGw7XG4gICAgICAgIGNvbnN0IG1vZGFsID0gYWN0aXZlTW9kYWwoKTtcbiAgICAgICAgY29uc3QgcGFyZW50ID0gZnVsbHNjcmVlbiA/IChtb2RhbCAmJiBmdWxsc2NyZWVuLmNvbnRhaW5zKG1vZGFsKSA/IG1vZGFsIDogZnVsbHNjcmVlbikgOiAobW9kYWwgfHwgZG9jdW1lbnQuYm9keSk7XG4gICAgICAgIHdpdGhPd25lZEZvY3VzKCgpID0+IHtcbiAgICAgICAgICAgIG1vdmVIb3N0KHBhcmVudCk7XG4gICAgICAgICAgICBpZiAoZnVsbHNjcmVlbiAhPT0gbGFzdEZ1bGxzY3JlZW4gfHwgbW9kYWwgIT09IGxhc3RNb2RhbCB8fCBob3N0LnBhcmVudEVsZW1lbnQgIT09IHBhcmVudCB8fCBzaG91bGRQcm9tb3RlKSBwcm9tb3RlKCk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoZnVsbHNjcmVlbiAhPT0gbGFzdEZ1bGxzY3JlZW4gfHwgbW9kYWwgIT09IGxhc3RNb2RhbCB8fCBob3N0LnBhcmVudEVsZW1lbnQgIT09IHBhcmVudCkge1xuICAgICAgICAgICAgbGFzdEZ1bGxzY3JlZW4gPSBmdWxsc2NyZWVuO1xuICAgICAgICAgICAgbGFzdE1vZGFsID0gbW9kYWw7XG4gICAgICAgIH1cbiAgICAgICAgY29sbGVjdFJvb3RzKCk7XG4gICAgICAgIGlmICghaG9zdC5tYXRjaGVzKCc6cG9wb3Zlci1vcGVuJykpIHdpdGhPd25lZEZvY3VzKHByb21vdGUpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNjaGVkdWxlKGZvcmNlID0gZmFsc2UpIHtcbiAgICAgICAgZm9yY2VQcm9tb3Rpb24gPSBmb3JjZVByb21vdGlvbiB8fCBmb3JjZSA9PT0gdHJ1ZTtcbiAgICAgICAgaWYgKHNjaGVkdWxlZCkgcmV0dXJuO1xuICAgICAgICBzY2hlZHVsZWQgPSB0cnVlO1xuICAgICAgICBzY2hlZHVsZWRUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KHN5bmMsIDApO1xuICAgIH1cblxuICAgIHByb21vdGUoKTtcbiAgICBjb2xsZWN0Um9vdHMoKTtcbiAgICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKHJlY29yZHMgPT4ge1xuICAgICAgICBmb3IgKGNvbnN0IHJlY29yZCBvZiByZWNvcmRzKSB7XG4gICAgICAgICAgICBpZiAocmVjb3JkLnR5cGUgIT09ICdhdHRyaWJ1dGVzJyB8fCByZWNvcmQuYXR0cmlidXRlTmFtZSAhPT0gJ29wZW4nIHx8IHJlY29yZC50YXJnZXQubG9jYWxOYW1lICE9PSAnZGlhbG9nJykgY29udGludWU7XG4gICAgICAgICAgICBjb25zdCBkaWFsb2cgPSByZWNvcmQudGFyZ2V0O1xuICAgICAgICAgICAgY29uc3QgaW5kZXggPSBtb2RhbE9yZGVyLmluZGV4T2YoZGlhbG9nKTtcbiAgICAgICAgICAgIGlmICghZGlhbG9nLmhhc0F0dHJpYnV0ZSgnb3BlbicpIHx8ICFpc01vZGFsKGRpYWxvZykpIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXggIT09IC0xKSBtb2RhbE9yZGVyLnNwbGljZShpbmRleCwgMSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChpbmRleCAhPT0gLTEpIG1vZGFsT3JkZXIuc3BsaWNlKGluZGV4LCAxKTtcbiAgICAgICAgICAgICAgICBtb2RhbE9yZGVyLnB1c2goZGlhbG9nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzY2hlZHVsZSgpO1xuICAgIH0pO1xuICAgIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IHN1YnRyZWU6IHRydWUsIGNoaWxkTGlzdDogdHJ1ZSwgYXR0cmlidXRlczogdHJ1ZSwgYXR0cmlidXRlRmlsdGVyOiBbJ29wZW4nLCAnc3R5bGUnLCAnY2xhc3MnXSB9KTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd0b2dnbGUnLCBzY2hlZHVsZSwgdHJ1ZSk7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignZnVsbHNjcmVlbmNoYW5nZScsIHNjaGVkdWxlLCB0cnVlKTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd3ZWJraXRmdWxsc2NyZWVuY2hhbmdlJywgc2NoZWR1bGUsIHRydWUpO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwYWdlaGlkZScsICgpID0+IHtcbiAgICAgICAgb2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICAgICAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHNjaGVkdWxlZFRpbWVyKTtcbiAgICAgICAgd2luZG93LmNsZWFyVGltZW91dChleHRlcm5hbFRvcExheWVyVGltZXIpO1xuICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICB9LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3BhZ2VzaG93JywgZXZlbnQgPT4ge1xuICAgICAgICBpZiAoIWV2ZW50LnBlcnNpc3RlZCkgcmV0dXJuO1xuICAgICAgICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBzdWJ0cmVlOiB0cnVlLCBjaGlsZExpc3Q6IHRydWUsIGF0dHJpYnV0ZXM6IHRydWUsIGF0dHJpYnV0ZUZpbHRlcjogWydvcGVuJywgJ3N0eWxlJywgJ2NsYXNzJ10gfSk7XG4gICAgICAgIHNjaGVkdWxlKCk7XG4gICAgfSk7XG4gICAgLy8gQSBsYXRlciBwYWdlIHBvcG92ZXIvZGlhbG9nIGVudGVycyBhYm92ZSBhbiBlYXJsaWVyIHBvcG92ZXIuIFJlLXByb21vdGUgYWZ0ZXIgaXRzIHRvZ2dsZS5cbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCd0b2dnbGUnLCBldmVudCA9PiB7XG4gICAgICAgIGlmIChldmVudC50YXJnZXQgPT09IGhvc3QgfHwgIWV2ZW50LnRhcmdldCB8fCBob3N0LmNvbnRhaW5zKGV2ZW50LnRhcmdldCkpIHJldHVybjtcbiAgICAgICAgd2luZG93LmNsZWFyVGltZW91dChleHRlcm5hbFRvcExheWVyVGltZXIpO1xuICAgICAgICBleHRlcm5hbFRvcExheWVyVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBtb2RhbCA9IGFjdGl2ZU1vZGFsKCk7XG4gICAgICAgICAgICBpZiAobW9kYWwgfHwgZG9jdW1lbnQuZnVsbHNjcmVlbkVsZW1lbnQpIHNjaGVkdWxlKHRydWUpO1xuICAgICAgICAgICAgZWxzZSB3aXRoT3duZWRGb2N1cyhwcm9tb3RlKTtcbiAgICAgICAgfSwgMCk7XG4gICAgfSwgdHJ1ZSk7XG4gICAgd2luZG93Ll9fbWVtY2hhdFRvcExheWVyID0geyBob3N0LCByZWZyZXNoOiBzY2hlZHVsZSB9O1xufSkoKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9EQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3ZFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUMxR0E7QUFDQTtBQUNBOztBQ0ZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0T0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9hQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwSUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuUUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaldBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqb0JBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDZEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsa0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMzNDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdGdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4bEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3prQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDN0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ25JQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OzsifQ==
