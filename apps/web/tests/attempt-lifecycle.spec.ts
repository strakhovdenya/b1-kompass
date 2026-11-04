import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import {
  getAttemptReview,
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
  submitAttempt,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import {
  depsNow,
  insertActiveAttempt,
  insertRawVersion,
  latestVersionOf,
  newGuest,
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
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import { attemptUrl } from './support/guest-browser';
import { historicalCompletionSql, snapshotSql } from './support/legacy-attempt';
import type { HistoricalCompletion } from './support/legacy-attempt';
import {
  DB_CONTAINER,
  installM2Fixtures,
  localTarget,
  psql,
  psqlJson,
  quote,
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
