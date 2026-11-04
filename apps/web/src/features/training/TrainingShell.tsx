'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import type {
  AttemptProgress,
  AttemptReview,
  ExamQuestion,
  Selections,
} from '@b1k/domain';
import { AudioPlayer } from '../audio/AudioPlayer';
import type { AudioAccess } from '../audio/AudioPlayer';
import { AttemptReviewView } from '../results/AttemptReviewView';
import type { ReviewBlock } from '../results/AttemptReviewView';
import { AttemptSubmissionControls } from './AttemptSubmissionControls';
import {
  attemptLesenPath,
  attemptPath,
  choicePath,
  requestSaveAnswer,
  requestSaveProgress,
} from './attempt-client';
import { useAnswerStore } from './answers';
import { TrainingContext } from './TrainingContext';
import type { TrainingState } from './TrainingContext';
import { useAttemptSubmission } from './useAttemptSubmission';

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

// While the recording plays the position is saved at most this often.
const PROGRESS_INTERVAL_MS = 10_000;

const BLOCK_PATHS: readonly {
  block: ReviewBlock;
  pathOf: (examSlug: string, attemptId: string) => string;
}[] = [
  { block: 'hoeren', pathOf: attemptPath },
  { block: 'lesen', pathOf: attemptLesenPath },
];

interface TrainingShellProps {
  examSlug: string;
  attemptId: string;
  questions: readonly ExamQuestion[];
  trackIds: readonly string[];
  initialSelections: Selections;
  initialRevisions: Readonly<Record<string, number>>;
  initialReview: AttemptReview | null;
  initialProgress: AttemptProgress | null;
  // The submission is accepted and its result is not stored yet.
  isResultPending: boolean;
  phaseRevision: number;
  resolveAudio: (input: ResolveAudioInput) => Promise<AudioAccess>;
  children: ReactNode;
}

