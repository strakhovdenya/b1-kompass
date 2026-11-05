import { z } from 'zod';
import type { Locale } from '@b1k/domain';
import type { Clock } from '../db';
import type {
  DictionaryEntry,
  DictionaryLexical,
  DictionaryResult,
  DictionaryTranslation,
  PartState,
} from '../../features/dictionary/entry';
import {
  MAX_ALTERNATIVES,
  MAX_SYNONYMS,
  MAX_TRANSLATION_CHARS,
} from '../../features/dictionary/entry';
import { MAX_WORD_CHARS, normalizeWord } from '../../features/dictionary/word';
import type {
  DictionaryProviders,
  LexicalOutcome,
  TranslationOutcome,
} from './providers';

// The dictionary service: one German word of a verified guest becomes one
// DictionaryEntry. Order: strict input, the word check, the guest admission
// in the database, the shared cache, the atomic provider budget, the
// providers, the cache write. The target language is
// the guest's locale, never a value of the request. A provider failure or a
// used-up budget gives a fallback entry; it never touches an attempt.

export type ProviderName = 'mymemory' | 'openthesaurus';
export type CacheTarget = Locale | 'de';

export const PROVIDER_VERSION: Readonly<Record<ProviderName, number>> = {
  mymemory: 1,
  openthesaurus: 1,
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const FOUND_TTL_MS = 30 * DAY_MS;
export const NOT_FOUND_TTL_MS = 1 * DAY_MS;

export interface CacheKey {
  provider: ProviderName;
  version: number;
  word: string;
  target: CacheTarget;
}

export interface CacheRow extends CacheKey {
  state: 'found' | 'not-found';
  payload: unknown;
  fetchedAt: Date;
  expiresAt: Date;
}

export type BudgetWindow = 'minute' | 'day';
export type BudgetKind = 'guest' | ProviderName;

export interface BudgetItem {
  scope: string;
  window: BudgetWindow;
  cost: number;
  limit: number;
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'session-invalid' }
  | { ok: false; reason: 'exhausted'; kind: BudgetKind | null };

// The shared cache and the budget of the database. Reading returns only rows
// that have not expired at `now`; writing is an idempotent upsert.
export interface DictionaryStore {
  readCache: (word: string, now: Date) => Promise<CacheRow[]>;
  writeCache: (rows: readonly CacheRow[]) => Promise<void>;
  reserve: (
    sessionId: string,
    items: readonly BudgetItem[],
  ) => Promise<ReserveResult>;
}

export interface DictionaryLimits {
  guestReadsPerMinute: number;
  guestLookupsPerMinute: number;
  myMemoryCharsPerDay: number;
  thesaurusPerMinute: number;
}

// Below the published free limits: MyMemory 5000 characters a day without a
// contact (a serverless egress IP may be shared), OpenThesaurus under 60
// requests a minute per IP. A guest may open 60 cards a minute (cached or
// not) and send 10 new words a minute to the providers.
export const DEFAULT_LIMITS: DictionaryLimits = {
  guestReadsPerMinute: 60,
  guestLookupsPerMinute: 10,
  myMemoryCharsPerDay: 4000,
  thesaurusPerMinute: 30,
};

export interface DictionaryDeps {
  store: DictionaryStore;
  providers: DictionaryProviders;
  clock: Clock;
  limits: DictionaryLimits;
}

export interface DictionaryGuest {
  sessionId: string;
  locale: Locale;
}

const MAX_RAW_WORD_CHARS = MAX_WORD_CHARS * 4;

const inputSchema = z.strictObject({
  word: z.string().max(MAX_RAW_WORD_CHARS),
});

const translationPayload = z.strictObject({
  text: z.string().min(1).max(MAX_TRANSLATION_CHARS),
  alternatives: z
    .array(z.string().min(1).max(MAX_TRANSLATION_CHARS))
    .max(MAX_ALTERNATIVES),
});

const lexicalPayload = z.strictObject({
  baseform: z.string().min(1).max(MAX_WORD_CHARS).nullable(),
  synonyms: z.array(z.string().min(1).max(MAX_WORD_CHARS)).max(MAX_SYNONYMS),
});

const EMPTY_PAYLOAD = {};

const keyOf = (
  provider: ProviderName,
  word: string,
  target: CacheTarget,
): CacheKey => ({
  provider,
  version: PROVIDER_VERSION[provider],
  word,
  target,
});

const isRowOf = (row: CacheRow, key: CacheKey): boolean =>
  row.provider === key.provider &&
  row.version === key.version &&
  row.word === key.word &&
  row.target === key.target;

const NO_TRANSLATION = (state: PartState): DictionaryTranslation => ({
  state,
  text: null,
  alternatives: [],
});

const NO_LEXICAL = (state: PartState): DictionaryLexical => ({
  state,
  baseform: null,
  synonyms: [],
});

// A cached row becomes part of the entry only after its payload is checked
// again; a damaged row is a miss, never shown.
const cachedTranslation = (
  row: CacheRow | undefined,
): DictionaryTranslation | null => {
  if (!row) return null;
  if (row.state === 'not-found') return NO_TRANSLATION('not-found');
  const parsed = translationPayload.safeParse(row.payload);
  if (!parsed.success) return null;
  return { state: 'found', ...parsed.data };
};

const cachedLexical = (row: CacheRow | undefined): DictionaryLexical | null => {
  if (!row) return null;
  if (row.state === 'not-found') return NO_LEXICAL('not-found');
  const parsed = lexicalPayload.safeParse(row.payload);
  if (!parsed.success) return null;
  return { state: 'found', ...parsed.data };
};

const translationOf = (outcome: TranslationOutcome): DictionaryTranslation => {
  if (outcome.kind !== 'found') return NO_TRANSLATION(outcome.kind);
  return {
    state: 'found',
    text: outcome.text,
    alternatives: outcome.alternatives,
  };
};

const lexicalOf = (outcome: LexicalOutcome): DictionaryLexical => {
  if (outcome.kind !== 'found') return NO_LEXICAL(outcome.kind);
  return {
    state: 'found',
    baseform: outcome.baseform,
    synonyms: outcome.synonyms,
  };
};

const rowOf = (
  key: CacheKey,
  state: 'found' | 'not-found',
  payload: unknown,
  now: Date,
): CacheRow => {
  const ttlMs = state === 'found' ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
  return {
    ...key,
    state,
    payload,
    fetchedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };
};

// Only a confirmed answer is cached: a found part with its data, or a short
// lived not-found. Unavailable and limited parts are never stored.
const translationRow = (
  key: CacheKey,
  part: DictionaryTranslation,
  now: Date,
): CacheRow | null => {
  if (part.state === 'found' && part.text !== null) {
    const payload = { text: part.text, alternatives: part.alternatives };
    return rowOf(key, 'found', payload, now);
  }
  if (part.state === 'not-found') {
    return rowOf(key, 'not-found', EMPTY_PAYLOAD, now);
  }
  return null;
};

const lexicalRow = (
  key: CacheKey,
  part: DictionaryLexical,
  now: Date,
): CacheRow | null => {
  if (part.state === 'found') {
    const payload = { baseform: part.baseform, synonyms: part.synonyms };
    return rowOf(key, 'found', payload, now);
  }
  if (part.state === 'not-found') {
    return rowOf(key, 'not-found', EMPTY_PAYLOAD, now);
  }
  return null;
};

interface Needs {
  translation: boolean;
  lexical: boolean;
}

const budgetOf = (
  deps: DictionaryDeps,
  guest: DictionaryGuest,
  word: string,
  needs: Needs,
): BudgetItem[] => {
  const { limits } = deps;
  const items: BudgetItem[] = [
    {
      scope: `guest:${guest.sessionId}`,
      window: 'minute',
      cost: 1,
      limit: limits.guestLookupsPerMinute,
    },
  ];
  if (needs.translation) {
    items.push({
      scope: 'mymemory',
      window: 'day',
      cost: [...word].length,
      limit: limits.myMemoryCharsPerDay,
    });
  }
  if (needs.lexical) {
    items.push({
      scope: 'openthesaurus',
      window: 'minute',
      cost: 1,
      limit: limits.thesaurusPerMinute,
    });
  }
  return items;
};

type Reservation =
  | { status: 'session-invalid' }
  | { status: 'reserved'; needs: Needs; limited: Needs };

const NOTHING: Needs = { translation: false, lexical: false };

// All scopes of one call are reserved together or not at all. When one
// provider's budget is used up, the other provider is tried once more on its
// own; a used-up guest budget limits both.
const reserveBudget = async (
  deps: DictionaryDeps,
  guest: DictionaryGuest,
  word: string,
  wanted: Needs,
): Promise<Reservation> => {
  let needs = wanted;
  let limited = NOTHING;
  for (let round = 0; round < 2; round++) {
    const items = budgetOf(deps, guest, word, needs);
    const result = await deps.store.reserve(guest.sessionId, items);
    if (result.ok) return { status: 'reserved', needs, limited };
    if (result.reason === 'session-invalid')
      return { status: 'session-invalid' };
    const isTranslationKind = result.kind === 'mymemory';
    const isLexicalKind = result.kind === 'openthesaurus';
    const isProviderKind = isTranslationKind || isLexicalKind;
    if (!isProviderKind) break;
    limited = {
      translation: limited.translation || isTranslationKind,
      lexical: limited.lexical || isLexicalKind,
    };
    needs = {
      translation: needs.translation && !isTranslationKind,
      lexical: needs.lexical && !isLexicalKind,
    };
    if (!needs.translation && !needs.lexical) break;
  }
  return {
    status: 'reserved',
    needs: NOTHING,
    limited: {
      translation: limited.translation || needs.translation,
      lexical: limited.lexical || needs.lexical,
    },
  };
};

const writeQuietly = async (store: DictionaryStore, rows: CacheRow[]) => {
  if (rows.length === 0) return;
  try {
    await store.writeCache(rows);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code ?? null;
    console.error({ dictionary: 'cache-write', code });
  }
};

const LIMITED_ENTRY = (word: string, target: Locale): DictionaryEntry => ({
  word,
  target,
  translation: NO_TRANSLATION('limited'),
  lexical: NO_LEXICAL('limited'),
});

// Every lookup, a cached one too, passes the database: the function checks
// the guest session again and counts the guest's cards of this minute.
const admitGuest = async (
  deps: DictionaryDeps,
  guest: DictionaryGuest,
): Promise<'admitted' | 'limited' | 'session-invalid'> => {
  const result = await deps.store.reserve(guest.sessionId, [
    {
      scope: `guestread:${guest.sessionId}`,
      window: 'minute',
      cost: 1,
      limit: deps.limits.guestReadsPerMinute,
    },
  ]);
  if (result.ok) return 'admitted';
  return result.reason === 'session-invalid' ? 'session-invalid' : 'limited';
};

const failure = (
  reason: 'invalid-input' | 'invalid-word' | 'session-invalid',
): DictionaryResult => ({ ok: false, failure: reason });

export const lookupWord = async (
  deps: DictionaryDeps,
  guest: DictionaryGuest,
  input: unknown,
): Promise<DictionaryResult> => {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return failure('invalid-input');
  const word = normalizeWord(parsed.data.word);
  if (!word) return failure('invalid-word');

  const target = guest.locale;
  const admission = await admitGuest(deps, guest);
  if (admission === 'session-invalid') return failure('session-invalid');
  if (admission === 'limited') {
    return { ok: true, entry: LIMITED_ENTRY(word, target) };
  }
  const now = deps.clock.now();
  const translationKey = keyOf('mymemory', word, target);
  const lexicalKey = keyOf('openthesaurus', word, 'de');
  const rows = await deps.store.readCache(word, now);
  let translation = cachedTranslation(
    rows.find((row) => isRowOf(row, translationKey)),
  );
  let lexical = cachedLexical(rows.find((row) => isRowOf(row, lexicalKey)));

  const wanted = { translation: !translation, lexical: !lexical };
  if (wanted.translation || wanted.lexical) {
    const reservation = await reserveBudget(deps, guest, word, wanted);
    if (reservation.status === 'session-invalid') {
      return failure('session-invalid');
    }
    const { needs, limited } = reservation;
    const [translated, described] = await Promise.all([
      needs.translation ? deps.providers.translate(word, target) : null,
      needs.lexical ? deps.providers.thesaurus(word) : null,
    ]);
    const fresh: CacheRow[] = [];
    if (translated) {
      translation = translationOf(translated);
      const row = translationRow(translationKey, translation, now);
      if (row) fresh.push(row);
    } else if (limited.translation) {
      translation = NO_TRANSLATION('limited');
    }
    if (described) {
      lexical = lexicalOf(described);
      const row = lexicalRow(lexicalKey, lexical, now);
      if (row) fresh.push(row);
    } else if (limited.lexical) {
      lexical = NO_LEXICAL('limited');
    }
    await writeQuietly(deps.store, fresh);
  }

  const entry: DictionaryEntry = {
    word,
    target,
    translation: translation ?? NO_TRANSLATION('limited'),
    lexical: lexical ?? NO_LEXICAL('limited'),
  };
  return { ok: true, entry };
};
