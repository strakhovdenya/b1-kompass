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
| Vercel CLI (только `Release Production`) | 65.11.0, закреплён в workflow |

Все версии закреплены точно; `package-lock.json` закоммичен. Монорепозиторий на npm workspaces: `apps/web`, `packages/domain`.

## Переменные окружения

Значения секретов не хранятся в Git. Сервер Next.js читает:

| Переменная | Где нужна | Что это |
| --- | --- | --- |
| `SUPABASE_URL` | сервер Next.js, скрипт загрузки | URL проекта Supabase |
| `SUPABASE_SECRET_KEY` | сервер Next.js, скрипт загрузки | секретный ключ (`sb_secret_…`, роль `service_role`). Никогда не публикуется в клиенте и не получает префикс `NEXT_PUBLIC_` |
| `GUEST_SESSIONS_PER_MINUTE` | сервер Next.js, необязательна | сколько новых гостевых сеансов в минуту разрешено на весь сайт; по умолчанию 30, неверное значение тоже даёт 30. E2E-сервер запускается с тестовым значением из `apps/web/tests/support/env.ts` |
| `PRACTICE_EXAM_SLUG` | сервер Next.js, необязательна | slug экзамена по умолчанию: его выбор открывает «Continue as guest», на его активную попытку ведут старые `/practice` и `/practice/lesen`; по умолчанию пилот `telc-ajf-b12-dtz`. Начатую попытку не выбирает: она открывается по своему адресу. E2E-серверы задают тестовые комплекты (`test-full-dtz`, пара Teil 3) |
| `APP_ORIGIN` | сервер Next.js; обязательна в Production | один точный origin сайта (схема, хост, порт при необходимости; без пути, query, учётных данных и `*`), например `https://<домен-сайта>`. Команды (`POST /api/attempts/*`) принимаются только с этим `Origin`. Задана — действует в любом окружении; некорректное значение — ошибка настройки и отказ мутаций. Не задана: в Preview (`VERCEL_ENV=preview`) берётся `https://` + `VERCEL_URL`, в Production и любом другом окружении мутации отклоняются. Host и forwarded-host запроса не используются; алиас ветки без явной `APP_ORIGIN` не доверяется. Не секрет, но и не `NEXT_PUBLIC_`: читается только в `server/next`. E2E: каждый из трёх серверов получает свой `http://localhost:3100`, `:3101`, `:3102` |
| `PILOT_KEYS_FILE` | только скрипты загрузки | путь к приватному JSON с ключом, по умолчанию `private/pilot-keys.json` |
| `PILOT_AUDIO_FILE` | только скрипты загрузки | путь к оригинальной записи у владельца (`.mp3`, `.wav`, `.m4a` или `.ogg`), например `private/track-127.mp3`. Обязательна, значения по умолчанию нет |
| `PILOT_CONTENT_FILE` | только `publish:pilot` | путь к подготовленному JSON полного пилота, по умолчанию `private/pilot-content.json` |
| `PILOT_DRAFT_FILE`, `PILOT_OUT_DIR` | только `prepare:pilot` | черновик пилота (по умолчанию `private/pilot-draft.json`) и папка результата (по умолчанию `private`) |

Браузеру в M1 ключи Supabase не нужны. Шаблон для локального запуска — `apps/web/.env.example`.

## Локальный запуск

Нужны Node.js 24, Docker и `npm`.

```sh
npm ci
npm run db:start                       # локальная Supabase в Docker, применяет supabase/migrations
npx supabase status -o env             # URL и ключи локальной Supabase
cp apps/web/.env.example apps/web/.env.local   # вписать API_URL и SECRET_KEY локальной Supabase
npm run seed:pilot                     # с SUPABASE_URL, SUPABASE_SECRET_KEY и PILOT_AUDIO_FILE в окружении
npm run dev --workspace apps/web
```

