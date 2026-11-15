import { APP_PORTS } from './constants';
import type { HeldLock } from './lock';
import { checkMigrations, cleanTestData } from './stack';
import type {
  AppliedMigration,
  MigrationCli,
  StackDb,
  StackStorage,
} from './stack';
import type { AttestedTarget } from './target';

// The orchestration of one isolated E2E run (#96): lock, attestation,
// migration preflight, cleanup before fixtures, the test process, cleanup in
// finally. The failure of the tests is never masked by the failure of the
// cleanup, and the other way round.

export interface RunDeps {
  acquireLock: () => HeldLock;
  attest: () => AttestedTarget;
  busyPorts: (ports: readonly number[]) => Promise<number[]>;
  localMigrations: () => AppliedMigration[];
  db: StackDb;
  storage: StackStorage;
  migrationCli: MigrationCli;
  // Builds the application; resolves with its exit code. Null: not asked for.
  build: ((signal: AbortSignal) => Promise<number>) | null;
  // Runs the whole Playwright suite; resolves with its exit code.
  runTests: (token: string, signal: AbortSignal) => Promise<number>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface PhaseTime {
  name: string;
  ms: number;
}

export interface RunResult {
  exitCode: number;
  // The exit code of the tests; null when they did not start.
  testExit: number | null;
  failures: string[];
  phases: PhaseTime[];
}

const PORT_POLL_MS = 500;
const SERVER_EXIT_GRACE_MS = 15_000;
const INTERRUPTED_EXIT = 130;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class Phases {
  readonly list: PhaseTime[] = [];

  constructor(private readonly now: () => number) {}

  async run<T>(name: string, step: () => Promise<T> | T): Promise<T> {
    const startedMs = this.now();
    try {
      return await step();
    } finally {
      this.list.push({ name, ms: this.now() - startedMs });
    }
  }
}

// The servers of a finished run need a moment to release their ports.
const assertPortsFree = async (
  deps: RunDeps,
  graceMs: number = 0,
): Promise<void> => {
  let busy = await deps.busyPorts(APP_PORTS);
  for (let waitedMs = 0; busy.length > 0 && waitedMs < graceMs;) {
    await deps.sleep(PORT_POLL_MS);
    waitedMs += PORT_POLL_MS;
    busy = await deps.busyPorts(APP_PORTS);
  }
  if (busy.length > 0) {
    throw new Error(
      `ports ${busy.join(', ')} are in use: a test server of another run may still write`,
    );
  }
};

const assertNotInterrupted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('interrupted before the tests started');
};

const exitCodeOf = (testExit: number | null, failures: string[]): number => {
  if (testExit !== null && testExit !== 0) return testExit;
  return failures.length > 0 ? 1 : 0;
};

// A full isolated run. Throws only when the lock is held: nothing has been
// touched then.
export const runIsolated = async (
  deps: RunDeps,
  signal: AbortSignal,
): Promise<RunResult> => {
  const lock = deps.acquireLock();
  const phases = new Phases(deps.now);
  const failures: string[] = [];
  let hasStartedTests = false;
  let testExit: number | null = null;
  try {
    await phases.run('attest', () => deps.attest());
    if (deps.build) {
      const { build } = deps;
      const built = await phases.run('build', () => build(signal));
      if (built !== 0) throw new Error(`build failed with exit code ${built}`);
    }
    await phases.run('ports', () => assertPortsFree(deps));
    const outcome = await phases.run('migrations', () => {
      lock.assertHeld();
      assertNotInterrupted(signal);
      return checkMigrations(
        deps.localMigrations(),
        deps.db,
        deps.migrationCli,
      );
    });
    deps.log(`migrations: ${outcome}`);
    await phases.run('clean-before', () => {
      lock.assertHeld();
      assertNotInterrupted(signal);
      return cleanTestData(deps.db, deps.storage);
    });
    assertNotInterrupted(signal);
    lock.assertHeld();
    hasStartedTests = true;
    testExit = await phases.run('tests', () =>
      deps.runTests(lock.token, signal),
    );
    if (signal.aborted && testExit === 0) testExit = INTERRUPTED_EXIT;
  } catch (error) {
    failures.push(describeError(error));
    if (signal.aborted && testExit === null) testExit = INTERRUPTED_EXIT;
  } finally {
    // Before the tests started nothing of this run wrote anything: a failed
    // preflight (drift, busy ports, refused target) leaves the stack alone.
    if (hasStartedTests) {
      try {
        await phases.run('clean-after', async () => {
          // The stack may have been stopped or replaced during a long run:
          // prove the target again, and that the lock is still ours.
          deps.attest();
          lock.assertHeld();
          // A server of this run must be gone before anything is removed.
          await assertPortsFree(deps, SERVER_EXIT_GRACE_MS);
          await cleanTestData(deps.db, deps.storage);
        });
      } catch (error) {
        failures.push(`cleanup after the run failed: ${describeError(error)}`);
      }
    }
    lock.release();
  }
  return {
    exitCode: exitCodeOf(testExit, failures),
    testExit,
    failures,
    phases: phases.list,
  };
};

// The guarded cleanup on its own (`e2e:clean`).
export const runClean = async (deps: RunDeps): Promise<RunResult> => {
  const lock = deps.acquireLock();
  const phases = new Phases(deps.now);
  const failures: string[] = [];
  try {
    await phases.run('attest', () => deps.attest());
    await phases.run('ports', () => assertPortsFree(deps));
    await phases.run('clean', () => {
      lock.assertHeld();
      return cleanTestData(deps.db, deps.storage);
    });
  } catch (error) {
    failures.push(describeError(error));
  } finally {
    lock.release();
  }
  return {
    exitCode: exitCodeOf(null, failures),
    testExit: null,
    failures,
    phases: phases.list,
  };
};
