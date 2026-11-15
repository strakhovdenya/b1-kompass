import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { E2E_STACK, RUN_TOKEN_ENV } from './constants';
import { LockHeld, acquireLock, readLock } from './lock';
import type { HeldLock } from './lock';
import { runClean, runIsolated } from './run';
import type { RunDeps, RunResult } from './run';
import {
  LOCK_FILE,
  REPORT_FILE,
  REPO_ROOT,
  createMigrationCli,
  createStackDb,
  createStackStorage,
  ensureMigrationLink,
  findBusyPorts,
  isProcessAlive,
  readLocalMigrations,
  realAttestDeps,
  startStack,
  stopStack,
  writeMarker,
} from './real';
import { checkMigrations } from './stack';
import { attestTarget } from './target';
import type { AttestedTarget } from './target';

// `npm run e2e:up | e2e:test | e2e:status | e2e:clean | e2e:stop` (#96).
// The same Node entry on Windows PowerShell and Linux.

const IS_WINDOWS = process.platform === 'win32';
const BUILD_ID = path.join(REPO_ROOT, 'apps', 'web', '.next', 'BUILD_ID');

const lockDeps = {
  isAlive: isProcessAlive,
  now: () => Date.now(),
  pid: process.pid,
  host: os.hostname(),
  platform: process.platform,
};

const takeLock = (): HeldLock => acquireLock(LOCK_FILE, lockDeps);

const makeLockDir = (): void => {
  mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
};

// Variables that could point the spec helpers (docker exec) or the app at
// another daemon or database never reach the test process.
const withoutRedirects = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([name]) => !/^(DOCKER_|SUPABASE_|PG[A-Z0-9]+$)/i.test(name),
    ),
  ) as NodeJS.ProcessEnv;

const KILL_ESCALATION_MS = 10_000;
const INTERRUPTED_EXIT = 130;

const killTree = (pid: number, isForced: boolean): void => {
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } else {
      process.kill(-pid, isForced ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    // The group is gone already.
  }
};

const spawnNpm = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<number> =>
  new Promise((resolve, reject) => {
    // An interrupt that came before this step must not start a suite.
    if (signal.aborted) {
      resolve(INTERRUPTED_EXIT);
      return;
    }
    const child = spawn(IS_WINDOWS ? 'npm.cmd' : 'npm', [...args], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
      shell: IS_WINDOWS,
      detached: !IS_WINDOWS,
    });
    const stop = (): void => {
      if (child.pid === undefined) return;
      killTree(child.pid, false);
      const { pid } = child;
      // Not cleared when npm exits: members of the group may outlive it.
      setTimeout(() => killTree(pid, true), KILL_ESCALATION_MS).unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('exit', (code) => {
      signal.removeEventListener('abort', stop);
      resolve(code ?? 1);
    });
  });

// The target of the run, set by the attestation. Database and Storage ports
// exist only after it: nothing can write to a stack that was not attested.
const createRunDeps = (options: { build: boolean }): RunDeps => {
  let target: AttestedTarget | null = null;
  const attested = (): AttestedTarget => {
    if (!target) throw new Error('the target has not been attested');
    return target;
  };
  return {
    acquireLock: () => {
      makeLockDir();
      return takeLock();
    },
    attest: () => {
      ensureMigrationLink();
      target = attestTarget(realAttestDeps(), { requireRunLock: false });
      if (target.mode !== 'e2e') {
        throw new Error('the isolated runner works on the E2E stack only');
      }
      return target;
    },
    busyPorts: findBusyPorts,
    localMigrations: readLocalMigrations,
    db: {
      tables: () => createStackDb(attested()).tables(),
      wipe: (tables) => createStackDb(attested()).wipe(tables),
      appliedMigrations: () => createStackDb(attested()).appliedMigrations(),
    },
    storage: {
      buckets: () => createStackStorage(attested()).buckets(),
      emptyBucket: (bucket) =>
        createStackStorage(attested()).emptyBucket(bucket),
      objectCount: (bucket) =>
        createStackStorage(attested()).objectCount(bucket),
    },
    migrationCli: { up: () => createMigrationCli(attested()).up() },
    build: (signal) => {
      if (options.build) return spawnNpm(['run', 'build'], process.env, signal);
      // Without --build the existing production build is used: checked
      // before anything is written.
      if (!existsSync(BUILD_ID)) {
        throw new Error('no production build: run `npm run build` first');
      }
      return Promise.resolve(0);
    },
    runTests: (token, signal) => {
      return spawnNpm(
        ['run', 'test:e2e', '--workspace', 'apps/web'],
        { ...withoutRedirects(process.env), [RUN_TOKEN_ENV]: token },
        signal,
      );
    },
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
    log: (line) => console.log(`[e2e] ${line}`),
  };
};

