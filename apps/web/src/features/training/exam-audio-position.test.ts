import { describe, expect, it } from 'vitest';
import { audioTargetSeconds } from './exam-audio-position';
import type { AudioPositionInput } from './exam-audio-position';

const START_MS = Date.parse('2026-11-01T10:00:00.000Z');
const DURATION = 1200;

const exam = (
  elapsedSeconds: number,
  durationSeconds = DURATION,
): AudioPositionInput => ({
  mode: 'exam',
  serverNowMs: START_MS + elapsedSeconds * 1000,
  hoerenStartedAtMs: START_MS,
  durationSeconds,
});

const saved = (
  mode: 'training' | 'timed-block',
  savedSeconds: number,
  durationSeconds = DURATION,
): AudioPositionInput => ({ mode, savedSeconds, durationSeconds });

describe('calculates bounded audio targets by mode', () => {
  it('puts a full exam at the server time since Hören began', () => {
    expect(audioTargetSeconds(exam(0))).toBe(0);
    expect(audioTargetSeconds(exam(437.5))).toBe(437.5);
  });

  it('ignores a saved place in a full exam', () => {
    const input = { ...exam(90), savedSeconds: 800 };
    expect(audioTargetSeconds(input)).toBe(90);
  });

  it('restores the own saved place in training and a timed block', () => {
    expect(audioTargetSeconds(saved('training', 312.4))).toBe(312.4);
    expect(audioTargetSeconds(saved('timed-block', 45))).toBe(45);
  });

  it('follows no clock outside a full exam', () => {
    const input = {
      ...saved('training', 10),
      serverNowMs: START_MS + 999_000,
      hoerenStartedAtMs: START_MS,
    };
    expect(audioTargetSeconds(input)).toBe(10);
  });

  it('keeps a target inside the recording', () => {
    expect(audioTargetSeconds(exam(DURATION + 50))).toBe(DURATION);
    expect(audioTargetSeconds(saved('training', DURATION + 50))).toBe(DURATION);
  });
});

describe('audio targets clamp invalid bounds without changing lifecycle', () => {
  it('never goes before the start when the server moment is earlier', () => {
    expect(audioTargetSeconds(exam(-30))).toBe(0);
    expect(audioTargetSeconds(saved('training', -5))).toBe(0);
  });

  it('never goes past the end', () => {
    expect(audioTargetSeconds(exam(1e9))).toBe(DURATION);
    expect(audioTargetSeconds(saved('timed-block', Infinity))).toBe(DURATION);
  });

  it('treats unusable numbers as the start', () => {
    expect(audioTargetSeconds(exam(Number.NaN))).toBe(0);
    expect(audioTargetSeconds(saved('training', Number.NaN))).toBe(0);
    expect(audioTargetSeconds(saved('training', -Infinity))).toBe(0);
  });

  it('leaves an unknown length without an upper bound', () => {
    expect(audioTargetSeconds(exam(300, Number.NaN))).toBe(300);
    expect(audioTargetSeconds(saved('training', 20, Infinity))).toBe(20);
  });

  it('does not change its input or depend on the local clock', () => {
    const input = Object.freeze(exam(250));
    const before = JSON.stringify(input);
    const first = audioTargetSeconds(input);
    expect(audioTargetSeconds(input)).toBe(first);
    expect(JSON.stringify(input)).toBe(before);
  });
});
