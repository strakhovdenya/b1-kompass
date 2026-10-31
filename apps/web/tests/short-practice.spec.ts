import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { selectScoringPolicy } from '@b1k/domain';
import type { AttemptReview } from '@b1k/domain';
import {
  PILOT_CONTENT,
  PILOT_EXAM,
  publishExamVersion,
  publishPilotShortSet,
} from '../../../scripts/seed-pilot-question';
import {
  finishAttempt,
  getAttemptReview,
  openPractice,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { resolveAttemptAudio } from '../src/server/audio/audio';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { getPublishedVersion } from '../src/server/material/published';
import {
  createPublicClient,
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readResults,
  readSessionByToken,
  serviceDb,
} from './support/db';
import { TEST_PILOT_KEYS, createTestRecording } from './support/global-setup';

const PROMPTS = {
  'hoeren-1': 'Was soll Herr Rossi machen?',
  'hoeren-2': 'Wann soll Frau Tulipano anrufen?',
  'hoeren-3': 'Was muss Frau Jensen tun?',
  'hoeren-4': 'Sie haben gerade ein dringendes technisches Problem.',
} as const;
const QUESTION_IDS = Object.keys(PROMPTS);
const AUDIO_BUCKET = 'exam-sources';

// Helpers --------------------------------------------------------------------

const startGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(page.getByText(PROMPTS['hoeren-1'])).toBeVisible();
};

const sessionOf = async (context: BrowserContext) => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  const session = await readSessionByToken(cookie.value);
  if (!session) throw new Error('guest session is missing');
  return session;
};

const onlyAttemptOf = async (sessionId: string) => {
  const attempts = await readAttempts(sessionId);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  if (!attempt) throw new Error('attempt is missing');
  return attempt;
};

const option = (page: Page, text: string) =>
  page.getByRole('radio', { name: new RegExp(text.replace(/\./g, '\\.')) });

const saveStatus = (page: Page) => page.getByTestId('save-status');

const answerOnPage = async (page: Page, number: number, text: string) => {
  await page.getByRole('button', { name: `Go to question ${number}` }).click();
  await option(page, text).check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
};

const audioOf = (page: Page) => page.getByTestId('audio-element');

const mediaState = (audio: Locator) =>
  audio.evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    paused: element.paused,
    isConnected: element.isConnected,
    marker: element.dataset.marker ?? null,
  }));

const waitForMetadata = async (audio: Locator) =>
  expect
    .poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration))
    .toBeGreaterThan(10);

const objectPathOf = async (audio: Locator): Promise<string> => {
  const src = await audio.evaluate((element: HTMLAudioElement) => element.currentSrc);
  return new URL(src).pathname;
};

// A guest created through the real server with the given saved answers.
const guestWith = async (answers: Record<string, string>) => {
  const created = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), created.guest);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  const attemptId = opened.practice.attemptId;
  for (const [questionId, optionId] of Object.entries(answers)) {
    const saved = await saveAnswer(depsNow(), created.token, {
      attemptId,
      questionId,
      optionId,
    });
    expect(saved.ok).toBe(true);
  }
  return { ...created, attemptId, practice: opened.practice };
};

const finishedReview = async (token: string, attemptId: string) => {
  const finished = await finishAttempt(depsNow(), token, { attemptId });
  if (!finished.ok) throw new Error(`finish: ${finished.error}`);
  return finished.review;
};

interface StoredResult {
  scope: string;
  score: number;
  max_score: number;
  correct_count: number;
  incorrect_count: number;
  skipped_count: number;
  computed_at: string;
}

const storedResults = async (attemptId: string) =>
  (await readResults(attemptId)) as StoredResult[];

const countRows = async (table: string): Promise<number> => {
  const { count, error } = await serviceDb
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
};

const pilotVersion = async () => {
  const version = await getPublishedVersion(depsNow(), PILOT_EXAM.slug);
  if (!version) throw new Error('pilot version is missing');
  return version;
};

const trackOf = async (versionId: string) => {
  const { data, error } = await serviceDb
    .from('exam_version_audio')
    .select('track_id, kind, object_path, content_type, sha256')
    .eq('exam_version_id', versionId)
    .returns<
      {
        track_id: string;
        kind: string;
        object_path: string;
        content_type: string;
        sha256: string;
      }[]
    >();
  if (error) throw error;
  expect(data).toHaveLength(1);
  const track = data[0];
  if (!track) throw new Error('audio track is missing');
  return track;
};

