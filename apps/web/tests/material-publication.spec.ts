import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SYNTHETIC_TRACK_ID, buildSyntheticPilot } from '@b1k/domain';
import type { AnswerKeys, ExamContent } from '@b1k/domain';
import {
  PILOT_CONTENT,
  PILOT_EXAM,
  PILOT_TRACK_ID,
} from '../../../scripts/seed-pilot-question';
import {
  PublicationRejectedError,
  publishExamVersion,
} from '../../../scripts/lib/publish-exam-version';
import type {
  PublishInput,
  PublishOutcome,
} from '../../../scripts/lib/publish-exam-version';
import { FULL_PILOT_TRACK_ID } from '../../../scripts/lib/pilot';
import { runOwnerCli } from '../../../scripts/manage-exam-library';
import { publishFullPilot } from '../../../scripts/publish-pilot';
import { getAttemptReview, saveAnswer } from '../src/server/attempts/attempts';
import { getPublishedVersion } from '../src/server/material/published';
import {
  countVersionKeys,
  createPublicClient,
  createServiceTestClient,
  depsNow,
  newGuest,
  openStarted,
  readAnswers,
  readAttempts,
  readExamState,
  readOpened,
  readResults,
  serviceDb,
  submitStored,
} from './support/db';
import { TEST_PILOT_KEYS, createTestRecording } from './support/global-setup';
import {
  CHOICE_URL,
  LIBRARY_URL,
  continueThroughLibrary,
} from './support/guest-browser';
import {
  DB_CONTAINER,
  assertLocalTarget,
  localTarget,
  psql,
  quote,
  waitersBehind,
} from './support/sql';
import type { AttemptLock } from './support/sql';

const AUDIO_BUCKET = 'exam-sources';
// Attempt ids that sort before and after any random id, fresh on every run.
const tail = () => randomBytes(6).toString('hex');
const lowId = () => `00000000-0000-4000-8000-${tail()}`;
const highId = () => `ffffffff-ffff-4fff-bfff-${tail()}`;

// Each test publishes into its own exam, so no other test sees these
// versions and every test starts from a known state.
let counter = 0;
const uniqueExam = () => ({
  slug: `test-pub-${Date.now().toString(36)}-${counter++}`,
  title: 'Publication test',
  format: 'DTZ',
});

type TestExam = ReturnType<typeof uniqueExam>;

const countRows = async (table: string): Promise<number> => {
  const { count, error } = await serviceDb
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
};

const bucketObjects = async (): Promise<string[]> => {
  const { data, error } = await serviceDb.storage
    .from(AUDIO_BUCKET)
    .list('audio', { limit: 1000 });
  if (error) throw error;
  return data.map((object) => object.name).toSorted();
};

const corrected = (content: ExamContent): ExamContent => ({
  ...content,
  questions: content.questions.map((question) =>
    question.id === 'hoeren-2'
      ? { ...question, prompt: `${question.prompt} (korrigiert)` }
      : question,
  ),
});

const publishShort = (
  exam: TestExam,
  content: ExamContent = PILOT_CONTENT,
  keys: Readonly<Record<string, string>> = TEST_PILOT_KEYS,
): Promise<PublishOutcome> =>
  publishExamVersion(serviceDb, {
    ...exam,
    content,
    keys,
    audio: [{ trackId: PILOT_TRACK_ID, ...createTestRecording() }],
  });

const storedVersion = async (versionId: string) => {
  const [version, keys, audio] = await Promise.all([
    serviceDb.from('exam_versions').select('*').eq('id', versionId).single(),
    serviceDb
      .from('answer_keys')
      .select('question_id, correct_option_id')
      .eq('exam_version_id', versionId)
      .order('question_id'),
    serviceDb
      .from('exam_version_audio')
      .select('track_id, object_path, sha256')
      .eq('exam_version_id', versionId)
      .order('track_id'),
  ]);
  if (version.error) throw version.error;
  if (keys.error) throw keys.error;
  if (audio.error) throw audio.error;
  return { version: version.data, keys: keys.data, audio: audio.data };
};

const countVersions = async (slug: string): Promise<number> => {
  const { data, error } = await serviceDb
    .from('exam_versions')
    .select('id, exams!inner(slug)')
    .eq('exams.slug', slug);
  if (error) throw error;
  return data.length;
};

const openReady = async (
  guest: Awaited<ReturnType<typeof newGuest>>,
  slug: string,
) => {
  const opened = await openStarted(depsNow(), guest, slug);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  return opened.practice;
};

// An active attempt written straight into the test database with its exam,
// then given its run by the real scoped M1 transfer (owner-only, through
// psql). A second active attempt of the same exam is refused by the slot
// index: the insert error is returned and nothing else is written.
const insertAttempt = async (
  sessionId: string,
  versionId: string,
  fields: { id: string; createdAt: string },
  answers: Record<string, string>,
): Promise<{ code?: string } | null> => {
  const version = await serviceDb
    .from('exam_versions')
    .select('exam_id')
    .eq('id', versionId)
    .single<{ exam_id: string }>();
  if (version.error) throw version.error;
  const inserted = await serviceDb.from('attempts').insert({
    id: fields.id,
    guest_session_id: sessionId,
    exam_id: version.data.exam_id,
    exam_version_id: versionId,
    status: 'active',
    created_at: fields.createdAt,
    updated_at: fields.createdAt,
  });
  if (inserted.error) return inserted.error;
  const rows = Object.entries(answers).map(([questionId, optionId]) => ({
    attempt_id: fields.id,
    question_id: questionId,
    option_id: optionId,
  }));
  const saved = await serviceDb.from('attempt_answers').insert(rows);
  if (saved.error) throw saved.error;
  psql(`select * from m2_private.backfill_m1_attempts(${quote(fields.id)})`);
  return null;
};

