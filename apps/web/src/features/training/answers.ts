'use client';

import { useCallback, useRef, useState } from 'react';
import type {
  SaveAnswerError,
  SaveAnswerResult,
  Selections,
} from '@b1k/domain';
import type { FinalAnswer } from './attempt-client';

export interface SaveAnswerInput {
  attemptId: string;
  questionId: string;
  optionId: string;
  revision: number;
}

// 'error' can still be saved by a retry; 'refused' (the attempt is no longer
// active, for example finished in another tab, or the input is malformed)
// and 'session-invalid' cannot.
export type PendingStatus = 'saving' | 'error' | 'refused' | 'session-invalid';

// A choice the server has not confirmed: in flight or refused. It lives in
// the training shell, so it survives the unmount of a block screen.
export interface PendingAnswer {
  optionId: string;
  // The revision a retry sends again; null once the server refused it as
  // stale or conflicting, so a retry takes a new one above the server's.
  revision: number | null;
  status: PendingStatus;
  // The server refused this option for its task: a retry may still be
  // offered, but the choice is not part of the final answers, which the
  // server would refuse whole.
  isRejected?: boolean;
}

export type PendingAnswers = Readonly<Record<string, PendingAnswer>>;

export interface SentAnswer {
  optionId: string;
  revision: number;
}

const STATUS_AFTER: Readonly<Record<SaveAnswerError, PendingStatus>> = {
  unavailable: 'error',
  'option-not-allowed': 'error',
  'attempt-not-found': 'refused',
  'invalid-input': 'refused',
  'session-invalid': 'session-invalid',
};

// What is left unconfirmed after the server answered the latest request of
// a question; null when the server holds exactly this choice.
export const unconfirmedAfter = (
  result: SaveAnswerResult,
  sent: SentAnswer,
): PendingAnswer | null => {
  const { optionId, revision } = sent;
  if (result.ok) {
    const isSame = result.optionId === optionId && result.revision === revision;
    return isSame ? null : { optionId, revision: null, status: 'error' };
  }
  if (result.error === 'stale' || result.error === 'conflict') {
    if (result.optionId === optionId) return null;
    return { optionId, revision: null, status: 'error' };
  }
  const status = STATUS_AFTER[result.error];
  if (result.error === 'option-not-allowed') {
    return { optionId, revision, status, isRejected: true };
  }
  return { optionId, revision, status };
};

export const hasSaving = (pending: PendingAnswers): boolean =>
  Object.values(pending).some((entry) => entry.status === 'saving');

// A choice that is in flight or can still be saved by a retry: it belongs to
// the final answers of a submission, never to a cancel.
export const isUnsaved = (entry: PendingAnswer): boolean =>
  entry.status === 'saving' || entry.status === 'error';

export const hasUnsaved = (pending: PendingAnswers): boolean =>
  Object.values(pending).some(isUnsaved);

export interface FinalAnswersInput {
  selections: Selections;
  // The stored revision of every confirmed choice.
  revisions: Readonly<Record<string, number>>;
  pending: PendingAnswers;
  // A new revision above every one used for the question.
  allocate: (questionId: string) => number;
}

// The final answers of a submission: every confirmed choice under its stored
// revision, replaced by a choice the server has not confirmed yet (saving,
// or failed and retryable) under its own revision. A refused or rejected
// choice is not sent: the server could not take it.
export const finalAnswersOf = ({
  selections,
  revisions,
  pending,
  allocate,
}: FinalAnswersInput): FinalAnswer[] => {
  const answers = new Map<string, FinalAnswer>();
  for (const [questionId, optionId] of Object.entries(selections)) {
    const revision = Object.hasOwn(revisions, questionId)
      ? (revisions[questionId] ?? 1)
      : 1;
    answers.set(questionId, { questionId, optionId, revision });
  }
  for (const [questionId, entry] of Object.entries(pending)) {
    if (!isUnsaved(entry) || entry.isRejected) continue;
    const revision = entry.revision ?? allocate(questionId);
    answers.set(questionId, { questionId, optionId: entry.optionId, revision });
  }
  return [...answers.values()];
};

interface AnswerStoreOptions {
  attemptId: string;
  initialSelections: Selections;
  initialRevisions: Readonly<Record<string, number>>;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
  // An attempt already submitted opens with its answers final.
  isSettled?: boolean;
}

export interface AnswerStore {
  selections: Selections;
  pending: PendingAnswers;
  // The pending answers of this moment, also between renders.
  readPending: () => PendingAnswers;
  choose: (questionId: string, optionId: string) => void;
  retry: (questionId: string) => void;
  // Stops new choices and retries while a command is in flight; results of
  // saves already sent still update the screen.
  lock: () => void;
  // Opens the answers again after a refused submission.
  unlock: () => void;
  // The final answers of this moment, with the pending choices included.
  readFinalAnswers: () => FinalAnswer[];
  // The answers the server accepted: shown as they are, nothing pending.
  settle: (accepted: Selections) => void;
}

