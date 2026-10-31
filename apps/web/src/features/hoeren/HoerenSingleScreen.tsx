'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ExamGroup, ExamQuestion, Selections } from '@b1k/domain';
import { useTraining } from '../training/TrainingContext';
import { PracticeSet } from '../practice/PracticeSet';
import { HoerenPairView } from './HoerenPairView';
import { HoerenSharedSetView } from './HoerenSharedSetView';

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

const SHARED_SET_TEIL = 4;

// The Teil 4 set is kept even when the group does not fit the material: the
// view reports it, so a broken group is never silently replaced.
export const selectSharedSetGroups = (
  groups: readonly ExamGroup[],
): ExamGroup[] =>
  groups.filter(
    (group) => group.kind === 'shared-set' && group.teil === SHARED_SET_TEIL,
  );

// Single questions of Teil 1–2, the members of the Teil 3 pairs and of the
// Teil 4 shared set, in the order of the material.
export const selectQuestions = (
  questions: readonly ExamQuestion[],
  groups: readonly ExamGroup[],
): ExamQuestion[] => {
  const hoerenIds = new Set(
    questions.filter((item) => item.skill === 'hoeren').map((item) => item.id),
  );
  const pairMembers = new Set(
    [
      ...selectPairGroups(questions, groups),
      ...selectSharedSetGroups(groups),
    ].flatMap((group) => group.questionIds.filter((id) => hoerenIds.has(id))),
  );
  const singles = new Set(
    selectSingleQuestions(questions).map((question) => question.id),
  );
  return questions.filter(
    (question) => singles.has(question.id) || pairMembers.has(question.id),
  );
};

interface HoerenSingleScreenProps {
  questions: readonly ExamQuestion[];
  groups?: readonly ExamGroup[];
  initialSelections: Selections;
}

// Hören Teil 1–4: single questions, the Teil 3 pairs and the Teil 4 shared
// set of the material contract. The recording is played by the training
// shell around the block, so moving between questions, blocks or languages
// never recreates or restarts it.
export const HoerenSingleScreen = ({
  questions,
  groups = [],
  initialSelections,
}: HoerenSingleScreenProps) => {
  const t = useTranslations('hoeren');
  const tPractice = useTranslations('practice');
  const { readProgress, reportProgress } = useTraining();
  const stored = readProgress();
  const initialStepKey = stored?.hoeren?.itemId ?? null;
  const handleStepChange = useCallback(
    (itemId: string) => reportProgress({ block: 'hoeren', hoeren: { itemId } }),
    [reportProgress],
  );
  const shown = selectQuestions(questions, groups);
  const shownGroups = [
    ...selectPairGroups(questions, groups),
    ...selectSharedSetGroups(groups),
  ];
  if (shown.length === 0) {
    return <Alert severity="warning">{tPractice('unavailable')}</Alert>;
  }
  return (
    <Stack spacing={3} data-testid="hoeren-screen">
      <Typography variant="body2" color="text.secondary">
        {t('intro', { count: shown.length })}
      </Typography>
      <PracticeSet
        questions={shown}
        groups={shownGroups}
        renderGroup={(step, cards) =>
          step.group?.kind === 'shared-set' ? (
            <HoerenSharedSetView
              group={step.group}
              questions={step.questions}
              cards={cards}
            />
          ) : (
            <HoerenPairView
              groupId={step.key}
              questions={step.questions}
              cards={cards}
            />
          )
        }
        initialSelections={initialSelections}
        initialStepKey={initialStepKey}
        onStepChange={handleStepChange}
      />
    </Stack>
  );
};
