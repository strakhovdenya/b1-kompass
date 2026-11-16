import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  Browser,
  BrowserContext,
  Locator,
  Page,
  Route,
} from '@playwright/test';
import { examContentSchema, selectScoringPolicy } from '@b1k/domain';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { AudioFileInput } from '../../../scripts/lib/publish-exam-version';
import { publishFullPilot } from '../../../scripts/publish-pilot';
import { saveAnswer } from '../src/server/attempts/attempts';
import { preflightTimedStart } from '../src/server/attempts/start';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import {
  replaceGuestSession,
  setGuestLocale,
} from '../src/server/guest-session/session';
import type { CreatedGuest } from '../src/server/guest-session/session';
import { getPublishedVersion } from '../src/server/material/published';
import {
  FULL_EXAM,
  FULL_PILOT,
  FULL_TIMING,
  FULL_TRACK_ID,
  PAIR_A_ONLY,
  PAIR_REPLACED,
  fullKeyOf,
  fullWrongOf,
  publishExamPair,
} from './support/full-exam';
import type { PairedExam } from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  depsNow,
  latestVersionOf,
  newGuest,
  audioObjectPathOf,
  readAnswers,
  readAttemptPin,
  readAttempts,
  readEventKinds,
  readResults,
  readRunRows,
  readSession,
  serviceDb,
  shortGuest,
  startBody,
  startFor,
  submitStored,
} from './support/db';
import { TEST_GUEST_SESSIONS_PER_MINUTE } from './support/env';
import {
  examAttemptOwners,
  examRunTimes,
  guestRows,
  installM2Fixtures,
  psql,
  quote,
  secondsAgoSql,
  settledGuestRowsOf,
  sqlRunnerAs,
} from './support/sql';
import { goToStep } from './support/release';
import {
  ANSWER_URL,
  CHOICE_URL,
  HOEREN_URL,
  FULL_ORIGIN,
  LESEN_URL,
  attemptIdOf,
  attemptUrl,
  audioOf,
  card,
  confirmationOf,
  expectStatus,
  finishFromShell,
  goToHoeren,
  goToLesen,
  optionIn,
  pausePlayer,
  postCommand,
  playFrom,
  screenOf,
  seekTo,
  snapshotOf,
  sourcePathOf,
  startBrowserGuest,
  untilGuestExpired,
  waitForPlayer,
} from './support/guest-browser';
import type {
  BrowserGuest,
  MediaSnapshot,
  ScreenSnapshot,
} from './support/guest-browser';

// Four guests of the synthetic full set at the same time, each in its own
// browser context with its own cookie. They share the one recording of the
// version and nothing else: answers, results and players stay their own.
// Server state is re-read from the test database after every step.

const AUDIO_BUCKET = 'exam-sources';
const GUESTS = 4;
const TOLERANCE_SECONDS = 0.75;
const PAUSED_TOLERANCE_SECONDS = 0.05;

const { questions } = FULL_PILOT.content;
const { keys } = FULL_PILOT;

test.describe.configure({ timeout: 180_000 });

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

interface TrackRow {
  track_id: string;
  object_path: string;
  sha256: string;
}

const versionOf = async (attemptId: string): Promise<string> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('exam_version_id')
    .eq('id', attemptId)
    .single<{ exam_version_id: string }>();
  if (error) throw error;
  return data.exam_version_id;
};

const tracksOf = async (versionId: string): Promise<TrackRow[]> => {
  const { data, error } = await serviceDb
    .from('exam_version_audio')
    .select('track_id, object_path, sha256')
    .eq('exam_version_id', versionId)
    .returns<TrackRow[]>();
  if (error) throw error;
  return data;
};

// Objects of the bucket with the given file name in the audio folder.
const objectsNamed = async (name: string): Promise<string[]> => {
  const { data, error } = await serviceDb.storage
    .from(AUDIO_BUCKET)
    .list('audio', { search: name, limit: 100 });
  if (error) throw error;
  return data.map((object) => object.name).filter((found) => found === name);
};

const fileNameOf = (objectPath: string): string =>
  objectPath.slice(objectPath.lastIndexOf('/') + 1);

const scoreOf = (selections: Record<string, string>): number => {
  const policy = selectScoringPolicy('DTZ', 'full-exam');
  if (!policy) throw new Error('policy is missing');
  return policy.score({ questions, keys, selections }).score;
};

// Contexts and held requests of the running test, released after it even
// when an assertion fails, so that no playing guest outlives its test.
const opened: BrowserGuest[] = [];
const extraContexts: BrowserContext[] = [];
const cleanups: (() => void)[] = [];

test.afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  const guests = opened.splice(0);
  await Promise.all([
    ...guests.map((guest) => guest.context.close()),
    ...extraContexts.splice(0).map((context) => context.close()),
  ]);
});

const startGuests = async (browser: Browser): Promise<BrowserGuest[]> => {
  const guests = await Promise.all(
    Array.from({ length: GUESTS }, () => startBrowserGuest(browser)),
  );
  opened.push(...guests);
  return guests;
};

type Skill = 'hoeren' | 'lesen';

// Answers one task of the current block and waits for the server to confirm.
const answer = async (
  page: Page,
  skill: Skill,
  number: number,
  optionId: string,
) => {
  await page.getByTestId(`go-to-question-${number}`).click();
  const target = card(page, `${skill}-${number}`);
  await expect(target).toBeVisible();
  await optionIn(target, optionId).check();
  await expectStatus(target, 'saved');
};

interface GuestPlan {
  startSeconds: number;
  hoeren: Record<number, string>;
  lesen: Record<number, string>;
}

// Different positions and different answers for every guest; the keys of the
// synthetic set make the four scores differ (1, 2, 3 and 0 points). The test
// recording lasts 60 s, so every start leaves it most of that time to run.
const PLANS: readonly GuestPlan[] = [
  { startSeconds: 2, hoeren: { 1: 'b' }, lesen: { 1: 'b' } },
  { startSeconds: 7, hoeren: { 1: 'b', 2: 'b' }, lesen: { 2: 'c' } },
  { startSeconds: 12, hoeren: { 1: 'b', 5: 'c' }, lesen: { 1: 'a' } },
  { startSeconds: 17, hoeren: { 1: 'a', 6: 'a' }, lesen: { 3: 'b' } },
];

// The starts are 5 s apart and all four play at once, so the actual
// positions keep their order and every two of them stay seconds apart.
const MIN_GAP_SECONDS = 2;

const expectDistinctPositions = (snapshots: readonly MediaSnapshot[]) => {
  const positions = snapshots.map((snapshot) => snapshot.currentTime);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  for (const [i, first] of positions.entries()) {
    for (const second of positions.slice(i + 1)) {
      expect(Math.abs(second - first)).toBeGreaterThanOrEqual(MIN_GAP_SECONDS);
    }
  }
};

const expectedAnswers = (plan: GuestPlan): Record<string, string> => {
  const entries = [
    ...Object.entries(plan.hoeren).map(([n, o]) => [`hoeren-${n}`, o]),
    ...Object.entries(plan.lesen).map(([n, o]) => [`lesen-${n}`, o]),
  ];
  return Object.fromEntries(entries);
};

