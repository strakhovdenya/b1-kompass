import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
  Route,
} from '@playwright/test';
import { selectScoringPolicy } from '@b1k/domain';
import {
  finishAttempt,
  openPractice,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { FULL_EXAM, FULL_PILOT } from './support/full-exam';
import {
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readResults,
  readSessionByToken,
  serviceDb,
} from './support/db';

// Network failures and competing requests against the real server actions
// and the test database. Saves carry the revision of the choice: the order
// of the changes of one answer, stored with it. The browser network is
// intercepted to delay, lose or repeat requests; the database is re-read.

const DB_CONTAINER = 'supabase_db_b1-kompass';

const psql = (sql: string): string =>
  execFileSync(
    'docker',
    [
      'exec',
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { stdio: 'pipe' },
  )
    .toString()
    .trim();

const { questions } = FULL_PILOT.content;
const { keys } = FULL_PILOT;

const keyOf = (questionId: string): string => {
  const key = keys[questionId];
  if (!key) throw new Error(`no key for ${questionId}`);
  return key;
};

// hoeren-1..3 have the options a, b, c and the key b.
const TARGET = 'hoeren-1';

interface StoredAnswer {
  option_id: string;
  revision: number;
}

const readStoredAnswers = async (
  attemptId: string,
  questionId: string,
): Promise<StoredAnswer[]> => {
  const { data, error } = await serviceDb
    .from('attempt_answers')
    .select('option_id, revision')
    .eq('attempt_id', attemptId)
    .eq('question_id', questionId)
    .returns<StoredAnswer[]>();
  if (error) throw error;
  return data;
};

const readStatus = async (attemptId: string): Promise<string> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('status')
    .eq('id', attemptId)
    .single<{ status: string }>();
  if (error) throw error;
  return data.status;
};

const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

const statusOf = (cardLocator: Locator): Locator =>
  cardLocator.getByTestId('save-status');

const expectStatus = (cardLocator: Locator, status: string) =>
  expect(statusOf(cardLocator)).toHaveAttribute('data-status', status);

// The save of one question: the server action call carries its input.
const isSaveOf = (request: Request, questionId: string): boolean =>
  request.method() === 'POST' &&
  (request.postData() ?? '').includes(`"questionId":"${questionId}"`);

const REPLAY_HEADERS = [
  'accept',
  'content-type',
  'next-action',
  'next-router-state-tree',
  'origin',
];

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// A copy of a server action request, to send it again later: a delayed
// duplicate of the same request reaching the server.
const capture = async (request: Request): Promise<CapturedRequest> => {
  const all = await request.allHeaders();
  const headers: Record<string, string> = {};
  for (const name of REPLAY_HEADERS) {
    const value = all[name];
    if (value !== undefined) headers[name] = value;
  }
  return { url: request.url(), headers, body: request.postData() ?? '' };
};

const replay = async (context: BrowserContext, captured: CapturedRequest) => {
  const response = await context.request.post(captured.url, {
    headers: captured.headers,
    data: captured.body,
  });
  expect(response.ok()).toBe(true);
  return response.text();
};

const signal = () => {
  let resolve = () => undefined as void;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { done, resolve: () => resolve() };
};

const tokenOf = async (context: BrowserContext): Promise<string> => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  return cookie.value;
};

const startGuest = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(card(page, TARGET)).toBeVisible();
  const token = await tokenOf(context);
  const session = await readSessionByToken(token);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  const [attempt] = attempts;
  if (attempts.length !== 1 || !attempt) throw new Error('one attempt');
  return { context, page, token, attemptId: attempt.id };
};

// A guest with an active attempt of the full set, through the real server.
const serverGuest = async () => {
  const created = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), created.guest, FULL_EXAM.slug);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  const { attemptId } = opened.practice;
  const save = (questionId: string, optionId: string, revision: number) =>
    saveAnswer(depsNow(), created.token, {
      attemptId,
      questionId,
      optionId,
      revision,
    });
  const finish = () => finishAttempt(depsNow(), created.token, { attemptId });
  return { ...created, attemptId, save, finish };
};

const goToLesen = async (page: Page) => {
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL('**/practice/lesen');
  await expect(page.getByTestId('reading-text')).toBeVisible();
};

