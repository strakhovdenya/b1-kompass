import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  finishAttempt,
  openPractice,
  saveAnswer,
  saveProgress,
} from '../src/server/attempts/attempts';
import { resolveGuestSession } from '../src/server/guest-session/session';
import {
  createPublicClient,
  depsAt,
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readResults,
  readSession,
  readSessionByToken,
  serviceDb,
} from './support/db';
import { FULL_EXAM, FULL_PILOT } from './support/full-exam';

// The synthetic full set: lesen-11 is the first task of the long Teil 3 text
// (lesen-text-3, 24 paragraphs); the recording is 60 seconds long.

const { keys } = FULL_PILOT;
const WIDE = { width: 1440, height: 900 };
const HOEREN_TASK = 'hoeren-3';
const LONG_TASK = 11;
const LONG_QUESTION = `lesen-${LONG_TASK}`;
const LONG_TEXT = 'lesen-text-3';
const THIRD_PARAGRAPH = 2;
const SEEK_SECONDS = 17;
const SEEK_TOLERANCE = 1;
const RECORDING_SECONDS = 60;
const TERM_HOURS = 720;
const HOUR_MS = 3_600_000;
const DB_CONTAINER = 'supabase_db_b1-kompass';
const LOCALE_CHECK = 'guest_sessions_locale_check';

const psql = (sql: string) =>
  execFileSync(
    'docker',
    [
      'exec',
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: 'pipe' },
  );

// Stores a locale the application does not support; the check of the column
// is replaced by an unvalidated copy in one transaction.
const storeUnsupportedLocale = (sessionId: string, locale: string) =>
  psql(`begin;
    alter table public.guest_sessions drop constraint ${LOCALE_CHECK};
    update public.guest_sessions set locale = '${locale}' where id = '${sessionId}';
    alter table public.guest_sessions add constraint ${LOCALE_CHECK}
      check (locale in ('en', 'ru')) not valid;
    commit;`);

const restoreLocale = (sessionId: string) =>
  psql(`update public.guest_sessions set locale = 'en' where id = '${sessionId}';
    alter table public.guest_sessions validate constraint ${LOCALE_CHECK};`);

interface StoredProgress {
  block?: string;
  positionSeconds?: number;
  hoeren?: { itemId?: string };
  lesen?: { itemId?: string; textId?: string; paragraph?: number };
}

interface StoredAttempt {
  id: string;
  status: string;
  exam_version_id: string;
  progress: StoredProgress | null;
}

const readStoredAttempts = async (
  sessionId: string,
): Promise<StoredAttempt[]> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('id, status, exam_version_id, progress')
    .eq('guest_session_id', sessionId)
    .returns<StoredAttempt[]>();
  if (error) throw error;
  return data;
};

const readStoredAttempt = async (attemptId: string): Promise<StoredAttempt> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('id, status, exam_version_id, progress')
    .eq('id', attemptId)
    .single<StoredAttempt>();
  if (error) throw error;
  return data;
};

const writeProgress = async (attemptId: string, progress: unknown) => {
  const { error } = await serviceDb
    .from('attempts')
    .update({ progress })
    .eq('id', attemptId);
  if (error) throw error;
};

// Leaving a page flushes its place, so the test writes a stored place only
// after the page has gone, and the write cannot be overwritten.
const writeProgressAway = async (
  page: Page,
  attemptId: string,
  progress: unknown,
) => {
  await page.goto('about:blank');
  await writeProgress(attemptId, progress);
};

const keyOf = (questionId: string): string => {
  const key = keys[questionId];
  if (!key) throw new Error(`no key for ${questionId}`);
  return key;
};

const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

const audioOf = (page: Page) => page.getByTestId('audio-element');

const timeOf = (page: Page): Promise<number> =>
  audioOf(page).evaluate((element: HTMLAudioElement) => element.currentTime);

const isPaused = (page: Page): Promise<boolean> =>
  audioOf(page).evaluate((element: HTMLAudioElement) => element.paused);

const waitForPlayer = async (page: Page) => {
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  await expect
    .poll(() => audioOf(page).evaluate((e: HTMLAudioElement) => e.duration))
    .toBeGreaterThan(RECORDING_SECONDS - 1);
};

const tokenOf = async (context: BrowserContext): Promise<string> => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  return cookie.value;
};

