import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamQuestion, ExamText } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { DictionaryActiveContext } from '../dictionary/GermanText';
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
  isDictionaryOn?: boolean;
}

const render = ({
  questions,
  texts,
  anchor,
  selections,
  isDictionaryOn = false,
}: RenderOptions) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DictionaryActiveContext.Provider value={isDictionaryOn}>
        <LesenScreen
          questions={questions}
          texts={texts}
          initialSelections={selections ?? {}}
          initialAnchor={anchor}
        />
      </DictionaryActiveContext.Provider>
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

  it('dictionary zones keep the reading anchor and both narrow panels', () => {
    const body = 'Erster Absatz mit Lücke.\n\nZweiter Absatz: E-Mail.';
    const options = {
      questions: [question('lesen-1', 1, 't1')],
      texts: [text('t1', body)],
      anchor: { textId: 't1', paragraph: 1 },
    };
    const plain = render(options);
    const marked = render({ ...options, isDictionaryOn: true });
    expect(marked).toContain('data-anchor="1"');
    expect(marked.match(/data-paragraph="\d"/g)).toEqual([
      'data-paragraph="0"',
      'data-paragraph="1"',
    ]);
    // Title, two paragraphs, the task and two options are zones.
    expect(marked.match(/data-dictionary-text=""/g)).toHaveLength(6);
    expect(plain).not.toContain('data-dictionary-text');
    // The text is unchanged: only the zone wrappers are added.
    const strip = (html: string) => html.replace(/<[^>]+>/g, '');
    expect(strip(marked)).toBe(strip(plain));
    expect(marked).toContain('data-testid="lesen-view-text"');
    expect(marked).toContain('data-testid="lesen-view-questions"');
    expect(marked).toContain('data-testid="reading-text"');
  });

  it('uses the shared navigator with the reading typography', () => {
    const html = render({
      questions: [question('lesen-1', 1, 't1'), question('lesen-2', 2, 't1')],
      texts: [text('t1', 'Erster Absatz.')],
      selections: { 'lesen-2': 'a' },
    });
    expect(html.match(/data-testid="navigator-toggle"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="go-to-question-1"');
    expect(html).toMatch(
      /<button[^>]*aria-current="step"[^>]*data-testid="go-to-question-1"|data-testid="go-to-question-1"[^>]*aria-current="step"/,
    );
    expect(html).toMatch(
      /data-testid="go-to-question-2"[^>]*data-progress="answered"|data-progress="answered"[^>]*data-testid="go-to-question-2"/,
    );
    expect(html).toContain('Question 1 of 2');
    expect(html).toMatch(/<p[^>]*data-paragraph="0"/);
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

describe('LesenScreen in a repeat of errors', () => {
  it('keeps the whole linked text with only the assessed task of it', () => {
    const html = render({
      questions: [question('lesen-2', 2, 'text-1')],
      texts: [text('text-1', 'Der ganze Text bleibt sichtbar.')],
    });
    expect(html).toContain('Der ganze Text bleibt sichtbar.');
    expect(html).toContain('data-testid="question-card-lesen-2"');
    expect(html).not.toContain('question-card-lesen-1');
    expect(html).not.toContain('context-card-');
    expect(html).toContain('Answered: 0 of 1');
  });
});
