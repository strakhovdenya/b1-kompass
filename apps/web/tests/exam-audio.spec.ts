import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
} from '@playwright/test';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import { saveProgress } from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { hashGuestToken } from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readResults,
  serviceDb,
  startFor,
} from './support/db';
import {
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  ensureConfirmedTestProfile,
  fullKeyOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  ANSWER_URL,
  HOEREN_URL,
  attemptIdOf,
  attemptUrl,
  card,
  enterAndStart,
  expectStatus,
  goToHoeren,
  goToLesen,
  optionIn,
  playFrom,
  snapshotOf,
  waitForPlayer,
} from './support/guest-browser';
import {
  examRunTimes,
  installM2Fixtures,
  psql,
  quote,
  runPhaseAt,
  secondsAgoSql,
  sqlRunnerAs,
  startExamAt,
} from './support/sql';

// The recording of a full exam, a free training and a timed block (#46):
// where it plays after a reload or a renewed signed address, who may ask for
// a new address, and what keeps running when sound, network or another guest
// fails. The signed address is made to fail through the media request of the
// browser (page.route on the Storage URL); the audio route of the app, which
// decides by the phase, always answers for real. Times are measured with
// performance.now() against currentTime, never with the device clock.

const FULL_ORIGIN = 'http://localhost:3102';
const SECOND_MS = 1000;
const owner = sqlRunnerAs('owner');

// A full exam restores within this many seconds of the server's timeline
// (INV-6); CI event scheduling adds jitter to the audio clock.
const FULL_POSITION_TOLERANCE_SECONDS = 2;
// A free place is restored exactly, apart from the rounding of its stored
// tenth of a second (the tolerance of learning-ux).
const SAVED_POSITION_TOLERANCE_SECONDS = 0.5;
// A playing element advances with the browser clock: the same tolerance as
// the full restoration, for the same scheduling reason.
const PLAYING_DRIFT_SECONDS = 1;

const H = FULL_TIMING.hoerenSeconds;
const H_MS = H * SECOND_MS;
const ALL_IDS = FULL_PILOT.content.questions.map((question) => question.id);

// A Hören that ends within seconds, for tests that watch it close.
const SHORT_HOEREN: TimingSettings = {
  recordingSeconds: 60,
  hoerenSeconds: 30,
  transitionSeconds: 30,
  lesenSeconds: 60,
};

// Tracing off for the whole file: see the autoplay test below.
test.use({ trace: 'off' });

const MEDIA_URL = '**/storage/v1/object/sign/**';

test.beforeAll(() => {
  installM2Fixtures();
});

interface Exam {
  slug: string;
  examId: string;
  versionId: string;
}

const publishExam = async (
  settings: TimingSettings = FULL_TIMING,
  tone = 613,
): Promise<Exam> => {
  const slug = `test-audio-${randomUUID().slice(0, 8)}`;
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: 'Audio recovery test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(tone) }],
  });
  ensureConfirmedTestProfile(owner, outcome.versionId, settings);
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error('exam is missing');
  return { slug, examId: latest.examId, versionId: latest.versionId };
};

const sessionOf = (created: CreatedGuest): string => created.guest.sessionId;

// A full exam whose Hören began the given seconds ago by the database clock.
const examAgo = (created: CreatedGuest, exam: Exam, seconds: number) => {
  const attemptId = startExamAt(
    sessionOf(created),
    exam,
    ALL_IDS,
    secondsAgoSql(seconds),
  );
  const startMs = Date.parse(examRunTimes(attemptId).acceptedAt);
  return { attemptId, startMs };
};

const contextWith = async (
  browser: Pick<Browser, 'newContext'>,
  token: string,
): Promise<BrowserContext> => {
  const context = await browser.newContext({
    baseURL: FULL_ORIGIN,
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

const examAudio = (page: Page) => page.getByTestId('exam-audio-element');

const requestsTo = (page: Page, path: string): Request[] => {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path) seen.push(request);
  });
  return seen;
};

interface Media {
  paused: boolean;
  currentTime: number;
  nowSeconds: number;
  marker: string | null;
  loads: number;
  src: string;
}

const mediaOf = (page: Page): Promise<Media> =>
  examAudio(page).evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    currentTime: element.currentTime,
    nowSeconds: performance.now() / 1000,
    marker: element.dataset.marker ?? null,
    loads: Number(element.dataset.loads ?? 0),
    src: element.currentSrc,
  }));

