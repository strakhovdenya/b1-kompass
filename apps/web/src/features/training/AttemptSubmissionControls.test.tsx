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
});