const expectShortSetReview = (
  review: AttemptReview,
  expected: Pick<AttemptReview, 'score' | 'correct' | 'incorrect' | 'skipped'>,
) => {
  expect(review).toMatchObject({
    scope: 'short-set',
    showsLevel: false,
    maxScore: QUESTION_IDS.length,
    ...expected,
  });
  expect(review.percent).toBe(
    Math.round((expected.score / QUESTION_IDS.length) * 100),
  );
};

// Audio ------------------------------------------------------------------------

test('two listeners seek independently without navigation restart', async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const pageA = await first.newPage();
  const pageB = await second.newPage();
  await startGuest(pageA);
  await startGuest(pageB);
  const audioA = audioOf(pageA);
  const audioB = audioOf(pageB);
  await expect(pageA.getByTestId('audio-status')).toHaveAttribute('data-status', 'ready');
  await expect(pageB.getByTestId('audio-status')).toHaveAttribute('data-status', 'ready');
  await waitForMetadata(audioA);
  await waitForMetadata(audioB);

  // Both browsers read the same private object, each with its own address.
  const track = await trackOf((await pilotVersion()).versionId);
  const pathA = await objectPathOf(audioA);
  expect(pathA).toContain(`/${AUDIO_BUCKET}/${track.object_path}`);
  expect(await objectPathOf(audioB)).toBe(pathA);

  await pageA.getByRole('button', { name: /Play/ }).click();
  await expect(pageA.getByRole('button', { name: /Pause/ })).toBeVisible();
  await audioA.evaluate((element: HTMLAudioElement) => {
    element.currentTime = 8;
    element.dataset.marker = 'first-player';
  });
  await audioB.evaluate((element: HTMLAudioElement) => {
    element.currentTime = 3;
  });
  await expect
    .poll(async () => (await mediaState(audioA)).currentTime)
    .toBeGreaterThan(8.3);

  const listenerA = await mediaState(audioA);
  const listenerB = await mediaState(audioB);
  expect(listenerA.paused).toBe(false);
  expect(listenerB.paused).toBe(true);
  expect(listenerB.currentTime).toBeCloseTo(3, 0);

  // Moving between questions keeps the very same playing element.
  await pageA.getByRole('button', { name: 'Next' }).click();
  await expect(pageA.getByText(PROMPTS['hoeren-2'])).toBeVisible();
  await pageA.getByRole('button', { name: 'Go to question 4' }).click();
  await expect(pageA.getByText(PROMPTS['hoeren-4'])).toBeVisible();
  const afterNavigation = await mediaState(audioA);
  expect(afterNavigation).toMatchObject({
    paused: false,
    isConnected: true,
    marker: 'first-player',
  });
  expect(afterNavigation.currentTime).toBeGreaterThanOrEqual(
    listenerA.currentTime,
  );

  // A server re-render after the language switch does not reload it either.
  await pageA.getByRole('button', { name: 'Русский' }).click();
  await expect(pageA.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(pageA.getByText(PROMPTS['hoeren-4'])).toBeVisible();
  const afterSwitch = await mediaState(audioA);
  expect(afterSwitch).toMatchObject({
    paused: false,
    isConnected: true,
    marker: 'first-player',
  });
  expect(afterSwitch.currentTime).toBeGreaterThanOrEqual(
    afterNavigation.currentTime,
  );

  const stillB = await mediaState(audioB);
  expect(stillB.paused).toBe(true);
  expect(stillB.currentTime).toBeCloseTo(3, 0);
  // Playback state is never stored on the server.
  const attemptA = await onlyAttemptOf((await sessionOf(first)).id);
  expect(await readAnswers(attemptA.id)).toEqual({});

  await first.close();
  await second.close();
});

