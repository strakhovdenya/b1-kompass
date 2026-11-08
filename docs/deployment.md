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
| `DICTIONARY_CONTACT_EMAIL` | сервер Next.js, необязательна (#60) | контакт владельца для словаря: параметр `de` MyMemory (лимит 50 000 вместо 5 000 символов в сутки по документации MyMemory) и контакт User-Agent OpenThesaurus. Без неё контактом User-Agent служит origin сайта, а серверный дневной бюджет MyMemory остаётся консервативным (4 000). Некорректное значение никуда не отправляется. Не секрет, не `NEXT_PUBLIC_` |
| `DICTIONARY_TEST_PROVIDER` | только E2E-серверы | `1` заменяет MyMemory/OpenThesaurus детерминированным серверным фейком (`apps/web/playwright.config.ts`); проверка Guest, кэш и бюджет работают по-настоящему. Принимается только без `VERCEL_ENV` и с loopback `APP_ORIGIN`; иначе словарь отвечает `503` без переводов. В Vercel не задаётся |
| `PILOT_KEYS_FILE` | только скрипты загрузки | путь к приватному JSON с ключом, по умолчанию `private/pilot-keys.json` |
| `PILOT_AUDIO_FILE` | только скрипты загрузки | путь к оригинальной записи у владельца (`.mp3`, `.wav`, `.m4a` или `.ogg`), например `private/track-127.mp3`. Обязательна, значения по умолчанию нет |
| `PILOT_CONTENT_FILE` | только `publish:pilot` | путь к подготовленному JSON полного пилота, по умолчанию `private/pilot-content.json` |
| `TIMING_PROFILE_OWNER_DB_URL` | только `scripts/manage-timing-profile.ts` (#42) | строка подключения PostgreSQL владельца/DDL-роли (`postgresql://postgres:<пароль БД>@<host>:5432/postgres`, пароль из Supabase Dashboard → Database). Это не `SUPABASE_SECRET_KEY`: роль `service_role` не может исполнять подтверждение. Задаётся только в терминале владельца; в Vercel, GitHub и `.env*` в репозитории не попадает, инструмент отказывается работать при `VERCEL` |
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

## Словарь слов (#60)

Перевод одного немецкого слова в Hören/Lesen (архитектура: `docs/architecture.md`, «Словарь слов (#60)»; права и API: `docs/security.md`).

**Провайдеры и бесплатные лимиты** (проверено по официальным страницам 2026-11-05):

| Назначение | Источник | Опубликованные условия | Что делает сервер |
| --- | --- | --- | --- |
| Перевод DE→EN/RU | MyMemory, `GET https://api.mymemory.translated.net/get` (`q`, `langpair=de\|en` или `de\|ru`, `mt=1`, `de`) | `q` ≤ 500 байт; анонимно 5 000 символов/сутки, с `de=<email>` — 50 000; частота контролируется («when necessary»); в Terms: не обходить лимиты, не «краулить» архив, не переводить больше абзаца за раз; отдельного условия о кэшировании ответов API нет | бюджет `mymemory` 4 000 символов в сутки (UTC) на весь сайт, стоимость = длина слова: serverless egress IP может быть общим; `ip`/`X-Forwarded-For` не передаются |
| Синонимы и начальная форма | OpenThesaurus, `GET https://www.openthesaurus.de/synonyme/search?format=application/json&baseform=true` | бесплатно; > 60 запросов/мин с одного IP — ошибка; контакт в User-Agent обязателен; видимая ссылка на www.openthesaurus.de без `nofollow` там, где показаны данные; лицензия данных CC BY-SA 4.0 / LGPL 2.1 (`metaData.license` ответа); о долгом использовании просят заранее написать на feedback@openthesaurus.de | бюджет `openthesaurus` 30 запросов/мин; User-Agent `B1Kompass/1.0 (+<контакт>)`; ссылка в карточке без `nofollow` |
| Подробности и грамматика | DWDS, Duden, Google Translate | только ссылки для пользователя | адреса строит приложение из проверенного слова; неофициальные endpoints Google не используются |

Часть речи, артикль и Plural в v1 не показываются: эти провайдеры их достоверно не поставляют. Начальная форма — только из `baseforms` OpenThesaurus.

**Кэш и бюджет.** Общий кэш `dictionary_cache`: `found` хранится 30 дней, «нет перевода» — 1 день, ошибки и исчерпанная квота не кэшируются. Бюджет `dictionary_budget`: Guest 60 карточек в минуту (любых, проверка сеанса в БД) и 10 новых (не из кэша) слов в минуту, MyMemory 4 000 символов в сутки, OpenThesaurus 30 запросов в минуту; одна функция резервирует всё нужное или ничего. Значения заданы в `server/dictionary/dictionary.ts` (`DEFAULT_LIMITS`). pg_cron `purge-dictionary-data` (каждый час, `41 * * * *`) удаляет истёкший кэш и окна бюджета старше 2 суток.

**Отказы.** HTTP 429/5xx, HTML, битый JSON, `quotaFinished`, `MYMEMORY WARNING`, `responseStatus ≠ 200`, «перевод», равный слову, таймаут 4 с или ответ > 64 KiB дают в карточке «сервис недоступен» и ссылки на другие словари; исчерпанный бюджет — «лимит исчерпан». Кэшированные слова продолжают работать. Ответы, попытка, таймер и запись не затрагиваются; повторов запросов нет.

**Ограничение по хранению.** Условия MyMemory не содержат явного разрешения или запрета кэшировать ответы API; кэш ограничен одиночными словами, сроком 30 дней и не публикуется как архив. До включения в Production владелец подтверждает допустимость такого кэширования (при необходимости — письмом в MyMemory); если хранение недопустимо, минимальное безопасное решение — уменьшить TTL перевода до 1 дня или выключить запись `mymemory` в кэш (изменение `translationRow` в `server/dictionary/dictionary.ts`), оставив бюджет. OpenThesaurus разрешает использование данных по CC BY-SA/LGPL с атрибуцией; о долгом использовании владелец пишет на feedback@openthesaurus.de.

**Выпуск.**
1. Миграция `20261109000000_word_dictionary_cache.sql` применяется только через ручной `Release Production` после approval владельца (после merge; до этого — нет). Перед ней — резервная копия базы по runbook. Миграция только добавляет объекты (expand), старый код с ней совместим.
2. При желании задать `DICTIONARY_CONTACT_EMAIL` в Vercel (Production/Preview). `DICTIONARY_TEST_PROVIDER` в Vercel не задаётся.
3. Проверка после выпуска (владелец, не автоматизирована): в Supabase → Integrations → Cron видна задача `purge-dictionary-data`; publishable-ключ получает `42501` на `dictionary_cache`, `dictionary_budget` и `reserve_dictionary_budget`; на сайте — перевод слова в Lesen и в варианте Hören (EN и RU), radio не меняется, синоним открывает свой перевод, ссылки и атрибуция видны, переключатель выключает словарь; iOS Safari и Android Chrome — удержание слова 1,5 с открывает bottom sheet, короткое касание и прокрутка нет, `speechSynthesis` не глушит запись Hören.

**Статус:** код и локальные проверки — в PR задачи #60. Применение миграции в Production, работа с настоящими MyMemory/OpenThesaurus из Vercel и ручная проверка на устройствах ⏳ не выполнялись.

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

### Проверка комплекта перед публикацией

Полный DTZ владелец сначала проверяет без записи. Команда `exam:validate` не требует `SUPABASE_URL` и `SUPABASE_SECRET_KEY`, не открывает сеть, не обращается к Supabase и ничего не пишет на диск. Публикация — отдельная команда `exam:publish` (следующий раздел); `validate` её не выполняет.

1. Подготовить приватный комплект в `private/<экзамен>/`: `manifest.json` (формат — «Owner manifest v1» в `docs/pilot-material.md`) и файл записи рядом с ним или в подкаталоге. Пути аудио в manifest — относительные от каталога manifest. Каталог `private/` в Git не попадает; ключи в manifest не копировать в чаты, логи и скриншоты.
2. Запустить `npm run exam:validate -- private/<экзамен>/manifest.json`.
3. Прочитать отчёт: каждая строка — `код путь id=<задание или дорожка> - пояснение`. Код выхода 0 — комплект цел, 1 — есть проблемы (показаны все сразу), 2 — неверные аргументы. Отчёт безопасен для терминала и CI-лога: в нём нет ключей, текстов заданий, содержимого manifest и абсолютных путей. Для обработки скриптом есть `--json`.
4. Исправить указанные ошибки в manifest или файлах записи.
5. Повторить проверку до кода 0. Пределы: файл записи до 50 MiB (`AUDIO_MAX_BYTES`, лимит бакета `exam-sources`), manifest до 5 MiB; допустимы `.mp3`, `.wav`, `.m4a`, `.ogg`.

Код 0 подтверждает форму и целостность комплекта, но не смысловую точность ключа и записи относительно оригинала: её сверяет владелец (см. «Статус проверки» в `docs/pilot-material.md`).

### Публикация комплекта владельцем (#81)

`exam:publish` — единственный путь публикации полного DTZ из owner manifest v1. Он вызывает тот же `publishExamVersion` и ту же функцию БД `publish_exam_version`, что `seed:pilot` и `publish:pilot`; веб-админки и HTTP-доступа нет.

**До первого запуска против облачного проекта** в Production должна быть применена миграция `supabase/migrations/20261114000000_m3_publish_guard.sql` (через `Release Production`, раздел «Ручной выпуск Production (#56)»). Без неё новая команда успевает загрузить запись в приватный бакет, получает отказ «функция не найдена» и версию не создаёт. Миграция заменяет функцию (cutover, раздел «Выпуск M2», п. 4): прежняя шестиаргументная сигнатура удаляется, новая принимает `p_intent` и `p_rename` и возвращает `version_id` + `is_new`. Веб-приложение эту функцию не вызывает, поэтому сайт миграция не затрагивает; owner-инструменты после неё запускать только из кода с #81 (старый код публикует, но не разбирает новый ответ). Агент миграцию в облаке не применяет и cloud-публикацию без отдельного разрешения владельца не выполняет.

Порядок владельца (ручные шаги помечены **вручную**: их не заменяет ни команда, ни CI):

1. **Подготовка.** Приватный комплект в `private/<экзамен>/` (manifest v1 и запись), как в разделе выше. Ни manifest, ни запись, ни ключи не попадают в Git, чат, лог или скриншот.
2. **Проверка формы.** `npm run exam:validate -- private/<экзамен>/manifest.json` до кода 0.
3. **Вручную: сверка с источником.** Владелец подтверждает право показывать материал в приложении, сверяет все 45 ключей с авторитетным ключом первоисточника (номер, Teil, варианты), а запись — с оригиналом: одна непрерывная запись Hören, длительность, `sha256sum` файла. Без этой сверки не публиковать: код 0 её не доказывает.
4. **Явное намерение.** Новый экзамен — `--new-exam` (slug ещё не существует). Исправление опубликованного экзамена — `--new-version` (slug существует). Смена названия существующего экзамена — только `--new-version --rename`: новое `exams.title` видно у всех версий, в том числе в review прежних попыток. `format` существующего экзамена не меняется никогда. Без флага намерения команда завершается кодом 1 до чтения секретов и подключения к БД.
5. **Публикация.**

   ```sh
   SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SECRET_KEY=<secret> \
     npm run exam:publish -- private/<экзамен>/manifest.json --new-exam
   ```

   Команда заново выполняет всю проверку `validate`, затем read-only preflight (есть ли slug, совпадают ли `format` и `title` с намерением) и только после этого загружает запись в приватный бакет и вызывает функцию БД. Отказ preflight ничего не загружает и ничего не пишет. Вывод — одна строка `Published slug=<slug> versionId=<uuid> isNew=true` (новая версия) или `Already published slug=<slug> versionId=<uuid> isNew=false` (идентичный пакет уже опубликован, либо выполнено только `--rename`); `--json` даёт `{ slug, versionId, isNew }`. Отказы — коды без данных: `exam_exists`, `exam_not_found`, `exam_format_mismatch`, `exam_title_mismatch`, `publish_intent_invalid`, `material_invalid`, `exam_identity_conflict`. Код выхода 0 — опубликовано или уже было, 1 — отказ или ошибка, 2 — неверные аргументы. Ключи, тексты, manifest, секрет, signed URL и пути в вывод не попадают.
6. **Проверенное чтение.** Убедиться, что опубликовано именно то, что сверено: в Supabase Dashboard → SQL Editor (read-only запросы) для `slug` — `exams.title`/`format`, номер версии и `versionId` из вывода, число ключей версии (45) и одна дорожка с `sha256` из шага 3; экзамен виден в библиотеке `/exams`, бесплатная тренировка открывается. Значения ключей в чат и логи не копировать.
7. **Отдельно: профиль времени.** Публикация профиль времени не создаёт и не подтверждает: новая версия остаётся без timed-блока и экзамена на время, пока владелец не выполнит процедуру «Профиль времени (#42)» для **этой** версии (`show` → `draft` → `confirm` с отпечатком).
8. **Повтор и границы.** Повтор того же пакета с тем же намерением (`--new-version`) безопасен: версия не создаётся, выводится прежний `versionId`. Исправленный пакет создаёт следующую неизменяемую версию; попытки, начатые на прежней, продолжают её. Две одновременные публикации одного slug функция БД выполняет по очереди под блокировкой строки экзамена: одинаковый пакет даёт одну версию, второй `--new-exam` того же slug получает `exam_exists`. Сбой Storage или БД между загрузкой и записью, проверка байтов существующего объекта и аудит неиспользуемых объектов — следующий раздел.

### Сбой публикации: безопасный повтор и аудит объектов (#82)

Публикация использует две системы (Storage и PostgreSQL) без общей транзакции. Объект записи, загруженный перед отказом БД, остаётся в приватном бакете `exam-sources` без ссылки из `exam_version_audio` (гостю он недоступен); видимой версии при этом нет. Это допустимое состояние, из которого есть безопасный выход.

Порядок владельца:

1. **Сбой.** `exam:publish` завершился кодом 1. Вывод содержит только код и фиксированную строку (`Publication failed: Audio upload failed (500)`, `Publication failed: Publication failed`, `Publication stopped: audio-object-mismatch (track <id>)`), без ключей, signed URL, manifest и секрета.
2. **Проверить результат.** Ничего не предполагать: в SQL Editor (read-only) посмотреть, есть ли версия `slug` и её число; при `Publication result unreadable` транзакция могла завершиться, поэтому сначала проверить, а потом повторять.
3. **Повторить тот же пакет** с тем же намерением. Публикация идемпотентна: уже созданная версия возвращается с `isNew=false`, иначе создаётся ровно одна. Существующий объект повторно не загружается, но и **не принимается на веру**: имя `audio/<sha256>.<расширение>` само не доказывает содержимое, поэтому перед использованием объект скачивается, считается его SHA-256 и сравнивается с ожидаемым. Так же проверяется объект, который параллельная загрузка с `upsert: false` успела создать между просмотром и загрузкой. Перезаписи (`upsert: true`) и удаления в публикации нет.
4. **`audio-object-mismatch`.** Под ожидаемым путём лежат другие байты. Публикация остановлена до вызова функции БД, объект не изменён. Повтор не поможет: владелец вручную выясняет происхождение объекта (подмена, повреждение, ошибка загрузки), ничего не удаляя, и решает отдельно.
5. **При необходимости — аудит.** `npm run exam:audit-audio` (опция `--json`; нужны `SUPABASE_URL`, `SUPABASE_SECRET_KEY`) только читает бакет постранично и таблицу `exam_version_audio` и печатает пути объектов, на которые не ссылается ни одна версия, и счётчики. Ничего не удаляет и не меняет; код 0 при любом числе найденных объектов, 1 — ошибка чтения или неверные аргументы (по спецификации #82; у `validate` и `publish` неверные аргументы дают 2).
6. **Проверить найденное.** Объект без ссылки — не обязательно мусор: параллельная публикация могла его загрузить и ещё не создать версию. Перед любым решением повторить аудит позже и убедиться, что нет запущенных публикаций; сверить `sha256` пути с файлами комплектов в `private/`.
7. **Удаление — только отдельное ручное решение владельца.** В M3 нет ни команды удаления, ни автоматической очистки, ни фоновой задачи; оригинальные записи экзаменов A, B и C этим не затрагиваются. Если владелец решил удалить объект, делается это вручную в Dashboard после шага 6.

Проверяют это `apps/web/tests/owner-publication-recovery.spec.ts` (тестовая БД и Storage, отказы внедряются только обёрткой клиента вокруг `upload` и `rpc`) и `scripts/manage-exam-library.test.ts`.

### Профиль времени (#42)

Длительности timed-режимов хранятся отдельно от материала: `m2_private.timing_profiles` (голова — номер текущей редакции версии) и append-only `m2_private.timing_profile_revisions`. Редакция привязана к `exam_versions.id`, к единственной дорожке версии и её `exam_version_audio.sha256`, хранит длительность записи, Hören, перехода и Lesen в секундах, отпечаток и статус `draft`/`confirmed`. Устройство и права — `docs/architecture.md` и `docs/security.md` (#42).

Управляет профилем только владелец со своего компьютера, инструментом `scripts/manage-timing-profile.ts` через `psql` (нужен клиент PostgreSQL; новых npm-пакетов нет). Веб-админки и HTTP-доступа нет:

```sh
export TIMING_PROFILE_OWNER_DB_URL='postgresql://postgres:<пароль БД>@<host>:5432/postgres'
npx tsx scripts/manage-timing-profile.ts show --exam <slug>   # версия, запись, голова, отпечаток, что вернёт gate
npx tsx scripts/manage-timing-profile.ts draft --exam <slug> \
  --recording-seconds <n> --hoeren-seconds <n> --transition-seconds <n> --lesen-seconds <n>
npx tsx scripts/manage-timing-profile.ts confirm --revision-id <uuid> --fingerprint <sha256>
```

- `draft` создаёт новую редакцию `draft` (те же настройки, что у головы, ничего не меняют) и печатает её `revisionId`, `fingerprint` и готовую команду `confirm`. Сам он ничего не подтверждает.
- `confirm` — отдельное явное действие. БД под блокировкой головы проверяет, что редакция всё ещё текущая, заново вычисляет отпечаток, сверяет запись версии и сравнивает отпечаток с переданным. Устаревший отпечаток, неактуальная редакция, сменившаяся запись или права не владельца — отказ без подтверждения (`timing_profile_fingerprint_mismatch`, `timing_profile_not_current`, `timing_profile_mismatch`, `permission_denied`).
- Новая `draft` после подтверждения закрывает timed-старт до нового `confirm`; к старой подтверждённой редакции система не возвращается.

**Процедура владельца перед подтверждением реального пилота** (не выполнена; эта задача пилот не подтверждает):

1. `show --exam <slug пилота>`: версия — та, что опубликована для выпуска; в `recordings` ровно одна дорожка, её `sha256` совпадает с `sha256sum` оригинального файла у владельца (`private/…`). Это должна быть та дорожка, которую играют задания Hören версии: иначе `draft` отказывает (`timing_profile_track_mismatch`).
2. Прослушать запись: фактическая длительность (24 мин 54 с) и паузы между частями; проверить регламент исходного материала. Предварительные значения Hören 1500 с, Lesen 2700 с, переход 60 с **не подтверждены**; их пригодность — решение владельца.
3. `draft` с проверенными значениями; сверить в выводе версию, `audioSha256`, все длительности и `fingerprint`.
4. `confirm` с `revisionId` и `fingerprint` именно из шага 3. Затем `show`: `confirmedRevisionId` равен этой редакции, `headMatches = true`.
5. Облачные права: подключаться через `TIMING_PROFILE_OWNER_DB_URL`, а не ключами Vercel. URL не сохранять в репозитории и истории оболочки. Что секретный ключ runtime подтверждать не может, автотесты проверяют только против локальной БД; в облаке это проверяет владелец после выпуска миграции, в Supabase Dashboard → SQL Editor:

   ```sql
   set role service_role;
   select m2_owner.timing_profile_state('00000000-0000-0000-0000-000000000000');
   ```

   Ожидаемый ответ — `permission denied for schema m2_owner`. Любой другой ответ — остановиться и не подтверждать профиль.

Timed-блок (#43) стартует только при текущей подтверждённой редакции профиля версии: пока профиль реального пилота не подтверждён владельцем, timed-старт пилота отвечает `not-enabled`, свободная тренировка работает. Новая `draft` закрывает новые timed-старты, но не меняет срок уже начатых. Миграцию `20261111000000_m2_timed_blocks.sql` применяет `Release Production` до promote, как остальные; в облаке она этим изменением не применялась (не проверено). Фонового worker и cron у блока нет. В автотестах `globalSetup` создаёт и подтверждает тестовый профиль только синтетического `test-full-dtz` в изолированной локальной БД; это не подтверждение пилота и не действие Production.

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
- Секреты передаются только в `env` конкретных шагов; `npm ci`, `vercel build` и job-level `env` их не видят. Vercel CLI берёт `VERCEL_TOKEN` из окружения шага (`vercel pull`, `deploy`, `curl`, `promote`); в аргументы командной строки токен не передаётся. `checkout` — `persist-credentials: false`. `.vercel/.env.*` удаляются сразу после сборки, `.vercel/` — в конце job; артефакты не публикуются.
- Smoke: `GET /` → `200`, HTML с `<title>B1 Kompass</title>` и «Continue as guest», `Cache-Control … no-store`; `GET /practice` без cookie → `307` на `/` того же deployment. POST, Guest и Attempt не создаются. `vercel curl` берёт существующий bypass проекта; вывод CLI не печатается.
- История миграций доказывает только **зарегистрированные** миграции. Ручные DDL вне миграций и полную runtime-совместимость она не гарантирует. Breaking SQL идёт отдельным review по схеме expand → deploy → contract: SQL выпуска обязан работать и со старой опубликованной версией, потому что до promote она продолжает обслуживать сайт.
- Workflow не использует account-wide `SUPABASE_ACCESS_TOKEN` и привязку CLI к проекту; запрещены сброс базы, правка истории миграций, `config push` и `--include-all`. Supabase CLI — `2.122.0` из `npm ci` (не v3).

### Название и карточка выпуска (#58)

**Название.** Поле `label` при запуске (Actions → Release Production → Run workflow) необязательное: например `ISSUE-12 таймеры`. Допустимы буквы (латиница и кириллица), цифры, пробел и `. # _ : -`, до 80 символов; всё остальное отклоняет `Preflight` с причиной `release-label-invalid` до шагов с секретами. Название — недоверенный ввод: в шаги оно попадает только через `env` (`RELEASE_LABEL`), а не через выражение в `run:`. Оно видно в названии запуска (`Release #<номер запуска> — <название>`; короткого SHA в названии нет, потому что в выражениях GitHub нет подстроки), в Step Summary и в метаданных staged deployment (`releaseLabel` рядом с `releaseSha`).

**Где смотреть историю выпусков.**

- GitHub → Actions → Release Production: список запусков с названиями и итоговая карточка в Summary запуска.
- GitHub → Deployments: у Environment `release-prepare` ссылка «View deployment» ведёт на staged-кандидата, у `production` — на `https://b1-kompass.vercel.app`.
- Vercel → Deployments: метаданные deployment (`releaseSha`, `releaseLabel`).

**Как читать карточку.** В Summary две карточки (единая таблица «Поле — Значение»). `Stage` пишет предварительную до approval: название, коммит, состав, кто запустил, кандидат и предыдущий deployment, preflight, smoke до SQL, итог «ожидает подтверждения». `Release` пишет итоговую (`if: always()`, в том числе после падения на любом шаге): добавляются кто подтвердил и комментарий, миграции remote «до → после» и список применённых (или «нет»), smoke после SQL, promote (код выхода CLI), фактический alias (кандидат, предыдущий или другой), команда `vercel rollback <предыдущий deployment>` с пометкой «только при совместимом SQL» и итог: «выпущен» либо «не выпущен: остановка на этапе …». Если approval отклонён, `Release` не запускается и остаётся предварительная карточка.

**Состав** — коммиты между публичным deployment (SHA из `meta.releaseSha`, иначе `meta.githubCommitSha` deployment, на который указывает alias `b1-kompass.vercel.app`) и кандидатом: GitHub compare, `ISSUE-<n>` и номера PR из первой строки сообщений (и из тела merge-коммита), без дублей, с числом коммитов. Если определить нельзя, карточка пишет «состав не определён: <причина>»: `compare-empty`, `github-api-unavailable`, `previous-sha-unknown` (compare вернул 404), `public-sha-missing` (у публичного deployment нет SHA или его не удалось прочитать). Состав и карточка — информация, а не gate: они не меняют решений выпуска и не роняют его.

**Кто подтвердил** берётся из `GET /repos/<repo>/actions/runs/<run_id>/approvals` (запись Environment `production` в состоянии `approved`) существующим правом `actions: read` job `Release`; при отказе API или отсутствии записи — «не определено».

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
2. Deployment Protection: Vercel Authentication включена с охватом, который защищает и production deployment URL: **Standard Protection** (`prod_deployment_urls_and_all_previews` / `all_except_custom_domains`) или All Deployments (`all`). Режим «Only Preview Deployments» (`preview`) оставляет staged-кандидата публичным — gate отказывает (`vercel-authentication-disabled`), так же как при выключенной защите (`ssoProtection: null`). **Protection Bypass for Automation** → создать один секрет (имя, например, `release-smoke`) заранее, чтобы `vercel curl` не создал неизвестный постоянный секрет. Значение никуда не копировать (ни в GitHub, ни в документ). Отзыв: там же Revoke/Regenerate; после регенерации проверить следующий stage.
3. Account Settings → Tokens: отдельный токен для CI, scope — команда проекта, ограниченный срок (например, 90 дней); записать дату ротации. Тот же токен положить в оба Environment.

**Supabase**

- `SUPABASE_DB_URL` — строка **Session pooler** (Dashboard → Connect → Session pooler, IPv4 для GitHub runners): `postgresql://postgres.kkhhtfgqsfrzjyznicoj:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres?sslmode=require`, пароль percent-encoded. Gate принимает только пользователя `postgres.<SUPABASE_PROJECT_ID>`, хост `*.pooler.supabase.com`, порт `5432`, базу `postgres` и `sslmode=require|verify-ca|verify-full`. Direct connection, transaction pooler `6543` и чужой проект отклоняются.
- **Backup до первого SQL через CD** — с компьютера владельца, не из CI (бесплатный план не гарантирует автоматический backup): `npx supabase db dump --db-url "$SUPABASE_DB_URL" -f private/backup-<дата>-schema.sql` и `npx supabase db dump --db-url "$SUPABASE_DB_URL" --data-only -f private/backup-<дата>-data.sql`; восстановление проверить на локальной Supabase (`npm run db:start`, затем `psql` в локальную базу). Файлы остаются в `private/`.

**Проверка настроек без выпуска:** `gh api repos/strakhovdenya/b1-kompass/environments/production` (reviewer, `prevent_self_review: false`, `custom_branch_policies: true`), `gh api repos/strakhovdenya/b1-kompass/environments/production/deployment-branch-policies` (одно правило `main`), то же для `release-prepare`; `gh secret list` (на уровне repo CD-секретов нет), `gh secret list --env production`, `gh variable list`. Первый запуск workflow сам повторяет эти проверки в preflight, до секретов.

### Что подтверждено до первого запуска

| Условие | Документация / исходный код CLI `65.11.0` | Реальная проверка |
| --- | --- | --- |
| CLI из корня монорепозитория при Root Directory `apps/web` | `vercel build`: `workPath = join(cwd, settings.rootDirectory)`, вывод в `<корень>/.vercel/output` | ✅ локально 2026-11-05: `vercel build --prod` из корня отдельного worktree с локальным `.vercel/project.json` (`rootDirectory: apps/web`) выполнил `installCommand` из `apps/web/vercel.json`, `next build` и записал `.vercel/output` (target `production`). `vercel deploy --prebuilt` из корня на Vercel ⏳ не запускался |
| `vercel build --prod` без `VERCEL_TOKEN` | build не обращается к API | ✅ та же локальная сборка: без `VERCEL_TOKEN` и с пустым `--global-config`. В GitHub Actions ⏳ не запускалась |
| `VERCEL_TOKEN` из окружения | `index.js`: `--token`, иначе `process.env.VERCEL_TOKEN` | ⏳ на Vercel не проверено (нужен токен) |
| Формат `protectionBypass` | CLI сам ищет запись `scope === "automation-bypass"` (`vercel curl`) | ⏳ ответ API реального проекта не читался |
| Vercel Authentication | выключенная защита хранится как `ssoProtection: null`; `preview` не защищает production deployment URL | ⏳ настройка проекта не читалась |

**Повторный запуск без новых миграций безопасен:** история до push равна файлам (префикс полной длины, pending: none), `db push` сообщает, что база актуальна, и ничего не применяет, история после push совпадает; promote делается только для нового staged-кандидата того же HEAD. Повтор после частично применённых миграций — только после разбора (см. «Отказы и восстановление»).

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

## Выпуск M2: порядок, совместимость и откат

Процедура для владельца поверх «Ручной выпуск Production (#56)». Описывает порядок и проверки; агент production-операции не выполняет. Что фактически выпущено и проверено — [m2-acceptance.md](m2-acceptance.md).

### 1. Предвыпускная проверка

1. `Quality` зелёный на HEAD `main` (`gh run list --workflow CI --branch main --limit 1`); `Release Production` сам отказывает при устаревшем SHA или красном CI.
2. Локально от HEAD: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` (нужен Docker и `npm run db:start`) и `node --test scripts/release/gate.test.mjs`. Результат CI не заменяется локальным прогоном и наоборот.
3. `git diff --stat <прежний выпуск>..HEAD -- supabase/migrations` — список новых миграций; каждую прочитать и отметить: добавляет ли она объекты (expand) или удаляет/заменяет контракт, на котором работает опубликованная версия (cutover, раздел 4).
4. Убедиться, что в репозитории нет `private/` и секретов, а `m2-fixtures.sql` и `tests/support/**` не импортируются кодом приложения (`production-boundary.spec.ts` проверяет это в CI).

### 2. Резервная копия и готовность восстановления

До выпуска, содержащего SQL, владелец делает копию со своего компьютера (команды `supabase db dump` схемы и данных — раздел «Настройки владельца», Supabase; файлы в `private/`). План Free не гарантирует автоматический backup. Восстановление проверяется на **локальной** Supabase (`npm run db:start`, затем `psql`), а не на рабочей базе. Копия содержит гостевые данные: хранить только в `private/`, в Git и чат не передавать.

### 3. Порядок миграций и согласованность схемы и приложения

- Миграции применяются по возрастанию timestamp; применённые не редактируются, исправление — новая миграция. M2 добавил (по порядку): `20261107…_m2_attempt_lifecycle`, `…08…_m2_submission`, `…10…_m2_timing_profiles`, `…11…_m2_timed_blocks`, `…12…_m2_full_exam`, `…13…_m2_error_repeat` (между ними `…09…_word_dictionary_cache`).
- `Release Production` применяет только ожидающие миграции: сверяет, что история Production — префикс файлов репозитория, делает `db push --dry-run`, `db push` и проверяет равенство истории. Порядок «SQL → smoke → promote» значит, что **до promote старую опубликованную версию обслуживает уже новая схема**.
- Поэтому каждая миграция должна быть совместима с кодом, который ещё обслуживает сайт (expand → deploy → contract). Исключение — cutover старых RPC (раздел 4): там совместимость старой версии невозможна, окно между `db push` и promote — известное и короткое (в Release #9 — секунды: `db push` 16:49:30, promote 16:49:35 UTC), но реальное.

### 4. Замена устаревших RPC (cutover)

Миграции M2 удалили или заменили контракты M1: `open_attempt`, `start_attempt`, `restart_attempt` (#39); `finish_attempt`, `save_attempt_answer`, `save_attempt_progress` с параметром времени (#40); `m2_start_attempt` и `m2_private.admit_start` пересозданы (`DROP` + `CREATE`) в #43 ради нового выходного поля; в #45 заменены оба (`create or replace`, прежняя сигнатура), в #47 — `admit_start`.

- Версия приложения до M2 **несовместима** со схемой M2, а приложение M2 несовместимо со схемой до миграции `20261107…`. Эти две стороны нельзя смешивать в рабочем выпуске.
- Выпуск, содержащий cutover, планируется в тихое время; сразу после `db push` workflow гоняет smoke кандидата («after-migrations»), и только затем promote.
- Проверка, что устаревших функций нет (read-only, Supabase SQL Editor):

  ```sql
  select p.proname from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('open_attempt','start_attempt','restart_attempt','finish_attempt',
                      'save_attempt_answer','save_attempt_progress');
  ```

  Ожидается 0 строк. Новые cutover без отдельного ревью не добавлять: сначала expand (новая функция рядом), затем deploy, затем contract отдельным выпуском.

### 5. Окружение Production и секреты

- Vercel Production: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (Sensitive), `APP_ORIGIN=https://b1-kompass.vercel.app` (без неё мутации отклоняются; точное значение и совпадение с алиасом проверяет владелец, агентом не сверялось). `GUEST_SESSIONS_PER_MINUTE` необязательна. `PRACTICE_EXAM_SLUG` не задавать (по умолчанию открывается пилот); допустим только slug реального опубликованного экзамена, тестовое значение направило бы гостей на тестовый экзамен.
- В Production **не** задаются тестовые переменные: `DICTIONARY_TEST_PROVIDER` и e2e-значение `PRACTICE_EXAM_SLUG`. `TIMING_PROFILE_OWNER_DB_URL` нужна только владельцу на компьютере и в Vercel не кладётся.
- Секреты выпуска лежат только в Environments `release-prepare` и `production`; в Git, логи и бандл не попадают (`docs/security.md`).

### 6. Тестовые обёртки не попадают в Production

`m2_test` и `m2-fixtures.sql` существуют только в изолированной локальной БД тестов. Проверки: `production-boundary.spec.ts` (в CI) и, для облака, запрос на отсутствие схемы:

```sql
select nspname from pg_namespace where nspname = 'm2_test';
```

Ожидается 0 строк. Installer фикстур отказывает любой нелокальной БД; запускать его против облака нельзя.

### 7. Проверка выпуска и smoke

Автоматически (workflow): история миграций до/после, staged smoke и smoke после SQL (`GET /` → 200, `Cache-Control … no-store`, «Continue as guest»; `GET /practice` без cookie → 307), `vercel promote`, чтение alias. Это **не** проверяет права, материал, устройства и гостевой маршрут.

Вручную после выпуска (владелец, тестовый Guest; результаты — в таблицу M-04…M-14 [m2-acceptance.md](m2-acceptance.md)):

1. HTTPS-главная, «Continue as guest», выбор режима, свободная тренировка: ответ, «Saved», сдача, разбор.
2. Блок на время и полный экзамен — только если профиль подтверждён (раздел 9). Без него полный экзамен отключён («Coming soon»), а старт блока на время отклоняется сообщением «This mode is not available yet.»; это ожидаемо.
3. Мутация с чужим `Origin` отклоняется (`403`), `http://` ведёт на HTTPS.
4. Vercel logs без ошибок RPC, например `function … does not exist`.

### 8. Проверка Production после выпуска M2

Read-only запросы в Supabase SQL Editor (результаты вносит владелец; агентом не выполнялись). Любое отличие от ожидаемого — остановиться и разобрать, а не игнорировать.

```sql
-- 1. RLS включён на всех таблицах public (ожидается 0 строк)
select c.relname from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity;

-- 2. У anon/authenticated нет прав на таблицы (ожидается 0 строк)
select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public','m2_private','m2_owner') and c.relkind in ('r','v','m','p')
  and (has_table_privilege('anon', c.oid, 'select,insert,update,delete')
    or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'));

-- 3. anon/authenticated не исполняют функции (ожидается 0 строк)
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','m2_private','m2_owner')
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));

-- 4. Закрытые схемы недоступны API-ролям (ожидается false, false)
select has_schema_privilege('anon','m2_private','usage'), has_schema_privilege('authenticated','m2_owner','usage');

-- 5. Перенос M1 (AC-34). Индекс слота на месте (ожидается 1 строка):
select indexname from pg_indexes where indexname = 'attempts_one_active_per_exam';
-- Отменённые дубликаты M1 (информационно: число зависит от данных M1; у каждой — сохранённые ответы и нет результата)
select r.cancel_reason, count(*) from public.attempt_runs r
join public.attempts a on a.id = r.attempt_id
where a.status = 'cancelled' group by 1;
```

Storage и Data API с publishable-ключом: повторить скрипт отказов из M1 (`docs/security.md`, «Статус проверок») для бакета `exam-sources` и таблиц M2; все операции должны быть отклонены. Подписанный URL, уже выданный сервером, до своего TTL остаётся рабочим — это предел архитектуры, а не дефект проверки.

### 9. Подтверждение профиля времени (точный отпечаток)

Публичный timed открывается только для версии, у которой голова профиля `confirmed` с совпавшим отпечатком. Один зелёный CI профиль не подтверждает. Процедура владельца — раздел «Профиль времени (#42)» выше (шаги 1–5); кратко и без исключений:

1. `show --exam <slug>`: версия, единственная дорожка и её `sha256` совпадают с оригинальным Track 127 у владельца.
2. Прослушать запись (24:54), проверить паузы и регламент; решить, годятся ли предварительные 1500 / 60 / 2700 с.
3. `draft` с проверенными значениями; **глазами** сверить версию, `audioSha256`, длительности и `fingerprint` из его вывода.
4. `confirm --revision-id … --fingerprint …` с теми же значениями из шага 3; затем `show`: `confirmedRevisionId` — эта редакция, `headMatches = true`.
5. Любое последующее `draft` закрывает новые timed-старты до нового `confirm`; начатые попытки не меняются. Профиль **другой версии** материала подтверждается отдельно.

Состояние на 2026-11-07: процедура **не выполнена**; значения предварительные; состояние профиля в Production агентом не читалось.

### 10. Откат

- **Не использовать** сброс базы (`db reset`), правку истории миграций, `--include-all` и ручное удаление применённых миграций.
- Приложение: `vercel rollback` или promote предыдущего deployment допустимы **только** если его код совместим с текущей схемой. Старый deployment до M2 несовместим со схемой после `20261107…` (раздел 4): откат к нему сломает сайт. Откат между двумя версиями M2 допустим, если разница между ними не удаляет и не переименовывает контракты схемы и не меняет тела функций, от которых зависит старый код (замена тела через `create or replace` тоже меняет поведение).
- База: исправление вперёд новой миграцией (expand → deploy → contract). Восстановление из копии — крайняя мера по решению владельца после оценки потери данных гостей и проверки на локальной базе.
- Быстрое ограничение без отката кода: новая `draft`-редакция профиля закрывает **новые** timed-старты (свободная тренировка продолжает работать, начатые попытки не меняются).
- Если `db push` применился частично или promote не подтверждён — разбор по таблице «Отказы и восстановление» выше; повторный promote только вручную после проверки.

### Статус внедрения ручного CD

Пять состояний ведутся раздельно; одно не подтверждает другое.

| # | Состояние | Статус |
| --- | --- | --- |
| 1 | Код CD (`release-production.yml`, `gate.mjs`, `vercel.json`, документы) | ✅ слит в `main` (PR #57, `d4a0803`); работает |
| 2 | CI `Quality` на PR head, включая release gate tests | ✅ зелёный на PR #57 и на каждом последующем PR/`main` |
| 3 | Настройки GitHub (ruleset, Environments, reviewer, secrets, vars) и Vercel (bypass, токен, `APP_ORIGIN`) | ✅ в части, которую проверяет workflow: preflight читает Environments, reviewer и branch policy, Stage — проект Vercel, Vercel Authentication и bypass; последние запуски прошли. ⏳ Значение `APP_ORIGIN` в Production и ruleset `main` агентом не сверялись |
| 4 | Проверка CD с approval | ✅ успешные запуски с approval и promote: первый запуск `d4a0803` ([run 42044321009](https://github.com/strakhovdenya/b1-kompass/actions/runs/42044321009)) … Release #9. ⏳ Сценарий «Reject» отдельно не подтверждён; Release #4 завершился `failure` |
| 5 | Первый подтверждённый Production release через CD | ✅ Первый запуск, `d4a0803`, 2026-11-05 ([run 42044321009](https://github.com/strakhovdenya/b1-kompass/actions/runs/42044321009)). Актуальный — Release #9 (`95ac460`, 2026-11-07, [run 42393020156](https://github.com/strakhovdenya/b1-kompass/actions/runs/42393020156)) |

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

### Дополнение 2026-11-07 (M2)

| Что | Статус |
| --- | --- |
| Production-код | ✅ `95ac460` (`main` после PR #70) выложен Release #9 ([run 42393020156](https://github.com/strakhovdenya/b1-kompass/actions/runs/42393020156)); GitHub Deployment `production` 7624044850: success 2026-11-07 16:49:43 UTC, `https://b1-kompass.vercel.app`. Проверка — данные workflow и GitHub API, сайт агентом не открывался |
| Миграции Production | ✅ перед Release #9 «12 из 14», pending `20261112000000_m2_full_exam`, `20261113000000_m2_error_repeat`; после `db push` «14 из 14, pending: none»; история до и после проверена gate |
| Smoke выпуска | ✅ staged и after-migrations: `GET /` и `GET /practice` без Guest. Гостевой маршрут, режимы M2 и права **не** проверялись |
| Предыдущие выпуски M2 | Release #7 `20db12b` (#37–#42), Release #8 `e950c90` (#43) — тот же workflow, успех |
| Профиль времени пилота | ⏳ не подтверждён владельцем по данным репозитория; состояние в Production не читалось. Публичный timed закрыт до `confirm` (раздел «Выпуск M2», п. 9) |
| Права, RLS и Storage объектов M2 в облаке | ⏳ не проверялись (раздел «Выпуск M2», п. 8; M-15, M-16 в [m2-acceptance.md](m2-acceptance.md)) |
| Ручная приёмка на телефоне и компьютере | ⏳ не выполнена (M-04…M-09 в [m2-acceptance.md](m2-acceptance.md)) |

Историческая таблица выше отражает 2026-11-01 и сохранена как есть.
