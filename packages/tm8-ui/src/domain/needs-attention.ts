import type { EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type { ListRowFacts } from './types';
import { getKind } from './registry';

/**
 * THE ONE PLACE "does this entity need a human" is decided.
 *
 * WHY IT IS A MODULE. The predicate itself lives in the registry
 * (`KindConfig.list.needsAttentionGroup`) because it is per-kind knowledge, and
 * L2 forbids a component branching on kind. But it was only ever *evaluated* in
 * one place — the list panel's `splitAttention` — so a detail panel that wanted
 * the same answer had no way to get it except by re-deriving it, and a
 * re-derivation is a second implementation that drifts. The list saying "needs
 * you" while the open session says nothing is exactly the terminal/chat
 * disagreement this work exists to remove, so the evaluation is shared here
 * rather than duplicated.
 *
 * The predicate consumes the seam's liveness verdict and the row's own recorded
 * status. It derives NEITHER — R-UI-5 keeps liveness classification seam-owned,
 * and D6 names inferring activity from `activityAt` recency as a forbidden
 * inference.
 */

/**
 * The narrow fact subset a row predicate may read. Deliberately not the whole
 * `EntitySummary`: a predicate that wants more is asking to derive something the
 * seam owns.
 */
export function toRowFacts(row: EntitySummary): ListRowFacts {
  const state = row.state as unknown as Record<string, unknown>;
  return {
    id: row.id,
    kind: row.kind,
    activityAt: row.activityAt,
    status: typeof state.status === 'string' ? state.status : null,
    blockedCount: row.badges.blocked?.unresolvedHardDependencyCount ?? 0,
  };
}

/**
 * Whether this entity is asking for a human right now.
 *
 * Two independent sources, OR'd, because they answer the same question from
 * different directions and either alone would miss cases:
 *   · `badges.attention` — a durable, server-side attention request someone
 *     explicitly raised.
 *   · the kind's own predicate — a derived, live verdict (for a work_session:
 *     alive, and its recorded status is `idle`).
 *
 * Returns false with no liveness resolver rather than guessing: without a
 * verdict the derived half cannot be evaluated, and a fabricated "needs you" is
 * worse than a missing one.
 */
export function needsAttentionOf(
  row: EntitySummary,
  livenessOf?: (id: string) => SessionLiveness,
): boolean {
  if (row.badges.attention) return true;
  const predicate = getKind(row.kind).list.needsAttentionGroup;
  if (!predicate || !livenessOf) return false;
  return predicate(toRowFacts(row), livenessOf(row.id));
}

/**
 * The banner/aria sentence for a derived block.
 *
 * STATES ONLY WHAT WAS MEASURED. The detector behind `status === 'idle'` reports
 * that a live PTY stopped producing output for its quiescence threshold — it
 * does not know whether an agent is waiting on a permission, waiting on a
 * question, or running a long silent command. So this sentence says the agent
 * has gone quiet and points at the terminal, and it never invents a question to
 * put in the banner. When a structured signal exists, it supplies its own detail
 * and this fallback is not used.
 */
export const QUIET_SESSION_DETAIL =
  'no terminal output for a while — it may be waiting for you. Open the terminal to see.';
