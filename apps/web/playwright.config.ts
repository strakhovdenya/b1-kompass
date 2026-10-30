import { defineConfig, devices } from '@playwright/test';
import { readTestSupabaseEnv } from './tests/support/env';

const PORT = 3100;
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      SUPABASE_URL: env.url,
      SUPABASE_SECRET_KEY: env.secretKey,
    },
  },
});
