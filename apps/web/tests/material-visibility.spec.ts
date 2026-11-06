import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import {
  readAttemptPage,
  readAttemptStatus,
  saveAnswer,
} from '../src/server/attempts/attempts';
import {
  prepareExamAudio,
  resolveAttemptAudio,
} from '../src/server/audio/audio';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  createPublicClient,
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  serviceDb,
} from './support/db';
import {
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  ensureConfirmedTestProfile,
  fullKeyOf,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  HOEREN_URL,
  LESEN_URL,
  attemptLesenUrl,
  attemptUrl,
  card,
  expectStatus,
  optionIn,
} from './support/guest-browser';
import {
  examRunTimes,
  installM2Fixtures,
  secondsAgoSql,
  sqlRunnerAs,
  startExamAt,
} from './support/sql';

// The material of a full exam by its trusted phase (#45): Lesen reaches no
// transport before its phase starts, not the page, its RSC payload, the
// status, a save or the recording; a closed Hören gets no new recording
// address. Runs are placed in a phase by starting them through the
// admission kernel at an earlier moment.

const FULL_ORIGIN = 'http://localhost:3102';
const SECOND_MS = 1000;
const owner = sqlRunnerAs('owner');
const H = FULL_TIMING.hoerenSeconds;
const T = FULL_TIMING.transitionSeconds;
const L = FULL_TIMING.lesenSeconds;
const ALL_IDS = FULL_PILOT.content.questions.map((question) => question.id);

// A Hören shorter than the 60 seconds of the test recording, so it still
// plays when Hören ends, and a transition long enough to look at it.
const SHORT_HOEREN: TimingSettings = {
  recordingSeconds: 60,
  hoerenSeconds: 20,
  transitionSeconds: 40,
  lesenSeconds: 60,
};

// Task ids, prompts, text ids and texts of Lesen.
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
  settings: TimingSettings = FULL_TIMING,
): Promise<Exam> => {
  const slug = `test-visible-${randomUUID().slice(0, 8)}`;
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: 'Material visibility test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(677) }],
  });
  ensureConfirmedTestProfile(owner, outcome.versionId, settings);
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error('exam is missing');
  return { slug, examId: latest.examId, versionId: latest.versionId };
};

const examAgo = (created: CreatedGuest, exam: Exam, seconds: number) => {
  const attemptId = startExamAt(
    created.guest.sessionId,
    exam,
    ALL_IDS,
    secondsAgoSql(seconds),
  );
  return {
    attemptId,
    startMs: Date.parse(examRunTimes(attemptId).acceptedAt),
  };
};

const cookieOf = (token: string) => `${GUEST_COOKIE}=${token}`;

const expectNoLesen = (body: string, where: string) => {
  for (const marker of LESEN_MARKERS) {
    expect(body, `${where}: ${marker}`).not.toContain(marker);
  }
};

// The RSC payload of an address, as the router of the browser fetches it.
// Next answers an RSC request without its cache-busting parameter with a
// redirect to it; the payload itself must be a real flight response, so a
// missing payload never passes as one without Lesen.
const rscPayloadOf = async (
  request: APIRequestContext,
  url: string,
  cookie: string,
): Promise<string> => {
  const headers = { cookie, RSC: '1' };
  const first = await request.get(url, { headers, maxRedirects: 0 });
  // The redirect is followed by hand: the cookie header is not carried over.
  const location = first.headers()['location'];
  const response = location
    ? await request.get(new URL(location, FULL_ORIGIN).toString(), {
        headers,
        maxRedirects: 0,
      })
    : first;
  expect(response.headers()['content-type']).toContain('text/x-component');
  const payload = await response.text();
  expect(payload.length).toBeGreaterThan(100);
  return payload;
};

interface Transports {
  hoerenHtml: string;
  lesenHtml: string;
  lesenFinalUrl: string;
  hoerenRsc: string;
  lesenRsc: string;
  status: string;
}

