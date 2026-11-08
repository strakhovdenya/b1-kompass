import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAttempts,
  readResults,
  serviceDb,
  startFor,
  submitStored,
} from './support/db';
import {
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  ensureConfirmedTestProfile,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import { LIBRARY_URL, attemptUrl, card } from './support/guest-browser';
import { psqlJson, quote, sqlRunnerAs } from './support/sql';

// The warning before the guest leaves a running timed block or exam for the
// library (#77). The dialog is client navigation only: the server keeps the
// run, its deadline and its status whatever the guest answers, so every case
// re-reads the database instead of trusting the screen.

const FULL_ORIGIN = 'http://localhost:3102';
const owner = sqlRunnerAs('owner');

interface Exam {
  slug: string;
}

// An exam with a confirmed timing profile under a slug of its own.
const publishExam = async (): Promise<Exam> => {
  const slug = `test-nav-${randomUUID().slice(0, 8)}`;
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: `Nav ${slug} Übungstest`,
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(517) }],
  });
  ensureConfirmedTestProfile(owner, outcome.versionId, FULL_TIMING);
  if (!(await latestVersionOf(slug))) throw new Error('exam is missing');
  return { slug };
};

interface Started {
  token: string;
  sessionId: string;
  attemptId: string;
}

const startedAttempt = async (
  slug: string,
  body: { mode: string; selection: string },
): Promise<Started> => {
  const created: CreatedGuest = await newGuest(depsNow());
  const started = await startFor(depsNow(), created.token, slug, body);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error(`start failed: ${JSON.stringify(started)}`);
  }
  return {
    token: created.token,
    sessionId: created.guest.sessionId,
    attemptId: started.result.attemptId,
  };
};

const timedBlock = (slug: string) =>
  startedAttempt(slug, { mode: 'timed-block', selection: 'hoeren' });
const fullExam = (slug: string) =>
  startedAttempt(slug, { mode: 'exam', selection: 'all' });
const freeTraining = (slug: string) =>
  startedAttempt(slug, { mode: 'training', selection: 'all' });

const contextWith = async (
  browser: Pick<Browser, 'newContext'>,
  token: string,
  viewport = { width: 1280, height: 800 },
): Promise<BrowserContext> => {
  const context = await browser.newContext({ baseURL: FULL_ORIGIN, viewport });
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

// Everything the server holds about the run and the guest's attempts: the
// whole run row (deadline-bearing columns included), the attempt statuses,
// the start events and the results. Equal before and after means untouched.
interface ServerState {
  run: unknown;
  attempts: { id: string; status: string }[];
  starts: number;
  results: number;
}

const stateOf = async (guest: Started): Promise<ServerState> => ({
  run: psqlJson<unknown>(
    `select to_jsonb(r) from public.attempt_runs r
      where r.attempt_id = ${quote(guest.attemptId)}`,
  ),
  attempts: await readAttempts(guest.sessionId),
  starts: psqlJson<number>(`select count(*) from public.guest_events e
      join public.guest_sessions s on s.visitor_id = e.visitor_id
      where s.id = ${quote(guest.sessionId)} and e.kind = 'start'`),
  results: (await readResults(guest.attemptId)).length,
});

const linkOf = (page: Page) => page.getByTestId('exam-context-library');
const dialogOf = (page: Page) => page.getByTestId('timed-leave-dialog');

// Commands that change an attempt: none of them may leave the browser while
// the warning is answered.
const watchAttemptCommands = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/api\/attempts\/(start|submit|cancel)/.test(pathname)) {
      seen.push(`${request.method()} ${pathname}`);
    }
  });
  return seen;
};

const deadlineOf = async (page: Page): Promise<number> =>
  Number(
    await page.getByTestId('attempt-timer').getAttribute('data-deadline-ms'),
  );

test('timed exam navigation warns without changing run', async ({
  browser,
}) => {
  const exam = await publishExam();
  const guest = await timedBlock(exam.slug);
  const before = await stateOf(guest);
  const context = await contextWith(browser, guest.token);
  const page = await context.newPage();
  const commands = watchAttemptCommands(page);

  await page.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(card(page, 'hoeren-1')).toBeVisible();
  const url = page.url();
  const deadline = await deadlineOf(page);

  // The link opens the warning instead of leaving.
  await linkOf(page).click();
  await expect(dialogOf(page)).toBeVisible();
  await expect(page).toHaveURL(url);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('The time keeps running');
  await expect(dialog).toHaveAccessibleDescription(/continues while you are/);
  await expect(dialog.getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('timed-leave-stay')).toBeFocused();

  // Escape stays: the focus returns to the link, nothing else moves.
  await page.keyboard.press('Escape');
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(linkOf(page)).toBeFocused();
  await expect(page).toHaveURL(url);

  // "Stay" does the same, by the button.
  await linkOf(page).click();
  await expect(dialogOf(page)).toBeVisible();
  await page.getByTestId('timed-leave-stay').click();
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(linkOf(page)).toBeFocused();
  await expect(page).toHaveURL(url);

  // The screen is the same attempt with the same deadline.
  await expect(card(page, 'hoeren-1')).toBeVisible();
  expect(await deadlineOf(page)).toBe(deadline);
  expect(commands).toEqual([]);
  expect(await stateOf(guest)).toEqual(before);

  // The Russian guest reads the same warning in Russian.
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await linkOf(page).click();
  await expect(dialogOf(page)).toBeVisible();
  await expect(dialog).toHaveAccessibleName('Время продолжает идти');
  await expect(page.getByTestId('timed-leave-stay')).toHaveText('Остаться');
  await expect(page.getByTestId('timed-leave-confirm')).toHaveText(
    'Перейти — время продолжит идти',
  );
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(dialogOf(page)).toHaveCount(0);
  expect(commands).toEqual([]);
  expect(await stateOf(guest)).toEqual(before);
  await context.close();
});

