import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ExamContent } from '@b1k/domain';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import {
  TimingProfileRefusal,
  confirmTimingProfileRevision,
  createTimingProfileRevision,
  ownerConnectionEnv,
  psqlEnv,
  readOwnerDatabaseUrl,
  runTimingProfileCommand,
  showTimingProfile,
} from '../../../scripts/manage-timing-profile';
import type {
  SqlRunner,
  TimingRevision,
  TimingSettings,
} from '../../../scripts/manage-timing-profile';
import { readConfirmedTimingProfile } from '../src/server/attempts/profiles';
import {
  createPublicClient,
  depsNow,
  insertRawVersion,
  latestVersionOf,
  newGuest,
  readAttempts,
  serviceDb,
  startFor,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  SHORT_TIMING,
  ensureConfirmedTestProfile,
} from './support/full-exam';
import globalSetup, { createTestRecording } from './support/global-setup';
import {
  DB_CONTAINER,
  assertLocalTarget,
  holdSlotLock,
  installM2Fixtures,
  localTarget,
  psql,
  psqlJson,
  quote,
  slotKeySql,
  sqlRunnerAs,
} from './support/sql';
import type { TestSqlRole } from './support/sql';

// Trusted timing profiles (#42): append-only revisions, a fingerprint
// computed by the database, explicit owner confirmation of the current head,
// the private gate for the timed start of #43 and the immutable pin of a
// run. Every exam here is published under its own slug and recording, so
// test-full-dtz and the profiles of other specs never change.

const owner = sqlRunnerAs('owner');
const API_ROLES: readonly TestSqlRole[] = [
  'anon',
  'authenticated',
  'service_role',
];

let counter = 0;
const uniqueExam = () => ({
  slug: `test-timing-${Date.now().toString(36)}-${counter++}`,
  title: 'Timing profile test',
  format: 'DTZ',
});

type Exam = ReturnType<typeof uniqueExam>;

// The same set with one prompt changed: a correction, published as v2.
const corrected = (content: ExamContent): ExamContent => ({
  ...content,
  questions: content.questions.map((question) =>
    question.id === 'hoeren-2'
      ? { ...question, prompt: `${question.prompt} (v2)` }
      : question,
  ),
});

// Each tone is another recording with its own SHA-256.
const publishTimed = async (
  exam: Exam,
  toneHz: number,
  content: ExamContent = FULL_PILOT.content,
): Promise<string> => {
  const outcome = await publishExamVersion(serviceDb, {
    ...exam,
    content,
    keys: FULL_PILOT.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...createTestRecording(toneHz) }],
  });
  return outcome.versionId;
};

const shaOfTone = (toneHz: number): string =>
  createHash('sha256').update(createTestRecording(toneHz).bytes).digest('hex');

// The canonical form the migration documents: sha256 of the jsonb text of
// one array. Recomputed here independently of the database.
const expectedFingerprint = (revision: TimingRevision): string => {
  const items = [
    'b1k-timing-profile-v1',
    revision.revisionId,
    revision.examVersionId,
    revision.revision,
    revision.trackId,
    revision.audioSha256,
    revision.recordingSeconds,
    revision.hoerenSeconds,
    revision.transitionSeconds,
    revision.lesenSeconds,
  ];
  const text = `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
  return createHash('sha256').update(text).digest('hex');
};

const settingsArgs = (settings: TimingSettings): string[] => [
  '--recording-seconds',
  String(settings.recordingSeconds),
  '--hoeren-seconds',
  String(settings.hoerenSeconds),
  '--transition-seconds',
  String(settings.transitionSeconds),
  '--lesen-seconds',
  String(settings.lesenSeconds),
];

const draft = (
  versionId: string,
  settings: TimingSettings,
  run: SqlRunner = owner,
): TimingRevision =>
  createTimingProfileRevision(run, { versionId }, settings).revision;

const confirm = (revision: TimingRevision, run: SqlRunner = owner) =>
  confirmTimingProfileRevision(run, {
    revisionId: revision.revisionId,
    fingerprint: revision.fingerprint,
  });

const refusalOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    if (error instanceof TimingProfileRefusal) return error.code;
    throw error;
  }
  throw new Error('a refusal was expected');
};

interface StoredRevision {
  id: string;
  revision: number;
  status: string;
  fingerprint: string;
  hoeren_seconds: number;
}

const revisionsOf = (versionId: string): StoredRevision[] =>
  psqlJson<StoredRevision[]>(`select coalesce(json_agg(json_build_object(
      'id', r.id, 'revision', r.revision, 'status', r.status,
      'fingerprint', r.fingerprint, 'hoeren_seconds', r.hoeren_seconds)
      order by r.revision), '[]')
    from m2_private.timing_profile_revisions r
    where r.exam_version_id = ${quote(versionId)}`);

const headOf = (versionId: string): number | null =>
  psqlJson<{ head: number | null }>(`select json_build_object('head',
    (select head_revision from m2_private.timing_profiles
      where exam_version_id = ${quote(versionId)}))`).head;

// What the private gate of #43 returns for the version: a revision id or
// null.
const gateOf = (versionId: string): string | null =>
  psqlJson<{ id: string | null }>(`select json_build_object('id',
    (select g.revision_id
      from m2_private.current_confirmed_profile(${quote(versionId)}) g))`).id;

const questionIdsOf = (skill: string): string[] =>
  FULL_PILOT.content.questions
    .filter((question) => question.skill === skill)
    .map((question) => question.id);

interface PinnedRun {
  mode: string;
  revisionId: string | null;
  snapshot: Record<string, unknown> | null;
}

const pinnedRunOf = (attemptId: string): PinnedRun =>
  psqlJson<PinnedRun>(`select json_build_object(
      'mode', r.mode,
      'revisionId', r.timing_profile_revision_id,
      'snapshot', r.timing_profile_snapshot)
    from public.attempt_runs r where r.attempt_id = ${quote(attemptId)}`);

// A separate psql session of the owner role, observed through its
// application name while it waits for a lock.
interface PsqlProcess {
  name: string;
  done: Promise<{ code: number | null; output: string }>;
}

const spawnPsql = (sql: string): PsqlProcess => {
  assertLocalTarget(localTarget());
  const name = `timing-${randomUUID()}`;
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGAPPNAME=${name}`,
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-tA',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdin.end(sql);
  const done = new Promise<{ code: number | null; output: string }>((resolve) =>
    child.once('close', (code) => resolve({ code, output })),
  );
  return { name, done };
};

