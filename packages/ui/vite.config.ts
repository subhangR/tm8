import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite host for the transplanted collab-v2 module (W3, lane 6).
 *
 * The dev server proxies the tm8 catalog rather than letting the browser talk
 * to it cross-origin: tm8-server binds loopback only and ships no CORS headers
 * (HOW-TO-TEST §6 — "Security beyond loopback-only binding is deferred"), so a
 * direct fetch from the page origin would be refused by the browser, not by the
 * server. Proxying keeps the app same-origin and means RealFacade can use
 * relative paths and carry no base-URL configuration into the seam.
 *
 * TM8_SERVER_ORIGIN lets a dev point at their own node; the default is 4620,
 * Keystone's port. :4610 belongs to the CTO and must not be the default.
 */
const target = process.env.TM8_SERVER_ORIGIN ?? 'http://127.0.0.1:4620';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4611,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/v2': { target, changeOrigin: false },
      '/health': { target, changeOrigin: false },
      // The session terminal's PTY byte-stream poll (non-catalog, beside /health).
      '/pty': { target, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    // Carried over from the snapshot's vitest.config.ts. Without it React
    // resolves to its production build and every render dies with
    // "act(...) is not supported in production builds of React" — 339 failures
    // that look like broken tests and are really one missing env var.
    env: { NODE_ENV: 'test' },
  },
});
