import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import { latestVersionOf, serviceDb } from './support/db';
import { FULL_EXAM } from './support/full-exam';
import {
  LIFT_M2_CONSTRAINTS,
  RESTORE_M2_CONSTRAINTS,
  historicalCompletionSql,
  legacyAttemptSql,
  snapshotSql,
} from './support/legacy-attempt';
import type {
  HistoricalCompletion,
  LegacyAttempt,
} from './support/legacy-attempt';
import { psqlJson, quote } from './support/sql';

// The transfer of M1 attempts by the same owner-only functions the migration
// calls: m2_private.backfill_m1_attempts and m2_private.cancel_m1_duplicates.
// Every scenario is one psql transaction that lifts the NOT NULL of exam_id
// and the active index, writes real M1-shaped rows (no exam_id, no run),
// runs the functions, checks the outcome and ends with ROLLBACK. This spec
// runs alone in the serial migration project, after the ordinary projects
// and before the limits project.

test.describe.configure({ mode: 'serial' });

interface VersionInfo {
  examId: string;
  versionId: string;
  questionIds: string[];
}

const versionInfo = async (slug: string): Promise<VersionInfo> => {
  const latest = await latestVersionOf(slug);
  if (!latest) throw new Error(`no version of ${slug}`);
  const { data, error } = await serviceDb
    .from('exam_versions')
    .select('content')
    .eq('id', latest.versionId)
    .single<{ content: { questions: { id: string }[] } }>();
  if (error) throw error;
  return {
    ...latest,
    questionIds: data.content.questions.map((question) => question.id),
  };
};

let pilot: VersionInfo;
let full: VersionInfo;

test.beforeAll(async () => {
  pilot = await versionInfo(PILOT_EXAM_SLUG);
  full = await versionInfo(FULL_EXAM.slug);
});

interface Snapshot {
  attempt: Record<string, unknown> & {
    exam_id: string | null;
    status: string;
    scope: string;
    exam_version_id: string;
    progress: unknown;
    created_at: string;
  };
  run: {
    mode: string;
    purpose: string;
    selection: string;
    source_attempt_id: string | null;
    assignment: { versionId: string; questionIds: string[] };
    cancel_reason: string | null;
  } | null;
  answers: { question_id: string; option_id: string; revision: number }[];
  result: Record<string, unknown> | null;
  events: string[];
}

type Snapshots = Record<string, Snapshot>;

interface BackfillCount {
  filled_exams: number;
  created_runs: number;
}

// Two uuids that share a random part and differ only in the last byte, so
// their order is known: `low` sorts before `high`.
const orderedIds = (): { low: string; high: string } => {
  const base = randomUUID().slice(0, 34);
  return { low: `${base}0a`, high: `${base}0b` };
};

const guestSql = (id: string): string =>
  `insert into public.guest_sessions (id, token_hash, locale, created_at,
    expires_at)
  values (${quote(id)}, md5(${quote(id)}) || md5(${quote(id)} || 'x'), 'en',
    now(), now() + interval '720 hours');`;

const at = (base: Date, seconds: number): string =>
  new Date(base.getTime() + seconds * 1000).toISOString();

const legacy = (
  input: Partial<LegacyAttempt> &
    Pick<LegacyAttempt, 'id' | 'sessionId' | 'versionId' | 'createdAt'>,
): LegacyAttempt => ({
  status: 'active',
  scope: 'short-set',
  answers: {},
  progress: null,
  result: null,
  ...input,
});

// Records one value of the script under a key; the summary returns them all.
const keep = (key: string, select: string): string =>
  `insert into pg_temp.summary values (${quote(key)}, (${select}));`;

const backfill = (key: string, attemptId: string | null = null): string => {
  const argument = attemptId === null ? '' : `${quote(attemptId)}::uuid`;
  return keep(
    key,
    `select to_jsonb(f) from m2_private.backfill_m1_attempts(${argument}) f`,
  );
};

const cancel = (key: string): string =>
  keep(key, 'select to_jsonb(m2_private.cancel_m1_duplicates())');

// One transaction: lift, prepare, act, summarize, roll back.
const runScenario = <T>(steps: string[]): T =>
  psqlJson<T>(
    [
      'begin;',
      'create temp table summary (key text primary key, value jsonb);',
      // Runless attempts committed by other specs (owner fixtures) are
      // transferred first, inside the same rolled-back transaction, so the
      // counts below belong to this scenario's legacy rows only.
      'select * from m2_private.backfill_m1_attempts();',
      LIFT_M2_CONSTRAINTS,
      ...steps,
      'select jsonb_object_agg(key, value) from pg_temp.summary;',
      'rollback;',
    ].join('\n'),
  );