test('audio failure preserves answer controls', async ({ browser }) => {
  const context = await browser.newContext();
  await context.route('**/storage/v1/object/sign/**', (route) => route.abort());
  const page = await context.newPage();
  await startGuest(page);

  const status = page.getByTestId('audio-status');
  await expect(status).toHaveAttribute('data-status', 'error');
  await expect(status).toContainText('The recording could not be loaded');
  await expect(page.getByRole('button', { name: /Play/ })).toBeDisabled();

  const attempt = await onlyAttemptOf((await sessionOf(context)).id);
  await option(page, 'In der Sprachschule anrufen.').check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  await answerOnPage(page, 2, 'Am Nachmittag.');
  await expect(status).toHaveAttribute('data-status', 'error');
  expect(await readAnswers(attempt.id)).toEqual({
    'hoeren-1': 'b',
    'hoeren-2': 'a',
  });
  expect(await readResults(attempt.id)).toEqual([]);

  // Once Storage is reachable again the same page loads the recording.
  await context.unroute('**/storage/v1/object/sign/**');
  await page.getByRole('button', { name: 'Load again' }).click();
  await expect(status).toHaveAttribute('data-status', 'ready');
  await expect(page.getByRole('button', { name: /Play/ })).toBeEnabled();
  await context.close();
});

// Completion and review ----------------------------------------------------------

