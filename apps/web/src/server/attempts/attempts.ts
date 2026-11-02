import { z } from 'zod';
import { attemptProgressSchema, examContentSchema } from '@b1k/domain';
import type {
  AnswerKeys,
  FinishAttemptError,
  FinishAttemptResult,
  ReviewResult,
  SaveAnswerError,
  SaveAnswerResult,
  SaveProgressError,
  SaveProgressResult,
  Selections,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { buildReview, policyFor, readAnswerKeys } from './read';
import type { VersionMaterial } from './read';
import { readOwnedAttempt, readStoredAnswers } from './repository';
import type { AttemptRow } from './repository';

// The compatible facade of attempts. Reading and the explicit start live in
// read.ts and start.ts; this module keeps the answer, progress, finish and
// review commands that later tasks replace.
export {
  findOwnedActive,
  readAttemptPage,
  readAttemptRun,
  readExamChoice,
} from './read';
export type { AttemptPageResult, ExamChoice, RunReadResult } from './read';
export { startAttempt } from './start';
export type { StartAttemptResult } from './start';
export type { AttemptRunView, PracticeState } from './projection';

// Unknown fields such as role, owner or score are rejected, not ignored.
const saveAnswerInput = z.strictObject({
  attemptId: z.uuid(),
  questionId: z.string().min(1).max(100),
  optionId: z.string().min(1).max(10),
  revision: z.int().min(1).max(2_147_483_647),
});

const saveProgressInput = z.strictObject({
  attemptId: z.uuid(),
  progress: attemptProgressSchema,
});

const attemptInput = z.strictObject({ attemptId: z.uuid() });

const RULE_ERRORS: Readonly<Record<string, SaveAnswerError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  option_not_allowed: 'option-not-allowed',
  revision_invalid: 'invalid-input',
};

const PROGRESS_RULE_ERRORS: Readonly<Record<string, SaveProgressError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  progress_not_allowed: 'progress-not-allowed',
};

const FINISH_RULE_ERRORS: Readonly<Record<string, FinishAttemptError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  // A cancelled attempt (for example an M1 duplicate) is closed for good.
  attempt_cancelled: 'attempt-not-found',
};

// Overlapping saves can change the answers between scoring and completion;
// the database then refuses and the server scores again.
const FINISH_ROUNDS = 3;

interface AnswerRow {
  question_id: string;
  option_id: string;
  revision: number;
  updated_at: string;
}

const readSelections = async (
  deps: ServerDeps,
  attemptId: string,
): Promise<Selections> => (await readStoredAnswers(deps, attemptId)).selections;

const readVersionMaterial = async (
  deps: ServerDeps,
  versionId: string,
): Promise<VersionMaterial> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select('content, exams!inner(format)')
    .eq('id', versionId)
    .single<{ content: unknown; exams: { format: string } }>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  return {
    format: data.exams.format,
    content: examContentSchema.parse(data.content),
  };
};

const reviewOf = (
  deps: ServerDeps,
  attempt: AttemptRow,
  material: VersionMaterial,
  selections: Selections,
) =>
  buildReview(
    deps,
    { id: attempt.id, versionId: attempt.examVersionId },
    material,
    selections,
  );

