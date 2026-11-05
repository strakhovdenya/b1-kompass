import { devices, expect, test } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';
import { fullKeyOf, fullWrongOf } from './support/full-exam';
import { readAnswers } from './support/db';
import {
  HOEREN_URL,
  activeAttemptOf,
  audioOf,
  card,
  enterAndStart,
  enterAtChoice,
  expectStatus,
  finishFromShell,
  goToHoeren,
  goToLesen,
  optionIn,
  playFrom,
  snapshotOf,
  waitForPlayer,
} from './support/guest-browser';
import {
  expectUsableLayout,
  expectVisibleFocus,
  goToStep,
  openGuestPage,
  tabTo,
} from './support/release';

// Mobile-first learning screens on the synthetic full set (20 Hören with
// pairs and a shared set, 25 Lesen): the recording that belongs to Hören, one
// translator switch in the header, readable German text, comfortable answer
// rows and one compact navigator. Locators use test ids, never translations;
// German words of the material are matched as text (they are never
// translated).

const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 375, height: 667 };
const NARROWEST = { width: 320, height: 640 };
const DESKTOP = { width: 1440, height: 900 };
const LOOKUP_PATH = /^\/api\/dictionary$/;
const ANSWER_PATH = /\/api\/attempts\/[^/]+\/answer$/;
const LONG_COMPOUND = 'Donaudampfschifffahrtsgesellschaftskapitän';
const HYPHENATED = 'Kfz-Haftpflichtversicherung';
const TEIL_THREE_PAIR = 10;
const SHARED_SET_FIRST = 18;
const HOEREN_STEPS = 14;
const LESEN_TASKS = 25;
const POSITION_TOLERANCE_SECONDS = 0.1;

const openGuest = async (
  browser: Browser,
  viewport: { width: number; height: number } = DESKTOP,
  isEnlarged = false,
) => {
  const { context, page } = await openGuestPage(browser, viewport, isEnlarged);
  await enterAndStart(page);
  await expect(card(page, 'hoeren-1')).toBeVisible();
  return { context, page };
};

const showTask = async (page: Page) => {
  const switcher = page.getByTestId('lesen-view-questions');
  if (await switcher.isVisible()) await switcher.click();
};

const showText = async (page: Page) => {
  const switcher = page.getByTestId('lesen-view-text');
  if (await switcher.isVisible()) await switcher.click();
};

const trackPosts = (page: Page, path: RegExp): string[] => {
  const seen: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() !== 'POST') return;
    if (path.test(new URL(sent.url()).pathname)) seen.push(sent.url());
  });
  return seen;
};

const choose = async (page: Page, questionId: string, optionId: string) => {
  const target = card(page, questionId);
  await optionIn(target, optionId).check();
  await expectStatus(target, 'saved');
};

const toggleOf = (page: Page): Locator => page.getByTestId('dictionary-toggle');
const cardOf = (page: Page): Locator => page.getByTestId('dictionary-card');
const wordOf = (page: Page): Locator => page.getByTestId('dictionary-word');

// The row of one answer: the label with the radio, the letter and the text.
const rowOf = (cardLocator: Locator, optionId: string): Locator =>
  cardLocator.locator('label.MuiFormControlLabel-root').filter({
    has: cardLocator.page().locator(`input[value="${optionId}"]`),
  });

const textOf = (row: Locator): Locator =>
  row.locator('.MuiFormControlLabel-label');

// The centre of the first line of a German word of the material, found with
// a DOM Range inside the locator.
const wordPoint = async (locator: Locator, word: string) => {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(target) ?? -1;
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`${target} is not in the element`);
  }, word);
};

// Selects one word of a German zone, as a guest would before using the
// keyboard action.
const selectWord = (locator: Locator, word: string) =>
  locator.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(target) ?? -1;
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + target.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`${target} is not in the element`);
  }, word);

interface TypeScale {
  fontPx: number;
  lineHeightRatio: number;
}

const scaleOf = (locator: Locator): Promise<TypeScale> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const fontPx = Number.parseFloat(style.fontSize);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return { fontPx, lineHeightRatio: lineHeight / fontPx };
  });

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element has no box');
  return box;
};

// Adds text to the end of a German zone of the material, only in the DOM of
// the test: the published material is never touched.
const appendInZone = (locator: Locator, text: string) =>
  locator.evaluate((element, added) => {
    const zone =
      element.querySelector('[data-dictionary-text]') ??
      element.querySelector('[lang="de"]') ??
      element;
    zone.append(document.createTextNode(added));
  }, text);

const expectNoSidewaysScroll = async (page: Page, screen: string) => {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, `${screen}: the page scrolls sideways`).toBe(
    widths.client,
  );
};

// Nothing of the text sticks out of its box or out of the screen.
const expectTextContained = async (locator: Locator, screen: string) => {
  const report = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects());
    const box = element.getBoundingClientRect();
    return {
      right: Math.max(...rects.map((rect) => rect.right)),
      left: Math.min(...rects.map((rect) => rect.left)),
      boxRight: box.right,
      screen: document.documentElement.clientWidth,
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(report.right, `${screen}: text beyond the screen`).toBeLessThanOrEqual(
    report.screen + 0.5,
  );
  expect(report.left, `${screen}: text before the screen`).toBeGreaterThan(
    -0.5,
  );
  expect(report.right, `${screen}: text beyond its box`).toBeLessThanOrEqual(
    report.boxRight + 0.5,
  );
  expect(report.overflow, `${screen}: clipped text`).toBeLessThanOrEqual(1);
};

