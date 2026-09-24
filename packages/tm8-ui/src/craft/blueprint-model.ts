/**
 * BLUEPRINT VIEW — the pure fold from a `graph` entity's ROW to everything a
 * Craft view draws (rulings R1-R3; view-model shape in `blueprint-types.ts`).
 *
 * The row is the whole graph (R1): no per-node reads, no induced edges, no
 * cap. The content is LEAN BY LAW (R2), so this parser is tolerant: a node
 * with no key gets one derived; an edge naming a key no node carries is
 * COUNTED and skipped, never silently dropped and never a crash; an unknown
 * kind or edge type still draws.
 *
 * MEANING comes from the orchestration vocabulary in `@tm8/contract` — the
 * same table the craft prompt teaches and the server's coherence check reads:
 *   - assignment edges are not lines: the assignee is docked on its task, and
 *     an assignee with ONLY assignments is not a card at all (`attached`);
 *   - flow/dependency edges rank the layered layout, drawn in DATA order
 *     (`consumes`/`depends_on` are drawn dst → src with their inverse label);
 *   - context edges are routed but order nothing.
 *
 * LAYOUT: `layout.ts` places and routes; `layout[key] = {x, y}` on the row is
 * a user PIN and wins, exactly where the row stores it (offset by PAD, the
 * convention every earlier reader used).
 */
import {
  checkGraphCoherence,
  graphEdgeKeys,
  graphNodeKey,
  graphNodeMaterialized,
  graphNodeRef,
  orchestrationNodeKind,
  resolveEdgeType,
  ORCHESTRATION_NODE_KINDS,
  type CoherenceFinding,
  type CoherenceSeverity,
  type EntityId,
} from '@tm8/contract';
import { humanize } from '../session-graph/model';
import {
  BLUEPRINT_ASSIGNEE_DOCK,
  blueprintCardSize,
  blueprintLabelSize,
  type BlueprintAssignee,
  type BlueprintAssigneeGroup,
  type BlueprintAttachedNode,
  type BlueprintCard,
  type BlueprintLane,
  type BlueprintLaneBy,
  type BlueprintLine,
  type BlueprintRow,
  type BlueprintStage,
  type BlueprintView,
  type BlueprintViewOptions,
  type RefTitles,
} from './blueprint-types';
import { layoutGraph, roundedPath, type Box, type LayoutEdgeInput, type LayoutNodeInput } from './layout';

export * from './blueprint-types';

/** Canvas padding: stored `layout` coordinates are offset by this, as they always were. */
export const PAD = 24;
const UNASSIGNED = '\u0000unassigned';
const NO_PHASE = '\u0000none';

