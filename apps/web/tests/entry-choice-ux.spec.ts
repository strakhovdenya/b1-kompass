import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, Request } from '@playwright/test';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  newGuest,
  readAttempts,
  readSessionByToken,
  serviceDb,
  startFor,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  CHOICE_URL,
  FULL_ORIGIN,
  HOEREN_URL,
  LESEN_URL,
  attemptIdOf,
  tokenOf,
} from './support/guest-browser';
import {
  expectNoFocusTrap,
  expectUsableLayout,
  expectVisibleFocus,
  tabTo,
} from './support/release';

// The first two screens of a guest (#48): the home page and the choice of a
// mode. They run in the parallel `full` project, so nothing here fills the
// site-wide rate-limit window: the busy notice is only looked at, the real
// window is the business of guest-limits.spec.ts. Locators use test ids, so
// the specs hold in both interface languages.
//
// The agreed equivalent of a 200 % browser zoom is a CSS viewport of 320 px.

const PHONE = { width: 390, height: 667 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
const ZOOMED = { width: 320, height: 568 } as const;
const MIN_TARGET_PX = 44;
const MINUTE_SECONDS = 60;
const READY_TIMEOUT_MS = 20_000;

const HOME = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '..', 'messages', 'en.json'),
    'utf8',
  ),
).home as { busy: string; note: string; continue: string };

interface Viewport {
  width: number;
  height: number;
}

const START_URL = '**/api/attempts/start';
const PREPARE_URL = '**/api/attempts/prepare-audio';

const guestCookieOf = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === GUEST_COOKIE);

const requestsTo = (page: Page, pathname: string): Request[] => {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === pathname
    ) {
      seen.push(request);
    }
  });
  return seen;
};

const sessionOf = async (context: BrowserContext) => {
  const session = await readSessionByToken(await tokenOf(context));
  if (!session) throw new Error('guest session is missing');
  return session;
};

// A guest of its own browser context, entered through the real CTA.
const enter = async (browser: Browser, viewport: Viewport) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('guest-continue').click();
  await page.waitForURL(CHOICE_URL);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  return { context, page };
};

// A guest created beside the browser, with its cookie in a new context.
const contextOf = async (
  browser: Browser,
  token: string,
  viewport: Viewport = DESKTOP,
) => {
  const context = await browser.newContext({
    baseURL: FULL_ORIGIN,
    viewport,
  });
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

const switchTo = async (page: Page, locale: 'en' | 'ru') => {
  await page.getByTestId(`locale-${locale}`).click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
};

const readyExamAudio = (page: Page) =>
  expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: READY_TIMEOUT_MS },
  );

const radioOf = (page: Page, testId: string) =>
  page.getByTestId(testId).getByRole('radio');

// An exam of its own without a confirmed timing profile: its full exam is
// not offered yet.
const publishWithoutProfile = async (): Promise<string> => {
  const slug = `test-ux-${randomUUID().slice(0, 8)}`;
  await publishExamVersion(serviceDb, {
    slug,
    title: 'Choice UX test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording() }],
  });
  return slug;
};

const expectTapTarget = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box?.height ?? 0, `${testId} height`).toBeGreaterThanOrEqual(
    MIN_TARGET_PX,
  );
};