// Marks the one element and counts every load of it, to tell it from a copy
// and a renewal from a mere replay.
const markExamAudio = (page: Page, marker = 'owner') =>
  examAudio(page).evaluate((element: HTMLAudioElement, mark: string) => {
    element.dataset.marker = mark;
    element.dataset.loads = '0';
    element.addEventListener('loadstart', () => {
      element.dataset.loads = String(Number(element.dataset.loads) + 1);
    });
  }, marker);

const timerDeadline = async (page: Page): Promise<number> =>
  Number(
    await page.getByTestId('attempt-timer').getAttribute('data-deadline-ms'),
  );

const serverSecondsSince = (startMs: number): number =>
  (Date.now() - startMs) / SECOND_MS;

// Waits for a ready recording and presses Play when the browser asks for it.
const ensurePlaying = async (page: Page) => {
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await expect
    .poll(
      async () => {
        const unlock = page.getByTestId('audio-unlock');
        if (await unlock.isVisible()) await unlock.click();
        return (await mediaOf(page)).paused;
      },
      { timeout: 15_000 },
    )
    .toBe(false);
};

type MediaFault = '403' | 'abort' | 'garbage';

// The media request of the browser fails until the page has asked the app
// for a new address `posts` times (the first ask is the initial one).
const failMediaUntilPosts = async (
  page: Page,
  asks: Request[],
  posts: number,
  fault: MediaFault,
): Promise<string[]> => {
  const urls: string[] = [];
  await page.route(MEDIA_URL, async (route) => {
    urls.push(route.request().url());
    if (asks.length >= posts) {
      await route.continue();
      return;
    }
    if (fault === '403') {
      await route.fulfill({ status: 403, body: 'expired' });
      return;
    }
    if (fault === 'abort') {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      body: 'this is not audio',
    });
  });
  return urls;
};

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

// A real request to the app, as the browser sends it: the cookie of the
// context and the origin the server trusts.
const postJson = async (
  api: APIRequestContext,
  path: string,
  data: unknown,
): Promise<Reply> => {
  const response = await api.post(path, {
    data,
    headers: { Origin: FULL_ORIGIN },
  });
  return {
    status: response.status(),
    body: (await response.json()) as Record<string, unknown>,
  };
};

const audioPath = (attemptId: string): string =>
  `/api/attempts/${attemptId}/audio`;

const askAudio = (api: APIRequestContext, attemptId: string) =>
  postJson(api, audioPath(attemptId), { trackId: FULL_TRACK_ID });

const expectStatusNot = async (cardLocator: Locator, status: string) => {
  await expect(cardLocator.getByTestId('save-status')).not.toHaveAttribute(
    'data-status',
    status,
  );
};

const heldRoute = async (page: Page, url: string) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    await held;
    await route.continue();
  });
  return release;
};

