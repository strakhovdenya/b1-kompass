import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SYNTHETIC_TRACK_ID, buildSyntheticPilot } from '@b1k/domain';
import { publishExamVersion } from '../../../../scripts/lib/publish-exam-version';
import type { AudioFileInput } from '../../../../scripts/lib/publish-exam-version';
import {
  confirmTimingProfileRevision,
  createTimingProfileRevision,
} from '../../../../scripts/manage-timing-profile';
import type {
  SqlRunner,
  TimingRevision,
  TimingSettings,
} from '../../../../scripts/manage-timing-profile';

// A test-only full DTZ set (20 Hören, 25 Lesen) with made-up text and key,
// published next to the pilot short set and served by its own e2e server
// (PRACTICE_EXAM_SLUG), so that attempts there get the full-exam scope.
export const FULL_EXAM = {
  slug: 'test-full-dtz',
  title: 'Test — DTZ Hören und Lesen',
  format: 'DTZ',
} as const;

export const FULL_TRACK_ID = SYNTHETIC_TRACK_ID;

export const FULL_PILOT = buildSyntheticPilot();

export const fullKeyOf = (questionId: string): string => {
  const key = FULL_PILOT.keys[questionId];
  if (key === undefined) throw new Error(`no key for ${questionId}`);
  return key;
};

// An option of the task other than its key: a wrong answer.
export const fullWrongOf = (questionId: string): string => {
  const question = FULL_PILOT.content.questions.find(
    (item) => item.id === questionId,
  );
  const key = fullKeyOf(questionId);
  const wrong = question?.options.find((option) => option.id !== key);
  if (!wrong) throw new Error(`no wrong option for ${questionId}`);
  return wrong.id;
};

// The trusted timing profile of the test set in the isolated test database.
// The preliminary pilot values serve only as test data here: the real pilot
// stays unconfirmed until the owner confirms it. The synthetic recording of
// global-setup lasts 60 seconds.
export const FULL_TIMING: TimingSettings = {
  recordingSeconds: 60,
  hoerenSeconds: 1500,
  transitionSeconds: 60,
  lesenSeconds: 2700,
};

// A short profile in seconds for SQL deadline tests (#43, #45). It is used
// only on an exam of its own (unique slug, version and recording), never on
// test-full-dtz.
export const SHORT_TIMING: TimingSettings = {
  recordingSeconds: 60,
  hoerenSeconds: 4,
  transitionSeconds: 2,
  lesenSeconds: 6,
};

// Test-only setup through the owner tool: the same settings as the current
// head change nothing, so a repeated setup creates no revision; otherwise a
// new draft is confirmed with the fingerprint the database computed.
export const ensureConfirmedTestProfile = (
  run: SqlRunner,
  versionId: string,
  settings: TimingSettings,
): TimingRevision => {
  const drafted = createTimingProfileRevision(run, { versionId }, settings);
  if (drafted.revision.status === 'confirmed') return drafted.revision;
  const confirmed = confirmTimingProfileRevision(run, {
    revisionId: drafted.revision.revisionId,
    fingerprint: drafted.revision.fingerprint,
  });
  return confirmed.revision;
};

export interface PublishedFullExam {
  slug: string;
  title: string;
}

// A full DTZ set (20 Hören, 25 Lesen) under a slug of its own, published
// through the trusted owner path. Specs of a shared database look only at
// their own slugs. `pilot` may replace the synthetic material (for a later,
// incomplete version of the same slug).
export const publishUniqueFullExam = async (
  db: SupabaseClient,
  audio: Omit<AudioFileInput, 'trackId'>,
  title: string,
  slug: string = `test-lib-${randomUUID().slice(0, 8)}`,
  pilot: Pick<typeof FULL_PILOT, 'content' | 'keys'> = FULL_PILOT,
): Promise<PublishedFullExam> => {
  await publishExamVersion(db, {
    slug,
    title,
    format: 'DTZ',
    content: pilot.content,
    keys: pilot.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...audio }],
  });
  return { slug, title };
};

// The synthetic set cut to its Hören tasks: a short set of the same exam.
export const shortOf = (
  pilot: typeof FULL_PILOT,
): Pick<typeof FULL_PILOT, 'content' | 'keys'> => {
  const questions = pilot.content.questions.filter(
    (question) => question.skill === 'hoeren',
  );
  const keys = Object.fromEntries(
    questions.map((question) => [question.id, pilot.keys[question.id] ?? '']),
  );
  return { content: { ...pilot.content, questions }, keys };
};

export type FullMaterial = Pick<typeof FULL_PILOT, 'content' | 'keys'>;

export interface MaterialChange {
  // Appended to the prompt of every task: text only this material has.
  marker: string;
  // One task leaves and another, with an id of its own, takes its place:
  // the set keeps its 20 Hören and 25 Lesen tasks.
  replace: { from: string; to: string };
  // The task whose key becomes its first other option (fullWrongOf).
  rekey?: string;
}

