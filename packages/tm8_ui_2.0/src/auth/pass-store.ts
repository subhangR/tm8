/**
 * THE PER-SERVER PASS STORE — the human credential store the identity design
 * never specified (doc 13 §4.1 names the gap; delivery plan Slice 1 closes it).
 *
 * `auth.login` returns a `tm8s_…` bearer pass exactly once. This browser may
 * be signed into SEVERAL servers — the local node plus any number of named
 * `server_connections` — and a pass minted by one server is meaningless at
 * another, so the store is keyed by server id and NOTHING here is global. The
 * CLI deliberately keeps no store at all (it prints the token once and the
 * caller exports `TM8_AGENT_TOKEN`); this file is the browser's answer to the
 * same problem and shares no storage with the CLI's.
 *
 * WHAT IS STORED: the pass, and the account the server said it belongs to.
 * NEVER the password — the server holds a scrypt hash and this browser holds
 * nothing derivable from it. localStorage is readable by anyone with this
 * browser profile, which is the same trust boundary a session cookie would
 * occupy; the pass is revocable server-side (`auth.logout`), which the old
 * local-account record never was.
 *
 * TWO RECORDS PER SERVER, NOT ONE — the pass and the known-accounts list are
 * separate, and it matters exactly as it did for the localStorage gate this
 * store replaces: sign-out must clear the pass WITHOUT forgetting which
 * accounts have signed in here, because the sign-in frame's "who are you"
 * default and the first-run-vs-login choice are driven by that memory.
 *
 * THE KEY IS THE TARGET ORIGIN — the identity lead's programme-wide ruling
 * (2026-08-02), mirrored from the CLI's store (`packages/cli/src/credentials.ts`):
 * credentials key on `new URL(baseUrl).origin`, never on an alias, so two
 * names for one server share a credential and a rename orphans nothing. The
 * local node's origin is the page's own; a named connection's origin is
 * cached here by the server registry when it loads the connection list
 * (`noteServerOrigin`), because the gate must resolve it SYNCHRONOUSLY before
 * any list fetch has run. A named server whose origin has never been cached
 * falls back to a `name:` key — self-contained, and superseded the first time
 * the registry sees the real origin (the viewer signs in again; nothing
 * breaks, nothing leaks).
 */
import { LOCAL_SERVER_ID, readActiveServerId } from '../servers/server-key';

/** The account half of a stored pass — what the server said at issuance. */
export interface GateAccount {
  /** The server-side username. The oracle writes handles as `@amber`. */
  handle: string;
  /** Display name if the server has one, else the handle. */
  displayName: string;
  accountId: string;
  identityId: string;
  isOwner: boolean;
  isNodeAdmin: boolean;
}

export interface ServerPass {
  /** `tm8s_<sessionId>.<secret>` — shown by the server exactly once. */
  token: string;
  account: GateAccount;
  sessionId: string;
  expiresAt: string;
  signedInAt: string;
}

/** An account that has signed in on this browser before. No credential. */
export interface KnownAccount {
  handle: string;
  displayName: string;
  lastSignedInAt: string;
}

/** One record: `Record<originKey, ServerPass>`. */
export const PASSES_STORAGE_KEY = 'tm8ui.auth.passes.v1';
/** One record: `Record<originKey, KnownAccount[]>`. */
export const KNOWN_ACCOUNTS_KEY = 'tm8ui.auth.known.v1';
/** One record: `Record<serverId, origin>` — the registry's origin cache. */
export const SERVER_ORIGINS_KEY = 'tm8ui.auth.server-origins.v1';

function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    // Blocked storage OR a corrupt record. Both mean "nothing usable here",
    // and neither may take the gate down.
    return {};
  }
}

function writeRecord<T>(key: string, value: Record<string, T>): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Reported, never swallowed — a session we cannot keep is a session the
    // caller must learn about now, not on their next reload.
    return false;
  }
}

/**
 * Called by the server registry whenever it learns a connection's `baseUrl`.
 * Idempotent; garbage URLs are dropped rather than stored.
 */
export function noteServerOrigin(serverId: string, baseUrl: string): void {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return;
  }
  const all = readRecord<string>(SERVER_ORIGINS_KEY);
  if (all[serverId] === origin) return;
  writeRecord(SERVER_ORIGINS_KEY, { ...all, [serverId]: origin });
}

/** serverId → the credential key (the lead's ruling: the target ORIGIN). */
function passKeyFor(serverId: string): string {
  if (serverId === LOCAL_SERVER_ID) {
    try {
      return window.location.origin;
    } catch {
      return LOCAL_SERVER_ID;
    }
  }
  return readRecord<string>(SERVER_ORIGINS_KEY)[serverId] ?? `name:${serverId}`;
}

function isPass(p: unknown): p is ServerPass {
  const r = p as ServerPass | null;
  return (
    !!r &&
    typeof r.token === 'string' &&
    r.token.length > 0 &&
    !!r.account &&
    typeof r.account.handle === 'string'
  );
}

export function readServerPass(serverId: string): ServerPass | null {
  const pass = readRecord<ServerPass>(PASSES_STORAGE_KEY)[passKeyFor(serverId)];
  return isPass(pass) ? pass : null;
}

/** The pass for the server this browser is currently pointed at. */
export function readActivePass(): ServerPass | null {
  return readServerPass(readActiveServerId());
}

export function writeServerPass(serverId: string, pass: ServerPass): boolean {
  const all = readRecord<ServerPass>(PASSES_STORAGE_KEY);
  return writeRecord(PASSES_STORAGE_KEY, { ...all, [passKeyFor(serverId)]: pass });
}

export function clearServerPass(serverId: string): void {
  const key = passKeyFor(serverId);
  const all = readRecord<ServerPass>(PASSES_STORAGE_KEY);
  if (!(key in all)) return;
  const { [key]: _dropped, ...rest } = all;
  writeRecord(PASSES_STORAGE_KEY, rest);
}

/**
 * The bearer token for a server, or null. THE read the transport layer uses —
 * read per request, so sign-in and sign-out take effect without rebuilding
 * any client.
 */
export function authTokenFor(serverId: string): string | null {
  return readServerPass(serverId)?.token ?? null;
}

export function readKnownAccounts(serverId: string): KnownAccount[] {
  const list = readRecord<KnownAccount[]>(KNOWN_ACCOUNTS_KEY)[passKeyFor(serverId)];
  return Array.isArray(list)
    ? list.filter((a): a is KnownAccount => !!a && typeof a.handle === 'string')
    : [];
}

/** Upsert by handle — signing in again refreshes the entry, never duplicates it. */
export function noteKnownAccount(serverId: string, account: KnownAccount): void {
  const all = readRecord<KnownAccount[]>(KNOWN_ACCOUNTS_KEY);
  const list = readKnownAccounts(serverId).filter((a) => a.handle !== account.handle);
  writeRecord(KNOWN_ACCOUNTS_KEY, { ...all, [passKeyFor(serverId)]: [...list, account] });
}

/** Test/dev affordance: forget every pass and every known account. */
export function resetPassStore(): void {
  try {
    window.localStorage.removeItem(PASSES_STORAGE_KEY);
    window.localStorage.removeItem(KNOWN_ACCOUNTS_KEY);
    window.localStorage.removeItem(SERVER_ORIGINS_KEY);
  } catch {
    // Nothing to do; the records were unreachable to begin with.
  }
}