test('timed leave confirm preserves server deadline', async ({ browser }) => {
  const exam = await publishExam();
  const guest = await fullExam(exam.slug);
  const before = await stateOf(guest);
  const context = await contextWith(browser, guest.token);
  const page = await context.newPage();
  const commands = watchAttemptCommands(page);

  await page.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-mode',
    'exam',
  );
  const deadline = await deadlineOf(page);

  await linkOf(page).click();
  await expect(dialogOf(page)).toBeVisible();
  await page.getByTestId('timed-leave-confirm').click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();

  // The server still holds the same active attempt, run and deadline, and
  // wrote no new start, result or command.
  expect(commands).toEqual([]);
  const after = await stateOf(guest);
  expect(after).toEqual(before);
  expect(after.attempts.map((attempt) => attempt.status)).toEqual(['active']);

  // Coming back through "Continue" shows the server's own deadline.
  await page
    .getByTestId(`exam-card-${exam.slug}`)
    .getByTestId('exam-card-continue')
    .click();
  await page.waitForURL(`**${attemptUrl(exam.slug, guest.attemptId)}`);
  await expect(page.getByTestId('attempt-timer')).toBeVisible();
  expect(await deadlineOf(page)).toBe(deadline);
  expect(await stateOf(guest)).toEqual(before);
  await context.close();
});

test('free training and review leave without warning', async ({ browser }) => {
  const exam = await publishExam();

  // A free training: the link leaves at once.
  const training = await freeTraining(exam.slug);
  const trainingBefore = await stateOf(training);
  const trainingContext = await contextWith(browser, training.token);
  const trainingPage = await trainingContext.newPage();
  await trainingPage.goto(attemptUrl(exam.slug, training.attemptId));
  await expect(card(trainingPage, 'hoeren-1')).toBeVisible();
  await linkOf(trainingPage).click();
  await trainingPage.waitForURL(LIBRARY_URL);
  await expect(dialogOf(trainingPage)).toHaveCount(0);
  expect(await stateOf(training)).toEqual(trainingBefore);

  // The review of a finished timed block: context and Result stage, and the
  // link leaves at once as well.
  const timed = await timedBlock(exam.slug);
  const done = await submitStored(depsNow(), timed.token, {
    attemptId: timed.attemptId,
  });
  expect(done.ok).toBe(true);
  const timedBefore = await stateOf(timed);
  const timedContext = await contextWith(browser, timed.token);
  const timedPage = await timedContext.newPage();
  await timedPage.goto(attemptUrl(exam.slug, timed.attemptId));
  await expect(timedPage.getByTestId('training-shell')).toBeVisible();
  await expect(timedPage.getByTestId('exam-context-where')).toContainText(
    'Result',
  );
  await linkOf(timedPage).click();
  await timedPage.waitForURL(LIBRARY_URL);
  await expect(dialogOf(timedPage)).toHaveCount(0);
  expect(await stateOf(timed)).toEqual(timedBefore);
  await trainingContext.close();
  await timedContext.close();
});

test('leaving in one tab keeps timed run in another', async ({ browser }) => {
  const exam = await publishExam();
  const guest = await timedBlock(exam.slug);
  const before = await stateOf(guest);
  const context = await contextWith(browser, guest.token);
  const first = await context.newPage();
  const second = await context.newPage();

  await first.goto(attemptUrl(exam.slug, guest.attemptId));
  await second.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(card(first, 'hoeren-1')).toBeVisible();
  await expect(card(second, 'hoeren-1')).toBeVisible();
  const deadline = await deadlineOf(second);

  await linkOf(first).click();
  await expect(dialogOf(first)).toBeVisible();
  await first.getByTestId('timed-leave-confirm').click();
  await first.waitForURL(LIBRARY_URL);

  // The other tab keeps the attempt, the same deadline and no warning.
  await expect(card(second, 'hoeren-1')).toBeVisible();
  await expect(dialogOf(second)).toHaveCount(0);
  expect(await deadlineOf(second)).toBe(deadline);
  await second.reload();
  expect(await deadlineOf(second)).toBe(deadline);
  expect(await stateOf(guest)).toEqual(before);
  await context.close();
});

test('leave after submission in another tab changes nothing', async ({
  browser,
}) => {
  const exam = await publishExam();
  const guest = await timedBlock(exam.slug);
  const context = await contextWith(browser, guest.token);
  const page = await context.newPage();
  const commands = watchAttemptCommands(page);

  // The first tab still shows the open attempt.
  await page.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(card(page, 'hoeren-1')).toBeVisible();

  // Another tab submits: the server completes the attempt.
  const done = await submitStored(depsNow(), guest.token, {
    attemptId: guest.attemptId,
  });
  expect(done.ok).toBe(true);
  const submitted = await stateOf(guest);
  expect(submitted.attempts.map((attempt) => attempt.status)).toEqual([
    'completed',
  ]);
  expect(submitted.results).toBe(1);

  // The stale screen may still warn; confirming only navigates.
  await linkOf(page).click();
  if (await dialogOf(page).isVisible()) {
    await page.getByTestId('timed-leave-confirm').click();
  }
  await page.waitForURL(LIBRARY_URL);
  expect(commands).toEqual([]);
  expect(await stateOf(guest)).toEqual(submitted);
  await context.close();
});
