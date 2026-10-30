-- =============================================================================
-- 399 — Bridges B1b-3: space-wide access on a bridge (D21, D23) and the D22/D30
-- provenance recorder, on D31's edge shape. (Provisional number; the merger
-- assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- §2.4 (handles), §2.7, §2.8, D21-D23, D29-D31. Task 01a189f3-ac8b. Builds on
-- 395 (B0a: tables, handle claim, listen, log cursor) and 396 (B1b-1: the
-- one-origin index excludes edges with props.bridgeId).
--
-- WHAT THIS FILE DOES
--   §1  bridgeOrigins, the launch context (§2.8): public.session_bridge_origins,
--       one row per (holder, bridge, origin key). A holder is a work session
--       (origins accumulate, D30) or a chat (turn-scoped: the router clears
--       them when the turn settles, §2.8 row 2).
--   §2  the recorder. One authored_from -> bridge edge per (entity, bridge)
--       with props {bridgeId, origins[]} (D31), plus authored_from -> the origin
--       message per (entity, message) with {bridgeId, origins:[that origin]}.
--       Both carry the top-level bridgeId 396 keys on. An AFTER INSERT trigger
--       on public.entities is the one path every create goes through: when the
--       creating caller (its work session, else its chat runtime) holds
--       bridgeOrigins, the edges are written in the create's own transaction,
--       and a failure fails the create. A work session created by such a
--       caller inherits the origins into its own launch context, depth + 1.
--       Doors for the server: record_bridge_provenance (the command executor's
--       own creates), bridge_launch_origins (spawn, in the spawn's tx),
--       add_bridge_origin (D30: a directed or routed delivery),
--       clear_bridge_origins (a chat turn settled).
--   §3  the edge guard B1b-1 left open: a bridgeId-marked authored_from may
--       point only at a bridge or a message (otherwise it would be a second
--       session/chat origin outside 396's index), names a real bridge, and
--       carries origins[] as an array. Writing or deleting one stays
--       recorder-owned (internal.guard_w1_edge): edges.create/delete refuse it.
--   §4  handles on first post (D23): bridge_poster_handle mints the session's
--       one space handle and records the appearance; a bridge_outbox insert
--       calls it for the posting session.
--   §5  one answerer per message (§2.7): bridge_message_answerers, set by the
--       router, settled by the answerer's reply; a reply to a bridged message
--       whose open answer belongs to another session or chat is refused
--       TBC01 `not_answerer`. People are never refused: the guardrail is for
--       workers (§2.7).
--   §6  who hears a message (§2.7): bridge_message_audience (directed:
--       @handle, a reply to the session's post, its /work thread; else the
--       sessions listening at thread or all) and bridge_unread_count for the
--       envelope's origin element.
--
-- Every door here is server-only: no catalog operation reaches it, and the
-- server calls it with the request's claims (the record_authored_from
-- precedent, 308/327).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. bridgeOrigins: the launch context.
-- -----------------------------------------------------------------------------
create table public.session_bridge_origins (
  holder_id           uuid not null references public.entities(id) on delete cascade,
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  -- The D22 dedupe key: the provider's message id, else the loop that fired.
  origin_key          text not null check (char_length(origin_key) between 1 and 512),
  message_id          uuid references public.entities(id) on delete set null,
  provider_message_id text,
  sender              jsonb not null default '{}'::jsonb check (jsonb_typeof(sender) = 'object'),
  command             text,
  loop_id             uuid,
  inherited           boolean not null,
  via_session_id      uuid,
  depth               integer not null default 0 check (depth >= 0),
  added_at            timestamptz not null default now(),
  primary key (holder_id, bridge_id, origin_key)
);
create index session_bridge_origins_bridge_idx on public.session_bridge_origins(bridge_id);

alter table public.session_bridge_origins enable row level security;
create policy session_bridge_origins_select on public.session_bridge_origins for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = session_bridge_origins.holder_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.session_bridge_origins to tm8_app;

-- One origin, validated and normalized: {bridgeId, messageId, providerMessageId,
-- sender, command, loopId?}. inherited/viaSessionId/depth are the recorder's.
create or replace function internal.bridge_origin_normalize(p_origin jsonb)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  v_bridge uuid; v_message uuid; v_loop uuid; v_provider text; v_command text; v_sender jsonb;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_origin is null or jsonb_typeof(p_origin) <> 'object' then
    raise exception 'a bridge origin is an object' using errcode = '22023';
  end if;
  if coalesce(p_origin ->> 'bridgeId', '') !~* uuid_re then
    raise exception 'a bridge origin names its bridgeId' using errcode = '22023';
  end if;
  v_bridge := (p_origin ->> 'bridgeId')::uuid;
  if not exists (select 1 from public.bridges where entity_id = v_bridge) then
    raise exception 'bridge origin %: no such bridge', v_bridge using errcode = '22023';
  end if;
  if nullif(p_origin ->> 'messageId', '') is not null then
    if p_origin ->> 'messageId' !~* uuid_re then raise exception 'messageId must be an id' using errcode = '22023'; end if;
    v_message := (p_origin ->> 'messageId')::uuid;
  end if;
  if nullif(p_origin ->> 'loopId', '') is not null then
    if p_origin ->> 'loopId' !~* uuid_re then raise exception 'loopId must be an id' using errcode = '22023'; end if;
    v_loop := (p_origin ->> 'loopId')::uuid;
  end if;
  v_provider := nullif(p_origin ->> 'providerMessageId', '');
  v_command := nullif(p_origin ->> 'command', '');
  v_sender := coalesce(p_origin -> 'sender', '{}'::jsonb);
  if jsonb_typeof(v_sender) <> 'object' then raise exception 'sender is an object' using errcode = '22023'; end if;
  if v_provider is null and v_loop is null then
    raise exception 'a bridge origin needs a providerMessageId, or a loopId for a loop firing' using errcode = '22023';
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'bridgeId', v_bridge, 'messageId', v_message, 'providerMessageId', v_provider,
    'command', v_command, 'loopId', v_loop))
    || jsonb_build_object('messageId', v_message, 'providerMessageId', v_provider,
                          'command', v_command, 'sender', v_sender);
