import { describe, expect, it } from 'vitest';
import type { Locale } from '@b1k/domain';
import type { DictionaryResult } from '../../features/dictionary/entry';
import { parseDictionarySettings } from './config';
import {
  DEFAULT_LIMITS,
  FOUND_TTL_MS,
  NOT_FOUND_TTL_MS,
  lookupWord,
} from './dictionary';
import type {
  BudgetItem,
  CacheRow,
  DictionaryDeps,
  DictionaryLimits,
  DictionaryStore,
  ReserveResult,
} from './dictionary';
import { createMyMemory, myMemoryUrl } from './mymemory';
import { createOpenThesaurus, openThesaurusUrl } from './openthesaurus';
import type { FetchLike } from './providers';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const GUEST_A = { sessionId: '11111111-1111-4111-8111-111111111111' };
const GUEST_B = { sessionId: '22222222-2222-4222-8222-222222222222' };
const CONTACT = 'owner@example.com';

// --- An in-memory store with the semantics of the SQL function -----------

interface MemoryStore extends DictionaryStore {
  rows: Map<string, CacheRow>;
  used: Map<string, number>;
  reserveCalls: BudgetItem[][];
  expired: Set<string>;
}

const rowKey = (
  row: Pick<CacheRow, 'provider' | 'version' | 'word' | 'target'>,
) => `${row.provider}|${row.version}|${row.word}|${row.target}`;

const createMemoryStore = (): MemoryStore => {
  const rows = new Map<string, CacheRow>();
  const used = new Map<string, number>();
  const reserveCalls: BudgetItem[][] = [];
  const expired = new Set<string>();
  return {
    rows,
    used,
    reserveCalls,
    expired,
    readCache: async (word, now) =>
      [...rows.values()].filter(
        (row) => row.word === word && row.expiresAt > now,
      ),
    writeCache: async (written) => {
      for (const row of written) rows.set(rowKey(row), { ...row });
    },
    reserve: async (sessionId, items): Promise<ReserveResult> => {
      reserveCalls.push([...items]);
      if (expired.has(sessionId)) {
        return { ok: false, reason: 'session-invalid' };
      }
      const sorted = [...items].sort((a, b) => a.scope.localeCompare(b.scope));
      for (const item of sorted) {
        const next = (used.get(item.scope) ?? 0) + item.cost;
        if (next > item.limit) {
          const kind = item.scope.split(':')[0];
          return {
            ok: false,
            reason: 'exhausted',
            kind:
              kind === 'guest' ||
              kind === 'mymemory' ||
              kind === 'openthesaurus'
                ? kind
                : null,
          };
        }
      }
      for (const item of sorted) {
        used.set(item.scope, (used.get(item.scope) ?? 0) + item.cost);
      }
      return { ok: true };
    },
  };
};

// The reservations that may reach a provider: every lookup also passes the
// guest admission (guestread), which alone never calls one.
const providerReserves = (store: MemoryStore): BudgetItem[][] =>
  store.reserveCalls.filter((items) =>
    items.some((item) => !item.scope.startsWith('guestread:')),
  );

// --- Controlled fake HTTP of the two providers ----------------------------

interface FakeAnswer {
  status?: number;
  type?: string;
  body: string;
}

interface Call {
  url: URL;
  init: RequestInit;
}

const json = (value: unknown): FakeAnswer => ({ body: JSON.stringify(value) });

const myMemoryOk = (text: string, extra: Record<string, unknown> = {}) =>
  json({
    responseData: { translatedText: text, match: 1 },
    quotaFinished: false,
    responseDetails: '',
    responseStatus: 200,
    matches: [],
    ...extra,
  });

const thesaurusOk = (
  terms: { term: string; level?: string }[],
  baseforms?: string[],
) =>
  json({
    metaData: { source: 'https://www.openthesaurus.de' },
    synsets: terms.length > 0 ? [{ id: 1, categories: [], terms }] : [],
    ...(baseforms ? { baseforms } : {}),
  });

type Responder = (url: URL) => FakeAnswer | Error;

