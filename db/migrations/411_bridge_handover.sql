-- =============================================================================
-- 411 — Bridges Q7/Q8: hand-over (D55) and no automatic failover (D56).
-- (Provisional number: main's max was 407 when this lane started; it is
-- stacked on #1427 (its 405/406 sit at 408/409 here) and #1443 (its 407 sits at
-- 410 here). The bridges merger assigns the final one; this file must stay
-- after #1443's, whose bridge_credential_guard it restates.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §8 D55, D56,
-- and this lane's D57, D78–D80. Task 01a189db-3911-729c-ab74-5510b5ebba9f.
-- Builds on 395 (schema), 398 (allowlist, outbox, watchdog) and #1427's 408
-- (the connection credential, D32) and #1443's 410 (the connection lifecycle).
--
-- WHAT THIS FILE DOES
--   §1  bridge_handovers: one open offer per bridge, from the bridge's
--       connection to another member's connection offered to the same space;
--   §2  the doors, all human-only (D9: never from WhatsApp):
--         offer    the current connection's owner or a space admin;
--         accept   only the receiving connection's owner, with the receiving
--                  number's LIVE group list (asked of its runtime by the
--                  handler, never stored); refused `not_in_group` when the
--                  conversation is not in it. One transaction moves
--                  connection_id and credential_id, bumps BOTH connections'
--                  allowlists, and re-addresses the outbox rows still pending;
--         decline  the receiving connection's owner;
--         withdraw the offerer, the current connection's owner or an admin;
--       plus the receiving-side read the accept handler starts from;
--   §3  395's guard_bridge_row and 408's bridge_credential_guard, restated from
--       their latest definitions with one arm each: the connection (and its
--       credential) may change only inside an accept of this transaction;
--   §4  a removed bridge lapses its open offer;
--   §5  D56: a connection going offline or logged out raises an fyi to every
--       space admin (beside D19's own to the owner) naming the hand-over; it
--       clears when the connection is linked again;
--   §6  an outbox insert racing an accept rides the bridge's committed
--       connection (a share lock on the bridge row).
--
-- WHAT IT NEVER DOES. Nothing here picks another number by itself (D56): the
-- only path that changes a bridge's connection is an accept by the receiving
-- number's owner. D20's unique (space, provider, conversation) is untouched:
-- it is one bridge before and after.
--
-- REFUSALS. TBC01 -> `conflict` with details.reason: `handover_pending`,
-- `handover_not_open`, `handover_stale`, `not_in_group`,
-- `connection_not_offered`, `same_connection`, `bridge_ended`. 42501 with
-- `not_connection_owner`, `not_space_member`, `admin_only`.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The offer.
-- -----------------------------------------------------------------------------
create table public.bridge_handovers (
  id                 uuid primary key default internal.new_id(),
  bridge_id          uuid not null references public.bridges(entity_id) on delete cascade,
  space_id           uuid not null references public.spaces(id) on delete cascade,
  from_connection_id uuid not null references public.bridge_connections(id),
  to_connection_id   uuid not null references public.bridge_connections(id),
  -- The offerer's and the settler's member entities.
  offered_by         uuid not null references public.entities(id),
  status             text not null default 'offered'
                     check (status in ('offered', 'accepted', 'declined', 'withdrawn', 'lapsed')),
  created_at         timestamptz not null default now(),
  settled_at         timestamptz,
  settled_by         uuid references public.entities(id),
  check (from_connection_id <> to_connection_id),
  check ((status = 'offered') = (settled_at is null))
);
create unique index bridge_handovers_one_open on public.bridge_handovers(bridge_id) where status = 'offered';
create index bridge_handovers_to_open on public.bridge_handovers(to_connection_id) where status = 'offered';
create index bridge_handovers_bridge_recent on public.bridge_handovers(bridge_id, created_at desc);

-- Readable with its bridge (218's shape, like every table hung on a bridge).
alter table public.bridge_handovers enable row level security;
create policy bridge_handovers_select on public.bridge_handovers for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_handovers.bridge_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_handovers to tm8_app;

-- The contract's view of one offer.
create or replace function internal.bridge_handover_json(h public.bridge_handovers)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', h.id, 'bridgeId', h.bridge_id, 'spaceId', h.space_id,
    'fromConnectionId', h.from_connection_id, 'toConnectionId', h.to_connection_id,
    'offeredBy', h.offered_by, 'status', h.status, 'createdAt', h.created_at,
    'settledAt', h.settled_at, 'settledBy', h.settled_by)
$$;
revoke all on function internal.bridge_handover_json(public.bridge_handovers) from public;

-- The active member in this space whose account owns the connection.
create or replace function internal.bridge_connection_member(p_connection_id uuid, p_space_id uuid)
returns uuid language sql stable security definer set search_path = public, internal, pg_temp as $$
  select m.entity_id from public.bridge_connections c
    join public.accounts a on a.id = c.owner_account_id
    join public.members m on m.identity_id = a.identity_id and m.space_id = p_space_id and m.status = 'active'
   where c.id = p_connection_id
   order by m.entity_id limit 1
$$;
revoke all on function internal.bridge_connection_member(uuid, uuid) from public;

-- An offer's attention item: one per offer, on the bridge, to the receiver.
create or replace function internal.bridge_handover_signal(p_handover_id uuid) returns text
language sql immutable as $$ select 'bridge.handover:' || p_handover_id $$;

-- Settle an open offer and clear its attention item.
create or replace function internal.bridge_handover_settle(p_handover_id uuid, p_status text, p_by uuid, p_note text)
returns public.bridge_handovers language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare h public.bridge_handovers;
begin
  update public.bridge_handovers set status = p_status, settled_at = now(), settled_by = p_by
   where id = p_handover_id and status = 'offered' returning * into h;
  if h.id is not null then
    perform internal.clear_attention_signal(h.space_id, internal.bridge_handover_signal(h.id), h.bridge_id, p_note);
  end if;
  return h;
end
$$;
revoke all on function internal.bridge_handover_settle(uuid, text, uuid, text) from public;

-- -----------------------------------------------------------------------------
-- §2. The doors.
-- -----------------------------------------------------------------------------

-- bridges.handover.offer: the current connection's owner or a space admin
-- offers the bridge to another member's connection that is offered to this
-- space (it will ride that credential, D32). The receiver gets an attention
-- item naming the accept.
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
  actor := internal.current_member_id(b.space_id);
  if actor is null then
    raise exception 'you can hand over a bridge only in a space you are a member of' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
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
    format('%s offers you the bridge to "%s": it would move onto your number %s, keeping its history, handles and loops. Accept in tm8: tm8 bridge handover accept %s (or decline %s)',
           coalesce(internal.w2_entity_title(actor), 'A member'), b.conversation ->> 'title', to_conn.label, h.id, h.id),
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

-- The receiving side, for the accept handler: which runtime to ask for the
-- receiving number's live groups. Only that number's owner reads it.
create or replace function public.bridge_handover_receiving(p_handover_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare h public.bridge_handovers; conn public.bridge_connections; b public.bridges;
begin
  perform internal.require_human_auth_kind();
  select * into h from public.bridge_handovers where id = p_handover_id;
  if h.id is null then raise exception 'hand-over not found' using errcode = 'P0002'; end if;
  select * into conn from public.bridge_connections where id = h.to_connection_id;
  if conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the receiving connection''s owner can do this' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  select * into b from public.bridges where entity_id = h.bridge_id;
  return internal.bridge_handover_json(h) || jsonb_build_object(
    'runtimeId', conn.runtime_id, 'connectionStatus', conn.status, 'conversationId', b.external_conversation_id);
end
$$;
revoke all on function public.bridge_handover_receiving(uuid) from public;
grant execute on function public.bridge_handover_receiving(uuid) to tm8_app;

-- True only inside the accept that is moving this bridge from p_from to p_to,
-- in this transaction (§3's guards).
create or replace function internal.bridge_handover_moving(p_bridge uuid, p_from uuid, p_to uuid)
returns boolean language sql stable security definer set search_path = public, internal, pg_temp as $$
  select exists (select 1 from public.bridge_handovers h
                  where h.bridge_id = p_bridge and h.from_connection_id = p_from and h.to_connection_id = p_to
                    and h.status = 'accepted' and h.settled_at = now())
$$;
revoke all on function internal.bridge_handover_moving(uuid, uuid, uuid) from public;

-- bridges.handover.accept: the receiving number's owner, in tm8. The handler
-- passes the receiving number's live group list, asked of its runtime just
-- now (D28: never stored); the bridge's conversation must be in it.
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
  -- Lock order: the bridge, then the offer, then the connection. remove_bridge
  -- (and 410's connection remove) lock the bridge and then, through §4's lapse
  -- trigger, the offer; the same order here cannot deadlock against them.
  select * into h from public.bridge_handovers where id = p_handover_id;
  if h.id is null then raise exception 'hand-over not found' using errcode = 'P0002'; end if;
  select * into b from public.bridges where entity_id = h.bridge_id for update;
  select * into h from public.bridge_handovers where id = p_handover_id for update;
  select * into to_conn from public.bridge_connections where id = h.to_connection_id for update;
  if to_conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the receiving connection''s owner can accept a hand-over' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  if h.status <> 'offered' then
    perform internal.bridge_refuse('handover_not_open', format('this hand-over was %s', h.status),
      jsonb_build_object('status', h.status));
  end if;
  actor := internal.current_member_id(h.space_id);
  if actor is null then
    raise exception 'you can accept a hand-over only in a space you are a member of' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
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

-- decline (the receiving number's owner) and withdraw (the offerer, the
-- current connection's owner, or a space admin): settle without a move.
create or replace function internal.bridge_handover_close(
  p_op text, p_handover_id uuid, p_client_mutation_id text
) returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare replay jsonb; h public.bridge_handovers; from_owner uuid; to_owner uuid; actor uuid;
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, p_op);
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{handover,id}', p_handover_id::text, 'hand-over');
    return replay;
  end if;
  select * into h from public.bridge_handovers where id = p_handover_id for update;
  if h.id is null then raise exception 'hand-over not found' using errcode = 'P0002'; end if;
  select owner_account_id into from_owner from public.bridge_connections where id = h.from_connection_id;
  select owner_account_id into to_owner from public.bridge_connections where id = h.to_connection_id;
  actor := internal.current_member_id(h.space_id);
  if p_op = 'bridges.handover.decline' then
    if to_owner is distinct from internal.current_account_id() then
      raise exception 'only the receiving connection''s owner can decline a hand-over' using errcode = '42501',
        detail = jsonb_build_object('reason', 'not_connection_owner')::text;
    end if;
  elsif not (actor is not null and actor = h.offered_by)
        and from_owner is distinct from internal.current_account_id()
        and not internal.is_space_admin(h.space_id) then
    raise exception 'only who offered it, the connection''s owner or a space admin can withdraw a hand-over'
      using errcode = '42501', detail = jsonb_build_object('reason', 'admin_only')::text;
  end if;
  if h.status <> 'offered' then
    perform internal.bridge_refuse('handover_not_open', format('this hand-over was %s', h.status),
      jsonb_build_object('status', h.status));
  end if;
  if actor is null then
    raise exception 'you are not a member of this space' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_space_member')::text;
  end if;
  perform internal.bind_actor(actor);
  h := internal.bridge_handover_settle(h.id,
    case p_op when 'bridges.handover.decline' then 'declined' else 'withdrawn' end, actor,
    case p_op when 'bridges.handover.decline' then 'declined' else 'withdrawn' end);
  return internal.ledger_record(p_client_mutation_id, p_op,
    internal.command_result(h.bridge_id, null,
      internal.record_activity(h.space_id, h.bridge_id, actor, 'updated', null,
        jsonb_build_object('kind', 'bridge', 'op', p_op, 'handoverId', h.id)),
      array[h.bridge_id]) || jsonb_build_object('handover', internal.bridge_handover_json(h)));
end
$$;
revoke all on function internal.bridge_handover_close(text, uuid, text) from public;

create or replace function public.decline_bridge_handover(p_handover_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_human_auth_kind();
  return internal.bridge_handover_close('bridges.handover.decline', p_handover_id, p_client_mutation_id);
end
$$;
create or replace function public.withdraw_bridge_handover(p_handover_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_human_auth_kind();
  return internal.bridge_handover_close('bridges.handover.withdraw', p_handover_id, p_client_mutation_id);
end
$$;
revoke all on function public.decline_bridge_handover(uuid, text) from public;
revoke all on function public.withdraw_bridge_handover(uuid, text) from public;
grant execute on function public.decline_bridge_handover(uuid, text) to tm8_app;
grant execute on function public.withdraw_bridge_handover(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. The guards: a bridge's connection and credential stay fixed, except
-- inside an accept (§2). Restated from their latest definitions, each change
-- marked `411 (D55)`:
--   * guard_bridge_row: 395's (main has no later one);
--   * bridge_credential_guard: #1427's (B1b-5, here 408) PLUS #1443's (B1b-7,
--     407_bridge_connection_lifecycle @ 087fe8422, here 410) `owner_not_member` arm,
--     marked `407 (B1b-7)`, so this body is right whichever merges first. A
--     later restatement must carry all three.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_bridge_row() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare target public.entities; conn public.bridge_connections;
begin
  perform internal.validate_bridge_policy(new.policy);
  perform internal.validate_bridge_conversation(new.conversation);
  perform internal.validate_bridge_quiet_hours(new.quiet_hours);
  if new.quiet_hours is not null and jsonb_typeof(new.quiet_hours) = 'null' then new.quiet_hours := null; end if;
  select * into target from public.entities where id = new.target_id;
  if target.id is null or target.space_id <> new.space_id or target.kind <> new.target_kind then
    raise exception 'bridge target must be a % in the bridge''s space', new.target_kind using errcode = '23514';
  end if;
  select * into conn from public.bridge_connections where id = new.connection_id;
  if conn.provider is distinct from new.provider then
    raise exception 'bridge provider must match its connection' using errcode = '23514';
  end if;
  if new.teammate_id is not null and not exists (
       select 1 from public.entities where id = new.teammate_id and kind = 'team_member' and space_id = new.space_id) then
    raise exception 'bridge teammate must be a teammate in the bridge''s space' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.space_id <> old.space_id or new.provider <> old.provider
                           -- 411 (D55): only an accept in flight moves the connection.
                           or (new.connection_id <> old.connection_id
                               and not internal.bridge_handover_moving(new.entity_id, old.connection_id, new.connection_id))
                           or new.external_conversation_id <> old.external_conversation_id) then
    raise exception 'a bridge''s space, provider, connection and conversation are fixed' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.ended_at is not null then
    raise exception 'this bridge was removed' using errcode = 'TBC01',
      detail = jsonb_build_object('reason', 'bridge_ended')::text;
  end if;
  return new;
end
$$;
revoke all on function internal.guard_bridge_row() from public;

create or replace function internal.bridge_credential_guard() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare cred public.space_credentials;
begin
  if tg_op = 'INSERT' then
    if new.credential_id is null then
      select * into cred from public.space_credentials
       where bridge_connection_id = new.connection_id and space_id = new.space_id and status <> 'revoked';
      if cred.id is null then
        perform internal.bridge_refuse('connection_not_offered',
          'offer this connection to the space first: tm8 bridge connection offer <connection-id> --space <space-id>',
          jsonb_build_object('connectionId', new.connection_id));
      end if;
      new.credential_id := cred.id;
    else
      select * into cred from public.space_credentials where id = new.credential_id;
      if cred.id is null or cred.bridge_connection_id is distinct from new.connection_id
         or cred.space_id <> new.space_id or cred.status = 'revoked' then
        raise exception 'a bridge rides the credential offered for its connection in its space' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.credential_id is distinct from old.credential_id then
    -- 411 (D55): an accept in flight moves the credential with the connection,
    -- onto the live offer for the new connection in this space.
    if not internal.bridge_handover_moving(new.entity_id, old.connection_id, new.connection_id) then
      raise exception 'a bridge''s credential is fixed' using errcode = '42501';
    end if;
    select * into cred from public.space_credentials where id = new.credential_id;
    if cred.id is null or cred.bridge_connection_id is distinct from new.connection_id
       or cred.space_id <> new.space_id or cred.status = 'revoked' then
      raise exception 'a bridge rides the credential offered for its connection in its space' using errcode = '23514';
    end if;
  end if;
  -- 407 (B1b-7): the owner of the number left the space (§2.5). Checked first: it is the
  -- reason to name, since leaving also revoked the offer.
  if old.paused_at is not null and new.paused_at is null and new.ended_at is null
     and not exists (select 1 from public.bridge_connections c
                       join public.accounts a on a.id = c.owner_account_id
                       join public.members m on m.identity_id = a.identity_id
                      where c.id = new.connection_id and m.space_id = new.space_id and m.status = 'active') then
    perform internal.bridge_refuse('owner_not_member',
      'the owner of this bridge''s number is no longer a member of the space; it stays paused');
  end if;
  if old.paused_at is not null and new.paused_at is null and new.ended_at is null
     and exists (select 1 from public.space_credentials sc where sc.id = new.credential_id and sc.status = 'revoked') then
    perform internal.bridge_refuse('connection_withdrawn',
      'this bridge''s connection was withdrawn from the space; its owner can offer it again, then resume');
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_credential_guard() from public;

-- -----------------------------------------------------------------------------
-- §4. A removed bridge lapses its open offer.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_handover_lapse() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare h uuid;
begin
  for h in select id from public.bridge_handovers where bridge_id = new.entity_id and status = 'offered' loop
    perform internal.bridge_handover_settle(h, 'lapsed', null, 'the bridge was removed');
  end loop;
  return null;
end
$$;
revoke all on function internal.bridge_handover_lapse() from public;
create trigger bridges_handover_lapse after update of ended_at on public.bridges
  for each row when (new.ended_at is not null and old.ended_at is null)
  execute function internal.bridge_handover_lapse();

-- -----------------------------------------------------------------------------
-- §5. D56: no automatic failover; the admins hear of it and can hand over.
-- -----------------------------------------------------------------------------

-- Clear the admins' down items for a connection: in one space (p_only_if_empty:
-- only once no live bridge rides it there), or everywhere (p_space null).
create or replace function internal.bridge_clear_connection_down(
  p_connection_id uuid, p_space_id uuid, p_only_if_empty boolean
) returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r record; n integer := 0;
begin
  if p_only_if_empty and exists (select 1 from public.bridges
                                  where connection_id = p_connection_id and space_id = p_space_id and ended_at is null) then
    return 0;
  end if;
  for r in select distinct ar.space_id, ar.entity_id, ar.signal_key from public.attention_requests ar
            where ar.signal_key like 'bridge.connection_down:' || p_connection_id || ':%'
              and ar.status in ('open', 'acknowledged')
              and (p_space_id is null or ar.space_id = p_space_id) loop
    n := n + internal.clear_attention_signal(r.space_id, r.signal_key, r.entity_id,
           case when p_only_if_empty then 'its bridges were handed over' else 'the connection is linked again' end);
  end loop;
  return n;
end
$$;
revoke all on function internal.bridge_clear_connection_down(uuid, uuid, boolean) from public;

-- Whichever path marks a connection down (the watchdog's silent runtime, a
-- `state` or `heartbeat` frame saying offline or logged out), every active
-- admin of each space it serves gets one fyi, on the first live bridge there,
-- naming the hand-over. The connection's owner already has D19's own item
-- from the watchdog and is not asked twice. Linked again: they clear.
create or replace function internal.bridge_connection_down_admins() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare s record; a record; r record; owner_identity text; how text;
begin
  if new.status in ('offline', 'logged_out') and old.status not in ('offline', 'logged_out') then
    select identity_id into owner_identity from public.accounts where id = new.owner_account_id;
    how := case new.status when 'logged_out' then 'logged out' else 'offline' end;
    for s in select b.space_id, count(*) as n,
                    (array_agg(b.entity_id order by b.created_at, b.entity_id))[1] as first_bridge
               from public.bridges b join public.entities e on e.id = b.entity_id and e.deleted_at is null
              where b.connection_id = new.id and b.ended_at is null
              group by b.space_id loop
      for a in select m.entity_id from public.members m
                where m.space_id = s.space_id and m.status = 'active' and m.role in ('owner', 'admin')
                  and m.identity_id is distinct from owner_identity
                order by m.entity_id loop
        select * into r from internal.raise_attention_signal(s.space_id, s.first_bridge,
          'bridge.connection_down:' || new.id || ':' || a.entity_id,
          format('The %s connection is %s, so %s on it %s degraded. Nothing moves to another number by itself. '
                 'To keep a group served, hand its bridge to a member whose number is in the group: '
                 'tm8 bridge handover offer %s --to <their-connection-id>',
                 new.label, how,
                 case when s.n = 1 then 'the bridge' else s.n || ' bridges' end,
                 case when s.n = 1 then 'is' else 'are' end,
                 case when s.n = 1 then s.first_bridge::text else '<bridge-id>' end),
          'fyi', 'review', a.entity_id);
        update public.attention_requests set assignee_id = a.entity_id where id = r.request_id and assignee_id is null;
      end loop;
    end loop;
  -- Any arrival at `linked` clears: a re-link goes logged_out -> connecting ->
  -- linked (begin_bridge_connection, then the runtime's state frame), and a
  -- reconnect may report `connecting` first. A clear with nothing open is a no-op.
  elsif new.status = 'linked' and old.status <> 'linked' then
    perform internal.bridge_clear_connection_down(new.id, null, false);
  end if;
  return null;
end
$$;
revoke all on function internal.bridge_connection_down_admins() from public;
create trigger bridge_connections_down_admins after update of status on public.bridge_connections
  for each row when (new.status is distinct from old.status)
  execute function internal.bridge_connection_down_admins();

-- -----------------------------------------------------------------------------
-- §6. An enqueue racing an accept follows the bridge (D78).
-- -----------------------------------------------------------------------------
-- internal.bridge_outbox_enqueue reads bridges.connection_id without a lock. In
-- READ COMMITTED an enqueue that read the old connection before an accept
-- committed, and inserts after the accept's re-address ran, would land on the
-- old number and fail `not_connected`. Before every insert this takes a share
-- lock on the bridge row: it waits for an accept in flight (FOR UPDATE) and
-- then reads its committed connection; an enqueue that locks first makes the
-- accept wait until it commits, so the re-address then sees its row. A row
-- still to be dispatched rides the bridge's connection as it is now.
create or replace function internal.bridge_outbox_follow_connection() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare cur uuid;
begin
  select connection_id into cur from public.bridges where entity_id = new.bridge_id for share;
  if new.status = 'pending' and cur is not null and new.connection_id is distinct from cur then
    new.connection_id := cur;
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_outbox_follow_connection() from public;
create trigger bridge_outbox_follow_connection before insert on public.bridge_outbox
  for each row execute function internal.bridge_outbox_follow_connection();

reset role;

analyze public.bridge_handovers;
