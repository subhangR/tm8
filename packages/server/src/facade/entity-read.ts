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
  WorkSessionEndedKind,
  WorkSessionKind,
  AcceptanceCriterion,
  ContainerIsolationClass,
  ContainerLifecycle,
  ContainerProfile,
  ContainerShareMode,
  ContainerSpec,
  ContainerStatus,
  ContainerSurfaceKind,
  ContainerUsage,
  ActorSummary,
  ChatMode,
  ChatWorkdirMode,
  EntityBadges,
  EntityCapabilities,
  EntityContent,
  EntityCounters,
  EntityAttentionSummary,
  EntityKind,
  EntityStaleness,
  EntityState,
  GraphEdgeSpec,
  GraphNode,
  EntitySummary,
  LiveWork,
  PullState,
  TaskAssignment,
  Visibility,
  WorkStatus,
} from '@tm8/contract';
import { plainExcerpt } from '@tm8/contract';
import type { Querier } from '../db/types.js';
import { projectInteractionProfileForBrowser } from '../profiles/browser-projection.js';
import {
  loadLinkedPullRequestBadges,
  projectForgeFacts,
  type LinkedPullRequestBadges,
} from '../tracking/pr-projection.js';
import { loadHumanMessageAuthorIds, type HumanMessageAuthorIds } from './message-author-projection.js';
// The ONE narrowing of the status columns, shared with `events/projector.ts`.
import { categoryFragment, narrowWorkStatus } from './status.js';

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
  -- 147. Denormalized onto the envelope precisely so it can live in THIS
  -- column list: the category is the tab/filter predicate, and a predicate
  -- that needed the task join would be unavailable to the twenty kinds that
  -- will carry a status in a later phase. MIRRORED by projector.ts's
  -- SUMMARY_SQL — the two column lists must not drift.
  e.status_category,
  coalesce(ec.likes, 0)    as likes,
  coalesce(ec.dislikes, 0) as dislikes,
  coalesce(ec.stars, 0)    as stars,
  coalesce(ec.points, 0)   as points,
  coalesce(ec.messages, 0) as messages,
  coalesce(ec.human_messages, 0) as human_messages,
  coalesce(ec.agent_messages, 0) as agent_messages,
  coalesce(ec.docs, 0)     as docs,
  coalesce(ec.memories, 0) as memories,
  t.title as task_title, t.description as task_description, t.axes as task_axes,
  t.work_status, t.priority, t.acceptance_criteria, t.points_estimate, t.due_date,
  t.start_date,
  t.completion_gate,
  d.title as doc_title, d.body as doc_body, d.format as doc_format,
  ch.name as channel_name, ch.topic as channel_topic,
  vc.name as voice_channel_name,
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
  ws.transcript_doc_id as ws_transcript_doc_id, ws.session_kind as ws_session_kind,
  ws.checkout_branch as ws_checkout_branch, ws.workdir_mode as ws_workdir_mode,
  ws.ended_kind as ws_ended_kind, ws.ended_reason as ws_ended_reason,
  wsp.pin_revision as ws_pin_revision, wsp.template_key as ws_pin_template_key,
  wsp.template_version as ws_pin_template_version,
  wsp.resolved_snapshot as ws_pin_resolved_snapshot,
  msg.anchor_id, msg.root_message_id, msg.author_id, msg.body as message_body,
  msg.message_batch_id,
  msg.mentions as message_mentions, msg.attachments as message_attachments,
  msg.edited_at as message_edited_at, msg.redacted_at as message_redacted_at,
  f.name as file_name, f.mime_type as file_mime, f.size_bytes as file_size,
  ppd.name as ppd_name, ppd.project_id as ppd_project_id,
  ppd.materialized_version as ppd_materialized_version,
  ip.status as ip_status, ip.current_draft_version as ip_current_draft_version,
  ip.active_version as ip_active_version, ip.active_hash as ip_active_hash,
  ip.retired_at as ip_retired_at,
  profile_version.draft_json ->> 'name' as ip_name,
  profile_version.draft_json ->> 'initialContentSurface' as ip_initial_content_surface,
  memo.statement as memory_statement, memo.mechanism as memory_mechanism,
  memo.subject_scope as memory_subject_scope,
  memo.does_not_establish as memory_does_not_establish,
  memo.measured_at as memory_measured_at,
  lp.title as loop_title, lp.schedule as loop_schedule, lp.enabled as loop_enabled,
  lp.team_member_id as loop_team_member_id, lp.subject_id as loop_subject_id,
  lp.prompt as loop_prompt, lp.config as loop_config,
  lp.next_run_at as loop_next_run_at, lp.last_run_at as loop_last_run_at,
  lp.last_error as loop_last_error,
  cht.title as chat_title, cht.teammate_id as chat_teammate_id,
  cht.model as chat_model, cht.provider as chat_provider, cht.agent_tool as chat_agent_tool,
  cht.chat_mode as chat_mode, cht.workdir_mode as chat_workdir_mode,
  cht.project_id as chat_project_id, cht.runtime_state as chat_runtime_state,
  chq.turn_state as chat_turn_state, chq.turn_count as chat_turn_count,
  chq.last_turn_at as chat_last_turn_at,
  gr.title as graph_title, gr.graph_type as graph_type,
  gr.nodes as graph_nodes, gr.edges as graph_edges,
  gr.layout as graph_layout, gr.source as graph_source,
  wt.project_id as wt_project_id, wt.path as wt_path, wt.branch as wt_branch,
  wt.base_ref as wt_base_ref, wt.base_commit_oid as wt_base_commit_oid,
  wt.status as wt_status, wt.status_changed_at as wt_status_changed_at,
  ctr.status as ctr_status, ctr.profile as ctr_profile, ctr.provider as ctr_provider,
  ctr.isolation as ctr_isolation, ctr.node_id as ctr_node_id, ctr.image as ctr_image,
  ctr.spec as ctr_spec, ctr.lifecycle as ctr_lifecycle, ctr.surfaces as ctr_surfaces,
  ctr.share_mode as ctr_share_mode, ctr.started_at as ctr_started_at,
  ctr.expires_at as ctr_expires_at, ctr.error as ctr_error, ctr.title as ctr_title,
  ctr.exposed as ctr_exposed, crs.usage as ctr_usage,
  pr.title as pr_title, pr.repo as pr_repo, pr.number as pr_number,
  pr.state as pr_state, pr.ci_status as pr_ci_status,
  pr.mergeable_state as pr_mergeable_state, pr.head_ref as pr_head_ref,
  pr.url as pr_url, pr.fetched_at as pr_fetched_at,
  art.name as artifact_name, art.description as artifact_description,
  arev.revision_number as artifact_revision_number,
  arev.entrypoint_path as artifact_entrypoint,
  arev.manifest_sha256 as artifact_manifest_sha256,
  arev.file_count as artifact_file_count,
  arev.total_size_bytes as artifact_total_size_bytes
