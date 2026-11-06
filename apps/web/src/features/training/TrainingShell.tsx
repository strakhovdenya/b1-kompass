'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import type {
  AttemptMode,
  AttemptPhase,
  AttemptProgress,
  AttemptReview,
  ExamQuestion,
  Selections,
} from '@b1k/domain';
import { AudioPlayer } from '../audio/AudioPlayer';
import { DictionaryBoundary } from '../dictionary/DictionaryBoundary';
import type { AudioAccess } from '../audio/AudioPlayer';
import { AttemptReviewView } from '../results/AttemptReviewView';
import type { ReviewBlock } from '../results/AttemptReviewView';
import { AttemptSubmissionControls } from './AttemptSubmissionControls';
import { AttemptTimer } from './AttemptTimer';
import {
  attemptLesenPath,
  attemptPath,
  choicePath,
  requestBeginLesen,
  requestSaveAnswer,
} from './attempt-client';
import type {
  AttemptStatusView,
  AttemptSummary,
  TimedClock,
} from './attempt-client';
import { useAnswerStore } from './answers';
import { syncOf } from './exam-clock';
import type { ClockSync } from './exam-clock';
import { ExamAudioPanel } from './ExamAudioSession';
import { TrainingContext } from './TrainingContext';
import type { TrainingState } from './TrainingContext';
import { TransitionScreen } from './TransitionScreen';
import type { BeginStatus } from './TransitionScreen';
import { useAttemptProgress } from './useAttemptProgress';
import { confirmationOf, useAttemptSubmission } from './useAttemptSubmission';
import type { SubmissionPhase } from './useAttemptSubmission';

export interface ResolveAudioInput {
  attemptId: string;
  trackId: string;
}

const BLOCK_PATHS: readonly {
  block: ReviewBlock;
  pathOf: (examSlug: string, attemptId: string) => string;
}[] = [
  { block: 'hoeren', pathOf: attemptPath },
  { block: 'lesen', pathOf: attemptLesenPath },
];

const ZERO_RETRY_MS = 3000;

// The run is closed for this page: the clock is no longer shown.
const CLOSED_PHASES: readonly SubmissionPhase[] = [
  'accepted',
  'completed',
  'expired',
];

interface TrainingShellProps {
  examSlug: string;
  attemptId: string;
  questions: readonly ExamQuestion[];
  trackIds: readonly string[];
  initialSelections: Selections;
  initialRevisions: Readonly<Record<string, number>>;
  initialReview: AttemptReview | null;
  initialProgress: AttemptProgress | null;
  // The submission is accepted and its result is not stored yet.
  isResultPending: boolean;
  phaseRevision: number;
  // The deadline of an open timed run as the server read it; null for a
  // free training and a closed run.
  timer?: TimedClock | null;
  // The mode of the run and its trusted phase as the server read it.
  mode?: AttemptMode;
  phase?: AttemptPhase | null;
  // The server's numbers of the whole assignment, hidden Lesen included.
  summary?: AttemptSummary | null;
  // The server's start of Hören of a full exam: the position of its one
  // recording.
  examStartedAtMs?: number | null;
  resolveAudio: (input: ResolveAudioInput) => Promise<AudioAccess>;
  children: ReactNode;
}

const NO_ANSWERS: readonly never[] = [];

