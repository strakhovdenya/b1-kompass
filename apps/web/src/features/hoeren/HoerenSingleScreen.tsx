'use client';

import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type {
  AttemptReview,
  ExamGroup,
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
import { HoerenPairView } from './HoerenPairView';

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

const PAIR_TEIL = 3;
const PAIR_SIZE = 2;

const isPairGroup = (group: ExamGroup): boolean =>
  group.kind === 'pair' && group.teil === PAIR_TEIL;

// Teil 3 pairs of two questions that are all in the material; a pair with a
// missing member is not shown.
export const selectPairGroups = (
  questions: readonly ExamQuestion[],
  groups: readonly ExamGroup[],
): ExamGroup[] => {
  const known = new Set(questions.map((question) => question.id));
  return groups.filter(
    (group) =>
      isPairGroup(group) &&
      group.questionIds.length === PAIR_SIZE &&
      group.questionIds.every((id) => known.has(id)),
  );
};

// Single questions of Teil 1–2 and the members of the Teil 3 pairs, in the
// order of the material.
export const selectQuestions = (
  questions: readonly ExamQuestion[],
  groups: readonly ExamGroup[],
): ExamQuestion[] => {
  const pairMembers = new Set(
    selectPairGroups(questions, groups).flatMap((group) => group.questionIds),
  );
  const singles = new Set(
    selectSingleQuestions(questions).map((question) => question.id),
  );
  return questions.filter(
    (question) => singles.has(question.id) || pairMembers.has(question.id),
  );
};

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

interface HoerenSingleScreenProps {
  attemptId: string;
  questions: readonly ExamQuestion[];
  groups?: readonly ExamGroup[];
  trackIds: readonly string[];
  initialSelections: Selections;
  initialReview: AttemptReview | null;
  resolveAudio: (input: ResolveAudioInput) => Promise<AudioAccess>;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
  finishAttempt: (input: FinishAttemptInput) => Promise<FinishAttemptResult>;
}

// Hören Teil 1–3: single questions and the Teil 3 pairs of the material
// contract. The
// players sit beside the question set, not inside it, so moving between
// questions or switching the language never recreates or restarts them.
export const HoerenSingleScreen = ({
  attemptId,
  questions,
  groups = [],
  trackIds,
  initialSelections,
  initialReview,
  resolveAudio,
  saveAnswer,
  finishAttempt,
}: HoerenSingleScreenProps) => {
  const t = useTranslations('hoeren');
  const tPractice = useTranslations('practice');
  const shown = selectQuestions(questions, groups);
  const shownGroups = selectPairGroups(questions, groups);
  if (shown.length === 0) {
    return <Alert severity="warning">{tPractice('unavailable')}</Alert>;
  }
  return (
    <Stack spacing={3}>
      <Typography variant="body2" color="text.secondary">
        {t('intro', { count: shown.length })}
      </Typography>
      {trackIds.map((trackId) => (
        <AudioPlayer
          key={trackId}
          resolveAudio={() => resolveAudio({ attemptId, trackId })}
        />
      ))}
      <PracticeSet
        attemptId={attemptId}
        questions={shown}
        groups={shownGroups}
        renderGroup={(step, cards) => (
          <HoerenPairView
            groupId={step.key}
            questions={step.questions}
            cards={cards}
          />
        )}
        initialSelections={initialSelections}
        initialReview={initialReview}
        saveAnswer={saveAnswer}
        finishAttempt={finishAttempt}
      />
    </Stack>
  );
};