end
$$;
revoke all on function internal.bridge_origin_normalize(jsonb) from public;

create or replace function internal.bridge_origin_key(p_origin jsonb) returns text
language sql immutable set search_path = public, internal, pg_temp as $$
  select coalesce(nullif(p_origin ->> 'providerMessageId', ''), 'loop:' || (p_origin ->> 'loopId'))
$$;
revoke all on function internal.bridge_origin_key(jsonb) from public;

-- Add one origin to a holder's launch context. Deduped on (bridge, key), so a
-- redelivery adds none. Returns whether it was new.
create or replace function internal.bridge_holder_add(
  p_holder uuid, p_origin jsonb, p_inherited boolean, p_via uuid, p_depth integer)
returns boolean language plpgsql set search_path = public, internal, pg_temp as $$
declare o jsonb := internal.bridge_origin_normalize(p_origin); n integer;
begin
  insert into public.session_bridge_origins(holder_id, bridge_id, origin_key, message_id, provider_message_id,
                                            sender, command, loop_id, inherited, via_session_id, depth)
  values (p_holder, (o ->> 'bridgeId')::uuid, internal.bridge_origin_key(o), (o ->> 'messageId')::uuid,
          o ->> 'providerMessageId', o -> 'sender', o ->> 'command', (o ->> 'loopId')::uuid,
          p_inherited, p_via, greatest(coalesce(p_depth, 0), 0))
  on conflict (holder_id, bridge_id, origin_key) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end
$$;
revoke all on function internal.bridge_holder_add(uuid, jsonb, boolean, uuid, integer) from public;

-- A holder's origins as recorder-ready objects (the edge's origins[] items).
create or replace function internal.bridge_holder_origins(p_holder uuid)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('loopId', o.loop_id))
           || jsonb_build_object('bridgeId', o.bridge_id, 'messageId', o.message_id,
                                 'providerMessageId', o.provider_message_id, 'sender', o.sender,
                                 'command', o.command, 'inherited', o.inherited,
                                 'viaSessionId', o.via_session_id, 'depth', o.depth)
           order by o.added_at, o.bridge_id, o.origin_key), '[]'::jsonb)
    from public.session_bridge_origins o where o.holder_id = p_holder
$$;
revoke all on function internal.bridge_holder_origins(uuid) from public;

-- The caller who holds bridgeOrigins: its work session (claim), else the chat
-- its chat-runtime bearer runs (auth_sessions.runtime_chat_id). Null for a
-- person, the bridge runtime and the background jobs.
create or replace function internal.bridge_caller_holder(p_space_id uuid)
returns uuid language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  v uuid := internal.caller_work_session(p_space_id);
  raw text;
begin
  if v is not null then return v; end if;
  raw := internal.claim_text('tm8.auth_session_id');
  if raw is null or raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  select a.runtime_chat_id into v
    from public.auth_sessions a
    join public.entities e on e.id = a.runtime_chat_id and e.space_id = p_space_id and e.deleted_at is null
   where a.id = raw::uuid;
  return v;
end
$$;
revoke all on function internal.bridge_caller_holder(uuid) from public;

-- -----------------------------------------------------------------------------
-- §2. The recorder.
-- -----------------------------------------------------------------------------
update public.edge_types
   set dst_kinds = array_append(dst_kinds, 'message')
 where type = 'authored_from' and not ('message' = any(dst_kinds));
update public.edge_types
   set props_schema = jsonb_set(props_schema, '{properties,origins}', jsonb_build_object('type', 'array'))
 where type = 'authored_from';

-- origins[] ∪ more, keeping the first copy of each (bridge, key): append what
-- is new, skip what is not, never drop one (D22, D31).
create or replace function internal.bridge_merge_origins(p_have jsonb, p_more jsonb)
returns jsonb language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare out jsonb := coalesce(p_have, '[]'::jsonb); item jsonb;
begin
  for item in select value from jsonb_array_elements(coalesce(p_more, '[]'::jsonb)) loop
    if not exists (select 1 from jsonb_array_elements(out) h
                    where h.value ->> 'bridgeId' = item ->> 'bridgeId'
                      and internal.bridge_origin_key(h.value) = internal.bridge_origin_key(item)) then
      out := out || jsonb_build_array(item);
    end if;
  end loop;
  return out;
end
$$;
revoke all on function internal.bridge_merge_origins(jsonb, jsonb) from public;

