import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import { createTimingProfileRevision } from '../../../scripts/manage-timing-profile';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import {
  cancelAttempt,
  getAttemptReview,
  preflightTimedStart,
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
  submitAttempt,
} from '../src/server/attempts/attempts';
import { readConfirmedTimingProfile } from '../src/server/attempts/profiles';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  hashGuestToken,
  resolveGuestSession,
} from '../src/server/guest-session/session';
import type {
  CreatedGuest,
  GuestContext,
} from '../src/server/guest-session/session';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttempts,
  readCommandRows,
  readEventKinds,
  readResults,
  readRunRows,
  readSubmission,
  serviceDb,
  startBody,
  startFor,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  SHORT_TIMING,
  ensureConfirmedTestProfile,
  fullKeyOf,
  fullWrongOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  ANSWER_URL,
  attemptUrl,
  card,
  expectStatus,
  optionIn,
} from './support/guest-browser';
import { expectUsableLayout } from './support/release';
import {
  holdAttemptLock,
  installM2Fixtures,
  psql,
  psqlJson,
  quote,
  sqlRunnerAs,
  waitersBehind,
} from './support/sql';

// One timed block (#43): the server pins the confirmed profile, sets one
// deadline and judges every write by the database clock after its lock.
// Exams with short profiles are published under their own slugs, so
// test-full-dtz keeps its profile; the browser only displays the time.

const FULL_ORIGIN = 'http://localhost:3102';
const SECOND_MS = 1000;
const RESERVE_SECONDS = 300;
const owner = sqlRunnerAs('owner');

// Long enough to hold a row lock and queue requests before the deadline.
const LOCK_TIMING: TimingSettings = { ...SHORT_TIMING, hoerenSeconds: 8 };

// Long enough to open a page and answer before the deadline.
const BROWSER_TIMING: TimingSettings = {
  recordingSeconds: 60,
  hoerenSeconds: 20,
  transitionSeconds: 2,
  lesenSeconds: 20,
};

test.beforeAll(() => {
  installM2Fixtures();
});

interface TimedExam {
  slug: string;
  examId: string;
  versionId: string;
}

const publishTimedExam = async (
  settings: TimingSettings | null,
): Promise<TimedExam> => {
  const slug = `test-timed-${randomUUID().slice(0, 8)}`;
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: 'Timed block test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(523) }],
  });
  if (settings) {
    ensureConfirmedTestProfile(owner, outcome.versionId, settings);
  }
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error('timed exam is missing');
  return { slug, examId: latest.examId, versionId: latest.versionId };
};

type Skill = 'hoeren' | 'lesen';

const idsOf = (skill: Skill): string[] =>
  FULL_PILOT.content.questions
    .filter((question) => question.skill === skill)
    .map((question) => question.id);

const timedStart = (
  token: string,
  slug: string,
  selection: Skill = 'hoeren',
  overrides: Record<string, unknown> = {},
) =>
  startFor(depsNow(), token, slug, {
    mode: 'timed-block',
    selection,
    ...overrides,
  });

interface Started {
  attemptId: string;
  startedAtMs: number;
  deadlineMs: number;
}

const startedTimed = async (
  token: string,
  slug: string,
  selection: Skill = 'hoeren',
): Promise<Started> => {
  const started = await timedStart(token, slug, selection);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error(`timed start failed: ${JSON.stringify(started)}`);
  }
  const { state } = started.result;
  if (state.deadlineMs === null) throw new Error('timed run has no deadline');
  return {
    attemptId: started.result.attemptId,
    startedAtMs: state.startedAtMs,
    deadlineMs: state.deadlineMs,
  };
};

interface Pin {
  revisionId: string | null;
  snapshot: Record<string, unknown> | null;
  acceptedAt: string;
}

const pinOf = (attemptId: string): Pin =>
  psqlJson<Pin>(`select json_build_object(
      'revisionId', timing_profile_revision_id,
      'snapshot', timing_profile_snapshot,
      'acceptedAt', accepted_at)
    from public.attempt_runs where attempt_id = ${quote(attemptId)}`);

const statusOf = (attemptId: string): string =>
  psql(`select status from public.attempts where id = ${quote(attemptId)}`);

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// The database and the test run on the same host; a small margin covers
// the rest.
const waitPast = (moment: number, marginMs = 400) =>
  sleep(moment - Date.now() + marginMs);

// A guest session whose fixed term ends the given seconds after the
// database clock, with a token the test knows.
const shortGuest = async (seconds: number): Promise<CreatedGuest> => {
  const token = randomBytes(32).toString('base64url');
  psql(`select m2_test.insert_guest_ending_in(
    ${quote(hashGuestToken(token))}, ${seconds})`);
  const guest: GuestContext | null = await resolveGuestSession(
    depsNow(),
    token,
  );
  if (!guest) throw new Error('short guest is not active');
  return { token, guest };
};

