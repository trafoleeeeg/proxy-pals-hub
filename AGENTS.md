<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

# Umbra — инструкция для агентов (Claude Code, Codex, Astra)

Umbra — антидетект-браузер: веб-панель управления + Electron-клиент под Windows.
Общение с владельцем проекта — только на русском языке.

## Стек

- TanStack Start v1 (React 19, Vite 7), файловый роутинг в `src/routes/`.
- Tailwind CSS v4 через `src/styles.css` (без `tailwind.config.js`).
- Бэкенд — Lovable Cloud (Supabase): БД, auth, RLS.
- Electron-клиент — каталог `desktop/`, сборка через GitHub Actions.

## Карта проекта

| Путь | Что там |
| --- | --- |
| `src/routes/auth.tsx` | Вход/регистрация, только email+пароль |
| `src/routes/_authenticated/` | Панель: профили, прокси, команда, приложение |
| `src/lib/*.functions.ts` | Серверные функции (`createServerFn`) — вся бизнес-логика |
| `src/lib/desktop.ts` | Мост между панелью и Electron (`window.umbra`) |
| `desktop/main.cjs` | Главный процесс Electron, IPC, автообновление |
| `desktop/launcher.cjs` | Запуск профиля: сессия, прокси, отпечаток, cookies |
| `desktop/proxy-check.cjs` | Проверка прокси внутри приложения (включая SOCKS5) |
| `supabase/migrations/` | Миграции БД |
| `.github/workflows/desktop-windows.yml` | Сборка `.exe` по тегу `vX.Y.Z` |

## Жёсткие правила

1. **Не трогать** `src/routeTree.gen.ts`, `src/integrations/supabase/*`, `.env`,
   `supabase/config.toml` — это генерируемые файлы.
2. **Авторизация только email+пароль.** Google OAuth удалён намеренно, не возвращать.
3. **Схему БД менять только миграциями** в `supabase/migrations/`. Каждая новая
   таблица в `public`: `CREATE TABLE` → `GRANT` → `ENABLE ROW LEVEL SECURITY` → политики.
   Без `GRANT` таблица недоступна приложению.
4. **Секреты** (`APP_ENCRYPTION_KEY` и пр.) читать только внутри `.handler()`
   серверных функций через `process.env`. Никогда не в браузерном коде.
5. Пароли прокси и cookies профилей шифруются AES-256-GCM (`src/lib/crypto.server.ts`).
   Не логировать и не отдавать их в браузер в открытом виде.
6. Роутер — только TanStack Router. `react-router-dom` не ставить.
7. Дизайн — тёмная тема в стиле Vision. Цвета брать из токенов в `src/styles.css`,
   не хардкодить `bg-black` / `text-white`.

## Проверка перед пушем

```bash
bun install
bunx tsgo --noEmit
node --check desktop/main.cjs && node --check desktop/launcher.cjs \
  && node --check desktop/preload.cjs && node --check desktop/proxy-check.cjs
```

## Выпуск новой версии клиента

1. Поднять `version` в `desktop/package.json`.
2. Запушить в `main`.
3. Создать тег `vX.Y.Z` и релиз на GitHub — Actions соберёт `Umbra-X.Y.Z-x64.exe`
   и `latest.yml`, установленные клиенты обновятся сами.

Не удалять из `desktop/package.json` → `build.nsis.deleteAppDataOnUninstall: false`:
иначе обновление сотрёт профили и сессии пользователей.
