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
 * The base every request to `serverId` is routed under. Empty for the local
 * node (relative, same-origin — the vite dev server proxies `/v2`); the relay
 * path for a named server.
 */
export function routeBaseUrlFor(serverId: string): string {
  return serverId === LOCAL_SERVER_ID
    ? ''
    : `/v2/server-connections/${encodeURIComponent(serverId)}/proxy`;
}
