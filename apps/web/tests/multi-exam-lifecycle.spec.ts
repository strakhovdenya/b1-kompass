import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import {
  getAttemptReview,
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  countVersionKeys,
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttemptPin,
  readAttempts,
  readEventKinds,
  readExamState,
  readOnlyResult,
  readResults,
  readRunRows,
  readSession,
  readStoredVersion,
  readSubmission,
  serviceDb,
  startFor,
  submitStored,
} from './support/db';
import type { StoredVersion } from './support/db';
import {
  FULL_PILOT,
  FULL_TIMING,
  ensureConfirmedTestProfile,
  fullKeyOf,
  fullWrongOf,
  publishNextFullVersion,
  publishUniqueFullExam,
  variantOf,
} from './support/full-exam';
import type { FullMaterial, PublishedFullExam } from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  FULL_ORIGIN,
  LIBRARY_URL,
  attemptLesenUrl,
  attemptUrl,
  card,
  expectStatus,
  goToLesen,
  optionIn,
  pausePlayer,
  playFrom,
  seekTo,
  postCommand,
  snapshotOf,
  waitForPlayer,
} from './support/guest-browser';
import { snapshotSql } from './support/legacy-attempt';
import { guestWrites, psqlJson, quote, sqlRunnerAs } from './support/sql';

// Two independent full DTZ exams of one guest (#84): exam A and exam B are
// published by every test under slugs of its own, so a later version of B
// touches no shared fixture. B/v1 is the synthetic full set; A and B/v2 are
// changed copies of it with a task and a marker only they have. Every claim is
// read back from the test database; expected ids, keys and scores come from
// the fixtures, never from the code under test.

const SECOND_MS = 1000;
const owner = sqlRunnerAs('owner');
const recordingA = createTestRecording(531);
const recordingB = createTestRecording(547);

// The task of the synthetic set that A and B/v2 replace by one of their own.
const REPLACED = 'lesen-25';
const A_ONLY = 'lesen-25-a';
const V2_ONLY = 'lesen-25-neu';
// The task whose key B/v2 moves to another option.
const REKEYED = 'hoeren-2';
const A_MARKER = '(Satz A)';
const V2_MARKER = '(B Version 2)';

const MATERIAL_A = variantOf(FULL_PILOT, {
  marker: A_MARKER,
  replace: { from: REPLACED, to: A_ONLY },
});
const MATERIAL_B2 = variantOf(FULL_PILOT, {
  marker: V2_MARKER,
  replace: { from: REPLACED, to: V2_ONLY },
  rekey: REKEYED,
});

const idsOf = (material: FullMaterial): string[] =>
  material.content.questions.map((question) => question.id);
const A_IDS = idsOf(MATERIAL_A);
const B1_IDS = idsOf(FULL_PILOT);
const B2_IDS = idsOf(MATERIAL_B2);
const HOEREN_COUNT = FULL_PILOT.content.questions.filter(
  (question) => question.skill === 'hoeren',
).length;

// Long enough to answer, leave for the other exam and come back after it.
const RETURN_TIMING: TimingSettings = {
  recordingSeconds: 60,
  hoerenSeconds: 12,
  transitionSeconds: 2,
  lesenSeconds: 12,
};

interface Exam extends PublishedFullExam {
  examId: string;
  versionId: string;
}

const publishExam = async (
  tag: string,
  label: 'a' | 'b',
  timing: TimingSettings | null = null,
): Promise<Exam> => {
  const published = await publishUniqueFullExam(
    serviceDb,
    label === 'a' ? recordingA : recordingB,
    `MX ${tag} ${label.toUpperCase()} Übungstest`,
    `test-mx-${tag}-${label}`,
    label === 'a' ? MATERIAL_A : FULL_PILOT,
  );
  const latest = await latestVersionOf(published.slug);
  if (!latest) throw new Error(`exam ${published.slug} is missing`);
  if (timing) ensureConfirmedTestProfile(owner, latest.versionId, timing);
  return { ...published, ...latest };
};

// Exam A and exam B of one test, each with one version.
const publishPair = async (timingA: TimingSettings | null = null) => {
  const tag = randomUUID().slice(0, 8);
  const examA = await publishExam(tag, 'a', timingA);
  const examB = await publishExam(tag, 'b');
  return { examA, examB };
};

const publishB2 = (examB: Exam): Promise<string> =>
  publishNextFullVersion(serviceDb, recordingB, examB, MATERIAL_B2);

const sessionOf = (guest: CreatedGuest): string => guest.guest.sessionId;

const started = async (
  guest: CreatedGuest,
  exam: Exam,
  overrides: Record<string, unknown> = {},
) => {
  const result = await startFor(depsNow(), guest.token, exam.slug, overrides);
  if (!result.ok || result.result.outcome !== 'accepted') {
    throw new Error(`start not accepted: ${JSON.stringify(result)}`);
  }
  return result.result;
};

