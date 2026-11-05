import type { Locale } from '@b1k/domain';

// The external dictionaries of the card. Every address is built here from a
// fixed HTTPS base and the checked word; nothing a provider returned ever
// becomes a link.

export interface DictionaryLink {
  id: 'dwds' | 'duden' | 'google';
  href: string;
}

export const OPENTHESAURUS_HOME = 'https://www.openthesaurus.de';
export const MYMEMORY_HOME = 'https://mymemory.translated.net';

export const dictionaryLinks = (
  word: string,
  target: Locale,
): DictionaryLink[] => {
  const encoded = encodeURIComponent(word);
  return [
    { id: 'dwds', href: `https://www.dwds.de/wb/${encoded}` },
    {
      id: 'duden',
      href: `https://www.duden.de/suchen/dudenonline/${encoded}`,
    },
    {
      id: 'google',
      href: `https://translate.google.com/?sl=de&tl=${target}&text=${encoded}&op=translate`,
    },
  ];
};
