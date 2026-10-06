import type { EntitySummary } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import type { ListRowFacts } from './types';
import { getKind } from './registry';
import { isSessionState } from './session-outcome';

/**
 * THE ONE PLACE "does this entity need a human" is decided, for PRESENTATION.
 *
 * NOT THE ATTENTION MODULE. Chips, counts, the banner and every resolve read
 * `src/attention/` (Attention v2, chapter 5). This predicate only feeds the
 * session pill and the list's needs-attention group.
 *
 * WHY IT IS A MODULE. The predicate itself lives in the registry
 * (`KindConfig.list.needsAttentionGroup`) because it is per-kind knowledge, and
 * L2 forbids a component branching on kind. But it was only ever *evaluated* in
 * one place — the list panel's `attentionIdsOf` — so a detail panel that wanted
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
    // Spec D1: the session predicate reads the outcome and the ending.
    ...(isSessionState(row.state) ? { sessionState: row.state } : {}),
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