test('four isolated guests share audio object and retain independent state', async ({
  browser,
}) => {
  const guests = await startGuests(browser);

  // Four cookies, four sessions, four attempts of one version.
  const tokens = new Set(guests.map((guest) => guest.token));
  const sessions = new Set(guests.map((guest) => guest.sessionId));
  const attempts = new Set(guests.map((guest) => guest.attemptId));
  expect([tokens.size, sessions.size, attempts.size]).toEqual([4, 4, 4]);
  const versions = await Promise.all(
    guests.map((guest) => versionOf(guest.attemptId)),
  );
  const versionId = versions[0];
  if (!versionId) throw new Error('version is missing');
  expect(new Set(versions)).toEqual(new Set([versionId]));

  const tracks = await tracksOf(versionId);
  const track = tracks[0];
  if (tracks.length !== 1 || !track) throw new Error('one track expected');
  expect(track.track_id).toBe(FULL_TRACK_ID);
  expect(track.sha256).toBe(sha256Of(createTestRecording().bytes));
  const fileName = fileNameOf(track.object_path);
  expect(await objectsNamed(fileName)).toEqual([fileName]);

  // Every player reads that one object, each started at its own second.
  await Promise.all(guests.map((guest) => waitForPlayer(guest.page)));
  const paths = await Promise.all(
    guests.map((guest) => sourcePathOf(guest.page)),
  );
  for (const sourcePath of paths) {
    expect(sourcePath).toContain(`/${AUDIO_BUCKET}/${track.object_path}`);
  }
  expect(new Set(paths).size).toBe(1);
  await Promise.all(
    guests.map((guest, index) =>
      playFrom(guest.page, PLANS[index]?.startSeconds ?? 0, `guest-${index}`),
    ),
  );
  const playing = await Promise.all(
    guests.map((guest) => snapshotOf(guest.page)),
  );
  playing.forEach((snapshot, index) => {
    const start = PLANS[index]?.startSeconds ?? 0;
    expect(snapshot).toMatchObject({
      paused: false,
      marker: `guest-${index}`,
    });
    expect(snapshot.currentTime).toBeGreaterThan(start);
    expect(snapshot.currentTime).toBeLessThan(start + 8);
  });
  expectDistinctPositions(playing);

  // Each guest answers on its own, in Hören and in Lesen, while all play.
  await Promise.all(
    guests.map(async (guest, index) => {
      const plan = PLANS[index];
      if (!plan) throw new Error('plan is missing');
      for (const [number, optionId] of Object.entries(plan.hoeren)) {
        await answer(guest.page, 'hoeren', Number(number), optionId);
      }
      await goToLesen(guest.page);
      for (const [number, optionId] of Object.entries(plan.lesen)) {
        await answer(guest.page, 'lesen', Number(number), optionId);
      }
    }),
  );
  // Lesen paused every recording where its guest left Hören; the places stay
  // apart and nothing moves any more.
  const pausedOnLesen = await Promise.all(
    guests.map((guest) => snapshotOf(guest.page)),
  );
  pausedOnLesen.forEach((snapshot, index) => {
    expect(snapshot).toMatchObject({
      paused: true,
      marker: `guest-${index}`,
    });
    expect(snapshot.currentTime).toBeGreaterThan(
      playing[index]?.currentTime ?? 0,
    );
  });
  expectDistinctPositions(pausedOnLesen);
  const settled = await Promise.all(
    guests.map((guest) => snapshotOf(guest.page)),
  );
  settled.forEach((snapshot, index) => {
    expect(snapshot.currentTime).toBe(pausedOnLesen[index]?.currentTime);
  });

  for (const [index, guest] of guests.entries()) {
    const plan = PLANS[index];
    if (!plan) throw new Error('plan is missing');
    expect(await readAnswers(guest.attemptId)).toEqual(expectedAnswers(plan));
  }

  // All four finish at once; every result is computed from its own answers.
  await Promise.all(guests.map((guest) => finishFromShell(guest.page)));
  const scores: number[] = [];
  for (const [index, guest] of guests.entries()) {
    const plan = PLANS[index];
    if (!plan) throw new Error('plan is missing');
    const answers = await readAnswers(guest.attemptId);
    expect(answers).toEqual(expectedAnswers(plan));
    const results = (await readResults(guest.attemptId)) as {
      score: number;
      max_score: number;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      score: scoreOf(answers),
      max_score: 45,
    });
    scores.push(results[0]?.score ?? -1);
    const stored = await readAttempts(guest.sessionId);
    expect(stored).toEqual([{ id: guest.attemptId, status: 'completed' }]);
  }
  expect(scores).toEqual([1, 2, 3, 0]);

  // One object for the version, however many guests listened.
  expect(await tracksOf(versionId)).toEqual(tracks);
  expect(await objectsNamed(fileName)).toEqual([fileName]);
});

// Actions of one guest against three others --------------------------------

interface ObservedGuest {
  guest: BrowserGuest;
  isPlaying: boolean;
  screen: ScreenSnapshot;
  media: MediaSnapshot;
  answers: Record<string, string>;
}

const observe = async (
  guest: BrowserGuest,
  isPlaying: boolean,
): Promise<ObservedGuest> => ({
  guest,
  isPlaying,
  screen: await screenOf(guest.page),
  media: await snapshotOf(guest.page),
  answers: await readAnswers(guest.attemptId),
});

// The other guests keep their screen, answers, attempt and player: a running
// player has moved on by the browser time that passed, a paused one has not
// moved at all, and neither element was replaced.
const expectUntouched = async (
  observed: readonly ObservedGuest[],
): Promise<ObservedGuest[]> => {
  const next: ObservedGuest[] = [];
  for (const before of observed) {
    const after = await observe(before.guest, before.isPlaying);
    expect(after.screen).toEqual(before.screen);
    expect(after.answers).toEqual(before.answers);
    expect(await readAttempts(before.guest.sessionId)).toEqual([
      { id: before.guest.attemptId, status: 'active' },
    ]);
    expect(after.media.marker).toBe(before.media.marker);
    expect(after.media.isConnected).toBe(true);
    expect(after.media.paused).toBe(!before.isPlaying);
    const elapsed = after.media.nowSeconds - before.media.nowSeconds;
    const expected = before.isPlaying
      ? before.media.currentTime + elapsed
      : before.media.currentTime;
    const tolerance = before.isPlaying
      ? TOLERANCE_SECONDS
      : PAUSED_TOLERANCE_SECONDS;
    expect(Math.abs(after.media.currentTime - expected)).toBeLessThanOrEqual(
      tolerance,
    );
    next.push(after);
  }
  return next;
};

test('one guest actions never reset three others', async ({ browser }) => {
  const guests = await startGuests(browser);
  const [actor, ...others] = guests;
  if (!actor || others.length !== 3) throw new Error('four guests expected');
  await Promise.all(guests.map((guest) => waitForPlayer(guest.page)));

  // Distinct answers, positions and player states before the first action.
  const choices = ['a', 'b', 'c', 'b'];
  await Promise.all(
    guests.map((guest, index) =>
      answer(guest.page, 'hoeren', index + 1, choices[index] ?? 'a'),
    ),
  );
  await playFrom(actor.page, 20, 'actor');
  const states = [
    { at: 2, isPlaying: true },
    { at: 30, isPlaying: false },
    { at: 5, isPlaying: true },
  ];
  await Promise.all(
    others.map(async (guest, index) => {
      const state = states[index];
      if (!state) throw new Error('state is missing');
      await playFrom(guest.page, state.at, `other-${index}`);
      if (!state.isPlaying) await pausePlayer(guest.page);
    }),
  );
  let observed = await Promise.all(
    others.map((guest, index) =>
      observe(guest, states[index]?.isPlaying ?? false),
    ),
  );
  expect(observed.map((item) => Object.keys(item.answers))).toEqual([
    ['hoeren-2'],
    ['hoeren-3'],
    ['hoeren-4'],
  ]);

  // 1. Language.
  await actor.page.getByTestId('locale-ru').click();
  await expect(actor.page.locator('html')).toHaveAttribute('lang', 'ru');
  observed = await expectUntouched(observed);

  // 2. Seek.
  await seekTo(actor.page, 45);
  await expect
    .poll(async () => (await snapshotOf(actor.page)).currentTime)
    .toBeGreaterThanOrEqual(45);
  observed = await expectUntouched(observed);

  // 3. Refresh.
  await actor.page.reload();
  await expect(card(actor.page, 'hoeren-1')).toBeVisible();
  await expect(optionIn(card(actor.page, 'hoeren-1'), 'a')).toBeChecked();
  await expect(actor.page.locator('html')).toHaveAttribute('lang', 'ru');
  observed = await expectUntouched(observed);

  // 4. Finish and start a new run: "start again" opens the choice without
  // creating anything; the new run exists only after the explicit start.
  await finishFromShell(actor.page);
  await actor.page.getByTestId('restart-attempt').click();
  await actor.page.waitForURL(CHOICE_URL);
  await expect(actor.page.getByTestId('mode-selection')).toBeVisible();
  expect(await readAttempts(actor.sessionId)).toEqual([
    { id: actor.attemptId, status: 'completed' },
  ]);
  await actor.page.getByTestId('start-attempt').click();
  await actor.page.waitForURL(HOEREN_URL);
  await expect(actor.page.getByTestId('attempt-review')).toBeHidden();
  await expect(actor.page.getByTestId('finish-attempt')).toBeVisible();
  const actorAttempts = await readAttempts(actor.sessionId);
  expect(actorAttempts).toHaveLength(2);
  const fresh = actorAttempts.find((row) => row.status === 'active');
  if (!fresh) throw new Error('new attempt is missing');
  expect(await readAnswers(fresh.id)).toEqual({});
  expect(await readAnswers(actor.attemptId)).toEqual({ 'hoeren-1': 'a' });
  expect(await readResults(actor.attemptId)).toHaveLength(1);
  await expectUntouched(observed);
});

// Material of the published test set ---------------------------------------

