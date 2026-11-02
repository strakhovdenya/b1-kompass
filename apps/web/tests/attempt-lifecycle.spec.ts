import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAttempts,
  readCommandRows,
  readRunRows,
  serviceDb,
  startFor,
} from './support/db';
import { FULL_EXAM } from './support/full-exam';
import {
  DB_CONTAINER,
  installM2Fixtures,
  localTarget,
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
