import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
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

const render = (initialOptionId: string | null) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QuestionCard
        attemptId="00000000-0000-4000-8000-000000000000"
        question={question}
        initialOptionId={initialOptionId}
        saveAnswer={async () => ({ ok: false, error: 'unavailable' })}
      />
    </NextIntlClientProvider>,
  );

describe('QuestionCard', () => {
  it('renders untrusted material as text, never as markup', () => {
    const html = render(null);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('marks the German task and shows the restored answer as saved', () => {
    const html = render('b');
    expect(html).toContain('lang="de"');
    expect(html).toContain('data-status="saved"');
    expect(html).toMatch(/value="b"[^>]*checked|checked[^>]*value="b"/);
  });
});
