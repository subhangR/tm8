/**
 * ONE ENTITY'S ATTENTION HISTORY — the arithmetic and the ordering, with no
 * React in it, so both are testable without a DOM.
 *
 * This is the counterpart to `attention-model.ts`. That one collapses the
 * space-wide queue DOWN to one row per entity for the inbox; this one expands
 * a single entity's rows OUT into the full record of everything that was ever
 * escalated on it. Same table, opposite direction, so they are deliberately
 * separate modules rather than one file with a mode flag.
 *
 * THE ORDERING IS NOT THE SERVER'S, and that is the point. The server answers
 * `points desc, createdAt asc, id asc` because it is feeding a TRIAGE queue,
 * where the loudest thing across the whole space belongs at the top. A history
 * is read as a story about one entity: unsettled work first, because it is the
 * only part you can still act on, and then newest-first, because that is how
 * every other history in this product reads.
 */
import type { AttentionRequest, AttentionRequestStatus } from '@tm8/contract';
import { relTime } from '../kit/time';

/** `open` and `acknowledged` are the two the server's badge counts. */
export function isPending(row: AttentionRequest): boolean {
  return row.status === 'open' || row.status === 'acknowledged';
}

/**
 * What the section's eyebrow states. `pendingCount`/`pendingPoints` mirror the
 * badge; `total` is the whole record, which the badge deliberately never shows.
 */
export interface AttentionHistorySummary {
  total: number;
  pendingCount: number;
  pendingPoints: number;
  /** Loudest PENDING row, or 0 when nothing is pending. */
  maxPendingPoints: number;
  settledCount: number;
}

export function summarizeHistory(rows: readonly AttentionRequest[]): AttentionHistorySummary {
  const pending = rows.filter(isPending);
  return {
    total: rows.length,
    pendingCount: pending.length,
    pendingPoints: pending.reduce((sum, r) => sum + r.points, 0),
    maxPendingPoints: pending.length === 0 ? 0 : Math.max(...pending.map((r) => r.points)),
    settledCount: rows.length - pending.length,
  };
}

/**
 * Pending first, then newest-first within each group. `id` is the final tie-
 * break so the list can never reorder between renders on equal input — two
 * rows created in the same second is the ordinary case here, not a corner one,
 * because a bulk resolve stamps them all at once.
 */
export function orderHistory(rows: readonly AttentionRequest[]): AttentionRequest[] {
  return [...rows].sort((a, b) => {
    const pendingDelta = Number(isPending(b)) - Number(isPending(a));
    if (pendingDelta !== 0) return pendingDelta;
    return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });
}

/**
 * The word shown on a row's status chip.
 *
 * `dismissed` is spelled DECLINED rather than "dismissed" because the two
 * settled states must not read as synonyms: resolved means the thing was dealt
 * with, declined means somebody looked and decided it did not need doing. A
 * history where those blur is a history that cannot answer "why is this still
 * happening" — and until this section shipped, `dismissed` had no UI path at
 * all, so nobody had ever had to name it.
 */
export const STATUS_LABEL: Readonly<Record<AttentionRequestStatus, string>> = {
  open: 'Waiting',
  acknowledged: 'Seen',
  resolved: 'Resolved',
  dismissed: 'Declined',
};

/**
 * Who settled a row and when, as one sentence — or null while it is pending,
 * where there is no such fact and a placeholder would invent one.
 *
 * Reads `acknowledged*` for the seen state and `resolved*` for both settled
 * states, matching how the RPC stamps them (migration 050:148-167).
 */
export function settlementLine(row: AttentionRequest, now?: string): string | null {
  if (row.status === 'open') return null;
  if (row.status === 'acknowledged') {
    const who = row.acknowledgedBy?.displayName;
    const when = row.acknowledgedAt;
    if (!who && !when) return 'Seen';
    return `Seen by ${who ?? 'someone'}${when ? ` · ${relTime(when, now ? Date.parse(now) : undefined)}` : ''}`;
  }
  const verb = row.status === 'resolved' ? 'Resolved' : 'Declined';
  const who = row.resolvedBy?.displayName;
  const when = row.resolvedAt;
  if (!who && !when) return verb;
  return `${verb} by ${who ?? 'someone'}${when ? ` · ${relTime(when, now ? Date.parse(now) : undefined)}` : ''}`;
}