const waitUntil = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const isWaitingOnLock = (name: string): boolean =>
  psql(`select count(*) from pg_stat_activity
    where application_name = ${quote(name)} and wait_event_type = 'Lock'`) ===
  '1';

const createCall = (versionId: string, settings: TimingSettings): string =>
  `m2_owner.create_timing_profile_revision(${quote(versionId)}::uuid,
    ${settings.recordingSeconds}, ${settings.hoerenSeconds},
    ${settings.transitionSeconds}, ${settings.lesenSeconds})`;

const createSql = (versionId: string, settings: TimingSettings): string =>
  `select ${createCall(versionId, settings)};`;

// The setup of ensureConfirmedTestProfile as one SQL statement of its own
// session: draft, then confirm the returned revision with the fingerprint
// the database computed (already-confirmed when nothing changed).
const setupSql = (versionId: string, settings: TimingSettings): string =>
  `with drafted as materialized (
      select ${createCall(versionId, settings)} as doc)
    select m2_owner.confirm_timing_profile_revision(
      (doc -> 'revision' ->> 'revisionId')::uuid,
      doc -> 'revision' ->> 'fingerprint')
    from drafted;`;

const SOURCE_ROOT = path.join(import.meta.dirname, '..', 'src');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });

test('owner tool explicitly confirms exact profile fingerprint', async () => {
  const exam = uniqueExam();
  const versionId = await publishTimed(exam, 523);

  const empty = showTimingProfile(owner, { examSlug: exam.slug });
  expect(empty).toMatchObject({
    examSlug: exam.slug,
    examVersionId: versionId,
    version: 1,
    recordings: [{ trackId: FULL_TRACK_ID, sha256: shaOfTone(523) }],
    head: null,
    confirmedRevisionId: null,
  });

  // The draft command creates the revision and only names the confirmation.
  const drafted = runTimingProfileCommand(owner, [
    'draft',
    '--exam',
    exam.slug,
    ...settingsArgs(FULL_TIMING),
  ]) as { outcome: string; revision: TimingRevision; next: string };
  const revision = drafted.revision;
  expect(drafted.outcome).toBe('created');
  expect(revision).toMatchObject({
    examVersionId: versionId,
    revision: 1,
    trackId: FULL_TRACK_ID,
    audioSha256: shaOfTone(523),
    ...FULL_TIMING,
    status: 'draft',
    confirmedAt: null,
  });
  expect(revision.fingerprint).toBe(expectedFingerprint(revision));
  expect(drafted.next).toContain(
    `confirm --revision-id ${revision.revisionId} ` +
      `--fingerprint ${revision.fingerprint}`,
  );
  expect(gateOf(versionId)).toBeNull();
  expect(await readConfirmedTimingProfile(depsNow(), versionId)).toBeNull();

  // The fingerprint stored is the one the database recomputes.
  expect(
    psql(`select m2_private.timing_profile_fingerprint_of(r) = r.fingerprint
      from m2_private.timing_profile_revisions r
      where r.id = ${quote(revision.revisionId)}`),
  ).toBe('t');

  // Another fingerprint, even of the same settings, confirms nothing.
  const wrong = `${revision.fingerprint.slice(0, 63)}${
    revision.fingerprint.endsWith('0') ? '1' : '0'
  }`;
  expect(
    refusalOf(() =>
      confirmTimingProfileRevision(owner, {
        revisionId: revision.revisionId,
        fingerprint: wrong,
      }),
    ),
  ).toBe('timing_profile_fingerprint_mismatch');
  expect(() =>
    runTimingProfileCommand(owner, [
      'confirm',
      '--revision-id',
      revision.revisionId,
    ]),
  ).toThrow(/--fingerprint is required/);
  expect(revisionsOf(versionId).map((row) => row.status)).toEqual(['draft']);

  const confirmed = runTimingProfileCommand(owner, [
    'confirm',
    '--revision-id',
    revision.revisionId,
    '--fingerprint',
    revision.fingerprint,
  ]) as { outcome: string; revision: TimingRevision };
  expect(confirmed.outcome).toBe('confirmed');
  expect(confirmed.revision.status).toBe('confirmed');
  expect(confirmed.revision.confirmedAt).not.toBeNull();
  expect(confirmed.revision.fingerprint).toBe(revision.fingerprint);
  expect(confirm(revision).outcome).toBe('already-confirmed');

  expect(gateOf(versionId)).toBe(revision.revisionId);
  expect(await readConfirmedTimingProfile(depsNow(), versionId)).toEqual({
    revisionId: revision.revisionId,
    examVersionId: versionId,
    revision: 1,
    ...FULL_TIMING,
    fingerprint: revision.fingerprint,
  });
  expect(showTimingProfile(owner, { versionId }).confirmedRevisionId).toBe(
    revision.revisionId,
  );

  // The command line needs the owner connection, never the runtime key.
  expect(() => readOwnerDatabaseUrl({})).toThrow(/TIMING_PROFILE_OWNER_DB_URL/);
  expect(() =>
    readOwnerDatabaseUrl({
      SUPABASE_SECRET_KEY: 'sb_secret_x',
      SUPABASE_URL: 'https://example.supabase.co',
    }),
  ).toThrow(/TIMING_PROFILE_OWNER_DB_URL/);
  expect(() =>
    readOwnerDatabaseUrl({
      VERCEL: '1',
      TIMING_PROFILE_OWNER_DB_URL: 'postgresql://postgres@localhost/postgres',
    }),
  ).toThrow(/Vercel/);

  // psql gets exactly the owner connection: inherited libpq settings and
  // message locale are dropped, unknown URL options are refused.
  const connection = ownerConnectionEnv(
    'postgresql://postgres:p%40ss@db.example.supabase.co:5432/postgres',
  );
  expect(connection).toEqual({
    PGHOST: 'db.example.supabase.co',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGDATABASE: 'postgres',
    PGSSLMODE: 'require',
    PGPASSWORD: 'p@ss',
  });
  expect(
    psqlEnv(
      {
        PATH: '/bin',
        PGHOSTADDR: '10.0.0.1',
        PGSERVICE: 'other',
        PGPASSWORD: 'other',
        LC_ALL: 'de_DE.UTF-8',
      },
      connection,
    ),
  ).toEqual({ PATH: '/bin', LC_MESSAGES: 'C', ...connection });
  expect(() =>
    ownerConnectionEnv(
      'postgresql://postgres@db.example.supabase.co/postgres?options=-c',
    ),
  ).toThrow(/only sslmode/);
});

