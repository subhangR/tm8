-- =============================================================================
-- 378: a node ends its own sessions' processes in every space.
--
-- A ghost is a work session whose record says a process runs (spawning /
-- running / idle) while the node it is recorded against holds none: the
-- process died with a prior instance of the server and nobody wrote its exit.
-- Boot reconciliation and the lost-session reaper exist to retire them, and the
-- completed auto-close ends a completed session's idle process. On a multi-user
-- node all three did almost nothing.
--
-- WHY. All three run as the node's loopback owner and worked through member
-- doors:
--
--   * the ghost candidates were a plain SELECT under tm8_app RLS, and
--     `entities_select` is `space_id = any(internal.member_space_ids())`, so a
--     ghost in a space the owner is not a member of was never a candidate. No
--     error and no log line: the reaper tick simply reported `skipped`;
--   * the auto-close candidates (`completed_sessions_to_close`, 318) end in
--     `is_space_member`, the same blindness;
--   * the write was `work_session_transition`, whose `require_space_member` has
--     no node-admin bypass, so even a visible row was refused with "not a
--     member of this space".
--
-- Measured on prod 2026-10-28 14:10Z: the cap read 64/64 and 19 of the 64 had
-- no process on the node, in six spaces the owner is not a member of. The cap
-- counts every space (`live_work_session_count(null)`), so those 19 refused
-- launches in every space, the owner's included.
--
-- TWO NAMED PREDICATES, and every read here uses one of them:
--
--   * `work_session_process_recorded_live(status, deleted_at)` — the record
--     says a process runs. ANY kind: agent, shell, container_exec and tool
--     sessions all run in a PTY on their node, and a ghost of any kind pins its
--     own counters (shell_session_count, container_exec_session_count) and
--     blocks container idle reclamation. This is what a node may end, and what
--     its ghost and auto-close reads list;
--   * `work_session_counts_against_cap(status, outcome, kind, deleted_at)` —
--     that, for an AGENT whose work is not completed (302, spec §5.3: a
--     completed session is spare capacity). The concurrency cap counts exactly
--     this, and so does the launch card's `used`.
--
-- THE NODE DOORS. Node admin only, scoped to the node id the caller names (its
-- own; a session recorded against another node may be alive over there). Every
-- node job reads and writes through them, so none uses a member door again:
--
--   * `node_live_work_sessions(node)` — ghost candidates: ids and statuses;
--   * `node_completed_sessions_to_close(node)` — the auto-close candidates,
--     318's rule without the membership filter;
--   * `node_record_work_session_ending(node, session, status, kind, reason,
--     error)` — the PROCESS fact only (status, ended_kind, ended_reason, error,
--     exited_at), never the outcome or the claims. Endings a node may record:
--     failed with lost / server_restart / unknown / out_of_memory (an absence
--     it observed), or exited with exited_clean (it closed a completed
--     session's idle process). Its precondition is the first predicate, the
--     same one both candidate reads use, so a listed row is always endable.
--     The durable record is the `session.process_changed` event the 302
--     trigger already writes, which now also names `endedByNode`. Returns the
--     facts the node needs to read the transcript's usage;
--   * `node_record_work_session_usage(node, session, usage, source)` — that
--     usage, for a session this node ran, in any space.
--
-- None is a catalog operation; only the node's own jobs call them. Members gain
-- nothing: a member is not a node admin.
--
-- And `session_capacity(node, held, stale_after)` for the launch card: `used`
-- (node-wide, the spawn gate's population) and, when a node is named,
-- `ghosts`: the part of `used` the reaper would retire — recorded against this
-- node, no PTY held here, unchanged for at least the reaper's stale window (so
-- a launch whose PTY is a second away is not called dead). One population, one
-- round trip, numbers only, so it is safe on a member's read.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function internal.work_session_process_recorded_live(
  p_status text, p_deleted_at timestamptz
) returns boolean language sql immutable
set search_path = public, internal, pg_temp as $$
  select p_status in ('spawning', 'running', 'idle') and p_deleted_at is null
$$;

revoke all on function internal.work_session_process_recorded_live(text, timestamptz) from public;
grant execute on function internal.work_session_process_recorded_live(text, timestamptz) to tm8_app;

create or replace function internal.work_session_counts_against_cap(
  p_status text, p_outcome text, p_session_kind text, p_deleted_at timestamptz
) returns boolean language sql immutable
set search_path = public, internal, pg_temp as $$
  select internal.work_session_process_recorded_live(p_status, p_deleted_at)
     and p_session_kind = 'agent'
     and p_outcome is distinct from 'completed'
$$;

revoke all on function internal.work_session_counts_against_cap(text, text, text, timestamptz) from public;
grant execute on function internal.work_session_counts_against_cap(text, text, text, timestamptz) to tm8_app;

