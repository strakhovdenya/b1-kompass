import type { Locale } from '@b1k/domain';

// The external dictionaries of the card and the external translation of a
// selected phrase. Every address is built here from a fixed HTTPS base and
// checked text; nothing a provider returned ever becomes a link.

export interface DictionaryLink {
  id: 'dwds' | 'duden' | 'google';
  href: string;
}

export const OPENTHESAURUS_HOME = 'https://www.openthesaurus.de';
export const MYMEMORY_HOME = 'https://mymemory.translated.net';
export const GOOGLE_TRANSLATE_HOME = 'https://translate.google.com/';

// The longest selected fragment handed to Google Translate, in Unicode code
// points (an umlaut or ß counts once).
export const MAX_PHRASE_CODE_POINTS = 300;

const WHITESPACE = /\s+/gu;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const LATIN_LETTER = /(?=\p{L})\p{Script=Latin}/u;

// The selected German fragment as it is sent: NFC, line breaks and runs of
// spaces made one space, trimmed. Null when no Latin letter is left, when it
// carries control or format characters or when it is longer than the limit.
export const normalizePhrase = (raw: string): string | null => {
  const phrase = raw.normalize('NFC').replace(WHITESPACE, ' ').trim();
  if (phrase === '') return null;
  if (CONTROL.test(phrase)) return null;
  if (!LATIN_LETTER.test(phrase)) return null;
  if ([...phrase].length > MAX_PHRASE_CODE_POINTS) return null;
  return phrase;
};

// The Google Translate page for German text in the interface language. The
// host, the path and the parameters are fixed; only the text is encoded in.
export const googleTranslateHref = (
  text: string,
  target: Locale,
): string | null => {
  const phrase = normalizePhrase(text);
  if (!phrase) return null;
  const encoded = encodeURIComponent(phrase);
  return `${GOOGLE_TRANSLATE_HOME}?sl=de&tl=${target}&text=${encoded}&op=translate`;
};

export const dictionaryLinks = (
  word: string,
  target: Locale,
): DictionaryLink[] => {
  const encoded = encodeURIComponent(word);
  const links: DictionaryLink[] = [
    { id: 'dwds', href: `https://www.dwds.de/wb/${encoded}` },
    {
      id: 'duden',
      href: `https://www.duden.de/suchen/dudenonline/${encoded}`,
    },
  ];
  const google = googleTranslateHref(word, target);
  if (google) links.push({ id: 'google', href: google });
  return links;
};
