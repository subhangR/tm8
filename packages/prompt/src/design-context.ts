/**
 * Run on a design (Craft → Designs, migration 302; change list items 5-6): the
 * design a launch was started on, carried on the manifest so EVERY frame (the
 * default v1 frame, v2, `tm8 worker init`, resume) renders the same hand-over.
 *
 * A design is an ordered set of PAGES (graphs, docs, artifacts, drawings,
 * other designs). Run → the launch sheet → a session whose task is derived
 * from the design. The spawn path reads the design once, as the spawner, and
 * folds its ordered pages (nested designs to a fixed depth) into this bounded
 * shape. Every title in it is graph content, so it renders inside
 * `<untrusted_data>`; the trusted parts are ids, kinds and the standing
 * instruction, which this module owns.
 *
 * THE STANDING INSTRUCTION. Run CREATES only what the design's graph pages
 * describe — each graph page is a blueprint (a PLAN, nothing materialized
 * while crafting) — and nothing else unless the launch text says so. It does
 * not start work on what it creates: what happens next is the launch text's
 * call.
 */
import { escapeAttr, untrustedData } from './escape.js';

export interface PromptDesignPage {
  id: string;
  kind: string;
  title: string;
  /** The `contains` edge's `props.position` in its design; null when unset. */
  position: number | null;
  /** 0 = a page of the launched design; 1+ = a page of a nested design page. */
  depth: number;
  /** The design this page belongs to (the launched design at depth 0). */
  designId: string;
  /** graph pages: the row's `graphType` (`entity` is a blueprint). */
  graphType?: string | null;
}

export interface PromptDesignContext {
  /** The launched design. */
  id: string;
  title: string;
  /** The primary task (derived from the design), or null. */
  taskId: string | null;
  /**
   * `loaded` when the pages were read; otherwise the reason the read failed or
   * timed out — the ref (id, title) still renders, the pages do not, and the
   * spawn never fails over it.
   */
  snapshot: 'loaded' | string;
  description?: string;
  /** Pages in page order, nested design pages right after their design. */
  pages?: PromptDesignPage[];
  /** Live pages of the launched design itself. */
  pageCount?: number;
  /**
   * The node kinds a blueprint may name but Run never creates (they are
   * confirmed by a human): `@tm8/contract`'s `confirmOnlyNodeKinds()`, read by
   * the server so this package stays dependency-free.
   */
  confirmOnlyKinds?: string[];
  /** A list was cut (page limit or nesting depth). */
  truncated?: boolean;
}

/** Caps applied when the spawn folds a design into the manifest. */
export const DESIGN_PROMPT_LIMITS = {
  description: 1200,
  title: 200,
  pages: 50,
  depth: 2,
} as const;

const KIND = /^[a-z][a-z0-9_:-]{0,48}$/;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function page(v: unknown): PromptDesignPage | null {
  const r = rec(v);
  const id = str(r?.id);
  const designId = str(r?.designId);
  if (!r || !id || !designId) return null;
  const kind = str(r.kind);
  return {
    id,
    kind: kind && KIND.test(kind) ? kind : 'entity',
    title: str(r.title) ?? '',
    position: typeof r.position === 'number' && Number.isFinite(r.position) ? r.position : null,
    depth: typeof r.depth === 'number' && Number.isInteger(r.depth) && r.depth >= 0 ? r.depth : 0,
    designId,
    ...(r.graphType !== undefined ? { graphType: str(r.graphType) } : {}),
  };
}

/**
 * Tolerant read of a manifest's `design` (the CLI parses manifests from JSON).
 * Anything malformed reads as absent rather than failing `worker init`.
 */
export function parseDesignContext(raw: unknown): PromptDesignContext | undefined {
  const r = rec(raw);
  const id = str(r?.id);
  const taskId = str(r?.taskId);
  if (!r || !id || (!taskId && r.taskId !== null)) return undefined;
  const pages = Array.isArray(r.pages)
    ? r.pages.map(page).filter((p): p is PromptDesignPage => p !== null).slice(0, DESIGN_PROMPT_LIMITS.pages)
    : undefined;
  const confirmOnly = Array.isArray(r.confirmOnlyKinds)
    ? r.confirmOnlyKinds.filter((k): k is string => typeof k === 'string' && KIND.test(k))
    : undefined;
  return {
    id,
    title: str(r.title) ?? '',
    taskId,
    snapshot: str(r.snapshot) ?? 'unavailable',
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(pages ? { pages } : {}),
    ...(typeof r.pageCount === 'number' ? { pageCount: r.pageCount } : {}),
    ...(confirmOnly && confirmOnly.length > 0 ? { confirmOnlyKinds: confirmOnly } : {}),
    ...(r.truncated === true ? { truncated: true } : {}),
  };
}

