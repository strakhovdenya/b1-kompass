'use client';

import { useMemo } from 'react';
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
import { DictionaryBoundary } from '../dictionary/DictionaryBoundary';
import type { AudioAccess } from '../audio/AudioPlayer';
import { AttemptReviewView } from '../results/AttemptReviewView';
import type { ReviewBlock } from '../results/AttemptReviewView';
import { AttemptSubmissionControls } from './AttemptSubmissionControls';
import {
  attemptLesenPath,
  attemptPath,
  choicePath,
  requestSaveAnswer,
} from './attempt-client';
import { useAnswerStore } from './answers';
import { TrainingContext } from './TrainingContext';
import type { TrainingState } from './TrainingContext';
import { useAttemptProgress } from './useAttemptProgress';
import { useAttemptSubmission } from './useAttemptSubmission';

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

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
  const { readProgress, reportProgress, stopProgress } = useAttemptProgress({
    attemptId,
    block: current,
    initialProgress,
    isSettled: initialReview !== null || isResultPending,
  });

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
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
          {blocks.map(({ block, href }) => (
            <Button
              key={block}
              component={Link}
              href={href}
              variant={block === current ? 'contained' : 'outlined'}
              aria-current={block === current ? 'page' : undefined}
              data-testid={`block-link-${block}`}
              sx={{ minHeight: 44 }}
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
        spacing={{ xs: 1.5, sm: 3 }}
        data-testid="training-shell"
        data-attempt-id={attemptId}
        data-submission={submission.phase}
      >
        {nav}
        {trackIds.map((trackId, trackIndex) => (
          <AudioPlayer
            key={trackId}
            isActive={current === 'hoeren'}
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
        {/* The dictionary wraps only the block page: the recording, the
            answers and the submission keep their own lifecycle. Its switch
            is portalled to the header; the recording belongs to Hören and
            is paused and hidden on Lesen. */}
        <DictionaryBoundary>{children}</DictionaryBoundary>
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 3 } }}>
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
