# Подключение агентов к Umbra

Два независимых канала доступа: **код** (GitHub) и **данные** (API с ключом).
Они не мешают друг другу и настраиваются отдельно.

---

## 1. Код

```bash
git clone https://github.com/trafoleeeeg/proxy-pals-hub.git
cd proxy-pals-hub
bun install
```

Правила работы, чтобы не конфликтовать (подробно — в `../AGENTS.md`):

- своя ветка на задачу: `agent/<имя>/<задача>`;
- в `main` только через Pull Request, с зелёной проверкой;
- никакого `--force`, `rebase` и `amend` по отправленным коммитам;
- перед пушем: `bunx tsgo --noEmit`.

## 2. Данные

Владелец создаёт ключ в панели: **Агенты → Новый ключ**. Ключ показывается один раз.

Базовый адрес: `https://proxy-pals-hub.lovable.app/api/public/agent`

Заголовок на каждый запрос:

```
Authorization: Bearer umbra_live_...
```

### Проверка ключа

```bash
curl -H "Authorization: Bearer $UMBRA_KEY" \
  https://proxy-pals-hub.lovable.app/api/public/agent/me
```

### Профили

```bash
# список
curl -H "Authorization: Bearer $UMBRA_KEY" \
  https://proxy-pals-hub.lovable.app/api/public/agent/profiles

# создать 5 профилей в папке «Рабочие», привязав прокси
curl -X POST -H "Authorization: Bearer $UMBRA_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Магазин","folder":"Рабочие","count":5,"country":"DE","proxyId":null}' \
  https://proxy-pals-hub.lovable.app/api/public/agent/profiles

# переименовать / удалить
curl -X PATCH  ... /api/public/agent/profiles/<id> -d '{"name":"Новое имя"}'
curl -X DELETE ... /api/public/agent/profiles/<id>
```

### Прокси

```bash
curl -H "Authorization: Bearer $UMBRA_KEY" \
  https://proxy-pals-hub.lovable.app/api/public/agent/proxies

curl -X POST -H "Authorization: Bearer $UMBRA_KEY" -H "Content-Type: application/json" \
  -d '{"protocol":"socks5","host":"1.2.3.4","port":1080,"username":"u","password":"p","country":"DE"}' \
  https://proxy-pals-hub.lovable.app/api/public/agent/proxies
```

### Права

| Право | Что даёт |
| --- | --- |
| `profiles:read` | список профилей |
| `profiles:write` | создание, правка, удаление профилей |
| `proxies:read` | список прокси (без паролей) |
| `proxies:write` | добавление прокси |
| `team:read` | состав команды |

### Чего API не делает намеренно

- Не отдаёт пароли прокси и cookies профилей — ни при каких правах.
- Не управляет составом команды и доступами сотрудников.
- Не больше 120 запросов в минуту на ключ.
- Каждое действие агента попадает в журнал и видно в панели.

Ключ можно отозвать в любой момент: **Агенты → Отозвать**.
