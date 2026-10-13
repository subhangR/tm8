/**
 * The SERVER store (W8, migration 261): typed wrappers for the servers.* RPCs
 * and the reachability probe.
 *
 * W9c (301) RETIRED the member's stored gate session (`server_gate_tokens`,
 * finding S4: a retained human session for the remote would bypass its link
 * and agent policy). `signIn`/`openGate` are gone, the stored rows were
 * deleted and the two RPCs refuse. Signing in to a space on another server is
 * the pairing-code claim (remote/link-pairing.ts): what this node keeps is a
 * `link` session the remote minted for one space, never a human session.
 * `Server.mine` stays in the response shape and now always reads signed out.
 */
import type { Db, DbClaims } from '../db/types.js';
import type { GuardedHttpsOptions, GuardedResult } from './guarded-https.js';
import { getRemoteHealth, type RemoteLinkClientOptions } from './link-client.js';

export type ServerReachStatus = 'unknown' | 'reachable' | 'unreachable' | 'offline';

/** One server as a home member sees it (261 `internal.server_json`). No secret. */
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

export interface DbServerStoreOptions {
  db: Db;
  /** Kept for callers; unused since W9c retired the sealed gate session. */
  dataDir: string;
  /** Tests only: the guard's resolver and transport. The address policy is not injectable. */
  https?: GuardedHttpsOptions;
  /** This node's link-client policy (`remoteLinkClientOptionsOf(config)`): loopback / private opt-ins. */
  client?: RemoteLinkClientOptions;
  /** The probe's whole budget. */
  probeTimeoutMs?: number;
}

export const SERVER_PROBE_TIMEOUT_MS = 5_000;

export class DbServerStore {
  private readonly db: Db;
  private readonly client: RemoteLinkClientOptions;
  private readonly probeTimeoutMs: number;

  constructor(options: DbServerStoreOptions) {
    this.db = options.db;
    this.client = { ...options.client, ...(options.https ? { https: options.https } : {}) };
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

  /**
   * Reachability: an unauthenticated GET of the server's `/health` through the
   * guarded client. The guard refusing (loopback, private, bad URL, TLS) is
   * `unreachable`; refused, reset or silent is `offline`, inside the budget.
   * Any HTTP answer is `reachable`: TLS completed and something answered; an
   * answer that is not a tm8 `/health` says so in `reason` (`not_tm8`).
   * It runs ON THIS NODE, under its link-client policy, so it answers "can
   * this server reach that one" rather than "can the caller's machine".
   */
  async probe(claims: DbClaims, serverId: string): Promise<ServerProbe> {
    const server = await this.db.rpc<Server>(claims, 'get_server', [serverId]);
    const result = await getRemoteHealth(server.baseUrl, { ...this.client, timeoutMs: this.probeTimeoutMs });
    const status = result.kind === 'response' ? 'reachable' : result.kind;
    const updated = await this.markReach(claims, serverId, status);
    const reason = result.kind !== 'response' ? result.reason : isTm8Health(result.body) ? undefined : 'not_tm8';
    return { server: updated, outcome: result.kind, ...(reason ? { reason } : {}) };
  }

  /** Record what a probe or a forwarded call just saw. */
  markReach(claims: DbClaims, serverId: string, status: Exclude<ServerReachStatus, 'unknown'>): Promise<Server> {
    return this.db.rpc<Server>(claims, 'mark_server_reach', [serverId, status]);
  }
}

/** `/health` as a tm8 server answers it (`{ ok: true, server: 'tm8-server' }`). */
export function isTm8Health(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed['server'] === 'tm8-server';
  } catch {
    return false;
  }
}
