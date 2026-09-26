/**
 * Remote servers (migration 991, Phase 1b W8). A `server` entity lives in a
 * home space; every member of that space sees it. It replaces 044's
 * node-local `server_connections`, which is now read-only: its rows stay, and
 * `servers.adopt` makes an entity for one on first use (no backfill).
 *
 *   · servers.list   — every live server in a space (no secrets)
 *   · servers.get    — one server, for a home member
 *   · servers.add    — add a server to a space (the caller's first space when omitted)
 *   · servers.adopt  — give a 044 row its entity (node admin)
 *   · servers.remove — the creator or a space admin
 *   · servers.probe  — check reachability through the SSRF-guarded client
 *
 * add / adopt / remove are human-only (browser or cli) in SQL. A member's
 * sealed gate session (`server_gate_tokens`) is never in any response.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';
import { ServerConnectionBaseUrlSchema, ServerConnectionNameSchema } from './schemas.js';

/** `unreachable`: the guard or TLS refused (e.g. loopback-only). `offline`: refused, reset or silent. */
export type ServerReachStatus = 'unknown' | 'reachable' | 'unreachable' | 'offline';

export interface ServerView {
  id: EntityId;
  homeSpaceId: string;
  name: string;
  baseUrl: string;
  username: string | null;
  reachStatus: ServerReachStatus;
  reachCheckedAt: string | null;
  /** The 044 row this entity adopted, if any. */
  legacyConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller's own gate session: metadata only. Null when they hold none. */
  mine: { status: 'signed_in' | 'signed_out'; expiresAt: string | null; lastUsedAt: string | null } | null;
}

export interface ServerProbeView {
  server: ServerView;
  outcome: 'response' | 'unreachable' | 'offline';
  reason?: string;
}

export interface ServersAddInput {
  /** Omitted: the caller's first active space (the server rail sits above spaces). */
  spaceId?: string | null;
  name: string;
  baseUrl: string;
  username?: string | null;
  clientMutationId: string;
}

export interface ServersAdoptInput {
  spaceId?: string | null;
  /** The 044 `server_connections.name`. */
  name: string;
  clientMutationId: string;
}

export interface ServersMutationInput {
  clientMutationId: string;
}

const clientMutationId = z.string().trim().min(1);

export const ServersAddInputSchema: z.ZodType<ServersAddInput> = z.object({
  spaceId: z.string().uuid().nullable().optional(),
  name: ServerConnectionNameSchema,
  baseUrl: ServerConnectionBaseUrlSchema,
  username: z.string().min(1).max(100).nullable().optional(),
  clientMutationId,
}).strict();

export const ServersAdoptInputSchema: z.ZodType<ServersAdoptInput> = z.object({
  spaceId: z.string().uuid().nullable().optional(),
  name: ServerConnectionNameSchema,
  clientMutationId,
}).strict();

export const ServersMutationInputSchema: z.ZodType<ServersMutationInput> = z.object({
  clientMutationId,
}).strict();
