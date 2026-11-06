import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, Request } from '@playwright/test';
import { resolveLifecycle } from '@b1k/domain';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import {
  preflightTimedStart,
  readAttemptStatus,
  saveAnswer,
  saveProgress,
  submitAttempt,
} from '../src/server/attempts/attempts';
import { beginLesen } from '../src/server/attempts/read';
import { resolveAttemptAudio } from '../src/server/audio/audio';
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
  createPublicClient,
  depsAt,
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAttempts,
  readResults,
  readRunRows,
  readSubmission,
  serviceDb,
  startFor,
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
  HOEREN_URL,
  LESEN_URL,
  attemptIdOf,
  attemptUrl,
  card,
  expectStatus,
  optionIn,
} from './support/guest-browser';
import { NARROW, WIDE, expectUsableLayout } from './support/release';
import type { ViewportSize } from './support/release';
import {
  examRunTimes,
  installM2Fixtures,
  psql,
  psqlJson,
  quote,
  runPhaseAt,
  secondsAgoSql,
  sqlRunnerAs,
  startExamAt,
} from './support/sql';

// The full exam (#45): Hören, a transition of at most the pinned seconds,
// then Lesen with its full pinned duration, all by the database clock after
// the row lock. Exams are published under their own slugs with the
// preliminary pilot profile as test data; runs placed in a phase are started
// through the admission kernel at an explicit earlier moment, so nothing
// waits for 25 minutes. The browser only displays the time.

const FULL_ORIGIN = 'http://localhost:3102';
const SECOND_MS = 1000;
const RESERVE_SECONDS = 300;
const owner = sqlRunnerAs('owner');

const H = FULL_TIMING.hoerenSeconds;
const T = FULL_TIMING.transitionSeconds;
const L = FULL_TIMING.lesenSeconds;
const H_MS = H * SECOND_MS;
const T_MS = T * SECOND_MS;
const L_MS = L * SECOND_MS;
const TIMELINE_SECONDS = H + T + L;

const ALL_IDS = FULL_PILOT.content.questions.map((question) => question.id);

// What no transport may carry before Lesen starts: its task ids, prompts,
// text ids and texts.
const LESEN_MARKERS = [
  'question-card-lesen',
  'lesen-text-1',
  'Anzeige zu Teil 1',
  'Langer Lesetext zu Teil 3',
  'lesen Teil 1',
];

test.beforeAll(() => {
  installM2Fixtures();
});

interface Exam {
  slug: string;
  examId: string;
  versionId: string;
}

const publishExam = async (
  settings: TimingSettings | null = FULL_TIMING,
  slug = `test-exam-${randomUUID().slice(0, 8)}`,
  tone = 611,
): Promise<Exam> => {
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: 'Full exam test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(tone) }],
  });
  if (settings) {
    ensureConfirmedTestProfile(owner, outcome.versionId, settings);
  }
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error('exam is missing');
  return { slug, examId: latest.examId, versionId: latest.versionId };
};

const sessionOf = (created: CreatedGuest): string => created.guest.sessionId;

// A full exam whose Hören started the given seconds ago.
const examAgo = (created: CreatedGuest, exam: Exam, seconds: number) => {
  const attemptId = startExamAt(
    sessionOf(created),
    exam,
    ALL_IDS,
    secondsAgoSql(seconds),
  );
  const startMs = Date.parse(examRunTimes(attemptId).acceptedAt);
  return { attemptId, startMs };
};

const ts = (ms: number): string =>
  `${quote(new Date(ms).toISOString())}::timestamptz`;

const statusOf = (token: string, attemptId: string) =>
  readAttemptStatus(depsNow(), token, { attemptId });

const activeStatus = async (token: string, attemptId: string) => {
  const status = await statusOf(token, attemptId);
  if (!status.ok) throw new Error(`status failed: ${status.failure}`);
  return status.result;
};

const saveAt = (
  created: CreatedGuest,
  attemptId: string,
  questionId: string,
  optionId: string,
  revision: number,
  atMs: number,
): string =>
  psql(`select question_id from m2_test.save_answer_at(
    ${quote(sessionOf(created))}, ${quote(attemptId)}, ${quote(questionId)},
    ${quote(optionId)}, ${revision}, ${ts(atMs)})`);

const answer = (questionId: string, optionId: string, revision = 1) => ({
  questionId,
  optionId,
  revision,
});

interface KernelSubmission {
  outcome: string;
  attempt_status: string;
  accepted_at: string | null;
  skipped: number | null;
  frozen: Record<string, { optionId: string; revision: number }> | null;
}

const submitAt = (
  created: CreatedGuest,
  attemptId: string,
  commandId: string,
  answers: unknown[],
  confirmation: { phaseRevision: number; skipped: number },
  atMs: number,
): KernelSubmission =>
  psqlJson<KernelSubmission>(`select row_to_json(s) from
    m2_test.accept_submission_at(${quote(sessionOf(created))},
      ${quote(attemptId)}, ${quote(commandId)},
      ${quote(JSON.stringify(answers))}::jsonb, ${confirmation.phaseRevision},
      ${confirmation.skipped}, ${ts(atMs)}) s`);

interface KernelBegin {
  outcome: string;
  attempt_status: string;
  changed: boolean;
}

const beginAt = (
  created: CreatedGuest,
  attemptId: string,
  atMs: number,
): KernelBegin =>
  psqlJson<KernelBegin>(`select row_to_json(b) from
    m2_test.begin_lesen_at(${quote(sessionOf(created))}, ${quote(attemptId)},
      ${ts(atMs)}) b`);

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

const contextOf = async (
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

const examAudio = (page: Page) => page.getByTestId('exam-audio-element');

const requestsTo = (page: Page, path: string): Request[] => {
  const seen: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path) seen.push(request);
  });
  return seen;
};

