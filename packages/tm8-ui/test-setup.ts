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
