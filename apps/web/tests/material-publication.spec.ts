import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { SYNTHETIC_TRACK_ID, buildSyntheticPilot } from '@b1k/domain';
import type { ExamContent } from '@b1k/domain';
import {
  PILOT_CONTENT,
  PILOT_EXAM,
  PILOT_TRACK_ID,
} from '../../../scripts/seed-pilot-question';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { PublishOutcome } from '../../../scripts/lib/publish-exam-version';
import { FULL_PILOT_TRACK_ID } from '../../../scripts/lib/pilot';
import { publishFullPilot } from '../../../scripts/publish-pilot';
import {
  finishAttempt,
  openPractice,
  saveAnswer,
} from '../src/server/attempts/attempts';
import { getPublishedVersion } from '../src/server/material/published';
import {
  createPublicClient,
  depsNow,
  newGuest,
  readAnswers,
  readAttempts,
  readResults,
  serviceDb,
} from './support/db';
import { TEST_PILOT_KEYS, createTestRecording } from './support/global-setup';

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
  const opened = await openPractice(depsNow(), guest.guest, slug);
  if (opened.status !== 'ready') throw new Error(`practice: ${opened.status}`);
  return opened.practice;
};

const insertAttempt = async (
  sessionId: string,
  versionId: string,
  fields: { id: string; createdAt: string },
  answers: Record<string, string>,
) => {
  const inserted = await serviceDb.from('attempts').insert({
    id: fields.id,
    guest_session_id: sessionId,
    exam_version_id: versionId,
    status: 'active',
    created_at: fields.createdAt,
    updated_at: fields.createdAt,
  });
  if (inserted.error) throw inserted.error;
  const rows = Object.entries(answers).map(([questionId, optionId]) => ({
    attempt_id: fields.id,
    question_id: questionId,
    option_id: optionId,
  }));
  const saved = await serviceDb.from('attempt_answers').insert(rows);
  if (saved.error) throw saved.error;
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
  });
  const finished = await finishAttempt(depsNow(), guest.token, {
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
  // neither "highest id" nor "latest version" would pick it.
  await insertAttempt(
    sessionId,
    oldVersion.versionId,
    { id: laterId, createdAt: '2026-10-01T10:00:00.000Z' },
    { 'hoeren-1': 'a' },
  );
  await insertAttempt(
    sessionId,
    newVersion.versionId,
    { id: earlierId, createdAt: '2026-09-01T10:00:00.000Z' },
    { 'hoeren-3': 'c' },
  );

  const practice = await openReady(guest, exam.slug);
  expect(practice.attemptId).toBe(laterId);
  expect(practice.versionId).toBe(oldVersion.versionId);
  expect(practice.selections).toEqual({ 'hoeren-1': 'a' });
  expect(await readAttempts(sessionId)).toHaveLength(2);
  expect(await readAnswers(earlierId)).toEqual({ 'hoeren-3': 'c' });
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
  await insertAttempt(
    sessionId,
    newVersion.versionId,
    { id: lowerId, createdAt },
    { 'hoeren-2': 'a' },
  );
  await insertAttempt(
    sessionId,
    oldVersion.versionId,
    { id: higherId, createdAt },
    { 'hoeren-4': 'b' },
  );

  const practice = await openReady(guest, exam.slug);
  expect(practice.attemptId).toBe(higherId);
  expect(practice.versionId).toBe(oldVersion.versionId);
  expect(practice.selections).toEqual({ 'hoeren-4': 'b' });
  expect(await readAttempts(sessionId)).toHaveLength(2);
  expect(await readAnswers(lowerId)).toEqual({ 'hoeren-2': 'a' });
  expect(await readAnswers(higherId)).toEqual({ 'hoeren-4': 'b' });
});

test('pilot exam slug is the default of openPractice', async () => {
  const guest = await newGuest(depsNow());
  const opened = await openPractice(depsNow(), guest.guest);
  if (opened.status !== 'ready') throw new Error('practice is missing');
  const version = await getPublishedVersion(depsNow(), PILOT_EXAM.slug);
  expect(opened.practice.versionId).toBe(version?.versionId);
});
