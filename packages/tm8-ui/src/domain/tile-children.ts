import type { EntitySummary } from '@tm8/contract';

/**
 * HOW MANY CHILDREN A LIST ROW HAS — the number its lead-icon subscript draws
 * (task 01a14b92, one rule for every tree kind).
 *
 * The tree on screen is built from the rows that happen to be loaded: one
 * page, one status tab. Counting those (what the `▸ N` chip did) made a task
 * with six subtasks say `1` because five sat on other tabs. The server's
 * count is the truth; the loaded count is only a floor, used when a node too
 * old to send one answers.
 *
 * WHICH COUNT, BY HOW THE ROW NESTS — the same split `treeParentOf` makes.
 * A launcher (a chat, a session) nests the sessions it LAUNCHED, which is the
 * `sessions` counter (`launched_by`, 330/331); its `parent_id` children are
 * tool runs no list draws. Every other tree kind nests by `parent_id`, which
 * is `childCount` (or a doc's older `state.childCount`).
 */
export function tileChildCount(
  row: Pick<EntitySummary, 'childCount' | 'counters' | 'state'>,
  loaded: number,
  nestsLaunched: boolean,
): number {
  const server = nestsLaunched ? row.counters.sessions : (row.childCount ?? docChildCount(row.state));
  return typeof server === 'number' && Number.isFinite(server) ? Math.max(server, loaded) : loaded;
}

function docChildCount(state: EntitySummary['state']): number | undefined {
  return state.kind === 'doc' ? state.childCount : undefined;
}
