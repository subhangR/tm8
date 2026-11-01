-- =============================================================================
-- 433 — Bridges close forked groups: `bridges.close` (task 01a19611-b19c).
--
-- WhatsApp has no real group delete. The closest is what this op does: post a
-- closing note, remove every participant, and have the number leave (the
-- server asks the runtime for that with `group.close` BEFORE this door runs,
-- while the group is still on the allowlist), then end the bridge here with
-- the same tombstone `bridges.remove` leaves (395: the row, its log, edges and
-- handles stay readable; the session it landed on is untouched).
--
-- Decision D84 (supersedes D28 for this op only): an AGENT may close a bridge,
-- but only a FORK — a bridge that a /split (426) or an agent fork (432,
-- public.bridge_group_forks) made. Any other bridge stays human-only to
-- remove (`bridges.remove`). Who may close a fork:
--   * the session the fork lands on (its target);
--   * the session the parent bridge lands on (the agent of the group it was
--     forked from);
--   * the forking session, when 432 recorded one (bridge_group_forks.session_id);
--   * a human space admin.
--
-- WHAT THIS FILE DOES
--   §1  internal.bridge_fork_of: is this bridge a fork, of which bridge, and
--       which session forked it. Reads bridge_group_forks only when 432 is
--       applied (to_regclass), so this file applies before or after it.
--   §2  internal.bridge_for_closer: the gate above.
--   §3  public.bridge_close_plan (what the server needs to ask the runtime)
--       and public.close_forked_bridge (the tombstone, ledgered).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Fork provenance: null, or {fromBridgeId, forkedBy (a session or null)}.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_fork_of(p_bridge_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare from_id uuid; forker uuid;
begin
  if to_regclass('public.bridge_group_forks') is not null then
    execute 'select from_bridge_id, session_id from public.bridge_group_forks where bridge_id = $1'
      into from_id, forker using p_bridge_id;
  end if;
  if from_id is null then
    select s.from_bridge_id into from_id from public.bridge_splits s where s.bridge_id = p_bridge_id limit 1;
  end if;
  if from_id is null then return null; end if;
  return jsonb_build_object('fromBridgeId', from_id, 'forkedBy', forker);
end
$$;
revoke all on function internal.bridge_fork_of(uuid) from public;

-- -----------------------------------------------------------------------------
-- §2. The gate: a live fork, and a caller allowed to close it.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_for_closer(p_bridge_id uuid) returns public.bridges
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; e public.entities; fork jsonb; parent public.bridges; caller uuid;
begin
  e := internal.live_entity(p_bridge_id, 'bridge');
  select * into b from public.bridges where entity_id = p_bridge_id;
  caller := internal.caller_work_session(e.space_id);
  if caller is null and not internal.is_space_admin(e.space_id) then
    raise exception 'closing a group takes the session it is bridged to, the session that forked it, or a space admin'
      using errcode = '42501';
  end if;
  if b.ended_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'this bridge was removed');
  end if;
  fork := internal.bridge_fork_of(p_bridge_id);
  if fork is null then
    perform internal.bridge_refuse('not_a_fork',
      'only a group made by /split or an agent fork can be closed by an agent; a human space admin removes any other bridge with `tm8 bridge remove`');
  end if;
  if caller is not null then
    select * into parent from public.bridges where entity_id = (fork ->> 'fromBridgeId')::uuid;
    if caller is distinct from b.target_id
       and caller is distinct from parent.target_id
       and caller is distinct from (fork ->> 'forkedBy')::uuid then
      raise exception 'only the session this group is bridged to, the session of the group it was forked from, or the session that forked it can close it'
        using errcode = '42501';
    end if;
  end if;
  return b;
end
$$;
revoke all on function internal.bridge_for_closer(uuid) from public;

-- -----------------------------------------------------------------------------
-- §3. The doors.
-- -----------------------------------------------------------------------------

-- What the server needs to dissolve the group on WhatsApp. Changes nothing.
create or replace function public.bridge_close_plan(p_bridge_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; fork jsonb; parent public.bridges; parent_e public.entities; c public.bridge_connections;
        v integer;
begin
  b := internal.bridge_for_closer(p_bridge_id);
  fork := internal.bridge_fork_of(p_bridge_id);
  select * into parent from public.bridges where entity_id = (fork ->> 'fromBridgeId')::uuid;
  select * into parent_e from public.entities where id = parent.entity_id;
  select * into c from public.bridge_connections where id = b.connection_id;
  select e.version into v from public.entities e where e.id = b.entity_id;
  return jsonb_build_object(
    'bridgeId', b.entity_id, 'spaceId', b.space_id, 'version', v,
    'connectionId', b.connection_id,
    'runtimeId', case when c.status = 'linked' then c.runtime_id end,
    'conversationId', b.external_conversation_id,
    'title', coalesce(b.conversation ->> 'title', ''),
    'fromBridgeId', parent.entity_id,
    'fromTitle', coalesce(parent.conversation ->> 'title', ''),
    -- Only on the same number: the runtime asks it for the parent's invite link.
    'fromConversationId', case when parent.connection_id = b.connection_id and parent.ended_at is null
                               then parent.external_conversation_id end,
    'fromLive', parent.entity_id is not null and parent.ended_at is null and parent_e.deleted_at is null);
end
$$;
revoke all on function public.bridge_close_plan(uuid) from public;
grant execute on function public.bridge_close_plan(uuid) to tm8_app;

-- The tombstone, after the runtime dissolved the group. p_result is what it
-- did ({removed, failed, note}), kept on the activity record. A replay of the
-- same clientMutationId answers the first call, even after the bridge ended.
create or replace function public.close_forked_bridge(
  p_bridge_id uuid, p_expected_version integer, p_result jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; b public.bridges; fork jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.close');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_bridge_id::text, 'entity');
    return replay;
  end if;
  b := internal.bridge_for_closer(p_bridge_id);
  fork := internal.bridge_fork_of(p_bridge_id);
  actor := internal.resolve_actor(p_actor_id, b.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_bridge_id, p_expected_version);
  -- 395's tombstone, as bridges.remove leaves it.
  update public.bridges set ended_at = now(), paused_at = null where entity_id = p_bridge_id;
  update public.bridge_outbox set status = 'failed_permanent', settled_at = now()
   where bridge_id = p_bridge_id and status in ('pending', 'dispatching', 'failed_retryable');
  return internal.ledger_record(p_client_mutation_id, 'bridges.close',
    internal.command_result(p_bridge_id, null,
      internal.record_activity(b.space_id, p_bridge_id, actor, 'deleted', null,
        jsonb_build_object('kind', 'bridge', 'op', 'bridges.close',
          'forkOf', fork ->> 'fromBridgeId',
          'closedBySession', internal.caller_work_session(b.space_id),
          'removed', coalesce((p_result ->> 'removed')::int, 0),
          'failed', coalesce((p_result ->> 'failed')::int, 0),
          'note', left(coalesce(p_result ->> 'note', ''), 1000))),
      array[p_bridge_id]));
end
$$;
revoke all on function public.close_forked_bridge(uuid, integer, jsonb, uuid, text) from public;
grant execute on function public.close_forked_bridge(uuid, integer, jsonb, uuid, text) to tm8_app;

reset role;
