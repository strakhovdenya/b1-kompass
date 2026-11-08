import { redirect } from 'next/navigation';
import { ExamLibrary } from '../../features/exams/ExamLibrary';
import { listLibrary } from '../../server/material/catalog';
import type { LibraryCard } from '../../server/material/catalog';
import type { GuestContext } from '../../server/guest-session/session';
import { getCurrentGuest, getServerDeps } from '../../server/next/request';

export const dynamic = 'force-dynamic';

const readEntries = async (
  guest: GuestContext,
): Promise<LibraryCard[] | null> => {
  try {
    return await listLibrary(getServerDeps(), guest);
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
  const entries = await readEntries(guest);
  return entries ? (
    <ExamLibrary entries={entries} />
  ) : (
    <ExamLibrary entries={[]} hasError />
  );
};

export default ExamsPage;
