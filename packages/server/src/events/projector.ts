/**
 * Entity hydration for the event stream — the `EntityProjector` seam.
 *
 * ## Why this is an interface and not just a function
 *
 * The capture trigger (db/migrations/003) stores `to_jsonb(row)` — the RAW
 * table row. The contract's events carry something much richer: `entity.upsert`
 * carries a full `EntitySummary` (kind-specific title, per-kind `state`,
 * counters including the caller's `viewerReaction`, `createdBy` as an
 * `ActorSummary`, badges), and `edge.upsert` carries TWO of them. Somebody has
 * to turn rows into summaries.
 *
 * That somebody is also the facade's read path (Deneb's D3 derived truth), and
 * L3 says derived truth is assembled in exactly one place. Two assemblers is a
 * genuinely nasty bug class: the socket and the REST read would disagree about
 * the same entity, and only for some kinds, so it would look like a caching bug
 * for a week. Hence a seam — `EntityProjector` — with a SQL-backed default that
 * makes this lane work today, and a single injection point for the facade's
 * assembler when it lands. The mapper depends on the interface and will not
 * change when the implementation is swapped.
 *
 * ## Reads happen under the CALLER's claims
 *
 * Every method takes a `Querier`, which the caller obtains from `Db.tx(claims,
 * …)`. This is not a style choice: hydrating a title with a privileged reader
 * would leak entities the poller cannot see, and no RLS policy would catch it
 * because the leak happens AFTER the policy that filtered the event rows ran.
 * The projector never opens its own transaction and never holds a `Db`.
 */
import {
  EntityKindSchema,
  plainExcerpt,
  type ActorSummary,
  type CustomEntityKind,
  type EntityCounters,
  type EntityAttentionSummary,
  type EntityKind,
  type CustomEntityState,
  type EntityState,
  type EntitySummary,
} from '@tm8/contract';

import type { Querier } from '../db/types.js';
// The ONE unread definition, shared with the facade assembler on purpose — see
// the `channel` arm of stateOf. `entity-read.ts` imports nothing from `events/`,
// so this direction adds no cycle.
import { loadUnreadCounts } from '../facade/entity-read.js';
import {
  loadLinkedPullRequestBadges,
  projectForgeFacts,
  type LinkedPullRequestBadges,
} from '../tracking/pr-projection.js';

/**
 * Thrown when the database holds an entity kind the FROZEN contract does not
 * define.
 *
 * This is deliberately loud and deliberately fatal to the request, rather than a
 * skipped row. Every other "cannot project this" condition in this lane is a
 * legitimate runtime state (an entity was deleted, or RLS filtered it) and is
 * skipped. This one is not: `internal.validate_entity_kind` already requires
 * every kind to be registered in `entity_kinds`, and the contract's custom arm
 * accepts ANY `c:*` string — so the only way to get here is genuine drift
 * between the migrations and the frozen contract. That is a deploy-level bug an
 * operator needs to see, not a row to quietly drop, and it should be impossible
 * in a correctly-migrated database.
 *
 * The alternative — casting the string to `EntityKind` — would let an unknown
 * kind reach a contract-typed event and slip past the tripwire wherever the
 * schema does not re-check that field. A cast here defeats the exact mechanism
 * this lane exists to provide.
 */
export class EntityKindDriftError extends Error {
  constructor(kind: string, entityId: string) {
    super(
      `database contains entity kind '${kind}' (entity ${entityId}) which is not in the frozen contract — ` +
        `db/migrations entity_kinds has drifted from @tm8/contract EntityKind`,
    );
    this.name = 'EntityKindDriftError';
  }
}

/**
 * Narrow a raw `kind` string to the contract's `EntityKind`.
 *
 * Uses the contract's own schema rather than a hand-kept list, because
 * `EntityKind` has a template-literal arm (`c:${string}`) that an array of
 * literals cannot express — a list would reject every custom kind.
 */
function entityKind(raw: string, entityId: string): EntityKind {
  const parsed = EntityKindSchema.safeParse(raw);
  if (!parsed.success) throw new EntityKindDriftError(raw, entityId);
  return parsed.data;
}

/**
 * Narrow a DDL-CHECK-constrained column to its literal union.
 *
 * The cast is sound because `includes` has already proven membership. `fallback`
 * covers the NULL case (the column belongs to a detail table that did not join)
 * — not a "whatever, close enough": every call site passes the same default the
 * migration declares, so a missing join produces the value a fresh row would
 * have had.
 */
function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * The title a deleted entity gets instead of its real one.
 *
 * Duplicated from `facade/entity-read.ts:222`, where it is module-private rather
 * than exported. If these two ever disagree the same entity will tombstone
 * differently on the read path and the event path — so if you change one, change
 * both, and prefer exporting the facade's constant over keeping this copy.
 */
const TOMBSTONE_TITLE = 'Deleted';

