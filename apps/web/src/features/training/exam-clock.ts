// Pure display arithmetic of a timed run. Every moment is passed in: the
// server moment of a reading, the local monotonic moment it arrived at and
// the local monotonic moment of the frame. Nothing here reads a clock, and
// nothing here admits a write: the database decides that after its lock.

// One reading of the server clock: the server moment and the local
// monotonic moment (performance.now) it corresponds to.
export interface ClockSync {
  readonly serverNowMs: number;
  readonly localMs: number;
}

export type ClockState = 'running' | 'zero';

export interface ClockDisplay {
  readonly remainingMs: number;
  // Whole seconds left, rounded up: 0 only once the deadline is reached.
  readonly seconds: number;
  readonly label: string;
  readonly state: ClockState;
}

const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 3600;

const isFiniteNumber = (value: number): boolean => Number.isFinite(value);

// A reading taken by a request sent at sentLocalMs and answered at
// receivedLocalMs: the server moment is placed in the middle of the round
// trip.
export const syncOf = (
  serverNowMs: number,
  sentLocalMs: number,
  receivedLocalMs: number,
): ClockSync => ({
  serverNowMs,
  localMs: sentLocalMs + (receivedLocalMs - sentLocalMs) / 2,
});

// The server moment at the local monotonic moment localMs.
export const serverNowAt = (sync: ClockSync, localMs: number): number =>
  sync.serverNowMs + (localMs - sync.localMs);

// Never negative; an unusable input shows no time left rather than more.
export const remainingMsAt = (deadlineMs: number, serverNowMs: number) => {
  const remainingMs = deadlineMs - serverNowMs;
  if (!isFiniteNumber(remainingMs) || remainingMs <= 0) return 0;
  return remainingMs;
};

const twoDigits = (value: number): string => String(value).padStart(2, '0');

// m:ss below an hour, h:mm:ss from an hour on.
export const formatSeconds = (totalSeconds: number): string => {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / HOUR_SECONDS);
  const minutes = Math.floor((safe % HOUR_SECONDS) / MINUTE_SECONDS);
  const seconds = safe % MINUTE_SECONDS;
  if (hours > 0) {
    return `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`;
  }
  return `${minutes}:${twoDigits(seconds)}`;
};

export const displayAt = (
  deadlineMs: number,
  sync: ClockSync,
  localMs: number,
): ClockDisplay => {
  const remainingMs = remainingMsAt(deadlineMs, serverNowAt(sync, localMs));
  const seconds = Math.ceil(remainingMs / SECOND_MS);
  return {
    remainingMs,
    seconds,
    label: formatSeconds(seconds),
    state: remainingMs > 0 ? 'running' : 'zero',
  };
};

// How long until the shown second changes: the next frame is drawn then.
export const nextTickMs = (remainingMs: number): number => {
  const rest = remainingMs % SECOND_MS;
  return remainingMs <= 0 ? SECOND_MS : rest || SECOND_MS;
};
