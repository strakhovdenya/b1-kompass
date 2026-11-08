import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  depsNow,
  newGuest,
  readAttempts,
  serviceDb,
  startFor,
  submitStored,
} from './support/db';
import { FULL_EXAM, publishUniqueFullExam } from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  HOEREN_URL,
  LIBRARY_URL,
  attemptLesenUrl,
  attemptUrl,
  card,
  optionIn,
} from './support/guest-browser';
import { psqlJson, quote } from './support/sql';

// The exam context line (#76) against the full-set server: the way back to
// the library, the title the server read, the mode and the stage. The line is
// plain navigation: it never starts, cancels or submits anything.

const FULL_ORIGIN = 'http://localhost:3102';
const recording = createTestRecording();
const tagged = (): string => randomUUID().slice(0, 8);

const publishExam = (title: string) =>
  publishUniqueFullExam(serviceDb, recording, title);

const LONG_TITLE_TAIL =
  'Übungsprüfung Deutsch-Test für Zuwanderer Hören und Lesen mit sehr langem Titel';

const contextWith = async (
  browser: Pick<Browser, 'newContext'>,
  token: string,
  viewport = { width: 1440, height: 900 },
): Promise<BrowserContext> => {
  const context = await browser.newContext({ baseURL: FULL_ORIGIN, viewport });
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

// A guest with one free training of the whole set of the exam.
const guestWithAttempt = async (slug: string) => {
  const created: CreatedGuest = await newGuest(depsNow());
  const started = await startFor(depsNow(), created.token, slug);
  if (!started.ok) throw new Error(`start failed: ${started.failure}`);
  return {
    token: created.token,
    sessionId: created.guest.sessionId,
    attemptId: started.result.attemptId,
  };
};

const contextOf = (page: Page) => page.getByTestId('exam-context');
const linkOf = (page: Page) => page.getByTestId('exam-context-library');
const titleOf = (page: Page) => page.getByTestId('exam-context-title');
const whereOf = (page: Page) => page.getByTestId('exam-context-where');

// What the page keeps once: one app bar, one slot of the translator, one
// language switch and one h1.
const expectChromeOnce = async (page: Page, isReview = false) => {
  await expect(page.locator('header.MuiAppBar-root')).toHaveCount(1);
  await expect(page.locator('#training-header-slot')).toHaveCount(1);
  await expect(page.getByTestId('locale-ru')).toHaveCount(1);
  // The review brings no h1 of its own; the line never adds one.
  if (isReview) {
    expect(await page.locator('h1').count()).toBeLessThanOrEqual(1);
  } else {
    await expect(page.locator('h1')).toHaveCount(1);
  }
  await expect(contextOf(page)).toHaveCount(1);
  await expect(contextOf(page).locator('h1, h2, h3, h4, h5, h6')).toHaveCount(
    0,
  );
};

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

test('exam context shows trusted exam and library navigation', async ({
  browser,
}) => {
  const exam = await publishExam(`Ctx ${tagged()} Übungstest A`);
  const guest = await guestWithAttempt(exam.slug);
  const context = await contextWith(browser, guest.token);
  const page = await context.newPage();

  // The choice of the exam: title and way back, no mode and no stage. A
  // title in the address is not trusted: the slug decides.
  await page.goto(`/practice/${exam.slug}?title=Forged&mode=exam`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await expectChromeOnce(page);
  await expect(titleOf(page)).toHaveText(exam.title);
  await expect(titleOf(page)).toHaveAttribute('lang', 'de');
  await expect(linkOf(page)).toHaveAttribute('href', '/exams');
  await expect(whereOf(page)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Forged');

  // Hören of the attempt: mode and stage come from the server's attempt.
  await page.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await expectChromeOnce(page);
  await expect(titleOf(page)).toHaveText(exam.title);
  await expect(linkOf(page)).toHaveAttribute('href', '/exams');
  await expect(whereOf(page)).toHaveText('Free training · Hören');
  await expect(page.locator('#training-header-slot')).not.toContainText(
    exam.title,
  );

  // Lesen of the same attempt, reached by the block link: the shell stays.
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL(`**${attemptLesenUrl(exam.slug, guest.attemptId)}`);
  await expect(whereOf(page)).toHaveText('Free training · Lesen');
  await expectChromeOnce(page);
  await expect(titleOf(page)).toHaveText(exam.title);

  // The language of the guest changes the labels, never the German title.
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(whereOf(page)).toHaveText('Тренировка · Lesen');
  await expect(linkOf(page)).toContainText('Все экзамены');
  await expect(titleOf(page)).toHaveText(exam.title);
  await page.getByTestId('locale-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(linkOf(page)).toContainText('All exams');

  // The review of the completed attempt keeps the context.
  const done = await submitStored(depsNow(), guest.token, {
    attemptId: guest.attemptId,
  });
  expect(done.ok).toBe(true);
  await page.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(page.getByTestId('training-shell')).toBeVisible();
  await expectChromeOnce(page, true);
  await expect(titleOf(page)).toHaveText(exam.title);
  await expect(linkOf(page)).toHaveAttribute('href', '/exams');
  await expect(whereOf(page)).toHaveText('Free training · Result');

  // The way back leads to the library, which is a different page.
  await linkOf(page).click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
  await expect(contextOf(page)).toHaveCount(0);
  await context.close();
});

test('exam context never shows foreign or mismatched exam', async ({
  browser,
}) => {
  const tag = tagged();
  const examA = await publishExam(`Ctx ${tag} Geheim A`);
  const examB = await publishExam(`Ctx ${tag} Geheim B`);
  const owner = await guestWithAttempt(examA.slug);
  const stranger = await newGuest(depsNow());

  const strangerContext = await contextWith(browser, stranger.token);
  const strangerPage = await strangerContext.newPage();
  await strangerPage.goto(attemptUrl(examA.slug, owner.attemptId));
  await expect(contextOf(strangerPage)).toHaveCount(0);
  await expect(strangerPage.locator('body')).not.toContainText(examA.title);
  await expect(strangerPage.locator('body')).not.toContainText(examB.title);
  await strangerContext.close();

  // The own attempt of A under the address of B shows neither of them.
  const ownerContext = await contextWith(browser, owner.token);
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(attemptUrl(examB.slug, owner.attemptId));
  await expect(contextOf(ownerPage)).toHaveCount(0);
  await expect(ownerPage.locator('body')).not.toContainText(examA.title);
  await expect(ownerPage.locator('body')).not.toContainText(examB.title);

  // The right address still shows the right exam.
  await ownerPage.goto(attemptUrl(examA.slug, owner.attemptId));
  await expect(titleOf(ownerPage)).toHaveText(examA.title);
  await ownerContext.close();
});

interface Viewport {
  width: number;
  height: number;
}

const VIEWPORTS: readonly Viewport[] = [
  { width: 320, height: 640 },
  { width: 390, height: 667 },
  { width: 1440, height: 900 },
];

const expectNoHorizontalScroll = async (page: Page) => {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
};

// The title is one cut line, never wrapped, and is not squeezed to nothing;
// the link and the mode share one row above it on a phone.
const expectOneLineTitle = async (page: Page) => {
  const title = await titleOf(page).boundingBox();
  expect(title?.height ?? Infinity).toBeLessThanOrEqual(28);
  expect(title?.width ?? 0).toBeGreaterThanOrEqual(120);
  const box = await contextOf(page).boundingBox();
  expect(box?.height ?? Infinity).toBeLessThanOrEqual(56);
};

const expectKeyboardFocus = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const link = linkOf(page);
  let isFocused = false;
  for (let step = 0; step < 12 && !isFocused; step += 1) {
    await page.keyboard.press('Tab');
    isFocused = await link.evaluate((node) => node === document.activeElement);
  }
  expect(isFocused).toBe(true);
  const outline = await link.evaluate((node) => {
    const style = getComputedStyle(node);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).not.toBe('0px');
};

test('exam context remains accessible responsive and dictionary safe', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam(`Ctx ${tagged()} ${LONG_TITLE_TAIL}`);
  const guest = await guestWithAttempt(exam.slug);

  for (const viewport of VIEWPORTS) {
    const context = await contextWith(browser, guest.token, viewport);
    const page = await context.newPage();
    for (const locale of ['en', 'ru']) {
      await page.goto(`/practice/${exam.slug}`);
      await expect(page.getByTestId('mode-selection')).toBeVisible();
      if (locale === 'ru') {
        await page.getByTestId('locale-ru').click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
      }
      await expectNoHorizontalScroll(page);
      await expectOneLineTitle(page);
      await expect(titleOf(page)).toHaveText(exam.title);

      await page.goto(attemptUrl(exam.slug, guest.attemptId));
      await expect(card(page, 'hoeren-1')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectOneLineTitle(page);
      await expect(titleOf(page)).toHaveText(exam.title);
      await expect(linkOf(page)).toBeVisible();
      await expect(whereOf(page)).toBeVisible();
      await expectKeyboardFocus(page);

      if (viewport.width === 320) {
        const isCut = await titleOf(page).evaluate(
          (node) => node.scrollWidth > node.clientWidth,
        );
        expect(isCut).toBe(true);
      }
      if (locale === 'ru') {
        await page.getByTestId('locale-en').click();
        await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      }
    }

    // The dictionary keeps its switch in the app bar and its own scope: the
    // context line is outside of it and opens no card.
    await page.goto(attemptLesenUrl(exam.slug, guest.attemptId));
    await expect(page.getByTestId('reading-paragraph-0')).toBeVisible();
    await expect(page.getByTestId('dictionary-toggle')).toHaveCount(1);
    await expect(page.getByTestId('dictionary-toggle')).toBeVisible();
    await expect(
      page.locator('#training-header-slot').getByTestId('dictionary-toggle'),
    ).toHaveCount(1);
    await expectNoHorizontalScroll(page);
    const toggle = page.getByTestId('dictionary-toggle');
    const isOn = (await toggle.getAttribute('aria-pressed')) === 'true';
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', String(!isOn));
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', String(isOn));
    await titleOf(page).dblclick();
    await expect(page.getByTestId('dictionary-card')).toHaveCount(0);
    await context.close();
  }
});

test('exam context keeps the first question on the first phone screen', async ({
  browser,
}) => {
  const exam = await publishExam(`${tagged()} DTZ Übungstest 2`);
  const guest = await guestWithAttempt(exam.slug);
  const context = await contextWith(browser, guest.token, {
    width: 390,
    height: 667,
  });
  const page = await context.newPage();
  await page.goto(attemptUrl(exam.slug, guest.attemptId));
  await expect(card(page, 'hoeren-1')).toBeVisible();
  const question = await card(page, 'hoeren-1').boundingBox();
  const first = await optionIn(card(page, 'hoeren-1'), 'a').boundingBox();
  expect(question).not.toBeNull();
  expect(first).not.toBeNull();
  // The question starts well inside the first screen and its first option
  // begins there too; font metrics of the runner move this by some pixels.
  expect(question?.y ?? Infinity).toBeLessThan(667 - 100);
  expect(first?.y ?? Infinity).toBeLessThan(667);
  await context.close();
});

test('library link from legacy and direct urls keeps attempt active', async ({
  browser,
}) => {
  const guest = await guestWithAttempt(FULL_EXAM.slug);
  const before = countsOf(guest.sessionId);
  expect(before.attempts).toBe(1);

  const expectUntouched = async () => {
    expect(countsOf(guest.sessionId)).toEqual(before);
    const attempts = await readAttempts(guest.sessionId);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['active']);
  };

  const context = await contextWith(browser, guest.token);
  const page = await context.newPage();

  // The legacy address continues the active attempt; the way back leaves it.
  await page.goto('/practice');
  await page.waitForURL(HOEREN_URL);
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await linkOf(page).click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
  await expectUntouched();

  // The direct address of the own attempt does the same.
  await page.goto(attemptUrl(FULL_EXAM.slug, guest.attemptId));
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await linkOf(page).click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
  await expectUntouched();

  // The attempt is still there to continue.
  await page.goto(attemptUrl(FULL_EXAM.slug, guest.attemptId));
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await expectUntouched();
  await context.close();
});
