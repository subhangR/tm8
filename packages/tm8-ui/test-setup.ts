/**
 * WORKING STORAGE FOR EVERY TEST FILE — the package-level cure for the
 * runner's broken `localStorage`, closing the KNOWN-OPEN note in
 * vite.config.ts.
 *
 * ROOT CAUSE, finally measured (2026-08-18). Node ≥22 ships an EXPERIMENTAL
 * global `localStorage` accessor; without `--localstorage-file` it evaluates
 * to a stub with no `setItem` (Node 22) or to plain `undefined` (Node 26).
 * Vitest's worker copies the Node global OVER jsdom's own working Storage
 * when it populates the test global, so every jsdom file inherits the broken
 * one — `location.href` is fine, storage is not, exactly what the config's
 * CORRECTED note measured.
 *
 * WHY THE SUITE FLIPPED IN PARALLEL RUNS AND NOT IN ISOLATION. Ten-plus
 * files worked around it with their own
 * `Object.defineProperty(globalThis, 'localStorage', …)` stubs, and a
 * worker RE-USES its global between the files it hosts: whether an
 * unstubbed file (gate.test, prompts, home-trails' neighbours) found
 * working storage depended on WHICH stubbed file happened to run earlier
 * in the same worker. Same seed, different worker assignment, different
 * failing set — the flakiness every lane has been diffing around.
 *
 * THE FIX: one spec-shaped, Map-backed Storage installed `configurable`
 * before each test file, on `globalThis` and on `window` when the
 * environment has one. Per-file stubs keep working — they redefine over
 * this exactly as they redefined over the broken one — and files with no
 * stub simply get storage that works, on every Node version, matching CI.
 * `beforeEach` clears it so state cannot leak between tests within a file;
 * between FILES the whole global is re-populated, so no cross-file leak.
 */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
  return storage;
}

/**
 * ALWAYS a fresh install, per FILE, unconditionally — three reasons:
 * - This module runs once per test file (`setupFiles`), so a fresh Map here
 *   IS file isolation: a re-used worker global can no longer carry one
 *   file's keys (or one file's stub) into the next.
 * - No `broken()` probe: probing keeps a previous file's leftover storage
 *   alive, which is the cross-file leak by another door.
 * - No `beforeEach` clear: a file that seeds storage at module or describe
 *   scope (last-place.test's throwing stub, realSeamFlag's opt-in) owns its
 *   slot for the whole file; wiping between tests broke exactly those.
 */
function install(target: object): void {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    value: makeStorage(),
  });
}

install(globalThis);
if (typeof window !== 'undefined' && (window as unknown) !== globalThis) {
  install(window);
}

/**
 * `waitFor`'s OWN deadline, which is a SECOND deadline and a much tighter one.
 *
 * Testing Library's `asyncUtilTimeout` defaults to 1000 ms
 * (`@testing-library/dom/dist/config.js:15`), and it is the deadline that
 * actually decides most of this package's async assertions: a `waitFor` gives
 * up after one second and throws its own "Unable to find …" long before
 * vitest's `testTimeout` in vite.config.ts is anywhere near expiring. Raising
 * only the outer one would leave the inner one governing, which is why this is
 * set here and not only there.
 *
 * ONE SECOND IS A CLAIM THAT A REACT SHELL MOUNTS AND SETTLES IN UNDER A
 * SECOND. On this repo's build node — 4 cores, load average 15-24, up to eight
 * agent sessions running suites at once — it does not, and the failure it
 * produces is a plain red with a DOM dump, indistinguishable from a real
 * missing element. That is how `unbuilt-view-card.test.tsx` came to be reported
 * as a failure that "passes in isolation", and it is the same shape as the
 * craft-screen cases that fail one round in ten and pass the other nine.
 *
 * This weakens nothing. `waitFor` polls and returns the instant its callback
 * succeeds, so a passing assertion costs exactly what it costs today; only a
 * FAILING one waits longer before it reports — and an assertion that was going
 * to fail still fails, with the same message. What changes is that an assertion
 * that was going to SUCCEED is no longer cut off by the clock.
 *
 * Deliberately kept under vite.config.ts's `testTimeout` so the inner deadline
 * fires first and names the element, rather than the outer one firing and
 * saying only "Test timed out". Override with `TM8_TEST_ASYNC_TIMEOUT_MS`.
 */
const ASYNC_UTIL_TIMEOUT_MS = Number(process.env['TM8_TEST_ASYNC_TIMEOUT_MS'] ?? 10_000);

/* jsdom only. This file also runs for the many `environment: 'node'` suites in
   this package, and @testing-library/dom reaches for a document at import. */
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/dom');
  configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });
}
