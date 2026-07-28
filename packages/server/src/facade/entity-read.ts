/**
 * Derived truth, assembled ONCE, server-side (L3).
 *
 * The contract's rule is that the client renders and never derives. Everything
 * a consumer would otherwise have to compute for itself lives here and is
 * computed the same way for every consumer — the browser, the CLI and an agent
 * all get byte-identical `EntitySummary`s:
 *
 *   - `title` is the kind-specific display title, never an id, and never the
 *     caller's job to work out from `content`;
 *   - `excerpt` is derived from whichever field is the body for that kind;
 *   - a tombstoned entity renders as a tombstone rather than leaking its old
 *     title through a soft delete;
 *   - `badges.blocked` comes from resolving hard `depends_on` edges through
 *     `internal.is_resolved`, so "blocked" means the same thing everywhere;
 *   - `counters.viewerReaction` is resolved from the CALLER's reaction edge —
 *     the one genuinely per-viewer field (DEV-10);
 *   - `capabilities` mirror what the RPCs will actually permit, so a disabled
 *     button and a 403 never disagree.
 *
 * SHAPE OF THE READS: one query for the entity rows, then a fixed set of batch
 * queries for the relations (actors, children, assignees, dependencies, pulls,
 * live work). Fixed, not per-row: an N+1 here would be paid on every list in
 * the product.
 *
 * All of it is plain SELECT through RLS. Nothing in this file writes.
 */
import type {
  AcceptanceCriterion,
  ActorSummary,
  EntityBadges,
  EntityCapabilities,
  EntityContent,
  EntityCounters,
  EntityKind,
  EntityState,
  EntitySummary,
  LiveWork,
  PullState,
  Visibility,
  WorkStatus,
} from '@tm8/contract';
import type { Querier } from '../db/types.js';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * The flat row every entity read produces. One column list, one join chain,
 * used by `entities.get`, `entities.children` and `collections.query` alike —
 * so a task looks the same however it was fetched.
 */
export const ENTITY_COLUMNS = `
  e.id, e.space_id, e.kind, e.parent_id, e.position, e.visibility, e.version,
  e.activity_at, e.created_at, e.updated_at, e.deleted_at, e.created_by,
  coalesce(ec.likes, 0)    as likes,
  coalesce(ec.dislikes, 0) as dislikes,
  coalesce(ec.stars, 0)    as stars,
  coalesce(ec.points, 0)   as points,
  coalesce(ec.messages, 0) as messages,
  t.title as task_title, t.description as task_description, t.axes as task_axes,
  t.work_status, t.priority, t.acceptance_criteria, t.points_estimate, t.due_date,
  d.title as doc_title, d.body as doc_body, d.format as doc_format,
  ch.name as channel_name, ch.topic as channel_topic,
  mem.display_name as member_display_name, mem.role as member_role,
  tm.name as team_member_name, tm.model as team_member_model,
  tm.agent_tool as team_member_agent_tool, tm.owner_member_id as team_member_owner_id,
  tm.identity as team_member_identity, tm.avatar as team_member_avatar,
  tm.capabilities as team_member_capabilities,
  tm.command_permissions as team_member_command_permissions,
  tm.memories as team_member_memories,
  col.name as collection_name, col.description as collection_description,
  col.collection_type,
  ws.title as ws_title, ws.status as ws_status, ws.agent_tool as ws_agent_tool,
  ws.model as ws_model, ws.share_mode as ws_share_mode, ws.started_at as ws_started_at,
  ws.exited_at as ws_exited_at, ws.node_id as ws_node_id, ws.project_id as ws_project_id,
  ws.transcript_doc_id as ws_transcript_doc_id,
  msg.anchor_id, msg.root_message_id, msg.author_id, msg.body as message_body,
  msg.message_batch_id,
  msg.mentions as message_mentions, msg.attachments as message_attachments,
  msg.edited_at as message_edited_at, msg.redacted_at as message_redacted_at,
  f.name as file_name, f.mime_type as file_mime, f.size_bytes as file_size
`;

/**
 * LEFT JOIN every detail table rather than dispatching on kind in the caller.
 * The envelope+detail split (001 §9) means a uniform read has to reassemble
 * them somewhere, and doing it once here beats a per-kind query path that can
 * drift kind by kind.
 */
