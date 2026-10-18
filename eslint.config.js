import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The pipeline features and the ports know no vendor, file or cloud: they reach the outside only
// through ports. Adapters live in each feature's adapters/ folder; only app/container wires them.
const coreBoundary = {
  paths: [
    { name: 'node:fs', message: 'core knows no files: use the RunStore port.' },
    { name: 'node:fs/promises', message: 'core knows no files: use the RunStore port.' },
    { name: 'ollama', message: 'core knows no vendor: use the ModelProvider port.' },
    { name: 'nodemailer', message: 'core knows no vendor: use the Delivery port.' },
  ],
  patterns: [
    {
      group: [
        '**/adapters/**',
        '**/cli/**',
        '**/scheduler/**',
        '**/observability/**',
        '**/app/**',
        '**/config/load*',
      ],
      message:
        'pipeline features and ports depend only on ports, pipeline features, shared and config/schema.',
    },
  ],
};

export default defineConfig(
  {
    ignores: ['dist/**', 'coverage/**', 'data/**', 'docs/plan/**', '.claude/**', 'node_modules/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
    },
  },
  {
    files: [
      'src/{digest,domain,classify,process,write,select,checks,render}/**/*.ts',
      'src/{sources,guards,models,delivery,store}/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/__fixtures__/**'],
    rules: { 'no-restricted-imports': ['error', coreBoundary] },
  },
  {
    files: ['src/cli/**/*.ts', 'scripts/**', 'evals/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: [
      'test/**/*.ts',
      '**/*.test.ts',
      '**/__fixtures__/**/*.ts',
      'evals/evalKit.ts',
      'src/store/adapters/lockContender.ts',
    ],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
