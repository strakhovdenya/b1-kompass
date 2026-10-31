import { examContentSchema } from './schema';
import type {
  AnswerKeys,
  ExamContent,
  ExamGroup,
  ExamOption,
  ExamQuestion,
  ExamText,
} from './schema';

// A synthetic set with the structure of the full pilot (20 Hören, 25 Lesen,
// Teil 3 pairs, a Teil 4 shared set, linked Lesen texts, examples) and made-up
// text. Tests use it because the publisher's material and key never enter
// the repository.
export const SYNTHETIC_TRACK_ID = 'track-127';

export interface SyntheticPilot {
  content: ExamContent;
  keys: AnswerKeys;
}

const SOURCE = {
  publisher: 'telc',
  title: 'Auf jeden Fall! B1.2 — Übungstest DTZ',
  url: 'https://example.com/synthetic-pilot.pdf',
  page: 1,
};

const optionsOf = (letters: string): ExamOption[] =>
  [...letters].map((id) => ({ id, text: `Antwort ${id}` }));

const TRUE_FALSE: ExamOption[] = [
  { id: 'a', text: 'Richtig' },
  { id: 'b', text: 'Falsch' },
];

const SHARED_OPTIONS = optionsOf('abcdef');

interface Builder {
  questions: ExamQuestion[];
  keys: Record<string, string>;
  groups: ExamGroup[];
  texts: ExamText[];
}

const addQuestion = (
  builder: Builder,
  skill: 'hoeren' | 'lesen',
  teil: number,
  fields: Pick<ExamQuestion, 'kind' | 'options'> &
    Partial<Pick<ExamQuestion, 'textId'>>,
  key: string,
): string => {
  const number = builder.questions.filter((q) => q.skill === skill).length + 1;
  const id = `${skill}-${number}`;
  const trackId = skill === 'hoeren' ? SYNTHETIC_TRACK_ID : undefined;
  builder.questions.push({
    id,
    number,
    skill,
    teil,
    prompt: `Frage ${number} (${skill} Teil ${teil})?`,
    sourcePage: teil + 1,
    ...(trackId ? { trackId } : {}),
    ...fields,
  });
  builder.keys[id] = key;
  return id;
};

const addHoeren = (builder: Builder) => {
  const single = { kind: 'single-choice' as const, options: optionsOf('abc') };
  for (let i = 0; i < 4; i++) addQuestion(builder, 'hoeren', 1, single, 'b');
  for (let i = 0; i < 5; i++) addQuestion(builder, 'hoeren', 2, single, 'c');
  for (let i = 0; i < 4; i++) {
    const trueFalse = { kind: 'true-false' as const, options: TRUE_FALSE };
    const first = addQuestion(builder, 'hoeren', 3, trueFalse, 'a');
    const second = addQuestion(builder, 'hoeren', 3, single, 'a');
    builder.groups.push({
      id: `hoeren-paar-${i + 1}`,
      kind: 'pair',
      teil: 3,
      trackId: SYNTHETIC_TRACK_ID,
      questionIds: [first, second],
    });
  }
  const shared = { kind: 'shared-choice' as const, options: SHARED_OPTIONS };
  const questionIds = ['b', 'd', 'e'].map((key) =>
    addQuestion(builder, 'hoeren', 4, shared, key),
  );
  builder.groups.push({
    id: 'hoeren-teil-4',
    kind: 'shared-set',
    teil: 4,
    trackId: SYNTHETIC_TRACK_ID,
    options: SHARED_OPTIONS,
    questionIds,
  });
};

const LESEN_TEILE = [5, 5, 7, 8];

const addLesen = (builder: Builder) => {
  LESEN_TEILE.forEach((count, index) => {
    const teil = index + 1;
    const textId = `lesen-text-${teil}`;
    builder.texts.push({
      id: textId,
      title: `Text zu Teil ${teil}`,
      body: `Erfundener Lesetext zu Teil ${teil}.`,
      sourcePage: teil + 4,
    });
    for (let i = 0; i < count; i++) {
      const fields = {
        kind: 'single-choice' as const,
        options: optionsOf('abc'),
      };
      addQuestion(builder, 'lesen', teil, { ...fields, textId }, 'a');
    }
  });
};

export const buildSyntheticPilot = (): SyntheticPilot => {
  const builder: Builder = { questions: [], keys: {}, groups: [], texts: [] };
  addHoeren(builder);
  addLesen(builder);
  const content = examContentSchema.parse({
    source: SOURCE,
    questions: builder.questions,
    examples: [
      {
        id: 'beispiel-hoeren-3',
        skill: 'hoeren',
        teil: 3,
        prompt: 'Beispiel: Sie hören eine Besprechung zwischen Kollegen.',
        options: TRUE_FALSE,
        solutionOptionId: 'a',
        trackId: SYNTHETIC_TRACK_ID,
        sourcePage: 3,
      },
    ],
    texts: builder.texts,
    groups: builder.groups,
  });
  return { content, keys: builder.keys };
};
