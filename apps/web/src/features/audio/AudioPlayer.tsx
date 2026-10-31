'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  | { ok: true; audio: PlayableAudio }
  | { ok: false; error: string };

type PlayerStatus = 'loading' | 'ready' | 'error';

interface AudioPlayerProps {
  resolveAudio: () => Promise<AudioAccess>;
}

const SKIP_BACK_SECONDS = 5;

const formatTime = (seconds: number): string => {
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
export const AudioPlayer = ({ resolveAudio }: AudioPlayerProps) => {
  const t = useTranslations('audio');
  const element = useRef<HTMLAudioElement>(null);
  const resumeAt = useRef<number | null>(null);
  const shouldResume = useRef(false);
  const hasRetried = useRef(false);
  const [audio, setAudio] = useState<PlayableAudio | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('loading');
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

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
    resumeAt.current = element.current?.currentTime ?? null;
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
    const wasPlaying = isPlaying;
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
      media.currentTime = resumeAt.current;
      resumeAt.current = null;
    }
    if (shouldResume.current) {
      shouldResume.current = false;
      media.play().catch(handlePlayError);
    }
  };

  const togglePlay = () => {
    const media = element.current;
    if (!media) return;
    if (media.paused) {
      media.play().catch(handlePlayError);
    } else {
      media.pause();
    }
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
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Stack spacing={1.5}>
        <Typography component="h2" variant="subtitle1">
          {t('label')}
        </Typography>
        <audio
          ref={element}
          src={audio?.url}
          preload="metadata"
          data-testid="audio-element"
          onLoadedMetadata={handleLoadedMetadata}
          onDurationChange={() => setDuration(element.current?.duration ?? 0)}
          onTimeUpdate={() => setPosition(element.current?.currentTime ?? 0)}
          onPlay={() => setIsPlaying(true)}
          onPlaying={() => {
            hasRetried.current = false;
          }}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={audio ? handleError : undefined}
        />
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button
            variant="contained"
            onClick={togglePlay}
            disabled={!canPlay}
            sx={{ minWidth: 104 }}
          >
            {isPlaying ? `❚❚ ${t('pause')}` : `▶ ${t('play')}`}
          </Button>
          <Button
            variant="text"
            onClick={() => seekTo(Math.max(0, position - SKIP_BACK_SECONDS))}
            disabled={!canPlay}
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
          disabled={!canPlay || !duration}
          onChange={(_event, value) => seekTo(Number(value))}
          getAriaValueText={formatTime}
        />
        <AudioStatusLine status={status} onRetry={retry} />
      </Stack>
    </Paper>
  );
};

interface AudioStatusLineProps {
  status: PlayerStatus;
  onRetry: () => void;
}

const AudioStatusLine = ({ status, onRetry }: AudioStatusLineProps) => {
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
  return (
    <Typography
      role="status"
      aria-live="polite"
      variant="body2"
      color="text.secondary"
      data-testid="audio-status"
      data-status={status}
    >
      {status === 'loading' ? t('loading') : t('ready')}
    </Typography>
  );
};
