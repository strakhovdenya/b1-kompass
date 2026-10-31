import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { ExamQuestion } from '@b1k/domain';
import { openPractice, saveAnswer } from '../src/server/attempts/attempts';
import {
  createGuestSession,
  resolveGuestSession,
} from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  createPublicClient,
  depsAt,
  depsNow,
  readAnswers,
  readAttempts,
  readResults,
  readSession,
  readSessionByToken,
  serviceDb,
} from './support/db';
import { readTestSupabaseEnv } from './support/env';

const PROMPT = 'Was soll Herr Rossi machen?';
const OPTION_A = 'Den anderen Teilnehmern Bescheid sagen.';
const OPTION_B = 'In der Sprachschule anrufen.';
const OPTION_C = 'Sofort in den Kurs kommen.';
const DAY_MS = 24 * 60 * 60 * 1000;

const startGuest = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(page.getByText(PROMPT)).toBeVisible();
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

const activeAttemptOf = async (sessionId: string) => {
  const attempts = await readAttempts(sessionId);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  if (!attempt) throw new Error('attempt is missing');
  return attempt;
};

const option = (page: Page, text: string) =>
  page.getByRole('radio', { name: new RegExp(text.replace('.', '\\.')) });

const saveStatus = (page: Page) => page.getByTestId('save-status');

const openReady = async (
  deps: Parameters<typeof openPractice>[0],
  guest: Parameters<typeof openPractice>[1],
) => {
  const opened = await openPractice(deps, guest);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  return opened.practice;
};

const firstQuestion = (practice: { questions: readonly ExamQuestion[] }) => {
  const question = practice.questions[0];
  if (!question) throw new Error('practice has no questions');
  return question;
};

// A guest with an active attempt and a saved answer, created through the
// real server functions.
const guestWithAnswer = async (optionId: string) => {
  const created = await createGuestSession(depsNow());
  const practice = await openReady(depsNow(), created.guest);
  const saved = await saveAnswer(depsNow(), created.token, {
    attemptId: practice.attemptId,
    questionId: firstQuestion(practice).id,
    optionId,
  });
  expect(saved.ok).toBe(true);
  return { ...created, attemptId: practice.attemptId };
};

test('fresh guest starts in English and owns locale', async ({ browser }) => {
  const first = await browser.newContext();
  const other = await browser.newContext();
  const page = await first.newPage();
  const otherPage = await other.newPage();

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(
    page.getByRole('heading', { name: 'Practise for the German DTZ exam' }),
  ).toBeVisible();
  await startGuest(page);
  await startGuest(otherPage);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText(/Part of the exam: Hören Teil 1/)).toBeVisible();

  await option(page, OPTION_B).check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByText(/Часть экзамена: Hören Teil 1/)).toBeVisible();
  await expect(page.getByText(PROMPT)).toBeVisible();
  await expect(option(page, OPTION_B)).toBeChecked();

  await otherPage.reload();
  await expect(otherPage.locator('html')).toHaveAttribute('lang', 'en');
  await expect(otherPage.getByText(/Part of the exam/)).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  expect((await sessionOf(first)).locale).toBe('ru');
  expect((await sessionOf(other)).locale).toBe('en');

  await first.close();
  await other.close();
});