// Everything a browser can ask of an attempt: the HTML of both addresses,
// their RSC payloads and the status JSON.
const transportsOf = async (
  request: APIRequestContext,
  token: string,
  exam: Exam,
  attemptId: string,
): Promise<Transports> => {
  const cookie = cookieOf(token);
  const hoeren = await request.get(attemptUrl(exam.slug, attemptId), {
    headers: { cookie },
  });
  const lesen = await request.get(attemptLesenUrl(exam.slug, attemptId), {
    headers: { cookie },
  });
  const rscOf = (url: string) => rscPayloadOf(request, url, cookie);
  const status = await request.post(
    `${FULL_ORIGIN}/api/attempts/${attemptId}/status`,
    {
      headers: {
        cookie,
        origin: FULL_ORIGIN,
        'content-type': 'application/json',
      },
      data: '{}',
    },
  );
  expect(status.headers()['cache-control']).toBe('private, no-store');
  return {
    hoerenHtml: await hoeren.text(),
    lesenHtml: await lesen.text(),
    lesenFinalUrl: lesen.url(),
    hoerenRsc: await rscOf(attemptUrl(exam.slug, attemptId)),
    lesenRsc: await rscOf(attemptLesenUrl(exam.slug, attemptId)),
    status: await status.text(),
  };
};

const contextOf = async (
  browser: Browser,
  token: string,
): Promise<BrowserContext> => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

const examAudio = (page: Page) => page.getByTestId('exam-audio-element');

const isPaused = (page: Page): Promise<boolean> =>
  examAudio(page).evaluate((element: HTMLAudioElement) => element.paused);

const markOf = (page: Page, testId: string): Promise<string | null> =>
  page
    .getByTestId(testId)
    .evaluate((element: HTMLElement) => element.dataset.marker ?? null);

const mark = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((element: HTMLElement) => {
    element.dataset.marker = 'kept';
  });

test('lesen becomes visible only after its trusted phase starts', async ({
  request,
}) => {
  const exam = await publishExam();
  const phases: [string, number][] = [
    ['hoeren', 10],
    ['transition', H + 10],
    ['lesen', H + T + 10],
  ];
  for (const [phase, ago] of phases) {
    const created = await newGuest(depsNow());
    const { attemptId } = examAgo(created, exam, ago);
    const sent = await transportsOf(request, created.token, exam, attemptId);
    const page = await readAttemptPage(
      depsNow(),
      created.guest,
      exam.slug,
      attemptId,
    );
    if (page.status !== 'ready') throw new Error(`page is ${page.status}`);
    const skills = new Set(page.practice.questions.map((item) => item.skill));
    const status = JSON.parse(sent.status) as {
      result: {
        summary: { skills: { lesen: { state: string; assigned: number } } };
      };
    };
    const lesenPart = status.result.summary.skills.lesen;
    expect(lesenPart.assigned, phase).toBe(25);

    if (phase === 'lesen') {
      // Once Lesen started it is in the page, its payload and its numbers;
      // the closed Hören is no longer projected.
      expect([...skills]).toEqual(['lesen']);
      expect(page.practice.texts.length).toBeGreaterThan(0);
      expect(page.practice.trackIds).toEqual([]);
      expect(sent.lesenHtml).toContain('question-card-lesen-1');
      expect(sent.lesenHtml).toContain('Anzeige zu Teil 1');
      expect(sent.lesenRsc).toContain('lesen-text-1');
      expect(sent.lesenFinalUrl).toContain('/lesen');
      expect(lesenPart.state).toBe('open');
      continue;
    }
    // Before it: Hören only, in every form, and Lesen only as a number.
    expect([...skills], phase).toEqual(['hoeren']);
    expect(page.practice.texts, phase).toEqual([]);
    expectNoLesen(sent.hoerenHtml, `${phase} html`);
    expectNoLesen(sent.lesenHtml, `${phase} lesen html`);
    expectNoLesen(sent.hoerenRsc, `${phase} rsc`);
    expectNoLesen(sent.lesenRsc, `${phase} lesen rsc`);
    expectNoLesen(sent.status, `${phase} status`);
    expect(lesenPart.state, phase).toBe('unopened');
    if (phase === 'transition') {
      expect(sent.hoerenHtml).toContain('data-testid="transition-screen"');
      expect(sent.hoerenHtml).not.toContain('question-card-hoeren-1');
    } else {
      expect(sent.hoerenHtml).toContain('question-card-hoeren-1');
      // In Hören the Lesen address sends the guest back to Hören.
      expect(sent.lesenFinalUrl).not.toContain('/lesen');
    }
  }
});