// Publication ----------------------------------------------------------------

test('publishes validated full pilot with source references', async () => {
  const exam = uniqueExam();
  const { content, keys } = buildSyntheticPilot();
  const versionsBefore = await countRows('exam_versions');
  const keysBefore = await countRows('answer_keys');

  const outcome = await publishFullPilot(serviceDb, {
    exam,
    content,
    keys,
    audio: createTestRecording(),
  });
  expect(outcome.isNew).toBe(true);
  expect(await countRows('exam_versions')).toBe(versionsBefore + 1);
  expect(await countRows('answer_keys')).toBe(keysBefore + 45);

  const stored = await storedVersion(outcome.versionId);
  const questions = content.questions;
  expect(questions.filter((q) => q.skill === 'hoeren')).toHaveLength(20);
  expect(questions.filter((q) => q.skill === 'lesen')).toHaveLength(25);
  expect(stored.keys).toHaveLength(45);
  expect(stored.keys.map((row) => row.question_id).toSorted()).toEqual(
    questions.map((q) => q.id).toSorted(),
  );
  const exampleIds = (content.examples ?? []).map((e) => e.id);
  expect(exampleIds).toHaveLength(1);
  for (const row of stored.keys) {
    expect(exampleIds).not.toContain(row.question_id);
  }
  expect(stored.audio.map((row) => row.track_id)).toEqual([
    FULL_PILOT_TRACK_ID,
  ]);
  expect(FULL_PILOT_TRACK_ID).toBe(SYNTHETIC_TRACK_ID);

  const projection = await getPublishedVersion(depsNow(), exam.slug);
  expect(projection?.versionId).toBe(outcome.versionId);
  expect(projection?.content).toEqual(content);
  const text = JSON.stringify(projection);
  expect(text).not.toContain('correct');
  expect(text).not.toContain('"keys"');
  const hoeren = questions.filter((q) => q.skill === 'hoeren');
  expect(hoeren.every((q) => q.trackId === FULL_PILOT_TRACK_ID)).toBe(true);
  expect(questions.every((q) => q.sourcePage !== undefined)).toBe(true);
  const lesen = questions.filter((q) => q.skill === 'lesen');
  expect(lesen.every((q) => q.textId !== undefined)).toBe(true);
  const kinds = projection?.content.groups?.map((group) => group.kind);
  expect(kinds).toContain('shared-set');
});

test('rejected pilot leaves no partial state', async () => {
  const exam = uniqueExam();
  const { content, keys } = buildSyntheticPilot();
  const contradictory = { ...keys, 'hoeren-2': 'z' };
  const versionsBefore = await countRows('exam_versions');
  const keysBefore = await countRows('answer_keys');
  const examsBefore = await countRows('exams');
  const objectsBefore = await bucketObjects();

  // Straight to the database function: the domain validator is bypassed.
  const { data, error } = await serviceDb.rpc('publish_exam_version', {
    p_slug: exam.slug,
    p_title: exam.title,
    p_format: exam.format,
    p_content: content,
    p_keys: contradictory,
    p_audio: [],
  });
  expect(data).toBeNull();
  expect(error?.hint).toBe('material_invalid');

  expect(await countRows('exam_versions')).toBe(versionsBefore);
  expect(await countRows('answer_keys')).toBe(keysBefore);
  expect(await countRows('exams')).toBe(examsBefore);
  expect(await bucketObjects()).toEqual(objectsBefore);
  expect(await getPublishedVersion(depsNow(), exam.slug)).toBeNull();
});

test('guest cannot publish or read private source', async () => {
  const exam = uniqueExam();
  const { content, keys } = buildSyntheticPilot();
  const recording = createTestRecording();
  const published = await publishShort(exam);
  const { audio } = await storedVersion(published.versionId);
  const objectPath = audio[0]?.object_path;
  if (!objectPath) throw new Error('track is missing');

  const guest = createPublicClient();
  const versionsBefore = await countRows('exam_versions');
  const keysBefore = await countRows('answer_keys');
  const objectsBefore = await bucketObjects();
  const other = uniqueExam();

  const rpc = await guest.rpc('publish_exam_version', {
    p_slug: other.slug,
    p_title: other.title,
    p_format: other.format,
    p_content: content,
    p_keys: keys,
    p_audio: [],
  });
  expect(rpc.error).not.toBeNull();
  expect(rpc.data).toBeNull();

  const upload = await guest.storage
    .from(AUDIO_BUCKET)
    .upload(`audio/guest-${Date.now()}.wav`, recording.bytes, {
      contentType: 'audio/wav',
    });
  expect(upload.error).not.toBeNull();

  const download = await guest.storage.from(AUDIO_BUCKET).download(objectPath);
  expect(download.data).toBeNull();
  expect(download.error).not.toBeNull();
  const listed = await guest.storage.from(AUDIO_BUCKET).list('audio');
  expect(listed.data ?? []).toEqual([]);

  for (const table of ['answer_keys', 'exam_versions', 'exam_version_audio']) {
    const read = await guest.from(table).select('*').limit(1);
    expect(read.error).not.toBeNull();
    expect(read.data).toBeNull();
  }
  const insert = await guest.from('exam_versions').insert({ id: lowId() });
  expect(insert.error).not.toBeNull();

  expect(await countRows('exam_versions')).toBe(versionsBefore);
  expect(await countRows('answer_keys')).toBe(keysBefore);
  expect(await bucketObjects()).toEqual(objectsBefore);
  expect(await getPublishedVersion(depsNow(), other.slug)).toBeNull();
});

