import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  Page,
  Request,
} from '@playwright/test';
import {
  cancelAttempt,
  readAttemptStatus,
  saveAnswer,
  saveProgress,
  submitAttempt,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { hashGuestToken } from '../src/server/guest-session/session';
import {
  createPublicClient,
  depsNow,
  insertRawVersion,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAnswers,
  readCommandRows,
  readEventKinds,
  readProgress,
  readResults,
  readSubmission,
  serviceDb,
  startFor,
  submitStored,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import {
  ANSWER_URL,
  HOEREN_URL,
  PROGRESS_URL,
  activeAttemptOf,
  attemptUrl,
  card,
  enterAndStart,
  expectStatus,
  optionIn,
} from './support/guest-browser';
import { snapshotSql } from './support/legacy-attempt';
import {
  holdAttemptLock,
  installM2Fixtures,
  psql,
  psqlJson,
  quote,
  waitersBehind,
} from './support/sql';

// The final submission of M2: one independent POST accepts the final answers,
// pending choices included, freezes them with the moment and the command and
// frees the slot; the result is computed afterwards and checked by the
// database against the frozen snapshot. A cancel closes without a result.
// Every check re-reads the test database.

const FULL_ORIGIN = 'http://localhost:3102';
const { questions } = FULL_PILOT.content;
const ALL_IDS = questions.map((question) => question.id);
const HOEREN_IDS = questions
  .filter((question) => question.skill === 'hoeren')
  .map((question) => question.id);
const TOTAL = ALL_IDS.length;

test.beforeAll(() => {
  installM2Fixtures();
});

interface Guest {
  token: string;
  sessionId: string;
  attemptId: string;
}

const startedGuest = async (): Promise<Guest> => {
  const created = await newGuest(depsNow());
  const started = await startFor(depsNow(), created.token, FULL_EXAM.slug);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error(`start failed: ${JSON.stringify(started)}`);
  }
  return {
    token: created.token,
    sessionId: created.guest.sessionId,
    attemptId: started.result.attemptId,
  };
};

// A training of the Hören tasks only of the full version, created by the
// trusted test start under the same slot lock and kernel as production.
// The public start does not offer single skills before #41.
const subsetGuest = async (): Promise<Guest> => {
  const created = await newGuest(depsNow());
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is missing');
  const row = psqlJson<{ attempt_id: string; outcome: string }>(
    `select row_to_json(s) from m2_test.start_attempt_at(
      ${quote(created.guest.sessionId)}, ${quote(latest.examId)},
      gen_random_uuid(), 'training', 'normal', 'hoeren', null,
      ${quote(latest.versionId)}, 'short-set',
      ${quote(JSON.stringify(HOEREN_IDS))}::jsonb, clock_timestamp()) s`,
  );
  expect(row.outcome).toBe('accepted');
  return {
    token: created.token,
    sessionId: created.guest.sessionId,
    attemptId: row.attempt_id,
  };
};

const save = (
  guest: Guest,
  questionId: string,
  optionId: string,
  revision: number,
) =>
  saveAnswer(depsNow(), guest.token, {
    attemptId: guest.attemptId,
    questionId,
    optionId,
    revision,
  });

interface Answer {
  questionId: string;
  optionId: string;
  revision: number;
}

const submitBody = (
  answers: readonly Answer[],
  skipped: number,
  commandId: string = randomUUID(),
) => ({ commandId, answers, confirmation: { phaseRevision: 0, skipped } });

const submit = (guest: Guest, body: object) =>
  submitAttempt(depsNow(), guest.token, {
    attemptId: guest.attemptId,
    ...body,
  });

const cancel = (guest: Guest, skipped: number, commandId = randomUUID()) =>
  cancelAttempt(depsNow(), guest.token, {
    attemptId: guest.attemptId,
    commandId,
    confirmation: { phaseRevision: 0, skipped },
  });

const statusOf = async (guest: Guest) => {
  const status = await readAttemptStatus(depsNow(), guest.token, {
    attemptId: guest.attemptId,
  });
  if (!status.ok) throw new Error(`status failed: ${status.failure}`);
  return status.result;
};

// The real acceptance without the finalize that follows it in the server:
// the state after an interruption between the two steps.
const acceptOnly = async (
  guest: Guest,
  answers: readonly Answer[],
  skipped: number,
  commandId: string = randomUUID(),
) => {
  const { data, error } = await serviceDb
    .rpc('m2_accept_submission', {
      p_session_id: guest.sessionId,
      p_attempt_id: guest.attemptId,
      p_command_id: commandId,
      p_answers: answers,
      p_expected_phase_revision: 0,
      p_expected_skipped: skipped,
    })
    .single<{ outcome: string; attempt_status: string }>();
  if (error) throw error;
  return data;
};

const statusRow = (attemptId: string): string =>
  psql(`select status from public.attempts where id = ${quote(attemptId)}`);

// Every stored field of the attempt (row, run, answers, result, events) and
// the commands of its session.
const stateOf = (guest: Guest) => ({
  attempt: psqlJson<unknown>(snapshotSql([guest.attemptId])),
  commands: psqlJson<unknown>(`select coalesce(jsonb_agg(to_jsonb(c)
    order by c.command_id), '[]') from public.attempt_commands c
    where c.guest_session_id = ${quote(guest.sessionId)}`),
});

const http = (
  request: APIRequestContext,
  guest: { token: string } | null,
  attemptId: string,
  command: string,
  body: unknown,
  headers: Record<string, string> = { origin: FULL_ORIGIN },
) =>
  request.post(`${FULL_ORIGIN}/api/attempts/${attemptId}/${command}`, {
    headers: {
      'content-type': 'application/json',
      ...(guest ? { cookie: `${GUEST_COOKIE}=${guest.token}` } : {}),
      ...headers,
    },
    data: typeof body === 'string' ? body : JSON.stringify(body),
    maxRedirects: 0,
  });

const signal = () => {
  let resolve = () => undefined as void;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { done, resolve: () => resolve() };
};

const isSubmit = (request: Request): boolean =>
  request.method() === 'POST' && request.url().endsWith('/submit');

const browserGuest = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
};

const finishInBrowser = async (page: Page) => {
  await page.getByTestId('finish-attempt').click();
  await page.getByTestId('finish-confirm').click();
};

// The submission ------------------------------------------------------------------

