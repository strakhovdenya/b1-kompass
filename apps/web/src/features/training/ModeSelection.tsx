'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { AttemptMode, AttemptSelection } from '@b1k/domain';
import { attemptPath, requestStart } from './attempt-client';

interface ModeSelectionProps {
  examSlug: string;
  examTitle: string;
  versionId: string;
  questionCount: number;
  hoerenCount: number;
  lesenCount: number;
  activeAttemptId: string | null;
}

type StartStatus =
  | 'idle'
  | 'starting'
  | 'error'
  | 'conflict'
  | 'changed'
  | 'not-enabled'
  | 'guest-too-short';

// The free training and one timed block are enabled; the full exam is shown
// as coming, without a way to start it. The time of a block is set by the
// server from the confirmed profile of the exam, never chosen here.
const MODES: readonly { mode: AttemptMode; isEnabled: boolean }[] = [
  { mode: 'training', isEnabled: true },
  { mode: 'timed-block', isEnabled: true },
  { mode: 'exam', isEnabled: false },
];

const DETAIL_KEYS: Readonly<Record<AttemptMode, string>> = {
  training: 'trainingDetail',
  'timed-block': 'timedBlockDetail',
  exam: 'comingSoon',
};

// A timed block is one skill: the whole set is not offered for it.
const isOffered = (mode: AttemptMode, selection: AttemptSelection): boolean =>
  mode !== 'timed-block' || selection !== 'all';

const MODE_KEYS: Readonly<Record<AttemptMode, string>> = {
  training: 'training',
  'timed-block': 'timedBlock',
  exam: 'exam',
};

const SELECTIONS: readonly AttemptSelection[] = ['all', 'hoeren', 'lesen'];

// The choice before a start. Opening it writes nothing; only the start
// button sends a command. A lost answer is sent again with the same
// commandId, so it cannot start a second attempt.
export const ModeSelection = ({
  examSlug,
  examTitle,
  versionId,
  questionCount,
  hoerenCount,
  lesenCount,
  activeAttemptId,
}: ModeSelectionProps) => {
  const t = useTranslations('choice');
  const router = useRouter();
  const [status, setStatus] = useState<StartStatus>('idle');
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [mode, setMode] = useState<AttemptMode>('training');
  const [selection, setSelection] = useState<AttemptSelection>('all');
  const commandId = useRef<string | null>(null);
  const counts: Readonly<Record<AttemptSelection, number>> = {
    all: questionCount,
    hoeren: hoerenCount,
    lesen: lesenCount,
  };

  // Another choice is another command: a lost answer of the old one is
  // not resent for it.
  const select = (value: AttemptSelection) => {
    commandId.current = null;
    setConflictId(null);
    setStatus('idle');
    setSelection(value);
  };

  const chooseMode = (value: AttemptMode) => {
    commandId.current = null;
    setConflictId(null);
    setStatus('idle');
    setMode(value);
    if (!isOffered(value, selection)) {
      setSelection(hoerenCount > 0 ? 'hoeren' : 'lesen');
    }
  };

  const start = async () => {
    commandId.current ??= crypto.randomUUID();
    setStatus('starting');
    const result = await requestStart({
      commandId: commandId.current,
      examSlug,
      mode,
      purpose: 'normal',
      selection,
      sourceAttemptId: null,
      expectedVersionId: versionId,
    });
    if (result.ok && result.result.outcome === 'accepted') {
      router.push(attemptPath(examSlug, result.result.attemptId));
      return;
    }
    if (result.ok) {
      commandId.current = null;
      setConflictId(result.result.attemptId);
      setStatus('conflict');
      return;
    }
    // A lost or failed answer keeps the command: the start may already be
    // committed, and the same commandId returns that attempt on a retry.
    const isRetryable =
      result.failure === 'network' || result.failure === 'unavailable';
    if (!isRetryable) commandId.current = null;
    if (result.failure === 'session-invalid') {
      router.push('/');
      return;
    }
    if (result.failure === 'not-found') {
      setStatus('changed');
      router.refresh();
      return;
    }
    if (result.failure === 'guest-too-short') {
      setStatus('guest-too-short');
      return;
    }
    setStatus(result.failure === 'not-enabled' ? 'not-enabled' : 'error');
  };

  const continueId = conflictId ?? activeAttemptId;
  const isStarting = status === 'starting';

  return (
    <Stack spacing={3} data-testid="mode-selection" data-exam-slug={examSlug}>
      <Typography component="h1" variant="h5" lang="de">
        {examTitle}
      </Typography>
      {continueId ? (
        <Alert
          severity="info"
          data-testid="active-attempt"
          action={
            <Button
              component={Link}
              href={attemptPath(examSlug, continueId)}
              color="inherit"
              data-testid="continue-attempt"
            >
              {t('continue')}
            </Button>
          }
        >
          {t('active')}
        </Alert>
      ) : null}
      <FormControl>
        <FormLabel id="mode-label">{t('modeLabel')}</FormLabel>
        <RadioGroup
          aria-labelledby="mode-label"
          value={mode}
          onChange={(_event, value) => {
            const picked = MODES.find(
              (item) => item.isEnabled && item.mode === value,
            );
            if (picked) chooseMode(picked.mode);
          }}
        >
          {MODES.map((item) => (
            <FormControlLabel
              key={item.mode}
              value={item.mode}
              disabled={!item.isEnabled || isStarting}
              control={<Radio />}
              data-testid={`mode-option-${item.mode}`}
              label={
                <Stack sx={{ py: 0.5 }}>
                  <Typography>{t(`mode.${MODE_KEYS[item.mode]}`)}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t(DETAIL_KEYS[item.mode])}
                  </Typography>
                </Stack>
              }
            />
          ))}
        </RadioGroup>
      </FormControl>
      <FormControl>
        <FormLabel id="selection-label">{t('selectionLabel')}</FormLabel>
        <RadioGroup
          aria-labelledby="selection-label"
          value={selection}
          onChange={(_event, value) => {
            const picked = SELECTIONS.find((item) => item === value);
            if (picked) select(picked);
          }}
        >
          {SELECTIONS.map((item) => (
            <FormControlLabel
              key={item}
              value={item}
              control={<Radio />}
              disabled={
                isStarting || counts[item] === 0 || !isOffered(mode, item)
              }
              data-testid={`selection-option-${item}`}
              label={t(`selection.${item}`, { count: counts[item] })}
            />
          ))}
        </RadioGroup>
      </FormControl>
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Button
          variant="contained"
          size="large"
          data-testid="start-attempt"
          disabled={isStarting}
          onClick={() => void start()}
        >
          {isStarting ? t('starting') : t('start')}
        </Button>
        <div role="status" data-testid="start-status" data-status={status}>
          {status === 'conflict' ? (
            <Alert severity="warning">{t('conflict')}</Alert>
          ) : null}
          {status === 'changed' ? (
            <Alert severity="info">{t('changed')}</Alert>
          ) : null}
        </div>
        {status === 'error' || status === 'not-enabled' ? (
          <Alert severity="error" role="alert" data-testid="start-error">
            {status === 'error' ? t('error') : t('notEnabled')}
          </Alert>
        ) : null}
        {status === 'guest-too-short' ? (
          <Alert
            severity="warning"
            role="alert"
            data-testid="start-guest-too-short"
          >
            {t('guestTooShort')}
          </Alert>
        ) : null}
      </Stack>
    </Stack>
  );
};