test('guest entry has clear responsive hierarchy and explicit session creation', async ({
  browser,
}) => {
  for (const viewport of [PHONE, DESKTOP]) {
    const screen = `home ${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const cookieRequests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/attempts')) cookieRequests.push(pathname);
    });
    await page.goto('/');

    // One heading, both skills, one primary action and the honest term.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(
      page.getByTestId('home-skills').getByRole('heading'),
    ).toHaveCount(2);
    await expect(page.getByTestId('home-skills')).toContainText('Hören');
    await expect(page.getByTestId('home-skills')).toContainText('Lesen');
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(1);
    const cta = page.getByTestId('guest-continue');
    await expect(cta).toHaveText(HOME.continue);
    await expect(page.getByTestId('guest-note')).toContainText(HOME.note);
    expect(HOME.note).toContain('30');
    await expectTapTarget(page, 'guest-continue');
    await expectUsableLayout(page, screen);

    // Nothing exists before the click: no cookie, no attempt, no start.
    expect(await guestCookieOf(context), screen).toBeUndefined();
    expect(cookieRequests, screen).toEqual([]);

    await cta.click();
    await page.waitForURL(CHOICE_URL);
    await expect(page.getByTestId('mode-selection')).toBeVisible();
    const session = await sessionOf(context);
    expect(await guestCookieOf(context), screen).toBeDefined();
    expect(session.locale).toBe('en');
    expect(await readAttempts(session.id), `${screen}: attempts`).toEqual([]);
    await context.close();
  }
});

test('mode choice is scannable accessible and preserves explicit start', async ({
  browser,
}) => {
  const slug = await publishWithoutProfile();
  const unconfirmed = await contextOf(
    browser,
    (await newGuest(depsNow())).token,
  );
  const lockedPage = await unconfirmed.newPage();
  await lockedPage.goto(`/practice/${slug}`);

  // A mode without a confirmed profile is shown but cannot be chosen; the
  // free training stays the default and starts.
  await expect(lockedPage.getByTestId('mode-selection')).toBeVisible();
  await expect(radioOf(lockedPage, 'mode-option-exam')).toBeDisabled();
  await expect(radioOf(lockedPage, 'mode-option-training')).toBeChecked();
  await expect(lockedPage.getByTestId('start-attempt')).toBeEnabled();
  await unconfirmed.close();

  for (const viewport of [PHONE, DESKTOP]) {
    for (const locale of ['en', 'ru'] as const) {
      const screen = `choice ${viewport.width} ${locale}`;
      const { context, page } = await enter(browser, viewport);
      if (locale === 'ru') await switchTo(page, 'ru');
      const starts = requestsTo(page, '/api/attempts/start');
      const session = await sessionOf(context);

      // Three cards in a labelled group, and a separate labelled selection.
      const groups = page.getByTestId('mode-selection').getByRole('radiogroup');
      await expect(groups).toHaveCount(2);
      for (const group of await groups.all()) {
        const labelId = await group.getAttribute('aria-labelledby');
        expect(labelId, screen).toBeTruthy();
        await expect(page.locator(`#${labelId}`)).not.toBeEmpty();
      }
      for (const mode of ['training', 'timed-block', 'exam']) {
        await expect(page.getByTestId(`mode-option-${mode}`)).toBeVisible();
      }
      await expect(radioOf(page, 'mode-option-training')).toBeChecked();
      await expect(page.getByTestId('mode-option-exam')).toContainText(
        String(FULL_TIMING.hoerenSeconds / MINUTE_SECONDS),
      );
      await expect(page.getByTestId('mode-option-exam')).toContainText(
        String(FULL_TIMING.lesenSeconds / MINUTE_SECONDS),
      );

      // A timed block is one skill: the whole set is not offered for it.
      await page.getByTestId('mode-option-timed-block').click();
      await expect(radioOf(page, 'mode-option-timed-block')).toBeChecked();
      await expect(radioOf(page, 'selection-option-all')).toBeDisabled();
      await expect(radioOf(page, 'selection-option-hoeren')).toBeChecked();
      await page.getByTestId('mode-option-training').click();
      await expect(radioOf(page, 'selection-option-all')).toBeEnabled();

      // The selected card is marked beyond colour: a checked radio and an
      // inset ring that the others do not have.
      const ringOf = (mode: string) =>
        page
          .getByTestId(`mode-option-${mode}`)
          .evaluate((element) => getComputedStyle(element).boxShadow);
      expect(await ringOf('training'), screen).not.toBe('none');
      expect(await ringOf('exam'), screen).toBe('none');

      await expectTapTarget(page, 'start-attempt');
      await expectUsableLayout(page, screen);
      await expectNoFocusTrap(page, screen);

      // Browsing wrote nothing and sent no start; the one click does.
      expect(starts, screen).toHaveLength(0);
      expect(await readAttempts(session.id), screen).toEqual([]);
      await page.getByTestId('start-attempt').click();
      await page.waitForURL(HOEREN_URL);
      expect(starts, screen).toHaveLength(1);
      const attempts = await readAttempts(session.id);
      expect(attempts.map((attempt) => attempt.id)).toEqual([
        attemptIdOf(page),
      ]);
      await context.close();
    }
  }

  // The full exam: prepared first, started by the same click.
  const { context, page } = await enter(browser, PHONE);
  const session = await sessionOf(context);
  const prepares = requestsTo(page, '/api/attempts/prepare-audio');
  await page.getByTestId('mode-option-exam').click();
  await readyExamAudio(page);
  expect(prepares.length).toBeGreaterThanOrEqual(1);
  expect(await readAttempts(session.id)).toEqual([]);
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  expect(await readAttempts(session.id)).toHaveLength(1);
  await context.close();
});

