import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { PILOT_EXAM } from '../../../scripts/seed-pilot-question';
import {
  depsNow,
  readAttempts,
  readSessionByToken,
  serviceDb,
  startFor,
} from './support/db';
import { readTestSupabaseEnv } from './support/env';
import {
  FULL_PILOT,
  publishUniqueFullExam,
  shortOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  LIBRARY_URL,
  attemptIdOf,
  startFromChoice,
  tokenOf,
} from './support/guest-browser';
import { PAIR_EXAM } from './support/pair-exam';
import { psqlJson, quote } from './support/sql';

// The library of full DTZ exams (#74) against the full-set server. The test
// database is shared with other specs: every check looks only at the slugs
// published here and at their relative order.

const recording = createTestRecording();

const tagged = (): string => randomUUID().slice(0, 8);

const publishFull = (title: string, slug?: string) =>
  publishUniqueFullExam(serviceDb, recording, title, slug);

const enterLibrary = async (page: Page) => {
  await page.goto('/');
  await page.getByTestId('guest-continue').click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
};

const cardOf = (page: Page, slug: string) =>
  page.getByTestId(`exam-card-${slug}`);

interface Counts {
  attempts: number;
  starts: number;
}

// What a start would have written for this guest: attempts and start events.
const countsOf = (sessionId: string): Counts =>
  psqlJson<Counts>(`select json_build_object(
    'attempts', (select count(*) from public.attempts
      where guest_session_id = ${quote(sessionId)}),
    'starts', (select count(*) from public.guest_events e
      join public.guest_sessions s on s.visitor_id = e.visitor_id
      where s.id = ${quote(sessionId)} and e.kind = 'start'))`);

const sessionOf = async (context: BrowserContext) => {
  const session = await readSessionByToken(await tokenOf(context));
  if (!session) throw new Error('guest session is missing');
  return session;
};

const PAGE_HEADERS: Record<string, string>[] = [
  {},
  { RSC: '1', 'Next-Router-Prefetch': '1' },
];
const RSC_HEADERS: Record<string, string>[] = [{}, { RSC: '1' }];

const NOTHING: Counts = { attempts: 0, starts: 0 };

test('guest CTA opens library without starting an attempt', async ({
  browser,
}) => {
  const exam = await publishFull(`Lib ${tagged()} A`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);

  const card = cardOf(page, exam.slug);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('exam-card-title')).toHaveText(exam.title);
  const counts = card.getByTestId('exam-card-counts');
  await expect(counts).toContainText('DTZ');
  await expect(counts).toContainText('20');
  await expect(counts).toContainText('25');
  await expect(counts).toContainText('45');
  expect(new URL(page.url()).pathname).toBe('/exams');

  const session = await sessionOf(context);
  expect(await readAttempts(session.id)).toEqual([]);
  expect(countsOf(session.id)).toEqual(NOTHING);
  await context.close();
});

test('repeated guest CTA keeps session term and locale', async ({
  browser,
}) => {
  await publishFull(`Lib ${tagged()} A`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const before = await sessionOf(context);
  expect(before.locale).toBe('ru');

  await page.goto('/');
  await page.getByTestId('guest-continue').click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  const after = await sessionOf(context);
  expect(after.id).toBe(before.id);
  expect(after.expires_at).toBe(before.expires_at);
  expect(after.locale).toBe('ru');
  await context.close();
});

test('catalog lists only eligible latest full exams', async ({ browser }) => {
  const tag = tagged();
  // Published in the opposite order of their titles.
  const examB = await publishFull(`Lib ${tag} B`);
  const examA = await publishFull(`Lib ${tag} A`);

  const short = await publishUniqueFullExam(
    serviceDb,
    recording,
    `Lib ${tag} short`,
    undefined,
    shortOf(FULL_PILOT),
  );
  // A full first version under an incomplete latest one.
  const superseded = await publishFull(`Lib ${tag} superseded`);
  await publishUniqueFullExam(
    serviceDb,
    recording,
    superseded.title,
    superseded.slug,
    shortOf(FULL_PILOT),
  );

  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);

  await expect(cardOf(page, examA.slug)).toHaveCount(1);
  await expect(cardOf(page, examB.slug)).toHaveCount(1);
  const hidden = [short.slug, superseded.slug, PILOT_EXAM.slug, PAIR_EXAM.slug];
  for (const slug of hidden) await expect(cardOf(page, slug)).toHaveCount(0);

  const order = await page
    .locator('[data-testid="exam-list"] > li')
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-testid')),
    );
  const indexA = order.indexOf(`exam-card-${examA.slug}`);
  expect(indexA).toBeGreaterThanOrEqual(0);
  expect(indexA).toBeLessThan(order.indexOf(`exam-card-${examB.slug}`));
  await context.close();
});

