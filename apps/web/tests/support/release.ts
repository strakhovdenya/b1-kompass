import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

// Release checks of the guest route on the screen sizes of the PRD, with the
// browser text size doubled where asked.

export const NARROW = { width: 390, height: 844 } as const;
export const WIDE = { width: 1440, height: 900 } as const;

export interface ViewportSize {
  width: number;
  height: number;
}

// Chromium's default font size is 16 px. Doubling it is what a guest gets
// from "text size 200 %" in the browser settings: every rem of the theme
// grows while the CSS width of the viewport stays.
const ENLARGED_FONT_PX = 32;
const ENLARGED_FIXED_FONT_PX = 26;

const enlargeText = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setFontSizes', {
    fontSizes: { standard: ENLARGED_FONT_PX, fixed: ENLARGED_FIXED_FONT_PX },
  });
};

export const expectEnlargedText = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    )
    .toBe(`${ENLARGED_FONT_PX}px`);

export interface GuestPage {
  context: BrowserContext;
  page: Page;
}

export const openGuestPage = async (
  browser: Browser,
  viewport: ViewportSize,
  isEnlarged: boolean,
): Promise<GuestPage> => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  if (isEnlarged) await enlargeText(page);
  return { context, page };
};

// Everything the guest can act on. A radio is invisible; its label is what
// the guest sees and touches.
const ACTION_SELECTOR = [
  'button',
  'a[href]',
  'label:has(input[type="radio"])',
  '.MuiSlider-thumb',
].join(', ');

interface LayoutReport {
  scrollWidth: number;
  clientWidth: number;
  outside: string[];
  covered: string[];
}

// Every visible action lies inside the width of the viewport and is the
// element under its own centre once scrolled into view.
const readLayout = (selector: string): LayoutReport => {
  const root = document.documentElement;
  const nameOf = (element: Element): string =>
    element.getAttribute('data-testid') ??
    `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 40)}"`;
  const elements = [...document.querySelectorAll(selector)].filter(
    (element) => element.getClientRects().length > 0,
  );
  const outside: string[] = [];
  const covered: string[] = [];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.left < -0.5 || rect.right > root.clientWidth + 0.5) {
      outside.push(nameOf(element));
      continue;
    }
    // A disabled action takes no taps (pointer-events: none) by design.
    if (element.matches(':disabled, [aria-disabled="true"], .Mui-disabled')) {
      continue;
    }
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    // A hit on a container means the action lets the tap fall through.
    const isOwn = hit !== null && element.contains(hit);
    if (!isOwn) covered.push(nameOf(element));
  }
  window.scrollTo(0, 0);
  return {
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    outside,
    covered,
  };
};

export const expectUsableLayout = async (page: Page, screen: string) => {
  const report = await page.evaluate(readLayout, ACTION_SELECTOR);
  expect(report.scrollWidth, `${screen}: the page scrolls sideways`).toBe(
    report.clientWidth,
  );
  expect(report.outside, `${screen}: actions outside the screen`).toEqual([]);
  expect(report.covered, `${screen}: covered actions`).toEqual([]);
};

interface FocusReport {
  key: string;
  elementId: string;
  isFocusVisible: boolean;
  outlineStyle: string;
  outlineWidthPx: number;
  isInViewport: boolean;
}

// The focused element and the ring the guest sees: the outline of the
// element itself or of the MUI control it belongs to (the ring of a radio
// or a slider is drawn around its invisible input).
const readFocus = (): FocusReport | null => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) {
    return null;
  }
  // Radios of one group share their key; the walk tells elements apart.
  active.dataset.focusWalkId ??= String(Math.random()).slice(2);
  const ring = active.closest('.Mui-focusVisible') ?? active;
  const style = getComputedStyle(ring);
  const rect = ring.getBoundingClientRect();
  const isRadio = active instanceof HTMLInputElement && active.type === 'radio';
  const text = (active.textContent ?? '').trim().slice(0, 40);
  const key = isRadio
    ? `radio:${active.name}`
    : (active.dataset.testid ?? `${active.tagName.toLowerCase()}:${text}`);
  return {
    key,
    elementId: active.dataset.focusWalkId,
    isFocusVisible: active.matches(':focus-visible'),
    outlineStyle: style.outlineStyle,
    outlineWidthPx: Number.parseFloat(style.outlineWidth) || 0,
    isInViewport:
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth,
  };
};

