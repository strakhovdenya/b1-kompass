import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import type { ExamContent } from '@b1k/domain';
import {
  PILOT_CONTENT,
  PILOT_TRACK_ID,
} from '../../../scripts/seed-pilot-question';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import {
  readAttemptPage,
  readAttemptRun,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  hashGuestToken,
  resolveGuestSession,
} from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import { FULL_EXAM, FULL_PILOT } from './support/full-exam';
import {
  createPublicClient,
  depsNow,
  insertActiveAttempt,
  latestVersionOf,
  newGuest,
  readAnswers,
  readAttempts,
  readCommandRows,
  readEventKinds,
  readResults,
  readRunRows,
  serviceDb,
  startBody,
  startFor,
  submitStored,
} from './support/db';
import {
  attemptLesenUrl,
  attemptUrl,
  card,
  enterAndStart,
  finishFromShell,
  optionIn,
  expectStatus,
} from './support/guest-browser';
import { TEST_PILOT_KEYS, createTestRecording } from './support/global-setup';
import {
  holdSlotLock,
  installM2Fixtures,
  psql,
  psqlJson,
  quote,
  slotWaiters,
} from './support/sql';

// The explicit start of M2 against the full-set server (3102) and the test
// database: reading never starts, a start is one command with a commandId,
// one active slot per guest session and exam, owner-only migration helpers.

const FULL_ORIGIN = 'http://localhost:3102';

let counter = 0;
const uniqueExam = () => ({
  slug: `test-entry-${Date.now().toString(36)}-${counter++}`,
  title: 'Entry test',
  format: 'DTZ',
});

const publish = async (
  exam: ReturnType<typeof uniqueExam>,
  content: ExamContent = PILOT_CONTENT,
): Promise<string> => {
  const outcome = await publishExamVersion(serviceDb, {
    ...exam,
    content,
    keys: TEST_PILOT_KEYS,
    audio: [{ trackId: PILOT_TRACK_ID, ...createTestRecording() }],
  });
  return outcome.versionId;
};

// The same set with one prompt changed: a correction, published as v2.
const corrected = (content: ExamContent): ExamContent => ({
  ...content,
  questions: content.questions.map((question) =>
    question.id === 'hoeren-2'
      ? { ...question, prompt: `${question.prompt} (v2)` }
      : question,
  ),
});

const examIdOf = async (slug: string): Promise<string> => {
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error(`no exam ${slug}`);
  return latest.examId;
};

interface Counts {
  attempts: number;
  runs: number;
  commands: number;
  starts: number;
}

const countsOf = (sessionId: string): Counts =>
  psqlJson<Counts>(`select json_build_object(
    'attempts', (select count(*) from public.attempts
      where guest_session_id = ${quote(sessionId)}),
    'runs', (select count(*) from public.attempt_runs r
      join public.attempts a on a.id = r.attempt_id
      where a.guest_session_id = ${quote(sessionId)}),
    'commands', (select count(*) from public.attempt_commands
      where guest_session_id = ${quote(sessionId)} and kind = 'start'),
    'starts', (select count(*) from public.guest_events e
      join public.guest_sessions s on s.visitor_id = e.visitor_id
      where s.id = ${quote(sessionId)} and e.kind = 'start'))`);

const NONE: Counts = { attempts: 0, runs: 0, commands: 0, starts: 0 };
const ONE: Counts = { attempts: 1, runs: 1, commands: 1, starts: 1 };

const sessionOf = (created: CreatedGuest): string => created.guest.sessionId;

const accepted = async (
  created: CreatedGuest,
  slug: string,
  commandId: string = randomUUID(),
): Promise<string> => {
  const result = await startFor(depsNow(), created.token, slug, { commandId });
  if (!result.ok || result.result.outcome !== 'accepted') {
    throw new Error(`start not accepted: ${JSON.stringify(result)}`);
  }
  return result.result.attemptId;
};

const httpStart = (
  request: APIRequestContext,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = { origin: FULL_ORIGIN },
) =>
  request.post(`${FULL_ORIGIN}/api/attempts/start`, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `${GUEST_COOKIE}=${token}` } : {}),
      ...headers,
    },
    data: JSON.stringify(body),
    maxRedirects: 0,
  });

const browserOf = async (browser: Browser, token: string) => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return { context, page: await context.newPage() };
};

const pathOf = (page: Page): string => new URL(page.url()).pathname;

// A cancelled attempt written by the trusted owner, as the cancel of #40 or
// the migration will: status, reason and one cancel event.
const cancelAsOwner = (attemptId: string, reason: string) =>
  psql(`begin;
    update public.attempts set status = 'cancelled' where id = ${quote(attemptId)};
    update public.attempt_runs set cancel_reason = ${quote(reason)}
      where attempt_id = ${quote(attemptId)};
    insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
    select 'cancel', s.visitor_id, a.id, clock_timestamp()
    from public.attempts a join public.guest_sessions s
      on s.id = a.guest_session_id
    where a.id = ${quote(attemptId)};
    commit;`);

const NEW_FUNCTIONS = [
  'public.m2_start_attempt(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb)',
  'm2_private.backfill_m1_attempts(uuid)',
  'm2_private.cancel_m1_duplicates()',
  'm2_private.slot_key(uuid, uuid)',
  'm2_private.admit_start(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb, timestamptz)',
  'public.guard_attempt_lifecycle()',
  'public.guard_attempt_run()',
  'public.reject_command_change()',
];

const OWNER_ONLY = NEW_FUNCTIONS.filter((name) =>
  name.startsWith('m2_private'),
);

const privilegeOf = (role: string, fn: string): boolean =>
  psql(
    `select has_function_privilege(${quote(role)}, ${quote(fn)}, 'execute')`,
  ) === 't';