const sessionOf = (created: CreatedGuest): string => created.guest.sessionId;

const writesOf = async (created: CreatedGuest) => ({
  attempts: await readAttempts(sessionOf(created)),
  commands: await readCommandRows(sessionOf(created)),
});

const NO_WRITES = { attempts: [], commands: [] };

const httpStart = (request: APIRequestContext, token: string, body: unknown) =>
  request.post(`${FULL_ORIGIN}/api/attempts/start`, {
    headers: {
      'content-type': 'application/json',
      cookie: `${GUEST_COOKIE}=${token}`,
      origin: FULL_ORIGIN,
    },
    data: JSON.stringify(body),
  });

const answer = (questionId: string, optionId: string, revision = 1) => ({
  questionId,
  optionId,
  revision,
});

interface ResultRow {
  scope: string;
  score: number;
  max_score: number;
  skipped_count: number;
  hoeren_max: number | null;
  lesen_max: number | null;
  level: string | null;
}

test('timed skills pin profile assignment and score own maximum', async () => {
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');
  const profile = await readConfirmedTimingProfile(depsNow(), latest.versionId);
  if (!profile) throw new Error('full set has no confirmed profile');
  expect(profile).toMatchObject({ ...FULL_TIMING });

  const skills: [Skill, number, number][] = [
    ['hoeren', 20, profile.hoerenSeconds],
    ['lesen', 25, profile.lesenSeconds],
  ];
  for (const [skill, count, seconds] of skills) {
    const created = await newGuest(depsNow());
    const started = await timedStart(created.token, FULL_EXAM.slug, skill);
    if (!started.ok) throw new Error(`start failed: ${started.failure}`);
    expect(started.result.outcome).toBe('accepted');
    const { attemptId, state } = started.result;
    expect(state).toMatchObject({
      mode: 'timed-block',
      selection: skill,
      status: 'active',
      phase: skill,
      phaseRevision: 0,
      openSkills: [skill],
      deadlineMs: state.startedAtMs + seconds * SECOND_MS,
    });

    // The run pins the current confirmed revision and exactly its document;
    // the assignment is the tasks of the skill of the pinned version.
    const pin = pinOf(attemptId);
    expect(pin.revisionId).toBe(profile.revisionId);
    expect(pin.snapshot).toMatchObject({
      revisionId: profile.revisionId,
      examVersionId: latest.versionId,
      status: 'confirmed',
      hoerenSeconds: profile.hoerenSeconds,
      lesenSeconds: profile.lesenSeconds,
      fingerprint: profile.fingerprint,
    });
    expect(Date.parse(pin.acceptedAt)).toBe(state.startedAtMs);
    const [run] = await readRunRows(attemptId);
    expect(run).toMatchObject({
      mode: 'timed-block',
      purpose: 'normal',
      selection: skill,
      assignment: { versionId: latest.versionId, questionIds: idsOf(skill) },
    });
    expect(run?.assignment.questionIds).toHaveLength(count);

    // Three right, one wrong, the rest skipped: scored on the maximum of
    // the block, without any DTZ level.
    const [first, second, third, fourth] = idsOf(skill);
    if (!first || !second || !third || !fourth) throw new Error('no tasks');
    const submitted = await submitAttempt(depsNow(), created.token, {
      attemptId,
      commandId: randomUUID(),
      answers: [
        answer(first, fullKeyOf(first)),
        answer(second, fullKeyOf(second)),
        answer(third, fullKeyOf(third)),
        answer(fourth, fullWrongOf(fourth)),
      ],
      confirmation: { phaseRevision: 0, skipped: count - 4 },
    });
    expect(submitted).toEqual({
      ok: true,
      result: { outcome: 'result-ready', attemptId },
    });
    const results = (await readResults(attemptId)) as ResultRow[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      scope: 'short-set',
      score: 3,
      max_score: count,
      skipped_count: count - 4,
      hoeren_max: null,
      lesen_max: null,
      level: null,
    });
    const review = await getAttemptReview(depsNow(), created.token, {
      attemptId,
    });
    if (!review.ok) throw new Error(`review failed: ${review.error}`);
    expect(review.review).toMatchObject({
      showsLevel: false,
      maxScore: count,
      score: 3,
      level: null,
      skills: null,
    });
    expect(review.review.items).toHaveLength(count);
  }
});

