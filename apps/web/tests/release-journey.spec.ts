import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { selectScoringPolicy } from '@b1k/domain';
import {
  getAttemptReview,
  saveAnswer,
  saveProgress,
  startAttempt,
} from '../src/server/attempts/attempts';
import { resolveAttemptAudio } from '../src/server/audio/audio';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  hashGuestToken,
  resolveGuestSession,
  setGuestLocale,
} from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import type { ExamVersionRef } from './support/db';
import {
  createPublicClient,
  depsAt,
  depsNow,
  latestVersionOf,
  newGuest,
  openStarted,
  readAnswerRows,
  readAnswers,
  readAttempts,
  readEventKinds,
  readOnlyResult,
  readProgress,
  readResults,
  readRunRows,
  readSession,
  readSessionByToken,
  serviceDb,
  startBody,
  startFor,
  submitStored,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  examRunTimes,
  installM2Fixtures,
  psql,
  quote,
  secondsAgoSql,
  startExamAt,
} from './support/sql';
import {
  ANSWER_URL,
  CHOICE_URL,
  HOEREN_URL,
  FULL_ORIGIN,
  LESEN_URL,
  SUBMIT_URL,
  activeAttemptOf,
  attemptLesenUrl,
  attemptIdOf,
  attemptUrl,
  card,
  expectStatus,
  finishFromShell,
  optionIn,
  postCommand,
  seekTo,
  snapshotOf,
  startBrowserGuest,
  waitForPlayer,
  continueThroughLibrary,
  passLibrary,
} from './support/guest-browser';
import {
  NARROW,
  WIDE,
  expectAccessibleScreen,
  expectEnlargedText,
  expectNoFocusTrap,
  expectUsableLayout,
  goToStep,
  openGuestPage,
  tabTo,
} from './support/release';
import type { ViewportSize } from './support/release';

// The release route of a guest on the synthetic full set (20 Hören, 25 Lesen,
// key in FULL_PILOT): the same pages, server actions and database functions
// as for every visitor. Every step is compared with the re-read database.

// From this width the navigator shows its grid; below it, behind a button.
const MD_BREAKPOINT_PX = 900;

const { keys } = FULL_PILOT;
const HOUR_MS = 60 * 60 * 1000;
const GUEST_TERM_HOURS = 720;
const SIGN_URL = '**/storage/v1/object/sign/**';

const keyOf = fullKeyOf;
const wrongOf = fullWrongOf;

interface StoredResult {
  score: number;
  max_score: number;
  level: string | null;
}

const optionIdsOf = (questionId: string): string[] =>
  FULL_PILOT.content.questions
    .find((question) => question.id === questionId)
    ?.options.map((option) => option.id) ?? [];

const onlyResult = (attemptId: string) =>
  readOnlyResult<StoredResult>(attemptId);

const firstRadio = (page: Page, questionId: string) =>
  card(page, questionId).locator('input[type="radio"]').first();

const enterAsGuestByKeyboard = async (page: Page, screen: string) => {
  await page.goto('/');
  await expectUsableLayout(page, `${screen} home`);
  // A new guest starts in English, so the entry has its English name.
  const entry = page.getByRole('button', { name: 'Continue as guest' });
  await tabTo(page, entry, `${screen} home`);
  await page.keyboard.press('Enter');
  // The entry opens the library; the legacy address leads to the choice, and
  // the training starts only by its own button.
  await passLibrary(page);
  await page.waitForURL(CHOICE_URL);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await expectUsableLayout(page, `${screen} choice`);
  await tabTo(page, page.getByTestId('start-attempt'), `${screen} choice`);
  await page.keyboard.press('Enter');
  await page.waitForURL(HOEREN_URL);
  await expect(card(page, 'hoeren-1')).toBeVisible();
};

// Space selects the first option of a group without a choice; the arrows
// move the choice inside the group.
const answerByKeyboard = async (
  page: Page,
  questionId: string,
  optionId: string,
  screen: string,
) => {
  const target = card(page, questionId);
  await tabTo(page, firstRadio(page, questionId), screen);
  await page.keyboard.press('Space');
  await expectStatus(target, 'saved');
  const radios = target.locator('input[type="radio"]');
  const values = await radios.evaluateAll((items) =>
    items.map((item) => (item as HTMLInputElement).value),
  );
  for (let i = 1; i <= values.indexOf(optionId); i++) {
    await page.keyboard.press('ArrowDown');
    await expect(optionIn(target, values[i] ?? '')).toBeChecked();
  }
  await expect(optionIn(target, optionId)).toBeChecked();
  await expectStatus(target, 'saved');
};

const activate = async (
  page: Page,
  testId: string,
  key: 'Enter' | 'Space',
  screen: string,
) => {
  await tabTo(page, page.getByTestId(testId), screen);
  await page.keyboard.press(key);
};

// The whole route by keyboard, with the layout and the focus checked on
// every screen. Hören 1 right, Hören 18 wrong, Lesen 1 right: 2 of 45.
const keyboardJourney = async (page: Page, viewport: ViewportSize) => {
  const screen = `${viewport.width}x${viewport.height}`;
  await enterAsGuestByKeyboard(page, screen);
  await expectEnlargedText(page);
  const attempt = await activeAttemptOf(page.context());

  await expectUsableLayout(page, `${screen} hoeren 1`);
  await answerByKeyboard(page, 'hoeren-1', keyOf('hoeren-1'), screen);
  // A phone keeps the list of tasks closed behind its own button.
  if (viewport.width < MD_BREAKPOINT_PX) {
    await activate(page, 'navigator-toggle', 'Enter', screen);
  }
  await activate(page, 'go-to-question-18', 'Enter', screen);
  await expect(card(page, 'hoeren-18')).toBeVisible();
  await expectUsableLayout(page, `${screen} hoeren 18-20`);
  await answerByKeyboard(page, 'hoeren-18', wrongOf('hoeren-18'), screen);

  await activate(page, 'block-link-lesen', 'Enter', screen);
  await page.waitForURL(LESEN_URL);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expectUsableLayout(page, `${screen} lesen text`);
  if (viewport.width < WIDE.width) {
    await activate(page, 'lesen-view-questions', 'Enter', screen);
  }
  await expect(card(page, 'lesen-1')).toBeVisible();
  await expectUsableLayout(page, `${screen} lesen 1`);
  await answerByKeyboard(page, 'lesen-1', keyOf('lesen-1'), screen);

  expect(await readAnswers(attempt.attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
    'hoeren-18': wrongOf('hoeren-18'),
    'lesen-1': keyOf('lesen-1'),
  });
  expect(await readResults(attempt.attemptId)).toEqual([]);

  await activate(page, 'finish-attempt', 'Enter', screen);
  await expect(page.getByTestId('finish-confirmation')).toBeVisible();
  await expectUsableLayout(page, `${screen} confirmation`);
  await activate(page, 'finish-confirm', 'Enter', screen);
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expectUsableLayout(page, `${screen} review`);

  const row = await onlyResult(attempt.attemptId);
  expect(row).toMatchObject({ score: 2, max_score: 45, level: 'below-A2' });
  await expect(page.getByTestId('result-score')).toContainText('2 of 45');
  await tabTo(page, page.getByTestId('restart-attempt'), `${screen} review`);
};

test('release journey is accessible and responsive', async ({ browser }) => {
  // The whole route by keyboard on several screens: slower than a spec of
  // one screen, more so with traces on two workers.
  test.slow();
  for (const viewport of [NARROW, WIDE]) {
    await test.step(`${viewport.width}x${viewport.height}`, async () => {
      const { context, page } = await openGuestPage(browser, viewport, true);
      await keyboardJourney(page, viewport);
      await context.close();
    });
  }
});

