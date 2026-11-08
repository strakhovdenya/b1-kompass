'use client';

import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import type { AttemptMode } from '@b1k/domain';
import {
  LIBRARY_PATH,
  TimedLeaveDialog,
  useBeforeUnloadWarning,
} from './TimedLeaveDialog';

export type ExamStage = 'hoeren' | 'lesen' | 'transition' | 'review';

const MODE_KEYS: Readonly<Record<AttemptMode, string>> = {
  training: 'training',
  'timed-block': 'timedBlock',
  exam: 'exam',
};

interface ExamContextHeaderProps {
  // The title of the exam as the server read it for the opened exam or the
  // verified attempt; German material, shown as is.
  examTitle: string;
  // Known only on an attempt; the choice of an exam shows neither.
  mode?: AttemptMode | null;
  stage?: ExamStage | null;
  // True only for a running timed block or exam: the link then asks before
  // leaving. The time runs on the server whatever the guest chooses.
  warnOnLeave?: boolean;
}

// The place of the guest: the way back to the library, the exam and, where
// known, the mode and the stage. A landmark, not a heading, and not part of
// the app bar: the page keeps its own h1. The link is a plain address: going
// back starts, cancels, submits and changes nothing.
export const ExamContextHeader = ({
  examTitle,
  mode = null,
  stage = null,
  warnOnLeave = false,
}: ExamContextHeaderProps) => {
  const t = useTranslations('examContext');
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [isAsking, setAsking] = useState(false);
  const [isLeaving, setLeaving] = useState(false);
  useBeforeUnloadWarning(warnOnLeave && !isLeaving);

  // Only a plain left click is held back; a new tab or window (modifier or
  // middle click) leaves this page where it is and needs no question.
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!warnOnLeave) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    setAsking(true);
  };
  const stay = () => {
    setAsking(false);
    linkRef.current?.focus();
  };
  const leave = () => {
    setLeaving(true);
    setAsking(false);
  };
  const modeLabel = mode ? t(`mode.${MODE_KEYS[mode]}`) : null;
  const stageLabel = stage ? t(`stage.${stage}`) : null;
  const where =
    modeLabel && stageLabel
      ? t('modeStage', { mode: modeLabel, stage: stageLabel })
      : (modeLabel ?? stageLabel);

  return (
    <Box
      component="nav"
      aria-label={t('label')}
      data-testid="exam-context"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 1,
        minWidth: 0,
      }}
    >
      <MuiLink
        component={Link}
        href={LIBRARY_PATH}
        ref={linkRef}
        onClick={onLinkClick}
        underline="hover"
        data-testid="exam-context-library"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          flexShrink: 0,
          // A 44 px target that takes 28 px of the page: the rest overlaps
          // the margins around it, above the neighbours.
          minHeight: 44,
          my: -1,
          position: 'relative',
          zIndex: 1,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          borderRadius: 1,
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      >
        <span aria-hidden="true">←&nbsp;</span>
        {t('library')}
      </MuiLink>
      <Box
        aria-hidden="true"
        sx={{
          display: { xs: 'none', sm: 'block' },
          width: '1px',
          height: 16,
          flexShrink: 0,
          bgcolor: 'divider',
        }}
      />
      <Typography
        component="span"
        variant="body2"
        lang="de"
        noWrap
        data-testid="exam-context-title"
        sx={{
          // A phone gives the title a row of its own, cut to one line; a
          // wider screen keeps everything in one row.
          order: { xs: 2, sm: 0 },
          flex: { xs: '1 1 100%', sm: '1 1 0' },
          minWidth: 0,
          fontWeight: 600,
        }}
      >
        {examTitle}
      </Typography>
      {where ? (
        <Typography
          component="span"
          variant="body2"
          color="text.secondary"
          noWrap
          data-testid="exam-context-where"
          sx={{
            order: 1,
            // On a phone it takes what the link leaves in the first row,
            // so it never wraps below the title.
            flex: { xs: '1 1 0', sm: '0 1 auto' },
            minWidth: 0,
            textAlign: { xs: 'right', sm: 'left' },
            maxWidth: { sm: '45%' },
          }}
        >
          {where}
        </Typography>
      ) : null}
      {warnOnLeave ? (
        <TimedLeaveDialog open={isAsking} onStay={stay} onLeave={leave} />
      ) : null}
    </Box>
  );
};