// Shifts Date by the given milliseconds in the page; performance.now and
// the server stay as they are.
const shiftDate = (context: BrowserContext, shiftMs: number) =>
  context.addInitScript((shift: number) => {
    const RealDate = Date;
    // new Date() and Date.now() read the shifted device clock; every other
    // use of Date is unchanged.
    globalThis.Date = new Proxy(RealDate, {
      construct: (target, args: unknown[]) =>
        args.length === 0
          ? new target(target.now() + shift)
          : (Reflect.construct(target, args) as object),
      apply: () => new RealDate(RealDate.now() + shift).toString(),
      get: (target, property) =>
        property === 'now'
          ? () => target.now() + shift
          : (Reflect.get(target, property) as unknown),
    });
  }, shiftMs);

const guestContext = async (
  browser: Browser,
  token: string,
  shiftMs = 0,
): Promise<BrowserContext> => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  if (shiftMs !== 0) await shiftDate(context, shiftMs);
  return context;
};

const timerOf = (page: Page) => page.getByTestId('attempt-timer');

const remainingOf = async (page: Page): Promise<number> =>
  Number(await timerOf(page).getAttribute('data-remaining-ms'));

const expectServerRemaining = async (page: Page, deadlineMs: number) => {
  await expect(timerOf(page)).toHaveAttribute(
    'data-deadline-ms',
    String(deadlineMs),
  );
  const expected = deadlineMs - Date.now();
  const shown = await remainingOf(page);
  expect(Math.abs(shown - expected)).toBeLessThan(5 * SECOND_MS);
};

const MINUTES_3 = 3 * 60 * SECOND_MS;

