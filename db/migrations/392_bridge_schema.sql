-- =============================================================================
-- 392 — Bridges B0a: the `bridge` kind, its tables, the `bridge_runtime` auth
-- kind, the edge rules, author resolution and the policy validator.
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- §2.1, §2.4, §3.1-§3.7, D20, D23, D25; build step B0a in §7.2. Task
-- 01a189d7-0ada-736e-aa83-728df7a38a6b. Where this file departs from the
-- design's §3.2 text it says so at the object and in D31-D34
-- (BRIDGE-ENTITY-DESIGN.md §8).
--
-- Predecessor: 390_tool_selection_headers.sql (main's top at open). 391 is
-- B0b's (labels); this file touches no object 391 does.
--
-- WHAT THIS FILE DOES
--   §1  the `bridge` core kind (Talk), with explicit capabilities;
--   §2  auth_sessions.kind learns `bridge_runtime` (no persona, no work
--       session, no space pin). Nothing mints one yet: B1b adds the mint and
--       the bridgeRuntime.* allow-list;
--   §3  the tables of §3.2 plus bridge_read_cursors (§2.7);
--   §4  the edge rules: `bridged_to` (server-written, one per bridge) and
--       `authored_from` gaining dst kind `bridge` (already recorder-owned);
--   §5  internal.validate_bridge_policy, the defaults, and
--       internal.bridge_resolve_author;
--   §6  internal.bridge_view (the one read both read paths select) and the
--       entity_content arm;
--   §7  the doors: create, update, retarget, pause, resume, remove, the
--       handle claim, the listen level and the log cursor.
--
-- REFUSALS. One custom SQLSTATE, TBC01 -> `conflict`, with details.reason:
-- `target_has_bridge` (D25), `already_connected` (D20, with connectedBy) and
-- `bridge_ended`. Ownership and admin refusals are 42501 with a reason.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The kind. Capabilities are stated explicitly (§3.1): the conversation is
--     its discussion, it links and is reacted to; it is flat, unassigned, has
--     no workflow (status is derived) and is never launched.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon, capabilities)
values ('bridge', 'core', null, 'bridge',
        '{"discussable":true,"linkable":true,"reactable":true,"hierarchical":false,"assignable":false,"workflowed":false,"spawnable":false}'::jsonb)
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- §2. auth_sessions.kind = 'bridge_runtime' (§2.5). The node mints one per
--     connector runtime: no persona, no work session, no chat runtime binding,
--     no space pin, no space link.
-- -----------------------------------------------------------------------------
alter table public.auth_sessions drop constraint if exists auth_sessions_kind_check;
alter table public.auth_sessions add constraint auth_sessions_kind_check
  check (kind in ('browser', 'cli', 'agent', 'agent_runtime', 'link', 'bridge_runtime'));

alter table public.auth_sessions add constraint auth_sessions_bridge_runtime_shape check (
  kind <> 'bridge_runtime'
  or (acting_as_team_member_id is null
      and work_session_id is null
      and runtime_member_id is null
      and runtime_thread_root_id is null
      and runtime_chat_id is null
      and space_id is null
      and via_link_id is null)
);

-- -----------------------------------------------------------------------------
-- §3. Tables.
-- -----------------------------------------------------------------------------

-- The closed provider vocabulary (§5), in one place for every check below.
create or replace function internal.bridge_provider_known(p text) returns boolean
language sql immutable set search_path = public, internal, pg_temp as $$
  select p in ('whatsapp', 'telegram', 'slack', 'discord', 'instagram', 'messenger')
$$;
revoke all on function internal.bridge_provider_known(text) from public;

-- Node-level, account-owned (§2.5). Holds NO secret bytes: state_ref names the
-- sealed blob on the node and is not granted to tm8_app at all.
create table public.bridge_connections (
  id                  uuid primary key default internal.new_id(),
  provider            text not null check (internal.bridge_provider_known(provider)),
  owner_account_id    uuid not null references public.accounts(id),
  label               text not null check (char_length(btrim(label)) between 1 and 80),
  external_account_id text,
  status              text not null default 'connecting'
                      check (status in ('connecting', 'linked', 'logged_out', 'offline', 'removed')),
  runtime_id          text,
  state_ref           text,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz
);
create index bridge_connections_owner_idx on public.bridge_connections(owner_account_id);

alter table public.bridge_connections enable row level security;
create policy bridge_connections_select on public.bridge_connections for select to tm8_app
  using (owner_account_id = internal.current_account_id() or internal.is_node_admin());
-- Column grant, not table grant: `state_ref` is never readable by the app role.
grant select (id, provider, owner_account_id, label, external_account_id, status,
              runtime_id, created_at, last_seen_at)
  on public.bridge_connections to tm8_app;

comment on table public.bridge_connections is
  '392 (Bridges §2.5): one authenticated provider account, owned by the human '
  'account that linked it. No secret: state_ref names the node-sealed blob and '
  'is withheld from tm8_app by a column grant.';

