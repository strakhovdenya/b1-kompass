import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { admitOperation, resolveLifecycle } from '@b1k/domain';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import {
  getAttemptReview,
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
  submitAttempt,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  hashGuestToken,
  resolveGuestSession,
} from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import {
  createPublicClient,
  depsNow,
  insertActiveAttempt,
  insertRawVersion,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttempts,
  readCommandRows,
  readEventKinds,
  readResults,
  readRunRows,
  readSubmission,
  serviceDb,
  startFor,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TRACK_ID,
  SHORT_TIMING,
  ensureConfirmedTestProfile,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import { attemptUrl } from './support/guest-browser';
import { historicalCompletionSql, snapshotSql } from './support/legacy-attempt';
import type { HistoricalCompletion } from './support/legacy-attempt';
import {
  DB_CONTAINER,
  holdAttemptLock,
  holdSlotLock,
  installM2Fixtures,
  localTarget,
  psql,
  psqlJson,
  quote,
  slotWaiters,
  sqlRunnerAs,
  waitersBehind,
} from './support/sql';

// The test-only fixtures of tests/support/m2-fixtures.sql call the same
// private admission kernel as the production start, under the same slot
// lock; only the moment is explicit. They live only in the isolated local
// database: the installer refuses other targets, no API role reaches them
// and the production start takes no time from its caller.

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const MIGRATIONS = path.join(REPO_ROOT, 'supabase', 'migrations');
const WEB_SOURCES = path.join(REPO_ROOT, 'apps', 'web', 'src');

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

const START_SIGNATURE =
  'uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb';

test.beforeAll(() => {
  installM2Fixtures();
});

interface AttemptShape {
  exam_id: string;
  exam_version_id: string;
  scope: string;
  status: string;
}

const readAttemptShape = async (attemptId: string): Promise<AttemptShape> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('exam_id, exam_version_id, scope, status')
    .eq('id', attemptId)
    .single<AttemptShape>();
  if (error) throw error;
  return data;
};

const onlyRun = async (attemptId: string) => {
  const runs = await readRunRows(attemptId);
  expect(runs).toHaveLength(1);
  const [run] = runs;
  if (!run) throw new Error('run is missing');
  return {
    mode: run.mode,
    purpose: run.purpose,
    selection: run.selection,
    source_attempt_id: run.source_attempt_id,
    assignment: run.assignment,
    cancel_reason: run.cancel_reason,
  };
};

test('isolated fixture installer and production start share admission kernel', async () => {
  const sources = psqlJson<{ production: string; fixture: string }>(
    `select json_build_object(
      'production', (select p.prosrc from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'm2_start_attempt'),
      'fixture', (select p.prosrc from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'm2_test' and p.proname = 'start_attempt_at'))`,
  );
  for (const source of [sources.production, sources.fixture]) {
    expect(source).toContain('m2_private.slot_key(');
    expect(source).toContain('m2_private.admit_start(');
  }
  // Production reads the database clock after the lock; only the fixture
  // passes the moment it was given.
  expect(sources.production).toContain('clock_timestamp()');
  expect(sources.production).not.toContain('p_at');
  expect(sources.fixture).toContain('p_at');

  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');

  // The production vector: the real start scenario of the Route Handler.
  const production = await newGuest(depsNow());
  const started = await startFor(depsNow(), production.token, FULL_EXAM.slug);
  if (!started.ok) throw new Error(`start failed: ${started.failure}`);
  expect(started.result.outcome).toBe('accepted');
  const productionId = started.result.attemptId;
  const productionAttempt = await readAttemptShape(productionId);
  const productionRun = await onlyRun(productionId);

  // The same admissible vector through the fixture, for another guest.
  const fixtureGuest = await newGuest(depsNow());
  const commandId = randomUUID();
  const fixture = psqlJson<{ attempt_id: string; outcome: string }>(
    `select to_json(s) from m2_test.start_attempt_at(
      ${quote(fixtureGuest.guest.sessionId)}::uuid,
      ${quote(latest.examId)}::uuid,
      ${quote(commandId)}::uuid,
      'training', 'normal', 'all', null,
      ${quote(latest.versionId)}::uuid,
      ${quote(productionAttempt.scope)},
      ${quote(JSON.stringify(productionRun.assignment.questionIds))}::jsonb,
      clock_timestamp()
    ) s`,
  );
  expect(fixture.outcome).toBe('accepted');
  expect(await readAttemptShape(fixture.attempt_id)).toEqual(productionAttempt);
  expect(await onlyRun(fixture.attempt_id)).toEqual(productionRun);
  expect(productionAttempt).toEqual({
    exam_id: latest.examId,
    exam_version_id: latest.versionId,
    scope: 'full-exam',
    status: 'active',
  });
  expect(await readCommandRows(fixtureGuest.guest.sessionId)).toEqual([
    { command_id: commandId, kind: 'start', attempt_id: fixture.attempt_id },
  ]);

  // The wrappers are not part of the migrations nor of the app sources.
  for (const file of filesUnder(MIGRATIONS)) {
    expect(readFileSync(file, 'utf8'), file).not.toContain('m2_test');
  }
  for (const file of filesUnder(WEB_SOURCES)) {
    const text = readFileSync(file, 'utf8');
    expect(text, file).not.toContain('m2_test');
    expect(text, file).not.toContain('m2-fixtures');
  }
});

