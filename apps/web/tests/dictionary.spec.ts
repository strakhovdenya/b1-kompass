import { randomUUID } from 'node:crypto';
import { devices, expect, request, test } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Locator,
  Page,
} from '@playwright/test';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  createPublicClient,
  depsAt,
  depsNow,
  newGuest,
  readAnswers,
  readProgress,
  serviceDb,
} from './support/db';
import {
  activeAttemptOf,
  card,
  enterAndStart,
  expectStatus,
  goToLesen,
  holdTouch,
  optionIn,
  touchPadOf,
  playFrom,
  scrollWithFinger,
  snapshotOf,
  waitForPlayer,
} from './support/guest-browser';
import { goToStep } from './support/release';
import { psql, quote } from './support/sql';

// The word dictionary on the synthetic full set, against the real local
// Supabase and the real Next server. The server's deterministic test provider
// replaces only MyMemory and OpenThesaurus (playwright.config.ts): the guest,
// the shared cache and the atomic budget run for real, and no request leaves
// the machine. German words of the material are matched as text (never
// translated); controls are found by test id.

const FULL_ORIGIN = 'http://localhost:3102';
const DICTIONARY_PATH = '/api/dictionary';
const WIDE = { width: 1440, height: 900 };
const LONG_TASK = 11;
const PARAGRAPH = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const PHONE = devices['Pixel 7'];
// A short tap opens the sheet of a word at once (#120). A finger resting
// this long is the browser's own long press (text selection): well past a
// tap and past the 1500 ms hold that #66 used before.
const HOLD_MS = 1900;
const GOOGLE_PHRASE = 'dictionary-google-phrase';
const GOOGLE_PAGES = 'https://translate.google.com/**';

const cardOf = (page: Page): Locator => page.getByTestId('dictionary-card');
const wordOf = (page: Page): Locator => page.getByTestId('dictionary-word');
const translationOf = (page: Page): Locator =>
  page.getByTestId('dictionary-translation');
const toggleOf = (page: Page): Locator => page.getByTestId('dictionary-toggle');

// The switch is a pressed/unpressed button.
const setTranslator = async (page: Page, isOn: boolean) => {
  const toggle = toggleOf(page);
  const pressed = isOn ? 'true' : 'false';
  if ((await toggle.getAttribute('aria-pressed')) !== pressed) {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-pressed', pressed);
};

// A fresh word for each run: letters only, so it passes the word check.
const freshWord = (prefix: string): string =>
  `${prefix}${randomUUID()
    .replace(/-/g, '')
    .slice(0, 10)
    .replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)] ?? 'a')}`;

interface WordBox {
  x: number;
  y: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// Where a German word of the material is on the screen, read with a DOM
// Range over its first occurrence inside the locator.
const wordBox = async (locator: Locator, word: string): Promise<WordBox> => {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(target) ?? -1;
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      const rect = range.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    }
    throw new Error(`${target} is not in the element`);
  }, word);
};

// Every POST of the page to a path, counted from now on.
const trackPosts = (page: Page, path: RegExp): string[] => {
  const seen: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() !== 'POST') return;
    if (path.test(new URL(sent.url()).pathname)) seen.push(sent.url());
  });
  return seen;
};

const ANSWER_PATH = /\/api\/attempts\/[^/]+\/answer$/;
const LOOKUP_PATH = /^\/api\/dictionary$/;

const openContext = async (
  browser: Browser,
  phone = false,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext(
    phone ? { ...PHONE } : { viewport: WIDE },
  );
  const page = await context.newPage();
  await enterAndStart(page);
  await expect(card(page, 'hoeren-1')).toBeVisible();
  return { context, page };
};

// The German words are text zones only once the page is hydrated with the
// translator on.
const expectZones = (locator: Locator) =>
  expect(locator.locator('[data-dictionary-text]').first()).toBeVisible();

const clearSelection = (page: Page) =>
  page.evaluate(() => window.getSelection()?.removeAllRanges());

// Selects text of the material as the system handles leave it: one range
// from the first occurrence of `from` to the end of the first occurrence
// of `to` (the same text node or a later one) inside the locators.
const selectRange = async (
  from: Locator,
  fromText: string,
  to: Locator = from,
  toText: string = fromText,
) => {
  const start = await from.evaluateHandle((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(target) ?? -1;
      if (index !== -1) return { node, index };
    }
    throw new Error(`${target} is not in the element`);
  }, fromText);
  await to.evaluate(
    (element, { begin, target }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent?.indexOf(target) ?? -1;
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(begin.node, begin.index);
        range.setEnd(node, index + target.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      throw new Error(`${target} is not in the element`);
    },
    { begin: start, target: toText },
  );
  await start.dispose();
};

const selectedText = (page: Page) =>
  page.evaluate(() => window.getSelection()?.toString() ?? '');

// Every request to the external Google Translate page is answered here by
// a stub: no test leaves the machine, and each request is counted.
const stubGoogle = async (context: BrowserContext): Promise<string[]> => {
  const seen: string[] = [];
  await context.route(GOOGLE_PAGES, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>stub</title>',
    });
  });
  return seen;
};

const optionLabel = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator('label').filter({
    has: cardLocator.page().locator(`input[value="${optionId}"]`),
  });

const readCacheRows = async (word: string) => {
  const { data, error } = await serviceDb
    .from('dictionary_cache')
    .select('provider, version, word, target, state, payload, expires_at')
    .eq('word', word);
  if (error) throw error;
  return data;
};

const readBudget = async (scope: string): Promise<number> => {
  const { data, error } = await serviceDb
    .from('dictionary_budget')
    .select('used')
    .eq('scope', scope);
  if (error) throw error;
  return data.reduce((sum, row) => sum + (row.used as number), 0);
};

