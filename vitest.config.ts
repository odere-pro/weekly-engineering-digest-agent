import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'evals/**/*.test.ts',
      'test/**/*.test.ts',
      'eslint-rules/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '.claude/**', 'dist/**'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'evals/**/*.ts', 'eslint-rules/**/*.mjs'],
      // Tests sit next to the code; their helpers and fixtures are not product code.
      exclude: [
        '**/*.test.ts',
        '**/__fixtures__/**',
        'evals/evalKit.ts',
        'src/store/adapters/lockContender.ts',
        // Entry glue: builds the program from `./program` (covered by its own tests) and parses argv.
        'src/cli/index.ts',
      ],
      reporter: ['text', 'json-summary'],
      // Each file must reach the bar on its own: a 99% average once hid `src/cli/program.ts` at 66%.
      thresholds: { perFile: true, lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
