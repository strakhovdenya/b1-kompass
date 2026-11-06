import { z } from 'zod';
import type { LifecycleState } from '@b1k/domain';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import { readConfirmedTimingProfile } from '../attempts/profiles';
import { parsePinnedDurations, toLifecycleState } from '../attempts/projection';
import { finalizeSubmitted } from '../attempts/reconcile';
import {
  callReconcile,
  findActiveAttempt,
  findExamBySlug,
  findSubmittedAttemptIds,
  readLatestVersion,
  readOwnedAttempt,
  readRun,
} from '../attempts/repository';
import type { AttemptRow, RunRow } from '../attempts/repository';

export const AUDIO_BUCKET = 'exam-sources';

// A signed URL lets the browser read the bytes straight from Storage, with
// HTTP range requests for seeking. It is short-lived; the player asks for a
// new one when it expires. The free training and a timed block keep this.
export const AUDIO_URL_TTL_SECONDS = 600;

// The address of a full exam outlives its whole Hören by this margin, from
// the moment it is issued: the one recording plays to the end without a new
// address.
export const EXAM_AUDIO_MARGIN_SECONDS = 300;

const SECOND_MS = 1000;

// A track of a published version as the server stores it. Only the adapter
// of its kind knows what the location means.
export interface AudioTrackRef {
  trackId: string;
  kind: string;
  location: string;
  contentType: string;
}

// What the browser gets: a playable address and its expiry, never the
// storage path or a key.
export interface PlayableAudio {
  url: string;
  contentType: string;
  expiresAt: string;
}

// Contract of an audio source. The first and only implementation is a file
// in the private bucket; a visible external player would be another kind
// with its own adapter, without changes for the callers.
export interface AudioSourceAdapter {
  resolve(
    deps: ServerDeps,
    track: AudioTrackRef,
    ttlSeconds: number,
  ): Promise<PlayableAudio>;
}

export const fileAudioSource: AudioSourceAdapter = {
  resolve: async (deps, track, ttlSeconds) => {
    const { data, error } = await deps.db.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(track.location, ttlSeconds);
    if (error) throw new Error('Audio URL was not issued', { cause: error });
    const issuedAt = deps.clock.now().getTime();
    const expiresAt = new Date(issuedAt + ttlSeconds * SECOND_MS);
    return {
      url: data.signedUrl,
      contentType: track.contentType,
      expiresAt: expiresAt.toISOString(),
    };
  },
};

const ADAPTERS: Readonly<Record<string, AudioSourceAdapter>> = {
  file: fileAudioSource,
};

interface TrackRow {
  track_id: string;
  kind: string;
  object_path: string;
  content_type: string;
}

const toRef = (row: TrackRow): AudioTrackRef => ({
  trackId: row.track_id,
  kind: row.kind,
  location: row.object_path,
  contentType: row.content_type,
});

// Track ids of a version, for the page: the public part only.
export const listVersionTrackIds = async (
  deps: ServerDeps,
  versionId: string,
): Promise<string[]> => {
  const { data, error } = await deps.db
    .from('exam_version_audio')
    .select('track_id')
    .eq('exam_version_id', versionId)
    .order('track_id')
    .returns<{ track_id: string }[]>();
  if (error) throw new Error('Audio lookup failed', { cause: error });
  return data.map((row) => row.track_id);
};

const TRACK_COLUMNS = 'track_id, kind, object_path, content_type';

const readTracks = async (
  deps: ServerDeps,
  versionId: string,
): Promise<AudioTrackRef[]> => {
  const { data, error } = await deps.db
    .from('exam_version_audio')
    .select(TRACK_COLUMNS)
    .eq('exam_version_id', versionId)
    .returns<TrackRow[]>();
  if (error) throw new Error('Audio lookup failed', { cause: error });
  return data.map(toRef);
};

const readTrack = async (
  deps: ServerDeps,
  versionId: string,
  trackId: string,
): Promise<AudioTrackRef | null> => {
  const { data, error } = await deps.db
    .from('exam_version_audio')
    .select(TRACK_COLUMNS)
    .eq('exam_version_id', versionId)
    .eq('track_id', trackId)
    .maybeSingle<TrackRow>();
  if (error) throw new Error('Audio lookup failed', { cause: error });
  return data ? toRef(data) : null;
};