test('refresh and signed url renewal restore mode specific position', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam();

  // Full exam: the first signed address is refused by the media request, a
  // new one comes from the app, and the recording sits on the server's
  // timeline both after that and after a reload.
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 12);
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();
  const asks = requestsTo(page, audioPath(attemptId));
  const media = await failMediaUntilPosts(page, asks, 2, '403');
  await page.goto(attemptUrl(exam.slug, attemptId));
  await ensurePlaying(page);
  expect(asks.length).toBeGreaterThanOrEqual(2);
  expect(media.length).toBeGreaterThanOrEqual(2);
  const deadline = await timerDeadline(page);
  expect(deadline).toBe(startMs + H_MS);
  await expect
    .poll(async () =>
      Math.abs((await mediaOf(page)).currentTime - serverSecondsSince(startMs)),
    )
    .toBeLessThan(FULL_POSITION_TOLERANCE_SECONDS);

  await page.reload();
  await ensurePlaying(page);
  await expect
    .poll(async () =>
      Math.abs((await mediaOf(page)).currentTime - serverSecondsSince(startMs)),
    )
    .toBeLessThan(FULL_POSITION_TOLERANCE_SECONDS);
  expect(await timerDeadline(page)).toBe(deadline);
  await context.close();

  // Training and a timed block restore the guest's own place.
  for (const mode of ['training', 'timed-block'] as const) {
    const guest = await newGuest(depsNow());
    const started = await startFor(depsNow(), guest.token, exam.slug, {
      mode,
      selection: 'hoeren',
    });
    if (!started.ok) throw new Error(`${mode} start: ${started.failure}`);
    const { attemptId: id } = started.result;
    const place = 23;
    const saved = await saveProgress(depsNow(), guest.token, {
      attemptId: id,
      progress: {
        block: 'hoeren',
        positionSeconds: place,
        hoeren: { itemId: 'hoeren-1' },
      },
    });
    if (!saved.ok) throw new Error(`${mode} progress: ${saved.error}`);
    const ownContext = await contextWith(browser, guest.token);
    const ownPage = await ownContext.newPage();
    const ownAsks = requestsTo(ownPage, audioPath(id));
    // A refused address for the free training, a dropped connection for the
    // timed block.
    const fault = mode === 'training' ? '403' : 'abort';
    const ownMedia = await failMediaUntilPosts(ownPage, ownAsks, 2, fault);
    await ownPage.goto(attemptUrl(exam.slug, id));
    await waitForPlayer(ownPage);
    expect(ownAsks.length, mode).toBeGreaterThanOrEqual(2);
    expect(ownMedia.length, mode).toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () =>
        Math.abs((await snapshotOf(ownPage)).currentTime - place),
      )
      .toBeLessThan(SAVED_POSITION_TOLERANCE_SECONDS);
    expect((await snapshotOf(ownPage)).paused).toBe(true);

    // A refresh restores the same place; a timed block keeps its deadline.
    const ownDeadline =
      mode === 'timed-block' ? await timerDeadline(ownPage) : null;
    await ownPage.reload();
    await waitForPlayer(ownPage);
    await expect
      .poll(async () =>
        Math.abs((await snapshotOf(ownPage)).currentTime - place),
      )
      .toBeLessThan(SAVED_POSITION_TOLERANCE_SECONDS);
    if (ownDeadline !== null) {
      expect(await timerDeadline(ownPage)).toBe(ownDeadline);
    }
    await ownContext.close();
  }
});

test('audio requests bypass held save and navigation preserves media', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 10);
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();
  const asks = requestsTo(page, audioPath(attemptId));
  const media = await failMediaUntilPosts(page, asks, 2, '403');
  const releaseSave = await heldRoute(page, ANSWER_URL);
  await page.goto(attemptUrl(exam.slug, attemptId));

  // The choice is made and its save is held at the network.
  const target = card(page, 'hoeren-1');
  await optionIn(target, fullKeyOf('hoeren-1')).check();
  await expectStatus(target, 'saving');

  // The signed address is refused and renewed, the recording plays and
  // reports its state, while the save is still waiting.
  await ensurePlaying(page);
  expect(asks.length).toBeGreaterThanOrEqual(2);
  expect(media.length).toBeGreaterThanOrEqual(2);
  await expectStatus(target, 'saving');
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );

  // Language and question navigation keep the one element, its place and
  // its playback; the pending choice is not shown as saved.
  await markExamAudio(page);
  const before = await mediaOf(page);
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByTestId('locale-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(examAudio(page)).toHaveCount(1);
  const after = await mediaOf(page);
  expect(after.marker).toBe('owner');
  expect(after.loads).toBe(0);
  expect(after.src).toBe(before.src);
  expect(after.paused).toBe(false);
  const elapsed = after.nowSeconds - before.nowSeconds;
  expect(
    Math.abs(after.currentTime - (before.currentTime + elapsed)),
  ).toBeLessThan(PLAYING_DRIFT_SECONDS);
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  expect(await timerDeadline(page)).toBe(startMs + H_MS);
  await expectStatus(card(page, 'hoeren-1'), 'saving');

  // Question navigation waits for the save; once it is confirmed, moving
  // between questions leaves the same element playing.
  releaseSave();
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  await page.getByTestId('go-to-question-2').click();
  await page.getByTestId('go-to-question-1').click();
  await expect(examAudio(page)).toHaveCount(1);
  const moved = await mediaOf(page);
  expect(moved.marker).toBe('owner');
  expect(moved.loads).toBe(0);
  expect(moved.paused).toBe(false);
  await context.close();
});

