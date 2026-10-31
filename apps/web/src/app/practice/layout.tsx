import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import { TrainingShell } from '../../features/training/TrainingShell';
import {
  finishAttemptAction,
  resolveAudioAction,
  restartAttemptAction,
  saveAnswerAction,
  saveProgressAction,
} from '../../server/next/actions';
import { getOpenedPractice } from '../../server/attempts/opened';
import { getCurrentGuest, getServerDeps } from '../../server/next/request';

export const dynamic = 'force-dynamic';

// One attempt, two block pages: the shell around them keeps the recording and
// the finish point while the guest moves between Hören and Lesen. A new run
// is another attempt: the key gives it a new shell, so the review, answers,
// place and players of the previous one are not carried over.
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
      key={practice.attemptId}
      attemptId={practice.attemptId}
      questions={practice.questions}
      trackIds={practice.trackIds}
      initialSelections={practice.selections}
      initialRevisions={practice.revisions}
      initialReview={practice.review}
      initialProgress={practice.progress}
      resolveAudio={resolveAudioAction}
      saveAnswer={saveAnswerAction}
      finishAttempt={finishAttemptAction}
      saveProgress={saveProgressAction}
      restartAttempt={restartAttemptAction}
    >
      {children}
    </TrainingShell>
  );
};

export default PracticeLayout;
