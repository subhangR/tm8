/**
 * The uniform entity operations (02 §3.1): get, create, patch, children.
 *
 * THE DISPATCH RULE (02 §6): SQL stays fully typed per kind — there is a
 * `create_task` and a `create_document`, not a generic writer. Uniformity is an
 * API property, so THIS layer is where `entities.create` fans out to the right
 * typed RPC based on the discriminated `kind`. That means an unsupported kind
 * gets an honest refusal here rather than a generic insert that half-works.
 *
 * G1A builds `task` and `doc` only (AM-5). Every other kind answers
 * `not_implemented` naming itself — not a 400, which would say the caller was
 * wrong when in fact the server is unfinished.
 */
import {
  CollabError,
  decodeCursor,
  encodeCursor,
  type CommandResult,
  type Connections,
  type CreateEntityInput,
  type EdgeGroup,
  type EdgeView,
  type EntityDetail,
  type EntitySummary,
  type Hierarchy,
  type Page,
  type PatchEntityInput,
} from '@tm8/contract';
import type { Querier } from '../../db/types.js';
import type { OperationHandler } from '../../http/types.js';
import type { FacadeDeps } from '../deps.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam, type CommandEnvelope } from '../context.js';
import {
  actorOf,
  assembleSummaries,
  entityCapabilities,
  contentOf,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  iso,
  loadActors,
  type EntityRow,
} from '../entity-read.js';

/**
 * Kinds `entities.create` routes to a typed RPC today.
 *
 * `team_member` is here because `execution.spawn` requires a `teamMemberId` —
 * a session is always somebody, and the manifest's identity block is built
 * from that row. Without it the loop cannot reach spawn at all, so the persona
 * is on the critical path even though nothing else about team_member is.
 *
 * `channel` is here because a space with no channels is not navigable, and
 * `spaces.navigation` renders the channel tree (AM-3: "open a space, see
 * tasks").
 */
const SUPPORTED_CREATE_KINDS = new Set(['task', 'doc', 'team_member', 'channel']);

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

export function entitiesGet(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const id = requireUuidParam(ctx, 'id');
    return deps.db.tx(claimsFor(owner, ctx), async (q) => buildDetail(q, id, owner.identityId));
  };
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
    capabilities: entityCapabilities(row),
  };
}

// ---------------------------------------------------------------------------
// entities.children
// ---------------------------------------------------------------------------

export function entitiesChildren(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const limit = limitOf(ctx.query.get('limit'));
    const cursor = ctx.query.get('cursor');

    return deps.db.tx(claimsFor(owner, ctx), async (q) => {
      const params: unknown[] = [id];
      let keyset = '';
      if (cursor) {
        const { k } = decodeCursor(cursor);
        if (k.length !== 2) throw new CollabError('invalid_cursor', 'invalid cursor: expected [position, id]');
        params.push(Number(k[0]), String(k[1]));
        keyset = `and (e.position, e.id) > ($2::double precision, $3::uuid)`;
      }

      const rows = await q.query<EntityRow>(
        `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
          where e.parent_id = $1 and e.deleted_at is null ${keyset}
          order by e.position asc, e.id asc
          limit ${limit + 1}`,
        params,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await assembleSummaries(q, pageRows, viewerIdentity(owner.identityId));
      const last = pageRows[pageRows.length - 1];
      const page: Page<EntitySummary> = {
        items,
        nextCursor: hasMore && last ? encodeChildCursor(last) : null,
      };
      return page;
    });
  };
}

function viewerIdentity(id: string): string {
  return id;
}

// ---------------------------------------------------------------------------
// entities.create / entities.patch
// ---------------------------------------------------------------------------

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

