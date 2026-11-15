import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';

// The exclusive inter-process lock of an E2E run (#96): only its holder may
// clean or write the test stack. The file appears atomically with its whole
// content (written aside, then hard-linked: `link` fails when the lock
// exists). A lock is stale only when it was written on this very host and
// platform and its owner process is gone. Anything else is treated as held:
// a live owner, another host or platform (WSL against Windows share one
// Docker), or a pid recycled after a restart are never displaced however
// long it takes; a stuck lock is removed by hand.
// A stale lock is taken over under a short mutex, so the check and the
// removal are one step.

export interface LockInfo {
  pid: number;
  token: string;
  startedAt: string;
  host: string;
  platform: string;
}

export interface LockDeps {
  isAlive: (pid: number) => boolean;
  now: () => number;
  pid: number;
  host: string;
  platform: string;
}

export class LockHeld extends Error {
  constructor(readonly holder: LockInfo) {
    super(
      `another E2E run holds the lock (pid ${holder.pid}, since ${holder.startedAt}); ` +
        'if no run is active, remove .e2e/run.lock',
    );
    this.name = 'LockHeld';
  }
}

export interface HeldLock {
  token: string;
  // Throws when the lock was lost: no destructive step may follow.
  assertHeld: () => void;
  release: () => void;
}

const TAKEOVER_STALE_MS = 30_000;
const TAKEOVER_TRIES = 100;
const TAKEOVER_PAUSE_MS = 50;

export const readLock = (file: string): LockInfo | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      'token' in parsed &&
      'startedAt' in parsed &&
      'host' in parsed &&
      'platform' in parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.host === 'string' &&
      typeof parsed.platform === 'string'
    ) {
      return {
        pid: parsed.pid,
        token: parsed.token,
        startedAt: parsed.startedAt,
        host: parsed.host,
        platform: parsed.platform,
      };
    }
    return null;
  } catch {
    return null;
  }
};

export const isStale = (file: string, deps: LockDeps): boolean => {
  const info = readLock(file);
  // The file is complete when it appears, so an unreadable one is damage.
  if (!info) return true;
  if (info.host !== deps.host || info.platform !== deps.platform) return false;
  return !deps.isAlive(info.pid);
};

// Creates the file only when it does not exist, with its whole content.
const create = (file: string, info: LockInfo): boolean => {
  const aside = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(aside, 'wx');
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(aside, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(aside, { force: true });
  }
};

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const newInfo = (deps: LockDeps): LockInfo => ({
  pid: deps.pid,
  token: randomUUID(),
  startedAt: new Date(deps.now()).toISOString(),
  host: deps.host,
  platform: deps.platform,
});

const takeOver = (file: string, deps: LockDeps): void => {
  const mutex = `${file}.takeover`;
  for (let attempt = 0; attempt < TAKEOVER_TRIES; attempt++) {
    if (create(mutex, newInfo(deps))) {
      try {
        if (isStale(file, deps)) rmSync(file, { force: true });
      } finally {
        rmSync(mutex, { force: true });
      }
      return;
    }
    try {
      if (deps.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) {
        rmSync(mutex, { force: true });
      }
    } catch {
      // The mutex is gone already.
    }
    pause(TAKEOVER_PAUSE_MS);
  }
};

export const acquireLock = (file: string, deps: LockDeps): HeldLock => {
  const info = newInfo(deps);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(file, info)) {
      const isMine = (): boolean => readLock(file)?.token === info.token;
      return {
        token: info.token,
        assertHeld: () => {
          if (!isMine()) throw new Error('the E2E run lock was lost');
        },
        release: () => {
          // Only the owner removes it: a lock taken over is not ours.
          if (isMine()) rmSync(file, { force: true });
        },
      };
    }
    if (!isStale(file, deps)) {
      const holder = readLock(file);
      if (holder) throw new LockHeld(holder);
      continue;
    }
    takeOver(file, deps);
  }
  const holder = readLock(file);
  if (holder) throw new LockHeld(holder);
  throw new Error('the E2E run lock could not be acquired');
};