// --- Recording: Hören only -------------------------------------------------

test('Lesen pauses and hides audio without unmounting', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await waitForPlayer(page);
  await playFrom(page, 5, 'listener');
  const playing = await snapshotOf(page);
  await expect(page.getByTestId('audio-player')).toBeVisible();

  await goToLesen(page);
  await expect(page.getByTestId('audio-player')).toBeHidden();
  await expect(audioOf(page)).toHaveCount(1);
  const onLesen = await snapshotOf(page);
  expect(onLesen).toMatchObject({
    paused: true,
    isConnected: true,
    marker: 'listener',
  });
  expect(onLesen.currentTime).toBeGreaterThanOrEqual(playing.currentTime);
  // Nothing moves any more.
  await page.waitForTimeout(900);
  expect((await snapshotOf(page)).currentTime).toBe(onLesen.currentTime);
  await context.close();
});

test('returning to Hören restores paused audio', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  const { attemptId } = await activeAttemptOf(context);
  await waitForPlayer(page);
  await choose(page, 'hoeren-1', fullKeyOf('hoeren-1'));
  await playFrom(page, 6, 'listener');

  await goToLesen(page);
  const onLesen = await snapshotOf(page);
  await goToHoeren(page);
  await expect(page.getByTestId('audio-player')).toBeVisible();
  const back = await snapshotOf(page);
  expect(back).toMatchObject({ paused: true, marker: 'listener' });
  expect(Math.abs(back.currentTime - onLesen.currentTime)).toBeLessThanOrEqual(
    POSITION_TOLERANCE_SECONDS,
  );
  // No autoplay: the place stays where it was.
  await page.waitForTimeout(900);
  expect((await snapshotOf(page)).currentTime).toBe(back.currentTime);
  await expect(page.getByTestId('audio-toggle')).toHaveAttribute(
    'data-playing',
    'false',
  );
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
  });
  await context.close();
});

test('hidden Lesen player never plays', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await waitForPlayer(page);
  await playFrom(page, 4, 'listener');
  await goToLesen(page);
  const before = await snapshotOf(page);
  expect(before.paused).toBe(true);

  // A media key or a headset calls play() on the element, not on the button.
  await audioOf(page).evaluate((element: HTMLAudioElement) => {
    void element.play().catch(() => undefined);
  });
  await expect.poll(async () => (await snapshotOf(page)).paused).toBe(true);
  // The pause follows the play event at once: at most a few frames pass.
  const stopped = await snapshotOf(page);
  expect(stopped.currentTime - before.currentTime).toBeLessThan(0.5);
  await page.waitForTimeout(1200);
  const after = await snapshotOf(page);
  expect(after.paused).toBe(true);
  expect(after.currentTime).toBe(stopped.currentTime);

  // The controls of the hidden player take no focus.
  await page
    .getByTestId('audio-toggle')
    .evaluate((element) => (element as HTMLElement).focus());
  expect(
    await page.evaluate(
      () =>
        document.activeElement?.getAttribute('data-testid') === 'audio-toggle',
    ),
  ).toBe(false);
  await expect(page.getByTestId('audio-toggle')).toBeHidden();
  await context.close();
});

test('navigation preserves one audio element', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await waitForPlayer(page);
  await playFrom(page, 5, 'listener');
  const sourceOf = () =>
    audioOf(page).evaluate((element: HTMLAudioElement) => element.currentSrc);
  const source = await sourceOf();
  expect(source).not.toBe('');

  // Moving between the blocks asks for no new address: no server action.
  const actions: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.headers()['next-action']) {
      actions.push(sent.url());
    }
  });
  await goToLesen(page);
  await goToHoeren(page);
  await goToLesen(page);
  await goToHoeren(page);
  expect(actions).toEqual([]);
  expect(await sourceOf()).toBe(source);

  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await goToLesen(page);
  await page.getByTestId('locale-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await goToHoeren(page);
  await expect(audioOf(page)).toHaveCount(1);
  expect(await sourceOf()).toBe(source);
  expect((await snapshotOf(page)).marker).toBe('listener');
  await context.close();
});

test('first Hören screen shows prompt and first option', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser, SMALL_PHONE);
  await waitForPlayer(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const height = SMALL_PHONE.height;

  const prompt = await boxOf(card(page, 'hoeren-1').locator('h2'));
  expect(prompt.y).toBeGreaterThanOrEqual(0);
  expect(prompt.y + prompt.height).toBeLessThanOrEqual(height);
  const first = await boxOf(rowOf(card(page, 'hoeren-1'), 'a'));
  expect(first.y + first.height).toBeLessThanOrEqual(height);

  // The compact player keeps everything the guest needs.
  for (const id of ['audio-toggle', 'audio-back', 'audio-time']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByRole('slider')).toBeVisible();
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  const player = await boxOf(page.getByTestId('audio-player'));
  expect(player.height).toBeLessThanOrEqual(120);
  await context.close();
});

// --- Translator: one control in the header ---------------------------------

