import { createHash, getRandomValues, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SYNTHETIC_TRACK_ID, buildSyntheticPilot } from '@b1k/domain';
import type { ExamContent } from '@b1k/domain';
import {
  PILOT_CONTENT,
  PILOT_TRACK_ID,
} from '../../../scripts/seed-pilot-question';
import {
  AUDIO_OBJECT_MISMATCH,
  AudioObjectMismatchError,
  publishExamVersion,
} from '../../../scripts/lib/publish-exam-version';
import type { PublishInput } from '../../../scripts/lib/publish-exam-version';
import { runOwnerCli } from '../../../scripts/manage-exam-library';
import {
  audioObjectExists,
  countAudioObjects,
  countAudioReferences,
  createServiceTestClient,
  plantAudioObject,
  readAudioObject,
  readExamState,
  readStoredVersion,
  serviceDb,
} from './support/db';
import { readTestSupabaseEnv } from './support/env';
import { TEST_PILOT_KEYS, createTestRecording } from './support/global-setup';

// Recovery of the owner publication (#82). Failures are injected only by a
// wrapper around `storage.from(...).upload` and `rpc` of a test client; every
// publication, every read-back and every audit runs against the real test
// database and Storage.

const env = readTestSupabaseEnv();

// Marks that must never reach a report: a key, a signed URL and a secret as
// they could appear inside an error message of a service.
const LEAK =
  'sb_secret_LEAKCHECK https://storage.test/object/sign/exam-sources/a.wav' +
  '?token=eyJLEAKCHECK';

interface Recording {
  contentType: 'audio/wav';
  bytes: Uint8Array;
}

// A recording no other test uploads: the last bytes are random, so its object
// is new and its SHA-256 is its own.
const uniqueRecording = (): Recording => {
  const { bytes } = createTestRecording();
  const copy = bytes.slice();
  getRandomValues(copy.subarray(copy.length - 16));
  return { contentType: 'audio/wav', bytes: copy };
};

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const objectPathOf = (recording: Recording): string =>
  `audio/${sha256Of(recording.bytes)}.wav`;

const uniqueExam = () => ({
  slug: `test-recovery-${randomUUID().slice(0, 8)}`,
  title: 'Recovery test',
  format: 'DTZ',
});

type TestExam = ReturnType<typeof uniqueExam>;

const corrected = (content: ExamContent): ExamContent => ({
  ...content,
  questions: content.questions.map((question) =>
    question.id === 'hoeren-2'
      ? { ...question, prompt: `${question.prompt} (korrigiert)` }
      : question,
  ),
});

const inputFor = (
  exam: TestExam,
  recording: Recording,
  content: ExamContent = PILOT_CONTENT,
): PublishInput => ({
  ...exam,
  content,
  keys: TEST_PILOT_KEYS,
  audio: [{ trackId: PILOT_TRACK_ID, ...recording }],
});

const snapshotOfExam = async (slug: string) => {
  const state = await readExamState(slug);
  const versions = await Promise.all(
    (state?.versionIds ?? []).map((id) => readStoredVersion(id)),
  );
  return { state, versions };
};

// Fail-points -----------------------------------------------------------------

type Bucket = ReturnType<SupabaseClient['storage']['from']>;
type UploadResult = Awaited<ReturnType<Bucket['upload']>>;

interface RpcResult {
  data: unknown;
  error: unknown;
}

interface FailPoints {
  // Runs instead of the upload; `real` performs the real upload.
  upload?: (
    objectPath: string,
    real: () => Promise<UploadResult>,
  ) => Promise<UploadResult>;
  // Runs instead of the database function; `real` performs the real call.
  rpc?: (real: () => PromiseLike<RpcResult>) => PromiseLike<RpcResult>;
}

interface Calls {
  uploads: string[];
  rpcs: number;
}

