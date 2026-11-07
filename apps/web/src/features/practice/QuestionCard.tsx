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
import { alpha } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ExamQuestion, PublicContextItem } from '@b1k/domain';
import { GermanText } from '../dictionary/GermanText';

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
      sx={{ p: { xs: 1.5, sm: 3 }, minWidth: 0 }}
    >
      <Stack spacing={{ xs: 1, sm: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t('practice.partial', {
            skill: t(`practice.skill.${question.skill}`),
            teil: question.teil,
          })}
        </Typography>
        <FormControl sx={{ minWidth: 0 }}>
          <FormLabel
            id={labelId}
            sx={{
              color: 'text.primary',
              mb: 1.5,
              '&.Mui-focused': { color: 'text.primary' },
            }}
          >
            <Typography component="h2" variant="taskPrompt" lang="de">
              {question.number}. <GermanText>{question.prompt}</GermanText>
            </Typography>
          </FormLabel>
          <RadioGroup
            aria-labelledby={labelId}
            name={labelId}
            value={selectedOptionId ?? ''}
            onChange={(event) => onChoose(event.target.value)}
            sx={{ gap: 1, flexWrap: 'nowrap' }}
          >
            {question.options.map((option) => (
              <FormControlLabel
                key={option.id}
                value={option.id}
                control={<Radio sx={{ p: '12px' }} />}
                slotProps={{
                  typography: {
                    variant: 'answerOption',
                    component: 'span',
                    sx: { flex: 1, minWidth: 0, py: 0.5, pr: 1 },
                  },
                }}
                sx={optionSx(option.id === selectedOptionId)}
                label={
                  <span lang="de">
                    <strong>{option.id}</strong>{' '}
                    <GermanText>{option.text}</GermanText>
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

interface ContextCardProps {
  item: PublicContextItem;
}

// A neighbour of an assessed task, shown so its pair or shared set reads as
// in the exam. It has no radio, no save state and no solution: it is never
// answered, scored or reviewed. Its options are a plain list.
export const ContextCard = ({ item }: ContextCardProps) => {
  const t = useTranslations('practice');
  const labelId = `context-${item.questionId}`;
  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby={labelId}
      data-testid={`context-card-${item.questionId}`}
      sx={{
        p: { xs: 1.5, sm: 3 },
        minWidth: 0,
        borderStyle: 'dashed',
        bgcolor: 'action.hover',
      }}
    >
      <Stack spacing={{ xs: 1, sm: 1.5 }}>
        <Typography
          variant="body2"
          sx={{ fontWeight: 600 }}
          data-testid="context-label"
        >
          {t('context')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('contextHint')}
        </Typography>
        <Typography id={labelId} component="h2" variant="taskPrompt" lang="de">
          {item.number}. <GermanText>{item.prompt}</GermanText>
        </Typography>
        <Stack component="ul" spacing={1} sx={{ m: 0, pl: 0 }}>
          {item.options.map((option) => (
            <Typography
              key={option.id}
              component="li"
              variant="answerOption"
              lang="de"
              sx={{ listStyle: 'none', overflowWrap: 'anywhere' }}
            >
              <strong>{option.id}</strong>{' '}
              <GermanText>{option.text}</GermanText>
            </Typography>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
};

// One answer row: a 48 px radio with the letter and the text beside it. The
// chosen row has a soft fill and a stronger frame besides the checked radio,
// so the choice does not rest on colour alone.
const optionSx = (isSelected: boolean): SxProps<Theme> => ({
  m: 0,
  width: '100%',
  minHeight: 56,
  alignItems: 'center',
  borderRadius: 1.5,
  borderStyle: 'solid',
  borderWidth: 2,
  borderColor: isSelected ? 'primary.main' : 'grey.300',
  bgcolor: (theme) =>
    isSelected ? alpha(theme.palette.primary.main, 0.1) : 'transparent',
  '&:has(.Mui-focusVisible)': { borderColor: 'primary.dark' },
});

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