const goToHoeren = async (page: Page) => {
  await page.getByTestId('block-link-hoeren').click();
  await page.waitForURL('**/practice');
  await expect(card(page, TARGET)).toBeVisible();
};

// Holding the row lock of an attempt -------------------------------------------

// A psql session takes the row lock every save and finish of the attempt
// needs, so the test decides which requests overlap and in which order they
// queue. Cancelling the sleep aborts the transaction and releases the lock.
const holdAttemptLock = (tag: string, attemptId: string): ChildProcess =>
  spawn(
    'docker',
    [
      'exec',
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-c',
      `begin;
       select '${tag}';
       select 1 from public.attempts where id = '${attemptId}' for update;
       select pg_sleep(60);
       commit;`,
    ],
    { stdio: 'ignore' },
  );

const isLockHeld = (tag: string): boolean =>
  psql(`select count(*) from pg_stat_activity
    where query like '%${tag}%' and wait_event = 'PgSleep'`) === '1';

// Requests of the given function queued behind the tagged session: blocked
// by it directly or by a request already queued behind it.
const waitersOn = (tag: string, fn: string): number =>
  Number(
    psql(`with recursive queued(pid) as (
        select pid from pg_stat_activity
        where query like '%${tag}%' and wait_event = 'PgSleep'
        union
        select w.pid from pg_stat_activity w, queued q
        where q.pid = any(pg_blocking_pids(w.pid))
      )
      select count(*) from pg_stat_activity a, queued q
      where a.pid = q.pid and a.wait_event_type = 'Lock'
        and a.query like '%${fn}%'`),
  );

const releaseLock = (tag: string, locker: ChildProcess) => {
  const exited = new Promise((resolve) => locker.once('exit', resolve));
  psql(`select pg_cancel_backend(pid) from pg_stat_activity
    where query like '%${tag}%' and wait_event = 'PgSleep'`);
  return exited;
};

// Order of the changes of one answer -------------------------------------------

test('out of order saves keep newest accepted choice', async ({ browser }) => {
  const { context, page, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);

  // Next runs server actions one at a time: the second save waits until the
  // first one returns. Each save is executed by the server at once, and its
  // response is held until the test releases it.
  const releases = [signal(), signal()];
  const delivered = [signal(), signal()];
  let saves = 0;
  await context.route('**/practice', async (route: Route) => {
    const request = route.request();
    if (!isSaveOf(request, TARGET)) return route.continue();
    const index = saves++;
    const response = await route.fetch();
    await releases[index]?.done;
    await route.fulfill({ response });
    delivered[index]?.resolve();
  });

  await optionIn(target, 'a').check();
  await expect
    .poll(() => readStoredAnswers(attemptId, TARGET))
    .toEqual([{ option_id: 'a', revision: 1 }]);
  await optionIn(target, 'c').check();
  await expect(optionIn(target, 'c')).toBeChecked();
  await expectStatus(target, 'saving');

  // The late confirmation of the older choice changes nothing on screen.
  releases[0]?.resolve();
  await delivered[0]?.done;
  await expect
    .poll(() => readStoredAnswers(attemptId, TARGET))
    .toEqual([{ option_id: 'c', revision: 2 }]);
  await expect(optionIn(target, 'c')).toBeChecked();
  await expectStatus(target, 'saving');

  releases[1]?.resolve();
  await delivered[1]?.done;
  await expectStatus(target, 'saved');
  await expect(optionIn(target, 'c')).toBeChecked();
  expect(saves).toBe(2);
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'c', revision: 2 },
  ]);
  expect(await readAnswers(attemptId)).toEqual({ [TARGET]: 'c' });
  await page.reload();
  await expect(optionIn(target, 'c')).toBeChecked();
  await context.close();
});