-- The bridge's detail row (§3.2).
--
-- DEPARTURES FROM §3.2, each in §8 of the design:
--   * credential_id is NULLABLE (D32): the offer flow that mints the space
--     credential (bridges.connections.offer) is not part of B0a, so a bridge is
--     created on its connection and the column is filled when the offer ships.
--   * the D20 unique is a partial index on live bridges (D33): remove keeps the
--     row as the tombstone (status 'ended'), and a table-level unique would
--     keep a removed group from ever being connected again.
--   * worker_wake carries the bridge's `workers.wake` ceiling (D34), which
--     bridges.listen caps a worker's own level by.
create table public.bridges (
  entity_id                uuid primary key references public.entities(id) on delete cascade,
  space_id                 uuid not null references public.spaces(id) on delete cascade,
  provider                 text not null check (internal.bridge_provider_known(provider)),
  connection_id            uuid not null references public.bridge_connections(id) on delete restrict,
  credential_id            uuid references public.entities(id),
  external_conversation_id text not null check (char_length(external_conversation_id) between 1 and 256),
  conversation             jsonb not null,
  target_kind              text not null check (target_kind in ('chat', 'work_session', 'channel')),
  target_id                uuid not null references public.entities(id),
  policy                   jsonb not null,
  paused_at                timestamptz,
  retention_days           integer check (retention_days between 1 and 3650),
  teammate_id              uuid references public.entities(id),
  purpose                  text check (purpose is null or (char_length(purpose) between 1 and 300 and purpose !~ '[\r\n]')),
  quiet_hours              jsonb,
  worker_posting           boolean not null default true,
  -- The ceiling for bridges.listen; update_bridge clamps workers above it (D34).
  worker_wake              text not null default 'directed' check (worker_wake in ('directed', 'thread', 'all')),
  ended_at                 timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
-- D20: a conversation is connected once per space, by any member's connection.
create unique index bridges_one_per_conversation
  on public.bridges(space_id, provider, external_conversation_id) where ended_at is null;
-- D25: one chat (session, channel) per bridge.
create unique index bridges_one_per_target on public.bridges(target_id) where ended_at is null;
create index bridges_space_idx on public.bridges(space_id, created_at desc);
create index bridges_connection_idx on public.bridges(connection_id);

comment on table public.bridges is
  '392 (Bridges §3.2): one provider conversation bound to one tm8 target. The '
  'target is also the bridged_to edge. ended_at is the tombstone (bridges.remove).';

-- Presence, per bridge (§2.4).
create table public.bridge_participants (
  bridge_id        uuid not null references public.bridges(entity_id) on delete cascade,
  external_id      text not null,
  alt_external_ids text[] not null default '{}',
  display_name     text,
  avatar_ref       text,
  muted            boolean not null default false,
  first_seen_at    timestamptz not null,
  last_seen_at     timestamptz not null,
  message_count    integer not null default 0,
  primary key (bridge_id, external_id)
);

-- Who a provider identity IS (§2.4). space_id null = identity-scoped (code,
-- invite); set = space-scoped (an admin's assertion). The unique holds over
-- unrevoked rows, so a revoked link can be made again.
create table public.bridge_identity_links (
  id                    uuid primary key default internal.new_id(),
  provider              text not null check (internal.bridge_provider_known(provider)),
  external_id           text not null,
  identity_id           text not null,
  method                text not null check (method in ('code', 'invite', 'admin')),
  space_id              uuid references public.spaces(id) on delete cascade,
  asserted_by_member_id uuid,
  verified_at           timestamptz not null,
  revoked_at            timestamptz,
  check ((method = 'admin') = (space_id is not null))
);
create unique index bridge_identity_links_one_live
  on public.bridge_identity_links(provider, external_id,
                                  coalesce(space_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;
create index bridge_identity_links_identity_idx on public.bridge_identity_links(identity_id);

create table public.bridge_link_codes (
  code        text primary key check (code ~ '^TM8-[A-Z0-9]{4,8}$'),
  identity_id text not null,
  provider    text not null check (internal.bridge_provider_known(provider)),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- Handles (§2.4, D23): one per session per space, the same name in every
-- group, never reused. An address, never an access grant.
create table public.bridge_handles (
  space_id   uuid not null references public.spaces(id) on delete cascade,
  handle     text not null check (handle ~ '^[a-z]+-[a-z]+(-[0-9]+)?$' and char_length(handle) <= 48),
  entity_id  uuid not null references public.entities(id) on delete cascade,
  kind       text not null check (kind in ('chat', 'work_session')),
  title      text check (title is null or char_length(title) between 1 and 80),
  status     text not null default 'live' check (status in ('live', 'ended')),
  created_at timestamptz not null default now(),
  primary key (space_id, handle),
  unique (space_id, entity_id)
);

create table public.bridge_handle_appearances (
  space_id  uuid not null,
  handle    text not null,
  bridge_id uuid not null references public.bridges(entity_id) on delete cascade,
  first_at  timestamptz not null,
  last_at   timestamptz not null,
  primary key (space_id, handle, bridge_id),
  foreign key (space_id, handle) references public.bridge_handles(space_id, handle) on delete cascade
);
create index bridge_handle_appearances_bridge_idx on public.bridge_handle_appearances(bridge_id, last_at desc);

-- The outbox (§2.3): idempotent on the message; the delivery ledger's states.
create table public.bridge_outbox (
  id                  uuid primary key default internal.new_id(),
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  message_id          uuid not null unique references public.messages(entity_id) on delete cascade,
  external_reply_to   text,
  payload             jsonb not null check (jsonb_typeof(payload) = 'object'),
  status              text not null default 'pending'
                      check (status in ('pending', 'dispatching', 'sent', 'failed_retryable', 'failed_permanent')),
  attempts            integer not null default 0 check (attempts >= 0),
  external_message_id text,
  created_at          timestamptz not null default now(),
  settled_at          timestamptz
);
create index bridge_outbox_bridge_idx on public.bridge_outbox(bridge_id, created_at desc);
create index bridge_outbox_open_idx on public.bridge_outbox(bridge_id) where status in ('pending', 'dispatching', 'failed_retryable');

-- Provenance of a bridged message (§2.3): deduped per bridge, from any number (D20).
create table public.message_origins (
  message_id               uuid primary key references public.messages(entity_id) on delete cascade,
  bridge_id                uuid not null references public.bridges(entity_id) on delete cascade,
  connection_id            uuid not null references public.bridge_connections(id),
  direction                text not null check (direction in ('in', 'out')),
  external_message_id      text not null,
  external_conversation_id text not null,
  external_sender_id       text,
  external_reply_to_id     text,
  external_ts              timestamptz,
  created_at               timestamptz not null default now(),
  unique (bridge_id, external_message_id, direction)
);

-- A worker's place in the log and its own wake level (§2.7, D21; D34).
create table public.bridge_read_cursors (
  bridge_id       uuid not null references public.bridges(entity_id) on delete cascade,
  session_id      uuid not null references public.entities(id) on delete cascade,
  last_message_id uuid references public.messages(entity_id) on delete set null,
  read_at         timestamptz,
  wake            text not null default 'directed' check (wake in ('directed', 'thread', 'all')),
  primary key (bridge_id, session_id)
);

-- RLS. Everything hung on a bridge follows 218's shape: an exists over
-- `entities_select`, `offset 0` keeping it a per-row probe.
alter table public.bridges enable row level security;
create policy bridges_select on public.bridges for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridges.entity_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridges to tm8_app;

alter table public.bridge_participants enable row level security;
create policy bridge_participants_select on public.bridge_participants for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_participants.bridge_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_participants to tm8_app;

alter table public.bridge_handles enable row level security;
create policy bridge_handles_select on public.bridge_handles for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_handles.entity_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_handles to tm8_app;

alter table public.bridge_handle_appearances enable row level security;
create policy bridge_handle_appearances_select on public.bridge_handle_appearances for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_handle_appearances.bridge_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_handle_appearances to tm8_app;

alter table public.message_origins enable row level security;
create policy message_origins_select on public.message_origins for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = message_origins.message_id and readable_entity.deleted_at is null offset 0)));
grant select on public.message_origins to tm8_app;

alter table public.bridge_outbox enable row level security;
create policy bridge_outbox_select on public.bridge_outbox for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_outbox.bridge_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_outbox to tm8_app;

alter table public.bridge_read_cursors enable row level security;
create policy bridge_read_cursors_select on public.bridge_read_cursors for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_read_cursors.bridge_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_read_cursors to tm8_app;

-- Links are readable by the identity they name and by admins of the space an
-- assertion is scoped to; identity-scoped rows reach a space only through the
-- resolver, never as a list (§3.2).
alter table public.bridge_identity_links enable row level security;
create policy bridge_identity_links_select on public.bridge_identity_links for select to tm8_app
  using (identity_id = internal.identity_id()
         or (space_id is not null and internal.is_space_admin(space_id)));
grant select on public.bridge_identity_links to tm8_app;

-- Codes are the identity's own; no list route reads them.
alter table public.bridge_link_codes enable row level security;
create policy bridge_link_codes_select on public.bridge_link_codes for select to tm8_app
  using (identity_id = internal.identity_id());
grant select on public.bridge_link_codes to tm8_app;

-- -----------------------------------------------------------------------------
-- §4. Edges.
-- -----------------------------------------------------------------------------

-- bridged_to: the tm8 side of a bridge. One per bridge; only the bridge doors
-- write, move or delete it (writer 'bridge').
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema)
values ('bridged_to', array['bridge'], array['chat', 'work_session', 'channel'],
        'Bridged to: the tm8 chat, session or channel this provider conversation is bound to.', false,
        '{"type":"object","properties":{"origin":{"type":"string"}},"additionalProperties":false}'::jsonb)
on conflict (type) do update
   set src_kinds = excluded.src_kinds, dst_kinds = excluded.dst_kinds,
       description = excluded.description, acyclic = excluded.acyclic,
       props_schema = excluded.props_schema;

create unique index if not exists edges_one_bridged_to on public.edges(src_id) where type = 'bridged_to';

create or replace function internal.guard_bridged_to_writer() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  -- A cascade from a deleted bridge or target removes the edge with no writer;
  -- the endpoint being gone is what tells it apart from a client delete.
  if tg_op = 'DELETE' and not exists (select 1 from public.entities where id = old.src_id)
     or tg_op = 'DELETE' and not exists (select 1 from public.entities where id = old.dst_id) then
    return old;
  end if;
  if coalesce(internal.w1_writer(), '') <> 'bridge' then
    raise exception 'bridged_to is written by the bridge doors; use tm8 bridge retarget'
      using errcode = '42501', detail = jsonb_build_object('reason', 'bridge_owned_edge')::text;
  end if;
  return coalesce(new, old);
end
$$;
revoke all on function internal.guard_bridged_to_writer() from public;

-- `when` on a row trigger cannot read both NEW and OLD for every event, so the
-- delete arm is its own trigger with the OLD-only condition.
drop trigger if exists edges_bridged_to_writer on public.edges;
create trigger edges_bridged_to_writer before insert or update on public.edges
for each row when (new.type = 'bridged_to')
execute function internal.guard_bridged_to_writer();
create trigger edges_bridged_to_writer_delete before delete on public.edges
for each row when (old.type = 'bridged_to')
execute function internal.guard_bridged_to_writer();

-- authored_from -> bridge (D22). `authored_from` is already recorder-owned in
-- internal.guard_w1_edge (052/308): no client can create or delete one, and
-- the entity recorder ('entity_recorder') is the writer D22 names. This adds
-- the destination kind and one shape rule: an edge to a bridge names that
-- bridge in props.bridgeId. The one-authored_from-per-source index (015/052)
-- is untouched here; D31 records why B1b narrows it together with its readers.
update public.edge_types
   set dst_kinds = array_append(dst_kinds, 'bridge')
 where type = 'authored_from' and not ('bridge' = any(dst_kinds));

create or replace function internal.guard_authored_from_bridge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if exists (select 1 from public.entities where id = new.dst_id and kind = 'bridge')
     and coalesce(new.props ->> 'bridgeId', '') <> new.dst_id::text then
    raise exception 'authored_from -> bridge must name the bridge in props.bridgeId'
      using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function internal.guard_authored_from_bridge() from public;
create trigger edges_authored_from_bridge before insert or update on public.edges
for each row when (new.type = 'authored_from')
execute function internal.guard_authored_from_bridge();

-- `attached_to` and `relates_to` already take any destination ('*').

-- -----------------------------------------------------------------------------
-- §5. Policy, defaults, author resolution.
-- -----------------------------------------------------------------------------

-- The BridgePolicy shape (§2.1), complete and closed: a definition-time error,
-- never a dead button (the 296 validate_mcp_definition precedent).
create or replace function internal.validate_bridge_policy(p jsonb) returns void
language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare k text;
begin
  if jsonb_typeof(p) is distinct from 'object'
     or not (p ?& array['trigger', 'direction', 'outbound', 'whoMayTrigger', 'voice', 'style']) then
    raise exception 'incomplete bridge policy' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if not k = any(array['trigger', 'direction', 'outbound', 'whoMayTrigger', 'voice', 'style']) then
      raise exception 'unknown bridge policy field %', k using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(p -> 'trigger') <> 'string' or p ->> 'trigger' not in ('mention', 'every', 'none') then
    raise exception 'policy.trigger must be mention, every or none' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'direction') <> 'string' or p ->> 'direction' not in ('both', 'in', 'out') then
    raise exception 'policy.direction must be both, in or out' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'outbound') <> 'string' or p ->> 'outbound' not in ('replies', 'all') then
    raise exception 'policy.outbound must be replies or all' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'whoMayTrigger') <> 'string' or p ->> 'whoMayTrigger' not in ('linked', 'anyone') then
    raise exception 'policy.whoMayTrigger must be linked or anyone' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'voice') <> 'string' or p ->> 'voice' not in ('named', 'plain') then
    raise exception 'policy.voice must be named or plain' using errcode = '22023';
  end if;
  if jsonb_typeof(p -> 'style') not in ('null', 'string')
     or (jsonb_typeof(p -> 'style') = 'string'
         and (char_length(p ->> 'style') not between 1 and 300 or p ->> 'style' ~ '[\r\n]')) then
    raise exception 'policy.style must be null or one line of at most 300 characters' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.validate_bridge_policy(jsonb) from public;

