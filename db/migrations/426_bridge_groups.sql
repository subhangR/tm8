-- =============================================================================
-- 426 — Bridges make groups: /split (a new group from people in this one) and
-- /invite (add people to this group), run through the bridge's own number.
--
-- Builds on 395 (bridges, create_bridge's row shape), 421/423 (the credential
-- the guard fills from the connection's live offer) and 425 (the managed
-- doors). Research: tm8 doc 01a1932d-ccef-7652-b8f1-b42d33186711.
--
-- WHAT THIS FILE DOES
--   §1  bridge_splits: one row per /split command message — the group it made
--       and the bridge that connects it — so a redelivered or swept command
--       never makes a second WhatsApp group (the group is made on WhatsApp
--       BEFORE this row can exist; the executor reads it first and records
--       the conversation as soon as WhatsApp answers).
--   §2  public.bridge_runtime_of (which runtime to ask), and
--       public.bridge_split_record / public.bridge_split_connect (bridges
--       worker only): record the new group, then connect it — a new bridge on
--       the same number, in the same space, copying the parent bridge's
--       policy, teammate, purpose, quiet hours and worker settings, and
--       landing on the session the server started for it. The parent's
--       connection must still be offered to the space (the credential guard
--       of 421/423 fills credential_id from that offer, as on create).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The record.
-- -----------------------------------------------------------------------------
create table public.bridge_splits (
  message_id      uuid primary key references public.messages(entity_id) on delete cascade,
  from_bridge_id  uuid not null references public.bridges(entity_id) on delete cascade,
  conversation_id text not null check (char_length(conversation_id) between 1 and 256),
  title           text not null check (char_length(btrim(title)) between 1 and 200),
  bridge_id       uuid references public.bridges(entity_id) on delete set null,
  created_at      timestamptz not null default now()
);
create index bridge_splits_from_idx on public.bridge_splits(from_bridge_id, created_at desc);
alter table public.bridge_splits enable row level security;
-- No policy and no grant: written and read only by the definers below.

comment on table public.bridge_splits is
  '426: the WhatsApp group a /split command made, and the bridge that connects it; '
  'keyed by the command message so a retried command never makes a second group.';

-- -----------------------------------------------------------------------------
-- §2. The doors.
-- -----------------------------------------------------------------------------

-- What a /split already did, if anything: null, or {conversationId, title, bridgeId}.
-- Refuses anyone but the bridges worker, like the other split doors (a quiet
-- null would read as "nothing made yet").
create or replace function public.bridge_split_of(p_message_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  return (select jsonb_build_object('conversationId', s.conversation_id, 'title', s.title, 'bridgeId', s.bridge_id)
            from public.bridge_splits s where s.message_id = p_message_id);
end
$$;
revoke all on function public.bridge_split_of(uuid) from public;
grant execute on function public.bridge_split_of(uuid) to tm8_app;

-- Which runtime runs a connection (the hub's address for a group request).
create or replace function public.bridge_runtime_of(p_connection_id uuid) returns text
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare rid text;
begin
  perform internal.require_bridges_worker();
  select c.runtime_id into rid from public.bridge_connections c where c.id = p_connection_id and c.status = 'linked';
  return rid;
end
$$;
revoke all on function public.bridge_runtime_of(uuid) from public;
grant execute on function public.bridge_runtime_of(uuid) to tm8_app;

-- The group exists on WhatsApp: remember it before anything else can fail.
create or replace function public.bridge_split_record(
  p_message_id uuid, p_from_bridge_id uuid, p_conversation_id text, p_title text
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  insert into public.bridge_splits(message_id, from_bridge_id, conversation_id, title)
  values (p_message_id, p_from_bridge_id, p_conversation_id, left(btrim(p_title), 200))
  on conflict (message_id) do nothing;
end
$$;
revoke all on function public.bridge_split_record(uuid, uuid, text, text) from public;
grant execute on function public.bridge_split_record(uuid, uuid, text, text) to tm8_app;

-- Connect the recorded group: a new bridge on the parent's number, landing on
-- p_target_id (the session the server just started for it). Idempotent on the
-- command message. Returns {bridgeId, replayed}.
create or replace function public.bridge_split_connect(
  p_message_id uuid, p_target_id uuid, p_actor_id uuid, p_member_count integer
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  s public.bridge_splits; parent public.bridges; parent_e public.entities; target public.entities;
  actor uuid; new_id uuid; b public.bridges; v_constraint text;
begin
  perform internal.require_bridges_worker();
  select * into s from public.bridge_splits where message_id = p_message_id for update;
  if s.message_id is null then raise exception 'no recorded split for this message' using errcode = 'P0002'; end if;
  if s.bridge_id is not null then return jsonb_build_object('bridgeId', s.bridge_id, 'replayed', true); end if;

  select * into parent from public.bridges where entity_id = s.from_bridge_id;
  select * into parent_e from public.entities where id = s.from_bridge_id;
  if parent.entity_id is null or parent.ended_at is not null or parent_e.deleted_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'the group this was split from is no longer connected');
  end if;
  select * into target from public.entities where id = p_target_id;
  if target.id is null or target.deleted_at is not null or target.space_id <> parent.space_id
     or target.kind not in ('chat', 'work_session') then
    raise exception 'the new group must land on a chat or session in the bridge''s space' using errcode = '22023';
  end if;
  perform internal.bridge_assert_target_free(p_target_id, null);
  select m.entity_id into actor from public.members m
   where m.entity_id = p_actor_id and m.space_id = parent.space_id and m.status = 'active';
  actor := coalesce(actor, parent_e.created_by);

  new_id := internal.create_envelope(parent.space_id, 'bridge', actor, null, null);
  begin
    insert into public.bridges(entity_id, space_id, provider, connection_id, credential_id,
                               external_conversation_id, conversation, target_kind, target_id, policy,
                               retention_days, teammate_id, purpose, quiet_hours, worker_posting, worker_wake)
    values (new_id, parent.space_id, parent.provider, parent.connection_id, null,
            s.conversation_id,
            jsonb_build_object('kind', 'group', 'title', s.title,
                               'memberCount', case when p_member_count is null then 'null'::jsonb else to_jsonb(p_member_count) end),
            target.kind, target.id,
            -- A new group is a group: the parent's policy, but never a channel's.
            case when parent.target_kind = 'channel' then internal.bridge_default_policy(target.kind, 'group')
                 else parent.policy end,
            parent.retention_days, parent.teammate_id, parent.purpose, parent.quiet_hours,
            parent.worker_posting, parent.worker_wake)
    returning * into b;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform internal.bridge_reraise_unique(v_constraint);
  end;
  perform internal.bridge_write_target_edge(b, actor);
  perform internal.record_initial_version(new_id, actor);
  perform internal.record_activity(parent.space_id, new_id, actor, 'created', null,
    jsonb_build_object('kind', 'bridge', 'provider', parent.provider, 'splitFrom', parent.entity_id));
  update public.bridge_splits set bridge_id = new_id where message_id = p_message_id;
  return jsonb_build_object('bridgeId', new_id, 'replayed', false);
end
$$;
revoke all on function public.bridge_split_connect(uuid, uuid, uuid, integer) from public;
grant execute on function public.bridge_split_connect(uuid, uuid, uuid, integer) to tm8_app;

reset role;

analyze public.bridge_splits;
