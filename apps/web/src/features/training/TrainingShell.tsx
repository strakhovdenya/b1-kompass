'use client';

import { useCallback, useMemo, useState } from 'react';
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
  AttemptReview,
  ExamQuestion,
  FinishAttemptResult,
  Selections,
} from '@b1k/domain';
import { AudioPlayer } from '../audio/AudioPlayer';
import type { AudioAccess } from '../audio/AudioPlayer';
import { AttemptReviewView } from '../results/AttemptReviewView';
import type { ReviewBlock } from '../results/AttemptReviewView';
import { TrainingContext } from './TrainingContext';
import type { TrainingState } from './TrainingContext';

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

export interface FinishAttemptInput {
  attemptId: string;
}

type FinishStatus = 'idle' | 'confirming' | 'finishing' | 'error';

const LESEN_PATH = '/practice/lesen';

const BLOCKS: readonly { block: ReviewBlock; href: string }[] = [
  { block: 'hoeren', href: '/practice' },
  { block: 'lesen', href: LESEN_PATH },
];

interface TrainingShellProps {
  attemptId: string;
  questions: readonly ExamQuestion[];
  trackIds: readonly string[];
  initialSelections: Selections;
  initialReview: AttemptReview | null;
  resolveAudio: (input: ResolveAudioInput) => Promise<AudioAccess>;
  finishAttempt: (input: FinishAttemptInput) => Promise<FinishAttemptResult>;
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

// The frame of one attempt around the Hören and Lesen pages. It stays mounted
// when the guest moves between the blocks, so the recording keeps playing and
// the answers confirmed by the server stay known. It owns the single finish
// point: the server computes the result, the shell only shows what it returns.
export const TrainingShell = ({
  attemptId,
  questions,
  trackIds,
  initialSelections,
  initialReview,
  resolveAudio,
  finishAttempt,
  children,
}: TrainingShellProps) => {
  const t = useTranslations('training');
  const pathname = usePathname();
  const [selections, setSelections] = useState<Selections>(initialSelections);
  const [review, setReview] = useState(initialReview);
  const [isSaving, setIsSaving] = useState(false);
  const [finishStatus, setFinishStatus] = useState<FinishStatus>('idle');

  const recordAnswer = useCallback((questionId: string, optionId: string) => {
    setSelections((current) => ({ ...current, [questionId]: optionId }));
  }, []);

  const state: TrainingState = useMemo(
    () => ({ selections, review, recordAnswer, setSaving: setIsSaving }),
    [selections, review, recordAnswer],
  );

  const blocks = BLOCKS.filter(({ block }) =>
    questions.some((question) => question.skill === block),
  );
  const current: ReviewBlock = pathname.startsWith(LESEN_PATH)
    ? 'lesen'
    : 'hoeren';
  const unanswered = {
    hoeren: countUnanswered(questions, selections, 'hoeren'),
    lesen: countUnanswered(questions, selections, 'lesen'),
  };
  const hasUnanswered = unanswered.hoeren + unanswered.lesen > 0;

  const finish = async () => {
    setFinishStatus('finishing');
    let result: FinishAttemptResult;
    try {
      result = await finishAttempt({ attemptId });
    } catch (error) {
      console.error({ error });
      result = { ok: false, error: 'unavailable' };
    }
    if (result.ok) setReview(result.review);
    else setFinishStatus('error');
  };

  const requestFinish = () => {
    if (hasUnanswered) setFinishStatus('confirming');
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
        <Stack spacing={3}>
          {nav}
          <AttemptReviewView
            review={review}
            questions={questions}
            block={blocks.length > 1 ? current : undefined}
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
      <Stack spacing={3}>
        {nav}
        {trackIds.map((trackId) => (
          <AudioPlayer
            key={trackId}
            resolveAudio={() => resolveAudio({ attemptId, trackId })}
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
