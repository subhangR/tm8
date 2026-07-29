/**
 * THE LOCAL SESSION STORE — what the gate is, stated once, in the place that
 * implements it.
 *
 * THIS IS NOT A SECURITY BOUNDARY, and every consumer of this file should read
 * that sentence before the code. The tm8 HTTP surface exposes exactly ONE
 * identity operation — `identity.get` (`GET /v2/identity`, v1). There is no
 * signup, no login, no logout, no session endpoint. The server has accounts
 * and auth_sessions internally; none of it is reachable from here. So an
 * account created through this gate exists in ONE browser's localStorage and
 * nowhere else, and anyone with access to this browser profile can read and
 * replace it.
 *
 * The gate exists anyway, because the alternative the order forbids is worse:
 * a login form that accepts a password and reports success against a server
 * that never saw it. This gate does exactly what it says, and every frame that
 * takes a credential says it on screen (`AuthLocalNote`).
 *
 * WHY THE PASSWORD IS STILL DERIVED PROPERLY (PBKDF2-SHA256, 210k iterations,
 * 16-byte random salt) even though this is not a security boundary: people
 * reuse passwords. A plaintext password sitting in localStorage is a hazard to
 * the person's OTHER accounts, which is not ours to create regardless of what
 * this gate protects. `crypto.subtle` was MEASURED as present under both the
 * test runner and a localhost browser (secure context) before this was
 * written; where it is genuinely absent, `createAccount` REFUSES with a reason
 * rather than falling back to something weaker and quiet.
 *
 * TWO RECORDS, NOT ONE — the account and the session are stored separately,
 * and it matters: sign-out must clear the session WITHOUT destroying the
 * account, and a surviving account must not imply a surviving session. A
 * single record would force sign-out either to delete the account or to not
 * work.
 */

/**
 * The account LIST. Viewer-local, same namespace as `tm8ui.theme`.
 *
 * It was a single record until the user asked to be able to create a second
 * account, which the single-record store refused with `account-exists`. That
 * refusal was right for a one-owner first run and wrong for what this gate is
 * actually used as — several people, or one person testing several identities,
 * on one browser. `ACCOUNT_STORAGE_KEY` below is the OLD key, still read once
 * so an account created before this change is not silently orphaned.
 */
export const ACCOUNTS_STORAGE_KEY = 'tm8ui.auth.accounts';
/** LEGACY single-record key. Read for migration, never written. */
export const ACCOUNT_STORAGE_KEY = 'tm8ui.auth.account';
/** The session record. Cleared by sign-out; the account outlives it. */
export const SESSION_STORAGE_KEY = 'tm8ui.auth.session';

/**
 * 210k is OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Recorded as a number
 * with a source rather than a round guess, and persisted ON the record so a
 * future raise can re-derive old accounts instead of locking them out.
 */
export const PBKDF2_ITERATIONS = 210_000;

export interface LocalAccount {
  /** Lower-cased; the handle the oracle writes as `@amber`. */
  handle: string;
  /** As typed, for display. The handle is derived from it. */
  displayName: string;
  /** base64. */
  salt: string;
  /** base64 of the PBKDF2 output. Never the password. */
  hash: string;
  iterations: number;
  algo: 'PBKDF2-SHA256';
  createdAt: string;
}

export interface LocalSession {
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
  | { kind: 'crypto-unavailable' };

export type AuthResult<T> = { ok: true; value: T } | { ok: false; failure: AuthFailure };

/** The oracle's own promise: "8+ characters · stored only on this server". */
export const MIN_PASSWORD_LENGTH = 8;

/* ── storage, defensively ──────────────────────────────────────────────── */

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Blocked storage OR a corrupt record. Both mean "nothing usable here",
    // and neither may take the gate down — a throw at this point would render
    // a white screen instead of a sign-in form.
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Reported, NEVER swallowed. Letting someone into an app we cannot keep
    // them in is worse than refusing: their next reload would eject them with
    // no explanation.
    return false;
  }
}

function isAccount(a: unknown): a is LocalAccount {
  // A record missing its derivation is not an account — treat it as absent
  // rather than letting `verify` compare against undefined.
  const r = a as LocalAccount | null;
  return !!r && typeof r.handle === 'string' && typeof r.hash === 'string' && !!r.salt;
}

/** Every local account on this browser, newest last. */
export function readLocalAccounts(): LocalAccount[] {
  const list = readJson<LocalAccount[]>(ACCOUNTS_STORAGE_KEY);
  if (Array.isArray(list)) return list.filter(isAccount);
  // MIGRATION, one way and idempotent: an account created before the list
  // existed is adopted rather than stranded. Not written back here — a read
  // that writes would make every render a storage mutation; `writeAccounts`
  // persists the list the next time one is added.
  const legacy = readJson<LocalAccount>(ACCOUNT_STORAGE_KEY);
  return isAccount(legacy) ? [legacy] : [];
}

export function findLocalAccount(handle: string): LocalAccount | null {
  const wanted = handleFrom(handle);
  return readLocalAccounts().find((a) => a.handle === wanted) ?? null;
}

/**
 * The account the current session belongs to, or null.
 *
 * NOTE the change in meaning: this used to be "the one account". With a list
 * it can only sensibly mean "the signed-in one", and callers wanting the set
 * want `readLocalAccounts()`.
 */
