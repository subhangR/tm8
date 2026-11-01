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
import { useTheme } from '../theme/useTheme';
import { parkConnectedToast, parkConnectionFailure, type McpCallback } from './oauth-callback';
import { OAUTH_MESSAGE_TYPE, type McpOAuthMessage } from './useConnect';
import './mcp.css';

/** What `mcp.oauth.callback` answers with: the new connection, plus §10.2's `return_to`. */
export interface McpCallbackResult {
  id: string;
  accountLabel?: string | null;
  returnTo?: string;
}
type CompleteCallback = (input: McpCallback['input']) => Promise<McpCallbackResult>;
// Auth boot can remount the callback. The provider code is single-use, so the
// same captured redirect must share its request across those mounts.
const completions = new WeakMap<McpCallback, Map<CompleteCallback | undefined, Promise<McpCallbackResult>>>();

export function McpOAuthCallback({ callback, complete, opener, view }: {
  callback: McpCallback;
  complete?: CompleteCallback;
  /** The window that opened this one, or null in the same-tab fallback. Injected for tests. */
  opener?: Window | null;
  view?: Window;
}) {
  const { theme } = useTheme();
  const [phase, setPhase] = useState<'pending' | 'done' | 'failed'>('pending');
  const [landing, setLanding] = useState<string | null>(null);
  const request = useRef<Promise<McpCallbackResult> | null>(null);
  const host = view ?? window;
  const parent = opener === undefined ? (host.opener as Window | null) : opener;
  // A page that opened itself is not an opener: posting to `window` would make
  // this page its own listener and the same-tab fallback would never run.
  const target = parent && parent !== host ? parent : null;
  const fallback = callback.spaceId ? `/#/s/${encodeURIComponent(callback.spaceId)}/settings/connectors` : '/';
  const http = useMemo(() => createHttpClient({ baseUrl: routeBaseUrlFor(callback.serverId), fetch: globalThis.fetch, getAuthToken: () => authTokenFor(callback.serverId) }), [callback.serverId]);

  const report = useCallback((payload: Omit<McpOAuthMessage, 'type'>, destination = fallback) => {
    if (!target) return false;
    try {
      // S14(a): one type, and `targetOrigin` is this page's own origin — the
      // message is undeliverable to any window that is not tm8's.
      target.postMessage({ type: OAUTH_MESSAGE_TYPE, ...payload }, host.location.origin);
    } catch { return false; }
    // The opener owns the outcome now. Closing late lets it be read if `close`
    // is refused, which leaves the page's own copy on screen instead.
    host.setTimeout(() => {
      try { host.close(); } catch { /* Recover in the current window below. */ }
      if (host.closed === false) host.location.replace(destination);
    }, 150);
    return true;
  }, [target, host, fallback]);

  useEffect(() => {
    let active = true;
    if (!callback.valid) {
      setPhase('failed');
      report({ status: 'failed', reason: 'OAuth state invalid or expired' });
      return;
    }
    let attempts = completions.get(callback);
    if (!attempts) { attempts = new Map(); completions.set(callback, attempts); }
    let pending = attempts.get(complete);
    if (!pending) {
      pending = complete ? complete(callback.input) : http.call<McpCallbackResult>('mcp.oauth.callback', { body: callback.input });
      attempts.set(complete, pending);
    }
    request.current = pending;
    void request.current.then(result => {
      if (!active) return;
      setPhase('done');
      const account = typeof result.accountLabel === 'string' && result.accountLabel ? result.accountLabel : null;
      const toast = account ? `Connected as ${account}.` : 'Account connected.';
      if (report({ status: 'connected', credentialId: result.id, ...(account ? { accountLabel: account } : {}) }, result.returnTo || fallback)) return;
      // Same tab: §10.2 lands the person back where they started, from the
      // server's `return_to`. It is a path on this origin by contract.
      parkConnectedToast(toast);
      setLanding(result.returnTo || fallback);
    }, (error: unknown) => {
      if (!active) return;
      setPhase('failed');
      if (report({ status: 'failed', reason: error instanceof Error ? error.message : '' })) return;
      if (callback.spaceId) { parkConnectionFailure(); setLanding(fallback); }
    });
    return () => { active = false; };
  }, [callback, complete, http, report, fallback]);

  useEffect(() => {
    if (!landing) return;
    host.location.replace(landing);
  }, [landing, host]);

  return <main className="cv2-root mcp-connect-handoff" data-theme={theme === 'dark' ? 'dark' : undefined}>
    <section className="mcp-connect-handoff__card" aria-labelledby="connect-heading">
      <span className="mcp-connect-handoff__brand">tm8</span>
      <span className="mcp-connect-handoff__indicator" data-phase={phase} aria-hidden="true">{phase === 'failed' ? '!' : phase === 'done' ? '✓' : ''}</span>
      <h1 id="connect-heading">{phase === 'failed' ? 'Let’s reconnect your account' : phase === 'done' ? 'Account connected' : 'Connecting your account'}</h1>
      {phase === 'pending' && <p role="status">Finishing sign-in. You’ll be back in Connect Apps shortly.</p>}
      {phase === 'done' && <p role="status">Taking you back to Connect Apps…</p>}
      {phase === 'failed' && <>
        <p role="alert">This sign-in couldn’t finish. It may have expired or been cancelled. Your existing connections are safe.</p>
        <a className="mcp-connect-handoff__action" href={fallback}>Open Connect Apps</a>
        <p className="mcp-connect-handoff__hint">Choose the app and connect again to start a fresh sign-in.</p>
      </>}
    </section>
  </main>;
}
