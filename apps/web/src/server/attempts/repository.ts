import { examContentSchema } from '@b1k/domain';
import type {
  AnswerKeys,
  AttemptScope,
  AttemptScore,
  DtzLevel,
  ExamContent,
  Selections,
} from '@b1k/domain';
import type { ServerDeps } from '../db';

// Data access of attempts: plain rows of the trusted database, no decisions.
// The owner check is part of every attempt query: a foreign attempt is not
// found. The answer key is never selected here.

export interface ExamRow {
  id: string;
  slug: string;
  title: string;
  format: string;
}

export interface VersionRow {
  id: string;
  examId: string;
  content: ExamContent;
}

export interface AttemptRow {
  id: string;
  status: string;
  scope: AttemptScope;
  examId: string;
  examVersionId: string;
  progress: unknown;
  createdAt: string;
}

// The stored run, as written at the start. The assignment and the frozen
// answers are snapshot JSON; the reader validates them.
export interface RunRow {
  mode: string;
  purpose: string;
  selection: string;
  sourceAttemptId: string | null;
  assignment: unknown;
  acceptedAt: string;
  cancelReason: string | null;
  frozenAnswers: unknown;
  submissionAcceptedAt: string | null;
  // Null for a submission closed by its deadline instead of a command.
  submitCommandId: string | null;
  legacyCompleted: boolean;
  // The timing profile pinned at the start of a timed run; null otherwise.
  timingSnapshot: unknown;
  // The explicit early start of Lesen of an exam; null otherwise.
  lesenStartedAt: string | null;
}

export interface StoredAnswers {
  selections: Selections;
  revisions: Readonly<Record<string, number>>;
}

interface AttemptRecord {
  id: string;
  status: string;
  scope: AttemptScope;
  exam_id: string;
  exam_version_id: string;
  progress: unknown;
  created_at: string;
}

interface RunRecord {
  mode: string;
  purpose: string;
  selection: string;
  source_attempt_id: string | null;
  assignment: unknown;
  accepted_at: string;
  cancel_reason: string | null;
  frozen_answers: unknown;
  submission_accepted_at: string | null;
  submit_command_id: string | null;
  legacy_completed: boolean;
  timing_profile_snapshot: unknown;
  lesen_started_at: string | null;
}

const ATTEMPT_COLUMNS =
  'id, status, scope, exam_id, exam_version_id, progress, created_at';
const RUN_COLUMNS = [
  'mode, purpose, selection, source_attempt_id, assignment, accepted_at',
  'cancel_reason, frozen_answers, submission_accepted_at, submit_command_id',
  'legacy_completed, timing_profile_snapshot, lesen_started_at',
].join(', ');

const toAttempt = (row: AttemptRecord): AttemptRow => ({
  id: row.id,
  status: row.status,
  scope: row.scope,
  examId: row.exam_id,
  examVersionId: row.exam_version_id,
  progress: row.progress,
  createdAt: row.created_at,
});

export const findExamBySlug = async (
  deps: ServerDeps,
  slug: string,
): Promise<ExamRow | null> => {
  const { data, error } = await deps.db
    .from('exams')
    .select('id, slug, title, format')
    .eq('slug', slug)
    .maybeSingle<ExamRow>();
  if (error) throw new Error('Exam lookup failed', { cause: error });
  return data;
};

export const findExamById = async (
  deps: ServerDeps,
  examId: string,
): Promise<ExamRow | null> => {
  const { data, error } = await deps.db
    .from('exams')
    .select('id, slug, title, format')
    .eq('id', examId)
    .maybeSingle<ExamRow>();
  if (error) throw new Error('Exam lookup failed', { cause: error });
  return data;
};

const toVersion = (row: {
  id: string;
  exam_id: string;
  content: unknown;
}): VersionRow => ({
  id: row.id,
  examId: row.exam_id,
  content: examContentSchema.parse(row.content),
});

// The latest published version: the one a new normal start runs on.
export const readLatestVersion = async (
  deps: ServerDeps,
  examId: string,
): Promise<VersionRow | null> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select('id, exam_id, content')
    .eq('exam_id', examId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; exam_id: string; content: unknown }>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  return data ? toVersion(data) : null;
};