`;

/**
 * LEFT JOIN every detail table rather than dispatching on kind in the caller.
 * The envelope+detail split (001 §9) means a uniform read has to reassemble
 * them somewhere, and doing it once here beats a per-kind query path that can
 * drift kind by kind.
 */
// --- containers (177) -------------------------------------------------------

const CONTAINER_STATUSES_SET = new Set<ContainerStatus>([
  'requested', 'provisioning', 'running', 'paused', 'stopping',
  'stopped', 'destroying', 'destroyed', 'failed',
]);

/**
 * A status the contract does not know is reported as `failed`, not dropped and
 * not passed through. The column is CHECK-constrained, so this can only fire
 * on a node reading a newer database than its own build — and the honest
 * answer there is "something is wrong with this container", never a value the
 * client's exhaustive switch will fall through.
 */
function ctrStatusOf(raw: string | null): ContainerStatus {
  if (raw && CONTAINER_STATUSES_SET.has(raw as ContainerStatus)) return raw as ContainerStatus;
  return 'failed';
}

function ctrProfileOf(raw: string | null): ContainerProfile {
  const known: ContainerProfile[] = ['shell', 'desktop', 'browser', 'android', 'ios', 'dind', 'custom'];
  return known.includes(raw as ContainerProfile) ? (raw as ContainerProfile) : 'custom';
}

function ctrIsolationOf(raw: string | null): ContainerIsolationClass {
  const known: ContainerIsolationClass[] = ['process', 'container', 'gvisor', 'microvm', 'vm'];
  // `process` is the WEAKEST class, so an unknown value degrades to claiming
  // the least isolation rather than the most. A wrong guess upward would tell
  // a reader their container is more contained than it is.
  return known.includes(raw as ContainerIsolationClass) ? (raw as ContainerIsolationClass) : 'process';
}

function ctrSurfacesOf(raw: unknown): ContainerSurfaceKind[] {
  const known: ContainerSurfaceKind[] = ['terminal', 'screen', 'browser', 'adb', 'docker', 'http'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is ContainerSurfaceKind => known.includes(k as ContainerSurfaceKind));
}

function ctrShareModeOf(raw: string | null): ContainerShareMode {
  return raw === 'space' || raw === 'explicit' ? raw : 'none';
}

function ctrLifecycleOf(raw: Record<string, unknown> | null): ContainerLifecycle {
  const row = raw ?? {};
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    ephemeral: row.ephemeral !== false,
    ttlSeconds: num(row.ttlSeconds),
    idleHibernateSeconds: num(row.idleHibernateSeconds),
    graceSeconds: typeof row.graceSeconds === 'number' ? row.graceSeconds : 600,
    snapshotOnStop: row.snapshotOnStop === true,
  };
}

function ctrSpecOf(raw: Record<string, unknown> | null, profile: ContainerProfile): ContainerSpec {
  const row = (raw ?? {}) as Partial<ContainerSpec>;
  return {
    profile: row.profile ?? profile,
    ...(row.image !== undefined ? { image: row.image } : {}),
    cpus: typeof row.cpus === 'number' ? row.cpus : 1,
    memMiB: typeof row.memMiB === 'number' ? row.memMiB : 1024,
    ...(row.diskMiB !== undefined ? { diskMiB: row.diskMiB } : {}),
    // Guest-only by construction: the door never writes a host path into
    // `spec`, and this read would carry one to the client if it did (R5).
    mounts: Array.isArray(row.mounts)
      ? row.mounts.map((m: { guest?: unknown; ro?: unknown }) => ({
        guest: String(m.guest ?? ''), ro: m.ro === true,
      }))
      : [],
    env: (row.env ?? {}) as Record<string, string>,
    ports: Array.isArray(row.ports) ? row.ports : [],
    network: row.network ?? { preset: 'balanced', allow: [] },
    surfaces: row.surfaces ?? {},
    labels: (row.labels ?? {}) as Record<string, string>,
  };
}

function ctrUsageOf(raw: Record<string, unknown> | null): ContainerUsage | null {
  // NULL IS A MEASURED ABSENCE — no heartbeat has landed — and renders
  // nothing. Defaulting to zeros would draw an idle machine.
  if (!raw) return null;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return { cpuPct: num(raw.cpuPct), memMiB: num(raw.memMiB), diskMiB: num(raw.diskMiB) };
}

function ctrExposedOf(raw: unknown): Array<{ port: number; url: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is { port: number; url: string } =>
      typeof r === 'object' && r !== null && typeof (r as { port?: unknown }).port === 'number')
    .map((r) => ({ port: r.port, url: String(r.url ?? '') }));
}

function ctrSurfaceDetailOf(
  surfaces: ContainerSurfaceKind[],
  live: boolean,
): Partial<Record<ContainerSurfaceKind, { live: boolean }>> {
  // PARTIAL by design: a container with no adb surface omits the key rather
  // than carrying a fake one, so every consumer must guard.
  const detail: Partial<Record<ContainerSurfaceKind, { live: boolean }>> = {};
  for (const kind of surfaces) detail[kind] = { live };
  return detail;
}

export const ENTITY_FROM = `
  from public.entities e
  left join public.entity_counters ec on ec.entity_id = e.id
  left join public.tasks t            on t.entity_id  = e.id
  left join public.documents d        on d.entity_id  = e.id
  left join public.channels ch        on ch.entity_id = e.id
  left join public.voice_channels vc  on vc.entity_id = e.id
  left join public.members mem        on mem.entity_id = e.id
  left join public.team_members tm    on tm.entity_id = e.id
  left join public.collections col    on col.entity_id = e.id
  left join public.work_sessions ws   on ws.entity_id = e.id
  left join lateral (
    select pin.pin_revision, pin.template_key, pin.template_version, pin.resolved_snapshot
      from public.work_session_interaction_pins pin
     where pin.work_session_id = ws.entity_id
     order by pin.pin_revision desc
     limit 1
  ) wsp on true
  left join public.messages msg       on msg.entity_id = e.id
  left join public.files f            on f.entity_id  = e.id
  left join public.project_projection_details ppd on ppd.entity_id = e.id
  left join public.interaction_profiles ip        on ip.entity_id  = e.id
  left join public.interaction_profile_versions profile_version
    on profile_version.profile_id = ip.entity_id
   and profile_version.version = coalesce(ip.active_version, ip.current_draft_version)
  left join public.memories memo         on memo.entity_id = e.id
  left join public.worktrees wt          on wt.entity_id = e.id
  left join public.loops lp              on lp.entity_id = e.id
  left join public.chats cht             on cht.entity_id = e.id
  -- The turn QUEUE, folded to one row. A chat's list tile has to say "busy"
  -- without a second read, and the busy fact is not on the chats row:
  -- runtime_state is about the headless child, not about whether anything is
  -- waiting for it. A lateral aggregate keeps this one query, not an N+1.
  left join lateral (
    select
      case
        when count(*) filter (where t.state = 'running') > 0 then 'running'
        when count(*) filter (where t.state = 'queued') > 0 then 'queued'
        else 'idle'
      end as turn_state,
      count(*)::int as turn_count,
      max(t.queued_at) as last_turn_at
      from public.chat_turns t
     where t.chat_id = cht.entity_id
  ) chq on cht.entity_id is not null
  left join public.graphs gr             on gr.entity_id = e.id
  left join public.pull_requests pr      on pr.entity_id = e.id
  left join public.artifacts art         on art.entity_id = e.id
  left join public.artifact_bundle_revisions arev on arev.id = art.current_revision_id
  left join public.containers ctr        on ctr.entity_id = e.id
  -- Usage is folded in AT READ TIME from the operational side table, which has
  -- no capture_event and no version bump. Heartbeats must never touch the
  -- entity: a 10s periodic UPDATE on the detail row would emit entity.upsert
  -- per container and starve live renames (the migration-165 lesson, §15).
  left join public.container_runtime_state crs on crs.entity_id = e.id
`;
// NOTE what is NOT selected above: `ctr.runtime_ref` and `ctr.host_spec`.
// R5 — `internal.command_entity` (007:36) embeds entity_content in the command
// result a client receives, so anything reachable here reaches the client.
// Native runtime ids and host bind-mount paths stay server-side; they are
// reachable through `containers.providers.list` and `containers.logs`, which
// are node-side reads with their own authorization.

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
  /** 147; optional keeps legacy row fixtures source-compatible. */
  status_category?: string | null;
  likes: number;
  dislikes: number;
  stars: number;
  points: number;
  messages: number;
  human_messages?: number;
  agent_messages?: number;
  /** Link counters (108); optional keeps legacy row fixtures source-compatible. */
  docs?: number;
  memories?: number;
  task_title: string | null;
  task_description: string | null;
  task_axes: Record<string, string> | null;
  work_status: string | null;
  priority: string | null;
  completion_gate: string | null;
  acceptance_criteria: AcceptanceCriterion[] | null;
  points_estimate: number | null;
  due_date: Date | string | null;
  start_date: Date | string | null;
  doc_title: string | null;
  doc_body: string | null;
  doc_format: string | null;
  channel_name: string | null;
  channel_topic: string | null;
  // No topic column: a voice room has no feed, so `name` is all of its content
  // (053 §2). Mirrors the projector's `voice_channel_name`.
  voice_channel_name: string | null;
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
  ws_session_kind: string | null;
  /** Lane facts (107); optional keeps legacy row fixtures source-compatible. */
  ws_checkout_branch?: string | null;
  ws_workdir_mode?: string | null;
  /** Ending facts (171); optional for the same fixture-compatibility reason. */
  ws_ended_kind?: string | null;
  ws_ended_reason?: string | null;
  ws_pin_revision: number | null;
  ws_pin_template_key: string | null;
  ws_pin_template_version: number | null;
  ws_pin_resolved_snapshot: Record<string, unknown> | null;
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
  ppd_name: string | null;
  ppd_project_id: string | null;
  ppd_materialized_version: number | null;
  ip_status: string | null;
  ip_initial_content_surface: string | null;
  ip_current_draft_version: number | null;
  ip_active_version: number | null;
  ip_active_hash: string | null;
  ip_retired_at: Date | string | null;
  /** Versioned authored name; optional keeps legacy row fixtures source-compatible. */
  ip_name?: string | null;
  loop_title: string | null;
  loop_schedule: string | null;
  loop_enabled: boolean | null;
  loop_team_member_id: string | null;
  loop_subject_id: string | null;
  loop_prompt: string | null;
  loop_config: Record<string, unknown> | null;
  loop_next_run_at: Date | string | null;
  loop_last_run_at: Date | string | null;
  loop_last_error: string | null;
  chat_title: string | null;
  chat_teammate_id: string | null;
  chat_model: string | null;
  chat_provider: string | null;
  chat_agent_tool: string | null;
  chat_mode: string | null;
  chat_workdir_mode: string | null;
  chat_project_id: string | null;
  chat_runtime_state: 'cold' | 'live' | 'stopped' | null;
  chat_turn_state: 'idle' | 'queued' | 'running' | null;
  chat_turn_count: number | null;
  chat_last_turn_at: Date | string | null;
  graph_title: string | null;
  graph_type: string | null;
  graph_nodes: unknown[] | null;
  graph_edges: unknown[] | null;
  graph_layout: Record<string, { x: number; y: number }> | null;
  graph_source: string | null;
  memory_statement: string | null;
  memory_mechanism: string | null;
  memory_subject_scope: string | null;
  memory_does_not_establish: string | null;
  memory_measured_at: Date | string | null;
  wt_project_id: string | null;
  wt_path: string | null;
  wt_branch: string | null;
  wt_base_ref: string | null;
  wt_base_commit_oid: string | null;
  wt_status: string | null;
  wt_status_changed_at: Date | string | null;
  // containers (177). NO `ctr_runtime_ref` and NO `ctr_host_spec` — see the
  // note under ENTITY_FROM.
  ctr_status: string | null;
  ctr_profile: string | null;
  ctr_provider: string | null;
  ctr_isolation: string | null;
  ctr_node_id: string | null;
  ctr_image: string | null;
  ctr_spec: Record<string, unknown> | null;
  ctr_lifecycle: Record<string, unknown> | null;
  ctr_surfaces: unknown;
  ctr_share_mode: string | null;
  ctr_started_at: Date | string | null;
  ctr_expires_at: Date | string | null;
  ctr_error: string | null;
  ctr_title: string | null;
  ctr_exposed: unknown;
  ctr_usage: Record<string, unknown> | null;
  /** pull_requests mirror columns; optional keeps legacy row fixtures source-compatible. */
  pr_title?: string | null;
  pr_repo?: string | null;
  pr_number?: number | null;
  pr_state?: string | null;
  pr_ci_status?: string | null;
  pr_mergeable_state?: string | null;
  pr_head_ref?: string | null;
  pr_url?: string | null;
  pr_fetched_at?: Date | string | null;
  artifact_name: string | null;
  artifact_description: string | null;
  artifact_revision_number: number | null;
  artifact_entrypoint: string | null;
  artifact_manifest_sha256: string | null;
  artifact_file_count: number | null;
  artifact_total_size_bytes: string | number | null;
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

/**
 * `work_sessions.ended_kind` (171) narrowed to the contract enum. A value the
 * contract does not know is projected as `null` rather than passed through:
 * the summary state is `.strict()`, so an unrecognised string would fail
 * validation and take the whole entity read down with it — a schema drift on
 * one column must not make a session unreadable.
 */
export function isEndedKind(value: string | null | undefined): value is WorkSessionEndedKind {
  return (
    value === 'completed' ||
    value === 'stopped_by_operator' ||
    value === 'server_restart' ||
    value === 'out_of_memory' ||
    value === 'crashed' ||
    value === 'unknown'
  );
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

/**
 * The 200-char preview every list row, board card and notification shows — and,
 * for a message, the title itself (`events/projector.ts`).
 *
 * The cap is spent on WORDS: `plainExcerpt` strips markdown before truncating,
 * because agents write markdown and 53 of 55 sampled bodies overflow this cap,
 * so raw `**` and `##` were displacing the prose they decorate. The CLI's
 * 72-char `bodyExcerpt` shares that helper — the caps differ on purpose, the
 * rule must not.
 */