test('dictionary has one visible control in header', async ({ browser }) => {
  const { context, page } = await openGuestPage(browser, DESKTOP, false);
  await enterAtChoice(page);
  // The choice screen has no translator.
  await expect(toggleOf(page)).toHaveCount(0);
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  await expect(card(page, 'hoeren-1')).toBeVisible();

  const control = page.getByRole('banner').getByTestId('dictionary-toggle');
  await expect(toggleOf(page)).toHaveCount(1);
  await expect(control).toBeVisible();
  await expect(page.getByTestId('dictionary-bar')).toHaveCount(0);
  await expect(page.getByTestId('dictionary-translate-selection')).toHaveCount(
    1,
  );
  const box = await boxOf(control);
  expect(box.width).toBeGreaterThanOrEqual(48);
  expect(box.height).toBeGreaterThanOrEqual(48);
  await expect(control).toHaveAttribute('aria-pressed', 'true');
  await expect(control).toHaveAccessibleName(/\S/);

  // The hint is a tooltip, not a permanent line.
  await control.hover();
  await expect(page.getByRole('tooltip')).toHaveText(/\S/);
  const onHint = (await page.getByRole('tooltip').textContent()) ?? '';
  await control.click();
  await expect(control).toHaveAttribute('aria-pressed', 'false');
  await expect(control).toHaveAttribute('data-enabled', 'false');
  await expect(page.getByTestId('dictionary-translate-selection')).toHaveCount(
    0,
  );
  await expect(page.getByRole('tooltip')).not.toHaveText(onHint);

  await goToLesen(page);
  await expect(toggleOf(page)).toHaveCount(1);
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  await toggleOf(page).click();
  await finishFromShell(page);
  // The review has no translator.
  await expect(toggleOf(page)).toHaveCount(0);
  await context.close();
});

test('keyboard can translate without permanent toolbar', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  await expect(page.getByTestId('dictionary-bar')).toHaveCount(0);
  const action = page.getByTestId('dictionary-translate-selection');
  // Hidden on the screen until it has the focus.
  const hidden = await boxOf(action);
  expect(hidden.width).toBeLessThanOrEqual(2);

  await selectWord(card(page, 'hoeren-1').locator('h2'), 'Frage');
  await action.focus();
  await expect(action).toBeVisible();
  expect((await boxOf(action)).height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await expect(wordOf(page)).toHaveText('Frage');
  await page.keyboard.press('Escape');
  await expect(cardOf(page)).toBeHidden();
  await expect(action).toBeFocused();
  await context.close();
});

test('keyboard translation retains selection and focus', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  const action = page.getByTestId('dictionary-translate-selection');
  await selectWord(card(page, 'hoeren-1').locator('h2'), 'Frage');
  await action.focus();
  // Taking the focus does not drop the selection.
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'Frage',
  );
  await page.keyboard.press('Space');
  await expect(wordOf(page)).toHaveText('Frage');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'Frage',
  );
  await page.keyboard.press('Escape');
  await expect(cardOf(page)).toBeHidden();
  await expect(action).toBeFocused();
  await expectVisibleFocus(page, 'translate action');

  // Without a selection the action says what to do instead of failing.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dictionary-selection-notice')).toBeVisible();
  await context.close();
});

test('off header translator never requests lookup', async ({ browser }) => {
  const { context, page } = await openGuest(browser);
  await toggleOf(page).click();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  const lookups = trackPosts(page, LOOKUP_PATH);
  const prompt = card(page, 'hoeren-1').locator('h2');
  const point = await wordPoint(prompt, 'Frage');
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(900);
  await page.mouse.dblclick(point.x, point.y);
  await page.waitForTimeout(500);
  await expect(cardOf(page)).toHaveCount(0);
  expect(lookups).toEqual([]);
  await context.close();

  // A touch device: a tap on a word of the option does not look it up.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const phonePage = await phone.newPage();
  await enterAndStart(phonePage);
  await toggleOf(phonePage).tap();
  await expect(toggleOf(phonePage)).toHaveAttribute('aria-pressed', 'false');
  const phoneLookups = trackPosts(phonePage, LOOKUP_PATH);
  const tap = await wordPoint(
    rowOf(card(phonePage, 'hoeren-1'), 'a'),
    'Antwort',
  );
  await phonePage.touchscreen.tap(tap.x, tap.y);
  await phonePage.waitForTimeout(700);
  await expect(cardOf(phonePage)).toHaveCount(0);
  expect(phoneLookups).toEqual([]);
  await phone.close();
});

test('mobile word tap does not choose radio', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  await enterAndStart(page);
  const { attemptId } = await activeAttemptOf(context);
  const answers = trackPosts(page, ANSWER_PATH);
  const target = card(page, 'hoeren-1');
  const statusBefore = await target
    .getByTestId('save-status')
    .getAttribute('data-status');

  const tap = await wordPoint(rowOf(target, 'a'), 'Antwort');
  await page.touchscreen.tap(tap.x, tap.y);
  await expect(cardOf(page)).toHaveAttribute('data-presentation', 'sheet');
  await expect(optionIn(target, 'a')).not.toBeChecked();
  await expect(target.getByTestId('save-status')).toHaveAttribute(
    'data-status',
    statusBefore ?? 'idle',
  );
  expect(answers).toEqual([]);
  expect(await readAnswers(attemptId)).toEqual({});
  await context.close();
});

