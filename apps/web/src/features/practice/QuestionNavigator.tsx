'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';

// How much of a step the guest has answered. It says nothing about whether
// the answers are right.
export type StepProgress = 'answered' | 'partial' | 'empty';

export interface NavigatorStep {
  key: string;
  // The label on the button: "7", or "5–6" for a pair.
  label: string;
  // The number of the first question; it names the test id and the exam task.
  number: number;
  count: number;
  teil: number;
  progress: StepProgress;
}

interface NavigatorGroup {
  teil: number;
  items: { step: NavigatorStep; index: number }[];
}

const groupByTeil = (steps: readonly NavigatorStep[]): NavigatorGroup[] => {
  const groups: NavigatorGroup[] = [];
  steps.forEach((step, index) => {
    const last = groups[groups.length - 1];
    if (last?.teil === step.teil) {
      last.items.push({ step, index });
    } else {
      groups.push({ teil: step.teil, items: [{ step, index }] });
    }
  });
  return groups;
};

interface QuestionNavigatorProps {
  steps: readonly NavigatorStep[];
  // The zero-based position of the step on screen.
  index: number;
  // A save of the set's own answers is running: no step may be left now.
  isDisabled: boolean;
  onSelect: (index: number) => void;
}

const TARGET_PX = 44;

const stepSx = (
  progress: StepProgress,
  isCurrent: boolean,
): SxProps<Theme> => ({
  minWidth: { xs: TARGET_PX, md: 40 },
  height: { xs: TARGET_PX, md: 36 },
  px: 1,
  borderWidth: 2,
  borderStyle: progress === 'partial' && !isCurrent ? 'dashed' : 'solid',
  borderColor: isCurrent || progress !== 'empty' ? 'primary.main' : 'grey.500',
  bgcolor: (theme) =>
    isCurrent
      ? theme.palette.primary.main
      : progress === 'answered'
        ? alpha(theme.palette.primary.main, 0.12)
        : 'transparent',
  color: isCurrent
    ? 'primary.contrastText'
    : progress === 'empty'
      ? 'text.primary'
      : 'primary.dark',
  fontWeight: isCurrent ? 800 : 600,
  '&:hover': {
    borderWidth: 2,
    bgcolor: isCurrent ? 'primary.dark' : 'action.hover',
  },
});

// The one navigator of Hören and Lesen. A phone shows the position and a
// button that opens the full list under it (CSS only: the list stays in the
// page, closed it is display:none and so out of the tab order); from the md
// breakpoint the grid is always visible. The steps are grouped by Teil, and
// each tells current, answered and empty apart without colour: a frame, a ✓
// and an accessible word.
export const QuestionNavigator = ({
  steps,
  index,
  isDisabled,
  onSelect,
}: QuestionNavigatorProps) => {
  const t = useTranslations('set');
  const listId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const current = steps[index];

  // Escape closes the open list and returns the focus to its button. The
  // dictionary card is the layer above: while it is open, it consumes
  // Escape before this listener runs.
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen]);

  const choose = (next: number) => {
    onSelect(next);
    if (!isOpen) return;
    setIsOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <Box component="nav" aria-label={t('navigation')}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          columnGap: 1,
          rowGap: 1,
        }}
      >
        <Typography
          data-testid="set-position"
          sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
        >
          {t('position', { current: index + 1, total: steps.length })}
        </Typography>
        <Button
          ref={toggleRef}
          variant="outlined"
          aria-expanded={isOpen}
          aria-controls={listId}
          data-testid="navigator-toggle"
          onClick={() => setIsOpen((open) => !open)}
          sx={{
            display: { xs: 'inline-flex', md: 'none' },
            minHeight: TARGET_PX,
            maxWidth: '100%',
          }}
        >
          {t('allQuestions', { current: current?.label ?? '' })}
          <span aria-hidden="true">{isOpen ? ' ▴' : ' ▾'}</span>
        </Button>
      </Box>
      <Box
        id={listId}
        data-testid="navigator-list"
        sx={{
          display: { xs: isOpen ? 'flex' : 'none', md: 'flex' },
          flexDirection: { xs: 'column', md: 'row' },
          flexWrap: 'wrap',
          gap: { xs: 1, md: 0.75 },
          columnGap: { md: 2 },
          mt: 1,
        }}
      >
        {groupByTeil(steps).map((group) => (
          <Box
            key={group.teil}
            role="group"
            aria-label={t('teil', { teil: group.teil })}
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
            }}
          >
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ minWidth: { xs: 56, md: 0 }, fontWeight: 600 }}
            >
              {t('teil', { teil: group.teil })}
            </Typography>
            {group.items.map(({ step, index: stepIndex }) => {
              const isCurrent = stepIndex === index;
              return (
                <Button
                  key={step.key}
                  variant="outlined"
                  color="primary"
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={t('goTo', {
                    number: step.label,
                    count: step.count,
                    state: step.progress,
                  })}
                  data-testid={`go-to-question-${step.number}`}
                  data-progress={step.progress}
                  disabled={isDisabled}
                  onClick={() => choose(stepIndex)}
                  sx={stepSx(step.progress, isCurrent)}
                >
                  {step.label}
                  {step.progress === 'answered' ? (
                    <span aria-hidden="true">{' ✓'}</span>
                  ) : null}
                </Button>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
};
