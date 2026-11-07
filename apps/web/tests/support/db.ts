import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttemptReview } from '@b1k/domain';
import {
  getAttemptReview,
  readAttemptPage,
  readAttemptStatus,
  startAttempt,
  submitAttempt,
} from '../../src/server/attempts/attempts';
import type {
  PracticeState,
  StartAttemptResult,
} from '../../src/server/attempts/attempts';
import { startCommand } from '../../src/server/attempts/start';
import type { StartCommandResult } from '../../src/server/attempts/start';
import { createServiceClient } from '../../src/server/db';
import type { Clock, ServerDeps } from '../../src/server/db';
import {
  createGuestSession,
  hashGuestToken,
} from '../../src/server/guest-session/session';
import type {
  CreatedGuest,
  GuestContext,
} from '../../src/server/guest-session/session';
import { PILOT_EXAM_SLUG } from '../../src/server/material/published';
import { TEST_GUEST_SESSIONS_PER_MINUTE, readTestSupabaseEnv } from './env';

const env = readTestSupabaseEnv();

export const serviceDb: SupabaseClient = createServiceClient({
  url: env.url,
  secretKey: env.secretKey,
});

// A browser-side client with the ordinary publishable key: what any visitor
// could call directly against the Data API and Storage.
export const createPublicClient = (): SupabaseClient =>
  createClient(env.url, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export const fixedClock = (at: Date): Clock => ({ now: () => new Date(at) });

export const depsAt = (at: Date): ServerDeps => ({
  db: serviceDb,
  clock: fixedClock(at),
});

export const depsNow = (): ServerDeps => depsAt(new Date());

// A guest created through the real createGuestSession with the e2e limit.
export const newGuest = async (deps: ServerDeps): Promise<CreatedGuest> => {
  const result = await createGuestSession(deps, TEST_GUEST_SESSIONS_PER_MINUTE);
  if (result.status !== 'created') throw new Error('Guest was rate-limited');
  return result.created;
};

export interface StoredSession {
  id: string;
  locale: string;
  created_at: string;
  expires_at: string;
}

export const readSessionByToken = async (
  token: string,
): Promise<StoredSession | null> => {
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .select('id, locale, created_at, expires_at')
    .eq('token_hash', hashGuestToken(token))
    .maybeSingle<StoredSession>();
  if (error) throw error;
  return data;
};

export const readSession = async (id: string): Promise<StoredSession> => {
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .select('id, locale, created_at, expires_at')
    .eq('id', id)
    .single<StoredSession>();
  if (error) throw error;
  return data;
};

export interface StoredAttempt {
  id: string;
  status: string;
}

export const readAttempts = async (
  sessionId: string,
): Promise<StoredAttempt[]> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('id, status')
    .eq('guest_session_id', sessionId)
    .returns<StoredAttempt[]>();
  if (error) throw error;
  return data;
};

export const readAnswers = async (
  attemptId: string,
): Promise<Record<string, string>> => {
  const { data, error } = await serviceDb
    .from('attempt_answers')
    .select('question_id, option_id')
    .eq('attempt_id', attemptId)
    .returns<{ question_id: string; option_id: string }[]>();
  if (error) throw error;
  return Object.fromEntries(
    data.map((row) => [row.question_id, row.option_id]),
  );
};

export const readResults = async (attemptId: string): Promise<unknown[]> => {
  const { data, error } = await serviceDb
    .from('attempt_results')
    .select('*')
    .eq('attempt_id', attemptId);
  if (error) throw error;
  return data;
};

export const readAttemptScope = async (attemptId: string): Promise<string> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('scope')
    .eq('id', attemptId)
    .single<{ scope: string }>();
  if (error) throw error;
  return data.scope;
};

export interface RawVersionInput {
  slug: string;
  content: unknown;
  keys: Readonly<Record<string, string>>;
}

// Writes a version straight into the test database, past the checks of the
// publication: a broken version that the owner path would never publish.
export const insertRawVersion = async (
  input: RawVersionInput,
): Promise<string> => {
  const exam = await serviceDb
    .from('exams')
    .insert({ slug: input.slug, title: 'Broken version', format: 'DTZ' })
    .select('id')
    .single<{ id: string }>();
  if (exam.error) throw exam.error;
  const version = await serviceDb
    .from('exam_versions')
    .insert({ exam_id: exam.data.id, version: 1, content: input.content })
    .select('id')
    .single<{ id: string }>();
  if (version.error) throw version.error;
  const rows = Object.entries(input.keys).map(([questionId, optionId]) => ({
    exam_version_id: version.data.id,
    question_id: questionId,
    correct_option_id: optionId,
  }));
  const keys = await serviceDb.from('answer_keys').insert(rows);
  if (keys.error) throw keys.error;
  return version.data.id;
};