test('translator toggle changes radio label behavior safely', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser);
  const { attemptId } = await activeAttemptOf(context);
  const answers = trackPosts(page, ANSWER_PATH);
  const target = card(page, 'hoeren-1');

  // On: a click on the words of an option opens the card, not the answer.
  const on = await wordPoint(rowOf(target, 'b'), 'Antwort');
  await page.mouse.click(on.x, on.y);
  await page.waitForTimeout(400);
  await expect(optionIn(target, 'b')).not.toBeChecked();
  expect(answers).toEqual([]);
  await page.keyboard.press('Escape');

  // Off: the ordinary label selects the radio again.
  await toggleOf(page).click();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  const off = await wordPoint(rowOf(target, 'b'), 'Antwort');
  await page.mouse.click(off.x, off.y);
  await expect(optionIn(target, 'b')).toBeChecked();
  await expectStatus(target, 'saved');
  expect(answers).toHaveLength(1);

  // On again: the words no longer choose, the radio itself does.
  await toggleOf(page).click();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'true');
  const again = await wordPoint(rowOf(target, 'c'), 'Antwort');
  await page.mouse.click(again.x, again.y);
  await page.waitForTimeout(400);
  await expect(optionIn(target, 'b')).toBeChecked();
  await expect(optionIn(target, 'c')).not.toBeChecked();
  expect(answers).toHaveLength(1);
  await page.keyboard.press('Escape');
  await optionIn(target, 'c').check();
  await expectStatus(target, 'saved');
  expect(await readAnswers(attemptId)).toEqual({ 'hoeren-1': 'c' });
  await context.close();
});

// --- German text: size, reflow, contrast -----------------------------------

test('Lesen body meets mobile typography', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  await goToLesen(page);
  await showText(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  const body = await scaleOf(paragraph);
  expect(body.fontPx).toBeGreaterThanOrEqual(18);
  expect(body.lineHeightRatio).toBeGreaterThanOrEqual(1.5);
  const title = await scaleOf(page.getByTestId('reading-text').locator('h2'));
  expect(title.fontPx).toBeGreaterThanOrEqual(20);
  expect(title.fontPx).toBeLessThanOrEqual(22);
  expect(title.lineHeightRatio).toBeGreaterThanOrEqual(1.35);
  // The text panel keeps 12 px of inner space on a phone.
  const padding = await page
    .getByTestId('reading-text')
    .evaluate((element) => getComputedStyle(element).paddingLeft);
  expect(padding).toBe('12px');
  await context.close();
});

test('answer options are readable and touch sized', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  const check = async (questionId: string) => {
    const target = card(page, questionId);
    const prompt = await scaleOf(target.locator('h2'));
    expect(prompt.fontPx).toBeGreaterThanOrEqual(20);
    expect(prompt.lineHeightRatio).toBeGreaterThanOrEqual(1.5);
    const rows = target.locator('label.MuiFormControlLabel-root');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2);
    let previousBottom: number | null = null;
    for (let index = 0; index < count; index++) {
      const row = rows.nth(index);
      const text = await scaleOf(textOf(row));
      expect(text.fontPx).toBeGreaterThanOrEqual(18);
      expect(text.lineHeightRatio).toBeGreaterThanOrEqual(1.5);
      const box = await boxOf(row);
      expect(box.height).toBeGreaterThanOrEqual(48);
      const radio = await boxOf(row.locator('.MuiRadio-root'));
      expect(radio.width).toBeGreaterThanOrEqual(48);
      expect(radio.height).toBeGreaterThanOrEqual(48);
      // The letter belongs to the same row, so it is part of the target.
      await expect(row.locator('strong')).toHaveText(/^[a-z]$/);
      if (previousBottom !== null) {
        expect(box.y - previousBottom).toBeCloseTo(8, 0);
      }
      previousBottom = box.y + box.height;
    }
  };
  await check('hoeren-1');
  await goToLesen(page);
  await showTask(page);
  await check('lesen-1');
  await context.close();
});

