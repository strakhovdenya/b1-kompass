import type { DictionaryEntry, DictionaryFailure } from './entry';

// The lookup controller of the card: one lookup at a time. A new lookup and
// closing both abort the request before it (AbortController) and move the
// request id on, so a late answer of an earlier word never reaches the card.

export type LookupFailure = DictionaryFailure | 'network';

export type LookupAnswer =
  { ok: true; entry: DictionaryEntry } | { ok: false; failure: LookupFailure };

export type LookupState =
  | { status: 'closed' }
  | { status: 'loading'; word: string; requestId: number }
  | {
      status: 'ready';
      word: string;
      requestId: number;
      entry: DictionaryEntry;
    }
  | {
      status: 'error';
      word: string;
      requestId: number;
      failure: LookupFailure;
    };

export type FetchEntry = (
  word: string,
  signal: AbortSignal,
) => Promise<LookupAnswer>;

export interface LookupController {
  open: (word: string) => void;
  close: () => void;
  current: () => LookupState;
}

export const CLOSED: LookupState = { status: 'closed' };

export const createLookupController = (
  fetchEntry: FetchEntry,
  publish: (state: LookupState) => void,
): LookupController => {
  let requestId = 0;
  let state: LookupState = CLOSED;
  let abort: AbortController | null = null;

  const set = (next: LookupState) => {
    state = next;
    publish(next);
  };

  const stopRequest = () => {
    abort?.abort();
    abort = null;
  };

  const settle = (id: number, word: string, answer: LookupAnswer) => {
    if (id !== requestId) return;
    abort = null;
    if (answer.ok) {
      set({ status: 'ready', word, requestId: id, entry: answer.entry });
    } else {
      set({ status: 'error', word, requestId: id, failure: answer.failure });
    }
  };

  const open = (word: string) => {
    stopRequest();
    requestId += 1;
    const id = requestId;
    const controller = new AbortController();
    abort = controller;
    set({ status: 'loading', word, requestId: id });
    fetchEntry(word, controller.signal).then(
      (answer) => settle(id, word, answer),
      () => settle(id, word, { ok: false, failure: 'network' }),
    );
  };

  const close = () => {
    stopRequest();
    requestId += 1;
    if (state.status !== 'closed') set(CLOSED);
  };

  return { open, close, current: () => state };
};
