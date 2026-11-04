import { z } from 'zod';
import type {
  CommandResult,
  RunTechnicalFailure,
  SubmitOutcome,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { toLifecycleState } from './projection';
import { readAttemptRun } from './read';
import { finalizeSubmitted } from './reconcile';
import { callAcceptSubmission, readOwnedAttempt, readRun } from './repository';

export type SubmitAttemptResult = CommandResult<SubmitOutcome>;

// More than any assignment holds; the database checks the exact set.
export const MAX_FINAL_ANSWERS = 200;

export const finalAnswerSchema = z.strictObject({
  questionId: z.string().min(1).max(100),
  optionId: z.string().min(1).max(10),
  revision: z.int().min(1).max(2_147_483_647),
});

export const confirmationSchema = z.strictObject({
  phaseRevision: z.int().min(0).max(1000),
  skipped: z.int().min(0).max(1000),
});

// The final answers include choices the autosave has not confirmed. Unknown
// fields such as owner, score, status or a time are rejected, not ignored.
const submitInput = z.strictObject({
  attemptId: z.uuid(),
  commandId: z.uuid(),
  answers: z.array(finalAnswerSchema).max(MAX_FINAL_ANSWERS),
  confirmation: confirmationSchema,
});

type SubmitInput = z.infer<typeof submitInput>;

export const RULE_FAILURES: Readonly<Record<string, RunTechnicalFailure>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'not-found',
  submission_invalid: 'invalid-input',
  cancel_invalid: 'invalid-input',
  question_not_assigned: 'invalid-input',
  option_not_allowed: 'invalid-input',
  command_mismatch: 'invalid-input',
  mode_not_enabled: 'not-enabled',
};

const fail = (failure: RunTechnicalFailure): SubmitAttemptResult => ({
  ok: false,
  failure,
});

// A business outcome with the actual state of the attempt.
const withState = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
  outcome: 'result-pending' | 'conflict' | 'stale-confirmation',
): Promise<SubmitAttemptResult> => {
  const read = await readAttemptRun(deps, guest, attemptId);
  if (read.status !== 'ready') return fail('unavailable');
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  if (!state) return fail('unavailable');
  return { ok: true, result: { outcome, attemptId, state } };
};

// The accepted submission is completed when its result can be computed;
// otherwise it stays submitted and the result is pending.
const settle = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
): Promise<SubmitAttemptResult> => {
  const [attempt, run] = await Promise.all([
    readOwnedAttempt(deps, guest.sessionId, attemptId),
    readRun(deps, attemptId),
  ]);
  if (!attempt || !run) return fail('unavailable');
  const outcome = await finalizeSubmitted(deps, guest.sessionId, attempt, run);
  if (outcome === 'completed') {
    return { ok: true, result: { outcome: 'result-ready', attemptId } };
  }
  return withState(deps, guest, attemptId, 'result-pending');
};

const runSubmit = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: SubmitInput,
): Promise<SubmitAttemptResult> => {
  const call = await callAcceptSubmission(deps, {
    sessionId: guest.sessionId,
    attemptId: input.attemptId,
    commandId: input.commandId,
    answers: input.answers,
    confirmation: input.confirmation,
  });
  if (!call.ok) {
    const rule = ruleViolation(call.error);
    const known = rule ? RULE_FAILURES[rule] : undefined;
    if (known) return fail(known);
    throw new Error('Submission was not accepted', { cause: call.error });
  }
  const { outcome } = call.row;
  if (outcome === 'accepted' || outcome === 'replayed') {
    return settle(deps, guest, input.attemptId);
  }
  return withState(deps, guest, input.attemptId, outcome);
};

// The final submission of the guest's own active attempt. The answers are
// accepted and frozen in one transaction before any scoring; the same
// commandId returns the same submission, also after a lost answer.
export const submitAttempt = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SubmitAttemptResult> => {
  const parsed = submitInput.safeParse(input);
  if (!parsed.success) return fail('invalid-input');
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return fail('session-invalid');
    return await runSubmit(deps, guest, parsed.data);
  } catch (error) {
    console.error({ error });
    return fail('unavailable');
  }
};
