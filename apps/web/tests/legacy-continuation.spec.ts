import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  getAttemptReview,
  readAttemptStatus,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttempts,
  readProgress,
  readResults,
  readRunRows,
  startFor,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import {
  attemptLesenUrl,
  attemptUrl,
  card,
  expectStatus,
  finishFromShell,
  goToLesen,
  optionIn,
  waitForPlayer,
  snapshotOf,
} from './support/guest-browser';
import {
  historicalActiveSql,
  historicalCompletionSql,
  snapshotSql,
} from './support/legacy-attempt';
import type { HistoricalActive } from './support/legacy-attempt';
import { psql, psqlJson, quote } from './support/sql';

// Attempts of M1 carried over to M2: the rows the transfer leaves behind (an
// exam, a free training run over the whole version, the answers with their
// revisions, the place) are written by the owner helper in one committed
// transaction and then opened in the browser. Expected numbers come from the
// fixture, not from the code under test.

const ORIGIN = 'http://localhost:3102';
const SLUG = FULL_EXAM.slug;
const { questions } = FULL_PILOT.content;
const ALL_IDS = questions.map((item) => item.id);
const SEEK_SECONDS = 12;
const SEEK_TOLERANCE = 0.5;
const HOUR_MS = 3_600_000;

const version = async (slug: string) => {
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error(`no version of ${slug}`);
  return latest;
};

const agoIso = (hours: number): string =>
  new Date(Date.now() - hours * HOUR_MS).toISOString();

const commit = (...statements: string[]) =>
  psql(['begin;', ...statements, 'commit;'].join('\n'));

const snapshotOf_ = (...ids: string[]) =>
  psqlJson<Record<string, Record<string, unknown>>>(snapshotSql(ids));

const activeOf = async (
  created: CreatedGuest,
  overrides: Partial<HistoricalActive> = {},
): Promise<HistoricalActive> => {
  const latest = await version(SLUG);
  return {
    id: randomUUID(),
    sessionId: created.guest.sessionId,
    examId: latest.examId,
    versionId: latest.versionId,
    scope: 'full-exam',
    createdAt: agoIso(2),
    answers: {},
    progress: null,
    ...overrides,
  };
};

const keyAnswers = (
  ids: readonly string[],
  revision: number,
): HistoricalActive['answers'] =>
  Object.fromEntries(
    ids.map((id) => [id, { optionId: fullKeyOf(id), revision }]),
  );

const browserOf = async (browser: Browser, token: string) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: GUEST_COOKIE, value: token, url: ORIGIN }]);
  return { context, page: await context.newPage() };
};

const answersOf = (attemptId: string) => readAnswerRows(attemptId);

interface StoredResult {
  scope: string;
  score: number;
  max_score: number;
  level: string | null;
}

const resultOf = async (attemptId: string): Promise<StoredResult> => {
  const rows = (await readResults(attemptId)) as StoredResult[];
  const [row] = rows;
  if (rows.length !== 1 || !row) throw new Error('one result row expected');
  return row;
};

