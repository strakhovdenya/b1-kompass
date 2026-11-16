import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  APIResponse,
  Browser,
  BrowserContext,
  Page,
  Request,
} from '@playwright/test';
import { getAttemptReview } from '../src/server/attempts/attempts';
import { preflightTimedStart } from '../src/server/attempts/start';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import type { CreatedGuest } from '../src/server/guest-session/session';
import {
  hashGuestToken,
  replaceGuestSession,
} from '../src/server/guest-session/session';
import {
  createPublicClient,
  depsNow,
  latestVersionOf,
  newGuest,
  readAnswerRows,
  readAnswers,
  readAttempts,
  readAudioObject,
  readCommandRows,
  readEventKinds,
  readProgress,
  readResults,
  readRunRows,
  readSession,
  readSessionByToken,
  completedOn,
  countVersionKeys,
  readExamState,
  serviceDb,
  shortGuest,
  startBody,
  startFor,
  startedOn,
} from './support/db';
import {
  TEST_GUEST_SESSIONS_PER_MINUTE,
  readTestSupabaseEnv,
} from './support/env';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TRACK_ID,
  PAIR_A_MARKER,
  PAIR_REPLACED,
  fullKeyOf,
  fullWrongOf,
  publishExamPair,
} from './support/full-exam';
import {
  CHOICE_URL,
  FULL_ORIGIN,
  attemptLesenUrl,
  attemptUrl,
  card,
  expectStatus,
  goToHoeren,
  SIGNED_AUDIO,
  expectNone,
  goToLesen,
  guestContextOf,
  optionIn,
  postCommand,
  readPage,
  startBrowserGuest,
  untilGuestExpired,
  tokenOf,
  continueThroughLibrary,
} from './support/guest-browser';
import { createTestRecording } from './support/global-setup';
import {
  examAttemptOwners,
  guestRows,
  installM2Fixtures,
  psql,
  psqlJson,
  quote,
  sqlRunnerAs,
} from './support/sql';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';

// Guest pages carry the answers of one attempt. Whatever sits between the
// server and the browser must not hand them to the next visitor of the same
// address: every response is private and never stored, and the body is
// rendered for the session of the request alone. Each attempt has its own
// address; the M1 addresses only redirect to the guest's own attempt.

const LEGACY_PATHS = ['/practice', '/practice/lesen'] as const;

const ownPaths = (attemptId: string): string[] => [
  attemptUrl(FULL_EXAM.slug, attemptId),
  attemptLesenUrl(FULL_EXAM.slug, attemptId),
];

const KEY_LEAKS = ['correctOptionId', 'correct_option_id', 'answer_keys'];

interface Probe {
  url: string;
  headers: Record<string, string>;
}

// The address and headers a browser really sends: the pages of the attempt
// itself, and the RSC requests of the client navigation between the blocks.
const pageProbes = (attemptId: string): Probe[] =>
  ownPaths(attemptId).map((url) => ({ url, headers: {} }));

// The same request for another attempt: its address and router state name
// that attempt instead.
const probeFor = (probe: Probe, from: string, to: string): Probe => ({
  url: probe.url.replaceAll(from, to),
  headers: Object.fromEntries(
    Object.entries(probe.headers).map(([name, value]) => [
      name,
      value.replaceAll(from, to),
    ]),
  ),
});

const REPLAYED_HEADERS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-url',
];

const recordRscRequests = (page: Page): Probe[] => {
  const probes: Probe[] = [];
  page.on('request', (request: Request) => {
    const all = request.headers();
    if (all.rsc !== '1') return;
    const headers = Object.fromEntries(
      REPLAYED_HEADERS.flatMap((name) => {
        const value = all[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const { pathname, search } = new URL(request.url());
    probes.push({ url: `${pathname}${search}`, headers });
  });
  return probes;
};

// The answers of a guest as the props of the screens (plain or escaped
// inside HTML).
const answerMarkersOf = (answers: Readonly<Record<string, string>>): string[] =>
  Object.entries(answers).flatMap(([questionId, optionId]) => [
    `"${questionId}":"${optionId}"`,
    `\\"${questionId}\\":\\"${optionId}\\"`,
  ]);

// How the attempt of a guest shows in a page or an RSC payload: its id, and
// its answers. A refused address may still name the requested id in its
// route tree, so a foreign request is checked against the answers only.
const markersOf = (
  attemptId: string,
  answers: Readonly<Record<string, string>>,
): string[] => [attemptId, ...answerMarkersOf(answers)];

const expectNeverStored = (response: APIResponse, where: string) => {
  const headers = response.headers();
  const cacheControl = headers['cache-control'] ?? '';
  expect(cacheControl, where).toContain('private');
  expect(cacheControl, where).toContain('no-store');
  expect(cacheControl, where).not.toMatch(/public|s-maxage/);
  expect(headers['x-nextjs-cache'], where).toBeUndefined();
  expect(headers.age, where).toBeUndefined();
};

const fetchProbe = async (context: BrowserContext, probe: Probe) => {
  const where = `${probe.url} ${JSON.stringify(probe.headers)}`;
  const response = await context.request.get(probe.url, {
    headers: probe.headers,
    maxRedirects: 0,
  });
  expectNeverStored(response, where);
  return {
    where,
    status: response.status(),
    location: response.headers().location ?? null,
    body: await response.text(),
  };
};

// A probe moved to another attempt id keeps the recorded `_rsc` hash of the
// old router state; Next answers it with a redirect to the same path under
// the matching hash, which is followed once with the same headers.
const fetchOwnProbe = async (context: BrowserContext, probe: Probe) => {
  const first = await fetchProbe(context, probe);
  if (first.status !== 307 || !first.location) return first;
  const target = new URL(first.location, 'http://localhost');
  const source = new URL(probe.url, 'http://localhost');
  expect(target.pathname, first.where).toBe(source.pathname);
  return fetchProbe(context, {
    url: `${target.pathname}${target.search}`,
    headers: probe.headers,
  });
};

const includesAny = (body: string, markers: readonly string[]): boolean =>
  markers.some((marker) => body.includes(marker));

test('guest cache never returns another attempt answers', async ({
  browser,
}) => {
  const first = await startBrowserGuest(browser);
  const rscProbes = recordRscRequests(first.page);
  const answers = {
    'hoeren-1': fullWrongOf('hoeren-1'),
    'lesen-1': fullWrongOf('lesen-1'),
  };
  await optionIn(card(first.page, 'hoeren-1'), answers['hoeren-1']).check();
  await expectStatus(card(first.page, 'hoeren-1'), 'saved');
  await goToLesen(first.page);
  await optionIn(card(first.page, 'lesen-1'), answers['lesen-1']).check();
  await expectStatus(card(first.page, 'lesen-1'), 'saved');
  await goToHoeren(first.page);
  await goToLesen(first.page);
  expect(await readAnswers(first.attemptId)).toEqual(answers);
  // A prefetch only carries the route tree; the navigations carry the
  // screens with their answers.
  const isPrefetch = (probe: Probe) =>
    probe.headers['next-router-prefetch'] !== undefined;
  expect(
    rscProbes.filter((probe) => !isPrefetch(probe)).length,
  ).toBeGreaterThan(0);
  const probes = [...pageProbes(first.attemptId), ...rscProbes];
  const firstMarkers = markersOf(first.attemptId, answers);
  const firstAnswers = answerMarkersOf(answers);
  const carries = (body: string) => includesAny(body, firstMarkers);

  // The own responses do carry the attempt: the markers are meaningful.
  for (const probe of probes) {
    const { where, body } = await fetchProbe(first.context, probe);
    if (!isPrefetch(probe)) expect(carries(body), where).toBe(true);
  }

  // The first guest asks right before every request of the second, so a
  // shared cache would have the first answers ready for that address.
  const second = await startBrowserGuest(browser);
  expect(second.attemptId).not.toBe(first.attemptId);
  for (const probe of probes) {
    // The address of the first attempt gives the second guest nothing.
    await fetchProbe(first.context, probe);
    const foreign = await fetchProbe(second.context, probe);
    expect(includesAny(foreign.body, firstAnswers), foreign.where).toBe(false);
    if (Object.keys(probe.headers).length === 0) {
      expect(foreign.status, foreign.where).toBe(404);
    }

    // The same request for the second guest's own attempt is a full screen
    // of the exam with its own attempt and without the first answers.
    const own = probeFor(probe, first.attemptId, second.attemptId);
    await fetchProbe(first.context, probe);
    const { where, status, body } = await fetchOwnProbe(second.context, own);
    expect(carries(body), where).toBe(false);
    if (!isPrefetch(own)) {
      expect(status, where).toBe(200);
      expect(body, where).toContain(FULL_EXAM.title);
    }
    if (Object.keys(own.headers).length === 0) {
      expect(body, where).toContain(second.attemptId);
    }
  }
  await expect(second.page.locator('input[type="radio"]:checked')).toHaveCount(
    0,
  );
  await goToLesen(second.page);
  await expect(second.page.locator('input[type="radio"]:checked')).toHaveCount(
    0,
  );
  expect(await readAnswers(second.attemptId)).toEqual({});

  // The legacy addresses are private redirects to the own attempt only.
  for (const [guest, other] of [
    [first, second],
    [second, first],
  ] as const) {
    for (const path of LEGACY_PATHS) {
      await fetchProbe(other.context, { url: path, headers: {} });
      const { where, status, location, body } = await fetchProbe(
        guest.context,
        { url: path, headers: {} },
      );
      expect(status, where).toBe(307);
      const target = new URL(location ?? '', 'http://localhost').pathname;
      expect(target, where).toBe(
        path === '/practice'
          ? attemptUrl(FULL_EXAM.slug, guest.attemptId)
          : attemptLesenUrl(FULL_EXAM.slug, guest.attemptId),
      );
      expect(body, where).not.toContain(other.attemptId);
    }
  }

  // A visitor without a cookie gets no page of an attempt at all.
  const stranger = await browser.newContext();
  const secondProbes = probes.map((probe) =>
    probeFor(probe, first.attemptId, second.attemptId),
  );
  for (const probe of [...probes, ...secondProbes]) {
    await fetchProbe(first.context, probe);
    const { where, status, body } = await fetchProbe(stranger, probe);
    expect(includesAny(body, firstAnswers), where).toBe(false);
    if (Object.keys(probe.headers).length === 0) {
      expect(status, where).not.toBe(200);
    }
  }
  for (const path of LEGACY_PATHS) {
    const { where, location, body } = await fetchProbe(stranger, {
      url: path,
      headers: {},
    });
    expect(new URL(location ?? '', 'http://localhost').pathname, where).toBe(
      '/',
    );
    expect(carries(body), where).toBe(false);
    expect(body, where).not.toContain(second.attemptId);
  }
  await stranger.close();

  expect(await readAnswers(first.attemptId)).toEqual(answers);
  await first.context.close();
  await second.context.close();
});

// A guest who entered but has not started anything yet.
const enterWithoutStart = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await continueThroughLibrary(page);
  await page.waitForURL(CHOICE_URL);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  const token = await tokenOf(context);
  const session = await readSessionByToken(token);
  if (!session) throw new Error('guest session is missing');
  expect(await readAttempts(session.id)).toEqual([]);
  return { context, page, token, sessionId: session.id };
};

const postStart = (
  context: BrowserContext,
  origin: string,
  data: unknown,
  options: { query?: string; headers?: Record<string, string> } = {},
) =>
  context.request.post(`/api/attempts/start${options.query ?? ''}`, {
    headers: { Origin: origin, ...options.headers },
    data,
    maxRedirects: 0,
  });

test('explicit attempt pages and commands stay private and cookie authorized', async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL is required');
  const owner = await startBrowserGuest(browser);
  const answers = {
    'hoeren-1': fullWrongOf('hoeren-1'),
    'lesen-1': fullWrongOf('lesen-1'),
  };
  await optionIn(card(owner.page, 'hoeren-1'), answers['hoeren-1']).check();
  await expectStatus(card(owner.page, 'hoeren-1'), 'saved');
  await goToLesen(owner.page);
  await optionIn(card(owner.page, 'lesen-1'), answers['lesen-1']).check();
  await expectStatus(card(owner.page, 'lesen-1'), 'saved');
  expect(await readAnswers(owner.attemptId)).toEqual(answers);
  const ownerAnswers = answerMarkersOf(answers);

  // The real pages of the attempt: private, with the owner's answers and
  // without the key. The cookie alone authorizes a fresh context.
  const cookieOnly = await browser.newContext();
  await cookieOnly.addCookies(await owner.context.cookies());
  for (const context of [owner.context, cookieOnly]) {
    for (const path of ownPaths(owner.attemptId)) {
      const { where, status, body } = await fetchProbe(context, {
        url: path,
        headers: {},
      });
      expect(status, where).toBe(200);
      expect(
        includesAny(body, markersOf(owner.attemptId, answers)),
        where,
      ).toBe(true);
      for (const leak of KEY_LEAKS) expect(body, where).not.toContain(leak);
    }
  }
  await cookieOnly.close();

  // The start JSON of the owner names the active attempt and creates
  // nothing; it is private as well.
  const conflict = await postStart(
    owner.context,
    baseURL,
    await startBody(FULL_EXAM.slug),
  );
  expectNeverStored(conflict, 'owner start');
  expect(conflict.status()).toBe(200);
  const conflictText = await conflict.text();
  expect(JSON.parse(conflictText)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: owner.attemptId },
  });
  for (const leak of KEY_LEAKS) expect(conflictText).not.toContain(leak);
  expect(await readAttempts(owner.sessionId)).toEqual([
    { id: owner.attemptId, status: 'active' },
  ]);

  // Another guest starts its own attempt by the same command; its JSON is
  // private and names only its own new attempt.
  const other = await enterWithoutStart(browser);
  const accepted = await postStart(
    other.context,
    baseURL,
    await startBody(FULL_EXAM.slug),
  );
  expectNeverStored(accepted, 'other start');
  expect(accepted.status()).toBe(200);
  const acceptedText = await accepted.text();
  const acceptedJson = JSON.parse(acceptedText) as {
    ok: boolean;
    result: { outcome: string; attemptId: string };
  };
  expect(acceptedJson).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });
  expect(acceptedJson.result.attemptId).not.toBe(owner.attemptId);
  expect(acceptedText).not.toContain(owner.attemptId);
  for (const leak of KEY_LEAKS) expect(acceptedText).not.toContain(leak);
  expect(await readAttempts(other.sessionId)).toEqual([
    { id: acceptedJson.result.attemptId, status: 'active' },
  ]);

  // The owner's addresses refuse the other guest without any of its data.
  for (const path of ownPaths(owner.attemptId)) {
    const { where, status, body } = await fetchProbe(other.context, {
      url: path,
      headers: {},
    });
    expect(status, where).toBe(404);
    expect(includesAny(body, ownerAnswers), where).toBe(false);
    for (const leak of KEY_LEAKS) expect(body, where).not.toContain(leak);
  }
  expect(await readAnswers(owner.attemptId)).toEqual(answers);
  expect(await readAttempts(owner.sessionId)).toEqual([
    { id: owner.attemptId, status: 'active' },
  ]);
  await other.context.close();
  await owner.context.close();
});