test('profile revisions retain pinned running snapshot', async () => {
  installM2Fixtures();
  const exam = uniqueExam();
  const versionId = await publishTimed(exam, 659);
  const first = ensureConfirmedTestProfile(owner, versionId, SHORT_TIMING);

  // A trusted fixture pins the confirmed head as the SQL start of #43 will.
  const guest = await newGuest(depsNow());
  const attemptId = psql(`select m2_test.insert_pinned_run_at(
    ${quote(guest.guest.sessionId)}, ${quote(versionId)}, 'hoeren',
    ${quote(JSON.stringify(questionIdsOf('hoeren')))}::jsonb,
    clock_timestamp())`);
  const pinned = pinnedRunOf(attemptId);
  expect(pinned.mode).toBe('timed-block');
  expect(pinned.revisionId).toBe(first.revisionId);
  expect(pinned.snapshot).toEqual(first);

  // New revisions, also confirmed ones, never rewrite the pinned run.
  const second = draft(versionId, { ...SHORT_TIMING, hoerenSeconds: 9 });
  expect(second.revision).toBe(2);
  expect(gateOf(versionId)).toBeNull();
  expect(pinnedRunOf(attemptId)).toEqual(pinned);
  confirm(second);
  expect(gateOf(versionId)).toBe(second.revisionId);
  expect(pinnedRunOf(attemptId)).toEqual(pinned);

  // A direct rewrite is refused by the trigger, even for the owner role.
  for (const change of [
    `timing_profile_snapshot = jsonb_set(timing_profile_snapshot,
      '{hoerenSeconds}', '9999')`,
    `timing_profile_revision_id = ${quote(second.revisionId)},
      timing_profile_snapshot = (select m2_private.timing_profile_document(r)
        from m2_private.timing_profile_revisions r
        where r.id = ${quote(second.revisionId)})`,
    'timing_profile_revision_id = null, timing_profile_snapshot = null',
  ]) {
    expect(() =>
      psql(`update public.attempt_runs set ${change}
        where attempt_id = ${quote(attemptId)}`),
    ).toThrow(/attempt_run_fixed/);
  }
  const serviceChange = await serviceDb
    .from('attempt_runs')
    .update({ timing_profile_snapshot: null })
    .eq('attempt_id', attemptId);
  expect(serviceChange.error).not.toBeNull();
  expect(pinnedRunOf(attemptId)).toEqual(pinned);

  // A run pins only a confirmed revision of its own version, with exactly
  // its document; a training run never pins.
  const other = uniqueExam();
  const otherVersion = await publishTimed(other, 698);
  const otherDraft = draft(otherVersion, SHORT_TIMING);
  const otherGuest = await newGuest(depsNow());
  const insertRun = (
    mode: string,
    revisionId: string,
    snapshot: string,
  ) => `begin;
    insert into public.attempts (id, guest_session_id, exam_id,
      exam_version_id, scope)
    select '00000000-0000-4000-8000-000000000042',
      ${quote(otherGuest.guest.sessionId)}, v.exam_id, v.id, 'short-set'
    from public.exam_versions v where v.id = ${quote(versionId)};
    insert into public.attempt_runs (attempt_id, mode, purpose, selection,
      assignment, accepted_at, timing_profile_revision_id,
      timing_profile_snapshot)
    values ('00000000-0000-4000-8000-000000000042', ${quote(mode)}, 'normal',
      'hoeren', ${quote(
        JSON.stringify({
          versionId,
          questionIds: questionIdsOf('hoeren'),
        }),
      )}::jsonb, now(), ${quote(revisionId)}, ${snapshot});
    rollback;`;
  const documentOf = (revisionId: string) =>
    `(select m2_private.timing_profile_document(r)
      from m2_private.timing_profile_revisions r
      where r.id = ${quote(revisionId)})`;
  // A confirmed revision with a forged duration.
  expect(() =>
    psql(
      insertRun(
        'timed-block',
        second.revisionId,
        `jsonb_set(${documentOf(second.revisionId)}, '{hoerenSeconds}', '1')`,
      ),
    ),
  ).toThrow(/timing_profile_pin_invalid/);
  // A draft of another version.
  expect(() =>
    psql(
      insertRun(
        'timed-block',
        otherDraft.revisionId,
        documentOf(otherDraft.revisionId),
      ),
    ),
  ).toThrow(/timing_profile_pin_invalid/);
  // A superseded confirmed revision with its exact document: no fallback.
  expect(revisionsOf(versionId).map((row) => row.status)).toEqual([
    'confirmed',
    'confirmed',
  ]);
  expect(() =>
    psql(
      insertRun('timed-block', first.revisionId, documentOf(first.revisionId)),
    ),
  ).toThrow(/timing_profile_pin_invalid/);
  // The confirmed head with its exact document, but on a training run.
  expect(() =>
    psql(
      insertRun('training', second.revisionId, documentOf(second.revisionId)),
    ),
  ).toThrow(/attempt_runs_training_unpinned/);
  expect(await readAttempts(otherGuest.guest.sessionId)).toEqual([]);

  // Since #43 the production start of a timed block, and since #45 the
  // start of the full exam, pins the current confirmed head with exactly its
  // document, never the superseded first revision.
  const runs: [string, string][] = [
    ['timed-block', 'hoeren'],
    ['timed-block', 'lesen'],
    ['exam', 'all'],
  ];
  for (const [mode, selection] of runs) {
    const timedGuest = await newGuest(depsNow());
    const timed = await startFor(depsNow(), timedGuest.token, exam.slug, {
      mode,
      selection,
    });
    expect(timed).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
    if (!timed.ok) throw new Error('timed start failed');
    const run = pinnedRunOf(timed.result.attemptId);
    expect(run.mode).toBe(mode);
    expect(run.revisionId).toBe(second.revisionId);
    expect(run.revisionId).not.toBe(first.revisionId);
    expect(run.snapshot).toMatchObject({
      revisionId: second.revisionId,
      status: 'confirmed',
      hoerenSeconds: 9,
    });
  }
  expect(pinnedRunOf(attemptId)).toEqual(pinned);
});

