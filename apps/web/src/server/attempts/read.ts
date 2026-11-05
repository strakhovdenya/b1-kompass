import { z } from 'zod';
import type { AttemptProgress, CommandResult, Selections } from '@b1k/domain';
import type {
  AttemptStatusOutcome,
  AttemptStatusView,
} from '../../features/training/attempt-client';
import { listVersionTrackIds } from '../audio/audio';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import {
  findActiveAttempt,
  findExamById,
  findExamBySlug,
  readLatestVersion,
  readOwnedAttempt,
  readRun,
  readStoredAnswers,
  readVersionOfExam,
} from './repository';
import type { AttemptRow, RunRow } from './repository';
import {
  parseAssignment,
  parseStoredProgress,
  toLifecycleState,
  toPracticeState,
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
});

const viewOf = (
  attempt: AttemptRow,
  examSlug: string,
  run: RunRow | null,
): RunReadResult => {
  if (!run) return { status: 'incompatible' };
  const questionIds = parseAssignment(run.assignment, attempt.examVersionId);
  if (!questionIds) return { status: 'incompatible' };
  return { status: 'ready', view: toView(attempt, examSlug, run, questionIds) };
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

export type AttemptPageResult =
  | {
      status: 'ready';
      practice: PracticeState;
      // The submission is accepted, its result is not stored yet.
      resultPending: boolean;
      phaseRevision: number;
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
  const run = ownRun;
  const attempt = await reconciled(deps, guest, owned, run);
  if (!attempt) return { status: 'not-found' };
  const read = viewOf(attempt, exam.slug, run);
  if (read.status !== 'ready' || !run) return { status: 'incompatible' };
  const [version, stored, trackIds] = await Promise.all([
    readVersionOfExam(deps, exam.id, attempt.examVersionId),
    readStoredAnswers(deps, attempt.id),
    listVersionTrackIds(deps, attempt.examVersionId),
  ]);
  const selections = countedSelections(attempt, run, stored.selections);
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  if (!version || !selections || !state) return { status: 'incompatible' };
  const material = { format: exam.format, content: version.content };
  const target = {
    id: attempt.id,
    versionId: version.id,
    questionIds: read.view.questionIds,
  };
  const review =
    attempt.status === 'completed'
      ? await buildReview(deps, target, material, selections)
      : null;
  const practice = toPracticeState({
    view: read.view,
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
  const [exam, run] = await Promise.all([
    findExamById(deps, owned.examId),
    readRun(deps, owned.id),
  ]);
  if (!exam) return { ok: false, failure: 'not-found' };
  const attempt = await reconciled(deps, guest, owned, run);
  if (!attempt) return { ok: false, failure: 'not-found' };
  const read = viewOf(attempt, exam.slug, run);
  if (read.status !== 'ready' || !run) {
    return { ok: false, failure: 'unavailable' };
  }
  const stored = await readStoredAnswers(deps, attempt.id);
  const counted = countedSelections(attempt, run, stored.selections);
  const state = toLifecycleState(read.view, deps.clock.now().getTime());
  const outcome = STATUS_OUTCOMES[attempt.status];
  if (!counted || !state || !outcome) {
    return { ok: false, failure: 'unavailable' };
  }
  const { questionIds } = read.view;
  const answers = onlyAssigned(questionIds, counted);
  return {
    ok: true,
    result: {
      outcome,
      attemptId: attempt.id,
      state,
      answers,
      skipped: countSkipped(questionIds, answers),
      submittedAt: run.submissionAcceptedAt,
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
  };
};
