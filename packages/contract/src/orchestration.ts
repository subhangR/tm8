/**
 * THE ORCHESTRATION VOCABULARY — what a Craft blueprint's nodes and edges MEAN.
 *
 * ONE SOURCE OF TRUTH, three readers: the UI draws by it (a `role` decides
 * whether an edge is a long line, an attached avatar or a dotted context
 * link), the coherence validator below checks against it, and the craft prompt
 * teaches it. Before this existed the prompt said "edge-vocabulary intent" and
 * defined none, so agents wrote any `type` they liked and the renderer could
 * only humanize the string.
 *
 * ADVISORY, NEVER A GATE (R2, lean by law — task 01a00a0b). The DB checks
 * container types only and keeps doing so. An unknown node kind or edge type
 * still renders; the validator reports it as `info`, never refuses it. That is
 * the whole difference between a vocabulary and a program schema.
 *
 * RECONCILED WITH THE REAL REGISTRY (`edgeTypes.list`, measured 2026-09-24).
 * Every canonical type names the registered edge materialize writes, 1:1, and
 * which way round. Where the registry already has the word (`assigned_to`,
 * `depends_on`, `remembers`, `equips`) the blueprint uses it verbatim. Where it
 * did not, migration 212 registered it (`produces`, `consumes`), so a live
 * progress map reading real edges can tell "writes" from "waits for".
 *
 * THE SENTENCE RULE: every edge reads `src <type> dst` — "t-api consumes
 * d-spec", "t-api depends_on t-research". `order` says which end the layout
 * puts first; it is NOT the stored direction.
 */
import type { EntityId } from './contract.js';

// ─── Node kinds ────────────────────────────────────────────────────────────────

/**
 * How a node of this kind takes part in a flowchart.
 *
 * - `rank`   a card placed in the left→right flow (tasks, docs, …)
 * - `attach` an ASSIGNEE: drawn attached to the tasks it is assigned to, not as
 *   a free-floating card with a long line. It becomes a card again the moment
 *   it carries any non-assignment edge (a teammate who also reviews something).
 */
export type OrchestrationPlacement = 'rank' | 'attach';

export interface OrchestrationNodeKind {
  kind: string;
  label: string;
  plural: string;
  placement: OrchestrationPlacement;
  /** Can the orchestrator create one of these at materialize time? */
  materializable: boolean;
}

export const ORCHESTRATION_NODE_KINDS: readonly OrchestrationNodeKind[] = [
  { kind: 'task', label: 'Task', plural: 'Tasks', placement: 'rank', materializable: true },
  { kind: 'team_member', label: 'Teammate', plural: 'Teammates', placement: 'attach', materializable: true },
  /* A human. Assignable exactly like a teammate; never created by materialize. */
  { kind: 'member', label: 'Person', plural: 'People', placement: 'attach', materializable: false },
  { kind: 'doc', label: 'Doc', plural: 'Docs', placement: 'rank', materializable: true },
  { kind: 'artifact', label: 'Artifact', plural: 'Artifacts', placement: 'rank', materializable: true },
  { kind: 'memory', label: 'Memory', plural: 'Memories', placement: 'rank', materializable: true },
  { kind: 'skill', label: 'Skill', plural: 'Skills', placement: 'rank', materializable: false },
];

const NODE_KINDS = new Map(ORCHESTRATION_NODE_KINDS.map((k) => [k.kind, k]));

export function orchestrationNodeKind(kind: string | null | undefined): OrchestrationNodeKind | null {
  return kind ? NODE_KINDS.get(kind) ?? null : null;
}

// ─── Edge types ────────────────────────────────────────────────────────────────

/**
 * The renderer and the validator read the ROLE, never the type string.
 *
 * - `assignment` who does it — drawn as an avatar on the task card
 * - `flow`       data moving through the plan — the main left→right lines
 * - `dependency` ordering between tasks — lines, emphasised when on a cycle
 * - `context`    supporting links (memory, skills, review) — quiet, dotted
 */
export type OrchestrationEdgeRole = 'assignment' | 'flow' | 'dependency' | 'context';

/**
 * Which endpoint comes FIRST in the flow — what a layered layout ranks by.
 * `src-first`: src left of dst. `dst-first`: dst left of src (`depends_on`
 * points at the prerequisite). `none`: the edge does not order anything.
 */
export type OrchestrationEdgeOrder = 'src-first' | 'dst-first' | 'none';

