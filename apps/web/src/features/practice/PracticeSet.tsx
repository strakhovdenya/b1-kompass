'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import type {
  ExamGroup,
  ExamQuestion,
  PublicContextItem,
  Selections,
} from '@b1k/domain';
import { useTraining } from '../training/TrainingContext';
import { ContextCard, QuestionCard } from './QuestionCard';
import { QuestionNavigator } from './QuestionNavigator';
import type { NavigatorStep } from './QuestionNavigator';
import { buildSteps } from './steps';
import type { PracticeStep } from './steps';

// Previous and next on a phone: two equal thumb targets in one row, at
// least 48 px high. From md they are ordinary buttons again. Shared with the
// Lesen screen so both blocks navigate alike.
export const NAV_BUTTON_SX: SxProps<Theme> = {
  flex: { xs: 1, md: 'none' },
  minHeight: { xs: 48, md: 'auto' },
};

interface PracticeSetProps {
  questions: readonly ExamQuestion[];
  groups?: readonly ExamGroup[];
  // Read-only neighbours of a repeat, shown inside their group only.
  context?: readonly PublicContextItem[];
  // Lays out the cards of a group step; without it they are stacked.
  renderGroup?: (step: PracticeStep, cards: ReactNode[]) => ReactNode;
  initialSelections: Selections;
  // The step the guest stopped at; an unknown key opens the first step.
  initialStepKey?: string | null;
  onStepChange?: (stepKey: string) => void;
}

// One step at a time with navigation (a question, or the questions of a pair
// shown together). Answers are chosen, saved and retried through the shared
// training shell, which also keeps the unconfirmed ones: a choice with an
// error survives navigation and a move to the other block, and a finish
// never overtakes the guest's last answer.
export const PracticeSet = ({
  questions,
  groups = [],
  context = [],
  renderGroup,
  initialSelections,
  initialStepKey = null,
  onStepChange,
}: PracticeSetProps) => {
  const t = useTranslations('set');
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      buildSteps(questions, groups, context).findIndex(
        (item) => item.key === initialStepKey,
      ),
    ),
  );
  const training = useTraining();
  const { pending, choose, retry, isClosed } = training;
  // The shell knows every answer confirmed since the page was loaded; the
  // page's own answers count outside a shell (component tests).
  const selections = { ...initialSelections, ...training.selections };

  const steps = buildSteps(questions, groups, context);
  const step = steps[index];
  const stepKey = step?.key;
  useEffect(() => {
    if (stepKey) onStepChange?.(stepKey);
  }, [stepKey, onStepChange]);
  if (!step) return null;
  // Navigation waits only for the saves of this set's own questions.
  const isSaving = questions.some(
    (item) => pending[item.id]?.status === 'saving',
  );
  const total = steps.length;
  const answered = questions.filter((item) =>
    Object.hasOwn(selections, item.id),
  ).length;

  const isChosen = (question: ExamQuestion): boolean =>
    Object.hasOwn(pending, question.id) ||
    Object.hasOwn(selections, question.id);
  const navigatorSteps = steps.flatMap((item): NavigatorStep[] => {
    const first = item.questions[0];
    const last = item.questions[item.questions.length - 1];
    if (!first || !last) return [];
    const chosen = item.questions.filter(isChosen).length;
    return [
      {
        key: item.key,
        label:
          first === last ? `${first.number}` : `${first.number}–${last.number}`,
        number: first.number,
        count: item.questions.length,
        teil: first.teil,
        progress:
          chosen === 0
            ? 'empty'
            : chosen === item.questions.length
              ? 'answered'
              : 'partial',
      },
    ];
  });

  // Context is never chosen, saved or counted: it has no card of its own in
  // the navigator and no part in the answered count.
  const cards = step.members.map((member) => {
    if (member.kind === 'context') {
      return <ContextCard key={member.item.questionId} item={member.item} />;
    }
    const { question } = member;
    const choice = Object.hasOwn(pending, question.id)
      ? pending[question.id]
      : undefined;
    return (
      <QuestionCard
        key={question.id}
        question={question}
        selectedOptionId={choice?.optionId ?? selections[question.id] ?? null}
        status={choice?.status}
        isClosed={isClosed}
        onChoose={(optionId) => choose(question.id, optionId)}
        onRetry={() => retry(question.id)}
      />
    );
  });

  return (
    <Stack spacing={{ xs: 1.5, sm: 2 }}>
      <QuestionNavigator
        steps={navigatorSteps}
        index={index}
        isDisabled={isSaving}
        onSelect={setIndex}
      />
      {step.group && renderGroup ? (
        renderGroup(step, cards)
      ) : (
        <Stack spacing={2}>{cards}</Stack>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          variant="outlined"
          data-testid="set-previous"
          disabled={index === 0 || isSaving}
          onClick={() => setIndex(index - 1)}
          sx={NAV_BUTTON_SX}
        >
          {t('previous')}
        </Button>
        <Button
          variant="outlined"
          data-testid="set-next"
          disabled={index === total - 1 || isSaving}
          onClick={() => setIndex(index + 1)}
          sx={NAV_BUTTON_SX}
        >
          {t('next')}
        </Button>
      </Stack>
      <Typography data-testid="set-answered">
        {t('answered', { answered, total: questions.length })}
      </Typography>
    </Stack>
  );
};
