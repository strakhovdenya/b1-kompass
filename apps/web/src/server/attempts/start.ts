import { z } from 'zod';
import {
  ATTEMPT_MODES,
  ATTEMPT_PURPOSES,
  ATTEMPT_SELECTIONS,
  buildAssignment,
} from '@b1k/domain';
import type {
  CommandResult,
  RunTechnicalFailure,
  StartOutcome,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { readAttemptRun } from './read';
import { toLifecycleState } from './projection';
import { callStart, findExamBySlug, readVersionOfExam } from './repository';

export type StartAttemptResult = CommandResult<StartOutcome>;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The full start contract. Unknown fields such as owner, score, status or a
// time are rejected, not ignored; the version is a consistency check of the
// prepared choice, not a choice of the client.
const startInput = z.strictObject({
  commandId: z.uuid(),
  examSlug: z.string().max(100).regex(SLUG_PATTERN),
  mode: z.enum(ATTEMPT_MODES),
  purpose: z.enum(ATTEMPT_PURPOSES),
  selection: z.enum(ATTEMPT_SELECTIONS),
  sourceAttemptId: z.uuid().nullable(),
  expectedVersionId: z.uuid(),
});

type StartInput = z.infer<typeof startInput>;

// The capabilities are switched on in order: this release starts the free
// training of the whole set or of one skill. Timed modes and the repeat of
// errors answer not-enabled before anything is written. The tasks are
// assigned from the pinned version, never taken from the client.
const isEnabled = (input: StartInput): boolean =>
  input.mode === 'training' &&
  input.purpose === 'normal' &&
  input.sourceAttemptId === null;

const RULE_FAILURES: Readonly<Record<string, RunTechnicalFailure>> = {
  guest_session_invalid: 'session-invalid',
  command_mismatch: 'invalid-input',
  start_invalid: 'invalid-input',
  assignment_invalid: 'invalid-input',
  // The prepared choice is no longer the latest version: the choice is read
  // again before a new start.
  version_changed: 'not-found',
};

const fail = (failure: RunTechnicalFailure): StartAttemptResult => ({
  ok: false,
  failure,
});

const runStart = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
): Promise<StartAttemptResult> => {
  const exam = await findExamBySlug(deps, input.examSlug);
  if (!exam) return fail('not-found');
  const version = await readVersionOfExam(
    deps,
    exam.id,
    input.expectedVersionId,
  );
  if (!version) return fail('not-found');
  const built = buildAssignment({
    format: exam.format,
    versionId: version.id,
    content: version.content,
    selection: input.selection,
  });
  if (!built.ok) return fail('not-found');
  const { assignment } = built;
  const call = await callStart(deps, {
    sessionId: guest.sessionId,
    examId: exam.id,
    commandId: input.commandId,
    mode: input.mode,
    purpose: input.purpose,
    selection: input.selection,
    sourceAttemptId: input.sourceAttemptId,
    versionId: version.id,
    scope: assignment.scope,
    questionIds: assignment.questionIds,
  });
  if (!call.ok) {
    const rule = ruleViolation(call.error);
    const known = rule ? RULE_FAILURES[rule] : undefined;
    if (known) return fail(known);
    throw new Error('Attempt was not started', { cause: call.error });
  }
  const { row } = call;
  const read = await readAttemptRun(deps, guest, row.attempt_id);
  if (read.status !== 'ready') return fail('unavailable');
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  if (!state) return fail('unavailable');
  const outcome = row.outcome === 'conflict' ? 'conflict' : 'accepted';
  return { ok: true, result: { outcome, attemptId: row.attempt_id, state } };
};

// An explicit start of one attempt. The same commandId returns the attempt
// it created, also after completion; a new commandId while an attempt of the
// exam is active is a conflict that names the active attempt.
export const startAttempt = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<StartAttemptResult> => {
  const parsed = startInput.safeParse(input);
  if (!parsed.success) return fail('invalid-input');
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return fail('session-invalid');
    if (!isEnabled(parsed.data)) return fail('not-enabled');
    return await runStart(deps, guest, parsed.data);
  } catch (error) {
    console.error({ error });
    return fail('unavailable');
  }
};
