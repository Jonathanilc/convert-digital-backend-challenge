import { defineConfig } from 'vitest/config';

/**
 * Black-box smoke suite: runs against an already running instance (APP_URL), typically the
 * production image started by compose.prod.yaml. Needs no Redis access of its own.
 */
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
