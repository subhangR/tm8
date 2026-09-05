/**
 * Event derivation and routing for session-to-session pulses.
 *
 * WHAT THIS DRAWS, AND WHAT IT DOES NOT CLAIM. Traffic from session A to
 * session B is animated as a travelling brightening of the tree's existing
 * hairlines: up A's ancestors to the nearest common ancestor, then down to B.
 *
 * That path is a LEGIBILITY CHOICE, not a claim about how the message
 * travelled. The tree is the SPAWN tree (entity `parentId`, migration 048);
 * the message graph is a different graph entirely, and A may message a cousin
 * or an unrelated root it never spawned. Routing along the wires that already
 * exist keeps the animation inside the structure the user is looking at,
 * instead of drawing a free arc that would imply a channel the tree does not
 * have. A pulse means "something went from A to B", never "it flowed through
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
import type { DurableWorkspaceEvent, EntitySummary, WorkSessionStatus } from '@tm8/contract';
import { getKind } from '../../domain';
import {
  SESSION_PULSE_KIND,
  type SessionPulseKind,
} from '../../session-graph/pulse-vocabulary';

export type { SessionPulseKind } from '../../session-graph/pulse-vocabulary';

interface PulseBase {
  /** Stable for one semantic arrival; corroborating events reuse this key. */
  key: string;
  kind: SessionPulseKind;
  fromId: string;
  toId: string;
}

/** A child session was born: responsibility moves parent -> child. */
export interface Delegation extends PulseBase {
  kind: typeof SESSION_PULSE_KIND.delegation;
  evidence: 'entity' | 'activity' | 'edge';
}

/** A child reached a terminal status: its result returns child -> parent. */
export interface Completion extends PulseBase {
  kind: typeof SESSION_PULSE_KIND.completion;
  outcome: Extract<WorkSessionStatus, 'exited' | 'failed'>;
}

/** The existing authored message arrival, unchanged apart from its kind tag. */
export interface SessionMessagePulse extends PulseBase {
  kind: typeof SESSION_PULSE_KIND.message;
}

export type SessionPulse = Delegation | Completion | SessionMessagePulse;

/**
 * The small projection needed to derive transitions. `lastSeqBySpace` makes
 * the function safe even when a test or alternate seam bypasses the real
 * connection's dedupe. Maps are read-only by contract; every reducer below
 * returns fresh ones rather than mutating its input.
 */
export interface SessionEventState {
  entities: ReadonlyMap<string, EntitySummary>;
  lastSeqBySpace: ReadonlyMap<string, number>;
  /** Prevent an activity/edge corroboration from replaying an entity pulse. */
  seenTransitions: ReadonlySet<string>;
}

export function createSessionEventState(
  entities: readonly EntitySummary[] = [],
): SessionEventState {
  return {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    lastSeqBySpace: new Map(),
    seenTransitions: new Set(),
  };
}

/** Merge summaries already held by the screen into the derivation snapshot. */
export function seedSessionEventState(
  prior: SessionEventState,
  entities: readonly EntitySummary[],
): SessionEventState {
  if (entities.length === 0) return prior;
  let changed = false;
  const next = new Map(prior.entities);
  for (const entity of entities) {
    const held = next.get(entity.id);
    const isFresher =
      held === undefined ||
      entity.version > held.version ||
      (entity.version === held.version && Date.parse(entity.updatedAt) > Date.parse(held.updatedAt));
    if (isFresher) {
      next.set(entity.id, entity);
      changed = true;
    }
  }
  return changed ? { ...prior, entities: next } : prior;
}

export function isFreshSessionEvent(
  event: DurableWorkspaceEvent,
  prior: SessionEventState,
): boolean {
  return event.seq > (prior.lastSeqBySpace.get(event.spaceId) ?? -1);
}

const SESSION_STATUSES: readonly WorkSessionStatus[] = [
  'spawning',
  'running',
  'idle',
  'exited',
  'failed',
];

function isSessionKind(kind: unknown): kind is string {
  return typeof kind === 'string' && getKind(kind).chip.tintBy === 'sessionStatus';
}

function statusOf(entity: EntitySummary | undefined): WorkSessionStatus | null {
  if (!entity || !isSessionKind(entity.kind)) return null;
  const status = (entity.state as unknown as { status?: unknown }).status;
  return typeof status === 'string' && SESSION_STATUSES.includes(status as WorkSessionStatus)
    ? status as WorkSessionStatus
    : null;
}

function delegationKey(childId: string): string {
  return `delegation:${childId}`;
}

