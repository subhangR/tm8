/**
 * THE BLUEPRINT VIEW MODEL — the one shape every Craft view draws from.
 *
 * `blueprintView(content, refs, options)` folds a `graph` row into this; the
 * UI renders it and never re-derives meaning from the row. Coordinates are
 * canvas units, top-left origin, and already include the layout (flow or
 * swimlane), the user's pinned `layout` overrides, routed edges with ports,
 * collision-free label boxes, and the coherence findings pinned to what they
 * are about. Non-graph views (per-teammate list, stage timeline, table) read
 * `lists`, which is layout-independent.
 */
import type {
  CoherenceFinding, CoherenceSeverity, EntityId, OrchestrationEdgeRole, WorkStatus,
} from '@tm8/contract';

// ─── Metrics (owned here; the canvas imports them so text and boxes agree) ─────

export interface BlueprintSize { width: number; height: number }

/** Card size per node kind. Unknown kinds use `BLUEPRINT_DEFAULT_CARD`. */
export const BLUEPRINT_CARD_SIZE: Readonly<Record<string, BlueprintSize>> = {
  task: { width: 200, height: 64 },
  team_member: { width: 168, height: 56 },
  member: { width: 168, height: 56 },
  doc: { width: 168, height: 56 },
  artifact: { width: 168, height: 56 },
  memory: { width: 160, height: 36 },
  skill: { width: 120, height: 28 },
};
export const BLUEPRINT_DEFAULT_CARD: BlueprintSize = { width: 200, height: 64 };

/**
 * Assignee avatar diameter. The avatar row is DOCKED centred on the task
 * card's bottom edge, so it overhangs by half of this; the layout reserves
 * that overhang below every task that has assignees (`card.height` is the
 * card alone).
 */
export const BLUEPRINT_ASSIGNEE_DOCK = 24;

/** Edge-label metrics `labelBox` is sized with — render labels exactly so. */
export const BLUEPRINT_LABEL = { fontSize: 10, fontWeight: 500, charWidth: 5.8, padX: 6, height: 16 } as const;

export function blueprintCardSize(kind: string): BlueprintSize {
  return BLUEPRINT_CARD_SIZE[kind] ?? BLUEPRINT_DEFAULT_CARD;
}

export function blueprintLabelSize(text: string): BlueprintSize {
  return { width: Math.ceil(text.length * BLUEPRINT_LABEL.charWidth + 2 * BLUEPRINT_LABEL.padX), height: BLUEPRINT_LABEL.height };
}

export type BlueprintMode = 'flow' | 'swimlane';
/** LR: flow runs left → right (default). TB: top → bottom. */
export type BlueprintDirection = 'LR' | 'TB';
/** Swimlane grouping: by assignee (default), by node kind, or by `spec.phase`. */
export type BlueprintLaneBy = 'assignee' | 'kind' | 'phase';

export interface BlueprintViewOptions {
  mode?: BlueprintMode;
  direction?: BlueprintDirection;
  laneBy?: BlueprintLaneBy;
}

/**
 * What the host knows about a referenced entity. `status` is the entity's own
 * status string (task: open/working/done…); `live` means a session is running
 * on it right now. Both optional — a host that only resolves titles still works.
 */
export interface RefInfo {
  kind: string;
  title: string;
  /** For tasks, the work-status vocabulary (open/pulled/working/in_review/done/blocked/cancelled). */
  status?: WorkStatus | string | null;
  live?: boolean;
}
export type RefTitles = ReadonlyMap<string, RefInfo>;

export interface BlueprintPoint { x: number; y: number }
export interface BlueprintBox { x: number; y: number; width: number; height: number }

/** An assignee drawn ON a task card (avatar/chip), not as a separate card. */
export interface BlueprintAssignee {
  key: string;
  title: string;
  kind: string;
  refId: EntityId | null;
  isSpec: boolean;
}

export interface BlueprintCard {
  /** Row-local key — the edge namespace. */
  key: string;
  refId: EntityId | null;
  kind: string;
  /** Vocabulary label ("Task", "Teammate", …) or the humanized unknown kind. */
  kindLabel: string;
  /** False ⇒ a kind the orchestration vocabulary does not know (still drawn). */
  knownKind: boolean;
  title: string;
  hint: string | null;
  /** `spec.phase`, when the row gives one. */
  phase: string | null;
  /** True ⇒ does not exist yet (no `ref`). Draw dashed. */
  isSpec: boolean;
  /** True ⇒ was a spec, now carries `ref` (orchestrated). Draw solid + a "built" mark. */
  materialized: boolean;
  /** Host-supplied live overlay for references (see RefInfo). */
  status: string | null;
  live: boolean;
  /** Top-left and size. Cards are not all the same size — read these, not constants. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** True ⇒ placed by the row's stored `layout` (a user override), not by the layout engine. */
  pinned: boolean;
  /** Flow stage, 0-based (column in LR, row in TB). -1 for an unconnected node, parked in a strip after the flow. */
  rank: number;
  /** Swimlane key this card sits in; null in flow mode. */
  lane: string | null;
  /** Assignees attached to this card (tasks only). */
  assignees: BlueprintAssignee[];
  /**
   * True ⇒ this node is an assignee whose ONLY edges are assignments: it is
   * drawn as a chip on its tasks (and as the lane header in swimlane-by-
   * assignee), so it is NOT in `cards`' drawable set — it is listed in
   * `view.attached` instead. Never true for a card in `view.cards`.
   */
  attached: false;
  /** Findings naming this node, worst first. */
  findings: CoherenceFinding[];
  /** Worst severity among `findings`, or null. */
  severity: CoherenceSeverity | null;
}

