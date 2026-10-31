import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  GUEST_TERM_HOURS,
  computeGuestExpiry,
  examContentSchema,
  findMaterialProblems,
  isGuestActive,
  isLocale,
} from './index';
import type { ExamContent } from './index';

type Question = ExamContent['questions'][number];

const first: Question = {
  id: 'hoeren-1',
  number: 1,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: 'Frage eins?',
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ],
};

const second: Question = {
  id: 'hoeren-2',
  number: 2,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: 'Frage zwei?',
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
  ],
};

const content: ExamContent = {
  source: {
    publisher: 'telc',
    title: 'Test',
    url: 'https://example.org/test.pdf',
    page: 1,
  },
  questions: [first, second],
};

describe('guest term', () => {
  const createdAt = new Date('2026-10-01T10:00:00.000Z');
  const expiresAt = computeGuestExpiry(createdAt);

  it('expires exactly 30 days after the first entry', () => {
    expect(GUEST_TERM_HOURS).toBe(30 * 24);
    expect(expiresAt.toISOString()).toBe('2026-10-31T10:00:00.000Z');
  });

  it('is active until, but not at, the expiry instant', () => {
    expect(isGuestActive(expiresAt, new Date(expiresAt.getTime() - 1))).toBe(
      true,
    );
    expect(isGuestActive(expiresAt, expiresAt)).toBe(false);
    expect(isGuestActive(expiresAt, new Date(expiresAt.getTime() + 1))).toBe(
      false,
    );
  });
});

describe('locale', () => {
  it('defaults to English and accepts only en/ru', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('material contract', () => {
  it('has no place for answer keys in the public projection', () => {
    const leaked = {
      ...content,
      questions: [{ ...first, correctOptionId: 'b' }],
    };
    expect(examContentSchema.safeParse(content).success).toBe(true);
    expect(examContentSchema.safeParse(leaked).success).toBe(false);
  });

  it('accepts a complete key and reports every broken one', () => {
    expect(
      findMaterialProblems(content, { 'hoeren-1': 'b', 'hoeren-2': 'a' }),
    ).toEqual([]);
    const duplicated = {
      ...content,
      questions: [first, second, { ...second }],
    };
    expect(
      findMaterialProblems(duplicated, {
        'hoeren-1': 'x',
        'hoeren-3': 'a',
      }),
    ).toEqual([
      { code: 'key-not-option', questionId: 'hoeren-1' },
      { code: 'missing-key', questionId: 'hoeren-2' },
      { code: 'duplicate-id', questionId: 'hoeren-2' },
      { code: 'duplicate-number', questionId: 'hoeren-2' },
      { code: 'missing-key', questionId: 'hoeren-2' },
      { code: 'unknown-key', questionId: 'hoeren-3' },
    ]);
  });
});
