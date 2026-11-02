import { redirect } from 'next/navigation';
import {
  getCurrentGuest,
  getServerDeps,
  readDefaultExamSlug,
  resolveExamEntry,
} from '../../server/next/request';

export const dynamic = 'force-dynamic';

// The M1 address of Hören. It continues the guest's own active attempt of
// the default exam at its own address, or opens the choice; it never starts.
const LegacyPracticePage = async () => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  redirect(
    await resolveExamEntry(
      getServerDeps(),
      guest,
      readDefaultExamSlug(),
      'hoeren',
    ),
  );
};

export default LegacyPracticePage;
