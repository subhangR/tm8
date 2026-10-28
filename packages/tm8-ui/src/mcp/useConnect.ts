/**
 * §10.2's CONNECT FLOW: the popup, the `postMessage` back, every fallback.
 *
 * Before this, Connect was a same-tab link: `startOAuth` returned an
 * authorization URL and the drawer rendered "Continue authorization", so
 * signing in to Gmail navigated the whole app away, and coming back landed on
 * whatever route the callback page linked to. The popup keeps the person where
 * they were — which is the point of §10.2 step 6, where the same flow starts
 * from the chat sheet or a launch dialog and the toggle that started it turns
 * on when it finishes.
 *
 * THE TRUST BOUNDARY (S14 item a). The popup navigates to the PROVIDER, so the
 * opener's `message` listener is reachable from any window the provider's pages
 * can get a handle on. `acceptOAuthMessage` is therefore the whole of what this
 * module will believe: the event's origin must be tm8's own origin, its source
 * must be the exact window this module opened, and its type must be
 * `tm8.mcp.oauth`. Anything else is dropped without a trace. It is a pure
 * function so that guard can be read — and asserted — without a DOM.
 *
 * THE MESSAGE IS NOT THE AUTHORITY (S14 item b, S4). A `connected` message
 * carries no credential and no token: the connection already exists, created by
 * the server from its own single-use `internal.mcp_oauth_pending` row, and all
 * the opener does with the message is refresh the list and say so. A forged
 * message can make the page re-read a list the reader is already entitled to;
 * it cannot connect an account.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { McpCredentialScope } from '@tm8/contract';
import { connectFailure, type ConnectFailure } from './errors';
import type { McpPort, McpServer } from './port';

/** The one message type this flow sends, and the only one it accepts. */
export const OAUTH_MESSAGE_TYPE = 'tm8.mcp.oauth';

export interface McpOAuthMessage {
  type: typeof OAUTH_MESSAGE_TYPE;
  status: 'connected' | 'failed';
  /** Which connection the server created. Correlation only; it is not a capability. */
  credentialId?: string;
  /** The provider's own name for the account, for §10.2's "Gmail connected as …" line. */
  accountLabel?: string;
  /** The server's refusal, for `connectFailure` to WORD. Never rendered as it stands. */
  reason?: string;
}

/**
 * S14 item (a). Three checks, and a message that fails any of them is not a
 * message: a different origin (the provider, or anything embedded in it), a
 * different window (another tab, an iframe, an extension), or a different type.
 */
