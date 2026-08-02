/**
 * THE SESSION STORE — what the gate is, stated once, in the place that
 * implements it.
 *
 * THE GATE IS SERVER-BACKED. The four operations the old localStorage gate
 * named as missing — `auth.signup`, `auth.login`, `auth.logout`,
 * `auth.session.get` — exist and are what this module calls (Identity v2
 * Stage 1, doc 4 §6). Creating an account creates it ON THE SERVER; signing
 * in exchanges the password for a `tm8s_…` bearer pass the server can revoke;
 * signing out revokes it. The password itself is never stored anywhere on
 * this browser — the server keeps a scrypt hash, this browser keeps the pass.
 *
 * THE PASS IS PER SERVER (`pass-store.ts`). This browser can point at the
 * local node or at any named server connection, and a pass minted by one is
 * meaningless at another. Every call this module makes is routed to the
 * ACTIVE server — the one the workspace is pointed at — through the same
 * relay the app itself uses.
 *
 * THE LOOPBACK PATH IS UNTOUCHED (D1, law T-L7). A request carrying no pass
 * resolves server-side to the loopback auto-owner, so a single machine with
 * no accounts behaves exactly as before: the CLI and the API need no
 * credential, and `auth.signup` from this gate is authorized as the node
 * owner. On a server where the caller is NOT the owner, signup is refused by
 * the node-admin gate (F1 — never open self-registration), and the refusal is
 * shown rather than translated into something softer.
 *
 * TWO RECORDS, NOT ONE — the pass and the known-accounts list are stored
 * separately, exactly as the account/session split worked before: sign-out
 * must clear the pass WITHOUT forgetting which accounts have signed in here,
 * or the gate could no longer offer "sign back in as @amber" after sign-out.
 */
import { CollabError } from '@tm8/contract';
import type {
  AuthLoginResult,
  AuthSessionGetResult,
  AuthSignupResult,
} from '@tm8/contract';
import { createHttpClient, type HttpClient } from '../data/real/http';
import { readActiveServerId, routeBaseUrlFor } from '../servers/server-key';
import {
  KNOWN_ACCOUNTS_KEY,
  PASSES_STORAGE_KEY,
  clearServerPass,
  noteKnownAccount,
  readKnownAccounts,
  readServerPass,
  resetPassStore,
  writeServerPass,
  type GateAccount,
  type KnownAccount,
  type ServerPass,
} from './pass-store';

export type { GateAccount, KnownAccount, ServerPass } from './pass-store';

/** LEGACY keys from the retired browser-local gate. Cleared on reset, never read. */
export const LEGACY_ACCOUNTS_STORAGE_KEY = 'tm8ui.auth.accounts';
export const LEGACY_ACCOUNT_STORAGE_KEY = 'tm8ui.auth.account';
export const LEGACY_SESSION_STORAGE_KEY = 'tm8ui.auth.session';

/** The reload check's answer: which handle this browser is signed in as, where. */
export interface StoredSession {
  serverId: string;
  handle: string;
  signedInAt: string;
}

/**
 * Every failure this module can produce, as data. The UI maps these to copy;
 * having them enumerated here is what stops a new failure mode reaching the
 * screen as an untranslated exception.
 */
export type AuthFailure =
  | { kind: 'password-too-short'; min: number }
  | { kind: 'name-required' }
  | { kind: 'account-exists'; handle: string }
  | { kind: 'bad-credentials' }
  | { kind: 'storage-blocked' }
  | { kind: 'server-refused'; message: string }
  | { kind: 'server-unreachable'; message: string };

export type AuthResult<T> = { ok: true; value: T } | { ok: false; failure: AuthFailure };

/** Matches the server's own floor: `AuthSignupInput.password` is `.min(8)`. */
export const MIN_PASSWORD_LENGTH = 8;

/* ── the wire ──────────────────────────────────────────────────────────── */

/**
 * A catalog-bound client against the ACTIVE server, built per call. Cheap by
 * design (`createHttpClient` holds no connection), and rebuilding it each
 * time is what makes a server switch or a fresh sign-in take effect without
 * any cache to invalidate. `getAuthToken` reads the pass store so the calls
 * that must carry the pass (logout, session.get) carry the current one.
 */
function clientForActiveServer(): { client: HttpClient; serverId: string } {
  const serverId = readActiveServerId();
  const client = createHttpClient({
    baseUrl: routeBaseUrlFor(serverId),
    fetch: (url, init) => globalThis.fetch(url, init),
    getAuthToken: () => readServerPass(serverId)?.token ?? null,
  });
  return { client, serverId };
}

