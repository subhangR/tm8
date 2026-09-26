import { createHash } from 'node:crypto';

import {
  CollabError,
  GraphContentInputSchema,
  applyGraphLinks,
  graphNodeKey,
  DrawingContentInputSchema,
  decodeCursor,
  encodeCursor,
  isCollabError,
  headerReadMode,
  SELECTION_HEADER_KINDS,
  type ActivityItem,
  type ActorSummary,
  type AttentionRequest,
  type AttentionRequestMutationResult,
  type AttentionRequestPage,
  type CommandResult,
  type CreateAttentionRequestInput,
  type CreateEntityInput,
  type CustomFieldValue,
  type EdgeView,
  type EntityCapabilities,
  type EntityContent,
  type EntityDetail,
  type EntitySummary,
  type Hierarchy,
  type LinkCommitInput,
  type LinkPrInput,
  type MoveEntityInput,
  type Page,
  type PatchEntityInput,
  type TickCriteriaInput,
  type ClearEntityHeaderInput,
  type EntityHeaderResult,
  type EntityHeaderReadMode,
  type EntityHeaderView,
  type SetEntityHeaderInput,
  type PullInput,
  type ReactionInput,
  type ResolveEntityAttentionInput,
  type TrackingRefreshInput,
  type UpdateAttentionRequestInput,
} from '@tm8/contract';

import type { Querier } from '../../../db/types.js';
import { resolveAuthoredHeaderView, resolveHeaderViews } from '../../../headers/resolve.js';
import {
  clearEntityHeader, createHeaderMutationId, headerWarnings, setEntityHeader, withHeaderWarnings,
  type HeaderRpcResult,
} from '../../../headers/write.js';
import type { RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, limitOf, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import {
  MICROS,
  actorOf,
  assembleSummaries,
  entityCapabilities,
  contentOf,
  hydrateDetail,
  ENTITY_COLUMNS,
  readAncestorRows,
  ENTITY_FROM,
  iso,
  isoOrNull,
  loadActors,
  type EntityRow,
} from '../../entity-read.js';
import type { RpcCommandResult } from '../../handlers/entities.js';
import { buildReceipt, receiptSnapshot, wantsReceipt, type ServerReceipt } from '../../receipt.js';
import { projectForgeFacts } from '../../../tracking/pr-projection.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REACTION_TYPES = new Set(['likes', 'dislikes', 'stars']);
const RESTRICTED_LIFECYCLE_KINDS = new Set([
  'member',
  'message',
  'work_session',
  'project',
  'interaction_profile',
  'artifact',
  // `container` (177) is here for exactly the reason `work_session` is: it is
  // born from `containers.create`, which RESERVES the record and then
  // provisions a runtime under a saga. A generic `entities.create container`
  // would produce a record with no machine behind it — one that renders in a
  // list, counts in the rail, and fails every verb — and a generic
  // `entities.delete` would orphan a running runtime the graph no longer
  // knows about. Destruction is `containers.destroy`, which stops the runtime
  // first and soft-deletes the envelope after.
  //
  // Unlike `work_session`, this kind does NOT open a rename door here: the
  // title is patched through `containers.update`, which is ledgered and
  // asserts a version like the rest of the family.
  'container',
  // `space_link` (W6, 250/251) is born from `spaceLinks.add` and ends only
  // through `spaceLinks.*` (P7). A generic delete would soft-delete the
  // envelope without the cascade or the revoke-on-delete trigger, hiding the
  // link while its tokens and target sessions stayed live (review D1). SQL
  // refuses the same doors (251 §10b). `server` joins in W8.
  'space_link',
]);
// `memory` is here to HIDE hierarchy on the read surfaces; the actual refusal
// of a memory parent lives at the data layer (056's entities trigger), because
// this set is not checked at create/move time.
const HIERARCHY_DISABLED_KINDS = new Set(['message', 'project', 'interaction_profile', 'memory']);

interface EnrichmentRow {
  id: string;
  kind: string;
  content: Record<string, unknown>;
  project_name: string | null;
  project_repo_url: string | null;
  profile_draft: Record<string, unknown> | null;
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
  /** Microsecond TEXT from `to_char`, REQUIRED — see edges-placements.ts. */
  cursor_created_at: string;
  /** Required for the same reason: the encoder has an `updatedAt` sort branch. */
  cursor_updated_at: string;
  resolved: boolean | null;
}

interface ActivityRow {
  id: string;
  entity_id: string | null;
  actor_id: string | null;
  verb: string;
  summary: Record<string, unknown>;
  ref_id: string | null;
  work_session_id: string | null;
  created_at: Date | string;
  /** Microsecond TEXT from `to_char`, REQUIRED — see edges-placements.ts. */
  cursor_created_at: string;
}

interface AttentionRequestRow {
  id: string;
  space_id: string;
  entity_id: string;
  reason: string;
  points: number;
  status: AttentionRequest['status'];
  version: number;
  requested_by: string;
  acknowledged_by: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  acknowledged_at: Date | string | null;
  resolved_at: Date | string | null;
  /** Microsecond cursor key, selected only on queue reads. */
  cursor_created_at?: string;
}

interface AttentionMutationRpcResult {
  attentionRequestId: string | null;
  entityId: string;
  affectedCount: number;
}

interface VersionRow {
  entity_id: string;
  version: number;
  snapshot: Record<string, unknown>;
  changed_by: string | null;
  changed_at: Date | string;
}

function fingerprint(scope: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({ scope, value }))
    .digest('base64url')
    .slice(0, 22);
}

/** The `entities.children` cursor identity. */
function childCursorFingerprint(parentId: string): string {
  return fingerprint('entities.children', { parentId });
}

/**
 * The `entities.children` continuation token: `[fp, position, id]`, resuming
 * strictly after `after` in `(position, id)` order.
 *
 * Exported because `entities.context` emits a `cursors.children` token that
 * this operation consumes; a token minted in any other shape is one it rejects
 * as `invalid_cursor`. `after: null` is the token for "from the first child" —
 * a keyset below every finite position — which context needs when its byte
 * caps dropped every child it fetched: without it a non-empty list would read
 * as empty with no way to continue.
 */
export function childCursor(parentId: string, after: { position: number; id: string } | null): string {
  const fp = childCursorFingerprint(parentId);
  return encodeCursor(after
    ? [fp, after.position, after.id]
    : [fp, -Number.MAX_VALUE, '00000000-0000-0000-0000-000000000000']);
}

function cursorUuid(value: unknown): string {
  const id = String(value ?? '');
  if (!UUID_RE.test(id)) throw new CollabError('invalid_cursor', 'cursor contains an invalid entity id');
  return id;
}

function cursorIso(value: unknown): string {
  const timestamp = String(value ?? '');
  if (timestamp.length === 0 || Number.isNaN(Date.parse(timestamp))) {
    throw new CollabError('invalid_cursor', 'cursor contains an invalid timestamp');
  }
  return timestamp;
}

