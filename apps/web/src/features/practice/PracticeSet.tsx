'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ExamGroup, ExamQuestion, Selections } from '@b1k/domain';
import { useTraining } from '../training/TrainingContext';
import { QuestionCard } from './QuestionCard';
import { buildSteps } from './steps';
import type { PracticeStep } from './steps';

interface PracticeSetProps {
  questions: readonly ExamQuestion[];
  groups?: readonly ExamGroup[];
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
  renderGroup,
  initialSelections,
  initialStepKey = null,
  onStepChange,
}: PracticeSetProps) => {
  const t = useTranslations('set');
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      buildSteps(questions, groups).findIndex(
        (item) => item.key === initialStepKey,
      ),
    ),
  );
  const training = useTraining();
  const { pending, choose, retry } = training;
  // The shell knows every answer confirmed since the page was loaded; the
  // page's own answers count outside a shell (component tests).
  const selections = { ...initialSelections, ...training.selections };

  const steps = buildSteps(questions, groups);
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

  const cards = step.questions.map((question) => {
    const choice = Object.hasOwn(pending, question.id)
      ? pending[question.id]
      : undefined;
    return (
      <QuestionCard
        key={question.id}
        question={question}
        selectedOptionId={choice?.optionId ?? selections[question.id] ?? null}
        status={choice?.status}
        onChoose={(optionId) => choose(question.id, optionId)}
        onRetry={() => retry(question.id)}
      />
    );
  });

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
          {steps.map((item, itemIndex) => {
            const first = item.questions[0];
            const last = item.questions[item.questions.length - 1];
            if (!first || !last) return null;
            const label =
              first === last
                ? `${first.number}`
                : `${first.number}–${last.number}`;
            return (
              <Button
                key={item.key}
                size="small"
                variant={itemIndex === index ? 'contained' : 'outlined'}
                aria-current={itemIndex === index ? 'step' : undefined}
                aria-label={t('goTo', {
                  number: label,
                  count: item.questions.length,
                })}
                data-testid={`go-to-question-${first.number}`}
                disabled={isSaving}
                onClick={() => setIndex(itemIndex)}
                sx={{ minWidth: 40 }}
              >
                {label}
              </Button>
            );
          })}
        </Stack>
      </nav>
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
        >
          {t('previous')}
        </Button>
        <Button
          variant="outlined"
          data-testid="set-next"
          disabled={index === total - 1 || isSaving}
          onClick={() => setIndex(index + 1)}
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
