import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
/* `pwaShell` is deliberately NOT in `plugins` — see point 3 below. The import
   stays so re-installing it is one line if this package ever takes the root
   back; the plugin and `src/pwa/` are otherwise complete and dormant. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { pwaShell } from './vite-plugin-pwa-shell';

/**
 * tm8_ui_2.0 — the Astryx redesign. THE ALTERNATE UI, served at `/ui-2.0/`.
 *
 * It was the product UI at `/` from 2026-08-29 (PRs #526/#531) until
 * 2026-09-03, when the owner reversed that and `packages/tm8-ui` took the root
 * back. This package is now what `packages/tm8-ui` was in between: built and
 * served, behind the version switch, and only when an operator sets
 * `TM8_UI_2_0_DIR`. See `scripts/lib/ui.mjs`.
 *
 * Three things here exist only because of that, and each would be wrong for a
 * bundle served at the root:
 *
 *  1. `base` — the mount path is baked into every asset URL at build time. It
 *     is duplicated in `packages/server/src/http/static.ts`
 *     (`UI_2_0_MOUNT_PATH`) and `packages/tm8-ui/src/ui-version/mount.ts`;
 *     changing it means changing all three and rebuilding this bundle.
 *
 *  2. `build.outDir` is `dist-2.0`, NOT `dist`. A safety interlock, not a
 *     preference: `TM8_UI_DIR` names the ROOT bundle, and if it is ever left
 *     naming this package a `dist/` built with `base: '/ui-2.0/'` would serve
 *     an index whose every asset 404s — a white screen with a 200. An absent
 *     `dist/` fails loudly instead.
 *
 *  3. NO `pwaShell`. A service worker for this bundle would install with
 *     `/ui-2.0/` scope beside the product worker's root scope; two workers
 *     racing over one origin is not something the alternate UI needs to be
 *     worth having. `packages/tm8-ui/src/pwa/service-worker.js` excludes this
 *     mount for the matching reason on its side, and `src/pwa/register.ts`
 *     here returns early because `BASE_URL !== '/'`.
 *
 * The proxy exists for the same reason as the product UI's: tm8-server binds
 * loopback-only with no CORS headers, so the app must stay same-origin.
 * `ws: true` is required — /v2 carries the workspace event stream and the
 * per-session PTY WebSocket. The data layer itself is bridge-owned
 * (src/data/); this is only transport plumbing.
 */
const target = process.env.TM8_SERVER_ORIGIN ?? 'http://127.0.0.1:4610';

export default defineConfig({
  base: '/ui-2.0/',
  build: { outDir: 'dist-2.0' },
  plugins: [react()],
  server: {
    port: 4612,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/v2': { target, changeOrigin: false, ws: true },
      '/health': { target, changeOrigin: false },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Same trap the old UI documented: without NODE_ENV=test React resolves
    // to its production build and every jsdom render dies inside act().
    env: { NODE_ENV: 'test' },
    // jsdom with NO url runs at an OPAQUE ORIGIN, where localStorage is a
    // security REFUSAL by design ("blocked origin") — not a missing API. This
    // url removes that hazard, which is real and worth keeping (A1a's
    // root-cause, 2026-07-28).
    //
    // CORRECTED 2026-07-29: it does NOT restore working storage under this
    // runner, and the original wording here — "per-file stubs are the
    // workaround this retires" — was a claim this comment made before anyone
    // tested it. Measured: the url IS in effect (`location.href` is
    // `http://localhost/`) and `localStorage` is still an object with no
    // `setItem`/`removeItem`, the SAME object on `window` and `globalThis`,
    // which is not jsdom's Storage at any origin. PER-FILE STUBS REMAIN
    // NECESSARY (see `src/views/realSeamFlag.test.ts`).
    //
    // CLOSED 2026-08-18 — the suspect was the culprit, measured in
    // `test-setup.ts`: Node's experimental global `localStorage` (no
    // `--localstorage-file` ⇒ a stub on 22, plain `undefined` on 26) is
    // copied over jsdom's Storage when the worker global is populated. The
    // setup file installs a working Map-backed Storage before every file,
    // which also ends the parallel-run flakiness: per-file stubs used to
    // leak through re-used worker globals, so unstubbed files passed or
    // failed by which neighbour ran first in their worker.
    environmentOptions: { jsdom: { url: 'http://localhost' } },
    setupFiles: ['./test-setup.ts'],
    /**
     * THE DEADLINE IS A CLAIM ABOUT THE MACHINE, AND THE DEFAULT ONE IS FALSE
     * HERE.
     *
     * vitest's default `testTimeout` is 5000 ms. That is generous for a test
     * that computes something and ample on an idle laptop; it is not ample for
     * a jsdom mount of a React shell on a box where the CPU is shared. MEASURED
     * on this repo's build node — 4 cores, load average 15-24, up to eight agent
     * sessions running suites at once — a full-suite run of this package on
     * clean `origin/main` produced 22 failures across 13 files, and TEN of them
     * were literally `Test timed out in 5000ms`, in files with no defect: the
     * gate suite, home-trails, share-a-link, panel-resize, server-signin, the
     * board screen. The same commit is green on CI.
     *
     * A timeout that fires on a slow machine does not report a slow machine. It
     * reports a FAILURE, indistinguishable in the log from a real one, and that
     * is the whole disease this file's package has been suffering from: a red
     * baseline in which no green means anything. Raising the deadline weakens no
     * assertion — a wrong expectation still fails, it just gets to finish first.
     *
     * 30 s is chosen to be far outside the load the node actually reaches, not
     * finely tuned to it: a value tuned to load average 17 is a new false claim
     * the day the node reaches 30. Files that need MORE still say so locally
     * (`panels.test.tsx` and `board.test.tsx` set 20 s of their own, which this
     * now exceeds; `settings.test.tsx` sets 60 s, which still wins). Override
     * with `TM8_TEST_TIMEOUT_MS` — set it to 5000 to reproduce the default.
     */
    testTimeout: Number(process.env['TM8_TEST_TIMEOUT_MS'] ?? 30_000),
    hookTimeout: Number(process.env['TM8_TEST_TIMEOUT_MS'] ?? 30_000),
  },
});
