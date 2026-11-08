import { redirect } from 'next/navigation';
import { ExamLibrary } from '../../features/exams/ExamLibrary';
import { listCatalog } from '../../server/material/catalog';
import type { CatalogEntry } from '../../server/material/catalog';
import { getCurrentGuest, getServerDeps } from '../../server/next/request';

export const dynamic = 'force-dynamic';

const readEntries = async (): Promise<CatalogEntry[] | null> => {
  try {
    return await listCatalog(getServerDeps());
  } catch (error) {
    console.error({ error });
    return null;
  }
};

// The library of full DTZ exams. Reading it writes nothing: no session, no
// attempt, no start event. Without a guest the visitor goes to the home page.
const ExamsPage = async () => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const entries = await readEntries();
  return entries ? (
    <ExamLibrary entries={entries} />
  ) : (
    <ExamLibrary entries={[]} hasError />
  );
};

export default ExamsPage;
