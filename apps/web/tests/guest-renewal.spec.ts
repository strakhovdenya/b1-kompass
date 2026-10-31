import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  finishAttempt,
  openPractice,
  restartAttempt,
  saveAnswer,
  saveProgress,
} from '../src/server/attempts/attempts';
import type { ServerDeps } from '../src/server/db';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
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
  newGuest,
  readAnswers,
  readAttempts,
  readResults,
  readSession,
  readSessionByToken,
  serviceDb,
} from './support/db';
import { FULL_EXAM, FULL_PILOT } from './support/full-exam';

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

const openReady = async (deps: ServerDeps, guest: GuestContext) => {
  const opened = await openPractice(deps, guest, FULL_EXAM.slug);
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
  const result = await finishAttempt(depsNow(), token, { attemptId });
  if (!result.ok) throw new Error(`finish: ${result.error}`);
  return result.review;
};

const restart = async (token: string, attemptId: string) => {
  const result = await restartAttempt(depsNow(), token, { attemptId });
  if (!result.ok) throw new Error(`restart: ${result.error}`);
  return result.attemptId;
};

// A guest whose first attempt has stored answers and is completed.
const completedGuest = async () => {
  const created = await newGuest(depsNow());
  const practice = await openReady(depsNow(), created.guest);
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

// Entry through the real home page; the page language is English here.
const enterAsGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
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
  const practice = await openReady(nearDeadline, created.guest);
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
  const practice = await openReady(depsNow(), created.guest);
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
  await page.goto('/practice/lesen');
  await expect(page.getByTestId('attempt-review')).toBeVisible();

  const [oldRow] = await readStoredAttempts(sessionId);
  const oldAnswers = await readAnswers(attemptId);
  const oldResults = await readResults(attemptId);
  expect(oldRow?.status).toBe('completed');
  expect(Object.keys(oldAnswers)).toHaveLength(2);
  expect(oldResults).toHaveLength(1);

  await page.getByTestId('restart-attempt').click();
  await page.waitForURL('**/practice');
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
  const first = await restart(guest.token, guest.completedId);
  const rows = await readStoredAttempts(guest.guest.sessionId);
  const events = await countEvents(guest.guest.visitorId);
  expect(rows).toHaveLength(2);
  expect(events.start).toBe(2);

  const second = await restart(guest.token, guest.completedId);
  expect(second).toBe(first);
  expect(await readStoredAttempts(guest.guest.sessionId)).toEqual(rows);
  expect(await countEvents(guest.guest.visitorId)).toEqual(events);

  const reopened = await openReady(depsNow(), guest.guest);
  expect(reopened.attemptId).toBe(first);
  expect(reopened.review).toBeNull();

  // An older completed run (a stale tab) also continues the active one.
  await finish(guest.token, first);
  const third = await restart(guest.token, first);
  const runs = await readStoredAttempts(guest.guest.sessionId);
  const counts = await countEvents(guest.guest.visitorId);
  expect(await restart(guest.token, guest.completedId)).toBe(third);
  expect(await readStoredAttempts(guest.guest.sessionId)).toEqual(runs);
  expect(await countEvents(guest.guest.visitorId)).toEqual(counts);
});

test('restart rejects foreign or active attempt', async () => {
  const owner = await completedGuest();
  const activeId = await restart(owner.token, owner.completedId);
  const stranger: CreatedGuest = await newGuest(depsNow());
  await openReady(depsNow(), stranger.guest);

  const ownerRows = await readStoredAttempts(owner.guest.sessionId);
  const strangerRows = await readStoredAttempts(stranger.guest.sessionId);
  const ownerEvents = await readEvents(owner.guest.visitorId);
  const strangerEvents = await readEvents(stranger.guest.visitorId);

  const foreign = { attemptId: owner.completedId };
  expect(await restartAttempt(depsNow(), stranger.token, foreign)).toEqual({
    ok: false,
    error: 'attempt-not-found',
  });
  expect(
    await restartAttempt(depsNow(), owner.token, { attemptId: activeId }),
  ).toEqual({ ok: false, error: 'not-completed' });
  expect(
    await restartAttempt(depsAt(owner.guest.expiresAt), owner.token, foreign),
  ).toEqual({ ok: false, error: 'session-invalid' });
  expect(await restartAttempt(depsNow(), null, foreign)).toEqual({
    ok: false,
    error: 'session-invalid',
  });
  expect(
    await restartAttempt(depsNow(), owner.token, { ...foreign, score: 45 }),
  ).toEqual({ ok: false, error: 'invalid-input' });

  // The database refuses the same calls on its own.
  const direct = (sessionId: string, attemptId: string, now: Date) =>
    serviceDb.rpc('restart_attempt', {
      p_session_id: sessionId,
      p_attempt_id: attemptId,
      p_exam_version_id: '00000000-0000-4000-8000-000000000000',
      p_now: now.toISOString(),
      p_scope: 'full-exam',
    });
  const now = new Date();
  const hints = [
    (await direct(stranger.guest.sessionId, owner.completedId, now)).error,
    (await direct(owner.guest.sessionId, activeId, now)).error,
    (await direct(owner.guest.sessionId, owner.completedId, now)).error,
    (
      await direct(
        owner.guest.sessionId,
        owner.completedId,
        owner.guest.expiresAt,
      )
    ).error,
  ].map((error) => error?.hint);
  expect(hints).toEqual([
    'attempt_not_found',
    'attempt_not_completed',
    'version_not_allowed',
    'guest_session_invalid',
  ]);

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
  const firstId = (await openReady(depsNow(), created.guest)).attemptId;
  await save(depsNow(), created.token, firstId, 'hoeren-1');
  await finish(created.token, firstId);
  const secondId = await restart(created.token, firstId);
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

  // Entry again from the same browser keeps its session.
  await enterAsGuest(page);
  expect((await sessionOf(context)).id).toBe(sessionId);
  await page.reload();
  expect((await openReady(depsNow(), guest)).attemptId).toBe(attemptId);
  await expectCounts({ entry: 1, start: 1, finish: 0 });

  await finish(token, attemptId);
  await finish(token, attemptId);
  await expectCounts({ entry: 1, start: 1, finish: 1 });

  const nextId = await restart(token, attemptId);
  expect(await restart(token, attemptId)).toBe(nextId);
  expect((await openReady(depsNow(), guest)).attemptId).toBe(nextId);
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

  const restarted = await anon.rpc('restart_attempt', {
    p_session_id: guest.guest.sessionId,
    p_attempt_id: guest.completedId,
    p_exam_version_id: '00000000-0000-4000-8000-000000000000',
    p_now: new Date().toISOString(),
    p_scope: 'full-exam',
  });
  expect(restarted.error?.code).toBe('42501');

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
  await page.goto('/practice');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await page.getByTestId('restart-attempt').click();
  await expect(page.getByTestId('finish-attempt')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  expect(await shellAttemptId(page)).not.toBe(guest.completedId);
  await context.close();
});