test('stale write cannot overwrite newer choice', async () => {
  const guest = await serverGuest();
  expect(await guest.save(TARGET, 'a', 1)).toMatchObject({
    ok: true,
    optionId: 'a',
    revision: 1,
  });
  expect(await guest.save(TARGET, 'c', 3)).toMatchObject({
    ok: true,
    optionId: 'c',
    revision: 3,
  });

  // The older choice is executed by the database after the newer one.
  const stale = await guest.save(TARGET, 'b', 2);
  expect(stale).toEqual({
    ok: false,
    error: 'stale',
    optionId: 'c',
    revision: 3,
  });
  const oldest = await guest.save(TARGET, 'a', 1);
  expect(oldest).toEqual({
    ok: false,
    error: 'stale',
    optionId: 'c',
    revision: 3,
  });

  expect(await readStoredAnswers(guest.attemptId, TARGET)).toEqual([
    { option_id: 'c', revision: 3 },
  ]);
  expect(await readAnswers(guest.attemptId)).toEqual({ [TARGET]: 'c' });
});

test('new choice after refresh is accepted', async ({ browser }) => {
  const { context, page, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);
  for (const option of ['a', 'c', 'a']) {
    await optionIn(target, option).check();
    await expectStatus(target, 'saved');
  }
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'a', revision: 3 },
  ]);

  // The page continues from the revision the server returns, not from zero.
  await page.reload();
  await expect(optionIn(target, 'a')).toBeChecked();
  await expectStatus(target, 'saved');
  await optionIn(target, 'b').check();
  await expectStatus(target, 'saved');
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'b', revision: 4 },
  ]);
  expect(await readAnswers(attemptId)).toEqual({ [TARGET]: 'b' });
  await context.close();
});

test('delayed retry of old choice cannot roll back newer', async ({
  browser,
}) => {
  const { context, page, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);
  const held: { request: CapturedRequest | null } = { request: null };
  await context.route('**/practice', async (route: Route) => {
    const request = route.request();
    if (isSaveOf(request, TARGET) && !held.request) {
      held.request = await capture(request);
    }
    return route.continue();
  });
  await optionIn(target, 'a').check();
  await expectStatus(target, 'saved');
  await context.unroute('**/practice');
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'a', revision: 1 },
  ]);

  await page.reload();
  await optionIn(target, 'c').check();
  await expectStatus(target, 'saved');

  // The held copy of the old request reaches the server only now.
  if (!held.request) throw new Error('the old save was not captured');
  const body = await replay(context, held.request);
  expect(body).toContain('"error":"stale"');
  expect(body).not.toContain('"ok":true');

  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'c', revision: 2 },
  ]);
  await page.reload();
  await expect(optionIn(target, 'c')).toBeChecked();
  await context.close();
});

test('lost save response retry is idempotent', async ({ browser }) => {
  const { context, page, token, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);
  const held: { request: CapturedRequest | null } = { request: null };
  await context.route('**/practice', async (route: Route) => {
    const request = route.request();
    if (!isSaveOf(request, TARGET) || held.request) return route.continue();
    // The server executes the save; its response is lost on the way back.
    held.request = await capture(request);
    await route.fetch();
    return route.abort();
  });

  await optionIn(target, 'a').check();
  await expectStatus(target, 'error');
  await expect(optionIn(target, 'a')).toBeChecked();
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'a', revision: 1 },
  ]);

  // The retry repeats the same request and is confirmed as the same choice.
  await statusOf(target).getByRole('button').click();
  await expectStatus(target, 'saved');
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'a', revision: 1 },
  ]);
  const repeated = await saveAnswer(depsNow(), token, {
    attemptId,
    questionId: TARGET,
    optionId: 'a',
    revision: 1,
  });
  expect(repeated).toMatchObject({ ok: true, optionId: 'a', revision: 1 });

  await optionIn(target, 'c').check();
  await expectStatus(target, 'saved');
  if (!held.request) throw new Error('the lost save was not captured');
  const body = await replay(context, held.request);
  expect(body).toContain('"error":"stale"');
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'c', revision: 2 },
  ]);
  expect(await readAnswers(attemptId)).toEqual({ [TARGET]: 'c' });
  await context.close();
});

test('same order key with other option is not saved', async () => {
  const guest = await serverGuest();
  expect((await guest.save(TARGET, 'a', 1)).ok).toBe(true);

  const other = await guest.save(TARGET, 'c', 1);
  expect(other).toEqual({
    ok: false,
    error: 'conflict',
    optionId: 'a',
    revision: 1,
  });
  expect(await readStoredAnswers(guest.attemptId, TARGET)).toEqual([
    { option_id: 'a', revision: 1 },
  ]);

  const next = await guest.save(TARGET, 'c', 2);
  expect(next).toMatchObject({ ok: true, optionId: 'c', revision: 2 });
  expect(await readStoredAnswers(guest.attemptId, TARGET)).toEqual([
    { option_id: 'c', revision: 2 },
  ]);
});

