// One German lexeme for the dictionary: found at a caret position or in a
// selection, normalised and checked. Pure: used by the browser before a
// lookup and by the server before any provider call, so both refuse the same
// input. The material itself is never changed.

export const MAX_WORD_CHARS = 64;
export const MAX_WORD_BYTES = 200;
const MIN_LETTERS = 2;

// A letter of the Latin script (ä, ö, ü, ß included after NFC). Words are
// joined by exactly one hyphen (U+002D, U+2010, U+2011) or an apostrophe
// inside the word; anything else (space, digit, URL, control character,
// another script) is refused.
const LETTER = String.raw`(?:(?=\p{L})\p{Script=Latin})`;
const TOKEN = new RegExp(`^${LETTER}+(?:[-‐‑'’]${LETTER}+)*$`, 'u');
const LETTERS = /\p{L}/gu;
const HYPHENS = /[‐‑]/g;
const APOSTROPHES = /’/g;
const EDGE_NOISE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const HYPHEN_SEGMENT = /^[-‐‑]$/;

const encoder = new TextEncoder();

// The canonical form of one word, or null when the text is not exactly one
// allowed German word. Significant case is kept: Essen and essen differ.
export const normalizeWord = (raw: string): string | null => {
  const word = raw.normalize('NFC').trim();
  if (word === '') return null;
  if ([...word].length > MAX_WORD_CHARS) return null;
  if (encoder.encode(word).byteLength > MAX_WORD_BYTES) return null;
  if (!TOKEN.test(word)) return null;
  if ((word.match(LETTERS) ?? []).length < MIN_LETTERS) return null;
  return word.replace(HYPHENS, '-').replace(APOSTROPHES, "'");
};

// A selection is one word only when, after trimming spaces and the
// punctuation at its edges, it is a valid word: a phrase is refused.
export const wordOfSelection = (selected: string): string | null =>
  normalizeWord(selected.normalize('NFC').replace(EDGE_NOISE, ''));

export interface WordSpan {
  word: string;
  start: number;
  end: number;
}

interface Segment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}

let segmenter: Intl.Segmenter | null = null;

const segmentsOf = (text: string): Segment[] => {
  segmenter ??= new Intl.Segmenter('de', { granularity: 'word' });
  return [...segmenter.segment(text)];
};

const isWord = (segment: Segment | undefined): boolean =>
  segment?.isWordLike === true;

const isHyphen = (segment: Segment | undefined): boolean =>
  segment !== undefined && HYPHEN_SEGMENT.test(segment.segment);

const containing = (segments: Segment[], offset: number): number =>
  segments.findIndex(
    (item) => offset >= item.index && offset < item.index + item.segment.length,
  );

// The word at a caret offset of a text, with word-like neighbours joined
// across exactly one hyphen without spaces (E-Mail, Bahnhofs-Ankunft). A
// caret right after the last letter still belongs to that word.
export const wordAt = (text: string, offset: number): WordSpan | null => {
  const segments = segmentsOf(text);
  let index = containing(segments, offset);
  if (!isWord(segments[index]) && offset > 0) {
    index = containing(segments, offset - 1);
  }
  if (index === -1 || !isWord(segments[index])) return null;
  let first = index;
  let last = index;
  while (isHyphen(segments[first - 1]) && isWord(segments[first - 2])) {
    first -= 2;
  }
  while (isHyphen(segments[last + 1]) && isWord(segments[last + 2])) {
    last += 2;
  }
  const head = segments[first];
  const tail = segments[last];
  if (!head || !tail) return null;
  const start = head.index;
  const end = tail.index + tail.segment.length;
  const word = normalizeWord(text.slice(start, end));
  return word ? { word, start, end } : null;
};