const snapshotOf = (ids: readonly string[]): string => snapshotSql(ids);

// Attempts written by other specs: already transferred neighbours.
const existingAttemptIds = async (): Promise<string[]> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(6)
    .returns<{ id: string }[]>();
  if (error) throw error;
  return data.map((row) => row.id);
};

const withoutTransfer = (snapshot: Snapshot) => ({
  ...snapshot,
  attempt: { ...snapshot.attempt, exam_id: null },
  run: null,
});

const pick = (snapshots: Snapshots, id: string): Snapshot => {
  const snapshot = snapshots[id];
  if (!snapshot) throw new Error(`no snapshot of ${id}`);
  return snapshot;
};

// After every scenario the rolled-back transaction has restored both
// constraints and left none of its rows.
test.afterEach(() => {
  const catalog = psqlJson<{
    notNull: boolean;
    index: string | null;
  }>(`select json_build_object(
    'notNull', (select attnotnull from pg_attribute
      where attrelid = 'public.attempts'::regclass and attname = 'exam_id'),
    'index', (select indexdef from pg_indexes
      where schemaname = 'public'
        and indexname = 'attempts_one_active_per_exam'))`);
  expect(catalog.notNull).toBe(true);
  expect(catalog.index).toContain('UNIQUE INDEX');
  expect(catalog.index).toContain('(guest_session_id, exam_id)');
  expect(catalog.index).toContain("WHERE (status = 'active'::text)");
});

test('backfill legacy m1 attempts is idempotent and preserves history', async () => {
  const guestId = randomUUID();
  const base = new Date(Date.now() - 3_600_000);
  const active = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: pilot.versionId,
    createdAt: at(base, 0),
    answers: { 'hoeren-1': 'a', 'hoeren-3': 'c' },
    progress: { block: 'hoeren', positionSeconds: 42 },
  });
  const completed = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: full.versionId,
    createdAt: at(base, 10),
    status: 'completed',
    answers: { 'hoeren-1': 'b', 'lesen-1': 'a' },
    result: { score: 1, maxScore: 45, correct: 1, incorrect: 1, skipped: 43 },
  });
  const ids = [active.id, completed.id];

  const summary = runScenario<{
    before: Snapshots;
    first: BackfillCount;
    afterFirst: Snapshots;
    cancelled: number;
    second: BackfillCount;
    afterSecond: Snapshots;
  }>([
    guestSql(guestId),
    legacyAttemptSql(active),
    legacyAttemptSql(completed),
    keep('before', snapshotOf(ids)),
    backfill('first'),
    keep('afterFirst', snapshotOf(ids)),
    cancel('cancelled'),
    backfill('second'),
    keep('afterSecond', snapshotOf(ids)),
    RESTORE_M2_CONSTRAINTS,
  ]);

  // The legacy shape was real: no exam_id and no run before the transfer.
  for (const id of ids) {
    expect(pick(summary.before, id).attempt.exam_id).toBeNull();
    expect(pick(summary.before, id).run).toBeNull();
  }
  expect(summary.first).toEqual({ filled_exams: 2, created_runs: 2 });
  expect(summary.cancelled).toBe(0);

  const expectations = [
    { attempt: active, info: pilot },
    { attempt: completed, info: full },
  ];
  for (const { attempt, info } of expectations) {
    const before = pick(summary.before, attempt.id);
    const after = pick(summary.afterFirst, attempt.id);
    expect(after.attempt.exam_id).toBe(info.examId);
    expect(after.run).toMatchObject({
      mode: 'training',
      purpose: 'normal',
      selection: 'all',
      source_attempt_id: null,
      cancel_reason: null,
      assignment: { versionId: info.versionId, questionIds: info.questionIds },
    });
    // Scope, version, status, progress, answers with revisions, result and
    // events stay exactly as they were.
    expect(withoutTransfer(after)).toEqual(withoutTransfer(before));
  }
  const activeAfter = pick(summary.afterFirst, active.id);
  expect(activeAfter.attempt.progress).toEqual(active.progress);
  expect(activeAfter.attempt.scope).toBe('short-set');
  expect(activeAfter.attempt.exam_version_id).toBe(pilot.versionId);
  expect(activeAfter.answers).toEqual([
    expect.objectContaining({
      question_id: 'hoeren-1',
      option_id: 'a',
      revision: 2,
    }),
    expect.objectContaining({
      question_id: 'hoeren-3',
      option_id: 'c',
      revision: 3,
    }),
  ]);
  const completedAfter = pick(summary.afterFirst, completed.id);
  expect(completedAfter.attempt.status).toBe('completed');
  expect(completedAfter.result).toMatchObject({
    score: 1,
    max_score: 45,
    correct_count: 1,
    incorrect_count: 1,
    skipped_count: 43,
  });

  // The second call finds nothing to do and changes nothing.
  expect(summary.second).toEqual({ filled_exams: 0, created_runs: 0 });
  expect(summary.afterSecond).toEqual(summary.afterFirst);
});