function contentString(content: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = content[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function contentNumber(content: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = content[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function camelContent(content: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    output[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  return output;
}

function customScalarFields(value: unknown): Record<string, CustomFieldValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const fields: Record<string, CustomFieldValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === null || typeof field === 'string' || typeof field === 'boolean'
      || (typeof field === 'number' && Number.isFinite(field))) {
      fields[key] = field;
    }
  }
  return fields;
}

function enrichSummaryFields(summary: EntitySummary, row: EnrichmentRow): EntitySummary {
  const content = row.content ?? {};
  switch (row.kind) {
    case 'spell':
    case 'skill':
      return summary; // Already derived by the shared read projection, including equips.
    case 'pull_request': {
      const fetchedAt = contentString(content, 'fetched_at', 'fetchedAt');
      return {
        ...summary,
        title: contentString(content, 'title') ?? 'Pull request',
        state: {
          kind: 'pull_request',
          repository: contentString(content, 'repo', 'repository') ?? '',
          number: contentNumber(content, 'number') ?? 0,
          state: contentString(content, 'state') ?? 'open',
          url: contentString(content, 'url') ?? undefined,
          fetchedAt,
          stale: fetchedAt === null,
          // 103: entity_content carries the whole pull_requests row, so the two
          // forge facts arrive here with no query change.
          ...projectForgeFacts(content.ci_status, content.mergeable_state, content.head_ref),
        },
      };
    }
    case 'commit':
      return {
        ...summary,
        title: contentString(content, 'message') || contentString(content, 'sha') || 'Commit',
        state: {
          kind: 'commit',
          repository: contentString(content, 'repo', 'repository') ?? '',
          sha: contentString(content, 'sha') ?? '',
          message: contentString(content, 'message') ?? '',
          committedAt: contentString(content, 'committed_at', 'committedAt'),
        },
      };
    case 'project':
      return {
        ...summary,
        title: row.project_name ?? 'Project',
        state: {
          kind: 'project',
          projectId: contentString(content, 'project_id', 'projectId') ?? '',
          materializedVersion: contentNumber(content, 'materialized_version', 'materializedVersion') ?? 1,
        },
      };
    case 'interaction_profile': {
      const draft = row.profile_draft ?? {};
      return {
        ...summary,
        title: contentString(draft, 'name') ?? 'Interaction Profile',
        state: {
          kind: 'interaction_profile',
          status: (contentString(content, 'status') ?? 'draft') as 'draft' | 'active' | 'retired',
          currentDraftVersion: contentNumber(content, 'current_draft_version', 'currentDraftVersion') ?? 1,
          activeVersion: contentNumber(content, 'active_version', 'activeVersion'),
          activeHash: contentString(content, 'active_hash', 'activeHash'),
          retiredAt: contentString(content, 'retired_at', 'retiredAt'),
        },
      };
    }
    default:
      if (row.kind.startsWith('c:')) {
        const fields = customScalarFields(content.fields);
        return {
          ...summary,
          title: contentString(content, 'title') ?? summary.title,
          state: { kind: row.kind as `c:${string}`, fields },
        };
      }
      return summary;
  }
}

function enrichSummary(summary: EntitySummary, row: EnrichmentRow): EntitySummary {
  const enriched = enrichSummaryFields(summary, row);
  if (summary.deletedAt === null) return enriched;
  return { ...enriched, title: summary.title, excerpt: undefined };
}

async function loadEnrichments(q: Querier, ids: readonly string[]): Promise<Map<string, EnrichmentRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q.query<EnrichmentRow>(
    `select e.id, e.kind,
            case
              when e.kind like 'c:%' then jsonb_build_object('title', custom_detail.title, 'fields', custom_detail.fields)
              when e.kind = 'file' then to_jsonb(file_detail) - 'entity_id'
              when e.kind = 'pull_request' then to_jsonb(pr_detail) - 'entity_id'
              when e.kind = 'commit' then to_jsonb(commit_detail) - 'entity_id'
              when e.kind = 'project' then to_jsonb(project_detail) - 'entity_id'
              when e.kind = 'interaction_profile' then to_jsonb(profile) - 'entity_id'
              else '{}'::jsonb
            end content,
            project_detail.name project_name, project_detail.repo_url project_repo_url,
            profile_version.draft_json profile_draft
       from public.entities e
       left join public.custom_entities custom_detail on custom_detail.entity_id = e.id
       left join public.files file_detail on file_detail.entity_id = e.id
       left join public.pull_requests pr_detail on pr_detail.entity_id = e.id
       left join public.commits commit_detail on commit_detail.entity_id = e.id
       left join public.project_projection_details project_detail on project_detail.entity_id = e.id
       left join public.interaction_profiles profile on profile.entity_id = e.id
       left join public.interaction_profile_versions profile_version
         on profile_version.profile_id = profile.entity_id
        and profile_version.version = coalesce(profile.active_version, profile.current_draft_version)
      where e.id = any($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadUniversalSummaries(
  q: Querier,
  rows: readonly EntityRow[],
  viewerIdentityId: string,
): Promise<EntitySummary[]> {
  const summaries = await assembleSummaries(q, rows, viewerIdentityId);
  const enrichments = await loadEnrichments(q, summaries.map((summary) => summary.id));
  return summaries.map((summary) => {
    const enrichment = enrichments.get(summary.id);
    return enrichment ? enrichSummary(summary, enrichment) : summary;
  });
}

async function liveRow(q: Querier, id: string): Promise<EntityRow> {
  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1 and e.deleted_at is null`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new CollabError('not_found', `no such entity: ${id}`);
  return row;
}

/**
 * The existence + visibility guard, WITHOUT reading the entity.
 *
 * `liveRow` answers the same question but pays a full ENTITY_FROM point read
 * (~200 columns across a 25-way join, 15-25ms) to do it. Callers that only
 * need "does this exist and may I see it" discard that row.
 *
 * Exactly equivalent: ENTITY_FROM is `entities e` plus LEFT JOINs, so nothing
 * downstream of `e` can hide a row. Visibility is decided by RLS on
 * `public.entities` alone, which is the table queried here, with the same
 * `deleted_at is null` predicate.
 *
 * This matters in `queryConnections`, which runs the guard on every call and
 * is called once per page by `buildUniversalDetail` -- 12 pages for prod's
 * most-connected entity (2,236 edges at limit 200), so 12 full point reads of
 * one already-loaded row per detail build.
 */
async function assertLive(q: Querier, id: string): Promise<void> {
  const rows = await q.query<{ one: number }>(
    `/* entities.assert-live */
     select 1 as one from public.entities e where e.id = $1 and e.deleted_at is null`,
    [id],
  );
  if (rows.length === 0) throw new CollabError('not_found', `no such entity: ${id}`);
}

function detailContent(row: EntityRow, enrichment: EnrichmentRow | undefined): EntityContent {
  if (!enrichment) return contentOf(row);
  const content = enrichment.content ?? {};
  if (row.kind.startsWith('c:')) {
    return { kind: row.kind as `c:${string}`, fields: customScalarFields(content.fields) };
  }
  if (row.kind === 'project') {
    return {
      kind: 'project',
      projectId: contentString(content, 'project_id', 'projectId') ?? '',
      repoUrl: enrichment.project_repo_url,
      materializedVersion: contentNumber(content, 'materialized_version', 'materializedVersion') ?? 1,
    };
  }
  if (row.kind === 'interaction_profile') {
    const draft = enrichment.profile_draft ?? {};
    return {
      kind: 'interaction_profile',
      status: (contentString(content, 'status') ?? 'draft') as 'draft' | 'active' | 'retired',
      templateKey: contentString(draft, 'templateKey', 'template_key') ?? 'core',
      templateVersion: contentNumber(draft, 'templateVersion', 'template_version') ?? 1,
      resolvedHash: contentString(content, 'active_hash', 'activeHash'),
      generatedByTeamMemberId: contentString(content, 'generated_by_team_member_id', 'generatedByTeamMemberId'),
    };
  }
  if (['pull_request', 'commit', 'file'].includes(row.kind)) {
    return { kind: row.kind, ...camelContent(content) } as EntityContent;
  }
  return contentOf(row);
}

function edgeView(
  row: EdgeRow,
  summaries: Map<string, EntitySummary>,
  actors: Map<string, ActorSummary>,
): EdgeView | null {
  const source = summaries.get(row.src_id);
  const target = summaries.get(row.dst_id);
  if (!source || !target) return null;
  const hard = row.type === 'depends_on'
    ? row.props?.hard === undefined ? true : row.props.hard === true
    : undefined;
  return {
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
  };
}

interface ConnectionQuery {
  entityId: string;
  types: string[];
  direction: 'incoming' | 'outgoing' | 'both';
  peerIds: string[];
  peerKinds: string[];
  createdByIds: string[];
  createdAfter: string | null;
  createdBefore: string | null;
  sort: 'createdAt' | 'updatedAt' | 'type';
  order: 'asc' | 'desc';
  cursor: string | null;
  limit: number;
}

function listParam(search: URLSearchParams, singular: string, plural: string): string[] {
  return [...new Set([
    ...search.getAll(singular),
    ...search.getAll(plural).flatMap((value) => value.split(',')),
  ].map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizedConnections(entityId: string, search: URLSearchParams): ConnectionQuery {
  const direction = search.get('direction') ?? 'both';
  if (!['incoming', 'outgoing', 'both'].includes(direction)) {
    throw new CollabError('invalid_input', 'direction must be incoming, outgoing, or both');
  }
  const sort = search.get('sort') ?? 'createdAt';
  if (!['createdAt', 'updatedAt', 'type'].includes(sort)) {
    throw new CollabError('invalid_input', 'sort must be createdAt, updatedAt, or type');
  }
  const order = search.get('order') ?? 'desc';
  if (order !== 'asc' && order !== 'desc') throw new CollabError('invalid_input', 'order must be asc or desc');
  const peerIds = listParam(search, 'peerId', 'peerIds');
  const createdByIds = listParam(search, 'createdById', 'createdByIds');
  for (const id of [...peerIds, ...createdByIds]) {
    if (!UUID_RE.test(id)) throw new CollabError('invalid_input', 'connection entity filters must be UUIDs');
  }
  const createdAfter = search.get('createdAfter');
  const createdBefore = search.get('createdBefore');
  for (const value of [createdAfter, createdBefore]) {
    if (value !== null && Number.isNaN(Date.parse(value))) {
      throw new CollabError('invalid_input', 'connection timestamps must be ISO timestamps');
    }
  }
  return {
    entityId,
    types: listParam(search, 'type', 'types'),
    direction: direction as ConnectionQuery['direction'],
    peerIds,
    peerKinds: listParam(search, 'peerKind', 'peerKinds'),
    createdByIds,
    createdAfter,
    createdBefore,
    sort: sort as ConnectionQuery['sort'],
    order,
    cursor: search.get('cursor'),
    limit: limitOf(search.get('limit')),
  };
}

class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

async function queryConnections(
  q: Querier,
  query: ConnectionQuery,
  viewerIdentityId: string,
): Promise<Page<EdgeView>> {
  await assertLive(q, query.entityId);
  const fp = fingerprint('entities.connections', {
    entityId: query.entityId,
    types: query.types,
    direction: query.direction,
    peerIds: query.peerIds,
    peerKinds: query.peerKinds,
    createdByIds: query.createdByIds,
    createdAfter: query.createdAfter,
    createdBefore: query.createdBefore,
    sort: query.sort,
    order: query.order,
  });
  const params = new SqlParams();
  const anchor = params.add(query.entityId);
  const where = [query.direction === 'outgoing'
    ? `g.src_id = ${anchor}`
    : query.direction === 'incoming'
      ? `g.dst_id = ${anchor}`
      : `(g.src_id = ${anchor} or g.dst_id = ${anchor})`];
  if (query.types.length > 0) where.push(`g.type = any(${params.add(query.types)}::text[])`);
  if (query.peerIds.length > 0) {
    where.push(`(case when g.src_id = ${anchor} then g.dst_id else g.src_id end) = any(${params.add(query.peerIds)}::uuid[])`);
  }
  if (query.peerKinds.length > 0) {
    where.push(`(case when g.src_id = ${anchor} then dst.kind else src.kind end) = any(${params.add(query.peerKinds)}::text[])`);
  }
  if (query.createdByIds.length > 0) where.push(`g.created_by = any(${params.add(query.createdByIds)}::uuid[])`);
  if (query.createdAfter) where.push(`g.created_at > ${params.add(query.createdAfter)}::timestamptz`);
  if (query.createdBefore) where.push(`g.created_at < ${params.add(query.createdBefore)}::timestamptz`);

  const descending = query.order === 'desc';
  const compare = descending ? '<' : '>';
  const direction = descending ? 'desc' : 'asc';
  const sortColumn = query.sort === 'updatedAt' ? 'g.updated_at' : query.sort === 'type' ? 'g.type' : 'g.created_at';
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded.k[0] !== fp) throw new CollabError('invalid_cursor', 'connection cursor does not match this query');
    if (query.sort === 'type') {
      if (decoded.k.length !== 4) throw new CollabError('invalid_cursor', 'invalid type-sorted connection cursor');
      const type = params.add(String(decoded.k[1] ?? ''));
      const at = params.add(cursorIso(decoded.k[2]));
      const id = params.add(cursorUuid(decoded.k[3]));
      where.push(`(g.type, g.created_at, g.id) ${compare} (${type}, ${at}::timestamptz, ${id}::uuid)`);
    } else {
      if (decoded.k.length !== 3) throw new CollabError('invalid_cursor', 'invalid connection cursor');
      const at = params.add(cursorIso(decoded.k[1]));
      const id = params.add(cursorUuid(decoded.k[2]));
      where.push(`(${sortColumn}, g.id) ${compare} (${at}::timestamptz, ${id}::uuid)`);
    }
  }
  const orderBy = query.sort === 'type'
    ? `g.type ${direction}, g.created_at ${direction}, g.id ${direction}`
    : `${sortColumn} ${direction}, g.id ${direction}`;
  // THE ENDPOINTS ARE PRIMARY-KEY LOOKUPS PER EDGE, NOT JOINS, ON PURPOSE.
  //
  // As plain `join public.entities src on src.id = g.src_id and src.deleted_at
  // is null`, the plan depended entirely on statistics. With none (every
  // per-suite scratch database: autovacuum_naptime is 60s and a suite is done
  // sooner), `deleted_at is null` estimates at one row, so the planner put
  // ENTITIES outermost and nested all live dst × all live src, calling the
  // security-definer `entity_row_visible` on each: N² RLS calls to answer "no
  // edges" for a task created a moment ago. Measured on g02-public H2: 1.2–1.4s
  // per call for a brand-new task, 11.5s once the file had created more
  // entities, and this runs inside every createTask (`attachInitialConnections`),
  // which is where the 12s statement_timeout (57014) and H2's 60s CI timeout came
  // from. `tm8_stable`, which has statistics, got the right plan (88ms for a
  // 706-edge hub), which is why it never showed there.
  //
  // `lateral (… where e.id = g.x limit 1)` keeps edges outermost whatever the
  // estimates say: `limit 1` stops the subquery being flattened back into a
  // join, and keeping `deleted_at` OUTSIDE it leaves `entities_pkey` as the only
  // index that can serve `id = g.x` (every partial index on entities is
  // `where deleted_at is null` and leads with another column). Semantics are
  // unchanged: `id` is unique, and a row RLS hides yields no lateral row, which
  // drops the edge exactly as the inner join did.
  const rows = await q.query<EdgeRow>(
    `select g.id, g.src_id, g.dst_id, g.type, g.props, g.created_by, g.created_at, g.updated_at,
            ${MICROS('g.created_at')} cursor_created_at,
            ${MICROS('g.updated_at')} cursor_updated_at,
            case when g.type = 'depends_on' then internal.is_resolved(g.dst_id) else null end resolved
       from public.edges g
       cross join lateral (
         select e.kind, e.deleted_at from public.entities e where e.id = g.src_id limit 1
       ) src
       cross join lateral (
         select e.kind, e.deleted_at from public.entities e where e.id = g.dst_id limit 1
       ) dst
      where src.deleted_at is null and dst.deleted_at is null
        and ${where.join(' and ')}
      order by ${orderBy}
      limit ${query.limit + 1}`,
    params.values,
  );
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const endpointRows = pageRows.length === 0 ? [] : await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[]) and e.deleted_at is null`,
    [[...new Set(pageRows.flatMap((row) => [row.src_id, row.dst_id]))]],
  );
  const summaries = new Map(
    (await loadUniversalSummaries(q, endpointRows, viewerIdentityId)).map((summary) => [summary.id, summary]),
  );
  const actors = await loadActors(q, pageRows.map((row) => row.created_by));
  const items = pageRows.flatMap((row) => {
    const view = edgeView(row, summaries, actors);
    return view ? [view] : [];
  });
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last
    ? query.sort === 'type'
      ? encodeCursor([fp, last.type, last.cursor_created_at, last.id])
      : encodeCursor([
          fp,
          query.sort === 'updatedAt' ? last.cursor_updated_at : last.cursor_created_at,
          last.id,
        ])
    : null;
  return { items, nextCursor };
}

async function hierarchyFor(
  q: Querier,
  row: EntityRow,
  viewerIdentityId: string,
  childLimit = 50,
): Promise<Hierarchy> {
  if (HIERARCHY_DISABLED_KINDS.has(row.kind)) {
    throw new CollabError('forbidden', `hierarchy is disabled for ${row.kind}`);
  }
  // Ancestors are read as ids and then one at a time, NOT by joining the
  // recursive CTE onto ENTITY_FROM. `readAncestorRows` carries the measurement
  // and the reason; the short version is that the joined form costs ~700ms to
  // return two rows and this costs ~26ms.
  //
  // Reversed to depth DESCENDING: `path` renders root -> parent, which is the
  // order a breadcrumb reads in, and the helper returns nearest-first.
  //
  // Deleted ancestors are EXCLUDED here (unlike `entities.get`), preserving
  // what the single query did by filtering in its outer select.
  const ancestors = (await readAncestorRows(q, row.id, { includeDeleted: false })).reverse();
  const childRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
      where e.parent_id = $1 and e.deleted_at is null
      order by e.position, e.id
      limit ${childLimit + 1}`,
    [row.id],
  );
  const hasMore = childRows.length > childLimit;
  const pageRows = hasMore ? childRows.slice(0, childLimit) : childRows;
  const path = await loadUniversalSummaries(q, ancestors, viewerIdentityId);
  const children = await loadUniversalSummaries(q, pageRows, viewerIdentityId);
  const last = pageRows.at(-1);
  return {
    parent: path.at(-1) ?? null,
    path,
    children: {
      items: children,
      nextCursor: hasMore && last ? childCursor(row.id, { position: Number(last.position), id: last.id }) : null,
    },
  };
}

/**
 * A collection's `content.items` is a bounded, position-ordered preview of its
 * `contains` members — enough for the detail panel to render the list without
 * a second round trip. The full, paginated membership read stays
 * `collections.query` with an edge filter; this cap is a preview bound, not
 * the membership bound, which is why `state.itemCount` (the live-member edge
 * count) may exceed `items.length`.
 */
const COLLECTION_ITEMS_PREVIEW_LIMIT = 50;

async function collectionItems(
  q: Querier,
  collectionId: string,
  viewerIdentityId: string,
): Promise<EntitySummary[]> {
  // TWO STEPS, and the reason is that the one-step form took 43 SECONDS.
  //
  // This used to join `edges` onto ENTITY_FROM directly. The planner
  // estimated the edges index scan at ONE row (this collection has 56) and,
  // on that estimate, chose to put the entire 25-way join on the INNER side
  // of a nested loop with `ce.dst_id = e.id` as a Join Filter rather than an
  // index condition:
  //
  //   Nested Loop  (cost=3008.99..172955.29 rows=1)
  //     Join Filter: (ce.dst_id = e.id)
  //     ->  Index Scan on edges ce            rows=1     -- actually 56
  //     ->  Nested Loop Left Join             rows=14334 -- every entity
  //
  // So it rebuilt the full 25-way join over all 14,334 entities once per
  // collection member and threw almost all of it away: ~800,000 rows of
  // 6,079 bytes to return 50. Measured on prod: 43,694ms / 14,636ms /
  // 15,824ms across three runs. Those last two straddle the 15s client
  // timeout, which is the reported symptom.
  //
  // `join_collapse_limit=1` does NOT rescue it (still ~18s) -- the join order
  // is not the problem, the rows=1 estimate driving a rescan is.
  //
  // Split, the ordering runs on `edges` + `entities` alone (two tables, an
  // index and a limit) and only the surviving 50 ids ever reach ENTITY_FROM.
  // Measured: 3ms + 40ms = ~44ms, against 14,636ms. Same rows, same order.
  //
  // The position cast is TYPE-GUARDED, exactly as in `set_collection_item`
  // (migration 100): edge `props` are client-controlled, and one membership
  // written with `props: {position: "top"}` would otherwise 22P02 this read —
  // which maps to not_found, turning a live collection's detail into a 404.
  const ordered = await q.query<{ id: string }>(
    `/* collections.items:ids */
     select e.id
       from public.edges ce
       join public.entities e on e.id = ce.dst_id
      where ce.src_id = $1 and ce.type = 'contains' and e.deleted_at is null
      order by (case when jsonb_typeof(ce.props -> 'position') = 'number'
                     then (ce.props ->> 'position')::float8 end) nulls last,
               ce.created_at, e.id
      limit ${COLLECTION_ITEMS_PREVIEW_LIMIT}`,
    [collectionId],
  );
  if (ordered.length === 0) return [];

  const ids = ordered.map((r) => r.id);
  const rows = await q.query<EntityRow>(
    `/* collections.items:rows */
     select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    [ids],
  );
  // `= any()` does not preserve argument order and step 1 IS the order, so
  // the rows are put back into it here rather than re-sorted in SQL.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const inOrder = ids
    .map((id) => byId.get(id))
    .filter((r): r is EntityRow => r !== undefined);
  return loadUniversalSummaries(q, inOrder, viewerIdentityId);
}

async function buildUniversalDetail(
  q: Querier,
  id: string,
  viewerIdentityId: string,
): Promise<EntityDetail> {
  const row = await liveRow(q, id);
  const summary = (await loadUniversalSummaries(q, [row], viewerIdentityId))[0];
  if (!summary) throw new CollabError('not_found', `no such entity: ${id}`);
  const enrichment = (await loadEnrichments(q, [id])).get(id);
  const hierarchy = HIERARCHY_DISABLED_KINDS.has(row.kind)
    ? { parent: null, path: [], children: { items: [], nextCursor: null } }
    : await hierarchyFor(q, row, viewerIdentityId);
  const connectionQuery = { ...normalizedConnections(id, new URLSearchParams()), limit: 200 };
  const connectionItems: EdgeView[] = [];
  let connectionCursor: string | null = null;
  do {
    const page = await queryConnections(
      q,
      { ...connectionQuery, cursor: connectionCursor },
      viewerIdentityId,
    );
    connectionItems.push(...page.items);
    connectionCursor = page.nextCursor;
  } while (connectionCursor !== null);
  const byType = (direction: 'incoming' | 'outgoing') => {
    const grouped = new Map<string, EdgeView[]>();
    for (const edge of connectionItems) {
      const matches = direction === 'outgoing' ? edge.source.id === id : edge.target.id === id;
      if (!matches || REACTION_TYPES.has(edge.type)) continue;
      const list = grouped.get(edge.type);
      if (list) list.push(edge); else grouped.set(edge.type, [edge]);
    }
    return [...grouped].map(([type, edges]) => ({
      type,
      direction,
      label: direction === 'outgoing' ? type : `${type} (incoming)`,
      edges,
    }));
  };
  const unresolvedHardDependencyCount = connectionItems.filter((edge) =>
    edge.source.id === id && edge.type === 'depends_on' && edge.hard !== false && edge.resolved === false,
  ).length;
  const hydrated = await hydrateDetail(q, row, summary.state, detailContent(row, enrichment), viewerIdentityId);
  const content = hydrated.content;
  return {
    ...summary,
    state: hydrated.state,
    content: content.kind === 'collection'
      ? { ...content, items: await collectionItems(q, id, viewerIdentityId) }
      : content,
    hierarchy,
    connections: {
      outgoing: byType('outgoing'),
      incoming: byType('incoming'),
      unresolvedHardDependencyCount,
    },
    capabilities: entityCapabilities(row),
  };
}

async function activityById(q: Querier, id: string): Promise<ActivityItem | undefined> {
  const rows = await q.query<ActivityRow>(
    `select id, entity_id, actor_id, verb, summary, ref_id, work_session_id, created_at
       from public.activity where id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;
  const actors = await loadActors(q, [row.actor_id ?? '']);
  return {
    id: row.id,
    entityId: row.entity_id,
    actor: row.actor_id ? actorOf(actors, row.actor_id) : null,
    verb: row.verb,
    summary: row.summary ?? {},
    createdAt: iso(row.created_at),
    refId: row.ref_id,
    workSessionId: row.work_session_id,
  };
}

const ATTENTION_COLUMNS = `
  id, space_id, entity_id, reason, points, status, version,
  requested_by, acknowledged_by, resolved_by, resolution_note,
  created_at, updated_at, acknowledged_at, resolved_at
`;

async function attentionRequestsOf(
  q: Querier,
  rows: readonly AttentionRequestRow[],
): Promise<AttentionRequest[]> {
  const actors = await loadActors(q, rows.flatMap((row) => [
    row.requested_by,
    row.acknowledged_by ?? '',
    row.resolved_by ?? '',
  ]));
  return rows.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    entityId: row.entity_id,
    reason: row.reason,
    points: Number(row.points),
    status: row.status,
    version: Number(row.version),
    requestedBy: actorOf(actors, row.requested_by),
    acknowledgedBy: row.acknowledged_by ? actorOf(actors, row.acknowledged_by) : null,
    resolvedBy: row.resolved_by ? actorOf(actors, row.resolved_by) : null,
    resolutionNote: row.resolution_note,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    acknowledgedAt: isoOrNull(row.acknowledged_at),
    resolvedAt: isoOrNull(row.resolved_at),
  }));
}

