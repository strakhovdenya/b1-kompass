# Полный пилот: подготовка и загрузка материала

Документ описывает, как владелец готовит и публикует полный пилот telc «Auf jeden Fall! B1.2 — Übungstest DTZ» (20 Hören, 25 Lesen). Публикует только владелец, с компьютера, через доверенный путь. Веб-админки и автоматического импорта в M1 нет.

## Источники

Все ссылки ведут на страницу загрузок издателя telc, материал не копируется в Git.

| Что | Источник |
| --- | --- |
| Экзамен, 15 страниц | https://www.telc.net/fileadmin/user_upload/Downloads_Verlag/Auf_jeden_Fall/Uebungstests/Auf_jeden_Fall_B1.2_UEbungstest_DTZ.pdf |
| Ключ издателя (45 заданий) | https://www.telc.net/fileadmin/user_upload/Downloads_Verlag/Auf_jeden_Fall/Loesungen_Hoertexte/Auf_jeden_Fall_B1.2_Loesungen_KB_AB.pdf, стр. 6, раздел «Übungstest Deutsch-Test für Zuwanderer» (в файле есть и другие тесты) |
| Запись, Track 127 | https://www.telc.net/fileadmin/user_upload/Downloads_Verlag/Auf_jeden_Fall/Audios/Auf_jeden_Fall_B1_2_Track_127_Uebungstest_Deutsch_Test_fuer_Zuwanderer.zip (весь Hören DTZ одним файлом) |
| Расшифровки, стр. 28–30 | https://www.telc.net/fileadmin/user_upload/Downloads_Verlag/Auf_jeden_Fall/Loesungen_Hoertexte/Auf_jeden_Fall_B1.2_Hoertexte_KB_AB.pdf |

## Инвентарь

| Блок | Задания | Структура |
| --- | --- | --- |
| Hören Teil 1 | 4 | одиночный выбор a/b/c |
| Hören Teil 2 | 5 | одиночный выбор a/b/c |
| Hören Teil 3 | 8 | 4 пары на общей записи: «Richtig / Falsch» и одиночный выбор a/b/c; пример (Beispiel) не оценивается |
| Hören Teil 4 | 3 | общий набор утверждений a–f, три задания подряд на одной длинной дорожке, каждое выбирает одну букву |
| Lesen Teil 1 | 5 | одиночный выбор a/b/c, текст (`texts`) |
| Lesen Teil 2 | 5 | сопоставление с вариантами a–h и x (девять вариантов), один выбор |
| Lesen Teil 3 | 6 | Richtig / Falsch, длинный текст |
| Lesen Teil 4 | 3 | Richtig / Falsch |
| Lesen Teil 5 | 6 | a/b/c, текст с метками пропусков `[40]`–`[45]` |

Весь Hören относится к одной записи `track-127`. Примеры лежат отдельно в `examples`, не входят в `questions` и не имеют строки в `answer_keys`. Распределение заданий Lesen по Teil и номера страниц владелец сверяет с PDF при подготовке: тесты используют синтетический набор той же структуры.

Изображения Lesen в контракт M1 не входят: связываются только текстовые материалы. Таблицы, меню и объявления хранятся текстом в `texts[].body` и показываются с сохранёнными переносами строк. Синтетический комплект (`buildSyntheticPilot`) повторяет структуру Lesen пилота: части по 5, 5, 6, 3 и 6 заданий, девять вариантов в Teil 2, Richtig/Falsch в Teil 3–4, метки `[40]`–`[45]` в Teil 5; сам пилот с ключом лежит в `private/` и в тестах недоступен.

## Контракт материала

Схема — `examContentSchema` (`packages/domain/src/material/schema.ts`), проверки — `findMaterialProblems` и `findInventoryProblems`. Контракт один для короткого набора и полного пилота.

- Типы задания: `single-choice`, `true-false`, `shared-choice`. У каждого задания свои `options`; у `shared-choice` они совпадают с общим набором группы.
- Группы `groups`: `pair` (Teil 3: `true-false` и `single-choice`) и `shared-set` (Teil 4: ровно 3 задания, общий список вариантов).
- Связи: `textId` (текст Lesen), `trackId` (запись), `sourcePage` (страница источника).
- Номера уникальны внутри блока (`hoeren`, `lesen`), id — во всём наборе.

Публикацию блокируют: отсутствующий ключ (`missing-key`), ключ вне вариантов (`key-not-option`), ключ у примера (`key-for-example`), ключ без задания (`unknown-key`), дубль номера, id или варианта, сломанная ссылка на текст, запись или задание группы (`broken-reference`), неверная группа (`invalid-group`), расхождение вариантов общего набора (`options-mismatch`), число заданий не 20 и 25 (`inventory-mismatch`). Каждая проблема приходит с id задания или группы.

## Подготовка

1. Получить структурированный черновик из PDF: текст извлекает владелец (программно или в аккаунте модели). Модель не назначает ключ.
2. Положить в `private/pilot-draft.json` объект `{ "content": <examContent>, "keys": { "<id задания>": "<вариант>" } }`. Ключ переносится со стр. 6 файла Lösungen.
3. Запустить проверку и разделение:

```sh
PILOT_DRAFT_FILE=private/pilot-draft.json npm run prepare:pilot
```

Скрипт либо печатает проблемы и завершается с ошибкой, либо записывает `private/pilot-content.json` (публичная проекция) и `private/pilot-keys.json` (ключ). Каталог `private/` в Git не попадает.

## Загрузка

```sh
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SECRET_KEY=<secret> \
PILOT_CONTENT_FILE=private/pilot-content.json \
PILOT_KEYS_FILE=private/pilot-keys.json \
PILOT_AUDIO_FILE=private/track-127.mp3 npm run publish:pilot
```

`scripts/publish-pilot.ts` проверяет число заданий и передаёт материал общей функции публикации `publishExamVersion` (`scripts/lib/publish-exam-version.ts`), той же, что у `seed:pilot`. Повтор с тем же содержимым (в том числе с другим порядком ключей JSON) возвращает прежнюю версию, исправление текста создаёт новую. Полный пилот публикуется под тем же экзаменом, что и короткий набор, и становится его последней версией. Гость с активной попыткой остаётся на своей версии (см. `docs/architecture.md`).

Экраны тренажёра: Hören на `/practice`, Lesen с текстами на `/practice/lesen` (`docs/training.md`). Общий маршрут блоков и итоги — в следующих задачах.

## Статус проверки

| Что | Статус |
| --- | --- |
| Контракт, валидатор, публикация, идемпотентность, запрет Guest, выбор версии попыткой | ✅ проверены автоматически на синтетическом наборе (`material.test.ts`, `material-publication.spec.ts`) |
| Соответствие реальных 45 заданий, текстов, ключа и Track 127 оригиналу | ⏳ не проверено: сверку делает владелец, автоматический тест её не заменяет |
| Публикация полного пилота в облаке | ⏳ не выполнена |

Структурные тесты доказывают форму и целостность материала, но не смысловую точность. Реальный ключ и полные исходники в репозиторий и CI не попадают.
