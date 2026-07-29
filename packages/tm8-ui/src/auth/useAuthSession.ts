/**
 * useAuthSession — the gate's state, and the actions the frames dispatch.
 *
 * THERE IS NO `checking` STATUS, deliberately. The session is read from
 * storage in the state INITIALISER, so the first render is already correct and
 * the app never flashes on screen before the gate decides. A `checking` member
 * would be a state this hook can never be in — the same reason `AuthOutcome`
 * has no `signed-in` member. Unreachable union members are promises the type
 * makes on the code's behalf.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AuthSessionContext } from './gate-context';
import {
  createLocalAccount,
  readLocalAccount,
  readLocalAccounts,
  readLocalSession,
  signInLocal,
  signOutLocal,
  subscribeToSession,
  watchCrossTabSignOut,
  type AuthFailure,
  type LocalAccount,
} from './session';
import type { AuthIdentity } from './types';

export type AuthStatus = 'signed-in' | 'signed-out';

export interface AuthSessionState {
  status: AuthStatus;
  /** The signed-in account, or null. */
  account: LocalAccount | null;
  /** EVERY local account on this browser. Drives "create another" vs "first run". */
  accounts: LocalAccount[];
  /** The signed-in handle, or null. */
  handle: string | null;
  /**
   * What `identity.get` returned, once signed in and once a resolver was
   * supplied. Independent of `status` ON PURPOSE — see `identityError`.
   */
  serverIdentity: AuthIdentity | null;
  /**
   * Set when `identity.get` rejected. The viewer stays signed in: the local
   * session and the node's reachability are different facts, and conflating
   * them would eject people every time the node hiccups.
   */
  identityError: string | null;
  /** The last failed credential attempt, for the frames to render. */
  failure: AuthFailure | null;
  busy: boolean;

  createAccount(name: string, password: string): Promise<boolean>;
  signIn(handle: string, password: string): Promise<boolean>;
  signOut(): void;
  clearFailure(): void;
}

export interface UseAuthSessionOptions {
  /**
   * Usually `() => seam.identity()`. Called only while signed in — a gate that
   * probed the node before letting anyone in would make an unreachable node
   * indistinguishable from a wrong password.
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
 * the session — it suppresses the identity resolution so a host consumer
 * cannot double-fire `identity.get`, which would be a real duplicate request
 * against the node rather than a harmless extra render.
 */
function useOwnAuthSession(options: UseAuthSessionOptions, inert: boolean): AuthSessionState {
  const { resolveIdentity } = options;

  // Read synchronously. This is the whole no-flash mechanism.
  const [snapshot, setSnapshot] = useState(() => ({
    account: readLocalAccount(),
    accounts: readLocalAccounts(),
    session: readLocalSession(),
  }));
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverIdentity, setServerIdentity] = useState<AuthIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setSnapshot({
      account: readLocalAccount(),
      accounts: readLocalAccounts(),
      session: readLocalSession(),
    });
  }, []);

  // The store is mutable from outside React (the exported `signOut`), and from
  // outside this TAB (another tab signing out). Both funnel through here.
  useEffect(() => subscribeToSession(refresh), [refresh]);
  useEffect(() => watchCrossTabSignOut(), []);

  const status: AuthStatus = snapshot.session ? 'signed-in' : 'signed-out';

  // Resolve identity only while signed in, and drop the result if the session
  // ends before it lands — otherwise a slow node could populate the identity of
  // a viewer who has already signed out.
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
        const result = await createLocalAccount(name, password);
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
        const result = await signInLocal(handle, password);
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
    signOutLocal(); // notifies, which refreshes this hook and every other gate
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
      signIn,
      signOut,
      clearFailure,
    ],
  );
}