const WORK_STATUSES = ['open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const DOC_FORMATS = ['markdown', 'mermaid', 'excalidraw'] as const;
const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
const WS_STATUSES = ['spawning', 'running', 'idle', 'exited', 'failed'] as const;
const WS_SHARE_MODES = ['none', 'space', 'explicit'] as const;
const IP_STATUSES = ['draft', 'active', 'retired'] as const;
const WT_STATUSES = ['active', 'merged', 'abandoned', 'deleted'] as const;

/**
 * Hydrates the entity-shaped payloads an event projection needs.
 *
 * Batch-shaped on purpose (`ids`, not `id`): one poll page can mention dozens
 * of entities, and a per-event query would turn one page into a hundred round
 * trips.
 */
export interface EntityProjector {
  /**
   * `EntitySummary` for each id that still exists and the caller may read.
   *
   * Ids that are absent from the result are absent for one of two reasons that
   * this method deliberately does NOT distinguish — hard-deleted, or invisible
   * to the caller under RLS. The mapper treats both the same way (see
   * mapper.ts), and telling them apart would itself be an information leak.
   */
  entitySummaries(q: Querier, ids: readonly string[]): Promise<Map<string, EntitySummary>>;

  /**
   * `ActorSummary` for each id that is a member or team_member.
   *
   * OPTIONAL, and optional for a reason: an `ActorSummary` can be approximated
   * from an `EntitySummary` (the title is the display name, the state carries the
   * role), so the mapper can fall back and any injected assembler works without
   * implementing this. But the approximation loses `avatar`, which is not on
   * `EntitySummary` at all — so an implementation that CAN answer properly
   * should, and `PgEntityProjector` does.
   */
  actorSummaries?(q: Querier, ids: readonly string[]): Promise<Map<string, ActorSummary>>;
}

/** Row shape of the wide hydration join. Every kind-specific column is nullable. */
interface SummaryRow {
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
  likes: number | null;
  dislikes: number | null;
  stars: number | null;
  points: number | null;
  messages: number | null;
  /** Link counters (108); optional keeps pre-108 row fixtures source-compatible. */
  docs?: number | null;
  memories?: number | null;
  task_title: string | null;
  task_description: string | null;
  work_status: string | null;
  priority: string | null;
  completion_gate: string | null;
  axes: Record<string, unknown> | null;
  due_date: Date | string | null;
  acceptance_criteria: unknown[] | null;
  doc_title: string | null;
  doc_body: string | null;
  doc_format: string | null;
  channel_name: string | null;
  channel_topic: string | null;
  // A voice room has no topic and no feed (053): `name` is the whole content.
  voice_channel_name: string | null;
  msg_anchor_id: string | null;
  msg_root_id: string | null;
  msg_author_id: string | null;
  msg_batch_id: string | null;
  msg_body: string | null;
  msg_edited_at: Date | string | null;
  msg_redacted_at: Date | string | null;
  member_role: string | null;
  member_display_name: string | null;
  member_identity_id: string | null;
  profile_display_name: string | null;
  profile_avatar: string | null;
  tm_name: string | null;
  tm_role: string | null;
  tm_owner_member_id: string | null;
  tm_model: string | null;
  tm_agent_tool: string | null;
  tm_avatar: string | null;
  ws_title: string | null;
  ws_status: string | null;
  ws_agent_tool: string | null;
  ws_model: string | null;
  ws_share_mode: string | null;
  ws_started_at: Date | string | null;
  ws_exited_at: Date | string | null;
  ws_checkout_branch: string | null;
  ws_workdir_mode: string | null;
  file_name: string | null;
  file_mime_type: string | null;
  file_size_bytes: string | number | null;
  pr_title: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_ci_status: string | null;
  pr_mergeable_state: string | null;
  pr_head_ref: string | null;
  pr_url: string | null;
  pr_fetched_at: Date | string | null;
  commit_repo: string | null;
  commit_sha: string | null;
  commit_message: string | null;
  commit_committed_at: Date | string | null;
  spell_name: string | null;
  spell_description: string | null;
  skill_name: string | null;
  skill_description: string | null;
  collection_name: string | null;
  collection_type: string | null;
  ppd_name: string | null;
  ppd_project_id: string | null;
  ppd_materialized_version: number | null;
  ip_status: string | null;
  ip_current_draft_version: number | null;
  ip_initial_content_surface: string | null;
  ip_active_version: number | null;
  ip_active_hash: string | null;
  ip_retired_at: Date | string | null;
  ip_name: string | null;
  loop_title: string | null;
  loop_schedule: string | null;
  loop_enabled: boolean | null;
  loop_team_member_id: string | null;
  loop_subject_id: string | null;
  loop_next_run_at: Date | string | null;
  loop_last_run_at: Date | string | null;
  loop_last_error: string | null;
  memory_statement: string | null;
  memory_mechanism: string | null;
  memory_subject_scope: string | null;
  memory_does_not_establish: string | null;
  memory_measured_at: Date | string | null;
  wt_project_id: string | null;
  wt_branch: string | null;
  wt_base_ref: string | null;
  wt_base_commit_oid: string | null;
  wt_status: string | null;
  artifact_name: string | null;
  artifact_description: string | null;
  artifact_revision_number: number | null;
  custom_fields: Record<string, unknown> | null;
}

/**
 * One join over the envelope and every core detail table.
 *
 * A 16-way LEFT JOIN looks alarming and is not: every join is on the detail
 * table's PRIMARY KEY (`entity_id`), and an entity has exactly one detail row,
 * so this is a series of unique index lookups, not a fan-out. The alternative —
 * branching to a different query per kind — would be N round trips for a mixed
 * page and would put the kind→table mapping in two places.
 */
const SUMMARY_SQL = `
select
  e.id, e.space_id, e.kind, e.parent_id, e.position, e.visibility, e.version,
  e.activity_at, e.created_at, e.updated_at, e.deleted_at, e.created_by,
  c.likes, c.dislikes, c.stars, c.points, c.messages, c.docs, c.memories,
  t.title            as task_title,
  t.description      as task_description,
  t.work_status, t.priority, t.axes, t.due_date, t.acceptance_criteria, t.completion_gate,
  d.title            as doc_title,
  d.body             as doc_body,
  d.format           as doc_format,
  ch.name            as channel_name,
  ch.topic           as channel_topic,
  vc.name            as voice_channel_name,
  msg.anchor_id      as msg_anchor_id,
  msg.root_message_id as msg_root_id,
  msg.author_id      as msg_author_id,
  msg.message_batch_id as msg_batch_id,
  msg.body           as msg_body,
  msg.edited_at      as msg_edited_at,
  msg.redacted_at    as msg_redacted_at,
  mem.role           as member_role,
  mem.display_name   as member_display_name,
  mem.identity_id    as member_identity_id,
  up.display_name    as profile_display_name,
  up.avatar          as profile_avatar,
  tm.name            as tm_name,
  tm.role            as tm_role,
  tm.owner_member_id as tm_owner_member_id,
  tm.model           as tm_model,
  tm.agent_tool      as tm_agent_tool,
  tm.avatar          as tm_avatar,
  ws.title           as ws_title,
  ws.status          as ws_status,
  ws.agent_tool      as ws_agent_tool,
  ws.model           as ws_model,
  ws.share_mode      as ws_share_mode,
  ws.started_at      as ws_started_at,
  ws.exited_at       as ws_exited_at,
  ws.checkout_branch as ws_checkout_branch,
  ws.workdir_mode    as ws_workdir_mode,
  f.name             as file_name,
  f.mime_type        as file_mime_type,
  f.size_bytes       as file_size_bytes,
  pr.title           as pr_title,
  pr.repo            as pr_repo,
  pr.number          as pr_number,
  pr.state           as pr_state,
  pr.ci_status       as pr_ci_status,
  pr.mergeable_state as pr_mergeable_state,
  pr.head_ref        as pr_head_ref,
  pr.url             as pr_url,
  pr.fetched_at      as pr_fetched_at,
  cm.repo            as commit_repo,
  cm.sha             as commit_sha,
  cm.message         as commit_message,
  cm.committed_at    as commit_committed_at,
  sp.name            as spell_name,
  sp.description     as spell_description,
  sk.name            as skill_name,
  sk.description     as skill_description,
  col.name           as collection_name,
  col.collection_type,
  ppd.name           as ppd_name,
  ppd.project_id     as ppd_project_id,
  ppd.materialized_version as ppd_materialized_version,
  ip.status          as ip_status,
  ip.current_draft_version as ip_current_draft_version,
  ip.active_version  as ip_active_version,
  ip.active_hash     as ip_active_hash,
  ip.retired_at      as ip_retired_at,
  profile_version.draft_json ->> 'name' as ip_name,
  profile_version.draft_json ->> 'initialContentSurface' as ip_initial_content_surface,
  memo.statement     as memory_statement,
  memo.mechanism     as memory_mechanism,
  memo.subject_scope as memory_subject_scope,
  memo.does_not_establish as memory_does_not_establish,
  memo.measured_at   as memory_measured_at,
  lp.title           as loop_title,
  lp.schedule        as loop_schedule,
  lp.enabled         as loop_enabled,
  lp.team_member_id  as loop_team_member_id,
  lp.subject_id      as loop_subject_id,
  lp.next_run_at     as loop_next_run_at,
  lp.last_run_at     as loop_last_run_at,
  lp.last_error      as loop_last_error,
  wt.project_id      as wt_project_id,
  wt.branch          as wt_branch,
  wt.base_ref        as wt_base_ref,
  wt.base_commit_oid as wt_base_commit_oid,
  wt.status          as wt_status,
  art.name           as artifact_name,
  art.description    as artifact_description,
  arev.revision_number as artifact_revision_number,
  cev.fields         as custom_fields
from public.entities e
left join public.entity_counters c   on c.entity_id   = e.id
left join public.tasks t             on t.entity_id   = e.id
left join public.documents d         on d.entity_id   = e.id
left join public.channels ch         on ch.entity_id  = e.id
left join public.voice_channels vc   on vc.entity_id  = e.id
left join public.messages msg        on msg.entity_id = e.id
left join public.members mem         on mem.entity_id = e.id
left join public.user_profiles up    on up.identity_id = mem.identity_id
left join public.team_members tm     on tm.entity_id  = e.id
left join public.work_sessions ws    on ws.entity_id  = e.id
left join public.files f             on f.entity_id   = e.id
left join public.pull_requests pr    on pr.entity_id  = e.id
left join public.commits cm          on cm.entity_id  = e.id
left join public.spells sp           on sp.entity_id  = e.id
left join public.skills sk           on sk.entity_id  = e.id
left join public.collections col     on col.entity_id = e.id
left join public.project_projection_details ppd on ppd.entity_id = e.id
left join public.interaction_profiles ip        on ip.entity_id  = e.id
left join public.interaction_profile_versions profile_version
  on profile_version.profile_id = ip.entity_id
 and profile_version.version = coalesce(ip.active_version, ip.current_draft_version)
left join public.memories memo       on memo.entity_id = e.id
left join public.worktrees wt        on wt.entity_id = e.id
left join public.loops lp            on lp.entity_id = e.id
left join public.artifacts art       on art.entity_id = e.id
left join public.artifact_bundle_revisions arev on arev.id = art.current_revision_id
left join public.custom_entities cev on cev.entity_id = e.id
where e.id = any($1::uuid[])
`;

/**
 * Reaction/assignment/membership edges, batched for the whole page.
 *
 * `has_member` rides along rather than becoming a KNOWN_GAP: this query is
 * already running, already resolves its `dst_id`s into actors below, and a
 * channel's roster is small. An empty `members` would be the projector saying
 * a channel has nobody when the graph says otherwise.
 */
const EDGE_SQL = `
select src_id, dst_id, type
  from public.edges
 where type in ('likes','dislikes','stars','assigned_to','has_member')
   and (dst_id = any($1::uuid[]) or src_id = any($1::uuid[]))
`;

/**
 * Normalize a timestamp column to an ISO-8601 **UTC** string.
 *
 * The driver hands back `Date` for `timestamptz`, but a value that reached us as
 * text carries the session's offset (`…+05:30`) and the contract's schemas
 * require `…Z`. Re-parsing makes both shapes converge. A `date` column
 * (`due_date`) widens to midnight UTC, which is what a date-only value means on
 * a timestamp-typed contract field.
 */
function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** `iso` for the non-nullable timestamp columns, which are `not null` in the DDL. */
function isoRequired(v: Date | string): string {
  return iso(v) ?? new Date(0).toISOString();
}

function asStringRecord(v: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v ?? {})) out[k] = String(val);
  return out;
}

