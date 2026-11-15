import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_TABLES,
  DEV_STACK,
  E2E_BUCKET,
  E2E_STACK,
  MARKER_VALUE,
  RUN_TOKEN_ENV,
} from './constants';
import { LockHeld, acquireLock, readLock } from './lock';
import type { LockDeps } from './lock';
import { buildWipeSql, cleanEnv, createStackDb } from './real';
import { runClean, runIsolated } from './run';
import type { RunDeps } from './run';
import { MigrationDrift, checkMigrations, cleanTestData } from './stack';
import type { AppliedMigration, StackDb, StackStorage } from './stack';
import { TargetRefused, attestTarget } from './target';
import type { AttestDeps, AttestedTarget, ContainerInfo } from './target';

const REPO = '/repo';
const LOCAL: AppliedMigration[] = [
  { version: '20261031000000', name: 'guest_attempts' },
  { version: '20261101000000', name: 'short_practice' },
  { version: '20261102000000', name: 'guest_session_limits' },
];

// An in-memory stack: PostgreSQL tables, Storage objects, the migration
// history and a log of everything destructive that was done to it.
class FakeStack {
  rows = new Map<string, number>(CLEANUP_TABLES.map((table) => [table, 0]));
  extraTables: string[] = [];
  objects = new Set<string>();
  buckets: string[] = [E2E_BUCKET];
  migrations: AppliedMigration[] = [...LOCAL];
  writes: string[] = [];
  upCalls = 0;
  dockerStarts = 0;
  failStorageClean = false;
  versionSeq = 0;
  publishedVersions = new Set<string>();

  seed(): void {
    for (const table of CLEANUP_TABLES) this.rows.set(table, 3);
    this.objects.add('audio/old.wav');
  }

  total(): number {
    return [...this.rows.values()].reduce((sum, count) => sum + count, 0);
  }

  // What the global setup does: a published version is created once; a
  // second publication of the same slug would reuse it.
  publish(slug: string): 'created' | 'reused' {
    if (this.publishedVersions.has(slug)) return 'reused';
    this.publishedVersions.add(slug);
    this.rows.set('public.exams', (this.rows.get('public.exams') ?? 0) + 1);
    this.objects.add(`audio/${slug}.wav`);
    return 'created';
  }

  db(): StackDb {
    return {
      tables: () => [...this.rows.keys(), ...this.extraTables],
      wipe: (tables) => {
        this.writes.push('wipe');
        for (const table of tables) this.rows.set(table, 0);
        this.publishedVersions.clear();
      },
      appliedMigrations: () => [...this.migrations],
    };
  }

  storage(): StackStorage {
    return {
      buckets: () => Promise.resolve([...this.buckets]),
      emptyBucket: () => {
        if (this.failStorageClean) {
          return Promise.reject(new Error('storage is down'));
        }
        this.writes.push('empty-bucket');
        this.objects.clear();
        return Promise.resolve();
      },
      objectCount: () => Promise.resolve(this.objects.size),
    };
  }
}

interface AttestScript {
  config?: string | null;
  apiUrl?: string;
  container?: ContainerInfo | null;
  gateway?: ContainerInfo | null;
  marker?: string;
  usedRows?: string;
  env?: Record<string, string | undefined>;
  runLock?: { token: string } | null;
  isWorker?: boolean;
}

const e2eContainer = (): ContainerInfo => ({
  running: true,
  labels: {
    'com.supabase.cli.project': E2E_STACK.projectId,
    'com.supabase.cli.workdir': `${REPO}/supabase/e2e`,
  },
  ports: {
    '5432/tcp': [String(E2E_STACK.dbPort)],
    '8000/tcp': [String(E2E_STACK.apiPort)],
  },
});

const devContainer = (): ContainerInfo => ({
  running: true,
  labels: {
    'com.supabase.cli.project': DEV_STACK.projectId,
    'com.supabase.cli.workdir': REPO,
  },
  ports: {
    '5432/tcp': [String(DEV_STACK.dbPort)],
    '8000/tcp': [String(DEV_STACK.apiPort)],
  },
});

class Calls {
  inspect = 0;
  psql = 0;
  status = 0;
}

