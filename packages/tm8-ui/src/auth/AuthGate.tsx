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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthFlow } from './AuthFlow';
import { useAuthSession } from './useAuthSession';
import { AuthActionsContext, AuthSessionContext, type AuthActions } from './gate-context';
import { fetchNodeClaim, readCachedNodeClaim, type NodeClaim } from './session';
import type { AuthFrameId, AuthIdentity } from './types';

/**
 * Which signed-out frame to render — THE NODE'S ANSWER, not this browser's
 * guess.
 *
 * THE DEFECT THIS REPLACED. The previous version discriminated on
 * `readKnownAccountsHere().length` plus `canUseLoopbackAutoOwner`. Neither is a
 * fact about the node, and the pair failed in both directions: a fresh browser
 * profile against a populated node opened on "create the first account" and
 * the signup 409'd, while a browser holding a stale entry for a re-provisioned
 * node was pinned to the sign-in card forever. Worse, off loopback it ALWAYS
 * chose sign-in — honest at the time, because signup there really would have
 * been refused, but a dead end: the node had no credential and no way to get
 * one. That dead end is the bug this whole lane exists to close.
 *
 * `claim` is null when the node has not answered yet OR could not be reached.
 * Both resolve to the sign-in card, and the distinction is deliberate: an
 * unreachable node must NOT be rendered as unclaimed, because offering a
 * ceremony that cannot succeed is exactly the false promise being removed.
 */
export function defaultSignedOutFrame(claim: NodeClaim | null): '1a' | '1d' {
  if (!claim) return '1d';
  return claim.claimed ? '1d' : '1a';
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
   * Which frame the flow opens on when signed out. By default the NODE decides
   * (`auth.claim.status`): an unclaimed node opens on `1a`, a claimed one on
   * `1d`. Supplying this overrides the node, which is what the review board
   * wants and what a live gate almost never does.
   */
  initialFrame?: AuthFrameId;
  /**
   * Reserved for the coordinator's mount: the frame to show when the host asks
   * the gate for an account surface while signed in (e.g. `1p`). Rendering it
   * is the host's call; the gate only carries the preference.
   */
  initialSignedInFrame?: AuthFrameId;
  /**
   * Context to render ABOVE the signed-out flow, when the host knows why this
   * viewer is being asked for credentials.
   *
   * Added for the join journey: somebody following an invite link hits this
   * gate because redeeming needs an identity, and without a word here they
   * meet a bare credential wall that has nothing to do with what they clicked.
   *
   * A SLOT, not an invite prop — the gate has no business knowing what an
   * invite is. It renders only in the signed-out branch, because once you are
   * in, the reason you were asked has stopped being news.
   */
  signedOutBanner?: ReactNode;
}

export function AuthGate({
  children,
  resolveIdentity,
  onSignedIn,
  initialFrame,
  signedOutBanner,
}: AuthGateProps) {
  const session = useAuthSession({ resolveIdentity });

  // Initialised SYNCHRONOUSLY from the per-server cache, for the same reason
  // the stored pass is (`useAuthSession`'s docblock): a first paint that shows
  // the wrong card and corrects itself is the flash this module already went
  // to some trouble to eliminate. The cache is never an authorization input —
  // the server refuses a claim on a claimed node — so a stale entry costs one
  // wrong paint and can grant nothing.
  const [nodeClaim, setNodeClaim] = useState<NodeClaim | null>(() => readCachedNodeClaim());
  // Distinct from `nodeClaim === null`, and the distinction is the whole point:
  // "not asked yet" and "asked, could not reach the node" must render
  // differently. See the render guard below.
  const [claimSettled, setClaimSettled] = useState(false);

  // Asked only while signed OUT. A signed-in viewer has already answered the
  // question this read exists to ask, and firing it anyway would put a
  // credential-free request on every authenticated page load.
  useEffect(() => {
    if (session.status === 'signed-in') return;
    let live = true;
    // Re-read the cache FIRST, synchronously within the effect. Claiming and
    // switching servers both change the answer, and the in-memory copy from
    // the initialiser is stale across either. Without this, signing out right
    // after a claim leaves the gate offering the claim card for a node it just
    // watched get claimed.
    const cached = readCachedNodeClaim();
    if (cached) setNodeClaim(cached);
    void fetchNodeClaim().then((claim) => {
      if (!live) return;
      // A null answer means the node could not be asked. Keep the last known
      // value rather than overwriting it with "unknown": an unreachable node
      // must not demote a claimed node into offering a claim ceremony.
      if (claim) setNodeClaim(claim);
      setClaimSettled(true);
    });
    return () => {
      live = false;
    };
  }, [session.status]);

  useEffect(() => {
    if (session.status === 'signed-in' && session.handle) onSignedIn?.(session.handle);
  }, [session.status, session.handle, onSignedIn]);

  const actions = useMemo<AuthActions>(
    () => ({
      createAccount: session.createAccount,
      claimNode: session.claimNode,
      nodeClaim,
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
      session.claimNode,
      nodeClaim,
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
  // A COLD BROWSER RENDERS NOTHING UNTIL THE NODE ANSWERS, and that beats the
  // alternative. The frame choice cannot be synchronous on a browser with no
  // cached answer, so the options are a brief blank or painting the sign-in
  // card and swapping it for the claim card a round trip later. The second is
  // the flash this module already went to some trouble to eliminate, and it is
  // worse here than a blank: it shows a viewer a credential prompt for an
  // account that does not exist, which is the exact false promise this lane
  // removes. A warm browser has the cached answer and never reaches this.
  //
  // `claimSettled` bounds it: an unreachable node settles with a null answer
  // and falls through to the sign-in card with the transport error, rather
  // than blanking forever.
  if (!initialFrame && !nodeClaim && !claimSettled) return null;

  // Which card to show is the NODE's answer (`auth.claim.status`), not this
  // browser's inference — see `defaultSignedOutFrame`.
  const frame = initialFrame ?? defaultSignedOutFrame(nodeClaim);

  return (
    <AuthActionsContext.Provider value={actions}>
      {signedOutBanner}
      <AuthFlow
        // KEYED ON THE DECISION. `initialFrame` seeds AuthFlow's internal
        // frame state and is read once at mount, so a claim answer that lands
        // after the flow is already on screen would be silently ignored — the
        // gate would compute `1d` and keep rendering `1a`. Measured: sign out
        // immediately after claiming and the claim card came back, for a node
        // that had just been claimed. Remounting on a changed decision is the
        // cheap fix; the flow holds no state worth preserving across one.
        key={frame}
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