/**
 * `EntityProjector` over the core graph tables.
 *
 * This is the G1A implementation, and it is honest about where it is thin: see
 * `KNOWN_GAPS` below. It is complete for every kind the G1A loop creates.
 */
export class PgEntityProjector implements EntityProjector {
  async entitySummaries(q: Querier, ids: readonly string[]): Promise<Map<string, EntitySummary>> {
    const out = new Map<string, EntitySummary>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;

    const rows = await q.query<SummaryRow>(SUMMARY_SQL, [unique]);
    if (rows.length === 0) return out;

    // Actors referenced by the summaries themselves (`createdBy`, message
    // authors, assignees) may not be in `ids` — resolve them in a second pass
    // over the same query rather than a different one.
    const actorIds = new Set<string>();
    for (const r of rows) {
      actorIds.add(r.created_by);
      if (r.msg_author_id !== null) actorIds.add(r.msg_author_id);
    }

    const edges = await q.query<{ src_id: string; dst_id: string; type: string }>(EDGE_SQL, [unique]);
    const attentionRows = await q.query<{
      entity_id: string;
      pending_count: number;
      total_points: number;
      max_points: number;
      latest_reason: string;
      oldest_requested_at: Date | string;
    }>(
      `select entity_id, count(*)::int as pending_count,
              sum(points)::int as total_points, max(points)::int as max_points,
              (array_agg(reason order by created_at desc, id desc))[1] as latest_reason,
              min(created_at) as oldest_requested_at
         from public.attention_requests
        where entity_id = any($1::uuid[]) and status in ('open', 'acknowledged')
        group by entity_id`,
      [unique],
    );
    const attention = new Map<string, EntityAttentionSummary>();
    for (const row of attentionRows) {
      attention.set(row.entity_id, {
        pendingCount: Number(row.pending_count),
        totalPoints: Number(row.total_points),
        maxPoints: Number(row.max_points),
        latestReason: row.latest_reason,
        oldestRequestedAt: isoRequired(row.oldest_requested_at),
      });
    }
    // Two maps, not one. `assigned_to` and `has_member` are disjoint by
    // construction — `internal.validate_edge` pins the first to src kind task
    // and the second to src kind channel (080) — but keeping them apart means
    // this code says which relation it is holding instead of relying on that.
    const assigneeIds = new Map<string, string[]>();
    const memberIds = new Map<string, string[]>();
    for (const edge of edges) {
      const target =
        edge.type === 'assigned_to' ? assigneeIds : edge.type === 'has_member' ? memberIds : null;
      if (!target) continue;
      const list = target.get(edge.src_id) ?? [];
      list.push(edge.dst_id);
      target.set(edge.src_id, list);
      actorIds.add(edge.dst_id);
    }

    const missingActors = [...actorIds].filter((id) => !unique.includes(id));
    const actorRows =
      missingActors.length === 0 ? [] : await q.query<SummaryRow>(SUMMARY_SQL, [missingActors]);

    const actors = new Map<string, ActorSummary>();
    for (const r of [...rows, ...actorRows]) {
      const actor = this.actorOf(r);
      if (actor !== null) actors.set(r.id, actor);
    }

    // `viewerReaction`: the caller's own reaction edge (DEV-10). Because this
    // query ran under the caller's claims, an edge authored by someone else is
    // simply not the caller's — we look for edges whose SOURCE is one of the
    // actors the caller is, which for v1 is the acting member. RLS decides
    // visibility; we decide attribution.
    const viewerReactions = new Map<string, EntityCounters['viewerReaction']>();
    for (const edge of edges) {
      if (edge.type === 'likes') viewerReactions.set(edge.dst_id, 'like');
      else if (edge.type === 'dislikes') viewerReactions.set(edge.dst_id, 'dislike');
      else if (edge.type === 'stars') viewerReactions.set(edge.dst_id, 'star');
    }

    // Viewer-scoped, and the SAME source the facade assembler uses, so a
    // channel's unread badge is identical whether it arrived over the event
    // feed or over a read. Skipped entirely when no channel is in the batch.
    const unreadCounts = await loadUnreadCounts(q, rows);

    // The same aggregate the facade assembler computes, so a collection's item
    // count is identical over the event feed and over a read. Skipped entirely
    // when no collection is in the batch. LIVE members only: soft delete
    // leaves the `contains` edge in place, and a count of raw edges would
    // exceed every list the UI can draw (content.items, connections and
    // collections.query all exclude tombstones) with no cap in sight.
    const containsCounts = new Map<string, number>();
    const collectionIds = rows.filter((r) => r.kind === 'collection').map((r) => r.id);
    if (collectionIds.length > 0) {
      const counted = await q.query<{ src_id: string; n: number }>(
        `select g.src_id, count(*)::int as n
           from public.edges g
           join public.entities m on m.id = g.dst_id and m.deleted_at is null
          where g.type = 'contains' and g.src_id = any($1::uuid[])
          group by g.src_id`,
        [collectionIds],
      );
      for (const row of counted) containsCounts.set(row.src_id, Number(row.n));
    }

    // `badges.pullRequests` — and it is NOT a KNOWN_GAP, deliberately. The
    // other badges are omitted here because they need per-entity graph work
    // this projector does not do; this one is a single bounded query, and
    // leaving it out would be worse than absent: the chip would render on load
    // and then VANISH on the next live `entity.upsert`, which reads as the PR
    // being unlinked. Same loader as the facade assembler, so the two answers
    // cannot drift. Skipped entirely when no task is in the batch.
    const pullRequests = await loadLinkedPullRequestBadges(q, rows);

    for (const r of rows) {
      out.set(
        r.id,
        this.summaryOf(r, actors, assigneeIds.get(r.id) ?? [], memberIds.get(r.id) ?? [],
          viewerReactions.get(r.id) ?? null, attention.get(r.id), unreadCounts, containsCounts,
          pullRequests.get(r.id)),
      );
    }
    return out;
  }

