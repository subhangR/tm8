/**
 * THE OAUTH CALLBACK PAGE — the `<origin>/mcp/oauth/callback` the provider
 * redirects to, rendered above the app shell by `App.tsx`.
 *
 * It runs in one of two windows and has to behave correctly in both (§10.2):
 *
 *  - **In the popup** this page opened for a sign-in. It completes the connect,
 *    posts one message back to the opener and closes itself. The opener then
 *    refreshes the row and says "connected as …", so the person never leaves
 *    the screen they started on.
 *  - **In the same tab**, when the browser blocked the popup. There is nobody
 *    to message, so it navigates to the `return_to` the SERVER kept on the
 *    pending row, with the toast parked for the page it lands on.
 *
 * S14 item (a): the message goes out with `targetOrigin` = this page's own
 * origin, so it is deliverable only to a tm8 window. S14 item (b): nothing
 * about which connector, which Space or where to land is read out of the
 * callback URL — the server's single-use pending row decides all three, and
 * this page learns `returnTo` from the RESPONSE (S4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authTokenFor } from '../auth/pass-store';
import { routeBaseUrlFor } from '../servers/server-key';
import { createHttpClient } from '../data/real/http';
import { parkConnectedToast, type McpCallback } from './oauth-callback';
import { OAUTH_MESSAGE_TYPE, type McpOAuthMessage } from './useConnect';
import './mcp.css';

/** What `mcp.oauth.callback` answers with: the new connection, plus §10.2's `return_to`. */
export interface McpCallbackResult {
  id: string;
  accountLabel?: string | null;
  returnTo?: string;
}

export function McpOAuthCallback({ callback, complete, opener, view }: {
  callback: McpCallback;
  complete?: (input: McpCallback['input']) => Promise<McpCallbackResult>;
  /** The window that opened this one, or null in the same-tab fallback. Injected for tests. */
  opener?: Window | null;
  view?: Window;
}) {
  const [phase, setPhase] = useState<'pending' | 'done' | 'failed'>('pending');
  const [landing, setLanding] = useState<string | null>(null);
  const request = useRef<Promise<McpCallbackResult> | null>(null);
  const host = view ?? window;
  const parent = opener === undefined ? (host.opener as Window | null) : opener;
  // A page that opened itself is not an opener: posting to `window` would make
  // this page its own listener and the same-tab fallback would never run.
  const target = parent && parent !== host ? parent : null;
  const http = useMemo(() => createHttpClient({ baseUrl: routeBaseUrlFor(callback.serverId), fetch: globalThis.fetch, getAuthToken: () => authTokenFor(callback.serverId) }), [callback.serverId]);

  const report = useCallback((payload: Omit<McpOAuthMessage, 'type'>) => {
    if (!target) return false;
    try {
      // S14(a): one type, and `targetOrigin` is this page's own origin — the
      // message is undeliverable to any window that is not tm8's.
      target.postMessage({ type: OAUTH_MESSAGE_TYPE, ...payload }, host.location.origin);
    } catch { return false; }
    // The opener owns the outcome now. Closing late lets it be read if `close`
    // is refused, which leaves the page's own copy on screen instead.
    host.setTimeout(() => { try { host.close(); } catch { /* Not a script-opened window. */ } }, 150);
    return true;
  }, [target, host]);

  useEffect(() => {
    let active = true;
    if (!callback.valid) {
      setPhase('failed');
      report({ status: 'failed', reason: 'OAuth state invalid or expired' });
      return;
    }
    request.current ??= complete ? complete(callback.input) : http.call<McpCallbackResult>('mcp.oauth.callback', { body: callback.input });
    void request.current.then(result => {
      if (!active) return;
      setPhase('done');
      const account = typeof result.accountLabel === 'string' && result.accountLabel ? result.accountLabel : null;
      const toast = account ? `Connected as ${account}.` : 'Connector connected.';
      if (report({ status: 'connected', credentialId: result.id, ...(account ? { accountLabel: account } : {}) })) return;
      // Same tab: §10.2 lands the person back where they started, from the
      // server's `return_to`. It is a path on this origin by contract.
      if (result.returnTo) { parkConnectedToast(toast); setLanding(result.returnTo); }
    }, (error: unknown) => {
      if (!active) return;
      setPhase('failed');
      report({ status: 'failed', reason: error instanceof Error ? error.message : '' });
    });
    return () => { active = false; };
  }, [callback, complete, http, report]);

  useEffect(() => {
    if (!landing) return;
    host.location.replace(landing);
  }, [landing, host]);

  return <main className="mcp-settings"><h1>Connect account</h1>
    {phase === 'pending' && <p role="status">Completing authorization&hellip;</p>}
    {phase === 'done' && <p role="status">Your account is connected. You can close this window.</p>}
    {phase === 'failed' && <p role="alert">Authorization could not be completed. It may have expired, been declined, or been started on another node. Return to connectors and start a new connection.</p>}
    {phase !== 'pending' && !target && !landing && <a href={callback.spaceId ? `/#/s/${encodeURIComponent(callback.spaceId)}/settings/connectors` : '/'}>Return to connectors</a>}
  </main>;
}
