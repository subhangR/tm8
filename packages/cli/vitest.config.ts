import { defineConfig } from 'vitest/config';

/**
 * The same package-level fact `packages/server/vitest.config.ts` records, for
 * the same reason: `test/integration/**` starts a REAL server against a REAL
 * scratch database, and its `beforeAll`/`afterAll` do the expensive halves —
 * applying the whole migration chain, then dropping the database again.
 *
 * Vitest's 10s default `hookTimeout` was the binding constraint. Under a full
 * run, ten Postgres databases and ten Node servers come up at once, and the
 * teardown `psql drop database` is the one that loses: three suites failed at
 * FILE level with `Hook timed out in 10000ms` while every assertion inside them
 * passed. A file-level red with zero failing assertions is the signature.
 *
 * DELIBERATELY NOTHING ELSE. Adding this file makes it the default config for a
 * bare `vitest run`, so an `include`/`exclude` here would silently change which
 * tests run. Vitest already excludes node_modules and dist.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
