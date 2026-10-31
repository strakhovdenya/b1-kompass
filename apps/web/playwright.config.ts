import { defineConfig, devices } from '@playwright/test';
import {
  TEST_GUEST_SESSIONS_PER_MINUTE,
  readTestSupabaseEnv,
} from './tests/support/env';

const PORT = 3100;
const LIMITS_SPEC = '**/guest-limits.spec.ts';
const env = readTestSupabaseEnv();

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
      testIgnore: LIMITS_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'limits',
      testMatch: LIMITS_SPEC,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      SUPABASE_URL: env.url,
      SUPABASE_SECRET_KEY: env.secretKey,
      GUEST_SESSIONS_PER_MINUTE: String(TEST_GUEST_SESSIONS_PER_MINUTE),
    },
  },
});