// The refusal of the autoplay test must come from Chromium itself. The test runner's tracing runs
// scripts in the page with a user gesture of their own right after it loads,
// which makes the browser allow the sound; with tracing off nothing but the
// app touches the page until the sound is tried, and Chromium refuses it.
test('observed autoplay rejection recovers explicitly without timer pause', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam(SHORT_HOEREN, 617);
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 1);
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();
  const asks = requestsTo(page, audioPath(attemptId));

  // Observation only: the native play() runs unchanged, its result is
  // returned as it is, and the name of every refusal the browser gives is
  // written down.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { playRejections: seen });
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play(
      this: HTMLMediaElement,
    ): Promise<void> {
      const result = original.call(this);
      result.catch((error: unknown) => {
        seen.push(error instanceof Error ? error.name : String(error));
      });
      return result;
    };
  });
  const rejections = () =>
    page.evaluate(
      () => (window as unknown as { playRejections: string[] }).playRejections,
    );

  // The first signed address is refused by the media request; the page
  // gets a new one and tries to continue the recording on it. Nobody has
  // clicked anything, so Chromium refuses the sound.
  await failMediaUntilPosts(page, asks, 2, '403');
  await page.goto(attemptUrl(exam.slug, attemptId));
  await page.waitForTimeout(5000);
  expect(asks.length).toBeGreaterThanOrEqual(2);
  expect(await rejections()).toContain('NotAllowedError');
  const player = page.getByTestId('audio-player');
  await expect(player).toHaveAttribute('data-blocked', 'true');
  await expect(page.getByTestId('audio-blocked')).toBeVisible();
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  expect((await mediaOf(page)).paused).toBe(true);

  // The timer ran through it all and the deadline is the server's.
  const deadline = await timerDeadline(page);
  expect(deadline).toBe(startMs + SHORT_HOEREN.hoerenSeconds * SECOND_MS);
  const remaining = async () =>
    Number(
      await page.getByTestId('attempt-timer').getAttribute('data-remaining-ms'),
    );
  const first = await remaining();
  await expect.poll(remaining).toBeLessThan(first - 900);

  // The explicit Play starts the sound at the server's position.
  await page.getByTestId('audio-unlock').click();
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);
  await expect(player).toHaveAttribute('data-blocked', 'false');
  await expect(page.getByTestId('audio-unlock')).toHaveCount(0);
  expect(
    Math.abs((await mediaOf(page)).currentTime - serverSecondsSince(startMs)),
  ).toBeLessThan(FULL_POSITION_TOLERANCE_SECONDS);
  expect(await timerDeadline(page)).toBe(deadline);

  // When the server closes Hören the sound stops, whatever the address.
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-phase',
    'transition',
    { timeout: 40_000 },
  );
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(true);
  await expect(page.getByTestId('audio-unlock')).toHaveCount(0);
  await context.close();
});

