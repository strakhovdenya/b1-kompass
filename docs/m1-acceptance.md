# Приёмка M1

Состояние на 2026-11-01. Итоговый отчёт задачи P5-T2 (Issue #14) по 19 критериям PRD [Guest Online Exam Trainer](prd/PRD-guest-online-exam-trainer.md). Ниже он дополнен отчётом P5-T1 (Issue #13) о четырёх независимых сеансах.

## Решение: M1 не принят

**M1 ещё не принят.** Автоматические проверки проходят, но обязательная ручная приёмка не выполнена:

- опубликованный сайт не проверен на реальных телефоне и компьютере;
- в облачной базе нет полного пилота (20 + 25), опубликован только короткий набор Hören Teil 1;
- сверка пилота с оригиналом издателя не сделана;
- работа при выключенном компьютере владельца не проверена фактически.

Пока владелец не впишет результаты в раздел «Ручная приёмка на устройствах» с датой, критерии, требующие опубликованного маршрута или устройств, остаются ⏳.

Отметки: **PASS** — подтверждено фактически; **FAIL** — проверка нашла дефект; **⏳ непроверено** — проверка не выполнялась. Автоматические и ручные проверки в таблице разделены. Итог PASS ставится только тогда, когда выполнены обе требуемые части.

## Окружение проверок

| Что | Значение |
| --- | --- |
| Опубликованный URL | https://b1-kompass.vercel.app |
| Deployed SHA (production) | `e78806cc3c08826926b20e67593015eaddcf3033`: head `main`, merge PR #33. Статус `Vercel: success` 2026-10-31 23:03 UTC (`gh api repos/strakhovdenya/b1-kompass/commits/e78806c/statuses`) |
| Проверка production | 2026-10-31 23:23 UTC, только чтение (`curl`, решение владельца: без создания гостевого сеанса). Главная `200` с «Continue as guest», `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, HSTS, `nosniff`, `X-Frame-Options: DENY`, ответ из `fra1`. `/practice` без cookie → `307` на `/`, `http://` → `308` на HTTPS. В 12 JS-файлах главной (≈ 0,9 МБ) нет `sb_secret_`, `service_role`, `SUPABASE_SECRET_KEY`, адреса Supabase, `answer_keys`, `correct_option_id` |
| Материал в облаке | Полный пилот (20 Hören + 25 Lesen, Track 127), версия `729d4787-8bc8-4190-8e15-68f898614372`: опубликован владельцем 2026-11-01 через `npm run publish:pilot` (ответ скрипта `Full pilot published`). До этого в облаке был только короткий набор Hören Teil 1, версия `2de7ca2f-fc8b-4c62-bbfe-bc10e4f5c5fc`. Агент облачную базу не читал: версия известна из вывода скрипта владельца |
| Автотесты | Ветка `task/ISSUE-14-release-acceptance`, Windows 11, Node 24, локальная Supabase в Docker, 2026-11-01. `npm run typecheck`, `npm run lint` ✅; `npm test` ✅ 13 файлов, 66 тестов; `npm run build` ✅; `npm run test:e2e` ✅ 130 из 130 (проекты `chromium`, `pair`, `full`, `limits`), 3,6 мин |
| Повторяемость | `npx playwright test release-journey.spec.ts access-matrix.spec.ts --project=full --repeat-each=4 --workers=2`: 28 из 28. Три длинных маршрута помечены `test.slow()`: в одном прогоне под нагрузкой они превысили 30 с по умолчанию (тайм-аут, не ошибка проверки) |
| CI этой задачи | `Quality` на head PR задачи #14 — ссылка в PR и в Issue #14. Последний CI `main` до задачи: ✅ [run 41250755131](https://github.com/strakhovdenya/b1-kompass/actions/runs/41250755131) на `e78806c` |

Автотесты полного маршрута работают на синтетическом комплекте `test-full-dtz` (20 + 25, выдуманный текст и тестовый ключ, WAV-тон 60 с). Они доказывают поведение кода. Что на сайте настоящий пилот, они не доказывают.

## Покрытие 19 критериев PRD

| AC | Автоматически: доказательства | Авто | Реально: опубликованный сайт, устройства | Итог |
| --- | --- | --- | --- | --- |
| AC-01 HTTPS-сайт, реальный экзамен на телефоне и компьютере | `release-journey.spec.ts` «release journey is accessible and responsive»: маршрут вход → Hören → Lesen → результат при 390×844 и 1440×900 | PASS | HTTPS и главная ✅ (`curl`). Владелец 2026-11-01 сообщил, что после публикации полного пилота маршрут открывается и работает (без деталей и без отметок по устройствам). Телефон и компьютер ⏳ | ⏳ непроверено |
| AC-02 вход без пароля, English по умолчанию | `guest-entry.spec.ts` «fresh guest starts in English and owns locale», «ignores browser and previous account locale». `release-journey.spec.ts` «release guest allowed operations pass access matrix» (сеанс `en`, срок 720 ч). `guest-renewal.spec.ts` «expiry creates fresh guest without sliding deadline» | PASS | ⏳ | ⏳ непроверено |
| AC-03 EN/RU без потери ответов и позиции | `full-training.spec.ts` «locale switches entire route without losing state». `hoeren-single.spec.ts` «both locale directions preserve actual media state». `multi-guest.spec.ts` «one guest actions never reset three others» | PASS | ⏳ | ⏳ непроверено |
| AC-04 опубликован проверенный комплект 20 + 25 | `material-publication.spec.ts` «publishes validated full pilot with source references», «rejected pilot leaves no partial state». `multi-guest.spec.ts` «published test set retains all assessed questions and resource links», «pilot integrity fails on missing key or resource». Domain: «missing key refuses full exam scoring» | PASS (синтетический комплект) | Полный пилот в облаке опубликован 2026-11-01. Ключ сверен скриптом `private/build-draft.mjs` с текстом Lösungen: 45 из 45 совпали (проверка по тексту, не по изображению). Сверка заданий с PDF и записи Track 127 с оригиналом ⏳ | ⏳ непроверено |
| AC-05 Hören Teil 1–4: одиночные, пара, общий набор | `hoeren-single.spec.ts`, `hoeren-pair.spec.ts` «paired questions render and save independently», `hoeren-complete.spec.ts` «shared pool remains visible for questions 18 to 20». Узкий экран: `release-journey.spec.ts` «narrow enlarged text keeps actions visible without focus trap» (Teil 1, пара и Teil 4 при 390 px и тексте 200 %) | PASS | ⏳ | ⏳ непроверено |
| AC-06 Lesen рядом с текстом, переключение на узком | `lesen-layout.spec.ts` «responsive reading preserves selection», «long reading preserves anchor across viewport changes». `release-journey.spec.ts` (Text/Task при 390 px) | PASS | ⏳ | ⏳ непроверено |
| AC-07 цельная запись, без компьютера владельца | `full-training.spec.ts` «switching blocks keeps attempt answers and playback». `hoeren-complete.spec.ts` «switching teil keeps one running recording». `release-journey.spec.ts` «release guest allowed operations pass access matrix» (байты по подписанному URL, совпадение `sha256`) | PASS | Разборчивость оригинала и воспроизведение на production ⏳. Работа при выключенном компьютере ⏳: по архитектуре компьютер не нужен (Vercel + Supabase Storage), фактически не проверялось | ⏳ непроверено |
| AC-08 один ответ, ключ скрыт до проверки | `hoeren-single.spec.ts` «single questions replace only their own answer». `full-training.spec.ts` «active or foreign review remains private». `release-journey.spec.ts` «release rejects guest privilege and private resource attacks» (HTML и RSC без ключа) | PASS | ⏳ | ⏳ непроверено |
| AC-09 серверная проверка 20/25/45 | `scoring-security.spec.ts` «server scores persisted versioned answers». `full-training.spec.ts` «full training presents localized stored review». Domain: «full dtz scores hoeren lesen and total separately» | PASS | ⏳ | ⏳ непроверено |
| AC-10 шкала DTZ 0–19 / 20–32 / 33–45, 15 + 18 = 33 = B1 | Domain: «dtz boundary scores use integer totals», «fifteen plus eighteen returns thirty three and B1», «nonfull and nonDTZ scopes have no official DTZ grade». `scoring-security.spec.ts` «short set attempt is finished without grade» | PASS | ⏳ | ⏳ непроверено |
| AC-11 облачное сохранение, refresh, честные статусы | `attempt-restore.spec.ts` «restore recovers server confirmed position and answers». `attempt-races.spec.ts` «retry failure retains latest choice without false saved». `release-journey.spec.ts` «release failures never fake saved state» | PASS | ⏳ | ⏳ непроверено |
| AC-12 30 дней без продления, новый `visitor_id` | `guest-entry.spec.ts` «guest expiry remains fixed before deadline», «rejects guest at expiry boundary». `guest-renewal.spec.ts` «expiry creates fresh guest without sliding deadline», «old guest rejected at exact expiry» | PASS | ⏳ вход на production. Сам срок проверяется только автотестом с часами сервера | ⏳ непроверено |
| AC-13 «Пройти заново», одно завершение | `guest-renewal.spec.ts` «restart button opens new empty attempt retaining history», «restart cannot reset another active guest». `scoring-security.spec.ts` «client score and duplicate finish cannot forge result». `release-journey.spec.ts` «keyboard reaches and activates every release action» (новый запуск с клавиатуры) | PASS | ⏳ | ⏳ непроверено |
| AC-14 четыре независимых сеанса | `multi-guest.spec.ts`: пять тестов (раздел P5-T1 ниже) | PASS | Четыре сеанса на реальных устройствах и production ⏳ | ⏳ непроверено |
| AC-15 запреты Guest на сервере и в Data API/Storage | `release-journey.spec.ts` «release rejects guest privilege and private resource attacks»: 6 операций без сеанса и с истёкшим, 6 с чужой попыткой, 10 подмен полей, 9 таблиц, 9 записей, 9 функций (`42501`), 8 операций Storage, регистрация. «release guest allowed operations pass access matrix». Матрица — `docs/security.md` | PASS | Облако: отказы для объектов P1-T1 ✅ 2026-10-31 (`docs/deployment.md`). Объекты миграций #3–#12 скриптом не проверялись ⏳ | ⏳ непроверено |
| AC-16 нет секретов и ключа в браузере, XSS, общий кэш | `access-matrix.spec.ts` «guest cache never returns another attempt answers». `full-training.spec.ts` «review escapes untrusted text and isolates cache». `QuestionCard.test.tsx` (экранирование). `release-journey.spec.ts` (HTML и RSC без ключа) | PASS | Production: заголовки `private, no-store`, бандл главной без секретов и ключа ✅. Страницы гостя на production ⏳ | ⏳ непроверено |
| AC-17 телефон и компьютер, клавиатура, увеличенный текст, отказы | `release-journey.spec.ts`: «release journey is accessible and responsive», «keyboard reaches and activates every release action», «narrow enlarged text keeps actions visible without focus trap», «release failures never fake saved state». Текст 200 % задаётся размером шрифта браузера 32 px (CDP `Page.setFontSizes`). Проверяются: нет горизонтальной прокрутки, действия внутри окна и не перекрыты, кольцо фокуса видно, Tab и Shift+Tab без ловушки, статусы передаются текстом и `aria-*` | PASS (после исправления, см. «Дефекты приёмки») | Реальные телефон и компьютер, масштаб текста в ОС ⏳ | ⏳ непроверено |
| AC-18 сборка, проверки, реальный цикл фабрики | `npm run typecheck`, `lint`, `test`, `build`, `test:e2e` (см. «Окружение проверок»). Цикл фабрики: #2 → PR #19, `Quality` ✅ ([factory-validation.md](factory-validation.md)) | PASS | Устройства не нужны. `Quality` этой задачи — в её PR | PASS |
| AC-19 без регистрации, SMTP, импорта, словарей и модельного API | `enable_signup = false` (`supabase/config.toml`), регистрация с publishable-ключом отклоняется (AC-15). В `apps/web/src`, `packages/domain/src`, `scripts` и `package.json` нет клиентов OpenAI/Anthropic, словарей и почты. На экранах маршрута Tab доходит только до рабочих действий (тест «narrow enlarged text…»), будущих функций нет в `messages/*.json` | PASS | Production: главная показывает только «Continue as guest» ✅ (`curl`). Регистрация в облаке выключена ✅ 2026-10-31 | PASS |

Итог: 2 из 19 PASS (AC-18, AC-19), 17 ⏳ непроверено, FAIL нет. Автоматическая часть — PASS у всех 19.

## Дефекты приёмки

| Дефект | Исправление | Регрессия |
| --- | --- | --- |
| Фокус клавиатуры почти не был виден. MUI показывает только бледный ripple, `outline` у кнопок, радио и ползунка — `none` (WCAG 2.4.7) | `apps/web/src/theme/ThemeRegistry.tsx`: сплошное кольцо 3 px цвета `primary` с отступом 2 px для `:focus-visible` и `.Mui-focusVisible` (кнопки, переключатели, радио, ползунок) | Каждый переход Tab в `release-journey.spec.ts` проверяет `:focus-visible`, `outline-style ≠ none`, ширину кольца ≥ 2 px и видимость элемента. До исправления тесты падали: `focus on button:Continue as guest`, ожидалось `outline-style` не `none` |

Для тестов добавлены атрибуты `data-testid="audio-back"` (кнопка «назад 5 с») и `data-testid="review-outcome"` (строка исхода в разборе).

⚠️ Наблюдение без исправления: при 390 px и тексте 200 % подписи кнопок плеера («▶ Play», «Back 5 s») и ссылок блоков переносятся внутри кнопки на 2–3 строки (высота около 110 px). Горизонтальной прокрутки и перекрытия нет, все действия видны и нажимаются. Это не дефект доступности, вид можно улучшить отдельной задачей.

## Находки при ручной проверке сайта (2026-11-01)

| Что обнаружено | Причина | Статус |
| --- | --- | --- |
| На preview и production `/practice` показывал «Something went wrong. Your saved answers are kept» | В облачной базе не были применены миграции `20261104000000` (#10), `20261105000000` (#11) и `20261106000000` (#12): `supabase migration list --linked` показывал их только в Local. Приложение с #10 читает `attempts.progress` и вызывает функции из этих миграций | ✅ устранено владельцем: после `supabase db push` все 7 миграций в Local и Remote (проверено агентом 2026-11-01) |
| Нет перехода в Lesen, «Question 4 of 4» | В облаке был только короткий набор Hören Teil 1. Версия без заданий Lesen скрывает переключатель блоков | ✅ устранено владельцем: опубликован полный пилот, версия `729d4787…`. Старая активная попытка остаётся на прежней версии до «Finish attempt» и «Start again» (так задумано) |
| Вводный текст Hören на коротком наборе говорит про части 1–4, пару Teil 3 и список a–f | Текст `hoeren.intro` одинаков для любого набора | не исправлено в этой задаче, заведён [#35](https://github.com/strakhovdenya/b1-kompass/issues/35) |

Вывод для приёмки: проверка production только чтением (`curl`) не заметила, что страница практики падает. Страницы гостя на production проверяются только вручную по списку ниже. Перед выпуском сверяйте миграции облака командой `npx supabase migration list --linked` (`docs/deployment.md`).

## Ручная приёмка на устройствах (владелец)

Заполняет владелец на опубликованном URL. Непроверенное не отмечается PASS.

| # | Проверка | Покрывает AC | Устройство и дата | Результат |
| --- | --- | --- | --- | --- |
| 1 | Полный пилот в облаке: публикация ✅ 2026-11-01, версия `729d4787…`. Остаётся сверить 45 заданий, ключ и Track 127 с оригиналом | 01, 04 | | ⏳ публикация ✅, сверка ⏳ |
| 2 | Телефон, браузер по умолчанию: вход, English, Hören Teil 1–4, Lesen с переключением Text/Task, Finish, разбор, «Start again» | 01, 02, 05, 06, 08–10, 13 | | ⏳ |
| 3 | Компьютер: тот же маршрут, Lesen рядом с текстом | 01, 05, 06 | | ⏳ |
| 4 | EN/RU во время воспроизведения: ответы и позиция записи сохраняются | 03, 07 | | ⏳ |
| 5 | Refresh посреди Hören и посреди Lesen: ответы, задание и позиция восстановлены | 11, 12 | | ⏳ |
| 6 | Только клавиатура на компьютере; текст 200 % в настройках браузера на телефоне и компьютере | 17 | | ⏳ |
| 7 | Режим полёта во время ответа: ошибка видна, выбор остаётся, без ложного Saved, повтор сохраняет | 11, 17 | | ⏳ |
| 8 | Запись: play/pause, перемотка; переход между заданиями и блоками не перезапускает; оригинал разборчив | 07 | | ⏳ |
| 9 | Четыре браузера или устройства одновременно слушают с разных позиций и отвечают | 14 | | ⏳ |
| 10 | Компьютер владельца выключен: сайт и запись работают с телефона | 01, 07 | | ⏳ |
| 11 | Скрипт с publishable-ключом против облака: таблицы, функции и бакет миграций #3–#12 отклоняются; страницы гостя отдаются с `private, no-store` | 15, 16 | | ⏳ |

M1 принят, только когда пункты 1–11 отмечены PASS с датой и устройством, а `Quality` PR задачи #14 успешен.

---

# P5-T1: проверка собранного экзамена в четырёх независимых сеансах

Отчёт задачи P5-T1 (Issue #13), сохранён без изменений по существу.

Состояние на 2026-10-31. Отметки: ✅ проверено фактически, ⏳ не проверено, ⚠️ замечание.

## Что проверено автоматически и на каком материале

Все автоматические проверки этой задачи работают на **синтетическом тестовом комплекте CI**, а не на настоящем пилоте:

- экзамен `test-full-dtz`, материал `buildSyntheticPilot()` (`packages/domain/src/material/synthetic-pilot.ts`): 20 Hören и 25 Lesen с выдуманным текстом и тестовым ключом;
- запись — детерминированная WAV-запись с тоном (`createTestRecording()` в `apps/web/tests/support/global-setup.ts`), трек `track-127`, 60 секунд, 960 044 байт;
- комплект публикуется в `globalSetup` той же доверенной функцией `publishExamVersion`, что и настоящий пилот.

Они доказывают структуру комплекта и поведение собранного маршрута: Hören → Lesen → разбор → «Пройти заново». Соответствие настоящих 45 заданий, ключа и Track 127 оригиналу они **не** доказывают (см. «Ручная приёмка владельца»).

## Четыре cookie-контекста

`apps/web/tests/multi-guest.spec.ts` (Playwright-проект `full`, сервер `next start` на порту 3102 с `PRACTICE_EXAM_SLUG=test-full-dtz`) открывает четыре `browser.newContext()`. Каждый проходит главную страницу → «Continue as guest» и получает свой cookie `b1k_guest`. Тест проверяет, что у четырёх гостей разные токены, разные строки `guest_sessions` и разные `attempts`, а все попытки закреплены за одной версией.

| Тест | Что подтверждено перечитыванием БД / браузера |
| --- | --- |
| `four isolated guests share audio object and retain independent state` | `currentSrc` всех четырёх плееров ведёт на один `object_path` из `exam_version_audio`, `sha256` равен хешу байтов записи. В бакете `exam-sources` ровно один объект этого имени до и после. Гости одновременно играют с 2, 7, 12 и 17 секунды. Каждый отвечает в Hören и Lesen и завершает попытку; ответы в БД совпадают с ответами этого гостя, у каждого одна строка `attempt_results`, баллы 1, 2, 3 и 0 совпадают с политикой DTZ по его ответам |
| `one guest actions never reset three others` | Первый гость по очереди: язык RU, перемотка на 45 с, обновление страницы, завершение и «Пройти заново». После каждого действия у трёх других без изменений язык, маршрут, видимые карточки, отмеченные варианты, статусы сохранения, ответы и попытки в БД и сам `<audio>` (маркер элемента). У двух играющих `paused=false`, `currentTime` = прежняя позиция + прошедшее `performance.now()` (допуск 0,75 с). У плеера на паузе `paused=true` и прежняя позиция (допуск 0,05 с) |
| `published test set retains all assessed questions and resource links` | В БД ровно 20 Hören и 25 Lesen с номерами 1–20 и 1–25, 45 строк `answer_keys`: по одной на задание, каждая — один из вариантов, у примеров ключа нет. Каждый Hören ссылается на трек версии; объект трека скачан из Storage, его `sha256` совпадает с записанным |
| `pilot integrity fails on missing key or resource` | Четыре ветви по отдельности: (1) `publishFullPilot` без ключа `hoeren-7` → `missing-key`; (2) `publishExamVersion`, где единственный файл относится к другому треку, → `broken-reference`; (3) функция БД `publish_exam_version` без ключа `lesen-25` → `material_invalid`; (4) функция БД с треком, чей объект не загружен → `material_invalid`. Для каждого slug после отказа нет строк `exams`, `exam_versions`, `answer_keys` и `exam_version_audio`; в ветвях 1, 2 и 4 нет и объекта предложенной записи в Storage (ветвь 3 записи не получает) |
| `one delayed listener does not block others` | Сохранение первого гостя задержано перехватом сети до сервера. Пока оно висит (статус `saving`, в БД ответа нет), трое других отвечают, видят Saved и завершают; их ответы и результаты уже в БД, у задержанного попытка активна без ответов и результата. После снятия задержки его ответ подтверждён только в его попытке |

Общий `currentTime`, эксклюзивная блокировка файла и копия записи на гостя не вводились: каждый браузер читает тот же приватный объект по своему подписанному URL.

### Дефекты

Проверка не выявила дефектов в коде приложения: исправлений и новых миграций в этой задаче нет. В интерфейс добавлены только атрибуты для тестов: `data-testid="audio-toggle"` с `data-playing` у кнопки плеера и `data-testid="locale-<код>"` у переключателя языка, чтобы локаторы не зависели от языка страницы.

⚠️ Наблюдение без исправления: функция БД `publish_exam_version` проверяет ключи и наличие объектов перечисленных треков, но не проверяет, что каждый `trackId` задания есть среди переданных треков. Эту ссылку проверяет `findMaterialProblems` в доверенной функции `publishExamVersion` (ветвь 2 выше). Функцию БД может вызвать только `service_role`.

## Команды и результаты

Локальный прогон 2026-10-31 на ветке `task/ISSUE-13-multi-guest` (Windows, Node 24, локальная Supabase в Docker):

| Команда | Результат |
| --- | --- |
| `npm run typecheck` | ✅ без ошибок |
| `npm run lint` | ✅ без ошибок |
| `npm test` | ✅ 13 файлов, 66 тестов |
| `npm run build` | ✅ |
| `npx playwright test multi-guest.spec.ts --project=full --repeat-each=3 --workers=2` | ✅ 15 из 15 (после правок ревью — `--repeat-each=2`, 10 из 10) |
| `npm run test:e2e` | ✅ 123 из 123 (проекты `chromium`, `pair`, `full`, `limits`), 2,4 мин |

CI: workflow `CI`, job `Quality` на head PR этой задачи — ссылка в PR и в Issue #13.

## Источник и версия пилота

- Материал: telc «Auf jeden Fall! B1.2 — Übungstest DTZ», ключ — Lösungen KB/AB, стр. 6, запись — Track 127 (ссылки в `docs/pilot-material.md`).
- В облаке опубликован только короткий набор Hören Teil 1: версия `2de7ca2f-fc8b-4c62-bbfe-bc10e4f5c5fc` (`docs/deployment.md`). ⏳ Полный пилот в облаке не опубликован.
- Локальная структурная проверка подготовленных файлов `private/pilot-content.json` и `private/pilot-keys.json`: 20 Hören, 25 Lesen, 45 ключей, каждый ключ — один из вариантов своего задания, лишних ключей нет, 7 текстов, 4 примера, весь Hören на `track-127`. Это проверка формы, не сверка с оригиналом.

## Deployed SHA

Источник — статусы `Vercel` коммитов в GitHub (`gh api repos/strakhovdenya/b1-kompass/commits/<sha>/statuses`) и ответ сайта, проверено 2026-10-31 в 22:45 UTC:

| Окружение | Deployed SHA | Факт |
| --- | --- | --- |
| Production `https://b1-kompass.vercel.app` | `bc390230956164a06c2efe14f83dd8290f5f7672` — последний коммит `main` (merge PR #32) | ✅ статус `Vercel: success` в 22:04 UTC. Главная отвечает `200`, в ней есть «Continue as guest», заголовок `Cache-Control: private, no-cache, no-store`, ответ из `fra1` |
| Preview этого PR | head PR #33 | ✅ статус `Vercel: success` на head PR |

⏳ Не проверено: в облаке не выполнялись вход гостя, прослушивание, сохранение и разбор, а также четыре сеанса. Полный пилот в облачной Supabase не опубликован. Что production alias указывает именно на `bc39023`, следует из статуса последнего коммита `main`; в Dashboard Vercel это не сверялось, доступа нет. Проверку на опубликованном URL выполняет P5-T2.

## Измеренный объём аудио и данных

| Что | Размер |
| --- | --- |
| Track 127, `private/hoeren-track-127.mp3` | 10 628 474 байт (≈ 10,1 МиБ), 24 мин 54 с, ≈ 57 кбит/с, sha256 `1dcabf88facc949be4dd73679a8a5904884af936c733c4594a90ad9a76a3a9eb` |
| Тестовая запись CI | 960 044 байт, 60 с |
| Публичная проекция настоящего пилота (`pilot-content.json`, JSON) | 28 991 байт |
| `content` синтетической версии в БД (`pg_column_size`, сжатый jsonb) | 2 476 байт |
| Вся локальная тестовая база после прогона | 13 MB |

Одно полное прослушивание Track 127 — около 10,6 МБ исходящего трафика Storage. Перемотка Range-запросами может читать часть файла повторно. Четыре одновременных гостя хранят один объект; трафик растёт с числом прослушиваний, а не с числом объектов.

## Free-квоты (на 2026-10-31)

Значения взяты с публичных страниц тарифов 2026-10-31. ⏳ С Dashboard проекта владельца не сверены.

| Сервис | Квота Free | Оценка M1 |
| --- | --- | --- |
| Supabase: база | 500 MB на проект | материал и попытки — десятки килобайт на версию |
| Supabase: файловое хранилище | 1 GB | одна запись ≈ 10,6 МБ |
| Supabase: egress | 5 GB (+ 5 GB cached egress) в месяц | ≈ 470 полных прослушиваний Track 127 в месяц |
| Supabase: простой | проект Free ставится на паузу после недели без активности | нужно учитывать для демонстраций |
| Vercel Hobby: Fast Data Transfer | 100 GB в месяц | байты аудио идут из Supabase, не через Vercel |

Источники: https://supabase.com/pricing, https://vercel.com/pricing, https://vercel.com/docs/limits. Платные функции не подключались.

## Ручная приёмка владельца (не автоматизирована)

| Что | Статус |
| --- | --- |
| Сверка настоящих 45 заданий, текстов и необходимых изображений с PDF издателя | ⏳ не проверено |
| Сверка ключа `private/pilot-keys.json` с Lösungen, стр. 6 | ⏳ не проверено |
| Track 127: тот же файл, что в архиве издателя, и соответствие Teil 1–4 | ⏳ не проверено |
| Публикация полного пилота в облаке, прослушивание и разбор по HTTPS | ⏳ не проверено |
| Четыре сеанса на реальных устройствах и опубликованном URL | ⏳ не проверено (P5-T2) |

Пока владелец не выполнит сверку и не впишет сюда результат с датой, соответствие настоящего пилота оригиналу считается непроверенным.