test('submission bypasses delayed autosave and freezes pending choice', async ({
  browser,
}) => {
  const { context, page } = await browserGuest(browser);
  await enterAndStart(page);
  const { attemptId, token } = await activeAttemptOf(context);

  // The autosave is held before it reaches the server, so before SQL.
  const arrived = signal();
  const release = signal();
  await context.route(ANSWER_URL, async (route) => {
    arrived.resolve();
    await release.done;
    await route.continue();
  });
  const target = card(page, 'hoeren-1');
  await optionIn(target, 'a').check();
  await arrived.done;
  await expectStatus(target, 'saving');

  const sent = page.waitForRequest(isSubmit);
  await page.getByTestId('finish-attempt').click();
  const confirmation = page.getByTestId('finish-confirmation');
  await expect(confirmation).toHaveAttribute('data-skipped', String(TOTAL - 1));
  await page.getByTestId('finish-confirm').click();
  await sent;
  await expect(page.getByTestId('attempt-review')).toBeVisible();

  // Accepted and frozen while the save is still on hold.
  expect(await readAnswerRows(attemptId)).toEqual([
    { question_id: 'hoeren-1', option_id: 'a', revision: 1 },
  ]);
  const run = await readSubmission(attemptId);
  expect(run.frozen_answers).toEqual({
    'hoeren-1': { optionId: 'a', revision: 1 },
  });
  expect(run.submission_accepted_at).not.toBeNull();
  expect(statusRow(attemptId)).toBe('completed');
  expect(await readResults(attemptId)).toHaveLength(1);
  const before = psqlJson<unknown>(snapshotSql([attemptId]));

  // The held save arrives late and is refused; so is any new change.
  const late = page.waitForResponse((response) =>
    response.url().endsWith('/answer'),
  );
  release.resolve();
  const lateResponse = await late;
  expect(lateResponse.status()).toBe(404);
  expect(await lateResponse.json()).toEqual({
    ok: false,
    error: 'attempt-not-found',
  });
  const changed = await saveAnswer(depsNow(), token, {
    attemptId,
    questionId: 'hoeren-1',
    optionId: 'c',
    revision: 5,
  });
  expect(changed).toEqual({ ok: false, error: 'attempt-not-found' });
  expect(psqlJson<unknown>(snapshotSql([attemptId]))).toEqual(before);
  await context.close();
});

test('submission bypasses held progress request and preserves pending choice', async ({
  browser,
}) => {
  const { context, page } = await browserGuest(browser);
  const progressArrived = signal();
  const releaseProgress = signal();
  const answerArrived = signal();
  const releaseAnswer = signal();
  let heldProgress = 0;
  await context.route(PROGRESS_URL, async (route) => {
    heldProgress++;
    progressArrived.resolve();
    await releaseProgress.done;
    await route.continue();
  });
  await enterAndStart(page);
  const { attemptId } = await activeAttemptOf(context);
  await page.getByTestId('go-to-question-2').click();
  await progressArrived.done;

  await context.route(ANSWER_URL, async (route) => {
    answerArrived.resolve();
    await releaseAnswer.done;
    await route.continue();
  });
  const target = card(page, 'hoeren-2');
  await optionIn(target, 'b').check();
  await answerArrived.done;

  const sent = page.waitForRequest(isSubmit);
  await finishInBrowser(page);
  await sent;
  await expect(page.getByTestId('attempt-review')).toBeVisible();

  // The progress request is still held: the submission went before it and
  // took the pending choice.
  expect(heldProgress).toBeGreaterThan(0);
  expect(await readProgress(attemptId)).toBeNull();
  expect((await readSubmission(attemptId)).frozen_answers).toEqual({
    'hoeren-2': { optionId: 'b', revision: 1 },
  });
  const results = await readResults(attemptId);
  expect(results).toHaveLength(1);

  const lateProgress = page.waitForResponse((response) =>
    response.url().endsWith('/progress'),
  );
  releaseProgress.resolve();
  releaseAnswer.resolve();
  expect((await lateProgress).status()).toBe(404);
  expect(await readProgress(attemptId)).toBeNull();
  expect(await readResults(attemptId)).toEqual(results);
  await context.close();
});

test('submission hook drives real accepted pending and completed browser flow', async ({
  browser,
}) => {
  // A version whose key misses one task: the submission is accepted, its
  // result cannot be computed until the key is complete.
  const slug = `test-submit-pending-${randomUUID().slice(0, 8)}`;
  const { 'lesen-7': missing, ...partialKeys } = FULL_PILOT.keys;
  if (!missing) throw new Error('lesen-7 has no key');
  const versionId = await insertRawVersion({
    slug,
    content: FULL_PILOT.content,
    keys: partialKeys,
  });
  const created = await newGuest(depsNow());
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: created.token, url: FULL_ORIGIN },
  ]);
  const page = await context.newPage();
  await page.goto(`/practice/${slug}`);
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  const { attemptId } = await activeAttemptOf(context);

  // A saved choice and one whose save fails: both go into the final set.
  const saved = card(page, 'hoeren-1');
  await optionIn(saved, fullKeyOf('hoeren-1')).check();
  await expectStatus(saved, 'saved');
  await context.route(ANSWER_URL, (route) => route.abort());
  await page.getByTestId('go-to-question-2').click();
  const failed = card(page, 'hoeren-2');
  await optionIn(failed, fullWrongOf('hoeren-2')).check();
  await expectStatus(failed, 'error');

  await page.getByTestId('finish-attempt').click();
  await expect(page.getByTestId('finish-confirmation')).toHaveAttribute(
    'data-skipped',
    String(TOTAL - 2),
  );
  await page.getByTestId('finish-confirm').click();
  const accepted = page.getByTestId('submission-accepted');
  await expect(accepted).toHaveAttribute('data-phase', 'accepted');
  await expect(page.getByTestId('finish-attempt')).toHaveCount(0);
  expect(statusRow(attemptId)).toBe('submitted');
  expect(await readResults(attemptId)).toEqual([]);
  const frozen = (await readSubmission(attemptId)).frozen_answers;
  expect(frozen).toEqual({
    'hoeren-1': { optionId: fullKeyOf('hoeren-1'), revision: 1 },
    'hoeren-2': { optionId: fullWrongOf('hoeren-2'), revision: 1 },
  });

  // Still pending: the check says so and nothing changes.
  await page.getByTestId('result-check').click();
  await expect(page.getByTestId('result-pending')).toBeVisible();
  expect(statusRow(attemptId)).toBe('submitted');

  // With the key complete, the same check completes the same snapshot.
  const fixed = await serviceDb.from('answer_keys').insert({
    exam_version_id: versionId,
    question_id: 'lesen-7',
    correct_option_id: missing,
  });
  expect(fixed.error).toBeNull();
  await page.getByTestId('result-check').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(statusRow(attemptId)).toBe('completed');
  const results = await readResults(attemptId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ correct_count: 1, incorrect_count: 1 });
  expect((await readSubmission(attemptId)).frozen_answers).toEqual(frozen);
  expect(await readEventKinds(attemptId)).toEqual(['start', 'finish']);
  await context.close();
});