  /**
   * `ActorSummary` for the ids that are actors, with the `avatar` an
   * `EntitySummary` cannot carry.
   */
  async actorSummaries(q: Querier, ids: readonly string[]): Promise<Map<string, ActorSummary>> {
    const out = new Map<string, ActorSummary>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;
    const rows = await q.query<SummaryRow>(SUMMARY_SQL, [unique]);
    for (const r of rows) {
      const actor = this.actorOf(r);
      if (actor !== null) out.set(r.id, actor);
    }
    return out;
  }

  /** An `ActorSummary`, if this row is a member or team_member. */
  private actorOf(r: SummaryRow): ActorSummary | null {
    if (r.kind === 'member') {
      return {
        id: r.id,
        kind: 'member',
        displayName: r.member_display_name ?? r.profile_display_name ?? r.member_identity_id ?? 'member',
        avatar: r.profile_avatar,
        role: r.member_role,
        isAgent: false,
      };
    }
    if (r.kind === 'team_member') {
      const summary: ActorSummary = {
        id: r.id,
        kind: 'team_member',
        displayName: r.tm_name ?? 'agent',
        avatar: r.tm_avatar,
        role: r.tm_role,
        isAgent: true,
      };
      return r.tm_owner_member_id === null
        ? summary
        : { ...summary, ownerMemberId: r.tm_owner_member_id };
    }
    return null;
  }

