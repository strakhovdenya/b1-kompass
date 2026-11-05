import { wordAt, wordOfSelection } from './word';

// Reading a word out of the page without changing it: the caret position
// under a point, or the current selection, inside a German text zone of the
// dictionary boundary. The Range is kept so the card can follow the word.

export const ZONE_ATTRIBUTE = 'data-dictionary-text';
const ZONE_SELECTOR = `[${ZONE_ATTRIBUTE}]`;
const HIT_TOLERANCE_PX = 1;

export interface WordHit {
  word: string;
  range: Range;
}

interface Caret {
  node: Node;
  offset: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const caretAt = (x: number, y: number): Caret | null => {
  const doc = document as CaretDocument;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    return position
      ? { node: position.offsetNode, offset: position.offset }
      : null;
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    return range
      ? { node: range.startContainer, offset: range.startOffset }
      : null;
  }
  return null;
};

const elementOf = (node: Node | null): Element | null => {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
};

export const zoneOf = (node: Node | null, root: Element): Element | null => {
  const zone = elementOf(node)?.closest(ZONE_SELECTOR) ?? null;
  return zone && root.contains(zone) ? zone : null;
};

const contains = (rect: DOMRect, x: number, y: number): boolean =>
  x >= rect.left - HIT_TOLERANCE_PX &&
  x <= rect.right + HIT_TOLERANCE_PX &&
  y >= rect.top - HIT_TOLERANCE_PX &&
  y <= rect.bottom + HIT_TOLERANCE_PX;

// The word under a point, only when the point is really over its letters:
// the caret snaps to the nearest text at a line end, which is not a hit.
export const wordAtPoint = (
  x: number,
  y: number,
  root: Element,
): WordHit | null => {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
  if (!zoneOf(caret.node, root)) return null;
  const text = caret.node.textContent ?? '';
  const span = wordAt(text, caret.offset);
  if (!span) return null;
  const range = document.createRange();
  range.setStart(caret.node, span.start);
  range.setEnd(caret.node, span.end);
  const isHit = Array.from(range.getClientRects()).some((rect) =>
    contains(rect, x, y),
  );
  return isHit ? { word: span.word, range } : null;
};

// The selection as one word of one German zone; a phrase, a selection
// across zones or outside the boundary gives nothing.
export const wordOfCurrentSelection = (root: Element): WordHit | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const zone = zoneOf(range.commonAncestorContainer, root);
  if (!zone) return null;
  const word = wordOfSelection(selection.toString());
  return word ? { word, range: range.cloneRange() } : null;
};
