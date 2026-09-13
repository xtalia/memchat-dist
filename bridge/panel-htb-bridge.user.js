// ==UserScript==
// @name         Panel Hatiko Bridge
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  Отдаёт CSRF-токен Panel Hatiko основному скрипту Мемного чата через postMessage
// @match        https://panel.hatiko.ru/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_ORIGINS = ['https://online.moysklad.ru', 'https://hatiko.ru', 'https://*.hatiko.ru'];

    function getAllowedContainOrigins() {
        return [
            'https://online.moysklad.ru',
            'https://hatiko.ru',
            'https://voronezh.hatiko.ru',
            'https://lipetsk.hatiko.ru',
            'https://balakovo.hatiko.ru'
        ];
    }

    function isAllowedOrigin(origin) {
        return getAllowedContainOrigins().includes(origin);
    }

    function getCsrf() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta && meta.content) return meta.content;
        const input = document.querySelector('input[name="_token"]');
        return input ? (input.value || '') : '';
    }

    function isAuthorized() {
        return !/\/login$/.test(location.pathname) && Boolean(getCsrf());
    }

    function sendResponse(eventOrigin) {
        const csrf = getCsrf();
        const payload = {
            source: 'hatiko-panel-bridge',
            type: 'panelCsrfResponse',
            ok: Boolean(csrf),
            authorized: isAuthorized(),
            token: csrf
        };
        try {
            if (eventOrigin) (event.source || window.parent)?.postMessage(payload, eventOrigin);
            else getAllowedContainOrigins().forEach(o => window.parent?.postMessage(payload, o));
        } catch (e) {
            console.warn('[PanelBridge] postMessage failed', e);
        }
    }

    function pushToken() {
        if (document.hidden) return;
        sendResponse();
    }

    // Push-модель: не ждём запрос от основного скрипта. Пока вкладка Panel
    // активна, обновляем токен каждые 5 минут; при возвращении во вкладку
    // отправляем свежий токен сразу.
    window.addEventListener('visibilitychange', () => {
        if (!document.hidden) pushToken();
    });
    setInterval(pushToken, 5 * 60 * 1000);

    if (window === window.top) {
        console.info('[PanelBridge] готов. Push-обновление CSRF каждые 5 минут.');
        pushToken();
    }
})();