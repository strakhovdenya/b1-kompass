import { z } from 'zod';
import type {
  AttemptProgress,
  BeginLesenOutcome,
  CommandResult,
  LifecycleState,
  RunTechnicalFailure,
  Selections,
} from '@b1k/domain';
import type {
  AttemptStatusOutcome,
  AttemptStatusView,
  AttemptSummary,
  ExamTiming,
  TimedClock,
} from '../../features/training/attempt-client';
import { listVersionTrackIds } from '../audio/audio';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { readConfirmedTimingProfile } from './profiles';
import {
  callBeginLesen,
  callReconcile,
  findActiveAttempt,
  findExamById,
  findExamBySlug,
  listActiveAttempts,
  listFullResults,
  readLatestVersion,
  readOwnedAttempt,
  readRun,
  readStoredAnswers,
  readVersionOfExam,
} from './repository';
import type { AttemptRow, RunRow } from './repository';
import {
  parseAssignment,
  parsePinnedDurations,
  parseStoredProgress,
  hasLesenOpened,
  toAttemptSummary,
  toLifecycleState,
  toPracticeState,
  visibleQuestionIds,
} from './projection';
import type { AttemptRunView, PracticeState } from './projection';
import { finalizeSubmitted, parseFrozen } from './reconcile';
import { buildReview, reviewedSelections } from './review';

// Reading never creates an attempt or a start. Every read is bound to the
// guest's own attempt or to its own slot of one exam. Reading a submitted
// attempt tries to complete it from its frozen snapshot; a failure leaves it
// submitted and is reported, never shown as a result.

export type RunReadResult =
  | { status: 'ready'; view: AttemptRunView }
  | { status: 'not-found' }
  // The attempt has no run or its snapshot disagrees with the attempt: it
  // is refused, never completed with a default assignment.
  | { status: 'incompatible' };

const toView = (
  attempt: AttemptRow,
  examSlug: string,
  run: RunRow,
  questionIds: readonly string[],
  durations: AttemptRunView['durations'],
): AttemptRunView => ({
  attemptId: attempt.id,
  examId: attempt.examId,
  examSlug,
  versionId: attempt.examVersionId,
  scope: attempt.scope,
  status: attempt.status,
  mode: run.mode,
  purpose: run.purpose,
  selection: run.selection,
  sourceAttemptId: run.sourceAttemptId,
  questionIds,
  acceptedAt: run.acceptedAt,
  durations,
  isClosedByDeadline:
    run.mode !== 'training' &&
    run.frozenAnswers !== null &&
    run.submitCommandId === null,
  // Only an exam has a start of Lesen; other views keep their contract.
  ...(run.mode === 'exam' ? { lesenStartedAt: run.lesenStartedAt } : {}),
});

// A timed run needs its pinned profile: without one its deadline is unknown
// and the run is not opened. A free training never carries one.
const durationsOf = (run: RunRow): AttemptRunView['durations'] | null => {
  const durations = parsePinnedDurations(run.timingSnapshot);
  if (!durations) return null;
  const isPinned = Object.keys(durations).length > 0;
  return isPinned === (run.mode !== 'training') ? durations : null;
};

const viewOf = (
  attempt: AttemptRow,
  examSlug: string,
  run: RunRow | null,
): RunReadResult => {
  if (!run) return { status: 'incompatible' };
  const questionIds = parseAssignment(run.assignment, attempt.examVersionId);
  const durations = durationsOf(run);
  if (!questionIds || !durations) return { status: 'incompatible' };
  return {
    status: 'ready',
    view: toView(attempt, examSlug, run, questionIds, durations),
  };
};

// The stored assignment, mode, purpose, scope and pinned version of the
// guest's own attempt, exactly as written at the start.
export const readAttemptRun = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
): Promise<RunReadResult> => {
  const attempt = await readOwnedAttempt(deps, guest.sessionId, attemptId);
  if (!attempt) return { status: 'not-found' };
  const [exam, run] = await Promise.all([
    findExamById(deps, attempt.examId),
    readRun(deps, attempt.id),
  ]);
  if (!exam) return { status: 'not-found' };
  return viewOf(attempt, exam.slug, run);
};