test('entry and mode controls remain usable with zoom keyboard and errors', async ({
  browser,
}) => {
  for (const viewport of [ZOOMED, PHONE]) {
    const screen = `${viewport.width}px`;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto('/');

    // The home page by keyboard alone.
    await expectUsableLayout(page, `home ${screen}`);
    await expectNoFocusTrap(page, `home ${screen}`);
    await tabTo(page, page.getByTestId('guest-continue'), `home ${screen}`);
    await page.keyboard.press('Enter');
    await page.waitForURL(CHOICE_URL);
    await expect(page.getByTestId('mode-selection')).toBeVisible();
    const session = await sessionOf(context);

    // The choice by keyboard: the arrow keys move the radio of the group.
    await expectUsableLayout(page, `choice ${screen}`);
    await expectNoFocusTrap(page, `choice ${screen}`);
    await tabTo(page, radioOf(page, 'mode-option-training'), `modes ${screen}`);
    await page.keyboard.press('ArrowDown');
    await expect(radioOf(page, 'mode-option-timed-block')).toBeChecked();
    await expect(radioOf(page, 'selection-option-hoeren')).toBeChecked();
    await page.keyboard.press('ArrowUp');
    await expect(radioOf(page, 'mode-option-training')).toBeChecked();
    // The block chosen on the way (Hören) is the one stop of its group.
    await tabTo(
      page,
      radioOf(page, 'selection-option-hoeren'),
      `skill ${screen}`,
    );
    await page.keyboard.press('ArrowDown');
    await expect(radioOf(page, 'selection-option-lesen')).toBeChecked();

    // A failed start names the problem in an alert, keeps the choice and the
    // Start button, and the keyboard retries it.
    let failures = 0;
    await page.route(START_URL, async (route) => {
      failures += 1;
      await route.fulfill({ status: 500, json: {} });
    });
    await tabTo(page, page.getByTestId('start-attempt'), `start ${screen}`);
    await page.keyboard.press('Enter');
    const error = page.getByTestId('start-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).not.toBeEmpty();
    expect(failures).toBe(1);
    await expect(radioOf(page, 'selection-option-lesen')).toBeChecked();
    await expectUsableLayout(page, `error ${screen}`);
    await expect(page.getByTestId('start-attempt')).toBeEnabled();
    await page.unroute(START_URL);
    await tabTo(page, page.getByTestId('start-attempt'), `retry ${screen}`);
    await expectVisibleFocus(page, `retry ${screen}`);
    await page.keyboard.press('Enter');
    await page.waitForURL(LESEN_URL);
    expect(await readAttempts(session.id)).toHaveLength(1);
    await context.close();
  }

  // A failed preparation of the exam recording is explained, offers its own
  // retry, and the keyboard reaches and uses it.
  const { context, page } = await enter(browser, ZOOMED);
  await page.route(PREPARE_URL, (route) =>
    route.fulfill({ status: 500, json: {} }),
  );
  await page.getByTestId('mode-option-exam').click();
  const status = page.getByTestId('exam-audio-status');
  await expect(status).toHaveAttribute('data-status', 'error');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('start-attempt')).toBeDisabled();
  await expectUsableLayout(page, 'audio error 320px');
  await page.unroute(PREPARE_URL);
  await tabTo(page, page.getByTestId('exam-audio-retry'), 'audio retry 320px');
  await page.keyboard.press('Enter');
  await readyExamAudio(page);
  await expect(page.getByTestId('start-attempt')).toBeEnabled();
  await expectNoFocusTrap(page, 'exam choice 320px');
  await context.close();
});