test('clock refresh focus tabs and wall clock skew preserve deadline', async ({
  browser,
}) => {
  const created = await newGuest(depsNow());
  const started = await startedTimed(created.token, FULL_EXAM.slug, 'hoeren');
  const url = attemptUrl(FULL_EXAM.slug, started.attemptId);
  const pinned = pinOf(started.attemptId);

  // A device clock three minutes ahead shows the server's remaining time.
  const ahead = await guestContext(browser, created.token, MINUTES_3);
  const page = await ahead.newPage();
  await page.goto(`${FULL_ORIGIN}${url}`);
  await expect(timerOf(page)).toBeVisible();
  await expect(timerOf(page)).toHaveAttribute('role', 'timer');
  await expect(timerOf(page)).not.toHaveAttribute('aria-live');
  await expectServerRemaining(page, started.deadlineMs);

  // The recording is not playing; the time runs anyway.
  const before = await remainingOf(page);
  await sleep(2 * SECOND_MS);
  await expect
    .poll(() => remainingOf(page))
    .toBeLessThanOrEqual(before - SECOND_MS);

  // A refresh shows the same deadline, never a new interval.
  await page.reload();
  await expectServerRemaining(page, started.deadlineMs);

  // Focus and the return to the tab read the server state again.
  const focused = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/attempts/${started.attemptId}/status`) &&
      response.status() === 200,
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const status = (await (await focused).json()) as {
    result: { serverNow: string; state: { deadlineMs: number } };
  };
  expect(status.result.state.deadlineMs).toBe(started.deadlineMs);
  expect(
    Math.abs(Date.parse(status.result.serverNow) - Date.now()),
  ).toBeLessThan(5 * SECOND_MS);
  await expectServerRemaining(page, started.deadlineMs);

  // A second tab with a device clock three minutes behind: the same deadline.
  const behind = await guestContext(browser, created.token, -MINUTES_3);
  const second = await behind.newPage();
  await second.goto(`${FULL_ORIGIN}${url}`);
  await expectServerRemaining(second, started.deadlineMs);

  // The phone layout keeps the clock to one compact line above the tasks.
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(timerOf(page)).toBeVisible();
  const box = await timerOf(page).boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(48);
  const cardBox = await card(page, 'hoeren-1').boundingBox();
  expect(box?.y ?? 0).toBeLessThan(cardBox?.y ?? 0);
  await expectUsableLayout(page, 'timed Hören 375');

  // Nothing was started, renewed or written by the pages.
  expect(await readAttempts(sessionOf(created))).toEqual([
    { id: started.attemptId, status: 'active' },
  ]);
  expect(pinOf(started.attemptId)).toEqual(pinned);
  await ahead.close();
  await behind.close();
});

test('accepted submission replays after deadline and guest reserve is enforced', async () => {
  const exam = await publishTimedExam(SHORT_TIMING);
  const created = await newGuest(depsNow());
  const started = await startedTimed(created.token, exam.slug);
  expect(started.deadlineMs - started.startedAtMs).toBe(
    SHORT_TIMING.hoerenSeconds * SECOND_MS,
  );
  const commandId = randomUUID();
  const body = {
    attemptId: started.attemptId,
    commandId,
    answers: [answer('hoeren-1', fullKeyOf('hoeren-1'))],
    confirmation: { phaseRevision: 0, skipped: 19 },
  };
  expect(await submitAttempt(depsNow(), created.token, body)).toEqual({
    ok: true,
    result: { outcome: 'result-ready', attemptId: started.attemptId },
  });
  const submission = await readSubmission(started.attemptId);
  expect(submission.submit_command_id).toBe(commandId);
  const result = await readResults(started.attemptId);
  expect(result).toHaveLength(1);

  // After the deadline the same command returns the same accepted result.
  await waitPast(started.deadlineMs);
  expect(await submitAttempt(depsNow(), created.token, body)).toEqual({
    ok: true,
    result: { outcome: 'result-ready', attemptId: started.attemptId },
  });
  expect(await readSubmission(started.attemptId)).toEqual(submission);
  expect(await readResults(started.attemptId)).toEqual(result);
  expect(await readEventKinds(started.attemptId)).toEqual(['start', 'finish']);

  // The reserve: a block of 4 seconds needs 304 seconds of the guest.
  const short = await shortGuest(
    SHORT_TIMING.hoerenSeconds + RESERVE_SECONDS - 1,
  );
  expect(await timedStart(short.token, exam.slug)).toEqual({
    ok: false,
    failure: 'guest-too-short',
  });
  expect(await writesOf(short)).toEqual(NO_WRITES);
  const enough = await shortGuest(
    SHORT_TIMING.hoerenSeconds + RESERVE_SECONDS + 5,
  );
  expect(await timedStart(enough.token, exam.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });
  // A free training needs no reserve.
  expect(
    await startFor(depsNow(), short.token, exam.slug, { selection: 'lesen' }),
  ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
});

test('timed cancellation releases slot without grade or resumption', async () => {
  const created = await newGuest(depsNow());
  const first = await startedTimed(created.token, FULL_EXAM.slug, 'lesen');
  const saved = await saveAnswer(depsNow(), created.token, {
    attemptId: first.attemptId,
    questionId: 'lesen-1',
    optionId: fullKeyOf('lesen-1'),
    revision: 1,
  });
  expect(saved.ok).toBe(true);
  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId: first.attemptId,
  });
  if (!status.ok) throw new Error(`status failed: ${status.failure}`);
  expect(status.result).toMatchObject({
    outcome: 'active',
    skipped: 24,
    isClosedByDeadline: false,
    state: { phase: 'lesen', phaseRevision: 0 },
  });
  const cancelCommand = randomUUID();
  const cancelled = await cancelAttempt(depsNow(), created.token, {
    attemptId: first.attemptId,
    commandId: cancelCommand,
    confirmation: { phaseRevision: 0, skipped: 24 },
  });
  expect(cancelled).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', state: { status: 'cancelled' } },
  });
  // The same cancel again is the same cancel.
  expect(
    await cancelAttempt(depsNow(), created.token, {
      attemptId: first.attemptId,
      commandId: cancelCommand,
      confirmation: { phaseRevision: 0, skipped: 24 },
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  expect(statusOf(first.attemptId)).toBe('cancelled');
  expect(await readAnswerRows(first.attemptId)).toEqual([
    { question_id: 'lesen-1', option_id: fullKeyOf('lesen-1'), revision: 1 },
  ]);
  expect(await readResults(first.attemptId)).toEqual([]);
  expect(await readEventKinds(first.attemptId)).toEqual(['start', 'cancel']);
  expect(
    await readAttemptPage(
      depsNow(),
      created.guest,
      FULL_EXAM.slug,
      first.attemptId,
    ),
  ).toEqual({ status: 'not-found' });

  // A new choice is a new attempt with its own deadline.
  const next = await startedTimed(created.token, FULL_EXAM.slug, 'lesen');
  expect(next.attemptId).not.toBe(first.attemptId);
  expect(next.startedAtMs).toBeGreaterThan(first.startedAtMs);
  expect(next.deadlineMs).toBe(
    next.startedAtMs + FULL_TIMING.lesenSeconds * SECOND_MS,
  );
  expect(statusOf(first.attemptId)).toBe('cancelled');
});

test('timed start rejects unconfirmed or forged profile', async () => {
  const unprofiled = await publishTimedExam(null);
  const exam = await publishTimedExam(FULL_TIMING);
  const full = await latestVersionOf(FULL_EXAM.slug);
  if (!full) throw new Error('full set is missing');
  const created = await newGuest(depsNow());

  // No profile at all.
  expect(await timedStart(created.token, unprofiled.slug)).toEqual({
    ok: false,
    failure: 'not-enabled',
  });
  // A duration, deadline or profile of the client is not part of a start.
  for (const forged of [
    { durationSeconds: 1 },
    { deadline: new Date(Date.now() + 3_600_000).toISOString() },
    { timingProfileRevisionId: randomUUID() },
    { startedAt: new Date(0).toISOString() },
  ]) {
    expect(
      await timedStart(created.token, exam.slug, 'hoeren', forged),
    ).toEqual({ ok: false, failure: 'invalid-input' });
  }
  // The version of another exam is not a version of this one.
  expect(
    await timedStart(created.token, exam.slug, 'hoeren', {
      expectedVersionId: full.versionId,
    }),
  ).toEqual({ ok: false, failure: 'not-found' });
  expect(await writesOf(created)).toEqual(NO_WRITES);

  // Directly, the SQL start refuses an exam without a confirmed profile
  // and an assignment that is not the block.
  const direct = (versionId: string, examId: string, ids: string[]) =>
    serviceDb.rpc('m2_start_attempt', {
      p_session_id: sessionOf(created),
      p_exam_id: examId,
      p_command_id: randomUUID(),
      p_mode: 'timed-block',
      p_purpose: 'normal',
      p_selection: 'hoeren',
      p_source_attempt_id: null,
      p_version_id: versionId,
      p_scope: 'short-set',
      p_question_ids: ids,
    });
  expect(
    (await direct(unprofiled.versionId, unprofiled.examId, idsOf('hoeren')))
      .error?.hint,
  ).toBe('timing_profile_unavailable');
  expect(
    (await direct(exam.versionId, exam.examId, idsOf('hoeren').slice(1))).error
      ?.hint,
  ).toBe('assignment_invalid');
  expect(await writesOf(created)).toEqual(NO_WRITES);

  // A run started on the confirmed profile keeps its deadline; a new draft
  // refuses new timed starts until it is confirmed.
  const running = await startedTimed(created.token, exam.slug);
  const pinned = pinOf(running.attemptId);
  const drafted = createTimingProfileRevision(
    owner,
    { versionId: exam.versionId },
    { ...FULL_TIMING, hoerenSeconds: 600 },
  ).revision;
  expect(drafted.status).toBe('draft');
  const other = await newGuest(depsNow());
  expect(await timedStart(other.token, exam.slug)).toEqual({
    ok: false,
    failure: 'not-enabled',
  });
  expect(await writesOf(other)).toEqual(NO_WRITES);
  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId: running.attemptId,
  });
  expect(status).toMatchObject({
    ok: true,
    result: { outcome: 'active', state: { deadlineMs: running.deadlineMs } },
  });
  expect(pinOf(running.attemptId)).toEqual(pinned);
  // The training of the same exam stays free of any profile.
  expect(
    await startFor(depsNow(), other.token, exam.slug, { selection: 'lesen' }),
  ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
});

test('late pending answer and expired cancellation cannot change result', async () => {
  const exam = await publishTimedExam(LOCK_TIMING);
  const created = await newGuest(depsNow());
  const started = await startedTimed(created.token, exam.slug);
  const key = fullKeyOf('hoeren-1');
  const saved = await saveAnswer(depsNow(), created.token, {
    attemptId: started.attemptId,
    questionId: 'hoeren-1',
    optionId: key,
    revision: 1,
  });
  expect(saved.ok).toBe(true);

  // A competing request holds the row while a change of the answer and a
  // cancel arrive before the deadline; the lock is released after it.
  const lock = await holdAttemptLock(started.attemptId);
  let late: Awaited<ReturnType<typeof saveAnswer>> | null = null;
  let cancelled: Awaited<ReturnType<typeof cancelAttempt>> | null = null;
  try {
    const latePromise = saveAnswer(depsNow(), created.token, {
      attemptId: started.attemptId,
      questionId: 'hoeren-1',
      optionId: fullWrongOf('hoeren-1'),
      revision: 2,
    });
    const cancelPromise = cancelAttempt(depsNow(), created.token, {
      attemptId: started.attemptId,
      commandId: randomUUID(),
      confirmation: { phaseRevision: 0, skipped: 19 },
    });
    await expect
      .poll(
        () =>
          waitersBehind(lock, 'm2_save_answer') +
          waitersBehind(lock, 'm2_cancel_attempt'),
      )
      .toBe(2);
    expect(Date.now()).toBeLessThan(started.deadlineMs);
    await waitPast(started.deadlineMs);
    await lock.release();
    [late, cancelled] = await Promise.all([latePromise, cancelPromise]);
  } finally {
    await lock.release().catch(() => undefined);
  }
  expect(late).toEqual({ ok: false, error: 'attempt-not-found' });
  expect(cancelled).toMatchObject({
    ok: true,
    result: { outcome: 'closed-phase' },
  });

  // Neither the answer nor its revision changed; the deadline froze the
  // answer accepted in time and the result counts only it.
  expect(await readAnswerRows(started.attemptId)).toEqual([
    { question_id: 'hoeren-1', option_id: key, revision: 1 },
  ]);
  const submission = await readSubmission(started.attemptId);
  expect(submission.frozen_answers).toEqual({
    'hoeren-1': { optionId: key, revision: 1 },
  });
  expect(submission.submit_command_id).toBeNull();
  expect(Date.parse(submission.submission_accepted_at ?? '')).toBe(
    started.deadlineMs,
  );
  const results = (await readResults(started.attemptId)) as ResultRow[];
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ score: 1, max_score: 20 });
  expect(await readEventKinds(started.attemptId)).toEqual(['start', 'finish']);
  const status = await readAttemptStatus(depsNow(), created.token, {
    attemptId: started.attemptId,
  });
  expect(status).toMatchObject({
    ok: true,
    result: {
      outcome: 'result-ready',
      isClosedByDeadline: true,
      answers: { 'hoeren-1': key },
    },
  });
});

test('reserve boundary ownership and expired replay are guarded', async ({
  request,
}) => {
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');
  const reserve = FULL_TIMING.hoerenSeconds + RESERVE_SECONDS;
  const body = await startBody(FULL_EXAM.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
  });

  // One second short of the block and its reserve: the preflight, the start
  // and the HTTP route all refuse with guest-too-short, never 500.
  const short = await shortGuest(reserve - 1);
  expect(await preflightTimedStart(depsNow(), short.token, body)).toEqual({
    ok: false,
    failure: 'guest-too-short',
  });
  expect(await startFor(depsNow(), short.token, FULL_EXAM.slug, body)).toEqual({
    ok: false,
    failure: 'guest-too-short',
  });
  const http = await httpStart(request, short.token, body);
  expect(http.status()).toBe(422);
  expect(await http.json()).toEqual({ ok: false, failure: 'guest-too-short' });
  expect(await writesOf(short)).toEqual(NO_WRITES);

  // The SQL kernel after the lock, at the exact boundary of the reserve:
  // a millisecond late is refused with guest_too_short, the boundary itself
  // is admitted. Rolled back.
  const boundary = psqlJson<Record<string, string>>(`begin;
    create temp table summary (key text primary key, value jsonb);
    do $$
    declare
      v_expires timestamptz := (select expires_at from public.guest_sessions
        where id = ${quote(sessionOf(short))});
      v_at timestamptz := v_expires - make_interval(secs => ${reserve});
      v_hint text;
    begin
      begin
        perform * from m2_test.start_attempt_at(
          ${quote(sessionOf(short))}, ${quote(latest.examId)},
          gen_random_uuid(), 'timed-block', 'normal', 'hoeren', null,
          ${quote(latest.versionId)}, 'short-set',
          ${quote(JSON.stringify(idsOf('hoeren')))}::jsonb,
          v_at + interval '1 millisecond');
        insert into pg_temp.summary values ('late', '"written"');
      exception when others then
        get stacked diagnostics v_hint = pg_exception_hint;
        insert into pg_temp.summary values ('late', to_jsonb(v_hint));
      end;
      insert into pg_temp.summary select 'exact', to_jsonb(s.outcome)
      from m2_test.start_attempt_at(
        ${quote(sessionOf(short))}, ${quote(latest.examId)},
        gen_random_uuid(), 'timed-block', 'normal', 'hoeren', null,
        ${quote(latest.versionId)}, 'short-set',
        ${quote(JSON.stringify(idsOf('hoeren')))}::jsonb, v_at) s;
    end;
    $$;
    select jsonb_object_agg(key, value) from pg_temp.summary;
    rollback;`);
  expect(boundary).toEqual({ late: 'guest_too_short', exact: 'accepted' });
  expect(await writesOf(short)).toEqual(NO_WRITES);

  // The order of the answers: an active attempt is a conflict, a draft
  // profile is not-enabled and a stale version not-found, before the reserve.
  const busy = await shortGuest(reserve - 1);
  const free = await startFor(depsNow(), busy.token, FULL_EXAM.slug);
  if (!free.ok) throw new Error('free start failed');
  expect(await timedStart(busy.token, FULL_EXAM.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: free.result.attemptId },
  });
  const drafted = await publishTimedExam(null);
  createTimingProfileRevision(
    owner,
    { versionId: drafted.versionId },
    FULL_TIMING,
  );
  expect(await timedStart(short.token, drafted.slug)).toEqual({
    ok: false,
    failure: 'not-enabled',
  });
  expect(
    await timedStart(short.token, FULL_EXAM.slug, 'hoeren', {
      expectedVersionId: drafted.versionId,
    }),
  ).toEqual({ ok: false, failure: 'not-found' });
  expect(await writesOf(short)).toEqual(NO_WRITES);

  // A replay answers before the reserve; a guest that became too short
  // still gets its own run back. A submission accepted earlier needs a
  // living guest to be replayed.
  const exam = await publishTimedExam(SHORT_TIMING);
  const brief = await shortGuest(
    SHORT_TIMING.hoerenSeconds + RESERVE_SECONDS + 2,
  );
  const replayBody = await startBody(exam.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
  });
  const first = await startFor(depsNow(), brief.token, exam.slug, replayBody);
  if (!first.ok) throw new Error(`timed start failed: ${first.failure}`);
  await sleep(2.5 * SECOND_MS);
  expect(
    await preflightTimedStart(depsNow(), brief.token, {
      ...replayBody,
      commandId: randomUUID(),
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'conflict' } });
  expect(
    await startFor(depsNow(), brief.token, exam.slug, replayBody),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: first.result.attemptId },
  });
  expect(await readAttempts(sessionOf(brief))).toHaveLength(1);

  // The free training of the busy guest, submitted while the guest lives,
  // is not replayed by the kernel once the guest's term is over.
  const submitCommand = randomUUID();
  const total = FULL_PILOT.content.questions.length;
  expect(
    await submitAttempt(depsNow(), busy.token, {
      attemptId: free.result.attemptId,
      commandId: submitCommand,
      answers: [],
      confirmation: { phaseRevision: 0, skipped: total },
    }),
  ).toMatchObject({ ok: true });
  const replayAfterGuest = psqlJson<{ hint: string }>(`begin;
    create temp table summary (hint text);
    do $$
    declare v_hint text;
    begin
      perform * from m2_test.accept_submission_at(
        ${quote(sessionOf(busy))}, ${quote(free.result.attemptId)},
        ${quote(submitCommand)}, '[]'::jsonb, 0, ${total},
        (select expires_at from public.guest_sessions
          where id = ${quote(sessionOf(busy))}));
      insert into pg_temp.summary values ('written');
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      insert into pg_temp.summary values (v_hint);
    end;
    $$;
    select row_to_json(s) from pg_temp.summary s;
    rollback;`);
  expect(replayAfterGuest).toEqual({ hint: 'guest_session_invalid' });
});

test('closed timed cancellation and old start cannot reopen a run', async () => {
  const created = await newGuest(depsNow());
  const body = await startBody(FULL_EXAM.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
  });
  const started = await startFor(
    depsNow(),
    created.token,
    FULL_EXAM.slug,
    body,
  );
  if (!started.ok) throw new Error(`start failed: ${started.failure}`);
  const { attemptId } = started.result;
  const pinned = pinOf(attemptId);
  expect(
    await submitAttempt(depsNow(), created.token, {
      attemptId,
      commandId: randomUUID(),
      answers: [answer('hoeren-1', fullKeyOf('hoeren-1'))],
      confirmation: { phaseRevision: 0, skipped: 19 },
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'result-ready' } });

  // A fresh cancel of the submitted run is refused.
  expect(
    await cancelAttempt(depsNow(), created.token, {
      attemptId,
      commandId: randomUUID(),
      confirmation: { phaseRevision: 0, skipped: 19 },
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'conflict' } });
  // The old start replays its own run, closed, with its own deadline.
  const replay = await startFor(depsNow(), created.token, FULL_EXAM.slug, body);
  expect(replay).toMatchObject({
    ok: true,
    result: {
      outcome: 'accepted',
      attemptId,
      state: { phase: 'closed', startedAtMs: started.result.state.startedAtMs },
    },
  });
  expect(pinOf(attemptId)).toEqual(pinned);
  expect(await readAttempts(sessionOf(created))).toEqual([
    { id: attemptId, status: 'completed' },
  ]);
  expect(
    (await readCommandRows(sessionOf(created))).map((row) => row.kind).sort(),
  ).toEqual(['start', 'submit']);

  // At the deadline a cancel is refused: it closes the run with the answers
  // accepted in time instead, and the old start still reopens nothing.
  const exam = await publishTimedExam(SHORT_TIMING);
  const expiring = await newGuest(depsNow());
  const expiringBody = await startBody(exam.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
  });
  const timed = await startFor(
    depsNow(),
    expiring.token,
    exam.slug,
    expiringBody,
  );
  if (!timed.ok || timed.result.state.deadlineMs === null) {
    throw new Error('timed start failed');
  }
  const expiredId = timed.result.attemptId;
  await waitPast(timed.result.state.deadlineMs);
  expect(
    await cancelAttempt(depsNow(), expiring.token, {
      attemptId: expiredId,
      commandId: randomUUID(),
      confirmation: { phaseRevision: 0, skipped: 20 },
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'closed-phase' } });
  expect(statusOf(expiredId)).toBe('completed');
  expect((await readRunRows(expiredId))[0]?.cancel_reason).toBeNull();
  expect(await readEventKinds(expiredId)).toEqual(['start', 'finish']);
  expect(
    await startFor(depsNow(), expiring.token, exam.slug, expiringBody),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: expiredId },
  });
  expect(await readAttempts(sessionOf(expiring))).toEqual([
    { id: expiredId, status: 'completed' },
  ]);
});

// The browser part of an expired block: a choice the server did not accept
// before the deadline stays visible as not saved.

const openTimedPage = async (browser: Browser) => {
  const exam = await publishTimedExam(BROWSER_TIMING);
  const created = await newGuest(depsNow());
  const started = await startedTimed(created.token, exam.slug);
  const context = await guestContext(browser, created.token);
  const page = await context.newPage();
  await page.goto(`${FULL_ORIGIN}${attemptUrl(exam.slug, started.attemptId)}`);
  await expect(timerOf(page)).toBeVisible();
  const first = card(page, 'hoeren-1');
  await optionIn(first, fullKeyOf('hoeren-1')).check();
  await expectStatus(first, 'saved');
  return { exam, created, started, context, page, first };
};

test('expired timed block distinguishes unconfirmed local answers', async ({
  browser,
}) => {
  const { started, context, page, first } = await openTimedPage(browser);
  // Offline, a changed choice cannot reach the server before the deadline.
  await context.setOffline(true);
  await optionIn(first, fullWrongOf('hoeren-1')).check();
  await expectStatus(first, 'error');
  await waitPast(started.deadlineMs);
  await expect(timerOf(page)).toHaveAttribute('data-state', 'zero');
  await expect(page.getByTestId('timed-expired')).toHaveCount(0);

  // Back online the server closes the run by its own clock.
  await context.setOffline(false);
  const expired = page.getByTestId('timed-expired');
  await expect(expired).toBeVisible({ timeout: 15_000 });
  await expect(expired).toHaveAttribute('role', 'status');
  await expect(expired).toHaveAttribute('data-unsaved', '1');
  await expect(page.getByTestId('timed-expired-unsaved')).toBeVisible();
  await expectStatus(first, 'refused');
  await expect(first.locator('[data-status="saved"]')).toHaveCount(0);
  await expect(page.getByTestId('finish-attempt')).toHaveCount(0);
  await expect(page.getByTestId('cancel-attempt')).toHaveCount(0);

  // Only the confirmed answer counts.
  const submission = await readSubmission(started.attemptId);
  expect(submission.frozen_answers).toEqual({
    'hoeren-1': { optionId: fullKeyOf('hoeren-1'), revision: 1 },
  });
  const results = (await readResults(started.attemptId)) as ResultRow[];
  expect(results[0]).toMatchObject({ score: 1, max_score: 20 });
  await page.getByTestId('result-check').click();
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await context.close();
});

test('timed status reconciles without waiting for held answer save', async ({
  browser,
}) => {
  const { started, context, page, first } = await openTimedPage(browser);
  // The next save is held in the browser network, never reaching the
  // server, so it holds no row lock.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let isHeld = false;
  await page.route(ANSWER_URL, async (route) => {
    isHeld = true;
    await held;
    await route.continue();
  });
  await optionIn(first, fullWrongOf('hoeren-1')).check();
  await expectStatus(first, 'saving');
  await expect.poll(() => isHeld).toBe(true);
  await waitPast(started.deadlineMs);

  // The status of zero is its own request and closes the run meanwhile.
  const expired = page.getByTestId('timed-expired');
  await expect(expired).toBeVisible({ timeout: 15_000 });
  await expect(expired).toHaveAttribute('data-unsaved', '1');
  await expectStatus(first, 'refused');
  expect(statusOf(started.attemptId)).toBe('completed');

  // The late save reaches the server after the deadline: refused, and the
  // screen keeps it as not saved.
  const late = page.waitForResponse((response) =>
    response.url().includes(`/api/attempts/${started.attemptId}/answer`),
  );
  release();
  const response = await late;
  expect(await response.json()).toEqual({
    ok: false,
    error: 'attempt-not-found',
  });
  await expectStatus(first, 'refused');
  expect(await readAnswerRows(started.attemptId)).toEqual([
    { question_id: 'hoeren-1', option_id: fullKeyOf('hoeren-1'), revision: 1 },
  ]);
  expect((await readSubmission(started.attemptId)).frozen_answers).toEqual({
    'hoeren-1': { optionId: fullKeyOf('hoeren-1'), revision: 1 },
  });
  await context.close();
});
