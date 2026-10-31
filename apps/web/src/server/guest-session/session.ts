import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_LOCALE, isGuestActive, isLocale } from '@b1k/domain';
import type { Locale } from '@b1k/domain';
import { ruleViolation } from '../db';
import type { ServerDeps } from '../db';

export interface GuestContext {
  sessionId: string;
  visitorId: string;
  locale: Locale;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreatedGuest {
  token: string;
  guest: GuestContext;
}

interface GuestSessionRow {
  id: string;
  visitor_id: string;
  locale: string;
  created_at: string;
  expires_at: string;
}

const SESSION_COLUMNS = 'id, visitor_id, locale, created_at, expires_at';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const hashGuestToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const toContext = (row: GuestSessionRow): GuestContext => ({
  sessionId: row.id,
  visitorId: row.visitor_id,
  locale: isLocale(row.locale) ? row.locale : DEFAULT_LOCALE,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
});

export type CreateGuestResult =
  { status: 'created'; created: CreatedGuest } | { status: 'rate-limited' };

// A new guest always starts in English, whatever the browser or an earlier
// session used. The database counts and inserts in one call
// (create_guest_session), so the whole site creates at most `perMinute`
// sessions in any minute.
export const createGuestSession = async (
  deps: ServerDeps,
  perMinute: number,
): Promise<CreateGuestResult> => {
  const token = randomBytes(32).toString('base64url');
  const { data, error } = await deps.db
    .rpc('create_guest_session', {
      p_token_hash: hashGuestToken(token),
      p_now: deps.clock.now().toISOString(),
      p_limit: perMinute,
    })
    .select(SESSION_COLUMNS)
    .single<GuestSessionRow>();
  if (error) {
    if (ruleViolation(error) === 'guest_rate_limited') {
      return { status: 'rate-limited' };
    }
    throw new Error('Guest session was not created', { cause: error });
  }
  return { status: 'created', created: { token, guest: toContext(data) } };
};

// The single check of guest credentials. Handlers get a verified context or
// null; reading never extends the term.
export const resolveGuestSession = async (
  deps: ServerDeps,
  token: string | null | undefined,
): Promise<GuestContext | null> => {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await deps.db
    .from('guest_sessions')
    .select(SESSION_COLUMNS)
    .eq('token_hash', hashGuestToken(token))
    .maybeSingle<GuestSessionRow>();
  if (error) throw new Error('Guest session lookup failed', { cause: error });
  if (!data) return null;
  const guest = toContext(data);
  if (!isGuestActive(guest.expiresAt, deps.clock.now())) return null;
  return guest;
};

// Returns false when the session ended before the update reached it.
export const setGuestLocale = async (
  deps: ServerDeps,
  guest: GuestContext,
  locale: Locale,
): Promise<boolean> => {
  const { data, error } = await deps.db
    .from('guest_sessions')
    .update({ locale })
    .eq('id', guest.sessionId)
    .gt('expires_at', deps.clock.now().toISOString())
    .select('id');
  if (error) throw new Error('Guest locale was not saved', { cause: error });
  return data.length === 1;
};
