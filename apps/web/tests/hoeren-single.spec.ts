import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { openPractice, saveAnswer } from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readSession,
  readSessionByToken,
} from './support/db';

// The seeded pilot short set: four single-choice Hören tasks of one recording.
const PROMPTS = [
  'Was soll Herr Rossi machen?',
  'Wann soll Frau Tulipano anrufen?',
  'Was muss Frau Jensen tun?',
  'Sie haben gerade ein dringendes technisches Problem.',
];
const SIGN_URL = '**/storage/v1/object/sign/**';

const promptOf = (number: number): string => PROMPTS[number - 1] ?? '';

const startGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(page.getByText(promptOf(1))).toBeVisible();
};

const sessionOf = async (context: BrowserContext) => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  const session = await readSessionByToken(cookie.value);
  if (!session) throw new Error('guest session is missing');
  return session;
};

const attemptOf = async (context: BrowserContext) => {
  const attempts = await readAttempts((await sessionOf(context)).id);
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt) {
    throw new Error('one attempt expected');
  }
  return attempt;
};

const option = (page: Page, text: string) =>
  page.getByRole('radio', { name: new RegExp(text.replace(/\./g, '\\.')) });

const saveStatus = (page: Page) => page.getByTestId('save-status');
const audioOf = (page: Page) => page.getByTestId('audio-element');
const position = (page: Page) => page.getByTestId('set-position');

const mediaState = (audio: Locator) =>
  audio.evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    paused: element.paused,
    isConnected: element.isConnected,
    marker: element.dataset.marker ?? null,
  }));

const goTo = (page: Page, number: number) =>
  page
    .getByRole('button', {
      name: new RegExp(`^(Go to question|Перейти к вопросу) ${number}$`),
    })
    .click();

const answer = async (page: Page, number: number, text: string) => {
  await goTo(page, number);
  await option(page, text).check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
};

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
    .poll(async () => (await mediaState(audioOf(page))).currentTime)
    .toBeGreaterThan(seconds + 0.3);
};

test('single questions replace only their own answer', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);

  for (const number of [1, 2, 3, 4]) {
    await goTo(page, number);
    await expect(page.getByText(promptOf(number))).toBeVisible();
    for (const other of [1, 2, 3, 4].filter((item) => item !== number)) {
      await expect(page.getByText(promptOf(other))).toHaveCount(0);
    }
  }

  await answer(page, 1, 'In der Sprachschule anrufen.');
  await answer(page, 2, 'Am Nachmittag.');
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'b',
    'hoeren-2': 'a',
  });

  await goTo(page, 1);
  await option(page, 'Sofort in den Kurs kommen.').check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'c',
    'hoeren-2': 'a',
  });
  await context.close();
});

test('changing question preserves other answers', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  await answer(page, 1, 'Den anderen Teilnehmern Bescheid sagen.');
  await answer(page, 3, 'In den nächsten Tagen einen Brief schreiben.');
  await answer(page, 2, 'Vormittags.');

  await answer(page, 2, 'Nächste Woche.');
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'a',
    'hoeren-2': 'b',
    'hoeren-3': 'b',
  });
  await goTo(page, 1);
  await expect(
    option(page, 'Den anderen Teilnehmern Bescheid sagen.'),
  ).toBeChecked();
  await goTo(page, 3);
  await expect(
    option(page, 'In den nächsten Tagen einen Brief schreiben.'),
  ).toBeChecked();
  await context.close();
});

test('navigation and locale preserve playback', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  await answer(page, 1, 'Sofort in den Kurs kommen.');
  await startPlayback(page, 8);
  const before = await mediaState(audioOf(page));

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(position(page)).toContainText('Question 2 of 4');
  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByText(promptOf(2))).toBeVisible();

  const after = await mediaState(audioOf(page));
  expect(after).toMatchObject({
    paused: false,
    isConnected: true,
    marker: 'listener',
  });
  expect(after.currentTime).toBeGreaterThanOrEqual(before.currentTime);

  await goTo(page, 1);
  await expect(option(page, 'Sofort in den Kurs kommen.')).toBeChecked();
  await context.close();
});

