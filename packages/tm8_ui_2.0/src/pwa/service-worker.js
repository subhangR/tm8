/* eslint-env serviceworker */
/**
 * tm8's service worker — the app SHELL, and nothing that could lie about work.
 *
 * ==========================================================================
 * THE ONE RULE THAT MATTERS: /v2 IS NEVER CACHED. NOT READ, NOT WRITTEN.
 * ==========================================================================
 *
 * `src/data/launch-cache.ts` already decided this for the browser-side cache
 * and wrote down why: tasks, docs and sessions are paged, they change
 * constantly, and "a stale row in a list is a lie about the work". The domain
 * store therefore starts EMPTY on every load, on purpose, and offline is meant
 * to be an honest "no node" — not invented rows from an earlier session.
 *
 * A service worker is exactly where that ruling would get quietly reversed,
 * because a `/v2` entry in a cache-first handler looks like a performance win
 * and nobody goes looking for it here. So it is stated once, loudly, and
 * enforced by `isApiRequest()` below, which returns BEFORE `respondWith` is
 * ever called — the request goes to the network untouched or it fails, and a
 * failure is what the app renders its empty state from.
 *
 * There is a second, independent reason, and it will outlive the first: today
 * API requests carry NO credentials at all — no cookie, no Authorization
 * header. The moment auth becomes real, any cached `/v2` response would be a
 * response for one user served to whoever opened the browser next. Caching
 * these is not a tuning decision that can be revisited later; it is a data leak
 * waiting for a login screen.
 *
 * If you are here to add offline data, the honest shape is a deliberate,
 * user-visible, per-entity "keep offline" that stores through the DOMAIN layer
 * with its own staleness UI. It is not a line in this file.
 *
 * ==========================================================================
 * WHAT IT DOES CACHE, AND WHY SO LITTLE
 * ==========================================================================
 *
 * The precache is the SHELL ONLY: the HTML, the entry chunk, the stylesheet,
 * the two UI font faces and the icons. It is injected at build time by
 * `vite-plugin-pwa-shell.ts` as an explicit list of the real hashed filenames.
 *
 * It is emphatically NOT `globPatterns: ['**' + '/*.{js,css,html}']`. That
 * glob would precache the whole of `dist/` — ~40 mermaid diagram renderers,
 * cytoscape, katex — on INSTALL, over whatever connection the phone happens to
 * have. Those are lazy routes: they are code-split precisely so that most
 * sessions never load them. They are runtime-cached here instead, so the first
 * visit that actually opens a diagram pays for the diagram renderer and every
 * later visit does not.
 *
 * ==========================================================================
 * FRESHNESS
 * ==========================================================================
 *
 * Navigations are network-first. The classic way to brick a PWA is to serve a
 * cached index.html forever: it references content-hashed chunks that no longer
 * exist on the server, and the app dies on a chunk 404 with no way for the user
 * to recover. Network-first means a deploy is picked up on the next load, and
 * the cached copy is only ever reached when the network genuinely cannot
 * answer. Prod is served by `vite preview`, which gives us no place to set
 * Cache-Control, so freshness has to live here.
 *
 * `skipWaiting` + `clients.claim` are deliberate for the same reason. A worker
 * that waits for every tab to close can sit stale for days on a phone that
 * never really closes anything. The usual hazard of claiming eagerly — a page
 * mid-session suddenly getting different responses — does not bite here,
 * because assets are content-hashed and a cache miss falls through to network.
 */

// Injected by vite-plugin-pwa-shell.ts at build time.
const SHELL = self.__TM8_SHELL__;
const BUILD = self.__TM8_BUILD__;

const CACHE = `tm8-shell-${BUILD}`;

