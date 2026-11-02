import { selectScoringPolicy, toPercent } from '@b1k/domain';
import type {
  AnswerKeys,
  AttemptProgress,
  AttemptReview,
  AttemptScope,
  DtzLevel,
  ExamContent,
  ScoringPolicy,
  Selections,
  SkillTotals,
} from '@b1k/domain';
import { listVersionTrackIds } from '../audio/audio';
import type { ServerDeps } from '../db';
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
  toPracticeState,
} from './projection';
import type { AttemptRunView, PracticeState } from './projection';

// Reading never creates an attempt or a start. Every read is bound to the
// guest's own attempt or to its own slot of one exam.

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

const readRunOf = async (
  deps: ServerDeps,
  attempt: AttemptRow,
  examSlug: string,
): Promise<RunReadResult> => {
  const run = await readRun(deps, attempt.id);
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
  const exam = await findExamById(deps, attempt.examId);
  if (!exam) return { status: 'not-found' };
  return readRunOf(deps, attempt, exam.slug);
};

interface ResultRow {
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

export interface VersionMaterial {
  format: string;
  content: ExamContent;
}

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

export const policyFor = (
  material: VersionMaterial,
  scope: AttemptScope,
): ScoringPolicy => {
  const policy = selectScoringPolicy(material.format, scope);
  if (!policy) {
    throw new Error(`No scoring policy for ${material.format} ${scope}`);
  }
  return policy;
};

const storedSkills = (row: ResultRow): SkillTotals | null => {
  const { hoeren_score, hoeren_max, lesen_score, lesen_max } = row;
  if (hoeren_score === null || hoeren_max === null) return null;
  if (lesen_score === null || lesen_max === null) return null;
  return {
    hoeren: { score: hoeren_score, maxScore: hoeren_max },
    lesen: { score: lesen_score, maxScore: lesen_max },
  };
};

// Results stored before the percentage column have none; the same rounding
// gives their value.
const storedPercent = (row: ResultRow): number =>
  row.percent === null
    ? toPercent(row.score, row.max_score)
    : Number(row.percent);

// The review of a completed attempt: stored totals plus the per-task view of
// its frozen answers against the key of its own version.
export const buildReview = async (
  deps: ServerDeps,
  attempt: { id: string; versionId: string },
  material: VersionMaterial,
  selections: Selections,
): Promise<AttemptReview> => {
  const [result, keys] = await Promise.all([
    deps.db
      .from('attempt_results')
      .select(RESULT_COLUMNS)
      .eq('attempt_id', attempt.id)
      .single<ResultRow>(),
    readAnswerKeys(deps, attempt.versionId),
  ]);
  if (result.error) {
    throw new Error('Result lookup failed', { cause: result.error });
  }
  const { data } = result;
  const policy = policyFor(material, data.scope);
  const scored = policy.score({
    questions: material.content.questions,
    keys,
    selections,
  });
  return {
    attemptId: attempt.id,
    scope: data.scope,
    showsLevel: policy.showsLevel,
    score: data.score,
    maxScore: data.max_score,
    percent: storedPercent(data),
    correct: data.correct_count,
    incorrect: data.incorrect_count,
    skipped: data.skipped_count,
    skills: storedSkills(data),
    level: data.level,
    completedAt: data.computed_at,
    items: scored.items,
  };
};

export type AttemptPageResult =
  | { status: 'ready'; practice: PracticeState }
  | { status: 'not-found' }
  | { status: 'incompatible' };

// The page of one attempt at /practice/[examSlug]/attempts/[attemptId]: the
// guest's own attempt of that exam on its pinned version. A cancelled
// attempt is not opened; a completed one comes with its review.
export const readAttemptPage = async (
  deps: ServerDeps,
  guest: GuestContext,
  examSlug: string,
  attemptId: string,
): Promise<AttemptPageResult> => {
  const [exam, attempt] = await Promise.all([
    findExamBySlug(deps, examSlug),
    readOwnedAttempt(deps, guest.sessionId, attemptId),
  ]);
  if (!exam || !attempt || attempt.examId !== exam.id) {
    return { status: 'not-found' };
  }
  if (attempt.status === 'cancelled') return { status: 'not-found' };
  const [run, version, { selections, revisions }, trackIds] = await Promise.all(
    [
      readRunOf(deps, attempt, exam.slug),
      readVersionOfExam(deps, exam.id, attempt.examVersionId),
      readStoredAnswers(deps, attempt.id),
      listVersionTrackIds(deps, attempt.examVersionId),
    ],
  );
  if (run.status !== 'ready') return run;
  if (!version) return { status: 'incompatible' };
  const material = { format: exam.format, content: version.content };
  const review =
    attempt.status === 'completed'
      ? await buildReview(
          deps,
          { id: attempt.id, versionId: version.id },
          material,
          selections,
        )
      : null;
  const practice = toPracticeState({
    view: run.view,
    examTitle: exam.title,
    content: version.content,
    selections,
    revisions,
    trackIds,
    review,
    progress: attempt.progress,
  });
  return { status: 'ready', practice };
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
  return {
    examSlug: exam.slug,
    examTitle: exam.title,
    versionId: version.id,
    questionCount: version.content.questions.length,
    activeAttemptId: active ? active.id : null,
  };
};
