# Chrome Memchat 8.9.0.11 — native notifications, shared sound, toolbar bear

## Изменения

- Native notifications принадлежат worker, а не страницам. Один результат опроса — одно агрегированное системное уведомление и один общий сигнал; открытие новой subscriber-вкладки не повторяет immediate poll.
- Сигнал воспроизводит один скрытый offscreen AUDIO_PLAYBACK-документ. Прежний MP3 локально включён в audio-player.js как data URL; токены, business payload и сайт не управляют источником звука.
- Toolbar icon меняется на мишку при enabled и возвращается к обычному при выключении. Восстановление из session config, отключение/отмена позднего воспроизведения и ошибки presentation проверены отдельно.
- Старые page toasts/Audio/мишки не используются в native runtime. Standalone fallback сохранён. Native notification silent=true исключает второй системный beep поверх собственного сигнала.
- Добавлены notifications/offscreen permissions. Script CSP остаётся self-only без inline/eval. V3 содержит девять runtime-файлов; readers поддерживают точные V1/V2/V3 schemas.
- Обновлены архитектурная справка и AGENTS.md, без изменения чужого WIP и опубликованных userscript blobs.

## Реальные проверки

- Финальный обычный npm test: **280 passed, 0 failed**. DEV loader и AST gate **17 boundaries** прошли.
- Offline updater: **36 tests, OK, 1 skip** (Windows directory-symlink permission).
- Syntax source/production JS и воспроизводимость ZIP проверены. Все девять executable/runtime members релизной сборки побайтно совпадают с браузерно проверенным кандидатом; изменена только пользовательская README в ZIP.
- Девять packaged-browser suites прошли на этих runtime bytes: native-alerts, orders-service, updater upgrade, native regressions/Panel/schedule, private storage, settings/rules, direct MS, calculator discount, general/live smoke.
- На финальной релизной сборке повторены native-alerts, двухвкладочный orders-service, Windows updater и общий live smoke. Последний теперь прошёл GitHub-to-raw redirect, живой hatiko.ru и безопасную unauthenticated Panel проверку. Предыдущие network-timeout логи сохранены; transport/assertions ради результата не менялись.
- Реальные Chrome APIs: zero supported tabs → три concurrent poll callers → одна native notification и один audio-play; offscreen Audio readyState=4, paused=false, currentTime>0. Две content-вкладки дают один сигнал и ноль page toasts. Permission denial не подавляет звук; sound-off не создаёт offscreen; disable отменяет queued playback.
- Реальный in-place upgrade **8.9.0.10 → 8.9.0.11** и Reload через карточку chrome://extensions сохраняют path/extension ID, private calculator/history/clear preference.
- Точный состав ZIP — **14 members**: девять runtime, четыре launcher-файла и README.

## Артефакт

- Версия: `8.9.0.11` / `8.9.0-chrome.11`.
- ZIP: **366156 bytes**.
- SHA-256: `d00a66e691dff318c99249f86c866aba098e71dc327d3683084c32910495fb37`.
- Release target: https://github.com/xtalia/memchat-dist/releases/tag/chrome-v8.9.0.11

Post-upload read-back, immutable tag/ref и проверка публичного онлайн-обновлятора фиксируются отдельным release receipt после публикации; эти пункты не подменяются локальным green suite.

## Ограничения

- Один основной агент; self-review/diff/security scan, не независимый reviewer. Remote application CI отсутствовал; локальные проверки не называются GitHub Actions CI.
- Headless Chrome проверяет API, decode/playback и audio clock, а не физический динамик/видимый баннер ОС. Системные настройки звука, уведомлений и «Не беспокоить» могут скрывать оповещения.
- Браузер должен оставаться запущенным. Для опроса без страниц требуется session-конфигурация; после полного browser restart её снова задаёт поддерживаемая страница.
- Нет production business writes или авторизованного production-account E2E. HTTP/credentials оповещателя синтетические. Native macOS не проверялась; Git Bash на Windows не равен macOS.
- Это GitHub release unpacked-папки, не Chrome Web Store публикация.

## Обновление

Один раз скачать новый ZIP и заменить соседние launcher-файлы. Старый reader из .10 безопасно отвергает V3. Затем запустить новый updater против прежней папки, нажать Reload и обновить рабочие вкладки. Не удалять расширение и не менять путь/ID; backup кода не является backup private Chrome storage.

Source commit: `52d8a4caa02bb814b3c054b731ca04ed217906f4`.
