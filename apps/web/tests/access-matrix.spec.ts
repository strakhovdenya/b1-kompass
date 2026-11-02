import { expect, test } from '@playwright/test';
import type {
  APIResponse,
  Browser,
  BrowserContext,
  Page,
  Request,
} from '@playwright/test';
import {
  readAnswers,
  readAttempts,
  readCommandRows,
  readEventKinds,
  readSessionByToken,
  startBody,
} from './support/db';
import { FULL_EXAM, fullWrongOf } from './support/full-exam';
import {
  CHOICE_URL,
  attemptLesenUrl,
  attemptUrl,
  card,
  expectStatus,
  goToHoeren,
  goToLesen,
  optionIn,
  startBrowserGuest,
  tokenOf,
} from './support/guest-browser';

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
  await page.getByRole('button', { name: 'Continue as guest' }).click();
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