export interface OrchestrationEdgeType {
  type: string;
  role: OrchestrationEdgeRole;
  /** Reads src → dst: "Draft schema  produces  Schema doc". */
  label: string;
  /** Reads dst → src, for a UI that lists a node's incoming edges. */
  inverseLabel: string;
  /** Allowed endpoint kinds; `'*'` admits any. Advisory (see file header). */
  srcKinds: readonly string[];
  dstKinds: readonly string[];
  order: OrchestrationEdgeOrder;
  /** The registered edge materialize writes; `reverse` swaps the endpoints. */
  registry: { type: string; reverse: boolean };
}

const ASSIGNEES = ['team_member', 'member'] as const;
const OUTPUTS = ['doc', 'artifact', 'memory'] as const;

export const ORCHESTRATION_EDGE_TYPES: readonly OrchestrationEdgeType[] = [
  {
    type: 'assigned_to', role: 'assignment', label: 'assigned to', inverseLabel: 'works on',
    srcKinds: ['task'], dstKinds: ASSIGNEES, order: 'none',
    registry: { type: 'assigned_to', reverse: false },
  },
  {
    type: 'produces', role: 'flow', label: 'produces', inverseLabel: 'produced by',
    srcKinds: ['task'], dstKinds: OUTPUTS, order: 'src-first',
    registry: { type: 'produces', reverse: false },
  },
  {
    /* TASK → INPUT ("t-api consumes d-spec"): the sentence reads src-type-dst
       like every other edge, and the DATA flows dst → src, so the input is
       ranked first. Coordinator ruling 2026-09-24, closed. */
    type: 'consumes', role: 'flow', label: 'consumes', inverseLabel: 'consumed by',
    srcKinds: ['task'], dstKinds: OUTPUTS, order: 'dst-first',
    registry: { type: 'consumes', reverse: false },
  },
  {
    type: 'depends_on', role: 'dependency', label: 'depends on', inverseLabel: 'blocks',
    srcKinds: ['task'], dstKinds: ['task'], order: 'dst-first',
    registry: { type: 'depends_on', reverse: false },
  },
  {
    type: 'remembers', role: 'context', label: 'remembers', inverseLabel: 'remembered by',
    srcKinds: ['task', ...ASSIGNEES], dstKinds: ['memory'], order: 'src-first',
    registry: { type: 'remembers', reverse: false },
  },
  {
    type: 'equips', role: 'context', label: 'uses skill', inverseLabel: 'used by',
    srcKinds: ['task', 'team_member'], dstKinds: ['skill'], order: 'dst-first',
    registry: { type: 'equips', reverse: false },
  },
  {
    type: 'relates_to', role: 'context', label: 'relates to', inverseLabel: 'relates to',
    srcKinds: ['*'], dstKinds: ['*'], order: 'none',
    registry: { type: 'relates_to', reverse: false },
  },
];

/**
 * Spellings agents reach for, folded onto the canonical type. `reverse`
 * swaps the endpoints: `{src: ada, dst: t1, type: works_on}` IS
 * `{src: t1, dst: ada, type: assigned_to}`. Aliases are read, never written:
 * the prompt teaches the canonical names.
 */
export const ORCHESTRATION_EDGE_ALIASES: Readonly<Record<string, { type: string; reverse: boolean }>> = {
  works_on: { type: 'assigned_to', reverse: true },
  working_on: { type: 'assigned_to', reverse: true },
  owns: { type: 'assigned_to', reverse: true },
  outputs: { type: 'produces', reverse: false },
  writes: { type: 'produces', reverse: false },
  creates: { type: 'produces', reverse: false },
  produced_by: { type: 'produces', reverse: true },
  reads: { type: 'consumes', reverse: false },
  uses: { type: 'consumes', reverse: false },
  feeds: { type: 'consumes', reverse: true },
  input_to: { type: 'consumes', reverse: true },
  consumed_by: { type: 'consumes', reverse: true },
  blocked_by: { type: 'depends_on', reverse: false },
  requires: { type: 'depends_on', reverse: false },
  after: { type: 'depends_on', reverse: false },
  blocks: { type: 'depends_on', reverse: true },
  before: { type: 'depends_on', reverse: true },
  precedes: { type: 'depends_on', reverse: true },
  uses_skill: { type: 'equips', reverse: false },
  reviews: { type: 'relates_to', reverse: false },
  related_to: { type: 'relates_to', reverse: false },
};

const EDGE_TYPES = new Map(ORCHESTRATION_EDGE_TYPES.map((t) => [t.type, t]));

