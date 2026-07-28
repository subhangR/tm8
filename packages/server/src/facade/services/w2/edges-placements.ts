import { createHash } from 'node:crypto';

import {
  CollabError,
  decodeCursor,
  encodeCursor,
  isCollabError,
  type CommandResult,
  type CreateEdgeInput,
  type EdgeView,
  type Page,
  type PatchEdgeInput,
  type PlacementInput,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, limitOf, optionalUuid, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import {
  MICROS,
  actorOf,
  assembleSummaries,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  iso,
  loadActors,
  type EntityRow,
} from '../../entity-read.js';
import { toCommandResult, type RpcCommandResult } from '../../handlers/entities.js';

type EdgeDirection = 'incoming' | 'outgoing';

interface EdgeRow {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  props: Record<string, unknown>;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  /**
   * Microsecond TEXT from `to_char`, REQUIRED. Optionality was half the
   * fragility: the `?? iso(...)` fallback made an omission look deliberately
   * tolerated while silently truncating the cursor, and deleting that fallback
   * was worth doing on its own.
   *
   * ⚠ BUT REQUIRING IT DOES **NOT** MAKE A FORGOTTEN `to_char` A COMPILE ERROR.
   * This comment claimed it did. `Querier.query<R>` (db/types.ts:45) takes `R`
   * as an UNCHECKED CALLER ASSERTION and never sees a SELECT list, so a query
   * that omits this column typechecks clean and yields `undefined` here. Only
   * an OBJECT-LITERAL producer is checked, and this row only ever comes from
   * SQL. Measured both ways: literal omission → TS2741; SQL omission → exit 0,
   * zero diagnostics.
   *
   * NOT HYPOTHETICAL — `inbox-read-marks.ts` shipped exactly that omission on
   * one of its two producers, and the missing slot became a JSON `null` that
   * the same file's own decoder then rejected, so the server handed out a
   * cursor it would not accept.
   *
   * SO THE INVARIANT IS HELD BY THE PRODUCERS, NOT BY THE COMPILER.
   * `sortKeyOf` (handlers/collections.ts) is the shape that actually refuses at
   * runtime rather than trusting its callers.
   */
  cursor_created_at: string;
  resolved: boolean | null;
}

export interface EdgeTypeView {
  type: string;
  sourceKinds: string[];
  destinationKinds: string[];
  direction: 'directed';
  description: string;
  propsSchema: Record<string, unknown>;
  acyclic: boolean;
}

interface EdgeTypeRow {
  type: string;
  src_kinds: string[];
  dst_kinds: string[];
  description: string;
  props_schema: Record<string, unknown> | null;
  acyclic: boolean;
}

interface NormalizedEdgeQuery {
  source: string | null;
  destination: string | null;
  type: string | null;
  direction: EdgeDirection;
  cursor: string | null;
  limit: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeEdgeQuery(query: URLSearchParams): NormalizedEdgeQuery {
  const source = optionalUuid(query.get('source'), 'source');
  const destination = optionalUuid(query.get('destination'), 'destination');
  const rawType = query.get('type');
  const type = rawType === null ? null : rawType.trim();
  if (type !== null && type.length === 0) {
    throw new CollabError('invalid_input', 'type must be a non-empty edge type');
  }
  const rawDirection = query.get('direction') ?? 'outgoing';
  if (rawDirection !== 'incoming' && rawDirection !== 'outgoing') {
    throw new CollabError('invalid_input', 'direction must be incoming or outgoing');
  }
  return {
    source,
    destination,
    type,
    direction: rawDirection,
    cursor: query.get('cursor'),
    limit: limitOf(query.get('limit')),
  };
}

function edgeFingerprint(query: NormalizedEdgeQuery): string {
  const canonical = JSON.stringify({
    scope: 'edges.list',
    source: query.source,
    destination: query.destination,
    type: query.type,
    direction: query.direction,
  });
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

function cursorTimestamp(value: unknown): string {
  const timestamp = String(value ?? '');
  if (timestamp.length === 0 || Number.isNaN(Date.parse(timestamp))) {
    throw new CollabError('invalid_cursor', 'invalid edge cursor timestamp');
  }
  return timestamp;
}

function cursorId(value: unknown): string {
  const id = String(value ?? '');
  if (!UUID_RE.test(id)) throw new CollabError('invalid_cursor', 'invalid edge cursor id');
  return id;
}

class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * The public edge list is relative to `source`: incoming reverses the storage
 * endpoints while preserving the actual EdgeView orientation in the result.
 * Both endpoint joins are live and every SELECT executes through caller RLS.
 */
export async function queryEdges(
  q: Querier,
  search: URLSearchParams,
  viewerIdentityId: string,
): Promise<Page<EdgeView>> {
  const query = normalizeEdgeQuery(search);
  const fingerprint = edgeFingerprint(query);
  const params = new Params();
  const where: string[] = [];
  const sourceColumn = query.direction === 'outgoing' ? 'g.src_id' : 'g.dst_id';
  const destinationColumn = query.direction === 'outgoing' ? 'g.dst_id' : 'g.src_id';
  if (query.source) where.push(`${sourceColumn} = ${params.add(query.source)}`);
  if (query.destination) where.push(`${destinationColumn} = ${params.add(query.destination)}`);
  if (query.type) where.push(`g.type = ${params.add(query.type)}`);

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded.k.length !== 3 || decoded.k[0] !== fingerprint) {
      throw new CollabError('invalid_cursor', 'edge cursor does not match this filter');
    }
    const timestamp = params.add(cursorTimestamp(decoded.k[1]));
    const id = params.add(cursorId(decoded.k[2]));
    where.push(`(g.created_at, g.id) < (${timestamp}::timestamptz, ${id}::uuid)`);
  }

  const predicate = where.length > 0 ? `and ${where.join('\n          and ')}` : '';
  const rows = await q.query<EdgeRow>(
    `select g.id, g.src_id, g.dst_id, g.type, g.props, g.created_by,
            g.created_at, g.updated_at,
            ${MICROS('g.created_at')} cursor_created_at,
            case when g.type = 'depends_on' then internal.is_resolved(g.dst_id) else null end resolved
       from public.edges g
       join public.entities src on src.id = g.src_id and src.deleted_at is null
       join public.entities dst on dst.id = g.dst_id and dst.deleted_at is null
      where true
        ${predicate}
      order by g.created_at desc, g.id desc
      limit ${query.limit + 1}`,
    params.values,
  );
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  if (pageRows.length === 0) return { items: [], nextCursor: null };

  const endpointIds = [...new Set(pageRows.flatMap((row) => [row.src_id, row.dst_id]))];
  const endpointRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
      where e.id = any($1::uuid[]) and e.deleted_at is null`,
    [endpointIds],
  );
  const summaries = new Map(
    (await assembleSummaries(q, endpointRows, viewerIdentityId)).map((summary) => [summary.id, summary]),
  );
  const actors = await loadActors(q, pageRows.map((row) => row.created_by));
  const items = pageRows.flatMap((row): EdgeView[] => {
    const source = summaries.get(row.src_id);
    const target = summaries.get(row.dst_id);
    if (!source || !target) return [];
    const hard = row.type === 'depends_on'
      ? (row.props?.hard === undefined ? true : row.props.hard === true)
      : undefined;
    return [{
      id: row.id,
      type: row.type,
      source,
      target,
      props: row.props ?? {},
      createdBy: actorOf(actors, row.created_by),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.resolved === null ? {} : { resolved: row.resolved }),
      ...(hard === undefined ? {} : { hard }),
    }];
  });
  const last = pageRows.at(-1)!;
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor([fingerprint, last.cursor_created_at, last.id])
      : null,
  };
}

export async function listEdgeTypes(q: Querier): Promise<EdgeTypeView[]> {
  const rows = await q.query<EdgeTypeRow>(
    `select type, src_kinds, dst_kinds, description, props_schema, acyclic
       from public.edge_types
      order by type`,
  );
  return rows.map((row) => ({
    type: row.type,
    sourceKinds: row.src_kinds,
    destinationKinds: row.dst_kinds,
    direction: 'directed',
    description: row.description,
    propsSchema: row.props_schema ?? { type: 'object' },
    acyclic: row.acyclic,
  }));
}

function rejectClientOrigin(props: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(props, 'origin')) {
    throw new CollabError('forbidden', 'edge props.origin is Server-owned');
  }
}

function withDerivedEdgeFields(result: CommandResult): CommandResult {
  if (result.edge?.type !== 'depends_on') return result;
  return {
    ...result,
    edge: {
      ...result.edge,
      hard: result.edge.props.hard === undefined ? true : result.edge.props.hard === true,
    },
  };
}

/** Convert W1's frozen plain SQL DETAIL reasons into the dossier wire carrier. */
function normalizeFrozenReason(error: unknown): never {
  if (isCollabError(error)) {
    const details = error.details as Record<string, unknown> | undefined;
    const reason = typeof details?.detail === 'string' ? details.detail : undefined;
    if (reason && [
      'attachment_edge_owned',
      'project_not_linked',
      'project_association_cap',
    ].includes(reason)) {
      const { detail: _detail, ...rest } = details ?? {};
      throw new CollabError(error.code, error.message, {
        details: { ...rest, reason },
        current: error.current,
      });
    }
  }
  throw error;
}

export class W2EdgesPlacementsService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly listEdges = async (ctx: RequestContext): Promise<Page<EdgeView>> => {
    const owner = await this.deps.owner();
    return this.deps.db.tx(claimsFor(owner, ctx), (q) => queryEdges(q, ctx.query, owner.identityId));
  };

  readonly listEdgeTypes = async (ctx: RequestContext): Promise<EdgeTypeView[]> => {
    const owner = await this.deps.owner();
    return this.deps.db.tx(claimsFor(owner, ctx), listEdgeTypes);
  };

  readonly createEdge = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const input = ctx.body as CreateEdgeInput;
    const envelope = commandEnvelope(ctx);
    rejectClientOrigin(input.props ?? {});
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const raw = await q.rpc<RpcCommandResult>('write_edge', [
          input.srcId,
          input.dstId,
          input.type,
          JSON.stringify(input.props ?? {}),
          envelope.actorId ?? null,
          envelope.clientMutationId ?? null,
        ]);
        return withDerivedEdgeFields(await toCommandResult(q, raw, owner.identityId));
      });
    } catch (error) {
      normalizeFrozenReason(error);
    }
  };

  readonly patchEdge = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const edgeId = requireUuidParam(ctx, 'edgeId');
    const input = ctx.body as PatchEdgeInput;
    const envelope = commandEnvelope(ctx);
    rejectClientOrigin(input.props);
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const raw = await q.rpc<RpcCommandResult>('update_edge', [
          edgeId,
          JSON.stringify(input.props),
          envelope.actorId ?? null,
          envelope.clientMutationId ?? null,
        ]);
        return withDerivedEdgeFields(await toCommandResult(q, raw, owner.identityId));
      });
    } catch (error) {
      normalizeFrozenReason(error);
    }
  };

  readonly deleteEdge = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const edgeId = requireUuidParam(ctx, 'edgeId');
    const envelope = commandEnvelope(ctx);
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const raw = await q.rpc<RpcCommandResult>('delete_edge', [
          edgeId,
          envelope.actorId ?? null,
          envelope.clientMutationId ?? null,
        ]);
        return withDerivedEdgeFields(await toCommandResult(q, raw, owner.identityId));
      });
    } catch (error) {
      normalizeFrozenReason(error);
    }
  };

  readonly applyPlacement = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const input = ctx.body as PlacementInput;
    const envelope = commandEnvelope(ctx);
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const raw = await q.rpc<RpcCommandResult>('place_entity', [
          input.sourceId,
          input.targetId,
          input.intent,
          input.embedMessage ?? null,
          null,
          envelope.actorId ?? null,
          envelope.clientMutationId ?? null,
        ]);
        return withDerivedEdgeFields(await toCommandResult(q, raw, owner.identityId));
      });
    } catch (error) {
      normalizeFrozenReason(error);
    }
  };
}