interface Synced {
  attempt: AttemptRow;
  run: RunRow | null;
  // The moment the state is judged at: the database clock read after the
  // row lock for an open timed attempt, the server clock otherwise.
  atMs: number;
}

// An open timed attempt is judged by the database: under its row lock the
// clock is read and an expired run is closed with the answers accepted in
// time. Null when the guest session ended meanwhile. A free training or a
// closed attempt is not locked and never waits.
const synced = async (
  deps: ServerDeps,
  guest: GuestContext,
  attempt: AttemptRow,
  run: RunRow | null,
): Promise<Synced | null> => {
  const isOpenTimed =
    attempt.status === 'active' && run !== null && run.mode !== 'training';
  if (!isOpenTimed) return { attempt, run, atMs: deps.clock.now().getTime() };
  const call = await callReconcile(deps, {
    sessionId: guest.sessionId,
    attemptId: attempt.id,
  });
  if (!call.ok) {
    if (ruleViolation(call.error) === 'guest_session_invalid') return null;
    throw new Error('Attempt was not reconciled', { cause: call.error });
  }
  const atMs = Date.parse(call.row.server_now);
  // Unchanged since the first read: nothing to read again. A run closed by
  // this call or meanwhile by another request is read after the lock.
  // An exam may have started Lesen early meanwhile without any change of
  // its status: its run is always read again after the lock.
  const isUnchanged =
    !call.row.closed &&
    call.row.attempt_status === attempt.status &&
    run.mode !== 'exam';
  if (isUnchanged) return { attempt, run, atMs };
  const [closed, closedRun] = await Promise.all([
    readOwnedAttempt(deps, guest.sessionId, attempt.id),
    readRun(deps, attempt.id),
  ]);
  if (!closed) return null;
  return { attempt: closed, run: closedRun, atMs };
};

// The guest's own attempt after reconciliation: a submitted attempt is
// completed when its result can be computed.
const reconciled = async (
  deps: ServerDeps,
  guest: GuestContext,
  attempt: AttemptRow,
  run: RunRow | null,
): Promise<AttemptRow | null> => {
  if (attempt.status !== 'submitted' || !run) return attempt;
  const outcome = await finalizeSubmitted(deps, guest.sessionId, attempt, run);
  if (outcome !== 'completed') return attempt;
  return readOwnedAttempt(deps, guest.sessionId, attempt.id);
};

// The answers that count for a closed attempt: its frozen snapshot, or the
// stored answers of a legacy completion; for an open one the stored answers.
const countedSelections = (
  attempt: AttemptRow,
  run: RunRow,
  stored: Selections,
): Selections | null => {
  if (attempt.status === 'active' || attempt.status === 'cancelled') {
    return stored;
  }
  if (attempt.status === 'submitted') return parseFrozen(run.frozenAnswers);
  return reviewedSelections(run, stored);
};

// The clock of an open timed run: the deadline of its current phase and the
// database moment of this read. None for a free training or a closed run.
// The transition of an exam counts down to the start of Lesen.
const timerOf = (
  state: LifecycleState,
  serverNowMs: number,
): TimedClock | null => {
  const { phase, deadlineMs } = state;
  if (state.mode === 'training' || deadlineMs === null) return null;
  if (phase === 'transition') {
    return { deadlineMs, serverNowMs, skill: 'lesen', phase };
  }
  if (phase !== 'hoeren' && phase !== 'lesen') return null;
  return { deadlineMs, serverNowMs, skill: phase, phase };
};

export type AttemptPageResult =
  | {
      status: 'ready';
      practice: PracticeState;
      // The submission is accepted, its result is not stored yet.
      resultPending: boolean;
      phaseRevision: number;
      timer: TimedClock | null;
      // The trusted lifecycle at the moment of this read.
      state: LifecycleState;
      // Numbers of the whole assignment, hidden Lesen included.
      summary: AttemptSummary;
    }
  | { status: 'not-found' }
  | { status: 'incompatible' };

