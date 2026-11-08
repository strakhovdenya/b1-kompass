'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { AudioStatusLine, formatTime } from '../audio/AudioPlayer';
import type { ClockSync } from './exam-clock';
import { useExamAudioSync } from './useExamAudio';

// The one HTML audio element of a full exam. It lives in the layout of the
// exam (/practice/[examSlug]), above the choice and the attempt, so the
// recording prepared on the choice keeps playing in the same element when
// the attempt opens: there is never a second copy and never a second
// autoplay. The owner knows no modes, phases or timers: the choice and the
// attempt shell decide; an inactive element refuses every play, including
// the media keys of the system. The free training keeps its own AudioPlayer.

export type ExamAudioStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ExamAudioSource {
  url: string;
  // The end of the address on the monotonic clock of the page, so the
  // device clock cannot make a stale address look fresh.
  expiresAtLocalMs: number;
  // The attempt the address was issued for; null for a preparation.
  attemptId: string | null;
}

export interface ExamAudioController {
  readonly element: HTMLAudioElement | null;
  readonly status: ExamAudioStatus;
  readonly source: ExamAudioSource | null;
  readonly isPlaying: boolean;
  // The browser refused sound without a click (NotAllowedError, observed on
  // a real play()); cleared when the recording sounds or is let go.
  readonly isBlocked: boolean;
  // A new address: the element loads it without playing. serverNow is the
  // server moment the expiry was issued at.
  load: (
    url: string,
    expiresAt: string,
    serverNow: string,
    attemptId?: string | null,
  ) => void;
  // Called synchronously inside the click, before any await: the browser
  // allows sound only from the gesture itself.
  play: () => void;
  // Pauses and rewinds: a refused start leaves no sound behind.
  stop: () => void;
  seek: (seconds: number) => void;
  // Forgets the address: before a guest replacement or another attempt.
  dispose: () => void;
  setActive: (isActive: boolean) => void;
  // The attempt takes over the prepared address: it is no longer a
  // preparation a later exam could start on.
  claim: (attemptId: string) => void;
}

const noop = () => undefined;

const ExamAudioContext = createContext<ExamAudioController>({
  element: null,
  status: 'idle',
  source: null,
  isPlaying: false,
  isBlocked: false,
  load: noop,
  play: noop,
  stop: noop,
  seek: noop,
  dispose: noop,
  setActive: noop,
  claim: noop,
});

export const useExamAudio = (): ExamAudioController =>
  useContext(ExamAudioContext);

const isDomError = (error: unknown, name: string): boolean =>
  error instanceof DOMException && error.name === name;

// The controls the system offers for a full exam: none move the recording.
const BLOCKED_ACTIONS: readonly MediaSessionAction[] = [
  'pause',
  'seekbackward',
  'seekforward',
  'seekto',
  'previoustrack',
  'nexttrack',
];

const setMediaHandler = (
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) => {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // An action this browser does not know has no handler to replace.
  }
};

interface ExamAudioSessionProps {
  children: ReactNode;
}

