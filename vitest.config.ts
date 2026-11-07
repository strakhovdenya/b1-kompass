import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/web/src/**/*.test.{ts,tsx}',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: false,
  },
});
