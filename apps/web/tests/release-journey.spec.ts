import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  finishAttempt,
  getAttemptReview,
  openPractice,
  restartAttempt,
  saveAnswer,
  saveProgress,
} from '../src/server/attempts/attempts';
import { resolveAttemptAudio } from '../src/server/audio/audio';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  hashGuestToken,
  resolveGuestSession,
  setGuestLocale,
} from '../src/server/guest-session/session';
import {
  createPublicClient,
  depsAt,
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readOnlyResult,
  readProgress,
  readResults,
  readSession,
  serviceDb,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TRACK_ID,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  activeAttemptOf,
  card,
  expectStatus,
  optionIn,
  seekTo,
  snapshotOf,
  startBrowserGuest,
  waitForPlayer,
} from './support/guest-browser';
import {
  NARROW,
  WIDE,
  expectAccessibleScreen,
  expectEnlargedText,
  expectUsableLayout,
  openGuestPage,
  tabTo,
} from './support/release';
import type { ViewportSize } from './support/release';

// The release route of a guest on the synthetic full set (20 Hören, 25 Lesen,
// key in FULL_PILOT): the same pages, server actions and database functions
// as for every visitor. Every step is compared with the re-read database.

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
  await page.waitForURL('**/practice');
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
  await activate(page, 'go-to-question-18', 'Enter', screen);
  await expect(card(page, 'hoeren-18')).toBeVisible();
  await expectUsableLayout(page, `${screen} hoeren 18-20`);
  await answerByKeyboard(page, 'hoeren-18', wrongOf('hoeren-18'), screen);

  await activate(page, 'block-link-lesen', 'Enter', screen);
  await page.waitForURL('**/practice/lesen');
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
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await page.waitForURL('**/practice');
    const { attemptId } = await activeAttemptOf(context);
    const status = page.getByTestId('audio-status');
    await expect(status).toHaveAttribute('data-status', 'error');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).not.toHaveText('');
    await expect(page.getByTestId('audio-toggle')).toBeDisabled();

    await optionIn(card(page, 'hoeren-1'), keyOf('hoeren-1')).check();
    await expectStatus(card(page, 'hoeren-1'), 'saved');
    await page.getByTestId('block-link-lesen').click();
    await page.waitForURL('**/practice/lesen');
    await optionIn(card(page, 'lesen-1'), wrongOf('lesen-1')).check();
    await expectStatus(card(page, 'lesen-1'), 'saved');
    await expect(status).toHaveAttribute('data-status', 'error');
    expect(await readAnswers(attemptId)).toEqual({
      'hoeren-1': keyOf('hoeren-1'),
      'lesen-1': wrongOf('lesen-1'),
    });

    await context.unroute(SIGN_URL);
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
    for (const path of ['**/practice', '**/practice/lesen']) {
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
    await page.waitForURL('**/practice/lesen');
    const lesen = card(page, 'lesen-1');
    await optionIn(lesen, keyOf('lesen-1')).check();
    await expectStatus(lesen, 'error');
    await expect(optionIn(lesen, keyOf('lesen-1'))).toBeChecked();
    await expect(saved).toHaveCount(0);
    expect(await readAnswers(attemptId)).toEqual({});

    await page.getByTestId('finish-attempt').click();
    const unsaved = page.getByTestId('finish-unsaved');
    await expect(unsaved).toHaveAttribute('role', 'alert');
    await expect(unsaved).toHaveAttribute('data-unsaved-hoeren', '1');
    await expect(unsaved).toHaveAttribute('data-unsaved-lesen', '1');
    await expect(page.getByTestId('attempt-review')).toHaveCount(0);
    expect(await readResults(attemptId)).toEqual([]);
    expect(await readAttempts(guest.sessionId)).toEqual([
      { id: attemptId, status: 'active' },
    ]);

    await context.unroute('**/practice');
    await context.unroute('**/practice/lesen');
    await tabTo(page, lesen.getByRole('button'), 'lesen retry');
    await page.keyboard.press('Enter');
    await expectStatus(lesen, 'saved');
    await page.getByTestId('block-link-hoeren').click();
    await page.waitForURL('**/practice');
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

// A guest made through the real server with an attempt on the full set.
const serverGuest = async () => {
  const created = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), created.guest, FULL_EXAM.slug);
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
    const finished = await finishAttempt(depsNow(), token, { attemptId });
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
    const restarted = await restartAttempt(depsNow(), token, { attemptId });
    if (!restarted.ok) throw new Error(`restart: ${restarted.error}`);
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
  'attempt_results',
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
    expect(await restartAttempt(depsNow(), owner.token, { attemptId })).toEqual(
      { ok: false, error: 'not-completed' },
    );
    const context = await browser.newContext();
    await context.addCookies([
      { name: GUEST_COOKIE, value: owner.token, url: baseURL },
    ]);
    const page = await context.newPage();
    for (const path of ['/practice', '/practice/lesen']) {
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
        await finishAttempt(deps, token, { attemptId }),
        await getAttemptReview(deps, token, { attemptId }),
        await restartAttempt(deps, token, { attemptId }),
        await resolveAttemptAudio(deps, token, track),
      ];
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ ok: false, error: 'session-invalid' });
      }
    }
    await expectOwnerUnchanged();
  });

  await test.step('no operation on a foreign attempt', async () => {
    const { token } = stranger;
    const refusals = [
      await saveAnswer(depsNow(), token, next),
      await saveProgress(depsNow(), token, { attemptId, progress: PROGRESS }),
      await finishAttempt(depsNow(), token, { attemptId }),
      await getAttemptReview(depsNow(), token, { attemptId }),
      await restartAttempt(depsNow(), token, { attemptId }),
    ];
    for (const refusal of refusals) {
      expect(refusal).toEqual({ ok: false, error: 'attempt-not-found' });
    }
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
      await finishAttempt(depsNow(), owner.token, { attemptId, score: 45 }),
      await finishAttempt(depsNow(), owner.token, { attemptId, level: 'B1' }),
      await finishAttempt(depsNow(), owner.token, {
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
      await restartAttempt(depsNow(), owner.token, {
        attemptId,
        scope: 'short-set',
      }),
      await resolveAttemptAudio(depsNow(), owner.token, {
        ...track,
        objectPath: (await trackOf(versionId)).object_path,
      }),
    ];
    for (const refusal of forged) {
      expect(refusal).toMatchObject({ ok: false, error: 'invalid-input' });
    }
    await expectOwnerUnchanged();
  });

  const anon = createPublicClient();
  const now = new Date().toISOString();
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
      restart_attempt: {
        p_session_id: sessionId,
        p_attempt_id: attemptId,
        p_exam_version_id: versionId,
        p_now: now,
        p_scope: 'full-exam',
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
  await activate(page, 'go-to-question-10', 'Enter', screen);
  await expect(card(page, 'hoeren-10')).toBeVisible();
  await expect(card(page, 'hoeren-11')).toBeVisible();
  await answerByKeyboard(page, 'hoeren-11', keyOf('hoeren-11'), screen);

  await activate(page, 'block-link-lesen', 'Enter', screen);
  await page.waitForURL('**/practice/lesen');
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
  await page.waitForURL('**/practice');
  await expect(page.getByTestId('review-item')).toHaveCount(20);
  expectDistinctTexts(await outcomeTexts(page));

  await activate(page, 'restart-attempt', 'Enter', screen);
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
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  const attempt = await activeAttemptOf(context);
  await waitForPlayer(page);

  const answer = async (questionId: string, optionId: string) => {
    await optionIn(card(page, questionId), optionId).check();
    await expectStatus(card(page, questionId), 'saved');
  };
  const goTo = async (number: number, questionId: string) => {
    await page.getByTestId(`go-to-question-${number}`).click();
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
  await page.waitForURL('**/practice/lesen');
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
  await page.waitForURL('**/practice');
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
