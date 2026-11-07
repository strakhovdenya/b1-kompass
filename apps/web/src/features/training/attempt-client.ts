import type {
  AttemptMode,
  AttemptPurpose,
  AttemptSelection,
  BeginLesenOutcome,
  CancelOutcome,
  CommandResult,
  ExamQuestion,
  LifecycleState,
  RepeatStartOutcome,
  RunTechnicalFailure,
  SaveAnswerResult,
  SaveProgressResult,
  Selections,
  Skill,
  StartOutcome,
  SubmitOutcome,
} from '@b1k/domain';
import type { AttemptProgress } from '@b1k/domain';

// Addresses of one exam and of one attempt. The exam slug of an attempt
// address is checked by the server against the attempt's own version.
export const choicePath = (examSlug: string): string => `/practice/${examSlug}`;

export const attemptPath = (examSlug: string, attemptId: string): string =>
  `/practice/${examSlug}/attempts/${attemptId}`;

export const attemptLesenPath = (examSlug: string, attemptId: string): string =>
  `${attemptPath(examSlug, attemptId)}/lesen`;

export interface StartRequest {
  commandId: string;
  examSlug: string;
  mode: AttemptMode;
  purpose: AttemptPurpose;
  selection: AttemptSelection;
  sourceAttemptId: string | null;
  expectedVersionId: string;
}

// What the explicit guest replacement answers. Only 'replaced' means a new
// guest and cookie exist; every other answer left the cookie untouched.
export type GuestReplacementAnswer =
  | { status: 'replaced' }
  | { status: 'replacement-not-needed' }
  | { status: 'rate-limited' }
  | { status: 'conflict'; attemptId: string }
  | { status: 'refused'; failure: RunTechnicalFailure };

// The server action of the replacement, passed down by the page: the consent
// and the start the guest asked for, which the server checks again.
export type ReplaceGuest = (input: {
  consent: true;
  start: StartRequest;
}) => Promise<GuestReplacementAnswer>;

export interface FinalAnswer {
  questionId: string;
  optionId: string;
  revision: number;
}

// What the guest confirmed: the phase revision and the number of skipped
// tasks. The server refuses the command when either has changed.
export interface Confirmation {
  phaseRevision: number;
  skipped: number;
}

export interface SubmitRequest {
  commandId: string;
  answers: readonly FinalAnswer[];
  confirmation: Confirmation;
}

export interface CancelRequest {
  commandId: string;
  confirmation: Confirmation;
}

export type AttemptStatusOutcome =
  'active' | 'result-pending' | 'result-ready' | 'cancelled';

// One skill of the assignment as plain numbers: open (answerable now),
// closed (its answers are final) or unopened (an exam's Lesen before it
// starts: counted, never shown).
export interface SkillSummary {
  readonly assigned: number;
  readonly answered: number;
  readonly state: 'open' | 'closed' | 'unopened';
}

// The whole assignment as the server counts it, hidden Lesen included. It
// names no task, text or key.
export interface AttemptSummary {
  readonly totalAssigned: number;
  readonly skills: Readonly<Record<Skill, SkillSummary>>;
}

// The confirmed durations of a full exam, in seconds.
export interface ExamTiming {
  readonly hoerenSeconds: number;
  readonly transitionSeconds: number;
  readonly lesenSeconds: number;
}

// The status of one attempt: its lifecycle state, the answers that count
// (stored for an open attempt, frozen for a submitted one) and the number of
// skipped assigned tasks.
export interface AttemptStatusView {
  readonly outcome: AttemptStatusOutcome;
  readonly attemptId: string;
  readonly state: LifecycleState;
  readonly answers: Selections;
  readonly skipped: number;
  readonly summary: AttemptSummary;
  // The clock of the current phase of an open timed run.
  readonly timer: TimedClock | null;
  readonly submittedAt: string | null;
  // The moment the server judged this state at, as ISO text: for an open
  // timed run the database clock read after its row lock. The browser shows
  // the remaining time from it, never from its own clock.
  readonly serverNow: string;
  // A timed run that its deadline closed: only the answers the server
  // accepted before it count.
  readonly isClosedByDeadline: boolean;
}

// The clock of an open timed run as the server reads it: the absolute
// deadline and the server moment of the read, both epoch milliseconds.
// The phase is the one the deadline ends: a block's skill, or the
// transition of an exam, whose skill is the coming Lesen.
export interface TimedClock {
  readonly deadlineMs: number;
  readonly serverNowMs: number;
  readonly skill: Skill;
  readonly phase: Skill | 'transition';
}

// 'network' means the answer was lost: the same commandId may be sent again
// and returns what the first request did, if it arrived.
type WithNetwork<Result> = Result | { ok: false; failure: 'network' };

