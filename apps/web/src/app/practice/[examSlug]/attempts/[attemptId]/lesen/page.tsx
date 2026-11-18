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

// The one h1 of the page. On a phone the exam context line above already
// shows the exam title, so the heading is kept for screen readers and the
// document outline only and gives its space to the first task.
const PAGE_TITLE_SX = {
  '@media (max-width: 599.95px)': {
    position: 'absolute',
    width: '1px',
    height: '1px',
    m: '-1px',
    p: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
} as const;

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

  const { practice, state } = opened;
  // Before the Lesen phase of an open full exam this address has nothing:
  // the projection holds no Lesen task or text, and the guest is sent to the
  // phase that is open.
  const isEarly =
    state.mode === 'exam' &&
    state.status === 'active' &&
    state.phase !== 'lesen';
  if (isEarly) redirect(attemptPath(practice.examSlug, practice.attemptId));
  const hasLesen = practice.questions.some((item) => item.skill === 'lesen');
  if (!hasLesen) redirect(attemptPath(practice.examSlug, practice.attemptId));
  // A completed attempt shows its review from the shell at this address.
  if (practice.review) return null;

  return (
    <Stack spacing={{ xs: 1.5, sm: 3 }}>
      <Typography
        component="h1"
        variant="h5"
        lang="de"
        data-testid="page-title"
        sx={PAGE_TITLE_SX}
      >
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
