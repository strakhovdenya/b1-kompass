import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readSessionByToken,
  serviceDb,
  startFor,
} from './support/db';
import { FULL_PILOT, publishUniqueFullExam } from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  ANSWER_URL,
  LESEN_URL,
  attemptLesenUrl,
  enterAndStart,
} from './support/guest-browser';
import { goToStep } from './support/release';

// The synthetic full set: lesen-1..5 Teil 1, 6..10 Teil 2 (nine options),
// 11..16 Teil 3 (the long text), 17..19 Teil 4, 20..25 Teil 5 (gap marks).
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };
const PARAGRAPH = 12;
const LONG_TASK = 11;

const TEILE = [
  { first: 1, last: 5, options: 3 },
  { first: 6, last: 10, options: 9 },
  { first: 11, last: 16, options: 2 },
  { first: 17, last: 19, options: 2 },
  { first: 20, last: 25, options: 3 },
];

const card = (page: Page, questionId: string): Locator =>
  page.getByTestId(`question-card-${questionId}`);

const optionIn = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator(`input[value="${optionId}"]`);

const statusOf = (cardLocator: Locator) =>
  cardLocator.getByTestId('save-status');

const goTo = goToStep;

const openGuest = async (browser: Browser) => {
  const context = await browser.newContext({ viewport: WIDE });
  const page = await context.newPage();
  await enterAndStart(page);
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL(LESEN_URL);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  return { context, page };
};

const attemptOf = async (context: BrowserContext) => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  const session = await readSessionByToken(cookie.value);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt) {
    throw new Error('one attempt expected');
  }
  return attempt;
};

const choose = async (page: Page, questionId: string, optionId: string) => {
  const target = card(page, questionId);
  await optionIn(target, optionId).check();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'saved');
};

const showTask = (page: Page) =>
  page.getByTestId('lesen-view-questions').click();

test('lesen renders complete linked source materials', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  for (const [index, teil] of TEILE.entries()) {
    for (let number = teil.first; number <= teil.last; number++) {
      await goTo(page, number);
      const target = card(page, `lesen-${number}`);
      await expect(target).toBeVisible();
      await expect(target.locator('input[type="radio"]')).toHaveCount(
        teil.options,
      );
      const reading = page.getByTestId('reading-text');
      await expect(reading).toHaveAttribute(
        'data-text-id',
        `lesen-text-${index + 1}`,
      );
      await expect(reading).toContainText(`Text zu Teil ${index + 1}`);
    }
  }

  await goTo(page, 6);
  const lines = page.getByTestId('reading-paragraph-0');
  await expect(lines).toHaveCSS('white-space', 'pre-wrap');
  expect(await lines.evaluate((e) => (e as HTMLElement).innerText)).toContain(
    'a) Anzeige a\nb) Anzeige b',
  );
  for (const id of ['a', 'h', 'x']) {
    await expect(optionIn(card(page, 'lesen-6'), id)).toBeVisible();
  }

  await goTo(page, 20);
  for (const mark of [40, 41, 42, 43, 44, 45]) {
    await expect(page.getByTestId('reading-text')).toContainText(`[${mark}]`);
  }
  await goTo(page, 17);
  const labels = card(page, 'lesen-17').locator('label');
  await expect(labels).toContainText(['Richtig', 'Falsch']);
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({});
  await context.close();
});

test('lesen state carries texts without answer keys', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  // The real Lesen page of the guest's own attempt, by its own address.
  const response = await context.request.get(new URL(page.url()).pathname, {
    maxRedirects: 0,
  });
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('Langer Lesetext zu Teil 3');
  expect(html).toContain('[45]');
  expect(html).not.toContain('correctOptionId');
  expect(html).not.toContain('correct_option_id');
  expect(html).not.toContain('solutionOptionId');
  expect(await page.content()).not.toContain('correctOptionId');
  await context.close();
});

test('responsive reading preserves selection', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(card(page, 'lesen-1')).toBeVisible();
  await choose(page, 'lesen-1', 'b');

  await page.setViewportSize(NARROW);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(card(page, 'lesen-1')).toBeHidden();
  await showTask(page);
  await expect(card(page, 'lesen-1')).toBeVisible();
  await expect(page.getByTestId('reading-text')).toBeHidden();
  await expect(optionIn(card(page, 'lesen-1'), 'b')).toBeChecked();

  await page.setViewportSize(WIDE);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  await expect(optionIn(card(page, 'lesen-1'), 'b')).toBeChecked();
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    'lesen-1': 'b',
  });
  await context.close();
});