test('submission controls cannot reopen accepted state or reuse stale confirmation', async ({
  browser,
}) => {
  const { context, page } = await browserGuest(browser);
  await enterAndStart(page);
  const guestAttempt = await activeAttemptOf(context);
  const { attemptId } = guestAttempt;
  let submits = 0;
  page.on('request', (request) => {
    if (isSubmit(request)) submits++;
  });
  const first = card(page, 'hoeren-1');
  await optionIn(first, 'b').check();
  await expectStatus(first, 'saved');

  await page.getByTestId('finish-attempt').click();
  const confirmation = page.getByTestId('finish-confirmation');
  await expect(confirmation).toHaveAttribute('data-skipped', String(TOTAL - 1));

  // A new choice while confirming: the old confirmation is not sent.
  await page.getByTestId('go-to-question-2').click();
  await optionIn(card(page, 'hoeren-2'), 'b').check();
  await expectStatus(card(page, 'hoeren-2'), 'saved');
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('finish-renewed')).toBeVisible();
  await expect(confirmation).toHaveAttribute('data-skipped', String(TOTAL - 2));
  expect(submits).toBe(0);

  // Another tab answers one more task: the server refuses the confirmation,
  // reports its answers and a new confirmation is asked for.
  const other = await context.newPage();
  await other.goto(attemptUrl(FULL_EXAM.slug, attemptId));
  await other.getByTestId('go-to-question-3').click();
  await optionIn(card(other, 'hoeren-3'), 'b').check();
  await expectStatus(card(other, 'hoeren-3'), 'saved');
  await page.getByTestId('finish-confirm').click();
  await expect(confirmation).toHaveAttribute('data-skipped', String(TOTAL - 3));
  await expect(page.getByTestId('finish-renewed')).toBeVisible();
  expect(submits).toBe(1);
  expect(statusRow(attemptId)).toBe('active');
  expect(
    (await readCommandRows(guestAttempt.sessionId)).map((row) => row.kind),
  ).toEqual(['start']);

  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(submits).toBe(2);
  expect(statusRow(attemptId)).toBe('completed');

  // The other tab cannot reopen it: its submit finds the closed attempt and
  // shows the result.
  await other.getByTestId('finish-attempt').click();
  await other.getByTestId('finish-confirm').click();
  await expect(other.getByTestId('attempt-review')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('finish-attempt')).toHaveCount(0);
  const kinds = (await readCommandRows(guestAttempt.sessionId))
    .map((row) => row.kind)
    .toSorted();
  expect(kinds).toEqual(['start', 'submit']);
  expect(await readResults(attemptId)).toHaveLength(1);
  await context.close();
});

test('replayed accepted submission returns exactly one result', async ({
  request,
}) => {
  const guest = await startedGuest();
  expect((await save(guest, 'hoeren-1', fullKeyOf('hoeren-1'), 1)).ok).toBe(
    true,
  );
  const body = submitBody(
    [{ questionId: 'lesen-1', optionId: fullKeyOf('lesen-1'), revision: 1 }],
    TOTAL - 2,
  );

  // The answer of the first request is lost; the same command is sent again.
  const first = await http(request, guest, guest.attemptId, 'submit', body);
  expect(first.status()).toBe(200);
  const run = await readSubmission(guest.attemptId);
  const results = await readResults(guest.attemptId);
  expect(results).toHaveLength(1);

  for (let repeat = 0; repeat < 2; repeat++) {
    const again = await http(request, guest, guest.attemptId, 'submit', body);
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({
      ok: true,
      result: { outcome: 'result-ready', attemptId: guest.attemptId },
    });
  }
  expect(await readSubmission(guest.attemptId)).toEqual(run);
  expect(await readResults(guest.attemptId)).toEqual(results);
  expect(await readEventKinds(guest.attemptId)).toEqual(['start', 'finish']);
  expect(
    (await readCommandRows(guest.sessionId)).filter(
      (row) => row.kind === 'submit',
    ),
  ).toHaveLength(1);
});

test('final submission accepts a complete forty five answer payload', async ({
  request,
}) => {
  const guest = await startedGuest();
  const answers = ALL_IDS.map((questionId) => ({
    questionId,
    optionId: fullKeyOf(questionId),
    revision: 1,
  }));
  const body = JSON.stringify(submitBody(answers, 0));
  expect(answers).toHaveLength(45);
  expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);

  const response = await http(request, guest, guest.attemptId, 'submit', body);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    result: { outcome: 'result-ready', attemptId: guest.attemptId },
  });
  expect(await readAnswers(guest.attemptId)).toEqual(FULL_PILOT.keys);
  const [result] = await readResults(guest.attemptId);
  expect(result).toMatchObject({
    max_score: 45,
    score: 45,
    correct_count: 45,
    skipped_count: 0,
    level: 'B1',
  });
});

test('malformed or oversized final submission is refused without mutation', async ({
  request,
}) => {
  const guest = await startedGuest();
  expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const before = stateOf(guest);

  const malformed = await http(
    request,
    guest,
    guest.attemptId,
    'submit',
    '{"commandId": "x", "answers": [',
  );
  expect(malformed.status()).toBe(400);
  expect(await malformed.json()).toEqual({
    ok: false,
    failure: 'invalid-input',
  });

  const answers = ALL_IDS.map((questionId) => ({
    questionId,
    optionId: 'a'.repeat(1500),
    revision: 1,
  }));
  const oversized = JSON.stringify(submitBody(answers, 0));
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(65_536);
  const tooLarge = await http(
    request,
    guest,
    guest.attemptId,
    'submit',
    oversized,
  );
  expect(tooLarge.status()).toBe(413);
  expect(await tooLarge.json()).toEqual({
    ok: false,
    failure: 'payload-too-large',
  });
  expect(stateOf(guest)).toEqual(before);
});

// Cancel ----------------------------------------------------------------------------

test('cancel closes without grade and frees active slot', async ({
  request,
}) => {
  const guest = await startedGuest();
  expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const status = await statusOf(guest);
  expect(status).toMatchObject({ outcome: 'active', skipped: TOTAL - 1 });

  const commandId = randomUUID();
  const body = { commandId, confirmation: { phaseRevision: 0, skipped: 44 } };
  const cancelled = await http(request, guest, guest.attemptId, 'cancel', body);
  expect(cancelled.status()).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: guest.attemptId },
  });
  const replay = await http(request, guest, guest.attemptId, 'cancel', body);
  expect(await replay.json()).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });

  expect(statusRow(guest.attemptId)).toBe('cancelled');
  expect(await readAnswers(guest.attemptId)).toEqual({ 'hoeren-1': 'a' });
  expect(await readResults(guest.attemptId)).toEqual([]);
  expect(await readEventKinds(guest.attemptId)).toEqual(['start', 'cancel']);
  const run = await readSubmission(guest.attemptId);
  expect(run.frozen_answers).toBeNull();
  expect(
    psql(`select cancel_reason from public.attempt_runs
      where attempt_id = ${quote(guest.attemptId)}`),
  ).toBe('user');

  // The slot is free: a new start creates another attempt.
  const next = await startFor(depsNow(), guest.token, FULL_EXAM.slug);
  expect(next).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!next.ok) throw new Error('start failed');
  expect(next.result.attemptId).not.toBe(guest.attemptId);
});