// The answers of one attempt. Every new choice of a question gets the next
// revision, continued from the revisions the server returned with the page
// and from the revisions the server reports back. Only the response to the
// latest request of a question decides its state, so a late response to an
// older choice never overwrites a newer one; the server applies the same
// order to the writes themselves.
export const useAnswerStore = ({
  attemptId,
  initialSelections,
  initialRevisions,
  saveAnswer,
  isSettled = false,
}: AnswerStoreOptions): AnswerStore => {
  const [selections, setSelections] = useState(initialSelections);
  const [pending, setPending] = useState<PendingAnswers>({});
  const selectionsRef = useRef(initialSelections);
  const pendingRef = useRef(pending);
  const confirmedRevisions = useRef<Record<string, number>>({
    ...initialRevisions,
  });
  const usedRevisions = useRef(new Map(Object.entries(initialRevisions)));
  const latestRevisions = useRef(new Map<string, number>());
  const isLocked = useRef(isSettled);
  const isFinal = useRef(isSettled);

  const updatePending = useCallback(
    (questionId: string, entry: PendingAnswer | null) => {
      const { [questionId]: _previous, ...rest } = pendingRef.current;
      pendingRef.current = entry ? { ...rest, [questionId]: entry } : rest;
      setPending(pendingRef.current);
    },
    [],
  );

  const confirm = useCallback(
    (questionId: string, optionId: string, revision: number) => {
      selectionsRef.current = {
        ...selectionsRef.current,
        [questionId]: optionId,
      };
      confirmedRevisions.current[questionId] = revision;
      setSelections(selectionsRef.current);
    },
    [],
  );

  const noteRevision = useCallback((questionId: string, revision: number) => {
    const used = usedRevisions.current;
    used.set(questionId, Math.max(used.get(questionId) ?? 0, revision));
  }, []);

  const allocate = useCallback((questionId: string): number => {
    const used = usedRevisions.current;
    const next = (used.get(questionId) ?? 0) + 1;
    used.set(questionId, next);
    return next;
  }, []);

  const send = useCallback(
    async (questionId: string, optionId: string, revision: number) => {
      latestRevisions.current.set(questionId, revision);
      updatePending(questionId, { optionId, revision, status: 'saving' });
      let result: SaveAnswerResult;
      try {
        result = await saveAnswer({
          attemptId,
          questionId,
          optionId,
          revision,
        });
      } catch (error) {
        console.error({ error });
        result = { ok: false, error: 'unavailable' };
      }
      // Once the server accepted the answers they are final: a late save
      // result changes nothing on the screen.
      if (isFinal.current) return;
      if ('revision' in result) noteRevision(questionId, result.revision);
      if (latestRevisions.current.get(questionId) !== revision) return;
      // A stale or conflicting save still tells what the server holds.
      if ('optionId' in result) {
        confirm(questionId, result.optionId, result.revision);
      }
      updatePending(
        questionId,
        unconfirmedAfter(result, { optionId, revision }),
      );
    },
    [attemptId, saveAnswer, confirm, noteRevision, updatePending],
  );

  const choose = useCallback(
    (questionId: string, optionId: string) => {
      if (isLocked.current) return;
      void send(questionId, optionId, allocate(questionId));
    },
    [send, allocate],
  );

  // A retry repeats the same request (same revision), which the server
  // confirms again if it was already written; a refused revision is renewed.
  const retry = useCallback(
    (questionId: string) => {
      if (isLocked.current) return;
      const entry = pendingRef.current[questionId];
      if (!entry || entry.status !== 'error') return;
      const revision = entry.revision ?? allocate(questionId);
      void send(questionId, entry.optionId, revision);
    },
    [send, allocate],
  );

  const readPending = useCallback(() => pendingRef.current, []);

  const lock = useCallback(() => {
    isLocked.current = true;
  }, []);

  const unlock = useCallback(() => {
    if (!isFinal.current) isLocked.current = false;
  }, []);

  // A pending choice without a revision gets one here, once: the same final
  // answers are sent again when the submission is repeated.
  const readFinalAnswers = useCallback(() => {
    const answers = finalAnswersOf({
      selections: selectionsRef.current,
      revisions: confirmedRevisions.current,
      pending: pendingRef.current,
      allocate,
    });
    for (const answer of answers) {
      const entry = pendingRef.current[answer.questionId];
      if (entry && entry.revision === null) {
        updatePending(answer.questionId, {
          ...entry,
          revision: answer.revision,
        });
      }
    }
    return answers;
  }, [allocate, updatePending]);

  const settle = useCallback((accepted: Selections) => {
    isLocked.current = true;
    isFinal.current = true;
    selectionsRef.current = accepted;
    pendingRef.current = {};
    setSelections(accepted);
    setPending(pendingRef.current);
  }, []);

  return {
    selections,
    pending,
    readPending,
    choose,
    retry,
    lock,
    unlock,
    readFinalAnswers,
    settle,
  };
};
