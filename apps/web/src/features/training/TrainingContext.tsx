'use client';

import { createContext, useContext } from 'react';
import type { AttemptReview, Selections } from '@b1k/domain';

// What the block screens share with the training shell: the answers the
// server confirmed, whether a save is in flight, and the finished review.
export interface TrainingState {
  selections: Selections;
  review: AttemptReview | null;
  recordAnswer: (questionId: string, optionId: string) => void;
  setSaving: (isSaving: boolean) => void;
}

const NO_SELECTIONS: Selections = {};

// Outside the shell (single screens, component tests) nothing is shared.
export const TrainingContext = createContext<TrainingState>({
  selections: NO_SELECTIONS,
  review: null,
  recordAnswer: () => undefined,
  setSaving: () => undefined,
});

export const useTraining = (): TrainingState => useContext(TrainingContext);
