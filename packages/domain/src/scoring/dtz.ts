import type { ExamContent, ExamQuestion, Inventory } from '../material/schema';
import type { AttemptScope } from './policy';

// The written part of the DTZ checked here: Hören and Lesen of one exam set.
export const DTZ_FULL_INVENTORY: Inventory = { hoeren: 20, lesen: 25 };

export const DTZ_FULL_MAX_SCORE =
  DTZ_FULL_INVENTORY.hoeren + DTZ_FULL_INVENTORY.lesen;

export type DtzLevel = 'below-A2' | 'A2' | 'B1';

// Lower bounds of the official g.a.s.t. scale for Hören + Lesen (0–45).
const A2_FROM = 20;
const B1_FROM = 33;

// The level follows the integer total; a percentage never decides it.
export const gradeDtzTotal = (total: number): DtzLevel => {
  const isValid =
    Number.isInteger(total) && total >= 0 && total <= DTZ_FULL_MAX_SCORE;
  if (!isValid) throw new RangeError(`DTZ total out of range: ${total}`);
  if (total >= B1_FROM) return 'B1';
  if (total >= A2_FROM) return 'A2';
  return 'below-A2';
};

const countSkill = (
  questions: readonly ExamQuestion[],
  skill: ExamQuestion['skill'],
): number => questions.filter((question) => question.skill === skill).length;

export const isFullDtzInventory = (
  questions: readonly ExamQuestion[],
): boolean =>
  countSkill(questions, 'hoeren') === DTZ_FULL_INVENTORY.hoeren &&
  countSkill(questions, 'lesen') === DTZ_FULL_INVENTORY.lesen;

// The scope of a new attempt follows the published version alone: a DTZ set
// with exactly 20 Hören and 25 Lesen tasks is the full exam, anything else
// is a short set without a level.
export const selectAttemptScope = (
  format: string,
  content: ExamContent,
): AttemptScope =>
  format === 'DTZ' && isFullDtzInventory(content.questions)
    ? 'full-exam'
    : 'short-set';