test('trusted profile gate and free start are independent', async () => {
  const exam = uniqueExam();
  const versionId = await publishTimed(exam, 740);

  // Without any profile the free training starts and pins nothing.
  const guest = await newGuest(depsNow());
  const started = await startFor(depsNow(), guest.token, exam.slug);
  expect(started).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!started.ok) throw new Error('free start failed');
  expect(pinnedRunOf(started.result.attemptId)).toEqual({
    mode: 'training',
    revisionId: null,
    snapshot: null,
  });
  expect(gateOf(versionId)).toBeNull();
  expect(await readConfirmedTimingProfile(depsNow(), versionId)).toBeNull();

  // Without a confirmed profile a timed start stays not-enabled and writes
  // nothing; with one (test-full-dtz) it is accepted and pinned to the head
  // the gate returns.
  const timedGuest = await newGuest(depsNow());
  expect(
    await startFor(depsNow(), timedGuest.token, exam.slug, {
      mode: 'timed-block',
      selection: 'hoeren',
    }),
  ).toEqual({ ok: false, failure: 'not-enabled' });
  expect(await readAttempts(timedGuest.guest.sessionId)).toEqual([]);
  const fullHead = await latestVersionOf(FULL_EXAM.slug);
  if (!fullHead) throw new Error('full set is missing');
  const timedFull = await startFor(
    depsNow(),
    timedGuest.token,
    FULL_EXAM.slug,
    {
      mode: 'timed-block',
      selection: 'hoeren',
    },
  );
  expect(timedFull).toMatchObject({
    ok: true,
    result: { outcome: 'accepted' },
  });
  if (!timedFull.ok) throw new Error('timed start failed');
  expect(pinnedRunOf(timedFull.result.attemptId).revisionId).toBe(
    gateOf(fullHead.versionId),
  );

  // The gate returns the confirmed profile of test-full-dtz to the trusted
  // server, read-only.
  const full = await latestVersionOf(FULL_EXAM.slug);
  if (!full) throw new Error('full set is missing');
  const fullProfile = await readConfirmedTimingProfile(
    depsNow(),
    full.versionId,
  );
  expect(fullProfile).toMatchObject({
    examVersionId: full.versionId,
    ...FULL_TIMING,
  });
  expect(gateOf(full.versionId)).toBe(fullProfile?.revisionId);

  // A confirmed profile changes nothing for the free training.
  const revision = ensureConfirmedTestProfile(owner, versionId, FULL_TIMING);
  expect(gateOf(versionId)).toBe(revision.revisionId);
  const later = await newGuest(depsNow());
  const second = await startFor(depsNow(), later.token, exam.slug, {
    selection: 'lesen',
  });
  expect(second).toMatchObject({ ok: true, result: { outcome: 'accepted' } });
  if (!second.ok) throw new Error('free start failed');
  expect(pinnedRunOf(second.result.attemptId).revisionId).toBeNull();
  expect(pinnedRunOf(started.result.attemptId).revisionId).toBeNull();

  // Training and legacy runs never carry a pin.
  expect(
    psql(`select count(*) from public.attempt_runs
      where mode = 'training'
        and (timing_profile_revision_id is not null
          or timing_profile_snapshot is not null)`),
  ).toBe('0');
});