test('published test set retains all assessed questions and resource links', async () => {
  const published = await getPublishedVersion(depsNow(), FULL_EXAM.slug);
  if (!published) throw new Error('test set is not published');
  const { versionId } = published;

  const version = await serviceDb
    .from('exam_versions')
    .select('content')
    .eq('id', versionId)
    .single<{ content: unknown }>();
  if (version.error) throw version.error;
  const content = examContentSchema.parse(version.data.content);
  const hoeren = content.questions.filter((q) => q.skill === 'hoeren');
  const lesen = content.questions.filter((q) => q.skill === 'lesen');
  expect(hoeren).toHaveLength(20);
  expect(lesen).toHaveLength(25);
  expect(hoeren.map((q) => q.number)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  expect(lesen.map((q) => q.number)).toEqual(
    Array.from({ length: 25 }, (_, i) => i + 1),
  );

  // One key row for every assessed question, none for anything else, and
  // every key is one of the options of its question.
  const stored = await serviceDb
    .from('answer_keys')
    .select('question_id, correct_option_id')
    .eq('exam_version_id', versionId)
    .returns<{ question_id: string; correct_option_id: string }[]>();
  if (stored.error) throw stored.error;
  const keyRows = new Map(
    stored.data.map((row) => [row.question_id, row.correct_option_id]),
  );
  expect(stored.data).toHaveLength(45);
  expect([...keyRows.keys()].toSorted()).toEqual(
    content.questions.map((q) => q.id).toSorted(),
  );
  for (const question of content.questions) {
    const key = keyRows.get(question.id);
    expect(question.options.map((option) => option.id)).toContain(key);
  }
  for (const example of content.examples ?? []) {
    expect(keyRows.has(example.id)).toBe(false);
  }

  // Every Hören question points to a track of this version, and the object
  // of that track exists in Storage with the stored hash.
  const tracks = await tracksOf(versionId);
  const trackIds = new Set(tracks.map((track) => track.track_id));
  for (const question of hoeren) {
    expect(question.trackId).toBeDefined();
    expect(trackIds.has(question.trackId ?? '')).toBe(true);
  }
  for (const track of tracks) {
    const download = await serviceDb.storage
      .from(AUDIO_BUCKET)
      .download(track.object_path);
    if (download.error) throw download.error;
    const bytes = new Uint8Array(await download.data.arrayBuffer());
    expect(sha256Of(bytes)).toBe(track.sha256);
  }
});

// A rejected set leaves nothing behind -------------------------------------

let counter = 0;
const uniqueExam = () => ({
  slug: `test-integrity-${Date.now().toString(36)}-${counter++}`,
  title: 'Integrity test',
  format: 'DTZ',
});

// A recording no other test uploads: the tone with a random tail.
const uniqueRecording = (): AudioFileInput => {
  const recording = createTestRecording();
  const bytes = new Uint8Array(recording.bytes);
  bytes.set(randomBytes(16), bytes.length - 16);
  return { trackId: FULL_TRACK_ID, contentType: 'audio/wav', bytes };
};

const objectPathOf = (recording: AudioFileInput): string =>
  `audio/${sha256Of(recording.bytes)}.wav`;

interface SetState {
  exams: number;
  versions: number;
  keys: number;
  tracks: number;
  objects: string[];
}

// Everything a publication of the slug could have written, with the object
// of the recording it was offered, if any.
const stateOf = async (
  slug: string,
  objectPath: string | null,
): Promise<SetState> => {
  const exams = await serviceDb.from('exams').select('id').eq('slug', slug);
  if (exams.error) throw exams.error;
  const versions = await serviceDb
    .from('exam_versions')
    .select('id, exams!inner(slug)')
    .eq('exams.slug', slug)
    .returns<{ id: string }[]>();
  if (versions.error) throw versions.error;
  const versionIds = versions.data.map((row) => row.id);
  const countOf = async (table: string): Promise<number> => {
    if (versionIds.length === 0) return 0;
    const { count, error } = await serviceDb
      .from(table)
      .select('*', { count: 'exact', head: true })
      .in('exam_version_id', versionIds);
    if (error) throw error;
    return count ?? 0;
  };
  return {
    exams: exams.data.length,
    versions: versionIds.length,
    keys: await countOf('answer_keys'),
    tracks: await countOf('exam_version_audio'),
    objects: objectPath ? await objectsNamed(fileNameOf(objectPath)) : [],
  };
};

const NOTHING: SetState = {
  exams: 0,
  versions: 0,
  keys: 0,
  tracks: 0,
  objects: [],
};

const withoutKey = (questionId: string): Record<string, string> =>
  Object.fromEntries(Object.entries(keys).filter(([id]) => id !== questionId));

test('pilot integrity fails on missing key or resource', async () => {
  const { content } = FULL_PILOT;

  // Owner path, missing key: refused before any upload.
  {
    const exam = uniqueExam();
    const recording = uniqueRecording();
    await expect(
      publishFullPilot(serviceDb, {
        exam,
        content,
        keys: withoutKey('hoeren-7'),
        audio: { contentType: 'audio/wav', bytes: recording.bytes },
      }),
    ).rejects.toThrow(/missing-key:hoeren-7/);
    expect(await stateOf(exam.slug, objectPathOf(recording))).toEqual(NOTHING);
    expect(await getPublishedVersion(depsNow(), exam.slug)).toBeNull();
  }

  // Owner path, missing recording: the only file offered belongs to another
  // track, so the Hören questions point nowhere and nothing is uploaded.
  {
    const exam = uniqueExam();
    const recording = { ...uniqueRecording(), trackId: 'other-track' };
    await expect(
      publishExamVersion(serviceDb, {
        ...exam,
        content,
        keys,
        audio: [recording],
      }),
    ).rejects.toThrow(/broken-reference:hoeren-1/);
    expect(await stateOf(exam.slug, objectPathOf(recording))).toEqual(NOTHING);
    expect(await getPublishedVersion(depsNow(), exam.slug)).toBeNull();
  }

  // Database function, missing key: the integrity check of the transaction.
  // The function uploads nothing, so only rows can be left behind.
  {
    const exam = uniqueExam();
    const { data, error } = await serviceDb.rpc('publish_exam_version', {
      p_slug: exam.slug,
      p_title: exam.title,
      p_format: exam.format,
      p_content: content,
      p_keys: withoutKey('lesen-25'),
      p_audio: [],
    });
    expect(data).toBeNull();
    expect(error?.hint).toBe('material_invalid');
    expect(error?.message).toContain('lesen-25');
    expect(await stateOf(exam.slug, null)).toEqual(NOTHING);
  }

  // Database function, a track whose object was never uploaded.
  {
    const exam = uniqueExam();
    const recording = uniqueRecording();
    const objectPath = objectPathOf(recording);
    const { data, error } = await serviceDb.rpc('publish_exam_version', {
      p_slug: exam.slug,
      p_title: exam.title,
      p_format: exam.format,
      p_content: content,
      p_keys: keys,
      p_audio: [
        {
          trackId: FULL_TRACK_ID,
          kind: 'file',
          objectPath,
          contentType: 'audio/wav',
          sha256: sha256Of(recording.bytes),
        },
      ],
    });
    expect(data).toBeNull();
    expect(error?.hint).toBe('material_invalid');
    expect(error?.message).toContain(FULL_TRACK_ID);
    expect(await stateOf(exam.slug, objectPath)).toEqual(NOTHING);
    expect(await getPublishedVersion(depsNow(), exam.slug)).toBeNull();
  }
});

// A delayed listener --------------------------------------------------------

const signal = () => {
  let resolve = () => undefined as void;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { done, resolve: () => resolve() };
};

test('one delayed listener does not block others', async ({ browser }) => {
  const guests = await startGuests(browser);
  const [delayed, ...others] = guests;
  if (!delayed || others.length !== 3) throw new Error('four guests expected');
  await Promise.all(guests.map((guest) => waitForPlayer(guest.page)));
  await Promise.all(
    guests.map((guest, index) => playFrom(guest.page, 5 + index * 5, 'on')),
  );

  // The save of the first guest is held before it reaches the server.
  const release = signal();
  const arrived = signal();
  cleanups.push(release.resolve);
  await delayed.context.route(ANSWER_URL, async (route: Route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    const isSave = body.includes('"questionId":"hoeren-1"');
    if (request.method() !== 'POST' || !isSave) {
      return route.continue();
    }
    arrived.resolve();
    await release.done;
    return route.continue();
  });
  const held = card(delayed.page, 'hoeren-1');
  await optionIn(held, 'b').check();
  await arrived.done;
  await expectStatus(held, 'saving');

  // The others answer and finish while that request is still on hold.
  await Promise.all(
    others.map(async (guest) => {
      const target = card(guest.page, 'hoeren-1');
      await optionIn(target, 'b').check();
      await expectStatus(target, 'saved');
      await goToLesen(guest.page);
      await answer(guest.page, 'lesen', 1, 'a');
      await goToHoeren(guest.page);
      await finishFromShell(guest.page);
    }),
  );
  for (const guest of others) {
    expect(await readAnswers(guest.attemptId)).toEqual({
      'hoeren-1': 'b',
      'lesen-1': 'a',
    });
    const results = (await readResults(guest.attemptId)) as {
      score: number;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(2);
    expect(await readAttempts(guest.sessionId)).toEqual([
      { id: guest.attemptId, status: 'completed' },
    ]);
  }
  await expectStatus(held, 'saving');
  expect(await readAnswers(delayed.attemptId)).toEqual({});
  expect(await readResults(delayed.attemptId)).toEqual([]);
  expect((await snapshotOf(delayed.page)).paused).toBe(false);

  // Released, the held save is confirmed for its own attempt only.
  release.resolve();
  await expectStatus(held, 'saved');
  expect(await readAnswers(delayed.attemptId)).toEqual({ 'hoeren-1': 'b' });
  expect(await readAttempts(delayed.sessionId)).toEqual([
    { id: delayed.attemptId, status: 'active' },
  ]);
});

// Four modes at once (#48) --------------------------------------------------
//
// One published synthetic full DTZ set, four guests in four browser contexts:
// the free training (A), a timed Hören block (B), the full exam (C) and the
// repeat of the own errors (D). B and C are started at an explicit earlier
// moment through the test-only admission wrappers, so that the end of their
// time is a matter of seconds; everything the guests do afterwards goes
// through the real pages and routes. After each phase the rows of every guest
// are re-read from the test database.

const SECOND_MS = 1000;
const H = FULL_TIMING.hoerenSeconds;
const ALL_IDS = questions.map((question) => question.id);
const HOEREN_IDS = questions
  .filter((question) => question.id.startsWith('hoeren-'))
  .map((question) => question.id);

type Plan = Readonly<Record<string, 'right' | 'wrong' | 'skip'>>;

// The source of the repeat: errors in a Teil 3 pair, the Teil 4 shared set
// and a Lesen text; every other task right.
const REPEAT_PLAN: Plan = {
  'hoeren-10': 'wrong',
  'hoeren-18': 'skip',
  'lesen-12': 'wrong',
};
const REPEAT_IDS = ['hoeren-10', 'hoeren-18', 'lesen-12'];

const contextWith = async (
  browser: Browser,
  token: string,
): Promise<BrowserContext> => {
  const context = await browser.newContext({
    baseURL: FULL_ORIGIN,
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([
    { name: GUEST_COOKIE, value: token, url: FULL_ORIGIN },
  ]);
  return context;
};

// A run started through the admission kernel at the given moment: the time of
// the run is judged from that moment, never from the browser.
const startAt = (
  created: CreatedGuest,
  exam: { examId: string; versionId: string },
  run: { mode: string; selection: string; ids: readonly string[] },
  secondsAgo: number,
): string =>
  psql(`select attempt_id from m2_test.start_attempt_at(
    ${quote(created.guest.sessionId)}, ${quote(exam.examId)}, gen_random_uuid(),
    ${quote(run.mode)}, 'normal', ${quote(run.selection)}, null,
    ${quote(exam.versionId)},
    ${quote(run.selection === 'all' ? 'full-exam' : 'short-set')},
    ${quote(JSON.stringify(run.ids))}::jsonb, ${secondsAgoSql(secondsAgo)})`);

const answerDirect = async (
  created: CreatedGuest,
  attemptId: string,
  ids: readonly string[],
  plan: Plan,
) => {
  for (const id of ids) {
    const kind = plan[id] ?? 'right';
    if (kind === 'skip') continue;
    const saved = await saveAnswer(depsNow(), created.token, {
      attemptId,
      questionId: id,
      optionId: kind === 'right' ? fullKeyOf(id) : fullWrongOf(id),
      revision: 1,
    });
    if (!saved.ok) throw new Error(`answer ${id}: ${saved.error}`);
  }
};

const deadlineOf = async (page: Page): Promise<number> =>
  Number(
    await page.getByTestId('attempt-timer').getAttribute('data-deadline-ms'),
  );

const attemptsOf = async (guest: CreatedGuest) =>
  (await readAttempts(guest.guest.sessionId)).toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );

interface ResultRow {
  score: number;
  max_score: number;
}

test('four modes keep independent guests answers results and media', async ({
  browser,
  request,
}) => {
  installM2Fixtures();
  const latest = await latestVersionOf(FULL_EXAM.slug);
  if (!latest) throw new Error('full exam is not published');
  const exam = latest;

  const [a, b, c, d] = await Promise.all(
    Array.from({ length: GUESTS }, () => newGuest(depsNow())),
  );
  if (!a || !b || !c || !d) throw new Error('four guests expected');
  const created = [a, b, c, d];
  expect(new Set(created.map((guest) => guest.token)).size).toBe(4);
  expect(new Set(created.map((guest) => guest.guest.sessionId)).size).toBe(4);
  await setGuestLocale(depsNow(), b.guest, 'ru');
  await setGuestLocale(depsNow(), d.guest, 'ru');
  const locales = async () =>
    Promise.all(
      created.map(
        async (guest) => (await readSession(guest.guest.sessionId)).locale,
      ),
    );
  expect(await locales()).toEqual(['en', 'ru', 'en', 'ru']);

  // D: a completed source of its own, repeated from its review.
  const sourceId = await startFor(depsNow(), d.token, FULL_EXAM.slug).then(
    (started) => {
      if (!started.ok || started.result.outcome !== 'accepted') {
        throw new Error('the source was not started');
      }
      return started.result.attemptId;
    },
  );
  await answerDirect(d, sourceId, ALL_IDS, REPEAT_PLAN);
  const finished = await submitStored(depsNow(), d.token, {
    attemptId: sourceId,
  });
  if (!finished.ok) throw new Error(`source: ${finished.error}`);

  const contexts = await Promise.all(
    created.map((guest) => contextWith(browser, guest.token)),
  );
  extraContexts.push(...contexts);
  const [aContext, bContext, cContext, dContext] = contexts;
  if (!aContext || !bContext || !cContext || !dContext) {
    throw new Error('four contexts expected');
  }
  const aPage = await aContext.newPage();
  const bPage = await bContext.newPage();
  const cPage = await cContext.newPage();
  const dPage = await dContext.newPage();

  // A: the free training by its explicit start, the recording playing.
  await aPage.goto(`/practice/${FULL_EXAM.slug}`);
  await aPage.getByTestId('start-attempt').click();
  await aPage.waitForURL(HOEREN_URL);
  const aAttempt = attemptIdOf(aPage);
  await waitForPlayer(aPage);
  await answer(aPage, 'hoeren', 1, fullKeyOf('hoeren-1'));
  await expect(aPage.getByTestId('attempt-timer')).toHaveCount(0);

  // D: its review, then the repeat of its own errors on its pinned version.
  await dPage.goto(attemptUrl(FULL_EXAM.slug, sourceId));
  await expect(dPage.getByTestId('attempt-review')).toBeVisible();
  await dPage.getByTestId('repeat-errors').click();
  await expect
    .poll(() => new URL(dPage.url()).pathname)
    .not.toContain(sourceId);
  await dPage.waitForURL(HOEREN_URL);
  const dRepeat = attemptIdOf(dPage);
  expect(dRepeat).not.toBe(sourceId);
  const [repeatRun] = await readRunRows(dRepeat);
  expect(repeatRun).toMatchObject({
    purpose: 'error-repeat',
    source_attempt_id: sourceId,
    assignment: { versionId: exam.versionId, questionIds: REPEAT_IDS },
  });
  // A fresh load of the repeat: the page of the review, still in the document
  // of the client navigation, carries keys by design; the repeat must not.
  await dPage.goto(attemptUrl(FULL_EXAM.slug, dRepeat));
  const neighbour = dPage.getByTestId('context-card-hoeren-11');
  await expect(neighbour).toBeVisible();
  await expect(neighbour.locator('input')).toHaveCount(0);
  await expect(dPage.getByTestId('review-solution')).toHaveCount(0);
  expect(await dPage.content()).not.toContain('correctOptionId');
  await expect(dPage.getByTestId('attempt-timer')).toHaveCount(0);

  // B: a timed Hören block with forty seconds left. C: a full exam whose
  // Hören ends in forty seconds. They are placed last, right before their
  // pages open, so the slow steps of the other guests do not use their time.
  const LEFT_SECONDS = 40;
  const bAttempt = startAt(
    b,
    exam,
    { mode: 'timed-block', selection: 'hoeren', ids: HOEREN_IDS },
    H - LEFT_SECONDS,
  );
  const cAttempt = startAt(
    c,
    exam,
    { mode: 'exam', selection: 'all', ids: ALL_IDS },
    H - LEFT_SECONDS,
  );
  const bRun = examRunTimes(bAttempt);
  const cRun = examRunTimes(cAttempt);

  // B and C: their own server deadlines, from their own start.
  await bPage.goto(attemptUrl(FULL_EXAM.slug, bAttempt));
  await cPage.goto(attemptUrl(FULL_EXAM.slug, cAttempt));
  const bDeadline = await deadlineOf(bPage);
  const cDeadline = await deadlineOf(cPage);
  expect(bDeadline).toBe(Date.parse(bRun.acceptedAt) + H * SECOND_MS);
  expect(cDeadline).toBe(Date.parse(cRun.acceptedAt) + H * SECOND_MS);
  await answer(bPage, 'hoeren', 2, fullKeyOf('hoeren-2'));
  await answer(cPage, 'hoeren', 3, fullKeyOf('hoeren-3'));

  // Audio controls and navigation do not move the deadline of B.
  await waitForPlayer(bPage);
  await playFrom(bPage, 5, 'guest-b');
  await seekTo(bPage, 40);
  await pausePlayer(bPage);
  await bPage.getByTestId('go-to-question-1').click();
  expect(await deadlineOf(bPage)).toBe(bDeadline);

  // Four guests, four attempts, their own answers and the database proof.
  // A's recording plays from here on, so that it is still running (the test
  // recording lasts 60 seconds) when the other guests' time ends.
  await playFrom(aPage, 3, 'guest-a');
  const aSnap = await snapshotOf(aPage);
  expect(aSnap).toMatchObject({ paused: false, marker: 'guest-a' });
  expect(await readAnswers(aAttempt)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
  });
  expect(await readAnswers(bAttempt)).toEqual({
    'hoeren-2': fullKeyOf('hoeren-2'),
  });
  expect(await readAnswers(cAttempt)).toEqual({
    'hoeren-3': fullKeyOf('hoeren-3'),
  });
  expect(await readAnswers(dRepeat)).toEqual({});
  expect(new Set([aAttempt, bAttempt, cAttempt, dRepeat, sourceId]).size).toBe(
    5,
  );
  expect((await attemptsOf(a)).map((row) => row.id)).toEqual([aAttempt]);
  expect((await attemptsOf(b)).map((row) => row.id)).toEqual([bAttempt]);
  expect((await attemptsOf(c)).map((row) => row.id)).toEqual([cAttempt]);
  expect((await attemptsOf(d)).map((row) => row.id).toSorted()).toEqual(
    [sourceId, dRepeat].toSorted(),
  );
  for (const [attemptId, mode] of [
    [aAttempt, 'training'],
    [bAttempt, 'timed-block'],
    [cAttempt, 'exam'],
    [dRepeat, 'training'],
  ] as const) {
    expect((await readRunRows(attemptId))[0]?.mode, attemptId).toBe(mode);
  }

  // B's time ends: its own page says so, the server closed its run with the
  // answer that came before the deadline; nobody else is touched.
  const expired = bPage.getByTestId('timed-expired');
  await expect(expired).toBeVisible({ timeout: 90_000 });
  expect(await readAttempts(b.guest.sessionId)).toEqual([
    { id: bAttempt, status: 'completed' },
  ]);
  const bResults = (await readResults(bAttempt)) as ResultRow[];
  expect(bResults).toHaveLength(1);
  expect(bResults[0]).toMatchObject({ score: 1, max_score: 20 });
  expect(await readAnswers(bAttempt)).toEqual({
    'hoeren-2': fullKeyOf('hoeren-2'),
  });
  const late = await postCommand(
    request,
    `/api/attempts/${bAttempt}/answer`,
    {
      questionId: 'hoeren-4',
      optionId: fullKeyOf('hoeren-4'),
      revision: 1,
    },
    { token: b.token },
  );
  expect(late.status).toBe(404);
  expect(await readAnswers(bAttempt)).toEqual({
    'hoeren-2': fullKeyOf('hoeren-2'),
  });
  expect(await readAttempts(a.guest.sessionId)).toEqual([
    { id: aAttempt, status: 'active' },
  ]);
  expect(await readResults(aAttempt)).toEqual([]);
  expect(await readResults(cAttempt)).toEqual([]);
  expect(await readResults(dRepeat)).toEqual([]);

  // C's Hören is closed by the server: the transition, the frozen Hören
  // answer, and a late save of a Hören task is refused.
  await expect(cPage.getByTestId('transition-screen')).toBeVisible({
    timeout: 90_000,
  });
  const frozen = await readAnswers(cAttempt);
  expect(frozen).toEqual({ 'hoeren-3': fullKeyOf('hoeren-3') });
  const lateC = await postCommand(
    request,
    `/api/attempts/${cAttempt}/answer`,
    {
      questionId: 'hoeren-5',
      optionId: fullKeyOf('hoeren-5'),
      revision: 1,
    },
    { token: c.token },
  );
  expect(lateC.status).toBe(404);
  expect(await readAnswers(cAttempt)).toEqual(frozen);

  // The other two guests still hold what they had: A plays on by the clock
  // of its browser, D's tasks and context are in place.
  const aLater = await snapshotOf(aPage);
  expect(aLater).toMatchObject({ paused: false, marker: 'guest-a' });
  const elapsed = aLater.nowSeconds - aSnap.nowSeconds;
  expect(
    Math.abs(aLater.currentTime - (aSnap.currentTime + elapsed)),
  ).toBeLessThanOrEqual(TOLERANCE_SECONDS);
  await expect(card(aPage, 'hoeren-1')).toBeVisible();
  await expect(neighbour).toBeVisible();
  expect(await readAnswers(aAttempt)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
  });

  // A changes its language: no other guest's language moves.
  await aPage.getByTestId('locale-ru').click();
  await expect(aPage.locator('html')).toHaveAttribute('lang', 'ru');
  expect(await locales()).toEqual(['ru', 'ru', 'en', 'ru']);
  await expect(cPage.locator('html')).toHaveAttribute('lang', 'en');

  // C: Lesen begins at its own request, the answer there is its own, and
  // the exam is finished once.
  await cPage.getByTestId('begin-lesen').click();
  await cPage.waitForURL(LESEN_URL);
  await answer(cPage, 'lesen', 1, fullKeyOf('lesen-1'));
  await finishFromShell(cPage);
  const cSelections = {
    'hoeren-3': fullKeyOf('hoeren-3'),
    'lesen-1': fullKeyOf('lesen-1'),
  };
  expect(await readAnswers(cAttempt)).toEqual(cSelections);
  const cResults = (await readResults(cAttempt)) as ResultRow[];
  expect(cResults).toHaveLength(1);
  expect(cResults[0]).toMatchObject({
    score: scoreOf(cSelections),
    max_score: 45,
  });
  expect(await readAttempts(c.guest.sessionId)).toEqual([
    { id: cAttempt, status: 'completed' },
  ]);

  // A finishes with its one answer; D answers its three tasks and finishes.
  await finishFromShell(aPage);
  const aSelections = { 'hoeren-1': fullKeyOf('hoeren-1') };
  const aResults = (await readResults(aAttempt)) as ResultRow[];
  expect(aResults).toHaveLength(1);
  expect(aResults[0]).toMatchObject({
    score: scoreOf(aSelections),
    max_score: 45,
  });
  await expect(card(dPage, 'hoeren-10')).toBeVisible();
  await optionIn(card(dPage, 'hoeren-10'), fullKeyOf('hoeren-10')).check();
  await expectStatus(card(dPage, 'hoeren-10'), 'saved');
  await goToStep(dPage, 18);
  await optionIn(card(dPage, 'hoeren-18'), fullKeyOf('hoeren-18')).check();
  await expectStatus(card(dPage, 'hoeren-18'), 'saved');
  await goToLesen(dPage);
  await optionIn(card(dPage, 'lesen-12'), fullKeyOf('lesen-12')).check();
  await expectStatus(card(dPage, 'lesen-12'), 'saved');
  // Every assigned task is answered: no confirmation of skipped tasks.
  await dPage.getByTestId('finish-attempt').click();
  await expect(dPage.getByTestId('attempt-review')).toBeVisible();
  await expect(dPage.getByTestId('finish-confirm')).toHaveCount(0);
  expect(await readAnswers(dRepeat)).toEqual({
    'hoeren-10': fullKeyOf('hoeren-10'),
    'hoeren-18': fullKeyOf('hoeren-18'),
    'lesen-12': fullKeyOf('lesen-12'),
  });
  const dResults = (await readResults(dRepeat)) as ResultRow[];
  expect(dResults).toHaveLength(1);
  expect(dResults[0]).toMatchObject({ score: 3, max_score: 3 });
  expect(await readResults(sourceId)).toHaveLength(1);

  // The end: every guest has exactly its own results and events.
  const expectedEvents: [string, string[]][] = [
    [aAttempt, ['start', 'finish']],
    [bAttempt, ['start', 'finish']],
    [cAttempt, ['start', 'finish']],
    [dRepeat, ['start', 'finish']],
    [sourceId, ['start', 'finish']],
  ];
  for (const [attemptId, kinds] of expectedEvents) {
    expect(await readEventKinds(attemptId), attemptId).toEqual(kinds);
  }
  expect(await locales()).toEqual(['ru', 'ru', 'en', 'ru']);
  expect(await readAttempts(b.guest.sessionId)).toEqual([
    { id: bAttempt, status: 'completed' },
  ]);
});

// Lifecycle of one guest against two live ones (#48) --------------------------

const examAudioOf = (page: Page) => page.getByTestId('exam-audio-element');

interface ExamMedia {
  currentTime: number;
  nowSeconds: number;
  paused: boolean;
  marker: string | null;
}

const examMediaOf = (page: Page): Promise<ExamMedia> =>
  examAudioOf(page).evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    nowSeconds: performance.now() / 1000,
    paused: element.paused,
    marker: element.dataset.marker ?? null,
  }));

