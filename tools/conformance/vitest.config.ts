import { defineConfig } from 'vitest/config';

/** W1 foundation/generation/honesty gate. No semantic Server is required. */
export default defineConfig({
  test: {
    include: ['./test/foundation/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
