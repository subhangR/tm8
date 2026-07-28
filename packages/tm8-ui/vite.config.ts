import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
    // security REFUSAL by design ("blocked origin") — not a missing API. Any
    // per-file `@vitest-environment jsdom` here inherits this url so storage
    // exists; found when the real-seam flag tests hit the wall (A1a's
    // root-cause, 2026-07-28; per-file stubs are the workaround this retires).
    environmentOptions: { jsdom: { url: 'http://localhost' } },
  },
});