test('German text reflows at 320px', async ({ browser }) => {
  const { context, page } = await openGuest(browser, NARROWEST);
  await goToLesen(page);
  await showText(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  const original = (await paragraph.textContent()) ?? '';
  await appendInZone(paragraph, ` ${LONG_COMPOUND} ${HYPHENATED}`);
  const changed = (await paragraph.textContent()) ?? '';
  expect(changed.startsWith(original)).toBe(true);
  await expectNoSidewaysScroll(page, 'lesen text');
  await expectTextContained(paragraph, 'lesen paragraph');

  await showTask(page);
  const row = rowOf(card(page, 'lesen-1'), 'a');
  const optionOriginal = (await row.textContent()) ?? '';
  await appendInZone(textOf(row), ` ${LONG_COMPOUND}`);
  expect((await row.textContent()) ?? '').toContain(optionOriginal);
  await expectNoSidewaysScroll(page, 'lesen option');
  await expectTextContained(textOf(row), 'option');
  // The material itself is read again from the server unchanged.
  await page.reload();
  await expect(page.getByTestId('reading-text')).toBeAttached();
  expect(
    (await page.getByTestId('reading-paragraph-0').textContent()) ?? '',
  ).toBe(original);
  await context.close();
});

test('hyphenated compound reflow preserves dictionary', async ({ browser }) => {
  const { context, page } = await openGuest(browser, NARROWEST);
  await goToLesen(page);
  await showText(page);
  const paragraph = page.getByTestId('reading-paragraph-0');
  await appendInZone(paragraph, ` ${HYPHENATED}`);
  await expectTextContained(paragraph, 'compound');
  await expectNoSidewaysScroll(page, 'compound');

  const point = await wordPoint(paragraph, HYPHENATED);
  await page.mouse.move(point.x, point.y);
  await expect(wordOf(page)).toHaveText(HYPHENATED);
  await expect(page.getByTestId('dictionary-translation')).toHaveText(
    `test-en:${HYPHENATED}`,
  );
  await expectNoSidewaysScroll(page, 'compound with card');
  await context.close();
});

test('mobile layouts keep learning controls visible', async ({ browser }) => {
  for (const viewport of [NARROWEST, { width: 360, height: 740 }, PHONE]) {
    const screen = `${viewport.width}x${viewport.height}`;
    const { context, page } = await openGuest(browser, viewport);
    await expectUsableLayout(page, `${screen} hoeren`);
    await goToStep(page, TEIL_THREE_PAIR);
    await expect(card(page, 'hoeren-10')).toBeVisible();
    await expectUsableLayout(page, `${screen} hoeren pair`);
    await goToLesen(page);
    await showText(page);
    await expectUsableLayout(page, `${screen} lesen text`);
    await showTask(page);
    await expectUsableLayout(page, `${screen} lesen task`);
    await page.getByTestId('navigator-toggle').click();
    await expectUsableLayout(page, `${screen} lesen list`);
    await context.close();
  }
});

test('text spacing override preserves content', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  // WCAG 1.4.12 overrides on the German learning zones.
  await page.addStyleTag({
    content: `
      [lang="de"], [lang="de"] * {
        line-height: 1.5 !important;
        letter-spacing: 0.12em !important;
        word-spacing: 0.16em !important;
      }
      [lang="de"] p, [data-paragraph], .MuiFormControlLabel-root {
        margin-bottom: 2em !important;
      }`,
  });
  await expectUsableLayout(page, 'hoeren spaced');
  await expectNoSidewaysScroll(page, 'hoeren spaced');
  await expectTextContained(card(page, 'hoeren-1').locator('h2'), 'prompt');
  for (const id of ['a', 'b', 'c']) {
    await expectTextContained(
      textOf(rowOf(card(page, 'hoeren-1'), id)),
      `option ${id}`,
    );
  }
  await page.getByTestId('navigator-toggle').click();
  await expectUsableLayout(page, 'navigator spaced');

  await goToLesen(page);
  await showText(page);
  await expectNoSidewaysScroll(page, 'lesen spaced');
  await expectTextContained(
    page.getByTestId('reading-paragraph-0'),
    'paragraph',
  );
  await showTask(page);
  await expectUsableLayout(page, 'lesen task spaced');
  await expectTextContained(
    card(page, 'lesen-1').locator('h2'),
    'lesen prompt',
  );
  await context.close();
});

test('zoomed text preserves learning controls', async ({ browser }) => {
  const { context, page } = await openGuest(browser, NARROWEST, true);
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    )
    .toBe('32px');
  await expectUsableLayout(page, 'hoeren zoomed');
  await expectNoSidewaysScroll(page, 'hoeren zoomed');
  await expect(card(page, 'hoeren-1').locator('h2')).toContainText('Frage 1');
  await expectTextContained(card(page, 'hoeren-1').locator('h2'), 'prompt');
  await expect(rowOf(card(page, 'hoeren-1'), 'a')).toContainText('Antwort a');
  await expect(toggleOf(page)).toBeVisible();

  await page.getByTestId('navigator-toggle').click();
  await expectUsableLayout(page, 'navigator zoomed');
  await page.getByTestId('navigator-toggle').click();

  await goToLesen(page);
  await showText(page);
  await expect(page.getByTestId('reading-paragraph-0')).toContainText(
    'Anzeige',
  );
  await expectUsableLayout(page, 'lesen text zoomed');
  await expectTextContained(page.getByTestId('reading-paragraph-0'), 'text');
  await showTask(page);
  await expectUsableLayout(page, 'lesen task zoomed');
  await context.close();
});

type Rgba = [number, number, number, number];

