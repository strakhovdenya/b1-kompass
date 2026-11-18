import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import { QuestionNavigator } from './QuestionNavigator';
import type { NavigatorStep } from './QuestionNavigator';

const steps: NavigatorStep[] = [
  { key: 'q1', label: '1', number: 1, count: 1, teil: 1, progress: 'answered' },
  { key: 'q2', label: '2', number: 2, count: 1, teil: 1, progress: 'empty' },
  {
    key: 'pair',
    label: '3–4',
    number: 3,
    count: 2,
    teil: 3,
    progress: 'partial',
  },
];

const renderSteps = (
  list: readonly NavigatorStep[],
  index: number,
  locale: 'en' | 'ru' = 'en',
) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? messages : ruMessages}
    >
      <QuestionNavigator
        steps={list}
        index={index}
        isDisabled={false}
        onSelect={() => undefined}
      />
    </NextIntlClientProvider>,
  );

const render = (index: number, locale: 'en' | 'ru' = 'en') =>
  renderSteps(steps, index, locale);

const buttonOf = (html: string, number: number): string =>
  new RegExp(
    String.raw`<button[^>]*data-testid="go-to-question-${number}"[^>]*>[\s\S]*?</button>`,
  ).exec(html)?.[0] ?? '';

describe('QuestionNavigator', () => {
  it('shows the position and a closed list button for a phone', () => {
    const html = render(0);
    expect(html).toContain('Question 1 of 4');
    const toggle = /<button[^>]*data-testid="navigator-toggle"[^>]*>/.exec(
      html,
    );
    expect(toggle?.[0]).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(toggle?.[0] ?? '')?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    // The current exam task of the step is named on the button.
    expect(html).toContain('All questions (1)');
    expect(render(2)).toContain('All questions (3–4)');
  });

  it('keeps every step reachable by its test id, a pair as one step', () => {
    const html = render(0);
    expect(html.match(/data-testid="go-to-question-\d+"/g)).toEqual([
      'data-testid="go-to-question-1"',
      'data-testid="go-to-question-2"',
      'data-testid="go-to-question-3"',
    ]);
    expect(buttonOf(html, 3)).toContain('3–4');
    expect(html).toContain('aria-label="Teil 1"');
    expect(html).toContain('aria-label="Teil 3"');
  });

  it('tells current, answered and empty steps apart without colour', () => {
    const html = render(1);
    expect(buttonOf(html, 2)).toContain('aria-current="step"');
    expect(buttonOf(html, 1)).not.toContain('aria-current');
    expect(buttonOf(html, 1)).toContain('Go to question 1, answered');
    expect(buttonOf(html, 1)).toContain('✓');
    expect(buttonOf(html, 2)).toContain('Go to question 2, not answered');
    expect(buttonOf(html, 2)).not.toContain('✓');
    expect(buttonOf(html, 3)).toContain('Go to questions 3–4, partly answered');
    expect(buttonOf(html, 3)).toContain('data-progress="partial"');
  });

  it('names the step states in Russian too', () => {
    const html = render(0, 'ru');
    expect(buttonOf(html, 1)).toContain('Перейти к вопросу 1, отвечено');
    expect(buttonOf(html, 2)).toContain('Перейти к вопросу 2, без ответа');
  });

  it('position counts real questions for grouped and single steps in both locales', () => {
    const hoeren: NavigatorStep[] = [
      {
        key: 'h1',
        label: '1',
        number: 1,
        count: 1,
        teil: 1,
        progress: 'empty',
      },
      {
        key: 'h2',
        label: '2',
        number: 2,
        count: 1,
        teil: 2,
        progress: 'empty',
      },
      {
        key: 'pair',
        label: '3–4',
        number: 3,
        count: 2,
        teil: 3,
        progress: 'empty',
      },
      {
        key: 'set',
        label: '5–7',
        number: 5,
        count: 3,
        teil: 4,
        progress: 'empty',
      },
    ];
    const position = (index: number, locale: 'en' | 'ru') =>
      /data-testid="set-position"[^>]*>([^<]*)</.exec(
        renderSteps(hoeren, index, locale),
      )?.[1];
    expect(position(0, 'en')).toBe('Question 1 of 7');
    expect(position(2, 'en')).toBe('Questions 3–4 of 7');
    expect(position(3, 'en')).toBe('Questions 5–7 of 7');
    expect(position(0, 'ru')).toBe('Вопрос 1 из 7');
    expect(position(2, 'ru')).toBe('Вопросы 3–4 из 7');
    expect(position(3, 'ru')).toBe('Вопросы 5–7 из 7');
  });

  it('single Lesen and grouped Hoeren keep unique navigator buttons', () => {
    const lesen: NavigatorStep[] = Array.from({ length: 25 }, (_, index) => ({
      key: `l${index + 1}`,
      label: `${index + 1}`,
      number: index + 1,
      count: 1,
      teil: Math.floor(index / 5) + 1,
      progress: 'empty' as const,
    }));
    const html = renderSteps(lesen, 24);
    expect(html).toContain('Question 25 of 25');
    const lesenIds = html.match(/data-testid="go-to-question-\d+"/g) ?? [];
    expect(lesenIds).toHaveLength(25);
    expect(new Set(lesenIds).size).toBe(25);

    // The second number of a pair has no button of its own.
    const grouped = render(2);
    expect(grouped).not.toContain('data-testid="go-to-question-4"');
    expect(grouped.match(/data-testid="go-to-question-3"/g)).toHaveLength(1);
  });
});