/** `"Depends On"`, `"depends-on"`, `"dependsOn"` → `"depends_on"`. */
export function normalizeEdgeTypeName(type: string): string {
  return type
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export interface ResolvedEdgeType {
  /** The canonical definition, or null for a type the vocabulary does not know. */
  def: OrchestrationEdgeType | null;
  /** True ⇒ the stored src/dst are the canonical dst/src. */
  reversed: boolean;
  /** The canonical name, or the normalized unknown name (`''` when absent). */
  type: string;
  /** The alias the row actually spelled, when it was one. */
  alias: string | null;
}

export function resolveEdgeType(type: string | null | undefined): ResolvedEdgeType {
  const name = typeof type === 'string' ? normalizeEdgeTypeName(type) : '';
  const direct = EDGE_TYPES.get(name);
  if (direct) return { def: direct, reversed: false, type: direct.type, alias: null };
  const alias = ORCHESTRATION_EDGE_ALIASES[name];
  if (alias) return { def: EDGE_TYPES.get(alias.type) ?? null, reversed: alias.reverse, type: alias.type, alias: name };
  return { def: null, reversed: false, type: name, alias: null };
}

export function kindAllowed(allowed: readonly string[], kind: string): boolean {
  return allowed.includes('*') || allowed.includes(kind);
}

// ─── Reading a row ─────────────────────────────────────────────────────────────

/**
 * THE PINNED NODE SHAPE, resolved in ONE place (see `GraphNode` in
 * contract.ts): a node is a reference iff it carries `ref` (or the legacy
 * `entityId`); the one legacy branch reads a bare UUID-form `id` as the ref
 * only when no `spec` is present. The UI and the server both read nodes
 * through these two functions, so they can never disagree about what a node is.
 */
const ENTITY_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NodeLike {
  key?: unknown; id?: unknown; ref?: unknown; entityId?: unknown;
  spec?: unknown;
}
interface EdgeLike { src?: unknown; dst?: unknown; type?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function graphNodeRef(node: NodeLike): EntityId | null {
  const ref = str(node.ref) ?? str(node.entityId);
  if (ref) return ref as EntityId;
  if (node.spec && typeof node.spec === 'object') return null;
  const bare = str(node.id) ?? str(node.key);
  return bare && ENTITY_ID_FORM.test(bare) ? (bare as EntityId) : null;
}

/** The row-local key edges name: `key` (legacy, wins) → `id` → the ref → `#index`. */
export function graphNodeKey(node: NodeLike, index: number): string {
  return str(node.key) ?? str(node.id) ?? graphNodeRef(node) ?? `#${index}`;
}

/**
 * An edge's stable key within one row version. The index keeps two identical
 * edges distinct; the rest makes the key readable in a finding.
 */
export function graphEdgeKey(edge: EdgeLike, index: number): string {
  return `${str(edge.src) ?? ''}:${str(edge.dst) ?? ''}:${str(edge.type) ?? ''}:${index}`;
}

/**
 * MATERIALIZED = a spec that now also carries `ref`. The spec is KEPT as the
 * plan's provenance (what was asked for), the ref says what was built. This is
 * the linkage the orchestrator writes back — see `GraphContentLinks`.
 */
export function graphNodeMaterialized(node: NodeLike): boolean {
  return graphNodeRef(node) !== null && !!node.spec && typeof node.spec === 'object';
}

/**
 * THE MATERIALIZE LINK DOOR. A graph patch may carry `link: {nodeId: entityId}`
 * instead of restating every node: the server sets `ref` on each named node
 * (its `spec` kept) under the patch's `expectedVersion`. A key naming no node,
 * or a value that is not an entity id, refuses the patch by name.
 */
export type GraphContentLinks = Record<string, EntityId>;

export function applyGraphLinks<N extends NodeLike>(
  nodes: readonly N[],
  links: Readonly<Record<string, unknown>>,
): { nodes: N[]; unknownKeys: string[]; invalidRefs: string[] } {
  const keys = nodes.map((node, index) => graphNodeKey(node, index));
  const known = new Set(keys);
  const unknownKeys = Object.keys(links).filter((key) => !known.has(key));
  const invalidRefs = Object.entries(links)
    .filter(([, ref]) => typeof ref !== 'string' || !ENTITY_ID_FORM.test(ref))
    .map(([key]) => key);
  const next = nodes.map((node, index) => {
    const ref = links[keys[index] as string];
    if (typeof ref !== 'string') return node;
    /* A legacy `key`-only node keeps its key; a node with neither gets `id`, so
       the key edges named survives the ref being added (the ref would
       otherwise become the key and orphan them). */
    const needsId = str(node.key) === null && str(node.id) === null;
    const { entityId: _legacy, ...rest } = node as N & { entityId?: unknown };
    return { ...rest, ...(needsId ? { id: keys[index] } : {}), ref } as N;
  });
  return { nodes: next, unknownKeys, invalidRefs };
}

// ─── Node mentions ─────────────────────────────────────────────────────────────

/**
 * HOW A TURN NAMES A BLUEPRINT NODE: `[<title>](tm8://node/<graphId>/<nodeId>)`.
 *
 * The composer's one reference convention (`fileReference` → `tm8://file/`),
 * so it degrades to readable text anywhere markdown is not rendered. It
 * carries the graph id because node ids are row-local, and it is the SAME
 * form for spec, ref and materialized nodes — the agent reads the ref off the
 * row. The UI seeds it, the craft prompt is built from it, and both import
 * this pair, so the spelling cannot drift (coordinator ruling 2026-09-24).
 */
export const BLUEPRINT_NODE_URI = 'tm8://node/';

export interface NodeMention { graphId: string; nodeId: string; title: string }

/** `[<title>](tm8://node/<graphId>/<nodeId>)`; `]` and `\` in the title are escaped. */
export function blueprintNodeRef(graphId: string, nodeId: string, title?: string | null): string {
  const text = (title ?? '').trim() || nodeId;
  const label = text.replace(/([[\]\\])/g, '\\$1');
  return `[${label}](${BLUEPRINT_NODE_URI}${encodeURIComponent(graphId)}/${encodeURIComponent(nodeId)})`;
}

const decode = (v: string): string => { try { return decodeURIComponent(v); } catch { return v; } };

/** The link TARGET → `{graphId, nodeId}`, or null when it is not a node link. */
export function parseBlueprintNodeRef(href: string): { graphId: string; nodeId: string } | null {
  if (!href.startsWith(BLUEPRINT_NODE_URI)) return null;
  const match = /^([^/\s)]+)\/([^/\s)]+)$/.exec(href.slice(BLUEPRINT_NODE_URI.length));
  return match ? { graphId: decode(match[1] as string), nodeId: decode(match[2] as string) } : null;
}

