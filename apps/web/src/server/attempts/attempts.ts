import { z } from 'zod';
import {
  examContentSchema,
  selectAttemptScope,
  selectScoringPolicy,
  toPercent,
} from '@b1k/domain';
import type {
  AnswerKeys,
  AttemptReview,
  AttemptScope,
  DtzLevel,
  ExamContent,
  ExamGroup,
  ExamText,
  ExamQuestion,
  FinishAttemptError,
  FinishAttemptResult,
  ReviewResult,
  SaveAnswerError,
  SaveAnswerResult,
  ScoringPolicy,
  Selections,
  SkillTotals,
} from '@b1k/domain';
import { listVersionTrackIds } from '../audio/audio';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import {
  PILOT_EXAM_SLUG,
  getPublishedVersion,
  getVersionById,
} from '../material/published';
import type { PublishedVersion } from '../material/published';

export interface PracticeState {
  attemptId: string;
  versionId: string;
  examTitle: string;
  source: ExamContent['source'];
  questions: ExamQuestion[];
  groups: ExamGroup[];
  texts: ExamText[];
  selections: Selections;
  trackIds: string[];
  review: AttemptReview | null;
}

// Unknown fields such as role, owner or score are rejected, not ignored.
const saveAnswerInput = z.strictObject({
  attemptId: z.uuid(),
  questionId: z.string().min(1).max(100),
  optionId: z.string().min(1).max(10),
});

const attemptInput = z.strictObject({ attemptId: z.uuid() });

const RULE_ERRORS: Readonly<Record<string, SaveAnswerError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  option_not_allowed: 'option-not-allowed',
};

const FINISH_RULE_ERRORS: Readonly<Record<string, FinishAttemptError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
};

// Overlapping saves can change the answers between scoring and completion;
// the database then refuses and the server scores again.
const FINISH_ROUNDS = 3;

interface AttemptRow {
  id: string;
  status: 'active' | 'completed';
  scope: AttemptScope;
  exam_version_id: string;
}

interface AnswerRow {
  question_id: string;
  option_id: string;
  updated_at: string;
}

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

interface VersionMaterial {
  format: string;
  content: ExamContent;
}

const ATTEMPT_COLUMNS = 'id, status, scope, exam_version_id';
const RESULT_COLUMNS = [
  'scope, score, max_score, correct_count, incorrect_count, skipped_count',
  'computed_at, percent, hoeren_score, hoeren_max, lesen_score, lesen_max',
  'level',
].join(', ');

const readSelections = async (
  deps: ServerDeps,
  attemptId: string,
): Promise<Selections> => {
  const { data, error } = await deps.db
    .from('attempt_answers')
    .select('question_id, option_id, updated_at')
    .eq('attempt_id', attemptId)
    .returns<AnswerRow[]>();
  if (error) throw new Error('Answers lookup failed', { cause: error });
  const selections: Record<string, string> = {};
  for (const row of data) selections[row.question_id] = row.option_id;
  return selections;
};

// The owner check is part of the query: a foreign attempt is not found.
const readOwnedAttempt = async (
  deps: ServerDeps,
  sessionId: string,
  attemptId: string,
): Promise<AttemptRow | null> => {
  const { data, error } = await deps.db
    .from('attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('id', attemptId)
    .eq('guest_session_id', sessionId)
    .maybeSingle<AttemptRow>();
  if (error) throw new Error('Attempt lookup failed', { cause: error });
  return data;
};

const readVersionMaterial = async (
  deps: ServerDeps,
  versionId: string,
): Promise<VersionMaterial> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select('content, exams!inner(format)')
    .eq('id', versionId)
    .single<{ content: unknown; exams: { format: string } }>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  return {
    format: data.exams.format,
    content: examContentSchema.parse(data.content),
  };
};

const readVersionFormat = async (
  deps: ServerDeps,
  versionId: string,
): Promise<string> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select('exams!inner(format)')
    .eq('id', versionId)
    .single<{ exams: { format: string } }>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  return data.exams.format;
};