test('ignores browser and previous account locale', async ({
  browser,
  baseURL,
}) => {
  // A previous guest of this browser used Russian; its session has ended.
  const previous = await createGuestSession(
    depsAt(new Date(Date.now() - 31 * DAY_MS)),
  );
  await serviceDb
    .from('guest_sessions')
    .update({ locale: 'ru' })
    .eq('id', previous.guest.sessionId)
    .throwOnError();
  const context = await browser.newContext({
    locale: 'ru-RU',
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });
  await context.addCookies([
    { name: GUEST_COOKIE, value: previous.token, url: baseURL },
    { name: 'NEXT_LOCALE', value: 'ru', url: baseURL },
  ]);
  const page = await context.newPage();

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeVisible();
  await startGuest(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText(/Part of the exam/)).toBeVisible();

  const current = await sessionOf(context);
  expect(current.id).not.toBe(previous.guest.sessionId);
  expect(current.locale).toBe('en');
  expect((await readSession(previous.guest.sessionId)).locale).toBe('ru');

  await page.getByRole('button', { name: 'Русский' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await context.close();
});

test('saves one real answer after server acknowledgement', async ({ page }) => {
  await startGuest(page);
  await expect(option(page, OPTION_A)).toBeVisible();
  await expect(option(page, OPTION_B)).toBeVisible();
  await expect(option(page, OPTION_C)).toBeVisible();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'idle');

  // The initial document carries the task but no key and no server secret.
  const html = await (await page.request.get('/practice')).text();
  expect(html).toContain(PROMPT);
  expect(html).not.toMatch(/correct/i);
  expect(html).not.toContain('answer_keys');
  expect(html).not.toContain(readTestSupabaseEnv().secretKey);

  const session = await sessionOf(page.context());
  const attempt = await activeAttemptOf(session.id);
  expect(await readAnswers(attempt.id)).toEqual({});

  await option(page, OPTION_B).check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  await expect(saveStatus(page)).toHaveText(/Saved/);
  expect(await readAnswers(attempt.id)).toEqual({ 'hoeren-1': 'b' });

  await page.reload();
  await expect(option(page, OPTION_B)).toBeChecked();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');

  await option(page, OPTION_A).check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  expect(await readAnswers(attempt.id)).toEqual({ 'hoeren-1': 'a' });
  expect(await readAttempts(session.id)).toHaveLength(1);
});

test('failed save retains selection without false saved status', async ({
  page,
}) => {
  await startGuest(page);
  const attempt = await activeAttemptOf((await sessionOf(page.context())).id);
  await page.route('**/practice', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, body: 'unavailable' });
    } else {
      await route.continue();
    }
  });

  await option(page, OPTION_C).check();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'error');
  await expect(saveStatus(page)).toContainText('Your answer was not saved');
  await expect(saveStatus(page)).not.toContainText('Saved');
  await expect(option(page, OPTION_C)).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({});

  await page.unroute('**/practice');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved');
  await expect(option(page, OPTION_C)).toBeChecked();
  expect(await readAnswers(attempt.id)).toEqual({ 'hoeren-1': 'c' });
});

test('authorized guest reads and saves scoped attempt', async () => {
  const first = await createGuestSession(depsNow());
  const second = await createGuestSession(depsNow());

  const practice = await openReady(depsNow(), first.guest);
  expect(Object.keys(firstQuestion(practice)).sort()).toEqual(
    ['id', 'kind', 'number', 'options', 'prompt', 'skill', 'teil'],
  );
  expect(JSON.stringify(practice)).not.toMatch(/correct|key/i);
  expect(firstQuestion(practice).prompt).toBe(PROMPT);

  const saved = await saveAnswer(depsNow(), first.token, {
    attemptId: practice.attemptId,
    questionId: 'hoeren-1',
    optionId: 'b',
  });
  expect(saved).toMatchObject({ ok: true, questionId: 'hoeren-1', optionId: 'b' });
  expect(await readAnswers(practice.attemptId)).toEqual({ 'hoeren-1': 'b' });

  const again = await openReady(depsNow(), first.guest);
  expect(again.attemptId).toBe(practice.attemptId);
  expect(again.selections).toEqual({ 'hoeren-1': 'b' });

  const others = await openReady(depsNow(), second.guest);
  expect(others.attemptId).not.toBe(practice.attemptId);
  expect(others.selections).toEqual({});

  const notAnOption = await saveAnswer(depsNow(), first.token, {
    attemptId: practice.attemptId,
    questionId: 'hoeren-1',
    optionId: 'x',
  });
  expect(notAnOption).toEqual({ ok: false, error: 'option-not-allowed' });
  expect(await readAnswers(practice.attemptId)).toEqual({ 'hoeren-1': 'b' });
});

