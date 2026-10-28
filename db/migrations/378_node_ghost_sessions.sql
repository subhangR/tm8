-- =============================================================================
-- 378: a node retires its own ghost sessions in every space.
--
-- A ghost is a work session whose record says it is live (spawning / running /
-- idle) while the node it is recorded against holds no process for it: the
-- process died with a prior instance of the server and nobody wrote its exit.
-- Boot reconciliation and the lost-session reaper exist to retire them, and on
-- a multi-user node they retired almost none.
--
-- WHY. Both run as the node's loopback owner, and both did their work through
-- member doors:
--
--   * the candidate list was a plain SELECT under tm8_app RLS, and
--     `entities_select` is `space_id = any(internal.member_space_ids())`, so a
--     ghost in a space the owner is not a member of was never a candidate. No
--     error and no log line: the reaper tick simply reported `skipped`;
--   * the write was `work_session_transition`, whose `require_space_member` has
--     no node-admin bypass, so even a visible ghost was refused with "not a
--     member of this space".
--
-- Measured on prod 2026-10-28 14:10Z: the cap read 64/64 and 19 of the 64 had
-- no process on the node, in six spaces the owner is not a member of. The cap
-- counts every space (`live_work_session_count(null)`), so those 19 refused
-- launches in every space, the owner's included.
--
-- THE CAP AND THE REAPER DISAGREED ON "LIVE", too. The cap counts status
-- spawning/running/idle AND outcome <> 'completed' AND session_kind 'agent';
-- the reaper's read had neither the outcome nor the kind filter. This adds ONE
-- definition, `internal.work_session_is_live`, and both now call it.
--
-- THE NODE DOORS. Two SECURITY DEFINER functions, node admin only, both scoped
-- to the node id the caller names (the node's own id; a ghost recorded against
-- another node may be alive over there):
--
--   * `node_live_work_sessions(node)` — ids and statuses, nothing else;
--   * `node_record_work_session_lost(node, session, kind, reason, error)` —
--     writes the PROCESS fact only: status 'failed', ended_kind, ended_reason,
--     error, exited_at. It never touches the outcome or the claims, so a lost
--     session is still unfinished work someone can resume, complete or stop.
--     The ending kinds are the four a node can infer about a process it does
--     not hold: lost, server_restart, unknown, out_of_memory.
--
-- Neither is a catalog operation; only the node's own background jobs call
-- them. Members gain nothing: a member is not a node admin.
--
-- And a COUNT for the person at the launch card: `node_ghost_work_session_count`
-- is how many live rows this node holds no process for, given the ids it does
-- hold. A number only, no ids, so it is safe on a member's read.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- The one definition of a live work session: the concurrency cap counts it,
-- and the node's ghost reads consider it. A completed session is spare
-- capacity (302, spec §5.3) even while its process idles, and the completed
-- auto-close closes that process, so it is not live here.
create or replace function internal.work_session_is_live(
  p_status text, p_outcome text, p_session_kind text, p_deleted_at timestamptz
) returns boolean language sql immutable
set search_path = public, internal, pg_temp as $$
  select p_status in ('spawning', 'running', 'idle')
     and p_outcome is distinct from 'completed'
     and p_session_kind = 'agent'
     and p_deleted_at is null
$$;

revoke all on function internal.work_session_is_live(text, text, text, timestamptz) from public;
grant execute on function internal.work_session_is_live(text, text, text, timestamptz) to tm8_app;

create or replace function internal.live_work_session_count(target_space uuid default null)
returns integer language sql stable
set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where internal.work_session_is_live(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
     and (target_space is null or e.space_id = target_space)
$$;

create or replace function public.node_live_work_sessions(p_node_id text)
returns table(session_id uuid, status text)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_node_id, '')), '') is null then
    raise exception 'node id required' using errcode = '22023';
  end if;
  return query
    select ws.entity_id, ws.status
      from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id
     where ws.node_id = p_node_id
       and internal.work_session_is_live(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
     order by ws.entity_id;
end
$$;

revoke all on function public.node_live_work_sessions(text) from public;
grant execute on function public.node_live_work_sessions(text) to tm8_app;

-- Returns whether it wrote. FALSE, not an error, for a row that is no longer
-- live or not on this node: the process may have recorded its own exit between
-- the read and this write, and that ending stands.
create or replace function public.node_record_work_session_lost(
  p_node_id text, p_session_id uuid, p_ended_kind text, p_ended_reason text, p_error text
) returns boolean
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_id uuid;
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_node_id, '')), '') is null then
    raise exception 'node id required' using errcode = '22023';
  end if;
  if p_ended_kind is null or p_ended_kind not in ('lost', 'server_restart', 'unknown', 'out_of_memory') then
    raise exception 'invalid ended_kind for a node-recorded ending: %', p_ended_kind using errcode = '22023';
  end if;

  select ws.entity_id into v_id
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.entity_id = p_session_id
     and ws.node_id = p_node_id
     and internal.work_session_is_live(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
     for update of ws;
  if v_id is null then return false; end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = 'failed',
         error = coalesce(p_error, error),
         ended_kind = p_ended_kind,
         ended_reason = coalesce(p_ended_reason, ended_reason),
         exited_at = coalesce(exited_at, now())
   where entity_id = v_id;
  perform set_config('tm8.work_session_transition', 'off', true);
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = v_id;
  return true;
end
$$;

revoke all on function public.node_record_work_session_lost(text, uuid, text, text, text) from public;
grant execute on function public.node_record_work_session_lost(text, uuid, text, text, text) to tm8_app;

-- Any caller: a count across spaces is what the cap itself already discloses.
create or replace function public.node_ghost_work_session_count(p_node_id text, p_held uuid[])
returns integer
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.node_id = p_node_id
     and internal.work_session_is_live(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
     and not (ws.entity_id = any(coalesce(p_held, '{}'::uuid[])))
$$;

revoke all on function public.node_ghost_work_session_count(text, uuid[]) from public;
grant execute on function public.node_ghost_work_session_count(text, uuid[]) to tm8_app;

reset role;