// The frame of one attempt around the Hören and Lesen pages. It stays mounted
// when the guest moves between the blocks, so the recording keeps playing and
// the answers stay known: the confirmed ones and the choices the server has
// not confirmed yet, whichever block they belong to. It connects the one
// answer store with the submission: the final answers include the choices
// still in flight, the server computes the result, the shell only shows it.
export const TrainingShell = ({
  examSlug,
  attemptId,
  questions,
  trackIds,
  initialSelections,
  initialRevisions,
  initialReview,
  initialProgress,
  isResultPending,
  phaseRevision,
  timer = null,
  mode = timer ? 'timed-block' : 'training',
  phase = null,
  summary = null,
  examStartedAtMs = null,
  resolveAudio,
  children,
}: TrainingShellProps) => {
  const t = useTranslations('training');
  const pathname = usePathname();
  const router = useRouter();
  const {
    selections,
    pending,
    choose,
    retry,
    lock,
    unlock,
    readFinalAnswers,
    readPending,
    settle,
    expire,
  } = useAnswerStore({
    attemptId,
    initialSelections,
    initialRevisions,
    saveAnswer: requestSaveAnswer,
    isSettled: initialReview !== null || isResultPending,
  });
  const store = useMemo(
    () => ({ lock, unlock, readFinalAnswers, readPending, settle, expire }),
    [lock, unlock, readFinalAnswers, readPending, settle, expire],
  );
  // The review arrives with the page once the result is stored.
  const review = initialReview;

  const lesenPath = attemptLesenPath(examSlug, attemptId);
  const current: ReviewBlock = pathname.startsWith(lesenPath)
    ? 'lesen'
    : 'hoeren';
  const { readProgress, reportProgress, stopProgress } = useAttemptProgress({
    attemptId,
    block: current,
    initialProgress,
    isSettled: initialReview !== null || isResultPending,
  });

  // The latest reading of the server clock of a timed run. The page brings
  // the first one; every status renews it.
  const [sync, setSync] = useState<ClockSync | null>(() =>
    timer
      ? syncOf(timer.serverNowMs, performance.now(), performance.now())
      : null,
  );
  const [isAtZero, setIsAtZero] = useState(false);
  const onSync = useCallback((next: ClockSync) => {
    setSync(next);
    setIsAtZero(false);
  }, []);

  // What the server said last: the phase, the clock of the phase and the
  // numbers of the whole assignment. The page brings the first reading;
  // every status renews it, a later page (after refresh) as well.
  const [trusted, setTrusted] = useState({ phase, timer, summary });
  const [pageReading, setPageReading] = useState({ phase, timer, summary });
  const isNewPage =
    pageReading.phase !== phase ||
    pageReading.timer !== timer ||
    pageReading.summary !== summary;
  if (isNewPage) {
    setPageReading({ phase, timer, summary });
    setTrusted({ phase, timer, summary });
  }
  const onStatus = useCallback((view: AttemptStatusView) => {
    setTrusted({
      phase: view.state.phase,
      timer: view.timer,
      summary: view.summary,
    });
  }, []);

  const submission = useAttemptSubmission({
    attemptId,
    examSlug,
    questions,
    phaseRevision,
    isResultPending,
    store,
    onClosed: stopProgress,
    onSync,
    summary,
    onStatus,
  });
  const { reconcile } = submission;
  const reconcileRef = useRef(reconcile);
  useEffect(() => {
    reconcileRef.current = reconcile;
  }, [reconcile]);
  const isTimed = timer !== null;

  // A timed run follows the server, not the page: on opening, on focus, on
  // return to the tab, on reconnection and at zero the state is read again
  // on its own fetch, beside any save in flight. Only the server closes the
  // run; a page that was away never extends it.
  useEffect(() => {
    if (!isTimed) return undefined;
    const refresh = () => void reconcileRef.current();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isTimed]);

  // At zero the server is asked until it answers; a lost answer is retried.
  useEffect(() => {
    if (!isAtZero) return undefined;
    const retry = setInterval(() => void reconcileRef.current(), ZERO_RETRY_MS);
    return () => clearInterval(retry);
  }, [isAtZero]);

  // A save the server refused may mean that its deadline has passed before
  // the page's clock shows it: the server state is read at once.
  const hasRefused = Object.values(pending).some(
    (entry) => entry.status === 'refused',
  );
  useEffect(() => {
    if (isTimed && hasRefused) void reconcileRef.current();
  }, [isTimed, hasRefused]);

  const onZero = useCallback(() => {
    setIsAtZero(true);
    void reconcileRef.current();
  }, []);

  // A full exam follows the trusted phase, not the address: when the server
  // moved it (Hören closed, Lesen started), the layout and the page are read
  // again, so the material of the new phase arrives and nothing of a phase
  // not opened was ever sent. The shell stays mounted, with its confirmed
  // and pending answers; the Hören page sends a Lesen phase to /lesen.
  const isExam = mode === 'exam';
  const isPhaseBehind =
    isExam && trusted.phase !== null && trusted.phase !== phase;
  useEffect(() => {
    if (isPhaseBehind) router.refresh();
  }, [isPhaseBehind, trusted.phase, pathname, router]);

  // The early start of Lesen. Its answer carries the status after it; a
  // failure leaves the transition, which ends by itself.
  const [beginStatus, setBeginStatus] = useState<BeginStatus>('idle');
  const { observe } = submission;
  const beginLesen = useCallback(async () => {
    setBeginStatus('beginning');
    const sentMs = performance.now();
    const result = await requestBeginLesen(attemptId);
    if (!result.ok) {
      setBeginStatus('failed');
      return;
    }
    const { status } = result.result;
    onSync(syncOf(Date.parse(status.serverNow), sentMs, performance.now()));
    observe(status);
    setBeginStatus('idle');
  }, [attemptId, observe, onSync]);

  const state: TrainingState = useMemo(
    () => ({
      selections,
      pending,
      review,
      choose,
      retry,
      readProgress,
      reportProgress,
    }),
    [selections, pending, review, choose, retry, readProgress, reportProgress],
  );

  const blocks = BLOCK_PATHS.filter(({ block }) =>
    questions.some((question) => question.skill === block),
  ).map(({ block, pathOf }) => ({ block, href: pathOf(examSlug, attemptId) }));

  // Starting again only opens the choice of the exam: a new attempt is
  // created there by an explicit start, never by this button.
  const restart = () => router.push(choicePath(examSlug));

  const nav =
    blocks.length > 1 ? (
      <nav aria-label={t('blocks')}>
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
          {blocks.map(({ block, href }) => (
            <Button
              key={block}
              component={Link}
              href={href}
              variant={block === current ? 'contained' : 'outlined'}
              aria-current={block === current ? 'page' : undefined}
              data-testid={`block-link-${block}`}
              sx={{ minHeight: 44 }}
            >
              {t(block)}
            </Button>
          ))}
        </Stack>
      </nav>
    ) : null;

  if (review) {
    return (
      <TrainingContext.Provider value={state}>
        <Stack
          spacing={3}
          data-testid="training-shell"
          data-attempt-id={attemptId}
        >
          {nav}
          <AttemptReviewView
            review={review}
            questions={questions}
            block={blocks.length > 1 ? current : undefined}
            onRestart={restart}
          />
        </Stack>
      </TrainingContext.Provider>
    );
  }

  // The whole assignment as the server counts it: a closed or not opened
  // part by its numbers, the open part with the choices of this page.
  const left = confirmationOf({
    questions,
    answers: NO_ANSWERS,
    phaseRevision,
    stored: new Set(Object.keys(selections)),
    summary: trusted.summary,
  });
  const total = trusted.summary?.totalAssigned ?? questions.length;
  const answered = total - left.skipped;
  const isOpen = !CLOSED_PHASES.includes(submission.phase);
  const activeClock = trusted.timer;
  const isTransition =
    isExam && isOpen && trusted.phase === 'transition' && activeClock !== null;
  const clock =
    activeClock && sync && isOpen && !isTransition ? (
      <AttemptTimer
        key={activeClock.deadlineMs}
        deadlineMs={activeClock.deadlineMs}
        sync={sync}
        skill={activeClock.skill}
        onZero={onZero}
      />
    ) : null;
  const [examTrackId] = trackIds;
  const examAudio =
    isExam && examTrackId && examStartedAtMs !== null ? (
      <ExamAudioPanel
        attemptId={attemptId}
        trackId={examTrackId}
        isActive={isOpen && trusted.phase === 'hoeren'}
        startedAtMs={examStartedAtMs}
        sync={sync}
      />
    ) : null;
  const freeAudio = isExam
    ? null
    : trackIds.map((trackId, trackIndex) => (
        <AudioPlayer
          key={trackId}
          isActive={current === 'hoeren'}
          resolveAudio={() => resolveAudio({ attemptId, trackId })}
          initialPosition={
            trackIndex === 0 ? (initialProgress?.positionSeconds ?? 0) : 0
          }
          onPosition={
            trackIndex === 0
              ? (seconds, isUrgent) =>
                  reportProgress({ positionSeconds: seconds }, isUrgent)
              : undefined
          }
        />
      ));
  const page =
    isTransition && sync ? (
      <TransitionScreen
        key={activeClock.deadlineMs}
        deadlineMs={activeClock.deadlineMs}
        sync={sync}
        status={beginStatus}
        onBegin={() => void beginLesen()}
        onZero={onZero}
      />
    ) : (
      <DictionaryBoundary>{children}</DictionaryBoundary>
    );

  return (
    <TrainingContext.Provider value={state}>
      <Stack
        spacing={{ xs: 1.5, sm: 3 }}
        data-testid="training-shell"
        data-attempt-id={attemptId}
        data-submission={submission.phase}
        data-mode={mode}
        data-phase={trusted.phase ?? undefined}
      >
        {clock}
        {nav}
        {examAudio}
        {freeAudio}
        {/* The dictionary wraps only the block page: the recording, the
            answers and the submission keep their own lifecycle. Its switch
            is portalled to the header; the recording belongs to Hören and
            is paused and hidden on Lesen. The transition of a full exam
            shows its own screen instead of the page. */}
        {page}
        <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 3 } }}>
          <AttemptSubmissionControls
            phase={submission.phase}
            confirmation={submission.confirmation}
            isRenewed={submission.isRenewed}
            cancelSummary={submission.cancelSummary}
            resultCheck={submission.resultCheck}
            expiry={submission.expiry}
            answered={answered}
            total={total}
            onSubmit={submission.submit}
            onConfirmSubmit={submission.confirmSubmit}
            onResendSubmit={submission.resendSubmit}
            onCheckResult={submission.checkResult}
            onCancel={submission.cancel}
            onConfirmCancel={submission.confirmCancel}
            onResendCancel={submission.resendCancel}
            onDismiss={submission.dismiss}
          />
        </Paper>
      </Stack>
    </TrainingContext.Provider>
  );
};