function excerpt(body: string | null): string | undefined {
  if (!body) return undefined;
  const flat = plainExcerpt(body, EXCERPT_MAX);
  return flat.length === 0 ? undefined : flat;
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
  session_title: string | null;
}

/**
 * Batch-resolve actor entities to `ActorSummary`.
 *
 * `isAgent` is `kind === 'team_member'` and nothing else — it is the flag the
 * UI uses to tell a human from a persona, so it must not be inferred from a
 * name or a model field that happens to be set.
 *
 * THE SECOND HOP (doc 06 §2.1-2.2). Most `working_on` edges are sourced from
 * a work_session, and this resolver used to collapse those ids to
 * `{kind:'member', displayName:'Member'}` — a false human, minted here, that
 * no renderer downstream could detect. A session id now resolves through
 * `participates_in` to its PERSONA: the summary is the persona's (kind
 * `team_member`, isAgent true), with `via.sessionId` naming the run it acted
 * through. A session with no persona — a human at a terminal; live data, not
 * an edge case — is typed as what it is: `kind:'work_session'`, displayName =
 * the session title. The literal-'Member' fallback dies here, where it was
 * born: THE ENFORCEMENT POINT IS THE RESOLVER, NOT THE COMPONENT.
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
            up.display_name as profile_display_name, up.avatar as profile_avatar,
            ws.title as session_title
       from public.entities e
       left join public.members mem on mem.entity_id = e.id
       left join public.team_members tm on tm.entity_id = e.id
       left join public.user_profiles up on up.identity_id = mem.identity_id
       left join public.work_sessions ws on ws.entity_id = e.id
      where e.id = any($1::uuid[])`,
    [unique],
  );

  // One batched hop, paid only when the page references sessions at all.
  // Several personas can share a session over its life; the most recent
  // `participates_in` edge wins — attribution follows who is acting now.
  const sessionIds = rows.filter((r) => r.kind === 'work_session').map((r) => r.id);
  const personaOf = new Map<
    string,
    { persona_id: string; name: string | null; avatar: string | null; owner_member_id: string | null }
  >();
  if (sessionIds.length > 0) {
    const personaRows = await q.query<{
      session_id: string;
      persona_id: string;
      name: string | null;
      avatar: string | null;
      owner_member_id: string | null;
    }>(
      `select distinct on (pe.dst_id)
              pe.dst_id as session_id, pe.src_id as persona_id,
              tm.name, tm.avatar, tm.owner_member_id
         from public.edges pe
         join public.team_members tm on tm.entity_id = pe.src_id
        where pe.type = 'participates_in' and pe.dst_id = any($1::uuid[])
        order by pe.dst_id, pe.created_at desc`,
      [sessionIds],
    );
    for (const p of personaRows) personaOf.set(p.session_id, p);
  }

  for (const row of rows) {
    if (row.kind === 'work_session') {
      const persona = personaOf.get(row.id);
      // The MAP KEY stays the referencing id (the edge names the session);
      // the summary's OWN id is the persona's, so colour/identity aggregate
      // per person across every run they act through.
      out.set(
        row.id,
        persona
          ? {
              id: persona.persona_id,
              kind: 'team_member',
              displayName: persona.name ?? 'Agent',
              avatar: persona.avatar,
              role: null,
              ...(persona.owner_member_id ? { ownerMemberId: persona.owner_member_id } : {}),
              isAgent: true,
              via: { sessionId: row.id },
            }
          : {
              id: row.id,
              kind: 'work_session',
              displayName: row.session_title || 'Session',
              avatar: null,
              role: null,
              // Not a persona: a run with no participating team_member is a
              // human at a terminal. The kind carries the provenance; lying
              // `isAgent: true` here would dress a person as an agent.
              isAgent: false,
            },
      );
      continue;
    }
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

/**
 * The persona a SESSION id resolves to, or null.
 *
 * `loadActors` already answers this — a session with a `participates_in`
 * persona comes back kinded `team_member`, one without comes back kinded
 * `work_session`. This narrows that to the question a session summary asks:
 * null for "no persona to name", never `unknownActor`, because a run at a
 * human's terminal has no teammate and a placeholder would invent one.
 */
function personaOf(actors: Map<string, ActorSummary>, sessionId: string): ActorSummary | null {
  const actor = actors.get(sessionId);
  return actor && actor.kind === 'team_member' ? actor : null;
}

// ---------------------------------------------------------------------------
// Relations, batched
// ---------------------------------------------------------------------------

export interface EntityRelations {
  /** Aggregate of unresolved attention requests, per entity. */
  attention: Map<string, EntityAttentionSummary>;
  /** `assigned_to` targets, per task. */
  assignees: Map<string, string[]>;
  /** Current assignment edges with their actor/time provenance, per task. */
  assignments: Map<string, Array<{
    assigneeId: string;
    assignedById: string | null;
    assignedAt: string;
  }>>;
  /**
   * `has_member` targets, per channel — the roster (080).
   *
   * Deliberately a SECOND map rather than a reuse of `assignees`. The two carry
   * the same shape and mean different things: an assignee is accountable for a
   * task, a member simply belongs to a channel. Folding them would make
   * `state.assignees` on a channel read as an assignment the node never made.
   */
  members: Map<string, string[]>;
  /** Live child count, per entity. */
  childCounts: Map<string, number>;
  /** Unresolved HARD `depends_on` targets, per entity — the blocked badge. */
  blockedBy: Map<string, string[]>;
  /** `pulled` edges pointing AT the entity. */
  pulls: Map<string, Array<{ actorId: string; props: Record<string, unknown>; at: string }>>;
  /** `working_on` edges pointing AT the entity. */
  workingOn: Map<string, Array<{ actorId: string; props: Record<string, unknown>; at: string }>>;
  /** Latest `completed_by` target per entity — the house-pattern ending. */
  completedBy: Map<string, { actorId: string; at: string }>;
  /** `contains` count, per collection. */
  itemCounts: Map<string, number>;
  /**
   * `defaults_to_profile` target, per teammate — the profile a launch preselects.
   *
   * A SCALAR, not a list, and the database is what makes that safe:
   * `edges_defaults_to_profile_source_idx` (015) is UNIQUE on `src_id` for this
   * type, so a teammate cannot have two. There is no "which one wins" to decide.
   */
  defaultProfiles: Map<string, string>;
  /** Raw mark-edge material for `badges.staleness` — derived in badgesOf, never stored. */
  marks: Map<string, EntityMarks>;
}

/**
 * The mark edges the staleness derivation needs, collected per entity.
 * `disputes`/`verifies` stay raw here because "answered" depends on the
 * entity's CURRENT version, which only badgesOf has; the basis counts are
 * resolved here because they need the pin TARGETS' versions, which only this
 * loader fetches.
 */
export interface EntityMarks {
  /** Immediate successor (latest inbound `supersedes`), with the chain head. */
  superseded: { byId: string; headId: string | null; depthTruncated: boolean } | null;
  /** Inbound `disputes` edges, raw. */
  disputes: Array<{ edgeId: string; at: string }>;
  /** Inbound `verifies` edges, raw. */
  verifies: Array<{ answers: string[]; pinnedVersion: number; at: string; independenceBasis: string }>;
  /** Outbound `based_on`/`copy_of` pins whose target's version moved past the pin. */
  basisMovedCount: number;
  /** Outbound `based_on`/`copy_of` pins pointing at a soft-deleted entity. */
  basisDeletedCount: number;
}

