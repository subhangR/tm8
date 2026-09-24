-- =============================================================================
-- 218 — RLS membership is resolved ONCE per statement, not once per row.
--
-- WHAT THIS CHANGES
--   1. New `internal.member_space_ids()` — SECURITY DEFINER, STABLE — returns
--      the calling identity's space ids as a `uuid[]` ('{}' when
--      `tm8.identity_id` is unset or has no membership).
--   2. Every policy that called `internal.is_space_member(X)` now reads
--      `X = any ((select internal.member_space_ids())::uuid[])`. The scalar sub-select
--      is uncorrelated, so the planner hoists it into an InitPlan: one
--      `members` probe per STATEMENT, then an array compare per row.
--      The `::uuid[]` cast is load-bearing: without it `= any ((select ...))`
--      parses as `= ANY (subquery)` and fails with `uuid = uuid[]`.
--   3. `entities_select` reads the same membership array and keeps the
--      restricted-project carve-out behind `internal.entity_row_visible`,
--      which is now called only for `visibility = 'restricted' and
--      kind = 'project'` rows (the carve-out re-checks membership itself).
--   4. Every policy that called `internal.entity_readable(X)` now reads
--      `exists (select 1 from public.entities readable_entity
--               where readable_entity.id = X and readable_entity.deleted_at is null
--               offset 0)`.
--      That sub-select runs as the caller (`tm8_app`) and is therefore
--      filtered by `entities_select` — which is exactly entity_readable's body
--      minus its `deleted_at is null` conjunct, kept here explicitly.
--      `offset 0` is an optimisation fence, not a semantic change: without it
--      the planner may flatten the exists into a hashed SubPlan that reads
--      every visible entity (~20 k on prod) once per statement per table,
--      which made the collection page query ~3x slower on the prod copy.
--      With it, each exists stays a per-row `entities_pkey` probe.
--   The three functions (`is_space_member`, `entity_readable`,
--   `entity_row_visible`) are NOT changed: SECURITY DEFINER write RPCs still
--   call them as explicit guards, and those callers keep their semantics.
--
-- WHY (prod, 2026-09-24, pg_stat_user_tables diffed over 57 s):
--   `members` (35 rows) took 1 151 965 seq scans / 17.1 M tuples read in that
--   window — ~20 k/s — against 913 673 `entities` index scans. Each is one
--   invocation of a policy helper: all three are `language sql security
--   definer set search_path`, which Postgres can never inline, so a policy
--   calling one runs a full SQL-function executor (plus its `members` probe)
--   for EVERY candidate row. Measured per call on prod data, read-only:
--       internal.is_space_member(space_id)          ~15 us
--       internal.entity_row_visible(...)            ~23 us
--       inline `exists (... members ...)`            ~0.2 us
--   and `members_select` itself calls `is_space_member` per row, so the
--   25-way ENTITY_FROM join's `left join members` costs 35 helper calls
--   (35 more `members` scans) per outer row whenever it is not an index hit.
--
-- WHY THIS IS EQUIVALENT
--   * `is_space_member(X)` = `identity_id() is not null and exists(members m
--     where m.space_id = X and m.identity_id = identity_id())`.
--     `member_space_ids()` = the space ids of exactly those `members` rows
--     (`m.identity_id = identity_id()` matches nothing when the claim is
--     NULL), so `X = any(...)` is true iff the old call was true. The only
--     difference is NULL X: old = false, new = NULL; a policy treats both as
--     deny. Same owner, same search_path, same statement snapshot (a STABLE
--     function already could not see changes made after statement start).
--   * `entity_readable(X)` = exists entity X, not deleted, whose space the
--     caller is a member of, and (visibility = 'space' or the carve-out).
--     `entities_select` supplies everything but the tombstone test; the
--     rewrite adds `deleted_at is null`. Every rewritten entity_readable
--     policy applies TO tm8_app, the role `entities_select` applies to. (The
--     three `{public}` policies rewritten here — space_credentials,
--     space_credential_policies, session_space_credentials — were
--     is_space_member calls; member_space_ids() is SECURITY DEFINER, so that
--     rewrite does not depend on the caller's role.)
--   * Verified before commit on a restored copy of prod (staging cluster,
--     with 216 + 218 applied inside a rolled-back transaction): (count, md5
--     of ctids) for each of the 68 tables tm8_app can SELECT, under each of
--     the 13 identities with memberships plus a stranger and an unset claim
--     = 1020 fingerprints, identical before and after (636 of them non-empty).
--     The 3 credential tables above were not compared: tm8_app has no SELECT
--     grant on them, so no tm8_app query reaches those policies today.
--
-- WHAT IS NOT HERE: other helper call sites (`can_act_as`, `form_is_caller`,
-- `is_node_admin`) — measured cheap or not on a hot path.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.member_space_ids() returns uuid[]
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce(array_agg(m.space_id), '{}'::uuid[])
    from public.members m
   where m.identity_id = internal.identity_id()
$$;

comment on function internal.member_space_ids() is
  'The calling identity''s space ids. RLS policies call it as '
  '`X = any ((select internal.member_space_ids())::uuid[])` so membership is resolved '
  'once per statement (InitPlan), not once per row (218).';

revoke all on function internal.member_space_ids() from public;
grant execute on function internal.member_space_ids() to tm8_app;

alter policy activity_select on public.activity
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy artifact_bundle_entries_select on public.artifact_bundle_entries
  using ((EXISTS ( SELECT 1
   FROM artifact_bundle_revisions r
  WHERE ((r.id = artifact_bundle_entries.revision_id) AND (exists (select 1 from public.entities readable_entity where readable_entity.id = r.artifact_entity_id and readable_entity.deleted_at is null offset 0))))));

alter policy artifact_bundle_revisions_select on public.artifact_bundle_revisions
  using ((internal.is_node_admin() OR (exists (select 1 from public.entities readable_entity where readable_entity.id = artifact_bundle_revisions.artifact_entity_id and readable_entity.deleted_at is null offset 0))));

alter policy artifact_preview_sessions_select on public.artifact_preview_sessions
  using ((internal.is_node_admin() OR (exists (select 1 from public.entities readable_entity where readable_entity.id = artifact_preview_sessions.artifact_entity_id and readable_entity.deleted_at is null offset 0))));

alter policy artifacts_select on public.artifacts
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = artifacts.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy attention_requests_select on public.attention_requests
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = attention_requests.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy channels_select on public.channels
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = channels.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy chat_turns_select on public.chat_turns
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = chat_turns.chat_id and readable_entity.deleted_at is null offset 0)));

