/**
 * Ending a membership, and turning an account off (migration 230, plan
 * 01a0d9eb W1 / G6). A membership ends by TOMBSTONE: the member row, the
 * member entity and everything they authored stay, `members.status` becomes
 * `left` or `removed`, and every membership helper stops answering for it.
 *
 *   · spaces.leave          — the caller leaves (human-only; the last owner
 *                             cannot leave)
 *   · spaces.members.remove — an admin removes someone else (human-only; only
 *                             an owner removes an owner)
 *   · accounts.disable      — a node admin turns an account off (human-only;
 *                             never your own, never the node owner)
 *
 * Every one of them is a command with a required `clientMutationId`, and a
 * replay returns the recorded result.
 */
import { z } from 'zod';

import type { EntityId } from './contract.js';

export type MembershipEndStatus = 'left' | 'removed';

/** `spaces.leave` and `spaces.members.remove` answer with the same shape. */
export interface MembershipEndResult {
  spaceId: string;
  memberId: EntityId;
  status: MembershipEndStatus;
  leftAt: string;
  /** Work sessions recorded exited in the same transaction; their PTYs are killed after commit. */
  stoppedSessionIds: EntityId[];
  /** The member's personas: kept, deactivated. */
  deactivatedPersonaIds: EntityId[];
  /** Entities (tasks) that lost an `assigned_to` edge to the member or their personas. */
  unassignedEntityIds: EntityId[];
  /** Auth sessions revoked: pinned to this space, of the stopped sessions, or acting as a persona. */
  revokedTokenCount: number;
  /** The `updated` activity row that records the status change. */
  activity: string;
}

export interface AccountDisableResult {
  accountId: string;
  status: 'disabled';
  disabledAt: string;
  revokedSessionCount: number;
  /** Live work sessions the account drove or launched; contained after commit. */
  stoppedSessionIds: EntityId[];
}

const MutationOnlySchema = z.object({ clientMutationId: z.string().trim().min(1) }).strict();

export const SpacesLeaveInputSchema = MutationOnlySchema;
export const SpacesMembersRemoveInputSchema = MutationOnlySchema;
export const AccountsDisableInputSchema = MutationOnlySchema;