const startedFree = async (guest: CreatedGuest, exam: Exam): Promise<string> =>
  (await started(guest, exam)).attemptId;

// A timed Hören block of the exam with its server deadline.
const startedTimed = async (guest: CreatedGuest, exam: Exam) => {
  const { attemptId, state } = await started(guest, exam, {
    mode: 'timed-block',
    selection: 'hoeren',
  });
  const { deadlineMs, startedAtMs } = state;
  if (deadlineMs === null) throw new Error('timed run has no deadline');
  return { attemptId, deadlineMs, startedAtMs };
};

const answered = async (
  guest: CreatedGuest,
  attemptId: string,
  questionId: string,
  optionId: string,
) => {
  const saved = await saveAnswer(depsNow(), guest.token, {
    attemptId,
    questionId,
    optionId,
    revision: 1,
  });
  if (!saved.ok) throw new Error(`answer ${questionId}: ${saved.error}`);
};

const completed = async (guest: CreatedGuest, attemptId: string) => {
  const done = await submitStored(depsNow(), guest.token, { attemptId });
  if (!done.ok) throw new Error(`complete: ${done.error}`);
  return done.review;
};

const reviewOf = async (guest: CreatedGuest, attemptId: string) => {
  const read = await getAttemptReview(depsNow(), guest.token, { attemptId });
  if (!read.ok) throw new Error(`review: ${read.error}`);
  return read.review;
};

const practiceOf = async (
  guest: CreatedGuest,
  exam: Exam,
  attemptId: string,
) => {
  const read = await readAttemptPage(
    depsNow(),
    guest.guest,
    exam.slug,
    attemptId,
  );
  if (read.status !== 'ready') throw new Error(`page is ${read.status}`);
  return read.practice;
};

type Stored = Record<string, unknown>;

interface AttemptSnapshot {
  attempt: Stored;
  run: Stored | null;
  answers: Stored[];
  result: Stored | null;
  events: string[];
}

// Every stored field of the attempts: attempt, run, answers, result, events.
const snapshotOfAttempts = (...ids: string[]) =>
  psqlJson<Record<string, AttemptSnapshot>>(snapshotSql(ids));

// The same without the place of the guest: an open page reports its place on
// its own, which is no change of the answers, the run or the result.
const settledOf = (...ids: string[]) =>
  Object.fromEntries(
    Object.entries(snapshotOfAttempts(...ids)).map(([id, stored]) => {
      const { progress, updated_at: updatedAt, ...attempt } = stored.attempt;
      void progress;
      void updatedAt;
      return [id, { ...stored, attempt }];
    }),
  );

const runRowOf = (attemptId: string) =>
  psqlJson<Stored>(`select to_jsonb(r) from public.attempt_runs r
    where r.attempt_id = ${quote(attemptId)}`);

const keyIn = (stored: StoredVersion, questionId: string) =>
  stored.keys.find((row) => row.question_id === questionId)?.correct_option_id;

const browserOf = async (
  browser: Browser,
  guest: CreatedGuest,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({ baseURL: FULL_ORIGIN });
  await context.addCookies([
    { name: GUEST_COOKIE, value: guest.token, url: FULL_ORIGIN },
  ]);
  return { context, page: await context.newPage() };
};

const shellOf = (page: Page) => page.getByTestId('training-shell');
const timerOf = (page: Page) => page.getByTestId('attempt-timer');
const cardOfExam = (page: Page, exam: Exam) =>
  page.getByTestId(`exam-card-${exam.slug}`);

const openLibrary = async (page: Page) => {
  await page.goto('/exams');
  await expect(page.getByTestId('exam-library')).toBeVisible();
};

// The way back of a free training: the link leaves at once.
const leaveToLibrary = async (page: Page) => {
  await page.getByTestId('exam-context-library').click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
};

// The way back of a running timed block: the warning, then the confirmation.
const leaveTimedToLibrary = async (page: Page) => {
  await page.getByTestId('exam-context-library').click();
  await expect(page.getByTestId('timed-leave-dialog')).toBeVisible();
  await page.getByTestId('timed-leave-confirm').click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId('exam-library')).toBeVisible();
};

const continueHrefOf = (page: Page, exam: Exam) =>
  cardOfExam(page, exam).getByTestId('exam-card-continue').getAttribute('href');

// "Continue" of the card of one exam opens the attempt of that exam.
const continueFromCard = async (page: Page, exam: Exam, attemptId: string) => {
  await cardOfExam(page, exam).getByTestId('exam-card-continue').click();
  await page.waitForURL(`**/practice/${exam.slug}/attempts/${attemptId}**`);
  await expect(shellOf(page)).toHaveAttribute('data-attempt-id', attemptId);
};

const answerOnPage = async (
  page: Page,
  questionId: string,
  optionId: string,
) => {
  await optionIn(card(page, questionId), optionId).check();
  await expectStatus(card(page, questionId), 'saved');
};