test('dictionary opens for Lesen word on desktop and mobile', async ({
  browser,
}) => {
  // Desktop: a double click selects one word; the card sits beside it.
  const desktop = await openContext(browser);
  const { page } = desktop;
  await goToLesen(page);
  const lookups = trackPosts(page, LOOKUP_PATH);
  const paragraph = page.getByTestId('reading-paragraph-0');
  const box = await wordBox(paragraph, 'Anzeige');
  await page.mouse.dblclick(box.x, box.y);
  await expect(cardOf(page)).toBeVisible();
  await expect(cardOf(page)).toHaveAttribute('data-presentation', 'popper');
  await expect(wordOf(page)).toHaveText('Anzeige');
  await expect(translationOf(page)).toHaveText('test-en:Anzeige');
  const placed = await cardOf(page).boundingBox();
  if (!placed) throw new Error('card has no box');
  const isBelow = placed.y >= box.bottom - 1 && placed.y - box.bottom <= 24;
  const isAbove =
    placed.y + placed.height <= box.top + 1 &&
    box.top - (placed.y + placed.height) <= 24;
  expect(isBelow || isAbove).toBe(true);
  expect(Math.abs(placed.x - box.left)).toBeLessThanOrEqual(24);
  expect(placed.x + placed.width).toBeLessThanOrEqual(WIDE.width);
  await page.keyboard.press('Escape');
  await expect(cardOf(page)).toBeHidden();

  // Selecting one word with the mouse.
  const zeile = await wordBox(paragraph, 'Zeile');
  await page.mouse.move(zeile.left + 1, zeile.y);
  await page.mouse.down();
  await page.mouse.move(zeile.right - 1, zeile.y, { steps: 5 });
  await page.mouse.up();
  await expect(wordOf(page)).toHaveText('Zeile');
  await page.keyboard.press('Escape');

  // A selected phrase never starts a lookup.
  const before = lookups.length;
  const phrase = await wordBox(paragraph, 'zu Teil');
  await page.mouse.move(phrase.left + 1, phrase.y);
  await page.mouse.down();
  await page.mouse.move(phrase.right - 1, phrase.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await expect(cardOf(page)).toBeHidden();
  expect(lookups.length).toBe(before);
  // The phrase is offered to the external page only, never to the lookup.
  await expect(page.getByTestId(GOOGLE_PHRASE)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.getByTestId(GOOGLE_PHRASE)).toHaveCount(0);

  // Resting the mouse on a word for about half a second.
  const teil = await wordBox(paragraph, 'Teil');
  await page.mouse.move(teil.x, teil.y);
  await expect(wordOf(page)).toHaveText('Teil');
  // A click outside closes the card.
  await page.mouse.click(5, 5);
  await expect(cardOf(page)).toBeHidden();
  await desktop.context.close();

  // Phone: a short tap on the word opens the bottom sheet; the page is not
  // locked.
  const phone = await openContext(browser, true);
  await goToLesen(phone.page);
  await expectZones(phone.page.getByTestId('reading-paragraph-0'));
  const tap = await wordBox(
    phone.page.getByTestId('reading-paragraph-0'),
    'Anzeige',
  );
  await phone.page.touchscreen.tap(tap.x, tap.y);
  const sheet = cardOf(phone.page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-presentation', 'sheet');
  await expect(wordOf(phone.page)).toHaveText('Anzeige');
  await expect(translationOf(phone.page)).toHaveText('test-en:Anzeige');
  const viewport = phone.page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  await expect
    .poll(async () => {
      const sheetBox = await sheet.boundingBox();
      return sheetBox ? Math.round(sheetBox.y + sheetBox.height) : -1;
    })
    .toBeGreaterThanOrEqual(viewport.height - 2);
  const overflow = await phone.page.evaluate(
    () => getComputedStyle(document.body).overflow,
  );
  expect(overflow).not.toBe('hidden');
  await phone.page.getByTestId('dictionary-close').click();
  await expect(sheet).toBeHidden();
  await phone.context.close();
});

// #66 named this test after its 1500 ms hold; the owner's decision of
// 2026-11-18 (#120) replaced the hold by a short tap, and the long press now
// belongs to the browser's text selection. The name stays: closed issues
// refer to it.
test('mobile dictionary requires 1500ms stationary long press', async ({
  browser,
}) => {
  const { context, page } = await openContext(browser, true);
  await goToLesen(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  await expectZones(paragraph);
  const lookups = trackPosts(page, LOOKUP_PATH);
  const point = await wordBox(paragraph, 'Anzeige');
  const pad = await touchPadOf(page);
  // Each step waits well past the old 1500 ms, so no delayed opening of any
  // kind could hide behind it.
  const expectNothing = async (step: string) => {
    await page.waitForTimeout(HOLD_MS);
    await expect(cardOf(page), step).toHaveCount(0);
    expect(lookups, step).toEqual([]);
    await clearSelection(page);
  };

  // A stationary hold for the full old delay, and longer: the browser's
  // long press, never the card.
  await pad.down(point.x, point.y);
  await page.waitForTimeout(HOLD_MS);
  await expect(cardOf(page)).toHaveCount(0);
  await pad.up();
  await expectNothing('hold');
  await pad.down(point.x, point.y);
  await page.waitForTimeout(550);
  await pad.up();
  await expectNothing('hold of 550 ms');

  // A finger that drifts further than the tolerance.
  await pad.down(point.x, point.y);
  await page.waitForTimeout(100);
  await pad.move(point.x + 24, point.y);
  await pad.up();
  await expectNothing('drift');

  // A cancelled touch.
  await pad.down(point.x, point.y);
  await page.waitForTimeout(100);
  await pad.cancel();
  await expectNothing('cancel');

  // A scroll: the page really scrolls and no lookup is asked. A short screen
  // makes the page taller than the viewport.
  await page.setViewportSize({ width: 412, height: 420 });
  const scrollable = await wordBox(paragraph, 'Anzeige');
  const scrolled = await scrollWithFinger(page, pad, scrollable);
  expect(scrolled.after).not.toBe(scrolled.before);
  await expectNothing('scroll');

  // A short tap opens the sheet at once and exactly once; the release and
  // the click after it add no second lookup.
  const tapped = await wordBox(paragraph, 'Anzeige');
  await page.touchscreen.tap(tapped.x, tapped.y);
  await expect(cardOf(page)).toHaveAttribute('data-presentation', 'sheet', {
    timeout: 1000,
  });
  await expect(wordOf(page)).toHaveText('Anzeige');
  await page.waitForTimeout(500);
  expect(lookups).toHaveLength(1);
  await context.close();
});

test('dictionary lookup preserves Hören selection', async ({ browser }) => {
  const { context, page } = await openContext(browser);
  const { attemptId } = await activeAttemptOf(context);
  const target = card(page, 'hoeren-1');
  await optionIn(target, 'a').check();
  await expectStatus(target, 'saved');
  const answers = trackPosts(page, ANSWER_PATH);

  // Hover over the text of another option.
  const option = optionLabel(target, 'b');
  const antwort = await wordBox(option, 'Antwort');
  await page.mouse.move(antwort.x, antwort.y);
  await expect(wordOf(page)).toHaveText('Antwort');
  await expect(translationOf(page)).toHaveText('test-en:Antwort');
  await page.keyboard.press('Escape');

  // A double click and a click on the option text.
  await page.mouse.dblclick(antwort.x, antwort.y);
  await expect(wordOf(page)).toHaveText('Antwort');
  await page.keyboard.press('Escape');
  await page.mouse.click(antwort.x, antwort.y);

  // A word of the question itself.
  const frage = await wordBox(target.locator('h2'), 'Frage');
  await page.mouse.dblclick(frage.x, frage.y);
  await expect(wordOf(page)).toHaveText('Frage');
  await page.keyboard.press('Escape');

  await expect(optionIn(target, 'a')).toBeChecked();
  await expect(optionIn(target, 'b')).not.toBeChecked();
  await expectStatus(target, 'saved');
  await page.waitForTimeout(500);
  expect(answers).toEqual([]);
  expect(await readAnswers(attemptId)).toEqual({ 'hoeren-1': 'a' });
  // The radio keeps its accessible name.
  await expect(
    target.getByRole('radio', { name: /Antwort b/ }),
  ).not.toBeChecked();
  await context.close();
});

test('concurrent lookups respect shared provider budget', async () => {
  // Fifteen reservations of three guests race for a shared limit of five.
  const guests = await Promise.all(
    [0, 1, 2].map(async () => (await newGuest(depsNow())).guest.sessionId),
  );
  const shared = `e2etest:${randomUUID()}`;
  const calls = guests.flatMap((sessionId) =>
    [0, 1, 2, 3, 4].map(() =>
      serviceDb.rpc('reserve_dictionary_budget', {
        p_session_id: sessionId,
        p_items: [
          {
            scope: `guest:${sessionId}`,
            window: 'minute',
            cost: 1,
            limit: 100,
          },
          { scope: shared, window: 'day', cost: 1, limit: 5 },
        ],
      }),
    ),
  );
  const results = await Promise.all(calls);
  const accepted = results.filter((result) => !result.error);
  const refused = results.filter((result) => result.error);
  expect(accepted).toHaveLength(5);
  expect(refused).toHaveLength(10);
  for (const result of refused) {
    expect(result.error?.hint).toBe('dictionary_budget_exhausted');
    expect(result.error?.details).toBe('e2etest');
  }
  expect(await readBudget(shared)).toBe(5);
  // A refused call took nothing from the guest scopes either.
  let guestTotal = 0;
  for (const sessionId of guests) {
    guestTotal += await readBudget(`guest:${sessionId}`);
  }
  expect(guestTotal).toBe(5);

  // A refused scope rolls back the scopes before it.
  const [first] = guests;
  if (!first) throw new Error('no guest');
  const roomy = `e2etest:${randomUUID()}`;
  const refusedAll = await serviceDb.rpc('reserve_dictionary_budget', {
    p_session_id: first,
    p_items: [
      { scope: roomy, window: 'day', cost: 1, limit: 100 },
      { scope: shared, window: 'day', cost: 1, limit: 5 },
    ],
  });
  expect(refusedAll.error?.hint).toBe('dictionary_budget_exhausted');
  expect(await readBudget(roomy)).toBe(0);
  expect(await readBudget(shared)).toBe(5);

  // An expired guest is refused before anything is counted.
  const expired = await newGuest(depsAt(new Date(Date.now() - 31 * DAY_MS)));
  const late = `e2etest:${randomUUID()}`;
  const lateCall = await serviceDb.rpc('reserve_dictionary_budget', {
    p_session_id: expired.guest.sessionId,
    p_items: [{ scope: late, window: 'day', cost: 1, limit: 100 }],
  });
  expect(lateCall.error?.hint).toBe('guest_session_invalid');
  expect(await readBudget(late)).toBe(0);

  // Four guests look up the same new word at once: one shared cache entry
  // per source, the same answer for all.
  const word = freshWord('Gleichzeitig');
  const tokens = await Promise.all(
    [0, 1, 2, 3].map(async () => (await newGuest(depsNow())).token),
  );
  const clients = await Promise.all(
    tokens.map(() => request.newContext({ baseURL: FULL_ORIGIN })),
  );
  const responses = await Promise.all(
    clients.map((client, index) =>
      client.post(DICTIONARY_PATH, {
        headers: {
          Origin: FULL_ORIGIN,
          Cookie: `${GUEST_COOKIE}=${tokens[index]}`,
        },
        data: { word },
      }),
    ),
  );
  for (const response of responses) {
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.entry.translation.text).toBe(`test-en:${word}`);
  }
  const rows = await readCacheRows(word);
  expect(
    rows.map((row) => `${row.provider}:${row.target}:${row.state}`).sort(),
  ).toEqual(['mymemory:en:found', 'openthesaurus:de:not-found']);
  await Promise.all(clients.map((client) => client.dispose()));
});

test('translator toggle persists and disables lookups', async ({ browser }) => {
  const { context, page } = await openContext(browser);
  await goToLesen(page);
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'true');
  await setTranslator(page, false);
  await expect(toggleOf(page)).toHaveAttribute('data-enabled', 'false');
  await expect(page.getByTestId('dictionary-bar')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-dictionary-text]')).toHaveCount(0);
  await expect(page.getByTestId('dictionary-translate-selection')).toHaveCount(
    0,
  );
  const lookups = trackPosts(page, LOOKUP_PATH);
  const paragraph = page.getByTestId('reading-paragraph-0');
  const box = await wordBox(paragraph, 'Anzeige');
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(900);
  await page.mouse.dblclick(box.x, box.y);
  await page.waitForTimeout(500);
  await expect(cardOf(page)).toHaveCount(0);
  expect(lookups).toEqual([]);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem('b1k.dictionary.enabled.v1'),
    ),
  ).toBe('false');
  await context.close();
});

