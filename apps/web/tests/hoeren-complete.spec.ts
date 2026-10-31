import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { saveAnswer } from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  readAnswers,
  readAttempts,
  readSessionByToken,
} from './support/db';

// The synthetic full set: hoeren-1..4 Teil 1, 5..9 Teil 2, 10..17 four Teil 3
// pairs, 18..20 the Teil 4 shared set with the options a-f.
const SIGN_URL = '**/storage/v1/object/sign/**';
const POOL = ['a', 'b', 'c', 'd', 'e', 'f'];
const TEIL_4 = ['hoeren-18', 'hoeren-19', 'hoeren-20'];
const TOLERANCE_SECONDS = 0.5;

const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

const statusOf = (cardLocator: Locator) =>
  cardLocator.getByTestId('save-status');

const startGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
};

const sessionOf = async (context: BrowserContext) => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  const session = await readSessionByToken(cookie.value);
  if (!session) throw new Error('guest session is missing');
  return { session, token: cookie.value };
};

const attemptOf = async (context: BrowserContext) => {
  const { session } = await sessionOf(context);
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

const goTo = (page: Page, number: number) =>
  page.getByTestId(`go-to-question-${number}`).click();

const audioOf = (page: Page) => page.getByTestId('audio-element');

interface MediaSnapshot {
  currentTime: number;
  nowSeconds: number;
  paused: boolean;
  isConnected: boolean;
  marker: string | null;
}

// currentTime and the clock of the browser are read in the same call.
const snapshotOf = (page: Page): Promise<MediaSnapshot> =>
  audioOf(page).evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    nowSeconds: performance.now() / 1000,
    paused: element.paused,
    isConnected: element.isConnected,
    marker: element.dataset.marker ?? null,
  }));

const waitForPlayer = async (page: Page) => {
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  await expect
    .poll(() => audioOf(page).evaluate((e: HTMLAudioElement) => e.duration))
    .toBeGreaterThan(10);
};

const startPlayback = async (page: Page, seconds: number) => {
  await page.getByRole('button', { name: /Play/ }).click();
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
  await audioOf(page).evaluate((element: HTMLAudioElement, at: number) => {
    element.currentTime = at;
    element.dataset.marker = 'listener';
  }, seconds);
  await expect
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeGreaterThan(seconds + 0.3);
};

test('shared pool remains visible for questions 18 to 20', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  await goTo(page, 18);

  for (const id of TEIL_4) {
    await expect(card(page, id)).toBeVisible();
    await expect(card(page, id).getByRole('radiogroup')).toHaveCount(1);
    await expect(card(page, id).getByRole('radio')).toHaveCount(POOL.length);
  }
  const choices = ['a', 'c', 'f'];
  for (const [index, id] of TEIL_4.entries()) {
    await choose(page, id, choices[index] ?? 'a');
    for (const other of TEIL_4) {
      for (const optionId of POOL) {
        await expect(optionIn(card(page, other), optionId)).toBeVisible();
        await expect(optionIn(card(page, other), optionId)).toBeEnabled();
      }
    }
  }
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-18': 'a',
    'hoeren-19': 'c',
    'hoeren-20': 'f',
  });
  await context.close();
});

test('changing shared pool answer does not mutate others', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  await goTo(page, 18);
  await choose(page, 'hoeren-18', 'b');
  await choose(page, 'hoeren-19', 'd');

  await choose(page, 'hoeren-19', 'e');
  await goTo(page, 16);
  await goTo(page, 18);

  await expect(optionIn(card(page, 'hoeren-18'), 'b')).toBeChecked();
  await expect(optionIn(card(page, 'hoeren-19'), 'e')).toBeChecked();
  await expect(card(page, 'hoeren-18').getByRole('radio')).toHaveCount(
    POOL.length,
  );
  await expect(
    card(page, 'hoeren-20').getByRole('radio', { checked: true }),
  ).toHaveCount(0);
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-18': 'b',
    'hoeren-19': 'e',
  });
  await context.close();
});

test('complete hoeren route stores answered and leaves skipped empty', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);

  const answers: Record<string, string> = {
    'hoeren-1': 'b',
    'hoeren-6': 'a',
    'hoeren-11': 'c',
    'hoeren-19': 'f',
  };
  const visited: string[] = [];
  const next = page.getByTestId('set-next');
  for (let guard = 0; guard < 30; guard++) {
    const ids = await page
      .locator('[data-testid^="question-card-"]')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          (node.getAttribute('data-testid') ?? '').replace(
            'question-card-',
            '',
          ),
        ),
      );
    visited.push(...ids);
    for (const id of ids) {
      const optionId = answers[id];
      if (optionId) await choose(page, id, optionId);
    }
    if (await next.isDisabled()) break;
    await next.click();
  }
  expect(visited).toEqual(
    Array.from({ length: 20 }, (_, index) => `hoeren-${index + 1}`),
  );
  expect(await readAnswers(attempt.id)).toEqual(answers);
  await context.close();
});

