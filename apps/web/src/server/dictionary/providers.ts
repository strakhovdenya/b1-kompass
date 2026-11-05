import type { Locale } from '@b1k/domain';
import { MAX_TRANSLATION_CHARS } from '../../features/dictionary/entry';

// The contract of the external sources. An adapter never throws: a failed,
// refused or untrusted answer is 'unavailable', an answer without data is
// 'not-found', and only checked data is 'found'.

export type TranslationOutcome =
  | { kind: 'found'; text: string; alternatives: string[] }
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

export type LexicalOutcome =
  | { kind: 'found'; baseform: string | null; synonyms: string[] }
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

export interface DictionaryProviders {
  translate: (word: string, target: Locale) => Promise<TranslationOutcome>;
  thesaurus: (word: string) => Promise<LexicalOutcome>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const PROVIDER_TIMEOUT_MS = 4000;
export const MAX_PROVIDER_BYTES = 64 * 1024;

export type ProviderFailure =
  'http-limited' | 'http-error' | 'not-json' | 'too-large' | 'network';

export type ProviderJson =
  { ok: true; json: unknown } | { ok: false; reason: ProviderFailure };

const isJsonType = (value: string | null): boolean => {
  const type = value?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
};

const readLimited = async (response: Response): Promise<string | null> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sizeBytes += value.byteLength;
    if (sizeBytes > MAX_PROVIDER_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

// One GET to a fixed HTTPS address: a 4 s timeout, no redirects, no retry,
// at most 64 KB of JSON. Nothing of the guest (cookie, IP, id) is sent.
export const getProviderJson = async (
  fetchFn: FetchLike,
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<ProviderJson> => {
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  try {
    if (response.status === 429) {
      await response.body?.cancel();
      return { ok: false, reason: 'http-limited' };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, reason: 'http-error' };
    }
    if (!isJsonType(response.headers.get('content-type'))) {
      await response.body?.cancel();
      return { ok: false, reason: 'not-json' };
    }
    const text = await readLimited(response);
    if (text === null) return { ok: false, reason: 'too-large' };
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'not-json' };
  }
};

// Operational failures are logged without the word, the guest or the body.
export const logProviderFailure = (provider: string, reason: string) => {
  console.warn({ dictionary: provider, failure: reason });
};

const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/u;
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\bjavascript:|\bdata:)/i;
const SPACES = /\s+/g;

// A provider string that may be shown to the guest: one line of plain text,
// no control characters, no links, limited length. React escapes it; this
// refuses what is not a translation at all.
export const cleanProviderText = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').replace(SPACES, ' ').trim();
  // UTF-16 length, the same measure as the DTO schemas.
  if (text === '' || text.length > MAX_TRANSLATION_CHARS) return null;
  if (CONTROL.test(text) || LINK.test(text)) return null;
  return text;
};

export const sameWord = (left: string, right: string): boolean =>
  left.normalize('NFC').trim().toLocaleLowerCase('de') ===
  right.normalize('NFC').trim().toLocaleLowerCase('de');