interface StartOptions {
  beforeLoad?: (context: BrowserContext) => Promise<unknown>;
}

// The first Hören screen reports its place; by default the start waits for
// it, so a later write of the test cannot be overtaken by that report.
const startGuest = async (browser: Browser, options: StartOptions = {}) => {
  const context = await browser.newContext({ viewport: WIDE });
  await options.beforeLoad?.(context);
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
  const token = await tokenOf(context);
  const session = await readSessionByToken(token);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  const [attempt] = attempts;
  if (attempts.length !== 1 || !attempt) throw new Error('one attempt');
  if (!options.beforeLoad) {
    await expectProgressSaved(attempt.id, { block: 'hoeren' });
  }
  return { context, page, token, sessionId: session.id, attemptId: attempt.id };
};

const seedAnswers = async (token: string, attemptId: string) => {
  for (const questionId of ['hoeren-1', 'hoeren-2', LONG_QUESTION]) {
    const saved = await saveAnswer(depsNow(), token, {
      attemptId,
      questionId,
      optionId: keyOf(questionId),
    });
    if (!saved.ok) throw new Error(`seed ${questionId}: ${saved.error}`);
  }
};

const expectProgressSaved = (
  attemptId: string,
  expected: Record<string, unknown>,
) =>
  expect
    .poll(async () => (await readStoredAttempt(attemptId)).progress)
    .toMatchObject(expected);

// The player is ready, the recording is paused at the given second and the
// reading position is set; returns when the database holds the place.
const reachPlace = async (page: Page, attemptId: string) => {
  await waitForPlayer(page);
  await page.getByTestId('go-to-question-3').click();
  await page.getByRole('button', { name: /Play/ }).click();
  await page.getByRole('button', { name: /Pause/ }).click();
  await audioOf(page).evaluate((element: HTMLAudioElement, at: number) => {
    element.currentTime = at;
  }, SEEK_SECONDS);
  await expect.poll(() => timeOf(page)).toBeCloseTo(SEEK_SECONDS, 0);
  await expectProgressSaved(attemptId, { block: 'hoeren' });

  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL('**/practice/lesen');
  await page.getByTestId(`go-to-question-${LONG_TASK}`).click();
  const reading = page.getByTestId('reading-text');
  await expect(reading).toHaveAttribute('data-text-id', LONG_TEXT);
  await page
    .getByTestId(`reading-paragraph-${THIRD_PARAGRAPH}`)
    .evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await expect(reading).toHaveAttribute('data-anchor', `${THIRD_PARAGRAPH}`);
  await expectProgressSaved(attemptId, {
    block: 'lesen',
    hoeren: { itemId: HOEREN_TASK },
    lesen: {
      itemId: LONG_QUESTION,
      textId: LONG_TEXT,
      paragraph: THIRD_PARAGRAPH,
    },
  });
};

// Back in Hören the guest finds the task they left, not the first one.
const expectHoerenPlaceKept = async (page: Page) => {
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL('**/practice');
  await expect(page.getByTestId('go-to-question-3')).toHaveAttribute(
    'aria-current',
    'step',
  );
};

const expectPlaceRestored = async (page: Page) => {
  await waitForPlayer(page);
  const reading = page.getByTestId('reading-text');
  await expect(reading).toHaveAttribute('data-text-id', LONG_TEXT);
  await expect(reading).toHaveAttribute('data-anchor', `${THIRD_PARAGRAPH}`);
  await expect(page.getByTestId(`go-to-question-${LONG_TASK}`)).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(
    page.getByTestId(`reading-paragraph-${THIRD_PARAGRAPH}`),
  ).toBeInViewport();
  await expect(
    optionIn(card(page, LONG_QUESTION), keyOf(LONG_QUESTION)),
  ).toBeChecked();
  expect(Math.abs((await timeOf(page)) - SEEK_SECONDS)).toBeLessThanOrEqual(
    SEEK_TOLERANCE,
  );
  expect(await isPaused(page)).toBe(true);
};

const validProgress = {
  block: 'lesen',
  positionSeconds: SEEK_SECONDS,
  hoeren: { itemId: HOEREN_TASK },
  lesen: {
    itemId: LONG_QUESTION,
    textId: LONG_TEXT,
    paragraph: THIRD_PARAGRAPH,
  },
} as const;

