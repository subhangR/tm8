import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// THROWAWAY, uncommitted: source-aliases @tm8/execution so this package's tests
// can be verified against packages/execution's current src instead of its
// stale dist (dist rebuilds are forbidden repo-wide). Mirrors the same pattern
// packages/tm8-ui/src/data/integration/vitest.config.ts already uses.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'test/w5/**',
      'test/w3/**',
      '**/*.pg.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@tm8/execution': resolve(__dirname, '../execution/src/index.ts'),
    },
  },
});
