import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import enMessages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import { TimedLeaveBody } from './TimedLeaveDialog';

const render = (locale: 'en' | 'ru', messages: typeof enMessages): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <TimedLeaveBody onStay={() => undefined} onLeave={() => undefined} />
    </NextIntlClientProvider>,
  );

// The visible labels of the actions: nothing that cancels, submits or pauses.
const buttons = (html: string): string[] =>
  [...html.matchAll(/<(?:button|a)[^>]*>([^<]*)<\/(?:button|a)>/g)].map(
    (match) => match[1] ?? '',
  );

describe('TimedLeaveDialog', () => {
  it('timed leave dialog is accessible and non destructive', () => {
    const en = render('en', enMessages);
    // The ids the Dialog points aria-labelledby / aria-describedby at.
    expect(en).toContain('id="timed-leave-title"');
    expect(en).toContain('id="timed-leave-body"');
    expect(en).toContain('The time keeps running');
    expect(en).toContain('Stay');
    expect(en).toContain('Leave — time keeps running');
    // Exactly two actions, neither one ends or pauses the attempt.
    expect(buttons(en)).toHaveLength(2);
    expect(buttons(en)).toEqual(['Stay', 'Leave — time keeps running']);
    expect(en).not.toMatch(/extra time|more time/i);

    const ru = render('ru', ruMessages as typeof enMessages);
    expect(ru).toContain('Время продолжает идти');
    expect(ru).toContain('Остаться');
    expect(ru).toContain('Перейти — время продолжит идти');
    expect(buttons(ru)).toHaveLength(2);
    expect(buttons(ru)).toEqual(['Остаться', 'Перейти — время продолжит идти']);
  });
});
