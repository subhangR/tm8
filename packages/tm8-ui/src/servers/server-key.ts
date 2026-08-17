/**
 * THE SERVER KEY — a LEAF module, and it must stay one.
 *
 * Both the server registry (`server-registry.ts`) and the auth pass store
 * (`../auth/pass-store.ts`) need the same two facts: which server this browser
 * is currently pointed at, and how requests to a server are routed. Putting
 * them here — importing nothing but the platform — lets both sides depend on
 * the facts without depending on each other. The registry importing the pass
 * store (to authenticate its requests) while the pass store imported the
 * registry (for the active id) would be a cycle; this file is why it isn't.
 *
 * The id vocabulary: `'local'` is the node this page is served from; any other
 * id is a `server_connections.name`, reached through the local node's
 * same-origin relay so browser CORS never becomes transport (S4 refuses every
 * cross-origin preflight, deliberately).
 */

export const LOCAL_SERVER_ID = 'local';

/** Where the active-server selection persists. One key, both consumers. */
export const ACTIVE_SERVER_KEY = 'tm8-ui:active-server';

export function readActiveServerId(): string {
  try {
    return localStorage.getItem(ACTIVE_SERVER_KEY) || LOCAL_SERVER_ID;
  } catch {
    return LOCAL_SERVER_ID;
  }
}

/**
 * Whether an unauthenticated browser request can truthfully rely on the
 * server's loopback auto-owner arm. A named server always rides the relay;
 * even the page's local node is remote when the browser origin is not a
 * loopback hostname.
 */
export function canUseLoopbackAutoOwner(serverId: string, hostname: string): boolean {
  if (serverId !== LOCAL_SERVER_ID) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * The base every request to `serverId` is routed under. Empty for the local
 * node (relative, same-origin — the vite dev server proxies `/v2`); the relay
 * path for a named server.
 */
export function routeBaseUrlFor(serverId: string): string {
  return serverId === LOCAL_SERVER_ID
    ? ''
    : `/v2/server-connections/${encodeURIComponent(serverId)}/proxy`;
}

/**
 * A human label for the node the browser is pointed at RIGHT NOW, for the
 * gate's chrome — so a viewer claiming or signing in can see WHICH node they
 * are acting on. With more than one node in play, a chrome line that names the
 * wrong one at the moment of handing over ownership is a safety problem, not a
 * cosmetic one.
 *
 * The local node identifies by the browser's own origin — host AND scheme,
 * because the scheme is load-bearing: it says whether the password about to be
 * typed rides TLS. A named connection identifies by its registered name, which
 * is all the same-origin relay exposes to the browser.
 *
 * Deliberately NEVER a version or product string. The node does not tell the
 * browser those — `auth.claim.status` carries only `claimed`/`mode`/
 * `signupPath` — and a confident fabrication ("v0.9.2 · localhost:8787") at the
 * exact moment ownership is handed over is worse than a plain host. Absence is
 * the honest answer; there is no fake to fall back to.
 */
export function activeNodeLabel(): string {
  const serverId = readActiveServerId();
  if (serverId !== LOCAL_SERVER_ID) return serverId;
  try {
    return globalThis.location?.origin || LOCAL_SERVER_ID;
  } catch {
    return LOCAL_SERVER_ID;
  }
}
