import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Alert from '@mui/material/Alert';
import { TrainingShell } from '../../../../../features/training/TrainingShell';
import { resolveAudioAction } from '../../../../../server/next/actions';
import { getOpenedAttempt } from '../../../../../server/attempts/opened';
import {
  getCurrentGuest,
  getServerDeps,
} from '../../../../../server/next/request';

export const dynamic = 'force-dynamic';

interface AttemptLayoutProps {
  children: ReactNode;
  params: Promise<{ examSlug: string; attemptId: string }>;
}

// One attempt, two block pages: the shell around them keeps the recording and
// the submission while the guest moves between Hören and Lesen. Another
// attempt has another address and so another shell; nothing is carried over.
const AttemptLayout = async ({ children, params }: AttemptLayoutProps) => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const { examSlug, attemptId } = await params;
  const opened = await getOpenedAttempt(
    getServerDeps(),
    guest,
    examSlug,
    attemptId,
  );
  if (opened.status === 'not-found') notFound();
  if (opened.status === 'incompatible') {
    const t = await getTranslations('choice');
    return (
      <Alert severity="error" data-testid="attempt-incompatible">
        {t('incompatible')}
      </Alert>
    );
  }

  const { practice, resultPending, phaseRevision } = opened;
  return (
    <TrainingShell
      key={practice.attemptId}
      examSlug={practice.examSlug}
      attemptId={practice.attemptId}
      questions={practice.questions}
      trackIds={practice.trackIds}
      initialSelections={practice.selections}
      initialRevisions={practice.revisions}
      initialReview={practice.review}
      initialProgress={practice.progress}
      isResultPending={resultPending}
      phaseRevision={phaseRevision}
      resolveAudio={resolveAudioAction}
    >
      {children}
    </TrainingShell>
  );
};

export default AttemptLayout;