function delegation(
  childId: string,
  parentId: string,
  evidence: Delegation['evidence'],
  prior: SessionEventState,
): Delegation | null {
  const key = delegationKey(childId);
  if (childId === parentId || prior.seenTransitions.has(key)) return null;
  return { key, kind: SESSION_PULSE_KIND.delegation, fromId: parentId, toId: childId, evidence };
}

/**
 * Derive the two event variants the closed server union intentionally lacks.
 *
 * The entity arm is authoritative: absence in the prior projection means a
 * child has just been born; a terminal status only counts when the prior
 * summary was non-terminal. The activity and `dispatched_by` arms are
 * corroboration/fallbacks for delivery order only. Neither is required to
 * arrive before the fully hydrated entity upsert.
 */
export function deriveSessionTransition(
  event: DurableWorkspaceEvent,
  prior: SessionEventState,
): Delegation | Completion | null {
  if (!isFreshSessionEvent(event, prior)) return null;

  if (event.type === 'entity.upsert' && statusOf(event.entity) !== null) {
    const current = event.entity;
    const previous = prior.entities.get(current.id);
    const parentId = current.parentId ?? previous?.parentId ?? null;

    if (previous === undefined && parentId !== null) {
      return delegation(current.id, parentId, 'entity', prior);
    }

    const before = statusOf(previous);
    const after = statusOf(current);
    if (
      parentId !== null &&
      before !== null &&
      before !== 'exited' &&
      before !== 'failed' &&
      (after === 'exited' || after === 'failed')
    ) {
      return {
        key: `completion:${current.id}:${event.seq}`,
        kind: SESSION_PULSE_KIND.completion,
        fromId: current.id,
        toId: parentId,
        outcome: after,
      };
    }
    return null;
  }

  if (event.type === 'activity.created' && event.activity.verb === 'created') {
    const childId = event.activity.entityId;
    const parentId = event.activity.summary.parentSessionId;
    const kind = event.activity.summary.kind;
    if (
      isSessionKind(kind) &&
      typeof childId === 'string' &&
      typeof parentId === 'string' &&
      parentId !== ''
    ) {
      return delegation(childId, parentId, 'activity', prior);
    }
  }

  if (event.type === 'edge.upsert' && event.edge.type === 'dispatched_by') {
    // Stored direction is spawned -> dispatcher; the visible act is the
    // inverse, dispatcher -> spawned.
    if (statusOf(event.edge.source) !== null && statusOf(event.edge.target) !== null) {
      return delegation(event.edge.source.id, event.edge.target.id, 'edge', prior);
    }
  }

  return null;
}

/** Advance the immutable projection after (and only after) deriving from it. */
export function advanceSessionEventState(
  prior: SessionEventState,
  event: DurableWorkspaceEvent,
  derived: Delegation | Completion | null = null,
): SessionEventState {
  if (!isFreshSessionEvent(event, prior)) return prior;

  const lastSeqBySpace = new Map(prior.lastSeqBySpace);
  lastSeqBySpace.set(event.spaceId, event.seq);
  let entities = prior.entities;

  if (event.type === 'entity.upsert' || event.type === 'entity.deleted') {
    entities = new Map(prior.entities).set(event.entity.id, event.entity);
  } else if (event.type === 'edge.upsert' || event.type === 'edge.deleted') {
    const next = new Map(prior.entities);
    next.set(event.edge.source.id, event.edge.source);
    next.set(event.edge.target.id, event.edge.target);
    entities = next;
  }

  let seenTransitions = prior.seenTransitions;
  if (derived !== null) {
    const next = new Set(prior.seenTransitions);
    next.add(derived.key);
    seenTransitions = next;
  }

  return { entities, lastSeqBySpace, seenTransitions };
}

/** Turn a fresh event into any of the three visual pulse variants. */
export function pulseFromEvent(
  event: DurableWorkspaceEvent,
  prior: SessionEventState,
): SessionPulse | null {
  const transition = deriveSessionTransition(event, prior);
  if (transition !== null) return transition;
  if (!isFreshSessionEvent(event, prior) || event.type !== 'message.created') return null;

  const fromId = event.sourceWorkSessionId;
  const toId = event.anchorId;
  if (typeof fromId !== 'string' || fromId === '' || fromId === toId) return null;
  return { key: event.message.id, kind: SESSION_PULSE_KIND.message, fromId, toId };
}

/** Pure oldest-first cap used by every surface that retains live pulses. */
export function appendBoundedPulse(
  current: readonly SessionPulse[],
  pulse: SessionPulse,
  cap: number,
): readonly SessionPulse[] {
  if (cap <= 0) return [];
  const withoutDuplicate = current.filter((item) => item.key !== pulse.key);
  return [...withoutDuplicate, pulse].slice(-cap);
}

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

