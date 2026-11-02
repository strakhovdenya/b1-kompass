// The trusted origin of the deployment, parsed from configuration strings
// handed in by the caller. Pure: no process.env, no request headers. The
// Host or forwarded host of a request is never a source of trust.

export interface OriginSettings {
  appOrigin: string | undefined;
  vercelEnv: string | undefined;
  vercelUrl: string | undefined;
}

export type OriginConfigError =
  'invalid-app-origin' | 'invalid-preview-host' | 'missing-origin';

export type TrustedOrigin =
  { ok: true; origin: string } | { ok: false; error: OriginConfigError };

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const PREVIEW_HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);

const isGiven = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

// One exact origin: scheme, host and an optional port, nothing else. Plain
// http is accepted only for a local test server.
const parseExactOrigin = (value: string): string | null => {
  if (value.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.origin !== value) return null;
  if (url.protocol === 'https:') return url.origin;
  const isLocal = LOCAL_HOSTS.includes(url.hostname);
  return url.protocol === 'http:' && isLocal ? url.origin : null;
};

const fail = (error: OriginConfigError): TrustedOrigin => ({
  ok: false,
  error,
});

// APP_ORIGIN wins in every environment, and an invalid value is an error,
// never replaced by a fallback. Only an explicit Vercel preview without
// APP_ORIGIN uses https:// + VERCEL_URL.
export const parseTrustedOrigin = (settings: OriginSettings): TrustedOrigin => {
  const { appOrigin, vercelEnv, vercelUrl } = settings;
  if (isGiven(appOrigin)) {
    const origin = parseExactOrigin(appOrigin);
    return origin ? { ok: true, origin } : fail('invalid-app-origin');
  }
  if (vercelEnv !== 'preview') return fail('missing-origin');
  if (!isGiven(vercelUrl)) return fail('missing-origin');
  if (!PREVIEW_HOST.test(vercelUrl)) return fail('invalid-preview-host');
  const origin = parseExactOrigin(`https://${vercelUrl}`);
  return origin ? { ok: true, origin } : fail('invalid-preview-host');
};

// The Origin header of a request must equal the trusted origin exactly; a
// missing header is refused.
export const isTrustedRequestOrigin = (
  trusted: string,
  received: string | null,
): boolean => received !== null && received === trusted;