test('identical content reuses version and correction creates new version', async () => {
  const exam = uniqueExam();
  const first = await publishShort(exam);
  expect(first.isNew).toBe(true);
  const before = await storedVersion(first.versionId);

  const reordered = Object.fromEntries(
    Object.entries(TEST_PILOT_KEYS).reverse(),
  );
  const sameContent: ExamContent = JSON.parse(JSON.stringify(PILOT_CONTENT));
  const again = await publishShort(exam, sameContent, reordered);
  expect(again).toEqual({ versionId: first.versionId, isNew: false });
  expect(await countVersions(exam.slug)).toBe(1);

  const fix = await publishShort(exam, corrected(PILOT_CONTENT));
  expect(fix.isNew).toBe(true);
  expect(fix.versionId).not.toBe(first.versionId);
  expect(await countVersions(exam.slug)).toBe(2);
  const latest = await getPublishedVersion(depsNow(), exam.slug);
  expect(latest?.versionId).toBe(fix.versionId);
  expect(await storedVersion(first.versionId)).toEqual(before);
  // A caller without intent and with the unchanged title and format (as
  // globalSetup and the pilot tools) keeps the exam identity (#81).
  expect(await readExamState(exam.slug)).toEqual({
    title: exam.title,
    format: exam.format,
    versionIds: [first.versionId, fix.versionId],
  });
});

// Attempts and corrections ----------------------------------------------------

test('published correction never mutates active pinned version', async () => {
  const exam = uniqueExam();
  const original = await publishShort(exam);
  const guest = await newGuest(depsNow());
  const first = await openReady(guest, exam.slug);
  expect(first.versionId).toBe(original.versionId);
  const saved = await saveAnswer(depsNow(), guest.token, {
    attemptId: first.attemptId,
    questionId: 'hoeren-2',
    optionId: 'b',
    revision: 1,
  });
  expect(saved.ok).toBe(true);
  const storedBefore = await storedVersion(original.versionId);

  const fix = await publishShort(exam, corrected(PILOT_CONTENT));
  expect(fix.versionId).not.toBe(original.versionId);

  const reopened = await openReady(guest, exam.slug);
  expect(reopened.attemptId).toBe(first.attemptId);
  expect(reopened.versionId).toBe(original.versionId);
  expect(reopened.questions).toEqual(PILOT_CONTENT.questions);
  expect(reopened.selections).toEqual({ 'hoeren-2': 'b' });
  expect(reopened.trackIds).toEqual([PILOT_TRACK_ID]);

  expect(await readAttempts(guest.guest.sessionId)).toEqual([
    { id: first.attemptId, status: 'active' },
  ]);
  expect(await readAnswers(first.attemptId)).toEqual({ 'hoeren-2': 'b' });
  expect(await storedVersion(original.versionId)).toEqual(storedBefore);

  // The attempt of version 1 is completed while version 2 is published: its
  // review scores by the key of version 1 and stays the same when a third
  // version with another key appears (#81, TR-2).
  const finished = await submitStored(depsNow(), guest.token, {
    attemptId: first.attemptId,
  });
  if (!finished.ok) throw new Error(`submit: ${finished.error}`);
  expect(
    finished.review.items.find((item) => item.questionId === 'hoeren-2'),
  ).toEqual({
    questionId: 'hoeren-2',
    selectedOptionId: 'b',
    correctOptionId: TEST_PILOT_KEYS['hoeren-2'],
    outcome: 'incorrect',
  });
  const results = await readResults(first.attemptId);
  expect(results).toHaveLength(1);
  const rekeyed = await publishShort(exam, corrected(PILOT_CONTENT), {
    ...TEST_PILOT_KEYS,
    'hoeren-2': 'b',
  });
  expect(rekeyed.isNew).toBe(true);
  expect(
    await getAttemptReview(depsNow(), guest.token, {
      attemptId: first.attemptId,
    }),
  ).toEqual({ ok: true, review: finished.review });
  const completed = await readOpened(
    depsNow(),
    guest.guest,
    exam.slug,
    first.attemptId,
  );
  if (completed.status !== 'ready') throw new Error('review is not ready');
  expect(completed.practice.versionId).toBe(original.versionId);
  expect(completed.practice.questions).toEqual(PILOT_CONTENT.questions);
  expect(await readResults(first.attemptId)).toEqual(results);
  expect(await storedVersion(original.versionId)).toEqual(storedBefore);
});

test('guest without active attempt opens corrected version', async () => {
  const exam = uniqueExam();
  await publishShort(exam);
  const fix = await publishShort(exam, corrected(PILOT_CONTENT));

  const guest = await newGuest(depsNow());
  expect(await readAttempts(guest.guest.sessionId)).toEqual([]);
  const practice = await openReady(guest, exam.slug);
  expect(practice.versionId).toBe(fix.versionId);
  expect(practice.questions).toEqual(corrected(PILOT_CONTENT).questions);
  expect(practice.selections).toEqual({});
  const attempts = await readAttempts(guest.guest.sessionId);
  expect(attempts).toEqual([{ id: practice.attemptId, status: 'active' }]);
});