test('responsive transition preserves unrelated answers', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  await choose(page, 'lesen-1', 'a');
  await goTo(page, 2);
  await choose(page, 'lesen-2', 'b');
  await choose(page, 'lesen-2', 'c');

  await page.setViewportSize(NARROW);
  await showTask(page);
  await expect(optionIn(card(page, 'lesen-2'), 'c')).toBeChecked();
  await goTo(page, 1);
  await expect(optionIn(card(page, 'lesen-1'), 'a')).toBeChecked();

  await page.setViewportSize(WIDE);
  await goTo(page, 2);
  await expect(optionIn(card(page, 'lesen-2'), 'c')).toBeChecked();
  await goTo(page, 1);
  await expect(optionIn(card(page, 'lesen-1'), 'a')).toBeChecked();
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    'lesen-1': 'a',
    'lesen-2': 'c',
  });
  await context.close();
});

test('failed save survives layout switch', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await context.route(ANSWER_URL, (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  const target = card(page, 'lesen-1');
  await optionIn(target, 'b').check();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  const attempt = await attemptOf(context);
  expect(await readAnswers(attempt.id)).toEqual({});

  await page.setViewportSize(NARROW);
  await showTask(page);
  await expect(optionIn(target, 'b')).toBeChecked();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  await expect(statusOf(target).getByRole('button')).toBeVisible();

  await page.setViewportSize(WIDE);
  await expect(statusOf(target)).toHaveAttribute('data-status', 'error');
  await expect(optionIn(target, 'b')).toBeChecked();
  await expect(statusOf(target).getByRole('button')).toBeVisible();

  await context.unroute(ANSWER_URL);
  await statusOf(target).getByRole('button').click();
  await expect(statusOf(target)).toHaveAttribute('data-status', 'saved');
  expect(await readAnswers(attempt.id)).toEqual({ 'lesen-1': 'b' });
  await context.close();
});

test('long reading preserves anchor across viewport changes', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  await goTo(page, LONG_TASK);
  await choose(page, `lesen-${LONG_TASK}`, 'b');

  await page.setViewportSize(NARROW);
  const reading = page.getByTestId('reading-text');
  const middle = page.getByTestId(`reading-paragraph-${PARAGRAPH}`);
  await middle.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);

  await page.setViewportSize(WIDE);
  await expect(middle).toBeInViewport();
  await expect(page.getByTestId('reading-paragraph-0')).not.toBeInViewport();
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);

  await page.setViewportSize(NARROW);
  await expect(middle).toBeInViewport();
  await expect(reading).toHaveAttribute('data-anchor', `${PARAGRAPH}`);

  await showTask(page);
  await expect(optionIn(card(page, `lesen-${LONG_TASK}`), 'b')).toBeChecked();
  await page.getByTestId('lesen-view-text').click();
  await expect(middle).toBeInViewport();
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    [`lesen-${LONG_TASK}`]: 'b',
  });
  await context.close();
});

// Teil 2 ads (#105): the synthetic Teil 2 text is one paragraph of its own, so
// these tests publish a full set whose Teil 2 text is a list of ads a-h with
// a long web and e-mail address, through the real owner path.
const ADS = [
  'a Fahrschule Theiss, Überring 362, 50678 Köln\nwww.fahrschule-theiss.de',
  'b Verkaufe gebrauchtes Fahrrad, 80 Euro. Anruf: 0221 1234567',
  'c Wohnungsverwaltung: verwaltung-sehr-langer-name@beispiel-gesellschaft-fuer-wohnungsverwaltung.example.de',
  'd Neue Abendkurse für Anfänger und Fortgeschrittene in der Volkshochschule',
  'e Zimmer frei ab dem ersten des Monats',
  'f Gitarrenunterricht für Kinder und Erwachsene',
  'g Umzugshilfe zu fairen Preisen, auch am Wochenende',
  'h Nachhilfe in Mathematik und Physik, Klasse fünf bis zehn',
];
const AD_QUESTION = 6;
const AD_TEIL_2_TEXT_ID = 'lesen-text-2';
const AD_ORIGIN = 'http://localhost:3102';
const AD_MATERIAL = {
  content: {
    ...FULL_PILOT.content,
    texts: (FULL_PILOT.content.texts ?? []).map((item) =>
      item.id === AD_TEIL_2_TEXT_ID
        ? { ...item, body: ADS.join('\n\n') }
        : item,
    ),
  },
  keys: FULL_PILOT.keys,
};

