import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { QuestionCard } from '../../features/practice/QuestionCard';
import { openPractice } from '../../server/attempts/attempts';
import { saveAnswerAction } from '../../server/next/actions';
import { getCurrentGuest, getServerDeps } from '../../server/next/request';

export const dynamic = 'force-dynamic';

const PracticePage = async () => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const t = await getTranslations('practice');
  const opened = await openPractice(getServerDeps(), guest);
  if (opened.status === 'session-invalid') redirect('/');
  if (opened.status === 'no-material') {
    return <Alert severity="warning">{t('unavailable')}</Alert>;
  }

  const { practice } = opened;
  const { question, selections, source } = practice;

  return (
    <Stack spacing={3}>
      <Typography component="h1" variant="h5" lang="de">
        {practice.examTitle}
      </Typography>
      <QuestionCard
        attemptId={practice.attemptId}
        question={question}
        initialOptionId={selections[question.id] ?? null}
        saveAnswer={saveAnswerAction}
      />
      <Typography variant="body2" color="text.secondary">
        {t('source', {
          publisher: source.publisher,
          title: source.title,
          page: source.page,
        })}
      </Typography>
    </Stack>
  );
};

export default PracticePage;