const positionOf = async (attemptId: string): Promise<number> =>
  Number((await readAttemptPin(attemptId)).progress?.positionSeconds ?? -1);

const POSITION_TOLERANCE = 1;
// The seconds the recordings of A and B are left at.
const REST_A = 12;
const REST_B = 31;

const expectStoredPosition = (attemptId: string, seconds: number) =>
  expect
    .poll(async () => Math.abs((await positionOf(attemptId)) - seconds))
    .toBeLessThanOrEqual(POSITION_TOLERANCE);

// Plays the recording, pauses it and moves the paused player to the given
// second: a seek of a paused player is reported at once, so the test waits
// for the server to hold that place before it leaves the page.
const restAt = async (
  page: Page,
  attemptId: string,
  seconds: number,
  marker: string,
) => {
  await waitForPlayer(page);
  await playFrom(page, 1, marker);
  await pausePlayer(page);
  await seekTo(page, seconds);
  await expectStoredPosition(attemptId, seconds);
};

const expectRestingAt = async (page: Page, seconds: number) => {
  await waitForPlayer(page);
  await expect
    .poll(async () => {
      const resting = await snapshotOf(page);
      return resting.paused ? Math.abs(resting.currentTime - seconds) : null;
    })
    .toBeLessThanOrEqual(POSITION_TOLERANCE);
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// The database and the test run on the same host; a small margin covers
// the rest.
const waitPast = (moment: number, marginMs = 400) =>
  sleep(moment - Date.now() + marginMs);

const answerPath = (attemptId: string) => `/api/attempts/${attemptId}/answer`;

const row = (questionId: string, optionId: string) => ({
  question_id: questionId,
  option_id: optionId,
  revision: 1,
});

test('two exams retain independent active attempts', async ({ browser }) => {
  const { examA, examB } = await publishPair();
  const guest = await newGuest(depsNow());
  const idA = await startedFree(guest, examA);
  const idB = await startedFree(guest, examB);
  expect(idA).not.toBe(idB);
  const writes = guestWrites(sessionOf(guest));
  expect(writes).toEqual({
    attempts: 2,
    runs: 2,
    commands: 2,
    starts: 2,
    results: 0,
  });

  const { context, page } = await browserOf(browser, guest);
  await openLibrary(page);

  // A: two Hören answers and a place in the recording of A.
  await continueFromCard(page, examA, idA);
  await answerOnPage(page, 'hoeren-1', fullKeyOf('hoeren-1'));
  await page.getByTestId('go-to-question-2').click();
  await answerOnPage(page, 'hoeren-2', fullWrongOf('hoeren-2'));
  await restAt(page, idA, REST_A, 'exam-a');
  await leaveToLibrary(page);
  await expectStoredPosition(idA, REST_A);

  // B: another Hören answer, another place, then a Lesen answer.
  await continueFromCard(page, examB, idB);
  await expect(card(page, 'hoeren-1').locator('input').first()).toBeVisible();
  await expect(card(page, 'hoeren-1').locator('input:checked')).toHaveCount(0);
  await page.getByTestId('go-to-question-3').click();
  await answerOnPage(page, 'hoeren-3', fullKeyOf('hoeren-3'));
  await restAt(page, idB, REST_B, 'exam-b');
  await goToLesen(page);
  await answerOnPage(page, 'lesen-1', fullWrongOf('lesen-1'));
  await leaveToLibrary(page);
  await expect
    .poll(async () => (await readAttemptPin(idB)).progress?.block)
    .toBe('lesen');
  await expectStoredPosition(idB, REST_B);

  // Each attempt holds its own exam, version, answers and place.
  const answersA = [
    row('hoeren-1', fullKeyOf('hoeren-1')),
    row('hoeren-2', fullWrongOf('hoeren-2')),
  ];
  const answersB = [
    row('hoeren-3', fullKeyOf('hoeren-3')),
    row('lesen-1', fullWrongOf('lesen-1')),
  ];
  expect(await readAnswerRows(idA)).toEqual(answersA);
  expect(await readAnswerRows(idB)).toEqual(answersB);
  expect(await readAttemptPin(idA)).toMatchObject({
    exam_id: examA.examId,
    exam_version_id: examA.versionId,
    status: 'active',
    scope: 'full-exam',
    progress: { block: 'hoeren', hoeren: { itemId: 'hoeren-2' } },
  });
  expect(await readAttemptPin(idB)).toMatchObject({
    exam_id: examB.examId,
    exam_version_id: examB.versionId,
    status: 'active',
    scope: 'full-exam',
    progress: { block: 'lesen', hoeren: { itemId: 'hoeren-3' } },
  });
  const [runA] = await readRunRows(idA);
  const [runB] = await readRunRows(idB);
  expect(runA?.assignment).toEqual({
    versionId: examA.versionId,
    questionIds: A_IDS,
  });
  expect(runB?.assignment).toEqual({
    versionId: examB.versionId,
    questionIds: B1_IDS,
  });

  // Both cards continue their own attempt in their own block.
  expect(await continueHrefOf(page, examA)).toBe(attemptUrl(examA.slug, idA));
  expect(await continueHrefOf(page, examB)).toBe(
    attemptLesenUrl(examB.slug, idB),
  );

  // Continuing A shows A and leaves B exactly as stored.
  const storedB = snapshotOfAttempts(idB);
  await continueFromCard(page, examA, idA);
  await expect(
    optionIn(card(page, 'hoeren-2'), fullWrongOf('hoeren-2')),
  ).toBeChecked();
  await expect(page.getByTestId('exam-context-title')).toHaveText(examA.title);
  await expectRestingAt(page, REST_A);
  await leaveToLibrary(page);
  expect(snapshotOfAttempts(idB)).toEqual(storedB);

  // Continuing B shows the Lesen of B and leaves the answers of A alone.
  const settledA = settledOf(idA);
  await continueFromCard(page, examB, idB);
  expect(new URL(page.url()).pathname).toBe(attemptLesenUrl(examB.slug, idB));
  await expect(
    optionIn(card(page, 'lesen-1'), fullWrongOf('lesen-1')),
  ).toBeChecked();
  await expect(page.getByTestId('exam-context-title')).toHaveText(examB.title);
  // Its Hören opens at the task and the second of B, without the answers
  // of A.
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL(`**${attemptUrl(examB.slug, idB)}`);
  await expect(
    optionIn(card(page, 'hoeren-3'), fullKeyOf('hoeren-3')),
  ).toBeChecked();
  await expectRestingAt(page, REST_B);
  await page.getByTestId('go-to-question-1').click();
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await expect(card(page, 'hoeren-1').locator('input:checked')).toHaveCount(0);
  await leaveToLibrary(page);
  expect(settledOf(idA)).toEqual(settledA);
  await expectStoredPosition(idA, REST_A);

  // Nothing was started, completed or answered by the way.
  expect(await readAnswerRows(idA)).toEqual(answersA);
  expect(await readAnswerRows(idB)).toEqual(answersB);
  expect(guestWrites(sessionOf(guest))).toEqual(writes);
  await context.close();
});

test('new version of B keeps pinned B v1 and A unchanged', async () => {
  const { examA, examB } = await publishPair();
  const v1 = examB.versionId;
  const guest = await newGuest(depsNow());

  // An active attempt of A, a completed attempt of B/v1 and an active one.
  const idA = await startedFree(guest, examA);
  await answered(guest, idA, 'hoeren-1', fullKeyOf('hoeren-1'));
  const doneB = await startedFree(guest, examB);
  await answered(guest, doneB, 'hoeren-1', fullKeyOf('hoeren-1'));
  await answered(guest, doneB, REKEYED, fullKeyOf(REKEYED));
  await answered(guest, doneB, 'lesen-1', fullWrongOf('lesen-1'));
  const reviewBefore = await completed(guest, doneB);
  expect(reviewBefore).toMatchObject({ score: 2, maxScore: 45 });
  const activeB = await startedFree(guest, examB);
  await answered(guest, activeB, REKEYED, fullKeyOf(REKEYED));
  await answered(guest, activeB, 'hoeren-3', fullKeyOf('hoeren-3'));

  const before = snapshotOfAttempts(idA, doneB, activeB);
  const storedV1 = await readStoredVersion(v1);
  const storedA = await readStoredVersion(examA.versionId);
  const resultBefore = await readOnlyResult<Stored>(doneB);

  const v2 = await publishB2(examB);
  expect(v2).not.toBe(v1);
  expect((await readExamState(examB.slug))?.versionIds).toEqual([v1, v2]);
  expect((await readExamState(examA.slug))?.versionIds).toEqual([
    examA.versionId,
  ]);

  // The publication wrote nothing into the attempts, B/v1, its key or A.
  expect(snapshotOfAttempts(idA, doneB, activeB)).toEqual(before);
  expect(await readStoredVersion(v1)).toEqual(storedV1);
  expect(await readStoredVersion(examA.versionId)).toEqual(storedA);
  expect(await countVersionKeys(v1)).toBe(45);
  const storedV2 = await readStoredVersion(v2);
  expect(keyIn(storedV1, REKEYED)).toBe(fullKeyOf(REKEYED));
  expect(keyIn(storedV2, REKEYED)).toBe(fullWrongOf(REKEYED));
  expect(keyIn(storedV2, V2_ONLY)).toBe(fullKeyOf(REPLACED));
  expect(keyIn(storedV1, V2_ONLY)).toBeUndefined();

  // The completed attempt keeps its version, result and review.
  expect((await readAttemptPin(doneB)).exam_version_id).toBe(v1);
  expect(await readOnlyResult<Stored>(doneB)).toEqual(resultBefore);
  expect(await reviewOf(guest, doneB)).toEqual(reviewBefore);

  // The active attempt goes on with the material of v1 only.
  const practice = await practiceOf(guest, examB, activeB);
  expect(practice.versionId).toBe(v1);
  expect(practice.questions.map((item) => item.id)).toEqual(B1_IDS);
  expect(JSON.stringify(practice)).not.toContain(V2_MARKER);
  expect(
    await saveAnswer(depsNow(), guest.token, {
      attemptId: activeB,
      questionId: V2_ONLY,
      optionId: fullKeyOf(REPLACED),
      revision: 1,
    }),
  ).toEqual({ ok: false, error: 'option-not-allowed' });
  await answered(guest, activeB, REPLACED, fullKeyOf(REPLACED));

  // The slot of B is still held by the attempt of v1: no start on v2 yet.
  expect(await startFor(depsNow(), guest.token, examB.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: activeB },
  });
  expect((await readAttemptPin(activeB)).exam_version_id).toBe(v1);

  // It is graded by the key of v1: the answer v2 calls wrong still counts.
  const reviewActive = await completed(guest, activeB);
  expect(reviewActive).toMatchObject({
    scope: 'full-exam',
    score: 3,
    maxScore: 45,
  });
  expect(reviewActive.items.map((item) => item.questionId)).toEqual(B1_IDS);
  expect(await readOnlyResult<Stored>(activeB)).toMatchObject({
    score: 3,
    max_score: 45,
  });
  expect(await readAttemptPin(activeB)).toMatchObject({
    exam_version_id: v1,
    status: 'completed',
  });
  const [runActive] = await readRunRows(activeB);
  expect(runActive?.assignment).toEqual({ versionId: v1, questionIds: B1_IDS });

  // A new start of B runs on v2, with its tasks and its key: the same three
  // choices are worth two points there.
  const newB = await startedFree(guest, examB);
  expect(await readAttemptPin(newB)).toMatchObject({
    exam_id: examB.examId,
    exam_version_id: v2,
    status: 'active',
  });
  const [runNew] = await readRunRows(newB);
  expect(runNew?.assignment).toEqual({ versionId: v2, questionIds: B2_IDS });
  const fresh = await practiceOf(guest, examB, newB);
  expect(fresh.versionId).toBe(v2);
  expect(JSON.stringify(fresh)).toContain(V2_MARKER);
  expect(
    await saveAnswer(depsNow(), guest.token, {
      attemptId: newB,
      questionId: REPLACED,
      optionId: fullKeyOf(REPLACED),
      revision: 1,
    }),
  ).toEqual({ ok: false, error: 'option-not-allowed' });
  await answered(guest, newB, REKEYED, fullKeyOf(REKEYED));
  await answered(guest, newB, 'hoeren-3', fullKeyOf('hoeren-3'));
  await answered(guest, newB, V2_ONLY, fullKeyOf(REPLACED));
  expect(await completed(guest, newB)).toMatchObject({
    scope: 'full-exam',
    score: 2,
    maxScore: 45,
  });
  expect(await readOnlyResult<Stored>(newB)).toMatchObject({
    score: 2,
    max_score: 45,
  });

  // The older results and A are as they were before the publication.
  expect(await readOnlyResult<Stored>(doneB)).toEqual(resultBefore);
  expect(await reviewOf(guest, doneB)).toEqual(reviewBefore);
  const after = snapshotOfAttempts(idA, doneB);
  expect(after[idA]).toEqual(before[idA]);
  expect(after[doneB]).toEqual(before[doneB]);
  expect(await readAttemptPin(idA)).toMatchObject({
    exam_id: examA.examId,
    exam_version_id: examA.versionId,
    status: 'active',
  });
  expect(guestWrites(sessionOf(guest))).toMatchObject({
    attempts: 4,
    runs: 4,
    starts: 4,
    results: 3,
  });
});