/** One exact edge traversal, used by the SVG graph rather than a CSS wire. */
export interface PulseStep {
  fromId: string;
  toId: string;
}

export interface PulsePathRoute {
  steps: readonly PulseStep[];
  fromRowId: string | null;
  toRowId: string | null;
  absorbed: boolean;
}

export interface PulseTreeIndex {
  /** Parent within the RENDERED tree — null for a root, undefined if absent. */
  parentOf: (id: string) => string | null | undefined;
  /** True when the row is currently on screen (no collapsed ancestor). */
  isVisible: (id: string) => boolean;
}

const EMPTY_PATH: PulsePathRoute = {
  steps: [],
  fromRowId: null,
  toRowId: null,
  absorbed: false,
};

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
 * Exact edge steps for one pulse, in the order they should light.
 *
 * Returns an empty route when there is nothing honest to draw — an endpoint
 * outside this tree, or a self-message. When both endpoints collapse into the
 * SAME visible ancestor the route is also empty of segments but still names
 * that row, so the caller glows it once rather than animating a wire from a
 * node to itself.
 */
export function routePulsePath(fromId: string, toId: string, index: PulseTreeIndex): PulsePathRoute {
  if (fromId === toId) return EMPTY_PATH;

  const from = visibleStandIn(fromId, index);
  const to = visibleStandIn(toId, index);

  // Only one end is in this tree: there is no path, but the arrival is still
  // real and worth showing. Glow the end we have.
  if (from === null || to === null) {
    if (from === null && to === null) return EMPTY_PATH;
    return {
      steps: [],
      fromRowId: from?.id ?? null,
      toRowId: to?.id ?? null,
      absorbed: (from?.absorbed ?? false) || (to?.absorbed ?? false),
    };
  }

  const absorbed = from.absorbed || to.absorbed;
  if (from.id === to.id) {
    return { steps: [], fromRowId: from.id, toRowId: to.id, absorbed };
  }

  const fromChain = chainToRoot(from.id, index);
  const toChain = chainToRoot(to.id, index);
  const toDepthOf = new Map(toChain.map((id, depth) => [id, depth]));

  // Lowest common ancestor: the first node on the sender's way up that the
  // target also sits under. Absent when the two live under different roots —
  // sessions spawned by nobody are separate trees, and that is common.
  const lca = fromChain.find((id) => toDepthOf.has(id)) ?? null;

  const ascendEnd = lca === null ? fromChain.length : fromChain.indexOf(lca);
  const steps: PulseStep[] = [];
  for (let i = 0; i < ascendEnd; i += 1) {
    const owner = index.parentOf(fromChain[i]);
    if (typeof owner === 'string') steps.push({ fromId: fromChain[i]!, toId: owner });
  }

  // The descent is built from the target upward and then reversed, so the
  // pulse arrives AT the target last.
  const descendEnd = lca === null ? toChain.length : (toDepthOf.get(lca) ?? 0);
  const descent: PulseStep[] = [];
  for (let i = 0; i < descendEnd; i += 1) {
    const owner = index.parentOf(toChain[i]);
    if (typeof owner === 'string') descent.push({ fromId: owner, toId: toChain[i]! });
  }
  descent.reverse();

  steps.push(...descent);
  return { steps, fromRowId: from.id, toRowId: to.id, absorbed };
}

/**
 * CSS tree routing keeps one segment per OWNER wire. Exact graph traversal is
 * available above; this adapter preserves the original public API and the
 * shared-wire de-duplication that makes sibling traffic read cleanly.
 */
export function routeMessagePulse(fromId: string, toId: string, index: PulseTreeIndex): PulseRoute {
  const path = routePulsePath(fromId, toId, index);
  const segments: PulseSegment[] = [];
  const seen = new Set<string>();

  // A node whose wire carries both legs (the turn at the common ancestor, or a
  // shared level between separate roots) must not be emitted twice — the
  // second copy would restart the animation mid-flight and read as a stutter.
  for (const step of path.steps) {
    const goingUp = index.parentOf(step.fromId) === step.toId;
    const ownerId = goingUp ? step.toId : step.fromId;
    if (!seen.has(ownerId)) {
      seen.add(ownerId);
      segments.push({ ownerId, direction: goingUp ? 'up' : 'down' });
    }
  }

  return {
    segments,
    fromRowId: path.fromRowId,
    toRowId: path.toRowId,
    absorbed: path.absorbed,
  };
}