test('finished attempt does not pin guest to old version', async () => {
  const exam = uniqueExam();
  const original = await publishShort(exam);
  const guest = await newGuest(depsNow());
  const first = await openReady(guest, exam.slug);
  await saveAnswer(depsNow(), guest.token, {
    attemptId: first.attemptId,
    questionId: 'hoeren-1',
    optionId: 'c',
    revision: 1,
  });
  const finished = await submitStored(depsNow(), guest.token, {
    attemptId: first.attemptId,
  });
  expect(finished.ok).toBe(true);
  const resultBefore = await readResults(first.attemptId);
  expect(resultBefore).toHaveLength(1);

  const fix = await publishShort(exam, corrected(PILOT_CONTENT));
  const next = await openReady(guest, exam.slug);
  expect(next.attemptId).not.toBe(first.attemptId);
  expect(next.versionId).toBe(fix.versionId);
  expect(next.versionId).not.toBe(original.versionId);
  expect(next.selections).toEqual({});
  expect(next.review).toBeNull();

  const byId = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  const attempts = await readAttempts(guest.guest.sessionId);
  expect(attempts.toSorted(byId)).toEqual(
    [
      { id: first.attemptId, status: 'completed' },
      { id: next.attemptId, status: 'active' },
    ].toSorted(byId),
  );
  expect(await readResults(first.attemptId)).toEqual(resultBefore);
  expect(await readAnswers(first.attemptId)).toEqual({ 'hoeren-1': 'c' });
});

test('two active attempts resume the latest created', async () => {
  const exam = uniqueExam();
  const oldVersion = await publishShort(exam);
  const newVersion = await publishShort(exam, corrected(PILOT_CONTENT));
  const guest = await newGuest(depsNow());
  const { sessionId } = guest.guest;
  const laterId = lowId();
  const earlierId = highId();
  // The later attempt has the smaller id and is on the older version, so
  // neither "highest id" nor "latest version" would pick it. Since M2 one
  // slot per guest and exam exists on any version: the second active attempt
  // is refused by the database, and M1 duplicates are resolved by the
  // migration with the same latest-created rule (m1-migration.spec.ts).
  expect(
    await insertAttempt(
      sessionId,
      oldVersion.versionId,
      { id: laterId, createdAt: '2026-10-01T10:00:00.000Z' },
      { 'hoeren-1': 'a' },
    ),
  ).toBeNull();
  const second = await insertAttempt(
    sessionId,
    newVersion.versionId,
    { id: earlierId, createdAt: '2026-09-01T10:00:00.000Z' },
    { 'hoeren-3': 'c' },
  );
  expect(second?.code).toBe('23505');

  const practice = await openReady(guest, exam.slug);
  expect(practice.attemptId).toBe(laterId);
  expect(practice.versionId).toBe(oldVersion.versionId);
  expect(practice.selections).toEqual({ 'hoeren-1': 'a' });
  expect(await readAttempts(sessionId)).toEqual([
    { id: laterId, status: 'active' },
  ]);
  expect(await readAnswers(earlierId)).toEqual({});
  expect(await readAnswers(laterId)).toEqual({ 'hoeren-1': 'a' });
});

test('equal created_at resumes the highest id', async () => {
  const exam = uniqueExam();
  const oldVersion = await publishShort(exam);
  const newVersion = await publishShort(exam, corrected(PILOT_CONTENT));
  const guest = await newGuest(depsNow());
  const { sessionId } = guest.guest;
  const createdAt = '2026-10-01T10:00:00.000Z';
  const lowerId = lowId();
  const higherId = highId();
  // One slot per guest and exam: an equal created_at no longer yields two
  // active attempts. The migration breaks such M1 ties by the highest id
  // (m1-migration.spec.ts); a new second active attempt is refused.
  expect(
    await insertAttempt(
      sessionId,
      oldVersion.versionId,
      { id: higherId, createdAt },
      { 'hoeren-4': 'b' },
    ),
  ).toBeNull();
  const second = await insertAttempt(
    sessionId,
    newVersion.versionId,
    { id: lowerId, createdAt },
    { 'hoeren-2': 'a' },
  );
  expect(second?.code).toBe('23505');

  const practice = await openReady(guest, exam.slug);
  expect(practice.attemptId).toBe(higherId);
  expect(practice.versionId).toBe(oldVersion.versionId);
  expect(practice.selections).toEqual({ 'hoeren-4': 'b' });
  expect(await readAttempts(sessionId)).toEqual([
    { id: higherId, status: 'active' },
  ]);
  expect(await readAnswers(lowerId)).toEqual({});
  expect(await readAnswers(higherId)).toEqual({ 'hoeren-4': 'b' });
});

