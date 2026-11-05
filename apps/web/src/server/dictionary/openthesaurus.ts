import { z } from 'zod';
import { MAX_SYNONYMS } from '../../features/dictionary/entry';
import { normalizeWord } from '../../features/dictionary/word';
import { getProviderJson, logProviderFailure, sameWord } from './providers';
import type { FetchLike, LexicalOutcome } from './providers';

// OpenThesaurus: German synonyms and the base form of one word. Every
// request carries a contact in the User-Agent; the card links the source
// without nofollow. Part of speech, article and plural are not delivered
// reliably, so they are not read at all.
const ENDPOINT = 'https://www.openthesaurus.de/synonyme/search';
const HIDDEN_LEVELS = ['derb', 'vulgär'];

const termSchema = z.object({
  term: z.string(),
  level: z.string().nullable().optional(),
});

const responseSchema = z.object({
  synsets: z.array(z.object({ terms: z.array(z.unknown()) })),
  baseforms: z.array(z.unknown()).nullable().optional(),
});

export const openThesaurusUrl = (word: string): URL => {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', word);
  url.searchParams.set('format', 'application/json');
  url.searchParams.set('baseform', 'true');
  return url;
};

export const userAgentOf = (contact: string): string =>
  `B1Kompass/1.0 (+${contact})`;

const isShown = (level: string | null | undefined): boolean =>
  !level || !HIDDEN_LEVELS.includes(level.toLowerCase());

// Synonyms that are one German word each, so that choosing one opens its own
// lookup; multi-word expressions and the word itself are left out.
const synonymsOf = (
  word: string,
  synsets: readonly { terms: readonly unknown[] }[],
): string[] => {
  const result: string[] = [];
  for (const synset of synsets) {
    for (const item of synset.terms) {
      if (result.length >= MAX_SYNONYMS) return result;
      const parsed = termSchema.safeParse(item);
      if (!parsed.success || !isShown(parsed.data.level)) continue;
      const term = normalizeWord(parsed.data.term);
      if (!term || sameWord(term, word)) continue;
      if (!result.some((seen) => sameWord(seen, term))) result.push(term);
    }
  }
  return result;
};

// The base form only as OpenThesaurus states it in `baseforms`.
const baseformOf = (word: string, baseforms: readonly unknown[]) => {
  for (const item of baseforms) {
    if (typeof item !== 'string') continue;
    const form = normalizeWord(item);
    if (form && !sameWord(form, word)) return form;
  }
  return null;
};

export const parseOpenThesaurus = (
  word: string,
  json: unknown,
): LexicalOutcome => {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return { kind: 'unavailable' };
  const synonyms = synonymsOf(word, parsed.data.synsets);
  const baseform = baseformOf(word, parsed.data.baseforms ?? []);
  if (synonyms.length === 0 && baseform === null) return { kind: 'not-found' };
  return { kind: 'found', baseform, synonyms };
};

export interface OpenThesaurusOptions {
  fetch: FetchLike;
  contact: string;
}

export const createOpenThesaurus = ({
  fetch,
  contact,
}: OpenThesaurusOptions) => {
  const thesaurus = async (word: string): Promise<LexicalOutcome> => {
    const answer = await getProviderJson(fetch, openThesaurusUrl(word), {
      'User-Agent': userAgentOf(contact),
    });
    if (!answer.ok) {
      logProviderFailure('openthesaurus', answer.reason);
      return { kind: 'unavailable' };
    }
    const outcome = parseOpenThesaurus(word, answer.json);
    if (outcome.kind === 'unavailable') {
      logProviderFailure('openthesaurus', 'refused-answer');
    }
    return outcome;
  };
  return { thesaurus };
};
