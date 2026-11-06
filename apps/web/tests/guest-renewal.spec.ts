import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import { createTimingProfileRevision } from '../../../scripts/manage-timing-profile';
import type { TimingSettings } from '../../../scripts/manage-timing-profile';
import {
  preflightTimedStart,
  readAttemptStatus,
  saveAnswer,
  saveProgress,
} from '../src/server/attempts/attempts';
import type { ServerDeps } from '../src/server/db';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  hashGuestToken,
  replaceGuestSession,
  resolveGuestSession,
  setGuestLocale,
} from '../src/server/guest-session/session';
import type {
  CreatedGuest,
  GuestContext,
} from '../src/server/guest-session/session';
import {
  createPublicClient,
  depsAt,
  depsNow,
  latestVersionOf,
  newGuest,
  openStarted,
  readAnswers,
  readAttempts,
  readResults,
  readRunRows,
  readSession,
  readSessionByToken,
  serviceDb,
  startBody,
  startFor,
  submitStored,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TRACK_ID,
  SHORT_TIMING,
  ensureConfirmedTestProfile,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import { installM2Fixtures, psql, quote, sqlRunnerAs } from './support/sql';
import {
  CHOICE_URL,
  HOEREN_URL,
  attemptIdOf,
  attemptLesenUrl,
  attemptUrl,
  startFromChoice,
} from './support/guest-browser';

// The synthetic full set. Events are read per visitor_id or attempt_id:
// other specs write their own events at the same time.

const { keys } = FULL_PILOT;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const PLAY_FROM_SECONDS = 5;
const OLD_POSITION_SECONDS = 20;

interface StoredEvent {
  kind: 'entry' | 'start' | 'finish';
  visitor_id: string;
  attempt_id: string | null;
}

interface EventCounts {
  entry: number;
  start: number;
  finish: number;
}

interface StoredAttemptRow {
  id: string;
  status: string;
  progress: unknown;
}

const keyOf = (questionId: string): string => {
  const key = keys[questionId];
  if (!key) throw new Error(`no key for ${questionId}`);
  return key;
};

const readEvents = async (visitorId: string): Promise<StoredEvent[]> => {
  const { data, error } = await serviceDb
    .from('guest_events')
    .select('kind, visitor_id, attempt_id')
    .eq('visitor_id', visitorId)
    .returns<StoredEvent[]>();
  if (error) throw error;
  return data;
};

const countEvents = async (visitorId: string): Promise<EventCounts> => {
  const counts: EventCounts = { entry: 0, start: 0, finish: 0 };
  for (const event of await readEvents(visitorId)) counts[event.kind] += 1;
  return counts;
};

const hasAttemptEvents = (
  attemptIds: readonly string[],
  events: StoredEvent[],
) =>
  events
    .filter((event) => event.attempt_id !== null)
    .map((event) => `${event.kind}:${event.attempt_id}`)
    .sort()
    .join(',') ===
  attemptIds
    .flatMap((id) => [`finish:${id}`, `start:${id}`])
    .sort()
    .join(',');

const readStoredAttempts = async (
  sessionId: string,
): Promise<StoredAttemptRow[]> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('id, status, progress')
    .eq('guest_session_id', sessionId)
    .order('created_at')
    .returns<StoredAttemptRow[]>();
  if (error) throw error;
  return data;
};

const readVisitorId = async (sessionId: string): Promise<string> => {
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .select('visitor_id')
    .eq('id', sessionId)
    .single<{ visitor_id: string }>();
  if (error) throw error;
  return data.visitor_id;
};

const openReady = async (
  deps: ServerDeps,
  created: { token: string; guest: GuestContext },
) => {
  const opened = await openStarted(deps, created, FULL_EXAM.slug);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  return opened.practice;
};

const save = async (
  deps: ServerDeps,
  token: string,
  attemptId: string,
  questionId: string,
) => {
  const saved = await saveAnswer(deps, token, {
    attemptId,
    questionId,
    optionId: keyOf(questionId),
    revision: 1,
  });
  if (!saved.ok) throw new Error(`save ${questionId}: ${saved.error}`);
};

const finish = async (token: string, attemptId: string) => {
  const result = await submitStored(depsNow(), token, { attemptId });
  if (!result.ok) throw new Error(`finish: ${result.error}`);
  return result.review;
};

// "Start again" only opens the choice; the new run is a new explicit start
// with its own commandId. While an attempt of the exam is active the start
// is a conflict that names it, so a repeat never creates a second one.
const restart = async (token: string) => {
  const result = await startFor(depsNow(), token, FULL_EXAM.slug);
  if (!result.ok) throw new Error(`start again: ${result.failure}`);
  return result.result.attemptId;
};

// A guest whose first attempt has stored answers and is completed.
const completedGuest = async () => {
  const created = await newGuest(depsNow());
  const practice = await openReady(depsNow(), created);
  await save(depsNow(), created.token, practice.attemptId, 'hoeren-1');
  await save(depsNow(), created.token, practice.attemptId, 'lesen-1');
  await finish(created.token, practice.attemptId);
  return { ...created, completedId: practice.attemptId };
};

const tokenOf = async (context: BrowserContext): Promise<string> => {
  const cookie = (await context.cookies()).find((c) => c.name === GUEST_COOKIE);
  if (!cookie) throw new Error('guest cookie is missing');
  return cookie.value;
};

const sessionOf = async (context: BrowserContext) => {
  const session = await readSessionByToken(await tokenOf(context));
  if (!session) throw new Error('guest session is missing');
  return session;
};

// Entry through the real home page and an explicit start from the choice;
// the page language is English here.
const enterAsGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL(CHOICE_URL);
  await startFromChoice(page);
  await expect(page.getByTestId('question-card-hoeren-1')).toBeVisible();
};

