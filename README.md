# Хатико · Memchat для Chrome

Chrome Manifest V3, **8.9.0.10** (`8.9.0-chrome.10`), Chrome 120+. Tampermonkey и Node/Python для установки не нужны.

## Что изменилось

- Бизнес-функции разделены на закрытые модули с явными зависимостями и своим состоянием. Настройки проходят через key-scoped storage ports; вложенное изменение чужого snapshot не меняет его источник.
- Чистые расчёты калькулятора и парсинг расписания отделены от интерфейса/сети. Ошибка запуска второстепенной функции не останавливает остальные; окно сообщает, какие группы не запустились.
- Добавлены AST-проверки архитектурных границ и tests изоляции/state/lifecycle. Интерфейс, расчёты, точность процентов и прежние storage keys сохранены.
- Сохранены Panel recovery, private storage, прямой MS transport, единый фоновый опрос, toolbar и top-layer. Новых разрешений Chrome нет.

## Скачать

[Версионный ZIP 8.9.0.10](https://github.com/xtalia/memchat-dist/releases/download/chrome-v8.9.0.10/memchat-chrome.zip) · [Все релизы](https://github.com/xtalia/memchat-dist/releases)

Это распакованное расширение с GitHub, не публикация Chrome Web Store. Само обновление файлов не активирует их в Chrome.

## Обновить существующую установку

1. Запусти обновлятор рядом с **прежней** папкой chrome-extension:
   - Windows: `Update-Memchat.cmd` и соседний `Update-Memchat.ps1`.
   - macOS: `Update-Memchat.command` и соседний `update-memchat.sh`.
   - Linux: `bash /путь/к/update-memchat.sh`.
2. Дождись успешного результата.
3. На `chrome://extensions` нажми круглую стрелку **Перезагрузить** на карточке Memchat; проверь версию **8.9.0.10**.
4. Перезагрузи рабочие вкладки МойСклад, Bitrix24 и Hatiko, включая Panel при её использовании.

**Не удаляй расширение, не меняй путь и не устанавливай вторую копию:** это важно для сохранения extension ID и private settings/history. Папочный backup обновлятора содержит код, не данные Chrome.

Если updater очень старый и не понимает native build-info/V2, один раз скачай ZIP и замени только четыре соседних launcher-файла. Затем обновляй прежнюю chrome-extension; переустановка не нужна. Обновлятор не обновляет сам себя.

При другом пути установки:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./Update-Memchat.ps1 -TargetDirectory "D:/Tools/MyMemchat"
```

```sh
bash ./update-memchat.sh --target "/путь/к/установленной/папке"
```

## Установить впервые на другом ПК

1. Распакуй ZIP в постоянную папку, например `D:/Tools/Memchat` или `~/Applications/Memchat`.
2. Отключи Memchat production/DEV в Tampermonkey, если они установлены.
3. Открой `chrome://extensions` → включи **Режим разработчика** → **Загрузить распакованное расширение**.
4. Выбери внутреннюю папку **chrome-extension**, где лежит manifest.json, не ZIP и не родительскую папку.
5. Перезагрузи рабочие сайты. При необходимости настрой Bearer на этом ПК и войди в Panel в том же профиле Chrome.

Настройки/авторизация автоматически между ПК не синхронизируются. Не пересылай ключи в чат; они не входят в ZIP.

## Быстрая проверка после обновления

- Значок показывает/скрывает главное окно, не теряя введённый черновик.
- Скидка `142490-3156` показывает `2.214892273141975%` и итог `139334 руб.`.
- Быстрый переключатель очистки работает до открытия настроек; Enter очищает поле только во включённом режиме.
- «Сегодня/Завтра» загружаются, «Правила и замены» сохраняются после перезагрузки страницы.
- Проверяются bearer/panel и нужные уведомления; при входе в Panel используй тот же профиль Chrome.

Если проблема: пришли версию, сайт/вкладку, действие и текст ошибки/скриншот. Токены, телефоны и cookies в отчёт не включай.

## Поведение и безопасность

- Настройки, Bearer и безопасная история — в private chrome.storage.local с TRUSTED_CONTEXTS; origins/аккаунты разделены. Телефоны бонусов не сохраняются.
- Panel использует браузерную cookie-сессию. CSRF не восстанавливает истёкший вход. Сначала фоновая проверка; при необходимости — bounded recovery через уже открытую подходящую Panel-вкладку. Cookies/CSRF не копируются в постоянное хранилище; новые вкладки автоматически не открываются. Красный Panel-индикатор открывает сайт только по явному клику.
- MS-запросы extension идут без локальной очереди/caps/pacing/quota. Временно неуспешное чтение повторяется один раз; неоднозначные записи не переигрываются вслепую. Ключ проверяется на актуальность.
- Заказы опрашивает один worker alarm на профиль. Для UI/sound нужна подходящая живая вкладка и разрешение браузера на звук. Сон ОС может задерживать alarms.
- Окна используют top layer текущей вкладки, а не «поверх всех приложений» ОС. Toolbar скрывает только главное окно; ПКМ → сброс положения окон.
- Все executable scripts локальны. Изоляция модулей — не песочница от вредоносного кода; поля UI остаются DOM, а данные профиля доступны владельцу компьютера.
- Дополнительные удалённые замены расписания могут возвращать private GitHub 404; встроенный fallback сохранён.

## Обновлятор

Получает fixed publisher descriptor и versioned GitHub Release ZIP, проверяет SHA-256 архива/семи runtime-файлов, готовит staging и сохраняет предыдущую папку. При ошибке проверки старая установка не меняется; при ошибке замены выполняется восстановление. Не допускаются посторонняя папка, downgrade, небезопасный архив и параллельная замена того же target. Same-version no-op проверяет целостность; повреждение той же версии восстанавливается.

V2 runtime: manifest.json, build-info.json, config.js, content.js, worker.js, controls.js, icon.png. Launchers и README находятся рядом. Windows требует PowerShell 5.1/7; Bash-ветка — curl, unzip и shasum/sha256sum. Python/jq/Node не нужны. Не отключай Gatekeeper и не меняй глобальную PowerShell policy; при потере executable bit у доверенного .command можно выполнить chmod +x.

Hash — проверка целостности, не независимая подпись издателя. Профиль Chrome и его cookies updater не редактирует. Reload расширения и рабочих страниц остаётся ручным действием.

## Для разработки

Авторитетные исходники: js/memchat/src, modules.json и extension/source-manifest.json. Карта/правила — AGENTS.md и docs/extension-architecture.md в source repository. Extension builder не требует готового generated userscript.

Из js/memchat, с установленными development dependencies:

```text
node dev/build-loader.cjs --check
npm run check:architecture
npm test
python extension/build.py --output <empty-owned-output>
python -m unittest discover -s tests/updater -p "test_*.py"
```

Python builder — standard library; Node/jsdom/Acorn/eslint-scope и Playwright нужны только разработчику. Packaged smokes запускаются по инструкции архитектуры против точного нового output в owned headless Chromium. Пользовательский браузер и бизнес-документы не используются для тестовых записей.

## Границы проверки

Packaged UI/transport/recovery tests используют настоящий Chromium и явно синтетические HTTP/credentials. Это не авторизованный production E2E и не проверка установленного у пользователя браузера. Нативная macOS-проверка на Windows не заявляется. Точные фактические результаты релиза — в его verification record.
