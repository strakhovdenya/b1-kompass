# Безопасность B1 Kompass (M1)

Состояние на приёмку M1 (P5-T2, #14), 2026-11-01. Здесь описано то, что реально введено и проверено; облачная проверка отмечена отдельно. Итоговая матрица с результатом каждой проверки — в разделе «Приёмочная матрица доступа».

## Принципы

- Привилегированный ключ (`SUPABASE_SECRET_KEY`, роль `service_role`) есть только у сервера Next.js (`apps/web/src/server/**`) и у доверенного скрипта владельца. В браузер не передаётся ни он, ни publishable-ключ: в M1 браузер вообще не обращается к Supabase напрямую.
- Авторизация выполняется в каждой серверной операции (`resolveGuestSession` и повторная проверка в функции БД). Скрытие кнопок и middleware её не заменяют.
- Роль не берётся из клиентских данных или `user_metadata`. Роли «владелец» в приложении нет: владелец действует только через доверенный скрипт с секретным ключом.

## Матрица доступа

| Операция | Guest через сервер | Прямой запрос с publishable-ключом (Data API, Storage) | Владелец (скрипт, секретный ключ) |
| --- | --- | --- | --- |
| Открыть сайт, создать гостевой сеанс | ✅ «Continue as guest», не больше 30 новых сеансов в минуту на весь сайт | ❌ нет прав на `guest_sessions` и `create_guest_session` | — |
| Создать сеанс сверх лимита | ❌ сеанс и cookie не создаются, главная показывает уведомление «попробуйте через минуту» (`home.busy`) | ❌ | — |
| Удалить истёкшие сеансы | ❌ | ❌ нет прав на `purge_expired_empty_guest_sessions` | ежедневная задача pg_cron в базе |
| Прочитать публичную проекцию опубликованного задания | ✅ только через страницу практики | ❌ нет прав на `exams`, `exam_versions` | ✅ |
| Прочитать ключ (`answer_keys`) до завершения попытки | ❌ ни в странице, ни в ответах действий | ❌ таблица закрыта | ✅ |
| Получить ключ в разборе | ✅ только владелец своей завершённой попытки: правильный вариант каждого задания его версии | ❌ | ✅ |
| Разбор активной или чужой попытки | ❌ `not-completed` / `attempt-not-found`, ключ не выдаётся | ❌ | — |
| Прочитать исходники и записи (`exam-sources`) напрямую | ❌ гость не получает путь объекта | ❌ бакет приватный, чтение, список и загрузка отклоняются | ✅ загрузка скриптом |
| Слушать запись | ✅ только по своей попытке: сервер выдаёт подписанный URL на 10 минут, байты читаются из Storage напрямую | ❌ | — |
| Слушать запись по чужой попытке или без сеанса | ❌ `not-found` / `session-invalid`, URL не выдаётся | ❌ | — |
| Сохранить ответ | ✅ только в свою активную попытку, только допустимый вариант, до истечения сеанса | ❌ нет прав на таблицы и функции | — |
| Сохранить ответ в чужую попытку | ❌ `attempt-not-found` | ❌ | — |
| Изменить роль, владельца попытки, сеанс, срок | ❌ лишние поля → `invalid-input`; триггер запрещает менять срок | ❌ | ❌ срок неизменяем и для `service_role` |
| Завершить попытку | ✅ только свою, вводом служит один `attemptId`; балл считает сервер по сохранённым ответам и закрытому ключу | ❌ нет прав на `finish_attempt` | — |
| Записать готовый балл или статус | ❌ лишние поля → `invalid-input` | ❌ нет прав на `attempt_results`, `attempts` | — |
| Изменить ответ или результат завершённой попытки | ❌ поздний ответ → `attempt-not-found`; триггеры `attempt_answers_frozen`, `attempt_results_final`, `attempts_keep_completed` | ❌ | ❌ триггеры действуют и для `service_role` |
| Повторное или параллельное завершение | ✅ возвращает прежний результат, второй не создаётся | ❌ | — |
| Начать заново (`restart_attempt`) | ✅ только со своей завершённой попытки до истечения сеанса; если активная попытка уже есть, возвращается она и новая не создаётся | ❌ нет прав на `restart_attempt` (`42501`) | — |
| Начать заново с чужой или активной попытки | ❌ `attempt-not-found` / `not-completed`, попытки и события не меняются | ❌ | — |
| Прочитать или записать журнал событий (`guest_events`) | ❌ гость журнал не видит, события пишут только функции БД | ❌ нет прав на таблицу (`42501`) | ✅ только чтение и добавление; `update`/`delete`/`truncate` запрещены правами и триггерами |
| Опубликовать материал и запись | ❌ | ❌ `publish_exam_version` не исполняется для anon | ✅ `npm run seed:pilot`: версия, ключи и дорожки одной транзакцией, объект записи должен существовать |
| Зарегистрироваться (Supabase Auth) | ❌ | ❌ регистрация выключена (`enable_signup = false`) | — |

Матрица описывает код и проверки на локальной Supabase и в CI. Права новых объектов P1-T2 в облачном проекте скриптом с publishable-ключом пока не проверялись (см. «Статус проверок»).

## Приёмочная матрица доступа (#14)

Обе таблицы проверяются одним прогоном на одной версии: `apps/web/tests/release-journey.spec.ts`, Playwright-проект `full`, синтетический полный комплект `test-full-dtz`, локальная Supabase. Каждая строка — шаг теста. Сервер вызывается через настоящие функции (`src/server/**`), Data API и Storage — клиентом с обычным publishable-ключом. После каждой группы отказов БД перечитывается: ответы, попытки, место, результат и сеанс владельца остаются прежними.

### Разрешённые операции гостя

Тест «release guest allowed operations pass access matrix».

| Операция | Путь | Проверенный результат |
| --- | --- | --- |
| Войти без email и пароля | `createGuestSession` → `create_guest_session` | Строка `guest_sessions` с `locale = en`, срок ровно 720 часов от `created_at`. `resolveGuestSession` по токену возвращает тот же сеанс |
| Выбрать язык интерфейса | `setGuestLocale` | В БД `locale = ru` только у этого сеанса |
| Открыть опубликованный комплект | `openPractice` → `open_attempt` | 45 заданий. В выдаче нет `correct*` и `answer_keys`. Одна активная попытка |
| Сохранить ответ | `saveAnswer` → `save_attempt_answer` | Ответ перечитан из `attempt_answers` |
| Сохранить место | `saveProgress` → `save_attempt_progress` | `attempts.progress` равен отправленному |
| Слушать запись своей попытки | `resolveAttemptAudio` | Выдаются только `url`, `contentType` и `expiresAt`. По URL скачиваются байты, `sha256` которых совпадает с `exam_version_audio.sha256` |
| Завершить попытку | `finishAttempt` → `finish_attempt` | Одна строка `attempt_results`, балл посчитан сервером |
| Получить разбор своей завершённой попытки | `getAttemptReview` | Тот же разбор. Решения совпадают с ключом версии |
| Начать заново | `restartAttempt` → `restart_attempt` | Прежняя попытка `completed` с одним результатом, новая `active` без ответов |

### Запрещённые пути

Тест «release rejects guest privilege and private resource attacks».

| Попытка | Путь | Проверенный результат |
| --- | --- | --- |
| Получить ключ до завершения | `getAttemptReview`, `restartAttempt` своей активной попытки | `not-completed`, ключ не выдан |
| | HTML и RSC-ответы `/practice`, `/practice/lesen` владельца | Содержат его попытку, но не `correctOptionId`, `correct_option_id`, `review-solution`, `answer_keys` |
| Действовать без сеанса или после срока | `saveAnswer`, `saveProgress`, `finishAttempt`, `getAttemptReview`, `restartAttempt`, `resolveAttemptAudio` с `null` и с истёкшим токеном (часы на `expires_at`) | `session-invalid` у всех шести |
| Действовать в чужой попытке | те же операции с токеном другого гостя | `attempt-not-found`, у записи — `not-found`. Ответы чужого гостя не созданы |
| Подменить роль, владельца, балл, уровень, статус, область, путь объекта | лишние поля `role`, `guestSessionId`, `score`, `level`, `status`, `scope`, `objectPath` во всех операциях | `invalid-input` у всех десяти вызовов |
| Прочитать таблицы | Data API `select` на `answer_keys`, `attempt_answers`, `attempt_results`, `attempts`, `exam_version_audio`, `exam_versions`, `exams`, `guest_events`, `guest_sessions` | Ошибка у каждой, `data = null` |
| Записать готовый результат, ключ, статус, владельца, срок, событие или материал | Data API `insert`/`update`/`delete` на `attempt_results`, `answer_keys`, `attempts`, `guest_sessions`, `attempt_answers`, `exam_versions`, `guest_events` | Ошибка у каждой записи. Состояние владельца не изменилось |
| Вызвать функцию БД | `rpc` всех девяти функций: `create_guest_session`, `start_attempt`, `open_attempt`, `save_attempt_answer`, `save_attempt_progress`, `finish_attempt`, `restart_attempt`, `publish_exam_version`, `purge_expired_empty_guest_sessions` | `42501` у каждой. Поддельный сеанс и поддельный экзамен в БД не появились |
| Прочитать или изменить запись в Storage | `exam-sources`: `download`, `createSignedUrl`, `list` (корень и `audio/`), публичный URL, `upload`, `update`, `remove` | Чтение, подпись и запись отклонены. Список пуст, публичный URL отвечает ошибкой ≥ 400, `remove` ничего не удаляет. Объект скачан сервисным ключом, `sha256` прежний |
| Зарегистрироваться | Supabase Auth `signUp` | Ошибка, пользователь не создан |

Личные ответы и общий кэш проверяет `apps/web/tests/access-matrix.spec.ts` «guest cache never returns another attempt answers». Гость A сохраняет ответы в Hören и Lesen. Перед каждым запросом гостя B и посетителя без cookie гость A запрашивает тот же адрес. Проверяются страницы `/practice` и `/practice/lesen`, а также записанные из браузера RSC-запросы клиентской навигации и prefetch с тем же `_rsc`. Каждый ответ получает `Cache-Control` с `private` и `no-store`, без `public`, `s-maxage`, `x-nextjs-cache` и `Age`. Ответы гостя A содержат его попытку и ответы, это контрольная проверка признаков. В ответах B и посетителя без cookie этих признаков нет, у B на экране не отмечено ни одного варианта.

## RLS и права

Миграции `supabase/migrations/20261031000000_guest_attempts.sql` (P1-T1) и `supabase/migrations/20261101000000_short_practice.sql` (P1-T2):

- RLS включён на всех таблицах `public`; политик нет. Для `anon` и `authenticated` RLS — второй барьер, первый — отсутствие прав.
- `revoke all` на таблицы и последовательности `public` у `anon`/`authenticated`; `revoke execute` на все функции `public` у `public`/`anon`/`authenticated`. Права по умолчанию для будущих объектов роли `postgres` отозваны так же.
- `service_role` получает таблицы и функции явно.
- Data API открывает только схему `public` (`graphql_public` убрана из `supabase/config.toml`).
- Бакет Storage `exam-sources` приватный. Политик на `storage.objects` для него нет, поэтому читать, перечислять и загружать файлы может только `service_role`.
- Опубликованные версии и ключи неизменяемы (триггеры), срок Guest зафиксирован CHECK и триггером.
- P1-T2 добавляет таблицу `exam_version_audio` (дорожки версии, неизменяема триггером, RLS включён, права только у `service_role`) и функции `open_attempt` и `finish_attempt`. Права на них выданы только `service_role`, у `public`/`anon`/`authenticated` они отозваны. Обе функции проверяют срок сеанса и владельца. `finish_attempt` работает под блокировкой строки попытки и возвращает сохранённый результат при повторном вызове.
- Триггеры `attempts_keep_completed`, `attempt_answers_frozen` и `attempt_results_final` запрещают возвращать завершённую попытку в `active`, менять её ответы и менять результат.
- Миграция `supabase/migrations/20261103000000_full_exam_scope.sql` (#8) заменяет `start_attempt`, `open_attempt` (новый параметр `p_scope`) и `finish_attempt` (итоги по навыкам, процент и уровень) новыми сигнатурами и удаляет прежние. Права на новые функции выданы только `service_role`, у `public`/`anon`/`authenticated` отозваны; вызов с publishable-ключом отклоняется по правам (`42501`). Область задаёт сервер по составу версии, клиентские `scope`, `score`, `level` и `role` отклоняются строгой схемой ввода. Новые столбцы `attempt_results` закрыты так же, как вся таблица.
- Миграция `supabase/migrations/20261104000000_attempt_progress.sql` (#10) добавляет столбец `attempts.progress` (закрыт правами таблицы) и функцию `save_attempt_progress`: права только у `service_role`, у `public`/`anon`/`authenticated` отозваны; вызов с publishable-ключом отклоняется по правам и место не меняется. Функция проверяет срок сеанса, владельца, статус `active` и принадлежность id версии попытки; клиентские `role`, `score`, `guestSessionId` отклоняются строгой схемой.
- Миграция `supabase/migrations/20261106000000_guest_renewal.sql` (#12) добавляет таблицу `guest_events` и функцию `restart_attempt`.
  - `guest_events`: RLS включён, политик нет. У `public`/`anon`/`authenticated` прав нет, у `service_role` только `select` и `insert`; триггеры запрещают `update`/`delete`/`truncate`. Журнал хранит только вид события, `visitor_id`, `attempt_id` и время, без IP, user agent и отпечатка.
  - `restart_attempt`: права только у `service_role`, у `public`/`anon`/`authenticated` отозваны.
  - `create_guest_session`, `start_attempt` и `finish_attempt` заменены с прежними сигнатурами и правами.
- Миграция `supabase/migrations/20261102000000_guest_session_limits.sql` (#18) добавляет функции `create_guest_session` и `purge_expired_empty_guest_sessions`; исполнять их может только `service_role`, у `public`/`anon`/`authenticated` права отозваны.

## Лимит и очистка гостевых сеансов

- Новый сеанс создаётся только через `create_guest_session`: подсчёт и вставка в одном вызове под транзакционной advisory-блокировкой. На весь сайт — не больше 30 новых сеансов за минуту (`GUEST_SESSIONS_PER_MINUTE`, по умолчанию 30). Сверх лимита сеанс и cookie не создаются, посетитель видит на главной уведомление попробовать снова через минуту.
- Лимит считает только `guest_sessions.created_at`. IP-адрес, user agent и отпечаток устройства не используются и не хранятся (PRD, инварианты 4–5).
- Раз в сутки задача pg_cron `purge-expired-empty-guest-sessions` удаляет сеансы, у которых истёк срок (`expires_at <= now`) и нет ни одной попытки. Сеанс с попыткой сохраняется. Накопленные события лежат в `guest_events` без ссылки на сеанс, поэтому очистка их не уменьшает.
- Объекты записи лежат в том же приватном бакете по пути `audio/<sha256>.<ext>`. Браузер получает подписанный URL со сроком 10 минут только от `server/audio` после проверки сеанса и владельца попытки; сам путь не отдаётся. Подробнее: `docs/architecture.md`, `docs/deployment.md`.

## Данные в браузере и кэш

- Начальный HTML и данные страницы практики содержат задания, варианты и сохранённые ответы, но не ключ и не секреты, пока попытка активна; это проверяется тестом. Ключ появляется на странице только в разборе завершённой попытки её владельца.
- Подписанный URL записи попадает только в ответ действия владельцу попытки: не в начальный HTML и не в журналы сервера.
- Немецкий материал выводится как текст средствами React, без `dangerouslySetInnerHTML`; тест рендерит вредоносные `<img onerror>` и `<script>` и проверяет экранирование.
- Все ответы сайта получают `Cache-Control: private, no-store`, страницы гостя динамические: личные ответы не попадают в общий кэш. Дополнительно заданы `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`.
- Секреты не пишутся в Git (`.env*`, `private/` исключены), журналы сервера не выводят токены.

## Статус проверок

| Проверка | Где | Статус |
| --- | --- | --- |
| Отказы Data API и Storage с publishable-ключом, вызов закрытых функций, регистрация | `apps/web/tests/guest-entry.spec.ts` «denies foreign attempt secret and direct API mutations» | ✅ локальная Supabase и CI |
| Чужая попытка, отсутствующий сеанс, лишние поля роли/балла/владельца, перечитывание БД после отказа | там же | ✅ |
| Срок 30 дней, отказ ровно в момент истечения | «guest expiry remains fixed before deadline», «rejects guest at expiry boundary» | ✅ |
| Ключ и секрет отсутствуют в HTML | «saves one real answer after server acknowledgement» | ✅ |
| Экранирование текста материала | `apps/web/src/features/practice/QuestionCard.test.tsx` | ✅ |
| Завершение: один результат при двойном и параллельном finish, поздний ответ, ручная запись балла, разбор раннего и чужого | `apps/web/tests/short-practice.spec.ts` «duplicate finish and late save cannot change result», «denies early foreign review and client score», «completed owned attempt exposes review» | ✅ CI `Quality` (PR #19) |
| Запись: чужая попытка и сеанс, закрытый бакет, закрытые таблицы и функции для publishable-ключа | там же «denies early foreign review and client score», «seed publishes short set with audio once» | ✅ CI `Quality` (PR #19) |
| Лимит сеансов в минуту, уведомление без cookie, очистка истёкших пустых сеансов, отказ publishable-ключу на обе функции | `apps/web/tests/guest-limits.spec.ts` | ✅ локальная Supabase |
| Те же права в облачном проекте Supabase | ручная проверка 2026-10-31 скриптом с publishable-ключом | ✅ все отказы подтверждены, регистрация выключена; см. `docs/deployment.md` |
| Права новых объектов P1-T2 (`exam_version_audio`, `open_attempt`, `finish_attempt`) в облачном проекте | — | ⏳ скриптом с publishable-ключом не проверялись: миграция применена владельцем, но облачная проверка отказов после неё не выполнялась |
| Задача очистки в облачном проекте (Integrations → Cron) | ручная проверка владельца после `supabase db push` | ⏳ не выполнена |
| Приёмочная матрица: разрешённые операции, запрещённые серверные, Data API и Storage пути | `apps/web/tests/release-journey.spec.ts` «release guest allowed operations pass access matrix», «release rejects guest privilege and private resource attacks» | ✅ локальная Supabase 2026-11-01. CI `Quality` — на PR #34 |
| Общий кэш не отдаёт чужие ответы | `apps/web/tests/access-matrix.spec.ts` «guest cache never returns another attempt answers» | ✅ локальная Supabase 2026-11-01. CI `Quality` — на PR #34 |
| Production: заголовки и клиентский код | `curl https://b1-kompass.vercel.app/` 2026-10-31 23:23 UTC, только чтение | ✅ `200`, `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, HSTS, `nosniff`, `DENY`, `same-origin`. `/practice` без cookie → `307` на `/`, `http://` → `308` на HTTPS. В 12 JS-файлах главной (≈ 0,9 МБ) нет `sb_secret_`, `service_role`, `SUPABASE_SECRET_KEY`, адреса Supabase, `answer_keys`, `correct_option_id` |
| Работа сайта на Vercel по HTTPS: вход, ответы, разбор | ручная проверка владельца | ⏳ не выполнена: гостевой маршрут на production не проходился (решение владельца: только чтение) |
| Те же отказы Data API и Storage в облачном проекте после миграций #3–#12 | скрипт с publishable-ключом | ⏳ не выполнена |