const attestDeps = (
  script: AttestScript = {},
  calls: Calls = new Calls(),
): AttestDeps => ({
  readConfigProjectId: () =>
    script.config === undefined ? E2E_STACK.projectId : script.config,
  readStatus: () => {
    calls.status++;
    return {
      API_URL: script.apiUrl ?? E2E_STACK.apiUrl,
      PUBLISHABLE_KEY: 'pk',
      SECRET_KEY: 'sk',
    };
  },
  inspect: (name) => {
    calls.inspect++;
    if (name.includes('kong') && script.gateway !== undefined) {
      return script.gateway;
    }
    return script.container === undefined ? e2eContainer() : script.container;
  },
  psql: (_container, sql) => {
    calls.psql++;
    if (sql.includes('marker')) return script.marker ?? MARKER_VALUE;
    return script.usedRows ?? '0';
  },
  readRunLock: () => script.runLock ?? null,
  env: script.env ?? {},
  repoRoot: REPO,
  isWorker: script.isWorker ?? false,
});

const CI_ENV = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_RUN_ID: '1',
  GITHUB_WORKSPACE: REPO,
  RUNNER_OS: 'Linux',
  RUNNER_ENVIRONMENT: 'github-hosted',
};

let dir = '';
let lockFile = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'b1k-e2e-'));
  lockFile = path.join(dir, 'run.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = new Set<number>([process.pid]);
const lockDeps = (pid: number = process.pid): LockDeps => ({
  isAlive: (candidate) => alive.has(candidate),
  now: () => Date.now(),
  pid,
  host: 'this-host',
  platform: 'win32',
});

const lockBody = (
  pid: number,
  token: string,
  host: string = 'this-host',
  platform: string = 'win32',
) => JSON.stringify({ pid, token, startedAt: 'then', host, platform });

interface Harness {
  deps: RunDeps;
  stack: FakeStack;
  logs: string[];
  testsSeen: { rowsAtStart: number[]; publish: string[] };
}

const harness = (
  options: {
    stack?: FakeStack;
    attest?: AttestScript;
    runTests?: (stack: FakeStack, token: string) => Promise<number>;
    busyPorts?: () => number[];
    local?: AppliedMigration[];
  } = {},
): Harness => {
  const stack = options.stack ?? new FakeStack();
  const logs: string[] = [];
  const testsSeen = { rowsAtStart: [] as number[], publish: [] as string[] };
  const deps: RunDeps = {
    acquireLock: () => acquireLock(lockFile, lockDeps()),
    attest: () =>
      attestTarget(attestDeps(options.attest), { requireRunLock: false }),
    busyPorts: () => Promise.resolve(options.busyPorts?.() ?? []),
    localMigrations: () => options.local ?? LOCAL,
    db: stack.db(),
    storage: stack.storage(),
    build: null,
    migrationCli: {
      up: () => {
        stack.upCalls++;
        stack.writes.push('migration-up');
        stack.migrations = [...(options.local ?? LOCAL)];
      },
    },
    runTests: async (token) => {
      testsSeen.rowsAtStart.push(stack.total() + stack.objects.size);
      if (options.runTests) return options.runTests(stack, token);
      testsSeen.publish.push(stack.publish('exam-a'));
      stack.rows.set('public.guest_sessions', 7);
      return 0;
    },
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    log: (line) => logs.push(line),
  };
  return { deps, stack, logs, testsSeen };
};

const signal = (): AbortSignal => new AbortController().signal;

describe('isolated E2E runs', () => {
  it('reuses persistent stack and restores clean baseline', async () => {
    const { deps, stack, testsSeen } = harness();
    stack.seed();
    stack.extraTables = [];

    const first = await runIsolated(deps, signal());
    expect(first.exitCode).toBe(0);
    expect(stack.total()).toBe(0);
    const second = await runIsolated(deps, signal());
    expect(second.exitCode).toBe(0);

    // Both runs began with no test records, though the stack held old ones.
    expect(testsSeen.rowsAtStart).toEqual([0, 0]);
    // The runner never starts, stops or recreates Docker and never replays.
    expect(stack.dockerStarts).toBe(0);
    expect(stack.upCalls).toBe(0);
    expect(stack.writes).not.toContain('migration-up');
    expect(readLock(lockFile)).toBeNull();
  });

  it('cleans database and storage without dropping schema', async () => {
    const stack = new FakeStack();
    stack.seed();
    const tablesBefore = [...stack.db().tables()];
    const migrationsBefore = [...stack.migrations];

    const report = await cleanTestData(stack.db(), stack.storage());

    expect(report.tables).toBe(CLEANUP_TABLES.length);
    expect(stack.total()).toBe(0);
    expect(stack.objects.size).toBe(0);
    // Tables, bucket and migration history remain; only data is gone.
    expect(stack.db().tables()).toEqual(tablesBefore);
    expect(stack.buckets).toEqual([E2E_BUCKET]);
    expect(stack.migrations).toEqual(migrationsBefore);
    expect(stack.writes).not.toContain('migration-up');
  });

  it('recovers after failed or interrupted run', async () => {
    // A killed run: stale lock of a dead process, data left behind.
    const stack = new FakeStack();
    stack.seed();
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: 424242, token: 'dead', startedAt: 'long ago' }),
    );
    const { deps, testsSeen } = harness({ stack });

    const recovered = await runIsolated(deps, signal());
    expect(recovered.exitCode).toBe(0);
    expect(testsSeen.rowsAtStart).toEqual([0]);

    // A failed run leaves data too; the cleanup in finally removes it and the
    // exit code of the tests is kept.
    const failing = harness({
      stack,
      runTests: (fake) => {
        fake.publish('exam-b');
        return Promise.resolve(1);
      },
    });
    const failed = await runIsolated(failing.deps, signal());
    expect(failed.exitCode).toBe(1);
    expect(failed.testExit).toBe(1);
    expect(stack.total()).toBe(0);
    expect(stack.objects.size).toBe(0);
  });

  it('refuses development and foreign targets before cleanup', async () => {
    const stack = new FakeStack();
    stack.seed();
    const before = stack.total();
    const refusals: AttestScript[] = [
      // The development project, config, address and container.
      {
        config: DEV_STACK.projectId,
        apiUrl: DEV_STACK.apiUrl,
        container: devContainer(),
      },
      // The right config and address, but the development container.
      { container: devContainer() },
      // A foreign container that only looks like the E2E one.
      {
        container: {
          ...e2eContainer(),
          labels: {
            'com.supabase.cli.project': 'something-else',
            'com.supabase.cli.workdir': `${REPO}/supabase/e2e`,
          },
        },
      },
      // A container that does not publish the E2E database port.
      { container: { ...e2eContainer(), ports: { '5432/tcp': ['54322'] } } },
      // The API gateway of another project answers on the API port.
      {
        gateway: {
          ...e2eContainer(),
          labels: {
            'com.supabase.cli.project': DEV_STACK.projectId,
            'com.supabase.cli.workdir': `${REPO}/supabase/e2e`,
          },
        },
      },
      { gateway: null },
      // A stopped or missing container.
      { container: { ...e2eContainer(), running: false } },
      { container: null },
      // A database without the marker of the E2E stack.
      { marker: '' },
      { marker: 'b1-kompass-dev' },
    ];
    for (const attest of refusals) {
      const { deps } = harness({ stack, attest });
      const result = await runIsolated(deps, signal());
      expect(result.exitCode).toBe(1);
      expect(result.failures.join()).toContain('E2E target refused');
      expect(result.testExit).toBeNull();
    }
    expect(stack.writes).toEqual([]);
    expect(stack.total()).toBe(before);

    // The privileged ports themselves refuse a non-E2E target.
    const dev: AttestedTarget = {
      mode: 'ci',
      profile: DEV_STACK,
      container: DEV_STACK.dbContainer,
      url: DEV_STACK.apiUrl,
      publishableKey: 'pk',
      secretKey: 'sk',
    };
    expect(() => createStackDb(dev).tables()).toThrow(/only on the E2E stack/);
    expect(() => createStackDb(dev).wipe(CLEANUP_TABLES)).toThrow(
      /only on the E2E stack/,
    );
    const foreign: AttestedTarget = {
      ...dev,
      mode: 'e2e',
      container: 'supabase_db_other',
    };
    expect(() => createStackDb(foreign).appliedMigrations()).toThrow(
      /only on the E2E stack/,
    );
  });

  it('serializes destructive test runs', async () => {
    let release: (code: number) => void = () => undefined;
    const slow = new Promise<number>((resolve) => {
      release = resolve;
    });
    const first = harness({ runTests: () => slow });
    const second = harness({ stack: first.stack });

    const running = runIsolated(first.deps, signal());
    // The second request is refused while the first holds the lock.
    await expect(runIsolated(second.deps, signal())).rejects.toBeInstanceOf(
      LockHeld,
    );
    expect(second.testsSeen.rowsAtStart).toEqual([]);
    expect(
      await new Promise((resolve) =>
        setImmediate(() => resolve(readLock(lockFile)?.pid)),
      ),
    ).toBe(process.pid);

    release(0);
    expect((await running).exitCode).toBe(0);
    // Free again after the first run.
    expect((await runIsolated(second.deps, signal())).exitCode).toBe(0);
  });

  it('skips applied migrations and fails on drift', () => {
    const stack = new FakeStack();
    const cli = {
      up: () => {
        stack.upCalls++;
        stack.migrations = [...LOCAL];
      },
    };

    // Installed history equals the files: no replay at all.
    expect(checkMigrations(LOCAL, stack.db(), cli)).toBe('current');
    expect(stack.upCalls).toBe(0);

    // Only the missing file is applied, once.
    stack.migrations = LOCAL.slice(0, 2);
    expect(checkMigrations(LOCAL, stack.db(), cli)).toBe('applied');
    expect(stack.upCalls).toBe(1);

    stack.migrations = [
      ...LOCAL,
      { version: '20269999000000', name: 'from_elsewhere' },
    ];
    expect(() => checkMigrations(LOCAL, stack.db(), cli)).toThrow(
      MigrationDrift,
    );
    expect(stack.upCalls).toBe(1);
  });

  it('rejects non-loopback and spoofed local targets', () => {
    const spoofs = [
      'http://localhost:54421',
      'http://127.0.0.1.evil.test:54421',
      'http://127.0.0.1@evil.test:54421',
      'http://user:pw@127.0.0.1:54421',
      'https://127.0.0.1:54421',
      'http://127.0.0.1:54321',
      'http://127.0.0.1',
      'http://[::1]:54421',
      'http://0.0.0.0:54421',
      'http://127.0.0.1:54421/rest/v1',
      'https://abcdefghijklmnop.supabase.co',
      'not a url',
      '',
    ];
    for (const apiUrl of spoofs) {
      const calls = new Calls();
      expect(
        () =>
          attestTarget(attestDeps({ apiUrl }, calls), {
            requireRunLock: false,
          }),
        apiUrl,
      ).toThrow(TargetRefused);
      // Rejected before Docker or psql were spawned.
      expect(calls.inspect, apiUrl).toBe(0);
      expect(calls.psql, apiUrl).toBe(0);
    }
    const ok = attestTarget(attestDeps(), { requireRunLock: false });
    expect(ok.url).toBe(E2E_STACK.apiUrl);
    expect(ok.container).toBe(E2E_STACK.dbContainer);
  });

  it('distinguishes stale and active run locks', () => {
    const holder = 4242;
    alive.add(holder);
    writeFileSync(lockFile, lockBody(holder, 'live'));
    // An active owner is never displaced, and its lock is untouched.
    expect(() => acquireLock(lockFile, lockDeps())).toThrow(LockHeld);
    expect(readLock(lockFile)?.token).toBe('live');

    // A lock of another host or platform (WSL against Windows, one shared
    // Docker) cannot be judged by a pid: it counts as held, dead pid or not.
    writeFileSync(
      lockFile,
      lockBody(999999, 'other-host', 'wsl-host', 'linux'),
    );
    expect(() => acquireLock(lockFile, lockDeps())).toThrow(LockHeld);
    expect(readLock(lockFile)?.token).toBe('other-host');
    rmSync(lockFile);

    // A dead owner is stale; so is a damaged lock file.
    writeFileSync(lockFile, lockBody(999999, 'dead'));
    acquireLock(lockFile, lockDeps()).release();
    writeFileSync(lockFile, '{"pid": 12');
    acquireLock(lockFile, lockDeps()).release();

    // A lock taken over is lost for its former owner: it is not removed by
    // it, and no destructive step may follow.
    const first = acquireLock(lockFile, lockDeps());
    rmSync(lockFile);
    writeFileSync(lockFile, lockBody(holder, 'other'));
    expect(() => first.assertHeld()).toThrow(/lost/);
    first.release();
    expect(readLock(lockFile)?.token).toBe('other');
    alive.delete(holder);
  });

  it('writes nothing after losing the lock or an interrupt', async () => {
    const stack = new FakeStack();
    stack.seed();
    const before = stack.total();
    // The lock is taken over while the preflight runs.
    const lost = harness({ stack });
    const original = lost.deps.acquireLock;
    lost.deps.acquireLock = () => {
      const held = original();
      rmSync(lockFile);
      writeFileSync(lockFile, lockBody(process.pid, 'someone-else'));
      return held;
    };
    const result = await runIsolated(lost.deps, signal());
    expect(result.exitCode).toBe(1);
    expect(result.failures.join()).toMatch(/lock was lost/);
    expect(stack.writes).toEqual([]);
    expect(stack.total()).toBe(before);
    rmSync(lockFile, { force: true });

    // An interrupt before the tests: the suite never starts, nothing is
    // cleaned, the exit code says interrupted.
    const controller = new AbortController();
    controller.abort();
    const interrupted = harness({ stack });
    const stopped = await runIsolated(interrupted.deps, controller.signal);
    expect(stopped.exitCode).toBe(130);
    expect(interrupted.testsSeen.rowsAtStart).toEqual([]);
    expect(stack.writes).toEqual([]);
  });

  it('builds the cleanup transaction safely', () => {
    const sql = buildWipeSql(CLEANUP_TABLES);
    expect(sql.startsWith('begin;')).toBe(true);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).toContain("set local lock_timeout = '30s'");
    expect(sql).toContain('restart identity');
    // Never cascades into a table the allowlist does not name, never drops.
    expect(sql).not.toMatch(/cascade/i);
    expect(sql).not.toMatch(/drop (table|schema|database|function)/i);
    expect(sql).not.toMatch(/delete/i);
    for (const table of CLEANUP_TABLES) {
      const [schema = '', name = ''] = table.split('.');
      expect(sql).toContain(`"${schema}"."${name}"`);
    }
    expect(sql).toContain('trigger state changed');
  });

  it('passes no caller environment to the CLI and Docker', () => {
    const env = cleanEnv({
      PATH: '/bin',
      SUPABASE_PROJECT_ID: 'b1-kompass',
      SUPABASE_DB_PORT: '54322',
      DOCKER_HOST: 'tcp://elsewhere:2375',
      DOCKER_CONTEXT: 'prod',
      PGHOST: 'db.example.com',
      HOME: '/home/dev',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/dev' });
  });

  it('refuses an active writer on the test server ports', async () => {
    const { deps, stack } = harness({ busyPorts: () => [3100] });
    stack.seed();
    const result = await runIsolated(deps, signal());
    expect(result.exitCode).toBe(1);
    expect(result.failures.join()).toContain('3100');
    expect(stack.writes).toEqual([]);
    const cleaned = await runClean(
      harness({ stack, busyPorts: () => [3101] }).deps,
    );
    expect(cleaned.exitCode).toBe(1);
    expect(stack.writes).toEqual([]);
  });

  it('preserves test failure when cleanup fails', async () => {
    const { deps, stack } = harness({
      runTests: (fake) => {
        fake.failStorageClean = true;
        return Promise.resolve(3);
      },
    });
    const result = await runIsolated(deps, signal());
    expect(result.testExit).toBe(3);
    // The code of the tests is not masked by the failed cleanup...
    expect(result.exitCode).toBe(3);
    // ...and the cleanup failure is reported next to it.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /cleanup after the run failed.*storage is down/,
    );
    expect(readLock(lockFile)).toBeNull();

    // Passing tests with a failed cleanup still exit nonzero.
    stack.failStorageClean = false;
    const passing = harness({
      stack,
      runTests: (fake) => {
        fake.failStorageClean = true;
        return Promise.resolve(0);
      },
    });
    const passed = await runIsolated(passing.deps, signal());
    expect(passed.testExit).toBe(0);
    expect(passed.exitCode).toBe(1);
  });

  it('blocks direct E2E on developer stack', () => {
    // Not a CI job: the developer stack is never a target.
    const calls = new Calls();
    expect(() =>
      attestTarget(
        attestDeps(
          {
            config: DEV_STACK.projectId,
            apiUrl: DEV_STACK.apiUrl,
            container: devContainer(),
          },
          calls,
        ),
        { requireRunLock: true },
      ),
    ).toThrow(TargetRefused);
    expect(calls.psql).toBe(0);

    // The E2E stack without the run lock of the orchestrator.
    expect(() => attestTarget(attestDeps(), { requireRunLock: true })).toThrow(
      /run lock/,
    );
    expect(() =>
      attestTarget(
        attestDeps({
          env: { [RUN_TOKEN_ENV]: 'forged' },
          runLock: { token: 'real' },
        }),
        { requireRunLock: true },
      ),
    ).toThrow(/run lock/);
    expect(
      attestTarget(
        attestDeps({
          env: { [RUN_TOKEN_ENV]: 'real' },
          runLock: { token: 'real' },
        }),
        { requireRunLock: true },
      ).container,
    ).toBe(E2E_STACK.dbContainer);

    // A CI-looking environment on a developer database that holds data.
    const dev = {
      config: DEV_STACK.projectId,
      apiUrl: DEV_STACK.apiUrl,
      container: devContainer(),
      env: CI_ENV,
    };
    expect(() =>
      attestTarget(attestDeps({ ...dev, usedRows: '2077' }), {
        requireRunLock: true,
      }),
    ).toThrow(/not fresh/);
    // A CI job on its own fresh stack, and its workers after the fixtures.
    expect(
      attestTarget(attestDeps({ ...dev, usedRows: '0' }), {
        requireRunLock: true,
      }).mode,
    ).toBe('ci');
    expect(
      attestTarget(attestDeps({ ...dev, usedRows: '9', isWorker: true }), {
        requireRunLock: true,
      }).mode,
    ).toBe('ci');
    // CI variables without the matching workspace of the container.
    expect(() =>
      attestTarget(
        attestDeps({
          ...dev,
          env: { ...CI_ENV, GITHUB_WORKSPACE: '/elsewhere' },
        }),
        { requireRunLock: true },
      ),
    ).toThrow(/another directory/);
  });

  it('does not retain published test versions', async () => {
    const { deps, testsSeen, stack } = harness();
    await runIsolated(deps, signal());
    await runIsolated(deps, signal());
    // The same fixture package is created anew on the next run, never found.
    expect(testsSeen.publish).toEqual(['created', 'created']);
    expect(stack.publishedVersions.size).toBe(0);
  });

  it('rejects migration drift safely', async () => {
    const drifted: AppliedMigration[][] = [
      [...LOCAL, { version: '20269999000000', name: 'unknown' }],
      [
        LOCAL[0] as AppliedMigration,
        { version: LOCAL[1]?.version ?? '', name: 'renamed' },
      ],
      [LOCAL[1] as AppliedMigration, LOCAL[0] as AppliedMigration],
    ];
    for (const migrations of drifted) {
      const stack = new FakeStack();
      stack.seed();
      stack.migrations = migrations;
      const before = stack.total();
      const { deps, testsSeen } = harness({ stack });
      const result = await runIsolated(deps, signal());
      expect(result.exitCode).toBe(1);
      expect(result.failures.join()).toContain('migration drift');
      // Nothing was reset, replayed or cleaned; the tests never started.
      expect(stack.writes).toEqual([]);
      expect(stack.upCalls).toBe(0);
      expect(stack.total()).toBe(before);
      expect(testsSeen.rowsAtStart).toEqual([]);
    }
  });

  it('fails closed on unknown tables and buckets', async () => {
    const stack = new FakeStack();
    stack.seed();
    stack.extraTables = ['public.new_table'];
    await expect(cleanTestData(stack.db(), stack.storage())).rejects.toThrow(
      /outside the allowlist/,
    );
    stack.extraTables = [];
    stack.buckets = [E2E_BUCKET, 'avatars'];
    await expect(cleanTestData(stack.db(), stack.storage())).rejects.toThrow(
      /unexpected Storage buckets/,
    );
    stack.buckets = [E2E_BUCKET];
    stack.rows.delete('public.exams');
    await expect(cleanTestData(stack.db(), stack.storage())).rejects.toThrow(
      /missing/,
    );
    // Not a single write happened in any of the three refusals.
    expect(stack.writes).toEqual([]);
    mkdirSync(dir, { recursive: true });
  });
});

describe('cleanup allowlist against the migrations', () => {
  const MIGRATIONS = fileURLToPath(
    new URL('../../supabase/migrations', import.meta.url),
  );
  const TABLE = String.raw`((?:public|m2_private)\.[a-z_0-9]+)`;

  const tablesOfMigrations = (): string[] => {
    const created = new Set<string>();
    const files = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
      for (const match of sql.matchAll(
        new RegExp(String.raw`create table (?:if not exists )?${TABLE}`, 'gi'),
      )) {
        created.add((match[1] ?? '').toLowerCase());
      }
      for (const match of sql.matchAll(
        new RegExp(String.raw`drop table (?:if exists )?${TABLE}`, 'gi'),
      )) {
        created.delete((match[1] ?? '').toLowerCase());
      }
    }
    return [...created].sort();
  };

  it('lists exactly the tables the migrations create', () => {
    expect([...CLEANUP_TABLES].sort()).toEqual(tablesOfMigrations());
  });
});
