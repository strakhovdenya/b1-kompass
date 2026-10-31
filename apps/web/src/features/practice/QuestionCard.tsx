'use client';

import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ExamQuestion } from '@b1k/domain';

// 'error' can be retried; 'refused' cannot be saved any more (the attempt is
// no longer active).
export type SaveStatus =
  'idle' | 'saving' | 'saved' | 'error' | 'refused' | 'session-invalid';

interface QuestionCardProps {
  question: ExamQuestion;
  // The choice on screen: the unconfirmed one if there is one, otherwise the
  // answer the server confirmed.
  selectedOptionId: string | null;
  // Without a status the selected answer is a confirmed one.
  status?: SaveStatus;
  onChoose: (optionId: string) => void;
  onRetry?: () => void;
}

// One task with its options and the save state of its answer. The answer
// itself is kept and saved by the training shell, in the order of choices.
export const QuestionCard = ({
  question,
  selectedOptionId,
  status,
  onChoose,
  onRetry,
}: QuestionCardProps) => {
  const t = useTranslations();
  const shownStatus = status ?? (selectedOptionId ? 'saved' : 'idle');

  const labelId = `question-${question.id}`;

  return (
    <Paper
      component="section"
      variant="outlined"
      data-testid={`question-card-${question.id}`}
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          {t('practice.partial', {
            skill: t(`practice.skill.${question.skill}`),
            teil: question.teil,
            number: question.number,
          })}
        </Typography>
        <FormControl>
          <FormLabel id={labelId} sx={{ color: 'text.primary', mb: 1 }}>
            <Typography component="h2" variant="h6" lang="de">
              {question.number}. {question.prompt}
            </Typography>
          </FormLabel>
          <RadioGroup
            aria-labelledby={labelId}
            name={labelId}
            value={selectedOptionId ?? ''}
            onChange={(event) => onChoose(event.target.value)}
          >
            {question.options.map((option) => (
              <FormControlLabel
                key={option.id}
                value={option.id}
                control={<Radio />}
                label={
                  <span lang="de">
                    <strong>{option.id}</strong> {option.text}
                  </span>
                }
              />
            ))}
          </RadioGroup>
        </FormControl>
        <SaveStatusLine status={shownStatus} onRetry={onRetry ?? null} />
      </Stack>
    </Paper>
  );
};

interface SaveStatusLineProps {
  status: SaveStatus;
  onRetry: (() => void) | null;
}

const SaveStatusLine = ({ status, onRetry }: SaveStatusLineProps) => {
  const t = useTranslations('save');
  if (status === 'error') {
    return (
      <Alert
        severity="error"
        role="alert"
        data-testid="save-status"
        data-status={status}
        action={
          onRetry ? (
            <Button color="inherit" size="small" onClick={onRetry}>
              {t('retry')}
            </Button>
          ) : null
        }
      >
        {t('error')}
      </Alert>
    );
  }
  if (status === 'refused') {
    return (
      <Alert
        severity="error"
        role="alert"
        data-testid="save-status"
        data-status={status}
      >
        {t('refused')}
      </Alert>
    );
  }
  if (status === 'session-invalid') {
    return (
      <Alert
        severity="warning"
        role="alert"
        data-testid="save-status"
        data-status={status}
      >
        {t('sessionInvalid')}
      </Alert>
    );
  }
  const text = {
    idle: t('idle'),
    saving: t('saving'),
    saved: `✓ ${t('saved')}`,
  };
  return (
    <Typography
      role="status"
      aria-live="polite"
      data-testid="save-status"
      data-status={status}
      color={status === 'saved' ? 'success.main' : 'text.secondary'}
    >
      {text[status]}
    </Typography>
  );
};
