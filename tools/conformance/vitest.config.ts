import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/global-setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    // The suite mutates one shared world per file; keep files sequential so
    // cursor/pagination assertions see stable pages.
    fileParallelism: false,
  },
});
