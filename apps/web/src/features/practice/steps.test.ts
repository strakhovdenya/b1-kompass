import { describe, expect, it } from 'vitest';
import type { ExamGroup, ExamQuestion } from '@b1k/domain';
import { buildSteps } from './steps';

const question = (id: string, number: number): ExamQuestion => ({
  id,
  number,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${number}?`,
  options: [
    { id: 'a', text: 'Erste' },
    { id: 'b', text: 'Zweite' },
  ],
});

const questions = [
  question('q1', 1),
  question('q2', 2),
  question('q3', 3),
  question('q4', 4),
];

const pair = (id: string, questionIds: string[]): ExamGroup => ({
  id,
  kind: 'pair',
  teil: 3,
  trackId: 'track',
  questionIds,
});

const keysOf = (steps: ReturnType<typeof buildSteps>) =>
  steps.map((step) => step.questions.map((item) => item.id));

describe('buildSteps', () => {
  it('makes one step per question without groups', () => {
    expect(keysOf(buildSteps(questions, []))).toEqual([
      ['q1'],
      ['q2'],
      ['q3'],
      ['q4'],
    ]);
  });

  it('joins the members of a pair at the place of the first member', () => {
    const steps = buildSteps(questions, [pair('p', ['q2', 'q3'])]);
    expect(keysOf(steps)).toEqual([['q1'], ['q2', 'q3'], ['q4']]);
    expect(steps[1]?.group?.id).toBe('p');
    expect(steps[0]?.group).toBeNull();
  });

  it('ignores a pair with a member that is not shown', () => {
    const steps = buildSteps(questions, [pair('p', ['q2', 'missing'])]);
    expect(keysOf(steps)).toEqual([['q1'], ['q2'], ['q3'], ['q4']]);
  });
});

describe('buildSteps with a shared set', () => {
  const shared = (questionIds: string[]): ExamGroup => ({
    id: 's',
    kind: 'shared-set',
    teil: 4,
    trackId: 'track',
    options: [
      { id: 'a', text: 'Erste' },
      { id: 'b', text: 'Zweite' },
    ],
    questionIds,
  });

  it('joins all members of the set into one step', () => {
    const steps = buildSteps(questions, [shared(['q2', 'q3', 'q4'])]);
    expect(keysOf(steps)).toEqual([['q1'], ['q2', 'q3', 'q4']]);
    expect(steps[1]?.group?.kind).toBe('shared-set');
  });

  it('keeps the members that exist when the set names a missing one', () => {
    const steps = buildSteps(questions, [shared(['q3', 'missing'])]);
    expect(keysOf(steps)).toEqual([['q1'], ['q2'], ['q3'], ['q4']]);
    expect(steps[2]?.group?.id).toBe('s');
  });
});
