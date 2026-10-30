-- =============================================================================
-- 401 — Bridges B1b-4: the command executor's server-only doors.
-- (Provisional number: the bridges merger assigns the final one at merge.)
--
-- Design of record: docs/features/bridges/BRIDGES-V2-DESIGN.md §4.1-§4.6, §5
-- (bridge_command_confirms) and BRIDGE-ENTITY-DESIGN.md §2.3 step 2. Task
-- 01a189f3-b4ae-7e08-aa17-2b12088292c2.
--
-- Depends on B0a (395, the bridge tables). The command state columns and the
-- claim/settle doors are B1b-2's, on message_origins; this file only READS
-- them (the sweep), dynamically, so it applies before or after theirs.
--
-- WHAT THIS FILE DOES
--   §1  the gate: every door answers only internal.is_bridges_worker()
--       (B1b-2's 'bridges.runtime' claim, the 375 pattern);
--   §2  public.bridge_command_input / bridge_command_context /
--       bridge_commands_due: one stored command, the bridge's facts and the
--       sender's role, and the sweep's due read, across spaces;
--   §3  public.bridge_command_guest_list: a guest's provenance list (members
--       read under their own claims);
--   §4  bridge_command_confirms (v2 §5) and its doors: open a confirm for a
--       notice, ask whether a YES answers one (the inbound door's detect), and
--       take it (one use, same sender, 2 minutes).
--
-- Every command still RUNS as the linked member, through the member's own
-- claims and the ordinary catalog RPCs; nothing here writes the graph.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The gate. Every door here answers only the in-process bridges worker:
--     internal.is_bridges_worker() (B1b-2's migration: the closed-list
--     background-job claim 'bridges.runtime', which no request can bind; the
--     375 loops pattern). Resolved when a door RUNS, so this file applies
--     before or after B1b-2's.
-- -----------------------------------------------------------------------------
create or replace function internal.require_bridge_commands_worker()
returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if not coalesce(internal.is_bridges_worker(), false) then
    raise exception 'only the in-process bridges worker reads this'
      using errcode = '42501', detail = jsonb_build_object('reason', 'not_bridges_worker')::text;
  end if;
end
$$;
revoke all on function internal.require_bridge_commands_worker() from public;

-- -----------------------------------------------------------------------------
-- §2. What run(input) needs beyond B1b-2's BridgeCommandInput, across spaces,
--     in one read: the bridge's facts, the sender's member role, and which of
--     our own messages a reply quotes. Null when the bridge is gone.
-- -----------------------------------------------------------------------------
create or replace function public.bridge_command_context(
  p_bridge_id uuid, p_member_id uuid, p_reply_to_external_id text)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  e public.entities;
  v_role text;
  v_status text;
  reply_message uuid;
  reply_direction text;
  muted_until timestamptz;
begin
  perform internal.require_bridge_commands_worker();
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then return null; end if;
  -- B1b-2's /mute column; read so this file applies before or after theirs.
  begin
    execute 'select muted_until from public.bridges where entity_id = $1' into muted_until using p_bridge_id;
  exception when undefined_column then
    muted_until := null;
  end;
  select * into e from public.entities where id = p_bridge_id;
  if p_member_id is not null then
    select mb.role, mb.status into v_role, v_status
      from public.members mb where mb.entity_id = p_member_id and mb.space_id = b.space_id;
  end if;
  if p_reply_to_external_id is not null then
    select r.message_id, r.direction into reply_message, reply_direction
      from public.message_origins r
     where r.bridge_id = p_bridge_id and r.external_message_id = p_reply_to_external_id
     order by (r.direction = 'out') desc
     limit 1;
  end if;
  return jsonb_build_object(
    'bridgeId', b.entity_id,
    'spaceId', b.space_id,
    'provider', b.provider,
    'title', coalesce(b.conversation ->> 'title', ''),
    'targetKind', b.target_kind,
    'targetId', b.target_id,
    'teammateId', b.teammate_id,
    'targetTeammateId', case when b.target_kind = 'chat'
      then (select c.teammate_id from public.chats c where c.entity_id = b.target_id) end,
    'targetTitle', internal.bridge_target_title(b.target_kind, b.target_id),
    'whoMayTrigger', b.policy ->> 'whoMayTrigger',
    'direction', b.policy ->> 'direction',
    'trigger', b.policy ->> 'trigger',
    'mutedUntil', muted_until,
    'pausedAt', b.paused_at,
    'endedAt', b.ended_at,
    'deleted', e.deleted_at is not null,
    'memberRole', case when v_status = 'active' then v_role end,
    'replyTo', case when p_reply_to_external_id is null then null else jsonb_build_object(
      'messageId', reply_message, 'direction', reply_direction) end);
end
$$;
revoke all on function public.bridge_command_context(uuid, uuid, text) from public;
grant execute on function public.bridge_command_context(uuid, uuid, text) to tm8_app;

-- One stored command, as run(messageId) needs it: B1b-2 stores the message and
-- its origin and marks it pending; the executor loads the rest from here, so
-- the sweep can re-run a command from its id alone. The author is resolved
-- NOW (395's resolver), so a link revoked since receipt counts as revoked.
create or replace function public.bridge_command_input(p_message_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  o public.message_origins;
  m public.messages;
  b public.bridges;
begin
  perform internal.require_bridge_commands_worker();
  select * into o from public.message_origins where message_id = p_message_id and direction = 'in';
  if o.message_id is null then return null; end if;
  select * into m from public.messages where entity_id = p_message_id;
  select * into b from public.bridges where entity_id = o.bridge_id;
  return jsonb_build_object(
    'bridgeId', o.bridge_id,
    'spaceId', b.space_id,
    'connectionId', o.connection_id,
    'messageId', o.message_id,
    'externalMessageId', o.external_message_id,
    'senderExternalId', coalesce(o.external_sender_id, ''),
    'author', internal.bridge_resolve_author(o.bridge_id, coalesce(o.external_sender_id, '')),
    'text', m.body,
    'edited', m.edited_at is not null or m.redacted_at is not null,
    'replyTo', case when o.external_reply_to_id is null then null
                    else jsonb_build_object('externalMessageId', o.external_reply_to_id) end);
end
$$;
revoke all on function public.bridge_command_input(uuid) from public;
grant execute on function public.bridge_command_input(uuid) to tm8_app;

-- The sweep's read (B1b-2's watchdog calls hook.sweep() every tick): commands
-- left pending for 30 s, or running for 2 minutes (a run that died). The
-- columns are B1b-2's (message_origins.command_state, command_claimed_at); the
-- body is dynamic so this file applies before or after theirs. The claim door
-- decides who wins a race.
create or replace function public.bridge_commands_due(p_limit integer default 20)
returns setof uuid language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridge_commands_worker();
  return query execute
    'select o.message_id
       from public.message_origins o
      where o.direction = ''in''
        and ((o.command_state = ''pending'' and o.created_at < now() - interval ''30 seconds'')
          or (o.command_state = ''running''
              and coalesce(o.command_claimed_at, o.created_at) < now() - interval ''2 minutes''))
      order by o.created_at
      limit $1'
    using least(greatest(coalesce(p_limit, 20), 1), 200);
end
$$;
revoke all on function public.bridge_commands_due(integer) from public;
grant execute on function public.bridge_commands_due(integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. "From this group" (v2 §4.4, BRIDGE-ENTITY-DESIGN §2.8): the bridge's
--     incoming authored_from edges filtered by kind, and nothing else; no
--     per-group index. dst_id = the bridge, so the -> message edges never
--     double count. Moving or editing an entity leaves its edge in place.
--
--     internal.bridge_provenance_rows is SECURITY INVOKER: a member's list is
--     read under the member's own claims, so RLS decides what they may read.
--     A guest has no member to read as; bridge_command_guest_list (definer,
--     executor-only) gives a guest what every member of the space sees
--     (visibility 'space').
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_provenance_rows(p_bridge_id uuid, p_kinds text[], p_limit integer)
returns table (id uuid, kind text, title text, status text, created_at timestamptz,
               created_by uuid, visibility text, handle text, origins jsonb)
language sql stable set search_path = public, internal, pg_temp as $$
  select en.id, en.kind,
         coalesce(t.title, ws.title, d.title, a.name, dr.title, 'Untitled'),
         coalesce(t.work_status, ws.status),
         en.created_at, en.created_by, en.visibility, h.handle,
         coalesce(ed.props -> 'origins', '[]'::jsonb)
    from public.edges ed
    join public.entities en on en.id = ed.src_id
    left join public.tasks t on t.entity_id = en.id
    left join public.work_sessions ws on ws.entity_id = en.id
    left join public.documents d on d.entity_id = en.id
    left join public.artifacts a on a.entity_id = en.id
    left join public.drawings dr on dr.entity_id = en.id
    left join public.bridge_handles h on h.entity_id = en.id and h.space_id = en.space_id
   where ed.type = 'authored_from' and ed.dst_id = p_bridge_id
     and en.kind = any(p_kinds) and en.deleted_at is null
     and en.space_id = (select b.space_id from public.bridges b where b.entity_id = p_bridge_id)
   order by en.created_at desc, en.id
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke all on function internal.bridge_provenance_rows(uuid, text[], integer) from public;
grant execute on function internal.bridge_provenance_rows(uuid, text[], integer) to tm8_app;

create or replace function public.bridge_command_guest_list(p_bridge_id uuid, p_kinds text[], p_limit integer)
returns table (id uuid, kind text, title text, status text, created_at timestamptz,
               created_by uuid, visibility text, handle text, origins jsonb)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridge_commands_worker();
  return query
    select r.* from internal.bridge_provenance_rows(p_bridge_id, p_kinds, p_limit) r
     where r.visibility = 'space';
end
$$;
revoke all on function public.bridge_command_guest_list(uuid, text[], integer) from public;
grant execute on function public.bridge_command_guest_list(uuid, text[], integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- §4. Confirms (v2 §4.6, §5). A confirm is INTENT, never an approval (D9):
--     nothing approval-gated runs on one. One use, same sender, 2 minutes,
--     keyed by the notice that asked.
-- -----------------------------------------------------------------------------
create table public.bridge_command_confirms (
  notice_message_id  uuid primary key references public.messages(entity_id) on delete cascade,
  bridge_id          uuid not null references public.bridges(entity_id) on delete cascade,
  sender_external_id text not null,
  command            jsonb not null check (jsonb_typeof(command) = 'object'),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  used_at            timestamptz,
  -- The YES that took it: the same YES taking again (a re-run after a crash)
  -- gets the same command back, so the confirmed work converges, never lost.
  used_by_message_id uuid
);
create index bridge_command_confirms_sender_idx
  on public.bridge_command_confirms(bridge_id, sender_external_id, created_at desc) where used_at is null;

-- No app grant: the executor reaches it only through the doors below.
alter table public.bridge_command_confirms enable row level security;

comment on table public.bridge_command_confirms is
  '401 (Bridges v2 §4.6): one open "reply YES within 2 min" per notice. One use, '
  'same sender. Intent, never an approval (D9).';

create or replace function public.bridge_command_confirm_open(
  p_notice_message_id uuid, p_bridge_id uuid, p_sender_external_id text, p_command jsonb)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridge_commands_worker();
  insert into public.bridge_command_confirms(notice_message_id, bridge_id, sender_external_id, command, expires_at)
  values (p_notice_message_id, p_bridge_id, p_sender_external_id, p_command, now() + interval '2 minutes')
  on conflict (notice_message_id) do nothing;
end
$$;
revoke all on function public.bridge_command_confirm_open(uuid, uuid, text, jsonb) from public;
grant execute on function public.bridge_command_confirm_open(uuid, uuid, text, jsonb) to tm8_app;

-- The notice a reply quotes, by its provider id (the out-row B1b-2's sent
-- settle writes). Null when the quote is not one of our messages.
create or replace function internal.bridge_notice_for_reply(p_bridge_id uuid, p_reply_to_external_id text)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select o.message_id from public.message_origins o
   where o.bridge_id = p_bridge_id and o.direction = 'out'
     and o.external_message_id = p_reply_to_external_id
   limit 1
$$;
revoke all on function internal.bridge_notice_for_reply(uuid, text) from public;

-- The inbound door's detect(): does this YES answer an open confirm of this
-- sender's? Only a YES/Y/OK body that quotes something reaches this read.
create or replace function public.bridge_command_confirm_open_for(
  p_bridge_id uuid, p_sender_external_id text, p_reply_to_external_id text)
returns boolean language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  -- The inbound door's transaction runs under the runtime's own session
  -- (B1b-2: internal.is_bridge_runtime()); the executor under the worker claim.
  if not (coalesce(internal.is_bridges_worker(), false) or coalesce(internal.is_bridge_runtime(), false)) then
    raise exception 'only the bridge runtime or the bridges worker asks this'
      using errcode = '42501', detail = jsonb_build_object('reason', 'not_bridges_worker')::text;
  end if;
  if p_reply_to_external_id is null then return false; end if;
  return exists (
    select 1 from public.bridge_command_confirms c
     where c.notice_message_id = internal.bridge_notice_for_reply(p_bridge_id, p_reply_to_external_id)
       and c.bridge_id = p_bridge_id and c.sender_external_id = p_sender_external_id
       and c.used_at is null and c.expires_at > now());
end
$$;
revoke all on function public.bridge_command_confirm_open_for(uuid, text, text) from public;
grant execute on function public.bridge_command_confirm_open_for(uuid, text, text) to tm8_app;

-- Takes the confirm a sender's YES answers: the notice the YES quotes (a YES
-- that quotes nothing confirms nothing), from the same sender, within its 2
-- minutes, once. Idempotent per YES message: the YES that took it gets the same
-- command back on a re-run. Returns the stored command, or null.
create or replace function public.bridge_command_confirm_take(
  p_bridge_id uuid, p_sender_external_id text, p_reply_to_external_id text, p_taking_message_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  c public.bridge_command_confirms;
  v_notice uuid;
begin
  perform internal.require_bridge_commands_worker();
  if p_reply_to_external_id is null or p_taking_message_id is null then return null; end if;
  v_notice := internal.bridge_notice_for_reply(p_bridge_id, p_reply_to_external_id);
  if v_notice is null then return null; end if;
  select * into c from public.bridge_command_confirms
   where notice_message_id = v_notice and bridge_id = p_bridge_id and sender_external_id = p_sender_external_id
   for update;
  if c.notice_message_id is null then return null; end if;
  if c.used_at is not null then
    if c.used_by_message_id = p_taking_message_id then
      return c.command || jsonb_build_object('noticeMessageId', c.notice_message_id);
    end if;
    return null;
  end if;
  if c.expires_at <= now() then return null; end if;
  update public.bridge_command_confirms set used_at = now(), used_by_message_id = p_taking_message_id
   where notice_message_id = c.notice_message_id;
  return c.command || jsonb_build_object('noticeMessageId', c.notice_message_id);
end
$$;
revoke all on function public.bridge_command_confirm_take(uuid, text, text, uuid) from public;
grant execute on function public.bridge_command_confirm_take(uuid, text, text, uuid) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.bridge_command_confirms;
