import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import type { ExamContent } from '@b1k/domain';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import {
  cancelAttempt,
  getAttemptReview,
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
  submitAttempt,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { setGuestLocale } from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttempts,
  readResults,
  readRunRows,
  repeatFor,
  serviceDb,
  startFor,
  submitStored,
} from './support/db';
import {
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  ensureConfirmedTestProfile,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  attemptLesenUrl,
  attemptUrl,
  card,
  expectStatus,
  optionIn,
} from './support/guest-browser';
import { historicalCompletionSql } from './support/legacy-attempt';
import { goToStep } from './support/release';
import { psql, psqlJson, quote, sqlRunnerAs } from './support/sql';

// The free repeat of the guest's own errors (#47) on exams of their own: a
// copy of the synthetic full set (20 Hören, 25 Lesen, Teil 3 pairs, the Teil
// 4 shared set, Lesen texts) under a unique slug, so a newer version can be
// published without touching the shared fixtures. Expected ids come from the
// fixture, not from the code under test.

const ORIGIN = 'http://localhost:3102';

// The two strings the specs check in one known language each, read from the
// message files themselves rather than copied.
interface Messages {
  results: { repeatEmpty: string };
  practice: { context: string };
}

const messagesOf = (locale: 'en' | 'ru'): Messages =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '..', 'messages', `${locale}.json`),
      'utf8',
    ),
  ) as Messages;

const en = messagesOf('en');
const ru = messagesOf('ru');
const { questions } = FULL_PILOT.content;
const ALL_IDS = questions.map((item) => item.id);
const HOEREN_IDS = questions
  .filter((item) => item.skill === 'hoeren')
  .map((item) => item.id);

interface Exam {
  slug: string;
  examId: string;
  versionId: string;
}

let counter = 0;

const publish = async (slug: string, content: ExamContent) =>
  publishExamVersion(serviceDb, {
    slug,
    title: 'Repeat test',
    format: 'DTZ',
    content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording() }],
  });

const newExam = async (): Promise<Exam> => {
  const slug = `test-repeat-${Date.now().toString(36)}-${counter++}`;
  const outcome = await publish(slug, FULL_PILOT.content);
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error(`exam ${slug} was not published`);
  return { slug, examId: latest.examId, versionId: outcome.versionId };
};

// The same set with one prompt corrected: a newer version of the exam.
const publishCorrection = async (exam: Exam): Promise<string> => {
  const outcome = await publish(exam.slug, {
    ...FULL_PILOT.content,
    questions: questions.map((item) =>
      item.id === 'hoeren-1'
        ? { ...item, prompt: `${item.prompt} (v2)` }
        : item,
    ),
  });
  expect(outcome.versionId).not.toBe(exam.versionId);
  return outcome.versionId;
};

const started = async (
  guest: CreatedGuest,
  slug: string,
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const result = await startFor(depsNow(), guest.token, slug, overrides);
  if (!result.ok || result.result.outcome !== 'accepted') {
    throw new Error(`start not accepted: ${JSON.stringify(result)}`);
  }
  return result.result.attemptId;
};

// Answers every given task: the key, a wrong option, or nothing (skipped).
type Plan = Readonly<Record<string, 'right' | 'wrong' | 'skip'>>;

const answer = async (
  guest: CreatedGuest,
  attemptId: string,
  ids: readonly string[],
  plan: Plan = {},
) => {
  for (const id of ids) {
    const kind = plan[id] ?? 'right';
    if (kind === 'skip') continue;
    const optionId = kind === 'right' ? fullKeyOf(id) : fullWrongOf(id);
    const saved = await saveAnswer(depsNow(), guest.token, {
      attemptId,
      questionId: id,
      optionId,
      revision: 1,
    });
    if (!saved.ok) throw new Error(`answer ${id}: ${saved.error}`);
  }
};

const complete = async (guest: CreatedGuest, attemptId: string) => {
  const finished = await submitStored(depsNow(), guest.token, { attemptId });
  if (!finished.ok) throw new Error(`complete: ${finished.error}`);
  return finished.review;
};

// A completed source of the whole set with the given errors and skips.
const completedSource = async (
  guest: CreatedGuest,
  exam: Exam,
  plan: Plan,
  selection = 'all',
) => {
  const id = await started(guest, exam.slug, { selection });
  const ids = selection === 'all' ? ALL_IDS : HOEREN_IDS;
  await answer(guest, id, ids, plan);
  await complete(guest, id);
  return id;
};

const sourceOf = (exam: Exam, attemptId: string, selection = 'all') => ({
  attemptId,
  versionId: exam.versionId,
  selection,
});

const repeated = async (
  guest: CreatedGuest,
  exam: Exam,
  sourceId: string,
  overrides: Record<string, unknown> = {},
) => {
  const result = await repeatFor(
    depsNow(),
    guest.token,
    exam.slug,
    sourceOf(exam, sourceId),
    overrides,
  );
  if (!result.ok || result.result.outcome !== 'accepted') {
    throw new Error(`repeat not accepted: ${JSON.stringify(result)}`);
  }
  return result.result.attemptId;
};

interface Counts {
  attempts: number;
  runs: number;
  commands: number;
  events: number;
  results: number;
}