export const saveProgress = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SaveProgressResult> => {
  const parsed = saveProgressInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  const { attemptId, progress } = parsed.data;
  const { error } = await deps.db.rpc('save_attempt_progress', {
    p_session_id: guest.sessionId,
    p_attempt_id: attemptId,
    p_progress: progress,
    p_now: deps.clock.now().toISOString(),
  });
  if (error) {
    const rule = ruleViolation(error);
    const known = rule ? PROGRESS_RULE_ERRORS[rule] : undefined;
    if (known) return { ok: false, error: known };
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
  return { ok: true, progress };
};

// The database returns the stored answer. It is this request's choice when
// the revision and the option match: a new write or a repeat of the same
// request. A higher stored revision means the request is stale; the same
// revision with another option is a conflict. Neither is a confirmation;
// both return the stored answer.
const settleSave = (
  stored: AnswerRow,
  optionId: string,
  revision: number,
): SaveAnswerResult => {
  const current = { optionId: stored.option_id, revision: stored.revision };
  if (stored.revision > revision) {
    return { ok: false, error: 'stale', ...current };
  }
  if (stored.option_id !== optionId) {
    return { ok: false, error: 'conflict', ...current };
  }
  return {
    ok: true,
    questionId: stored.question_id,
    optionId: stored.option_id,
    revision: stored.revision,
    savedAt: stored.updated_at,
  };
};

export const saveAnswer = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SaveAnswerResult> => {
  const parsed = saveAnswerInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  const { attemptId, questionId, optionId, revision } = parsed.data;
  const { data, error } = await deps.db
    .rpc('save_attempt_answer', {
      p_session_id: guest.sessionId,
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_option_id: optionId,
      p_revision: revision,
      p_now: deps.clock.now().toISOString(),
    })
    .single<AnswerRow>();
  if (error) {
    const rule = ruleViolation(error);
    const known = rule ? RULE_ERRORS[rule] : undefined;
    if (known) return { ok: false, error: known };
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
  return settleSave(data, optionId, revision);
};

type FinishRound =
  | { status: 'done' }
  | { status: 'answers-changed' }
  | { status: 'failed'; error: FinishAttemptError };

// One round: score the stored answers with the policy of the attempt and ask
// the database to complete it with exactly those answers.
const finishRound = async (
  deps: ServerDeps,
  guest: GuestContext,
  attempt: AttemptRow,
  material: VersionMaterial,
  keys: AnswerKeys,
): Promise<FinishRound> => {
  const policy = policyFor(material, attempt.scope);
  const selections = await readSelections(deps, attempt.id);
  const scored = policy.score({
    questions: material.content.questions,
    keys,
    selections,
  });
  const { error } = await deps.db
    .rpc('finish_attempt', {
      p_session_id: guest.sessionId,
      p_attempt_id: attempt.id,
      p_now: deps.clock.now().toISOString(),
      p_scope: scored.scope,
      p_scored_answers: selections,
      p_score: scored.score,
      p_max_score: scored.maxScore,
      p_correct: scored.correct,
      p_incorrect: scored.incorrect,
      p_skipped: scored.skipped,
      p_percent: scored.percent,
      p_hoeren_score: scored.skills?.hoeren.score ?? null,
      p_hoeren_max: scored.skills?.hoeren.maxScore ?? null,
      p_lesen_score: scored.skills?.lesen.score ?? null,
      p_lesen_max: scored.skills?.lesen.maxScore ?? null,
      p_level: scored.level,
    })
    .single();
  if (!error) return { status: 'done' };
  const rule = ruleViolation(error);
  if (rule === 'answers_changed') return { status: 'answers-changed' };
  const known = rule ? FINISH_RULE_ERRORS[rule] : undefined;
  if (known) return { status: 'failed', error: known };
  throw new Error('Attempt was not finished', { cause: error });
};

// Completes the guest's own attempt and returns its review. The score is
// computed here from the stored answers and the closed key; repeating the
// call returns the same, already stored result.
export const finishAttempt = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<FinishAttemptResult> => {
  const parsed = attemptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  try {
    const attempt = await readOwnedAttempt(
      deps,
      guest.sessionId,
      parsed.data.attemptId,
    );
    if (!attempt) return { ok: false, error: 'attempt-not-found' };
    const [material, keys] = await Promise.all([
      readVersionMaterial(deps, attempt.examVersionId),
      readAnswerKeys(deps, attempt.examVersionId),
    ]);
    for (let round = 0; round < FINISH_ROUNDS; round++) {
      const outcome = await finishRound(deps, guest, attempt, material, keys);
      if (outcome.status === 'failed')
        return { ok: false, error: outcome.error };
      if (outcome.status === 'done') {
        // Another finish may have won the lock: review the frozen answers.
        const frozen = await readSelections(deps, attempt.id);
        const review = await reviewOf(deps, attempt, material, frozen);
        return { ok: true, review };
      }
    }
    return { ok: false, error: 'unavailable' };
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};

// The review exists only for the owner and only after completion: an active
// or a foreign attempt gives no key.
export const getAttemptReview = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<ReviewResult> => {
  const parsed = attemptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  try {
    const attempt = await readOwnedAttempt(
      deps,
      guest.sessionId,
      parsed.data.attemptId,
    );
    if (!attempt) return { ok: false, error: 'attempt-not-found' };
    if (attempt.status !== 'completed') {
      return { ok: false, error: 'not-completed' };
    }
    const [material, selections] = await Promise.all([
      readVersionMaterial(deps, attempt.examVersionId),
      readSelections(deps, attempt.id),
    ]);
    const review = await reviewOf(deps, attempt, material, selections);
    return { ok: true, review };
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};