const createFakeHttp = (
  myMemory: Responder,
  thesaurus: Responder = () => thesaurusOk([]),
) => {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, init });
    const answer =
      url.hostname === 'api.mymemory.translated.net'
        ? myMemory(url)
        : thesaurus(url);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body, {
      status: answer.status ?? 200,
      headers: { 'content-type': answer.type ?? 'application/json' },
    });
  };
  const providerCalls = (host: string) =>
    calls.filter((call) => call.url.hostname === host);
  return {
    fetchFn,
    calls,
    myMemoryCalls: () => providerCalls('api.mymemory.translated.net'),
    thesaurusCalls: () => providerCalls('www.openthesaurus.de'),
  };
};

const setup = (
  http: ReturnType<typeof createFakeHttp>,
  limits: DictionaryLimits = DEFAULT_LIMITS,
  store: MemoryStore = createMemoryStore(),
) => {
  const { translate } = createMyMemory({
    fetch: http.fetchFn,
    contactEmail: CONTACT,
  });
  const { thesaurus } = createOpenThesaurus({
    fetch: http.fetchFn,
    contact: CONTACT,
  });
  const deps: DictionaryDeps = {
    store,
    providers: { translate, thesaurus },
    clock: { now: () => new Date(NOW) },
    limits,
  };
  return { deps, store };
};

const guestOf = (base: { sessionId: string }, locale: Locale) => ({
  ...base,
  locale,
});

const entryOf = (result: DictionaryResult) => {
  if (!result.ok) throw new Error(`lookup failed: ${result.failure}`);
  return result.entry;
};

// --------------------------------------------------------------------------

