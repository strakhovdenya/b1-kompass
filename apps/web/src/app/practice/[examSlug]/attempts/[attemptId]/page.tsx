import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { HoerenSingleScreen } from '../../../../../features/hoeren/HoerenSingleScreen';
import { attemptLesenPath } from '../../../../../features/training/attempt-client';
import { getOpenedAttempt } from '../../../../../server/attempts/opened';
import {
  getCurrentGuest,
  getServerDeps,
} from '../../../../../server/next/request';

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

interface HoerenPageProps {
  params: Promise<{ examSlug: string; attemptId: string }>;
}

const HoerenPage = async ({ params }: HoerenPageProps) => {
  const guest = await getCurrentGuest();
  if (!guest) redirect('/');
  const { examSlug, attemptId } = await params;
  const opened = await getOpenedAttempt(
    getServerDeps(),
    guest,
    examSlug,
    attemptId,
  );
  // The layout shows the refusal; the page renders nothing of its own.
  if (opened.status !== 'ready') return null;

  const { practice, state } = opened;
  // An open full exam follows its trusted phase: in Lesen its work is at the
  // Lesen address; in the transition the shell shows the pause and this
  // page sends no material of its own.
  if (state.mode === 'exam' && state.status === 'active') {
    if (state.phase === 'lesen') {
      redirect(attemptLesenPath(practice.examSlug, practice.attemptId));
    }
    if (state.phase !== 'hoeren') return null;
  }
  // A Lesen-only attempt has no Hören block: its work is at the Lesen address.
  const hasHoeren = practice.questions.some((item) => item.skill === 'hoeren');
  const hasLesen = practice.questions.some((item) => item.skill === 'lesen');
  if (!hasHoeren && hasLesen && !practice.review) {
    redirect(attemptLesenPath(practice.examSlug, practice.attemptId));
  }
  // A completed attempt shows its review from the shell; the block is not
  // rendered, so the key-free material is not sent a second time.
  if (practice.review) return null;
  const t = await getTranslations('practice');
  const { source } = practice;

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
      <HoerenSingleScreen
        questions={practice.questions}
        groups={practice.groups}
        context={practice.context}
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

export default HoerenPage;