// A second guest with its own attempt and a stored place, made through the
// real functions.
const guestWithProgress = async () => {
  const created = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), created.guest, FULL_EXAM.slug);
  if (opened.status !== 'ready') throw new Error('practice is not ready');
  const { attemptId } = opened.practice;
  const saved = await saveProgress(depsNow(), created.token, {
    attemptId,
    progress: validProgress,
  });
  if (!saved.ok) throw new Error(`progress: ${saved.error}`);
  return { ...created, attemptId, sessionId: created.guest.sessionId };
};

test('restore recovers server confirmed position and answers', async ({
  browser,
}) => {
  const { context, page, token, sessionId, attemptId } =
    await startGuest(browser);
  await seedAnswers(token, attemptId);
  await page.goto('/practice');
  await reachPlace(page, attemptId);

  const stored = await readStoredAttempt(attemptId);
  expect(stored.progress?.block).toBe('lesen');
  expect(stored.progress?.lesen?.itemId).toBe(LONG_QUESTION);
  expect(stored.progress?.hoeren?.itemId).toBe(HOEREN_TASK);
  expect(
    Math.abs((stored.progress?.positionSeconds ?? 0) - SEEK_SECONDS),
  ).toBeLessThanOrEqual(SEEK_TOLERANCE);
  expect(stored.progress?.lesen?.paragraph).toBe(THIRD_PARAGRAPH);

  await page.reload();
  await expectPlaceRestored(page);

  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Continue as guest' }).click();
  await other.waitForURL('**/practice/lesen');
  await expectPlaceRestored(other);

  expect(await readStoredAttempts(sessionId)).toEqual([stored]);
  await expectHoerenPlaceKept(other);
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
    'hoeren-2': keyOf('hoeren-2'),
    [LONG_QUESTION]: keyOf(LONG_QUESTION),
  });
  await context.close();
});

test('restore shows completed result without new attempt', async ({
  browser,
}) => {
  const { context, page, token, sessionId, attemptId } =
    await startGuest(browser);
  await seedAnswers(token, attemptId);
  await saveProgress(depsNow(), token, { attemptId, progress: validProgress });
  const finished = await finishAttempt(depsNow(), token, { attemptId });
  expect(finished.ok).toBe(true);
  const results = await readResults(attemptId);

  await page.goto('/practice');
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('finish-attempt')).toHaveCount(0);

  const attempts = await readStoredAttempts(sessionId);
  expect(attempts.map((item) => item.id)).toEqual([attemptId]);
  expect(attempts[0]?.status).toBe('completed');
  expect(await readResults(attemptId)).toEqual(results);

  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('guest is not active');
  const opened = await openPractice(depsNow(), guest, FULL_EXAM.slug);
  if (opened.status !== 'ready') throw new Error('practice is not ready');
  expect(opened.practice.attemptId).toBe(attemptId);
  expect(opened.practice.progress).toBeNull();
  expect(opened.practice.review?.attemptId).toBe(attemptId);
  await context.close();
});

test('restore refuses foreign session', async () => {
  const owner = await guestWithProgress();
  const intruder = await newGuest(depsNow());
  const before = await readStoredAttempt(owner.attemptId);

  const written = await saveProgress(depsNow(), intruder.token, {
    attemptId: owner.attemptId,
    progress: {
      block: 'hoeren',
      hoeren: { itemId: 'hoeren-4' },
      positionSeconds: 5,
    },
  });
  expect(written).toEqual({ ok: false, error: 'attempt-not-found' });

  const opened = await openPractice(depsNow(), intruder.guest, FULL_EXAM.slug);
  if (opened.status !== 'ready') throw new Error('practice is not ready');
  expect(opened.practice.attemptId).not.toBe(owner.attemptId);
  expect(opened.practice.progress).toBeNull();
  expect(opened.practice.selections).toEqual({});

  expect(await readStoredAttempt(owner.attemptId)).toEqual(before);
  expect(before.progress).toEqual(validProgress);
  expect(await readAnswers(owner.attemptId)).toEqual({});
});