function acceptanceCriteria(content: Record<string, unknown> | undefined): unknown[] {
  const raw = content?.acceptanceCriteria;
  if (!Array.isArray(raw)) return [];
  // Criteria carry `{id, text, done}`; a client may send only `text`, so the
  // id is minted here rather than left absent for the UI to invent later.
  return raw.map((c, i) => {
    const item = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
    return {
      id: typeof item.id === 'string' ? item.id : `ac_${i + 1}`,
      text: typeof item.text === 'string' ? item.text : '',
      done: item.done === true,
      ...(typeof item.doneBy === 'string' ? { doneBy: item.doneBy } : {}),
      ...(typeof item.doneAt === 'string' ? { doneAt: item.doneAt } : {}),
    };
  });
}

export function entitiesCreate(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const input = ctx.body as CreateEntityInput;

    if (!SUPPORTED_CREATE_KINDS.has(input.kind)) {
      // DEV-13 honesty: the contract declares this kind, this build has not
      // implemented it. That is a 501 about the server, not a 400 about the
      // request.
      throw new CollabError(
        'not_implemented',
        `entities.create does not yet support kind '${input.kind}' on this node (G1A builds task and doc)`,
      );
    }

    const content = (input.content ?? {}) as Record<string, unknown>;
    const attach = input.attachTo;
    const claims = claimsFor(owner, ctx, envelope);

    return deps.db.tx(claims, async (q) => {
      if (input.kind === 'team_member') {
        // Every field but the name has a default in the RPC (007:1198), so a
        // persona created with just `{spaceId, kind, title}` is well-formed,
        // not half-formed: role/identity default to '', the jsonb blocks to
        // '{}', and the OWNER is resolved from the caller's member row rather
        // than accepted from the client (an agent minting its own persona
        // would grow a new can_act_as root every spawn).
        const raw = await q.rpc<RpcCommandResult>('create_team_member', [
          input.spaceId,
          input.title,
          envelope.actorId ?? null,
          content.role ?? '',
          content.identity ?? '',
          content.model ?? null,
          content.agentTool ?? null,
          content.mode ?? null,
          content.permissionMode ?? null,
          JSON.stringify(content.capabilities ?? {}),
          JSON.stringify(content.commandPermissions ?? {}),
          content.avatar ?? null,
          input.parentId ?? null,
          input.position ?? null,
          envelope.clientMutationId ?? null,
        ]);
        const created = await toCommandResult(q, raw, owner.identityId);
        return { kind: 'json' as const, status: 201, data: created };
      }

      if (input.kind === 'channel') {
        // `create_channel` lowercases and trims the name itself (007:1069),
        // because `channels.name` is regex-constrained and unique per space —
        // so the title travels through as-is rather than being pre-mangled
        // here where the two normalisations could drift apart.
        const raw = await q.rpc<RpcCommandResult>('create_channel', [
          input.spaceId,
          input.title,
          envelope.actorId ?? null,
          content.topic ?? '',
          input.parentId ?? null,
          input.position ?? null,
          envelope.clientMutationId ?? null,
        ]);
        const created = await toCommandResult(q, raw, owner.identityId);
        return { kind: 'json' as const, status: 201, data: created };
      }

      const raw =
        input.kind === 'task'
          ? await q.rpc<RpcCommandResult>('create_task', [
              input.spaceId,
              input.title,
              envelope.actorId ?? null,
              content.description ?? '',
              content.axes ?? {},
              input.parentId ?? null,
              input.position ?? null,
              content.priority ?? 'medium',
              JSON.stringify(acceptanceCriteria(content)),
              content.pointsEstimate ?? null,
              content.dueDate ?? null,
              attach?.entityId ?? null,
              attach?.edgeType ?? 'attached_to',
              envelope.clientMutationId ?? null,
            ])
          : await q.rpc<RpcCommandResult>('create_document', [
              input.spaceId,
              input.title,
              envelope.actorId ?? null,
              content.body ?? '',
              content.format ?? 'markdown',
              input.parentId ?? null,
              input.position ?? null,
              attach?.entityId ?? null,
              attach?.edgeType ?? 'attached_to',
              envelope.clientMutationId ?? null,
            ]);

      await attachEdgeInto(q, raw, attach);
      const result = await toCommandResult(q, raw, owner.identityId);
      return { kind: 'json' as const, status: 201, data: result };
    });
  };
}

