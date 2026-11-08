import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptReview, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { TrainingShell } from './TrainingShell';
import type { RepeatSource } from './TrainingShell';
import type { AttemptSummary, TimedClock } from './attempt-client';

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

const DEADLINE_MS = Date.parse('2026-11-06T12:25:00.000Z');

const render = (
  initialReview: AttemptReview | null,
  isResultPending = false,
  timer: TimedClock | null = null,
  repeatSource: RepeatSource | null = null,
) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TrainingShell
        examSlug="test-exam"
        examTitle="DTZ Übungstest 2"
        attemptId={ATTEMPT_ID}
        questions={questions}
        trackIds={['track-1']}
        initialSelections={{ 'hoeren-1': 'a' }}
        initialRevisions={{ 'hoeren-1': 1 }}
        initialReview={initialReview}
        initialProgress={null}
        isResultPending={isResultPending}
        phaseRevision={0}
        timer={timer}
        resolveAudio={async () => ({ ok: false, error: 'unavailable' })}
        repeatSource={repeatSource}
      >
        <p>block page</p>
      </TrainingShell>
    </NextIntlClientProvider>,
  );

describe('TrainingShell', () => {
  it('shows one compact server clock above the block of a timed run', () => {
    const html = render(null, false, {
      deadlineMs: DEADLINE_MS,
      serverNowMs: DEADLINE_MS - 25 * 60_000,
      skill: 'hoeren',
      phase: 'hoeren',
    });
    const timer = /<div[^>]*role="timer"[^>]*>/.exec(html)?.[0] ?? '';
    expect(timer).toContain('data-testid="attempt-timer"');
    expect(timer).toContain('data-deadline-ms="' + DEADLINE_MS + '"');
    expect(timer).toContain('data-state="running"');
    // Not announced every second: no live region on the clock.
    expect(timer).not.toContain('aria-live');
    expect(html).toContain('25:00 left');
    expect(html).toContain('Timed block · Hören');
    expect(html).toContain('data-mode="timed-block"');
    // One line before the block links, the recording and the block page.
    const clock = html.indexOf('data-testid="attempt-timer"');
    expect(clock).toBeLessThan(html.indexOf('data-testid="block-link-hoeren"'));
    expect(clock).toBeLessThan(html.indexOf('data-testid="audio-element"'));
    expect(clock).toBeLessThan(html.indexOf('block page'));
    expect(html.match(/role="timer"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="finish-attempt"');
  });

  it('shows no clock for a free training or a closed timed run', () => {
    expect(render(null)).not.toContain('role="timer"');
    expect(render(null)).toContain('data-mode="training"');
    const pending = render(null, true, {
      deadlineMs: DEADLINE_MS,
      serverNowMs: DEADLINE_MS - 1000,
      skill: 'lesen',
      phase: 'lesen',
    });
    expect(pending).not.toContain('role="timer"');
    expect(pending).toContain('data-testid="submission-accepted"');
  });

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
    const boundary = html.indexOf('data-testid="dictionary-boundary"');
    const action = html.indexOf('data-testid="dictionary-translate-selection"');
    const page = html.indexOf('block page');
    const finish = html.indexOf('data-testid="finish-attempt"');
    // The recording comes before the dictionary, the finish point after the
    // block: neither is inside the dictionary boundary.
    expect(audio).toBeGreaterThan(-1);
    expect(audio).toBeLessThan(boundary);
    // The keyboard action is the first control inside the boundary.
    expect(boundary).toBeLessThan(action);
    expect(action).toBeLessThan(page);
    expect(page).toBeLessThan(finish);
    expect(html.match(/data-testid="audio-element"/g)).toHaveLength(1);
    // The permanent panel is gone, and so is any second switch: the one
    // switch is portalled into the server header slot after mounting, so
    // server rendering holds none.
    expect(html).not.toContain('data-testid="dictionary-bar"');
    expect(html).not.toContain('data-testid="dictionary-toggle"');
    expect(html).not.toContain('type="radio"');
    // No card is open and nothing is looked up while rendering.
    expect(html).not.toContain('data-testid="dictionary-card"');
    // The confirmed answer is still counted by the shell.
    expect(html).toContain('Answered in total: 1 of 3.');
  });

  it('hides the recording outside Hören without unmounting it', () => {
    const html = render(null);
    const player = /<section[^>]*data-testid="audio-player"[^>]*>/.exec(html);
    // The page is Lesen: the player is hidden, the element stays in the page.
    expect(player?.[0]).toContain('hidden=""');
    expect(html).toContain('data-testid="audio-element"');
    expect(html).toContain('data-testid="audio-status"');
  });

  it('shows the accepted submission instead of the finish point', () => {
    const html = render(null, true);
    expect(html).toContain('block page');
    expect(html).toContain('data-testid="submission-accepted"');
    expect(html).toContain('data-testid="result-check"');
    expect(html).not.toContain('data-testid="finish-attempt"');
    expect(html).not.toContain('data-testid="cancel-attempt"');
  });

  it('separates assessed review from the repeat of errors', () => {
    const source: RepeatSource = {
      versionId: '00000000-0000-4000-8000-000000000001',
      selection: 'all',
    };
    const completed = render(review, false, null, source);
    expect(completed).toContain('data-testid="repeat-errors"');
    expect(completed).not.toContain('data-testid="repeat-status"');
    // The review lists only assessed tasks; no read-only card is shown.
    expect(completed).not.toContain('context-card-');
    // An open attempt offers no repeat, and none without a source.
    expect(render(null, false, null, source)).not.toContain('repeat-errors');
    expect(render(review)).not.toContain('repeat-errors');
  });

  it('shell always renders exam context header', () => {
    const open = render(null, false, {
      deadlineMs: DEADLINE_MS,
      serverNowMs: DEADLINE_MS - 60_000,
      skill: 'lesen',
      phase: 'lesen',
    });
    expect(open).toContain('data-testid="exam-context"');
    expect(open).toContain('href="/exams"');
    expect(open).toContain('DTZ Übungstest 2');
    // A free training shows the line as well, and its link is never held back.
    const free = render(null);
    expect(free).toContain('data-testid="exam-context"');
    expect(free).toContain('DTZ Übungstest 2');
  });

  it('shell review keeps exam context header', () => {
    const html = render(review);
    expect(html).toContain('<nav');
    expect(html).toContain('data-testid="exam-context"');
    expect(html).toContain('href="/exams"');
    expect(html).toContain('DTZ Übungstest 2');
    expect(html).toContain('Result');
    expect(html).not.toContain('timed-leave');
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

  describe('a full exam', () => {
    const lesenOnly = [question('lesen-1', 1, 'lesen')];

    // The server's numbers after Hören closed and Lesen started: 2 Hören
    // tasks, one answered in time; 25 Lesen tasks, none answered yet.
    const lesenSummary: AttemptSummary = {
      totalAssigned: 27,
      skills: {
        hoeren: { assigned: 2, answered: 1, state: 'closed' },
        lesen: { assigned: 25, answered: 0, state: 'open' },
      },
    };

    const renderExam = (
      shown: typeof questions,
      phase: 'hoeren' | 'transition' | 'lesen',
      summary: AttemptSummary,
      selections: Record<string, string>,
    ) =>
      renderToStaticMarkup(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TrainingShell
            examSlug="test-exam"
            examTitle="DTZ Übungstest 2"
            attemptId={ATTEMPT_ID}
            questions={shown}
            trackIds={phase === 'lesen' ? [] : ['track-1']}
            initialSelections={selections}
            initialRevisions={{}}
            initialReview={null}
            initialProgress={null}
            isResultPending={false}
            phaseRevision={phase === 'lesen' ? 2 : 0}
            timer={{
              deadlineMs: DEADLINE_MS,
              serverNowMs: DEADLINE_MS - 60_000,
              skill: phase === 'hoeren' ? 'hoeren' : 'lesen',
              phase,
            }}
            mode="exam"
            phase={phase}
            summary={summary}
            examStartedAtMs={DEADLINE_MS - 30 * 60_000}
            resolveAudio={async () => ({ ok: false, error: 'unavailable' })}
          >
            <p>block page</p>
          </TrainingShell>
        </NextIntlClientProvider>,
      );

    it('counts the whole assignment and keeps answers across a phase change', () => {
      // Hören open: the shell knows only Hören, Lesen is a number.
      const hoeren = renderExam(
        [question('hoeren-1', 1, 'hoeren'), question('hoeren-2', 2, 'hoeren')],
        'hoeren',
        {
          totalAssigned: 27,
          skills: {
            hoeren: { assigned: 2, answered: 1, state: 'open' },
            lesen: { assigned: 25, answered: 0, state: 'unopened' },
          },
        },
        { 'hoeren-1': 'a' },
      );
      expect(hoeren).toContain('Answered in total: 1 of 27.');
      expect(hoeren).toContain('data-mode="exam"');
      expect(hoeren).toContain('data-phase="hoeren"');
      expect(hoeren).not.toContain('lesen-1');

      // After the server moved to Lesen the same shell gets Lesen material:
      // the closed Hören counts by the server's numbers, the answer the
      // page holds is not dropped, and no Hören task is shown again.
      const lesen = renderExam(lesenOnly, 'lesen', lesenSummary, {
        'hoeren-1': 'a',
        'lesen-1': 'a',
      });
      expect(lesen).toContain('Answered in total: 2 of 27.');
      expect(lesen).toContain('data-phase="lesen"');
      expect(lesen).toContain('block page');
    });

    it('has one exam recording without pause or seek, inactive outside Hören', () => {
      const hoeren = renderExam(
        [question('hoeren-1', 1, 'hoeren')],
        'hoeren',
        lesenSummary,
        {},
      );
      expect(hoeren).toContain('data-mode="exam"');
      // The element itself belongs to the exam layout, never to the shell.
      expect(hoeren).not.toContain('data-testid="audio-element"');
      expect(hoeren).not.toContain('data-testid="audio-toggle"');
      expect(hoeren).not.toContain('data-testid="audio-back"');
      expect(hoeren).not.toContain('aria-label="Position in the recording"');
      expect(hoeren).toContain('data-testid="audio-status"');
      expect(hoeren.match(/data-testid="audio-player"/g)).toHaveLength(1);

      const pause = renderExam(
        [question('hoeren-1', 1, 'hoeren')],
        'transition',
        lesenSummary,
        {},
      );
      const player = /<section[^>]*data-testid="audio-player"[^>]*>/.exec(
        pause,
      );
      expect(player?.[0]).toContain('hidden=""');
    });

    it('shows the transition instead of the page, with no clock of a skill', () => {
      const html = renderExam(
        [question('hoeren-1', 1, 'hoeren')],
        'transition',
        {
          totalAssigned: 27,
          skills: {
            hoeren: { assigned: 2, answered: 0, state: 'closed' },
            lesen: { assigned: 25, answered: 0, state: 'unopened' },
          },
        },
        {},
      );
      expect(html).toContain('data-testid="transition-screen"');
      expect(html).toContain('data-testid="begin-lesen"');
      expect(html).toContain('role="timer"');
      expect(html).not.toContain('data-testid="attempt-timer"');
      expect(html).not.toContain('block page');
      expect(html).toContain('Answered in total: 0 of 27.');
    });
  });
});
