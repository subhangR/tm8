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
     * system-ui. The other 19 faces (latin-ext, the serif display face, the
     * mono) are runtime-cached: they are wanted less often and `font-display:
     * swap` means their absence costs a repaint, not a broken screen.
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
  },
});