test('pilot exam slug is the default of openPractice', async ({ page }) => {
  const guest = await newGuest(depsNow());
  const opened = await openStarted(depsNow(), guest);
  if (opened.status !== 'ready') throw new Error('practice is missing');
  const version = await getPublishedVersion(depsNow(), PILOT_EXAM.slug);
  expect(opened.practice.versionId).toBe(version?.versionId);
  expect(opened.practice.examSlug).toBe(PILOT_EXAM.slug);

  // The entry of a new guest on a server without PRACTICE_EXAM_SLUG opens the
  // choice of the pilot exam, and the legacy address leads there too.
  await page.goto('/');
  await continueThroughLibrary(page);
  await page.waitForURL(CHOICE_URL);
  expect(new URL(page.url()).pathname).toBe(`/practice/${PILOT_EXAM.slug}`);
  await page.goto('/practice');
  expect(new URL(page.url()).pathname).toBe(`/practice/${PILOT_EXAM.slug}`);
  await expect(page.getByTestId('mode-selection')).toHaveAttribute(
    'data-exam-slug',
    PILOT_EXAM.slug,
  );
});

// Owner publication with intent and the SQL identity guard (#81) -------------

const FULL = buildSyntheticPilot();

const ownerDirs: string[] = [];

test.afterAll(async () => {
  await Promise.all(
    ownerDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const uniqueFullSlug = () => `test-owner-${randomUUID().slice(0, 8)}`;

// A recording no other test uploads: its object would reveal an upload.
const uniqueRecording = (): Uint8Array =>
  createTestRecording(2000 + Math.floor(Math.random() * 6000)).bytes;

const objectNameOf = (bytes: Uint8Array): string =>
  `${createHash('sha256').update(bytes).digest('hex')}.wav`;

const objectExists = async (name: string): Promise<boolean> => {
  const { data, error } = await serviceDb.storage
    .from(AUDIO_BUCKET)
    .list('audio', { search: name });
  if (error) throw error;
  return data.some((object) => object.name === name);
};

interface OwnerPackageFields {
  slug: string;
  title: string;
  content?: ExamContent;
  keys?: AnswerKeys;
  audio?: Uint8Array;
}

// A private owner package (manifest v1 and its recording) of the synthetic
// full DTZ in a temporary directory outside the repository.
const writeOwnerPackage = async (
  fields: OwnerPackageFields,
): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owner-publish-'));
  ownerDirs.push(dir);
  const content = fields.content ?? FULL.content;
  const audio = fields.audio ?? createTestRecording().bytes;
  await writeFile(path.join(dir, 'track.wav'), audio);
  const manifest = {
    schemaVersion: 1,
    slug: fields.slug,
    title: fields.title,
    format: 'DTZ',
    source: content.source,
    content,
    keys: fields.keys ?? FULL.keys,
    audio: [{ trackId: SYNTHETIC_TRACK_ID, file: 'track.wav' }],
  };
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest));
  return file;
};

interface CliRun {
  code: number;
  out: string;
  err: string;
}

// The owner CLI in process, with its own privileged client of the test
// database instead of the environment.
const ownerPublish = async (
  manifest: string,
  flags: string[],
): Promise<CliRun> => {
  let out = '';
  let err = '';
  const code = await runOwnerCli(['publish', manifest, ...flags], {
    cwd: path.dirname(manifest),
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    connect: createServiceTestClient,
  });
  return { code, out, err };
};

const publishedLine = (slug: string, versionId: string, isNew: boolean) =>
  `${isNew ? 'Published' : 'Already published'} slug=${slug} ` +
  `versionId=${versionId} isNew=${isNew}\n`;

// The output never carries the manifest, its texts, keys, paths or secrets.
const expectSafeOutput = (run: CliRun, manifest: string, title: string) => {
  const all = run.out + run.err;
  const [question] = FULL.content.questions;
  for (const forbidden of [
    path.dirname(manifest),
    title,
    question?.prompt ?? 'no question',
    'correct',
    'sb_secret',
    'eyJ',
    'token=',
  ]) {
    expect(all, forbidden).not.toContain(forbidden);
  }
};

const firstVersionOf = async (slug: string): Promise<string> => {
  const state = await readExamState(slug);
  const versionId = state?.versionIds[0];
  if (!versionId) throw new Error(`${slug} is not published`);
  return versionId;
};

const shortInput = (exam: TestExam): PublishInput => ({
  ...exam,
  content: PILOT_CONTENT,
  keys: TEST_PILOT_KEYS,
  audio: [{ trackId: PILOT_TRACK_ID, ...createTestRecording() }],
});

// The tracks of a stored version as the database function receives them.
const trackArgsOf = async (versionId: string) => {
  const { data, error } = await serviceDb
    .from('exam_version_audio')
    .select('track_id, kind, object_path, content_type, sha256')
    .eq('exam_version_id', versionId)
    .order('track_id')
    .returns<
      {
        track_id: string;
        kind: string;
        object_path: string;
        content_type: string;
        sha256: string;
      }[]
    >();
  if (error) throw error;
  return data.map((row) => ({
    trackId: row.track_id,
    kind: row.kind,
    objectPath: row.object_path,
    contentType: row.content_type,
    sha256: row.sha256,
  }));
};

// The code of a refused publication, or 'published'.
const rejectionOf = async (run: Promise<PublishOutcome>): Promise<string> => {
  try {
    await run;
    return 'published';
  } catch (error) {
    if (error instanceof PublicationRejectedError) return error.code;
    throw error;
  }
};

const waitUntil = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const sessionsNamed = (name: string): number =>
  Number(
    psql(`select count(*) from pg_stat_activity
      where application_name = ${quote(name)}`),
  );

const exitOf = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