test('fixture installer cannot target cloud or expose production time bypass', async () => {
  const local = localTarget();
  expect(() =>
    installM2Fixtures({
      url: 'https://abcdefghijklmnop.supabase.co',
      container: DB_CONTAINER,
    }),
  ).toThrow(/non-local/);
  expect(() =>
    installM2Fixtures({ url: local.url, container: 'other-container' }),
  ).toThrow(/container/);
  expect(() =>
    installM2Fixtures({ url: 'not a url', container: DB_CONTAINER }),
  ).toThrow(/unparsable/);

  const privileges = psqlJson<Record<string, boolean>>(
    `select json_object_agg(r.role || ':' || c.what, c.allowed) from
    (values ('anon'), ('authenticated'), ('service_role')) r (role),
    lateral (values
      ('m2_test usage', has_schema_privilege(r.role, 'm2_test', 'usage')),
      ('m2_private usage',
        has_schema_privilege(r.role, 'm2_private', 'usage')),
      ('start_attempt_at', has_function_privilege(r.role,
        'm2_test.start_attempt_at(${START_SIGNATURE}, timestamptz)',
        'execute')),
      ('insert_guest_ending_in', has_function_privilege(r.role,
        'm2_test.insert_guest_ending_in(text, numeric)', 'execute')),
      ('admit_start', has_function_privilege(r.role,
        'm2_private.admit_start(${START_SIGNATURE}, timestamptz)',
        'execute'))
    ) c (what, allowed)`,
  );
  expect(Object.keys(privileges)).toHaveLength(15);
  for (const [name, allowed] of Object.entries(privileges)) {
    expect(allowed, name).toBe(false);
  }

  // The production start has one signature and none of it is a time.
  const overloads = psqlJson<{ total: number; timed: number }>(
    `select json_build_object(
      'total', count(*),
      'timed', count(*) filter (
        where 'timestamptz'::regtype = any (p.proargtypes::regtype[])))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'm2_start_attempt'`,
  );
  expect(overloads).toEqual({ total: 1, timed: 0 });

  const created = await newGuest(depsNow());
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');
  const valid = {
    p_session_id: created.guest.sessionId,
    p_exam_id: latest.examId,
    p_command_id: randomUUID(),
    p_mode: 'training',
    p_purpose: 'normal',
    p_selection: 'all',
    p_source_attempt_id: null,
    p_version_id: latest.versionId,
    p_scope: 'full-exam',
    p_question_ids: ['hoeren-1'],
  };
  const past = '2020-01-01T00:00:00.000Z';
  for (const override of [{ p_now: past }, { p_at: past }]) {
    const { error } = await serviceDb.rpc('m2_start_attempt', {
      ...valid,
      ...override,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('PGRST202');
  }
  // The fixture is not reachable through the Data API either.
  const fixture = await serviceDb.rpc('start_attempt_at', {
    ...valid,
    p_at: past,
  });
  expect(fixture.error).not.toBeNull();

  expect(await readAttempts(created.guest.sessionId)).toEqual([]);
  expect(await readCommandRows(created.guest.sessionId)).toEqual([]);
});

// Submission cutover ---------------------------------------------------------------

const FULL_ORIGIN = 'http://localhost:3102';
const TOTAL = FULL_PILOT.content.questions.length;

const startedOn = async (
  created: CreatedGuest,
  slug: string,
): Promise<string> => {
  const started = await startFor(depsNow(), created.token, slug);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error(`start failed: ${JSON.stringify(started)}`);
  }
  return started.result.attemptId;
};

const submitAll = (
  created: CreatedGuest,
  attemptId: string,
  answers: { questionId: string; optionId: string; revision: number }[],
  commandId: string = randomUUID(),
) =>
  submitAttempt(depsNow(), created.token, {
    attemptId,
    commandId,
    answers,
    confirmation: { phaseRevision: 0, skipped: TOTAL - answers.length },
  });

const sessionOf = (created: CreatedGuest): string => created.guest.sessionId;

const statusRow = (attemptId: string): string =>
  psql(`select status from public.attempts where id = ${quote(attemptId)}`);

const snapshotOf = (attemptId: string): unknown =>
  psqlJson<unknown>(snapshotSql([attemptId]));

const statusRequest = (
  request: APIRequestContext,
  token: string,
  attemptId: string,
) =>
  request.post(`${FULL_ORIGIN}/api/attempts/${attemptId}/status`, {
    headers: {
      'content-type': 'application/json',
      cookie: `${GUEST_COOKIE}=${token}`,
      origin: FULL_ORIGIN,
    },
    data: '{}',
  });

// A copy of the full set whose v1 lacks the key of lesen-7, and a complete
// v2 published afterwards by the trusted owner. Only this exam is touched.
const brokenExam = async () => {
  const slug = `test-broken-${randomUUID().slice(0, 8)}`;
  const { 'lesen-7': _missing, ...partialKeys } = FULL_PILOT.keys;
  const v1 = await insertRawVersion({
    slug,
    content: FULL_PILOT.content,
    keys: partialKeys,
  });
  const publishV2 = async (): Promise<string> => {
    const latest = await latestVersionOf(slug);
    if (!latest) throw new Error('broken exam is missing');
    const version = await serviceDb
      .from('exam_versions')
      .insert({
        exam_id: latest.examId,
        version: 2,
        content: FULL_PILOT.content,
      })
      .select('id')
      .single<{ id: string }>();
    if (version.error) throw version.error;
    const keys = await serviceDb.from('answer_keys').insert(
      Object.entries(FULL_PILOT.keys).map(([questionId, optionId]) => ({
        exam_version_id: version.data.id,
        question_id: questionId,
        correct_option_id: optionId,
      })),
    );
    if (keys.error) throw keys.error;
    return version.data.id;
  };
  return { slug, v1, publishV2 };
};

const ANSWERS = [
  { questionId: 'hoeren-1', optionId: fullKeyOf('hoeren-1'), revision: 1 },
  { questionId: 'lesen-7', optionId: fullKeyOf('lesen-7'), revision: 1 },
];

test('broken submitted result cannot block a new valid start', async () => {
  const exam = await brokenExam();
  const created = await newGuest(depsNow());
  const oldId = await startedOn(created, exam.slug);
  const submitted = await submitAll(created, oldId, ANSWERS);
  expect(submitted).toMatchObject({
    ok: true,
    result: { outcome: 'result-pending', attemptId: oldId },
  });
  expect(statusRow(oldId)).toBe('submitted');
  expect(await readResults(oldId)).toEqual([]);
  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId: oldId,
  });
  expect(status).toMatchObject({
    ok: true,
    result: { outcome: 'result-pending' },
  });

  // The slot is free although the old result cannot be computed.
  const v2 = await exam.publishV2();
  const next = await startFor(depsNow(), created.token, exam.slug, {
    expectedVersionId: v2,
  });
  expect(next).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!next.ok) throw new Error('start failed');
  const newId = next.result.attemptId;
  expect(newId).not.toBe(oldId);
  expect((await readRunRows(newId))[0]?.assignment.versionId).toBe(v2);
  expect(statusRow(newId)).toBe('active');
  expect(statusRow(oldId)).toBe('submitted');
  expect(await readEventKinds(oldId)).toEqual(['start']);
});

