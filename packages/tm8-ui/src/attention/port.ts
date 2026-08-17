/**
 * THE ATTENTION PORT — two verbs, and the only place `AttentionRequests` knows
 * a seam exists.
 *
 * Same law as `files/port.ts`: the component takes plain values and callbacks
 * and cannot tell a fixture from a real node. A host wires
 * `attentionPortFromSeam(seam, spaceId)` once and the section is testable
 * against a hand-written object with no seam at all.
 *
 * WHY A PORT AND NOT THE SEAM DIRECTLY, when `SessionDebugBody` takes the seam:
 * this component WRITES. A surface holding `seam.commands` holds every command
 * in the product, and the two it needs are a strict subset of one another's
 * blast radius — `resolveAttention` is bulk and unaddressable, `update` is
 * per-row. Naming exactly those two here is what keeps a later edit from
 * quietly reaching for `deleteEntity` because it happened to be in scope.
 */
import type {
  AttentionRequest,
  AttentionRequestMutationResult,
  AttentionRequestStatus,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';

/** One page is the whole history for one entity in every realistic case. */
export const HISTORY_LIMIT = 100;

export interface AttentionPort {
  /**
   * EVERY request ever made on this entity, whatever its status.
   *
   * Deliberately unfiltered: the server narrows to pending only when computing
   * the badge (`entity-read.ts:520-523`), and passing a `status` here would
   * reproduce that narrowing in the one surface whose entire purpose is the
   * part the badge drops.
   */
  history(entityId: EntityId): Promise<{ rows: AttentionRequest[]; truncated: boolean }>;
  /**
   * Settle ONE request. `expectedVersion` is the row's own version and a
   * conflict is the expected failure, not a rare one — opening an entity bulk-
   * resolves its queue and bumps every version it touches, so a section that
   * has been sitting on screen is holding stale versions by design.
   */
  settle(input: {
    requestId: string;
    expectedVersion: number;
    status: AttentionRequestStatus;
    resolutionNote?: string;
  }): Promise<AttentionRequestMutationResult>;
}

export function attentionPortFromSeam(seam: Seam, spaceId: SpaceId | string): AttentionPort {
  return {
    async history(entityId) {
      const page = await seam.attentionRequests({
        spaceId: spaceId as SpaceId,
        entityId,
        limit: HISTORY_LIMIT,
      });
      return { rows: [...page.items], truncated: page.nextCursor != null };
    },
    settle: ({ requestId, expectedVersion, status, resolutionNote }) =>
      seam.commands.updateAttentionRequest(requestId, {
        // The server requires a mutation id on every command; it is what makes
        // a retried write idempotent rather than a second settlement.
        clientMutationId: `attention-settle:${requestId}:${expectedVersion}:${status}`,
        expectedVersion,
        status,
        // OMITTED, not sent empty: `resolutionNote: ''` would overwrite a note
        // somebody already wrote with nothing, and the input schema coalesces
        // rather than clears (migration 050:143-169).
        ...(resolutionNote ? { resolutionNote } : {}),
      }),
  };
}
