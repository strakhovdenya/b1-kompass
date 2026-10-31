import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openPractice } from '../src/server/attempts/attempts';
import { createGuestSession } from '../src/server/guest-session/session';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  createPublicClient,
  depsAt,
  readAttempts,
  readSession,
  serviceDb,
} from './support/db';
import { TEST_GUEST_SESSIONS_PER_MINUTE } from './support/env';

// This spec runs alone after every other spec (project `limits`): it fills
// the site-wide window and purges expired sessions of the whole database.

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;
const TERM_MS = 720 * 60 * 60 * SECOND_MS;
const LIMIT = 3;

const MESSAGES_PATH = path.join(import.meta.dirname, '..', 'messages', 'en.json');
const BUSY_TEXT: string = JSON.parse(readFileSync(MESSAGES_PATH, 'utf8')).home
  .busy;

// Every test uses its own moment far from the real clock, so the minute
// windows of the tests never overlap with each other or with real sessions.
const momentOf = (day: number): Date => new Date(Date.UTC(2031, 0, day, 12));

const insertSessions = async (
  count: number,
  createdAt: Date,
): Promise<string[]> => {
  const rows = Array.from({ length: count }, () => ({
    token_hash: randomBytes(32).toString('hex'),
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + TERM_MS).toISOString(),
  }));
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .insert(rows)
    .select('id')
    .returns<{ id: string }[]>();
  if (error) throw error;
  return data.map((row) => row.id);
};

// The ids go into the request URL, so a long list is deleted in chunks.
const DELETE_CHUNK = 100;

const deleteSessions = async (ids: readonly string[]): Promise<void> => {
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK);
    const { error } = await serviceDb
      .from('guest_sessions')
      .delete()
      .in('id', chunk);
    if (error) throw error;
  }
};

const findSessionIds = async (ids: readonly string[]): Promise<string[]> => {
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .select('id')
    .in('id', ids)
    .returns<{ id: string }[]>();
  if (error) throw error;
  return data.map((row) => row.id);
};

const countSessions = async (): Promise<number> => {
  const { count, error } = await serviceDb
    .from('guest_sessions')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
};

const createDirect = async (now: Date) =>
  serviceDb.rpc('create_guest_session', {
    p_token_hash: randomBytes(32).toString('hex'),
    p_now: now.toISOString(),
    p_limit: LIMIT,
  });

const purge = async (now: Date): Promise<number> => {
  const { data, error } = await serviceDb.rpc(
    'purge_expired_empty_guest_sessions',
    { p_now: now.toISOString() },
  );
  if (error) throw error;
  return data as number;
};

const createdIdOf = (
  result: Awaited<ReturnType<typeof createGuestSession>>,
): string => {
  if (result.status !== 'created') throw new Error('guest was rate-limited');
  return result.created.guest.sessionId;
};

test('creates guest session under the limit', async () => {
  const now = momentOf(1);
  const before = await countSessions();
  const id = createdIdOf(await createGuestSession(depsAt(now), LIMIT));
  expect(await countSessions()).toBe(before + 1);
  const stored = await readSession(id);
  expect(stored.locale).toBe('en');
  expect(new Date(stored.created_at).getTime()).toBe(now.getTime());
  const termMs =
    new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime();
  expect(termMs).toBe(TERM_MS);
  await deleteSessions([id]);
});

test('rejects guest session over the minute limit', async () => {
  const now = momentOf(2);
  const filled = await insertSessions(LIMIT, new Date(now.getTime() - 30 * SECOND_MS));
  const before = await countSessions();

  const direct = await createDirect(now);
  expect(direct.error?.code).toBe('P0001');
  expect(direct.error?.hint).toBe('guest_rate_limited');
  expect(await createGuestSession(depsAt(now), LIMIT)).toEqual({
    status: 'rate-limited',
  });
  expect(await countSessions()).toBe(before);
  await deleteSessions(filled);
});

test('counts only sessions of the last minute', async () => {
  const now = momentOf(3);
  const older = await insertSessions(LIMIT, new Date(now.getTime() - 61 * SECOND_MS));
  const recent = await insertSessions(
    LIMIT - 1,
    new Date(now.getTime() - 30 * SECOND_MS),
  );
  const id = createdIdOf(await createGuestSession(depsAt(now), LIMIT));
  expect(await findSessionIds([id])).toEqual([id]);
  await deleteSessions([...older, ...recent, id]);
});