/** An assignee node drawn only as chips (see BlueprintCard.attached). */
export interface BlueprintAttachedNode {
  key: string;
  refId: EntityId | null;
  kind: string;
  title: string;
  isSpec: boolean;
  materialized: boolean;
  /** The task keys it is attached to. */
  tasks: string[];
  findings: CoherenceFinding[];
}

export type BlueprintEdgeRole = OrchestrationEdgeRole | 'unknown';

export interface BlueprintLine {
  key: string;
  /** Endpoints AS STORED in the row (the sentence: src <type> dst). */
  src: string;
  dst: string;
  /** Canonical type (aliases folded), or the normalized unknown type. */
  type: string;
  role: BlueprintEdgeRole;
  knownType: boolean;
  /**
   * The label that reads ALONG THE DRAWN ARROW. For `consumes`/`depends_on`
   * the arrow is drawn dst → src (data/ordering flow), so the label is the
   * inverse ("consumed by", "blocks"); otherwise the vocabulary label.
   */
  label: string;
  /** The stored sentence, for tooltips: "t-api consumes d-spec". */
  sentence: string;
  note: string | null;
  /** True ⇒ drawn from dst to src (see `label`). */
  drawnReversed: boolean;
  /** True ⇒ runs against the flow (part of a cycle); draw emphasised. */
  back: boolean;
  /**
   * The routed polyline in DRAW order — first point on the source card's
   * border (a port), last point on the target card's border. Arrowhead at the
   * last point. Segments are orthogonal and never cross a card interior.
   */
  points: BlueprintPoint[];
  /** SVG path `d` for `points`, with rounded corners. */
  path: string;
  /** Where to draw the label (box, top-left), or null when no collision-free slot exists — show on hover. */
  labelBox: BlueprintBox | null;
  findings: CoherenceFinding[];
  severity: CoherenceSeverity | null;
  /** @deprecated straight-line fields kept for the current canvas; use `points`/`path`. */
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  lx: number; ly: number;
}

export interface BlueprintLane {
  key: string;
  label: string;
  /** For assignee lanes: the assignee node (null for the "Unassigned" lane). */
  assignee: BlueprintAssignee | null;
  box: BlueprintBox;
}

/** A per-assignee grouping for list views. `assignee: null` = unassigned. */
export interface BlueprintAssigneeGroup {
  assignee: BlueprintAssignee | null;
  /** Task keys in flow order. */
  tasks: string[];
}

/** One stage of the flow for a timeline view. */
export interface BlueprintStage {
  rank: number;
  /** Node keys in this stage, top-to-bottom order. */
  keys: string[];
}

/** One row per non-attached node, for a table view. */
export interface BlueprintRow {
  key: string;
  kind: string;
  kindLabel: string;
  title: string;
  isSpec: boolean;
  materialized: boolean;
  refId: EntityId | null;
  status: string | null;
  rank: number;
  assignees: string[];
  /** Keys this node consumes / produces / depends on / is depended on by. */
  consumes: string[];
  produces: string[];
  dependsOn: string[];
  blocks: string[];
  /** Context links from this node: remembers / equips / relates_to / unknown-type targets. */
  context: string[];
  severity: CoherenceSeverity | null;
}

export interface BlueprintView {
  graphType: string;
  source: string | null;
  mode: BlueprintMode;
  direction: BlueprintDirection;
  /** Drawable cards (attached-only assignees excluded — see `attached`). */
  cards: readonly BlueprintCard[];
  attached: readonly BlueprintAttachedNode[];
  /** Drawn edges. Assignment edges are NOT here — they are `card.assignees`. */
  lines: readonly BlueprintLine[];
  /** Swimlane bands (empty in flow mode). */
  lanes: readonly BlueprintLane[];
  /** Every coherence finding, worst first (the same list the server returns on read). */
  findings: readonly CoherenceFinding[];
  /** Edges whose src/dst named no node — surfaced, never silently dropped. */
  danglingEdgeCount: number;
  lists: {
    byAssignee: readonly BlueprintAssigneeGroup[];
    stages: readonly BlueprintStage[];
    rows: readonly BlueprintRow[];
  };
  /** Max extent from the 0,0 origin (legacy). */
  width: number;
  height: number;
  /** What is actually drawn, as a box — fit the viewport to this. */
  bounds: { minX: number; minY: number; width: number; height: number };
}