describe('dictionary service', () => {
  it('returns translation in active guest locale', async () => {
    const http = createFakeHttp((url) => {
      const target = url.searchParams.get('langpair');
      return myMemoryOk(target === 'de|ru' ? 'письмо' : 'letter');
    });
    const { deps, store } = setup(http);

    const english = entryOf(
      await lookupWord(deps, guestOf(GUEST_A, 'en'), { word: 'Brief' }),
    );
    expect(english.target).toBe('en');
    expect(english.translation.text).toBe('letter');

    // The same guest switched to Russian: a separate key, a separate call.
    const russian = entryOf(
      await lookupWord(deps, guestOf(GUEST_A, 'ru'), { word: 'Brief' }),
    );
    expect(russian.target).toBe('ru');
    expect(russian.translation.text).toBe('письмо');
    expect(
      http.myMemoryCalls().map((call) => call.url.searchParams.get('langpair')),
    ).toEqual(['de|en', 'de|ru']);
    const targets = [...store.rows.values()]
      .filter((row) => row.provider === 'mymemory')
      .map((row) => `${row.word}:${row.target}`)
      .sort();
    expect(targets).toEqual(['Brief:en', 'Brief:ru']);

    // A target in the request body is refused, never used.
    expect(
      await lookupWord(deps, guestOf(GUEST_A, 'en'), {
        word: 'Brief',
        target: 'ru',
      }),
    ).toEqual({ ok: false, failure: 'invalid-input' });
  });

  it('combines trusted translation with optional lexical details', async () => {
    const http = createFakeHttp(
      () =>
        myMemoryOk('went', {
          matches: [
            { segment: 'gegangen', translation: 'gone', match: 1 },
            { segment: 'Gegangen', translation: 'went', match: 1 },
            { segment: 'gegangen.', translation: 'following an assault.' },
            { segment: 'ist gegangen', translation: 'has left' },
            { segment: 'gegangen', translation: 'https://spam.example' },
            { segment: 'gegangen', translation: 'MYMEMORY WARNING: x' },
            { segment: 'gegangen', translation: 'gegangen' },
          ],
        }),
      () =>
        thesaurusOk(
          [
            { term: 'gegangen' },
            { term: 'gelaufen' },
            { term: 'davon gegangen' },
            { term: 'abgehauen', level: 'umgangssprachlich' },
            { term: 'verpisst', level: 'derb' },
          ],
          ['gehen'],
        ),
    );
    const { deps } = setup(http);
    const entry = entryOf(
      await lookupWord(deps, guestOf(GUEST_A, 'en'), { word: 'gegangen' }),
    );
    expect(entry).toEqual({
      word: 'gegangen',
      target: 'en',
      translation: { state: 'found', text: 'went', alternatives: ['gone'] },
      lexical: {
        state: 'found',
        baseform: 'gehen',
        synonyms: ['gelaufen', 'abgehauen'],
      },
    });
    // No article, plural or part of speech is invented.
    expect(Object.keys(entry.lexical).sort()).toEqual([
      'baseform',
      'state',
      'synonyms',
    ]);

    // Only the word, the pair and the contact reach the providers.
    const [translateCall] = http.myMemoryCalls();
    const [thesaurusCall] = http.thesaurusCalls();
    if (!translateCall || !thesaurusCall) throw new Error('no provider call');
    expect(translateCall.url.toString()).toBe(
      myMemoryUrl('gegangen', 'en', CONTACT).toString(),
    );
    expect([...translateCall.url.searchParams.keys()].sort()).toEqual([
      'de',
      'langpair',
      'mt',
      'q',
    ]);
    expect(translateCall.url.protocol).toBe('https:');
    expect(thesaurusCall.url.toString()).toBe(
      openThesaurusUrl('gegangen').toString(),
    );
    const headers = new Headers(thesaurusCall.init.headers);
    expect(headers.get('user-agent')).toContain(CONTACT);
    for (const call of http.calls) {
      const sent = new Headers(call.init.headers);
      expect(sent.get('x-forwarded-for')).toBeNull();
      expect(sent.get('cookie')).toBeNull();
      expect(call.url.searchParams.get('ip')).toBeNull();
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('reuses safe shared translation across guests', async () => {
    const http = createFakeHttp(
      () => myMemoryOk('gap'),
      () => thesaurusOk([{ term: 'Lücke' }, { term: 'Spalt' }]),
    );
    const { deps, store } = setup(http);
    const first = entryOf(
      await lookupWord(deps, guestOf(GUEST_A, 'en'), { word: 'Lücke' }),
    );
    const second = entryOf(
      await lookupWord(deps, guestOf(GUEST_B, 'en'), { word: 'Lücke' }),
    );
    expect(second).toEqual(first);
    expect(http.myMemoryCalls()).toHaveLength(1);
    expect(http.thesaurusCalls()).toHaveLength(1);
    // Only the first guest's miss was charged to the providers; the second
    // guest still passed the session check of the database.
    expect(providerReserves(store)).toHaveLength(1);
    expect(store.used.get(`guest:${GUEST_B.sessionId}`)).toBeUndefined();
    expect(store.used.get(`guestread:${GUEST_B.sessionId}`)).toBe(1);

    // The shared rows carry no session data.
    for (const row of store.rows.values()) {
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(GUEST_A.sessionId);
      expect(stored).not.toContain(GUEST_B.sessionId);
      expect(row.expiresAt.getTime() - row.fetchedAt.getTime()).toBe(
        FOUND_TTL_MS,
      );
    }
    expect(JSON.stringify(second)).not.toContain(GUEST_A.sessionId);

    // Significant case is a different word.
    await lookupWord(deps, guestOf(GUEST_B, 'en'), { word: 'lücke' });
    expect(http.myMemoryCalls()).toHaveLength(2);
  });

  it('rejects unsafe and oversized lookup tokens', async () => {
    const http = createFakeHttp(() => myMemoryOk('x'));
    const { deps, store } = setup(http);
    const guest = guestOf(GUEST_A, 'en');
    const words = [
      'Haus\u0000',
      'Ha‮us',
      'Haus\u0007tür',
      'https://evil.example',
      'javascript:alert(1)',
      'zwei Wörter',
      'Ich gehe nach Hause.',
      '2026',
      'Москва',
      'a'.repeat(65),
      'ä'.repeat(65),
      '',
    ];
    for (const word of words) {
      expect(await lookupWord(deps, guest, { word }), word).toEqual({
        ok: false,
        failure: 'invalid-word',
      });
    }
    for (const input of [
      null,
      'Brief',
      { word: 7 },
      { word: 'Brief', extra: true },
      { word: 'x'.repeat(1000) },
    ]) {
      expect(await lookupWord(deps, guest, input)).toEqual({
        ok: false,
        failure: 'invalid-input',
      });
    }
    expect(http.calls).toHaveLength(0);
    expect(store.reserveCalls).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  it('rejects untrusted and unavailable provider responses', async () => {
    const word = 'Anzeige';
    const failures: Record<string, FakeAnswer | Error> = {
      'http 429': { status: 429, body: '{}' },
      'http 503': { status: 503, body: '{}' },
      html: { type: 'text/html', body: '<html><script>x</script></html>' },
      'broken json': { body: '{"responseData": ' },
      'quota finished': myMemoryOk('advertisement', { quotaFinished: true }),
      warning: myMemoryOk(
        'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY',
      ),
      'status 403': myMemoryOk('advertisement', { responseStatus: '403' }),
      'status 429 in body': myMemoryOk('advertisement', {
        responseStatus: 429,
      }),
      oversized: myMemoryOk('x'.repeat(70 * 1024)),
      network: new Error('ECONNRESET'),
    };
    for (const [name, answer] of Object.entries(failures)) {
      const http = createFakeHttp(
        () => answer,
        () => answer,
      );
      const { deps, store } = setup(http);
      const entry = entryOf(
        await lookupWord(deps, guestOf(GUEST_A, 'en'), { word }),
      );
      expect(entry.translation, name).toEqual({
        state: 'unavailable',
        text: null,
        alternatives: [],
      });
      expect(entry.lexical.state, name).toBe('unavailable');
      expect(store.rows.size, name).toBe(0);
    }

    // The source word echoed back (any case) is no translation; it is cached
    // only as a short-lived not-found, never as a translation.
    for (const echo of ['Anzeige', 'ANZEIGE', ' anzeige ']) {
      const http = createFakeHttp(() => myMemoryOk(echo));
      const { deps, store } = setup(http);
      const entry = entryOf(
        await lookupWord(deps, guestOf(GUEST_A, 'en'), { word }),
      );
      expect(entry.translation.state).toBe('not-found');
      expect(entry.translation.text).toBeNull();
      const row = [...store.rows.values()].find(
        (item) => item.provider === 'mymemory',
      );
      expect(row?.state).toBe('not-found');
      expect(row?.payload).toEqual({});
      expect(
        (row?.expiresAt.getTime() ?? 0) - (row?.fetchedAt.getTime() ?? 0),
      ).toBe(NOT_FOUND_TTL_MS);
    }

    // A link or control characters in place of a translation are refused.
    for (const text of ['see https://spam.example', 'bad\u0000text']) {
      const http = createFakeHttp(() => myMemoryOk(text));
      const { deps } = setup(http);
      const entry = entryOf(
        await lookupWord(deps, guestOf(GUEST_A, 'en'), { word }),
      );
      expect(entry.translation.text).toBeNull();
    }
  });

  it('enforces quota without blocking cached words', async () => {
    const http = createFakeHttp(
      (url) => myMemoryOk(`en-${url.searchParams.get('q')}`),
      () => thesaurusOk([{ term: 'Inserat' }]),
    );
    const limits: DictionaryLimits = {
      guestReadsPerMinute: 100,
      guestLookupsPerMinute: 100,
      myMemoryCharsPerDay: 10,
      thesaurusPerMinute: 100,
    };
    const { deps, store } = setup(http, limits);
    const guest = guestOf(GUEST_A, 'en');

    // Anzeige (7 characters) fits into the daily budget of 10.
    const cached = entryOf(await lookupWord(deps, guest, { word: 'Anzeige' }));
    expect(cached.translation.text).toBe('en-Anzeige');
    expect(http.myMemoryCalls()).toHaveLength(1);

    // Lesetext (8) does not: MyMemory is not called, OpenThesaurus still is.
    const limited = entryOf(
      await lookupWord(deps, guest, { word: 'Lesetext' }),
    );
    expect(limited.translation.state).toBe('limited');
    expect(http.myMemoryCalls()).toHaveLength(1);
    expect(limited.lexical.state).toBe('found');
    expect(store.used.get('mymemory')).toBe(7);
    expect(
      [...store.rows.values()].some(
        (row) => row.provider === 'mymemory' && row.word === 'Lesetext',
      ),
    ).toBe(false);

    // The cached word is still served, without any budget or provider.
    const callsBefore = http.calls.length;
    const reservesBefore = providerReserves(store).length;
    expect(entryOf(await lookupWord(deps, guest, { word: 'Anzeige' }))).toEqual(
      cached,
    );
    expect(http.calls.length).toBe(callsBefore);
    expect(providerReserves(store).length).toBe(reservesBefore);

    // A used-up guest minute limits both providers.
    const strict = setup(
      createFakeHttp(() => myMemoryOk('x')),
      { ...DEFAULT_LIMITS, guestLookupsPerMinute: 1 },
    );
    entryOf(await lookupWord(strict.deps, guest, { word: 'Brief' }));
    const blocked = entryOf(
      await lookupWord(strict.deps, guest, { word: 'Zeile' }),
    );
    expect(blocked.translation.state).toBe('limited');
    expect(blocked.lexical.state).toBe('limited');

    // Too many cards in a minute: a limited entry, no cache or provider.
    const reads = setup(
      createFakeHttp(() => myMemoryOk('x')),
      { ...DEFAULT_LIMITS, guestReadsPerMinute: 1 },
    );
    entryOf(await lookupWord(reads.deps, guest, { word: 'Brief' }));
    const throttled = entryOf(
      await lookupWord(reads.deps, guest, { word: 'Brief' }),
    );
    expect(throttled.translation.state).toBe('limited');
    expect(throttled.lexical.state).toBe('limited');
    expect(providerReserves(reads.store)).toHaveLength(1);

    // An expired session is refused by the database even for a cached word.
    const cachedStore = store;
    cachedStore.expired.add(GUEST_A.sessionId);
    expect(await lookupWord(deps, guest, { word: 'Anzeige' })).toEqual({
      ok: false,
      failure: 'session-invalid',
    });
    cachedStore.expired.delete(GUEST_A.sessionId);

    // An expired session is refused by the budget before any provider call.
    const expired = createMemoryStore();
    expired.expired.add(GUEST_B.sessionId);
    const late = setup(
      createFakeHttp(() => myMemoryOk('x')),
      DEFAULT_LIMITS,
      expired,
    );
    expect(
      await lookupWord(late.deps, guestOf(GUEST_B, 'en'), { word: 'Brief' }),
    ).toEqual({ ok: false, failure: 'session-invalid' });
    expect(expired.rows.size).toBe(0);
  });
});

describe('dictionary configuration', () => {
  const base = {
    testProvider: undefined,
    contactEmail: undefined,
    vercelEnv: undefined,
    appOrigin: 'https://b1-kompass.example',
  };

  it('uses the live providers unless the local test provider is allowed', () => {
    expect(parseDictionarySettings(base)).toEqual({
      ok: true,
      mode: 'live',
      contactEmail: null,
    });
    expect(
      parseDictionarySettings({ ...base, contactEmail: ' owner@example.com ' }),
    ).toMatchObject({ contactEmail: 'owner@example.com' });
    expect(
      parseDictionarySettings({ ...base, contactEmail: 'not an email' }),
    ).toMatchObject({ contactEmail: null });

    const local = { ...base, testProvider: '1' };
    expect(
      parseDictionarySettings({ ...local, appOrigin: 'http://localhost:3102' }),
    ).toEqual({ ok: true, mode: 'test', contactEmail: null });
    expect(
      parseDictionarySettings({ ...local, appOrigin: 'http://127.0.0.1:3000' }),
    ).toMatchObject({ ok: true, mode: 'test' });

    // Never on Vercel, never behind a public origin, never by accident.
    for (const settings of [
      { ...local, appOrigin: 'http://localhost:3102', vercelEnv: 'preview' },
      { ...local, appOrigin: 'http://localhost:3102', vercelEnv: 'production' },
      { ...local, appOrigin: 'https://b1-kompass.vercel.app' },
      { ...local, appOrigin: 'http://localhost.evil.example' },
      { ...local, appOrigin: undefined },
    ]) {
      expect(parseDictionarySettings(settings)).toEqual({
        ok: false,
        error: 'test-provider-forbidden',
      });
    }
    expect(
      parseDictionarySettings({
        ...base,
        testProvider: 'true',
        appOrigin: 'http://localhost:3102',
      }),
    ).toEqual({ ok: false, error: 'invalid-test-provider' });
  });
});
