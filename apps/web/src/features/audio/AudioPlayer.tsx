'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

// Contract of the audio resolution the page passes in: a playable address of
// one track or a reason. The player does not know where the bytes live.
export interface PlayableAudio {
  url: string;
  contentType: string;
  expiresAt: string;
}

export type AudioAccess =
  { ok: true; audio: PlayableAudio } | { ok: false; error: string };

export type PlayerStatus = 'loading' | 'ready' | 'error';

interface AudioPlayerProps {
  resolveAudio: () => Promise<AudioAccess>;
  // The stored place of a returning guest. The browser does not allow sound
  // without a click, so the recording is only moved there, never started.
  initialPosition?: number;
  // The place after the guest paused or sought (urgent), or while playing.
  onPosition?: (seconds: number, isUrgent: boolean) => void;
  // Whether the recording belongs to the block on screen. The shell decides;
  // the player knows no modes or timers. An inactive player is hidden and
  // paused, refuses every new play (including the media keys of the system),
  // and keeps its element, source and place.
  isActive?: boolean;
}

// Readable by assistive technology, invisible on screen.
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

const SKIP_BACK_SECONDS = 5;

export const formatTime = (seconds: number): string => {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
};

const requestAudio = async (
  resolveAudio: () => Promise<AudioAccess>,
): Promise<AudioAccess> => {
  try {
    return await resolveAudio();
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};

// A pending play() that pause() or a new source interrupts, or a resume the
// browser does not allow without a click, is not a broken recording.
const isHarmlessPlayError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === 'AbortError' || error.name === 'NotAllowedError');

