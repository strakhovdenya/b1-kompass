'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerStatus } from '../audio/AudioPlayer';
import { requestAttemptAudio } from './attempt-client';
import type { PrepareFailure } from './attempt-client';
import { audioTargetSeconds } from './exam-audio-position';
import { serverNowAt, syncOf } from './exam-clock';
import type { ClockSync } from './exam-clock';
import type { ExamAudioController } from './ExamAudioSession';

// The recovery of the one recording of a full exam: where it belongs by the
// server's time, a new address when the old one stops working, and the
// guest's own Play when the browser refuses sound. The media element, its
// source and the system controls stay with the owner (ExamAudioSession);
// this hook only drives it. Nothing here touches the exam deadline: sound
// and network are not exam time.

// A new address is asked for after a failed read at most this many times
// in a row; the counter starts again when the recording plays.
const MAX_RENEWALS = 3;
const BACKOFF_MS: readonly number[] = [500, 1500, 4000];

// The server's answer that no retry can change: the phase is over, the
// session or attempt is not the guest's, or the request is wrong. Only a
// lost or failed request is worth repeating.
const RETRYABLE: readonly (PrepareFailure | 'network')[] = [
  'network',
  'unavailable',
];

// More apart than this, the recording is moved to the server's position.
const ALIGN_TOLERANCE_SECONDS = 2;

type Closure = 'phase-closed' | 'refused';

export interface ExamAudioSyncOptions {
  attemptId: string;
  trackId: string;
  // Hören is open by the server's phase, not by the address.
  isActive: boolean;
  // The server's start of Hören and the end of its permitted time.
  startedAtMs: number;
  deadlineMs: number | null;
  // The latest reading of the server clock.
  sync: ClockSync | null;
}

export interface ExamAudioSync {
  // Whether the recording may sound now: the phase is open and the server
  // has not closed the recording.
  isLive: boolean;
  // Whether the panel is drawn at all.
  isVisible: boolean;
  line: PlayerStatus;
  // False once the server refused for good: there is nothing to retry.
  canRetry: boolean;
  canUnlock: boolean;
  isBlocked: boolean;
  positionSeconds: number;
  durationSeconds: number;
  // Called inside the click: the browser allows sound only from the gesture.
  unlock: () => void;
  retry: () => void;
}

