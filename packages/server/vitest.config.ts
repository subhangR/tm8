import { defineConfig } from 'vitest/config';

/**
 * ONE package-level fact: tests here build real worlds.
 *
 * A `packages/server` test typically creates a scratch database, applies the
 * whole migration chain, and boots a real server — measured at ~4.5s on this
 * box, and 9–15s under full-suite contention. Vitest's defaults (5s test,
 * 10s hook) were never a budget for that, and the suite had been paying for it
 * in two ways: 240 hand-written timeout literals restating the same fact, and a
 * tail of tests that were green only by margin and fell over under load.
 *
 * 60s is roughly 2–4x the worst real case — enough to absorb a loaded box,
 * short enough that a genuinely hung test (an unresolved promise, a socket that
 * never closes) still fails within a minute rather than two.
 *
 * `hookTimeout` matters as much as `testTimeout`: the majority of the failures
 * this replaced were `beforeAll`/`afterAll`, which `testTimeout` does not
 * govern. Teardown is the expensive half — dropping a scratch database was
 * measured at 14.4s under load.
 *
 * DELIBERATELY NOTHING ELSE. No `include`/`exclude`: adding this file makes it
 * the default config for a bare `vitest run`, so a collection setting here
 * would silently change WHICH tests run, which is not what this file is for.
 * Vitest already excludes node_modules and dist. `vitest.p3-verify.config.ts`
 * is unaffected — it is selected explicitly with `-c`.
 *
 * A per-test literal still wins over this, so the existing 240 are untouched
 * and any that are too SMALL still need fixing individually.
 */
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
