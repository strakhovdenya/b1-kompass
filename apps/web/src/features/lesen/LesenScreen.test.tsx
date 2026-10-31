import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamQuestion, ExamText } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { LesenScreen, resolveAnchor, splitParagraphs } from './LesenScreen';
import type { ReadingAnchor } from './LesenScreen';

const question = (
  id: string,
  number: number,
  textId: string,
): ExamQuestion => ({
  id,
  number,
  kind: 'single-choice',
  skill: 'lesen',
  teil: 1,
  prompt: `Frage ${id}?`,
  options: [
    { id: 'a', text: 'Erste' },
    { id: 'b', text: 'Zweite' },
  ],
  textId,
});

const text = (id: string, body: string): ExamText => ({
  id,
  title: `Titel ${id}`,
  body,
});

interface RenderOptions {
  questions: ExamQuestion[];
  texts: ExamText[];
  anchor?: ReadingAnchor;
  selections?: Record<string, string>;
}

const render = ({ questions, texts, anchor, selections }: RenderOptions) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LesenScreen
        questions={questions}
        texts={texts}
        initialSelections={selections ?? {}}
        initialAnchor={anchor}
      />
    </NextIntlClientProvider>,
  );

describe('LesenScreen', () => {
  it('missing reading resource never substitutes unrelated text', () => {
    const html = render({
      questions: [question('lesen-1', 1, 'gone')],
      texts: [text('other', 'Fremder Text, der nicht passt.')],
    });
    expect(html).toContain('data-testid="reading-missing"');
    expect(html).not.toContain('Fremder Text');
    expect(html).not.toContain('data-testid="reading-text"');
    expect(html).not.toContain('question-card-lesen-1');
  });

  it('invalid reading anchor has safe fallback', () => {
    const body = 'Erster Absatz.\n\nZweiter Absatz.';
    const base = {
      questions: [question('lesen-1', 1, 't1')],
      texts: [text('t1', body)],
      selections: { 'lesen-1': 'b' },
    };
    const valid = render({ ...base, anchor: { textId: 't1', paragraph: 1 } });
    expect(valid).toContain('data-anchor="1"');
    const invalid = render({
      ...base,
      anchor: { textId: 't1', paragraph: 99 },
    });
    expect(invalid).toContain('data-anchor="0"');
    expect(invalid).toContain('Erster Absatz.');
    expect(invalid).toContain('Zweiter Absatz.');
    expect(invalid).toMatch(
      /<input[^>]*value="b"[^>]*checked|<input[^>]*checked[^>]*value="b"/,
    );
    const foreign = render({
      ...base,
      anchor: { textId: 'unknown', paragraph: 1 },
    });
    expect(foreign).toContain('data-anchor="0"');
    expect(resolveAnchor({ textId: 't1', paragraph: -1 }, 't1', 2)).toBe(0);
    expect(resolveAnchor({ textId: 't1', paragraph: 1.5 }, 't1', 2)).toBe(0);
    expect(resolveAnchor(null, 't1', 2)).toBe(0);
  });

  it('reading text is rendered as plain text', () => {
    const body = '<script>window.hacked = 1</script>\n<b>fett</b>';
    const html = render({
      questions: [question('lesen-1', 1, 't1')],
      texts: [text('t1', body)],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>fett</b>');
    expect(html).toContain('&lt;script&gt;window.hacked = 1&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;fett&lt;/b&gt;');
  });

  it('keeps line breaks inside a paragraph and splits on blank lines', () => {
    expect(splitParagraphs('a\nb\n\nc')).toEqual(['a\nb', 'c']);
  });
});