const examIdOfVersion = async (versionId: string): Promise<string> => {
  const { data, error } = await serviceDb
    .from('exam_versions')
    .select('exam_id')
    .eq('id', versionId)
    .single<{ exam_id: string }>();
  if (error) throw error;
  return data.exam_id;
};

// An active attempt written straight into the test database, for a version
// the server cannot open. It has no run: the reader refuses it.
export const insertActiveAttempt = async (
  sessionId: string,
  versionId: string,
  scope: 'short-set' | 'full-exam',
): Promise<string> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .insert({
      guest_session_id: sessionId,
      exam_id: await examIdOfVersion(versionId),
      exam_version_id: versionId,
      scope,
    })
    .select('id')
    .single<{ id: string }>();
  if (error) throw error;
  return data.id;
};

export const readProgress = async (attemptId: string): Promise<unknown> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('progress')
    .eq('id', attemptId)
    .single<{ progress: unknown }>();
  if (error) throw error;
  return data.progress;
};

// The single result row of a completed attempt.
export const readOnlyResult = async <T>(attemptId: string): Promise<T> => {
  const rows = (await readResults(attemptId)) as T[];
  const [row] = rows;
  if (rows.length !== 1 || !row) throw new Error('one result row expected');
  return row;
};

export interface ExamVersionRef {
  examId: string;
  versionId: string;
}

// The exam and its latest published version: what a new start runs on.
export const latestVersionOf = async (
  slug: string,
): Promise<ExamVersionRef | null> => {
  const { data, error } = await serviceDb
    .from('exam_versions')
    .select('id, exam_id, exams!inner(slug)')
    .eq('exams.slug', slug)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; exam_id: string }>();
  if (error) throw error;
  return data ? { examId: data.exam_id, versionId: data.id } : null;
};

export interface StartBody {
  commandId: string;
  examSlug: string;
  mode: string;
  purpose: string;
  selection: string;
  sourceAttemptId: string | null;
  expectedVersionId: string;
}

// The body of an explicit start of the free training of the whole set on
// the latest version, as the choice screen sends it.
export const startBody = async (
  slug: string,
  overrides: Partial<StartBody> = {},
): Promise<StartBody> => {
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error(`no published version of ${slug}`);
  return {
    commandId: randomUUID(),
    examSlug: slug,
    mode: 'training',
    purpose: 'normal',
    selection: 'all',
    sourceAttemptId: null,
    expectedVersionId: latest.versionId,
    ...overrides,
  };
};

// The real start scenario, as the Route Handler calls it.
export const startFor = async (
  deps: ServerDeps,
  token: string | null,
  slug: string,
  overrides: Partial<StartBody> = {},
): Promise<StartAttemptResult> =>
  startAttempt(deps, token, await startBody(slug, overrides));

// The repeat of the errors of one completed attempt, as the review sends it:
// the start contract with the source, its version and its selection. The
// overrides forge any field, so the strict input and the source judge them.
export const repeatFor = async (
  deps: ServerDeps,
  token: string | null,
  slug: string,
  source: { attemptId: string; versionId: string; selection?: string },
  overrides: Partial<StartBody> & Record<string, unknown> = {},
): Promise<StartCommandResult> =>
  startCommand(deps, token, {
    ...(await startBody(slug)),
    purpose: 'error-repeat',
    selection: source.selection ?? 'all',
    sourceAttemptId: source.attemptId,
    expectedVersionId: source.versionId,
    ...overrides,
  });

export type OpenedPractice =
  | { status: 'ready'; practice: PracticeState }
  | { status: 'session-invalid' }
  | { status: 'no-material' };

// One attempt read by its own address, as the attempt layout reads it.
export const readOpened = async (
  deps: ServerDeps,
  guest: GuestContext,
  slug: string,
  attemptId: string,
): Promise<OpenedPractice> => {
  const page = await readAttemptPage(deps, guest, slug, attemptId);
  if (page.status !== 'ready') {
    throw new Error(`attempt ${attemptId} is ${page.status}`);
  }
  return { status: 'ready', practice: page.practice };
};

// The explicit replacement of the M1 openPractice in specs: an explicit
// start, which names the guest's own active attempt of the exam when there is
// one (conflict), then the read of that attempt by its address.
export const openStarted = async (
  deps: ServerDeps,
  created: { token: string; guest: GuestContext },
  slug: string = PILOT_EXAM_SLUG,
): Promise<OpenedPractice> => {
  if (!(await latestVersionOf(slug))) return { status: 'no-material' };
  const started = await startFor(deps, created.token, slug);
  if (!started.ok) {
    if (started.failure === 'session-invalid') {
      return { status: 'session-invalid' };
    }
    throw new Error(`start failed: ${started.failure}`);
  }
  return readOpened(deps, created.guest, slug, started.result.attemptId);
};