// The choice of a full exam until its recording is prepared.
const prepareOnChoice = async (page: Page, slug: string) => {
  await page.goto(`/practice/${slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await page.getByTestId('mode-option-exam').click();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
};

interface Media {
  paused: boolean;
  currentTime: number;
  marker: string | null;
  plays: number;
  src: string;
}

const mediaOf = (page: Page): Promise<Media> =>
  examAudio(page).evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    currentTime: element.currentTime,
    marker: element.dataset.marker ?? null,
    plays: Number(element.dataset.plays ?? 0),
    src: element.currentSrc,
  }));

// Marks the one element and counts its plays, to tell it from a copy.
const markExamAudio = (page: Page) =>
  examAudio(page).evaluate((element: HTMLAudioElement) => {
    element.dataset.marker = 'prepared';
    element.addEventListener('play', () => {
      element.dataset.plays = String(Number(element.dataset.plays ?? 0) + 1);
    });
  });

const timerDeadline = async (page: Page): Promise<number> =>
  Number(
    await page.getByTestId('attempt-timer').getAttribute('data-deadline-ms'),
  );

test('prepared audio and explicit full start follow pinned phases', async ({
  browser,
}) => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  const starts = requestsTo(page, '/api/attempts/start');

  await prepareOnChoice(page, exam.slug);
  // The preparation wrote nothing: no attempt, command or start.
  expect(await readAttempts(sessionOf(created))).toEqual([]);
  expect(starts).toHaveLength(0);

  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  const attemptId = attemptIdOf(page);
  expect(starts).toHaveLength(1);
  const [run] = await readRunRows(attemptId);
  expect(run).toMatchObject({ mode: 'exam', selection: 'all' });
  expect(run?.assignment.questionIds).toEqual(ALL_IDS);
  const pinned = psqlJson<Record<string, unknown>>(
    `select timing_profile_snapshot from public.attempt_runs
      where attempt_id = ${quote(attemptId)}`,
  );
  expect(pinned).toMatchObject({
    hoerenSeconds: H,
    transitionSeconds: T,
    lesenSeconds: L,
    status: 'confirmed',
  });
  const startMs = Date.parse(examRunTimes(attemptId).acceptedAt);

  const shell = page.getByTestId('training-shell');
  await expect(shell).toHaveAttribute('data-mode', 'exam');
  await expect(shell).toHaveAttribute('data-phase', 'hoeren');
  expect(await timerDeadline(page)).toBe(startMs + H_MS);
  await expect(card(page, 'hoeren-1')).toBeVisible();

  // The pinned schedule, by the SQL rule and by the domain lifecycle, at
  // the exact boundaries of every phase.
  const vectors: [number, string][] = [
    [H_MS - 1, 'hoeren'],
    [H_MS, 'transition'],
    [H_MS + T_MS - 1, 'transition'],
    [H_MS + T_MS, 'lesen'],
    [H_MS + T_MS + L_MS - 1, 'lesen'],
    [H_MS + T_MS + L_MS, 'closed'],
  ];
  for (const [offsetMs, phase] of vectors) {
    expect(runPhaseAt(attemptId, ts(startMs + offsetMs)), `${offsetMs}`).toBe(
      phase,
    );
    const domain = resolveLifecycle(
      {
        mode: 'exam',
        selection: 'all',
        status: 'active',
        startedAtMs: startMs,
        durations: { hoerenMs: H_MS, transitionMs: T_MS, lesenMs: L_MS },
        closedSkills: [],
        lesenStartedAtMs: null,
      },
      startMs + offsetMs,
    );
    expect(domain.ok && domain.state.phase).toBe(phase);
  }
  await context.close();
});

test('early automatic and missed transitions preserve full lesen duration', async () => {
  const exam = await publishExam();

  // Early: inside the transition Lesen starts at once, with its full time,
  // once; a repeat changes nothing.
  const early = await newGuest(depsNow());
  const first = examAgo(early, exam, H + 10);
  const pause = await activeStatus(early.token, first.attemptId);
  expect(pause.state).toMatchObject({ phase: 'transition', phaseRevision: 1 });
  expect(pause.state.deadlineMs).toBe(first.startMs + H_MS + T_MS);
  const begun = await beginLesen(depsNow(), early.token, {
    attemptId: first.attemptId,
  });
  expect(begun).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', changed: true },
  });
  const started = examRunTimes(first.attemptId).lesenStartedAt;
  if (!started) throw new Error('Lesen has no start');
  const lesenMs = Date.parse(started);
  expect(lesenMs).toBeGreaterThanOrEqual(first.startMs + H_MS);
  expect(lesenMs).toBeLessThan(first.startMs + H_MS + T_MS);
  if (!begun.ok) throw new Error('begin failed');
  expect(begun.result.state).toMatchObject({
    phase: 'lesen',
    phaseRevision: 2,
  });
  expect(begun.result.state.deadlineMs).toBe(lesenMs + L_MS);
  const again = await beginLesen(depsNow(), early.token, {
    attemptId: first.attemptId,
  });
  expect(again).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', changed: false },
  });
  expect(examRunTimes(first.attemptId).lesenStartedAt).toBe(started);

  // Automatic: without the command Lesen starts at the end of the
  // transition; a late begin-lesen writes nothing.
  const automatic = await newGuest(depsNow());
  const second = examAgo(automatic, exam, H + T + 5);
  const reading = await activeStatus(automatic.token, second.attemptId);
  expect(reading.state.phase).toBe('lesen');
  expect(reading.state.deadlineMs).toBe(second.startMs + H_MS + T_MS + L_MS);
  expect(
    await beginLesen(depsNow(), automatic.token, {
      attemptId: second.attemptId,
    }),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', changed: false },
  });
  expect(examRunTimes(second.attemptId).lesenStartedAt).toBeNull();

  // A return 30 seconds into the transition catches up: the transition
  // keeps its own end, no new minute, Hören stays closed.
  const back = await newGuest(depsNow());
  const third = examAgo(back, exam, H + 30);
  const caught = await activeStatus(back.token, third.attemptId);
  expect(caught.state.phase).toBe('transition');
  expect(caught.timer).toMatchObject({
    phase: 'transition',
    deadlineMs: third.startMs + H_MS + T_MS,
  });
  const late = await saveAnswer(depsNow(), back.token, {
    attemptId: third.attemptId,
    questionId: 'hoeren-1',
    optionId: fullKeyOf('hoeren-1'),
    revision: 1,
  });
  expect(late).toEqual({ ok: false, error: 'attempt-not-found' });

  // A return after every deadline shows the closed exam and its result,
  // never a new phase.
  const away = await newGuest(depsNow());
  const fourth = examAgo(away, exam, TIMELINE_SECONDS + 5);
  const closed = await activeStatus(away.token, fourth.attemptId);
  expect(closed.outcome).toBe('result-ready');
  expect(closed.isClosedByDeadline).toBe(true);
  expect(closed.state.phase).toBe('closed');
  expect(
    await beginLesen(depsNow(), away.token, { attemptId: fourth.attemptId }),
  ).toMatchObject({ ok: true, result: { outcome: 'closed-phase' } });
  const [result] = (await readResults(fourth.attemptId)) as {
    max_score: number;
  }[];
  expect(result?.max_score).toBe(45);
});

test('full phase admission and accepted submission replay are final', async () => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 10);
  const at = (offsetMs: number) => startMs + offsetMs;

  // Hören is written until its deadline and never at it.
  expect(saveAt(created, attemptId, 'hoeren-1', 'b', 1, at(H_MS - 1))).toBe(
    'hoeren-1',
  );
  expect(() =>
    saveAt(created, attemptId, 'hoeren-2', 'c', 1, at(H_MS)),
  ).toThrow(/phase_closed/);
  // Lesen is refused in the transition and written from its start.
  expect(() =>
    saveAt(created, attemptId, 'lesen-1', 'a', 1, at(H_MS + T_MS - 1)),
  ).toThrow(/phase_closed/);
  expect(saveAt(created, attemptId, 'lesen-1', 'a', 1, at(H_MS + T_MS))).toBe(
    'lesen-1',
  );
  // The closed Hören is not rewritten in Lesen.
  expect(() =>
    saveAt(created, attemptId, 'hoeren-1', 'a', 2, at(H_MS + T_MS)),
  ).toThrow(/phase_closed/);

  // A submission accepted in Lesen replays after the end with the same
  // snapshot and moment.
  const commandId = randomUUID();
  const batch = [answer('lesen-2', 'a')];
  const accepted = submitAt(
    created,
    attemptId,
    commandId,
    batch,
    { phaseRevision: 2, skipped: 42 },
    at(H_MS + T_MS + SECOND_MS),
  );
  expect(accepted).toMatchObject({ outcome: 'accepted', skipped: 42 });
  const replayed = submitAt(
    created,
    attemptId,
    commandId,
    batch,
    { phaseRevision: 2, skipped: 42 },
    at(H_MS + T_MS + L_MS + 10 * SECOND_MS),
  );
  expect(replayed).toEqual({
    ...accepted,
    outcome: 'replayed',
    attempt_status: 'submitted',
  });
  // A new submission of the closed exam is a conflict, not a second one.
  expect(
    submitAt(
      created,
      attemptId,
      randomUUID(),
      [],
      { phaseRevision: 2, skipped: 42 },
      at(H_MS + T_MS + 2 * SECOND_MS),
    ).outcome,
  ).toBe('conflict');
  // The lost answer is repeated by the production submission as well.
  const repeated = await submitAttempt(depsNow(), created.token, {
    attemptId,
    commandId,
    answers: batch,
    confirmation: { phaseRevision: 2, skipped: 42 },
  });
  expect(repeated).toEqual({
    ok: true,
    result: { outcome: 'result-ready', attemptId },
  });
  expect((await readSubmission(attemptId)).frozen_answers).toEqual(
    accepted.frozen,
  );
});

test('full transition confirmations are accessible and localized', async ({
  browser,
}) => {
  const exam = await publishExam();
  const texts: Record<string, string> = {};
  for (const viewport of [NARROW, WIDE]) {
    for (const locale of ['en', 'ru'] as const) {
      const screen = `${locale} ${viewport.width}`;
      const created = await newGuest(depsNow());
      const update = await serviceDb
        .from('guest_sessions')
        .update({ locale })
        .eq('id', sessionOf(created));
      expect(update.error).toBeNull();
      const { attemptId, startMs } = examAgo(created, exam, H + 5);
      const context = await contextOf(browser, created.token, viewport);
      const page = await context.newPage();
      await page.goto(attemptUrl(exam.slug, attemptId));

      const transition = page.getByTestId('transition-screen');
      await expect(transition).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.lang)).toBe(
        locale,
      );
      // The new phase is announced once and takes the focus; the countdown
      // is a timer, not a live region.
      await expect(page.locator('#transition-title')).toBeFocused();
      const status = page.getByTestId('transition-status');
      await expect(status).toHaveAttribute('role', 'status');
      const timer = page.getByTestId('transition-timer');
      await expect(timer).toHaveAttribute('role', 'timer');
      expect(await timer.getAttribute('aria-live')).toBeNull();
      expect(Number(await timer.getAttribute('data-deadline-ms'))).toBe(
        startMs + H_MS + T_MS,
      );
      texts[screen] = (await status.textContent()) ?? '';
      expect(texts[screen]).not.toBe('');
      await expectUsableLayout(page, `transition ${screen}`);
      for (const marker of LESEN_MARKERS) {
        expect(await page.content(), marker).not.toContain(marker);
      }

      // The early confirmation by keyboard counts the unopened Lesen.
      await page.getByTestId('finish-attempt').focus();
      await page.keyboard.press('Enter');
      const confirmation = page.getByTestId('finish-confirmation');
      await expect(confirmation).toHaveAttribute('data-skipped', '45');
      await expect(confirmation).toHaveAttribute('data-unopened', '25');
      await expect(confirmation).toHaveAttribute('data-total', '45');
      await expect(page.getByTestId('finish-unopened')).toBeVisible();
      await page.getByTestId('finish-cancel').focus();
      await page.keyboard.press('Enter');
      await expect(confirmation).toHaveCount(0);

      // Starting Lesen by keyboard gives it its full time, once.
      await page.getByTestId('begin-lesen').focus();
      await page.keyboard.press('Enter');
      await page.waitForURL(LESEN_URL);
      await expect(page.getByTestId('training-shell')).toHaveAttribute(
        'data-phase',
        'lesen',
      );
      await expect(card(page, 'lesen-1')).toHaveCount(1);
      const started = examRunTimes(attemptId).lesenStartedAt;
      if (!started) throw new Error('Lesen has no start');
      await expect
        .poll(() => timerDeadline(page))
        .toBe(Date.parse(started) + L_MS);
      await expectUsableLayout(page, `lesen ${screen}`);
      await context.close();
    }
  }
  expect(texts['ru 390']).not.toBe(texts['en 390']);
  expect(texts['ru 1440']).toBe(texts['ru 390']);
});

test('early submit at every full phase retains forty five maximum', async () => {
  const exam = await publishExam();
  const phases: [string, number, number][] = [
    ['hoeren', 10, 43],
    ['transition', H + 10, 43],
    ['lesen', H + T + 10, 42],
  ];
  for (const [phase, ago, skipped] of phases) {
    const created = await newGuest(depsNow());
    const { attemptId, startMs } = examAgo(created, exam, ago);
    saveAt(created, attemptId, 'hoeren-1', fullKeyOf('hoeren-1'), 1, startMs);
    saveAt(created, attemptId, 'hoeren-2', fullWrongOf('hoeren-2'), 1, startMs);
    if (phase === 'lesen') {
      const saved = await saveAnswer(depsNow(), created.token, {
        attemptId,
        questionId: 'lesen-1',
        optionId: fullKeyOf('lesen-1'),
        revision: 1,
      });
      expect(saved.ok).toBe(true);
    }
    const view = await activeStatus(created.token, attemptId);
    expect(view.state.phase).toBe(phase);
    expect(view.skipped).toBe(skipped);
    expect(view.summary.totalAssigned).toBe(45);
    const submitted = await submitAttempt(depsNow(), created.token, {
      attemptId,
      commandId: randomUUID(),
      answers: [],
      confirmation: {
        phaseRevision: view.state.phaseRevision,
        skipped: view.skipped,
      },
    });
    expect(submitted, phase).toEqual({
      ok: true,
      result: { outcome: 'result-ready', attemptId },
    });
    const [result] = (await readResults(attemptId)) as Record<
      string,
      unknown
    >[];
    expect(result, phase).toMatchObject({
      scope: 'full-exam',
      max_score: 45,
      hoeren_max: 20,
      lesen_max: 25,
      skipped_count: skipped,
      score: phase === 'lesen' ? 2 : 1,
    });
    expect(result?.level).not.toBeNull();
    // The time is over for good: nothing is written or started any more.
    const after = await saveAnswer(depsNow(), created.token, {
      attemptId,
      questionId: 'hoeren-3',
      optionId: 'b',
      revision: 1,
    });
    expect(after.ok).toBe(false);
    expect(
      await beginLesen(depsNow(), created.token, { attemptId }),
    ).toMatchObject({ ok: true, result: { outcome: 'closed-phase' } });
    expect((await activeStatus(created.token, attemptId)).outcome).toBe(
      'result-ready',
    );
  }
});

test('player controls follow mode without pausing exam deadline', async ({
  browser,
}) => {
  const exam = await publishExam();

  // Full exam: no pause, seek, back or speed; pausing the element itself
  // does not move the server deadline.
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 5);
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.goto(attemptUrl(exam.slug, attemptId));
  const player = page.getByTestId('audio-player');
  await expect(player).toHaveAttribute('data-mode', 'exam');
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('audio-toggle')).toHaveCount(0);
  await expect(page.getByTestId('audio-back')).toHaveCount(0);
  await expect(player.getByRole('slider')).toHaveCount(0);
  await expect(page.getByTestId('audio-element')).toHaveCount(0);
  // Play only unlocks the sound after a reload, at the server's position.
  await page.getByTestId('audio-unlock').click();
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);
  await expect(page.getByTestId('audio-unlock')).toHaveCount(0);
  await expect
    .poll(async () => {
      const { currentTime } = await mediaOf(page);
      return Math.abs(currentTime - (Date.now() - startMs) / SECOND_MS);
    })
    .toBeLessThan(2.5);
  expect(await timerDeadline(page)).toBe(startMs + H_MS);
  await examAudio(page).evaluate((element: HTMLAudioElement) =>
    element.pause(),
  );
  const paused = await activeStatus(created.token, attemptId);
  expect(paused.state.deadlineMs).toBe(startMs + H_MS);
  expect(Date.parse(examRunTimes(attemptId).acceptedAt)).toBe(startMs);
  await context.close();

  // Free training and a timed block keep the usual controls.
  for (const mode of ['training', 'timed-block'] as const) {
    const guest = await newGuest(depsNow());
    const started = await startFor(depsNow(), guest.token, exam.slug, {
      mode,
      selection: 'hoeren',
    });
    if (!started.ok) throw new Error(`${mode} start: ${started.failure}`);
    const ownContext = await contextOf(browser, guest.token);
    const ownPage = await ownContext.newPage();
    await ownPage.goto(attemptUrl(exam.slug, started.result.attemptId));
    await expect(ownPage.getByTestId('audio-toggle')).toBeVisible();
    await expect(ownPage.getByTestId('audio-back')).toBeVisible();
    await expect(
      ownPage.getByTestId('audio-player').getByRole('slider'),
    ).toBeVisible();
    await expect(ownPage.getByTestId('exam-audio-element')).toHaveCount(1);
    if (mode === 'timed-block') {
      const deadline = started.result.state.deadlineMs;
      await expect(ownPage.getByTestId('audio-toggle')).toBeEnabled({
        timeout: 20_000,
      });
      await ownPage.getByTestId('audio-toggle').click();
      await ownPage.getByTestId('audio-toggle').click();
      // The block keeps running while its recording is paused.
      expect(await timerDeadline(ownPage)).toBe(deadline);
      const view = await activeStatus(guest.token, started.result.attemptId);
      expect(view.state.deadlineMs).toBe(deadline);
    }
    await ownContext.close();
  }
});

test('full prepared audio survives choice to attempt navigation', async ({
  browser,
}) => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await prepareOnChoice(page, exam.slug);
  await markExamAudio(page);
  const prepared = await mediaOf(page);
  expect(prepared.paused).toBe(true);

  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  const attemptId = attemptIdOf(page);
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-phase',
    'hoeren',
  );
  // The same element, never a copy, keeps playing the same address: one
  // play from the click, no second autoplay.
  await expect(examAudio(page)).toHaveCount(1);
  await expect(page.getByTestId('audio-element')).toHaveCount(0);
  await expect.poll(async () => (await mediaOf(page)).paused).toBe(false);
  const playing = await mediaOf(page);
  expect(playing.marker).toBe('prepared');
  expect(playing.src).toBe(prepared.src);
  expect(playing.plays).toBe(1);
  // Its position follows the server's start of Hören.
  const startMs = Date.parse(examRunTimes(attemptId).acceptedAt);
  const serverSeconds = (Date.now() - startMs) / SECOND_MS;
  expect(Math.abs(playing.currentTime - serverSeconds)).toBeLessThan(2.5);
  await context.close();

  // A refused start stops the sound at once and creates nothing.
  const short = await shortGuest(TIMELINE_SECONDS + RESERVE_SECONDS - 120);
  const refusedContext = await contextOf(browser, short.token);
  const refusedPage = await refusedContext.newPage();
  await prepareOnChoice(refusedPage, exam.slug);
  await refusedPage.getByTestId('start-attempt').click();
  await expect(refusedPage.getByTestId('start-guest-too-short')).toBeVisible();
  await expect
    .poll(async () => {
      const media = await mediaOf(refusedPage);
      return media.paused && media.currentTime === 0;
    })
    .toBe(true);
  expect(await readAttempts(sessionOf(short))).toEqual([]);
  await refusedContext.close();
});

test('early full confirmation counts unopened lesen without leaking material', async ({
  browser,
}) => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const { attemptId } = examAgo(created, exam, 5);
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  const submits = requestsTo(page, `/api/attempts/${attemptId}/submit`);
  // One answer stored before the page opened, one chosen on it.
  const stored = await saveAnswer(depsNow(), created.token, {
    attemptId,
    questionId: 'hoeren-2',
    optionId: fullKeyOf('hoeren-2'),
    revision: 1,
  });
  expect(stored.ok).toBe(true);
  await page.goto(attemptUrl(exam.slug, attemptId));
  const target = card(page, 'hoeren-1');
  await optionIn(target, fullKeyOf('hoeren-1')).check();
  await expectStatus(target, 'saved');
  await page.getByTestId('finish-attempt').click();
  const confirmation = page.getByTestId('finish-confirmation');
  await expect(confirmation).toHaveAttribute('data-total', '45');
  await expect(confirmation).toHaveAttribute('data-skipped', '43');
  await expect(confirmation).toHaveAttribute('data-unanswered-lesen', '25');
  await expect(confirmation).toHaveAttribute('data-unopened', '25');
  const html = await page.content();
  for (const marker of LESEN_MARKERS)
    expect(html, marker).not.toContain(marker);

  await page.getByTestId('finish-confirm').click();
  await expect.poll(async () => (await readResults(attemptId)).length).toBe(1);
  // One submission, accepted on the first confirmation.
  expect(submits).toHaveLength(1);
  const [result] = (await readResults(attemptId)) as Record<string, unknown>[];
  expect(result).toMatchObject({ max_score: 45, skipped_count: 43, score: 2 });
  await context.close();
});

test('full start requires fresh prepared audio through horen duration', async ({
  browser,
}) => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.clock.install();
  const prepares = requestsTo(page, '/api/attempts/prepare-audio');
  const starts = requestsTo(page, '/api/attempts/start');
  await prepareOnChoice(page, exam.slug);
  expect(prepares).toHaveLength(1);
  const first = await mediaOf(page);
  const firstAudio = (await (await prepares[0]?.response())?.json()) as {
    audio: { expiresAt: string; serverNow: string; coverSeconds: number };
  };
  // The address covers the whole Hören plus the margin.
  expect(firstAudio.audio.coverSeconds).toBe(H);
  expect(
    Date.parse(firstAudio.audio.expiresAt) -
      Date.parse(firstAudio.audio.serverNow),
  ).toBe((H + RESERVE_SECONDS) * SECOND_MS);

  // Every new load of the one element is counted: a renewal loads again
  // even when Storage signs the same address within the same second.
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    element.dataset.loads = '0';
    element.addEventListener('loadstart', () => {
      element.dataset.loads = String(Number(element.dataset.loads) + 1);
    });
  });

  // After waiting on the choice the address no longer covers Hören: the
  // start is blocked until a new address is playable; no time runs.
  await page.clock.fastForward('04:50');
  await expect(page.getByTestId('start-attempt')).toBeDisabled();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  expect(prepares).toHaveLength(2);
  const renewedAudio = (await (await prepares[1]?.response())?.json()) as {
    audio: { url: string; coverSeconds: number };
  };
  expect(renewedAudio.audio.coverSeconds).toBe(H);
  const renewed = await mediaOf(page);
  // The element plays the renewed answer, loaded anew, still silent.
  expect(renewed.src).toBe(renewedAudio.audio.url);
  expect(
    Number(
      await examAudio(page).evaluate(
        (element: HTMLAudioElement) => element.dataset.loads,
      ),
    ),
  ).toBeGreaterThanOrEqual(1);
  expect(first.src).not.toBe('');
  expect(renewed.paused).toBe(true);
  expect(starts).toHaveLength(0);
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  expect(starts).toHaveLength(1);
  expect((await mediaOf(page)).src).toBe(renewed.src);
  await context.close();
});

test('full start applies entire timeline guest reserve', async () => {
  const exam = await publishExam();
  const reserve = TIMELINE_SECONDS + RESERVE_SECONDS;

  // Enough for one block, not for the whole exam: refused before writing.
  const short = await shortGuest(reserve - 60);
  const body = { mode: 'exam', selection: 'all' };
  expect(await startFor(depsNow(), short.token, exam.slug, body)).toEqual({
    ok: false,
    failure: 'guest-too-short',
  });
  expect(
    await startFor(depsNow(), short.token, exam.slug, {
      mode: 'timed-block',
      selection: 'lesen',
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  expect(
    (await readAttempts(sessionOf(short))).map((row) => row.status),
  ).toEqual(['active']);
  // An active attempt is a conflict before the reserve is judged.
  expect(await startFor(depsNow(), short.token, exam.slug, body)).toMatchObject(
    { ok: true, result: { outcome: 'conflict' } },
  );

  const shorter = await shortGuest(reserve - 60);
  const latest = await latestVersionOf(exam.slug);
  const preflight = await preflightTimedStart(depsNow(), shorter.token, {
    commandId: randomUUID(),
    examSlug: exam.slug,
    mode: 'exam',
    purpose: 'normal',
    selection: 'all',
    sourceAttemptId: null,
    expectedVersionId: latest?.versionId,
  });
  expect(preflight).toEqual({ ok: false, failure: 'guest-too-short' });
  expect(await readAttempts(sessionOf(shorter))).toEqual([]);

  const enough = await shortGuest(reserve + 60);
  expect(
    await startFor(depsNow(), enough.token, exam.slug, body),
  ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });

  // The SQL start after its lock, at the exact edge of the reserve.
  for (const [shiftMs, isAccepted] of [
    [0, true],
    [1, false],
  ] as const) {
    const edge = await shortGuest(reserve + 30);
    const expiresAt = psql(`select to_json(expires_at) #>> '{}'
      from public.guest_sessions where id = ${quote(sessionOf(edge))}`);
    const atMs = Date.parse(expiresAt) - reserve * SECOND_MS + shiftMs;
    const run = () => startExamAt(sessionOf(edge), exam, ALL_IDS, ts(atMs));
    if (isAccepted) expect(run()).toMatch(/^[0-9a-f-]{36}$/);
    else expect(run).toThrow(/guest_too_short/);
    expect((await readAttempts(sessionOf(edge))).length).toBe(
      isAccepted ? 1 : 0,
    );
  }
});

test('failed preparation and stale version cannot start full exam', async ({
  browser,
}) => {
  // A recording that cannot be loaded: the start stays blocked.
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.route('**/api/attempts/prepare-audio', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { audio: Record<string, unknown> };
    body.audio.url = `${FULL_ORIGIN}/missing-recording.wav`;
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/practice/${exam.slug}`);
  await page.getByTestId('mode-option-exam').click();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'error',
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('start-attempt')).toBeDisabled();
  expect((await mediaOf(page)).paused).toBe(true);
  expect(await readAttempts(sessionOf(created))).toEqual([]);
  await context.close();

  // A version published after the preparation: the start is refused, the
  // sound stops and no attempt exists on either version.
  const changing = await publishExam();
  const guest = await newGuest(depsNow());
  const changedContext = await contextOf(browser, guest.token);
  const changedPage = await changedContext.newPage();
  await prepareOnChoice(changedPage, changing.slug);
  const republished = await publishExam(FULL_TIMING, changing.slug, 733);
  expect(republished.versionId).not.toBe(changing.versionId);
  await changedPage.getByTestId('start-attempt').click();
  await expect(changedPage.getByTestId('start-status')).toHaveAttribute(
    'data-status',
    'changed',
  );
  await expect
    .poll(async () => {
      const media = await mediaOf(changedPage);
      return media.paused && media.currentTime === 0;
    })
    .toBe(true);
  expect(await readAttempts(sessionOf(guest))).toEqual([]);
  await changedContext.close();
});

