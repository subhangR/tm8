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

/**
 * THE FACTORY IS MEMOISED, and that is a correctness property rather than a
 * performance one.
 *
 * `attentionSectionFor` calls this INSIDE the render of five hosts. A fresh
 * object literal per call meant the port's identity changed on every one of
 * those renders, and `AttentionRequests` had it in a `useCallback` dependency
 * array feeding a mount effect — so every host render re-ran the effect, refetched
 * the history, and dropped the section to `phase: 'loading'`, which renders
 * `null`. The section unmounted and remounted continuously, and everything below
 * it in the content body jumped up and back down each time.
 *
 * The component no longer keys off this identity (see `AttentionRequests`), so
 * the loop cannot come back through that door either. This cache is the other
 * half: every caller of a factory named `…FromSeam` reasonably assumes that the
 * same seam and space yield the same port, and now they do.
 *
 * A `WeakMap` on the seam is what keeps this from being a leak: a seam that goes
 * out of scope takes its ports with it. The inner key is the space id, because
 * one seam legitimately serves several spaces over its life.
 */
const PORTS = new WeakMap<Seam, Map<string, AttentionPort>>();

export function attentionPortFromSeam(seam: Seam, spaceId: SpaceId | string): AttentionPort {
  let bySpace = PORTS.get(seam);
  if (!bySpace) {
    bySpace = new Map();
    PORTS.set(seam, bySpace);
  }
  const cached = bySpace.get(String(spaceId));
  if (cached) return cached;
  const port = buildPort(seam, spaceId);
  bySpace.set(String(spaceId), port);
  return port;
}

function buildPort(seam: Seam, spaceId: SpaceId | string): AttentionPort {
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