test('profile setup is idempotent and isolated by exam slug', async () => {
  const full = await latestVersionOf(FULL_EXAM.slug);
  if (!full) throw new Error('full set is missing');
  const before = revisionsOf(full.versionId);
  const head = before.at(-1);
  expect(head).toMatchObject({
    status: 'confirmed',
    hoeren_seconds: FULL_TIMING.hoerenSeconds,
  });
  expect(headOf(full.versionId)).toBe(head?.revision);

  // A repeated global setup publishes nothing new and adds no revision.
  await globalSetup();
  expect((await latestVersionOf(FULL_EXAM.slug))?.versionId).toBe(
    full.versionId,
  );
  expect(revisionsOf(full.versionId)).toEqual(before);
  expect(
    ensureConfirmedTestProfile(owner, full.versionId, FULL_TIMING).revisionId,
  ).toBe(head?.id);
  expect(revisionsOf(full.versionId)).toEqual(before);
  expect(gateOf(full.versionId)).toBe(head?.id);

  // Two exams with their own slug, version and recording are set up at the
  // same time in separate database sessions, while test-full-dtz and the
  // first exam are set up once more in parallel.
  const first = uniqueExam();
  const second = uniqueExam();
  const [firstVersion, secondVersion] = await Promise.all([
    publishTimed(first, 784),
    publishTimed(second, 831),
  ]);
  const sessions = [
    setupSql(firstVersion, FULL_TIMING),
    setupSql(secondVersion, SHORT_TIMING),
    setupSql(full.versionId, FULL_TIMING),
    setupSql(firstVersion, FULL_TIMING),
  ].map((sql) => spawnPsql(sql));
  const results = await Promise.all(sessions.map((session) => session.done));
  expect(
    results.map((result) => result.code),
    results.map((result) => result.output).join('\n'),
  ).toEqual([0, 0, 0, 0]);

  const statusOf = (versionId: string) =>
    revisionsOf(versionId).map((row) => [row.revision, row.status]);
  expect(statusOf(firstVersion)).toEqual([[1, 'confirmed']]);
  expect(statusOf(secondVersion)).toEqual([[1, 'confirmed']]);
  expect(revisionsOf(full.versionId)).toEqual(before);

  const firstHead = showTimingProfile(owner, { versionId: firstVersion }).head;
  const secondHead = showTimingProfile(owner, {
    versionId: secondVersion,
  }).head;
  if (!firstHead || !secondHead) throw new Error('profiles are missing');
  expect(firstHead).toMatchObject({
    audioSha256: shaOfTone(784),
    ...FULL_TIMING,
    status: 'confirmed',
  });
  expect(secondHead).toMatchObject({
    audioSha256: shaOfTone(831),
    ...SHORT_TIMING,
    status: 'confirmed',
  });
  expect(firstHead.fingerprint).toBe(expectedFingerprint(firstHead));
  expect(secondHead.fingerprint).toBe(expectedFingerprint(secondHead));
  expect(firstHead.fingerprint).not.toBe(secondHead.fingerprint);

  // The setup helper of global setup, repeated, adds nothing anywhere.
  const firstRows = revisionsOf(firstVersion);
  const secondRows = revisionsOf(secondVersion);
  ensureConfirmedTestProfile(owner, firstVersion, FULL_TIMING);
  ensureConfirmedTestProfile(owner, secondVersion, SHORT_TIMING);
  expect(revisionsOf(firstVersion)).toEqual(firstRows);
  expect(revisionsOf(secondVersion)).toEqual(secondRows);
  expect(gateOf(firstVersion)).toBe(firstHead.revisionId);
  expect(gateOf(secondVersion)).toBe(secondHead.revisionId);
  expect(revisionsOf(full.versionId)).toEqual(before);
});

test('owner confirmation rejects stale fingerprint and public credentials', async () => {
  const exam = uniqueExam();
  const versionId = await publishTimed(exam, 880);
  const first = draft(versionId, FULL_TIMING);
  const second = draft(versionId, SHORT_TIMING);
  expect([first.revision, second.revision]).toEqual([1, 2]);

  // The superseded revision is not confirmed, with its own fingerprint or
  // with the one of the current head.
  expect(refusalOf(() => confirm(first))).toBe('timing_profile_not_current');
  expect(
    refusalOf(() =>
      confirmTimingProfileRevision(owner, {
        revisionId: first.revisionId,
        fingerprint: second.fingerprint,
      }),
    ),
  ).toBe('timing_profile_not_current');
  expect(
    refusalOf(() =>
      confirmTimingProfileRevision(owner, {
        revisionId: second.revisionId,
        fingerprint: first.fingerprint,
      }),
    ),
  ).toBe('timing_profile_fingerprint_mismatch');
  expect(
    refusalOf(() =>
      confirmTimingProfileRevision(owner, {
        revisionId: randomUUID(),
        fingerprint: second.fingerprint,
      }),
    ),
  ).toBe('timing_profile_revision_missing');

  // No API role, the runtime service_role included, reaches the owner tool.
  for (const role of API_ROLES) {
    const run = sqlRunnerAs(role);
    expect(refusalOf(() => confirm(second, run))).toBe('permission_denied');
    expect(refusalOf(() => draft(versionId, FULL_TIMING, run))).toBe(
      'permission_denied',
    );
    expect(refusalOf(() => showTimingProfile(run, { versionId }))).toBe(
      'permission_denied',
    );
    expect(() =>
      psql(`set role ${role};
        update m2_private.timing_profile_revisions
        set status = 'confirmed', confirmed_at = now()
        where id = ${quote(second.revisionId)};`),
    ).toThrow(/permission denied/);
  }
  expect(revisionsOf(versionId).map((row) => row.status)).toEqual([
    'draft',
    'draft',
  ]);

  // A confirmation that waits for a concurrent new draft is judged after the
  // lock: the head moved, so it confirms nothing.
  // The new draft holds the head row and then waits on a lock the test
  // releases, so the confirmation provably queues behind it.
  const lockSession = randomUUID();
  const lockExam = randomUUID();
  const holder = await holdSlotLock(lockSession, lockExam);
  const creator = spawnPsql(`begin;
    ${createSql(versionId, { ...FULL_TIMING, hoerenSeconds: 1400 })}
    select pg_advisory_xact_lock(${slotKeySql(lockSession, lockExam)});
    commit;`);
  try {
    await waitUntil(() => isWaitingOnLock(creator.name), 'draft holds head');
    const confirmer = spawnPsql(
      `select m2_owner.confirm_timing_profile_revision(
        ${quote(second.revisionId)}::uuid, ${quote(second.fingerprint)});`,
    );
    await waitUntil(
      () => isWaitingOnLock(confirmer.name),
      'confirmation waits for the head',
    );
    await holder.release();
    const [created, confirmed] = await Promise.all([
      creator.done,
      confirmer.done,
    ]);
    expect(created.code).toBe(0);
    expect(confirmed.code).not.toBe(0);
    expect(confirmed.output).toContain('timing_profile_not_current');
  } finally {
    await holder.release().catch(() => undefined);
  }
  expect(revisionsOf(versionId).map((row) => row.status)).toEqual([
    'draft',
    'draft',
    'draft',
  ]);
  expect(headOf(versionId)).toBe(3);
  expect(gateOf(versionId)).toBeNull();

  // Concurrent drafts are serialized on the head: consecutive numbers, one
  // head, no lost revision.
  const racers = [1300, 1200].map((hoerenSeconds) =>
    spawnPsql(createSql(versionId, { ...FULL_TIMING, hoerenSeconds })),
  );
  const raced = await Promise.all(racers.map((racer) => racer.done));
  expect(raced.map((result) => result.code)).toEqual([0, 0]);
  const rows = revisionsOf(versionId);
  expect(rows.map((row) => row.revision)).toEqual([1, 2, 3, 4, 5]);
  expect(
    rows
      .slice(3)
      .map((row) => row.hoeren_seconds)
      .toSorted(),
  ).toEqual([1200, 1300]);
  expect(headOf(versionId)).toBe(5);
  expect(gateOf(versionId)).toBeNull();
});