const EMPTY_RELATIONS: EntityRelations = {
  attention: new Map(),
  assignees: new Map(),
  assignments: new Map(),
  members: new Map(),
  childCounts: new Map(),
  blockedBy: new Map(),
  pulls: new Map(),
  workingOn: new Map(),
  completedBy: new Map(),
  itemCounts: new Map(),
  defaultProfiles: new Map(),
  marks: new Map(),
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
    attention: new Map(),
    assignees: new Map(),
    assignments: new Map(),
    members: new Map(),
    childCounts: new Map(),
    blockedBy: new Map(),
    pulls: new Map(),
    workingOn: new Map(),
    completedBy: new Map(),
    itemCounts: new Map(),
    defaultProfiles: new Map(),
    marks: new Map(),
  };

  const edgeRows = await q.query<{
    id: string;
    src_id: string;
    dst_id: string;
    type: string;
    props: Record<string, unknown>;
    created_at: Date | string;
    assigned_by: string | null;
    assigned_at: Date | string | null;
  }>(
    `select id, src_id, dst_id, type, props, created_at, assigned_by, assigned_at
       from public.edges
      where (src_id = any($1::uuid[]) and type in ('assigned_to', 'has_member', 'depends_on', 'based_on', 'copy_of', 'completed_by', 'defaults_to_profile'))
         -- \`contains\` alone filters tombstoned members: itemCount must agree
         -- with every list the UI draws (content.items, connections and
         -- collections.query all exclude deleted endpoints), and the projector
         -- counts with the same predicate. The other relations keep their raw
         -- semantics untouched.
         or (src_id = any($1::uuid[]) and type = 'contains'
             and exists (select 1 from public.entities m where m.id = dst_id and m.deleted_at is null))
         or (dst_id = any($1::uuid[]) and type in ('pulled', 'working_on', 'supersedes', 'disputes', 'verifies'))`,
    [unique],
  );

  const attentionRows = await q.query<{
    entity_id: string;
    pending_count: number;
    total_points: number;
    max_points: number;
    latest_reason: string;
    oldest_requested_at: Date | string;
  }>(
    `select entity_id,
            count(*)::int as pending_count,
            sum(points)::int as total_points,
            max(points)::int as max_points,
            (array_agg(reason order by created_at desc, id desc))[1] as latest_reason,
            min(created_at) as oldest_requested_at
       from public.attention_requests
      where entity_id = any($1::uuid[])
        and status in ('open', 'acknowledged')
      group by entity_id`,
    [unique],
  );
  for (const row of attentionRows) {
    relations.attention.set(row.entity_id, {
      pendingCount: Number(row.pending_count),
      totalPoints: Number(row.total_points),
      maxPoints: Number(row.max_points),
      latestReason: row.latest_reason,
      oldestRequestedAt: iso(row.oldest_requested_at),
    });
  }

  const wanted = new Set(unique);
  const dependsOn: Array<{ src: string; dst: string; hard: boolean }> = [];
  const pins: Array<{ src: string; dst: string; pinnedVersion: number }> = [];
  const supersededBy = new Map<string, { byId: string; at: string }>();
  const marksOf = (id: string): EntityMarks => {
    let m = relations.marks.get(id);
    if (!m) {
      m = { superseded: null, disputes: [], verifies: [], basisMovedCount: 0, basisDeletedCount: 0 };
      relations.marks.set(id, m);
    }
    return m;
  };

  for (const edge of edgeRows) {
    switch (edge.type) {
      case 'assigned_to':
        if (wanted.has(edge.src_id)) {
          push(relations.assignees, edge.src_id, edge.dst_id);
          // 129 backfills assigned_at from the edge's creation time, so every
          // current assignment has a timestamp even when its pre-129 assigner
          // is unknowable (assigned_by = NULL).
          push(relations.assignments, edge.src_id, {
            assigneeId: edge.dst_id,
            assignedById: edge.assigned_by,
            assignedAt: iso(edge.assigned_at ?? edge.created_at),
          });
        }
        break;
      case 'has_member':
        if (wanted.has(edge.src_id)) push(relations.members, edge.src_id, edge.dst_id);
        break;
      case 'completed_by': {
        // Latest wins: completion writes one edge per completer, and the
        // badge is a single header line, not a roster.
        if (!wanted.has(edge.src_id)) break;
        const at = iso(edge.created_at);
        const prior = relations.completedBy.get(edge.src_id);
        if (!prior || at > prior.at) {
          relations.completedBy.set(edge.src_id, { actorId: edge.dst_id, at });
        }
        break;
      }
      case 'contains':
        if (wanted.has(edge.src_id)) {
          relations.itemCounts.set(edge.src_id, (relations.itemCounts.get(edge.src_id) ?? 0) + 1);
        }
        break;
      /* THE SAME SHAPE AS `contains` ABOVE — a scalar derived from an outbound
         edge, riding the batch query rather than asking per row. `set` rather
         than an accumulate because the type is UNIQUE on `src_id` (015:297);
         if that index were ever dropped this would silently keep the last row
         the query returned, which is why the invariant is named here. */
      case 'defaults_to_profile':
        if (wanted.has(edge.src_id)) relations.defaultProfiles.set(edge.src_id, edge.dst_id);
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
      case 'based_on':
      case 'copy_of':
        if (wanted.has(edge.src_id)) {
          pins.push({
            src: edge.src_id,
            dst: edge.dst_id,
            pinnedVersion: Number(edge.props?.pinnedVersion ?? 0),
          });
        }
        break;
      case 'supersedes':
        if (wanted.has(edge.dst_id)) {
          const at = iso(edge.created_at);
          const prior = supersededBy.get(edge.dst_id);
          // Latest immediate successor wins the `byId` slot; the chain walk
          // below resolves the head independently of which branch this is.
          if (!prior || at > prior.at) supersededBy.set(edge.dst_id, { byId: edge.src_id, at });
        }
        break;
      case 'disputes':
        if (wanted.has(edge.dst_id)) {
          marksOf(edge.dst_id).disputes.push({ edgeId: edge.id, at: iso(edge.created_at) });
        }
        break;
      case 'verifies':
        if (wanted.has(edge.dst_id)) {
          const answers = Array.isArray(edge.props?.answers)
            ? (edge.props.answers as unknown[]).filter((a): a is string => typeof a === 'string')
            : [];
          marksOf(edge.dst_id).verifies.push({
            answers,
            pinnedVersion: Number(edge.props?.pinnedVersion ?? 0),
            at: iso(edge.created_at),
            independenceBasis: String(edge.props?.independenceBasis ?? 'actor'),
          });
        }
        break;
      default:
        break;
    }
  }

  // The tense rule (doc 06 §2.3): `workingActors` means "working NOW", but
  // `working_on` cannot express an ending — its propsSchema has no `endedAt`,
  // so edges accumulate forever. Liveness is therefore DERIVED, never stored:
  // a session-sourced edge counts only while its work_session is in a live
  // status. `work_sessions.status` is trustworthy for this — it has an
  // enforced single writer (001:727-746). Person-sourced edges pass through
  // (a person has no status row); a source row this querier cannot see proves
  // nothing, so it does not get the badge. The terminal-task half of the rule
  // lives in badgesOf, where the row is at hand.
  if (relations.workingOn.size > 0) {
    const sourceIds = [
      ...new Set([...relations.workingOn.values()].flat().map((w) => w.actorId)),
    ];
    const sourceRows = await q.query<{ id: string; kind: string; status: string | null }>(
      `select e.id, e.kind, ws.status
         from public.entities e
         left join public.work_sessions ws on ws.entity_id = e.id
        where e.id = any($1::uuid[])
          and e.deleted_at is null`,
      [sourceIds],
    );
    const liveSource = new Map(
      sourceRows.map((r) => [
        r.id,
        r.kind !== 'work_session' ||
          r.status === 'spawning' ||
          r.status === 'running' ||
          r.status === 'idle',
      ]),
    );
    for (const [id, list] of relations.workingOn) {
      const live = list.filter((w) => liveSource.get(w.actorId) === true);
      if (live.length === list.length) continue;
      if (live.length === 0) relations.workingOn.delete(id);
      else relations.workingOn.set(id, live);
    }
  }

  // The two staleness lookups mirror the conditional dependency-target fetch
  // below: batched over the distinct targets, run only when the page produced
  // any mark at all, so a page with no memories pays nothing.
  if (pins.length > 0) {
    const pinTargets = [...new Set(pins.map((p) => p.dst))];
    const targetRows = await q.query<{ id: string; version: number; deleted_at: Date | string | null }>(
      `select id, version, deleted_at from public.entities where id = any($1::uuid[])`,
      [pinTargets],
    );
    const targetById = new Map(targetRows.map((r) => [r.id, r]));
    for (const pin of pins) {
      const target = targetById.get(pin.dst);
      const m = marksOf(pin.src);
      // A target RLS hid or that was hard-deleted out from under the pin is a
      // gone basis, not a live one.
      if (!target || target.deleted_at !== null) m.basisDeletedCount += 1;
      // A deleted basis can ALSO have moved — both reasons fire (design §3.3:
      // precedence orders display; it never hides).
      if (target && pin.pinnedVersion > 0 && pin.pinnedVersion < target.version) {
        m.basisMovedCount += 1;
      }
    }
  }

  if (supersededBy.size > 0) {
    // One recursive walk for the whole page, bounded at depth 32. The bound is
    // required regardless of the write-side cycle guard: prevent_edge_cycle's
    // own CTE bounds at 256, so a longer chain can exist without detection.
    // Hitting the bound reports headId null rather than a wrong head.
    const chainRows = await q.query<{ origin: string; head: string; depth: number }>(
      `with recursive chain as (
         select e.dst_id as origin, e.src_id as head, 1 as depth
           from public.edges e
          where e.type = 'supersedes' and e.dst_id = any($1::uuid[])
         union all
         select c.origin, e.src_id, c.depth + 1
           from chain c
           join public.edges e on e.type = 'supersedes' and e.dst_id = c.head
          where c.depth < 32
       )
       select distinct on (origin) origin, head, depth
         from chain
        order by origin, depth desc, head`,
      [[...supersededBy.keys()]],
    );
    const headByOrigin = new Map(chainRows.map((r) => [r.origin, r]));
    for (const [id, { byId }] of supersededBy) {
      const walk = headByOrigin.get(id);
      const truncated = (walk?.depth ?? 1) >= 32;
      marksOf(id).superseded = {
        byId,
        headId: truncated ? null : (walk?.head ?? byId),
        depthTruncated: truncated,
      };
    }
  }

  // Resolution is asked of the database rather than reimplemented here, where
  // the two definitions could drift. Since phase 5 (migration 152) the rule is
  // UNIVERSAL — `status_category = 'done'` for every kind, with `pull_request`
  // overridden to the forge's merged state — so this predicate now answers for
  // docs, sessions and the other eighteen as well as for tasks. It is the same
  // one call it always was, which is exactly why that widening needed no edit
  // here.
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