// A separate psql session runs one statement on the exam identity (a row
// lock, an uncommitted insert of the slug) and keeps its transaction open.
// Release terminates the session: the transaction is rolled back.
const holdExamIdentity = async (statement: string): Promise<AttemptLock> => {
  assertLocalTarget(localTarget());
  const name = `exam-holder-${randomUUID()}`;
  const child = spawn(
    'docker',
    [
      'exec',
      '-e',
      `PGAPPNAME=${name}`,
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-tA',
      '-c',
      `${statement}; select pg_sleep(60)`,
    ],
    { stdio: 'ignore' },
  );
  await waitUntil(
    () =>
      Number(
        psql(`select count(*) from pg_stat_activity
          where application_name = ${quote(name)}
            and wait_event = 'PgSleep'`),
      ) === 1,
    'exam identity held',
  );
  return {
    name,
    release: async () => {
      psql(`select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${quote(name)}`);
      await exitOf(child);
      await waitUntil(() => sessionsNamed(name) === 0, 'exam identity freed');
    },
  };
};

test('generic owner publisher creates independent full DTZ version', async ({
  page,
}) => {
  const slug = uniqueFullSlug();
  const title = `Owner exam ${slug}`;
  const recording = createTestRecording().bytes;
  const manifest = await writeOwnerPackage({ slug, title, audio: recording });

  const run = await ownerPublish(manifest, ['--new-exam']);
  expect(run.code, run.err).toBe(0);
  const versionId = await firstVersionOf(slug);
  expect(run.out).toBe(publishedLine(slug, versionId, true));
  expect(run.err).toBe('');
  expectSafeOutput(run, manifest, title);

  expect(await readExamState(slug)).toEqual({
    title,
    format: 'DTZ',
    versionIds: [versionId],
  });
  expect(await countVersionKeys(versionId)).toBe(45);
  const stored = await storedVersion(versionId);
  expect(stored.version.version).toBe(1);
  expect(
    Object.fromEntries(
      stored.keys.map((row) => [row.question_id, row.correct_option_id]),
    ),
  ).toEqual(FULL.keys);
  expect(stored.audio).toEqual([
    {
      track_id: SYNTHETIC_TRACK_ID,
      object_path: `audio/${objectNameOf(recording)}`,
      sha256: objectNameOf(recording).replace('.wav', ''),
    },
  ]);
  expect(await objectExists(objectNameOf(recording))).toBe(true);
  const projection = await getPublishedVersion(depsNow(), slug);
  expect(projection?.versionId).toBe(versionId);
  expect(projection?.content).toEqual(FULL.content);

  // The new exam is a card of the library without any other change.
  await page.goto('/');
  await page.getByTestId('guest-continue').click();
  await page.waitForURL(LIBRARY_URL);
  await expect(page.getByTestId(`exam-card-${slug}`)).toHaveCount(1);
});

test('owner publish is idempotent and preserves old version', async () => {
  const slug = uniqueFullSlug();
  const title = `Owner exam ${slug}`;
  const manifest = await writeOwnerPackage({ slug, title });
  const first = await ownerPublish(manifest, ['--new-exam']);
  expect(first.code, first.err).toBe(0);
  const v1 = await firstVersionOf(slug);

  const guest = await newGuest(depsNow());
  const opened = await openReady(guest, slug);
  expect(opened.versionId).toBe(v1);
  const key = FULL.keys['hoeren-1'] ?? 'a';
  const saved = await saveAnswer(depsNow(), guest.token, {
    attemptId: opened.attemptId,
    questionId: 'hoeren-1',
    optionId: key,
    revision: 1,
  });
  expect(saved.ok).toBe(true);
  const storedBefore = await storedVersion(v1);

  const again = await ownerPublish(manifest, ['--new-version']);
  expect(again).toEqual({
    code: 0,
    out: publishedLine(slug, v1, false),
    err: '',
  });
  expect((await readExamState(slug))?.versionIds).toEqual([v1]);

  const fixed = await writeOwnerPackage({
    slug,
    title,
    content: corrected(FULL.content),
  });
  const second = await ownerPublish(fixed, ['--new-version']);
  expect(second.code, second.err).toBe(0);
  const state = await readExamState(slug);
  const v2 = state?.versionIds[1] ?? 'missing';
  expect(state).toEqual({ title, format: 'DTZ', versionIds: [v1, v2] });
  expect(second.out).toBe(publishedLine(slug, v2, true));
  expectSafeOutput(second, fixed, title);
  expect(await countVersionKeys(v2)).toBe(45);
  expect((await storedVersion(v2)).version.version).toBe(2);
  expect((await getPublishedVersion(depsNow(), slug))?.versionId).toBe(v2);

  // The attempt started on version 1 still opens version 1.
  const reopened = await readOpened(
    depsNow(),
    guest.guest,
    slug,
    opened.attemptId,
  );
  if (reopened.status !== 'ready') throw new Error('attempt is not ready');
  expect(reopened.practice.versionId).toBe(v1);
  const promptOf = (questions: readonly { id: string; prompt?: string }[]) =>
    questions.find((question) => question.id === 'hoeren-2')?.prompt;
  expect(promptOf(reopened.practice.questions)).toBe(
    promptOf(FULL.content.questions),
  );
  expect(reopened.practice.selections).toEqual({ 'hoeren-1': key });
  expect(await storedVersion(v1)).toEqual(storedBefore);
});

