'use client';

import { useRef, useState } from 'react';
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
import type { ExamQuestion, SaveAnswerResult } from '@b1k/domain';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'session-invalid';

export interface SaveAnswerInput {
  attemptId: string;
  questionId: string;
  optionId: string;
}

interface QuestionCardProps {
  attemptId: string;
  question: ExamQuestion;
  initialOptionId: string | null;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
}

export const QuestionCard = ({
  attemptId,
  question,
  initialOptionId,
  saveAnswer,
}: QuestionCardProps) => {
  const t = useTranslations();
  const [selected, setSelected] = useState(initialOptionId);
  const [status, setStatus] = useState<SaveStatus>(
    initialOptionId ? 'saved' : 'idle',
  );
  const requestSeq = useRef(0);

  const submit = async (optionId: string) => {
    const seq = ++requestSeq.current;
    setStatus('saving');
    let result: SaveAnswerResult;
    try {
      result = await saveAnswer({ attemptId, questionId: question.id, optionId });
    } catch (error) {
      console.error({ error });
      result = { ok: false, error: 'unavailable' };
    }
    if (seq !== requestSeq.current) return;
    if (result.ok && result.optionId === optionId) setStatus('saved');
    else if (!result.ok && result.error === 'session-invalid') {
      setStatus('session-invalid');
    } else setStatus('error');
  };

  const handleChange = (optionId: string) => {
    setSelected(optionId);
    void submit(optionId);
  };

  const labelId = `question-${question.id}`;

  return (
    <Paper component="section" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
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
            value={selected ?? ''}
            onChange={(event) => handleChange(event.target.value)}
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
        <SaveStatusLine
          status={status}
          onRetry={selected ? () => void submit(selected) : null}
        />
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
  const text = { idle: t('idle'), saving: t('saving'), saved: `✓ ${t('saved')}` };
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