test('playback never advances task by time', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  await goTo(page, 5);
  await startPlayback(page, 5);
  const before = (await snapshotOf(page)).currentTime;

  await expect
    .poll(async () => (await snapshotOf(page)).currentTime, {
      timeout: 15_000,
    })
    .toBeGreaterThan(before + 10);
  await expect(card(page, 'hoeren-5')).toBeVisible();
  await expect(page.getByTestId('go-to-question-5')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await context.close();
});

test('unknown shared pool option is refused without change', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  const { token } = await sessionOf(context);
  await goTo(page, 18);
  await choose(page, 'hoeren-19', 'c');
  const before = await readAnswers(attempt.id);

  const refused = await saveAnswer(depsNow(), token, {
    attemptId: attempt.id,
    questionId: 'hoeren-19',
    optionId: 'z',
    revision: 1,
  });
  expect(refused).toEqual({ ok: false, error: 'option-not-allowed' });
  expect(await readAnswers(attempt.id)).toEqual(before);
  expect(before).toEqual({ 'hoeren-19': 'c' });
  await context.close();
});

test('switching teil keeps one running recording', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  await goTo(page, 5);
  await startPlayback(page, 5);

  const before = await snapshotOf(page);
  await goTo(page, 18);
  await expect(card(page, 'hoeren-18')).toBeVisible();
  await goTo(page, 5);
  await expect(card(page, 'hoeren-5')).toBeVisible();
  const after = await snapshotOf(page);

  await expect(audioOf(page)).toHaveCount(1);
  expect(after).toMatchObject({
    paused: false,
    isConnected: true,
    marker: 'listener',
  });
  const expected = before.currentTime + (after.nowSeconds - before.nowSeconds);
  expect(Math.abs(after.currentTime - expected)).toBeLessThanOrEqual(
    TOLERANCE_SECONDS,
  );
  await context.close();
});

test('switching teil keeps paused position', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  await goTo(page, 5);
  await startPlayback(page, 6);
  await page.getByRole('button', { name: /Pause/ }).click();
  await expect(page.getByRole('button', { name: /Play/ })).toBeVisible();
  const before = await snapshotOf(page);
  expect(before.paused).toBe(true);

  await goTo(page, 18);
  await expect(card(page, 'hoeren-18')).toBeVisible();
  await goTo(page, 5);
  await expect(card(page, 'hoeren-5')).toBeVisible();
  const after = await snapshotOf(page);

  await expect(audioOf(page)).toHaveCount(1);
  expect(after.paused).toBe(true);
  expect(Math.abs(after.currentTime - before.currentTime)).toBeLessThanOrEqual(
    TOLERANCE_SECONDS,
  );
  await context.close();
});

test('network failure preserves navigation and selection', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  await goTo(page, 18);

  await context.route('**/practice', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  const target = card(page, 'hoeren-18');
  await optionIn(target, 'd').check();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  await expect(target.getByRole('button')).toBeVisible();
  await expect(optionIn(target, 'd')).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({});

  await page.getByTestId('set-previous').click();
  await expect(card(page, 'hoeren-16')).toBeVisible();
  await goTo(page, 18);
  await expect(optionIn(target, 'd')).toBeChecked();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');

  await context.unroute('**/practice');
  await target.getByRole('button').click();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'saved');
  expect(await readAnswers(attempt.id)).toEqual({ 'hoeren-18': 'd' });
  await context.close();
});

test('audio failure preserves navigation and answers', async ({ browser }) => {
  const context = await browser.newContext();
  await context.route(SIGN_URL, (route) => route.abort());
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);

  const audioStatus = page.getByTestId('audio-status');
  await expect(audioStatus).toHaveAttribute('data-status', 'error');
  await expect(audioStatus.getByRole('button')).toBeVisible();

  await choose(page, 'hoeren-1', 'a');
  await goTo(page, 18);
  await choose(page, 'hoeren-20', 'b');
  await expect(audioStatus).toHaveAttribute('data-status', 'error');
  await expect(audioStatus.getByRole('button')).toBeVisible();
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'a',
    'hoeren-20': 'b',
  });
  await context.close();
});
