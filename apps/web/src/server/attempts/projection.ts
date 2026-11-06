import { z } from 'zod';
import { attemptProgressSchema, resolveLifecycle } from '@b1k/domain';
import type {
  AttemptProgress,
  AttemptReview,
  AttemptScope,
  ExamContent,
  ExamGroup,
  ExamQuestion,
  ExamText,
  LifecycleDurations,
  LifecycleState,
  Selections,
} from '@b1k/domain';

// Plain-data projections of a stored attempt. Inputs are rows already
// authorized by the reader; nothing here reads the database or the key.

export interface PracticeState {
  attemptId: string;
  examSlug: string;
  versionId: string;
  examTitle: string;
  source: ExamContent['source'];
  questions: ExamQuestion[];
  groups: ExamGroup[];
  texts: ExamText[];
  selections: Selections;
  // The revision of every stored answer: the next choice continues above it.
  revisions: Readonly<Record<string, number>>;
  trackIds: string[];
  review: AttemptReview | null;
  // Where the guest stopped; null for a completed attempt.
  progress: AttemptProgress | null;
}

// The stable contract of one stored attempt: identity and pinned version
// from attempts, mode, purpose and the assigned tasks from its run.
export interface AttemptRunView {
  attemptId: string;
  examId: string;
  examSlug: string;
  versionId: string;
  scope: AttemptScope;
  status: string;
  mode: string;
  purpose: string;
  selection: string;
  sourceAttemptId: string | null;
  questionIds: readonly string[];
  acceptedAt: string;
  // The durations of the pinned timing profile; empty for a free training.
  durations: LifecycleDurations;
  // The run was closed by its deadline, not by a submission of the guest.
  isClosedByDeadline: boolean;
}

const SECONDS_MS = 1000;

const pinnedSchema = z.object({
  hoerenSeconds: z.int().positive(),
  transitionSeconds: z.int().positive(),
  lesenSeconds: z.int().positive(),
});

// The durations of the timing snapshot pinned at the start, in
// milliseconds. A run without a pin has none; a pin that does not parse is
// not trusted (null), so its deadline is never guessed.
export const parsePinnedDurations = (
  stored: unknown,
): LifecycleDurations | null => {
  if (stored === null || stored === undefined) return {};
  const parsed = pinnedSchema.safeParse(stored);
  if (!parsed.success) return null;
  const { hoerenSeconds, transitionSeconds, lesenSeconds } = parsed.data;
  return {
    hoerenMs: hoerenSeconds * SECONDS_MS,
    transitionMs: transitionSeconds * SECONDS_MS,
    lesenMs: lesenSeconds * SECONDS_MS,
  };
};

const assignmentSchema = z.object({
  versionId: z.uuid(),
  questionIds: z.array(z.string().min(1).max(100)).min(1),
});

// The assignment snapshot of a run. It must name the pinned version of its
// attempt and list each task once; anything else is not trusted.
export const parseAssignment = (
  stored: unknown,
  pinnedVersionId: string,
): readonly string[] | null => {
  const parsed = assignmentSchema.safeParse(stored);
  if (!parsed.success) return null;
  const { versionId, questionIds } = parsed.data;
  if (versionId !== pinnedVersionId) return null;
  if (new Set(questionIds).size !== questionIds.length) return null;
  return questionIds;
};

// A stored place that no longer fits the schema is dropped, so a bad row can
// never break the page; the guest starts at the beginning.
export const parseStoredProgress = (
  stored: unknown,
): AttemptProgress | null => {
  const parsed = attemptProgressSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
};

// The public lifecycle snapshot of the run at atMs: for a timed run the
// moment the database reported, so its deadline and remaining time are the
// server's. The moment is never earlier than the start, whichever clock read
// it. A closed timed run is closed whatever the moment.
export const toLifecycleState = (
  view: AttemptRunView,
  atMs: number,
): LifecycleState | null => {
  const startedAtMs = Date.parse(view.acceptedAt);
  const result = resolveLifecycle(
    {
      mode: view.mode,
      selection: view.selection,
      status: view.status,
      startedAtMs,
      durations: view.durations,
      closedSkills: [],
      lesenStartedAtMs: null,
    },
    Math.max(atMs, startedAtMs),
  );
  return result.ok ? result.state : null;
};

export interface PracticeInput {
  view: AttemptRunView;
  examTitle: string;
  content: ExamContent;
  selections: Selections;
  revisions: Readonly<Record<string, number>>;
  trackIds: string[];
  review: AttemptReview | null;
  progress: unknown;
}

// Only the assigned tasks of the pinned version, without the key. Groups,
// texts and recordings of tasks that are not assigned stay on the server.
export const toPracticeState = (input: PracticeInput): PracticeState => {
  const { view, content, review } = input;
  const assigned = new Set(view.questionIds);
  const questions = content.questions.filter((item) => assigned.has(item.id));
  const textIds = new Set(questions.map((item) => item.textId));
  const hasHoeren = questions.some((item) => item.skill === 'hoeren');
  return {
    attemptId: view.attemptId,
    examSlug: view.examSlug,
    versionId: view.versionId,
    examTitle: input.examTitle,
    source: content.source,
    questions,
    groups: (content.groups ?? []).filter((group) =>
      group.questionIds.some((id) => assigned.has(id)),
    ),
    texts: (content.texts ?? []).filter((text) => textIds.has(text.id)),
    selections: input.selections,
    revisions: input.revisions,
    trackIds: hasHoeren ? input.trackIds : [],
    review,
    progress: review ? null : parseStoredProgress(input.progress),
  };
};
