import type {
  AttemptMode,
  AttemptPurpose,
  AttemptSelection,
  CancelOutcome,
  CommandResult,
  LifecycleState,
  RunTechnicalFailure,
  SaveAnswerResult,
  SaveProgressResult,
  Selections,
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

// The status of one attempt: its lifecycle state, the answers that count
// (stored for an open attempt, frozen for a submitted one) and the number of
// skipped assigned tasks.
export interface AttemptStatusView {
  readonly outcome: AttemptStatusOutcome;
  readonly attemptId: string;
  readonly state: LifecycleState;
  readonly answers: Selections;
  readonly skipped: number;
  readonly submittedAt: string | null;
}

// 'network' means the answer was lost: the same commandId may be sent again
// and returns what the first request did, if it arrived.
type WithNetwork<Result> = Result | { ok: false; failure: 'network' };

export type StartClientResult = WithNetwork<CommandResult<StartOutcome>>;
export type SubmitClientResult = WithNetwork<CommandResult<SubmitOutcome>>;
export type CancelClientResult = WithNetwork<CommandResult<CancelOutcome>>;
export type StatusClientResult = WithNetwork<CommandResult<AttemptStatusView>>;

const FAILURES: readonly RunTechnicalFailure[] = [
  'invalid-input',
  'session-invalid',
  'not-found',
  'unavailable',
  'not-enabled',
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