test('failed recovery cannot fabricate success or undo accepted new run', async () => {
  const exam = await brokenExam();
  const created = await newGuest(depsNow());
  const oldId = await startedOn(created, exam.slug);
  const commandId = randomUUID();
  await submitAll(created, oldId, ANSWERS, commandId);
  const frozen = await readSubmission(oldId);
  const v2 = await exam.publishV2();
  const newId = await startedOn(created, exam.slug);
  const newRun = await readRunRows(newId);
  const commands = await readCommandRows(created.guest.sessionId);

  // Repeated status, review and replay of the old submission stay pending.
  for (let round = 0; round < 2; round++) {
    expect(
      await readAttemptStatus(depsNow(), created.token, { attemptId: oldId }),
    ).toMatchObject({ ok: true, result: { outcome: 'result-pending' } });
    expect(
      await getAttemptReview(depsNow(), created.token, { attemptId: oldId }),
    ).toEqual({ ok: false, error: 'not-completed' });
    expect(await submitAll(created, oldId, ANSWERS, commandId)).toMatchObject({
      ok: true,
      result: { outcome: 'result-pending' },
    });
  }
  expect(await readSubmission(oldId)).toEqual(frozen);
  expect(await readResults(oldId)).toEqual([]);
  expect(statusRow(oldId)).toBe('submitted');

  // A further start is refused while the new run is active; that run stays.
  expect(
    await startFor(depsNow(), created.token, exam.slug, {
      expectedVersionId: exam.v1,
    }),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: newId },
  });
  expect(await readRunRows(newId)).toEqual(newRun);
  expect(statusRow(newId)).toBe('active');
  expect(await readCommandRows(created.guest.sessionId)).toEqual(commands);
  expect((await readRunRows(newId))[0]?.assignment.versionId).toBe(v2);
});

// A completion of M1 or of the old finish, committed and marked by the
// trusted owner fixture, as the migration marks the stored history.
const historicalOf = async (
  created: CreatedGuest,
): Promise<HistoricalCompletion> => {
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is missing');
  return {
    id: randomUUID(),
    sessionId: created.guest.sessionId,
    examId: latest.examId,
    versionId: latest.versionId,
    scope: 'short-set',
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    completedAt: new Date(Date.now() - 3_600_000).toISOString(),
    answers: {
      'hoeren-1': fullKeyOf('hoeren-1'),
      'hoeren-2': fullWrongOf('hoeren-2'),
    },
    result: { score: 1, maxScore: 45, correct: 1, incorrect: 1, skipped: 43 },
  };
};

const commitMarked = (completion: HistoricalCompletion) =>
  psql(`begin;
    ${historicalCompletionSql(completion)}
    select m2_private.mark_legacy_completed(${quote(completion.id)});
    commit;`);

test('legacy completed without frozen remains readable across submission cutover', async ({
  browser,
  request,
}) => {
  const created = await newGuest(depsNow());
  const completion = await historicalOf(created);
  commitMarked(completion);
  const before = snapshotOf(completion.id);
  const run = await readSubmission(completion.id);
  expect(run).toMatchObject({ legacy_completed: true, frozen_answers: null });

  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId: completion.id,
  });
  expect(status).toMatchObject({
    ok: true,
    result: {
      outcome: 'result-ready',
      answers: completion.answers,
      skipped: 43,
      submittedAt: null,
    },
  });
  const review = await getAttemptReview(depsNow(), created.token, {
    attemptId: completion.id,
  });
  if (!review.ok) throw new Error(`review failed: ${review.error}`);
  // The stored short-set result as it was: no level on a 45-task version.
  expect(review.review).toMatchObject({
    scope: 'short-set',
    showsLevel: false,
    score: 1,
    maxScore: 45,
    correct: 1,
    incorrect: 1,
    skipped: 43,
    level: null,
    skills: null,
  });
  expect(Date.parse(review.review.completedAt)).toBe(
    Date.parse(completion.completedAt),
  );
  expect(review.review.items).toHaveLength(45);

  const http = await statusRequest(request, created.token, completion.id);
  expect(http.status()).toBe(200);
  expect(await http.json()).toMatchObject({
    ok: true,
    result: { outcome: 'result-ready' },
  });

  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: created.token, url: FULL_ORIGIN },
  ]);
  const page = await context.newPage();
  await page.goto(`${FULL_ORIGIN}${attemptUrl(FULL_EXAM.slug, completion.id)}`);
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('result-level')).toHaveCount(0);
  await expect(page.getByTestId('finish-attempt')).toHaveCount(0);
  await context.close();

  // Nothing was scored, finalized or written by reading.
  expect(snapshotOf(completion.id)).toEqual(before);
  expect(await readEventKinds(completion.id)).toEqual(['start', 'finish']);
});

// A new attempt completed past its snapshot by a direct owner write: broken,
// never legacy.
const forceCompleteSql = (attemptId: string): string => `begin;
  alter table public.attempts disable trigger attempts_guard_lifecycle;
  update public.attempts set status = 'completed'
    where id = ${quote(attemptId)};
  alter table public.attempts enable trigger attempts_guard_lifecycle;
  alter table public.attempt_results disable trigger attempt_results_checked;
  insert into public.attempt_results (attempt_id, scope, score, max_score,
    correct_count, incorrect_count, skipped_count, percent, hoeren_score,
    hoeren_max, lesen_score, lesen_max, level)
  values (${quote(attemptId)}, 'full-exam', 0, 45, 0, 0, 45, 0, 0, 20, 0, 25,
    'below-A2');
  alter table public.attempt_results enable trigger attempt_results_checked;
  commit;`;

