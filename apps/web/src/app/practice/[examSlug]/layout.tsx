import type { ReactNode } from 'react';
import { ExamAudioSession } from '../../../features/training/ExamAudioSession';

interface ExamLayoutProps {
  children: ReactNode;
  params: Promise<{ examSlug: string }>;
}

// The frame of one exam above its choice and its attempts. It holds only
// the one recording element of a full exam, so the recording prepared on
// the choice keeps playing when the attempt opens. It reads no guest,
// material, key or attempt: the pages below do, each with its own checks.
// The owner belongs to the slug: another exam gets a new owner, never the
// element of the previous one, while the choice and the attempts of the same
// exam share the one that is mounted.
const ExamLayout = async ({ children, params }: ExamLayoutProps) => {
  const { examSlug } = await params;
  return <ExamAudioSession key={examSlug}>{children}</ExamAudioSession>;
};

export default ExamLayout;