-- Defaults by target kind and conversation kind (§2.2, D16).
create or replace function internal.bridge_default_policy(p_target_kind text, p_conversation_kind text)
returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select case
    when p_target_kind = 'channel' then
      '{"trigger":"none","direction":"both","outbound":"all","whoMayTrigger":"linked","voice":"named","style":null}'::jsonb
    when p_conversation_kind = 'dm' then
      '{"trigger":"every","direction":"both","outbound":"replies","whoMayTrigger":"anyone","voice":"named","style":null}'::jsonb
    else
      '{"trigger":"mention","direction":"both","outbound":"replies","whoMayTrigger":"linked","voice":"named","style":null}'::jsonb
  end
$$;
revoke all on function internal.bridge_default_policy(text, text) from public;

create or replace function internal.validate_bridge_conversation(c jsonb) returns void
language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare k text;
begin
  if jsonb_typeof(c) is distinct from 'object' or not (c ?& array['kind', 'title']) then
    raise exception 'bridge conversation needs kind and title' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(c) loop
    if not k = any(array['kind', 'title', 'memberCount']) then
      raise exception 'unknown bridge conversation field %', k using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(c -> 'kind') <> 'string' or c ->> 'kind' not in ('group', 'channel', 'dm') then
    raise exception 'conversation.kind must be group, channel or dm' using errcode = '22023';
  end if;
  if jsonb_typeof(c -> 'title') <> 'string' or char_length(btrim(c ->> 'title')) not between 1 and 200 then
    raise exception 'conversation.title must be 1-200 characters' using errcode = '22023';
  end if;
  if c ? 'memberCount' and jsonb_typeof(c -> 'memberCount') <> 'null'
     and (jsonb_typeof(c -> 'memberCount') <> 'number' or (c ->> 'memberCount')::numeric < 0
          or (c ->> 'memberCount')::numeric <> trunc((c ->> 'memberCount')::numeric)) then
    raise exception 'conversation.memberCount must be a non-negative integer or null' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.validate_bridge_conversation(jsonb) from public;

create or replace function internal.validate_bridge_quiet_hours(q jsonb) returns void
language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if q is null or jsonb_typeof(q) = 'null' then return; end if;
  if jsonb_typeof(q) <> 'object' or not (q ?& array['start', 'end'])
     or (select count(*) from jsonb_object_keys(q)) <> 2
     or jsonb_typeof(q -> 'start') <> 'string' or jsonb_typeof(q -> 'end') <> 'string'
     or q ->> 'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or q ->> 'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or q ->> 'start' = q ->> 'end' then
    raise exception 'quietHours must be {start, end} as distinct HH:MM' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.validate_bridge_quiet_hours(jsonb) from public;

-- Row guard: the facts a door must never get wrong, re-checked on every write
-- (defence in depth; the doors give the friendly refusal first).
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
                           or new.connection_id <> old.connection_id
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