test('legacy completion exception cannot be forged by runtime or foreign guest', async ({
  request,
}) => {
  // A new completion without its frozen snapshot is broken, not legacy.
  const created = await newGuest(depsNow());
  const forgedId = await startedOn(created, FULL_EXAM.slug);
  const saved = await saveAnswer(depsNow(), created.token, {
    attemptId: forgedId,
    questionId: 'hoeren-1',
    optionId: 'a',
    revision: 1,
  });
  expect(saved.ok).toBe(true);
  psql(forceCompleteSql(forgedId));
  const forgedBefore = snapshotOf(forgedId);
  expect(
    await readAttemptPage(depsNow(), created.guest, FULL_EXAM.slug, forgedId),
  ).toEqual({ status: 'incompatible' });
  expect(
    await readAttemptStatus(depsNow(), created.token, { attemptId: forgedId }),
  ).toEqual({ ok: false, failure: 'unavailable' });
  expect(
    await getAttemptReview(depsNow(), created.token, { attemptId: forgedId }),
  ).toEqual({ ok: false, error: 'unavailable' });
  const http = await statusRequest(request, created.token, forgedId);
  expect(http.status()).toBe(503);
  expect(snapshotOf(forgedId)).toEqual(forgedBefore);

  // The runtime cannot set the mark: not through a command, a table or the
  // owner helper.
  const fresh = await newGuest(depsNow());
  const freshId = await startedOn(fresh, FULL_EXAM.slug);
  const viaCommand = await submitAttempt(depsNow(), fresh.token, {
    attemptId: freshId,
    commandId: randomUUID(),
    answers: [],
    confirmation: { phaseRevision: 0, skipped: TOTAL },
    legacyCompleted: true,
  });
  expect(viaCommand).toEqual({ ok: false, failure: 'invalid-input' });
  const viaTable = await serviceDb
    .from('attempt_runs')
    .update({ legacy_completed: true })
    .eq('attempt_id', forgedId);
  expect(viaTable.error?.code).toBe('42501');
  const viaHelper = await serviceDb.rpc('mark_legacy_completed', {
    p_attempt_id: forgedId,
  });
  expect(viaHelper.error).not.toBeNull();
  expect(
    psql(`select has_function_privilege('service_role',
      'm2_private.mark_legacy_completed(uuid)', 'execute')`),
  ).toBe('f');
  expect((await readSubmission(forgedId)).legacy_completed).toBe(false);
  expect(statusRow(freshId)).toBe('active');

  // A foreign guest reads nothing of a real legacy completion.
  const owner = await newGuest(depsNow());
  const completion = await historicalOf(owner);
  commitMarked(completion);
  const legacyBefore = snapshotOf(completion.id);
  const stranger = await newGuest(depsNow());
  expect(
    await readAttemptStatus(depsNow(), stranger.token, {
      attemptId: completion.id,
    }),
  ).toEqual({ ok: false, failure: 'not-found' });
  expect(
    await getAttemptReview(depsNow(), stranger.token, {
      attemptId: completion.id,
    }),
  ).toEqual({ ok: false, error: 'attempt-not-found' });
  expect(
    await readAttemptPage(
      depsNow(),
      stranger.guest,
      FULL_EXAM.slug,
      completion.id,
    ),
  ).toEqual({ status: 'not-found' });
  expect(snapshotOf(completion.id)).toEqual(legacyBefore);
});

const guestSql = (id: string): string =>
  `insert into public.guest_sessions (id, token_hash, locale, created_at,
    expires_at)
  values (${quote(id)}, md5(${quote(id)}) || md5(${quote(id)} || 'x'), 'en',
    now(), now() + interval '720 hours');`;

test('legacy marker only classifies eligible stored historical completions', async () => {
  const pilot = await latestVersionOf(PILOT_EXAM_SLUG);
  if (!pilot) throw new Error('pilot is missing');
  const { data, error } = await serviceDb
    .from('exam_versions')
    .select('content')
    .eq('id', pilot.versionId)
    .single<{ content: { questions: { id: string }[] } }>();
  if (error) throw error;
  const count = data.content.questions.length;
  const ids = {
    eligible: randomUUID(),
    active: randomUUID(),
    submitted: randomUUID(),
    cancelled: randomUUID(),
    frozen: randomUUID(),
    noResult: randomUUID(),
    noRun: randomUUID(),
  };
  // One guest per attempt: the slot holds one active attempt per exam.
  const sessions = Object.fromEntries(
    Object.values(ids).map((id) => [id, randomUUID()]),
  );
  const sessionOf = (id: string): string => sessions[id] ?? '';
  const base = {
    examId: pilot.examId,
    versionId: pilot.versionId,
    scope: 'short-set' as const,
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    completedAt: new Date(Date.now() - 3_600_000).toISOString(),
    answers: {},
  };
  const result = {
    score: 0,
    maxScore: count,
    correct: 0,
    incorrect: 0,
    skipped: count,
  };
  const runtime = (id: string) =>
    `insert into public.attempts (id, guest_session_id, exam_id,
      exam_version_id, scope) values (${quote(id)}, ${quote(sessionOf(id))},
      ${quote(pilot.examId)}, ${quote(pilot.versionId)}, 'short-set');
    select * from m2_private.backfill_m1_attempts(${quote(id)});`;
  const accept = (id: string) =>
    `select * from m2_private.accept_submission(${quote(sessionOf(id))},
      ${quote(id)}, gen_random_uuid(), '[]', 0, ${count}, clock_timestamp());`;
  const all = Object.values(ids);
  const mark = (key: string, id: string) =>
    `insert into pg_temp.summary values (${quote(key)},
      to_jsonb(m2_private.mark_legacy_completed(${quote(id)})));`;
  const keep = (key: string) =>
    `insert into pg_temp.summary values (${quote(key)},
      (${snapshotSql(all)}));`;
  const summary = psqlJson<Record<string, unknown>>(
    [
      'begin;',
      'create temp table summary (key text primary key, value jsonb);',
      ...Object.values(sessions).map(guestSql),
      historicalCompletionSql({
        ...base,
        id: ids.eligible,
        sessionId: sessionOf(ids.eligible),
        result,
      }),
      runtime(ids.active),
      runtime(ids.submitted),
      accept(ids.submitted),
      runtime(ids.cancelled),
      `update public.attempts set status = 'cancelled'
        where id = ${quote(ids.cancelled)};`,
      runtime(ids.frozen),
      accept(ids.frozen),
      `select public.m2_finalize_attempt(${quote(sessionOf(ids.frozen))},
        ${quote(ids.frozen)}, 'short-set', 0, ${count}, 0, 0, ${count}, 0,
        null, null, null, null, null);`,
      historicalCompletionSql({
        ...base,
        id: ids.noResult,
        sessionId: sessionOf(ids.noResult),
        result: null,
      }),
      `insert into public.attempts (id, guest_session_id, exam_id,
        exam_version_id, scope, status) values (${quote(ids.noRun)},
        ${quote(sessionOf(ids.noRun))}, ${quote(pilot.examId)},
        ${quote(pilot.versionId)}, 'short-set', 'completed');`,
      keep('before'),
      ...Object.entries(ids)
        .filter(([key]) => key !== 'eligible')
        .map(([key, id]) => mark(key, id)),
      keep('afterIneligible'),
      mark('eligible', ids.eligible),
      mark('repeated', ids.eligible),
      keep('after'),
      'select jsonb_object_agg(key, value) from pg_temp.summary;',
      'rollback;',
    ].join('\n'),
  );
  for (const key of Object.keys(ids).filter((name) => name !== 'eligible')) {
    expect(summary[key], key).toBe(0);
  }
  expect(summary.afterIneligible).toEqual(summary.before);
  expect(summary.eligible).toBe(1);
  expect(summary.repeated).toBe(0);
  const before = summary.before as Record<string, unknown>;
  const after = summary.after as Record<
    string,
    { run: { legacy_completed: boolean } | null; result: unknown }
  >;
  for (const id of all) {
    const isEligible = id === ids.eligible;
    expect(after[id]?.run?.legacy_completed ?? false, id).toBe(isEligible);
    if (!isEligible) expect(after[id], id).toEqual(before[id]);
  }
  const eligibleBefore = before[ids.eligible] as { result: unknown };
  expect(after[ids.eligible]?.result).toEqual(eligibleBefore.result);
  expect(
    psql(`select count(*) from public.attempts
      where id in (${all.map(quote).join(', ')})`),
  ).toBe('0');
});