test('cross exam navigation preserves absolute server deadlines', async ({
  browser,
}) => {
  const { examA, examB } = await publishPair(FULL_TIMING);
  const guest = await newGuest(depsNow());
  const idB = await startedFree(guest, examB);
  const timed = await startedTimed(guest, examA);
  const idA = timed.attemptId;
  const { deadlineMs, startedAtMs } = timed;
  expect(deadlineMs - startedAtMs).toBe(FULL_TIMING.hoerenSeconds * SECOND_MS);

  const runBefore = runRowOf(idA);
  expect(Date.parse(String(runBefore.accepted_at))).toBe(startedAtMs);
  const settledBefore = settledOf(idA, idB);
  const writes = guestWrites(sessionOf(guest));
  const session = await readSession(sessionOf(guest));
  expect(session.locale).toBe('en');

  // The clock of the page shows the deadline and the remaining time of the
  // server; returns the remaining milliseconds it shows and the moment of
  // that reading.
  const expectServerClock = async (page: Page) => {
    await expect(timerOf(page)).toHaveAttribute(
      'data-deadline-ms',
      String(deadlineMs),
    );
    const shown = Number(await timerOf(page).getAttribute('data-remaining-ms'));
    const atMs = Date.now();
    expect(Math.abs(shown - (deadlineMs - atMs))).toBeLessThan(5 * SECOND_MS);
    return { shown, atMs };
  };

  const { context, page } = await browserOf(browser, guest);
  await page.goto(attemptUrl(examA.slug, idA));
  await expect(timerOf(page)).toBeVisible();
  const first = await expectServerClock(page);

  // Out of the timed block of A through the warning, into the library.
  await leaveTimedToLibrary(page);
  expect(runRowOf(idA)).toEqual(runBefore);

  // B is opened, and the language is switched there.
  await continueFromCard(page, examB, idB);
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await expect(timerOf(page)).toHaveCount(0);
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect
    .poll(async () => (await readSession(sessionOf(guest))).locale)
    .toBe('ru');
  await expect(shellOf(page)).toHaveAttribute('data-attempt-id', idB);
  await leaveToLibrary(page);
  expect(runRowOf(idA)).toEqual(runBefore);

  // Back in A: the same deadline, the remaining time by the server clock.
  await sleep(SECOND_MS);
  await continueFromCard(page, examA, idA);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(timerOf(page)).toBeVisible();
  const back = await expectServerClock(page);
  // The clock lost exactly the time that passed while the guest was away:
  // it neither stopped nor started again.
  const awayMs = back.atMs - first.atMs;
  expect(awayMs).toBeGreaterThan(SECOND_MS);
  expect(Math.abs(first.shown - back.shown - awayMs)).toBeLessThan(
    2 * SECOND_MS,
  );
  const status = await readAttemptStatus(depsNow(), guest.token, {
    attemptId: idA,
  });
  if (!status.ok || status.result.outcome !== 'active') {
    throw new Error(`status: ${JSON.stringify(status)}`);
  }
  expect(status.result.state.deadlineMs).toBe(deadlineMs);
  expect(status.result.state.startedAtMs).toBe(startedAtMs);

  // The run of A, both attempts, the term of the guest: nothing moved.
  expect(runRowOf(idA)).toEqual(runBefore);
  expect(settledOf(idA, idB)).toEqual(settledBefore);
  expect(guestWrites(sessionOf(guest))).toEqual(writes);
  expect(await readAttempts(sessionOf(guest))).toHaveLength(2);
  const sessionAfter = await readSession(sessionOf(guest));
  expect(sessionAfter.expires_at).toBe(session.expires_at);
  expect(sessionAfter.created_at).toBe(session.created_at);
  await context.close();
});

