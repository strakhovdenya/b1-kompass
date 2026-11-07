import {
  ATTEMPT_PURPOSES,
  ATTEMPT_SELECTIONS,
  buildRepeatAssignment,
} from '@b1k/domain';
import type { AttemptAssignment, RunTechnicalFailure } from '@b1k/domain';
import type { ServerDeps } from '../db';
import type { GuestContext } from '../guest-session/session';
import { parseAssignment } from './projection';
import {
  readAnswerKeys,
  readOwnedAttempt,
  readRun,
  readStoredAnswers,
  readVersionOfExam,
} from './repository';
import type { ExamRow } from './repository';
import { reviewedSelections } from './review';

// The repeat of the guest's own errors. The source is the guest's own
// completed attempt of the same exam; its pinned version, its assignment and
// the answers it was reviewed with (frozen snapshot, or the stored answers of
// a legacy completion) decide the tasks. Nothing of the request but the source
// id is trusted: the selection and the version only have to agree with the
// source. The mode is checked before (always a free training). The SQL start
// checks the same again under the slot lock.

export interface RepeatRequest {
  readonly selection: string;
  readonly sourceAttemptId: string;
  readonly expectedVersionId: string;
}

export type RepeatPreparation =
  | { readonly outcome: 'ready'; readonly assignment: AttemptAssignment }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'refused'; readonly failure: RunTechnicalFailure };

const refused = (failure: RunTechnicalFailure): RepeatPreparation => ({
  outcome: 'refused',
  failure,
});

// A source that is not the guest's own completed attempt of this exam on the
// named version is not found, whatever the reason: the answer never tells a
// foreign, an active, a submitted or a cancelled attempt apart.
const NOT_FOUND = refused('not-found');

const selectionOf = (value: string) =>
  ATTEMPT_SELECTIONS.find((selection) => selection === value);

const purposeOf = (value: string) =>
  ATTEMPT_PURPOSES.find((purpose) => purpose === value);

const unusable = (sourceId: string, reason: string): RepeatPreparation => {
  console.error({ error: `Repeat source ${sourceId} unusable: ${reason}` });
  return NOT_FOUND;
};

export const prepareRepeat = async (
  deps: ServerDeps,
  guest: GuestContext,
  exam: ExamRow,
  request: RepeatRequest,
): Promise<RepeatPreparation> => {
  const { sourceAttemptId: sourceId } = request;
  // The run is read with the attempt; it is used only once the attempt is
  // known to be the guest's own completed source.
  const [source, run] = await Promise.all([
    readOwnedAttempt(deps, guest.sessionId, sourceId),
    readRun(deps, sourceId),
  ]);
  if (!source || source.examId !== exam.id) return NOT_FOUND;
  if (source.status !== 'completed') return NOT_FOUND;
  if (source.examVersionId !== request.expectedVersionId) return NOT_FOUND;
  if (!run) return unusable(sourceId, 'no run');
  // A repeat keeps the selection of its source.
  if (request.selection !== run.selection) return refused('invalid-input');
  const questionIds = parseAssignment(run.assignment, source.examVersionId);
  const selection = selectionOf(run.selection);
  const purpose = purposeOf(run.purpose);
  if (!questionIds || !selection || !purpose) {
    return unusable(sourceId, 'assignment');
  }
  const [version, keys, stored] = await Promise.all([
    readVersionOfExam(deps, exam.id, source.examVersionId),
    readAnswerKeys(deps, source.examVersionId),
    readStoredAnswers(deps, source.id),
  ]);
  // A new completion without a usable snapshot has no answers: it is
  // refused, never read as all tasks skipped.
  const selections = reviewedSelections(run, stored.selections);
  if (!version || !selections) return unusable(sourceId, 'answers');
  const built = buildRepeatAssignment({
    assignment: {
      format: exam.format,
      versionId: version.id,
      scope: source.scope,
      selection,
      purpose,
      questionIds,
      contextIds: [],
    },
    versionId: version.id,
    content: version.content,
    keys,
    selections,
  });
  if (built.ok) return { outcome: 'ready', assignment: built.assignment };
  if (built.error === 'empty') return { outcome: 'empty' };
  return unusable(sourceId, built.error);
};
