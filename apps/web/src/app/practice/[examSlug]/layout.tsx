import type { ReactNode } from 'react';
import { ExamAudioSession } from '../../../features/training/ExamAudioSession';

interface ExamLayoutProps {
  children: ReactNode;
}

// The frame of one exam above its choice and its attempts. It holds only
// the one recording element of a full exam, so the recording prepared on
// the choice keeps playing when the attempt opens. It reads no guest,
// material, key or attempt: the pages below do, each with its own checks.
const ExamLayout = ({ children }: ExamLayoutProps) => (
  <ExamAudioSession>{children}</ExamAudioSession>
);

export default ExamLayout;
