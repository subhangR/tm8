/**
 * The per-server credential store — Identity v2, doc 13 §4.1 ("credential per
 * remote", the git-remotes model). This is the piece twelve design documents
 * chose and never located: where the CLI keeps a human's `tm8s_…` pass, per
 * server.
 *
 * KEYED BY ORIGIN, never by connection alias. The alias is Server A's naming
 * of a route; the origin (`scheme://host[:port]`) is the security boundary a
 * credential belongs to. A credential for server A is never presented to
 * server B: `server-target.ts` drops A's token on retarget, and the dispatch
 * lookup refills from THIS store under B's own origin — or leaves the request
 * unauthenticated when B has no stored credential.
 *
 * TWO BACKENDS:
 *  - macOS: the login keychain via `security(1)`. The secret travels through
 *    `security -i` on stdin, never through argv, so it cannot surface in `ps`
 *    output or shell history.
 *  - everywhere else, and whenever `TM8_CREDENTIALS_PATH` is set: a `0600`
 *    JSON file (default `~/.config/tm8/credentials.json`), written atomically
 *    via rename, in a `0700` directory.
 *
 * TWO RULES BIND EVERY CALLER:
 *  - AGENTS NEVER TOUCH THE STORE (doc 13 §4.2–4.3). An agent's credential is
 *    minted at spawn and injected as `TM8_AGENT_TOKEN`; it dies with the
 *    session. A spawned session must not inherit the human's stored
 *    credential — an agent that wants another server needs its own account
 *    there. Any agent-context marker in the env disables the store entirely,
 *    for reads and writes alike.
 *  - `server_connections` STAYS CREDENTIAL-FREE (migration 044: "a credential
 *    that is stored but never used would only create secret exposure").
 *    Routing config is server-side and shared; credentials are client-side
 *    and personal. They must not merge.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Metadata stored alongside a token where the backend can hold it (file only). */
export interface CredentialMeta {
  username?: string | undefined;
  expiresAt?: string | undefined;
}

export interface CredentialStore {
  /** Which backend this is — rendered to the user so storage is never a mystery. */
  readonly kind: 'keychain' | 'file';
  get(origin: string): string | undefined;
  set(origin: string, token: string, meta?: CredentialMeta): void;
  /** True when an entry existed and was removed. */
  delete(origin: string): boolean;
  /**
   * The pin-key index for `origin` (see `spaceCredentialKey`). Not a
   * credential — it names spaces and gate session ids, never a secret — so it
   * lives in its own slot, and nothing that reads credentials has to skip it.
   * An absent index is `[]`; an index that exists but cannot be read (a
   * locked keychain, a denied prompt) THROWS, so no caller mistakes it for
   * empty and writes over it.
   */
  getSpaceIndex(origin: string): string[];
  /** Replace the index for `origin`; an empty one removes it. */
  setSpaceIndex(origin: string, keys: readonly string[]): void;
}

/**
 * Normalize a base URL to the origin a credential is keyed by. `URL.origin`
 * lower-cases the host, strips paths and trailing slashes, and elides default
 * ports — one canonical spelling per server.
 */
export function credentialOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** `tm8s_<sessionId>.<secret>` → the embedded session id, else undefined. */
export function tokenSessionId(token: string): string | undefined {
  if (!token.startsWith('tm8s_')) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 'tm8s_'.length) return undefined;
  return token.slice('tm8s_'.length, dot);
}

/**
 * W3 PINNED SPACE SESSIONS share this store under their own keys. Under
 * `TM8_SPACE_SESSIONS=enforce` the origin's credential is a GATE session, and
 * every command that acts in a space needs a session pinned to it
 * (`tm8 auth space enter <space-id>`). The key carries the gate session id,
 * so a fresh `auth login` orphans every pin minted by the previous one and a
 * pinned token is only ever presented next to the gate it came from.
 *
 * The store's space index lists the pin keys, because the keychain backend
 * cannot enumerate: logout and login read it to revoke and forget them.
 */
export function spaceCredentialKey(origin: string, spaceId: string, gateSessionId: string): string {
  return `${origin}#space:${spaceId}#gate:${gateSessionId}`;
}

/**
 * Before the index had its own slot it was a pseudo-credential under
 * `<origin>#spaces`, comma-joined. The first read after an upgrade folds it
 * into the slot and deletes it, so an old install still revokes its pins.
 */
function legacySpaceIndexKey(origin: string): string {
  return `${origin}#spaces`;
}

interface SpaceIndexRead {
  keys: string[];
  /** False when the index exists but could not be read: never write it back. */
  writable: boolean;
}

function readSpaceIndex(store: CredentialStore, origin: string): SpaceIndexRead {
  let index: string[] = [];
  let writable = true;
  try {
    index = store.getSpaceIndex(origin);
  } catch {
    writable = false;
  }
  const legacy = store.get(legacySpaceIndexKey(origin));
  if (legacy === undefined) return { keys: index, writable };
  const merged = [...new Set([...index, ...legacy.split(',').filter(Boolean)])];
  // The fold is housekeeping. It never overwrites an index it could not read,
  // and a failed write leaves the legacy entry for the next read to retry;
  // this read still answers with every key it saw, so logout still revokes.
  if (writable) {
    try {
      store.setSpaceIndex(origin, merged);
      store.delete(legacySpaceIndexKey(origin));
    } catch {
      /* retried on the next read */
    }
  }
  return { keys: merged, writable };
}