test('release failures never fake saved state', async ({ browser }) => {
  await test.step('audio failure', async () => {
    const context = await browser.newContext({ viewport: WIDE });
    await context.route(SIGN_URL, (route) => route.abort());
    const page = await context.newPage();
    await page.goto('/');
    await continueThroughLibrary(page);
    await page.waitForURL(CHOICE_URL);
    await page.getByTestId('start-attempt').click();
    await page.waitForURL(HOEREN_URL);
    const { attemptId } = await activeAttemptOf(context);
    const status = page.getByTestId('audio-status');
    await expect(status).toHaveAttribute('data-status', 'error');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).not.toHaveText('');
    await expect(page.getByTestId('audio-toggle')).toBeDisabled();

    await optionIn(card(page, 'hoeren-1'), keyOf('hoeren-1')).check();
    await expectStatus(card(page, 'hoeren-1'), 'saved');
    await page.getByTestId('block-link-lesen').click();
    await page.waitForURL(LESEN_URL);
    await optionIn(card(page, 'lesen-1'), wrongOf('lesen-1')).check();
    await expectStatus(card(page, 'lesen-1'), 'saved');
    await expect(status).toHaveAttribute('data-status', 'error');
    expect(await readAnswers(attemptId)).toEqual({
      'hoeren-1': keyOf('hoeren-1'),
      'lesen-1': wrongOf('lesen-1'),
    });

    await context.unroute(SIGN_URL);
    // The recording belongs to Hören: its retry is reached there.
    await page.getByTestId('block-link-hoeren').click();
    await page.waitForURL(HOEREN_URL);
    await tabTo(page, status.getByRole('button'), 'audio retry');
    await page.keyboard.press('Enter');
    await expect(status).toHaveAttribute('data-status', 'ready');
    await expect(page.getByTestId('audio-toggle')).toBeEnabled();
    await context.close();
  });

  await test.step('save failure', async () => {
    const guest = await startBrowserGuest(browser);
    const { context, page, attemptId } = guest;
    await waitForPlayer(page);
    const isAction = (method: string) => method === 'POST';
    for (const path of [ANSWER_URL]) {
      await context.route(path, (route) =>
        isAction(route.request().method())
          ? route.fulfill({ status: 503, body: 'unavailable' })
          : route.continue(),
      );
    }
    const saved = page.locator(
      '[data-testid="save-status"][data-status="saved"]',
    );

    const hoeren = card(page, 'hoeren-1');
    await optionIn(hoeren, keyOf('hoeren-1')).check();
    await expectStatus(hoeren, 'error');
    await expect(hoeren.getByTestId('save-status')).toHaveAttribute(
      'role',
      'alert',
    );
    await expect(optionIn(hoeren, keyOf('hoeren-1'))).toBeChecked();
    await expect(saved).toHaveCount(0);

    await page.getByTestId('block-link-lesen').click();
    await page.waitForURL(LESEN_URL);
    const lesen = card(page, 'lesen-1');
    await optionIn(lesen, keyOf('lesen-1')).check();
    await expectStatus(lesen, 'error');
    await expect(optionIn(lesen, keyOf('lesen-1'))).toBeChecked();
    await expect(saved).toHaveCount(0);
    expect(await readAnswers(attemptId)).toEqual({});

    // The failed choices belong to the final answers of a submission: the
    // confirmation does not count them as unanswered. Going back sends
    // nothing.
    await page.getByTestId('finish-attempt').click();
    const confirmation = page.getByTestId('finish-confirmation');
    await expect(confirmation).toHaveAttribute('data-unanswered-hoeren', '19');
    await expect(confirmation).toHaveAttribute('data-unanswered-lesen', '24');
    await page.getByTestId('finish-cancel').click();
    await expect(page.getByTestId('attempt-review')).toHaveCount(0);
    expect(await readResults(attemptId)).toEqual([]);
    expect(await readAttempts(guest.sessionId)).toEqual([
      { id: attemptId, status: 'active' },
    ]);

    await context.unroute(ANSWER_URL);
    await tabTo(page, lesen.getByRole('button'), 'lesen retry');
    await page.keyboard.press('Enter');
    await expectStatus(lesen, 'saved');
    await page.getByTestId('block-link-hoeren').click();
    await page.waitForURL(HOEREN_URL);
    await expectStatus(hoeren, 'error');
    await expect(optionIn(hoeren, keyOf('hoeren-1'))).toBeChecked();
    await tabTo(page, hoeren.getByRole('button'), 'hoeren retry');
    await page.keyboard.press('Enter');
    await expectStatus(hoeren, 'saved');
    expect(await readAnswers(attemptId)).toEqual({
      'hoeren-1': keyOf('hoeren-1'),
      'lesen-1': keyOf('lesen-1'),
    });
    await context.close();
  });
});

// A guest made through the real server with an explicitly started attempt
// on the full set.
const serverGuest = async () => {
  const created = await newGuest(depsNow());
  const opened = await openStarted(depsNow(), created, FULL_EXAM.slug);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  return { ...created, practice: opened.practice };
};

const trackOf = async (versionId: string) => {
  const { data, error } = await serviceDb
    .from('exam_version_audio')
    .select('object_path, sha256')
    .eq('exam_version_id', versionId)
    .eq('track_id', FULL_TRACK_ID)
    .single<{ object_path: string; sha256: string }>();
  if (error) throw error;
  return data;
};

const PROGRESS = {
  block: 'lesen',
  positionSeconds: 12,
  hoeren: { itemId: 'hoeren-2' },
  lesen: { itemId: 'lesen-3', textId: 'lesen-text-1', paragraph: 0 },
} as const;

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

test('release guest allowed operations pass access matrix', async () => {
  const start = new Date();
  const { token, guest, practice } = await serverGuest();
  const { attemptId, versionId } = practice;

  await test.step('enter: a session with a fixed term', async () => {
    const stored = await readSession(guest.sessionId);
    expect(stored.locale).toBe('en');
    const termMs =
      Date.parse(stored.expires_at) - Date.parse(stored.created_at);
    expect(termMs).toBe(GUEST_TERM_HOURS * HOUR_MS);
    expect(Date.parse(stored.created_at)).toBeGreaterThanOrEqual(
      start.getTime() - 1000,
    );
    const resolved = await resolveGuestSession(depsNow(), token);
    expect(resolved?.sessionId).toBe(guest.sessionId);
  });

  await test.step('choose the interface language', async () => {
    expect(await setGuestLocale(depsNow(), guest, 'ru')).toBe(true);
    expect((await readSession(guest.sessionId)).locale).toBe('ru');
  });

  await test.step('open the published set without its key', async () => {
    expect(practice.questions).toHaveLength(45);
    expect(JSON.stringify(practice)).not.toMatch(/correct|answer_?keys/i);
    expect(await readAttempts(guest.sessionId)).toEqual([
      { id: attemptId, status: 'active' },
    ]);
  });

  await test.step('save an answer and the place', async () => {
    const saved = await saveAnswer(depsNow(), token, {
      attemptId,
      questionId: 'hoeren-1',
      optionId: keyOf('hoeren-1'),
      revision: 1,
    });
    expect(saved.ok).toBe(true);
    expect(await readAnswers(attemptId)).toEqual({
      'hoeren-1': keyOf('hoeren-1'),
    });
    const progressed = await saveProgress(depsNow(), token, {
      attemptId,
      progress: PROGRESS,
    });
    expect(progressed.ok).toBe(true);
    expect(await readProgress(attemptId)).toEqual(PROGRESS);
  });

  await test.step('play the recording of the own attempt', async () => {
    const access = await resolveAttemptAudio(depsNow(), token, {
      attemptId,
      trackId: FULL_TRACK_ID,
    });
    if (!access.ok) throw new Error(`audio: ${access.error}`);
    expect(Object.keys(access.audio).sort()).toEqual([
      'contentType',
      'expiresAt',
      'url',
    ]);
    const response = await fetch(access.audio.url);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const track = await trackOf(versionId);
    expect(sha256Of(bytes)).toBe(track.sha256);
    expect(sha256Of(bytes)).toBe(sha256Of(createTestRecording().bytes));
  });

  await test.step('finish once and read the own review', async () => {
    const finished = await submitStored(depsNow(), token, { attemptId });
    if (!finished.ok) throw new Error(`finish: ${finished.error}`);
    expect(finished.review).toMatchObject({ score: 1, maxScore: 45 });
    expect(await onlyResult(attemptId)).toMatchObject({
      score: 1,
      max_score: 45,
    });
    const review = await getAttemptReview(depsNow(), token, { attemptId });
    if (!review.ok) throw new Error(`review: ${review.error}`);
    expect(review.review).toEqual(finished.review);
    const solutions = Object.fromEntries(
      review.review.items.map((item) => [
        item.questionId,
        item.correctOptionId,
      ]),
    );
    expect(solutions).toEqual(keys);
  });

  await test.step('start a new run', async () => {
    // After completion a new run is a new explicit start of the exam.
    const started = await startFor(depsNow(), token, FULL_EXAM.slug);
    if (!started.ok) throw new Error(`start: ${started.failure}`);
    expect(started.result.outcome).toBe('accepted');
    const restarted = { attemptId: started.result.attemptId };
    expect(restarted.attemptId).not.toBe(attemptId);
    const attempts = await readAttempts(guest.sessionId);
    expect(attempts).toHaveLength(2);
    expect(attempts).toContainEqual({ id: attemptId, status: 'completed' });
    expect(attempts).toContainEqual({
      id: restarted.attemptId,
      status: 'active',
    });
    expect(await readAnswers(restarted.attemptId)).toEqual({});
    expect(await readResults(restarted.attemptId)).toEqual([]);
    expect(await readResults(attemptId)).toHaveLength(1);
  });
});

const TABLES = [
  'answer_keys',
  'attempt_answers',
  'attempt_commands',
  'attempt_results',
  'attempt_runs',
  'attempts',
  'exam_version_audio',
  'exam_versions',
  'exams',
  'guest_events',
  'guest_sessions',
] as const;

const KEY_LEAKS = [
  'correctOptionId',
  'correct_option_id',
  'review-solution',
  'answer_keys',
];

interface OwnerState {
  answers: Record<string, string>;
  attempts: unknown;
  progress: unknown;
  results: unknown[];
  session: unknown;
}

