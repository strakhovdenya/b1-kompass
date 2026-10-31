'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type {
  AttemptProgress,
  AttemptReview,
  ExamQuestion,
  FinishAttemptResult,
  RestartAttemptResult,
  SaveAnswerResult,
  SaveProgressResult,
  Selections,
} from '@b1k/domain';
import { AudioPlayer } from '../audio/AudioPlayer';
import type { AudioAccess } from '../audio/AudioPlayer';
import { AttemptReviewView } from '../results/AttemptReviewView';
import type { RestartStatus, ReviewBlock } from '../results/AttemptReviewView';
import { hasSaving, hasUnsaved, isUnsaved, useAnswerStore } from './answers';
import type { PendingAnswers, SaveAnswerInput } from './answers';
import { TrainingContext } from './TrainingContext';
import type { TrainingState } from './TrainingContext';

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

export interface FinishAttemptInput {
  attemptId: string;
}

export interface RestartAttemptInput {
  attemptId: string;
}

export interface SaveProgressInput {
  attemptId: string;
  progress: AttemptProgress;
}

type FinishStatus = 'idle' | 'confirming' | 'finishing' | 'unsaved' | 'error';

const LESEN_PATH = '/practice/lesen';

// While the recording plays the position is saved at most this often.
const PROGRESS_INTERVAL_MS = 10_000;

const BLOCKS: readonly { block: ReviewBlock; href: string }[] = [
  { block: 'hoeren', href: '/practice' },
  { block: 'lesen', href: LESEN_PATH },
];

interface TrainingShellProps {
  attemptId: string;
  questions: readonly ExamQuestion[];
  trackIds: readonly string[];
  initialSelections: Selections;
  initialRevisions: Readonly<Record<string, number>>;
  initialReview: AttemptReview | null;
  initialProgress: AttemptProgress | null;
  resolveAudio: (input: ResolveAudioInput) => Promise<AudioAccess>;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
  finishAttempt: (input: FinishAttemptInput) => Promise<FinishAttemptResult>;
  saveProgress: (input: SaveProgressInput) => Promise<SaveProgressResult>;
  restartAttempt: (input: RestartAttemptInput) => Promise<RestartAttemptResult>;
  children: ReactNode;
}

const countUnanswered = (
  questions: readonly ExamQuestion[],
  selections: Selections,
  block: ReviewBlock,
): number =>
  questions.filter(
    (question) =>
      question.skill === block && !Object.hasOwn(selections, question.id),
  ).length;

const countUnsaved = (
  questions: readonly ExamQuestion[],
  pending: PendingAnswers,
  block: ReviewBlock,
): number =>
  questions.filter((question) => {
    const entry = Object.hasOwn(pending, question.id)
      ? pending[question.id]
      : undefined;
    return question.skill === block && entry !== undefined && isUnsaved(entry);
  }).length;