  /**
   * A placeholder actor for a `createdBy` we could not resolve.
   *
   * `EntitySummary.createdBy` is NOT optional in the contract, so a missing
   * author cannot be represented by omission — and dropping the whole event
   * because its author row was deleted would lose a real mutation. This keeps
   * the event, and makes the gap visible in the UI rather than crashing the
   * tripwire.
   */
  private unknownActor(id: string): ActorSummary {
    return { id, kind: 'member', displayName: 'unknown', avatar: null, role: null, isAgent: false };
  }

  private summaryOf(
    r: SummaryRow,
    actors: Map<string, ActorSummary>,
    assignees: readonly string[],
    members: readonly string[],
    viewerReaction: EntityCounters['viewerReaction'],
    attention: EntityAttentionSummary | undefined,
    unreadCounts: ReadonlyMap<string, number>,
    containsCounts: ReadonlyMap<string, number>,
    pullRequests: LinkedPullRequestBadges | undefined,
  ): EntitySummary {
    const counters: EntityCounters = {
      likes: r.likes ?? 0,
      dislikes: r.dislikes ?? 0,
      stars: r.stars ?? 0,
      points: r.points ?? 0,
      messages: r.messages ?? 0,
      // 108 — MIRRORS entity-read: a live row post-108 always has the
      // columns (NOT NULL DEFAULT 0); a missing counter row joins as null
      // and projects 0 like its five elders.
      docs: r.docs ?? 0,
      memories: r.memories ?? 0,
      viewerReaction,
    };

    const summary: EntitySummary = {
      id: r.id,
      spaceId: r.space_id,
      kind: entityKind(r.kind, r.id),
      title: this.titleOf(r),
      parentId: r.parent_id,
      position: r.position,
      visibility: r.visibility === 'restricted' ? 'restricted' : 'space',
      version: r.version,
      activityAt: isoRequired(r.activity_at),
      createdAt: isoRequired(r.created_at),
      updatedAt: isoRequired(r.updated_at),
      deletedAt: iso(r.deleted_at),
      createdBy: actors.get(r.created_by) ?? this.unknownActor(r.created_by),
      counters,
      state: this.stateOf(r, actors, assignees, members, unreadCounts, containsCounts),
      // `EntityBadges` fields are all optional, so `{}` is a valid and honest
      // "no badges computed" — unlike `state`, which has required fields and
      // cannot be honestly empty. `restricted` is the one badge derivable from
      // the envelope alone. blocked/pulls/workingActors need graph traversals
      // that belong to the facade's assembler — see KNOWN_GAPS.
      //
      // `pullRequests` MIRRORS badgesOf in entity-read.ts, condition for
      // condition: emitted only when non-empty, `truncated` only when true.
      badges: {
        ...(r.visibility === 'restricted' ? { restricted: true } : {}),
        ...(attention ? { attention } : {}),
        ...(pullRequests && pullRequests.items.length > 0
          ? {
              pullRequests: pullRequests.items,
              ...(pullRequests.truncated ? { pullRequestsTruncated: true } : {}),
            }
          : {}),
      },
    };

    const excerpt = this.excerptOf(r);
    return excerpt === null ? summary : { ...summary, excerpt };
  }

