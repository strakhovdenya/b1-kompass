import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { PracticeSet } from './PracticeSet';

const question = (id: string, number: number): ExamQuestion => ({
  id,
  number,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${number}?`,
  options: [
    { id: 'a', text: 'Erste' },
    { id: 'b', text: 'Zweite' },
  ],
});

const questions = [question('hoeren-1', 1), question('hoeren-2', 2)];

const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PracticeSet
        attemptId="00000000-0000-4000-8000-000000000000"
        questions={questions}
        initialSelections={{ 'hoeren-2': 'a' }}
        saveAnswer={async () => ({ ok: false, error: 'unavailable' })}
      />
    </NextIntlClientProvider>,
  );

describe('PracticeSet', () => {
  it('shows one question with navigation and the answered count', () => {
    const html = render();
    expect(html).toContain('Frage 1?');
    expect(html).not.toContain('Frage 2?');
    expect(html).toContain('Question 1 of 2');
    expect(html).toContain('Answered: 1 of 2');
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain('data-testid="finish-attempt"');
  });

  it('has no review before completion', () => {
    expect(render()).not.toContain('data-testid="attempt-review"');
  });
});