test('runtime direct writes cannot forge or unset legacy completion marker', async () => {
  const owner = await newGuest(depsNow());
  const completion = await historicalOf(owner);
  commitMarked(completion);
  const runtimeId = await startedOn(await newGuest(depsNow()), FULL_EXAM.slug);
  const runless = await insertActiveAttempt(
    (await newGuest(depsNow())).guest.sessionId,
    completion.versionId,
    'short-set',
  );
  const ids = [completion.id, runtimeId, runless];
  const before = ids.map(snapshotOf);

  const inserted = await serviceDb.from('attempt_runs').insert({
    attempt_id: runless,
    mode: 'training',
    purpose: 'normal',
    selection: 'all',
    assignment: {
      versionId: completion.versionId,
      questionIds: FULL_PILOT.content.questions.map((item) => item.id),
    },
    accepted_at: new Date().toISOString(),
    legacy_completed: true,
  });
  expect(inserted.error?.code).toBe('42501');
  const updates: [string, boolean][] = [
    [runtimeId, true],
    [completion.id, false],
    [completion.id, true],
  ];
  for (const [attemptId, value] of updates) {
    const updated = await serviceDb
      .from('attempt_runs')
      .update({ legacy_completed: value })
      .eq('attempt_id', attemptId);
    expect(updated.error?.code, `${attemptId} ${value}`).toBe('42501');
  }
  expect(ids.map(snapshotOf)).toEqual(before);

  // Even the owner cannot unset the mark, insert a marked run or mark an
  // attempt that is not a stored completion; only the helper classifies a
  // stored completion, from false to true.
  const tried = (key: string, sql: string) => `begin
      ${sql}
      insert into pg_temp.summary values (${quote(key)}, '"written"');
    exception when others then
      insert into pg_temp.summary values (${quote(key)}, to_jsonb(sqlerrm));
    end;`;
  const owned = psqlJson<Record<string, unknown>>(`begin;
    create temp table summary (key text primary key, value jsonb);
    do $$
    begin
      ${tried(
        'unset',
        `update public.attempt_runs set legacy_completed = false
          where attempt_id = ${quote(completion.id)};`,
      )}
      ${tried(
        'insert',
        `insert into public.attempt_runs (attempt_id, mode, purpose,
          selection, assignment, accepted_at, legacy_completed)
        values (${quote(runless)}, 'training', 'normal', 'all',
          jsonb_build_object('versionId', ${quote(completion.versionId)},
            'questionIds', jsonb_build_array('hoeren-1')), now(), true);`,
      )}
      ${tried(
        'active',
        `update public.attempt_runs set legacy_completed = true
          where attempt_id = ${quote(runtimeId)};`,
      )}
    end;
    $$;
    ${forceCompleteSql(runtimeId).replace('begin;', '').replace('commit;', '')}
    insert into pg_temp.summary values ('marked',
      to_jsonb(m2_private.mark_legacy_completed(${quote(runtimeId)})));
    insert into pg_temp.summary values ('flag', (select to_jsonb(
      legacy_completed) from public.attempt_runs
      where attempt_id = ${quote(runtimeId)}));
    select jsonb_object_agg(key, value) from pg_temp.summary;
    rollback;`);
  expect(owned).toEqual({
    unset: 'a legacy mark is final',
    insert: 'a new run starts open',
    active: 'only a stored completion without a snapshot is legacy',
    marked: 1,
    flag: true,
  });
  expect(ids.map(snapshotOf)).toEqual(before);
  expect(await readResults(completion.id)).toHaveLength(1);
});

// Timed block (#43) ----------------------------------------------------------------

// The deadline of a timed run is judged by the database clock after the
// lock, the same way by the kernel with an explicit moment and by the
// production functions with clock_timestamp(). Each exam has its own slug,
// recording and short confirmed profile; test-full-dtz is not touched.

const SECOND_MS = 1000;
const owner = sqlRunnerAs('owner');

const TIMED_HOEREN_IDS = FULL_PILOT.content.questions
  .filter((question) => question.skill === 'hoeren')
  .map((question) => question.id);

// Long enough to hold a row lock and queue requests before the deadline.
const LOCK_TIMING: TimingSettings = { ...SHORT_TIMING, hoerenSeconds: 8 };

interface TimedExam {
  slug: string;
  examId: string;
  versionId: string;
}

const publishTimedExam = async (
  settings: TimingSettings,
): Promise<TimedExam> => {
  const slug = `test-timed-${randomUUID().slice(0, 8)}`;
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: 'Timed lifecycle test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(587) }],
  });
  ensureConfirmedTestProfile(owner, outcome.versionId, settings);
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error('timed exam is missing');
  return { slug, examId: latest.examId, versionId: latest.versionId };
};

interface TimedStarted {
  attemptId: string;
  deadlineMs: number;
}

