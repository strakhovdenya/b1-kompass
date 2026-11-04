import { describe, expect, it } from 'vitest';
import {
  finalAnswersOf,
  hasSaving,
  hasUnsaved,
  unconfirmedAfter,
} from './answers';

const sent = { optionId: 'b', revision: 3 };

describe('unconfirmedAfter', () => {
  it('confirms only the same choice under the same revision', () => {
    const saved = {
      ok: true as const,
      questionId: 'hoeren-1',
      optionId: 'b',
      revision: 3,
      savedAt: '2026-10-31T10:00:00.000Z',
    };
    expect(unconfirmedAfter(saved, sent)).toBeNull();
    expect(unconfirmedAfter({ ...saved, optionId: 'a' }, sent)).toEqual({
      optionId: 'b',
      revision: null,
      status: 'error',
    });
    expect(unconfirmedAfter({ ...saved, revision: 4 }, sent)).toEqual({
      optionId: 'b',
      revision: null,
      status: 'error',
    });
  });

  it('renews the revision after a stale or conflicting save', () => {
    for (const error of ['stale', 'conflict'] as const) {
      const result = { ok: false as const, error, optionId: 'c', revision: 5 };
      expect(unconfirmedAfter(result, sent)).toEqual({
        optionId: 'b',
        revision: null,
        status: 'error',
      });
    }
  });

  it('needs no retry when a newer save stored the same choice', () => {
    const result = {
      ok: false as const,
      error: 'stale' as const,
      optionId: 'b',
      revision: 5,
    };
    expect(unconfirmedAfter(result, sent)).toBeNull();
  });

  it('keeps the revision for a retry after a failed request', () => {
    expect(unconfirmedAfter({ ok: false, error: 'unavailable' }, sent)).toEqual(
      { optionId: 'b', revision: 3, status: 'error' },
    );
    // A rejected option can be retried but is marked as rejected.
    expect(
      unconfirmedAfter({ ok: false, error: 'option-not-allowed' }, sent),
    ).toEqual({
      optionId: 'b',
      revision: 3,
      status: 'error',
      isRejected: true,
    });
  });

  it('marks a choice that can no longer be saved', () => {
    const ended = { ok: false as const, error: 'session-invalid' as const };
    expect(unconfirmedAfter(ended, sent)?.status).toBe('session-invalid');
    for (const error of ['attempt-not-found', 'invalid-input'] as const) {
      expect(unconfirmedAfter({ ok: false, error }, sent)?.status).toBe(
        'refused',
      );
    }
  });
});

describe('pending answers', () => {
  const failed = { optionId: 'a', revision: 1, status: 'error' as const };
  const saving = { optionId: 'b', revision: 2, status: 'saving' as const };
  const refused = { optionId: 'c', revision: 1, status: 'refused' as const };

  it('is saving only while a save is in flight', () => {
    expect(hasSaving({})).toBe(false);
    expect(hasSaving({ 'hoeren-1': failed })).toBe(false);
    expect(hasSaving({ 'hoeren-1': failed, 'lesen-1': saving })).toBe(true);
  });

  it('is unsaved while a choice is in flight or can be retried', () => {
    expect(hasUnsaved({})).toBe(false);
    expect(hasUnsaved({ 'hoeren-1': refused })).toBe(false);
    expect(hasUnsaved({ 'hoeren-1': failed })).toBe(true);
    expect(hasUnsaved({ 'lesen-1': saving })).toBe(true);
  });
});

describe('final answers', () => {
  const allocations: string[] = [];
  const allocate = (questionId: string) => {
    allocations.push(questionId);
    return 9;
  };

  it('sends confirmed choices and every saving or failed choice', () => {
    allocations.length = 0;
    const answers = finalAnswersOf({
      selections: { 'hoeren-1': 'a', 'hoeren-2': 'b', 'lesen-1': 'c' },
      revisions: { 'hoeren-1': 2, 'hoeren-2': 1, 'lesen-1': 4 },
      pending: {
        'hoeren-2': { optionId: 'c', revision: 3, status: 'saving' },
        'lesen-2': { optionId: 'a', revision: 2, status: 'error' },
        'lesen-3': { optionId: 'b', revision: null, status: 'error' },
      },
      allocate,
    });
    expect(answers).toEqual([
      { questionId: 'hoeren-1', optionId: 'a', revision: 2 },
      { questionId: 'hoeren-2', optionId: 'c', revision: 3 },
      { questionId: 'lesen-1', optionId: 'c', revision: 4 },
      { questionId: 'lesen-2', optionId: 'a', revision: 2 },
      { questionId: 'lesen-3', optionId: 'b', revision: 9 },
    ]);
    expect(allocations).toEqual(['lesen-3']);
  });

  it('leaves out a choice the server refused', () => {
    allocations.length = 0;
    const answers = finalAnswersOf({
      selections: { 'hoeren-1': 'a' },
      revisions: { 'hoeren-1': 1 },
      pending: {
        'hoeren-1': { optionId: 'b', revision: 2, status: 'refused' },
        'lesen-1': { optionId: 'c', revision: 1, status: 'session-invalid' },
        'lesen-2': {
          optionId: 'x',
          revision: 1,
          status: 'error',
          isRejected: true,
        },
      },
      allocate,
    });
    expect(answers).toEqual([
      { questionId: 'hoeren-1', optionId: 'a', revision: 1 },
    ]);
    expect(allocations).toEqual([]);
  });
});
