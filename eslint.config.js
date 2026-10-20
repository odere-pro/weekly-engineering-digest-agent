import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import regexpPlugin from 'eslint-plugin-regexp';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { digest } from './eslint-rules/index.mjs';

// The pipeline features and the ports know no vendor, file or cloud: they reach the outside only
// through ports. Adapters live in each feature's adapters/ folder; only app/container wires them.
// ADR 0001 removed Mastra; bringing a workflow framework back needs ADR 0002.
const noMastra = {
  group: ['@mastra/*'],
  message: 'Mastra was removed (docs/architecture/decisions/0001-mastra.md); write ADR 0002 first.',
};

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
    noMastra,
  ],
};

export default defineConfig(
  {
    ignores: ['dist/**', 'coverage/**', 'data/**', '.claude/**', 'node_modules/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  // Static regex checks (ReDoS and correctness). The two super-linear rules are errors: a link-check
  // regex once took 25 s on 64 KB of `](  `, and collected text is hostile by design.
  regexpPlugin.configs.recommended,
  {
    rules: {
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
    },
  },
  // An eslint-disable that no longer suppresses anything fails the lint instead of only warning.
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
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
    files: ['**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [noMastra] }] },
  },
  {
    files: [
      'src/{digest,domain,classify,process,write,select,checks,render}/**/*.ts',
      'src/{sources,guards,models,delivery,store}/**/*.ts',
    ],
    ignores: [
      '**/*.test.ts',
      '**/__fixtures__/**',
      'src/{sources,guards,models,delivery,store}/adapters/**',
    ],
    rules: { 'no-restricted-imports': ['error', coreBoundary] },
  },
  {
    // This project's own rules (eslint-rules/). `digest/fetch-redirect` is type-aware: it needs the
    // parser's type information, so it runs on TypeScript only. Tests may call a fake fetch freely.
    files: ['src/**/*.ts', 'evals/**/*.ts'],
    ignores: ['**/*.test.ts', '**/__fixtures__/**'],
    plugins: { digest },
    rules: { 'digest/fetch-redirect': 'error' },
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
    // `no-super-linear-move` stays an error for every product file, so all code that reads untrusted
    // text keeps it (checks, render, sources, guards, write, shared, delivery, evals). A test regex
    // runs on short strings the test wrote itself, so quadratic moves cost nothing there.
    files: ['**/*.test.ts', 'test/**/*.ts', '**/__fixtures__/**/*.ts'],
    rules: { 'regexp/no-super-linear-move': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