-- Upsert one provenance edge: insert, or merge origins[] into the one there.
create or replace function internal.bridge_upsert_edge(e public.entities, p_dst uuid, p_bridge uuid, p_origins jsonb)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare existing public.edges;
begin
  perform internal.w1_set_writer('entity_recorder');
  select * into existing from public.edges
   where src_id = e.id and dst_id = p_dst and type = 'authored_from' for update;
  if existing.id is null then
    insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
    values (e.space_id, e.id, p_dst, 'authored_from', e.created_by,
            jsonb_build_object('bridgeId', p_bridge, 'origins', p_origins))
    on conflict (src_id, dst_id, type) do nothing;
    if not found then
      select * into existing from public.edges
       where src_id = e.id and dst_id = p_dst and type = 'authored_from' for update;
    end if;
  end if;
  if existing.id is not null then
    if not (existing.props ? 'bridgeId') then
      -- p_dst is this entity's session/chat origin: never a provenance target.
      raise exception 'authored_from % -> % is the session/chat origin, not provenance', e.id, p_dst
        using errcode = '23514';
    end if;
    if internal.bridge_merge_origins(existing.props -> 'origins', p_origins) is distinct from existing.props -> 'origins' then
      update public.edges
         set props = props || jsonb_build_object('origins', internal.bridge_merge_origins(props -> 'origins', p_origins))
       where id = existing.id;
    end if;
  end if;
  perform internal.w1_set_writer(null);
end
$$;
revoke all on function internal.bridge_upsert_edge(public.entities, uuid, uuid, jsonb) from public;

-- Write the edges for a set of recorder-ready origins on one entity: one
-- -> bridge per bridge (origins[] of that bridge), one -> message per origin
-- message. Origins whose bridge lives in another space are not this entity's
-- (edges are same-space). Raises on any write failure, failing the create.
create or replace function internal.bridge_stamp(p_entity_id uuid, p_origins jsonb)
returns integer language plpgsql set search_path = public, internal, pg_temp as $$
declare
  e public.entities; b record; m record; written integer := 0;
begin
  if p_origins is null or jsonb_array_length(p_origins) = 0 then return 0; end if;
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then raise exception 'entity % not found', p_entity_id using errcode = 'P0002'; end if;
  for b in
    select (o.value ->> 'bridgeId')::uuid as bridge_id, jsonb_agg(o.value order by o.ordinality) as origins
      from jsonb_array_elements(p_origins) with ordinality o
      join public.entities be on be.id = (o.value ->> 'bridgeId')::uuid and be.kind = 'bridge' and be.space_id = e.space_id
     group by 1
  loop
    if b.bridge_id <> e.id then
      perform internal.bridge_upsert_edge(e, b.bridge_id, b.bridge_id, b.origins);
      written := written + 1;
    end if;
    for m in
      select (o.value ->> 'messageId')::uuid as message_id, jsonb_agg(o.value) as origins
        from jsonb_array_elements(b.origins) o
        join public.entities me on me.id = (o.value ->> 'messageId')::uuid and me.kind = 'message' and me.space_id = e.space_id
       where nullif(o.value ->> 'messageId', '') is not null
       group by 1
    loop
      if m.message_id <> e.id then
        perform internal.bridge_upsert_edge(e, m.message_id, b.bridge_id, m.origins);
        written := written + 1;
      end if;
    end loop;
  end loop;
  return written;
end
$$;
revoke all on function internal.bridge_stamp(uuid, jsonb) from public;

-- The trigger: every entity created by a caller holding bridgeOrigins.
create or replace function internal.bridge_record_provenance() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  holder uuid;
  holder_kind text;
  origins jsonb;
  child_depth_step integer;
  o record;
begin
  holder := internal.bridge_caller_holder(new.space_id);
  if holder is null or holder = new.id then return null; end if;
  if not exists (select 1 from public.session_bridge_origins where holder_id = holder) then return null; end if;
  select kind into holder_kind from public.entities where id = holder;
  -- A worker spawned by a session is one generation deeper; one a chat turn
  -- spawns is the bridge layer's direct worker (depth unchanged, §2.8).
  child_depth_step := case when holder_kind = 'work_session' then 1 else 0 end;
  if new.kind = 'work_session' then
    for o in select * from public.session_bridge_origins where holder_id = holder loop
      perform internal.bridge_holder_add(new.id,
        jsonb_strip_nulls(jsonb_build_object('loopId', o.loop_id))
          || jsonb_build_object('bridgeId', o.bridge_id, 'messageId', o.message_id,
                                'providerMessageId', o.provider_message_id, 'sender', o.sender, 'command', o.command),
        true, holder, o.depth + child_depth_step);
    end loop;
    origins := internal.bridge_holder_origins(new.id);
  else
    select coalesce(jsonb_agg(x.value || jsonb_build_object('inherited', true, 'viaSessionId', holder)), '[]'::jsonb)
      into origins from jsonb_array_elements(internal.bridge_holder_origins(holder)) x;
  end if;
  perform internal.bridge_stamp(new.id, origins);
  return null;
end
$$;
revoke all on function internal.bridge_record_provenance() from public;
create trigger entities_bridge_provenance after insert on public.entities
for each row execute function internal.bridge_record_provenance();