test('navigation does not affect another guest', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const pageA = await first.newPage();
  const pageB = await second.newPage();
  await startGuest(pageA);
  await startGuest(pageB);
  await waitForPlayer(pageA);
  await waitForPlayer(pageB);
  await audioOf(pageB).evaluate((element: HTMLAudioElement) => {
    element.currentTime = 3;
  });

  await pageA.getByRole('button', { name: 'Русский' }).click();
  await expect(pageA.locator('html')).toHaveAttribute('lang', 'ru');
  await goTo(pageA, 3);
  await expect(pageA.getByText(promptOf(3))).toBeVisible();

  await expect(pageB.locator('html')).toHaveAttribute('lang', 'en');
  await expect(position(pageB)).toContainText('Question 1 of 4');
  await expect(pageB.getByText(promptOf(1))).toBeVisible();
  const stateB = await mediaState(audioOf(pageB));
  expect(stateB.paused).toBe(true);
  expect(stateB.currentTime).toBeCloseTo(3, 0);
  expect((await readSession((await sessionOf(second)).id)).locale).toBe('en');
  expect((await readSession((await sessionOf(first)).id)).locale).toBe('ru');
  await first.close();
  await second.close();
});

test('all published single questions are reachable and durable', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  const texts = [
    'Den anderen Teilnehmern Bescheid sagen.',
    'Nächste Woche.',
    'Die Geburtsurkunde schicken.',
    'Eine E-Mail schicken.',
  ];
  for (const [index, text] of texts.entries()) {
    await answer(page, index + 1, text);
  }
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'a',
    'hoeren-2': 'b',
    'hoeren-3': 'a',
    'hoeren-4': 'b',
  });

  await page.reload();
  await expect(page.getByText(promptOf(1))).toBeVisible();
  for (const [index, text] of texts.entries()) {
    await goTo(page, index + 1);
    await expect(page.getByText(promptOf(index + 1))).toBeVisible();
    await expect(option(page, text)).toBeChecked();
  }
  await context.close();
});

test('single answer refuses unknown question and invalid option', async () => {
  const created = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), created.guest);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  const { attemptId } = opened.practice;
  const save = (questionId: string, optionId: string) =>
    saveAnswer(depsNow(), created.token, { attemptId, questionId, optionId });

  expect((await save('hoeren-1', 'b')).ok).toBe(true);
  expect((await save('hoeren-2', 'a')).ok).toBe(true);
  const stored = { 'hoeren-1': 'b', 'hoeren-2': 'a' };

  expect(await save('hoeren-99', 'a')).toEqual({
    ok: false,
    error: 'option-not-allowed',
  });
  expect(await save('hoeren-1', 'z')).toEqual({
    ok: false,
    error: 'option-not-allowed',
  });
  expect(await readAnswers(attemptId)).toEqual(stored);
});

test('both locale directions preserve actual media state', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  await answer(page, 2, 'Nächste Woche.');
  await startPlayback(page, 10);

  for (const [name, lang] of [
    ['Русский', 'ru'],
    ['English', 'en'],
  ] as const) {
    const before = await mediaState(audioOf(page));
    await page.getByRole('button', { name }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    const after = await mediaState(audioOf(page));
    expect(after).toMatchObject({
      paused: false,
      isConnected: true,
      marker: 'listener',
    });
    expect(after.currentTime).toBeGreaterThanOrEqual(before.currentTime);
    await expect(option(page, 'Nächste Woche.')).toBeChecked();
  }
  await context.close();
});

test('single navigation failure retains selection and media state', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  const attempt = await attemptOf(context);
  await answer(page, 1, 'In der Sprachschule anrufen.');
  await startPlayback(page, 6);

  // Saving fails: the error is visible, the choice stays and nothing is stored.
  await context.route('**/practice', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await goTo(page, 2);
  await option(page, 'Am Nachmittag.').check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'error');
  await expect(option(page, 'Am Nachmittag.')).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({ 'hoeren-1': 'b' });

  await goTo(page, 1);
  await expect(option(page, 'In der Sprachschule anrufen.')).toBeChecked();
  await goTo(page, 2);
  await expect(option(page, 'Am Nachmittag.')).toBeChecked();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'error');
  expect(await mediaState(audioOf(page))).toMatchObject({
    paused: false,
    isConnected: true,
    marker: 'listener',
  });

  // The recording address fails too; once saving works again the answer is kept.
  await context.route(SIGN_URL, (route) => route.abort());
  await context.unroute('**/practice');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'b',
    'hoeren-2': 'a',
  });
  await context.unroute(SIGN_URL);
  await context.close();
});
