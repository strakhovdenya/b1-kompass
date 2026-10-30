import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ServiceClient = SupabaseClient;

export interface Clock {
  now(): Date;
}

export interface ServerDeps {
  db: ServiceClient;
  clock: Clock;
}

export interface ServiceConfig {
  url: string;
  secretKey: string;
}

export const systemClock: Clock = { now: () => new Date() };

// The only privileged Supabase client of the runtime. It bypasses RLS, so it
// lives in src/server and is never imported by UI code.
export const createServiceClient = (config: ServiceConfig): ServiceClient =>
  createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export const readServiceConfig = (
  env: Readonly<Record<string, string | undefined>>,
): ServiceConfig => {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  }
  return { url, secretKey };
};

// Supabase reports expected rule violations of the trusted functions as
// P0001 with a stable hint.
export const ruleViolation = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const { code, hint } = error as { code?: unknown; hint?: unknown };
  if (code !== 'P0001' || typeof hint !== 'string') return null;
  return hint;
};
