'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ExamQuestion, Selections } from '@b1k/domain';
import { isUnsaved } from './answers';
import { syncOf } from './exam-clock';
import type { ClockSync } from './exam-clock';
import type { AnswerStore } from './answers';
import {
  choicePath,
  confirmationOf,
  requestCancel,
  requestStatus,
  requestSubmit,
} from './attempt-client';
import type {
  AttemptStatusView,
  AttemptSummary,
  CancelClientResult,
  CancelRequest,
  FinalAnswer,
  StatusClientResult,
  SubmitClientResult,
  SubmitConfirmation,
  SubmitRequest,
} from './attempt-client';

// The submission and the cancel of one attempt, from the confirmation to the
// accepted state. Both are single commands with their own commandId, sent
// at once on their own fetch: they never wait for an autosave, the place or
// a server action. Once a command is sent, the answers are locked until the
// server answers; a lost answer keeps them locked and the same command can
// be sent again. The answers themselves stay in the one answer store.
// Every status read also reports the server clock, so the timer of a timed
// run follows the server; a run its deadline closed shows which choices were
// not saved in time.
export type SubmissionPhase =
  | 'idle'
  | 'confirming'
  | 'sending'
  | 'uncertain'
  | 'failed'
  | 'accepted'
  | 'completed'
  | 'cancel-loading'
  | 'cancel-confirming'
  | 'cancelling'
  | 'cancel-uncertain'
  | 'cancel-failed'
  | 'expired';

export type { ConfirmationInput, SubmitConfirmation } from './attempt-client';
export { confirmationOf } from './attempt-client';

// The cancel is confirmed with the server's own answers: what it holds is
// kept, the choices it has not stored are lost.
export interface CancelSummary {
  phaseRevision: number;
  skipped: number;
  unsaved: number;
}

export type ResultCheck = 'idle' | 'checking' | 'not-ready';

// The deadline closed the run: the choices the server did not accept in
// time, and whether the result is already stored.
export interface Expiry {
  unsaved: number;
  isResultReady: boolean;
}

export type SubmissionStore = Pick<
  AnswerStore,
  'lock' | 'unlock' | 'readFinalAnswers' | 'readPending' | 'settle' | 'expire'
>;

interface SubmissionOptions {
  attemptId: string;
  examSlug: string;
  questions: readonly ExamQuestion[];
  phaseRevision: number;
  isResultPending: boolean;
  store: SubmissionStore;
  // Called once the attempt is closed: nothing else is saved for it.
  onClosed: () => void;
  // Each reading of the server clock that came with a status.
  onSync?: (sync: ClockSync) => void;
  // The server's numbers of the whole assignment from the page; every
  // status renews them.
  summary?: AttemptSummary | null;
  // Every status the server answered, to follow its trusted phase.
  onStatus?: (view: AttemptStatusView) => void;
}

export interface AttemptSubmission {
  phase: SubmissionPhase;
  confirmation: SubmitConfirmation | null;
  // The confirmation was renewed because the server's numbers changed.
  isRenewed: boolean;
  cancelSummary: CancelSummary | null;
  resultCheck: ResultCheck;
  expiry: Expiry | null;
  submit: () => void;
  confirmSubmit: () => void;
  resendSubmit: () => void;
  checkResult: () => void;
  cancel: () => void;
  confirmCancel: () => void;
  resendCancel: () => void;
  dismiss: () => void;
  // Reads the server state on its own fetch, beside any save in flight. A
  // closed run is shown as closed; an open one only renews the clock.
  reconcile: () => Promise<void>;
  // Takes a status another command answered with (begin-lesen) as if it
  // had been read.
  observe: (view: AttemptStatusView) => void;
}

const isSameConfirmation = (
  left: SubmitConfirmation,
  right: SubmitConfirmation,
): boolean =>
  left.phaseRevision === right.phaseRevision && left.skipped === right.skipped;

const isLost = (result: { ok: false; failure: string }): boolean =>
  result.failure === 'network' || result.failure === 'unavailable';

const countUnsaved = (store: SubmissionStore): number =>
  Object.values(store.readPending()).filter(isUnsaved).length;

