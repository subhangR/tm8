/**
 * useAuthSession — the gate's state, and the actions the frames dispatch.
 *
 * THERE IS NO `checking` STATUS, deliberately. The stored pass is read in the
 * state INITIALISER, so the first render is already correct and the app never
 * flashes on screen before the gate decides. The pass is this browser's fact;
 * the SERVER's word arrives asynchronously through `verifyStoredSession()`
 * (`auth.session.get`), and the two disagree in exactly two ways, both
 * handled: a revoked/expired pass flips the gate closed as soon as the server
 * says so, and an unreachable node leaves the viewer signed in with the
 * failure surfaced — the local pass and the node's reachability are different
 * facts, and conflating them would eject people every time the node hiccups.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AuthSessionContext } from './gate-context';
import {
  claimNodeOnServer,
  createServerAccount,
  readActiveAccount,
  readKnownAccountsHere,
  readStoredSession,
  signInToServer,
  signOutOfServer,
  subscribeToSession,
  verifyStoredSession,
  watchCrossTabSignOut,
  type AuthFailure,
  type GateAccount,
  type KnownAccount,
} from './session';
import type { AuthIdentity } from './types';

export type AuthStatus = 'signed-in' | 'signed-out';

export interface AuthSessionState {
  status: AuthStatus;
  /** The signed-in account on the active server, or null. */
  account: GateAccount | null;
  /** EVERY account that has signed in on this browser, for the active server.
   * Drives "create another" vs "first run". */
  accounts: KnownAccount[];
  /** The signed-in handle, or null. */
  handle: string | null;
  /**
   * What the server said about this viewer, once signed in — from
   * `auth.session.get`, or from the host's `resolveIdentity` when supplied.
   * Independent of `status` ON PURPOSE — see `identityError`.
   */
  serverIdentity: AuthIdentity | null;
  /**
   * Set when the server could not be asked (or refused to answer) about the
   * session or identity. The viewer stays signed in: an unreachable node and
   * a revoked pass are different facts, and only the second ends a session.
   */
  identityError: string | null;
  /** The last failed credential attempt, for the frames to render. */
  failure: AuthFailure | null;
  busy: boolean;

  createAccount(name: string, password: string): Promise<boolean>;
  /**
   * `auth.claim` — first-run only. Separate from `createAccount` because it is
   * a different act with a different authorization: the claim token, not a
   * node-admin session. Collapsing them would make the 1a card unable to tell
   * a viewer which one it is actually performing.
   */
  claimNode(token: string, name: string, password: string): Promise<boolean>;
  signIn(handle: string, password: string): Promise<boolean>;
  signOut(): void;
  clearFailure(): void;
}

export interface UseAuthSessionOptions {
  /**
   * Usually `() => seam.identity()`. Called only while signed in — a gate that
   * probed the node before letting anyone in would make an unreachable node
   * indistinguishable from a wrong password. When omitted, the identity shown
   * is the one `auth.session.get` returns.
   */
  resolveIdentity?: () => Promise<AuthIdentity | null>;
}

/**
 * THE GATE'S SESSION IF THERE IS ONE, otherwise a standalone session.
 *
 * WHY THE INDIRECTION EXISTS — this was a real footgun and it caught its own
 * author. Called inside `<AuthGate>`, the earlier version built a SECOND,
 * independent session: its own state, its own identity resolution, its own
 * view of storage. Everything type-checked and rendered; the consumer just
 * never saw the gate's identity, because it was reading a different instance
 * of the same hook. That is the "four sessions rendered as twelve" shape — a
 * chain where every link is individually correct and the feature is dead —
 * and it took a test failure to see it.
 *
 * So the context WINS when present. The standalone instance below is still
 * constructed (hook order must not vary) but runs inert, doing no work and
 * firing no effects. Hosts can call this anywhere and get the right answer.
 */
export function useAuthSession(options: UseAuthSessionOptions = {}): AuthSessionState {
  const shared = useContext(AuthSessionContext);
  const own = useOwnAuthSession(options, shared !== null);
  return shared ?? own;
}