// Finish against saves ------------------------------------------------------------

const scoreOf = (selections: Record<string, string>): number => {
  const policy = selectScoringPolicy('DTZ', 'full-exam');
  if (!policy) throw new Error('policy is missing');
  return policy.score({ questions, keys, selections }).score;
};

test('save finish race produces one coherent result', async () => {
  const guest = await serverGuest();
  // hoeren-1 right, hoeren-2 wrong; the racing save makes hoeren-3 right.
  const seeded = { 'hoeren-1': keyOf('hoeren-1'), 'hoeren-2': 'a' };
  for (const [questionId, optionId] of Object.entries(seeded)) {
    expect((await guest.save(questionId, optionId, 1)).ok).toBe(true);
  }
  const withRaced = { ...seeded, 'hoeren-3': keyOf('hoeren-3') };
  const SCORE_WITHOUT = 1;
  const SCORE_WITH = 2;
  expect(scoreOf(seeded)).toBe(SCORE_WITHOUT);
  expect(scoreOf(withRaced)).toBe(SCORE_WITH);

  const [finished, raced] = await Promise.all([
    guest.finish(),
    guest.save('hoeren-3', keyOf('hoeren-3'), 1),
  ]);
  if (!finished.ok) throw new Error(`finish: ${finished.error}`);

  const frozen = await readAnswers(guest.attemptId);
  const results = (await readResults(guest.attemptId)) as { score: number }[];
  expect(results).toHaveLength(1);
  if (raced.ok) {
    expect(frozen).toEqual(withRaced);
    expect(results[0]?.score).toBe(SCORE_WITH);
  } else {
    expect(raced).toEqual({ ok: false, error: 'attempt-not-found' });
    expect(frozen).toEqual(seeded);
    expect(results[0]?.score).toBe(SCORE_WITHOUT);
  }
  expect(finished.review.score).toBe(results[0]?.score);
  expect(await guest.finish()).toEqual(finished);
  expect(await readResults(guest.attemptId)).toHaveLength(1);
});

test('concurrent finish and late save remain immutable', async () => {
  const guest = await serverGuest();
  expect((await guest.save('hoeren-1', keyOf('hoeren-1'), 1)).ok).toBe(true);
  expect((await guest.save('lesen-1', keyOf('lesen-1'), 1)).ok).toBe(true);
  const before = await readAnswers(guest.attemptId);

  const tag = `b1k-race-lock-${guest.attemptId}`;
  const locker = holdAttemptLock(tag, guest.attemptId);
  try {
    await expect.poll(() => isLockHeld(tag)).toBe(true);
    // Both completions queue on the attempt row first, the save after them.
    const finishes = [guest.finish(), guest.finish()];
    await expect.poll(() => waitersOn(tag, 'finish_attempt')).toBe(2);
    const late = guest.save('hoeren-2', 'b', 1);
    await expect.poll(() => waitersOn(tag, 'save_attempt_answer')).toBe(1);
    await releaseLock(tag, locker);

    const [first, second] = await Promise.all(finishes);
    if (!first?.ok || !second?.ok) throw new Error('finish failed');
    expect(second.review).toEqual(first.review);
    expect(await late).toEqual({ ok: false, error: 'attempt-not-found' });
  } finally {
    locker.kill();
  }

  expect(await readResults(guest.attemptId)).toHaveLength(1);
  expect(await readStatus(guest.attemptId)).toBe('completed');
  expect(await readAnswers(guest.attemptId)).toEqual(before);
  expect(await guest.save('hoeren-1', 'a', 2)).toEqual({
    ok: false,
    error: 'attempt-not-found',
  });
  expect(await readAnswers(guest.attemptId)).toEqual(before);
});

// Network failures -----------------------------------------------------------------

