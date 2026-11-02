import type {
  AttemptMode,
  AttemptPurpose,
  AttemptSelection,
  CommandResult,
  RunTechnicalFailure,
  StartOutcome,
} from '@b1k/domain';

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

// 'network' means the answer was lost: the same commandId may be sent again
// and returns the attempt it created, if it did.
export type StartClientResult =
  CommandResult<StartOutcome> | { ok: false; failure: 'network' };

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

// One independent fetch per command, outside the queue of server actions.
// The guest is authorized by the httpOnly cookie only; no token is sent.
export const requestStart = async (
  request: StartRequest,
): Promise<StartClientResult> => {
  let body: unknown;
  try {
    const response = await fetch('/api/attempts/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    body = await response.json();
  } catch {
    return { ok: false, failure: 'network' };
  }
  if (!isRecord(body)) return { ok: false, failure: 'unavailable' };
  if (body.ok === true && isRecord(body.result)) {
    return { ok: true, result: body.result as unknown as StartOutcome };
  }
  return { ok: false, failure: toFailure(body.failure) };
};