export type StartClientResult = WithNetwork<CommandResult<StartOutcome>>;
export type RepeatClientResult = WithNetwork<CommandResult<RepeatStartOutcome>>;
export type SubmitClientResult = WithNetwork<CommandResult<SubmitOutcome>>;
export type CancelClientResult = WithNetwork<CommandResult<CancelOutcome>>;
export type StatusClientResult = WithNetwork<CommandResult<AttemptStatusView>>;

const FAILURES: readonly RunTechnicalFailure[] = [
  'invalid-input',
  'session-invalid',
  'not-found',
  'unavailable',
  'not-enabled',
  'guest-too-short',
];

const toFailure = (value: unknown): RunTechnicalFailure =>
  FAILURES.find((failure) => failure === value) ?? 'unavailable';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const NETWORK = Symbol('network');

// One independent fetch per command, outside the queue of server actions
// and of every other request. The guest is authorized by the httpOnly
// cookie only; no token is sent.
const post = async (
  path: string,
  body: unknown,
  isKeepalive = false,
): Promise<unknown> => {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: isKeepalive,
    });
    return await response.json();
  } catch {
    return NETWORK;
  }
};

const commandOf = <Outcome>(
  body: unknown,
): WithNetwork<CommandResult<Outcome>> => {
  if (body === NETWORK) return { ok: false, failure: 'network' };
  if (!isRecord(body)) return { ok: false, failure: 'unavailable' };
  if (body.ok === true && isRecord(body.result)) {
    return { ok: true, result: body.result as unknown as Outcome };
  }
  return { ok: false, failure: toFailure(body.failure) };
};

const commandPath = (attemptId: string, command: string): string =>
  `/api/attempts/${attemptId}/${command}`;

export const requestStart = async (
  request: StartRequest,
): Promise<StartClientResult> =>
  commandOf<StartOutcome>(await post('/api/attempts/start', request));

// The repeat of the errors of one completed attempt: the same start route
// and contract; the server assigns the tasks from the source and may answer
// empty without starting anything.
export const requestRepeat = async (
  sourceAttemptId: string,
  request: Omit<StartRequest, 'mode' | 'purpose' | 'sourceAttemptId'>,
): Promise<RepeatClientResult> =>
  commandOf<RepeatStartOutcome>(
    await post('/api/attempts/start', {
      ...request,
      mode: 'training',
      purpose: 'error-repeat',
      sourceAttemptId,
    }),
  );

export const requestSubmit = async (
  attemptId: string,
  request: SubmitRequest,
): Promise<SubmitClientResult> =>
  commandOf<SubmitOutcome>(
    await post(commandPath(attemptId, 'submit'), request),
  );

export const requestCancel = async (
  attemptId: string,
  request: CancelRequest,
): Promise<CancelClientResult> =>
  commandOf<CancelOutcome>(
    await post(commandPath(attemptId, 'cancel'), request),
  );

export const requestStatus = async (
  attemptId: string,
): Promise<StatusClientResult> =>
  commandOf<AttemptStatusView>(
    await post(commandPath(attemptId, 'status'), {}),
  );

export type BeginLesenView = BeginLesenOutcome & {
  readonly status: AttemptStatusView;
};

export type BeginLesenClientResult = WithNetwork<CommandResult<BeginLesenView>>;

// The early start of Lesen. Repeating it is harmless: in Lesen it changes
// nothing, so a lost answer is simply sent again.
export const requestBeginLesen = async (
  attemptId: string,
): Promise<BeginLesenClientResult> =>
  commandOf<BeginLesenView>(
    await post(commandPath(attemptId, 'begin-lesen'), {}),
  );

// A playable address of the one recording of a full exam and its expiry,
// with the server moment it was judged at and the Hören duration the
// address must still cover when the exam starts.
export interface PreparedAudio {
  readonly url: string;
  readonly contentType: string;
  readonly expiresAt: string;
  readonly serverNow: string;
  readonly coverSeconds: number;
}

export type PrepareFailure =
  | 'invalid-input'
  | 'session-invalid'
  | 'not-found'
  | 'conflict'
  | 'phase-closed'
  | 'unavailable';

export type PrepareAudioResult =
  | { ok: true; audio: PreparedAudio }
  | { ok: false; error: PrepareFailure | 'network' };

const PREPARE_FAILURES: readonly PrepareFailure[] = [
  'invalid-input',
  'session-invalid',
  'not-found',
  'conflict',
  'phase-closed',
  'unavailable',
];

const audioOf = (body: unknown): PrepareAudioResult => {
  if (body === NETWORK) return { ok: false, error: 'network' };
  if (isRecord(body) && body.ok === true && isRecord(body.audio)) {
    return { ok: true, audio: body.audio as unknown as PreparedAudio };
  }
  const error = isRecord(body) ? body.error : undefined;
  return {
    ok: false,
    error: PREPARE_FAILURES.find((item) => item === error) ?? 'unavailable',
  };
};