function storedPinKey(store: CredentialStore, origin: string, spaceId: string): string | undefined {
  const gate = store.get(origin);
  const gateSessionId = gate ? tokenSessionId(gate) : undefined;
  return gateSessionId ? spaceCredentialKey(origin, spaceId, gateSessionId) : undefined;
}

/** The pinned token for `spaceId` minted from the stored gate session, if any. */
export function spaceCredential(
  store: CredentialStore,
  origin: string,
  spaceId: string,
): string | undefined {
  const key = storedPinKey(store, origin, spaceId);
  return key ? store.get(key) : undefined;
}

/**
 * Store a pinned token under the current gate session. Returns the token it
 * replaced for the same space, so the caller can revoke it.
 */
export function storeSpaceCredential(
  store: CredentialStore,
  origin: string,
  spaceId: string,
  token: string,
  meta?: CredentialMeta,
): string | undefined {
  const key = storedPinKey(store, origin, spaceId);
  if (!key) throw new Error(`no stored gate credential for ${origin}`);
  const previous = store.get(key);
  store.set(key, token, meta);
  const index = readSpaceIndex(store, origin);
  if (index.writable && !index.keys.includes(key)) store.setSpaceIndex(origin, [...index.keys, key]);
  return previous;
}

/**
 * Forget the pin for `spaceId` after the Server refused it (expired or
 * revoked), so the next command does not present the dead token again. Only
 * while the stored pin is still `token`: a concurrent `auth space enter` may
 * already have replaced it with a live one. True when it was removed.
 */
export function forgetSpaceCredential(
  store: CredentialStore,
  origin: string,
  spaceId: string,
  token: string,
): boolean {
  const key = storedPinKey(store, origin, spaceId);
  if (!key || store.get(key) !== token) return false;
  store.delete(key);
  const index = readSpaceIndex(store, origin);
  if (index.writable) store.setSpaceIndex(origin, index.keys.filter((k) => k !== key));
  return true;
}

/** Forget every pinned token stored for `origin`; returns them for revocation. */
export function dropSpaceCredentials(store: CredentialStore, origin: string): string[] {
  const tokens: string[] = [];
  const index = readSpaceIndex(store, origin);
  for (const key of index.keys) {
    const token = store.get(key);
    if (token) tokens.push(token);
    store.delete(key);
  }
  // An unreadable index may still name pins this read could not see; keep it
  // so a later logout can revoke them. A failed clear only leaves keys whose
  // entries are already gone, so it must not fail the logout.
  if (index.writable) {
    try {
      store.setSpaceIndex(origin, []);
    } catch {
      /* stale keys are harmless: every entry they name was deleted above */
    }
  }
  return tokens;
}

/** `$TM8_CREDENTIALS_PATH`, else `~/.config/tm8/credentials.json`. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TM8_CREDENTIALS_PATH?.trim();
  if (explicit) return explicit;
  return join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'),
    'tm8',
    'credentials.json',
  );
}

/**
 * The agent-context guard. `TM8_AGENT_TOKEN` is the spawn-minted credential
 * seam; `TM8_SESSION_ID` / `TM8_TEAM_MEMBER_ID` mark a tm8-spawned session
 * even before minting exists. In any of those contexts the human's store is
 * off-limits (doc 13 §4.3): the store returns as absent rather than refusing,
 * so the request proceeds with whatever credential the spawn env provided.
 */
export function isAgentContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.TM8_AGENT_TOKEN?.trim() || env.TM8_SESSION_ID?.trim() || env.TM8_TEAM_MEMBER_ID?.trim(),
  );
}

/**
 * Resolve the store for this process, or undefined when no store may be used:
 * agent contexts, and `TM8_CREDENTIALS_MODE=off`.
 *
 * Selection: `TM8_CREDENTIALS_PATH` forces the file backend at that path
 * (the test seam, and the operator's escape hatch); `TM8_CREDENTIALS_MODE`
 * picks a backend explicitly; otherwise darwin gets the keychain and every
 * other platform the 0600 file.
 */