// The frame of one attempt around the Hören and Lesen pages. It stays mounted
// when the guest moves between the blocks, so the recording keeps playing and
// the answers stay known: the confirmed ones and the choices the server has
// not confirmed yet, whichever block they belong to. It connects the one
// answer store with the submission: the final answers include the choices
// still in flight, the server computes the result, the shell only shows it.
export const TrainingShell = ({
  examSlug,
  attemptId,
  questions,
  trackIds,
  initialSelections,
  initialRevisions,
  initialReview,
  initialProgress,
  isResultPending,
  phaseRevision,
  resolveAudio,
  children,
}: TrainingShellProps) => {
  const t = useTranslations('training');
  const pathname = usePathname();
  const router = useRouter();
  const {
    selections,
    pending,
    choose,
    retry,
    lock,
    unlock,
    readFinalAnswers,
    readPending,
    settle,
  } = useAnswerStore({
    attemptId,
    initialSelections,
    initialRevisions,
    saveAnswer: requestSaveAnswer,
    isSettled: initialReview !== null || isResultPending,
  });
  const store = useMemo(
    () => ({ lock, unlock, readFinalAnswers, readPending, settle }),
    [lock, unlock, readFinalAnswers, readPending, settle],
  );
  // The review arrives with the page once the result is stored.
  const review = initialReview;

  const lesenPath = attemptLesenPath(examSlug, attemptId);
  const current: ReviewBlock = pathname.startsWith(lesenPath)
    ? 'lesen'
    : 'hoeren';
  const currentRef = useRef(current);
  const progressRef = useRef(initialProgress);
  const lastSavedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const isDone = useRef(initialReview !== null || isResultPending);
  const isDirty = useRef(false);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Saves are sent one after another, so the last place wins. A failure is
  // logged only: it never blocks choosing, saving or submitting.
  const flushProgress = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const progress = progressRef.current;
    if (!progress || isDone.current || !isDirty.current) return;
    isDirty.current = false;
    lastSavedAt.current = Date.now();
    queue.current = queue.current.then(async () => {
      try {
        const result = await requestSaveProgress({ attemptId, progress });
        if (!result.ok) {
          isDirty.current = true;
          console.error({ progressError: result.error });
        }
      } catch (error) {
        isDirty.current = true;
        console.error({ error });
      }
    });
  }, [attemptId]);

  const reportProgress = useCallback(
    (patch: Partial<AttemptProgress>, isUrgent = true) => {
      if (isDone.current) return;
      const previous = progressRef.current;
      const next: AttemptProgress = {
        ...previous,
        ...patch,
        block: patch.block ?? currentRef.current,
      };
      if (previous?.hoeren || patch.hoeren) {
        next.hoeren = { ...previous?.hoeren, ...patch.hoeren };
      }
      if (previous?.lesen || patch.lesen) {
        next.lesen = { ...previous?.lesen, ...patch.lesen };
      }
      // Opening a screen reports the place it just read: nothing to write.
      if (JSON.stringify(next) === JSON.stringify(previous)) return;
      isDirty.current = true;
      progressRef.current = next;
      const wait = lastSavedAt.current + PROGRESS_INTERVAL_MS - Date.now();
      if (isUrgent || wait <= 0) flushProgress();
      else if (timer.current === undefined) {
        timer.current = window.setTimeout(flushProgress, wait);
      }
    },
    [flushProgress],
  );

  const readProgress = useCallback(() => progressRef.current, []);

  // A closed attempt saves no place: a pending timer is dropped, a request
  // already in flight is refused by the server.
  const stopProgress = useCallback(() => {
    isDone.current = true;
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  useEffect(() => {
    const handleHidden = () => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    document.addEventListener('visibilitychange', handleHidden);
    window.addEventListener('pagehide', flushProgress);
    return () => {
      document.removeEventListener('visibilitychange', handleHidden);
      window.removeEventListener('pagehide', flushProgress);
      window.clearTimeout(timer.current);
    };
  }, [flushProgress]);

  const submission = useAttemptSubmission({
    attemptId,
    examSlug,
    questions,
    phaseRevision,
    isResultPending,
    store,
    onClosed: stopProgress,
  });

  const state: TrainingState = useMemo(
    () => ({
      selections,
      pending,
      review,
      choose,
      retry,
      readProgress,
      reportProgress,
    }),
    [selections, pending, review, choose, retry, readProgress, reportProgress],
  );

  const blocks = BLOCK_PATHS.filter(({ block }) =>
    questions.some((question) => question.skill === block),
  ).map(({ block, pathOf }) => ({ block, href: pathOf(examSlug, attemptId) }));

  // Starting again only opens the choice of the exam: a new attempt is
  // created there by an explicit start, never by this button.
  const restart = () => router.push(choicePath(examSlug));

  const nav =
    blocks.length > 1 ? (
      <nav aria-label={t('blocks')}>
        <Stack direction="row" spacing={1}>
          {blocks.map(({ block, href }) => (
            <Button
              key={block}
              component={Link}
              href={href}
              variant={block === current ? 'contained' : 'outlined'}
              aria-current={block === current ? 'page' : undefined}
              data-testid={`block-link-${block}`}
            >
              {t(block)}
            </Button>
          ))}
        </Stack>
      </nav>
    ) : null;

  if (review) {
    return (
      <TrainingContext.Provider value={state}>
        <Stack
          spacing={3}
          data-testid="training-shell"
          data-attempt-id={attemptId}
        >
          {nav}
          <AttemptReviewView
            review={review}
            questions={questions}
            block={blocks.length > 1 ? current : undefined}
            onRestart={restart}
          />
        </Stack>
      </TrainingContext.Provider>
    );
  }

  const answered = questions.filter((question) =>
    Object.hasOwn(selections, question.id),
  ).length;

  return (
    <TrainingContext.Provider value={state}>
      <Stack
        spacing={3}
        data-testid="training-shell"
        data-attempt-id={attemptId}
        data-submission={submission.phase}
      >
        {nav}
        {trackIds.map((trackId, trackIndex) => (
          <AudioPlayer
            key={trackId}
            resolveAudio={() => resolveAudio({ attemptId, trackId })}
            initialPosition={
              trackIndex === 0 ? (initialProgress?.positionSeconds ?? 0) : 0
            }
            onPosition={
              trackIndex === 0
                ? (seconds, isUrgent) =>
                    reportProgress({ positionSeconds: seconds }, isUrgent)
                : undefined
            }
          />
        ))}
        {children}
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <AttemptSubmissionControls
            phase={submission.phase}
            confirmation={submission.confirmation}
            isRenewed={submission.isRenewed}
            cancelSummary={submission.cancelSummary}
            resultCheck={submission.resultCheck}
            answered={answered}
            total={questions.length}
            onSubmit={submission.submit}
            onConfirmSubmit={submission.confirmSubmit}
            onResendSubmit={submission.resendSubmit}
            onCheckResult={submission.checkResult}
            onCancel={submission.cancel}
            onConfirmCancel={submission.confirmCancel}
            onResendCancel={submission.resendCancel}
            onDismiss={submission.dismiss}
          />
        </Paper>
      </Stack>
    </TrainingContext.Provider>
  );
};
