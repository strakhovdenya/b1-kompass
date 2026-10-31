# CLAUDE.md — apps/web

Rules specific to the Next.js app. The root `CLAUDE.md` is authoritative for scope, invariants and process; this file adds app detail only.

## Stack

Next.js 16 App Router, React 19, TypeScript strict, MUI 7 (`@mui/material-nextjs/v16-appRouter`, Emotion), next-intl 4 without i18n routing, `@supabase/supabase-js` on the server only. Exact versions are pinned in `package.json`.

## Structure

```text
src/app/                 routes (server components); pages pass server actions to client components as props
src/features/<feature>/  client UI ('use client'): uses @b1k/domain contracts and next-intl only
src/server/              trusted server code
  db.ts                  service_role client, Clock, ServerDeps, ruleViolation()
  guest-session/         createGuestSession, resolveGuestSession (the single credential check), setGuestLocale
  attempts/              openPractice, saveAnswer (strict input schema)
  material/              getPublishedVersion: public projection only
  next/                  Next glue: cookie b1k_guest, getCurrentGuest (React cache), 'use server' actions
src/i18n/request.ts      locale from the guest session, English otherwise
src/theme/               MUI theme (blue B1 Kompass palette)
messages/{en,ru}.json    every UI string, both languages
tests/                   Playwright specs (*.spec.ts) and tests/support helpers
```

## Rules

- `src/features/**` and `src/theme/**` never import `src/server/**` or `@supabase/*`; ESLint fails the build of such an import.
- Server functions take `ServerDeps` explicitly; only `src/server/next/**` touches `cookies()` and `process.env`. Keep it that way so tests can call the real functions with a fixed clock.
- Every user-visible string goes through next-intl with keys in both `en.json` and `ru.json`. German exam text is rendered as is, with `lang="de"`.
- Render material as text; `dangerouslySetInnerHTML` is not used.
- Status is never shown by colour alone: text (and an icon where useful) goes with it. Use `role="status"` / `role="alert"` for save states.
- "Saved" appears only after the server confirmed the latest choice; a failed save keeps the selection and offers a retry.
- Guest pages are dynamic and served with `Cache-Control: private, no-store` (`next.config.ts`); do not add static caching to pages with personal data.
- New server operations get negative tests: missing session, foreign attempt, extra fields, direct Data API/Storage access with the publishable key.

## Commands

From the repository root: `npm run build`, `npm run test:e2e` (needs `npm run db:start` and a build), `npm test` for component tests (`src/**/*.test.tsx`, rendered with `react-dom/server`). Local dev: `npm run dev --workspace apps/web` with `apps/web/.env.local` (template `.env.example`).

## Tests

`tests/guest-entry.spec.ts` drives the browser against `next start` on port 3100 and calls server functions directly with `tests/support/db.ts` (service client, publishable-key client, fixed clock). `globalSetup` publishes the real pilot question through `scripts/seed-pilot-question.ts` with a test-only key. Test names are referenced by Issue Acceptance Criteria: do not rename them.

Locators in Playwright specs must not depend on translated UI text when the page language can change in the test (EN/RU switch, a guest with another locale). Use `getByTestId` for controls that need it (for example `go-to-question-<number>`, `save-status`, `set-position`, `audio-element`); a missing test id is added to the component in the same change. Matching visible text is acceptable only for German material (it is never translated) and for steps that run strictly in one known language. Never copy a translation from `messages/*.json` into a test regex.