// Offers exactly the methods the publisher uses; everything behind them is
// the real client.
const withFailPoints = (
  db: SupabaseClient,
  points: FailPoints,
): SupabaseClient => {
  const bucketOf = (name: string) => {
    const real = db.storage.from(name);
    return {
      list: real.list.bind(real),
      download: real.download.bind(real),
      upload: (
        objectPath: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean },
      ) => {
        const performUpload = () => real.upload(objectPath, body, options);
        return points.upload
          ? points.upload(objectPath, performUpload)
          : performUpload();
      },
    };
  };
  const facade = {
    from: (table: string) => db.from(table),
    storage: { from: bucketOf },
    rpc: (fn: string, args: Record<string, unknown>) => {
      const performCall = () =>
        db.rpc(fn, args) as unknown as PromiseLike<RpcResult>;
      return points.rpc ? points.rpc(performCall) : performCall();
    },
  };
  return facade as unknown as SupabaseClient;
};

// A test client with fail-points that also counts what reaches Storage and
// the database function.
const tracked = (points: FailPoints = {}) => {
  const calls: Calls = { uploads: [], rpcs: 0 };
  const db = withFailPoints(createServiceTestClient(), {
    upload: (objectPath, real) => {
      calls.uploads.push(objectPath);
      return points.upload ? points.upload(objectPath, real) : real();
    },
    rpc: (real) => {
      calls.rpcs += 1;
      return points.rpc ? points.rpc(real) : real();
    },
  });
  return { db, calls };
};

const storageFailure = async (): Promise<UploadResult> =>
  ({
    data: null,
    error: Object.assign(new Error(`injected storage failure ${LEAK}`), {
      status: 500,
      statusCode: '500',
    }),
  }) as unknown as UploadResult;

const databaseFailure = async (): Promise<RpcResult> => ({
  data: null,
  error: {
    code: 'XX000',
    message: `injected database failure ${LEAK}`,
    details: null,
    hint: null,
  },
});

// A client that can only read: the audit receives nothing that could write,
// move or delete.
const readOnlyView = (db: SupabaseClient): SupabaseClient => {
  const view = {
    from: (table: string) => ({
      select: (columns: string) => db.from(table).select(columns),
    }),
    storage: {
      from: (name: string) => {
        const real = db.storage.from(name);
        return { list: real.list.bind(real) };
      },
    },
  };
  return view as unknown as SupabaseClient;
};

const connectReadOnly = (): SupabaseClient =>
  readOnlyView(createServiceTestClient());

// CLI -------------------------------------------------------------------------

interface CliRun {
  code: number;
  out: string;
  err: string;
}

const runCli = async (
  argv: string[],
  connect: () => SupabaseClient,
  cwd: string = os.tmpdir(),
): Promise<CliRun> => {
  let out = '';
  let err = '';
  const code = await runOwnerCli(argv, {
    cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    connect,
  });
  return { code, out, err };
};

const FULL = buildSyntheticPilot();
const ownerDirs: string[] = [];