// Each browser has its own player: play, pause and position belong to this
// element only. It lives outside the question navigation, so moving between
// questions neither recreates nor restarts it.
export const AudioPlayer = ({
  resolveAudio,
  initialPosition = 0,
  onPosition,
  isActive = true,
}: AudioPlayerProps) => {
  const t = useTranslations('audio');
  const element = useRef<HTMLAudioElement>(null);
  const resumeAt = useRef<number | null>(
    initialPosition > 0 ? initialPosition : null,
  );
  const shouldResume = useRef(false);
  const hasRetried = useRef(false);
  const isActiveRef = useRef(isActive);
  const [audio, setAudio] = useState<PlayableAudio | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('loading');
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // Leaving the block pauses the recording where it is; the pause is
  // reported through onPause like any other.
  // A layout effect: the ref follows the prop before the guest can tap Play.
  useLayoutEffect(() => {
    isActiveRef.current = isActive;
    if (!isActive) element.current?.pause();
  }, [isActive]);

  const apply = useCallback((access: AudioAccess) => {
    if (access.ok) {
      setAudio(access.audio);
      setStatus('ready');
    } else {
      setStatus('error');
    }
  }, []);

  // A server re-render (for example a language switch) passes a new bound
  // action; it must not reload the recording and restart playback.
  const resolveRef = useRef(resolveAudio);
  useEffect(() => {
    resolveRef.current = resolveAudio;
  }, [resolveAudio]);

  useEffect(() => {
    let isActive = true;
    void requestAudio(resolveRef.current).then((access) => {
      if (isActive) apply(access);
    });
    return () => {
      isActive = false;
    };
  }, [apply]);

  // A fresh address can equal the previous one (signed in the same second);
  // load() makes the element try again in any case.
  useEffect(() => {
    if (audio) element.current?.load();
  }, [audio]);

  const reload = (isResuming: boolean) => {
    // Before the first load there is no position yet: the stored one stays.
    const current = element.current?.currentTime ?? 0;
    resumeAt.current = current > 0 ? current : resumeAt.current;
    shouldResume.current = isResuming;
    setStatus('loading');
    void requestAudio(resolveRef.current).then(apply);
  };

  const handlePlayError = (error: unknown) => {
    if (isHarmlessPlayError(error)) return;
    console.error({ error });
    setStatus('error');
  };

  // The signed address may have expired. One fresh address is requested
  // without asking the guest, whatever the local clock says; a second
  // failure in a row is shown.
  const handleError = () => {
    const wasPlaying = isPlaying && isActiveRef.current;
    setIsPlaying(false);
    if (hasRetried.current) {
      setStatus('error');
      return;
    }
    hasRetried.current = true;
    reload(wasPlaying);
  };

  const retry = () => {
    hasRetried.current = false;
    reload(false);
  };

  const handleLoadedMetadata = () => {
    const media = element.current;
    if (!media) return;
    setDuration(media.duration);
    if (resumeAt.current !== null) {
      // A stored place beyond the recording is kept inside it.
      const target = Number.isFinite(media.duration)
        ? Math.min(resumeAt.current, media.duration)
        : resumeAt.current;
      media.currentTime = target;
      setPosition(target);
      resumeAt.current = null;
    }
    if (shouldResume.current) {
      shouldResume.current = false;
      if (isActiveRef.current) media.play().catch(handlePlayError);
    }
  };

  const togglePlay = () => {
    const media = element.current;
    if (!media) return;
    if (media.paused) {
      if (isActiveRef.current) media.play().catch(handlePlayError);
    } else {
      media.pause();
    }
  };

  const reportPosition = (isUrgent: boolean) => {
    const media = element.current;
    if (!media || !onPosition) return;
    const seconds = Math.round(media.currentTime * 10) / 10;
    if (Number.isFinite(seconds) && seconds >= 0) onPosition(seconds, isUrgent);
  };

  const seekTo = (seconds: number) => {
    const media = element.current;
    if (!media) return;
    media.currentTime = seconds;
    setPosition(seconds);
  };

  const canPlay = status === 'ready' && audio !== null;

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-label={t('label')}
      hidden={!isActive}
      data-testid="audio-player"
      sx={{ px: { xs: 1.5, sm: 2 }, py: { xs: 0.5, sm: 1 } }}
    >
      <audio
        ref={element}
        src={audio?.url}
        preload="metadata"
        data-testid="audio-element"
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={() => setDuration(element.current?.duration ?? 0)}
        onTimeUpdate={() => {
          setPosition(element.current?.currentTime ?? 0);
          if (!element.current?.paused) reportPosition(false);
        }}
        onSeeked={() => reportPosition(true)}
        onPlay={() => {
          // Media keys or a headset can start a hidden element.
          if (!isActiveRef.current) {
            element.current?.pause();
            return;
          }
          setIsPlaying(true);
        }}
        onPlaying={() => {
          if (!isActiveRef.current) {
            element.current?.pause();
            return;
          }
          hasRetried.current = false;
        }}
        onPause={() => {
          setIsPlaying(false);
          if (!element.current?.ended) reportPosition(true);
        }}
        onEnded={() => {
          setIsPlaying(false);
          onPosition?.(0, true);
        }}
        onError={audio ? handleError : undefined}
      />
      <Stack
        direction="row"
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}
      >
        <Button
          variant="contained"
          onClick={togglePlay}
          disabled={!canPlay}
          data-testid="audio-toggle"
          data-playing={isPlaying}
          sx={{ minWidth: 104, minHeight: 44 }}
        >
          {isPlaying ? `❚❚ ${t('pause')}` : `▶ ${t('play')}`}
        </Button>
        <Button
          variant="text"
          onClick={() => seekTo(Math.max(0, position - SKIP_BACK_SECONDS))}
          disabled={!canPlay}
          data-testid="audio-back"
          sx={{ minHeight: 44 }}
        >
          {t('back', { seconds: SKIP_BACK_SECONDS })}
        </Button>
        <Typography
          variant="body2"
          color="text.secondary"
          data-testid="audio-time"
          sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums' }}
        >
          {formatTime(position)} / {formatTime(duration)}
        </Typography>
      </Stack>
      <Slider
        aria-label={t('seek')}
        value={Math.min(position, duration || 0)}
        min={0}
        max={duration || 1}
        step={1}
        size="small"
        disabled={!canPlay || !duration}
        onChange={(_event, value) => seekTo(Number(value))}
        getAriaValueText={formatTime}
        sx={{ display: 'block', py: 1.25, mt: -0.25 }}
      />
      <AudioStatusLine status={status} onRetry={retry} />
    </Paper>
  );
};

interface AudioStatusLineProps {
  status: PlayerStatus;
  onRetry: () => void;
  // The announcement of a ready recording; the free one by default.
  readyLabel?: string;
}

// The one status line of a recording: loading and error stay visible, ready
// is announced. Shared by the free player and the full exam.
export const AudioStatusLine = ({
  status,
  onRetry,
  readyLabel,
}: AudioStatusLineProps) => {
  const t = useTranslations('audio');
  if (status === 'error') {
    return (
      <Alert
        severity="error"
        role="alert"
        data-testid="audio-status"
        data-status={status}
        action={
          <Button color="inherit" size="small" onClick={onRetry}>
            {t('retry')}
          </Button>
        }
      >
        {t('error')}
      </Alert>
    );
  }
  // Ready is announced but not drawn: the player is its own proof. Loading
  // stays visible.
  return (
    <Typography
      role="status"
      aria-live="polite"
      variant="body2"
      color="text.secondary"
      data-testid="audio-status"
      data-status={status}
      sx={status === 'ready' ? VISUALLY_HIDDEN : { pb: 0.5 }}
    >
      {status === 'loading' ? t('loading') : (readyLabel ?? t('ready'))}
    </Typography>
  );
};