/**
 * The actual implementation. `inert` is set when a gate above us already owns
 * the session — it suppresses the identity resolution AND the session verify,
 * so a host consumer cannot double-fire either against the node.
 */
function useOwnAuthSession(options: UseAuthSessionOptions, inert: boolean): AuthSessionState {
  const { resolveIdentity } = options;

  // Read synchronously. This is the whole no-flash mechanism.
  const [snapshot, setSnapshot] = useState(() => ({
    account: readActiveAccount(),
    accounts: readKnownAccountsHere(),
    session: readStoredSession(),
  }));
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverIdentity, setServerIdentity] = useState<AuthIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setSnapshot({
      account: readActiveAccount(),
      accounts: readKnownAccountsHere(),
      session: readStoredSession(),
    });
  }, []);

  // The store is mutable from outside React (the exported `signOut`), and from
  // outside this TAB (another tab signing out). Both funnel through here.
  useEffect(() => subscribeToSession(refresh), [refresh]);
  useEffect(() => watchCrossTabSignOut(), []);

  const status: AuthStatus = snapshot.session ? 'signed-in' : 'signed-out';

  /**
   * THE RELOAD CHECK — the server's word on the stored pass. An 'invalid'
   * verdict has already cleared the store and notified, so `refresh` (via the
   * subscription) flips the gate closed; nothing more to do here. Keyed on
   * the handle so a sign-in as someone else re-verifies as them.
   */
  useEffect(() => {
    if (inert || status !== 'signed-in') return;
    let live = true;
    void verifyStoredSession().then((verdict) => {
      if (!live) return;
      if (verdict.state === 'valid') {
        refresh(); // the server's copy of the account may have moved
        if (!resolveIdentity) {
          setServerIdentity({
            username: verdict.account.handle,
            displayName: verdict.account.displayName,
            avatar: null,
            isOwner: verdict.account.isOwner,
          });
        }
      } else if (verdict.state === 'unreachable') {
        setIdentityError(verdict.message);
      }
    });
    return () => {
      live = false;
    };
  }, [inert, status, snapshot.session?.handle, resolveIdentity, refresh]);

  // Resolve the host's richer identity only while signed in, and drop the
  // result if the session ends before it lands — otherwise a slow node could
  // populate the identity of a viewer who has already signed out.
  useEffect(() => {
    if (inert || status !== 'signed-in' || !resolveIdentity) return;
    let live = true;
    setIdentityError(null);
    resolveIdentity().then(
      (id) => {
        if (live) setServerIdentity(id ?? null);
      },
      (err: unknown) => {
        if (live) setIdentityError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [inert, status, resolveIdentity]);

  const createAccount = useCallback(
    async (name: string, password: string) => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await createServerAccount(name, password);
        if (!result.ok) {
          setFailure(result.failure);
          return false;
        }
        refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const claimNode = useCallback(
    async (token: string, name: string, password: string) => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await claimNodeOnServer(token, name, password);
        if (!result.ok) {
          setFailure(result.failure);
          return false;
        }
        refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const signIn = useCallback(
    async (handle: string, password: string) => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await signInToServer(handle, password);
        if (!result.ok) {
          setFailure(result.failure);
          return false;
        }
        refresh();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const signOut = useCallback(() => {
    setServerIdentity(null);
    setIdentityError(null);
    setFailure(null);
    signOutOfServer(); // notifies, which refreshes this hook and every other gate
  }, []);

  const clearFailure = useCallback(() => setFailure(null), []);

  return useMemo(
    () => ({
      status,
      account: snapshot.account,
      accounts: snapshot.accounts,
      handle: snapshot.session?.handle ?? null,
      serverIdentity,
      identityError,
      failure,
      busy,
      createAccount,
      claimNode,
      signIn,
      signOut,
      clearFailure,
    }),
    [
      status,
      snapshot,
      serverIdentity,
      identityError,
      failure,
      busy,
      createAccount,
      claimNode,
      signIn,
      signOut,
      clearFailure,
    ],
  );
}