test('return after deadline from other exam keeps phase gates', async ({
  browser,
  request,
}) => {
  const { examA, examB } = await publishPair(RETURN_TIMING);
  const guest = await newGuest(depsNow());
  const idB = await startedFree(guest, examB);
  const timed = await startedTimed(guest, examA);
  const idA = timed.attemptId;
  const { deadlineMs, startedAtMs } = timed;
  expect(deadlineMs - startedAtMs).toBe(
    RETURN_TIMING.hoerenSeconds * SECOND_MS,
  );
  const key = fullKeyOf('hoeren-1');
  const post = (body: unknown) =>
    postCommand(request, answerPath(idA), body, { token: guest.token });

  // An answer of A reaches the server before the deadline.
  const early = await post({
    questionId: 'hoeren-1',
    optionId: key,
    revision: 1,
  });
  expect(early.status).toBe(200);
  expect(early.body).toMatchObject({ ok: true, revision: 1 });
  expect(Date.now()).toBeLessThan(deadlineMs);

  // The guest leaves the running block for B and answers there.
  const { context, page } = await browserOf(browser, guest);
  await page.goto(attemptUrl(examA.slug, idA));
  await expect(timerOf(page)).toHaveAttribute(
    'data-deadline-ms',
    String(deadlineMs),
  );
  await leaveTimedToLibrary(page);
  await continueFromCard(page, examB, idB);
  await answerOnPage(page, 'hoeren-1', fullWrongOf('hoeren-1'));
  const settledB = settledOf(idB);
  expect(Date.now()).toBeLessThan(deadlineMs);
  expect((await readAttemptPin(idA)).status).toBe('active');

  // The deadline of A passes while the guest is in B. Nothing has closed the
  // run yet: a late answer meets the deadline itself and is refused.
  await waitPast(deadlineMs);
  expect((await readAttemptPin(idA)).status).toBe('active');
  const gated = await post({
    questionId: 'hoeren-3',
    optionId: fullKeyOf('hoeren-3'),
    revision: 1,
  });
  expect(gated.status).toBe(404);
  expect(gated.body).toEqual({ ok: false, error: 'attempt-not-found' });
  expect(await readAnswerRows(idA)).toEqual([row('hoeren-1', key)]);

  // Then the guest returns to A.
  await leaveToLibrary(page);
  await page.goto(attemptUrl(examA.slug, idA));
  await expect(shellOf(page)).toHaveAttribute('data-attempt-id', idA);
  await expect
    .poll(async () => (await readAttemptPin(idA)).status)
    .not.toBe('active');
  await expect(timerOf(page)).toHaveCount(0);

  // Late writes of A are refused: a new answer and a change of the old one.
  const lateWrites = [
    { questionId: 'hoeren-2', optionId: fullKeyOf('hoeren-2'), revision: 1 },
    { questionId: 'hoeren-1', optionId: fullWrongOf('hoeren-1'), revision: 2 },
  ];
  for (const body of lateWrites) {
    const late = await post(body);
    expect(late.status).toBe(404);
    expect(late.body).toEqual({ ok: false, error: 'attempt-not-found' });
  }

  // The same gate as with one exam: the answer accepted in time is frozen at
  // the deadline and alone counts.
  expect(
    await readAttemptStatus(depsNow(), guest.token, { attemptId: idA }),
  ).toMatchObject({
    ok: true,
    result: {
      outcome: 'result-ready',
      isClosedByDeadline: true,
      answers: { 'hoeren-1': key },
    },
  });
  expect(await readAnswerRows(idA)).toEqual([row('hoeren-1', key)]);
  const submission = await readSubmission(idA);
  expect(submission.frozen_answers).toEqual({
    'hoeren-1': { optionId: key, revision: 1 },
  });
  expect(submission.submit_command_id).toBeNull();
  expect(Date.parse(submission.submission_accepted_at ?? '')).toBe(deadlineMs);
  const results = (await readResults(idA)) as Stored[];
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    score: 1,
    max_score: HOEREN_COUNT,
    skipped_count: HOEREN_COUNT - 1,
  });
  expect(await readEventKinds(idA)).toEqual(['start', 'finish']);
  expect(await readAttemptPin(idA)).toMatchObject({
    status: 'completed',
    exam_version_id: examA.versionId,
  });

  // Opened again, the attempt shows its review and no way to finish it.
  await page.reload();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('finish-attempt')).toHaveCount(0);

  // B is untouched by the deadline of A and still takes answers.
  expect(settledOf(idB)).toEqual(settledB);
  expect(await readEventKinds(idB)).toEqual(['start']);
  await answered(guest, idB, 'lesen-1', fullKeyOf('lesen-1'));
  expect(await readAnswerRows(idB)).toEqual([
    row('hoeren-1', fullWrongOf('hoeren-1')),
    row('lesen-1', fullKeyOf('lesen-1')),
  ]);
  expect(guestWrites(sessionOf(guest))).toEqual({
    attempts: 2,
    runs: 2,
    commands: 2,
    starts: 2,
    results: 1,
  });
  await context.close();
});

