import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { AttemptReview, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import { AttemptReviewView } from './AttemptReviewView';
import type { RestartStatus } from './AttemptReviewView';

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

const render = (value: AttemptReview, locale = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'ru' ? ruMessages : messages}
    >
      <AttemptReviewView review={value} questions={questions} />
    </NextIntlClientProvider>,
  );

describe('AttemptReviewView', () => {
  it('shows points, counts and the scope note instead of a level', () => {
    const html = render(review);
    expect(html).toContain('1 of 2 points (50.0%)');
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

  it('offers a new run only with a handler and shows its state', () => {
    const renderRestart = (status: RestartStatus, locale = 'en') =>
      renderToStaticMarkup(
        <NextIntlClientProvider
          locale={locale}
          messages={locale === 'ru' ? ruMessages : messages}
        >
          <AttemptReviewView
            review={review}
            questions={questions}
            onRestart={() => undefined}
            restartStatus={status}
          />
        </NextIntlClientProvider>,
      );
    expect(render(review)).not.toContain('data-testid="restart-attempt"');
    const idle = renderRestart('idle');
    expect(idle).toContain('data-testid="restart-attempt"');
    expect(idle).toContain(messages.results.restart);
    expect(idle).not.toContain('data-testid="restart-status"');
    expect(renderRestart('idle', 'ru')).toContain(ruMessages.results.restart);
    expect(renderRestart('restarting')).toContain('disabled=""');
    expect(renderRestart('error')).toContain('data-testid="restart-status"');
  });

  it('omits the scope note only when a policy shows a level', () => {
    expect(render({ ...review, showsLevel: true })).not.toContain(
      'data-testid="result-scope"',
    );
  });

  const full: AttemptReview = {
    ...review,
    scope: 'full-exam',
    showsLevel: true,
    score: 33,
    maxScore: 45,
    percent: 73.3,
    skills: {
      hoeren: { score: 15, maxScore: 20 },
      lesen: { score: 18, maxScore: 25 },
    },
    level: 'B1',
  };

  it('shows the stored totals per skill, the level and a localized percent', () => {
    const html = render(full);
    expect(html).toContain('33 of 45 points (73.3%)');
    expect(html).toContain('Hören: 15 of 20 points');
    expect(html).toContain('Lesen: 18 of 25 points');
    expect(html).toContain('Level: B1');
    expect(html).not.toContain('data-testid="result-scope"');
    const ru = render(full, 'ru');
    expect(ru).toContain('73,3');
    expect(ru).toContain('Уровень: B1');
  });

  it('lists only the tasks of the requested block', () => {
    const lesen = { ...question('lesen-1', 1), skill: 'lesen' as const };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AttemptReviewView
          review={{
            ...review,
            items: [
              ...review.items,
              {
                questionId: 'lesen-1',
                selectedOptionId: null,
                correctOptionId: 'a',
                outcome: 'skipped',
              },
            ],
          }}
          questions={[...questions, lesen]}
          block="lesen"
        />
      </NextIntlClientProvider>,
    );
    expect(html.match(/data-testid="review-item"/g)).toHaveLength(1);
    expect(html).toContain('data-question-id="lesen-1"');
  });

  it('escapes a script in the task text and in the options', () => {
    const hostile: ExamQuestion = {
      ...question('hoeren-1', 1),
      prompt: '<script>window.__xss=1</script>',
      options: [
        { id: 'a', text: '<script>alert(1)</script>' },
        { id: 'b', text: 'Zweite' },
      ],
    };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AttemptReviewView review={review} questions={[hostile]} />
      </NextIntlClientProvider>,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;window.__xss=1&lt;/script&gt;');
  });
});
