import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import ru from '../../../messages/ru.json';
import { ExamLibrary } from './ExamLibrary';
import type { LibraryEntry } from './ExamLibrary';

const entry = (slug: string, title: string): LibraryEntry => ({
  slug,
  title,
  format: 'DTZ',
  hoerenCount: 20,
  lesenCount: 25,
  totalCount: 45,
});

const render = (
  props: { entries: LibraryEntry[]; hasError?: boolean },
  locale: 'en' | 'ru' = 'en',
) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? en : ru}
    >
      <ExamLibrary {...props} />
    </NextIntlClientProvider>,
  );

describe('ExamLibrary', () => {
  it('library renders empty and error states without cards', () => {
    const empty = render({ entries: [] });
    expect(empty).toContain('data-testid="library-empty"');
    expect(empty).toContain('href="/"');
    expect(empty).not.toContain('exam-card-');
    expect(empty).not.toContain('exam-card-open');

    const failed = render({ entries: [], hasError: true });
    expect(failed).toContain('data-testid="library-error"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('href="/exams"');
    expect(failed).toContain('href="/"');
    expect(failed).not.toContain('exam-card-');
  });

  it('renders one card per exam with counts and a link to its mode choice', () => {
    const html = render({
      entries: [entry('exam-a', 'Exam A'), entry('exam-b', 'Exam B')],
    });
    expect(html).toContain('href="/practice/exam-a"');
    expect(html).toContain('href="/practice/exam-b"');
    expect(html).toContain('DTZ · 20 Hören + 25 Lesen · 45 tasks');
    expect(html.match(/data-testid="exam-card-open"/g)).toHaveLength(2);
  });

  it('renders a single exam and the Russian interface', () => {
    const html = render({ entries: [entry('only', 'Only')] }, 'ru');
    expect(html).toContain('Выбрать режим');
    expect(html).toContain('45 заданий');
    expect(html.match(/data-testid="exam-card-open"/g)).toHaveLength(1);
  });

  it('state read failure shows retry instead of cards', () => {
    const failed = render({
      entries: [
        {
          ...entry('exam-a', 'Exam A'),
          continueHref: '/practice/exam-a/attempts/x',
        },
      ],
      hasError: true,
    });
    expect(failed).toContain('data-testid="library-error"');
    expect(failed).toContain('href="/exams"');
    expect(failed).not.toContain('exam-card-');
    expect(failed).not.toContain('Choose mode');
    expect(failed).not.toContain('Continue');
  });

  it('continue is the main action and latest result the second one', () => {
    const html = render({
      entries: [
        {
          ...entry('exam-a', 'Exam A'),
          continueHref: '/practice/exam-a/attempts/a1/lesen',
          resultHref: '/practice/exam-a/attempts/a0',
        },
        {
          ...entry('exam-b', 'Exam B'),
          resultHref: '/practice/exam-b/attempts/b0',
        },
        entry('exam-c', 'Exam C'),
      ],
    });
    expect(html).toContain('href="/practice/exam-a/attempts/a1/lesen"');
    expect(html).toContain('href="/practice/exam-a/attempts/a0"');
    expect(html).not.toContain('href="/practice/exam-a"');
    expect(html.match(/data-testid="exam-card-continue"/g)).toHaveLength(1);
    expect(html.match(/data-testid="exam-card-open"/g)).toHaveLength(2);
    expect(html.match(/data-testid="exam-card-result"/g)).toHaveLength(2);
    expect(html).toContain('Latest result');
    expect(
      render({ entries: [{ ...entry('a', 'A'), resultHref: '/r' }] }, 'ru'),
    ).toContain('Последний результат');
  });
});