test('mode selection refuses stale exam start and preserves active continuation', async ({
  browser,
}) => {
  // An exam recording that cannot be prepared starts nothing.
  const first = await enter(browser, DESKTOP);
  const firstStarts = requestsTo(first.page, '/api/attempts/start');
  await first.page.route(PREPARE_URL, (route) =>
    route.fulfill({ status: 500, json: {} }),
  );
  await first.page.getByTestId('mode-option-exam').click();
  await expect(first.page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'error',
  );
  await expect(first.page.getByTestId('start-attempt')).toBeDisabled();
  expect(firstStarts).toHaveLength(0);
  await first.context.close();

  // An address that no longer covers the Hören is renewed before any start:
  // the first answer is made short-lived, the renewal is held. While it is
  // held the Start button stays closed and no start leaves the page.
  const second = await enter(browser, DESKTOP);
  const secondSession = await sessionOf(second.context);
  const starts = requestsTo(second.page, '/api/attempts/start');
  const prepares = requestsTo(second.page, '/api/attempts/prepare-audio');
  let releaseRenewal: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseRenewal = resolve;
  });
  let asked = 0;
  await second.page.route(PREPARE_URL, async (route) => {
    asked += 1;
    if (asked > 1) {
      await held;
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.audio.expiresAt = new Date(
      Date.parse(body.audio.serverNow) + 5000,
    ).toISOString();
    await route.fulfill({ response, json: body });
  });
  await second.page.getByTestId('mode-option-exam').click();
  await expect.poll(() => prepares.length).toBeGreaterThanOrEqual(2);
  await expect(second.page.getByTestId('start-attempt')).toBeDisabled();
  await expect(
    second.page.getByTestId('exam-audio-status'),
  ).not.toHaveAttribute('data-status', 'ready');
  expect(starts).toHaveLength(0);
  expect(await readAttempts(secondSession.id)).toEqual([]);
  releaseRenewal();
  await readyExamAudio(second.page);
  await expect(second.page.getByTestId('start-attempt')).toBeEnabled();
  await second.page.getByTestId('start-attempt').click();
  await second.page.waitForURL(HOEREN_URL);
  expect(starts).toHaveLength(1);
  expect(await readAttempts(secondSession.id)).toHaveLength(1);
  await second.context.close();

  // A guest with an active attempt: the link to continue is on the screen,
  // a start is refused as a conflict, the link survives and nothing is added.
  const created = await newGuest(depsNow());
  const started = await startFor(depsNow(), created.token, FULL_EXAM.slug);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error('the active attempt was not started');
  }
  const { attemptId } = started.result;
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.goto(`/practice/${FULL_EXAM.slug}`);
  const link = page.getByTestId('continue-attempt');
  await expect(page.getByTestId('active-attempt')).toBeVisible();
  await expect(link).toHaveAttribute('href', new RegExp(`${attemptId}$`));
  await page.getByTestId('start-attempt').click();
  await expect(page.getByTestId('start-status')).toHaveAttribute(
    'data-status',
    'conflict',
  );
  await expect(link).toHaveAttribute('href', new RegExp(`${attemptId}$`));
  expect(
    (await readAttempts(created.guest.sessionId)).map((row) => row.id),
  ).toEqual([attemptId]);
  await link.click();
  await page.waitForURL(HOEREN_URL);
  expect(attemptIdOf(page)).toBe(attemptId);
  await context.close();
});