const NODE_MENTION = /\[((?:\\.|[^\]\\])*)\]\((tm8:\/\/node\/[^\s)]+)\)/g;

/** Every node link in a turn's TEXT, in order, titles unescaped. */
export function parseNodeMentions(text: string): NodeMention[] {
  const out: NodeMention[] = [];
  for (const match of text.matchAll(NODE_MENTION)) {
    const target = parseBlueprintNodeRef(match[2] as string);
    if (target) out.push({ ...target, title: (match[1] as string).replace(/\\([[\]\\])/g, '$1') });
  }
  return out;
}

// ─── Coherence ─────────────────────────────────────────────────────────────────

export type CoherenceSeverity = 'error' | 'warning' | 'info';

export type CoherenceCode =
  | 'duplicate_node_id'
  | 'dangling_edge'
  | 'self_loop'
  | 'duplicate_edge'
  | 'unknown_edge_type'
  | 'aliased_edge_type'
  | 'unknown_node_kind'
  | 'untyped_spec'
  | 'endpoint_mismatch'
  | 'dependency_cycle'
  | 'task_unassigned'
  | 'input_without_producer'
  | 'orphan_spec';

export interface CoherenceFinding {
  code: CoherenceCode;
  severity: CoherenceSeverity;
  /** One sentence a human or an agent can act on, naming the node ids. */
  message: string;
  /** Row-local node keys this is about — the UI pins the finding on them. */
  nodes: string[];
  /** Edge keys (`graphEdgeKey`) this is about. */
  edges: string[];
}

export interface CoherenceOptions {
  /** Kinds of referenced entities, when the caller has resolved them. */
  refKind?: (ref: EntityId) => string | undefined;
}

const SEVERITY_RANK: Record<CoherenceSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * THE COHERENCE CHECK — pure, total, shared by the canvas and the server.
 *
 * It never throws on a malformed row (lean by law: whatever the row holds is
 * read as far as it can be) and never refuses anything: it REPORTS, ordered
 * error → warning → info, then by first node key, so two runs over the same
 * row print the same list.
 */