const ownerState = async (sessionId: string, attemptId: string) =>
  ({
    answers: await readAnswers(attemptId),
    attempts: await readAttempts(sessionId),
    progress: await readProgress(attemptId),
    results: await readResults(attemptId),
    session: await readSession(sessionId),
  }) satisfies OwnerState;

test('release rejects guest privilege and private resource attacks', async ({
  browser,
  baseURL,
}) => {
  const owner = await serverGuest();
  const stranger = await serverGuest();
  const { attemptId, versionId } = owner.practice;
  const sessionId = owner.guest.sessionId;
  const answer = {
    attemptId,
    questionId: 'hoeren-1',
    optionId: wrongOf('hoeren-1'),
    revision: 1,
  };
  expect((await saveAnswer(depsNow(), owner.token, answer)).ok).toBe(true);
  const progressed = await saveProgress(depsNow(), owner.token, {
    attemptId,
    progress: PROGRESS,
  });
  expect(progressed.ok).toBe(true);
  const before = await ownerState(sessionId, attemptId);
  const expectOwnerUnchanged = async () =>
    expect(await ownerState(sessionId, attemptId)).toEqual(before);
  const next = { ...answer, optionId: keyOf('hoeren-1'), revision: 2 };
  const track = { attemptId, trackId: FULL_TRACK_ID };

  await test.step('no key before the attempt is completed', async () => {
    expect(
      await getAttemptReview(depsNow(), owner.token, { attemptId }),
    ).toEqual({ ok: false, error: 'not-completed' });
    // While the attempt is active a new start creates nothing: it names the
    // active attempt as a conflict.
    expect(
      await startFor(depsNow(), owner.token, FULL_EXAM.slug),
    ).toMatchObject({ ok: true, result: { outcome: 'conflict', attemptId } });
    const context = await browser.newContext();
    await context.addCookies([
      { name: GUEST_COOKIE, value: owner.token, url: baseURL },
    ]);
    const page = await context.newPage();
    for (const path of [
      attemptUrl(FULL_EXAM.slug, attemptId),
      attemptLesenUrl(FULL_EXAM.slug, attemptId),
    ]) {
      for (const headers of [{}, { RSC: '1' }] as Record<string, string>[]) {
        const response = await page.request.get(path, { headers });
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(body).toContain(attemptId);
        for (const leak of KEY_LEAKS) expect(body, path).not.toContain(leak);
      }
    }
    await context.close();
    await expectOwnerUnchanged();
  });

  await test.step('no operation without a valid session', async () => {
    const expired = depsAt(owner.guest.expiresAt);
    for (const deps of [depsNow(), expired]) {
      const token = deps === expired ? owner.token : null;
      const refusals = [
        await saveAnswer(deps, token, next),
        await saveProgress(deps, token, { attemptId, progress: PROGRESS }),
        await submitStored(deps, token, { attemptId }),
        await getAttemptReview(deps, token, { attemptId }),
        await resolveAttemptAudio(deps, token, track),
      ];
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ ok: false, error: 'session-invalid' });
      }
      expect(await startFor(deps, token, FULL_EXAM.slug)).toEqual({
        ok: false,
        failure: 'session-invalid',
      });
    }
    await expectOwnerUnchanged();
  });

  await test.step('no operation on a foreign attempt', async () => {
    const { token } = stranger;
    const refusals = [
      await saveAnswer(depsNow(), token, next),
      await saveProgress(depsNow(), token, { attemptId, progress: PROGRESS }),
      await submitStored(depsNow(), token, { attemptId }),
      await getAttemptReview(depsNow(), token, { attemptId }),
    ];
    for (const refusal of refusals) {
      expect(refusal).toEqual({ ok: false, error: 'attempt-not-found' });
    }
    // A start of the stranger only ever names the stranger's own attempt.
    expect(await startFor(depsNow(), token, FULL_EXAM.slug)).toMatchObject({
      ok: true,
      result: { outcome: 'conflict', attemptId: stranger.practice.attemptId },
    });
    expect(await resolveAttemptAudio(depsNow(), token, track)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await readAnswers(stranger.practice.attemptId)).toEqual({});
    await expectOwnerUnchanged();
  });

  await test.step('client role, owner, score and status are refused', async () => {
    const forged = [
      await saveAnswer(depsNow(), owner.token, { ...next, role: 'owner' }),
      await saveAnswer(depsNow(), owner.token, {
        ...next,
        guestSessionId: stranger.guest.sessionId,
      }),
      await saveAnswer(depsNow(), owner.token, { ...next, score: 45 }),
      await submitStored(depsNow(), owner.token, { attemptId, score: 45 }),
      await submitStored(depsNow(), owner.token, { attemptId, level: 'B1' }),
      await submitStored(depsNow(), owner.token, {
        attemptId,
        status: 'completed',
      }),
      await saveProgress(depsNow(), owner.token, {
        attemptId,
        progress: PROGRESS,
        role: 'admin',
      }),
      await getAttemptReview(depsNow(), owner.token, {
        attemptId,
        role: 'owner',
      }),
      await resolveAttemptAudio(depsNow(), owner.token, {
        ...track,
        objectPath: (await trackOf(versionId)).object_path,
      }),
    ];
    for (const refusal of forged) {
      expect(refusal).toMatchObject({ ok: false, error: 'invalid-input' });
    }
    const body = await startBody(FULL_EXAM.slug);
    for (const extra of [
      { scope: 'short-set' },
      { guestSessionId: stranger.guest.sessionId },
      { status: 'completed' },
      { score: 45 },
      { acceptedAt: '2000-01-01T00:00:00Z' },
    ]) {
      expect(
        await startAttempt(depsNow(), owner.token, { ...body, ...extra }),
      ).toEqual({ ok: false, failure: 'invalid-input' });
    }
    await expectOwnerUnchanged();
  });

  const anon = createPublicClient();
  const now = new Date().toISOString();
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is not published');
  const { examId } = latest;
  const forgedHash = hashGuestToken(`forged-${Date.now()}`);
  const forgedSlug = `forged-release-${Date.now().toString(36)}`;

  await test.step('Data API: no table is readable or writable', async () => {
    for (const table of TABLES) {
      const read = await anon.from(table).select('*').limit(1);
      expect(read.error, table).not.toBeNull();
      expect(read.data, table).toBeNull();
    }
    const writes = [
      await anon
        .from('attempt_results')
        .insert({ attempt_id: attemptId, score: 45, max_score: 45 }),
      await anon.from('answer_keys').insert({
        exam_version_id: versionId,
        question_id: 'hoeren-1',
        correct_option_id: 'a',
      }),
      await anon
        .from('attempts')
        .update({ status: 'completed' })
        .eq('id', attemptId),
      await anon
        .from('attempts')
        .update({ guest_session_id: stranger.guest.sessionId })
        .eq('id', attemptId),
      await anon
        .from('guest_sessions')
        .update({ expires_at: '2999-01-01T00:00:00Z' })
        .eq('id', sessionId),
      await anon
        .from('guest_sessions')
        .insert({ token_hash: forgedHash, locale: 'en' }),
      await anon.from('attempt_answers').delete().eq('attempt_id', attemptId),
      await anon
        .from('exam_versions')
        .update({ content: {} })
        .eq('id', versionId),
      await anon
        .from('guest_events')
        .insert({ visitor_id: sessionId, kind: 'entry' }),
    ];
    for (const write of writes) expect(write.error).not.toBeNull();
    await expectOwnerUnchanged();
  });

  await test.step('Data API: no database function is callable', async () => {
    const calls = {
      create_guest_session: {
        p_token_hash: forgedHash,
        p_now: now,
        p_limit: 1000,
      },
      m2_start_attempt: {
        p_session_id: sessionId,
        p_exam_id: examId,
        p_command_id: randomUUID(),
        p_mode: 'training',
        p_purpose: 'normal',
        p_selection: 'all',
        p_source_attempt_id: null,
        p_version_id: versionId,
        p_scope: 'full-exam',
        p_question_ids: FULL_PILOT.content.questions.map((item) => item.id),
      },
      m2_save_answer: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_question_id: 'hoeren-1',
        p_option_id: keyOf('hoeren-1'),
        p_revision: 2,
      },
      m2_save_progress: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_progress: { block: 'hoeren' },
      },
      m2_accept_submission: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_command_id: randomUUID(),
        p_answers: [],
        p_expected_phase_revision: 0,
        p_expected_skipped: 45,
      },
      m2_cancel_attempt: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_command_id: randomUUID(),
        p_expected_phase_revision: 0,
        p_expected_skipped: 45,
      },
      m2_finalize_attempt: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_scope: 'full-exam',
        p_score: 45,
        p_max_score: 45,
        p_correct: 45,
        p_incorrect: 0,
        p_skipped: 0,
        p_percent: 100,
        p_hoeren_score: 20,
        p_hoeren_max: 20,
        p_lesen_score: 25,
        p_lesen_max: 25,
        p_level: 'B1',
      },
      publish_exam_version: {
        p_slug: forgedSlug,
        p_title: 'Forged',
        p_format: 'DTZ',
        p_content: FULL_PILOT.content,
        p_keys: keys,
        p_audio: [],
      },
      purge_expired_empty_guest_sessions: { p_now: '2999-01-01T00:00:00Z' },
    };
    for (const [name, args] of Object.entries(calls)) {
      const { data, error } = await anon.rpc(name, args);
      expect(data, name).toBeNull();
      expect(error?.code, name).toBe('42501');
    }
    // The M1 entry points and the saves and finish with a caller time are
    // gone: neither key finds them any more.
    const removed = {
      save_attempt_answer: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_question_id: 'hoeren-1',
        p_option_id: keyOf('hoeren-1'),
        p_revision: 2,
        p_now: now,
      },
      save_attempt_progress: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_progress: { block: 'hoeren' },
        p_now: now,
      },
      finish_attempt: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_now: now,
        p_scope: 'full-exam',
        p_scored_answers: {},
        p_score: 45,
        p_max_score: 45,
        p_correct: 45,
        p_incorrect: 0,
        p_skipped: 0,
        p_percent: 100,
        p_hoeren_score: 20,
        p_hoeren_max: 20,
        p_lesen_score: 25,
        p_lesen_max: 25,
        p_level: 'B1',
      },
      start_attempt: {
        p_session_id: sessionId,
        p_exam_version_id: versionId,
        p_now: now,
        p_scope: 'full-exam',
      },
      open_attempt: {
        p_session_id: sessionId,
        p_exam_version_id: versionId,
        p_now: now,
        p_scope: 'full-exam',
      },
      restart_attempt: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_exam_version_id: versionId,
        p_now: now,
        p_scope: 'full-exam',
      },
    };
    for (const [name, args] of Object.entries(removed)) {
      const publicCall = await anon.rpc(name, args);
      expect(publicCall.data, name).toBeNull();
      expect(publicCall.error, name).not.toBeNull();
      const serviceCall = await serviceDb.rpc(name, args);
      expect(serviceCall.data, name).toBeNull();
      expect(serviceCall.error?.code, name).toBe('PGRST202');
    }
    const sessions = await serviceDb
      .from('guest_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('token_hash', forgedHash);
    expect(sessions.count).toBe(0);
    const exams = await serviceDb
      .from('exams')
      .select('id', { count: 'exact', head: true })
      .eq('slug', forgedSlug);
    expect(exams.count).toBe(0);
    await expectOwnerUnchanged();
  });

  await test.step('Storage: the private bucket stays closed', async () => {
    const { object_path: objectPath, sha256 } = await trackOf(versionId);
    const bucket = anon.storage.from('exam-sources');
    const download = await bucket.download(objectPath);
    expect(download.data).toBeNull();
    expect(download.error).not.toBeNull();
    const signed = await bucket.createSignedUrl(objectPath, 60);
    expect(signed.data).toBeNull();
    expect(signed.error).not.toBeNull();
    for (const folder of ['', 'audio']) {
      const listing = await bucket.list(folder);
      expect(listing.data ?? []).toEqual([]);
    }
    const publicUrl = bucket.getPublicUrl(objectPath).data.publicUrl;
    const direct = await fetch(publicUrl);
    expect(direct.status).toBeGreaterThanOrEqual(400);
    const upload = await bucket.upload(`audio/forged-${Date.now()}.wav`, 'x');
    expect(upload.error).not.toBeNull();
    const overwrite = await bucket.update(objectPath, 'x');
    expect(overwrite.error).not.toBeNull();
    const removed = await bucket.remove([objectPath]);
    expect(removed.data ?? []).toEqual([]);

    const kept = await serviceDb.storage
      .from('exam-sources')
      .download(objectPath);
    if (kept.error) throw kept.error;
    const bytes = new Uint8Array(await kept.data.arrayBuffer());
    expect(sha256Of(bytes)).toBe(sha256);
  });

  await test.step('no account can be created', async () => {
    const signUp = await anon.auth.signUp({
      email: `release-${Date.now()}@example.org`,
      password: 'correct-horse-battery-staple',
    });
    expect(signUp.error).not.toBeNull();
    expect(signUp.data.user).toBeNull();
    await expectOwnerUnchanged();
  });
});

