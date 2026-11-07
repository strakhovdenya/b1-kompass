import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { hashGuestToken } from '../src/server/guest-session/session';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttempts,
  readCommandRows,
  readEventKinds,
  readResults,
  serviceDb,
  startFor,
} from './support/db';
import { readTestSupabaseEnv } from './support/env';
import { FULL_EXAM, FULL_PILOT, FULL_TIMING } from './support/full-exam';
import { postCommand } from './support/guest-browser';
import {
  DB_CONTAINER,
  assertLocalTarget,
  installM2Fixtures,
  psql,
  psqlJson,
  quote,
  secondsAgoSql,
  startExamAt,
} from './support/sql';

// The production boundary (#48). The wrappers of tests/support/m2-fixtures.sql
// are installed in the isolated test database on purpose; what is checked is
// that nothing of the production paths knows them: the migration graph, the
// sources that run, the compiled server and the browser bundles, and that no
// caller can hand the production code a time. Real cloud grants and RLS are
// not covered here: they need their own evidence from the real project.

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const WEB = path.join(REPO_ROOT, 'apps', 'web');
const SECOND_MS = 1000;

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

const relative = (file: string): string =>
  path.relative(REPO_ROOT, file).replaceAll('\\', '/');

const isSource = (file: string): boolean =>
  /\.(?:[cm]?[jt]sx?|json|sql|toml)$/.test(file);

const isTestFile = (file: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(file);

const TEST_MARKERS = ['m2_test', 'm2-fixtures'];

const expectNoMarker = (files: readonly string[], markers: string[]) => {
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const marker of markers) {
      expect(
        text.includes(marker),
        `${relative(file)} contains ${marker}`,
      ).toBe(false);
    }
  }
};

// Directories whose files may run in production or reach the browser.
const productionSources = (): string[] =>
  [
    path.join(REPO_ROOT, 'supabase', 'migrations'),
    path.join(WEB, 'src'),
    path.join(REPO_ROOT, 'packages', 'domain', 'src'),
    path.join(REPO_ROOT, 'scripts'),
  ]
    .filter((directory) => existsSync(directory))
    .flatMap(filesUnder)
    .filter((file) => isSource(file) && !isTestFile(file));

// A file of a browser bundle: a client component, the theme and the
// translations.
const clientSources = (): string[] =>
  [path.join(WEB, 'src', 'features'), path.join(WEB, 'src', 'theme')]
    .flatMap(filesUnder)
    .filter((file) => !isTestFile(file));