test('guest lifecycle mutations cannot affect other live sessions', async ({
  browser,
}) => {
  const [live, paused, actor] = await Promise.all(
    Array.from({ length: 3 }, () => newGuest(depsNow())),
  );
  if (!live || !paused || !actor) throw new Error('three guests expected');
  const [liveContext, pausedContext, actorContext] = await Promise.all(
    [live, paused, actor].map((guest) => contextWith(browser, guest.token)),
  );
  if (!liveContext || !pausedContext || !actorContext) {
    throw new Error('three contexts expected');
  }
  extraContexts.push(liveContext, pausedContext, actorContext);
  const livePage = await liveContext.newPage();
  const pausedPage = await pausedContext.newPage();
  const actorPage = await actorContext.newPage();

  // The first observer: a full exam whose recording is playing.
  await livePage.goto(`/practice/${FULL_EXAM.slug}`);
  await livePage.getByTestId('mode-option-exam').click();
  await expect(livePage.getByTestId('exam-audio-status')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 20_000 },
  );
  await livePage.getByTestId('start-attempt').click();
  await livePage.waitForURL(HOEREN_URL);
  const liveAttempt = attemptIdOf(livePage);
  await expect
    .poll(async () => (await examMediaOf(livePage)).paused)
    .toBe(false);
  await examAudioOf(livePage).evaluate((element: HTMLAudioElement) => {
    element.dataset.marker = 'live-exam';
  });
  await answer(livePage, 'hoeren', 1, fullKeyOf('hoeren-1'));

  // The second observer: a timed block with its recording paused.
  await pausedPage.goto(`/practice/${FULL_EXAM.slug}`);
  await pausedPage.getByTestId('mode-option-timed-block').click();
  await pausedPage.getByTestId('start-attempt').click();
  await pausedPage.waitForURL(HOEREN_URL);
  const pausedAttempt = attemptIdOf(pausedPage);
  await waitForPlayer(pausedPage);
  await playFrom(pausedPage, 12, 'paused-block');
  await pausePlayer(pausedPage);
  await answer(pausedPage, 'hoeren', 2, fullKeyOf('hoeren-2'));

  const liveDeadline = await deadlineOf(livePage);
  const pausedDeadline = await deadlineOf(pausedPage);
  expect(liveDeadline).toBe(
    Date.parse(examRunTimes(liveAttempt).acceptedAt) + H * SECOND_MS,
  );
  expect(pausedDeadline).toBe(
    Date.parse(examRunTimes(pausedAttempt).acceptedAt) + H * SECOND_MS,
  );
  const liveBefore = await examMediaOf(livePage);
  const pausedBefore = await snapshotOf(pausedPage);
  expect(pausedBefore).toMatchObject({ paused: true, marker: 'paused-block' });

  // The observers keep answers, status, deadline and media, the playing one
  // by the browser clock that passed, the paused one exactly.
  const expectObserversUntouched = async (step: string) => {
    expect(await readAnswers(liveAttempt), step).toEqual({
      'hoeren-1': fullKeyOf('hoeren-1'),
    });
    expect(await readAnswers(pausedAttempt), step).toEqual({
      'hoeren-2': fullKeyOf('hoeren-2'),
    });
    expect(await readAttempts(live.guest.sessionId), step).toEqual([
      { id: liveAttempt, status: 'active' },
    ]);
    expect(await readAttempts(paused.guest.sessionId), step).toEqual([
      { id: pausedAttempt, status: 'active' },
    ]);
    expect(await readResults(liveAttempt), step).toEqual([]);
    expect(await readResults(pausedAttempt), step).toEqual([]);
    expect(await deadlineOf(livePage), step).toBe(liveDeadline);
    expect(await deadlineOf(pausedPage), step).toBe(pausedDeadline);
    const liveNow = await examMediaOf(livePage);
    expect(liveNow.paused, step).toBe(false);
    expect(liveNow.marker, step).toBe('live-exam');
    const elapsed = liveNow.nowSeconds - liveBefore.nowSeconds;
    expect(
      Math.abs(liveNow.currentTime - (liveBefore.currentTime + elapsed)),
      step,
    ).toBeLessThanOrEqual(1);
    const pausedNow = await snapshotOf(pausedPage);
    expect(pausedNow.paused, step).toBe(true);
    expect(pausedNow.marker, step).toBe('paused-block');
    expect(
      Math.abs(pausedNow.currentTime - pausedBefore.currentTime),
      step,
    ).toBeLessThanOrEqual(PAUSED_TOLERANCE_SECONDS);
    expect(await locales(), step).toEqual(['en', 'en', actorLocale]);
  };
  let actorLocale = 'en';
  const locales = () =>
    Promise.all(
      [live, paused, actor].map(
        async (guest) => (await readSession(guest.guest.sessionId)).locale,
      ),
    );
  await expectObserversUntouched('before');

  // The actor: starts, errs, finishes, repeats its error, changes language
  // and cancels the repeat.
  await actorPage.goto(`/practice/${FULL_EXAM.slug}`);
  await actorPage.getByTestId('start-attempt').click();
  await actorPage.waitForURL(HOEREN_URL);
  const source = attemptIdOf(actorPage);
  await answer(actorPage, 'hoeren', 1, fullWrongOf('hoeren-1'));
  await expectObserversUntouched('actor started');

  await finishFromShell(actorPage);
  expect(await readResults(source)).toHaveLength(1);
  await expectObserversUntouched('actor finished');

  await actorPage.getByTestId('repeat-errors').click();
  await expect
    .poll(() => new URL(actorPage.url()).pathname)
    .not.toContain(source);
  await actorPage.waitForURL(HOEREN_URL);
  const repeat = attemptIdOf(actorPage);
  expect((await readRunRows(repeat))[0]).toMatchObject({
    purpose: 'error-repeat',
    source_attempt_id: source,
  });
  await expectObserversUntouched('actor repeated');

  await actorPage.getByTestId('locale-ru').click();
  await expect(actorPage.locator('html')).toHaveAttribute('lang', 'ru');
  actorLocale = 'ru';
  await expectObserversUntouched('actor language');

  await actorPage.getByTestId('cancel-attempt').click();
  await actorPage.getByTestId('cancel-confirm').click();
  await expect
    .poll(
      async () =>
        (await readAttempts(actor.guest.sessionId)).find(
          (row) => row.id === repeat,
        )?.status,
    )
    .toBe('cancelled');
  expect(await readResults(repeat)).toEqual([]);
  await expectObserversUntouched('actor cancelled');

  // The observers are still live: they can answer and finish on their own.
  await answer(pausedPage, 'hoeren', 3, fullKeyOf('hoeren-3'));
  expect(await readAnswers(pausedAttempt)).toEqual({
    'hoeren-2': fullKeyOf('hoeren-2'),
    'hoeren-3': fullKeyOf('hoeren-3'),
  });
});

