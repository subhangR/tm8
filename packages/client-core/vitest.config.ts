import { defineConfig } from 'vitest/config';

/**
 * The moved suites ran under tm8-ui's config in the `node` environment and
 * import every helper they use from `vitest` themselves, so nothing here
 * needs jsdom, globals or a setup file.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