export function readLocalAccount(): LocalAccount | null {
  const s = readJson<LocalSession>(SESSION_STORAGE_KEY);
  if (!s || typeof s.handle !== 'string') return null;
  return findLocalAccount(s.handle);
}

export function readLocalSession(): LocalSession | null {
  const s = readJson<LocalSession>(SESSION_STORAGE_KEY);
  if (!s || typeof s.handle !== 'string') return null;
  // A session naming an account that no longer exists is stale, not valid.
  return findLocalAccount(s.handle) ? s : null;
}

/* ── derivation ────────────────────────────────────────────────────────── */

function subtle(): SubtleCrypto | null {
  const c = globalThis.crypto;
  return c && typeof c.subtle?.deriveBits === 'function' ? c.subtle : null;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string | null> {
  const s = subtle();
  if (!s) return null;
  const key = await s.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await s.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * Constant-time-ish comparison. Not meaningful against a local attacker who
 * already has the storage, and said so rather than implied: it is here because
 * comparing secrets with `===` is a habit worth not forming, not because it
 * defends this particular record.
 */
function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `amber Smith` → `ambersmith`. The oracle writes handles as `@amber`. */
export function handleFrom(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '');
}

/* ── the three verbs ───────────────────────────────────────────────────── */

export async function createLocalAccount(
  name: string,
  password: string,
): Promise<AuthResult<LocalAccount>> {
  const handle = handleFrom(name);
  if (!handle) return { ok: false, failure: { kind: 'name-required' } };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, failure: { kind: 'password-too-short', min: MIN_PASSWORD_LENGTH } };
  }
  // Only a HANDLE COLLISION is a conflict now. Having other accounts is not.
  const taken = findLocalAccount(handle);
  if (taken) return { ok: false, failure: { kind: 'account-exists', handle: taken.handle } };

  const salt = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) {
    return { ok: false, failure: { kind: 'crypto-unavailable' } };
  }
  globalThis.crypto.getRandomValues(salt);

  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  if (hash === null) return { ok: false, failure: { kind: 'crypto-unavailable' } };

  const account: LocalAccount = {
    handle,
    displayName: name.trim(),
    salt: toBase64(salt),
    hash,
    iterations: PBKDF2_ITERATIONS,
    algo: 'PBKDF2-SHA256',
    createdAt: new Date().toISOString(),
  };

  // Write the ACCOUNT LIST first and check it. If storage refuses, the caller
  // must learn now — not after we have shown them an app they cannot return
  // to. Appending rather than replacing is what keeps the first account alive.
  if (!writeJson(ACCOUNTS_STORAGE_KEY, [...readLocalAccounts(), account])) {
    return { ok: false, failure: { kind: 'storage-blocked' } };
  }
  if (!writeJson(SESSION_STORAGE_KEY, { handle, signedInAt: new Date().toISOString() })) {
    return { ok: false, failure: { kind: 'storage-blocked' } };
  }
  return { ok: true, value: account };
}

export async function signInLocal(
  handle: string,
  password: string,
): Promise<AuthResult<LocalAccount>> {
  const account = findLocalAccount(handle);

  // ONE failure for both halves. Distinguishing "no such account" from "wrong
  // password" tells anyone at this browser which handles exist, for free.
  // Deriving anyway on the miss keeps the two paths similar in cost.
  const salt = account ? fromBase64(account.salt) : new Uint8Array(16);
  const iterations = account?.iterations ?? PBKDF2_ITERATIONS;
  const attempt = await derive(password, salt, iterations);
  if (attempt === null) return { ok: false, failure: { kind: 'crypto-unavailable' } };

  if (!account || !equalStrings(attempt, account.hash)) {
    return { ok: false, failure: { kind: 'bad-credentials' } };
  }

  if (!writeJson(SESSION_STORAGE_KEY, { handle: account.handle, signedInAt: new Date().toISOString() })) {
    return { ok: false, failure: { kind: 'storage-blocked' } };
  }
  return { ok: true, value: account };
}

/**
 * Clears the SESSION only. The account survives, so the viewer can sign back
 * in — and so that sign-out is not a destructive act wearing a mild verb.
 *
 * Exported standalone as well as through the hook because the coordinator's
 * mount may want to call it from a menu that does not sit inside the gate's
 * React tree. The subscription below is what keeps both paths in sync.
 */
export function signOutLocal(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage that refuses to forget. The in-memory notification still fires,
    // so the UI returns to the gate; the stale record is re-validated against
    // the account on the next read.
  }
  notify();
}

/* ── change notification ───────────────────────────────────────────────── */

/**
 * `signOut()` is callable from outside React (the exported verb), so the hook
 * cannot rely on its own setState to hear about it. This is the smallest
 * mechanism that keeps every mounted gate consistent with the store — and the
 * `storage` event is subscribed too, so signing out in one tab returns the
 * others to the gate rather than leaving a live app behind a dead session.
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
    if (
      e.key === SESSION_STORAGE_KEY ||
      e.key === ACCOUNTS_STORAGE_KEY ||
      e.key === ACCOUNT_STORAGE_KEY ||
      e.key === null
    )
      notify();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

/** Test/dev affordance: forget everything this gate stored. */
export function resetLocalAuth(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    window.localStorage.removeItem(ACCOUNTS_STORAGE_KEY);
    window.localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  } catch {
    // Nothing to do; the records were unreachable to begin with.
  }
  notify();
}