test('learning text has sufficient contrast', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  const contrastOf = (locator: Locator): Promise<number> =>
    locator.evaluate((element) => {
      const parse = (value: string): Rgba => {
        const match = /rgba?\(([^)]+)\)/.exec(value);
        if (!match?.[1]) throw new Error(`unsupported colour ${value}`);
        const parts = match[1]
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      };
      const over = (top: Rgba, bottom: Rgba): Rgba => {
        const alpha = top[3] + bottom[3] * (1 - top[3]);
        const mix = (index: 0 | 1 | 2) =>
          (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) /
          (alpha || 1);
        return [mix(0), mix(1), mix(2), alpha];
      };
      const layers: Rgba[] = [];
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        layers.push(parse(getComputedStyle(node).backgroundColor));
      }
      let background: Rgba = [255, 255, 255, 1];
      for (const layer of layers.reverse())
        background = over(layer, background);
      const text = over(parse(getComputedStyle(element).color), background);
      const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928
          ? scaled / 12.92
          : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: Rgba) =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const [light = 0, dark = 0] = [
        luminance(text),
        luminance(background),
      ].sort((a, b) => b - a);
      return (light + 0.05) / (dark + 0.05);
    });

  const hoeren = card(page, 'hoeren-1');
  expect(await contrastOf(hoeren.locator('h2'))).toBeGreaterThanOrEqual(7);
  expect(await contrastOf(textOf(rowOf(hoeren, 'a')))).toBeGreaterThanOrEqual(
    7,
  );
  expect(await contrastOf(hoeren.locator('p').first())).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(
    await contrastOf(page.getByTestId('set-position')),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await contrastOf(page.getByTestId('audio-time')),
  ).toBeGreaterThanOrEqual(4.5);
  await goToLesen(page);
  await showText(page);
  expect(
    await contrastOf(page.getByTestId('reading-paragraph-0')),
  ).toBeGreaterThanOrEqual(7);
  expect(
    await contrastOf(page.getByTestId('reading-text').locator('h2')),
  ).toBeGreaterThanOrEqual(7);
  await context.close();
});

// --- Answers: a clear chosen state -----------------------------------------

test('selected answers have clear visual state', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  const { attemptId } = await activeAttemptOf(context);
  const answers = trackPosts(page, ANSWER_PATH);
  const target = card(page, 'hoeren-1');
  const look = (row: Locator) =>
    row.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor };
    });
  const before = await look(rowOf(target, 'b'));
  await optionIn(target, 'b').check();
  await expectStatus(target, 'saved');
  const chosen = await look(rowOf(target, 'b'));
  const other = await look(rowOf(target, 'a'));
  // A soft fill and a stronger frame next to the checked radio.
  expect(chosen.background).not.toBe(before.background);
  expect(chosen.background).not.toBe(other.background);
  expect(chosen.border).not.toBe(other.border);
  await expect(optionIn(target, 'b')).toBeChecked();

  // The keyboard focus is clearly visible on the radio.
  await optionIn(target, 'b').focus();
  await page.keyboard.press('ArrowDown');
  await expect(optionIn(target, 'c')).toBeChecked();
  await expectVisibleFocus(page, 'chosen radio');
  await expectStatus(target, 'saved');
  const saves = answers.length;

  // A click on a word does not choose again.
  const tap = await wordPoint(rowOf(target, 'a'), 'Antwort');
  await page.mouse.click(tap.x, tap.y);
  await page.waitForTimeout(400);
  await expect(optionIn(target, 'c')).toBeChecked();
  expect(answers).toHaveLength(saves);
  expect(await readAnswers(attemptId)).toEqual({ 'hoeren-1': 'c' });

  await goToLesen(page);
  await showTask(page);
  await choose(page, 'lesen-1', 'b');
  const lesen = await look(rowOf(card(page, 'lesen-1'), 'b'));
  expect(lesen.background).not.toBe(
    (await look(rowOf(card(page, 'lesen-1'), 'a'))).background,
  );
  await context.close();
});

// --- Navigator --------------------------------------------------------------

test('Lesen picker navigates to any question', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  await goToLesen(page);
  await showTask(page);
  await choose(page, 'lesen-1', fullKeyOf('lesen-1'));

  // A phone: one line, the list opens under its button.
  const toggle = page.getByTestId('navigator-toggle');
  const list = page.getByTestId('navigator-list');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  const controls = await toggle.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  await expect(page.locator(`[id="${controls}"]`)).toHaveCount(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toBeVisible();
  await expect(page.locator('[data-testid^="go-to-question-"]')).toHaveCount(
    LESEN_TASKS,
  );
  // Current, answered and empty tell apart without colour.
  const first = page.getByTestId('go-to-question-1');
  await expect(first).toHaveAttribute('aria-current', 'step');
  await expect(first).toHaveAttribute('data-progress', 'answered');
  await expect(first).toContainText('✓');
  await expect(first).toHaveAccessibleName(/\S/);
  const second = page.getByTestId('go-to-question-2');
  await expect(second).toHaveAttribute('data-progress', 'empty');
  await expect(second).not.toContainText('✓');
  await expect(second).not.toHaveAttribute('aria-current', 'step');
  expect(await first.getAttribute('aria-label')).not.toBe(
    await second.getAttribute('aria-label'),
  );

  for (const number of [25, 11, 7, 1, 20]) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await page.getByTestId(`go-to-question-${number}`).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('set-position')).toContainText(
      `${number} of ${LESEN_TASKS}`,
    );
    await showTask(page);
    await expect(card(page, `lesen-${number}`)).toBeVisible();
  }
  await context.close();

  // A wide screen shows the compact grid at once.
  const wide = await openGuest(browser, DESKTOP);
  await goToLesen(wide.page);
  await expect(wide.page.getByTestId('navigator-toggle')).toBeHidden();
  await expect(wide.page.getByTestId('navigator-list')).toBeVisible();
  for (const number of [1, 13, 25]) {
    await expect(
      wide.page.getByTestId(`go-to-question-${number}`),
    ).toBeVisible();
  }
  const compact = await boxOf(wide.page.getByTestId('go-to-question-25'));
  expect(compact.height).toBeLessThanOrEqual(40);
  await wide.page.getByTestId('go-to-question-25').click();
  await expect(card(wide.page, 'lesen-25')).toBeVisible();
  await wide.context.close();
});

