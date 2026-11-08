// The one trusted publication function of the owner tools: validates the
// material contract, checks the identity of the exam, uploads the audio
// objects and calls the database function that writes version, keys and
// tracks in one transaction. The short set, the full pilot and the owner CLI
// (`exam:publish`) all publish through it.
//
// The identity guard lives in the database function
// (supabase/migrations/20261114000000_m3_publish_guard.sql): under the row
// lock of the exam it rejects a changed format, a changed title without
// `rename` and an intent that does not match, and returns the existing
// version for an identical package. The read-only checks here only avoid
// uploading objects for a publication the database would refuse.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { examContentSchema, findMaterialProblems } from '@b1k/domain';
import { ruleViolation } from '../../apps/web/src/server/db';
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

export const isValidTrackId = (trackId: string): boolean =>
  TRACK_ID.test(trackId);

export const keysFileSchema = z.record(z.string(), z.string());

// One audio file of the version, read by the owner from outside the
// repository.
export interface AudioFileInput {
  trackId: string;
  contentType: AudioContentType;
  bytes: Uint8Array;
}

// 'new-exam': the slug must not exist yet; 'new-version': it must exist.
// Optional for the trusted callers that publish fixed test and pilot sets;
// the owner CLI always passes it.
export type PublishIntent = 'new-exam' | 'new-version';

export interface ExamIdentity {
  slug: string;
  title: string;
  format: string;
}

export interface PublicationRequest extends ExamIdentity {
  intent?: PublishIntent;
  // Allows a changed `exams.title` of an existing exam; the new title is
  // visible in the reviews of every earlier version.
  rename?: boolean;
}

export interface PublishInput extends PublicationRequest {
  content: ExamContent;
  keys: AnswerKeys;
  audio: readonly AudioFileInput[];
}

export interface PublishOutcome {
  versionId: string;
  isNew: boolean;
}

// Expected refusals of a publication as stable codes. The database function
// reports the same codes as the hint of its P0001 errors.
export const PUBLICATION_REJECTIONS = [
  'exam_exists',
  'exam_not_found',
  'exam_format_mismatch',
  'exam_title_mismatch',
  'exam_identity_conflict',
  'publish_intent_invalid',
  'material_invalid',
] as const;

export type PublicationRejection = (typeof PUBLICATION_REJECTIONS)[number];

const isPublicationRejection = (
  value: unknown,
): value is PublicationRejection =>
  typeof value === 'string' &&
  (PUBLICATION_REJECTIONS as readonly string[]).includes(value);

// An operational refusal: it carries only its code, never material or keys.
export class PublicationRejectedError extends Error {
  readonly code: PublicationRejection;

  constructor(code: PublicationRejection) {
    super(`Publication rejected: ${code}`);
    this.name = 'PublicationRejectedError';
    this.code = code;
  }
}

// An object under the content-addressed path holds other bytes than the path
// promises. The publication stops before the database function; the object is
// left untouched. The error carries the code and the track id only.
export const AUDIO_OBJECT_MISMATCH = 'audio-object-mismatch';

export class AudioObjectMismatchError extends Error {
  readonly code = AUDIO_OBJECT_MISMATCH;
  readonly trackId: string;

