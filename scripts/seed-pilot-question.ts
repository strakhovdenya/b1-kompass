// Trusted owner tool: publishes the first real pilot question as an immutable
// exam version. It needs the server secret key and is never run by the web
// app or by a guest.
//
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//   PILOT_KEYS_FILE=private/pilot-keys.json npm run seed:pilot
//
// The answer key is read from a private, git-ignored file; this file holds
// only the public projection of the material.

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

// Hören Teil 1, Aufgabe 1 of the official telc practice test, page 1.
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
  ],
});

const keysFileSchema = z.record(z.string(), z.string());

export interface PublishInput {
  slug: string;
  title: string;
  format: string;
  content: ExamContent;
  keys: AnswerKeys;
}

export interface PublishOutcome {
  versionId: string;
  isNew: boolean;
}

const findSameVersion = async (
  db: SupabaseClient,
  input: PublishInput,
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
  return isDeepStrictEqual(storedKeys, { ...input.keys }) ? data.id : null;
};

// Validates the material contract before anything is written; the database
// function repeats the key checks and publishes atomically.
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
  const existing = await findSameVersion(db, input);
  if (existing) return { versionId: existing, isNew: false };
  const { data, error } = await db.rpc('publish_exam_version', {
    p_slug: input.slug,
    p_title: input.title,
    p_format: input.format,
    p_content: content,
    p_keys: input.keys,
  });
  if (error) throw new Error('Publication failed', { cause: error });
  return { versionId: z.uuid().parse(data), isNew: true };
};

export const publishPilotQuestion = (db: SupabaseClient, keys: AnswerKeys) =>
  publishExamVersion(db, { ...PILOT_EXAM, content: PILOT_CONTENT, keys });

const main = async () => {
  const db = createServiceClient(readServiceConfig(process.env));
  const keysFile = process.env.PILOT_KEYS_FILE ?? 'private/pilot-keys.json';
  const keys = keysFileSchema.parse(JSON.parse(await readFile(keysFile, 'utf8')));
  const outcome = await publishPilotQuestion(db, keys);
  const state = outcome.isNew ? 'published' : 'already published';
  console.log(`Pilot question ${state}: version ${outcome.versionId}`);
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