// Four guests on two exams (#85) ----------------------------------------------
//
// Exam A and exam B are published by each test under slugs of its own, with
// different recordings. Two guests work on each exam, all four in different
// modes and at the same time. Every claim about a guest is a re-read of the
// whole rows of its session; the three others are compared with what they
// held before the step.

type PairMode = 'training' | 'exam' | 'timed-block';

const publishPairWith = (toneA: number, toneB: number) =>
  publishExamPair({
    db: serviceDb,
    owner: sqlRunnerAs('owner'),
    audioA: createTestRecording(toneA),
    audioB: createTestRecording(toneB),
  });

// The explicit start of one mode from the choice screen of an exam.
const startModeAt = async (
  page: Page,
  exam: PairedExam,
  mode: PairMode,
): Promise<string> => {
  await page.goto(`/practice/${exam.slug}`);
  await expect(page.getByTestId('mode-selection')).toBeVisible();
  if (mode !== 'training') {
    await page.getByTestId(`mode-option-${mode}`).click();
  }
  if (mode === 'exam') {
    await expect(page.getByTestId('exam-audio-status')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 20_000 },
    );
  }
  await page.getByTestId('start-attempt').click();
  await page.waitForURL(HOEREN_URL);
  return attemptIdOf(page);
};

const storedPositionOf = async (attemptId: string): Promise<number> =>
  Number((await readAttemptPin(attemptId)).progress?.positionSeconds ?? -1);