export const ENTITY_FROM = `
  from public.entities e
  left join public.entity_counters ec on ec.entity_id = e.id
  left join public.tasks t            on t.entity_id  = e.id
  left join public.documents d        on d.entity_id  = e.id
  left join public.channels ch        on ch.entity_id = e.id
  left join public.members mem        on mem.entity_id = e.id
  left join public.team_members tm    on tm.entity_id = e.id
  left join public.collections col    on col.entity_id = e.id
  left join public.work_sessions ws   on ws.entity_id = e.id
  left join public.messages msg       on msg.entity_id = e.id
  left join public.files f            on f.entity_id  = e.id
`;

export interface EntityRow {
  id: string;
  space_id: string;
  kind: string;
  parent_id: string | null;
  position: number;
  visibility: string;
  version: number;
  activity_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  created_by: string;
  likes: number;
  dislikes: number;
  stars: number;
  points: number;
  messages: number;
  task_title: string | null;
  task_description: string | null;
  task_axes: Record<string, string> | null;
  work_status: string | null;
  priority: string | null;
  acceptance_criteria: AcceptanceCriterion[] | null;
  points_estimate: number | null;
  due_date: Date | string | null;
  doc_title: string | null;
  doc_body: string | null;
  doc_format: string | null;
  channel_name: string | null;
  channel_topic: string | null;
  member_display_name: string | null;
  member_role: string | null;
  team_member_name: string | null;
  team_member_model: string | null;
  team_member_agent_tool: string | null;
  team_member_owner_id: string | null;
  team_member_identity: string | null;
  team_member_avatar: string | null;
  team_member_capabilities: Record<string, unknown> | null;
  team_member_command_permissions: Record<string, unknown> | null;
  team_member_memories: unknown[] | null;
  collection_name: string | null;
  collection_description: string | null;
  collection_type: string | null;
  ws_title: string | null;
  ws_status: string | null;
  ws_agent_tool: string | null;
  ws_model: string | null;
  ws_share_mode: string | null;
  ws_started_at: Date | string | null;
  ws_exited_at: Date | string | null;
  ws_node_id: string | null;
  ws_project_id: string | null;
  ws_transcript_doc_id: string | null;
  anchor_id: string | null;
  root_message_id: string | null;
  author_id: string | null;
  message_batch_id: string | null;
  message_body: string | null;
  message_mentions: unknown[] | null;
  message_attachments: unknown[] | null;
  message_edited_at: Date | string | null;
  message_redacted_at: Date | string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: string | number | null;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * Render a `timestamptz` as microsecond-exact, UTC-normalised text, in SQL.
 *
 * USE THIS FOR EVERY KEYSET CURSOR VALUE. Never `iso()` — see its warning
 * below — and never a bare `::text`, which renders in the SESSION's timezone
 * and strips trailing zeros, so the same instant spells differently depending
 * on server config and carries a variable number of fractional digits.
 *
 * One definition rather than a format string copied to each call site: `US` is
 * the 6-digit microsecond field, and a single wrong letter there (`MS`, or a
 * dropped `U`) silently reduces precision with no error anywhere. That is the
 * failure this helper exists to make unrepeatable.
 */
export const MICROS = (expr: string): string =>
  `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * ISO text for a DISPLAY field.
 *
 * NOT FOR CURSORS. This truncates on BOTH branches — a `Date` holds only
 * milliseconds, and the string branch re-parses through `new Date(...)`, so a
 * value that arrived from SQL already correct is destroyed just the same.
 * Postgres stores MICROSECONDS, so a cursor built through here lands strictly
 * BEFORE the row it came from: on an ASC keyset that re-admits the row and
 * loops, and on a DESC keyset it SILENTLY SKIPS every row sharing the lost
 * millisecond. Use `MICROS` in the query instead.
 */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** `date` columns must not acquire a timezone on the way out. */
function dateOnly(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const s = value instanceof Date ? value.toISOString() : String(value);
  return s.slice(0, 10);
}

/**
 * Normalise a timestamp that came out of a jsonb `props` blob.
 *
 * Timestamps stored INSIDE jsonb (edge props: `pulledAt`, `startedAt`) are
 * serialised by Postgres in its own text format, which carries the server's UTC
 * OFFSET — `2026-07-25T14:59:01.89182+05:30`. The contract's `IsoTimestamp` is
 * `/…Z$/` (schemas.ts:44), so that string is contract-INVALID and would fail
 * validation in any consumer that checks. Columns are fine — the driver hands
 * those back as `Date` — so this applies only to values dug out of jsonb.
 */
function isoFromProps(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

const EXCERPT_MAX = 200;

function excerpt(body: string | null): string | undefined {
  if (!body) return undefined;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * The tombstone rule (02 §3.2): a soft-deleted entity keeps its place in the
 * graph so threads and hierarchies do not develop holes, but it must not keep
 * rendering its content. One place decides that, for every kind.
 */
const TOMBSTONE_TITLE = 'Deleted';

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

interface ActorRow {
  id: string;
  kind: string;
  space_id: string;
  member_display_name: string | null;
  member_role: string | null;
  team_member_name: string | null;
  team_member_avatar: string | null;
  team_member_owner_id: string | null;
  profile_display_name: string | null;
  profile_avatar: string | null;
}

/**
 * Batch-resolve actor entities to `ActorSummary`.
 *
 * `isAgent` is `kind === 'team_member'` and nothing else — it is the flag the
 * UI uses to tell a human from a persona, so it must not be inferred from a
 * name or a model field that happens to be set.
 */
export async function loadActors(
  q: Querier,
  ids: readonly string[],
): Promise<Map<string, ActorSummary>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, ActorSummary>();
  if (unique.length === 0) return out;

  const rows = await q.query<ActorRow>(
    `select e.id, e.kind, e.space_id,
            mem.display_name as member_display_name, mem.role as member_role,
            tm.name as team_member_name, tm.avatar as team_member_avatar,
            tm.owner_member_id as team_member_owner_id,
            up.display_name as profile_display_name, up.avatar as profile_avatar
       from public.entities e
       left join public.members mem on mem.entity_id = e.id
       left join public.team_members tm on tm.entity_id = e.id
       left join public.user_profiles up on up.identity_id = mem.identity_id
      where e.id = any($1::uuid[])`,
    [unique],
  );

  for (const row of rows) {
    const isAgent = row.kind === 'team_member';
    out.set(row.id, {
      id: row.id,
      kind: isAgent ? 'team_member' : 'member',
      displayName: isAgent
        ? (row.team_member_name ?? 'Agent')
        : (row.member_display_name ?? row.profile_display_name ?? 'Member'),
      avatar: isAgent ? row.team_member_avatar : row.profile_avatar,
      role: isAgent ? null : row.member_role,
      ...(isAgent && row.team_member_owner_id ? { ownerMemberId: row.team_member_owner_id } : {}),
      isAgent,
    });
  }
  return out;
}

/**
 * An actor row RLS hid, or one that was hard-deleted out from under a
 * reference. Rendering a placeholder keeps a list usable; returning null would
 * push a null-check into every consumer for a case that is rare and not their
 * problem.
 */
function unknownActor(id: string): ActorSummary {
  return { id, kind: 'member', displayName: 'Unknown', avatar: null, role: null, isAgent: false };
}

export function actorOf(actors: Map<string, ActorSummary>, id: string | null): ActorSummary {
  if (!id) return unknownActor('');
  return actors.get(id) ?? unknownActor(id);
}

// ---------------------------------------------------------------------------
// Relations, batched
// ---------------------------------------------------------------------------

export interface EntityRelations {
  /** `assigned_to` targets, per task. */
  assignees: Map<string, string[]>;
  /** Live child count, per entity. */
  childCounts: Map<string, number>;
  /** Unresolved HARD `depends_on` targets, per entity — the blocked badge. */
  blockedBy: Map<string, string[]>;
  /** `pulled` edges pointing AT the entity. */
  pulls: Map<string, Array<{ actorId: string; props: Record<string, unknown>; at: string }>>;
  /** `working_on` edges pointing AT the entity. */
  workingOn: Map<string, Array<{ actorId: string; props: Record<string, unknown>; at: string }>>;
  /** `contains` count, per collection. */
  itemCounts: Map<string, number>;
}

const EMPTY_RELATIONS: EntityRelations = {
  assignees: new Map(),
  childCounts: new Map(),
  blockedBy: new Map(),
  pulls: new Map(),
  workingOn: new Map(),
  itemCounts: new Map(),
};

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Every relation the summary/badge assembly needs, in a fixed number of
 * queries regardless of how many entities were asked for.
 */
export async function loadRelations(q: Querier, ids: readonly string[]): Promise<EntityRelations> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return EMPTY_RELATIONS;

  const relations: EntityRelations = {
    assignees: new Map(),
    childCounts: new Map(),
    blockedBy: new Map(),
    pulls: new Map(),
    workingOn: new Map(),
    itemCounts: new Map(),
  };

  const edgeRows = await q.query<{
    src_id: string;
    dst_id: string;
    type: string;
    props: Record<string, unknown>;
    created_at: Date | string;
  }>(
    `select src_id, dst_id, type, props, created_at
       from public.edges
      where (src_id = any($1::uuid[]) and type in ('assigned_to', 'depends_on', 'contains'))
         or (dst_id = any($1::uuid[]) and type in ('pulled', 'working_on'))`,
    [unique],
  );

  const wanted = new Set(unique);
  const dependsOn: Array<{ src: string; dst: string; hard: boolean }> = [];

  for (const edge of edgeRows) {
    switch (edge.type) {
      case 'assigned_to':
        if (wanted.has(edge.src_id)) push(relations.assignees, edge.src_id, edge.dst_id);
        break;
      case 'contains':
        if (wanted.has(edge.src_id)) {
          relations.itemCounts.set(edge.src_id, (relations.itemCounts.get(edge.src_id) ?? 0) + 1);
        }
        break;
      case 'depends_on':
        if (wanted.has(edge.src_id)) {
          // `props.hard` defaults to TRUE, matching `ready_to_work` (007:2350).
          // A dependency with no explicit flag is a hard one.
          dependsOn.push({
            src: edge.src_id,
            dst: edge.dst_id,
            hard: edge.props?.hard === undefined ? true : edge.props.hard === true,
          });
        }
        break;
      case 'pulled':
        if (wanted.has(edge.dst_id)) {
          push(relations.pulls, edge.dst_id, {
            actorId: edge.src_id,
            props: edge.props ?? {},
            at: iso(edge.created_at),
          });
        }
        break;
      case 'working_on':
        if (wanted.has(edge.dst_id)) {
          push(relations.workingOn, edge.dst_id, {
            actorId: edge.src_id,
            props: edge.props ?? {},
            at: iso(edge.created_at),
          });
        }
        break;
      default:
        break;
    }
  }

  // Resolution is a per-kind rule (a task is resolved when done, a PR when
  // merged), so it is asked of the database rather than reimplemented here
  // where the two definitions could drift.
  const hardTargets = [...new Set(dependsOn.filter((d) => d.hard).map((d) => d.dst))];
  if (hardTargets.length > 0) {
    const resolved = await q.query<{ id: string; resolved: boolean }>(
      `select id, internal.is_resolved(id) as resolved from public.entities where id = any($1::uuid[])`,
      [hardTargets],
    );
    const resolvedById = new Map(resolved.map((r) => [r.id, r.resolved]));
    for (const dep of dependsOn) {
      if (!dep.hard) continue;
      if (resolvedById.get(dep.dst) === true) continue;
      push(relations.blockedBy, dep.src, dep.dst);
    }
  }

  const childRows = await q.query<{ parent_id: string; count: string }>(
    `select parent_id, count(*)::text as count
       from public.entities
      where parent_id = any($1::uuid[]) and deleted_at is null
      group by parent_id`,
    [unique],
  );
  for (const row of childRows) relations.childCounts.set(row.parent_id, Number(row.count));

  return relations;
}

/**
 * The caller's own reaction, per entity (DEV-10).
 *
 * Scoped by IDENTITY rather than by a member id, so one query answers for
 * entities spanning several spaces — the caller has a different member row in
 * each, and the reaction edge is authored by whichever one applies.
 */
export async function loadViewerReactions(
  q: Querier,
  ids: readonly string[],
  viewerIdentityId: string,
): Promise<Map<string, EntityCounters['viewerReaction']>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, EntityCounters['viewerReaction']>();
  if (unique.length === 0 || !viewerIdentityId) return out;

  const rows = await q.query<{ dst_id: string; type: string }>(
    `select r.dst_id, r.type
       from public.edges r
       join public.members m on m.entity_id = r.src_id
      where r.dst_id = any($1::uuid[])
        and r.type in ('likes', 'dislikes', 'stars')
        and m.identity_id = $2`,
    [unique, viewerIdentityId],
  );

  // The edge types are plural (`likes`); the DTO field is singular (`like`).
  const singular: Record<string, EntityCounters['viewerReaction']> = {
    likes: 'like',
    dislikes: 'dislike',
    stars: 'star',
  };
  for (const row of rows) out.set(row.dst_id, singular[row.type] ?? null);
  return out;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The kind-specific display title. Never an id, never raw content (L3). */
export function titleOf(row: EntityRow): string {
  if (row.deleted_at) return TOMBSTONE_TITLE;
  switch (row.kind) {
    case 'task':
      return row.task_title ?? 'Untitled task';
    case 'doc':
      return row.doc_title ?? 'Untitled document';
    case 'channel':
      // The bare name, NOT '#name'. The '#' is a rendering affordance and
      // belongs to the client; conformance (reads.test.ts:32) asserts the
      // stored name comes back unadorned.
      return row.channel_name ?? 'channel';
    case 'member':
      return row.member_display_name ?? 'Member';
    case 'team_member':
      return row.team_member_name ?? 'Agent';
    case 'collection':
      return row.collection_name ?? 'Collection';
    case 'work_session':
      return row.ws_title && row.ws_title.length > 0 ? row.ws_title : 'Session';
    case 'file':
      return row.file_name ?? 'File';
    case 'message':
      return excerpt(row.message_body) ?? 'Message';
    default:
      return row.kind;
  }
}

function excerptOf(row: EntityRow): string | undefined {
  if (row.deleted_at) return undefined;
  switch (row.kind) {
    case 'task':
      return excerpt(row.task_description);
    case 'doc':
      return excerpt(row.doc_body);
    case 'message':
      return row.message_redacted_at ? undefined : excerpt(row.message_body);
    case 'channel':
      return excerpt(row.channel_topic);
    case 'collection':
      return excerpt(row.collection_description);
    default:
      return undefined;
  }
}

function acceptanceOf(row: EntityRow): { total: number; completed: number } {
  const criteria = Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [];
  return {
    total: criteria.length,
    completed: criteria.filter((c) => c?.done === true).length,
  };
}

export interface AssemblyContext {
  actors: Map<string, ActorSummary>;
  relations: EntityRelations;
  viewerReactions: Map<string, EntityCounters['viewerReaction']>;
  /** Summaries of related entities (dependency targets, working-on tasks). */
  related?: Map<string, EntitySummary>;
}

function stateOf(row: EntityRow, ctx: AssemblyContext): EntityState {
  switch (row.kind) {
    case 'task':
      return {
        kind: 'task',
        workStatus: (row.work_status ?? 'open') as WorkStatus,
        priority: (row.priority ?? 'medium') as 'low' | 'medium' | 'high' | 'urgent',
        axes: row.task_axes ?? {},
        dueDate: dateOnly(row.due_date),
        assignees: (ctx.relations.assignees.get(row.id) ?? []).map((id) => actorOf(ctx.actors, id)),
        acceptance: acceptanceOf(row),
      };
    case 'channel':
      return {
        kind: 'channel',
        topic: row.channel_topic ?? '',
        // Per-member unread counts are `unread_counts` (007:1986) and are not
        // on the G1A loop. Reported as 0 rather than omitted, because the field
        // is required and a wrong-but-typed 0 beats a crash in the renderer.
        unreadCount: 0,
        workingAgentCount: (ctx.relations.workingOn.get(row.id) ?? []).length,
      };
    case 'doc':
      return {
        kind: 'doc',
        format: (row.doc_format ?? 'markdown') as 'markdown' | 'mermaid' | 'excalidraw',
        childCount: ctx.relations.childCounts.get(row.id) ?? 0,
      };
    case 'message':
      return {
        kind: 'message',
        anchorId: row.anchor_id ?? '',
        rootMessageId: row.root_message_id,
        author: actorOf(ctx.actors, row.author_id),
        messageBatchId: row.message_batch_id,
        editedAt: isoOrNull(row.message_edited_at),
      };
    case 'member':
      return {
        kind: 'member',
        role: (row.member_role ?? 'member') as 'owner' | 'admin' | 'member',
        score: row.points,
        taskDoneCount: 0,
      };
    case 'team_member':
      return {
        kind: 'team_member',
        owner: actorOf(ctx.actors, row.team_member_owner_id),
        model: row.team_member_model,
        agentTool: row.team_member_agent_tool,
        liveWork: null,
      };
    case 'work_session':
      return {
        kind: 'work_session',
        status: (row.ws_status ?? 'spawning') as 'spawning' | 'running' | 'idle' | 'exited' | 'failed',
        agentTool: row.ws_agent_tool,
        model: row.ws_model,
        shareMode: (row.ws_share_mode ?? 'none') as 'none' | 'space' | 'explicit',
        startedAt: isoOrNull(row.ws_started_at),
        exitedAt: isoOrNull(row.ws_exited_at),
      };
    case 'collection':
      return {
        kind: 'collection',
        collectionType: row.collection_type ?? 'manual',
        itemCount: ctx.relations.itemCounts.get(row.id) ?? 0,
      };
    case 'file':
      return {
        kind: 'file',
        name: row.file_name ?? '',
        mimeType: row.file_mime ?? 'application/octet-stream',
        sizeBytes: Number(row.file_size ?? 0),
      };
    default:
      // A custom `c:*` kind. Its scalar fields live in `custom_entities` and
      // are out of the G1A slice, so the shape is honest and empty rather than
      // invented.
      return { kind: row.kind as `c:${string}`, fields: {} };
  }
}

function badgesOf(row: EntityRow, ctx: AssemblyContext): EntityBadges {
  const badges: EntityBadges = {};

  const blockedBy = ctx.relations.blockedBy.get(row.id) ?? [];
  if (blockedBy.length > 0) {
    badges.blocked = {
      unresolvedHardDependencyCount: blockedBy.length,
      waitingOn: blockedBy
        .map((id) => ctx.related?.get(id))
        .filter((s): s is EntitySummary => s !== undefined),
    };
  }

  const pulls = ctx.relations.pulls.get(row.id) ?? [];
  if (pulls.length > 0) {
    badges.pulls = pulls.map((pull): PullState => {
      const pinnedVersion = Number(pull.props.pinnedVersion ?? 0);
      const pulledAt = isoFromProps(pull.props.pulledAt, pull.at);
      return {
        actor: actorOf(ctx.actors, pull.actorId),
        localId: (pull.props.localId as string | null | undefined) ?? null,
        pinnedVersion,
        // Staleness is DERIVED, never stored: the edge pins a version, the
        // entity moves on, and the difference is the answer.
        contentStale: pinnedVersion > 0 && pinnedVersion < row.version,
        // The discussion moved on if the entity saw activity after the pull.
        discussionMoved: Date.parse(iso(row.activity_at)) > Date.parse(pulledAt),
        workStatus: (pull.props.workStatus as string | null | undefined) ?? null,
        pulledAt,
      };
    });
  }

  const working = ctx.relations.workingOn.get(row.id) ?? [];
  if (working.length > 0 && ctx.related) {
    const self = ctx.related.get(row.id);
    if (self) {
      badges.workingActors = working.map(
        (w): LiveWork => ({
          actor: actorOf(ctx.actors, w.actorId),
          task: self,
          startedAt: isoFromProps(w.props.startedAt, w.at),
          note: (w.props.note as string | null | undefined) ?? null,
        }),
      );
    }
  }

  if (row.visibility === 'restricted') badges.restricted = true;

  return badges;
}

/**
 * What the caller may do, computed from the same rules the RPCs enforce.
 *
 * These mirror real refusals rather than expressing a UI preference: v1 is
 * loopback single-owner, so "is the caller allowed" is settled — what is left
 * is what the KIND and the STATE permit.
 *
 * `canComplete` is an AFFORDANCE, not a pre-flight check. It answers "is
 * completing this a thing you can do here", not "would completing it succeed
 * this instant". Conformance settles it: `reads.test.ts:45` expects
 * `canComplete === true` on a task with two UNFINISHED acceptance criteria
 * (:49 asserts `acceptance.total === 2`). I originally folded
 * `complete_task`'s criteria gate (007:1835) in here, reasoning that the
 * button and the 409 should agree — but that conflates two questions. The
 * gate is a runtime invariant the RPC enforces; the client already has
 * `state.acceptance` to render progress and decide what to grey out. Encoding
 * the gate here would also make the capability lie the moment another actor
 * ticks a criterion.
 */
export function capabilitiesOf(row: EntityRow): EntityCapabilities {
  const live = row.deleted_at === null;
  const editable = new Set(['task', 'doc', 'channel', 'collection', 'team_member', 'spell', 'skill']);
  const hierarchical = new Set(['task', 'doc', 'channel', 'collection']);
  const pullable = new Set(['channel', 'task', 'doc', 'file', 'spell', 'skill', 'collection']);

  return {
    canEdit: live && editable.has(row.kind),
    // 007:1437 refuses to delete a member entity — leaving the space is the
    // only way that row goes away.
    canDelete: live && row.kind !== 'member',
    canAddChild: live && hierarchical.has(row.kind),
    canLink: live,
    canPull: live && pullable.has(row.kind),
    canReact: live,
    canGrantPoints: live && (row.kind === 'member' || row.kind === 'team_member'),
    // Not gated on acceptance criteria — see the note above.
    canComplete: live && row.kind === 'task' && row.work_status !== 'done',
  };
}

export function toEntitySummary(row: EntityRow, ctx: AssemblyContext): EntitySummary {
  const summary: EntitySummary = {
    id: row.id,
    spaceId: row.space_id,
    kind: row.kind as EntityKind,
    title: titleOf(row),
    parentId: row.parent_id,
    position: Number(row.position),
    visibility: row.visibility as Visibility,
    version: row.version,
    activityAt: iso(row.activity_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: isoOrNull(row.deleted_at),
    createdBy: actorOf(ctx.actors, row.created_by),
    counters: {
      likes: row.likes,
      dislikes: row.dislikes,
      stars: row.stars,
      points: row.points,
      messages: row.messages,
      viewerReaction: ctx.viewerReactions.get(row.id) ?? null,
    },
    state: stateOf(row, ctx),
    badges: badgesOf(row, ctx),
  };
  const ex = excerptOf(row);
  return ex === undefined ? summary : { ...summary, excerpt: ex };
}

/** The typed `content` block of an `EntityDetail`. */
export function contentOf(row: EntityRow): EntityContent {
  if (row.deleted_at) {
    // A tombstone has no content to show. The kind is preserved so the client
    // still knows what it is looking at the grave of.
    switch (row.kind) {
      case 'task':
        return { kind: 'task', description: '', acceptanceCriteria: [], pointsEstimate: null };
      case 'doc':
        return { kind: 'doc', body: '', format: 'markdown' };
      default:
        break;
    }
  }
  switch (row.kind) {
    case 'task':
      return {
        kind: 'task',
        description: row.task_description ?? '',
        acceptanceCriteria: Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [],
        pointsEstimate: row.points_estimate,
      };
    case 'doc':
      return {
        kind: 'doc',
        body: row.doc_body ?? '',
        format: (row.doc_format ?? 'markdown') as 'markdown' | 'mermaid' | 'excalidraw',
      };
    case 'channel':
      return {
        kind: 'channel',
        topic: row.channel_topic ?? '',
        pinned: [],
        // Channel autoTabs are assembled from `attached_to` and are outside the
        // G1A slice; an empty list is honest, an invented one is not.
        autoTabs: [],
      };
    case 'message':
      return {
        kind: 'message',
        body: row.message_redacted_at ? '' : (row.message_body ?? ''),
        mentions: (Array.isArray(row.message_mentions) ? row.message_mentions : []) as never,
        attachments: (Array.isArray(row.message_attachments) ? row.message_attachments : []) as never,
      };
    case 'member':
      return { kind: 'member', teamMembers: [], work: [] };
    case 'team_member':
      return {
        kind: 'team_member',
        identity: row.team_member_identity ?? '',
        memories: Array.isArray(row.team_member_memories) ? row.team_member_memories : [],
        capabilities: row.team_member_capabilities ?? {},
        commandPermissions: row.team_member_command_permissions ?? {},
        equipped: [],
        work: [],
      };
    case 'work_session':
      return {
        kind: 'work_session',
        nodeId: row.ws_node_id,
        launchProjectId: row.ws_project_id,
        workingOn: [],
        transcriptDoc: null,
      };
    case 'collection':
      return { kind: 'collection', description: row.collection_description ?? '', items: [] };
    default:
      return { kind: row.kind as `c:${string}`, fields: {} };
  }
}

/**
 * Assemble summaries for a set of rows: batch the relations, batch the actors,
 * then map. Two passes over the rows, because `badges.blocked.waitingOn` and
 * `badges.workingActors.task` are themselves `EntitySummary`s — the first pass
 * builds the plain summaries the second pass hands to the badges.
 */
export async function assembleSummaries(
  q: Querier,
  rows: readonly EntityRow[],
  viewerIdentityId: string,
): Promise<EntitySummary[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // Sequential, NOT Promise.all: a `Querier` wraps ONE pooled client, and a pg
  // client cannot run two queries at once. Concurrent calls are silently
  // queued today and are deprecated as of pg 8.22 — so parallelism here buys
  // nothing and breaks at pg 9.
  const relations = await loadRelations(q, ids);
  const viewerReactions = await loadViewerReactions(q, ids, viewerIdentityId);

  // Dependency targets are referenced by the blocked badge and are usually NOT
  // in the page being rendered, so they are fetched explicitly.
  const dependencyIds = [...new Set([...relations.blockedBy.values()].flat())].filter(
    (id) => !ids.includes(id),
  );
  const dependencyRows =
    dependencyIds.length === 0
      ? []
      : await q.query<EntityRow>(
          `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
          [dependencyIds],
        );

  const allRows = [...rows, ...dependencyRows];
  const actorIds = allRows.flatMap((r) => [
    r.created_by,
    r.author_id ?? '',
    r.team_member_owner_id ?? '',
  ]);
  for (const list of relations.assignees.values()) actorIds.push(...list);
  for (const list of relations.pulls.values()) actorIds.push(...list.map((p) => p.actorId));
  for (const list of relations.workingOn.values()) actorIds.push(...list.map((w) => w.actorId));

  const actors = await loadActors(q, actorIds);

  // Pass 1: plain summaries (badges empty of cross-references).
  const bare: AssemblyContext = {
    actors,
    relations: EMPTY_RELATIONS,
    viewerReactions,
  };
  const related = new Map<string, EntitySummary>(
    allRows.map((r) => [r.id, toEntitySummary(r, bare)]),
  );

  // Pass 2: the real thing, with relations and the summaries the badges need.
  const ctx: AssemblyContext = { actors, relations, viewerReactions, related };
  return rows.map((r) => toEntitySummary(r, ctx));
}

/**
 * Assemble summaries for a set of ids — the projector entry point.
 *
 * A plain function, deliberately free of any handler, registry or HTTP
 * coupling, so the event stream and the REST reads share ONE assembler. Two
 * implementations would let a `WorkspaceEvent`'s entity and the same entity
 * fetched over `entities.get` disagree — for some kinds and not others, which
 * is the kind of divergence that ships.
 *
 * Order follows `ids`; entities RLS hides (or that do not exist) are simply
 * absent rather than rendered as a placeholder — a caller asking for a
 * specific set needs to be able to tell which ones it actually got.
 */
export async function loadEntitySummariesByIds(
  q: Querier,
  ids: readonly string[],
  viewerIdentityId: string,
): Promise<EntitySummary[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];

  const rows = await q.query<EntityRow>(
    `select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = any($1::uuid[])`,
    [unique],
  );
  const summaries = await assembleSummaries(q, rows, viewerIdentityId);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  return unique.map((id) => byId.get(id)).filter((s): s is EntitySummary => s !== undefined);
}
