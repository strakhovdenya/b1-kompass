'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ExamQuestion, Selections } from '@b1k/domain';
import { isUnsaved } from './answers';
import type { AnswerStore } from './answers';
import {
  choicePath,
  requestCancel,
  requestStatus,
  requestSubmit,
} from './attempt-client';
import type {
  AttemptStatusView,
  CancelClientResult,
  CancelRequest,
  FinalAnswer,
  StatusClientResult,
  SubmitClientResult,
  SubmitRequest,
} from './attempt-client';

// The submission and the cancel of one attempt, from the confirmation to the
// accepted state. Both are single commands with their own commandId, sent
// at once on their own fetch: they never wait for an autosave, the place or
// a server action. Once a command is sent, the answers are locked until the
// server answers; a lost answer keeps them locked and the same command can
// be sent again. The answers themselves stay in the one answer store.
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
  | 'cancel-failed';

export interface SubmitConfirmation {
  phaseRevision: number;
  skipped: number;
  unanswered: { hoeren: number; lesen: number };
}

// The cancel is confirmed with the server's own answers: what it holds is
// kept, the choices it has not stored are lost.
export interface CancelSummary {
  phaseRevision: number;
  skipped: number;
  unsaved: number;
}

export type ResultCheck = 'idle' | 'checking' | 'not-ready';

export type SubmissionStore = Pick<
  AnswerStore,
  'lock' | 'unlock' | 'readFinalAnswers' | 'readPending' | 'settle'
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
}

export interface AttemptSubmission {
  phase: SubmissionPhase;
  confirmation: SubmitConfirmation | null;
  // The confirmation was renewed because the server's numbers changed.
  isRenewed: boolean;
  cancelSummary: CancelSummary | null;
  resultCheck: ResultCheck;
  submit: () => void;
  confirmSubmit: () => void;
  resendSubmit: () => void;
  checkResult: () => void;
  cancel: () => void;
  confirmCancel: () => void;
  resendCancel: () => void;
  dismiss: () => void;
}

const confirmationOf = (
  questions: readonly ExamQuestion[],
  answers: readonly FinalAnswer[],
  phaseRevision: number,
  stored: ReadonlySet<string>,
): SubmitConfirmation => {
  const answered = new Set(stored);
  for (const answer of answers) answered.add(answer.questionId);
  const unanswered = { hoeren: 0, lesen: 0 };
  for (const question of questions) {
    if (!answered.has(question.id)) unanswered[question.skill] += 1;
  }
  const skipped = unanswered.hoeren + unanswered.lesen;
  return { phaseRevision, skipped, unanswered };
};

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
  // The command in flight, sent again unchanged after a lost answer.
  const submitCommand = useRef<SubmitRequest | null>(null);
  const cancelCommand = useRef<CancelRequest | null>(null);
  // Tasks the server reported as answered, for example from another tab:
  // the effective answers of a submission include them.
  const storedAnswered = useRef<ReadonlySet<string>>(new Set());

  const confirmationNow = useCallback(
    (answers: readonly FinalAnswer[]) =>
      confirmationOf(questions, answers, phaseRevision, storedAnswered.current),
    [questions, phaseRevision],
  );

  const close = useCallback(
    (next: 'accepted' | 'completed', accepted: Selections | null) => {
      onClosed();
      if (accepted) store.settle(accepted);
      else store.lock();
      setPhase(next);
      if (next === 'completed') router.refresh();
    },
    [onClosed, store, router],
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
      if (view.outcome === 'result-ready') close('completed', view.answers);
      else if (view.outcome === 'result-pending') {
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
    [close, examSlug, onClosed, router, store],
  );

  // The server refused the confirmation: its stored answers are read again
  // and a new confirmation is asked for; nothing is sent without it.
  const renewConfirmation = useCallback(async () => {
    const status = await requestStatus(attemptId);
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
  }, [attemptId, confirmationNow, follow, store]);

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
      const status = await requestStatus(attemptId);
      if (outcome === 'conflict') follow(status, 'failed');
      else close('accepted', status.ok ? status.result.answers : null);
    },
    [attemptId, close, follow, renewConfirmation, store],
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
    const status = await requestStatus(attemptId);
    if (status.ok && status.result.outcome === 'result-ready') {
      close('completed', status.result.answers);
      return;
    }
    setResultCheck('not-ready');
  }, [attemptId, close]);

  const loadCancelSummary = useCallback(async () => {
    setPhase('cancel-loading');
    const status = await requestStatus(attemptId);
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
  }, [attemptId, follow, store]);

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
      follow(await requestStatus(attemptId), 'cancel-failed');
    },
    [attemptId, examSlug, follow, loadCancelSummary, onClosed, router, store],
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
    submit,
    confirmSubmit,
    resendSubmit,
    checkResult: () => void checkResult(),
    cancel,
    confirmCancel,
    resendCancel,
    dismiss,
  };
};