const openAds = async (browser: Browser, viewport: typeof WIDE) => {
  const exam = await publishUniqueFullExam(
    serviceDb,
    createTestRecording(),
    `Ads ${Date.now()}`,
    undefined,
    AD_MATERIAL,
  );
  const created = await newGuest(depsNow());
  const started = await startFor(depsNow(), created.token, exam.slug);
  if (!started.ok) throw new Error(`start failed: ${started.failure}`);
  const path = attemptLesenUrl(exam.slug, started.result.attemptId);
  const context = await browser.newContext({ baseURL: AD_ORIGIN, viewport });
  await context.addCookies([
    { name: GUEST_COOKIE, value: created.token, url: AD_ORIGIN },
  ]);
  const page = await context.newPage();
  await page.goto(path);
  await goTo(page, AD_QUESTION);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  return { context, page, path };
};

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const boxesOf = (page: Page, selector: string): Promise<Box[]> =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const { top, bottom, left, right } = node.getBoundingClientRect();
      return { top, bottom, left, right };
    }),
  );

const AD_BLOCKS = '[data-ad-letter]';
const AD_BADGES = '[data-testid^="ad-letter-"]';

test('teil 2 ads are separated blocks on a narrow screen', async ({
  browser,
}) => {
  const { context, page } = await openAds(browser, { width: 360, height: 800 });
  const blocks = page.locator(AD_BLOCKS);
  await expect(blocks).toHaveCount(ADS.length);
  for (let i = 0; i < ADS.length; i++) {
    const block = blocks.nth(i);
    await expect(block).toHaveCSS('border-top-width', '1px');
    await expect(block).toHaveCSS('border-top-style', 'solid');
    await expect(block).toHaveAttribute('data-ad-letter', 'abcdefgh'[i] ?? '');
  }
  const boxes = await boxesOf(page, AD_BLOCKS);
  for (let i = 1; i < boxes.length; i++) {
    const gap = (boxes[i]?.top ?? 0) - (boxes[i - 1]?.bottom ?? 0);
    expect(gap).toBeGreaterThanOrEqual(8);
  }
  const overflow = await page.getByTestId('reading-text').evaluate((node) => ({
    panel: node.scrollWidth - node.clientWidth,
    page:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(overflow.panel).toBeLessThanOrEqual(0);
  expect(overflow.page).toBeLessThanOrEqual(0);
  await context.close();
});

test('page disables phone and address detection', async ({ browser }) => {
  const { context, page } = await openAds(browser, NARROW);
  const content = await page
    .locator('meta[name="format-detection"]')
    .getAttribute('content');
  expect(content).toContain('telephone=no');
  expect(content).toContain('address=no');
  await context.close();
});

test('hyphenation is off only in teil 2 ads', async ({ browser }) => {
  const { context, page } = await openAds(browser, NARROW);
  await expect(page.getByTestId('ad-text-0')).toHaveCSS('hyphens', 'none');
  await goTo(page, 1);
  await expect(page.getByTestId('reading-paragraph-0')).toHaveCSS(
    'hyphens',
    'auto',
  );
  await context.close();
});

test('teil 2 ad blocks add no answer keys to the page', async ({ browser }) => {
  const { context, page, path } = await openAds(browser, WIDE);
  const html = await (await context.request.get(path)).text();
  expect(html).toContain('data-ad-letter');
  expect(html).not.toContain('correctOptionId');
  expect(html).not.toContain('correct_option_id');
  expect(html).not.toContain('solutionOptionId');
  expect(await page.content()).not.toContain('correctOptionId');
  await context.close();
});

// Owner request on top of the Issue (not an acceptance criterion): the same
// component is as clear on a 1440 px desktop as on a phone.
for (const viewport of [WIDE, NARROW]) {
  test(`teil 2 ads stay aligned blocks at ${viewport.width} px`, async ({
    browser,
  }) => {
    const { context, page } = await openAds(browser, viewport);
    const blocks = await boxesOf(page, AD_BLOCKS);
    const badges = await boxesOf(page, AD_BADGES);
    expect(blocks).toHaveLength(ADS.length);
    expect(badges).toHaveLength(ADS.length);
    // Blocks never overlap and their badges share one left edge.
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]?.top ?? 0).toBeGreaterThan(blocks[i - 1]?.bottom ?? 0);
    }
    expect(new Set(badges.map((box) => Math.round(box.left))).size).toBe(1);
    // The text stays inside its block.
    const texts = await boxesOf(page, '[data-testid^="ad-text-"]');
    texts.forEach((box, i) => {
      expect(box.right).toBeLessThanOrEqual((blocks[i]?.right ?? 0) + 0.5);
    });
    // Nothing runs out sideways, and the task card keeps its width.
    const overflow = await page
      .getByTestId('reading-text')
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (viewport.width > NARROW.width) {
      const task = await page
        .getByTestId(`question-card-lesen-${AD_QUESTION}`)
        .boundingBox();
      expect(task?.width ?? 0).toBeGreaterThan(300);
    }
    // The last ad can be scrolled to: the anchors of the blocks work.
    const last = page.getByTestId(`reading-paragraph-${ADS.length - 1}`);
    await last.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await expect(last).toBeInViewport();
    await context.close();
  });
}

