import 'server-only';
import { parseTrustedOrigin, isTrustedRequestOrigin } from './origin';
import type { TrustedOrigin } from './origin';

// The guard of every runtime command sent by fetch to a Route Handler. The
// method, the exact Origin of the trusted configuration, the JSON content
// type and the body size are checked before any session lookup or write.
// Responses are personal: private, no-store.

export const MAX_COMMAND_BYTES = 64 * 1024;

export type HttpRefusal =
  | 'method-not-allowed'
  | 'origin-not-configured'
  | 'origin-refused'
  | 'unsupported-media-type'
  | 'payload-too-large'
  | 'invalid-input';

const REFUSAL_STATUS: Readonly<Record<HttpRefusal, number>> = {
  'method-not-allowed': 405,
  'origin-not-configured': 500,
  'origin-refused': 403,
  'unsupported-media-type': 415,
  'payload-too-large': 413,
  'invalid-input': 400,
};

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export const privateJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: PRIVATE_HEADERS });

const refuse = (refusal: HttpRefusal): Response =>
  privateJson({ ok: false, failure: refusal }, REFUSAL_STATUS[refusal]);

// The deployment origin: APP_ORIGIN, or the Vercel preview URL only in an
// explicit preview. Read per request so a wrong value is never cached.
export const readTrustedOrigin = (): TrustedOrigin =>
  parseTrustedOrigin({
    appOrigin: process.env.APP_ORIGIN,
    vercelEnv: process.env.VERCEL_ENV,
    vercelUrl: process.env.VERCEL_URL,
  });

const isJsonType = (value: string | null): boolean => {
  if (!value) return false;
  const [type] = value.split(';');
  return type?.trim().toLowerCase() === 'application/json';
};

// Reads at most the limit; a longer body is refused without being parsed.
const readLimitedText = async (request: Request): Promise<string | null> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_COMMAND_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sizeBytes += value.byteLength;
    if (sizeBytes > MAX_COMMAND_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export type CommandBody =
  { ok: true; body: unknown } | { ok: false; response: Response };

export const readCommandBody = async (
  request: Request,
): Promise<CommandBody> => {
  if (request.method !== 'POST') {
    return { ok: false, response: refuse('method-not-allowed') };
  }
  const trusted = readTrustedOrigin();
  if (!trusted.ok) {
    console.error({ error: `Trusted origin: ${trusted.error}` });
    return { ok: false, response: refuse('origin-not-configured') };
  }
  const origin = request.headers.get('origin');
  if (!isTrustedRequestOrigin(trusted.origin, origin)) {
    return { ok: false, response: refuse('origin-refused') };
  }
  if (!isJsonType(request.headers.get('content-type'))) {
    return { ok: false, response: refuse('unsupported-media-type') };
  }
  const text = await readLimitedText(request);
  if (text === null) {
    return { ok: false, response: refuse('payload-too-large') };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: refuse('invalid-input') };
  }
};

// The HTTP status of a command result: a business outcome is 200, a
// technical failure keeps its own status.
const FAILURE_STATUS: Readonly<Record<string, number>> = {
  'invalid-input': 400,
  'session-invalid': 401,
  'not-found': 404,
  'not-enabled': 422,
  unavailable: 503,
};

export const commandResponse = (
  result: { ok: true } | { ok: false; failure: string },
): Response => {
  if (result.ok) return privateJson(result);
  return privateJson(result, FAILURE_STATUS[result.failure] ?? 500);
};

// The HTTP status of a save result: a stale or conflicting save is a
// business answer with the stored value; the others keep their own status.
const SAVE_ERROR_STATUS: Readonly<Record<string, number>> = {
  stale: 200,
  conflict: 200,
  'invalid-input': 400,
  'session-invalid': 401,
  'attempt-not-found': 404,
  'option-not-allowed': 422,
  'progress-not-allowed': 422,
  unavailable: 503,
};

export const saveResponse = (
  result: { ok: true } | { ok: false; error: string },
): Response => {
  if (result.ok) return privateJson(result);
  return privateJson(result, SAVE_ERROR_STATUS[result.error] ?? 500);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The input of a command on one attempt: the JSON body plus the attempt id
// of the address. A body that is not an object, or that names an attempt
// itself, gives no input and is refused by the strict schema.
export const withAttemptId = (body: unknown, attemptId: string): unknown =>
  isPlainObject(body) && !Object.hasOwn(body, 'attemptId')
    ? { ...body, attemptId }
    : null;
