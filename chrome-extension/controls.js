'use strict';
const RESET_POSITION_MENU_ID = 'memchat-reset-position';
const ACTION_TITLE = 'Показать / скрыть Мемчат';

function supportedActionTab(tab) {
    if (!Number.isInteger(tab?.id)) return false;
    try {
        const url = new URL(tab.url);
        return url.protocol === 'https:' && !url.port && MEMCHAT_EXTENSION_CONFIG.pageMatches.some(pattern => {
            const host = pattern.slice('https://'.length).split('/')[0];
            return host.startsWith('*.')
                ? url.hostname === host.slice(2) || url.hostname.endsWith('.' + host.slice(2))
                : url.hostname === host;
        });
    } catch { return false; }
}

async function updateActionFeedback(tabId, result) {
    const titles = {
        unsupported: 'Откройте МойСклад, Bitrix24 или сайт Hatiko.',
        conflict: 'Отключите Memchat в Tampermonkey и перезагрузите вкладку.',
        missing: 'Перезагрузите рабочую вкладку после обновления расширения.',
        failed: 'Не удалось выполнить действие. Перезагрузите рабочую вкладку.'
    };
    if (!Number.isInteger(tabId)) return;
    // A tab may close between sending the command and updating its feedback.
    await Promise.allSettled([
        chrome.action.setBadgeText({ tabId, text: result.ok ? '' : '!' }),
        chrome.action.setTitle({ tabId, title: result.ok ? ACTION_TITLE : (titles[result.reason] || titles.failed) })
    ]);
}

async function runTabCommand(tab, type) {
    let result;
    if (!supportedActionTab(tab)) result = { ok: false, reason: 'unsupported' };
    else {
        try {
            const reply = await chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
            result = reply?.ok ? { ok: true } : { ok: false, reason: reply?.reason || 'failed' };
        } catch { result = { ok: false, reason: 'missing' }; }
    }
    await updateActionFeedback(tab?.id, result);
    return result;
}

function handleActionClick(tab) { return runTabCommand(tab, 'memchat:toggle'); }
function handleContextClick(info, tab) {
    if (info.menuItemId === RESET_POSITION_MENU_ID) return runTabCommand(tab, 'memchat:reset-position');
    return Promise.resolve({ ok: false, reason: 'unknown-menu' });
}

function registerActionMenu() {
    return new Promise((resolve, reject) => {
        chrome.contextMenus.removeAll(() => {
            if (chrome.runtime.lastError) { reject(new Error('Context menu unavailable')); return; }
            chrome.contextMenus.create({ id: RESET_POSITION_MENU_ID, title: 'Сбросить положение окон', contexts: ['action'] }, () => {
                if (chrome.runtime.lastError) reject(new Error('Context menu unavailable'));
                else resolve();
            });
        });
    });
}

chrome.action.onClicked.addListener(handleActionClick);
chrome.contextMenus.onClicked.addListener(handleContextClick);
chrome.runtime.onInstalled.addListener(() => registerActionMenu().catch(() => {}));
chrome.runtime.onStartup.addListener(() => registerActionMenu().catch(() => {}));
