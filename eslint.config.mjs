import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // CLI scripts and test runners report to the terminal.
    files: ['scripts/**', 'e2e/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
  globalIgnores(['.next/**', 'node_modules/**', 'next-env.d.ts', 'e2e/.artifacts/**']),
]);
