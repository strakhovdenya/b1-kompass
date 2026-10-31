# Запуск, проверки и размещение

## Закреплённый стек

| Часть | Версия |
| --- | --- |
| Node.js | 24 LTS (`engines: >=24 <25`; CI на Node 24) |
| Next.js / React | 16.4.3 / 19.3.1 (App Router) |
| TypeScript | 5.9.3, `strict` |
| MUI | 7.3.11 (`@mui/material-nextjs` 7.3.10, `v16-appRouter`) |
| next-intl | 4.14.9 (без i18n-маршрутизации: язык хранится в гостевом сеансе) |
| Supabase | `@supabase/supabase-js` 2.118.0, CLI 2.122.0, PostgreSQL 17 |
| Тесты | Vitest 5.0.5, Playwright 1.64.1 |
| dark-factory | v0.1.3 (коммит `33fa44b`) |

Все версии закреплены точно; `package-lock.json` закоммичен. Монорепозиторий на npm workspaces: `apps/web`, `packages/domain`.

## Переменные окружения

Значения секретов не хранятся в Git. Сервер Next.js читает:

| Переменная | Где нужна | Что это |
| --- | --- | --- |
| `SUPABASE_URL` | сервер Next.js, скрипт загрузки | URL проекта Supabase |
| `SUPABASE_SECRET_KEY` | сервер Next.js, скрипт загрузки | секретный ключ (`sb_secret_…`, роль `service_role`). Никогда не публикуется в клиенте и не получает префикс `NEXT_PUBLIC_` |
| `PILOT_KEYS_FILE` | только скрипт загрузки | путь к приватному JSON с ключом, по умолчанию `private/pilot-keys.json` |

Браузеру в M1 ключи Supabase не нужны. Шаблон для локального запуска — `apps/web/.env.example`.

## Локальный запуск

Нужны Node.js 24, Docker и `npm`.

```sh
npm ci
npm run db:start                       # локальная Supabase в Docker, применяет supabase/migrations
npx supabase status -o env             # URL и ключи локальной Supabase
cp apps/web/.env.example apps/web/.env.local   # вписать API_URL и SECRET_KEY локальной Supabase
npm run seed:pilot                     # с SUPABASE_URL/SUPABASE_SECRET_KEY в окружении
npm run dev --workspace apps/web
```

Ключ задания для локальной загрузки: файл `private/pilot-keys.json` вида `{ "hoeren-1": "<вариант>" }`. Папка `private/` исключена из Git.

## Проверки

```sh
npm run typecheck     # tsc для packages/domain, apps/web и scripts
npm run lint          # ESLint, включая запрет импорта server/** и Supabase SDK из UI
npm test              # Vitest: domain и компоненты web
npm run build         # next build
npm run test:e2e      # Playwright против локальной Supabase и next start (нужен npm run build)
```

Playwright сам берёт URL и ключи из `supabase status`; рабочую облачную базу и секреты production тесты не используют. Перед прогоном `globalSetup` публикует реальное задание пилота через доверенный путь с тестовым ключом (ключ издателя в Git не хранится).

В CI (`.github/workflows/ci.yml`, workflow `CI`, job `Quality`) выполняются те же шаги на Node 24 с локальной Supabase в Docker; `continue-on-error` и пропуск шагов не используются. `Quality` указан как обязательная проверка в `.github/verifier/required-checks.json`.

## Облачное размещение

Используются отдельные от Cards ресурсы: один проект Supabase Free и один проект Vercel. Платные функции и собственный домен не подключаются.

### Supabase

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push        # применить supabase/migrations
npx supabase config push    # применить настройки Auth, в т. ч. enable_signup = false
```

После этого в Dashboard проверить: Authentication → Sign In / Providers → «Allow new users to sign up» выключено; Storage → бакет `exam-sources` приватный.

Доверенная начальная загрузка выполняется с компьютера владельца один раз:

```sh
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SECRET_KEY=<secret> npm run seed:pilot
```

### Vercel

- Root Directory: `apps/web`, Framework: Next.js, Node.js 24.x.
- Переменные `SUPABASE_URL` и `SUPABASE_SECRET_KEY` (Production и Preview), тип Sensitive.

## Фактический статус публикации

Состояние на 2026-10-31:

| Что | Статус |
| --- | --- |
| Проект Supabase `b1-kompass` (Free, `eu-central-1`) | ✅ создан, миграция применена `supabase db push` |
| Регистрация в облачном Auth | ✅ выключена в Dashboard (`/auth/v1/settings` → `disable_signup: true`). `supabase config push` не используется: он перенёс бы локальные dev-настройки Auth (`site_url`, подтверждение email) |
| Реальное задание пилота | ✅ опубликовано доверенной загрузкой с ключом издателя |
| Отказы publishable-ключа в облаке | ✅ 7 таблиц, запись балла, 3 функции, бакет `exam-sources` (чтение, список, загрузка), GraphQL — все отклонены |
| Проект Vercel `b1-kompass` | ✅ создан: Root Directory `apps/web`, Node.js 24.x, GitHub `strakhovdenya/b1-kompass`, переменные Production/Preview (sensitive) |
| Production URL `https://b1-kompass.vercel.app` | ⏳ появится после мержа приложения в `main`; работа не проверена |
| Проверка с телефона и компьютера | ⏳ не выполнена |

Успешная сборка не считается публикацией: статус обновляется только после реальной проверки по HTTPS.
