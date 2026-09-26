-- =============================================================================
-- 269 (set at the merge position after #917's 268; 262 stays a hole; was placeholder 980) — plan W2
-- x A3: `projects.create` may link the project it creates into one space, in
-- the SAME transaction.
--
-- WHY. Plan W2 pins the credential-free loopback owner to the space its PATH
-- names (`/v2/spaces/:spaceId/...`; lead ruling on 01a0dc4c: a pinned local
-- owner is space-scoped BY DESIGN). The browser's "connect a folder" dialog
-- did `projects.create` (space-less, so unpinned) and then `projects.link`
-- under `/v2/spaces/S` (pinned to S). Pinned, K6 (233) drops node-admin and
-- 232's `member_space_ids()` narrows to S, so `project_visible_to_caller`
-- (228) cannot see a project linked nowhere yet, and the link answered P0002.
-- Creating the project already linked into S means it is BORN inside S, so
-- every later pinned call under `/v2/spaces/S` sees it.
--
-- WHAT IT IS NOT. `projects.create` stays space-less and unpinned, as plan W2
-- designed it, and stays node-admin (`create_project` still calls
-- `require_node_admin`). A create-time link is equivalent to create plus a
-- node-admin link; the pin on `/v2/spaces/:id` is unchanged, and
-- `project_visible_to_caller` is unchanged (P2, widening it, was declined).
--
-- ADDITIVE ONLY. One NEW function. `create_project` (007) and
-- `link_project_w2` (228) are called, not replaced; no row is rewritten or
-- deleted. The space admin check runs BEFORE the insert, and the whole body is
-- one statement's transaction, so a refused link leaves no orphan project.
-- Replay keys on the same `projects.create` ledger operation as 007, so a
-- replayed create returns its first result, link included.
-- =============================================================================

set role tm8_graph_owner;

create function public.create_project_in_space(
  p_space_id uuid, p_name text, p_working_dir text, p_repo_url text default null,
  p_trust text default 'untrusted', p_defaults jsonb default '{}'::jsonb,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  created jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.create');
  if replay is not null then return replay; end if;
  perform internal.require_node_admin();
  perform internal.require_space_admin(p_space_id);
  created := public.create_project(p_name, p_working_dir, p_repo_url, p_trust, p_defaults, null);
  perform public.link_project_w2(p_space_id, (created -> 'project' ->> 'id')::uuid, null, null);
  return internal.ledger_record(p_client_mutation_id, 'projects.create', created);
end
$$;

revoke all on function public.create_project_in_space(uuid, text, text, text, text, jsonb, text) from public;
grant execute on function public.create_project_in_space(uuid, text, text, text, text, jsonb, text) to tm8_app;

comment on function public.create_project_in_space(uuid, text, text, text, text, jsonb, text) is
  '`projects.create` with `spaceId` (269, plan W2 x A3): create_project plus link_project_w2 '
  'in one transaction, after require_space_admin. Node admin only, like create_project.';

reset role;
