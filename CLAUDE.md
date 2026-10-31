# CLAUDE.md

Always-on rules and routing for Claude Code in this repository. Task procedures live in skills, system knowledge in `docs/` and the app-level `apps/web/CLAUDE.md`. Do not copy those procedures here.

## Project

B1 Kompass is an online German A2–B1 exam trainer (DTZ Hören and Lesen) for phone and desktop, with an English / Русский interface. The first release M1 is a guest trainer: one real prepared exam, original audio, server-side checking and cloud storage. It is a separate project from Cards: never reuse Cards data, secrets or configuration.

## Read first

- The active GitHub Issue is the execution spec. Task branches follow `branchTemplate` of `.factory/profile.json` (`task/ISSUE-<n>-<slug>`).
- Read the sections the Issue lists in `## Docs to Read`; read further or stop and ask when the context is not enough to satisfy the Acceptance Criteria.
- Before writing a new PRD, plan or Issue, read `docs/architecture-evolution.md` and the current affected code. Carry applicable `ARC-xx` prerequisites into the PRD's architectural impact, the plan's dependencies, and the Issue's Docs to Read / Key Invariants / Affects; explain non-applicability. Deferred extensions are not automatically added to M1.
- When an approved plan enters implementation, load `task-lifecycle` before Issue/branch changes or the first edit; reload it before closure, commit and PR.
- Load the metaskills the skill gate asks for before editing `.ts`/`.tsx` files.

## Routing

| Need | Source |
| --- | --- |
| Implementation → closure → PR | `.claude/skills/task-lifecycle/SKILL.md` |
| Issue body format, creating/editing issues | `.claude/skills/issues/SKILL.md`, `node_modules/dark-factory/verifier/issue-contract.md` |
| PRD / plan / next epic | `prd`, `plan`, `epic-discovery` skills; documents in `docs/prd`, `docs/plans` |
| Product scope and decisions | `docs/project-overview.md`, `docs/project-decisions.md` (large: read only the needed section), `docs/roadmap.md` |
| Modules, material/version/attempt, guest session | `docs/architecture.md` |
| Architecture prerequisites for future PRDs, plans and Issues | `docs/architecture-evolution.md` |
| Access matrix, RLS, grants, Storage | `docs/security.md` |
| Stack, env vars, local run, CI, Supabase/Vercel | `docs/deployment.md` |
| Web app structure, commands, UI rules | `apps/web/CLAUDE.md` |
| Installed factory (hooks, verifier, Ralph) | `node_modules/dark-factory/` (`README.md`, `hooks/README.md`); project values in `.factory/profile.json` |

## Layout

npm workspaces, one lockfile at the root:

```text
apps/web/          Next.js app: UI, server actions, trusted server code (src/server)
packages/domain/   pure rules and contracts: material schema, single choice, guest term, locales
scripts/           trusted owner tools (secret key), e.g. seed-pilot-question.ts
supabase/          config.toml and migrations of the isolated Supabase project
docs/              PRD, plan, architecture, security, deployment
```

## Commands (repository root)

```sh
npm ci
npm run typecheck    # domain, web, scripts
npm run lint         # ESLint + Prettier check of .ts/.tsx (npm run format fixes it)
npm test             # Vitest: packages/domain, apps/web/src
npm run build
npm run db:start     # local Supabase in Docker; needed for E2E
npm run test:e2e     # Playwright apps/web/tests against local Supabase + next start
```

CI (`.github/workflows/ci.yml`, workflow `CI`, job `Quality`) runs all of them on Node 24. `Quality` is the required check of the verifier; do not rename the workflow or the job.

## Invariants

- Material is separate from attempts. A published `exam_versions` row and its `answer_keys` are immutable; changed material is a new version. The key comes from the source, never from a model.
- The answer key never reaches the browser before review: not in HTML, initial data, public resources or shared caches.
- Guests are not Supabase Auth users. One `guest_sessions` row per browser session, term fixed at `created_at + 720 hours`, never extended; `now >= expires_at` is rejected.
- The interface language belongs to the guest session only; a new guest starts in English. German material is never translated.
- Every server operation checks the session itself (`resolveGuestSession` plus the database function). Client-sent role, owner, score or status are rejected.
- The privileged Supabase client exists only in `apps/web/src/server` and `scripts/`. UI code imports neither, nor the Supabase SDK (ESLint enforces it).
- `anon`/`authenticated` have no rights on tables or functions; RLS stays enabled. A migration that adds a table or function must keep this and extend the negative tests.
- Results are computed by the server; repeating a completion must not create a second result.

## Rules

- Keep changes inside the Issue's `## Affects`; stop and ask when the work needs more.
- Tests of changed logic go into the same change. Verify through the real function and a re-read of the test database; never mock a ready success or a finished score.
- New migrations go to `supabase/migrations/` with a new timestamp; never edit an applied migration.
- Secrets never enter Git, logs or client bundles. `.env*` and `private/` are ignored; the publisher's answer keys live in `private/`.
- Do not claim deployment, cloud checks or a factory run that did not happen; mark them as not verified.

## Factory hooks

`.claude/settings.json` wires the hooks of the pinned `dark-factory` (`v0.1.3`): skill gate on `Write|Edit`, closure gate on `git commit`/`git push` and `gh issue create|edit`, lint/typecheck helpers from the profile.

The gates fail closed. Never delete `node_modules` (or `node_modules/dark-factory`) from inside a Claude Code session: every Bash call and edit is then blocked. Repair from an ordinary terminal at the repository root with `npm.cmd ci` (Windows PowerShell blocks `npm.ps1`), then return to the session.
