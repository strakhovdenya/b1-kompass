import { z } from 'zod';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';

export const AUDIO_BUCKET = 'exam-sources';

// A signed URL lets the browser read the bytes straight from Storage, with
// HTTP range requests for seeking. It is short-lived; the player asks for a
// new one when it expires.
export const AUDIO_URL_TTL_SECONDS = 600;

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
  resolve(deps: ServerDeps, track: AudioTrackRef): Promise<PlayableAudio>;
}

export const fileAudioSource: AudioSourceAdapter = {
  resolve: async (deps, track) => {
    const { data, error } = await deps.db.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(track.location, AUDIO_URL_TTL_SECONDS);
    if (error) throw new Error('Audio URL was not issued', { cause: error });
    const issuedAt = deps.clock.now().getTime();
    const expiresAt = new Date(issuedAt + AUDIO_URL_TTL_SECONDS * 1000);
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

export type AudioAccessError =
  'invalid-input' | 'session-invalid' | 'not-found' | 'unavailable';

export type AudioAccessResult =
  { ok: true; audio: PlayableAudio } | { ok: false; error: AudioAccessError };

const audioInput = z.strictObject({
  attemptId: z.uuid(),
  trackId: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(100),
});

const findOwnedTrack = async (
  deps: ServerDeps,
  sessionId: string,
  attemptId: string,
  trackId: string,
): Promise<AudioTrackRef | null> => {
  const attempt = await deps.db
    .from('attempts')
    .select('exam_version_id')
    .eq('id', attemptId)
    .eq('guest_session_id', sessionId)
    .maybeSingle<{ exam_version_id: string }>();
  if (attempt.error) {
    throw new Error('Attempt lookup failed', { cause: attempt.error });
  }
  if (!attempt.data) return null;
  const { data, error } = await deps.db
    .from('exam_version_audio')
    .select('track_id, kind, object_path, content_type')
    .eq('exam_version_id', attempt.data.exam_version_id)
    .eq('track_id', trackId)
    .maybeSingle<TrackRow>();
  if (error) throw new Error('Audio lookup failed', { cause: error });
  return data ? toRef(data) : null;
};

// Resolves the audio of the guest's own attempt. Every browser gets its own
// address and plays it in its own player: nothing about playback is shared
// or stored on the server.
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
    const track = await findOwnedTrack(
      deps,
      guest.sessionId,
      attemptId,
      trackId,
    );
    const adapter = track ? ADAPTERS[track.kind] : undefined;
    if (!track || !adapter) return { ok: false, error: 'not-found' };
    return { ok: true, audio: await adapter.resolve(deps, track) };
  } catch (error) {
    // The cause carries no signed URL: it is created only on success.
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
};