test('short attempt gets scoped server result', async ({ page }) => {
  await startGuest(page);
  const session = await sessionOf(page.context());
  const attempt = await onlyAttemptOf(session.id);

  // Test key: c, a, b, c. Two right, one wrong, one skipped.
  await option(page, 'Sofort in den Kurs kommen.').check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  await answerOnPage(page, 2, 'Nächste Woche.');
  await answerOnPage(page, 4, 'Sich telefonisch melden.');
  await expect(page.getByTestId('set-answered')).toContainText('Answered: 3 of 4');

  const html = await (await page.request.get('/practice')).text();
  expect(html).not.toContain('review-solution');
  expect(html).not.toContain('correctOptionId');

  await page.getByTestId('finish-attempt').click();
  await page.getByTestId('finish-confirm').click();
  const review = page.getByTestId('attempt-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('result-score')).toHaveText('2 of 4 points (50.0%)');
  await expect(page.getByTestId('result-counts')).toHaveText(
    'Right: 2 · Wrong: 1 · Skipped: 1',
  );
  await expect(page.getByTestId('result-scope')).toContainText(
    'not an official DTZ level',
  );
  await expect(review).not.toContainText(/\b(A1|A2|B1|B2|C1)\b/);
  const outcomes = await page
    .getByTestId('review-item')
    .evaluateAll((items: HTMLElement[]) =>
      items.map((item) => [item.dataset.questionId, item.dataset.outcome]),
    );
  expect(outcomes).toEqual([
    ['hoeren-1', 'correct'],
    ['hoeren-2', 'incorrect'],
    ['hoeren-3', 'skipped'],
    ['hoeren-4', 'correct'],
  ]);
  await expect(page.getByRole('radio')).toHaveCount(0);

  expect(await readAttempts(session.id)).toEqual([
    { id: attempt.id, status: 'completed' },
  ]);
  expect(await storedResults(attempt.id)).toEqual([
    expect.objectContaining({
      scope: 'short-set',
      score: 2,
      max_score: 4,
      correct_count: 2,
      incorrect_count: 1,
      skipped_count: 1,
    }),
  ]);

  // The stored result is what the page shows after a reload.
  await page.reload();
  await expect(page.getByTestId('result-score')).toHaveText('2 of 4 points (50.0%)');
  expect(await readAttempts(session.id)).toHaveLength(1);
  expect(await storedResults(attempt.id)).toHaveLength(1);
});

test('duplicate finish and late save cannot change result', async () => {
  const guest = await guestWith({ 'hoeren-1': 'c', 'hoeren-2': 'b' });
  const finish = () =>
    finishAttempt(depsNow(), guest.token, { attemptId: guest.attemptId });

  // Two overlapping completions race with a save; the database serialises
  // them on the attempt row.
  const raced = await Promise.all([
    finish(),
    finish(),
    saveAnswer(depsNow(), guest.token, {
      attemptId: guest.attemptId,
      questionId: 'hoeren-3',
      optionId: 'b',
    }),
  ]);
  const reviews = raced.slice(0, 2).map((result) => {
    if (!('review' in result)) throw new Error('finish failed');
    return result.review;
  });
  expect(reviews[1]).toEqual(reviews[0]);

  const results = await storedResults(guest.attemptId);
  expect(results).toHaveLength(1);
  const frozen = await readAnswers(guest.attemptId);
  const policy = selectScoringPolicy('DTZ', 'short-set');
  if (!policy) throw new Error('policy is missing');
  const expected = policy.score({
    questions: PILOT_CONTENT.questions,
    keys: TEST_PILOT_KEYS,
    selections: frozen,
  });
  expect(results[0]).toMatchObject({
    score: expected.score,
    correct_count: expected.correct,
    incorrect_count: expected.incorrect,
    skipped_count: expected.skipped,
  });
  expect(reviews[0]?.score).toBe(expected.score);

  // After completion a late save is refused and changes nothing.
  const late = await saveAnswer(depsNow(), guest.token, {
    attemptId: guest.attemptId,
    questionId: 'hoeren-2',
    optionId: 'a',
  });
  expect(late).toEqual({ ok: false, error: 'attempt-not-found' });
  const again = await finish();
  expect(again).toEqual({ ok: true, review: reviews[0] });

  const directAnswer = await serviceDb
    .from('attempt_answers')
    .update({ option_id: 'a' })
    .eq('attempt_id', guest.attemptId)
    .eq('question_id', 'hoeren-2');
  expect(directAnswer.error?.hint).toBe('attempt_completed');
  const directResult = await serviceDb
    .from('attempt_results')
    .update({ score: 4 })
    .eq('attempt_id', guest.attemptId);
  expect(directResult.error?.hint).toBe('result_final');
  const reopen = await serviceDb
    .from('attempts')
    .update({ status: 'active' })
    .eq('id', guest.attemptId);
  expect(reopen.error?.hint).toBe('attempt_completed');

  expect(await readAnswers(guest.attemptId)).toEqual(frozen);
  expect(await storedResults(guest.attemptId)).toEqual(results);
  expect(await readAttempts(guest.guest.sessionId)).toEqual([
    { id: guest.attemptId, status: 'completed' },
  ]);
});

test('completed owned attempt exposes review', async () => {
  // Another version with the same question ids and a different key must not
  // leak into the review of the pilot attempt.
  const other = await publishExamVersion(serviceDb, {
    slug: 'test-other-version',
    title: 'Other version',
    format: 'DTZ',
    content: PILOT_CONTENT,
    keys: { 'hoeren-1': 'a', 'hoeren-2': 'c', 'hoeren-3': 'a', 'hoeren-4': 'a' },
    audio: [{ trackId: 'hoeren-teil-1', ...createTestRecording() }],
  });
  const pilot = await pilotVersion();
  expect(other.versionId).not.toBe(pilot.versionId);

  const guest = await guestWith({ 'hoeren-1': 'c', 'hoeren-3': 'a' });
  const finished = await finishedReview(guest.token, guest.attemptId);
  const reviewed = await getAttemptReview(depsNow(), guest.token, {
    attemptId: guest.attemptId,
  });
  expect(reviewed).toEqual({ ok: true, review: finished });
  if (!reviewed.ok) throw new Error('review is missing');
  const { review } = reviewed;

  expect(review.attemptId).toBe(guest.attemptId);
  expectShortSetReview(review, { score: 1, correct: 1, incorrect: 1, skipped: 2 });
  expect(review.items.map((item) => item.questionId)).toEqual(QUESTION_IDS);
  expect(
    Object.fromEntries(
      review.items.map((item) => [item.questionId, item.correctOptionId]),
    ),
  ).toEqual(TEST_PILOT_KEYS);
  expect(
    Object.fromEntries(
      review.items.map((item) => [item.questionId, item.selectedOptionId]),
    ),
  ).toEqual({ 'hoeren-1': 'c', 'hoeren-2': null, 'hoeren-3': 'a', 'hoeren-4': null });
  expect(JSON.stringify(review)).not.toContain(other.versionId);

  // The page of the same guest restores the review of the completed attempt.
  const opened = await openPractice(depsNow(), guest.guest);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  expect(opened.practice.attemptId).toBe(guest.attemptId);
  expect(opened.practice.review).toEqual(review);
});

test('denies early foreign review and client score', async () => {
  const owner = await guestWith({ 'hoeren-1': 'a' });
  const stranger = await guestWith({ 'hoeren-1': 'c', 'hoeren-2': 'a' });
  const strangerReview = await finishedReview(stranger.token, stranger.attemptId);
  const strangerResult = await storedResults(stranger.attemptId);
  const anon = createPublicClient();
  const ownerUntouched = async () => {
    expect(await readAnswers(owner.attemptId)).toEqual({ 'hoeren-1': 'a' });
    expect(await readResults(owner.attemptId)).toEqual([]);
    expect(await readAttempts(owner.guest.sessionId)).toEqual([
      { id: owner.attemptId, status: 'active' },
    ]);
  };

  await test.step('own active attempt has no review yet', async () => {
    const early = await getAttemptReview(depsNow(), owner.token, {
      attemptId: owner.attemptId,
    });
    expect(early).toEqual({ ok: false, error: 'not-completed' });
    expect(JSON.stringify(owner.practice)).not.toMatch(/correct|key/i);
    await ownerUntouched();
  });

  await test.step('foreign completed attempt stays closed', async () => {
    expect(
      await getAttemptReview(depsNow(), owner.token, {
        attemptId: stranger.attemptId,
      }),
    ).toEqual({ ok: false, error: 'attempt-not-found' });
    expect(
      await finishAttempt(depsNow(), owner.token, {
        attemptId: stranger.attemptId,
      }),
    ).toEqual({ ok: false, error: 'attempt-not-found' });
    expect(
      await resolveAttemptAudio(depsNow(), owner.token, {
        attemptId: stranger.attemptId,
        trackId: 'hoeren-teil-1',
      }),
    ).toEqual({ ok: false, error: 'not-found' });
    expect(
      await getAttemptReview(depsNow(), null, { attemptId: stranger.attemptId }),
    ).toEqual({ ok: false, error: 'session-invalid' });
    expect(await storedResults(stranger.attemptId)).toEqual(strangerResult);
    await ownerUntouched();
  });

  await test.step('a ready score from the client is not used', async () => {
    for (const forged of [
      { attemptId: owner.attemptId, score: 4 },
      { attemptId: owner.attemptId, score: 4, maxScore: 4, status: 'completed' },
      { attemptId: owner.attemptId, guestSessionId: stranger.guest.sessionId },
    ]) {
      expect(await finishAttempt(depsNow(), owner.token, forged)).toEqual({
        ok: false,
        error: 'invalid-input',
      });
    }
    await ownerUntouched();

    const direct = await anon.rpc('finish_attempt', {
      p_session_id: owner.guest.sessionId,
      p_attempt_id: owner.attemptId,
      p_now: new Date().toISOString(),
      p_scope: 'short-set',
      p_scored_answers: { 'hoeren-1': 'a' },
      p_score: 4,
      p_max_score: 4,
      p_correct: 4,
      p_incorrect: 0,
      p_skipped: 0,
    });
    expect(direct.error).not.toBeNull();
    for (const table of ['exam_version_audio', 'attempt_results', 'answer_keys']) {
      const { data, error } = await anon.from(table).select('*');
      expect(error, table).not.toBeNull();
      expect(data, table).toBeNull();
    }
    const opened = await anon.rpc('open_attempt', {
      p_session_id: owner.guest.sessionId,
      p_exam_version_id: (await pilotVersion()).versionId,
      p_now: new Date().toISOString(),
    });
    expect(opened.error).not.toBeNull();
    await ownerUntouched();

    // The server scores the stored answer: a is wrong for task 1.
    const review = await finishedReview(owner.token, owner.attemptId);
    expectShortSetReview(review, { score: 0, correct: 0, incorrect: 1, skipped: 3 });
    expect(await storedResults(owner.attemptId)).toEqual([
      expect.objectContaining({ score: 0, max_score: 4, incorrect_count: 1 }),
    ]);
    expect(strangerReview.score).toBe(2);
  });

  await test.step('audio access needs the own session', async () => {
    expect(
      await resolveAttemptAudio(depsNow(), null, {
        attemptId: owner.attemptId,
        trackId: 'hoeren-teil-1',
      }),
    ).toEqual({ ok: false, error: 'session-invalid' });
    expect(
      await resolveAttemptAudio(depsNow(), owner.token, {
        attemptId: owner.attemptId,
        trackId: 'hoeren-teil-1',
        objectPath: 'audio/other.wav',
      }),
    ).toEqual({ ok: false, error: 'invalid-input' });
    const own = await resolveAttemptAudio(depsNow(), owner.token, {
      attemptId: owner.attemptId,
      trackId: 'hoeren-teil-1',
    });
    expect(own.ok).toBe(true);
  });
});

test('empty short attempt finishes as all skipped', async ({ page }) => {
  await startGuest(page);
  const session = await sessionOf(page.context());
  const attempt = await onlyAttemptOf(session.id);
  expect(await readAnswers(attempt.id)).toEqual({});
  await expect(page.getByTestId('set-answered')).toContainText('Answered: 0 of 4');

  await page.getByTestId('finish-attempt').click();
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('result-score')).toHaveText('0 of 4 points (0.0%)');
  await expect(page.getByTestId('result-counts')).toHaveText(
    'Right: 0 · Wrong: 0 · Skipped: 4',
  );
  await expect(page.getByTestId('result-scope')).toContainText(
    'not an official DTZ level',
  );
  await expect(page.getByTestId('attempt-review')).not.toContainText(
    /\b(A1|A2|B1|B2|C1)\b/,
  );
  await expect(page.locator('[data-outcome="skipped"]')).toHaveCount(4);

  expect(await readAnswers(attempt.id)).toEqual({});
  expect(await storedResults(attempt.id)).toEqual([
    expect.objectContaining({
      scope: 'short-set',
      score: 0,
      max_score: 4,
      correct_count: 0,
      incorrect_count: 0,
      skipped_count: 4,
    }),
  ]);
  expect(await readAttempts(session.id)).toEqual([
    { id: attempt.id, status: 'completed' },
  ]);
});

