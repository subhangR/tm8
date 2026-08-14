/**
 * Shared entity-read/command-result assembly used by the W2 `entities.*` and
 * `edges.*` service handlers (`facade/services/w2/entities-commands-tracking.ts`
 * and friends): `buildDetail`, `toCommandResult`, and `enrichVersionConflict`.
 */
import {
  CollabError,
  encodeCursor,
  type CommandResult,
  type Connections,
  type EdgeGroup,
  type EdgeView,
  type EntityDetail,
  type EntitySummary,
  type Hierarchy,
  type Page,
} from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, type CommandEnvelope } from '../context.js';
import {
  actorOf,
  assembleSummaries,
  capabilitiesOf,
  contentOf,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  iso,
  loadActors,
  type EntityRow,
} from '../entity-read.js';

/**
 * Fetch one entity for a LIVE read.
 *
 * A tombstone is `not_found` here, matching `internal.live_entity` (007:87):
 * "tombstoned rows are not found by default: only the tombstone-aware read
 * paths see them." `entities.get` is not one of those paths;
 * `collections.query` with `deleted: 'only'` is, and it still surfaces
 * tombstones with their `deletedAt` set. Keeping the two consistent means a
 * soft delete looks like a delete everywhere except where someone explicitly
 * asked to see the graves.
 */
async function fetchRow(q: Querier, id: string): Promise<EntityRow> {
  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1`,
    [id],
  );
  const row = rows[0];
  // RLS makes an unreadable entity indistinguishable from a missing one, which
  // is the right answer to give — it leaks nothing about what exists.
  if (!row) throw new CollabError('not_found', `no such entity: ${id}`);
  if (row.deleted_at !== null) throw new CollabError('not_found', `no such entity: ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// entities.get — the full EntityDetail
// ---------------------------------------------------------------------------

/**
 * Reactions are counters, never connections.
 *
 * `likes`/`dislikes`/`stars` are edges in the schema because that is how a
 * per-viewer reaction is stored, but surfacing them in `connections` would
 * bury the meaningful relationships (assigned_to, depends_on, tracks) under
 * one row per reaction. Conformance asserts their absence (reads.test.ts:44).
 */
const REACTION_EDGE_TYPES = new Set(['likes', 'dislikes', 'stars']);

const EDGE_LABELS: Record<string, string> = {
  assigned_to: 'Assigned to',
  attached_to: 'Attached to',
  depends_on: 'Depends on',
  completed_by: 'Completed by',
  tracks: 'Tracks',
  relates_to: 'Relates to',
  contains: 'Contains',
  working_on: 'Working on',
  pulled: 'Pulled by',
  equips: 'Equips',
  member_of: 'Member of',
  copy_of: 'Copy of',
  approved_by: 'Approved by',
  approval_requested_from: 'Approval requested from',
  visible_to: 'Visible to',
};

function edgeLabel(type: string, direction: 'outgoing' | 'incoming'): string {
  return EDGE_LABELS[type] ?? (direction === 'outgoing' ? type : `${type} (incoming)`);
}

interface EdgeRow {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  props: Record<string, unknown>;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  dst_resolved: boolean | null;
}

async function loadConnections(
  q: Querier,
  row: EntityRow,
  viewerIdentityId: string,
): Promise<Connections> {
  const edgeRows = await q.query<EdgeRow>(
    `select g.id, g.src_id, g.dst_id, g.type, g.props, g.created_by, g.created_at, g.updated_at,
            case when g.type = 'depends_on' then internal.is_resolved(g.dst_id) else null end as dst_resolved
       from public.edges g
      where g.src_id = $1 or g.dst_id = $1
      order by g.type, g.created_at desc, g.id desc`,
    [row.id],
  );

  const visible = edgeRows.filter((e) => !REACTION_EDGE_TYPES.has(e.type));
  if (visible.length === 0) {
    return { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 };
  }

  // Both endpoints of every edge are rendered as summaries, so they are
  // fetched and assembled through the one assembler like everything else.
  const endpointIds = [...new Set(visible.flatMap((e) => [e.src_id, e.dst_id]))];
  const endpointRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    [endpointIds],
  );
  const summaries = new Map(
    (await assembleSummaries(q, endpointRows, viewerIdentityId)).map((s) => [s.id, s]),
  );
  const actors = await loadActors(q, visible.map((e) => e.created_by));

  const toView = (edge: EdgeRow): EdgeView | null => {
    const source = summaries.get(edge.src_id);
    const target = summaries.get(edge.dst_id);
    // An endpoint RLS hid: drop the edge rather than render half of it.
    if (!source || !target) return null;
    const hard =
      edge.type === 'depends_on'
        ? edge.props?.hard === undefined
          ? true
          : edge.props.hard === true
        : undefined;
    return {
      id: edge.id,
      type: edge.type,
      source,
      target,
      props: edge.props ?? {},
      createdBy: actorOf(actors, edge.created_by),
      createdAt: iso(edge.created_at),
      updatedAt: iso(edge.updated_at),
      ...(edge.dst_resolved === null ? {} : { resolved: edge.dst_resolved }),
      ...(hard === undefined ? {} : { hard }),
    };
  };

  const group = (edges: EdgeRow[], direction: 'outgoing' | 'incoming'): EdgeGroup[] => {
    const byType = new Map<string, EdgeView[]>();
    for (const edge of edges) {
      const view = toView(edge);
      if (!view) continue;
      const list = byType.get(edge.type);
      if (list) list.push(view);
      else byType.set(edge.type, [view]);
    }
    return [...byType.entries()].map(([type, views]) => ({
      type,
      direction,
      label: edgeLabel(type, direction),
      edges: views,
    }));
  };

  const outgoing = group(visible.filter((e) => e.src_id === row.id), 'outgoing');
  const incoming = group(visible.filter((e) => e.dst_id === row.id && e.src_id !== row.id), 'incoming');

  const unresolvedHardDependencyCount = visible.filter(
    (e) =>
      e.src_id === row.id &&
      e.type === 'depends_on' &&
      (e.props?.hard === undefined ? true : e.props.hard === true) &&
      e.dst_resolved === false,
  ).length;

  return { outgoing, incoming, unresolvedHardDependencyCount };
}

