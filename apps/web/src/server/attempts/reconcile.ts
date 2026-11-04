import { z } from 'zod';
import {
  ATTEMPT_PURPOSES,
  ATTEMPT_SELECTIONS,
  scoreAssignment,
} from '@b1k/domain';
import type { AssignmentScoreResult, Selections } from '@b1k/domain';
import type { ServerDeps } from '../db';
import { parseAssignment } from './projection';
import {
  callFinalize,
  findExamById,
  readAnswerKeys,
  readVersionOfExam,
} from './repository';
import type { AttemptRow, RunRow } from './repository';

// The second step after an accepted submission: the result is computed by
// @b1k/domain from the frozen snapshot and the closed key, and stored by the
// finalize of the database, which checks it again. It is a separate step: a
// failure leaves the attempt submitted, its slot free and its snapshot
// unchanged, and any later status, review or repeated submit tries again.

export type ReconcileOutcome = 'completed' | 'result-error';

const frozenSchema = z.record(
  z.string().min(1).max(100),
  z.strictObject({
    optionId: z.string().min(1).max(10),
    revision: z.int().min(1),
  }),
);

// The answers of a frozen snapshot; null when the snapshot is not usable.
export const parseFrozen = (stored: unknown): Selections | null => {
  const parsed = frozenSchema.safeParse(stored);
  if (!parsed.success) return null;
  const selections: Record<string, string> = {};
  for (const [questionId, answer] of Object.entries(parsed.data)) {
    selections[questionId] = answer.optionId;
  }
  return selections;
};

const selectionOf = (value: string) =>
  ATTEMPT_SELECTIONS.find((selection) => selection === value);

const purposeOf = (value: string) =>
  ATTEMPT_PURPOSES.find((purpose) => purpose === value);

const scoreFrozen = async (
  deps: ServerDeps,
  attempt: AttemptRow,
  run: RunRow,
): Promise<AssignmentScoreResult | null> => {
  const questionIds = parseAssignment(run.assignment, attempt.examVersionId);
  const selections = parseFrozen(run.frozenAnswers);
  const selection = selectionOf(run.selection);
  const purpose = purposeOf(run.purpose);
  if (!questionIds || !selections || !selection || !purpose) return null;
  const [exam, version, keys] = await Promise.all([
    findExamById(deps, attempt.examId),
    readVersionOfExam(deps, attempt.examId, attempt.examVersionId),
    readAnswerKeys(deps, attempt.examVersionId),
  ]);
  if (!exam || !version) return null;
  const assignment = {
    format: exam.format,
    versionId: version.id,
    scope: attempt.scope,
    selection,
    purpose,
    questionIds,
    contextIds: [],
  };
  return scoreAssignment({
    assignment,
    versionId: version.id,
    content: version.content,
    keys,
    selections,
  });
};

// Completes the guest's own submitted attempt from its frozen snapshot. A
// completed attempt stays as it is. Any failure is reported as result-error
// and logged; it never changes the snapshot or reopens the attempt.
export const finalizeSubmitted = async (
  deps: ServerDeps,
  sessionId: string,
  attempt: AttemptRow,
  run: RunRow,
): Promise<ReconcileOutcome> => {
  if (attempt.status === 'completed') return 'completed';
  try {
    const scored = await scoreFrozen(deps, attempt, run);
    if (!scored?.ok) {
      const reason = scored ? scored.error : 'snapshot-unusable';
      console.error({ error: `Result of ${attempt.id} failed: ${reason}` });
      return 'result-error';
    }
    const call = await callFinalize(deps, {
      sessionId,
      attemptId: attempt.id,
      score: scored.score,
    });
    if (call.ok) return 'completed';
    console.error({ error: call.error });
    return 'result-error';
  } catch (error) {
    console.error({ error });
    return 'result-error';
  }
};
