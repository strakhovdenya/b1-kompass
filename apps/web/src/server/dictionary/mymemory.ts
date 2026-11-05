import { z } from 'zod';
import type { Locale } from '@b1k/domain';
import { MAX_ALTERNATIVES } from '../../features/dictionary/entry';
import {
  cleanProviderText,
  getProviderJson,
  logProviderFailure,
  sameWord,
} from './providers';
import type { FetchLike, TranslationOutcome } from './providers';

// MyMemory, the documented GET of one word: q, langpair de|en or de|ru, mt=1
// and the optional contact `de`. The ip parameter and X-Forwarded-For are
// never sent, so the provider never sees the guest.
const ENDPOINT = 'https://api.mymemory.translated.net/get';
const WARNING = 'MYMEMORY WARNING';
const OK_STATUS = 200;

const responseSchema = z.object({
  responseData: z.object({ translatedText: z.unknown() }).nullable(),
  responseStatus: z.union([z.number(), z.string()]),
  quotaFinished: z.boolean().nullable().optional(),
  matches: z.array(z.unknown()).nullable().optional(),
});

const matchSchema = z.object({ segment: z.string(), translation: z.string() });

export const myMemoryUrl = (
  word: string,
  target: Locale,
  contactEmail: string | null,
): URL => {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', word);
  url.searchParams.set('langpair', `de|${target}`);
  url.searchParams.set('mt', '1');
  if (contactEmail) url.searchParams.set('de', contactEmail);
  return url;
};

const isWarning = (text: unknown): boolean =>
  typeof text === 'string' && text.toUpperCase().includes(WARNING);

// Other translations of exactly this word from the matches, never of a
// longer segment that only contains it.
const alternativesOf = (
  word: string,
  primary: string,
  matches: readonly unknown[],
): string[] => {
  const result: string[] = [];
  for (const item of matches) {
    if (result.length >= MAX_ALTERNATIVES) break;
    const parsed = matchSchema.safeParse(item);
    if (!parsed.success || !sameWord(parsed.data.segment, word)) continue;
    const text = cleanProviderText(parsed.data.translation);
    if (!text || isWarning(text) || sameWord(text, word)) continue;
    const isKnown = [primary, ...result].some((seen) => sameWord(seen, text));
    if (!isKnown) result.push(text);
  }
  return result;
};

// A trusted translation or nothing: a finished quota, a non-200 status, a
// warning instead of a translation or the source word echoed back are never
// a translation and are never cached as one.
export const parseMyMemory = (
  word: string,
  json: unknown,
): TranslationOutcome => {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { kind: 'unavailable' };
  const { responseData, responseStatus, quotaFinished, matches } = parsed.data;
  if (quotaFinished === true) return { kind: 'unavailable' };
  if (Number(responseStatus) !== OK_STATUS) return { kind: 'unavailable' };
  const raw = responseData?.translatedText;
  if (isWarning(raw)) return { kind: 'unavailable' };
  const text = cleanProviderText(raw);
  if (!text || sameWord(text, word)) return { kind: 'not-found' };
  return {
    kind: 'found',
    text,
    alternatives: alternativesOf(word, text, matches ?? []),
  };
};

export interface MyMemoryOptions {
  fetch: FetchLike;
  contactEmail: string | null;
}

export const createMyMemory = ({ fetch, contactEmail }: MyMemoryOptions) => {
  const translate = async (
    word: string,
    target: Locale,
  ): Promise<TranslationOutcome> => {
    const url = myMemoryUrl(word, target, contactEmail);
    const answer = await getProviderJson(fetch, url, {});
    if (!answer.ok) {
      logProviderFailure('mymemory', answer.reason);
      return { kind: 'unavailable' };
    }
    const outcome = parseMyMemory(word, answer.json);
    if (outcome.kind === 'unavailable') {
      logProviderFailure('mymemory', 'refused-answer');
    }
    return outcome;
  };
  return { translate };
};