const browserGuest = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await enterAsGuest(page);
  const token = await tokenOf(context);
  const session = await sessionOf(context);
  const [attempt] = await readAttempts(session.id);
  if (!attempt) throw new Error('attempt is missing');
  return { context, page, token, sessionId: session.id, attemptId: attempt.id };
};

const shellAttemptId = (page: Page) =>
  page.getByTestId('training-shell').getAttribute('data-attempt-id');

const audioOf = (page: Page) => page.getByTestId('audio-element');

const waitForPlayer = async (page: Page) => {
  await expect(page.getByTestId('audio-status')).toHaveAttribute(
    'data-status',
    'ready',
  );
  await expect
    .poll(() => audioOf(page).evaluate((e: HTMLAudioElement) => e.duration))
    .toBeGreaterThan(10);
};

const currentTimeOf = (page: Page): Promise<number> =>
  audioOf(page).evaluate((element: HTMLAudioElement) => element.currentTime);

const positionOf = (progress: unknown): number =>
  (progress as { positionSeconds?: number } | null)?.positionSeconds ?? 0;

const checkedCount = (page: Page) =>
  page.locator('[data-testid^="question-card-"] input:checked').count();

test('expiry creates fresh guest without sliding deadline', async ({
  browser,
  baseURL,
}) => {
  const created = await newGuest(depsNow());
  const before = await readSession(created.guest.sessionId);
  const expiresAt = new Date(before.expires_at).getTime();

  const nearDeadline = depsAt(new Date(expiresAt - MINUTE_MS));
  const read = await resolveGuestSession(nearDeadline, created.token);
  expect(read?.sessionId).toBe(created.guest.sessionId);
  const practice = await openReady(nearDeadline, created);
  await save(nearDeadline, created.token, practice.attemptId, 'hoeren-1');
  expect(await readSession(created.guest.sessionId)).toEqual(before);

  // After the term the old token is refused and a new entry is a new guest.
  const afterExpiry = depsAt(new Date(expiresAt + MINUTE_MS));
  expect(await resolveGuestSession(afterExpiry, created.token)).toBeNull();
  const fresh = await newGuest(afterExpiry);
  expect(fresh.guest.sessionId).not.toBe(created.guest.sessionId);
  expect(fresh.guest.visitorId).not.toBe(created.guest.visitorId);
  expect((await readSession(fresh.guest.sessionId)).locale).toBe('en');

  // The browser of a guest whose Russian session has ended.
  const previous = await newGuest(depsAt(new Date(Date.now() - 31 * DAY_MS)));
  await serviceDb
    .from('guest_sessions')
    .update({ locale: 'ru' })
    .eq('id', previous.guest.sessionId)
    .throwOnError();
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: previous.token, url: baseURL },
  ]);
  const page = await context.newPage();
  await enterAsGuest(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const current = await sessionOf(context);
  expect(current.id).not.toBe(previous.guest.sessionId);
  expect(current.locale).toBe('en');
  const currentVisitor = await readVisitorId(current.id);
  expect(currentVisitor).not.toBe(previous.guest.visitorId);
  expect(await countEvents(currentVisitor)).toEqual({
    entry: 1,
    start: 1,
    finish: 0,
  });
  const kept = await readSession(previous.guest.sessionId);
  expect(kept.locale).toBe('ru');
  expect(new Date(kept.expires_at).getTime()).toBe(
    previous.guest.expiresAt.getTime(),
  );
  await context.close();
});

test('old guest rejected at exact expiry', async () => {
  const created = await newGuest(depsNow());
  const practice = await openReady(depsNow(), created);
  await save(depsNow(), created.token, practice.attemptId, 'hoeren-1');
  const events = await readEvents(created.guest.visitorId);
  expect(await countEvents(created.guest.visitorId)).toEqual({
    entry: 1,
    start: 1,
    finish: 0,
  });
  const atExpiry = depsAt(created.guest.expiresAt);

  expect(
    await saveAnswer(atExpiry, created.token, {
      attemptId: practice.attemptId,
      questionId: 'hoeren-1',
      optionId: keyOf('hoeren-1') === 'a' ? 'b' : 'a',
      revision: 2,
    }),
  ).toEqual({ ok: false, error: 'session-invalid' });

  expect(await readAnswers(practice.attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
  });
  expect(await readEvents(created.guest.visitorId)).toEqual(events);
});

test('restart button opens new empty attempt retaining history', async ({
  browser,
}) => {
  const { context, page, token, sessionId, attemptId } =
    await browserGuest(browser);
  await save(depsNow(), token, attemptId, 'hoeren-1');
  await save(depsNow(), token, attemptId, 'lesen-1');
  const progressed = await saveProgress(depsNow(), token, {
    attemptId,
    progress: { block: 'hoeren', positionSeconds: OLD_POSITION_SECONDS },
  });
  expect(progressed.ok).toBe(true);
  await finish(token, attemptId);
  await page.goto(attemptLesenUrl(FULL_EXAM.slug, attemptId));
  await expect(page.getByTestId('attempt-review')).toBeVisible();

  const [oldRow] = await readStoredAttempts(sessionId);
  const oldAnswers = await readAnswers(attemptId);
  const oldResults = await readResults(attemptId);
  expect(oldRow?.status).toBe('completed');
  expect(Object.keys(oldAnswers)).toHaveLength(2);
  expect(oldResults).toHaveLength(1);

  // Start again opens the choice of the exam and creates nothing yet.
  await page.getByTestId('restart-attempt').click();
  await page.waitForURL(CHOICE_URL);
  expect(await readStoredAttempts(sessionId)).toHaveLength(1);
  await startFromChoice(page);
  await expect(page.getByTestId('attempt-review')).toBeHidden();
  await expect(page.getByTestId('finish-attempt')).toBeVisible();
  const shownId = await shellAttemptId(page);
  expect(shownId).not.toBe(attemptId);

  const rows = await readStoredAttempts(sessionId);
  expect(rows).toHaveLength(2);
  const active = rows.find((row) => row.status === 'active');
  expect(active?.id).toBe(shownId);
  expect(await readAnswers(shownId ?? '')).toEqual({});
  expect(await checkedCount(page)).toBe(0);
  await waitForPlayer(page);
  expect(await currentTimeOf(page)).toBe(0);

  await page.reload();
  await expect(page.getByTestId('finish-attempt')).toBeVisible();
  expect(await shellAttemptId(page)).toBe(shownId);
  expect(await checkedCount(page)).toBe(0);
  await waitForPlayer(page);
  expect(await currentTimeOf(page)).toBe(0);

  // Opening the new run may store its place, never the old recording time.
  const after = await readStoredAttempts(sessionId);
  expect(after.map((row) => [row.id, row.status])).toEqual([
    [attemptId, 'completed'],
    [shownId, 'active'],
  ]);
  expect(after[0]).toEqual(oldRow);
  expect(positionOf(after[1]?.progress)).toBe(0);
  expect(await readAnswers(attemptId)).toEqual(oldAnswers);
  expect(await readResults(attemptId)).toEqual(oldResults);
  await context.close();
});

