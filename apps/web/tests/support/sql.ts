import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { psqlVarArgs } from '../../../../scripts/manage-timing-profile';
import { readTestSupabaseEnv } from './env';

// Direct SQL against the local, isolated test database only, through psql
// inside its Docker container. Every entry point checks the target first: a
// cloud URL or another container is refused before anything connects.

export const DB_CONTAINER = 'supabase_db_b1-kompass';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

export interface SqlTarget {
  url: string;
  container: string;
}

export const localTarget = (): SqlTarget => ({
  url: readTestSupabaseEnv().url,
  container: DB_CONTAINER,
});

export const assertLocalTarget = (target: SqlTarget): void => {
  let host: string;
  try {
    host = new URL(target.url).hostname;
  } catch {
    throw new Error('Test SQL refuses an unparsable database URL');
  }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`Test SQL refuses the non-local database ${host}`);
  }
  if (target.container !== DB_CONTAINER) {
    throw new Error(`Test SQL refuses the container ${target.container}`);
  }
};

const psqlArgs = (container: string, extra: string[]): string[] => [
  'exec',
  '-i',
  container,
  'psql',
  '-U',
  'postgres',
  '-tA',
  '-q',
  '-v',
  'ON_ERROR_STOP=1',
  ...extra,
];

const runScript = (sql: string, target: SqlTarget, extra: string[]): string => {
  assertLocalTarget(target);
  return execFileSync(
    'docker',
    psqlArgs(target.container, [...extra, '-f', '-']),
    { input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();
};

// Runs a script from stdin and returns its output rows. A failing statement
// stops the script and throws; an open transaction is rolled back when the
// session ends.
export const psql = (sql: string, target: SqlTarget = localTarget()): string =>
  runScript(sql, target, []);

// The database roles a test runs a script as: the owner/DDL role of the
// container, or an API role switched to with SET ROLE.
export type TestSqlRole = 'owner' | 'service_role' | 'anon' | 'authenticated';

// The SqlRunner of scripts/manage-timing-profile.ts for the isolated test
// database: its psql variables (:'name', quoted by psql) and verbose errors,
// run as the given role. Every call checks the local target first.
export const sqlRunnerAs =
  (role: TestSqlRole, target: SqlTarget = localTarget()) =>
  (sql: string, vars: Readonly<Record<string, string>>): string =>
    runScript(role === 'owner' ? sql : `set role ${role};\n${sql}`, target, [
      '-v',
      'VERBOSITY=verbose',
      ...psqlVarArgs(vars),
    ]);

// The last output line parsed as JSON: scripts end with one json select.
export const psqlJson = <T>(sql: string): T => {
  const lines = psql(sql).split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error('psql returned no rows');
  return JSON.parse(last) as T;
};

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const FIXTURES = path.join(import.meta.dirname, 'm2-fixtures.sql');

// Installs the test-only wrappers of tests/support/m2-fixtures.sql into the
// isolated test database. They are never part of supabase/migrations or the
// build; the installer refuses any target but the local container.
// Specs of parallel workers install them at the same time: one transaction
// under an advisory lock, so concurrent replacements of a function wait for
// each other instead of failing.
export const installM2Fixtures = (target: SqlTarget = localTarget()): void => {
  assertLocalTarget(target);
  psql(
    [
      'begin;',
      "select pg_advisory_xact_lock(hashtext('b1k-m2-fixtures'));",
      readFileSync(FIXTURES, 'utf8'),
      'commit;',
    ].join('\n'),
    target,
  );
};

// The advisory lock key of the slot of a guest session and an exam: the same
// function the production start uses.
export const slotKeySql = (sessionId: string, examId: string): string =>
  `m2_private.slot_key(${quote(sessionId)}::uuid, ${quote(examId)}::uuid)`;

export interface HeldLock {
  release: () => Promise<void>;
}

const sessionsNamed = (name: string): number =>
  Number(
    psql(`select count(*) from pg_stat_activity
      where application_name = ${quote(name)}`),
  );

const waitFor = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const exitOf = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

// A separate psql session holds the slot lock of (session, exam) until it is
// released, as a competing start would.
export const holdSlotLock = async (
  sessionId: string,
  examId: string,
): Promise<HeldLock> => {
  assertLocalTarget(localTarget());
  const name = `slot-holder-${randomUUID()}`;
  const child = spawn(
    'docker',
    [
      'exec',
      '-e',
      `PGAPPNAME=${name}`,
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-tA',
      '-c',
      `select pg_advisory_lock(${slotKeySql(sessionId, examId)}),
        pg_sleep(60)`,
    ],
    { stdio: 'ignore' },
  );
  await waitFor(
    () =>
      Number(
        psql(`select count(*) from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where l.locktype = 'advisory' and l.granted
            and a.application_name = ${quote(name)}`),
      ) === 1,
    'slot lock taken',
  );
  return {
    release: async () => {
      psql(`select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${quote(name)}`);
      await exitOf(child);
      await waitFor(() => sessionsNamed(name) === 0, 'slot lock released');
    },
  };
};

// Number of sessions waiting for the advisory slot lock of the pair.
export const slotWaiters = (sessionId: string, examId: string): number =>
  Number(
    psql(`select count(*) from pg_locks
      where locktype = 'advisory' and not granted
        and ((classid::bigint << 32) | objid::bigint)
          = ${slotKeySql(sessionId, examId)}`),
  );

// A separate psql session holds the row lock of one attempt until it is
// released, as a competing save, submit or cancel would.
export interface AttemptLock extends HeldLock {
  name: string;
}

export const holdAttemptLock = async (
  attemptId: string,
): Promise<AttemptLock> => {
  assertLocalTarget(localTarget());
  const name = `attempt-holder-${randomUUID()}`;
  const child = spawn(
    'docker',
    [
      'exec',
      '-e',
      `PGAPPNAME=${name}`,
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-tA',
      '-c',
      `select 1 from public.attempts where id = ${quote(attemptId)}
        for update; select pg_sleep(60)`,
    ],
    { stdio: 'ignore' },
  );
  await waitFor(
    () =>
      Number(
        psql(`select count(*) from pg_stat_activity
          where application_name = ${quote(name)}
            and wait_event = 'PgSleep'`),
      ) === 1,
    'attempt lock taken',
  );
  return {
    name,
    release: async () => {
      psql(`select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${quote(name)}`);
      await exitOf(child);
      await waitFor(() => sessionsNamed(name) === 0, 'attempt lock released');
    },
  };
};

// Requests of the given function queued behind the held lock: blocked by it
// directly or by a request already queued behind it.
export const waitersBehind = (lock: AttemptLock, fn: string): number =>
  Number(
    psql(`with recursive queued(pid) as (
        select pid from pg_stat_activity
        where application_name = ${quote(lock.name)}
        union
        select w.pid from pg_stat_activity w, queued q
        where q.pid = any(pg_blocking_pids(w.pid))
      )
      select count(*) from pg_stat_activity a, queued q
      where a.pid = q.pid and a.wait_event_type = 'Lock'
        and a.query like ${quote(`%${fn}%`)}`),
  );

// A moment of the database clock the given seconds ago, rounded down to
// whole milliseconds like the production start, as SQL text.
export const secondsAgoSql = (seconds: number): string =>
  `pg_catalog.date_trunc('milliseconds', clock_timestamp()
    - make_interval(secs => ${seconds}))`;

export interface ExamTarget {
  examId: string;
  versionId: string;
}

// A full exam started through the same admission kernel as the production
// start, at an explicit moment (#45): the slot lock, the pinned confirmed
// profile and the guest reserve are judged at that moment. Returns the new
// attempt id; a refusal throws with its hint.
export const startExamAt = (
  sessionId: string,
  exam: ExamTarget,
  questionIds: readonly string[],
  atSql: string,
): string =>
  psql(`select attempt_id from m2_test.start_attempt_at(
    ${quote(sessionId)}, ${quote(exam.examId)}, gen_random_uuid(),
    'exam', 'normal', 'all', null, ${quote(exam.versionId)}, 'full-exam',
    ${quote(JSON.stringify(questionIds))}::jsonb, ${atSql})`);

// The phase of a run by the private SQL rule at an explicit moment.
export const runPhaseAt = (attemptId: string, atSql: string): string =>
  psql(`select m2_private.run_phase(r, ${atSql})
    from public.attempt_runs r where r.attempt_id = ${quote(attemptId)}`);

export interface ExamRunTimes {
  acceptedAt: string;
  lesenStartedAt: string | null;
}

export const examRunTimes = (attemptId: string): ExamRunTimes =>
  psqlJson<ExamRunTimes>(`select json_build_object(
      'acceptedAt', accepted_at, 'lesenStartedAt', lesen_started_at)
    from public.attempt_runs where attempt_id = ${quote(attemptId)}`);