/**
 * Per-viewer unread message counts, per anchor.
 *
 * Delegates to `public.unread_counts` (016:47) rather than re-deriving the
 * predicate here, because "unread" must have exactly ONE definition: this is
 * the same function `spaces.navigation` already calls for the channel tree
 * (handlers/spaces.ts), and a second implementation would let the nav badge and
 * the channel itself disagree about the same number. Re-deriving it locally is
 * also not available: the predicate compares `entity_id` against
 * `internal.uuid_at(last_read_at)`, and `internal` functions are granted to
 * `tm8_app` one at a time (047, 070) — `uuid_at` is not among them.
 *
 * The function is SECURITY DEFINER and resolves the viewer from the
 * TRANSACTION CLAIMS (`internal.current_member_id` → `internal.identity_id`),
 * not from a parameter, so it reports the caller's own unread on both the
 * facade and the projector path. It already excludes the viewer's own messages
 * and re-checks `entity_readable` on both the message and its anchor.
 *
 * Only anchors WITH unread appear in the result (it is a `group by`), so a
 * missing key means zero — which is a true zero, unlike the hardcoded one this
 * replaced.
 */
export async function loadUnreadCounts(
  q: Querier,
  // Structural, not `EntityRow`: the projector assembles from its own row type
  // and must resolve this from the same place, or the two paths diverge.
  rows: readonly { kind: string; space_id: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // Scoped to channels: they are the only kind whose state carries a count, and
  // this keeps the extra round-trip off every read that renders no channel.
  const spaceIds = [
    ...new Set(rows.filter((r) => r.kind === 'channel').map((r) => r.space_id).filter(Boolean)),
  ];
  if (spaceIds.length === 0) return out;

  for (const spaceId of spaceIds) {
    // Sequential for the same reason the assembler is: one pooled client.
    const unreadRows = await q.rpc<Array<{ anchor_id: string; unread: number }>>('unread_counts', [
      spaceId,
    ]);
    for (const row of unreadRows) out.set(row.anchor_id, Number(row.unread));
  }
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
    case 'voice_channel':
      // Same rule as `channel` above: the bare name, no '🔊'. The detail row is
      // written in the same statement as the envelope (053 §5), so the fallback
      // only ever covers a hypothetical stray row.
      return row.voice_channel_name ?? 'voice channel';
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
    // The two arms below MIRROR the landed projector twins (projector.ts
    // titleOf, commit 378e167). Parity is the point: a title that differs
    // between the event feed and the read path is drift a client can see.
    case 'project':
      return row.ppd_name ?? '';
    case 'interaction_profile':
      // Profile names are versioned with the draft, not copied into the entity
      // envelope. Project the active/current version so list reads never make
      // the browser invent a label from an id. A legacy row with no matching
      // version remains honestly unnamed.
      return row.ip_name ?? '';
    case 'memory':
      // Title is DERIVED from the statement, never separately settable — a
      // free-standing title would be a restatement with no back-link (design
      // §3.1). Same 120-char bound as the projector twin.
      return (row.memory_statement ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Memory';
    case 'loop':
      // A loop carries its own title on its detail row — MIRRORS the projector
      // twin. `entities` has no title column, so an unnamed loop must fall back
      // to something a human can read rather than to an id (L3).
      return row.loop_title ?? 'Loop';
    case 'graph':
      // Its own detail-row title — MIRRORS the projector twin (same reason).
      return row.graph_title ?? 'Graph';
    case 'chat':
      // The chat's own title, which `start_chat` seeds from the opening message.
      // An empty one is legal (the column defaults to '') and must still render
      // as something a human can read, never as an id (L3).
      return row.chat_title && row.chat_title.length > 0 ? row.chat_title : 'Chat';
    case 'container':
      // Its own detail-row title — MIRRORS the projector twin, the same way
      // graph and artifact do.
      return row.ctr_title ?? 'Container';
    case 'worktree':
      // The branch IS the human name of a worktree; paths are server-computed
      // noise and ids are forbidden as titles (L3).
      return row.wt_branch ?? 'Worktree';
    case 'artifact':
      // The artifact's own name — MIRRORS the projector twin. The detail row is
      // written atomically with the first revision (055), so the fallback only
      // covers a hypothetical stray envelope.
      return row.artifact_name ?? 'Artifact';
    case 'pull_request': {
      // MIRRORS the projector twin: the PR's own title, else the repo#number
      // slug — never the raw kind string this arm used to fall through to
      // (frozen legacy gap, healed by the 084 forge observer wave).
      const repo = row.pr_repo ?? null;
      return row.pr_title ?? (repo !== null ? `${repo}#${String(row.pr_number ?? 0)}` : '');
    }
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
    case 'memory':
      // The statement reaches summaries through the excerpt; the scope fields
      // ride in `state` — together they are the §3.1 thesis: a summary carries
      // claim and conditions in one payload.
      return excerpt(row.memory_statement);
    case 'artifact':
      // The description is the artifact's body text — MIRRORS the projector twin.
      return excerpt(row.artifact_description);
    case 'loop':
      // The schedule is the one fact that makes a loop legible in a list: what
      // it does is the prompt, but WHEN is what distinguishes two of them.
      return excerpt(row.loop_schedule);
    case 'graph':
      // The type is what makes a graph legible in a list — an orchestratable
      // blueprint and a mermaid sketch answer to different intents.
      return excerpt(row.graph_type);
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
  humanMessageAuthors?: Map<string, HumanMessageAuthorIds>;
  /** Per-viewer unread message counts, per anchor. Absent key means zero. */
  unreadCounts?: Map<string, number>;
  /**
   * Tracked pull requests, per task — the material for `badges.pullRequests`.
   *
   * Optional for the same reason `unreadCounts` is: the first assembly pass
   * builds the bare summaries the badges NEST (a `workingActors[].task`), and
   * those must not recurse into a second round of badge material.
   */
  pullRequests?: Map<string, LinkedPullRequestBadges>;
  /** Summaries of related entities (dependency targets, working-on tasks). */
  related?: Map<string, EntitySummary>;
}

/** The profile status enum, defaulted rather than trusted (projector's oneOf). */
function ipStatusOf(raw: string | null): 'draft' | 'active' | 'retired' {
  return raw === 'active' || raw === 'retired' ? raw : 'draft';
}

/** The worktree status enum, defaulted rather than trusted (same posture as ipStatusOf). */
function wtStatusOf(raw: string | null): 'active' | 'merged' | 'abandoned' | 'deleted' {
  return raw === 'merged' || raw === 'abandoned' || raw === 'deleted' ? raw : 'active';
}

/**
 * The draft's surface choice, as a spreadable fragment. A draft written before
 * `initialContentSurface` existed has no opinion, and the ABSENT key is the
 * honest encoding of that — emitting a guessed 'chat' here is exactly the lie
 * the launch picker used to tell, where a hardcoded constant made every profile
 * advertise Chat regardless of what it actually did.
 */
function surfaceOf(raw: string | null): { initialContentSurface?: 'terminal' | 'chat' } {
  return raw === 'terminal' || raw === 'chat' ? { initialContentSurface: raw } : {};
}

/**
 * Exported alongside its twin `contentOf` so the per-kind arms can be tested
 * directly. Without it a state arm is only reachable through a full assembly,
 * which needs a populated `AssemblyContext` — and a test that builds one is
 * testing assembly, not the arm.
 */
export function stateOf(row: EntityRow, ctx: AssemblyContext): EntityState {
  switch (row.kind) {
    case 'task':
      return {
        kind: 'task',
        // Raises rather than casting. This was `(row.work_status ?? 'open') as
        // WorkStatus` — an UNCHECKED cast, while the event path had already
        // been made to raise on the same value (phase 0). The two paths
        // disagreeing about a drifted status is worse than either posture, and
        // the loud one is the ruled direction: see `facade/status.ts`.
        status: narrowWorkStatus(row.work_status, row.id),
        priority: (row.priority ?? 'medium') as 'low' | 'medium' | 'high' | 'urgent',
        axes: row.task_axes ?? {},
        dueDate: dateOnly(row.due_date),
        startDate: dateOnly(row.start_date),
        assignees: (ctx.relations.assignees.get(row.id) ?? []).map((id) => actorOf(ctx.actors, id)),
        assignments: (ctx.relations.assignments.get(row.id) ?? []).map((assignment): TaskAssignment => ({
          assignee: actorOf(ctx.actors, assignment.assigneeId),
          assignedBy: assignment.assignedById === null
            ? null
            : actorOf(ctx.actors, assignment.assignedById),
          assignedAt: assignment.assignedAt,
        })),
        acceptance: acceptanceOf(row),
        completionGate: row.completion_gate === 'pr_merged' ? 'pr_merged' : 'none',
      };
    case 'channel':
      return {
        kind: 'channel',
        topic: row.channel_topic ?? '',
        // The roster, from `has_member` (080). Batched with every other
        // relation, so a channel list costs no extra query per row.
        members: (ctx.relations.members.get(row.id) ?? []).map((id) => actorOf(ctx.actors, id)),
        // Real, per-viewer, from `public.unread_counts` (016:47) — see
        // loadUnreadCounts. A missing key is a genuine zero (the RPC groups,
        // so it only returns anchors that HAVE unread), not the "not built"
        // zero this used to report. MIRRORED by the projector twin so the read
        // path and the event feed agree.
        unreadCount: ctx.unreadCounts?.get(row.id) ?? 0,
        workingAgentCount: (ctx.relations.workingOn.get(row.id) ?? []).length,
      };
    case 'voice_channel':
      return {
        kind: 'voice_channel',
        // 0 here, always — NOT a "not batched yet" 0 like unreadCount above.
        // The roster is ephemeral by construction (voice/roster.ts, 053's
        // header): it lives in this process's memory, is rebuilt from LiveKit
        // webhooks, and is in no table. This file is a pure SELECT assembler,
        // so there is no query that could produce the live count, and the
        // projector twin reports 0 for the same reason — the read path and the
        // event feed agree. Live counts reach clients over the voice roster
        // events instead.
        participantCount: 0,
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
        redactedAt: isoOrNull(row.message_redacted_at),
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
        // `null`, never omitted: the field's contract is that absence MEANS
        // "no default of its own", so a teammate that genuinely has none must
        // say so rather than look like a row that forgot to carry the answer.
        defaultProfileId: ctx.relations.defaultProfiles.get(row.id) ?? null,
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
        // OMITTED, never defaulted, when the column has no value: the DTO
        // makes absence mean `agent`, so a node whose rows predate 082 keeps
        // the pre-082 behaviour instead of being told they are all agents by
        // a server that never looked. `.strict()` refuses an explicit
        // `undefined` key, hence the spread rather than a ternary value.
        ...(row.ws_session_kind ? { sessionKind: row.ws_session_kind as WorkSessionKind } : {}),
        // The lane facts (107). `checkoutBranch` is nullable-and-present:
        // an explicit null is "measured absence / never captured — render no
        // claim", while a missing KEY would mean "server too old to know the
        // field exists". `workdirMode` is projected only when the column
        // holds one of its three CHECK values — the enum is the contract.
        checkoutBranch: row.ws_checkout_branch ?? null,
        ...(row.ws_workdir_mode === 'project' ||
        row.ws_workdir_mode === 'worktree' ||
        row.ws_workdir_mode === 'scratch'
          ? { workdirMode: row.ws_workdir_mode }
          : {}),
        // The ending facts (171), projected exactly like the lane facts above:
        // nullable-and-present, so an explicit null reads as "no ending was
        // recorded" and never as a default. `endedKind` is projected only when
        // the column holds one of its CHECK values — the enum is the contract,
        // and a row carrying something else is a bug to surface, not to render.
        endedKind: isEndedKind(row.ws_ended_kind) ? row.ws_ended_kind : null,
        endedReason: row.ws_ended_reason ?? null,
        // The persona, via the SAME resolver that attributes this session's
        // messages — `loadActors` keyed by the session's own id already does
        // the `participates_in` hop. A session with no persona resolves to a
        // `work_session`-kinded summary there, and that is the honest null
        // here: no teammate to name, not a teammate we failed to look up.
        teammate: personaOf(ctx.actors, row.id),
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
    // The two arms below MIRROR the landed projector twins (projector.ts
    // stateOf, commit 378e167) — the facade's side of the same defect: both
    // kinds sat in the frozen contract while falling through to the custom
    // arm, whose `c:*`-shaped state fails the strict schema for a core kind.
    case 'project':
      return {
        kind: 'project',
        // The detail row is written atomically with the projection entity
        // (021); the fallbacks keep a hypothetical stray row readable
        // instead of failing the strict schema on a null.
        projectId: row.ppd_project_id ?? row.id,
        materializedVersion: row.ppd_materialized_version ?? 1,
      };
    case 'interaction_profile':
      return {
        kind: 'interaction_profile',
        status: ipStatusOf(row.ip_status),
        currentDraftVersion: row.ip_current_draft_version ?? 1,
        activeVersion: row.ip_active_version,
        activeHash: row.ip_active_hash,
        retiredAt: isoOrNull(row.ip_retired_at),
        ...surfaceOf(row.ip_initial_content_surface),
      };
    case 'memory':
      // The scope columns are NOT NULL in the DDL; the fallbacks keep a
      // hypothetical stray row readable instead of failing the strict schema.
      return {
        kind: 'memory',
        mechanism: row.memory_mechanism ?? '',
        subjectScope: row.memory_subject_scope ?? '',
        doesNotEstablish: row.memory_does_not_establish ?? '',
        measuredAt: isoOrNull(row.memory_measured_at),
      };
    case 'loop':
      // `teamMemberId: null` is a VALUE, not a gap: it means the firing routes
      // through the dispatcher. Coalescing it to '' here would erase the whole
      // distinction the executor branches on.
      return {
        kind: 'loop',
        schedule: row.loop_schedule ?? '',
        enabled: row.loop_enabled ?? false,
        teamMemberId: row.loop_team_member_id,
        subjectId: row.loop_subject_id,
        nextRunAt: isoOrNull(row.loop_next_run_at),
        lastRunAt: isoOrNull(row.loop_last_run_at),
        lastError: row.loop_last_error,
      };
    case 'graph':
      // Which type and how big — the vertices/edges are content, not state
      // (they can be large and a list row never needs them).
      return {
        kind: 'graph',
        graphType: row.graph_type ?? 'entity',
        nodeCount: Array.isArray(row.graph_nodes) ? row.graph_nodes.length : 0,
        edgeCount: Array.isArray(row.graph_edges) ? row.graph_edges.length : 0,
      };
    case 'chat':
      // Who it is with, what it is running, and whether it is busy. The two
      // state axes are independent and both are projected: `runtimeState` is the
      // durable claim about the headless child, `turnState` is the queue.
      return {
        kind: 'chat',
        teammateId: row.chat_teammate_id ?? '',
        model: row.chat_model ?? '',
        provider: row.chat_provider ?? '',
        agentTool: row.chat_agent_tool ?? '',
        mode: (row.chat_mode ?? 'ask') as ChatMode,
        workdirMode: (row.chat_workdir_mode ?? 'scratch') as ChatWorkdirMode,
        projectId: row.chat_project_id,
        runtimeState: row.chat_runtime_state ?? 'cold',
        turnState: row.chat_turn_state ?? 'idle',
        turnCount: Number(row.chat_turn_count ?? 0),
        lastTurnAt: isoOrNull(row.chat_last_turn_at),
      };
    case 'container': {
      // Hot and small — this rides EVERY list row, so it carries the surface
      // KINDS that exist and not their detail. `usage` is content, not state.
      const profile = ctrProfileOf(row.ctr_profile);
      return {
        kind: 'container',
        status: ctrStatusOf(row.ctr_status),
        profile,
        provider: row.ctr_provider ?? '',
        isolation: ctrIsolationOf(row.ctr_isolation),
        nodeId: row.ctr_node_id ?? '',
        surfaces: ctrSurfacesOf(row.ctr_surfaces),
        ephemeral: ctrLifecycleOf(row.ctr_lifecycle).ephemeral,
        shareMode: ctrShareModeOf(row.ctr_share_mode),
        startedAt: isoOrNull(row.ctr_started_at),
        expiresAt: isoOrNull(row.ctr_expires_at),
      };
    }
    case 'worktree':
      // SEMANTIC lifecycle only. Operational disk health lives in
      // worktree_allocations, which is deliberately not on this read: state
      // must never look like status (worktree design §3).
      return {
        kind: 'worktree',
        status: wtStatusOf(row.wt_status),
        branch: row.wt_branch ?? '',
        baseRef: row.wt_base_ref ?? '',
        baseCommitOid: row.wt_base_commit_oid ?? '',
        projectId: row.wt_project_id ?? '',
      };
    case 'artifact':
      // Publish drives version advancement; the summary carries the CURRENT
      // bundle revision number — MIRRORS the projector twin. The fallback of 1
      // keeps a hypothetical stray envelope (no revision joined) readable
      // instead of failing the strict schema on a null.
      return { kind: 'artifact', revisionNumber: row.artifact_revision_number ?? 1 };
    case 'pull_request': {
      // MIRRORS the projector twin and the connections read
      // (`projects-associations.ts` artifactSummary) FIELD FOR FIELD, through
      // the ONE shared mapper — graph.query, the event feed and the
      // connections door must serve the same forge facts under the same
      // names, or chips render from whichever door happened to answer.
      const fetched = row.pr_fetched_at ?? null;
      return {
        kind: 'pull_request',
        repository: row.pr_repo ?? '',
        number: Number(row.pr_number ?? 0),
        state: row.pr_state ?? 'open',
        ...(row.pr_url ? { url: row.pr_url } : {}),
        fetchedAt: isoOrNull(fetched),
        // `stale` is "the mirror is older than the upstream". Never fetched ⇒
        // definitionally stale — same ruling as the projector twin.
        stale: fetched === null,
        ...projectForgeFacts(row.pr_ci_status, row.pr_mergeable_state, row.pr_head_ref),
      };
    }
    default:
      // A custom `c:*` kind. Its scalar fields live in `custom_entities` and
      // are out of the G1A slice, so the shape is honest and empty rather than
      // invented.
      return { kind: row.kind as `c:${string}`, fields: {} };
  }
}

function badgesOf(row: EntityRow, ctx: AssemblyContext): EntityBadges {
  const badges: EntityBadges = {};

  const humanAuthors = ctx.humanMessageAuthors?.get(row.id);
  if (humanAuthors && humanAuthors.total > 0) {
    badges.humanMessageAuthors = {
      actors: humanAuthors.ids.map((id) => actorOf(ctx.actors, id)),
      total: humanAuthors.total,
    };
  }

  const attention = ctx.relations.attention?.get(row.id);
  if (attention) badges.attention = attention;

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
        status: (pull.props.status as string | null | undefined) ?? null,
        pulledAt,
      };
    });
  }

  const working = ctx.relations.workingOn.get(row.id) ?? [];
  // The other half of the §2.3 tense rule: an entity that has STOPPED is not
  // being worked on, whatever its edges say. Past tense ("Worked on by") is a
  // detail-panel aggregation, never a tile badge.
  //
  // PHASE 9: this reads the CATEGORY, not two task status literals and a kind
  // check. It used to be `row.kind === 'task' && work_status in (done,
  // cancelled)`, which was three assumptions at once — that only tasks stop,
  // that stopping is spelled by those two words, and that a custom status
  // meaning "shipped" is still in flight. `status_category` answers all three
  // for every kind, and `done`/`cancelled` are the closed pair that means
  // stopped. A row with NO category has not stopped; it has no status at all.
  const stopped = row.status_category === 'done' || row.status_category === 'cancelled';
  if (working.length > 0 && !stopped && ctx.related) {
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

  // The PRs this task tracks, carried ON THE ROW. Unlike every other badge
  // here, this one does not summarize the entity's own state — it projects a
  // NEIGHBOUR's facts inward, because the client's edge projection re-hydrates
  // from a bounded graph page and a freshly linked PR loses that lottery
  // routinely. See `LinkedPullRequestBadge` for the measurement.
  //
  // Emitted only when there is something to say: an absent field means NO
  // CLAIM (a rolling node, or the bare first assembly pass), never "this task
  // links no PRs" — so a reader can still fall back to the graph.
  const linkedPullRequests = ctx.pullRequests?.get(row.id);
  if (linkedPullRequests && linkedPullRequests.items.length > 0) {
    badges.pullRequests = linkedPullRequests.items;
    if (linkedPullRequests.truncated) badges.pullRequestsTruncated = true;
  }

  const completion = ctx.relations.completedBy.get(row.id);
  if (completion) {
    badges.completedBy = { actor: actorOf(ctx.actors, completion.actorId), at: completion.at };
  }

  if (row.visibility === 'restricted') badges.restricted = true;

  const staleness = stalenessOf(row, ctx.relations.marks.get(row.id));
  if (staleness) badges.staleness = staleness;

  return badges;
}

