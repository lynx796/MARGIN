import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/web/e2e/**'],
    testTimeout: 60_000,
    pool: 'forks',
  },
});
