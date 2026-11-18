import { describe, expect, it } from 'vitest';
import {
  GOOGLE_TRANSLATE_HOME,
  MAX_PHRASE_CODE_POINTS,
  dictionaryLinks,
  googleTranslateHref,
  normalizePhrase,
} from './links';

const paramsOf = (href: string): URLSearchParams => {
  const url = new URL(href);
  expect(url.protocol).toBe('https:');
  expect(url.host).toBe('translate.google.com');
  expect(url.pathname).toBe('/');
  expect(url.username).toBe('');
  expect(url.hash).toBe('');
  return url.searchParams;
};

describe('dictionary links', () => {
  it('Google translation links accept bounded German phrases and EN RU targets', () => {
    const phrase = 'Die Straße ist für Fußgänger gesperrt';

    const english = googleTranslateHref(phrase, 'en');
    const russian = googleTranslateHref(phrase, 'ru');
    expect(english).not.toBeNull();
    expect(russian).not.toBeNull();
    const toEnglish = paramsOf(english ?? '');
    const toRussian = paramsOf(russian ?? '');
    expect(english?.startsWith(GOOGLE_TRANSLATE_HOME)).toBe(true);
    expect(toEnglish.get('sl')).toBe('de');
    expect(toEnglish.get('tl')).toBe('en');
    expect(toEnglish.get('op')).toBe('translate');
    expect(toEnglish.get('text')).toBe(phrase);
    expect(toRussian.get('tl')).toBe('ru');
    expect(toRussian.get('text')).toBe(phrase);
    expect([...toEnglish.keys()]).toEqual(['sl', 'tl', 'text', 'op']);

    // Spaces are %20, umlauts and ß UTF-8 percent-encoded, never raw.
    expect(english).toContain(
      'text=Die%20Stra%C3%9Fe%20ist%20f%C3%BCr%20Fu%C3%9Fg%C3%A4nger%20gesperrt',
    );
    expect(english).not.toMatch(/[ äöüß]/u);

    // Characters with a meaning in a URL stay inside the text parameter.
    const tricky = 'Preis: 5 € & mehr? #1 a=b/c';
    const trickyParams = paramsOf(googleTranslateHref(tricky, 'en') ?? '');
    expect(trickyParams.get('text')).toBe(tricky);
    expect(trickyParams.get('tl')).toBe('en');
    expect([...trickyParams.keys()]).toEqual(['sl', 'tl', 'text', 'op']);

    // Line breaks and runs of spaces of a selection become one space; the
    // decomposed umlaut is sent in NFC.
    expect(normalizePhrase('  Guten\n\tMorgen,   Frau  Müller  ')).toBe(
      'Guten Morgen, Frau Müller',
    );

    // The limit counts code points: 300 umlauts pass, 301 do not.
    const atLimit = 'ä'.repeat(MAX_PHRASE_CODE_POINTS);
    expect(MAX_PHRASE_CODE_POINTS).toBe(300);
    expect(normalizePhrase(atLimit)).toBe(atLimit);
    expect(googleTranslateHref(atLimit, 'ru')).not.toBeNull();
    expect(googleTranslateHref(`${atLimit}ä`, 'ru')).toBeNull();
    expect(googleTranslateHref(`${atLimit} `, 'ru')).not.toBeNull();

    // Empty, blank, letterless and control-laden selections give no link.
    for (const refused of [
      '',
      '   ',
      '\n\t',
      '123 456',
      '!!! ...',
      'a\u0000b',
    ]) {
      expect(normalizePhrase(refused)).toBeNull();
      expect(googleTranslateHref(refused, 'en')).toBeNull();
    }
    expect(
      googleTranslateHref(`Haus${String.fromCodePoint(0x200b)}Tür`, 'en'),
    ).toBeNull();

    // The existing link of one word keeps its address.
    const google = dictionaryLinks('Straße', 'ru').find(
      (link) => link.id === 'google',
    );
    expect(google?.href).toBe(
      'https://translate.google.com/?sl=de&tl=ru&text=Stra%C3%9Fe&op=translate',
    );
    expect(dictionaryLinks('Straße', 'en').map((link) => link.id)).toEqual([
      'dwds',
      'duden',
      'google',
    ]);
  });
});
