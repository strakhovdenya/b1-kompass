import { expect, test } from '@playwright/test';
import type { ExamQuestion } from '@b1k/domain';
import {
  finishAttempt,
  openPractice,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import {
  createPublicClient,
  depsNow,
  insertActiveAttempt,
  insertRawVersion,
  newGuest,
  readAnswers,
  readAttemptScope,
  readAttempts,
  readResults,
  readSessionByToken,
  serviceDb,
} from './support/db';
import { FULL_EXAM, FULL_PILOT, FULL_TRACK_ID } from './support/full-exam';
import { createTestRecording } from './support/global-setup';

const { content, keys } = FULL_PILOT;

// Helpers --------------------------------------------------------------------

interface StoredResult {
  scope: string;
  score: number;
  max_score: number;
  correct_count: number;
  incorrect_count: number;
  skipped_count: number;
  percent: number | string | null;
  hoeren_score: number | null;
  hoeren_max: number | null;
  lesen_score: number | null;
  lesen_max: number | null;
  level: string | null;
}

const storedResults = async (attemptId: string) =>
  (await readResults(attemptId)) as StoredResult[];

const uniqueSlug = (name: string) =>
  `test-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const ofSkill = (skill: ExamQuestion['skill']) =>
  content.questions.filter((question) => question.skill === skill);

const keyOf = (question: ExamQuestion): string => {
  const key = keys[question.id];
  if (key === undefined) throw new Error(`no key for ${question.id}`);
  return key;
};

const wrongOption = (question: ExamQuestion): string => {
  const key = keyOf(question);
  const wrong = question.options.find((option) => option.id !== key);
  if (!wrong) throw new Error(`no wrong option for ${question.id}`);
  return wrong.id;
};

interface SkillPlan {
  correct: number;
  incorrect: number;
}

// The first tasks of each skill are answered right, the next ones wrong, the
// rest stays skipped.
const selectionsFor = (hoeren: SkillPlan, lesen: SkillPlan) => {
  const selections: Record<string, string> = {};
  const plans = [
    { skill: 'hoeren' as const, counts: hoeren },
    { skill: 'lesen' as const, counts: lesen },
  ];
  for (const { skill, counts } of plans) {
    const answered = counts.correct + counts.incorrect;
    for (const [index, question] of ofSkill(skill).entries()) {
      if (index < counts.correct) selections[question.id] = keyOf(question);
      else if (index < answered)
        selections[question.id] = wrongOption(question);
    }
  }
  return selections;
};

// 15 + 18 right: 33 of 45, 73.3 %, B1.
const CONTROL_SELECTIONS = selectionsFor(
  { correct: 15, incorrect: 3 },
  { correct: 18, incorrect: 4 },
);

const CONTROL_RESULT = {
  scope: 'full-exam',
  score: 33,
  max_score: 45,
  correct_count: 33,
  incorrect_count: 7,
  skipped_count: 5,
  hoeren_score: 15,
  hoeren_max: 20,
  lesen_score: 18,
  lesen_max: 25,
  level: 'B1',
};

// A guest created through the real server with an attempt on the given exam.
const guestOn = async (slug?: string) => {
  const created = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), created.guest, slug);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  const { attemptId, versionId } = opened.practice;
  return { ...created, attemptId, versionId };
};

const saveAll = async (
  token: string,
  attemptId: string,
  selections: Readonly<Record<string, string>>,
) => {
  for (const [questionId, optionId] of Object.entries(selections)) {
    const saved = await saveAnswer(depsNow(), token, {
      attemptId,
      questionId,
      optionId,
    });
    expect(saved.ok, questionId).toBe(true);
  }
};

const expectActiveWithoutResult = async (
  sessionId: string,
  attemptId: string,
) => {
  const attempts = await readAttempts(sessionId);
  expect(attempts).toContainEqual({ id: attemptId, status: 'active' });
  expect(await readResults(attemptId)).toEqual([]);
};

// Opening ----------------------------------------------------------------------

test('full version attempt opens with full exam scope', async ({ page }) => {
  // A new guest starts in English, so the entry button has its English name.
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.waitForURL('**/practice');
  await expect(page.getByTestId('set-position')).toBeVisible();
  await expect(page.locator('h1')).toHaveText(FULL_EXAM.title);

  const cookie = (await page.context().cookies()).find(
    (c) => c.name === GUEST_COOKIE,
  );
  if (!cookie) throw new Error('guest cookie is missing');
  const session = await readSessionByToken(cookie.value);
  if (!session) throw new Error('guest session is missing');
  const attempts = await readAttempts(session.id);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  if (!attempt) throw new Error('attempt is missing');
  expect(attempt.status).toBe('active');
  expect(await readAttemptScope(attempt.id)).toBe('full-exam');
});

// Completion -------------------------------------------------------------------

test('server scores persisted versioned answers', async () => {
  // The attempt is pinned to version 1; version 2 of the same exam gets a
  // different key that must not reach the score.
  const slug = uniqueSlug('full-pinned');
  const exam = { slug, title: 'Pinned full DTZ', format: 'DTZ' };
  const audio = [{ trackId: FULL_TRACK_ID, ...createTestRecording() }];
  const first = await publishExamVersion(serviceDb, {
    ...exam,
    content,
    keys,
    audio,
  });
  const guest = await guestOn(slug);
  expect(await readAttemptScope(guest.attemptId)).toBe('full-exam');
  await saveAll(guest.token, guest.attemptId, CONTROL_SELECTIONS);

  const otherKeys = Object.fromEntries(
    content.questions.map((question) => [question.id, wrongOption(question)]),
  );
  const second = await publishExamVersion(serviceDb, {
    ...exam,
    content,
    keys: otherKeys,
    audio,
  });
  expect(second.isNew).toBe(true);
  expect(second.versionId).not.toBe(first.versionId);

  const finished = await finishAttempt(depsNow(), guest.token, {
    attemptId: guest.attemptId,
  });
  if (!finished.ok) throw new Error(`finish: ${finished.error}`);
  expect(finished.review).toMatchObject({
    scope: 'full-exam',
    showsLevel: true,
    score: 33,
    maxScore: 45,
    percent: 73.3,
    correct: 33,
    incorrect: 7,
    skipped: 5,
    skills: {
      hoeren: { score: 15, maxScore: 20 },
      lesen: { score: 18, maxScore: 25 },
    },
    level: 'B1',
  });
  expect(finished.review.items).toHaveLength(45);
  expect(
    Object.fromEntries(
      finished.review.items.map((item) => [
        item.questionId,
        item.correctOptionId,
      ]),
    ),
  ).toEqual(keys);

  const results = await storedResults(guest.attemptId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject(CONTROL_RESULT);
  expect(Number(results[0]?.percent)).toBe(73.3);
  expect(await readAnswers(guest.attemptId)).toEqual(CONTROL_SELECTIONS);
  expect(await readAttempts(guest.guest.sessionId)).toEqual([
    { id: guest.attemptId, status: 'completed' },
  ]);
});

test('client score and duplicate finish cannot forge result', async () => {
  const guest = await guestOn(FULL_EXAM.slug);
  await saveAll(guest.token, guest.attemptId, CONTROL_SELECTIONS);
  const { attemptId } = guest;

  for (const forged of [
    { attemptId, scope: 'short-set' },
    { attemptId, score: 45 },
    { attemptId, level: 'B1' },
    { attemptId, role: 'admin' },
  ]) {
    expect(await finishAttempt(depsNow(), guest.token, forged)).toEqual({
      ok: false,
      error: 'invalid-input',
    });
    await expectActiveWithoutResult(guest.guest.sessionId, attemptId);
  }
  const forgedSave = await saveAnswer(depsNow(), guest.token, {
    attemptId,
    questionId: 'hoeren-1',
    optionId: 'a',
    scope: 'full-exam',
  });
  expect(forgedSave).toEqual({ ok: false, error: 'invalid-input' });
  expect(await readAnswers(attemptId)).toEqual(CONTROL_SELECTIONS);

  const finish = () => finishAttempt(depsNow(), guest.token, { attemptId });
  const raced = await Promise.all([finish(), finish()]);
  const repeated = await finish();
  const reviews = [...raced, repeated].map((result) => {
    if (!result.ok) throw new Error(`finish: ${result.error}`);
    return result.review;
  });
  expect(reviews[1]).toEqual(reviews[0]);
  expect(reviews[2]).toEqual(reviews[0]);
  expect(reviews[0]).toMatchObject({ score: 33, level: 'B1', percent: 73.3 });

  const results = await storedResults(attemptId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject(CONTROL_RESULT);
  expect(await readAttempts(guest.guest.sessionId)).toEqual([
    { id: attemptId, status: 'completed' },
  ]);
});

test('short set attempt is finished without grade', async () => {
  const guest = await guestOn();
  expect(await readAttemptScope(guest.attemptId)).toBe('short-set');
  await saveAll(guest.token, guest.attemptId, { 'hoeren-1': 'c' });

  const finished = await finishAttempt(depsNow(), guest.token, {
    attemptId: guest.attemptId,
  });
  if (!finished.ok) throw new Error(`finish: ${finished.error}`);
  expect(finished.review).toMatchObject({
    scope: 'short-set',
    showsLevel: false,
    skills: null,
    level: null,
  });

  const results = await storedResults(guest.attemptId);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    scope: 'short-set',
    hoeren_score: null,
    hoeren_max: null,
    lesen_score: null,
    lesen_max: null,
    level: null,
  });
  const percent = Number(results[0]?.percent);
  expect(percent).toBe(finished.review.percent);
});

// Access -----------------------------------------------------------------------

test('public client cannot call scope functions', async () => {
  const guest = await guestOn(FULL_EXAM.slug);
  const firstTask = ofSkill('hoeren')[0];
  if (!firstTask) throw new Error('first task is missing');
  const answers = { [firstTask.id]: keyOf(firstTask) };
  await saveAll(guest.token, guest.attemptId, answers);
  const attemptsBefore = await readAttempts(guest.guest.sessionId);
  const anon = createPublicClient();

  const opened = await anon.rpc('open_attempt', {
    p_session_id: guest.guest.sessionId,
    p_exam_version_id: guest.versionId,
    p_now: new Date().toISOString(),
    p_scope: 'full-exam',
  });
  expect(opened.data).toBeNull();
  expect(opened.error?.code).toBe('42501');

  const finished = await anon.rpc('finish_attempt', {
    p_session_id: guest.guest.sessionId,
    p_attempt_id: guest.attemptId,
    p_now: new Date().toISOString(),
    p_scope: 'full-exam',
    p_scored_answers: answers,
    p_score: 45,
    p_max_score: 45,
    p_correct: 45,
    p_incorrect: 0,
    p_skipped: 0,
    p_percent: 100,
    p_hoeren_score: 20,
    p_hoeren_max: 20,
    p_lesen_score: 25,
    p_lesen_max: 25,
    p_level: 'B1',
  });
  expect(finished.data).toBeNull();
  expect(finished.error?.code).toBe('42501');

  expect(await readAttempts(guest.guest.sessionId)).toEqual(attemptsBefore);
  await expectActiveWithoutResult(guest.guest.sessionId, guest.attemptId);
  expect(await readAnswers(guest.attemptId)).toEqual(answers);
});

// Broken material --------------------------------------------------------------

test('missing key or invalid pinned version refuses finish', async () => {
  const guest = await newGuest(depsNow());
  const sessionId = guest.guest.sessionId;

  await test.step('a version without the key of one task', async () => {
    const { 'lesen-7': _missing, ...partialKeys } = keys;
    const slug = uniqueSlug('missing-key');
    await insertRawVersion({ slug, content, keys: partialKeys });
    const opened = await openPractice(depsNow(), guest.guest, slug);
    if (opened.status !== 'ready')
      throw new Error(`practice: ${opened.status}`);
    const { attemptId } = opened.practice;
    expect(await readAttemptScope(attemptId)).toBe('full-exam');
    await saveAll(guest.token, attemptId, CONTROL_SELECTIONS);

    expect(await finishAttempt(depsNow(), guest.token, { attemptId })).toEqual({
      ok: false,
      error: 'unavailable',
    });
    await expectActiveWithoutResult(sessionId, attemptId);
  });

  await test.step('a version whose content breaks the schema', async () => {
    const invalid = {
      ...content,
      questions: content.questions.map((question) => ({
        ...question,
        kind: 'essay',
      })),
    };
    const versionId = await insertRawVersion({
      slug: uniqueSlug('invalid-content'),
      content: invalid,
      keys,
    });
    const attemptId = await insertActiveAttempt(
      sessionId,
      versionId,
      'full-exam',
    );

    expect(await finishAttempt(depsNow(), guest.token, { attemptId })).toEqual({
      ok: false,
      error: 'unavailable',
    });
    await expectActiveWithoutResult(sessionId, attemptId);
  });

  const attempts = await readAttempts(sessionId);
  expect(attempts).toHaveLength(2);
  expect(attempts.every((attempt) => attempt.status === 'active')).toBe(true);
});