test('full phase change refreshes layout material without exposing early lesen', async ({
  browser,
  request,
}) => {
  const exam = await publishExam();

  // A direct /lesen before Lesen starts stays empty of Lesen.
  const early = await newGuest(depsNow());
  const opened = examAgo(early, exam, 10);
  const direct = await request.get(
    attemptLesenUrl(exam.slug, opened.attemptId),
    {
      headers: { cookie: cookieOf(early.token) },
    },
  );
  expectNoLesen(await direct.text(), 'direct lesen');
  expect(direct.url()).not.toContain('/lesen');

  // Hören ends while the page is open: the server moves the phase, the
  // same shell and the same recording element get the material of the new
  // phase, and the confirmed answer still counts.
  const created = await newGuest(depsNow());
  const { attemptId } = examAgo(created, exam, H - 8);
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.goto(attemptUrl(exam.slug, attemptId));
  await page.waitForURL(HOEREN_URL);
  const target = card(page, 'hoeren-1');
  await optionIn(target, fullKeyOf('hoeren-1')).check();
  await expectStatus(target, 'saved');
  await mark(page, 'training-shell');
  await mark(page, 'exam-audio-element');

  await expect(page.getByTestId('transition-screen')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-phase',
    'transition',
  );
  expectNoLesen(await page.content(), 'transition page');
  expect(await markOf(page, 'training-shell')).toBe('kept');

  await page.getByTestId('begin-lesen').click();
  await page.waitForURL(LESEN_URL);
  await expect(page.getByTestId('training-shell')).toHaveAttribute(
    'data-phase',
    'lesen',
  );
  await expect(card(page, 'lesen-1')).toHaveCount(1);
  await expect(card(page, 'hoeren-1')).toHaveCount(0);
  expect(await markOf(page, 'training-shell')).toBe('kept');
  expect(await markOf(page, 'exam-audio-element')).toBe('kept');
  await page.getByTestId('finish-attempt').click();
  const confirmation = page.getByTestId('finish-confirmation');
  await expect(confirmation).toHaveAttribute('data-skipped', '44');
  await expect(confirmation).toHaveAttribute('data-unanswered-hoeren', '19');
  await expect(confirmation).toHaveAttribute('data-unopened', '0');
  await context.close();
});

test('direct routes transports and writes cannot reveal early lesen', async ({
  request,
}) => {
  const exam = await publishExam();
  for (const ago of [10, H + 10]) {
    const created = await newGuest(depsNow());
    const { attemptId } = examAgo(created, exam, ago);
    const headers = {
      cookie: cookieOf(created.token),
      origin: FULL_ORIGIN,
      'content-type': 'application/json',
    };
    // A save of a Lesen task is refused and writes nothing.
    const save = await request.post(
      `${FULL_ORIGIN}/api/attempts/${attemptId}/answer`,
      {
        headers,
        data: JSON.stringify({
          questionId: 'lesen-1',
          optionId: fullKeyOf('lesen-1'),
          revision: 1,
        }),
      },
    );
    expect(save.status()).toBe(404);
    expectNoLesen(await save.text(), 'save');
    expect(
      await saveAnswer(depsNow(), created.token, {
        attemptId,
        questionId: 'lesen-2',
        optionId: 'a',
        revision: 1,
      }),
    ).toEqual({ ok: false, error: 'attempt-not-found' });
    expect(await readAnswerRows(attemptId)).toEqual([]);

    // The RSC payload of /lesen, the begin-lesen answer of Hören and the
    // status carry no Lesen.
    const rsc = await rscPayloadOf(
      request,
      attemptLesenUrl(exam.slug, attemptId),
      cookieOf(created.token),
    );
    expectNoLesen(rsc, 'lesen rsc');
    const status = await readAttemptStatus(depsNow(), created.token, {
      attemptId,
    });
    expectNoLesen(JSON.stringify(status), 'status');
    if (ago === 10) {
      const begin = await request.post(
        `${FULL_ORIGIN}/api/attempts/${attemptId}/begin-lesen`,
        { headers, data: '{}' },
      );
      const answer = await begin.text();
      expect(answer).toContain('phase-not-open');
      expectNoLesen(answer, 'begin-lesen');
    }
  }
  // The closed material never reaches the publishable key.
  const anon = createPublicClient();
  const read = await anon.from('exam_versions').select('content');
  expect(read.data ?? []).toEqual([]);
});