test('selection and restart navigation do not start a run', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL(`**/practice/${FULL_EXAM.slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  const token = (await context.cookies()).find(
    (cookie) => cookie.name === GUEST_COOKIE,
  )?.value;
  if (!token) throw new Error('guest cookie is missing');
  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('guest is missing');
  const { sessionId } = guest;
  expect(countsOf(sessionId)).toEqual(NONE);

  // Reload, prefetch of the RSC payload, the legacy address and both
  // interface languages: still nothing.
  await page.reload();
  await page.request.get(`/practice/${FULL_EXAM.slug}`, {
    headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
  });
  await page.request.get('/practice');
  await page.request.get('/practice/lesen');
  await page.getByTestId('locale-ru').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByTestId('locale-en').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(countsOf(sessionId)).toEqual(NONE);

  // The explicit start creates one empty run pinned to the latest version.
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(`**/practice/${FULL_EXAM.slug}/attempts/*`);
  expect(countsOf(sessionId)).toEqual(ONE);
  const [attempt] = await readAttempts(sessionId);
  if (!attempt) throw new Error('attempt is missing');
  expect(pathOf(page)).toBe(attemptUrl(FULL_EXAM.slug, attempt.id));
  expect(attempt.status).toBe('active');
  expect(await readAnswers(attempt.id)).toEqual({});
  const latest = await latestVersionOf(FULL_EXAM.slug);
  const [run] = await readRunRows(attempt.id);
  expect(run?.assignment.versionId).toBe(latest?.versionId);
  expect(run?.mode).toBe('training');

  // Start again after the result only opens the choice.
  await page.goto(attemptLesenUrl(FULL_EXAM.slug, attempt.id));
  await finishFromShell(page);
  await page.getByTestId('restart-attempt').click();
  await page.waitForURL(`**/practice/${FULL_EXAM.slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  await page.goto('/practice');
  await page.waitForURL(`**/practice/${FULL_EXAM.slug}`);
  expect(countsOf(sessionId)).toEqual(ONE);
  expect((await readAttempts(sessionId)).map((row) => row.status)).toEqual([
    'completed',
  ]);
  await context.close();
});

test('command replay and cross version starts use one active slot', async () => {
  const exam = uniqueExam();
  const v1 = await publish(exam);
  const owner = await newGuest(depsNow());
  const sessionId = sessionOf(owner);

  // A completed start: its command returns the same attempt.
  const completedCommand = randomUUID();
  const completedId = await accepted(owner, exam.slug, completedCommand);
  const finished = await submitStored(depsNow(), owner.token, {
    attemptId: completedId,
  });
  expect(finished.ok).toBe(true);
  const replayCompleted = await startFor(depsNow(), owner.token, exam.slug, {
    commandId: completedCommand,
  });
  expect(replayCompleted).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: completedId },
  });

  // A cancelled start, prepared by the trusted owner: the same.
  const cancelledCommand = randomUUID();
  const cancelledId = await accepted(owner, exam.slug, cancelledCommand);
  cancelAsOwner(cancelledId, 'user');
  const replayCancelled = await startFor(depsNow(), owner.token, exam.slug, {
    commandId: cancelledCommand,
  });
  expect(replayCancelled).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: cancelledId },
  });
  expect(countsOf(sessionId)).toEqual({
    attempts: 2,
    runs: 2,
    commands: 2,
    starts: 2,
  });

  // An active attempt on v1; v2 is published; a start on v2 names the v1
  // attempt: versions of one exam share the slot.
  const activeId = await accepted(owner, exam.slug);
  const v2 = await publish(exam, corrected(PILOT_CONTENT));
  expect(v2).not.toBe(v1);
  const onV2 = await startFor(depsNow(), owner.token, exam.slug);
  expect(onV2).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: activeId },
  });
  const direct = await serviceDb.from('attempts').insert({
    guest_session_id: sessionId,
    exam_id: await examIdOf(exam.slug),
    exam_version_id: v2,
    scope: 'short-set',
  });
  expect(direct.error?.code).toBe('23505');

  // Parallel starts of another guest on v2: one accepted, one active.
  const racer = await newGuest(depsNow());
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      startFor(depsNow(), racer.token, exam.slug),
    ),
  );
  const outcomes = results.map((result) =>
    result.ok ? result.result.outcome : result.failure,
  );
  expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === 'conflict')).toHaveLength(4);
  const ids = new Set(
    results.map((result) => (result.ok ? result.result.attemptId : null)),
  );
  expect(ids.size).toBe(1);
  expect(countsOf(sessionOf(racer))).toEqual(ONE);
  const racerAttempts = await readAttempts(sessionOf(racer));
  const [racerRun] = await readRunRows(racerAttempts[0]?.id ?? '');
  expect(racerRun?.assignment.versionId).toBe(v2);
});

test('legacy practice urls redirect to owned active attempt without starting', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterAndStart(page);
  const token = (await context.cookies()).find(
    (cookie) => cookie.name === GUEST_COOKIE,
  )?.value;
  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('guest is missing');
  const [attempt] = await readAttempts(guest.sessionId);
  if (!attempt) throw new Error('attempt is missing');
  const before = countsOf(guest.sessionId);
  expect(before).toEqual(ONE);

  await page.goto('/practice');
  await expect(card(page, 'hoeren-1')).toBeVisible();
  expect(pathOf(page)).toBe(attemptUrl(FULL_EXAM.slug, attempt.id));
  await page.goto('/practice/lesen');
  await expect(page.getByTestId('reading-text')).toBeVisible();
  expect(pathOf(page)).toBe(attemptLesenUrl(FULL_EXAM.slug, attempt.id));
  expect(countsOf(guest.sessionId)).toEqual(before);
  await context.close();
});