const countsOf = (guest: CreatedGuest): Counts =>
  psqlJson<Counts>(`select json_build_object(
    'attempts', (select count(*) from public.attempts
      where guest_session_id = ${quote(guest.guest.sessionId)}),
    'runs', (select count(*) from public.attempt_runs r
      join public.attempts a on a.id = r.attempt_id
      where a.guest_session_id = ${quote(guest.guest.sessionId)}),
    'commands', (select count(*) from public.attempt_commands
      where guest_session_id = ${quote(guest.guest.sessionId)}),
    'events', (select count(*) from public.guest_events
      where visitor_id = ${quote(guest.guest.visitorId)}),
    'results', (select count(*) from public.attempt_results x
      join public.attempts a on a.id = x.attempt_id
      where a.guest_session_id = ${quote(guest.guest.sessionId)}))`);

const activeOf = async (guest: CreatedGuest) =>
  (await readAttempts(guest.guest.sessionId)).filter(
    (row) => row.status === 'active',
  );

const versionOfAttempt = (attemptId: string): string =>
  psql(`select exam_version_id from public.attempts
    where id = ${quote(attemptId)}`);

const pageOf = async (guest: CreatedGuest, exam: Exam, attemptId: string) => {
  const read = await readAttemptPage(
    depsNow(),
    guest.guest,
    exam.slug,
    attemptId,
  );
  if (read.status !== 'ready') throw new Error(`page is ${read.status}`);
  return read.practice;
};

const browserOf = async (browser: Browser, guest: CreatedGuest) => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: guest.token, url: ORIGIN },
  ]);
  return { context, page: await context.newPage() };
};

const cancelled = async (guest: CreatedGuest, attemptId: string) => {
  const status = await readAttemptStatus(depsNow(), guest.token, {
    attemptId,
  });
  if (!status.ok || status.result.outcome !== 'active') {
    throw new Error('cancel needs an active attempt');
  }
  const result = await cancelAttempt(depsNow(), guest.token, {
    attemptId,
    commandId: randomUUID(),
    confirmation: {
      phaseRevision: status.result.state.phaseRevision,
      skipped: status.result.skipped,
    },
  });
  if (!result.ok || result.result.outcome !== 'accepted') {
    throw new Error(`cancel: ${JSON.stringify(result)}`);
  }
};

// The direct production start with a repeat payload, as a forged server
// call would send it.
const directRepeat = (
  guest: CreatedGuest,
  exam: Exam,
  sourceId: string,
  questionIds: readonly string[],
  overrides: Record<string, unknown> = {},
) =>
  serviceDb.rpc('m2_start_attempt', {
    p_session_id: guest.guest.sessionId,
    p_exam_id: exam.examId,
    p_command_id: randomUUID(),
    p_mode: 'training',
    p_purpose: 'error-repeat',
    p_selection: 'all',
    p_source_attempt_id: sourceId,
    p_version_id: exam.versionId,
    p_scope: 'short-set',
    p_question_ids: questionIds,
    ...overrides,
  });

// Errors in a Teil 3 pair, the Teil 4 shared set and a Lesen text.
const GROUP_PLAN: Plan = {
  'hoeren-10': 'wrong',
  'hoeren-18': 'skip',
  'lesen-12': 'wrong',
};
const GROUP_REPEAT = ['hoeren-10', 'hoeren-18', 'lesen-12'];

test('repeat pins source version and selects only assigned errors and skips', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, {
    'hoeren-2': 'wrong',
    'hoeren-11': 'skip',
    'lesen-4': 'wrong',
    'lesen-20': 'skip',
  });
  // A newer version is published after the source was completed.
  const v2 = await publishCorrection(exam);

  const repeatId = await repeated(guest, exam, sourceId);
  const [run] = await readRunRows(repeatId);
  expect(run).toMatchObject({
    mode: 'training',
    purpose: 'error-repeat',
    selection: 'all',
    source_attempt_id: sourceId,
    assignment: {
      versionId: exam.versionId,
      questionIds: ['hoeren-2', 'hoeren-11', 'lesen-4', 'lesen-20'],
    },
  });
  expect(versionOfAttempt(repeatId)).toBe(exam.versionId);
  expect(
    psql(`select scope from public.attempts
    where id = ${quote(repeatId)}`),
  ).toBe('short-set');
  // The repeat opens empty on the pinned version, without the newer prompt.
  const practice = await pageOf(guest, exam, repeatId);
  expect(practice.selections).toEqual({});
  expect(practice.versionId).toBe(exam.versionId);
  expect(JSON.stringify(practice)).not.toContain('(v2)');

  // A repeat on the newer version is not the source version: not found.
  await answer(guest, repeatId, ['hoeren-2', 'lesen-4'], {});
  await complete(guest, repeatId);
  expect(
    await repeatFor(depsNow(), guest.token, exam.slug, {
      attemptId: sourceId,
      versionId: v2,
    }),
  ).toEqual({ ok: false, failure: 'not-found' });

  // The repeat of the repeat keeps only what is still wrong or skipped.
  const secondId = await repeated(guest, exam, repeatId);
  const [second] = await readRunRows(secondId);
  expect(second?.assignment).toEqual({
    versionId: exam.versionId,
    questionIds: ['hoeren-11', 'lesen-20'],
  });
  expect(second?.source_attempt_id).toBe(repeatId);
});

