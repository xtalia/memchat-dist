# Хатико · Memchat для Chrome

Автономное расширение Chrome **Manifest V3**, версия `8.8.0-beta`. Содержит production `memchat.user.js`: те же вкладки, калькуляторы, поиск Hatiko/Panel, расписание и функции МойСклад. Tampermonkey для этой версии не нужен.

## Установка

1. Скачать [memchat-chrome.zip](https://github.com/xtalia/memchat-dist/raw/refs/heads/main/memchat-chrome.zip) и распаковать в постоянную папку.
2. **Отключить Memchat в Tampermonkey**, включая DEV-версию. Расширение и userscript нельзя запускать одновременно: иначе возможны дублирующие обработчики и уведомления.
3. Открыть `chrome://extensions`, включить **Режим разработчика**.
4. Нажать **Загрузить распакованное расширение**, выбрать внутреннюю папку `chrome-extension` с `manifest.json`, не ZIP и не родительскую папку.
5. Перезагрузить рабочие вкладки МойСклад, Bitrix24 или Hatiko.
6. Закрепить расширение в панели Chrome. Нажать его значок → **Открыть мемный чат**.

Chrome 120+; на Chromium 151 пакет проверен в headless-режиме. Установка в основном профиле пользователя не выполнялась.

## Обновление

Скачать новый ZIP, заменить содержимое **той же постоянной папки**, на `chrome://extensions` нажать **Обновить/Перезагрузить** для расширения, затем перезагрузить рабочие вкладки. Без Chrome Web Store или enterprise update-server автоматических обновлений нет. Публикация в Web Store не входит в этот релиз.

## Авторизация и данные

- Для Panel войти в `https://panel.hatiko.ru/` в **том же профиле Chrome**. Расширение использует существующую сессию браузера; пароли не входят в пакет.
- Bearer API МойСклад включается в существующих настройках Мемчата. Ключ не вшит в расширение.
- Сохраняются исходные `memchat:*` localStorage keys. Поэтому настройки и история production-userscript в том же сайте/профиле продолжают работать; DEV-состояние не переносится.
- Данные по-прежнему раздельны для разных сайтов/профилей. localStorage принадлежит странице и доступен её скриптам: это прежняя модель userscript, **не защищённое хранилище секретов**. Для переноса токена в chrome.storage требуется отдельная миграция и изменение общего core.
- Телефоны вкладки «Бонусы» по-прежнему исключены из сохраняемой истории.
- Пакет не содержит паролей, Bearer-ключей, пользовательских данных или телеметрии. Все исполняемые скрипты локальны; сетевые ответы — данные/HTML/JSON, не remote code.

## Разрешения

- Site access: `online.moysklad.ru`, `*.bitrix24.ru`, `*.hatiko.ru` — только исходные `@match` сайта для content script и чтения URL рабочей вкладки popup-ом.
- Network access: исходные `@connect` (`hatiko.ru` и поддомены, Panel, `docs.google.com`, GitHub/raw, `api.moysklad.ru`).
- `activeTab` — действие по текущей рабочей вкладке; broad `tabs` не запрашивается.
- `declarativeNetRequestWithHostAccess` — выставление фиксированных Origin/Referer для **собственных** запросов расширения к Panel; отдельное правило блокирует внешние redirect destinations. Обычные запросы страниц не переписываются.
- Нет `<all_urls>`, `cookies`, `webRequest`, `scripting`, clipboard permission или externally_connectable.

## Архитектура

- `content.js`: isolated-world IIFE, GM-адаптер и production userscript.
- `worker.js`: проверенный по sender/domain/method GM transport. Cookie-сессии передаются через `credentials: include`; `anonymous` использует `omit`. Bearer разрешён только для `api.moysklad.ru`.
- `config.js`: allowlists из metadata userscript.
- `popup.html/js/css`: зарегистрированные GM-menu actions без eval и page postMessage bridge.
- `build-info.json`: версия и SHA-256 точного production input.

Таймаут отдельного запроса ограничен 30 секундами с учётом lifecycle MV3. Табличные/фоновые функции core продолжают жить в открытой вкладке, а не в постоянно работающем worker. Закрытие/заморозка рабочей вкладки останавливает их, как и у userscript; это не сервер мониторинга.

## Сборка и проверки

Исходники расширения: `hatiko/js/memchat/extension/`. Generated userscript вручную не редактировать.

Из `E:/gitreps/hatiko/js/memchat`:

```sh
# После обычной production-сборки memchat.user.js:
python extension/build.py
node --test tests/chrome-extension-*.test.js
node extension/smoke.cjs
npm test
```

`build.py` не пересобирает и не меняет userscript: получает уже собранный production input. Это позволяет не включать незавершённые src-изменения в extension release. Артефакты: `extension/dist/chrome-extension/` и `extension/dist/memchat-chrome.zip`. ZIP детерминированный; зависимости для Python-сборки не нужны.

Smoke использует уже установленный Playwright и отдельный временный headless Chromium профиль. Пути можно задать переменными `MEMCHAT_PLAYWRIGHT` и `MEMCHAT_CHROMIUM`. Он проверяет действительную загрузку пакета, popup, калькулятор, сохранение состояния, runtime HTTP channel, публичный GitHub redirect и live `hatiko.ru`; пользовательский профиль и бизнес-документы не меняет.

## Границы проверки первого релиза

- На момент старта в рабочем дереве были незакоммиченные изменения; production input взят без них. Его SHA-256 совпадал с текущим remote `memchat-dist/main/memchat.user.js`.
- Полный исходный test suite уже содержал один fail: `internal-order-settings-persistence.test.js`. Он сохранён как baseline, расширение его не исправляет.
- Авторизованные Panel-поиск/бонусы и API-записи МойСклад **не проверены end-to-end** без пользовательской сессии/ключа. Транспорт проверен отдельно, запись бизнес-данных не выполнялась.
- Исходный GitHub URL дополнительных замен расписания находится в приватном `hatiko`: анонимно возвращает 404. Существующий fallback к встроенным заменам сохранён; токен GitHub в пакет не добавляется.
