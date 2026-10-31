import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { LesenScreen } from '../../../features/lesen/LesenScreen';
import { openPractice } from '../../../server/attempts/attempts';
import { saveAnswerAction } from '../../../server/next/actions';
import { getCurrentGuest, getServerDeps } from '../../../server/next/request';

export const dynamic = 'force-dynamic';

const LesenPage = async () => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const t = await getTranslations('practice');
  const opened = await openPractice(
    getServerDeps(),
    guest,
    process.env.PRACTICE_EXAM_SLUG,
  );
  if (opened.status === 'session-invalid') redirect('/');
  if (opened.status === 'no-material') {
    return <Alert severity="warning">{t('unavailable')}</Alert>;
  }

  const { practice } = opened;
  const hasLesen = practice.questions.some((item) => item.skill === 'lesen');
  if (!hasLesen || practice.review) redirect('/practice');

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
