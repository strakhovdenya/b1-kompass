import type { AttemptScope, ReviewItem } from './policy';

// Review of one completed attempt, as the server gives it to its owner. It
// exists only after completion: before that no key leaves the server.
export interface AttemptReview {
  attemptId: string;
  scope: AttemptScope;
  showsLevel: boolean;
  score: number;
  maxScore: number;
  percent: number;
  correct: number;
  incorrect: number;
  skipped: number;
  completedAt: string;
  items: ReviewItem[];
}

export type FinishAttemptError =
  | 'invalid-input'
  | 'session-invalid'
  | 'attempt-not-found'
  | 'unavailable';

export type FinishAttemptResult =
  | { ok: true; review: AttemptReview }
  | { ok: false; error: FinishAttemptError };

export type ReviewError =
  | 'invalid-input'
  | 'session-invalid'
  | 'attempt-not-found'
  | 'not-completed'
  | 'unavailable';

export type ReviewResult =
  | { ok: true; review: AttemptReview }
  | { ok: false; error: ReviewError };
