import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwaShell } from './vite-plugin-pwa-shell';

/**
 * tm8-ui — the new UI, built from the approved design suite (charter R1).
 * Dev port 4612 is charter-fixed (4610 = tm8-server, 4611 = old UI oracle).
 *
 * The proxy exists for the same reason as the old UI's: tm8-server binds
 * loopback-only with no CORS headers, so the app must stay same-origin.
 * `ws: true` is required — /v2 carries the workspace event stream and the
 * per-session PTY WebSocket. The data layer itself is bridge-owned
 * (src/data/); this is only transport plumbing.
 */
const target = process.env.TM8_SERVER_ORIGIN ?? 'http://127.0.0.1:4610';

/**
 * THIS PACKAGE IS THE PRODUCT UI, served at `/`. It was the frozen 1.0 snapshot
 * between 2026-08-29 and 2026-09-03; on 2026-09-03 the owner reversed that and
 * the pair swapped roles. `packages/tm8_ui_2.0` is now the ALTERNATE UI behind
 * the version switch, at `/ui-2.0/`; see `scripts/lib/ui.mjs`, the pointer every
 * launcher, doctor and deploy path reads.
 *
 * Three things follow from being the ROOT bundle, and each was the opposite
 * while this package was the mounted one:
 *
 *  1. NO `base`. Vite's default `/` is correct and must stay implicit-correct:
 *     the mount path is baked into every asset URL at build time, so a `base`
 *     here would make every asset 404 at the root. The mounted bundle's base
 *     lives in `tm8_ui_2.0/vite.config.ts` and is duplicated in
 *     `packages/server/src/http/static.ts` (`UI_2_0_MOUNT_PATH`) and
 *     `tm8-ui/src/ui-version/mount.ts`; changing it means changing all three
 *     and rebuilding that bundle.
 *
 *  2. `build.outDir` is the default `dist`, and `TM8_UI_DIR` names it. The old
 *     `dist-1.0` override was a production interlock against a stale
 *     root-owned `/etc/tm8/prod.env`; that pointer has since been rewritten and
 *     `deploy/utho/deploy.sh` removes the legacy `dist` symlink before building,
 *     so emitting `dist` here no longer risks repointing production.
 *
 *  3. `pwaShell` IS INSTALLED. A service worker belongs to whichever bundle
 *     holds the root scope, and that is this one; `src/pwa/register.ts` guards
 *     on `BASE_URL === '/'` so a mounted build of this package would still
 *     register nothing. `tm8_ui_2.0` drops the plugin for the matching reason
 *     on its side — two workers racing over one origin is not something the
 *     alternate UI needs to be worth having.
 */
export default defineConfig({
  plugins: [
    react(),
    /**
     * The precache list. `critical` (the HTML, entry chunk and stylesheet) is
     * derived from the bundle; these are the copied-from-`public/` files worth
     * having offline on top of it.
     *
     * The two font faces are Hanken Grotesk 400 and 600 latin — `--pn-ui` at
     * body weight and at the weight every heading, title and tab label uses.
     * They are 69 kB together and they are the difference between the installed
     * app looking like itself on a cold offline launch and falling back to
     * system-ui. The other faces (latin-ext, the serif display face, the mono)
     * are runtime-cached: they are wanted less often and `font-display: swap`
     * means their absence costs a repaint, not a broken screen.
     */
    pwaShell({
      optional: [
        '/manifest.webmanifest',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/icon-maskable-512.png',
        '/icons/apple-touch-icon-180.png',
        '/favicon.ico',
        '/tm8-mark.png',
        '/fonts/HankenGrotesk-400-latin.woff2',
        '/fonts/HankenGrotesk-600-latin.woff2',
      ],
    }),
  ],
  server: {
    port: 4612,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/v2': { target, changeOrigin: false, ws: true },
      '/health': { target, changeOrigin: false },
      /* The alternate 2.0 UI is served by tm8-server (TM8_UI_2_0_DIR), not by
         vite — so the version switch's destination has to be proxied like the
         API is. Without this line `/ui-2.0/` falls to vite's own SPA fallback
         and answers with THIS app's index.html: the switch would appear to
         work and change nothing. */
      '/ui-2.0': { target, changeOrigin: false },
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