const outcomeTexts = (page: Page) =>
  page
    .getByTestId('review-item')
    .evaluateAll((items: HTMLElement[]) =>
      items.map((item) => [
        item.dataset.outcome ?? '',
        item.querySelector('[data-testid="review-outcome"]')?.textContent ?? '',
      ]),
    );

// Each kind of state has its own words, so it never depends on colour.
const expectDistinctTexts = (pairs: string[][]) => {
  const byState = new Map<string, Set<string>>();
  for (const [state = '', text = ''] of pairs) {
    expect(text.trim(), state).not.toBe('');
    const texts = byState.get(state) ?? new Set<string>();
    texts.add(text);
    byState.set(state, texts);
  }
  const all = [...byState.values()].map((texts) => [...texts]);
  for (const texts of all) expect(texts).toHaveLength(1);
  expect(new Set(all.flat()).size).toBe(byState.size);
};

test('keyboard reaches and activates every release action', async ({
  browser,
}) => {
  test.slow();
  const { context, page } = await openGuestPage(browser, NARROW, false);
  const screen = 'keyboard';
  await enterAsGuestByKeyboard(page, screen);
  const attempt = await activeAttemptOf(context);

  await activate(page, 'locale-ru', 'Enter', screen);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByTestId('locale-ru')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await activate(page, 'locale-en', 'Space', screen);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect((await readSession(attempt.sessionId)).locale).toBe('en');

  await waitForPlayer(page);
  const toggle = page.getByTestId('audio-toggle');
  const playText = await toggle.innerText();
  await activate(page, 'audio-toggle', 'Space', screen);
  await expect(toggle).toHaveAttribute('data-playing', 'true');
  await expect(toggle).not.toHaveText(playText);
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('data-playing', 'false');
  await expect(toggle).toHaveText(playText);

  await seekTo(page, 20);
  await activate(page, 'audio-back', 'Enter', screen);
  await expect
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeLessThan(16);
  const beforeSeek = (await snapshotOf(page)).currentTime;
  await tabTo(page, page.getByRole('slider'), screen);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeGreaterThan(beforeSeek + 1);

  const idle = await card(page, 'hoeren-1')
    .getByTestId('save-status')
    .innerText();
  await answerByKeyboard(page, 'hoeren-1', keyOf('hoeren-1'), screen);
  // The arrows wrap around inside the group.
  const options = optionIdsOf('hoeren-1');
  const keyIndex = options.indexOf(keyOf('hoeren-1'));
  const above = options[(keyIndex + options.length - 1) % options.length];
  await page.keyboard.press('ArrowUp');
  await expect(optionIn(card(page, 'hoeren-1'), above ?? '')).toBeChecked();
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  await page.keyboard.press('ArrowDown');
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  const savedText = await card(page, 'hoeren-1')
    .getByTestId('save-status')
    .innerText();
  expect(savedText).not.toBe(idle);

  await activate(page, 'set-next', 'Enter', screen);
  await expect(card(page, 'hoeren-2')).toBeVisible();
  await expect(page.getByTestId('go-to-question-2')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await activate(page, 'set-previous', 'Space', screen);
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await activate(page, 'navigator-toggle', 'Enter', screen);
  await expect(page.getByTestId('navigator-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await activate(page, 'go-to-question-10', 'Enter', screen);
  await expect(card(page, 'hoeren-10')).toBeVisible();
  await expect(card(page, 'hoeren-11')).toBeVisible();
  await answerByKeyboard(page, 'hoeren-11', keyOf('hoeren-11'), screen);

  await activate(page, 'block-link-lesen', 'Enter', screen);
  await page.waitForURL(LESEN_URL);
  await expect(page.getByTestId('block-link-lesen')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await activate(page, 'lesen-view-questions', 'Space', screen);
  await expect(card(page, 'lesen-1')).toBeVisible();
  await expect(page.getByTestId('lesen-view-questions')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await activate(page, 'lesen-view-text', 'Enter', screen);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await activate(page, 'lesen-view-questions', 'Enter', screen);
  await answerByKeyboard(page, 'lesen-1', keyOf('lesen-1'), screen);

  await activate(page, 'finish-attempt', 'Enter', screen);
  await expect(page.getByTestId('finish-confirmation')).toBeVisible();
  await activate(page, 'finish-cancel', 'Enter', screen);
  await expect(page.getByTestId('finish-confirmation')).toHaveCount(0);
  expect(await readResults(attempt.attemptId)).toEqual([]);
  await activate(page, 'finish-attempt', 'Space', screen);
  await activate(page, 'finish-confirm', 'Space', screen);
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(await onlyResult(attempt.attemptId)).toMatchObject({ score: 3 });
  expectDistinctTexts(await outcomeTexts(page));

  await activate(page, 'block-link-hoeren', 'Enter', screen);
  await page.waitForURL(HOEREN_URL);
  await expect(page.getByTestId('review-item')).toHaveCount(20);
  expectDistinctTexts(await outcomeTexts(page));

  // "Start again" opens the choice; the new run is the explicit start there.
  await activate(page, 'restart-attempt', 'Enter', screen);
  await page.waitForURL(CHOICE_URL);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  expect(await readAttempts(attempt.sessionId)).toEqual([
    { id: attempt.attemptId, status: 'completed' },
  ]);
  await activate(page, 'start-attempt', 'Enter', screen);
  await page.waitForURL(HOEREN_URL);
  await expect(card(page, 'hoeren-1')).toBeVisible();
  const attempts = await readAttempts(attempt.sessionId);
  expect(attempts).toHaveLength(2);
  expect(attempts).toContainEqual({
    id: attempt.attemptId,
    status: 'completed',
  });
  const fresh = await activeAttemptOf(context);
  expect(fresh.attemptId).not.toBe(attempt.attemptId);
  await context.close();
});

test('narrow enlarged text keeps actions visible without focus trap', async ({
  browser,
}) => {
  test.slow();
  const { context, page } = await openGuestPage(browser, NARROW, true);
  await page.goto('/');
  await expectEnlargedText(page);
  await expectAccessibleScreen(page, 'home');
  await continueThroughLibrary(page);
  await page.waitForURL(CHOICE_URL);
  await expectAccessibleScreen(page, 'choice');
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  const attempt = await activeAttemptOf(context);
  await waitForPlayer(page);

  const answer = async (questionId: string, optionId: string) => {
    await optionIn(card(page, questionId), optionId).check();
    await expectStatus(card(page, questionId), 'saved');
  };
  const goTo = async (number: number, questionId: string) => {
    await goToStep(page, number);
    await expect(card(page, questionId)).toBeVisible();
  };

  await answer('hoeren-1', keyOf('hoeren-1'));
  await expectAccessibleScreen(page, 'hoeren teil 1');
  await goTo(10, 'hoeren-10');
  await answer('hoeren-10', keyOf('hoeren-10'));
  await answer('hoeren-11', wrongOf('hoeren-11'));
  await expectAccessibleScreen(page, 'hoeren teil 3 pair');
  await goTo(18, 'hoeren-18');
  await answer('hoeren-19', keyOf('hoeren-19'));
  await expectAccessibleScreen(page, 'hoeren teil 4 set');

  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL(LESEN_URL);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expectAccessibleScreen(page, 'lesen text');
  await page.getByTestId('lesen-view-questions').click();
  await answer('lesen-1', keyOf('lesen-1'));
  await expectAccessibleScreen(page, 'lesen task');
  await goTo(6, 'lesen-6');
  await answer('lesen-6', keyOf('lesen-6'));
  await expectAccessibleScreen(page, 'lesen teil 2 task');
  await page.getByTestId('lesen-view-text').click();
  await expectAccessibleScreen(page, 'lesen teil 2 text');

  await page.getByTestId('finish-attempt').click();
  await expect(page.getByTestId('finish-confirmation')).toBeVisible();
  await expectAccessibleScreen(page, 'confirmation');
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expectAccessibleScreen(page, 'lesen review');
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL(HOEREN_URL);
  await expect(page.getByTestId('review-item')).toHaveCount(20);
  await expectAccessibleScreen(page, 'hoeren review');

  expect(await readAnswers(attempt.attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
    'hoeren-10': keyOf('hoeren-10'),
    'hoeren-11': wrongOf('hoeren-11'),
    'hoeren-19': keyOf('hoeren-19'),
    'lesen-1': keyOf('lesen-1'),
    'lesen-6': keyOf('lesen-6'),
  });
  expect(await onlyResult(attempt.attemptId)).toMatchObject({
    score: 5,
    max_score: 45,
  });
  await context.close();
});

// M2 controls and lifecycle (#48) ----------------------------------------------
//
// Guests with their own cookie on the full-set server, in a chosen language.
// The time of an exam or of a guest is placed through the test-only
// admission wrappers; every control is then used through the real page and
// every refusal or replay through the real route. Rows are re-read after each
// step.

const SECOND_MS = 1000;
const H = FULL_TIMING.hoerenSeconds;
const ALL_IDS = FULL_PILOT.content.questions.map((question) => question.id);
type Locale = 'en' | 'ru';

const readMessages = (locale: Locale) =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '..', 'messages', `${locale}.json`),
      'utf8',
    ),
  ) as { save: { error: string } };

const guestWith = async (
  locale: Locale,
  termSeconds: number | null = null,
): Promise<CreatedGuest> => {
  const created =
    termSeconds === null
      ? await newGuest(depsNow())
      : await shortGuest(termSeconds);
  const update = await serviceDb
    .from('guest_sessions')
    .update({ locale })
    .eq('id', created.guest.sessionId);
  expect(update.error).toBeNull();
  return created;
};

// A guest whose fixed term ends the given seconds after the database clock.
const shortGuest = async (seconds: number): Promise<CreatedGuest> => {
  const token = randomBytes(32).toString('base64url');
  psql(
    `select m2_test.insert_guest_ending_in(${quote(hashGuestToken(token))}, ${seconds})`,
  );
  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('short guest is not active');
  return { token, guest };
};

const contextFor = async (
  browser: Browser,
  token: string,
  viewport: ViewportSize = WIDE,
): Promise<BrowserContext> => {
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

const startedAttempt = async (
  created: CreatedGuest,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const started = await startFor(
    depsNow(),
    created.token,
    FULL_EXAM.slug,
    overrides,
  );
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error(`start failed: ${JSON.stringify(started)}`);
  }
  return started.result.attemptId;
};

// A completed free training with one wrong answer: a source with an error.
const completedWithError = async (created: CreatedGuest): Promise<string> => {
  const attemptId = await startedAttempt(created);
  const saved = await saveAnswer(depsNow(), created.token, {
    attemptId,
    questionId: 'hoeren-1',
    optionId: wrongOf('hoeren-1'),
    revision: 1,
  });
  if (!saved.ok) throw new Error(`answer: ${saved.error}`);
  const finished = await submitStored(depsNow(), created.token, { attemptId });
  if (!finished.ok) throw new Error(`finish: ${finished.error}`);
  return attemptId;
};

const examExam = async () => {
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');
  return latest;
};

// A full exam whose Hören began the given seconds ago.
const examAgo = (
  created: CreatedGuest,
  exam: ExamVersionRef,
  seconds: number,
) =>
  startExamAt(created.guest.sessionId, exam, ALL_IDS, secondsAgoSql(seconds));

// On a narrow screen the questions of a Lesen text sit behind a button.
const showQuestions = async (page: Page) => {
  const toggle = page.getByTestId('lesen-view-questions');
  if (await toggle.isVisible()) await toggle.click();
};

// A modal covers the page on purpose: its own two actions must be reachable
// inside the screen and the page must not scroll sideways.
const expectDialogReachable = async (page: Page, screen: string) => {
  for (const testId of [
    'guest-replacement-cancel',
    'guest-replacement-confirm',
  ]) {
    const action = page.getByTestId(testId);
    await action.scrollIntoViewIfNeeded();
    await expect(action, `${testId} ${screen}`).toBeInViewport();
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    `dialog ${screen} scrolls sideways`,
  ).toBe(true);
};

// One task by its step: a block shows the task of its step only.
const answerTask = async (
  page: Page,
  number: number,
  skill: 'hoeren' | 'lesen',
  optionId: string,
) => {
  await showQuestions(page);
  await goToStep(page, number);
  const target = card(page, `${skill}-${number}`);
  await expect(target).toBeVisible();
  await optionIn(target, optionId).check();
  await expectStatus(target, 'saved');
};

const radioIn = (page: Page, testId: string) =>
  page.getByTestId(testId).getByRole('radio');

const scoreOfSelections = (selections: Record<string, string>): number => {
  const policy = selectScoringPolicy('DTZ', 'full-exam');
  if (!policy) throw new Error('policy is missing');
  return policy.score({
    questions: FULL_PILOT.content.questions,
    keys: FULL_PILOT.keys,
    selections,
  }).score;
};

// The guest of a context, read back from its cookie.
const sessionOfContext = async (context: BrowserContext) => {
  const token = (await context.cookies()).find(
    (cookie) => cookie.name === GUEST_COOKIE,
  )?.value;
  if (!token) throw new Error('guest cookie is missing');
  const stored = await readSessionByToken(token);
  if (!stored) throw new Error('guest session is missing');
  return { token, sessionId: stored.id };
};

test('m2 controls remain accessible localized and responsive', async ({
  browser,
}) => {
  // Measured 29.5 s on CI (53 s locally): the same triple budget as the other
  // long journeys of this file.
  test.slow();
  installM2Fixtures();
  const exam = await examExam();
  const texts: Record<string, string> = {};

  for (const viewport of [NARROW, WIDE]) {
    for (const locale of ['en', 'ru'] as const) {
      const screen = `${locale} ${viewport.width}`;

      // The choice and a timed block by keyboard, its clock, its two
      // confirmations and its cancel.
      const timedGuest = await guestWith(locale);
      const context = await contextFor(browser, timedGuest.token, viewport);
      const page = await context.newPage();
      await page.goto(`/practice/${FULL_EXAM.slug}`);
      await expect(page.getByTestId('mode-selection')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expectAccessibleScreen(page, `choice ${screen}`);
      await tabTo(
        page,
        radioIn(page, 'mode-option-training'),
        `modes ${screen}`,
      );
      await page.keyboard.press('ArrowDown');
      await expect(radioIn(page, 'mode-option-timed-block')).toBeChecked();
      await expect(radioIn(page, 'selection-option-hoeren')).toBeChecked();
      await expectAccessibleScreen(page, `timed choice ${screen}`);
      await tabTo(page, page.getByTestId('start-attempt'), `start ${screen}`);
      await page.keyboard.press('Enter');
      await page.waitForURL(HOEREN_URL);
      const timedAttempt = (await activeAttemptOf(context)).attemptId;

      const timer = page.getByTestId('attempt-timer');
      await expect(timer).toHaveAttribute('role', 'timer');
      expect(await timer.getAttribute('aria-live')).toBeNull();
      expect(Number(await timer.getAttribute('data-deadline-ms'))).toBe(
        Date.parse(examRunTimes(timedAttempt).acceptedAt) + H * SECOND_MS,
      );
      await expectAccessibleScreen(page, `timed ${screen}`);

      await tabTo(page, page.getByTestId('finish-attempt'), `finish ${screen}`);
      await page.keyboard.press('Enter');
      const finishing = page.getByTestId('finish-confirmation');
      await expect(finishing).toBeVisible();
      await expectUsableLayout(page, `finish confirmation ${screen}`);
      await tabTo(
        page,
        page.getByTestId('finish-cancel'),
        `finish back ${screen}`,
      );
      await page.keyboard.press('Enter');
      await expect(finishing).toHaveCount(0);

      await tabTo(page, page.getByTestId('cancel-attempt'), `cancel ${screen}`);
      await page.keyboard.press('Enter');
      const cancelling = page.getByTestId('cancel-confirmation');
      await expect(cancelling).toBeVisible();
      await expectUsableLayout(page, `cancel confirmation ${screen}`);
      await tabTo(
        page,
        page.getByTestId('cancel-back'),
        `cancel back ${screen}`,
      );
      await page.keyboard.press('Enter');
      await expect(cancelling).toHaveCount(0);
      expect(await readAttempts(timedGuest.guest.sessionId)).toEqual([
        { id: timedAttempt, status: 'active' },
      ]);

      await tabTo(page, page.getByTestId('cancel-attempt'), `cancel ${screen}`);
      await page.keyboard.press('Enter');
      await tabTo(
        page,
        page.getByTestId('cancel-confirm'),
        `cancel ok ${screen}`,
      );
      await page.keyboard.press('Enter');
      await page.waitForURL(CHOICE_URL);
      await expect(page.getByTestId('mode-selection')).toBeVisible();
      expect(await readAttempts(timedGuest.guest.sessionId)).toEqual([
        { id: timedAttempt, status: 'cancelled' },
      ]);
      expect(await readResults(timedAttempt)).toEqual([]);
      await context.close();

      // The transition of a full exam, its status and the keyboard start of
      // Lesen.
      const examGuest = await guestWith(locale);
      const examAttempt = examAgo(examGuest, exam, H + 5);
      const examContext = await contextFor(browser, examGuest.token, viewport);
      const examPage = await examContext.newPage();
      await examPage.goto(attemptUrl(FULL_EXAM.slug, examAttempt));
      await expect(examPage.getByTestId('transition-screen')).toBeVisible();
      const status = examPage.getByTestId('transition-status');
      await expect(status).toHaveAttribute('role', 'status');
      texts[`transition ${screen}`] = (await status.textContent()) ?? '';
      expect(texts[`transition ${screen}`]).not.toBe('');
      await expectAccessibleScreen(examPage, `transition ${screen}`);
      await tabTo(
        examPage,
        examPage.getByTestId('begin-lesen'),
        `lesen ${screen}`,
      );
      await examPage.keyboard.press('Enter');
      await examPage.waitForURL(LESEN_URL);
      await expect(examPage.getByTestId('training-shell')).toHaveAttribute(
        'data-phase',
        'lesen',
      );
      await examContext.close();

      // The repeat of the own errors from a review.
      const reviewGuest = await guestWith(locale);
      const sourceId = await completedWithError(reviewGuest);
      const reviewContext = await contextFor(
        browser,
        reviewGuest.token,
        viewport,
      );
      const reviewPage = await reviewContext.newPage();
      await reviewPage.goto(attemptUrl(FULL_EXAM.slug, sourceId));
      await expect(reviewPage.getByTestId('attempt-review')).toBeVisible();
      await expectAccessibleScreen(reviewPage, `review ${screen}`);
      await tabTo(
        reviewPage,
        reviewPage.getByTestId('repeat-errors'),
        `repeat ${screen}`,
      );
      await reviewPage.keyboard.press('Enter');
      await expect
        .poll(() => new URL(reviewPage.url()).pathname)
        .not.toContain(sourceId);
      await reviewPage.waitForURL(HOEREN_URL);
      const repeats = (await readAttempts(reviewGuest.guest.sessionId)).filter(
        (row) => row.id !== sourceId,
      );
      expect(repeats).toHaveLength(1);
      expect((await readRunRows(repeats[0]?.id ?? ''))[0]).toMatchObject({
        purpose: 'error-repeat',
        source_attempt_id: sourceId,
      });
      await reviewContext.close();

      // A guest too short for a timed block: the refusal is text, the
      // replacement is a modal that the keyboard enters, leaves and
      // completes.
      const shortOne = await guestWith(locale, 200);
      const shortContext = await contextFor(browser, shortOne.token, viewport);
      const shortPage = await shortContext.newPage();
      await shortPage.goto(`/practice/${FULL_EXAM.slug}`);
      await tabTo(
        shortPage,
        radioIn(shortPage, 'mode-option-training'),
        `modes ${screen}`,
      );
      await shortPage.keyboard.press('ArrowDown');
      await tabTo(
        shortPage,
        shortPage.getByTestId('start-attempt'),
        `start ${screen}`,
      );
      await shortPage.keyboard.press('Enter');
      // The refusal opens the replacement dialog by itself; the keyboard stays
      // inside it, Escape leaves it and returns to the Start button.
      const dialog = shortPage.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute(
        'aria-labelledby',
        'guest-replacement-title',
      );
      const inside = () =>
        dialog.evaluate((element) => element.contains(document.activeElement));
      for (let i = 0; i < 6; i++) {
        await shortPage.keyboard.press('Tab');
        expect(await inside(), `dialog focus ${screen}`).toBe(true);
      }
      await expectDialogReachable(shortPage, screen);
      await shortPage.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(shortPage.getByTestId('start-attempt')).toBeFocused();
      const tooShort = shortPage.getByTestId('start-guest-too-short');
      await expect(tooShort).toBeVisible();
      await expect(tooShort).toHaveAttribute('role', 'alert');
      texts[`too short ${screen}`] = (await tooShort.textContent()) ?? '';
      await expectUsableLayout(shortPage, `too short ${screen}`);
      expect(await readAttempts(shortOne.guest.sessionId)).toEqual([]);
      await tabTo(
        shortPage,
        shortPage.getByTestId('guest-replacement-open'),
        `replace ${screen}`,
      );
      await shortPage.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await shortPage.getByTestId('guest-replacement-confirm').focus();
      await shortPage.keyboard.press('Enter');
      await shortPage.waitForURL(HOEREN_URL);
      const replaced = await sessionOfContext(shortContext);
      expect(replaced.token).not.toBe(shortOne.token);
      expect(replaced.sessionId).not.toBe(shortOne.guest.sessionId);
      expect(await readAttempts(shortOne.guest.sessionId)).toEqual([]);
      const [fresh] = await readAttempts(replaced.sessionId);
      expect(fresh?.status).toBe('active');
      expect((await readRunRows(fresh?.id ?? ''))[0]?.mode).toBe('timed-block');
      await shortContext.close();
    }
  }
  expect(texts['transition ru 390']).not.toBe(texts['transition en 390']);
  expect(texts['too short ru 390']).not.toBe(texts['too short en 390']);
  expect(texts['too short ru 1440']).toBe(texts['too short ru 390']);
  expect(texts['too short en 1440']).toBe(texts['too short en 390']);
});

test('narrow localized failure states remain keyboard recoverable', async ({
  browser,
}) => {
  const ru = readMessages('ru');
  const created = await guestWith('ru');
  const context = await contextFor(browser, created.token, NARROW);
  const page = await context.newPage();
  await page.goto(`/practice/${FULL_EXAM.slug}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await tabTo(page, page.getByTestId('start-attempt'), 'start');
  await page.keyboard.press('Enter');
  await page.waitForURL(HOEREN_URL);
  const attemptId = attemptIdOf(page);
  await waitForPlayer(page);

  // A save that fails: the text names it, the choice stays marked, the
  // retry is a button of the card that the keyboard reaches.
  await context.route(ANSWER_URL, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 503, body: 'unavailable' })
      : route.continue(),
  );
  const first = card(page, 'hoeren-1');
  await optionIn(first, keyOf('hoeren-1')).focus();
  await page.keyboard.press('Space');
  await expectStatus(first, 'error');
  const saveStatus = first.getByTestId('save-status');
  await expect(saveStatus).toHaveAttribute('role', 'alert');
  await expect(saveStatus).toContainText(ru.save.error);
  await expect(optionIn(first, keyOf('hoeren-1'))).toBeChecked();
  expect(await readAnswers(attemptId)).toEqual({});
  await expectUsableLayout(page, 'save failure 390 ru');
  await context.unroute(ANSWER_URL);
  await tabTo(page, first.getByRole('button'), 'save retry');
  await page.keyboard.press('Enter');
  await expectStatus(first, 'saved');
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
  });

  // A recording that cannot be loaded: an alert in text, the tasks and their
  // saves go on, the retry is a button.
  await context.route(SIGN_URL, (route) => route.abort());
  await page.reload();
  const audio = page.getByTestId('audio-status');
  await expect(audio).toHaveAttribute('data-status', 'error');
  await expect(audio).toHaveAttribute('role', 'alert');
  await expect(audio).not.toHaveText('');
  await expect(page.getByTestId('audio-toggle')).toBeDisabled();
  await expectUsableLayout(page, 'audio failure 390 ru');
  await answerTask(page, 2, 'hoeren', keyOf('hoeren-2'));
  await context.unroute(SIGN_URL);
  await tabTo(page, audio.getByRole('button'), 'audio retry');
  await page.keyboard.press('Enter');
  await expect(audio).toHaveAttribute('data-status', 'ready');

  // A submission whose answer is lost: the state is stated, the resend is a
  // button, and the resend does not make a second result.
  await context.route(SUBMIT_URL, (route) => route.abort());
  await tabTo(page, page.getByTestId('finish-attempt'), 'finish');
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByTestId('finish-confirm'), 'finish confirm');
  await page.keyboard.press('Enter');
  const uncertain = page.getByTestId('finish-uncertain');
  await expect(uncertain).toBeVisible();
  await expect(uncertain).toHaveAttribute('role', 'alert');
  await expect(uncertain).not.toHaveText('');
  expect(await readResults(attemptId)).toEqual([]);
  await expectUsableLayout(page, 'submit failure 390 ru');
  await expectNoFocusTrap(page, 'submit failure 390 ru');
  await context.unroute(SUBMIT_URL);
  await tabTo(page, page.getByTestId('finish-resend'), 'finish resend');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(await readResults(attemptId)).toHaveLength(1);
  expect(await readEventKinds(attemptId)).toEqual(['start', 'finish']);
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
    'hoeren-2': keyOf('hoeren-2'),
  });
  await context.close();
});

// Two tabs, a phase, a replaced cookie and a replay ----------------------------

interface SubmitSeen {
  url: string;
  body: string;
}

const recordSubmits = (page: Page): SubmitSeen[] => {
  const seen: SubmitSeen[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/submit')) {
      seen.push({ url: request.url(), body: request.postData() ?? '' });
    }
  });
  return seen;
};

const finishKinds = async (attemptId: string): Promise<string[]> =>
  (await readEventKinds(attemptId)).filter((kind) => kind === 'finish');

test('cross tab phase cookie replacement and replay remain consistent', async ({
  browser,
  request,
}) => {
  // Measured 23.5 s on CI, most of it the real end of a 20 s Hören.
  test.slow();
  installM2Fixtures();
  const exam = await examExam();

  // Two tabs of one guest on one exam whose Hören ends in 20 seconds: each
  // answers its own task, both see the transition, both ask for Lesen at
  // once, and the answers of both are in one final set.
  const guest = await newGuest(depsNow());
  const attemptId = examAgo(guest, exam, H - 20);
  const context = await contextFor(browser, guest.token);
  const tabOne = await context.newPage();
  const tabTwo = await context.newPage();
  const submits = recordSubmits(tabOne);
  await tabOne.goto(attemptUrl(FULL_EXAM.slug, attemptId));
  await tabTwo.goto(attemptUrl(FULL_EXAM.slug, attemptId));
  const oneDeadline = await tabOne
    .getByTestId('attempt-timer')
    .getAttribute('data-deadline-ms');
  expect(
    await tabTwo.getByTestId('attempt-timer').getAttribute('data-deadline-ms'),
  ).toBe(oneDeadline);
  await optionIn(card(tabOne, 'hoeren-1'), keyOf('hoeren-1')).check();
  await expectStatus(card(tabOne, 'hoeren-1'), 'saved');
  await answerTask(tabTwo, 2, 'hoeren', keyOf('hoeren-2'));
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
    'hoeren-2': keyOf('hoeren-2'),
  });

  await expect(tabOne.getByTestId('transition-screen')).toBeVisible({
    timeout: 90_000,
  });
  await expect(tabTwo.getByTestId('transition-screen')).toBeVisible({
    timeout: 90_000,
  });
  const frozen = await readAnswers(attemptId);
  // A save of a Hören task that a stale tab still sends is refused.
  const late = await postCommand(
    request,
    `/api/attempts/${attemptId}/answer`,
    { questionId: 'hoeren-3', optionId: keyOf('hoeren-3'), revision: 1 },
    { token: guest.token },
  );
  expect(late.status).toBe(404);
  expect(await readAnswers(attemptId)).toEqual(frozen);

  await Promise.all([
    tabOne.getByTestId('begin-lesen').click(),
    tabTwo.getByTestId('begin-lesen').click(),
  ]);
  await tabOne.waitForURL(LESEN_URL);
  await tabTwo.waitForURL(LESEN_URL);
  const lesenStart = examRunTimes(attemptId).lesenStartedAt;
  expect(lesenStart).not.toBeNull();
  await expect
    .poll(async () =>
      Number(
        await tabOne
          .getByTestId('attempt-timer')
          .getAttribute('data-deadline-ms'),
      ),
    )
    .toBe(Date.parse(lesenStart ?? '') + FULL_TIMING.lesenSeconds * SECOND_MS);
  await expect
    .poll(async () =>
      Number(
        await tabTwo
          .getByTestId('attempt-timer')
          .getAttribute('data-deadline-ms'),
      ),
    )
    .toBe(Date.parse(lesenStart ?? '') + FULL_TIMING.lesenSeconds * SECOND_MS);
  expect(examRunTimes(attemptId).lesenStartedAt).toBe(lesenStart);
  expect(await readAnswers(attemptId)).toEqual(frozen);

  await showQuestions(tabOne);
  await optionIn(card(tabOne, 'lesen-1'), keyOf('lesen-1')).check();
  await expectStatus(card(tabOne, 'lesen-1'), 'saved');
  await answerTask(tabTwo, 2, 'lesen', keyOf('lesen-2'));
  const finalSet = {
    'hoeren-1': keyOf('hoeren-1'),
    'hoeren-2': keyOf('hoeren-2'),
    'lesen-1': keyOf('lesen-1'),
    'lesen-2': keyOf('lesen-2'),
  };
  expect(await readAnswers(attemptId)).toEqual(finalSet);

  // The first tab finishes; the second finishes the same attempt too. There
  // is one result and one finish event.
  // The first tab counted three answers, the server holds four: the first
  // confirmation is refused with the new numbers and nothing is stored until
  // the guest confirms again.
  await tabOne.getByTestId('finish-attempt').click();
  await tabOne.getByTestId('finish-confirm').click();
  await expect(tabOne.getByTestId('finish-renewed')).toBeVisible();
  expect(await readResults(attemptId)).toEqual([]);
  expect(await finishKinds(attemptId)).toEqual([]);
  await tabOne.getByTestId('finish-confirm').click();
  await expect(tabOne.getByTestId('attempt-review')).toBeVisible();
  const results = await readResults(attemptId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    score: scoreOfSelections(finalSet),
    max_score: 45,
  });
  expect(await finishKinds(attemptId)).toEqual(['finish']);
  await tabTwo.getByTestId('finish-attempt').click();
  const confirm = tabTwo.getByTestId('finish-confirm');
  await expect(confirm.or(tabTwo.getByTestId('attempt-review'))).toBeVisible();
  if (await confirm.isVisible()) await confirm.click();
  await expect(tabTwo.getByTestId('attempt-review')).toBeVisible({
    timeout: 20_000,
  });
  expect(await readResults(attemptId)).toHaveLength(1);
  expect(await finishKinds(attemptId)).toEqual(['finish']);
  expect(await readAnswers(attemptId)).toEqual(finalSet);

  // The accepted submission replays with its own command id: the same
  // outcome and no second result; a new command on the finished attempt is
  // not a second submission either.
  const first = submits[0];
  if (!first) throw new Error('the submit of the first tab was not seen');
  const replay = await request.post(first.url, {
    headers: {
      'content-type': 'application/json',
      cookie: `${GUEST_COOKIE}=${guest.token}`,
      origin: FULL_ORIGIN,
    },
    data: first.body,
  });
  expect(replay.status()).toBe(200);
  const replayed = (await replay.json()) as { ok: boolean };
  expect(replayed.ok).toBe(true);
  const fresh = await postCommand(
    request,
    `/api/attempts/${attemptId}/submit`,
    {
      commandId: randomUUID(),
      answers: [],
      confirmation: { phaseRevision: 0, skipped: 41 },
    },
    { token: guest.token },
  );
  expect(fresh.status).toBeLessThan(500);
  expect(await readResults(attemptId)).toHaveLength(1);
  expect(await finishKinds(attemptId)).toEqual(['finish']);
  expect(await readAnswers(attemptId)).toEqual(finalSet);
  expect(await readAttempts(guest.guest.sessionId)).toEqual([
    { id: attemptId, status: 'completed' },
  ]);
  expect(await readEventKinds(attemptId)).toEqual(['start', 'finish']);
  await context.close();

  // The cookie of a browser is replaced while a second tab of the old guest
  // is still open: the stale tab speaks for the new guest and cannot reach
  // the old one's attempt; the old guest's rows stay.
  const shortOne = await shortGuest(200);
  const sourceId = await completedWithError(shortOne);
  const oldRows = {
    attempts: await readAttempts(shortOne.guest.sessionId),
    results: await readResults(sourceId),
    answers: await readAnswers(sourceId),
    events: await readEventKinds(sourceId),
  };
  const shortContext = await contextFor(browser, shortOne.token);
  const choicePage = await shortContext.newPage();
  const stalePage = await shortContext.newPage();
  await stalePage.goto(attemptUrl(FULL_EXAM.slug, sourceId));
  await expect(stalePage.getByTestId('attempt-review')).toBeVisible();
  await choicePage.goto(`/practice/${FULL_EXAM.slug}`);
  await choicePage.getByTestId('mode-option-timed-block').click();
  await choicePage.getByTestId('start-attempt').click();
  await expect(choicePage.getByTestId('start-guest-too-short')).toBeVisible();
  await choicePage.getByTestId('guest-replacement-confirm').click();
  await choicePage.waitForURL(HOEREN_URL);
  const replaced = await sessionOfContext(shortContext);
  expect(replaced.sessionId).not.toBe(shortOne.guest.sessionId);
  const newAttempts = await readAttempts(replaced.sessionId);
  expect(newAttempts).toHaveLength(1);

  await stalePage.getByTestId('repeat-errors').click();
  // The refusal ends the request: the button is usable again and the page
  // still shows the old attempt.
  await expect(stalePage.getByTestId('repeat-errors')).toBeEnabled();
  expect(new URL(stalePage.url()).pathname).toContain(sourceId);
  expect(await readAttempts(replaced.sessionId)).toEqual(newAttempts);
  expect({
    attempts: await readAttempts(shortOne.guest.sessionId),
    results: await readResults(sourceId),
    answers: await readAnswers(sourceId),
    events: await readEventKinds(sourceId),
  }).toEqual(oldRows);
  await shortContext.close();
});

test('stale phase and replaced cookie cannot rewrite frozen data', async ({
  browser,
  request,
}) => {
  installM2Fixtures();
  const exam = await examExam();

  // A Hören answer of an exam saved while its Hören was open, the Hören now
  // closed: nothing a stale tab or a late request sends rewrites it.
  const guest = await newGuest(depsNow());
  const attemptId = examAgo(guest, exam, H + 5);
  const startMs = Date.parse(examRunTimes(attemptId).acceptedAt);
  psql(`select question_id from m2_test.save_answer_at(
    ${quote(guest.guest.sessionId)}, ${quote(attemptId)}, 'hoeren-1',
    ${quote(keyOf('hoeren-1'))}, 1,
    ${quote(new Date(startMs + 10 * SECOND_MS).toISOString())}::timestamptz)`);
  const frozen = { 'hoeren-1': keyOf('hoeren-1') };
  expect(await readAnswers(attemptId)).toEqual(frozen);

  const answerBody = (
    questionId: string,
    optionId: string,
    revision: number,
  ) => ({
    questionId,
    optionId,
    revision,
  });
  const rows = async () => ({
    answers: await readAnswerRows(attemptId),
    results: await readResults(attemptId),
    events: await readEventKinds(attemptId),
    attempts: await readAttempts(guest.guest.sessionId),
  });
  const before = await rows();
  for (const body of [
    answerBody('hoeren-1', wrongOf('hoeren-1'), 2),
    answerBody('hoeren-1', wrongOf('hoeren-1'), 1),
    answerBody('hoeren-4', keyOf('hoeren-4'), 1),
  ]) {
    const reply = await postCommand(
      request,
      `/api/attempts/${attemptId}/answer`,
      body,
      { token: guest.token },
    );
    expect(reply.status, JSON.stringify(body)).toBe(404);
  }
  expect(await rows()).toEqual(before);

  // The tab of the same guest in the transition: Lesen opens, its answers
  // are saved, the exam is finished once.
  const context = await contextFor(browser, guest.token);
  const page = await context.newPage();
  await page.goto(attemptUrl(FULL_EXAM.slug, attemptId));
  await expect(page.getByTestId('transition-screen')).toBeVisible();
  await page.getByTestId('begin-lesen').click();
  await page.waitForURL(LESEN_URL);
  await optionIn(card(page, 'lesen-1'), keyOf('lesen-1')).check();
  await expectStatus(card(page, 'lesen-1'), 'saved');
  await finishFromShell(page);
  const done = {
    'hoeren-1': keyOf('hoeren-1'),
    'lesen-1': keyOf('lesen-1'),
  };
  expect(await readAnswers(attemptId)).toEqual(done);
  expect(await readResults(attemptId)).toHaveLength(1);
  const finished = await rows();

  // After the finish nothing rewrites it: not a late save of either block,
  // not a cancel, not another submission.
  const lates = [
    [
      `/api/attempts/${attemptId}/answer`,
      answerBody('lesen-1', wrongOf('lesen-1'), 2),
    ],
    [
      `/api/attempts/${attemptId}/answer`,
      answerBody('lesen-2', keyOf('lesen-2'), 1),
    ],
    [
      `/api/attempts/${attemptId}/cancel`,
      {
        commandId: randomUUID(),
        confirmation: { phaseRevision: 0, skipped: 43 },
      },
    ],
    [
      `/api/attempts/${attemptId}/submit`,
      {
        commandId: randomUUID(),
        answers: [answerBody('lesen-3', keyOf('lesen-3'), 1)],
        confirmation: { phaseRevision: 0, skipped: 42 },
      },
    ],
  ] as const;
  for (const [pathname, body] of lates) {
    const reply = await postCommand(request, pathname, body, {
      token: guest.token,
    });
    expect(reply.status, pathname).toBeLessThan(500);
    expect(await rows(), pathname).toEqual(finished);
  }
  await context.close();

  // The cookie replaced: the old guest's token and the new guest's token
  // both fail to rewrite the finished attempt of the old guest.
  const shortOne = await shortGuest(200);
  const sourceId = await completedWithError(shortOne);
  const sourceRows = async () => ({
    answers: await readAnswerRows(sourceId),
    results: await readResults(sourceId),
    events: await readEventKinds(sourceId),
    attempts: await readAttempts(shortOne.guest.sessionId),
  });
  const sourceBefore = await sourceRows();
  const shortContext = await contextFor(browser, shortOne.token);
  const shortPage = await shortContext.newPage();
  await shortPage.goto(`/practice/${FULL_EXAM.slug}`);
  await shortPage.getByTestId('mode-option-timed-block').click();
  await shortPage.getByTestId('start-attempt').click();
  await shortPage.getByTestId('guest-replacement-confirm').click();
  await shortPage.waitForURL(HOEREN_URL);
  const replaced = await sessionOfContext(shortContext);
  expect(replaced.token).not.toBe(shortOne.token);
  const newBefore = await readAttempts(replaced.sessionId);
  for (const token of [shortOne.token, replaced.token]) {
    for (const [pathname, body] of [
      [
        `/api/attempts/${sourceId}/answer`,
        answerBody('hoeren-1', keyOf('hoeren-1'), 2),
      ],
      [
        `/api/attempts/${sourceId}/answer`,
        answerBody('hoeren-2', keyOf('hoeren-2'), 1),
      ],
      [
        `/api/attempts/${sourceId}/cancel`,
        {
          commandId: randomUUID(),
          confirmation: { phaseRevision: 0, skipped: 44 },
        },
      ],
      [
        `/api/attempts/${sourceId}/submit`,
        {
          commandId: randomUUID(),
          answers: [],
          confirmation: { phaseRevision: 0, skipped: 44 },
        },
      ],
    ] as const) {
      const reply = await postCommand(request, pathname, body, { token });
      expect(
        reply.status,
        `${pathname} ${token === replaced.token}`,
      ).toBeLessThan(500);
      expect(await sourceRows(), pathname).toEqual(sourceBefore);
    }
  }
  expect(await readAttempts(replaced.sessionId)).toEqual(newBefore);
  await shortContext.close();
});
