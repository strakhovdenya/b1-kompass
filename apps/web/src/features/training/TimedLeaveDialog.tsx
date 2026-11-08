'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';

export const LIBRARY_PATH = '/exams';

interface TimedLeaveDialogProps {
  open: boolean;
  // Stay: the dialog closes, nothing else changes. Escape and a click on the
  // backdrop mean the same.
  onStay: () => void;
  // Leave: a plain link to the library, and only that; the callback only
  // tells the caller that the leave began.
  onLeave: () => void;
}

// What the dialog says and offers, apart from the MUI shell, so a test can
// render it on the server. Two plain actions: no cancel or submit of the
// attempt, no pause. "Stay" is the focused default; leaving is not
// destructive, so it is a normal button, not an error colour.
export const TimedLeaveBody = ({
  onStay,
  onLeave,
}: Pick<TimedLeaveDialogProps, 'onStay' | 'onLeave'>) => {
  const t = useTranslations('timedLeave');
  return (
    <>
      <DialogTitle id="timed-leave-title" sx={{ overflowWrap: 'anywhere' }}>
        {t('title')}
      </DialogTitle>
      <DialogContent id="timed-leave-body">
        <DialogContentText sx={{ mb: 1.5 }}>{t('body')}</DialogContentText>
        <DialogContentText>{t('hint')}</DialogContentText>
      </DialogContent>
      <DialogActions
        sx={{
          flexDirection: { xs: 'column-reverse', sm: 'row' },
          alignItems: 'stretch',
          gap: 1,
          px: 3,
          pb: 2,
          '& > :not(style) ~ :not(style)': { ml: 0 },
        }}
      >
        <Button
          autoFocus
          onClick={onStay}
          data-testid="timed-leave-stay"
          sx={{ minHeight: 44 }}
        >
          {t('stay')}
        </Button>
        <Button
          component={Link}
          href={LIBRARY_PATH}
          variant="contained"
          onClick={onLeave}
          data-testid="timed-leave-confirm"
          sx={{ minHeight: 44 }}
        >
          {t('leave')}
        </Button>
      </DialogActions>
    </>
  );
};

// The warning before the guest leaves a running timed block or exam for the
// library. It only informs: the server keeps the deadline whatever the guest
// does here.
export const TimedLeaveDialog = ({
  open,
  onStay,
  onLeave,
}: TimedLeaveDialogProps) => (
  <Dialog
    open={open}
    onClose={onStay}
    fullWidth
    maxWidth="xs"
    aria-labelledby="timed-leave-title"
    aria-describedby="timed-leave-body"
    data-testid="timed-leave-dialog"
    slotProps={{ paper: { sx: { m: 1, width: 'calc(100% - 16px)' } } }}
  >
    <TimedLeaveBody onStay={onStay} onLeave={onLeave} />
  </Dialog>
);

// Best effort only: the browser decides whether to ask on a refresh, a
// closed tab or a system Back, and may show its own generic text. Nothing
// here pauses or protects the run; the server's deadline does.
export const useBeforeUnloadWarning = (active: boolean): void => {
  useEffect(() => {
    if (!active) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older WebKit asks only when the legacy value is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
};