test('repeat never broadens source scope to unassigned questions', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  // A Hören-only source with one wrong and one skipped task: its Lesen is
  // not assigned, so it is never a skip of the source.
  const sourceId = await completedSource(
    guest,
    exam,
    { 'hoeren-3': 'wrong', 'hoeren-7': 'skip' },
    'hoeren',
  );
  const source = sourceOf(exam, sourceId, 'hoeren');
  const before = countsOf(guest);
  expect(
    await repeatFor(depsNow(), guest.token, exam.slug, {
      ...source,
      selection: 'all',
    }),
  ).toEqual({ ok: false, failure: 'invalid-input' });
  expect(countsOf(guest)).toEqual(before);

  const repeatResult = await repeatFor(
    depsNow(),
    guest.token,
    exam.slug,
    source,
  );
  if (!repeatResult.ok || repeatResult.result.outcome !== 'accepted') {
    throw new Error('repeat expected');
  }
  const repeatId = repeatResult.result.attemptId;
  const [run] = await readRunRows(repeatId);
  expect(run?.selection).toBe('hoeren');
  expect(run?.assignment.questionIds).toEqual(['hoeren-3', 'hoeren-7']);

  // Nothing answered in the repeat: its own two tasks, nothing more.
  await complete(guest, repeatId);
  const second = await repeatFor(depsNow(), guest.token, exam.slug, {
    ...source,
    attemptId: repeatId,
  });
  if (!second.ok || second.result.outcome !== 'accepted') {
    throw new Error('second repeat expected');
  }
  const [secondRun] = await readRunRows(second.result.attemptId);
  expect(secondRun?.assignment.questionIds).toEqual(['hoeren-3', 'hoeren-7']);
});

test('group context stays visible readonly and outside score', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, GROUP_PLAN);
  const repeatId = await repeated(guest, exam, sourceId);

  const practice = await pageOf(guest, exam, repeatId);
  expect(practice.questions.map((item) => item.id)).toEqual(GROUP_REPEAT);
  // Teil 3: the other task of the pair; Teil 4: the other two of the set.
  expect(practice.context.map((item) => item.questionId)).toEqual([
    'hoeren-11',
    'hoeren-19',
    'hoeren-20',
  ]);
  // Lesen: the whole linked text, none of its other tasks.
  expect(practice.texts.map((item) => item.id)).toEqual(['lesen-text-3']);
  const lesenShown = JSON.stringify(practice);
  for (const id of ['lesen-11', 'lesen-13', 'lesen-16']) {
    expect(lesenShown).not.toContain(`"${id}"`);
  }

  await answer(guest, repeatId, GROUP_REPEAT);
  const review = await complete(guest, repeatId);
  expect(review).toMatchObject({
    scope: 'short-set',
    showsLevel: false,
    score: 3,
    maxScore: 3,
    level: null,
    skills: null,
  });
  expect(review.items.map((item) => item.questionId)).toEqual(GROUP_REPEAT);
});

test('empty and full size repeat preserve purpose rules', async () => {
  const exam = await newExam();
  const perfect = await newGuest(depsNow());
  const perfectId = await completedSource(perfect, exam, {});
  const before = countsOf(perfect);
  expect(
    await repeatFor(
      depsNow(),
      perfect.token,
      exam.slug,
      sourceOf(exam, perfectId),
    ),
  ).toEqual({
    ok: true,
    result: { outcome: 'empty', sourceAttemptId: perfectId },
  });
  expect(countsOf(perfect)).toEqual(before);
  // Directly, an empty set is no assignment either.
  const empty = await directRepeat(perfect, exam, perfectId, []);
  expect(empty.error?.hint).toBe('assignment_invalid');
  expect(countsOf(perfect)).toEqual(before);

  // All 45 skipped: the repeat has all 45 tasks and is still free, without a
  // level, although a normal run of the same tasks would be a full exam.
  const idle = await newGuest(depsNow());
  const idleId = await started(idle, exam.slug);
  await complete(idle, idleId);
  const repeatId = await repeated(idle, exam, idleId);
  const [run] = await readRunRows(repeatId);
  expect(run?.assignment.questionIds).toEqual(ALL_IDS);
  expect(
    psql(`select scope from public.attempts
    where id = ${quote(repeatId)}`),
  ).toBe('short-set');
  expect(
    psql(`select timing_profile_revision_id is null
      from public.attempt_runs where attempt_id = ${quote(repeatId)}`),
  ).toBe('t');
  await answer(idle, repeatId, ALL_IDS);
  const review = await complete(idle, repeatId);
  expect(review).toMatchObject({
    scope: 'short-set',
    showsLevel: false,
    score: 45,
    maxScore: 45,
    level: null,
    skills: null,
  });
});