test('concurrent transition cannot reopen or extend a phase', async () => {
  const exam = await publishExam();

  // Two begin-lesen of the same transition: the first moment stays.
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, H + 10);
  expect(beginAt(created, attemptId, startMs + H_MS + 5 * SECOND_MS)).toEqual({
    outcome: 'accepted',
    attempt_status: 'active',
    changed: true,
  });
  const first = examRunTimes(attemptId).lesenStartedAt;
  expect(beginAt(created, attemptId, startMs + H_MS + 8 * SECOND_MS)).toEqual({
    outcome: 'accepted',
    attempt_status: 'active',
    changed: false,
  });
  expect(
    await beginLesen(depsNow(), created.token, { attemptId }),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', changed: false },
  });
  expect(examRunTimes(attemptId).lesenStartedAt).toBe(first);
  // The moment is fixed by the database itself, even for its owner; the
  // runtime role cannot update runs at all.
  const moved = await serviceDb
    .from('attempt_runs')
    .update({
      lesen_started_at: new Date(startMs + H_MS + 30_000).toISOString(),
    })
    .eq('attempt_id', attemptId);
  expect(moved.error).not.toBeNull();
  const setLesen = (id: string, atMs: number) =>
    psql(`update public.attempt_runs set lesen_started_at = ${ts(atMs)}
      where attempt_id = ${quote(id)}`);
  expect(() => setLesen(attemptId, startMs + H_MS + 30_000)).toThrow(
    /attempt_run_fixed/,
  );
  // Hören stays closed in Lesen; its old status does not reopen it.
  const late = await saveAnswer(depsNow(), created.token, {
    attemptId,
    questionId: 'hoeren-1',
    optionId: 'b',
    revision: 1,
  });
  expect(late).toEqual({ ok: false, error: 'attempt-not-found' });

  // In Hören an early start of Lesen is refused and writes nothing; a
  // moment outside the transition is refused by the database itself.
  const listening = await newGuest(depsNow());
  const open = examAgo(listening, exam, 10);
  expect(beginAt(listening, open.attemptId, open.startMs + SECOND_MS)).toEqual({
    outcome: 'phase-not-open',
    attempt_status: 'active',
    changed: false,
  });
  expect(
    await beginLesen(depsNow(), listening.token, { attemptId: open.attemptId }),
  ).toMatchObject({ ok: true, result: { outcome: 'phase-not-open' } });
  expect(() => setLesen(open.attemptId, open.startMs + 1000)).toThrow(
    /lesen_start_invalid/,
  );
  expect(examRunTimes(open.attemptId).lesenStartedAt).toBeNull();
  expect(runPhaseAt(open.attemptId, 'clock_timestamp()')).toBe('hoeren');

  // Two tabs start Lesen at once: one moment, written once.
  const tabs = await newGuest(depsNow());
  const pause = examAgo(tabs, exam, H + 20);
  const answers = await Promise.all(
    [0, 1].map(() =>
      beginLesen(depsNow(), tabs.token, { attemptId: pause.attemptId }),
    ),
  );
  const changed = answers.map((item) =>
    item.ok && 'changed' in item.result ? item.result.changed : null,
  );
  expect([...changed].sort()).toEqual([false, true]);
  const both = answers.map((item) =>
    item.ok ? item.result.state.lesenStartedAtMs : null,
  );
  expect(both[0]).toBe(both[1]);
  expect(Date.parse(examRunTimes(pause.attemptId).lesenStartedAt ?? '')).toBe(
    both[0],
  );
});

