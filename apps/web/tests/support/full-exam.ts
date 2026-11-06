import { SYNTHETIC_TRACK_ID, buildSyntheticPilot } from '@b1k/domain';
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