test('concurrent repeat sources share one active slot and replay id', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const first = await completedSource(guest, exam, { 'hoeren-1': 'wrong' });
  const second = await completedSource(guest, exam, { 'lesen-1': 'skip' });
  const before = countsOf(guest);
  const commands = [randomUUID(), randomUUID()];
  const answers = await Promise.all(
    [first, second].map((sourceId, index) =>
      repeatFor(depsNow(), guest.token, exam.slug, sourceOf(exam, sourceId), {
        commandId: commands[index],
      }),
    ),
  );
  const outcomes = answers.map((item) =>
    item.ok ? item.result.outcome : item.failure,
  );
  expect([...outcomes].sort()).toEqual(['accepted', 'conflict']);
  const winner = answers.find(
    (item) => item.ok && item.result.outcome === 'accepted',
  );
  if (!winner?.ok || winner.result.outcome === 'empty') {
    throw new Error('no winner');
  }
  const winnerId = winner.result.attemptId;
  for (const item of answers) {
    expect(item).toMatchObject({ ok: true, result: { attemptId: winnerId } });
  }
  expect((await activeOf(guest)).map((row) => row.id)).toEqual([winnerId]);
  const afterRace = countsOf(guest);
  expect(afterRace).toMatchObject({
    attempts: before.attempts + 1,
    runs: before.runs + 1,
    commands: before.commands + 1,
  });

  // The winning command replays its attempt; nothing is written.
  const winnerIndex = outcomes.indexOf('accepted');
  const replay = await repeatFor(
    depsNow(),
    guest.token,
    exam.slug,
    sourceOf(exam, [first, second][winnerIndex] ?? ''),
    { commandId: commands[winnerIndex] },
  );
  expect(replay).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: winnerId },
  });
  expect(countsOf(guest)).toEqual(afterRace);
});

test('review repeat action handles empty conflict and pinned source', async ({
  browser,
}) => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const perfectId = await completedSource(guest, exam, {});
  const sourceId = await completedSource(guest, exam, {
    'hoeren-1': 'wrong',
    'lesen-2': 'skip',
  });
  await publishCorrection(exam);
  const { context, page } = await browserOf(browser, guest);

  // The review of the source starts the repeat and opens it empty.
  await page.goto(attemptUrl(exam.slug, sourceId));
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await page.getByTestId('repeat-errors').click();
  await page.waitForURL((url) => !url.pathname.includes(sourceId));
  const [active] = await activeOf(guest);
  if (!active) throw new Error('repeat not started');
  expect(page.url()).toContain(active.id);
  expect(versionOfAttempt(active.id)).toBe(exam.versionId);
  const [run] = await readRunRows(active.id);
  expect(run?.assignment.questionIds).toEqual(['hoeren-1', 'lesen-2']);
  await expect(page.getByTestId('attempt-review')).toHaveCount(0);
  await expectStatus(card(page, 'hoeren-1'), 'idle');
  expect(await readAnswerRows(active.id)).toEqual([]);

  // A second repeat meets the active one and opens it: no second run.
  const counts = countsOf(guest);
  await page.goto(attemptUrl(exam.slug, sourceId));
  await page.getByTestId('repeat-errors').click();
  await page.waitForURL((url) => url.pathname.includes(active.id));
  expect(countsOf(guest)).toEqual(counts);

  // Nothing to repeat: a localized message, no start, the page stays.
  await page.goto(attemptUrl(exam.slug, perfectId));
  await page.getByTestId('repeat-errors').click();
  await expect(page.getByTestId('repeat-status')).toHaveText(
    en.results.repeatEmpty,
  );
  expect(page.url()).toContain(perfectId);
  expect(countsOf(guest)).toEqual(counts);
  await context.close();
});

test('repeat mixed group context is readonly localized and navigable', async ({
  browser,
}) => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, GROUP_PLAN);
  const repeatId = await repeated(guest, exam, sourceId);
  const { context, page } = await browserOf(browser, guest);

  await page.goto(attemptUrl(exam.slug, repeatId));
  // Teil 3: the assessed task with its read-only neighbour of the pair.
  const assessed = card(page, 'hoeren-10');
  const neighbour = page.getByTestId('context-card-hoeren-11');
  await expect(assessed).toBeVisible();
  await expect(neighbour).toBeVisible();
  await expect(neighbour.getByTestId('context-label')).toHaveText(
    en.practice.context,
  );
  await expect(neighbour.locator('input')).toHaveCount(0);
  await expect(neighbour.getByTestId('save-status')).toHaveCount(0);
  await expect(neighbour.getByTestId('review-solution')).toHaveCount(0);

  // The assessed task is answered by keyboard and confirmed by the server.
  await optionIn(assessed, fullKeyOf('hoeren-10')).focus();
  await page.keyboard.press('Space');
  await expectStatus(assessed, 'saved');

  // Teil 4: the shared list with the two read-only neighbours.
  await goToStep(page, 18);
  await expect(card(page, 'hoeren-18')).toBeVisible();
  await expect(page.getByTestId('context-card-hoeren-19')).toBeVisible();
  await expect(page.getByTestId('context-card-hoeren-20')).toBeVisible();
  await expect(page.getByTestId('shared-hoeren-teil-4')).toBeVisible();
  await expect(page.getByTestId('set-answered')).toContainText('1');

  // Lesen: the whole linked text and only the assessed task of it.
  await page.goto(attemptLesenUrl(exam.slug, repeatId));
  await expect(card(page, 'lesen-12')).toBeVisible();
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(page.getByTestId('reading-paragraph-23')).toContainText(
    'Absatz 24: Langer Lesetext zu Teil 3',
  );
  for (const id of ['lesen-11', 'lesen-13']) {
    await expect(card(page, id)).toHaveCount(0);
    await expect(page.getByTestId(`context-card-${id}`)).toHaveCount(0);
  }

  // Russian: the guest returns to the Teil 4 step it left, and the same
  // neighbours are labelled in the guest's language.
  expect(await setGuestLocale(depsNow(), guest.guest, 'ru')).toBe(true);
  await page.goto(attemptUrl(exam.slug, repeatId));
  await expect(
    page.getByTestId('context-card-hoeren-19').getByTestId('context-label'),
  ).toHaveText(ru.practice.context);
  expect(await readAnswerRows(repeatId)).toEqual([
    expect.objectContaining({ question_id: 'hoeren-10' }),
  ]);
  await context.close();
});