test('repeated restart returns existing active attempt', async () => {
  const guest = await completedGuest();
  const body = await startBody(FULL_EXAM.slug);
  const started = await startFor(depsNow(), guest.token, FULL_EXAM.slug, body);
  if (!started.ok) throw new Error(`start: ${started.failure}`);
  expect(started.result.outcome).toBe('accepted');
  const first = started.result.attemptId;
  const rows = await readStoredAttempts(guest.guest.sessionId);
  const events = await countEvents(guest.guest.visitorId);
  expect(rows).toHaveLength(2);
  expect(events.start).toBe(2);

  // The same command again returns its attempt; a new command while it is
  // active is a conflict naming it. Neither writes anything.
  expect(
    await startFor(depsNow(), guest.token, FULL_EXAM.slug, body),
  ).toMatchObject({
    ok: true,
    result: { outcome: 'accepted', attemptId: first },
  });
  expect(await startFor(depsNow(), guest.token, FULL_EXAM.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: first },
  });
  expect(await readStoredAttempts(guest.guest.sessionId)).toEqual(rows);
  expect(await countEvents(guest.guest.visitorId)).toEqual(events);

  const reopened = await openReady(depsNow(), guest);
  expect(reopened.attemptId).toBe(first);
  expect(reopened.review).toBeNull();

  // A stale tab of an older completed run starts again from the choice: it
  // meets the active run and continues it.
  await finish(guest.token, first);
  const third = await restart(guest.token);
  const runs = await readStoredAttempts(guest.guest.sessionId);
  const counts = await countEvents(guest.guest.visitorId);
  expect(await restart(guest.token)).toBe(third);
  expect(await readStoredAttempts(guest.guest.sessionId)).toEqual(runs);
  expect(await countEvents(guest.guest.visitorId)).toEqual(counts);
});

test('restart rejects foreign or active attempt', async () => {
  const owner = await completedGuest();
  const activeId = await restart(owner.token);
  const stranger: CreatedGuest = await newGuest(depsNow());
  await openReady(depsNow(), stranger);

  const ownerRows = await readStoredAttempts(owner.guest.sessionId);
  const strangerRows = await readStoredAttempts(stranger.guest.sessionId);
  const ownerEvents = await readEvents(owner.guest.visitorId);
  const strangerEvents = await readEvents(stranger.guest.visitorId);

  // A start builds on no foreign attempt: naming one as a source is not
  // enabled; an active run is a conflict, never replaced.
  const foreign = {
    purpose: 'error-repeat',
    sourceAttemptId: owner.completedId,
  };
  expect(
    await startFor(depsNow(), stranger.token, FULL_EXAM.slug, foreign),
  ).toEqual({ ok: false, failure: 'not-enabled' });
  expect(await startFor(depsNow(), owner.token, FULL_EXAM.slug)).toMatchObject({
    ok: true,
    result: { outcome: 'conflict', attemptId: activeId },
  });
  expect(
    await startFor(depsAt(owner.guest.expiresAt), owner.token, FULL_EXAM.slug),
  ).toEqual({ ok: false, failure: 'session-invalid' });
  expect(await startFor(depsNow(), null, FULL_EXAM.slug)).toEqual({
    ok: false,
    failure: 'session-invalid',
  });
  const scored = { score: 45 } as Partial<
    Awaited<ReturnType<typeof startBody>>
  >;
  expect(
    await startFor(depsNow(), owner.token, FULL_EXAM.slug, scored),
  ).toEqual({ ok: false, failure: 'invalid-input' });

  // The database refuses on its own: the M1 restart no longer exists, and
  // the start checks the guest term, the version and the assignment.
  const removed = await serviceDb.rpc('restart_attempt', {
    p_session_id: owner.guest.sessionId,
    p_attempt_id: owner.completedId,
    p_exam_version_id: '00000000-0000-4000-8000-000000000000',
    p_now: new Date().toISOString(),
    p_scope: 'full-exam',
  });
  expect(removed.error?.code).toBe('PGRST202');

  const exam = await latestVersionOf(FULL_EXAM.slug);
  if (!exam) throw new Error('full exam is missing');
  const allIds = FULL_PILOT.content.questions.map((question) => question.id);
  const expired = await newGuest(depsAt(new Date(Date.now() - 31 * DAY_MS)));
  const fresh = await newGuest(depsNow());
  const direct = (sessionId: string, overrides: Record<string, unknown>) =>
    serviceDb.rpc('m2_start_attempt', {
      p_session_id: sessionId,
      p_exam_id: exam.examId,
      p_command_id: crypto.randomUUID(),
      p_mode: 'training',
      p_purpose: 'normal',
      p_selection: 'all',
      p_source_attempt_id: null,
      p_version_id: exam.versionId,
      p_scope: 'full-exam',
      p_question_ids: allIds,
      ...overrides,
    });
  const hints = [
    (await direct(expired.guest.sessionId, {})).error,
    (
      await direct(fresh.guest.sessionId, {
        p_version_id: '00000000-0000-4000-8000-000000000000',
      })
    ).error,
    (await direct(fresh.guest.sessionId, { p_question_ids: allIds.slice(1) }))
      .error,
    (await direct(fresh.guest.sessionId, { p_mode: 'speed' })).error,
  ].map((error) => error?.hint);
  expect(hints).toEqual([
    'guest_session_invalid',
    'version_changed',
    'assignment_invalid',
    'start_invalid',
  ]);
  expect(await readStoredAttempts(expired.guest.sessionId)).toEqual([]);
  expect(await readStoredAttempts(fresh.guest.sessionId)).toEqual([]);

  expect(await readStoredAttempts(owner.guest.sessionId)).toEqual(ownerRows);
  expect(await readStoredAttempts(stranger.guest.sessionId)).toEqual(
    strangerRows,
  );
  expect(await readEvents(owner.guest.visitorId)).toEqual(ownerEvents);
  expect(await readEvents(stranger.guest.visitorId)).toEqual(strangerEvents);
});