test('start records database time after slot lock', async () => {
  const created = await newGuest(depsNow());
  const examId = await examIdOf(FULL_EXAM.slug);
  const lock = await holdSlotLock(sessionOf(created), examId);
  const pending = startFor(depsNow(), created.token, FULL_EXAM.slug);
  await expect
    .poll(() => slotWaiters(sessionOf(created), examId), { timeout: 15_000 })
    .toBe(1);
  // The start really waits on the slot: nothing is written meanwhile.
  expect(countsOf(sessionOf(created))).toEqual(NONE);
  const beforeRelease = psql('select clock_timestamp()');
  await lock.release();
  const result = await pending;
  expect(result).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!result.ok) throw new Error('start failed');
  const [run] = await readRunRows(result.result.attemptId);
  if (!run) throw new Error('run is missing');
  expect(Date.parse(run.accepted_at)).toBeGreaterThanOrEqual(
    Date.parse(beforeRelease),
  );
  expect(result.result.state.startedAtMs).toBe(Date.parse(run.accepted_at));
});

test('runtime and migration owner privilege controls are explicit', async () => {
  // The runtime role starts; anon and authenticated cannot.
  const created = await newGuest(depsNow());
  await accepted(created, FULL_EXAM.slug);
  const [start] = NEW_FUNCTIONS;
  if (!start) throw new Error('no start function');
  expect(privilegeOf('service_role', start)).toBe(true);
  for (const role of ['anon', 'authenticated']) {
    for (const fn of NEW_FUNCTIONS) expect(privilegeOf(role, fn)).toBe(false);
  }
  for (const fn of OWNER_ONLY)
    expect(privilegeOf('service_role', fn)).toBe(false);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect(
      psql(
        `select has_schema_privilege(${quote(role)}, 'm2_private', 'usage')`,
      ),
    ).toBe('f');
  }

  // Every new function has an explicit ACL without PUBLIC (grantee 0).
  const acl = psqlJson<{ name: string; hasAcl: boolean; hasPublic: boolean }[]>(
    `select json_agg(json_build_object(
      'name', p.oid::regprocedure::text,
      'hasAcl', p.proacl is not null,
      'hasPublic', exists (select 1 from aclexplode(p.proacl) x
        where x.grantee = 0)))
    from pg_proc p where p.oid in (${NEW_FUNCTIONS.map(
      (fn) => `${quote(fn)}::regprocedure`,
    ).join(', ')})`,
  );
  expect(acl).toHaveLength(NEW_FUNCTIONS.length);
  for (const row of acl)
    expect(row).toMatchObject({ hasAcl: true, hasPublic: false });

  // The owner runs the migration helpers: an empty scoped transfer, rolled
  // back.
  const owner = psqlJson<{ filled_exams: number; created_runs: number }>(
    `begin;
    select row_to_json(t) from m2_private.backfill_m1_attempts(${quote(
      randomUUID(),
    )}) t;
    rollback;`,
  );
  expect(owner).toEqual({ filled_exams: 0, created_runs: 0 });
});

test('runtime creates one run while legacy owner fixture permits scoped backfill', async () => {
  const created = await newGuest(depsNow());
  const attemptId = await accepted(created, FULL_EXAM.slug);
  expect(await readRunRows(attemptId)).toHaveLength(1);
  const before = countsOf(sessionOf(created));

  // A second run and an orphan run are refused by the keys.
  expect(() =>
    psql(`begin;
      insert into public.attempt_runs (attempt_id, mode, purpose, selection,
        assignment, accepted_at)
      values (${quote(attemptId)}, 'training', 'normal', 'all',
        '{"versionId":"00000000-0000-4000-8000-000000000000","questionIds":["x"]}',
        now());
      rollback;`),
  ).toThrow(/attempt_runs_pkey/);
  expect(() =>
    psql(`begin;
      insert into public.attempt_runs (attempt_id, mode, purpose, selection,
        assignment, accepted_at)
      values (${quote(randomUUID())}, 'training', 'normal', 'all',
        '{"versionId":"00000000-0000-4000-8000-000000000000","questionIds":["x"]}',
        now());
      rollback;`),
  ).toThrow(/attempt_runs_attempt_id_fkey/);
  expect(countsOf(sessionOf(created))).toEqual(before);

  // The owner may keep a historical attempt without a run and transfer it
  // later, one attempt at a time.
  const other = await newGuest(depsNow());
  const latest = await latestVersionOf(PILOT_EXAM_SLUG);
  if (!latest) throw new Error('pilot is missing');
  const first = randomUUID();
  const second = randomUUID();
  const outcome = psqlJson<{
    transfer: { filled_exams: number; created_runs: number };
    firstRuns: number;
    secondRuns: number;
    questionIds: string[];
  }>(`begin;
    insert into public.attempts (id, guest_session_id, exam_id,
      exam_version_id, scope, status)
    values
      (${quote(first)}, ${quote(sessionOf(other))}, ${quote(latest.examId)},
        ${quote(latest.versionId)}, 'short-set', 'completed');
    insert into public.attempts (id, guest_session_id, exam_id,
      exam_version_id, scope)
    values
      (${quote(second)}, ${quote(sessionOf(other))}, ${quote(latest.examId)},
        ${quote(latest.versionId)}, 'short-set');
    create temp table transfer on commit drop as
      select * from m2_private.backfill_m1_attempts(${quote(first)});
    select json_build_object(
      'transfer', (select row_to_json(t) from transfer t),
      'firstRuns', (select count(*) from public.attempt_runs
        where attempt_id = ${quote(first)}),
      'secondRuns', (select count(*) from public.attempt_runs
        where attempt_id = ${quote(second)}),
      'questionIds', (select assignment -> 'questionIds'
        from public.attempt_runs where attempt_id = ${quote(first)}));
    rollback;`);
  expect(outcome).toEqual({
    transfer: { filled_exams: 0, created_runs: 1 },
    firstRuns: 1,
    secondRuns: 0,
    questionIds: PILOT_CONTENT.questions.map((question) => question.id),
  });
  expect(await readAttempts(sessionOf(other))).toEqual([]);
});