function pageLine(p: PromptDesignPage): string {
  const indent = '  '.repeat(p.depth);
  const kind = p.kind === 'graph' && p.graphType ? `graph:${p.graphType}` : p.kind;
  const at = p.position === null ? '' : ` #${p.position}`;
  return `${indent}- ${p.title || '(untitled)'} [${kind}${at}] ${p.id}`;
}

/** The design as plain text, for the inside of the untrusted block. */
export function designContextText(design: PromptDesignContext): string {
  const lines: string[] = [`Design: ${design.title || '(untitled)'}`];
  if (design.description) lines.push('', 'Description:', design.description);
  const pages = design.pages ?? [];
  const total = design.pageCount ?? pages.filter((p) => p.depth === 0).length;
  lines.push('', `Pages, in order (${total}):`);
  if (pages.length === 0) lines.push('- (none)');
  lines.push(...pages.map(pageLine));
  if (design.truncated) lines.push(`- … more pages: read the design with \`tm8 entity context ${design.id}\``);
  return lines.join('\n');
}

/**
 * What Run does with a blueprint page. The materialize language of the craft
 * chat (server `chat/compose.ts`, before Craft → Designs), moved here: Run is
 * now the only path that materializes a blueprint, and it stops before
 * dispatch.
 */
export function blueprintMaterializeSteps(confirmOnlyKinds: readonly string[] = []): string {
  const confirm = confirmOnlyKinds.length > 0
    ? ` ${confirmOnlyKinds.join(', ')} specs are confirmed by a human, never created: ask which existing one to ref.`
    : '';
  return 'For each blueprint page (a `graph` page with graphType "entity"), in page order: '
    + '(1) re-read the row with `tm8 entity get <graph-id> --full --format json`; if its `content.findings` carry an error, say so and do not materialize that page. '
    + '(2) Create one real entity per SPEC node — a node without `ref`; a node that carries `ref` already exists and is never created again — in dependency order, prerequisites before dependents: each task elaborated from its spec into a real description and acceptance criteria naming what it produces; each output a task produces (doc, artifact, memory) as a stub that keeps its spec title and says it is pending, to be written by its producing task.'
    + confirm
    + ' (3) Create one real edge per blueprint edge — same type, same direction. '
    + '(4) After each batch, write the mapping back: patch the graph row with `content.link` {nodeId: createdId} under expectedVersion, so each node gains `ref` and keeps its spec.';
}

/**
 * The standing instruction a Run session carries (D4): create what the graph
 * pages describe, nothing else, and do not start the work.
 */
export function designRunInstruction(design: Pick<PromptDesignContext, 'id' | 'confirmOnlyKinds'>): string {
  return `You were launched on design ${design.id}. Its pages follow as data, in page order; `
    + 'a page is an ordinary entity (a graph, doc, artifact, drawing, or a nested design whose own pages are listed under it). '
    + 'Your job is to CREATE THE ENTITIES ITS GRAPH PAGES DESCRIBE, AND NOTHING ELSE unless the launch text says so. '
    + 'Other pages are context: read them where a blueprint needs them, but create nothing from them. '
    + blueprintMaterializeSteps(design.confirmOnlyKinds ?? [])
    + ' Do NOT dispatch, spawn or start work on anything you create: what happens next is the launch text\'s call, and with none, nobody\'s yet. '
    + `When done, post the node → entity map for each graph page on the design (\`tm8 message send --to ${design.id}\`) and report it on your task.`;
}

/**
 * The rendered hand-over: one trusted `<design>` element carrying ids and the
 * standing instruction, and (`full`) the design as an untrusted block. `full:
 * false` is the compact form a frame falls back to when the whole would cross
 * the combined budget.
 */
export function renderDesignContext(design: PromptDesignContext, full = true): string {
  const loaded = design.snapshot === 'loaded';
  const attrs = [
    `id="${escapeAttr(design.id)}"`,
    ...(design.taskId ? [`task="${escapeAttr(design.taskId)}"`] : []),
    `snapshot="${loaded ? (full ? 'loaded' : 'omitted') : 'unavailable'}"`,
    ...(loaded ? [] : [`reason="${escapeAttr(design.snapshot)}"`]),
  ].join(' ');
  const out = [
    `<design ${attrs}>`,
    `  <instruction>${escapeAttr(designRunInstruction(design))}</instruction>`,
    '</design>',
  ];
  const body = full && loaded ? designContextText(design) : `Design: ${design.title || '(untitled)'}`;
  out.push(untrustedData({
    type: 'design-context',
    body,
    truncated: design.truncated === true || (loaded && !full),
    fetchRef: `tm8 entity context ${design.id}`,
  }));
  return out.join('\n');
}
