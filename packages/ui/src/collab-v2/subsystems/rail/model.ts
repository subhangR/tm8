/**
 * Rail model — the pure, DOM-free half of the Connections rail: edge-type
 * vocabulary, group keys/previews, resolution-badge derivation, blocked
 * rollups and hierarchy reorder math. Everything here is unit-testable
 * without React, and nothing here branches on entity KIND (kinds are data —
 * the registry owns them).
 */
import type {
  Connections, EdgeGroup, EdgeView, EntityId, EntitySummary,
} from '../../types/contract';

/** How many items of a group render before the "show all" affordance. */
export const GROUP_PREVIEW = 8;

/** Types the inline composer offers. Anything else must be namespaced `x:*`. */
export const RAIL_EDGE_TYPES: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'relates_to', label: 'Related' },
  { type: 'depends_on', label: 'Depends on' },
  { type: 'attached_to', label: 'Attached' },
  { type: 'tracks', label: 'Tracks' },
  { type: 'assigned_to', label: 'Assigned to' },
  { type: 'equips', label: 'Equips' },
  { type: 'copy_of', label: 'Copy of' },
];

/** Sentinel value of the composer's type select for a custom `x:*` type. */
export const CUSTOM_TYPE = '__custom__';

/**
 * Display label for an edge type. Groups arrive labelled by the facade; this
 * is the fallback for the composer and for `x:*` types the server never
 * registered (rendered as-is, just prettified).
 */
export function railEdgeLabel(type: string): string {
  const known = RAIL_EDGE_TYPES.find((t) => t.type === type);
  if (known) return known.label;
  const bare = type.startsWith('x:') ? type.slice(2) : type;
  return bare.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Stable identity for a group across refetches (type + direction). */
export const groupKey = (g: Pick<EdgeGroup, 'type' | 'direction'>): string =>
  `${g.direction}:${g.type}`;

/** The entity on the OTHER end of an edge, from this rail's viewpoint. */
export function otherEnd(edge: EdgeView, direction: EdgeGroup['direction']): EntitySummary {
  return direction === 'outgoing' ? edge.target : edge.source;
}

export interface ResolutionBadge {
  /** HARD (blocking) or SOFT (advisory) — only depends_on carries this. */
  strength: 'HARD' | 'SOFT';
  resolved: boolean;
  label: string;
  /** True when this single item is what's blocking the entity. */
  blocking: boolean;
}

/**
 * Per-item resolution badge. `hard` is only present on dependency edges, so
 * every other edge type renders no badge at all.
 */
export function resolutionBadge(edge: EdgeView): ResolutionBadge | null {
  if (edge.hard == null) return null;
  const strength = edge.hard ? 'HARD' : 'SOFT';
  const resolved = edge.resolved === true;
  return {
    strength,
    resolved,
    label: `${strength} ${resolved ? '✓' : '⚠'}`,
    blocking: edge.hard === true && !resolved,
  };
}

/** How many items in a group are unresolved hard dependencies (group rollup). */
export function unresolvedCount(group: EdgeGroup): number {
  return group.edges.filter((e) => resolutionBadge(e)?.blocking).length;
}

/**
 * The entities this one is waiting on. Prefers the server-computed badge
 * (`badges.blocked.waitingOn`) and falls back to deriving it from the
 * outgoing dependency edges — the rail must show the rollup even when it is
 * mounted on a summary that carries no badges (nested-summary recursion
 * guard leaves them empty).
 */
export function waitingOn(
  connections: Connections,
  fromBadge?: EntitySummary[],
): EntitySummary[] {
  if (fromBadge && fromBadge.length > 0) return fromBadge;
  const out: EntitySummary[] = [];
  const seen = new Set<EntityId>();
  for (const group of connections.outgoing) {
    for (const edge of group.edges) {
      if (!resolutionBadge(edge)?.blocking) continue;
      const other = otherEnd(edge, group.direction);
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      out.push(other);
    }
  }
  return out;
}

/** Groups in render order: outgoing first, each side sorted by size desc. */
export function orderedGroups(connections: Connections): EdgeGroup[] {
  const bySize = (a: EdgeGroup, b: EdgeGroup): number =>
    unresolvedCount(b) - unresolvedCount(a)
    || b.edges.length - a.edges.length
    || a.label.localeCompare(b.label);
  return [
    ...[...connections.outgoing].sort(bySize),
    ...[...connections.incoming].sort(bySize),
  ].filter((g) => g.edges.length > 0);
}

/** Fractional position between two neighbours — order-preserving reorders. */
export function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 0;
  if (before == null) return (after as number) - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

export interface ReorderPlan {
  childId: EntityId;
  fromIndex: number;
  toIndex: number;
  /** New `position` to send to `moveEntity`. */
  position: number;
  /** The sibling the child now sits before (null = last). */
  beforeId: EntityId | null;
}

/**
 * Reorder math for the hierarchy list. Returns null at the ends (no-op), so
 * callers can disable the control without duplicating the bounds logic.
 */
export function planReorder(
  children: EntitySummary[],
  index: number,
  direction: 'up' | 'down',
): ReorderPlan | null {
  const child = children[index];
  if (!child) return null;
  const toIndex = direction === 'up' ? index - 1 : index + 1;
  if (toIndex < 0 || toIndex >= children.length) return null;
  // Neighbours of the destination slot, ignoring the moving child.
  const rest = children.filter((_, i) => i !== index);
  const before = toIndex > 0 ? rest[toIndex - 1] ?? null : null;
  const after = rest[toIndex] ?? null;
  return {
    childId: child.id,
    fromIndex: index,
    toIndex,
    position: positionBetween(before ? before.position : null, after ? after.position : null),
    beforeId: after ? after.id : null,
  };
}

/** Source/target for a new edge, honouring the group's direction. */
export function edgeEndpoints(
  entityId: EntityId,
  otherId: EntityId,
  direction: EdgeGroup['direction'],
): { srcId: EntityId; dstId: EntityId } {
  return direction === 'outgoing'
    ? { srcId: entityId, dstId: otherId }
    : { srcId: otherId, dstId: entityId };
}

let mutationSeq = 0;
/** Per-mutation idempotency key (the contract honours it on every command). */
export const newMutationId = (): string => `cv2-rail-${++mutationSeq}-${Math.random().toString(36).slice(2, 8)}`;
