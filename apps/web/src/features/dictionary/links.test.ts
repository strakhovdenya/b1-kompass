import { describe, expect, it } from 'vitest';
import {
  GOOGLE_TRANSLATE_HOME,
  MAX_PHRASE_CODE_POINTS,
  checkedPhrase,
  dictionaryLinks,
  googleTranslateHref,
} from './links';

// Characters that must not hide in a source file as invisible bytes.
const COMBINING_DIAERESIS = String.fromCodePoint(0x0308);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const MATHEMATICAL_SCRIPT_A = String.fromCodePoint(0x1d49c);

const paramsOf = (href: string): URLSearchParams => {
  const url = new URL(href);
  expect(url.protocol).toBe('https:');
  expect(url.host).toBe('translate.google.com');
  expect(url.pathname).toBe('/');
  expect(url.username).toBe('');
  expect(url.hash).toBe('');
  return url.searchParams;
};

const textOf = (
  selected: string,
  target: 'en' | 'ru' = 'en',
): string | null => {
  const href = googleTranslateHref(selected, target);
  return href === null ? null : paramsOf(href).get('text');
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
    expect(toRussian.get('sl')).toBe('de');
    expect(toRussian.get('tl')).toBe('ru');
    expect(toRussian.get('text')).toBe(phrase);
    expect([...toEnglish.keys()]).toEqual(['sl', 'tl', 'text', 'op']);
    expect([...toRussian.keys()]).toEqual(['sl', 'tl', 'text', 'op']);

    // Spaces are %20, umlauts and ß UTF-8 percent-encoded, never raw.
    expect(english).toContain(
      'text=Die%20Stra%C3%9Fe%20ist%20f%C3%BCr%20Fu%C3%9Fg%C3%A4nger%20gesperrt',
    );
    expect(english).not.toMatch(/[ äöüß]/u);

    // The limit counts code points: exactly 300 pass, in both languages,
    // with the fixed host, path and parameters.
    const atLimit = 'ä'.repeat(MAX_PHRASE_CODE_POINTS);
    expect(MAX_PHRASE_CODE_POINTS).toBe(300);
    expect(checkedPhrase(atLimit)).toBe(atLimit);
    expect(textOf(atLimit, 'en')).toBe(atLimit);
    expect(textOf(atLimit, 'ru')).toBe(atLimit);
    // A code point outside the BMP counts once, not as two UTF-16 units.
    const astral = `a${MATHEMATICAL_SCRIPT_A}`.repeat(150);
    expect(astral.length).toBe(450);
    expect([...astral]).toHaveLength(300);
    expect(textOf(astral)).toBe(astral);

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

  it('Google translation links send the selected text unchanged', () => {
    // Line breaks, tabs, runs of spaces, spaces at the edges and a
    // decomposed umlaut (u + combining diaeresis) all stay as selected.
    const decomposed = `Mu${COMBINING_DIAERESIS}ller`;
    expect(decomposed).not.toBe('Müller');
    expect(decomposed.normalize('NFC')).toBe('Müller');
    const exact = `  Guten\n\tMorgen,   Frau  ${decomposed}  `;
    expect(checkedPhrase(exact)).toBe(exact);
    for (const target of ['en', 'ru'] as const) {
      expect(textOf(exact, target)).toBe(exact);
    }
    expect(googleTranslateHref(exact, 'en')).toContain(
      'text=%20%20Guten%0A%09Morgen%2C%20%20%20Frau%20%20Mu%CC%88ller%20%20&',
    );

    // A carriage return and Windows line breaks are kept as well.
    const crlf = 'Zeile eins\r\nZeile zwei';
    expect(textOf(crlf)).toBe(crlf);

    // Characters with a meaning in a URL stay inside the text parameter.
    const tricky = 'Preis: 5 € & mehr? #1 a=b/c';
    const params = paramsOf(googleTranslateHref(tricky, 'en') ?? '');
    expect(params.get('text')).toBe(tricky);
    expect(params.get('tl')).toBe('en');
    expect([...params.keys()]).toEqual(['sl', 'tl', 'text', 'op']);
  });

  it('Google translation links refuse unsafe or oversize selections', () => {
    const atLimit = 'ä'.repeat(MAX_PHRASE_CODE_POINTS);
    const refused = [
      '',
      '   ',
      '\n\t',
      '123 456',
      '!!! ...',
      `a${String.fromCodePoint(0)}b`,
      `a${String.fromCodePoint(0x1b)}b`,
      `Haus${ZERO_WIDTH_SPACE}Tür`,
      `Haus${RIGHT_TO_LEFT_OVERRIDE}Tür`,
      `${atLimit}ä`,
      `${atLimit} `,
      ` ${atLimit}`,
    ];
    for (const selected of refused) {
      expect(checkedPhrase(selected), JSON.stringify(selected)).toBeNull();
      expect(googleTranslateHref(selected, 'en')).toBeNull();
      expect(googleTranslateHref(selected, 'ru')).toBeNull();
    }
    // A phrase longer than the limit in code points, not in UTF-16 units.
    const astral = `a${MATHEMATICAL_SCRIPT_A}`.repeat(151);
    expect([...astral]).toHaveLength(302);
    expect(googleTranslateHref(astral, 'en')).toBeNull();
  });
});