test('Hören picker respects grouped steps', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  await page.getByTestId('navigator-toggle').click();
  const steps = page.locator('[data-testid^="go-to-question-"]');
  await expect(steps).toHaveCount(HOEREN_STEPS);
  await expect(page.getByTestId('set-position')).toContainText(
    `1 of ${HOEREN_STEPS}`,
  );
  // A pair and the shared set are one step each, named by their range.
  await expect(
    page.getByTestId(`go-to-question-${TEIL_THREE_PAIR}`),
  ).toContainText('10–11');
  await expect(page.getByTestId('go-to-question-11')).toHaveCount(0);
  await expect(
    page.getByTestId(`go-to-question-${SHARED_SET_FIRST}`),
  ).toContainText('18–20');
  await expect(page.getByTestId('go-to-question-19')).toHaveCount(0);
  for (const teil of [1, 2, 3, 4]) {
    await expect(
      page.getByRole('group', { name: `Teil ${teil}` }),
    ).toBeVisible();
  }

  await page.getByTestId(`go-to-question-${TEIL_THREE_PAIR}`).click();
  await expect(card(page, 'hoeren-10')).toBeVisible();
  await expect(card(page, 'hoeren-11')).toBeVisible();
  await expect(card(page, 'hoeren-1')).toHaveCount(0);
  await choose(page, 'hoeren-10', fullKeyOf('hoeren-10'));
  await page.getByTestId('navigator-toggle').click();
  await expect(
    page.getByTestId(`go-to-question-${TEIL_THREE_PAIR}`),
  ).toHaveAttribute('data-progress', 'partial');
  await page.getByTestId('go-to-question-1').click();
  await expect(card(page, 'hoeren-1')).toBeVisible();
  await context.close();
});

test('grouped Hören answers survive navigation', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  const { attemptId } = await activeAttemptOf(context);

  await goToStep(page, TEIL_THREE_PAIR);
  await choose(page, 'hoeren-10', 'a');
  await choose(page, 'hoeren-11', 'b');
  await goToStep(page, SHARED_SET_FIRST);
  for (const id of ['hoeren-18', 'hoeren-19', 'hoeren-20']) {
    await expect(card(page, id)).toBeVisible();
  }
  await choose(page, 'hoeren-18', 'c');
  await choose(page, 'hoeren-19', 'd');
  await goToStep(page, 1);
  await goToStep(page, TEIL_THREE_PAIR);
  await expect(optionIn(card(page, 'hoeren-10'), 'a')).toBeChecked();
  await expect(optionIn(card(page, 'hoeren-11'), 'b')).toBeChecked();
  await goToStep(page, SHARED_SET_FIRST);
  await expect(optionIn(card(page, 'hoeren-18'), 'c')).toBeChecked();
  await expect(optionIn(card(page, 'hoeren-19'), 'd')).toBeChecked();
  await expect(optionIn(card(page, 'hoeren-20'), 'a')).not.toBeChecked();
  expect(await readAnswers(attemptId)).toEqual({
    'hoeren-10': 'a',
    'hoeren-11': 'b',
    'hoeren-18': 'c',
    'hoeren-19': 'd',
  });
  await context.close();
});