export interface StoredRun {
  mode: string;
  purpose: string;
  selection: string;
  source_attempt_id: string | null;
  assignment: { versionId: string; questionIds: string[] };
  accepted_at: string;
  cancel_reason: string | null;
}

export const readRunRows = async (attemptId: string): Promise<StoredRun[]> => {
  const { data, error } = await serviceDb
    .from('attempt_runs')
    .select('*')
    .eq('attempt_id', attemptId)
    .returns<StoredRun[]>();
  if (error) throw error;
  return data;
};

export const readCommandRows = async (
  sessionId: string,
): Promise<{ command_id: string; kind: string; attempt_id: string }[]> => {
  const { data, error } = await serviceDb
    .from('attempt_commands')
    .select('command_id, kind, attempt_id')
    .eq('guest_session_id', sessionId)
    .returns<{ command_id: string; kind: string; attempt_id: string }[]>();
  if (error) throw error;
  return data;
};

export const readEventKinds = async (attemptId: string): Promise<string[]> => {
  const { data, error } = await serviceDb
    .from('guest_events')
    .select('kind')
    .eq('attempt_id', attemptId)
    .order('id')
    .returns<{ kind: string }[]>();
  if (error) throw error;
  return data.map((row) => row.kind);
};

export type StoredSubmission =
  | { ok: true; review: AttemptReview }
  | {
      ok: false;
      error:
        | 'invalid-input'
        | 'session-invalid'
        | 'attempt-not-found'
        | 'unavailable';
    };

const SUBMISSION_ERRORS = {
  'invalid-input': 'invalid-input',
  'session-invalid': 'session-invalid',
  'not-found': 'attempt-not-found',
  unavailable: 'unavailable',
  'not-enabled': 'unavailable',
  'guest-too-short': 'unavailable',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// The free submission of the stored answers, as the browser sends it when
// nothing is pending: the real status gives the confirmation, the real
// submit accepts and finalizes, the real review is read back. Fields other
// than attemptId (a forged score, owner or time) go into the submit body
// unchanged, so the strict input of the scenario judges them. A completed
// attempt returns its stored review; a cancelled one is not found.
export const submitStored = async (
  deps: ServerDeps,
  token: string | null,
  input: unknown,
): Promise<StoredSubmission> => {
  if (!isRecord(input)) return { ok: false, error: 'invalid-input' };
  const { attemptId, ...extra } = input;
  const status = await readAttemptStatus(deps, token, { attemptId });
  if (!status.ok) {
    return { ok: false, error: SUBMISSION_ERRORS[status.failure] };
  }
  const view = status.result;
  if (view.outcome === 'cancelled') {
    return { ok: false, error: 'attempt-not-found' };
  }
  if (view.outcome === 'active') {
    const submitted = await submitAttempt(deps, token, {
      attemptId,
      commandId: randomUUID(),
      answers: [],
      confirmation: {
        phaseRevision: view.state.phaseRevision,
        skipped: view.skipped,
      },
      ...extra,
    });
    if (!submitted.ok) {
      return { ok: false, error: SUBMISSION_ERRORS[submitted.failure] };
    }
    if (submitted.result.outcome === 'conflict') {
      const again = await readAttemptStatus(deps, token, { attemptId });
      if (again.ok && again.result.outcome === 'cancelled') {
        return { ok: false, error: 'attempt-not-found' };
      }
    }
  }
  const review = await getAttemptReview(deps, token, { attemptId });
  if (review.ok) return review;
  return {
    ok: false,
    error: review.error === 'not-completed' ? 'unavailable' : review.error,
  };
};

export interface StoredRunSubmission {
  frozen_answers: Record<string, { optionId: string; revision: number }> | null;
  submission_accepted_at: string | null;
  submit_command_id: string | null;
  legacy_completed: boolean;
}

export const readSubmission = async (
  attemptId: string,
): Promise<StoredRunSubmission> => {
  const { data, error } = await serviceDb
    .from('attempt_runs')
    .select(
      'frozen_answers, submission_accepted_at, submit_command_id, legacy_completed',
    )
    .eq('attempt_id', attemptId)
    .single<StoredRunSubmission>();
  if (error) throw error;
  return data;
};

export interface StoredAnswerRow {
  question_id: string;
  option_id: string;
  revision: number;
}

export const readAnswerRows = async (
  attemptId: string,
): Promise<StoredAnswerRow[]> => {
  const { data, error } = await serviceDb
    .from('attempt_answers')
    .select('question_id, option_id, revision')
    .eq('attempt_id', attemptId)
    .order('question_id')
    .returns<StoredAnswerRow[]>();
  if (error) throw error;
  return data;
};
