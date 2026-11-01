-- 435 — /new session: freeze validated launch choices and atomically retarget.
-- The command message is the durable retry key. A completed receipt makes a
-- late retry a no-op, even after a newer /new has moved the group again.
set local lock_timeout = '5s';
set role tm8_graph_owner;

create table internal.bridge_session_starts (
  message_id uuid primary key references public.messages(entity_id) on delete cascade,
  bridge_id uuid not null references public.bridges(entity_id) on delete cascade,
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  -- Keep the completed receipt even if that session is later purged.
  session_id uuid
);
create index bridge_session_starts_bridge_idx on internal.bridge_session_starts(bridge_id);
revoke all on internal.bridge_session_starts from public, tm8_app;

create or replace function public.bridge_new_session_plan(p_bridge_id uuid, p_message_id uuid, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare saved internal.bridge_session_starts; b public.bridges;
begin
  perform internal.require_bridges_worker();
  select * into saved from internal.bridge_session_starts where message_id = p_message_id and bridge_id = p_bridge_id;
  if saved.message_id is not null then
    return saved.plan || jsonb_build_object('appliedSessionId', saved.session_id);
  end if;
  if p_plan is null then return null; end if;
  select * into b from public.bridges where entity_id = p_bridge_id for update;
  if b.entity_id is null or b.ended_at is not null or b.target_kind = 'channel'
     or b.target_id is distinct from (p_plan->>'targetId')::uuid then
    perform internal.bridge_refuse('bridge_changed', 'this bridge moved while /new was starting; send /new session again');
  end if;
  if not exists (select 1 from public.message_origins where message_id = p_message_id and bridge_id = p_bridge_id and direction = 'in') then
    raise exception 'the command must be an inbound message on this bridge' using errcode = '22023';
  end if;
  if not exists (select 1 from public.team_members tm join public.entities e on e.id = tm.entity_id
                  where tm.entity_id = (p_plan->>'teamMemberId')::uuid and e.space_id = b.space_id and e.deleted_at is null)
     or nullif(p_plan->>'model', '') is null or nullif(p_plan->>'agentTool', '') is null then
    raise exception 'a validated launch with a teammate in this space is required' using errcode = '22023';
  end if;
  insert into internal.bridge_session_starts(message_id, bridge_id, plan) values (p_message_id, p_bridge_id, p_plan)
    on conflict (message_id) do nothing;
  select * into saved from internal.bridge_session_starts where message_id = p_message_id and bridge_id = p_bridge_id;
  return saved.plan || jsonb_build_object('appliedSessionId', saved.session_id);
end
$$;
revoke all on function public.bridge_new_session_plan(uuid, uuid, jsonb) from public;
grant execute on function public.bridge_new_session_plan(uuid, uuid, jsonb) to tm8_app;

create or replace function public.bridge_new_session_finish(p_bridge_id uuid, p_message_id uuid, p_session_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare saved internal.bridge_session_starts; b public.bridges; teammate uuid; session_status text;
begin
  perform internal.require_bridges_worker();
  select * into saved from internal.bridge_session_starts where message_id = p_message_id and bridge_id = p_bridge_id for update;
  if saved.message_id is null then raise exception 'no validated launch plan' using errcode = '22023'; end if;
  -- The first completed retarget owns the receipt. A redelivery must not undo
  -- a later command (nor write another activity or target edge).
  if saved.session_id is not null then return internal.bridge_view(p_bridge_id); end if;
  select * into b from public.bridges where entity_id = p_bridge_id for update;
  if b.target_id is distinct from (saved.plan->>'targetId')::uuid then
    perform internal.bridge_refuse('bridge_changed', 'this bridge moved while /new was starting; send /new session again');
  end if;
  select status into session_status from public.work_sessions where entity_id = p_session_id;
  -- Spawn's mutation ledger can replay an admitted session whose boot failed.
  -- An admission receipt alone must never move the group to that failed row.
  if session_status = 'spawning' then
    raise exception 'the new session is still starting; retrying' using errcode = 'XX000';
  end if;
  if session_status is null or session_status not in ('running', 'idle') then
    perform internal.bridge_refuse('session_not_live', 'the new session did not start successfully; the bridge is unchanged. Send /new session to try again');
  end if;
  teammate := internal.bridge_target_teammate('work_session', p_session_id);
  if teammate is distinct from (saved.plan->>'teamMemberId')::uuid then
    raise exception 'the spawned session must run as the selected teammate' using errcode = '22023';
  end if;
  perform public.bridge_managed_retarget(p_bridge_id, p_session_id, p_actor_id, 'new');
  -- /work, /new and the keeper prefer the bridge override. Update it in the
  -- SAME transaction as the target so it cannot keep pointing at the old team.
  update public.bridges set teammate_id = teammate where entity_id = p_bridge_id;
  update internal.bridge_session_starts set session_id = p_session_id where message_id = p_message_id;
  return internal.bridge_view(p_bridge_id);
end
$$;
revoke all on function public.bridge_new_session_finish(uuid, uuid, uuid, uuid) from public;
grant execute on function public.bridge_new_session_finish(uuid, uuid, uuid, uuid) to tm8_app;
reset role;
