import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import { ExamContextHeader } from '../../../features/training/ExamContextHeader';
import { ModeSelection } from '../../../features/training/ModeSelection';
import { readExamChoice } from '../../../server/attempts/read';
import { replaceGuestAction } from '../../../server/next/actions';
import { getCurrentGuest, getServerDeps } from '../../../server/next/request';

export const dynamic = 'force-dynamic';

interface ChoicePageProps {
  params: Promise<{ examSlug: string }>;
}

// The choice of one exam. Reading it, prefetching it or switching the
// language writes nothing; a start is a separate command of the button.
const ChoicePage = async ({ params }: ChoicePageProps) => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const { examSlug } = await params;
  const choice = await readExamChoice(getServerDeps(), guest, examSlug);
  // An unknown exam or one without a published version: the same notice
  // as before the choice existed, not a bare 404.
  if (!choice) {
    const t = await getTranslations('practice');
    return (
      <Alert severity="warning" data-testid="practice-unavailable">
        {t('unavailable')}
      </Alert>
    );
  }
  // The context line shows the title the server read for this slug, nothing
  // from the address or the browser.
  return (
    <Stack spacing={1} sx={{ maxWidth: 720, mx: 'auto', minWidth: 0 }}>
      <ExamContextHeader examTitle={choice.examTitle} />
      <ModeSelection
        examSlug={choice.examSlug}
        examTitle={choice.examTitle}
        versionId={choice.versionId}
        questionCount={choice.questionCount}
        hoerenCount={choice.hoerenCount}
        lesenCount={choice.lesenCount}
        activeAttemptId={choice.activeAttemptId}
        examTiming={choice.examTiming}
        replaceGuest={replaceGuestAction}
      />
    </Stack>
  );
};

export default ChoicePage;
