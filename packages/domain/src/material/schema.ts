import { z } from 'zod';

const OPTION_ID = /^[a-z]$/;
const QUESTION_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const optionSchema = z.strictObject({
  id: z.string().regex(OPTION_ID),
  text: z.string().min(1).max(500),
});

export const questionSchema = z.strictObject({
  id: z.string().regex(QUESTION_ID),
  number: z.number().int().positive(),
  kind: z.literal('single-choice'),
  skill: z.enum(['hoeren', 'lesen']),
  teil: z.number().int().min(1).max(5),
  prompt: z.string().min(1).max(1000),
  options: z.array(optionSchema).min(2).max(10),
});

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
});

export type ExamOption = z.infer<typeof optionSchema>;
export type ExamQuestion = z.infer<typeof questionSchema>;
export type ExamContent = z.infer<typeof examContentSchema>;
export type AnswerKeys = Readonly<Record<string, string>>;

export interface MaterialProblem {
  code: 'duplicate-id' | 'duplicate-number' | 'missing-key' | 'key-not-option' | 'unknown-key';
  questionId: string;
}

export const findMaterialProblems = (
  content: ExamContent,
  keys: AnswerKeys,
): MaterialProblem[] => {
  const problems: MaterialProblem[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const question of content.questions) {
    const questionId = question.id;
    if (ids.has(questionId)) problems.push({ code: 'duplicate-id', questionId });
    if (numbers.has(question.number)) {
      problems.push({ code: 'duplicate-number', questionId });
    }
    ids.add(questionId);
    numbers.add(question.number);
    const key = Object.hasOwn(keys, questionId) ? keys[questionId] : undefined;
    if (key === undefined) {
      problems.push({ code: 'missing-key', questionId });
    } else if (!question.options.some((option) => option.id === key)) {
      problems.push({ code: 'key-not-option', questionId });
    }
  }
  for (const questionId of Object.keys(keys)) {
    if (!ids.has(questionId)) problems.push({ code: 'unknown-key', questionId });
  }
  return problems;
};