create trigger bridges_validate_kind before insert or update of entity_id on public.bridges
for each row execute function internal.validate_detail_envelope('bridge');
create trigger bridges_guard before insert or update on public.bridges
for each row execute function internal.guard_bridge_row();
create trigger bridges_touch before update on public.bridges
for each row execute function internal.touch_updated_at();
create trigger bridges_snapshot after update on public.bridges
for each row execute function internal.snapshot_entity_version();

-- The generic lifecycle doors never reach a bridge: bridges.remove is the end
-- (§3.4), so outbox, links and handles never outlive the entity quietly.
create or replace function internal.guard_bridge_entity() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'a bridge is removed with tm8 bridge remove (bridges.remove)'
      using errcode = '42501', detail = jsonb_build_object('reason', 'bridge_lifecycle')::text;
  end if;
  if new.space_id <> old.space_id or new.parent_id is distinct from old.parent_id then
    raise exception 'bridges are flat and cannot move between spaces' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function internal.guard_bridge_entity() from public;
create trigger bridge_entity_lifecycle before update of deleted_at, parent_id, space_id on public.entities
for each row when (old.kind = 'bridge') execute function internal.guard_bridge_entity();

-- Author resolution (§2.4): the ONE path that turns a provider sender into a
-- member. (provider, external id, or any alternate id the participant row
-- holds) -> an unrevoked identity-scoped link, else a space-scoped link for
-- THIS space -> that identity's ACTIVE member row in the bridge's space.
-- No match, or a member who left: a guest, authored by the bridge.
-- Server-only: granted to no app role (B1b's bridgeRuntime.inbound calls it
-- inside its own definer body).
create or replace function internal.bridge_resolve_author(p_bridge_id uuid, p_sender_external_id text)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  ids text[];
  link public.bridge_identity_links;
  member_id uuid;
  participant public.bridge_participants;
begin
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then
    raise exception 'bridge not found' using errcode = 'P0002';
  end if;
  select * into participant from public.bridge_participants
   where bridge_id = p_bridge_id and external_id = p_sender_external_id;
  ids := array[p_sender_external_id] || coalesce(participant.alt_external_ids, '{}');

  select * into link from public.bridge_identity_links l
   where l.provider = b.provider and l.external_id = any(ids) and l.revoked_at is null
     and l.space_id is null
   order by l.verified_at limit 1;
  if link.id is null then
    select * into link from public.bridge_identity_links l
     where l.provider = b.provider and l.external_id = any(ids) and l.revoked_at is null
       and l.space_id = b.space_id
     order by l.verified_at limit 1;
  end if;

  if link.id is not null then
    select m.entity_id into member_id
      from public.members m join public.entities e on e.id = m.entity_id
     where m.space_id = b.space_id and m.identity_id = link.identity_id
       and m.status = 'active' and e.deleted_at is null
     limit 1;
  end if;

  if member_id is null then
    return jsonb_build_object('kind', 'bridge', 'actorId', p_bridge_id, 'trust', 'guest',
      'participant', jsonb_build_object('displayName', coalesce(participant.display_name, 'Guest')));
  end if;
  return jsonb_build_object('kind', 'member', 'actorId', member_id,
    'trust', case when link.space_id is null then 'linked' else 'asserted' end,
    'identityId', link.identity_id, 'linkId', link.id,
    'participant', jsonb_build_object('displayName', coalesce(participant.display_name, '')));
end
$$;
revoke all on function internal.bridge_resolve_author(uuid, text) from public;
grant execute on function internal.bridge_resolve_author(uuid, text) to tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §6. The read. internal.bridge_view is the content both read paths and the
--     doors return, camelCase, with status and health DERIVED here once (T-L12).
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_target_title(p_kind text, p_id uuid)
returns text language sql stable set search_path = public, internal, pg_temp as $$
  select case p_kind
    when 'chat' then (select nullif(c.title, '') from public.chats c where c.entity_id = p_id)
    when 'work_session' then (select nullif(ws.title, '') from public.work_sessions ws where ws.entity_id = p_id)
    when 'channel' then (select ch.name from public.channels ch where ch.entity_id = p_id)
  end
$$;
revoke all on function internal.bridge_target_title(text, uuid) from public;

-- '+91 …9494': the last four characters, never the rest (§6 PII).
create or replace function internal.bridge_mask(p text) returns text
language sql immutable set search_path = public, internal, pg_temp as $$
  select case when p is null then null
              when char_length(regexp_replace(p, '@.*$', '')) <= 4 then '…'
              else '…' || right(regexp_replace(p, '@.*$', ''), 4) end
$$;
revoke all on function internal.bridge_mask(text) from public;

