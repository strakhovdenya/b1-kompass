import { z } from 'zod';
import {
  attemptProgressSchema,
  contextIdsOf,
  resolveLifecycle,
  toPublicContext,
} from '@b1k/domain';
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
  PublicContextItem,
  Selections,
  Skill,
} from '@b1k/domain';
import type {
  AttemptSummary,
  SkillSummary,
} from '../../features/training/attempt-client';

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
  // Neighbours of an assigned task in its Teil 3 pair or Teil 4 shared set:
  // shown read-only, never answered, scored or reviewed; no key, no answer.
  context: PublicContextItem[];
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
  // The explicit early start of Lesen of an exam; null or absent otherwise.
  lesenStartedAt?: string | null;
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
// The stored facts the lifecycle is judged from; every reader (page, status,
// commands, the audio gate) maps them the same way.
export type StoredLifecycle = Pick<
  AttemptRunView,
  | 'mode'
  | 'selection'
  | 'status'
  | 'acceptedAt'
  | 'durations'
  | 'lesenStartedAt'
>;

export const toLifecycleState = (
  view: StoredLifecycle,
  atMs: number,
): LifecycleState | null => {
  const startedAtMs = Date.parse(view.acceptedAt);
  const lesenStartedAtMs = view.lesenStartedAt
    ? Date.parse(view.lesenStartedAt)
    : null;
  const result = resolveLifecycle(
    {
      mode: view.mode,
      selection: view.selection,
      status: view.status,
      startedAtMs,
      durations: view.durations,
      closedSkills: [],
      lesenStartedAtMs,
    },
    Math.max(atMs, startedAtMs),
  );
  return result.ok ? result.state : null;
};

const ALL_SKILLS: readonly Skill[] = ['hoeren', 'lesen'];

// Whether the Lesen of an exam had started by the moment its run was
// closed (submitted or closed by its deadline); never for an open run.
export const hasLesenOpened = (
  view: StoredLifecycle,
  closedAt: string | null,
): boolean => {
  if (view.mode !== 'exam' || closedAt === null) return false;
  const { hoerenMs = 0, transitionMs = 0 } = view.durations;
  const lesenStartMs = view.lesenStartedAt
    ? Date.parse(view.lesenStartedAt)
    : Date.parse(view.acceptedAt) + hoerenMs + transitionMs;
  return Date.parse(closedAt) >= lesenStartMs;
};

// The skills whose material the public projection of the run may carry.
// Every free or timed run and a completed exam (its review) carry their
// whole assignment. An open exam carries only its trusted phase: Hören
// during Hören and the transition (already given, no longer answerable),
// Lesen only once Lesen has started; an exam past its end that is not
// closed yet carries nothing. A closed exam whose result is not stored yet
// carries Lesen only if Lesen had started before it closed: an early
// submission never reveals a Lesen that was not opened. The internal
// assignment of all tasks stays on the server for scoring.
export const visibleSkillsOf = (
  state: LifecycleState,
  isLesenOpened = false,
): readonly Skill[] => {
  if (state.mode !== 'exam' || state.status === 'completed') return ALL_SKILLS;
  if (state.status !== 'active') {
    return isLesenOpened ? ALL_SKILLS : ['hoeren'];
  }
  if (state.phase === 'hoeren' || state.phase === 'transition') {
    return ['hoeren'];
  }
  return state.phase === 'lesen' ? ['lesen'] : [];
};

const partOf = (state: LifecycleState, skill: Skill): SkillSummary['state'] => {
  if (state.openSkills.includes(skill)) return 'open';
  if (state.closedSkills.includes(skill)) return 'closed';
  return state.mode === 'exam' ? 'unopened' : 'closed';
};

// Plain numbers of the whole assignment, per skill: how many tasks are
// assigned and answered and whether the part is open, closed or not opened
// yet. It names no task, text or key: a confirmation counts the tasks of a
// Lesen the guest has not seen without receiving them.
export const toAttemptSummary = (
  questionIds: readonly string[],
  content: ExamContent,
  state: LifecycleState,
  answers: Selections,
): AttemptSummary => {
  const assigned = new Set(questionIds);
  const counts = {
    hoeren: { assigned: 0, answered: 0 },
    lesen: { assigned: 0, answered: 0 },
  };
  for (const question of content.questions) {
    if (!assigned.has(question.id)) continue;
    const count = counts[question.skill];
    count.assigned += 1;
    if (Object.hasOwn(answers, question.id)) count.answered += 1;
  }
  return {
    totalAssigned: questionIds.length,
    skills: {
      hoeren: { ...counts.hoeren, state: partOf(state, 'hoeren') },
      lesen: { ...counts.lesen, state: partOf(state, 'lesen') },
    },
  };
};

const pickIds = <Value>(
  record: Readonly<Record<string, Value>>,
  ids: ReadonlySet<string>,
): Record<string, Value> => {
  const picked: Record<string, Value> = {};
  for (const [id, value] of Object.entries(record)) {
    if (ids.has(id)) picked[id] = value;
  }
  return picked;
};

// The tasks of the assignment whose skill is visible: the public part of
// the run. The caller projects only these.
export const visibleQuestionIds = (
  questionIds: readonly string[],
  content: ExamContent,
  state: LifecycleState,
  isLesenOpened = false,
): readonly string[] => {
  const skills = visibleSkillsOf(state, isLesenOpened);
  const visible = new Set(
    content.questions
      .filter((item) => skills.includes(item.skill))
      .map((item) => item.id),
  );
  return questionIds.filter((id) => visible.has(id));
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

// The read-only neighbours of an open repeat of errors. A normal attempt
// assigns whole groups and has none; a review shows the assigned tasks only.
const contextOf = (input: PracticeInput, assigned: ReadonlySet<string>) => {
  const { view, content } = input;
  if (view.purpose !== 'error-repeat' || input.review) return [];
  const contextIds = contextIdsOf(content, assigned);
  return toPublicContext(content, { contextIds });
};

// Only the given tasks of the pinned version, without the key. Groups,
// texts, recordings and answers of other tasks stay on the server; a
// neighbour of a repeat is passed as public context only. A Lesen text comes
// with its assigned tasks, never with the other tasks of that text. An open
// exam passes only the tasks of its visible phase (visibleQuestionIds).
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
    selections: pickIds(input.selections, assigned),
    revisions: pickIds(input.revisions, assigned),
    trackIds: hasHoeren ? input.trackIds : [],
    context: contextOf(input, assigned),
    review,
    progress: review ? null : parseStoredProgress(input.progress),
  };
};
