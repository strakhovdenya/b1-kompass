import { z } from 'zod';
import type {
  ExamContent,
  ExamQuestion,
  SaveAnswerError,
  SaveAnswerResult,
  Selections,
} from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';
import { resolveGuestSession } from '../guest-session/session';
import type { GuestContext } from '../guest-session/session';
import { PILOT_EXAM_SLUG, getPublishedVersion } from '../material/published';

export interface PracticeState {
  attemptId: string;
  examTitle: string;
  source: ExamContent['source'];
  question: ExamQuestion;
  selections: Selections;
}

// Unknown fields such as role, owner or score are rejected, not ignored.
const saveAnswerInput = z.strictObject({
  attemptId: z.uuid(),
  questionId: z.string().min(1).max(100),
  optionId: z.string().min(1).max(10),
});

const RULE_ERRORS: Readonly<Record<string, SaveAnswerError>> = {
  guest_session_invalid: 'session-invalid',
  attempt_not_found: 'attempt-not-found',
  option_not_allowed: 'option-not-allowed',
};

interface AttemptRow {
  id: string;
}

interface AnswerRow {
  question_id: string;
  option_id: string;
  updated_at: string;
}

const readSelections = async (
  deps: ServerDeps,
  attemptId: string,
): Promise<Selections> => {
  const { data, error } = await deps.db
    .from('attempt_answers')
    .select('question_id, option_id, updated_at')
    .eq('attempt_id', attemptId)
    .returns<AnswerRow[]>();
  if (error) throw new Error('Answers lookup failed', { cause: error });
  const selections: Record<string, string> = {};
  for (const row of data) selections[row.question_id] = row.option_id;
  return selections;
};

export type OpenPracticeResult =
  | { status: 'ready'; practice: PracticeState }
  | { status: 'session-invalid' }
  | { status: 'no-material' };

// Opens the short pilot practice: the first published question of the pilot
// and the guest's own active attempt for that version.
export const openPractice = async (
  deps: ServerDeps,
  guest: GuestContext,
): Promise<OpenPracticeResult> => {
  const version = await getPublishedVersion(deps, PILOT_EXAM_SLUG);
  const question = version?.content.questions[0];
  if (!version || !question) return { status: 'no-material' };
  const { data, error } = await deps.db
    .rpc('start_attempt', {
      p_session_id: guest.sessionId,
      p_exam_version_id: version.versionId,
      p_now: deps.clock.now().toISOString(),
    })
    .single<AttemptRow>();
  if (error) {
    if (ruleViolation(error) === 'guest_session_invalid') {
      return { status: 'session-invalid' };
    }
    throw new Error('Attempt was not started', { cause: error });
  }
  const practice: PracticeState = {
    attemptId: data.id,
    examTitle: version.examTitle,
    source: version.content.source,
    question,
    selections: await readSelections(deps, data.id),
  };
  return { status: 'ready', practice };
};

export const saveAnswer = async (
  deps: ServerDeps,
  token: string | null | undefined,
  input: unknown,
): Promise<SaveAnswerResult> => {
  const parsed = saveAnswerInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid-input' };
  const guest = await resolveGuestSession(deps, token);
  if (!guest) return { ok: false, error: 'session-invalid' };
  const { attemptId, questionId, optionId } = parsed.data;
  const { data, error } = await deps.db
    .rpc('save_attempt_answer', {
      p_session_id: guest.sessionId,
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_option_id: optionId,
      p_now: deps.clock.now().toISOString(),
    })
    .single<AnswerRow>();
  if (error) {
    const rule = ruleViolation(error);
    const known = rule ? RULE_ERRORS[rule] : undefined;
    if (known) return { ok: false, error: known };
    console.error({ error });
    return { ok: false, error: 'unavailable' };
  }
  return {
    ok: true,
    questionId: data.question_id,
    optionId: data.option_id,
    savedAt: data.updated_at,
  };
};
