import {
  CollabError,
  type EdgeView,
  type GraphQuery,
  type GraphResult,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import type { OperationHandler } from '../../../http/types.js';
import { claimsFor, commandEnvelope, limitOf, MAX_LIMIT, optionalUuid } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { actorOf, loadActors } from '../../entity-read.js';
import type { HandlerRegistry } from '../../registry.js';
import { collectionsQuery, queryCollection } from '../collections.js';
import { toCommandResult, type RpcCommandResult } from '../entities.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GRAPH_HOPS = 3;
const MAX_GRAPH_EDGES = 1_000;

interface GraphEdgeRow {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  props: Record<string, unknown>;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  resolved: boolean;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function validateGraphLens(query: GraphQuery): { focusId?: string; hops: number } {
  if (query.focusId && !UUID_RE.test(query.focusId)) {
    throw new CollabError('invalid_input', 'focusId must be a uuid');
  }
  if (query.hops !== undefined && query.focusId === undefined) {
    throw new CollabError('invalid_input', 'hops requires focusId');
  }
  const hops = query.hops ?? 1;
  if (!Number.isInteger(hops) || hops <= 0 || hops > MAX_GRAPH_HOPS) {
    throw new CollabError('invalid_input', `hops must be an integer from 1 to ${MAX_GRAPH_HOPS}`);
  }
  return { ...(query.focusId ? { focusId: query.focusId } : {}), hops };
}

/**
 * Build a finite, RLS-filtered graph lens from the same entity semantics as a
 * collection. Candidate reads and edge reads both execute as the caller; the
 * explicit live endpoint joins additionally prevent a tombstone from entering
 * a projection through an otherwise-live edge.
 */
export async function queryGraph(
  q: Querier,
  query: GraphQuery,
  viewerIdentityId: string,
): Promise<GraphResult> {
  const lens = validateGraphLens(query);
  const nodeLimit = limitOf(query.limit);

  // Discover through a hard global ceiling, then apply the caller's smaller
  // output bound after traversal. This avoids making `limit: 10` mean "focus
  // must happen to be in the first ten items" while keeping every read finite.
  const candidates = await queryCollection(
    q,
    {
      ...query,
      filters: { ...query.filters, deleted: 'exclude' },
      limit: MAX_LIMIT,
    },
    viewerIdentityId,
    'graph.query',
  );
  const candidateNodes = candidates.page.items;
  if (candidateNodes.length === 0) return { nodes: [], edges: [], clusters: [] };

  const candidateIds = candidateNodes.map((node) => node.id);
  const effectiveEdgeTypes = query.mode === 'dependency'
    ? ['depends_on']
    : [...new Set((query.edgeTypes ?? []).filter(Boolean))];

  const loadEdges = async (
    endpointIds: readonly string[],
    frontierIds?: readonly string[],
  ): Promise<GraphEdgeRow[]> => {
    const params: unknown[] = [query.spaceId, endpointIds];
    const predicates: string[] = [];
    if (effectiveEdgeTypes.length > 0) {
      params.push(effectiveEdgeTypes);
      predicates.push(`g.type = any($${params.length}::text[])`);
    }
    if (frontierIds) {
      params.push(frontierIds);
      predicates.push(
        `(g.src_id = any($${params.length}::uuid[]) or g.dst_id = any($${params.length}::uuid[]))`,
      );
    }
    const tail = predicates.length > 0 ? `and ${predicates.join('\n        and ')}` : '';
    return q.query<GraphEdgeRow>(
      `select g.id, g.src_id, g.dst_id, g.type, g.props, g.created_by,
              g.created_at, g.updated_at, internal.is_resolved(g.dst_id) resolved
         from public.edges g
         join public.entities src on src.id = g.src_id and src.deleted_at is null
         join public.entities dst on dst.id = g.dst_id and dst.deleted_at is null
        where g.space_id = $1
          and g.src_id = any($2::uuid[])
          and g.dst_id = any($2::uuid[])
          ${tail}
        order by g.created_at, g.id
        limit ${MAX_GRAPH_EDGES}`,
      params,
    );
  };

  const candidateById = new Map(candidateNodes.map((node) => [node.id, node]));
  let selectedIds: string[];
  if (lens.focusId) {
    if (!candidateById.has(lens.focusId)) return { nodes: [], edges: [], clusters: [] };
    const visited = new Set<string>([lens.focusId]);
    let frontier = [lens.focusId];
    for (let depth = 0; depth < lens.hops && frontier.length > 0 && visited.size < nodeLimit; depth += 1) {
      const traversalEdges = await loadEdges(candidateIds, frontier);
      const next: string[] = [];
      const frontierSet = new Set(frontier);
      const neighbors = new Set<string>();
      for (const edge of traversalEdges) {
        if (frontierSet.has(edge.src_id)) neighbors.add(edge.dst_id);
        if (frontierSet.has(edge.dst_id)) neighbors.add(edge.src_id);
      }
      for (const neighbor of [...neighbors].sort()) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          next.push(neighbor);
          if (visited.size >= nodeLimit) break;
      }
      frontier = next;
    }
    selectedIds = [...visited];
  } else {
    selectedIds = candidateIds.slice(0, nodeLimit);
  }

  const selected = new Set(selectedIds);
  const nodes = selectedIds
    .map((id) => candidateById.get(id))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);
  // Return the complete induced edge set for the chosen nodes, not merely the
  // traversal edges that happened to discover them.
  const edgeRows = await loadEdges(selectedIds);
  const visibleEdgeRows = edgeRows.filter(
    (edge) => selected.has(edge.src_id) && selected.has(edge.dst_id),
  );
  const actors = await loadActors(q, visibleEdgeRows.map((edge) => edge.created_by));
  const edges: EdgeView[] = visibleEdgeRows.map((edge) => ({
    id: edge.id,
    type: edge.type,
    source: candidateById.get(edge.src_id)!,
    target: candidateById.get(edge.dst_id)!,
    props: edge.props ?? {},
    createdBy: actorOf(actors, edge.created_by),
    createdAt: iso(edge.created_at),
    updatedAt: iso(edge.updated_at),
    ...(edge.type === 'depends_on'
      ? {
          resolved: edge.resolved,
          hard: edge.props?.hard === undefined ? true : edge.props.hard === true,
        }
      : {}),
  }));

  const clustersByParent = new Map<string, string[]>();
  for (const node of nodes) {
    const parentId = node.parentId;
    if (!parentId || !selected.has(parentId)) continue;
    const children = clustersByParent.get(parentId);
    if (children) children.push(node.id);
    else clustersByParent.set(parentId, [node.id]);
  }
  const clusters = [...clustersByParent]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([parentId, childIds]) => ({ parentId, childIds: childIds.sort() }));

  return { nodes, edges, clusters };
}