// A paused player moved to a second: the move of a paused player is reported
// at once, so the server holds that place.
const restAt = async (page: Page, attemptId: string, seconds: number) => {
  await seekTo(page, seconds);
  await expect
    .poll(async () => Math.abs((await storedPositionOf(attemptId)) - seconds))
    .toBeLessThanOrEqual(1);
};

const ownersOf = (examIds: readonly string[]): Set<string> =>
  new Set(
    examAttemptOwners(examIds).map(
      (owner) => `${owner.examId} ${owner.sessionId} ${owner.attempts}`,
    ),
  );

interface ClockedMedia extends ExamMedia {
  ended: boolean;
  duration: number;
}

const clockedMediaOf = (audio: Locator): Promise<ClockedMedia> =>
  audio.evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime,
    nowSeconds: performance.now() / 1000,
    paused: element.paused,
    marker: element.dataset.marker ?? null,
    ended: element.ended,
    duration: element.duration,
  }));

// A playing recording runs by the clock of its browser from where it was,
// until its end (the test recording lasts 60 seconds, and the steps of the
// other guests take time). Around
// the end either state is right; before it the recording plays at the place
// the clock gives, after it the recording has ended at its full length.
const END_MARGIN_SECONDS = 2;

const expectRecordingOnClock = (
  now: ClockedMedia,
  before: ExamMedia,
  step: string,
) => {
  expect(now.marker, step).toBe(before.marker);
  const expected = before.currentTime + now.nowSeconds - before.nowSeconds;
  if (expected < now.duration - END_MARGIN_SECONDS) {
    expect(now.paused, step).toBe(false);
    expect(Math.abs(now.currentTime - expected), step).toBeLessThanOrEqual(1);
    return;
  }
  expect(now.currentTime, step).toBeGreaterThan(
    now.duration - 2 * END_MARGIN_SECONDS,
  );
  if (expected > now.duration + END_MARGIN_SECONDS) {
    expect(now.ended, step).toBe(true);
  }
};

