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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { examContentSchema } from '@b1k/domain';
import type { AnswerKeys, ExamContent } from '@b1k/domain';
import {
  createServiceClient,
  readServiceConfig,
} from '../apps/web/src/server/db';
import {
  audioContentTypeOf,
  keysFileSchema,
  publishExamVersion,
} from './lib/publish-exam-version';
import type { AudioContentType } from './lib/publish-exam-version';

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
  const keys = keysFileSchema.parse(
    JSON.parse(await readFile(keysFile, 'utf8')),
  );
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