-- Recorder-ready form of origins passed by the server at the origin's birth:
-- inherited false, no via session, depth 0 (§2.8 "where an origin is born").
create or replace function internal.bridge_born_origins(p_origins jsonb)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare out jsonb := '[]'::jsonb; item jsonb;
begin
  if p_origins is null or jsonb_typeof(p_origins) <> 'array' then
    raise exception 'origins must be an array' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(p_origins) loop
    out := out || jsonb_build_array(internal.bridge_origin_normalize(item)
                   || jsonb_build_object('inherited', false, 'viaSessionId', null, 'depth', 0));
  end loop;
  return out;
end
$$;
revoke all on function internal.bridge_born_origins(jsonb) from public;

-- record_bridge_provenance: the command executor (and the loop executor)
-- stamping what it created itself. Same tx as the create; idempotent.
create or replace function public.record_bridge_provenance(p_entity_id uuid, p_origins jsonb)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  return internal.bridge_stamp(p_entity_id, internal.bridge_born_origins(p_origins));
end
$$;
revoke all on function public.record_bridge_provenance(uuid, jsonb) from public;
grant execute on function public.record_bridge_provenance(uuid, jsonb) to tm8_app;

-- bridge_launch_origins: a session started because of a bridge (/work,
-- bridges.work.start, a loop). Runs in the spawn's transaction: the launch
-- context and the session's own edges exist before the worker can start.
create or replace function public.bridge_launch_origins(p_session_id uuid, p_origins jsonb)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare item jsonb; born jsonb := internal.bridge_born_origins(p_origins);
begin
  if not exists (select 1 from public.entities where id = p_session_id and kind = 'work_session' and deleted_at is null) then
    raise exception 'bridge origins launch a work session' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(born) loop
    perform internal.bridge_holder_add(p_session_id, item, false, null, 0);
  end loop;
  return internal.bridge_stamp(p_session_id, born);
end
$$;
revoke all on function public.bridge_launch_origins(uuid, jsonb) from public;
grant execute on function public.bridge_launch_origins(uuid, jsonb) to tm8_app;

-- add_bridge_origin (D30): a directed or routed message from a bridge was
-- delivered to this running session, or starts this chat's turn. From then on
-- what it creates carries it; nothing created before is rewritten. Deduped on
-- (bridgeId, providerMessageId): a redelivery adds none.
create or replace function public.add_bridge_origin(p_holder_id uuid, p_origin jsonb)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare h public.entities; o jsonb := internal.bridge_origin_normalize(p_origin);
begin
  select * into h from public.entities where id = p_holder_id and deleted_at is null;
  if h.id is null or h.kind not in ('work_session', 'chat') then
    raise exception 'bridge origins belong to a work session or a chat' using errcode = '22023';
  end if;
  if not exists (select 1 from public.entities where id = (o ->> 'bridgeId')::uuid and space_id = h.space_id) then
    raise exception 'the bridge is not in the holder''s space' using errcode = '22023';
  end if;
  return internal.bridge_holder_add(p_holder_id, o, false, null, 0);
end
$$;
revoke all on function public.add_bridge_origin(uuid, jsonb) from public;
grant execute on function public.add_bridge_origin(uuid, jsonb) to tm8_app;

-- clear_bridge_origins: a chat's turn settled. Chat origins are turn-scoped
-- (§2.8 row 2); a session's are kept for its life (D30).
create or replace function public.clear_bridge_origins(p_chat_id uuid)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n integer;
begin
  if not exists (select 1 from public.entities where id = p_chat_id and kind = 'chat') then
    raise exception 'only a chat''s origins are turn-scoped' using errcode = '22023';
  end if;
  delete from public.session_bridge_origins where holder_id = p_chat_id;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function public.clear_bridge_origins(uuid) from public;