// 'phase-closed': the Hören of a full exam is over (or the exam is closed)
// and its result is not reviewed yet: no new address is issued.
export type AudioAccessError =
  | 'invalid-input'
  | 'session-invalid'
  | 'not-found'
  | 'phase-closed'
  | 'unavailable';

// The address; for a full exam also the server moment it was issued at and
// how many seconds of Hören it must still cover. The free player gets the
// plain PlayableAudio.
export interface IssuedAudio extends PlayableAudio {
  serverNow?: string;
  coverSeconds?: number;
}

export type AudioAccessResult =
  { ok: true; audio: IssuedAudio } | { ok: false; error: AudioAccessError };

const trackIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(100);

const audioInput = z.strictObject({
  attemptId: z.uuid(),
  trackId: trackIdSchema,
});

// The lifecycle of a stored run at a moment, by the same mapping as every
// other reader; null when its pinned profile does not parse, so an exam is
// never opened on a guess.
const lifecycleOf = (
  attempt: AttemptRow,
  run: RunRow,
  atMs: number,
): LifecycleState | null => {
  const durations = parsePinnedDurations(run.timingSnapshot);
  if (!durations) return null;
  return toLifecycleState(
    {
      mode: run.mode,
      selection: run.selection,
      status: attempt.status,
      acceptedAt: run.acceptedAt,
      durations,
      lesenStartedAt: run.lesenStartedAt,
    },
    atMs,
  );
};

interface AudioWindow {
  ttlSeconds: number;
  // The rest of Hören the address must cover; null for the free player,
  // whose answer keeps the plain PlayableAudio.
  coverSeconds: number | null;
}

const FREE_WINDOW: AudioWindow = {
  ttlSeconds: AUDIO_URL_TTL_SECONDS,
  coverSeconds: null,
};

// The window of an open full exam, judged like every other phase decision:
// under the row lock of the attempt by the database clock, which also closes
// a run past its end. The run is read again after the lock, so an early
// start of Lesen by another tab counts.
const examWindowOf = async (
  deps: ServerDeps,
  sessionId: string,
  attempt: AttemptRow,
): Promise<AudioWindow | null> => {
  const call = await callReconcile(deps, { sessionId, attemptId: attempt.id });
  if (!call.ok) throw new Error('Attempt was not read', { cause: call.error });
  if (call.row.attempt_status !== 'active') return null;
  const run = await readRun(deps, attempt.id);
  const atMs = Date.parse(call.row.server_now);
  const state = run ? lifecycleOf(attempt, run, atMs) : null;
  if (!state || state.phase !== 'hoeren' || state.deadlineMs === null) {
    return null;
  }
  const coverSeconds = Math.ceil((state.deadlineMs - atMs) / SECOND_MS);
  return {
    ttlSeconds: coverSeconds + EXAM_AUDIO_MARGIN_SECONDS,
    coverSeconds,
  };
};

// When the guest's own attempt may get an address. A free training and a
// timed block keep the free player and its 600 seconds. A full exam gets one
// only while its Hören is open, for the rest of Hören plus the margin, or
// once its result is stored, for the review; never in the transition, in
// Lesen or while the result is pending, whatever page asks.
const audioWindowOf = async (
  deps: ServerDeps,
  sessionId: string,
  attempt: AttemptRow,
): Promise<AudioWindow | null> => {
  const run = await readRun(deps, attempt.id);
  if (!run || run.mode !== 'exam') return FREE_WINDOW;
  if (attempt.status === 'completed') return FREE_WINDOW;
  if (attempt.status !== 'active') return null;
  return examWindowOf(deps, sessionId, attempt);
};

const issue = async (
  deps: ServerDeps,
  track: AudioTrackRef,
  window: AudioWindow,
): Promise<AudioAccessResult> => {
  const adapter = ADAPTERS[track.kind];
  if (!adapter) return { ok: false, error: 'not-found' };
  const audio = await adapter.resolve(deps, track, window.ttlSeconds);
  if (window.coverSeconds === null) return { ok: true, audio };
  // The moment of issue on the server clock: the address lives exactly its
  // TTL from it.
  const issuedMs = Date.parse(audio.expiresAt) - window.ttlSeconds * SECOND_MS;
  const serverNow = new Date(issuedMs).toISOString();
  return {
    ok: true,
    audio: { ...audio, serverNow, coverSeconds: window.coverSeconds },
  };
};

