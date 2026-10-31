// Trusted owner tool: publishes the full pilot (20 Hören, 25 Lesen) from the
// prepared JSON as an immutable exam version. It needs the server secret key
// and is never run by the web app or by a guest.
//
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//   PILOT_CONTENT_FILE=private/pilot-content.json \
//   PILOT_KEYS_FILE=private/pilot-keys.json \
//   PILOT_AUDIO_FILE=private/track-127.mp3 npm run publish:pilot
//
// Content, key and recording are read from private, git-ignored files and
// validated by the same contract as the short set.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { examContentSchema, findInventoryProblems } from '@b1k/domain';
import type { AnswerKeys } from '@b1k/domain';
import {
  createServiceClient,
  readServiceConfig,
} from '../apps/web/src/server/db';
import { FULL_PILOT_TRACK_ID, PILOT_INVENTORY } from './lib/pilot';
import { PILOT_EXAM } from './seed-pilot-question';
import {
  audioContentTypeOf,
  keysFileSchema,
  publishExamVersion,
} from './lib/publish-exam-version';
import type {
  AudioContentType,
  PublishOutcome,
} from './lib/publish-exam-version';

export interface FullPilotInput {
  exam?: { slug: string; title: string; format: string };
  content: unknown;
  keys: AnswerKeys;
  audio: { contentType: AudioContentType; bytes: Uint8Array };
}

// The inventory is checked before anything is written; the contract itself is
// checked by the shared publication.
export const publishFullPilot = (
  db: SupabaseClient,
  input: FullPilotInput,
): Promise<PublishOutcome> => {
  const content = examContentSchema.parse(input.content);
  const problems = findInventoryProblems(content, PILOT_INVENTORY);
  if (problems.length > 0) {
    const list = problems.map((p) => `${p.code}:${p.questionId}`).join(', ');
    throw new Error(`Pilot is not complete: ${list}`);
  }
  return publishExamVersion(db, {
    ...(input.exam ?? PILOT_EXAM),
    content,
    keys: input.keys,
    audio: [{ trackId: FULL_PILOT_TRACK_ID, ...input.audio }],
  });
};

const main = async () => {
  const db = createServiceClient(readServiceConfig(process.env));
  const contentFile =
    process.env.PILOT_CONTENT_FILE ?? 'private/pilot-content.json';
  const keysFile = process.env.PILOT_KEYS_FILE ?? 'private/pilot-keys.json';
  const audioFile = process.env.PILOT_AUDIO_FILE;
  if (!audioFile) throw new Error('PILOT_AUDIO_FILE must be set');
  const outcome = await publishFullPilot(db, {
    content: JSON.parse(await readFile(contentFile, 'utf8')),
    keys: keysFileSchema.parse(JSON.parse(await readFile(keysFile, 'utf8'))),
    audio: {
      contentType: audioContentTypeOf(audioFile),
      bytes: new Uint8Array(await readFile(audioFile)),
    },
  });
  const state = outcome.isNew ? 'published' : 'already published';
  console.log(`Full pilot ${state}: version ${outcome.versionId}`);
};

const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
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