create or replace function internal.live_work_session_count(target_space uuid default null)
returns integer language sql stable
set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where internal.work_session_counts_against_cap(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
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
       and internal.work_session_process_recorded_live(ws.status, e.deleted_at)
     order by ws.entity_id;
end
$$;

revoke all on function public.node_live_work_sessions(text) from public;
grant execute on function public.node_live_work_sessions(text) to tm8_app;

-- 318's `completed_sessions_to_close` rule, node-wide. Tool sessions stay out
-- (318: "No idle autoclose for the retained shell").
create or replace function public.node_completed_sessions_to_close(p_node_id text)
returns table(session_id uuid, minutes integer)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_node_door(p_node_id);
  return query
    select ws.entity_id, sp.session_autoclose_minutes
      from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id
      join public.spaces sp on sp.id = e.space_id
     where ws.node_id = p_node_id
       and ws.session_kind <> 'tool'
       and ws.outcome = 'completed'
       and internal.work_session_process_recorded_live(ws.status, e.deleted_at)
       and sp.session_autoclose_minutes > 0
       and greatest(ws.outcome_at, e.activity_at) < now() - make_interval(mins => sp.session_autoclose_minutes)
       -- D2 follow-on (6 Oct): never close a session that still has running children.
       and not exists (
         select 1 from public.entities ce join public.work_sessions cws on cws.entity_id = ce.id
          where ce.parent_id = ws.entity_id
            and internal.work_session_process_recorded_live(cws.status, ce.deleted_at))
     order by ws.entity_id;
end
$$;

revoke all on function public.node_completed_sessions_to_close(text) from public;
grant execute on function public.node_completed_sessions_to_close(text) to tm8_app;

-- Its member-filtered predecessor has no caller left.
drop function if exists public.completed_sessions_to_close(text);

-- `recorded` false, not an error, for a row whose process is no longer recorded
-- live on this node: its own exit may have been written between the read and
-- this write, and that ending stands. The caller counts it as not recorded.
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
     and internal.work_session_process_recorded_live(w.status, e.deleted_at)
     for update of w;
  if ws.entity_id is null then
    return jsonb_build_object('recorded', false, 'usageFacts', null);
  end if;

  -- `tm8.ending_node` is read by the event trigger below: the durable event
  -- names which node recorded this ending.
  perform set_config('tm8.work_session_transition', 'on', true);
  perform set_config('tm8.ending_node', p_node_id, true);
  update public.work_sessions
     set status = p_status,
         error = coalesce(p_error, error),
         ended_kind = p_ended_kind,
         ended_reason = coalesce(p_ended_reason, ended_reason),
         exited_at = coalesce(exited_at, now())
   where entity_id = ws.entity_id;
  perform set_config('tm8.ending_node', '', true);
  perform set_config('tm8.work_session_transition', 'off', true);
  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = ws.entity_id;

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
create or replace function public.session_capacity(p_node_id text, p_held uuid[], p_stale_after interval)
returns table(used integer, ghosts integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select count(*)::integer,
         case when p_node_id is null then null
              else (count(*) filter (
                      where ws.node_id = p_node_id
                        and not (ws.entity_id = any(coalesce(p_held, '{}'::uuid[])))
                        and ws.status_changed_at < now() - greatest(coalesce(p_stale_after, interval '10 minutes'),
                                                                    interval '0')))::integer end
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where internal.work_session_counts_against_cap(ws.status, ws.outcome, ws.session_kind, e.deleted_at)
$$;

revoke all on function public.session_capacity(text, uuid[], interval) from public;
grant execute on function public.session_capacity(text, uuid[], interval) to tm8_app;

reset role;

-- 302's event trigger, plus `endedByNode` on a node-recorded ending. Absent on
-- every other ending, so a member-door event is byte-identical to before.
-- Outside the tm8_graph_owner block: 302 created it as the migration role,
-- which still owns it.
create or replace function internal.emit_work_session_events()
returns trigger language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  space uuid;
  ending_node text := nullif(coalesce(current_setting('tm8.ending_node', true), ''), '');
begin
  select e.space_id into space from public.entities e where e.id = new.entity_id;
  if space is null then return new; end if;
  if new.status is distinct from old.status then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (space, internal.next_event_seq(space), 'session.process_changed',
            jsonb_build_object('id', new.entity_id, 'from', old.status, 'to', new.status,
                               'endedKind', new.ended_kind, 'endedReason', new.ended_reason,
                               'outcome', new.outcome, 'at', now())
              || case when ending_node is null then '{}'::jsonb
                      else jsonb_build_object('endedByNode', ending_node) end,
            internal.claim_cmid());
  end if;
  if new.outcome is distinct from old.outcome then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (space, internal.next_event_seq(space), 'session.outcome_changed',
            jsonb_build_object('id', new.entity_id, 'from', old.outcome, 'to', new.outcome,
                               'outcomeBy', new.outcome_by, 'receiptMessageId', new.receipt_message_id,
                               'outcomeSource', new.outcome_source, 'status', new.status, 'at', now()),
            internal.claim_cmid());
  end if;
  return new;
end
$$;

revoke all on function internal.emit_work_session_events() from public;