test('cross exam answer injection is refused without writes', async ({
  request,
}) => {
  const { examA, examB } = await publishPair();
  const guest = await newGuest(depsNow());
  const idA = await startedFree(guest, examA);
  const idB = await startedFree(guest, examB);
  await answered(guest, idA, 'hoeren-1', fullKeyOf('hoeren-1'));
  await answered(guest, idB, 'hoeren-1', fullWrongOf('hoeren-1'));
  const before = snapshotOfAttempts(idA, idB);
  const writes = guestWrites(sessionOf(guest));
  const post = (attemptId: string, body: unknown) =>
    postCommand(request, answerPath(attemptId), body, { token: guest.token });

  // The tasks only one of the exams has are real tasks of that exam.
  expect(A_IDS).toContain(A_ONLY);
  expect(B1_IDS).not.toContain(A_ONLY);
  expect(B1_IDS).toContain(REPLACED);
  expect(A_IDS).not.toContain(REPLACED);
  const foreign = { optionId: fullKeyOf(REPLACED), revision: 1 };
  const shared = {
    questionId: 'hoeren-2',
    optionId: fullKeyOf('hoeren-2'),
    revision: 1,
  };

  // A task of A sent into the attempt of B, and a task of B into A.
  const intoB = await post(idB, { questionId: A_ONLY, ...foreign });
  expect(intoB.status).toBe(422);
  expect(intoB.body).toEqual({ ok: false, error: 'option-not-allowed' });
  const intoA = await post(idA, { questionId: REPLACED, ...foreign });
  expect(intoA.status).toBe(422);
  expect(intoA.body).toEqual({ ok: false, error: 'option-not-allowed' });

  // The attempt of A named under the slug of B: the command takes neither a
  // slug nor another attempt than the one of its address.
  const underSlug = await post(idA, { ...shared, examSlug: examB.slug });
  expect(underSlug.status).toBe(400);
  expect(underSlug.body).toEqual({ ok: false, error: 'invalid-input' });
  const renamed = await post(idB, { ...shared, attemptId: idA });
  expect(renamed.status).toBe(400);
  expect(renamed.body).toEqual({ ok: false, error: 'invalid-input' });

  // The pages of an attempt under the slug of the other exam do not exist.
  const crossed = [
    attemptUrl(examB.slug, idA),
    attemptLesenUrl(examB.slug, idA),
    attemptUrl(examA.slug, idB),
    attemptLesenUrl(examA.slug, idB),
  ];
  for (const pathname of crossed) {
    const response = await request.get(`${FULL_ORIGIN}${pathname}`, {
      headers: { cookie: `${GUEST_COOKIE}=${guest.token}` },
      maxRedirects: 0,
    });
    expect(response.status(), pathname).toBe(404);
    const html = await response.text();
    expect(html).not.toContain('question-card-');
    expect(html).not.toContain(A_MARKER);
  }
  expect(
    (await readAttemptPage(depsNow(), guest.guest, examB.slug, idA)).status,
  ).toBe('not-found');
  expect(
    (await readAttemptPage(depsNow(), guest.guest, examA.slug, idB)).status,
  ).toBe('not-found');

  // Nothing was written for either attempt.
  expect(snapshotOfAttempts(idA, idB)).toEqual(before);
  expect(guestWrites(sessionOf(guest))).toEqual(writes);

  // The control: a task of its own exam is written, into that attempt only.
  const own = await post(idB, { questionId: REPLACED, ...foreign });
  expect(own.status).toBe(200);
  expect(own.body).toMatchObject({ ok: true, questionId: REPLACED });
  expect(await readAnswerRows(idB)).toEqual([
    row('hoeren-1', fullWrongOf('hoeren-1')),
    row(REPLACED, fullKeyOf(REPLACED)),
  ]);
  expect(snapshotOfAttempts(idA)[idA]).toEqual(before[idA]);
});