test('attempt reader preserves stored assignment and pinned metadata', async () => {
  const exam = uniqueExam();
  const v1 = await publish(exam);
  const created = await newGuest(depsNow());
  const examId = await examIdOf(exam.slug);
  const attemptId = randomUUID();
  // The full assignment of v1, stored in an order no content gives.
  const stored = PILOT_CONTENT.questions
    .map((question) => question.id)
    .toReversed();
  psql(`begin;
    insert into public.attempts (id, guest_session_id, exam_id,
      exam_version_id, scope, created_at)
    values (${quote(attemptId)}, ${quote(sessionOf(created))}, ${quote(examId)},
      ${quote(v1)}, 'short-set', '2026-11-01T10:00:00Z');
    insert into public.attempt_runs (attempt_id, mode, purpose, selection,
      assignment, accepted_at)
    values (${quote(attemptId)}, 'training', 'normal', 'all',
      ${quote(JSON.stringify({ versionId: v1, questionIds: stored }))}::jsonb,
      '2026-11-01T10:00:00Z');
    commit;`);
  const v2 = await publish(exam, corrected(PILOT_CONTENT));
  expect(v2).not.toBe(v1);

  const read = await readAttemptRun(depsNow(), created.guest, attemptId);
  expect(read).toEqual({
    status: 'ready',
    view: {
      attemptId,
      examId,
      examSlug: exam.slug,
      versionId: v1,
      scope: 'short-set',
      status: 'active',
      mode: 'training',
      purpose: 'normal',
      selection: 'all',
      sourceAttemptId: null,
      questionIds: stored,
      acceptedAt: '2026-11-01T10:00:00+00:00',
    },
  });
  const page = await readAttemptPage(
    depsNow(),
    created.guest,
    exam.slug,
    attemptId,
  );
  if (page.status !== 'ready') throw new Error(page.status);
  expect(page.practice.versionId).toBe(v1);
  expect(page.practice.questions.map((question) => question.prompt)).toEqual(
    PILOT_CONTENT.questions.map((question) => question.prompt),
  );
});

test('refuses a new start while active and detects command payload mismatch', async () => {
  const created = await newGuest(depsNow());
  const sessionId = sessionOf(created);
  const commandId = randomUUID();
  const activeId = await accepted(created, FULL_EXAM.slug, commandId);

  const second = await startFor(depsNow(), created.token, FULL_EXAM.slug);
  expect(second).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: activeId },
  });
  expect(countsOf(sessionId)).toEqual(ONE);

  // The same commandId with another payload (another exam) is refused.
  const mismatch = await startFor(depsNow(), created.token, PILOT_EXAM_SLUG, {
    commandId,
  });
  expect(mismatch).toEqual({ ok: false, failure: 'invalid-input' });
  expect(countsOf(sessionId)).toEqual(ONE);

  // Another exam has its own slot.
  const otherExam = await accepted(created, PILOT_EXAM_SLUG);
  expect(otherExam).not.toBe(activeId);
  expect(countsOf(sessionId)).toEqual({
    attempts: 2,
    runs: 2,
    commands: 2,
    starts: 2,
  });
  expect(await readEventKinds(activeId)).toEqual(['start']);
});

test('foreign attempts and not enabled modes cannot be opened or started', async ({
  browser,
  request,
}) => {
  const owner = await newGuest(depsNow());
  const ownerAttempt = await accepted(owner, FULL_EXAM.slug);
  const saved = await saveAnswer(depsNow(), owner.token, {
    attemptId: ownerAttempt,
    questionId: 'hoeren-1',
    optionId: 'b',
    revision: 1,
  });
  expect(saved.ok).toBe(true);
  const intruder = await newGuest(depsNow());

  // A foreign attempt id is not found, by the reader and by the page.
  expect(
    await readAttemptPage(
      depsNow(),
      intruder.guest,
      FULL_EXAM.slug,
      ownerAttempt,
    ),
  ).toEqual({ status: 'not-found' });
  const foreign = await request.get(attemptUrl(FULL_EXAM.slug, ownerAttempt), {
    headers: { cookie: `${GUEST_COOKIE}=${intruder.token}` },
  });
  expect(foreign.status()).toBe(404);
  expect(await foreign.text()).not.toContain('question-card-hoeren-1');
  expect(await readAnswers(ownerAttempt)).toEqual({ 'hoeren-1': 'b' });

  // Unknown and not yet enabled modes, over HTTP and directly. The single
  // skills are enabled since #41 (free-training.spec.ts), one timed block of
  // one skill since #43 (timed-block.spec.ts); a timed block of the whole
  // set does not exist and the full exam waits for P4.
  const refused: [Record<string, unknown>, number, string][] = [
    [{ mode: 'speed-run' }, 400, 'invalid-input'],
    [{ mode: 'timed-block', selection: 'all' }, 400, 'invalid-input'],
    [{ mode: 'exam' }, 422, 'not-enabled'],
    [{ mode: 'exam', selection: 'hoeren' }, 422, 'not-enabled'],
    [
      { purpose: 'error-repeat', sourceAttemptId: ownerAttempt },
      422,
      'not-enabled',
    ],
  ];
  for (const [overrides, status, failure] of refused) {
    const body = { ...(await startBody(FULL_EXAM.slug)), ...overrides };
    const response = await httpStart(request, intruder.token, body);
    expect(response.status()).toBe(status);
    expect(await response.json()).toEqual({ ok: false, failure });
    const direct = await startFor(
      depsNow(),
      intruder.token,
      FULL_EXAM.slug,
      overrides,
    );
    expect(direct).toEqual({ ok: false, failure });
  }
  expect(countsOf(sessionOf(intruder))).toEqual(NONE);
  expect(countsOf(sessionOf(owner))).toEqual(ONE);

  // The same guest and origin start the enabled training.
  const allowed = await httpStart(
    request,
    intruder.token,
    await startBody(FULL_EXAM.slug),
  );
  expect(allowed.status()).toBe(200);
  expect(await allowed.json()).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });
  expect(countsOf(sessionOf(intruder))).toEqual(ONE);

  const { context, page } = await browserOf(browser, intruder.token);
  const response = await page.goto(attemptUrl(FULL_EXAM.slug, ownerAttempt));
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('training-shell')).toHaveCount(0);
  await context.close();
});