alter policy chats_select on public.chats
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = chats.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy collections_select on public.collections
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = collections.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy commits_select on public.commits
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = commits.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy container_exposures_select on public.container_exposures
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = container_exposures.container_entity_id and readable_entity.deleted_at is null offset 0)));

alter policy container_runtime_state_select on public.container_runtime_state
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = container_runtime_state.container_entity_id and readable_entity.deleted_at is null offset 0)));

alter policy containers_select on public.containers
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = containers.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy custom_entities_select on public.custom_entities
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = custom_entities.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy documents_select on public.documents
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = documents.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy drawings_select on public.drawings
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = drawings.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy edges_select on public.edges
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy entities_select on public.entities
  using ((space_id = any ((select internal.member_space_ids())::uuid[]))
    and (visibility = 'space'
         or (visibility = 'restricted' and kind = 'project'
             and internal.entity_row_visible(id, space_id, kind, visibility))));

alter policy entity_counters_select on public.entity_counters
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = entity_counters.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy entity_kinds_select on public.entity_kinds
  using ((((space_id IS NULL) AND (internal.identity_id() IS NOT NULL)) OR (space_id = any ((select internal.member_space_ids())::uuid[]))));

alter policy entity_versions_select on public.entity_versions
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = entity_versions.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy files_select on public.files
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = files.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy form_deliveries_select on public.form_deliveries
  using ((EXISTS ( SELECT 1
   FROM form_responses r
  WHERE ((r.id = form_deliveries.response_id) AND (exists (select 1 from public.entities readable_entity where readable_entity.id = r.form_id and readable_entity.deleted_at is null offset 0)) AND ((r.status = 'submitted'::text) OR internal.form_is_caller(r.respondent_id))))));

