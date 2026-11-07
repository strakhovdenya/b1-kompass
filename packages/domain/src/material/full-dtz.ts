import { DTZ_FULL_INVENTORY } from '../scoring/dtz';
import { findInventoryProblems, findMaterialProblems } from './schema';
import type {
  AnswerKeys,
  ExamContent,
  ExamGroup,
  ExamQuestion,
  MaterialContext,
  MaterialProblem,
} from './schema';

type Skill = 'hoeren' | 'lesen';

// Tasks per Teil of the supported full DTZ (g.a.s.t. and telc sets).
const TEIL_SIZES: Readonly<Record<Skill, readonly number[]>> = {
  hoeren: [4, 5, 8, 3],
  lesen: [5, 5, 6, 3, 6],
};

const HOEREN_PAIR_TEIL = 3;
const HOEREN_PAIR_COUNT = 4;
const HOEREN_SHARED_TEIL = 4;
const LESEN_PAIR_TEIL = 3;
const LESEN_TRUE_FALSE_TEIL = 4;

const SKILLS: readonly Skill[] = ['hoeren', 'lesen'];

const teilId = (skill: Skill, teil: number): string => `${skill}:teil-${teil}`;

const ofSkill = (content: ExamContent, skill: Skill): ExamQuestion[] =>
  content.questions.filter((question) => question.skill === skill);

const inTeil = (
  content: ExamContent,
  skill: Skill,
  teil: number,
): ExamQuestion[] =>
  ofSkill(content, skill)
    .filter((question) => question.teil === teil)
    .sort((a, b) => a.number - b.number);

const findTeilCountProblems = (content: ExamContent): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  for (const skill of SKILLS) {
    const sizes = TEIL_SIZES[skill];
    const questions = ofSkill(content, skill);
    sizes.forEach((size, index) => {
      const teil = index + 1;
      const count = questions.filter((q) => q.teil === teil).length;
      if (count !== size) {
        problems.push({
          code: 'teil-mismatch',
          questionId: teilId(skill, teil),
        });
      }
    });
    for (const teil of new Set(questions.map((q) => q.teil))) {
      if (teil > sizes.length) {
        problems.push({
          code: 'teil-mismatch',
          questionId: teilId(skill, teil),
        });
      }
    }
  }
  return problems;
};

// Numbers of one skill are a gap-free ascending row ordered by Teil. The first
// number is not fixed: real sets number Lesen from 21 or from 1. A repeated
// number is already reported as duplicate-number.
const findNumberingProblems = (content: ExamContent): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  for (const skill of SKILLS) {
    const sorted = ofSkill(content, skill).sort((a, b) => a.number - b.number);
    let previousNumber: number | undefined;
    let highestTeil = 0;
    for (const question of sorted) {
      const { number, teil } = question;
      const isGap =
        previousNumber !== undefined &&
        number !== previousNumber &&
        number !== previousNumber + 1;
      if (isGap) {
        problems.push({ code: 'numbering-gap', questionId: question.id });
      }
      if (teil < highestTeil) {
        problems.push({ code: 'teil-order', questionId: question.id });
      }
      highestTeil = Math.max(highestTeil, teil);
      previousNumber = number;
    }
  }
  return problems;
};

const findKindProblems = (content: ExamContent): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  const reject = (question: ExamQuestion) =>
    problems.push({ code: 'invalid-question-kind', questionId: question.id });
  for (const question of ofSkill(content, 'hoeren')) {
    if (question.teil <= 2 && question.kind !== 'single-choice') {
      reject(question);
    }
  }
  // A Richtig/Falsch of Lesen is a single choice with two options: Lesen has
  // no recording, so it cannot be a `true-false` question of a pair group.
  for (const question of ofSkill(content, 'lesen')) {
    if (question.kind !== 'single-choice') reject(question);
  }
  // Teil 3: three pairs, each a Richtig/Falsch followed by a Richtig/Falsch
  // or an a/b/c choice (the official sets mix them; older pilots have six
  // Richtig/Falsch).
  inTeil(content, 'lesen', LESEN_PAIR_TEIL).forEach((question, index) => {
    const count = question.options.length;
    const isFirstOfPair = index % 2 === 0;
    const isValid = isFirstOfPair ? count === 2 : count === 2 || count === 3;
    if (!isValid) reject(question);
  });
  for (const question of inTeil(content, 'lesen', LESEN_TRUE_FALSE_TEIL)) {
    if (question.options.length !== 2) reject(question);
  }
  return problems;
};

