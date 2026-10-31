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

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'session-invalid';

export interface SaveAnswerInput {
  attemptId: string;
  questionId: string;
  optionId: string;
}

interface QuestionCardProps {
  attemptId: string;
  question: ExamQuestion;
  initialOptionId: string | null;
  initialStatus?: SaveStatus;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
  onSettled?: (questionId: string, optionId: string, status: SaveStatus) => void;
  onStatusChange?: (status: SaveStatus) => void;
}

export const QuestionCard = ({
  attemptId,
  question,
  initialOptionId,
  initialStatus,
  saveAnswer,
  onSettled,
  onStatusChange,
}: QuestionCardProps) => {
  const t = useTranslations();
  const [selected, setSelected] = useState(initialOptionId);
  const [status, setStatus] = useState<SaveStatus>(
    initialStatus ?? (initialOptionId ? 'saved' : 'idle'),
  );
  const requestSeq = useRef(0);

  const changeStatus = (next: SaveStatus) => {
    setStatus(next);
    onStatusChange?.(next);
  };

  const submit = async (optionId: string) => {
    const seq = ++requestSeq.current;
    changeStatus('saving');
    let result: SaveAnswerResult;
    try {
      result = await saveAnswer({ attemptId, questionId: question.id, optionId });
    } catch (error) {
      console.error({ error });
      result = { ok: false, error: 'unavailable' };
    }
    if (seq !== requestSeq.current) return;
    let settled: SaveStatus = 'error';
    if (result.ok && result.optionId === optionId) settled = 'saved';
    else if (!result.ok && result.error === 'session-invalid') {
      settled = 'session-invalid';
    }
    changeStatus(settled);
    onSettled?.(question.id, optionId, settled);
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