test('restore refuses foreign or expired session', async () => {
  const owner = await guestWithProgress();
  const before = await readStoredAttempt(owner.attemptId);
  const session = await readSession(owner.sessionId);
  const expiredAt = new Date(
    new Date(session.created_at).getTime() + TERM_HOURS * HOUR_MS,
  );
  const expired = depsAt(expiredAt);
  const attemptsBefore = await readStoredAttempts(owner.sessionId);

  const written = await saveProgress(expired, owner.token, {
    attemptId: owner.attemptId,
    progress: {
      block: 'hoeren',
      hoeren: { itemId: 'hoeren-4' },
      positionSeconds: 5,
    },
  });
  expect(written).toEqual({ ok: false, error: 'session-invalid' });
  const opened = await openPractice(expired, owner.guest, FULL_EXAM.slug);
  expect(opened).toEqual({ status: 'session-invalid' });

  const foreign = await newGuest(depsNow());
  const foreignOpened = await openPractice(
    depsNow(),
    foreign.guest,
    FULL_EXAM.slug,
  );
  if (foreignOpened.status !== 'ready') throw new Error('not ready');
  expect(foreignOpened.practice.progress).toBeNull();
  expect(foreignOpened.practice.attemptId).not.toBe(owner.attemptId);

  expect(await readStoredAttempt(owner.attemptId)).toEqual(before);
  expect(await readStoredAttempts(owner.sessionId)).toEqual(attemptsBefore);
});

test('malformed progress is refused without change', async () => {
  const owner = await guestWithProgress();
  const before = await readStoredAttempt(owner.attemptId);
  const attempts = await readStoredAttempts(owner.sessionId);

  const refused = [
    {
      progress: { ...validProgress, role: 'admin' },
      error: 'invalid-input',
    },
    {
      progress: { ...validProgress, positionSeconds: -1 },
      error: 'invalid-input',
    },
    {
      progress: {
        block: 'hoeren',
        hoeren: { itemId: 'group-outside-version' },
      },
      error: 'progress-not-allowed',
    },
    {
      progress: { block: 'lesen', lesen: { textId: 'text-outside-version' } },
      error: 'progress-not-allowed',
    },
  ];
  for (const { progress, error } of refused) {
    const result = await saveProgress(depsNow(), owner.token, {
      attemptId: owner.attemptId,
      progress,
    });
    expect(result).toEqual({ ok: false, error });
    expect(await readStoredAttempt(owner.attemptId)).toEqual(before);
  }
  expect(await readStoredAttempts(owner.sessionId)).toEqual(attempts);
});

test('blocked autoplay keeps restored seek position', async ({ browser }) => {
  const { context, page, token, attemptId } = await startGuest(browser);
  await seedAnswers(token, attemptId);
  await writeProgressAway(page, attemptId, {
    block: 'hoeren',
    hoeren: { itemId: 'hoeren-1' },
    positionSeconds: SEEK_SECONDS,
  });
  // Without a click the browser refuses play(); every refused call is counted.
  await context.addInitScript(() => {
    const target = window as unknown as { __blockedPlays: number };
    target.__blockedPlays = 0;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      if (!navigator.userActivation.isActive) {
        target.__blockedPlays++;
        return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      }
      return original.call(this);
    };
  });

  await page.goto('/practice');
  await waitForPlayer(page);
  await expect.poll(() => timeOf(page)).toBeCloseTo(SEEK_SECONDS, 0);
  await page.waitForTimeout(1_500);
  expect(await isPaused(page)).toBe(true);
  expect(Math.abs((await timeOf(page)) - SEEK_SECONDS)).toBeLessThan(
    SEEK_TOLERANCE,
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __blockedPlays: number }).__blockedPlays,
    ),
  ).toBe(0);

  await page.getByRole('button', { name: /Play/ }).click();
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
  await expect
    .poll(() => timeOf(page))
    .toBeGreaterThan(SEEK_SECONDS - SEEK_TOLERANCE);
  expect(await timeOf(page)).toBeLessThan(SEEK_SECONDS + 4);
  await context.close();
});

test('restored locale roundtrip keeps durable answers and seek', async ({
  browser,
}) => {
  const { context, page, token, attemptId } = await startGuest(browser);
  await seedAnswers(token, attemptId);
  await page.goto('/practice');
  await reachPlace(page, attemptId);
  await page.reload();
  await expectPlaceRestored(page);
  const answers = await readAnswers(attemptId);
  const before = await readStoredAttempt(attemptId);

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await expectPlaceRestored(page);
  expect(await readAnswers(attemptId)).toEqual(answers);
  expect(await readStoredAttempt(attemptId)).toEqual(before);
  await context.close();
});

