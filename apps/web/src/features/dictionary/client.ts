import { dictionaryResultSchema } from './entry';
import type { LookupAnswer } from './lookup';

// The one HTTP call of the card: POST /api/dictionary with only the word.
// The guest is the httpOnly cookie; the language comes from the session on
// the server. Nothing in the browser talks to a dictionary provider.

export const DICTIONARY_PATH = '/api/dictionary';

export const requestDictionaryEntry = async (
  word: string,
  signal: AbortSignal,
): Promise<LookupAnswer> => {
  const response = await fetch(DICTIONARY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word }),
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  const parsed = dictionaryResultSchema.safeParse(json);
  if (!parsed.success) return { ok: false, failure: 'unavailable' };
  return parsed.data;
};
