import type { ExamGroup, ExamQuestion } from '@b1k/domain';

// One screen of the set: a single question, or the questions of a group that
// belong together and are shown at the same time.
export interface PracticeStep {
  key: string;
  questions: ExamQuestion[];
  group: ExamGroup | null;
}

// Questions keep their order; the members of a pair form one step at the place
// of the first member. A group with a member outside `questions` is ignored,
// so its members stay single steps.
export const buildSteps = (
  questions: readonly ExamQuestion[],
  groups: readonly ExamGroup[],
): PracticeStep[] => {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const groupOf = new Map<string, ExamGroup>();
  for (const group of groups) {
    if (group.kind !== 'pair') continue;
    if (!group.questionIds.every((id) => byId.has(id))) continue;
    for (const id of group.questionIds) groupOf.set(id, group);
  }
  const steps: PracticeStep[] = [];
  const emitted = new Set<string>();
  for (const question of questions) {
    const group = groupOf.get(question.id) ?? null;
    if (!group) {
      steps.push({ key: question.id, questions: [question], group: null });
    } else if (!emitted.has(group.id)) {
      emitted.add(group.id);
      steps.push({
        key: group.id,
        questions: group.questionIds.flatMap((id) => byId.get(id) ?? []),
        group,
      });
    }
  }
  return steps;
};
