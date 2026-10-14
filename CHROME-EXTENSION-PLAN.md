# Memchat Chrome Extension Implementation Plan

**Goal:** Собрать автономное Chrome-расширение Memchat (Manifest V3) из production `js/memchat.user.js` и опубликовать ZIP и распакованную папку в `xtalia/memchat-dist`.

**Architecture:** Существующий userscript без metadata запускается в IIFE в isolated content world. Совместимый GM-адаптер передаёт сетевые запросы service worker через приватные runtime-сообщения. Меню Tampermonkey становится popup расширения. Все исполняемые файлы находятся в пакете, eval/remote code отсутствуют.

**Tech Stack:** Chrome Manifest V3, JavaScript, Python stdlib (сборка, SHA-256, ZIP), node:test + существующий jsdom, установленный Playwright/Chromium для headless smoke-теста.

## Исходные условия и границы

- Production userscript — версия `8.8.0-beta`; extension manifest version — `8.8.0`, version_name содержит beta.
- В рабочей папке есть чужие незакоммиченные изменения. Не редактировать, не включать в коммит, не запускать существующий publish.ps1, который stage-ит всю папку memchat.
- До изменений полный `npm test`: 54 теста, 53 pass, 1 fail — `internal-order-settings-persistence.test.js`. Это существующая ошибка незакоммиченной разработки, не предмет миграции.
- Расширение использует именно текущий production `js/memchat.user.js`, не незавершённые src-модули. Последующие релизы: сначала обычная production сборка, затем extension build.
- Существующий DOM/UI, API payloads, localStorage keys и исключение бонусных телефонов из истории сохраняются. Перед установкой отключить userscript, иначе получатся дублирующие observer/timer/UI.
- GitHub Web Store публикация не входит в scope. ZIP из GitHub устанавливается через «Загрузить распакованное расширение»; обещаний автоматического обновления нет.

## Задачи

### 1. Детерминированный builder
- Создать `js/memchat/tests/chrome-extension-build.test.js`: тест вызывает Python builder во временную папку и проверяет MV3, версии, permissions, content script, ZIP и source hash. Сначала получить ожидаемый FAIL из-за отсутствующего builder.
- Создать `js/memchat/extension/build.py`: читать generated userscript, разобрать @version/@match/@connect/@grant, отклонять неподдерживаемые grants; создать manifest.json, content.js и статические файлы.
- Версия и hosts происходят из metadata, module order автоматически совпадает с production userscript.
- ZIP детерминированный, без credentials, node_modules, dev dependencies. Сохранять `build-info.json` с SHA-256 production input.
- Повторить тест и сравнить повторную сборку побайтно.

### 2. Привилегированный сетевой транспорт
- Создать `js/memchat/tests/chrome-extension-transport.test.js`, затем `js/memchat/extension/worker.js`.
- Разрешать только HTTPS хосты из metadata; отдельно валидировать отправителя: extension ID, top-frame и supported site либо popup extension URL.
- Разрешённые методы GET/POST/PUT/PATCH/DELETE/HEAD; JSON/text request body. Удалять forbidden fetch headers; Authorization разрешён только api.moysklad.ru.
- Сохранять status/statusText/responseText/responseHeaders/finalUrl; HTTP ошибки идут onload, сеть/таймаут/abort — соответствующие callbacks.
- Ограничить timeout до 30 секунд с учётом lifecycle MV3. Не логировать headers/tokens/body/телефоны.
- Panel cookies credentials:include; DNR session rule задаёт фиксированные Origin/Referer только для запросов расширения к panel.hatiko.ru.
- Контроль redirect: только allowlisted hosts, не отправлять Authorization на другие хосты.

### 3. Content bridge и popup
- Создать `js/memchat/tests/chrome-extension-bridge.test.js`, затем `js/memchat/extension/bridge.js`, popup.html/js/css.
- GM_xmlhttpRequest сериализует только параметры, не callback functions. Передаёт abort в worker, не вызывает terminal callbacks дважды.
- GM_registerMenuCommand сохраняет callback в content-script Map; popup получает только id/label и запускает разрешённый id. Никакого eval или page postMessage bridge.
- Обработать неподдерживаемую страницу, необходимость refresh после установки, дублирование активного userscript.
- Popup принимает сообщения только от собственного extension URL; worker не принимает произвольные внешние сообщения.

### 4. Проверка настоящего пакета
- Node syntax checks всех файлов и generated content.js.
- Новые node:test + full npm test: нет новых baseline failures.
- Headless Chromium с отдельным scratch profile и `--load-extension`: фактическая загрузка service worker, popup, команды открыть/закрыть, калькулятор, сохранение настроек, локальный fixture UI и live supported route без изменения данных.
- Реальные read-only сетевые запросы к разрешённым публичным hosts через worker. Проверить unsupported host/timeout/abort/headers/Panel CSRF origin rules. Авторизованные функции без пользовательского входа помечать как не проверенные end-to-end.
- Независимый code review; исправить конкретные подтверждённые проблемы до публикации.

### 5. Документация и релиз
- Создать `js/memchat/extension/README.md` с установкой, обновлением, разрешениями, авторизацией, настройками и ограничениями MV3.
- Сборка в ignored `js/memchat/extension/dist/`.
- Source commit только новых extension/tests files; не включать существующий WIP. Не force-push source/main: local/remote histories расходятся.
- Сначала актуализировать clean `E:/gitreps/memchat-dist`; сохранить оба существующих userscript.
- Добавить `chrome-extension/`, `memchat-chrome.zip`, `CHROME-EXTENSION.md`; отдельный artifact commit/push в main.
- Прочитать remote ref и файлы обратно, сравнить SHA-256 ZIP и всех extension files с локальными. Проверить, что remote userscript bytes не изменились.

## Критерии приёмки

- Пакет реально загружается Chrome/Chromium; меню и калькулятор работают.
- Нет удалённо исполняемого кода, eval, лишних <all_urls> или секрета в артефактах.
- Source production SHA соответствует input; ZIP и unpacked папка согласованы.
- Незакоммиченные изменения пользователя сохранены, baseline ошибки не выданы за успешные тесты.
- GitHub `memchat-dist/main` содержит проверенные артефакты; пользователю даны ZIP URL и короткая инструкция установки.