test('current draft missing and mismatched profiles refuse timed gate', async () => {
  const exam = uniqueExam();
  const v1 = await publishTimed(exam, 932);
  expect(gateOf(v1)).toBeNull();
  expect(await readConfirmedTimingProfile(depsNow(), v1)).toBeNull();

  const first = ensureConfirmedTestProfile(owner, v1, FULL_TIMING);
  expect(gateOf(v1)).toBe(first.revisionId);

  // A new draft hides the older confirmed revision: no fallback.
  const second = draft(v1, SHORT_TIMING);
  expect(gateOf(v1)).toBeNull();
  expect(await readConfirmedTimingProfile(depsNow(), v1)).toBeNull();
  expect(revisionsOf(v1).map((row) => row.status)).toEqual([
    'confirmed',
    'draft',
  ]);
  confirm(second);
  expect(gateOf(v1)).toBe(second.revisionId);

  // Another version of the exam, with the same recording or a new one, has
  // no profile of its own and never borrows the one of v1.
  const v2 = await publishTimed(exam, 932, corrected(FULL_PILOT.content));
  expect(v2).not.toBe(v1);
  expect(gateOf(v2)).toBeNull();
  const v3 = await publishTimed(exam, 988, corrected(FULL_PILOT.content));
  expect(v3).not.toBe(v2);
  expect(gateOf(v3)).toBeNull();
  expect(await readConfirmedTimingProfile(depsNow(), v3)).toBeNull();
  expect(gateOf(v1)).toBe(second.revisionId);

  // Inside rolled-back transactions the stored data is forced past the
  // guards: a changed recording SHA (with a matching fingerprint), changed
  // durations under the old fingerprint, or a second recording of the
  // version all close the gate.
  const gateAfter = (change: string): string | null =>
    psqlJson<{ id: string | null }>(`begin;
      alter table m2_private.timing_profile_revisions disable trigger user;
      ${change};
      select json_build_object('id', (select g.revision_id
        from m2_private.current_confirmed_profile(${quote(v1)}) g));
      rollback;`).id;
  const otherSha = '0'.repeat(64);
  expect(
    gateAfter(`update m2_private.timing_profile_revisions r
      set audio_sha256 = ${quote(otherSha)},
        fingerprint = m2_private.timing_profile_fingerprint(r.id,
          r.exam_version_id, r.revision, r.track_id, ${quote(otherSha)},
          r.recording_seconds, r.hoeren_seconds, r.transition_seconds,
          r.lesen_seconds)
      where r.id = ${quote(second.revisionId)}`),
  ).toBeNull();
  expect(
    gateAfter(`update m2_private.timing_profile_revisions
      set hoeren_seconds = hoeren_seconds + 1
      where id = ${quote(second.revisionId)}`),
  ).toBeNull();
  expect(
    gateAfter(`insert into public.exam_version_audio (exam_version_id,
        track_id, kind, object_path, content_type, sha256)
      values (${quote(v1)}, 'second-track', 'file',
        ${quote(`audio/${otherSha}.wav`)}, 'audio/wav', ${quote(otherSha)})`),
  ).toBeNull();
  expect(gateOf(v1)).toBe(second.revisionId);

  // A version with two recordings cannot even get a draft.
  expect(
    psqlJson<{ hint: string }>(`begin;
      insert into public.exam_version_audio (exam_version_id, track_id, kind,
        object_path, content_type, sha256)
      values (${quote(v3)}, 'second-track', 'file',
        ${quote(`audio/${otherSha}.wav`)}, 'audio/wav', ${quote(otherSha)});
      create temp table outcome (hint text) on commit drop;
      do $$
      declare
        v_hint text;
      begin
        perform m2_owner.create_timing_profile_revision(${quote(v3)}::uuid,
          60, 1500, 60, 2700);
        insert into outcome values ('created');
      exception when others then
        get stacked diagnostics v_hint = pg_exception_hint;
        insert into outcome values (v_hint);
      end $$;
      select json_build_object('hint', (select hint from outcome));
      rollback;`).hint,
  ).toBe('timing_profile_audio_ambiguous');
  expect(
    refusalOf(() =>
      createTimingProfileRevision(
        owner,
        { versionId: randomUUID() },
        {
          ...FULL_TIMING,
        },
      ),
    ),
  ).toBe('timing_profile_version_missing');
  expect(revisionsOf(v3)).toEqual([]);

  // The one recording must be the Hören track the content plays: a version
  // whose Hören questions name another track gets no draft, and even a
  // forced confirmed revision for it never opens the gate.
  const raw = await insertRawVersion({
    slug: uniqueExam().slug,
    content: FULL_PILOT.content,
    keys: FULL_PILOT.keys,
  });
  psql(`insert into public.exam_version_audio (exam_version_id, track_id,
      kind, object_path, content_type, sha256)
    values (${quote(raw)}, 'other-track', 'file',
      ${quote(`audio/${otherSha}.wav`)}, 'audio/wav', ${quote(otherSha)})`);
  expect(refusalOf(() => draft(raw, FULL_TIMING))).toBe(
    'timing_profile_track_mismatch',
  );
  expect(revisionsOf(raw)).toEqual([]);
  const forcedId = randomUUID();
  const forcedValues = `${quote(forcedId)}, ${quote(raw)}, 1, 'other-track',
    ${quote(otherSha)}, 60, 1500, 60, 2700`;
  expect(
    psqlJson<{ id: string | null }>(`begin;
      alter table m2_private.timing_profile_revisions disable trigger user;
      insert into m2_private.timing_profiles (exam_version_id, head_revision)
      values (${quote(raw)}, 1);
      insert into m2_private.timing_profile_revisions (id, exam_version_id,
        revision, track_id, audio_sha256, recording_seconds, hoeren_seconds,
        transition_seconds, lesen_seconds, fingerprint, status, created_at,
        confirmed_at)
      values (${forcedValues},
        m2_private.timing_profile_fingerprint(${forcedValues}),
        'confirmed', now(), now());
      select json_build_object('id', (select g.revision_id
        from m2_private.current_confirmed_profile(${quote(raw)}) g));
      rollback;`).id,
  ).toBeNull();
  expect(revisionsOf(raw)).toEqual([]);
});