export function acceptOAuthMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  popup: Window | null,
  origin: string,
): McpOAuthMessage | null {
  // No window of ours open means nothing may be accepted — without this, a
  // `source` of null would match a `popup` of null.
  if (!popup) return null;
  if (event.origin !== origin) return null;
  if (event.source !== popup) return null;
  if (typeof event.data !== 'object' || event.data === null) return null;
  const data = event.data as Record<string, unknown>;
  if (data.type !== OAUTH_MESSAGE_TYPE) return null;
  if (data.status !== 'connected' && data.status !== 'failed') return null;
  return {
    type: OAUTH_MESSAGE_TYPE,
    status: data.status,
    ...(typeof data.credentialId === 'string' ? { credentialId: data.credentialId } : {}),
    ...(typeof data.accountLabel === 'string' ? { accountLabel: data.accountLabel } : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
  };
}

/** §10.2: 520×700, centred on the window the person is looking at. */
export function popupFeatures(view: Pick<Window, 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'>): string {
  const width = 520;
  const height = 700;
  const left = Math.max(0, Math.round(view.screenX + (view.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(view.screenY + (view.outerHeight - height) / 3));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * Where a SAME-TAB sign-in has to land (§10.2's popup-blocked row). It goes to
 * the server, which keeps it on the pending row (`return_to`), so it survives
 * the provider redirect — the thing the old `sessionStorage` state could not do
 * and the reason a connect begun in another tab always failed (S4).
 *
 * The contract's `SameOriginPath` accepts a PATH on this origin and nothing
 * else, so a value that is not one is dropped rather than sent: a sign-in that
 * lands on the default route is a smaller fault than a refused `begin`.
 */
export function returnToPath(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string | undefined {
  const path = `${location.pathname}${location.search}${location.hash}`;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return undefined;
  if (path.length > 2048 || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  return path;
}

export type ConnectPhase =
  /** Nothing in flight. The row shows its ordinary §10.0 status. */
  | { kind: 'idle' }
  /** `mcp.oauth.begin` is in flight; no window is open yet. */
  | { kind: 'starting'; provider: string }
  /** The popup is open. §10.2: "Waiting for Google…", with [Cancel]. */
  | { kind: 'waiting'; provider: string }
  /** `window.open` returned null. §10.2: a same-tab link, with `returnTo` already stored. */
  | { kind: 'blocked'; provider: string; url: string }
  | { kind: 'failed'; provider: string; failure: ConnectFailure };

export interface ConnectController {
  phase: ConnectPhase;
  /** Runs §10.2 steps 1–4 for one connector. It never throws: failures land in `phase`. */
  start(server: McpServer, input: { label: string; scope: McpCredentialScope }): Promise<void>;
  /** [Cancel] while waiting: shut the popup and put the row back. */
  cancel(): void;
  /** Dismiss a `blocked` or `failed` phase without starting anything. */
  reset(): void;
}

export interface ConnectOptions {
  port: McpPort;
  /** Whether this viewer is a Space admin: it decides which half of §10.2's copy they get. */
  admin: boolean;
  /** Called once the server has made the connection. The caller refreshes and says so. */
  onConnected(result: { provider: string; credentialId?: string; accountLabel?: string }): void;
  /** Injected for tests; defaults to the real window. */
  view?: Window;
}

export function useConnect({ port, admin, onConnected, view }: ConnectOptions): ConnectController {
  const [phase, setPhase] = useState<ConnectPhase>({ kind: 'idle' });
  const popup = useRef<Window | null>(null);
  const provider = useRef('');
  // Read through refs so the `waiting` listener is installed ONCE per popup: a
  // caller that passes a fresh `onConnected` every render would otherwise tear the
  // listener down and rebuild it, restarting the closed-popup poll each time.
  const connected = useRef(onConnected);
  const isAdmin = useRef(admin);
  connected.current = onConnected;
  isAdmin.current = admin;
  const host = view ?? window;

  const shut = useCallback(() => {
    const child = popup.current;
    popup.current = null;
    try { child?.close(); } catch { /* Already gone, or never ours to close. */ }
  }, []);

  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const child = popup.current;
    if (!child) return;
    const name = provider.current;
    let timer = 0;

    function stop() {
      host.removeEventListener('message', receive);
      host.clearInterval(timer);
    }
    function receive(event: MessageEvent) {
      const message = acceptOAuthMessage(event, child, host.location.origin);
      // S14(a): a message from another origin, another window or another type
      // is not answered and not logged. It simply never happened.
      if (!message) return;
      stop();
      popup.current = null;
      try { child?.close(); } catch { /* The callback page usually closed itself. */ }
      if (message.status === 'connected') {
        setPhase({ kind: 'idle' });
        connected.current({
          provider: name,
          ...(message.credentialId ? { credentialId: message.credentialId } : {}),
          ...(message.accountLabel ? { accountLabel: message.accountLabel } : {}),
        });
        return;
      }
      setPhase({ kind: 'failed', provider: name, failure: connectFailure(new Error(message.reason ?? ''), { name, admin: isAdmin.current }) });
    }

    host.addEventListener('message', receive);
    // §10.2: the person closing the popup resets the row to [Connect] with NO
    // error toast — abandoning a sign-in is not a failure. `closed` is the only
    // signal a cross-origin popup gives, so it is polled.
    timer = host.setInterval(() => {
      if (!child.closed) return;
      stop();
      popup.current = null;
      setPhase({ kind: 'idle' });
    }, 500);
    return stop;
    // `provider` and the callbacks are refs on purpose (see above), so the only
    // thing that re-installs this is a new popup.
  }, [phase.kind, host]);

  // A drawer that closes mid-connect must not leave a window nobody owns.
  useEffect(() => shut, [shut]);

  const start = useCallback(async (server: McpServer, input: { label: string; scope: McpCredentialScope }) => {
    const name = server.title;
    provider.current = name;
    shut();
    setPhase({ kind: 'starting', provider: name });
    const fail = (error: unknown) => setPhase({ kind: 'failed', provider: name, failure: connectFailure(error, { name, admin: isAdmin.current }) });

    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await port.startOAuth(server.id, input.label, input.scope, returnToPath(host.location)));
    } catch (error) { fail(error); return; }

    // The address came back from tm8, but it was BUILT from provider metadata,
    // so it is parsed and its scheme checked before a window is pointed at it.
    let url: URL;
    try { url = new URL(authorizationUrl); } catch {
      setPhase({ kind: 'failed', provider: name, failure: { message: `${name} returned an address tm8 will not open.`, retry: false } });
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      setPhase({ kind: 'failed', provider: name, failure: { message: `${name} returned an address tm8 will not open.`, retry: false } });
      return;
    }

    let child: Window | null = null;
    // `window.open` is allowed to throw as well as to return null, and both
    // mean the same thing to the person: no window appeared.
    try { child = host.open(url.href, 'tm8-mcp-oauth', popupFeatures(host)); } catch { child = null; }
    if (!child) {
      // §10.2's popup-blocked row. `returnTo` is already on the pending row, so
      // the same-tab sign-in comes back to this screen by itself.
      setPhase({ kind: 'blocked', provider: name, url: url.href });
      return;
    }
    popup.current = child;
    try { child.focus(); } catch { /* Focus is a courtesy, not a requirement. */ }
    setPhase({ kind: 'waiting', provider: name });
  }, [port, host, shut]);

  const cancel = useCallback(() => { shut(); setPhase({ kind: 'idle' }); }, [shut]);
  const reset = useCallback(() => setPhase({ kind: 'idle' }), []);

  return { phase, start, cancel, reset };
}
