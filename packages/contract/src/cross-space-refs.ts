/**
 * Cross-space references (migration 279, lane L3; owner decisions D3, D7).
 *
 * An edge never crosses spaces (D3 keeps that invariant). An entity in home
 * space A may instead hold a REFERENCE to an entity in target space B:
 * `{targetSpaceId, targetEntityId, kind, titleSnapshot}`, stored in A only.
 *
 *   · entities.refs.add    — through the caller's OWN signed-in space link
 *                            (D7: no active link, no reference). The server
 *                            reads B's entity through that link first, so a
 *                            reference only ever names something the caller
 *                            could read in B; the read is audited in A.
 *   · entities.refs.list   — every reader of the A entity. `live` is set only
 *                            when the VIEWER can read B's entity directly;
 *                            otherwise the snapshot is all there is.
 *   · entities.refs.remove — every member who can read the A entity.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';

/** What the viewer sees of B's entity when it can read it now. */
export interface CrossSpaceRefLive {
  kind: string;
  title: string;
  updatedAt: string;
}

export interface CrossSpaceRef {
  id: string;
  /** Space A: the referencing entity's space. */
  spaceId: string;
  entityId: EntityId;
  /** The link it was made through; null once that link is removed. */
  linkId: EntityId | null;
  targetSpaceId: string;
  /** Null: B is on this server. Set: a remote link's `server` entity (W8). */
  targetServerId: EntityId | null;
  targetEntityId: EntityId;
  /** B's entity kind when the reference was made (or last refreshed). */
  kind: string;
  /** B's title when the reference was made (or last refreshed). Untrusted. */
  titleSnapshot: string;
  /** Null when the viewer cannot read B's entity: render the snapshot. */
  live: CrossSpaceRefLive | null;
  createdBy: EntityId;
  createdAt: string;
  updatedAt: string;
}

/**
 * The body of entities.refs.add; the referencing entity is the path's `:id`.
 * Adding a target the entity already references refreshes its snapshot.
 */
export interface CrossSpaceRefAddInput {
  /** The caller's link out of A: its alias or the link id. */
  link: string;
  targetEntityId: string;
  actorId?: string;
  clientMutationId?: string;
  workSessionId?: string;
}

export interface CrossSpaceRefRemoved {
  id: string;
  entityId: EntityId;
  removed: true;
}

/** The command context every command body may carry (schemas.ts `commandContextShape`). */
const commandContext = {
  actorId: z.string().uuid().optional(),
  clientMutationId: z.string().optional(),
  workSessionId: z.string().uuid().optional(),
};

export const CrossSpaceRefAddInputSchema: z.ZodType<CrossSpaceRefAddInput> = z.object({
  ...commandContext,
  link: z.string().trim().min(1).max(200),
  targetEntityId: z.string().uuid(),
}).strict();

export interface CrossSpaceRefRemoveInput {
  actorId?: string;
  clientMutationId?: string;
  workSessionId?: string;
}

export const CrossSpaceRefRemoveInputSchema: z.ZodType<CrossSpaceRefRemoveInput> = z.object({
  ...commandContext,
}).strict();

/** Typed `details.reason` values a refused add carries. */
export const CROSS_SPACE_REF_NO_LINK = 'cross_space_ref_no_link';
export const CROSS_SPACE_REF_LINK_INACTIVE = 'cross_space_ref_link_inactive';

/**
 * `details.reason` on an `edges.create` whose endpoints are in two spaces.
 * An edge never crosses spaces (D3), so no retry succeeds: the refusal names
 * the reference to make instead, as `details.next` (the CLI prints it).
 */
export const CROSS_SPACE_EDGE = 'cross_space_edge';

/** Placeholder for `--link` when the refusal cannot tell which link to use. */
export const CROSS_SPACE_REF_LINK_PLACEHOLDER = '<alias|link-id|space-id>';

/**
 * The one command that replaces a cross-space edge. `holderId` is the entity
 * in the caller's own space; `targetId` is the one in the linked space.
 */
export function crossSpaceRefCommand(holderId: string, targetId: string, link?: string): string {
  return `tm8 entity ref add ${holderId} ${targetId} --link ${link ?? CROSS_SPACE_REF_LINK_PLACEHOLDER}`;
}
