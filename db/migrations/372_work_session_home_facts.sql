-- =============================================================================
-- 372: the facts a node needs before it removes a session's Codex home.
--
-- Every Codex launch writes a per-session CODEX_HOME under the node's data
-- root (`<dataDir>/manifests/mcp-homes/<session>/codex`), and nothing removed
-- it. The node's reclaim job (`execution.codex-home-reclaim`) removes a home
-- only when the session can no longer be resumed: no row, a deleted row, or a
-- worktree session whose checkout is gone. That last check is a filesystem
-- check, so this door returns facts and the node decides.
--
-- NODE ADMIN, and deliberately NOT filtered by space membership. The caller
-- reads an id missing from the answer as "no such session" and removes its
-- home. The node owner is not a member of every space on a multi-user node,
-- so an RLS-scoped read would make other spaces' sessions look like orphans.
-- Returns status and paths only, never content.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.work_session_home_facts(p_session_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare rows jsonb;
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_session_ids), 0) > 1000 then
    raise exception 'at most 1000 sessions per call' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'sessionId', ws.entity_id,
           'status', ws.status,
           'deleted', e.deleted_at is not null,
           'workdirMode', ws.workdir_mode,
           'workdirPath', ws.workdir_path,
           'exitedAt', ws.exited_at)), '[]'::jsonb)
    into rows
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.entity_id = any(coalesce(p_session_ids, '{}'::uuid[]));
  return rows;
end
$$;

revoke all on function public.work_session_home_facts(uuid[]) from public;
grant execute on function public.work_session_home_facts(uuid[]) to tm8_app;

reset role;