test('context cannot be answered or reveal keys in any projection', async ({
  browser,
  request,
}) => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, GROUP_PLAN);
  const repeatId = await repeated(guest, exam, sourceId);
  // A neighbour and a task of another part are not answerable.
  for (const questionId of ['hoeren-11', 'lesen-1']) {
    const saved = await saveAnswer(depsNow(), guest.token, {
      attemptId: repeatId,
      questionId,
      optionId: fullKeyOf(questionId),
      revision: 1,
    });
    expect(saved).toEqual({ ok: false, error: 'option-not-allowed' });
  }
  expect(await readAnswerRows(repeatId)).toEqual([]);

  const cookie = { cookie: `${GUEST_COOKIE}=${guest.token}` };
  const url = `${ORIGIN}${attemptUrl(exam.slug, repeatId)}`;
  const html = await (await request.get(url, { headers: cookie })).text();
  expect(html).toContain('context-card-hoeren-11');
  // The RSC payloads of the client navigation between the blocks.
  const { context, page } = await browserOf(browser, guest);
  // Chromium does not keep streamed RSC bodies: the navigation requests are
  // recorded with the headers the router sent and replayed by the context.
  const probes: { url: string; headers: Record<string, string> }[] = [];
  page.on('request', (sent) => {
    const headers = sent.headers();
    if (headers.rsc !== '1' || headers['next-router-prefetch']) return;
    probes.push({
      url: sent.url(),
      headers: Object.fromEntries(
        ['rsc', 'next-router-state-tree', 'next-url'].flatMap((name) => {
          const value = headers[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    });
  });
  await page.goto(url);
  await expect(page.getByTestId('context-card-hoeren-11')).toBeVisible();
  await page.getByTestId('block-link-lesen').click();
  await expect(card(page, 'lesen-12')).toBeVisible();
  await page.getByTestId('block-link-hoeren').click();
  await expect(page.getByTestId('context-card-hoeren-11')).toBeVisible();
  const replay = async (probe: (typeof probes)[number]): Promise<string> => {
    const first = await context.request.get(probe.url, {
      headers: probe.headers,
      maxRedirects: 0,
    });
    const location = first.headers().location;
    if (first.status() !== 307 || !location) return first.text();
    const again = await context.request.get(new URL(location, ORIGIN).href, {
      headers: probe.headers,
      maxRedirects: 0,
    });
    return again.text();
  };
  const rsc = await Promise.all(probes.map(replay));
  expect(rsc.some((body) => body.includes('lesen-12'))).toBe(true);
  expect(rsc.some((body) => body.includes('hoeren-11'))).toBe(true);
  for (const body of [html, ...rsc]) {
    expect(body).not.toContain('correctOptionId');
    expect(body).not.toContain('review-solution');
  }
  await context.close();

  await answer(guest, repeatId, GROUP_REPEAT);
  await complete(guest, repeatId);
  const review = await getAttemptReview(depsNow(), guest.token, {
    attemptId: repeatId,
  });
  if (!review.ok) throw new Error('review expected');
  const serialized = JSON.stringify(review.review);
  for (const id of ['hoeren-11', 'hoeren-19', 'hoeren-20', 'lesen-11']) {
    expect(serialized).not.toContain(`"${id}"`);
  }
  const reviewed = await (await request.get(url, { headers: cookie })).text();
  expect(reviewed).not.toContain('context-card-');
  expect(reviewed.match(/data-testid="review-item"/g)).toHaveLength(2);
  expect(reviewed).not.toContain('data-question-id="hoeren-11"');
});

test('readonly context refuses writes and never appears in review keys', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, GROUP_PLAN);
  const repeatId = await repeated(guest, exam, sourceId);
  // The assessed task keeps its revisions; the neighbour gets none.
  for (const revision of [1, 2]) {
    const saved = await saveAnswer(depsNow(), guest.token, {
      attemptId: repeatId,
      questionId: 'hoeren-10',
      optionId:
        revision === 1 ? fullWrongOf('hoeren-10') : fullKeyOf('hoeren-10'),
      revision,
    });
    expect(saved.ok).toBe(true);
  }
  const status = await readAttemptStatus(depsNow(), guest.token, {
    attemptId: repeatId,
  });
  if (!status.ok || status.result.outcome !== 'active') {
    throw new Error('active repeat expected');
  }
  // The summary counts only the three assessed tasks.
  expect(status.result.summary.totalAssigned).toBe(3);
  expect(status.result.skipped).toBe(2);
  const submitWithContext = await submitAttempt(depsNow(), guest.token, {
    attemptId: repeatId,
    commandId: randomUUID(),
    answers: [
      {
        questionId: 'hoeren-11',
        optionId: fullKeyOf('hoeren-11'),
        revision: 1,
      },
    ],
    confirmation: {
      phaseRevision: status.result.state.phaseRevision,
      skipped: status.result.skipped,
    },
  });
  expect(submitWithContext).toEqual({ ok: false, failure: 'invalid-input' });
  expect(await readAnswerRows(repeatId)).toEqual([
    {
      question_id: 'hoeren-10',
      option_id: fullKeyOf('hoeren-10'),
      revision: 2,
    },
  ]);
  expect(await readResults(repeatId)).toEqual([]);

  const review = await complete(guest, repeatId);
  expect(review.maxScore).toBe(3);
  expect(review.items.map((item) => item.questionId)).toEqual(GROUP_REPEAT);
  expect(review.items[0]).toMatchObject({
    questionId: 'hoeren-10',
    outcome: 'correct',
  });
  const frozen = psql(`select frozen_answers::text from public.attempt_runs
    where attempt_id = ${quote(repeatId)}`);
  expect(frozen).not.toContain('hoeren-11');
});