export const useAttemptSubmission = ({
  attemptId,
  examSlug,
  questions,
  phaseRevision,
  isResultPending,
  store,
  onClosed,
  onSync,
  summary = null,
  onStatus,
}: SubmissionOptions): AttemptSubmission => {
  const router = useRouter();
  const [phase, setPhase] = useState<SubmissionPhase>(
    isResultPending ? 'accepted' : 'idle',
  );
  const [confirmation, setConfirmation] = useState<SubmitConfirmation | null>(
    null,
  );
  const [isRenewed, setIsRenewed] = useState(false);
  const [cancelSummary, setCancelSummary] = useState<CancelSummary | null>(
    null,
  );
  const [resultCheck, setResultCheck] = useState<ResultCheck>('idle');
  const [expiry, setExpiry] = useState<Expiry | null>(null);
  // Closed for this page: no further reconciliation changes the screen.
  const isClosed = useRef(isResultPending);
  // The command in flight, sent again unchanged after a lost answer.
  const submitCommand = useRef<SubmitRequest | null>(null);
  const cancelCommand = useRef<CancelRequest | null>(null);
  // Tasks the server reported as answered, for example from another tab:
  // the effective answers of a submission include them.
  const storedAnswered = useRef<ReadonlySet<string>>(new Set());
  // The latest phase revision and numbers the server reported: a renewed
  // confirmation names the phase of now, so a phase change never repeats
  // the same stale confirmation.
  const latestRevision = useRef(phaseRevision);
  const latestSummary = useRef(summary);
  useEffect(() => {
    latestRevision.current = phaseRevision;
  }, [phaseRevision]);
  useEffect(() => {
    latestSummary.current = summary;
  }, [summary]);

  const confirmationNow = useCallback(
    (answers: readonly FinalAnswer[]) =>
      confirmationOf({
        questions,
        answers,
        phaseRevision: latestRevision.current,
        stored: storedAnswered.current,
        summary: latestSummary.current,
      }),
    [questions],
  );

  const learn = useCallback(
    (view: AttemptStatusView) => {
      latestRevision.current = view.state.phaseRevision;
      latestSummary.current = view.summary;
      onStatus?.(view);
    },
    [onStatus],
  );

  // Every status is read on its own fetch and reports the server clock: the
  // moment is placed in the middle of the round trip.
  const readStatus = useCallback(async (): Promise<StatusClientResult> => {
    const sentMs = performance.now();
    const status = await requestStatus(attemptId);
    if (status.ok) {
      const serverNowMs = Date.parse(status.result.serverNow);
      onSync?.(syncOf(serverNowMs, sentMs, performance.now()));
      learn(status.result);
    }
    return status;
  }, [attemptId, onSync, learn]);

  const close = useCallback(
    (next: 'accepted' | 'completed', accepted: Selections | null) => {
      isClosed.current = true;
      onClosed();
      if (accepted) store.settle(accepted);
      else store.lock();
      setPhase(next);
      if (next === 'completed') router.refresh();
    },
    [onClosed, store, router],
  );

  // The deadline closed the run with the answers accepted in time: they are
  // final, every other choice stays visible as not saved, and the result is
  // opened by the guest, so the unsaved choices can be seen first.
  const expire = useCallback(
    (view: AttemptStatusView) => {
      isClosed.current = true;
      onClosed();
      const unsaved = store.expire(view.answers);
      setExpiry({ unsaved, isResultReady: view.outcome === 'result-ready' });
      setConfirmation(null);
      setCancelSummary(null);
      setResultCheck('idle');
      setPhase('expired');
    },
    [onClosed, store],
  );

  // The attempt is no longer open for this command: show what it is now.
  const follow = useCallback(
    (status: StatusClientResult, otherwise: SubmissionPhase) => {
      if (!status.ok) {
        store.unlock();
        setPhase(otherwise);
        return;
      }
      const view: AttemptStatusView = status.result;
      const isFinished =
        view.outcome === 'result-ready' || view.outcome === 'result-pending';
      if (isFinished && view.isClosedByDeadline) expire(view);
      else if (view.outcome === 'result-ready') {
        close('completed', view.answers);
      } else if (view.outcome === 'result-pending') {
        close('accepted', view.answers);
      } else if (view.outcome === 'cancelled') {
        onClosed();
        store.lock();
        router.push(choicePath(examSlug));
      } else {
        store.unlock();
        setPhase(otherwise);
      }
    },
    [close, examSlug, expire, onClosed, router, store],
  );

  // The server refused the confirmation: its stored answers are read again
  // and a new confirmation is asked for; nothing is sent without it.
  const renewConfirmation = useCallback(async () => {
    const status = await readStatus();
    if (status.ok && status.result.outcome !== 'active') {
      follow(status, 'failed');
      return;
    }
    if (status.ok) {
      storedAnswered.current = new Set(Object.keys(status.result.answers));
    }
    setConfirmation(confirmationNow(store.readFinalAnswers()));
    setIsRenewed(true);
    setPhase('confirming');
  }, [readStatus, confirmationNow, follow, store]);

  const settleSubmit = useCallback(
    async (result: SubmitClientResult) => {
      if (!result.ok) {
        if (isLost(result)) {
          setPhase('uncertain');
          return;
        }
        submitCommand.current = null;
        store.unlock();
        setPhase('failed');
        return;
      }
      submitCommand.current = null;
      const { outcome } = result.result;
      if (outcome === 'result-ready') {
        close('completed', null);
        return;
      }
      if (outcome === 'stale-confirmation') {
        store.unlock();
        await renewConfirmation();
        return;
      }
      const status = await readStatus();
      // closed-phase: the deadline closed the run before this submission.
      // The run is closed even when its status could not be read: the
      // answers stay locked and the result is asked for again.
      if (outcome === 'closed-phase' && !status.ok) close('accepted', null);
      else if (outcome === 'conflict' || outcome === 'closed-phase') {
        follow(status, 'failed');
      } else close('accepted', status.ok ? status.result.answers : null);
    },
    [readStatus, close, follow, renewConfirmation, store],
  );

  const send = useCallback(
    async (request: SubmitRequest) => {
      submitCommand.current = request;
      store.lock();
      setPhase('sending');
      await settleSubmit(await requestSubmit(attemptId, request));
    },
    [attemptId, settleSubmit, store],
  );

  const sendNew = useCallback(
    (answers: readonly FinalAnswer[], confirmed: SubmitConfirmation) => {
      const { phaseRevision: revision, skipped } = confirmed;
      void send({
        commandId: crypto.randomUUID(),
        answers,
        confirmation: { phaseRevision: revision, skipped },
      });
    },
    [send],
  );

  // Without unanswered tasks there is nothing to confirm.
  const submit = useCallback(() => {
    const answers = store.readFinalAnswers();
    const next = confirmationNow(answers);
    setIsRenewed(false);
    if (next.skipped === 0) {
      sendNew(answers, next);
      return;
    }
    setConfirmation(next);
    setPhase('confirming');
  }, [store, confirmationNow, sendNew]);

  // A confirmation that no longer matches the answers is not reused.
  const confirmSubmit = useCallback(() => {
    if (!confirmation) return;
    const answers = store.readFinalAnswers();
    const current = confirmationNow(answers);
    if (!isSameConfirmation(current, confirmation)) {
      setConfirmation(current);
      setIsRenewed(true);
      return;
    }
    sendNew(answers, current);
  }, [confirmation, store, confirmationNow, sendNew]);

  const resendSubmit = useCallback(() => {
    const request = submitCommand.current;
    if (request) void send(request);
  }, [send]);

  const checkResult = useCallback(async () => {
    setResultCheck('checking');
    const status = await readStatus();
    if (status.ok && status.result.outcome === 'result-ready') {
      close('completed', status.result.answers);
      return;
    }
    setResultCheck('not-ready');
  }, [readStatus, close]);

  const loadCancelSummary = useCallback(async () => {
    setPhase('cancel-loading');
    const status = await readStatus();
    if (!status.ok || status.result.outcome !== 'active') {
      follow(status, 'cancel-failed');
      return;
    }
    setCancelSummary({
      phaseRevision: status.result.state.phaseRevision,
      skipped: status.result.skipped,
      unsaved: countUnsaved(store),
    });
    setPhase('cancel-confirming');
  }, [readStatus, follow, store]);

  const cancel = useCallback(() => {
    setIsRenewed(false);
    void loadCancelSummary();
  }, [loadCancelSummary]);

  const settleCancel = useCallback(
    async (result: CancelClientResult) => {
      if (!result.ok) {
        if (isLost(result)) {
          setPhase('cancel-uncertain');
          return;
        }
        cancelCommand.current = null;
        store.unlock();
        setPhase('cancel-failed');
        return;
      }
      cancelCommand.current = null;
      const { outcome } = result.result;
      if (outcome === 'accepted') {
        onClosed();
        router.push(choicePath(examSlug));
        return;
      }
      store.unlock();
      if (outcome === 'stale-confirmation') {
        setIsRenewed(true);
        await loadCancelSummary();
        return;
      }
      follow(await readStatus(), 'cancel-failed');
    },
    [examSlug, follow, loadCancelSummary, onClosed, readStatus, router, store],
  );

  const sendCancel = useCallback(
    async (request: CancelRequest) => {
      cancelCommand.current = request;
      store.lock();
      setPhase('cancelling');
      await settleCancel(await requestCancel(attemptId, request));
    },
    [attemptId, settleCancel, store],
  );

  const confirmCancel = useCallback(() => {
    if (!cancelSummary) return;
    const { phaseRevision: revision, skipped } = cancelSummary;
    void sendCancel({
      commandId: crypto.randomUUID(),
      confirmation: { phaseRevision: revision, skipped },
    });
  }, [cancelSummary, sendCancel]);

  const resendCancel = useCallback(() => {
    const request = cancelCommand.current;
    if (request) void sendCancel(request);
  }, [sendCancel]);

  const reconcile = useCallback(async () => {
    if (isClosed.current) return;
    const status = await readStatus();
    if (isClosed.current || !status.ok) return;
    if (status.result.outcome !== 'active') follow(status, 'idle');
  }, [follow, readStatus]);

  const observe = useCallback(
    (view: AttemptStatusView) => {
      if (isClosed.current) return;
      learn(view);
      if (view.outcome !== 'active') follow({ ok: true, result: view }, 'idle');
    },
    [follow, learn],
  );

  const dismiss = useCallback(() => {
    store.unlock();
    setConfirmation(null);
    setCancelSummary(null);
    setIsRenewed(false);
    setPhase('idle');
  }, [store]);

  return {
    phase,
    confirmation,
    isRenewed,
    cancelSummary,
    resultCheck,
    expiry,
    submit,
    confirmSubmit,
    resendSubmit,
    checkResult: () => void checkResult(),
    cancel,
    confirmCancel,
    resendCancel,
    dismiss,
    reconcile,
    observe,
  };
};
