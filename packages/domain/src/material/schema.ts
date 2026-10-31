import { z } from 'zod';

const OPTION_ID = /^[a-z]$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SHARED_SET_SIZE = 3;

export const optionSchema = z.strictObject({
  id: z.string().regex(OPTION_ID),
  text: z.string().min(1).max(500),
});

// Every question carries its own options, also inside a shared set: the
// answer check of the database and the scoring read them from the question.
// The validator keeps a shared set and its questions identical.
export const questionSchema = z.strictObject({
  id: z.string().regex(SLUG),
  number: z.number().int().positive(),
  kind: z.enum(['single-choice', 'true-false', 'shared-choice']),
  skill: z.enum(['hoeren', 'lesen']),
  teil: z.number().int().min(1).max(5),
  prompt: z.string().min(1).max(1000),
  options: z.array(optionSchema).min(2).max(10),
  textId: z.string().regex(SLUG).optional(),
  trackId: z.string().regex(SLUG).optional(),
  sourcePage: z.number().int().positive().optional(),
});

// A worked example of the publisher: shown, never scored and without a row in
// the answer keys, so its solution is public by design.
export const exampleSchema = z.strictObject({
  id: z.string().regex(SLUG),
  skill: z.enum(['hoeren', 'lesen']),
  teil: z.number().int().min(1).max(5),
  prompt: z.string().min(1).max(1000),
  options: z.array(optionSchema).min(2).max(10),
  solutionOptionId: z.string().regex(OPTION_ID),
  trackId: z.string().regex(SLUG).optional(),
  sourcePage: z.number().int().positive().optional(),
});

// A reading text that several Lesen questions refer to.
export const textSchema = z.strictObject({
  id: z.string().regex(SLUG),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(6000),
  sourcePage: z.number().int().positive().optional(),
});

// Teil 3: one recording with a true/false question and a single choice.
const pairGroupSchema = z.strictObject({
  id: z.string().regex(SLUG),
  kind: z.literal('pair'),
  teil: z.number().int().min(1).max(5),
  trackId: z.string().regex(SLUG),
  questionIds: z.array(z.string().regex(SLUG)),
});

// Teil 4: one long recording, a common list of statements and questions that
// each pick one of them.
const sharedSetGroupSchema = z.strictObject({
  id: z.string().regex(SLUG),
  kind: z.literal('shared-set'),
  teil: z.number().int().min(1).max(5),
  trackId: z.string().regex(SLUG),
  options: z.array(optionSchema).min(2).max(10),
  questionIds: z.array(z.string().regex(SLUG)),
});

export const groupSchema = z.discriminatedUnion('kind', [
  pairGroupSchema,
  sharedSetGroupSchema,
]);

export const sourceSchema = z.strictObject({
  publisher: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  page: z.number().int().positive(),
});

// Public projection of one exam version: what a guest may see before review.
// It has no field for answer keys, and unknown fields are rejected.
export const examContentSchema = z.strictObject({
  source: sourceSchema,
  questions: z.array(questionSchema).min(1),
  examples: z.array(exampleSchema).optional(),
  texts: z.array(textSchema).optional(),
  groups: z.array(groupSchema).optional(),
});

export type ExamOption = z.infer<typeof optionSchema>;
export type ExamQuestion = z.infer<typeof questionSchema>;
export type ExamExample = z.infer<typeof exampleSchema>;
export type ExamText = z.infer<typeof textSchema>;
export type ExamGroup = z.infer<typeof groupSchema>;
export type ExamContent = z.infer<typeof examContentSchema>;
export type AnswerKeys = Readonly<Record<string, string>>;

export interface MaterialProblem {
  code:
    | 'duplicate-id'
    | 'duplicate-number'
    | 'duplicate-option'
    | 'missing-key'
    | 'key-not-option'
    | 'key-for-example'
    | 'unknown-key'
    | 'broken-reference'
    | 'invalid-group'
    | 'options-mismatch'
    | 'invalid-example'
    | 'inventory-mismatch';
  questionId: string;
}

export interface MaterialContext {
  // Audio tracks published with the version; links to others are broken.
  trackIds?: ReadonlySet<string>;
}

export interface Inventory {
  hoeren: number;
  lesen: number;
}

const hasDuplicates = (options: readonly ExamOption[]): boolean =>
  new Set(options.map((option) => option.id)).size !== options.length;

const sameOptions = (
  left: readonly ExamOption[],
  right: readonly ExamOption[],
): boolean =>
  left.length === right.length &&
  left.every(
    (option, index) =>
      option.id === right[index]?.id && option.text === right[index]?.text,
  );

const findGroupProblems = (
  group: ExamGroup,
  byId: ReadonlyMap<string, ExamQuestion>,
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  const members = group.questionIds.map((id) => byId.get(id));
  const known = members.filter((member) => member !== undefined);
  if (known.length !== members.length) {
    return [{ code: 'broken-reference', questionId: group.id }];
  }
  const hasRepeat =
    new Set(group.questionIds).size !== group.questionIds.length;
  if (hasRepeat) problems.push({ code: 'invalid-group', questionId: group.id });
  for (const member of known) {
    if (member.trackId !== undefined && member.trackId !== group.trackId) {
      problems.push({ code: 'broken-reference', questionId: member.id });
    }
  }
  if (group.kind === 'pair') {
    const kinds = known.map((member) => member.kind).join();
    if (kinds !== 'true-false,single-choice') {
      problems.push({ code: 'invalid-group', questionId: group.id });
    }
    return problems;
  }
  if (known.length !== SHARED_SET_SIZE) {
    problems.push({ code: 'invalid-group', questionId: group.id });
  }
  if (hasDuplicates(group.options)) {
    problems.push({ code: 'duplicate-option', questionId: group.id });
  }
  for (const member of known) {
    if (member.kind !== 'shared-choice') {
      problems.push({ code: 'invalid-group', questionId: member.id });
    } else if (!sameOptions(member.options, group.options)) {
      problems.push({ code: 'options-mismatch', questionId: member.id });
    }
  }
  return problems;
};

