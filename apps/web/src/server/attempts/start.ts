import { z } from 'zod';
import {
  ATTEMPT_MODES,
  ATTEMPT_PURPOSES,
  ATTEMPT_SELECTIONS,
  buildAssignment,
} from '@b1k/domain';
import type {
  AttemptAssignment,
  CommandResult,
  RunTechnicalFailure,
  StartOutcome,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { readConfirmedTimingProfile } from './profiles';
import { readAttemptRun } from './read';
import { toLifecycleState } from './projection';
import {
  callStart,
  findActiveAttempt,
  findExamBySlug,
  findStartCommand,
  findSubmittedAttemptIds,
  readVersionOfExam,
} from './repository';
import { finalizeClosedRun } from './submit';
import type { ExamRow, VersionRow } from './repository';

export type StartAttemptResult = CommandResult<StartOutcome>;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The guest session must outlive a timed block by this reserve.
export const GUEST_RESERVE_SECONDS = 300;

const SECOND_MS = 1000;

// The full start contract. Unknown fields such as owner, score, status, a
// time or a duration are rejected, not ignored; the version is a consistency
// check of the prepared choice, not a choice of the client.
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

// The capabilities are switched on in order: the free training of the whole
// set or of one skill, and one timed block of Hören or Lesen. The full exam
// and the repeat of errors answer not-enabled before anything is written. The
// tasks are assigned from the pinned version, never taken from the client.
const isNormal = (input: StartInput): boolean =>
  input.purpose === 'normal' && input.sourceAttemptId === null;

const isTimed = (input: StartInput): boolean => input.mode === 'timed-block';

const checkEnabled = (input: StartInput): RunTechnicalFailure | null => {
  if (!isNormal(input) || input.mode === 'exam') return 'not-enabled';
  if (isTimed(input) && input.selection === 'all') return 'invalid-input';
  return null;
};

const RULE_FAILURES: Readonly<Record<string, RunTechnicalFailure>> = {
  guest_session_invalid: 'session-invalid',
  command_mismatch: 'invalid-input',
  start_invalid: 'invalid-input',
  assignment_invalid: 'invalid-input',
  mode_not_enabled: 'not-enabled',
  // No current confirmed profile: a draft head, none or a mismatch.
  timing_profile_unavailable: 'not-enabled',
  guest_too_short: 'guest-too-short',
  // The prepared choice is no longer the latest version: the choice is read
  // again before a new start.
  version_changed: 'not-found',
};

const fail = <Outcome>(
  failure: RunTechnicalFailure,
): CommandResult<Outcome> => ({
  ok: false,
  failure,
});

interface Prepared {
  exam: ExamRow;
  version: VersionRow;
  assignment: AttemptAssignment;
}

const prepare = async (
  deps: ServerDeps,
  input: StartInput,
): Promise<Prepared | null> => {
  const exam = await findExamBySlug(deps, input.examSlug);
  if (!exam) return null;
  const version = await readVersionOfExam(
    deps,
    exam.id,
    input.expectedVersionId,
  );
  if (!version) return null;
  const built = buildAssignment({
    format: exam.format,
    versionId: version.id,
    content: version.content,
    selection: input.selection,
  });
  if (!built.ok) return null;
  return { exam, version, assignment: built.assignment };
};

// What a timed start would meet now, by the same order as the SQL start:
// a known commandId, an active attempt of the exam, the confirmed profile of
// the version, the reserve of the guest. It only reads: no guest, attempt,
// command or event is written, and its answer is advisory; the SQL start
// checks all of it again after its locks.
export type TimedStartVerdict =
  | {
      readonly outcome: 'admissible';
      readonly durationSeconds: number;
      // The guest session must last at least until this moment.
      readonly requiredUntil: string;
    }
  | { readonly outcome: 'replay' | 'conflict'; readonly attemptId: string };

// By the server clock and the same lifecycle rule as every reader,
// advisory only: the SQL start decides after its locks.
const isPastDeadline = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
): Promise<boolean> => {
  const read = await readAttemptRun(deps, guest, attemptId);
  if (read.status !== 'ready' || read.view.mode === 'training') return false;
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  return state?.phase === 'closed';
};