test('migration deduplicates by created at then id', async () => {
  const laterGuest = randomUUID();
  const tieGuest = randomUUID();
  const base = new Date(Date.now() - 7_200_000);
  // Case A: the later created_at wins although its id is the smaller one.
  const caseA = orderedIds();
  const laterSmall = legacy({
    id: caseA.low,
    sessionId: laterGuest,
    versionId: pilot.versionId,
    createdAt: at(base, 60),
  });
  const earlierLarge = legacy({
    id: caseA.high,
    sessionId: laterGuest,
    versionId: pilot.versionId,
    createdAt: at(base, 0),
    answers: { 'hoeren-2': 'b' },
  });
  // Case B: on equal created_at the greatest id wins.
  const caseB = orderedIds();
  const tieLow = legacy({
    id: caseB.low,
    sessionId: tieGuest,
    versionId: pilot.versionId,
    createdAt: at(base, 30),
    answers: { 'hoeren-4': 'a' },
  });
  const tieHigh = legacy({
    id: caseB.high,
    sessionId: tieGuest,
    versionId: pilot.versionId,
    createdAt: at(base, 30),
  });
  const ids = [laterSmall.id, earlierLarge.id, tieLow.id, tieHigh.id];

  const summary = runScenario<{
    filled: BackfillCount;
    cancelled: number;
    after: Snapshots;
    again: number;
  }>([
    guestSql(laterGuest),
    guestSql(tieGuest),
    ...[laterSmall, earlierLarge, tieLow, tieHigh].map(legacyAttemptSql),
    backfill('filled'),
    cancel('cancelled'),
    keep('after', snapshotOf(ids)),
    cancel('again'),
    // The active index can be created again on the cleaned data.
    RESTORE_M2_CONSTRAINTS,
  ]);

  expect(summary.filled).toEqual({ filled_exams: 4, created_runs: 4 });
  expect(summary.cancelled).toBe(2);
  expect(summary.again).toBe(0);

  for (const winner of [laterSmall, tieHigh]) {
    const snapshot = pick(summary.after, winner.id);
    expect(snapshot.attempt.status).toBe('active');
    expect(snapshot.run?.cancel_reason).toBeNull();
    expect(snapshot.events).toEqual([]);
  }
  const losers = [
    { attempt: earlierLarge, answer: ['hoeren-2', 'b'] },
    { attempt: tieLow, answer: ['hoeren-4', 'a'] },
  ];
  for (const { attempt, answer } of losers) {
    const snapshot = pick(summary.after, attempt.id);
    expect(snapshot.attempt.status).toBe('cancelled');
    expect(snapshot.run?.cancel_reason).toBe('duplicate-m1');
    expect(snapshot.result).toBeNull();
    expect(snapshot.events).toEqual(['cancel']);
    expect(
      snapshot.answers.map((row) => [row.question_id, row.option_id]),
    ).toEqual([answer]);
  }
});

