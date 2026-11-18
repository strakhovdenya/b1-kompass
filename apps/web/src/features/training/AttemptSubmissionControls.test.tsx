import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import { AttemptSubmissionControls } from './AttemptSubmissionControls';
import type { AttemptSubmissionControlsProps } from './AttemptSubmissionControls';

const noop = () => undefined;

const base: AttemptSubmissionControlsProps = {
  phase: 'idle',
  confirmation: null,
  isRenewed: false,
  cancelSummary: null,
  resultCheck: 'idle',
  answered: 3,
  total: 5,
  onSubmit: noop,
  onConfirmSubmit: noop,
  onResendSubmit: noop,
  onCheckResult: noop,
  onCancel: noop,
  onConfirmCancel: noop,
  onResendCancel: noop,
  onDismiss: noop,
};

const render = (
  props: Partial<AttemptSubmissionControlsProps>,
  locale: 'en' | 'ru' = 'en',
) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? messages : ruMessages}
    >
      <AttemptSubmissionControls {...base} {...props} />
    </NextIntlClientProvider>,
  );

// The opening tag and the text of a button.
const buttonOf = (html: string, testId: string): string => {
  const match = new RegExp(
    `<button[^>]*data-testid="${testId}"[^>]*>.*?</button>`,
  ).exec(html);
  if (!match) throw new Error(`no button ${testId}`);
  return match[0];
};

// The CSS Emotion wrote for one button: its class rule and the media rules.
const buttonCss = (html: string, testId: string): string => {
  const [, cls] = /class="[^"]*?(css-[\w-]+MuiButton-root)/.exec(
    buttonOf(html, testId),
  ) ?? ['', ''];
  const rules = [...html.matchAll(/<style[^>]*>(.*?)<\/style>/g)]
    .map((style) => style[1] ?? '')
    .filter((css) => css.includes(`.${cls}`));
  if (!cls || rules.length === 0) throw new Error(`no css of ${testId}`);
  return rules.join('');
};

const confirmation = {
  phaseRevision: 0,
  skipped: 2,
  unanswered: { hoeren: 1, lesen: 1 },
};

