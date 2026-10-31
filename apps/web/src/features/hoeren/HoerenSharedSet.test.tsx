import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { ExamGroup, ExamQuestion } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { HoerenSharedSetView } from './HoerenSharedSetView';

const OPTIONS = [
  { id: 'a', text: 'Erste Aussage' },
  { id: 'b', text: 'Zweite Aussage' },
];

const question = (id: string, number: number): ExamQuestion => ({
  id,
  number,
  kind: 'shared-choice',
  skill: 'hoeren',
  teil: 4,
  prompt: `Frage ${number}?`,
  options: OPTIONS,
});

const group = (fields: Partial<ExamGroup> = {}): ExamGroup =>
  ({
    id: 'g',
    kind: 'shared-set',
    teil: 4,
    trackId: 'track',
    options: OPTIONS,
    questionIds: ['q1', 'q2'],
    ...fields,
  }) as ExamGroup;

const render = (setGroup: ExamGroup, questions: ExamQuestion[]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HoerenSharedSetView
        group={setGroup}
        questions={questions}
        cards={questions.map((item) => (
          <p key={item.id}>
            {item.prompt} {item.options.map((option) => option.text).join(' ')}
          </p>
        ))}
      />
    </NextIntlClientProvider>,
  );

describe('HoerenSharedSetView', () => {
  it('shows every card of a valid set under one legend', () => {
    const html = render(group(), [question('q1', 18), question('q2', 19)]);
    expect(html).toContain('questions 18 to 19');
    expect(html).toContain('Frage 18?');
    expect(html).toContain('Frage 19?');
    expect(html).not.toContain('role="alert"');
  });

  it('invalid shared pool is reported without substitution', () => {
    const noOptions = render(group({ options: [] } as Partial<ExamGroup>), [
      question('q1', 18),
      question('q2', 19),
    ]);
    const outsideMaterial = render(group({ questionIds: ['q1', 'ghost'] }), [
      question('q1', 18),
    ]);
    for (const html of [noOptions, outsideMaterial]) {
      expect(html).toContain('role="alert"');
      expect(html).toContain(messages.hoeren.sharedSetError);
      expect(html).not.toContain('Erste Aussage');
      expect(html).not.toContain('Frage 18?');
    }
  });
});
