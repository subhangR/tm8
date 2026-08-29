/**
 * Untrusted transcript payloads -> small, bounded presentation models.
 *
 * The MCP validates these payloads before returning them, but a durable Chat
 * transcript can outlive or predate the runtime that produced it. The UI does
 * not cast tool JSON into props: it re-checks every field and caps every list.
 */

export const EXPLANATION_TOOL_NAMES = [
  'explain_diagram',
  'explain_graph',
  'explain_code',
  'explain_asset',
] as const;

export type ExplanationToolName = (typeof EXPLANATION_TOOL_NAMES)[number];

export interface DiagramPresentation {
  kind: 'diagram';
  title: string;
  source: string;
  caption?: string;
}

export interface GraphPresentationNode {
  id: string;
  label: string;
  description?: string;
  entityId?: string;
  kind?: string;
}

export interface GraphPresentationEdge {
  from: string;
  to: string;
  label: string;
  basis: 'persisted' | 'inferred' | 'pending';
  edgeId?: string;
  relationshipType?: string;
}

export interface GraphPresentation {
  kind: 'graph';
  title: string;
  caption?: string;
  focusNodeId?: string;
  nodes: GraphPresentationNode[];
  edges: GraphPresentationEdge[];
  /** False while the MCP call is still running; persisted claims stay dotted. */
  verified: boolean;
}

export interface CodePresentationHighlight {
  startLine: number;
  endLine: number;
  label?: string;
  tone: 'focus' | 'note' | 'warning';
}

export interface CodePresentation {
  kind: 'code';
  title: string;
  sourceKind: 'repository' | 'illustrative';
  path?: string;
  language: string;
  code: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  highlights: CodePresentationHighlight[];
}

export interface AssetPresentation {
  kind: 'asset';
  fileEntityId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  alt: string;
  caption?: string;
}

export type ExplanationPresentation =
  | DiagramPresentation
  | GraphPresentation
  | CodePresentation
  | AssetPresentation;

export function explanationToolName(raw: string): ExplanationToolName | null {
  const bare = raw.includes('__') ? raw.slice(raw.lastIndexOf('__') + 2) : raw;
  return (EXPLANATION_TOOL_NAMES as readonly string[]).includes(bare)
    ? bare as ExplanationToolName
    : null;
}

export function durableOutputToolName(raw: string): 'doc_create' | 'doc_update' | 'artifact_create' | null {
  const bare = raw.includes('__') ? raw.slice(raw.lastIndexOf('__') + 2) : raw;
  return bare === 'doc_create' || bare === 'doc_update' || bare === 'artifact_create' ? bare : null;
}

export function explanationPresentation(
  rawName: string,
  args: unknown,
  result: unknown,
): ExplanationPresentation | null {
  const name = explanationToolName(rawName);
  if (!name) return null;
  const resultRecord = findToolRecord(result, name);
  const input = recordOf(args);
  const payload = resultRecord ?? input;
  if (!payload) return null;
  if (name === 'explain_diagram') return diagramOf(payload);
  if (name === 'explain_graph') return graphOf(payload, resultRecord !== null);
  if (name === 'explain_code') return codeOf(payload, resultRecord !== null);
  return resultRecord ? assetOf(payload) : null;
}

function diagramOf(row: Record<string, unknown>): DiagramPresentation | null {
  const title = text(row.title, 200);
  const source = text(row.source, 128 * 1024, true);
  if (!title || source === null) return null;
  return {
    kind: 'diagram', title, source,
    ...(text(row.caption, 2_000) ? { caption: text(row.caption, 2_000)! } : {}),
  };
}