  constructor(trackId: string) {
    super(`Publication stopped: ${AUDIO_OBJECT_MISMATCH}`);
    this.name = 'AudioObjectMismatchError';
    this.trackId = trackId;
  }
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

// The content type of a supported audio extension, or undefined.
export const findAudioContentType = (
  filePath: string,
): AudioContentType | undefined =>
  CONTENT_TYPES[path.extname(filePath).toLowerCase()];

export const audioContentTypeOf = (filePath: string): AudioContentType => {
  const contentType = findAudioContentType(filePath);
  if (!contentType) {
    const extension = path.extname(filePath).toLowerCase();
    throw new Error(`Audio file type is not supported: ${extension}`);
  }
  return contentType;
};

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

// The object path is derived from the bytes: the same file is uploaded once,
// and a changed file never overwrites the audio of a published version.
const toTrack = (file: AudioFileInput): AudioTrack => {
  if (!isValidTrackId(file.trackId)) {
    throw new Error(`Audio track id is not valid: ${file.trackId}`);
  }
  if (!Object.hasOwn(AUDIO_EXTENSIONS, file.contentType)) {
    throw new Error(`Audio type is not supported: ${file.contentType}`);
  }
  if (file.bytes.byteLength === 0) {
    throw new Error(`Audio file of ${file.trackId} is empty`);
  }
  const sha256 = sha256Of(file.bytes);
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

// The exam of the slug as it is stored now, or null. Read-only.
export const readExamIdentity = async (
  db: SupabaseClient,
  slug: string,
): Promise<ExamIdentity | null> => {
  const { data, error } = await db
    .from('exams')
    .select('slug, title, format')
    .eq('slug', slug)
    .maybeSingle<ExamIdentity>();
  if (error) throw new Error('Exam lookup failed', { cause: error });
  return data;
};

// The rule of the database guard applied to a read snapshot.
export const findIdentityProblem = (
  existing: ExamIdentity | null,
  request: PublicationRequest,
): PublicationRejection | null => {
  if (!existing) {
    return request.intent === 'new-version' ? 'exam_not_found' : null;
  }
  if (request.intent === 'new-exam') return 'exam_exists';
  if (existing.format !== request.format) return 'exam_format_mismatch';
  const isRenamed = existing.title !== request.title;
  if (isRenamed && request.rename !== true) return 'exam_title_mismatch';
  return null;
};

// Read-only preflight: refuses before any upload what the database function
// would refuse. It cannot see a concurrent publication; the database
// function decides again under the row lock of the exam.
//
// The audio objects are content addressed (`audio/<sha256>.<ext>`), but the
// name of an object does not prove its bytes: an object that already exists
// (listed, or reported as a duplicate by a concurrent upload) is accepted only
// after its downloaded bytes give the expected SHA-256 (#82). Nothing is
// overwritten and this module never deletes an object: an upload that was not
// followed by a committed version stays in the private bucket and is found by
// the read-only audit (`exam:audit-audio`).
export const preflightPublication = async (
  db: SupabaseClient,
  request: PublicationRequest,
): Promise<ExamIdentity | null> => {
  const existing = await readExamIdentity(db, request.slug);
  const problem = findIdentityProblem(existing, request);
  if (problem) throw new PublicationRejectedError(problem);
  return existing;
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

// The latest version when content, keys and tracks are identical to it.
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

// The early exit without upload and without the database function is taken
// only when all five parts (content, keys, tracks, title, format) are
// unchanged and the intent allows an existing exam.
const mayReuseVersion = (
  existing: ExamIdentity | null,
  input: PublishInput,
): boolean =>
  existing !== null &&
  input.intent !== 'new-exam' &&
  existing.title === input.title &&
  existing.format === input.format;

// The upload answer of a name that is already taken (a concurrent upload of
// the same content addressed object won the race).
const isDuplicateObject = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const { status, statusCode, code } = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  return (
    status === 409 || statusCode === '409' || code === 'ResourceAlreadyExists'
  );
};

// Reads the stored object back and compares its SHA-256 with the one its
// path promises. Read-only: a mismatch is reported, never repaired.
const verifyObject = async (
  bucket: ReturnType<SupabaseClient['storage']['from']>,
  track: AudioTrack,
): Promise<void> => {
  const { data, error } = await bucket.download(track.objectPath);
  if (error) throw new Error('Audio verification failed', { cause: error });
  const stored = new Uint8Array(await data.arrayBuffer());
  if (sha256Of(stored) !== track.sha256) {
    throw new AudioObjectMismatchError(track.trackId);
  }
};

// Makes sure the object of the track exists with the right bytes: an existing
// object is verified instead of trusted, a missing one is uploaded without
// overwrite, and a lost race against another upload is verified the same way.
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
  if (listed.data.some((object) => object.name === name)) {
    await verifyObject(bucket, track);
    return;
  }
  const { error } = await bucket.upload(track.objectPath, file.bytes, {
    contentType: track.contentType,
    upsert: false,
  });
  if (!error) return;
  if (!isDuplicateObject(error)) {
    throw new Error('Audio upload failed', { cause: error });
  }
  await verifyObject(bucket, track);
};

// The function returns exactly one row.
const publishedRowsSchema = z.tuple([
  z.object({ version_id: z.uuid(), is_new: z.boolean() }),
]);

// A refusal of the database function becomes its code; anything else stays
// an internal failure with the database error only as its cause.
const publicationError = (error: unknown): Error => {
  const hint = ruleViolation(error);
  return isPublicationRejection(hint)
    ? new PublicationRejectedError(hint)
    : new Error('Publication failed', { cause: error });
};

// Validates the material contract, the audio files and the identity of the
// exam before anything is written: a rejected set uploads nothing and
// creates no exam, version or key. The database function repeats the key
// and identity checks under the row lock of the exam, requires every audio
// object and writes version, keys and tracks in one transaction.
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
  const existing = await preflightPublication(db, input);
  if (mayReuseVersion(existing, input)) {
    const same = await findSameVersion(db, input, tracks);
    if (same) return { versionId: same, isNew: false };
  }
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
    p_intent: input.intent ?? null,
    p_rename: input.rename === true,
  });
  if (error) throw publicationError(error);
  // The transaction is committed here: an unreadable answer must not look
  // like a failed publication.
  const parsed = publishedRowsSchema.safeParse(data);
  if (!parsed.success) throw new Error('Publication result unreadable');
  const row = parsed.data[0];
  return { versionId: row.version_id, isNew: row.is_new };
};