test('production paths exclude test clocks wrappers and privileged clients', async () => {
  // The migration graph and every source that runs know no wrapper and do not
  // import anything of the test support.
  const sources = productionSources();
  expect(sources.length).toBeGreaterThan(50);
  expectNoMarker(sources, TEST_MARKERS);
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    expect(/from\s+['"][^'"]*\/tests\//.test(text), relative(file)).toBe(false);
    expect(/import\(\s*['"][^'"]*\/tests\//.test(text), relative(file)).toBe(
      false,
    );
  }
  expect(
    readdirSync(path.join(REPO_ROOT, 'supabase', 'migrations')).length,
  ).toBeGreaterThan(0);

  // The privileged client is for the server and the owner tools: the
  // browser-side directories import neither it nor the Supabase SDK.
  for (const file of clientSources().filter(isSource)) {
    const text = readFileSync(file, 'utf8');
    expect(text.includes('@supabase/'), relative(file)).toBe(false);
    expect(
      /from\s+['"]\.{1,2}\/[^'"]*\/server(?:\/|['"])/.test(text),
      relative(file),
    ).toBe(false);
    expect(text.includes('SUPABASE_SECRET_KEY'), relative(file)).toBe(false);
  }

  // The build the E2E servers run: the browser bundles hold no wrapper, no
  // secret key and no name of the privileged key; the server build holds no
  // wrapper either.
  const built = path.join(WEB, '.next');
  expect(existsSync(built), 'run `npm run build` before the E2E').toBe(true);
  const secret = readTestSupabaseEnv().secretKey;
  const bundles = filesUnder(path.join(built, 'static')).filter((file) =>
    /\.(?:js|css|html|json|map)$/.test(file),
  );
  expect(bundles.length).toBeGreaterThan(0);
  for (const file of bundles) {
    const text = readFileSync(file, 'utf8');
    for (const forbidden of [
      ...TEST_MARKERS,
      'SUPABASE_SECRET_KEY',
      'service_role',
      secret,
    ]) {
      expect(text.includes(forbidden), `${relative(file)}: ${forbidden}`).toBe(
        false,
      );
    }
  }
  const compiled = filesUnder(path.join(built, 'server')).filter((file) =>
    /\.(?:js|json)$/.test(file),
  );
  expect(compiled.length).toBeGreaterThan(0);
  expectNoMarker(compiled, TEST_MARKERS);

  // The wrappers exist in this database (the E2E installed them) but are not
  // reachable by any API role or through the Data API.
  installM2Fixtures();
  const reach = psqlJson<Record<string, boolean>>(
    `select json_object_agg(r.role, has_schema_privilege(r.role, 'm2_test', 'usage'))
     from (values ('anon'), ('authenticated'), ('service_role')) r (role)`,
  );
  expect(reach).toEqual({
    anon: false,
    authenticated: false,
    service_role: false,
  });
  const hidden = await serviceDb
    .schema('m2_test' as 'public')
    .rpc('start_attempt_at', { p_at: '2020-01-01T00:00:00.000Z' });
  expect(hidden.error).not.toBeNull();
  expect(hidden.error?.code).toBe('PGRST106');

  // The production functions of M2 take no time. Any other function that
  // does is for the server, which calls it with its own clock: no API role
  // may execute it, so no request can hand it a time.
  const timed = psqlJson<{ name: string; timed: boolean; isOpen: boolean }[]>(
    `select json_agg(json_build_object('name', p.proname, 'timed',
      'timestamptz'::regtype = any (p.proargtypes::regtype[]),
      'isOpen', has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'`,
  );
  expect(timed.filter((fn) => fn.name.startsWith('m2_') && fn.timed)).toEqual(
    [],
  );
  expect(timed.filter((fn) => fn.timed).length).toBeGreaterThan(0);
  expect(timed.filter((fn) => fn.timed && fn.isOpen)).toEqual([]);

  // The installer works on the isolated local database only.
  const local = { url: readTestSupabaseEnv().url, container: DB_CONTAINER };
  expect(() => assertLocalTarget(local)).not.toThrow();
  for (const url of [
    'https://abcdefghijklmnop.supabase.co',
    'https://db.example.com',
    'http://localhost.evil.example',
    'http://127.0.0.1.nip.io',
    'http://user@evil.example:54321',
    'https://localhost.supabase.co',
  ]) {
    expect(
      () => installM2Fixtures({ url, container: DB_CONTAINER }),
      url,
    ).toThrow(/non-local/);
  }
  expect(() =>
    installM2Fixtures({ url: local.url, container: 'production-db' }),
  ).toThrow(/container/);
});

const ALL_IDS = FULL_PILOT.content.questions.map((question) => question.id);

test('time override attempts and cloud fixture installation are refused', async ({
  request,
}) => {
  installM2Fixtures();
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');
  const created = await newGuest(depsNow());
  const sessionId = created.guest.sessionId;
  const { token } = created;

  // A full exam whose Hören closed half a minute ago by the database clock.
  const closedMs = (FULL_TIMING.hoerenSeconds + 30) * SECOND_MS;
  const attemptId = startExamAt(
    sessionId,
    latest,
    ALL_IDS,
    secondsAgoSql(closedMs / SECOND_MS),
  );
  const rows = async () => ({
    attempts: await readAttempts(sessionId),
    answers: await readAnswerRows(attemptId),
    commands: await readCommandRows(sessionId),
    events: await readEventKinds(attemptId),
    results: await readResults(attemptId),
  });
  const before = await rows();
  const save = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    search = '',
  ) =>
    postCommand(
      request,
      `/api/attempts/${attemptId}/answer${search}`,
      { questionId: 'hoeren-1', optionId: 'a', revision: 1, ...body },
      { token, headers },
    );

  // Without any override the closed Hören refuses the save.
  const plain = await save({});
  expect(plain.status).toBe(404);

  // A time in a header, the query or the body changes nothing: the header and
  // the query are not read, the body is a strict contract.
  const earlier = new Date(Date.now() - closedMs).toISOString();
  const headerNames = [
    'x-test-now',
    'x-now',
    'x-clock',
    'x-time-override',
    'x-forwarded-date',
    'x-vercel-now',
    'date',
  ];
  for (const name of headerNames) {
    const reply = await save({}, { [name]: earlier });
    expect({ name, status: reply.status, body: reply.body }).toEqual({
      name,
      status: plain.status,
      body: plain.body,
    });
  }
  const searched = await save(
    {},
    {},
    `?now=${earlier}&at=${earlier}&p_now=${earlier}`,
  );
  expect(searched).toEqual(plain);
  for (const field of ['now', 'at', 'clientNow', 'serverNow', 'deadline']) {
    const reply = await save({ [field]: earlier });
    expect(reply.status, field).toBe(400);
  }
  expect(await rows()).toEqual(before);

  // The same with the term of a guest: while it runs a save is accepted,
  // after it ends the save is refused whatever time the request claims.
  const shortToken = randomBytes(32).toString('base64url');
  const shortId = psql(
    `select m2_test.insert_guest_ending_in(${quote(hashGuestToken(shortToken))}, 12)`,
  );
  const started = await startFor(depsNow(), shortToken, FULL_EXAM.slug);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error('the short guest was not started');
  }
  const shortAttempt = started.result.attemptId;
  const claimedPast = { 'x-test-now': '2020-01-01T00:00:00.000Z' };
  const answerOf = (revision: number, headers = {}) =>
    postCommand(
      request,
      `/api/attempts/${shortAttempt}/answer`,
      { questionId: 'hoeren-1', optionId: 'a', revision },
      { token: shortToken, headers },
    );
  expect((await answerOf(1)).status).toBe(200);
  await expect
    .poll(
      () =>
        psql(`select clock_timestamp() >= expires_at
          from public.guest_sessions where id = ${quote(shortId)}`),
      { timeout: 20_000 },
    )
    .toBe('t');
  const keep = await readAnswerRows(shortAttempt);
  expect(keep).toHaveLength(1);
  for (const headers of [
    {},
    claimedPast,
    { date: claimedPast['x-test-now'] },
  ]) {
    const reply = await answerOf(2, headers);
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ ok: false, error: 'session-invalid' });
  }
  expect(await readAnswerRows(shortAttempt)).toEqual(keep);

  // No production function accepts a time from a caller: the privileged
  // client too is refused a signature with one, and the wrappers are not in
  // any schema the Data API exposes.
  const fresh = await newGuest(depsNow());
  const past = '2020-01-01T00:00:00.000Z';
  const valid = {
    p_session_id: fresh.guest.sessionId,
    p_attempt_id: attemptId,
    p_question_id: 'hoeren-1',
    p_option_id: 'a',
    p_revision: 1,
  };
  for (const override of [{ p_now: past }, { p_at: past }]) {
    const { error } = await serviceDb.rpc('m2_save_answer', {
      ...valid,
      ...override,
    });
    expect(error?.code).toBe('PGRST202');
  }
  for (const name of ['save_answer_at', 'start_attempt_at']) {
    const { error } = await serviceDb.rpc(name, { ...valid, p_at: past });
    expect(error).not.toBeNull();
  }
  expect(await readAttempts(fresh.guest.sessionId)).toEqual([]);
  expect(await rows()).toEqual(before);

  // The fixture installer refuses every cloud target before it runs
  // anything, and psql itself checks the target as well.
  for (const url of [
    'https://abcdefghijklmnop.supabase.co',
    'https://aws-0-eu-central-1.pooler.supabase.com:6543',
    'postgresql://postgres:secret@db.example.com:5432/postgres',
  ]) {
    expect(
      () => installM2Fixtures({ url, container: DB_CONTAINER }),
      url,
    ).toThrow(/non-local/);
    expect(
      () => psql('select 1', { url, container: DB_CONTAINER }),
      url,
    ).toThrow(/non-local/);
  }
});