test.afterAll(async () => {
  await Promise.all(
    ownerDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// A private owner package (manifest v1 and its recording) of the synthetic
// full DTZ in a temporary directory outside the repository.
const writeOwnerPackage = async (
  exam: TestExam,
  recording: Recording,
): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owner-recovery-'));
  ownerDirs.push(dir);
  await writeFile(path.join(dir, 'track.wav'), recording.bytes);
  const manifest = {
    schemaVersion: 1,
    ...exam,
    source: FULL.content.source,
    content: FULL.content,
    keys: FULL.keys,
    audio: [{ trackId: SYNTHETIC_TRACK_ID, file: 'track.wav' }],
  };
  const file = path.join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify(manifest));
  return file;
};

// A report never carries a key, a signed URL, the secret key, the manifest or
// a path of the owner.
const expectSafeOutput = (run: CliRun, manifest: string, exam: TestExam) => {
  const all = run.out + run.err;
  const [question] = FULL.content.questions;
  for (const forbidden of [
    LEAK,
    'sb_secret',
    'LEAKCHECK',
    'token=',
    'eyJ',
    'injected',
    env.secretKey,
    env.publishableKey,
    path.dirname(manifest),
    exam.title,
    question?.prompt ?? 'no question',
  ]) {
    expect(all, forbidden).not.toContain(forbidden);
  }
};

// Publication -----------------------------------------------------------------

test('storage failure leaves no visible partial version', async () => {
  const exam = uniqueExam();
  await publishExamVersion(serviceDb, inputFor(exam, uniqueRecording()));
  const before = await snapshotOfExam(exam.slug);
  expect(before.versions).toHaveLength(1);

  // A corrected version whose upload fails.
  const second = uniqueRecording();
  const failing = tracked({ upload: storageFailure });
  const next = inputFor(exam, second, corrected(PILOT_CONTENT));
  await expect(publishExamVersion(failing.db, next)).rejects.toThrow(
    'Audio upload failed',
  );
  expect(failing.calls.uploads).toEqual([objectPathOf(second)]);
  expect(failing.calls.rpcs).toBe(0);
  expect(await snapshotOfExam(exam.slug)).toEqual(before);
  expect(await audioObjectExists(objectPathOf(second))).toBe(false);
  expect(await countAudioReferences(objectPathOf(second))).toBe(0);

  // A first publication of a new exam whose upload fails.
  const fresh = uniqueExam();
  const freshRecording = uniqueRecording();
  await expect(
    publishExamVersion(failing.db, inputFor(fresh, freshRecording)),
  ).rejects.toThrow('Audio upload failed');
  expect(await readExamState(fresh.slug)).toBeNull();
  expect(await audioObjectExists(objectPathOf(freshRecording))).toBe(false);

  // The same publication succeeds once Storage works again.
  const retried = await publishExamVersion(serviceDb, next);
  expect(retried.isNew).toBe(true);
  expect((await snapshotOfExam(exam.slug)).versions).toHaveLength(2);
});

test('database failure after upload is safely retryable', async () => {
  const exam = uniqueExam();
  await publishExamVersion(serviceDb, inputFor(exam, uniqueRecording()));
  const before = await snapshotOfExam(exam.slug);
  const [firstVersion] = before.versions;

  const second = uniqueRecording();
  const next = inputFor(exam, second, corrected(PILOT_CONTENT));
  const failing = tracked({ rpc: databaseFailure });
  await expect(publishExamVersion(failing.db, next)).rejects.toThrow(
    'Publication failed',
  );
  // The object is uploaded, the version is not visible.
  expect(failing.calls.uploads).toEqual([objectPathOf(second)]);
  expect(failing.calls.rpcs).toBe(1);
  expect(await snapshotOfExam(exam.slug)).toEqual(before);
  expect(await countAudioObjects(objectPathOf(second))).toBe(1);
  expect(await countAudioReferences(objectPathOf(second))).toBe(0);

  // The retry finds the object, verifies its bytes and uploads nothing.
  const retry = tracked();
  const outcome = await publishExamVersion(retry.db, next);
  expect(outcome.isNew).toBe(true);
  expect(retry.calls.uploads).toEqual([]);
  expect(retry.calls.rpcs).toBe(1);
  const after = await snapshotOfExam(exam.slug);
  expect(after.state?.versionIds).toHaveLength(2);
  expect(after.versions[0]).toEqual(firstVersion);
  const stored = await readStoredVersion(outcome.versionId);
  expect(stored.audio).toEqual([
    {
      track_id: PILOT_TRACK_ID,
      object_path: objectPathOf(second),
      sha256: sha256Of(second.bytes),
    },
  ]);
  expect(stored.keys).toHaveLength(Object.keys(TEST_PILOT_KEYS).length);

  // An identical third run creates nothing.
  const again = await publishExamVersion(serviceDb, next);
  expect(again).toEqual({ versionId: outcome.versionId, isNew: false });
  expect((await snapshotOfExam(exam.slug)).state?.versionIds).toHaveLength(2);
});

test('interrupted publication leaves the exam retryable', async () => {
  const exam = uniqueExam();
  const recording = uniqueRecording();
  // The object is stored, but the process never sees the answer.
  const interrupted = tracked({
    upload: async (_objectPath, real) => {
      await real();
      return storageFailure();
    },
  });
  await expect(
    publishExamVersion(interrupted.db, inputFor(exam, recording)),
  ).rejects.toThrow('Audio upload failed');
  expect(interrupted.calls.rpcs).toBe(0);
  expect(await readExamState(exam.slug)).toBeNull();
  expect(await countAudioObjects(objectPathOf(recording))).toBe(1);

  const retry = tracked();
  const outcome = await publishExamVersion(retry.db, inputFor(exam, recording));
  expect(outcome.isNew).toBe(true);
  expect(retry.calls.uploads).toEqual([]);
  expect((await readExamState(exam.slug))?.versionIds).toEqual([
    outcome.versionId,
  ]);
});

test('lost answer after commit creates no second version', async () => {
  const exam = uniqueExam();
  const recording = uniqueRecording();
  // The database function commits, but its answer is lost.
  const lost = tracked({
    rpc: async (real) => {
      await real();
      return databaseFailure();
    },
  });
  await expect(
    publishExamVersion(lost.db, inputFor(exam, recording)),
  ).rejects.toThrow('Publication failed');
  const committed = await readExamState(exam.slug);
  expect(committed?.versionIds).toHaveLength(1);

  const retry = tracked();
  const outcome = await publishExamVersion(retry.db, inputFor(exam, recording));
  expect(outcome).toEqual({
    versionId: committed?.versionIds[0],
    isNew: false,
  });
  expect(retry.calls.uploads).toEqual([]);
  expect(retry.calls.rpcs).toBe(0);
  expect((await readExamState(exam.slug))?.versionIds).toHaveLength(1);
});

// Existing objects --------------------------------------------------------------

test('existing object with other bytes stops publication', async () => {
  const exam = uniqueExam();
  const recording = uniqueRecording();
  const objectPath = objectPathOf(recording);
  // Other bytes under the path that the recording would get.
  const other = uniqueRecording().bytes;
  await plantAudioObject(objectPath, other, recording.contentType);

  const guarded = tracked();
  const error = await publishExamVersion(
    guarded.db,
    inputFor(exam, recording),
  ).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AudioObjectMismatchError);
  expect((error as AudioObjectMismatchError).code).toBe(AUDIO_OBJECT_MISMATCH);
  // The database function was never reached and nothing was uploaded over it.
  expect(guarded.calls.rpcs).toBe(0);
  expect(guarded.calls.uploads).toEqual([]);
  expect(await readExamState(exam.slug)).toBeNull();
  expect(await countAudioReferences(objectPath)).toBe(0);
  // The foreign bytes are still there: not overwritten, not deleted.
  expect(sha256Of(await readAudioObject(objectPath))).toBe(sha256Of(other));
});

