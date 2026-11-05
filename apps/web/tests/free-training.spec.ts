import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import {
  cancelAttempt,
  getAttemptReview,
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
  startAttempt,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAnswers,
  readAttempts,
  readCommandRows,
  readEventKinds,
  readProgress,
  readResults,
  readRunRows,
  readSessionByToken,
  serviceDb,
  startBody,
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
  attemptLesenUrl,
  attemptUrl,
  card,
  enterAtChoice,
  expectStatus,
  finishFromShell,
  goToHoeren,
  goToLesen,
  optionIn,
  pausePlayer,
  playFrom,
  snapshotOf,
  startSelection,
  tokenOf,
  waitForPlayer,
} from './support/guest-browser';
import type { FreeSelection } from './support/guest-browser';

// The free training of a whole set or of one skill, on the synthetic full set
// (20 Hören, 25 Lesen) served at 3102. Counts and ids come from the fixture,
// not from the code under test.

const ORIGIN = 'http://localhost:3102';
const SLUG = FULL_EXAM.slug;
const { questions } = FULL_PILOT.content;

const SELECTIONS: readonly {
  selection: FreeSelection;
  count: number;
  scope: string;
}[] = [
  { selection: 'all', count: 45, scope: 'full-exam' },
  { selection: 'hoeren', count: 20, scope: 'short-set' },
  { selection: 'lesen', count: 25, scope: 'short-set' },
];

const idsOf = (selection: FreeSelection): string[] =>
  questions
    .filter((item) => selection === 'all' || item.skill === selection)
    .map((item) => item.id);

const REVISION_TOLERANCE_SECONDS = 0.5;
const PAUSED_TOLERANCE_SECONDS = 0.1;

interface Entered {
  page: Page;
  token: string;
  sessionId: string;
  close: () => Promise<void>;
}

// A new guest stops at the choice screen.
const enterGuest = async (browser: Browser): Promise<Entered> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterAtChoice(page);
  const token = await tokenOf(context);
  const session = await readSessionByToken(token);
  if (!session) throw new Error('guest session is missing');
  expect(await readAttempts(session.id)).toEqual([]);
  return { page, token, sessionId: session.id, close: () => context.close() };
};

const attemptIdOfUrl = (page: Page): string => {
  const match = /\/attempts\/([0-9a-f-]{36})/.exec(page.url());
  if (!match?.[1]) throw new Error(`not an attempt address: ${page.url()}`);
  return match[1];
};

const seedAnswer = async (
  token: string,
  attemptId: string,
  questionId: string,
  optionId: string,
  revision = 1,
) => {
  const saved = await saveAnswer(depsNow(), token, {
    attemptId,
    questionId,
    optionId,
    revision,
  });
  if (!saved.ok) throw new Error(`seed ${questionId}: ${saved.error}`);
};

const startCounts = async (sessionId: string) => ({
  attempts: (await readAttempts(sessionId)).length,
  commands: (await readCommandRows(sessionId)).filter(
    (row) => row.kind === 'start',
  ).length,
});

const runsOf = async (sessionId: string) => {
  const attempts = await readAttempts(sessionId);
  const runs = await Promise.all(
    attempts.map((attempt) => readRunRows(attempt.id)),
  );
  return runs.flat().length;
};

const percentOf = (score: number, max: number): string =>
  new Intl.NumberFormat('en', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(score / max);

const httpStart = (
  request: APIRequestContext,
  token: string | null,
  body: unknown,
) =>
  request.post(`${ORIGIN}/api/attempts/start`, {
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(token ? { cookie: `${GUEST_COOKIE}=${token}` } : {}),
    },
    data: JSON.stringify(body),
    maxRedirects: 0,
  });

interface StoredResult {
  scope: string;
  score: number;
  max_score: number;
  level: string | null;
}

const storedResult = async (attemptId: string): Promise<StoredResult> => {
  const rows = (await readResults(attemptId)) as StoredResult[];
  const [row] = rows;
  if (rows.length !== 1 || !row) throw new Error('one result row expected');
  return row;
};

// Selections ------------------------------------------------------------------