test('migrated legacy attempt resumes submits and cancels', async ({
  browser,
}) => {
  const resumed = await newGuest(depsNow());
  const answers = {
    'hoeren-1': { optionId: fullKeyOf('hoeren-1'), revision: 3 },
    'hoeren-2': { optionId: fullWrongOf('hoeren-2'), revision: 2 },
    'lesen-1': { optionId: fullKeyOf('lesen-1'), revision: 1 },
  };
  const legacy = await activeOf(resumed, {
    answers,
    progress: {
      block: 'hoeren',
      hoeren: { itemId: 'hoeren-2' },
      positionSeconds: SEEK_SECONDS,
    },
  });
  commit(historicalActiveSql(legacy));

  const { context, page } = await browserOf(browser, resumed.token);
  await page.goto(attemptUrl(SLUG, legacy.id));
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-attempt-id',
    legacy.id,
  );
  await expect(card(page, 'hoeren-2')).toBeVisible();
  await expect(
    optionIn(card(page, 'hoeren-2'), fullWrongOf('hoeren-2')),
  ).toBeChecked();
  await waitForPlayer(page);
  const resting = await snapshotOf(page);
  expect(resting.paused).toBe(true);
  expect(Math.abs(resting.currentTime - SEEK_SECONDS)).toBeLessThanOrEqual(
    SEEK_TOLERANCE,
  );
  await page.getByTestId('go-to-question-1').click();
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();

  // The run is a free training: the carried-over attempt has no timer.
  const [run] = await readRunRows(legacy.id);
  expect(run).toMatchObject({ mode: 'training', selection: 'all' });
  expect(run?.assignment.questionIds).toEqual(ALL_IDS);

  // The next choice continues above the stored revision.
  await page.getByTestId('go-to-question-2').click();
  await optionIn(card(page, 'hoeren-2'), fullKeyOf('hoeren-2')).check();
  await expectStatus(card(page, 'hoeren-2'), 'saved');
  await goToLesen(page);
  await expect(
    optionIn(card(page, 'lesen-1'), fullKeyOf('lesen-1')),
  ).toBeChecked();
  expect(await answersOf(legacy.id)).toEqual([
    { question_id: 'hoeren-1', option_id: fullKeyOf('hoeren-1'), revision: 3 },
    { question_id: 'hoeren-2', option_id: fullKeyOf('hoeren-2'), revision: 3 },
    { question_id: 'lesen-1', option_id: fullKeyOf('lesen-1'), revision: 1 },
  ]);

  await finishFromShell(page);
  await expect(page.getByTestId('result-score')).toContainText('3 of 45');
  expect(await resultOf(legacy.id)).toMatchObject({
    scope: 'full-exam',
    score: 3,
    max_score: 45,
  });
  await context.close();

  const cancelled = await newGuest(depsNow());
  const second = await activeOf(cancelled, {
    answers: keyAnswers(['hoeren-1', 'hoeren-2'], 2),
    progress: { block: 'hoeren', hoeren: { itemId: 'hoeren-1' } },
  });
  commit(historicalActiveSql(second));
  const other = await browserOf(browser, cancelled.token);
  await other.page.goto(attemptUrl(SLUG, second.id));
  await expect(card(other.page, 'hoeren-1')).toBeVisible();
  await other.page.getByTestId('cancel-attempt').click();
  await other.page.getByTestId('cancel-confirm').click();
  await other.page.waitForURL('**/practice/*');
  await expect(other.page.getByTestId('mode-selection')).toBeVisible();
  const [attempt] = await readAttempts(cancelled.guest.sessionId);
  expect(attempt).toMatchObject({ id: second.id, status: 'cancelled' });
  expect(await readResults(second.id)).toEqual([]);
  expect(await answersOf(second.id)).toEqual([
    { question_id: 'hoeren-1', option_id: fullKeyOf('hoeren-1'), revision: 2 },
    { question_id: 'hoeren-2', option_id: fullKeyOf('hoeren-2'), revision: 2 },
  ]);
  await other.context.close();
});

const completedOf = async (created: CreatedGuest) => {
  const latest = await version(SLUG);
  return {
    id: randomUUID(),
    sessionId: created.guest.sessionId,
    examId: latest.examId,
    versionId: latest.versionId,
    scope: 'short-set' as const,
    createdAt: agoIso(3),
    completedAt: agoIso(2),
    answers: Object.fromEntries(ALL_IDS.map((id) => [id, fullKeyOf(id)])),
    result: {
      score: 45,
      maxScore: 45,
      correct: 45,
      incorrect: 0,
      skipped: 0,
    },
  };
};