test('restart cannot reset another active guest', async ({ browser }) => {
  const other = await browserGuest(browser);
  await save(depsNow(), other.token, other.attemptId, 'hoeren-1');
  await save(depsNow(), other.token, other.attemptId, 'hoeren-2');
  await other.page.reload();
  await expect(
    other.page.getByTestId('question-card-hoeren-1').locator('input:checked'),
  ).toHaveCount(1);
  await waitForPlayer(other.page);
  await other.page.getByRole('button', { name: /Play/ }).click();
  await expect(other.page.getByRole('button', { name: /Pause/ })).toBeVisible();
  await audioOf(other.page).evaluate((element: HTMLAudioElement, at) => {
    element.currentTime = at;
    element.dataset.marker = 'listener';
  }, PLAY_FROM_SECONDS);
  await expect
    .poll(() => currentTimeOf(other.page))
    .toBeGreaterThan(PLAY_FROM_SECONDS + 0.3);
  const otherAnswers = await readAnswers(other.attemptId);
  const otherRows = await readStoredAttempts(other.sessionId);
  const otherChecked = await checkedCount(other.page);
  const positionBefore = await currentTimeOf(other.page);
  expect(otherChecked).toBeGreaterThan(0);

  const first = await browserGuest(browser);
  await save(depsNow(), first.token, first.attemptId, 'hoeren-1');
  await finish(first.token, first.attemptId);
  await first.page.reload();
  await first.page.getByTestId('restart-attempt').click();
  await first.page.waitForURL(CHOICE_URL);
  await startFromChoice(first.page);
  await expect(first.page.getByTestId('finish-attempt')).toBeVisible();
  const restartedId = await shellAttemptId(first.page);
  expect(restartedId).not.toBe(first.attemptId);
  expect(restartedId).not.toBe(other.attemptId);

  expect(await readAnswers(other.attemptId)).toEqual(otherAnswers);
  expect(
    (await readStoredAttempts(other.sessionId)).map((row) => row.id),
  ).toEqual(otherRows.map((row) => row.id));
  expect(await shellAttemptId(other.page)).toBe(other.attemptId);
  expect(await checkedCount(other.page)).toBe(otherChecked);
  const media = await audioOf(other.page).evaluate(
    (element: HTMLAudioElement) => ({
      currentTime: element.currentTime,
      paused: element.paused,
      marker: element.dataset.marker ?? null,
    }),
  );
  expect(media.paused).toBe(false);
  expect(media.marker).toBe('listener');
  expect(media.currentTime).toBeGreaterThan(positionBefore);
  await first.context.close();
  await other.context.close();
});

test('entry start and finish are recorded', async () => {
  const created = await newGuest(depsNow());
  const { visitorId, sessionId } = created.guest;
  expect(await readVisitorId(sessionId)).toBe(visitorId);
  const firstId = (await openReady(depsNow(), created)).attemptId;
  await save(depsNow(), created.token, firstId, 'hoeren-1');
  await finish(created.token, firstId);
  const secondId = await restart(created.token);
  await finish(created.token, secondId);

  const events = await readEvents(visitorId);
  expect(await countEvents(visitorId)).toEqual({
    entry: 1,
    start: 2,
    finish: 2,
  });
  expect(events.every((event) => event.visitor_id === visitorId)).toBe(true);
  expect(events.find((event) => event.kind === 'entry')?.attempt_id).toBeNull();
  expect(hasAttemptEvents([firstId, secondId], events)).toBe(true);
});

