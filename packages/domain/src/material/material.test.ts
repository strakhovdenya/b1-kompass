import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_TRACK_ID,
  buildSyntheticPilot,
  examContentSchema,
  findInventoryProblems,
  findMaterialProblems,
} from '../index';
import type { ExamContent, MaterialProblem } from '../index';

const TRACKS = new Set([SYNTHETIC_TRACK_ID]);
const INVENTORY = { hoeren: 20, lesen: 25 };

const withQuestions = (
  content: ExamContent,
  change: (questions: ExamContent['questions']) => ExamContent['questions'],
): ExamContent => ({ ...content, questions: change(content.questions) });

describe('complete pilot structure', () => {
  it('accepts complete pilot structure', () => {
    const { content, keys } = buildSyntheticPilot();
    const problems = findMaterialProblems(content, keys, { trackIds: TRACKS });
    expect(problems).toEqual([]);
    expect(findInventoryProblems(content, INVENTORY)).toEqual([]);
    expect(content.questions.filter((q) => q.skill === 'hoeren')).toHaveLength(
      20,
    );
    expect(content.questions.filter((q) => q.skill === 'lesen')).toHaveLength(
      25,
    );
    expect(Object.keys(keys)).toHaveLength(45);
    expect(content.groups?.map((group) => group.kind)).toContain('shared-set');
    expect(
      content.groups?.filter((group) => group.kind === 'pair'),
    ).toHaveLength(4);
    expect(content.examples).toHaveLength(1);
    expect(examContentSchema.safeParse(content).success).toBe(true);
  });

  it('numbers the skills independently', () => {
    const { content, keys } = buildSyntheticPilot();
    const numbers = content.questions.map((q) => `${q.skill}:${q.number}`);
    expect(new Set(numbers).size).toBe(45);
    expect(findMaterialProblems(content, keys)).toEqual([]);
  });
});