// The closed key of one version. It is read only to score or to review a
// completed attempt and never goes into the practice state.
const readAnswerKeys = async (
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

const policyFor = (
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
const buildReview = async (
  deps: ServerDeps,
  attempt: AttemptRow,
  material: VersionMaterial,
  selections: Selections,
): Promise<AttemptReview> => {
  const [result, keys] = await Promise.all([
    deps.db
      .from('attempt_results')
      .select(RESULT_COLUMNS)
      .eq('attempt_id', attempt.id)
      .single<ResultRow>(),
    readAnswerKeys(deps, attempt.exam_version_id),
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

export type OpenPracticeResult =
  | { status: 'ready'; practice: PracticeState }
  | { status: 'session-invalid' }
  | { status: 'no-material' };

// The scope comes from the composition of the version, never from the
// client; the database writes it only into a newly created attempt.
const openAttempt = async (
  deps: ServerDeps,
  guest: GuestContext,
  versionId: string,
  scope: AttemptScope,
): Promise<AttemptRow | null> => {
  const { data, error } = await deps.db
    .rpc('open_attempt', {
      p_session_id: guest.sessionId,
      p_exam_version_id: versionId,
      p_now: deps.clock.now().toISOString(),
      p_scope: scope,
    })
    .single<AttemptRow>();
  if (error) {
    if (ruleViolation(error) === 'guest_session_invalid') return null;
    throw new Error('Attempt was not started', { cause: error });
  }
  return data;
};

// The guest's active attempt for the exam on any version. Several are
// possible after a correction: the latest created wins, the highest id breaks
// a tie.
const findActiveVersionId = async (
  deps: ServerDeps,
  guest: GuestContext,
  slug: string,
): Promise<string | null> => {
  const { data, error } = await deps.db
    .from('attempts')
    .select('exam_version_id, exam_versions!inner(exams!inner(slug))')
    .eq('guest_session_id', guest.sessionId)
    .eq('status', 'active')
    .eq('exam_versions.exams.slug', slug)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle<{ exam_version_id: string }>();
  if (error) throw new Error('Active attempt lookup failed', { cause: error });
  return data ? data.exam_version_id : null;
};

// An active attempt stays on its own version, even after a correction was
// published; the latest version is taken only without one.
const chooseVersion = async (
  deps: ServerDeps,
  guest: GuestContext,
  slug: string,
): Promise<PublishedVersion | null> => {
  const activeVersionId = await findActiveVersionId(deps, guest, slug);
  if (activeVersionId) return getVersionById(deps, activeVersionId);
  return getPublishedVersion(deps, slug);
};

// Opens the practice set: the material of the guest's active attempt, or of
// the latest published version without one, and the guest's latest attempt
// for it (open_attempt): a completed attempt comes with its review, otherwise
// the active attempt is continued or started with the scope of the version.
export const openPractice = async (
  deps: ServerDeps,
  guest: GuestContext,
  slug: string = PILOT_EXAM_SLUG,
): Promise<OpenPracticeResult> => {
  const version = await chooseVersion(deps, guest, slug);
  if (!version) return { status: 'no-material' };
  const material: VersionMaterial = {
    format: await readVersionFormat(deps, version.versionId),
    content: version.content,
  };
  const scope = selectAttemptScope(material.format, material.content);
  const attempt = await openAttempt(deps, guest, version.versionId, scope);
  if (!attempt) return { status: 'session-invalid' };
  const [selections, trackIds] = await Promise.all([
    readSelections(deps, attempt.id),
    listVersionTrackIds(deps, version.versionId),
  ]);
  const review =
    attempt.status === 'completed'
      ? await buildReview(deps, attempt, material, selections)
      : null;
  const practice: PracticeState = {
    attemptId: attempt.id,
    versionId: version.versionId,
    examTitle: version.examTitle,
    source: version.content.source,
    questions: version.content.questions,
    groups: version.content.groups ?? [],
    texts: version.content.texts ?? [],
    selections,
    trackIds,
    review,
  };
  return { status: 'ready', practice };
};

export const saveAnswer = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SaveAnswerResult> => {
  const parsed = saveAnswerInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  const { attemptId, questionId, optionId } = parsed.data;
  const { data, error } = await deps.db
    .rpc('save_attempt_answer', {
      p_session_id: guest.sessionId,
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_option_id: optionId,
      p_now: deps.clock.now().toISOString(),
    })
    .single<AnswerRow>();
  if (error) {
    const rule = ruleViolation(error);
    const known = rule ? RULE_ERRORS[rule] : undefined;
    if (known) return { ok: false, error: known };
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
  return {
    ok: true,
    questionId: data.question_id,
    optionId: data.option_id,
    savedAt: data.updated_at,
  };
};

type FinishRound =
  | { status: 'done' }
  | { status: 'answers-changed' }
  | { status: 'failed'; error: FinishAttemptError };

// One round: score the stored answers with the policy of the attempt and ask
// the database to complete it with exactly those answers.
const finishRound = async (
  deps: ServerDeps,
  guest: GuestContext,
  attempt: AttemptRow,
  material: VersionMaterial,
  keys: AnswerKeys,
): Promise<FinishRound> => {
  const policy = policyFor(material, attempt.scope);
  const selections = await readSelections(deps, attempt.id);
  const scored = policy.score({
    questions: material.content.questions,
    keys,
    selections,
  });
  const { error } = await deps.db
    .rpc('finish_attempt', {
      p_session_id: guest.sessionId,
      p_attempt_id: attempt.id,
      p_now: deps.clock.now().toISOString(),
      p_scope: scored.scope,
      p_scored_answers: selections,
      p_score: scored.score,
      p_max_score: scored.maxScore,
      p_correct: scored.correct,
      p_incorrect: scored.incorrect,
      p_skipped: scored.skipped,
      p_percent: scored.percent,
      p_hoeren_score: scored.skills?.hoeren.score ?? null,
      p_hoeren_max: scored.skills?.hoeren.maxScore ?? null,
      p_lesen_score: scored.skills?.lesen.score ?? null,
      p_lesen_max: scored.skills?.lesen.maxScore ?? null,
      p_level: scored.level,
    })
    .single();
  if (!error) return { status: 'done' };
  const rule = ruleViolation(error);
  if (rule === 'answers_changed') return { status: 'answers-changed' };
  const known = rule ? FINISH_RULE_ERRORS[rule] : undefined;
  if (known) return { status: 'failed', error: known };
  throw new Error('Attempt was not finished', { cause: error });
};

// Completes the guest's own attempt and returns its review. The score is
// computed here from the stored answers and the closed key; repeating the
// call returns the same, already stored result.
export const finishAttempt = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<FinishAttemptResult> => {
  const parsed = attemptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  try {
    const attempt = await readOwnedAttempt(
      deps,
      guest.sessionId,
      parsed.data.attemptId,
    );
    if (!attempt) return { ok: false, error: 'attempt-not-found' };
    const [material, keys] = await Promise.all([
      readVersionMaterial(deps, attempt.exam_version_id),
      readAnswerKeys(deps, attempt.exam_version_id),
    ]);
    for (let round = 0; round < FINISH_ROUNDS; round++) {
      const outcome = await finishRound(deps, guest, attempt, material, keys);
      if (outcome.status === 'failed')
        return { ok: false, error: outcome.error };
      if (outcome.status === 'done') {
        // Another finish may have won the lock: review the frozen answers.
        const completed = { ...attempt, status: 'completed' as const };
        const frozen = await readSelections(deps, attempt.id);
        const review = await buildReview(deps, completed, material, frozen);
        return { ok: true, review };
      }
    }
    return { ok: false, error: 'unavailable' };
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};

// The review exists only for the owner and only after completion: an active
// or a foreign attempt gives no key.
export const getAttemptReview = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<ReviewResult> => {
  const parsed = attemptInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  try {
    const attempt = await readOwnedAttempt(
      deps,
      guest.sessionId,
      parsed.data.attemptId,
    );
    if (!attempt) return { ok: false, error: 'attempt-not-found' };
    if (attempt.status !== 'completed') {
      return { ok: false, error: 'not-completed' };
    }
    const [material, selections] = await Promise.all([
      readVersionMaterial(deps, attempt.exam_version_id),
      readSelections(deps, attempt.id),
    ]);
    const review = await buildReview(deps, attempt, material, selections);
    return { ok: true, review };
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};
