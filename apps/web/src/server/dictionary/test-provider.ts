import type { Locale } from '@b1k/domain';
import type {
  DictionaryProviders,
  LexicalOutcome,
  TranslationOutcome,
} from './providers';

// The deterministic replacement of the external HTTP sources for the local
// e2e server only (DICTIONARY_TEST_PROVIDER=1 on a loopback origin, see
// config.ts). It never opens a network connection; auth, cache and budget
// still run for real.

const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  Anzeige: ['Inserat', 'Annonce'],
  Brief: ['Schreiben', 'Zuschrift'],
};

const BASEFORMS: Readonly<Record<string, string>> = {
  gegangen: 'gehen',
};

export const testTranslationOf = (word: string, target: Locale): string =>
  `test-${target}:${word}`;

export const createTestProviders = (): DictionaryProviders => ({
  translate: async (
    word: string,
    target: Locale,
  ): Promise<TranslationOutcome> => ({
    kind: 'found',
    text: testTranslationOf(word, target),
    alternatives: [],
  }),
  thesaurus: async (word: string): Promise<LexicalOutcome> => {
    const synonyms = [...(SYNONYMS[word] ?? [])];
    const baseform = BASEFORMS[word] ?? null;
    if (synonyms.length === 0 && baseform === null)
      return { kind: 'not-found' };
    return { kind: 'found', baseform, synonyms };
  },
});
