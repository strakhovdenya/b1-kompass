import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { HoerenSingleScreen } from '../../features/hoeren/HoerenSingleScreen';
import { getOpenedPractice } from '../../server/attempts/opened';
import { getCurrentGuest, getServerDeps } from '../../server/next/request';

export const dynamic = 'force-dynamic';

const PracticePage = async () => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const opened = await getOpenedPractice(
    getServerDeps(),
    guest,
    process.env.PRACTICE_EXAM_SLUG,
  );
  if (opened.status === 'session-invalid') redirect('/');
  if (opened.status === 'no-material') return null;

  const { practice } = opened;
  // A completed attempt shows its review from the shell; the block is not
  // rendered, so the key-free material is not sent a second time.
  if (practice.review) return null;
  const t = await getTranslations('practice');
  const { source } = practice;

  return (
    <Stack spacing={3}>
      <Typography component="h1" variant="h5" lang="de">
        {practice.examTitle}
      </Typography>
      <HoerenSingleScreen
        questions={practice.questions}
        groups={practice.groups}
        initialSelections={practice.selections}
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
