import {
  DTZ_FULL_INVENTORY,
  examContentSchema,
  selectAttemptScope,
} from '@b1k/domain';
import type { ServerDeps } from '../db';

export interface CatalogEntry {
  slug: string;
  title: string;
  format: string;
  hoerenCount: number;
  lesenCount: number;
  totalCount: number;
}

export interface CatalogVersionRow {
  version: number;
  content: unknown;
}

export interface CatalogRow {
  slug: string;
  title: string;
  format: string;
  exam_versions: CatalogVersionRow[];
}

// Only the public columns of exams and exam_versions: no keys, no audio. The
// embedded versions are cut to the latest one in the database, so neither old
// versions nor the row limit of the API reach the page.
const CATALOG_COLUMNS = 'slug, title, format, exam_versions(version, content)';
const PAGE_SIZE = 200;

const latestVersion = (row: CatalogRow): CatalogVersionRow | null => {
  let latest: CatalogVersionRow | null = null;
  for (const candidate of row.exam_versions) {
    if (!latest || candidate.version > latest.version) latest = candidate;
  }
  return latest;
};

const toEntry = (row: CatalogRow): CatalogEntry | null => {
  const latest = latestVersion(row);
  if (!latest) return null;
  const parsed = examContentSchema.safeParse(latest.content);
  if (!parsed.success) return null;
  if (selectAttemptScope(row.format, parsed.data) !== 'full-exam') return null;
  const { hoeren, lesen } = DTZ_FULL_INVENTORY;
  return {
    slug: row.slug,
    title: row.title,
    format: row.format,
    hoerenCount: hoeren,
    lesenCount: lesen,
    totalCount: hoeren + lesen,
  };
};

const compareEntries = (a: CatalogEntry, b: CatalogEntry): number => {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
};

// An exam is listed only when its latest version is a full DTZ; an invalid or
// incomplete latest version hides the exam and is never replaced by an older
// one.
export const projectCatalog = (rows: readonly CatalogRow[]): CatalogEntry[] =>
  rows
    .map(toEntry)
    .filter((entry): entry is CatalogEntry => entry !== null)
    .sort(compareEntries);

const readPage = async (
  deps: ServerDeps,
  from: number,
): Promise<CatalogRow[]> => {
  const { data, error } = await deps.db
    .from('exams')
    .select(CATALOG_COLUMNS)
    .order('slug', { ascending: true })
    .order('version', { referencedTable: 'exam_versions', ascending: false })
    .limit(1, { referencedTable: 'exam_versions' })
    .range(from, from + PAGE_SIZE - 1)
    .returns<CatalogRow[]>();
  if (error) throw new Error('Catalog lookup failed', { cause: error });
  return data;
};

export const listCatalog = async (
  deps: ServerDeps,
): Promise<CatalogEntry[]> => {
  const rows: CatalogRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await readPage(deps, from);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return projectCatalog(rows);
};