const timedStartedOn = async (
  created: CreatedGuest,
  slug: string,
): Promise<TimedStarted> => {
  const started = await startFor(depsNow(), created.token, slug, {
    mode: 'timed-block',
    selection: 'hoeren',
  });
  if (!started.ok || started.result.state.deadlineMs === null) {
    throw new Error(`timed start failed: ${JSON.stringify(started)}`);
  }
  return {
    attemptId: started.result.attemptId,
    deadlineMs: started.result.state.deadlineMs,
  };
};

// How long before a deadline or expiry the lock tests take the lock.
const LOCK_LEAD_MS = 3000;

const pause = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// The database and the test share the host; a small margin covers the rest.
const waitPast = (moment: number, marginMs = 400) =>
  pause(moment - Date.now() + marginMs);

const iso = (ms: number): string => new Date(ms).toISOString();

interface KernelVector {
  save: string;
  submit: string;
  closed: boolean;
}

// One rolled-back transaction: a timed start at startMs through the kernel,
// then a save, a submission and a status read at atMs. A refusal is its
// hint; an admitted write is "written".
const kernelVector = (
  sessionId: string,
  exam: TimedExam,
  startMs: number,
  atMs: number,
): KernelVector =>
  psqlJson<KernelVector>(`begin;
    create temp table summary (key text primary key, value jsonb);
    do $$
    declare
      v_attempt uuid;
      v_hint text;
      v_outcome text;
    begin
      select s.attempt_id into v_attempt from m2_test.start_attempt_at(
        ${quote(sessionId)}, ${quote(exam.examId)}, gen_random_uuid(),
        'timed-block', 'normal', 'hoeren', null, ${quote(exam.versionId)},
        'short-set', ${quote(JSON.stringify(TIMED_HOEREN_IDS))}::jsonb,
        ${quote(iso(startMs))}::timestamptz) s;
      begin
        perform m2_test.save_answer_at(${quote(sessionId)}, v_attempt,
          'hoeren-1', ${quote(fullKeyOf('hoeren-1'))}, 1,
          ${quote(iso(atMs))}::timestamptz);
        insert into pg_temp.summary values ('save', '"written"');
      exception when others then
        get stacked diagnostics v_hint = pg_exception_hint;
        insert into pg_temp.summary values ('save', to_jsonb(v_hint));
      end;
      -- The submission is undone after its answer, so the status read
      -- below sees the run as the save left it.
      begin
        select s.outcome into v_outcome
        from m2_test.accept_submission_at(${quote(sessionId)}, v_attempt,
          gen_random_uuid(), '[]'::jsonb, 0, 19,
          ${quote(iso(atMs))}::timestamptz) s;
        raise exception 'undo';
      exception when others then
        if sqlerrm = 'undo' then
          insert into pg_temp.summary values ('submit', to_jsonb(v_outcome));
        else
          get stacked diagnostics v_hint = pg_exception_hint;
          insert into pg_temp.summary values ('submit', to_jsonb(v_hint));
        end if;
      end;
      insert into pg_temp.summary select 'closed', to_jsonb(r.closed)
      from m2_test.reconcile_attempt_at(${quote(sessionId)}, v_attempt,
        ${quote(iso(atMs))}::timestamptz) r;
    end;
    $$;
    select jsonb_object_agg(key, value) from pg_temp.summary;
    rollback;`);

test('timed admission uses post lock server deadline', async () => {
  const exam = await publishTimedExam(LOCK_TIMING);
  const durationMs = LOCK_TIMING.hoerenSeconds * SECOND_MS;
  const created = await newGuest(depsNow());

  // The kernel before, exactly at and after the deadline: only a write
  // before it is admitted; at it the run is closed.
  const startMs = Date.now() - 2 * SECOND_MS;
  const deadlineMs = startMs + durationMs;
  expect(
    kernelVector(sessionOf(created), exam, startMs, deadlineMs - 1),
  ).toEqual({ save: 'written', submit: 'accepted', closed: false });
  for (const atMs of [deadlineMs, deadlineMs + 1]) {
    expect(kernelVector(sessionOf(created), exam, startMs, atMs)).toEqual({
      save: 'phase_closed',
      submit: 'closed-phase',
      closed: true,
    });
  }
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  // The production save: accepted before the deadline by its own clock.
  const started = await timedStartedOn(created, exam.slug);
  const run = (await readRunRows(started.attemptId))[0];
  expect(Date.parse(run?.accepted_at ?? '') + durationMs).toBe(
    started.deadlineMs,
  );
  const key = fullKeyOf('hoeren-1');
  expect(
    await saveAnswer(depsNow(), created.token, {
      attemptId: started.attemptId,
      questionId: 'hoeren-1',
      optionId: key,
      revision: 1,
    }),
  ).toMatchObject({ ok: true, revision: 1 });

  // A save sent before the deadline waits for the row until after it: the
  // time is read again after the lock and the save is refused.
  // A request waits on the lock only for the last seconds before the
  // moment: the API roles have a statement timeout of 8 seconds.
  await waitPast(started.deadlineMs - LOCK_LEAD_MS, 0);
  const lock = await holdAttemptLock(started.attemptId);
  let late: unknown = null;
  try {
    const pending = serviceDb.rpc('m2_save_answer', {
      p_session_id: sessionOf(created),
      p_attempt_id: started.attemptId,
      p_question_id: 'hoeren-1',
      p_option_id: fullWrongOf('hoeren-1'),
      p_revision: 2,
    });
    const settled = Promise.resolve(pending);
    await expect.poll(() => waitersBehind(lock, 'm2_save_answer')).toBe(1);
    expect(Date.now()).toBeLessThan(started.deadlineMs);
    await waitPast(started.deadlineMs);
    await lock.release();
    late = await settled;
  } finally {
    await lock.release();
  }
  expect(late).toMatchObject({ error: { hint: 'phase_closed' } });
  expect(await readAnswerRows(started.attemptId)).toEqual([
    { question_id: 'hoeren-1', option_id: key, revision: 1 },
  ]);
  // Still active in the table until a dependent operation closes it; the
  // status closes it with the answer accepted in time.
  expect(statusRow(started.attemptId)).toBe('active');
  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId: started.attemptId,
  });
  expect(status).toMatchObject({
    ok: true,
    result: {
      outcome: 'result-ready',
      isClosedByDeadline: true,
      answers: { 'hoeren-1': key },
      state: { phase: 'closed' },
    },
  });
});

