# Локальное защищённое хранилище переноса ключа

Назначение: принять **прежний**, неизменённый `APP_ENCRYPTION_KEY` из
авторизованной временной серверной операции. Это не создание нового ключа,
не импорт базы и не перенос cookies. Рабочая Umbra и её профили не затрагиваются.

## Ограничения

- Только Windows, PowerShell **7.4+** и тот же Windows-пользователь, который
  подготовил запрос. Windows PowerShell 5.1 не поддерживается.
- В `key-transfer-vault.ps1` нет HTTP/API, логина Cloudflare, буфера обмена или
  сетевого push. Отдельный helper Cloudflare описан ниже; он не запускается
  автоматически после `receive`.
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
  -Command prepare -StateDirectory D:\LOCAL-PRIVATE-PARENT\umbra-transfer.local
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
  -Command receive -StateDirectory D:\LOCAL-PRIVATE-PARENT\umbra-transfer.local `
  -EnvelopePath D:\LOCAL-PRIVATE-PARENT\encrypted-envelope.json
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

## Отдельный этап: DPAPI → Cloudflare

Реализация `scripts/key-transfer-cloudflare.ps1` подготовлена отдельно от vault.
Добавление helper в репозиторий **не является выполнением push**. Использовать
его можно только после разрешённой проверки доступа к Cloudflare и явного
подтверждения записи в Production. Не обходить блокировку доступа к аккаунту
через CLI или другой API. Скрипт не устанавливает программы, не выполняет login,
не открывает браузер, не публикует сборку и не меняет базу.

Закреплён единственный получатель:

- Account: `783398cd847a9aa13275dfab6ab2df2c`.
- Pages project: `proxy-pals-hub`, проверяется также `proxy-pals-hub.pages.dev`.
- Environment: `production`; Preview намеренно не поддерживается.
- Только один secret: `APP_ENCRYPTION_KEY`.
- Wrangler **4.151.1**, прямой entry `wrangler-dist/cli.js` с SHA-256
  `a1b3cf7023a53d0d7f7ca4a183f2f904573cdb00737cd1a034890207431f1d8e`.

Версия и hash взяты из проверенного локального пакета, полученного из официального
npm registry. Integrity пакета:
`sha512-OAsa9UAHZshM6mq2PXcVoyxXgWThAanZMBc/IirtqEWd/BauRtmUKzAniOu/pU0pd3pxKuMZ2vsbF4eo6RiNDA==`.
Обновление Wrangler требует отдельной проверки и изменения pins, а не `latest`.
Helper требует также абсолютный путь и заранее независимо проверенный SHA-256
`node.exe`; не выбирать исполняемый файл через PATH. Hash одного CLI-entry не
проверяет все его внешние зависимости: установленный пакет/dependency tree
должны находиться в контролируемом каталоге, не доступном посторонним на запись.

Новые tools/cache/temp/work directories размещать на D:, например
`D:\Codex\tools`, `D:\Codex\cache`, `D:\Codex\workspaces\umbra-key-transfer`.
`WorkingDirectory` должен уже существовать на D:, не быть ссылкой и не иметь
Wrangler/config/.env в цепочке родителей. Helper создаёт в нём отдельный
защищённый каталог с UUID; public CLI cache/временные данные остаются там для
проверки. Он не удаляет произвольные пользовательские каталоги и не меняет
Windows-wide TEMP. Уже существующий OAuth credential store не переносится.
Для отдельно настроенной CLI-авторизации явно передавать существующие
`WranglerConfigDirectory` и `WranglerCacheDirectory` на D:, например
`D:\Codex\cache\cloudflare-config` и `D:\Codex\cache\cloudflare`.
Они становятся дочерними `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`; сам helper не открывает
и не печатает файлы токенов. Предыдущий login обязан использовать ту же config
папку. Токены/credentials не копируются между расположениями автоматически.

### Сначала preflight

Значения Node-path/hash ниже — **шаблон**, не команда с готовыми разрешениями:

```powershell
pwsh -NoProfile -NonInteractive -File scripts/key-transfer-cloudflare.ps1 `
  -Command preflight `
  -StateDirectory D:\LOCAL-PRIVATE-PARENT\umbra-transfer.local `
  -WorkingDirectory D:\Codex\workspaces\umbra-key-transfer `
  -WranglerConfigDirectory D:\Codex\cache\cloudflare-config `
  -WranglerCacheDirectory D:\Codex\cache\cloudflare `
  -NodePath '<absolute-reviewed-node.exe>' -NodeSha256 '<reviewed-node-sha256>' `
  -WranglerEntry D:\Codex\tools\wrangler-4.151.1\node_modules\wrangler\wrangler-dist\cli.js `
  -WranglerEntrySha256 a1b3cf7023a53d0d7f7ca4a183f2f904573cdb00737cd1a034890207431f1d8e `
  -WranglerVersion 4.151.1
```

Preflight запускает только закреплённый CLI напрямую: `--version`,
`whoami --json`, `pages project list --json`. stdout/stderr перехвачены;
email, SID и списки других проектов не выводятся. Ключ не расшифровывается.
Отсутствующая/неподходящая CLI-авторизация — отказ, не автоматический login.
Работает с уже настроенным OAuth store; env API-token и нестандартные endpoint,
proxy, NODE_OPTIONS не наследуются. Если нужны иные способы авторизации,
остановиться и согласовать их отдельно.

### Затем отдельно подтверждённый push

После согласования **конкретной production-записи** повторить те же аргументы с
`-Command push -ConfirmProductionKeyWrite`. Наличие переключателя не заменяет
разрешение человека непосредственно перед выполнением. Без переключателя
`push` отклоняется ещё до проверки путей и запуска CLI.

