import { describe, expect, it } from 'vitest';
import { decideSave } from './useAttemptProgress';

// The decision of the place queue (#108): send now, keep for the timer, or
// do nothing. The hook only carries it out.

const WAITING = 6_000;

describe('decideSave', () => {
  it('urgent report of a pending place is sent at once', () => {
    // A time update queued the place; the pause reports the same place.
    expect(
      decideSave({
        isChanged: false,
        isPending: true,
        isUrgent: true,
        waitMs: WAITING,
      }),
    ).toBe('send');
  });

  it('urgent report of a new place is sent at once', () => {
    expect(
      decideSave({
        isChanged: true,
        isPending: false,
        isUrgent: true,
        waitMs: WAITING,
      }),
    ).toBe('send');
  });

  it('urgent report of the sent place sends nothing', () => {
    expect(
      decideSave({
        isChanged: false,
        isPending: false,
        isUrgent: true,
        waitMs: WAITING,
      }),
    ).toBe('skip');
  });

  it('non urgent report of the sent place sends nothing', () => {
    expect(
      decideSave({
        isChanged: false,
        isPending: false,
        isUrgent: false,
        waitMs: 0,
      }),
    ).toBe('skip');
  });

  it('non urgent reports stay throttled', () => {
    const report = (waitMs: number, isPending: boolean) =>
      decideSave({ isChanged: true, isPending, isUrgent: false, waitMs });
    // Inside the interval every change waits for the timer, pending or not.
    expect(report(WAITING, false)).toBe('defer');
    expect(report(1, true)).toBe('defer');
    // Once the interval is over the next change goes out.
    expect(report(0, false)).toBe('send');
    expect(report(-500, true)).toBe('send');
  });
});