test('terminal cancellation and mismatched replay are refused', async () => {
  // A cancelled attempt: a new cancel and a submit change nothing.
  const cancelledGuest = await startedGuest();
  expect((await cancel(cancelledGuest, TOTAL)).ok).toBe(true);
  const cancelledState = stateOf(cancelledGuest);
  expect(await cancel(cancelledGuest, TOTAL)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict' },
  });
  expect(await submit(cancelledGuest, submitBody([], TOTAL))).toMatchObject({
    ok: true,
    result: { outcome: 'conflict' },
  });
  expect(stateOf(cancelledGuest)).toEqual(cancelledState);

  // A submitted attempt: no cancel, and its commandId names one command.
  const guest = await startedGuest();
  const commandId = randomUUID();
  const answers = [{ questionId: 'hoeren-1', optionId: 'a', revision: 1 }];
  expect(await acceptOnly(guest, answers, TOTAL - 1, commandId)).toMatchObject({
    outcome: 'accepted',
    attempt_status: 'submitted',
  });
  const submittedState = stateOf(guest);
  expect(await cancel(guest, TOTAL - 1)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict' },
  });
  expect(await cancel(guest, TOTAL - 1, commandId)).toEqual({
    ok: false,
    failure: 'invalid-input',
  });
  const otherAnswers = [{ questionId: 'hoeren-1', optionId: 'c', revision: 2 }];
  expect(
    await submit(guest, submitBody(otherAnswers, TOTAL - 1, commandId)),
  ).toEqual({ ok: false, failure: 'invalid-input' });
  expect(stateOf(guest)).toEqual(submittedState);
  expect(await readEventKinds(guest.attemptId)).toEqual(['start']);
  expect(await readResults(guest.attemptId)).toEqual([]);
});

// Revisions and confirmations ---------------------------------------------------

