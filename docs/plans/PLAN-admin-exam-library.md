# Plan: Exam Library and Trusted Publication — M3

**PRD:** `docs/prd/PRD-admin-exam-library.md`  
**Date:** 2026-11-07  
**Status:** Draft — подробная декомпозиция для согласования; не является GitHub Issues или разрешением на реализацию  
**Project:** B1 Kompass · EPIC M3 / направление №3 `Admin Exam Library`  
**Baseline:** `main` `64c480dbaba724cee8ce39cb27033cb8b75f6065` (проверен 2026-11-07); учтены замечания Claude F-01–F-17. PRD и PLAN остаются Draft до отдельного утверждения владельцем. Перед Issues проверить новый HEAD.  
**Factory:** `dark-factory` v0.1.3, `plan` skill и его базовый шаблон; `.factory/profile.json`: `docs.plans=docs/plans`, `apps=web, domain`, `branchTemplate=task/ISSUE-{issue}-{slug}`. Дополнительный overlay PLAN в профиле не задан.  
**Owner decision, 2026-11-07:** второй комплект **ещё не найден**, но должен быть самостоятельным **полным аналогом пилота** по экзаменационной структуре: 20 Hören + 25 Lesen, оригинальная запись, авторитетный ключ и совместимое представление в существующем тренажёре. Поиск и проверка пригодного комплекта — внешний product/content gate, а не вымышленная готовность.  
**Scope:** каталог опубликованных **экзаменов**, безопасная навигация и идентичность выбранного комплекта, универсальный доверенный owner CLI с dry-run и публикацией, **второй реальный полный DTZ**, регрессия безопасности/версий/аудио, документация и доказательная приёмка. **Не включены:** web-admin/Auth, автоматический PDF/OCR/AI import, новые проигрыватели/точная нарезка аудио, личные аккаунты, аналитическая админка.

## Implementation Phases

### Принципы декомпозиции и исполнительские правила

1. **Один PR = законченная проверяемая возможность.** Ни один Issue не заканчивается только интерфейсом без потребителя, абстрактным контрактом без применения или изменённым кодом без тестов. Первая фаза — минимальный работающий вертикальный путь (*Tracer Bullet*). После каждой фазы система пригодна для использования без следующих фаз, хотя полное определение M3 пока не удовлетворено.
2. **Не больше пяти задач на фазу;** ниже 7 фаз и 16 предполагаемых задач. `web` (`apps/web`) и `domain` (`packages/domain`) разделены по явным владельцам изменения. `scripts/` — отдельные owner-инструменты, не браузерное приложение; там, где CLI применяет чистую domain-политику, производственная проверка домена и её первый потребитель поставляются в одной проверяемой фазе. При оформлении Issues изменения `packages/domain` и `scripts` разделять только тогда, когда **каждый PR самостоятельно завершён и проверяем**.
3. **Цель не перепроектировать M2:** #47, #48, #49 **закрыты**, соответствующий код уже в `main`. `docs/m2-acceptance.md` отделяет автоматически проверенное M2 от ещё не завершённой ручной приёмки; M3 не приписывает ей статус PASS. Для ARC-01–ARC-06 фиксировать конкретный эффект и отсутствие несогласованных расширений.
4. **Сквозные проверки не отложены на конец.** Каждый изменяющий код Issue включает unit/integration/browser тесты изменённой границы. Только сценарии, реально требующие одновременно библиотеку, второго издателя и универсальный publisher, остаются отдельной интеграционной фазой.
5. **Внешние материалы не создают скрытой блокировки разработке.** Фазы 1–4 допустимы на пилоте и изолированных синтетических full-DTZ fixtures. Пятый этап требует реально найденного источника и права на использование; синтетические fixtures **никогда не засчитываются** как второй продакшен-экзамен. Фазы 6–7 могут подготовить часть проверок до появления комплекта, но их окончательное закрытие зависит от него.
6. **Никаких неявных побочных эффектов:** GET/SSR/prefetch каталога и выбора режима не создают Guest/attempt/run/start; start остаётся идемпотентной явной командой. Для Guest сохраняются 720 часов без продления, EN/RU по сеансу и ownership. Опубликованные данные/ключи/дорожки неизменяемы; прошлые попытки закреплены за исходной версией.
7. **Профиль времени отдельно от публикации.** Присутствие 45 заданий и оригинального аудио **не** подтверждает регламент. До ручной проверки fingerprint и версии timed/full остаются закрытыми серверным gate; свободная тренировка — доступной. Подтверждение не наследуется от другого экзамена или новой версии.
8. **Affects ниже — плановая область, не готовые разрешения:** точные пути, `Docs to Read`, `Key Invariants`, `Verify:`-тесты и необходимые миграции согласуются при создании конкретного Issue по текущему HEAD и v2-контракту Dark Factory. Не расширять миграции/API/Auth «на всякий случай». Новые SQL-изменения только при доказанной необходимости и с проверками GRANT/RLS; применённые миграции не редактировать.

### Phase 1: Tracer Bullet — библиотека опубликованных экзаменов и Guest-вход

**Goal:** После явного `Continue as guest` пользователь попадает в настоящую библиотеку и открывает выбор режима **конкретного опубликованного полного экзамена**. Уже на одном пилоте работают серверное чтение, фильтрация неполных версий, изоляция состояния Guest, переход на правильный `examSlug` и отсутствие запуска на чтении. Новая публикация позднее автоматически появится по тому же контракту, без hard-code списка.

**Affects:** `apps/web` — Guest entry, серверное чтение опубликованных материалов/состояний попыток, страницы/компоненты каталога, EN/RU, миграция E2E-обвязки `apps/web/tests/support/guest-browser.ts`, `apps/web/playwright.config.ts` и затронутых specs, компонентные и DB tests; действующие таблицы Supabase читаются только из доверенного сервера, без новых публичных GRANT. Возможные ориентиры на текущем HEAD: `src/server/material/published.ts`, `src/server/attempts/read.ts`, `src/server/next/actions.ts`, `src/server/next/request.ts`, `src/app/page.tsx`, `src/app/practice/[examSlug]/page.tsx`; новые пути/компоненты — только по подтверждённому Issue.

**Tasks:**