// The page of one attempt at /practice/[examSlug]/attempts/[attemptId]: the
// guest's own attempt of that exam on its pinned version. A cancelled
// attempt is not opened; a completed one comes with its review, a submitted
// one with its frozen answers.
export const readAttemptPage = async (
  deps: ServerDeps,
  guest: GuestContext,
  examSlug: string,
  attemptId: string,
): Promise<AttemptPageResult> => {
  // The run is read with the attempt; it is used only once the attempt is
  // known to be the guest's own.
  const [exam, owned, ownRun] = await Promise.all([
    findExamBySlug(deps, examSlug),
    readOwnedAttempt(deps, guest.sessionId, attemptId),
    readRun(deps, attemptId),
  ]);
  if (!exam || !owned || owned.examId !== exam.id) {
    return { status: 'not-found' };
  }
  if (owned.status === 'cancelled') return { status: 'not-found' };
  const sync = await synced(deps, guest, owned, ownRun);
  if (!sync) return { status: 'not-found' };
  const { run, atMs } = sync;
  const attempt = await reconciled(deps, guest, sync.attempt, run);
  if (!attempt) return { status: 'not-found' };
  const read = viewOf(attempt, exam.slug, run);
  if (read.status !== 'ready' || !run) return { status: 'incompatible' };
  const [version, stored, trackIds] = await Promise.all([
    readVersionOfExam(deps, exam.id, attempt.examVersionId),
    readStoredAnswers(deps, attempt.id),
    listVersionTrackIds(deps, attempt.examVersionId),
  ]);
  const selections = countedSelections(attempt, run, stored.selections);
  const state = toLifecycleState(read.view, atMs);
  if (!version || !selections || !state) return { status: 'incompatible' };
  const material = { format: exam.format, content: version.content };
  const target = {
    id: attempt.id,
    versionId: version.id,
    questionIds: read.view.questionIds,
  };
  // Only the visible phase of an open exam is projected, and of a closed
  // one only what was opened before it closed; the review of a completed
  // attempt names the whole assignment.
  const visible = {
    ...read.view,
    questionIds: visibleQuestionIds(
      read.view.questionIds,
      version.content,
      state,
      hasLesenOpened(read.view, run.submissionAcceptedAt),
    ),
  };
  const review =
    attempt.status === 'completed'
      ? await buildReview(deps, target, material, selections)
      : null;
  const practice = toPracticeState({
    view: visible,
    examTitle: exam.title,
    content: version.content,
    selections,
    revisions: stored.revisions,
    trackIds,
    review,
    progress: attempt.progress,
  });
  return {
    status: 'ready',
    practice,
    resultPending: attempt.status === 'submitted',
    phaseRevision: state.phaseRevision,
    timer: timerOf(state, atMs),
    state,
    summary: toAttemptSummary(
      read.view.questionIds,
      version.content,
      state,
      selections,
    ),
  };
};

const STATUS_OUTCOMES: Readonly<Record<string, AttemptStatusOutcome>> = {
  active: 'active',
  submitted: 'result-pending',
  completed: 'result-ready',
  cancelled: 'cancelled',
};

const statusInput = z.strictObject({ attemptId: z.uuid() });

const countSkipped = (
  questionIds: readonly string[],
  answers: Selections,
): number => questionIds.filter((id) => !Object.hasOwn(answers, id)).length;

const onlyAssigned = (
  questionIds: readonly string[],
  answers: Selections,
): Selections => {
  const assigned: Record<string, string> = {};
  for (const id of questionIds) {
    const optionId = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (optionId !== undefined) assigned[id] = optionId;
  }
  return assigned;
};

