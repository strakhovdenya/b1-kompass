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

const render = (index: number, locale: 'en' | 'ru' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? messages : ruMessages}
    >
      <QuestionNavigator
        steps={steps}
        index={index}
        isDisabled={false}
        onSelect={() => undefined}
      />
    </NextIntlClientProvider>,
  );

const buttonOf = (html: string, number: number): string =>
  new RegExp(
    String.raw`<button[^>]*data-testid="go-to-question-${number}"[^>]*>[\s\S]*?</button>`,
  ).exec(html)?.[0] ?? '';

describe('QuestionNavigator', () => {
  it('shows the position and a closed list button for a phone', () => {
    const html = render(0);
    expect(html).toContain('Question 1 of 3');
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
});
