# Panel Hatiko Bridge

Вспомогательный userscript, работающий **внутри** `panel.hatiko.ru`.

## Зачем

`panel.hatiko.ru` отдаёт anti-bot заглушку любому кросс-доменному запросу (в том числе через `GM_xmlhttpRequest`), поэтому основной «Мемный чат» не может получить CSRF-токен в фоне: токен появляется только после ручного открытия/обновления вкладки Panel.

Bridge живеёт на странице самой панели, где сессия и куки уже настоящие, и отдаёт токен основному скрипту по `postMessage`.

## Схема

```text
Мемный чат (online.moysklad.ru / *.hatiko.ru)
        │  postMessage { source:'memchat-main', type:'panel-token-request' }
        ▼
Panel Bridge (panel.hatiko.ru/*)
        │  читает <meta name="csrf-token">
        ▼
postMessage { source:'hatiko-panel-bridge', type:'panelCsrfResponse', ok, authorized, token }
```

## Установка

1. Установите `panel-htb-bridge.user.js` в Tampermonkey.
2. Он сработает автоматически, когда вы открываете любую страницу `panel.hatiko.ru`.
3. Основной скрипт должен быть обновлён до версии, поддерживающей bridge (ищи токен через bridge, с fallback на прямой запрос).

## Безопасность

- Bridge отвечает только отправителям с разрешённых `origin` (`online.moysklad.ru`, все `*.hatiko.ru`).
- Не передаёт куки; токен — то же значение, что видно в DOM панели.
- @grant none, никаких GM_* привилегий.

## Заметки

- Если вкладка Panel не открыта, основному скрипту нужно будет открыть её (через iframe/окно) либо оставить старый фрагмент доступа к токену.
- Скрипт работает на странице панели независимо от того, сделан ли пользователь авторизованным (окно проверки `authorized` показывает статус).