test('word interaction cannot submit answer', async ({ browser }) => {
  const { context, page } = await openContext(browser);
  const { attemptId } = await activeAttemptOf(context);
  const target = card(page, 'hoeren-1');
  const answers = trackPosts(page, ANSWER_PATH);

  // Translator on: clicks on the option text open the card only.
  const text = await wordBox(optionLabel(target, 'b'), 'Antwort');
  await page.mouse.click(text.x, text.y);
  await page.mouse.dblclick(text.x, text.y);
  await expect(wordOf(page)).toHaveText('Antwort');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  for (const id of ['a', 'b', 'c']) {
    await expect(optionIn(target, id)).not.toBeChecked();
  }
  expect(answers).toEqual([]);

  // The radio control itself still saves, with the translator on.
  await optionIn(target, 'b').check();
  await expectStatus(target, 'saved');
  expect(answers).toHaveLength(1);
  // Keyboard on the radio group still moves the answer.
  await optionIn(target, 'b').focus();
  await page.keyboard.press('ArrowDown');
  await expect(optionIn(target, 'c')).toBeChecked();
  await expectStatus(target, 'saved');
  expect(await readAnswers(attemptId)).toEqual({ 'hoeren-1': 'c' });

  // Lesen options behave the same.
  await goToLesen(page);
  const lesen = card(page, 'lesen-1');
  const lesenAnswers = answers.length;
  const lesenText = await wordBox(optionLabel(lesen, 'a'), 'Antwort');
  await page.mouse.click(lesenText.x, lesenText.y);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await expect(optionIn(lesen, 'a')).not.toBeChecked();
  expect(answers.length).toBe(lesenAnswers);

  // Translator off: the label text chooses the answer as before.
  await setTranslator(page, false);
  const plainText = await wordBox(optionLabel(lesen, 'b'), 'Antwort');
  await page.mouse.click(plainText.x, plainText.y);
  await expect(optionIn(lesen, 'b')).toBeChecked();
  await expectStatus(lesen, 'saved');
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': 'c',
    'lesen-1': 'b',
  });
  await setTranslator(page, true);
  await context.close();

  // Phone: a tap on the option text opens the sheet, not the answer, and
  // the click of the release does not choose it either.
  const phone = await openContext(browser, true);
  const phoneAttempt = await activeAttemptOf(phone.context);
  const phoneAnswers = trackPosts(phone.page, ANSWER_PATH);
  const phoneCard = card(phone.page, 'hoeren-1');
  await expectZones(optionLabel(phoneCard, 'a'));
  const tap = await wordBox(optionLabel(phoneCard, 'a'), 'Antwort');
  await phone.page.touchscreen.tap(tap.x, tap.y);
  await expect(cardOf(phone.page)).toHaveAttribute(
    'data-presentation',
    'sheet',
  );
  await expect(optionIn(phoneCard, 'a')).not.toBeChecked();
  expect(phoneAnswers).toEqual([]);
  await phone.page.getByTestId('dictionary-close').click();
  await expect(optionIn(phoneCard, 'a')).not.toBeChecked();
  await optionIn(phoneCard, 'a').tap();
  await expectStatus(phoneCard, 'saved');
  expect(phoneAnswers).toHaveLength(1);
  expect(await readAnswers(phoneAttempt.attemptId)).toEqual({
    'hoeren-1': 'a',
  });
  await phone.context.close();
});

