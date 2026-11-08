# Chrome Memchat 8.9.0.10 — module isolation verification

## Изменения

- Нумерованные общие исходники заменены feature factories с собственным закрытым состоянием, явными per-symbol ports и composition root.
- Calculator/schedule domain отделены от UI/transport; исходящие data snapshots копируются/замораживаются, входящие settings/state копируются.
- Key-scoped storage capabilities поверх прежнего private storage, без изменения persisted schema/keys.
- Независимые startup-группы и обезличенный статус ошибки; field-clear dispose/remount с отменой pending timers и global listeners.
- AST/dependency/composition/storage-key gates, negative tests, актуальная архитектура и AGENTS.md.
- UI/business formulas, полный вывод процентов, Panel recovery, MS direct transport, notifier alarms/subscribers, update path/ID/private storage сохранены. Legacy order-check не включён в native diagnostics.

## Фактические проверки

- Baseline: обычный `npm test` — 256/256.
- Финальный обычный `npm test` — **270 passed, 0 failed**, без test-concurrency workaround.
- AST architecture/composition gate — **17 boundaries**, negative ambient-credential/foreign-port/read-only-write/wrong-owner/storage-key tests passed.
- Syntax: **40** source/runtime/tool/built JS files; DEV loader check; standalone source builder в scratch — passed.
- Offline updater suite: **34 tests, OK, 1 skip** (Windows directory symlink permission).
- Semantic extraction audit: **401** прежнее определение найдено, **393** совпали по нормализованному AST, **8** явных изменений проверены отдельно; missing/unexpected = 0. Удалённые source-файлы не оставлены второй копией business logic.
- Reproducible ZIP: две независимые сборки совпали побайтно; ровно 12 ZIP members, включая прежние семь runtime-файлов. Production bundle не содержит тестового eval/window API.
- Packaged Chromium **151.0.7922.34**: native regression (Panel fallback/419/cold-start clear/schedule/restart), private storage/migration/origins/cross-tab, settings/rules, orders service/alarm, MS direct concurrency/retry/credential change/stop-wake, calculator precision, general UI/top-layer/modal/fullscreen/live public site и updater upgrade — passed.
- Реальный Windows updater **8.9.0.9 → 8.9.0.10**, затем actual extension-card Reload: прежний ID, calculator mode/history и private clear preference сохранены.
- Изменённые header/rules UI просмотрены на скриншотах; видимых ошибок компоновки не обнаружено.

### Зафиксированная проблема harness

Один финальный orders smoke сначала остановился: persistent startup fixture toast перекрыл кнопку вкладки. Лог сохранён; это не выдано за успешный первый прогон. Fixture теперь явно имеет ноль matching orders во время bootstrap, а известные matching orders появляются в измеряемой фазе. Startup polling не выключается, реальный click/доставка/toast/alarm assertions сохранены, force-click/DOM removal не использованы. Исправлен и повторно пройден именно harness; runtime notifier/UI ради зелёного результата не менялись.

## Пакет

- Версия: `8.9.0.10` / `8.9.0-chrome.10`.
- ZIP: **320295 bytes**.
- SHA-256: `f2fe3e7ad420f792dd219d82b98640d23a366fbcce54b5d80918bd7c7e562f82`.
- Release: https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.10
- Asset: https://github.com/xtalia/memchat-dist/releases/download/chrome-v8.9.0.10/memchat-chrome.zip
- Проверенный source baseline: `1216ea0848dcdc631d39edf75f7f6b68c7ecf051`; итоговый source commit публикуется отдельно от immutable dist artifact и descriptor.

Ссылки выше задают адрес публикуемого релиза, а не заменяют post-upload read-back. Доказательства публикации/online updater фиксируются после загрузки отдельно.

## Ограничения и безопасность

- Работа выполнена основным агентом; review — собственный diff/AST/contract review, не независимый агент.
- Remote application CI отсутствовал; локальные фактические проверки не называются GitHub Actions CI.
- Авторизованный production Panel E2E и MS business writes не выполнялись. HTTP/credentials в соответствующих browser scenarios синтетические; публичный hatiko.ru и безопасный unauthenticated Panel проверялись отдельно.
- Нативная macOS-проверка не заявляется. Bash tests на Windows не равны тесту на Mac.
- Legacy simple calculator и его CSP-ограничения не перерабатывались; новая domain extraction не объявляется новым expression engine.
- Private данные/токены/пользовательский Chrome не изменялись. Standalone опубликованные userscript blobs сохранены, их новый source build проверен только в scratch.
- GitHub Release не является Chrome Web Store публикацией. Обновление дисковых файлов и Chrome Reload — разные действия.

## Проверка на другом ПК

Обновить прежнюю папку через updater, нажать Reload на карточке Memchat и обновить рабочие вкладки. Для новой установки распаковать ZIP в постоянное место и Load unpacked внутреннюю chrome-extension. Не удалять существующее расширение и не менять его путь. Версию проверять на chrome://extensions; header core может показывать исходную версию общей бизнес-логики.

Проверить toggle/черновик, скидку 142490-3156, очистку до открытия настроек, сохранение rules/replacements, расписание и нужные bearer/panel/notifier сценарии. Сессии/ключи между ПК автоматически не переносятся.

Source commit: `3f805533fc3d66e937d3d786bf8f2d129f3d8e7a`.
