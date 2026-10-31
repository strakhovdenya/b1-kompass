import { examContentSchema } from '@b1k/domain';

// A test-only exam with one Teil 3 pair, published next to the pilot short set
// and served by a second e2e server (PRACTICE_EXAM_SLUG), so that the specs
// of the short set keep their four questions.
export const PAIR_EXAM = {
  slug: 'test-hoeren-pair',
  title: 'Test — Hören Teil 3',
  format: 'DTZ',
} as const;

export const PAIR_TRACK_ID = 'hoeren-pair-track';

export const PAIR_PROMPTS = {
  trueFalse: 'Der Mann spricht mit der Lehrerin der Kinder.',
  choice: 'Was möchte der Mann?',
} as const;

export const PAIR_CONTENT = examContentSchema.parse({
  source: {
    publisher: 'test',
    title: 'Synthetic pair',
    url: 'https://example.com/pair.pdf',
    page: 1,
  },
  questions: [
    {
      id: 'pair-1',
      number: 1,
      kind: 'true-false',
      skill: 'hoeren',
      teil: 3,
      prompt: PAIR_PROMPTS.trueFalse,
      options: [
        { id: 'a', text: 'Richtig' },
        { id: 'b', text: 'Falsch' },
      ],
      trackId: PAIR_TRACK_ID,
    },
    {
      id: 'pair-2',
      number: 2,
      kind: 'single-choice',
      skill: 'hoeren',
      teil: 3,
      prompt: PAIR_PROMPTS.choice,
      options: [
        { id: 'a', text: 'Einen Termin absagen.' },
        { id: 'b', text: 'Einen neuen Termin vereinbaren.' },
        { id: 'c', text: 'Die Adresse erfragen.' },
      ],
      trackId: PAIR_TRACK_ID,
    },
  ],
  groups: [
    {
      id: 'pair-group-1',
      kind: 'pair',
      teil: 3,
      trackId: PAIR_TRACK_ID,
      questionIds: ['pair-1', 'pair-2'],
    },
  ],
});

// Test key: richtig, b.
export const PAIR_KEYS = { 'pair-1': 'a', 'pair-2': 'b' } as const;