const report = (title: string, result: RunResult): void => {
  const total = result.phases.reduce((sum, phase) => sum + phase.ms, 0);
  console.log(`\n[e2e] ${title}: phase times`);
  for (const phase of result.phases) {
    console.log(
      `[e2e]   ${phase.name.padEnd(14)} ${(phase.ms / 1000).toFixed(1)} s`,
    );
  }
  console.log(`[e2e]   ${'total'.padEnd(14)} ${(total / 1000).toFixed(1)} s`);
  for (const failure of result.failures)
    console.error(`[e2e] FAILED: ${failure}`);
  if (result.testExit !== null) {
    console.log(`[e2e] tests exit code: ${result.testExit}`);
  }
  mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  writeFileSync(
    REPORT_FILE,
    JSON.stringify({ title, at: new Date().toISOString(), ...result }, null, 2),
  );
};

const withAbort = async (
  work: (signal: AbortSignal) => Promise<RunResult>,
): Promise<RunResult> => {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGBREAK', onSignal);
  try {
    return await work(controller.signal);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGBREAK', onSignal);
  }
};

const up = async (): Promise<number> => {
  ensureMigrationLink();
  makeLockDir();
  const lock = takeLock();
  try {
    const deps = realAttestDeps();
    if (!deps.inspect(E2E_STACK.dbContainer)?.running) {
      if (deps.readConfigProjectId(E2E_STACK) !== E2E_STACK.projectId) {
        throw new Error('supabase/e2e config does not name the E2E project');
      }
      startStack();
    }
    // The three proofs without the marker, then the marker, then all four.
    const target = attestTarget(deps, {
      requireRunLock: false,
      allowMissingMarker: true,
    });
    writeMarker(target);
    attestTarget(deps, { requireRunLock: false });
    const outcome = checkMigrations(
      readLocalMigrations(),
      createStackDb(target),
      createMigrationCli(target),
    );
    console.log(
      `[e2e] stack is up (${E2E_STACK.projectId}); migrations: ${outcome}`,
    );
    return 0;
  } finally {
    lock.release();
  }
};

const status = async (): Promise<number> => {
  const holder = readLock(LOCK_FILE);
  console.log(
    holder
      ? `[e2e] run lock: held by pid ${holder.pid} since ${holder.startedAt}`
      : '[e2e] run lock: free',
  );
  try {
    const target = attestTarget(realAttestDeps(), { requireRunLock: false });
    console.log(`[e2e] target: OK (${target.container}, ${target.url})`);
    const db = createStackDb(target);
    const local = readLocalMigrations();
    const applied = db.appliedMigrations();
    console.log(
      `[e2e] migrations: ${applied.length} applied of ${local.length} in the repository`,
    );
    return 0;
  } catch (error) {
    console.error(
      `[e2e] target: NOT READY: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
};

const stop = async (): Promise<number> => {
  makeLockDir();
  const lock = takeLock();
  try {
    stopStack();
    return 0;
  } finally {
    lock.release();
  }
};

const COMMANDS: Record<string, () => Promise<number>> = {
  up,
  status,
  stop,
  test: async () => {
    const build = process.argv.includes('--build');
    const result = await withAbort((signal) =>
      runIsolated(createRunDeps({ build }), signal),
    );
    report('isolated run', result);
    return result.exitCode;
  },
  clean: async () => {
    const result = await runClean(createRunDeps({ build: false }));
    report('guarded cleanup', result);
    return result.exitCode;
  },
};

const main = async (): Promise<number> => {
  const name = process.argv[2] ?? '';
  const handler = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!handler) {
    console.error(`usage: e2e <${Object.keys(COMMANDS).join('|')}>`);
    return 2;
  }
  try {
    return await handler();
  } catch (error) {
    if (error instanceof LockHeld) {
      console.error(`[e2e] ${error.message}`);
    } else {
      console.error(
        `[e2e] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return 1;
  }
};

process.exitCode = await main();