export function credentialStoreFor(
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore | undefined {
  if (isAgentContext(env)) return undefined;
  const mode = env.TM8_CREDENTIALS_MODE?.trim();
  if (mode === 'off') return undefined;
  if (env.TM8_CREDENTIALS_PATH?.trim()) return new FileCredentialStore(credentialsPath(env));
  if (mode === 'file') return new FileCredentialStore(credentialsPath(env));
  if (mode === 'keychain') return new KeychainCredentialStore();
  return process.platform === 'darwin'
    ? new KeychainCredentialStore()
    : new FileCredentialStore(credentialsPath(env));
}

interface FileShape {
  version: 1;
  credentials: Record<string, { token: string } & CredentialMeta>;
  /** Pin keys per origin: the space index, beside the credentials, not among them. */
  spaces?: Record<string, string[]>;
}

/**
 * The 0600 JSON file. Reads are defensive — an absent or corrupt file is an
 * empty store, matching `loadLocalConfig`'s posture — and writes are atomic:
 * the temp file is created 0600 BEFORE the token is written into it, then
 * renamed over the target, so no interleaving ever exposes a readable token.
 */
class FileCredentialStore implements CredentialStore {
  readonly kind = 'file' as const;
  constructor(private readonly path: string) {}

  private read(): FileShape {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      return { version: 1, credentials: {} };
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as FileShape).credentials !== 'object' ||
      (parsed as FileShape).credentials === null
    ) {
      return { version: 1, credentials: {} };
    }
    const spaces = (parsed as FileShape).spaces;
    return {
      version: 1,
      credentials: { ...(parsed as FileShape).credentials },
      ...(spaces !== null && typeof spaces === 'object' && !Array.isArray(spaces) ? { spaces: { ...spaces } } : {}),
    };
  }

  private write(shape: FileShape): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    // Rename preserves the temp file's 0600, but repair a pre-existing loose
    // target that the rename replaced on filesystems where it might not.
    try {
      if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
    } catch {
      /* the file just got written; a stat race here is not worth failing on */
    }
  }

  get(origin: string): string | undefined {
    const entry = this.read().credentials[origin];
    return entry && typeof entry.token === 'string' && entry.token ? entry.token : undefined;
  }

  set(origin: string, token: string, meta?: CredentialMeta): void {
    const shape = this.read();
    shape.credentials[origin] = {
      token,
      ...(meta?.username !== undefined ? { username: meta.username } : {}),
      ...(meta?.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
    };
    this.write(shape);
  }

  delete(origin: string): boolean {
    const shape = this.read();
    if (!(origin in shape.credentials)) return false;
    delete shape.credentials[origin];
    this.writeOrRemove(shape);
    return true;
  }

  getSpaceIndex(origin: string): string[] {
    const keys = this.read().spaces?.[origin];
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string' && k !== '') : [];
  }

  setSpaceIndex(origin: string, keys: readonly string[]): void {
    const shape = this.read();
    const spaces = { ...shape.spaces };
    if (keys.length > 0) spaces[origin] = [...keys];
    else if (origin in spaces) delete spaces[origin];
    else return;
    if (Object.keys(spaces).length > 0) shape.spaces = spaces;
    else delete shape.spaces;
    this.writeOrRemove(shape);
  }

  /** An empty store is no file at all. */
  private writeOrRemove(shape: FileShape): void {
    if (Object.keys(shape.credentials).length === 0 && shape.spaces === undefined) {
      try {
        unlinkSync(this.path);
        return;
      } catch {
        /* fall through: write the empty shape instead */
      }
    }
    this.write(shape);
  }
}

const KEYCHAIN_SERVICE = 'tm8';
/** `security(1)`'s errSecItemNotFound exit status: absent, not unreadable. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;
/** The space index's own service: next to the credentials, never among them. */
const KEYCHAIN_INDEX_SERVICE = 'tm8-space-index';

/**
 * macOS login keychain via `security(1)`. The write goes through `security -i`
 * (commands on stdin), so the secret never appears in argv. Values that cannot
 * be safely quoted for the interactive parser are refused rather than escaped.
 */
class KeychainCredentialStore implements CredentialStore {
  readonly kind = 'keychain' as const;

  private quote(value: string, what: string): string {
    if (/["\\\n\r\0]/.test(value)) {
      throw new Error(`${what} contains characters the keychain quoting cannot carry`);
    }
    return `"${value}"`;
  }

  get(origin: string, service = KEYCHAIN_SERVICE): string | undefined {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', service, '-a', origin, '-w'],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) return undefined;
    const token = result.stdout.trim();
    return token || undefined;
  }

  set(origin: string, token: string, _meta?: CredentialMeta, service = KEYCHAIN_SERVICE): void {
    const line = [
      'add-generic-password',
      '-U',
      '-s',
      this.quote(service, 'service'),
      '-a',
      this.quote(origin, 'origin'),
      '-w',
      this.quote(token, 'token'),
    ].join(' ');
    const result = spawnSync('security', ['-i'], { input: `${line}\n`, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `security add-generic-password failed (${result.status}): ${result.stderr.trim()}`,
      );
    }
  }

  delete(origin: string, service = KEYCHAIN_SERVICE): boolean {
    const result = spawnSync(
      'security',
      ['delete-generic-password', '-s', service, '-a', origin],
      { encoding: 'utf8' },
    );
    return result.status === 0;
  }

  getSpaceIndex(origin: string): string[] {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_INDEX_SERVICE, '-a', origin, '-w'],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.status === KEYCHAIN_ITEM_NOT_FOUND) return [];
    if (result.status !== 0) {
      throw new Error(`security find-generic-password failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim().split(',').filter(Boolean);
  }

  setSpaceIndex(origin: string, keys: readonly string[]): void {
    if (keys.length > 0) this.set(origin, keys.join(','), undefined, KEYCHAIN_INDEX_SERVICE);
    else this.delete(origin, KEYCHAIN_INDEX_SERVICE);
  }
}
