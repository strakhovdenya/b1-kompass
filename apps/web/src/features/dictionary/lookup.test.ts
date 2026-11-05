import { describe, expect, it } from 'vitest';
import type { DictionaryEntry } from './entry';
import { createLookupController } from './lookup';
import type { LookupAnswer, LookupState } from './lookup';

const entryOf = (word: string): DictionaryEntry => ({
  word,
  target: 'en',
  translation: { state: 'found', text: `en:${word}`, alternatives: [] },
  lexical: { state: 'not-found', baseform: null, synonyms: [] },
});

interface Pending {
  word: string;
  signal: AbortSignal;
  resolve: (answer: LookupAnswer) => void;
}

const setup = () => {
  const pending: Pending[] = [];
  const states: LookupState[] = [];
  const controller = createLookupController(
    (word, signal) =>
      new Promise<LookupAnswer>((resolve) => {
        pending.push({ word, signal, resolve });
      }),
    (state) => states.push(state),
  );
  return { controller, pending, states };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('lookup controller', () => {
  it('ignores stale lookup response after close', async () => {
    const { controller, pending, states } = setup();

    // Closed with Escape while the request runs: the late answer is dropped.
    controller.open('Anzeige');
    const first = pending[0];
    if (!first) throw new Error('no request');
    controller.close();
    expect(first.signal.aborted).toBe(true);
    first.resolve({ ok: true, entry: entryOf('Anzeige') });
    await flush();
    expect(controller.current()).toEqual({ status: 'closed' });
    expect(states.map((state) => state.status)).toEqual(['loading', 'closed']);

    // A hover moved on to another word: only the newest answer is shown.
    controller.open('Brief');
    controller.open('Lücke');
    const brief = pending[1];
    const luecke = pending[2];
    if (!brief || !luecke) throw new Error('no request');
    expect(brief.signal.aborted).toBe(true);
    expect(luecke.signal.aborted).toBe(false);
    luecke.resolve({ ok: true, entry: entryOf('Lücke') });
    await flush();
    brief.resolve({ ok: true, entry: entryOf('Brief') });
    await flush();
    const current = controller.current();
    expect(current.status).toBe('ready');
    expect(current.status === 'ready' && current.entry.word).toBe('Lücke');

    // A failure after close is dropped as well.
    controller.open('Zeile');
    controller.close();
    pending[3]?.resolve({ ok: false, failure: 'unavailable' });
    await flush();
    expect(controller.current()).toEqual({ status: 'closed' });
  });

  it('reports a failed request as an error of its own word', async () => {
    const states: LookupState[] = [];
    const controller = createLookupController(
      () => Promise.reject(new Error('offline')),
      (state) => states.push(state),
    );
    controller.open('Brief');
    await flush();
    expect(controller.current()).toMatchObject({
      status: 'error',
      word: 'Brief',
      failure: 'network',
    });
  });
});
