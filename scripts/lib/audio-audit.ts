// Read-only audit of the private audio bucket (#82): lists the objects that
// no `exam_version_audio` row refers to. It only reads (a bucket listing and a
// table select) and only reports paths: it holds no code that deletes,
// moves or rewrites an object, and the owner decides about every unreferenced
// object separately.
//
// An unreferenced object is not proof that it is unused: a publication may
// have uploaded it and not yet committed the version that refers to it. The
// listing is therefore read before the references: an object that gets
// referenced in between is reported as referenced, never as unreferenced by
// mistake.

import type { SupabaseClient } from '@supabase/supabase-js';
import { AUDIO_BUCKET } from './publish-exam-version';

const OBJECT_PAGE = 100;
// A page may be shorter than requested (a server-side row limit), so paging
// ends only at an empty page.
const REFERENCE_PAGE = 1000;
// Folders below the bucket root: `audio/` is the only one in use.
const MAX_DEPTH = 6;
// The placeholder that the Supabase dashboard stores in an empty folder.
const FOLDER_PLACEHOLDER = '.emptyFolderPlaceholder';

export const LISTING_FAILED = 'Audio object listing failed';
export const REFERENCES_FAILED = 'Audio reference lookup failed';

export interface AudioAuditReport {
  // Objects found in the bucket.
  objects: number;
  // Of them, objects that a version of an exam refers to.
  referenced: number;
  // Paths of objects that no version refers to, sorted.
  unreferenced: string[];
}

const listFolder = async (
  db: SupabaseClient,
  folder: string,
  depth: number,
): Promise<string[]> => {
  const bucket = db.storage.from(AUDIO_BUCKET);
  const found: string[] = [];
  for (let offset = 0; ; offset += OBJECT_PAGE) {
    const { data, error } = await bucket.list(folder, {
      limit: OBJECT_PAGE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(LISTING_FAILED, { cause: error });
    for (const entry of data) {
      if (entry.name === FOLDER_PLACEHOLDER) continue;
      const entryPath = folder === '' ? entry.name : `${folder}/${entry.name}`;
      if (entry.id !== null) {
        found.push(entryPath);
      } else if (depth < MAX_DEPTH) {
        found.push(...(await listFolder(db, entryPath, depth + 1)));
      }
    }
    if (data.length === 0) return found;
  }
};

const readReferencedPaths = async (
  db: SupabaseClient,
): Promise<Set<string>> => {
  const paths = new Set<string>();
  for (let from = 0; ; from += REFERENCE_PAGE) {
    const { data, error } = await db
      .from('exam_version_audio')
      .select('object_path')
      .order('exam_version_id')
      .order('track_id')
      .range(from, from + REFERENCE_PAGE - 1)
      .returns<{ object_path: string }[]>();
    if (error) throw new Error(REFERENCES_FAILED, { cause: error });
    for (const row of data) paths.add(row.object_path);
    if (data.length === 0) return paths;
  }
};

export const auditAudio = async (
  db: SupabaseClient,
): Promise<AudioAuditReport> => {
  const objects = await listFolder(db, '', 0);
  const references = await readReferencedPaths(db);
  const unreferenced = objects.filter((object) => !references.has(object));
  return {
    objects: objects.length,
    referenced: objects.length - unreferenced.length,
    unreferenced: unreferenced.toSorted(),
  };
};

// A path as one safe printable token.
const printable = (objectPath: string): string =>
  objectPath.replaceAll(/[^\x20-\x7e]/g, '?');

export const formatAuditReport = (
  report: AudioAuditReport,
  json: boolean,
): string => {
  const { objects, referenced, unreferenced } = report;
  if (json) {
    return `${JSON.stringify({ objects, referenced, unreferenced }, null, 2)}\n`;
  }
  const lines = [
    `Audio objects: ${objects}, referenced by a version: ${referenced}, ` +
      `unreferenced: ${unreferenced.length}`,
    ...unreferenced.map(
      (objectPath) => `unreferenced ${printable(objectPath)}`,
    ),
    'Nothing was deleted or changed. An unreferenced object may belong to a ' +
      'publication that has not committed yet: do not delete it without ' +
      'checking.',
  ];
  return `${lines.join('\n')}\n`;
};
