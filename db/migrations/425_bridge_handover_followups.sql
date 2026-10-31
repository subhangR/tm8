-- =============================================================================
-- 425 — Bridges Q7/Q8 follow-ups: the hand-over list, accept's lock order, and
-- a reason without the group title. (Provisional number: on cut B, whose top is
-- 424_bridge_handover; the bridges merger assigns the final one.)
--
-- Design of record: BRIDGE-ENTITY-DESIGN.md §8 D55, D57, D78-D80, D81-D82.
-- Tasks 01a190c5-a326 (handoverId + list op, #1472's review) and
-- 01a19098-b9ea (lock order, #1455's review).
--
-- WHAT THIS FILE DOES
--   §1  bridges.handovers.list: a bridge's offers with the caller's roles and
--       what it may do (accept, decline, withdraw), computed here. Any session
--       that can read the bridge (entity_readable, pinned 227) may list.
--   §2  offer_bridge_handover and accept_bridge_handover, restated from 424's
--       latest bodies (the pin-first fix included), each change marked `425`:
--       the offer's attention reason drops the group title; accept locks both
--       connections before the bridge and the offer.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The list.
-- -----------------------------------------------------------------------------
create or replace function public.list_bridge_handovers(p_bridge_id uuid, p_status text default 'offered')
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; me uuid; acct uuid; admin boolean;
begin
  if p_status is null or p_status not in ('offered', 'all') then
    raise exception 'status is offered or all' using errcode = '22023';
  end if;
  -- Readable (pinned, 227) or it does not exist for this caller.
  if not internal.entity_readable(p_bridge_id) then
    raise exception 'bridge not found' using errcode = 'P0002';
  end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  me := internal.current_member_id(b.space_id);
  acct := internal.current_account_id();
  admin := internal.is_space_admin(b.space_id);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(item order by created_at desc, id desc) from (
      select h.created_at, h.id,
             internal.bridge_handover_json(h) || jsonb_build_object(
               'fromConnectionLabel', fc.label, 'toConnectionLabel', tc.label,
               'viewer', jsonb_build_object(
                 'roles', to_jsonb(array_remove(array[
                   case when me is not null and me = h.offered_by then 'offerer' end,
                   case when acct is not null and acct = tc.owner_account_id then 'receiver' end,
                   case when acct is not null and acct = fc.owner_account_id then 'from_owner' end,
                   case when admin then 'admin' end], null)),
                 'canAccept', h.status = 'offered' and me is not null and acct is not null and acct = tc.owner_account_id,
                 'canDecline', h.status = 'offered' and me is not null and acct is not null and acct = tc.owner_account_id,
                 'canWithdraw', h.status = 'offered' and me is not null
                                and (me = h.offered_by or acct = fc.owner_account_id or admin))) as item
        from public.bridge_handovers h
        join public.bridge_connections fc on fc.id = h.from_connection_id
        join public.bridge_connections tc on tc.id = h.to_connection_id
       where h.bridge_id = p_bridge_id and (p_status = 'all' or h.status = 'offered')
       order by h.created_at desc, h.id desc
       limit 100) x), '[]'::jsonb));
