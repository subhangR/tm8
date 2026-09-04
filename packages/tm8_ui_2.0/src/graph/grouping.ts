/**
 * Contextual grouping — the SIGNALS the graph payload already carries, turned
 * into a partition of the canvas.
 *
 * ## Why this exists
 *
 * The canvas already groups, but only TOPOLOGICALLY: connected components over
 * the filtered edge set, with hub-stopping so the project everything hangs off
 * does not weld the space into one blob (model.ts §COMPONENTS). That answers
 * "what is wired to what". It cannot answer "what is blocked", "what is mine",
 * "what is still open" — questions a reader asks far more often, and which the
 * data can already answer, because a graph node is a FULL `EntitySummary`.
 *
 * Nothing here needs a server change. `graph.query` returns `EntitySummary[]`
 * (nodes) and `GraphEdgeView[]` with `type` and `props` intact; `relevance.ts`
 * reads degree, liveness and three badges and ignores every other field on the
 * row. This module reads the rest.
 *
 * ## The law of this file
 *
 * A grouper is a PURE function of one entity plus a resolved context, and it
 * must be TOTAL: every node lands in exactly one group, including the ones the
 * signal does not apply to. There is no silent drop — a node the signal cannot
 * speak about goes to a named residual group ("No assignee", "Not a task"),
 * because a card missing from the canvas is indistinguishable from a card that
 * was never loaded, and that is the confusion this whole surface exists to end.
 *
 * §15.2 is honored: no kind literals. A grouper that groups BY kind returns the
 * kind as `kindRef` and lets the caller resolve presentation through the domain
 * registry, exactly as the cards do.
 */
import type { EdgeView, EntitySummary } from '@tm8/contract';
import { heatOf } from './heat';

// --------------------------------------------------------------------------
// The dimensions.
// --------------------------------------------------------------------------

export type GroupById =
  | 'none'
  | 'kind'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'author'
  | 'parent'
  | 'project'
  | 'heat'
  | 'signal';

export interface GroupSpec {
  id: GroupById;
  label: string;
  /** One line, shown on the control. Says what the partition MEANS. */
  hint: string;
}

/**
 * Offered in the order a reader reaches for them: what it is, where it stands,
 * who holds it, where it lives, how it is moving.
 */
export const GROUP_BYS: readonly GroupSpec[] = [
  { id: 'none', label: 'No grouping', hint: 'Islands only — connected components, the way the canvas has always drawn them.' },
  { id: 'kind', label: 'Kind', hint: 'Group by entity kind — tasks with tasks, sessions with sessions.' },
  { id: 'status', label: 'Status', hint: 'Group by work status, in workflow order. Anything without a status is named as such.' },
  { id: 'priority', label: 'Priority', hint: 'Group by task priority, urgent first.' },
  { id: 'assignee', label: 'Assignee', hint: 'Group by who holds the work. Unassigned is its own band, never hidden.' },
  { id: 'author', label: 'Author', hint: 'Group by who created the entity.' },
  { id: 'parent', label: 'Parent', hint: 'Group by the entity that contains it — the hierarchy, not the edges.' },
  { id: 'project', label: 'Project', hint: 'Group by the project it was created in, read from the in_project edge.' },
  { id: 'heat', label: 'Recency', hint: 'Group by how recently the space touched it — fresh, warm, at rest.' },
  { id: 'signal', label: 'Signal', hint: 'Group by what the entity is asking for: blocked, needs attention, being worked, in review, quiet.' },
];

export function groupSpec(id: GroupById): GroupSpec {
  return GROUP_BYS.find((g) => g.id === id) ?? GROUP_BYS[0];
}

/** One node's group membership. `key` partitions; `label` is what a human reads. */
export interface GroupAssignment {
  key: string;
  label: string;
  /**
   * Set only when the group IS a kind, so the caller can resolve the icon and
   * the plural label through the domain registry rather than printing the raw
   * enum. §15.2 — presentation never branches on a kind literal in this file.
   */
  kindRef?: string;
  /** An actor id, when the group is an actor — lets the caller draw the avatar. */
  actorRef?: string;
  /**
   * Sort rank within the dimension. Lower sorts first. Groupers with an
   * inherent order (status, priority, heat, signal) set it; the rest leave it
   * at 0 and fall back to size-then-name, which is decided by the caller.
   */
  rank: number;
  /**
   * True when this is the residual band — the nodes the signal cannot speak
   * about. Sorted last regardless of rank, and rendered quieter, because "we
   * have nothing to say about these twelve" is a different statement from
   * "these twelve are open".
   */
  residual: boolean;
}

