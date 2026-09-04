/**
 * Registers the app-shell service worker.
 *
 * DEV IS EXCLUDED ON PURPOSE. `sw.js` is emitted by the build (it needs the
 * hashed asset names), so it does not exist under `vite dev` — and a worker
 * that did exist there would serve yesterday's modules straight through HMR,
 * which is the single most confusing failure a frontend dev can be handed.
 *
 * SECURE CONTEXT. `navigator.serviceWorker` is undefined on a plain-http
 * origin that is not loopback. That is not a bug to work around here, it is the
 * platform: the tailnet https origin and 127.0.0.1 qualify, a phone pointed at
 * `http://<lan-ip>:7777` does not. The same constraint already governs
 * `crypto.subtle`, which the auth gate needs for PBKDF2 — so on a plain-http
 * LAN origin the app cannot sign in either, and a missing service worker is the
 * lesser of the two symptoms. We degrade silently rather than warn, because
 * every non-secure origin is a developer on purpose, and the app works fine
 * without a worker; it simply is not installable.
 *
 * A MOUNTED BUILD REGISTERS NOTHING, and this is a correctness guard rather
 * than an optimisation. Since 2026-09-03 this package is built with
 * `base: '/ui-2.0/'` and served beside the product UI on one origin, with no
 * `pwaShell` — so it emits no `sw.js`. The line below asks for `/sw.js` at
 * root scope, and at the root of that shared origin sits `packages/tm8-ui`'s
 * worker: without this guard the 2.0 app would successfully register the 1.0
 * WORKER over the whole origin. It would then answer offline navigations —
 * including navigations back to `/` — from a precache of a bundle this app
 * never built, and nothing would report it, because the registration SUCCEEDS.
 * The `.catch` below cannot help; there is no error.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (import.meta.env.BASE_URL !== '/') return;
  if (!('serviceWorker' in navigator)) return;

  // `load` matters: registration competes with the app's own boot requests for
  // connections, and the shell should paint first.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // A failed registration must never take the app down with it. The app is
      // fully functional unregistered — it is only offline launch that is lost.
    });
  });
}
