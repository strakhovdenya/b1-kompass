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
import type { ConfirmedTimingProfile } from './profiles';
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

// The guest session must outlive a timed block, or the whole timeline of
// the exam, by this reserve.
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
// set or of one skill, one timed block of Hören or Lesen and the full exam
// of the whole set. The repeat of errors answers not-enabled before anything
// is written. The tasks are assigned from the pinned version, never taken
// from the client.
const isNormal = (input: StartInput): boolean =>
  input.purpose === 'normal' && input.sourceAttemptId === null;

// A timed block and the full exam pin a confirmed profile and need the
// reserve of the guest.
const isTimed = (input: StartInput): boolean => input.mode !== 'training';

const checkEnabled = (input: StartInput): RunTechnicalFailure | null => {
  if (!isNormal(input)) return 'not-enabled';
  const isWhole = input.selection === 'all';
  if (input.mode === 'timed-block' && isWhole) return 'invalid-input';
  if (input.mode === 'exam' && !isWhole) return 'invalid-input';
  return null;
};

// The time the run may last by its pinned profile: one block, or Hören, the
// whole transition and Lesen of the exam.
const durationOf = (
  input: StartInput,
  profile: ConfirmedTimingProfile,
): number => {
  if (input.mode === 'exam') {
    return (
      profile.hoerenSeconds + profile.transitionSeconds + profile.lesenSeconds
    );
  }
  return input.selection === 'hoeren'
    ? profile.hoerenSeconds
    : profile.lesenSeconds;
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
  version: VersionRow;
  assignment: AttemptAssignment;
}

// The requested version of the exam and the assignment the start would get
// from it; null for another exam's or an unknown version.
const prepare = async (
  deps: ServerDeps,
  exam: ExamRow,
  input: StartInput,
): Promise<Prepared | null> => {
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
  return { version, assignment: built.assignment };
};

// What a timed start would meet now, by the same order as the SQL start:
// a known commandId, an active attempt of the exam, the version and its
// confirmed profile, the reserve of the guest. It only reads: no guest,
// attempt, command or event is written, and its answer is advisory; the SQL
// start checks all of it again after its locks.
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

type SlotVerdict = Extract<TimedStartVerdict, { attemptId: string }>;

// The first two steps: a known commandId, then an active attempt that holds
// the slot. Null when neither answers.
const judgeSlot = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
  exam: ExamRow,
): Promise<CommandResult<SlotVerdict | null>> => {
  const [known, active] = await Promise.all([
    findStartCommand(deps, guest.sessionId, input.commandId),
    findActiveAttempt(deps, guest.sessionId, exam.id),
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
  return { ok: true, result: null };
};

// The last two steps for a free slot: the confirmed profile of the version,
// then the reserve of the guest.
const judgeTerms = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
  version: VersionRow,
): Promise<CommandResult<TimedStartVerdict>> => {
  const profile = await readConfirmedTimingProfile(deps, version.id);
  if (!profile) return fail('not-enabled');
  const durationSeconds = durationOf(input, profile);
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

interface Judged {
  verdict: TimedStartVerdict;
  prepared: Prepared | null;
}

// The whole order: replay, active attempt, version, profile, reserve. A
// replay or a conflict answers before the version is read.
const judgeTimed = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
  exam: ExamRow,
): Promise<CommandResult<Judged>> => {
  const slot = await judgeSlot(deps, guest, input, exam);
  if (!slot.ok) return fail(slot.failure);
  if (slot.result) {
    return { ok: true, result: { verdict: slot.result, prepared: null } };
  }
  const prepared = await prepare(deps, exam, input);
  if (!prepared) return fail('not-found');
  const terms = await judgeTerms(deps, guest, input, prepared.version);
  if (!terms.ok) return fail(terms.failure);
  return { ok: true, result: { verdict: terms.result, prepared } };
};

// The answer of a start: the attempt it names with its actual state.
const outcomeOf = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
  outcome: StartOutcome['outcome'],
): Promise<StartAttemptResult> => {
  const read = await readAttemptRun(deps, guest, attemptId);
  if (read.status !== 'ready') return fail('unavailable');
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  if (!state) return fail('unavailable');
  return { ok: true, result: { outcome, attemptId, state } };
};

interface Ready {
  prepared: Prepared | null;
  // A replay or a conflict found before the version was read.
  slot: SlotVerdict | null;
}

// A timed start passes the whole order before its SQL call; the SQL start
// checks it again after its locks.
const readyFor = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
  exam: ExamRow,
): Promise<CommandResult<Ready>> => {
  if (!isTimed(input)) {
    const prepared = await prepare(deps, exam, input);
    return { ok: true, result: { prepared, slot: null } };
  }
  const judged = await judgeTimed(deps, guest, input, exam);
  if (!judged.ok) return fail(judged.failure);
  const { verdict } = judged.result;
  if (verdict.outcome === 'admissible') {
    return {
      ok: true,
      result: { prepared: judged.result.prepared, slot: null },
    };
  }
  const prepared = await prepare(deps, exam, input);
  return { ok: true, result: { prepared, slot: verdict } };
};

const runStart = async (
  deps: ServerDeps,
  guest: GuestContext,
  input: StartInput,
): Promise<StartAttemptResult> => {
  const exam = await findExamBySlug(deps, input.examSlug);
  if (!exam) return fail('not-found');
  const ready = await readyFor(deps, guest, input, exam);
  if (!ready.ok) return fail(ready.failure);
  const { prepared, slot } = ready.result;
  // A replay or a conflict answers before the version, as in SQL: the
  // requested version is not needed to name the attempt of the slot.
  if (!prepared && slot) {
    const outcome = slot.outcome === 'conflict' ? 'conflict' : 'accepted';
    return outcomeOf(deps, guest, slot.attemptId, outcome);
  }
  if (!prepared) return fail('not-found');
  const { version, assignment } = prepared;
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
  const outcome = row.outcome === 'conflict' ? 'conflict' : 'accepted';
  return outcomeOf(deps, guest, row.attempt_id, outcome);
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
    const exam = await findExamBySlug(deps, parsed.data.examSlug);
    if (!exam) return fail('not-found');
    const judged = await judgeTimed(deps, guest, parsed.data, exam);
    if (!judged.ok) return fail(judged.failure);
    return { ok: true, result: judged.result.verdict };
  } catch (error) {
    console.error({ error });
    return fail('unavailable');
  }
};
