'use client';

import { useEffect, useRef, useState } from 'react';
import { displayAt, nextTickMs } from './exam-clock';
import type { ClockDisplay, ClockSync } from './exam-clock';

// A little after the second changes, so the frame never shows the old one.
const TICK_SLACK_MS = 20;

const localNow = (): number => performance.now();

interface ExamClockOptions {
  deadlineMs: number;
  // The latest reading of the server clock.
  sync: ClockSync;
  // Called once when the shown time reaches zero for this reading: the
  // owner asks the server, which alone closes the run.
  onZero: () => void;
}

// The remaining time of a timed run as a display only. It counts with the
// monotonic clock of the page between server readings, so changing the
// device clock, pausing the recording or switching the block never moves
// the deadline. Writes are judged by the database, never by this value.
export const useExamClock = ({
  deadlineMs,
  sync,
  onZero,
}: ExamClockOptions): ClockDisplay => {
  // The first frame is the time at the server reading itself: the same on
  // the server and in the browser, so hydration matches; the effect then
  // draws the current time.
  const [display, setDisplay] = useState(() =>
    displayAt(deadlineMs, sync, sync.localMs),
  );
  const onZeroRef = useRef(onZero);
  useEffect(() => {
    onZeroRef.current = onZero;
  }, [onZero]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hasReportedZero = false;
    const draw = () => {
      const next = displayAt(deadlineMs, sync, localNow());
      setDisplay(next);
      if (next.state === 'zero') {
        if (!hasReportedZero) {
          hasReportedZero = true;
          onZeroRef.current();
        }
        return;
      }
      timer = setTimeout(draw, nextTickMs(next.remainingMs) + TICK_SLACK_MS);
    };
    draw();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [deadlineMs, sync]);

  return display;
};
