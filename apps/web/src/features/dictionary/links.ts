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

// Control characters other than the line break and tab a multi-line
// selection legitimately carries, and invisible format characters (zero
// width space, bidi marks) never belong to a selected phrase.
const UNWANTED = /[^\P{Cc}\t\n\r]|\p{Cf}/u;
const LATIN_LETTER = /(?=\p{L})\p{Script=Latin}/u;

// The selected German fragment, exactly as the guest selected it. Null when
// it is blank, holds no Latin letter, carries control or format characters
// or is longer than the limit; a fragment that passes is never rewritten.
export const checkedPhrase = (selected: string): string | null => {
  if (selected.trim() === '') return null;
  if (UNWANTED.test(selected)) return null;
  if (!LATIN_LETTER.test(selected)) return null;
  if ([...selected].length > MAX_PHRASE_CODE_POINTS) return null;
  return selected;
};

// The Google Translate page for the selected German text in the interface
// language. The host, the path and the parameters are fixed; only the text,
// unchanged, is percent-encoded into it.
export const googleTranslateHref = (
  text: string,
  target: Locale,
): string | null => {
  const phrase = checkedPhrase(text);
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