// --- The hint about switching between text and task (#119) ------------------

const NARROWEST = { width: 320, height: 640 };
const HINT = 'lesen-narrow-hint';

const openLesenAt = async (
  browser: Browser,
  viewport: { width: number; height: number },
) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await enterAndStart(page);
  await page.getByTestId('block-link-lesen').click();
  await page.waitForURL(LESEN_URL);
  await expect(page.getByTestId('reading-text')).toBeVisible();
  return { context, page };
};

test('reading mode hint appears only on a narrow screen', async ({
  browser,
}) => {
  const narrow = await openLesenAt(browser, NARROW);
  const hint = narrow.page.getByTestId(HINT);
  await expect(hint).toBeVisible();
  await expect(hint).not.toBeEmpty();
  // The buttons the hint names are on the screen with it.
  await expect(narrow.page.getByTestId('lesen-view-text')).toBeVisible();
  const english = await hint.innerText();
  await narrow.page.getByTestId('locale-ru').click();
  await expect(narrow.page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(hint).toBeVisible();
  expect(await hint.innerText()).not.toBe(english);
  await narrow.context.close();

  const wide = await openLesenAt(browser, WIDE);
  // Out of the layout and out of the reading order of a screen reader.
  await expect(wide.page.getByTestId(HINT)).toBeHidden();
  await expect(wide.page.getByTestId('lesen-view-text')).toBeHidden();
  await wide.context.close();
});

test('desktop reading keeps two columns without narrow hint', async ({
  browser,
}) => {
  const wide = await openLesenAt(browser, WIDE);
  await expect(wide.page.getByTestId(HINT)).toBeHidden();
  const text = await wide.page.getByTestId('reading-text').boundingBox();
  const task = await wide.page
    .getByTestId('question-card-lesen-1')
    .boundingBox();
  if (!text || !task) throw new Error('the text and the task need boxes');
  // Side by side: the task starts where the text ends, near the same top.
  expect(task.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
  expect(Math.abs(task.y - text.y)).toBeLessThan(200);
  await wide.context.close();

  // The narrowest phone: the hint and the text stay inside the page.
  const narrow = await openLesenAt(browser, NARROWEST);
  await expect(narrow.page.getByTestId(HINT)).toBeVisible();
  const widths = await narrow.page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBe(widths.client);
  const hintBox = await narrow.page.getByTestId(HINT).boundingBox();
  expect((hintBox?.x ?? 0) + (hintBox?.width ?? 0)).toBeLessThanOrEqual(
    NARROWEST.width,
  );
  await narrow.context.close();
});

// --- The jump from the end of a long text to its task (#120) ---------------

const JUMP = 'lesen-jump-to-question';

// The reading position of the text after the page has stopped moving: the
// anchor follows the scroll events of the page, so it is read only when two
// reads, a moment apart, agree.
const settledAnchor = async (reading: Locator): Promise<string> => {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const current = await reading.getAttribute('data-anchor');
        const isSettled = current !== null && current === previous;
        previous = current;
        return isSettled;
      },
      { intervals: [250] },
    )
    .toBe(true);
  return previous ?? '';
};
const LAST_PARAGRAPH = 23;

const answerPosts = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() !== 'POST') return;
    if (/\/api\/attempts\/[^/]+\/answer$/.test(new URL(sent.url()).pathname)) {
      seen.push(sent.url());
    }
  });
  return seen;
};

