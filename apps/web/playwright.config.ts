import { defineConfig, devices } from '@playwright/test';
import { FULL_EXAM } from './tests/support/full-exam';
import { PAIR_EXAM } from './tests/support/pair-exam';
import {
  TEST_GUEST_SESSIONS_PER_MINUTE,
  readTestSupabaseEnv,
} from './tests/support/env';

const PORT = 3100;
const PAIR_PORT = 3101;
const FULL_PORT = 3102;
const LIMITS_SPEC = '**/guest-limits.spec.ts';
const PAIR_SPEC = '**/hoeren-pair.spec.ts';
// Lifts the active index and NOT NULL of exam_id inside rolled-back
// transactions: it runs alone, after the ordinary projects.
const MIGRATION_SPEC = '**/m1-migration.spec.ts';
// The specs written for the pilot short set. Every other spec runs against
// the synthetic full set, so new specs need no change here.
const SHORT_SET_SPECS = [
  '**/guest-entry.spec.ts',
  '**/hoeren-single.spec.ts',
  '**/material-publication.spec.ts',
  '**/short-practice.spec.ts',
];
const env = readTestSupabaseEnv();

// Each server trusts exactly its own origin: a request from a sibling port
// is as foreign as any other site.
const originOf = (port: number): string => `http://localhost:${port}`;

// DICTIONARY_TEST_PROVIDER replaces only the external dictionary HTTP
// sources (MyMemory, OpenThesaurus) with a deterministic server-side fake:
// CI never calls them. The server accepts it only without VERCEL_ENV and with
// a loopback APP_ORIGIN; auth, cache and budget still run for real.
const serverEnv = {
  SUPABASE_URL: env.url,
  SUPABASE_SECRET_KEY: env.secretKey,
  GUEST_SESSIONS_PER_MINUTE: String(TEST_GUEST_SESSIONS_PER_MINUTE),
  DICTIONARY_TEST_PROVIDER: '1',
};

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/support/global-setup.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  // The limit spec fills the site-wide window and purges sessions of the
  // whole database, so it runs alone after every other spec, the migration
  // spec included.
  projects: [
    {
      name: 'chromium',
      testMatch: SHORT_SET_SPECS,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'pair',
      testMatch: PAIR_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${PAIR_PORT}`,
      },
    },
    {
      name: 'full',
      testIgnore: [...SHORT_SET_SPECS, PAIR_SPEC, MIGRATION_SPEC, LIMITS_SPEC],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${FULL_PORT}`,
      },
    },
    {
      name: 'migration',
      testMatch: MIGRATION_SPEC,
      dependencies: ['chromium', 'pair', 'full'],
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'limits',
      testMatch: LIMITS_SPEC,
      dependencies: ['migration'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `npm run start -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...serverEnv, APP_ORIGIN: originOf(PORT) },
    },
    // The same build, serving the test exam with a Teil 3 pair.
    {
      command: `npm run start -- --port ${PAIR_PORT}`,
      url: `http://localhost:${PAIR_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...serverEnv,
        APP_ORIGIN: originOf(PAIR_PORT),
        PRACTICE_EXAM_SLUG: PAIR_EXAM.slug,
      },
    },
    // The same build, serving the synthetic full DTZ set.
    {
      command: `npm run start -- --port ${FULL_PORT}`,
      url: `http://localhost:${FULL_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...serverEnv,
        APP_ORIGIN: originOf(FULL_PORT),
        PRACTICE_EXAM_SLUG: FULL_EXAM.slug,
      },
    },
  ],
});
