import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**', 'dist/**'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'evals/**/*.ts'],
      // Tests sit next to the code; their helpers and fixtures are not product code.
      exclude: [
        '**/*.test.ts',
        '**/__fixtures__/**',
        'evals/evalKit.ts',
        'src/store/adapters/lockContender.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
