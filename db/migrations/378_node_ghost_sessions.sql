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
-- THE NODE DOORS, for "this node's process ended". Node admin only, scoped to
-- the node id the caller names (its own; a session recorded against another
-- node may be alive over there). One door for all three node jobs — boot
-- reconciliation, the lost-session reaper and the completed auto-close — so no
-- node job writes through a member door again:
--
--   * `node_live_work_sessions(node)` — ghost candidates: ids and statuses;
--   * `node_record_work_session_ending(node, session, status, kind, reason,
--     error)` — the PROCESS fact only (status, ended_kind, ended_reason, error,
--     exited_at), never the outcome or the claims. Endings a node may record:
--     failed with lost / server_restart / unknown / out_of_memory (an absence
--     it observed), or exited with exited_clean (it closed a completed
--     session's idle process). Each write leaves a command-ledger row
--     (`execution.node_ending`) with the node identity and the reason, and
--     returns the facts the node needs to read the transcript's usage;
--   * `node_record_work_session_usage(node, session, usage, source)` — that
--     usage, for a session this node ran, in any space.
--
-- None is a catalog operation; only the node's own jobs call them. Members gain
-- nothing: a member is not a node admin.
--
-- And `session_capacity(node, held)` for the launch card: the cap's `used`
-- (node-wide, as the spawn gate counts it) and, when a node is named, `ghosts`
-- (this node's live rows it holds no process for), from ONE population in one
-- round trip. Numbers only, no ids, so it is safe on a member's read — a
-- member-scoped `used` beside a node-wide `ghosts` would describe two
-- different sets.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- The record says an agent process runs: what a node may end, and what the cap
-- and the ghost reads start from.
create or replace function internal.work_session_process_recorded_live(
  p_status text, p_session_kind text, p_deleted_at timestamptz
) returns boolean language sql immutable
set search_path = public, internal, pg_temp as $$
  select p_status in ('spawning', 'running', 'idle')
     and p_session_kind = 'agent'
     and p_deleted_at is null
$$;

revoke all on function internal.work_session_process_recorded_live(text, text, timestamptz) from public;
grant execute on function internal.work_session_process_recorded_live(text, text, timestamptz) to tm8_app;

-- The one definition of a LIVE work session: the concurrency cap counts it,
-- and the node's ghost reads consider it. A completed session is spare
-- capacity (302, spec §5.3) even while its process idles; the completed
-- auto-close ends that process.
create or replace function internal.work_session_is_live(
  p_status text, p_outcome text, p_session_kind text, p_deleted_at timestamptz
) returns boolean language sql immutable
set search_path = public, internal, pg_temp as $$
  select internal.work_session_process_recorded_live(p_status, p_session_kind, p_deleted_at)
     and p_outcome is distinct from 'completed'
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

create or replace function internal.require_node_door(p_node_id text) returns void
language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if not internal.is_node_admin() then
    raise exception 'node admin required' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_node_id, '')), '') is null then
    raise exception 'node id required' using errcode = '22023';
  end if;
end
$$;

revoke all on function internal.require_node_door(text) from public;

create or replace function public.node_live_work_sessions(p_node_id text)
returns table(session_id uuid, status text)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_door(p_node_id);
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

-- `recorded` false, not an error, for a row whose process is no longer recorded
-- live on this node: its own exit may have been written between the read and
-- this write, and that ending stands.
create or replace function public.node_record_work_session_ending(
  p_node_id text, p_session_id uuid, p_status text, p_ended_kind text,
  p_ended_reason text, p_error text
) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  ws public.work_sessions;
begin
  perform internal.require_node_door(p_node_id);
  if not ((p_status = 'failed' and p_ended_kind in ('lost', 'server_restart', 'unknown', 'out_of_memory'))
       or (p_status = 'exited' and p_ended_kind = 'exited_clean')) then
    raise exception 'not an ending a node records: % / %', p_status, p_ended_kind using errcode = '22023';
  end if;

  select w.* into ws
    from public.work_sessions w
    join public.entities e on e.id = w.entity_id
   where w.entity_id = p_session_id
     and w.node_id = p_node_id
     and internal.work_session_process_recorded_live(w.status, w.session_kind, e.deleted_at)
     for update of w;
  if ws.entity_id is null then
    return jsonb_build_object('recorded', false, 'usageFacts', null);
  end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = p_status,
         error = coalesce(p_error, error),
         ended_kind = p_ended_kind,
         ended_reason = coalesce(p_ended_reason, ended_reason),
         exited_at = coalesce(exited_at, now())
   where entity_id = ws.entity_id;
  perform set_config('tm8.work_session_transition', 'off', true);
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = ws.entity_id;

  -- The audit row: who ended it (the node identity, from the claims), and why.
  perform internal.ledger_record('node-ending:' || internal.new_id()::text, 'execution.node_ending',
    jsonb_build_object('sessionId', ws.entity_id, 'nodeId', p_node_id, 'status', p_status,
                       'endedKind', p_ended_kind, 'reason', p_error));

  return jsonb_build_object('recorded', true, 'usageFacts', jsonb_build_object(
    'agentTool', ws.agent_tool,
    'nativeSessionId', ws.native_session_id,
    'workdirMode', ws.workdir_mode,
    'workdirPath', ws.workdir_path,
    'agentConfigDir', ws.agent_config_dir));
end
$$;

revoke all on function public.node_record_work_session_ending(text, uuid, text, text, text, text) from public;
grant execute on function public.node_record_work_session_ending(text, uuid, text, text, text, text) to tm8_app;

-- record_work_session_usage (185) for a session this node ran, in any space.
create or replace function public.node_record_work_session_usage(
  p_node_id text, p_session_id uuid, p_usage jsonb, p_usage_source text
) returns boolean
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_door(p_node_id);
  if p_usage is null or jsonb_typeof(p_usage) <> 'object' then
    raise exception 'usage must be a JSON object' using errcode = '22023';
  end if;
  if p_usage_source is null or p_usage_source not in ('claude_transcript', 'codex_rollout') then
    raise exception 'usage_source must be claude_transcript or codex_rollout, got %',
      coalesce(p_usage_source, '<null>') using errcode = '22023';
  end if;
  update public.work_sessions
     set usage = p_usage, usage_source = p_usage_source, usage_recorded_at = now()
   where entity_id = p_session_id and node_id = p_node_id;
  if not found then return false; end if;
  update public.entities set version = version + 1, updated_at = now() where id = p_session_id;
  return true;
end
$$;

revoke all on function public.node_record_work_session_usage(text, uuid, jsonb, text) from public;
grant execute on function public.node_record_work_session_usage(text, uuid, jsonb, text) to tm8_app;

-- Any caller: numbers only, and `used` is what the spawn gate already discloses.
-- `ghosts` is null when no node is named.
create or replace function public.session_capacity(p_node_id text, p_held uuid[])
returns table(used integer, ghosts integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select count(*)::integer,
         case when p_node_id is null then null
              else (count(*) filter (
                      where ws.node_id = p_node_id
                        and not (ws.entity_id = any(coalesce(p_held, '{}'::uuid[])))))::integer end
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where internal.work_session_is_live(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
$$;

revoke all on function public.session_capacity(text, uuid[]) from public;
grant execute on function public.session_capacity(text, uuid[]) to tm8_app;

reset role;
