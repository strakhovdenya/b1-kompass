import type { AnswerKeys, ExamQuestion } from '../material/schema';
import type { Selections } from '../answers/save-result';

// What one attempt checks. A short set is a few tasks of one Teil: it gets
// points and a review, never an official level. The level of the full DTZ
// comes with its own scale (P3-T2).
export type AttemptScope = 'short-set' | 'full-exam';

export type QuestionOutcome = 'correct' | 'incorrect' | 'skipped';

export interface ReviewItem {
  questionId: string;
  selectedOptionId: string | null;
  correctOptionId: string;
  outcome: QuestionOutcome;
}

export interface AttemptScore {
  scope: AttemptScope;
  score: number;
  maxScore: number;
  correct: number;
  incorrect: number;
  skipped: number;
  items: ReviewItem[];
}

export interface ScoringInput {
  questions: readonly ExamQuestion[];
  keys: AnswerKeys;
  selections: Selections;
}

export interface ScoringPolicy {
  scope: AttemptScope;
  showsLevel: boolean;
  score(input: ScoringInput): AttemptScore;
}

const ownValue = (
  record: Readonly<Record<string, string>>,
  key: string,
): string | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

const outcomeOf = (
  selectedOptionId: string | null,
  correctOptionId: string,
): QuestionOutcome => {
  if (selectedOptionId === null) return 'skipped';
  return selectedOptionId === correctOptionId ? 'correct' : 'incorrect';
};

// One point per task. Only questions of the version count: an answer to an
// unknown question id is ignored. A question without a key is a material
// error, so scoring stops instead of guessing.
const scoreShortSet = (input: ScoringInput): AttemptScore => {
  const items: ReviewItem[] = [];
  const totals = { correct: 0, incorrect: 0, skipped: 0 };
  for (const question of input.questions) {
    const questionId = question.id;
    const correctOptionId = ownValue(input.keys, questionId);
    if (correctOptionId === undefined) {
      throw new Error(`Answer key is missing for ${questionId}`);
    }
    const selectedOptionId = ownValue(input.selections, questionId) ?? null;
    const outcome = outcomeOf(selectedOptionId, correctOptionId);
    totals[outcome] += 1;
    items.push({ questionId, selectedOptionId, correctOptionId, outcome });
  }
  return {
    scope: 'short-set',
    score: totals.correct,
    maxScore: items.length,
    correct: totals.correct,
    incorrect: totals.incorrect,
    skipped: totals.skipped,
    items,
  };
};

const SHORT_SET_POLICY: ScoringPolicy = {
  scope: 'short-set',
  showsLevel: false,
  score: scoreShortSet,
};

// The policy follows the exam format and the scope of the attempt, not the
// player or the page. Combinations without a scale get no policy.
export const selectScoringPolicy = (
  format: string,
  scope: AttemptScope,
): ScoringPolicy | null => {
  if (format === 'DTZ' && scope === 'short-set') return SHORT_SET_POLICY;
  return null;
};

export const toPercent = (score: number, maxScore: number): number =>
  maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