test('migration leaves neighbours unchanged and restores constraints', async () => {
  const neighbours = await existingAttemptIds();
  expect(neighbours.length).toBeGreaterThan(0);
  const guestId = randomUUID();
  const otherGuestId = randomUUID();
  const base = new Date(Date.now() - 1_800_000);
  // No duplicates: another guest, another exam and a completed attempt of
  // the same exam next to one active attempt.
  const own = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: pilot.versionId,
    createdAt: at(base, 0),
    answers: { 'hoeren-1': 'a' },
  });
  const otherGuest = legacy({
    id: randomUUID(),
    sessionId: otherGuestId,
    versionId: pilot.versionId,
    createdAt: at(base, 5),
  });
  const otherExam = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: full.versionId,
    createdAt: at(base, 10),
    answers: { 'lesen-2': 'b' },
  });
  const done = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: pilot.versionId,
    createdAt: at(base, 20),
    status: 'completed',
    answers: { 'hoeren-2': 'c' },
    result: { score: 0, maxScore: 4, correct: 0, incorrect: 1, skipped: 3 },
  });
  const legacyRows = [own, otherGuest, otherExam, done];
  const legacyIds = legacyRows.map((row) => row.id);

  const summary = runScenario<{
    neighboursBefore: Snapshots;
    legacyBefore: Snapshots;
    firstFill: BackfillCount;
    firstCancel: number;
    afterFirst: Snapshots;
    secondFill: BackfillCount;
    secondCancel: number;
    afterSecond: Snapshots;
    neighboursAfter: Snapshots;
  }>([
    guestSql(guestId),
    guestSql(otherGuestId),
    ...legacyRows.map(legacyAttemptSql),
    keep('neighboursBefore', snapshotOf(neighbours)),
    keep('legacyBefore', snapshotOf(legacyIds)),
    backfill('firstFill'),
    cancel('firstCancel'),
    keep('afterFirst', snapshotOf(legacyIds)),
    backfill('secondFill'),
    cancel('secondCancel'),
    keep('afterSecond', snapshotOf(legacyIds)),
    keep('neighboursAfter', snapshotOf(neighbours)),
    RESTORE_M2_CONSTRAINTS,
  ]);

  expect(Object.keys(summary.neighboursBefore).sort()).toEqual(
    [...neighbours].sort(),
  );
  expect(summary.neighboursAfter).toEqual(summary.neighboursBefore);
  expect(summary.firstFill).toEqual({ filled_exams: 4, created_runs: 4 });
  expect(summary.firstCancel).toBe(0);
  expect(summary.secondFill).toEqual({ filled_exams: 0, created_runs: 0 });
  expect(summary.secondCancel).toBe(0);
  for (const id of legacyIds) {
    const before = pick(summary.legacyBefore, id);
    const after = pick(summary.afterFirst, id);
    expect(withoutTransfer(after)).toEqual(withoutTransfer(before));
    expect(after.run?.cancel_reason).toBeNull();
  }
  expect(pick(summary.afterFirst, otherExam.id).attempt.exam_id).toBe(
    full.examId,
  );
  expect(pick(summary.afterFirst, otherGuest.id).attempt.exam_id).toBe(
    pilot.examId,
  );
  expect(summary.afterSecond).toEqual(summary.afterFirst);
});

test('scoped legacy backfill of unknown attempt is empty without side effects', async () => {
  const neighbours = await existingAttemptIds();
  const firstGuest = randomUUID();
  const secondGuest = randomUUID();
  const base = new Date(Date.now() - 900_000);
  const target = legacy({
    id: randomUUID(),
    sessionId: firstGuest,
    versionId: pilot.versionId,
    createdAt: at(base, 0),
    answers: { 'hoeren-1': 'b' },
  });
  const untouched = legacy({
    id: randomUUID(),
    sessionId: secondGuest,
    versionId: full.versionId,
    createdAt: at(base, 1),
  });
  const ids = [target.id, untouched.id, ...neighbours];

  const summary = runScenario<{
    before: Snapshots;
    unknown: BackfillCount;
    afterUnknown: Snapshots;
    scoped: BackfillCount;
    afterScoped: Snapshots;
    repeated: BackfillCount;
    afterRepeated: Snapshots;
  }>([
    guestSql(firstGuest),
    guestSql(secondGuest),
    legacyAttemptSql(target),
    legacyAttemptSql(untouched),
    keep('before', snapshotOf(ids)),
    backfill('unknown', randomUUID()),
    keep('afterUnknown', snapshotOf(ids)),
    backfill('scoped', target.id),
    keep('afterScoped', snapshotOf(ids)),
    backfill('repeated', target.id),
    keep('afterRepeated', snapshotOf(ids)),
  ]);

  expect(summary.unknown).toEqual({ filled_exams: 0, created_runs: 0 });
  expect(summary.afterUnknown).toEqual(summary.before);

  expect(summary.scoped).toEqual({ filled_exams: 1, created_runs: 1 });
  const transferred = pick(summary.afterScoped, target.id);
  expect(transferred.attempt.exam_id).toBe(pilot.examId);
  expect(transferred.run?.assignment).toEqual({
    versionId: pilot.versionId,
    questionIds: pilot.questionIds,
  });
  expect(withoutTransfer(transferred)).toEqual(
    withoutTransfer(pick(summary.before, target.id)),
  );
  // Only the named attempt was transferred.
  expect(pick(summary.afterScoped, untouched.id)).toEqual(
    pick(summary.before, untouched.id),
  );
  for (const id of neighbours) {
    expect(pick(summary.afterScoped, id)).toEqual(pick(summary.before, id));
  }

  expect(summary.repeated).toEqual({ filled_exams: 0, created_runs: 0 });
  expect(summary.afterRepeated).toEqual(summary.afterScoped);
});