test('repeated requests do not duplicate events', async ({ browser }) => {
  const { context, page, token, sessionId, attemptId } =
    await browserGuest(browser);
  const visitorId = await readVisitorId(sessionId);
  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('guest is missing');
  const expectCounts = async (counts: EventCounts) =>
    expect(await countEvents(visitorId)).toEqual(counts);
  await expectCounts({ entry: 1, start: 1, finish: 0 });

  // Entry again from the same browser keeps its session and continues its
  // active attempt at the attempt's own address, without a start.
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL(HOEREN_URL);
  expect(attemptIdOf(page)).toBe(attemptId);
  expect((await sessionOf(context)).id).toBe(sessionId);
  await page.reload();
  expect((await openReady(depsNow(), { token, guest })).attemptId).toBe(
    attemptId,
  );
  await expectCounts({ entry: 1, start: 1, finish: 0 });

  await finish(token, attemptId);
  await finish(token, attemptId);
  await expectCounts({ entry: 1, start: 1, finish: 1 });

  const nextId = await restart(token);
  expect(await restart(token)).toBe(nextId);
  expect((await openReady(depsNow(), { token, guest })).attemptId).toBe(nextId);
  await expectCounts({ entry: 1, start: 2, finish: 1 });

  await finish(token, nextId);
  await finish(token, nextId);
  await expectCounts({ entry: 1, start: 2, finish: 2 });

  // The journal itself refuses a second event of the same kind.
  const duplicate = await serviceDb.from('guest_events').insert({
    kind: 'finish',
    visitor_id: visitorId,
    attempt_id: nextId,
    occurred_at: new Date().toISOString(),
  });
  expect(duplicate.error?.code).toBe('23505');
  await expectCounts({ entry: 1, start: 2, finish: 2 });
  await context.close();
});

test('public client cannot read events or restart', async () => {
  const guest = await completedGuest();
  const anon = createPublicClient();
  const events = await readEvents(guest.guest.visitorId);
  const rows = await readStoredAttempts(guest.guest.sessionId);

  const read = await anon
    .from('guest_events')
    .select('*')
    .eq('visitor_id', guest.guest.visitorId);
  expect(read.error?.code).toBe('42501');
  expect(read.data).toBeNull();

  const write = await anon.from('guest_events').insert({
    kind: 'entry',
    visitor_id: guest.guest.visitorId,
    occurred_at: new Date().toISOString(),
  });
  expect(write.error?.code).toBe('42501');

  // The M1 restart is removed; the explicit start that replaces it is
  // closed to the public key.
  const restarted = await anon.rpc('restart_attempt', {
    p_session_id: guest.guest.sessionId,
    p_attempt_id: guest.completedId,
    p_exam_version_id: '00000000-0000-4000-8000-000000000000',
    p_now: new Date().toISOString(),
    p_scope: 'full-exam',
  });
  expect(restarted.error?.code).toBe('PGRST202');
  const exam = await latestVersionOf(FULL_EXAM.slug);
  const started = await anon.rpc('m2_start_attempt', {
    p_session_id: guest.guest.sessionId,
    p_exam_id: exam?.examId,
    p_command_id: crypto.randomUUID(),
    p_mode: 'training',
    p_purpose: 'normal',
    p_selection: 'all',
    p_source_attempt_id: null,
    p_version_id: exam?.versionId,
    p_scope: 'full-exam',
    p_question_ids: FULL_PILOT.content.questions.map((item) => item.id),
  });
  expect(started.error?.code).toBe('42501');

  expect(await readEvents(guest.guest.visitorId)).toEqual(events);
  expect(await readStoredAttempts(guest.guest.sessionId)).toEqual(rows);
});

test('restart keeps the guest locale', async ({ browser, baseURL }) => {
  const guest = await completedGuest();
  expect(await setGuestLocale(depsNow(), guest.guest, 'ru')).toBe(true);
  const context = await browser.newContext();
  await context.addCookies([
    { name: GUEST_COOKIE, value: guest.token, url: baseURL },
  ]);
  const page = await context.newPage();
  await page.goto(attemptUrl(FULL_EXAM.slug, guest.completedId));
  await expect(page.getByTestId('attempt-review')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByTestId('restart-attempt').click();
  await page.waitForURL(CHOICE_URL);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await startFromChoice(page);
  await expect(page.getByTestId('finish-attempt')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  expect(await shellAttemptId(page)).not.toBe(guest.completedId);
  await context.close();
});

// --- Explicit guest replacement before a timed block (#44) -----------------
// A guest too short for the block gets a dialog; only a consent creates a new
// English guest, and the block starts by a separate request under the new
// cookie. Sessions end in a few minutes through the test-only fixture, so no
// clock is moved and nothing is mocked.

const TERM_HOURS_MS = 720 * 60 * 60 * 1000;
// The block of Hören of the full set needs 1500 s and the 300 s reserve.
const TOO_SHORT_SECONDS = 600;
const LONG_ENOUGH_SECONDS = 1500 + 300 + 600;
const PER_MINUTE = 500;
const owner = sqlRunnerAs('owner');

test.beforeAll(() => {
  installM2Fixtures();
});

const guestEndingIn = async (seconds: number) => {
  const token = randomBytes(32).toString('base64url');
  psql(`select m2_test.insert_guest_ending_in(
    ${quote(hashGuestToken(token))}, ${seconds})`);
  const guest = await resolveGuestSession(depsNow(), token);
  if (!guest) throw new Error('guest is not active');
  return { token, guest };
};

const timedBody = (slug: string = FULL_EXAM.slug) =>
  startBody(slug, { mode: 'timed-block', selection: 'hoeren' });

// The server work of the Server Action with the real preflight; the cookie
// write is the only thing left to the action.
const replaceFor = async (
  token: string | null,
  body: Awaited<ReturnType<typeof timedBody>>,
) =>
  replaceGuestSession(depsNow(), PER_MINUTE, () =>
    preflightTimedStart(depsNow(), token, body),
  );

interface TimedExam {
  slug: string;
  versionId: string;
}

const publishTimedExam = async (
  settings: TimingSettings | null,
): Promise<TimedExam> => {
  const slug = `test-replace-${randomUUID().slice(0, 8)}`;
  const outcome = await publishExamVersion(serviceDb, {
    slug,
    title: 'Replacement test',
    format: 'DTZ',
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(523) }],
  });
  if (settings) ensureConfirmedTestProfile(owner, outcome.versionId, settings);
  return { slug, versionId: outcome.versionId };
};