interface GuestRows {
  attempts: unknown;
  answers: Record<string, string>;
  commands: unknown;
  events: string[];
}

const rowsOf = async (
  sessionId: string,
  attemptId: string,
): Promise<GuestRows> => ({
  attempts: await readAttempts(sessionId),
  answers: await readAnswers(attemptId),
  commands: await readCommandRows(sessionId),
  events: await readEventKinds(attemptId),
});

test('body query and header tokens cannot replace owned guest cookie', async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL is required');
  const owner = await startBrowserGuest(browser);
  const answer = fullWrongOf('hoeren-1');
  await optionIn(card(owner.page, 'hoeren-1'), answer).check();
  await expectStatus(card(owner.page, 'hoeren-1'), 'saved');
  const ownerToken = owner.token;
  const ownerAnswers = answerMarkersOf({ 'hoeren-1': answer });
  const ownerBefore = await rowsOf(owner.sessionId, owner.attemptId);
  expect(ownerBefore.events).toEqual(['start']);

  const foreign = await startBrowserGuest(browser);
  const foreignBefore = await rowsOf(foreign.sessionId, foreign.attemptId);
  const noCookie = await browser.newContext();

  const carriers: {
    name: string;
    query: string;
    headers: Record<string, string>;
  }[] = [
    {
      name: 'query',
      query: `?token=${ownerToken}&b1k_guest=${ownerToken}`,
      headers: {},
    },
    {
      name: 'custom header',
      query: '',
      headers: { 'x-guest-token': ownerToken },
    },
    {
      name: 'authorization header',
      query: '',
      headers: { authorization: `Bearer ${ownerToken}` },
    },
  ];
  const visitors = [
    { name: 'no cookie', context: noCookie, ownAttemptId: null },
    {
      name: 'foreign cookie',
      context: foreign.context,
      ownAttemptId: foreign.attemptId,
    },
  ];

  for (const visitor of visitors) {
    // The owner's pages: the token outside the cookie opens nothing.
    for (const path of ownPaths(owner.attemptId)) {
      for (const carrier of carriers) {
        const where = `${visitor.name} ${carrier.name} ${path}`;
        const response = await visitor.context.request.get(
          `${path}${carrier.query}`,
          { headers: carrier.headers, maxRedirects: 0 },
        );
        expectNeverStored(response, where);
        expect(response.status(), where).not.toBe(200);
        const body = await response.text();
        expect(includesAny(body, ownerAnswers), where).toBe(false);
        for (const leak of KEY_LEAKS) expect(body, where).not.toContain(leak);
      }
    }

    // The start: a token field in the body is an unknown field.
    const withField = await postStart(visitor.context, baseURL, {
      ...(await startBody(FULL_EXAM.slug)),
      guestToken: ownerToken,
    });
    expect(withField.status(), `${visitor.name} body`).toBe(400);
    expect(await withField.json()).toEqual({
      ok: false,
      failure: 'invalid-input',
    });

    // In the query or a header the token is ignored: the request is the
    // visitor's own, or no guest at all.
    for (const carrier of carriers) {
      const where = `${visitor.name} ${carrier.name} start`;
      const response = await postStart(
        visitor.context,
        baseURL,
        await startBody(FULL_EXAM.slug),
        { query: carrier.query, headers: carrier.headers },
      );
      expectNeverStored(response, where);
      const json = (await response.json()) as unknown;
      if (visitor.ownAttemptId === null) {
        expect(response.status(), where).toBe(401);
        expect(json, where).toEqual({ ok: false, failure: 'session-invalid' });
      } else {
        expect(json, where).toMatchObject({
          ok: true,
          result: { outcome: 'conflict', attemptId: visitor.ownAttemptId },
        });
      }
      expect(JSON.stringify(json), where).not.toContain(owner.attemptId);
    }
  }

  expect(await rowsOf(owner.sessionId, owner.attemptId)).toEqual(ownerBefore);
  expect(await rowsOf(foreign.sessionId, foreign.attemptId)).toEqual(
    foreignBefore,
  );
  await noCookie.close();
  await foreign.context.close();
  await owner.context.close();
});