test('full exact deadline and expired guest cannot admit writes', async () => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const { attemptId, startMs } = examAgo(created, exam, 10);
  const endMs = startMs + H_MS + T_MS + L_MS;
  expect(saveAt(created, attemptId, 'lesen-1', 'a', 1, endMs - 1)).toBe(
    'lesen-1',
  );
  expect(() => saveAt(created, attemptId, 'lesen-2', 'a', 1, endMs)).toThrow(
    /phase_closed/,
  );
  expect(() =>
    psql(`select * from m2_test.save_progress_at(${quote(sessionOf(created))},
      ${quote(attemptId)}, '{"block":"lesen"}'::jsonb, ${ts(endMs)})`),
  ).toThrow(/phase_closed/);
  const closing = submitAt(
    created,
    attemptId,
    randomUUID(),
    [answer('lesen-2', 'a')],
    { phaseRevision: 2, skipped: 43 },
    endMs,
  );
  expect(closing.outcome).toBe('closed-phase');
  expect(closing.frozen).toEqual({ 'lesen-1': { optionId: 'a', revision: 1 } });
  expect(await readAnswerRows(attemptId)).toEqual([
    { question_id: 'lesen-1', option_id: 'a', revision: 1 },
  ]);

  // An accepted submission of an expired guest is not replayed to it: the
  // term is checked before any command is answered.
  const reserve = TIMELINE_SECONDS + RESERVE_SECONDS;
  const ending = await shortGuest(reserve + 5);
  const expiresAt = psql(`select to_json(expires_at) #>> '{}'
    from public.guest_sessions where id = ${quote(sessionOf(ending))}`);
  // The term carries microseconds: one millisecond later it has ended.
  const expiresMs = Date.parse(expiresAt) + 1;
  const short = examAgo(ending, exam, 3);
  const commandId = randomUUID();
  expect(
    submitAt(
      ending,
      short.attemptId,
      commandId,
      [],
      { phaseRevision: 0, skipped: 45 },
      short.startMs + SECOND_MS,
    ).outcome,
  ).toBe('accepted');
  expect(() =>
    submitAt(
      ending,
      short.attemptId,
      commandId,
      [],
      { phaseRevision: 0, skipped: 45 },
      expiresMs,
    ),
  ).toThrow(/guest_session_invalid/);
  expect(() =>
    saveAt(ending, short.attemptId, 'hoeren-1', 'b', 1, expiresMs),
  ).toThrow(/guest_session_invalid/);
  expect(
    await readAttemptStatus(depsAt(new Date(expiresMs)), ending.token, {
      attemptId: short.attemptId,
    }),
  ).toEqual({ ok: false, failure: 'session-invalid' });
});

