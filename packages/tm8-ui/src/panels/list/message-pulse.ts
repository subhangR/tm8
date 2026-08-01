/**
 * Routing for the session-tree message pulse.
 *
 * WHAT THIS DRAWS, AND WHAT IT DOES NOT CLAIM. A message from session A to
 * session B is animated as a travelling brightening of the tree's existing
 * hairlines: up A's ancestors to the nearest common ancestor, then down to B.
 *
 * That path is a LEGIBILITY CHOICE, not a claim about how the message
 * travelled. The tree is the SPAWN tree (entity `parentId`, migration 048);
 * the message graph is a different graph entirely, and A may message a cousin
 * or an unrelated root it never spawned. Routing along the wires that already
 * exist keeps the animation inside the structure the user is looking at,
 * instead of drawing a free arc that would imply a channel the tree does not
 * have. A pulse means "a message went from A to B", never "it flowed through
 * the sessions in between".
 *
 * THE WIRE IS A PARENT'S PROPERTY. There is one hairline per nesting level —
 * the `border-left` on `.lp__children` (panels.css:1249) — and it belongs to
 * the node whose children that wrapper holds. So a step from a node to its
 * parent lights the PARENT's wrapper, which is why every segment below is
 * keyed by `parentOf(node)` rather than by the node itself.
 *
 * HIDDEN ENDPOINTS ARE ABSORBED, NEVER CHASED. If an endpoint is inside a
 * collapsed subtree, the route stops at its nearest visible ancestor and that
 * row takes the glow — "traffic inside". Nothing auto-expands and nothing
 * scrolls: a tree that rearranges itself under the cursor because a background
 * agent sent a message is worse than a pulse you did not see.
 */

/** One nesting level's hairline, lit in travel order. */
export interface PulseSegment {
  /** The node whose `.lp__children` wrapper draws this wire. */
  ownerId: string;
  /** Ascending toward the common ancestor, or descending toward the target. */
  direction: 'up' | 'down';
}

export interface PulseRoute {
  segments: readonly PulseSegment[];
  /** Visible row the pulse leaves — the sender, or the ancestor absorbing it. */
  fromRowId: string | null;
  /** Visible row the pulse arrives at — the target, or its absorbing ancestor. */
  toRowId: string | null;
  /** An endpoint was collapsed away, so a stand-in ancestor is glowing instead. */
  absorbed: boolean;
}

export interface PulseTreeIndex {
  /** Parent within the RENDERED tree — null for a root, undefined if absent. */
  parentOf: (id: string) => string | null | undefined;
  /** True when the row is currently on screen (no collapsed ancestor). */
  isVisible: (id: string) => boolean;
}

const EMPTY: PulseRoute = { segments: [], fromRowId: null, toRowId: null, absorbed: false };

/**
 * The nearest ancestor-or-self that is actually rendered. Returns null when the
 * id is not in this tree at all, which is the ordinary case for a message whose
 * far end lives in another space, another list page, or no list at all.
 */
function visibleStandIn(id: string, index: PulseTreeIndex): { id: string; absorbed: boolean } | null {
  let cursor: string | null | undefined = id;
  let absorbed = false;
  const guard = new Set<string>();
  while (typeof cursor === 'string') {
    if (guard.has(cursor)) return null; // malformed parent cycle — refuse to spin
    guard.add(cursor);
    if (index.isVisible(cursor)) return { id: cursor, absorbed };
    absorbed = true;
    cursor = index.parentOf(cursor);
  }
  return null;
}

/** Ancestor chain from a node up to its root, the node itself first. */
function chainToRoot(id: string, index: PulseTreeIndex): string[] {
  const chain: string[] = [];
  let cursor: string | null | undefined = id;
  const guard = new Set<string>();
  while (typeof cursor === 'string' && !guard.has(cursor)) {
    guard.add(cursor);
    chain.push(cursor);
    cursor = index.parentOf(cursor);
  }
  return chain;
}

/**
 * Segments for one message, in the order they should light.
 *
 * Returns an empty route when there is nothing honest to draw — an endpoint
 * outside this tree, or a self-message. When both endpoints collapse into the
 * SAME visible ancestor the route is also empty of segments but still names
 * that row, so the caller glows it once rather than animating a wire from a
 * node to itself.
 */
export function routeMessagePulse(fromId: string, toId: string, index: PulseTreeIndex): PulseRoute {
  if (fromId === toId) return EMPTY;

  const from = visibleStandIn(fromId, index);
  const to = visibleStandIn(toId, index);

  // Only one end is in this tree: there is no path, but the arrival is still
  // real and worth showing. Glow the end we have.
  if (from === null || to === null) {
    if (from === null && to === null) return EMPTY;
    return {
      segments: [],
      fromRowId: from?.id ?? null,
      toRowId: to?.id ?? null,
      absorbed: (from?.absorbed ?? false) || (to?.absorbed ?? false),
    };
  }

  const absorbed = from.absorbed || to.absorbed;
  if (from.id === to.id) {
    return { segments: [], fromRowId: from.id, toRowId: to.id, absorbed };
  }

  const fromChain = chainToRoot(from.id, index);
  const toChain = chainToRoot(to.id, index);
  const toDepthOf = new Map(toChain.map((id, depth) => [id, depth]));

  // Lowest common ancestor: the first node on the sender's way up that the
  // target also sits under. Absent when the two live under different roots —
  // sessions spawned by nobody are separate trees, and that is common.
  const lca = fromChain.find((id) => toDepthOf.has(id)) ?? null;

  const ascendEnd = lca === null ? fromChain.length : fromChain.indexOf(lca);
  const segments: PulseSegment[] = [];
  for (let i = 0; i < ascendEnd; i += 1) {
    const owner = index.parentOf(fromChain[i]);
    if (typeof owner === 'string') segments.push({ ownerId: owner, direction: 'up' });
  }

  // The descent is built from the target upward and then reversed, so the
  // pulse arrives AT the target last.
  const descendEnd = lca === null ? toChain.length : (toDepthOf.get(lca) ?? 0);
  const descent: PulseSegment[] = [];
  for (let i = 0; i < descendEnd; i += 1) {
    const owner = index.parentOf(toChain[i]);
    if (typeof owner === 'string') descent.push({ ownerId: owner, direction: 'down' });
  }
  descent.reverse();

  // A node whose wire carries both legs (the turn at the common ancestor, or a
  // shared level between separate roots) must not be emitted twice — the
  // second copy would restart the animation mid-flight and read as a stutter.
  const seen = new Set(segments.map((segment) => segment.ownerId));
  for (const segment of descent) {
    if (!seen.has(segment.ownerId)) {
      seen.add(segment.ownerId);
      segments.push(segment);
    }
  }

  return { segments, fromRowId: from.id, toRowId: to.id, absorbed };
}
