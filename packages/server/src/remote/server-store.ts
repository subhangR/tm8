/**
 * The SERVER store (W8, migration 991): typed wrappers for the servers.* RPCs,
 * the reachability probe, and the only module that seals or opens a member's
 * gate session on a remote server.
 *
 * Sealed as 244's link sessions are: AES-256-GCM under the node key, bound to
 * `server-gate|<home_space_id>|<server_id>|<member_id>`
 * (`ServerGateSecretBinding`). The binding is RECOMPUTED from the row's
 * columns on open, never read from the stored `aad`, so a ciphertext copied to
 * another row or member does not open.
 *
 * The gate token is never logged, never put in an error, and returned only by
 * `openGate` to server-side code. Management is human-only in SQL (the strict
 * `internal.require_human_auth_kind`), and so is `open_server_gate_token`: an
 * agent never holds a member's gate session.
 */
import type { Db, DbClaims } from '../db/types.js';
import { loadOrCreateCredentialKey } from '../credentials/credential-key.js';
import { openSecret, sealSecret, type ServerGateSecretBinding } from '../credentials/secret-box.js';
import { guardedHttpsRequest, type GuardedHttpsOptions, type GuardedResult } from './guarded-https.js';

export type ServerReachStatus = 'unknown' | 'reachable' | 'unreachable' | 'offline';

/** One server as a home member sees it (991 `internal.server_json`). No secret. */
export interface Server {
  id: string;
  homeSpaceId: string;
  name: string;
  baseUrl: string;
  username: string | null;
  reachStatus: ServerReachStatus;
  reachCheckedAt: string | null;
  legacyConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
  mine: { status: 'signed_in' | 'signed_out'; expiresAt: string | null; lastUsedAt: string | null } | null;
}

/** One row of `public.server_directory`: a server entity, or a 044 row no entity has adopted yet. */
export interface ServerDirectoryRow {
  id: string;
  name: string;
  baseUrl: string;
  username: string | null;
  homeSpaceId: string | null;
  reachStatus: ServerReachStatus;
  legacy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerProbe {
  server: Server;
  /** What the guarded client saw. `response` means TLS completed and the server answered. */
  outcome: GuardedResult['kind'];
  reason?: string;
}

interface OpenedGate {
  serverId: string;
  homeSpaceId: string;
  memberId: string;
  ciphertext: string;
  nonce: string;
}

export interface DbServerStoreOptions {
  db: Db;
  dataDir: string;
  /** Tests only: the guard's resolver and transport. The address policy is not injectable. */
  https?: GuardedHttpsOptions;
  /** The probe's whole budget. */
  probeTimeoutMs?: number;
}

export const SERVER_PROBE_TIMEOUT_MS = 5_000;

export class DbServerStore {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly https: GuardedHttpsOptions;
  private readonly probeTimeoutMs: number;

  constructor(options: DbServerStoreOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.https = options.https ?? {};
    this.probeTimeoutMs = options.probeTimeoutMs ?? SERVER_PROBE_TIMEOUT_MS;
  }

  list(claims: DbClaims, spaceId: string): Promise<Server[]> {
    return this.db.rpc<Server[]>(claims, 'list_servers', [spaceId]);
  }

  get(claims: DbClaims, serverId: string): Promise<Server> {
    return this.db.rpc<Server>(claims, 'get_server', [serverId]);
  }

  add(
    claims: DbClaims,
    input: { spaceId?: string | null; name: string; baseUrl: string; username?: string | null; clientMutationId?: string | null },
  ): Promise<Server> {
    return this.db.rpc<Server>(claims, 'add_server', [
      input.spaceId ?? null, input.name, input.baseUrl, input.username ?? null, input.clientMutationId ?? null,
    ]);
  }

  adopt(claims: DbClaims, input: { spaceId?: string | null; name: string; clientMutationId?: string | null }): Promise<Server> {
    return this.db.rpc<Server>(claims, 'adopt_server_connection', [
      input.spaceId ?? null, input.name, input.clientMutationId ?? null,
    ]);
  }

  remove(claims: DbClaims, serverId: string, clientMutationId?: string | null): Promise<Server> {
    return this.db.rpc<Server>(claims, 'remove_server', [serverId, clientMutationId ?? null]);
  }

  /** Seal and store the member's gate session for `serverId`. The token is never returned. */
  async signIn(
    claims: DbClaims,
    input: { serverId: string; token: string; expiresAt?: string | null; clientMutationId?: string | null },
  ): Promise<Server> {
    const binding = await this.db.rpc<ServerGateSecretBinding>(claims, 'server_gate_seal_context', [input.serverId]);
    const sealed = sealSecret(await this.key(), input.token, binding);
    return this.db.rpc<Server>(claims, 'store_server_gate_token', [
      input.serverId, input.expiresAt ?? null, sealed.ciphertext, sealed.nonce, input.clientMutationId ?? null,
    ]);
  }

  signOut(claims: DbClaims, serverId: string, clientMutationId?: string | null): Promise<Server> {
    return this.db.rpc<Server>(claims, 'sign_out_server', [serverId, clientMutationId ?? null]);
  }

  /** The member's gate token, in memory, for server-side use only. Never log it. */
  async openGate(claims: DbClaims, serverId: string): Promise<string> {
    const row = await this.db.rpc<OpenedGate>(claims, 'open_server_gate_token', [serverId]);
    return openSecret(
      await this.key(),
      { ciphertext: Buffer.from(row.ciphertext, 'base64'), nonce: Buffer.from(row.nonce, 'base64') },
      { homeSpaceId: row.homeSpaceId, serverId: row.serverId, memberId: row.memberId },
    );
  }

  /**
   * Reachability: an unauthenticated GET of the server's `/health` through the
   * guarded client. The guard refusing (loopback, private, bad URL, TLS) is
   * `unreachable`; refused, reset or silent is `offline`, inside the budget.
   * Any HTTP answer is `reachable`: TLS completed and something answered.
   */
  async probe(claims: DbClaims, serverId: string): Promise<ServerProbe> {
    const server = await this.db.rpc<Server>(claims, 'get_server', [serverId]);
    const url = new URL('/health', server.baseUrl).toString();
    const result = await guardedHttpsRequest(
      { url, method: 'GET', headers: { accept: 'application/json' }, timeoutMs: this.probeTimeoutMs },
      this.https,
    );
    const status = result.kind === 'response' ? 'reachable' : result.kind;
    const updated = await this.db.rpc<Server>(claims, 'mark_server_reach', [serverId, status]);
    return {
      server: updated,
      outcome: result.kind,
      ...(result.kind === 'response' ? {} : { reason: result.reason }),
    };
  }

  private key(): Promise<Buffer> {
    return loadOrCreateCredentialKey(this.dataDir);
  }
}