/**
 * Surface the edge that `attachTo` created.
 *
 * `create_task` / `create_document` call `internal.attach_on_create`, which
 * DOES create the edge — but they pass `null` as `command_result`'s edge
 * argument, so the id never comes back (007:939). The edge is real and
 * committed; only the reporting is missing, and a client that asked for an
 * atomic create-and-attach needs to see what it got. Looked up here rather
 * than patched into the RPC, which is Cygnus's file.
 */
async function attachEdgeInto(
  q: Querier,
  raw: RpcCommandResult,
  attach: CreateEntityInput['attachTo'],
): Promise<void> {
  const newId = raw.entity?.id;
  if (!attach?.entityId || !newId || raw.edge) return;

  const rows = await q.query<NonNullable<RpcCommandResult['edge']>>(
    `select id, src_id, dst_id, type, props, created_by, created_at
       from public.edges
      where src_id = $1 and dst_id = $2 and type = $3`,
    [newId, attach.entityId, attach.edgeType ?? 'attached_to'],
  );
  const row = rows[0];
  if (row) {
    raw.edge = row;
    // `toCommandResult` builds the EdgeView from `patches`, so both endpoints
    // must be in there. The RPC patches only the new entity.
    const patches = raw.patches ?? [];
    if (!patches.some((p) => p.id === attach.entityId)) {
      raw.patches = [...patches, { id: attach.entityId }];
    }
  }
}

export function entitiesPatch(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const owner = await deps.owner();
    const envelope = commandEnvelope(ctx);
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as PatchEntityInput;
    const content = (input.content ?? {}) as Record<string, unknown>;
    const claims = claimsFor(owner, ctx, envelope);

    const run = (): Promise<unknown> =>
      deps.db.tx(claims, async (q) => {
      // Dispatch on the STORED kind, not on anything the client said: a patch
      // body has no `kind`, and trusting one would let a caller aim a task
      // update at a document.
      const kindRows = await q.query<{ kind: string }>(
        `select kind from public.entities where id = $1 and deleted_at is null`,
        [id],
      );
      const kind = kindRows[0]?.kind;
      if (!kind) throw new CollabError('not_found', `no such entity: ${id}`);

      let raw: RpcCommandResult;
      if (kind === 'task') {
        raw = await q.rpc<RpcCommandResult>('update_task_content', [
          id,
          input.expectedVersion,
          envelope.actorId ?? null,
          input.title ?? null,
          content.description ?? null,
          content.axes ?? null,
          content.workStatus ?? null,
          content.priority ?? null,
          content.acceptanceCriteria === undefined
            ? null
            : JSON.stringify(acceptanceCriteria(content)),
          content.pointsEstimate ?? null,
          content.dueDate ?? null,
          // An explicit `dueDate: null` means CLEAR, which `coalesce` in the
          // RPC cannot express — hence the separate flag.
          content.dueDate === null,
          envelope.clientMutationId ?? null,
        ]);
      } else if (kind === 'doc') {
        raw = await q.rpc<RpcCommandResult>('update_document', [
          id,
          input.expectedVersion,
          envelope.actorId ?? null,
          input.title ?? null,
          content.body ?? null,
          content.format ?? null,
          envelope.clientMutationId ?? null,
        ]);
      } else {
        throw new CollabError(
          'not_implemented',
          `entities.patch does not yet support kind '${kind}' on this node (G1A builds task and doc)`,
        );
      }

      return toCommandResult(q, raw, owner.identityId);
    });

    try {
      return await run();
    } catch (err) {
      // A stale write is told what it lost the race to, rather than being left
      // to discover it with another request.
      throw await enrichVersionConflict(deps, ctx, id, err);
    }
  };
}

// ---------------------------------------------------------------------------
// entities.activity
// ---------------------------------------------------------------------------

export { toCommandResult, type RpcCommandResult, type CommandEnvelope };
