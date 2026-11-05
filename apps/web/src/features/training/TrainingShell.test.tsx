import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptReview, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { TrainingShell } from './TrainingShell';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000000';

vi.mock('next/navigation', () => ({
  usePathname: () =>
    '/practice/test-exam/attempts/00000000-0000-4000-8000-000000000000/lesen',
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

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

const render = (initialReview: AttemptReview | null, isResultPending = false) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrainingShell
        examSlug="test-exam"
        attemptId={ATTEMPT_ID}
        questions={questions}
        trackIds={['track-1']}
        initialSelections={{ 'hoeren-1': 'a' }}
        initialRevisions={{ 'hoeren-1': 1 }}
        initialReview={initialReview}
        initialProgress={null}
        isResultPending={isResultPending}
        phaseRevision={0}
        resolveAudio={async () => ({ ok: false, error: 'unavailable' })}
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
    expect(html).toContain(`href="/practice/test-exam/attempts/${ATTEMPT_ID}"`);
    expect(html).toContain(
      `href="/practice/test-exam/attempts/${ATTEMPT_ID}/lesen"`,
    );
    expect(html).toContain('data-testid="finish-attempt"');
    expect(html).toContain('data-testid="cancel-attempt"');
    expect(html).toContain('Answered in total: 1 of 3.');
    expect(html).not.toContain('data-testid="finish-confirmation"');
    expect(html).not.toContain('data-testid="restart-attempt"');
  });

  it('keeps the dictionary apart from the recording and the attempt', () => {
    const html = render(null);
    const audio = html.indexOf('data-testid="audio-element"');
    const bar = html.indexOf('data-testid="dictionary-bar"');
    const boundary = html.indexOf('data-testid="dictionary-boundary"');
    const page = html.indexOf('block page');
    const finish = html.indexOf('data-testid="finish-attempt"');
    // The recording comes before the dictionary, the finish point after the
    // block: neither is inside the dictionary boundary.
    expect(audio).toBeGreaterThan(-1);
    expect(audio).toBeLessThan(bar);
    expect(bar).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(page);
    expect(page).toBeLessThan(finish);
    expect(html.match(/data-testid="audio-element"/g)).toHaveLength(1);
    expect(html).toMatch(
      /aria-pressed="true"[^>]*data-testid="dictionary-toggle"|data-testid="dictionary-toggle"[^>]*aria-pressed="true"/,
    );
    // The switch is a button, not an input that could look like an answer.
    expect(html.slice(bar, boundary)).not.toContain('<input');
    expect(html).toContain('data-enabled="true"');
    expect(html).toContain('data-testid="dictionary-translate-selection"');
    // No card is open and nothing is looked up while rendering.
    expect(html).not.toContain('data-testid="dictionary-card"');
    // The confirmed answer is still counted by the shell.
    expect(html).toContain('Answered in total: 1 of 3.');
  });

  it('shows the accepted submission instead of the finish point', () => {
    const html = render(null, true);
    expect(html).toContain('block page');
    expect(html).toContain('data-testid="submission-accepted"');
    expect(html).toContain('data-testid="result-check"');
    expect(html).not.toContain('data-testid="finish-attempt"');
    expect(html).not.toContain('data-testid="cancel-attempt"');
  });

  it('shows only the review of the open block once completed', () => {
    const html = render(review);
    expect(html).not.toContain('block page');
    expect(html).not.toContain('data-testid="audio-element"');
    expect(html).not.toContain('data-testid="finish-attempt"');
    expect(html).toContain('data-testid="restart-attempt"');
    expect(html).not.toContain('data-testid="dictionary-bar"');
    expect(html.match(/data-testid="review-item"/g)).toHaveLength(1);
    expect(html).toContain('data-question-id="lesen-1"');
  });
});
