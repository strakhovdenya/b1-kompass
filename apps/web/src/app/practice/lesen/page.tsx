import { redirect } from 'next/navigation';
import {
  getCurrentGuest,
  getServerDeps,
  readDefaultExamSlug,
  resolveExamEntry,
} from '../../../server/next/request';

export const dynamic = 'force-dynamic';

// The M1 address of Lesen: the Lesen page of the guest's own active attempt
// of the default exam, or the choice. It never starts an attempt.
const LegacyLesenPage = async () => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  redirect(
    await resolveExamEntry(
      getServerDeps(),
      guest,
      readDefaultExamSlug(),
      'lesen',
    ),
  );
};

export default LegacyLesenPage;