test('legacy full scope and completed result remain unchanged', async ({
  browser,
}) => {
  // A high-scoring short set on the full version: a new normal run over the
  // same answers would have scored a level, the stored result does not.
  const finished = await newGuest(depsNow());
  const completion = await completedOf(finished);
  commit(
    historicalCompletionSql(completion),
    `select m2_private.mark_legacy_completed(${quote(completion.id)});`,
  );
  const before = snapshotOf_(completion.id);

  const { context, page } = await browserOf(browser, finished.token);
  await page.goto(attemptUrl(SLUG, completion.id));
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('result-score')).toHaveText(
    '45 of 45 points (100.0%)',
  );
  await expect(page.getByTestId('result-level')).toHaveCount(0);
  await expect(page.getByTestId('result-untimed')).toHaveCount(0);
  await expect(page.getByTestId('result-scope')).toContainText(
    'not an official DTZ level',
  );
  expect(snapshotOf_(completion.id)).toEqual(before);

  // A new explicit start leaves the old completion as it was.
  const started = await startFor(depsNow(), finished.token, SLUG);
  if (!started.ok) throw new Error(`start: ${started.failure}`);
  expect(started.result.attemptId).not.toBe(completion.id);
  await page.goto(attemptUrl(SLUG, completion.id));
  await expect(page.getByTestId('result-score')).toHaveText(
    '45 of 45 points (100.0%)',
  );
  expect(snapshotOf_(completion.id)).toEqual(before);
  await context.close();

  // An open full-exam attempt keeps its scope, version and assignment.
  const open = await newGuest(depsNow());
  const legacy = await activeOf(open, {
    answers: keyAnswers(['hoeren-1', 'lesen-1'], 2),
    progress: { block: 'hoeren', hoeren: { itemId: 'hoeren-1' } },
  });
  commit(historicalActiveSql(legacy));
  const kept = snapshotOf_(legacy.id)[legacy.id];
  const opened = await browserOf(browser, open.token);
  await opened.page.goto(attemptUrl(SLUG, legacy.id));
  await expect(card(opened.page, 'hoeren-1')).toBeVisible();
  await opened.page.goto(attemptLesenUrl(SLUG, legacy.id));
  await expect(opened.page.getByTestId('reading-text')).toBeVisible();
  const after = snapshotOf_(legacy.id)[legacy.id];
  for (const field of ['scope', 'exam_version_id', 'exam_id', 'status']) {
    expect((after?.attempt as Record<string, unknown>)[field]).toBe(
      (kept?.attempt as Record<string, unknown>)[field],
    );
  }
  expect(kept?.attempt).toMatchObject({ scope: 'full-exam', status: 'active' });
  expect(after?.run).toEqual(kept?.run);
  expect(after?.answers).toEqual(kept?.answers);
  await opened.context.close();
});

test('legacy short set on full version does not acquire level', async ({
  browser,
}) => {
  const created = await newGuest(depsNow());
  const legacy = await activeOf(created, {
    scope: 'short-set',
    answers: keyAnswers(ALL_IDS, 2),
    progress: {
      block: 'hoeren',
      hoeren: { itemId: 'hoeren-3' },
      positionSeconds: SEEK_SECONDS,
    },
  });
  commit(historicalActiveSql(legacy));
  const initial = await answersOf(legacy.id);
  expect(initial).toHaveLength(45);

  const { context, page } = await browserOf(browser, created.token);
  await page.goto(attemptUrl(SLUG, legacy.id));
  await expect(card(page, 'hoeren-3')).toBeVisible();
  expect(await readProgress(legacy.id)).toMatchObject({
    block: 'hoeren',
    hoeren: { itemId: 'hoeren-3' },
  });
  expect(await answersOf(legacy.id)).toEqual(initial);

  // Everything is answered: no confirmation, one submission.
  await page.getByTestId('finish-attempt').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.getByTestId('result-score')).toHaveText(
    '45 of 45 points (100.0%)',
  );
  await expect(page.getByTestId('result-level')).toHaveCount(0);
  await expect(page.getByTestId('result-scope')).toBeVisible();
  expect(await resultOf(legacy.id)).toMatchObject({
    scope: 'short-set',
    score: 45,
    max_score: 45,
    level: null,
  });
  expect(await answersOf(legacy.id)).toEqual(initial);
  await context.close();
});

