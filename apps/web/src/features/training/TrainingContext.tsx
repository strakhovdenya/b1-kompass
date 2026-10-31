'use client';

import { createContext, useContext } from 'react';
import type { AttemptProgress, AttemptReview, Selections } from '@b1k/domain';
import type { PendingAnswers } from './answers';

// What the block screens share with the training shell: the answers the
// server confirmed, the choices it has not confirmed yet (in flight or
// refused), the finished review and the place of the guest. Answers are
// chosen and retried through the shell, which keeps their order; a progress
// report is saved by the shell: at once when the place changed, at most every
// 10 seconds while the recording plays.
export interface TrainingState {
  selections: Selections;
  pending: PendingAnswers;
  review: AttemptReview | null;
  choose: (questionId: string, optionId: string) => void;
  retry: (questionId: string) => void;
  readProgress: () => AttemptProgress | null;
  reportProgress: (patch: Partial<AttemptProgress>, isUrgent?: boolean) => void;
}

const NO_SELECTIONS: Selections = {};
const NO_PENDING: PendingAnswers = {};

// Outside the shell (single screens, component tests) nothing is shared.
export const TrainingContext = createContext<TrainingState>({
  selections: NO_SELECTIONS,
  pending: NO_PENDING,
  review: null,
  choose: () => undefined,
  retry: () => undefined,
  readProgress: () => null,
  reportProgress: () => undefined,
});

export const useTraining = (): TrainingState => useContext(TrainingContext);