async function attentionMutationResult(
  q: Querier,
  raw: AttentionMutationRpcResult,
  viewerIdentityId: string,
): Promise<AttentionRequestMutationResult> {
  const entityRows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1 and e.deleted_at is null`,
    [raw.entityId],
  );
  const entity = (await loadUniversalSummaries(q, entityRows, viewerIdentityId))[0];
  if (!entity) throw new CollabError('not_found', `no such entity: ${raw.entityId}`);
  const requestRows = raw.attentionRequestId
    ? await q.query<AttentionRequestRow>(
      `select ${ATTENTION_COLUMNS} from public.attention_requests where id = $1`,
      [raw.attentionRequestId],
    )
    : [];
  const request = (await attentionRequestsOf(q, requestRows))[0] ?? null;
  return { request, entity, affectedCount: Number(raw.affectedCount) };
}

const HEADER_KINDS: ReadonlySet<string> = new Set(SELECTION_HEADER_KINDS);

/** The entity's resolved header, under the caller's RLS; undefined for a kind with none. */
async function headerOf(q: Querier, detail: EntityDetail): Promise<EntityHeaderView | undefined> {
  if (!HEADER_KINDS.has(detail.kind)) return undefined;
  return (await resolveHeaderViews(q, detail.spaceId, [detail.id])).get(detail.id);
}

/**
 * An entity read carries `header` only when one is AUTHORED (version > 0).
 * A native or derived header is recomputed from fields the read already
 * carries (a task's derived summary is its own description), so showing it
 * would only add bytes; and until someone writes a header, every read stays
 * byte-identical (headers design §9.5). No `header` means header version 0.
 */
const authored = (header: EntityHeaderView | undefined): EntityHeaderView | undefined =>
  header && header.version > 0 ? header : undefined;

/**
 * `entities.get`'s detail, with `header` when one is authored — or, under the
 * opt-in `header=resolved` (I9a), the header launches actually read: authored,
 * else native, else derived at version 0. The default path is unchanged, so a
 * read that does not ask stays byte-identical.
 */
async function withHeader(q: Querier, detail: EntityDetail, mode: EntityHeaderReadMode = 'authored'): Promise<EntityDetail> {
  if (!HEADER_KINDS.has(detail.kind)) return detail;
  const header = mode === 'resolved'
    ? await headerOf(q, detail)
    : await resolveAuthoredHeaderView(q, detail.spaceId, detail.id);
  return header ? { ...detail, header } : detail;
}

/**
 * A header command's result: the command result, the header now in effect —
 * after a clear, the native/derived one, at version 0 — and the RPC's
 * warnings. A kind with no header at all (work_session, chat, message, c:*)
 * has no `header`; its command was a no-op with `header_not_stored`.
 */
async function headerResult(
  q: Querier,
  id: string,
  raw: HeaderRpcResult,
  result: CommandResult,
): Promise<EntityHeaderResult> {
  if (!result.entity) throw new CollabError('not_found', `no readable entity: ${id}`);
  const warnings = headerWarnings(raw);
  const header = await headerOf(q, result.entity);
  const own = authored(header);
  return {
    ...result,
    entity: own ? { ...result.entity, header: own } : result.entity,
    ...(header ? { header } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function commandResult(
  q: Querier,
  raw: RpcCommandResult,
  viewerIdentityId: string,
): Promise<CommandResult> {
  const patchIds = [...new Set((raw.patches ?? []).map((patch) => patch.id).filter(Boolean))];
  const patchRows = patchIds.length === 0 ? [] : await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    [patchIds],
  );
  const patches = await loadUniversalSummaries(q, patchRows, viewerIdentityId);
  const liveEntity = raw.entity?.id
    ? patchRows.find((row) => row.id === raw.entity?.id && row.deleted_at === null)
      ?? (await q.query<EntityRow>(
        `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1 and e.deleted_at is null`,
        [raw.entity.id],
      ))[0]
    : undefined;
  const entity = liveEntity ? await buildUniversalDetail(q, liveEntity.id, viewerIdentityId) : undefined;

  let edge: EdgeView | undefined;
  if (raw.edge?.id) {
    const rows = await q.query<EdgeRow>(
      `select g.id, g.src_id, g.dst_id, g.type, g.props, g.created_by, g.created_at, g.updated_at,
              case when g.type = 'depends_on' then internal.is_resolved(g.dst_id) else null end resolved
         from public.edges g where g.id = $1`,
      [raw.edge.id],
    );
    const edgeRow = rows[0];
    if (edgeRow) {
      const endpointRows = await q.query<EntityRow>(
        `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[]) and e.deleted_at is null`,
        [[edgeRow.src_id, edgeRow.dst_id]],
      );
      const summaries = new Map(
        (await loadUniversalSummaries(q, endpointRows, viewerIdentityId)).map((summary) => [summary.id, summary]),
      );
      edge = edgeView(edgeRow, summaries, await loadActors(q, [edgeRow.created_by])) ?? undefined;
    }
  }
  const activity = raw.activity ? await activityById(q, raw.activity) : undefined;
  return {
    ...(entity ? { entity } : {}),
    ...(edge ? { edge } : {}),
    ...(activity ? { activity } : {}),
    patches,
    ...(raw.undo ? { undo: raw.undo } : {}),
  };
}

function normalizeReason(error: unknown): never {
  if (isCollabError(error)) {
    const details = error.details as Record<string, unknown> | undefined;
    const reason = typeof details?.detail === 'string' ? details.detail : undefined;
    if (reason) {
      const { detail: _detail, ...rest } = details ?? {};
      throw new CollabError(error.code, error.message, {
        details: { ...rest, reason },
        current: error.current,
      });
    }
  }
  throw error;
}

function assertGenericLifecycle(kind: string, operation: string): void {
  if (RESTRICTED_LIFECYCLE_KINDS.has(kind)) {
    throw new CollabError('forbidden', `${operation} is owned by the ${kind} lifecycle`);
  }
}

/**
 * THE CONTENT MEMBERS EACH `entities.patch` ARM FORWARDS — and therefore the
 * only ones it may accept. Every arm below reads a fixed list of members off
 * `content` and hands them to its RPC; anything else used to fall on the floor
 * while the call reported success, so `{"body": …}` aimed at a task (whose
 * prose member is `description`) exited 0 having changed nothing. A member no
 * arm reads is now refused BY NAME, the rule the `work_session` and `worktree`
 * arms already state for themselves (they keep their own, stricter checks and
 * are absent here).
 *
 * `kind` is admitted when it names the STORED kind: the content shapes the
 * CLI documents carry it as a discriminator. A `kind` naming another kind is a
 * patch aimed at the wrong entity, refused rather than ignored. A patch that
 * carries neither a title nor any forwarded member is refused too: it can
 * only ever be a no-op reported as an update.
 *
 * `graph` and `drawing` are absent on purpose: their doors are SOFT gates by
 * design (Craft P1 — see `softGraphContent`), validating the members they name
 * and passing the rest through.
 *
 * This list and the switch in `patchEntity` must move together.
 */
const PATCH_CONTENT_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  task: ['description', 'axes', 'status', 'priority', 'acceptanceCriteria', 'pointsEstimate',
    'dueDate', 'startDate'],
  doc: ['body', 'format'],
  channel: ['topic'],
  collection: ['description', 'collectionType'],
  team_member: ['role', 'identity', 'model', 'agentTool', 'mode', 'permissionMode', 'capabilities',
    'commandPermissions', 'avatar', 'memories'],
  file: ['mimeType'],
  spell: ['description', 'rule'],
  skill: ['description', 'content'],
  pull_request: ['url', 'state', 'headSha'],
  commit: ['url', 'author', 'committedAt'],
  memory: ['statement', 'mechanism', 'subjectScope', 'doesNotEstablish', 'measuredAt'],
  loop: ['schedule', 'teamMemberId', 'subjectId', 'prompt', 'config', 'enabled', 'nextRunAt'],
};

function assertPatchContentMembers(
  kind: string,
  title: string | undefined,
  content: Record<string, unknown>,
): void {
  const accepted = PATCH_CONTENT_MEMBERS[kind] ?? (kind.startsWith('c:') ? ['fields'] : undefined);
  if (!accepted) return;
  if (content.kind !== undefined && content.kind !== kind) {
    throw new CollabError('invalid_input',
      `content.kind '${String(content.kind)}' does not match this entity's kind '${kind}'`);
  }
  const ignored = Object.keys(content).filter((k) => k !== 'kind' && !accepted.includes(k));
  if (ignored.length > 0) {
    throw new CollabError('invalid_input',
      `${kind} patch does not accept content ${ignored.length === 1 ? 'field' : 'fields'} `
        + `${ignored.join(', ')}; accepted: ${accepted.join(', ')}`);
  }
  // With no title and no member an arm forwards, the RPC would still run —
  // and report an update that changed nothing.
  if (title === undefined && !Object.keys(content).some((k) => accepted.includes(k))) {
    throw new CollabError('invalid_input',
      `${kind} patch changes nothing: it carries no title and no content member (accepted: ${accepted.join(', ')})`);
  }
}

