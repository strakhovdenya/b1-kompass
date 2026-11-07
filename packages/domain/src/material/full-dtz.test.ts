import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_TRACK_ID,
  buildSyntheticPilot,
  findFullDtzProblems,
} from '../index';
import type { ExamContent, ExamQuestion, MaterialProblem } from '../index';

const TRACKS = new Set([SYNTHETIC_TRACK_ID]);

const check = (content: ExamContent, keys: Record<string, string>) =>
  findFullDtzProblems(content, keys, { trackIds: TRACKS });

const mapQuestions = (
  content: ExamContent,
  change: (question: ExamQuestion) => ExamQuestion,
): ExamContent => ({ ...content, questions: content.questions.map(change) });

const codes = (problems: MaterialProblem[]) => problems.map((p) => p.code);

const has = (problems: MaterialProblem[], code: string, questionId: string) =>
  problems.some((p) => p.code === code && p.questionId === questionId);

describe('full DTZ structure policy', () => {
  it('synthetic full DTZ passes structure policy', () => {
    const { content, keys } = buildSyntheticPilot();
    expect(check(content, keys)).toEqual([]);
  });

  it('inventory count alone cannot validate full DTZ structure', () => {
    const { content, keys } = buildSyntheticPilot();
    // 20 Hören and 25 Lesen remain, but a Lesen Teil 5 task moves to Teil 4
    // and a Hören Teil 1 task to Teil 2.
    const moved = mapQuestions(content, (q) => {
      if (q.id === 'lesen-25') return { ...q, teil: 4 };
      if (q.id === 'hoeren-1') return { ...q, teil: 2 };
      return q;
    });
    const problems = check(moved, keys);
    expect(has(problems, 'teil-mismatch', 'lesen:teil-4')).toBe(true);
    expect(has(problems, 'teil-mismatch', 'lesen:teil-5')).toBe(true);
    expect(has(problems, 'teil-mismatch', 'hoeren:teil-1')).toBe(true);
    expect(has(problems, 'teil-mismatch', 'hoeren:teil-2')).toBe(true);
    expect(codes(problems)).not.toContain('inventory-mismatch');
  });

  it('full DTZ structure rejects wrong numbering and groups', () => {
    const { content, keys } = buildSyntheticPilot();
    const gap = mapQuestions(content, (q) =>
      q.id === 'lesen-10' ? { ...q, number: 40 } : q,
    );
    expect(has(check(gap, keys), 'numbering-gap', 'lesen-10')).toBe(true);
    const duplicate = mapQuestions(content, (q) =>
      q.id === 'lesen-10' ? { ...q, number: 9 } : q,
    );
    expect(has(check(duplicate, keys), 'duplicate-number', 'lesen-10')).toBe(
      true,
    );
    const unordered = mapQuestions(content, (q) =>
      q.id === 'lesen-3' ? { ...q, teil: 5 } : q,
    );
    expect(has(check(unordered, keys), 'teil-order', 'lesen-4')).toBe(true);

    const noPair = {
      ...content,
      groups: (content.groups ?? []).filter((g) => g.id !== 'hoeren-paar-2'),
    };
    expect(has(check(noPair, keys), 'invalid-group', 'hoeren:teil-3')).toBe(
      true,
    );
    const noShared = {
      ...content,
      groups: (content.groups ?? []).filter((g) => g.kind !== 'shared-set'),
    };
    expect(has(check(noShared, keys), 'invalid-group', 'hoeren:teil-4')).toBe(
      true,
    );
    const tooFew = mapQuestions(content, (q) =>
      q.id === 'hoeren-20' ? { ...q, teil: 3 } : q,
    );
    expect(has(check(tooFew, keys), 'invalid-group', 'hoeren-teil-4')).toBe(
      true,
    );
  });

  it('official DTZ Lesen Teil 3 mixed question types are accepted', () => {
    const { content, keys } = buildSyntheticPilot();
    // The fixture keeps six Richtig/Falsch single choices (older pilots).
    expect(check(content, keys)).toEqual([]);
    // Official g.a.s.t. sets: three pairs of Richtig/Falsch and a/b/c.
    const abc = [
      { id: 'a', text: 'Antwort a' },
      { id: 'b', text: 'Antwort b' },
      { id: 'c', text: 'Antwort c' },
    ];
    const official = mapQuestions(content, (q) =>
      q.skill === 'lesen' && q.teil === 3 && q.number % 2 === 0
        ? { ...q, options: abc }
        : q,
    );
    expect(
      official.questions
        .filter((q) => q.skill === 'lesen' && q.teil === 3)
        .map((q) => q.options.length),
    ).toEqual([2, 3, 2, 3, 2, 3]);
    expect(check(official, keys)).toEqual([]);
    const badPair = mapQuestions(content, (q) =>
      q.id === 'lesen-15' ? { ...q, options: abc } : q,
    );
    expect(codes(check(badPair, keys))).toContain('invalid-question-kind');
  });

  it('full DTZ validator rejects multiple hoeren tracks', () => {
    const { content, keys } = buildSyntheticPilot();
    const split = mapQuestions(content, (q) =>
      q.id === 'hoeren-1' ? { ...q, trackId: 'track-other' } : q,
    );
    const problems = findFullDtzProblems(split, keys);
    expect(has(problems, 'multiple-hoeren-tracks', 'hoeren')).toBe(true);
  });

  it('full DTZ reports key problems without key values', () => {
    const { content, keys } = buildSyntheticPilot();
    const { 'hoeren-1': removed, ...rest } = keys;
    const broken = {
      ...rest,
      'beispiel-hoeren-3': 'a',
      'ghost-task': 'c',
      'lesen-1': 'z',
    };
    const problems = check(content, broken);
    expect(removed).toBeDefined();
    expect(has(problems, 'missing-key', 'hoeren-1')).toBe(true);
    expect(has(problems, 'key-for-example', 'beispiel-hoeren-3')).toBe(true);
    expect(has(problems, 'unknown-key', 'ghost-task')).toBe(true);
    expect(has(problems, 'key-not-option', 'lesen-1')).toBe(true);
    for (const problem of problems) {
      expect(Object.keys(problem).sort()).toEqual(['code', 'questionId']);
    }
  });
});