// Resolves the audio of the guest's own attempt, through the Server Action
// of the free player and the HTTP route of the full exam alike: the phase
// gate lives here, so no path issues a Hören address after Hören. Every
// browser gets its own address and plays it in its own player: nothing
// about playback is shared or stored on the server.
export const resolveAttemptAudio = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<AudioAccessResult> => {
  const parsed = audioInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  const { attemptId, trackId } = parsed.data;
  try {
    const attempt = await readOwnedAttempt(deps, guest.sessionId, attemptId);
    if (!attempt) return { ok: false, error: 'not-found' };
    const track = await readTrack(deps, attempt.examVersionId, trackId);
    if (!track) return { ok: false, error: 'not-found' };
    const window = await audioWindowOf(deps, guest.sessionId, attempt);
    if (!window) return { ok: false, error: 'phase-closed' };
    return await issue(deps, track, window);
  } catch (error) {
    // The cause carries no signed URL: it is created only on success.
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const prepareInput = z.strictObject({
  examSlug: z.string().max(100).regex(SLUG_PATTERN),
  expectedVersionId: z.uuid(),
});

// 'conflict': the slot of the exam holds an open attempt, which follows its
// own rules; a preparation never gives it a new address.
export type PrepareAudioError = AudioAccessError | 'conflict';

export type PrepareAudioResult =
  { ok: true; audio: IssuedAudio } | { ok: false; error: PrepareAudioError };

// A closed attempt of the slot whose result is not stored yet: its result
// is computed first. A closed exam gets a recording again only once it can
// be reviewed; until then a preparation is refused like its own audio.
const isReviewable = async (
  deps: ServerDeps,
  sessionId: string,
  attemptId: string,
): Promise<boolean> => {
  const [attempt, run] = await Promise.all([
    readOwnedAttempt(deps, sessionId, attemptId),
    readRun(deps, attemptId),
  ]);
  if (!attempt || !run) return false;
  if (run.mode !== 'exam' || attempt.status === 'completed') return true;
  const outcome = await finalizeSubmitted(deps, sessionId, attempt, run);
  return outcome === 'completed';
};

// The slot of the exam as the database judges it: the active attempt under
// its row lock by the database clock, which closes a run past its end, and
// then every submitted attempt of the slot. Null when a preparation may run.
const slotRefusal = async (
  deps: ServerDeps,
  sessionId: string,
  examId: string,
  active: AttemptRow | null,
): Promise<PrepareAudioError | null> => {
  if (active) {
    const call = await callReconcile(deps, { sessionId, attemptId: active.id });
    if (!call.ok) throw new Error('Slot was not read', { cause: call.error });
    if (call.row.attempt_status === 'active') return 'conflict';
  }
  for (const id of await findSubmittedAttemptIds(deps, sessionId, examId)) {
    if (!(await isReviewable(deps, sessionId, id))) return 'phase-closed';
  }
  return null;
};

// The preparation of a full exam on the choice: the one Hören recording of
// the latest version with a confirmed profile (which has exactly one
// recording and one Hören track; anything else fails closed), for the whole
// Hören plus the margin. It creates no attempt, no start and no deadline and
// returns no material. The start checks everything again.
export const prepareExamAudio = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<PrepareAudioResult> => {
  const parsed = prepareInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  try {
    const exam = await findExamBySlug(deps, parsed.data.examSlug);
    if (!exam) return { ok: false, error: 'not-found' };
    const [version, active] = await Promise.all([
      readLatestVersion(deps, exam.id),
      findActiveAttempt(deps, guest.sessionId, exam.id),
    ]);
    if (!version || version.id !== parsed.data.expectedVersionId) {
      return { ok: false, error: 'not-found' };
    }
    const refusal = await slotRefusal(deps, guest.sessionId, exam.id, active);
    if (refusal) return { ok: false, error: refusal };
    const [profile, tracks] = await Promise.all([
      readConfirmedTimingProfile(deps, version.id),
      readTracks(deps, version.id),
    ]);
    const [track] = tracks;
    if (!profile || !track || tracks.length !== 1) {
      return { ok: false, error: 'not-found' };
    }
    return await issue(deps, track, {
      ttlSeconds: profile.hoerenSeconds + EXAM_AUDIO_MARGIN_SECONDS,
      coverSeconds: profile.hoerenSeconds,
    });
  } catch (error) {
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};