export function graphQuery(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    return deps.db.tx(claimsFor(owner, ctx), (q) => (
      queryGraph(q, ctx.body as GraphQuery, owner.identityId)
    ));
  };
}

interface UndoInput {
  token: string;
  actorId?: string;
  clientMutationId?: string;
}

function undoInput(body: unknown): UndoInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CollabError('invalid_input', 'undo body must be an object');
  }
  const input = body as Record<string, unknown>;
  if (typeof input.token !== 'string' || input.token.length < 8 || input.token.length > 200) {
    throw new CollabError('invalid_input', 'token must be an opaque undo token');
  }
  const actorId = optionalUuid(input.actorId, 'actorId');
  if (input.clientMutationId !== undefined && (
    typeof input.clientMutationId !== 'string' || input.clientMutationId.trim().length === 0
  )) {
    throw new CollabError('invalid_input', 'clientMutationId must be a non-empty string');
  }
  return {
    token: input.token,
    ...(actorId ? { actorId } : {}),
    ...(typeof input.clientMutationId === 'string'
      ? { clientMutationId: input.clientMutationId }
      : {}),
  };
}

export function commandsUndo(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const input = undoInput(ctx.body);
    const envelope = commandEnvelope(ctx);
    return deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('undo_command', [
        input.token,
        input.actorId ?? null,
        input.clientMutationId ?? null,
      ]);
      return toCommandResult(q, raw, owner.identityId);
    });
  };
}

/** The integration worker's single registration seam for W2.G05. */
export function registerW2CollectionsGraphUndoHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  registry.registerAll({
    'collections.query': collectionsQuery(deps),
    'graph.query': graphQuery(deps),
    'commands.undo': commandsUndo(deps),
  });
}