const expectedGroupKind = (teil: number): ExamGroup['kind'] | undefined => {
  if (teil === HOEREN_PAIR_TEIL) return 'pair';
  if (teil === HOEREN_SHARED_TEIL) return 'shared-set';
  return undefined;
};

const findGroupStructureProblems = (
  content: ExamContent,
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  const byId = new Map(content.questions.map((q) => [q.id, q]));
  const groups = content.groups ?? [];
  for (const group of groups) {
    const isMisplaced =
      group.kind !== expectedGroupKind(group.teil) ||
      !group.questionIds.every((id) => {
        const member = byId.get(id);
        return member?.skill === 'hoeren' && member.teil === group.teil;
      });
    if (isMisplaced) {
      problems.push({ code: 'invalid-group', questionId: group.id });
    }
  }
  const groupsOf = (kind: ExamGroup['kind'], teil: number) =>
    groups.filter((g) => g.kind === kind && g.teil === teil);
  const isCovered = (teil: number, covering: readonly ExamGroup[]) => {
    const ids = new Set(covering.flatMap((g) => g.questionIds));
    return inTeil(content, 'hoeren', teil).every((q) => ids.has(q.id));
  };
  const pairs = groupsOf('pair', HOEREN_PAIR_TEIL);
  if (
    pairs.length !== HOEREN_PAIR_COUNT ||
    !isCovered(HOEREN_PAIR_TEIL, pairs)
  ) {
    problems.push({
      code: 'invalid-group',
      questionId: teilId('hoeren', HOEREN_PAIR_TEIL),
    });
  }
  const shared = groupsOf('shared-set', HOEREN_SHARED_TEIL);
  if (shared.length !== 1 || !isCovered(HOEREN_SHARED_TEIL, shared)) {
    problems.push({
      code: 'invalid-group',
      questionId: teilId('hoeren', HOEREN_SHARED_TEIL),
    });
  }
  return problems;
};

// Hören is one continuous recording: questions, groups and examples may name
// only one track. The audio itself is neither cut nor merged.
const findTrackProblems = (content: ExamContent): MaterialProblem[] => {
  const tracks = new Set<string>();
  for (const question of ofSkill(content, 'hoeren')) {
    if (question.trackId !== undefined) tracks.add(question.trackId);
  }
  for (const group of content.groups ?? []) tracks.add(group.trackId);
  for (const example of content.examples ?? []) {
    if (example.skill === 'hoeren' && example.trackId !== undefined) {
      tracks.add(example.trackId);
    }
  }
  return tracks.size > 1
    ? [{ code: 'multiple-hoeren-tracks', questionId: 'hoeren' }]
    : [];
};

// The material and key checks of the contract plus the structure of the
// supported full DTZ. Problems carry a code and an id, never a key value.
export const findFullDtzProblems = (
  content: ExamContent,
  keys: AnswerKeys,
  context: MaterialContext = {},
): MaterialProblem[] => [
  ...findMaterialProblems(content, keys, context),
  ...findInventoryProblems(content, DTZ_FULL_INVENTORY),
  ...findTeilCountProblems(content),
  ...findNumberingProblems(content),
  ...findKindProblems(content),
  ...findGroupStructureProblems(content),
  ...findTrackProblems(content),
];
