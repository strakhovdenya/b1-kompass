'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import type { SxProps, Theme } from '@mui/material/styles';
import type { AttemptMode, AttemptSelection } from '@b1k/domain';
import {
  attemptPath,
  requestPrepareAudio,
  requestStart,
} from './attempt-client';
import type { ExamTiming, ReplaceGuest, StartRequest } from './attempt-client';
import { useExamAudio } from './ExamAudioSession';
import { GuestReplacementDialog } from './GuestReplacementDialog';
import type { ReplacementProblem } from './GuestReplacementDialog';

interface ModeSelectionProps {
  examSlug: string;
  examTitle: string;
  versionId: string;
  questionCount: number;
  hoerenCount: number;
  lesenCount: number;
  activeAttemptId: string | null;
  // The confirmed durations of the full exam; null while it cannot start.
  examTiming?: ExamTiming | null;
  replaceGuest: ReplaceGuest;
}

// A prepared address must still cover the whole Hören, with this margin,
// when the exam starts; earlier it is renewed in the background.
const FRESH_MARGIN_MS = 15_000;

type PrepareStatus = 'idle' | 'preparing' | 'failed' | 'conflict';

// What the choice shows of the prepared recording of a full exam.
type ExamAudioState =
  'preparing' | 'loading' | 'ready' | 'stale' | 'error' | 'conflict';

const MINUTE_SECONDS = 60;

type StartStatus =
  | 'idle'
  | 'starting'
  | 'error'
  | 'conflict'
  | 'changed'
  | 'not-enabled'
  | 'guest-too-short'
  | 'replacement-not-needed';

// The free training, one timed block and the full exam. The full exam is
// offered once its profile is confirmed. The times are set by the server
// from the confirmed profile of the exam, never chosen here.
const MODES: readonly AttemptMode[] = ['training', 'timed-block', 'exam'];

const DETAIL_KEYS: Readonly<Record<AttemptMode, string>> = {
  training: 'trainingDetail',
  'timed-block': 'timedBlockDetail',
  exam: 'examDetail',
};

// A timed block is one skill: the whole set is not offered for it. The full
// exam is always the whole set.
const isOffered = (mode: AttemptMode, selection: AttemptSelection): boolean => {
  if (mode === 'exam') return selection === 'all';
  return mode !== 'timed-block' || selection !== 'all';
};

const MODE_KEYS: Readonly<Record<AttemptMode, string>> = {
  training: 'training',
  'timed-block': 'timedBlock',
  exam: 'exam',
};

const SELECTIONS: readonly AttemptSelection[] = ['all', 'hoeren', 'lesen'];