const openChoiceAs = async (
  browser: Browser,
  baseURL: string | undefined,
  token: string,
  viewport?: { width: number; height: number },
) => {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: baseURL ?? '' },
  ]);
  const page = await context.newPage();
  await page.goto(`/practice/${FULL_EXAM.slug}`);
  return { context, page };
};

const dialogOf = (page: Page) => page.getByTestId('guest-replacement-dialog');

// Chooses the timed Hören block and starts it: a too-short guest meets the
// dialog.
const startTimed = async (page: Page) => {
  await page.getByTestId('mode-option-timed-block').click();
  await page.getByTestId('selection-option-hoeren').click();
  await page.getByTestId('start-attempt').click();
  await expect(dialogOf(page)).toBeVisible();
};

test('replacement requires consent then starts with new english guest', async ({
  browser,
  baseURL,
}) => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  expect(await setGuestLocale(depsNow(), old.guest, 'ru')).toBe(true);
  const before = await readSession(old.guest.sessionId);
  const { context, page } = await openChoiceAs(browser, baseURL, old.token);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  // Refusal: the dialog closes, cookie, session and data stay as they were.
  await startTimed(page);
  await page.getByTestId('guest-replacement-cancel').click();
  await expect(dialogOf(page)).toBeHidden();
  expect(await tokenOf(context)).toBe(old.token);
  expect(await readSession(old.guest.sessionId)).toEqual(before);
  expect(await readStoredAttempts(old.guest.sessionId)).toEqual([]);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  // Consent: a new English guest of 720 hours, then the chosen block.
  await page.getByTestId('guest-replacement-open').click();
  await page.getByTestId('guest-replacement-confirm').click();
  await page.waitForURL(HOEREN_URL);
  const token = await tokenOf(context);
  expect(token).not.toBe(old.token);
  const fresh = await sessionOf(context);
  expect(fresh.id).not.toBe(old.guest.sessionId);
  expect(fresh.locale).toBe('en');
  expect(new Date(fresh.expires_at).getTime()).toBe(
    new Date(fresh.created_at).getTime() + TERM_HOURS_MS,
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const rows = await readStoredAttempts(fresh.id);
  expect(rows).toHaveLength(1);
  const [run] = await readRunRows(rows[0]?.id ?? '');
  expect(run).toMatchObject({ mode: 'timed-block', selection: 'hoeren' });
  // The old session keeps its term and has no attempt.
  expect(await readSession(old.guest.sessionId)).toEqual(before);
  expect(await readStoredAttempts(old.guest.sessionId)).toEqual([]);
  await context.close();
});

test('replacement retains old data and isolates other browser', async ({
  browser,
}) => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  const practice = await openReady(depsNow(), old);
  await save(depsNow(), old.token, practice.attemptId, 'hoeren-1');
  await finish(old.token, practice.attemptId);
  const attempts = await readStoredAttempts(old.guest.sessionId);
  const answers = await readAnswers(practice.attemptId);
  const results = await readResults(practice.attemptId);
  const events = await readEvents(old.guest.visitorId);
  const sessionBefore = await readSession(old.guest.sessionId);
  const other = await browserGuest(browser);

  const replaced = await replaceFor(old.token, await timedBody());
  if (replaced.status !== 'created') throw new Error(replaced.status);
  expect(replaced.created.guest.locale).toBe('en');

  // The old guest keeps everything, untouched and unextended.
  expect(await readStoredAttempts(old.guest.sessionId)).toEqual(attempts);
  expect(await readAnswers(practice.attemptId)).toEqual(answers);
  expect(await readResults(practice.attemptId)).toEqual(results);
  expect(await readEvents(old.guest.visitorId)).toEqual(events);
  expect(await readSession(old.guest.sessionId)).toEqual(sessionBefore);
  // The new guest owns nothing of it.
  expect(await readStoredAttempts(replaced.created.guest.sessionId)).toEqual(
    [],
  );

  // Another browser keeps its own guest, attempt and saving.
  const status = await readAttemptStatus(depsNow(), other.token, {
    attemptId: other.attemptId,
  });
  expect(status).toMatchObject({ ok: true, result: { outcome: 'active' } });
  await save(depsNow(), other.token, other.attemptId, 'hoeren-1');
  expect(await readAnswers(other.attemptId)).toEqual({
    'hoeren-1': keyOf('hoeren-1'),
  });
  await other.context.close();
});

test('new guest cannot recover old history by id', async () => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  const practice = await openReady(depsNow(), old);
  await save(depsNow(), old.token, practice.attemptId, 'hoeren-1');
  await finish(old.token, practice.attemptId);
  const replaced = await replaceFor(old.token, await timedBody());
  if (replaced.status !== 'created') throw new Error(replaced.status);
  const { token } = replaced.created;

  const status = await readAttemptStatus(depsNow(), token, {
    attemptId: practice.attemptId,
  });
  expect(status.ok).toBe(false);
  const review = await submitStored(depsNow(), token, {
    attemptId: practice.attemptId,
  });
  expect(review.ok).toBe(false);
  // The old token still reads its own history.
  expect(
    await readAttemptStatus(depsNow(), old.token, {
      attemptId: practice.attemptId,
    }),
  ).toMatchObject({ ok: true });
});

test('replacement rejects missing consent and forged guest', async () => {
  // The function never rotates without a verified old session.
  const body = await timedBody();
  expect(await replaceFor(null, body)).toEqual({
    status: 'refused',
    failure: 'session-invalid',
  });
  expect(await replaceFor(randomBytes(32).toString('base64url'), body)).toEqual(
    { status: 'refused', failure: 'session-invalid' },
  );
  // Forged fields of the start are refused by its strict input.
  const short = await guestEndingIn(TOO_SHORT_SECONDS);
  expect(
    await replaceFor(short.token, {
      ...body,
      sessionId: short.guest.sessionId,
    } as typeof body),
  ).toEqual({ status: 'refused', failure: 'invalid-input' });
  expect(await resolveGuestSession(depsNow(), short.token)).toMatchObject({
    expiresAt: short.guest.expiresAt,
  });
  // The Server Action side (consent, Origin) is in the action test below.
});

