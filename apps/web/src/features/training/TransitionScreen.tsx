'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ClockSync } from './exam-clock';
import { useExamClock } from './useExamClock';

export type BeginStatus = 'idle' | 'beginning' | 'failed';

interface TransitionScreenProps {
  // The end of the transition by the server: Lesen starts by itself then.
  deadlineMs: number;
  sync: ClockSync;
  status: BeginStatus;
  onBegin: () => void;
  onZero: () => void;
}

// The pause between the closed Hören and Lesen of a full exam. The change
// of phase is announced once; the countdown is a timer without a live
// region. Starting Lesen early gives it its full time, so the guest can go
// on at once; without the button Lesen starts when the pause ends. The
// screen only reports the choice: the server alone moves the phase.
export const TransitionScreen = ({
  deadlineMs,
  sync,
  status,
  onBegin,
  onZero,
}: TransitionScreenProps) => {
  const t = useTranslations('transition');
  const display = useExamClock({ deadlineMs, sync, onZero });
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The keyboard and the screen reader land on the new phase.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby="transition-title"
      data-testid="transition-screen"
      data-state={display.state}
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Typography
          id="transition-title"
          component="h2"
          variant="h6"
          tabIndex={-1}
          ref={headingRef}
        >
          {t('title')}
        </Typography>
        <Typography role="status" data-testid="transition-status">
          {t('body')}
        </Typography>
        <Typography
          role="timer"
          aria-label={t('timer', { time: display.label })}
          data-testid="transition-timer"
          data-remaining-ms={Math.round(display.remainingMs)}
          data-deadline-ms={deadlineMs}
          fontWeight={600}
          suppressHydrationWarning
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {t('timer', { time: display.label })}
        </Typography>
        <Button
          variant="contained"
          size="large"
          data-testid="begin-lesen"
          disabled={status === 'beginning'}
          onClick={onBegin}
          sx={{ minHeight: 44 }}
        >
          {status === 'beginning' ? t('beginning') : t('begin')}
        </Button>
        {status === 'failed' ? (
          <Alert severity="error" role="alert" data-testid="begin-lesen-error">
            {t('error')}
          </Alert>
        ) : null}
      </Stack>
    </Paper>
  );
};
