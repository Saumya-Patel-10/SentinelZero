import { defineConfig } from 'vitest/config';

/** Unit tests: pure logic, no server required. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