function toGateAccount(account: {
  username: string;
  displayName: string | null;
  accountId: string;
  identityId: string;
  isOwner: boolean;
  isNodeAdmin: boolean;
}): GateAccount {
  return {
    handle: account.username,
    displayName: account.displayName ?? account.username,
    accountId: account.accountId,
    identityId: account.identityId,
    isOwner: account.isOwner,
    isNodeAdmin: account.isNodeAdmin,
  };
}

/**
 * Wire error → failure. `unauthenticated` on a login IS the credential
 * refusal, and the server deliberately says nothing about which half was
 * wrong (no account enumeration) — this mapping preserves that. Everything
 * else is surfaced as the server's own words: a refusal this gate cannot
 * explain is still one the viewer can act on, and paraphrasing it would
 * manufacture precision.
 */
function failureFrom(err: unknown, act: 'signup' | 'login' | 'logout'): AuthFailure {
  if (err instanceof CollabError) {
    if (err.code === 'unauthenticated' && act === 'login') return { kind: 'bad-credentials' };
    if (err.code === 'upstream_unavailable') {
      return { kind: 'server-unreachable', message: err.message };
    }
    return { kind: 'server-refused', message: err.message };
  }
  return {
    kind: 'server-unreachable',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** `amber Smith` → `ambersmith`. The oracle writes handles as `@amber`. */
export function handleFrom(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '');
}

/* ── reads ─────────────────────────────────────────────────────────────── */

/** The signed-in account on the active server, or null. Synchronous — the
 * no-flash first render depends on it. */
export function readActiveAccount(): GateAccount | null {
  return readServerPass(readActiveServerId())?.account ?? null;
}

/** Every account that has signed in on this browser, for the active server. */
export function readKnownAccountsHere(): KnownAccount[] {
  return readKnownAccounts(readActiveServerId());
}

/** Synchronous session read — the stored pass, as a fact about this browser.
 * `verifyStoredSession` is the server's word on whether it still stands. */
export function readStoredSession(): StoredSession | null {
  const serverId = readActiveServerId();
  const pass = readServerPass(serverId);
  return pass ? { serverId, handle: pass.account.handle, signedInAt: pass.signedInAt } : null;
}

export type SessionVerdict =
  | { state: 'valid'; account: GateAccount }
  | { state: 'invalid' }
  | { state: 'unreachable'; message: string }
  | { state: 'signed-out' };

/**
 * THE RELOAD CHECK — `auth.session.get` under the stored pass. A revoked or
 * expired pass comes back `unauthenticated`, and the stale record is cleared
 * so the gate closes NOW rather than on the first failed mutation. An
 * unreachable node is NOT a sign-out: the local pass and the node's
 * reachability are different facts, and conflating them would eject the
 * viewer every time the node hiccups.
 */
export async function verifyStoredSession(): Promise<SessionVerdict> {
  const { client, serverId } = clientForActiveServer();
  const pass = readServerPass(serverId);
  if (!pass) return { state: 'signed-out' };

  try {
    const result = await client.call<AuthSessionGetResult>('auth.session.get');
    const account = toGateAccount(result.account);
    // The server's copy wins — a display name edited elsewhere lands here on
    // the next reload rather than fossilising at what sign-in saw. But ONLY
    // onto the pass that was verified: the viewer may have signed out (or in
    // as someone else) while this call was in flight, and a stale write-back
    // here would resurrect a session the viewer already ended.
    const current = readServerPass(serverId);
    if (current && current.token === pass.token) {
      writeServerPass(serverId, { ...current, account });
    }
    return { state: 'valid', account };
  } catch (err) {
    if (err instanceof CollabError && err.code === 'unauthenticated') {
      // Same in-flight guard: only the verified pass may be cleared.
      const current = readServerPass(serverId);
      if (current && current.token === pass.token) {
        clearServerPass(serverId);
        notify();
      }
      return { state: 'invalid' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { state: 'unreachable', message };
  }
}

/* ── the three verbs ───────────────────────────────────────────────────── */

function storePass(
  serverId: string,
  login: AuthLoginResult,
): AuthResult<GateAccount> {
  const account = toGateAccount(login.account);
  const pass: ServerPass = {
    token: login.token,
    account,
    sessionId: login.session.sessionId,
    expiresAt: login.session.expiresAt,
    signedInAt: new Date().toISOString(),
  };
  // Write and CHECK. If storage refuses, the caller must learn now — a pass
  // this browser cannot keep would eject the viewer on their next reload with
  // no explanation. The minted session is revoked again so it does not linger
  // server-side as a session nothing holds.
  if (!writeServerPass(serverId, pass)) {
    const { client } = clientForActiveServer();
    void client
      .call('auth.logout', { body: { sessionId: login.session.sessionId } })
      .catch(() => {});
    return { ok: false, failure: { kind: 'storage-blocked' } };
  }
  noteKnownAccount(serverId, {
    handle: account.handle,
    displayName: account.displayName,
    lastSignedInAt: pass.signedInAt,
  });
  notify();
  return { ok: true, value: account };
}

/**
 * `auth.signup` + `auth.login`, in that order. Signup is node-admin gated in
 * SQL under the CALLER's claims: from a loopback machine the credential-free
 * request is the auto-owner and passes; anywhere else it is refused, and the
 * documented provisioning path (an admin runs `tm8 auth signup`, then the
 * person redeems a space invite) is the answer — see
 * `docs/identity/PROVISION-SECOND-ACCOUNT.md`.
 */
export async function createServerAccount(
  name: string,
  password: string,
): Promise<AuthResult<GateAccount>> {
  const handle = handleFrom(name);
  if (!handle) return { ok: false, failure: { kind: 'name-required' } };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, failure: { kind: 'password-too-short', min: MIN_PASSWORD_LENGTH } };
  }

  const { client, serverId } = clientForActiveServer();
  try {
    await client.call<AuthSignupResult>('auth.signup', {
      body: { username: handle, password, displayName: name.trim() },
    });
  } catch (err) {
    if (err instanceof CollabError && err.code === 'conflict') {
      return { ok: false, failure: { kind: 'account-exists', handle } };
    }
    return { ok: false, failure: failureFrom(err, 'signup') };
  }

  try {
    const login = await client.call<AuthLoginResult>('auth.login', {
      body: { username: handle, password, kind: 'browser' },
    });
    return storePass(serverId, login);
  } catch (err) {
    return { ok: false, failure: failureFrom(err, 'login') };
  }
}

/** `auth.login` — the password for a `tm8s_…` pass, stored per server. */
export async function signInToServer(
  handle: string,
  password: string,
): Promise<AuthResult<GateAccount>> {
  const username = handleFrom(handle);
  if (!username) return { ok: false, failure: { kind: 'name-required' } };

  const { client, serverId } = clientForActiveServer();
  try {
    const login = await client.call<AuthLoginResult>('auth.login', {
      body: { username, password, kind: 'browser' },
    });
    return storePass(serverId, login);
  } catch (err) {
    return { ok: false, failure: failureFrom(err, 'login') };
  }
}

/**
 * `auth.logout`, then the pass is gone either way. The revoke is
 * fire-and-forget ON PURPOSE: the viewer asked to leave, and holding the UI
 * hostage to a slow node would keep them visibly signed in after the act.
 * If the revoke is lost the pass still ages out server-side (`expiresAt`),
 * and the local copy is already destroyed — the asymmetry favours the viewer.
 *
 * Exported standalone as well as through the hook because the coordinator's
 * mount may call it from a menu outside the gate's React tree. The
 * subscription below keeps both paths in sync.
 */
export function signOutOfServer(): void {
  const { client, serverId } = clientForActiveServer();
  const pass = readServerPass(serverId);
  if (pass) {
    // Capture-free: the client's getAuthToken still reads the store, so the
    // revoke must be DISPATCHED before the pass is cleared.
    void client.call('auth.logout', { body: {} }).catch(() => {
      // The pass is gone locally regardless; a lost revoke expires server-side.
    });
    clearServerPass(serverId);
  }
  notify();
}

/* ── change notification ───────────────────────────────────────────────── */

/**
 * `signOut()` is callable from outside React (the exported verb), so the hook
 * cannot rely on its own setState to hear about it. This is the smallest
 * mechanism that keeps every mounted gate consistent with the store — and the
 * `storage` event is subscribed too, so signing out in one tab returns the
 * others to the gate rather than leaving a live app behind a dead pass.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeToSession(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Called by the hook on mount; idempotent. */
export function watchCrossTabSignOut(): () => void {
  if (typeof window === 'undefined' || !window.addEventListener) return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === PASSES_STORAGE_KEY || e.key === KNOWN_ACCOUNTS_KEY || e.key === null) notify();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

/** Test/dev affordance: forget every pass, plus the retired local-gate keys. */
export function resetLocalAuth(): void {
  resetPassStore();
  try {
    window.localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_ACCOUNTS_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_ACCOUNT_STORAGE_KEY);
  } catch {
    // Nothing to do; the records were unreachable to begin with.
  }
  notify();
}