test('counts sessions inside the minute window', async () => {
  const now = momentOf(4);
  const oldest = await insertSessions(1, new Date(now.getTime() - 59 * SECOND_MS));
  const recent = await insertSessions(
    LIMIT - 1,
    new Date(now.getTime() - 10 * SECOND_MS),
  );
  const before = await countSessions();
  const direct = await createDirect(now);
  expect(direct.error?.hint).toBe('guest_rate_limited');
  expect(await countSessions()).toBe(before);
  await deleteSessions([...oldest, ...recent]);
});

test('home shows busy message without session cookie', async ({ browser }) => {
  const filled = await insertSessions(
    TEST_GUEST_SESSIONS_PER_MINUTE,
    new Date(Date.now() - 5 * SECOND_MS),
  );
  const before = await countSessions();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await page.waitForURL('**/?busy=1');
    await expect(page.getByText(BUSY_TEXT)).toBeVisible();
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === GUEST_COOKIE)).toBeUndefined();
    expect(await countSessions()).toBe(before);
  } finally {
    await context.close();
    await deleteSessions(filled);
  }
});

test('purges expired empty guest sessions', async () => {
  const now = new Date(Date.UTC(2032, 5, 1));
  await purge(now);
  const expired = await insertSessions(3, new Date(now.getTime() - 40 * DAY_MS));
  const atBoundary = await insertSessions(1, new Date(now.getTime() - TERM_MS));

  expect(await purge(now)).toBe(expired.length + atBoundary.length);
  expect(await findSessionIds([...expired, ...atBoundary])).toEqual([]);
});

test('keeps sessions with attempts or before expiry', async () => {
  const now = new Date(Date.UTC(2033, 5, 1));
  const start = new Date(now.getTime() - 40 * DAY_MS);
  const created = await createGuestSession(depsAt(start), LIMIT);
  if (created.status !== 'created') throw new Error('guest was rate-limited');
  const { guest } = created.created;
  const opened = await openPractice(depsAt(start), guest);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  const notExpired = await insertSessions(
    1,
    new Date(now.getTime() - TERM_MS + SECOND_MS),
  );

  await purge(now);
  const kept = [guest.sessionId, ...notExpired];
  expect((await findSessionIds(kept)).sort()).toEqual([...kept].sort());
  expect(await readAttempts(guest.sessionId)).toEqual([
    { id: opened.practice.attemptId, status: 'active' },
  ]);
  await deleteSessions(kept);
});

const countEvents = async (): Promise<number> => {
  const { count, error } = await serviceDb
    .from('guest_events')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
};

test('purge keeps accumulated events', async () => {
  const now = new Date(Date.UTC(2034, 5, 1));
  const start = new Date(now.getTime() - 40 * DAY_MS);
  const created = await createGuestSession(depsAt(start), LIMIT);
  const sessionId = createdIdOf(created);
  if (created.status !== 'created') throw new Error('guest was rate-limited');
  const { visitorId } = created.created.guest;
  const entries = await serviceDb
    .from('guest_events')
    .select('kind, attempt_id')
    .eq('visitor_id', visitorId);
  expect(entries.data).toEqual([{ kind: 'entry', attempt_id: null }]);
  const before = await countEvents();

  expect(await purge(now)).toBeGreaterThanOrEqual(1);
  expect(await findSessionIds([sessionId])).toEqual([]);
  expect(await countEvents()).toBe(before);
  const kept = await serviceDb
    .from('guest_events')
    .select('kind, attempt_id')
    .eq('visitor_id', visitorId);
  expect(kept.data).toEqual(entries.data);
});

test('denies anon execution of limit and purge functions', async () => {
  const anon = createPublicClient();
  const expired = await insertSessions(1, new Date(Date.now() - 40 * DAY_MS));
  const before = await countSessions();

  const created = await anon.rpc('create_guest_session', {
    p_token_hash: randomBytes(32).toString('hex'),
    p_now: new Date().toISOString(),
    p_limit: 30,
  });
  expect(created.error?.code).toBe('42501');

  const purged = await anon.rpc('purge_expired_empty_guest_sessions', {
    p_now: new Date().toISOString(),
  });
  expect(purged.error?.code).toBe('42501');
  expect(await findSessionIds(expired)).toEqual(expired);
  expect(await countSessions()).toBe(before);
  await deleteSessions(expired);
});
