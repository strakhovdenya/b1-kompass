import { redirect } from 'next/navigation';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { LesenScreen } from '../../../features/lesen/LesenScreen';
import { saveAnswerAction } from '../../../server/next/actions';
import { getOpenedPractice } from '../../../server/next/request';

export const dynamic = 'force-dynamic';

const LesenPage = async () => {
  const opened = await getOpenedPractice();
  if (!opened || opened.status === 'session-invalid') redirect('/');
  if (opened.status === 'no-material') return null;

  const { practice } = opened;
  const hasLesen = practice.questions.some((item) => item.skill === 'lesen');
  if (!hasLesen) redirect('/practice');
  // A completed attempt shows its review from the shell at this address.
  if (practice.review) return null;

  return (
    <Stack spacing={3}>
      <Typography component="h1" variant="h5" lang="de">
        {practice.examTitle}
      </Typography>
      <LesenScreen
        attemptId={practice.attemptId}
        questions={practice.questions}
        texts={practice.texts}
        initialSelections={practice.selections}
        saveAnswer={saveAnswerAction}
      />
    </Stack>
  );
};

export default LesenPage;