test('invalid restored position has safe bounded fallback', async ({
  browser,
}) => {
  const { context, page, token, attemptId } = await startGuest(browser);
  await seedAnswers(token, attemptId);
  await writeProgressAway(page, attemptId, {
    block: 'hoeren',
    hoeren: { itemId: 'hoeren-1' },
    positionSeconds: 5_000,
  });
  await page.goto('/practice');
  await waitForPlayer(page);
  await expect.poll(() => timeOf(page)).toBeGreaterThan(RECORDING_SECONDS - 1);
  expect(await timeOf(page)).toBeLessThanOrEqual(RECORDING_SECONDS);
  await expect(
    optionIn(card(page, 'hoeren-1'), keyOf('hoeren-1')),
  ).toBeChecked();

  await writeProgressAway(page, attemptId, {
    block: 'lesen',
    lesen: { itemId: LONG_QUESTION, textId: LONG_TEXT, paragraph: 99 },
  });
  await page.goto('/practice/lesen');
  const reading = page.getByTestId('reading-text');
  await expect(reading).toHaveAttribute('data-text-id', LONG_TEXT);
  await expect(reading).toHaveAttribute('data-anchor', '0');
  await expect(page.getByTestId('reading-paragraph-0')).toBeInViewport();
  await expect(
    optionIn(card(page, LONG_QUESTION), keyOf(LONG_QUESTION)),
  ).toBeChecked();
  expect(await readAnswers(attemptId)).toMatchObject({
    'hoeren-1': keyOf('hoeren-1'),
    [LONG_QUESTION]: keyOf(LONG_QUESTION),
  });
  await context.close();
});

test('invalid restored locale cannot reset attempt', async ({ browser }) => {
  const { context, page, token, sessionId, attemptId } =
    await startGuest(browser);
  await seedAnswers(token, attemptId);
  await writeProgressAway(page, attemptId, validProgress);
  const before = await readStoredAttempts(sessionId);
  const answers = await readAnswers(attemptId);

  storeUnsupportedLocale(sessionId, 'de');
  try {
    await page.goto('/practice/lesen');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('finish-attempt')).toHaveText(
      'Finish attempt',
    );
    await expect(page.getByTestId('reading-text')).toHaveAttribute(
      'data-anchor',
      `${THIRD_PARAGRAPH}`,
    );
    await expect(
      optionIn(card(page, LONG_QUESTION), keyOf(LONG_QUESTION)),
    ).toBeChecked();
    expect(await readStoredAttempts(sessionId)).toEqual(before);
    expect(await readAnswers(attemptId)).toEqual(answers);
  } finally {
    restoreLocale(sessionId);
  }
  expect((await readSession(sessionId)).locale).toBe('en');
  await context.close();
});

test('progress failure does not block answers', async ({ browser }) => {
  let refusedSaves = 0;
  const { context, page, attemptId } = await startGuest(browser, {
    beforeLoad: (target) =>
      target.route(/\/practice(\/lesen)?$/, (route) => {
        const request = route.request();
        const body = request.postData() ?? '';
        if (request.method() === 'POST' && body.includes('"progress"')) {
          refusedSaves++;
          return route.abort();
        }
        return route.continue();
      }),
  });
  await page.getByTestId('go-to-question-2').click();

  const target = card(page, 'hoeren-2');
  await optionIn(target, keyOf('hoeren-2')).check();
  await expect(target.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    'saved',
  );
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-2': keyOf('hoeren-2'),
  });
  expect(refusedSaves).toBeGreaterThan(0);
  expect((await readStoredAttempt(attemptId)).progress).toBeNull();
  await context.close();
});

test('public client cannot write progress', async () => {
  const owner = await guestWithProgress();
  const before = await readStoredAttempt(owner.attemptId);

  const { error } = await createPublicClient().rpc('save_attempt_progress', {
    p_session_id: owner.sessionId,
    p_attempt_id: owner.attemptId,
    p_progress: {
      block: 'hoeren',
      hoeren: { itemId: 'hoeren-4' },
      positionSeconds: 5,
    },
    p_now: new Date().toISOString(),
  });
  expect(error).not.toBeNull();

  const direct = await createPublicClient()
    .from('attempts')
    .select('progress')
    .eq('id', owner.attemptId);
  expect(direct.data ?? []).toEqual([]);
  expect(await readStoredAttempt(owner.attemptId)).toEqual(before);
});