// The preparation of a full exam on the choice: the recording only, before
// any attempt exists. It starts nothing and carries no material.
export const requestPrepareAudio = async (request: {
  examSlug: string;
  expectedVersionId: string;
}): Promise<PrepareAudioResult> =>
  audioOf(await post('/api/attempts/prepare-audio', request));

// The recording of the guest's own exam while its Hören is open.
export const requestAttemptAudio = async (
  attemptId: string,
  trackId: string,
): Promise<PrepareAudioResult> =>
  audioOf(await post(commandPath(attemptId, 'audio'), { trackId }));

// A refusal of the HTTP guard (origin, size, type) has no business error of
// a save: only a malformed request is the caller's fault.
const saveErrorOf = (body: unknown): 'invalid-input' | 'unavailable' =>
  isRecord(body) && body.failure === 'invalid-input'
    ? 'invalid-input'
    : 'unavailable';

const hasError = (body: Record<string, unknown>): boolean =>
  typeof body.error === 'string';

export interface SaveAnswerRequest {
  attemptId: string;
  questionId: string;
  optionId: string;
  revision: number;
}

export const requestSaveAnswer = async ({
  attemptId,
  ...answer
}: SaveAnswerRequest): Promise<SaveAnswerResult> => {
  const body = await post(commandPath(attemptId, 'answer'), answer);
  if (isRecord(body) && (body.ok === true || hasError(body))) {
    return body as unknown as SaveAnswerResult;
  }
  return { ok: false, error: saveErrorOf(body) };
};

export interface SaveProgressRequest {
  attemptId: string;
  progress: AttemptProgress;
}

// Kept alive, so the place written while the page is hidden still arrives.
export const requestSaveProgress = async ({
  attemptId,
  progress,
}: SaveProgressRequest): Promise<SaveProgressResult> => {
  const path = commandPath(attemptId, 'progress');
  const body = await post(path, { progress }, true);
  if (isRecord(body) && (body.ok === true || hasError(body))) {
    return body as unknown as SaveProgressResult;
  }
  return { ok: false, error: saveErrorOf(body) };
};

// The confirmation of a submission, as the guest sees it and the server
// checks it again.
export interface SubmitConfirmation {
  phaseRevision: number;
  skipped: number;
  unanswered: { hoeren: number; lesen: number };
  // Tasks of a part that has not started (the Lesen of an exam during
  // Hören or the transition): never shown, counted as skipped.
  unopened?: number;
}

export interface ConfirmationInput {
  // The tasks on screen: those of the visible phase.
  questions: readonly ExamQuestion[];
  // The final answers of this page, choices in flight included.
  answers: readonly FinalAnswer[];
  // The phase revision the server reported last.
  phaseRevision: number;
  // Tasks the server reported as answered, for example from another tab.
  stored: ReadonlySet<string>;
  // The server's numbers of the whole assignment; null counts the tasks on
  // screen only.
  summary: AttemptSummary | null;
}

const SKILL_LIST: readonly Skill[] = ['hoeren', 'lesen'];

// The confirmation the server checks again. An open part counts the tasks
// on screen with the choices of this page; a closed part only the answers
// the server holds, because a late choice there is never written; a part
// not opened yet counts all its tasks as skipped without knowing them.
export const confirmationOf = ({
  questions,
  answers,
  phaseRevision,
  stored,
  summary,
}: ConfirmationInput): SubmitConfirmation => {
  const answered = new Set(stored);
  for (const answer of answers) answered.add(answer.questionId);
  const onScreen = { hoeren: 0, lesen: 0 };
  const answeredOnScreen = { hoeren: 0, lesen: 0 };
  for (const question of questions) {
    if (answered.has(question.id)) answeredOnScreen[question.skill] += 1;
    else onScreen[question.skill] += 1;
  }
  if (!summary) {
    const skipped = onScreen.hoeren + onScreen.lesen;
    return { phaseRevision, skipped, unanswered: onScreen, unopened: 0 };
  }
  const unanswered = { hoeren: 0, lesen: 0 };
  let unopened = 0;
  for (const skill of SKILL_LIST) {
    const part = summary.skills[skill];
    const done =
      part.state === 'open' ? answeredOnScreen[skill] : part.answered;
    unanswered[skill] = Math.max(0, part.assigned - done);
    if (part.state === 'unopened') unopened += unanswered[skill];
  }
  const skipped = unanswered.hoeren + unanswered.lesen;
  return { phaseRevision, skipped, unanswered, unopened };
};
