// ==UserScript==
// @name         Panel Enhancer — пресеты checkout
// @namespace    https://github.com/xtalia/hatiko
// @version      1.3.0-alpha
// @description  Пользовательские пресеты и компактный интерфейс для checkout Panel Hatiko
// @match        https://panel.hatiko.ru/order/checkout*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/xtalia/memchat-dist/main/panel-enhancer.user.js
// @updateURL    https://raw.githubusercontent.com/xtalia/memchat-dist/main/panel-enhancer.user.js
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = 'panel-enhancer:presets_v1';
    const CONFIG_FORMAT = 'panel-enhancer-config';
    const CONFIG_VERSION = 1;
    const CARD_SELECTOR = 'body > main > div.container > div:nth-child(3) > div.card-body';
    const BAR_ID = 'panelEnhancerPresetBar';
    const DIALOG_ID = 'panelEnhancerPresetDialog';
    const FIELD_IDS = {
        source: 'clientSourceSelect',
        channel: 'channelSelect',
        stock: 'stockSelect',
        priceType: 'priceTypeSelect'
    };
    let observer = null;
    let observerScheduled = false;

    function enabled() {
        return location.hostname === 'panel.hatiko.ru' && location.pathname === '/order/checkout';
    }

    function normalizePresets(raw) {
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        return raw.map(item => ({
                id: typeof item?.id === 'string' && item.id ? item.id : `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                name: typeof item?.name === 'string' ? item.name.trim().slice(0, 80) : '',
                source: typeof item?.source === 'string' ? item.source : '',
                channel: typeof item?.channel === 'string' ? item.channel : '',
                stock: typeof item?.stock === 'string' ? item.stock : '',
                priceType: typeof item?.priceType === 'string' ? item.priceType : ''
            })).filter(item => {
                if (!item.name || !item.source || !item.channel || !item.stock || !item.priceType || seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            });
    }

    function loadPresets() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            return normalizePresets(raw);
        } catch {
            return [];
        }
    }

    function savePresets(presets) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
            return true;
        } catch {
            return false;
        }
    }

    function exportConfig() {
        return JSON.stringify({
            format: CONFIG_FORMAT,
            version: CONFIG_VERSION,
            presets: loadPresets()
        }, null, 2);
    }

    function importConfig(text) {
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            return { ok: false, error: 'Некорректный JSON' };
        }
        const rawPresets = Array.isArray(parsed) ? parsed : parsed?.presets;
        if (!Array.isArray(rawPresets)) return { ok: false, error: 'В JSON нет массива presets' };
        const presets = normalizePresets(rawPresets);
        if (presets.length !== rawPresets.length) return { ok: false, error: 'В JSON есть некорректные пресеты' };
        if (!savePresets(presets)) return { ok: false, error: 'Не удалось сохранить конфигурацию' };
        return { ok: true, count: presets.length };
    }

    function field(name) {
        return document.getElementById(FIELD_IDS[name]);
    }

    function currentValues() {
        const selects = Object.keys(FIELD_IDS).map(field);
        if (selects.some(select => !select)) return null;
        return Object.fromEntries(Object.keys(FIELD_IDS).map((name, index) => [name, selects[index].value]));
    }

    function selectedLabel(name) {
        const select = field(name);
        return select?.options[select.selectedIndex]?.textContent.trim() || select?.value || '';
    }

    function cityLabel() {
        return selectedLabel('stock')
            .replace(/^склад\s+/i, '')
            .replace(/\s+склад$/i, '')
            .trim();
    }

    function shortChannelLabel(label) {
        const normalized = String(label || '').replace(/\s+/g, ' ').trim();
        const aliases = [
            [/интернет[- ]?магазин|сайт|онлайн/i, 'Сайт'],
            [/маркетплейс/i, 'МП'],
            [/розничн.*магазин|магазин/i, 'Магазин'],
            [/телефон/i, 'Телефон'],
            [/мессенджер|чат/i, 'Чат'],
            [/рекомендац/i, 'Рек.'],
            [/покупател|клиент/i, 'Вход'],
            [/партн[её]р/i, 'Партн.']
        ];
        const alias = aliases.find(([pattern]) => pattern.test(normalized));
        if (alias) return alias[1];
        const compact = normalized.replace(/\b(канал|продаж|поступления|поступление|источник)\b/gi, '').replace(/\s+/g, ' ').trim();
        if (compact.length <= 16) return compact || normalized;
        const words = compact.split(' ').filter(Boolean);
        return words.length > 1 ? words.map(word => word[0]).join('').toUpperCase() : compact.slice(0, 14);
    }

    function autoPresetName(existing) {
        const labels = [cityLabel(), selectedLabel('priceType'), shortChannelLabel(selectedLabel('channel')), shortChannelLabel(selectedLabel('source'))]
            .filter(Boolean);
        const base = (`Авто: ${labels.join(' · ')}` || 'Автопресет').slice(0, 80);
        let index = 1;
        let candidate = base;
        while (existing.some(item => item.name === candidate)) {
            index += 1;
            const suffix = ` (${index})`;
            candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
        }
        return candidate.slice(0, 80);
    }

    function waitFor(predicate, timeout, label) {
        const started = Date.now();
        return new Promise((resolve, reject) => {
            const check = () => {
                try {
                    const result = predicate();
                    if (result) return resolve(result);
                } catch (error) {
                    return reject(error);
                }
                if (Date.now() - started >= timeout) return reject(new Error(`Не дождался: ${label}`));
                setTimeout(check, 150);
            };
            check();
        });
    }

    function setSelect(name, value) {
        const select = field(name);
        if (!select) throw new Error(`Не найдено поле #${FIELD_IDS[name]}`);
        const option = [...select.options].find(item => item.value === value);
        if (!option) throw new Error(`В поле #${FIELD_IDS[name]} нет сохранённого значения`);
        select.value = value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function waitForSavedOption(name, value, label, timeout = 10000) {
        await waitFor(() => {
            const select = field(name);
            return select && !select.disabled && [...select.options].some(option => option.value === value);
        }, timeout, label);
    }

    async function applyPreset(preset, status) {
        const setStatus = message => { if (status) status.textContent = message; };
        try {
            setStatus(`Применяю «${preset.name}»…`);
            setSelect('source', preset.source);
            await new Promise(resolve => setTimeout(resolve, 200));
            await waitForSavedOption('channel', preset.channel, 'канал продаж');
            setSelect('channel', preset.channel);
            await new Promise(resolve => setTimeout(resolve, 200));
            await waitForSavedOption('stock', preset.stock, 'склад', 5000);
            setSelect('stock', preset.stock);
            await new Promise(resolve => setTimeout(resolve, 200));
            await waitForSavedOption('priceType', preset.priceType, 'тип цены', 5000);
            setSelect('priceType', preset.priceType);
            setStatus(`✅ Применён пресет «${preset.name}»`);
        } catch (error) {
            setStatus(`❌ ${error.message}`);
        }
    }

    function button(text, title, onClick) {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = text;
        element.title = title;
        element.style.cssText = 'padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font:12px/1 Arial,sans-serif;cursor:pointer;';
        element.addEventListener('click', onClick);
        return element;
    }

    function renderBar() {
        const bar = document.getElementById(BAR_ID);
        if (!bar) return;
        const presets = loadPresets();
        const signature = JSON.stringify(presets);
        if (bar.dataset.signature === signature) return;
        bar.dataset.signature = signature;
        const list = bar.querySelector('[data-preset-list]');
        const status = bar.querySelector('[data-preset-status]');
        list.replaceChildren();
        presets.forEach(preset => list.appendChild(button(preset.name, `Применить «${preset.name}»`, () => applyPreset(preset, status))));
    }

    function renderDialogList(list, status) {
        list.replaceChildren();
        const presets = loadPresets();
        if (!presets.length) {
            const empty = document.createElement('div');
            empty.textContent = 'Пресетов пока нет. Выставьте поля и сохраните текущие значения.';
            empty.style.cssText = 'padding:8px;border:1px dashed #cbd5e1;border-radius:7px;color:#64748b;font-size:11px;';
            list.appendChild(empty);
            return;
        }
        presets.forEach(preset => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:6px 0;border-bottom:1px solid #e5e7eb;';
            const name = document.createElement('span');
            name.textContent = preset.name;
            name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            row.append(
                name,
                button('▶', `Применить «${preset.name}»`, () => applyPreset(preset, status)),
                button('✏️', 'Переименовать', () => {
                    const nextName = window.prompt('Новое название пресета', preset.name)?.trim().slice(0, 80);
                    if (!nextName || nextName === preset.name) return;
                    savePresets(loadPresets().map(item => item.id === preset.id ? { ...item, name: nextName } : item));
                    renderDialogList(list, status);
                    renderBar();
                }),
                button('🗑', 'Удалить', () => {
                    savePresets(loadPresets().filter(item => item.id !== preset.id));
                    renderDialogList(list, status);
                    renderBar();
                })
            );
            list.appendChild(row);
        });
    }

    function openDialog() {
        document.getElementById(DIALOG_ID)?.remove();
        const overlay = document.createElement('div');
        overlay.id = DIALOG_ID;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.35);';
        const box = document.createElement('section');
        box.style.cssText = 'width:min(460px,calc(100vw - 32px));max-height:80vh;overflow:auto;padding:14px;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 12px 40px rgba(15,23,42,.3);font:13px/1.35 Arial,sans-serif;color:#1f2937;';
        const header = document.createElement('div');
        header.textContent = '⚙️ Panel Enhancer — пресеты';
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-weight:700;';
        header.appendChild(button('✕', 'Закрыть', () => overlay.remove()));
        const form = document.createElement('div');
        form.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 80;
        input.placeholder = 'Название нового пресета (необязательно)';
        input.style.cssText = 'flex:1;min-width:0;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;';
        const status = document.createElement('div');
        status.style.cssText = 'min-height:17px;margin-bottom:7px;color:#64748b;font-size:11px;';
        const list = document.createElement('div');
        const configArea = document.createElement('textarea');
        configArea.rows = 8;
        configArea.placeholder = 'Здесь появится JSON конфигурации. Его можно скопировать или вставить для импорта.';
        configArea.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:7px 8px;border:1px solid #cbd5e1;border-radius:6px;font:11px/1.35 Consolas,monospace;resize:vertical;';
        const configActions = document.createElement('div');
        configActions.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
        const exportButton = button('📤 Экспорт JSON', 'Показать текущую конфигурацию в JSON', () => {
            configArea.value = exportConfig();
            configArea.focus();
            configArea.select();
            status.textContent = '✅ Конфигурация подготовлена. Скопируйте JSON из поля ниже.';
        });
        const importButton = button('📥 Импорт JSON', 'Загрузить конфигурацию из JSON', () => {
            const result = importConfig(configArea.value);
            if (!result.ok) {
                status.textContent = `❌ ${result.error}`;
                return;
            }
            renderDialogList(list, status);
            renderBar();
            status.textContent = `✅ Импортировано пресетов: ${result.count}`;
        });
        configActions.append(exportButton, importButton);
        const save = button('Сохранить текущие', 'Сохранить текущие значения полей', () => {
            const values = currentValues();
            const existing = loadPresets();
            const name = input.value.trim() || autoPresetName(existing);
            if (!values) return status.textContent = '❌ Поля checkout ещё не загружены';
            const presets = existing.filter(item => item.name !== name);
            presets.push({ id: `preset-${Date.now()}`, name: name.slice(0, 80), ...values });
            if (!savePresets(presets)) return status.textContent = '❌ Не удалось сохранить пресет';
            input.value = '';
            renderDialogList(list, status);
            renderBar();
            status.textContent = `✅ Сохранён «${name}»`;
        });
        form.append(input, save);
        box.append(header, form, status, list, configArea, configActions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
        renderDialogList(list, status);
    }

    function mount() {
        if (!enabled()) return false;
        const card = document.querySelector(CARD_SELECTOR);
        if (!card) return false;
        let bar = document.getElementById(BAR_ID);
        let shouldRender = false;
        if (bar && bar.parentElement !== card) {
            bar.remove();
            bar = null;
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.id = BAR_ID;
            bar.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin:-4px 0 12px;padding:7px 8px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;';
            const label = document.createElement('span');
            label.textContent = 'Пресеты:';
            label.style.cssText = 'font-size:11px;font-weight:700;color:#475569;margin-right:2px;';
            const list = document.createElement('div');
            list.dataset.presetList = '1';
            list.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
            const status = document.createElement('span');
            status.dataset.presetStatus = '1';
            status.style.cssText = 'flex:1 1 100%;min-height:14px;color:#64748b;font-size:10px;';
            bar.append(label, list, button('⚙️', 'Настроить и удалить пресеты', openDialog), button('➕', 'Создать пресет из текущих значений', openDialog), status);
            card.prepend(bar);
            shouldRender = true;
        }
        if (shouldRender) renderBar();
        return true;
    }

    function stop() {
        observer?.disconnect();
        observer = null;
        observerScheduled = false;
    }

    function tick() {
        observerScheduled = false;
        if (!enabled()) {
            document.getElementById(BAR_ID)?.remove();
            stop();
            return;
        }
        mount();
    }

    function start() {
        if (!enabled()) return;
        mount();
        if (observer || typeof MutationObserver === 'undefined') return;
        observer = new MutationObserver(() => {
            if (observerScheduled) return;
            observerScheduled = true;
            queueMicrotask(tick);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    start();
})();