test('public roles cannot mutate timing profiles or confirmations', async () => {
  const exam = uniqueExam();
  const versionId = await publishTimed(exam, 1046);
  const revision = draft(versionId, FULL_TIMING);

  const ownerFunctions = [
    'm2_owner.timing_profile_state(uuid)',
    'm2_owner.create_timing_profile_revision(uuid, integer, integer, integer, integer)',
    'm2_owner.confirm_timing_profile_revision(uuid, text)',
  ];
  const privateFunctions = [
    'm2_private.current_confirmed_profile(uuid)',
    'm2_private.timing_profile_fingerprint(uuid, uuid, integer, text, text, integer, integer, integer, integer)',
    'm2_private.timing_profile_fingerprint_of(m2_private.timing_profile_revisions)',
    'm2_private.timing_profile_document(m2_private.timing_profile_revisions)',
    'm2_private.timing_profile_matches(m2_private.timing_profile_revisions)',
    'm2_private.guard_new_timing_profile_revision()',
    'm2_private.guard_timing_profile_revision()',
    'm2_private.guard_timing_profile_head()',
    'm2_private.reject_timing_profile_truncate()',
    'm2_private.check_timing_profile_head()',
    'm2_private.confirmed_head(uuid)',
    'm2_private.utc_text(timestamptz)',
    'm2_private.hoeren_track_ids(uuid)',
  ];
  const reader = 'public.m2_confirmed_timing_profile(uuid)';
  const tables = [
    'm2_private.timing_profiles',
    'm2_private.timing_profile_revisions',
  ];
  for (const role of API_ROLES) {
    for (const schema of ['m2_owner', 'm2_private']) {
      expect(
        psql(`select has_schema_privilege(${quote(role)}, ${quote(schema)},
          'usage')`),
        `${role} ${schema}`,
      ).toBe('f');
    }
    for (const fn of [...ownerFunctions, ...privateFunctions]) {
      expect(
        psql(`select has_function_privilege(${quote(role)}, ${quote(fn)},
          'execute')`),
        `${role} ${fn}`,
      ).toBe('f');
    }
    for (const table of tables) {
      for (const privilege of ['select', 'insert', 'update', 'delete']) {
        expect(
          psql(`select has_table_privilege(${quote(role)}, ${quote(table)},
            ${quote(privilege)})`),
          `${role} ${privilege} ${table}`,
        ).toBe('f');
      }
    }
    expect(
      psql(`select has_function_privilege(${quote(role)}, ${quote(reader)},
        'execute')`),
      `${role} ${reader}`,
    ).toBe(role === 'service_role' ? 't' : 'f');
  }
  const allFunctions = [...ownerFunctions, ...privateFunctions, reader]
    .map((fn) => `${quote(fn)}::regprocedure`)
    .join(', ');
  expect(
    psql(`select count(*) from pg_proc p,
      aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      where x.grantee = 0 and p.oid in (${allFunctions})`),
  ).toBe('0');
  // Every new function has a fixed empty search_path; the definer ones are
  // exactly the owner entry points and the runtime reader.
  expect(
    psqlJson<{ fixed: boolean; definers: string[] }>(`select json_build_object(
      'fixed', bool_and(p.proconfig @> array['search_path=""']),
      'definers', coalesce(json_agg(n.nspname || '.' || p.proname
        order by n.nspname, p.proname) filter (where p.prosecdef), '[]'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.oid in (${allFunctions})`),
  ).toEqual({
    fixed: true,
    definers: [
      'm2_owner.confirm_timing_profile_revision',
      'm2_owner.create_timing_profile_revision',
      'm2_owner.timing_profile_state',
      'public.m2_confirmed_timing_profile',
    ],
  });
  expect(
    psql(`select bool_and(c.relrowsecurity) from pg_class c
      where c.oid in (${tables.map((t) => `${quote(t)}::regclass`).join(', ')})`),
  ).toBe('t');

  // The Data API knows neither the owner functions nor the private tables;
  // the publishable key cannot even call the runtime reader.
  const anon = createPublicClient();
  for (const client of [anon, serviceDb]) {
    const rpc = await client.rpc('confirm_timing_profile_revision', {
      p_revision_id: revision.revisionId,
      p_fingerprint: revision.fingerprint,
    });
    expect(rpc.error).not.toBeNull();
    const ownerRpc = await client
      .schema('m2_owner')
      .rpc('confirm_timing_profile_revision', {
        p_revision_id: revision.revisionId,
        p_fingerprint: revision.fingerprint,
      });
    expect(ownerRpc.error).not.toBeNull();
    const table = await client
      .schema('m2_private')
      .from('timing_profile_revisions')
      .update({ status: 'confirmed' })
      .eq('id', revision.revisionId);
    expect(table.error).not.toBeNull();
  }
  const anonRead = await anon.rpc('m2_confirmed_timing_profile', {
    p_version_id: versionId,
  });
  expect(anonRead.error?.code).toBe('42501');

  // Even the owner role cannot rewrite or delete a revision, nor confirm one
  // that is not the head.
  const later = draft(versionId, SHORT_TIMING);
  for (const statement of [
    `update m2_private.timing_profile_revisions set hoeren_seconds = 1
      where id = ${quote(later.revisionId)}`,
    `delete from m2_private.timing_profile_revisions
      where id = ${quote(revision.revisionId)}`,
    `update m2_private.timing_profiles set head_revision = 1
      where exam_version_id = ${quote(versionId)}`,
  ]) {
    expect(() => psql(statement)).toThrow(/timing_profile_append_only/);
  }
  expect(() =>
    psql(`update m2_private.timing_profile_revisions
      set status = 'confirmed', confirmed_at = now()
      where id = ${quote(revision.revisionId)}`),
  ).toThrow(/timing_profile_not_current/);
  expect(() =>
    psql(`insert into m2_private.timing_profile_revisions (id,
        exam_version_id, revision, track_id, audio_sha256, recording_seconds,
        hoeren_seconds, transition_seconds, lesen_seconds, fingerprint,
        status, created_at, confirmed_at)
      select gen_random_uuid(), r.exam_version_id, 3, r.track_id,
        r.audio_sha256, 60, 1500, 60, 2700, r.fingerprint, 'confirmed', now(),
        now()
      from m2_private.timing_profile_revisions r
      where r.id = ${quote(later.revisionId)}`),
  ).toThrow(/timing_profile_invalid/);
  // A valid next draft written without moving the head is refused at
  // commit: no orphan above the head.
  expect(() =>
    psql(`with n as (
        select gen_random_uuid() as id, r.exam_version_id,
          r.revision + 1 as revision, r.track_id, r.audio_sha256
        from m2_private.timing_profile_revisions r
        where r.id = ${quote(later.revisionId)})
      insert into m2_private.timing_profile_revisions (id, exam_version_id,
        revision, track_id, audio_sha256, recording_seconds, hoeren_seconds,
        transition_seconds, lesen_seconds, fingerprint, status, created_at)
      select n.id, n.exam_version_id, n.revision, n.track_id, n.audio_sha256,
        60, 1500, 60, 2700,
        m2_private.timing_profile_fingerprint(n.id, n.exam_version_id,
          n.revision, n.track_id, n.audio_sha256, 60, 1500, 60, 2700),
        'draft', now()
      from n`),
  ).toThrow(/timing_profile_invalid/);
  expect(revisionsOf(versionId).map((row) => row.status)).toEqual([
    'draft',
    'draft',
  ]);
  expect(gateOf(versionId)).toBeNull();

  // The web runtime neither imports the owner tool nor names an owner
  // function; it only reads the confirmed profile.
  const offenders = sourceFiles(SOURCE_ROOT).filter((file) =>
    /m2_owner|confirm_timing_profile|create_timing_profile|manage-timing-profile|TIMING_PROFILE_OWNER/.test(
      readFileSync(file, 'utf8'),
    ),
  );
  expect(offenders).toEqual([]);
  const readers = sourceFiles(SOURCE_ROOT).filter((file) =>
    readFileSync(file, 'utf8').includes('m2_confirmed_timing_profile'),
  );
  expect(readers.map((file) => path.relative(SOURCE_ROOT, file))).toEqual([
    path.join('server', 'attempts', 'profiles.ts'),
  ]);
});