test('replacement does not bypass active slot or profile refusal', async () => {
  // An active attempt of the exam: a conflict that names it.
  const busy = await guestEndingIn(TOO_SHORT_SECONDS);
  const started = await startFor(depsNow(), busy.token, FULL_EXAM.slug);
  if (!started.ok) throw new Error(started.failure);
  expect(await replaceFor(busy.token, await timedBody())).toEqual({
    status: 'conflict',
    attemptId: started.result.attemptId,
  });

  // No confirmed profile together with a short term: the profile refusal.
  const draft = await publishTimedExam(null);
  const short = await guestEndingIn(TOO_SHORT_SECONDS);
  expect(await replaceFor(short.token, await timedBody(draft.slug))).toEqual({
    status: 'refused',
    failure: 'not-enabled',
  });
  // Free training is not a timed start: nothing to replace.
  const free = await startBody(FULL_EXAM.slug);
  expect(await replaceFor(short.token, free)).toEqual({
    status: 'refused',
    failure: 'invalid-input',
  });
  expect(await readStoredAttempts(short.guest.sessionId)).toEqual([]);
});

test('replacement rechecks concurrent active and profile before cookie write', async () => {
  // Another tab started an attempt before the confirmation reached the server.
  const first = await guestEndingIn(TOO_SHORT_SECONDS);
  const body = await timedBody();
  expect(await preflightTimedStart(depsNow(), first.token, body)).toEqual({
    ok: false,
    failure: 'guest-too-short',
  });
  const started = await startFor(depsNow(), first.token, FULL_EXAM.slug);
  if (!started.ok) throw new Error(started.failure);
  expect(await replaceFor(first.token, body)).toMatchObject({
    status: 'conflict',
  });

  // The profile became a draft after the dialog opened.
  const exam = await publishTimedExam(SHORT_TIMING);
  const second = await guestEndingIn(100);
  const timed = await timedBody(exam.slug);
  expect(await preflightTimedStart(depsNow(), second.token, timed)).toEqual({
    ok: false,
    failure: 'guest-too-short',
  });
  createTimingProfileRevision(
    owner,
    { versionId: exam.versionId },
    { ...SHORT_TIMING, hoerenSeconds: SHORT_TIMING.hoerenSeconds + 1 },
  );
  expect(await replaceFor(second.token, timed)).toEqual({
    status: 'refused',
    failure: 'not-enabled',
  });
  expect(await readStoredAttempts(second.guest.sessionId)).toEqual([]);
});

test('replacement refuses rotation when reserve is sufficient', async () => {
  const enough = await guestEndingIn(LONG_ENOUGH_SECONDS);
  const before = await readSession(enough.guest.sessionId);
  expect(await replaceFor(enough.token, await timedBody())).toEqual({
    status: 'not-needed',
  });
  expect(await readSession(enough.guest.sessionId)).toEqual(before);
  // The ordinary start stays available.
  expect(
    await startFor(depsNow(), enough.token, FULL_EXAM.slug, {
      mode: 'timed-block',
      selection: 'hoeren',
    }),
  ).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
});

test('replacement is not offered when current guest can finish timed run', async ({
  browser,
  baseURL,
}) => {
  const enough = await guestEndingIn(LONG_ENOUGH_SECONDS);
  const { context, page } = await openChoiceAs(browser, baseURL, enough.token);
  await page.getByTestId('mode-option-timed-block').click();
  await page.getByTestId('selection-option-hoeren').click();
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  expect(await dialogOf(page).count()).toBe(0);
  expect(await tokenOf(context)).toBe(enough.token);
  await context.close();
});

test('replacement retry preserves start command idempotency', async ({
  browser,
  baseURL,
}) => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  const { context, page } = await openChoiceAs(browser, baseURL, old.token);
  await startTimed(page);
  const commands: string[] = [];
  let calls = 0;
  await page.route('**/api/attempts/start', async (route) => {
    calls += 1;
    commands.push(route.request().postDataJSON().commandId);
    // The first start is lost before it is sent; the second commits and its
    // answer is lost; the third goes through.
    if (calls === 1) return route.abort('failed');
    if (calls === 2) {
      await route.fetch();
      return route.abort('failed');
    }
    return route.continue();
  });

  await page.getByTestId('guest-replacement-confirm').click();
  await expect(page.getByTestId('start-error')).toBeVisible();
  // Failed start after replacement: the new session works, nothing is hidden.
  const token = await tokenOf(context);
  expect(token).not.toBe(old.token);
  const fresh = await resolveGuestSession(depsNow(), token);
  expect(fresh?.locale).toBe('en');
  expect(await readStoredAttempts(fresh?.sessionId ?? '')).toEqual([]);
  expect(await readStoredAttempts(old.guest.sessionId)).toEqual([]);

  await page.getByTestId('start-attempt').click();
  await expect.poll(() => calls).toBe(2);
  await expect
    .poll(async () => (await readStoredAttempts(fresh?.sessionId ?? '')).length)
    .toBe(1);
  const [committed] = await readStoredAttempts(fresh?.sessionId ?? '');

  await expect(page.getByTestId('start-error')).toBeVisible();
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  expect(attemptIdOf(page)).toBe(committed?.id);
  expect(await readStoredAttempts(fresh?.sessionId ?? '')).toHaveLength(1);
  expect(new Set(commands).size).toBe(1);
  await context.close();
});