test('other bytes appearing during upload stop publication', async () => {
  const exam = uniqueExam();
  const recording = uniqueRecording();
  const objectPath = objectPathOf(recording);
  const other = uniqueRecording().bytes;
  // A competing upload wins the name between the lookup and the upload; the
  // real Storage then answers that the object exists.
  const racing = tracked({
    upload: async (name, real) => {
      await plantAudioObject(name, other, recording.contentType);
      return real();
    },
  });
  await expect(
    publishExamVersion(racing.db, inputFor(exam, recording)),
  ).rejects.toBeInstanceOf(AudioObjectMismatchError);
  expect(racing.calls.uploads).toEqual([objectPath]);
  expect(racing.calls.rpcs).toBe(0);
  expect(await readExamState(exam.slug)).toBeNull();
  expect(sha256Of(await readAudioObject(objectPath))).toBe(sha256Of(other));
});

test('identical object appearing during upload is accepted', async () => {
  const exam = uniqueExam();
  const recording = uniqueRecording();
  const racing = tracked({
    upload: async (name, real) => {
      await plantAudioObject(name, recording.bytes, recording.contentType);
      return real();
    },
  });
  const outcome = await publishExamVersion(
    racing.db,
    inputFor(exam, recording),
  );
  expect(outcome.isNew).toBe(true);
  expect(racing.calls.rpcs).toBe(1);
  expect(await countAudioObjects(objectPathOf(recording))).toBe(1);
  expect(sha256Of(await readAudioObject(objectPathOf(recording)))).toBe(
    sha256Of(recording.bytes),
  );
});

