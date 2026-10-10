import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against the rate limiter's source so no build step is needed first.
      '@challenge/rate-limiter': fileURLToPath(
        new URL('../rate-limiter/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', '**/node_modules/**'],
    globalSetup: ['test/global-setup.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/demo/server.ts', 'src/index.ts', 'src/generated/**'],
    },
  },
});