- [ ] **P1-T1. Вертикальный путь `Guest → /exams → выбор режима`.** Добавить единый доступный после Guest маршрут библиотеки (согласованный в PRD `/exams`), серверный read-only список актуальных **полных** опубликованных DTZ, детерминированный порядок и карточку с фактическими названием/форматом/20+25/45. Переиспользовать опубликованные `exams` и их latest `exam_versions`, отфильтровать короткие fixture-экзамены и *не подменять* некорректную latest версию старой. CTA карточки — «Выбрать режим», не `Start`; после Guest CTA не открывать пилот принудительно. **В этом же PR:** unit/read тесты 0/1/N/неполные latest/дубли slug и browser E2E входа, локалей, read-only GET/prefetch; SQL re-read количества session/attempt/run/start; проверка отсутствия ключа и signed audio URL в HTML/RSC. **Зависимости:** существующие read/start границы M2. **Рекомендуемая модель:** Sonnet High; security review границы SSR — Opus по необходимости. **Уточнение по ревью:** Изменение Guest CTA на `/exams` требует в ЭТОМ ЖЕ PR обновить `enterAtChoice`/`enterAndStart` и все E2E с `CHOICE_URL='**/practice/*'`: Guest → `/exams` → явная карточка полного fixture → `/practice/<slug>`. Короткие pair/short fixtures не видны в библиотеке: после создания Guest обращаться напрямую к `/practice/<slug>`; `readDefaultExamSlug` и `PRACTICE_EXAM_SLUG` сохраняются лишь для legacy. Тесты в общей DB проверяют свои уникальные slug/относительный порядок, а не общее количество карточек; empty, error, retry, 0/1/N — component/projection tests без фиктивного состояния общей DB. `exams.slug UNIQUE`, сценарий «дубликаты slug» невозможен. Не ослаблять старые assertions.
- [ ] **P1-T2. Карточки с состоянием текущего Guest без N+1.** Для каждого разрешённого экзамена показывать **только свой** active `Continue` и, где существует, собственный последний completed review; при отсутствии active оставить выбор режима. Обеспечить один ответ каталога с ограниченным и предсказуемым числом чтений/объёмом полей, различимые состояния пусто/ошибка/загрузка/повторить, корректную обработку отсутствующего/истёкшего Guest, без выдачи полных attempt payloads. **В этом же PR:** многопользовательские негативные тесты ownership и cache, число SQL-вызовов/отсутствие неконтролируемого N+1 при десятках экзаменов, EN/RU, повреждённая запись, отказ БД. **Рекомендуемая модель:** Sonnet High. **Уточнение по ревью:** Последний результат — собственная последняя по `attempt_results.computed_at` завершённая попытка **полного scope**, `purpose != repeat` у M2; учитывать legacy M1 completed без M2 run. Никакого partial error-repeat в карточке «Последний результат». Batch запросы: `exams` → `exam_versions(id, exam_id, version)` → только latest `content` одним `in()` → свои `attempts`/results одним batch, без N+1, key exposure и миграции по умолчанию; переиспользовать `isFullDtzInventory`/scope policy. В этом PR реализовать AC-08: две собственные active A/B и два правильных Continue, SQL re-read без нового start при GET.

**Dependency/order:** T1 → T2; никакого ожидания подготовки второго реального комплекта. Не добавлять новую модель «lesson»/«course» и не расширять структуру персональных аккаунтов.

**Done when:** каталог пригоден к использованию хотя бы с одним полным пилотом, независим от переменной выбора пилота и читается без мутации. **Primary PRD coverage:**

- **AC-02:** «Повторный Guest CTA в действующем сеансе не заменяет его, не продлевает 720 часов и открывает библиотеку»; язык сохраняется.
- **AC-03:** одна карточка на пригодную **полную latest**-версию; неполные/неопубликованные/старые версии не представлены как новые экзамены.
- **AC-04:** `Choose mode`, собственные `Continue` и `Latest result` по серверному состоянию; ни одного чужого состояния.
- **AC-05:** 0/1/2/N и локализованные empty/error/retry, стабильный порядок.
- **AC-06:** ни ключей, ни owner manifest, ни signed URL, ни чужой попытки/общего кэша.
- **AC-08:** две собственные активные full A/B попытки, `Continue` на свой attempt/блок; SQL re-read.
- **AC-07:** переход A/B по правильному slug без GET/hover/prefetch/start side effects (с двумя fixture-экзаменами).
- **AC-12:** прежний явный идемпотентный start, конфликт собственного слота и race latest-version не ухудшены библиотекой.

**Phase gate / evidence:** отдельные именованные browser specs + SQL re-read; T1/T2 не принимаются по одному screenshot. **Незакрытая на этом этапе часть AC-01:** наличие второго **реального** экзамена — гейт Phase 5.

### Phase 2: Непрерывный UX конкретного экзамена, навигация и медиабезопасность

**Goal:** На выборе режима, Hören, Lesen, переходе и разборе пользователь всегда понимает, *какой* комплект открыт и как вернуться к списку. Выход из активного timed/full информирует о работающем серверном времени; внутри одного экзамена сохраняется единственный audio owner и уже реализованная мобильная UX-система #48.

**Affects:** только `apps/web`: маршрутные layout/page и небольшой отдельный exam context, ссылки/диалог контролируемой навигации, `TrainingShell` **лишь при строго необходимом подключении видимого контекста**, существующий `ExamAudioSession`, EN/RU, Playwright/компонентные тесты. `AppBar` и `training-header-slot` не перепрофилируются.

**Tasks:**