test('early full submit cannot inject unseen lesen answers', async () => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const { attemptId } = examAgo(created, exam, 10);
  const view = await activeStatus(created.token, attemptId);
  expect(view.skipped).toBe(45);
  expect(Object.keys(view.answers)).toEqual([]);
  const batch = [
    answer('hoeren-1', fullKeyOf('hoeren-1')),
    answer('lesen-1', fullKeyOf('lesen-1')),
  ];
  // Counting the Lesen answer as given is a stale confirmation: nothing is
  // written.
  const counted = await submitAttempt(depsNow(), created.token, {
    attemptId,
    commandId: randomUUID(),
    answers: batch,
    confirmation: { phaseRevision: 0, skipped: 43 },
  });
  expect(counted).toMatchObject({
    ok: true,
    result: { outcome: 'stale-confirmation' },
  });
  expect(await readAnswerRows(attemptId)).toEqual([]);
  // Accepted with the Lesen task as skipped: its answer is not taken.
  const accepted = await submitAttempt(depsNow(), created.token, {
    attemptId,
    commandId: randomUUID(),
    answers: batch,
    confirmation: { phaseRevision: 0, skipped: 44 },
  });
  expect(accepted).toEqual({
    ok: true,
    result: { outcome: 'result-ready', attemptId },
  });
  expect((await readSubmission(attemptId)).frozen_answers).toEqual({
    'hoeren-1': { optionId: fullKeyOf('hoeren-1'), revision: 1 },
  });
  expect(
    (await readAnswerRows(attemptId)).map((row) => row.question_id),
  ).toEqual(['hoeren-1']);
  const [result] = (await readResults(attemptId)) as Record<string, unknown>[];
  expect(result).toMatchObject({ skipped_count: 44, lesen_score: 0 });
});