test('concurrent upload of one content addressed object is verified', async () => {
  const recording = uniqueRecording();
  const objectPath = objectPathOf(recording);
  // An exam that must stay untouched by the two publications.
  const bystander = uniqueExam();
  await publishExamVersion(serviceDb, inputFor(bystander, uniqueRecording()));
  const bystanderBefore = await snapshotOfExam(bystander.slug);

  // Both publications have looked the object up (it is missing) before either
  // uploads: the two uploads of the same name really race.
  let arrived = 0;
  let release: () => void = () => undefined;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answers: string[] = [];
  const racing = () =>
    tracked({
      upload: async (_name, real) => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        const result = await real();
        answers.push(result.error ? 'rejected' : 'stored');
        return result;
      },
    });
  const first = racing();
  const second = racing();
  const firstExam = uniqueExam();
  const secondExam = uniqueExam();
  const [firstOutcome, secondOutcome] = await Promise.all([
    publishExamVersion(first.db, inputFor(firstExam, recording)),
    publishExamVersion(second.db, inputFor(secondExam, recording)),
  ]);

  expect(answers.toSorted()).toEqual(['rejected', 'stored']);
  expect(firstOutcome.isNew).toBe(true);
  expect(secondOutcome.isNew).toBe(true);
  expect(firstOutcome.versionId).not.toBe(secondOutcome.versionId);
  // One object, with the expected bytes.
  expect(await countAudioObjects(objectPath)).toBe(1);
  expect(sha256Of(await readAudioObject(objectPath))).toBe(
    sha256Of(recording.bytes),
  );
  // Every version refers to the right track of the verified object.
  for (const outcome of [firstOutcome, secondOutcome]) {
    const stored = await readStoredVersion(outcome.versionId);
    expect(stored.audio).toEqual([
      {
        track_id: PILOT_TRACK_ID,
        object_path: objectPath,
        sha256: sha256Of(recording.bytes),
      },
    ]);
  }
  expect(await countAudioReferences(objectPath)).toBe(2);
  expect((await readExamState(firstExam.slug))?.versionIds).toEqual([
    firstOutcome.versionId,
  ]);
  expect((await readExamState(secondExam.slug))?.versionIds).toEqual([
    secondOutcome.versionId,
  ]);
  expect(await snapshotOfExam(bystander.slug)).toEqual(bystanderBefore);
});

// Audit -----------------------------------------------------------------------

interface AuditJson {
  objects: number;
  referenced: number;
  unreferenced: string[];
}