test('blocks translator when disabled', async ({ browser }) => {
  const { context, page } = await openContext(browser);
  await goToLesen(page);
  await setTranslator(page, false);
  const lookups = trackPosts(page, LOOKUP_PATH);
  const paragraph = page.getByTestId('reading-paragraph-0');

  const word = await wordBox(paragraph, 'Anzeige');
  await page.mouse.dblclick(word.x, word.y);
  const zeile = await wordBox(paragraph, 'Zeile');
  await page.mouse.move(zeile.left + 1, zeile.y);
  await page.mouse.down();
  await page.mouse.move(zeile.right - 1, zeile.y, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(word.x, word.y);
  await page.waitForTimeout(900);
  await expect(cardOf(page)).toHaveCount(0);
  expect(lookups).toEqual([]);

  // Switched on again, the same word is translated.
  await setTranslator(page, true);
  const again = await wordBox(paragraph, 'Anzeige');
  await page.mouse.dblclick(again.x, again.y);
  await expect(wordOf(page)).toHaveText('Anzeige');
  await expect(translationOf(page)).toHaveText('test-en:Anzeige');
  expect(lookups.length).toBeGreaterThanOrEqual(1);

  // The keyboard path: select a word, then the one translate button.
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const button = page.getByTestId('dictionary-translate-selection');
  // The action is shown only while it has the focus: the keyboard reaches it.
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dictionary-selection-notice')).toBeVisible();
  await paragraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node?.textContent) throw new Error('no text');
    const index = node.textContent.indexOf('Zeile');
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 'Zeile'.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(wordOf(page)).toHaveText('Zeile');
  await expect(wordOf(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cardOf(page)).toBeHidden();
  await expect(button).toBeFocused();
  await context.close();
});

test('rejects unauthorized dictionary requests without mutation', async () => {
  const valid = await newGuest(depsNow());
  const expired = await newGuest(depsAt(new Date(Date.now() - 31 * DAY_MS)));
  const client: APIRequestContext = await request.newContext({
    baseURL: FULL_ORIGIN,
  });
  const cookieOf = (token: string) => `${GUEST_COOKIE}=${token}`;
  const post = (data: string, headers: Record<string, string>) =>
    client.post(DICTIONARY_PATH, {
      headers: { 'Content-Type': 'application/json', ...headers },
      data,
    });
  const guestScope = (sessionId: string) => `guest:${sessionId}`;

  const cases: {
    name: string;
    word: string;
    headers: Record<string, string>;
    status: number;
  }[] = [
    {
      name: 'no guest',
      word: freshWord('Ohnegast'),
      headers: { Origin: FULL_ORIGIN },
      status: 401,
    },
    {
      name: 'expired guest',
      word: freshWord('Abgelaufen'),
      headers: { Origin: FULL_ORIGIN, Cookie: cookieOf(expired.token) },
      status: 401,
    },
    {
      name: 'foreign origin',
      word: freshWord('Fremd'),
      headers: {
        Origin: 'https://evil.example',
        Cookie: cookieOf(valid.token),
      },
      status: 403,
    },
    {
      name: 'sibling origin',
      word: freshWord('Nachbar'),
      headers: {
        Origin: 'http://localhost:3100',
        Cookie: cookieOf(valid.token),
      },
      status: 403,
    },
    {
      name: 'missing origin',
      word: freshWord('Ohneherkunft'),
      headers: { Cookie: cookieOf(valid.token) },
      status: 403,
    },
    {
      name: 'wrong type',
      word: freshWord('Falschtyp'),
      headers: {
        Origin: FULL_ORIGIN,
        Cookie: cookieOf(valid.token),
        'Content-Type': 'text/plain',
      },
      status: 415,
    },
  ];
  for (const item of cases) {
    const response = await post(
      JSON.stringify({ word: item.word }),
      item.headers,
    );
    expect(response.status(), item.name).toBe(item.status);
    expect(await readCacheRows(item.word), item.name).toEqual([]);
  }

  const headers = { Origin: FULL_ORIGIN, Cookie: cookieOf(valid.token) };
  const extra = freshWord('Zusatz');
  const extraFields = await post(
    JSON.stringify({ word: extra, target: 'ru' }),
    headers,
  );
  expect(extraFields.status()).toBe(400);
  expect((await extraFields.json()).failure).toBe('invalid-input');
  expect(await readCacheRows(extra)).toEqual([]);

  const phrase = await post(JSON.stringify({ word: 'zwei Wörter' }), headers);
  expect(phrase.status()).toBe(400);
  expect((await phrase.json()).failure).toBe('invalid-word');

  const big = freshWord('Gross');
  const tooLarge = await post(
    JSON.stringify({ word: big, padding: 'x'.repeat(2000) }),
    headers,
  );
  expect(tooLarge.status()).toBe(413);
  const huge = await post(
    JSON.stringify({ word: big, padding: 'x'.repeat(70 * 1024) }),
    headers,
  );
  expect(huge.status()).toBe(413);
  expect(await readCacheRows(big)).toEqual([]);

  // Nothing above was charged to the guest or reached a provider.
  expect(await readBudget(guestScope(valid.guest.sessionId))).toBe(0);
  expect(await readBudget(guestScope(expired.guest.sessionId))).toBe(0);

  // The same guest with a proper request is served, privately.
  const word = freshWord('Erlaubt');
  const ok = await post(JSON.stringify({ word }), headers);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['cache-control']).toBe('private, no-store');
  const body = await ok.json();
  expect(body).toEqual({
    ok: true,
    entry: {
      word,
      target: 'en',
      translation: {
        state: 'found',
        text: `test-en:${word}`,
        alternatives: [],
      },
      lexical: { state: 'not-found', baseform: null, synonyms: [] },
    },
  });
  expect(JSON.stringify(body)).not.toContain(valid.guest.sessionId);
  expect(await readBudget(guestScope(valid.guest.sessionId))).toBe(1);
  await client.dispose();
});