describe('AttemptSubmissionControls', () => {
  it('submission controls render confirmation and accepted pending states', () => {
    const idle = render({});
    expect(idle).toContain('data-testid="finish-attempt"');
    expect(idle).toContain('data-testid="cancel-attempt"');
    expect(idle).toContain('Answered in total: 3 of 5.');
    expect(idle).not.toContain('data-testid="finish-confirmation"');

    const confirming = render({ phase: 'confirming', confirmation });
    expect(confirming).toContain('data-testid="finish-confirmation"');
    expect(confirming).toContain('data-skipped="2"');
    expect(confirming).toContain('data-unanswered-hoeren="1"');
    expect(confirming).toContain('data-unanswered-lesen="1"');
    expect(confirming).toContain('data-testid="finish-confirm"');
    expect(confirming).not.toContain('data-testid="finish-attempt"');
    expect(confirming).not.toContain('data-testid="finish-renewed"');

    const renewed = render({
      phase: 'confirming',
      confirmation,
      isRenewed: true,
    });
    expect(renewed).toContain('data-testid="finish-renewed"');

    const accepted = render({ phase: 'accepted' });
    expect(accepted).toContain('data-testid="submission-accepted"');
    expect(accepted).toContain('data-phase="accepted"');
    expect(accepted).toContain('role="status"');
    expect(accepted).toContain('data-testid="result-check"');
    expect(accepted).not.toContain('data-testid="finish-attempt"');
    expect(accepted).not.toContain('data-testid="cancel-attempt"');
    expect(accepted).not.toContain('data-testid="result-pending"');

    const notReady = render({ phase: 'accepted', resultCheck: 'not-ready' });
    expect(notReady).toContain('data-testid="result-pending"');

    const completed = render({ phase: 'completed' });
    expect(completed).toContain('data-phase="completed"');
    expect(completed).not.toContain('data-testid="result-check"');
  });

  it('locks both commands while one is in flight or its answer was lost', () => {
    for (const phase of ['sending', 'uncertain', 'cancelling'] as const) {
      const html = render({ phase });
      expect(html).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="finish-attempt"/,
      );
      expect(html).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="cancel-attempt"/,
      );
    }
    const uncertain = render({ phase: 'uncertain' });
    expect(uncertain).toContain('data-testid="finish-uncertain"');
    expect(uncertain).toContain('data-testid="finish-resend"');
    expect(render({ phase: 'idle' })).not.toMatch(
      /<button[^>]*disabled=""[^>]*data-testid="finish-attempt"/,
    );
  });

  it('confirms a cancel with the server summary and the unsaved choices', () => {
    const cancelSummary = { phaseRevision: 0, skipped: 4, unsaved: 2 };
    const html = render({ phase: 'cancel-confirming', cancelSummary });
    expect(html).toContain('data-testid="cancel-confirmation"');
    expect(html).toContain('data-skipped="4"');
    expect(html).toContain('data-unsaved="2"');
    expect(html).toContain('data-testid="cancel-unsaved"');
    expect(html).toContain('2 choices are not saved yet and will be lost.');
    const saved = render({
      phase: 'cancel-confirming',
      cancelSummary: { ...cancelSummary, unsaved: 0 },
    });
    expect(saved).not.toContain('data-testid="cancel-unsaved"');
    const russian = render({ phase: 'cancel-confirming', cancelSummary }, 'ru');
    expect(russian).toContain('Отменить эту попытку?');
  });

  it('shows a refused submission and cancel as errors', () => {
    expect(render({ phase: 'failed' })).toContain(
      'data-testid="finish-status"',
    );
    expect(render({ phase: 'cancel-failed' })).toContain(
      'data-testid="cancel-status"',
    );
  });

  it('renders full size confirmation and retry buttons in both locales', () => {
    const cancelSummary = { phaseRevision: 0, skipped: 4, unsaved: 0 };
    const expiry = { unsaved: 0, isResultReady: false };
    const screens: [Partial<AttemptSubmissionControlsProps>, string[]][] = [
      [{}, ['finish-attempt', 'cancel-attempt']],
      [
        { phase: 'confirming', confirmation },
        ['finish-confirm', 'finish-cancel'],
      ],
      [
        { phase: 'cancel-confirming', cancelSummary },
        ['cancel-confirm', 'cancel-back'],
      ],
      [{ phase: 'accepted' }, ['result-check']],
      [{ phase: 'expired', expiry }, ['result-check']],
      [{ phase: 'uncertain' }, ['finish-resend']],
      [{ phase: 'cancel-uncertain' }, ['cancel-resend']],
    ];
    // Cancelling is destructive, so its confirmation and its resend are red;
    // the matching submission buttons stay primary.
    const destructive = new Set(['cancel-confirm', 'cancel-resend']);
    const primary = new Set(['finish-confirm', 'finish-resend']);
    for (const locale of ['en', 'ru'] as const) {
      for (const [props, testIds] of screens) {
        const html = render(props, locale);
        for (const testId of testIds) {
          const css = buttonCss(html, testId);
          expect(css, `${locale} ${testId}`).toContain('min-height:48px');
          expect(css, `${locale} ${testId}`).toContain('width:100%');
          const button = buttonOf(html, testId);
          if (destructive.has(testId)) {
            expect(button, `${locale} ${testId}`).toContain(
              'MuiButton-containedError',
            );
          }
          if (primary.has(testId)) {
            expect(button, `${locale} ${testId}`).toContain(
              'MuiButton-containedPrimary',
            );
            expect(button, `${locale} ${testId}`).not.toContain(
              'MuiButton-colorError',
            );
          }
        }
      }
    }
  });

  it('tells the finish and the cancel button apart in both locales', () => {
    const cancelSummary = { phaseRevision: 0, skipped: 4, unsaved: 0 };
    const labels = {
      en: { finish: 'Finish attempt', cancel: 'Cancel attempt' },
      ru: { finish: 'Завершить попытку', cancel: 'Отменить попытку' },
    } as const;
    for (const locale of ['en', 'ru'] as const) {
      const html = render({}, locale);
      const finish = buttonOf(html, 'finish-attempt');
      const cancel = buttonOf(html, 'cancel-attempt');
      expect(finish).toContain('MuiButton-containedPrimary');
      expect(cancel).toContain('MuiButton-outlinedError');
      expect(cancel).not.toContain('MuiButton-text');
      expect(buttonCss(html, 'cancel-attempt')).toContain('border-width:2px');
      expect(finish).toContain(labels[locale].finish);
      expect(cancel).toContain(labels[locale].cancel);

      const confirming = render(
        { phase: 'cancel-confirming', cancelSummary },
        locale,
      );
      expect(buttonOf(confirming, 'cancel-confirm')).toContain(
        'MuiButton-containedError',
      );
      expect(buttonOf(confirming, 'cancel-back')).toContain(
        'MuiButton-outlinedPrimary',
      );
      expect(buttonOf(confirming, 'cancel-back')).not.toContain(
        'MuiButton-colorError',
      );

      const locked = render({ phase: 'cancelling' }, locale);
      expect(buttonOf(locked, 'finish-attempt')).toContain('Mui-disabled');
      expect(buttonOf(locked, 'cancel-attempt')).toContain('Mui-disabled');
    }
  });

  it('cancel pending phases announce loading status in both locales', () => {
    const texts = {
      en: {
        loading: 'Getting the attempt state…',
        sending: 'Cancelling the attempt…',
      },
      ru: {
        loading: 'Получаем состояние попытки…',
        sending: 'Отменяем попытку…',
      },
    } as const;
    for (const locale of ['en', 'ru'] as const) {
      const loading = render({ phase: 'cancel-loading' }, locale);
      expect(loading).toMatch(
        /role="status"[^>]*data-testid="cancel-loading-status"[^>]*>[^<]*</,
      );
      expect(loading).toContain(`>${texts[locale].loading}<`);
      expect(loading).not.toContain('data-testid="cancel-sending-status"');
      expect(loading).not.toContain(texts[locale].sending);

      const sending = render({ phase: 'cancelling' }, locale);
      expect(sending).toMatch(
        /role="status"[^>]*data-testid="cancel-sending-status"[^>]*>[^<]*</,
      );
      expect(sending).toContain(`>${texts[locale].sending}<`);
      expect(sending).not.toContain('data-testid="cancel-loading-status"');

      for (const html of [loading, sending]) {
        // The wait is neutral: no success, no error, both commands locked.
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain('data-testid="cancel-status"');
        expect(html).not.toContain('data-testid="submission-accepted"');
        expect(buttonOf(html, 'finish-attempt')).toContain('Mui-disabled');
        expect(buttonOf(html, 'cancel-attempt')).toContain('Mui-disabled');
      }
    }
    expect(render({ phase: 'idle' })).not.toContain('role="status"');
  });

  it('failed and uncertain cancellation keeps retry alerts', () => {
    for (const locale of ['en', 'ru'] as const) {
      const failed = render({ phase: 'cancel-failed' }, locale);
      expect(failed).toMatch(/role="alert"[^>]*data-testid="cancel-status"/);
      // A refused cancel can be started again; nothing says it succeeded.
      expect(buttonOf(failed, 'cancel-attempt')).not.toContain('Mui-disabled');
      expect(buttonOf(failed, 'finish-attempt')).not.toContain('Mui-disabled');
      expect(failed).not.toContain('data-testid="cancel-loading-status"');
      expect(failed).not.toContain('data-testid="cancel-sending-status"');
      expect(failed).not.toContain('data-testid="submission-accepted"');

      const uncertain = render({ phase: 'cancel-uncertain' }, locale);
      expect(uncertain).toMatch(
        /role="alert"[^>]*data-testid="cancel-uncertain"/,
      );
      expect(buttonOf(uncertain, 'cancel-resend')).not.toContain(
        'Mui-disabled',
      );
      expect(buttonOf(uncertain, 'cancel-attempt')).toContain('Mui-disabled');
      expect(uncertain).not.toContain('data-testid="cancel-sending-status"');
      expect(uncertain).not.toContain('data-testid="submission-accepted"');
    }
  });
});