test('old review never shows material of new version', async ({ browser }) => {
  const { examB } = await publishPair();
  const v1 = examB.versionId;
  const guest = await newGuest(depsNow());
  const doneB = await startedFree(guest, examB);
  await answered(guest, doneB, 'hoeren-1', fullKeyOf('hoeren-1'));
  await answered(guest, doneB, REKEYED, fullKeyOf(REKEYED));
  await answered(guest, doneB, REPLACED, fullWrongOf(REPLACED));
  const reviewBefore = await completed(guest, doneB);
  expect(reviewBefore).toMatchObject({ score: 2, maxScore: 45 });
  const before = snapshotOfAttempts(doneB);

  const v2 = await publishB2(examB);
  expect((await latestVersionOf(examB.slug))?.versionId).toBe(v2);

  // The stored attempt is still the one of v1.
  expect(snapshotOfAttempts(doneB)).toEqual(before);
  expect((await readAttemptPin(doneB)).exam_version_id).toBe(v1);
  const [run] = await readRunRows(doneB);
  expect(run?.assignment).toEqual({ versionId: v1, questionIds: B1_IDS });

  // The review of the server holds the tasks of v1 and nothing of v2.
  const review = await reviewOf(guest, doneB);
  expect(review).toEqual(reviewBefore);
  expect(review.items.map((item) => item.questionId)).toEqual(B1_IDS);
  expect(B1_IDS).not.toContain(V2_ONLY);
  expect(JSON.stringify(review)).not.toContain(V2_MARKER);

  // The review in the browser, at both addresses of the attempt.
  const { context, page } = await browserOf(browser, guest);
  // Each address lists the tasks of its own block.
  const oldPages = [
    { url: attemptUrl(examB.slug, doneB), count: HOEREN_COUNT },
    {
      url: attemptLesenUrl(examB.slug, doneB),
      count: B1_IDS.length - HOEREN_COUNT,
    },
  ];
  for (const { url, count } of oldPages) {
    await page.goto(url);
    await expect(page.getByTestId('attempt-review')).toBeVisible();
    await expect(page.getByTestId('review-item')).toHaveCount(count);
    const html = await page.content();
    expect(html).not.toContain(V2_MARKER);
    expect(html).not.toContain(V2_ONLY);
  }

  // The control: a new attempt of the same guest does show v2, so the marker
  // and the new task would have been visible above.
  const newB = await startedFree(guest, examB);
  expect((await readAttemptPin(newB)).exam_version_id).toBe(v2);
  await page.goto(attemptUrl(examB.slug, newB));
  await expect(card(page, 'hoeren-1')).toContainText(V2_MARKER);
  await page.goto(attemptLesenUrl(examB.slug, newB));
  await expect(page.getByTestId('reading-text')).toBeVisible();
  expect(await page.content()).toContain(V2_ONLY);

  // Opening the old review after that changed nothing in it.
  await page.goto(attemptUrl(examB.slug, doneB));
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(await page.content()).not.toContain(V2_MARKER);
  expect(snapshotOfAttempts(doneB)).toEqual(before);
  await context.close();
});
