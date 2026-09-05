import { defineConfig } from 'vite';

/**
 * Serving config for the PROD build — dist/ on 7777, tm8-server on 7778.
 *
 * Not `vite dev`: this serves the built bundle from dist/ and nothing else.
 * The proxy is the same same-origin plumbing vite.config.ts documents —
 * tm8-server binds loopback with no CORS headers, and `ws: true` is required
 * because /v2 carries both the workspace event stream and the per-session PTY
 * socket.
 *
 * Used by deploy/prod/run-ui.sh. It lives in the repo (not only inside the
 * deployed directory) so a snapshot of the tree actually carries it — the UI
 * supervisor crash-loops on "Could not resolve vite.preview.config.ts" without it.
 *
 * It moved here from `packages/tm8_ui_2.0` on 2026-09-03, when this package
 * became the product UI again and 2.0 became the alternate at `/ui-2.0/`.
 */
const target = process.env.TM8_SERVER_ORIGIN ?? 'http://127.0.0.1:7778';
const port = Number(process.env.TM8_UI_PORT ?? 7777);

export default defineConfig({
  preview: {
    port,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/v2': { target, changeOrigin: false, ws: true },
      '/health': { target, changeOrigin: false },
      /* The alternate 2.0 UI is served by tm8-server (TM8_UI_2_0_DIR), not by
         vite — so it has to be proxied like the API is. Without this line
         `/ui-2.0/` falls to vite's own SPA fallback and answers with THIS
         app's index.html: typing the mount address would appear to work and
         land you back in this bundle. */
      '/ui-2.0': { target, changeOrigin: false },
    },
  },
});
