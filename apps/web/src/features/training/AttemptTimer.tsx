'use client';

import { useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Skill } from '@b1k/domain';
import type { ClockSync } from './exam-clock';
import { useExamClock } from './useExamClock';

interface AttemptTimerProps {
  deadlineMs: number;
  sync: ClockSync;
  skill: Skill;
  onZero: () => void;
}

// One compact line above the block: the mode, the skill and the time left by
// the server's clock. role="timer" without a live region: it is not
// announced every second; the end of the time is announced by the
// submission status of the shell.
export const AttemptTimer = ({
  deadlineMs,
  sync,
  skill,
  onZero,
}: AttemptTimerProps) => {
  const t = useTranslations('timer');
  const display = useExamClock({ deadlineMs, sync, onZero });
  const skillName = t(`skill.${skill}`);

  return (
    <Box
      role="timer"
      aria-label={t('label', { skill: skillName, time: display.label })}
      data-testid="attempt-timer"
      data-state={display.state}
      data-remaining-ms={Math.round(display.remainingMs)}
      data-deadline-ms={deadlineMs}
      sx={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 1,
        minWidth: 0,
        px: 1.5,
        py: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
      }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        noWrap
        sx={{ minWidth: 0 }}
      >
        {t('context', { skill: skillName })}
      </Typography>
      <Typography
        component="span"
        variant="body1"
        fontWeight={600}
        suppressHydrationWarning
        sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {t('left', { time: display.label })}
      </Typography>
    </Box>
  );
};