test('client audio controls cannot alter server lifecycle', async ({
  request,
}) => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  for (const extra of [
    { durationSeconds: 99_999 },
    { positionSeconds: 1200 },
    { hoerenStartedAt: new Date(0).toISOString() },
  ]) {
    expect(
      await startFor(depsNow(), created.token, exam.slug, {
        mode: 'exam',
        selection: 'all',
        ...extra,
      } as never),
    ).toEqual({ ok: false, failure: 'invalid-input' });
  }
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  const { attemptId, startMs } = examAgo(created, exam, 10);
  const before = examRunTimes(attemptId);
  const forged = { positionSeconds: H - 1, durationSeconds: 1 };
  expect(
    await readAttemptStatus(depsNow(), created.token, { attemptId, ...forged }),
  ).toEqual({ ok: false, failure: 'invalid-input' });
  expect(
    await saveAnswer(depsNow(), created.token, {
      attemptId,
      questionId: 'hoeren-1',
      optionId: 'b',
      revision: 1,
      ...forged,
    }),
  ).toEqual({ ok: false, error: 'invalid-input' });
  expect(
    await resolveAttemptAudio(depsNow(), created.token, {
      attemptId,
      trackId: FULL_TRACK_ID,
      ...forged,
    }),
  ).toEqual({ ok: false, error: 'invalid-input' });
  expect(
    await beginLesen(depsNow(), created.token, { attemptId, at: startMs }),
  ).toEqual({ ok: false, failure: 'invalid-input' });
  const headers = {
    'content-type': 'application/json',
    cookie: `${GUEST_COOKIE}=${created.token}`,
    origin: FULL_ORIGIN,
  };
  for (const [command, body] of [
    ['begin-lesen', { at: startMs }],
    ['audio', { trackId: FULL_TRACK_ID, ...forged }],
    ['status', forged],
  ] as const) {
    const response = await request.post(
      `${FULL_ORIGIN}/api/attempts/${attemptId}/${command}`,
      { headers, data: JSON.stringify(body) },
    );
    expect(response.status(), command).toBe(400);
  }
  // A place reported by the page is only a place: the phase, the deadline
  // and the admission of writes stay the server's.
  expect(
    await saveProgress(depsNow(), created.token, {
      attemptId,
      progress: { block: 'hoeren', positionSeconds: H - 1 },
    }),
  ).toMatchObject({ ok: true });
  expect(examRunTimes(attemptId)).toEqual(before);
  const view = await activeStatus(created.token, attemptId);
  expect(view.state).toMatchObject({ phase: 'hoeren' });
  expect(view.state.deadlineMs).toBe(startMs + H_MS);
  const lesen = await saveAnswer(depsNow(), created.token, {
    attemptId,
    questionId: 'lesen-1',
    optionId: 'a',
    revision: 1,
  });
  expect(lesen).toEqual({ ok: false, error: 'attempt-not-found' });
});

