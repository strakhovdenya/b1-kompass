import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '../../src/server/db';
import type { Clock, ServerDeps } from '../../src/server/db';
import {
  createGuestSession,
  hashGuestToken,
} from '../../src/server/guest-session/session';
import type { CreatedGuest } from '../../src/server/guest-session/session';
import { TEST_GUEST_SESSIONS_PER_MINUTE, readTestSupabaseEnv } from './env';

const env = readTestSupabaseEnv();

export const serviceDb: SupabaseClient = createServiceClient({
  url: env.url,
  secretKey: env.secretKey,
});

// A browser-side client with the ordinary publishable key: what any visitor
// could call directly against the Data API and Storage.
export const createPublicClient = (): SupabaseClient =>
  createClient(env.url, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export const fixedClock = (at: Date): Clock => ({ now: () => new Date(at) });

export const depsAt = (at: Date): ServerDeps => ({
  db: serviceDb,
  clock: fixedClock(at),
});

export const depsNow = (): ServerDeps => depsAt(new Date());

// A guest created through the real createGuestSession with the e2e limit.
export const newGuest = async (deps: ServerDeps): Promise<CreatedGuest> => {
  const result = await createGuestSession(deps, TEST_GUEST_SESSIONS_PER_MINUTE);
  if (result.status !== 'created') throw new Error('Guest was rate-limited');
  return result.created;
};

export interface StoredSession {
  id: string;
  locale: string;
  created_at: string;
  expires_at: string;
}

export const readSessionByToken = async (
  token: string,
): Promise<StoredSession | null> => {
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .select('id, locale, created_at, expires_at')
    .eq('token_hash', hashGuestToken(token))
    .maybeSingle<StoredSession>();
  if (error) throw error;
  return data;
};

export const readSession = async (id: string): Promise<StoredSession> => {
  const { data, error } = await serviceDb
    .from('guest_sessions')
    .select('id, locale, created_at, expires_at')
    .eq('id', id)
    .single<StoredSession>();
  if (error) throw error;
  return data;
};

export interface StoredAttempt {
  id: string;
  status: string;
}

export const readAttempts = async (
  sessionId: string,
): Promise<StoredAttempt[]> => {
  const { data, error } = await serviceDb
    .from('attempts')
    .select('id, status')
    .eq('guest_session_id', sessionId)
    .returns<StoredAttempt[]>();
  if (error) throw error;
  return data;
};

export const readAnswers = async (
  attemptId: string,
): Promise<Record<string, string>> => {
  const { data, error } = await serviceDb
    .from('attempt_answers')
    .select('question_id, option_id')
    .eq('attempt_id', attemptId)
    .returns<{ question_id: string; option_id: string }[]>();
  if (error) throw error;
  return Object.fromEntries(data.map((row) => [row.question_id, row.option_id]));
};

export const readResults = async (attemptId: string): Promise<unknown[]> => {
  const { data, error } = await serviceDb
    .from('attempt_results')
    .select('*')
    .eq('attempt_id', attemptId);
  if (error) throw error;
  return data;
};
