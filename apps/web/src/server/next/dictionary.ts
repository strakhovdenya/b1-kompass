import 'server-only';
import type {
  DictionaryFailure,
  DictionaryResult,
} from '../../features/dictionary/entry';
import { parseDictionarySettings } from '../dictionary/config';
import type { DictionarySettings } from '../dictionary/config';
import { DEFAULT_LIMITS, lookupWord } from '../dictionary/dictionary';
import type { DictionaryDeps } from '../dictionary/dictionary';
import { createMyMemory } from '../dictionary/mymemory';
import { createOpenThesaurus } from '../dictionary/openthesaurus';
import type { DictionaryProviders } from '../dictionary/providers';
import { createSupabaseDictionaryStore } from '../dictionary/store';
import { createTestProviders } from '../dictionary/test-provider';
import { resolveGuestSession } from '../guest-session/session';
import { privateJson, readTrustedOrigin } from './http';
import { getServerDeps } from './request';

// The Next side of POST /api/dictionary: the body limit, the configuration
// from the environment and the verified guest. Everything else is
// server/dictionary.

// {"word": "..."} with the longest allowed word fits easily.
export const MAX_DICTIONARY_BODY_BYTES = 1024;

const FAILURE_STATUS: Readonly<Record<DictionaryFailure, number>> = {
  'invalid-input': 400,
  'invalid-word': 400,
  'session-invalid': 401,
  unavailable: 503,
};

const respond = (result: DictionaryResult): Response =>
  result.ok
    ? privateJson(result)
    : privateJson(result, FAILURE_STATUS[result.failure]);

const readSettings = (): DictionarySettings =>
  parseDictionarySettings({
    testProvider: process.env.DICTIONARY_TEST_PROVIDER,
    contactEmail: process.env.DICTIONARY_CONTACT_EMAIL,
    vercelEnv: process.env.VERCEL_ENV,
    appOrigin: process.env.APP_ORIGIN,
  });

// The contact of the OpenThesaurus User-Agent: the configured email, else the
// public address of this deployment.
const readContact = (email: string | null): string => {
  if (email) return email;
  const trusted = readTrustedOrigin();
  return trusted.ok ? trusted.origin : 'B1 Kompass';
};

let liveProviders: DictionaryProviders | null = null;
let testProviders: DictionaryProviders | null = null;

const providersFor = (
  settings: Extract<DictionarySettings, { ok: true }>,
): DictionaryProviders => {
  if (settings.mode === 'test') {
    testProviders ??= createTestProviders();
    return testProviders;
  }
  if (!liveProviders) {
    const fetchFn = (url: string, init: RequestInit) => fetch(url, init);
    const { translate } = createMyMemory({
      fetch: fetchFn,
      contactEmail: settings.contactEmail,
    });
    const { thesaurus } = createOpenThesaurus({
      fetch: fetchFn,
      contact: readContact(settings.contactEmail),
    });
    liveProviders = { translate, thesaurus };
  }
  return liveProviders;
};

// A lookup body is tiny: a declared size over 1 KiB is refused after the
// common command checks. A body without a declared size is bounded by
// readCommandBody (64 KiB) and the strict schema of lookupWord.
export const refuseOversizedLookup = (request: Request): Response | null => {
  const declared = Number(request.headers.get('content-length'));
  const isOversized =
    Number.isFinite(declared) && declared > MAX_DICTIONARY_BODY_BYTES;
  return isOversized
    ? privateJson({ ok: false, failure: 'payload-too-large' }, 413)
    : null;
};

// The guest token comes from the httpOnly cookie, the body from
// readCommandBody; resolveGuestSession verifies the guest before the word
// reaches server/dictionary. The response is private, no-store.
export const lookupDictionaryWord = async (
  token: string | null,
  body: unknown,
): Promise<Response> => {
  const settings = readSettings();
  if (!settings.ok) {
    console.error({ error: `Dictionary configuration: ${settings.error}` });
    return respond({ ok: false, failure: 'unavailable' });
  }
  const serverDeps = getServerDeps();
  try {
    const guest = await resolveGuestSession(serverDeps, token);
    if (!guest) return respond({ ok: false, failure: 'session-invalid' });
    const deps: DictionaryDeps = {
      store: createSupabaseDictionaryStore(serverDeps.db),
      providers: providersFor(settings),
      clock: serverDeps.clock,
      limits: DEFAULT_LIMITS,
    };
    return respond(await lookupWord(deps, guest, body));
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    console.error({ error: 'Dictionary lookup failed', code: code ?? null });
    return respond({ ok: false, failure: 'unavailable' });
  }
};