test('failed start after replacement retains recoverable new session', async ({
  browser,
  baseURL,
}) => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  const { context, page } = await openChoiceAs(browser, baseURL, old.token);
  await startTimed(page);
  await page.route('**/api/attempts/start', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, failure: 'unavailable' }),
    }),
  );
  await page.getByTestId('guest-replacement-confirm').click();
  await expect(page.getByTestId('start-error')).toBeVisible();
  const fresh = await resolveGuestSession(depsNow(), await tokenOf(context));
  expect(fresh).not.toBeNull();
  expect(await readStoredAttempts(fresh?.sessionId ?? '')).toEqual([]);
  expect(await readStoredAttempts(old.guest.sessionId)).toEqual([]);

  // The choice is kept and the retry runs under the new cookie.
  await page.unroute('**/api/attempts/start');
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  expect(await readStoredAttempts(fresh?.sessionId ?? '')).toHaveLength(1);
  expect(await readStoredAttempts(old.guest.sessionId)).toEqual([]);
  await context.close();
});

test('guest replacement dialog is accessible and preserves pending choice', async ({
  browser,
  baseURL,
}) => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  expect(await setGuestLocale(depsNow(), old.guest, 'ru')).toBe(true);
  const { context, page } = await openChoiceAs(browser, baseURL, old.token, {
    width: 320,
    height: 640,
  });
  await startTimed(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAccessibleName(/\S/);

  // 320 px: the dialog and its controls fit the screen.
  const box = await dialog.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
  for (const id of ['guest-replacement-cancel', 'guest-replacement-confirm']) {
    const button = await page.getByTestId(id).boundingBox();
    expect(button?.height).toBeGreaterThanOrEqual(44);
    expect((button?.x ?? 0) + (button?.width ?? 0)).toBeLessThanOrEqual(320);
  }

  // Keyboard: the focus starts on the safe answer, stays inside, and Escape
  // closes the dialog and returns it to the start button.
  await expect(page.getByTestId('guest-replacement-cancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('guest-replacement-confirm')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('guest-replacement-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialogOf(page)).toBeHidden();
  await expect(page.getByTestId('start-attempt')).toBeFocused();
  expect(await tokenOf(context)).toBe(old.token);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  // Enter on the confirm button: English interface, same mode and block, and
  // the recording does not start by itself.
  await page.getByTestId('guest-replacement-open').click();
  await expect(page.getByTestId('guest-replacement-cancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('guest-replacement-confirm')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(HOEREN_URL);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const fresh = await sessionOf(context);
  const [row] = await readStoredAttempts(fresh.id);
  const [run] = await readRunRows(row?.id ?? '');
  expect(run).toMatchObject({ mode: 'timed-block', selection: 'hoeren' });
  await waitForPlayer(page);
  expect(await audioOf(page).evaluate((e: HTMLAudioElement) => e.paused)).toBe(
    true,
  );
  await context.close();
});

test('replacement server action enforces origin and ownership', async ({
  browser,
  baseURL,
  playwright,
}) => {
  const old = await guestEndingIn(TOO_SHORT_SECONDS);
  const { context, page } = await openChoiceAs(browser, baseURL, old.token);
  await startTimed(page);
  const captured = page.waitForRequest(
    (sent) => sent.method() === 'POST' && 'next-action' in sent.headers(),
  );
  await page.getByTestId('guest-replacement-confirm').click();
  const sent = await captured;
  await page.waitForURL(HOEREN_URL);
  const action = sent.headers()['next-action'] ?? '';
  const url = sent.url();
  const original = JSON.parse(sent.postData() ?? '[]') as [
    { consent?: boolean; start: Record<string, unknown> },
  ];
  const real = original[0];
  if (!real) throw new Error('no captured argument');
  expect(real.consent).toBe(true);

  const api = await playwright.request.newContext();
  const post = async (
    token: string,
    argument: unknown,
    origin: string = baseURL ?? '',
  ) => {
    const response = await api.post(url, {
      headers: {
        'next-action': action,
        'content-type': 'text/plain;charset=UTF-8',
        origin,
        cookie: `${GUEST_COOKIE}=${token}`,
      },
      data: JSON.stringify([argument]),
    });
    return {
      text: await response.text(),
      ok: response.ok(),
      setsCookie: 'set-cookie' in response.headers(),
    };
  };
  const fresh = await guestEndingIn(TOO_SHORT_SECONDS);

  // A foreign Origin is rejected before the action runs.
  const foreign = await post(fresh.token, real, 'https://evil.example');
  expect(foreign.ok).toBe(false);
  expect(foreign.setsCookie).toBe(false);

  // Missing consent, a forged guest field and an unknown session.
  const noConsent = await post(fresh.token, { start: real.start });
  expect(noConsent.text).toContain('invalid-input');
  expect(noConsent.setsCookie).toBe(false);
  const forged = await post(fresh.token, {
    consent: true,
    start: { ...real.start, sessionId: fresh.guest.sessionId },
  });
  expect(forged.text).toContain('invalid-input');
  expect(forged.setsCookie).toBe(false);
  const unknown = await post(randomBytes(32).toString('base64url'), real);
  expect(unknown.text).toContain('session-invalid');
  expect(unknown.setsCookie).toBe(false);

  // A guest with enough reserve is told the replacement is not needed.
  const enough = await guestEndingIn(LONG_ENOUGH_SECONDS);
  const needless = await post(enough.token, real);
  expect(needless.text).toContain('not-needed');
  expect(needless.setsCookie).toBe(false);
  expect(await resolveGuestSession(depsNow(), enough.token)).not.toBeNull();
  expect(await readStoredAttempts(fresh.guest.sessionId)).toEqual([]);
  await api.dispose();
  await context.close();
});