test('denies direct database dictionary access', async () => {
  const word = freshWord('Geschuetzt');
  const now = new Date();
  const seeded = {
    provider: 'mymemory',
    version: 1,
    word,
    target: 'en',
    state: 'found',
    payload: { text: 'protected', alternatives: [] },
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + DAY_MS).toISOString(),
  };
  const insert = await serviceDb.from('dictionary_cache').insert(seeded);
  expect(insert.error).toBeNull();
  const guest = await newGuest(depsNow());

  const anon = createPublicClient();
  const reads = await Promise.all([
    anon.from('dictionary_cache').select('*').eq('word', word),
    anon.from('dictionary_budget').select('*').limit(1),
  ]);
  for (const read of reads) {
    expect(read.error?.code).toBe('42501');
    expect(read.data).toBeNull();
  }
  const writes = await Promise.all([
    anon.from('dictionary_cache').insert({ ...seeded, word: `${word}x` }),
    anon
      .from('dictionary_cache')
      .update({ payload: { text: 'hacked', alternatives: [] } })
      .eq('word', word),
    anon.from('dictionary_cache').delete().eq('word', word),
    anon
      .from('dictionary_budget')
      .insert({ scope: 'mymemory', window_start: now.toISOString(), used: 0 }),
    anon.from('dictionary_budget').delete().eq('scope', 'mymemory'),
  ]);
  for (const write of writes) expect(write.error?.code).toBe('42501');
  const rpcs = await Promise.all([
    anon.rpc('reserve_dictionary_budget', {
      p_session_id: guest.guest.sessionId,
      p_items: [{ scope: 'mymemory', window: 'day', cost: 1, limit: 1 }],
    }),
    anon.rpc('purge_dictionary_data', { p_now: now.toISOString() }),
  ]);
  for (const call of rpcs) expect(call.error).not.toBeNull();

  // authenticated has no right either, in the database itself.
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['dictionary_cache', 'dictionary_budget']) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        expect(
          psql(
            `select has_table_privilege(${quote(role)}, ${quote(`public.${table}`)}, ${quote(privilege)})`,
          ),
          `${role} ${privilege} ${table}`,
        ).toBe('f');
      }
    }
    for (const fn of [
      'public.reserve_dictionary_budget(uuid, jsonb)',
      'public.purge_dictionary_data(timestamptz)',
    ]) {
      expect(
        psql(
          `select has_function_privilege(${quote(role)}, ${quote(fn)}, 'execute')`,
        ),
      ).toBe('f');
    }
    expect(() =>
      psql(`set role ${role}; select count(*) from public.dictionary_cache;`),
    ).toThrow(/permission denied/);
  }
  expect(
    psql(`select count(*) from pg_proc p,
      aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      where x.grantee = 0
        and p.oid = 'public.reserve_dictionary_budget(uuid, jsonb)'::regprocedure`),
  ).toBe('0');
  expect(
    psql(`select bool_and(relrowsecurity) from pg_class
      where oid in ('public.dictionary_cache'::regclass,
        'public.dictionary_budget'::regclass)`),
  ).toBe('t');

  // The cached row is unchanged.
  const [row] = await readCacheRows(word);
  expect(row?.payload).toEqual({ text: 'protected', alternatives: [] });

  // The purge job exists next to the guest purge, and purging old data
  // keeps fresh rows and guest sessions.
  expect(
    psql(`select string_agg(jobname, ',' order by jobname) from cron.job
      where jobname in ('purge-dictionary-data',
        'purge-expired-empty-guest-sessions')`),
  ).toBe('purge-dictionary-data,purge-expired-empty-guest-sessions');
  const old = freshWord('Veraltet');
  const expiredRow = await serviceDb.from('dictionary_cache').insert({
    ...seeded,
    word: old,
    fetched_at: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
    expires_at: new Date(now.getTime() - DAY_MS).toISOString(),
  });
  expect(expiredRow.error).toBeNull();
  const purge = await serviceDb.rpc('purge_dictionary_data', {
    p_now: now.toISOString(),
  });
  expect(purge.error).toBeNull();
  expect(await readCacheRows(old)).toEqual([]);
  expect(await readCacheRows(word)).toHaveLength(1);
  const session = await serviceDb
    .from('guest_sessions')
    .select('id')
    .eq('id', guest.guest.sessionId);
  expect(session.data).toHaveLength(1);
});

