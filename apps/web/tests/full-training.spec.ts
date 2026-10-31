import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { FULL_PILOT } from './support/full-exam';
import {
  finishAttempt,
  getAttemptReview,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readResults,
  readSession,
  readSessionByToken,
  serviceDb,
} from './support/db';

// The synthetic full set: hoeren-1..20 and lesen-1..25 with the key in
// FULL_PILOT. Answers are prepared through the real saveAnswer; the screens
// are driven in the browser and compared with the re-read database.
const { questions } = FULL_PILOT.content;
const { keys } = FULL_PILOT;
const TOLERANCE_SECONDS = 0.5;
const PLAY_FROM_SECONDS = 5;

type Mark = 'right' | 'wrong' | 'skip';
type Question = (typeof questions)[number];

const byId = (id: string): Question => {
  const found = questions.find((question) => question.id === id);
  if (!found) throw new Error(`no question ${id}`);
  return found;
};

const keyOf = (question: Question): string => {
  const key = keys[question.id];
  if (!key) throw new Error(`no key for ${question.id}`);
  return key;
};

const answerFor = (question: Question, mark: Mark): string | null => {
  if (mark === 'skip') return null;
  if (mark === 'right') return keyOf(question);
  const wrong = question.options.find(
    (option) => option.id !== keyOf(question),
  );
  if (!wrong) throw new Error(`no wrong option for ${question.id}`);
  return wrong.id;
};

// 15 + 18 right: 33 of 45, the B1 border; the rest wrong or skipped.
const MIXED = (question: Question): Mark => {
  if (question.skill === 'hoeren') {
    if (question.number <= 15) return 'right';
    return question.number <= 17 ? 'wrong' : 'skip';
  }
  if (question.number <= 18) return 'right';
  return question.number <= 21 ? 'wrong' : 'skip';
};

const ALL_RIGHT = (): Mark => 'right';

const outcomeOf = (question: Question, answers: Record<string, string>) => {
  const chosen = answers[question.id];
  if (chosen === undefined) return 'skipped';
  return chosen === keyOf(question) ? 'correct' : 'incorrect';
};

const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

const startGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
};

const tokenOf = async (context: BrowserContext): Promise<string> => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  return cookie.value;
};

const attemptOf = async (context: BrowserContext) => {
  const token = await tokenOf(context);
  const session = await readSessionByToken(token);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt)
    throw new Error('one attempt expected');
  return { ...attempt, token, sessionId: session.id };
};

const seed = async (
  token: string,
  attemptId: string,
  markOf: (question: Question) => Mark,
) => {
  for (const question of questions) {
    const optionId = answerFor(question, markOf(question));
    if (optionId === null) continue;
    const saved = await saveAnswer(depsNow(), token, {
      attemptId,
      questionId: question.id,
      optionId,
    });
    if (!saved.ok) throw new Error(`seed ${question.id}: ${saved.error}`);
  }
};

// A guest with a started attempt whose answers are already stored.
const openSeeded = async (
  context: BrowserContext,
  markOf: (question: Question) => Mark,
) => {
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  await seed(attempt.token, attempt.id, markOf);
  await page.goto('/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
  return { page, attempt };
};

interface StoredResult {
  score: number;
  max_score: number;
  correct_count: number;
  incorrect_count: number;
  skipped_count: number;
  percent: number | string;
  hoeren_score: number;
  hoeren_max: number;
  lesen_score: number;
  lesen_max: number;
  level: string;
}

const storedResult = async (attemptId: string): Promise<StoredResult> => {
  const rows = (await readResults(attemptId)) as StoredResult[];
  const [row] = rows;
  if (rows.length !== 1 || !row) throw new Error('one result row expected');
  return row;
};

const finishFromShell = async (page: Page, isConfirmed: boolean) => {
  await page.getByTestId('finish-attempt').click();
  if (isConfirmed) await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
};

const reviewOutcomes = (page: Page): Promise<string[][]> =>
  page
    .getByTestId('review-item')
    .evaluateAll((items: HTMLElement[]) =>
      items.map((item) => [
        item.dataset.questionId ?? '',
        item.dataset.outcome ?? '',
      ]),
    );

const expectedOutcomes = (
  skill: 'hoeren' | 'lesen',
  answers: Record<string, string>,
) =>
  questions
    .filter((question) => question.skill === skill)
    .map((question) => [question.id, outcomeOf(question, answers)]);

const percentText = (percent: number | string, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Number(percent) / 100);

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

const startPlayback = async (page: Page) => {
  await page.getByRole('button', { name: /Play/ }).click();
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
  await audioOf(page).evaluate((element: HTMLAudioElement, at: number) => {
    element.currentTime = at;
    element.dataset.marker = 'listener';
  }, PLAY_FROM_SECONDS);
  await expect
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeGreaterThan(PLAY_FROM_SECONDS + 0.3);
};

const markDocument = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __document: string }).__document = 'same';
  });