export const useExamAudioSync = (
  audio: ExamAudioController,
  options: ExamAudioSyncOptions,
): ExamAudioSync => {
  const { attemptId, trackId, isActive, startedAtMs, deadlineMs, sync } =
    options;
  const { element, source, status, isPlaying, isBlocked } = audio;
  const { load, dispose, setActive, play, seek, claim } = audio;
  const [closure, setClosure] = useState<Closure | null>(null);
  const [isFailed, setIsFailed] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [positionSeconds, setPositionSeconds] = useState(0);
  const [lapsedDeadline, setLapsedDeadline] = useState<number | null>(null);

  const isLapsed = deadlineMs !== null && lapsedDeadline === deadlineMs;
  const isLive = isActive && closure === null && !isLapsed;
  // A refusal for good is shown (without a retry); a closed phase is not an
  // error of the recording, the panel just goes away like any inactive one.
  const isVisible = isActive && closure !== 'phase-closed' && !isLapsed;

  const identity = useRef({ attemptId, trackId });
  const clock = useRef<ClockSync | null>(sync);
  const fetchAddress = useRef<() => Promise<void>>(async () => undefined);
  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renewals = useRef(0);
  // A request or a backoff timer is already on its way to a new address.
  const isRenewing = useRef(false);
  const shouldResume = useRef(false);

  useEffect(() => {
    identity.current = { attemptId, trackId };
  }, [attemptId, trackId]);

  useEffect(() => {
    if (sync) clock.current = sync;
  }, [sync]);

  // Renewed with every new address too: dispose() makes the element
  // inactive, the open Hören makes it active again. A closed recording
  // stays inactive, so neither a stale phase nor the media keys of the
  // system can start it.
  useEffect(() => {
    setActive(isLive);
  }, [isLive, setActive, source]);

  // Leaving the attempt (for example back to the choice) never leaves the
  // recording playing in the exam layout.
  useEffect(() => () => setActive(false), [setActive]);

  // The address prepared on the choice becomes this attempt's; one of
  // another attempt is let go.
  const owner = source ? source.attemptId : undefined;
  useEffect(() => {
    if (owner === null) claim(attemptId);
    else if (owner !== undefined && owner !== attemptId) dispose();
  }, [owner, attemptId, claim, dispose]);

  const cancel = useCallback(() => {
    requestId.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    isRenewing.current = false;
  }, []);

  const scheduleRenewal = useCallback(() => {
    if (renewals.current >= MAX_RENEWALS) {
      isRenewing.current = false;
      setIsFailed(true);
      return;
    }
    const delayMs = BACKOFF_MS[renewals.current] ?? 0;
    renewals.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void fetchAddress.current(), delayMs);
  }, []);

  // The address comes from its own HTTP request, never from the queue of
  // saves or Server Actions. The server decides again, by the phase, whether
  // one may be issued.
  const requestAddress = useCallback(async () => {
    requestId.current += 1;
    isRenewing.current = true;
    const id = requestId.current;
    const sentMs = performance.now();
    const current = identity.current;
    const result = await requestAttemptAudio(
      current.attemptId,
      current.trackId,
    );
    if (id !== requestId.current) return;
    if (result.ok) {
      const { url, expiresAt, serverNow } = result.audio;
      clock.current ??= syncOf(
        Date.parse(serverNow),
        sentMs,
        performance.now(),
      );
      isRenewing.current = false;
      load(url, expiresAt, serverNow, current.attemptId);
      return;
    }
    if (RETRYABLE.includes(result.error)) {
      scheduleRenewal();
      return;
    }
    shouldResume.current = false;
    isRenewing.current = false;
    setClosure(result.error === 'phase-closed' ? 'phase-closed' : 'refused');
  }, [load, scheduleRenewal]);

  useEffect(() => {
    fetchAddress.current = requestAddress;
  }, [requestAddress]);

  useEffect(() => cancel, [cancel]);

  const needsAddress = isLive && source === null && !isFailed;
  useEffect(() => {
    if (!needsAddress) return undefined;
    renewals.current = 0;
    void fetchAddress.current();
    return cancel;
  }, [needsAddress, retryCount, cancel]);

  // The read of the address failed (403 of an expired or revoked address, a
  // lost connection, a broken file): a new one is asked for at once,
  // and the recording continues where the server's time puts it.
  useEffect(() => {
    if (status !== 'error' || !source || !isLive || isFailed) return;
    if (isRenewing.current) return;
    if (renewals.current >= MAX_RENEWALS) {
      setIsFailed(true);
      return;
    }
    renewals.current += 1;
    // The recording belongs to the exam time: on the new address it tries
    // to sound again, and the browser says whether it may.
    shouldResume.current = true;
    void fetchAddress.current();
  }, [status, source, isLive, isFailed]);

  const targetNow = useCallback((): number | null => {
    if (!clock.current) return null;
    return audioTargetSeconds({
      mode: 'exam',
      serverNowMs: serverNowAt(clock.current, performance.now()),
      hoerenStartedAtMs: startedAtMs,
      durationSeconds: element?.duration ?? Number.NaN,
    });
  }, [element, startedAtMs]);

  const isPastEnd = useCallback(
    (target: number): boolean =>
      element !== null &&
      Number.isFinite(element.duration) &&
      target >= element.duration,
    [element],
  );

  const align = useCallback(() => {
    if (!element || !isLive || element.paused) return;
    const target = targetNow();
    if (target === null) return;
    if (isPastEnd(target)) {
      element.pause();
      return;
    }
    if (Math.abs(element.currentTime - target) > ALIGN_TOLERANCE_SECONDS)
      seek(target);
  }, [element, isLive, targetNow, isPastEnd, seek]);

  // A recording that is ready is put on the server's timeline. One that was
  // playing before its address was renewed tries to sound again: without a
  // click the browser may refuse, and that refusal (observed by the owner)
  // is what explains the explicit Play. After a reload the recording stays
  // silent until the guest presses Play.
  useEffect(() => {
    if (status !== 'ready' || !element || !source || !isLive) return;
    const target = targetNow();
    if (target === null) return;
    if (isPastEnd(target)) {
      shouldResume.current = false;
      element.pause();
      return;
    }
    if (shouldResume.current) {
      shouldResume.current = false;
      seek(target);
      play();
      return;
    }
    align();
  }, [
    status,
    element,
    source,
    isLive,
    targetNow,
    isPastEnd,
    seek,
    play,
    align,
  ]);

  useEffect(() => {
    if (!element) return undefined;
    const onTime = () => setPositionSeconds(element.currentTime);
    // The budget of renewals starts again once the recording really plays.
    const onPlaying = () => {
      renewals.current = 0;
      align();
    };
    element.addEventListener('playing', onPlaying);
    element.addEventListener('timeupdate', onTime);
    return () => {
      element.removeEventListener('playing', onPlaying);
      element.removeEventListener('timeupdate', onTime);
    };
  }, [element, align]);

  // The end of Hören by the server's time silences the recording even when
  // the news of the phase has not arrived yet.
  useEffect(() => {
    if (deadlineMs === null || !clock.current) return undefined;
    const remainingMs =
      deadlineMs - serverNowAt(clock.current, performance.now());
    const lapse = setTimeout(
      () => setLapsedDeadline(deadlineMs),
      Math.max(0, remainingMs),
    );
    return () => clearTimeout(lapse);
  }, [deadlineMs, sync, source]);

  const unlock = () => {
    const isExpired =
      source !== null && source.expiresAtLocalMs <= performance.now();
    if (isExpired || status === 'error') {
      if (isRenewing.current) return;
      shouldResume.current = true;
      renewals.current = 0;
      void fetchAddress.current();
      return;
    }
    const target = targetNow();
    if (target !== null) seek(target);
    play();
  };

  const retry = () => {
    cancel();
    renewals.current = 0;
    shouldResume.current = false;
    setIsFailed(false);
    setRetryCount((count) => count + 1);
    dispose();
  };

  let line: PlayerStatus = 'loading';
  if (closure !== null || isFailed) line = 'error';
  else if (status === 'ready') line = 'ready';

  return {
    isLive,
    isVisible,
    line,
    canRetry: closure === null,
    canUnlock: isLive && status === 'ready' && !isPlaying,
    isBlocked,
    positionSeconds,
    durationSeconds: element?.duration ?? 0,
    unlock,
    retry,
  };
};