// A mode is a card the whole of which selects its radio. The selected card
// has a thicker border (an inset shadow keeps the layout still) beside the
// checked radio, so the state is not carried by colour alone.
const cardSx = (isSelected: boolean): SxProps<Theme> => ({
  alignItems: 'flex-start',
  m: 0,
  minHeight: 64,
  minWidth: 0,
  px: 1,
  py: 0.5,
  border: 1,
  borderRadius: 2,
  borderColor: isSelected ? 'primary.main' : 'divider',
  bgcolor: isSelected ? 'action.selected' : 'background.paper',
  boxShadow: (theme) =>
    isSelected ? `inset 0 0 0 1px ${theme.palette.primary.main}` : 'none',
  '& .MuiFormControlLabel-label': { minWidth: 0, flex: 1 },
  '&.Mui-disabled': {
    bgcolor: isSelected ? 'action.selected' : 'action.disabledBackground',
  },
});

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
  examTiming = null,
  replaceGuest,
}: ModeSelectionProps) => {
  const t = useTranslations('choice');
  const router = useRouter();
  const audio = useExamAudio();
  const [status, setStatus] = useState<StartStatus>('idle');
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [mode, setMode] = useState<AttemptMode>('training');
  const [selection, setSelection] = useState<AttemptSelection>('all');
  const commandId = useRef<string | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [isReplacing, setReplacing] = useState(false);
  const [problem, setProblem] = useState<ReplacementProblem>(null);
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

  // Both timed modes need the confirmed profile of this version; the server
  // checks it again on every start.
  const isEnabled = (value: AttemptMode): boolean =>
    value === 'training' || examTiming !== null;

  // The preparation of the full exam: the one recording, before any
  // attempt. The address must cover the whole Hören when the exam starts;
  // shortly before it no longer does, it is renewed in the background while
  // no exam time runs, and the start waits for the new one to be playable.
  const [prepare, setPrepare] = useState<PrepareStatus>('idle');
  const [coverMs, setCoverMs] = useState(0);
  // The prepared address no longer covers the whole Hören.
  const [isStale, setIsStale] = useState(false);
  const { source, load, dispose } = audio;
  const isOwnSource = source !== null && source.attemptId === null;

  const prepareAudio = useCallback(async () => {
    setPrepare('preparing');
    const result = await requestPrepareAudio({
      examSlug,
      expectedVersionId: versionId,
    });
    if (result.ok) {
      const { url, expiresAt, serverNow, coverSeconds } = result.audio;
      setCoverMs(coverSeconds * 1000);
      load(url, expiresAt, serverNow);
      setIsStale(false);
      setPrepare('idle');
      return;
    }
    if (result.error === 'session-invalid') {
      router.push('/');
      return;
    }
    if (result.error === 'not-found') {
      setStatus('changed');
      router.refresh();
    }
    setPrepare(result.error === 'conflict' ? 'conflict' : 'failed');
  }, [examSlug, versionId, load, router]);

  const isExam = mode === 'exam';
  const expiresAtLocalMs = isOwnSource ? source.expiresAtLocalMs : null;
  // No renewal while a start is in flight: it would replace the address
  // the click has just started playing.
  const isStartPending = status === 'starting';
  useEffect(() => {
    if (!isExam || isStartPending || expiresAtLocalMs === null) {
      return undefined;
    }
    const delayMs =
      expiresAtLocalMs - coverMs - FRESH_MARGIN_MS - performance.now();
    const renew = setTimeout(
      () => {
        setIsStale(true);
        void prepareAudio();
      },
      Math.max(0, delayMs),
    );
    return () => clearTimeout(renew);
  }, [isExam, isStartPending, expiresAtLocalMs, coverMs, prepareAudio]);

  // Checked again inside the click by the monotonic clock of the page.
  const isFreshNow = (): boolean =>
    isOwnSource &&
    source.expiresAtLocalMs - performance.now() >= coverMs + FRESH_MARGIN_MS;

  const examAudioState = (): ExamAudioState => {
    if (prepare === 'preparing') return 'preparing';
    if (prepare === 'conflict') return 'conflict';
    if (prepare === 'failed' || audio.status === 'error') return 'error';
    if (audio.status !== 'ready' || !isOwnSource) return 'loading';
    return isStale ? 'stale' : 'ready';
  };
  const examState = isExam ? examAudioState() : null;

  const chooseMode = (value: AttemptMode) => {
    commandId.current = null;
    setConflictId(null);
    setStatus('idle');
    setMode(value);
    if (value === 'exam') {
      setSelection('all');
      // An address of an attempt is not a preparation: the exam starts
      // with its own.
      if (!isOwnSource) {
        dispose();
        void prepareAudio();
      }
      return;
    }
    // A recording prepared for the exam is not kept for another mode.
    dispose();
    if (!isOffered(value, selection)) {
      setSelection(hoerenCount > 0 ? 'hoeren' : 'lesen');
    }
  };

  const startRequest = (): StartRequest => {
    commandId.current ??= crypto.randomUUID();
    return {
      commandId: commandId.current,
      examSlug,
      mode,
      purpose: 'normal',
      selection,
      sourceAttemptId: null,
      expectedVersionId: versionId,
    };
  };

  const start = async () => {
    setStatus('starting');
    const result = await requestStart(startRequest());
    if (result.ok && result.result.outcome === 'accepted') {
      // The exam layout stays mounted above the attempt: the attempt opens
      // at the top of the page, not scrolled to its own segment.
      window.scrollTo({ top: 0 });
      router.push(attemptPath(examSlug, result.result.attemptId), {
        scroll: false,
      });
      return;
    }
    // A refused, failed or lost start leaves no sound: the exam has not
    // begun for this page. A retry with the same commandId plays again.
    audio.stop();
    audio.setActive(false);
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
      setProblem(null);
      setDialogOpen(true);
      return;
    }
    setStatus(result.failure === 'not-enabled' ? 'not-enabled' : 'error');
  };

  // The consent was given: the server checks the refusal again and only then
  // creates the new guest and its cookie. The chosen block is started by a
  // separate request afterwards, with a new commandId, under the new cookie.
  const replace = async () => {
    setReplacing(true);
    setProblem(null);
    // The recording prepared for the old guest is let go before its cookie
    // is replaced; the new guest prepares its own.
    audio.dispose();
    let answer;
    try {
      answer = await replaceGuest({ consent: true, start: startRequest() });
    } catch {
      setReplacing(false);
      setProblem('error');
      return;
    }
    setReplacing(false);
    if (answer.status === 'replaced') {
      setDialogOpen(false);
      commandId.current = null;
      router.refresh();
      // Sound needs the guest's own click: the exam is prepared again and
      // started by the button; a timed block starts right away.
      if (isExam) {
        setStatus('idle');
        void prepareAudio();
        return;
      }
      await start();
      return;
    }
    if (answer.status === 'rate-limited') {
      setProblem('busy');
      return;
    }
    setDialogOpen(false);
    if (answer.status === 'replacement-not-needed') {
      setStatus('replacement-not-needed');
      return;
    }
    if (answer.status === 'conflict') {
      commandId.current = null;
      setConflictId(answer.attemptId);
      setStatus('conflict');
      return;
    }
    if (answer.failure === 'session-invalid') {
      router.push('/');
      return;
    }
    if (answer.failure === 'not-found') {
      commandId.current = null;
      setStatus('changed');
      router.refresh();
      return;
    }
    if (answer.failure === 'not-enabled') {
      setStatus('not-enabled');
      return;
    }
    setStatus('error');
  };

  const continueId = conflictId ?? activeAttemptId;
  const isStarting = status === 'starting';

  const detailOf = (item: AttemptMode): string => {
    if (item === 'training') return t(DETAIL_KEYS[item]);
    if (!examTiming) return item === 'exam' ? '' : t(DETAIL_KEYS[item]);
    if (item === 'timed-block') {
      return `${t(DETAIL_KEYS[item])} ${t('timedBlockTimes', {
        hoeren: Math.round(examTiming.hoerenSeconds / MINUTE_SECONDS),
        lesen: Math.round(examTiming.lesenSeconds / MINUTE_SECONDS),
      })}`;
    }
    return t('examDetail', {
      hoeren: Math.round(examTiming.hoerenSeconds / MINUTE_SECONDS),
      transition: examTiming.transitionSeconds,
      lesen: Math.round(examTiming.lesenSeconds / MINUTE_SECONDS),
    });
  };

  // The explicit start. For the full exam the recording starts inside this
  // click, before any await, and the start goes to the server beside it; a
  // stale or unprepared recording starts nothing and is prepared again.
  const onStart = () => {
    if (isExam) {
      if (examAudioState() !== 'ready' || !isFreshNow()) {
        setIsStale(true);
        void prepareAudio();
        return;
      }
      audio.setActive(true);
      audio.play();
    }
    void start();
  };
  const isStartBlocked = isStarting || (isExam && examState !== 'ready');

  return (
    <Stack
      spacing={3}
      data-testid="mode-selection"
      data-exam-slug={examSlug}
      sx={{ maxWidth: 720, mx: 'auto', minWidth: 0 }}
    >
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
      <FormControl sx={{ minWidth: 0 }}>
        <FormLabel id="mode-label" sx={{ mb: 1 }}>
          {t('modeLabel')}
        </FormLabel>
        <RadioGroup
          aria-labelledby="mode-label"
          value={mode}
          sx={{ gap: 1.5 }}
          onChange={(_event, value) => {
            const picked = MODES.find(
              (item) => isEnabled(item) && item === value,
            );
            if (picked) chooseMode(picked);
          }}
        >
          {MODES.map((item) => (
            <FormControlLabel
              key={item}
              value={item}
              disabled={!isEnabled(item) || isStarting}
              control={
                <Radio
                  slotProps={{
                    input: {
                      'aria-describedby': isEnabled(item)
                        ? undefined
                        : `mode-reason-${item}`,
                    },
                  }}
                />
              }
              data-testid={`mode-option-${item}`}
              sx={cardSx(mode === item)}
              label={
                <Stack sx={{ py: 0.5, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }}>
                    {t(`mode.${MODE_KEYS[item]}`)}
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {t(`modeFact.${MODE_KEYS[item]}`)}
                  </Typography>
                  {detailOf(item) ? (
                    <Typography variant="body2" color="text.secondary">
                      {detailOf(item)}
                    </Typography>
                  ) : null}
                  {isEnabled(item) ? null : (
                    <Typography
                      id={`mode-reason-${item}`}
                      variant="body2"
                      color="text.secondary"
                      data-testid={`mode-reason-${item}`}
                    >
                      {t('needsProfile')}
                    </Typography>
                  )}
                </Stack>
              }
            />
          ))}
        </RadioGroup>
      </FormControl>
      <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, borderRadius: 2 }}>
        <FormControl sx={{ minWidth: 0, width: '100%' }}>
          <FormLabel id="selection-label" sx={{ mb: 0.5 }}>
            {t('selectionLabel')}
          </FormLabel>
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
                sx={{ minHeight: 44, mx: 0 }}
                label={t(`selection.${item}`, { count: counts[item] })}
              />
            ))}
          </RadioGroup>
        </FormControl>
      </Paper>
      <Stack
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', sm: 'flex-start' } }}
      >
        {examState ? (
          <Stack
            spacing={1}
            sx={{ alignItems: 'flex-start' }}
            role="status"
            data-testid="exam-audio-status"
            data-status={examState}
          >
            <Typography variant="body2" color="text.secondary">
              {t(`examAudio.${examState}`)}
            </Typography>
            {examState === 'error' ? (
              <Button
                size="small"
                variant="outlined"
                data-testid="exam-audio-retry"
                onClick={() => void prepareAudio()}
              >
                {t('examAudioRetry')}
              </Button>
            ) : null}
          </Stack>
        ) : null}
        <Button
          variant="contained"
          size="large"
          ref={startRef}
          data-testid="start-attempt"
          sx={{ minHeight: 48, px: 4 }}
          disabled={isStartBlocked}
          onClick={onStart}
        >
          {isStarting ? t('starting') : t(isExam ? 'startExam' : 'start')}
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
            <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
              {t('guestTooShort')}
              <Button
                size="small"
                color="inherit"
                variant="outlined"
                data-testid="guest-replacement-open"
                onClick={() => setDialogOpen(true)}
              >
                {t('replaceOpen')}
              </Button>
            </Stack>
          </Alert>
        ) : null}
        {status === 'replacement-not-needed' ? (
          <Alert severity="info" data-testid="replacement-not-needed">
            {t('replaceNotNeeded')}
          </Alert>
        ) : null}
      </Stack>
      <GuestReplacementDialog
        open={isDialogOpen}
        isWorking={isReplacing || isStarting}
        problem={problem}
        onConfirm={() => void replace()}
        onCancel={() => setDialogOpen(false)}
        onExited={() => startRef.current?.focus()}
      />
    </Stack>
  );
};
