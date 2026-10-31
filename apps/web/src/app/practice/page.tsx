import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { AudioPlayer } from '../../features/audio/AudioPlayer';
import { PracticeSet } from '../../features/practice/PracticeSet';
import { openPractice } from '../../server/attempts/attempts';
import {
  finishAttemptAction,
  resolveAudioAction,
  saveAnswerAction,
} from '../../server/next/actions';
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
  const { source } = practice;

  return (
    <Stack spacing={3}>
      <Typography component="h1" variant="h5" lang="de">
        {practice.examTitle}
      </Typography>
      {practice.trackIds.map((trackId) => (
        <AudioPlayer
          key={trackId}
          resolveAudio={resolveAudioAction.bind(null, {
            attemptId: practice.attemptId,
            trackId,
          })}
        />
      ))}
      <PracticeSet
        attemptId={practice.attemptId}
        questions={practice.questions}
        initialSelections={practice.selections}
        initialReview={practice.review}
        saveAnswer={saveAnswerAction}
        finishAttempt={finishAttemptAction}
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
