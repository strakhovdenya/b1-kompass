import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import enMessages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import { ModeSelection } from './ModeSelection';
import type { ExamTiming } from './attempt-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const TIMING: ExamTiming = {
  hoerenSeconds: 1500,
  transitionSeconds: 60,
  lesenSeconds: 2700,
};

const replaceGuest = () => Promise.reject(new Error('not used'));

const render = (
  examTiming: ExamTiming | null,
  locale: 'en' | 'ru' = 'en',
): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'ru' ? ruMessages : enMessages}
    >
      <ModeSelection
        examSlug="test-exam"
        examTitle="DTZ Übungstest"
        versionId="00000000-0000-4000-8000-000000000001"
        questionCount={45}
        hoerenCount={20}
        lesenCount={25}
        activeAttemptId={null}
        examTiming={examTiming}
        replaceGuest={replaceGuest}
      />
    </NextIntlClientProvider>,
  );

// The opening tag of the radio input inside one mode card.
const radioOf = (html: string, mode: string): string => {
  const card = html.slice(html.indexOf(`data-testid="mode-option-${mode}"`));
  const input = /<input[^>]*type="radio"[^>]*>/.exec(card)?.[0];
  if (!input) throw new Error(`no radio for ${mode}`);
  return input;
};

describe('ModeSelection', () => {
  it('timed modes are unavailable without confirmed version profile', () => {
    const html = render(null);

    expect(radioOf(html, 'timed-block')).toContain('disabled=""');
    expect(radioOf(html, 'exam')).toContain('disabled=""');
    expect(radioOf(html, 'training')).not.toContain('disabled');
    expect(html).toContain(enMessages.choice.needsProfile);
    expect(html).toContain('data-testid="mode-reason-timed-block"');
    expect(html).toContain('data-testid="mode-reason-exam"');
    expect(html).not.toContain('data-testid="mode-reason-training"');
    expect(html).toMatch(/data-testid="start-attempt"(?![^>]*disabled)/);
  });

  it('timed modes follow confirmed version profile', () => {
    const html = render(TIMING);

    for (const mode of ['training', 'timed-block', 'exam']) {
      expect(radioOf(html, mode)).not.toContain('disabled');
      expect(radioOf(html, mode)).not.toContain('aria-describedby');
    }
    expect(html).not.toContain('mode-reason-');
    const cardOf = (mode: string): string => {
      const start = html.indexOf(`data-testid="mode-option-${mode}"`);
      return html.slice(
        start,
        html.indexOf('data-testid="mode-option-', start + 30),
      );
    };
    expect(cardOf('timed-block')).toContain('Hören 25 min, Lesen 45 min');
    expect(cardOf('exam')).toContain('Hören (25 min)');
    expect(cardOf('exam')).toContain('Lesen with its full time (45 min)');
  });

  it('unavailable reason is localized and described', () => {
    for (const locale of ['en', 'ru'] as const) {
      const html = render(null, locale);
      const reason = (locale === 'ru' ? ruMessages : enMessages).choice
        .needsProfile;

      expect(reason).not.toBe('');
      expect(html).toContain(reason);
      for (const mode of ['timed-block', 'exam']) {
        const input = radioOf(html, mode);
        expect(input).toContain('disabled=""');
        expect(input).toContain(`aria-describedby="mode-reason-${mode}"`);
        expect(html).toContain(`id="mode-reason-${mode}"`);
      }
    }
    expect(ruMessages.choice.needsProfile).not.toBe(
      enMessages.choice.needsProfile,
    );
  });
});