test('four guests keep two exams and media fully isolated', async ({
  browser,
}) => {
  const { examA, examB } = await publishPairWith(631, 641);
  const examIds = [examA.examId, examB.examId];
  const pathA = await audioObjectPathOf(examA.versionId);
  const pathB = await audioObjectPathOf(examB.versionId);
  expect(pathA).not.toBe(pathB);

  const created = await Promise.all(
    Array.from({ length: GUESTS }, () => newGuest(depsNow())),
  );
  const sessions = created.map((guest) => guest.guest.sessionId);
  expect(new Set(created.map((guest) => guest.token)).size).toBe(GUESTS);
  expect(new Set(sessions).size).toBe(GUESTS);
  const contexts = await Promise.all(
    created.map((guest) => contextWith(browser, guest.token)),
  );
  extraContexts.push(...contexts);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [p1, p2, p3, p4] = pages;
  if (!p1 || !p2 || !p3 || !p4) throw new Error('four pages expected');

  // Two guests per exam, four modes, started at the same time.
  const plan: [Page, PairedExam, PairMode][] = [
    [p1, examA, 'training'],
    [p2, examA, 'exam'],
    [p3, examB, 'timed-block'],
    [p4, examB, 'training'],
  ];
  const attempts = await Promise.all(
    plan.map(([page, exam, mode]) => startModeAt(page, exam, mode)),
  );
  const [a1, a2, a3, a4] = attempts;
  if (!a1 || !a2 || !a3 || !a4) throw new Error('four attempts expected');
  expect(new Set(attempts).size).toBe(GUESTS);

  // Each answers a task of its own while the others do the same.
  const answers: Record<string, string>[] = [
    { 'hoeren-1': fullKeyOf('hoeren-1') },
    { 'hoeren-2': fullWrongOf('hoeren-2') },
    { 'hoeren-3': fullKeyOf('hoeren-3') },
    { 'hoeren-1': fullWrongOf('hoeren-1') },
  ];
  await Promise.all([
    answer(p1, 'hoeren', 1, fullKeyOf('hoeren-1')),
    answer(p2, 'hoeren', 2, fullWrongOf('hoeren-2')),
    answer(p3, 'hoeren', 3, fullKeyOf('hoeren-3')),
    answer(p4, 'hoeren', 1, fullWrongOf('hoeren-1')),
  ]);

  // The recordings: A plays for its two guests, B for the other two, each
  // from the object of its own exam and at its own place.
  await Promise.all([waitForPlayer(p1), waitForPlayer(p3), waitForPlayer(p4)]);
  await expect.poll(async () => (await examMediaOf(p2)).paused).toBe(false);
  await examAudioOf(p2).evaluate((element: HTMLAudioElement) => {
    element.dataset.marker = 'guest-2';
  });
  const examSource = await examAudioOf(p2).evaluate(
    (element: HTMLAudioElement) => new URL(element.currentSrc).pathname,
  );
  expect(await sourcePathOf(p1)).toContain(`/${AUDIO_BUCKET}/${pathA}`);
  expect(examSource).toContain(`/${AUDIO_BUCKET}/${pathA}`);
  expect(await sourcePathOf(p3)).toContain(`/${AUDIO_BUCKET}/${pathB}`);
  expect(await sourcePathOf(p4)).toContain(`/${AUDIO_BUCKET}/${pathB}`);
  await playFrom(p1, 3, 'guest-1');
  await playFrom(p3, 12, 'guest-3');
  await pausePlayer(p3);
  await playFrom(p4, 25, 'guest-4');
  await pausePlayer(p4);
  await restAt(p4, a4, 31);
  const playing1 = await snapshotOf(p1);
  const playing2 = await examMediaOf(p2);
  const paused3 = await snapshotOf(p3);
  expect(playing1).toMatchObject({ paused: false, marker: 'guest-1' });
  expect(playing2).toMatchObject({ paused: false, marker: 'guest-2' });
  expect(paused3).toMatchObject({ paused: true, marker: 'guest-3' });

  // The database: one attempt each, of its own exam and pinned version, in
  // its own mode, with its own answer and its own start event.
  const modes = plan.map(([, , mode]) => mode);
  const exams = plan.map(([, exam]) => exam);
  for (const [index, attemptId] of attempts.entries()) {
    const exam = exams[index];
    const session = sessions[index];
    if (!exam || !session) throw new Error('plan is incomplete');
    const where = `guest ${index + 1}`;
    expect(await readAttempts(session), where).toEqual([
      { id: attemptId, status: 'active' },
    ]);
    expect(await readAttemptPin(attemptId), where).toMatchObject({
      exam_id: exam.examId,
      exam_version_id: exam.versionId,
      status: 'active',
    });
    const [run] = await readRunRows(attemptId);
    expect(run?.mode, where).toBe(modes[index]);
    expect(run?.assignment.versionId, where).toBe(exam.versionId);
    for (const questionId of run?.assignment.questionIds ?? []) {
      expect(exam.questionIds, where).toContain(questionId);
    }
    expect(await readAnswers(attemptId), where).toEqual(answers[index]);
    expect(await readEventKinds(attemptId), where).toEqual(['start']);
    expect(await readResults(attemptId), where).toEqual([]);
  }
  const owners = new Set(
    sessions.map(
      (session, index) => `${exams[index]?.examId ?? ''} ${session} 1`,
    ),
  );
  expect(ownersOf(examIds)).toEqual(owners);

  // After each step of one guest the three others hold what they held.
  let held = settledGuestRowsOf(sessions);
  const expectOthersKept = (actor: number, step: string) => {
    const now = settledGuestRowsOf(sessions);
    for (const [index, rows] of now.entries()) {
      if (index !== actor)
        expect(rows, `${step}: guest ${index + 1}`).toEqual(held[index]);
    }
    expect(now[actor], `${step}: the actor changed`).not.toEqual(held[actor]);
    held = now;
  };
  const deadline2 = await deadlineOf(p2);
  const deadline3 = await deadlineOf(p3);
  expect(deadline2).toBe(
    Date.parse(examRunTimes(a2).acceptedAt) + H * SECOND_MS,
  );
  expect(deadline3).toBe(
    Date.parse(examRunTimes(a3).acceptedAt) + H * SECOND_MS,
  );

  // Guest 4: the Lesen task only B has, then the end of its attempt.
  await goToLesen(p4);
  await p4.getByTestId('go-to-question-25').click();
  await optionIn(card(p4, PAIR_REPLACED), fullKeyOf(PAIR_REPLACED)).check();
  await expectStatus(card(p4, PAIR_REPLACED), 'saved');
  expectOthersKept(3, 'guest 4 answered Lesen');
  await finishFromShell(p4);
  expectOthersKept(3, 'guest 4 finished');
  const results4 = (await readResults(a4)) as ResultRow[];
  expect(results4).toHaveLength(1);
  expect(results4[0]).toMatchObject({ score: 1, max_score: 45 });

  // Guest 3 answers on; guest 2 answers in its exam.
  await answer(p3, 'hoeren', 4, fullKeyOf('hoeren-4'));
  expectOthersKept(2, 'guest 3 answered');
  await answer(p2, 'hoeren', 5, fullKeyOf('hoeren-5'));
  expectOthersKept(1, 'guest 2 answered');

  // The media of the three open guests: A's free player and the exam play on
  // by the clock of their browsers, B's paused player has not moved, and no
  // deadline did.
  expectRecordingOnClock(
    await clockedMediaOf(audioOf(p1)),
    playing1,
    'guest 1 plays on',
  );
  expectRecordingOnClock(
    await clockedMediaOf(examAudioOf(p2)),
    playing2,
    'guest 2 plays on',
  );
  const later3 = await snapshotOf(p3);
  expect(later3).toMatchObject({ paused: true, marker: 'guest-3' });
  expect(
    Math.abs(later3.currentTime - paused3.currentTime),
  ).toBeLessThanOrEqual(PAUSED_TOLERANCE_SECONDS);
  expect(await deadlineOf(p2)).toBe(deadline2);
  expect(await deadlineOf(p3)).toBe(deadline3);

  // Guest 1: its own place in the recording of A, the Lesen task only A
  // has, then the end of its attempt.
  await pausePlayer(p1);
  await restAt(p1, a1, 8);
  await goToLesen(p1);
  await p1.getByTestId('go-to-question-25').click();
  await optionIn(card(p1, PAIR_A_ONLY), fullKeyOf(PAIR_REPLACED)).check();
  await expectStatus(card(p1, PAIR_A_ONLY), 'saved');
  expectOthersKept(0, 'guest 1 answered Lesen');
  await finishFromShell(p1);
  expectOthersKept(0, 'guest 1 finished');
  const results1 = (await readResults(a1)) as ResultRow[];
  expect(results1).toHaveLength(1);
  expect(results1[0]).toMatchObject({ score: 2, max_score: 45 });

  // The end: answers, results and events are each guest's own.
  expect(await readAnswers(a1)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
    [PAIR_A_ONLY]: fullKeyOf(PAIR_REPLACED),
  });
  expect(await readAnswers(a2)).toEqual({
    'hoeren-2': fullWrongOf('hoeren-2'),
    'hoeren-5': fullKeyOf('hoeren-5'),
  });
  expect(await readAnswers(a3)).toEqual({
    'hoeren-3': fullKeyOf('hoeren-3'),
    'hoeren-4': fullKeyOf('hoeren-4'),
  });
  expect(await readAnswers(a4)).toEqual({
    'hoeren-1': fullWrongOf('hoeren-1'),
    [PAIR_REPLACED]: fullKeyOf(PAIR_REPLACED),
  });
  const finalEvents: [string, string[], string][] = [
    [a1, ['start', 'finish'], 'completed'],
    [a2, ['start'], 'active'],
    [a3, ['start'], 'active'],
    [a4, ['start', 'finish'], 'completed'],
  ];
  for (const [index, [attemptId, kinds, status]] of finalEvents.entries()) {
    const session = sessions[index];
    if (!session) throw new Error('session is missing');
    expect(await readEventKinds(attemptId), attemptId).toEqual(kinds);
    expect(await readAttempts(session), attemptId).toEqual([
      { id: attemptId, status },
    ]);
  }
  expect(await readResults(a2)).toEqual([]);
  expect(await readResults(a3)).toEqual([]);
  expect(ownersOf(examIds)).toEqual(owners);
});

// The term of the fourth guest: long enough for its start, cancel,
// completion and replacement on a slow runner, each followed by a re-read of
// the three observers. A guest that expires earlier fails its own steps.
const ACTOR_TERM_SECONDS = 90;
const LIFECYCLE_TIMEOUT_MS = 300_000;

