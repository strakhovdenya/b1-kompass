// Pure rule for where a recording belongs. Every moment is passed in: the
// calculator reads no element, no clock and no storage, and it changes no
// deadline, phase or answer; it only returns a number of seconds.

const SECOND_MS = 1000;

// A full exam plays on the pinned server timeline: the recording belongs to
// the time that has passed since Hören began. Training and a timed block
// restore the place the guest left themselves; there the recording never
// follows a clock.
export type AudioPositionInput =
  | {
      readonly mode: 'exam';
      readonly serverNowMs: number;
      readonly hoerenStartedAtMs: number;
      readonly durationSeconds: number;
    }
  | {
      readonly mode: 'training' | 'timed-block';
      readonly savedSeconds: number;
      readonly durationSeconds: number;
    };

// Never before the start, never past the end. A recording whose length is
// not known yet has no upper bound, and an unusable number is the start.
const bounded = (seconds: number, durationSeconds: number): number => {
  if (Number.isNaN(seconds)) return 0;
  const upper =
    Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? durationSeconds
      : Infinity;
  const target = Math.min(Math.max(0, seconds), upper);
  return Number.isFinite(target) ? target : 0;
};

export const audioTargetSeconds = (input: AudioPositionInput): number => {
  if (input.mode === 'exam') {
    const elapsedMs = input.serverNowMs - input.hoerenStartedAtMs;
    return bounded(elapsedMs / SECOND_MS, input.durationSeconds);
  }
  return bounded(input.savedSeconds, input.durationSeconds);
};