test('legacy rpc and forged host cannot bypass explicit start', async ({
  request,
}) => {
  const created = await newGuest(depsNow());
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');
  const now = new Date().toISOString();
  const legacy = [
    serviceDb.rpc('start_attempt', {
      p_session_id: sessionOf(created),
      p_exam_version_id: latest.versionId,
      p_now: now,
      p_scope: 'full-exam',
    }),
    serviceDb.rpc('open_attempt', {
      p_session_id: sessionOf(created),
      p_exam_version_id: latest.versionId,
      p_now: now,
      p_scope: 'full-exam',
    }),
    serviceDb.rpc('restart_attempt', {
      p_session_id: sessionOf(created),
      p_attempt_id: randomUUID(),
      p_exam_version_id: latest.versionId,
      p_now: now,
      p_scope: 'full-exam',
    }),
  ];
  for (const call of await Promise.all(legacy)) {
    expect(call.error?.code).toBe('PGRST202');
  }
  expect(
    psql(`select count(*) from pg_proc p join pg_namespace n
      on n.oid = p.pronamespace where n.nspname = 'public'
      and p.proname in ('start_attempt', 'open_attempt', 'restart_attempt')`),
  ).toBe('0');

  // A forged Host or forwarded host never stands in for the trusted Origin.
  const body = await startBody(FULL_EXAM.slug);
  const forged: Record<string, string>[] = [
    { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      origin: 'http://evil.example',
    },
    { 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' },
    { 'x-forwarded-host': 'localhost:3102', origin: 'http://evil.example' },
  ];
  for (const headers of forged) {
    const response = await httpStart(request, created.token, body, headers);
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      failure: 'origin-refused',
    });
  }
  expect(countsOf(sessionOf(created))).toEqual(NONE);
});

test('new lifecycle schema rejects public access and identity reopening', async () => {
  const owner = await newGuest(depsNow());
  const attemptId = await accepted(owner, FULL_EXAM.slug);
  const anon = createPublicClient();

  for (const table of ['attempt_runs', 'attempt_commands']) {
    const read = await anon.from(table).select('*');
    expect(read.error).not.toBeNull();
    const written = await anon.from(table).insert({ attempt_id: attemptId });
    expect(written.error).not.toBeNull();
  }
  const started = await anon.rpc('m2_start_attempt', {
    p_session_id: sessionOf(owner),
    p_exam_id: await examIdOf(FULL_EXAM.slug),
    p_command_id: randomUUID(),
    p_mode: 'training',
    p_purpose: 'normal',
    p_selection: 'all',
    p_source_attempt_id: null,
    p_version_id: randomUUID(),
    p_scope: 'full-exam',
    p_question_ids: [],
  });
  expect(started.error).not.toBeNull();

  // The runtime role cannot move an attempt to another guest or version.
  const stranger = await newGuest(depsNow());
  const moved = await serviceDb
    .from('attempts')
    .update({ guest_session_id: sessionOf(stranger) })
    .eq('id', attemptId);
  expect(moved.error?.hint).toBe('attempt_identity_fixed');
  const pilot = await latestVersionOf(PILOT_EXAM_SLUG);
  const repinned = await serviceDb
    .from('attempts')
    .update({ exam_version_id: pilot?.versionId })
    .eq('id', attemptId);
  expect(repinned.error).not.toBeNull();
  const runChanged = await serviceDb
    .from('attempt_runs')
    .update({ mode: 'exam' })
    .eq('attempt_id', attemptId);
  expect(runChanged.error).not.toBeNull();

  // A cancelled duplicate is never reopened.
  cancelAsOwner(attemptId, 'duplicate-m1');
  const reopened = await serviceDb
    .from('attempts')
    .update({ status: 'active' })
    .eq('id', attemptId);
  expect(reopened.error?.hint).toBe('attempt_cancelled');
  const [row] = await readAttempts(sessionOf(owner));
  expect(row).toEqual({ id: attemptId, status: 'cancelled' });
  expect((await readRunRows(attemptId))[0]?.cancel_reason).toBe('duplicate-m1');
  expect(await readAttempts(sessionOf(stranger))).toEqual([]);
});