test('one guest lifecycle change never affects others across exams', async ({
  browser,
  request,
}) => {
  // The test waits for the term of the fourth guest to end.
  test.setTimeout(LIFECYCLE_TIMEOUT_MS);
  installM2Fixtures();
  const { examA, examB } = await publishPairWith(643, 647);
  const examIds = [examA.examId, examB.examId];

  // Three observers: a full exam of A with its recording playing, a timed
  // block of B paused, a free training of A paused at a stored place.
  const observers = await Promise.all(
    Array.from({ length: 3 }, () => newGuest(depsNow())),
  );
  const sessions = observers.map((guest) => guest.guest.sessionId);
  const contexts = await Promise.all(
    observers.map((guest) => contextWith(browser, guest.token)),
  );
  extraContexts.push(...contexts);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [livePage, pausedPage, restingPage] = pages;
  if (!livePage || !pausedPage || !restingPage) {
    throw new Error('three pages expected');
  }
  const [liveAttempt, pausedAttempt, restingAttempt] = await Promise.all([
    startModeAt(livePage, examA, 'exam'),
    startModeAt(pausedPage, examB, 'timed-block'),
    startModeAt(restingPage, examA, 'training'),
  ]);
  await expect
    .poll(async () => (await examMediaOf(livePage)).paused)
    .toBe(false);
  await examAudioOf(livePage).evaluate((element: HTMLAudioElement) => {
    element.dataset.marker = 'live-exam';
  });
  await answer(livePage, 'hoeren', 1, fullKeyOf('hoeren-1'));
  await waitForPlayer(pausedPage);
  await playFrom(pausedPage, 12, 'paused-block');
  await pausePlayer(pausedPage);
  await answer(pausedPage, 'hoeren', 2, fullKeyOf('hoeren-2'));
  await waitForPlayer(restingPage);
  await playFrom(restingPage, 5, 'resting-training');
  await pausePlayer(restingPage);
  await restAt(restingPage, restingAttempt, 20);
  await answer(restingPage, 'hoeren', 3, fullKeyOf('hoeren-3'));

  const liveDeadline = await deadlineOf(livePage);
  const pausedDeadline = await deadlineOf(pausedPage);
  expect(liveDeadline).toBe(
    Date.parse(examRunTimes(liveAttempt).acceptedAt) + H * SECOND_MS,
  );
  expect(pausedDeadline).toBe(
    Date.parse(examRunTimes(pausedAttempt).acceptedAt) + H * SECOND_MS,
  );
  const liveBefore = await examMediaOf(livePage);
  const pausedBefore = await snapshotOf(pausedPage);
  const restingBefore = await snapshotOf(restingPage);
  expect(pausedBefore).toMatchObject({ paused: true, marker: 'paused-block' });
  expect(restingBefore).toMatchObject({
    paused: true,
    marker: 'resting-training',
  });
  const held = settledGuestRowsOf(sessions);
  const restingPlace = await storedPositionOf(restingAttempt);
  for (const rows of held) {
    expect(rows.attempts).toHaveLength(1);
    expect(rows.attempts[0]?.answers).toHaveLength(1);
    expect(rows.attempts[0]?.attempt.status).toBe('active');
  }
  const observerOwners = [
    `${examA.examId} ${sessions[0] ?? ''} 1`,
    `${examB.examId} ${sessions[1] ?? ''} 1`,
    `${examA.examId} ${sessions[2] ?? ''} 1`,
  ];

  const expectObserversUntouched = async (step: string) => {
    for (const [index, rows] of settledGuestRowsOf(sessions).entries()) {
      expect(rows, `${step}: observer ${index}`).toEqual(held[index]);
    }
    const owners = ownersOf(examIds);
    for (const owner of observerOwners) {
      expect(owners.has(owner), `${step}: ${owner}`).toBe(true);
    }
    expect(await storedPositionOf(restingAttempt), step).toBe(restingPlace);
    expect(await deadlineOf(livePage), step).toBe(liveDeadline);
    expect(await deadlineOf(pausedPage), step).toBe(pausedDeadline);
    expectRecordingOnClock(
      await clockedMediaOf(examAudioOf(livePage)),
      liveBefore,
      step,
    );
    for (const [page, before] of [
      [pausedPage, pausedBefore],
      [restingPage, restingBefore],
    ] as const) {
      const now = await snapshotOf(page);
      expect(now.paused, step).toBe(true);
      expect(now.marker, step).toBe(before.marker);
      expect(
        Math.abs(now.currentTime - before.currentTime),
        step,
      ).toBeLessThanOrEqual(PAUSED_TOLERANCE_SECONDS);
    }
  };
  await expectObserversUntouched('before');

  // The fourth guest: its term ends soon, by the database clock. It
  // works on both exams over real HTTP with the trusted Origin.
  const { token: actorToken, sessionId: actorSession } =
    shortGuest(ACTOR_TERM_SECONDS);
  const send = (pathname: string, body: unknown, token = actorToken) =>
    postCommand(request, pathname, body, { token });
  const startedBy = async (token: string, exam: PairedExam) => {
    const reply = await send(
      '/api/attempts/start',
      await startBody(exam.slug, { expectedVersionId: exam.versionId }),
      token,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ result: { outcome: 'accepted' } });
    return (reply.body.result as { attemptId: string }).attemptId;
  };
  const confirmed = (attemptId: string) =>
    confirmationOf(request, attemptId, { token: actorToken });

  // It starts A and answers, as the observers of A do.
  const cancelledId = await startedBy(actorToken, examA);
  const saved = await send(`/api/attempts/${cancelledId}/answer`, {
    questionId: 'hoeren-1',
    optionId: fullWrongOf('hoeren-1'),
    revision: 1,
  });
  expect(saved.status).toBe(200);
  await expectObserversUntouched('actor started A');

  // Cancel.
  const cancelled = await send(`/api/attempts/${cancelledId}/cancel`, {
    commandId: randomUUID(),
    confirmation: await confirmed(cancelledId),
  });
  expect(cancelled.status).toBe(200);
  expect(await readAttempts(actorSession)).toEqual([
    { id: cancelledId, status: 'cancelled' },
  ]);
  expect(await readResults(cancelledId)).toEqual([]);
  await expectObserversUntouched('actor cancelled A');

  // A completed attempt of B.
  const completedId = await startedBy(actorToken, examB);
  const submitted = await send(`/api/attempts/${completedId}/submit`, {
    commandId: randomUUID(),
    answers: [],
    confirmation: await confirmed(completedId),
  });
  expect(submitted.status).toBe(200);
  expect(await readResults(completedId)).toHaveLength(1);
  await expectObserversUntouched('actor completed B');

  // Replace: too short for a timed block of A, the guest is replaced (#44)
  // and the new guest starts both exams.
  const actorRows = guestRows(actorSession);
  const timedStart = await startBody(examA.slug, {
    mode: 'timed-block',
    selection: 'hoeren',
    expectedVersionId: examA.versionId,
  });
  const replaced = await replaceGuestSession(
    depsNow(),
    TEST_GUEST_SESSIONS_PER_MINUTE,
    () => preflightTimedStart(depsNow(), actorToken, timedStart),
  );
  if (replaced.status !== 'created') throw new Error(replaced.status);
  const fresh = replaced.created;
  const freshA = await startedBy(fresh.token, examA);
  const freshB = await startedBy(fresh.token, examB);
  expect(
    (await readAttempts(fresh.guest.sessionId)).map((row) => row.id).toSorted(),
  ).toEqual([freshA, freshB].toSorted());
  expect(guestRows(actorSession)).toEqual(actorRows);
  await expectObserversUntouched('actor replaced');

  // Expire: the old guest is refused, and nothing of the others moved.
  await untilGuestExpired(actorSession, 2 * ACTOR_TERM_SECONDS * SECOND_MS);
  const refused = [
    await send(
      '/api/attempts/start',
      await startBody(examA.slug, { expectedVersionId: examA.versionId }),
    ),
    await send(`/api/attempts/${completedId}/status`, {}),
    await send(`/api/attempts/${liveAttempt}/answer`, {
      questionId: 'hoeren-4',
      optionId: fullKeyOf('hoeren-4'),
      revision: 1,
    }),
  ];
  for (const reply of refused) {
    expect(reply.status).toBe(401);
    expect(JSON.stringify(reply.body)).toContain('session-invalid');
  }
  expect(guestRows(actorSession)).toEqual(actorRows);
  await expectObserversUntouched('actor expired');

  // The observers are still live: each can go on by itself.
  await answer(pausedPage, 'hoeren', 3, fullKeyOf('hoeren-3'));
  expect(await readAnswers(pausedAttempt)).toEqual({
    'hoeren-2': fullKeyOf('hoeren-2'),
    'hoeren-3': fullKeyOf('hoeren-3'),
  });
  await answer(livePage, 'hoeren', 2, fullKeyOf('hoeren-2'));
  expect(await readAnswers(liveAttempt)).toEqual({
    'hoeren-1': fullKeyOf('hoeren-1'),
    'hoeren-2': fullKeyOf('hoeren-2'),
  });
  expect(await readAnswers(restingAttempt)).toEqual({
    'hoeren-3': fullKeyOf('hoeren-3'),
  });
});