// The classification of the submission migration -----------------------------------

const MIGRATIONS = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
);

// The executable statement of the migration itself, not a copy: a comment
// or a missing call fails here.
const classificationOfMigration = (): string => {
  const [file, ...others] = readdirSync(MIGRATIONS).filter((name) =>
    name.endsWith('_m2_submission.sql'),
  );
  expect(file).toBeDefined();
  expect(others).toEqual([]);
  const text = readFileSync(path.join(MIGRATIONS, file ?? ''), 'utf8');
  const statements =
    text.match(/^select m2_private\.mark_legacy_completed\(\);$/gm) ?? [];
  expect(statements).toHaveLength(1);
  return statements[0] ?? '';
};

interface MarkedSnapshot extends Snapshot {
  run: Snapshot['run'] & { legacy_completed: boolean; frozen_answers: unknown };
}

test('submission migration classifies historical completed rows idempotently', async () => {
  const classification = classificationOfMigration();
  const guestId = randomUUID();
  const otherGuest = randomUUID();
  const base = new Date(Date.now() - 7_200_000);
  // M1: no exam_id and no run until the transfer.
  const m1 = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: full.versionId,
    createdAt: at(base, 0),
    status: 'completed',
    answers: { 'hoeren-1': 'b', 'lesen-1': 'a' },
    result: { score: 1, maxScore: 45, correct: 1, incorrect: 1, skipped: 43 },
  });
  // The old finish of #39: started with exam_id and a run, completed with a
  // result before the snapshot existed.
  const oldFinish: HistoricalCompletion = {
    id: randomUUID(),
    sessionId: otherGuest,
    examId: pilot.examId,
    versionId: pilot.versionId,
    scope: 'short-set',
    createdAt: at(base, 10),
    completedAt: at(base, 600),
    answers: { 'hoeren-1': 'a' },
    result: {
      score: 0,
      maxScore: pilot.questionIds.length,
      correct: 0,
      incorrect: 1,
      skipped: pilot.questionIds.length - 1,
    },
  };
  const active = legacy({
    id: randomUUID(),
    sessionId: guestId,
    versionId: pilot.versionId,
    createdAt: at(base, 20),
    answers: { 'hoeren-1': 'c' },
  });
  const cancelled = legacy({
    id: randomUUID(),
    sessionId: otherGuest,
    versionId: full.versionId,
    createdAt: at(base, 30),
  });
  const ids = [m1.id, oldFinish.id, active.id, cancelled.id];

  const summary = runScenario<{
    before: Record<string, MarkedSnapshot>;
    first: Record<string, MarkedSnapshot>;
    second: Record<string, MarkedSnapshot>;
  }>([
    guestSql(guestId),
    guestSql(otherGuest),
    legacyAttemptSql(m1),
    legacyAttemptSql(active),
    legacyAttemptSql(cancelled),
    'select * from m2_private.backfill_m1_attempts();',
    `update public.attempts set status = 'cancelled'
      where id = ${quote(cancelled.id)};`,
    RESTORE_M2_CONSTRAINTS,
    historicalCompletionSql(oldFinish),
    keep('before', snapshotOf(ids)),
    classification,
    keep('first', snapshotOf(ids)),
    classification,
    keep('second', snapshotOf(ids)),
  ]);

  const classified = [m1.id, oldFinish.id];
  for (const id of ids) {
    const before = summary.before[id];
    const first = summary.first[id];
    if (!before?.run || !first?.run) throw new Error(`no run of ${id}`);
    expect(before.run.legacy_completed, id).toBe(false);
    expect(before.run.frozen_answers, id).toBeNull();
    expect(first.run.legacy_completed, id).toBe(classified.includes(id));
    // Only the mark changes: attempt, answers, result, its timestamps and
    // the events stay as they were.
    expect({
      ...first,
      run: { ...first.run, legacy_completed: before.run.legacy_completed },
    }).toEqual(before);
  }
  expect(pick(summary.before, m1.id).result).not.toBeNull();
  expect(pick(summary.before, oldFinish.id).events).toEqual([
    'start',
    'finish',
  ]);
  // Repeating the operation changes nothing.
  expect(summary.second).toEqual(summary.first);
});
