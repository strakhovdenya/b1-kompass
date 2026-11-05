import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { DictionaryActiveContext } from '../dictionary/GermanText';
import { QuestionCard } from './QuestionCard';

const PAYLOAD = '<img src=x onerror="alert(1)">';

const question: ExamQuestion = {
  id: 'hoeren-1',
  number: 1,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${PAYLOAD}`,
  options: [
    { id: 'a', text: `<script>alert(2)</script>` },
    { id: 'b', text: 'Antwort' },
  ],
};

const render = (initialOptionId: string | null, isDictionaryOn = false) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DictionaryActiveContext.Provider value={isDictionaryOn}>
        <QuestionCard
          question={question}
          selectedOptionId={initialOptionId}
          onChoose={() => undefined}
        />
      </DictionaryActiveContext.Provider>
    </NextIntlClientProvider>,
  );

// The text of each answer label without tags: the accessible name of its
// radio.
const labelTexts = (html: string): string[] =>
  [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)]
    .map((match) =>
      (match[1] ?? '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
        .replace(/<[^>]+>/g, ''),
    )
    .filter((text) => text.trim() !== '');

describe('QuestionCard', () => {
  it('renders untrusted material as text, never as markup', () => {
    const html = render(null);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('marks German words for the dictionary without changing the answers', () => {
    const plain = render('b');
    const marked = render('b', true);
    // The words of the task and of each option are one zone each, never
    // separate elements or tab stops.
    expect(plain).not.toContain('data-dictionary-text');
    expect(marked.match(/data-dictionary-text=""/g)).toHaveLength(3);
    expect(marked).not.toMatch(/data-dictionary-text=""[^>]*tabindex/);
    expect(marked.match(/tabindex/g)?.length ?? 0).toBe(
      plain.match(/tabindex/g)?.length ?? 0,
    );
    // The radios, their values, the restored choice and the accessible names
    // are the same with and without the dictionary.
    expect(marked.match(/type="radio"/g)).toHaveLength(2);
    expect(marked).toMatch(/value="b"[^>]*checked|checked[^>]*value="b"/);
    expect(labelTexts(marked)).toEqual(labelTexts(plain));
    expect(labelTexts(marked)).toContain('b Antwort');
    expect(marked).toContain('data-status="saved"');
  });

  it('marks the German task and shows the restored answer as saved', () => {
    const html = render('b');
    expect(html).toContain('lang="de"');
    expect(html).toContain('data-status="saved"');
    expect(html).toMatch(/value="b"[^>]*checked|checked[^>]*value="b"/);
  });
});