describe('rejects incomplete inconsistent pilot', () => {
  const run = (
    content: ExamContent,
    keys: Readonly<Record<string, string>>,
  ): MaterialProblem[] =>
    findMaterialProblems(content, keys, { trackIds: TRACKS });

  it('rejects incomplete inconsistent pilot', () => {
    const { content, keys } = buildSyntheticPilot();

    const { 'hoeren-1': removed, ...withoutKey } = keys;
    expect(removed).toBe('b');
    expect(run(content, withoutKey)).toEqual([
      { code: 'missing-key', questionId: 'hoeren-1' },
    ]);

    expect(run(content, { ...keys, 'hoeren-2': 'z' })).toEqual([
      { code: 'key-not-option', questionId: 'hoeren-2' },
    ]);

    expect(run(content, { ...keys, 'beispiel-hoeren-3': 'a' })).toEqual([
      { code: 'key-for-example', questionId: 'beispiel-hoeren-3' },
    ]);

    expect(run(content, { ...keys, 'hoeren-99': 'a' })).toEqual([
      { code: 'unknown-key', questionId: 'hoeren-99' },
    ]);

    const duplicatedNumber = withQuestions(content, (questions) =>
      questions.map((q) => (q.id === 'lesen-2' ? { ...q, number: 1 } : q)),
    );
    expect(run(duplicatedNumber, keys)).toEqual([
      { code: 'duplicate-number', questionId: 'lesen-2' },
    ]);

    const duplicatedOption = withQuestions(content, (questions) =>
      questions.map((q) =>
        q.id === 'hoeren-3'
          ? { ...q, options: [q.options[0]!, q.options[1]!, q.options[1]!] }
          : q,
      ),
    );
    expect(run(duplicatedOption, keys)).toEqual([
      { code: 'duplicate-option', questionId: 'hoeren-3' },
    ]);

    const brokenText = withQuestions(content, (questions) =>
      questions.map((q) => (q.id === 'lesen-4' ? { ...q, textId: 'gone' } : q)),
    );
    expect(run(brokenText, keys)).toEqual([
      { code: 'broken-reference', questionId: 'lesen-4' },
    ]);

    const brokenTrack = withQuestions(content, (questions) =>
      questions.map((q) =>
        q.id === 'hoeren-5' ? { ...q, trackId: 'gone' } : q,
      ),
    );
    expect(run(brokenTrack, keys)).toEqual([
      { code: 'broken-reference', questionId: 'hoeren-5' },
    ]);
  });

  it('rejects broken groups', () => {
    const { content, keys } = buildSyntheticPilot();
    const groups = content.groups ?? [];

    const missingMember = {
      ...content,
      groups: groups.map((g) =>
        g.id === 'hoeren-paar-1'
          ? { ...g, questionIds: ['hoeren-10', 'nope'] }
          : g,
      ),
    };
    expect(run(missingMember, keys)).toEqual([
      { code: 'broken-reference', questionId: 'hoeren-paar-1' },
    ]);

    const wrongKinds = {
      ...content,
      groups: groups.map((g) =>
        g.id === 'hoeren-paar-1'
          ? { ...g, questionIds: [...g.questionIds].reverse() }
          : g,
      ),
    };
    expect(run(wrongKinds, keys)).toEqual([
      { code: 'invalid-group', questionId: 'hoeren-paar-1' },
    ]);

    const shortSet = {
      ...content,
      groups: groups.map((g) =>
        g.kind === 'shared-set'
          ? { ...g, questionIds: g.questionIds.slice(0, 2) }
          : g,
      ),
    };
    const shortProblems = run(shortSet, keys);
    expect(shortProblems).toContainEqual({
      code: 'invalid-group',
      questionId: 'hoeren-teil-4',
    });

    const otherOptions = withQuestions(content, (questions) =>
      questions.map((q) =>
        q.id === 'hoeren-18' ? { ...q, options: q.options.slice(0, 5) } : q,
      ),
    );
    expect(run(otherOptions, keys)).toEqual([
      { code: 'options-mismatch', questionId: 'hoeren-18' },
    ]);

    const ungrouped = { ...content, groups: [] };
    expect(run(ungrouped, keys)).toContainEqual({
      code: 'invalid-group',
      questionId: 'hoeren-18',
    });
  });

  it('rejects ambiguous groups, examples and true-false options', () => {
    const { content, keys } = buildSyntheticPilot();
    const groups = content.groups ?? [];

    const twice = {
      ...content,
      groups: groups.map((g) =>
        g.id === 'hoeren-paar-2'
          ? { ...g, questionIds: ['hoeren-10', 'hoeren-11'] }
          : g,
      ),
    };
    expect(run(twice, keys)).toContainEqual({
      code: 'invalid-group',
      questionId: 'hoeren-10',
    });

    const otherTrack = withQuestions(content, (questions) =>
      questions.map((q) =>
        q.id === 'hoeren-18' ? { ...q, trackId: 'other' } : q,
      ),
    );
    expect(run(otherTrack, keys)).toContainEqual({
      code: 'broken-reference',
      questionId: 'hoeren-18',
    });

    const example = content.examples?.[0];
    if (!example) throw new Error('example is missing');
    const duplicated = {
      ...content,
      examples: [
        { ...example, options: [example.options[0]!, example.options[0]!] },
      ],
    };
    expect(run(duplicated, keys)).toEqual([
      { code: 'duplicate-option', questionId: example.id },
    ]);

    const threeWay = withQuestions(content, (questions) =>
      questions.map((q) =>
        q.id === 'hoeren-10'
          ? { ...q, options: [...q.options, { id: 'c', text: 'Vielleicht' }] }
          : q,
      ),
    );
    expect(run(threeWay, keys)).toEqual([
      { code: 'options-mismatch', questionId: 'hoeren-10' },
    ]);
  });

  it('rejects an inventory that differs from the full pilot', () => {
    const { content } = buildSyntheticPilot();
    const short = withQuestions(content, (questions) => questions.slice(0, 40));
    expect(findInventoryProblems(short, INVENTORY)).toEqual([
      { code: 'inventory-mismatch', questionId: 'lesen' },
    ]);
  });
});
