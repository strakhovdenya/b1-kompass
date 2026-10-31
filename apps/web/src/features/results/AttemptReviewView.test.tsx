import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { AttemptReview, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { AttemptReviewView } from './AttemptReviewView';

const question = (id: string, number: number): ExamQuestion => ({
  id,
  number,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${number} <b>?</b>`,
  options: [
    { id: 'a', text: 'Erste' },
    { id: 'b', text: 'Zweite' },
  ],
});

const questions = [question('hoeren-1', 1), question('hoeren-2', 2)];

const review: AttemptReview = {
  attemptId: '00000000-0000-4000-8000-000000000000',
  scope: 'short-set',
  showsLevel: false,
  score: 1,
  maxScore: 2,
  percent: 50,
  correct: 1,
  incorrect: 0,
  skipped: 1,
  skills: null,
  level: null,
  completedAt: '2026-10-31T10:00:00.000Z',
  items: [
    {
      questionId: 'hoeren-1',
      selectedOptionId: 'b',
      correctOptionId: 'b',
      outcome: 'correct',
    },
    {
      questionId: 'hoeren-2',
      selectedOptionId: null,
      correctOptionId: 'a',
      outcome: 'skipped',
    },
  ],
};

const render = (value: AttemptReview) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AttemptReviewView review={value} questions={questions} />
    </NextIntlClientProvider>,
  );

describe('AttemptReviewView', () => {
  it('shows points, counts and the scope note instead of a level', () => {
    const html = render(review);
    expect(html).toContain('1 of 2 points (50%)');
    expect(html).toContain('Right: 1 · Wrong: 0 · Skipped: 1');
    expect(html).toContain('not an official DTZ level');
    expect(html).toContain('data-outcome="correct"');
    expect(html).toContain('data-outcome="skipped"');
    expect(html).toContain('no answer');
  });

  it('renders German material as text with its language', () => {
    const html = render(review);
    expect(html).not.toContain('<b>');
    expect(html).toContain('Frage 1 &lt;b&gt;?&lt;/b&gt;');
    expect(html).toContain('lang="de"');
  });

  it('omits the scope note only when a policy shows a level', () => {
    expect(render({ ...review, showsLevel: true })).not.toContain(
      'data-testid="result-scope"',
    );
  });
});
