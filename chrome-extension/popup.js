'use strict';
(async () => {
    const status = document.getElementById('status');
    const actions = document.getElementById('actions');
    const manifest = chrome.runtime.getManifest();
    document.getElementById('version').textContent = 'v' + (manifest.version_name || manifest.version);
    const matches = url => {
        try {
            const current = new URL(url);
            if (current.protocol !== 'https:' || current.port) return false;
            return manifest.content_scripts[0].matches.some(pattern => {
                const host = pattern.slice('https://'.length).split('/')[0];
                return host.startsWith('*.')
                    ? current.hostname === host.slice(2) || current.hostname.endsWith('.' + host.slice(2))
                    : current.hostname === host;
            });
        } catch { return false; }
    };
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !matches(tab.url)) {
            status.textContent = 'Откройте МойСклад, Bitrix24 или сайт Hatiko.';
            return;
        }
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'memchat:menus' }, { frameId: 0 });
        if (result?.conflict) {
            status.textContent = 'Обнаружено окно старого Memchat. Отключите userscript в Tampermonkey и перезагрузите вкладку.';
            return;
        }
        if (!result?.menus?.length) throw new Error('No content script');
        status.textContent = 'Меню рабочей вкладки';
        for (const menu of result.menus) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = menu.label;
            button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                    const reply = await chrome.tabs.sendMessage(tab.id, { type: 'memchat:menu', id: menu.id }, { frameId: 0 });
                    status.textContent = reply?.ok ? 'Выполнено' : 'Не удалось выполнить. Проверьте вкладку и перезагрузите её.';
                } catch { status.textContent = 'Перезагрузите рабочую вкладку и откройте меню снова.'; }
                finally { button.disabled = false; }
            });
            actions.appendChild(button);
        }
    } catch { status.textContent = 'Перезагрузите рабочую вкладку после установки или обновления расширения.'; }
})();
