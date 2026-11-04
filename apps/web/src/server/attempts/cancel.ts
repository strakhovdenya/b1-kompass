import { z } from 'zod';
import type {
  CancelOutcome,
  CommandResult,
  RunTechnicalFailure,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { toLifecycleState } from './projection';
import { readAttemptRun } from './read';
import { callCancel } from './repository';
import { RULE_FAILURES, confirmationSchema } from './submit';

export type CancelAttemptResult = CommandResult<CancelOutcome>;

// A cancel carries no answers: choices the server has not stored are lost,
// as the confirmation said.
const cancelInput = z.strictObject({
  attemptId: z.uuid(),
  commandId: z.uuid(),
  confirmation: confirmationSchema,
});

type CancelInput = z.infer<typeof cancelInput>;

const fail = (failure: RunTechnicalFailure): CancelAttemptResult => ({
  ok: false,
  failure,
});

const runCancel = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: CancelInput,
): Promise<CancelAttemptResult> => {
  const call = await callCancel(deps, {
    sessionId: guest.sessionId,
    attemptId: input.attemptId,
    commandId: input.commandId,
    confirmation: input.confirmation,
  });
  if (!call.ok) {
    const rule = ruleViolation(call.error);
    const known = rule ? RULE_FAILURES[rule] : undefined;
    if (known) return fail(known);
    throw new Error('Attempt was not cancelled', { cause: call.error });
  }
  const { attemptId } = input;
  const read = await readAttemptRun(deps, guest, attemptId);
  if (read.status !== 'ready') return fail('unavailable');
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  if (!state) return fail('unavailable');
  const recorded = call.row.outcome;
  const outcome = recorded === 'replayed' ? 'accepted' : recorded;
  return { ok: true, result: { outcome, attemptId, state } };
};

// Closes the guest's own active attempt without a result and frees its slot.
// A submitted or closed attempt is not cancelled; the same commandId returns
// the same cancel.
export const cancelAttempt = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<CancelAttemptResult> => {
  const parsed = cancelInput.safeParse(input);
  if (!parsed.success) return fail('invalid-input');
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return fail('session-invalid');
    return await runCancel(deps, guest, parsed.data);
  } catch (error) {
    console.error({ error });
    return fail('unavailable');
  }
};