async function loadHierarchy(
  q: Querier,
  row: EntityRow,
  viewerIdentityId: string,
  childLimit: number,
): Promise<Hierarchy> {
  // The ancestor chain, walked in SQL rather than by repeated round trips.
  // Depth-capped for the same reason `entity_tree` is: a cycle would otherwise
  // be an infinite loop, and 001 only guarantees acyclicity for edges.
  const pathRows = await q.query<EntityRow>(
    `with recursive up(id, parent_id, depth) as (
        select e.id, e.parent_id, 0 from public.entities e where e.id = $1
        union all
        select p.id, p.parent_id, up.depth + 1
          from public.entities p join up on p.id = up.parent_id
         where up.depth < 32
      )
      select ${ENTITY_COLUMNS} ${ENTITY_FROM}
       where e.id in (select id from up where depth > 0)`,
    [row.id],
  );

  const childRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
      where e.parent_id = $1 and e.deleted_at is null
      order by e.position asc, e.id asc
      limit ${childLimit + 1}`,
    [row.id],
  );
  const hasMore = childRows.length > childLimit;
  const pageRows = hasMore ? childRows.slice(0, childLimit) : childRows;

  const ancestors = await assembleSummaries(q, pathRows, viewerIdentityId);
  const children = await assembleSummaries(q, pageRows, viewerIdentityId);

  // `path` reads root → parent, which is the order a breadcrumb renders in.
  const byId = new Map(ancestors.map((a) => [a.id, a]));
  const ordered: EntitySummary[] = [];
  let cursor = row.parent_id;
  while (cursor) {
    const next = byId.get(cursor);
    if (!next) break;
    ordered.unshift(next);
    cursor = next.parentId;
  }

  const last = pageRows[pageRows.length - 1];
  const childPage: Page<EntitySummary> = {
    items: children,
    // Children are position-ordered, so the child cursor is a position keyset.
    nextCursor: hasMore && last ? encodeChildCursor(last) : null,
  };

  return {
    parent: row.parent_id ? (byId.get(row.parent_id) ?? null) : null,
    children: childPage,
    path: ordered,
  };
}

/** Children are position-ordered, so their keyset is `(position, id)`. */
function encodeChildCursor(row: EntityRow): string {
  return encodeCursor([Number(row.position), row.id]);
}

/**
 * Attach the CURRENT state to a `version_conflict`.
 *
 * A stale write is only actionable if the client is told what it lost the race
 * to. Without `details.current` the client's only move is another round trip
 * to find out — and it has to know to make it.
 *
 * The re-read happens in a FRESH transaction, deliberately: the conflicting
 * one was rolled back, so there is no querier left to ask, and reading through
 * the dead transaction would fail. The wire body carries it under `details`
 * because `toWireError` prefers `details` when both are present (04 §4).
 *
 * Best-effort by construction: if the entity has since become unreadable, the
 * original conflict is rethrown untouched. Losing the conflict itself in order
 * to report a failure to decorate it would be a strictly worse error.
 */
export async function enrichVersionConflict(
  deps: FacadeDeps,
  ctx: Parameters<OperationHandler>[0],
  id: string,
  err: unknown,
): Promise<unknown> {
  if (!(err instanceof CollabError) || err.code !== 'version_conflict') return err;
  try {
    const owner = await deps.owner();
    const current = await deps.db.tx(claimsFor(owner, ctx), (q) =>
      buildDetail(q, id, owner.identityId),
    );
    return new CollabError('version_conflict', err.message, {
      details: { ...(err.details ?? {}), current },
      current,
    });
  } catch {
    return err;
  }
}

/** The one EntityDetail assembler — every command result reuses it too. */
export async function buildDetail(
  q: Querier,
  id: string,
  viewerIdentityId: string,
): Promise<EntityDetail> {
  const row = await fetchRow(q, id);
  const [summary] = await assembleSummaries(q, [row], viewerIdentityId);
  if (!summary) throw new CollabError('not_found', `no such entity: ${id}`);

  // Sequential: one `Querier` is one pooled pg client, which cannot run two
  // queries concurrently (see entity-read.ts).
  const hierarchy = await loadHierarchy(q, row, viewerIdentityId, 50);
  const connections = await loadConnections(q, row, viewerIdentityId);

  return {
    ...summary,
    content: contentOf(row),
    hierarchy,
    connections,
    capabilities: capabilitiesOf(row),
  };
}

/** The jsonb `internal.command_result` shape the write RPCs return. */
interface RpcCommandResult {
  entity?: { id: string };
  /** `internal.command_edge` — a raw `to_jsonb(edges)` row, so snake_case. */
  edge?: {
    id: string;
    src_id: string;
    dst_id: string;
    type: string;
    props: Record<string, unknown>;
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  activity?: string | null;
  patches?: Array<{ id: string }>;
  /** DEV-11: a 5-minute redemption handle on cheaply-invertible commands. */
  undo?: { token: string; label: string; expiresAt?: string };
}

/**
 * Turn an RPC's raw command result into the contract's `CommandResult`.
 *
 * The RPC returns rows (envelope + content + counters); the DTOs — detail,
 * summaries, capabilities — are assembled HERE, by the same code that serves
 * the reads. That is the whole L3 bargain: a client that just created a task
 * and a client that just fetched one are looking at identical objects.
 */
async function toCommandResult(
  q: Querier,
  raw: RpcCommandResult,
  viewerIdentityId: string,
): Promise<CommandResult> {
  const entityId = raw.entity?.id;
  const patchIds = (raw.patches ?? []).map((p) => p.id).filter(Boolean);

  const patchRows =
    patchIds.length === 0
      ? []
      : await q.query<EntityRow>(
          `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
          [patchIds],
        );
  const patches = await assembleSummaries(q, patchRows, viewerIdentityId);

  let edge: EdgeView | undefined;
  if (raw.edge) {
    // `write_edge` patches both endpoints, so the summaries the EdgeView needs
    // are already in hand — no extra round trip for the common case.
    const byId = new Map(patches.map((p) => [p.id, p]));
    const source = byId.get(raw.edge.src_id);
    const target = byId.get(raw.edge.dst_id);
    if (source && target) {
      const actors = await loadActors(q, [raw.edge.created_by]);
      edge = {
        id: raw.edge.id,
        type: raw.edge.type,
        source,
        target,
        props: raw.edge.props ?? {},
        createdBy: actorOf(actors, raw.edge.created_by),
        createdAt: new Date(raw.edge.created_at).toISOString(),
        updatedAt: new Date(raw.edge.updated_at).toISOString(),
      };
    }
  }

  return {
    ...(entityId ? { entity: await buildDetail(q, entityId, viewerIdentityId) } : {}),
    ...(edge ? { edge } : {}),
    patches,
    ...(raw.undo
      ? {
          undo: {
            token: raw.undo.token,
            label: raw.undo.label,
            // Normalised for the same reason every other jsonb-sourced
            // timestamp is: Postgres serialises it with a UTC offset.
            ...(raw.undo.expiresAt
              ? { expiresAt: new Date(raw.undo.expiresAt).toISOString() }
              : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// entities.activity
// ---------------------------------------------------------------------------

export { toCommandResult, type RpcCommandResult, type CommandEnvelope };
