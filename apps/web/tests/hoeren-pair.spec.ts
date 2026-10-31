import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { finishAttempt } from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  readAnswers,
  readAttempts,
  readResults,
  readSession,
  readSessionByToken,
} from './support/db';
import { PAIR_PROMPTS } from './support/pair-exam';

// The test exam of this spec: one Teil 3 pair, served by the second e2e
// server. Key: pair-1 = a (Richtig), pair-2 = b.
const FIRST = 'pair-1';
const SECOND = 'pair-2';
const RICHTIG = 'Richtig';
const FALSCH = 'Falsch';
const TERMIN_ABSAGEN = 'Einen Termin absagen.';
const TERMIN_NEU = 'Einen neuen Termin vereinbaren.';
const ADRESSE = 'Die Adresse erfragen.';
const TOLERANCE_SECONDS = 0.5;

const startGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(page.getByText(PAIR_PROMPTS.trueFalse)).toBeVisible();
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

// The two cards of the pair, found by the German prompt they carry.
const cardOf = (page: Page, prompt: string): Locator =>
  page.locator('section').filter({ hasText: prompt });
const firstCard = (page: Page) => cardOf(page, PAIR_PROMPTS.trueFalse);
const secondCard = (page: Page) => cardOf(page, PAIR_PROMPTS.choice);

const optionIn = (card: Locator, text: string) =>
  card.getByRole('radio', { name: new RegExp(text.replace(/\./g, '\\.')) });

const statusOf = (card: Locator) => card.getByTestId('save-status');

const choose = async (card: Locator, text: string) => {
  await optionIn(card, text).check();
  await expect(statusOf(card)).toHaveAttribute('data-status', 'saved');
};

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

const expectKeptPlaying = (before: MediaSnapshot, after: MediaSnapshot) => {
  expect(after).toMatchObject({
    paused: false,
    isConnected: true,
    marker: 'listener',
  });
  const expected = before.currentTime + (after.nowSeconds - before.nowSeconds);
  expect(Math.abs(after.currentTime - expected)).toBeLessThanOrEqual(
    TOLERANCE_SECONDS,
  );
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
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeGreaterThan(seconds + 0.3);
};

const switchLanguage = async (page: Page, name: string, lang: string) => {
  await page.getByRole('button', { name }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
};

// The save of the given question reaches the real server action with an
// option that question does not have, so the server itself refuses it
// (option-not-allowed). Saves of other questions and other actions pass.
const refuseSavesOf = (context: BrowserContext, questionId: string) =>
  context.route('**/practice', (route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    const isSave = request.method() === 'POST' && body.includes(questionId);
    if (!isSave) return route.continue();
    const invalid = body.replace(/"optionId":"[^"]*"/, '"optionId":"z"');
    return route.continue({ postData: invalid });
  });

const VIEWPORTS = [
  {
    width: 390,
    height: 844,
    first: [RICHTIG, 'a'],
    second: [TERMIN_ABSAGEN, 'a'],
  },
  { width: 1440, height: 900, first: [FALSCH, 'b'], second: [ADRESSE, 'c'] },
] as const;

test('paired questions render and save independently', async ({ browser }) => {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    await startGuest(page);
    const attempt = await attemptOf(context);
    const first = firstCard(page);
    const second = secondCard(page);

    // Both questions are on the screen at once, inside the viewport width.
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    for (const card of [first, second]) {
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width,
      );
    }
    await expect(page.getByRole('radio')).toHaveCount(5);

    const [firstText, firstOption] = viewport.first;
    const [secondText, secondOption] = viewport.second;
    await choose(first, firstText);
    await expect(second.getByRole('radio', { checked: true })).toHaveCount(0);
    expect(await readAnswers(attempt.id)).toEqual({ [FIRST]: firstOption });

    await choose(second, secondText);
    await expect(optionIn(first, firstText)).toBeChecked();
    expect(await readAnswers(attempt.id)).toEqual({
      [FIRST]: firstOption,
      [SECOND]: secondOption,
    });

    // A new choice replaces only the answer of its own question.
    const other = firstText === RICHTIG ? FALSCH : RICHTIG;
    await choose(first, other);
    await expect(optionIn(second, secondText)).toBeChecked();
    expect(await readAnswers(attempt.id)).toEqual({
      [FIRST]: other === RICHTIG ? 'a' : 'b',
      [SECOND]: secondOption,
    });
    await context.close();
  }
});

