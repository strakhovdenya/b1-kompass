import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import ru from '../../../messages/ru.json';
import { DictionaryCard } from './DictionaryCard';
import type { DictionaryEntry } from './entry';
import type { LookupState } from './lookup';

type OpenState = Exclude<LookupState, { status: 'closed' }>;

const SCRIPT = '<script>alert(1)</script>';
const IMAGE = '<img src=x onerror="alert(2)">';
const EVIL = 'https://evil.example/steal';

const ALLOWED_LINKS = [
  'https://www.dwds.de/wb/',
  'https://www.duden.de/suchen/dudenonline/',
  'https://translate.google.com/?sl=de&amp;tl=',
  'https://mymemory.translated.net',
  'https://www.openthesaurus.de',
];

const render = (state: OpenState, locale: 'en' | 'ru' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? en : ru}
    >
      <DictionaryCard
        state={state}
        target={locale}
        titleId="dictionary-title"
        onClose={() => undefined}
        onLookup={() => undefined}
      />
    </NextIntlClientProvider>,
  );

const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');

const hostile: DictionaryEntry = {
  word: 'Brief',
  target: 'en',
  translation: {
    state: 'found',
    text: `${SCRIPT} ${EVIL}`,
    alternatives: [IMAGE, `<a href="${EVIL}">click</a>`],
  },
  lexical: {
    state: 'found',
    baseform: `${IMAGE}`,
    synonyms: [`<b>${EVIL}</b>`],
  },
};

describe('DictionaryCard', () => {
  it('renders untrusted lexical text safely', () => {
    const html = render({
      status: 'ready',
      word: 'Brief',
      requestId: 1,
      entry: hostile,
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
    // A provider URL is shown as text at most, never as a link.
    for (const href of hrefsOf(html)) {
      expect(href).not.toContain('evil.example');
      expect(
        ALLOWED_LINKS.some((prefix) => href.startsWith(prefix)),
        href,
      ).toBe(true);
    }
    expect(html).not.toContain('nofollow');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('builds the external links from the word and the guest language', () => {
    const html = render(
      {
        status: 'ready',
        word: 'Straße',
        requestId: 1,
        entry: {
          word: 'Straße',
          target: 'ru',
          translation: { state: 'found', text: 'улица', alternatives: [] },
          lexical: { state: 'not-found', baseform: null, synonyms: [] },
        },
      },
      'ru',
    );
    expect(html).toContain('href="https://www.dwds.de/wb/Stra%C3%9Fe"');
    expect(html).toContain(
      'href="https://www.duden.de/suchen/dudenonline/Stra%C3%9Fe"',
    );
    expect(html).toContain(
      'href="https://translate.google.com/?sl=de&amp;tl=ru&amp;text=Stra%C3%9Fe&amp;op=translate"',
    );
    expect(html).toContain('data-testid="dictionary-openthesaurus"');
    expect(html).toContain('lang="ru"');
    expect(html).toContain('lang="de"');
  });

  it('shows loading, error, empty and limited states with the links', () => {
    const loading = render({ status: 'loading', word: 'Brief', requestId: 1 });
    expect(loading).toContain('data-testid="dictionary-loading"');
    expect(loading).toContain('role="status"');
    expect(loading).toContain('data-testid="dictionary-link-dwds"');

    const failed = render({
      status: 'error',
      word: 'Brief',
      requestId: 1,
      failure: 'unavailable',
    });
    expect(failed).toContain('data-testid="dictionary-error"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('data-testid="dictionary-link-google"');

    const empty = render({
      status: 'ready',
      word: 'Brief',
      requestId: 1,
      entry: {
        word: 'Brief',
        target: 'en',
        translation: { state: 'not-found', text: null, alternatives: [] },
        lexical: { state: 'limited', baseform: null, synonyms: [] },
      },
    });
    expect(empty).toContain('data-state="not-found"');
    expect(empty).toContain('data-state="limited"');
    expect(empty).not.toContain('data-testid="dictionary-translation"');
    expect(empty).toContain('data-testid="dictionary-link-duden"');
  });
});