end
$$;
revoke all on function public.list_bridge_handovers(uuid, text) from public;
grant execute on function public.list_bridge_handovers(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §2. The doors, restated from 424.
-- -----------------------------------------------------------------------------
create or replace function public.offer_bridge_handover(
  p_bridge_id uuid,
  p_to_connection_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; e public.entities; b public.bridges; from_conn public.bridge_connections;
  to_conn public.bridge_connections; actor uuid; receiver uuid; open_id uuid; h public.bridge_handovers;
  r record;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.handover.offer');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_bridge_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_bridge_id, 'bridge');
  -- Pin first (227): a session pinned to another space is refused here, before
  -- any lock or state refusal, so it learns nothing about this space's offer.
  actor := internal.current_member_id(e.space_id);
  if actor is null then
    raise exception 'you can hand over a bridge only in a space you are a member of' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
  end if;
  select * into b from public.bridges where entity_id = p_bridge_id for update;
  if b.ended_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'this bridge was removed');
  end if;
  select * into from_conn from public.bridge_connections where id = b.connection_id;
  if from_conn.owner_account_id is distinct from internal.current_account_id()
     and not internal.is_space_admin(b.space_id) then
    raise exception 'only the connection''s owner or a space admin can hand a bridge over' using errcode = '42501',
      detail = jsonb_build_object('reason', 'admin_only')::text;
  end if;
  perform internal.bind_actor(actor);

  select * into to_conn from public.bridge_connections where id = p_to_connection_id;
  if to_conn.id is null or to_conn.status = 'removed' then
    raise exception 'bridge connection not found' using errcode = 'P0002';
  end if;
  if to_conn.id = b.connection_id then
    perform internal.bridge_refuse('same_connection', 'this bridge already rides that connection');
  end if;
  if to_conn.provider <> b.provider then
    raise exception 'a bridge moves only to a connection of its own provider (%)', b.provider using errcode = '22023';
  end if;
  if not exists (select 1 from public.space_credentials sc
                  where sc.bridge_connection_id = to_conn.id and sc.space_id = b.space_id and sc.status <> 'revoked') then
    perform internal.bridge_refuse('connection_not_offered',
      'that connection is not offered to this space; its owner offers it first: tm8 bridge connection offer <connection-id> --space <space-id>',
      jsonb_build_object('connectionId', to_conn.id));
  end if;
  receiver := internal.bridge_connection_member(to_conn.id, b.space_id);
  if receiver is null then
    raise exception 'that connection''s owner is not a member of this space' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
  end if;
  select id into open_id from public.bridge_handovers where bridge_id = b.entity_id and status = 'offered';
  if open_id is not null then
    perform internal.bridge_refuse('handover_pending',
      'this bridge already has an open hand-over; withdraw it first: tm8 bridge handover withdraw ' || open_id,
      jsonb_build_object('handoverId', open_id));
  end if;

  insert into public.bridge_handovers(bridge_id, space_id, from_connection_id, to_connection_id, offered_by)
  values (b.entity_id, b.space_id, b.connection_id, to_conn.id, actor)
  returning * into h;
  select * into r from internal.raise_attention_signal(b.space_id, b.entity_id, internal.bridge_handover_signal(h.id),
    -- 425: no group title (members set it, so it is not ours to put in a
    -- reason a client might read); the UI takes ids from bridges.handovers.list.
    format('%s offers you a bridge: it would move onto your number %s, keeping its history, handles and loops. Accept in tm8: tm8 bridge handover accept %s (or decline %s)',
           left(coalesce(internal.w2_entity_title(actor), 'A member'), 80), left(to_conn.label, 80), h.id, h.id),
    'normal', 'decide', actor);
  update public.attention_requests set assignee_id = receiver where id = r.request_id and assignee_id is null;

  return internal.ledger_record(p_client_mutation_id, 'bridges.handover.offer',
    internal.command_result(b.entity_id, null,
      internal.record_activity(b.space_id, b.entity_id, actor, 'updated', null,
        jsonb_build_object('kind', 'bridge', 'op', 'bridges.handover.offer', 'handoverId', h.id,
                           'fromConnectionId', h.from_connection_id, 'toConnectionId', h.to_connection_id)),
      array[b.entity_id]) || jsonb_build_object('handover', internal.bridge_handover_json(h)));
end
$$;
revoke all on function public.offer_bridge_handover(uuid, uuid, text) from public;
grant execute on function public.offer_bridge_handover(uuid, uuid, text) to tm8_app;

create or replace function public.accept_bridge_handover(
  p_handover_id uuid,
  p_live_conversation_ids text[],
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; h public.bridge_handovers; b public.bridges; to_conn public.bridge_connections;
  cred uuid; actor uuid; moved integer;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.handover.accept');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{handover,id}', p_handover_id::text, 'hand-over');
    return replay;
  end if;
  -- 425, lock order: both connections (in id order), then the bridge, then the
  -- offer. 423's remove_bridge_connection locks its connection and then the
  -- bridges on it, and remove_bridge locks a bridge and then its offer (424's
  -- lapse trigger): this order agrees with both. One path still runs the other
  -- way: a pause/resume/remove of the bridge marks its connection's allowlist
  -- dirty from a trigger (398), bridge before connection. Racing that, one side
  -- gets 40P01 and can retry; nothing is half-written.
  select * into h from public.bridge_handovers where id = p_handover_id;
  if h.id is null then raise exception 'hand-over not found' using errcode = 'P0002'; end if;
  -- Pin first (227): a session pinned to another space is refused here, before
  -- any lock or state refusal, so it learns nothing about this space's offer.
  actor := internal.current_member_id(h.space_id);
  if actor is null then
    raise exception 'you can accept a hand-over only in a space you are a member of' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
  end if;
  perform 1 from public.bridge_connections where id in (h.from_connection_id, h.to_connection_id)
   order by id for update;
  select * into b from public.bridges where entity_id = h.bridge_id for update;
  select * into h from public.bridge_handovers where id = p_handover_id for update;
  select * into to_conn from public.bridge_connections where id = h.to_connection_id;
  if to_conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the receiving connection''s owner can accept a hand-over' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  if h.status <> 'offered' then
    perform internal.bridge_refuse('handover_not_open', format('this hand-over was %s', h.status),
      jsonb_build_object('status', h.status));
  end if;
  perform internal.bind_actor(actor);

  if b.ended_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'this bridge was removed');
  end if;
  if b.connection_id <> h.from_connection_id then
    perform internal.bridge_refuse('handover_stale', 'this bridge has moved since the offer');
  end if;
  if to_conn.status = 'removed' then
    raise exception 'this connection was removed' using errcode = '22023';
  end if;
  select id into cred from public.space_credentials
   where bridge_connection_id = to_conn.id and space_id = h.space_id and status <> 'revoked';
  if cred is null then
    perform internal.bridge_refuse('connection_not_offered',
      'offer your connection to this space first: tm8 bridge connection offer <connection-id> --space <space-id>',
      jsonb_build_object('connectionId', to_conn.id));
  end if;
  if p_live_conversation_ids is null then
    raise exception 'accept needs the receiving number''s live group list' using errcode = '22023';
  end if;
  if not (b.external_conversation_id = any(p_live_conversation_ids)) then
    perform internal.bridge_refuse('not_in_group',
      'your number is not in this group, so it cannot carry the bridge; join the group with it first',
      jsonb_build_object('connectionId', to_conn.id));
  end if;

  -- One write (D55). The settle comes first: §3's guards admit the move only
  -- while this accept is in flight.
  h := internal.bridge_handover_settle(h.id, 'accepted', actor, 'accepted');
  update public.bridges set connection_id = to_conn.id, credential_id = cred where entity_id = b.entity_id;
  -- Both allowlists: the old one drops the group, the new one adds it. Each
  -- version is bumped here and again by the push that carries it (D35).
  update public.bridge_connections
     set allowlist_version = allowlist_version + 1, allowlist_dirty = true
   where id in (h.from_connection_id, h.to_connection_id);
  -- Rows not yet handed to the old runtime go out on the new number. Rows in
  -- flight (`dispatching`) settle on the old one; a retry finds the group off
  -- its allowlist and fails `not_connected` (398's take).
  update public.bridge_outbox set connection_id = to_conn.id
   where bridge_id = b.entity_id and connection_id = h.from_connection_id and status = 'pending';
  get diagnostics moved = row_count;
  -- D19's item to the old number's owner is one per connection (the watchdog
  -- raises it once, on its first bridge, and not again while down_since holds):
  -- it is done only when no live bridge rides that connection in any space.
  -- The admins' D56 items are per space: done once none rides it here.
  if not exists (select 1 from public.bridges where connection_id = h.from_connection_id and ended_at is null) then
    perform internal.clear_attention_signal(ar.space_id, ar.signal_key, null, 'handed over to another connection')
       from (select distinct space_id, signal_key from public.attention_requests
              where signal_key = 'bridge.runtime_down:' || h.from_connection_id
                and status in ('open', 'acknowledged')) ar;
  end if;
  perform internal.bridge_clear_connection_down(h.from_connection_id, b.space_id, true);

  return internal.ledger_record(p_client_mutation_id, 'bridges.handover.accept',
    internal.command_result(b.entity_id, null,
      internal.record_activity(b.space_id, b.entity_id, actor, 'updated', null,
        jsonb_build_object('kind', 'bridge', 'op', 'bridges.handover.accept', 'handoverId', h.id,
                           'fromConnectionId', h.from_connection_id, 'toConnectionId', h.to_connection_id,
                           'readdressed', moved)),
      array[b.entity_id]) || jsonb_build_object('handover', internal.bridge_handover_json(h), 'readdressed', moved));
end
$$;
revoke all on function public.accept_bridge_handover(uuid, text[], text) from public;
grant execute on function public.accept_bridge_handover(uuid, text[], text) to tm8_app;

reset role;