export function checkGraphCoherence(content: unknown, options: CoherenceOptions = {}): CoherenceFinding[] {
  const c = (content ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(c['nodes']) ? (c['nodes'] as unknown[]) : [];
  const rawEdges = Array.isArray(c['edges']) ? (c['edges'] as unknown[]) : [];
  const findings: CoherenceFinding[] = [];
  const add = (f: CoherenceFinding) => findings.push(f);

  interface N { key: string; ref: EntityId | null; kind: string | null; isSpec: boolean; title: string }
  const nodes: N[] = [];
  const seen = new Map<string, number>();
  rawNodes.forEach((raw, index) => {
    const node = (raw && typeof raw === 'object' ? raw : {}) as NodeLike & { spec?: Record<string, unknown> };
    const key = graphNodeKey(node, index);
    const ref = graphNodeRef(node);
    const spec = node.spec && typeof node.spec === 'object' ? node.spec : null;
    const kind = (ref ? options.refKind?.(ref) : undefined) ?? str(spec?.['kind']);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    nodes.push({ key, ref, kind: kind ?? null, isSpec: ref === null, title: str(spec?.['title']) ?? key });
  });
  seen.forEach((count, key) => {
    if (count > 1) {
      add({ code: 'duplicate_node_id', severity: 'error', nodes: [key], edges: [],
        message: `${count} nodes share the id "${key}"; edges naming it cannot tell them apart.` });
    }
  });
  const byKey = new Map<string, N>();
  nodes.forEach((n) => { if (!byKey.has(n.key)) byKey.set(n.key, n); });

  nodes.forEach((n) => {
    if (!n.kind) {
      if (n.isSpec) {
        add({ code: 'untyped_spec', severity: 'warning', nodes: [n.key], edges: [],
          message: `Spec "${n.key}" has no kind; the orchestrator cannot tell what to create.` });
      }
    } else if (!orchestrationNodeKind(n.kind)) {
      add({ code: 'unknown_node_kind', severity: 'info', nodes: [n.key], edges: [],
        message: `"${n.key}" is a ${n.kind}, which the orchestration vocabulary does not know; it still renders.` });
    }
  });

  /* Canonicalise every edge once: endpoint keys in CANONICAL direction. */
  interface E { key: string; src: string; dst: string; type: string; def: OrchestrationEdgeType | null }
  const edges: E[] = [];
  const edgeSeen = new Map<string, string>();
  rawEdges.forEach((raw, index) => {
    const edge = (raw && typeof raw === 'object' ? raw : {}) as EdgeLike;
    const key = graphEdgeKey(edge, index);
    const s = str(edge.src);
    const d = str(edge.dst);
    const missing = [s, d].filter((k): k is string => k !== null && !byKey.has(k));
    if (!s || !d || missing.length > 0) {
      add({ code: 'dangling_edge', severity: 'error', nodes: [], edges: [key],
        message: !s || !d
          ? `Edge ${index} is missing its ${!s ? 'src' : 'dst'}.`
          : `Edge ${index} names ${missing.map((m) => `"${m}"`).join(' and ')}, which no node carries.` });
      return;
    }
    const resolved = resolveEdgeType(str(edge.type));
    const [src, dst] = resolved.reversed ? [d, s] : [s, d];
    if (src === dst) {
      add({ code: 'self_loop', severity: 'warning', nodes: [src], edges: [key],
        message: `"${src}" has an edge to itself.` });
      return;
    }
    const identity = `${src}\u0000${dst}\u0000${resolved.type}`;
    const first = edgeSeen.get(identity);
    if (first !== undefined) {
      add({ code: 'duplicate_edge', severity: 'info', nodes: [src, dst], edges: [first, key],
        message: `"${src}" → "${dst}" (${resolved.type || 'untyped'}) is drawn twice.` });
    } else {
      edgeSeen.set(identity, key);
    }
    if (resolved.alias) {
      add({ code: 'aliased_edge_type', severity: 'info', nodes: [s, d], edges: [key],
        message: `"${resolved.alias}" is read as ${resolved.reversed
          ? `"${d}" ${resolved.type} "${s}"` : `"${s}" ${resolved.type} "${d}"`}; write that instead.` });
    }
    if (!resolved.def) {
      add({ code: 'unknown_edge_type', severity: 'info', nodes: [s, d], edges: [key],
        message: resolved.type
          ? `Edge type "${resolved.type}" is not in the vocabulary; it renders as a plain link and materializes as relates_to.`
          : `Edge "${s}" → "${d}" has no type; it renders as a plain link.` });
    } else {
      const sk = byKey.get(src)?.kind;
      const dk = byKey.get(dst)?.kind;
      const badSrc = sk && !kindAllowed(resolved.def.srcKinds, sk);
      const badDst = dk && !kindAllowed(resolved.def.dstKinds, dk);
      if (badSrc || badDst) {
        add({ code: 'endpoint_mismatch', severity: 'warning', nodes: [src, dst], edges: [key],
          message: `"${resolved.def.type}" runs ${resolved.def.srcKinds.join('|')} → ${resolved.def.dstKinds.join('|')}, `
            + `but "${src}" is a ${sk ?? '?'} and "${dst}" is a ${dk ?? '?'}.` });
      }
    }
    edges.push({ key, src, dst, type: resolved.type, def: resolved.def });
  });

  /* CYCLES in the precedence graph (flow + dependency orders). Tarjan's SCC,
     iterated in row order so the report is deterministic. */
  const succ = new Map<string, { to: string; edge: string }[]>();
  edges.forEach((e) => {
    const role = e.def?.role;
    if (role !== 'flow' && role !== 'dependency') return;
    const [a, b] = e.def?.order === 'dst-first' ? [e.dst, e.src] : [e.src, e.dst];
    const list = succ.get(a) ?? [];
    list.push({ to: b, edge: e.key });
    succ.set(a, list);
  });
  for (const scc of stronglyConnected([...byKey.keys()], succ)) {
    if (scc.length < 2) continue;
    const members = new Set(scc);
    const cycleEdges = scc.flatMap((k) => (succ.get(k) ?? []).filter((s) => members.has(s.to)).map((s) => s.edge));
    add({ code: 'dependency_cycle', severity: 'error', nodes: scc, edges: cycleEdges,
      message: `${scc.map((k) => `"${k}"`).join(', ')} depend on each other in a loop; nothing in it can start first.` });
  }

  /* PLAN GAPS — only for SPECS: a referenced entity already exists and may be
     wired outside this row, so the blueprint cannot judge it. */
  const touching = new Map<string, E[]>();
  edges.forEach((e) => {
    [e.src, e.dst].forEach((k) => touching.set(k, [...(touching.get(k) ?? []), e]));
  });
  nodes.forEach((n) => {
    if (!n.isSpec || byKey.get(n.key) !== n) return;
    const mine = touching.get(n.key) ?? [];
    if (mine.length === 0) {
      add({ code: 'orphan_spec', severity: 'warning', nodes: [n.key], edges: [],
        message: `Spec "${n.key}" is not connected to anything.` });
    }
    if (n.kind === 'task' && !mine.some((e) => e.def?.role === 'assignment' && e.src === n.key)) {
      add({ code: 'task_unassigned', severity: 'warning', nodes: [n.key], edges: [],
        message: `Task "${n.key}" has no assignee (assigned_to a teammate).` });
    }
    if (n.kind && OUTPUTS.includes(n.kind as typeof OUTPUTS[number])) {
      const consumed = mine.filter((e) => e.type === 'consumes' && e.dst === n.key);
      const produced = mine.some((e) => e.type === 'produces' && e.dst === n.key);
      if (consumed.length > 0 && !produced) {
        add({ code: 'input_without_producer', severity: 'warning', nodes: [n.key], edges: consumed.map((e) => e.key),
          message: `"${n.key}" is consumed but nothing produces it, and it does not exist yet.` });
      }
    }
  });

  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map(({ f }) => f);
}

function stronglyConnected(order: string[], succ: Map<string, { to: string }[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  /* Iterative Tarjan: a 1 000-task chain must not blow the JS stack. */
  for (const root of order) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, counter); low.set(root, counter); counter += 1;
    stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { v: string; i: number };
      const next = succ.get(frame.v) ?? [];
      if (frame.i < next.length) {
        const w = (next[frame.i] as { to: string }).to;
        frame.i += 1;
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter += 1;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v) as number, index.get(w) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v) as number, low.get(frame.v) as number));
      if (low.get(frame.v) === index.get(frame.v)) {
        const scc: string[] = [];
        let w: string | undefined;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          scc.push(w);
        } while (w !== frame.v);
        out.push(scc.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
      }
    }
  }
  return out.sort((a, b) => order.indexOf(a[0] as string) - order.indexOf(b[0] as string));
}