// The frame of one attempt around the Hören and Lesen pages. It stays mounted
// when the guest moves between the blocks, so the recording keeps playing and
// the answers stay known: the confirmed ones and the choices the server has
// not confirmed yet, whichever block they belong to. It owns the single
// finish point: while a choice is unconfirmed nothing is finished, and the
// server computes the result, the shell only shows what it returns.
export const TrainingShell = ({
  attemptId,
  questions,
  trackIds,
  initialSelections,
  initialRevisions,
  initialReview,
  initialProgress,
  resolveAudio,
  saveAnswer,
  finishAttempt,
  saveProgress,
  restartAttempt,
  children,
}: TrainingShellProps) => {
  const t = useTranslations('training');
  const pathname = usePathname();
  const {
    selections,
    pending,
    readPending,
    retry,
    choose: chooseAnswer,
  } = useAnswerStore({
    attemptId,
    initialSelections,
    initialRevisions,
    saveAnswer,
  });
  const [review, setReview] = useState(initialReview);
  const [finishStatus, setFinishStatus] = useState<FinishStatus>('idle');
  const [restartStatus, setRestartStatus] = useState<RestartStatus>('idle');
  const isSaving = hasSaving(pending);
  // Once the finish request is sent no answer is changed: the server scores
  // the answers it holds at that moment.
  const isFinishing = useRef(false);
  const choose = useCallback(
    (questionId: string, optionId: string) => {
      if (!isFinishing.current) chooseAnswer(questionId, optionId);
    },
    [chooseAnswer],
  );

  const current: ReviewBlock = pathname.startsWith(LESEN_PATH)
    ? 'lesen'
    : 'hoeren';
  const currentRef = useRef(current);
  const progressRef = useRef(initialProgress);
  const lastSavedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const isDone = useRef(initialReview !== null);
  const isDirty = useRef(false);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Saves are sent one after another, so the last place wins. A failure is
  // logged only: it never blocks choosing or saving an answer.
  const flushProgress = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const progress = progressRef.current;
    if (!progress || isDone.current || !isDirty.current) return;
    isDirty.current = false;
    lastSavedAt.current = Date.now();
    queue.current = queue.current.then(async () => {
      try {
        const result = await saveProgress({ attemptId, progress });
        if (!result.ok) {
          isDirty.current = true;
          console.error({ progressError: result.error });
        }
      } catch (error) {
        isDirty.current = true;
        console.error({ error });
      }
    });
  }, [attemptId, saveProgress]);

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

  const blocks = BLOCKS.filter(({ block }) =>
    questions.some((question) => question.skill === block),
  );
  const unanswered = {
    hoeren: countUnanswered(questions, selections, 'hoeren'),
    lesen: countUnanswered(questions, selections, 'lesen'),
  };
  const hasUnanswered = unanswered.hoeren + unanswered.lesen > 0;
  const unsaved = {
    hoeren: countUnsaved(questions, pending, 'hoeren'),
    lesen: countUnsaved(questions, pending, 'lesen'),
  };
  const isUnsavedLeft = hasUnsaved(pending);

  // An unconfirmed choice would be missing from the stored answers the
  // server scores, so the attempt is not finished until it is saved.
  const finish = async () => {
    if (hasUnsaved(readPending())) {
      setFinishStatus('unsaved');
      return;
    }
    isFinishing.current = true;
    setFinishStatus('finishing');
    let result: FinishAttemptResult;
    try {
      // The last place is stored before the attempt is closed.
      flushProgress();
      await queue.current;
      result = await finishAttempt({ attemptId });
    } catch (error) {
      console.error({ error });
      result = { ok: false, error: 'unavailable' };
    }
    if (result.ok) {
      isDone.current = true;
      setReview(result.review);
      return;
    }
    isFinishing.current = false;
    setFinishStatus('error');
  };

  // The server starts the new run and sends the guest to its beginning; the
  // layout then mounts a new shell for the new attempt, so nothing of this
  // one is carried over.
  const restart = async () => {
    setRestartStatus('restarting');
    try {
      const result = await restartAttempt({ attemptId });
      // A redirected action resolves without a result.
      setRestartStatus(result?.ok === false ? 'error' : 'idle');
    } catch (error) {
      console.error({ error });
      setRestartStatus('error');
    }
  };

  const requestFinish = () => {
    if (isUnsavedLeft) setFinishStatus('unsaved');
    else if (hasUnanswered) setFinishStatus('confirming');
    else void finish();
  };

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
            onRestart={() => void restart()}
            restartStatus={restartStatus}
          />
        </Stack>
      </TrainingContext.Provider>
    );
  }

  const isBusy = isSaving || finishStatus === 'finishing';
  const answered = questions.filter((question) =>
    Object.hasOwn(selections, question.id),
  ).length;

  return (
    <TrainingContext.Provider value={state}>
      <Stack
        spacing={3}
        data-testid="training-shell"
        data-attempt-id={attemptId}
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
          <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
            <Typography data-testid="training-answered">
              {t('answered', { answered, total: questions.length })}
            </Typography>
            {finishStatus === 'confirming' ? (
              <Stack
                spacing={1.5}
                role="group"
                aria-labelledby="finish-confirm-title"
                data-testid="finish-confirmation"
                data-unanswered-hoeren={unanswered.hoeren}
                data-unanswered-lesen={unanswered.lesen}
              >
                <Typography id="finish-confirm-title" fontWeight={600}>
                  {t('confirmTitle')}
                </Typography>
                <Typography>
                  {t('confirmBody', {
                    hoeren: unanswered.hoeren,
                    lesen: unanswered.lesen,
                  })}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    data-testid="finish-confirm"
                    disabled={isBusy}
                    onClick={() => void finish()}
                  >
                    {t('confirm')}
                  </Button>
                  <Button
                    variant="outlined"
                    data-testid="finish-cancel"
                    onClick={() => setFinishStatus('idle')}
                  >
                    {t('cancel')}
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Button
                variant="contained"
                data-testid="finish-attempt"
                disabled={isBusy}
                onClick={requestFinish}
              >
                {finishStatus === 'finishing' ? t('finishing') : t('finish')}
              </Button>
            )}
            {finishStatus === 'unsaved' && isUnsavedLeft ? (
              <Alert
                severity="warning"
                role="alert"
                data-testid="finish-unsaved"
                data-unsaved-hoeren={unsaved.hoeren}
                data-unsaved-lesen={unsaved.lesen}
              >
                {t('unsaved', unsaved)}
              </Alert>
            ) : null}
            {finishStatus === 'error' ? (
              <Alert severity="error" role="alert" data-testid="finish-status">
                {t('finishError')}
              </Alert>
            ) : null}
          </Stack>
        </Paper>
      </Stack>
    </TrainingContext.Provider>
  );
};