Ключ короткого набора для локальной загрузки: файл `private/pilot-keys.json` вида `{ "hoeren-1": "<вариант>", "hoeren-2": "…", "hoeren-3": "…", "hoeren-4": "…" }`: ровно один ответ на каждое задание, иначе загрузка отклоняется. Запись лежит рядом, например `private/hoeren-teil-1.mp3`. Папка `private/` исключена из Git; ни ключ, ни аудио не коммитятся.

## Выдача аудио

- Запись хранится объектом приватного бакета `exam-sources` по пути `audio/<sha256>.<ext>`. Путь вычисляется из байтов: тот же файл загружается один раз, изменённый файл не перезаписывает запись опубликованной версии. Связь версии и записи — таблица `exam_version_audio`.
- Публичного бакета и политик `storage.objects` нет: publishable-ключ не читает, не перечисляет и не загружает объекты.
- Браузер получает запись в два шага. Сначала server action `resolveAudioAction` вызывает `server/audio`: проверка гостевого сеанса → попытка принадлежит сеансу → дорожка относится к версии этой попытки. Затем сервер выдаёт подписанный URL Storage со сроком 10 минут (`AUDIO_URL_TTL_SECONDS`). Байты браузер читает прямо из Supabase Storage, с Range-запросами для перемотки; Next.js байты не проксирует.
- Подписанный URL — служебный адрес: он отдаётся только владельцу попытки в ответе действия, не попадает в начальный HTML и не пишется в логи. При ошибке сервер логирует только причину, без URL; путь объекта браузеру не отдаётся. После истечения срока плеер запрашивает новый URL и продолжает с той же позиции.
- Секретный ключ, ключ ответов и URL облачного проекта со служебными параметрами не публикуются в Git, логах и клиентском бандле.

## Проверки

```sh
npm run typecheck     # tsc для packages/domain, apps/web и scripts
npm run lint          # ESLint, включая запрет импорта server/** и Supabase SDK из UI
npm test              # Vitest: domain и компоненты web
npm run build         # next build
npm run test:e2e      # Playwright против локальной Supabase и next start (нужен npm run build)
node --test scripts/release/gate.test.mjs   # release gate ручного CD (#56), без сети и секретов
```

Playwright сам берёт URL и ключи из `supabase status`; рабочую облачную базу и секреты production тесты не используют. Перед прогоном `globalSetup` публикует реальное задание пилота через доверенный путь с тестовым ключом (ключ издателя в Git не хранится).

В CI (`.github/workflows/ci.yml`, workflow `CI`, job `Quality`) выполняются те же шаги на Node 24 с локальной Supabase в Docker; `continue-on-error` и пропуск шагов не используются. `Quality` указан как обязательная проверка в `.github/verifier/required-checks.json`.

## Облачное размещение

Используются отдельные от Cards ресурсы: один проект Supabase Free и один проект Vercel. Платные функции и собственный домен не подключаются.

### Supabase