export interface GroupContext {
  /** The heat clock, same one the cards use. */
  now: string;
  /** Every edge in scope — `project` reads `in_project` from these. */
  edges: readonly EdgeView[];
  /** Every node in scope, for resolving a parent that is itself on the canvas. */
  nodes: readonly EntitySummary[];
}

// --------------------------------------------------------------------------
// Structural reads. These reach into `state` and `badges` WITHOUT asserting a
// kind: a doc has no `assignees`, and the correct answer for a doc is the
// residual band, not a crash and not an invented empty array.
// --------------------------------------------------------------------------

interface Actorish { id: string; displayName?: string }

function assigneesOf(n: EntitySummary): readonly Actorish[] {
  const a = (n.state as { assignees?: readonly Actorish[] } | undefined)?.assignees;
  return Array.isArray(a) ? a : [];
}

function statusOf(n: EntitySummary): string | null {
  const s = (n.state as { status?: unknown } | undefined)?.status;
  return typeof s === 'string' ? s : null;
}

function priorityOf(n: EntitySummary): string | null {
  const p = (n.state as { priority?: unknown } | undefined)?.priority;
  return typeof p === 'string' ? p : null;
}

const RESIDUAL_RANK = 9_000;

function residual(key: string, label: string): GroupAssignment {
  return { key, label, rank: RESIDUAL_RANK, residual: true };
}

function band(key: string, label: string, rank: number, extra?: Partial<GroupAssignment>): GroupAssignment {
  return { key, label, rank, residual: false, ...extra };
}

// --------------------------------------------------------------------------
// The orders. Explicit, because alphabetical is wrong for every one of these:
// "blocked, cancelled, done, in_review" reads as noise where the workflow order
// reads as a pipeline.
// --------------------------------------------------------------------------

/** Workflow order. Unknown (space-defined) statuses sort after the known ones. */
const STATUS_ORDER: readonly string[] = [
  'open', 'pulled', 'working', 'blocked', 'in_review', 'done', 'cancelled',
];

const PRIORITY_ORDER: readonly string[] = ['urgent', 'high', 'medium', 'low'];

const HEAT_ORDER: readonly string[] = ['fresh', 'warm', 'rest'];

const HEAT_LABEL: Readonly<Record<string, string>> = {
  fresh: 'Fresh · last 2 minutes',
  warm: 'Warm · last 45 minutes',
  rest: 'At rest',
};

