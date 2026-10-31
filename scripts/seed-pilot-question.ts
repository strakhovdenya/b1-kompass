// Trusted owner tool: publishes the short pilot set (Hören Teil 1) with its
// original audio as an immutable exam version. It needs the server secret
// key and is never run by the web app or by a guest.
//
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//   PILOT_KEYS_FILE=private/pilot-keys.json \
//   PILOT_AUDIO_FILE=private/hoeren-teil-1.mp3 npm run seed:pilot
//
// The answer key and the audio file are read from private, git-ignored
// files; this file holds only the public projection of the material.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { examContentSchema, findMaterialProblems } from '@b1k/domain';
import type { AnswerKeys, ExamContent } from '@b1k/domain';
import {
  createServiceClient,
  readServiceConfig,
} from '../apps/web/src/server/db';

export const PILOT_EXAM = {
  slug: 'telc-ajf-b12-dtz',
  title: 'Auf jeden Fall! B1.2 — Übungstest Deutsch-Test für Zuwanderer',
  format: 'DTZ',
} as const;

// Hören Teil 1, Aufgaben 1–4 of the official telc practice test, page 1.
// The four announcements are one recording.
export const PILOT_CONTENT: ExamContent = examContentSchema.parse({
  source: {
    publisher: 'telc',
    title: 'Auf jeden Fall! B1.2 — Übungstest DTZ',
    url: 'https://www.telc.net/fileadmin/user_upload/Downloads_Verlag/Auf_jeden_Fall/Uebungstests/Auf_jeden_Fall_B1.2_UEbungstest_DTZ.pdf',
    page: 1,
  },
  questions: [
    {
      id: 'hoeren-1',
      number: 1,
      kind: 'single-choice',
      skill: 'hoeren',
      teil: 1,
      prompt: 'Was soll Herr Rossi machen?',
      options: [
        { id: 'a', text: 'Den anderen Teilnehmern Bescheid sagen.' },
        { id: 'b', text: 'In der Sprachschule anrufen.' },
        { id: 'c', text: 'Sofort in den Kurs kommen.' },
      ],
    },
    {
      id: 'hoeren-2',
      number: 2,
      kind: 'single-choice',
      skill: 'hoeren',
      teil: 1,
      prompt: 'Wann soll Frau Tulipano anrufen?',
      options: [
        { id: 'a', text: 'Am Nachmittag.' },
        { id: 'b', text: 'Nächste Woche.' },
        { id: 'c', text: 'Vormittags.' },
      ],
    },
    {
      id: 'hoeren-3',
      number: 3,
      kind: 'single-choice',
      skill: 'hoeren',
      teil: 1,
      prompt: 'Was muss Frau Jensen tun?',
      options: [
        { id: 'a', text: 'Die Geburtsurkunde schicken.' },
        { id: 'b', text: 'In den nächsten Tagen einen Brief schreiben.' },
        { id: 'c', text: 'Zum neuen Termin in die Schule gehen.' },
      ],
    },
    {
      id: 'hoeren-4',
      number: 4,
      kind: 'single-choice',
      skill: 'hoeren',
      teil: 1,
      prompt:
        'Sie haben gerade ein dringendes technisches Problem. Was sollen Sie machen?',
      options: [
        { id: 'a', text: 'Bis 17. August warten.' },
        { id: 'b', text: 'Eine E-Mail schicken.' },
        { id: 'c', text: 'Sich telefonisch melden.' },
      ],
    },
  ],
});

export const PILOT_TRACK_ID = 'hoeren-teil-1';

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

const keysFileSchema = z.record(z.string(), z.string());

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
  const problems = findMaterialProblems(content, input.keys);
  if (problems.length > 0) {
    const list = problems.map((p) => `${p.code}:${p.questionId}`).join(', ');
    throw new Error(`Material is not publishable: ${list}`);
  }
  const tracks = toTracks(input.audio);
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

export interface PilotAudio {
  contentType: AudioContentType;
  bytes: Uint8Array;
}

export const publishPilotShortSet = (
  db: SupabaseClient,
  keys: AnswerKeys,
  audio: PilotAudio,
) =>
  publishExamVersion(db, {
    ...PILOT_EXAM,
    content: PILOT_CONTENT,
    keys,
    audio: [{ trackId: PILOT_TRACK_ID, ...audio }],
  });

const main = async () => {
  const db = createServiceClient(readServiceConfig(process.env));
  const keysFile = process.env.PILOT_KEYS_FILE ?? 'private/pilot-keys.json';
  const audioFile = process.env.PILOT_AUDIO_FILE;
  if (!audioFile) throw new Error('PILOT_AUDIO_FILE must be set');
  const keys = keysFileSchema.parse(JSON.parse(await readFile(keysFile, 'utf8')));
  const audio: PilotAudio = {
    contentType: audioContentTypeOf(audioFile),
    bytes: new Uint8Array(await readFile(audioFile)),
  };
  const outcome = await publishPilotShortSet(db, keys, audio);
  const state = outcome.isNew ? 'published' : 'already published';
  console.log(`Pilot short set ${state}: version ${outcome.versionId}`);
};

const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const isEntryPoint =
  process.argv[1] !== undefined &&
  samePath(fileURLToPath(import.meta.url), process.argv[1]);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
