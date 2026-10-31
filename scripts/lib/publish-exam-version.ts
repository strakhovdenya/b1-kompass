// The one trusted publication function of the owner tools: validates the
// material contract, uploads the audio objects and calls the database
// function that writes version, keys and tracks in one transaction. The short
// set and the full pilot both publish through it.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { examContentSchema, findMaterialProblems } from '@b1k/domain';
import type { AnswerKeys, ExamContent } from '@b1k/domain';

export const AUDIO_BUCKET = 'exam-sources';

const AUDIO_EXTENSIONS = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
} as const;

export type AudioContentType = keyof typeof AUDIO_EXTENSIONS;

const CONTENT_TYPES: Readonly<Record<string, AudioContentType>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

const TRACK_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const keysFileSchema = z.record(z.string(), z.string());

// One audio file of the version, read by the owner from outside the
// repository.
export interface AudioFileInput {
  trackId: string;
  contentType: AudioContentType;
  bytes: Uint8Array;
}

export interface PublishInput {
  slug: string;
  title: string;
  format: string;
  content: ExamContent;
  keys: AnswerKeys;
  audio: readonly AudioFileInput[];
}

export interface PublishOutcome {
  versionId: string;
  isNew: boolean;
}

interface AudioTrack {
  trackId: string;
  kind: 'file';
  objectPath: string;
  contentType: AudioContentType;
  sha256: string;
}

interface AudioTrackRow {
  track_id: string;
  kind: string;
  object_path: string;
  content_type: string;
  sha256: string;
}

export const audioContentTypeOf = (filePath: string): AudioContentType => {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(`Audio file type is not supported: ${extension}`);
  }
  return contentType;
};

// The object path is derived from the bytes: the same file is uploaded once,
// and a changed file never overwrites the audio of a published version.
const toTrack = (file: AudioFileInput): AudioTrack => {
  if (!TRACK_ID.test(file.trackId)) {
    throw new Error(`Audio track id is not valid: ${file.trackId}`);
  }
  if (!Object.hasOwn(AUDIO_EXTENSIONS, file.contentType)) {
    throw new Error(`Audio type is not supported: ${file.contentType}`);
  }
  if (file.bytes.byteLength === 0) {
    throw new Error(`Audio file of ${file.trackId} is empty`);
  }
  const sha256 = createHash('sha256').update(file.bytes).digest('hex');
  const extension = AUDIO_EXTENSIONS[file.contentType];
  return {
    trackId: file.trackId,
    kind: 'file',
    objectPath: `audio/${sha256}.${extension}`,
    contentType: file.contentType,
    sha256,
  };
};

const toTracks = (files: readonly AudioFileInput[]): AudioTrack[] => {
  const tracks = files.map(toTrack);
  const trackIds = new Set(tracks.map((track) => track.trackId));
  if (trackIds.size !== tracks.length) {
    throw new Error('Audio track ids are not unique');
  }
  return tracks.toSorted((a, b) => a.trackId.localeCompare(b.trackId));
};

const sameTracks = async (
  db: SupabaseClient,
  versionId: string,
  tracks: readonly AudioTrack[],
): Promise<boolean> => {
  const { data, error } = await db
    .from('exam_version_audio')
    .select('track_id, kind, object_path, content_type, sha256')
    .eq('exam_version_id', versionId)
    .returns<AudioTrackRow[]>();
  if (error) throw new Error('Audio lookup failed', { cause: error });
  const stored = data
    .map((row) => ({
      trackId: row.track_id,
      kind: row.kind,
      objectPath: row.object_path,
      contentType: row.content_type,
      sha256: row.sha256,
    }))
    .toSorted((a, b) => a.trackId.localeCompare(b.trackId));
  return isDeepStrictEqual(stored, tracks);
};

const findSameVersion = async (
  db: SupabaseClient,
  input: PublishInput,
  tracks: readonly AudioTrack[],
): Promise<string | null> => {
  const { data, error } = await db
    .from('exam_versions')
    .select('id, content, exams!inner(slug)')
    .eq('exams.slug', input.slug)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; content: unknown }>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  if (!data) return null;
  const stored = examContentSchema.safeParse(data.content);
  if (!stored.success || !isDeepStrictEqual(stored.data, input.content)) {
    return null;
  }
  const keys = await db
    .from('answer_keys')
    .select('question_id, correct_option_id')
    .eq('exam_version_id', data.id)
    .returns<{ question_id: string; correct_option_id: string }[]>();
  if (keys.error) throw new Error('Key lookup failed', { cause: keys.error });
  const storedKeys = Object.fromEntries(
    keys.data.map((row) => [row.question_id, row.correct_option_id]),
  );
  if (!isDeepStrictEqual(storedKeys, { ...input.keys })) return null;
  return (await sameTracks(db, data.id, tracks)) ? data.id : null;
};

const uploadTrack = async (
  db: SupabaseClient,
  track: AudioTrack,
  file: AudioFileInput,
): Promise<void> => {
  const bucket = db.storage.from(AUDIO_BUCKET);
  const folder = path.posix.dirname(track.objectPath);
  const name = path.posix.basename(track.objectPath);
  const listed = await bucket.list(folder, { search: name });
  if (listed.error) {
    throw new Error('Audio lookup failed', { cause: listed.error });
  }
  if (listed.data.some((object) => object.name === name)) return;
  const { error } = await bucket.upload(track.objectPath, file.bytes, {
    contentType: track.contentType,
    upsert: false,
  });
  if (error) throw new Error('Audio upload failed', { cause: error });
};

// Validates the material contract and the audio files before anything is
// written: a rejected set uploads nothing and creates no version or key. The
// database function repeats the key checks, requires every audio object and
// writes version, keys and tracks in one transaction.
export const publishExamVersion = async (
  db: SupabaseClient,
  input: PublishInput,
): Promise<PublishOutcome> => {
  const content = examContentSchema.parse(input.content);
  const tracks = toTracks(input.audio);
  const trackIds = new Set(tracks.map((track) => track.trackId));
  const problems = findMaterialProblems(content, input.keys, { trackIds });
  if (problems.length > 0) {
    const list = problems.map((p) => `${p.code}:${p.questionId}`).join(', ');
    throw new Error(`Material is not publishable: ${list}`);
  }
  const existing = await findSameVersion(db, input, tracks);
  if (existing) return { versionId: existing, isNew: false };
  for (const file of input.audio) {
    const track = tracks.find((item) => item.trackId === file.trackId);
    if (track) await uploadTrack(db, track, file);
  }
  const { data, error } = await db.rpc('publish_exam_version', {
    p_slug: input.slug,
    p_title: input.title,
    p_format: input.format,
    p_content: content,
    p_keys: input.keys,
    p_audio: tracks,
  });
  if (error) throw new Error('Publication failed', { cause: error });
  return { versionId: z.uuid().parse(data), isNew: true };
};
