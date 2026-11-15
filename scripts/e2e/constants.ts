// The identity of the local E2E Supabase stack and of the development stack
// it must never touch (#96). Every value is a constant of the code: no
// environment variable, flag or URL can select another target.

export interface StackProfile {
  readonly projectId: string;
  readonly dbContainer: string;
  // The API gateway: the endpoint Storage is reached through.
  readonly gatewayContainer: string;
  readonly apiUrl: string;
  readonly apiPort: number;
  readonly dbPort: number;
  // Repository-relative directory of the config.toml the CLI is pointed at.
  readonly workdir: string;
}

export const E2E_STACK: StackProfile = {
  projectId: 'b1-kompass-e2e',
  dbContainer: 'supabase_db_b1-kompass-e2e',
  gatewayContainer: 'supabase_kong_b1-kompass-e2e',
  apiUrl: 'http://127.0.0.1:54421',
  apiPort: 54421,
  dbPort: 54422,
  workdir: 'supabase/e2e',
};

// The development stack: never a local E2E target. CI starts a fresh stack
// with this very project id, so the CI guard may attest it, and only it.
export const DEV_STACK: StackProfile = {
  projectId: 'b1-kompass',
  dbContainer: 'supabase_db_b1-kompass',
  gatewayContainer: 'supabase_kong_b1-kompass',
  apiUrl: 'http://127.0.0.1:54321',
  apiPort: 54321,
  dbPort: 54322,
  workdir: '.',
};

// The marker that bootstrap writes into the E2E database and every
// destructive step reads back from that exact database.
export const MARKER_SCHEMA = 'e2e_infra';
export const MARKER_KEY = 'stack';
export const MARKER_VALUE = 'b1-kompass-e2e:v1';

// The database URL the migration CLI is given: constant, never `--local`.
export const E2E_DB_URL =
  'postgresql://postgres:postgres@127.0.0.1:54422/postgres';

export const RUN_TOKEN_ENV = 'B1K_E2E_RUN_TOKEN';

// Ports of the three `next start` servers of apps/web/playwright.config.ts.
export const APP_PORTS: readonly number[] = [3100, 3101, 3102];

// Services the E2E stack does not need: the app talks to PostgREST and
// Storage only.
export const EXCLUDED_SERVICES = [
  'studio',
  'mailpit',
  'realtime',
  'imgproxy',
  'vector',
  'logflare',
  'edge-runtime',
  'postgres-meta',
] as const;

export const E2E_BUCKET = 'exam-sources';

// Test data the cleanup may empty: exactly these tables, nothing else.
export const CLEANUP_TABLES: readonly string[] = [
  'public.answer_keys',
  'public.attempt_answers',
  'public.attempt_commands',
  'public.attempt_results',
  'public.attempt_runs',
  'public.attempts',
  'public.dictionary_budget',
  'public.dictionary_cache',
  'public.exam_version_audio',
  'public.exam_versions',
  'public.exams',
  'public.guest_events',
  'public.guest_sessions',
  'm2_private.timing_profile_revisions',
  'm2_private.timing_profiles',
];

// Schemas of Supabase itself and the marker: their tables are never cleaned
// and are not judged as unknown.
export const SYSTEM_SCHEMAS: readonly string[] = [
  'pg_catalog',
  'information_schema',
  'auth',
  'storage',
  'cron',
  'vault',
  'supabase_functions',
  'supabase_migrations',
  '_realtime',
  'realtime',
  'extensions',
  'graphql',
  'graphql_public',
  MARKER_SCHEMA,
];
