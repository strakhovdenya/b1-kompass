import type { Selections } from '../answers/save-result';
import type {
  AnswerKeys,
  ExamContent,
  ExamOption,
  ExamQuestion,
} from '../material/schema';
import { isFullDtzInventory, selectAttemptScope } from '../scoring/dtz';
import { selectScoringPolicy } from '../scoring/policy';
import type { AttemptScope, AttemptScore } from '../scoring/policy';
import { ATTEMPT_SELECTIONS } from './contracts';
import type {
  AdmissionResult,
  AttemptPurpose,
  AttemptSelection,
  BeginLesenOutcome,
  CommandResult,
} from './contracts';

// The tasks one attempt checks, fixed when the attempt is created. Only
// `questionIds` count for the maximum; `contextIds` are neighbours of a shared
// recording that are shown but never scored.
export interface AttemptAssignment {
  readonly format: string;
  readonly versionId: string;
  readonly scope: AttemptScope;
  readonly selection: AttemptSelection;
  readonly purpose: AttemptPurpose;
  readonly questionIds: readonly string[];
  readonly contextIds: readonly string[];
}

export type AssignmentError =
  | 'unknown-selection'
  | 'empty'
  | 'duplicate-question'
  | 'unknown-question'
  | 'foreign-version'
  | 'invalid-assignment'
  | 'invalid-scope'
  | 'missing-key'
  | 'unsupported-format';

export type AssignmentResult =
  | { ok: true; assignment: AttemptAssignment }
  | { ok: false; error: AssignmentError };

export type AssignmentScoreResult =
  { ok: true; score: AttemptScore } | { ok: false; error: AssignmentError };

interface Material {
  readonly format: string;
  readonly versionId: string;
  readonly content: ExamContent;
}

const fail = (
  error: AssignmentError,
): { ok: false; error: AssignmentError } => ({
  ok: false,
  error,
});

const isSelection = (value: string): value is AttemptSelection =>
  ATTEMPT_SELECTIONS.some((selection) => selection === value);

const hasDuplicates = (ids: readonly string[]): boolean =>
  new Set(ids).size !== ids.length;

const contextIdsOf = (
  content: ExamContent,
  assigned: ReadonlySet<string>,
): string[] => {
  const known = new Set(content.questions.map((question) => question.id));
  const context = new Set<string>();
  for (const group of content.groups ?? []) {
    if (!group.questionIds.some((id) => assigned.has(id))) continue;
    for (const id of group.questionIds) {
      if (known.has(id) && !assigned.has(id)) context.add(id);
    }
  }
  return [...context];
};

interface Draft {
  readonly scope: AttemptScope;
  readonly selection: AttemptSelection;
  readonly purpose: AttemptPurpose;
  readonly questionIds: readonly string[];
}

const create = (material: Material, draft: Draft): AssignmentResult => {
  const { format, versionId, content } = material;
  const assigned = new Set(draft.questionIds);
  const contextIds = contextIdsOf(content, assigned);
  return { ok: true, assignment: { format, versionId, ...draft, contextIds } };
};

// A new normal attempt. Only the whole version of a DTZ set with exactly 20
// Hören and 25 Lesen tasks is a full exam; every other composition, also a
// single skill, is a short set without a level.
export const buildAssignment = (
  material: Material & { readonly selection: string },
): AssignmentResult => {
  const { selection, content } = material;
  if (!isSelection(selection)) return fail('unknown-selection');
  const ids = content.questions.map((question) => question.id);
  if (hasDuplicates(ids)) return fail('duplicate-question');
  const picked = content.questions.filter(
    (question) => selection === 'all' || question.skill === selection,
  );
  if (picked.length === 0) return fail('empty');
  if (!selectScoringPolicy(material.format, 'short-set')) {
    return fail('unsupported-format');
  }
  const scope =
    selection === 'all'
      ? selectAttemptScope(material.format, content)
      : 'short-set';
  const questionIds = picked.map((question) => question.id);
  return create(material, { scope, selection, purpose: 'normal', questionIds });
};

export interface ScoreAssignmentInput {
  readonly assignment: AttemptAssignment;
  readonly versionId: string;
  readonly content: ExamContent;
  readonly keys: AnswerKeys;
  readonly selections: Selections;
}