// Publication --------------------------------------------------------------------

test('seed publishes short set with audio once', async () => {
  const current = await pilotVersion();
  const versionsBefore = await countRows('exam_versions');
  const keysBefore = await countRows('answer_keys');
  const recording = createTestRecording();

  const first = await publishPilotShortSet(serviceDb, TEST_PILOT_KEYS, recording);
  const second = await publishPilotShortSet(serviceDb, TEST_PILOT_KEYS, recording);
  expect(first).toEqual({ versionId: current.versionId, isNew: false });
  expect(second).toEqual(first);
  expect(await countRows('exam_versions')).toBe(versionsBefore);
  expect(await countRows('answer_keys')).toBe(keysBefore);

  const questions = current.content.questions;
  expect(questions.length).toBeGreaterThanOrEqual(3);
  expect(questions.every((q) => q.skill === 'hoeren' && q.teil === 1)).toBe(true);
  expect(questions.map((q) => q.id)).toEqual(QUESTION_IDS);

  const sha256 = createHash('sha256').update(recording.bytes).digest('hex');
  const track = await trackOf(current.versionId);
  expect(track).toEqual({
    track_id: 'hoeren-teil-1',
    kind: 'file',
    object_path: `audio/${sha256}.wav`,
    content_type: 'audio/wav',
    sha256,
  });
  const bucket = await serviceDb.storage.getBucket(AUDIO_BUCKET);
  expect(bucket.data?.public).toBe(false);
  const stored = await serviceDb.storage.from(AUDIO_BUCKET).download(track.object_path);
  expect(stored.error).toBeNull();
  expect(stored.data?.size).toBe(recording.bytes.byteLength);

  const anon = createPublicClient();
  const leaked = await anon.storage.from(AUDIO_BUCKET).download(track.object_path);
  expect(leaked.data).toBeNull();
  expect(leaked.error).not.toBeNull();
  expect((await anon.storage.from(AUDIO_BUCKET).list('audio')).data ?? []).toEqual([]);
});

