'use client';

import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';

export type ReplacementProblem = 'busy' | 'error' | null;

interface GuestReplacementDialogProps {
  open: boolean;
  isWorking: boolean;
  problem: ReplacementProblem;
  onConfirm: () => void;
  onCancel: () => void;
  onExited: () => void;
}

// The consent before a new guest session replaces one that is too short for
// the chosen timed block. It only asks: nothing is created or started until
// the confirm button, and Cancel (also Escape) leaves everything unchanged.
// The focus starts on Cancel, the safe answer; MUI traps the focus inside
// and `onExited` returns it to the start button (which was disabled while
// the start ran, so the browser has no earlier focus to restore).
export const GuestReplacementDialog = ({
  open,
  isWorking,
  problem,
  onConfirm,
  onCancel,
  onExited,
}: GuestReplacementDialogProps) => {
  const t = useTranslations('choice.replace');
  return (
    <Dialog
      open={open}
      onClose={isWorking ? undefined : onCancel}
      fullWidth
      maxWidth="xs"
      aria-labelledby="guest-replacement-title"
      aria-describedby="guest-replacement-body"
      data-testid="guest-replacement-dialog"
      slotProps={{
        paper: { sx: { m: 1, width: 'calc(100% - 16px)' } },
        transition: { onExited },
      }}
    >
      <DialogTitle
        id="guest-replacement-title"
        sx={{ overflowWrap: 'anywhere' }}
      >
        {t('title')}
      </DialogTitle>
      <DialogContent id="guest-replacement-body">
        <DialogContentText sx={{ mb: 1.5 }}>{t('tooShort')}</DialogContentText>
        <DialogContentText sx={{ mb: 1.5 }}>{t('history')}</DialogContentText>
        <DialogContentText>{t('english')}</DialogContentText>
        {problem ? (
          <Alert
            severity="error"
            role="alert"
            sx={{ mt: 2 }}
            data-testid="guest-replacement-error"
          >
            {t(problem)}
          </Alert>
        ) : null}
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
          onClick={onCancel}
          disabled={isWorking}
          data-testid="guest-replacement-cancel"
          sx={{ minHeight: 44 }}
        >
          {t('keep')}
        </Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          disabled={isWorking}
          data-testid="guest-replacement-confirm"
          sx={{ minHeight: 44 }}
        >
          {isWorking ? t('working') : t('confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
