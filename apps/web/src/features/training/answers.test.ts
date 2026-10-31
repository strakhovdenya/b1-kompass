import { describe, expect, it } from 'vitest';
import { hasSaving, hasUnsaved, unconfirmedAfter } from './answers';

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
    for (const error of ['unavailable', 'option-not-allowed'] as const) {
      expect(unconfirmedAfter({ ok: false, error }, sent)).toEqual({
        optionId: 'b',
        revision: 3,
        status: 'error',
      });
    }
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
