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
| Сдать попытку (`POST …/submit` → `m2_accept_submission`, затем `m2_finalize_attempt`, #40) | ✅ только свою активную, по cookie и точному `Origin`; ответы только назначенных заданий и их вариантов; подтверждение числа пропусков; балл считает сервер по замороженному снимку и закрытому ключу, БД сверяет его с тем же снимком | ❌ нет прав на `m2_accept_submission`, `m2_finalize_attempt` | ✅ `service_role` вызывает только эти обёртки; ядро с явным временем недоступно |
| Отменить попытку (`POST …/cancel` → `m2_cancel_attempt`, #40) | ✅ только свою активную; результата нет, одно событие `cancel`; после сдачи — `conflict` | ❌ нет прав на `m2_cancel_attempt` | — |
| Записать готовый балл или статус | ❌ лишние поля → `invalid-input` | ❌ нет прав на `attempt_results`, `attempts` | — |
| Изменить ответ, снимок или результат сданной, завершённой или отменённой попытки | ❌ поздний ответ и место → `attempt-not-found`; триггеры `attempt_answers_frozen`, `attempt_results_final`, `attempt_results_checked`, `attempts_guard_lifecycle`, `attempt_runs_fixed` | ❌ | ❌ триггеры действуют и для `service_role`; `attempt_runs` (снимок, метка истории) ему только для чтения |
| Повторная или параллельная сдача, повтор после потерянного ответа | ✅ та же `commandId` возвращает прежний приём и результат, второй не создаётся; гонка сдачи и отмены даёт ровно один конечный исход | ❌ | — |
| Явно начать попытку (`POST /api/attempts/start` → `m2_start_attempt`, #39) | ✅ только по своей cookie и с точным `Origin` сервера; один активный слот на экзамен; тот же `commandId` возвращает прежнюю попытку, новый при активной — `conflict` | ❌ нет прав на `m2_start_attempt` | ✅ `service_role` вызывает только `m2_start_attempt`; ядро с явным временем и функции переноса M1 ему недоступны |
| Открыть выбор, страницу попытки, старый адрес `/practice` | ✅ только чтение: попытка и событие `start` не создаются; чужая или отменённая попытка — 404 | ❌ | — |
| «Пройти заново» | ✅ только открывает выбор; новая попытка — отдельный явный старт | ❌ `restart_attempt`, `open_attempt`, `start_attempt` удалены | — |
| Прочитать или изменить `attempt_runs`, `attempt_commands` | ❌ | ❌ нет прав | ✅ только `select`; идентичность run и команды неизменяемы триггерами, вставку делает только `m2_start_attempt` |
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
| Открыть опубликованный комплект | явный старт `startAttempt` → `m2_start_attempt`, затем `readAttemptPage` по адресу попытки | 45 заданий. В выдаче нет `correct*` и `answer_keys`. Одна активная попытка |
| Сохранить ответ | `saveAnswer` → `m2_save_answer` | Ответ перечитан из `attempt_answers` |
| Сохранить место | `saveProgress` → `m2_save_progress` | `attempts.progress` равен отправленному |
| Слушать запись своей попытки | `resolveAttemptAudio` | Выдаются только `url`, `contentType` и `expiresAt`. По URL скачиваются байты, `sha256` которых совпадает с `exam_version_audio.sha256` |
| Сдать попытку | статус `readAttemptStatus`, затем `submitAttempt` → `m2_accept_submission` и `m2_finalize_attempt` (тестовый `submitStored`) | Одна строка `attempt_results`, балл посчитан сервером |
| Получить разбор своей завершённой попытки | `getAttemptReview` | Тот же разбор. Решения совпадают с ключом версии |
| Начать заново | «Пройти заново» открывает выбор, затем новый явный старт с новым `commandId` | Прежняя попытка `completed` с одним результатом, новая `active` без ответов |

### Запрещённые пути

Тест «release rejects guest privilege and private resource attacks».

| Попытка | Путь | Проверенный результат |
| --- | --- | --- |
| Получить ключ до завершения | `getAttemptReview` своей активной попытки | `not-completed`, ключ не выдан |
| | HTML и RSC-ответы адреса попытки `/practice/<exam>/attempts/<id>` и `…/lesen` владельца | Содержат его попытку, но не `correctOptionId`, `correct_option_id`, `review-solution`, `answer_keys` |
| Действовать без сеанса или после срока | `saveAnswer`, `saveProgress`, сдача (`submitStored`), `getAttemptReview`, `startAttempt`, `resolveAttemptAudio` с `null` и с истёкшим токеном (часы на `expires_at`) | `session-invalid` у всех шести |
| Действовать в чужой попытке | те же операции с токеном другого гостя | `attempt-not-found`, у записи — `not-found`. Ответы чужого гостя не созданы |
| Подменить роль, владельца, балл, уровень, статус, область, путь объекта | лишние поля `role`, `guestSessionId`, `score`, `level`, `status`, `scope`, `objectPath` во всех операциях | `invalid-input` у всех десяти вызовов |
| Прочитать таблицы | Data API `select` на `answer_keys`, `attempt_answers`, `attempt_results`, `attempts`, `exam_version_audio`, `exam_versions`, `exams`, `guest_events`, `guest_sessions` | Ошибка у каждой, `data = null` |
| Записать готовый результат, ключ, статус, владельца, срок, событие или материал | Data API `insert`/`update`/`delete` на `attempt_results`, `answer_keys`, `attempts`, `guest_sessions`, `attempt_answers`, `exam_versions`, `guest_events` | Ошибка у каждой записи. Состояние владельца не изменилось |
| Вызвать функцию БД | `rpc` функций `create_guest_session`, `m2_start_attempt`, `m2_save_answer`, `m2_save_progress`, `m2_accept_submission`, `m2_cancel_attempt`, `m2_finalize_attempt`, `m2_reconcile_attempt`, `publish_exam_version`, `purge_expired_empty_guest_sessions`; удалённые `start_attempt`, `open_attempt`, `restart_attempt`, `save_attempt_answer`, `save_attempt_progress`, `finish_attempt` | `42501` у действующих, удалённые не найдены ни одной роли. Поддельный сеанс и поддельный экзамен в БД не появились |
| Прочитать или изменить запись в Storage | `exam-sources`: `download`, `createSignedUrl`, `list` (корень и `audio/`), публичный URL, `upload`, `update`, `remove` | Чтение, подпись и запись отклонены. Список пуст, публичный URL отвечает ошибкой ≥ 400, `remove` ничего не удаляет. Объект скачан сервисным ключом, `sha256` прежний |
| Зарегистрироваться | Supabase Auth `signUp` | Ошибка, пользователь не создан |

Личные ответы и общий кэш проверяет `apps/web/tests/access-matrix.spec.ts` «guest cache never returns another attempt answers». Гость A сохраняет ответы в Hören и Lesen. Перед каждым запросом гостя B и посетителя без cookie гость A запрашивает тот же адрес. Проверяются реальные страницы конкретной попытки (Hören и Lesen; с #39 старые `/practice` и `/practice/lesen` — только перенаправление и проверяются отдельно как совместимость), а также записанные из браузера RSC-запросы клиентской навигации и prefetch с тем же `_rsc`. Каждый ответ получает `Cache-Control` с `private` и `no-store`, без `public`, `s-maxage`, `x-nextjs-cache` и `Age`. Ответы гостя A содержат его попытку и ответы, это контрольная проверка признаков. В ответах B и посетителя без cookie этих признаков нет, у B на экране не отмечено ни одного варианта.

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
- Миграция `supabase/migrations/20261107000000_m2_attempt_lifecycle.sql` (#39):
  - таблицы `attempt_runs` и `attempt_commands`: RLS включён, у `public`/`anon`/`authenticated`/`service_role` отозвано всё, `service_role` получает только `select`. Вставляет их только `m2_start_attempt`; триггеры запрещают менять run (кроме однократной причины отмены) и команду;
  - схема `m2_private` не экспонируется Data API и не даёт USAGE ни одной API-роли. В ней owner-only `backfill_m1_attempts`, `cancel_m1_duplicates`, `slot_key` и ядро `admit_start` с явным временем; у каждой функции явный `REVOKE` от `public`, `anon`, `authenticated`, `service_role` (default privileges не считаются заменой);
  - `public.m2_start_attempt` без параметра времени, SECURITY DEFINER с пустым `search_path`: так `service_role` вызывает старт, не получая доступа к ядру с временем. `EXECUTE` отозван у `public`/`anon`/`authenticated`, выдан только `service_role`;
  - триггеры `attempts_guard_lifecycle` (идентичность, конечные `completed`/`cancelled`) и расширенный `attempt_answers_frozen` действуют и для `service_role`;
  - `restart_attempt`, `open_attempt`, `start_attempt` удалены.
- Runtime-команды идут через Route Handlers (`app/api/attempts/**`, `server/next/http.ts`): только POST, точный `Origin` из `APP_ORIGIN` (или Vercel preview), `Content-Type: application/json`, тело ≤ 64 KiB, строгая схема; отказ — до чтения сеанса и любой записи. Host и forwarded-host не доверяются. Токен Guest берётся только из httpOnly cookie; токен в теле, query или заголовке не авторизует. Ответы `Cache-Control: private, no-store`.
- Миграция `supabase/migrations/20261108000000_m2_submission.sql` (#40):
  - новые `public.m2_save_answer`, `m2_save_progress`, `m2_accept_submission`, `m2_cancel_attempt` — SECURITY DEFINER с пустым `search_path`, без параметра времени: берут блокировку строки попытки, затем `clock_timestamp()` и вызывают ядро `m2_private` (проверка Guest после ожидания блокировки, владелец, назначение, вариант, ревизия, подтверждение). `m2_finalize_attempt` — SECURITY INVOKER: вставку результата проверяет триггер `attempt_results_checked` для любой роли. `EXECUTE` отозван у `public`/`anon`/`authenticated`, выдан только `service_role`;
  - ядра `m2_private.save_answer`, `save_progress`, `accept_submission`, `cancel_attempt` с явным временем, их помощники и owner-only `mark_legacy_completed` недоступны ни одной API-роли, `service_role` в том числе; тестовые обёртки с временем — только `tests/support/m2-fixtures.sql`;
  - `save_attempt_answer`, `save_attempt_progress` и `finish_attempt` удалены без перегрузок совместимости;
  - снимок сдачи и `legacy_completed` лежат в `attempt_runs`, где у `service_role` только `select`; триггеры фиксируют снимок один раз, запрещают снимать метку, вставлять помеченный run и метить неподходящую попытку даже владельцу;
  - Origin, метод, тип, размер и строгая схема новых Route Handlers те же, что у старта; `attemptId` берётся только из адреса.
- Миграция `supabase/migrations/20261111000000_m2_timed_blocks.sql` (#43) — блок на время:
  - `public.m2_start_attempt` и ядро `m2_private.admit_start` пересозданы `DROP + CREATE` ради нового выходного поля `closed_attempt_id` (id истёкшей попытки, закрытой стартом, остаётся на доверенном сервере и в публичный ответ не попадает); входные сигнатуры прежние, параметра времени у production-функции нет. Права восстановлены явно: ядро — `REVOKE` у `public`/`anon`/`authenticated`/`service_role`, `m2_start_attempt` — `EXECUTE` только у `service_role`;
  - новый `public.m2_reconcile_attempt(uuid, uuid)` — SECURITY DEFINER, `search_path = ''`, без параметра времени, `EXECUTE` только у `service_role`: блокирует строку открытой timed-попытки, читает `clock_timestamp()` и закрывает истёкший run; новые `m2_private.run_deadline`, `timely_answers`, `close_expired`, `reconcile_attempt` недоступны ни одной API-роли;
  - срок, профиль и запас Guest проверяет SQL после блокировок; клиентские длительность, срок, время и профиль отклоняются строгой схемой, test-only обёртки с временем (`m2_test.start_attempt_at`, `m2_test.reconcile_attempt_at`) — только `tests/support/m2-fixtures.sql`;
  - timed-run обязан нести закреплённый профиль (CHECK), снимок закрытия сроком без команды сдачи допустим только не для training (CHECK); проверки — `apps/web/tests/timed-block.spec.ts` и `apps/web/tests/attempt-lifecycle.spec.ts`.
- Миграция `supabase/migrations/20261106000000_guest_renewal.sql` (#12) добавляет таблицу `guest_events` и функцию `restart_attempt` (удалена в #39).
  - `guest_events`: RLS включён, политик нет. У `public`/`anon`/`authenticated` прав нет, у `service_role` только `select` и `insert`; триггеры запрещают `update`/`delete`/`truncate`. Журнал хранит только вид события, `visitor_id`, `attempt_id` и время, без IP, user agent и отпечатка.
  - `restart_attempt`: права только у `service_role`, у `public`/`anon`/`authenticated` отозваны.
  - `create_guest_session`, `start_attempt` и `finish_attempt` заменены с прежними сигнатурами и правами.
- Миграция `supabase/migrations/20261102000000_guest_session_limits.sql` (#18) добавляет функции `create_guest_session` и `purge_expired_empty_guest_sessions`; исполнять их может только `service_role`, у `public`/`anon`/`authenticated` права отозваны.

- Миграция `supabase/migrations/20261109000000_word_dictionary_cache.sql` (#60) — словарь слов:
  - таблицы `dictionary_cache` и `dictionary_budget`: RLS включён, политик нет, у `public`/`anon`/`authenticated` отозвано всё, у `service_role` — `select/insert/update/delete`. Прямой Data API с publishable-ключом получает `42501` на чтение и запись, кэш не меняется;
  - `reserve_dictionary_budget(uuid, jsonb)` — SECURITY INVOKER, `search_path = ''`; `EXECUTE` отозван у `public`/`anon`/`authenticated`, выдан только `service_role`. Функция сама проверяет, что Guest существует и `now() < expires_at`, и резервирует все scopes вызова или ни одного (упорядоченные условные upsert, отказ откатывает всю транзакцию);
  - `purge_dictionary_data(timestamptz)` — только `service_role` и pg_cron; внешних ключей к `guest_sessions` нет, очистка сеансов работает как раньше;
  - в кэше нет session id, ответов, результатов и ключей; scopes `guest:<session id>` и `guestread:<session id>` бюджета живут не дольше двух суток;
  - каждый lookup, включая слово из кэша, вызывает функцию (scope `guestread`): сеанс проверяется и `resolveGuestSession`, и функцией БД.

- Миграция `supabase/migrations/20261110000000_m2_timing_profiles.sql` (#42) — профиль времени:
  - таблицы `m2_private.timing_profiles` и `m2_private.timing_profile_revisions` лежат в неэкспонируемой схеме: RLS включён, политик нет, у `public`/`anon`/`authenticated`/`service_role` отозвано всё, USAGE на схему нет ни у одной API-роли. Триггеры действуют для любой роли, владельца тоже: новая редакция — только следующий номер, `draft`, с отпечатком, который вычисляет БД, и единственной записью своей версии, которую играет её Hören-материал; данные редакции не меняются и не удаляются, единственное изменение — `draft → confirmed` текущей головы; голова только сдвигается на следующую редакцию, а отложенный constraint trigger при commit требует, чтобы новая редакция стала головой (сирота над головой невозможна); `truncate` запрещён;
  - owner-only функции в схеме `m2_owner` (`timing_profile_state`, `create_timing_profile_revision`, `confirm_timing_profile_revision`): SECURITY DEFINER, `search_path = ''`, без динамического SQL; `EXECUTE` и USAGE схемы отозваны у `public`, `anon`, `authenticated` **и `service_role`**. Исполнить их может только владелец/DDL-роль БД (`postgres`), подключённая через `TIMING_PROFILE_OWNER_DB_URL` из `scripts/manage-timing-profile.ts`. Runtime-ключ `SUPABASE_SECRET_KEY` (роль `service_role`) подтвердить профиль не может по правам БД, а не только потому, что web не импортирует инструмент; owner URL не задаётся в Vercel и GitHub. Значения передаются переменными `psql` (`:'name'`), пароль — через окружение libpq, а не аргументы процесса;
  - `m2_private.current_confirmed_profile(version_id)` — приватный read-only gate без прав у API-ролей. Для runtime есть одна функция `public.m2_confirmed_timing_profile(uuid)`: SECURITY DEFINER, `search_path = ''`, `EXECUTE` только у `service_role`, возвращает подтверждённый снимок или `null` без блокировки строк; publishable-ключ получает `42501`. Вызывает её только `apps/web/src/server/attempts/profiles.ts`; в браузер профиль не передаётся;
  - `attempt_runs.timing_profile_revision_id` / `timing_profile_snapshot`: у `service_role` по-прежнему только `select`; триггер `guard_new_attempt_run` принимает закрепление лишь текущей подтверждённой головы своей версии, совпадающей с записью, с точным документом, `guard_attempt_run` запрещает менять его после вставки; training-run профиль не закрепляет (CHECK);
  - негативные проверки — `apps/web/tests/timing-profile.spec.ts`: права схем, таблиц и функций и PUBLIC ACL, SECURITY DEFINER и `search_path`, Data API с publishable- и secret-ключом, `SET ROLE service_role/anon/authenticated`, статический поиск owner-функций в `apps/web/src`.

## Словарь: API и внешние провайдеры (#60)

- `POST /api/dictionary`: `readCommandBody` (POST, точный `Origin`, `application/json`, ≤ 64 KiB, JSON), затем отказ `413` для объявленного `Content-Length` > 1 KiB, затем `resolveGuestSession` по httpOnly cookie. Строгая схема `{word: string}`: лишние поля (например, `target`) — `400`. Слово проверяется (`features/dictionary/word.ts`: одна латинская лексема, без пробелов, цифр, URL, управляющих символов и других письменностей, ≤ 64 символов / 200 байт) до кэша, бюджета и сети. Ответ всегда `Cache-Control: private, no-store`. Отказ по Origin/сеансу/телу не пишет кэш и не тратит бюджет (`apps/web/tests/dictionary.spec.ts`).
- Язык перевода — только `locale` проверенного Guest на сервере; из тела запроса не принимается.
- Браузер не обращается к MyMemory и OpenThesaurus. Сервер ходит только на фиксированные HTTPS-адреса (`api.mymemory.translated.net/get`, `www.openthesaurus.de/synonyme/search`), пользовательский URL не принимает; `redirect: 'error'`, таймаут 4 с, ответ ≤ 64 KiB, JSON проверяется схемой, повторов нет.
- Провайдерам уходят только выбранное слово, языковая пара и необязательный контакт `DICTIONARY_CONTACT_EMAIL` (MyMemory `de`, User-Agent OpenThesaurus). Не передаются текст материала, ответы, ключи, cookies, IP (`ip` и `X-Forwarded-For` не задаются), Guest ID.
- Ответ провайдера не доверяется: `quotaFinished`, `responseStatus ≠ 200`, `MYMEMORY WARNING`, перевод, равный слову, строки с управляющими символами или ссылками не считаются переводом и не кэшируются как перевод. Карточка выводит строки только как React-текст; ссылки DWDS/Duden/Google Translate/источников строятся приложением из проверенного слова (`rel="noopener noreferrer"`), URL из ответа провайдера не становятся ссылкой (`DictionaryCard.test.tsx`).
- Журналы сервера по словарю содержат только имя провайдера и вид отказа или код ошибки БД, без слова, сеанса и тела ответа.
- Тестовый провайдер (`DICTIONARY_TEST_PROVIDER=1`) подменяет только HTTP-источники: проверка Guest, кэш и бюджет работают по-настоящему. Он принимается только без `VERCEL_ENV` и с loopback `APP_ORIGIN`; иначе конфигурация считается ошибочной и сервер не отвечает переводами вообще (`503`), фиктивных ответов нет.
- Переключатель словаря хранит в `localStorage` один boolean; личные данные и слова в браузере не сохраняются, кроме памяти страницы.

## Лимит и очистка гостевых сеансов

- Новый сеанс создаётся только через `create_guest_session`: подсчёт и вставка в одном вызове под транзакционной advisory-блокировкой. На весь сайт — не больше 30 новых сеансов за минуту (`GUEST_SESSIONS_PER_MINUTE`, по умолчанию 30). Сверх лимита сеанс и cookie не создаются, посетитель видит на главной уведомление попробовать снова через минуту.
- Лимит считает только `guest_sessions.created_at`. IP-адрес, user agent и отпечаток устройства не используются и не хранятся (PRD, инварианты 4–5).
- Раз в сутки задача pg_cron `purge-expired-empty-guest-sessions` удаляет сеансы, у которых истёк срок (`expires_at <= now`) и нет ни одной попытки. Сеанс с попыткой сохраняется. Накопленные события лежат в `guest_events` без ссылки на сеанс, поэтому очистка их не уменьшает.
- Объекты записи лежат в том же приватном бакете по пути `audio/<sha256>.<ext>`. Браузер получает подписанный URL только от `server/audio` после проверки сеанса и владельца попытки (свободный плеер — 10 минут; полный экзамен — остаток Hören + 300 с, только в открытом Hören, #45); сам путь не отдаётся. Подробнее: `docs/architecture.md`, `docs/deployment.md`.

## Явная замена Guest перед блоком на время (#44)

- Срок Guest (720 часов) не продлевается ни при каких условиях. Если оставшегося срока не хватает на выбранный блок и запас 300 с, старт отвечает `guest-too-short`, а `ModeSelection` показывает `GuestReplacementDialog`. Диалог объясняет: прежние попытки и результаты не удаляются, но после начала нового сеанса недоступны в этом браузере (cookie новая); чужие браузеры не затронуты. Новый сеанс всегда English.
- Замена — два отдельных шага. 1) Server Action `replaceGuestAction` (единственная граница identity, как `continueAsGuest`): требует `consent: true`, берёт старый сеанс только из httpOnly cookie, заново вызывает read-only `preflightTimedStart` для того же запроса и создаёт Guest только если сам preflight вернул `guest-too-short`. Достаточный запас — `replacement-not-needed`; активная попытка — `conflict`; черновик/нет профиля, сменившаяся версия, отсутствие или истёкший старый сеанс — отказ без cookie и без записи. Затем тот же `createGuestSession` с прежним общим лимитом (`rate-limited` — без Guest, cookie и попытки) и `writeGuestCookie`. 2) Только после установки cookie браузер отдельным HTTP-запросом `POST /api/attempts/start` с **новым** `commandId` запускает выбранный блок; SQL заново авторизует нового Guest и применяет все свои проверки. Попытка не создаётся под старым токеном и не создаётся в Server Action.
- Токен только в httpOnly cookie; клиент не передаёт visitor_id, sessionId, срок или «одобрение сервера» (лишние поля отклоняет строгая схема). Origin защищает встроенная проверка Server Actions Next.js (чужой Origin отклоняется до кода) вместе с SameSite=Lax. Старые попытки и результаты принадлежат прежнему `visitor_id`; новый Guest получает по их id отказ, как любой чужой.
- Если старт после замены не удался, новая cookie остаётся действительной, выбор режима и блока сохраняется, повтор идёт с тем же `commandId` (потерянный ответ) или с новым выбором.
- Остаточное ограничение. Между preflight и записью cookie нет общего блокирующего слота: другая вкладка старого сеанса может успеть создать active-попытку, пока создаётся новый Guest. Это окно не устранено атомарно. Последствия ограничены: такая старая попытка остаётся в БД, новый Guest её не видит, а любой новый старт проходит SQL-допуск (слот, профиль, запас) заново. Последовательное изменение другой вкладкой до повторного preflight даёт отказ без cookie.

## Полный экзамен: материал, запись и окончательность этапов (#45)

- Lesen до своего этапа не выдаётся ни в одной публичной форме: HTML и RSC payload обоих адресов попытки, props layout и страницы, статус, ответы `begin-lesen`, сохранения и сдачи. Проекция открытого экзамена содержит только задания видимой фазы (`visibleSkillsOf`); сданный экзамен без сохранённого результата — только то, что было открыто до сдачи (Lesen — лишь если он начался), весь материал — только в разборе `completed`; о Lesen передаются только числа (`summary`). Скрытие вкладки в интерфейсе этим не заменяется: прямой `/lesen` перенаправляет на Hören, сохранение задания Lesen до начала отклоняется SQL (`phase_closed`) и ничего не пишет.
- Окончательность Hören проверяет БД после блокировки строки по `clock_timestamp()`: сохранение и сдача не меняют ответы и ревизии закрытого Hören, даже если устаревшая вкладка шлёт их с бо́льшими номерами; ответы не открытого Lesen в пакете сдачи не принимаются. Подтверждение сверяется с фазой и числом пропусков по всему назначению в момент приёма. Момент раннего начала Lesen пишется один раз (`guard_attempt_run`: `attempt_run_fixed`, `lesen_start_invalid` — в том числе для владельца БД); у `service_role` прав на прямой UPDATE `attempt_runs` нет.
- Запись: `prepare-audio` и `[attemptId]/audio` — отдельные Route Handlers (точный Origin, JSON, ≤ 64 KiB, `private, no-store`, строгая схема: позиция, длительность или время от клиента — `invalid-input`). Подготовка не создаёт попытку и отказывает при занятом слоте; экзамен слота, истёкший без чтения, сначала закрывается под блокировкой и получает результат, без него новая ссылка не выдаётся; после закрытия Hören новый адрес не выдаётся ни этим путём, ни Server Action свободного плеера (общий gate в `resolveAttemptAudio`, `phase-closed`) до разбора завершённой попытки. Уже выданный адрес живёт до своего TTL.
- Пределы штатных ограничений. Полный плеер не показывает pause/seek/«назад»/скорость, неактивный элемент прерывает любой `play()` (страница, медиакнопки, Media Session), Media Session не перематывает. Это ограничение интерфейса, а не защита: полученный файл или действующий подписанный URL можно сохранить, запомненный ключ или ответы — передать; прокторинга нет. Сроки, допуск записи и результат от этого не зависят — их решает только сервер.
- `m2_begin_lesen(uuid, uuid)` — SECURITY DEFINER, пустой `search_path`, без параметра времени; EXECUTE только `service_role`, ядро `m2_private.begin_lesen` и вспомогательные функции фаз — только владельцу. Тестовая обёртка `m2_test.begin_lesen_at` живёт только в `tests/support/m2-fixtures.sql` изолированной БД.

## Данные в браузере и кэш

- Начальный HTML и данные страницы практики содержат задания, варианты и сохранённые ответы, но не ключ и не секреты, пока попытка активна; это проверяется тестом. Ключ появляется на странице только в разборе завершённой попытки её владельца.
- Подписанный URL записи попадает только в ответ действия владельцу попытки: не в начальный HTML и не в журналы сервера.
- Немецкий материал выводится как текст средствами React, без `dangerouslySetInnerHTML`; тест рендерит вредоносные `<img onerror>` и `<script>` и проверяет экранирование.
- Все ответы сайта получают `Cache-Control: private, no-store`, страницы гостя динамические: личные ответы не попадают в общий кэш. Дополнительно заданы `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`.
- Секреты не пишутся в Git (`.env*`, `private/` исключены), журналы сервера не выводят токены.

## Секреты CI/CD и выпуск Production (#56)

- CI (`Quality`) работает без production-секретов: локальная Supabase в Docker, тестовые ключи.
- Секреты выпуска хранятся только в GitHub Environments, не на уровне repository/organization:
  - `release-prepare` — `VERCEL_TOKEN` (staged deployment и smoke);
  - `production` — `VERCEL_TOKEN` и `SUPABASE_DB_URL`. Этот Environment требует approval владельца (`strakhovdenya`, self-review разрешён), поэтому ни один шаг с `SUPABASE_DB_URL` и `vercel promote` не выполняется до подтверждения.
  - Оба Environment разрешены только ветке `main`; preflight без секретов проверяет это через GitHub API и отказывает при отсутствии Environment, лишней ветке, другом reviewer или ошибке API.
- Секрет попадает только в `env` конкретного шага, которому он нужен (Vercel CLI читает `VERCEL_TOKEN` из окружения, не из аргументов); `npm ci`, сборка и job-level `env` его не видят; `checkout` без сохранённых учётных данных. Gate не печатает URL базы, токены и значения bypass, `vercel curl` выполняется без вывода; `.vercel/` удаляется, артефакты не публикуются.
- Supabase: используется узкая строка подключения Session pooler проверенного проекта (`postgres.<project>`, `*.pooler.supabase.com:5432`, TLS), а не account-wide `SUPABASE_ACCESS_TOKEN`. Запрещены сброс базы, правка истории миграций, `config push`, `--include-all`.
- Карточка выпуска в Step Summary (#58): в неё не попадают токены, `SUPABASE_DB_URL`, значение bypass, содержимое `.vercel/` и тела HTTP-ответов; функция карточки читает только перечисленные поля. Название выпуска, тексты коммитов, комментарий approval и login проходят через одну функцию экранирования markdown. Название (`label`) — недоверенный ввод: белый список в `Preflight`, в шаги только через `env`, не в `run:`. Подтвердившего читает `GET …/actions/runs/<id>/approvals` существующим правом `actions: read` job `Release`; права не расширялись.
- Vercel: Vercel Authentication не отключается; gate требует `ssoProtection` с охватом production deployment URL (не `null`, не `enabled: false`, не только `preview`). Protection Bypass for Automation создаёт и отзывает владелец в Vercel; в GitHub он не хранится, `vercel curl` берёт его через API для smoke-GET. Gate отказывает, если bypass не создан заранее (иначе CLI создал бы новый постоянный секрет).

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
| Сдача, отмена, расчёт: обход удержанного save/progress, повтор, гонки, подтверждение, назначение, вариант, срок Guest после блокировки, время от клиента, права и прямые записи `service_role` | `apps/web/tests/exam-submission.spec.ts`, `attempt-lifecycle.spec.ts`, `m1-migration.spec.ts` | ✅ локальная Supabase 2026-11-04; CI `Quality` — на PR задачи #40 (ещё не запущен) |
| Полный экзамен (#45): Lesen ни в HTML/RSC/статусе/командах до этапа, отказ записи закрытого Hören и раннего Lesen, окончательность момента Lesen, gate записи для `audio`/`prepare-audio`/Server Action, лишние поля времени и позиции | `apps/web/tests/material-visibility.spec.ts`, `full-exam-timing.spec.ts`, `exam-submission.spec.ts` | ✅ локальная Supabase 2026-11-06; CI `Quality` — на PR задачи #45 |
| Права новых объектов P1-T2 (`exam_version_audio`, `open_attempt`, `finish_attempt`) в облачном проекте | — | ⏳ скриптом с publishable-ключом не проверялись: миграция применена владельцем, но облачная проверка отказов после неё не выполнялась |
| Задача очистки в облачном проекте (Integrations → Cron) | ручная проверка владельца после `supabase db push` | ⏳ не выполнена |
| Приёмочная матрица: разрешённые операции, запрещённые серверные, Data API и Storage пути | `apps/web/tests/release-journey.spec.ts` «release guest allowed operations pass access matrix», «release rejects guest privilege and private resource attacks» | ✅ локальная Supabase 2026-11-01. CI `Quality` — на PR #34 |
| Общий кэш не отдаёт чужие ответы | `apps/web/tests/access-matrix.spec.ts` «guest cache never returns another attempt answers» | ✅ локальная Supabase 2026-11-01. CI `Quality` — на PR #34 |
| Production: заголовки и клиентский код | `curl https://b1-kompass.vercel.app/` 2026-10-31 23:23 UTC, только чтение | ✅ `200`, `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, HSTS, `nosniff`, `DENY`, `same-origin`. `/practice` без cookie → `307` на `/`, `http://` → `308` на HTTPS. В 12 JS-файлах главной (≈ 0,9 МБ) нет `sb_secret_`, `service_role`, `SUPABASE_SECRET_KEY`, адреса Supabase, `answer_keys`, `correct_option_id` |
| Работа сайта на Vercel по HTTPS: вход, ответы, разбор | ручная проверка владельца | ⏳ не выполнена: гостевой маршрут на production не проходился (решение владельца: только чтение) |
| Те же отказы Data API и Storage в облачном проекте после миграций #3–#12 | скрипт с publishable-ключом | ⏳ не выполнена |
| Release gate: недоверенный запуск, устаревший SHA, CI, Environments, DB URL, история миграций, staged deployment, promotion | `scripts/release/gate.test.mjs` | ✅ локально `node --test` (#56); CI `Quality` — на PR #56 |
| Изоляция секретов по Environments и approval до SQL на реальном запуске | `Release Production` | ⏳ не выполнялась: Environments и secrets владельцем ещё не настроены |
| Словарь (#60): отказы Data API на кэш/бюджет для `anon` и `authenticated`, отказы API (Guest, Origin, тип, лишние поля, размер), атомарный бюджет при параллельных вызовах, срок Guest в функции | `apps/web/tests/dictionary.spec.ts` «denies direct database dictionary access», «rejects unauthorized dictionary requests without mutation», «concurrent lookups respect shared provider budget» | ✅ локальная Supabase 2026-11-05; CI `Quality` — на PR задачи #60 |
| Словарь (#60): недоверенные ответы провайдеров, проверка слова, безопасный вывод | `apps/web/src/server/dictionary/dictionary.test.ts`, `apps/web/src/features/dictionary/DictionaryCard.test.tsx` | ✅ Vitest локально |
| Права объектов словаря в облачном проекте, задача `purge-dictionary-data` | ручная проверка после выпуска | ⏳ миграция в Production не применялась |
