import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamGroup, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import {
  HoerenSingleScreen,
  selectQuestions,
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
        <HoerenSingleScreen questions={questions} initialSelections={{}} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('Question 1 of 2');
    expect(html).toContain('Frage h1?');
    expect(html).not.toContain('data-testid="audio-element"');
    expect(html).not.toContain('Finish');
  });
});

const pair: ExamGroup = {
  id: 'pair-3',
  kind: 'pair',
  teil: 3,
  trackId: 'track-127',
  questionIds: ['h3', 'h4'],
};

describe('selectQuestions', () => {
  it('adds the members of a Teil 3 pair to the single questions', () => {
    const ids = selectQuestions(questions, [pair]).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('leaves out a pair with a member missing from the material', () => {
    const broken = { ...pair, questionIds: ['h3', 'missing'] };
    const ids = selectQuestions(questions, [broken]).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2']);
  });

  it('ignores pairs of another Teil or of another size', () => {
    const otherTeil = { ...pair, teil: 2 };
    const threeMembers = { ...pair, questionIds: ['h3', 'h4', 'h5'] };
    for (const group of [otherTeil, threeMembers]) {
      const ids = selectQuestions(questions, [group]).map((item) => item.id);
      expect(ids).toEqual(['h1', 'h2']);
    }
  });

  it('adds the members of the Teil 4 shared set', () => {
    const shared: ExamGroup = {
      id: 'set-4',
      kind: 'shared-set',
      teil: 4,
      trackId: 'track-127',
      options: [
        { id: 'a', text: 'Erste' },
        { id: 'b', text: 'Zweite' },
      ],
      questionIds: ['h5'],
    };
    const ids = selectQuestions(questions, [shared]).map((item) => item.id);
    expect(ids).toEqual(['h1', 'h2', 'h5']);
  });
});

describe('HoerenSingleScreen with a pair', () => {
  const renderAt = (initial: Record<string, string>) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <HoerenSingleScreen
          questions={questions}
          groups={[pair]}
          initialSelections={initial}
        />
      </NextIntlClientProvider>,
    );

  it('counts the pair as one step and every member as an answer', () => {
    const html = renderAt({ h1: 'a', h3: 'b' });
    expect(html).toContain('Question 1 of 3');
    expect(html).toContain('Answered: 2 of 4');
    expect(html).toContain('data-testid="go-to-question-3"');
  });
});

describe('HoerenSingleScreen introduction', () => {
  const intro = (
    shown: ExamQuestion[],
    groups: ExamGroup[] = [],
    locale: 'en' | 'ru' = 'en',
  ) => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === 'en' ? messages : ruMessages}
      >
        <HoerenSingleScreen
          questions={shown}
          groups={groups}
          initialSelections={{}}
        />
      </NextIntlClientProvider>,
    );
    const start = html.indexOf('Hören,');
    return html.slice(start, html.indexOf('</p>', start));
  };

  const shared: ExamGroup = {
    id: 'set-4',
    kind: 'shared-set',
    teil: 4,
    trackId: 'track-127',
    options: [
      { id: 'a', text: 'Erste' },
      { id: 'b', text: 'Zweite' },
    ],
    questionIds: ['h5'],
  };

  it('intro names only the parts of a short set', () => {
    const short = [
      question('h1', { number: 1, teil: 1 }),
      question('h2', { number: 2, teil: 1 }),
    ];
    const text = intro(short, [pair, shared]);
    expect(text).toContain('Hören, part 1: 2 questions');
    for (const missing of ['parts', 'part 3', 'part 4', 'a–f']) {
      expect(text).not.toContain(missing);
    }
    const russian = intro(short, [pair, shared], 'ru');
    expect(russian).toContain('Hören, часть 1: 2 задания');
    expect(russian).not.toContain('части');
    expect(russian).not.toContain('a–f');
  });

  it('intro names pair and shared set of a full set', () => {
    const text = intro(questions, [pair, shared]);
    expect(text).toContain('Hören, parts 1 to 4: 5 questions');
    expect(text).toContain('In part 3 the two questions of one conversation');
    expect(text).toContain('In part 4 the whole list of statements a–f');
    const russian = intro(questions, [pair, shared], 'ru');
    expect(russian).toContain('Hören, части 1–4: 5 заданий');
    expect(russian).toContain('В части 3');
    expect(russian).toContain('В части 4');
  });

  it('intro omits the shared set when part 4 is missing', () => {
    const text = intro(questions, [pair]);
    expect(text).toContain('Hören, parts 1 to 3: 4 questions');
    expect(text).toContain('In part 3 the two questions of one conversation');
    expect(text).not.toContain('part 4');
    expect(text).not.toContain('a–f');
  });

  it('hoeren intro keys exist in both languages', () => {
    expect(Object.keys(ruMessages.hoeren).sort()).toEqual(
      Object.keys(messages.hoeren).sort(),
    );
  });

  it('intro of a single question has no missing parts', () => {
    const text = intro([question('h1', { number: 1, teil: 1 })], [pair]);
    expect(text).toContain('Hören, part 1: 1 question,');
    expect(text).not.toContain('questions');
    expect(text).not.toContain('part 3');
  });
});