test('audio audit reports orphans and deletes nothing', async () => {
  const published = uniqueRecording();
  await publishExamVersion(serviceDb, inputFor(uniqueExam(), published));
  // An object that was uploaded and whose version never became visible.
  const orphan = uniqueRecording();
  const failing = tracked({ rpc: databaseFailure });
  await expect(
    publishExamVersion(failing.db, inputFor(uniqueExam(), orphan)),
  ).rejects.toThrow('Publication failed');
  expect(await countAudioReferences(objectPathOf(orphan))).toBe(0);

  const json = await runCli(['audit-audio', '--json'], connectReadOnly);
  expect(json.code, json.err).toBe(0);
  expect(json.err).toBe('');
  const report = JSON.parse(json.out) as AuditJson;
  expect(report.unreferenced).toContain(objectPathOf(orphan));
  expect(report.unreferenced).not.toContain(objectPathOf(published));
  expect(report.referenced).toBeGreaterThan(0);

  // The text report names the orphan and says that nothing was deleted.
  const text = await runCli(['audit-audio'], connectReadOnly);
  expect(text.code).toBe(0);
  expect(text.out).toContain(`unreferenced ${objectPathOf(orphan)}`);
  expect(text.out).not.toContain(`unreferenced ${objectPathOf(published)}`);
  expect(text.out).toContain('Nothing was deleted');
  for (const forbidden of ['sb_secret', 'token=', 'eyJ', env.secretKey]) {
    expect(text.out + text.err).not.toContain(forbidden);
  }

  // Both objects are still stored, byte for byte.
  expect(sha256Of(await readAudioObject(objectPathOf(orphan)))).toBe(
    sha256Of(orphan.bytes),
  );
  expect(sha256Of(await readAudioObject(objectPathOf(published)))).toBe(
    sha256Of(published.bytes),
  );
  expect(await countAudioReferences(objectPathOf(published))).toBe(1);
});

test('audio audit without orphans reports nothing', async () => {
  const recording = uniqueRecording();
  await publishExamVersion(serviceDb, inputFor(uniqueExam(), recording));

  for (const argv of [['audit-audio'], ['audit-audio', '--json']]) {
    const run = await runCli(argv, connectReadOnly);
    expect(run.code, run.err).toBe(0);
    expect(run.out + run.err).not.toContain(objectPathOf(recording));
    expect(run.out + run.err).not.toContain(sha256Of(recording.bytes));
  }
});

// Reports ---------------------------------------------------------------------

test('publish failures redact secrets and remain retryable', async () => {
  const exam = uniqueExam();
  const recording = uniqueRecording();
  const manifest = await writeOwnerPackage(exam, recording);
  const publish = (connect: () => SupabaseClient) =>
    runCli(
      ['publish', manifest, '--new-exam'],
      connect,
      path.dirname(manifest),
    );

  const storage = await publish(() => tracked({ upload: storageFailure }).db);
  expect(storage.code).toBe(1);
  expect(storage.err).toContain('Publication failed: Audio upload failed');
  expectSafeOutput(storage, manifest, exam);
  expect(await readExamState(exam.slug)).toBeNull();

  const database = await publish(() => tracked({ rpc: databaseFailure }).db);
  expect(database.code).toBe(1);
  expect(database.err).toContain('Publication failed: Publication failed');
  expectSafeOutput(database, manifest, exam);
  expect(await readExamState(exam.slug)).toBeNull();
  expect(await countAudioObjects(objectPathOf(recording))).toBe(1);

  // Foreign bytes under the path of another package stop it with a code.
  const mismatched = uniqueExam();
  const foreign = uniqueRecording();
  const foreignManifest = await writeOwnerPackage(mismatched, foreign);
  await plantAudioObject(
    objectPathOf(foreign),
    uniqueRecording().bytes,
    foreign.contentType,
  );
  const mismatch = await runCli(
    ['publish', foreignManifest, '--new-exam'],
    createServiceTestClient,
    path.dirname(foreignManifest),
  );
  expect(mismatch.code).toBe(1);
  expect(mismatch.err).toContain(AUDIO_OBJECT_MISMATCH);
  expectSafeOutput(mismatch, foreignManifest, mismatched);
  expect(await readExamState(mismatched.slug)).toBeNull();

  // The first package is retried unchanged and publishes exactly once.
  const retry = await publish(createServiceTestClient);
  expect(retry.code, retry.err).toBe(0);
  expect(retry.out).toContain(`Published slug=${exam.slug}`);
  expectSafeOutput(retry, manifest, exam);
  expect((await readExamState(exam.slug))?.versionIds).toHaveLength(1);
});
