'use client';

import { createContext, useContext } from 'react';
import type { AttemptProgress, AttemptReview, Selections } from '@b1k/domain';

// What the block screens share with the training shell: the answers the
// server confirmed, whether a save is in flight, the finished review and the
// place of the guest. A progress report is saved by the shell: at once when
// the place changed, at most every 10 seconds while the recording plays.
export interface TrainingState {
  selections: Selections;
  review: AttemptReview | null;
  recordAnswer: (questionId: string, optionId: string) => void;
  setSaving: (isSaving: boolean) => void;
  readProgress: () => AttemptProgress | null;
  reportProgress: (patch: Partial<AttemptProgress>, isUrgent?: boolean) => void;
}

const NO_SELECTIONS: Selections = {};

// Outside the shell (single screens, component tests) nothing is shared.
export const TrainingContext = createContext<TrainingState>({
  selections: NO_SELECTIONS,
  review: null,
  recordAnswer: () => undefined,
  setSaving: () => undefined,
  readProgress: () => null,
  reportProgress: () => undefined,
});

export const useTraining = (): TrainingState => useContext(TrainingContext);