create or replace function internal.bridge_view(p_bridge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  conn public.bridge_connections;
  admin boolean;
  status text;
  last_in timestamptz;
  last_out timestamptz;
  queued integer;
  failed integer;
  participants integer;
  linked integer;
  guests integer;
  handle_count integer;
begin
  -- Definer, so readability is checked here, not left to RLS: a caller who
  -- cannot read the bridge entity gets nothing, from any space.
  if not internal.entity_readable(p_bridge_id) then return null; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then return null; end if;
  select * into conn from public.bridge_connections where id = b.connection_id;
  admin := internal.is_space_admin(b.space_id);

  status := case
    when b.ended_at is not null then 'ended'
    when b.paused_at is not null then 'paused'
    when conn.status is distinct from 'linked' then 'degraded'
    else 'live' end;

  select max(coalesce(o.external_ts, o.created_at)) filter (where o.direction = 'in'),
         max(coalesce(o.external_ts, o.created_at)) filter (where o.direction = 'out')
    into last_in, last_out
    from public.message_origins o where o.bridge_id = p_bridge_id;
  select count(*) filter (where ob.status in ('pending', 'dispatching', 'failed_retryable')),
         count(*) filter (where ob.status in ('failed_retryable', 'failed_permanent')
                            and ob.created_at > now() - interval '24 hours')
    into queued, failed
    from public.bridge_outbox ob where ob.bridge_id = p_bridge_id;

  select count(*),
         count(*) filter (where pl.linked),
         count(*) filter (where not pl.linked and p.last_seen_at > now() - interval '7 days')
    into participants, linked, guests
    from public.bridge_participants p
    cross join lateral (select exists (
           select 1 from public.bridge_identity_links l
            where l.provider = b.provider and l.revoked_at is null
              and (l.external_id = p.external_id or l.external_id = any(p.alt_external_ids))
              and (l.space_id is null or l.space_id = b.space_id)) as linked) pl
   where p.bridge_id = p_bridge_id;
  select count(*) into handle_count from public.bridge_handle_appearances a where a.bridge_id = p_bridge_id;

  return jsonb_build_object(
    'provider', b.provider,
    'connectionId', b.connection_id,
    'connectionCredentialId', b.credential_id,
    'conversation', jsonb_build_object(
      'externalId', case when b.conversation ->> 'kind' = 'dm' and not admin
                         then internal.bridge_mask(b.external_conversation_id)
                         else b.external_conversation_id end,
      'kind', b.conversation ->> 'kind',
      'title', b.conversation ->> 'title',
      'memberCount', b.conversation -> 'memberCount'),
    'target', jsonb_build_object('kind', b.target_kind, 'id', b.target_id,
      'title', coalesce(internal.bridge_target_title(b.target_kind, b.target_id), '')),
    'policy', b.policy,
    'status', status,
    'health', jsonb_build_object(
      'connection', case when conn.status in ('linked', 'connecting', 'logged_out') then conn.status else 'offline' end,
      'lastInboundAt', last_in, 'lastOutboundAt', last_out,
      'queued', coalesce(queued, 0), 'failed24h', coalesce(failed, 0),
      'detail', case when conn.status = 'removed' then 'connection removed' end),
    'people', jsonb_build_object('participants', coalesce(participants, 0), 'linked', coalesce(linked, 0),
                                 'guestsSeen7d', coalesce(guests, 0)),
    'handles', coalesce(handle_count, 0),
    'retentionDays', b.retention_days,
    'teammateId', b.teammate_id,
    'purpose', b.purpose,
    'quietHours', b.quiet_hours,
    'workerPosting', b.worker_posting,
    'workers', jsonb_build_object('wake', b.worker_wake),
    'pausedAt', b.paused_at,
    'endedAt', b.ended_at,
    'createdAt', b.created_at,
    'updatedAt', b.updated_at);
end
$$;
revoke all on function internal.bridge_view(uuid) from public;
grant execute on function internal.bridge_view(uuid) to tm8_app;

-- Content hydration. SHARED OBJECT: the live body (322's) verbatim; the
-- `bridge` arm is the only addition, and it is the bridge's own row minus
-- nothing secret (bridges holds none).
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      when 'drawing' then select to_jsonb(d) - 'entity_id' into content from public.drawings d where d.entity_id = target;
      -- `-` binds tighter than `||`: the entity_id is dropped, THEN the
      -- ordered sections and questions are merged in.
      when 'form' then select to_jsonb(fm) - 'entity_id'
                              || jsonb_build_object('sections', internal.form_sections_json(target),
                                                    'questions', internal.form_questions_json(target))
                         into content from public.forms fm where fm.entity_id = target;
      -- An allow-list, never to_jsonb(sc): the row holds the sealed secret,
      -- the hint and the vendor login (§3a).
      when 'credential' then select to_jsonb(cc) - 'entity_id' into content from public.credential_cards cc where cc.entity_id = target;
      -- 250 (W6): the shared link's metadata. `space_links` holds no secret; the
      -- sealed per-member token is `space_link_tokens` (251) and has no arm.
      when 'space_link' then select to_jsonb(sl) - 'entity_id' into content from public.space_links sl where sl.entity_id = target;
      -- W8: the server's metadata. `servers` holds no secret; the sealed
      -- per-member gate session is `server_gate_tokens` and has no arm.
      when 'server' then select to_jsonb(sv) - 'entity_id' into content from public.servers sv where sv.entity_id = target;
      -- 283: the story's title and description. Its roots are `contains`
      -- edges and its trail is computed (story_trail), never embedded here.
      when 'story' then select to_jsonb(st) - 'entity_id' into content from public.stories st where st.entity_id = target;
      -- 284: a space style's detail row. The row holds nothing secret (the
      -- document, tags and attribution), so the house form applies; the
      -- contract's camelCase shape is the read facade's job (`contentOf`).
      when 'style' then select to_jsonb(sty) - 'entity_id' into content from public.styles sty where sty.entity_id = target;
      when 'mcp_server' then select to_jsonb(m) - 'entity_id' into content from public.mcp_servers m where m.entity_id=target;
      -- 304/322: the craft's title and description. Its pages are `contains`
      -- edges ordered by props.position, never embedded here.
      when 'craft' then select to_jsonb(dsg) - 'entity_id' into content from public.crafts dsg where dsg.entity_id = target;
      when 'tool' then select to_jsonb(tl) - 'entity_id'
        || jsonb_build_object('config', coalesce((select jsonb_object_agg(c.input_name,c.value) from public.tool_config c where c.tool_id=target),'{}'::jsonb),
          'secretBindings', coalesce((select jsonb_agg(jsonb_build_object('inputName',b.input_name,'credentialId',b.credential_id,'boundBy',b.bound_by,'boundAt',b.bound_at)) from public.tool_secret_bindings b where b.tool_id=target),'[]'::jsonb))
        into content from public.tools tl where tl.entity_id=target;
      -- 392 (Bridges B0a): the detail row. No secret lives on it.
      when 'bridge' then select to_jsonb(br) - 'entity_id' into content from public.bridges br where br.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- §7. The doors. Each is security definer, ledgered on its clientMutationId,
--     and answers internal.command_result for the bridge.
-- -----------------------------------------------------------------------------

create or replace function internal.bridge_refuse(p_reason text, p_message text, p_details jsonb default '{}'::jsonb)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  raise exception '%', p_message using errcode = 'TBC01',
    detail = (jsonb_build_object('reason', p_reason) || coalesce(p_details, '{}'::jsonb))::text;
end
$$;
revoke all on function internal.bridge_refuse(text, text, jsonb) from public;

-- D25: a target already bridged by a live bridge (other than p_except).
create or replace function internal.bridge_assert_target_free(p_target_id uuid, p_except uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
declare other uuid;
begin
  select entity_id into other from public.bridges
   where target_id = p_target_id and ended_at is null and entity_id is distinct from p_except;
  if other is not null then
    perform internal.bridge_refuse('target_has_bridge',
      'this target already has a bridge; one group, one bridge, one chat',
      jsonb_build_object('bridgeId', other));
  end if;
end
$$;
revoke all on function internal.bridge_assert_target_free(uuid, uuid) from public;

-- The partial uniques behind D20 and D25, re-raised with their reason when a
-- concurrent door wins the race past the friendly checks. Called only from an
-- exception handler, where the diagnostics still name the constraint.
create or replace function internal.bridge_reraise_unique(p_constraint text)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if p_constraint = 'bridges_one_per_target' then
    perform internal.bridge_refuse('target_has_bridge',
      'this target already has a bridge; one group, one bridge, one chat');
  elsif p_constraint = 'bridges_one_per_conversation' then
    perform internal.bridge_refuse('already_connected', 'already connected by another member');
  end if;
  raise exception 'bridge write conflicts with %', coalesce(p_constraint, 'a unique constraint')
    using errcode = '23505';
end
$$;
revoke all on function internal.bridge_reraise_unique(text) from public;

create or replace function internal.bridge_live_target(p_space_id uuid, p_target_id uuid)
returns public.entities language plpgsql stable set search_path = public, internal, pg_temp as $$
declare target public.entities;
begin
  select * into target from public.entities where id = p_target_id;
  if target.id is null or target.deleted_at is not null or target.space_id <> p_space_id
     or not internal.entity_readable(target.id) then
    raise exception 'bridge target not found in this space' using errcode = 'P0002';
  end if;
  if target.kind not in ('chat', 'work_session', 'channel') then
    raise exception 'a bridge targets a chat, a work_session or a channel (got %)', target.kind
      using errcode = '22023';
  end if;
  return target;
end
$$;
revoke all on function internal.bridge_live_target(uuid, uuid) from public;

create or replace function internal.bridge_for_admin(p_bridge_id uuid)
returns public.bridges language plpgsql stable set search_path = public, internal, pg_temp as $$
declare b public.bridges; e public.entities;
begin
  e := internal.live_entity(p_bridge_id, 'bridge');
  perform internal.require_space_admin(e.space_id);
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.ended_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'this bridge was removed');
  end if;
  return b;
end
$$;
revoke all on function internal.bridge_for_admin(uuid) from public;

create or replace function internal.bridge_write_target_edge(b public.bridges, p_actor uuid)
returns void language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform internal.w1_set_writer('bridge');
  delete from public.edges where src_id = b.entity_id and type = 'bridged_to';
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (b.space_id, b.entity_id, b.target_id, 'bridged_to', p_actor);
  perform internal.w1_set_writer(null);
end
$$;
revoke all on function internal.bridge_write_target_edge(public.bridges, uuid) from public;

create or replace function public.create_bridge(
  p_space_id uuid,
  p_connection_id uuid,
  p_external_conversation_id text,
  p_conversation jsonb,
  p_target_id uuid,
  p_policy jsonb default '{}'::jsonb,
  p_teammate_id uuid default null,
  p_purpose text default null,
  p_quiet_hours jsonb default null,
  p_worker_posting boolean default true,
  p_retention_days integer default null,
  p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  conn public.bridge_connections;
  target public.entities;
  existing public.bridges;
  connected_by text;
  policy jsonb;
  new_id uuid;
  b public.bridges;
  v_constraint text;
begin
  -- D28: a human, a space admin, and the owner of the number.
  perform internal.require_human_auth_kind();
  perform internal.require_space_admin(p_space_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.create');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  select * into conn from public.bridge_connections where id = p_connection_id;
  if conn.id is null then
    raise exception 'bridge connection not found' using errcode = 'P0002';
  end if;
  if conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the connection''s owner can create a bridge on it' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  if conn.status = 'removed' then
    raise exception 'this connection was removed' using errcode = '22023';
  end if;

  perform internal.validate_bridge_conversation(p_conversation);
  target := internal.bridge_live_target(p_space_id, p_target_id);

  -- D20 before D25, so a second member's attempt names who connected it.
  select * into existing from public.bridges
   where space_id = p_space_id and provider = conn.provider
     and external_conversation_id = p_external_conversation_id and ended_at is null;
  if existing.entity_id is not null then
    select coalesce(internal.w2_entity_title(e.created_by), 'another member') into connected_by
      from public.entities e where e.id = existing.entity_id;
    perform internal.bridge_refuse('already_connected',
      format('already connected by %s', connected_by),
      jsonb_build_object('bridgeId', existing.entity_id, 'connectedBy', connected_by));
  end if;
  perform internal.bridge_assert_target_free(p_target_id, null);

  if jsonb_typeof(coalesce(p_policy, '{}'::jsonb)) <> 'object' then
    raise exception 'policy must be an object' using errcode = '22023';
  end if;
  policy := internal.bridge_default_policy(target.kind, p_conversation ->> 'kind') || coalesce(p_policy, '{}'::jsonb);
  perform internal.validate_bridge_policy(policy);

  new_id := internal.create_envelope(p_space_id, 'bridge', actor, null, null);
  begin
  insert into public.bridges(entity_id, space_id, provider, connection_id, credential_id,
                             external_conversation_id, conversation, target_kind, target_id, policy,
                             retention_days, teammate_id, purpose, quiet_hours, worker_posting)
  values (new_id, p_space_id, conn.provider, conn.id, null,
          p_external_conversation_id,
          jsonb_build_object('kind', p_conversation ->> 'kind', 'title', btrim(p_conversation ->> 'title'),
                             'memberCount', coalesce(p_conversation -> 'memberCount', 'null'::jsonb)),
          target.kind, target.id, policy,
          -- D15: keep a group's record; a DM is a person's, 90 days.
          coalesce(p_retention_days, case when p_conversation ->> 'kind' = 'dm' then 90 end),
          p_teammate_id, nullif(btrim(p_purpose), ''), p_quiet_hours, coalesce(p_worker_posting, true))
  returning * into b;
  exception when unique_violation then
    -- A concurrent create won between the checks above and this insert.
    get stacked diagnostics v_constraint = constraint_name;
    perform internal.bridge_reraise_unique(v_constraint);
  end;
  perform internal.bridge_write_target_edge(b, actor);
  perform internal.record_initial_version(new_id, actor);
  return internal.ledger_record(p_client_mutation_id, 'bridges.create',
    internal.command_result(new_id, null,
      internal.record_activity(p_space_id, new_id, actor, 'created', null,
        jsonb_build_object('kind', 'bridge', 'provider', conn.provider)), array[new_id]));
end
$$;
revoke all on function public.create_bridge(uuid, uuid, text, jsonb, uuid, jsonb, uuid, text, jsonb, boolean, integer, uuid, text) from public;
grant execute on function public.create_bridge(uuid, uuid, text, jsonb, uuid, jsonb, uuid, text, jsonb, boolean, integer, uuid, text) to tm8_app;

-- bridges.update: policy (merged over the stored one), purpose, teammate,
-- quiet hours, worker posting and wake ceiling, retention, conversation title.
-- p_patch keys are the contract's camelCase names; an absent key is unchanged,
-- an explicit null clears where null is meaningful.
create or replace function public.update_bridge(
  p_bridge_id uuid, p_expected_version integer, p_patch jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; actor uuid; b public.bridges; k text; policy jsonb;
begin
  b := internal.bridge_for_admin(p_bridge_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.update');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_bridge_id::text, 'entity');
    return replay;
  end if;
  actor := internal.resolve_actor(p_actor_id, b.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_bridge_id, p_expected_version);

  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'patch must be an object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not k = any(array['policy', 'purpose', 'teammateId', 'quietHours', 'workerPosting',
                         'workerWake', 'retentionDays', 'conversationTitle']) then
      raise exception 'unknown bridge field %', k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'policy' then
    if jsonb_typeof(p_patch -> 'policy') <> 'object' then
      raise exception 'policy must be an object' using errcode = '22023';
    end if;
    policy := b.policy || (p_patch -> 'policy');
    perform internal.validate_bridge_policy(policy);
    b.policy := policy;
  end if;
  if p_patch ? 'purpose' then b.purpose := nullif(btrim(p_patch ->> 'purpose'), ''); end if;
  if p_patch ? 'teammateId' then b.teammate_id := nullif(p_patch ->> 'teammateId', '')::uuid; end if;
  if p_patch ? 'quietHours' then
    b.quiet_hours := case when jsonb_typeof(p_patch -> 'quietHours') = 'null' then null else p_patch -> 'quietHours' end;
  end if;
  if p_patch ? 'workerPosting' then
    if jsonb_typeof(p_patch -> 'workerPosting') <> 'boolean' then
      raise exception 'workerPosting must be a boolean' using errcode = '22023';
    end if;
    b.worker_posting := (p_patch ->> 'workerPosting')::boolean;
  end if;
  if p_patch ? 'workerWake' then b.worker_wake := p_patch ->> 'workerWake'; end if;
  if p_patch ? 'retentionDays' then
    if jsonb_typeof(p_patch -> 'retentionDays') not in ('null', 'number') then
      raise exception 'retentionDays must be a number of days or null' using errcode = '22023';
    end if;
    b.retention_days := (p_patch ->> 'retentionDays')::integer;
  end if;
  if p_patch ? 'conversationTitle' then
    b.conversation := b.conversation || jsonb_build_object('title', btrim(p_patch ->> 'conversationTitle'));
  end if;

  update public.bridges set policy = b.policy, purpose = b.purpose, teammate_id = b.teammate_id,
         quiet_hours = b.quiet_hours, worker_posting = b.worker_posting, worker_wake = b.worker_wake,
         retention_days = b.retention_days, conversation = b.conversation
   where entity_id = p_bridge_id;
  -- A lowered ceiling lowers every worker above it in the same write, so no
  -- reader has to remember to take the least of the two (§2.7).
  if p_patch ? 'workerWake' then
    update public.bridge_read_cursors c set wake = b.worker_wake
     where c.bridge_id = p_bridge_id
       and ('{"directed":0,"thread":1,"all":2}'::jsonb ->> c.wake)::int
         > ('{"directed":0,"thread":1,"all":2}'::jsonb ->> b.worker_wake)::int;
  end if;
  return internal.ledger_record(p_client_mutation_id, 'bridges.update',
    internal.command_result(p_bridge_id, null,
      internal.record_activity(b.space_id, p_bridge_id, actor, 'updated', null,
        jsonb_build_object('kind', 'bridge', 'fields', (select jsonb_agg(x) from jsonb_object_keys(p_patch) x))),
      array[p_bridge_id]));
end
$$;
revoke all on function public.update_bridge(uuid, integer, jsonb, uuid, text) from public;
grant execute on function public.update_bridge(uuid, integer, jsonb, uuid, text) to tm8_app;

-- bridges.retarget: human-only; refuses a target that already has a bridge (D25).
create or replace function public.retarget_bridge(
  p_bridge_id uuid, p_expected_version integer, p_target_id uuid,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; b public.bridges; target public.entities; v_constraint text;
begin
  perform internal.require_human_auth_kind();
  b := internal.bridge_for_admin(p_bridge_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.retarget');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_bridge_id::text, 'entity');
    return replay;
  end if;
  actor := internal.resolve_actor(p_actor_id, b.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_bridge_id, p_expected_version);
  target := internal.bridge_live_target(b.space_id, p_target_id);
  if target.id = b.target_id then
    raise exception 'the bridge already targets this entity' using errcode = '22023';
  end if;
  perform internal.bridge_assert_target_free(p_target_id, p_bridge_id);
  begin
    update public.bridges set target_kind = target.kind, target_id = target.id
     where entity_id = p_bridge_id returning * into b;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform internal.bridge_reraise_unique(v_constraint);
  end;
  perform internal.bridge_write_target_edge(b, actor);
  return internal.ledger_record(p_client_mutation_id, 'bridges.retarget',
    internal.command_result(p_bridge_id, null,
      internal.record_activity(b.space_id, p_bridge_id, actor, 'updated', null,
        jsonb_build_object('kind', 'bridge', 'retargetedTo', target.id)), array[p_bridge_id, target.id]));
end
$$;
revoke all on function public.retarget_bridge(uuid, integer, uuid, uuid, text) from public;
grant execute on function public.retarget_bridge(uuid, integer, uuid, uuid, text) to tm8_app;

-- bridges.pause / bridges.resume / bridges.remove share one body.
create or replace function internal.bridge_set_state(
  p_op text, p_bridge_id uuid, p_expected_version integer, p_actor_id uuid, p_client_mutation_id text
) returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; b public.bridges;
begin
  if p_op = 'bridges.remove' then perform internal.require_human_auth_kind(); end if;
  b := internal.bridge_for_admin(p_bridge_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, p_op);
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_bridge_id::text, 'entity');
    return replay;
  end if;
  actor := internal.resolve_actor(p_actor_id, b.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_bridge_id, p_expected_version);
  case p_op
    when 'bridges.pause' then
      if b.paused_at is not null then raise exception 'the bridge is already paused' using errcode = '22023'; end if;
      update public.bridges set paused_at = now() where entity_id = p_bridge_id;
    when 'bridges.resume' then
      if b.paused_at is null then raise exception 'the bridge is not paused' using errcode = '22023'; end if;
      update public.bridges set paused_at = null where entity_id = p_bridge_id;
    when 'bridges.remove' then
      -- The tombstone: the row, the log, the edges and the handles stay readable;
      -- nothing crosses again. Pending outbox rows are failed permanently.
      update public.bridges set ended_at = now(), paused_at = null where entity_id = p_bridge_id;
      update public.bridge_outbox set status = 'failed_permanent', settled_at = now()
       where bridge_id = p_bridge_id and status in ('pending', 'dispatching', 'failed_retryable');
  end case;
  return internal.ledger_record(p_client_mutation_id, p_op,
    internal.command_result(p_bridge_id, null,
      internal.record_activity(b.space_id, p_bridge_id, actor,
        case p_op when 'bridges.remove' then 'deleted' else 'updated' end, null,
        jsonb_build_object('kind', 'bridge', 'op', p_op)), array[p_bridge_id]));
end
$$;
revoke all on function internal.bridge_set_state(text, uuid, integer, uuid, text) from public;

create or replace function public.pause_bridge(p_bridge_id uuid, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language sql security definer set search_path = public, internal, pg_temp as $$
  select internal.bridge_set_state('bridges.pause', p_bridge_id, p_expected_version, p_actor_id, p_client_mutation_id)
$$;
create or replace function public.resume_bridge(p_bridge_id uuid, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language sql security definer set search_path = public, internal, pg_temp as $$
  select internal.bridge_set_state('bridges.resume', p_bridge_id, p_expected_version, p_actor_id, p_client_mutation_id)
$$;
-- Human-only: the gate is the first statement of the shared body for this op.
create or replace function public.remove_bridge(p_bridge_id uuid, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_human_auth_kind();
  return internal.bridge_set_state('bridges.remove', p_bridge_id, p_expected_version, p_actor_id, p_client_mutation_id);
end
$$;
revoke all on function public.pause_bridge(uuid, integer, uuid, text) from public;
revoke all on function public.resume_bridge(uuid, integer, uuid, text) from public;
revoke all on function public.remove_bridge(uuid, integer, uuid, text) from public;
grant execute on function public.pause_bridge(uuid, integer, uuid, text) to tm8_app;
grant execute on function public.resume_bridge(uuid, integer, uuid, text) to tm8_app;
grant execute on function public.remove_bridge(uuid, integer, uuid, text) to tm8_app;

-- Handles (D23). Readable adjective-animal words, unique per space, never
-- reused: rows are never deleted, so a name once given stays taken.
create or replace function internal.bridge_new_handle(p_space_id uuid)
returns text language plpgsql volatile set search_path = public, internal, pg_temp as $$
declare
  adjectives constant text[] := array['amber','brave','brisk','calm','clever','cosmic','crisp','daring',
    'eager','fair','fleet','gentle','glad','golden','grand','happy','hardy','jolly','keen','kind',
    'lively','lucky','merry','mighty','misty','nimble','noble','plucky','proud','quick','quiet','rapid',
    'ready','rosy','sharp','shiny','silent','sleek','smart','snowy','spry','steady','sunny','swift',
    'tidy','vivid','warm','wise','witty','zesty'];
  animals constant text[] := array['badger','bear','beaver','bison','crane','crow','deer','dingo',
    'dolphin','eagle','falcon','ferret','finch','fox','gecko','goose','hare','hawk','heron','ibis',
    'jaguar','koala','lark','lemur','lynx','marten','mink','moose','newt','orca','otter','owl',
    'panda','puffin','quail','raven','robin','seal','shrew','sparrow','stoat','swan','tapir','tern',
    'tiger','toucan','vole','walrus','wolf','wren'];
  candidate text;
  attempt integer := 0;
begin
  loop
    candidate := adjectives[1 + floor(random() * array_length(adjectives, 1))::int]
              || '-' || animals[1 + floor(random() * array_length(animals, 1))::int];
    -- After the first tries a suffix keeps the space from ever running out.
    if attempt >= 8 then candidate := candidate || '-' || (2 + floor(random() * 998))::int; end if;
    exit when not exists (select 1 from public.bridge_handles where space_id = p_space_id and handle = candidate);
    attempt := attempt + 1;
    if attempt > 64 then raise exception 'could not mint a free handle' using errcode = '53400'; end if;
  end loop;
  return candidate;
end
$$;
revoke all on function internal.bridge_new_handle(uuid) from public;

-- bridges.handles.claim: the CALLER's own session, any session in the space;
-- idempotent, returns its one space handle. A handle grants nothing.
create or replace function public.claim_bridge_handle(p_space_id uuid, p_title text default null)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  v_session uuid;
  v_row public.bridge_handles;
  v_title text := nullif(btrim(p_title), '');
  v_attempt integer := 0;
  v_constraint text;
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
  select * into v_row from public.bridge_handles where space_id = p_space_id and entity_id = v_session;
  -- Two races, told apart by which unique fired: the same session claiming
  -- twice (the (space, entity) unique: re-read the winner's row), and two
  -- sessions minting the same name at once (the primary key: mint again).
  while v_row.handle is null loop
    v_attempt := v_attempt + 1;
    if v_attempt > 8 then raise exception 'could not mint a free handle' using errcode = '53400'; end if;
    begin
      insert into public.bridge_handles(space_id, handle, entity_id, kind, title)
      values (p_space_id, internal.bridge_new_handle(p_space_id), v_session, 'work_session',
              coalesce(v_title, left(nullif(internal.bridge_target_title('work_session', v_session), ''), 80)))
      returning * into v_row;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'bridge_handles_pkey' then
        select * into v_row from public.bridge_handles where space_id = p_space_id and entity_id = v_session;
      end if;
    end;
  end loop;
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

-- bridges.listen: the caller session's own wake level, capped by the bridge's
-- ceiling (§2.7). Any session in the space (D23).
create or replace function public.set_bridge_listen(p_bridge_id uuid, p_wake text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities; b public.bridges; v_session uuid;
  rank_of constant jsonb := '{"directed":0,"thread":1,"all":2}'::jsonb;
  v_row public.bridge_read_cursors;
begin
  e := internal.live_entity(p_bridge_id, 'bridge');
  perform internal.require_space_member(e.space_id);
  if not internal.entity_readable(e.id) then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.ended_at is not null then perform internal.bridge_refuse('bridge_ended', 'this bridge was removed'); end if;
  if p_wake is null or not rank_of ? p_wake then
    raise exception 'wake must be directed, thread or all' using errcode = '22023';
  end if;
  if (rank_of ->> p_wake)::int > (rank_of ->> b.worker_wake)::int then
    raise exception 'this bridge lets workers listen at most at %', b.worker_wake using errcode = '42501',
      detail = jsonb_build_object('reason', 'above_bridge_ceiling', 'ceiling', b.worker_wake)::text;
  end if;
  v_session := internal.caller_work_session(e.space_id);
  if v_session is null then
    raise exception 'a listen level belongs to a session: set it from inside a session in this space'
      using errcode = '42501', detail = jsonb_build_object('reason', 'not_a_session')::text;
  end if;
  insert into public.bridge_read_cursors(bridge_id, session_id, wake) values (p_bridge_id, v_session, p_wake)
  on conflict (bridge_id, session_id) do update set wake = excluded.wake
  returning * into v_row;
  return jsonb_build_object('bridgeId', v_row.bridge_id, 'sessionId', v_row.session_id, 'wake', v_row.wake,
                            'ceiling', b.worker_wake);
end
$$;
revoke all on function public.set_bridge_listen(uuid, text) from public;
grant execute on function public.set_bridge_listen(uuid, text) to tm8_app;

-- bridges.log.read: where the log is (the channel for a channel target, else
-- the bridge, §2.2), the calling session in this space (null for a member
-- without one), and that session's cursor. Definer so the app role need not
-- call internal.caller_work_session; readability is checked first.
create or replace function public.bridge_log_context(p_bridge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; v_session uuid;
begin
  if not internal.entity_readable(p_bridge_id) then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  select br.* into b from public.bridges br
    join public.entities e on e.id = br.entity_id and e.deleted_at is null
   where br.entity_id = p_bridge_id;
  if b.entity_id is null then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  v_session := internal.caller_work_session(b.space_id);
  return jsonb_build_object(
    'anchorId', case when b.target_kind = 'channel' then b.target_id else b.entity_id end,
    'sessionId', v_session,
    'cursor', (select c.last_message_id from public.bridge_read_cursors c
                where c.bridge_id = p_bridge_id and c.session_id = v_session));
end
$$;
revoke all on function public.bridge_log_context(uuid) from public;
grant execute on function public.bridge_log_context(uuid) to tm8_app;

-- bridges.log.read --unread: advance the caller session's cursor to the last
-- message it was shown. Only ever forward, and only to a message on the
-- bridge's log anchor.
create or replace function public.advance_bridge_read_cursor(p_bridge_id uuid, p_message_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e public.entities; b public.bridges; v_session uuid; anchor uuid; v_row public.bridge_read_cursors;
  current_at timestamptz; next_at timestamptz;
begin
  e := internal.live_entity(p_bridge_id, 'bridge');
  perform internal.require_space_member(e.space_id);
  if not internal.entity_readable(e.id) then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  v_session := internal.caller_work_session(e.space_id);
  if v_session is null then
    raise exception 'a read cursor belongs to a session' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_a_session')::text;
  end if;
  anchor := case when b.target_kind = 'channel' then b.target_id else b.entity_id end;
  select m.created_at into next_at from public.messages m where m.entity_id = p_message_id and m.anchor_id = anchor;
  if next_at is null then raise exception 'message is not on this bridge''s log' using errcode = '22023'; end if;
  select m.created_at into current_at
    from public.bridge_read_cursors c join public.messages m on m.entity_id = c.last_message_id
   where c.bridge_id = p_bridge_id and c.session_id = v_session;
  if current_at is not null and current_at > next_at then
    select * into v_row from public.bridge_read_cursors where bridge_id = p_bridge_id and session_id = v_session;
  else
    insert into public.bridge_read_cursors(bridge_id, session_id, last_message_id, read_at)
    values (p_bridge_id, v_session, p_message_id, now())
    on conflict (bridge_id, session_id) do update set last_message_id = excluded.last_message_id, read_at = now()
    returning * into v_row;
  end if;
  return jsonb_build_object('bridgeId', v_row.bridge_id, 'sessionId', v_row.session_id,
                            'lastMessageId', v_row.last_message_id, 'readAt', v_row.read_at, 'wake', v_row.wake);
end
$$;
revoke all on function public.advance_bridge_read_cursor(uuid, uuid) from public;
grant execute on function public.advance_bridge_read_cursor(uuid, uuid) to tm8_app;

reset role;

-- Never-analyzed tables are estimated at 10 pages (225); 229's precedent.
analyze public.bridge_connections, public.bridges, public.bridge_participants,
        public.bridge_identity_links, public.bridge_link_codes, public.bridge_handles,
        public.bridge_handle_appearances, public.bridge_outbox, public.message_origins,
        public.bridge_read_cursors;