test('stale revisions and confirmations cannot rewrite accepted state', async () => {
  // The server holds a newer revision than the final set: it is kept, and an
  // equal revision with another option does not replace it either.
  const guest = await startedGuest();
  expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
  expect((await save(guest, 'hoeren-1', 'c', 3)).ok).toBe(true);
  expect((await save(guest, 'hoeren-2', 'a', 2)).ok).toBe(true);
  const result = await submit(
    guest,
    submitBody(
      [
        { questionId: 'hoeren-1', optionId: 'b', revision: 2 },
        { questionId: 'hoeren-2', optionId: 'b', revision: 2 },
        { questionId: 'hoeren-3', optionId: 'b', revision: 1 },
      ],
      TOTAL - 3,
    ),
  );
  expect(result).toMatchObject({
    ok: true,
    result: { outcome: 'result-ready' },
  });
  expect((await readSubmission(guest.attemptId)).frozen_answers).toEqual({
    'hoeren-1': { optionId: 'c', revision: 3 },
    'hoeren-2': { optionId: 'a', revision: 2 },
    'hoeren-3': { optionId: 'b', revision: 1 },
  });
  expect(await readAnswerRows(guest.attemptId)).toEqual([
    { question_id: 'hoeren-1', option_id: 'c', revision: 3 },
    { question_id: 'hoeren-2', option_id: 'a', revision: 2 },
    { question_id: 'hoeren-3', option_id: 'b', revision: 1 },
  ]);

  // A confirmation that no longer matches the effective set is refused whole:
  // not even the new answer of the batch is written.
  const stale = await startedGuest();
  expect((await save(stale, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const before = stateOf(stale);
  for (const skipped of [TOTAL, TOTAL - 1, TOTAL - 3]) {
    const refused = await submit(
      stale,
      submitBody(
        [{ questionId: 'hoeren-2', optionId: 'b', revision: 1 }],
        skipped,
      ),
    );
    expect(refused).toMatchObject({
      ok: true,
      result: { outcome: 'stale-confirmation', attemptId: stale.attemptId },
    });
  }
  const wrongPhase = await submit(stale, {
    commandId: randomUUID(),
    answers: [],
    confirmation: { phaseRevision: 1, skipped: TOTAL - 1 },
  });
  expect(wrongPhase).toMatchObject({
    ok: true,
    result: { outcome: 'stale-confirmation' },
  });
  expect(stateOf(stale)).toEqual(before);
});

// Assignment and options ----------------------------------------------------------

test('sql save and submission accept only assigned subset questions', async () => {
  const guest = await subsetGuest();
  expect(await save(guest, 'hoeren-1', fullKeyOf('hoeren-1'), 1)).toMatchObject(
    { ok: true, questionId: 'hoeren-1' },
  );
  const status = await statusOf(guest);
  expect(status.skipped).toBe(HOEREN_IDS.length - 1);
  const result = await submit(
    guest,
    submitBody(
      [
        {
          questionId: 'hoeren-2',
          optionId: fullWrongOf('hoeren-2'),
          revision: 1,
        },
        {
          questionId: 'hoeren-3',
          optionId: fullKeyOf('hoeren-3'),
          revision: 1,
        },
      ],
      HOEREN_IDS.length - 3,
    ),
  );
  expect(result).toMatchObject({
    ok: true,
    result: { outcome: 'result-ready' },
  });
  const [stored] = await readResults(guest.attemptId);
  expect(stored).toMatchObject({
    scope: 'short-set',
    max_score: 20,
    score: 2,
    correct_count: 2,
    incorrect_count: 1,
    skipped_count: 17,
    level: null,
    hoeren_max: null,
  });
});

test('unassigned question rejects save and entire submission batch atomically', async () => {
  const guest = await subsetGuest();
  expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const before = stateOf(guest);

  // lesen-1 is part of the version but not of this Hören assignment.
  expect(await save(guest, 'lesen-1', fullKeyOf('lesen-1'), 1)).toEqual({
    ok: false,
    error: 'option-not-allowed',
  });
  const batch = await submit(
    guest,
    submitBody(
      [
        { questionId: 'hoeren-2', optionId: 'b', revision: 1 },
        { questionId: 'lesen-1', optionId: fullKeyOf('lesen-1'), revision: 1 },
      ],
      HOEREN_IDS.length - 2,
    ),
  );
  expect(batch).toEqual({ ok: false, failure: 'invalid-input' });
  const direct = await serviceDb.rpc('m2_save_answer', {
    p_session_id: guest.sessionId,
    p_attempt_id: guest.attemptId,
    p_question_id: 'lesen-1',
    p_option_id: fullKeyOf('lesen-1'),
    p_revision: 1,
  });
  expect(direct.error?.hint).toBe('question_not_assigned');
  expect(stateOf(guest)).toEqual(before);
  expect(statusRow(guest.attemptId)).toBe('active');
});

test('foreign option rejects assigned question save and submission atomically', async () => {
  const guest = await startedGuest();
  expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const before = stateOf(guest);

  // x is an option of the version, but not of hoeren-1.
  expect(await save(guest, 'hoeren-1', 'x', 2)).toEqual({
    ok: false,
    error: 'option-not-allowed',
  });
  const batch = await submit(
    guest,
    submitBody(
      [
        { questionId: 'hoeren-2', optionId: 'b', revision: 1 },
        { questionId: 'hoeren-1', optionId: 'x', revision: 2 },
      ],
      TOTAL - 2,
    ),
  );
  expect(batch).toEqual({ ok: false, failure: 'invalid-input' });
  const direct = await serviceDb
    .rpc('m2_accept_submission', {
      p_session_id: guest.sessionId,
      p_attempt_id: guest.attemptId,
      p_command_id: randomUUID(),
      p_answers: [{ questionId: 'hoeren-1', optionId: 'x', revision: 2 }],
      p_expected_phase_revision: 0,
      p_expected_skipped: TOTAL - 1,
    })
    .single();
  expect(direct.error?.hint).toBe('option_not_allowed');
  expect(stateOf(guest)).toEqual(before);
});

// Finalize ----------------------------------------------------------------------------

// hoeren-1..20 by key, lesen-1..10 by key, lesen-11..15 wrong, the rest
// skipped: the expected totals are written down from the key itself.
const MIXED_ANSWERS = ALL_IDS.flatMap((questionId, index) => {
  if (index < 30) {
    return [{ questionId, optionId: fullKeyOf(questionId), revision: 1 }];
  }
  if (index < 35) {
    return [{ questionId, optionId: fullWrongOf(questionId), revision: 1 }];
  }
  return [];
});

test('finalization validates frozen assignment counts and grade eligibility', async () => {
  const guest = await startedGuest();
  const result = await submit(guest, submitBody(MIXED_ANSWERS, 10));
  expect(result).toMatchObject({
    ok: true,
    result: { outcome: 'result-ready' },
  });
  const rows = await readResults(guest.attemptId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    scope: 'full-exam',
    max_score: 45,
    score: 30,
    correct_count: 30,
    incorrect_count: 5,
    skipped_count: 10,
    percent: 66.7,
    hoeren_score: 20,
    hoeren_max: 20,
    lesen_score: 10,
    lesen_max: 25,
    level: 'A2',
  });

  // A repeated finalize returns the stored result; nothing else is written.
  const again = await serviceDb
    .rpc('m2_finalize_attempt', {
      p_session_id: guest.sessionId,
      p_attempt_id: guest.attemptId,
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
    })
    .single<{ score: number }>();
  expect(again.data?.score).toBe(30);
  expect(await readResults(guest.attemptId)).toEqual(rows);
  expect(await readEventKinds(guest.attemptId)).toEqual(['start', 'finish']);
});

interface FinalizeArgs {
  p_scope: string;
  p_score: number;
  p_max_score: number;
  p_correct: number;
  p_incorrect: number;
  p_skipped: number;
  p_percent: number;
  p_hoeren_score: number | null;
  p_hoeren_max: number | null;
  p_lesen_score: number | null;
  p_lesen_max: number | null;
  p_level: string | null;
}

test('database rejects inconsistent frozen result aggregates', async () => {
  // hoeren-1 by key and hoeren-2 wrong: 1 correct, 1 wrong, 43 skipped.
  const guest = await startedGuest();
  const answers = [
    { questionId: 'hoeren-1', optionId: fullKeyOf('hoeren-1'), revision: 1 },
    { questionId: 'hoeren-2', optionId: fullWrongOf('hoeren-2'), revision: 1 },
  ];
  await acceptOnly(guest, answers, TOTAL - 2);
  const valid: FinalizeArgs = {
    p_scope: 'full-exam',
    p_score: 1,
    p_max_score: 45,
    p_correct: 1,
    p_incorrect: 1,
    p_skipped: 43,
    p_percent: 2.2,
    p_hoeren_score: 1,
    p_hoeren_max: 20,
    p_lesen_score: 0,
    p_lesen_max: 25,
    p_level: 'below-A2',
  };
  const finalize = (args: FinalizeArgs, target: Guest = guest) =>
    serviceDb
      .rpc('m2_finalize_attempt', {
        p_session_id: target.sessionId,
        p_attempt_id: target.attemptId,
        ...args,
      })
      .single();
  const before = stateOf(guest);
  const variants: Partial<FinalizeArgs>[] = [
    { p_max_score: 44, p_skipped: 42 },
    { p_score: 2, p_correct: 2, p_incorrect: 0, p_hoeren_score: 2 },
    { p_incorrect: 0, p_skipped: 44 },
    { p_percent: 2.3 },
    { p_hoeren_max: 19, p_lesen_max: 26 },
    { p_hoeren_score: 0, p_lesen_score: 1 },
    { p_level: null },
    { p_scope: 'short-set' },
  ];
  for (const variant of variants) {
    const refused = await finalize({ ...valid, ...variant });
    expect(refused.error?.hint, JSON.stringify(variant)).toBe(
      'result_inconsistent',
    );
  }
  expect(stateOf(guest)).toEqual(before);
  expect(statusRow(guest.attemptId)).toBe('submitted');

  // A short set has no level and no skill totals.
  const subset = await subsetGuest();
  await acceptOnly(
    subset,
    [{ questionId: 'hoeren-1', optionId: fullKeyOf('hoeren-1'), revision: 1 }],
    HOEREN_IDS.length - 1,
  );
  const shortValid: FinalizeArgs = {
    p_scope: 'short-set',
    p_score: 1,
    p_max_score: 20,
    p_correct: 1,
    p_incorrect: 0,
    p_skipped: 19,
    p_percent: 5,
    p_hoeren_score: null,
    p_hoeren_max: null,
    p_lesen_score: null,
    p_lesen_max: null,
    p_level: null,
  };
  for (const variant of [
    { p_level: 'A2' },
    { p_hoeren_score: 1, p_hoeren_max: 20, p_lesen_score: 0, p_lesen_max: 0 },
  ]) {
    const refused = await finalize({ ...shortValid, ...variant }, subset);
    expect(refused.error?.hint, JSON.stringify(variant)).toBe(
      'result_inconsistent',
    );
  }
  expect(statusRow(subset.attemptId)).toBe('submitted');

  // The consistent values are stored once.
  expect((await finalize(valid)).error).toBeNull();
  expect((await finalize(shortValid, subset)).error).toBeNull();
  expect(statusRow(guest.attemptId)).toBe('completed');
  expect(await readResults(guest.attemptId)).toHaveLength(1);
});

// Terminal states and direct writes ------------------------------------------------

test('submit cancel and direct writes preserve terminal state', async () => {
  // Both winners of a race on the row lock: exactly one terminal outcome.
  for (const first of ['submit', 'cancel'] as const) {
    const guest = await startedGuest();
    expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
    const lock = await holdAttemptLock(guest.attemptId);
    const doSubmit = () => submit(guest, submitBody([], TOTAL - 1));
    const doCancel = () => cancel(guest, TOTAL - 1);
    const fnOf = (kind: 'submit' | 'cancel') =>
      kind === 'submit' ? 'm2_accept_submission' : 'm2_cancel_attempt';
    const second = first === 'submit' ? 'cancel' : 'submit';
    try {
      const winner = first === 'submit' ? doSubmit() : doCancel();
      await expect.poll(() => waitersBehind(lock, fnOf(first))).toBe(1);
      const loser = second === 'submit' ? doSubmit() : doCancel();
      await expect.poll(() => waitersBehind(lock, fnOf(second))).toBe(1);
      await lock.release();
      const [won, lost] = await Promise.all([winner, loser]);
      expect(won).toMatchObject({
        ok: true,
        result: { outcome: first === 'submit' ? 'result-ready' : 'accepted' },
      });
      expect(lost).toMatchObject({ ok: true, result: { outcome: 'conflict' } });
    } finally {
      await lock.release().catch(() => undefined);
    }
    const isSubmitted = first === 'submit';
    expect(statusRow(guest.attemptId)).toBe(
      isSubmitted ? 'completed' : 'cancelled',
    );
    expect(await readResults(guest.attemptId)).toHaveLength(
      isSubmitted ? 1 : 0,
    );
    expect(await readEventKinds(guest.attemptId)).toEqual([
      'start',
      isSubmitted ? 'finish' : 'cancel',
    ]);
  }

  // Prepared terminal states refuse direct service_role writes.
  const submitted = await startedGuest();
  await acceptOnly(
    submitted,
    [{ questionId: 'hoeren-1', optionId: 'a', revision: 1 }],
    TOTAL - 1,
  );
  const completed = await startedGuest();
  expect((await save(completed, 'hoeren-1', 'a', 1)).ok).toBe(true);
  expect(
    (
      await submitStored(depsNow(), completed.token, {
        attemptId: completed.attemptId,
      })
    ).ok,
  ).toBe(true);
  const cancelled = await startedGuest();
  expect((await save(cancelled, 'hoeren-1', 'a', 1)).ok).toBe(true);
  expect((await cancel(cancelled, TOTAL - 1)).ok).toBe(true);
  const stranger = await newGuest(depsNow());

  const cases = [
    { guest: submitted, hint: 'attempt_submitted' },
    { guest: completed, hint: 'attempt_completed' },
    { guest: cancelled, hint: 'attempt_cancelled' },
  ];
  for (const { guest, hint } of cases) {
    const before = stateOf(guest);
    const { attemptId } = guest;
    const identity = await serviceDb
      .from('attempts')
      .update({ guest_session_id: stranger.guest.sessionId })
      .eq('id', attemptId);
    expect(identity.error?.hint).toBe('attempt_identity_fixed');
    const reopen = await serviceDb
      .from('attempts')
      .update({ status: 'active' })
      .eq('id', attemptId);
    expect(reopen.error?.hint).toBe(hint);
    for (const change of [
      { frozen_answers: {} },
      { assignment: { versionId: attemptId, questionIds: ['hoeren-1'] } },
      { legacy_completed: true },
    ]) {
      const run = await serviceDb
        .from('attempt_runs')
        .update(change)
        .eq('attempt_id', attemptId);
      expect(run.error?.code, JSON.stringify(change)).toBe('42501');
    }
    const answer = await serviceDb.from('attempt_answers').upsert({
      attempt_id: attemptId,
      question_id: 'hoeren-2',
      option_id: 'b',
    });
    expect(answer.error?.hint).toBe('attempt_completed');
    const rewritten = await serviceDb
      .from('attempt_answers')
      .update({ option_id: 'c' })
      .eq('attempt_id', attemptId);
    expect(rewritten.error?.hint).toBe('attempt_completed');
    expect(stateOf(guest), hint).toEqual(before);
  }
  const forged = await serviceDb.from('attempt_results').insert({
    attempt_id: submitted.attemptId,
    scope: 'full-exam',
    score: 45,
    max_score: 45,
    correct_count: 45,
    incorrect_count: 0,
    skipped_count: 0,
    percent: 100,
    hoeren_score: 20,
    hoeren_max: 20,
    lesen_score: 25,
    lesen_max: 25,
    level: 'B1',
  });
  expect(forged.error?.hint).toBe('result_inconsistent');
  const onCancelled = await serviceDb.from('attempt_results').insert({
    attempt_id: cancelled.attemptId,
    score: 0,
    max_score: 45,
    skipped_count: 45,
  });
  expect(onCancelled.error?.hint).toBe('attempt_not_submitted');

  // The allowed finalize still completes the submitted attempt, and the
  // purge of a guest session still removes its attempts.
  expect(
    (
      await submitStored(depsNow(), submitted.token, {
        attemptId: submitted.attemptId,
      })
    ).ok,
  ).toBe(true);
  expect(statusRow(submitted.attemptId)).toBe('completed');
  for (const guest of [submitted, cancelled]) {
    const purged = await serviceDb
      .from('guest_sessions')
      .delete()
      .eq('id', guest.sessionId);
    expect(purged.error).toBeNull();
    expect(
      psql(`select count(*) from public.attempts
        where id = ${quote(guest.attemptId)}`),
    ).toBe('0');
  }
});

test('late progress cannot mutate submitted completed or cancelled attempt', async () => {
  const progress = { block: 'lesen' as const, positionSeconds: 3 };
  const submitted = await startedGuest();
  await acceptOnly(submitted, [], TOTAL);
  const completed = await startedGuest();
  expect(
    (
      await submitStored(depsNow(), completed.token, {
        attemptId: completed.attemptId,
      })
    ).ok,
  ).toBe(true);
  const cancelled = await startedGuest();
  expect((await cancel(cancelled, TOTAL)).ok).toBe(true);

  for (const guest of [submitted, completed, cancelled]) {
    const before = stateOf(guest);
    const late = await saveProgress(depsNow(), guest.token, {
      attemptId: guest.attemptId,
      progress,
    });
    expect(late).toEqual({ ok: false, error: 'attempt-not-found' });
    const direct = await serviceDb.rpc('m2_save_progress', {
      p_session_id: guest.sessionId,
      p_attempt_id: guest.attemptId,
      p_progress: progress,
    });
    expect(direct.error?.hint).toBe('attempt_not_found');
    expect(await readProgress(guest.attemptId)).toBeNull();
    expect(stateOf(guest)).toEqual(before);
  }
});

// Recovery -------------------------------------------------------------------------

test('accepted submission recovers after interruption before finalization', async () => {
  // A replay of the same command completes the interrupted submission.
  const replayed = await startedGuest();
  const commandId = randomUUID();
  const answers = [
    { questionId: 'hoeren-1', optionId: fullKeyOf('hoeren-1'), revision: 1 },
  ];
  await acceptOnly(replayed, answers, TOTAL - 1, commandId);
  const accepted = await readSubmission(replayed.attemptId);
  expect(statusRow(replayed.attemptId)).toBe('submitted');
  expect(await readResults(replayed.attemptId)).toEqual([]);
  const again = await submit(
    replayed,
    submitBody(answers, TOTAL - 1, commandId),
  );
  expect(again).toEqual({
    ok: true,
    result: { outcome: 'result-ready', attemptId: replayed.attemptId },
  });
  expect(await readSubmission(replayed.attemptId)).toEqual(accepted);
  expect(await readResults(replayed.attemptId)).toHaveLength(1);
  expect(await readEventKinds(replayed.attemptId)).toEqual(['start', 'finish']);

  // The status completes it as well, and the review reads that result.
  const read = await startedGuest();
  await acceptOnly(read, answers, TOTAL - 1);
  const snapshot = await readSubmission(read.attemptId);
  const status = await statusOf(read);
  expect(status).toMatchObject({
    outcome: 'result-ready',
    answers: { 'hoeren-1': fullKeyOf('hoeren-1') },
    submittedAt: snapshot.submission_accepted_at,
  });
  expect(await readSubmission(read.attemptId)).toEqual(snapshot);
  expect(await readResults(read.attemptId)).toHaveLength(1);
  const reviewed = await submitStored(depsNow(), read.token, {
    attemptId: read.attemptId,
  });
  if (!reviewed.ok) throw new Error('review failed');
  expect(reviewed.review.correct).toBe(1);
  expect(await readEventKinds(read.attemptId)).toEqual(['start', 'finish']);

  // No other attempt was created for either guest.
  for (const guest of [replayed, read]) {
    expect(
      psql(`select count(*) from public.attempts
        where guest_session_id = ${quote(guest.sessionId)}`),
    ).toBe('1');
  }
});

// Access -----------------------------------------------------------------------------

test('submission transport and rpc reject privilege bypasses', async ({
  request,
}) => {
  const owner = await startedGuest();
  expect((await save(owner, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const stranger = await startedGuest();
  const before = stateOf(owner);
  const body = submitBody([], TOTAL - 1);
  const cancelBody = {
    commandId: randomUUID(),
    confirmation: { phaseRevision: 0, skipped: TOTAL - 1 },
  };

  for (const command of ['submit', 'cancel', 'status'] as const) {
    const payload =
      command === 'submit' ? body : command === 'cancel' ? cancelBody : {};
    const noGuest = await http(
      request,
      null,
      owner.attemptId,
      command,
      payload,
    );
    expect(noGuest.status(), command).toBe(401);
    const foreign = await http(
      request,
      stranger,
      owner.attemptId,
      command,
      payload,
    );
    expect(foreign.status(), command).toBe(404);
    const crossSite = await http(
      request,
      owner,
      owner.attemptId,
      command,
      payload,
      { origin: 'https://evil.example' },
    );
    expect(crossSite.status(), command).toBe(403);
    const noOrigin = await http(
      request,
      owner,
      owner.attemptId,
      command,
      payload,
      {},
    );
    expect(noOrigin.status(), command).toBe(403);
  }
  for (const forged of [
    { ...body, score: 45 },
    { ...body, level: 'B1' },
    { ...body, status: 'completed' },
    { ...body, sessionId: stranger.sessionId },
    { ...body, attemptId: stranger.attemptId },
  ]) {
    const response = await http(
      request,
      owner,
      owner.attemptId,
      'submit',
      forged,
    );
    expect(response.status(), JSON.stringify(Object.keys(forged))).toBe(400);
  }

  // The publishable key reaches none of the new functions.
  const anon = createPublicClient();
  const calls = {
    m2_accept_submission: {
      p_session_id: owner.sessionId,
      p_attempt_id: owner.attemptId,
      p_command_id: randomUUID(),
      p_answers: [],
      p_expected_phase_revision: 0,
      p_expected_skipped: TOTAL - 1,
    },
    m2_cancel_attempt: {
      p_session_id: owner.sessionId,
      p_attempt_id: owner.attemptId,
      p_command_id: randomUUID(),
      p_expected_phase_revision: 0,
      p_expected_skipped: TOTAL - 1,
    },
    m2_finalize_attempt: {
      p_session_id: owner.sessionId,
      p_attempt_id: owner.attemptId,
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
  };
  for (const [name, args] of Object.entries(calls)) {
    const called = await anon.rpc(name, args);
    expect(called.error?.code, name).toBe('42501');
  }
  // A foreign session cannot submit or finalize the owner's attempt either.
  const foreignAccept = await serviceDb
    .rpc('m2_accept_submission', {
      ...calls.m2_accept_submission,
      p_session_id: stranger.sessionId,
    })
    .single();
  expect(foreignAccept.error?.hint).toBe('attempt_not_found');
  const foreignFinalize = await serviceDb.rpc('m2_finalize_attempt', {
    ...calls.m2_finalize_attempt,
    p_session_id: stranger.sessionId,
  });
  expect(foreignFinalize.error?.hint).toBe('attempt_not_found');
  expect(stateOf(owner)).toEqual(before);
});

test('new mutations refuse arbitrary caller time', async ({ request }) => {
  const guest = await startedGuest();
  expect((await save(guest, 'hoeren-1', 'a', 1)).ok).toBe(true);
  const before = stateOf(guest);
  const time = { p_now: '2999-01-01T00:00:00Z' };
  const bodies = {
    answer: { questionId: 'hoeren-2', optionId: 'b', revision: 1 },
    progress: { progress: { block: 'hoeren' } },
    status: {},
    submit: submitBody([], TOTAL - 1),
    cancel: {
      commandId: randomUUID(),
      confirmation: { phaseRevision: 0, skipped: TOTAL - 1 },
    },
  };
  for (const [command, body] of Object.entries(bodies)) {
    for (const extra of [time, { now: time.p_now }, { at: time.p_now }]) {
      const response = await http(request, guest, guest.attemptId, command, {
        ...body,
        ...extra,
      });
      expect(response.status(), `${command} ${Object.keys(extra)}`).toBe(400);
    }
  }

  // No production function takes a time: a call with one finds nothing.
  const base = { p_session_id: guest.sessionId, p_attempt_id: guest.attemptId };
  const rpcs = {
    m2_save_answer: {
      ...base,
      p_question_id: 'hoeren-2',
      p_option_id: 'b',
      p_revision: 1,
    },
    m2_save_progress: { ...base, p_progress: { block: 'hoeren' } },
    m2_accept_submission: {
      ...base,
      p_command_id: randomUUID(),
      p_answers: [],
      p_expected_phase_revision: 0,
      p_expected_skipped: TOTAL - 1,
    },
    m2_cancel_attempt: {
      ...base,
      p_command_id: randomUUID(),
      p_expected_phase_revision: 0,
      p_expected_skipped: TOTAL - 1,
    },
    m2_finalize_attempt: {
      ...base,
      p_scope: 'full-exam',
      p_score: 0,
      p_max_score: 45,
      p_correct: 0,
      p_incorrect: 1,
      p_skipped: 44,
      p_percent: 0,
      p_hoeren_score: 0,
      p_hoeren_max: 20,
      p_lesen_score: 0,
      p_lesen_max: 25,
      p_level: 'below-A2',
    },
  };
  for (const [name, args] of Object.entries(rpcs)) {
    const called = await serviceDb.rpc(name, { ...args, ...time });
    expect(called.error?.code, name).toBe('PGRST202');
  }
  const timed = psql(`select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'm2\\_%'
      and 'timestamptz'::regtype::oid = any(p.proargtypes::oid[])`);
  expect(timed).toBe('0');
  expect(stateOf(guest)).toEqual(before);
});

const RUNTIME_FUNCTIONS = [
  'public.m2_save_answer(uuid, uuid, text, text, integer)',
  'public.m2_save_progress(uuid, uuid, jsonb)',
  'public.m2_accept_submission(uuid, uuid, uuid, jsonb, integer, integer)',
  'public.m2_cancel_attempt(uuid, uuid, uuid, integer, integer)',
  'public.m2_finalize_attempt(uuid, uuid, text, integer, integer, integer, integer, integer, numeric, integer, integer, integer, integer, text)',
];

const TRIGGER_FUNCTIONS = [
  'public.guard_new_attempt_run()',
  'public.check_attempt_result()',
];

const PRIVATE_FUNCTIONS = [
  'm2_private.active_visitor(uuid, timestamptz)',
  'm2_private.owned_attempt(uuid, uuid)',
  'm2_private.check_answerable(public.attempts, public.attempt_runs, text, text)',
  'm2_private.answer_batch(jsonb)',
  'm2_private.skipped_in(public.attempt_runs, jsonb)',
  'm2_private.stored_answers(public.attempt_runs)',
  'm2_private.fingerprint(jsonb)',
  'm2_private.save_answer(uuid, uuid, text, text, integer, timestamptz)',
  'm2_private.save_progress(uuid, uuid, jsonb, timestamptz)',
  'm2_private.accept_submission(uuid, uuid, uuid, jsonb, integer, integer, timestamptz)',
  'm2_private.cancel_attempt(uuid, uuid, uuid, integer, integer, timestamptz)',
  'm2_private.mark_legacy_completed(uuid)',
];

const can = (role: string, fn: string): boolean =>
  psql(
    `select has_function_privilege(${quote(role)}, ${quote(fn)}, 'execute')`,
  ) === 't';

test('mutation grants deny public roles and preserve migration owner boundary', async () => {
  const all = [
    ...RUNTIME_FUNCTIONS,
    ...TRIGGER_FUNCTIONS,
    ...PRIVATE_FUNCTIONS,
  ];
  const publicAcl = psql(`select count(*) from pg_proc p,
    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where x.grantee = 0 and p.oid in (${all
      .map((fn) => `${quote(fn)}::regprocedure`)
      .join(', ')})`);
  expect(publicAcl).toBe('0');
  for (const fn of all) {
    expect(can('anon', fn), `anon ${fn}`).toBe(false);
    expect(can('authenticated', fn), `authenticated ${fn}`).toBe(false);
  }
  for (const fn of RUNTIME_FUNCTIONS) {
    expect(can('service_role', fn), fn).toBe(true);
  }
  for (const fn of PRIVATE_FUNCTIONS) {
    expect(can('service_role', fn), fn).toBe(false);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect(
      psql(
        `select has_schema_privilege(${quote(role)}, 'm2_private', 'usage')`,
      ),
      role,
    ).toBe('f');
  }
  for (const fn of RUNTIME_FUNCTIONS) {
    const definer = psql(`select prosecdef::text || ':' ||
      coalesce(array_to_string(proconfig, ','), '')
      from pg_proc where oid = ${quote(fn)}::regprocedure`);
    expect(definer, fn).toMatch(/search_path=""$/);
  }

  // Real calls: the publishable key is refused, the private kernels and
  // the migration helper are not reachable by any API key.
  const guest = await startedGuest();
  const before = stateOf(guest);
  const anon = createPublicClient();
  const saved = await anon.rpc('m2_save_answer', {
    p_session_id: guest.sessionId,
    p_attempt_id: guest.attemptId,
    p_question_id: 'hoeren-1',
    p_option_id: 'a',
    p_revision: 1,
  });
  expect(saved.error?.code).toBe('42501');
  const progressed = await anon.rpc('m2_save_progress', {
    p_session_id: guest.sessionId,
    p_attempt_id: guest.attemptId,
    p_progress: { block: 'hoeren' },
  });
  expect(progressed.error?.code).toBe('42501');
  for (const client of [anon, serviceDb]) {
    for (const name of ['mark_legacy_completed', 'accept_submission']) {
      const called = await client.rpc(name, {});
      expect(called.error, name).not.toBeNull();
    }
  }
  expect(stateOf(guest)).toEqual(before);
});

test('save and submit enforce real guest expiry after row lock', async () => {
  const token = randomBytes(32).toString('base64url');
  const sessionId = psql(
    `select m2_test.insert_guest_ending_in(${quote(hashGuestToken(token))}, 8)`,
  );
  const expiresAt = new Date(
    psql(`select expires_at from public.guest_sessions
      where id = ${quote(sessionId)}`),
  ).getTime();
  const started = await startFor(depsNow(), token, FULL_EXAM.slug);
  if (!started.ok) throw new Error(`start failed: ${started.failure}`);
  const guest = { token, sessionId, attemptId: started.result.attemptId };
  const before = stateOf(guest);

  // The Node check passes now; both requests then wait on the row lock until
  // the real term is over.
  const lock = await holdAttemptLock(guest.attemptId);
  try {
    const pendingSave = save(guest, 'hoeren-1', 'a', 1);
    const pendingSubmit = submit(guest, submitBody([], TOTAL));
    await expect
      .poll(() => waitersBehind(lock, 'm2_save_answer'), { timeout: 5000 })
      .toBe(1);
    await expect
      .poll(() => waitersBehind(lock, 'm2_accept_submission'), {
        timeout: 5000,
      })
      .toBe(1);
    const waitMs = expiresAt - Date.now() + 500;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await lock.release();
    expect(await pendingSave).toEqual({ ok: false, error: 'session-invalid' });
    expect(await pendingSubmit).toEqual({
      ok: false,
      failure: 'session-invalid',
    });
  } finally {
    await lock.release().catch(() => undefined);
  }
  expect(stateOf(guest)).toEqual(before);
  expect(statusRow(guest.attemptId)).toBe('active');
});