test('question picker does not change answers', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  const { attemptId } = await activeAttemptOf(context);
  await choose(page, 'hoeren-1', fullKeyOf('hoeren-1'));
  await goToStep(page, 2);
  await choose(page, 'hoeren-2', fullWrongOf('hoeren-2'));
  const stored = await readAnswers(attemptId);
  const answers = trackPosts(page, ANSWER_PATH);

  for (const number of [9, TEIL_THREE_PAIR, SHARED_SET_FIRST, 1, 2]) {
    await goToStep(page, number);
    await expect(page.getByTestId('navigator-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  }
  await expect(
    optionIn(card(page, 'hoeren-2'), fullWrongOf('hoeren-2')),
  ).toBeChecked();
  expect(answers).toEqual([]);
  expect(await readAnswers(attemptId)).toEqual(stored);

  await goToLesen(page);
  await showTask(page);
  await goToStep(page, 12);
  await goToStep(page, 1);
  expect(answers).toEqual([]);
  expect(await readAnswers(attemptId)).toEqual(stored);
  await context.close();
});

// --- Header, locale and state ----------------------------------------------

test('narrow header keeps locale and dictionary accessible', async ({
  browser,
}) => {
  const { context, page } = await openGuest(browser, NARROWEST);
  const header = page.getByRole('banner');
  const translator = header.getByRole('button', { name: 'Word translator' });
  const english = header.getByRole('button', { name: 'EN, English' });
  const russian = header.getByRole('button', { name: 'RU, Русский' });
  for (const control of [translator, english, russian]) {
    await expect(control).toBeVisible();
  }
  const boxes = await Promise.all(
    [translator, english, russian].map((control) => boxOf(control)),
  );
  // One row, inside the screen, none wrapped below another.
  const tops = boxes.map((box) => box.y);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(8);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(NARROWEST.width);
  }
  expect(boxes[0]?.width).toBeGreaterThanOrEqual(48);
  expect(boxes[0]?.height).toBeGreaterThanOrEqual(48);
  expect((await boxOf(header)).height).toBeLessThanOrEqual(72);
  await expectNoSidewaysScroll(page, 'header');
  await expectUsableLayout(page, 'narrow header');

  await translator.click();
  await expect(translator).toHaveAttribute('aria-pressed', 'false');
  await russian.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(russian).toHaveAttribute('aria-pressed', 'true');
  await expectNoSidewaysScroll(page, 'header ru');
  await english.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(translator).toHaveAttribute('aria-pressed', 'false');
  await context.close();
});

test('locale switch preserves learning state', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  const { attemptId } = await activeAttemptOf(context);
  await waitForPlayer(page);
  await choose(page, 'hoeren-1', fullKeyOf('hoeren-1'));
  await toggleOf(page).click();
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  await playFrom(page, 7, 'listener');
  await page.getByTestId('audio-toggle').click();
  await expect(page.getByTestId('audio-toggle')).toHaveAttribute(
    'data-playing',
    'false',
  );
  const before = await snapshotOf(page);

  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(toggleOf(page)).toHaveAttribute('aria-pressed', 'false');
  const after = await snapshotOf(page);
  expect(after).toMatchObject({ paused: true, marker: 'listener' });
  expect(Math.abs(after.currentTime - before.currentTime)).toBeLessThanOrEqual(
    POSITION_TOLERANCE_SECONDS,
  );
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();
  expect((await activeAttemptOf(context)).attemptId).toBe(attemptId);
  await expect(page.getByTestId('block-link-hoeren')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await context.close();
});

// --- Keyboard order and layers ---------------------------------------------

test('keyboard focus follows visible controls', async ({ browser }) => {
  const { context, page } = await openGuest(browser, PHONE);
  await waitForPlayer(page);

  // Tab from the top of the page: header, blocks, recording, the
  // translate action (shown once focused), then the navigator.
  await page.evaluate(() => {
    const { body } = document;
    body.tabIndex = -1;
    body.focus();
    body.removeAttribute('tabindex');
  });
  const order: string[] = [];
  for (let step = 0; step < 14; step++) {
    await page.keyboard.press('Tab');
    const key = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
    order.push(key);
    if (key) await expectVisibleFocus(page, `tab ${step} ${key}`);
    if (key === 'navigator-toggle') break;
  }
  const at = (id: string) => order.indexOf(id);
  expect(at('dictionary-toggle')).toBeGreaterThanOrEqual(0);
  expect(at('dictionary-toggle')).toBeLessThan(at('locale-en'));
  expect(at('locale-en')).toBeLessThan(at('locale-ru'));
  expect(at('locale-ru')).toBeLessThan(at('block-link-hoeren'));
  expect(at('block-link-hoeren')).toBeLessThan(at('audio-toggle'));
  expect(at('audio-toggle')).toBeLessThan(at('audio-back'));
  expect(at('audio-back')).toBeLessThan(at('dictionary-translate-selection'));
  expect(at('dictionary-translate-selection')).toBeLessThan(
    at('navigator-toggle'),
  );
  // The closed list is out of the tab order.
  expect(order.some((id) => id.startsWith('go-to-question-'))).toBe(false);

  // Escape closes only the top layer: the dictionary card first, the open
  // list of tasks second, and the focus returns to the list button.
  const toggle = page.getByTestId('navigator-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const prompt = card(page, 'hoeren-1').locator('h2');
  const point = await wordPoint(prompt, 'Frage');
  await page.mouse.dblclick(point.x, point.y);
  await expect(wordOf(page)).toHaveText('Frage');
  await page.keyboard.press('Escape');
  await expect(cardOf(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('navigator-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expectVisibleFocus(page, 'list button after escape');

  // A list opened with the keyboard is walked and chosen with it.
  await tabTo(page, toggle, 'list button');
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByTestId('go-to-question-2'), 'step 2');
  await page.keyboard.press('Enter');
  await expect(card(page, 'hoeren-2')).toBeVisible();
  await expect(toggle).toBeFocused();
  await context.close();
});

test('failed recording stays in Hören and keeps the answers', async ({
  browser,
}) => {
  // The status stays in the DOM of the hidden Lesen player and shows again
  // in Hören; the answers never depend on the recording.
  const context = await browser.newContext({ viewport: PHONE });
  await context.route('**/storage/v1/object/sign/**', (route) => route.abort());
  const page = await context.newPage();
  await enterAndStart(page);
  const status = page.getByTestId('audio-status');
  await expect(status).toHaveAttribute('data-status', 'error');
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status.getByRole('button')).toBeVisible();
  await choose(page, 'hoeren-1', fullKeyOf('hoeren-1'));
  await goToLesen(page);
  await expect(status).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('audio-player')).toBeHidden();
  await goToHoeren(page);
  await expect(status.getByRole('button')).toBeVisible();
  await expect(
    optionIn(card(page, 'hoeren-1'), fullKeyOf('hoeren-1')),
  ).toBeChecked();
  await context.close();
});