const findGroupMembershipProblems = (
  content: ExamContent,
  byId: ReadonlyMap<string, ExamQuestion>,
): MaterialProblem[] => {
  const groups = content.groups ?? [];
  const problems = groups.flatMap((group) => findGroupProblems(group, byId));
  const memberships = new Map<string, number>();
  for (const group of groups) {
    for (const questionId of new Set(group.questionIds)) {
      memberships.set(questionId, (memberships.get(questionId) ?? 0) + 1);
    }
  }
  for (const question of content.questions) {
    const count = memberships.get(question.id) ?? 0;
    const isStandalone = question.kind === 'single-choice';
    if (count > 1 || (count === 0 && !isStandalone)) {
      problems.push({ code: 'invalid-group', questionId: question.id });
    }
    if (question.kind === 'true-false' && question.options.length !== 2) {
      problems.push({ code: 'options-mismatch', questionId: question.id });
    }
  }
  return problems;
};

const findReferenceProblems = (
  content: ExamContent,
  context: MaterialContext,
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  const textIds = new Set((content.texts ?? []).map((text) => text.id));
  const { trackIds } = context;
  const isBrokenTrack = (trackId: string | undefined) =>
    trackIds !== undefined && trackId !== undefined && !trackIds.has(trackId);
  for (const question of content.questions) {
    const { textId, trackId } = question;
    const isBrokenText = textId !== undefined && !textIds.has(textId);
    if (isBrokenText || isBrokenTrack(trackId)) {
      problems.push({ code: 'broken-reference', questionId: question.id });
    }
  }
  for (const group of content.groups ?? []) {
    if (isBrokenTrack(group.trackId)) {
      problems.push({ code: 'broken-reference', questionId: group.id });
    }
  }
  for (const example of content.examples ?? []) {
    if (isBrokenTrack(example.trackId)) {
      problems.push({ code: 'broken-reference', questionId: example.id });
    }
  }
  return problems;
};

const findExampleProblems = (
  content: ExamContent,
  keys: AnswerKeys,
  questionIds: ReadonlySet<string>,
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  for (const example of content.examples ?? []) {
    const { id } = example;
    if (questionIds.has(id)) {
      problems.push({ code: 'duplicate-id', questionId: id });
    }
    if (Object.hasOwn(keys, id)) {
      problems.push({ code: 'key-for-example', questionId: id });
    }
    if (hasDuplicates(example.options)) {
      problems.push({ code: 'duplicate-option', questionId: id });
    }
    const hasSolution = example.options.some(
      (option) => option.id === example.solutionOptionId,
    );
    if (!hasSolution)
      problems.push({ code: 'invalid-example', questionId: id });
  }
  return problems;
};

export const findMaterialProblems = (
  content: ExamContent,
  keys: AnswerKeys,
  context: MaterialContext = {},
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  const ids = new Set<string>();
  const numbers = new Set<string>();
  for (const question of content.questions) {
    const questionId = question.id;
    const numberKey = `${question.skill}:${question.number}`;
    if (ids.has(questionId))
      problems.push({ code: 'duplicate-id', questionId });
    if (numbers.has(numberKey)) {
      problems.push({ code: 'duplicate-number', questionId });
    }
    if (hasDuplicates(question.options)) {
      problems.push({ code: 'duplicate-option', questionId });
    }
    ids.add(questionId);
    numbers.add(numberKey);
    const key = Object.hasOwn(keys, questionId) ? keys[questionId] : undefined;
    if (key === undefined) {
      problems.push({ code: 'missing-key', questionId });
    } else if (!question.options.some((option) => option.id === key)) {
      problems.push({ code: 'key-not-option', questionId });
    }
  }
  const exampleIds = new Set((content.examples ?? []).map((e) => e.id));
  for (const questionId of Object.keys(keys)) {
    if (!ids.has(questionId) && !exampleIds.has(questionId)) {
      problems.push({ code: 'unknown-key', questionId });
    }
  }
  const byId = new Map(content.questions.map((q) => [q.id, q]));
  return [
    ...problems,
    ...findExampleProblems(content, keys, ids),
    ...findGroupMembershipProblems(content, byId),
    ...findReferenceProblems(content, context),
  ];
};

// The scored questions of a complete set. The owner passes the expected
// counts of the full pilot; the short set is not checked against them.
export const findInventoryProblems = (
  content: ExamContent,
  expected: Inventory,
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  for (const skill of ['hoeren', 'lesen'] as const) {
    const count = content.questions.filter((q) => q.skill === skill).length;
    if (count !== expected[skill]) {
      problems.push({ code: 'inventory-mismatch', questionId: skill });
    }
  }
  return problems;
};
