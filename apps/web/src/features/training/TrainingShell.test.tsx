import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptReview, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { TrainingShell } from './TrainingShell';

vi.mock('next/navigation', () => ({ usePathname: () => '/practice/lesen' }));

const question = (
  id: string,
  number: number,
  skill: 'hoeren' | 'lesen',
): ExamQuestion => ({
  id,
  number,
  kind: 'single-choice',
  skill,
  teil: 1,
  prompt: `Frage ${id}?`,
  options: [{ id: 'a', text: 'Erste' }],
});

const questions = [
  question('hoeren-1', 1, 'hoeren'),
  question('hoeren-2', 2, 'hoeren'),
  question('lesen-1', 1, 'lesen'),
];

const review: AttemptReview = {
  attemptId: '00000000-0000-4000-8000-000000000000',
  scope: 'short-set',
  showsLevel: false,
  score: 0,
  maxScore: 3,
  percent: 0,
  correct: 0,
  incorrect: 0,
  skipped: 3,
  skills: null,
  level: null,
  completedAt: '2026-10-31T10:00:00.000Z',
  items: questions.map((item) => ({
    questionId: item.id,
    selectedOptionId: null,
    correctOptionId: 'a',
    outcome: 'skipped' as const,
  })),
};

const render = (initialReview: AttemptReview | null) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrainingShell
        attemptId="00000000-0000-4000-8000-000000000000"
        questions={questions}
        trackIds={['track-1']}
        initialSelections={{ 'hoeren-1': 'a' }}
        initialRevisions={{ 'hoeren-1': 1 }}
        initialReview={initialReview}
        initialProgress={null}
        resolveAudio={async () => ({ ok: false, error: 'unavailable' })}
        saveAnswer={async () => ({ ok: false, error: 'unavailable' })}
        finishAttempt={async () => ({ ok: false, error: 'unavailable' })}
        saveProgress={async () => ({ ok: false, error: 'unavailable' })}
        restartAttempt={async () => ({ ok: false, error: 'unavailable' })}
      >
        <p>block page</p>
      </TrainingShell>
    </NextIntlClientProvider>,
  );

describe('TrainingShell', () => {
  it('wraps the block with the recording, block links and one finish point', () => {
    const html = render(null);
    expect(html).toContain('block page');
    expect(html).toContain('data-testid="audio-element"');
    expect(html).toContain('data-testid="block-link-hoeren"');
    expect(html).toContain('data-testid="block-link-lesen"');
    expect(html).toContain('data-testid="finish-attempt"');
    expect(html).toContain('Answered in total: 1 of 3.');
    expect(html).not.toContain('data-testid="finish-confirmation"');
    expect(html).not.toContain('data-testid="restart-attempt"');
  });

  it('shows only the review of the open block once completed', () => {
    const html = render(review);
    expect(html).not.toContain('block page');
    expect(html).not.toContain('data-testid="audio-element"');
    expect(html).not.toContain('data-testid="finish-attempt"');
    expect(html).toContain('data-testid="restart-attempt"');
    expect(html.match(/data-testid="review-item"/g)).toHaveLength(1);
    expect(html).toContain('data-question-id="lesen-1"');
  });
});
