/**
 * Grouping the space-wide attention queue into ONE ROW PER ENTITY.
 *
 * The server's list op returns one row per *request*; the screen shows one row
 * per *entity* with its requests combined. The arithmetic here is deliberately
 * the same as the server's own badge aggregate
 * (`server/src/facade/entity-read.ts` — count / sum(points) / max(points) /
 * latest reason / oldest createdAt), so a grouped row and that entity's
 * `badges.attention` agree. If they ever diverge, this is the copy that is
 * wrong: the badge is computed in SQL over the full table, while this sees only
 * the page it was handed.
 */
import type { ActorSummary, AttentionRequest, EntityId } from '@tm8/contract';

/** One entity's combined attention, shaped like `EntityAttentionSummary`. */
export interface AttentionEntityGroup {
  entityId: EntityId;
  /** How many requests were combined into this row. */
  pendingCount: number;
  /** The number the row is ranked by. */
  totalPoints: number;
  /** The single loudest request. */
  maxPoints: number;
  /** Reason of the most recently created request. */
  latestReason: string;
  /** Requester paired with latestReason; never inferred from another row. */
  latestRequester: ActorSummary;
  /** When the entity FIRST started waiting — the honest age of the wait. */
  oldestRequestedAt: string;
}

/**
 * Group by entity, then rank. Ordering is total points desc (the loudest first),
 * ties broken by who has waited longest, then by id so the list never reorders
 * between renders on equal input.
 */
export function groupAttentionByEntity(
  rows: readonly AttentionRequest[],
): AttentionEntityGroup[] {
  /** `latestAt` is bookkeeping for picking `latestReason`; it is not output. */
  const byEntity = new Map<EntityId, AttentionEntityGroup & { latestAt: string }>();

  for (const row of rows) {
    const existing = byEntity.get(row.entityId);
    if (!existing) {
      byEntity.set(row.entityId, {
        entityId: row.entityId,
        pendingCount: 1,
        totalPoints: row.points,
        maxPoints: row.points,
        latestReason: row.reason,
        latestRequester: row.requestedBy,
        oldestRequestedAt: row.createdAt,
        latestAt: row.createdAt,
      });
      continue;
    }
    existing.pendingCount += 1;
    existing.totalPoints += row.points;
    if (row.points > existing.maxPoints) existing.maxPoints = row.points;
    // Strictly-later wins, so an equal timestamp keeps the first reason seen
    // rather than flipping with input order.
    if (row.createdAt > existing.latestAt) {
      existing.latestAt = row.createdAt;
      existing.latestReason = row.reason;
      existing.latestRequester = row.requestedBy;
    }
    if (row.createdAt < existing.oldestRequestedAt) existing.oldestRequestedAt = row.createdAt;
  }

  return [...byEntity.values()]
    .map(({ latestAt: _latestAt, ...group }) => group)
    .sort((a, b) => b.totalPoints - a.totalPoints
      || a.oldestRequestedAt.localeCompare(b.oldestRequestedAt)
      || a.entityId.localeCompare(b.entityId));
}