/**
 * `badges.staleness`, derived from mark edges and versions at read time —
 * never stored, exactly like `contentStale` and `attention` above.
 *
 * ABSENT MEANS UNFLAGGED, never "verified" or "current": an entity nobody has
 * examined must not acquire false authority. The badge exists only when at
 * least one reason applies; `reasons: []` is never emitted. Display precedence
 * (superseded > disputed > basisDeleted > basisMoved) ORDERS the array — it
 * never hides a reason.
 */
function stalenessOf(row: EntityRow, marks: EntityMarks | undefined): EntityStaleness | undefined {
  if (!marks) return undefined;

  // A dispute is open until a verifying edge names it in `answers` AND pins
  // the entity's CURRENT version — a clear of version N stops clearing the
  // moment the content moves to N+1.
  const openDisputes = marks.disputes.filter(
    (d) => !marks.verifies.some(
      (v) => v.pinnedVersion === row.version && v.answers.includes(d.edgeId),
    ),
  );

  const reasons: EntityStaleness['reasons'] = [];
  if (marks.superseded) reasons.push('superseded');
  if (openDisputes.length > 0) reasons.push('disputed');
  if (marks.basisDeletedCount > 0) reasons.push('basisDeleted');
  if (marks.basisMovedCount > 0) reasons.push('basisMoved');
  if (reasons.length === 0) return undefined;

  const latestVerify = marks.verifies.reduce<EntityMarks['verifies'][number] | null>(
    (best, v) => (best === null || v.at > best.at ? v : best),
    null,
  );

  return {
    reasons,
    ...(marks.superseded ? { superseded: marks.superseded } : {}),
    ...(openDisputes.length > 0
      ? {
          disputed: {
            openCount: openDisputes.length,
            latestAt: openDisputes.reduce((max, d) => (d.at > max ? d.at : max), ''),
          },
        }
      : {}),
    ...(marks.basisDeletedCount > 0 ? { basisDeleted: { count: marks.basisDeletedCount } } : {}),
    ...(marks.basisMovedCount > 0 ? { basisMoved: { count: marks.basisMovedCount } } : {}),
    ...(latestVerify
      ? {
          verified: {
            at: latestVerify.at,
            atVersion: latestVerify.pinnedVersion,
            current: latestVerify.pinnedVersion === row.version,
            independenceBasis:
              latestVerify.independenceBasis === 'session' ? 'session' : 'actor',
          },
        }
      : {}),
  };
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
  // Memory edits are for typos (any edit bumps the version and un-pins every
  // inbound verification); it is editable, never hierarchical, never pullable.
  // Worktree "edit" is exactly one thing — the status transition through
  // update_worktree; every other field is immutable. canEdit mirrors that the
  // patch door will accept SOMETHING, which is the contract of this flag.
  // Work-session "edit" is likewise exactly one thing: the display title, via
  // rename_work_session (085). Everything else on that row belongs to the
  // execution block, which is why it is still not deletable or hierarchical.
  const editable = new Set(['task', 'doc', 'channel', 'collection', 'team_member', 'spell', 'skill', 'memory', 'worktree', 'work_session', 'graph']);
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
    //
    // KEYED ON THE COMPLETION SURFACE, NOT ON A KIND NAME. This read
    // `row.kind === 'task'` for as long as it has existed, which made a
    // structural fact ("does this row have a work status to move to done")
    // into a name check — the shape §15.2 forbids in the client and that has
    // no better claim here. `work_status` is `public.tasks.work_status`,
    // LEFT JOINed: it is non-null exactly for rows that carry a work-status
    // record and null for every other kind, so this is the same set today,
    // arrived at from the row's own surface rather than from its label.
    //
    // It stays in step with `complete_task` for free. That RPC selects
    // `where kind = 'task'` and then reads `public.tasks` — so a row this
    // grants the affordance to is a row that RPC can find, which is the
    // property a name check only had by coincidence.
    //
    // THE LATER PHASE THIS NOTE PROMISED IS HERE, FOR SESSIONS ONLY. This read
    // "does NOT widen completion to sessions or to any other kind"; the second
    // arm widens it to exactly one, because exactly one grew a door (migration
    // 156, `public.set_session_done`) — user ruling 2026-08-19: "i want to mark
    // sessions done, but not close them to revisit later".
    //
    // The arms are deliberately NOT unified into a single `status_category`
    // test, which would read cleaner and would be wrong: it would grant the
    // affordance to every doc, file and member in the space, none of which has
    // a completion door to reach. A flag is a promise that a door will answer.
    //
    // NO `!== 'done'` ON THE SESSION ARM, unlike the task arm beside it. The
    // session tick is a TOGGLE — ticking a done session reopens it — so the
    // affordance is exactly as available in one direction as the other. The
    // task arm keeps its check because `complete_task` has no inverse.
    //
    // `typeof === 'string'` rather than `!== null`: a hand-built row fixture
    // that omits the column would slip past a null check as `undefined` and
    // claim the affordance on a kind that has no work status at all.
    canComplete:
      live &&
      ((typeof row.work_status === 'string' && row.work_status !== 'done') ||
        row.kind === 'work_session'),
  };
}