test('dictionary preserves audio and Lesen reading anchor', async ({
  browser,
}) => {
  const { context, page } = await openContext(browser);
  const { attemptId } = await activeAttemptOf(context);
  await waitForPlayer(page);
  await playFrom(page, 5, 'dictionary');
  const playing = await snapshotOf(page);

  const prompt = card(page, 'hoeren-1').locator('h2');
  const frage = await wordBox(prompt, 'Frage');
  await page.mouse.move(frage.x, frage.y);
  await expect(wordOf(page)).toHaveText('Frage');
  await page.getByTestId('dictionary-speak').click();
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(frage.x, frage.y);
  await expect(wordOf(page)).toHaveText('Frage');
  await page.getByTestId('dictionary-close').click();
  await expect(cardOf(page)).toBeHidden();

  await expect
    .poll(async () => (await snapshotOf(page)).currentTime)
    .toBeGreaterThan(playing.currentTime + 0.5);
  const after = await snapshotOf(page);
  expect(after.paused).toBe(false);
  expect(after.isConnected).toBe(true);
  expect(after.marker).toBe('dictionary');

  // Lesen: the paragraph anchor of the long text survives the card.
  await goToLesen(page);
  await page.getByTestId(`go-to-question-${LONG_TASK}`).click();
  const reading = page.getByTestId('reading-text');
  const middle = page.getByTestId(`reading-paragraph-${PARAGRAPH}`);
  await middle.evaluate((element) =>
    element.scrollIntoView({ block: 'start' }),
  );
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);
  await expect
    .poll(async () => JSON.stringify(await readProgress(attemptId)))
    .toContain(`"paragraph":${PARAGRAPH}`);

  const lesetext = await wordBox(middle, 'Lesetext');
  await page.mouse.dblclick(lesetext.x, lesetext.y);
  await expect(wordOf(page)).toHaveText('Lesetext');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(lesetext.x, lesetext.y + 2);
  await expect(wordOf(page)).toHaveText('Lesetext');
  await page.getByTestId('dictionary-close').click();
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);
  await expect(middle).toBeInViewport();
  await page.waitForTimeout(800);
  expect(JSON.stringify(await readProgress(attemptId))).toContain(
    `"paragraph":${PARAGRAPH}`,
  );
  // Lesen paused the recording at its place; the element and the marker of
  // the guest survived the dictionary and the block change.
  const onLesen = await snapshotOf(page);
  expect(onLesen.paused).toBe(true);
  expect(onLesen.isConnected).toBe(true);
  expect(onLesen.marker).toBe('dictionary');
  expect(onLesen.currentTime).toBeGreaterThanOrEqual(after.currentTime);
  await context.close();
});

test('synonym opens its own lookup', async ({ browser }) => {
  const { context, page } = await openContext(browser);
  await goToLesen(page);
  const lookups = trackPosts(page, LOOKUP_PATH);
  const paragraph = page.getByTestId('reading-paragraph-0');
  const anzeige = await wordBox(paragraph, 'Anzeige');
  await page.mouse.dblclick(anzeige.x, anzeige.y);
  await expect(translationOf(page)).toHaveText('test-en:Anzeige');
  const synonyms = page.getByTestId('dictionary-synonym');
  await expect(synonyms).toHaveText(['Inserat', 'Annonce']);

  await synonyms.filter({ hasText: 'Inserat' }).click();
  await expect(wordOf(page)).toHaveText('Inserat');
  await expect(translationOf(page)).toHaveText('test-en:Inserat');
  await expect(cardOf(page)).not.toContainText('test-en:Anzeige');
  expect(lookups.length).toBe(2);
  await page.keyboard.press('Escape');

  // The guest switches to Russian: the same word is looked up in RU, from
  // its own cache key.
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  const again = await wordBox(paragraph, 'Anzeige');
  await page.mouse.dblclick(again.x, again.y);
  await expect(translationOf(page)).toHaveText('test-ru:Anzeige');
  await expect(translationOf(page)).toHaveAttribute('lang', 'ru');
  const rows = await readCacheRows('Anzeige');
  const targets = rows
    .filter((row) => row.provider === 'mymemory')
    .map((row) => row.target)
    .sort();
  expect(targets).toEqual(['en', 'ru']);
  await context.close();
});

