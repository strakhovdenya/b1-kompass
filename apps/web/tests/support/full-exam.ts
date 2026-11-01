import { SYNTHETIC_TRACK_ID, buildSyntheticPilot } from '@b1k/domain';

// A test-only full DTZ set (20 Hören, 25 Lesen) with made-up text and key,
// published next to the pilot short set and served by its own e2e server
// (PRACTICE_EXAM_SLUG), so that attempts there get the full-exam scope.
export const FULL_EXAM = {
  slug: 'test-full-dtz',
  title: 'Test — DTZ Hören und Lesen',
  format: 'DTZ',
} as const;

export const FULL_TRACK_ID = SYNTHETIC_TRACK_ID;

export const FULL_PILOT = buildSyntheticPilot();

export const fullKeyOf = (questionId: string): string => {
  const key = FULL_PILOT.keys[questionId];
  if (key === undefined) throw new Error(`no key for ${questionId}`);
  return key;
};

// An option of the task other than its key: a wrong answer.
export const fullWrongOf = (questionId: string): string => {
  const question = FULL_PILOT.content.questions.find(
    (item) => item.id === questionId,
  );
  const key = fullKeyOf(questionId);
  const wrong = question?.options.find((option) => option.id !== key);
  if (!wrong) throw new Error(`no wrong option for ${questionId}`);
  return wrong.id;
};
