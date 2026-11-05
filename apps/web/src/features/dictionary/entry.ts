import { z } from 'zod';
import { LOCALES } from '@b1k/domain';
import type { Locale } from '@b1k/domain';
import { MAX_WORD_CHARS } from './word';

// The one dictionary DTO shared by the server and the card. It names no
// provider address and carries no session data: only the word, the target
// language of the guest and what the sources confirmed. Grammar the sources
// do not deliver (article, plural, part of speech) is not part of it.

export const MAX_TRANSLATION_CHARS = 200;
export const MAX_ALTERNATIVES = 4;
export const MAX_SYNONYMS = 8;

// found: confirmed data; not-found: the source answered without data;
// unavailable: the source failed; limited: the shared budget was used up.
export const PART_STATES = [
  'found',
  'not-found',
  'unavailable',
  'limited',
] as const;
export type PartState = (typeof PART_STATES)[number];

export interface DictionaryTranslation {
  state: PartState;
  text: string | null;
  alternatives: string[];
}

export interface DictionaryLexical {
  state: PartState;
  baseform: string | null;
  synonyms: string[];
}

export interface DictionaryEntry {
  word: string;
  target: Locale;
  translation: DictionaryTranslation;
  lexical: DictionaryLexical;
}

export const DICTIONARY_FAILURES = [
  'invalid-input',
  'invalid-word',
  'session-invalid',
  'unavailable',
] as const;
export type DictionaryFailure = (typeof DICTIONARY_FAILURES)[number];

export type DictionaryResult =
  | { ok: true; entry: DictionaryEntry }
  | { ok: false; failure: DictionaryFailure };

const shortText = z.string().min(1).max(MAX_TRANSLATION_CHARS);
const germanWord = z
  .string()
  .min(1)
  .max(MAX_WORD_CHARS * 2);

export const dictionaryEntrySchema = z.strictObject({
  word: germanWord,
  target: z.enum(LOCALES),
  translation: z.strictObject({
    state: z.enum(PART_STATES),
    text: shortText.nullable(),
    alternatives: z.array(shortText).max(MAX_ALTERNATIVES),
  }),
  lexical: z.strictObject({
    state: z.enum(PART_STATES),
    baseform: germanWord.nullable(),
    synonyms: z.array(germanWord).max(MAX_SYNONYMS),
  }),
});

export const dictionaryResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), entry: dictionaryEntrySchema }),
  z.strictObject({
    ok: z.literal(false),
    failure: z.enum(DICTIONARY_FAILURES),
  }),
]);