test('denies foreign attempt secret and direct API mutations', async ({
  request,
}) => {
  const owner = await guestWithAnswer('a');
  const stranger = await guestWithAnswer('b');
  const anon = createPublicClient();
  const valid = { attemptId: owner.attemptId, questionId: 'hoeren-1', optionId: 'c' };
  const ownerAnswerStays = async () =>
    expect(await readAnswers(owner.attemptId)).toEqual({ 'hoeren-1': 'a' });

  await test.step('missing or unknown session', async () => {
    expect(await saveAnswer(depsNow(), null, valid)).toEqual({
      ok: false,
      error: 'session-invalid',
    });
    expect(
      await saveAnswer(depsNow(), 'A'.repeat(43), valid),
    ).toEqual({ ok: false, error: 'session-invalid' });
    const response = await request.get('/practice', { maxRedirects: 0 });
    expect(response.status()).toBeGreaterThanOrEqual(300);
    expect(response.status()).toBeLessThan(400);
    expect(await response.text()).not.toContain(PROMPT);
    await ownerAnswerStays();
  });

  await test.step('foreign attempt', async () => {
    expect(await saveAnswer(depsNow(), stranger.token, valid)).toEqual({
      ok: false,
      error: 'attempt-not-found',
    });
    await ownerAnswerStays();
    expect(await readAnswers(stranger.attemptId)).toEqual({ 'hoeren-1': 'b' });
  });

  await test.step('direct read of keys, material, sessions and sources', async () => {
    for (const table of [
      'answer_keys',
      'exam_versions',
      'exams',
      'guest_sessions',
      'attempts',
      'attempt_answers',
      'attempt_results',
    ]) {
      const { data, error } = await anon.from(table).select('*');
      expect(error, table).not.toBeNull();
      expect(data, table).toBeNull();
    }
    const rpc = await anon.rpc('save_attempt_answer', {
      p_session_id: owner.guest.sessionId,
      p_attempt_id: owner.attemptId,
      p_question_id: 'hoeren-1',
      p_option_id: 'c',
      p_now: new Date().toISOString(),
    });
    expect(rpc.error).not.toBeNull();
    expect(rpc.data).toBeNull();

    const path = `pilot/${owner.attemptId}.json`;
    await serviceDb.storage
      .from('exam-sources')
      .upload(path, JSON.stringify({ 'hoeren-1': 'c' }), {
        contentType: 'application/json',
      })
      .then(({ error }) => expect(error).toBeNull());
    const download = await anon.storage.from('exam-sources').download(path);
    expect(download.data).toBeNull();
    expect(download.error).not.toBeNull();
    const listing = await anon.storage.from('exam-sources').list('pilot');
    expect(listing.data ?? []).toEqual([]);
    const upload = await anon.storage
      .from('exam-sources')
      .upload('pilot/forged.json', '{}');
    expect(upload.error).not.toBeNull();
    const published = await anon.rpc('publish_exam_version', {
      p_slug: 'forged',
      p_title: 'Forged',
      p_format: 'DTZ',
      p_content: { questions: [] },
      p_keys: {},
    });
    expect(published.error).not.toBeNull();
    const { count } = await serviceDb
      .from('exams')
      .select('id', { count: 'exact', head: true })
      .eq('slug', 'forged');
    expect(count).toBe(0);
    await ownerAnswerStays();
  });

  await test.step('role and owner changes', async () => {
    expect(
      await saveAnswer(depsNow(), owner.token, { ...valid, role: 'owner' }),
    ).toEqual({ ok: false, error: 'invalid-input' });
    expect(
      await saveAnswer(depsNow(), owner.token, {
        ...valid,
        guestSessionId: stranger.guest.sessionId,
      }),
    ).toEqual({ ok: false, error: 'invalid-input' });
    const update = await anon
      .from('guest_sessions')
      .update({ locale: 'ru' })
      .eq('id', owner.guest.sessionId);
    expect(update.error).not.toBeNull();
    expect((await readSession(owner.guest.sessionId)).locale).toBe('en');
    const reassign = await anon
      .from('attempts')
      .update({ guest_session_id: stranger.guest.sessionId })
      .eq('id', owner.attemptId);
    expect(reassign.error).not.toBeNull();
    const signUp = await anon.auth.signUp({
      email: `guest-${Date.now()}@example.org`,
      password: 'correct-horse-battery-staple',
    });
    expect(signUp.error).not.toBeNull();
    expect(signUp.data.user).toBeNull();
    await ownerAnswerStays();
  });

  await test.step('ready score and status', async () => {
    expect(
      await saveAnswer(depsNow(), owner.token, { ...valid, score: 45 }),
    ).toEqual({ ok: false, error: 'invalid-input' });
    const insert = await anon
      .from('attempt_results')
      .insert({ attempt_id: owner.attemptId, score: 45, max_score: 45 });
    expect(insert.error).not.toBeNull();
    const complete = await anon
      .from('attempts')
      .update({ status: 'completed' })
      .eq('id', owner.attemptId);
    expect(complete.error).not.toBeNull();
    expect(await readResults(owner.attemptId)).toEqual([]);
    expect(await readAttempts(owner.guest.sessionId)).toEqual([
      { id: owner.attemptId, status: 'active' },
    ]);
    await ownerAnswerStays();
  });
});