test('free selections expose only assigned tasks and localized results', async ({
  browser,
}) => {
  for (const { selection, count, scope } of SELECTIONS) {
    const guest = await enterGuest(browser);
    const { page } = guest;
    await startSelection(page, selection);
    const attemptId = attemptIdOfUrl(page);

    const [run] = await readRunRows(attemptId);
    expect(run).toMatchObject({ mode: 'training', selection });
    expect(run?.assignment.questionIds).toEqual(idsOf(selection));
    expect(run?.assignment.questionIds).toHaveLength(count);

    const own = idsOf(selection);
    const foreign = questions
      .map((item) => item.id)
      .filter((id) => !own.includes(id));
    if (selection === 'lesen') {
      await expect(page.getByTestId('reading-text')).toBeVisible();
      await expect(page.getByTestId('audio-element')).toHaveCount(0);
    } else {
      await expect(card(page, 'hoeren-1')).toBeVisible();
    }
    for (const id of foreign.slice(0, 3)) {
      await expect(page.getByTestId(`question-card-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('block-link-hoeren')).toHaveCount(
      selection === 'all' ? 1 : 0,
    );
    await expect(page.getByTestId('block-link-lesen')).toHaveCount(
      selection === 'all' ? 1 : 0,
    );

    const [first, second] = own;
    if (!first || !second) throw new Error('fixture too small');
    await seedAnswer(guest.token, attemptId, first, fullKeyOf(first));
    await seedAnswer(guest.token, attemptId, second, fullWrongOf(second));
    await page.goto(
      selection === 'lesen'
        ? attemptLesenUrl(SLUG, attemptId)
        : attemptUrl(SLUG, attemptId),
    );
    await finishFromShell(page);

    await expect(page.getByTestId('result-score')).toHaveText(
      `1 of ${count} points (${percentOf(1, count)})`,
    );
    await expect(page.getByTestId('result-counts')).toHaveText(
      `Right: 1 · Wrong: 1 · Skipped: ${count - 2}`,
    );
    const reviewed = await page
      .getByTestId('review-item')
      .evaluateAll((items: HTMLElement[]) =>
        items.map((item) => item.dataset.questionId),
      );
    if (selection === 'all') {
      // The review lists the tasks of the block that is open.
      expect(reviewed.length).toBeGreaterThan(0);
    } else {
      expect(reviewed).toEqual(own);
    }
    for (const id of foreign.slice(0, 1)) {
      await expect(page.getByTestId('attempt-review')).not.toContainText(
        questions.find((item) => item.id === id)?.prompt ?? id,
      );
    }
    if (selection === 'all') {
      await expect(page.getByTestId('result-untimed')).toBeVisible();
      await expect(page.getByTestId('result-scope')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('result-scope')).toContainText(
        'not an official DTZ level',
      );
      await expect(page.getByTestId('result-untimed')).toHaveCount(0);
      await expect(page.getByTestId('result-level')).toHaveCount(0);
    }

    const row = await storedResult(attemptId);
    expect(row).toMatchObject({ scope, score: 1, max_score: count });
    if (selection !== 'all') expect(row.level).toBeNull();

    await page.getByRole('button', { name: 'Русский' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByTestId('result-score')).toContainText(
      `1 из ${count} баллов`,
    );
    await guest.close();
  }
});

test('skill selections become enabled through existing start contract', async ({
  request,
}) => {
  for (const { selection, count } of SELECTIONS.filter(
    (item) => item.selection !== 'all',
  )) {
    const created = await newGuest(depsNow());
    const response = await httpStart(
      request,
      created.token,
      await startBody(SLUG, { selection }),
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      result: { outcome: string; attemptId: string };
    };
    expect(body).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
    const { attemptId } = body.result;

    const [run] = await readRunRows(attemptId);
    expect(run).toMatchObject({ mode: 'training', selection });
    expect(run?.assignment.questionIds).toEqual(idsOf(selection));

    const guest = created.guest;
    const page = await readAttemptPage(depsNow(), guest, SLUG, attemptId);
    if (page.status !== 'ready') throw new Error(`page ${page.status}`);
    expect(page.practice.questions.map((item) => item.id)).toEqual(
      idsOf(selection),
    );
    expect(page.practice.questions).toHaveLength(count);

    const html = await request.get(
      selection === 'lesen'
        ? `${ORIGIN}${attemptLesenUrl(SLUG, attemptId)}`
        : `${ORIGIN}${attemptUrl(SLUG, attemptId)}`,
      { headers: { cookie: `${GUEST_COOKIE}=${created.token}` } },
    );
    expect(html.status()).toBe(200);
    const text = await html.text();
    const other = selection === 'hoeren' ? 'lesen' : 'hoeren';
    const ownQuestion = questions.find((item) => item.skill === selection);
    const otherQuestion = questions.find((item) => item.skill === other);
    expect(text).toContain(ownQuestion?.prompt.slice(0, 20) ?? '?');
    expect(text).not.toContain(otherQuestion?.prompt.slice(0, 20) ?? '?');

    const submitted = await submitStored(depsNow(), created.token, {
      attemptId,
    });
    if (!submitted.ok) throw new Error(`submit: ${submitted.error}`);
    expect(submitted.review).toMatchObject({
      scope: 'short-set',
      showsLevel: false,
      level: null,
      maxScore: count,
    });
    expect(submitted.review.items).toHaveLength(count);
  }
});

test('enabled skill start still rejects forged selection and assignment', async ({
  request,
}) => {
  const created = await newGuest(depsNow());
  const sessionId = created.guest.sessionId;
  const forged: Record<string, unknown>[] = [
    { selection: 'speaking' },
    { selection: 'HOEREN' },
    { selection: 'hoeren', questionIds: ['lesen-1'] },
    { selection: 'lesen', assignment: { questionIds: ['hoeren-1'] } },
    { selection: 'hoeren', scope: 'full-exam' },
  ];
  for (const overrides of forged) {
    const body = { ...(await startBody(SLUG)), ...overrides };
    const response = await httpStart(request, created.token, body);
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      failure: 'invalid-input',
    });
    expect(await startAttempt(depsNow(), created.token, body)).toEqual({
      ok: false,
      failure: 'invalid-input',
    });
  }
  expect(await startCounts(sessionId)).toEqual({ attempts: 0, commands: 0 });

  // The scoped SQL refuses an assignment that does not match the selection,
  // whoever calls it.
  const latest = await latestVersionOf(SLUG);
  if (!latest) throw new Error('full set is missing');
  const refused = await serviceDb.rpc('m2_start_attempt', {
    p_session_id: sessionId,
    p_exam_id: latest.examId,
    p_command_id: randomUUID(),
    p_mode: 'training',
    p_purpose: 'normal',
    p_selection: 'hoeren',
    p_source_attempt_id: null,
    p_version_id: latest.versionId,
    p_scope: 'short-set',
    p_question_ids: [...idsOf('hoeren').slice(0, 19), 'lesen-1'],
  });
  expect(refused.error?.hint).toBe('assignment_invalid');
  expect(await startCounts(sessionId)).toEqual({ attempts: 0, commands: 0 });
  expect(await runsOf(sessionId)).toBe(0);
});

// Privacy ---------------------------------------------------------------------

test('unassigned skill and early or foreign review stay private', async ({
  request,
}) => {
  for (const { selection } of SELECTIONS.filter(
    (item) => item.selection !== 'all',
  )) {
    const other = selection === 'hoeren' ? 'lesen' : 'hoeren';
    const owner = await newGuest(depsNow());
    const stranger = await newGuest(depsNow());
    const started = await startFor(depsNow(), owner.token, SLUG, { selection });
    if (!started.ok) throw new Error(`start: ${started.failure}`);
    const attemptId = started.result.attemptId;
    const own = idsOf(selection);
    const foreignId = idsOf(other)[0] ?? '';
    const ownId = own[0] ?? '';
    await seedAnswer(owner.token, attemptId, ownId, fullKeyOf(ownId));

    // A task of the other skill is refused and nothing is stored for it.
    const forged = await saveAnswer(depsNow(), owner.token, {
      attemptId,
      questionId: foreignId,
      optionId: fullKeyOf(foreignId),
      revision: 1,
    });
    expect(forged).toEqual({ ok: false, error: 'option-not-allowed' });
    expect(await readAnswers(attemptId)).toEqual({ [ownId]: fullKeyOf(ownId) });
    // The SQL refuses it too, whoever calls it.
    const refuseDirect = async (reason: string) => {
      const direct = await serviceDb.rpc('m2_save_answer', {
        p_session_id: owner.guest.sessionId,
        p_attempt_id: attemptId,
        p_question_id: foreignId,
        p_option_id: fullKeyOf(foreignId),
        p_revision: 1,
      });
      expect(direct.error?.hint).toBe(reason);
      expect(await readAnswers(attemptId)).toEqual({
        [ownId]: fullKeyOf(ownId),
      });
    };
    await refuseDirect('question_not_assigned');

    // Before completion nobody gets a key: not the owner, not another guest.
    expect(
      await getAttemptReview(depsNow(), owner.token, { attemptId }),
    ).toEqual({ ok: false, error: 'not-completed' });
    expect(
      await getAttemptReview(depsNow(), stranger.token, { attemptId }),
    ).toEqual({ ok: false, error: 'attempt-not-found' });
    expect((await readAttempts(owner.guest.sessionId))[0]?.status).toBe(
      'active',
    );

    const submitted = await submitStored(depsNow(), owner.token, { attemptId });
    if (!submitted.ok) throw new Error(`submit: ${submitted.error}`);
    expect(submitted.review.items.map((item) => item.questionId)).toEqual(own);
    expect(JSON.stringify(submitted.review)).not.toContain(`"${foreignId}"`);

    // The completed page carries no task or key of the other skill, and a
    // later save for it is refused as well.
    const foreignQuestion = questions.find((item) => item.id === foreignId);
    const own_ = await request.get(`${ORIGIN}${attemptUrl(SLUG, attemptId)}`, {
      headers: { cookie: `${GUEST_COOKIE}=${owner.token}` },
    });
    const body = await own_.text();
    expect(own_.status()).toBe(200);
    expect(body).not.toContain(foreignId);
    expect(body).not.toContain(foreignQuestion?.prompt.slice(0, 20) ?? '?');
    await refuseDirect('attempt_not_found');

    const results = await readResults(attemptId);
    expect(results).toHaveLength(1);
    expect(
      await getAttemptReview(depsNow(), stranger.token, { attemptId }),
    ).toEqual({ ok: false, error: 'attempt-not-found' });
    expect(await readResults(attemptId)).toEqual(results);
    expect(await readAnswers(attemptId)).toEqual({ [ownId]: fullKeyOf(ownId) });
  }
});

// Unconfirmed answers ---------------------------------------------------------

test('failed save survives navigation without false saved', async ({
  browser,
}) => {
  const guest = await enterGuest(browser);
  const { page } = guest;
  await startSelection(page, 'all');
  const attemptId = attemptIdOfUrl(page);
  const context = page.context();

  await context.route(ANSWER_URL, (route) => route.abort());
  const target = card(page, 'hoeren-1');
  await optionIn(target, fullKeyOf('hoeren-1')).check();
  await expectStatus(target, 'error');

  await goToLesen(page);
  await goToHoeren(page);
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();
  await expectStatus(card(page, 'hoeren-1'), 'error');
  expect(await readAnswers(attemptId)).toEqual({});

  await context.unroute(ANSWER_URL);
  await card(page, 'hoeren-1')
    .getByRole('button', { name: 'Try again' })
    .click();
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  expect(await readAnswerRows(attemptId)).toEqual([
    { question_id: 'hoeren-1', option_id: fullKeyOf('hoeren-1'), revision: 1 },
  ]);
  await guest.close();
});

test('refresh cannot claim unaccepted choices as server saved', async ({
  browser,
}) => {
  const guest = await enterGuest(browser);
  const { page } = guest;
  await startSelection(page, 'all');
  const attemptId = attemptIdOfUrl(page);
  await seedAnswer(guest.token, attemptId, 'hoeren-1', fullKeyOf('hoeren-1'));
  await page.reload();
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();

  const context = page.context();
  await context.route(ANSWER_URL, (route) => route.abort());
  await page.getByTestId('go-to-question-2').click();
  const target = card(page, 'hoeren-2');
  await optionIn(target, fullKeyOf('hoeren-2')).check();
  await expectStatus(target, 'error');
  await context.unroute(ANSWER_URL);

  // The page opens at the place the server accepted: the unsent choice is
  // neither checked nor shown as saved.
  await page.reload();
  await expect(card(page, 'hoeren-2')).toBeVisible();
  await expect(
    optionIn(card(page, 'hoeren-2'), fullKeyOf('hoeren-2')),
  ).not.toBeChecked();
  await expect(
    card(page, 'hoeren-2').locator('[data-status="saved"]'),
  ).toHaveCount(0);
  await page.getByTestId('go-to-question-1').click();
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
  });
  await guest.close();
});

// Navigation, audio and refresh -----------------------------------------------

test('free navigation and locale preserve answers progress and audio', async ({
  browser,
}) => {
  const guest = await enterGuest(browser);
  const { page } = guest;
  await startSelection(page, 'all');
  const attemptId = attemptIdOfUrl(page);
  await waitForPlayer(page);
  await page.evaluate(() => {
    (window as unknown as { __document: string }).__document = 'same';
  });

  await optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')).check();
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  await playFrom(page, 5, 'listener');
  const before = await snapshotOf(page);

  await goToLesen(page);
  await optionIn(card(page, 'lesen-1'), fullKeyOf('lesen-1')).check();
  await expectStatus(card(page, 'lesen-1'), 'saved');
  await goToHoeren(page);
  const back = await snapshotOf(page);
  expect(back).toMatchObject({ paused: false, marker: 'listener' });
  const expected = before.currentTime + (back.nowSeconds - before.nowSeconds);
  expect(Math.abs(back.currentTime - expected)).toBeLessThanOrEqual(
    REVISION_TOLERANCE_SECONDS,
  );
  await expect(page.getByTestId('audio-element')).toHaveCount(1);
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const russian = await snapshotOf(page);
  expect(russian).toMatchObject({ paused: false, marker: 'listener' });
  const later = back.currentTime + (russian.nowSeconds - back.nowSeconds);
  expect(Math.abs(russian.currentTime - later)).toBeLessThanOrEqual(
    REVISION_TOLERANCE_SECONDS,
  );
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();

  await pausePlayer(page);
  const paused = await snapshotOf(page);
  await goToLesen(page);
  await expect(
    optionIn(card(page, 'lesen-1'), fullKeyOf('lesen-1')),
  ).toBeChecked();
  await goToHoeren(page);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const resting = await snapshotOf(page);
  expect(resting).toMatchObject({ paused: true, marker: 'listener' });
  expect(
    Math.abs(resting.currentTime - paused.currentTime),
  ).toBeLessThanOrEqual(PAUSED_TOLERANCE_SECONDS);
  expect(
    await page.evaluate(
      () => (window as unknown as { __document?: string }).__document,
    ),
  ).toBe('same');
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
    'lesen-1': fullKeyOf('lesen-1'),
  });
  await guest.close();
});

test('free refresh restores accepted answers revisions and saved audio position', async ({
  browser,
}) => {
  const guest = await enterGuest(browser);
  const { page } = guest;
  await startSelection(page, 'hoeren');
  const attemptId = attemptIdOfUrl(page);
  await waitForPlayer(page);

  const first = card(page, 'hoeren-1');
  await optionIn(first, fullWrongOf('hoeren-1')).check();
  await expectStatus(first, 'saved');
  await optionIn(first, fullKeyOf('hoeren-1')).check();
  await expect
    .poll(async () => (await readAnswerRows(attemptId))[0]?.revision)
    .toBe(2);
  await expectStatus(first, 'saved');
  await page.getByTestId('go-to-question-2').click();
  await expect(card(page, 'hoeren-2')).toBeVisible();

  await playFrom(page, 17, 'listener');
  await pausePlayer(page);
  const rested = await snapshotOf(page);
  await expect
    .poll(async () => {
      const progress = (await readProgress(attemptId)) as {
        positionSeconds?: number;
      } | null;
      return progress?.positionSeconds ?? -1;
    })
    .toBeGreaterThan(rested.currentTime - 1);

  await page.reload();
  await waitForPlayer(page);
  const restored = await snapshotOf(page);
  expect(restored.paused).toBe(true);
  expect(
    Math.abs(restored.currentTime - rested.currentTime),
  ).toBeLessThanOrEqual(REVISION_TOLERANCE_SECONDS);
  expect(restored.marker).toBeNull();
  expect(attemptIdOfUrl(page)).toBe(attemptId);
  expect((await readAttempts(guest.sessionId)).map((item) => item.id)).toEqual([
    attemptId,
  ]);

  await expect(card(page, 'hoeren-2')).toBeVisible();
  await page.getByTestId('go-to-question-1').click();
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();
  await page.getByTestId('audio-toggle').click();
  await expect(page.getByTestId('audio-toggle')).toHaveAttribute(
    'data-playing',
    'true',
  );

  // The next choice continues above the stored revision.
  await optionIn(card(page, 'hoeren-1'), fullWrongOf('hoeren-1')).check();
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  expect(await readAnswerRows(attemptId)).toEqual([
    {
      question_id: 'hoeren-1',
      option_id: fullWrongOf('hoeren-1'),
      revision: 3,
    },
  ]);
  await guest.close();
});

// Lifecycle -------------------------------------------------------------------

test('result and cancellation lead to choice then clean explicit new attempt', async ({
  browser,
}) => {
  const guest = await enterGuest(browser);
  const { page, sessionId } = guest;

  await startSelection(page, 'hoeren');
  const first = attemptIdOfUrl(page);
  await optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')).check();
  await expectStatus(card(page, 'hoeren-1'), 'saved');
  await finishFromShell(page);
  const events = await readEventKinds(first);
  const before = await startCounts(sessionId);
  expect(before).toEqual({ attempts: 1, commands: 1 });

  await page.getByTestId('restart-attempt').click();
  await page.waitForURL('**/practice/*');
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/practice/${SLUG}`);
  expect(await startCounts(sessionId)).toEqual(before);
  expect(await runsOf(sessionId)).toBe(1);
  expect(await readEventKinds(first)).toEqual(events);

  await startSelection(page, 'lesen');
  const second = attemptIdOfUrl(page);
  expect(second).not.toBe(first);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(page.getByTestId('audio-element')).toHaveCount(0);
  await expect(page.locator('input:checked')).toHaveCount(0);
  expect(await readAnswers(second)).toEqual({});
  expect(await startCounts(sessionId)).toEqual({ attempts: 2, commands: 2 });

  await optionIn(card(page, 'lesen-1'), fullKeyOf('lesen-1')).check();
  await expectStatus(card(page, 'lesen-1'), 'saved');
  await page.getByTestId('cancel-attempt').click();
  await page.getByTestId('cancel-confirm').click();
  await page.waitForURL('**/practice/*');
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  const statuses = Object.fromEntries(
    (await readAttempts(sessionId)).map((item) => [item.id, item.status]),
  );
  expect(statuses).toEqual({ [first]: 'completed', [second]: 'cancelled' });
  expect(await startCounts(sessionId)).toEqual({ attempts: 2, commands: 2 });
  expect(await runsOf(sessionId)).toBe(2);
  expect(await readResults(second)).toEqual([]);

  await startSelection(page, 'all');
  const third = attemptIdOfUrl(page);
  expect([first, second]).not.toContain(third);
  await waitForPlayer(page);
  await expect(page.locator('input:checked')).toHaveCount(0);
  expect((await snapshotOf(page)).currentTime).toBeLessThan(1);
  expect(await readAnswers(third)).toEqual({});
  expect(await readProgress(third)).not.toMatchObject({ positionSeconds: 17 });
  expect(await startCounts(sessionId)).toEqual({ attempts: 3, commands: 3 });
  await guest.close();
});

test('cancelled route and old start replay cannot resume or create run', async ({
  browser,
}) => {
  const created = await newGuest(depsNow());
  const sessionId = created.guest.sessionId;
  const commandId = randomUUID();
  const started = await startFor(depsNow(), created.token, SLUG, {
    commandId,
    selection: 'hoeren',
  });
  if (!started.ok) throw new Error(`start: ${started.failure}`);
  const attemptId = started.result.attemptId;
  await seedAnswer(created.token, attemptId, 'hoeren-1', fullKeyOf('hoeren-1'));

  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId,
  });
  if (!status.ok) throw new Error(`status: ${status.failure}`);
  const cancelled = await cancelAttempt(depsNow(), created.token, {
    attemptId,
    commandId: randomUUID(),
    confirmation: {
      phaseRevision: status.result.state.phaseRevision,
      skipped: status.result.skipped,
    },
  });
  expect(cancelled).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });
  const events = await readEventKinds(attemptId);
  const answers = await readAnswerRows(attemptId);

  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: created.token, url: ORIGIN },
  ]);
  const page = await context.newPage();
  const response = await page.goto(attemptUrl(SLUG, attemptId));
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('training-shell')).toHaveCount(0);
  const lesen = await page.goto(attemptLesenUrl(SLUG, attemptId));
  expect(lesen?.status()).toBe(404);
  await context.close();

  const replay = await startAttempt(depsNow(), created.token, {
    ...(await startBody(SLUG, { selection: 'hoeren' })),
    commandId,
  });
  if (replay.ok) expect(replay.result.attemptId).toBe(attemptId);
  expect(await startCounts(sessionId)).toEqual({ attempts: 1, commands: 1 });
  expect(await runsOf(sessionId)).toBe(1);
  const [only] = await readAttempts(sessionId);
  expect(only).toMatchObject({ id: attemptId, status: 'cancelled' });
  expect(await readEventKinds(attemptId)).toEqual(events);
  expect(await readAnswerRows(attemptId)).toEqual(answers);
  expect(await readResults(attemptId)).toEqual([]);

  // Only a new explicit command creates another attempt.
  const next = await startFor(depsNow(), created.token, SLUG, {
    selection: 'hoeren',
  });
  if (!next.ok) throw new Error(`start: ${next.failure}`);
  expect(next.result.attemptId).not.toBe(attemptId);
  expect(await startCounts(sessionId)).toEqual({ attempts: 2, commands: 2 });
});
