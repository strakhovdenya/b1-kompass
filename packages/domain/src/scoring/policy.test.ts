import { describe, expect, it } from 'vitest';
import { selectScoringPolicy, toPercent } from '../index';
import type { ExamQuestion } from '../index';

const question = (id: string, number: number): ExamQuestion => ({
  id,
  number,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${number}?`,
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ],
});

const questions = [
  question('hoeren-1', 1),
  question('hoeren-2', 2),
  question('hoeren-3', 3),
  question('hoeren-4', 4),
];
const keys = {
  'hoeren-1': 'c',
  'hoeren-2': 'a',
  'hoeren-3': 'b',
  'hoeren-4': 'c',
};

const shortSet = () => {
  const policy = selectScoringPolicy('DTZ', 'short-set');
  if (!policy) throw new Error('short-set policy is missing');
  return policy;
};

describe('short-set scoring policy', () => {
  it('counts correct, incorrect and skipped tasks without a level', () => {
    const policy = shortSet();
    const result = policy.score({
      questions,
      keys,
      selections: { 'hoeren-1': 'c', 'hoeren-2': 'b', 'hoeren-4': 'c' },
    });
    expect(policy.showsLevel).toBe(false);
    expect(result).toMatchObject({
      scope: 'short-set',
      score: 2,
      maxScore: 4,
      correct: 2,
      incorrect: 1,
      skipped: 1,
    });
    expect(result.items).toEqual([
      {
        questionId: 'hoeren-1',
        selectedOptionId: 'c',
        correctOptionId: 'c',
        outcome: 'correct',
      },
      {
        questionId: 'hoeren-2',
        selectedOptionId: 'b',
        correctOptionId: 'a',
        outcome: 'incorrect',
      },
      {
        questionId: 'hoeren-3',
        selectedOptionId: null,
        correctOptionId: 'b',
        outcome: 'skipped',
      },
      {
        questionId: 'hoeren-4',
        selectedOptionId: 'c',
        correctOptionId: 'c',
        outcome: 'correct',
      },
    ]);
  });

  it('scores an empty attempt as all skipped with zero points', () => {
    const result = shortSet().score({ questions, keys, selections: {} });
    expect(result).toMatchObject({ score: 0, correct: 0, incorrect: 0 });
    expect(result.skipped).toBe(4);
    expect(result.items.every((item) => item.outcome === 'skipped')).toBe(true);
  });

  it('ignores answers to questions outside the version', () => {
    const result = shortSet().score({
      questions: questions.slice(0, 2),
      keys: { 'hoeren-1': 'c', 'hoeren-2': 'a' },
      selections: { 'hoeren-1': 'c', 'other-9': 'a' },
    });
    expect(result.items.map((item) => item.questionId)).toEqual([
      'hoeren-1',
      'hoeren-2',
    ]);
    expect(result).toMatchObject({ score: 1, maxScore: 2, skipped: 1 });
  });

  it('stops on a question without a key', () => {
    const { 'hoeren-3': _missing, ...partial } = keys;
    expect(() =>
      shortSet().score({ questions, keys: partial, selections: {} }),
    ).toThrow(/hoeren-3/);
  });

  it('has no policy for scopes without a scale', () => {
    expect(selectScoringPolicy('DTZ', 'full-exam')?.showsLevel).toBe(true);
    expect(selectScoringPolicy('OTHER', 'short-set')).toBeNull();
  });

  it('rounds the percentage of points', () => {
    expect(toPercent(2, 3)).toBe(66.7);
    expect(toPercent(0, 4)).toBe(0);
    expect(toPercent(4, 4)).toBe(100);
  });
});