const documentMarker = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __document?: string }).__document ?? null,
  );

const goToLesen = async (page: Page) => {
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL('**/practice/lesen');
  await expect(page.getByTestId('reading-text')).toBeVisible();
};

const goToHoeren = async (page: Page) => {
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL('**/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
};

const checked = (page: Page, questionId: string, optionId: string) =>
  expect(optionIn(card(page, questionId), optionId)).toBeChecked();

test('full training presents localized stored review', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, MIXED);

  await goToLesen(page);
  await finishFromShell(page, true);

  const row = await storedResult(attempt.id);
  expect(row).toMatchObject({
    score: 33,
    max_score: 45,
    hoeren_score: 15,
    hoeren_max: 20,
    lesen_score: 18,
    lesen_max: 25,
    level: 'B1',
  });
  await expect(page.getByTestId('result-score')).toHaveText(
    `${row.score} of ${row.max_score} points (${percentText(row.percent, 'en')})`,
  );
  await expect(page.getByTestId('result-hoeren')).toHaveText(
    `Hören: ${row.hoeren_score} of ${row.hoeren_max} points`,
  );
  await expect(page.getByTestId('result-lesen')).toHaveText(
    `Lesen: ${row.lesen_score} of ${row.lesen_max} points`,
  );
  await expect(page.getByTestId('result-level')).toHaveText('Level: B1');
  await expect(page.getByTestId('result-counts')).toHaveText(
    `Right: ${row.correct_count} · Wrong: ${row.incorrect_count} · Skipped: ${row.skipped_count}`,
  );
  await expect(page.getByTestId('result-scope')).toHaveCount(0);

  const answers = await readAnswers(attempt.id);
  expect(await reviewOutcomes(page)).toEqual(
    expectedOutcomes('lesen', answers),
  );
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL('**/practice');
  await expect(page.getByTestId('review-item')).toHaveCount(20);
  expect(await reviewOutcomes(page)).toEqual(
    expectedOutcomes('hoeren', answers),
  );
  await expect(page.getByTestId('result-level')).toHaveText('Level: B1');
  await context.close();
});

test('empty attempt shows zero result', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  expect(await readAnswers(attempt.id)).toEqual({});

  await finishFromShell(page, true);

  const row = await storedResult(attempt.id);
  expect(row).toMatchObject({
    score: 0,
    max_score: 45,
    skipped_count: 45,
    level: 'below-A2',
  });
  await expect(page.getByTestId('result-score')).toHaveText(
    '0 of 45 points (0.0%)',
  );
  await expect(page.getByTestId('result-hoeren')).toHaveText(
    'Hören: 0 of 20 points',
  );
  await expect(page.getByTestId('result-lesen')).toHaveText(
    'Lesen: 0 of 25 points',
  );
  await expect(page.getByTestId('result-level')).toHaveText('Level: below A2');
  await expect(page.getByTestId('result-counts')).toHaveText(
    'Right: 0 · Wrong: 0 · Skipped: 45',
  );
  await expect(page.locator('[data-outcome="skipped"]')).toHaveCount(20);
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL('**/practice/lesen');
  await expect(page.getByTestId('review-item')).toHaveCount(25);
  await expect(page.locator('[data-outcome="skipped"]')).toHaveCount(25);
  await context.close();
});