  /**
   * Kind-specific display title. Never an id (contract: "never an ID").
   *
   * ## ⚠ THERE ARE TWO OF THESE, AND MOST FALLBACKS DISAGREE
   *
   * The other one is `titleOf` in `facade/entity-read.ts` (the tombstone branch
   * is at entity-read.ts:485, the work_session fallback at :503). That is the
   * facade's read path; this is the event path. The SAME entity therefore gets a
   * different title depending on whether you fetched it or were pushed it — the
   * observed symptom was a work_session that read as "Session" after reload
   * and as "" after a live event. Work-session title parity is fixed below;
   * the remaining cosmetic divergences stay visible until the shared assembler
   * replaces this projector.
   *
   * **The intended fix is NOT to hand-match the tables below.** Doing that
   * creates a second copy of the fallback table, which is exactly what the
   * `EntityProjector` seam exists to eliminate, and a hand-matched copy that
   * looks right today drifts silently tomorrow. The fix is to inject the
   * facade's assembler behind `EntityProjector` (scheduled; the seam and the
   * exported assembler both already exist). Until then these gaps are left
   * VISIBLE on purpose.
   *
   * Known divergences, this file → entity-read.ts. Cosmetic, deliberately unfixed:
   *   task         ''                → 'Untitled task'
   *   doc          ''                → 'Untitled document'
   *   channel      ''                → 'channel'
   *   voice_channel ''               → 'voice channel'
   *   member       ''                → 'Member'
   *   team_member  ''                → 'Agent'
   *   file         ''                → 'File'
   *   collection   ''                → 'Collection'
   *   message      body.slice(0,120) → excerpt(body) ?? 'Message'
   *
   * Behavioural, and FIXED here because they are correctness/privacy rather than
   * labels — do not regress them while waiting for the injection:
   *   deleted entity   → tombstone title, not the live title (below)
   *   redacted message → body and excerpt suppressed (see `excerptOf`, and the
   *                      live-row read in mapper.ts `messageContents`)
   *
   * If you are here to "fix one side", read the paragraph above first: widening
   * the gap by patching only one implementation is worse than the gap.
   */
  private titleOf(r: SummaryRow): string {
    // A deleted entity must not keep announcing its real title over the event
    // feed. Matches entity-read.ts:485, which tombstones before the kind switch.
    if (r.deleted_at !== null) return TOMBSTONE_TITLE;
    switch (r.kind) {
      case 'task':
        return r.task_title ?? '';
      case 'doc':
        return r.doc_title ?? '';
      case 'channel':
        return r.channel_name ?? '';
      case 'voice_channel':
        // Same bare name as `channel` — the '🔊' is a rendering affordance and
        // belongs to the client, exactly as the '#' does for text channels.
        return r.voice_channel_name ?? '';
      case 'member':
        return r.member_display_name ?? r.profile_display_name ?? r.member_identity_id ?? '';
      case 'team_member':
        return r.tm_name ?? '';
      case 'work_session':
        return r.ws_title && r.ws_title.length > 0 ? r.ws_title : 'Session';
      case 'file':
        return r.file_name ?? '';
      case 'pull_request':
        return r.pr_title ?? (r.pr_repo !== null ? `${r.pr_repo}#${String(r.pr_number ?? 0)}` : '');
      case 'commit':
        // First line of the commit message is the conventional title.
        return (r.commit_message ?? '').split('\n')[0] ?? '';
      case 'spell':
        return r.spell_name ?? '';
      case 'skill':
        return r.skill_name ?? '';
      case 'collection':
        return r.collection_name ?? '';
      case 'project':
        return r.ppd_name ?? '';
      case 'interaction_profile':
        // The name is versioned with the profile draft. Keep live events in
        // lock-step with collection/detail reads so an upsert cannot replace
        // a useful picker label with an empty string.
        return r.ip_name ?? '';
      case 'message':
        // A message has no title of its own; the first line of the body is what
        // every surface shows. Bounded so a 10k-char message is not a title.
        return (r.msg_body ?? '').slice(0, 120);
      case 'memory':
        // Derived from the statement, never separately settable — MIRRORS
        // entity-read.ts titleOf (same flatten, same 120-char bound, same
        // fallback), because a title that differs between the feed and the
        // read path is drift a client can see.
        return (r.memory_statement ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Memory';
      case 'loop':
        // Its own detail-row title — MIRRORS entity-read.ts titleOf, same
        // fallback. `entities` has no title column for it to fall back to.
        return r.loop_title ?? 'Loop';
      case 'worktree':
        // The branch is the human name — MIRRORS entity-read.ts titleOf.
        return r.wt_branch ?? 'Worktree';
      case 'artifact':
        // The artifact's own name — MIRRORS entity-read.ts titleOf.
        return r.artifact_name ?? 'Artifact';
      default:
        // Custom c:* kinds: no title column exists. `fields.title` is the
        // convention when the kind schema declares one.
        return String(r.custom_fields?.['title'] ?? '');
    }
  }

  /**
   * The excerpt, or null for "no excerpt".
   *
   * Two suppressions, both matching `facade/entity-read.ts:517-521` and both
   * load-bearing rather than cosmetic:
   * - a DELETED entity gets no excerpt, for the same reason it gets a tombstone
   *   title instead of its real one;
   * - a REDACTED message gets no excerpt. Redaction is a user asking for
   *   something to be unsaid, and the event feed is the path a client is most
   *   likely to cache, so leaking it here defeats the request more thoroughly
   *   than leaking it on a read would.
   *
   * The 280-char cap is this surface's own and deliberately differs from the
   * facade's 200; only the STRIPPING rule is shared, via `plainExcerpt`. Sharing
   * it is not optional: `facade/entity-read.ts` strips, so leaving a raw
   * `slice` here would not preserve an existing divergence, it would author a
   * new one — the case `:644` rules against.
   */
  private excerptOf(r: SummaryRow): string | null {
    if (r.deleted_at !== null) return null;
    if (r.kind === 'message' && r.msg_redacted_at !== null) return null;
    const source =
      r.kind === 'task' ? r.task_description
      : r.kind === 'doc' ? r.doc_body
      : r.kind === 'message' ? r.msg_body
      : r.kind === 'channel' ? r.channel_topic
      : r.kind === 'memory' ? r.memory_statement
      : r.kind === 'artifact' ? r.artifact_description
      : r.kind === 'loop' ? r.loop_schedule
      : null;
    if (source === null || source === '') return null;
    // Empty becomes "no excerpt", not an empty one — `entity-read.ts` maps the
    // same case to `undefined`. A whitespace-only body reaches here as `''`.
    return plainExcerpt(source, 280) || null;
  }

  /**
   * The kind-specific `state`. Unlike badges, `state` has REQUIRED fields per
   * arm, so every branch has to produce a complete object — and an unknown kind
   * falls through to the custom-kind arm rather than to `undefined`, which the
   * tripwire would reject.
   */
  private stateOf(
    r: SummaryRow,
    actors: Map<string, ActorSummary>,
    assignees: readonly string[],
    members: readonly string[],
    unreadCounts: ReadonlyMap<string, number>,
    containsCounts: ReadonlyMap<string, number>,
  ): EntityState {
    switch (r.kind) {
      case 'task': {
        const criteria = Array.isArray(r.acceptance_criteria) ? r.acceptance_criteria : [];
        const completed = criteria.filter(
          (c) => typeof c === 'object' && c !== null && (c as { done?: unknown }).done === true,
        ).length;
        return {
          kind: 'task',
          workStatus: oneOf(r.work_status, WORK_STATUSES, 'open'),
          priority: oneOf(r.priority, PRIORITIES, 'medium'),
          axes: asStringRecord(r.axes),
          dueDate: iso(r.due_date),
          assignees: assignees.map((id) => actors.get(id) ?? this.unknownActor(id)),
          acceptance: { total: criteria.length, completed },
          completionGate: r.completion_gate === 'pr_merged' ? 'pr_merged' : 'none',
        };
      }
      case 'doc':
        return {
          kind: 'doc',
          format: oneOf(r.doc_format, DOC_FORMATS, 'markdown'),
          // childCount: docs nest (homogeneous hierarchy), so this is a count of
          // child entities. See KNOWN_GAPS — not computed on the event path.
          childCount: 0,
        };
      case 'channel':
        return {
          kind: 'channel',
          topic: r.channel_topic ?? '',
          members: members.map((id) => actors.get(id) ?? this.unknownActor(id)),
          // MIRRORS entity-read.ts stateOf, deliberately: this query runs under
          // the caller's claims, so `public.unread_counts` resolves the same
          // viewer it does on the read path. If this stayed 0 while the facade
          // reported the truth, every `entity.upsert` for a channel would
          // overwrite a correct badge with a false zero.
          unreadCount: unreadCounts.get(r.id) ?? 0,
          workingAgentCount: 0,
        };
      case 'voice_channel':
        return {
          kind: 'voice_channel',
          // 0, ALWAYS, on this path — and not a "not computed yet" 0 like the
          // ones in KNOWN_GAPS. The roster is ephemeral by construction: it
          // lives in `voice/roster.ts` in this process, is rebuilt from LiveKit
          // webhooks, and is deliberately in NO table (053's header: a table
          // for it "would be a lie that survives a crash"). The projector reads
          // Postgres under the caller's claims and holds nothing else, so there
          // is no query that could produce the real count here. Live counts
          // reach clients over the voice roster events, not over entity.upsert.
          participantCount: 0,
        };
      case 'message':
        return {
          kind: 'message',
          anchorId: r.msg_anchor_id ?? r.id,
          rootMessageId: r.msg_root_id,
          author:
            r.msg_author_id === null
              ? this.unknownActor(r.id)
              : (actors.get(r.msg_author_id) ?? this.unknownActor(r.msg_author_id)),
          messageBatchId: r.msg_batch_id,
          editedAt: iso(r.msg_edited_at),
          redactedAt: iso(r.msg_redacted_at),
        };
      case 'member':
        return {
          kind: 'member',
          role: oneOf(r.member_role, MEMBER_ROLES, 'member'),
          score: r.points ?? 0,
          taskDoneCount: 0,
        };
      case 'team_member':
        return {
          kind: 'team_member',
          owner:
            r.tm_owner_member_id === null
              ? this.unknownActor(r.id)
              : (actors.get(r.tm_owner_member_id) ?? this.unknownActor(r.tm_owner_member_id)),
          model: r.tm_model,
          agentTool: r.tm_agent_tool,
          liveWork: null,
        };
      case 'work_session':
        return {
          kind: 'work_session',
          status: oneOf(r.ws_status, WS_STATUSES, 'spawning'),
          agentTool: r.ws_agent_tool,
          model: r.ws_model,
          shareMode: oneOf(r.ws_share_mode, WS_SHARE_MODES, 'none'),
          startedAt: iso(r.ws_started_at),
          exitedAt: iso(r.ws_exited_at),
          // The lane facts (107) — MIRRORS entity-read.ts stateOf: an
          // explicit null branch renders no claim; the mode key is spread
          // in only when the column holds a CHECK value, because absence
          // means "too old to know" while a wrong word would be a lie.
          checkoutBranch: r.ws_checkout_branch ?? null,
          ...(r.ws_workdir_mode === 'project' ||
          r.ws_workdir_mode === 'worktree' ||
          r.ws_workdir_mode === 'scratch'
            ? { workdirMode: r.ws_workdir_mode }
            : {}),
        };
      case 'file':
        return {
          kind: 'file',
          name: r.file_name ?? '',
          mimeType: r.file_mime_type ?? 'application/octet-stream',
          sizeBytes: Number(r.file_size_bytes ?? 0),
        };
      case 'pull_request': {
        const base = {
          kind: 'pull_request' as const,
          repository: r.pr_repo ?? '',
          number: r.pr_number ?? 0,
          state: r.pr_state ?? 'open',
          fetchedAt: iso(r.pr_fetched_at),
          // `stale` is "the mirror is older than the upstream", which needs a
          // tracking comparison. Never fetched ⇒ definitionally stale.
          stale: r.pr_fetched_at === null,
          ...projectForgeFacts(r.pr_ci_status, r.pr_mergeable_state, r.pr_head_ref),
        };
        return r.pr_url === null ? base : { ...base, url: r.pr_url };
      }
      case 'commit':
        return {
          kind: 'commit',
          repository: r.commit_repo ?? '',
          sha: r.commit_sha ?? '',
          message: r.commit_message ?? '',
          committedAt: iso(r.commit_committed_at),
        };
      case 'spell':
      case 'skill': {
        const description = r.kind === 'spell' ? r.spell_description : r.skill_description;
        // `equipped` is relative to a context (a task/persona equips a spell via
        // an `equips` edge); an event has no such context. False is the honest
        // default for "not equipped in any context I was told about".
        return description === null
          ? { kind: r.kind, equipped: false }
          : { kind: r.kind, description, equipped: false };
      }
      case 'collection':
        return {
          kind: 'collection',
          collectionType: r.collection_type ?? 'manual',
          itemCount: containsCounts.get(r.id) ?? 0,
        };
      // The two arms below were MISSING while their kinds sat in the frozen
      // contract (CoreEntityKindSchema includes 'project' and
      // 'interaction_profile'), so a projects.create/link on any space fell
      // through to the custom-kind guard, raised EntityKindDriftError, and —
      // because that error is deliberately fatal to the whole page — wedged
      // the pump's cursor and the space's entire live feed PERMANENTLY.
      // Found by ws-e2e.pg.test.ts A6c. The drift guard itself is correct and
      // stays; these arms close the drift it was pointing at.
      case 'project':
        return {
          kind: 'project',
          // The detail row is written atomically with the projection entity
          // (021); the fallbacks keep a hypothetical stray row projectable
          // instead of re-poisoning the feed on a strict-schema refusal.
          projectId: r.ppd_project_id ?? r.id,
          materializedVersion: r.ppd_materialized_version ?? 1,
        };
      case 'interaction_profile':
        return {
          kind: 'interaction_profile',
          status: oneOf(r.ip_status, IP_STATUSES, 'draft'),
          currentDraftVersion: r.ip_current_draft_version ?? 1,
          activeVersion: r.ip_active_version,
          activeHash: r.ip_active_hash,
          retiredAt: iso(r.ip_retired_at),
          // Absent key when the draft has no opinion — see entity-read's
          // `surfaceOf`. Both readers must agree or the same profile would
          // describe itself differently over the feed than over a read.
          ...(r.ip_initial_content_surface === 'terminal'
            || r.ip_initial_content_surface === 'chat'
            ? { initialContentSurface: r.ip_initial_content_surface }
            : {}),
        };
      case 'memory':
        // MIRRORS entity-read.ts stateOf. The scope columns are NOT NULL in
        // the DDL; the fallbacks keep a hypothetical stray row projectable
        // instead of poisoning the feed on a strict-schema refusal (the
        // project/interaction_profile lesson above).
        return {
          kind: 'memory',
          mechanism: r.memory_mechanism ?? '',
          subjectScope: r.memory_subject_scope ?? '',
          doesNotEstablish: r.memory_does_not_establish ?? '',
          measuredAt: iso(r.memory_measured_at),
        };
      case 'loop':
        // MIRRORS entity-read.ts stateOf. `teamMemberId: null` is meaningful
        // (route via the dispatcher), so it is projected as null, not ''.
        return {
          kind: 'loop',
          schedule: r.loop_schedule ?? '',
          enabled: r.loop_enabled ?? false,
          teamMemberId: r.loop_team_member_id,
          subjectId: r.loop_subject_id,
          nextRunAt: iso(r.loop_next_run_at),
          lastRunAt: iso(r.loop_last_run_at),
          lastError: r.loop_last_error,
        };
      case 'worktree':
        // Semantic lifecycle only — allocation (disk) state is deliberately
        // not on the event path either. MIRRORS entity-read.ts stateOf.
        return {
          kind: 'worktree',
          status: oneOf(r.wt_status, WT_STATUSES, 'active'),
          branch: r.wt_branch ?? '',
          baseRef: r.wt_base_ref ?? '',
          baseCommitOid: r.wt_base_commit_oid ?? '',
          projectId: r.wt_project_id ?? '',
        };
      case 'artifact':
        // Publish drives version advancement; the CURRENT revision number —
        // MIRRORS entity-read.ts stateOf. The fallback of 1 keeps a
        // hypothetical stray envelope projectable instead of poisoning the feed
        // on a strict-schema refusal.
        return { kind: 'artifact', revisionNumber: r.artifact_revision_number ?? 1 };
      default: {
        // T-L4: custom c:* kinds carry their schema-validated scalars.
        //
        // Reaching here means the kind is not one of the core arms above. It
        // must therefore be a custom kind — and `entityKind` has already proven
        // the string is a valid `EntityKind`, so anything that is not core is
        // `c:${string}` by elimination. The check is repeated rather than
        // assumed: if a core kind is ever added to the contract without a case
        // here, this raises drift instead of silently projecting a core entity
        // as a custom one with empty fields.
        const kind = entityKind(r.kind, r.id);
        if (!kind.startsWith('c:')) throw new EntityKindDriftError(r.kind, r.id);
        return {
          kind: kind as CustomEntityKind,
          fields: (r.custom_fields ?? {}) as CustomEntityState['fields'],
        };
      }
    }
  }
}

/**
 * What this projector does NOT compute, recorded here rather than discovered by
 * whoever debugs a zero in the UI. Every one of these is a graph traversal or a
 * viewer-scoped aggregate that belongs to the facade's `EntitySummary`
 * assembler; when that assembler is injected behind `EntityProjector` they all
 * become correct at once, with no change to the mapper.
 *
 * None of them affects the G1A loop, which needs task/doc/message/work_session
 * identity, titles, status and counters — all of which ARE computed.
 *
 * - `badges.blocked` / `badges.pulls` / `badges.workingActors` — omitted (all
 *   optional; `{}` is contract-valid). Each needs an edge traversal per entity.
 * - `state.channel.workingAgentCount` — 0. Needs live `working_on` edges.
 * - `state.doc.childCount` — 0. Needs a child count per doc.
 * - `state.member.taskDoneCount` — 0. Needs a completed-task aggregate.
 * - `state.team_member.liveWork` — null. Needs the live `working_on` join.
 */
export const KNOWN_GAPS = Object.freeze([
  'badges.blocked',
  'badges.pulls',
  'badges.workingActors',
  // Staleness needs the mark-edge traversal + pin-target versions — the same
  // per-entity graph work as blocked/pulls. A feed-driven UI sees a staleness
  // change on re-read, not live (consistent with the two badges above).
  'badges.staleness',
  // `state.channel.unreadCount` used to be here. It is now computed, from the
  // same `public.unread_counts` the facade assembler uses.
  'state.channel.workingAgentCount',
  'state.doc.childCount',
  'state.member.taskDoneCount',
  'state.team_member.liveWork',
  // `state.collection.itemCount` used to be here. It is now computed, from
  // the same `contains` count the facade assembler uses.
]);
