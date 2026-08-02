/**
 * AuthGate — the MANDATORY gate. Children render if and only if there is a
 * session; otherwise the T3 flow does, and nothing of the app is on screen.
 *
 * THE ACCEPTANCE LOOP this is built to, verbatim: reload → land on auth with
 * no app screen visible → create an account → the app renders → reload keeps
 * you in → sign-out returns to the gate. `gate.test.tsx` asserts each leg and
 * then the whole circuit in one go.
 *
 * WHAT KIND OF GATE THIS IS. Server-backed (Identity v2 Stage 1): the verbs
 * behind it are `auth.signup`, `auth.login`, `auth.logout`, and the reload
 * check is `auth.session.get` — see `session.ts`. Creating an account creates
 * it on the server; signing in mints a revocable `tm8s_…` pass stored PER
 * SERVER; signing out revokes it. The token-paste path stays refused because
 * no operation redeems a pasted token, not because auth is missing.
 *
 * THE EXECUTOR IS THE DISCRIMINATOR. Frames read their actions from context:
 * inside the gate the context carries real verbs and the buttons are live;
 * on the review board there is no context and the identical component renders
 * disabled-with-reason. The honesty law is therefore structural — a frame
 * cannot render an enabled verb it has no executor for, because the enabled
 * branch requires a value that only the gate provides.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { AuthFlow } from './AuthFlow';
import { useAuthSession } from './useAuthSession';
import { AuthActionsContext, AuthSessionContext, type AuthActions } from './gate-context';
import { readKnownAccountsHere } from './session';
import { LOCAL_SERVER_ID, readActiveServerId } from '../servers/server-key';
import type { AuthFrameId, AuthIdentity } from './types';

/**
 * Account creation without an existing bearer is authorized only through the
 * server's loopback auto-owner arm. A named server always rides the relay, and
 * a page served from a non-loopback host reaches even its "local" node as a
 * remote caller. Offering first-run signup in either case promises an action
 * the server must refuse.
 */
export function defaultSignedOutFrame(
  knownAccountCount: number,
  serverId: string,
  hostname: string,
): '1a' | '1d' {
  if (knownAccountCount > 0) return '1d';
  if (serverId !== LOCAL_SERVER_ID) return '1d';

  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const loopback = host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
  return loopback ? '1a' : '1d';
}

export interface AuthGateProps {
  children: ReactNode;
  /**
   * Usually `() => seam.identity()`. Called ONLY once signed in: probing the
   * node before letting anyone in would make an unreachable node
   * indistinguishable from a wrong password.
   */
  resolveIdentity?: () => Promise<AuthIdentity | null>;
  /** Fires on each transition into the signed-in state. */
  onSignedIn?: (handle: string) => void;
  /**
   * Which frame the flow opens on when signed out. By default only a loopback
   * local node with no known account opens on `1a`; remote and relayed nodes
   * open on `1d`, because unauthenticated signup there is not authorized.
   */
  initialFrame?: AuthFrameId;
  /**
   * Reserved for the coordinator's mount: the frame to show when the host asks
   * the gate for an account surface while signed in (e.g. `1p`). Rendering it
   * is the host's call; the gate only carries the preference.
   */
  initialSignedInFrame?: AuthFrameId;
}

export function AuthGate({
  children,
  resolveIdentity,
  onSignedIn,
  initialFrame,
}: AuthGateProps) {
  const session = useAuthSession({ resolveIdentity });

  useEffect(() => {
    if (session.status === 'signed-in' && session.handle) onSignedIn?.(session.handle);
  }, [session.status, session.handle, onSignedIn]);

  const actions = useMemo<AuthActions>(
    () => ({
      createAccount: session.createAccount,
      signIn: session.signIn,
      signOut: session.signOut,
      clearFailure: session.clearFailure,
      failure: session.failure,
      busy: session.busy,
      account: session.account,
      accounts: session.accounts,
    }),
    [
      session.createAccount,
      session.signIn,
      session.signOut,
      session.clearFailure,
      session.failure,
      session.busy,
      session.account,
      session.accounts,
    ],
  );

  // BOTH providers, in BOTH states. The first version supplied the actions
  // only while signed OUT — which is exactly where the frames need them — and
  // that made `useAuthActions()` return null everywhere inside the app. The
  // workspace account menu therefore rendered nothing at all, silently,
  // because its own "no gate ⇒ no account affordance" guard could not tell a
  // missing gate from a gate that withheld its actions. The actions are a
  // property of the gate, not of one of its two states.
  if (session.status === 'signed-in') {
    return (
      <AuthSessionContext.Provider value={session}>
        <AuthActionsContext.Provider value={actions}>{children}</AuthActionsContext.Provider>
      </AuthSessionContext.Provider>
    );
  }

  // Signed out. `children` is not rendered at all — not hidden, not mounted
  // behind an overlay. A gate that mounted the app underneath would run its
  // effects, open its sockets and fire its reads for a viewer who is not in.
  // A known account always means sign-in. With none known, first-account
  // creation is truthful only on the local loopback path; remote and relayed
  // callers start at sign-in and ask their operator for provisioning.
  const frame = initialFrame ?? defaultSignedOutFrame(
    readKnownAccountsHere().length,
    readActiveServerId(),
    globalThis.location?.hostname ?? '',
  );

  return (
    <AuthActionsContext.Provider value={actions}>
      <AuthFlow
        frame={undefined}
        initialFrame={frame}
        identity={session.serverIdentity}
        onDone={() => {
          // Unreachable in the gate: the real verbs sign you in by writing the
          // session, and this component re-renders off that. Kept as the
          // AuthFlow contract's required prop, and deliberately inert here.
        }}
      />
    </AuthActionsContext.Provider>
  );
}

/**
 * Sign out from outside the gate's React tree — the coordinator's menu mount.
 * Re-exported from `session.ts` so there is ONE implementation and both paths
 * notify the same subscribers.
 */
export { signOutOfServer as signOut } from './session';
