import type { AnswerKeys, ExamQuestion } from '../material/schema';
import type { Selections } from '../answers/save-result';
import { DTZ_FULL_INVENTORY, gradeDtzTotal, isFullDtzInventory } from './dtz';
import type { DtzLevel } from './dtz';

// What one attempt checks. A short set is any other composition of tasks: it
// gets points and a review, never an official level. The full exam is the
// whole Hören and Lesen block of one DTZ set and gets the g.a.s.t. level.
export type AttemptScope = 'short-set' | 'full-exam';

export type QuestionOutcome = 'correct' | 'incorrect' | 'skipped';

export interface ReviewItem {
  questionId: string;
  selectedOptionId: string | null;
  correctOptionId: string;
  outcome: QuestionOutcome;
}

export interface SkillScore {
  score: number;
  maxScore: number;
}

export interface SkillTotals {
  hoeren: SkillScore;
  lesen: SkillScore;
}

export interface AttemptScore {
  scope: AttemptScope;
  score: number;
  maxScore: number;
  percent: number;
  correct: number;
  incorrect: number;
  skipped: number;
  // Only the full exam has totals per skill and a level.
  skills: SkillTotals | null;
  level: DtzLevel | null;
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

interface ScoredItems {
  items: ReviewItem[];
  correct: number;
  incorrect: number;
  skipped: number;
}

// One point per task. Only questions of the version count: an answer to an
// unknown question id is ignored. A question without a key is a material
// error, so scoring stops instead of guessing.
const scoreItems = (
  questions: readonly ExamQuestion[],
  input: ScoringInput,
): ScoredItems => {
  const scored: ScoredItems = {
    items: [],
    correct: 0,
    incorrect: 0,
    skipped: 0,
  };
  for (const question of questions) {
    const questionId = question.id;
    const correctOptionId = ownValue(input.keys, questionId);
    if (correctOptionId === undefined) {
      throw new Error(`Answer key is missing for ${questionId}`);
    }
    const selectedOptionId = ownValue(input.selections, questionId) ?? null;
    const outcome = outcomeOf(selectedOptionId, correctOptionId);
    scored[outcome] += 1;
    scored.items.push({
      questionId,
      selectedOptionId,
      correctOptionId,
      outcome,
    });
  }
  return scored;
};

const scoreShortSet = (input: ScoringInput): AttemptScore => {
  const { items, correct, incorrect, skipped } = scoreItems(
    input.questions,
    input,
  );
  return {
    scope: 'short-set',
    score: correct,
    maxScore: items.length,
    percent: toPercent(correct, items.length),
    correct,
    incorrect,
    skipped,
    skills: null,
    level: null,
    items,
  };
};

const skillScore = (
  input: ScoringInput,
  items: readonly ReviewItem[],
  skill: ExamQuestion['skill'],
): SkillScore => {
  const ids = new Set(
    input.questions.filter((q) => q.skill === skill).map((q) => q.id),
  );
  const own = items.filter((item) => ids.has(item.questionId));
  const score = own.filter((item) => item.outcome === 'correct').length;
  return { score, maxScore: own.length };
};

// The whole Hören + Lesen block: 20 + 25 tasks, one point each. Any other
// composition or a missing key refuses the score, so no level is ever given
// for an incomplete set.
const scoreFullExam = (input: ScoringInput): AttemptScore => {
  if (!isFullDtzInventory(input.questions)) {
    const expected = `${DTZ_FULL_INVENTORY.hoeren}+${DTZ_FULL_INVENTORY.lesen}`;
    throw new Error(`Full DTZ needs ${expected} Hören and Lesen tasks`);
  }
  const { items, correct, incorrect, skipped } = scoreItems(
    input.questions,
    input,
  );
  const skills = {
    hoeren: skillScore(input, items, 'hoeren'),
    lesen: skillScore(input, items, 'lesen'),
  };
  return {
    scope: 'full-exam',
    score: correct,
    maxScore: items.length,
    percent: toPercent(correct, items.length),
    correct,
    incorrect,
    skipped,
    skills,
    level: gradeDtzTotal(correct),
    items,
  };
};

const SHORT_SET_POLICY: ScoringPolicy = {
  scope: 'short-set',
  showsLevel: false,
  score: scoreShortSet,
};

const FULL_EXAM_POLICY: ScoringPolicy = {
  scope: 'full-exam',
  showsLevel: true,
  score: scoreFullExam,
};

const DTZ_POLICIES: Readonly<Record<AttemptScope, ScoringPolicy>> = {
  'short-set': SHORT_SET_POLICY,
  'full-exam': FULL_EXAM_POLICY,
};

// The policy follows the exam format and the scope of the attempt, not the
// player or the page. Only the DTZ has a scale here: the Austrian DTÖ and any
// other format get no policy.
export const selectScoringPolicy = (
  format: string,
  scope: AttemptScope,
): ScoringPolicy | null => {
  if (format !== 'DTZ') return null;
  return Object.hasOwn(DTZ_POLICIES, scope) ? DTZ_POLICIES[scope] : null;
};

// Percentage of points with one decimal place; it never decides a level.
export const toPercent = (score: number, maxScore: number): number =>
  maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;
