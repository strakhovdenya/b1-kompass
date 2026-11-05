// The dictionary configuration, parsed from strings handed in by the caller.
// Pure: no process.env. The deterministic test provider replaces only the
// external HTTP sources, never auth, cache or budget, and is accepted only on
// a local test server: never on Vercel and never behind a public origin.

export type DictionaryMode = 'live' | 'test';

export interface DictionarySettingsInput {
  testProvider: string | undefined;
  contactEmail: string | undefined;
  vercelEnv: string | undefined;
  appOrigin: string | undefined;
}

export type DictionaryConfigError =
  'invalid-test-provider' | 'test-provider-forbidden';

export type DictionarySettings =
  | { ok: true; mode: DictionaryMode; contactEmail: string | null }
  | { ok: false; error: DictionaryConfigError };

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/i;
const MAX_EMAIL_CHARS = 254;

const isGiven = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

const isLoopbackOrigin = (value: string | undefined): boolean => {
  if (!isGiven(value)) return false;
  try {
    const url = new URL(value);
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    return isHttp && LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
};

// The optional contact of MyMemory (`de`) and of the OpenThesaurus
// User-Agent. An invalid value is not sent anywhere.
export const parseContactEmail = (value: string | undefined): string | null => {
  if (!isGiven(value)) return null;
  const email = value.trim();
  if (email.length > MAX_EMAIL_CHARS || !EMAIL.test(email)) return null;
  return email;
};

export const parseDictionarySettings = (
  input: DictionarySettingsInput,
): DictionarySettings => {
  const contactEmail = parseContactEmail(input.contactEmail);
  if (!isGiven(input.testProvider)) {
    return { ok: true, mode: 'live', contactEmail };
  }
  if (input.testProvider !== '1') {
    return { ok: false, error: 'invalid-test-provider' };
  }
  const isLocal =
    !isGiven(input.vercelEnv) && isLoopbackOrigin(input.appOrigin);
  if (!isLocal) return { ok: false, error: 'test-provider-forbidden' };
  return { ok: true, mode: 'test', contactEmail: null };
};
