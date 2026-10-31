'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type {
  ExamGroup,
  ExamQuestion,
  SaveAnswerResult,
  Selections,
} from '@b1k/domain';
import { useTraining } from '../training/TrainingContext';
import { QuestionCard } from './QuestionCard';
import type { SaveAnswerInput, SaveStatus } from './QuestionCard';
import { buildSteps } from './steps';
import type { PracticeStep } from './steps';

// A choice the server did not confirm. It survives navigation so the guest
// still sees it with the error and the retry.
interface UnsavedChoice {
  optionId: string;
  status: SaveStatus;
}

interface PracticeSetProps {
  attemptId: string;
  questions: readonly ExamQuestion[];
  groups?: readonly ExamGroup[];
  // Lays out the cards of a group step; without it they are stacked.
  renderGroup?: (step: PracticeStep, cards: ReactNode[]) => ReactNode;
  initialSelections: Selections;
  // The step the guest stopped at; an unknown key opens the first step.
  initialStepKey?: string | null;
  onStepChange?: (stepKey: string) => void;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
}

// One step at a time with navigation (a question, or the questions of a pair
// shown together). The attempt is finished from the shared training shell,
// which is told when an answer is confirmed or still being saved, so a finish
// never overtakes the guest's last answer.
export const PracticeSet = ({
  attemptId,
  questions,
  groups = [],
  renderGroup,
  initialSelections,
  initialStepKey = null,
  onStepChange,
  saveAnswer,
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
  const [selections, setSelections] = useState<Selections>(initialSelections);
  const [unsaved, setUnsaved] = useState<
    Readonly<Record<string, UnsavedChoice>>
  >({});
  const [saveStatus, setSaveStatus] = useState<
    Readonly<Record<string, SaveStatus>>
  >({});
  const { recordAnswer, setSaving } = useTraining();
  const isSaving = Object.values(saveStatus).includes('saving');
  useEffect(() => {
    setSaving(isSaving);
    return () => setSaving(false);
  }, [isSaving, setSaving]);

  const steps = buildSteps(questions, groups);
  const step = steps[index];
  const stepKey = step?.key;
  useEffect(() => {
    if (stepKey) onStepChange?.(stepKey);
  }, [stepKey, onStepChange]);
  if (!step) return null;
  const total = steps.length;
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
      recordAnswer(questionId, optionId);
    }
    setUnsaved((current) => {
      const { [questionId]: _previous, ...rest } = current;
      return status === 'saved'
        ? rest
        : { ...rest, [questionId]: { optionId, status } };
    });
  };

  const goTo = (next: number) => {
    setIndex(next);
    setSaveStatus({});
  };

  const cards = step.questions.map((question) => {
    const choice = Object.hasOwn(unsaved, question.id)
      ? unsaved[question.id]
      : undefined;
    return (
      <QuestionCard
        key={question.id}
        attemptId={attemptId}
        question={question}
        initialOptionId={choice?.optionId ?? selections[question.id] ?? null}
        initialStatus={choice?.status}
        saveAnswer={saveAnswer}
        onSettled={handleSettled}
        onStatusChange={(status) =>
          setSaveStatus((current) => ({ ...current, [question.id]: status }))
        }
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
                onClick={() => goTo(itemIndex)}
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
          onClick={() => goTo(index - 1)}
        >
          {t('previous')}
        </Button>
        <Button
          variant="outlined"
          data-testid="set-next"
          disabled={index === total - 1 || isSaving}
          onClick={() => goTo(index + 1)}
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