test('publication intent is checked before upload', async () => {
  const existing = uniqueFullSlug();
  const title = `Owner exam ${existing}`;
  const published = await ownerPublish(
    await writeOwnerPackage({ slug: existing, title }),
    ['--new-exam'],
  );
  expect(published.code, published.err).toBe(0);
  const existingBefore = await readExamState(existing);
  const missing = uniqueFullSlug();

  const cases: { slug: string; title: string; flags: string[]; why: string }[] =
    [
      { slug: existing, title, flags: ['--new-exam'], why: 'exam_exists' },
      {
        slug: missing,
        title: 'Missing exam',
        flags: ['--new-version'],
        why: 'exam_not_found',
      },
      {
        slug: missing,
        title: 'Missing exam',
        flags: [],
        why: 'exactly one of --new-exam or --new-version',
      },
      {
        slug: existing,
        title: 'Another title',
        flags: ['--new-version'],
        why: 'exam_title_mismatch',
      },
    ];
  for (const item of cases) {
    const audio = uniqueRecording();
    const manifest = await writeOwnerPackage({
      slug: item.slug,
      title: item.title,
      content: corrected(FULL.content),
      audio,
    });
    const run = await ownerPublish(manifest, item.flags);
    expect(run.code, item.why).toBe(1);
    expect(run.out, item.why).toBe('');
    expect(run.err, item.why).toContain(item.why);
    expectSafeOutput(run, manifest, item.title);
    expect(await objectExists(objectNameOf(audio)), item.why).toBe(false);
    expect(await readExamState(existing), item.why).toEqual(existingBefore);
    expect(await readExamState(missing), item.why).toBeNull();
  }
});

test('sql guard rejects format drift and implicit rename', async () => {
  const exam = uniqueExam();
  const first = await publishShort(exam);
  const tracks = await trackArgsOf(first.versionId);
  const before = await readExamState(exam.slug);
  if (!before) throw new Error('exam is not published');
  const rpc = (overrides: Record<string, unknown>) =>
    serviceDb.rpc('publish_exam_version', {
      p_slug: exam.slug,
      p_title: exam.title,
      p_format: exam.format,
      p_content: PILOT_CONTENT,
      p_keys: TEST_PILOT_KEYS,
      p_audio: tracks,
      ...overrides,
    });

  const refused: [Record<string, unknown>, string][] = [
    [{ p_format: 'TELC' }, 'exam_format_mismatch'],
    [
      { p_format: 'TELC', p_intent: 'new-version', p_rename: true },
      'exam_format_mismatch',
    ],
    [{ p_title: 'Renamed silently' }, 'exam_title_mismatch'],
    [
      { p_title: 'Renamed silently', p_intent: 'new-version' },
      'exam_title_mismatch',
    ],
    [
      { p_title: 'Renamed silently', p_content: corrected(PILOT_CONTENT) },
      'exam_title_mismatch',
    ],
    [{ p_intent: 'replace' }, 'publish_intent_invalid'],
  ];
  for (const [overrides, hint] of refused) {
    const { data, error } = await rpc(overrides);
    expect(data, hint).toBeNull();
    expect(error?.hint, JSON.stringify(Object.keys(overrides))).toBe(hint);
    expect(await readExamState(exam.slug)).toEqual(before);
  }

  const renamed = await rpc({ p_title: 'Renamed explicitly', p_rename: true });
  expect(renamed.error).toBeNull();
  expect(renamed.data).toEqual([
    { version_id: first.versionId, is_new: false },
  ]);
  expect(await readExamState(exam.slug)).toEqual({
    ...before,
    title: 'Renamed explicitly',
  });
});

test('concurrent identical publish creates one version', async () => {
  const exam = uniqueExam();
  const first = await publishShort(exam);
  const input: PublishInput = {
    ...shortInput(exam),
    content: corrected(PILOT_CONTENT),
    intent: 'new-version',
  };
  // Both runs pass the read-only preflight and the early check, then wait
  // for the row of the exam in the database function, each over its own
  // client and connection.
  const holder = await holdExamIdentity(
    `select 1 from public.exams where slug = ${quote(exam.slug)}
      for no key update`,
  );
  const runs = Promise.allSettled([
    publishExamVersion(createServiceTestClient(), input),
    publishExamVersion(createServiceTestClient(), input),
  ]);
  try {
    await waitUntil(
      () => waitersBehind(holder, 'publish_exam_version') === 2,
      'both publications wait for the exam',
    );
  } finally {
    await holder.release();
  }
  const results = await runs;
  const outcomes = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  expect(outcomes.filter((outcome) => outcome.isNew)).toHaveLength(1);
  const [a, b] = outcomes;
  expect(a?.versionId).toBe(b?.versionId);
  expect(a?.versionId).not.toBe(first.versionId);
  expect(await readExamState(exam.slug)).toEqual({
    title: exam.title,
    format: exam.format,
    versionIds: [first.versionId, a?.versionId],
  });
  expect(await countVersionKeys(a?.versionId ?? '')).toBe(4);
});