test('switching blocks keeps attempt answers and playback', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, (question) =>
    question.number === 1 ? 'right' : 'skip',
  );
  const stored = await readAnswers(attempt.id);
  await waitForPlayer(page);
  await markDocument(page);
  await startPlayback(page);
  const before = await snapshotOf(page);
  expect(before.currentTime).toBeGreaterThanOrEqual(PLAY_FROM_SECONDS);

  await goToLesen(page);
  await checked(page, 'lesen-1', keyOf(byId('lesen-1')));
  await goToHoeren(page);
  const after = await snapshotOf(page);

  expect(await documentMarker(page)).toBe('same');
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
  await checked(page, 'hoeren-1', keyOf(byId('hoeren-1')));
  expect((await attemptOf(context)).id).toBe(attempt.id);
  expect(await readAnswers(attempt.id)).toEqual(stored);
  await context.close();
});

test('switching blocks keeps paused position', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, (question) =>
    question.number === 1 ? 'right' : 'skip',
  );
  const stored = await readAnswers(attempt.id);
  await waitForPlayer(page);
  await markDocument(page);
  await startPlayback(page);
  await page.getByRole('button', { name: /Pause/ }).click();
  await expect(page.getByRole('button', { name: /Play/ })).toBeVisible();
  const before = await snapshotOf(page);
  expect(before.paused).toBe(true);
  expect(before.currentTime).toBeGreaterThanOrEqual(PLAY_FROM_SECONDS);

  await goToLesen(page);
  await goToHoeren(page);
  const after = await snapshotOf(page);

  expect(await documentMarker(page)).toBe('same');
  await expect(audioOf(page)).toHaveCount(1);
  expect(after.paused).toBe(true);
  expect(Math.abs(after.currentTime - before.currentTime)).toBeLessThanOrEqual(
    TOLERANCE_SECONDS,
  );
  expect(await readAnswers(attempt.id)).toEqual(stored);
  await context.close();
});

test('active or foreign review remains private', async ({
  browser,
  baseURL,
}) => {
  const ownerContext = await browser.newContext();
  const { page, attempt } = await openSeeded(ownerContext, MIXED);
  const leaks = ['correctOptionId', 'review-solution', 'attempt-review'];

  const active = await getAttemptReview(depsNow(), attempt.token, {
    attemptId: attempt.id,
  });
  expect(active).toEqual({ ok: false, error: 'not-completed' });
  for (const path of ['/practice', '/practice/lesen']) {
    const html = await (await page.request.get(path)).text();
    for (const leak of leaks) expect(html).not.toContain(leak);
  }

  const result = await finishAttempt(depsNow(), attempt.token, {
    attemptId: attempt.id,
  });
  expect(result.ok).toBe(true);

  const stranger = await newGuest(depsNow());
  const foreign = await getAttemptReview(depsNow(), stranger.token, {
    attemptId: attempt.id,
  });
  expect(foreign).toEqual({ ok: false, error: 'attempt-not-found' });
  expect(JSON.stringify(foreign)).not.toContain('correct');

  const strangerContext = await browser.newContext();
  await strangerContext.addCookies([
    {
      name: GUEST_COOKIE,
      value: stranger.token,
      url: baseURL,
    },
  ]);
  const strangerPage = await strangerContext.newPage();
  for (const path of ['/practice', '/practice/lesen']) {
    const body = await (await strangerPage.request.get(path)).text();
    for (const leak of leaks) expect(body).not.toContain(leak);
    expect(body).not.toContain('data-outcome');
  }
  await strangerContext.close();
  await ownerContext.close();
});

test('completed attempt refuses block changes', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, MIXED);
  await finishFromShell(page, true);
  const stored = await readAnswers(attempt.id);

  const changed = await saveAnswer(depsNow(), attempt.token, {
    attemptId: attempt.id,
    questionId: 'hoeren-1',
    optionId: 'c',
  });
  expect(changed.ok).toBe(false);
  const added = await saveAnswer(depsNow(), attempt.token, {
    attemptId: attempt.id,
    questionId: 'hoeren-20',
    optionId: 'a',
  });
  expect(added.ok).toBe(false);
  expect(await readAnswers(attempt.id)).toEqual(stored);

  await page.goto('/practice');
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.locator('[data-testid^="question-card-"]')).toHaveCount(0);
  await context.close();
});

