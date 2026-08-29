/**
 * THE READ POLICY for the session graph — how many `entities.connections`
 * calls, on which nodes, and what happens when one of them fails.
 *
 * ONE READ PER NODE, BREADTH FIRST. `entities.connections` answers "every edge
 * on this entity" exactly and without the 200-row candidate slice that makes
 * `graph.query` under-report a busy session's own messages by fifty to one
 * (measured; see `model.ts`). The cost is a call per expanded node, so the
 * expansion set is deliberately small and deliberately the SAME set the canvas
 * will draw unfolded — reading a hundred messages the model is about to fold
 * into one cell would buy a number we already have from the fold.
 *
 * PARTIAL IS NORMAL, AND SAYS SO. Neighbour reads run settled, never all-or-
 * nothing: one 403 on one linked entity must not blank a graph that is
 * otherwise complete. A node whose edges were not read has `degree: null` in
 * the model and the canvas draws its branch as ENDING, not as a leaf. The
 * returned `failed` count is what the surface prints so a thin graph is never
 * mistaken for a quiet session.
 */
import type { EdgeView, EntityId, Page } from '@tm8/contract';
import { HUB_DEGREE, expandableFrom } from './model';

/** The focus's own edges. A busy session measured 103; 200 clears it in one page. */
const FOCUS_LIMIT = 200;
/** A neighbour only needs enough to place its own branch and know its degree. */
const NEIGHBOUR_LIMIT = 60;
/**
 * Nodes expanded per hop. Falls with depth: the second ring is where the
 * viewer's attention is, the third is context. Twelve and six keep the whole
 * graph inside ~19 reads at the maximum depth.
 */
const EXPAND_BUDGET: readonly number[] = [12, 6];

export type ConnectionsReader = (
  id: EntityId,
  opts?: { limit?: number },
) => Promise<Page<EdgeView>>;

export interface LoadInput {
  read: ConnectionsReader;
  focusId: EntityId;
  hops: number;
  openFolds?: ReadonlySet<string>;
  /** Set by the caller when the surface unmounts or the focus changes. */
  cancelled?: () => boolean;
}

export interface LoadResult {
  edgesByNode: Map<string, EdgeView[]>;
  /** Neighbour reads that failed; their branches end early on the canvas. */
  failed: number;
  /** The focus holds more edges than one page returned. */
  focusPaged: boolean;
}

export async function loadSessionGraph(input: LoadInput): Promise<LoadResult> {
  const { read, focusId, hops } = input;
  const openFolds = input.openFolds ?? new Set<string>();
  const cancelled = input.cancelled ?? (() => false);

  const edgesByNode = new Map<string, EdgeView[]>();
  let failed = 0;

  // The focus read is the one that must succeed — without it there is no graph,
  // so its rejection propagates and the surface renders an error, not an empty
  // canvas that would read as "this session did nothing".
  const focusPage = await read(focusId, { limit: FOCUS_LIMIT });
  edgesByNode.set(focusId, focusPage.items);
  const focusPaged = focusPage.nextCursor !== null;

  let frontier: string[] = [focusId];
  for (let hop = 1; hop < hops && !cancelled(); hop += 1) {
    const budget = EXPAND_BUDGET[hop - 1] ?? 0;
    if (budget === 0) break;

    const candidates: string[] = [];
    for (const parentId of frontier) {
      const edges = edgesByNode.get(parentId);
      if (!edges) continue;
      // A hub is a landmark, not a corridor — the model draws nothing through
      // one, so reading its neighbours would spend the budget on cells that can
      // never appear. The focus is exempt: a busy session is itself well over
      // the threshold, and it is the one node this graph exists to expand.
      if (parentId !== focusId && edges.length > HUB_DEGREE) continue;
      for (const id of expandableFrom(parentId, edges, openFolds)) {
        if (edgesByNode.has(id) || candidates.includes(id)) continue;
        candidates.push(id);
      }
    }
    const take = candidates.slice(0, budget);
    if (take.length === 0) break;

    const pages = await Promise.allSettled(
      take.map((id) => read(id as EntityId, { limit: NEIGHBOUR_LIMIT })),
    );
    if (cancelled()) break;
    const next: string[] = [];
    for (const [index, result] of pages.entries()) {
      const id = take[index]!;
      if (result.status === 'rejected') {
        failed += 1;
        continue;
      }
      edgesByNode.set(id, result.value.items);
      next.push(id);
    }
    frontier = next;
  }

  return { edgesByNode, failed, focusPaged };
}
