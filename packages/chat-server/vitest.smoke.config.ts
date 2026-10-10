import { defineConfig } from 'vitest/config';

/** Black-box smoke suite against a running instance (APP_URL). */
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