const runStatus = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
): Promise<CommandResult<AttemptStatusView>> => {
  const owned = await readOwnedAttempt(deps, guest.sessionId, attemptId);
  if (!owned) return { ok: false, failure: 'not-found' };
  const [exam, ownRun] = await Promise.all([
    findExamById(deps, owned.examId),
    readRun(deps, owned.id),
  ]);
  if (!exam) return { ok: false, failure: 'not-found' };
  const sync = await synced(deps, guest, owned, ownRun);
  if (!sync) return { ok: false, failure: 'session-invalid' };
  const { run, atMs } = sync;
  const attempt = await reconciled(deps, guest, sync.attempt, run);
  if (!attempt) return { ok: false, failure: 'not-found' };
  const read = viewOf(attempt, exam.slug, run);
  if (read.status !== 'ready' || !run) {
    return { ok: false, failure: 'unavailable' };
  }
  const [stored, version] = await Promise.all([
    readStoredAnswers(deps, attempt.id),
    readVersionOfExam(deps, exam.id, attempt.examVersionId),
  ]);
  const counted = countedSelections(attempt, run, stored.selections);
  const state = toLifecycleState(read.view, atMs);
  const outcome = STATUS_OUTCOMES[attempt.status];
  if (!counted || !state || !outcome || !version) {
    return { ok: false, failure: 'unavailable' };
  }
  const { questionIds } = read.view;
  const { content } = version;
  const all = onlyAssigned(questionIds, counted);
  // The answers of the visible tasks only, as for the page; the numbers of
  // the whole assignment come with the summary.
  const visibleIds = visibleQuestionIds(
    questionIds,
    content,
    state,
    hasLesenOpened(read.view, run.submissionAcceptedAt),
  );
  return {
    ok: true,
    result: {
      outcome,
      attemptId: attempt.id,
      state,
      answers: onlyAssigned(visibleIds, counted),
      skipped: countSkipped(questionIds, all),
      summary: toAttemptSummary(questionIds, content, state, all),
      timer: timerOf(state, atMs),
      submittedAt: run.submissionAcceptedAt,
      serverNow: new Date(atMs).toISOString(),
      isClosedByDeadline: read.view.isClosedByDeadline,
    },
  };
};

// The status of the guest's own attempt: its lifecycle state, the answers
// that count and the number of skipped tasks, as the confirmation of a
// submit or a cancel needs them. A submitted attempt is completed when its
// result can be computed; reading never starts or reopens anything.
export const readAttemptStatus = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<CommandResult<AttemptStatusView>> => {
  const parsed = statusInput.safeParse(input);
  if (!parsed.success) return { ok: false, failure: 'invalid-input' };
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return { ok: false, failure: 'session-invalid' };
    return await runStatus(deps, guest, parsed.data.attemptId);
  } catch (error) {
    console.error({ error });
    return { ok: false, failure: 'unavailable' };
  }
};

const beginInput = z.strictObject({ attemptId: z.uuid() });

const BEGIN_FAILURES: Readonly<Record<string, RunTechnicalFailure>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'not-found',
};

// The answer of begin-lesen: its outcome with the status of the attempt
// after it, so the browser follows the trusted phase in one round trip.
export type BeginLesenResult = CommandResult<
  BeginLesenOutcome & { readonly status: AttemptStatusView }
>;

const runBeginLesen = async (
  deps: ServerDeps,
  guest: GuestContext,
  attemptId: string,
): Promise<BeginLesenResult> => {
  const call = await callBeginLesen(deps, {
    sessionId: guest.sessionId,
    attemptId,
  });
  if (!call.ok) {
    const rule = ruleViolation(call.error);
    const known = rule ? BEGIN_FAILURES[rule] : undefined;
    if (known) return { ok: false, failure: known };
    throw new Error('Lesen was not started', { cause: call.error });
  }
  // A closed exam is completed by the status read, which computes the
  // result of a submitted attempt.
  const status = await runStatus(deps, guest, attemptId);
  if (!status.ok) return status;
  const { state } = status.result;
  const base = { attemptId, state, status: status.result };
  if (call.row.outcome === 'accepted') {
    return {
      ok: true,
      result: { ...base, outcome: 'accepted', changed: call.row.changed },
    };
  }
  return { ok: true, result: { ...base, outcome: call.row.outcome } };
};

// The explicit early start of Lesen of the guest's own exam. Inside the
// transition the database writes the moment once and Lesen gets its full
// pinned duration; a repeat in Lesen changes nothing; Hören is not left
// early. Without it Lesen starts at the end of the transition by itself.
export const beginLesen = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<BeginLesenResult> => {
  const parsed = beginInput.safeParse(input);
  if (!parsed.success) return { ok: false, failure: 'invalid-input' };
  try {
    const guest = await resolveGuestSession(deps, token);
    if (!guest) return { ok: false, failure: 'session-invalid' };
    return await runBeginLesen(deps, guest, parsed.data.attemptId);
  } catch (error) {
    console.error({ error });
    return { ok: false, failure: 'unavailable' };
  }
};