// --- A selected phrase and the external Google Translate page (#120) -------

// Selects the whole content of an element, as a guest's handles might.
const selectContents = (locator: Locator) =>
  locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

const toRussian = async (page: Page) => {
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
};

test('selected German phrase opens external Google Translate only on activation', async ({
  browser,
}) => {
  const { context, page } = await openContext(browser, true);
  const google = await stubGoogle(context);
  const { attemptId } = await activeAttemptOf(context);
  const answers = trackPosts(page, ANSWER_PATH);
  const lookups = trackPosts(page, LOOKUP_PATH);
  await goToLesen(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  await expectZones(paragraph);
  const action = page.getByTestId(GOOGLE_PHRASE);
  await expect(action).toHaveCount(0);
  let tabs = 0;
  context.on('page', () => {
    tabs += 1;
  });

  // A long press starts the native selection; the handles extend it over
  // several words of the same text.
  const start = await wordBox(paragraph, 'Anzeige');
  await holdTouch(page, start, HOLD_MS);
  await selectRange(paragraph, 'Anzeige zu Teil 1');
  await expect(action).toBeVisible();
  const english =
    'https://translate.google.com/?sl=de&tl=en&text=Anzeige%20zu%20Teil%201&op=translate';
  await expect(action).toHaveAttribute('href', english);
  await expect(action).toHaveAttribute('target', '_blank');
  await expect(action).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(action).toHaveAccessibleName(/Google/);
  // The selection is still the browser's, and nothing has left the page.
  await page.waitForTimeout(800);
  expect(await selectedText(page)).toBe('Anzeige zu Teil 1');
  await expect(cardOf(page)).toHaveCount(0);
  expect(google).toEqual([]);
  expect(tabs).toBe(0);
  expect(lookups).toEqual([]);

  // Only the activation opens exactly this text, in a new tab.
  const opened = context.waitForEvent('page');
  await action.tap();
  const tab = await opened;
  await expect.poll(() => google).toEqual([english]);
  expect(tab.url()).toBe(english);
  await tab.close();
  expect(lookups).toEqual([]);
  await clearSelection(page);

  // Umlauts, brackets and the Russian interface: the gap text of Teil 5.
  await toRussian(page);
  await goToStep(page, 20);
  const gap = page.getByTestId('reading-paragraph-0');
  await expectZones(gap);
  await selectRange(gap, 'eine Lücke [40] im Satz.');
  const russian =
    'https://translate.google.com/?sl=de&tl=ru&text=eine%20L%C3%BCcke%20%5B40%5D%20im%20Satz.&op=translate';
  await expect(action).toHaveAttribute('href', russian);
  await page.waitForTimeout(500);
  expect(google).toEqual([english]);
  expect(lookups).toEqual([]);

  // A bottom sheet left open by an earlier tap does not hide the action: a
  // new phrase selection closes the sheet and offers the link. Only the tap
  // on the single word was looked up, never the phrase.
  await clearSelection(page);
  const brief = await wordBox(gap, 'Brief');
  await page.touchscreen.tap(brief.x, brief.y);
  await expect(cardOf(page)).toHaveAttribute('data-presentation', 'sheet');
  await expect(wordOf(page)).toHaveText('Brief');
  await expect(action).toHaveCount(0);
  await selectRange(gap, 'Brief hat eine');
  await expect(action).toBeVisible();
  await expect(cardOf(page)).toHaveCount(0);
  await expect(action).toHaveAttribute(
    'href',
    'https://translate.google.com/?sl=de&tl=ru&text=Brief%20hat%20eine&op=translate',
  );
  await page.waitForTimeout(500);
  expect(google).toEqual([english]);
  expect(lookups).toHaveLength(1);
  expect(answers).toEqual([]);
  expect(await readAnswers(attemptId)).toEqual({});
  await context.close();
});

test('Google link carries the selected phrase exactly including line breaks', async ({
  browser,
}) => {
  const { context, page } = await openContext(browser, true);
  const google = await stubGoogle(context);
  const lookups = trackPosts(page, LOOKUP_PATH);
  const answers = trackPosts(page, ANSWER_PATH);
  await goToLesen(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  await expectZones(paragraph);

  // Two lines of the pre-wrapped reading text: the selection holds a real
  // line break, which a rewriting of the text would turn into a space.
  await selectRange(paragraph, 'Zeile 1', paragraph, 'Zeile 2');
  const selected = await selectedText(page);
  expect(selected).toBe('Zeile 1\nAnzeige zu Teil 1, Zeile 2');
  const action = page.getByTestId(GOOGLE_PHRASE);
  await expect(action).toBeVisible();
  const expected =
    'https://translate.google.com/?sl=de&tl=en&text=Zeile%201%0AAnzeige%20zu%20Teil%201%2C%20Zeile%202&op=translate';
  await expect(action).toHaveAttribute('href', expected);
  expect(google).toEqual([]);

  const opened = context.waitForEvent('page');
  await action.tap();
  const tab = await opened;
  await expect.poll(() => google).toEqual([expected]);
  expect(new URL(tab.url()).searchParams.get('text')).toBe(selected);
  await tab.close();
  expect(lookups).toEqual([]);
  expect(answers).toEqual([]);
  await context.close();
});

test('invalid or out of scope selection never offers external translation', async ({
  browser,
}) => {
  const { context, page } = await openContext(browser, true);
  const google = await stubGoogle(context);
  const lookups = trackPosts(page, LOOKUP_PATH);
  await goToLesen(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  await expectZones(paragraph);
  let tabs = 0;
  context.on('page', () => {
    tabs += 1;
  });
  const action = page.getByTestId(GOOGLE_PHRASE);
  const expectNoAction = async (step: string) => {
    await page.waitForTimeout(400);
    await expect(action, step).toHaveCount(0);
    await expect(cardOf(page), step).toHaveCount(0);
  };

  // An empty selection: a caret inside the text.
  await paragraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) throw new Error('no text');
    const range = document.createRange();
    range.setStart(node, 3);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expectNoAction('caret');

  // Outside the German zones: the exam title of the page header and the
  // interface hint inside the boundary.
  await selectContents(page.getByTestId('exam-context-title'));
  await expectNoAction('outside the boundary');
  await selectContents(page.getByTestId('dictionary-touch-hint'));
  await expectNoAction('interface text');

  // Across two zones: from the title of the text into its first paragraph.
  await selectRange(
    page.getByTestId('reading-text').locator('h2'),
    'Text zu',
    paragraph,
    'Anzeige zu',
  );
  await expectNoAction('two zones');

  // More than 300 code points inside one zone (added in this test's DOM
  // only; the material is never touched).
  const zone = paragraph.locator('[data-dictionary-text]').first();
  await zone.evaluate((element) => {
    element.append(
      document.createTextNode(` ${'Straßenbahnhaltestelle '.repeat(16)}`),
    );
  });
  await selectContents(zone);
  expect([...(await selectedText(page))].length).toBeGreaterThan(300);
  await expectNoAction('too long');

  // A valid phrase is offered; with the translator off it is not.
  await selectRange(paragraph, 'Anzeige zu Teil 1');
  await expect(action).toBeVisible();
  await toggleOf(page).tap();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(action).toHaveCount(0);
  await selectRange(paragraph, 'Anzeige zu Teil 1');
  await expectNoAction('translator off');
  expect(await selectedText(page)).toBe('Anzeige zu Teil 1');

  expect(google).toEqual([]);
  expect(tabs).toBe(0);
  expect(lookups).toEqual([]);
  await context.close();
});

test('dictionary keeps desktop word selection and mobile answer safety', async ({
  browser,
}) => {
  const desktop = await openContext(browser);
  const { page } = desktop;
  const google = await stubGoogle(desktop.context);
  const target = card(page, 'hoeren-1');
  const prompt = target.locator('h2');
  await expectZones(prompt);
  // No phone hint on a mouse screen.
  await expect(page.getByTestId('dictionary-touch-hint')).toBeHidden();

  // Hover: a non-modal card beside the word, named by its title.
  const frage = await wordBox(prompt, 'Frage');
  await page.mouse.move(frage.x, frage.y);
  await expect(wordOf(page)).toHaveText('Frage');
  const popper = cardOf(page);
  await expect(popper).toHaveAttribute('data-presentation', 'popper');
  await expect(popper).toHaveAttribute('role', 'dialog');
  await expect(popper).toHaveAttribute('aria-modal', 'false');
  await expect(popper).toHaveAccessibleName(/Frage/);
  await page.keyboard.press('Escape');
  await expect(popper).toBeHidden();
  await page.mouse.move(5, 5);

  // One word selected with the mouse: its card, no external phrase action.
  await page.mouse.move(frage.left + 1, frage.y);
  await page.mouse.down();
  await page.mouse.move(frage.right - 1, frage.y, { steps: 5 });
  await page.mouse.up();
  await expect(wordOf(page)).toHaveText('Frage');
  await expect(page.getByTestId(GOOGLE_PHRASE)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // Keyboard: the translate action takes a selected word, Escape returns
  // the focus; the switch keeps its name and state.
  await selectRange(prompt, 'Frage');
  const translate = page.getByTestId('dictionary-translate-selection');
  await translate.focus();
  await page.keyboard.press('Enter');
  await expect(wordOf(page)).toHaveText('Frage');
  await page.keyboard.press('Escape');
  await expect(translate).toBeFocused();
  await expect(toggleOf(page)).toHaveAccessibleName(/\S/);
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'true');

  // The phrase action is a link the keyboard reaches; focus alone goes
  // nowhere, Enter opens the page.
  await selectRange(prompt, 'Frage 1 (hoeren');
  const phrase = page.getByTestId(GOOGLE_PHRASE);
  await expect(phrase).toBeVisible();
  await expect(phrase).toHaveAccessibleName(/Google/);
  await phrase.focus();
  await expect(phrase).toBeFocused();
  await page.waitForTimeout(400);
  expect(google).toEqual([]);
  const opened = desktop.context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const tab = await opened;
  await expect.poll(() => google.length).toBe(1);
  expect(tab.url()).toContain('tl=en');
  expect(tab.url()).toContain('text=Frage%201%20(hoeren');
  await tab.close();
  await desktop.context.close();

  // Phone: a tap on a word of an option opens its sheet and leaves the
  // answer; the radio itself then chooses it at once.
  const phone = await openContext(browser, true);
  const answers = trackPosts(phone.page, ANSWER_PATH);
  const lookups = trackPosts(phone.page, LOOKUP_PATH);
  const { attemptId } = await activeAttemptOf(phone.context);
  const phoneCard = card(phone.page, 'hoeren-1');
  await expectZones(optionLabel(phoneCard, 'c'));
  const word = await wordBox(optionLabel(phoneCard, 'c'), 'Antwort');
  await phone.page.touchscreen.tap(word.x, word.y);
  await expect(cardOf(phone.page)).toHaveAttribute(
    'data-presentation',
    'sheet',
  );
  await expect(optionIn(phoneCard, 'c')).not.toBeChecked();
  await phone.page.waitForTimeout(400);
  expect(answers).toEqual([]);
  expect(lookups).toHaveLength(1);
  await phone.page.getByTestId('dictionary-close').click();
  await optionIn(phoneCard, 'c').tap();
  await expectStatus(phoneCard, 'saved');
  expect(answers).toHaveLength(1);
  expect(lookups).toHaveLength(1);
  expect(await readAnswers(attemptId)).toEqual({ 'hoeren-1': 'c' });
  await phone.context.close();
});
