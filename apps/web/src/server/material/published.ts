import { examContentSchema } from '@b1k/domain';
import type { ExamContent } from '@b1k/domain';
import type { ServerDeps } from '../db';

export const PILOT_EXAM_SLUG = 'telc-ajf-b12-dtz';

export interface PublishedVersion {
  versionId: string;
  examTitle: string;
  content: ExamContent;
}

interface VersionRow {
  id: string;
  content: unknown;
  exams: { title: string };
}

const VERSION_COLUMNS = 'id, content, exams!inner(title)';

const toPublished = (data: VersionRow): PublishedVersion => ({
  versionId: data.id,
  examTitle: data.exams.title,
  content: examContentSchema.parse(data.content),
});

// Reads only the public projection; answer keys live in another table and
// are never selected here.
export const getPublishedVersion = async (
  deps: ServerDeps,
  slug: string,
): Promise<PublishedVersion | null> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select(VERSION_COLUMNS)
    .eq('exams.slug', slug)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle<VersionRow>();
  if (error) throw new Error('Published material lookup failed', { cause: error });
  return data ? toPublished(data) : null;
};

// One published version by id, for an attempt that stays on the version it
// started with.
export const getVersionById = async (
  deps: ServerDeps,
  versionId: string,
): Promise<PublishedVersion | null> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select(VERSION_COLUMNS)
    .eq('id', versionId)
    .maybeSingle<VersionRow>();
  if (error) throw new Error('Version lookup failed', { cause: error });
  return data ? toPublished(data) : null;
};