test('unanswered pair member remains skipped', async ({ browser }) => {
  const outcomes = [
    { answer: [FIRST, 'a'], skipped: SECOND },
    { answer: [SECOND, 'b'], skipped: FIRST },
  ] as const;
  for (const { answer, skipped } of outcomes) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await startGuest(page);
    const attempt = await attemptOf(context);
    const { token } = await sessionOf(context);
    const card = answer[0] === FIRST ? firstCard(page) : secondCard(page);
    const text = answer[0] === FIRST ? RICHTIG : TERMIN_NEU;
    await choose(card, text);

    const finished = await finishAttempt(depsNow(), token, {
      attemptId: attempt.id,
    });
    if (!finished.ok) throw new Error(`finish: ${finished.error}`);
    const { review } = finished;
    expect(review).toMatchObject({
      score: 1,
      maxScore: 2,
      correct: 1,
      incorrect: 0,
      skipped: 1,
    });
    const item = (id: string) =>
      review.items.find((entry) => entry.questionId === id);
    expect(item(skipped)).toMatchObject({
      selectedOptionId: null,
      outcome: 'skipped',
    });
    expect(item(answer[0])).toMatchObject({
      selectedOptionId: answer[1],
      outcome: 'correct',
    });

    // The skipped member has no stored answer and the result counts it as 0.
    expect(await readAnswers(attempt.id)).toEqual({ [answer[0]]: answer[1] });
    expect(await readResults(attempt.id)).toEqual([
      expect.objectContaining({
        score: 1,
        max_score: 2,
        correct_count: 1,
        skipped_count: 1,
      }),
    ]);
    await context.close();
  }
});

test('pair controls have independent accessible labels', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);

  const groups = page.getByRole('radiogroup');
  await expect(groups).toHaveCount(2);
  const firstGroup = groups.filter({ hasText: RICHTIG });
  const secondGroup = groups.filter({ hasText: ADRESSE });
  await expect(
    page.getByRole('radiogroup', { name: PAIR_PROMPTS.trueFalse }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('radiogroup', { name: PAIR_PROMPTS.choice }),
  ).toHaveCount(1);

  // Arrow keys move and select inside the first question only.
  const richtig = firstGroup.getByRole('radio', { name: new RegExp(RICHTIG) });
  const falsch = firstGroup.getByRole('radio', { name: new RegExp(FALSCH) });
  await richtig.focus();
  await page.keyboard.press('ArrowDown');
  await expect(falsch).toBeChecked();
  await expect(statusOf(firstCard(page))).toHaveAttribute(
    'data-status',
    'saved',
  );
  await expect(falsch).toBeFocused();
  expect(await readAnswers(attempt.id)).toEqual({ [FIRST]: 'b' });

  // Tab leaves the first question; Space selects in the second one.
  await page.keyboard.press('Tab');
  const termin = secondGroup.getByRole('radio', {
    name: new RegExp(TERMIN_ABSAGEN.replace('.', '\\.')),
  });
  await expect(termin).toBeFocused();
  await page.keyboard.press('Space');
  await expect(termin).toBeChecked();
  await expect(statusOf(secondCard(page))).toHaveAttribute(
    'data-status',
    'saved',
  );
  await expect(termin).toBeFocused();
  await expect(falsch).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({
    [FIRST]: 'b',
    [SECOND]: 'a',
  });
  await context.close();
});

