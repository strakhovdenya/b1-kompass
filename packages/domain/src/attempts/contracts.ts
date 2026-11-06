export const ATTEMPT_MODES = ['training', 'timed-block', 'exam'] as const;
export type AttemptMode = (typeof ATTEMPT_MODES)[number];

export const ATTEMPT_PURPOSES = ['normal', 'error-repeat'] as const;
export type AttemptPurpose = (typeof ATTEMPT_PURPOSES)[number];

export const ATTEMPT_SELECTIONS = ['all', 'hoeren', 'lesen'] as const;
export type AttemptSelection = (typeof ATTEMPT_SELECTIONS)[number];

export const ATTEMPT_STATUSES = [
  'active',
  'submitted',
  'completed',
  'cancelled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const SKILLS = ['hoeren', 'lesen'] as const;
export type Skill = (typeof SKILLS)[number];

// 'open' is the free practice: no phases, no deadline.
export type AttemptPhase = 'open' | Skill | 'transition' | 'closed';

// Durations are positive milliseconds. Absolute times (startedAtMs,
// lesenStartedAtMs, `at`) are finite UTC epoch milliseconds. Converting
// TIMESTAMPTZ and profile units is the job of the server boundary.
export interface LifecycleDurations {
  readonly hoerenMs?: number;
  readonly transitionMs?: number;
  readonly lesenMs?: number;
}

// Plain data stored by the server. Mode, selection and status are strings:
// they arrive from the database and are validated here, not trusted.
export interface LifecycleInput {
  readonly mode: string;
  readonly selection: string;
  readonly status: string;
  readonly startedAtMs: number;
  readonly durations: LifecycleDurations;
  readonly closedSkills: readonly string[];
  readonly lesenStartedAtMs: number | null;
}

export interface LifecycleState {
  readonly mode: AttemptMode;
  readonly selection: AttemptSelection;
  readonly status: AttemptStatus;
  readonly phase: AttemptPhase;
  readonly phaseRevision: number;
  readonly openSkills: readonly Skill[];
  readonly closedSkills: readonly Skill[];
  readonly startedAtMs: number;
  readonly lesenStartedAtMs: number | null;
  // End of the current phase; null for free practice and a closed attempt.
  readonly deadlineMs: number | null;
  // End of the whole attempt; null for free practice.
  readonly endsAtMs: number | null;
  readonly remainingMs: number | null;
}

export type LifecycleError =
  | 'unknown-mode'
  | 'unknown-selection'
  | 'unknown-status'
  | 'invalid-combination'
  | 'invalid-duration'
  | 'invalid-time'
  | 'invalid-state'
  | 'invalid-operation';

export type LifecycleResult =
  { ok: true; state: LifecycleState } | { ok: false; error: LifecycleError };

export type AttemptOperation =
  | { kind: 'answer'; skill: string }
  | { kind: 'submit' }
  | { kind: 'cancel' }
  | { kind: 'begin-lesen' };

export type AdmissionRefusal =
  'closed-phase' | 'phase-not-open' | 'skill-not-open';

// A refusal carries the unchanged snapshot. `changed` is false for an
// accepted no-op. Acceptance is not authorization: the server still checks
// the guest session, the owner and the assignment.
export type AdmissionResult =
  | { ok: true; changed: boolean; state: LifecycleState }
  | { ok: false; reason: AdmissionRefusal; state: LifecycleState }
  | { ok: false; reason: 'invalid-input'; error: LifecycleError };

// Public command DTOs. Each command lists only the business outcomes that
// apply to it; technical failures travel in a separate channel and never
// share a variant with a business outcome. 'guest-too-short' refuses a timed
// start whose guest session would end before the block plus its reserve;
// the policy of that reserve belongs to the trusted server, not here.
export type RunTechnicalFailure =
  | 'invalid-input'
  | 'session-invalid'
  | 'not-found'
  | 'unavailable'
  | 'not-enabled'
  | 'guest-too-short';

export type CommandResult<Outcome> =
  { ok: true; result: Outcome } | { ok: false; failure: RunTechnicalFailure };

// The snapshot is the actual state of the attempt, also for a repeated or
// refused command.
interface OutcomeOf<Kind extends string> {
  readonly outcome: Kind;
  readonly attemptId: string;
  readonly state: LifecycleState;
}

export type StartOutcome = OutcomeOf<'accepted' | 'conflict'>;

export type SubmitOutcome =
  | OutcomeOf<
      | 'accepted'
      | 'result-pending'
      | 'conflict'
      | 'closed-phase'
      | 'stale-confirmation'
    >
  | { readonly outcome: 'result-ready'; readonly attemptId: string };

export type CancelOutcome = OutcomeOf<
  'accepted' | 'conflict' | 'closed-phase' | 'stale-confirmation'
>;

// `changed` is false for the accepted no-op of an already active Lesen.
export type BeginLesenOutcome =
  | (OutcomeOf<'accepted'> & { readonly changed: boolean })
  | OutcomeOf<'phase-not-open' | 'closed-phase'>;