/** A word for a status the space invented — shown as-is, never mapped away. */
function humanize(word: string): string {
  const bare = word.startsWith('x:') ? word.slice(2) : word;
  const spaced = bare.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function rankIn(order: readonly string[], value: string): number {
  const i = order.indexOf(value);
  return i === -1 ? order.length : i;
}

// --------------------------------------------------------------------------
// SIGNAL — the one dimension that is not a field but a reading of several.
//
// Precedence is deliberate and is the same precedence the cards already use:
// blocked outranks attention outranks live work. A node matches the FIRST band
// it qualifies for, so the count on each band is "things whose most urgent fact
// is this", which is the number a reader can act on. Sum still equals the whole.
// --------------------------------------------------------------------------

interface SignalBand {
  key: string;
  label: string;
  hit: (n: EntitySummary) => boolean;
}

const SIGNAL_BANDS: readonly SignalBand[] = [
  {
    key: 'blocked',
    label: 'Blocked',
    hit: (n) => (n.badges.blocked?.unresolvedHardDependencyCount ?? 0) > 0,
  },
  {
    key: 'attention',
    label: 'Needs attention',
    hit: (n) => n.badges.attention !== undefined,
  },
  {
    key: 'working',
    label: 'Being worked now',
    hit: (n) => (n.badges.workingActors?.length ?? 0) > 0,
  },
  {
    key: 'pr',
    label: 'Has a pull request',
    hit: (n) => (n.badges.pullRequests?.length ?? 0) > 0,
  },
  {
    key: 'stale',
    label: 'Stale',
    hit: (n) => (n.badges.staleness?.reasons.length ?? 0) > 0,
  },
  {
    key: 'pulled',
    label: 'Pulled',
    hit: (n) => (n.badges.pulls?.length ?? 0) > 0,
  },
];

// --------------------------------------------------------------------------
// The project index: node id → the project it was created in.
// --------------------------------------------------------------------------

const PROJECT_EDGE = 'in_project';

function projectIndex(edges: readonly EdgeView[]): Map<string, { id: string; title: string }> {
  const out = new Map<string, { id: string; title: string }>();
  for (const e of edges) {
    if (e.type !== PROJECT_EDGE) continue;
    // Direction is entity -> project. Recorded once; a later duplicate does not
    // overwrite, so the mapping is stable under edge reordering.
    if (!out.has(e.source.id)) out.set(e.source.id, { id: e.target.id, title: e.target.title });
  }
  return out;
}

// --------------------------------------------------------------------------
// The groupers.
// --------------------------------------------------------------------------

export interface Grouper {
  (n: EntitySummary): GroupAssignment;
}

/**
 * Build the grouper for one dimension. Resolving the context ONCE (project
 * index, parent titles) keeps the per-node call O(1) — this runs over every
 * node on every model compute.
 */
export function grouperFor(by: GroupById, ctx: GroupContext): Grouper {
  switch (by) {
    case 'kind':
      return (n) => band(`kind:${n.kind}`, n.kind, 0, { kindRef: n.kind });

    case 'status':
      return (n) => {
        const s = statusOf(n);
        if (s === null) return residual('status:none', 'No status');
        return band(`status:${s}`, humanize(s), rankIn(STATUS_ORDER, s));
      };

    case 'priority':
      return (n) => {
        const p = priorityOf(n);
        if (p === null) return residual('priority:none', 'No priority');
        return band(`priority:${p}`, humanize(p), rankIn(PRIORITY_ORDER, p));
      };

    case 'assignee':
      return (n) => {
        const holders = assigneesOf(n);
        if (holders.length === 0) return residual('assignee:none', 'Unassigned');
        // A node with several assignees lands under the FIRST, and the band
        // count says so rather than double-counting it into two bands — the
        // accounting law requires exactly one home per node.
        const a = holders[0];
        const more = holders.length > 1 ? ` +${holders.length - 1}` : '';
        return band(`assignee:${a.id}`, `${a.displayName ?? a.id}${more}`, 0, { actorRef: a.id });
      };

    case 'author':
      return (n) =>
        band(`author:${n.createdBy.id}`, n.createdBy.displayName, 0, { actorRef: n.createdBy.id });

    case 'parent': {
      const titleById = new Map(ctx.nodes.map((n) => [n.id, n.title]));
      return (n) => {
        if (n.parentId === null) return residual('parent:none', 'Top level');
        const title = titleById.get(n.parentId);
        // A parent off-canvas is still a real parent — group by its id and say
        // the title is unknown, rather than pretending the node is top-level.
        return band(`parent:${n.parentId}`, title ?? 'Parent not on canvas', 0);
      };
    }

    case 'project': {
      const index = projectIndex(ctx.edges);
      return (n) => {
        const p = index.get(n.id);
        if (p === undefined) return residual('project:none', 'No project');
        return band(`project:${p.id}`, p.title, 0);
      };
    }

    case 'heat':
      return (n) => {
        const h = heatOf(n.activityAt, ctx.now);
        return band(`heat:${h}`, HEAT_LABEL[h] ?? humanize(h), rankIn(HEAT_ORDER, h));
      };

    case 'signal':
      return (n) => {
        for (const [i, s] of SIGNAL_BANDS.entries()) {
          if (s.hit(n)) return band(`signal:${s.key}`, s.label, i);
        }
        return residual('signal:quiet', 'Quiet');
      };

    case 'none':
    default:
      return () => band('all', 'All', 0);
  }
}

/**
 * Which dimensions would actually SPLIT this node set — a control that offers
 * "Priority" on a canvas of nothing but sessions is offering a partition of one
 * band, and the reader learns that only by spending a click. A dimension counts
 * as discriminating when it yields at least two non-empty groups.
 *
 * Returned in `GROUP_BYS` order; 'none' is always included.
 */
export function discriminatingGroupBys(
  nodes: readonly EntitySummary[],
  ctx: GroupContext,
): GroupById[] {
  const out: GroupById[] = [];
  for (const spec of GROUP_BYS) {
    if (spec.id === 'none') {
      out.push(spec.id);
      continue;
    }
    const grouper = grouperFor(spec.id, ctx);
    const keys = new Set<string>();
    for (const n of nodes) {
      keys.add(grouper(n).key);
      if (keys.size > 1) break;
    }
    if (keys.size > 1) out.push(spec.id);
  }
  return out;
}