- [ ] **P2-T1. Согласованный exam-context во всей существующей цепочке.** Одна лёгкая и доступная визуальная конструкция: `← Все экзамены`, доверенное название конкретного `examSlug`, этап Hören/Lesen и режим **только там, где он известен**. Охватить choice, active, submitted/pending, completed review и старые прямые URLs. Не выводить конфликтующих заголовков, не занимать словарный слот, не создавать второй AppBar/проигрыватель; название из серверного экзамена/закреплённой версии, не из query/localStorage. **В этом же PR:** E2E на 320/390/1440, long-title, EN/RU, keyboard/focus, dictionary/LocaleSwitcher и legacy deep links; возврат к нужному slug; аудио A не продолжается в B, intra-exam choice → attempt сохраняет существующий owner. **Рекомендуемая модель:** Sonnet High с UX-review.
- [ ] **P2-T2. Понятный выход из active timed/full без изменения state machine.** Управляемые переходы к библиотеке/другому экзамену сопровождаются доступным подтверждением «Остаться» / «Перейти — время продолжает идти». Не отменять, не завершать, не приостанавливать попытку из-за перехода. Свободная тренировка/завершённый review не получают лишнего предупреждения. Browser Back/reload/close не обещают гарантированный interstitial; реальная гарантия — неизменный абсолютный server deadline. **В этом же PR:** E2E cancel/confirm, keyboard/ESC/focus return, RU/EN текст, multi-tab, серверные deadline и audio-stop при смене exam; тест против ложной остановки таймера. **Рекомендуемая модель:** Sonnet High; при изменении state/auth — независимое Opus review, либо исправление вне этой UX-задачи.

- [ ] **P2-T3. Доступность timed/full без профиля. [Sonnet High]** Исправить `ModeSelection`: без подтверждённого timing latest-версии **оба** `timed-block` и `exam` disabled с EN/RU причиной; `training` доступна. Сохранять серверный `start.ts` gate `not-enabled`. В том же PR — компонентные проверки с профилем/без и E2E полного synthetic DTZ без профиля: disabled UI, прямой POST `not-enabled`, 0 start events, EN/RU/a11y. Реальный профиль B — отдельное решение владельца. Закрывает UI/server AC-18.