test('legacy urls without owned active show choice without mutation', async ({
  browser,
}) => {
  const choicePath = `/practice/${FULL_EXAM.slug}`;
  const expectChoice = async (token: string) => {
    const { context, page } = await browserOf(browser, token);
    for (const legacy of ['/practice', '/practice/lesen']) {
      await page.goto(legacy);
      await expect(page.getByTestId('mode-selection')).toBeVisible();
      expect(pathOf(page)).toBe(choicePath);
    }
    await context.close();
  };

  // No attempt at all.
  const empty = await newGuest(depsNow());
  await expectChoice(empty.token);
  expect(countsOf(sessionOf(empty))).toEqual(NONE);

  // Only a cancelled attempt of the exam.
  const cancelled = await newGuest(depsNow());
  const cancelledId = await accepted(cancelled, FULL_EXAM.slug);
  cancelAsOwner(cancelledId, 'user');
  await expectChoice(cancelled.token);
  expect(countsOf(sessionOf(cancelled))).toEqual(ONE);
  expect(await readAttempts(sessionOf(cancelled))).toEqual([
    { id: cancelledId, status: 'cancelled' },
  ]);

  // An active attempt of another exam only.
  const elsewhere = await newGuest(depsNow());
  const pilotId = await accepted(elsewhere, PILOT_EXAM_SLUG);
  await expectChoice(elsewhere.token);
  expect(await readAttempts(sessionOf(elsewhere))).toEqual([
    { id: pilotId, status: 'active' },
  ]);

  // Another guest's active attempt of this exam is not this guest's.
  const neighbour = await newGuest(depsNow());
  await accepted(neighbour, FULL_EXAM.slug);
  const lonely = await newGuest(depsNow());
  await expectChoice(lonely.token);
  expect(countsOf(sessionOf(lonely))).toEqual(NONE);
  expect(countsOf(sessionOf(neighbour))).toEqual(ONE);
});

test('start enforces real guest expiry after waiting slot lock', async () => {
  installM2Fixtures();
  const token = randomBytes(32).toString('base64url');
  const sessionId = psql(
    `select m2_test.insert_guest_ending_in(${quote(hashGuestToken(token))}, 4)`,
  );
  // The Node check passes: the guest is still valid now.
  expect(await resolveGuestSession(depsNow(), token)).not.toBeNull();
  const examId = await examIdOf(FULL_EXAM.slug);
  const lock = await holdSlotLock(sessionId, examId);
  const pending = startFor(depsNow(), token, FULL_EXAM.slug);
  await expect
    .poll(() => slotWaiters(sessionId, examId), { timeout: 15_000 })
    .toBe(1);
  await expect
    .poll(
      () =>
        psql(`select clock_timestamp() >= expires_at from public.guest_sessions
          where id = ${quote(sessionId)}`),
      { timeout: 15_000 },
    )
    .toBe('t');
  await lock.release();
  expect(await pending).toEqual({ ok: false, failure: 'session-invalid' });
  expect(countsOf(sessionId)).toEqual(NONE);
});

test('production start rejects caller controlled time overrides', async ({
  request,
}) => {
  const created = await newGuest(depsNow());
  const body = await startBody(FULL_EXAM.slug);
  for (const field of ['now', 'acceptedAt', 'startedAt', 'p_now']) {
    const response = await httpStart(request, created.token, {
      ...body,
      [field]: '2020-01-01T00:00:00Z',
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      failure: 'invalid-input',
    });
  }

  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');
  const call = await serviceDb.rpc('m2_start_attempt', {
    p_session_id: sessionOf(created),
    p_exam_id: latest.examId,
    p_command_id: randomUUID(),
    p_mode: 'training',
    p_purpose: 'normal',
    p_selection: 'all',
    p_source_attempt_id: null,
    p_version_id: latest.versionId,
    p_scope: 'full-exam',
    p_question_ids: FULL_PILOT.content.questions.map((item) => item.id),
    p_now: '2020-01-01T00:00:00Z',
  });
  expect(call.error?.code).toBe('PGRST202');
  expect(
    psql(`select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'm2_start_attempt'
        and 'timestamptz'::regtype = any (p.proargtypes::regtype[])`),
  ).toBe('0');
  expect(countsOf(sessionOf(created))).toEqual(NONE);
});

test('public and service roles cannot execute owner only migration helpers', async () => {
  // An attempt without a run: any executed transfer would give it one.
  const created = await newGuest(depsNow());
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');
  const runless = await insertActiveAttempt(
    sessionOf(created),
    latest.versionId,
    'full-exam',
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const call of [
      'select * from m2_private.backfill_m1_attempts()',
      'select m2_private.cancel_m1_duplicates()',
    ]) {
      expect(() => psql(`set role ${role}; ${call};`)).toThrow(
        /permission denied/,
      );
    }
  }
  for (const fn of NEW_FUNCTIONS) {
    expect(privilegeOf('anon', fn)).toBe(false);
    expect(privilegeOf('authenticated', fn)).toBe(false);
  }
  for (const fn of OWNER_ONLY)
    expect(privilegeOf('service_role', fn)).toBe(false);
  const publicAcl = psql(`select count(*) from pg_proc p,
    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where x.grantee = 0 and p.oid in (${NEW_FUNCTIONS.map(
      (fn) => `${quote(fn)}::regprocedure`,
    ).join(', ')})`);
  expect(publicAcl).toBe('0');

  // Through the Data API the helpers do not exist at all.
  const anon = createPublicClient();
  for (const client of [anon, serviceDb]) {
    const called = await client.rpc('backfill_m1_attempts', {});
    expect(called.error).not.toBeNull();
  }
  expect(await readRunRows(runless)).toEqual([]);
  expect(await readAttempts(sessionOf(created))).toEqual([
    { id: runless, status: 'active' },
  ]);
});

