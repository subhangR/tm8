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
    return { version: 1, credentials: { ...(parsed as FileShape).credentials } };
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
    if (Object.keys(shape.credentials).length === 0) {
      try {
        unlinkSync(this.path);
      } catch {
        this.write(shape);
      }
      return true;
    }
    this.write(shape);
    return true;
  }
}

const KEYCHAIN_SERVICE = 'tm8';

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

  get(origin: string): string | undefined {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', origin, '-w'],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) return undefined;
    const token = result.stdout.trim();
    return token || undefined;
  }

  set(origin: string, token: string): void {
    const line = [
      'add-generic-password',
      '-U',
      '-s',
      this.quote(KEYCHAIN_SERVICE, 'service'),
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

  delete(origin: string): boolean {
    const result = spawnSync(
      'security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', origin],
      { encoding: 'utf8' },
    );
    return result.status === 0;
  }
}