grant execute on function public.clear_bridge_origins(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. The edge guard: closes B1b-1's gap.
-- -----------------------------------------------------------------------------
create or replace function internal.guard_authored_from_bridge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare dst_kind text;
begin
  -- A writer that is not an authored_from recorder is refused 42501 by
  -- internal.guard_w1_edge, which runs after this trigger (names sort); answer
  -- that refusal, not a shape error, to a client.
  if coalesce(internal.w1_writer(), '') not in ('message_recorder', 'memory_recorder', 'artifact_publisher',
      'form_recorder', 'entity_recorder', 'commit_recorder', 'edge_migration') then
    return new;
  end if;
  select kind into dst_kind from public.entities where id = new.dst_id;
  if dst_kind = 'bridge' and coalesce(new.props ->> 'bridgeId', '') <> new.dst_id::text then
    raise exception 'authored_from -> bridge must name the bridge in props.bridgeId'
      using errcode = '22023';
  end if;
  if new.props ? 'bridgeId' then
    -- 396's index admits any number of bridgeId-marked edges: only bridge
    -- provenance may carry the marker, or it would be a second session/chat
    -- origin outside the index.
    if dst_kind is distinct from 'bridge' and dst_kind is distinct from 'message' then
      raise exception 'bridge provenance (props.bridgeId) points at a bridge or a message, not a %', coalesce(dst_kind, 'missing entity')
        using errcode = '22023';
    end if;
    if not exists (select 1 from public.entities
                    where id::text = new.props ->> 'bridgeId' and kind = 'bridge') then
      raise exception 'props.bridgeId must name a bridge' using errcode = '22023';
    end if;
    if jsonb_typeof(new.props -> 'origins') is distinct from 'array' then
      raise exception 'bridge provenance carries origins[]' using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;
revoke all on function internal.guard_authored_from_bridge() from public;

-- -----------------------------------------------------------------------------
-- §4. Handles on first post (D23).
-- -----------------------------------------------------------------------------
-- The session's one space handle, minted if it has none. 395's claim door now
-- shares it.
create or replace function internal.bridge_ensure_handle(p_space_id uuid, p_session uuid, p_title text)
returns public.bridge_handles language plpgsql set search_path = public, internal, pg_temp as $$
declare
  v_row public.bridge_handles;
  v_attempt integer := 0;
  v_constraint text;
begin
  select * into v_row from public.bridge_handles where space_id = p_space_id and entity_id = p_session;
  -- Two races, told apart by which unique fired: the same session claiming
  -- twice (the (space, entity) unique: re-read the winner's row), and two
  -- sessions minting the same name at once (the primary key: mint again).
  while v_row.handle is null loop
    v_attempt := v_attempt + 1;
    if v_attempt > 8 then raise exception 'could not mint a free handle' using errcode = '53400'; end if;
    begin
      insert into public.bridge_handles(space_id, handle, entity_id, kind, title)
      values (p_space_id, internal.bridge_new_handle(p_space_id), p_session, 'work_session',
              coalesce(p_title, left(nullif(internal.bridge_target_title('work_session', p_session), ''), 80)))
      returning * into v_row;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bridge_handles_pkey' then
        select * into v_row from public.bridge_handles where space_id = p_space_id and entity_id = p_session;
      end if;
    end;
  end loop;
  return v_row;
end
$$;
revoke all on function internal.bridge_ensure_handle(uuid, uuid, text) from public;

create or replace function public.claim_bridge_handle(p_space_id uuid, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_session uuid;
  v_row public.bridge_handles;
  v_title text := nullif(btrim(p_title), '');
begin
  perform internal.require_space_member(p_space_id);
  v_session := internal.caller_work_session(p_space_id);
  if v_session is null then
    raise exception 'a handle belongs to a session: claim one from inside a session in this space'
      using errcode = '42501', detail = jsonb_build_object('reason', 'not_a_session')::text;
  end if;
  if v_title is not null and (char_length(v_title) > 80 or array_length(regexp_split_to_array(v_title, '\s+'), 1) > 4) then
    raise exception 'a handle title is at most four words' using errcode = '22023';
  end if;
  v_row := internal.bridge_ensure_handle(p_space_id, v_session, v_title);
  if v_title is not null and v_title is distinct from v_row.title then
    update public.bridge_handles set title = v_title
     where space_id = p_space_id and handle = v_row.handle returning * into v_row;
  end if;
  return jsonb_build_object('spaceId', v_row.space_id, 'handle', v_row.handle, 'entityId', v_row.entity_id,
    'kind', v_row.kind, 'title', v_row.title, 'status', v_row.status, 'createdAt', v_row.created_at);
end
$$;
revoke all on function public.claim_bridge_handle(uuid, text) from public;
grant execute on function public.claim_bridge_handle(uuid, text) to tm8_app;

-- bridge_assign_handle: a named session's space handle, minted at request
-- time for a worker /work or bridges.work.start just started (v2 §4.3).
-- Idempotent per (space, session); a title is set only on the first mint.
create or replace function internal.bridge_assign_handle(p_space_id uuid, p_session_id uuid, p_title text default null)
returns text language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_title text := left(nullif(btrim(p_title), ''), 80);
begin
  if not exists (select 1 from public.entities where id = p_session_id and kind = 'work_session' and space_id = p_space_id) then
    raise exception 'a handle belongs to a work session in this space' using errcode = '22023';
  end if;
  return (internal.bridge_ensure_handle(p_space_id, p_session_id, v_title)).handle;
end
$$;
revoke all on function internal.bridge_assign_handle(uuid, uuid, text) from public;
grant execute on function internal.bridge_assign_handle(uuid, uuid, text) to tm8_app;

-- bridge_poster_handle: a session posts on a bridge. Its space handle (minted
-- on its first post to any bridge), and this bridge recorded as one it has
-- appeared on. The outbox calls it for the `Title (handle):` signature.
create or replace function public.bridge_poster_handle(p_bridge_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b public.entities; v_row public.bridge_handles;
begin
  select * into b from public.entities where id = p_bridge_id and kind = 'bridge';
  if b.id is null then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  -- First post: the same door /work calls at request time (B1b ruling 2).
  perform internal.bridge_assign_handle(b.space_id, p_session_id, null);
  select * into v_row from public.bridge_handles where space_id = b.space_id and entity_id = p_session_id;
  insert into public.bridge_handle_appearances(space_id, handle, bridge_id, first_at, last_at)
  values (b.space_id, v_row.handle, p_bridge_id, now(), now())
  on conflict (space_id, handle, bridge_id) do update set last_at = excluded.last_at;
  return jsonb_build_object('spaceId', v_row.space_id, 'handle', v_row.handle, 'entityId', v_row.entity_id,
    'kind', v_row.kind, 'title', v_row.title, 'status', v_row.status, 'createdAt', v_row.created_at);
end
$$;
revoke all on function public.bridge_poster_handle(uuid, uuid) from public;
grant execute on function public.bridge_poster_handle(uuid, uuid) to tm8_app;

-- The session a message was posted from: its session origin (message_recorder
-- writes message -> work_session), never bridge provenance.
create or replace function internal.bridge_message_session(p_message_id uuid)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select af.dst_id from public.edges af
    join public.entities s on s.id = af.dst_id and s.kind = 'work_session'
   where af.src_id = p_message_id and af.type = 'authored_from' and not (af.props ? 'bridgeId')
   limit 1
$$;
revoke all on function internal.bridge_message_session(uuid) from public;

create or replace function internal.bridge_outbox_handle() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_session uuid := internal.bridge_message_session(new.message_id);
begin
  if v_session is not null then perform public.bridge_poster_handle(new.bridge_id, v_session); end if;
  return null;
end
$$;
revoke all on function internal.bridge_outbox_handle() from public;
create trigger bridge_outbox_poster_handle after insert on public.bridge_outbox
for each row execute function internal.bridge_outbox_handle();

-- -----------------------------------------------------------------------------
-- §5. One answerer per message (§2.7).
-- -----------------------------------------------------------------------------
create table public.bridge_message_answerers (
  message_id  uuid primary key references public.messages(entity_id) on delete cascade,
  bridge_id   uuid not null references public.bridges(entity_id) on delete cascade,
  answerer_id uuid not null references public.entities(id) on delete cascade,
  status      text not null default 'open' check (status in ('open', 'settled')),
  assigned_at timestamptz not null default now(),
  settled_at  timestamptz
);
create index bridge_message_answerers_open_idx on public.bridge_message_answerers(answerer_id) where status = 'open';

alter table public.bridge_message_answerers enable row level security;
create policy bridge_message_answerers_select on public.bridge_message_answerers for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_message_answerers.message_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_message_answerers to tm8_app;

-- set_bridge_answerer: the router names the answerer when it routes (the
-- directed session, else the target chat); a hand-over names the new one.
create or replace function public.set_bridge_answerer(p_message_id uuid, p_answerer_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare o public.message_origins; a public.entities; r public.bridge_message_answerers;
begin
  select * into o from public.message_origins where message_id = p_message_id and direction = 'in';
  if o.message_id is null then raise exception 'not an inbound bridged message' using errcode = '22023'; end if;
  select * into a from public.entities where id = p_answerer_id and deleted_at is null;
  if a.id is null or a.kind not in ('work_session', 'chat')
     or a.space_id is distinct from (select space_id from public.entities where id = o.bridge_id) then
    raise exception 'an answerer is a work session or chat in the bridge''s space' using errcode = '22023';
  end if;
  insert into public.bridge_message_answerers(message_id, bridge_id, answerer_id)
  values (p_message_id, o.bridge_id, p_answerer_id)
  on conflict (message_id) do update
     set answerer_id = excluded.answerer_id, status = 'open', assigned_at = now(), settled_at = null
  returning * into r;
  return jsonb_build_object('messageId', r.message_id, 'answererId', r.answerer_id, 'status', r.status);
end
$$;
revoke all on function public.set_bridge_answerer(uuid, uuid) from public;
grant execute on function public.set_bridge_answerer(uuid, uuid) to tm8_app;

-- settle_bridge_answer: the answer is done (the chat's turn settled). The
-- answerer's own reply settles it too (below).
create or replace function public.settle_bridge_answer(p_message_id uuid)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  update public.bridge_message_answerers set status = 'settled', settled_at = now()
   where message_id = p_message_id and status = 'open';
  return found;
end
$$;
revoke all on function public.settle_bridge_answer(uuid) from public;
grant execute on function public.settle_bridge_answer(uuid) to tm8_app;

-- The guard, on every post path: a reply to a bridged message (the log copy
-- or any copy in its batch) whose open answer is someone else's is refused.
create or replace function internal.guard_bridge_answerer() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  me public.entities; v_parent uuid; r public.bridge_message_answerers; caller uuid; who text;
begin
  select * into me from public.entities where id = new.entity_id;
  v_parent := me.parent_id;
  if v_parent is null then return new; end if;
  select a.* into r from public.bridge_message_answerers a
   where a.status = 'open'
     and (a.message_id = v_parent
          or a.message_id in (select c.entity_id from public.messages c
                               join public.messages p on p.entity_id = v_parent
                              where p.message_batch_id is not null and c.message_batch_id = p.message_batch_id))
   limit 1;
  if r.message_id is null then return new; end if;
  caller := internal.bridge_caller_holder(me.space_id);
  if caller is null then return new; end if;   -- people are never refused (§2.7)
  if caller = r.answerer_id then
    update public.bridge_message_answerers set status = 'settled', settled_at = now() where message_id = r.message_id;
    return new;
  end if;
  select coalesce(h.title || ' (' || h.handle || ')', internal.bridge_target_title(e.kind, e.id), 'the answerer')
    into who
    from public.entities e
    left join public.bridge_handles h on h.entity_id = e.id and h.space_id = e.space_id
   where e.id = r.answerer_id;
  perform internal.bridge_refuse('not_answerer',
    format('this message is %s''s to answer: post a new message or wait for %s', who, who),
    jsonb_build_object('answererId', r.answerer_id, 'messageId', r.message_id));
  return new;
end
$$;
revoke all on function internal.guard_bridge_answerer() from public;
create trigger messages_bridge_answerer before insert on public.messages
for each row execute function internal.guard_bridge_answerer();

-- -----------------------------------------------------------------------------
-- §6. Who hears a message, and how much they have not read (§2.7).
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_log_anchor(p_bridge_id uuid)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select case when b.target_kind = 'channel' then b.target_id else b.entity_id end
    from public.bridges b where b.entity_id = p_bridge_id
$$;
revoke all on function internal.bridge_log_anchor(uuid) from public;

create or replace function internal.bridge_session_live(p_session uuid)
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  select exists (select 1 from public.work_sessions ws join public.entities e on e.id = ws.entity_id
                  where ws.entity_id = p_session and e.deleted_at is null
                    and ws.status in ('spawning', 'running', 'idle'))
$$;
revoke all on function internal.bridge_session_live(uuid) from public;

-- /tell <handle>: the live session a handle addresses in a space.
create or replace function public.bridge_directed_by_handle(p_space_id uuid, p_handle text)
returns uuid language sql stable security definer set search_path = public, internal, pg_temp as $$
  select h.entity_id from public.bridge_handles h
   where h.space_id = p_space_id and h.handle = lower(ltrim(btrim(p_handle), '@'))
     and h.kind = 'work_session' and h.status = 'live' and internal.bridge_session_live(h.entity_id)
$$;
revoke all on function public.bridge_directed_by_handle(uuid, text) from public;
grant execute on function public.bridge_directed_by_handle(uuid, text) to tm8_app;

-- bridge_tell: `/tell <handle> <text>` (v2 §4.4) directs a message to a
-- worker. Resolves the handle to a live session, makes the message an origin
-- of it (D30, command '/tell') and the session its answerer. Returns the
-- session, or null when the handle names no live worker (the executor says so).
-- The delivery itself is the router's, like every directed message.
create or replace function public.bridge_tell(p_bridge_id uuid, p_message_id uuid, p_handle text, p_sender jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b public.entities; o public.message_origins; v_session uuid;
begin
  select * into b from public.entities where id = p_bridge_id and kind = 'bridge';
  if b.id is null then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  select * into o from public.message_origins where message_id = p_message_id and bridge_id = p_bridge_id and direction = 'in';
  if o.message_id is null then raise exception 'not an inbound message on this bridge' using errcode = '22023'; end if;
  v_session := public.bridge_directed_by_handle(b.space_id, p_handle);
  if v_session is null then return null; end if;
  perform internal.bridge_holder_add(v_session, jsonb_build_object(
    'bridgeId', p_bridge_id, 'messageId', p_message_id, 'providerMessageId', o.external_message_id,
    'sender', coalesce(p_sender, '{}'::jsonb), 'command', '/tell'), false, null, 0);
  perform public.set_bridge_answerer(p_message_id, v_session);
  return v_session;
end
$$;
revoke all on function public.bridge_tell(uuid, uuid, text, jsonb) from public;
grant execute on function public.bridge_tell(uuid, uuid, text, jsonb) to tm8_app;

-- bridge_message_audience: the sessions a log message reaches, at most one
-- row each. `directed` wakes always: an @handle in the body, a reply to a
-- message the session posted, a message in the thread of the session's /work
-- line. Otherwise only sessions that lowered no further than `thread` (and
-- posted in this thread) or listen at `all` hear it; everyone else counts it
-- as unread. The poster never hears its own message.
create or replace function public.bridge_message_audience(p_bridge_id uuid, p_message_id uuid)
returns table(session_id uuid, reason text)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  m public.messages; me public.entities; space uuid; poster uuid; root uuid;
begin
  select * into m from public.messages where entity_id = p_message_id;
  select * into me from public.entities where id = p_message_id;
  if m.entity_id is null or m.anchor_id is distinct from internal.bridge_log_anchor(p_bridge_id) then
    raise exception 'message is not on this bridge''s log' using errcode = '22023';
  end if;
  space := me.space_id;
  poster := internal.bridge_message_session(p_message_id);
  root := coalesce(m.root_message_id, m.entity_id);
  return query
  with directed as (
    select h.entity_id as sid from public.bridge_handles h
     where h.space_id = space and h.kind = 'work_session' and h.status = 'live'
       and h.handle in (select lower(x[1]) from regexp_matches(m.body, '@([A-Za-z]+-[A-Za-z]+(?:-[0-9]+)?)', 'g') x)
    union
    select internal.bridge_message_session(me.parent_id) where me.parent_id is not null
    union
    select o.holder_id from public.session_bridge_origins o
     where o.bridge_id = p_bridge_id and o.command = '/work' and o.message_id = root
       and not o.inherited
  ),
  listening as (
    select c.session_id as sid, c.wake from public.bridge_read_cursors c where c.bridge_id = p_bridge_id and c.wake <> 'directed'
  ),
  thread_posters as (
    select distinct internal.bridge_message_session(t.entity_id) as sid
      from public.messages t where t.anchor_id = m.anchor_id and (t.root_message_id = root or t.entity_id = root)
  ),
  heard as (
    select d.sid, 'directed'::text as why, 0 as rank from directed d where d.sid is not null
    union all
    select l.sid, 'thread', 1 from listening l join thread_posters tp on tp.sid = l.sid where l.wake in ('thread', 'all')
    union all
    select l.sid, 'all', 2 from listening l where l.wake = 'all'
  )
  select distinct on (hd.sid) hd.sid, hd.why from heard hd
   where hd.sid is distinct from poster and internal.bridge_session_live(hd.sid)
   order by hd.sid, hd.rank;
end
$$;
revoke all on function public.bridge_message_audience(uuid, uuid) from public;
grant execute on function public.bridge_message_audience(uuid, uuid) to tm8_app;

-- bridge_unread_count: log messages after the session's cursor (or, before
-- its first read, since the session started); the envelope's unread="n".
create or replace function public.bridge_unread_count(p_bridge_id uuid, p_session_id uuid)
returns integer language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare after_at timestamptz; after_id uuid; n integer;
begin
  select cm.created_at, cm.entity_id into after_at, after_id
    from public.bridge_read_cursors c join public.messages cm on cm.entity_id = c.last_message_id
   where c.bridge_id = p_bridge_id and c.session_id = p_session_id;
  if after_at is null then
    select s.created_at, '00000000-0000-0000-0000-000000000000'::uuid into after_at, after_id
      from public.entities s where s.id = p_session_id;
  end if;
  select count(*)::int into n
    from public.messages m join public.entities e on e.id = m.entity_id and e.deleted_at is null
   where m.anchor_id = internal.bridge_log_anchor(p_bridge_id)
     and (after_at is null or (m.created_at, m.entity_id) > (after_at, after_id))
     and internal.bridge_message_session(m.entity_id) is distinct from p_session_id;
  return n;
end
$$;
revoke all on function public.bridge_unread_count(uuid, uuid) from public;
grant execute on function public.bridge_unread_count(uuid, uuid) to tm8_app;

-- The session or chat a message was posted from: its session/chat origin edge
-- (message_recorder), else the caller holding it in this transaction.
create or replace function internal.bridge_message_poster(p_message_id uuid)
returns uuid language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v uuid;
begin
  select af.dst_id into v from public.edges af
    join public.entities s on s.id = af.dst_id and s.kind in ('work_session', 'chat')
   where af.src_id = p_message_id and af.type = 'authored_from' and not (af.props ? 'bridgeId')
   limit 1;
  if v is null then
    v := internal.bridge_caller_holder((select space_id from public.entities where id = p_message_id));
  end if;
  return v;
end
$$;
revoke all on function internal.bridge_message_poster(uuid) from public;

-- bridge_post_is_directed: a reply to a bridged message whose answerer (open
-- or already settled by this very reply) is the poster. The outbox's
-- "6 per 10 min un-directed" bucket counts everything else (§2.7).
create or replace function public.bridge_post_is_directed(p_message_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare v_parent uuid; poster uuid;
begin
  select e.parent_id into v_parent from public.entities e where e.id = p_message_id;
  if v_parent is null then return false; end if;
  poster := internal.bridge_message_poster(p_message_id);
  if poster is null then return false; end if;
  return exists (
    select 1 from public.bridge_message_answerers a
     where a.answerer_id = poster
       and (a.message_id = v_parent
            or a.message_id in (select c.entity_id from public.messages c
                                 join public.messages p on p.entity_id = v_parent
                                where p.message_batch_id is not null and c.message_batch_id = p.message_batch_id)));
end
$$;
revoke all on function public.bridge_post_is_directed(uuid) from public;
grant execute on function public.bridge_post_is_directed(uuid) to tm8_app;

-- bridge_origin_facts: the envelope's <origin kind="bridge" …/> for one
-- delivery of a log message to a session (§2.3): provider, conversation,
-- participant, trust, the provider id, directed, and the reader's unread count.
create or replace function public.bridge_origin_facts(p_message_id uuid, p_session_id uuid, p_directed boolean)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare o public.message_origins; b public.bridges; author jsonb;
begin
  select * into o from public.message_origins where message_id = p_message_id;
  if o.message_id is null then
    -- A copy in another anchor (the chat copy): its batch's log message.
    select mo.* into o from public.message_origins mo
      join public.messages c on c.entity_id = mo.message_id
      join public.messages m on m.entity_id = p_message_id
     where m.message_batch_id is not null and c.message_batch_id = m.message_batch_id
     limit 1;
  end if;
  if o.message_id is null then return null; end if;
  select * into b from public.bridges where entity_id = o.bridge_id;
  author := case when o.direction = 'in' and o.external_sender_id is not null
                 then internal.bridge_resolve_author(o.bridge_id, o.external_sender_id) end;
  return jsonb_build_object(
    'bridgeId', o.bridge_id, 'provider', b.provider,
    'conversation', coalesce(b.conversation ->> 'title', ''),
    'participant', coalesce(author -> 'participant' ->> 'displayName', ''),
    'trust', coalesce(author ->> 'trust', 'guest'),
    'externalMessageId', o.external_message_id,
    'directed', coalesce(p_directed, false),
    'unread', case when p_session_id is null then 0 else public.bridge_unread_count(o.bridge_id, p_session_id) end);
end
$$;
revoke all on function public.bridge_origin_facts(uuid, uuid, boolean) from public;
grant execute on function public.bridge_origin_facts(uuid, uuid, boolean) to tm8_app;

reset role;

analyze public.session_bridge_origins, public.bridge_message_answerers;
