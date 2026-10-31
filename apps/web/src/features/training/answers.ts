'use client';

import { useCallback, useRef, useState } from 'react';
import type {
  SaveAnswerError,
  SaveAnswerResult,
  Selections,
} from '@b1k/domain';

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
  return { optionId, revision, status: STATUS_AFTER[result.error] };
};

export const hasSaving = (pending: PendingAnswers): boolean =>
  Object.values(pending).some((entry) => entry.status === 'saving');

// A choice that is in flight or can still be saved by a retry: finishing now
// would score the attempt without it.
export const isUnsaved = (entry: PendingAnswer): boolean =>
  entry.status === 'saving' || entry.status === 'error';

export const hasUnsaved = (pending: PendingAnswers): boolean =>
  Object.values(pending).some(isUnsaved);

interface AnswerStoreOptions {
  attemptId: string;
  initialSelections: Selections;
  initialRevisions: Readonly<Record<string, number>>;
  saveAnswer: (input: SaveAnswerInput) => Promise<SaveAnswerResult>;
}

export interface AnswerStore {
  selections: Selections;
  pending: PendingAnswers;
  // The pending answers of this moment, also between renders.
  readPending: () => PendingAnswers;
  choose: (questionId: string, optionId: string) => void;
  retry: (questionId: string) => void;
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
}: AnswerStoreOptions): AnswerStore => {
  const [selections, setSelections] = useState(initialSelections);
  const [pending, setPending] = useState<PendingAnswers>({});
  const pendingRef = useRef(pending);
  const usedRevisions = useRef(new Map(Object.entries(initialRevisions)));
  const latestRevisions = useRef(new Map<string, number>());

  const updatePending = useCallback(
    (questionId: string, entry: PendingAnswer | null) => {
      const { [questionId]: _previous, ...rest } = pendingRef.current;
      pendingRef.current = entry ? { ...rest, [questionId]: entry } : rest;
      setPending(pendingRef.current);
    },
    [],
  );

  const confirm = useCallback((questionId: string, optionId: string) => {
    setSelections((current) => ({ ...current, [questionId]: optionId }));
  }, []);

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
      if ('revision' in result) noteRevision(questionId, result.revision);
      if (latestRevisions.current.get(questionId) !== revision) return;
      // A stale or conflicting save still tells what the server holds.
      if ('optionId' in result) confirm(questionId, result.optionId);
      updatePending(
        questionId,
        unconfirmedAfter(result, { optionId, revision }),
      );
    },
    [attemptId, saveAnswer, confirm, noteRevision, updatePending],
  );

  const choose = useCallback(
    (questionId: string, optionId: string) => {
      void send(questionId, optionId, allocate(questionId));
    },
    [send, allocate],
  );

  // A retry repeats the same request (same revision), which the server
  // confirms again if it was already written; a refused revision is renewed.
  const retry = useCallback(
    (questionId: string) => {
      const entry = pendingRef.current[questionId];
      if (!entry || entry.status !== 'error') return;
      const revision = entry.revision ?? allocate(questionId);
      void send(questionId, entry.optionId, revision);
    },
    [send, allocate],
  );

  const readPending = useCallback(() => pendingRef.current, []);

  return { selections, pending, readPending, choose, retry };
};