alter policy form_notices_select on public.form_notices
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = form_notices.form_id and readable_entity.deleted_at is null offset 0)));

alter policy form_questions_select on public.form_questions
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = form_questions.form_id and readable_entity.deleted_at is null offset 0)));

alter policy form_responses_select on public.form_responses
  using (((exists (select 1 from public.entities readable_entity where readable_entity.id = form_responses.form_id and readable_entity.deleted_at is null offset 0)) AND ((status = 'submitted'::text) OR internal.form_is_caller(respondent_id))));

alter policy form_sections_select on public.form_sections
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = form_sections.form_id and readable_entity.deleted_at is null offset 0)));

alter policy forms_select on public.forms
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = forms.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy graphs_select on public.graphs
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = graphs.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy interaction_profile_versions_select on public.interaction_profile_versions
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = interaction_profile_versions.profile_id and readable_entity.deleted_at is null offset 0)));

alter policy interaction_profiles_select on public.interaction_profiles
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = interaction_profiles.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy jev_calls_insert on public.jev_calls
  with check ((EXISTS ( SELECT 1
   FROM jev_runs r
  WHERE ((r.id = jev_calls.run_id) AND (r.space_id = any ((select internal.member_space_ids())::uuid[])) AND (r.requested_by = internal.identity_id())))));

alter policy jev_calls_select on public.jev_calls
  using ((EXISTS ( SELECT 1
   FROM jev_runs r
  WHERE ((r.id = jev_calls.run_id) AND (r.space_id = any ((select internal.member_space_ids())::uuid[]))))));

alter policy jev_runs_insert on public.jev_runs
  with check (((space_id = any ((select internal.member_space_ids())::uuid[])) AND (requested_by = internal.identity_id())));

alter policy jev_runs_select on public.jev_runs
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy jev_runs_update on public.jev_runs
  using (((space_id = any ((select internal.member_space_ids())::uuid[])) AND (requested_by = internal.identity_id())))
  with check (((space_id = any ((select internal.member_space_ids())::uuid[])) AND (requested_by = internal.identity_id())));

alter policy loops_select on public.loops
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = loops.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy members_select on public.members
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy memories_select on public.memories
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = memories.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy message_parts_select on public.message_parts
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = message_parts.message_id and readable_entity.deleted_at is null offset 0)));

alter policy messages_select on public.messages
  using (((exists (select 1 from public.entities readable_entity where readable_entity.id = messages.entity_id and readable_entity.deleted_at is null offset 0)) AND (exists (select 1 from public.entities readable_entity where readable_entity.id = messages.anchor_id and readable_entity.deleted_at is null offset 0))));

alter policy point_events_select on public.point_events
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy project_links_select on public.project_links
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy project_projection_details_select on public.project_projection_details
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = project_projection_details.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy projects_select on public.projects
  using ((internal.is_node_admin() OR (EXISTS ( SELECT 1
   FROM space_projects sp
  WHERE ((sp.project_id = projects.id) AND (sp.space_id = any ((select internal.member_space_ids())::uuid[])))))));

alter policy pull_requests_select on public.pull_requests
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = pull_requests.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy saved_views_select on public.saved_views
  using (((space_id = any ((select internal.member_space_ids())::uuid[])) AND ((share_mode = 'space'::text) OR (EXISTS ( SELECT 1
   FROM members m
  WHERE ((m.entity_id = saved_views.owner_member_id) AND (m.identity_id = internal.identity_id())))))));

alter policy session_handoffs_select on public.session_handoffs
  using (((source_space_id = any ((select internal.member_space_ids())::uuid[])) AND (exists (select 1 from public.entities readable_entity where readable_entity.id = session_handoffs.target_work_session_id and readable_entity.deleted_at is null offset 0)) AND (source_missing OR (exists (select 1 from public.entities readable_entity where readable_entity.id = session_handoffs.source_entity_id and readable_entity.deleted_at is null offset 0)))));

