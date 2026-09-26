/**
 * Space links (migrations 250/251, Phase 1b W6). A home space links to a
 * target space; each member of the home space who is also a member of the
 * target signs in once and the server stores that member's own `link`
 * session for the target, sealed, 90 days. Agents launched by that member use
 * it (W7); nobody else can.
 *
 *   · spaceLinks.list     — every home member sees the links (no secrets)
 *   · spaceLinks.add      — link a space you are also a member of
 *   · spaceLinks.login    — sign in: store your own session for the target
 *   · spaceLinks.relogin  — replace it; the old one is revoked
 *   · spaceLinks.logout   — revoke it and forget the stored bytes
 *   · spaceLinks.remove   — delete your own row (the link stays for others)
 *   · spaceLinks.setSpawn — your own spawn switch and budget. Allow spawn is
 *                           stored per link; it is enforced when cross-space
 *                           spawn ships.
 *
 * Every write is human-only (browser or cli) in SQL. No response ever carries
 * the stored session.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';

export type SpaceLinkStatus = 'signed_in' | 'signed_out' | 'left' | 'unreachable';

/** The caller's own row: metadata only. */
export interface SpaceLinkMine {
  memberId: EntityId;
  status: SpaceLinkStatus;
  allowSpawn: boolean;
  spawnBudget: number;
  alias: string | null;
  sessionId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface SpaceLinkView {
  id: EntityId;
  homeSpaceId: string;
  targetSpaceId: string;
  /** Null = this server. */
  targetServerId: EntityId | null;
  /** Only when the caller is a member of the target. */
  targetSpaceName: string | null;
  createdAt: string;
  statusSummary: { signedIn: number; signedOut: number; left: number; unreachable: number };
  /** Null when the caller holds no row on this link. */
  mine: SpaceLinkMine | null;
}

/** The body of spaceLinks.add: the home Space is the path's `:spaceId`. */
export interface SpaceLinksAddInput {
  targetSpaceId: string;
  alias?: string | null;
  clientMutationId: string;
}

/** The body of spaceLinks.login / relogin / logout / remove. */
export interface SpaceLinksMutationInput {
  clientMutationId: string;
}

/**
 * The body of spaceLinks.setSpawn. Allow spawn is stored per link; it is enforced when cross-space spawn ships.
 */
export interface SpaceLinksSetSpawnInput {
  allowSpawn: boolean;
  /** 0..100; omitted keeps the current budget. */
  spawnBudget?: number | null;
  clientMutationId: string;
}

const clientMutationId = z.string().trim().min(1);

export const SpaceLinksAddInputSchema: z.ZodType<SpaceLinksAddInput> = z.object({
  targetSpaceId: z.string().uuid(),
  alias: z.string().max(200).nullable().optional(),
  clientMutationId,
}).strict();

export const SpaceLinksMutationInputSchema: z.ZodType<SpaceLinksMutationInput> = z.object({
  clientMutationId,
}).strict();

export const SpaceLinksSetSpawnInputSchema: z.ZodType<SpaceLinksSetSpawnInput> = z.object({
  allowSpawn: z.boolean(),
  spawnBudget: z.number().int().min(0).max(100).nullable().optional(),
  clientMutationId,
}).strict();