test('locale switches entire route without losing state', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await startGuest(page);
  const attempt = await attemptOf(context);
  await seed(attempt.token, attempt.id, (question) =>
    question.skill === 'hoeren' && question.number === 1
      ? 'skip'
      : MIXED(question),
  );
  await page.goto('/practice');
  await waitForPlayer(page);
  await startPlayback(page);
  const target = card(page, 'hoeren-1');
  await optionIn(target, keyOf(byId('hoeren-1'))).check();
  await expect(target.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
  const before = await snapshotOf(page);

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const after = await snapshotOf(page);
  await checked(page, 'hoeren-1', keyOf(byId('hoeren-1')));
  expect(after).toMatchObject({ paused: false, marker: 'listener' });
  const expected = before.currentTime + (after.nowSeconds - before.nowSeconds);
  expect(Math.abs(after.currentTime - expected)).toBeLessThanOrEqual(
    TOLERANCE_SECONDS,
  );
  await expect(page.getByTestId('finish-attempt')).toHaveText(
    'Завершить попытку',
  );
  await goToLesen(page);
  await expect(page.getByTestId('finish-attempt')).toHaveText(
    'Завершить попытку',
  );

  await context.route('**/practice/lesen', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await page.getByTestId('finish-attempt').click();
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('finish-status')).toContainText(
    'Попытка не завершена',
  );
  expect(await readResults(attempt.id)).toEqual([]);
  await context.unroute('**/practice/lesen');

  await finishFromShell(page, true);

  const row = await storedResult(attempt.id);
  expect(row.score).toBe(33);
  await expect(page.getByTestId('result-score')).toContainText(
    percentText(row.percent, 'ru'),
  );
  await expect(page.getByTestId('result-level')).toHaveText('Уровень: B1');
  await expect(page.getByTestId('result-hoeren')).toHaveText(
    'Hören: 15 из 20 баллов',
  );
  await expect(page.getByTestId('review-item').first()).toContainText(
    byId('lesen-1').prompt,
  );

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('result-score')).toContainText(
    percentText(row.percent, 'en'),
  );
  expect(percentText(73.3, 'en')).toBe('73.3%');
  expect(percentText(73.3, 'ru')).toMatch(/^73,3\s%$/);
  await context.close();
});

test('unsupported locale preserves training state', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, MIXED);
  const stored = await readAnswers(attempt.id);

  // The database itself refuses a locale other than en and ru; the guest
  // therefore keeps the stored one and the interface stays English.
  const refused = await serviceDb
    .from('guest_sessions')
    .update({ locale: 'de' })
    .eq('id', attempt.sessionId);
  expect(refused.error).not.toBeNull();
  expect((await readSession(attempt.sessionId)).locale).toBe('en');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('finish-attempt')).toHaveText('Finish attempt');
  await expect(card(page, 'hoeren-1')).toContainText(byId('hoeren-1').prompt);
  await checked(page, 'hoeren-1', keyOf(byId('hoeren-1')));
  expect(await readAnswers(attempt.id)).toEqual(stored);
  await context.close();
});

test('review escapes untrusted text and isolates cache', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const { page, attempt } = await openSeeded(first, MIXED);
  await finishFromShell(page, true);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: string }).__xss),
  ).toBeUndefined();
  expect(await page.locator('script', { hasText: 'alert' }).count()).toBe(0);

  const response = await page.request.get('/practice');
  expect(response.headers()['cache-control']).toContain('no-store');

  const second = await browser.newContext();
  const otherPage = await second.newPage();
  await startGuest(otherPage);
  const body = await (await otherPage.request.get('/practice/lesen')).text();
  expect(body).not.toContain('data-outcome');
  expect(body).not.toContain('attempt-review');
  await expect(otherPage.getByTestId('attempt-review')).toHaveCount(0);
  const other = await attemptOf(second);
  expect(other.id).not.toBe(attempt.id);
  expect(await readResults(other.id)).toEqual([]);
  await first.close();
  await second.close();
});

