import { z } from 'zod';
import { selectScoringPolicy, toPercent } from '@b1k/domain';
import type {
  AttemptReview,
  AttemptScope,
  ExamContent,
  ReviewResult,
  ScoringPolicy,
  Selections,
  SkillTotals,
} from '@b1k/domain';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import { parseAssignment } from './projection';
import { finalizeSubmitted, parseFrozen } from './reconcile';
import {
  findExamById,
  readAnswerKeys,
  readOwnedAttempt,
  readResult,
  readRun,
  readStoredAnswers,
  readVersionOfExam,
} from './repository';
import type { ResultRow, RunRow } from './repository';

// The review of a completed attempt exists only for its owner. A new
// completion is reviewed from its frozen snapshot; a legacy completion (M1
// and the old finish) from its stored answers. Both show the stored result
// as it is. The only write on this path is the completion of a submitted
// attempt (reconcile.ts): its result is computed once from the snapshot; a
// completed or legacy result is never scored again.

export interface VersionMaterial {
  format: string;
  content: ExamContent;
}

export const policyFor = (
  material: VersionMaterial,
  scope: AttemptScope,
): ScoringPolicy => {
  const policy = selectScoringPolicy(material.format, scope);
  if (!policy) {
    throw new Error(`No scoring policy for ${material.format} ${scope}`);
  }
  return policy;
};

const storedSkills = (row: ResultRow): SkillTotals | null => {
  const { hoeren_score, hoeren_max, lesen_score, lesen_max } = row;
  if (hoeren_score === null || hoeren_max === null) return null;
  if (lesen_score === null || lesen_max === null) return null;
  return {
    hoeren: { score: hoeren_score, maxScore: hoeren_max },
    lesen: { score: lesen_score, maxScore: lesen_max },
  };
};

// Results stored before the percentage column have none; the same rounding
// gives their value.
const storedPercent = (row: ResultRow): number =>
  row.percent === null
    ? toPercent(row.score, row.max_score)
    : Number(row.percent);

// The answers a completed attempt is reviewed with: its frozen snapshot, or
// the stored answers of a legacy completion. A new completion without a
// usable snapshot has none: it is an error, never a fallback.
export const reviewedSelections = (
  run: RunRow,
  stored: Selections,
): Selections | null => {
  if (run.frozenAnswers !== null) return parseFrozen(run.frozenAnswers);
  return run.legacyCompleted ? stored : null;
};

export interface ReviewTarget {
  id: string;
  versionId: string;
  questionIds: readonly string[];
}

// Stored totals plus the per-task view of the assigned tasks against the
// key of the pinned version.
export const buildReview = async (
  deps: ServerDeps,
  attempt: ReviewTarget,
  material: VersionMaterial,
  selections: Selections,
): Promise<AttemptReview> => {
  const [result, keys] = await Promise.all([
    readResult(deps, attempt.id),
    readAnswerKeys(deps, attempt.versionId),
  ]);
  if (!result) throw new Error(`Attempt ${attempt.id} has no result`);
  const assigned = new Set(attempt.questionIds);
  const questions = material.content.questions.filter((question) =>
    assigned.has(question.id),
  );
  const policy = policyFor(material, result.scope);
  const scored = policy.score({ questions, keys, selections });
  return {
    attemptId: attempt.id,
    scope: result.scope,
    showsLevel: policy.showsLevel,
    score: result.score,
    maxScore: result.max_score,
    percent: storedPercent(result),
    correct: result.correct_count,
    incorrect: result.incorrect_count,
    skipped: result.skipped_count,
    skills: storedSkills(result),
    level: result.level,
    completedAt: result.computed_at,
    items: scored.items,
  };
};

const attemptInput = z.strictObject({ attemptId: z.uuid() });

// The review of the guest's own attempt. A submitted attempt is completed
// first; an active or a foreign attempt gives no key.
export const getAttemptReview = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<ReviewResult> => {
  const parsed = attemptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return { ok: false, error: 'session-invalid' };
    const { attemptId } = parsed.data;
    let attempt = await readOwnedAttempt(deps, guest.sessionId, attemptId);
    if (!attempt) return { ok: false, error: 'attempt-not-found' };
    const run = await readRun(deps, attempt.id);
    if (!run) return { ok: false, error: 'unavailable' };
    if (attempt.status === 'submitted') {
      await finalizeSubmitted(deps, guest.sessionId, attempt, run);
      attempt = await readOwnedAttempt(deps, guest.sessionId, attemptId);
      if (!attempt) return { ok: false, error: 'attempt-not-found' };
    }
    if (attempt.status !== 'completed') {
      return { ok: false, error: 'not-completed' };
    }
    const questionIds = parseAssignment(run.assignment, attempt.examVersionId);
    const [exam, version, stored] = await Promise.all([
      findExamById(deps, attempt.examId),
      readVersionOfExam(deps, attempt.examId, attempt.examVersionId),
      readStoredAnswers(deps, attempt.id),
    ]);
    const selections = reviewedSelections(run, stored.selections);
    if (!questionIds || !exam || !version || !selections) {
      console.error({ error: `Attempt ${attempt.id} cannot be reviewed` });
      return { ok: false, error: 'unavailable' };
    }
    const material = { format: exam.format, content: version.content };
    const target = { id: attempt.id, versionId: version.id, questionIds };
    const review = await buildReview(deps, target, material, selections);
    return { ok: true, review };
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};