test('long mobile reading offers direct jump from text to question', async ({
  browser,
}) => {
  const { context, page } = await openLesenAt(browser, NARROW);
  await goTo(page, LONG_TASK);
  const reading = page.getByTestId('reading-text');
  const task = card(page, `lesen-${LONG_TASK}`);
  await showTask(page);
  await choose(page, `lesen-${LONG_TASK}`, 'b');
  const answers = answerPosts(page);
  await page.getByTestId('lesen-view-text').click();
  await expect(reading).toBeVisible();

  // At the end of the long text the jump is right there, on the phone only.
  const last = page.getByTestId(`reading-paragraph-${LAST_PARAGRAPH}`);
  await last.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  const jump = page.getByTestId(JUMP);
  await expect(jump).toBeVisible();
  await jump.evaluate((node) => node.scrollIntoView({ block: 'nearest' }));
  await expect(jump).toBeInViewport();
  const box = await jump.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  const anchor = await settledAnchor(reading);
  expect(Number(anchor)).toBeGreaterThan(PARAGRAPH);
  const english = await jump.innerText();

  // The jump switches the existing view: the task shows from its start,
  // takes the focus, keeps the confirmed answer and sends nothing.
  await jump.click();
  await expect(page.getByTestId('lesen-view-questions')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(reading).toBeHidden();
  await expect(task).toBeInViewport();
  await expect(page.getByTestId('lesen-view-text')).toBeInViewport();
  await expect(page.getByTestId('lesen-task')).toBeFocused();
  await expect(optionIn(task, 'b')).toBeChecked();
  await expect(statusOf(task)).toHaveAttribute('data-status', 'saved');

  // Back to the text: the same place in it.
  await page.getByTestId('lesen-view-text').click();
  await expect(reading).toHaveAttribute('data-anchor', anchor ?? '');
  await expect(
    page.getByTestId(`reading-paragraph-${anchor ?? ''}`),
  ).toBeInViewport();

  // The label is localized.
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByTestId(JUMP)).not.toHaveText(english);
  expect(answers).toEqual([]);
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    [`lesen-${LONG_TASK}`]: 'b',
  });
  await context.close();
});

test('desktop reading omits jump and phone keeps selection and anchor', async ({
  browser,
}) => {
  // Desktop: two columns, no jump, the task beside the text.
  const wide = await openLesenAt(browser, WIDE);
  await goTo(wide.page, LONG_TASK);
  // The controls exist in the page (a renamed test id would not pass for
  // "hidden") and are not shown on the desktop layout.
  for (const testId of [JUMP, 'lesen-view-text', 'lesen-view-questions']) {
    await expect(wide.page.getByTestId(testId)).toBeAttached();
    await expect(wide.page.getByTestId(testId)).toBeHidden();
  }
  const text = await wide.page.getByTestId('reading-text').boundingBox();
  const side = await card(wide.page, `lesen-${LONG_TASK}`).boundingBox();
  if (!text || !side) throw new Error('the text and the task need boxes');
  expect(side.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
  await wide.context.close();

  // Phone: text → task → text → task keeps the reading place, the answer,
  // and sends the answer once. The reader scrolls to the end of the text,
  // where the jump is, and the place they stopped at is what comes back.
  const { context, page } = await openLesenAt(browser, NARROW);
  const answers = answerPosts(page);
  await goTo(page, LONG_TASK);
  const reading = page.getByTestId('reading-text');
  const jump = page.getByTestId(JUMP);
  const task = card(page, `lesen-${LONG_TASK}`);
  let expectedAnswers = 0;

  for (const optionId of ['a', 'a']) {
    await jump.evaluate((node) => node.scrollIntoView({ block: 'nearest' }));
    await expect(jump).toBeInViewport();
    const anchor = await settledAnchor(reading);
    expect(Number(anchor)).toBeGreaterThan(PARAGRAPH);

    await jump.click();
    await expect(task).toBeInViewport();
    if (expectedAnswers === 0) {
      await choose(page, `lesen-${LONG_TASK}`, optionId);
      expectedAnswers = 1;
    }
    await expect(optionIn(task, optionId)).toBeChecked();
    await expect(statusOf(task)).toHaveAttribute('data-status', 'saved');
    await page.waitForTimeout(500);
    expect(answers).toHaveLength(expectedAnswers);

    await page.getByTestId('lesen-view-text').click();
    await expect(reading).toHaveAttribute('data-anchor', anchor);
    await expect(
      page.getByTestId(`reading-paragraph-${anchor}`),
    ).toBeInViewport();
  }
  expect(await readAnswers((await attemptOf(context)).id)).toEqual({
    [`lesen-${LONG_TASK}`]: 'a',
  });
  await context.close();
});