test('profile edits do not affect sibling fixtures', async () => {
  const sibling = uniqueExam();
  const edited = uniqueExam();
  const [siblingVersion, editedVersion] = await Promise.all([
    publishTimed(sibling, 1109),
    publishTimed(edited, 1175),
  ]);
  const siblingProfile = ensureConfirmedTestProfile(
    owner,
    siblingVersion,
    FULL_TIMING,
  );
  ensureConfirmedTestProfile(owner, editedVersion, FULL_TIMING);
  const full = await latestVersionOf(FULL_EXAM.slug);
  if (!full) throw new Error('full set is missing');

  const siblingBefore = showTimingProfile(owner, { versionId: siblingVersion });
  const fullBefore = showTimingProfile(owner, { versionId: full.versionId });
  expect(siblingBefore.confirmedRevisionId).toBe(siblingProfile.revisionId);

  // Same durations on another version: another fingerprint.
  const editedDraft = draft(editedVersion, SHORT_TIMING);
  expect(gateOf(editedVersion)).toBeNull();
  expect(showTimingProfile(owner, { versionId: siblingVersion })).toEqual(
    siblingBefore,
  );
  expect(showTimingProfile(owner, { versionId: full.versionId })).toEqual(
    fullBefore,
  );
  confirm(editedDraft);
  expect(gateOf(editedVersion)).toBe(editedDraft.revisionId);
  expect(showTimingProfile(owner, { versionId: siblingVersion })).toEqual(
    siblingBefore,
  );
  expect(showTimingProfile(owner, { versionId: full.versionId })).toEqual(
    fullBefore,
  );
  expect(siblingBefore.head?.fingerprint).not.toBe(editedDraft.fingerprint);
  expect(revisionsOf(siblingVersion)).toHaveLength(1);
});