test('legacy finish cannot complete a cancelled migration duplicate', async () => {
  const created = await newGuest(depsNow());
  const attemptId = await accepted(created, FULL_EXAM.slug);
  const saved = await saveAnswer(depsNow(), created.token, {
    attemptId,
    questionId: 'hoeren-2',
    optionId: 'a',
    revision: 1,
  });
  expect(saved.ok).toBe(true);
  cancelAsOwner(attemptId, 'duplicate-m1');

  // The old finish is gone; neither the submission nor the finalize that
  // replace it closes a cancelled duplicate.
  const submitted = await serviceDb
    .rpc('m2_accept_submission', {
      p_session_id: sessionOf(created),
      p_attempt_id: attemptId,
      p_command_id: randomUUID(),
      p_answers: [{ questionId: 'hoeren-2', optionId: 'b', revision: 2 }],
      p_expected_phase_revision: 0,
      p_expected_skipped: 44,
    })
    .single<{ outcome: string; attempt_status: string }>();
  expect(submitted.data).toMatchObject({
    outcome: 'conflict',
    attempt_status: 'cancelled',
  });
  const finished = await serviceDb.rpc('m2_finalize_attempt', {
    p_session_id: sessionOf(created),
    p_attempt_id: attemptId,
    p_scope: 'full-exam',
    p_score: 0,
    p_max_score: 45,
    p_correct: 0,
    p_incorrect: 1,
    p_skipped: 44,
    p_percent: 0,
    p_hoeren_score: 0,
    p_hoeren_max: 20,
    p_lesen_score: 0,
    p_lesen_max: 25,
    p_level: 'below-A2',
  });
  expect(finished.error?.hint).toBe('attempt_not_submitted');
  const viaServer = await submitStored(depsNow(), created.token, {
    attemptId,
  });
  expect(viaServer.ok).toBe(false);

  expect(await readAttempts(sessionOf(created))).toEqual([
    { id: attemptId, status: 'cancelled' },
  ]);
  expect((await readRunRows(attemptId))[0]?.cancel_reason).toBe('duplicate-m1');
  expect(await readAnswers(attemptId)).toEqual({ 'hoeren-2': 'a' });
  expect(await readResults(attemptId)).toEqual([]);
  expect(await readEventKinds(attemptId)).toEqual(['start', 'cancel']);
});

test('version changing entry fixtures remain isolated by exam slug', async () => {
  const changing = uniqueExam();
  const steady = uniqueExam();
  const [changingV1, steadyV1] = await Promise.all([
    publish(changing),
    publish(steady),
  ]);
  const created = await newGuest(depsNow());
  const steadyId = await accepted(created, steady.slug);
  await saveAnswer(depsNow(), created.token, {
    attemptId: steadyId,
    questionId: 'hoeren-1',
    optionId: 'c',
    revision: 1,
  });
  const finished = await submitStored(depsNow(), created.token, {
    attemptId: steadyId,
  });
  expect(finished.ok).toBe(true);
  const snapshotOf = () =>
    psqlJson<unknown>(`select json_build_object(
      'attempt', (select to_jsonb(a) from public.attempts a
        where a.id = ${quote(steadyId)}),
      'run', (select to_jsonb(r) from public.attempt_runs r
        where r.attempt_id = ${quote(steadyId)}),
      'answers', (select jsonb_agg(to_jsonb(x)) from public.attempt_answers x
        where x.attempt_id = ${quote(steadyId)}),
      'result', (select to_jsonb(res) from public.attempt_results res
        where res.attempt_id = ${quote(steadyId)}))`);
  const before = snapshotOf();

  // The other exam gets a start, then a v2 published in parallel with a
  // scoped transfer and a start of a second guest on it.
  const changingId = await accepted(created, changing.slug);
  const racer = await newGuest(depsNow());
  const [changingV2] = await Promise.all([
    publish(changing, corrected(PILOT_CONTENT)),
    Promise.resolve().then(() =>
      psql(
        `select * from m2_private.backfill_m1_attempts(${quote(changingId)})`,
      ),
    ),
    startFor(depsNow(), racer.token, changing.slug),
  ]);
  expect(changingV2).not.toBe(changingV1);
  const [changingRun] = await readRunRows(changingId);
  expect(changingRun?.assignment.versionId).toBe(changingV1);

  expect(snapshotOf()).toEqual(before);
  expect((await latestVersionOf(steady.slug))?.versionId).toBe(steadyV1);
  const [steadyRun] = await readRunRows(steadyId);
  expect(steadyRun?.assignment.versionId).toBe(steadyV1);
});

test('lifecycle journals remain append only without credential fields', async () => {
  const created = await newGuest(depsNow());
  const commandId = randomUUID();
  const attemptId = await accepted(created, FULL_EXAM.slug, commandId);
  cancelAsOwner(attemptId, 'user');

  const events = await serviceDb
    .from('guest_events')
    .update({ kind: 'finish' })
    .eq('attempt_id', attemptId);
  expect(events.error).not.toBeNull();
  const removed = await serviceDb
    .from('guest_events')
    .delete()
    .eq('attempt_id', attemptId);
  expect(removed.error).not.toBeNull();
  const changed = await serviceDb
    .from('attempt_commands')
    .update({ attempt_id: randomUUID() })
    .eq('command_id', commandId);
  expect(changed.error).not.toBeNull();
  const deleted = await serviceDb
    .from('attempt_commands')
    .delete()
    .eq('command_id', commandId);
  expect(deleted.error).not.toBeNull();
  expect(() =>
    psql(`begin;
      update public.attempt_commands set kind = 'start'
      where command_id = ${quote(commandId)};
      rollback;`),
  ).toThrow(/an accepted command is final/);

  // A replay writes no second event.
  const replay = await startFor(depsNow(), created.token, FULL_EXAM.slug, {
    commandId,
  });
  expect(replay).toMatchObject({
    ok: true,
    result: { attemptId, outcome: 'accepted' },
  });
  expect(await readEventKinds(attemptId)).toEqual(['start', 'cancel']);
  expect(await readCommandRows(sessionOf(created))).toEqual([
    { command_id: commandId, kind: 'start', attempt_id: attemptId },
  ]);

  const columns = psql(`select string_agg(table_name || '.' || column_name, ',')
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('attempt_runs', 'attempt_commands', 'guest_events')
      and column_name ~ '(token|ip|address|agent|fingerprint_of_device)'`);
  expect(columns).toBe('');
});