test('seed rejects short set with missing key', async () => {
  const { 'hoeren-3': _missing, ...keys } = TEST_PILOT_KEYS;
  const slug = 'test-missing-key-set';
  // Bytes no other test uploads, to see that nothing reached Storage.
  const bytes = new TextEncoder().encode(`missing-key-${Date.now()}`);
  const objectName = `${createHash('sha256').update(bytes).digest('hex')}.wav`;
  const versionsBefore = await countRows('exam_versions');
  const keysBefore = await countRows('answer_keys');

  await expect(
    publishExamVersion(serviceDb, {
      slug,
      title: 'Missing key',
      format: 'DTZ',
      content: PILOT_CONTENT,
      keys,
      audio: [{ trackId: 'hoeren-teil-1', contentType: 'audio/wav', bytes }],
    }),
  ).rejects.toThrow(/missing-key:hoeren-3/);

  expect(await countRows('exam_versions')).toBe(versionsBefore);
  expect(await countRows('answer_keys')).toBe(keysBefore);
  const { count } = await serviceDb
    .from('exams')
    .select('id', { count: 'exact', head: true })
    .eq('slug', slug);
  expect(count).toBe(0);
  const listed = await serviceDb.storage
    .from(AUDIO_BUCKET)
    .list('audio', { search: objectName });
  expect(listed.error).toBeNull();
  expect(listed.data?.map((object) => object.name)).not.toContain(objectName);
});
