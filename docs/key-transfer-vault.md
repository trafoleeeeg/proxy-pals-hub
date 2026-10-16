# Локальное защищённое хранилище переноса ключа

Назначение: принять **прежний**, неизменённый `APP_ENCRYPTION_KEY` из
авторизованной временной серверной операции. Это не создание нового ключа,
не импорт базы и не перенос cookies. Рабочая Umbra и её профили не затрагиваются.

## Ограничения

- Только Windows, PowerShell **7.4+** и тот же Windows-пользователь, который
  подготовил запрос. Windows PowerShell 5.1 не поддерживается.
- В скрипте нет HTTP/API, логина Cloudflare, буфера обмена или сетевого push.
- Состояние привязано Windows DPAPI `CurrentUser`; его нельзя считать переносимой
  резервной копией. Потеря доступа к Windows-учётной записи/DPAPI может сделать
  его нечитаемым. Не удалять исходный секрет из Lovable.
- Явный отказ при существующем каталоге состояния, ссылках/reparse points,
  ослабленных ACL, истёкшем запросе, повторном приёме или неверном контейнере.
- Каталог получает права только текущего SID и SYSTEM. Администратор, вредоносный
  процесс от имени того же пользователя или отладчик всё равно могут получить
  доступ; это не защита от скомпрометированного ноутбука.
- Закрытый ключ, исходный секрет и расшифрованный payload существуют в памяти процесса.
  Временные byte buffers очищаются по возможности; .NET/JS строки, pagefile,
  антивирусные дампы и аварийные дампы не позволяют обещать физическое отсутствие
  любых следов в памяти/на накопителе. Открытые значения не пишутся в файлы,
  stdout/stderr, аргументы запуска, переменные окружения или clipboard.

## prepare

Родительская папка должна уже существовать и не быть ссылкой. Каталог состояния
должен быть **новым**, вне Git и не синхронизироваться в облако. Пример пути
ниже — только шаблон; выбрать разрешённый локальный каталог.

```powershell
pwsh -NoProfile -NonInteractive -File scripts/key-transfer-vault.ps1 `
  -Command prepare -StateDirectory C:\LOCAL-PRIVATE-PARENT\umbra-transfer.local
```

Файлы:

- `public-manifest.json` — единственный файл, который можно передавать на
  исходный сервер. Он содержит публичный SPKI, SHA-256 id публичного ключа,
  случайный UUID запроса, фиксированные source/target origins и TTL 30 минут.
- `private.dpapi` — закрытый RSA-3072 PKCS#8, защищённый DPAPI CurrentUser.
  Никогда не публиковать, не загружать на сервер и не добавлять в Git.

Подмена публичного manifest перед серверной активацией меняет получателя секрета.
Публичный ключ/его id должны быть закреплены в отдельно проверенной серверной
конфигурации, не приниматься из произвольного браузерного запроса.

## receive

Сохранённый сервером файл должен содержать только **зашифрованный контейнер**.
Не открывать его в редакторе, исполняющем содержимое; это входные данные.

```powershell
pwsh -NoProfile -NonInteractive -File scripts/key-transfer-vault.ps1 `
  -Command receive -StateDirectory C:\LOCAL-PRIVATE-PARENT\umbra-transfer.local `
  -EnvelopePath C:\LOCAL-PRIVATE-PARENT\encrypted-envelope.json
```

Скрипт проверяет точные schema/pins/сроки, OAEP-SHA256 (пустой label), GCM AAD
и синтетическую canary в существующем формате Umbra. После успешного приёма
создаётся `app-key.dpapi`. Исходный файл контейнера не изменяется. Повторный приём
не перезаписывает уже принятый ключ. Никаких других сервисов скрипт не меняет.

`APP_ENCRYPTION_KEY` не `trim`-ится и не нормализуется: даже перевод строки или
пробел участвует в SHA-256 в `crypto.server.ts`. Canary проверяет совместимость
криптографии с точными байтами ключа; **не** подтверждает полноту экспорта базы,
наличие Facebook-сессии или действительность cookies у внешнего сайта.

## Контракт контейнера

Manifest:

```text
format = umbra-key-transfer-request-v1
transferId, keyId, sourceOrigin, targetOrigin, createdAt, expiresAt, publicKeySpki
```

Контейнер имеет ровно поля:

```text
format = umbra-key-transfer-v1
transferId, keyId, sourceOrigin, targetOrigin, issuedAt, expiresAt,
wrappedKey, iv, tag, ciphertext
```

`keyId`: lowercase SHA256hex DER SPKI. Dates: UTC `YYYY-MM-DDTHH:mm:ss.sssZ`.
`wrappedKey`: RSA3072 OAEP SHA256, default empty label, случайный AES-ключ 32 bytes.
`iv`: 12 bytes, `tag`: 16 bytes. Все бинарные поля — canonical standard base64.
AES256GCM AAD — UTF8 байты **компактного JSON массива** ровно в таком порядке:

```text
[format, transferId, keyId, sourceOrigin, targetOrigin, issuedAt, expiresAt]
```

Расшифрованный JSON имеет ровно
`{secretName:'APP_ENCRYPTION_KEY', secret:<исходная строка>, canary:{plain,encrypted}}`.
Canary `plain` — только свежая случайная синтетическая строка 16–512 символов,
никогда реальные cookies. `encrypted` — `base64(iv).base64(tag).base64(ciphertext)`
по AES256GCM с `SHA256(UTF8(secret))`, без AAD как в существующем `encryptSecret`.

## Следующий отдельный этап: Cloudflare

Сетевой push намеренно **не реализован** до проверки конкретного Cloudflare
account/project, авторизации CLI и явного подтверждения целевого окружения.
Не обходить блокировку доступа к браузеру/аккаунту через CLI или другой API.
Установка/авторизация Wrangler этим скриптом не выполняется.

Контракт будущего helper: расшифровать `app-key.dpapi` только в памяти и передать
один JSON `{ "APP_ENCRYPTION_KEY": <точная исходная строка> }` через **pipe stdin**
закреплённому, проверенному Wrangler CLI, запущенному напрямую без shell:

```text
node <absolute-pinned-wrangler-entry> pages secret bulk
  --project-name proxy-pals-hub --env production
```

Не передавать ключ в argv, env, временном JSON, stdout или через clipboard.
`pages secret put` здесь не подходит: Wrangler вызывает `trimTrailingWhitespace`
и может изменить ключ. `secret bulk` с компактным JSON сохраняет строку целиком.
Пустой/невалидный ключ отклонять **до** запуска CLI. stdout/stderr CLI должны быть
перехвачены, не пересылаться в чат автоматически; ошибки выводить обезличенно.
Успех CLI — только запись секрета, не доказательство полной миграции.

Источники для проверки реализации (не команды к исполнению):

- [Официальные команды Wrangler Pages](https://developers.cloudflare.com/workers/wrangler/commands/pages/).
- [Pages secret put/bulk: официальный исходник](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/secret/index.ts).
- [Парсер bulk stdin JSON](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/parse-bulk-input.ts).

После записи секрета надо отдельно проверить восстановленную базу, авторизацию,
расшифровку записей **без вывода их содержимого**, завершённые очереди сохранения
и обновлённый desktop URL. Старый источник не отключать до этих проверок.
