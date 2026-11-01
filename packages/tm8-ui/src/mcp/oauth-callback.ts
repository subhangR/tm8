import { readActiveServerId } from '../servers/server-key';
const PREFIX = 'tm8:mcp:oauth:';
/** One-shot handoff for the §10.2 same-tab toast, read and cleared by the Connectors page. */
const TOAST_KEY = 'tm8:mcp:connected';
const FAILURE_KEY = 'tm8:mcp:connection-failed';

export interface McpCallback {
  input: { state: string; code?: string; issuer?: string; error?: string };
  /**
   * Which tm8 NODE to complete against — not the MCP connector. It comes from
   * the local hint below, else the node this browser is pointed at. NEVER from
   * the callback URL (S14 item b): a `?serverId=` in the provider's redirect
   * would be a stranger choosing which node receives an authorization code.
   */
  serverId: string;
  /** Presentation only: where "Return to connectors" points if the server names no `return_to`. */
  spaceId: string;
  valid: boolean;
}

/**
 * Retain public correlation metadata only; provider tokens and codes are never persisted.
 *
 * It is a HINT, not authority (S4). It names which tm8 node the connect was
 * begun against, so a browser registered with more than one completes against
 * the right one; the authority for everything else — which Space, which
 * connector, which member, where to land — is the server's single-use
 * `internal.mcp_oauth_pending` row. A missing stash no longer fails the
 * callback, which is what made a connect begun from the CLI or another tab
 * always report "Authorization could not be completed".
 */
export function rememberMcpOAuth(authorizationUrl: string, spaceId: string, storage: Storage = sessionStorage) {
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (!state) throw new Error('Authorization did not return state.');
  storage.setItem(PREFIX + state, JSON.stringify({ serverId: readActiveServerId(), spaceId, expiresAt: Date.now() + 10 * 60_000 }));
}

/** Capture once before auth boot; remove authorization parameters from browser history immediately. */
export function captureMcpCallback(location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location, history: Pick<History, 'replaceState'> = window.history, storage?: Storage): McpCallback | null {
  if (location.pathname !== '/mcp/oauth/callback') return null;
  const query = new URLSearchParams(location.search);
  const state = query.get('state') ?? '';
  const code = query.get('code') ?? '';
  const error = query.get('error') ?? '';
  history.replaceState(null, '', '/mcp/oauth/callback');
  let binding: { serverId?: string; spaceId?: string; expiresAt?: number } = {};
  try {
    const stash = storage ?? window.sessionStorage;
    const raw = stash.getItem(PREFIX + state);
    stash.removeItem(PREFIX + state);
    // An expired hint is no hint: it names a node from a connect that has
    // already timed out, so it is dropped rather than followed.
    if (raw) { const parsed = JSON.parse(raw) as typeof binding; if ((parsed.expiresAt ?? 0) > Date.now()) binding = parsed; }
  } catch { /* Fail open to the active node, without echoing callback data. */ }
  return {
    input: { state, ...(code ? { code } : {}), ...(query.get('iss') ? { issuer: query.get('iss')! } : {}), ...(error ? { error } : {}) },
    serverId: typeof binding.serverId === 'string' && binding.serverId ? binding.serverId : readActiveServerId(),
    spaceId: typeof binding.spaceId === 'string' ? binding.spaceId : '',
    // The contract wants a state and exactly one of code/error. Anything else
    // is a malformed redirect that the server would only refuse.
    valid: !!state && (!!code !== !!error),
  };
}

/**
 * The §10.2 same-tab fallback's toast. Only ever the AUTHORED sentence the
 * callback page composed — never a token, a code, or anything from the
 * provider — and it is consumed on the first read, because a connect that
 * happened once should not be announced twice.
 */
export function parkConnectedToast(message: string, storage: Storage = sessionStorage) {
  try { storage.setItem(TOAST_KEY, message); } catch { /* A toast is not worth failing a connect over. */ }
}
export function takeConnectedToast(storage: Storage = sessionStorage): string | null {
  try { const value = storage.getItem(TOAST_KEY); storage.removeItem(TOAST_KEY); return value; } catch { return null; }
}
export function parkConnectionFailure(storage: Storage = sessionStorage) {
  try { storage.setItem(FAILURE_KEY, '1'); } catch { /* Recovery still works without a notice. */ }
}
export function takeConnectionFailure(storage: Storage = sessionStorage): string | null {
  try {
    const failed = storage.getItem(FAILURE_KEY); storage.removeItem(FAILURE_KEY);
    return failed ? 'Sign-in couldn’t finish. Choose the app and connect again.' : null;
  } catch { return null; }
}
