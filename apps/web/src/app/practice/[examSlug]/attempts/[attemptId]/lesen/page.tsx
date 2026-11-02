import { redirect } from 'next/navigation';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { LesenScreen } from '../../../../../../features/lesen/LesenScreen';
import { attemptPath } from '../../../../../../features/training/attempt-client';
import { getOpenedAttempt } from '../../../../../../server/attempts/opened';
import {
  getCurrentGuest,
  getServerDeps,
} from '../../../../../../server/next/request';

export const dynamic = 'force-dynamic';

interface LesenPageProps {
  params: Promise<{ examSlug: string; attemptId: string }>;
}

const LesenPage = async ({ params }: LesenPageProps) => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const { examSlug, attemptId } = await params;
  const opened = await getOpenedAttempt(
    getServerDeps(),
    guest,
    examSlug,
    attemptId,
  );
  if (opened.status !== 'ready') return null;

  const { practice } = opened;
  const hasLesen = practice.questions.some((item) => item.skill === 'lesen');
  if (!hasLesen) redirect(attemptPath(practice.examSlug, practice.attemptId));
  // A completed attempt shows its review from the shell at this address.
  if (practice.review) return null;

  return (
    <Stack spacing={3}>
      <Typography component="h1" variant="h5" lang="de">
        {practice.examTitle}
      </Typography>
      <LesenScreen
        questions={practice.questions}
        texts={practice.texts}
        initialSelections={practice.selections}
      />
    </Stack>
  );
};

export default LesenPage;
