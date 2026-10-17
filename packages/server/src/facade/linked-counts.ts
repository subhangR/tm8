import type { EntityLinkedCounts } from '@tm8/contract';

/**
 * 327's five tile counts, from a row carrying `entity_counters`' columns —
 * the read path's row, the projector's row and a `counter.changed` payload
 * alike, so the three cannot disagree about the shape.
 *
 * SPREAD-WHEN-PRESENT, like 108's `docs`/`memories`: a row (or a durable
 * event captured before 327) without the columns omits `linked`, which the
 * contract reads as "never counted"; inventing zeros would claim emptiness.
 */
export function linkedCountsOf(row: Record<string, unknown>): { linked?: EntityLinkedCounts } {
  if (row['linked_docs'] === undefined) return {};
  const n = (key: string): number => Number(row[key] ?? 0);
  return {
    linked: {
      docs: n('linked_docs'),
      pullRequests: n('linked_pull_requests'),
      artifacts: n('linked_artifacts'),
      drawings: n('linked_drawings'),
      memories: n('linked_memories'),
    },
  };
}
