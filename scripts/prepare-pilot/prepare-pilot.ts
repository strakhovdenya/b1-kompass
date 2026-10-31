// Owner tool: splits a structured draft of the pilot into the public content
// file and the private key file, after checking both against the material
// contract. The draft is made from the publisher's PDF (text extracted by the
// owner, programmatically or in a model account); the key is copied from the
// publisher's answer pages and never produced by a model.
//
//   PILOT_DRAFT_FILE=private/pilot-draft.json npm run prepare:pilot
//
// Draft: { "content": <examContent>, "keys": { "<questionId>": "<option>" } }
// Output: private/pilot-content.json and private/pilot-keys.json.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  examContentSchema,
  findInventoryProblems,
  findMaterialProblems,
} from '@b1k/domain';
import type { AnswerKeys, ExamContent, MaterialProblem } from '@b1k/domain';
import { FULL_PILOT_TRACK_ID, PILOT_INVENTORY } from '../lib/pilot';

const draftSchema = z.strictObject({
  content: examContentSchema,
  keys: z.record(z.string(), z.string()),
});

export interface PreparedPilot {
  content: ExamContent;
  keys: AnswerKeys;
  problems: MaterialProblem[];
}

// The draft names the recording by track id; every Hören reference must use
// the one recording of the pilot.
export const preparePilot = (draft: unknown): PreparedPilot => {
  const { content, keys } = draftSchema.parse(draft);
  const trackIds = new Set([FULL_PILOT_TRACK_ID]);
  const problems = [
    ...findMaterialProblems(content, keys, { trackIds }),
    ...findInventoryProblems(content, PILOT_INVENTORY),
  ];
  return { content, keys, problems };
};

const main = async () => {
  const draftFile = process.env.PILOT_DRAFT_FILE ?? 'private/pilot-draft.json';
  const outDir = process.env.PILOT_OUT_DIR ?? 'private';
  const draft: unknown = JSON.parse(await readFile(draftFile, 'utf8'));
  const { content, keys, problems } = preparePilot(draft);
  if (problems.length > 0) {
    for (const { code, questionId } of problems) {
      console.error(`${code}: ${questionId}`);
    }
    process.exitCode = 1;
    return;
  }
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(outDir, 'pilot-content.json'), json(content));
  await writeFile(path.join(outDir, 'pilot-keys.json'), json(keys));
  console.log(`Prepared ${content.questions.length} questions in ${outDir}`);
};

const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