test('new start reconciles expired attempt without a worker', async () => {
  const exam = await publishTimedExam(SHORT_TIMING);
  const created = await newGuest(depsNow());
  const old = await timedStartedOn(created, exam.slug);
  const key = fullKeyOf('hoeren-1');
  expect(
    (
      await saveAnswer(depsNow(), created.token, {
        attemptId: old.attemptId,
        questionId: 'hoeren-1',
        optionId: key,
        revision: 1,
      })
    ).ok,
  ).toBe(true);

  // Nobody opens the page or asks for the status: the next start of the
  // exam closes the expired run, frees the slot and scores it once.
  await waitPast(old.deadlineMs);
  expect(statusRow(old.attemptId)).toBe('active');
  const next = await startFor(depsNow(), created.token, exam.slug);
  expect(next).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!next.ok) throw new Error('start failed');
  const newId = next.result.attemptId;
  expect(newId).not.toBe(old.attemptId);
  expect(statusRow(newId)).toBe('active');
  expect(statusRow(old.attemptId)).toBe('completed');
  const submission = await readSubmission(old.attemptId);
  expect(submission).toMatchObject({
    frozen_answers: { 'hoeren-1': { optionId: key, revision: 1 } },
    submit_command_id: null,
  });
  expect(Date.parse(submission.submission_accepted_at ?? '')).toBe(
    old.deadlineMs,
  );
  const results = await readResults(old.attemptId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ score: 1, max_score: 20, level: null });
  expect(await readEventKinds(old.attemptId)).toEqual(['start', 'finish']);

  // Repeated starts and reads do not score the old run a second time.
  expect(await startFor(depsNow(), created.token, exam.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: newId },
  });
  expect(
    await readAttemptStatus(depsNow(), created.token, {
      attemptId: old.attemptId,
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'result-ready' } });
  expect(await readResults(old.attemptId)).toEqual(results);
  expect(await readEventKinds(old.attemptId)).toEqual(['start', 'finish']);
});

// A guest session ending the given seconds after the database clock, with a
// token the test knows.
const endingGuest = async (seconds: number): Promise<CreatedGuest> => {
  const token = randomBytes(32).toString('base64url');
  psql(`select m2_test.insert_guest_ending_in(
    ${quote(hashGuestToken(token))}, ${seconds})`);
  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('guest is not active');
  return { token, guest };
};

test('guest expiry while waiting lock is enforced by production rpc', async () => {
  const created = await endingGuest(8);
  const expiresMs = created.guest.expiresAt.getTime();
  const attemptId = await startedOn(created, FULL_EXAM.slug);
  const pilot = await latestVersionOf(PILOT_EXAM_SLUG);
  if (!pilot) throw new Error('pilot is missing');

  // A save and a start pass the Node check of the guest, then wait for
  // their locks until the term is over.
  // A request waits on the lock only for the last seconds before the
  // moment: the API roles have a statement timeout of 8 seconds.
  await waitPast(expiresMs - LOCK_LEAD_MS, 0);
  const rowLock = await holdAttemptLock(attemptId);
  const slotLock = await holdSlotLock(sessionOf(created), pilot.examId);
  let saved: unknown = null;
  let started: unknown = null;
  try {
    const save = saveAnswer(depsNow(), created.token, {
      attemptId,
      questionId: 'hoeren-1',
      optionId: fullKeyOf('hoeren-1'),
      revision: 1,
    });
    const start = startFor(depsNow(), created.token, PILOT_EXAM_SLUG);
    await expect.poll(() => waitersBehind(rowLock, 'm2_save_answer')).toBe(1);
    await expect
      .poll(() => slotWaiters(sessionOf(created), pilot.examId))
      .toBe(1);
    expect(Date.now()).toBeLessThan(expiresMs);
    await waitPast(expiresMs);
    await rowLock.release();
    await slotLock.release();
    [saved, started] = await Promise.all([save, start]);
  } finally {
    await rowLock.release();
    await slotLock.release();
  }
  expect(saved).toEqual({ ok: false, error: 'session-invalid' });
  expect(started).toEqual({ ok: false, failure: 'session-invalid' });
  expect(await readAttempts(sessionOf(created))).toEqual([
    { id: attemptId, status: 'active' },
  ]);
  expect(await readAnswerRows(attemptId)).toEqual([]);
  expect(await readEventKinds(attemptId)).toEqual(['start']);
  expect(await readResults(attemptId)).toEqual([]);
});

// The key of one assigned task removed from the closed key of this exam
// only, by the owner of the isolated test database.
const breakKeyOf = (versionId: string, questionId: string) =>
  psql(`begin;
    alter table public.answer_keys disable trigger answer_keys_immutable;
    delete from public.answer_keys
    where exam_version_id = ${quote(versionId)}
      and question_id = ${quote(questionId)};
    alter table public.answer_keys enable trigger answer_keys_immutable;
    commit;`);

test('grading failure does not retain active slot or fabricate result', async () => {
  const exam = await publishTimedExam(LOCK_TIMING);
  breakKeyOf(exam.versionId, 'hoeren-3');
  const created = await newGuest(depsNow());
  const old = await timedStartedOn(created, exam.slug);
  const key = fullKeyOf('hoeren-1');
  expect(
    (
      await saveAnswer(depsNow(), created.token, {
        attemptId: old.attemptId,
        questionId: 'hoeren-1',
        optionId: key,
        revision: 1,
      })
    ).ok,
  ).toBe(true);
  await waitPast(old.deadlineMs);

  // A save holds the row of the expired run; the new start takes the slot,
  // then waits for that row, never the other way round.
  const lock = await holdAttemptLock(old.attemptId);
  let next: Awaited<ReturnType<typeof startFor>> | null = null;
  try {
    const start = startFor(depsNow(), created.token, exam.slug);
    await expect.poll(() => waitersBehind(lock, 'm2_start_attempt')).toBe(1);
    await lock.release();
    next = await start;
  } finally {
    await lock.release();
  }
  expect(next).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!next?.ok) throw new Error('start failed');
  const newId = next.result.attemptId;
  expect(statusRow(newId)).toBe('active');

  // The old run is closed with the answer accepted in time, without a result
  // and without a finish; it is never reopened.
  expect(statusRow(old.attemptId)).toBe('submitted');
  expect((await readSubmission(old.attemptId)).frozen_answers).toEqual({
    'hoeren-1': { optionId: key, revision: 1 },
  });
  for (let round = 0; round < 2; round++) {
    expect(
      await readAttemptStatus(depsNow(), created.token, {
        attemptId: old.attemptId,
      }),
    ).toMatchObject({
      ok: true,
      result: { outcome: 'result-pending', isClosedByDeadline: true },
    });
  }
  expect(await readResults(old.attemptId)).toEqual([]);
  expect(await readEventKinds(old.attemptId)).toEqual(['start']);
  expect(statusRow(old.attemptId)).toBe('submitted');
  expect(await startFor(depsNow(), created.token, exam.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: newId },
  });
});

