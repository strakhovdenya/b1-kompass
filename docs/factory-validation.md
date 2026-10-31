# Проверка цикла фабрики на реальной задаче

Первая документированная проверка полного цикла dark-factory `v0.1.3` (коммит `33fa44b`) в этом репозитории. Фабрика подключена PR #15 и уже применялась в #1 (PR #17). Наличие пакета в `node_modules` само по себе не считается доказательством работы фабрики. Здесь записано только то, что реально выполнено, с фактическими командами и результатами. Невыполненное помечено **не проверено**.

| Поле | Значение |
| --- | --- |
| Issue | #2 — `[M1 P1-T2] Гость слушает запись и получает серверный результат короткой тренировки` |
| Ветка | `task/ISSUE-2-short-practice-audio-result` (из `branchTemplate` `task/ISSUE-{issue}-{slug}`) |
| База | `main` @ `4be7897` (merge PR #17) |
| Исполнитель | Claude Code (Opus), сеанс 2026-10-31, Windows 11, без Docker и без доступа к облаку |
| PR | дописывает владелец после merge |
| Итоговый head SHA | дописывает владелец после merge |
| Финальный CI `Quality` | ссылку дописывает владелец после merge |
| Review | ссылку дописывает владелец после merge |

## Шаги цикла

| # | Шаг (`task-lifecycle`) | Фактическая команда / действие | Результат |
| --- | --- | --- | --- |
| 1 | Чтение спецификации | `gh issue view 2 --json title,body,labels,comments,milestone` | Тело v2 получено; метки: только `enhancement` |
| 2 | Проверка формата issue | `node node_modules/dark-factory/verifier/issue-lint.js <тело issue #2> --require-v2` | `"format": "v2"`, `"problems": []`; 8 INV, 12 AC, 1 TR, 1 DOD распознаны |
| 3 | Заморозка спецификации (`spec-approved`) | метка на issue | ❌ **не проверено**: на старте метки `spec-approved` не было. Проверка `spec-approval` verifier'а пройдёт только после того, как владелец поставит метку |
| 4 | План до кода | план (файлы, подход, риски) показан владельцу | Одобрен ответом «го» |
| 5 | Загрузка `task-lifecycle` | Skill `task-lifecycle` | Загружен до создания ветки и первой правки |
| 6 | Ветка от актуального `main` | `git checkout main && git pull --ff-only && git checkout -b task/ISSUE-2-short-practice-audio-result` | Ветка создана от `4be7897`; посторонние изменения (`.vscode/`) не включены |
| 7 | Skill gate на `Write\|Edit` | первая запись `packages/domain/src/scoring/policy.ts` | Хук **заблокировал** запись: `requires skills that were not loaded in this session yet: js-gof, js-data-structures, error-handling, modern-javascript`. После загрузки этих skills та же запись прошла. Хук дополнительно вывел предупреждения Ajv `strict mode: missing type "object"…` о схеме профиля; на решение они не повлияли |
| 8 | Локальные гейты профиля, app `web` | `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` | ✅ exit 0 |
| | | `node node_modules/eslint/bin/eslint.js apps/web` | ✅ exit 0 |
| | | `node node_modules/vitest/vitest.mjs run apps/web` | ✅ exit 0, 3 файла, 7 тестов |
| | | `node node_modules/next/dist/bin/next build apps/web` | ❌ exit 1: `[next-intl] Could not find i18n config at ./src/i18n/request.ts`. Так же падает и без изменений этой задачи: `next.config.ts` ищет путь от текущей папки, а гейт запускается из корня. Сборка через `npm run build` (из `apps/web`) проходит, её же выполняет CI. Находка о профиле, вне `Affects` задачи |
| 9 | Локальные гейты профиля, app `domain` | `node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit` | ✅ exit 0 |
| | | `node node_modules/eslint/bin/eslint.js packages/domain` | ✅ exit 0 |
| | | `node node_modules/vitest/vitest.mjs run packages/domain` | ✅ exit 0, 2 файла, 11 тестов |
| 10 | Шаги CI локально | `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` | ✅ все exit 0; `npm test` — 5 файлов, 18 тестов |
| 11 | E2E и тесты доступа (`apps/web/tests/*.spec.ts`) | `npm run test:e2e` | **не проверено локально**: в среде агента нет Docker и локальной Supabase. Выполняются только в CI `Quality` |
| 12 | Closure gate, commit, push, PR | `git commit` / `git push` / `gh pr create` после чек-листа закрытия | дописывает владелец по факту: хэш коммита, номер PR |
| 13 | `/code-review` по рабочему diff | skill `code-review` по решению владельца перед commit | 10 замечаний. Исправлены 5: Finish/переход во время сохранения, потеря неподтверждённого выбора при переходе, AbortError у `play()`, повтор адреса записи без часов браузера, повторные чтения БД. Не исправлены 5: новый запуск после завершения (относится к этапу 4), CHECK счётчиков и отсутствие запрета на удаление результата (миграция уже применена в облаке; при необходимости — новой миграцией), дублирование контракта аудио в UI (`packages/domain` вне `Affects`), `getAttemptReview` без server action (это проверяемый серверный путь разбора из AC-5/AC-6). После исправлений `npm run typecheck`, `npm run lint`, `npm test` (18 тестов), `npm run build` — exit 0 |
| 14 | Обязательный `Quality` на точном head PR | GitHub Actions | **не проверено** до запуска CI; ссылку дописывает владелец |
| 15 | Acceptance verifier (`spec-approval`, `affects-scope`, `test-tampering-scan`, `ci-checks` …) | workflow `acceptance-verifier.yml` на PR | **не проверено**; ожидаемо зависит от шага 3 |

## Не проверено и вне доступа агента

- Применение миграции `20261101000000_short_practice.sql` к облачному проекту (`npx supabase db push`).
- Загрузка реального ключа заданий 2–4 и оригинальной записи Hören Teil 1 в приватный bucket облачного проекта через `npm run seed:pilot`.
- Прослушивание, завершение и разбор на опубликованном сайте с телефона и компьютера.
