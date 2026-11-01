import { expect, test } from '@playwright/test';
import type {
  APIResponse,
  BrowserContext,
  Page,
  Request,
} from '@playwright/test';
import { readAnswers } from './support/db';
import { FULL_EXAM, fullWrongOf } from './support/full-exam';
import {
  card,
  expectStatus,
  goToHoeren,
  goToLesen,
  optionIn,
  startBrowserGuest,
} from './support/guest-browser';

// Guest pages carry the answers of one attempt. Whatever sits between the
// server and the browser must not hand them to the next visitor of the same
// address: every response is private and never stored, and the body is
// rendered for the session of the request alone.

const PATHS = ['/practice', '/practice/lesen'] as const;

interface Probe {
  url: string;
  headers: Record<string, string>;
}

// The address and headers a browser really sends: the page itself, and the
// RSC requests of the client navigation between the blocks.
const PAGE_PROBES: Probe[] = PATHS.map((url) => ({ url, headers: {} }));

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

// How the attempt of a guest shows in a page or an RSC payload: its id, and
// its answers as the props of the screens (plain or escaped inside HTML).
const markersOf = (
  attemptId: string,
  answers: Readonly<Record<string, string>>,
): string[] => [
  attemptId,
  ...Object.entries(answers).flatMap(([questionId, optionId]) => [
    `"${questionId}":"${optionId}"`,
    `\\"${questionId}\\":\\"${optionId}\\"`,
  ]),
];

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
  return { where, status: response.status(), body: await response.text() };
};

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
  const probes = [...PAGE_PROBES, ...rscProbes];
  const firstMarkers = markersOf(first.attemptId, answers);
  const carries = (body: string) =>
    firstMarkers.some((marker) => body.includes(marker));

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
    await fetchProbe(first.context, probe);
    const { where, status, body } = await fetchProbe(second.context, probe);
    expect(carries(body), where).toBe(false);
    // The second guest got a screen of the exam, not an empty or error body;
    // a whole page also carries its own attempt.
    if (!isPrefetch(probe)) {
      expect(status, where).toBe(200);
      expect(body, where).toContain(FULL_EXAM.title);
    }
    if (Object.keys(probe.headers).length === 0) {
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

  // A visitor without a cookie gets no page of an attempt at all.
  const stranger = await browser.newContext();
  for (const probe of probes) {
    await fetchProbe(first.context, probe);
    const { where, body } = await fetchProbe(stranger, probe);
    expect(carries(body), where).toBe(false);
    expect(body, where).not.toContain(second.attemptId);
  }
  await stranger.close();

  expect(await readAnswers(first.attemptId)).toEqual(answers);
  await first.context.close();
  await second.context.close();
});