test('stale full preparation refreshes before explicit start', async ({
  browser,
}) => {
  const exam = await publishExam();
  const created = await newGuest(depsNow());
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.clock.install();
  const starts = requestsTo(page, '/api/attempts/start');
  await prepareOnChoice(page, exam.slug);

  // The renewal is held: while it is pending the start cannot run, by
  // click or keyboard, and nothing plays.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/attempts/prepare-audio', async (route) => {
    await held;
    await route.continue();
  });
  await page.clock.fastForward('04:50');
  const startButton = page.getByTestId('start-attempt');
  await expect(startButton).toBeDisabled();
  await expect(page.getByTestId('exam-audio-status')).not.toHaveAttribute(
    'data-status',
    'ready',
  );
  await startButton.focus();
  await page.keyboard.press('Enter');
  expect(starts).toHaveLength(0);
  expect((await mediaOf(page)).paused).toBe(true);
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  release();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await page.unroute('**/api/attempts/prepare-audio');

  // A refused renewal shows the error and still starts nothing.
  await page.route('**/api/attempts/prepare-audio', (route) =>
    route.fulfill({ status: 503, json: { ok: false, error: 'unavailable' } }),
  );
  await page.clock.fastForward('04:50');
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'error',
  );
  await expect(startButton).toBeDisabled();
  expect(starts).toHaveLength(0);
  expect(await readAttempts(sessionOf(created))).toEqual([]);

  // A fresh preparation then starts the exam once.
  await page.unroute('**/api/attempts/prepare-audio');
  await page.getByTestId('exam-audio-retry').click();
  await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await startButton.click();
  await page.waitForURL(HOEREN_URL);
  expect(starts).toHaveLength(1);
  expect(
    (await readAttempts(sessionOf(created))).map((row) => row.status),
  ).toEqual(['active']);
  await context.close();
});

