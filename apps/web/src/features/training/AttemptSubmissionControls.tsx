'use client';

import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type {
  CancelSummary,
  ResultCheck,
  SubmissionPhase,
  SubmitConfirmation,
} from './useAttemptSubmission';

// The view of the submission and the cancel of one attempt. It renders the
// states it is given and reports the guest's choices; the commands, their
// order and their repetition belong to useAttemptSubmission.
export interface AttemptSubmissionControlsProps {
  phase: SubmissionPhase;
  confirmation: SubmitConfirmation | null;
  isRenewed: boolean;
  cancelSummary: CancelSummary | null;
  resultCheck: ResultCheck;
  answered: number;
  total: number;
  onSubmit: () => void;
  onConfirmSubmit: () => void;
  onResendSubmit: () => void;
  onCheckResult: () => void;
  onCancel: () => void;
  onConfirmCancel: () => void;
  onResendCancel: () => void;
  onDismiss: () => void;
}

// While a command is in flight or its answer was lost, no other starts.
const LOCKED_PHASES: readonly SubmissionPhase[] = [
  'sending',
  'uncertain',
  'cancel-loading',
  'cancelling',
  'cancel-uncertain',
];

export const AttemptSubmissionControls = ({
  phase,
  confirmation,
  isRenewed,
  cancelSummary,
  resultCheck,
  answered,
  total,
  onSubmit,
  onConfirmSubmit,
  onResendSubmit,
  onCheckResult,
  onCancel,
  onConfirmCancel,
  onResendCancel,
  onDismiss,
}: AttemptSubmissionControlsProps) => {
  const t = useTranslations('training');

  if (phase === 'accepted' || phase === 'completed') {
    return (
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Alert
          severity="info"
          role="status"
          data-testid="submission-accepted"
          data-phase={phase}
        >
          {phase === 'completed' ? t('resultOpening') : t('accepted')}
        </Alert>
        {phase === 'accepted' ? (
          <Button
            variant="contained"
            data-testid="result-check"
            disabled={resultCheck === 'checking'}
            onClick={onCheckResult}
          >
            {t('checkResult')}
          </Button>
        ) : null}
        {resultCheck === 'not-ready' ? (
          <Alert severity="warning" role="alert" data-testid="result-pending">
            {t('resultNotReady')}
          </Alert>
        ) : null}
      </Stack>
    );
  }

  const isLocked = LOCKED_PHASES.includes(phase);

  const confirming =
    phase === 'confirming' && confirmation ? (
      <Stack
        spacing={1.5}
        role="group"
        aria-labelledby="finish-confirm-title"
        data-testid="finish-confirmation"
        data-skipped={confirmation.skipped}
        data-unanswered-hoeren={confirmation.unanswered.hoeren}
        data-unanswered-lesen={confirmation.unanswered.lesen}
      >
        <Typography id="finish-confirm-title" fontWeight={600}>
          {t('confirmTitle')}
        </Typography>
        {isRenewed ? (
          <Alert severity="warning" role="alert" data-testid="finish-renewed">
            {t('confirmRenewed')}
          </Alert>
        ) : null}
        <Typography>
          {t('confirmBody', {
            hoeren: confirmation.unanswered.hoeren,
            lesen: confirmation.unanswered.lesen,
          })}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            data-testid="finish-confirm"
            onClick={onConfirmSubmit}
          >
            {t('confirm')}
          </Button>
          <Button
            variant="outlined"
            data-testid="finish-cancel"
            onClick={onDismiss}
          >
            {t('cancel')}
          </Button>
        </Stack>
      </Stack>
    ) : null;

  const cancelling =
    phase === 'cancel-confirming' && cancelSummary ? (
      <Stack
        spacing={1.5}
        role="group"
        aria-labelledby="cancel-confirm-title"
        data-testid="cancel-confirmation"
        data-skipped={cancelSummary.skipped}
        data-unsaved={cancelSummary.unsaved}
      >
        <Typography id="cancel-confirm-title" fontWeight={600}>
          {t('cancelTitle')}
        </Typography>
        {isRenewed ? (
          <Alert severity="warning" role="alert" data-testid="cancel-renewed">
            {t('confirmRenewed')}
          </Alert>
        ) : null}
        <Typography>
          {t('cancelBody', { skipped: cancelSummary.skipped })}
        </Typography>
        {cancelSummary.unsaved > 0 ? (
          <Alert severity="warning" data-testid="cancel-unsaved">
            {t('cancelUnsaved', { unsaved: cancelSummary.unsaved })}
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            color="error"
            data-testid="cancel-confirm"
            onClick={onConfirmCancel}
          >
            {t('cancelConfirm')}
          </Button>
          <Button
            variant="outlined"
            data-testid="cancel-back"
            onClick={onDismiss}
          >
            {t('cancel')}
          </Button>
        </Stack>
      </Stack>
    ) : null;

  const actions =
    confirming || cancelling ? null : (
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          data-testid="finish-attempt"
          disabled={isLocked}
          onClick={onSubmit}
        >
          {phase === 'sending' ? t('finishing') : t('finish')}
        </Button>
        <Button
          variant="text"
          color="error"
          data-testid="cancel-attempt"
          disabled={isLocked}
          onClick={onCancel}
        >
          {t('cancelAttempt')}
        </Button>
      </Stack>
    );

  return (
    <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <Typography data-testid="training-answered">
        {t('answered', { answered, total })}
      </Typography>
      {confirming}
      {cancelling}
      {actions}
      {phase === 'sending' ? (
        <Typography role="status" data-testid="submission-sending">
          {t('finishing')}
        </Typography>
      ) : null}
      {phase === 'uncertain' ? (
        <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Alert severity="warning" role="alert" data-testid="finish-uncertain">
            {t('finishUncertain')}
          </Alert>
          <Button
            variant="contained"
            data-testid="finish-resend"
            onClick={onResendSubmit}
          >
            {t('resend')}
          </Button>
        </Stack>
      ) : null}
      {phase === 'cancel-uncertain' ? (
        <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Alert severity="warning" role="alert" data-testid="cancel-uncertain">
            {t('cancelUncertain')}
          </Alert>
          <Button
            variant="contained"
            data-testid="cancel-resend"
            onClick={onResendCancel}
          >
            {t('resend')}
          </Button>
        </Stack>
      ) : null}
      {phase === 'failed' ? (
        <Alert severity="error" role="alert" data-testid="finish-status">
          {t('finishError')}
        </Alert>
      ) : null}
      {phase === 'cancel-failed' ? (
        <Alert severity="error" role="alert" data-testid="cancel-status">
          {t('cancelError')}
        </Alert>
      ) : null}
    </Stack>
  );
};
