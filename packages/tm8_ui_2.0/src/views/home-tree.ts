/**
 * R6's ONE DEFINITION of "in the tree" (task 01a00932, LLD §4.3).
 *
 * A click inside Home's centre panel navigates IN PLACE only when the target
 * sits in the centre ROOT's own hierarchy — its parent chain, walked through
 * the host's detail cache, reaches the trail's root. Everything else (a
 * different kind, the same kind outside the tree, or a chain the cache
 * cannot walk yet) opens BESIDE the centre: sideways is the reversible
 * default, silently re-rooting the centre is not.
 *
 * Pure, so the decision table is exhaustively testable: the cache is a
 * `parentOf` function, and the walk is depth-capped — a parent CYCLE is
 * corrupt data, not a reason to hang the click.
 */
import type { EntityId } from '@tm8/contract';

const MAX_TREE_DEPTH = 32;

export function inTreeOf(
  rootId: EntityId | null,
  id: EntityId,
  parentOf: (id: EntityId) => EntityId | null,
): boolean {
  if (!rootId) return false;
  let cursor: EntityId | null = id;
  for (let depth = 0; cursor && depth < MAX_TREE_DEPTH; depth += 1) {
    if (cursor === rootId) return true;
    cursor = parentOf(cursor);
  }
  return false;
}