const EXAM_RUNTIME_FUNCTIONS = ['public.m2_begin_lesen(uuid, uuid)'];

const EXAM_PRIVATE_FUNCTIONS = [
  'm2_private.pinned_interval(public.attempt_runs, text)',
  'm2_private.lesen_start(public.attempt_runs)',
  'm2_private.run_phase(public.attempt_runs, timestamptz)',
  'm2_private.phase_revision(public.attempt_runs, timestamptz)',
  'm2_private.question_skill(uuid, text)',
  'm2_private.is_open_task(public.attempts, public.attempt_runs, text, timestamptz)',
  'm2_private.begin_lesen(uuid, uuid, timestamptz)',
];

const canExecute = (role: string, fn: string): boolean =>
  psql(
    `select has_function_privilege(${quote(role)}, ${quote(fn)}, 'execute')`,
  ) === 't';

test('full exam functions and routes deny public roles and foreign guests', async ({
  request,
}) => {
  const all = [...EXAM_RUNTIME_FUNCTIONS, ...EXAM_PRIVATE_FUNCTIONS];
  const publicAcl = psql(`select count(*) from pg_proc p,
    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where x.grantee = 0 and p.oid in (${all
      .map((fn) => `${quote(fn)}::regprocedure`)
      .join(', ')})`);
  expect(publicAcl).toBe('0');
  for (const fn of all) {
    expect(canExecute('anon', fn), `anon ${fn}`).toBe(false);
    expect(canExecute('authenticated', fn), `authenticated ${fn}`).toBe(false);
  }
  for (const fn of EXAM_RUNTIME_FUNCTIONS) {
    expect(canExecute('service_role', fn), fn).toBe(true);
  }
  for (const fn of EXAM_PRIVATE_FUNCTIONS) {
    expect(canExecute('service_role', fn), fn).toBe(false);
  }

  const exam = await publishExam();
  const owner = await newGuest(depsNow());
  const { attemptId } = examAgo(owner, exam, H + 10);
  const before = examRunTimes(attemptId);

  // The publishable key reaches neither the runtime nor the kernel.
  const anon = createPublicClient();
  const direct = await anon.rpc('m2_begin_lesen', {
    p_session_id: sessionOf(owner),
    p_attempt_id: attemptId,
  });
  expect(direct.error).not.toBeNull();

  // HTTP: no cookie, a foreign guest, a foreign origin.
  const intruder = await newGuest(depsNow());
  const post = (path: string, headers: Record<string, string>, body = '{}') =>
    request.post(`${FULL_ORIGIN}${path}`, {
      headers: { 'content-type': 'application/json', ...headers },
      data: body,
    });
  const begin = `/api/attempts/${attemptId}/begin-lesen`;
  const prepareBody = JSON.stringify({
    examSlug: exam.slug,
    expectedVersionId: exam.versionId,
  });
  expect((await post(begin, { origin: FULL_ORIGIN })).status()).toBe(401);
  expect(
    (
      await post(begin, {
        origin: FULL_ORIGIN,
        cookie: `${GUEST_COOKIE}=${intruder.token}`,
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await post(begin, {
        origin: 'https://evil.example',
        cookie: `${GUEST_COOKIE}=${owner.token}`,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await post(
        '/api/attempts/prepare-audio',
        { origin: FULL_ORIGIN },
        prepareBody,
      )
    ).status(),
  ).toBe(401);
  expect(
    (
      await post(
        '/api/attempts/prepare-audio',
        {
          origin: 'https://evil.example',
          cookie: `${GUEST_COOKIE}=${owner.token}`,
        },
        prepareBody,
      )
    ).status(),
  ).toBe(403);
  expect(
    (
      await post(
        `/api/attempts/${attemptId}/audio`,
        { origin: FULL_ORIGIN, cookie: `${GUEST_COOKIE}=${intruder.token}` },
        JSON.stringify({ trackId: FULL_TRACK_ID }),
      )
    ).status(),
  ).toBe(404);
  // Nothing of the owner's exam changed.
  expect(examRunTimes(attemptId)).toEqual(before);
  expect(await readAttempts(sessionOf(intruder))).toEqual([]);
});