test('invalid repeat sources cannot create or reveal attempts', async ({
  request,
}) => {
  const exam = await newExam();
  const owner = await newGuest(depsNow());
  const stranger = await newGuest(depsNow());
  const foreignId = await completedSource(stranger, exam, {
    'hoeren-1': 'wrong',
  });
  // A cancelled, a submitted (result not stored yet) and an active attempt
  // of the owner; the active one holds the slot.
  const cancelledId = await started(owner, exam.slug);
  await cancelled(owner, cancelledId);
  const submittedId = await started(owner, exam.slug);
  const accepted = await serviceDb
    .rpc('m2_accept_submission', {
      p_session_id: owner.guest.sessionId,
      p_attempt_id: submittedId,
      p_command_id: randomUUID(),
      p_answers: [],
      p_expected_phase_revision: 0,
      p_expected_skipped: ALL_IDS.length,
    })
    .single();
  expect(accepted.error).toBeNull();
  expect(
    psql(`select status from public.attempts
    where id = ${quote(submittedId)}`),
  ).toBe('submitted');
  // The active attempt is started directly in SQL: the start route would
  // complete the submitted attempt of the slot after its commit.
  const direct = await serviceDb
    .rpc('m2_start_attempt', {
      p_session_id: owner.guest.sessionId,
      p_exam_id: exam.examId,
      p_command_id: randomUUID(),
      p_mode: 'training',
      p_purpose: 'normal',
      p_selection: 'all',
      p_source_attempt_id: null,
      p_version_id: exam.versionId,
      p_scope: 'full-exam',
      p_question_ids: ALL_IDS,
    })
    .single<{ attempt_id: string; outcome: string }>();
  if (direct.error || direct.data.outcome !== 'accepted') {
    throw new Error(`active start: ${JSON.stringify(direct)}`);
  }
  const activeId = direct.data.attempt_id;
  const before = countsOf(owner);
  const strangerBefore = countsOf(stranger);

  const sources = [foreignId, randomUUID(), activeId, cancelledId, submittedId];
  for (const sourceId of sources) {
    const result = await repeatFor(
      depsNow(),
      owner.token,
      exam.slug,
      sourceOf(exam, sourceId),
    );
    expect(result).toEqual({ ok: false, failure: 'not-found' });
    expect(JSON.stringify(result)).not.toContain(activeId);
  }
  // Over HTTP with the right origin: the same refusal, no active id.
  const response = await request.post(`${ORIGIN}/api/attempts/start`, {
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      cookie: `${GUEST_COOKIE}=${owner.token}`,
    },
    data: JSON.stringify({
      commandId: randomUUID(),
      examSlug: exam.slug,
      mode: 'training',
      purpose: 'error-repeat',
      selection: 'all',
      sourceAttemptId: foreignId,
      expectedVersionId: exam.versionId,
    }),
  });
  expect(response.status()).toBe(404);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ ok: false, failure: 'not-found' });
  expect(body).not.toContain(activeId);
  // The database refuses the same sources before the slot.
  for (const sourceId of sources) {
    const refused = await directRepeat(owner, exam, sourceId, ['hoeren-1']);
    expect(refused.error?.hint).toBe('repeat_source_invalid');
  }
  expect(countsOf(owner)).toEqual(before);
  expect(countsOf(stranger)).toEqual(strangerBefore);
  expect(
    psql(`select status from public.attempts
    where id = ${quote(submittedId)}`),
  ).toBe('submitted');
});

test('repeat conflicts and altered command replay do not create another run', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, { 'hoeren-1': 'wrong' });
  const otherId = await completedSource(guest, exam, { 'lesen-1': 'wrong' });
  const activeId = await started(guest, exam.slug);
  const before = countsOf(guest);
  expect(
    await repeatFor(
      depsNow(),
      guest.token,
      exam.slug,
      sourceOf(exam, sourceId),
    ),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: activeId },
  });
  expect(countsOf(guest)).toEqual(before);

  await complete(guest, activeId);
  const commandId = randomUUID();
  const repeatId = await repeated(guest, exam, sourceId, { commandId });
  const afterStart = countsOf(guest);
  // The same commandId with another payload: refused, nothing written.
  for (const altered of [
    { sourceAttemptId: otherId },
    { purpose: 'normal', sourceAttemptId: null },
  ]) {
    expect(
      await repeatFor(
        depsNow(),
        guest.token,
        exam.slug,
        sourceOf(exam, sourceId),
        {
          commandId,
          ...altered,
        },
      ),
    ).toEqual({ ok: false, failure: 'invalid-input' });
  }
  expect(countsOf(guest)).toEqual(afterStart);
  expect((await activeOf(guest)).map((row) => row.id)).toEqual([repeatId]);
  // The same payload replays its attempt.
  expect(
    await repeatFor(
      depsNow(),
      guest.token,
      exam.slug,
      sourceOf(exam, sourceId),
      {
        commandId,
      },
    ),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: repeatId },
  });
  expect(countsOf(guest)).toEqual(afterStart);
});

