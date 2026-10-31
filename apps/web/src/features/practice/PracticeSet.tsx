'use client';

import { useState } from 'react';
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
  SaveAnswerResult,
  Selections,
} from '@b1k/domain';
import { AttemptReviewView } from '../results/AttemptReviewView';
import { QuestionCard } from './QuestionCard';
import type { SaveAnswerInput, SaveStatus } from './QuestionCard';

export interface FinishAttemptInput {
  attemptId: string;
}

type FinishStatus = 'idle' | 'finishing' | 'error';

// A choice the server did not confirm. It survives navigation so the guest
// still sees it with the error and the retry.
interface UnsavedChoice {
  optionId: string;
  status: SaveStatus;
}

interface PracticeSetProps {
  attemptId: string;
  questions: readonly ExamQuestion[];
  initialSelections: Selections;
  initialReview: AttemptReview | null;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
  finishAttempt: (input: FinishAttemptInput) => Promise<FinishAttemptResult>;
}

// The short set: one question at a time with navigation, then a server-side
// completion. Only the attempt id goes to the server on finish; points come
// back from it. While an answer is being saved neither navigation nor finish
// is possible, so a finish never overtakes the guest's last answer.
export const PracticeSet = ({
  attemptId,
  questions,
  initialSelections,
  initialReview,
  saveAnswer,
  finishAttempt,
}: PracticeSetProps) => {
  const t = useTranslations('set');
  const [index, setIndex] = useState(0);
  const [selections, setSelections] = useState<Selections>(initialSelections);
  const [unsaved, setUnsaved] = useState<Readonly<Record<string, UnsavedChoice>>>(
    {},
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [finishStatus, setFinishStatus] = useState<FinishStatus>('idle');
  const [review, setReview] = useState(initialReview);

  if (review) return <AttemptReviewView review={review} questions={questions} />;

  const question = questions[index];
  if (!question) return null;
  const total = questions.length;
  const answered = questions.filter((item) =>
    Object.hasOwn(selections, item.id),
  ).length;

  const handleSettled = (
    questionId: string,
    optionId: string,
    status: SaveStatus,
  ) => {
    if (status === 'saved') {
      setSelections((current) => ({ ...current, [questionId]: optionId }));
    }
    setUnsaved((current) => {
      const { [questionId]: _previous, ...rest } = current;
      return status === 'saved' ? rest : { ...rest, [questionId]: { optionId, status } };
    });
  };

  const goTo = (next: number) => {
    setIndex(next);
    setSaveStatus('idle');
  };

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

  const isSaving = saveStatus === 'saving';
  const isBusy = isSaving || finishStatus === 'finishing';
  const choice = Object.hasOwn(unsaved, question.id) ? unsaved[question.id] : undefined;

  return (
    <Stack spacing={2}>
      <nav aria-label={t('navigation')}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Typography data-testid="set-position" sx={{ mr: 1 }}>
            {t('position', { current: index + 1, total })}
          </Typography>
          {questions.map((item, itemIndex) => (
            <Button
              key={item.id}
              size="small"
              variant={itemIndex === index ? 'contained' : 'outlined'}
              aria-current={itemIndex === index ? 'step' : undefined}
              aria-label={t('goTo', { number: item.number })}
              disabled={isSaving}
              onClick={() => goTo(itemIndex)}
              sx={{ minWidth: 40 }}
            >
              {item.number}
            </Button>
          ))}
        </Stack>
      </nav>
      <QuestionCard
        key={question.id}
        attemptId={attemptId}
        question={question}
        initialOptionId={choice?.optionId ?? selections[question.id] ?? null}
        initialStatus={choice?.status}
        saveAnswer={saveAnswer}
        onSettled={handleSettled}
        onStatusChange={setSaveStatus}
      />
      <Stack direction="row" spacing={1}>
        <Button
          variant="outlined"
          disabled={index === 0 || isSaving}
          onClick={() => goTo(index - 1)}
        >
          {t('previous')}
        </Button>
        <Button
          variant="outlined"
          disabled={index === total - 1 || isSaving}
          onClick={() => goTo(index + 1)}
        >
          {t('next')}
        </Button>
      </Stack>
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography data-testid="set-answered">
            {t('answered', { answered, total })}
          </Typography>
          <Button
            variant="contained"
            onClick={() => void finish()}
            disabled={isBusy}
          >
            {finishStatus === 'finishing' ? t('finishing') : t('finish')}
          </Button>
          {finishStatus === 'error' ? (
            <Alert severity="error" role="alert" data-testid="finish-status">
              {t('finishError')}
            </Alert>
          ) : null}
        </Stack>
      </Paper>
    </Stack>
  );
};