// M2 actions over real HTTP (#48) ---------------------------------------------
//
// Ownership is judged with the trusted Origin and the cookie of the actor, so
// that a refusal of the Origin can never hide a missing authorization; the
// Origin has its own matrix below. Every step re-reads the rows of both
// guests from the test database.

const PROGRESS = {
  block: 'lesen',
  positionSeconds: 12,
  hoeren: { itemId: 'hoeren-2' },
  lesen: { itemId: 'lesen-3', textId: 'lesen-text-1', paragraph: 0 },
} as const;

const KEY_FIELDS = ['correctOptionId', 'correct_option_id', 'answer_keys'];

const sessionIdOf = (created: CreatedGuest): string => created.guest.sessionId;

interface AttemptRows {
  id: string;
  status: string;
  answers: unknown;
  progress: unknown;
  results: unknown;
  events: string[];
  runs: unknown;
}

interface GuestDump {
  session: unknown;
  commands: unknown;
  attempts: AttemptRows[];
}

// Everything the database holds for one guest, in a stable order.
const rowsOfSession = async (sessionId: string): Promise<GuestDump> => {
  const attempts = (await readAttempts(sessionId)).toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
  return {
    session: await readSession(sessionId),
    commands: (await readCommandRows(sessionId)).toSorted((a, b) =>
      a.command_id.localeCompare(b.command_id),
    ),
    attempts: await Promise.all(
      attempts.map(async ({ id, status }) => ({
        id,
        status,
        answers: await readAnswerRows(id),
        progress: await readProgress(id),
        results: await readResults(id),
        events: await readEventKinds(id),
        runs: await readRunRows(id),
      })),
    ),
  };
};

const rowsOfGuest = (created: CreatedGuest): Promise<GuestDump> =>
  rowsOfSession(sessionIdOf(created));

const expectNoKey = (reply: { body: unknown }, where: string) => {
  const text = JSON.stringify(reply.body);
  for (const field of KEY_FIELDS) expect(text, where).not.toContain(field);
};

const startAccepted = async (created: CreatedGuest): Promise<string> => {
  const started = await startFor(depsNow(), created.token, FULL_EXAM.slug);
  if (!started.ok || started.result.outcome !== 'accepted') {
    throw new Error(`start failed: ${JSON.stringify(started)}`);
  }
  return started.result.attemptId;
};

interface StatusBody {
  result: {
    outcome: string;
    state: { phaseRevision: number };
    skipped: number;
  };
}

test('m2 owner controls and public role boundaries cover new actions', async ({
  request,
}) => {
  const owner = await newGuest(depsNow());
  const bystander = await newGuest(depsNow());
  const bystanderAttempt = await startAccepted(bystander);
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');
  const answered = await postCommand(
    request,
    `/api/attempts/${bystanderAttempt}/answer`,
    {
      questionId: 'hoeren-1',
      optionId: fullKeyOf('hoeren-1'),
      revision: 1,
    },
    { token: bystander.token },
  );
  expect(answered.status).toBe(200);
  const bystanderBefore = await rowsOfGuest(bystander);

  // Each action of the owner is judged against the owner's own rows and the
  // untouched rows of the bystander.
  const send = (pathname: string, body: unknown) =>
    postCommand(request, pathname, body, { token: owner.token });
  const ownerRows = async (attemptId: string) => {
    const rows = await rowsOfGuest(owner);
    const attempt = rows.attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error('owner attempt is missing');
    return { rows, attempt };
  };
  const bystanderUntouched = async (where: string) => {
    expect(await rowsOfGuest(bystander), where).toEqual(bystanderBefore);
  };
  const statusOf = async (attemptId: string) => {
    const reply = await send(`/api/attempts/${attemptId}/status`, {});
    expect(reply.status).toBe(200);
    return (reply.body as unknown as StatusBody).result;
  };
  const confirmationOf = async (attemptId: string) => {
    const status = await statusOf(attemptId);
    return {
      phaseRevision: status.state.phaseRevision,
      skipped: status.skipped,
    };
  };
  const startOf = async (overrides: Record<string, unknown>) => {
    const reply = await send('/api/attempts/start', {
      ...(await startBody(FULL_EXAM.slug)),
      ...overrides,
    });
    expect(reply.status).toBe(200);
    const result = reply.body.result as { outcome: string; attemptId: string };
    expect(result.outcome).toBe('accepted');
    return result.attemptId;
  };

  // 1. start the free training, answer, save the place, finish once.
  const trainingId = await startOf({});
  let state = await ownerRows(trainingId);
  expect(state.attempt).toMatchObject({ status: 'active', answers: [] });
  expect(state.rows.commands).toHaveLength(1);
  await bystanderUntouched('start');

  const wrong = await send(`/api/attempts/${trainingId}/answer`, {
    questionId: 'hoeren-1',
    optionId: fullWrongOf('hoeren-1'),
    revision: 1,
  });
  expect(wrong).toMatchObject({ status: 200, body: { ok: true } });
  state = await ownerRows(trainingId);
  expect(state.attempt.answers).toEqual([
    {
      question_id: 'hoeren-1',
      option_id: fullWrongOf('hoeren-1'),
      revision: 1,
    },
  ]);
  await bystanderUntouched('answer');

  const progressed = await send(`/api/attempts/${trainingId}/progress`, {
    progress: PROGRESS,
  });
  expect(progressed).toMatchObject({ status: 200, body: { ok: true } });
  expect((await ownerRows(trainingId)).attempt.progress).toEqual(PROGRESS);
  await bystanderUntouched('progress');

  const submit = await send(`/api/attempts/${trainingId}/submit`, {
    commandId: randomUUID(),
    answers: [],
    confirmation: await confirmationOf(trainingId),
  });
  expect(submit.status).toBe(200);
  state = await ownerRows(trainingId);
  expect(state.attempt.status).toBe('completed');
  expect(state.attempt.results).toHaveLength(1);
  await bystanderUntouched('submit');

  // 2. repeat the own errors of the completed attempt, then cancel the run.
  const repeatId = await startOf({
    purpose: 'error-repeat',
    sourceAttemptId: trainingId,
  });
  state = await ownerRows(repeatId);
  const [repeatRun] = state.attempt.runs as {
    purpose: string;
    source_attempt_id: string;
  }[];
  expect(repeatRun).toMatchObject({
    purpose: 'error-repeat',
    source_attempt_id: trainingId,
  });
  await bystanderUntouched('repeat');
  const cancelled = await send(`/api/attempts/${repeatId}/cancel`, {
    commandId: randomUUID(),
    confirmation: await confirmationOf(repeatId),
  });
  expect(cancelled.status).toBe(200);
  state = await ownerRows(repeatId);
  expect(state.attempt).toMatchObject({ status: 'cancelled', results: [] });
  await bystanderUntouched('cancel');

  // 3. prepare the recording, start the full exam, read its recording, answer
  // and leave it.
  const before = await rowsOfGuest(owner);
  const prepared = await send('/api/attempts/prepare-audio', {
    examSlug: FULL_EXAM.slug,
    expectedVersionId: latest.versionId,
  });
  expect(prepared).toMatchObject({ status: 200, body: { ok: true } });
  expect(await rowsOfGuest(owner)).toEqual(before);
  await bystanderUntouched('prepare-audio');

  const examId = await startOf({ mode: 'exam' });
  const audio = await send(`/api/attempts/${examId}/audio`, {
    trackId: FULL_TRACK_ID,
  });
  expect(audio).toMatchObject({ status: 200, body: { ok: true } });
  expectNoKey(audio, 'audio');
  const examAnswer = await send(`/api/attempts/${examId}/answer`, {
    questionId: 'hoeren-2',
    optionId: fullKeyOf('hoeren-2'),
    revision: 1,
  });
  expect(examAnswer).toMatchObject({ status: 200, body: { ok: true } });
  state = await ownerRows(examId);
  expect(state.attempt.answers).toHaveLength(1);
  expect((state.attempt.runs as { mode: string }[])[0]?.mode).toBe('exam');
  await bystanderUntouched('exam');

  const lesen = await send(`/api/attempts/${examId}/begin-lesen`, {});
  expect(lesen).toMatchObject({ status: 200, body: { ok: true } });
  await bystanderUntouched('begin-lesen');

  // Every response of an action is private.
  for (const reply of [wrong, progressed, submit, cancelled, prepared, audio]) {
    expect(reply.cacheControl).toContain('no-store');
  }

  // The public role (the publishable key) holds no right on any of it.
  const publicClient = createPublicClient();
  const tables = [
    'attempts',
    'attempt_answers',
    'attempt_runs',
    'attempt_commands',
    'attempt_results',
    'answer_keys',
    'guest_events',
    'guest_sessions',
    'exam_versions',
    'exam_version_audio',
  ];
  for (const table of tables) {
    const { data, error } = await publicClient.from(table).select('*');
    expect(error !== null || (data ?? []).length === 0, table).toBe(true);
    const insert = await publicClient.from(table).insert({});
    expect(insert.error, `${table} insert`).not.toBeNull();
  }
  const functions = psqlJson<
    { name: string; args: { name: string; type: string }[] }[]
  >(`select json_agg(json_build_object('name', p.proname, 'args',
      (select coalesce(json_agg(json_build_object('name', a.n, 'type', t.typname)
        order by a.i), '[]'::json)
      from unnest(p.proargnames, p.proargtypes::oid[])
        with ordinality as a (n, o, i) join pg_type t on t.oid = a.o)))
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and left(p.proname, 3) = 'm2_'`);
  expect(functions.map((fn) => fn.name)).toEqual(
    expect.arrayContaining(['m2_start_attempt', 'm2_save_answer']),
  );
  const dummy: Record<string, unknown> = {
    uuid: randomUUID(),
    text: 'x',
    int4: 1,
    jsonb: {},
    numeric: 1,
  };
  for (const fn of functions) {
    const args = Object.fromEntries(
      fn.args.map((arg) => [arg.name, dummy[arg.type] ?? null]),
    );
    const { error } = await publicClient.rpc(fn.name, args);
    expect(error?.code, fn.name).toBe('42501');
  }
  const bucket = publicClient.storage.from('exam-sources');
  const listed = await bucket.list('audio');
  expect(listed.error !== null || listed.data.length === 0).toBe(true);
  const downloaded = await bucket.download('audio/anything.wav');
  expect(downloaded.error).not.toBeNull();
  await bystanderUntouched('public role');
});