const judgeTimed = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
  prepared: Prepared,
): Promise<CommandResult<TimedStartVerdict>> => {
  const [known, active] = await Promise.all([
    findStartCommand(deps, guest.sessionId, input.commandId),
    findActiveAttempt(deps, guest.sessionId, prepared.exam.id),
  ]);
  // The id of another command is refused by the SQL start as well.
  if (known && known.kind !== 'start') return fail('invalid-input');
  if (known) {
    return {
      ok: true,
      result: { outcome: 'replay', attemptId: known.attemptId },
    };
  }
  // An active timed run past its deadline does not hold the slot: the start
  // closes it. Any other active attempt is a conflict.
  if (active && !(await isPastDeadline(deps, guest, active.id))) {
    return { ok: true, result: { outcome: 'conflict', attemptId: active.id } };
  }
  const profile = await readConfirmedTimingProfile(deps, prepared.version.id);
  if (!profile) return fail('not-enabled');
  const durationSeconds =
    input.selection === 'hoeren' ? profile.hoerenSeconds : profile.lesenSeconds;
  const requiredMs =
    deps.clock.now().getTime() +
    (durationSeconds + GUEST_RESERVE_SECONDS) * SECOND_MS;
  if (guest.expiresAt.getTime() < requiredMs) return fail('guest-too-short');
  return {
    ok: true,
    result: {
      outcome: 'admissible',
      durationSeconds,
      requiredUntil: new Date(requiredMs).toISOString(),
    },
  };
};

const runStart = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
): Promise<StartAttemptResult> => {
  const prepared = await prepare(deps, input);
  if (!prepared) return fail('not-found');
  if (isTimed(input)) {
    const verdict = await judgeTimed(deps, guest, input, prepared);
    if (!verdict.ok) return fail(verdict.failure);
  }
  const { exam, version, assignment } = prepared;
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
  // The expired attempt this start closed gets its result after the commit,
  // before the answer. A failure leaves it submitted without a result and
  // never undoes the new start. A replayed start names no closed attempt, so
  // every submitted attempt of the slot is tried again as well.
  const closedIds = new Set(
    await findSubmittedAttemptIds(deps, guest.sessionId, exam.id),
  );
  if (row.closed_attempt_id) closedIds.add(row.closed_attempt_id);
  for (const closedId of closedIds) {
    await finalizeClosedRun(deps, guest, closedId);
  }
  const read = await readAttemptRun(deps, guest, row.attempt_id);
  if (read.status !== 'ready') return fail('unavailable');
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  if (!state) return fail('unavailable');
  const outcome = row.outcome === 'conflict' ? 'conflict' : 'accepted';
  return { ok: true, result: { outcome, attemptId: row.attempt_id, state } };
};

// An explicit start of one attempt. The same commandId returns the attempt
// it created, also after completion; a new commandId while an attempt of the
// exam is active is a conflict that names the active attempt. An active
// timed attempt past its deadline is closed by the start instead.
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
    const refused = checkEnabled(parsed.data);
    if (refused) return fail(refused);
    return await runStart(deps, guest, parsed.data);
  } catch (error) {
    console.error({ error });
    return fail('unavailable');
  }
};

// The read-only preflight of a timed start for the guest replacement of #44:
// the same input and the same checks as the start, in the same order, with
// guest-too-short as its own refusal. It writes nothing and never admits by
// itself; only the SQL start, after its locks, decides.
export const preflightTimedStart = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<CommandResult<TimedStartVerdict>> => {
  const parsed = startInput.safeParse(input);
  if (!parsed.success) return fail('invalid-input');
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return fail('session-invalid');
    if (!isTimed(parsed.data)) return fail('invalid-input');
    const refused = checkEnabled(parsed.data);
    if (refused) return fail(refused);
    const prepared = await prepare(deps, parsed.data);
    if (!prepared) return fail('not-found');
    return await judgeTimed(deps, guest, parsed.data, prepared);
  } catch (error) {
    console.error({ error });
    return fail('unavailable');
  }
};