const MIN_OUTLINE_PX = 2;

export const expectVisibleFocus = async (page: Page, screen: string) => {
  const focus = await page.evaluate(readFocus);
  if (!focus) throw new Error(`${screen}: nothing is focused`);
  const where = `${screen}: focus on ${focus.key}`;
  expect(focus.isFocusVisible, where).toBe(true);
  expect(focus.outlineStyle, where).not.toBe('none');
  expect(focus.outlineWidthPx, where).toBeGreaterThanOrEqual(MIN_OUTLINE_PX);
  expect(focus.isInViewport, where).toBe(true);
};

const MAX_TABS = 200;

const hasFocusInside = (locator: Locator): Promise<boolean> =>
  locator.evaluate(
    (element) =>
      element === document.activeElement ||
      element.contains(document.activeElement),
  );

// Moves the focus with Tab only, from wherever it is, until it lands inside
// the target; the focus ring is checked there.
export const tabTo = async (page: Page, target: Locator, screen: string) => {
  await expect(target).toBeVisible();
  for (let i = 0; i < MAX_TABS; i++) {
    if (await hasFocusInside(target)) {
      await expectVisibleFocus(page, screen);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`${screen}: Tab never reached the target`);
};

// The stops Tab must reach on the screen: every visible enabled button,
// link and slider, and one stop per radio group; and how many elements
// could take the focus at most.
const readTabStops = (): { keys: string[]; count: number } => {
  const keys = new Set<string>();
  let count = 0;
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, a[href], input[type="radio"], input[type="range"], [tabindex]',
  );
  for (const element of candidates) {
    const isDisabled =
      element.matches(':disabled') ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.tabIndex < 0 ||
      element.closest('[inert], [aria-hidden="true"]') !== null;
    const shown =
      element instanceof HTMLInputElement
        ? (element.closest('label, .MuiSlider-root') ?? element)
        : element;
    if (isDisabled || shown.getClientRects().length === 0) continue;
    count++;
    if (element instanceof HTMLInputElement && element.type === 'radio') {
      keys.add(`radio:${element.name}`);
      continue;
    }
    const text = (element.textContent ?? '').trim().slice(0, 40);
    keys.add(
      element.dataset.testid ?? `${element.tagName.toLowerCase()}:${text}`,
    );
  }
  return { keys: [...keys], count };
};

interface Walk {
  visited: string[];
  steps: number;
  hasLeft: boolean;
}

// Follows the focus until it leaves the page. Coming back to an element
// already visited before leaving is a cycle: a trap.
const walk = async (
  page: Page,
  key: 'Tab' | 'Shift+Tab',
  limit: number,
): Promise<Walk> => {
  const visited: string[] = [];
  const elements = new Set<string>();
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press(key);
    const focus = await page.evaluate(readFocus);
    // Entering the page may take a step through the document itself.
    if (!focus && elements.size === 0) continue;
    if (!focus) return { visited, steps: elements.size, hasLeft: true };
    if (elements.has(focus.elementId)) break;
    elements.add(focus.elementId);
    visited.push(focus.key);
  }
  return { visited, steps: elements.size, hasLeft: false };
};

// From the top of the page Tab reaches every stop and then leaves the page;
// Shift+Tab walks the same stops back and leaves at the top.
export const expectNoFocusTrap = async (page: Page, screen: string) => {
  const stops = await page.evaluate(readTabStops);
  // The walk starts at the top of the document, before the first stop.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const { body } = document;
    body.tabIndex = -1;
    body.focus();
    body.removeAttribute('tabindex');
  });
  const limit = stops.count + 5;
  const forward = await walk(page, 'Tab', limit);
  const path = forward.visited.join(' ');
  expect(forward.hasLeft, `${screen}: Tab never leaves: ${path}`).toBe(true);
  for (const stop of stops.keys) {
    expect(
      forward.visited,
      `${screen}: Tab misses ${stop} after ${path}`,
    ).toContain(stop);
  }
  const backward = await walk(page, 'Shift+Tab', limit);
  expect(backward.hasLeft, `${screen}: Shift+Tab never leaves`).toBe(true);
  expect(new Set(backward.visited), `${screen}: Shift+Tab path`).toEqual(
    new Set(forward.visited),
  );
};

export const expectAccessibleScreen = async (page: Page, screen: string) => {
  await expectUsableLayout(page, screen);
  await expectNoFocusTrap(page, screen);
};
