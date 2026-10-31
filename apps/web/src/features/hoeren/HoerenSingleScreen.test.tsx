import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamGroup, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import {
  HoerenSingleScreen,
  selectQuestions,
  selectSingleQuestions,
} from './HoerenSingleScreen';

const question = (
  id: string,
  fields: Partial<ExamQuestion> = {},
): ExamQuestion => ({
  id,
  number: 1,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${id}?`,
  options: [
    { id: 'a', text: 'Erste' },
    { id: 'b', text: 'Zweite' },
  ],
  ...fields,
});

const questions = [
  question('h1', { number: 1, teil: 1 }),
  question('h2', { number: 2, teil: 2 }),
  question('h3', { number: 3, teil: 3, kind: 'true-false' }),
  question('h4', { number: 4, teil: 3 }),
  question('h5', { number: 5, teil: 4, kind: 'shared-choice' }),
  question('l1', { number: 1, skill: 'lesen', teil: 1 }),
];

describe('selectSingleQuestions', () => {
  it('keeps only single-choice Hören of Teil 1 and 2, in order', () => {
    const ids = selectSingleQuestions(questions).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2']);
  });
});

describe('HoerenSingleScreen', () => {
  it('renders the first question and the count of Teil 1–2 only', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HoerenSingleScreen
          attemptId="00000000-0000-4000-8000-000000000000"
          questions={questions}
          initialSelections={{}}
          saveAnswer={async () => ({ ok: false, error: 'unavailable' })}
        />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('Question 1 of 2');
    expect(html).toContain('Frage h1?');
    expect(html).not.toContain('data-testid="audio-element"');
    expect(html).not.toContain('Finish');
  });
});

const pair: ExamGroup = {
  id: 'pair-3',
  kind: 'pair',
  teil: 3,
  trackId: 'track-127',
  questionIds: ['h3', 'h4'],
};

describe('selectQuestions', () => {
  it('adds the members of a Teil 3 pair to the single questions', () => {
    const ids = selectQuestions(questions, [pair]).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('leaves out a pair with a member missing from the material', () => {
    const broken = { ...pair, questionIds: ['h3', 'missing'] };
    const ids = selectQuestions(questions, [broken]).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2']);
  });

  it('ignores pairs of another Teil or of another size', () => {
    const otherTeil = { ...pair, teil: 2 };
    const threeMembers = { ...pair, questionIds: ['h3', 'h4', 'h5'] };
    for (const group of [otherTeil, threeMembers]) {
      const ids = selectQuestions(questions, [group]).map((item) => item.id);
      expect(ids).toEqual(['h1', 'h2']);
    }
  });

  it('adds the members of the Teil 4 shared set', () => {
    const shared: ExamGroup = {
      id: 'set-4',
      kind: 'shared-set',
      teil: 4,
      trackId: 'track-127',
      options: [
        { id: 'a', text: 'Erste' },
        { id: 'b', text: 'Zweite' },
      ],
      questionIds: ['h5'],
    };
    const ids = selectQuestions(questions, [shared]).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2', 'h5']);
  });
});

describe('HoerenSingleScreen with a pair', () => {
  const renderAt = (initial: Record<string, string>) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HoerenSingleScreen
          attemptId="00000000-0000-4000-8000-000000000000"
          questions={questions}
          groups={[pair]}
          initialSelections={initial}
          saveAnswer={async () => ({ ok: false, error: 'unavailable' })}
        />
      </NextIntlClientProvider>,
    );

  it('counts the pair as one step and every member as an answer', () => {
    const html = renderAt({ h1: 'a', h3: 'b' });
    expect(html).toContain('Question 1 of 3');
    expect(html).toContain('Answered: 2 of 4');
    expect(html).toContain('data-testid="go-to-question-3"');
  });
});
