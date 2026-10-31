'use client';

import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type {
  AttemptReview,
  ExamQuestion,
  FinishAttemptResult,
  SaveAnswerResult,
  Selections,
} from '@b1k/domain';
import { AudioPlayer } from '../audio/AudioPlayer';
import type { AudioAccess } from '../audio/AudioPlayer';
import { PracticeSet } from '../practice/PracticeSet';
import type { FinishAttemptInput } from '../practice/PracticeSet';
import type { SaveAnswerInput } from '../practice/QuestionCard';

const SINGLE_TEILS: readonly number[] = [1, 2];

export const selectSingleQuestions = (
  questions: readonly ExamQuestion[],
): ExamQuestion[] =>
  questions.filter(
    (question) =>
      question.skill === 'hoeren' &&
      question.kind === 'single-choice' &&
      SINGLE_TEILS.includes(question.teil),
  );

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

interface HoerenSingleScreenProps {
  attemptId: string;
  questions: readonly ExamQuestion[];
  trackIds: readonly string[];
  initialSelections: Selections;
  initialReview: AttemptReview | null;
  resolveAudio: (input: ResolveAudioInput) => Promise<AudioAccess>;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
  finishAttempt: (input: FinishAttemptInput) => Promise<FinishAttemptResult>;
}

// Hören Teil 1–2: single-choice questions of the material contract. The
// players sit beside the question set, not inside it, so moving between
// questions or switching the language never recreates or restarts them.
export const HoerenSingleScreen = ({
  attemptId,
  questions,
  trackIds,
  initialSelections,
  initialReview,
  resolveAudio,
  saveAnswer,
  finishAttempt,
}: HoerenSingleScreenProps) => {
  const t = useTranslations('hoeren');
  const tPractice = useTranslations('practice');
  const singles = selectSingleQuestions(questions);
  if (singles.length === 0) {
    return <Alert severity="warning">{tPractice('unavailable')}</Alert>;
  }
  return (
    <Stack spacing={3}>
      <Typography variant="body2" color="text.secondary">
        {t('intro', { count: singles.length })}
      </Typography>
      {trackIds.map((trackId) => (
        <AudioPlayer
          key={trackId}
          resolveAudio={() => resolveAudio({ attemptId, trackId })}
        />
      ))}
      <PracticeSet
        attemptId={attemptId}
        questions={singles}
        initialSelections={initialSelections}
        initialReview={initialReview}
        saveAnswer={saveAnswer}
        finishAttempt={finishAttempt}
      />
    </Stack>
  );
};