async function kindFor(q: Querier, id: string): Promise<string> {
  const rows = await q.query<{ kind: string }>(
    `select kind from public.entities where id = $1 and deleted_at is null`,
    [id],
  );
  if (!rows[0]) throw new CollabError('not_found', `no such entity: ${id}`);
  return rows[0].kind;
}

/**
 * NORMALISE THE CRITERIA, AND OWN THE `done` PROVENANCE.
 *
 * `doneBy`/`doneAt` used to pass through VERBATIM in both directions, which is
 * wrong at both edges and stayed invisible for as long as nothing wrote the
 * field: the tm8-ui task panel's acceptance region is its first writer.
 *
 *   · TICKED and unstamped ⇒ STAMP IT HERE. The client cannot honestly: it
 *     does not know the acting principal (delegation makes "the signed-in
 *     member" the wrong answer) and its clock is not one anyone should record.
 *     Both are right here — the request envelope and this node's clock.
 *   · UN-TICKED ⇒ DROP THE STAMP. Preserving it produced `{done:false,
 *     doneBy:'…', doneAt:'…'}` — a record saying "not done, completed by forge
 *     at 09:14" and daring the reader to pick a half to believe.
 *
 * An EXISTING stamp on a still-done criterion is PRESERVED, never refreshed:
 * it records when the condition was met, not when the row was last patched.
 */