const createdAtStart = async (): Promise<{ start: Date; created: CreatedGuest }> => {
  const start = new Date();
  return { start, created: await createGuestSession(depsAt(start)) };
};

test('guest expiry remains fixed before deadline', async () => {
  const { start, created } = await createdAtStart();
  const stored = await readSession(created.guest.sessionId);
  const createdAt = new Date(stored.created_at).getTime();
  const expiresAt = new Date(stored.expires_at).getTime();
  expect(createdAt).toBe(start.getTime());
  expect(expiresAt - createdAt).toBe(30 * DAY_MS);

  const nearDeadline = depsAt(new Date(expiresAt - 60_000));
  const guest = await resolveGuestSession(nearDeadline, created.token);
  expect(guest?.sessionId).toBe(created.guest.sessionId);
  const practice = await openReady(nearDeadline, created.guest);
  const saved = await saveAnswer(nearDeadline, created.token, {
    attemptId: practice.attemptId,
    questionId: 'hoeren-1',
    optionId: 'b',
  });
  expect(saved.ok).toBe(true);

  const prolong = await serviceDb
    .from('guest_sessions')
    .update({ expires_at: new Date(expiresAt + DAY_MS).toISOString() })
    .eq('id', created.guest.sessionId);
  expect(prolong.error).not.toBeNull();

  const after = await readSession(created.guest.sessionId);
  expect(new Date(after.created_at).getTime()).toBe(createdAt);
  expect(new Date(after.expires_at).getTime()).toBe(expiresAt);
});

test('rejects guest at expiry boundary', async () => {
  const { created } = await createdAtStart();
  const practice = await openReady(depsNow(), created.guest);
  await saveAnswer(depsNow(), created.token, {
    attemptId: practice.attemptId,
    questionId: 'hoeren-1',
    optionId: 'a',
  });
  const atExpiry = depsAt(created.guest.expiresAt);

  expect(await resolveGuestSession(atExpiry, created.token)).toBeNull();
  expect(
    await saveAnswer(atExpiry, created.token, {
      attemptId: practice.attemptId,
      questionId: 'hoeren-1',
      optionId: 'b',
    }),
  ).toEqual({ ok: false, error: 'session-invalid' });

  // Even with a context obtained earlier, the database refuses new work.
  await serviceDb
    .from('attempts')
    .update({ status: 'completed' })
    .eq('id', practice.attemptId)
    .throwOnError();
  expect(await openPractice(atExpiry, created.guest)).toEqual({
    status: 'session-invalid',
  });
  const direct = await serviceDb.rpc('save_attempt_answer', {
    p_session_id: created.guest.sessionId,
    p_attempt_id: practice.attemptId,
    p_question_id: 'hoeren-1',
    p_option_id: 'b',
    p_now: created.guest.expiresAt.toISOString(),
  });
  expect(direct.error?.hint).toBe('guest_session_invalid');

  expect(await readAnswers(practice.attemptId)).toEqual({ 'hoeren-1': 'a' });
  expect(await readAttempts(created.guest.sessionId)).toEqual([
    { id: practice.attemptId, status: 'completed' },
  ]);
});