// A changed copy of a full set: another exam, or a later version of the same
// one. Counts, parts, groups and texts stay, so the copy is a full DTZ too.
export const variantOf = (
  pilot: FullMaterial,
  { marker, replace, rekey }: MaterialChange,
): FullMaterial => {
  const rename = (id: string): string =>
    id === replace.from ? replace.to : id;
  const questions = pilot.content.questions.map((question) => ({
    ...question,
    id: rename(question.id),
    prompt: `${question.prompt} ${marker}`,
  }));
  const groups = pilot.content.groups?.map((group) => ({
    ...group,
    questionIds: group.questionIds.map(rename),
  }));
  const keys = Object.fromEntries(
    Object.entries(pilot.keys).map(([id, key]) => [rename(id), key]),
  );
  if (rekey !== undefined) {
    const other = questions
      .find((question) => question.id === rekey)
      ?.options.find((option) => option.id !== keys[rekey]);
    if (!other) throw new Error(`no other option for ${rekey}`);
    keys[rekey] = other.id;
  }
  return {
    content: { ...pilot.content, questions, ...(groups ? { groups } : {}) },
    keys,
  };
};

// The next version of an exam that publishUniqueFullExam published: the
// owner path with the intent of a new version. Returns the id of the version,
// which must be a new one.
export const publishNextFullVersion = async (
  db: SupabaseClient,
  audio: Omit<AudioFileInput, 'trackId'>,
  exam: PublishedFullExam,
  pilot: FullMaterial,
): Promise<string> => {
  const outcome = await publishExamVersion(db, {
    slug: exam.slug,
    title: exam.title,
    format: 'DTZ',
    intent: 'new-version',
    content: pilot.content,
    keys: pilot.keys,
    audio: [{ trackId: FULL_TRACK_ID, ...audio }],
  });
  if (!outcome.isNew) throw new Error(`${exam.slug} got no new version`);
  return outcome.versionId;
};

// Two independent full DTZ exams A and B of one test (#85). B is the
// synthetic set; A is a changed copy with one task and a marker only it has,
// so material of one exam is recognised in an answer about the other. Each
// has a recording of its own, hence its own object and signed address, and a
// confirmed timing profile for the timed modes.
export const PAIR_REPLACED = 'lesen-25';
export const PAIR_A_ONLY = 'lesen-25-a';
export const PAIR_A_MARKER = '(Satz A)';

export const PAIR_MATERIAL_A: FullMaterial = variantOf(FULL_PILOT, {
  marker: PAIR_A_MARKER,
  replace: { from: PAIR_REPLACED, to: PAIR_A_ONLY },
});

export interface PairedExam extends PublishedFullExam {
  examId: string;
  versionId: string;
  questionIds: string[];
}

export interface ExamPair {
  examA: PairedExam;
  examB: PairedExam;
}

export interface PairSetup {
  db: SupabaseClient;
  // The owner SQL runner of the isolated test database.
  owner: SqlRunner;
  // Two different recordings: A and B never share an object.
  audioA: Omit<AudioFileInput, 'trackId'>;
  audioB: Omit<AudioFileInput, 'trackId'>;
  timing?: TimingSettings;
}

const publishPaired = async (
  setup: PairSetup,
  tag: string,
  label: 'a' | 'b',
): Promise<PairedExam> => {
  const material = label === 'a' ? PAIR_MATERIAL_A : FULL_PILOT;
  const slug = `test-sec-${tag}-${label}`;
  const title = `SEC ${tag} ${label.toUpperCase()} Übungstest`;
  const outcome = await publishExamVersion(setup.db, {
    slug,
    title,
    format: 'DTZ',
    intent: 'new-exam',
    content: material.content,
    keys: material.keys,
    audio: [
      {
        trackId: FULL_TRACK_ID,
        ...(label === 'a' ? setup.audioA : setup.audioB),
      },
    ],
  });
  if (!outcome.isNew) throw new Error(`${slug} was published before`);
  const exam = await setup.db
    .from('exams')
    .select('id')
    .eq('slug', slug)
    .single<{ id: string }>();
  if (exam.error) throw exam.error;
  ensureConfirmedTestProfile(
    setup.owner,
    outcome.versionId,
    setup.timing ?? FULL_TIMING,
  );
  return {
    slug,
    title,
    examId: exam.data.id,
    versionId: outcome.versionId,
    questionIds: material.content.questions.map((question) => question.id),
  };
};

export const publishExamPair = async (setup: PairSetup): Promise<ExamPair> => {
  const tag = randomUUID().slice(0, 8);
  const examA = await publishPaired(setup, tag, 'a');
  const examB = await publishPaired(setup, tag, 'b');
  return { examA, examB };
};
