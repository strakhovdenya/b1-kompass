'use client';

import { useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Skill } from '@b1k/domain';
import type { ClockSync } from './exam-clock';
import { useExamClock } from './useExamClock';

// The room a phone keeps above a scrolled-to control for the pinned clock
// line (its height and a small gap); nothing is pinned from md up.
export const STICKY_CLOCK_CLEARANCE = { xs: '56px', md: 0 } as const;

interface AttemptTimerProps {
  deadlineMs: number;
  sync: ClockSync;
  skill: Skill;
  onZero: () => void;
}

// One compact line above the block: the skill and the time left by the
// server's clock. The mode (timed block or full exam) is named once by the
// exam context header, so this line never claims one. role="timer" without a
// live region: it is not
// announced every second; the end of the time is announced by the
// submission status of the shell.
// On a phone the running line stays pinned to the top of the screen while
// the tasks scroll beneath it; at zero it is an ordinary line again, so a
// run that is closing never keeps a pinned bar.
export const AttemptTimer = ({
  deadlineMs,
  sync,
  skill,
  onZero,
}: AttemptTimerProps) => {
  const t = useTranslations('timer');
  const display = useExamClock({ deadlineMs, sync, onZero });
  const skillName = t(`skill.${skill}`);
  const isPinned = display.state === 'running';

  return (
    <Box
      role="timer"
      aria-label={t('label', { skill: skillName, time: display.label })}
      data-testid="attempt-timer"
      data-state={display.state}
      data-pinned={isPinned ? 'phone' : 'none'}
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
        bgcolor: 'background.paper',
        position: isPinned ? { xs: 'sticky', md: 'static' } : 'static',
        top: 'env(safe-area-inset-top)',
        // Above the page, below the dictionary card, menus and dialogs.
        zIndex: 'appBar',
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