const isFullShape = (
  assignment: AttemptAssignment,
  questions: readonly ExamQuestion[],
): boolean =>
  assignment.selection === 'all' &&
  assignment.purpose === 'normal' &&
  isFullDtzInventory(questions);

const findProblem = (
  input: ScoreAssignmentInput,
  questions: readonly (ExamQuestion | undefined)[],
): AssignmentError | null => {
  const { assignment, keys } = input;
  const ids = assignment.questionIds;
  if (assignment.versionId !== input.versionId) return 'foreign-version';
  if (ids.length === 0) return 'empty';
  if (hasDuplicates(ids)) return 'duplicate-question';
  if (questions.includes(undefined)) return 'unknown-question';
  const known = new Set(input.content.questions.map((q) => q.id));
  const isContextBroken = assignment.contextIds.some(
    (id) => ids.includes(id) || !known.has(id),
  );
  if (isContextBroken) {
    return 'invalid-assignment';
  }
  if (ids.some((id) => !Object.hasOwn(keys, id))) return 'missing-key';
  return null;
};

// Scores exactly the assigned tasks. Answers and keys of every other task of
// the version are ignored; an invalid assignment is refused, not repaired.
export const scoreAssignment = (
  input: ScoreAssignmentInput,
): AssignmentScoreResult => {
  const { assignment, content, keys, selections } = input;
  const byId = new Map(content.questions.map((q) => [q.id, q] as const));
  const found = assignment.questionIds.map((id) => byId.get(id));
  const problem = findProblem(input, found);
  if (problem) return fail(problem);
  const questions = found.filter((question) => question !== undefined);
  const isFull = assignment.scope === 'full-exam';
  if (isFull && !isFullShape(assignment, questions)) {
    return fail('invalid-scope');
  }
  const policy = selectScoringPolicy(assignment.format, assignment.scope);
  if (!policy) return fail('unsupported-format');
  return { ok: true, score: policy.score({ questions, keys, selections }) };
};

// A repeat of the wrong and skipped tasks inside the assignment of its source,
// on the version of the source. Nothing wrong or skipped is `empty`.
export const buildRepeatAssignment = (
  input: ScoreAssignmentInput,
): AssignmentResult => {
  const { assignment: source } = input;
  const scored = scoreAssignment(input);
  if (!scored.ok) return fail(scored.error);
  const questionIds = scored.score.items
    .filter((item) => item.outcome !== 'correct')
    .map((item) => item.questionId);
  if (questionIds.length === 0) return fail('empty');
  const material = { ...source, content: input.content };
  return create(material, {
    scope: 'short-set',
    selection: source.selection,
    purpose: 'error-repeat',
    questionIds,
  });
};

// What the browser may see of a neighbouring task: no key, no outcome.
export interface PublicContextItem {
  readonly questionId: string;
  readonly number: number;
  readonly prompt: string;
  readonly options: readonly ExamOption[];
}

export const toPublicContext = (
  content: ExamContent,
  assignment: AttemptAssignment,
): PublicContextItem[] => {
  const byId = new Map(content.questions.map((q) => [q.id, q] as const));
  return assignment.contextIds.flatMap((id) => {
    const question = byId.get(id);
    if (!question) return [];
    const options = question.options.map((o) => ({ id: o.id, text: o.text }));
    const { number, prompt } = question;
    return [{ questionId: question.id, number, prompt, options }];
  });
};

// Maps the pure admission of BeginLesen to the public DTO. Refusals of the
// phase stay business outcomes; only an unusable input is a technical failure.
export const toBeginLesenResult = (
  attemptId: string,
  admission: AdmissionResult,
): CommandResult<BeginLesenOutcome> => {
  if (admission.ok) {
    const { changed, state } = admission;
    return {
      ok: true,
      result: { outcome: 'accepted', attemptId, state, changed },
    };
  }
  if (admission.reason === 'invalid-input') {
    return { ok: false, failure: 'invalid-input' };
  }
  if (admission.reason === 'skill-not-open') {
    throw new Error('skill-not-open cannot refuse begin-lesen');
  }
  const { reason, state } = admission;
  return { ok: true, result: { outcome: reason, attemptId, state } };
};
