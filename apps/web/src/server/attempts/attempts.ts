import { z } from 'zod';
import { attemptProgressSchema } from '@b1k/domain';
import type {
  SaveAnswerError,
  SaveAnswerResult,
  SaveProgressError,
  SaveProgressResult,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import { callSaveAnswer, callSaveProgress } from './repository';
import type { AnswerRecord } from './repository';

// The facade of attempts. Reading and status live in read.ts, the explicit
// start in start.ts, the submission in submit.ts, the cancel in cancel.ts,
// the completion of a submitted attempt in reconcile.ts and the review in
// review.ts; this module keeps the saves of answers and of the place.
export {
  findOwnedActive,
  readAttemptPage,
  readAttemptRun,
  readAttemptStatus,
  readExamChoice,
} from './read';
export type { AttemptPageResult, ExamChoice, RunReadResult } from './read';
export { preflightTimedStart, startAttempt } from './start';
export type { StartAttemptResult, TimedStartVerdict } from './start';
export { submitAttempt } from './submit';
export type { SubmitAttemptResult } from './submit';
export { cancelAttempt } from './cancel';
export type { CancelAttemptResult } from './cancel';
export { getAttemptReview } from './review';
export type { AttemptRunView, PracticeState } from './projection';

// Unknown fields such as role, owner, score or a time are rejected, not
// ignored.
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

const RULE_ERRORS: Readonly<Record<string, SaveAnswerError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  question_not_assigned: 'option-not-allowed',
  option_not_allowed: 'option-not-allowed',
  revision_invalid: 'invalid-input',
  // The deadline of a timed run is reached: nothing is written any more.
  phase_closed: 'attempt-not-found',
};

const PROGRESS_RULE_ERRORS: Readonly<Record<string, SaveProgressError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  progress_not_allowed: 'progress-not-allowed',
  phase_closed: 'attempt-not-found',
};

export const saveProgress = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SaveProgressResult> => {
  const parsed = saveProgressInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return { ok: false, error: 'session-invalid' };
    const { attemptId, progress } = parsed.data;
    const call = await callSaveProgress(deps, {
      sessionId: guest.sessionId,
      attemptId,
      progress,
    });
    if (!call.ok) {
      const rule = ruleViolation(call.error);
      const known = rule ? PROGRESS_RULE_ERRORS[rule] : undefined;
      if (known) return { ok: false, error: known };
      console.error({ error: call.error });
      return { ok: false, error: 'unavailable' };
    }
    return { ok: true, progress };
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};

// The database returns the stored answer. It is this request's choice when
// the revision and the option match: a new write or a repeat of the same
// request. A higher stored revision means the request is stale; the same
// revision with another option is a conflict. Neither is a confirmation;
// both return the stored answer.
const settleSave = (
  stored: AnswerRecord,
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

// One answer of an assigned task of the guest's own active attempt. The
// database checks the guest again after the row lock, with its own clock.
export const saveAnswer = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SaveAnswerResult> => {
  const parsed = saveAnswerInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return { ok: false, error: 'session-invalid' };
    const { attemptId, questionId, optionId, revision } = parsed.data;
    const call = await callSaveAnswer(deps, {
      sessionId: guest.sessionId,
      attemptId,
      questionId,
      optionId,
      revision,
    });
    if (!call.ok) {
      const rule = ruleViolation(call.error);
      const known = rule ? RULE_ERRORS[rule] : undefined;
      if (known) return { ok: false, error: known };
      console.error({ error: call.error });
      return { ok: false, error: 'unavailable' };
    }
    return settleSave(call.row, optionId, revision);
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};