test('finish asks confirmation for unanswered tasks', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, (question) => {
    if (question.skill === 'hoeren')
      return question.number <= 12 ? 'right' : 'skip';
    return question.number <= 20 ? 'wrong' : 'skip';
  });
  const answers = await readAnswers(attempt.id);
  const countOf = (skill: string, total: number) =>
    total - Object.keys(answers).filter((id) => id.startsWith(skill)).length;
  const hoeren = countOf('hoeren-', 20);
  const lesen = countOf('lesen-', 25);
  expect([hoeren, lesen]).toEqual([8, 5]);

  const confirmation = page.getByTestId('finish-confirmation');
  const assertConfirmation = async () => {
    await page.getByTestId('finish-attempt').click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveAttribute(
      'data-unanswered-hoeren',
      String(hoeren),
    );
    await expect(confirmation).toHaveAttribute(
      'data-unanswered-lesen',
      String(lesen),
    );
    await expect(confirmation).toContainText(`Hören ${hoeren}, Lesen ${lesen}`);
    expect(await readResults(attempt.id)).toEqual([]);
    expect(
      (await readAttempts(attempt.sessionId)).map((row) => row.status),
    ).toEqual(['active']);
  };

  await assertConfirmation();
  await page.getByTestId('finish-cancel').click();
  await goToLesen(page);
  await assertConfirmation();
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(await readResults(attempt.id)).toHaveLength(1);
  await context.close();
});

test('cancelled finish keeps attempt active', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, MIXED);
  const stored = await readAnswers(attempt.id);

  await page.getByTestId('finish-attempt').click();
  await expect(page.getByTestId('finish-confirmation')).toBeVisible();
  await page.getByTestId('finish-cancel').click();

  await expect(page.getByTestId('finish-confirmation')).toHaveCount(0);
  await expect(page.getByTestId('finish-attempt')).toBeVisible();
  expect(await readResults(attempt.id)).toEqual([]);
  expect(await readAnswers(attempt.id)).toEqual(stored);

  const target = card(page, 'hoeren-18');
  await page.getByTestId('go-to-question-18').click();
  await optionIn(card(page, 'hoeren-18'), 'a').check();
  await expect(target.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
  expect(await readAnswers(attempt.id)).toEqual({
    ...stored,
    'hoeren-18': 'a',
  });
  expect(await readResults(attempt.id)).toEqual([]);
  await context.close();
});

test('finish from either block gives one result', async ({ browser }) => {
  const context = await browser.newContext();
  const { page: hoerenPage, attempt } = await openSeeded(context, MIXED);
  const lesenPage = await context.newPage();
  await lesenPage.goto('/practice/lesen');
  await expect(lesenPage.getByTestId('reading-text')).toBeVisible();

  await expect(hoerenPage.getByTestId('hoeren-screen')).toBeVisible();
  await expect(
    hoerenPage.getByTestId('hoeren-screen').getByTestId('finish-attempt'),
  ).toHaveCount(0);
  await expect(hoerenPage.getByTestId('finish-attempt')).toHaveCount(1);

  await finishFromShell(lesenPage, true);
  const first = await storedResult(attempt.id);
  await finishFromShell(hoerenPage, true);

  const again = await finishAttempt(depsNow(), attempt.token, {
    attemptId: attempt.id,
  });
  expect(again.ok).toBe(true);
  expect(await readResults(attempt.id)).toHaveLength(1);
  expect(await storedResult(attempt.id)).toEqual(first);
  const scoreOnScreen = await lesenPage.getByTestId('result-score').innerText();
  await expect(hoerenPage.getByTestId('result-score')).toHaveText(
    scoreOnScreen,
  );
  await context.close();
});

test('completed lesen route shows review', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, MIXED);
  const finished = await finishAttempt(depsNow(), attempt.token, {
    attemptId: attempt.id,
  });
  expect(finished.ok).toBe(true);

  await page.goto('/practice/lesen');
  expect(new URL(page.url()).pathname).toBe('/practice/lesen');
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('review-item')).toHaveCount(25);
  await expect(page.getByTestId('reading-text')).toHaveCount(0);
  await page.goto('/practice');
  await expect(page.getByTestId('review-item')).toHaveCount(20);
  await context.close();
});

test('finish without unanswered tasks skips confirmation', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const { page, attempt } = await openSeeded(context, ALL_RIGHT);
  expect(Object.keys(await readAnswers(attempt.id))).toHaveLength(45);

  await page.getByTestId('finish-attempt').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();

  expect(await page.getByTestId('finish-confirmation').count()).toBe(0);
  const row = await storedResult(attempt.id);
  expect(row).toMatchObject({ score: 45, level: 'B1', skipped_count: 0 });
  await expect(page.getByTestId('result-score')).toContainText('45 of 45');
  await context.close();
});
