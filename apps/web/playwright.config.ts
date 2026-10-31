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
// The specs written for the pilot short set. Every other spec runs against
// the synthetic full set, so new specs need no change here.
const SHORT_SET_SPECS = [
  '**/guest-entry.spec.ts',
  '**/hoeren-single.spec.ts',
  '**/material-publication.spec.ts',
  '**/short-practice.spec.ts',
];
const env = readTestSupabaseEnv();

const serverEnv = {
  SUPABASE_URL: env.url,
  SUPABASE_SECRET_KEY: env.secretKey,
  GUEST_SESSIONS_PER_MINUTE: String(TEST_GUEST_SESSIONS_PER_MINUTE),
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
  // whole database, so it runs alone after every other spec.
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
      testIgnore: [...SHORT_SET_SPECS, PAIR_SPEC, LIMITS_SPEC],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${FULL_PORT}`,
      },
    },
    {
      name: 'limits',
      testMatch: LIMITS_SPEC,
      dependencies: ['chromium', 'pair', 'full'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `npm run start -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: serverEnv,
    },
    // The same build, serving the test exam with a Teil 3 pair.
    {
      command: `npm run start -- --port ${PAIR_PORT}`,
      url: `http://localhost:${PAIR_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...serverEnv, PRACTICE_EXAM_SLUG: PAIR_EXAM.slug },
    },
    // The same build, serving the synthetic full DTZ set.
    {
      command: `npm run start -- --port ${FULL_PORT}`,
      url: `http://localhost:${FULL_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...serverEnv, PRACTICE_EXAM_SLUG: FULL_EXAM.slug },
    },
  ],
});