test('foreign legacy history is refused without mutation', async ({
  browser,
}) => {
  const owner = await newGuest(depsNow());
  const intruder = await newGuest(depsNow());
  const completion = await completedOf(owner);
  commit(
    historicalCompletionSql(completion),
    `select m2_private.mark_legacy_completed(${quote(completion.id)});`,
  );
  const before = snapshotOf_(completion.id);

  const { context, page } = await browserOf(browser, intruder.token);
  const response = await page.goto(attemptUrl(SLUG, completion.id));
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('training-shell')).toHaveCount(0);
  await expect(page.getByTestId('attempt-review')).toHaveCount(0);
  const lesen = await page.goto(attemptLesenUrl(SLUG, completion.id));
  expect(lesen?.status()).toBe(404);
  await context.close();

  expect(
    await getAttemptReview(depsNow(), intruder.token, {
      attemptId: completion.id,
    }),
  ).toEqual({ ok: false, error: 'attempt-not-found' });
  expect(
    await readAttemptStatus(depsNow(), intruder.token, {
      attemptId: completion.id,
    }),
  ).toEqual({ ok: false, failure: 'not-found' });
  expect(snapshotOf_(completion.id)).toEqual(before);
  expect(await readAttempts(intruder.guest.sessionId)).toEqual([]);
});

test('legacy continuation backfill is scoped to its own fixture', async () => {
  const pilot = await version(PILOT_EXAM_SLUG);
  const first = await newGuest(depsNow());
  const second = await newGuest(depsNow());
  const own = await activeOf(first, {
    answers: keyAnswers(['hoeren-1', 'lesen-1'], 4),
    progress: { block: 'lesen', lesen: { itemId: 'lesen-1' } },
  });
  const neighbour = await activeOf(second, {
    examId: pilot.examId,
    versionId: pilot.versionId,
    scope: 'short-set',
    answers: { 'hoeren-1': { optionId: 'a', revision: 7 } },
    progress: { block: 'hoeren', hoeren: { itemId: 'hoeren-1' } },
  });

  const keep = (key: string) =>
    `insert into pg_temp.summary values (${quote(key)}, (${snapshotSql([
      neighbour.id,
    ])}));`;
  const summary = psqlJson<Record<string, Record<string, unknown>>>(
    [
      'begin;',
      'create temp table summary (key text primary key, value jsonb);',
      historicalActiveSql(own, { hasRun: false }),
      historicalActiveSql(neighbour, { hasRun: false }),
      keep('neighbourBefore'),
      `select * from m2_private.backfill_m1_attempts(${quote(own.id)});`,
      keep('neighbourAfter'),
      'commit;',
      'select jsonb_object_agg(key, value) from pg_temp.summary;',
    ].join('\n'),
  );
  expect(summary.neighbourAfter).toEqual(summary.neighbourBefore);

  const committed = snapshotOf_(own.id, neighbour.id);
  expect(committed[neighbour.id]).toEqual(
    summary.neighbourBefore?.[neighbour.id],
  );
  expect(committed[neighbour.id]?.run).toBeNull();
  expect(committed[neighbour.id]?.attempt).toMatchObject({
    scope: 'short-set',
    status: 'active',
    exam_id: pilot.examId,
    progress: neighbour.progress,
  });
  expect(committed[neighbour.id]?.answers).toMatchObject([
    { question_id: 'hoeren-1', option_id: 'a', revision: 7 },
  ]);

  // Only the named attempt got its run, over the whole version.
  const [run] = await readRunRows(own.id);
  expect(run).toMatchObject({ mode: 'training', selection: 'all' });
  expect(run?.assignment.questionIds).toEqual(ALL_IDS);
  expect(await readRunRows(neighbour.id)).toEqual([]);
  expect(committed[own.id]?.attempt).toMatchObject({
    scope: 'full-exam',
    exam_id: own.examId,
    progress: own.progress,
  });
  expect(committed[own.id]?.answers).toMatchObject([
    { question_id: 'hoeren-1', option_id: fullKeyOf('hoeren-1'), revision: 4 },
    { question_id: 'lesen-1', option_id: fullKeyOf('lesen-1'), revision: 4 },
  ]);
});