Helper повторяет preflight **до** DPAPI Unprotect. Затем проверяет reparse points,
owner=current SID, protected DACL с двумя full-control allow principals (SID и
SYSTEM) у vault и `app-key.dpapi`. DPAPI `CurrentUser` расшифровывает исходные
байты только в памяти. Строгий UTF-8 encoder формирует компактный JSON напрямую
из bytes — без `Trim`, нормализации и дополнительного перевода строки:

```text
{"APP_ENCRYPTION_KEY": <точная исходная строка>}
```

JSON передаётся только через pipe stdin в прямой дочерний процесс:

```text
node <absolute-pinned-wrangler-entry> pages secret bulk
  --project-name proxy-pals-hub --env production
```

`pages secret put` не используется: он обрезает завершающие whitespace, в отличие
от bulk JSON. Нет secret argv/env/файла/clipboard; output CLI не пересылается
пользователю. Дисковые Wrangler logs и telemetry явно выключены
(`WRANGLER_WRITE_LOGS=false`, `WRANGLER_SEND_METRICS=false`); одного
`WRANGLER_LOG=none` для отключения disk logs недостаточно. Буферы очищаются по
возможности, но pipe buffers, память Node/ОС, debugger/crash dumps и код от того
же Windows-пользователя остаются в модели риска.

На каждый процесс установлен timeout 45 секунд и предел stdout/stderr 256 КиБ;
таймаут/ошибка завершают process tree, выводят только фиксированный stage и
не вызывают retry. Если API успел принять запись перед обрывом, результат может
быть неопределённым: helper **не обещает rollback**. Исходный секрет Lovable и
DPAPI vault не удаляются. Успешный exit CLI подтверждает только запись секрета,
не правильную runtime-расшифровку данных и не завершение миграции.

Источники для проверки реализации (не команды к исполнению):

- [Официальные команды Wrangler Pages](https://developers.cloudflare.com/workers/wrangler/commands/pages/).
- [Pages secret put/bulk: официальный исходник](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/secret/index.ts).
- [Парсер bulk stdin JSON](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/deploy/helpers/parse-bulk-input.ts).
- [Wrangler identity JSON](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/user/whoami.ts).
- [Pages project list JSON](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/projects.ts).
- [Wrangler logging controls](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/logger.ts).

После записи секрета надо отдельно проверить восстановленную базу, авторизацию,
расшифровку записей **без вывода их содержимого**, завершённые очереди сохранения
и обновлённый desktop URL. Старый источник не отключать до этих проверок.

## Ограниченная диагностика исходного экспорта

Для временной операции владелец прямо согласовал абсолютное 30-минутное окно:
`2026-10-16T19:53:18.730Z` — `2026-10-16T20:23:18.730Z` и получателя с keyId
`e6750e281ca21ac245b67ffe1c7426747b9fb54ad196546325f99280f37da29a`.
Затем владелец отдельно прямо продлил только этот же закреплённый получатель
до `2026-10-16T21:00:00.000Z` (04:00 по времени ноутбука), после зелёных проверок.
Исходный createdAt не меняется, новый срок абсолютный и не продлевается автоматически.
После защищённого локального получения контейнера canary и DPAPI-проверка
успешно завершены; временная операция выключена (`enabled: false`, `request: null`),
публичный получатель удалён из runtime-конфигурации. Это подтверждает получение
ключа, но **не** завершение миграции базы, авторизации и рабочего приложения.
Наличие диагностического кода **не** продлевает согласование; другое окно или
получатель требуют нового прямого разрешения. Тест проверяет fail-closed даже
внутри прежнего окна, отсутствие получателя и нулевое число чтений ключа.

До полного прохождения password AMR, online Auth, superadmin, source URL/Origin,
HTTP и pinned recipient/expiry проверок сохраняются прежние generic auth/error
semantics. Переменная ключа не читается, диагностические коды не выдаются.
Только уже авторизованный владелец внутри действующего окна может получить:

| Код | Доказанный этап отказа, не содержимое ошибки |
| --- | --- |
| `source_key_unavailable` | Исходный runtime не вернул ключ или отказал в доступе к переменной |
| `crypto_import_failed` | Не удалось загрузить серверный crypto/canary модуль |
| `canary_failed` | Не удалось создать случайную синтетическую canary или зашифровать её |
| `seal_failed` | Не удалось сформировать зашифрованный контейнер |

Это конечный allowlist, не `exception.message`, cause, fingerprint ключа, размер
или значение секрета. Guard expiry/password/HTTP перепроверяется перед возвратом
результата; истечение во время crypto остаётся generic отказом. Код сам по себе
не доказывает причину на уровне провайдера и не изменяет ключ или данные.

RPC возвращает `{ok: true, envelope}` либо `{ok: false, code}`. Панель скачивает
**только `envelope`**, поэтому формат файла для `receive` остался прежним. После
обновления панели следует перезагрузить страницу перед новой попыткой. Ошибка
запуска browser download имеет отдельный UI-код `download_failed`, не смешивается
с серверным отказом. Панель не может подтвердить фактическое сохранение файла
на диске: после передачи запроса браузеру нужно проверить его вручную.

Создание контейнера использует WebCrypto AES-256-GCM (ключ 256 бит, IV 96 бит,
tag 128 бит и прежний точный JSON tuple AAD) и RSA-OAEP SHA-256 с пустым label.
Импортированные AES/RSA ключи nonextractable; plaintext byte buffer очищается
в finally. Формат контейнера и существующая .NET/DPAPI-проверка не меняются;
никаких fallback к SHA-1, PKCS#1 v1.5 или отсутствующему AAD нет.