test('concurrent new exam publish keeps exam identity', async () => {
  const slug = uniqueFullSlug();
  const titles = [`First ${slug}`, `Second ${slug}`];
  // An uncommitted insert of the same slug: both runs see no exam in their
  // preflight and wait on the slug inside the database function.
  const holder = await holdExamIdentity(
    `insert into public.exams (slug, title, format)
      values (${quote(slug)}, 'Holder', 'DTZ')`,
  );
  const runs = Promise.allSettled(
    titles.map((title) =>
      publishExamVersion(createServiceTestClient(), {
        slug,
        title,
        format: 'DTZ',
        content: FULL.content,
        keys: FULL.keys,
        audio: [{ trackId: SYNTHETIC_TRACK_ID, ...createTestRecording() }],
        intent: 'new-exam',
      }),
    ),
  );
  try {
    await waitUntil(
      () => waitersBehind(holder, 'publish_exam_version') === 2,
      'both publications wait for the slug',
    );
  } finally {
    await holder.release();
  }
  const results = await runs;
  const published = results.flatMap((result, index) =>
    result.status === 'fulfilled' ? [{ ...result.value, index }] : [],
  );
  const refused = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  expect(published).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toBeInstanceOf(PublicationRejectedError);
  expect((refused[0] as PublicationRejectedError).code).toBe('exam_exists');
  const [winner] = published;
  if (!winner) throw new Error('no publication');
  expect(winner.isNew).toBe(true);
  expect(await readExamState(slug)).toEqual({
    title: titles[winner.index],
    format: 'DTZ',
    versionIds: [winner.versionId],
  });
  expect(await countVersionKeys(winner.versionId)).toBe(45);
});

test('rename with identical material updates title without new version', async () => {
  const slug = uniqueFullSlug();
  const title = `Owner exam ${slug}`;
  const first = await ownerPublish(await writeOwnerPackage({ slug, title }), [
    '--new-exam',
  ]);
  expect(first.code, first.err).toBe(0);
  const v1 = await firstVersionOf(slug);

  const renamedTitle = `Renamed exam ${slug}`;
  const renamed = await writeOwnerPackage({ slug, title: renamedTitle });
  const implicit = await ownerPublish(renamed, ['--new-version']);
  expect(implicit.code).toBe(1);
  expect(implicit.err).toContain('exam_title_mismatch');
  expect(await readExamState(slug)).toEqual({
    title,
    format: 'DTZ',
    versionIds: [v1],
  });

  const run = await ownerPublish(renamed, ['--new-version', '--rename']);
  expect(run.code, run.err).toBe(0);
  expect(run.out).toBe(publishedLine(slug, v1, false));
  expect(run.err).toContain('Warning: --rename');
  expectSafeOutput(run, renamed, renamedTitle);
  expect(await readExamState(slug)).toEqual({
    title: renamedTitle,
    format: 'DTZ',
    versionIds: [v1],
  });
  expect(await countVersionKeys(v1)).toBe(45);

  const again = await ownerPublish(renamed, ['--new-version', '--rename']);
  expect(again).toEqual({
    code: 0,
    out: publishedLine(slug, v1, false),
    err: '',
  });
});

test('identical material with other title or format is not silently accepted', async () => {
  const exam = uniqueExam();
  const first = await publishShort(exam);
  const before = await readExamState(exam.slug);
  const refused: [Partial<PublishInput>, string][] = [
    [{ title: 'Other title' }, 'exam_title_mismatch'],
    [{ title: 'Other title', intent: 'new-version' }, 'exam_title_mismatch'],
    [{ format: 'TELC' }, 'exam_format_mismatch'],
    [{ format: 'TELC', rename: true }, 'exam_format_mismatch'],
  ];
  for (const [changed, code] of refused) {
    const run = publishExamVersion(serviceDb, {
      ...shortInput(exam),
      ...changed,
    });
    expect(await rejectionOf(run), code).toBe(code);
    expect(await readExamState(exam.slug)).toEqual(before);
  }
  expect(await publishShort(exam)).toEqual({
    versionId: first.versionId,
    isNew: false,
  });
  expect(await readExamState(exam.slug)).toEqual(before);
});

test('identical material cannot bypass publication intent', async () => {
  const exam = uniqueExam();
  const first = await publishShort(exam);
  const before = await readExamState(exam.slug);
  const tracks = await trackArgsOf(first.versionId);
  const direct = (intent: string | null) =>
    serviceDb.rpc('publish_exam_version', {
      p_slug: exam.slug,
      p_title: exam.title,
      p_format: exam.format,
      p_content: PILOT_CONTENT,
      p_keys: TEST_PILOT_KEYS,
      p_audio: tracks,
      p_intent: intent,
    });

  // The publisher, past the CLI preflight.
  const viaPublisher = publishExamVersion(serviceDb, {
    ...shortInput(exam),
    intent: 'new-exam',
  });
  expect(await rejectionOf(viaPublisher)).toBe('exam_exists');
  expect(await readExamState(exam.slug)).toEqual(before);

  // The database function itself, past the publisher.
  const refused = await direct('new-exam');
  expect(refused.data).toBeNull();
  expect(refused.error?.hint).toBe('exam_exists');
  expect(await readExamState(exam.slug)).toEqual(before);

  const same = { versionId: first.versionId, isNew: false };
  expect(
    await publishExamVersion(serviceDb, {
      ...shortInput(exam),
      intent: 'new-version',
    }),
  ).toEqual(same);
  for (const intent of ['new-version', null]) {
    const reused = await direct(intent);
    expect(reused.error).toBeNull();
    expect(reused.data).toEqual([
      { version_id: first.versionId, is_new: false },
    ]);
  }
  expect(await readExamState(exam.slug)).toEqual(before);
});
