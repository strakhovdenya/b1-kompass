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

// Reads only the public projection; answer keys live in another table and
// are never selected here.
export const getPublishedVersion = async (
  deps: ServerDeps,
  slug: string,
): Promise<PublishedVersion | null> => {
  const { data, error } = await deps.db
    .from('exam_versions')
    .select('id, content, exams!inner(title)')
    .eq('exams.slug', slug)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle<VersionRow>();
  if (error) throw new Error('Published material lookup failed', { cause: error });
  if (!data) return null;
  return {
    versionId: data.id,
    examTitle: data.exams.title,
    content: examContentSchema.parse(data.content),
  };
};