test('missing run fails closed and database rejects duplicate or orphan metadata', async ({
  browser,
}) => {
  const created = await newGuest(depsNow());
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full set is missing');
  const attemptId = await insertActiveAttempt(
    sessionOf(created),
    latest.versionId,
    'full-exam',
  );
  expect(
    await readAttemptPage(depsNow(), created.guest, FULL_EXAM.slug, attemptId),
  ).toEqual({ status: 'incompatible' });
  expect(await readAttemptRun(depsNow(), created.guest, attemptId)).toEqual({
    status: 'incompatible',
  });

  const { context, page } = await browserOf(browser, created.token);
  await page.goto('/practice');
  expect(pathOf(page)).toBe(attemptUrl(FULL_EXAM.slug, attemptId));
  await expect(page.getByTestId('attempt-incompatible')).toBeVisible();
  await expect(page.locator('[data-testid^="question-card-"]')).toHaveCount(0);
  await context.close();

  // A new start does not replace it with a default assignment.
  const start = await startFor(depsNow(), created.token, FULL_EXAM.slug);
  expect(start).toEqual({ ok: false, failure: 'unavailable' });
  expect(countsOf(sessionOf(created))).toEqual({
    attempts: 1,
    runs: 0,
    commands: 0,
    starts: 0,
  });

  const runSql = (id: string) => `insert into public.attempt_runs
    (attempt_id, mode, purpose, selection, assignment, accepted_at)
    values (${quote(id)}, 'training', 'normal', 'all',
      ${quote(JSON.stringify({ versionId: latest.versionId, questionIds: ['hoeren-1'] }))},
      now());`;
  expect(() =>
    psql(`begin; ${runSql(attemptId)} ${runSql(attemptId)} rollback;`),
  ).toThrow(/attempt_runs_pkey/);
  expect(() => psql(`begin; ${runSql(randomUUID())} rollback;`)).toThrow(
    /attempt_runs_attempt_id_fkey/,
  );
  expect(await readRunRows(attemptId)).toEqual([]);
});

test('failed run insertion rolls back entire start transaction', async () => {
  installM2Fixtures();
  const exam = uniqueExam();
  await publish(exam);
  const examId = await examIdOf(exam.slug);
  const created = await newGuest(depsNow());
  const neighbourId = await accepted(created, FULL_EXAM.slug);
  const trigger = `fail_run_${examId.replaceAll('-', '')}`;
  psql(`create function m2_test.${trigger}() returns trigger
    language plpgsql set search_path = '' as $$
    begin
      if exists (select 1 from public.attempts
        where id = new.attempt_id and exam_id = ${quote(examId)}) then
        raise exception 'run insert failed for the test exam';
      end if;
      return new;
    end $$;
    create trigger ${trigger} before insert on public.attempt_runs
      for each row execute function m2_test.${trigger}();`);
  try {
    const result = await startFor(depsNow(), created.token, exam.slug);
    expect(result).toEqual({ ok: false, failure: 'unavailable' });
  } finally {
    psql(`drop trigger ${trigger} on public.attempt_runs;
      drop function m2_test.${trigger}();`);
  }
  expect(countsOf(sessionOf(created))).toEqual(ONE);
  expect(await readAttempts(sessionOf(created))).toEqual([
    { id: neighbourId, status: 'active' },
  ]);
  expect(
    psql(`select count(*) from public.attempts
      where exam_id = ${quote(examId)}`),
  ).toBe('0');
});

test('reader rejects conflicting snapshot and duplicate canonical run fields', async () => {
  const columns = psql(`select string_agg(column_name, ',' order by column_name)
    from information_schema.columns
    where table_schema = 'public' and table_name = 'attempt_runs'`);
  expect(columns.split(',')).not.toContain('scope');
  expect(columns.split(',')).not.toContain('exam_version_id');
  expect(columns.split(',')).not.toContain('exam_id');

  const exam = uniqueExam();
  const v1 = await publish(exam);
  const v2 = await publish(exam, corrected(PILOT_CONTENT));
  const created = await newGuest(depsNow());
  const examId = await examIdOf(exam.slug);
  const attemptId = randomUUID();
  const ids = PILOT_CONTENT.questions.map((question) => question.id);
  psql(`begin;
    insert into public.attempts (id, guest_session_id, exam_id,
      exam_version_id, scope)
    values (${quote(attemptId)}, ${quote(sessionOf(created))}, ${quote(examId)},
      ${quote(v1)}, 'short-set');
    insert into public.attempt_runs (attempt_id, mode, purpose, selection,
      assignment, accepted_at)
    values (${quote(attemptId)}, 'training', 'normal', 'all',
      ${quote(JSON.stringify({ versionId: v2, questionIds: ids }))}::jsonb,
      now());
    commit;`);
  const before = await readRunRows(attemptId);

  expect(await readAttemptRun(depsNow(), created.guest, attemptId)).toEqual({
    status: 'incompatible',
  });
  expect(
    await readAttemptPage(depsNow(), created.guest, exam.slug, attemptId),
  ).toEqual({ status: 'incompatible' });
  expect(await readRunRows(attemptId)).toEqual(before);
  const [attempt] = await readAttempts(sessionOf(created));
  expect(attempt).toEqual({ id: attemptId, status: 'active' });
  expect(
    psql(`select exam_version_id from public.attempts
      where id = ${quote(attemptId)}`),
  ).toBe(v1);
});

test.describe('browser save on a started attempt', () => {
  test('started attempt saves and reloads by its address', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await enterAndStart(page);
    const target = card(page, 'hoeren-1');
    await optionIn(target, 'b').check();
    await expectStatus(target, 'saved');
    const path = pathOf(page);
    await page.reload();
    expect(pathOf(page)).toBe(path);
    await expect(optionIn(card(page, 'hoeren-1'), 'b')).toBeChecked();
    await context.close();
  });
});
