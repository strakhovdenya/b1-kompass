import { execSync } from 'node:child_process';
import path from 'node:path';

export interface TestSupabaseEnv {
  url: string;
  publishableKey: string;
  secretKey: string;
}

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..', '..');

const readStatus = (): Record<string, string> => {
  const output = execSync('npx supabase status -o env', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
};

// Tests run only against the local, isolated Supabase started by
// `supabase start`; production values are never read here.
export const readTestSupabaseEnv = (): TestSupabaseEnv => {
  const fromEnv = {
    url: process.env.TEST_SUPABASE_URL,
    publishableKey: process.env.TEST_SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.TEST_SUPABASE_SECRET_KEY,
  };
  if (fromEnv.url && fromEnv.publishableKey && fromEnv.secretKey) {
    return fromEnv as TestSupabaseEnv;
  }
  const status = readStatus();
  const url = status.API_URL;
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  if (!url || !publishableKey || !secretKey) {
    throw new Error('Local Supabase is not running: run `npm run db:start`');
  }
  process.env.TEST_SUPABASE_URL = url;
  process.env.TEST_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  process.env.TEST_SUPABASE_SECRET_KEY = secretKey;
  return { url, publishableKey, secretKey };
};