alter policy session_manifests_select on public.session_manifests
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = session_manifests.work_session_id and readable_entity.deleted_at is null offset 0)));

alter policy session_message_deliveries_select on public.session_message_deliveries
  using (((exists (select 1 from public.entities readable_entity where readable_entity.id = session_message_deliveries.target_work_session_id and readable_entity.deleted_at is null offset 0)) AND ((source_work_session_id IS NULL) OR (exists (select 1 from public.entities readable_entity where readable_entity.id = session_message_deliveries.source_work_session_id and readable_entity.deleted_at is null offset 0))) AND (EXISTS ( SELECT 1
   FROM messages canonical_message
  WHERE ((canonical_message.entity_id = session_message_deliveries.message_id) AND (exists (select 1 from public.entities readable_entity where readable_entity.id = canonical_message.entity_id and readable_entity.deleted_at is null offset 0)) AND (exists (select 1 from public.entities readable_entity where readable_entity.id = canonical_message.anchor_id and readable_entity.deleted_at is null offset 0)))))));

alter policy session_modals_select on public.session_modals
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy session_space_credentials_member_select on public.session_space_credentials
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy skills_select on public.skills
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = skills.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy space_credential_policies_member_select on public.space_credential_policies
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy space_credentials_member_select on public.space_credentials
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy space_event_seq_select on public.space_event_seq
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy space_menu_configs_select on public.space_menu_configs
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy space_projects_select on public.space_projects
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy spaces_select on public.spaces
  using (((id = any ((select internal.member_space_ids())::uuid[])) OR ((visibility = 'public'::text) AND (internal.identity_id() IS NOT NULL))));

alter policy spells_select on public.spells
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = spells.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy stored_blobs_select on public.stored_blobs
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy stream_grants_select on public.stream_grants
  using (((subject_identity = internal.identity_id()) OR (exists (select 1 from public.entities readable_entity where readable_entity.id = stream_grants.work_session_id and readable_entity.deleted_at is null offset 0))));

alter policy task_axes_select on public.task_axes
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy tasks_select on public.tasks
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = tasks.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy team_members_select on public.team_members
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = team_members.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy tracking_refresh_select on public.tracking_refresh_requests
  using ((space_id = any ((select internal.member_space_ids())::uuid[])));

alter policy voice_channels_select on public.voice_channels
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = voice_channels.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy work_session_interaction_pins_select on public.work_session_interaction_pins
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = work_session_interaction_pins.work_session_id and readable_entity.deleted_at is null offset 0)));

alter policy work_session_view_preferences_select on public.work_session_view_preferences
  using (((exists (select 1 from public.entities readable_entity where readable_entity.id = work_session_view_preferences.work_session_id and readable_entity.deleted_at is null offset 0)) AND (EXISTS ( SELECT 1
   FROM members member_row
  WHERE ((member_row.entity_id = work_session_view_preferences.member_id) AND (member_row.identity_id = internal.identity_id()))))));

alter policy work_sessions_select on public.work_sessions
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = work_sessions.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy workspace_events_select on public.workspace_events
  using (((space_id = any ((select internal.member_space_ids())::uuid[])) AND ((recipient_member_id IS NULL) OR (EXISTS ( SELECT 1
   FROM members m
  WHERE ((m.entity_id = workspace_events.recipient_member_id) AND (m.identity_id = internal.identity_id())))))));

alter policy worktree_allocations_select on public.worktree_allocations
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = worktree_allocations.worktree_entity_id and readable_entity.deleted_at is null offset 0)));

alter policy worktrees_select on public.worktrees
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = worktrees.entity_id and readable_entity.deleted_at is null offset 0)));

alter policy entity_headers_select on public.entity_headers
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = entity_headers.entity_id and readable_entity.deleted_at is null offset 0)));

reset role;
