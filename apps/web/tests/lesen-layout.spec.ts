import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { readAnswers, readAttempts, readSessionByToken } from './support/db';

// The synthetic full set: lesen-1..5 Teil 1, 6..10 Teil 2 (nine options),
// 11..16 Teil 3 (the long text), 17..19 Teil 4, 20..25 Teil 5 (gap marks).
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };
const PARAGRAPH = 12;
const LONG_TASK = 11;

const TEILE = [
  { first: 1, last: 5, options: 3 },
  { first: 6, last: 10, options: 9 },
  { first: 11, last: 16, options: 2 },
  { first: 17, last: 19, options: 2 },
  { first: 20, last: 25, options: 3 },
];

const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

const statusOf = (cardLocator: Locator) =>
  cardLocator.getByTestId('save-status');

const goTo = (page: Page, number: number) =>
  page.getByTestId(`go-to-question-${number}`).click();

const openGuest = async (browser: Browser) => {
  const context = await browser.newContext({ viewport: WIDE });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await page.getByTestId('lesen-link').click();
  await page.waitForURL('**/practice/lesen');
  await expect(page.getByTestId('reading-text')).toBeVisible();
  return { context, page };
};

const attemptOf = async (context: BrowserContext) => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  const session = await readSessionByToken(cookie.value);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt) {
    throw new Error('one attempt expected');
  }
  return attempt;
};

const choose = async (page: Page, questionId: string, optionId: string) => {
  const target = card(page, questionId);
  await optionIn(target, optionId).check();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'saved');
};

const showTask = (page: Page) =>
  page.getByTestId('lesen-view-questions').click();

test('lesen renders complete linked source materials', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  for (const [index, teil] of TEILE.entries()) {
    for (let number = teil.first; number <= teil.last; number++) {
      await goTo(page, number);
      const target = card(page, `lesen-${number}`);
      await expect(target).toBeVisible();
      await expect(target.locator('input[type="radio"]')).toHaveCount(
        teil.options,
      );
      const reading = page.getByTestId('reading-text');
      await expect(reading).toHaveAttribute(
        'data-text-id',
        `lesen-text-${index + 1}`,
      );
      await expect(reading).toContainText(`Text zu Teil ${index + 1}`);
    }
  }

  await goTo(page, 6);
  const lines = page.getByTestId('reading-paragraph-0');
  await expect(lines).toHaveCSS('white-space', 'pre-wrap');
  expect(await lines.evaluate((e) => (e as HTMLElement).innerText)).toContain(
    'a) Anzeige a\nb) Anzeige b',
  );
  for (const id of ['a', 'h', 'x']) {
    await expect(optionIn(card(page, 'lesen-6'), id)).toBeVisible();
  }

  await goTo(page, 20);
  for (const mark of [40, 41, 42, 43, 44, 45]) {
    await expect(page.getByTestId('reading-text')).toContainText(`[${mark}]`);
  }
  await goTo(page, 17);
  const labels = card(page, 'lesen-17').locator('label');
  await expect(labels).toContainText(['Richtig', 'Falsch']);
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({});
  await context.close();
});

test('lesen state carries texts without answer keys', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  const response = await context.request.get('/practice/lesen');
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('Langer Lesetext zu Teil 3');
  expect(html).toContain('[45]');
  expect(html).not.toContain('correctOptionId');
  expect(html).not.toContain('correct_option_id');
  expect(html).not.toContain('solutionOptionId');
  expect(await page.content()).not.toContain('correctOptionId');
  await context.close();
});

test('responsive reading preserves selection', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(card(page, 'lesen-1')).toBeVisible();
  await choose(page, 'lesen-1', 'b');

  await page.setViewportSize(NARROW);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(card(page, 'lesen-1')).toBeHidden();
  await showTask(page);
  await expect(card(page, 'lesen-1')).toBeVisible();
  await expect(page.getByTestId('reading-text')).toBeHidden();
  await expect(optionIn(card(page, 'lesen-1'), 'b')).toBeChecked();

  await page.setViewportSize(WIDE);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(optionIn(card(page, 'lesen-1'), 'b')).toBeChecked();
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    'lesen-1': 'b',
  });
  await context.close();
});

test('responsive transition preserves unrelated answers', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  await choose(page, 'lesen-1', 'a');
  await goTo(page, 2);
  await choose(page, 'lesen-2', 'b');
  await choose(page, 'lesen-2', 'c');

  await page.setViewportSize(NARROW);
  await showTask(page);
  await expect(optionIn(card(page, 'lesen-2'), 'c')).toBeChecked();
  await goTo(page, 1);
  await expect(optionIn(card(page, 'lesen-1'), 'a')).toBeChecked();

  await page.setViewportSize(WIDE);
  await goTo(page, 2);
  await expect(optionIn(card(page, 'lesen-2'), 'c')).toBeChecked();
  await goTo(page, 1);
  await expect(optionIn(card(page, 'lesen-1'), 'a')).toBeChecked();
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    'lesen-1': 'a',
    'lesen-2': 'c',
  });
  await context.close();
});

test('failed save survives layout switch', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await context.route('**/practice/lesen', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  const target = card(page, 'lesen-1');
  await optionIn(target, 'b').check();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  const attempt = await attemptOf(context);
  expect(await readAnswers(attempt.id)).toEqual({});

  await page.setViewportSize(NARROW);
  await showTask(page);
  await expect(optionIn(target, 'b')).toBeChecked();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  await expect(statusOf(target).getByRole('button')).toBeVisible();

  await page.setViewportSize(WIDE);
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  await expect(optionIn(target, 'b')).toBeChecked();
  await expect(statusOf(target).getByRole('button')).toBeVisible();

  await context.unroute('**/practice/lesen');
  await statusOf(target).getByRole('button').click();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'saved');
  expect(await readAnswers(attempt.id)).toEqual({ 'lesen-1': 'b' });
  await context.close();
});

test('long reading preserves anchor across viewport changes', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  await goTo(page, LONG_TASK);
  await choose(page, `lesen-${LONG_TASK}`, 'b');

  await page.setViewportSize(NARROW);
  const reading = page.getByTestId('reading-text');
  const middle = page.getByTestId(`reading-paragraph-${PARAGRAPH}`);
  await middle.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);

  await page.setViewportSize(WIDE);
  await expect(middle).toBeInViewport();
  await expect(page.getByTestId('reading-paragraph-0')).not.toBeInViewport();
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);

  await page.setViewportSize(NARROW);
  await expect(middle).toBeInViewport();
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);

  await showTask(page);
  await expect(optionIn(card(page, `lesen-${LONG_TASK}`), 'b')).toBeChecked();
  await page.getByTestId('lesen-view-text').click();
  await expect(middle).toBeInViewport();
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    [`lesen-${LONG_TASK}`]: 'b',
  });
  await context.close();
});