/**
 * Craft P1: the graph door's SOFT gate. Container shapes only (R2 — lean by
 * law): a malformed member is refused by name here, before the RPC, so the
 * caller sees `invalid_input` with zod's path rather than a bare SQLSTATE;
 * everything the schema does not name passes through untouched.
 */
function softGraphContent(content: Record<string, unknown>) {
  const parsed = GraphContentInputSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CollabError('invalid_input',
      `graph content: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`);
  }
  return parsed.data;
}

/**
 * THE MATERIALIZE WRITE-BACK: `content.link = {nodeId: entityId}` sets `ref` on
 * each named node and keeps its `spec` — the node now reads as MATERIALIZED.
 * Strictly additive: a patch without `link` takes the unchanged path above.
 * Every unknown node id and every non-entity-id value is refused BY NAME,
 * with the ids the row does carry, so a typo can never read as a link landed.
 */
function linkNodes(graphId: string, nodes: readonly unknown[], link: Record<string, unknown>): unknown[] {
  const result = applyGraphLinks(nodes.map((n) => (n && typeof n === 'object' ? n : {}) as Record<string, unknown>), link);
  if (result.unknownKeys.length > 0) {
    const known = nodes.map((n, i) => graphNodeKey((n && typeof n === 'object' ? n : {}) as Record<string, unknown>, i));
    throw new CollabError('invalid_input',
      `graph ${graphId} has no node ${result.unknownKeys.join(', ')}; its nodes: ${known.length > 0 ? known.join(', ') : 'none'}`,
      { details: { reason: 'unknown_node', unknown: result.unknownKeys, known } });
  }
  if (result.invalidRefs.length > 0) {
    throw new CollabError('invalid_input',
      `graph link: ${result.invalidRefs.join(', ')} must map to an entity id`,
      { details: { reason: 'invalid_ref', nodes: result.invalidRefs } });
  }
  return result.nodes;
}

/**
 * The stored nodes a `link`-only patch merges into — read WITH the version, and
 * refused unless it is the version the caller expects. The RPC re-checks under
 * its row lock; this check is what stops a caller whose `expectedVersion` is
 * AHEAD of the row we read from writing nodes merged into a stale copy.
 */
async function storedGraphNodes(q: Querier, id: string, expectedVersion: number): Promise<unknown[]> {
  const rows = await q.query<{ version: number; nodes: unknown }>(
    `select e.version, g.nodes from public.entities e join public.graphs g on g.entity_id = e.id
      where e.id = $1 and e.deleted_at is null`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new CollabError('not_found', `no such graph: ${id}`);
  if (row.version !== expectedVersion) {
    throw new CollabError('version_conflict', `version conflict on ${id}`,
      { details: { entityId: id, currentVersion: row.version } });
  }
  return Array.isArray(row.nodes) ? row.nodes : [];
}

function softDrawingContent(content: Record<string, unknown>) {
  const parsed = DrawingContentInputSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CollabError('invalid_input',
      `drawing content: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'malformed'}`);
  }
  return parsed.data;
}

function acceptanceCriteria(
  content: Record<string, unknown>,
  actorId: string | null,
): unknown[] {
  const criteria = content.acceptanceCriteria;
  if (!Array.isArray(criteria)) return [];
  const now = new Date().toISOString();
  return criteria.map((criterion, index) => {
    const value = typeof criterion === 'object' && criterion !== null
      ? criterion as Record<string, unknown>
      : {};
    const done = value.done === true;
    const doneBy = typeof value.doneBy === 'string' ? value.doneBy : actorId;
    const doneAt = typeof value.doneAt === 'string' ? value.doneAt : now;
    return {
      id: typeof value.id === 'string' ? value.id : `ac_${index + 1}`,
      text: typeof value.text === 'string' ? value.text : '',
      done,
      ...(done && doneBy ? { doneBy } : {}),
      ...(done ? { doneAt } : {}),
    };
  });
}

async function attachInitialConnections(
  q: Querier,
  raw: RpcCommandResult,
  input: CreateEntityInput,
): Promise<void> {
  const entityId = raw.entity?.id;
  if (!entityId) return;
  const requested = [
    ...(input.attachTo && input.kind !== 'task' && input.kind !== 'doc'
      ? [{ type: input.attachTo.edgeType, targetId: input.attachTo.entityId, props: {} }]
      : []),
    ...(input.connections ?? []),
  ];
  for (const connection of requested) {
    if (Object.prototype.hasOwnProperty.call(connection.props ?? {}, 'origin')) {
      throw new CollabError('forbidden', 'connection props.origin is Server-owned');
    }
    const existing = await q.query<{ id: string }>(
      `select id from public.edges where src_id = $1 and dst_id = $2 and type = $3`,
      [entityId, connection.targetId, connection.type],
    );
    if (existing[0]) continue;
    const edgeRaw = await q.rpc<RpcCommandResult>('write_edge', [
      entityId,
      connection.targetId,
      connection.type,
      JSON.stringify(connection.props ?? {}),
      input.actorId ?? null,
      null,
    ]);
    if (!raw.edge && edgeRaw.edge) raw.edge = edgeRaw.edge;
    raw.patches = [
      ...(raw.patches ?? []),
      ...(edgeRaw.patches ?? []),
    ];
  }
  if (!raw.edge) {
    const edgeRows = await q.query<NonNullable<RpcCommandResult['edge']>>(
      `select id, src_id, dst_id, type, props, created_by, created_at, updated_at
         from public.edges where src_id = $1 order by created_at, id limit 1`,
      [entityId],
    );
    if (edgeRows[0]) raw.edge = edgeRows[0];
  }
}

interface ParsedProviderRef {
  provider: string;
  repo: string;
  identifier: string;
}

function parseProviderUrl(urlValue: string, kind: 'pull_request' | 'commit'): ParsedProviderRef {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new CollabError('invalid_input', 'tracking URL is invalid');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const marker = kind === 'pull_request'
    ? segments.findIndex((segment) => segment === 'pull' || segment === 'merge_requests')
    : segments.findIndex((segment) => segment === 'commit' || segment === 'commits');
  if (marker < 2 || marker + 1 >= segments.length) {
    throw new CollabError('invalid_input', `URL is not a ${kind === 'pull_request' ? 'pull request' : 'commit'} URL`);
  }
  const identifier = segments[marker + 1]!;
  if (kind === 'pull_request' && (!/^\d+$/.test(identifier) || Number(identifier) < 1)) {
    throw new CollabError('invalid_input', 'pull request URL has an invalid number');
  }
  if (kind === 'commit' && !/^[a-f0-9]{7,64}$/i.test(identifier)) {
    throw new CollabError('invalid_input', 'commit URL has an invalid sha');
  }
  const repoSegments = segments.slice(0, marker);
  if (repoSegments.at(-1) === '-') repoSegments.pop();
  return {
    provider: url.hostname.toLowerCase() === 'github.com' ? 'github' : url.hostname.toLowerCase(),
    repo: repoSegments.join('/'),
    identifier,
  };
}

