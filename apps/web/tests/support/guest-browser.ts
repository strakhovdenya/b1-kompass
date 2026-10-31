import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { GUEST_COOKIE } from '../../src/server/guest-session/cookie';
import { readAttempts, readSessionByToken } from './db';

// Browser helpers for specs that drive several guests at once: each guest is
// its own browser context with its own cookie, session and attempt.

export const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

export const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

export const expectStatus = (cardLocator: Locator, status: string) =>
  expect(cardLocator.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    status,
  );

export const tokenOf = async (context: BrowserContext): Promise<string> => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  return cookie.value;
};

export interface BrowserGuest {
  context: BrowserContext;
  page: Page;
  token: string;
  sessionId: string;
  attemptId: string;
}

// A fresh guest entered through the home page, with its one active attempt
// read back from the test database.
export const startBrowserGuest = async (
  browser: Browser,
): Promise<BrowserGuest> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
  const token = await tokenOf(context);
  const session = await readSessionByToken(token);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt) throw new Error('one attempt');
  return { context, page, token, sessionId: session.id, attemptId: attempt.id };
};

export const audioOf = (page: Page): Locator =>
  page.getByTestId('audio-element');

export interface MediaSnapshot {
  currentTime: number;
  nowSeconds: number;
  paused: boolean;
  isConnected: boolean;
  marker: string | null;
}

// currentTime and the clock of the browser are read in the same call.
export const snapshotOf = (page: Page): Promise<MediaSnapshot> =>
  audioOf(page).evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    nowSeconds: performance.now() / 1000,
    paused: element.paused,
    isConnected: element.isConnected,
    marker: element.dataset.marker ?? null,
  }));

export const waitForPlayer = async (page: Page) => {
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  await expect
    .poll(() => audioOf(page).evaluate((e: HTMLAudioElement) => e.duration))
    .toBeGreaterThan(10);
};

// The pathname of the address the player actually reads from.
export const sourcePathOf = async (page: Page): Promise<string> => {
  const src = await audioOf(page).evaluate(
    (element: HTMLAudioElement) => element.currentSrc,
  );
  return new URL(src).pathname;
};

export const seekTo = (page: Page, seconds: number) =>
  audioOf(page).evaluate((element: HTMLAudioElement, at: number) => {
    element.currentTime = at;
  }, seconds);

// Starts the player of an English page, moves it to the given second and
// marks the element, so that a replaced element is noticed later.
export const playFrom = async (page: Page, seconds: number, marker: string) => {
  await page.getByRole('button', { name: /Play/ }).click();
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
  await audioOf(page).evaluate(
    (element: HTMLAudioElement, input: { at: number; marker: string }) => {
      element.currentTime = input.at;
      element.dataset.marker = input.marker;
    },
    { at: seconds, marker },
  );
  await expect
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeGreaterThan(seconds + 0.3);
};

export const pausePlayer = async (page: Page) => {
  await page.getByRole('button', { name: /Pause/ }).click();
  await expect(page.getByRole('button', { name: /Play/ })).toBeVisible();
  await expect.poll(async () => (await snapshotOf(page)).paused).toBe(true);
};

export interface ScreenSnapshot {
  lang: string | null;
  path: string;
  cards: string[];
  checked: string[];
  statuses: string[];
}

interface CardView {
  id: string;
  checked: string[];
  statuses: string[];
}

const readCards = (items: HTMLElement[]): CardView[] =>
  items.map((item) => {
    const id = item.dataset.testid ?? '';
    const inputs = [...item.querySelectorAll<HTMLInputElement>('input')];
    const statuses = [
      ...item.querySelectorAll<HTMLElement>('[data-testid="save-status"]'),
    ];
    return {
      id,
      checked: inputs
        .filter((input) => input.checked)
        .map((input) => `${id}:${input.value}`),
      statuses: statuses.map((status) => status.dataset.status ?? ''),
    };
  });

// What the guest sees: language, route, the question cards with their
// checked options and save states.
export const screenOf = async (page: Page): Promise<ScreenSnapshot> => {
  const lang = await page.locator('html').getAttribute('lang');
  const views = await page
    .locator('[data-testid^="question-card-"]')
    .evaluateAll(readCards);
  return {
    lang,
    path: new URL(page.url()).pathname,
    cards: views.map((view) => view.id),
    checked: views.flatMap((view) => view.checked),
    statuses: views.flatMap((view) => view.statuses),
  };
};

export const goToLesen = async (page: Page) => {
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL('**/practice/lesen');
  await expect(page.getByTestId('reading-text')).toBeVisible();
};

export const goToHoeren = async (page: Page) => {
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL('**/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
};

// Finishing with unanswered tasks asks for a confirmation first.
export const finishFromShell = async (page: Page) => {
  await page.getByTestId('finish-attempt').click();
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
};