test('forged repeat source version and assignment fail without writes', async ({
  request,
}) => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, {
    'hoeren-1': 'wrong',
    'lesen-1': 'skip',
  });
  const stranger = await newGuest(depsNow());
  const before = countsOf(guest);
  const valid = {
    commandId: randomUUID(),
    examSlug: exam.slug,
    mode: 'training',
    purpose: 'error-repeat',
    selection: 'all',
    sourceAttemptId: sourceId,
    expectedVersionId: exam.versionId,
  };
  const forged: [Record<string, unknown>, number, string][] = [
    [{ mode: 'exam' }, 400, 'invalid-input'],
    [{ mode: 'timed-block', selection: 'hoeren' }, 400, 'invalid-input'],
    [{ selection: 'lesen' }, 400, 'invalid-input'],
    [{ scope: 'full-exam' }, 400, 'invalid-input'],
    [{ questionIds: ['hoeren-1'] }, 400, 'invalid-input'],
    [{ score: 45 }, 400, 'invalid-input'],
    [{ purpose: 'normal' }, 400, 'invalid-input'],
    [{ expectedVersionId: randomUUID() }, 404, 'not-found'],
  ];
  for (const [overrides, status, failure] of forged) {
    const response = await request.post(`${ORIGIN}/api/attempts/start`, {
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        cookie: `${GUEST_COOKIE}=${guest.token}`,
      },
      data: JSON.stringify({
        ...valid,
        commandId: randomUUID(),
        ...overrides,
      }),
    });
    expect(response.status()).toBe(status);
    expect(await response.json()).toEqual({ ok: false, failure });
  }
  expect(countsOf(guest)).toEqual(before);

  // The database checks the same on its own.
  const expected = ['hoeren-1', 'lesen-1'];
  const hints = [
    await directRepeat(guest, exam, sourceId, ['hoeren-1']),
    await directRepeat(guest, exam, sourceId, ALL_IDS),
    await directRepeat(guest, exam, sourceId, expected, { p_mode: 'exam' }),
    await directRepeat(guest, exam, sourceId, expected, {
      p_mode: 'timed-block',
      p_selection: 'hoeren',
    }),
    await directRepeat(guest, exam, sourceId, expected, {
      p_scope: 'full-exam',
    }),
    await directRepeat(guest, exam, sourceId, expected, {
      p_selection: 'hoeren',
    }),
    await directRepeat(guest, exam, sourceId, expected, {
      p_version_id: randomUUID(),
    }),
    await directRepeat(stranger, exam, sourceId, expected),
  ].map((call) => call.error?.hint);
  expect(hints).toEqual([
    'assignment_invalid',
    'assignment_invalid',
    'start_invalid',
    'start_invalid',
    'start_invalid',
    'start_invalid',
    'repeat_source_invalid',
    'repeat_source_invalid',
  ]);
  expect(countsOf(guest)).toEqual(before);
  expect(countsOf(stranger)).toMatchObject({ attempts: 0, commands: 0 });
});

test('empty replay and concurrent repeat preserve slot and event counts', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const perfectId = await completedSource(guest, exam, {});
  const first = await completedSource(guest, exam, { 'hoeren-5': 'wrong' });
  const second = await completedSource(guest, exam, { 'lesen-5': 'skip' });
  const before = countsOf(guest);
  const emptyCommand = randomUUID();
  for (let i = 0; i < 2; i++) {
    expect(
      await repeatFor(
        depsNow(),
        guest.token,
        exam.slug,
        sourceOf(exam, perfectId),
        { commandId: emptyCommand },
      ),
    ).toEqual({
      ok: true,
      result: { outcome: 'empty', sourceAttemptId: perfectId },
    });
  }
  expect(countsOf(guest)).toEqual(before);

  const commands = [randomUUID(), randomUUID()];
  const raced = await Promise.all(
    [first, second].map((sourceId, index) =>
      repeatFor(depsNow(), guest.token, exam.slug, sourceOf(exam, sourceId), {
        commandId: commands[index],
      }),
    ),
  );
  const winnerIndex = raced.findIndex(
    (item) => item.ok && item.result.outcome === 'accepted',
  );
  expect(winnerIndex).toBeGreaterThanOrEqual(0);
  const winner = raced[winnerIndex];
  if (!winner?.ok || winner.result.outcome === 'empty') {
    throw new Error('no winner');
  }
  const afterRace = countsOf(guest);
  // One new attempt with one start event; the loser wrote nothing.
  expect(afterRace).toEqual({
    ...before,
    attempts: before.attempts + 1,
    runs: before.runs + 1,
    commands: before.commands + 1,
    events: before.events + 1,
  });
  const replay = await repeatFor(
    depsNow(),
    guest.token,
    exam.slug,
    sourceOf(exam, [first, second][winnerIndex] ?? ''),
    { commandId: commands[winnerIndex] },
  );
  expect(replay).toMatchObject({
    ok: true,
    result: { attemptId: winner.result.attemptId },
  });
  // Even while the slot is held, an empty source stays empty and silent.
  expect(
    await repeatFor(
      depsNow(),
      guest.token,
      exam.slug,
      sourceOf(exam, perfectId),
    ),
  ).toMatchObject({ ok: true, result: { outcome: 'empty' } });
  expect(countsOf(guest)).toEqual(afterRace);
});