export class W2EntitiesCommandsTrackingService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly getEntity = async (ctx: RequestContext): Promise<EntityDetail> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    // Only `header` is read: the route took no query before, and it still
    // ignores every other key. An unknown mode reads as the default and says
    // so in `warnings` (instruct, don't refuse).
    const { mode, warning } = headerReadMode(ctx.query.get('header'));
    const detail = await this.deps.db.tx(claimsFor(owner, ctx), async (q) => withHeader(q, await buildUniversalDetail(q, id, owner.identityId), mode));
    return warning ? { ...detail, warnings: [warning] } : detail;
  };

  readonly createEntity = async (ctx: RequestContext): Promise<CommandResult | ServerReceipt> => {
    const owner = await this.deps.owner();
    const input = ctx.body as CreateEntityInput;
    const envelope = commandEnvelope(ctx);
    const content = (input.content ?? {}) as Record<string, unknown>;
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      let raw: RpcCommandResult;
      switch (input.kind) {
        case 'task':
          raw = await q.rpc('create_task', [input.spaceId, input.title, envelope.actorId ?? null,
            content.description ?? '', content.axes ?? {}, input.parentId ?? null, input.position ?? null,
            content.priority ?? 'medium',
            JSON.stringify(acceptanceCriteria(content, envelope.actorId ?? null)),
            content.pointsEstimate ?? null, content.dueDate ?? null, content.startDate ?? null,
            input.attachTo?.entityId ?? null,
            input.attachTo?.edgeType ?? 'attached_to', envelope.clientMutationId ?? null]);
          break;
        case 'doc':
          raw = await q.rpc('create_document', [input.spaceId, input.title, envelope.actorId ?? null,
            content.body ?? '', content.format ?? 'markdown', input.parentId ?? null, input.position ?? null,
            input.attachTo?.entityId ?? null, input.attachTo?.edgeType ?? 'attached_to',
            envelope.clientMutationId ?? null]);
          break;
        case 'channel':
          raw = await q.rpc('create_channel', [input.spaceId, input.title, envelope.actorId ?? null,
            content.topic ?? '', input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        // A voice channel has no topic and no feed, so the title IS the whole
        // content. The RPC lowercases and trims it into the same slug grammar
        // channels use (053), which is why nothing is normalised here.
        case 'voice_channel':
          raw = await q.rpc('create_voice_channel', [input.spaceId, input.title, envelope.actorId ?? null,
            input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'collection':
          raw = await q.rpc('create_collection', [input.spaceId, input.title, envelope.actorId ?? null,
            content.description ?? '', content.collectionType ?? 'manual', input.parentId ?? null,
            input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'team_member':
          raw = await q.rpc('create_team_member', [input.spaceId, input.title, envelope.actorId ?? null,
            content.role ?? '', content.identity ?? '', content.model ?? null, content.agentTool ?? null,
            content.mode ?? null, content.permissionMode ?? null, JSON.stringify(content.capabilities ?? {}),
            JSON.stringify(content.commandPermissions ?? {}), content.avatar ?? null, input.parentId ?? null,
            input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'file':
          raw = await q.rpc('create_file_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            content.mimeType ?? 'application/octet-stream', input.parentId ?? null, input.position ?? null,
            envelope.clientMutationId ?? null]);
          break;
        case 'spell':
          raw = await q.rpc('create_spell_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            content.description ?? '', JSON.stringify(content.rule ?? {}), input.parentId ?? null,
            input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'skill':
          raw = await q.rpc('create_skill_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            content.description ?? '', content.content ?? '', input.parentId ?? null,
            input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'pull_request':
          raw = await q.rpc('create_pull_request_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            content.provider ?? 'github', content.url ?? null, content.repository ?? content.repo ?? null,
            content.number ?? null, content.state ?? 'open', content.headSha ?? null,
            input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'commit':
          raw = await q.rpc('create_commit_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            content.provider ?? 'github', content.url ?? null, content.repository ?? content.repo ?? null,
            content.sha ?? null, content.author ?? null, content.committedAt ?? null,
            input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'memory':
          // No title argument: the title is derived from the statement (056).
          // No parentId: memories are outside hierarchy, refused at the data
          // layer. `workSessionId` is validated server-side against the
          // actor's participates_in edge — provenance is never client-drawn.
          raw = await q.rpc('create_memory', [input.spaceId,
            content.statement ?? input.title ?? '', content.mechanism ?? '',
            content.subjectScope ?? '', content.doesNotEstablish ?? '',
            content.measuredAt ?? null, envelope.actorId ?? null,
            input.position ?? null, content.workSessionId ?? null,
            envelope.clientMutationId ?? null]);
          break;
        case 'loop':
          // Zero new catalog rows: a loop is created through the ordinary
          // entities.create envelope, exactly as a memory is (056 pattern).
          // Same-space containment of teamMemberId/subjectId is enforced in the
          // door, not here — a check on this side would be advisory only.
          raw = await q.rpc('create_loop', [input.spaceId, input.title, envelope.actorId ?? null,
            content.schedule ?? null, content.teamMemberId ?? null, content.subjectId ?? null,
            content.prompt ?? '', JSON.stringify(content.config ?? {}),
            content.enabled ?? true, content.nextRunAt ?? null,
            input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        case 'graph': {
          // Craft P1 (135): SOFT validation by law (R2) — the schema asserts
          // node/edge/layout container shapes and passes unknown members
          // through; it must never grow into a program schema. The same 056
          // posture as memory/loop: zero new catalog rows.
          const graph = softGraphContent(content);
          const nodes = graph.link === undefined ? graph.nodes : linkNodes('new graph', graph.nodes ?? [], graph.link);
          raw = await q.rpc('create_graph_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            graph.graphType ?? 'entity',
            JSON.stringify(nodes ?? []), JSON.stringify(graph.edges ?? []),
            JSON.stringify(graph.layout ?? {}), graph.source ?? null,
            input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        }
        case 'drawing': {
          // 194: zero new catalog rows, the 056/091/135 posture exactly — a
          // drawing is born through the ordinary envelope. Attaching it to a
          // task needs nothing here either: `attachInitialConnections` below
          // writes the `attached_to` edge from `input.attachTo`, which is the
          // real attachment door (a task cannot be a drawing's PARENT —
          // `validate_entity_parent` requires matching kinds).
          const drawing = softDrawingContent(content);
          raw = await q.rpc('create_drawing_entity', [input.spaceId, input.title, envelope.actorId ?? null,
            drawing.format ?? 'excalidraw',
            JSON.stringify(drawing.elements ?? []), JSON.stringify(drawing.appState ?? {}),
            JSON.stringify(drawing.files ?? {}),
            input.parentId ?? null, input.position ?? null, envelope.clientMutationId ?? null]);
          break;
        }
        default:
          if (!input.kind.startsWith('c:')) {
            throw new CollabError('forbidden', `entities.create is owned by the ${input.kind} lifecycle`);
          }
          raw = await q.rpc('create_custom_entity', [input.spaceId, input.kind, input.title,
            envelope.actorId ?? null, JSON.stringify(content.fields ?? content), input.parentId ?? null,
            input.position ?? null, envelope.clientMutationId ?? null]);
      }
      await attachInitialConnections(q, raw, input);
      // An authored header rides the create's transaction: the entity and its
      // header land together or not at all (headers design §3.1). On a kind
      // that stores none the create still succeeds, and says why (223).
      const warnings = input.header && raw.entity?.id
        ? headerWarnings(await setEntityHeader(q, raw.entity.id, input.header, 0, envelope.actorId ?? null,
          createHeaderMutationId(envelope.clientMutationId)))
        : [];
      const receipt = wantsReceipt(ctx) ? await buildReceipt(q, 'entity.create', raw) : undefined;
      return withHeaderWarnings(receipt ?? await commandResult(q, raw, owner.identityId), warnings);
    });
  };

  readonly patchEntity = async (ctx: RequestContext): Promise<CommandResult | ServerReceipt> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as PatchEntityInput;
    const envelope = commandEnvelope(ctx);
    const content = (input.content ?? {}) as Record<string, unknown>;
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const kind = await kindFor(q, id);
        // `work_session` stays in RESTRICTED_LIFECYCLE_KINDS — create, move,
        // delete and restore are owned by the execution block and must keep
        // refusing. A rename is not lifecycle: it renames the LABEL a person
        // reads in a list of live agents, so this one door is opened by name
        // rather than by taking the kind out of the set (085).
        if (kind !== 'work_session') assertGenericLifecycle(kind, 'entities.patch');
        assertPatchContentMembers(kind, input.title, content);
        const before = wantsReceipt(ctx) ? await receiptSnapshot(q, id) : undefined;
        let raw: RpcCommandResult;
        switch (kind) {
          case 'task':
            raw = await q.rpc('update_task_content', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.description ?? null, content.axes ?? null,
              content.status ?? null, content.priority ?? null,
              content.acceptanceCriteria === undefined
                ? null
                : JSON.stringify(acceptanceCriteria(content, envelope.actorId ?? null)),
              content.pointsEstimate ?? null, content.dueDate ?? null, content.dueDate === null,
              content.startDate ?? null, content.startDate === null,
              envelope.clientMutationId ?? null]);
            break;
          case 'doc':
            raw = await q.rpc('update_document', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.body ?? null, content.format ?? null, envelope.clientMutationId ?? null]);
            break;
          case 'channel':
            raw = await q.rpc('update_channel', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.topic ?? null, envelope.clientMutationId ?? null]);
            break;
          case 'collection':
            raw = await q.rpc('update_collection', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.description ?? null, content.collectionType ?? null,
              envelope.clientMutationId ?? null]);
            break;
          case 'team_member':
            raw = await q.rpc('update_team_member', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.role ?? null, content.identity ?? null, content.model ?? null,
              content.agentTool ?? null, content.mode ?? null, content.permissionMode ?? null,
              content.capabilities === undefined ? null : JSON.stringify(content.capabilities),
              content.commandPermissions === undefined ? null : JSON.stringify(content.commandPermissions),
              content.avatar ?? null, content.memories === undefined ? null : JSON.stringify(content.memories),
              envelope.clientMutationId ?? null]);
            break;
          case 'file':
            raw = await q.rpc('update_file_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.mimeType ?? null, envelope.clientMutationId ?? null]);
            break;
          case 'spell':
            raw = await q.rpc('update_spell_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.description ?? null,
              content.rule === undefined ? null : JSON.stringify(content.rule), envelope.clientMutationId ?? null]);
            break;
          case 'skill':
            raw = await q.rpc('update_skill_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.description ?? null, content.content ?? null,
              envelope.clientMutationId ?? null]);
            break;
          case 'pull_request':
            raw = await q.rpc('update_pull_request_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.url ?? null, content.state ?? null, content.headSha ?? null,
              envelope.clientMutationId ?? null]);
            break;
          case 'commit':
            raw = await q.rpc('update_commit_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.url ?? null, content.author ?? null, content.committedAt ?? null,
              envelope.clientMutationId ?? null]);
            break;
          case 'memory':
            // Edits are for typos: any material edit bumps the version and
            // un-pins every inbound verification. Wrong memories are
            // superseded, never edited. Title is derived — input.title is
            // deliberately NOT forwarded.
            raw = await q.rpc('update_memory', [id, input.expectedVersion, envelope.actorId ?? null,
              content.statement ?? null, content.mechanism ?? null,
              content.subjectScope ?? null, content.doesNotEstablish ?? null,
              content.measuredAt ?? null, content.measuredAt === null,
              envelope.clientMutationId ?? null]);
            break;
          case 'work_session': {
            // The door accepts EXACTLY a title. Every other column on the row
            // — status, model, node, workdir, the exit evidence — has a writer
            // in the execution block, and a content member silently dropped
            // here would read to the caller as a patch that worked. Refused BY
            // NAME, the same rule the worktree arm below states.
            const rejected = Object.keys(content);
            if (rejected.length > 0) {
              throw new CollabError('invalid_input',
                `work_session patch accepts title only, not: ${rejected.join(', ')}`);
            }
            if (typeof input.title !== 'string') {
              throw new CollabError('invalid_input', 'work_session patch requires title');
            }
            raw = await q.rpc('rename_work_session', [id, input.expectedVersion,
              envelope.actorId ?? null, input.title, envelope.clientMutationId ?? null]);
            break;
          }
          case 'loop':
            // `null` MERGES and the explicit `clear*` booleans are the only way
            // to null a column — so an unrelated patch cannot silently
            // unschedule a loop or drop its runner.
            raw = await q.rpc('update_loop', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, content.schedule ?? null,
              content.teamMemberId ?? null, content.teamMemberId === null,
              content.subjectId ?? null, content.subjectId === null,
              content.prompt ?? null,
              content.config === undefined ? null : JSON.stringify(content.config),
              content.enabled ?? null,
              content.nextRunAt ?? null, content.nextRunAt === null,
              null, null, false,
              envelope.clientMutationId ?? null]);
            break;
          case 'graph': {
            // Craft P1: `null` MERGES (a patch carries only what it changes —
            // the one-guarded-patch-per-turn crafting flow), and an explicit
            // `source: null` is the clear signal, the loop pattern exactly.
            const graph = softGraphContent(content);
            const nodes = graph.link === undefined
              ? graph.nodes
              : linkNodes(id, graph.nodes ?? await storedGraphNodes(q, id, input.expectedVersion), graph.link);
            raw = await q.rpc('update_graph_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, graph.graphType ?? null,
              nodes === undefined ? null : JSON.stringify(nodes),
              graph.edges === undefined ? null : JSON.stringify(graph.edges),
              graph.layout === undefined || graph.layout === null ? null : JSON.stringify(graph.layout),
              graph.source ?? null, graph.source === null,
              envelope.clientMutationId ?? null]);
            break;
          }
          case 'drawing': {
            // `null` MERGES, the graph/loop pattern: the debounced editor
            // sends elements and appState and must not wipe the title it did
            // not restate. There is no explicit clear — every column has a
            // non-null default and "empty" is '[]'/'{}', never null.
            const drawing = softDrawingContent(content);
            raw = await q.rpc('update_drawing_entity', [id, input.expectedVersion, envelope.actorId ?? null,
              input.title ?? null, drawing.format ?? null,
              drawing.elements === undefined ? null : JSON.stringify(drawing.elements),
              drawing.appState === undefined ? null : JSON.stringify(drawing.appState),
              drawing.files === undefined ? null : JSON.stringify(drawing.files),
              envelope.clientMutationId ?? null]);
            break;
          }
          case 'worktree': {
            // The door accepts EXACTLY a status transition (+ an optional
            // preflight token). Everything else is refused BY NAME with
            // invalid_input — never a silent drop (worktree design §2.5).
            // `worktree` stays OUT of RESTRICTED_LIFECYCLE_KINDS on purpose:
            // restricting it would make this door unreachable.
            if (input.title !== undefined) {
              throw new CollabError('invalid_input', 'worktree title is derived from the branch and cannot be patched');
            }
            const immutable = ['path', 'branch', 'baseRef', 'baseCommitOid', 'projectId']
              .filter((field) => field in content);
            if (immutable.length > 0) {
              throw new CollabError('invalid_input', `worktree ${immutable.join(', ')} is immutable after creation`);
            }
            const unknown = Object.keys(content).filter((k) => k !== 'status' && k !== 'preflightToken');
            if (unknown.length > 0) {
              throw new CollabError('invalid_input', `worktree patch does not accept: ${unknown.join(', ')}`);
            }
            if (typeof content.status !== 'string') {
              throw new CollabError('invalid_input', 'worktree patch requires content.status');
            }
            raw = await q.rpc('update_worktree', [id, input.expectedVersion, content.status,
              envelope.actorId ?? null, envelope.clientMutationId ?? null,
              typeof content.preflightToken === 'string' ? content.preflightToken : null]);
            break;
          }
          default:
            if (!kind.startsWith('c:')) throw new CollabError('not_implemented', `entities.patch does not support ${kind}`);
            raw = await q.rpc('update_custom_entity', [id, input.expectedVersion, input.title ?? null,
              envelope.actorId ?? null, content.fields === undefined ? null : JSON.stringify(content.fields),
              envelope.clientMutationId ?? null]);
        }
        const receipt = before ? await buildReceipt(q, 'entity.update', raw, { before }) : undefined;
        return receipt ?? commandResult(q, raw, owner.identityId);
      });
    } catch (error) {
      throw await this.withCurrent(error, owner, ctx, id);
    }
  };

  /**
   * `entities.header.set` — write an entity's authored selection header
   * (migration 216's `set_entity_header`). The header has its own version;
   * `entities.version` never moves, so a header write can never fail an
   * in-flight body edit or un-pin a verification.
   */
  readonly setHeader = async (ctx: RequestContext): Promise<EntityHeaderResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as SetEntityHeaderInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await setEntityHeader(q, id, input, input.expectedVersion, envelope.actorId ?? null,
        envelope.clientMutationId ?? null);
      return headerResult(q, id, raw, await commandResult(q, raw, owner.identityId));
    });
  };

  /**
   * `entities.header.clear` — remove the authored header, so the entity falls
   * back to its native/derived one. The header's expected version is optional;
   * an entity with no authored header is a no-op with a warning.
   */
  readonly clearHeader = async (ctx: RequestContext): Promise<EntityHeaderResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as ClearEntityHeaderInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await clearEntityHeader(q, id, input.expectedVersion, envelope.actorId ?? null,
        envelope.clientMutationId ?? null);
      return headerResult(q, id, raw, await commandResult(q, raw, owner.identityId));
    });
  };

  /** A version conflict owes the caller the `current` it lost to; anything else passes through. */
  private async withCurrent(
    error: unknown,
    owner: Awaited<ReturnType<FacadeDeps['owner']>>,
    ctx: RequestContext,
    id: string,
  ): Promise<unknown> {
    if (!isCollabError(error) || error.code !== 'version_conflict') return error;
    try {
      const current = await this.deps.db.tx(claimsFor(owner, ctx), (q) =>
        buildUniversalDetail(q, id, owner.identityId));
      return new CollabError('version_conflict', error.message, {
        current,
        details: { ...(error.details ?? {}), current },
      });
    } catch {
      return error;
    }
  }

  /**
   * `entities.commands.tick` — set `done` on named acceptance criteria, MERGED
   * BY ID into the stored list.
   *
   * WHY AN OPERATION AND NOT PATCH SUGAR. The patch door takes the WHOLE
   * `acceptanceCriteria` array (`update_task_content` replaces the column), so
   * ticking one criterion through it means reading the task, learning the
   * member's name, and restating every criterion — measured live at 29.5 KB of
   * `entity get` per agent just to find the key. Here the caller names ids;
   * the read and the merge happen server-side, in the transaction that writes.
   *
   * ONE WRITE PATH. The merged list goes through the same `update_task_content`
   * RPC and the same `acceptanceCriteria` normaliser as a patch, so the
   * version guard, the `doneBy`/`doneAt` stamping and the activity row are the
   * patch door's own, not a second copy. A ticked criterion loses any stale
   * stamp so the normaliser stamps the actor making THIS call.
   *
   * An id the task does not carry is refused BY NAME with the ids it does
   * carry — never dropped — so a typo cannot read as a tick that landed.
   */
  readonly tickCriteria = async (ctx: RequestContext): Promise<CommandResult | ServerReceipt> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as TickCriteriaInput;
    const envelope = commandEnvelope(ctx);
    const done = input.done ?? true;
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const kind = await kindFor(q, id);
        if (kind !== 'task') {
          throw new CollabError('invalid_input', `only a task carries acceptance criteria; ${id} is a ${kind}`);
        }
        const rows = await q.query<{ acceptance_criteria: unknown }>(
          'select acceptance_criteria from public.tasks where entity_id = $1',
          [id],
        );
        const stored = Array.isArray(rows[0]?.acceptance_criteria)
          ? rows[0]!.acceptance_criteria as Array<Record<string, unknown>>
          : [];
        const known = stored.map((c) => String(c?.id ?? ''));
        const unknown = [...new Set(input.criterionIds)].filter((cid) => !known.includes(cid));
        if (unknown.length > 0) {
          throw new CollabError('invalid_input',
            `task ${id} has no acceptance ${unknown.length === 1 ? 'criterion' : 'criteria'} `
              + `${unknown.join(', ')}; its criteria: ${known.length > 0 ? known.join(', ') : 'none'}`,
            { details: { reason: 'unknown_criterion', unknown, known } });
        }
        const named = new Set(input.criterionIds);
        const merged = stored.map((c) => {
          if (!named.has(String(c?.id ?? ''))) return c;
          const { doneBy: _by, doneAt: _at, ...rest } = c;
          // Already in the asked state: keep its stamp, it is still true.
          return c?.done === done ? c : { ...rest, done };
        });
        const before = wantsReceipt(ctx) ? await receiptSnapshot(q, id) : undefined;
        const raw = await q.rpc<RpcCommandResult>('update_task_content', [id, input.expectedVersion,
          envelope.actorId ?? null, null, null, null, null, null,
          JSON.stringify(acceptanceCriteria({ acceptanceCriteria: merged }, envelope.actorId ?? null)),
          null, null, false, null, false,
          envelope.clientMutationId ?? null]);
        const receipt = before ? await buildReceipt(q, 'task.tick', raw, { before }) : undefined;
        return receipt ?? commandResult(q, raw, owner.identityId);
      });
    } catch (error) {
      throw await this.withCurrent(error, owner, ctx, id);
    }
  };

  readonly listAttentionRequests = async (ctx: RequestContext): Promise<AttentionRequestPage> => {
    const owner = await this.deps.owner();
    const spaceId = ctx.query.get('spaceId') ?? '';
    if (!UUID_RE.test(spaceId)) throw new CollabError('invalid_input', 'spaceId must be a uuid');
    const entityId = ctx.query.get('entityId');
    if (entityId !== null && !UUID_RE.test(entityId)) {
      throw new CollabError('invalid_input', 'entityId must be a uuid');
    }
    const status = ctx.query.get('status');
    const statuses = new Set(['open', 'acknowledged', 'resolved', 'dismissed']);
    if (status !== null && !statuses.has(status)) {
      throw new CollabError('invalid_input', 'invalid attention request status');
    }
    const minPointsRaw = ctx.query.get('minPoints');
    const minPoints = minPointsRaw === null ? null : Number(minPointsRaw);
    if (minPoints !== null && (!Number.isInteger(minPoints) || minPoints < 1 || minPoints > 100)) {
      throw new CollabError('invalid_input', 'minPoints must be an integer from 1 to 100');
    }
    const limit = limitOf(ctx.query.get('limit'));
    const fp = fingerprint('attentionRequests.list', { spaceId, entityId, status, minPoints });
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) => {
      const values: unknown[] = [spaceId];
      const where = ['space_id = $1'];
      if (entityId) { values.push(entityId); where.push(`entity_id = $${values.length}`); }
      if (status) { values.push(status); where.push(`status = $${values.length}`); }
      if (minPoints !== null) { values.push(minPoints); where.push(`points >= $${values.length}`); }
      const cursor = ctx.query.get('cursor');
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k[0] !== fp || decoded.k.length !== 5) {
          throw new CollabError('invalid_cursor', 'attention cursor does not match this query');
        }
        const points = Number(decoded.k[1]);
        const at = cursorIso(decoded.k[2]);
        const id = cursorUuid(decoded.k[3]);
        if (!Number.isInteger(points)) throw new CollabError('invalid_cursor', 'invalid attention points cursor');
        values.push(points, at, id);
        const pointParam = `$${values.length - 2}`;
        const atParam = `$${values.length - 1}`;
        const idParam = `$${values.length}`;
        where.push(`(points < ${pointParam} or (points = ${pointParam} and (created_at, id) > (${atParam}::timestamptz, ${idParam}::uuid)))`);
      }
      const rows = await q.query<AttentionRequestRow>(
        `select ${ATTENTION_COLUMNS}, ${MICROS('created_at')} cursor_created_at
           from public.attention_requests
          where ${where.join(' and ')}
          order by points desc, created_at asc, id asc
          limit ${limit + 1}`,
        values,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await attentionRequestsOf(q, pageRows);
      const last = pageRows.at(-1);
      return {
        items,
        nextCursor: hasMore && last
          ? encodeCursor([fp, Number(last.points), last.cursor_created_at!, last.id, 'attention'])
          : null,
      };
    });
  };

  readonly createAttentionRequest = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const entityId = requireUuidParam(ctx, 'entityId');
    const input = ctx.body as CreateAttentionRequestInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('create_attention_request', [
        entityId,
        input.reason,
        input.points,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly updateAttentionRequest = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const requestId = requireUuidParam(ctx, 'requestId');
    const input = ctx.body as UpdateAttentionRequestInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('update_attention_request', [
        requestId,
        input.expectedVersion,
        input.reason ?? null,
        input.points ?? null,
        input.status ?? null,
        input.resolutionNote ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly resolveEntityAttention = async (ctx: RequestContext): Promise<AttentionRequestMutationResult> => {
    const owner = await this.deps.owner();
    const entityId = requireUuidParam(ctx, 'entityId');
    const input = ctx.body as ResolveEntityAttentionInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<AttentionMutationRpcResult>('resolve_entity_attention', [
        entityId,
        input.resolutionNote ?? null,
        envelope.actorId ?? null,
        envelope.clientMutationId ?? null,
      ]);
      return attentionMutationResult(q, raw, owner.identityId);
    });
  };

  readonly moveEntity = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as MoveEntityInput;
    const envelope = commandEnvelope(ctx);
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        assertGenericLifecycle(await kindFor(q, id), 'entities.move');
        const raw = await q.rpc<RpcCommandResult>('move_entity', [id, input.parentId, input.position,
          input.expectedVersion, envelope.actorId ?? null, envelope.clientMutationId ?? null]);
        return commandResult(q, raw, owner.identityId);
      });
    } catch (error) {
      if (isCollabError(error) && error.code === 'version_conflict') {
        const current = await this.deps.db.tx(claimsFor(owner, ctx), (q) =>
          buildUniversalDetail(q, id, owner.identityId));
        throw new CollabError('version_conflict', error.message, {
          current,
          details: { ...(error.details ?? {}), current },
        });
      }
      throw error;
    }
  };

  readonly deleteEntity = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      assertGenericLifecycle(await kindFor(q, id), 'entities.delete');
      const raw = await q.rpc<RpcCommandResult>('delete_entity', [id, envelope.actorId ?? null,
        envelope.clientMutationId ?? null]);
      return commandResult(q, raw, owner.identityId);
    });
  };

  readonly restoreEntity = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const rows = await q.query<{ kind: string }>(`select kind from public.entities where id = $1`, [id]);
      if (!rows[0]) throw new CollabError('not_found', `no such entity: ${id}`);
      assertGenericLifecycle(rows[0].kind, 'entities.restore');
      const raw = await q.rpc<RpcCommandResult>('restore_entity', [id, envelope.actorId ?? null,
        envelope.clientMutationId ?? null]);
      return commandResult(q, raw, owner.identityId);
    });
  };

  readonly listChildren = async (ctx: RequestContext): Promise<Page<EntitySummary>> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const limit = limitOf(ctx.query.get('limit'));
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) => {
      const parent = await liveRow(q, id);
      if (HIERARCHY_DISABLED_KINDS.has(parent.kind)) {
        throw new CollabError('forbidden', `children are disabled for ${parent.kind}`);
      }
      const fp = childCursorFingerprint(id);
      const params: unknown[] = [id];
      let keyset = '';
      const cursor = ctx.query.get('cursor');
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k.length !== 3 || decoded.k[0] !== fp) {
          throw new CollabError('invalid_cursor', 'child cursor does not match this parent');
        }
        const position = Number(decoded.k[1]);
        if (!Number.isFinite(position)) throw new CollabError('invalid_cursor', 'child cursor position is invalid');
        params.push(position, cursorUuid(decoded.k[2]));
        keyset = 'and (e.position, e.id) > ($2::double precision, $3::uuid)';
      }
      const rows = await q.query<EntityRow>(
        `select ${ENTITY_COLUMNS} ${ENTITY_FROM}
          where e.parent_id = $1 and e.deleted_at is null ${keyset}
          order by e.position, e.id limit ${limit + 1}`,
        params,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows.at(-1);
      return {
        items: await loadUniversalSummaries(q, pageRows, owner.identityId),
        nextCursor: hasMore && last ? childCursor(id, { position: Number(last.position), id: last.id }) : null,
      };
    });
  };

  readonly getHierarchy = async (ctx: RequestContext): Promise<Hierarchy> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) =>
      hierarchyFor(q, await liveRow(q, id), owner.identityId));
  };

  readonly listConnections = async (ctx: RequestContext): Promise<Page<EdgeView>> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    return this.deps.db.tx(claimsFor(owner, ctx), (q) =>
      queryConnections(q, normalizedConnections(id, ctx.query), owner.identityId));
  };

  readonly listVersions = async (ctx: RequestContext): Promise<Page<Record<string, unknown>>> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const limit = limitOf(ctx.query.get('limit'));
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) => {
      const entity = await liveRow(q, id);
      const fp = fingerprint('entities.versions', { entityId: id, kind: entity.kind });
      const params: unknown[] = [id];
      let keyset = '';
      const cursor = ctx.query.get('cursor');
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k.length !== 2 || decoded.k[0] !== fp || !Number.isInteger(Number(decoded.k[1]))) {
          throw new CollabError('invalid_cursor', 'version cursor does not match this entity');
        }
        params.push(Number(decoded.k[1]));
        keyset = 'and version < $2';
      }
      const rows = entity.kind === 'interaction_profile'
        ? await q.query<VersionRow>(
          `select v.profile_id entity_id, v.version,
                  jsonb_build_object('draft', v.draft_json, 'validationStatus', v.validation_status,
                    'validatedHash', v.validated_hash, 'validation', v.validation_json) snapshot,
                  e.created_by changed_by, v.created_at changed_at
             from public.interaction_profile_versions v
             join public.entities e on e.id = v.profile_id
            where v.profile_id = $1 ${keyset}
            order by v.version desc limit ${limit + 1}`,
          params)
        : await q.query<VersionRow>(
          `select entity_id, version, snapshot, changed_by, changed_at
             from public.entity_versions where entity_id = $1 ${keyset}
            order by version desc limit ${limit + 1}`,
          params);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const actors = await loadActors(q, pageRows.map((row) => row.changed_by ?? ''));
      return {
        items: pageRows.map((row) => ({
          entityId: row.entity_id,
          version: row.version,
          snapshot: row.snapshot,
          changedBy: row.changed_by ? actorOf(actors, row.changed_by) : null,
          changedAt: iso(row.changed_at),
        })),
        nextCursor: hasMore ? encodeCursor([fp, pageRows.at(-1)!.version]) : null,
      };
    });
  };

  readonly listActivity = async (ctx: RequestContext): Promise<Page<ActivityItem>> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const limit = limitOf(ctx.query.get('limit'));
    return this.deps.db.tx(claimsFor(owner, ctx), async (q) => {
      await liveRow(q, id);
      const fp = fingerprint('entities.activity', { entityId: id });
      const params: unknown[] = [id];
      let keyset = '';
      const cursor = ctx.query.get('cursor');
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (decoded.k.length !== 3 || decoded.k[0] !== fp) {
          throw new CollabError('invalid_cursor', 'activity cursor does not match this entity');
        }
        params.push(cursorIso(decoded.k[1]), cursorUuid(decoded.k[2]));
        keyset = 'and (a.created_at, a.id) < ($2::timestamptz, $3::uuid)';
      }
      const rows = await q.query<ActivityRow>(
        `select a.id, a.entity_id, a.actor_id, a.verb, a.summary, a.ref_id,
                a.work_session_id, a.created_at,
                ${MICROS('a.created_at')} cursor_created_at
           from public.activity a where a.entity_id = $1 ${keyset}
          order by a.created_at desc, a.id desc limit ${limit + 1}`,
        params,
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const actors = await loadActors(q, pageRows.map((row) => row.actor_id ?? ''));
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => ({
          id: row.id,
          entityId: row.entity_id,
          actor: row.actor_id ? actorOf(actors, row.actor_id) : null,
          verb: row.verb,
          summary: row.summary ?? {},
          createdAt: iso(row.created_at),
          refId: row.ref_id,
          workSessionId: row.work_session_id,
        })),
        nextCursor: hasMore && last
          ? encodeCursor([fp, last.cursor_created_at, last.id])
          : null,
      };
    });
  };

  readonly react = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as ReactionInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('react', [id, input.reaction, input.enabled,
        envelope.actorId ?? null, envelope.clientMutationId ?? null]);
      return commandResult(q, raw, owner.identityId);
    });
  };

  readonly pull = async (ctx: RequestContext): Promise<CommandResult> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as PullInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
      const raw = await q.rpc<RpcCommandResult>('set_pull_state', [id, input.pinnedVersion,
        input.localId ?? null, envelope.actorId ?? null, envelope.clientMutationId ?? null,
        // SIXTH positional = p_clear_local_id (order: p_entity_id, p_pinned_version,
        // p_local_id, p_actor_id, p_client_mutation_id, p_clear_local_id).
        // `localId` is THREE-STATE (schemas.ts:968 `.nullable().optional()`), and the
        // `?? null` above deliberately sends NULL for BOTH absent and explicit-null --
        // the RPC reads NULL as "leave alone", so THIS flag is the only thing that
        // distinguishes them. STRICT equality is load-bearing: `==` also matches
        // undefined, which would clear a stored localId on an ordinary re-pin -- the
        // silent destroy this repair exists to remove.
        input.localId === null]);
      return commandResult(q, raw, owner.identityId);
    });
  };

  readonly linkPr = async (ctx: RequestContext): Promise<CommandResult | ServerReceipt> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as LinkPrInput;
    const envelope = commandEnvelope(ctx);
    const parsed = parseProviderUrl(input.url, 'pull_request');
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const before = wantsReceipt(ctx) ? await receiptSnapshot(q, id) : undefined;
        const raw = await q.rpc<RpcCommandResult>('link_pull_request', [id, input.url,
          parsed.provider, parsed.repo, Number(parsed.identifier), input.projectId ?? null,
          envelope.actorId ?? null, envelope.clientMutationId ?? null]);
        const receipt = before ? await buildReceipt(q, 'task.link-pr', raw, { before }) : undefined;
        return receipt ?? commandResult(q, raw, owner.identityId);
      });
    } catch (error) {
      normalizeReason(error);
    }
  };

  readonly linkCommit = async (ctx: RequestContext): Promise<CommandResult | ServerReceipt> => {
    const owner = await this.deps.owner();
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as LinkCommitInput;
    const envelope = commandEnvelope(ctx);
    const parsed = parseProviderUrl(input.url, 'commit');
    try {
      return await this.deps.db.tx(claimsFor(owner, ctx, envelope), async (q) => {
        const before = wantsReceipt(ctx) ? await receiptSnapshot(q, id) : undefined;
        const raw = await q.rpc<RpcCommandResult>('link_commit', [id, input.url,
          parsed.provider, parsed.repo, parsed.identifier, input.projectId ?? null,
          envelope.actorId ?? null, envelope.clientMutationId ?? null]);
        const receipt = before ? await buildReceipt(q, 'task.link-commit', raw, { before }) : undefined;
        return receipt ?? commandResult(q, raw, owner.identityId);
      });
    } catch (error) {
      normalizeReason(error);
    }
  };

  readonly refreshTracking = async (ctx: RequestContext): Promise<Record<string, unknown>> => {
    const owner = await this.deps.owner();
    const input = ctx.body as TrackingRefreshInput;
    const envelope = commandEnvelope(ctx);
    return this.deps.db.tx(claimsFor(owner, ctx, envelope), (q) => q.rpc('queue_tracking_refresh', [
      input.entityIds ?? [], envelope.actorId ?? null, envelope.clientMutationId ?? null,
    ]));
  };
}

export { buildUniversalDetail, loadUniversalSummaries, queryConnections };