Первичная настройка проекта владельцем с его компьютера (один раз). Миграции рабочей базы после внедрения ручного CD (#56) применяет только workflow `Release Production` после подтверждения владельца, см. «Ручной выпуск Production».

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push        # применить supabase/migrations
npx supabase config push    # применить настройки Auth, в т. ч. enable_signup = false
```

После этого в Dashboard проверить: Authentication → Sign In / Providers → «Allow new users to sign up» выключено; Storage → бакет `exam-sources` приватный.

Доверенная начальная загрузка выполняется с компьютера владельца один раз:

```sh
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SECRET_KEY=<secret> PILOT_KEYS_FILE=private/pilot-keys.json PILOT_AUDIO_FILE=private/hoeren-teil-1.mp3 npm run seed:pilot
```

Скрипт сначала проверяет материал, ключ и файл записи. Только после этого он загружает запись в `exam-sources` и публикует версию, ключи и дорожку одной транзакцией `publish_exam_version`. Повторный запуск с тем же содержимым сообщает `already published` и возвращает прежнюю версию.

### Полный пилот

Полный пилот (20 Hören, 25 Lesen) владелец готовит и загружает так же, с компьютера и без веб-админки. Подготовленный JSON и ключ лежат в `private/`, в Git и CI не попадают:

```sh
PILOT_DRAFT_FILE=private/pilot-draft.json npm run prepare:pilot
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SECRET_KEY=<secret> PILOT_CONTENT_FILE=private/pilot-content.json PILOT_KEYS_FILE=private/pilot-keys.json PILOT_AUDIO_FILE=private/track-127.mp3 npm run publish:pilot
```

Скрипт проверяет контракт и число заданий до записи и публикует версию общей функцией. Повтор с тем же содержимым возвращает прежнюю версию. Подробности и статус сверки с оригиналом — `docs/pilot-material.md`.

### Vercel

- Root Directory: `apps/web`, Framework: Next.js, Node.js 24.x.
- Переменные `SUPABASE_URL` и `SUPABASE_SECRET_KEY` (Production и Preview), тип Sensitive. `GUEST_SESSIONS_PER_MINUTE` и `PRACTICE_EXAM_SLUG` необязательны: без них действуют значения по умолчанию (фактический набор переменных в проекте Vercel в #14 не сверялся).
- `APP_ORIGIN` (#39): в Production — публичный origin сайта; без неё в Production старт попытки отклоняется. В Preview её не задавать (production-значение не наследуется): используется `https://${VERCEL_URL}`. Если preview открывают через алиас ветки, для Preview нужно явно задать этот алиас. ⏳ В проекте Vercel владельцем ещё не задана — не проверено.
- `apps/web/vercel.json` задаёт `git.deploymentEnabled.main = false` (#56): merge в `main` больше не публикует Production и не создаёт Git-деплой `main`. Preview остальных веток (каждый PR) сохраняется, его статус виден в GitHub как статус `Vercel` коммита. Production публикует только ручной workflow `Release Production`.
- Deployment Protection: Vercel Authentication включена (Standard Protection), публичным остаётся только production-домен `b1-kompass.vercel.app`. Protection Bypass for Automation создаёт владелец заранее (см. ниже); его значение в GitHub не хранится.

## Развёртывание с нуля по шагам

Порядок для владельца; значения секретов в документ не пишутся.

1. Supabase: создать проект Free, затем `npx supabase link --project-ref <project-ref>` и `npx supabase db push`. Применяются все миграции `supabase/migrations/` по порядку: `20261031000000_guest_attempts`, `20261101000000_short_practice`, `20261102000000_guest_session_limits`, `20261103000000_full_exam_scope`, `20261104000000_attempt_progress`, `20261105000000_answer_revision`, `20261106000000_guest_renewal`, `20261107000000_m2_attempt_lifecycle`, `20261108000000_m2_submission` (последняя на `main@d838a64`). Проверка: `npx supabase migration list --linked` показывает каждую в Local и Remote. Это только создание проекта с нуля; следующие миграции рабочей базы применяет `Release Production`.
2. Auth: в Dashboard выключить регистрацию. Проверка: `GET https://<project-ref>.supabase.co/auth/v1/settings` с publishable-ключом → `disable_signup: true`.
3. Storage и cron: бакет `exam-sources` создан миграцией и приватен. В Integrations → Cron есть задача `purge-expired-empty-guest-sessions`.
4. Материал: доверенная загрузка с компьютера владельца. Короткий набор — `npm run seed:pilot`, полный пилот — `npm run prepare:pilot`, затем `npm run publish:pilot` (команды выше). Нужны `SUPABASE_URL`, `SUPABASE_SECRET_KEY` и файлы в `private/`. Повтор с тем же содержимым возвращает прежнюю версию, изменённый материал — новую.
5. Vercel: проект с настройками выше, переменные Production и Preview. Merge в `main` Production не публикует.
6. Выпуск: настройки GitHub/Vercel из «Ручной выпуск Production», затем Actions → `Release Production` → Run workflow на `main`. Workflow сверяет историю миграций до и после `db push`. Пока в Remote нет миграций, которых ждёт код, `/practice` падает с «Something went wrong», а `curl` главной этого не замечает — поэтому SQL применяется до promote.
7. Проверка после выпуска: итог workflow (alias `b1-kompass.vercel.app` указывает на кандидата). `curl -I https://b1-kompass.vercel.app/` → `200` и `Cache-Control: private, no-cache, no-store…`. Затем ручная приёмка по `docs/m1-acceptance.md`: вход, Hören, Lesen, разбор, «Пройти заново» на телефоне и компьютере, при выключенном компьютере владельца.

Сайт и запись не зависят от компьютера владельца. Страницы отдаёт Vercel, данные и аудио — Supabase Storage. Docker и локальные процессы нужны только для разработки и тестов.

## Ручной выпуск Production (#56)

После merge в `main` выполняется только CI (`Quality`). Production публикует отдельный ручной workflow `.github/workflows/release-production.yml` (`Release Production`, только `workflow_dispatch`). Кандидат — всегда текущий HEAD `main`, без тегов. Проверки выполняет `scripts/release/gate.mjs` (чистые функции, тесты `scripts/release/gate.test.mjs` в CI `Quality` и в preflight).

```text
Merge → CI/Quality → Run workflow (main)
  preflight (без секретов) → stage (release-prepare: VERCEL_TOKEN) → staged smoke
  → ⏸ approval владельца (Environment production)
  → recheck HEAD/CI → DB URL → history (prefix) → db push --dry-run → db push → history (equal)
  → smoke после SQL → vercel promote (без rebuild) → чтение alias b1-kompass.vercel.app
```

| Job | Environment | Секреты | Что делает | Что меняет |
| --- | --- | --- | --- | --- |
| `Preflight` | — | нет (только `github.token`, `contents: read`, `actions: read`) | событие `workflow_dispatch`, репозиторий, `refs/heads/main`, `github.sha` = текущий HEAD `main`, последний push-запуск `CI` на этом SHA успешен и job `Quality` = `success`; оба Environment существуют и разрешены только ветке `main`; у `production` ровно один reviewer `strakhovdenya`, `prevent_self_review = false`; репозиторий публичный | ничего |
| `Stage` | `release-prepare` | `VERCEL_TOKEN` | проект/команда/Root Directory `apps/web`, Vercel Authentication и наличие bypass; `vercel pull --environment=production`, `vercel build --prod` (без токена), `vercel deploy --prebuilt --prod --skip-domain --meta releaseSha=<SHA>`; API: тот же project/team, `target=production`, `READY`, `readySubstate=STAGED`, `meta.releaseSha`, публичный alias указывает на другой deployment; read-only smoke через `vercel curl` | создаёт staged Production deployment без публичного адреса |
| `Release` | `production` (required reviewer) | `VERCEL_TOKEN`, `SUPABASE_DB_URL` | после approval: повтор preflight, повтор проверки кандидата, проверка DB URL, история миграций до push (префикс), `db push --dry-run`, `db push --db-url … --skip-vault`, история после push (равенство), smoke, повтор проверки кандидата, один `vercel promote <id>`, ограниченное чтение alias (18 × 10 с) и GET главной | рабочая БД, затем публичный alias |

- Один workflow-level `concurrency` (`release-production`, `cancel-in-progress: false`, `queue: max`): запуски идут по очереди, ожидание approval удерживает группу. Повторная сверка HEAD и CI выполняется после approval, до SQL и promote: если за время ожидания в `main` появился новый commit, выпуск устаревшего кандидата отказывает.
- Секреты передаются только в `env` конкретных шагов; `npm ci`, `vercel build` и job-level `env` их не видят. `checkout` — `persist-credentials: false`. `.vercel/.env.*` удаляются сразу после сборки, `.vercel/` — в конце job; артефакты не публикуются.
- Smoke: `GET /` → `200`, HTML с `<title>B1 Kompass</title>` и «Continue as guest», `Cache-Control … no-store`; `GET /practice` без cookie → `307` на `/` того же deployment. POST, Guest и Attempt не создаются. `vercel curl` берёт существующий bypass проекта; вывод CLI не печатается.
- История миграций доказывает только **зарегистрированные** миграции. Ручные DDL вне миграций и полную runtime-совместимость она не гарантирует. Breaking SQL идёт отдельным review по схеме expand → deploy → contract: SQL выпуска обязан работать и со старой опубликованной версией, потому что до promote она продолжает обслуживать сайт.
- Workflow не использует account-wide `SUPABASE_ACCESS_TOKEN` и привязку CLI к проекту; запрещены сброс базы, правка истории миграций, `config push` и `--include-all`. Supabase CLI — `2.122.0` из `npm ci` (не v3).

### Настройки владельца (до merge PR #56)

Merge PR #56 сам отключает автопубликацию `main` (`vercel.json`), поэтому всё ниже готовится **до** merge. Значения секретов в документ и в логи не пишутся.

**GitHub**

1. Ruleset для `main`: required status check `Quality`, запрет force-push и удаления, изменения только через PR; bypass для admin — ограничить (не «Always»).
2. Settings → Environments → `release-prepare`: Deployment branches and tags → **Selected branches and tags** → одно правило branch `main`. Reviewer не нужен. Secret: `VERCEL_TOKEN`.
3. Environments → `production`: Selected branches and tags → одно правило branch `main`; **Required reviewers** → только `strakhovdenya`; **Prevent self-review** выключен (владелец сам запускает и сам утверждает); **Allow administrators to bypass** — выключить. Secrets: `VERCEL_TOKEN`, `SUPABASE_DB_URL`.
4. Repository variables (не секреты): `SUPABASE_PROJECT_ID=kkhhtfgqsfrzjyznicoj`, `VERCEL_ORG_ID=team_8CIxfH6pWMGHuoWC1zyr48pt`, `VERCEL_PROJECT_ID=prj_TbhAm2zqwMunQHFhF5qaSmAZnJDS`.
5. На уровне repository/organization секретов `VERCEL_TOKEN` и `SUPABASE_DB_URL` нет (их видел бы любой job, включая preflight).
6. Gate отказывает, если репозиторий станет private: на GitHub Free required reviewers для private-репозитория не действуют.

**Vercel**

1. Project → Settings → General: Root Directory `apps/web`; Production env `APP_ORIGIN=https://b1-kompass.vercel.app` (подтвердить).
2. Deployment Protection: Vercel Authentication включена. **Protection Bypass for Automation** → создать один секрет (имя, например, `release-smoke`) заранее, чтобы `vercel curl` не создал неизвестный постоянный секрет. Значение никуда не копировать (ни в GitHub, ни в документ). Отзыв: там же Revoke/Regenerate; после регенерации проверить следующий stage.
3. Account Settings → Tokens: отдельный токен для CI, scope — команда проекта, ограниченный срок (например, 90 дней); записать дату ротации. Тот же токен положить в оба Environment.

**Supabase**

- `SUPABASE_DB_URL` — строка **Session pooler** (Dashboard → Connect → Session pooler, IPv4 для GitHub runners): `postgresql://postgres.kkhhtfgqsfrzjyznicoj:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres?sslmode=require`, пароль percent-encoded. Gate принимает только пользователя `postgres.<SUPABASE_PROJECT_ID>`, хост `*.pooler.supabase.com`, порт `5432`, базу `postgres` и `sslmode=require|verify-ca|verify-full`. Direct connection, transaction pooler `6543` и чужой проект отклоняются.
- **Backup до первого SQL через CD** — с компьютера владельца, не из CI (бесплатный план не гарантирует автоматический backup): `npx supabase db dump --db-url "$SUPABASE_DB_URL" -f private/backup-<дата>-schema.sql` и `npx supabase db dump --db-url "$SUPABASE_DB_URL" --data-only -f private/backup-<дата>-data.sql`; восстановление проверить на локальной Supabase (`npm run db:start`, затем `psql` в локальную базу). Файлы остаются в `private/`.

**Проверка настроек без выпуска:** `gh api repos/strakhovdenya/b1-kompass/environments/production` (reviewer, `prevent_self_review: false`, `custom_branch_policies: true`), `gh api repos/strakhovdenya/b1-kompass/environments/production/deployment-branch-policies` (одно правило `main`), то же для `release-prepare`; `gh secret list` (на уровне repo CD-секретов нет), `gh secret list --env production`, `gh variable list`. Первый запуск workflow сам повторяет эти проверки в preflight, до секретов.

### Первый cutover (порядок)

1. Подготовить настройки выше и backup.
2. Merge PR #56. Проверить в Vercel → Deployments: для merge-commit **нет** нового Production Git-деплоя; Preview других веток продолжают создаваться. Дождаться `Quality` на merge SHA.
3. Run №1 (Actions → Release Production → Run workflow, branch `main`): дождаться stage и smoke, затем **Reject** в approval. Ожидаемо: job `Release` не запускался, история миграций и alias `b1-kompass.vercel.app` прежние (`gh`/Dashboard), staged deployment не публичен.
4. Run №2: **Approve**. Проверить итог workflow (migrations after = equal, alias → кандидат), открыть сайт.
5. Ручная приёмка на телефоне: Guest → Hören/Lesen → сохранение → сдача/разбор; старые попытки читаются; запросы с правильным Origin; Vercel logs без ошибок. GET-smoke эту приёмку не заменяет.
6. До успешного выпуска №2 не мержить новые runtime PR (их код не попадёт в Production, а следующий выпуск взял бы его вместе с SQL).

### Отказы и восстановление

| Где остановилось | Состояние | Что делать |
| --- | --- | --- |
| Preflight (чужая ветка, устаревший SHA, CI не `success`, Environment/branch policy/reviewer, API) | ничего не создано | исправить причину из лога (`release gate preflight: refused`), запустить заново на актуальном HEAD |
| Stage (build/deploy/candidate/smoke) | возможен staged deployment без публичного адреса | исправить; staged deployment можно удалить в Vercel. БД и alias не менялись |
| **Approval отклонён** или истёк | staged deployment не публичен; `Release` не выполнялся | ничего; БД и публичный домен прежние |
| Recheck после approval (новый commit в `main`) | БД и alias не менялись | запустить новый выпуск для нового HEAD |
| DB URL / история до push (drift) | БД не менялась | сверить `supabase_migrations.schema_migrations` с `supabase/migrations/`; историю вручную не править, не применять «все» миграции; разобрать расхождение отдельно |
| `db push` или история после push | часть миграций могла примениться; сайт обслуживает старый deployment | **автоматического SQL rollback нет**. Остановиться, прочитать историю, восстановить совместимость отдельной миграцией (или из backup владельцем). Новый выпуск — после исправления |
| Smoke после SQL | SQL применён, alias прежний | старый deployment работает с новым SQL (требование expand/contract); исправить и выпустить заново |
| `vercel promote` — ошибка или timeout CLI | неизвестно | workflow **не повторяет promote**; он читает alias через API до 3 минут. Alias у кандидата → успех; иначе job падает с `promotion-not-confirmed`. Проверить Vercel → Deployments / `vercel promote status`; повторный promote — только вручную после проверки |
| Alias у кандидата, но GET главной не прошёл | новая версия уже публична | разобрать по Vercel logs. `vercel rollback` (или promote предыдущего deployment из summary) допустим **только если SQL совместим** со старой версией |

### Статус внедрения ручного CD

Пять состояний ведутся раздельно; одно не подтверждает другое.

| # | Состояние | Статус |
| --- | --- | --- |
| 1 | Код CD и PR #56 (`release-production.yml`, `gate.mjs`, `vercel.json`, документы) | ✅ в PR, не смержен |
| 2 | CI `Quality` на PR head, включая release gate tests | ⏳ отмечается по результату CI PR #56 |
| 3 | Настройки GitHub (ruleset, Environments, reviewer, secrets, vars) и Vercel (bypass, токен, `APP_ORIGIN`) | ⏳ владельцем не подтверждены |
| 4 | Проверка CD с approval (run с Reject, run с Approve) | ⏳ не выполнялась |
| 5 | Первый подтверждённый Production release через CD | ⏳ не выполнялся; Production остаётся на `dpl_5mKAg5KA84Pe915sjd4XVmjKrv5p` до первого выпуска |

## Фактический статус публикации

Состояние на 2026-11-01 (обновлено при приёмке #14):

| Что | Статус |
| --- | --- |
| Проект Supabase `b1-kompass` (Free, `eu-central-1`) | ✅ создан, миграция применена `supabase db push` |
| Регистрация в облачном Auth | ✅ выключена в Dashboard (`/auth/v1/settings` → `disable_signup: true`). `supabase config push` не используется: он перенёс бы локальные dev-настройки Auth (`site_url`, подтверждение email) |
| Реальное задание пилота | ✅ опубликовано доверенной загрузкой с ключом издателя |
| Миграция `20261101000000_short_practice.sql` (P1-T2) в облаке | ✅ применена владельцем: `supabase migration list --linked` показывает `20261101000000` в Local и Remote. Seed из `main` после неё не работает: 5-аргументная `publish_exam_version` удалена |
| Короткий набор Hören Teil 1 с оригинальной записью в облаке | ✅ опубликован владельцем 2026-10-31: `npm run seed:pilot` → `Pilot short set published: version 2de7ca2f-fc8b-4c62-bbfe-bc10e4f5c5fc`. Ключ — официальный ключ telc (Lösungen KB/AB, стр. 6). Запись — telc Track 127 (весь Hören DTZ, Teil 1 в начале). Ни ключ, ни запись в Git не хранятся |
| Полный пилот (20 Hören, 25 Lesen) в облаке | ✅ опубликован владельцем 2026-11-01: `npm run publish:pilot`, версия `729d4787-8bc8-4190-8e15-68f898614372`. Файлы подготовлены `private/build-draft.mjs` и `npm run prepare:pilot` (ключ сверен с Lösungen: 45 из 45). Сверка заданий и записи с оригиналом ⏳ за владельцем |
| Прослушивание и разбор в облаке | ⏳ не проверены |
| Отказы publishable-ключа в облаке | ✅ 7 таблиц, запись балла, 3 функции, бакет `exam-sources` (чтение, список, загрузка), GraphQL — все отклонены |
| Проект Vercel `b1-kompass` | ✅ создан: Root Directory `apps/web`, Node.js 24.x, GitHub `strakhovdenya/b1-kompass`, переменные Production/Preview (sensitive) |
| Миграции `20261104…`–`20261106…` (#10–#12) в облаке | ✅ применены владельцем после того, как `/practice` на preview упал с «Something went wrong». Проверено агентом 2026-11-01: `supabase migration list --linked` показывает все 7 миграций в Local и Remote |
| Миграции `20261107…`, `20261108…` (#37, #40) в облаке | ✅ по данным Issue #56 Production-база на `20261108000000`; агентом в #56 не перечитывалось |
| Production URL `https://b1-kompass.vercel.app` | ✅ отвечает по HTTPS. Статус `Vercel: success` у `e78806c` (head `main`, merge PR #33) в 2026-10-31 23:03 UTC. Проверка `curl` 2026-10-31 23:23 UTC, только чтение: главная `200` с «Continue as guest», `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, ответ из `fra1`; `/practice` без cookie → `307` на `/`; `http://` → `308` на HTTPS |
| Гостевой маршрут на production (вход, ответ, разбор) | ⏳ не выполнялся: по решению владельца в #14 production проверялся только чтением, без создания гостевого сеанса |
| Проверка с телефона и компьютера | ⏳ не выполнена |
| Работа при выключенном компьютере владельца | ⏳ не проверена фактически. По устройству развёртывания (Vercel и Supabase) компьютер не нужен |

Успешная сборка не считается публикацией: статус обновляется только после реальной проверки по HTTPS.