test('timed phase gate and domain sql boundary parity are enforced', async () => {
  const created = await newGuest(depsNow());
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');

  // The full exam (#45) is always the whole set: one skill or a short scope
  // is refused by the server, the production RPC and the kernel, and
  // nothing is created.
  expect(
    await startFor(depsNow(), created.token, FULL_EXAM.slug, {
      mode: 'exam',
      selection: 'hoeren',
    }),
  ).toEqual({ ok: false, failure: 'invalid-input' });
  const allIds = FULL_PILOT.content.questions.map((question) => question.id);
  const direct = await serviceDb.rpc('m2_start_attempt', {
    p_session_id: sessionOf(created),
    p_exam_id: latest.examId,
    p_command_id: randomUUID(),
    p_mode: 'exam',
    p_purpose: 'normal',
    p_selection: 'all',
    p_source_attempt_id: null,
    p_version_id: latest.versionId,
    p_scope: 'short-set',
    p_question_ids: allIds,
  });
  expect(direct.error?.hint).toBe('start_invalid');
  const hoerenIds = FULL_PILOT.content.questions
    .filter((question) => question.skill === 'hoeren')
    .map((question) => question.id);
  expect(() =>
    psql(`select * from m2_test.start_attempt_at(
      ${quote(sessionOf(created))}, ${quote(latest.examId)},
      gen_random_uuid(), 'exam', 'normal', 'hoeren', null,
      ${quote(latest.versionId)}, 'short-set',
      ${quote(JSON.stringify(hoerenIds))}::jsonb, clock_timestamp())`),
  ).toThrow(/start_invalid/);
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  // The same boundary vectors through the domain lifecycle and the SQL
  // kernel give the same admission and phase.
  const exam = await publishTimedExam(SHORT_TIMING);
  const durationMs = SHORT_TIMING.hoerenSeconds * SECOND_MS;
  const startMs = Date.now() - SECOND_MS;
  const input = {
    mode: 'timed-block',
    selection: 'hoeren',
    status: 'active',
    startedAtMs: startMs,
    durations: {
      hoerenMs: durationMs,
      transitionMs: SHORT_TIMING.transitionSeconds * SECOND_MS,
      lesenMs: SHORT_TIMING.lesenSeconds * SECOND_MS,
    },
    closedSkills: [],
    lesenStartedAtMs: null,
  };
  for (const offsetMs of [-durationMs + 1, -1, 0, 1, SECOND_MS]) {
    const atMs = startMs + durationMs + offsetMs;
    const domain = admitOperation(
      input,
      { kind: 'answer', skill: 'hoeren' },
      atMs,
    );
    const phase = resolveLifecycle(input, atMs);
    const sql = kernelVector(sessionOf(created), exam, startMs, atMs);
    const isOpen = domain.ok;
    expect(sql.save === 'written', `save at ${offsetMs}`).toBe(isOpen);
    expect(sql.closed, `closed at ${offsetMs}`).toBe(!isOpen);
    expect(sql.submit, `submit at ${offsetMs}`).toBe(
      isOpen ? 'accepted' : 'closed-phase',
    );
    expect(phase.ok && phase.state.phase, `phase at ${offsetMs}`).toBe(
      isOpen ? 'hoeren' : 'closed',
    );
    if (!domain.ok) expect(domain.reason).toBe('closed-phase');
  }
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  // The functions of the timed block: the runtime status read only for
  // service_role, the kernels and helpers for no API role, none for PUBLIC,
  // and no production function takes a time.
  const runtime = 'public.m2_reconcile_attempt(uuid, uuid)';
  const kernels = [
    'm2_private.run_deadline(public.attempt_runs)',
    'm2_private.timely_answers(public.attempt_runs, timestamptz)',
    'm2_private.close_expired(uuid, timestamptz)',
    'm2_private.reconcile_attempt(uuid, uuid, timestamptz)',
    `m2_private.admit_start(${START_SIGNATURE}, timestamptz)`,
  ];
  const start = `public.m2_start_attempt(${START_SIGNATURE})`;
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of [runtime, start, ...kernels]) {
      const isRuntime = fn === runtime || fn === start;
      expect(
        psql(`select has_function_privilege(${quote(role)}, ${quote(fn)},
          'execute')`),
        `${role} ${fn}`,
      ).toBe(isRuntime && role === 'service_role' ? 't' : 'f');
    }
  }
  expect(
    psql(`select count(*) from pg_proc p,
      aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      where x.grantee = 0 and p.oid in (${[runtime, start, ...kernels]
        .map((fn) => `${quote(fn)}::regprocedure`)
        .join(', ')})`),
  ).toBe('0');
  expect(
    psql(`select string_agg(prosecdef::text || ':' ||
      array_to_string(proconfig, ','), ' ' order by oid)
      from pg_proc where oid in (${quote(runtime)}::regprocedure,
        ${quote(start)}::regprocedure)`),
  ).toBe('true:search_path="" true:search_path=""');
  const anonymous = await createPublicClient().rpc('m2_reconcile_attempt', {
    p_session_id: sessionOf(created),
    p_attempt_id: randomUUID(),
  });
  expect(anonymous.error?.code).toBe('42501');
  const withTime = await serviceDb.rpc('m2_reconcile_attempt', {
    p_session_id: sessionOf(created),
    p_attempt_id: randomUUID(),
    p_at: new Date(0).toISOString(),
  });
  expect(withTime.error?.code).toBe('PGRST202');
});
