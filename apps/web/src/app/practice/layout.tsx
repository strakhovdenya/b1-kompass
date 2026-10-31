import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import { TrainingShell } from '../../features/training/TrainingShell';
import {
  finishAttemptAction,
  resolveAudioAction,
} from '../../server/next/actions';
import { getOpenedPractice } from '../../server/attempts/opened';
import { getCurrentGuest, getServerDeps } from '../../server/next/request';

export const dynamic = 'force-dynamic';

// One attempt, two block pages: the shell around them keeps the recording and
// the finish point while the guest moves between Hören and Lesen.
const PracticeLayout = async ({ children }: { children: ReactNode }) => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const opened = await getOpenedPractice(
    getServerDeps(),
    guest,
    process.env.PRACTICE_EXAM_SLUG,
  );
  if (opened.status === 'session-invalid') redirect('/');
  if (opened.status === 'no-material') {
    const t = await getTranslations('practice');
    return <Alert severity="warning">{t('unavailable')}</Alert>;
  }

  const { practice } = opened;
  return (
    <TrainingShell
      attemptId={practice.attemptId}
      questions={practice.questions}
      trackIds={practice.trackIds}
      initialSelections={practice.selections}
      initialReview={practice.review}
      resolveAudio={resolveAudioAction}
      finishAttempt={finishAttemptAction}
    >
      {children}
    </TrainingShell>
  );
};

export default PracticeLayout;