test('network retry preserves and eventually confirms selection', async ({
  browser,
}) => {
  const { context, page, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);
  await context.route('**/practice', (route: Route) =>
    isSaveOf(route.request(), TARGET) ? route.abort() : route.continue(),
  );
  await optionIn(target, 'c').check();
  await expectStatus(target, 'error');
  await expect(optionIn(target, 'c')).toBeChecked();
  expect(await readAnswers(attemptId)).toEqual({});

  await page.getByTestId('go-to-question-2').click();
  await expect(card(page, 'hoeren-2')).toBeVisible();
  await page.getByTestId('go-to-question-1').click();
  await expect(optionIn(target, 'c')).toBeChecked();
  await expectStatus(target, 'error');

  await context.unroute('**/practice');
  await statusOf(target).getByRole('button').click();
  await expectStatus(target, 'saved');
  await expect(optionIn(target, 'c')).toBeChecked();
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'c', revision: 1 },
  ]);
  await context.close();
});

test('retry failure retains latest choice without false saved', async ({
  browser,
}) => {
  const { context, page, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);
  await optionIn(target, 'b').check();
  await expectStatus(target, 'saved');

  let refused = 0;
  await context.route('**/practice', (route: Route) => {
    if (!isSaveOf(route.request(), TARGET)) return route.continue();
    refused++;
    return route.abort();
  });
  await optionIn(target, 'a').check();
  await expectStatus(target, 'error');
  await statusOf(target).getByRole('button').click();
  await expect.poll(() => refused).toBe(2);
  await expectStatus(target, 'error');

  await optionIn(target, 'c').check();
  await expect.poll(() => refused).toBe(3);
  await expectStatus(target, 'error');
  await expect(optionIn(target, 'c')).toBeChecked();
  await expect(statusOf(target).getByRole('button')).toBeVisible();
  await expect(target.locator('[data-status="saved"]')).toHaveCount(0);
  expect(await readStoredAnswers(attemptId, TARGET)).toEqual([
    { option_id: 'b', revision: 1 },
  ]);

  // Once the network is back, the latest choice is the one confirmed.
  await context.unroute('**/practice');
  await statusOf(target).getByRole('button').click();
  await expectStatus(target, 'saved');
  await expect(optionIn(target, 'c')).toBeChecked();
  expect(await readAnswers(attemptId)).toEqual({ [TARGET]: 'c' });
  await context.close();
});

test('unsaved hoeren answer blocks finish from lesen', async ({ browser }) => {
  const { context, page, attemptId } = await startGuest(browser);
  const target = card(page, TARGET);
  await context.route('**/practice', (route: Route) =>
    isSaveOf(route.request(), TARGET) ? route.abort() : route.continue(),
  );
  await optionIn(target, 'a').check();
  await expectStatus(target, 'error');
  await context.unroute('**/practice');
  expect(await readAnswers(attemptId)).toEqual({});

  await goToLesen(page);
  const reading = card(page, 'lesen-1');
  await optionIn(reading, keyOf('lesen-1')).check();
  await expectStatus(reading, 'saved');

  await page.getByTestId('finish-attempt').click();
  const notice = page.getByTestId('finish-unsaved');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-unsaved-hoeren', '1');
  await expect(notice).toHaveAttribute('data-unsaved-lesen', '0');
  await expect(page.getByTestId('attempt-review')).toHaveCount(0);
  await expect(page.getByTestId('finish-confirmation')).toHaveCount(0);
  expect(await readResults(attemptId)).toEqual([]);
  expect(await readStatus(attemptId)).toBe('active');
  expect(await readAnswers(attemptId)).toEqual({
    'lesen-1': keyOf('lesen-1'),
  });

  // Back in Hören the unconfirmed choice is still there with its retry.
  await goToHoeren(page);
  await expect(optionIn(target, 'a')).toBeChecked();
  await expectStatus(target, 'error');
  await statusOf(target).getByRole('button').click();
  await expectStatus(target, 'saved');
  await expect(notice).toHaveCount(0);

  await page.getByTestId('finish-attempt').click();
  await page.getByTestId('finish-confirm').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  expect(await readResults(attemptId)).toHaveLength(1);
  expect(await readAnswers(attemptId)).toEqual({
    [TARGET]: 'a',
    'lesen-1': keyOf('lesen-1'),
  });
  await context.close();
});