function graphOf(row: Record<string, unknown>, verified: boolean): GraphPresentation | null {
  const title = text(row.title, 200);
  if (!title || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) return null;
  const nodes = row.nodes.slice(0, 16).flatMap((raw): GraphPresentationNode[] => {
    const node = recordOf(raw);
    const id = text(node?.id, 80);
    const label = text(node?.label, 160);
    if (!node || !id || !label) return [];
    return [{
      id, label,
      ...(text(node.description, 500) ? { description: text(node.description, 500)! } : {}),
      ...(text(node.entityId, 100) ? { entityId: text(node.entityId, 100)! } : {}),
      ...(text(node.kind, 80) ? { kind: text(node.kind, 80)! } : {}),
    }];
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodes.length === 0 || nodeIds.size !== nodes.length) return null;
  const edges = row.edges.slice(0, 32).flatMap((raw): GraphPresentationEdge[] => {
    const edge = recordOf(raw);
    const from = text(edge?.from, 80);
    const to = text(edge?.to, 80);
    const label = text(edge?.label, 120);
    const rawBasis = edge?.basis;
    if (!edge || !from || !to || !label || !nodeIds.has(from) || !nodeIds.has(to)) return [];
    if (rawBasis !== 'persisted' && rawBasis !== 'inferred') return [];
    return [{
      from, to, label,
      basis: rawBasis === 'persisted' && !verified ? 'pending' : rawBasis,
      ...(text(edge.edgeId, 100) ? { edgeId: text(edge.edgeId, 100)! } : {}),
      ...(text(edge.relationshipType, 100) ? { relationshipType: text(edge.relationshipType, 100)! } : {}),
    }];
  });
  const focusNodeId = text(row.focusNodeId, 80);
  return {
    kind: 'graph', title, nodes, edges, verified,
    ...(focusNodeId && nodeIds.has(focusNodeId) ? { focusNodeId } : {}),
    ...(text(row.caption, 2_000) ? { caption: text(row.caption, 2_000)! } : {}),
  };
}

function codeOf(row: Record<string, unknown>, normalized: boolean): CodePresentation | null {
  const code = text(row.code, 128 * 1024, true);
  if (code === null) return null;
  const sourceKind = row.sourceKind === 'repository' || row.path
    ? 'repository'
    : 'illustrative';
  // A repository-path call has no exact bytes until the MCP returns them.
  if (sourceKind === 'repository' && !normalized) return null;
  const startLine = integer(row.startLine) ?? 1;
  const lineCount = code.split('\n').length;
  const endLine = integer(row.endLine) ?? startLine + lineCount - 1;
  const totalLines = integer(row.totalLines) ?? lineCount;
  const highlights = Array.isArray(row.highlights)
    ? row.highlights.slice(0, 24).flatMap((raw): CodePresentationHighlight[] => {
        const item = recordOf(raw);
        const first = integer(item?.startLine);
        const last = integer(item?.endLine);
        if (!item || first === null || last === null || first > last) return [];
        const tone = item.tone === 'warning' || item.tone === 'note' ? item.tone : 'focus';
        return [{
          startLine: first, endLine: last, tone,
          ...(text(item.label, 500) ? { label: text(item.label, 500)! } : {}),
        }];
      })
    : [];
  return {
    kind: 'code',
    title: text(row.title, 200) ?? text(row.path, 4_096) ?? 'Illustrative code',
    sourceKind,
    ...(text(row.path, 4_096) ? { path: text(row.path, 4_096)! } : {}),
    language: text(row.language, 80) ?? 'text',
    code, startLine, endLine, totalLines, highlights,
  };
}

function assetOf(row: Record<string, unknown>): AssetPresentation | null {
  const fileEntityId = text(row.fileEntityId, 100);
  const name = text(row.name, 1_000);
  const mimeType = text(row.mimeType, 200);
  const sizeBytes = integer(row.sizeBytes);
  if (!fileEntityId || !name || !mimeType || sizeBytes === null) return null;
  return {
    kind: 'asset', fileEntityId, name, mimeType, sizeBytes,
    title: text(row.title, 200) ?? name,
    alt: text(row.alt, 500) ?? name,
    ...(text(row.caption, 2_000) ? { caption: text(row.caption, 2_000)! } : {}),
  };
}

function findToolRecord(raw: unknown, expected: ExplanationToolName): Record<string, unknown> | null {
  let budget = 80;
  const visit = (value: unknown, depth: number): Record<string, unknown> | null => {
    if (budget-- <= 0 || depth > 6 || value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
      try { return visit(JSON.parse(trimmed), depth + 1); } catch { return null; }
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const row = recordOf(value);
    if (!row) return null;
    if (explanationToolName(String(row.tool ?? '')) === expected) return row;
    // Claude's MCP bridge commonly carries the structured result as JSON in
    // `content: [{type:'text', text:'{...}'}]`; `text` is therefore a protocol
    // envelope here, not presentation prose.
    for (const key of ['structuredContent', 'content', 'data', 'text']) {
      const found = visit(row[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(raw, 0);
}

function recordOf(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function text(raw: unknown, max: number, emptyAllowed = false): string | null {
  if (typeof raw !== 'string' || raw.length > max || (!emptyAllowed && raw.trim() === '')) return null;
  return raw;
}

function integer(raw: unknown): number | null {
  return Number.isSafeInteger(raw) && (raw as number) >= 0 ? raw as number : null;
}
