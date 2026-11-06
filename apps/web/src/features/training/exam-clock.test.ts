import { describe, expect, it } from 'vitest';
import * as clock from './exam-clock';
import {
  displayAt,
  formatSeconds,
  nextTickMs,
  remainingMsAt,
  serverNowAt,
  syncOf,
} from './exam-clock';

const DEADLINE_MS = Date.UTC(2026, 10, 6, 12, 0, 0);
const MINUTE_MS = 60_000;

describe('exam clock', () => {
  it('remaining time uses explicit server offset and deadline', () => {
    // The server said 11:55:00 when the request was sent at local 1000 and
    // answered at local 1400: the reading belongs to local 1200.
    const sync = syncOf(DEADLINE_MS - 5 * MINUTE_MS, 1000, 1400);
    expect(sync).toEqual({
      serverNowMs: DEADLINE_MS - 5 * MINUTE_MS,
      localMs: 1200,
    });
    expect(serverNowAt(sync, 1200)).toBe(DEADLINE_MS - 5 * MINUTE_MS);
    expect(serverNowAt(sync, 61_200)).toBe(DEADLINE_MS - 4 * MINUTE_MS);

    // Only the explicit inputs count: the same inputs give the same display
    // whatever the device clock says.
    const shown = displayAt(DEADLINE_MS, sync, 61_200);
    expect(shown).toEqual({
      remainingMs: 4 * MINUTE_MS,
      seconds: 240,
      label: '4:00',
      state: 'running',
    });
    expect(displayAt(DEADLINE_MS, sync, 61_200)).toEqual(shown);

    // A second reading with a skewed device clock but the same server time
    // gives the same remaining time: the local clock only measures elapsed
    // time between readings.
    const later = syncOf(DEADLINE_MS - 4 * MINUTE_MS, 9_000_000, 9_000_000);
    expect(displayAt(DEADLINE_MS, later, 9_000_000)).toEqual(shown);

    // A part of a second shows the whole second still left.
    expect(displayAt(DEADLINE_MS, sync, 1200 + 5 * MINUTE_MS - 1).label).toBe(
      '0:01',
    );
    expect(formatSeconds(25 * 60)).toBe('25:00');
    expect(formatSeconds(45 * 60 + 5)).toBe('45:05');
    expect(formatSeconds(3600 + 61)).toBe('1:01:01');
    expect(nextTickMs(1500)).toBe(500);
    expect(nextTickMs(2000)).toBe(1000);
  });

  it('clock clamps negative display without granting admission', () => {
    const sync = syncOf(DEADLINE_MS, 0, 0);
    // Exactly at the deadline and after it: zero, never negative.
    expect(displayAt(DEADLINE_MS, sync, 0)).toEqual({
      remainingMs: 0,
      seconds: 0,
      label: '0:00',
      state: 'zero',
    });
    expect(displayAt(DEADLINE_MS, sync, 3 * MINUTE_MS)).toEqual(
      displayAt(DEADLINE_MS, sync, 0),
    );
    expect(remainingMsAt(DEADLINE_MS, DEADLINE_MS + 1)).toBe(0);
    // An unusable offset shows no time left rather than more.
    expect(remainingMsAt(DEADLINE_MS, Number.NaN)).toBe(0);
    expect(displayAt(Number.NaN, sync, 0).state).toBe('zero');
    expect(formatSeconds(-5)).toBe('0:00');
    expect(nextTickMs(0)).toBe(1000);

    // A wrong offset that shows time left is only a display: the module has
    // no admission, and its result carries no permission to write.
    const wrong = syncOf(DEADLINE_MS - 10 * MINUTE_MS, 0, 0);
    const shown = displayAt(DEADLINE_MS, wrong, 0);
    expect(shown.state).toBe('running');
    expect(Object.keys(shown).sort()).toEqual([
      'label',
      'remainingMs',
      'seconds',
      'state',
    ]);
    expect(Object.keys(clock).sort()).toEqual([
      'displayAt',
      'formatSeconds',
      'nextTickMs',
      'remainingMsAt',
      'serverNowAt',
      'syncOf',
    ]);
  });
});
