import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, Page, Route } from '@playwright/test';
import { examContentSchema, selectScoringPolicy } from '@b1k/domain';
import { publishExamVersion } from '../../../scripts/lib/publish-exam-version';
import type { AudioFileInput } from '../../../scripts/lib/publish-exam-version';
import { publishFullPilot } from '../../../scripts/publish-pilot';
import { getPublishedVersion } from '../src/server/material/published';
import { FULL_EXAM, FULL_PILOT, FULL_TRACK_ID } from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import {
  depsNow,
  readAnswers,
  readAttempts,
  readResults,
  serviceDb,
} from './support/db';
import {
  card,
  expectStatus,
  finishFromShell,
  goToHoeren,
  goToLesen,
  optionIn,
  pausePlayer,
  playFrom,
  screenOf,
  seekTo,
  snapshotOf,
  sourcePathOf,
  startBrowserGuest,
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
const cleanups: (() => void)[] = [];

test.afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  const guests = opened.splice(0);
  await Promise.all(guests.map((guest) => guest.context.close()));
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
  const stillPlaying = await Promise.all(
    guests.map((guest) => snapshotOf(guest.page)),
  );
  stillPlaying.forEach((snapshot, index) => {
    expect(snapshot).toMatchObject({
      paused: false,
      marker: `guest-${index}`,
    });
    expect(snapshot.currentTime).toBeGreaterThan(
      playing[index]?.currentTime ?? 0,
    );
  });
  expectDistinctPositions(stillPlaying);

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

  // 4. Finish and start a new run.
  await finishFromShell(actor.page);
  await actor.page.getByTestId('restart-attempt').click();
  await actor.page.waitForURL('**/practice');
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
  await delayed.context.route('**/practice', async (route: Route) => {
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
