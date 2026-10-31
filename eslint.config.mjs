import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import tseslint from 'typescript-eslint';

const UI_PATHS = [
  'apps/web/src/features/**/*.{ts,tsx}',
  'apps/web/src/theme/**/*.{ts,tsx}',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'supabase/**',
      '.claude/**',
      'apps/web/next-env.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
  ...nextVitals.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{ts,tsx}'],
  })),
  ...nextTypescript.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{ts,tsx}'],
  })),
  {
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // UI must not reach privileged server code or the Supabase SDK.
    files: UI_PATHS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/(.*/)?server(/.*)?$',
              message: 'UI uses contracts, not server modules.',
            },
            { group: ['@supabase/*'], message: 'UI does not use the Supabase SDK.' },
          ],
        },
      ],
    },
  },
);