interface Route {
  name: string;
  pathname: string;
  body: unknown;
  // Routes of an attempt of someone else; start and prepare-audio act on
  // the slot of the guest of the cookie itself.
  isAttemptRoute: boolean;
}

const ATTEMPT_COMMANDS: [string, unknown][] = [
  ['answer', { questionId: 'hoeren-1', optionId: 'a', revision: 5 }],
  ['progress', { progress: PROGRESS }],
  ['status', {}],
  [
    'submit',
    {
      commandId: randomUUID(),
      answers: [{ questionId: 'hoeren-1', optionId: 'a', revision: 5 }],
      confirmation: { phaseRevision: 0, skipped: 44 },
    },
  ],
  [
    'cancel',
    {
      commandId: randomUUID(),
      confirmation: { phaseRevision: 0, skipped: 45 },
    },
  ],
  ['begin-lesen', {}],
  ['audio', { trackId: FULL_TRACK_ID }],
];

const routesOf = (attemptId: string, versionId: string): Route[] => [
  {
    name: 'start',
    pathname: '/api/attempts/start',
    body: {
      commandId: randomUUID(),
      examSlug: FULL_EXAM.slug,
      mode: 'training',
      purpose: 'normal',
      selection: 'all',
      sourceAttemptId: null,
      expectedVersionId: versionId,
    },
    isAttemptRoute: false,
  },
  {
    name: 'prepare-audio',
    pathname: '/api/attempts/prepare-audio',
    body: { examSlug: FULL_EXAM.slug, expectedVersionId: versionId },
    isAttemptRoute: false,
  },
  ...ATTEMPT_COMMANDS.map(([name, body]) => ({
    name,
    pathname: `/api/attempts/${attemptId}/${name}`,
    body,
    isAttemptRoute: true,
  })),
];

const waitUntilExpired = (sessionId: string) =>
  expect
    .poll(
      () =>
        psql(`select clock_timestamp() >= expires_at
          from public.guest_sessions where id = ${quote(sessionId)}`),
      { timeout: 20_000 },
    )
    .toBe('t');

test('m2 forged expired foreign and public requests are refused', async ({
  request,
}) => {
  installM2Fixtures();
  const owner = await newGuest(depsNow());
  const stranger = await newGuest(depsNow());
  const ownerAttempt = await startAccepted(owner);
  await startAccepted(stranger);
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');
  const saved = await postCommand(
    request,
    `/api/attempts/${ownerAttempt}/answer`,
    { questionId: 'hoeren-1', optionId: fullKeyOf('hoeren-1'), revision: 1 },
    { token: owner.token },
  );
  expect(saved.status).toBe(200);

  // A guest whose term ends in a few seconds, with its own attempt.
  const shortToken = randomBytes(32).toString('base64url');
  const shortSession = psql(
    `select m2_test.insert_guest_ending_in(${quote(hashGuestToken(shortToken))}, 12)`,
  );
  const shortStart = await startFor(depsNow(), shortToken, FULL_EXAM.slug);
  if (!shortStart.ok || shortStart.result.outcome !== 'accepted') {
    throw new Error('the short guest was not started');
  }
  const shortAttempt = shortStart.result.attemptId;

  const snapshot = async () => ({
    owner: await rowsOfGuest(owner),
    stranger: await rowsOfGuest(stranger),
    short: await rowsOfSession(shortSession),
  });
  const before = await snapshot();
  const expectUntouched = async (where: string) =>
    expect(await snapshot(), where).toEqual(before);

  const routes = routesOf(ownerAttempt, latest.versionId);

  // Ownership, with the trusted Origin: no cookie, a forged cookie and a
  // guest of another session are refused on every route, the key unread.
  const forged = randomBytes(32).toString('base64url');
  for (const route of routes) {
    for (const token of [null, forged]) {
      const where = `${route.name} cookie ${token ? 'forged' : 'none'}`;
      const reply = await postCommand(request, route.pathname, route.body, {
        token,
      });
      expect(reply.status, where).toBe(401);
      expect(JSON.stringify(reply.body), where).toContain('session-invalid');
      expectNoKey(reply, where);
      expect(reply.cacheControl, where).toContain('no-store');
    }
    if (route.isAttemptRoute) {
      const where = `${route.name} foreign attempt`;
      const reply = await postCommand(request, route.pathname, route.body, {
        token: stranger.token,
      });
      expect(reply.status, where).toBe(404);
      expectNoKey(reply, where);
    }
  }
  await expectUntouched('no cookie, forged cookie, foreign attempt');

  // A foreign or unknown source of a repeat, a foreign or unknown version and
  // forged fields are refused without a trace.
  const repeatBody = (overrides: Record<string, unknown>) => ({
    commandId: randomUUID(),
    examSlug: FULL_EXAM.slug,
    mode: 'training',
    purpose: 'error-repeat',
    selection: 'all',
    sourceAttemptId: ownerAttempt,
    expectedVersionId: latest.versionId,
    ...overrides,
  });
  const foreignSource = await postCommand(
    request,
    '/api/attempts/start',
    repeatBody({}),
    { token: stranger.token },
  );
  const unknownSource = await postCommand(
    request,
    '/api/attempts/start',
    repeatBody({ sourceAttemptId: randomUUID() }),
    { token: stranger.token },
  );
  expect(foreignSource.status).toBeGreaterThanOrEqual(400);
  expect(foreignSource.body).toEqual(unknownSource.body);
  expect(JSON.stringify(foreignSource.body)).not.toContain(ownerAttempt);
  const wrongVersion = await postCommand(
    request,
    '/api/attempts/start',
    repeatBody({
      purpose: 'normal',
      sourceAttemptId: null,
      expectedVersionId: randomUUID(),
    }),
    { token: stranger.token },
  );
  expect(wrongVersion.status).toBeGreaterThanOrEqual(400);
  const forgedFields: Record<string, unknown>[] = [
    { role: 'owner' },
    { guestSessionId: sessionIdOf(owner) },
    { score: 45 },
    { status: 'completed' },
    { profileId: randomUUID(), profileStatus: 'confirmed' },
    { now: '2020-01-01T00:00:00.000Z' },
  ];
  for (const extra of forgedFields) {
    const reply = await postCommand(
      request,
      '/api/attempts/start',
      repeatBody({ purpose: 'normal', sourceAttemptId: null, ...extra }),
      { token: stranger.token },
    );
    expect(reply.status, JSON.stringify(extra)).toBe(400);
    const answer = await postCommand(
      request,
      `/api/attempts/${ownerAttempt}/answer`,
      {
        questionId: 'hoeren-1',
        optionId: fullWrongOf('hoeren-1'),
        revision: 9,
        ...extra,
      },
      { token: owner.token },
    );
    expect(answer.status, JSON.stringify(extra)).toBe(400);
  }
  await expectUntouched('foreign source, version and forged fields');

  // A start of an exam without a confirmed profile is refused as not enabled.
  const unconfirmed = `test-unconfirmed-${randomUUID().slice(0, 8)}`;
  await publishExamVersion(serviceDb, {
    slug: unconfirmed,
    title: 'Unconfirmed profile',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording() }],
  });
  const unconfirmedVersion = await latestVersionOf(unconfirmed);
  if (!unconfirmedVersion) throw new Error('exam is missing');
  const notEnabled = await postCommand(
    request,
    '/api/attempts/start',
    {
      ...repeatBody({}),
      examSlug: unconfirmed,
      mode: 'exam',
      purpose: 'normal',
      sourceAttemptId: null,
      expectedVersionId: unconfirmedVersion.versionId,
    },
    { token: stranger.token },
  );
  expect(notEnabled.status).toBe(422);
  expect(notEnabled.body).toMatchObject({ failure: 'not-enabled' });
  await expectUntouched('unconfirmed profile');

  // The Origin has its own matrix: a valid owner cookie is refused when the
  // Origin is missing, foreign, a sibling server or the null origin.
  const origins: [string, string | null][] = [
    ['missing', null],
    ['foreign', 'https://evil.example'],
    ['sibling port', 'http://localhost:3101'],
    ['null', 'null'],
  ];
  for (const route of routes) {
    for (const [name, origin] of origins) {
      const where = `${route.name} origin ${name}`;
      const reply = await postCommand(request, route.pathname, route.body, {
        token: owner.token,
        origin,
      });
      expect(reply.status, where).toBe(403);
      expect(reply.body, where).toEqual({
        ok: false,
        failure: 'origin-refused',
      });
    }
  }
  await expectUntouched('invalid origins');

  // An expired guest is refused on every route of its own attempt; the
  // answer it would have saved is not stored. The rows stay as they were.
  await waitUntilExpired(shortSession);
  const expiredRows = await rowsOfSession(shortSession);
  for (const route of routesOf(shortAttempt, latest.versionId)) {
    const where = `${route.name} expired`;
    const reply = await postCommand(request, route.pathname, route.body, {
      token: shortToken,
    });
    expect(reply.status, where).toBe(401);
    expect(JSON.stringify(reply.body), where).toContain('session-invalid');
  }
  expect(await rowsOfSession(shortSession)).toEqual(expiredRows);
  expect(await rowsOfGuest(owner)).toEqual(before.owner);
  expect(await rowsOfGuest(stranger)).toEqual(before.stranger);
});