test('one full audio owner survives routes locale and allowed renewal', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();

  await page.goto(`/practice/${exam.slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await page.getByTestId('mode-option-exam').click();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await markExamAudio(page);
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  const attemptId = attemptIdOf(page);
  const startMs = Date.parse(examRunTimes(attemptId).acceptedAt);
  const asks = requestsTo(page, audioPath(attemptId));
  await expect(examAudio(page)).toHaveCount(1);
  await expect(page.getByTestId('audio-element')).toHaveCount(0);
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);
  const deadline = await timerDeadline(page);
  expect(deadline).toBe(startMs + H_MS);

  // Language switches keep the same element and its playback.
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByTestId('locale-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(examAudio(page)).toHaveCount(1);
  let current = await mediaOf(page);
  expect(current.marker).toBe('owner');
  expect(current.loads).toBe(0);
  expect(current.paused).toBe(false);

  // A renewal at the permitted stage: the read of the address fails, the app
  // issues a new one on its own request, the same element loads it and
  // continues at the server's position. The deadline is not touched.
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    element.dispatchEvent(new Event('error'));
  });
  await expect.poll(() => asks.length).toBe(1);
  await expect.poll(async () => (await mediaOf(page)).loads).toBe(1);
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);
  current = await mediaOf(page);
  expect(current.marker).toBe('owner');
  await expect(examAudio(page)).toHaveCount(1);
  expect(
    Math.abs(current.currentTime - serverSecondsSince(startMs)),
  ).toBeLessThan(FULL_POSITION_TOLERANCE_SECONDS);
  expect(await timerDeadline(page)).toBe(deadline);
  const renewed = await asks[0]?.response();
  const body = (await renewed?.json()) as {
    audio: { expiresAt: string; serverNow: string };
  };
  // The renewed address does not outlive its permitted time by more than
  // the margin: it was not issued for a longer exam.
  const lifeSeconds =
    (Date.parse(body.audio.expiresAt) - Date.parse(body.audio.serverNow)) /
    SECOND_MS;
  expect(lifeSeconds).toBeLessThanOrEqual(H + 300);
  expect(lifeSeconds).toBeGreaterThan(H - serverSecondsSince(startMs) - 5);
  await context.close();

  // The free training keeps its pause on Lesen and does not autoplay back.
  const freeContext = await browser.newContext();
  const freePage = await freeContext.newPage();
  await enterAndStart(freePage);
  await waitForPlayer(freePage);
  await playFrom(freePage, 7, 'free');
  await goToLesen(freePage);
  const paused = await snapshotOf(freePage);
  expect(paused.paused).toBe(true);
  expect(paused.isConnected).toBe(true);
  expect(paused.marker).toBe('free');
  await goToHoeren(freePage);
  const back = await snapshotOf(freePage);
  expect(back.paused).toBe(true);
  expect(Math.abs(back.currentTime - paused.currentTime)).toBeLessThan(0.1);
  await freeContext.close();
});

test('switching exams stops prior audio owner', async ({ browser }) => {
  test.setTimeout(120_000);
  const examA = await publishExam(FULL_TIMING, 613);
  const examB = await publishExam(FULL_TIMING, 440);
  const created = await newGuest(depsNow());
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();

  // A starts and its recording plays; the context line names the exam.
  await page.goto(`/practice/${examA.slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await page.getByTestId('mode-option-exam').click();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  await expect(page.getByTestId('exam-context-where')).toHaveText(
    'Exam · Hören',
  );
  await expect(examAudio(page)).toHaveCount(1);
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);

  // The element of A is kept in the page: a stopped owner must stay silent
  // even when nothing in the document points to it any more.
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    Object.assign(window, { ownerA: element });
  });
  const stateOfA = () =>
    page.evaluate(() => {
      const owner = (window as unknown as { ownerA: HTMLAudioElement }).ownerA;
      return {
        paused: owner.paused,
        hasSource: owner.hasAttribute('src'),
        isConnected: owner.isConnected,
      };
    });
  expect((await stateOfA()).paused).toBe(false);

  // The way back to the library is client navigation without a new document.
  await page.getByTestId('exam-context-library').click();
  await page.waitForURL('**/exams');
  await expect(page.getByTestId('exam-library')).toBeVisible();
  await expect(page.locator('audio')).toHaveCount(0);
  await expect.poll(async () => (await stateOfA()).paused).toBe(true);
  expect(await stateOfA()).toMatchObject({
    hasSource: false,
    isConnected: false,
  });

  // B opens with an owner of its own; A is still silent.
  await page
    .getByTestId(`exam-card-${examB.slug}`)
    .getByTestId('exam-card-open')
    .click();
  await page.waitForURL(`**/practice/${examB.slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await page.getByTestId('mode-option-exam').click();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await expect(examAudio(page)).toHaveCount(1);
  await expect(page.locator('audio')).toHaveCount(1);
  const isSameElement = await examAudio(page).evaluate(
    (element: HTMLAudioElement) =>
      element === (window as unknown as { ownerA: HTMLAudioElement }).ownerA,
  );
  expect(isSameElement).toBe(false);
  expect((await mediaOf(page)).paused).toBe(true);
  expect((await stateOfA()).paused).toBe(true);
  await context.close();
});

test('closed foreign and expired requests cannot renew audio', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam(SHORT_HOEREN, 619);

  // Closed: Hören is over, the attempt is in its transition.
  const closed = await newGuest(depsNow());
  const closedRun = examAgo(closed, exam, SHORT_HOEREN.hoerenSeconds + 5);
  const closedContext = await contextWith(browser, closed.token);
  const closedAsk = await askAudio(closedContext.request, closedRun.attemptId);
  expect(closedAsk.body).toEqual({ ok: false, error: 'phase-closed' });
  const closedPrepare = await postJson(
    closedContext.request,
    '/api/attempts/prepare-audio',
    { examSlug: exam.slug, expectedVersionId: exam.versionId },
  );
  expect(closedPrepare.body.ok).toBe(false);
  expect(closedPrepare.body.audio).toBeUndefined();
  await closedContext.close();

  // Foreign: an open attempt of another guest.
  const mine = await newGuest(depsNow());
  const openRun = examAgo(mine, exam, 3);
  const mineContext = await contextWith(browser, mine.token);
  const ownAsk = await askAudio(mineContext.request, openRun.attemptId);
  expect(ownAsk.body.ok).toBe(true);
  const stranger = await newGuest(depsNow());
  const strangerContext = await contextWith(browser, stranger.token);
  const foreign = await askAudio(strangerContext.request, openRun.attemptId);
  expect(foreign.body).toEqual({ ok: false, error: 'not-found' });
  const noCookie = await browser.newContext({ baseURL: FULL_ORIGIN });
  const anonymous = await askAudio(noCookie.request, openRun.attemptId);
  expect(anonymous.body).toEqual({ ok: false, error: 'session-invalid' });
  await mineContext.close();
  await strangerContext.close();
  await noCookie.close();

  // Expired: the fixed term of the guest ends while the attempt exists.
  const token = randomBytes(32).toString('base64url');
  psql(`select m2_test.insert_guest_ending_in(
    ${quote(hashGuestToken(token))}, 8)`);
  const started = await startFor(depsNow(), token, exam.slug, {
    mode: 'training',
    selection: 'hoeren',
  });
  if (!started.ok) throw new Error(`short guest start: ${started.failure}`);
  const shortContext = await contextWith(browser, token);
  const alive = await askAudio(shortContext.request, started.result.attemptId);
  expect(alive.body.ok).toBe(true);
  await expect
    .poll(
      async () =>
        (await askAudio(shortContext.request, started.result.attemptId)).body,
      { timeout: 20_000 },
    )
    .toEqual({ ok: false, error: 'session-invalid' });
  const expiredPrepare = await postJson(
    shortContext.request,
    '/api/attempts/prepare-audio',
    { examSlug: exam.slug, expectedVersionId: exam.versionId },
  );
  expect(expiredPrepare.body).toEqual({ ok: false, error: 'session-invalid' });
  await shortContext.close();
});

test('other guest actions cannot reset playing or paused media', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam();

  // A full exam plays for the first guest; the second guest answers,
  // switches language and submits, and an old tab of the first guest
  // changes language too.
  const first = await newGuest(depsNow());
  const firstRun = examAgo(first, exam, 8);
  const second = await newGuest(depsNow());
  const secondRun = examAgo(second, exam, 8);
  const firstContext = await contextWith(browser, first.token);
  const secondContext = await contextWith(browser, second.token);
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  await firstPage.goto(attemptUrl(exam.slug, firstRun.attemptId));
  await secondPage.goto(attemptUrl(exam.slug, secondRun.attemptId));
  await ensurePlaying(firstPage);
  await ensurePlaying(secondPage);
  await markExamAudio(firstPage);
  const before = await mediaOf(firstPage);

  const oldTab = await firstContext.newPage();
  await oldTab.goto(firstPage.url());
  await oldTab.getByTestId('locale-ru').click();
  await expect(oldTab.locator('html')).toHaveAttribute('lang', 'ru');

  const target = card(secondPage, 'hoeren-1');
  await optionIn(target, fullKeyOf('hoeren-1')).check();
  await expectStatus(target, 'saved');
  await secondPage.getByTestId('locale-ru').click();
  await expect(secondPage.locator('html')).toHaveAttribute('lang', 'ru');
  await secondPage.getByTestId('finish-attempt').click();
  await secondPage.getByTestId('finish-confirm').click();
  await expect(secondPage.getByTestId('attempt-review')).toBeVisible({
    timeout: 20_000,
  });

  const after = await mediaOf(firstPage);
  expect(after.marker).toBe('owner');
  expect(after.paused).toBe(false);
  expect(after.loads).toBe(0);
  expect(after.src).toBe(before.src);
  const elapsed = after.nowSeconds - before.nowSeconds;
  expect(
    Math.abs(after.currentTime - (before.currentTime + elapsed)),
  ).toBeLessThan(PLAYING_DRIFT_SECONDS);
  await firstContext.close();
  await secondContext.close();

  // A paused free recording keeps its place while another guest cancels.
  const pausedGuest = await browser.newContext();
  const pausedPage = await pausedGuest.newPage();
  await enterAndStart(pausedPage);
  await waitForPlayer(pausedPage);
  await playFrom(pausedPage, 9, 'paused-owner');
  await pausedPage.getByTestId('audio-toggle').click();
  await expect
    .poll(async () => (await snapshotOf(pausedPage)).paused)
    .toBe(true);
  const kept = await snapshotOf(pausedPage);

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await enterAndStart(otherPage);
  await waitForPlayer(otherPage);
  await playFrom(otherPage, 4, 'other');
  await otherPage.getByTestId('locale-ru').click();
  await expect(otherPage.locator('html')).toHaveAttribute('lang', 'ru');
  await otherPage.getByTestId('cancel-attempt').click();
  await otherPage.getByTestId('cancel-confirm').click();

  const stayed = await snapshotOf(pausedPage);
  expect(stayed.marker).toBe('paused-owner');
  expect(stayed.paused).toBe(true);
  expect(Math.abs(stayed.currentTime - kept.currentTime)).toBeLessThan(0.1);
  await pausedGuest.close();
  await other.close();
});

test('network and decoding failures do not pause time or fake saved', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 10);
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();
  const asks = requestsTo(page, audioPath(attemptId));
  await page.goto(attemptUrl(exam.slug, attemptId));
  await ensurePlaying(page);
  await markExamAudio(page);
  const deadline = await timerDeadline(page);
  expect(deadline).toBe(startMs + H_MS);

  // Offline: the choice cannot be saved, the failed read of the recording
  // cannot get a new address, and the exam time still runs.
  await context.setOffline(true);
  const target = card(page, 'hoeren-1');
  await optionIn(target, fullKeyOf('hoeren-1')).check();
  await expect
    .poll(async () =>
      target.getByTestId('save-status').getAttribute('data-status'),
    )
    .toBe('error');
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    element.dispatchEvent(new Event('error'));
  });
  const remaining = async () =>
    Number(
      await page.getByTestId('attempt-timer').getAttribute('data-remaining-ms'),
    );
  const first = await remaining();
  await expect.poll(remaining).toBeLessThan(first - 1500);
  expect(await timerDeadline(page)).toBe(deadline);
  await expectStatusNot(target, 'saved');
  expect((await readResults(attemptId)).length).toBe(0);

  // Back online the recording gets its address and continues at the
  // server's position; the answer is saved only after the server says so.
  await context.setOffline(false);
  // After three lost requests the recording asks the guest to load it again.
  const reload = page.getByTestId('audio-retry');
  await expect
    .poll(async () => {
      if (await reload.isVisible()) await reload.click();
      return page.getByTestId('audio-status').getAttribute('data-status');
    })
    .toBe('ready');
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);
  expect(
    Math.abs((await mediaOf(page)).currentTime - serverSecondsSince(startMs)),
  ).toBeLessThan(FULL_POSITION_TOLERANCE_SECONDS);
  expect((await mediaOf(page)).marker).toBe('owner');
  expect(asks.length).toBeGreaterThanOrEqual(1);
  expect(await timerDeadline(page)).toBe(deadline);
  await context.close();

  // Decoding: the address answers with bytes that are not audio; a new
  // address is asked for, the deadline stays, nothing becomes saved.
  const decoding = await newGuest(depsNow());
  const run = examAgo(decoding, exam, 10);
  const decodingContext = await contextWith(browser, decoding.token);
  const decodingPage = await decodingContext.newPage();
  const decodingAsks = requestsTo(decodingPage, audioPath(run.attemptId));
  await failMediaUntilPosts(decodingPage, decodingAsks, 2, 'garbage');
  await decodingPage.goto(attemptUrl(exam.slug, run.attemptId));
  await ensurePlaying(decodingPage);
  expect(decodingAsks.length).toBeGreaterThanOrEqual(2);
  expect(await timerDeadline(decodingPage)).toBe(run.startMs + H_MS);
  const choice = card(decodingPage, 'hoeren-1');
  await expectStatus(choice, 'idle');
  await decodingContext.close();
});

test('closed full phase refuses renewal and hidden playback', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const exam = await publishExam(SHORT_HOEREN, 623);
  const created = await newGuest(depsNow());
  const { attemptId } = examAgo(created, exam, 6);
  const context = await contextWith(browser, created.token);
  const page = await context.newPage();
  const asks = requestsTo(page, audioPath(attemptId));
  await page.goto(attemptUrl(exam.slug, attemptId));
  await ensurePlaying(page);
  await markExamAudio(page, 'closing');
  const loadsBefore = asks.length;

  // The server closes Hören: the shell moves on, the owner is inactive.
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-phase',
    'transition',
    { timeout: 30_000 },
  );
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(true);
  await expect(page.getByTestId('audio-player')).toBeHidden();
  await expect(page.getByTestId('audio-unlock')).toHaveCount(0);

  // What a headset or a system key does: play() on the element. The
  // inactive owner pauses it again.
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    void element.play().catch(() => undefined);
  });
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(true);

  // A forced media failure does not make the page ask for a new address.
  await page.route(MEDIA_URL, (route) =>
    route.fulfill({ status: 403, body: 'expired' }),
  );
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    element.dispatchEvent(new Event('error'));
  });
  await page.waitForTimeout(1500);
  expect(asks.length).toBe(loadsBefore);
  expect((await mediaOf(page)).loads).toBe(0);
  expect((await mediaOf(page)).paused).toBe(true);
  await expect(page.getByTestId('attempt-review')).toHaveCount(0);

  // The real routes refuse in this tab and in another one; no result or
  // review exists before the exam is finished.
  const ask = await askAudio(context.request, attemptId);
  expect(ask.body).toEqual({ ok: false, error: 'phase-closed' });
  const second = await context.newPage();
  await second.goto(attemptUrl(exam.slug, attemptId));
  await expect(second.getByTestId('training-shell')).toBeVisible();
  const again = await askAudio(second.request, attemptId);
  expect(again.body).toEqual({ ok: false, error: 'phase-closed' });
  const prepare = await postJson(
    context.request,
    '/api/attempts/prepare-audio',
    {
      examSlug: exam.slug,
      expectedVersionId: exam.versionId,
    },
  );
  expect(prepare.body.ok).toBe(false);
  expect(prepare.body.audio).toBeUndefined();
  await expect(second.getByTestId('attempt-review')).toHaveCount(0);
  expect((await readResults(attemptId)).length).toBe(0);
  await context.close();

  // A page that has not heard of the end yet: the server closes Hören under
  // it, the failed read asks once, the answer is final, and neither a retry
  // nor a second request is offered.
  const late = await newGuest(depsNow());
  const lateRun = examAgo(late, exam, SHORT_HOEREN.hoerenSeconds - 6);
  const lateContext = await contextWith(browser, late.token);
  const latePage = await lateContext.newPage();
  const lateAsks = requestsTo(latePage, audioPath(lateRun.attemptId));
  // The clock of the page stands still, as on a device that was asleep; the
  // server's time goes on.
  await latePage.clock.install();
  await latePage.goto(attemptUrl(exam.slug, lateRun.attemptId));
  await ensurePlaying(latePage);
  await latePage.clock.pauseAt(new Date(Date.now() + 500));
  await expect
    .poll(() => runPhaseAt(lateRun.attemptId, 'clock_timestamp()'), {
      timeout: 20_000,
    })
    .not.toBe('hoeren');
  await examAudio(latePage).evaluate((element: HTMLAudioElement) => {
    element.dispatchEvent(new Event('error'));
  });
  await expect.poll(() => lateAsks.length).toBe(2);
  const refusal = await lateAsks[1]?.response();
  expect(await refusal?.json()).toEqual({ ok: false, error: 'phase-closed' });
  await expect(latePage.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'error',
  );
  await expect(latePage.getByTestId('audio-player')).toBeHidden();
  await expect(
    latePage.getByTestId('audio-status').getByRole('button'),
  ).toHaveCount(0);
  await expect(latePage.getByTestId('audio-unlock')).toHaveCount(0);
  expect((await mediaOf(latePage)).paused).toBe(true);
  await latePage.waitForTimeout(6000);
  expect(lateAsks).toHaveLength(2);
  await lateContext.close();
});