test('closed hoeren cannot obtain fresh audio through preparation', async ({
  request,
}) => {
  const exam = await publishExam();
  const audioOf = (token: string, attemptId: string) =>
    request.post(`${FULL_ORIGIN}/api/attempts/${attemptId}/audio`, {
      headers: {
        cookie: cookieOf(token),
        origin: FULL_ORIGIN,
        'content-type': 'application/json',
      },
      data: JSON.stringify({ trackId: FULL_TRACK_ID }),
    });
  const prepareFor = (token: string) =>
    prepareExamAudio(depsNow(), token, {
      examSlug: exam.slug,
      expectedVersionId: exam.versionId,
    });

  // Open Hören: an address for the rest of Hören plus the margin.
  const listening = await newGuest(depsNow());
  const open = examAgo(listening, exam, 10);
  const issued = await audioOf(listening.token, open.attemptId);
  expect(issued.status()).toBe(200);
  const body = (await issued.json()) as {
    audio: { expiresAt: string; serverNow: string; coverSeconds: number };
  };
  const lifeSeconds =
    (Date.parse(body.audio.expiresAt) - Date.parse(body.audio.serverNow)) /
    SECOND_MS;
  expect(lifeSeconds).toBe(body.audio.coverSeconds + 300);
  expect(Math.abs(body.audio.coverSeconds - (H - 10))).toBeLessThanOrEqual(2);
  // The slot holds an open exam: no preparation beside it.
  expect(await prepareFor(listening.token)).toEqual({
    ok: false,
    error: 'conflict',
  });

  // Transition and Lesen: refused through the HTTP route and through the
  // function the Server Action of the free player calls.
  for (const ago of [H + 5, H + T + 5]) {
    const created = await newGuest(depsNow());
    const { attemptId } = examAgo(created, exam, ago);
    const refused = await audioOf(created.token, attemptId);
    expect(refused.status(), `${ago}`).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: 'phase-closed' });
    expect(
      await resolveAttemptAudio(depsNow(), created.token, {
        attemptId,
        trackId: FULL_TRACK_ID,
      }),
    ).toEqual({ ok: false, error: 'phase-closed' });
    expect(await prepareFor(created.token)).toEqual({
      ok: false,
      error: 'conflict',
    });
  }

  // After the end and the result: the review may play the recording again,
  // and a new preparation is possible for a new exam.
  const done = await newGuest(depsNow());
  const closed = examAgo(done, exam, H + T + L + 5);
  const reviewed = await readAttemptStatus(depsNow(), done.token, {
    attemptId: closed.attemptId,
  });
  expect(reviewed).toMatchObject({
    ok: true,
    result: { outcome: 'result-ready' },
  });
  expect((await audioOf(done.token, closed.attemptId)).status()).toBe(200);
  expect(await prepareFor(done.token)).toMatchObject({
    ok: true,
    audio: { coverSeconds: H },
  });
});

test('closed full audio cannot restart or reveal future material', async ({
  browser,
  request,
}) => {
  const exam = await publishExam(SHORT_HOEREN);
  const created = await newGuest(depsNow());
  const { attemptId } = examAgo(created, exam, SHORT_HOEREN.hoerenSeconds - 8);
  const context = await contextOf(browser, created.token);
  const page = await context.newPage();
  await page.goto(attemptUrl(exam.slug, attemptId));
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await page.getByTestId('audio-unlock').click();
  await expect.poll(() => isPaused(page)).toBe(false);

  // Hören ends on this address: the trusted phase stops the recording.
  await expect(page.getByTestId('transition-screen')).toBeVisible({
    timeout: 20_000,
  });
  expect(page.url()).not.toContain('/lesen');
  await expect.poll(() => isPaused(page)).toBe(true);
  await expect(page.getByTestId('audio-player')).toBeHidden();
  await expect(page.getByTestId('audio-unlock')).toHaveCount(0);

  // A play from the page or a media key is stopped at once.
  await examAudio(page).evaluate((element: HTMLAudioElement) => {
    void element.play().catch(() => undefined);
  });
  await page.waitForTimeout(500);
  expect(await isPaused(page)).toBe(true);
  await expect(page.getByTestId('audio-player')).toHaveAttribute(
    'data-playing',
    'false',
  );
  // No new address, and no Lesen before its phase.
  const refused = await request.post(
    `${FULL_ORIGIN}/api/attempts/${attemptId}/audio`,
    {
      headers: {
        cookie: cookieOf(created.token),
        origin: FULL_ORIGIN,
        'content-type': 'application/json',
      },
      data: JSON.stringify({ trackId: FULL_TRACK_ID }),
    },
  );
  expect(refused.status()).toBe(409);
  expectNoLesen(await page.content(), 'closed hoeren page');
  await context.close();
});