test('changing second answer preserves first selection', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  const first = firstCard(page);
  const second = secondCard(page);
  await choose(first, RICHTIG);

  await refuseSavesOf(context, SECOND);
  const adresse = optionIn(second, ADRESSE);
  await adresse.focus();
  await page.keyboard.press('Space');
  await expect(statusOf(second)).toHaveAttribute('data-status', 'error');
  await expect(adresse).toBeChecked();
  await expect(adresse).toBeFocused();
  await expect(optionIn(first, RICHTIG)).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({ [FIRST]: 'a' });

  // The keyboard continues: Tab reaches the retry button, Enter repeats.
  await page.keyboard.press('Tab');
  const retry = second.getByRole('button');
  await expect(retry).toBeFocused();
  await context.unroute('**/practice');
  await page.keyboard.press('Enter');
  await expect(statusOf(second)).toHaveAttribute('data-status', 'saved');
  await expect(optionIn(first, RICHTIG)).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({
    [FIRST]: 'a',
    [SECOND]: 'c',
  });
  await context.close();
});

test('pair answers and locale preserve playback', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  const attempt = await attemptOf(context);
  await startPlayback(page, 8);
  const first = firstCard(page);
  const second = secondCard(page);

  let before = await snapshotOf(page);
  const steps: [string, () => Promise<void>][] = [
    ['first answer', () => choose(first, RICHTIG)],
    ['second answer', () => choose(second, TERMIN_NEU)],
    ['to Russian', () => switchLanguage(page, 'Русский', 'ru')],
    ['back to English', () => switchLanguage(page, 'English', 'en')],
  ];
  for (const [, act] of steps) {
    await act();
    const after = await snapshotOf(page);
    expectKeptPlaying(before, after);
    before = after;
  }

  expect(await readAnswers(attempt.id)).toEqual({
    [FIRST]: 'a',
    [SECOND]: 'b',
  });
  await expect(optionIn(first, RICHTIG)).toBeChecked();
  await expect(optionIn(second, TERMIN_NEU)).toBeChecked();
  await context.close();
});

test('pair actions do not affect another guest', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await startGuest(pageA);
  await startGuest(pageB);
  await waitForPlayer(pageA);
  await waitForPlayer(pageB);
  const attemptB = await attemptOf(contextB);

  // The second guest has an answer, a language and a paused recording.
  await choose(firstCard(pageB), FALSCH);
  await startPlayback(pageB, 20);
  await pageB.getByRole('button', { name: /Pause/ }).click();
  await switchLanguage(pageB, 'Русский', 'ru');
  const pausedAt = await snapshotOf(pageB);
  expect(pausedAt.paused).toBe(true);
  expect(pausedAt.currentTime).toBeGreaterThan(19);
  const answersB = await readAnswers(attemptB.id);
  expect(answersB).toEqual({ [FIRST]: 'b' });

  await startPlayback(pageA, 8);
  await choose(firstCard(pageA), RICHTIG);
  await choose(secondCard(pageA), TERMIN_NEU);
  await switchLanguage(pageA, 'Русский', 'ru');
  await switchLanguage(pageA, 'English', 'en');

  const stateB = await snapshotOf(pageB);
  expect(stateB.paused).toBe(true);
  expect(
    Math.abs(stateB.currentTime - pausedAt.currentTime),
  ).toBeLessThanOrEqual(0.1);
  await expect(pageB.locator('html')).toHaveAttribute('lang', 'ru');
  expect(
    (await readSession((await sessionOf(contextB)).session.id)).locale,
  ).toBe('ru');
  expect(await readAnswers(attemptB.id)).toEqual(answersB);
  await contextA.close();
  await contextB.close();
});

test('pair save failure keeps playback state', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  await waitForPlayer(page);
  const attempt = await attemptOf(context);
  const first = firstCard(page);
  const second = secondCard(page);
  await choose(first, RICHTIG);
  await startPlayback(page, 6);

  await refuseSavesOf(context, SECOND);
  const before = await snapshotOf(page);
  await optionIn(second, TERMIN_NEU).check();
  await expect(statusOf(second)).toHaveAttribute('data-status', 'error');
  await expect(second.getByRole('alert')).toBeVisible();

  expectKeptPlaying(before, await snapshotOf(page));
  await expect(optionIn(first, RICHTIG)).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({ [FIRST]: 'a' });
  await context.close();
});
