import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';

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
  plugins: [react()],
  server: {
    port: 4612,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/v2': {
        target,
        changeOrigin: false,
        ws: true,
        /* TEMPORARY DIAGNOSTIC TAP (2026-08-15, staging auth lockout): logs
           method, path, header PRESENCE and body length for auth.login only —
           never the credential itself. Remove once the sign-in defect is
           understood. */
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.includes('/auth/login')) {
              const chunks: Buffer[] = [];
              req.on('data', (c: Buffer) => chunks.push(c));
              req.on('end', () => {
                const body = Buffer.concat(chunks);
                const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
                console.log(
                  '[auth-tap]', new Date().toISOString(), req.method, req.url,
                  'bearer=', Boolean(req.headers.authorization),
                  'cookie=', Boolean(req.headers.cookie),
                  'x-tm8-client=', Boolean(req.headers['x-tm8-client']),
                  'len=', body.length, 'sha12=', hash,
                );
              });
            }
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            if (req.url?.includes('/auth/login')) {
              const chunks: Buffer[] = [];
              proxyRes.on('data', (c: Buffer) => chunks.push(c));
              proxyRes.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                console.log('[auth-tap]', 'status=', proxyRes.statusCode,
                  'body=', proxyRes.statusCode === 200 ? '(token issued)' : text.slice(0, 160));
              });
            }
          });
        },
      },
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
    // KNOWN-OPEN, deliberately not chased: the next probe is whether the runner
    // can start without the node-level `--localstorage-file` injection it warns
    // about on every run — the current suspect for shadowing jsdom's Storage.
    // Suspected, not asserted.
    environmentOptions: { jsdom: { url: 'http://localhost' } },
  },
});