export interface OwnedActive {
  attemptId: string;
  examSlug: string;
  progress: AttemptProgress | null;
}

// The guest's active attempt of this exam, if any, for a redirect to its own
// address. Nothing is created.
export const findOwnedActive = async (
  deps: ServerDeps,
  guest: GuestContext,
  examSlug: string,
): Promise<OwnedActive | null> => {
  const exam = await findExamBySlug(deps, examSlug);
  if (!exam) return null;
  const attempt = await findActiveAttempt(deps, guest.sessionId, exam.id);
  if (!attempt) return null;
  return {
    attemptId: attempt.id,
    examSlug: exam.slug,
    progress: parseStoredProgress(attempt.progress),
  };
};

export interface ExamChoice {
  examSlug: string;
  examTitle: string;
  // The version a new start would run on; the start checks it again.
  versionId: string;
  questionCount: number;
  // The size of each free block, as the start would assign it.
  hoerenCount: number;
  lesenCount: number;
  activeAttemptId: string | null;
  // The confirmed durations of the exam; null while it cannot start.
  examTiming: ExamTiming | null;
}

// The data of the choice screen of one exam. Read only.
export const readExamChoice = async (
  deps: ServerDeps,
  guest: GuestContext,
  examSlug: string,
): Promise<ExamChoice | null> => {
  const exam = await findExamBySlug(deps, examSlug);
  if (!exam) return null;
  const [version, active] = await Promise.all([
    readLatestVersion(deps, exam.id),
    findActiveAttempt(deps, guest.sessionId, exam.id),
  ]);
  if (!version) return null;
  const profile = await readConfirmedTimingProfile(deps, version.id);
  const { questions } = version.content;
  const countOf = (skill: string): number =>
    questions.filter((question) => question.skill === skill).length;
  return {
    examSlug: exam.slug,
    examTitle: exam.title,
    versionId: version.id,
    questionCount: questions.length,
    hoerenCount: countOf('hoeren'),
    lesenCount: countOf('lesen'),
    activeAttemptId: active ? active.id : null,
    examTiming: profile
      ? {
          hoerenSeconds: profile.hoerenSeconds,
          transitionSeconds: profile.transitionSeconds,
          lesenSeconds: profile.lesenSeconds,
        }
      : null,
  };
};

// What the library card of one exam needs from the guest's own attempts.
export interface ExamCardState {
  active: { attemptId: string; block: 'hoeren' | 'lesen' } | null;
  latestResult: { attemptId: string } | null;
}

// The states of the given exams in a fixed number of reads, whatever their
// count: the guest's active attempts and their completed full results, read
// by owner and cut to the given exams here. Both are bound to the guest
// session; a repeat of mistakes is never the latest result, a legacy
// completion without a run is. Read only.
export const readExamCardStates = async (
  deps: ServerDeps,
  guest: GuestContext,
  examIds: readonly string[],
): Promise<Map<string, ExamCardState>> => {
  const [actives, results] = await Promise.all([
    listActiveAttempts(deps, guest.sessionId),
    listFullResults(deps, guest.sessionId),
  ]);
  const wanted = new Set(examIds);
  const states = new Map<string, ExamCardState>();
  const stateOf = (examId: string): ExamCardState => {
    const known = states.get(examId);
    if (known) return known;
    const created: ExamCardState = { active: null, latestResult: null };
    states.set(examId, created);
    return created;
  };
  const newestActive = new Map<string, (typeof actives)[number]>();
  for (const row of actives) {
    if (!wanted.has(row.examId)) continue;
    const seen = newestActive.get(row.examId);
    if (!seen || row.createdAt > seen.createdAt)
      newestActive.set(row.examId, row);
  }
  for (const row of newestActive.values()) {
    const progress = parseStoredProgress(row.progress);
    stateOf(row.examId).active = {
      attemptId: row.attemptId,
      block: progress?.block === 'lesen' ? 'lesen' : 'hoeren',
    };
  }
  // Newest first: the first accepted row of an exam is its latest result.
  for (const row of results) {
    if (!wanted.has(row.examId) || row.purpose === 'error-repeat') continue;
    const state = stateOf(row.examId);
    if (!state.latestResult) state.latestResult = { attemptId: row.attemptId };
  }
  return states;
};
