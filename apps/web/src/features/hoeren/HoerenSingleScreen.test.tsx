import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import {
  HoerenSingleScreen,
  selectSingleQuestions,
} from './HoerenSingleScreen';

const question = (
  id: string,
  fields: Partial<ExamQuestion> = {},
): ExamQuestion => ({
  id,
  number: 1,
  kind: 'single-choice',
  skill: 'hoeren',
  teil: 1,
  prompt: `Frage ${id}?`,
  options: [
    { id: 'a', text: 'Erste' },
    { id: 'b', text: 'Zweite' },
  ],
  ...fields,
});

const questions = [
  question('h1', { number: 1, teil: 1 }),
  question('h2', { number: 2, teil: 2 }),
  question('h3', { number: 3, teil: 3, kind: 'true-false' }),
  question('h4', { number: 4, teil: 3 }),
  question('h5', { number: 5, teil: 4, kind: 'shared-choice' }),
  question('l1', { number: 1, skill: 'lesen', teil: 1 }),
];

describe('selectSingleQuestions', () => {
  it('keeps only single-choice Hören of Teil 1 and 2, in order', () => {
    const ids = selectSingleQuestions(questions).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2']);
  });
});

describe('HoerenSingleScreen', () => {
  it('renders the first question and the count of Teil 1–2 only', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HoerenSingleScreen
          attemptId="00000000-0000-4000-8000-000000000000"
          questions={questions}
          trackIds={['track-127']}
          initialSelections={{}}
          initialReview={null}
          resolveAudio={async () => ({ ok: false, error: 'unavailable' })}
          saveAnswer={async () => ({ ok: false, error: 'unavailable' })}
          finishAttempt={async () => ({ ok: false, error: 'unavailable' })}
        />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('Question 1 of 2');
    expect(html).toContain('Frage h1?');
    expect(html).toContain('data-testid="audio-element"');
  });
});
