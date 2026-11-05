import { describe, expect, it } from 'vitest';
import { MAX_WORD_CHARS, normalizeWord, wordAt, wordOfSelection } from './word';

const offsetOf = (text: string, part: string, inside = 1): number => {
  const index = text.indexOf(part);
  if (index === -1) throw new Error(`${part} is not in ${text}`);
  return index + inside;
};

describe('dictionary word', () => {
  it('rejects phrases and nonwords without lookup', () => {
    const refused = [
      '',
      '   ',
      'zwei Wörter',
      'Ich gehe nach Hause',
      '2026',
      '12,50',
      'B1',
      'a',
      'https://example.com',
      'www.example.com',
      'Haus\u0000',
      'Haus​',
      'Ha\nus',
      'Москва',
      'Hausдом',
      'a'.repeat(MAX_WORD_CHARS + 1),
    ];
    for (const value of refused) {
      expect(normalizeWord(value), JSON.stringify(value)).toBeNull();
      expect(wordOfSelection(value), JSON.stringify(value)).toBeNull();
    }
    // A dangling or doubled hyphen is not a word token.
    for (const value of ['x-', 'E--Mail', '-Mail', "'s", 'Haus–Tür']) {
      expect(normalizeWord(value), value).toBeNull();
    }
    // The longest allowed word: 64 letters, within 200 UTF-8 bytes.
    expect(normalizeWord('ẞ'.repeat(MAX_WORD_CHARS))).toBe(
      'ẞ'.repeat(MAX_WORD_CHARS),
    );
    // A caret on a number or between words gives no word.
    const text = 'Am 12. Mai um 18 Uhr.';
    expect(wordAt(text, offsetOf(text, '12'))).toBeNull();
    expect(wordAt(text, offsetOf(text, '18'))).toBeNull();
    expect(wordAt('Ja , nein', 3)).toBeNull();
  });

  it('segments German umlauts and hyphenated compounds', () => {
    const decomposed = 'Lücke';
    expect(normalizeWord(decomposed)).toBe('Lücke');
    expect(normalizeWord('  Straße ')).toBe('Straße');
    expect(normalizeWord('Essen')).toBe('Essen');
    expect(normalizeWord('essen')).toBe('essen');
    expect(normalizeWord('E‑Mail')).toBe('E-Mail');
    expect(normalizeWord('geht’s')).toBe("geht's");

    const title = 'Die Bahnhofs-Ankunft der Größten: E-Mail für Jürgen!';
    expect(wordAt(title, offsetOf(title, 'Bahnhofs'))?.word).toBe(
      'Bahnhofs-Ankunft',
    );
    expect(wordAt(title, offsetOf(title, 'Ankunft', 3))?.word).toBe(
      'Bahnhofs-Ankunft',
    );
    expect(wordAt(title, offsetOf(title, 'Größten', 3))?.word).toBe('Größten');
    expect(wordAt(title, offsetOf(title, 'Mail'))?.word).toBe('E-Mail');
    expect(wordAt(title, offsetOf(title, 'Jürgen', 2))?.word).toBe('Jürgen');
    const span = wordAt(title, offsetOf(title, 'Größten'));
    expect(span && title.slice(span.start, span.end)).toBe('Größten');
    // The caret right after the last letter belongs to the word.
    expect(wordAt('Lücke.', 5)?.word).toBe('Lücke');
    // Two hyphens or a spaced dash do not join words.
    const spaced = 'Hin - und';
    expect(wordAt(spaced, 1)?.word).toBe('Hin');

    expect(wordOfSelection(' „Lücke“, ')).toBe('Lücke');
    expect(wordOfSelection('E-Mail.')).toBe('E-Mail');
  });
});