**Dependency/order:** Phase 1 → P2-T1 → P2-T2; P2-T3 после P1-T1, независимо от появления реального B. Минимальные, мобильные и доступные компоненты MUI; не пересобирать Guest landing / ModeSelection (#48). Разделение предупреждения и навигации не добавляет новую команду `start/submit/cancel`.

**Done when:** маршрут каталога связан с уже работающим exam-flow, текущий комплект различим на каждом нужном экране, неудобные маршруты не выключают время и не теряют данные. **Primary PRD coverage:**

- **AC-10:** exam name, путь «Все экзамены», режим/этап на choice, active и review с сохранением AppBar/словаря.
- **AC-11:** явное предупреждение при управляемом выходе из timed/full, cancel/confirm и неизменность deadline.
- **AC-13:** совместимость `/practice`, `/practice/lesen`, exam и pinned attempt/review URLs без записи при чтении.
- **AC-14:** независимый audio owner A/B, прекращение звука A при выходе и сохранение одного owner внутри A.
- **AC-18:** UI/server `timed-block`+`exam` недоступны без confirmed profile, free разрешён; реальный B — owner gate P5.
- **AC-31:** EN/RU, 320/390/1440 px, keyboard, screen reader announcements, отсутствие горизонтального scroll, семантика dialog/link/button.
- **AC-32:** результат #48 не сломан: первый вопрос Hören, словарь, локаль, иерархия режима, существующие селекторы.

**Phase gate / evidence:** UX и accessibility браузерные проверки плюс отрицательные SQL-состояния: предупреждение ничего не меняет в persisted attempt. Подтверждение ухода **не** является подтверждением отмены экзамена.

### Phase 3: Единый строгий формат полного DTZ и рабочий owner dry-run

**Goal:** Владелец может подготовить **любой** поддерживаемый полный DTZ как один приватный `manifest v1` плюс отдельные аудиофайлы и получить структурированный отчёт **без записи** в БД или Storage. Подлинность и соответствие первоисточнику остаются отдельной ручной проверкой, но структурные ошибки отсекаются автоматически.

**Affects:** `packages/domain` — только чистые правила полноты/структуры DTZ и unit tests; `scripts/` — owner-only manifest schema, CLI dry-run, безопасная диагностика, документация и unit tests; `vitest.config.ts` — подключение `scripts/**/*.test.ts` к `npm test`/CI Quality. **Не** `apps/web`, web route, UI или public import API. Возможные текущие источники: `packages/domain/src/material/schema.ts` (`examContentSchema`, `findMaterialProblems`, `findInventoryProblems`), `scripts/lib/publish-exam-version.ts`, `scripts/publish-pilot.ts`. Вводимый `manifest schemaVersion` — версия **административного входа**, не `exam_versions.version`.

**Tasks:**

- [ ] **P3-T1. Политика проверяемого полного DTZ как единый источник истины.** Поверх действующей схемы и проверок материала задать domain-валидацию именно **реального DTZ 20+25**, ожидаемой нумерации/Teil, допустимых видов заданий, групп Teil 3/4, references, примеров и ключей (один правильный вариант у каждого из 45). Переиспользовать уже имеющиеся `findMaterialProblems`/`findInventoryProblems`, не копировать пилотный validator. Проверить отрицательные кейсы «45 неправильных чисел/частей», повтор id, несогласованные общие опции, несоответствие `trackId`, отсутствующий текст, ключ для примера и лишний ключ. **Первый потребитель в этой же задаче:** применить новую общую проверку в существующем полном owner/pilot validation path вместо создания неиспользуемого абстрактного validator; сохранить действующие договорённости пилота. **В этом же PR:** чистые unit/domain tests с полными и дефектными fixtures и regression для текущего `publishFullPilot`; старый пилот остаётся валиден. **Рекомендуемая модель:** Sonnet High, независимое domain/API review. **Уточнение по ревью:** Валидационная структура DTZ из `docs/pilot-material.md`: Hören Teil1–4 4/5/8/3 (Teil3 — 4 пары `true-false`+`single-choice`, Teil4 — `shared-set` из трёх), Lesen Teil1–5 5/5/6/3/6; сплошная нумерация по навыку, примеры не оцениваются. Для full timed/exam оригинальная запись Hören обязана быть **одна непрерывная** (`resolveExamAudio` и SQL timing profile); несколько Hören tracks → блокирующая ошибка `multiple-hoeren-tracks`, склейка/нарезка вне M3. Профиль — условия допуска второго источника к M3, не абстрактное требование к любому издателю.
- [ ] **P3-T2. Приватный owner manifest v1 и полноценный dry-run CLI.** Один документированный пакет с `slug`, `title`, `format=DTZ`, `source`, `content`, `keys`, `schemaVersion=1` и `trackId` → локальные audio paths; отдельные бинарные файлы не в Git. Строгий разбор неизвестных полей/версии и размеров/типа файлов, проверка всех связей, **список** проблем `{code, field/path, questionId/trackId, message}` вместо первой упавшей исключительной ошибки. Проверка не инициализирует привилегированный Supabase client, не загружает audio и не пишет БД; читает только разрешённые локальные inputs. Не включать ключи/manifest/секреты в diagnostic output. **В этом же PR:** tests CLI exit codes/stdout/stderr, dry-run без env/БД, множественных ошибок, unsupported MIME/empty/missing file, path traversal/unexpected URL if relevant, unknown schemaVersion и leak scanning. **Рекомендуемая модель:** Sonnet High; security-review чтения локальных файлов. **Уточнение по ревью:** В этом же PR включить `scripts/**/*.test.ts` через `vitest.config.ts`; настоящие CLI-тесты exit codes/stdout/stderr/отсутствие DB/Storage write при dry-run в `npm test`/`Quality`. Реальные publish DB+Storage проверки сохраняются в Playwright.

**Dependency/order:** T1 → T2. Выдержать строгую границу: публичный `examContentSchema` **не содержит ключ**; owner manifest остаётся owner-only. Конкретные лимиты размера/числа файлов фиксируются относительно реально поддерживаемой конфигурации, без обещания непроверенных тарифов. `contentSchemaVersion` для старого persisted content **не добавляется**, пока не требуется несовместимая публичная структура.

**Done when:** полностью валидный подготовленный полный пакет проходит `validate/dry-run`, все перечисленные некорректные пакеты дают адресный непривилегированный отчёт, а Storage/DB не меняются. **Primary PRD coverage:**

- **AC-22:** один v1 manifest + отдельные аудио без индивидуальных скриптов B/C.
- **AC-23:** dry-run отклоняет неправильные формат/slug/инвентарь/Teil/keys/refs/audio/files/version и указывает точные проблемы **до записи**.
- **AC-24:** ключи, привилегированные данные и бинарники не появляются в Git, stdout/stderr и публичном контракте.
- **AC-29:** старые публичные версии по-прежнему читаются; неизвестная owner-input версия блокируется; несовместимая информация не упрощается с потерями.

**Phase gate / evidence:** положительные и отрицательные pure domain + CLI tests. При несоответствии будущего реального источника текущему renderer — **не расширять** схему автоматически: блокировать именно этот материал, выбрать другой совместимый источник либо отдельно согласовать изменение PRD и ARC-03.

### Phase 4: Универсальный защищённый publish и безопасное восстановление

**Goal:** Владелец после успешного dry-run может **явно** опубликовать любое полное совместимое издание B/C через существующую транзакционную серверную публикацию и приватный Storage. Повтор идентичного пакета безвреден; исправление создаёт новую неизменяемую версию; отказы и гонки не порождают видимой неполной публикации.

**Affects:** owner `scripts/` и существующая публикационная граница `scripts/lib/publish-exam-version.ts`, изолированная Supabase Database/Storage, integration tests `scripts` и `apps/web/tests/material-publication.spec.ts` либо новые тесты по фактическому владельцу. Не меняются web UI, публичные grants или права guest. SQL migration допускается **только** при найденной нерешаемой race/atomicity-проблеме в текущей приватной процедуре с отдельным security review.

**Tasks:**

- [ ] **P4-T1. Завершённая owner-команда `publish` поверх общего валидатора.** Команда повторяет ту же проверку, что `dry-run`, требует явного publish-действия, использует действующий `publishExamVersion` и `publish_exam_version`, сохраняет раздельные public content/closed keys/private audio, сообщает только безопасные `slug/versionId/isNew` и проверяемый результат. Один и тот же ввод через повтор не создаёт v2, изменённый валидный материал создаёт следующую immutable версию. Не хранить ключ в web/runtime, не вводить `/admin`. **В этом же PR:** SQL+Storage integration для new/same/changed version, DB re-read `answer_keys` (только privileged test), попыток `anon/authenticated`, проверка signed access и совместимости старого пилота. **Рекомендуемая модель:** Opus для security/concurrency границы; Sonnet может делать shell/tests после review контракта. **Уточнение по ревью:** До первой загрузки файлов read-only preflight требует явное намерение `--new-exam` (slug отсутствует) или `--new-version` (slug существует); смена `format` запрещена, смена `exams.title` разрешена лишь флагом `--rename` с предупреждением для исторических review. Текущая SQL `publish_exam_version` содержит `ON CONFLICT(slug) DO UPDATE title`; защита должна оставаться корректной и при гонке preflight→SQL, с миграцией SQL-guard только при необходимости, с RLS/GRANT negative tests. Чужой slug/format без явного намерения — отказ ДО upload и без DB mutations. **Runbook и AC-30 принадлежат P4-T1:** `docs/deployment.md`: validate → ручная сверка source/legal/45-key/audio → publish → verified read → отдельное timing profile → retry/orphan audit.
- [ ] **P4-T2. Recovery и наблюдаемость при сбоях/двойном запуске.** Покрыть Storage-error, DB-error после загрузки bytes, прерванную/повторенную публикацию и две конкурирующие owner-команды для одного slug. Сохранять content-addressed object identity и отсутствие частично опубликованной версии; безопасно диагностировать orphan private objects, не удаляя используемые/чужие или неизвестные объекты. Повторяемость не равна безусловному удалению по ошибке: уборка допускается лишь после доказательства отсутствия ссылок и учёта гонок. **В этом же PR:** fail-point/integration tests, re-read старых версий и аудио, zero partial-publication assertions, отсутствие приватных payloads в логах. **Рекомендуемая модель:** Opus (race, DB/Storage consistency). **Уточнение по ревью:** Два конкурентных `upsert:false` upload одного content-addressed объекта: «object exists» считать успехом ТОЛЬКО после проверки соответствия объекту (hash/байты), без перезаписи. Тестировать параллельный preflight→SQL, failed Storage/DB, retry и orphan audit, не удалять используемые ресурсы.

**Dependency/order:** Phase 3 → P4-T1 → P4-T2. Публикация и доступ к аудио используют только доверенные owner-инструменты/существующий SQL gate. Прямые `anon/authenticated` grants и service key в браузер не добавляются; применённые миграции не меняются. Профиль времени не публикуется вместе с контентом.

**Done when:** универсальный CLI публикует два **разных тестовых** full-DTZ через один и тот же интерфейс, делает безопасный повтор и обновление одной версии, остаётся атомарным на уровне видимой публикации и даёт безопасную процедуру аудита ошибок. **Primary PRD coverage:**

- **AC-25:** корректный пакет публикуется через текущую защищённую границу; после публикации появляется в каталоге без UI hard-code.
- **AC-26:** identical input → прежняя версия, changed valid input → новая immutable версия; pinned attempts не меняются.
- **AC-27:** сбои/гонки/retry не оставляют видимой неполной версии; orphan audio выявляется без рискованного удаления.
- **AC-30:** безопасный owner-runbook публикуется вместе с CLI и до P5, ручная сверка источника не приравнивается к CI.
- **AC-28:** Guest/anon/authenticated не получают права писать материал/ключи/Storage/timing; нет web-admin route и service key в bundle.

**Phase gate / evidence:** реальная изолированная DB/Storage и два независимых owner пакета; успешная unit проверка **не заменяет** security-integrations. При необходимости правки SQL — отдельный миграционный risk review и проверка RLS/grants до merge.

### Phase 5: Второй настоящий полный DTZ и независимая публикация

**Goal:** Получить **не синтетический** второй вариант, проверить его с владельцем и опубликовать как новый `slug`; в библиотеке действительно существуют **два** самостоятельных полных экзамена с правильными источниками/аудио/ключами. Обеспечить его free training, а timed/full держать закрытыми до конкретного confirmed timing profile.

**Affects:** контент и evidence владельца **вне репозитория** (PDF/ключи/аудио/manifest), `scripts/` как уже готовые команды, изолированное/cloud Supabase Storage/DB по разрешённой процедуре; owner runbook/evidence внутри `docs/` без приватных материалов. **Не писать** второй отдельный publisher, не встраивать ключи и оригинальную запись в Git, не создавать PDF-worker и не увеличивать public content schema без согласования.

**Tasks:**

- [ ] **P5-T1. Поиск пригодного комплекта и предварительный legal/content gate.** Найти независимый достоверный **полный DTZ**, структурно аналогичный пилоту: 20 оцениваемых Hören + 25 Lesen, примеры отдельно, исходные вопросы/группы/тексты, проверенный официальный или иной авторитетный ключ, оригинальная полная Hören-запись, traceable publisher/title/source URL/pages и законное основание **показывать материалы в приложении**. Отметить отсутствие/расхождение каждого элемента до выбора; исключить источники с утратой критической визуальной структуры или неясными правами. Кандидат считается подходящим только после фиксированного решения владельца; «нашлось PDF в сети» недостаточно. **Evidence:** source inventory/checklist с ссылками и явно подтверждёнными владельцем правами и ключом; приватные оригиналы — вне Git. **Рекомендуемая модель:** Sonnet для анализа, владелец — окончательное решение о пригодности/правах. **Уточнение по ревью:** Ручной gate владельца, стартовать параллельно P1–P4. Доступны права/оригинальный авторитетный ключ на 45 заданий и **одна непрерывная оригинальная Hören-запись со всеми примерами**; раздельные tracks по Teil не подходят, M3 не монтирует их. Не создавать для поиска техническую Issue с фиктивным Verify.
- [ ] **P5-T2. Подготовленный, дважды сверенный пакет B.** Привести содержимое первоисточника к **существующей** публичной схеме; пройти 45 item-by-item с номером, Teil, типом, options, связью пары/shared set/text, авторитетным ключом и местом в оригинале. Сопоставить все `trackId` с оригинальной записью, её целостностью/длительностью; не переносить ни ключ, ни аудио из A; полное наполнение проходит owner `dry-run`. Несовместимая таблица/изображение не удаляется ради результата: такой кандидат отклоняется или создаётся отдельное согласованное решение о расширении scope/ARC-03. **Evidence:** приватная матрица 45 вопросов и source/key/audio checks, безопасное summary без ответов в репозитории. **Рекомендуемая модель:** Sonnet для технической подготовки, независимая сверка владельцем и manual QA. **Уточнение по ревью:** Ручной owner gate: двойная сверка ключей/аудио/структуры, evidence только безопасной сводкой, source/key/audio/manifest остаются private; P3-T2 dry-run обязателен дополнительно. Тест CI не доказывает legal/source correctness.
- [ ] **P5-T3. Публикация B, free smoke и gate времени.** После owner approval выполнить универсальный `publish`, проверить `slug/title/version` и 20/25, наличие закрытого ключа и storage по server read, появление B в каталоге без нового кода, free Hören→Lesen→submit/review, независимость пилота. Для B без confirmed profile `timed-block/exam` должны быть **запрещены и на UI, и в SQL**; отдельно проверить существующую неоднородность UI-доступности: в текущем `ModeSelection` `isEnabled` блокирует по `examTiming === null` только `exam`, а `timed-block` может выглядеть доступным до отказа сервера. Исправить только UX-индикацию/availability, не ослабляя серверные проверки. Проверить отдельно процедуру подтверждения профиля **версии B**, сравнение fingerprint реальной записи/официального регламента и корректное открытие режимов только после него; не объявлять публичный timed проверенным, если ручного подтверждения нет. **Evidence:** безопасные publication outcome, verified SHA/CI и owner-manual checklist с отметками PASS/PENDING. **Рекомендуемая модель:** Sonnet для сопровождения; Opus при подозрении на нарушение security gate. **Уточнение по ревью:** В этом gate только owner-authorized публикация настоящего B, verified read/free smoke и проверка уже существующего UI gate P2-T3; `ModeSelection` не править здесь. При оформлении Issues P5-T1/T2 ведутся в M3 tracker как manual owner checklist, P5-T3 — документальное evidence при необходимости; CI не подменяет разрешения cloud publish.

**Dependency/order:** P5-T1 начинается сразу в параллель с P1–P4. P5-T2 после P3-T2 и найденного источника. P5-T3 после P1, P2-T3, P4-T1 и отдельного разрешения владельца на cloud publish. P5-T1/T2 owner-only manual gates в epic tracker, без фиктивного `Verify:`; P6 не ждёт P5.

**Done when:** в живой библиотеке **два настоящих** независимых DTZ, подтверждённая источниковая корректность B и работающая свободная тренировка. **Primary PRD coverage:**

- **AC-01:** после явного Guest CTA отображаются два реальных полных экзамена; no-start/no-guest-on-GET гарантии подтверждены P1.
- **AC-15:** реальный B со своим slug/title/source, ровно 20+25, верными Teil/парами/текстами, manual evidence.
- **AC-16:** 45 верных источниковых ключей, оригинальное аудио и проверенные основания публикации, не синтетика/не A.
- **AC-17:** free B Hören+Lesen, серверная оценка **B**, сохранение/разбор; A не изменён.

**Phase gate / evidence:** нельзя закрывать AC-15/16 как PASS по dry-run или тестовому контенту. AC-18 не объявляется вручную подтверждённым для Production, пока владелец не проверил реальную запись/регламент B; положительный технический путь можно доказать отдельным синтетическим E2E, сохранив production gate закрытым.

### Phase 6: Сквозная multi-exam интеграция, версии, Repeat и security

**Goal:** На единой проверенной базе одновременно работают два 45-вопросных экзамена с разными гостями, активными слотами, версиями, результатами, повтором ошибок и независимым аудио; отрицательные сценарии не раскрывают секреты и не меняют чужие строки. Этап добавляет именно проверки взаимодействия нескольких ранее завершённых возможностей, не заменяя тесты из Phases 1–5.

**Affects:** `apps/web/tests/**` и существующие server/UI границы **только если тест выявил конкретный дефект в пределах согласованного `Affects` нового Issue**; документация evidence. Повторное проектирование domain publisher/Guest/RLS не предполагается. CI `Quality`, isolated DB, Playwright с независимыми contexts; fixture каждого теста использует уникальный exam slug, не мутирует общий timing profile.

**Tasks:**

- [ ] **P6-T1. Два независимых полных DTZ: lifecycle/versions/repeat.** На разных реальных по структуре fixtures A/B проверить два active slots у одного Guest; correct `attemptId`, pinned version, resumes в нужном Hören/Lesen, сохранение ответов/audio positions; смена B/v1 → v2 не меняет старые B/review/repeat, A остаётся прежним. Repeat из B выбирает только assigned errors/skips B, readonly контекст Teil 3/4 не влияет на score и не раскрывает ключ; latest start идёт на latest B, old review — на pinned B/v1. Timed/full проверяются с доверенным fixture-profile, navigation/refresh не увеличивают сроки. **В том же PR:** named Playwright/SQL re-read, точные event counts и результаты, отдельная регрессия старых `/practice*` URL. **Рекомендуемая модель:** Opus для сложных lifecycle/version races; Sonnet для изолированных E2E.
- [ ] **P6-T2. Матрица четырёх Guest и негативная безопасность.** Четыре независимых browser contexts с двумя exam-slugs проверяют own/foreign attempt, mismatched slug/version, expired/replaced Guest, повторенные команды, неправильный Origin **отдельно** от чужого owner, прямые Data API/RLS/GRANT/Storage, denial до сдачи и отсутствие secret в HTML/RSC/cache/client bundles. SQL re-read для принятых и запрещённых операций, аудио каждого контекста не влияет на другие; тесты не подменяют server authority mock-ответами. **В том же PR:** negative matrix + проверка production-boundary/no test wrappers и неизменности старого security baseline. **Рекомендуемая модель:** Opus (security lead); Sonnet — отдельные test helpers при строгом review.
- [ ] **P6-T3. Сквозная ресурсная регрессия. [Sonnet High]** Каталог не делает N+1 и не запрашивает signed audio; переход A→каталог→B не оставляет двух `<audio>`/media owners. Измерить CI budget, не увеличивать таймауты и не ослаблять assertions. Не дублировать P1/P2 EN/RU, 320/390/1440, keyboard/a11y. Opus ревью security при необходимости.

**Dependency/order:** после P1, P2 и P4: две synthetic full DTZ fixtures A/B + настоящая test DB/Storage. Phase 6 не ждёт реального B; owner B checks остаются в P5/P7. Исполнитель сначала воспроизводит дефект текущим тестом, затем исправляет только owning boundary в отдельно одобренном Affects; не расширять M3 на общий «refactor». Для всех новых security-проверок использовать реальный корректный Origin в positive/foreign-owner случаях; wrong Origin — отдельный CSRF scenario.

**Done when:** на CI есть проверенная матрица двух полных fixtures/версий + 4 Guest + repeat/timing и отсутствие нарушений ownership/кэша/ресурсных границ. **Primary PRD coverage:**

- **AC-09:** IDOR чужого Guest / mismatched slug+version без data leak и лишних событий.
- **AC-19:** никакой навигацией/языком/refresh не продлеваются server deadlines и не обходятся phase gates.
- **AC-20:** B/v2 не изменяет B/v1/attempts/keys/results/repeat и не затрагивает A.
- **AC-21:** source-scoped repeat B только по B/source version; readonly контекст вне score.
- **AC-33:** ≥4 Guest одновременно A/B, реальные DB/Storage/audio/events, независимость.
- **AC-34:** IDOR, forged keys/timing/owner, CSRF, expiry, unpublished/key/signed URL, RLS/Storage/cache и negative grants.

**Phase gate / evidence:** named Playwright specs + SQL assertions в `Quality` на реальном PR head и проверка отсутствия ослабленных селекторов/ожиданий. 350 зелёных старых E2E из отчёта M2 — исторический baseline, не результат нового M3.

### Phase 7: Актуальная документация, owner acceptance и release-gate M3

**Goal:** Зафиксировать то, что **реально** получено и проверено, передать владельцу безопасную воспроизводимую процедуру публикации третьего экзамена и итоговую матрицу M3. Не считать закрытие Issue, merge, зелёный CI и production проверкой реального экзамена или ручным согласием владельца.

**Affects:** `docs/architecture.md`, `docs/architecture-evolution.md`, `docs/security.md`, `docs/deployment.md` и owner-runbook, `docs/training.md`, `docs/scoring.md` при изменении сценариев, `docs/roadmap.md`, `docs/project-overview.md`, `docs/project-decisions.md` **только при реально новом решении**, новый `docs/m3-acceptance.md`; текущие `docs/m1-acceptance.md` и `docs/m2-acceptance.md` остаются историческими доказательствами. Изменённую архитектурную документацию дополнять **в тех же PR**, что изменяют runtime; эта фаза сводит и проверяет её, а не оправдывает отсутствие docs ранее.

**Tasks:**

- [ ] **P7-T1. Документация фактической архитектуры и owner-runbook.** Согласовать с объединённым кодом каталога/attempt/version/signed audio/CLI/Storage. Развести M3 CLI и будущие web-admin/PDF/alignment/Accounts, указать реальные ограничения формата и fallback при неподходящем исходнике. Зафиксировать инструкцию `validate → сверка источника/прав → publish → verified read → gate timing → safe retry/orphan-audit`, конфигурацию без секретов, recovery ошибочных публикаций и поддерживаемые устройства; security matrix/ARC-01–06 обновлять по фактическим контрактам. **Рекомендуемая модель:** Sonnet High; безопасность и эксплуатационный runbook — Opus review. **Уточнение по ревью:** Уточнить и свести опубликованный в P4-T1 runbook, не писать впервые. В `docs/security.md` задокументировать остаточный риск `publish_exam_version` доступной `service_role`, применяемой и веб-рантаймом; отдельная owner DB-role — будущая согласованная мера, не автоматический scope M3.
- [ ] **P7-T2. `m3-acceptance.md`: доказательства для 36 AC и Go/No-Go.** Для каждого AC указать owning task/PR, фактический tested SHA, named tests/CI, результат SQL/Storage проверки, статус `implemented`/`automated checked`/`deployed`/`owner accepted`, датированные источниковые и UX/manual checks. Пройти отдельно реальный B/45-key/audio/legal, физический телефон (iOS Safari/Android Chrome насколько доступно), desktop, timing profile и M2 manual pending; не выдать недоказанное за PASS. Зафиксировать известные дефекты, PENDING, ограничения и решение владельца о публикации/доступности timed. **Рекомендуемая модель:** Sonnet High + независимый Opus security/QA review.

**Dependency/order:** Phases 1–6 по реально предъявленным evidence; owner-manual данные доступны только от владельца; документационный PR может подготовить матрицу и маркировку PENDING независимо от наличия телефонов/допуска timed. **Не** менять статусы historical M1/M2 на основе PRD M3.

**Done when:** полное покрытие фактов M3 и безопасный owner runbook опубликованы/доказаны; оставшиеся manual/cloud проверки описаны как pending. **Primary PRD coverage:**

- **AC-35:** обновлены актуальные `architecture`, ARC, security, training, roadmap/overview, decisions лишь при необходимости, deployment/owner docs с честной границей реализованного.
- **AC-36:** M3 acceptance содержит **два настоящих экзамена**, source checks, UX devices, timing/version, соответствие #47–#49, доказательства CI/Production/manual и не подменяет отсутствующие проверки.

**Phase gate / evidence:** наличие документа — не автоматическое `owner accepted`. Go на публичный **free** доступ требует проверенного B и security; timed/full для B — **отдельного** подтверждения source timing version/fingerprint и server gate.

### Primary AC coverage — все 36 критериев, без потерянных или двойных владельцев

| Фаза | Primary Acceptance Criteria | Количество | Зависимость для полного закрытия |
| --- | --- | ---: | --- |
| Phase 1 · Guest/library | AC-02, AC-03, AC-04, AC-05, AC-06, AC-07, AC-08, AC-12 | 8 | Full-DTZ test fixture, текущий M2 start |
| Phase 2 · UX/navigation/audio | AC-10, AC-11, AC-13, AC-14, AC-18, AC-31, AC-32 | 7 | Каталог P1, актуальные компоненты #48 |
| Phase 3 · Validation/manifest/dry-run | AC-22, AC-23, AC-24, AC-29 | 4 | Existing domain schema; без реального B |
| Phase 4 · Trusted publish/recovery | AC-25, AC-26, AC-27, AC-28, AC-30 | 5 | Фаза 3 + isolated DB/Storage |
| Phase 5 · Second real DTZ | AC-01, AC-15, AC-16, AC-17 | 4 | **Реальный B, права, ключ, аудио и owner evidence** |
| Phase 6 · Integrated security/regression | AC-09, AC-19, AC-20, AC-21, AC-33, AC-34 | 6 | Фазы 1, 2, 3, 4, 4 Guest/2 synthetic full fixtures, без Phase 5, M2 contracts |
| Phase 7 · Docs/acceptance | AC-35, AC-36 | 2 | Evidence предыдущих фаз и owner manual |
| **ИТОГО** | **AC-01–AC-36, каждый указан один раз** | **36** | Без подмены требований тестами |

### Строгие dependency gates и критический путь

| Gate | Требование / причина | Что разрешено до gate | Что запрещено объявлять выполненным |
| --- | --- | --- | --- |
| **G0 — текущая база** | Проверить HEAD, правила, M2 #47/#48/#49 и `.factory/profile.json` перед Issues. На момент создания плана все три Issue **closed**, а M2 manual acceptance — **not done**. | PRD/PLAN, новые Issues, Phases 1–4. | «M2 полностью принят владельцем» без его ручного evidence. |
| **G1 — технический каталог** | Фазы 1–2: read-only catalog и корректная UX-навигация. | Проверять на первом full-пилоте и отдельном synthetic full-fixture. | «В production два реальных экзамена» без Phase 5. |
| **G2 — contract/security** | Фазы 3–4: dry-run строго без writes, publisher с реальной изолированной DB и failure/race tests. | Готовить и проверять owner tool до выбора B. | Допуск service secrets в браузер/публичные API. |
| **G3 — источник второго экзамена** | P5-T1: реальный 20+25, ключ, собственная запись, право на использование, совместимость с renderer. **Сейчас блокер открыт.** | Все независимые этапы. | Выпуск «второго экзамена», замена реальных 45 на fixture, потеря изображения/таблицы, угадывание ключа моделью. |
| **G4 — ручная проверка и публикация** | P5-T2/T3: 45-item source/key/audio matrix и owner approval, dry-run, publish, проверенное чтение. | Технический `publish` в тестовой среде. | Cloud publish без разрешения владельца и проверенной целевой среды. |
| **G5 — timed per version** | Отдельный confirmed timing profile с fingerprint версии и реальной записью. | Free training, автоматические positive/negative E2E с тестовым confirmed profile. | Публичный B timed/full без owner verification; копирование A profile. |
| **G6 — интеграция и приёмка** | Phase 6, Phase 7; CI на **актуальном** SHA, manual checks и deployment evidence отдельно. | Принятие тестируемых независимых частей с PENDING evidence. | Называть merged/deployed/CI green равнозначным owner acceptance. |

**Критический путь:** параллельно P1→P2 (web), P3→P4 (CLI), P5-T1 (поиск/legal). P5-T2 после P3 и материала; P5-T3 после web+CLI+owner approval. P6 после web+CLI на synthetic A/B без ожидания P5; продуктовый P7 Go/No-Go требует реального B. Ветка P1–P2 и ветка P3–P4 могут выполняться параллельно **при независимых заданиях и отсутствии конфликтов по Affects**, но это не разрешение автоматически слить задачи без проверки интеграции.

### Матрица рисков и решений principal reviewers

| Риск | Приоритет | Предотвращение / критерий остановки | Владелец контроля |
| --- | --- | --- | --- |
| Нет правомерно доступного **второго полного источника** | **Blocker M3 product** | Не выбирать неподтверждённый материал; вести source checklist; не принимать synthetic вместо B; можно завершить P1–4 отдельно. | Product owner + content QA |
| Подмена 45 фактических ключей «похожими»/моделью | **Critical correctness** | 45 source-key trace с независимой проверкой; любые расхождения блокируют publish. | Owner + QA |
| Исходник содержит важные картинки/таблицы вне schema | **High UX/correctness** | Source-fit gate: выбрать совместимый полный комплект; иной вариант только через отдельное решение ARC-03 + scope review. | Architect + owner |
| Privacy leak в catalog/SSR/cache/логах | **Critical security** | Public projection only, guest-own read, no keys/audio URLs, private no-store, browser artifact scanning, negative tests. | Security reviewer |
| `Guest`+`examSlug` смешивают active slots | **Critical integrity** | Slot key per exam/guest, server checks, 4 contexts, SQL re-read, version pin. | Backend + QA |
| Двойная публикация и orphan objects | **High consistency/cost** | Existing immutable SQL gate, idempotency/failure tests, content-addressed audio, audit без автоматического массового delete. | Architect + security |
| Запуск timed неподтверждённой версии | **Critical product/security** | Trusted server+SQL gate, source fingerprint per version, отрицательные тесты B без профиля. | Owner + backend |
| Переход из timed вводит в заблуждение | **High UX/trust** | Explicit leave warning без приостановки/отмены; server deadlines сохраняются при Back/refresh. | UX + QA |
| Незаметная поломка #47/#48/#49 | **High regression** | Cross-exam repeat/version, dictionary slot, MUI 320 px, legacy URLs, Quality regression. | Tech lead + QA |
| Долгий CI/E2E и конфликт fixtures | **Medium delivery** | Изоляция slug, не мутировать shared profile, замер time budget 30 min, tests per code PR, не ослаблять assertions. | QA lead |

### UX, security и test non-negotiables при создании Issues

**UX:** один первый выбор «экзамен» → второй «режим» → только затем `Start`. `Continue` никогда не создаёт новую попытку; `Latest result` существует только для собственного completed. В мобильном viewport сначала видны идентичность комплекта и контент, а не многоуровневая навигационная панель. Нативные роли link/button/dialog, доступные ошибки и фокус, RU/EN без перевода учебных немецких материалов. Сломанный latest экзамен не рендерится как пригодный даже при существовании старого full.

**Security:** privileged Supabase client остаётся только `src/server/` и доверенных `scripts/`; public schemas и catalog без answer keys, secrets, private paths, signed URLs, raw DB errors. Guest проверяется перед доступом к персональному состоянию; read-only операции не пишут `start`. RLS и DENY по default; неверный Origin тестировать независимо от IDOR. Новые SQL-функции только при подтверждённой необходимости, привилегии/negative tests вместе с миграцией.

**QA:** тесты из tasks P1–P4 и P6 должны проходить на реальном пути server → SQL → Storage (где применимо), синтетика допустима только для CI-детерминизма. Контракт schema и publisher сравнивается с исходным `packages/domain`/`scripts/lib`, не дублируется под M3. Проверять потерянный start response, повтор команды, stale latest, два exam/версии, denied foreign access, audio lifecycle, ошибки и доступность. Не запускать тесты против Production для генерации данных; cloud/manual отдельно и с разрешением владельца.

**Delivery:** каждой будущей Issue нужен конкретный Affects и Doc-to-Read, проверяемые `AC`/`TR`/`DOD` по формату v2, review постановки до approved. Для чувствительных областей `answer_keys`, `guest_session`, `migrations` назначить независимый security review. Рекомендации по Claude выше учитывают сложность/стоимость; модель в Issue — рекомендация, разрешённые модели из репозитория не менять. Задачи проходят Plan-first → Issue-first → Branch-first; не запускать автоматический цикл review без значимых замечаний.

### Epic branch / execution note

**Recommended epic base branch:** потенциально оправдана только если одновременная реализация нескольких зависимых PR действительно требует интеграционной ветки. На этапе PLAN **нет tracker Issue и его номера**, поэтому имя **не фиксируется и ветка не создаётся**. После назначения tracker номер вычислить **установленной Dark Factory**, а не вручную: `branchNameFor(profile.branchTemplate, trackerNumber, "admin-exam-library-base")` с актуальным `.factory/profile.json`. При обычном последовательном merge отдельных проверяемых PR интеграционная база не обязательна; более дешёвый и понятный вариант — отдельные task branches по Issue.

**Следующий артефакт после согласования владельцем:** создать/согласовать M3 tracking Issue, применить `issues` skill к этому PLAN, по фазам оформить milestones/Issues только после реальной сверки `Affects` и source prerequisites. **Сам PLAN не создаёт Issues, не меняет код, не публикует материал и не подтверждает ручную приёмку.**