// Owner material (#81) ------------------------------------------------------

const PUBLISH_SIGNATURE =
  'public.publish_exam_version(text,text,text,jsonb,jsonb,jsonb,text,boolean)';
const OLD_PUBLISH_SIGNATURE =
  'public.publish_exam_version(text,text,text,jsonb,jsonb,jsonb)';

const objectExists = async (objectPath: string): Promise<boolean> => {
  const folder = objectPath.slice(0, objectPath.lastIndexOf('/'));
  const name = objectPath.slice(objectPath.lastIndexOf('/') + 1);
  const { data, error } = await serviceDb.storage
    .from('exam-sources')
    .list(folder, { search: name });
  if (error) throw error;
  return data.some((object) => object.name === name);
};

const tracksOf = async (versionId: string): Promise<unknown[]> => {
  const { data, error } = await serviceDb
    .from('exam_version_audio')
    .select('track_id, kind, object_path, content_type, sha256')
    .eq('exam_version_id', versionId)
    .order('track_id');
  if (error) throw error;
  return data;
};

test('public roles cannot publish or mutate owner material', async () => {
  const slug = `test-owner-${randomUUID().slice(0, 8)}`;
  const forged = `test-forged-${randomUUID().slice(0, 8)}`;
  const forgedObject = `audio/forged-${randomUUID()}.wav`;
  const recording = createTestRecording();
  const published = await publishExamVersion(serviceDb, {
    slug,
    title: 'Owner material',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...recording }],
  });
  const [track] = (await tracksOf(published.versionId)) as {
    object_path: string;
  }[];
  if (!track) throw new Error('track is missing');
  const objectPath = track.object_path;

  // The SQL re-read of everything a public role could try to change.
  const snapshot = async () => ({
    exam: await readExamState(slug),
    keys: await countVersionKeys(published.versionId),
    tracks: await tracksOf(published.versionId),
    forged: await readExamState(forged),
    forgedObject: await objectExists(forgedObject),
    object: await objectExists(objectPath),
  });
  const before = await snapshot();
  expect(before.exam).toEqual({
    title: 'Owner material',
    format: 'DTZ',
    versionIds: [published.versionId],
  });
  expect(before.keys).toBe(45);
  expect(before.forged).toBeNull();
  expect(before.forgedObject).toBe(false);
  expect(before.object).toBe(true);

  // The function exists only with its new signature, for service_role
  // alone, as SECURITY INVOKER with an empty search_path.
  const catalog = psqlJson<Record<string, unknown>>(
    `select json_build_object(
      'oldSignature', to_regprocedure(${quote(OLD_PUBLISH_SIGNATURE)}),
      'overloads', (select count(*) from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'publish_exam_version'),
      'anon', has_function_privilege('anon', ${quote(PUBLISH_SIGNATURE)},
        'execute'),
      'authenticated', has_function_privilege('authenticated',
        ${quote(PUBLISH_SIGNATURE)}, 'execute'),
      'serviceRole', has_function_privilege('service_role',
        ${quote(PUBLISH_SIGNATURE)}, 'execute'),
      'publicGrant', exists (select 1 from pg_proc p,
        aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
        where p.oid = to_regprocedure(${quote(PUBLISH_SIGNATURE)})
          and x.grantee = 0),
      'definer', (select prosecdef from pg_proc
        where oid = to_regprocedure(${quote(PUBLISH_SIGNATURE)})),
      'config', (select array_to_string(proconfig, ',') from pg_proc
        where oid = to_regprocedure(${quote(PUBLISH_SIGNATURE)})))`,
  );
  expect(catalog).toEqual({
    oldSignature: null,
    overloads: 1,
    anon: false,
    authenticated: false,
    serviceRole: true,
    publicGrant: false,
    definer: false,
    config: 'search_path=""',
  });

  // Data API and Storage with the publishable key (anon).
  const anon = createPublicClient();
  const publishArgs = {
    p_slug: slug,
    p_title: 'Forged',
    p_format: 'DTZ',
    p_content: FULL_PILOT.content,
    p_keys: FULL_PILOT.keys,
    p_audio: [],
  };
  for (const args of [
    publishArgs,
    { ...publishArgs, p_slug: forged },
    { ...publishArgs, p_intent: 'new-version', p_rename: true },
    { ...publishArgs, p_slug: forged, p_intent: 'new-exam', p_rename: false },
  ]) {
    const { data, error } = await anon.rpc('publish_exam_version', args);
    expect(data, JSON.stringify(Object.keys(args))).toBeNull();
    expect(error?.code, args.p_slug).toBe('42501');
  }
  const writes = [
    anon.from('exams').insert({ slug: forged, title: 'Forged', format: 'DTZ' }),
    anon.from('exams').update({ title: 'Forged' }).eq('slug', slug),
    anon.from('exams').delete().eq('slug', slug),
    anon.from('exam_versions').insert({
      exam_id: randomUUID(),
      version: 99,
      content: { questions: [] },
    }),
    anon.from('answer_keys').insert({
      exam_version_id: published.versionId,
      question_id: 'forged-1',
      correct_option_id: 'a',
    }),
    anon
      .from('answer_keys')
      .update({ correct_option_id: 'a' })
      .eq('exam_version_id', published.versionId),
    anon.from('exam_version_audio').insert({
      exam_version_id: published.versionId,
      track_id: 'forged',
      kind: 'file',
      object_path: forgedObject,
      content_type: 'audio/wav',
      sha256: '0'.repeat(64),
    }),
  ];
  for (const [index, write] of writes.entries()) {
    const { error } = await write;
    expect(error, `anon write ${index}`).not.toBeNull();
  }
  const bucket = anon.storage.from('exam-sources');
  const upload = await bucket.upload(forgedObject, recording.bytes, {
    contentType: 'audio/wav',
  });
  expect(upload.error).not.toBeNull();
  const overwrite = await bucket.upload(objectPath, recording.bytes, {
    contentType: 'audio/wav',
    upsert: true,
  });
  expect(overwrite.error).not.toBeNull();
  await bucket.remove([objectPath]);
  await bucket.move(objectPath, forgedObject);

  // The same writes straight in SQL as anon and authenticated: refused by
  // privileges or by RLS of storage.objects.
  const forgedPublish = (target: string, intent: string) =>
    `select * from public.publish_exam_version(${quote(target)}, 'Forged',
      'DTZ', '{"questions": []}'::jsonb, '{}'::jsonb, '[]'::jsonb,
      ${quote(intent)}, true)`;
  const refused = [
    forgedPublish(forged, 'new-exam'),
    forgedPublish(slug, 'new-version'),
    `select * from public.publish_exam_version(${quote(slug)}, 'Forged',
      'DTZ', '{"questions": []}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
    `insert into public.exams (slug, title, format)
      values (${quote(forged)}, 'Forged', 'DTZ')`,
    `update public.exams set title = 'Forged' where slug = ${quote(slug)}`,
    `insert into public.exam_versions (exam_id, version, content)
      select id, 99, '{"questions": []}'::jsonb from public.exams
      where slug = ${quote(slug)}`,
    `insert into public.answer_keys
      (exam_version_id, question_id, correct_option_id)
      values (${quote(published.versionId)}, 'forged-1', 'a')`,
    `update public.answer_keys set correct_option_id = 'a'
      where exam_version_id = ${quote(published.versionId)}`,
    `insert into public.exam_version_audio
      (exam_version_id, track_id, kind, object_path, content_type, sha256)
      values (${quote(published.versionId)}, 'forged', 'file',
        ${quote(forgedObject)}, 'audio/wav', ${quote('0'.repeat(64))})`,
    `insert into storage.objects (bucket_id, name)
      values ('exam-sources', ${quote(forgedObject)})`,
  ];
  // Rows a public role cannot see are not changed by RLS: no error, no effect.
  const unseen = [
    `update storage.objects set name = ${quote(forgedObject)}
      where bucket_id = 'exam-sources' and name = ${quote(objectPath)}`,
    `delete from storage.objects
      where bucket_id = 'exam-sources' and name = ${quote(objectPath)}`,
  ];
  for (const role of ['anon', 'authenticated'] as const) {
    const run = sqlRunnerAs(role);
    for (const sql of refused) {
      expect(() => run(sql, {}), `${role}: ${sql}`).toThrow(
        /permission denied|row-level security/,
      );
    }
    for (const sql of unseen) {
      try {
        run(sql, {});
      } catch {
        // A refusal is as good as no effect; the re-read decides.
      }
    }
  }

  expect(await snapshot()).toEqual(before);
});

// Two exams and the library (#85) --------------------------------------------
//
// Guests of two independent full exams A and B, published by every test
// under slugs of its own. Ownership is judged with the trusted Origin, so a
// refusal is never the refusal of the Origin (that one is http-origin.spec).
// Each refused request is paired with an accepted control of the same shape,
// and every claim about the database is a re-read of whole rows.

const REVIEW_MARKS = [...KEY_FIELDS, 'review-solution'];
// The first task of both exams: its card in HTML and its prompt, which is
// also in the RSC payload (the prompt of A only adds its marker).
const FIRST_PROMPT = FULL_PILOT.content.questions[0]?.prompt ?? 'missing';
const MATERIAL_MARKS = ['question-card-', PAIR_A_MARKER, FIRST_PROMPT];

const publishPair = () =>
  publishExamPair({
    db: serviceDb,
    owner: sqlRunnerAs('owner'),
    audioA: createTestRecording(601),
    audioB: createTestRecording(607),
  });

const expectPrivate = (cacheControl: string, where: string) => {
  expect(cacheControl, where).toContain('no-store');
  expect(cacheControl, where).not.toMatch(/public|s-maxage/);
};

// The three tests below send dozens of real requests and re-read whole rows
// through psql after each group; the second one also waits for a guest term
// to end by the database clock.
const MATRIX_TIMEOUT_MS = 180_000;
// Long enough for the guest to build its states on a slow runner before the
// term ends; a guest that expires earlier fails its own controls.
const EXPIRING_TERM_SECONDS = 45;

test('foreign attempt slug and version are denied without mutation', async ({
  request,
}) => {
  test.setTimeout(MATRIX_TIMEOUT_MS);
  const { examA, examB } = await publishPair();
  const examIds = [examA.examId, examB.examId];
  const x = await newGuest(depsNow());
  const y = await newGuest(depsNow());
  const asX = { token: x.token };
  const asY = { token: y.token };
  const answerOf = (attemptId: string) => `/api/attempts/${attemptId}/answer`;
  const saved = async (
    token: string,
    attemptId: string,
    questionId: string,
    optionId: string,
  ) => {
    const reply = await postCommand(
      request,
      answerOf(attemptId),
      { questionId, optionId, revision: 1 },
      { token },
    );
    expect(reply.status, `${questionId} of ${attemptId}`).toBe(200);
  };

  // X: a completed and an active attempt of A, nothing of B. Y: a completed
  // attempt of A and an active one of B.
  const xDone = await startedOn(x.token, examA.slug);
  await saved(x.token, xDone, 'hoeren-1', fullWrongOf('hoeren-1'));
  await completedOn(x.token, xDone);
  const xActive = await startedOn(x.token, examA.slug);
  await saved(x.token, xActive, 'hoeren-1', fullKeyOf('hoeren-1'));
  const yDone = await startedOn(y.token, examA.slug);
  await saved(y.token, yDone, 'hoeren-3', fullWrongOf('hoeren-3'));
  await completedOn(y.token, yDone);
  const yActive = await startedOn(y.token, examB.slug);
  const yAnswers = {
    'hoeren-1': fullWrongOf('hoeren-1'),
    [PAIR_REPLACED]: fullKeyOf(PAIR_REPLACED),
  };
  for (const [questionId, optionId] of Object.entries(yAnswers)) {
    await saved(y.token, yActive, questionId, optionId);
  }
  expect(new Set([xDone, xActive, yDone, yActive]).size).toBe(4);
  const yMarks = [
    ...answerMarkersOf(yAnswers),
    ...answerMarkersOf({ 'hoeren-3': fullWrongOf('hoeren-3') }),
  ];

  // The fixtures are not empty: the owner's own pages carry what the
  // foreign requests below must not get.
  const ownActive = await readPage(
    request,
    attemptUrl(examB.slug, yActive),
    asY,
  );
  expect(ownActive.status).toBe(200);
  expect(ownActive.body).toContain('question-card-');
  expect(ownActive.body).toContain(FIRST_PROMPT);
  const ownActiveRsc = await readPage(
    request,
    attemptUrl(examB.slug, yActive),
    { ...asY, rsc: true },
  );
  expect(ownActiveRsc.contentType).toContain('text/x-component');
  expect(ownActiveRsc.body).toContain(FIRST_PROMPT);
  expect(includesAny(ownActiveRsc.body, answerMarkersOf(yAnswers))).toBe(true);
  expect(includesAny(ownActive.body, answerMarkersOf(yAnswers))).toBe(true);
  expectNone(ownActive.body, REVIEW_MARKS, 'own active page');
  const ownReview = await readPage(request, attemptUrl(examA.slug, yDone), asY);
  expect(ownReview.status).toBe(200);
  expect(includesAny(ownReview.body, REVIEW_MARKS)).toBe(true);
  expect(ownReview.body).toContain(PAIR_A_MARKER);
  const xOwn = await readPage(request, attemptUrl(examA.slug, xActive), asX);
  expect(xOwn.status).toBe(200);
  expect(xOwn.body).toContain(PAIR_A_MARKER);

  const snapshot = () => ({
    x: guestRows(x.guest.sessionId),
    y: guestRows(y.guest.sessionId),
    owners: examAttemptOwners(examIds),
  });
  const before = snapshot();
  expect(before.x.attempts).toHaveLength(2);
  expect(before.y.attempts).toHaveLength(2);
  expect(before.owners).toHaveLength(3);

  // 1. The pages of Y's attempts for X, under their own slug and under the
  // slug of the other exam, as HTML and as the RSC payload.
  const foreignPages = [yActive, yDone].flatMap((attemptId) =>
    [examA.slug, examB.slug].flatMap((slug) => [
      attemptUrl(slug, attemptId),
      attemptLesenUrl(slug, attemptId),
    ]),
  );
  // X's own attempts of A under the slug of B.
  const crossedPages = [xActive, xDone].flatMap((attemptId) => [
    attemptUrl(examB.slug, attemptId),
    attemptLesenUrl(examB.slug, attemptId),
  ]);
  for (const pathname of [...foreignPages, ...crossedPages]) {
    for (const rsc of [false, true]) {
      const where = `${pathname} ${rsc ? 'rsc' : 'html'}`;
      const reply = await readPage(request, pathname, { ...asX, rsc });
      if (!rsc) expect(reply.status, where).toBe(404);
      expectPrivate(reply.cacheControl, where);
      expectNone(
        reply.body,
        [...yMarks, ...REVIEW_MARKS, ...MATERIAL_MARKS, SIGNED_AUDIO],
        where,
      );
    }
  }

  // 2. Every command of an attempt, sent by X for the attempts of Y.
  const answer = {
    questionId: 'hoeren-2',
    optionId: fullKeyOf('hoeren-2'),
    revision: 1,
  };
  for (const attemptId of [yActive, yDone]) {
    const commands: [string, unknown][] = [
      ...ATTEMPT_COMMANDS,
      ['answer', answer],
    ];
    for (const [name, body] of commands) {
      const where = `${name} of ${attemptId}`;
      const reply = await postCommand(
        request,
        `/api/attempts/${attemptId}/${name}`,
        body,
        asX,
      );
      expect(reply.status, where).toBe(404);
      expectPrivate(reply.cacheControl, where);
      const text = JSON.stringify(reply.body);
      expectNone(
        text,
        [...REVIEW_MARKS, SIGNED_AUDIO, y.guest.sessionId, '"url"'],
        where,
      );
    }
  }
  expect(
    await getAttemptReview(depsNow(), x.token, { attemptId: yDone }),
  ).toEqual({ ok: false, error: 'attempt-not-found' });

  // 3. X's own attempt of A named for the exam B inside a command.
  const underSlug = await postCommand(
    request,
    answerOf(xActive),
    { ...answer, examSlug: examB.slug },
    asX,
  );
  expect(underSlug.status).toBe(400);
  expect(underSlug.body).toEqual({ ok: false, error: 'invalid-input' });

  // 4. A start of B with the version of A, and of A with the version of B.
  // X has no attempt of B: an accepted start would write.
  const startOfB = await startBody(examB.slug, {
    expectedVersionId: examB.versionId,
  });
  const swapped = { ...startOfB, expectedVersionId: examA.versionId };
  const start = (body: unknown) =>
    postCommand(request, '/api/attempts/start', body, asX);
  const refusedStart = await start(swapped);
  expect(refusedStart.status).toBe(404);
  expect(refusedStart.body).toEqual({ ok: false, failure: 'not-found' });
  // Another exam's version answers exactly like a version that never existed.
  const unknownVersion = await start({
    ...startOfB,
    commandId: randomUUID(),
    expectedVersionId: randomUUID(),
  });
  expect(unknownVersion.status).toBe(404);
  expect(unknownVersion.body).toEqual(refusedStart.body);
  // The timed modes, each by a guest with nothing at B: the same refusal,
  // and no row. The same bodies with the version of B are accepted below.
  const timedShapes = [
    { mode: 'exam', selection: 'all' },
    { mode: 'timed-block', selection: 'hoeren' },
  ];
  const timedGuests = await Promise.all(
    timedShapes.map(() => newGuest(depsNow())),
  );
  const timedStarts = timedShapes.map((shape, index) => {
    const guest = timedGuests[index];
    if (!guest) throw new Error('timed guest is missing');
    return {
      where: `start of B, ${shape.mode}`,
      guest,
      body: { ...startOfB, ...shape, commandId: randomUUID() },
    };
  });
  for (const { where, guest, body } of timedStarts) {
    const reply = await postCommand(
      request,
      '/api/attempts/start',
      { ...body, expectedVersionId: examA.versionId },
      { token: guest.token },
    );
    expect(reply.status, where).toBe(404);
    expect(reply.body, where).toEqual({ ok: false, failure: 'not-found' });
    const rows = guestRows(guest.guest.sessionId);
    expect(rows.attempts, where).toEqual([]);
    expect(rows.commands, where).toEqual([]);
  }
  const startOfA = await startBody(examA.slug, {
    expectedVersionId: examB.versionId,
  });
  const reversed = await start(startOfA);
  expect(reversed.status).toBe(404);
  expect(reversed.body).toEqual({ ok: false, failure: 'not-found' });
  // A timed start of the occupied slot of A answers with X's own attempt of
  // that slot before the version is read: nothing of B, nothing written.
  const occupied = await start({
    ...startOfA,
    commandId: randomUUID(),
    mode: 'timed-block',
    selection: 'hoeren',
  });
  expect(occupied.status).toBe(200);
  expect(occupied.body).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: xActive },
  });
  expectNone(JSON.stringify(occupied.body), [examB.versionId], 'occupied');

  // 5. A repeat of errors from a foreign source, and from X's own source of
  // the other exam.
  const repeat = (slug: string, versionId: string, sourceAttemptId: string) =>
    start({
      commandId: randomUUID(),
      examSlug: slug,
      mode: 'training',
      purpose: 'error-repeat',
      selection: 'all',
      sourceAttemptId,
      expectedVersionId: versionId,
    });
  const repeats = [
    await repeat(examA.slug, examA.versionId, yDone),
    await repeat(examB.slug, examB.versionId, xDone),
    await repeat(examB.slug, examA.versionId, xDone),
    await repeat(examB.slug, examB.versionId, randomUUID()),
  ];
  for (const [index, reply] of repeats.entries()) {
    const where = `repeat ${index}`;
    expect(reply.status, where).toBe(404);
    expect(reply.body, where).toEqual({ ok: false, failure: 'not-found' });
  }

  // Nothing was written for X or Y, and nobody else holds an attempt of the
  // two exams.
  expect(snapshot()).toEqual(before);

  // The controls: the same shapes are accepted for the owner. The refused
  // start with the right version (and the same commandId) starts B for X;
  // the answer X sent into Y's attempt is saved when Y sends it.
  const acceptedStart = await start(startOfB);
  expect(acceptedStart.status).toBe(200);
  expect(acceptedStart.body).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });
  const ownAnswer = await postCommand(request, answerOf(yActive), answer, asY);
  expect(ownAnswer.status).toBe(200);
  for (const { where, guest, body } of timedStarts) {
    const reply = await postCommand(request, '/api/attempts/start', body, {
      token: guest.token,
    });
    expect(reply.status, where).toBe(200);
    expect(reply.body, where).toMatchObject({
      ok: true,
      result: { outcome: 'accepted' },
    });
    const [attempt] = guestRows(guest.guest.sessionId).attempts;
    expect(attempt?.attempt, where).toMatchObject({
      exam_id: examB.examId,
      exam_version_id: examB.versionId,
    });
  }
  const after = snapshot();
  expect(after.x.attempts).toHaveLength(3);
  expect(after.owners).toHaveLength(6);
  const yActiveAfter = after.y.attempts.find(
    (item) => item.attempt.id === yActive,
  );
  expect(yActiveAfter?.answers).toHaveLength(3);
  expect(after.y.attempts.find((item) => item.attempt.id === yDone)).toEqual(
    before.y.attempts.find((item) => item.attempt.id === yDone),
  );
});

// Contexts of the tests below, closed after each of them on every path.
const openedContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(openedContexts.splice(0).map((context) => context.close()));
});

const cardOf = (page: Page, slug: string) =>
  page.getByTestId(`exam-card-${slug}`);

test('expired and replaced guests see no catalog state or audio', async ({
  browser,
  request,
}) => {
  test.setTimeout(MATRIX_TIMEOUT_MS);
  installM2Fixtures();
  const { examA, examB } = await publishPair();
  const examIds = [examA.examId, examB.examId];
  // An active attempt of A with an answer and a completed attempt of B.
  const withStates = async (token: string) => {
    const active = await startedOn(token, examA.slug);
    const saved = await postCommand(
      request,
      `/api/attempts/${active}/answer`,
      { questionId: 'hoeren-1', optionId: fullKeyOf('hoeren-1'), revision: 1 },
      { token },
    );
    expect(saved.status).toBe(200);
    const done = await startedOn(token, examB.slug);
    await completedOn(token, done);
    return { active, done };
  };
  const catalogOf = async (token: string) => [
    await readPage(request, '/exams', { token }),
    await readPage(request, '/exams', { token, rsc: true }),
  ];
  const answerMarks = answerMarkersOf({ 'hoeren-1': fullKeyOf('hoeren-1') });

  // The expired guest ------------------------------------------------------
  const expiring = shortGuest(EXPIRING_TERM_SECONDS);
  const states = await withStates(expiring.token);
  const ownIds = [states.active, states.done];
  // While the term lasts the library shows both states and the recording is
  // issued: the fixture is a guest with something to lose.
  for (const reply of await catalogOf(expiring.token)) {
    expect(reply.status).toBe(200);
    for (const id of ownIds) expect(reply.body).toContain(id);
  }
  const audioPath = `/api/attempts/${states.active}/audio`;
  const issued = await postCommand(
    request,
    audioPath,
    { trackId: FULL_TRACK_ID },
    { token: expiring.token },
  );
  expect(issued.status).toBe(200);
  // As a boolean: a failure never prints the signed address.
  expect(JSON.stringify(issued.body).includes(SIGNED_AUDIO)).toBe(true);
  const expiringRows = guestRows(expiring.sessionId);
  const owners = examAttemptOwners(examIds);
  expect(expiringRows.attempts).toHaveLength(2);

  await untilGuestExpired(expiring.sessionId, MATRIX_TIMEOUT_MS / 2);
  const [html, rsc] = await catalogOf(expiring.token);
  if (!html || !rsc) throw new Error('two catalog replies expected');
  expect(html.status).toBe(307);
  expect(new URL(html.location ?? '', FULL_ORIGIN).pathname).toBe('/');
  for (const reply of [html, rsc]) {
    expect(reply.setCookie).toBeNull();
    expectPrivate(reply.cacheControl, 'expired catalog');
    expectNone(
      reply.body,
      [...ownIds, 'exam-card-continue', 'exam-card-result', examA.slug],
      'expired catalog',
    );
  }
  const expiredPages = [
    `/practice/${examA.slug}`,
    attemptUrl(examA.slug, states.active),
    attemptLesenUrl(examA.slug, states.active),
    attemptUrl(examB.slug, states.done),
  ];
  for (const pathname of expiredPages) {
    for (const asRsc of [false, true]) {
      const where = `expired ${pathname} ${asRsc ? 'rsc' : 'html'}`;
      const reply = await readPage(request, pathname, {
        token: expiring.token,
        rsc: asRsc,
      });
      if (!asRsc) expect(reply.status, where).not.toBe(200);
      expect(reply.setCookie, where).toBeNull();
      expectNone(
        reply.body,
        [...answerMarks, ...REVIEW_MARKS, ...MATERIAL_MARKS, SIGNED_AUDIO],
        where,
      );
    }
  }
  const expiredCommands: [string, unknown][] = [
    [audioPath, { trackId: FULL_TRACK_ID }],
    [
      '/api/attempts/prepare-audio',
      { examSlug: examB.slug, expectedVersionId: examB.versionId },
    ],
    [
      '/api/attempts/start',
      await startBody(examB.slug, { expectedVersionId: examB.versionId }),
    ],
    [
      `/api/attempts/${states.active}/answer`,
      { questionId: 'hoeren-2', optionId: fullKeyOf('hoeren-2'), revision: 1 },
    ],
    [`/api/attempts/${states.active}/status`, {}],
    [`/api/attempts/${states.done}/status`, {}],
  ];
  for (const [pathname, body] of expiredCommands) {
    const where = `expired ${pathname}`;
    const reply = await postCommand(request, pathname, body, {
      token: expiring.token,
    });
    expect(reply.status, where).toBe(401);
    const text = JSON.stringify(reply.body);
    expect(text, where).toContain('session-invalid');
    expectNone(text, [...REVIEW_MARKS, SIGNED_AUDIO, '"url"'], where);
  }
  expect(guestRows(expiring.sessionId)).toEqual(expiringRows);
  expect(examAttemptOwners(examIds)).toEqual(owners);

  // The replaced guest -----------------------------------------------------
  // Too short for a timed block: the replacement of #44 gives the browser a
  // new guest. The old rows stay; the new cookie reaches none of them. (The
  // old token itself stays valid until its fixed term, as documented.)
  const old = shortGuest(600);
  const oldStates = await withStates(old.token);
  const oldIds = [oldStates.active, oldStates.done];
  const context = await guestContextOf(browser, old.token);
  openedContexts.push(context);
  const page = await context.newPage();
  await page.goto('/exams');
  await expect(
    cardOf(page, examA.slug).getByTestId('exam-card-continue'),
  ).toBeVisible();
  await expect(
    cardOf(page, examB.slug).getByTestId('exam-card-result'),
  ).toBeVisible();
  const oldRows = guestRows(old.sessionId);
  const ownersBefore = examAttemptOwners(examIds);

  const timedStart = await startBody(examB.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
    expectedVersionId: examB.versionId,
  });
  const replaced = await replaceGuestSession(
    depsNow(),
    TEST_GUEST_SESSIONS_PER_MINUTE,
    () => preflightTimedStart(depsNow(), old.token, timedStart),
  );
  if (replaced.status !== 'created') throw new Error(replaced.status);
  const fresh = replaced.created;
  expect(fresh.guest.sessionId).not.toBe(old.sessionId);
  // What the Server Action does next: the browser gets the new cookie.
  await context.clearCookies();
  await context.addCookies([
    { name: GUEST_COOKIE, value: fresh.token, url: FULL_ORIGIN },
  ]);
  await page.reload();
  await expect(page.getByTestId('exam-library')).toBeVisible();
  for (const slug of [examA.slug, examB.slug]) {
    const examCard = cardOf(page, slug);
    await expect(examCard.getByTestId('exam-card-open')).toBeVisible();
    await expect(examCard.getByTestId('exam-card-continue')).toHaveCount(0);
    await expect(examCard.getByTestId('exam-card-result')).toHaveCount(0);
  }
  expectNone(await page.content(), oldIds, 'library of the new guest');

  for (const reply of await catalogOf(fresh.token)) {
    expect(reply.status).toBe(200);
    // The library of the new guest is not an empty page.
    expect(reply.body).toContain(examA.slug);
    expect(reply.body).toContain(examB.slug);
    expectNone(reply.body, [...oldIds, SIGNED_AUDIO], 'new guest catalog');
    expectPrivate(reply.cacheControl, 'new guest catalog');
  }
  const oldPages = [
    attemptUrl(examA.slug, oldStates.active),
    attemptLesenUrl(examA.slug, oldStates.active),
    attemptUrl(examB.slug, oldStates.done),
  ];
  for (const pathname of oldPages) {
    const where = `replaced ${pathname}`;
    const reply = await readPage(request, pathname, { token: fresh.token });
    expect(reply.status, where).toBe(404);
    expectNone(
      reply.body,
      [...answerMarks, ...REVIEW_MARKS, ...MATERIAL_MARKS, SIGNED_AUDIO],
      where,
    );
  }
  const oldCommands: [string, unknown][] = [
    [`/api/attempts/${oldStates.active}/audio`, { trackId: FULL_TRACK_ID }],
    [
      `/api/attempts/${oldStates.active}/answer`,
      { questionId: 'hoeren-2', optionId: fullKeyOf('hoeren-2'), revision: 1 },
    ],
    [`/api/attempts/${oldStates.active}/status`, {}],
    [`/api/attempts/${oldStates.done}/status`, {}],
  ];
  for (const [pathname, body] of oldCommands) {
    const where = `replaced ${pathname}`;
    const reply = await postCommand(request, pathname, body, {
      token: fresh.token,
    });
    expect(reply.status, where).toBe(404);
    expectNone(
      JSON.stringify(reply.body),
      [...REVIEW_MARKS, SIGNED_AUDIO, '"url"'],
      where,
    );
  }
  expect(
    await getAttemptReview(depsNow(), fresh.token, {
      attemptId: oldStates.done,
    }),
  ).toEqual({ ok: false, error: 'attempt-not-found' });

  expect(guestRows(old.sessionId)).toEqual(oldRows);
  expect(examAttemptOwners(examIds)).toEqual(ownersBefore);
  const freshRows = guestRows(fresh.guest.sessionId);
  expect(freshRows.attempts).toEqual([]);
  expect(freshRows.commands).toEqual([]);
  expect(freshRows.session).toMatchObject({ locale: 'en' });
});

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const READ_TABLES = [
  'exams',
  'exam_versions',
  'answer_keys',
  'attempts',
  'attempt_results',
] as const;

test('public roles cannot read material keys attempts or audio', async ({
  request,
}) => {
  test.setTimeout(MATRIX_TIMEOUT_MS);
  const { examA, examB } = await publishPair();
  const guest = await newGuest(depsNow());
  const active = await startedOn(guest.token, examA.slug);
  const done = await startedOn(guest.token, examB.slug);
  await completedOn(guest.token, done);
  const objectPaths = await Promise.all(
    [examA.versionId, examB.versionId].map(async (versionId) => {
      const [track] = (await tracksOf(versionId)) as { object_path: string }[];
      if (!track) throw new Error('track is missing');
      return track.object_path;
    }),
  );
  const [objectPath] = objectPaths;
  if (!objectPath) throw new Error('object path is missing');
  expect(new Set(objectPaths).size).toBe(2);
  const recordingSha = sha256Of(await readAudioObject(objectPath));
  expect(recordingSha).toBe(sha256Of(createTestRecording(601).bytes));

  // What the trusted side holds: the rows and objects the public roles are
  // about to ask for exist.
  const versions = [examA.versionId, examB.versionId].map(quote).join(', ');
  const exams = [examA.examId, examB.examId].map(quote).join(', ');
  const session = quote(guest.guest.sessionId);
  const stored = () =>
    psqlJson<Record<string, number>>(`select json_build_object(
      'exams', (select count(*) from public.exams where id in (${exams})),
      'versions', (select count(*) from public.exam_versions
        where id in (${versions})),
      'keys', (select count(*) from public.answer_keys
        where exam_version_id in (${versions})),
      'attempts', (select count(*) from public.attempts
        where guest_session_id = ${session}),
      'results', (select count(*) from public.attempt_results r
        join public.attempts a on a.id = r.attempt_id
        where a.guest_session_id = ${session}),
      'objects', (select count(*) from storage.objects
        where bucket_id = 'exam-sources'
          and name in (${objectPaths.map(quote).join(', ')})))`);
  const before = stored();
  expect(before).toEqual({
    exams: 2,
    versions: 2,
    keys: 90,
    attempts: 2,
    results: 1,
    objects: 2,
  });
  const rowsBefore = guestRows(guest.guest.sessionId);

  // The row of each table a visitor would name by a known id.
  const known: Record<(typeof READ_TABLES)[number], [string, string]> = {
    exams: ['id', examA.examId],
    exam_versions: ['id', examA.versionId],
    answer_keys: ['exam_version_id', examA.versionId],
    attempts: ['id', active],
    attempt_results: ['attempt_id', done],
  };

  // anon: the Data API with the publishable key, through the SDK and as the
  // plain HTTP request anybody can send.
  const anon = createPublicClient();
  const env = readTestSupabaseEnv();
  const keyHeaders: Record<string, string> = {
    apikey: env.publishableKey,
    authorization: `Bearer ${env.publishableKey}`,
  };
  const dataHeaders: Record<string, string>[] = [
    keyHeaders,
    { apikey: env.publishableKey },
    {},
  ];
  const objectHeaders: Record<string, string>[] = [keyHeaders, {}];
  for (const table of READ_TABLES) {
    const [column, value] = known[table];
    const all = await anon.from(table).select('*');
    expect(all.error, `${table} select`).not.toBeNull();
    expect(all.data, `${table} select`).toBeNull();
    const one = await anon.from(table).select('*').eq(column, value);
    expect(one.error, `${table} by id`).not.toBeNull();
    expect(one.data, `${table} by id`).toBeNull();
    const counted = await anon
      .from(table)
      .select('*', { count: 'exact', head: true });
    expect(counted.count, `${table} count`).toBeNull();

    const address = `${env.url}/rest/v1/${table}?select=*&${column}=eq.${value}`;
    for (const headers of dataHeaders) {
      const where = `${table} http ${Object.keys(headers).join('+')}`;
      const reply = await request.get(address, { headers });
      expect(reply.status(), where).toBeGreaterThanOrEqual(400);
      const text = await reply.text();
      expectNone(
        text,
        ['correct_option_id', 'guest_session_id', '"content"', '"slug"'],
        where,
      );
    }
  }

  // anon: the private bucket through Storage.
  const bucket = anon.storage.from('exam-sources');
  const fileName = objectPath.slice(objectPath.lastIndexOf('/') + 1);
  const downloaded = await bucket.download(objectPath);
  expect(downloaded.error).not.toBeNull();
  expect(downloaded.data).toBeNull();
  const signed = await bucket.createSignedUrl(objectPath, 60);
  expect(signed.error).not.toBeNull();
  expect(signed.data).toBeNull();
  const objectFolder = objectPath.slice(0, objectPath.lastIndexOf('/'));
  expect(objectFolder).not.toBe('');
  for (const folder of ['', objectFolder]) {
    const listed = await bucket.list(folder, { search: fileName });
    expect(
      listed.error !== null || listed.data.length === 0,
      `list ${folder}`,
    ).toBe(true);
  }
  const storageBase = `${env.url}/storage/v1/object`;
  const objectAddresses = [
    bucket.getPublicUrl(objectPath).data.publicUrl,
    `${storageBase}/exam-sources/${objectPath}`,
    `${storageBase}/authenticated/exam-sources/${objectPath}`,
    `${storageBase}/info/exam-sources/${objectPath}`,
  ];
  for (const address of objectAddresses) {
    for (const headers of objectHeaders) {
      const where = `${new URL(address).pathname} ${Object.keys(headers).length}`;
      const reply = await request.get(address, { headers });
      expect(reply.status(), where).toBeGreaterThanOrEqual(400);
      expect(sha256Of(await reply.body()), where).not.toBe(recordingSha);
    }
  }

  // anon and authenticated in SQL: no privilege on the tables, RLS enabled,
  // and the objects of the bucket are invisible.
  const open = psqlJson<string[]>(`select coalesce(json_agg(r.role || ':'
      || t.name), '[]'::json)
    from (values ('anon'), ('authenticated')) r (role),
      (values ${READ_TABLES.map((table) => `(${quote(table)})`).join(', ')})
        t (name)
    where has_table_privilege(r.role, 'public.' || t.name,
      'select, insert, update, delete')`);
  expect(open).toEqual([]);
  const unguarded = psqlJson<string[]>(`select coalesce(json_agg(c.relname),
      '[]'::json) from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relname in (${READ_TABLES.map(quote).join(', ')})
      and not c.relrowsecurity`);
  expect(unguarded).toEqual([]);
  for (const role of ['anon', 'authenticated'] as const) {
    const run = sqlRunnerAs(role);
    for (const table of READ_TABLES) {
      const [column, value] = known[table];
      expect(
        () =>
          run(
            `select * from public.${table} where ${column} = ${quote(value)}`,
            {},
          ),
        `${role}: ${table}`,
      ).toThrow(/permission denied/);
    }
    let seen: string | null = null;
    try {
      seen = run(
        `select count(*) from storage.objects
          where bucket_id = 'exam-sources'`,
        {},
      );
    } catch (error) {
      expect(String(error), `${role}: storage.objects`).toMatch(
        /permission denied/,
      );
    }
    expect(seen === null || seen === '0', `${role}: storage.objects`).toBe(
      true,
    );
  }

  // Nothing moved: the same rows, the same bytes.
  expect(stored()).toEqual(before);
  expect(guestRows(guest.guest.sessionId)).toEqual(rowsBefore);
  expect(sha256Of(await readAudioObject(objectPath))).toBe(recordingSha);
});