/**
 * WHY EVERY CACHE READ IGNORES `Vary`. This is not a micro-optimisation; without
 * it the offline shell is broken in a way that only ever shows up offline.
 *
 * `vite preview` — which is how prod is served — sends `Vary: Origin` on every
 * response. Cache matching honours `Vary`, so a stored response is only returned
 * to a request whose `Origin` header matches the one that fetched it. The
 * precache is fetched BY THIS WORKER, which sends no `Origin`. But vite emits
 * `<script type="module" crossorigin>` and `<link rel="stylesheet" crossorigin>`,
 * so the PAGE asks for those same files as CORS requests, WITH an `Origin`.
 *
 * The result: the navigation is served from cache (matched by URL string, no
 * Origin either), the app's HTML appears, and then the entry chunk and the
 * stylesheet miss the cache, fall through to `fetch`, and fail — an offline
 * launch that renders a blank page with the shell sitting right there in the
 * cache. Measured, not theorised: `#root` had 0 children and
 * `getComputedStyle(document.body).fontFamily` was `Times`.
 *
 * Ignoring `Vary` is correct here rather than merely convenient: this cache only
 * ever stores same-origin `basic` responses, so there is exactly one origin it
 * could vary on. There is no second variant to confuse.
 *
 * Constraint worth remembering: prod has no in-repo place to set response
 * headers, so this could not have been fixed by removing the `Vary`.
 */
const MATCH = { ignoreVary: true };

/** Paths that are cacheable static build output. Everything else falls through. */
const STATIC_PREFIXES = ['/assets/', '/fonts/', '/icons/'];
const STATIC_FILES = ['/favicon.ico', '/tm8-mark.png', '/tm8-mark.svg', '/manifest.webmanifest'];

/**
 * The guard for the ruling at the top of this file.
 *
 * `/v2` is the whole API surface — entities, collections, messages, the event
 * stream and the PTY socket. `/health` is the node liveness probe, and a cached
 * "healthy" is a lie of exactly the same kind.
 */
function isApiRequest(url) {
  return url.pathname === '/v2'
    || url.pathname.startsWith('/v2/')
    || url.pathname === '/health';
}

/**
 * The OTHER UI — this worker's root scope would cover it, and must not.
 *
 * DORMANT SINCE 2026-09-03. This bundle no longer installs `pwaShell`, so no
 * `sw.js` is emitted from this source and `register.ts` returns early on
 * `BASE_URL !== '/'`. It is kept intact, and correct for the root case, so
 * that re-installing the plugin is the only edit needed if this package ever
 * takes the root back — a worker resurrected without this guard is a silent
 * failure. `packages/tm8-ui/src/pwa/service-worker.js` carries the live copy,
 * excluding `/ui-2.0/`.
 *
 * `/ui-1.0/` is a whole second application bundle, not a route of this one.
 * Two failures follow from touching it, and the navigation one is the reason
 * this exists: `networkFirst` falls back to THIS app's cached `/index.html`
 * when the network fails, so an offline navigation to `/ui-1.0/` would boot
 * the 2.0 shell at the 1.0 address — the switch would appear to do nothing.
 * Its assets would also be cached under this worker's key while its own build
 * hashes are unknown here, so a 1.0 redeploy could not evict them.
 */
function isOtherUi(url) {
  return url.pathname === '/ui-1.0' || url.pathname.startsWith('/ui-1.0/');
}

function isStatic(url) {
  return STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))
    || STATIC_FILES.includes(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The shell is split into what the app cannot boot without and what merely
    // makes it look like itself. `addAll` is atomic — one 404 in the optional
    // list would otherwise fail the whole install and leave no worker at all.
    await cache.addAll(SHELL.critical);
    await Promise.all(SHELL.optional.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('tm8-shell-') && n !== CACHE)
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

/** Network, but give up waiting long before the user does. */
async function networkFirst(request, timeoutMs = 4000) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('sw: network timeout')), timeoutMs)),
    ]);
    if (response && response.ok) cache.put('/index.html', response.clone());
    return response;
  } catch {
    // Offline, or a captive portal swallowing the request. The shell we have is
    // the honest answer: it boots, discovers it cannot reach the node, and says
    // so. It does NOT get handed stale rows to render.
    const cached = await cache.match('/index.html', MATCH);
    if (cached) return cached;
    throw new Error('sw: no cached shell');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const response = await fetch(request);
  // Opaque (no-cors) responses have status 0 and would poison the cache with a
  // body we can never read back, so only same-origin OKs are stored.
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ---- THE RULING. Do not add an `else` to this. -------------------------
  // No respondWith: the request leaves untouched and its failure is the app's
  // to render honestly.
  if (isApiRequest(url)) return;
  // -----------------------------------------------------------------------

  // The 1.0 UI is a separate bundle under this worker's scope. It leaves
  // untouched for the same reason the API does: this worker cannot speak for
  // something it did not build.
  if (isOtherUi(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(cacheFirst(request));
  }
});
