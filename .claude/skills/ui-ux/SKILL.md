---
name: ui-ux
description: UI/UX and accessibility rules for the B1 Kompass web app (phone and desktop, EN/RU, MUI 7). Load before editing .ts/.tsx in apps/web; also use to review a screen against the rules. Based on Vercel's Web Interface Guidelines, adapted to MUI, next-intl and the exam-trainer invariants.
---

# UI/UX rules for apps/web

Project rules live in `apps/web/CLAUDE.md` (i18n keys in both languages, no colour-only status, `role="status"`/`role="alert"`, "Saved" only after the server confirmed, `data-testid` in Playwright, no `dangerouslySetInnerHTML`). This skill adds the interface rules; do not restate those project rules here.

Generic rules below come from [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines), translated to MUI. Nothing is fetched at run time.

## Product context

Guests train for a timed exam, often on a phone, with audio. A mistake costs time and trust: the screen must be calm, predictable and forgiving. The interface language is EN or RU; German exam material is never translated and is rendered with `lang="de"`.

## Phone first

- Design at 360 px width first. The answer area is never covered by a timer, banner or sticky bar; the timer is a compact status line, not a modal.
- Touch targets are at least 44×44 px (MUI `size="large"` or padding), with space between neighbouring answers so a thumb does not hit the wrong option.
- Respect safe areas (`env(safe-area-inset-*)`) for fixed bars. No horizontal scroll at any width; check long German words (`overflowWrap: 'anywhere'` on text, `minWidth: 0` on flex children).
- Do not rely on hover; every action has a tap and keyboard path. Gestures (swipe) always have a button alternative.

## Accessibility

- Semantic elements first (`button`, `a`, `nav`, `main`, `h1`…`h6`); ARIA only to fill gaps. One `h1` per page, headings in order.
- Every control has an accessible name (visible label or `aria-label` from next-intl). Icon-only buttons need `aria-label`.
- Questions with choices are a labelled group (`RadioGroup` with `FormLabel`, or `fieldset`/`legend`). The selected state is exposed to assistive technology, not only by colour.
- Keyboard: all actions reachable in logical order, visible focus ring (keep the MUI/theme `:focus-visible` style; never remove an outline without a replacement), no keyboard traps in dialogs, focus returns to the trigger on close.
- Async changes are announced: `role="status"` (polite) for save and phase changes, `role="alert"` for errors and for time running out. The timer is not announced every second; announce stage changes and a few milestones.
- Contrast meets WCAG AA (4.5:1 text, 3:1 large text and controls). Respect `prefers-reduced-motion`.
- Audio: a real `<audio>` with visible controls and a text alternative of its state (playing, paused, position); never autoplay.

## Forms and input

- Inputs have `name`, correct `type`/`inputMode`/`autoComplete`; never block paste.
- Errors are inline next to the field, say what happened and how to fix it, and keep what the user already entered.
- Destructive or irreversible actions (submit, cancel an attempt, start over) ask for confirmation in a dialog with a specific button text ("Submit answers", not "OK"), and explain what the action keeps and what it ends.
- Warn before leaving with unsent changes only when changes are really unsent; otherwise save quietly and show the confirmed state.

## State and navigation

- Reflect state in the URL where it should survive a refresh or sharing (attempt id, block); use real links (`next/link`, MUI `Link`) for navigation and buttons for actions.
- Every screen has all four states designed: loading (skeleton or text with `…`), empty ("Нет заданий для повторения"-style, with the next step), error (with retry), success.
- Disable a submit button only while the request runs; a failed request re-enables it and keeps the selection.

## Content, typography and i18n

- All text through next-intl; check the longest of EN/RU/DE in each place. Never concatenate translated fragments; use ICU placeholders.
- Format numbers, dates, durations with `Intl` / next-intl formatters; use `font-variant-numeric: tabular-nums` for timers and scores so digits do not jump.
- Use the typographic ellipsis `…` and non-breaking space between a number and its unit. Active voice, specific button labels, errors that name the fix.
- Truncate long text deliberately (`noWrap` or line clamp) only where full text is available elsewhere; never truncate exam material.

## Motion and performance

- Animate only `transform` and `opacity`; no `transition: all`; short and interruptible. Honour reduced motion (MUI `useMediaQuery('(prefers-reduced-motion: reduce)')`).
- Images and media have explicit dimensions (`next/image` with width/height), lazy below the fold. Lists over ~50 items are virtualised or paginated.
- Do not read layout during render; keep controlled inputs cheap (no heavy work per keystroke).

## Review output

When asked to review a screen, report findings per file as `path:line — problem → fix`, terse, ordered by severity (accessibility and exam-flow blockers first); mark clean files `✓ pass`. Check at least: phone width, RU and EN, keyboard-only, screen reader names, reduced motion, and the four states.
