import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { AttemptMode } from '@b1k/domain';
import messages from '../../../messages/en.json';
import { ExamContextHeader } from './ExamContextHeader';
import type { ExamStage } from './ExamContextHeader';

const TITLE = 'DTZ Übungstest 2';

const render = (props: {
  mode?: AttemptMode | null;
  stage?: ExamStage | null;
}): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ExamContextHeader examTitle={TITLE} {...props} />
    </NextIntlClientProvider>,
  );

describe('ExamContextHeader', () => {
  it('context header shows known mode and stage without heading', () => {
    const html = render({ mode: 'exam', stage: 'hoeren' });

    expect(html).toContain('<nav');
    expect(html).toContain('href="/exams"');
    expect(html).toContain('All exams');
    expect(html).toContain(`lang="de"`);
    expect(html).toContain(TITLE);
    expect(html).toContain('Exam · Hören');
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it('context header omits unknown mode and stage', () => {
    const html = render({});

    expect(html).toContain('href="/exams"');
    expect(html).toContain(TITLE);
    expect(html).not.toContain('exam-context-where');
    expect(html).not.toContain('·');
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it('shows the one known part alone', () => {
    expect(render({ mode: 'timed-block' })).toContain('Timed block');
    expect(render({ mode: 'timed-block' })).not.toContain('·');
    expect(render({ stage: 'review' })).toContain('Result');
    expect(render({ stage: 'review' })).not.toContain('·');
  });
});