interface RawNode {
  key?: unknown; id?: unknown; ref?: unknown; entityId?: unknown;
  spec?: { kind?: unknown; title?: unknown; hint?: unknown; phase?: unknown };
}
interface RawEdge { src?: unknown; dst?: unknown; type?: unknown; note?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Re-exported for `CraftScreen`, which resolves reference titles from the same answer. */
export function nodeRefId(node: RawNode): EntityId | null {
  return graphNodeRef(node);
}
export function nodeKey(node: RawNode, index: number): string {
  return graphNodeKey(node, index);
}

const SEVERITY_ORDER: Record<CoherenceSeverity, number> = { error: 0, warning: 1, info: 2 };
function worst(findings: readonly CoherenceFinding[]): CoherenceSeverity | null {
  return findings.reduce<CoherenceSeverity | null>(
    (w, f) => (w === null || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[w] ? f.severity : w), null);
}

interface NodeInfo {
  key: string;
  refId: EntityId | null;
  kind: string;
  title: string;
  hint: string | null;
  phase: string | null;
  isSpec: boolean;
  materialized: boolean;
  status: string | null;
  live: boolean;
}

interface EdgeInfo {
  key: string;
  /** Stored endpoints. */
  src: string;
  dst: string;
  /** Canonical endpoints (aliases unfolded). */
  csrc: string;
  cdst: string;
  type: string;
  rawType: string;
  role: BlueprintLine['role'];
  known: boolean;
  order: 'src-first' | 'dst-first' | 'none';
  label: string;
  inverseLabel: string;
  note: string | null;
}

export function blueprintView(
  content: unknown,
  refTitles?: RefTitles,
  options: BlueprintViewOptions = {},
): BlueprintView {
  const c = (content ?? {}) as Record<string, unknown>;
  const graphType = str(c['graphType']) ?? 'entity';
  const source = str(c['source']);
  const rawNodes: RawNode[] = Array.isArray(c['nodes']) ? (c['nodes'] as unknown[]).map((n) => (n && typeof n === 'object' ? n : {}) as RawNode) : [];
  const rawEdges: RawEdge[] = Array.isArray(c['edges']) ? (c['edges'] as unknown[]).map((e) => (e && typeof e === 'object' ? e : {}) as RawEdge) : [];
  const storedLayout = (c['layout'] && typeof c['layout'] === 'object' ? c['layout'] : {}) as Record<string, { x?: unknown; y?: unknown }>;
  const mode = options.mode ?? 'flow';
  const direction = options.direction ?? 'LR';
  const laneBy: BlueprintLaneBy = options.laneBy ?? 'assignee';

  // ── Nodes (first key wins; the coherence check reports duplicates) ───────────
  const nodes: NodeInfo[] = [];
  const byKey = new Map<string, NodeInfo>();
  rawNodes.forEach((node, index) => {
    const key = graphNodeKey(node, index);
    if (byKey.has(key)) return;
    const refId = graphNodeRef(node);
    const spec = node.spec && typeof node.spec === 'object' ? node.spec : null;
    const resolved = refId ? refTitles?.get(refId) : undefined;
    const info: NodeInfo = {
      key,
      refId,
      kind: resolved?.kind ?? str(spec?.kind) ?? 'entity',
      /* An unresolved reference shows its truncated id, honestly — the host
         resolves titles asynchronously and re-folds. */
      title: resolved?.title ?? str(spec?.title) ?? (refId ? `${refId.slice(0, 8)}…` : 'Untitled'),
      hint: str(spec?.hint),
      phase: str(spec?.phase),
      isSpec: refId === null,
      materialized: graphNodeMaterialized(node),
      status: refId ? resolved?.status ?? null : null,
      live: refId ? resolved?.live === true : false,
    };
    nodes.push(info);
    byKey.set(key, info);
  });

  // ── Edges ────────────────────────────────────────────────────────────────────
  let dangling = 0;
  const edges: EdgeInfo[] = [];
  const edgeKeys = graphEdgeKeys(rawEdges);
  rawEdges.forEach((edge, index) => {
    const s = str(edge.src);
    const d = str(edge.dst);
    if (!s || !d || !byKey.has(s) || !byKey.has(d)) {
      dangling += 1;
      return;
    }
    const rawType = str(edge.type) ?? '';
    const r = resolveEdgeType(rawType);
    const [csrc, cdst] = r.reversed ? [d, s] : [s, d];
    const fallback = (r.type || 'relates to').replace(/_/g, ' ');
    edges.push({
      key: edgeKeys[index] as string,
      src: s, dst: d, csrc, cdst,
      type: r.type, rawType,
      role: r.def?.role ?? 'unknown',
      known: r.def !== null,
      /* An unknown type is most often a flow word ("feeds", "then"): rank it forward. */
      order: r.def?.order ?? 'src-first',
      label: r.def?.label ?? fallback,
      inverseLabel: r.def?.inverseLabel ?? fallback,
      note: str(edge.note),
    });
  });

  const assignments = edges.filter((e) => e.role === 'assignment');
  const drawn = edges.filter((e) => e.role !== 'assignment');

  /* ATTACHED: an assignee whose every edge is an assignment it receives. */
  const attachedKeys = new Set<string>();
  nodes.forEach((n) => {
    if (orchestrationNodeKind(n.kind)?.placement !== 'attach') return;
    const mine = edges.filter((e) => e.csrc === n.key || e.cdst === n.key);
    if (mine.length > 0 && mine.every((e) => e.role === 'assignment' && e.cdst === n.key)) attachedKeys.add(n.key);
  });
  const assigneeOf = (key: string): BlueprintAssignee => {
    const n = byKey.get(key) as NodeInfo;
    return { key, title: n.title, kind: n.kind, refId: n.refId, isSpec: n.isSpec };
  };
  const assigneesByTask = new Map<string, string[]>();
  assignments.forEach((e) => {
    const list = assigneesByTask.get(e.csrc) ?? [];
    if (!list.includes(e.cdst)) list.push(e.cdst);
    assigneesByTask.set(e.csrc, list);
  });
  const cardNodes = nodes.filter((n) => !attachedKeys.has(n.key));

  // ── Findings ─────────────────────────────────────────────────────────────────
  const findings = checkGraphCoherence(c, { refKind: (ref) => refTitles?.get(ref)?.kind });
  const nodeFindings = new Map<string, CoherenceFinding[]>();
  const edgeFindings = new Map<string, CoherenceFinding[]>();
  findings.forEach((f) => {
    f.nodes.forEach((k) => nodeFindings.set(k, [...(nodeFindings.get(k) ?? []), f]));
    f.edges.forEach((k) => edgeFindings.set(k, [...(edgeFindings.get(k) ?? []), f]));
  });

  // ── Lanes ────────────────────────────────────────────────────────────────────
  const laneOf = new Map<string, string>();
  let lanes: { key: string; label: string; assignee: BlueprintAssignee | null }[] = [];
  if (mode === 'swimlane') {
    if (laneBy === 'assignee') {
      const heads: string[] = [];
      nodes.forEach((n) => {
        if (orchestrationNodeKind(n.kind)?.placement === 'attach'
          && (assignments.some((e) => e.cdst === n.key) || !attachedKeys.has(n.key))) heads.push(n.key);
      });
      heads.forEach((h) => { if (!attachedKeys.has(h)) laneOf.set(h, h); });
      cardNodes.forEach((n) => {
        const first = assigneesByTask.get(n.key)?.[0];
        if (first) laneOf.set(n.key, first);
      });
      /* Everything else follows its nearest laned neighbour — an output lives
         with the task that produces it, an input with the task that reads it. */
      for (let pass = 0; pass < 4; pass += 1) {
        cardNodes.forEach((n) => {
          if (laneOf.has(n.key)) return;
          const neighbour = drawn
            .filter((e) => e.csrc === n.key || e.cdst === n.key)
            .map((e) => (e.csrc === n.key ? e.cdst : e.csrc))
            .find((k) => laneOf.has(k));
          if (neighbour) laneOf.set(n.key, laneOf.get(neighbour) as string);
        });
      }
      cardNodes.forEach((n) => { if (!laneOf.has(n.key)) laneOf.set(n.key, UNASSIGNED); });
      lanes = heads
        .filter((h) => [...laneOf.values()].includes(h))
        .map((h) => ({ key: h, label: (byKey.get(h) as NodeInfo).title, assignee: assigneeOf(h) }));
      if ([...laneOf.values()].includes(UNASSIGNED)) lanes.push({ key: UNASSIGNED, label: 'Unassigned', assignee: null });
    } else if (laneBy === 'kind') {
      cardNodes.forEach((n) => laneOf.set(n.key, n.kind));
      const seen = [...new Set(cardNodes.map((n) => n.kind))];
      const vocab = ORCHESTRATION_NODE_KINDS.map((k) => k.kind);
      seen.sort((a, b) => {
        const ia = vocab.indexOf(a);
        const ib = vocab.indexOf(b);
        return (ia < 0 ? vocab.length : ia) - (ib < 0 ? vocab.length : ib) || seen.indexOf(a) - seen.indexOf(b);
      });
      lanes = seen.map((k) => ({ key: k, label: orchestrationNodeKind(k)?.plural ?? humanize(k), assignee: null }));
    } else {
      cardNodes.forEach((n) => laneOf.set(n.key, n.phase ?? NO_PHASE));
      const seen = [...new Set(cardNodes.map((n) => n.phase ?? NO_PHASE))];
      seen.sort((a, b) => Number(a === NO_PHASE) - Number(b === NO_PHASE));
      lanes = seen.map((k) => ({ key: k, label: k === NO_PHASE ? 'No phase' : k, assignee: null }));
    }
  }

  // ── Layout ───────────────────────────────────────────────────────────────────
  const dockFor = (key: string) => ((assigneesByTask.get(key)?.length ?? 0) > 0 ? BLUEPRINT_ASSIGNEE_DOCK / 2 : 0);
  const layoutNodes: LayoutNodeInput[] = cardNodes.map((n) => {
    const size = blueprintCardSize(n.kind);
    const placed = storedLayout[n.key];
    const pinned = placed && typeof placed.x === 'number' && Number.isFinite(placed.x)
      && typeof placed.y === 'number' && Number.isFinite(placed.y)
      ? { x: PAD + placed.x, y: PAD + placed.y } : null;
    return {
      key: n.key, width: size.width, height: size.height + dockFor(n.key),
      lane: mode === 'swimlane' ? laneOf.get(n.key) ?? null : null,
      pinned,
    };
  });
  const lineMeta = drawn.map((e) => {
    const drawnReversed = e.order === 'dst-first';
    const label = drawnReversed ? e.inverseLabel : e.label;
    return { e, drawnReversed, label };
  });
  const layoutEdges: LayoutEdgeInput[] = lineMeta.map(({ e, drawnReversed, label }) => ({
    key: e.key,
    from: drawnReversed ? e.cdst : e.csrc,
    to: drawnReversed ? e.csrc : e.cdst,
    ranked: e.order !== 'none',
    label: blueprintLabelSize(label),
  }));
  const placed = layoutGraph(layoutNodes, layoutEdges, {
    direction,
    lanes: mode === 'swimlane' ? lanes.map((l) => ({ key: l.key, label: l.label })) : null,
    pad: PAD,
  });

  // ── Cards ────────────────────────────────────────────────────────────────────
  const cards: BlueprintCard[] = cardNodes.map((n) => {
    const p = placed.nodes.get(n.key)!;
    const size = blueprintCardSize(n.kind);
    const mine = nodeFindings.get(n.key) ?? [];
    return {
      key: n.key,
      refId: n.refId,
      kind: n.kind,
      kindLabel: orchestrationNodeKind(n.kind)?.label ?? humanize(n.kind),
      knownKind: orchestrationNodeKind(n.kind) !== null,
      title: n.title,
      hint: n.hint,
      phase: n.phase,
      isSpec: n.isSpec,
      materialized: n.materialized,
      status: n.status,
      live: n.live,
      x: p.x,
      y: p.y,
      width: size.width,
      height: size.height,
      pinned: p.pinned,
      rank: p.rank,
      lane: p.lane,
      assignees: (assigneesByTask.get(n.key) ?? []).map(assigneeOf),
      attached: false,
      findings: mine,
      severity: worst(mine),
    };
  });

  const attached: BlueprintAttachedNode[] = nodes
    .filter((n) => attachedKeys.has(n.key))
    .map((n) => ({
      key: n.key,
      refId: n.refId,
      kind: n.kind,
      title: n.title,
      isSpec: n.isSpec,
      materialized: n.materialized,
      tasks: assignments.filter((e) => e.cdst === n.key).map((e) => e.csrc)
        .filter((k, i, all) => all.indexOf(k) === i),
      findings: nodeFindings.get(n.key) ?? [],
    }));

  // ── Lines ────────────────────────────────────────────────────────────────────
  const lines: BlueprintLine[] = lineMeta.map(({ e, drawnReversed, label }) => {
    const route = placed.edges.get(e.key)!;
    const pts = route.points;
    const first = pts[0] ?? { x: 0, y: 0 };
    const last = pts[pts.length - 1] ?? first;
    const mine = edgeFindings.get(e.key) ?? [];
    const lb = route.labelBox;
    return {
      key: e.key,
      src: e.src,
      dst: e.dst,
      type: e.type,
      role: e.role,
      knownType: e.known,
      label,
      sentence: `${e.src} ${e.rawType || 'relates to'} ${e.dst}`,
      note: e.note,
      drawnReversed,
      back: route.back,
      points: pts,
      path: roundedPath(pts),
      labelBox: lb,
      findings: mine,
      severity: worst(mine),
      /* LEGACY straight line, port to port, for the canvas that has not moved
         to `path` yet — its label sits on ITS line, not on the routed one. */
      x1: first.x, y1: first.y, x2: last.x, y2: last.y,
      cx: (first.x + last.x) / 2, cy: (first.y + last.y) / 2,
      lx: (first.x + last.x) / 2, ly: (first.y + last.y) / 2,
    };
  });

  const laneViews: BlueprintLane[] = placed.lanes.map((l) => ({
    key: l.key,
    label: l.label,
    assignee: lanes.find((x) => x.key === l.key)?.assignee ?? null,
    box: l.box,
  }));

  // ── Lists (layout-independent views) ────────────────────────────────────────
  const flowOrder = (a: BlueprintCard, b: BlueprintCard) => a.rank - b.rank
    || (placed.nodes.get(a.key)!.order - placed.nodes.get(b.key)!.order);
  const tasksSorted = cards.filter((card) => card.kind === 'task').sort(flowOrder);
  const byAssignee: BlueprintAssigneeGroup[] = [];
  nodes.forEach((n) => {
    const tasks = tasksSorted.filter((t) => (assigneesByTask.get(t.key) ?? []).includes(n.key)).map((t) => t.key);
    if (tasks.length > 0) byAssignee.push({ assignee: assigneeOf(n.key), tasks });
  });
  const unassigned = tasksSorted.filter((t) => (assigneesByTask.get(t.key) ?? []).length === 0).map((t) => t.key);
  if (unassigned.length > 0) byAssignee.push({ assignee: null, tasks: unassigned });

  const stages: BlueprintStage[] = [];
  [...cards].sort(flowOrder).forEach((card) => {
    const stage = stages.find((s) => s.rank === card.rank);
    if (stage) stage.keys.push(card.key);
    else stages.push({ rank: card.rank, keys: [card.key] });
  });

  const out = (key: string, type: string) => drawn.filter((e) => e.type === type && e.csrc === key).map((e) => e.cdst);
  const rows: BlueprintRow[] = cards.map((card) => ({
    key: card.key,
    kind: card.kind,
    kindLabel: card.kindLabel,
    title: card.title,
    isSpec: card.isSpec,
    materialized: card.materialized,
    refId: card.refId,
    status: card.status,
    rank: card.rank,
    assignees: card.assignees.map((a) => a.key),
    consumes: out(card.key, 'consumes'),
    produces: out(card.key, 'produces'),
    dependsOn: out(card.key, 'depends_on'),
    blocks: drawn.filter((e) => e.type === 'depends_on' && e.cdst === card.key).map((e) => e.csrc),
    context: drawn.filter((e) => (e.role === 'context' || e.role === 'unknown') && e.csrc === card.key).map((e) => e.cdst),
    severity: card.severity,
  }));

  // ── Extent ───────────────────────────────────────────────────────────────────
  const boxes: Box[] = [
    ...cards.map((card) => ({ x: card.x, y: card.y, width: card.width, height: card.height + dockFor(card.key) })),
    ...lines.flatMap((l) => [
      ...l.points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })),
      ...(l.labelBox ? [l.labelBox] : []),
    ]),
    ...laneViews.map((l) => l.box),
  ];
  const width = Math.max(PAD, ...boxes.map((b) => b.x + b.width)) + PAD;
  const height = Math.max(PAD, ...boxes.map((b) => b.y + b.height)) + PAD;
  const minX = boxes.length > 0 ? Math.min(...boxes.map((b) => b.x)) - PAD : 0;
  const minY = boxes.length > 0 ? Math.min(...boxes.map((b) => b.y)) - PAD : 0;
  const bounds = boxes.length > 0
    ? { minX, minY, width: Math.max(...boxes.map((b) => b.x + b.width)) + PAD - minX, height: Math.max(...boxes.map((b) => b.y + b.height)) + PAD - minY }
    : { minX: 0, minY: 0, width, height };

  return {
    graphType, source, mode, direction,
    cards, attached, lines, lanes: laneViews, findings,
    danglingEdgeCount: dangling,
    lists: { byAssignee, stages, rows },
    width, height, bounds,
  };
}