// One version of the given exam; a version of another exam is not found.
export const readVersionOfExam = async (
  deps: ServerDeps,
  examId: string,
  versionId: string,
): Promise<VersionRow | null> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select('id, exam_id, content')
    .eq('id', versionId)
    .eq('exam_id', examId)
    .maybeSingle<{ id: string; exam_id: string; content: unknown }>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  return data ? toVersion(data) : null;
};

export const readOwnedAttempt = async (
  deps: ServerDeps,
  sessionId: string,
  attemptId: string,
): Promise<AttemptRow | null> => {
  const { data, error } = await deps.db
    .from('attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('id', attemptId)
    .eq('guest_session_id', sessionId)
    .maybeSingle<AttemptRecord>();
  if (error) throw new Error('Attempt lookup failed', { cause: error });
  return data ? toAttempt(data) : null;
};

// The one active attempt of the guest for this exam: the slot holds at most
// one, on any version.
export const findActiveAttempt = async (
  deps: ServerDeps,
  sessionId: string,
  examId: string,
): Promise<AttemptRow | null> => {
  const { data, error } = await deps.db
    .from('attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('guest_session_id', sessionId)
    .eq('exam_id', examId)
    .eq('status', 'active')
    .maybeSingle<AttemptRecord>();
  if (error) throw new Error('Active attempt lookup failed', { cause: error });
  return data ? toAttempt(data) : null;
};

export interface CardActiveRow {
  attemptId: string;
  examId: string;
  progress: unknown;
  createdAt: string;
}

interface CardActiveRecord {
  id: string;
  exam_id: string;
  progress: unknown;
  created_at: string;
}

// The guest's own active attempts of every exam in one read. The filter is
// the owner alone: a list of exam ids would grow the request address with the
// number of exams, while the guest holds at most one active attempt per exam
// version. Only identity and the stored position are selected: no answers,
// no key.
export const listActiveAttempts = async (
  deps: ServerDeps,
  sessionId: string,
): Promise<CardActiveRow[]> => {
  const { data, error } = await deps.db
    .from('attempts')
    .select('id, exam_id, progress, created_at')
    .eq('guest_session_id', sessionId)
    .eq('status', 'active')
    .returns<CardActiveRecord[]>();
  if (error) throw new Error('Active attempts lookup failed', { cause: error });
  return data.map((row) => ({
    attemptId: row.id,
    examId: row.exam_id,
    progress: row.progress,
    createdAt: row.created_at,
  }));
};

export interface CardResultRow {
  attemptId: string;
  examId: string;
  computedAt: string;
  // Null for a legacy M1 completion that has no run.
  purpose: string | null;
}

interface CardResultRecord {
  attempt_id: string;
  computed_at: string;
  attempts: {
    exam_id: string;
    attempt_runs: { purpose: string } | { purpose: string }[] | null;
  };
}

const purposeOf = (runs: CardResultRecord['attempts']['attempt_runs']) => {
  const run = Array.isArray(runs) ? (runs[0] ?? null) : runs;
  return run ? run.purpose : null;
};

// The completed full-exam results of the guest's own attempts at every exam,
// newest first, with the purpose of the run (null without a run). The
// owner, the status and the scope are filtered by the database; the caller
// drops repeats of mistakes. Scores, answers and reviews are not selected.
export const listFullResults = async (
  deps: ServerDeps,
  sessionId: string,
): Promise<CardResultRow[]> => {
  const { data, error } = await deps.db
    .from('attempt_results')
    .select(
      'attempt_id, computed_at, attempts!inner(exam_id, attempt_runs!attempt_runs_attempt_id_fkey(purpose))',
    )
    .eq('scope', 'full-exam')
    .eq('attempts.guest_session_id', sessionId)
    .eq('attempts.status', 'completed')
    .order('computed_at', { ascending: false })
    .order('attempt_id', { ascending: true })
    .returns<CardResultRecord[]>();
  if (error) throw new Error('Results lookup failed', { cause: error });
  return data.map((row) => ({
    attemptId: row.attempt_id,
    examId: row.attempts.exam_id,
    computedAt: row.computed_at,
    purpose: purposeOf(row.attempts.attempt_runs),
  }));
};

export const readRun = async (
  deps: ServerDeps,
  attemptId: string,
): Promise<RunRow | null> => {
  const { data, error } = await deps.db
    .from('attempt_runs')
    .select(RUN_COLUMNS)
    .eq('attempt_id', attemptId)
    .maybeSingle<RunRecord>();
  if (error) throw new Error('Run lookup failed', { cause: error });
  if (!data) return null;
  return {
    mode: data.mode,
    purpose: data.purpose,
    selection: data.selection,
    sourceAttemptId: data.source_attempt_id,
    assignment: data.assignment,
    acceptedAt: data.accepted_at,
    cancelReason: data.cancel_reason,
    frozenAnswers: data.frozen_answers,
    submissionAcceptedAt: data.submission_accepted_at,
    submitCommandId: data.submit_command_id,
    legacyCompleted: data.legacy_completed,
    timingSnapshot: data.timing_profile_snapshot,
    lesenStartedAt: data.lesen_started_at,
  };
};

export const readStoredAnswers = async (
  deps: ServerDeps,
  attemptId: string,
): Promise<StoredAnswers> => {
  const { data, error } = await deps.db
    .from('attempt_answers')
    .select('question_id, option_id, revision')
    .eq('attempt_id', attemptId)
    .returns<{ question_id: string; option_id: string; revision: number }[]>();
  if (error) throw new Error('Answers lookup failed', { cause: error });
  const selections: Record<string, string> = {};
  const revisions: Record<string, number> = {};
  for (const row of data) {
    selections[row.question_id] = row.option_id;
    revisions[row.question_id] = row.revision;
  }
  return { selections, revisions };
};

export interface StartCall {
  sessionId: string;
  examId: string;
  commandId: string;
  mode: string;
  purpose: string;
  selection: string;
  sourceAttemptId: string | null;
  versionId: string;
  scope: AttemptScope;
  questionIds: readonly string[];
}

export interface StartRow {
  attempt_id: string;
  outcome: 'accepted' | 'replayed' | 'conflict';
  status: string;
  accepted_at: string | null;
  // The expired attempt of the slot this start closed. It stays on the
  // trusted server: its result is computed after the commit and its id never
  // goes into the public outcome.
  closed_attempt_id: string | null;
}

export type StartCallResult =
  { ok: true; row: StartRow } | { ok: false; error: unknown };

// The production start: slot lock, row lock of the active attempt, profile
// lock of a timed start, database time, closing of an expired attempt,
// command journal and the insert of attempt, run (with its pinned profile),
// command and start event in one transaction.
export const callStart = async (
  deps: ServerDeps,
  call: StartCall,
): Promise<StartCallResult> => {
  const { data, error } = await deps.db
    .rpc('m2_start_attempt', {
      p_session_id: call.sessionId,
      p_exam_id: call.examId,
      p_command_id: call.commandId,
      p_mode: call.mode,
      p_purpose: call.purpose,
      p_selection: call.selection,
      p_source_attempt_id: call.sourceAttemptId,
      p_version_id: call.versionId,
      p_scope: call.scope,
      p_question_ids: call.questionIds,
    })
    .single<StartRow>();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

// The command of this guest with this commandId, if the database already
// holds it: a repeated start returns its attempt; another kind is refused.
export const findStartCommand = async (
  deps: ServerDeps,
  sessionId: string,
  commandId: string,
): Promise<{ kind: string; attemptId: string } | null> => {
  const { data, error } = await deps.db
    .from('attempt_commands')
    .select('kind, attempt_id')
    .eq('guest_session_id', sessionId)
    .eq('command_id', commandId)
    .maybeSingle<{ kind: string; attempt_id: string }>();
  if (error) throw new Error('Command lookup failed', { cause: error });
  return data ? { kind: data.kind, attemptId: data.attempt_id } : null;
};

// The guest's submitted attempts of one exam: accepted, result not stored.
export const findSubmittedAttemptIds = async (
  deps: ServerDeps,
  sessionId: string,
  examId: string,
): Promise<string[]> => {
  const { data, error } = await deps.db
    .from('attempts')
    .select('id')
    .eq('guest_session_id', sessionId)
    .eq('exam_id', examId)
    .eq('status', 'submitted')
    .returns<{ id: string }[]>();
  if (error) throw new Error('Submitted lookup failed', { cause: error });
  return data.map((row) => row.id);
};

// The closed key of one version. It is read only to score or to review a
// completed attempt and never goes into the practice state.
export const readAnswerKeys = async (
  deps: ServerDeps,
  versionId: string,
): Promise<AnswerKeys> => {
  const { data, error } = await deps.db
    .from('answer_keys')
    .select('question_id, correct_option_id')
    .eq('exam_version_id', versionId)
    .returns<{ question_id: string; correct_option_id: string }[]>();
  if (error) throw new Error('Key lookup failed', { cause: error });
  const keys: Record<string, string> = {};
  for (const row of data) keys[row.question_id] = row.correct_option_id;
  return keys;
};

export interface ResultRow {
  scope: AttemptScope;
  score: number;
  max_score: number;
  correct_count: number;
  incorrect_count: number;
  skipped_count: number;
  computed_at: string;
  percent: number | string | null;
  hoeren_score: number | null;
  hoeren_max: number | null;
  lesen_score: number | null;
  lesen_max: number | null;
  level: DtzLevel | null;
}

const RESULT_COLUMNS = [
  'scope, score, max_score, correct_count, incorrect_count, skipped_count',
  'computed_at, percent, hoeren_score, hoeren_max, lesen_score, lesen_max',
  'level',
].join(', ');

export const readResult = async (
  deps: ServerDeps,
  attemptId: string,
): Promise<ResultRow | null> => {
  const { data, error } = await deps.db
    .from('attempt_results')
    .select(RESULT_COLUMNS)
    .eq('attempt_id', attemptId)
    .maybeSingle<ResultRow>();
  if (error) throw new Error('Result lookup failed', { cause: error });
  return data;
};

export type RpcResult<Row> =
  { ok: true; row: Row } | { ok: false; error: unknown };

export interface AnswerRecord {
  question_id: string;
  option_id: string;
  revision: number;
  updated_at: string;
}

export interface SaveAnswerCall {
  sessionId: string;
  attemptId: string;
  questionId: string;
  optionId: string;
  revision: number;
}

// The production save: row lock of the attempt, then the database clock.
export const callSaveAnswer = async (
  deps: ServerDeps,
  call: SaveAnswerCall,
): Promise<RpcResult<AnswerRecord>> => {
  const { data, error } = await deps.db
    .rpc('m2_save_answer', {
      p_session_id: call.sessionId,
      p_attempt_id: call.attemptId,
      p_question_id: call.questionId,
      p_option_id: call.optionId,
      p_revision: call.revision,
    })
    .single<AnswerRecord>();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

export const callSaveProgress = async (
  deps: ServerDeps,
  call: { sessionId: string; attemptId: string; progress: unknown },
): Promise<RpcResult<unknown>> => {
  const { data, error } = await deps.db.rpc('m2_save_progress', {
    p_session_id: call.sessionId,
    p_attempt_id: call.attemptId,
    p_progress: call.progress,
  });
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

export interface FinalAnswer {
  questionId: string;
  optionId: string;
  revision: number;
}

// What the guest confirmed: the phase revision and the number of skipped
// tasks of the effective answers.
export interface Confirmation {
  phaseRevision: number;
  skipped: number;
}

// closed-phase: the deadline of a timed run was reached; the command closed
// it with the answers accepted in time instead.
export type CommandRecordOutcome =
  'accepted' | 'replayed' | 'conflict' | 'stale-confirmation' | 'closed-phase';

export interface SubmissionRecord {
  outcome: CommandRecordOutcome;
  attempt_status: string;
  accepted_at: string | null;
  skipped: number | null;
  frozen: unknown;
}

// The production acceptance: one transaction writes the winning answers,
// freezes the effective set with the moment and the command, and moves the
// attempt to submitted.
export const callAcceptSubmission = async (
  deps: ServerDeps,
  call: {
    sessionId: string;
    attemptId: string;
    commandId: string;
    answers: readonly FinalAnswer[];
    confirmation: Confirmation;
  },
): Promise<RpcResult<SubmissionRecord>> => {
  const { data, error } = await deps.db
    .rpc('m2_accept_submission', {
      p_session_id: call.sessionId,
      p_attempt_id: call.attemptId,
      p_command_id: call.commandId,
      p_answers: call.answers,
      p_expected_phase_revision: call.confirmation.phaseRevision,
      p_expected_skipped: call.confirmation.skipped,
    })
    .single<SubmissionRecord>();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

export interface ReconcileRecord {
  attempt_status: string;
  closed: boolean;
  server_now: string;
}

// The production status read: an open timed attempt is locked, its deadline
// is judged by the database clock read after the lock and an expired run is
// closed. Returns the status and that moment.
export const callReconcile = async (
  deps: ServerDeps,
  call: { sessionId: string; attemptId: string },
): Promise<RpcResult<ReconcileRecord>> => {
  const { data, error } = await deps.db
    .rpc('m2_reconcile_attempt', {
      p_session_id: call.sessionId,
      p_attempt_id: call.attemptId,
    })
    .single<ReconcileRecord>();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

export interface BeginLesenRecord {
  outcome: 'accepted' | 'phase-not-open' | 'closed-phase';
  attempt_status: string;
  changed: boolean;
}

// The production early start of Lesen: row lock of the attempt, then the
// database clock; the moment is written once, inside the transition.
export const callBeginLesen = async (
  deps: ServerDeps,
  call: { sessionId: string; attemptId: string },
): Promise<RpcResult<BeginLesenRecord>> => {
  const { data, error } = await deps.db
    .rpc('m2_begin_lesen', {
      p_session_id: call.sessionId,
      p_attempt_id: call.attemptId,
    })
    .single<BeginLesenRecord>();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

export interface CancelRecord {
  outcome: CommandRecordOutcome;
  attempt_status: string;
  accepted_at: string | null;
  skipped: number | null;
}

export const callCancel = async (
  deps: ServerDeps,
  call: {
    sessionId: string;
    attemptId: string;
    commandId: string;
    confirmation: Confirmation;
  },
): Promise<RpcResult<CancelRecord>> => {
  const { data, error } = await deps.db
    .rpc('m2_cancel_attempt', {
      p_session_id: call.sessionId,
      p_attempt_id: call.attemptId,
      p_command_id: call.commandId,
      p_expected_phase_revision: call.confirmation.phaseRevision,
      p_expected_skipped: call.confirmation.skipped,
    })
    .single<CancelRecord>();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};

// Stores the result of a submitted attempt; the database checks it against
// the frozen answers and the key.
export const callFinalize = async (
  deps: ServerDeps,
  call: { sessionId: string; attemptId: string; score: AttemptScore },
): Promise<RpcResult<unknown>> => {
  const { score } = call;
  const { data, error } = await deps.db
    .rpc('m2_finalize_attempt', {
      p_session_id: call.sessionId,
      p_attempt_id: call.attemptId,
      p_scope: score.scope,
      p_score: score.score,
      p_max_score: score.maxScore,
      p_correct: score.correct,
      p_incorrect: score.incorrect,
      p_skipped: score.skipped,
      p_percent: score.percent,
      p_hoeren_score: score.skills?.hoeren.score ?? null,
      p_hoeren_max: score.skills?.hoeren.maxScore ?? null,
      p_lesen_score: score.skills?.lesen.score ?? null,
      p_lesen_max: score.skills?.lesen.maxScore ?? null,
      p_level: score.level,
    })
    .single();
  if (error) return { ok: false, error };
  return { ok: true, row: data };
};
