'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { AttemptProgress } from '@b1k/domain';
import { requestSaveProgress } from './attempt-client';

// While the recording plays the position is saved at most this often.
const PROGRESS_INTERVAL_MS = 10_000;

export type SaveDecision = 'send' | 'defer' | 'skip';

interface SaveSituation {
  // The report changes the place the queue holds.
  isChanged: boolean;
  // The queue holds a place that no request has carried yet.
  isPending: boolean;
  isUrgent: boolean;
  // Milliseconds until the next save is allowed; zero or less: allowed now.
  waitMs: number;
}

// What one report does: send the place now, keep it for the timer, or leave
// it. A place already waiting in the queue is not "unchanged": an urgent
// report of it (a pause right after a time update) must still send it.
export const decideSave = ({
  isChanged,
  isPending,
  isUrgent,
  waitMs,
}: SaveSituation): SaveDecision => {
  if (!isChanged && !isPending) return 'skip';
  if (isUrgent || waitMs <= 0) return 'send';
  return 'defer';
};

interface AttemptProgressInput {
  attemptId: string;
  // The block the guest is on now; a report without a block belongs to it.
  block: AttemptProgress['block'];
  initialProgress: AttemptProgress | null;
  // The attempt is closed or its result is pending: no place is saved.
  isSettled: boolean;
}

export interface AttemptProgressQueue {
  readProgress: () => AttemptProgress | null;
  reportProgress: (patch: Partial<AttemptProgress>, isUrgent?: boolean) => void;
  stopProgress: () => void;
}

// The queue of the place of the guest: the block, the question and the
// recording position. It owns only this place and the delay of its saves;
// the answers belong to the answer store. Saves are sent one after another,
// so the last place wins. A failure is logged only: it never blocks choosing,
// saving or submitting, and the place is sent again with the next report.
export const useAttemptProgress = ({
  attemptId,
  block,
  initialProgress,
  isSettled,
}: AttemptProgressInput): AttemptProgressQueue => {
  const blockRef = useRef(block);
  const progressRef = useRef(initialProgress);
  const lastSavedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const isDone = useRef(isSettled);
  const isDirty = useRef(false);

  useEffect(() => {
    blockRef.current = block;
  }, [block]);

  const flushProgress = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const progress = progressRef.current;
    if (!progress || isDone.current || !isDirty.current) return;
    isDirty.current = false;
    lastSavedAt.current = Date.now();
    queue.current = queue.current.then(async () => {
      try {
        const result = await requestSaveProgress({ attemptId, progress });
        if (!result.ok) {
          isDirty.current = true;
          console.error({ progressError: result.error });
        }
      } catch (error) {
        isDirty.current = true;
        console.error({ error });
      }
    });
  }, [attemptId]);

  const reportProgress = useCallback(
    (patch: Partial<AttemptProgress>, isUrgent = true) => {
      if (isDone.current) return;
      const previous = progressRef.current;
      const next: AttemptProgress = {
        ...previous,
        ...patch,
        block: patch.block ?? blockRef.current,
      };
      if (previous?.hoeren || patch.hoeren) {
        next.hoeren = { ...previous?.hoeren, ...patch.hoeren };
      }
      if (previous?.lesen || patch.lesen) {
        next.lesen = { ...previous?.lesen, ...patch.lesen };
      }
      // Opening a screen reports the place it just read: nothing to write.
      const waitMs = lastSavedAt.current + PROGRESS_INTERVAL_MS - Date.now();
      const decision = decideSave({
        isChanged: JSON.stringify(next) !== JSON.stringify(previous),
        isPending: isDirty.current,
        isUrgent,
        waitMs,
      });
      if (decision === 'skip') return;
      isDirty.current = true;
      progressRef.current = next;
      if (decision === 'send') flushProgress();
      else if (timer.current === undefined) {
        timer.current = window.setTimeout(flushProgress, waitMs);
      }
    },
    [flushProgress],
  );

  const readProgress = useCallback(() => progressRef.current, []);

  // A closed attempt saves no place: a pending timer is dropped, a request
  // already in flight is refused by the server.
  const stopProgress = useCallback(() => {
    isDone.current = true;
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  useEffect(() => {
    const handleHidden = () => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    document.addEventListener('visibilitychange', handleHidden);
    window.addEventListener('pagehide', flushProgress);
    return () => {
      document.removeEventListener('visibilitychange', handleHidden);
      window.removeEventListener('pagehide', flushProgress);
      // A link inside the app unmounts the page without pagehide: the place
      // still waiting for the timer goes out now. A closed attempt sends none.
      flushProgress();
    };
  }, [flushProgress]);

  return { readProgress, reportProgress, stopProgress };
};
