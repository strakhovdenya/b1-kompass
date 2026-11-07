import type { ExamGroup, ExamQuestion, PublicContextItem } from '@b1k/domain';

// One member of a step in the order of its group: an assessed task, or a
// read-only neighbour of a repeat that is shown but never answered.
export type StepMember =
  | { readonly kind: 'assessed'; readonly question: ExamQuestion }
  | { readonly kind: 'context'; readonly item: PublicContextItem };

// One screen of the set: a single question, or the questions of a group that
// belong together and are shown at the same time. `questions` are only the
// assessed ones; `members` adds the read-only context at its place.
export interface PracticeStep {
  key: string;
  questions: ExamQuestion[];
  group: ExamGroup | null;
  members: StepMember[];
}

// The number and options a group view reads of every member.
export const memberView = (member: StepMember): PublicContextItem =>
  member.kind === 'assessed'
    ? {
        questionId: member.question.id,
        number: member.question.number,
        prompt: member.question.prompt,
        options: member.question.options,
      }
    : member.item;

// Questions keep their order; the members of a group form one step at the
// place of the first assessed member. A read-only neighbour counts as a
// present member of its group but is never a step of its own. A pair with a
// member that is neither assessed nor context is ignored, so its members stay
// single steps. A shared set is kept with the members that exist: the screen
// of the set reports the missing ones.
export const buildSteps = (
  questions: readonly ExamQuestion[],
  groups: readonly ExamGroup[],
  context: readonly PublicContextItem[] = [],
): PracticeStep[] => {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const contextById = new Map(context.map((item) => [item.questionId, item]));
  const isPresent = (id: string): boolean =>
    byId.has(id) || contextById.has(id);
  const groupOf = new Map<string, ExamGroup>();
  for (const group of groups) {
    if (group.kind !== 'pair' && group.kind !== 'shared-set') continue;
    const isComplete = group.questionIds.every(isPresent);
    if (group.kind === 'pair' && !isComplete) continue;
    for (const id of group.questionIds) groupOf.set(id, group);
  }
  const memberOf = (id: string): StepMember[] => {
    const question = byId.get(id);
    if (question) return [{ kind: 'assessed', question }];
    const item = contextById.get(id);
    return item ? [{ kind: 'context', item }] : [];
  };
  const steps: PracticeStep[] = [];
  const emitted = new Set<string>();
  for (const question of questions) {
    const group = groupOf.get(question.id) ?? null;
    if (!group) {
      steps.push({
        key: question.id,
        questions: [question],
        group: null,
        members: [{ kind: 'assessed', question }],
      });
    } else if (!emitted.has(group.id)) {
      emitted.add(group.id);
      steps.push({
        key: group.id,
        questions: group.questionIds.flatMap((id) => byId.get(id) ?? []),
        group,
        members: group.questionIds.flatMap(memberOf),
      });
    }
  }
  return steps;
};