test('legacy completed source uses stored answers without invented skips', async () => {
  const exam = await newExam();
  const guest = await newGuest(depsNow());
  const hourAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  // A legacy completion: stored answers, no frozen snapshot. hoeren-1 has
  // no answer, lesen-1 a wrong one; every other task is right.
  const legacyAnswers = Object.fromEntries(
    ALL_IDS.filter((id) => id !== 'hoeren-1').map((id) => [
      id,
      id === 'lesen-1' ? fullWrongOf(id) : fullKeyOf(id),
    ]),
  );
  const legacy = {
    id: randomUUID(),
    sessionId: guest.guest.sessionId,
    examId: exam.examId,
    versionId: exam.versionId,
    scope: 'short-set' as const,
    createdAt: hourAgo(3),
    completedAt: hourAgo(2),
    answers: legacyAnswers,
    result: { score: 43, maxScore: 45, correct: 43, incorrect: 1, skipped: 1 },
  };
  psql(
    [
      'begin;',
      historicalCompletionSql(legacy),
      `select m2_private.mark_legacy_completed(${quote(legacy.id)});`,
      'commit;',
    ].join('\n'),
  );
  const legacyReview = await getAttemptReview(depsNow(), guest.token, {
    attemptId: legacy.id,
  });
  if (!legacyReview.ok) throw new Error('legacy review expected');
  const reviewedErrors = legacyReview.review.items
    .filter((item) => item.outcome !== 'correct')
    .map((item) => item.questionId);
  expect(reviewedErrors).toEqual(['hoeren-1', 'lesen-1']);
  const repeatId = await repeated(guest, exam, legacy.id);
  const [run] = await readRunRows(repeatId);
  expect(run?.assignment.questionIds).toEqual(reviewedErrors);
  await complete(guest, repeatId);

  // A new completion without its snapshot (not marked legacy) has no
  // trusted answers: refused, never read as 45 skipped tasks.
  const broken = { ...legacy, id: randomUUID() };
  psql(['begin;', historicalCompletionSql(broken), 'commit;'].join('\n'));
  const before = countsOf(guest);
  expect(
    await repeatFor(
      depsNow(),
      guest.token,
      exam.slug,
      sourceOf(exam, broken.id),
    ),
  ).toEqual({ ok: false, failure: 'not-found' });
  const direct = await directRepeat(guest, exam, broken.id, ALL_IDS);
  expect(direct.error?.hint).toBe('repeat_source_invalid');
  expect(countsOf(guest)).toEqual(before);
});

test('repeat SQL source version and normal timed full starts coexist', async () => {
  const exam = await newExam();
  ensureConfirmedTestProfile(sqlRunnerAs('owner'), exam.versionId, FULL_TIMING);
  const guest = await newGuest(depsNow());
  const sourceId = await completedSource(guest, exam, { 'lesen-25': 'wrong' });
  const v2 = await publishCorrection(exam);
  ensureConfirmedTestProfile(sqlRunnerAs('owner'), v2, FULL_TIMING);

  // The repeat runs on the old published version, without a profile.
  const repeatId = await repeated(guest, exam, sourceId);
  expect(versionOfAttempt(repeatId)).toBe(exam.versionId);
  expect(
    psql(`select timing_profile_revision_id is null
      from public.attempt_runs where attempt_id = ${quote(repeatId)}`),
  ).toBe('t');
  await complete(guest, repeatId);

  // A normal start still needs the latest version, in SQL as well.
  const stale = await serviceDb.rpc('m2_start_attempt', {
    p_session_id: guest.guest.sessionId,
    p_exam_id: exam.examId,
    p_command_id: randomUUID(),
    p_mode: 'training',
    p_purpose: 'normal',
    p_selection: 'all',
    p_source_attempt_id: null,
    p_version_id: exam.versionId,
    p_scope: 'full-exam',
    p_question_ids: ALL_IDS,
  });
  expect(stale.error?.hint).toBe('version_changed');

  const latest = { expectedVersionId: v2 };
  const trainingId = await started(guest, exam.slug, latest);
  expect(versionOfAttempt(trainingId)).toBe(v2);
  await answer(guest, trainingId, ALL_IDS);
  await complete(guest, trainingId);
  const blockId = await started(guest, exam.slug, {
    ...latest,
    mode: 'timed-block',
    selection: 'hoeren',
  });
  expect(versionOfAttempt(blockId)).toBe(v2);
  expect(
    psql(`select timing_profile_revision_id is not null
      from public.attempt_runs where attempt_id = ${quote(blockId)}`),
  ).toBe('t');
  await complete(guest, blockId);
  const examId = await started(guest, exam.slug, { ...latest, mode: 'exam' });
  expect(
    psql(`select scope from public.attempts where id = ${quote(examId)}`),
  ).toBe('full-exam');
  // While the exam runs: the all-right training of v2 has nothing to
  // repeat, the older source on v1 meets the slot of the exam.
  expect(
    await repeatFor(depsNow(), guest.token, exam.slug, {
      attemptId: trainingId,
      versionId: v2,
    }),
  ).toEqual({
    ok: true,
    result: { outcome: 'empty', sourceAttemptId: trainingId },
  });
  expect(
    await repeatFor(depsNow(), guest.token, exam.slug, {
      attemptId: sourceId,
      versionId: exam.versionId,
    }),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: examId },
  });
});