export const ExamAudioSession = ({ children }: ExamAudioSessionProps) => {
  const ref = useRef<HTMLAudioElement>(null);
  const isActiveRef = useRef(false);
  const [element, setElement] = useState<HTMLAudioElement | null>(null);
  const [source, setSource] = useState<ExamAudioSource | null>(null);
  const [status, setStatus] = useState<ExamAudioStatus>('idle');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);

  useEffect(() => {
    setElement(ref.current);
  }, []);

  // Leaving the exam, or opening another one, lets the recording go: a
  // removed element is paused by the browser's own rule, but it would keep
  // its signed address, and some browsers keep sound of a detached element.
  // Nothing is left to resume it from the system controls.
  useEffect(() => {
    const media = ref.current;
    return () => {
      isActiveRef.current = false;
      if (!media) return;
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, []);

  const pause = useCallback(() => {
    ref.current?.pause();
  }, []);

  const setActive = useCallback(
    (isActive: boolean) => {
      isActiveRef.current = isActive;
      if (!isActive) pause();
    },
    [pause],
  );

  const load = useCallback(
    (
      url: string,
      expiresAt: string,
      serverNow: string,
      attemptId: string | null = null,
    ) => {
      const media = ref.current;
      if (!media) return;
      const lifeMs = Date.parse(expiresAt) - Date.parse(serverNow);
      setSource({
        url,
        expiresAtLocalMs: performance.now() + lifeMs,
        attemptId,
      });
      setStatus('loading');
      // Loading a new address stops the element without a pause event, and
      // an earlier refusal says nothing about the sound that follows.
      setIsPlaying(false);
      setIsBlocked(false);
      media.src = url;
      media.load();
    },
    [],
  );

  const play = useCallback(() => {
    const media = ref.current;
    if (!media || !isActiveRef.current) return;
    media.play().catch((error: unknown) => {
      // A play() that pause() or a new source interrupts is not a broken
      // recording.
      if (isDomError(error, 'AbortError')) return;
      // The browser wants a click first: the guest is offered Play.
      if (isDomError(error, 'NotAllowedError')) {
        setIsBlocked(true);
        return;
      }
      console.error({ error });
      setStatus('error');
    });
  }, []);

  const stop = useCallback(() => {
    const media = ref.current;
    if (!media) return;
    media.pause();
    if (media.readyState > 0) media.currentTime = 0;
  }, []);

  const seek = useCallback((seconds: number) => {
    const media = ref.current;
    if (!media || !Number.isFinite(seconds)) return;
    media.currentTime = Math.max(0, seconds);
  }, []);

  const claim = useCallback((attemptId: string) => {
    setSource((current) =>
      current && current.attemptId === null
        ? { ...current, attemptId }
        : current,
    );
  }, []);

  const dispose = useCallback(() => {
    const media = ref.current;
    isActiveRef.current = false;
    setSource(null);
    setStatus('idle');
    setIsPlaying(false);
    setIsBlocked(false);
    if (!media) return;
    media.pause();
    media.removeAttribute('src');
    media.load();
  }, []);

  // The system controls of a full exam: play only while active, no pause,
  // no seek, no other track. Restored when the exam layout is left.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return undefined;
    setMediaHandler('play', play);
    for (const action of BLOCKED_ACTIONS) setMediaHandler(action, noop);
    return () => {
      setMediaHandler('play', null);
      for (const action of BLOCKED_ACTIONS) setMediaHandler(action, null);
    };
  }, [play]);

  const controller = useMemo(
    () => ({
      element,
      status,
      source,
      isPlaying,
      isBlocked,
      load,
      play,
      stop,
      seek,
      dispose,
      setActive,
      claim,
    }),
    [
      element,
      status,
      source,
      isPlaying,
      isBlocked,
      load,
      play,
      stop,
      seek,
      dispose,
      setActive,
      claim,
    ],
  );

  const onReady = () => {
    if (ref.current?.getAttribute('src')) setStatus('ready');
  };

  return (
    <ExamAudioContext.Provider value={controller}>
      {/* Not a player: the attempt shows its state; it has no controls. */}
      <audio
        ref={ref}
        preload="auto"
        hidden
        data-testid="exam-audio-element"
        onCanPlay={onReady}
        onCanPlayThrough={onReady}
        onPlay={() => {
          // Media keys or a headset can start an inactive element.
          if (!isActiveRef.current) {
            pause();
            return;
          }
          setIsPlaying(true);
        }}
        onPlaying={() => {
          if (!isActiveRef.current) {
            pause();
            return;
          }
          setIsBlocked(false);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onError={() => {
          if (ref.current?.getAttribute('src')) setStatus('error');
        }}
      />
      {children}
    </ExamAudioContext.Provider>
  );
};

interface ExamAudioPanelProps {
  attemptId: string;
  trackId: string;
  // Hören of this exam is open by the server's phase, not by the address.
  isActive: boolean;
  // The server's start of Hören and the end of its permitted time, with the
  // latest reading of its clock.
  startedAtMs: number;
  deadlineMs: number | null;
  sync: ClockSync | null;
}

// The state of the one recording inside the attempt of a full exam. It has
// no pause, seek, back or speed: the recording runs with the exam time.
// Play is offered only to unlock sound after a reload, and the recording is
// then moved to the server's position. Without a prepared address, or with
// one of another attempt, it asks the server for its own, which it issues
// only while Hören is open; a failed address is renewed by useExamAudioSync.
export const ExamAudioPanel = ({
  attemptId,
  trackId,
  isActive,
  startedAtMs,
  deadlineMs,
  sync,
}: ExamAudioPanelProps) => {
  const t = useTranslations('audio');
  const audio = useExamAudio();
  const recording = useExamAudioSync(audio, {
    attemptId,
    trackId,
    isActive,
    startedAtMs,
    deadlineMs,
    sync,
  });
  const { isVisible, line, canUnlock, isBlocked } = recording;

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-label={t('label')}
      hidden={!isVisible}
      data-testid="audio-player"
      data-mode="exam"
      data-playing={audio.isPlaying}
      data-blocked={isBlocked}
      sx={{ px: { xs: 1.5, sm: 2 }, py: { xs: 0.5, sm: 1 } }}
    >
      <Stack
        direction="row"
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}
      >
        {canUnlock ? (
          <Button
            variant="contained"
            onClick={recording.unlock}
            data-testid="audio-unlock"
            sx={{ minHeight: 44 }}
          >
            {`▶ ${t('examPlay')}`}
          </Button>
        ) : null}
        <Typography
          variant="body2"
          color="text.secondary"
          data-testid="audio-time"
          sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums' }}
        >
          {formatTime(recording.positionSeconds)} /{' '}
          {formatTime(recording.durationSeconds)}
        </Typography>
      </Stack>
      {canUnlock && isBlocked ? (
        <Typography
          role="status"
          variant="body2"
          color="text.secondary"
          data-testid="audio-blocked"
          sx={{ pb: 0.5 }}
        >
          {t('examBlocked')}
        </Typography>
      ) : null}
      <AudioStatusLine
        status={line}
        onRetry={recording.canRetry ? recording.retry : undefined}
        readyLabel={t('examReady')}
      />
    </Paper>
  );
};
