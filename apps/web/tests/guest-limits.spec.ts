import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildAssignment, examContentSchema } from '@b1k/domain';
import { preflightTimedStart } from '../src/server/attempts/attempts';
import {
  createGuestSession,
  hashGuestToken,
  replaceGuestSession,
} from '../src/server/guest-session/session';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import {
  createPublicClient,
  depsAt,
  latestVersionOf,
  readAttempts,
  readSession,
  serviceDb,
  startBody,
} from './support/db';
import { FULL_EXAM } from './support/full-exam';
import { installM2Fixtures, psql, quote } from './support/sql';
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

const countRows = async (table: string): Promise<number> => {
  const { count, error } = await serviceDb
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
};

// The only spec that fills the real site-wide window: the parallel UX spec
// merely looks at the notice. This one presses the real button.
test('rate limited guest entry redirects to busy without creating session', async ({
  browser,
}) => {
  const filled = await insertSessions(
    TEST_GUEST_SESSIONS_PER_MINUTE,
    new Date(Date.now() - 5 * SECOND_MS),
  );
  const tables = ['guest_sessions', 'attempts', 'attempt_runs', 'attempt_commands'];
  const before = await Promise.all(tables.map(countRows));
  const context = await browser.newContext();
  const page = await context.newPage();
  const starts: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/attempts')) {
      starts.push(request.url());
    }
  });
  try {
    await page.goto('/');
    expect(await context.cookies()).toEqual([]);
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await page.waitForURL('**/?busy=1');
    const notice = page.getByTestId('home-busy');
    await expect(notice).toHaveText(BUSY_TEXT);
    await expect(notice).toHaveAttribute('role', 'alert');
    await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible();
    expect(await context.cookies()).toEqual([]);
    expect(starts).toEqual([]);
    expect(await Promise.all(tables.map(countRows))).toEqual(before);
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

// An attempt started long ago, for a session that has expired since. The
// production start judges the guest by the database clock, so the history is
// written by the trusted test-only wrapper of the same admission kernel with
// the explicit moment of that start.
const startedAt = async (sessionId: string, at: Date): Promise<string> => {
  const latest = await latestVersionOf(PILOT_EXAM_SLUG);
  if (!latest) throw new Error('the pilot is not published');
  const { data, error } = await serviceDb
    .from('exam_versions')
    .select('content, exams!inner(format)')
    .eq('id', latest.versionId)
    .single<{ content: unknown; exams: { format: string } }>();
  if (error) throw error;
  const built = buildAssignment({
    format: data.exams.format,
    versionId: latest.versionId,
    content: examContentSchema.parse(data.content),
    selection: 'all',
  });
  if (!built.ok) throw new Error(`assignment: ${built.error}`);
  const { scope, questionIds } = built.assignment;
  installM2Fixtures();
  return psql(`select attempt_id from m2_test.start_attempt_at(
    ${quote(sessionId)}, ${quote(latest.examId)}, gen_random_uuid(),
    'training', 'normal', 'all', null, ${quote(latest.versionId)},
    ${quote(scope)}, ${quote(JSON.stringify(questionIds))}::jsonb,
    ${quote(at.toISOString())})`);
};

test('keeps sessions with attempts or before expiry', async () => {
  const now = new Date(Date.UTC(2033, 5, 1));
  const start = new Date(now.getTime() - 40 * DAY_MS);
  const created = await createGuestSession(depsAt(start), LIMIT);
  if (created.status !== 'created') throw new Error('guest was rate-limited');
  const { guest } = created.created;
  const attemptId = await startedAt(guest.sessionId, start);
  const notExpired = await insertSessions(
    1,
    new Date(now.getTime() - TERM_MS + SECOND_MS),
  );

  await purge(now);
  const kept = [guest.sessionId, ...notExpired];
  expect((await findSessionIds(kept)).sort()).toEqual([...kept].sort());
  expect(await readAttempts(guest.sessionId)).toEqual([
    { id: attemptId, status: 'active' },
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

// The explicit replacement of a guest too short for a timed block (#44) goes
// through the same site-wide creation limit. Each test lives at its own
// distant moment; the short guests are inserted with the term that ends
// shortly after it.

const TOO_SHORT_SECONDS = 100;

const insertShortGuest = async (
  now: Date,
): Promise<{ id: string; token: string }> => {
  const token = randomBytes(32).toString('base64url');
  const createdAt = new Date(
    now.getTime() - TERM_MS + TOO_SHORT_SECONDS * SECOND_MS,
  );
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .insert({
      token_hash: hashGuestToken(token),
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + TERM_MS).toISOString(),
    })
    .select('id')
    .single<{ id: string }>();
  if (error) throw error;
  return { id: data.id, token };
};

const countInWindow = async (now: Date): Promise<number> => {
  const { count, error } = await serviceDb
    .from('guest_sessions')
    .select('*', { count: 'exact', head: true })
    .gt('created_at', new Date(now.getTime() - 60 * SECOND_MS).toISOString())
    .lte('created_at', now.toISOString());
  if (error) throw error;
  return count ?? 0;
};

const replaceAt = async (now: Date, token: string) => {
  const body = await startBody(FULL_EXAM.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
  });
  return replaceGuestSession(depsAt(now), LIMIT, () =>
    preflightTimedStart(depsAt(now), token, body),
  );
};

test('guest replacement obeys existing creation limit', async () => {
  const now = momentOf(10);
  const filled = await insertSessions(LIMIT - 1, new Date(now.getTime() - 30 * SECOND_MS));
  const first = await insertShortGuest(now);
  const second = await insertShortGuest(now);
  expect(await countInWindow(now)).toBe(LIMIT - 1);

  // The last free place of the window: the replacement is created.
  const created = await replaceAt(now, first.token);
  if (created.status !== 'created') throw new Error(created.status);
  expect(created.created.guest.locale).toBe('en');
  expect(created.created.guest.expiresAt.getTime()).toBe(now.getTime() + TERM_MS);
  expect(await countInWindow(now)).toBe(LIMIT);

  // The window is full: the same limit refuses, with an exact count.
  expect(await replaceAt(now, second.token)).toEqual({ status: 'rate-limited' });
  expect(await countInWindow(now)).toBe(LIMIT);
  await deleteSessions([...filled, first.id, second.id, created.created.guest.sessionId]);
});

test('rate limited replacement creates neither guest nor attempt', async () => {
  const now = momentOf(11);
  const filled = await insertSessions(LIMIT, new Date(now.getTime() - 30 * SECOND_MS));
  const short = await insertShortGuest(now);
  const before = await readSession(short.id);

  expect(await replaceAt(now, short.token)).toEqual({ status: 'rate-limited' });
  expect(await countInWindow(now)).toBe(LIMIT);
  expect(await readAttempts(short.id)).toEqual([]);
  expect(await readSession(short.id)).toEqual(before);
  await deleteSessions([...filled, short.id]);
});
