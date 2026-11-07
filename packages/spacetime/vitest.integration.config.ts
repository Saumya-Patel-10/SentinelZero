import { defineConfig } from 'vitest/config';

/** Integration tests against a real local SpacetimeDB 2.14.1 server (see docs/api-contracts.md). */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    onConsoleLog: log => !log.includes('Connecting to SpacetimeDB WS'),
  },
});