test('locale and choice browsing never start or replace guest implicitly', async ({
  browser,
}) => {
  const created = await newGuest(depsNow());
  const sessionId = created.guest.sessionId;
  const firstContext = await contextOf(browser, created.token);
  const tabA = await firstContext.newPage();
  const tabB = await firstContext.newPage();
  await tabA.goto(`/practice/${FULL_EXAM.slug}`);
  await tabA.getByTestId('mode-option-exam').click();
  await readyExamAudio(tabA);
  const audioA = tabA.getByTestId('exam-audio-element');
  await audioA.evaluate((element: HTMLAudioElement) => {
    element.dataset.marker = 'prepared';
  });

  // Another guest prepares its own recording at the same time.
  const other = await enter(browser, DESKTOP);
  const otherSession = await sessionOf(other.context);
  await other.page.getByTestId('mode-option-exam').click();
  await readyExamAudio(other.page);
  await other.page
    .getByTestId('exam-audio-element')
    .evaluate((element: HTMLAudioElement) => {
      element.dataset.marker = 'other';
    });

  // The second tab browses: language changes, reloads, prefetch, the legacy
  // addresses. Nothing starts, the guest stays the same.
  await tabB.goto(`/practice/${FULL_EXAM.slug}`);
  await expect(tabB.getByTestId('mode-selection')).toBeVisible();
  await switchTo(tabB, 'ru');
  await tabB.reload();
  await tabB.request.get(`/practice/${FULL_EXAM.slug}`, {
    headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
  });
  await tabB.request.get('/practice');
  await switchTo(tabB, 'en');
  await tabB.reload();
  await switchTo(tabB, 'ru');
  const session = await sessionOf(firstContext);
  expect(session.id).toBe(sessionId);
  expect(session.locale).toBe('ru');
  expect((await guestCookieOf(firstContext))?.value).toBe(created.token);
  expect(await readAttempts(sessionId)).toEqual([]);
  expect(await readAttempts(otherSession.id)).toEqual([]);
  expect((await sessionOf(other.context)).locale).toBe('en');

  // The prepared recording of the first tab and of the other guest stay.
  await readyExamAudio(tabA);
  await expect(audioA).toHaveAttribute('data-marker', 'prepared');
  await expect(tabA.getByTestId('exam-audio-element')).toHaveCount(1);
  await readyExamAudio(other.page);
  await expect(other.page.getByTestId('exam-audio-element')).toHaveAttribute(
    'data-marker',
    'other',
  );
  expect((await sessionOf(other.context)).id).toBe(otherSession.id);

  // The same tab switches the language: the element and the choice remain.
  await switchTo(tabA, 'en');
  await expect(radioOf(tabA, 'mode-option-exam')).toBeChecked();
  await readyExamAudio(tabA);
  await expect(audioA).toHaveAttribute('data-marker', 'prepared');
  expect(await readAttempts(sessionId)).toEqual([]);
  await firstContext.close();
  await other.context.close();
});

test('busy guest entry notice is readable without creating session', async ({
  browser,
}) => {
  // Without a cookie the page is English; the global window is not touched,
  // the page is only opened.
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await page.goto('/?busy=1');
  const notice = page.getByTestId('home-busy');
  await expect(notice).toHaveText(HOME.busy);
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('guest-continue')).toBeEnabled();
  await expect(page.getByRole('main').getByRole('link')).toHaveCount(0);
  await expectUsableLayout(page, 'busy 390');
  expect(await guestCookieOf(context)).toBeUndefined();
  await context.close();

  // A guest whose language is Russian reads the notice in Russian, with the
  // same single action and no new session behind it.
  const { context: ruContext, page: ruPage } = await enter(browser, PHONE);
  await switchTo(ruPage, 'ru');
  const before = await sessionOf(ruContext);
  await ruPage.goto('/?busy=1');
  await expect(ruPage.getByTestId('home-busy')).toBeVisible();
  await expect(ruPage.getByTestId('home-busy')).not.toHaveText(HOME.busy);
  await expect(ruPage.getByRole('main').getByRole('button')).toHaveCount(1);
  expect((await sessionOf(ruContext)).id).toBe(before.id);
  await expectUsableLayout(ruPage, 'busy ru 390');
  await ruContext.close();
});