/**
 * The WHOLE capability rule: the base above, plus the per-kind narrowings.
 *
 * `capabilitiesOf` alone is NOT the answer any surface should render. It is
 * the kind-and-liveness base, and several kinds refuse more than it knows —
 * most importantly `canDelete`, which it grants to everything except `member`
 * while `message`, `work_session`, `project` and `interaction_profile` all
 * genuinely refuse deletion. A caller that renders the base draws an Archive
 * control on four kinds that will bounce it.
 *
 * This lived privately in the w2 service, which is what serves `entities.get`,
 * so the live detail read applied these narrowings and the OTHER detail
 * assembler (`buildDetail`, behind command results) did not — the same entity
 * answered differently depending on which door you came through. Hoisted here,
 * beside the base it wraps, so summary, detail and command result cannot
 * disagree.
 *
 * Takes the ROW, not the assembled summary: it only ever consulted `kind` and
 * `deletedAt`, both of which are the row's own `kind` and `deleted_at`. Reading
 * the row directly is what lets `toEntitySummary` call it while the summary it
 * would otherwise need is still being built.
 */
export function entityCapabilities(row: EntityRow): EntityCapabilities {
  const base = capabilitiesOf(row);
  const live = row.deleted_at === null;
  if (row.kind === 'project' || row.kind === 'interaction_profile') {
    return {
      canEdit: false,
      canDelete: false,
      canAddChild: false,
      canLink: live,
      canPull: false,
      canReact: live,
      canGrantPoints: false,
      canComplete: false,
    };
  }
  if (row.kind === 'message') {
    return { ...base, canEdit: false, canDelete: false, canAddChild: false };
  }
  // A session is still not deletable and has no children — it is born from a
  // spawn and it exits. But its canEdit is now left as `capabilitiesOf`
  // computed it, which since 085 is true for a live session and means exactly
  // one thing: the display title. Forcing it false here would leave the panel
  // dressing the title as locked while the patch door accepts the rename.
  if (row.kind === 'work_session') {
    return { ...base, canDelete: false, canAddChild: false };
  }
  if (row.kind === 'pull_request' || row.kind === 'commit' || row.kind === 'file') {
    return { ...base, canEdit: live };
  }
  if (row.kind.startsWith('c:')) {
    return { ...base, canEdit: live, canAddChild: live, canPull: live };
  }
  if (row.kind === 'container') {
    // The six container verbs (§15), derived from status + share_mode.
    //
    // They GATE THE BUTTON, not the dot. `canAttach` says the viewer is
    // ALLOWED to open the screen; whether pixels are flowing comes from
    // `seam.liveness.statusOf` (R-UI-5) and is a different question.
    //
    // `canDelete` stays false: a container is not deleted, it is DESTROYED,
    // and `entities.delete` refuses the kind. Offering a delete control that
    // the only door for it refuses would be a lie in the UI.
    const status = ctrStatusOf(row.ctr_status);
    const running = status === 'running';
    const surfaces = ctrSurfacesOf(row.ctr_surfaces);
    // `terminal` is reached through `containers.terminal.start`, not through a
    // surface grant — so it does not make a container attachable.
    const attachable = surfaces.some((kind) => kind !== 'terminal');
    return {
      ...base,
      canEdit: live,
      canDelete: false,
      canStart: status === 'stopped',
      canStop: running || status === 'paused',
      canDestroy: live && status !== 'destroying' && status !== 'destroyed',
      canAttach: running && attachable,
      canControl: running && attachable,
      canExec: running,
    };
  }
  return base;
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
    // Spread-when-known, like the 108 counters above it and for the same
    // reason: an entity with no status must OMIT the key rather than claim a
    // bucket. MIRRORED by projector.ts's summary literal.
    ...categoryFragment(row.status_category, row.id),
    counters: {
      likes: row.likes,
      dislikes: row.dislikes,
      stars: row.stars,
      points: row.points,
      messages: row.messages,
      ...(row.human_messages === undefined ? {} : { humanMessages: row.human_messages }),
      ...(row.agent_messages === undefined ? {} : { agentMessages: row.agent_messages }),
      // 108, spread-when-known: a legacy row fixture without the columns
      // omits the keys, which is the contract's "never counted" claim —
      // an invented 0 would be a different (wrong) claim.
      ...(row.docs === undefined ? {} : { docs: row.docs }),
      ...(row.memories === undefined ? {} : { memories: row.memories }),
      viewerReaction: ctx.viewerReactions.get(row.id) ?? null,
    },
    state: stateOf(row, ctx),
    badges: badgesOf(row, ctx),
    // The SAME rule the detail read applies, from the SAME helper — not a fork
    // of it, and deliberately the FULL rule rather than the `capabilitiesOf`
    // base (a base-only projection would promise `canDelete` on the four kinds
    // that refuse deletion, and a tile that hides Archive on server truth would
    // then show it exactly where it bounces).
    //
    // A tile gates its row actions on this. Before it rode the summary, a list
    // row had to wait for a detail read to learn its own permissions — and a
    // COLLAPSED row never gets one, so every capability-gated verb was refused
    // there permanently.
    //
    // Free, and safe: the rule reads only the row already in hand (kind,
    // liveness, work_status), so it adds no query, cannot become an N+1, and
    // cannot widen a viewer's view — the row already cleared RLS to get here.
    capabilities: entityCapabilities(row),
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
      case 'memory':
        return { kind: 'memory', statement: '', mechanism: '', subjectScope: '',
                 doesNotEstablish: '', measuredAt: null };
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
    case 'voice_channel':
      // The contract arm carries nothing but the kind: a voice room has no
      // topic, no pins and no feed to hydrate (053 §2). The name is the title,
      // and the live roster is not content — it arrives over voice events.
      return { kind: 'voice_channel' };
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
        interactionProfile:
          row.ws_pin_revision !== null
          && row.ws_pin_template_key !== null
          && row.ws_pin_template_version !== null
          && row.ws_pin_resolved_snapshot !== null
            ? projectInteractionProfileForBrowser({
                pinRevision: row.ws_pin_revision,
                templateKey: row.ws_pin_template_key,
                templateVersion: row.ws_pin_template_version,
                snapshot: row.ws_pin_resolved_snapshot,
              })
            : null,
      };
    case 'collection':
      return { kind: 'collection', description: row.collection_description ?? '', items: [] };
    case 'memory':
      return {
        kind: 'memory',
        statement: row.memory_statement ?? '',
        mechanism: row.memory_mechanism ?? '',
        subjectScope: row.memory_subject_scope ?? '',
        doesNotEstablish: row.memory_does_not_establish ?? '',
        measuredAt: isoOrNull(row.memory_measured_at),
      };
    case 'loop':
      return {
        kind: 'loop',
        schedule: row.loop_schedule ?? '',
        enabled: row.loop_enabled ?? false,
        teamMemberId: row.loop_team_member_id,
        subjectId: row.loop_subject_id,
        prompt: row.loop_prompt ?? '',
        config: row.loop_config ?? {},
        nextRunAt: isoOrNull(row.loop_next_run_at),
        lastRunAt: isoOrNull(row.loop_last_run_at),
        lastError: row.loop_last_error,
      };
    case 'chat':
      // R5: a chat's working directory and native runtime session id are
      // server-side, and nothing else on the row is content rather than state.
      // The arm exists so the discriminated union is total, and says so.
      return { kind: 'chat' };
    case 'graph':
      // The whole row IS the graph (R1): one read hands a renderer or an
      // orchestrating agent everything. Lean fallbacks keep a hypothetical
      // stray envelope readable rather than failing the strict schema.
      return {
        kind: 'graph',
        graphType: row.graph_type ?? 'entity',
        nodes: (Array.isArray(row.graph_nodes) ? row.graph_nodes : []) as GraphNode[],
        edges: (Array.isArray(row.graph_edges) ? row.graph_edges : []) as GraphEdgeSpec[],
        layout: row.graph_layout ?? {},
        source: row.graph_source,
      };
    case 'container': {
      const status = ctrStatusOf(row.ctr_status);
      const surfaces = ctrSurfacesOf(row.ctr_surfaces);
      const profile = ctrProfileOf(row.ctr_profile);
      return {
        kind: 'container',
        image: row.ctr_image ?? '',
        spec: ctrSpecOf(row.ctr_spec, profile),
        lifecycle: ctrLifecycleOf(row.ctr_lifecycle),
        // A surface is live only while the machine is; a recorded surface on a
        // stopped container is a fact about its shape, not about a pipe.
        surfaceDetail: ctrSurfaceDetailOf(surfaces, status === 'running'),
        error: row.ctr_error ?? null,
        usage: ctrUsageOf(row.ctr_usage),
        exposed: ctrExposedOf(row.ctr_exposed),
      };
    }
    case 'worktree':
      return {
        kind: 'worktree',
        projectId: row.wt_project_id ?? '',
        path: row.wt_path ?? '',
        branch: row.wt_branch ?? '',
        baseRef: row.wt_base_ref ?? '',
        baseCommitOid: row.wt_base_commit_oid ?? '',
        status: wtStatusOf(row.wt_status),
        statusChangedAt: isoOrNull(row.wt_status_changed_at),
      };
    case 'artifact':
      // The CURRENT revision, projected. The bytes are served via preview/export
      // (055 RPCs), never here — this is metadata only. Fallbacks keep a
      // hypothetical stray envelope readable rather than failing the strict
      // schema on a null.
      return {
        kind: 'artifact',
        description: row.artifact_description,
        currentRevisionNumber: row.artifact_revision_number ?? 1,
        entrypoint: row.artifact_entrypoint ?? '',
        manifestSha256: row.artifact_manifest_sha256 ?? '',
        fileCount: row.artifact_file_count ?? 0,
        totalSizeBytes: Number(row.artifact_total_size_bytes ?? 0),
      };
    case 'pull_request': {
      // The contract's content arm for tracking mirrors is an open bag; carry
      // the same projected facts as `stateOf` so a detail read never knows
      // less than a list row. Same shared mapper, same field names.
      const fetched = row.pr_fetched_at ?? null;
      return {
        kind: 'pull_request',
        repository: row.pr_repo ?? '',
        number: Number(row.pr_number ?? 0),
        state: row.pr_state ?? 'open',
        ...(row.pr_url ? { url: row.pr_url } : {}),
        fetchedAt: isoOrNull(fetched),
        stale: fetched === null,
        ...projectForgeFacts(row.pr_ci_status, row.pr_mergeable_state, row.pr_head_ref),
      };
    }
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
  const unreadCounts = await loadUnreadCounts(q, rows);
  // THE SAME loader the events projector calls — see its header for why this
  // is one function and not two twins.
  const pullRequests = await loadLinkedPullRequestBadges(q, rows);
  const humanMessageAuthors = await loadHumanMessageAuthorIds(q, ids);

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
    // A work_session's OWN id, so `loadActors` runs its `participates_in` hop
    // for it and the summary can name the persona behind the run. Free when
    // the page has no sessions; one extra batched query when it does.
    r.kind === 'work_session' ? r.id : '',
  ]);
  for (const list of relations.assignees.values()) actorIds.push(...list);
  for (const list of relations.assignments.values()) {
    for (const assignment of list) {
      actorIds.push(assignment.assigneeId);
      if (assignment.assignedById !== null) actorIds.push(assignment.assignedById);
    }
  }
  for (const list of relations.members.values()) actorIds.push(...list);
  for (const list of relations.pulls.values()) actorIds.push(...list.map((p) => p.actorId));
  for (const list of relations.workingOn.values()) actorIds.push(...list.map((w) => w.actorId));
  for (const completion of relations.completedBy.values()) actorIds.push(completion.actorId);
  for (const authors of humanMessageAuthors.values()) actorIds.push(...authors.ids);

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
  const ctx: AssemblyContext = {
    actors, relations, viewerReactions, unreadCounts, related, pullRequests, humanMessageAuthors,
  };
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