test('library card opens mode choice of its own exam', async ({ browser }) => {
  const tag = tagged();
  const examA = await publishFull(`Lib ${tag} A`);
  const examB = await publishFull(`Lib ${tag} B`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);

  for (const exam of [examA, examB]) {
    await cardOf(page, exam.slug).getByTestId('exam-card-open').click();
    await page.waitForURL(`**/practice/${exam.slug}`);
    await expect(page.getByTestId('mode-selection')).toContainText(exam.title);
    await page.goBack();
    await expect(page.getByTestId('exam-library')).toBeVisible();
  }

  const session = await sessionOf(context);
  expect(await readAttempts(session.id)).toEqual([]);
  expect(countsOf(session.id)).toEqual(NOTHING);
  await context.close();
});

test('library without guest redirects without creating session', async ({
  browser,
  request,
}) => {
  // Other specs create sessions at the same time, so the table count is not
  // comparable: the proof is that no response sets a cookie.
  for (const headers of PAGE_HEADERS) {
    const response = await request.get('/exams', {
      headers,
      maxRedirects: 0,
    });
    expect([302, 307, 308]).toContain(response.status());
    const location = response.headers().location ?? '';
    // An RSC request is first sent to the same address with its cache key.
    if (!headers.RSC) expect(new URL(location, 'http://x').pathname).toBe('/');
    expect(response.headers()['set-cookie']).toBeUndefined();
  }
  const home = await request.get('/', { headers: { RSC: '1' } });
  expect(home.headers()['set-cookie']).toBeUndefined();

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/exams');
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.getByTestId('guest-continue')).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  await context.close();
});

test('library response contains no keys signed urls or shared cache', async ({
  browser,
}) => {
  const exam = await publishFull(`Lib ${tagged()} A`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);

  const firstPrompt = FULL_PILOT.content.questions[0]?.prompt ?? '';
  expect(firstPrompt).not.toBe('');
  const forbidden = [
    readTestSupabaseEnv().secretKey,
    'SUPABASE_SECRET_KEY',
    'answer_keys',
    'correct_option_id',
    'token=',
    '/storage/v1/object/sign',
    'exam_version_audio',
    firstPrompt,
  ];
  for (const headers of RSC_HEADERS) {
    const response = await page.request.get('/exams', { headers });
    expect(response.status()).toBe(200);
    const cacheControl = response.headers()['cache-control'] ?? '';
    expect(cacheControl).not.toContain('public');
    expect(cacheControl).toContain('no-store');
    const body = await response.text();
    expect(body).toContain(exam.slug);
    for (const text of forbidden) expect(body).not.toContain(text);
  }
  await context.close();
});

test('library locale switch and refresh write nothing', async ({ browser }) => {
  await publishFull(`Lib ${tagged()} A`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);
  const session = await sessionOf(context);

  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByTestId('locale-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByTestId('exam-library')).toBeVisible();

  expect(await readAttempts(session.id)).toEqual([]);
  expect(countsOf(session.id)).toEqual(NOTHING);
  await context.close();
});

test('start after library choice stays explicit and idempotent', async ({
  browser,
}) => {
  const exam = await publishFull(`Lib ${tagged()} A`);
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterLibrary(page);
  await cardOf(page, exam.slug).getByTestId('exam-card-open').click();
  await page.waitForURL(`**/practice/${exam.slug}`);
  const session = await sessionOf(context);
  expect(countsOf(session.id)).toEqual(NOTHING);

  await startFromChoice(page);
  const attemptId = attemptIdOf(page);
  expect(countsOf(session.id)).toEqual({ attempts: 1, starts: 1 });

  const token = await tokenOf(context);
  const commandId = randomUUID();
  const first = await startFor(depsNow(), token, exam.slug, { commandId });
  const replay = await startFor(depsNow(), token, exam.slug, { commandId });
  const another = await startFor(depsNow(), token, exam.slug);
  expect(first).toMatchObject({ ok: true, result: { attemptId } });
  expect(replay).toEqual(first);
  expect(another).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId },
  });
  expect(countsOf(session.id)).toEqual({ attempts: 1, starts: 1 });
  await context.close();
});
