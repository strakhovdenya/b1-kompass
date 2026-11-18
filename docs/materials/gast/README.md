# g.a.s.t. DTZ — источники для экзаменов B и C

**На 2026-11-07:** SOURCE SELECTED · STRUCTURAL INDEX PREPARED · **NOT IMPORTABLE · NOT PUBLISHED**.

Здесь хранятся только ссылки, описание проверки и **структурные индексы**. Это не полноценные `examContentSchema`, не owner manifest и не материал, готовый к публикации. Пользовательский выбор: B = Übungssatz 2, C = Übungssatz 1; пилот A (telc «Auf jeden Fall! B1.2») сохраняется отдельно.

## Официальные источники

| | B | C |
|---|---|---|
| Официальный тест | **g.a.s.t. Deutsch-Test für Zuwanderer A2–B1, Übungssatz 2** (июнь 2024) | **g.a.s.t. Deutsch-Test für Zuwanderer A2–B1, Übungssatz 1** (июнь 2024) |
| Планируемый slug | `dtz-gast-uebungssatz-2` | `dtz-gast-uebungssatz-1` |
| PDF | [Оригинал 2](https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/PDF/gast_DTZ_UEbungssatz_2.pdf) | [Оригинал 1](https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/PDF/gast_DTZ_UEbungssatz_1.pdf) |
| Оригинальное MP3 | [Audio 2](https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/Audio/gast_Deutsch-Test_fuer_Zuwanderer_UEbungssatz_2.mp3) | [Audio 1](https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/Audio/gast_Deutsch-Test_fuer_Zuwanderer_UEbungssatz_1.mp3) |
| Публичный индекс | [exam-b-index.json](exam-b-index.json) | [exam-c-index.json](exam-c-index.json) |

[Официальная страница с PDF и аудио](https://www.gast.de/de/forschung-entwicklung/entwicklung/auftraege/deutsch-test-fuer-zuwanderer-dtz/der-dtz-auf-einen-blick).
Оба PDF содержат **56 страниц**. Источник официального ключа — страница **54**, расшифровка Hören — страницы **51–53**.

## Структура (оба набора)

| Навык | Teil 1 | Teil 2 | Teil 3 | Teil 4 | Teil 5 | Всего |
|---|---:|---:|---:|---:|---:|---:|
| Hören | 4 | 5 | 8 | 3 | — | **20** |
| Lesen | 5 | 5 | 6 | 3 | 6 | **25** |

- Hören Teil 3 — 4 группы по два задания `true-false` + `single-choice`; Teil 4 — 3 задания `shared-choice` с одним набором вариантов a–f.
- **Lesen Teil 3** — задания 31/32, 33/34, 35/36 чередуют `Richtig/Falsch` и `a/b/c` (не шесть `Richtig/Falsch`). Lesen Teil 4 — три `Richtig/Falsch`.
- Примеры (`Beispiele`) сохраняются отдельно от 45 оцениваемых заданий.
- Issue [#79](https://github.com/strakhovdenya/b1-kompass/issues/79) уточнена под официальный формат, но валидатор **ещё не реализован**.

## Фактический статус

| Проверка | Статус |
|---|---|
| Официальные названия, PDF, независимость двух наборов | Подтверждены |
| Структура Hören 20 + Lesen 25 | Подтверждена официальной таблицей |
| Наличие официального ключа на 45 заданий | Подтверждено на стр. 54 |
| Предварительный перенос 45 ключей для B и 45 для C в приватные файлы | Выполнен ранее; требуется независимая сверка каждого ответа с вариантом |
| Полные формулировки, варианты, все тексты Lesen | **НЕ ПЕРЕНЕСЕНЫ** |
| Примеры и изображения/двухколоночные объявления Lesen | **НЕ ПРОВЕРЕНЫ** (напр. стр. 17) |
| Оригинальные MP3-байты, SHA-256, длительность и паузы | **НЕ ПРОВЕРЕНЫ**; существует официальная ссылка |
| Совместимость реального `content` с `examContentSchema` | **НЕ ПРОВЕРЕНА** |
| Универсальный owner CLI `exam:validate` / `exam:publish` | **ЕЩЁ НЕ РЕАЛИЗОВАН** (#80 / #81) |
| Разрешение g.a.s.t. на размещение заданий и аудио в стороннем публичном приложении | **НЕ ПОДТВЕРЖДЕНО** |
| Production/Supabase публикация B или C | **НЕ ВЫПОЛНЕНА** |

**Права:** на странице 2 PDF содержится уведомление о защите текстов, изображений и других материалов авторским правом. Бесплатная загрузка, учебная цель и отсутствие индексации сайта не равны разрешению на публичное воспроизведение.

## Правильный путь подготовки

1. Получать оригинальные PDF и MP3 только по официальным ссылкам, в локальную **`private/gast-sources/`** (каталог `private/` исключён через `.gitignore`). Не копировать их в `public/`, `docs/`, GitHub Issues, артефакты открытого CI.
2. Установить контрольные суммы SHA-256, фактический тип файла, MP3-duration и число потоков. Прослушать вступление, Beispiele, четыре Teile, паузы и окончание; подтвердить, что аудио соответствует выбранному PDF.
3. Извлечь точные исходные задания, тексты и варианты с сохранением умлаутов, ß, нумерации, ссылок на страницы, групп и примеров. Для Lesen Teil 2 обязательно визуально проверить порядок двух колонок объявлений.
4. Дважды сверить **каждое** из 45 заданий и правильных ответов **в каждом** наборе. Предварительные `richtig/falsch` в приватных ключах технически обозначены `a/b`; окончательное соответствие определяется реальными `options`.
5. Сформировать приватные `content` и `keys` по [`examContentSchema`](../../../packages/domain/src/material/schema.ts), затем **после реализации** [#79](https://github.com/strakhovdenya/b1-kompass/issues/79) и [#80](https://github.com/strakhovdenya/b1-kompass/issues/80) собрать owner manifest и выполнить `exam:validate`.
6. Только после окончательной проверки и отдельного решения по правам/публикации использовать owner CLI из [#81](https://github.com/strakhovdenya/b1-kompass/issues/81). Не применять `publish:pilot` — он привязан к telc. Подтверждение профиля времени каждой версии — отдельный gate.

Публичные индексы (`status: INDEX_ONLY_NOT_CONTENT_SCHEMA`) содержат **только** план расположения заданий, группы, идентификаторы текстов и ссылки на оригиналы. В них намеренно **нет** полных вопросов, вариантов ответов, ключей, файлов записи и содержимого PDF. **Эти индексы нельзя импортировать в приложение или считать прошедшими валидацию.**

## Привязка к проекту

- [M3 tracker #73](https://github.com/strakhovdenya/b1-kompass/issues/73): отдельно отмечены ручные gate.
- [#83](https://github.com/strakhovdenya/b1-kompass/issues/83): публикация реального B; решение добавить C само по себе не доказывает его готовность к публикации.
- [`docs/pilot-material.md`](../../pilot-material.md): отдельный telc-пилот A.
- **Секреты, PDF/MP3, реальные задания, ключи, матрицы с ответами и приватные owner manifests не должны попадать в Git.** Опубликованные версии и ключи неизменяемы; подготовка и публикация разделены (ARC-01/02/03/06).
