-- =============================================================================
-- 398 — Bridges B1b-2: the runtime doors, inbound, the outbox's hard checks and
-- buckets, delivery badges, and the watchdog (D19).
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- §2.3, §2.5, §2.6, §2.7, §6, D14, D19, D20, D28, D35, D37. Task
-- 01a189f3-5ab5-7062-bd38-16401fcff789. Builds on 395 (B0a's schema).
--
-- WHAT THIS FILE DOES
--   §1  who may call: the `bridge_runtime` session (minted here) and the
--       in-process bridges worker (background-job claim `bridges.runtime`);
--   §2  columns and tables: allowlist versions on the connection, command
--       state and the server-only provider payload on message_origins, the
--       outbox's poster/bucket columns, refusals, notices, mute;
--   §3  validate_message admits a bridge author (a guest's message, §3.7);
--   §4  the allowlist: derived from live, unpaused bridges; every push takes a
--       fresh version from the connection row, so versions only grow, across
--       server restarts too (D35);
--   §5  the runtime doors: hello, state, heartbeat, conversation-state,
--       inbound, sent;
--   §6  the outbox: one enqueue holding every hard check and bucket; the
--       outbound rules (a deferred trigger on messages, and chat turn
--       answers); notices and reactions; dispatch;
--   §7  the command state machine B1b-4 claims and settles;
--   §8  the watchdog tick; the delivery badge read.
--
-- REFUSALS. Delivery refusals are never errors: the message stays in tm8 and
-- its badge carries {status:'refused', reason, retryAfterMs?} (§2.7). Doors
-- called by the wrong kind of caller raise 42501 with details.reason.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Who may call.
-- -----------------------------------------------------------------------------

-- The runtime's own session: the bound auth kind AND a live bridge_runtime row
-- under the bound session id. The kind claim alone is not trusted: only a row
-- the node minted makes a caller the runtime.
create or replace function internal.bridge_runtime_session() returns uuid
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare sid uuid;
begin
  if internal.claim_text('tm8.auth_kind') is distinct from 'bridge_runtime' then
    raise exception 'only the bridge runtime may call this door' using errcode = '42501',
      detail = jsonb_build_object('reason', 'bridge_runtime_only')::text;
  end if;
  select s.id into sid from public.auth_sessions s
   where s.id = nullif(internal.claim_text('tm8.auth_session_id'), '')::uuid
     and s.kind = 'bridge_runtime' and s.revoked_at is null and s.expires_at > now();
  if sid is null then
    raise exception 'the bridge runtime session is not live' using errcode = '42501',
      detail = jsonb_build_object('reason', 'bridge_runtime_only')::text;
  end if;
  return sid;
end
$$;
revoke all on function internal.bridge_runtime_session() from public;

-- The same test as a boolean, for other lanes' doors that admit the runtime's
-- inbound transaction (B1b-4's confirm lookup, run inside it by detect()).
create or replace function internal.is_bridge_runtime() returns boolean
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.bridge_runtime_session();
  return true;
exception when insufficient_privilege then
  return false;
end
$$;
revoke all on function internal.is_bridge_runtime() from public;
grant execute on function internal.is_bridge_runtime() to tm8_app;

-- The in-process bridges worker (the 306/375 pattern): the closed-list claim
-- db/client.ts binds only from code, never from a request, and never on a
-- space-pinned session.
create or replace function internal.is_bridges_worker() returns boolean
language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(internal.claim_text('tm8.background_job') = 'bridges.runtime', false)
     and nullif(current_setting('tm8.session_space_id', true), '') is null
$$;
revoke all on function internal.is_bridges_worker() from public;
grant execute on function internal.is_bridges_worker() to tm8_app;

create or replace function internal.require_bridges_worker() returns void
language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if not internal.is_bridges_worker() then
    raise exception 'only the in-process bridges worker may call this door' using errcode = '42501',
      detail = jsonb_build_object('reason', 'bridges_worker_only')::text;
  end if;
end
$$;
revoke all on function internal.require_bridges_worker() from public;

-- The mint (§2.5, the 105 agent_runtime precedent): the node, as its owner,
-- mints one session per sidecar start. No persona, no work session, no space
-- pin (395's shape check). Its op allow-list is the bridgeRuntime doors: the
-- server refuses the kind on every other route (identity-resolver.ts), and
-- each door re-checks it here.
create or replace function public.issue_bridge_runtime_session(
  p_token_hash text, p_expires_at timestamptz, p_label text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare acct uuid; row_json jsonb;
begin
  if internal.identity_id() is null or not internal.is_node_admin() then
    raise exception 'only the node mints a bridge runtime session' using errcode = '42501';
  end if;
  if internal.claim_text('tm8.auth_kind') in ('agent', 'agent_runtime', 'link', 'bridge_runtime') then
    raise exception 'an agent credential cannot mint a bridge runtime session' using errcode = '42501';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '30 days' then
    raise exception 'a bridge runtime session lives at most 30 days' using errcode = '22023';
  end if;
  select a.id into acct from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
   order by a.created_at limit 1;
  if acct is null then raise exception 'no active account for the node owner' using errcode = '42501'; end if;
  insert into public.auth_sessions(account_id, kind, token_hash, expires_at, label)
  values (acct, 'bridge_runtime', p_token_hash, p_expires_at, left(p_label, 120))
  returning to_jsonb(auth_sessions) - 'token_hash' into row_json;
  return row_json;
end
$$;
revoke all on function public.issue_bridge_runtime_session(text, timestamptz, text) from public;
grant execute on function public.issue_bridge_runtime_session(text, timestamptz, text) to tm8_app;

-- Revokes every live bridge_runtime session with this label except one (the
-- session just minted for the same sidecar): a restart leaves one live token.
create or replace function public.revoke_bridge_runtime_sessions(p_label text, p_except uuid default null)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n integer;
begin
  if internal.identity_id() is null or not internal.is_node_admin() then
    raise exception 'only the node revokes a bridge runtime session' using errcode = '42501';
  end if;
  update public.auth_sessions set revoked_at = now()
   where kind = 'bridge_runtime' and label is not distinct from left(p_label, 120)
     and revoked_at is null and id is distinct from p_except;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function public.revoke_bridge_runtime_sessions(text, uuid) from public;
grant execute on function public.revoke_bridge_runtime_sessions(text, uuid) to tm8_app;

-- auth.sessions.list (249) never shows the runtime's session: 249's body
-- verbatim, with one filter in the caller's own list (a bridge_runtime row is
-- never space-pinned, so the space list cannot hold one).
CREATE OR REPLACE FUNCTION public.list_auth_sessions(p_space_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  caller text;
  rows jsonb;
begin
  caller := internal.require_identity();
  perform internal.require_human_auth_kind();

  if p_space_id is null then
    select coalesce(jsonb_agg(internal.auth_session_view(s) order by s.created_at desc), '[]'::jsonb)
      into rows
      from public.auth_sessions s
      join public.accounts a on a.id = s.account_id
     where a.identity_id = caller
       -- W4-P1: under a pin the own list is that space's sessions only; the
       -- account's gate sessions and its sessions in other spaces stay unseen.
       and (internal.session_space_id() is null or s.space_id = internal.session_space_id())
       and s.revoked_at is null
       and s.expires_at > now()
       -- 398: the connector runtime's session belongs to the node, not to a
       -- person; it is never listed (nor revocable from a list). The node
       -- re-mints it on every sidecar start.
       and s.kind <> 'bridge_runtime';
    return rows;
  end if;

  -- 227's helper honours the pin: an admin pinned to another space is refused.
  if not internal.is_space_admin(p_space_id) then
    raise exception 'space admin required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(internal.auth_session_view(s) order by s.created_at desc), '[]'::jsonb)
    into rows
    from public.auth_sessions s
   where s.space_id = p_space_id
     and s.revoked_at is null
     and s.expires_at > now();
  return rows;
end
$function$;

-- -----------------------------------------------------------------------------
-- §2. Columns and tables.
-- -----------------------------------------------------------------------------

alter table public.bridge_connections
  -- D35: the version of the last allowlist pushed. Bumped by every push, so a
  -- version is never reused and a restarted server continues above it.
  add column allowlist_version bigint not null default 0 check (allowlist_version >= 0),
  -- A bridge on this connection changed since the last push.
  add column allowlist_dirty boolean not null default true,
  -- The number's own JIDs (StateFrame.self: PN and LID), to detect @-mentions of it.
  add column self_ids text[] not null default '{}',
  add column heartbeat_at timestamptz,
  -- The last heartbeat's drop counters (counts only, never content, D28).
  add column runtime_counters jsonb,
  -- The watchdog's mark: this connection's runtime is down (attention raised).
  add column down_since timestamptz;
-- 395 grants tm8_app a column list on this table; none of these is added to it.

alter table public.bridges
  -- /mute (v2 §4.4): still on the allowlist, still logged, nothing sent.
  add column muted_until timestamptz;

alter table public.message_origins
  -- A command (§2.3 step 2): null = not a command. B1b-4 claims and settles it.
  add column command_state text check (command_state in ('pending', 'running', 'done', 'failed')),
  add column command_claimed_at timestamptz,
  add column command_settled_at timestamptz,
  add column command_attempts integer not null default 0,
  -- An inbound message that reached the target (§2.3 step 5).
  add column routed boolean not null default false,
  -- The participant's name as the provider sent it, at the time (display only).
  add column sender_display text,
  -- Media references as the runtime sent them: fetch handles, never bytes.
  add column media jsonb,
  -- SERVER-ONLY (B1a, binding): the sent proto message as JSON, with media keys
  -- and a poll's messageSecret. Never on a read route or in an event; the
  -- column is withheld from tm8_app below.
  add column provider_payload jsonb;

-- tm8_app reads message_origins column by column, never provider_payload.
revoke select on public.message_origins from tm8_app;
grant select (message_id, bridge_id, connection_id, direction, external_message_id, external_conversation_id,
              external_sender_id, external_reply_to_id, external_ts, created_at, command_state,
              command_claimed_at, command_settled_at, command_attempts, routed, sender_display, media)
  on public.message_origins to tm8_app;

create index message_origins_commands_open_idx on public.message_origins(command_claimed_at)
  where command_state in ('pending', 'running');
create index message_origins_routed_recent_idx on public.message_origins(bridge_id, created_at desc)
  where direction = 'in' and routed;

alter table public.bridge_outbox
  add column kind text not null default 'send' check (kind in ('send', 'react')),
  add column reaction text check (reaction is null or char_length(reaction) between 1 and 16),
  add column connection_id uuid references public.bridge_connections(id),
  add column external_conversation_id text,
  -- Who posted: decides which buckets apply (§2.7).
  add column poster text not null default 'member' check (poster in ('member', 'worker', 'chat', 'notice', 'system')),
  add column teammate_id uuid,
  add column session_id uuid,
  -- A reply to a message directed to this poster (§2.7's un-directed limit).
  add column directed boolean not null default false,
  add column dispatched_at timestamptz,
  add column next_attempt_at timestamptz,
  add column last_error text;

-- One send per message, one reaction per (message, emoji).
alter table public.bridge_outbox drop constraint bridge_outbox_message_id_key;
create unique index bridge_outbox_one_send on public.bridge_outbox(message_id) where kind = 'send';
create unique index bridge_outbox_one_react on public.bridge_outbox(message_id, reaction) where kind = 'react';
create index bridge_outbox_connection_recent_idx on public.bridge_outbox(connection_id, created_at desc);
create index bridge_outbox_teammate_recent_idx on public.bridge_outbox(teammate_id, bridge_id, created_at desc)
  where teammate_id is not null;
create index bridge_outbox_due_idx on public.bridge_outbox(connection_id, created_at)
  where status in ('pending', 'failed_retryable');

-- A post the outbox refused (§2.7): the message stays in tm8, and this is its badge.
create table public.bridge_delivery_refusals (
  message_id     uuid primary key references public.messages(entity_id) on delete cascade,
  bridge_id      uuid not null references public.bridges(entity_id) on delete cascade,
  reason         text not null check (reason in ('bridge_paused', 'bridge_ended', 'direction_in', 'worker_posting_off',
                                                 'rate_limited', 'not_connected', 'credential_text')),
  retry_after_ms integer check (retry_after_ms is null or retry_after_ms >= 0),
  created_at     timestamptz not null default now()
);
alter table public.bridge_delivery_refusals enable row level security;
create policy bridge_delivery_refusals_select on public.bridge_delivery_refusals for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_delivery_refusals.message_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_delivery_refusals to tm8_app;

-- Notices are idempotent on their caller's key (B1b-4: `cmd:<bridge>:<external id>`).
create table public.bridge_notices (
  idempotency_key text primary key check (char_length(idempotency_key) between 1 and 300),
  bridge_id       uuid not null references public.bridges(entity_id) on delete cascade,
  message_id      uuid not null references public.messages(entity_id) on delete cascade,
  created_at      timestamptz not null default now()
);
alter table public.bridge_notices enable row level security;
-- No policy and no grant: read only through the definer doors.

-- -----------------------------------------------------------------------------
-- §3. A guest's message is authored by the bridge (§3.7). validate_message is
--     001's body verbatim; the author rule admits a `bridge` of the space.
--     Only the definer doors below ever write one: every app-facing post
--     resolves its author through internal.resolve_actor (member/teammate).
-- -----------------------------------------------------------------------------
create or replace function internal.validate_message() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  self public.entities;
  anchor public.entities;
  author public.entities;
  parent public.messages;
begin
  select * into self   from public.entities where id = new.entity_id;
  select * into anchor from public.entities where id = new.anchor_id;
  select * into author from public.entities where id = new.author_id;

  if anchor.id is null or anchor.space_id <> self.space_id then
    raise exception 'message anchor must exist in the message space' using errcode = '23503';
  end if;
  if author.id is null or author.space_id <> self.space_id
     or author.kind not in ('member','team_member','bridge') then
    raise exception 'message author must be a member, team_member or bridge of the space' using errcode = '23514';
  end if;

  -- Immutability (D-inherited): identity, anchor, author, thread root and the
  -- idempotency key can never change. Only body/mentions/attachments may.
  if tg_op = 'UPDATE' and (
       new.entity_id <> old.entity_id
    or new.anchor_id <> old.anchor_id
    or new.author_id <> old.author_id
    or new.root_message_id is distinct from old.root_message_id
    or new.client_msg_id is distinct from old.client_msg_id
    or new.created_at <> old.created_at
  ) then
    raise exception 'message identity, anchor, author, root and client id are immutable'
      using errcode = '23514';
  end if;

  if self.parent_id is null then
    if new.root_message_id is not null then
      raise exception 'a top-level message has no thread root' using errcode = '23514';
    end if;
  else
    select * into parent from public.messages where entity_id = self.parent_id;
    if parent.entity_id is null then
      raise exception 'a message reply must have a message parent' using errcode = '23503';
    end if;
    if parent.anchor_id <> new.anchor_id then
      raise exception 'a reply must use its parent message anchor' using errcode = '23514';
    end if;
    if new.root_message_id is distinct from coalesce(parent.root_message_id, parent.entity_id) then
      raise exception 'reply root_message_id must match its thread root' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- §4. The allowlist (§2.3, D28, D35).
-- -----------------------------------------------------------------------------

-- A connection's allowlist: the conversation ids of its live, unpaused bridges.
-- A muted bridge stays on it (§2.7): still read and logged, nothing sent.
create or replace function internal.bridge_allowlist_ids(p_connection uuid) returns text[]
language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(array_agg(distinct b.external_conversation_id order by b.external_conversation_id), '{}')
    from public.bridges b join public.entities e on e.id = b.entity_id and e.deleted_at is null
   where b.connection_id = p_connection and b.ended_at is null and b.paused_at is null
$$;
revoke all on function internal.bridge_allowlist_ids(uuid) from public;

-- One allowlist frame, with a FRESH version from the row (D35): every push,
-- the `hello` reply and `connect` take the next number, so the runtime never
-- sees a version twice and a restarted server continues above the last one.
create or replace function internal.bridge_allowlist_frame(p_connection uuid) returns jsonb
language plpgsql set search_path = public, internal, pg_temp as $$
declare v bigint;
begin
  update public.bridge_connections
     set allowlist_version = allowlist_version + 1, allowlist_dirty = false
   where id = p_connection
  returning allowlist_version into v;
  if v is null then raise exception 'bridge connection not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('type', 'allowlist', 'connectionId', p_connection, 'version', v,
                            'conversationIds', to_jsonb(internal.bridge_allowlist_ids(p_connection)));
end
$$;
revoke all on function internal.bridge_allowlist_frame(uuid) from public;

-- Every change that can move a conversation on or off the list marks its
-- connection; the hub pushes marked connections within a second.
create or replace function internal.bridge_mark_allowlist() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if tg_op = 'UPDATE'
     and new.paused_at is not distinct from old.paused_at
     and new.ended_at is not distinct from old.ended_at then
    return null;
  end if;
  update public.bridge_connections set allowlist_dirty = true
   where id = coalesce(new.connection_id, old.connection_id) and not allowlist_dirty;
  return null;
end
$$;
revoke all on function internal.bridge_mark_allowlist() from public;
create trigger bridges_mark_allowlist after insert or update or delete on public.bridges
for each row execute function internal.bridge_mark_allowlist();

-- Whatever path dirtied a connection (pause, resume, remove, a credential
-- withdraw's trigger, a runtime fault, a stale heartbeat), the hub hears it at
-- once: it LISTENs on this channel and re-reads the marked rows, and its poll
-- covers a notify lost to a reconnect. The payload is only the connection id.
create or replace function internal.bridge_notify_allowlist() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform pg_notify('tm8_bridge_allowlist', new.id::text);
  return null;
end
$$;
revoke all on function internal.bridge_notify_allowlist() from public;
create trigger bridge_connections_notify_allowlist after insert or update of allowlist_dirty on public.bridge_connections
for each row when (new.allowlist_dirty) execute function internal.bridge_notify_allowlist();

-- The hub's push: every marked connection run by one of these runtimes, each
-- with a fresh frame and the runtime to send it to.
create or replace function internal.bridge_allowlists_due(p_runtime_ids text[]) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare c record; frames jsonb := '[]'::jsonb;
begin
  perform internal.require_bridges_worker();
  for c in select id, runtime_id from public.bridge_connections
            where allowlist_dirty and runtime_id = any(p_runtime_ids) and status <> 'removed'
            order by id for update skip locked loop
    frames := frames || jsonb_build_array(jsonb_build_object(
      'runtimeId', c.runtime_id, 'frame', internal.bridge_allowlist_frame(c.id)));
  end loop;
  return frames;
end
$$;
revoke all on function internal.bridge_allowlists_due(text[]) from public;
grant execute on function internal.bridge_allowlists_due(text[]) to tm8_app;

-- B1b-5's `connect`: bind the connection to the runtime and hand back a fresh
-- allowlist for the frame. The stateKey is added in TypeScript (D38): SQL
-- never sees it.
create or replace function internal.bridge_runtime_connect(p_connection uuid, p_runtime_id text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections;
begin
  perform internal.require_bridges_worker();
  update public.bridge_connections set runtime_id = p_runtime_id
   where id = p_connection and status <> 'removed' returning * into conn;
  if conn.id is null then raise exception 'bridge connection not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('connectionId', conn.id, 'provider', conn.provider,
                            'allowlist', internal.bridge_allowlist_frame(conn.id));
end
$$;
revoke all on function internal.bridge_runtime_connect(uuid, text) from public;
grant execute on function internal.bridge_runtime_connect(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §5. The runtime doors (§2.5, D35). Each re-checks the caller first.
-- -----------------------------------------------------------------------------

-- hello: the connections this runtime runs (every connection of its provider
-- on this node that is not logged out or removed: a logged-out number waits
-- for its owner to re-link, D38) and each one's allowlist.
create or replace function public.bridge_runtime_hello(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_runtime text := p_frame ->> 'runtimeId'; v_provider text := p_frame ->> 'provider'; c record;
        rows jsonb := '[]'::jsonb;
begin
  perform internal.bridge_runtime_session();
  if v_runtime is null or char_length(v_runtime) not between 1 and 200 or not internal.bridge_provider_known(v_provider) then
    raise exception 'hello needs a runtimeId and a known provider' using errcode = '22023';
  end if;
  for c in select id from public.bridge_connections
            where bridge_connections.provider = v_provider
              and status not in ('logged_out', 'removed')
            order by created_at, id for update loop
    update public.bridge_connections set runtime_id = v_runtime, last_seen_at = now() where id = c.id;
    rows := rows || jsonb_build_array(jsonb_build_object(
      'connectionId', c.id, 'allowlist', internal.bridge_allowlist_frame(c.id)));
  end loop;
  return jsonb_build_object('connections', rows);
end
$$;
revoke all on function public.bridge_runtime_hello(jsonb) from public;
grant execute on function public.bridge_runtime_hello(jsonb) to tm8_app;

-- connection.state: status, the number's own ids once linked.
create or replace function public.bridge_runtime_state(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections; st text := p_frame ->> 'status'; self_ids text[];
begin
  perform internal.bridge_runtime_session();
  if st not in ('connecting', 'linked', 'logged_out', 'offline') then
    raise exception 'unknown connection status' using errcode = '22023';
  end if;
  select array_remove(array[p_frame #>> '{self,id}', p_frame #>> '{self,lid}'], null) into self_ids;
  update public.bridge_connections
     set status = st, last_seen_at = now(),
         self_ids = case when cardinality(self_ids) > 0 then self_ids else bridge_connections.self_ids end,
         external_account_id = coalesce(p_frame #>> '{self,id}', external_account_id)
   where id = (p_frame ->> 'connectionId')::uuid and status <> 'removed'
  returning * into conn;
  if conn.id is null then raise exception 'bridge connection not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('connectionId', conn.id, 'status', conn.status);
end
$$;
revoke all on function public.bridge_runtime_state(jsonb) from public;
grant execute on function public.bridge_runtime_state(jsonb) to tm8_app;

-- heartbeat: every 30 s. A connection whose runtime holds an older allowlist
-- than the last one pushed is marked for a re-push.
create or replace function public.bridge_runtime_heartbeat(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare item jsonb; n integer := 0;
begin
  perform internal.bridge_runtime_session();
  for item in select * from jsonb_array_elements(coalesce(p_frame -> 'connections', '[]'::jsonb)) loop
    update public.bridge_connections
       set heartbeat_at = now(), last_seen_at = now(),
           status = case when item ->> 'status' in ('connecting', 'linked', 'logged_out', 'offline')
                         then item ->> 'status' else status end,
           runtime_counters = item -> 'dropped',
           allowlist_dirty = allowlist_dirty
             or coalesce((item ->> 'allowlistVersion')::bigint, -1) < allowlist_version
     where id = (item ->> 'connectionId')::uuid and status <> 'removed'
       and runtime_id is not distinct from (p_frame ->> 'runtimeId');
    n := n + 1;
  end loop;
  return jsonb_build_object('connections', n);
end
$$;
revoke all on function public.bridge_runtime_heartbeat(jsonb) from public;
grant execute on function public.bridge_runtime_heartbeat(jsonb) to tm8_app;

-- conversation-state: an admins-only group the number can't post in falls back
-- to `direction: in` (D28). Restoring it is an admin's act.
create or replace function public.bridge_runtime_conversation_state(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare n integer := 0;
begin
  perform internal.bridge_runtime_session();
  if coalesce((p_frame ->> 'canSend')::boolean, true) = false then
    update public.bridges
       set policy = jsonb_set(policy, '{direction}', '"in"')
     where connection_id = (p_frame ->> 'connectionId')::uuid
       and external_conversation_id = p_frame ->> 'conversationId'
       and ended_at is null and policy ->> 'direction' <> 'in';
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('updated', n);
end
$$;
revoke all on function public.bridge_runtime_conversation_state(jsonb) from public;
grant execute on function public.bridge_runtime_conversation_state(jsonb) to tm8_app;

-- The bridge's log anchor (§2.2): the channel for a channel target, else the bridge.
create or replace function internal.bridge_log_anchor(b public.bridges) returns uuid
language sql immutable set search_path = public, internal, pg_temp as $$
  select case when b.target_kind = 'channel' then b.target_id else b.entity_id end
$$;
revoke all on function internal.bridge_log_anchor(public.bridges) from public;

-- The bridged origin of a message: its own message_origins row, or the row of
-- the message it was batch-copied with (the log copy of a routed message).
create or replace function internal.bridge_origin_of(p_message uuid) returns public.message_origins
language sql stable set search_path = public, internal, pg_temp as $$
  select o.* from public.message_origins o where o.message_id = p_message
  union all
  select o.* from public.messages m
    join public.messages twin on twin.message_batch_id = m.message_batch_id and twin.entity_id <> m.entity_id
    join public.message_origins o on o.message_id = twin.entity_id
   where m.entity_id = p_message and m.message_batch_id is not null
  limit 1
$$;
revoke all on function internal.bridge_origin_of(uuid) from public;

-- Calls into B1b-3's doors when its migration is present (merge order is free).
create or replace function internal.bridge_try(p_fn text, p_args text, variadic p_vals text[] default '{}')
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  if to_regprocedure(p_fn || '(' || p_args || ')') is null then return null; end if;
  execute format('select to_jsonb(%s(%s))', p_fn,
    (select string_agg(format('%L::%s', v, t), ', ')
       from unnest(p_vals, string_to_array(p_args, ',')) as x(v, t)))
    into result;
  return result;
end
$$;
revoke all on function internal.bridge_try(text, text, text[]) from public;

-- The live, unpaused bridge a runtime frame names, for the server's command
-- detection inside the inbound transaction (the app role cannot read bridges
-- as the runtime: it is no member of their spaces).
create or replace function public.bridge_runtime_bridge_for(p_connection uuid, p_conversation text) returns uuid
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare id uuid;
begin
  perform internal.bridge_runtime_session();
  select b.entity_id into id from public.bridges b
   where b.connection_id = p_connection and b.external_conversation_id = p_conversation
     and b.ended_at is null and b.paused_at is null;
  return id;
end
$$;
revoke all on function public.bridge_runtime_bridge_for(uuid, text) from public;
grant execute on function public.bridge_runtime_bridge_for(uuid, text) to tm8_app;

-- inbound (§2.3): resolve, dedupe, author, store on the log anchor, origins,
-- route. `p_command` is the executor's detect() answer, computed in the same
-- transaction by the server. A conversation off this connection's allowlist is
-- a runtime fault: refused, counted, and the allowlist is pushed again.
create or replace function public.bridge_runtime_inbound(p_frame jsonb, p_command boolean default false) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  conn public.bridge_connections;
  b public.bridges;
  ext text := p_frame ->> 'externalMessageId';
  conv text := p_frame ->> 'conversationId';
  sender text := p_frame #>> '{sender,externalId}';
  sender_name text := nullif(btrim(coalesce(p_frame #>> '{sender,name}', '')), '');
  alt text := p_frame #>> '{sender,altId}';
  body text := coalesce(p_frame ->> 'body', '');
  author jsonb;
  log_anchor uuid;
  anchor_e public.entities;
  parent_msg uuid;
  parent_row public.messages;
  thread_root uuid;
  reply_ext text := p_frame #>> '{replyTo,externalMessageId}';
  log_id uuid;
  copy_id uuid;
  batch text;
  ts timestamptz;
  triggered boolean := false;
  allowed boolean;
  routed boolean := false;
  chat_row public.chats;
  actor_kind text;
  existing uuid;
  wake jsonb := null;
  target_e public.entities;
begin
  perform internal.bridge_runtime_session();
  if ext is null or conv is null or char_length(ext) > 256 then
    raise exception 'inbound needs a conversationId and an externalMessageId' using errcode = '22023';
  end if;
  select * into conn from public.bridge_connections where id = (p_frame ->> 'connectionId')::uuid;
  if conn.id is null or conn.status = 'removed' then
    return jsonb_build_object('status', 'refused', 'reason', 'unknown_connection');
  end if;
  -- A reaction or a poll vote is not a message: nothing is stored for it yet.
  if p_frame -> 'reaction' is not null and jsonb_typeof(p_frame -> 'reaction') = 'object' then
    return jsonb_build_object('status', 'ignored', 'reason', 'reaction');
  end if;
  if p_frame -> 'pollVote' is not null and jsonb_typeof(p_frame -> 'pollVote') = 'object' then
    return jsonb_build_object('status', 'ignored', 'reason', 'poll_vote');
  end if;

  select br.* into b from public.bridges br join public.entities e on e.id = br.entity_id and e.deleted_at is null
   where br.connection_id = conn.id and br.external_conversation_id = conv
     and br.ended_at is null and br.paused_at is null
   for update of br;
  if b.entity_id is null then
    -- D28: the runtime forwarded something off its allowlist. Push it again.
    update public.bridge_connections
       set allowlist_dirty = true,
           runtime_counters = jsonb_set(coalesce(runtime_counters, '{}'::jsonb), '{serverRefused}',
             to_jsonb(coalesce((runtime_counters ->> 'serverRefused')::integer, 0) + 1))
     where id = conn.id;
    return jsonb_build_object('status', 'refused', 'reason', 'not_on_allowlist');
  end if;

  -- Exactly once per bridge, from any number (D20).
  perform pg_advisory_xact_lock(hashtextextended('bridge-in:' || b.entity_id || ':' || ext, 0));
  select message_id into existing from public.message_origins
   where bridge_id = b.entity_id and external_message_id = ext and direction = 'in';
  if existing is not null then
    return jsonb_build_object('status', 'duplicate', 'messageId', existing, 'bridgeId', b.entity_id);
  end if;

  -- Presence (§2.4): the participant row the resolver reads alternate ids from.
  if sender is not null then
    insert into public.bridge_participants(bridge_id, external_id, alt_external_ids, display_name,
                                           first_seen_at, last_seen_at, message_count)
    values (b.entity_id, sender, case when alt is null then '{}' else array[alt] end, sender_name, now(), now(), 1)
    on conflict (bridge_id, external_id) do update
      set display_name = coalesce(excluded.display_name, bridge_participants.display_name),
          alt_external_ids = case when alt is null or alt = any(bridge_participants.alt_external_ids)
                                  then bridge_participants.alt_external_ids
                                  else bridge_participants.alt_external_ids || alt end,
          last_seen_at = now(), message_count = bridge_participants.message_count + 1;
    author := internal.bridge_resolve_author(b.entity_id, sender);
  else
    author := jsonb_build_object('kind', 'bridge', 'actorId', b.entity_id, 'trust', 'guest',
                                 'participant', jsonb_build_object('displayName', coalesce(sender_name, 'Guest')));
  end if;

  if body = '' then
    body := coalesce((select string_agg(coalesce(m ->> 'caption', '[' || coalesce(m ->> 'kind', 'media') || ']'), E'\n')
                        from jsonb_array_elements(coalesce(p_frame -> 'media', '[]'::jsonb)) m), '');
  end if;
  if body = '' then body := '[message]'; end if;
  body := left(body, 10000);

  log_anchor := internal.bridge_log_anchor(b);
  select * into anchor_e from public.entities where id = log_anchor;
  -- A quote of a message we hold threads under its log copy.
  if reply_ext is not null then
    select o.message_id into parent_msg from public.message_origins o
     join public.messages m on m.entity_id = o.message_id and m.anchor_id = log_anchor
     where o.bridge_id = b.entity_id and o.external_message_id = reply_ext
     order by o.direction limit 1;
    if parent_msg is not null then
      select * into parent_row from public.messages where entity_id = parent_msg;
      thread_root := coalesce(parent_row.root_message_id, parent_row.entity_id);
    end if;
  end if;

  ts := case when p_frame ? 'ts' and jsonb_typeof(p_frame -> 'ts') = 'number'
             then to_timestamp((p_frame ->> 'ts')::double precision) end;   -- epoch SECONDS (B1a)
  batch := 'bridge-in:' || b.entity_id || ':' || ext;
  log_id := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
  values (log_id, b.space_id, 'message', parent_msg, null, (author ->> 'actorId')::uuid, anchor_e.visibility);
  insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
  values (log_id, log_anchor, thread_root, (author ->> 'actorId')::uuid, body, batch);

  insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id,
    external_conversation_id, external_sender_id, external_reply_to_id, external_ts, command_state,
    sender_display, media)
  values (log_id, b.entity_id, conn.id, 'in', ext, conv, sender, reply_ext, ts,
          case when p_command then 'pending' end, sender_name,
          nullif(coalesce(p_frame -> 'media', '[]'::jsonb), '[]'::jsonb));

  -- A command is stored, never routed (§2.3 step 2).
  if p_command then
    return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                              'command', true, 'routed', false);
  end if;

  -- Step 5: trigger and whoMayTrigger.
  triggered := case b.policy ->> 'trigger'
    when 'every' then true
    when 'mention' then
         body ~* '(^|[^[:alnum:]_])@tm8([^[:alnum:]_]|$)'
      or exists (select 1 from jsonb_array_elements_text(coalesce(p_frame -> 'mentions', '[]'::jsonb)) j(id)
                  where j.id = any(conn.self_ids))
      or (reply_ext is not null and exists (
            select 1 from public.message_origins o
             where o.bridge_id = b.entity_id and o.external_message_id = reply_ext and o.direction = 'out'))
    else false end;
  allowed := b.policy ->> 'whoMayTrigger' = 'anyone' or author ->> 'kind' = 'member';

  if triggered and allowed and b.target_kind = 'chat' then
    select * into chat_row from public.chats where entity_id = b.target_id;
    select * into target_e from public.entities where id = b.target_id;
    if chat_row.entity_id is not null and target_e.deleted_at is null then
      copy_id := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      values (copy_id, b.space_id, 'message', null, null, (author ->> 'actorId')::uuid, target_e.visibility);
      insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
      values (copy_id, b.target_id, null, (author ->> 'actorId')::uuid, body, batch);
      select e.kind into actor_kind from public.entities e where e.id = (author ->> 'actorId')::uuid;
      insert into public.chat_turns(chat_id, root_message_id, user_message_id, requested_by_member_id,
        requested_by_actor_id, requested_by_session_id, requested_by_chat_id, requested_by_auth_kind,
        mode, pricing_provider, pricing_model, queued_at)
      values (chat_row.entity_id, null, copy_id,
              case when actor_kind = 'member' then (author ->> 'actorId')::uuid end,
              (author ->> 'actorId')::uuid, null, null, null,
              chat_row.chat_mode, chat_row.provider, chat_row.model, now());
      routed := true;
      wake := jsonb_build_object('chatId', chat_row.entity_id, 'identityId', chat_row.configured_by_identity_id);
      -- B1b-3: the chat answers it, and the turn carries the bridge origin (D30).
      perform internal.bridge_try('public.set_bridge_answerer', 'uuid,uuid', log_id::text, b.target_id::text);
      perform internal.bridge_try('public.add_bridge_origin', 'uuid,jsonb', b.target_id::text,
        jsonb_build_object('bridgeId', b.entity_id, 'messageId', log_id, 'providerMessageId', ext,
                           'sender', jsonb_build_object('participant', author -> 'participant',
                             'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
                           'command', null)::text);
    end if;
  end if;
  if routed then
    update public.message_origins set routed = true where message_id = log_id;
  end if;

  return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                            'command', false, 'routed', routed, 'copyId', copy_id, 'wakeChat', wake,
                            'author', author);
end
$$;
revoke all on function public.bridge_runtime_inbound(jsonb, boolean) from public;
grant execute on function public.bridge_runtime_inbound(jsonb, boolean) to tm8_app;

-- sent: settles an outbox row (authoritative; no echoes, D37). A send writes
-- the message's `out` origin with the provider id and the server-only payload,
-- which a later quote of it and B1b-4's confirm lookup read.
create or replace function public.bridge_runtime_sent(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare ob public.bridge_outbox; ok boolean := p_frame ? 'externalMessageId'; retryable boolean;
begin
  perform internal.bridge_runtime_session();
  select * into ob from public.bridge_outbox where id = (p_frame ->> 'outboxId')::uuid for update;
  if ob.id is null or ob.connection_id is distinct from (p_frame ->> 'connectionId')::uuid then
    raise exception 'outbox row not found for this connection' using errcode = 'P0002';
  end if;
  if ob.status in ('sent', 'failed_permanent') then
    return jsonb_build_object('outboxId', ob.id, 'status', ob.status, 'replayed', true);
  end if;
  if ok then
    update public.bridge_outbox
       set status = 'sent', external_message_id = p_frame ->> 'externalMessageId', settled_at = now(), last_error = null
     where id = ob.id;
    if ob.kind = 'send' then
      insert into public.message_origins(message_id, bridge_id, connection_id, direction, external_message_id,
        external_conversation_id, external_sender_id, external_reply_to_id, external_ts, provider_payload)
      values (ob.message_id, ob.bridge_id, ob.connection_id, 'out', p_frame ->> 'externalMessageId',
              ob.external_conversation_id, null, ob.external_reply_to, now(), p_frame -> 'message')
      on conflict do nothing;
    end if;
  else
    retryable := coalesce((p_frame #>> '{failed,retryable}')::boolean, false) and ob.attempts < 5;
    update public.bridge_outbox
       set status = case when retryable then 'failed_retryable' else 'failed_permanent' end,
           settled_at = case when retryable then null else now() end,
           next_attempt_at = case when retryable then now() + make_interval(secs => 5 * power(2, ob.attempts)) end,
           last_error = left(coalesce(p_frame #>> '{failed,reason}', 'failed'), 300)
     where id = ob.id;
  end if;
  -- The badge rides the message: touching it re-emits it to its readers.
  update public.entities set updated_at = clock_timestamp() where id = ob.message_id and deleted_at is null;
  select * into ob from public.bridge_outbox where id = ob.id;
  return jsonb_build_object('outboxId', ob.id, 'status', ob.status);
end
$$;
revoke all on function public.bridge_runtime_sent(jsonb) from public;
grant execute on function public.bridge_runtime_sent(jsonb) to tm8_app;

-- -----------------------------------------------------------------------------
-- §6. The outbox.
-- -----------------------------------------------------------------------------

-- Credential-shaped text never crosses (the Phase-1 relay refusal, §2.3).
create or replace function internal.bridge_text_looks_secret(p text) returns boolean
language sql immutable set search_path = public, internal, pg_temp as $$
  select p ~ '(tm8[a-z]?_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
$$;
revoke all on function internal.bridge_text_looks_secret(text) from public;

-- THE one writer of outbox rows: every hard check (§2.3, D23, D28) and every
-- bucket (§2.7, §6). Answers {status:'pending', outboxId} or
-- {status:'refused', reason, retryAfterMs?}; a refused SEND leaves a badge.
--   p_kind    'send' | 'react'
--   p_payload the frame body: {text, replyTo?} or {target, emoji}
--   p_opts    {poster, teammateId?, sessionId?, directed?, replyToExternalId?, reaction?}
create or replace function internal.bridge_outbox_enqueue(
  p_bridge uuid, p_message uuid, p_kind text, p_payload jsonb, p_opts jsonb
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges; conn public.bridge_connections;
  v_poster text := coalesce(p_opts ->> 'poster', 'member');
  v_teammate uuid := nullif(p_opts ->> 'teammateId', '')::uuid;
  v_directed boolean := coalesce((p_opts ->> 'directed')::boolean, false);
  reason text; retry_ms integer; oldest timestamptz; row_id uuid; existing public.bridge_outbox;
begin
  if p_kind not in ('send', 'react') then raise exception 'unknown outbox kind' using errcode = '22023'; end if;
  select * into existing from public.bridge_outbox
   where message_id = p_message and kind = p_kind
     and (p_kind = 'send' or reaction is not distinct from p_opts ->> 'reaction');
  if existing.id is not null then
    return jsonb_build_object('status', 'pending', 'outboxId', existing.id, 'replayed', true);
  end if;

  select * into b from public.bridges where entity_id = p_bridge;
  select * into conn from public.bridge_connections where id = b.connection_id;
  -- Every row on one number is decided one at a time, so the buckets hold.
  perform pg_advisory_xact_lock(hashtextextended('bridge-outbox:' || coalesce(conn.id, p_bridge)::text, 0));

  reason := case
    when b.entity_id is null or b.ended_at is not null then 'bridge_ended'
    when conn.id is null or conn.status = 'removed' then 'not_connected'
    when b.paused_at is not null or b.muted_until > now() then 'bridge_paused'
    when b.policy ->> 'direction' = 'in' then 'direction_in'
    when v_poster = 'worker' and not b.worker_posting then 'worker_posting_off'
    when not (b.external_conversation_id = any(internal.bridge_allowlist_ids(conn.id))) then 'not_connected'
    when p_kind = 'send' and internal.bridge_text_looks_secret(coalesce(p_payload ->> 'text', '')) then 'credential_text'
  end;

  -- Buckets, tightest first (§2.7, §6). Each answers how long until it has room.
  if reason is null then
    select min(created_at) into oldest from (
      select created_at from public.bridge_outbox where connection_id = conn.id and created_at > now() - interval '1 minute'
       order by created_at desc limit 60) w having count(*) >= 60;
    if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '1 minute' - now()) * 1000); end if;
  end if;
  if reason is null then
    select min(created_at) into oldest from (
      select created_at from public.bridge_outbox where bridge_id = p_bridge and created_at > now() - interval '1 minute'
       order by created_at desc limit 30) w having count(*) >= 30;
    if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '1 minute' - now()) * 1000); end if;
  end if;
  if reason is null and v_teammate is not null and v_poster in ('worker', 'chat') then
    select min(created_at) into oldest from (
      select created_at from public.bridge_outbox
       where teammate_id = v_teammate and bridge_id = p_bridge and poster in ('worker', 'chat')
         and created_at > now() - interval '1 minute'
       order by created_at desc limit 20) w having count(*) >= 20;
    if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '1 minute' - now()) * 1000); end if;
    if reason is null and not v_directed then
      select min(created_at) into oldest from (
        select created_at from public.bridge_outbox
         where teammate_id = v_teammate and bridge_id = p_bridge and poster in ('worker', 'chat') and not directed
           and created_at > now() - interval '10 minutes'
         order by created_at desc limit 6) w having count(*) >= 6;
      if oldest is not null then reason := 'rate_limited'; retry_ms := ceil(extract(epoch from oldest + interval '10 minutes' - now()) * 1000); end if;
    end if;
  end if;

  if reason is not null then
    if p_kind = 'send' then
      insert into public.bridge_delivery_refusals(message_id, bridge_id, reason, retry_after_ms)
      values (p_message, p_bridge, reason, greatest(retry_ms, 0))
      on conflict (message_id) do update set reason = excluded.reason, retry_after_ms = excluded.retry_after_ms,
        created_at = now();
    end if;
    return jsonb_strip_nulls(jsonb_build_object('status', 'refused', 'reason', reason,
                                                'retryAfterMs', greatest(retry_ms, 0)));
  end if;

  insert into public.bridge_outbox(bridge_id, message_id, external_reply_to, payload, kind, reaction, connection_id,
    external_conversation_id, poster, teammate_id, session_id, directed)
  values (p_bridge, p_message, p_opts ->> 'replyToExternalId', p_payload, p_kind, p_opts ->> 'reaction', conn.id,
          b.external_conversation_id, v_poster, v_teammate, nullif(p_opts ->> 'sessionId', '')::uuid, v_directed)
  returning id into row_id;
  delete from public.bridge_delivery_refusals where message_id = p_message and p_kind = 'send';
  return jsonb_build_object('status', 'pending', 'outboxId', row_id);
end
$$;
revoke all on function internal.bridge_outbox_enqueue(uuid, uuid, text, jsonb, jsonb) from public;

-- What the provider shows for a quoted message (protocol.ts QuoteRef).
create or replace function internal.bridge_quote_ref(p_message uuid) returns jsonb
language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
           'externalMessageId', o.external_message_id,
           'senderExternalId', o.external_sender_id,
           'fromMe', o.direction = 'out',
           'message', case when o.direction = 'out' then o.provider_payload end,
           'text', case when o.direction = 'in' then left(m.body, 1000) end))
    from public.message_origins o join public.messages m on m.entity_id = o.message_id
   where o.message_id = (internal.bridge_origin_of(p_message)).message_id
$$;
revoke all on function internal.bridge_quote_ref(uuid) from public;

-- The signature (§2.3 Voice) on a provider with one sender identity.
create or replace function internal.bridge_signed(b public.bridges, p_author uuid, p_session uuid, p_poster text, p_text text)
returns text language plpgsql stable set search_path = public, internal, pg_temp as $$
declare who text; handle jsonb; title text;
begin
  if b.policy ->> 'voice' = 'plain' then return p_text; end if;
  if p_poster = 'notice' then return 'tm8: ' || p_text; end if;
  if p_poster = 'chat' then
    select tm.name into who from public.team_members tm where tm.entity_id = coalesce(b.teammate_id, p_author);
    return coalesce(nullif(btrim(who), ''), 'tm8') || ': ' || p_text;
  end if;
  if p_poster = 'worker' and p_session is not null then
    handle := internal.bridge_try('public.bridge_poster_handle', 'uuid,uuid', b.entity_id::text, p_session::text);
    select ws.title into title from public.work_sessions ws where ws.entity_id = p_session;
    title := coalesce(handle ->> 'title', title, 'tm8');
    return case when handle ->> 'handle' is not null then title || ' (' || (handle ->> 'handle') || '): ' else title || ': ' end
           || p_text;
  end if;
  select coalesce(m.display_name, 'tm8') into who from public.members m where m.entity_id = p_author;
  return coalesce(who, 'tm8') || ': ' || p_text;
end
$$;
revoke all on function internal.bridge_signed(public.bridges, uuid, uuid, text, text) from public;

-- THE OUTBOUND RULE (§2.3), at commit (a deferred constraint trigger: B1b-3's
-- not_answerer check and the authored_from edges are in place by then). A
-- message crosses when it replies to a bridged message, or is posted on a
-- bridge's log anchor, or is on the target of an `outbound: all` bridge.
-- Inbound copies, the bridge's own notices and a chat's turn output (crossed
-- by the chat_turns rule below) are skipped. One row per message batch.
create or replace function internal.bridge_outbound_after_message() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  m public.messages; self public.entities; author public.entities; b public.bridges; o public.message_origins;
  parent uuid; source uuid; source_kind text; poster text; teammate uuid; session uuid; directed boolean := false;
  text_out text;
begin
  select * into m from public.messages where entity_id = new.entity_id;
  select * into self from public.entities where id = new.entity_id;
  if m.entity_id is null or self.deleted_at is not null then return null; end if;
  if exists (select 1 from public.message_origins where message_id = m.entity_id) then return null; end if;
  if exists (select 1 from public.bridge_outbox where message_id = m.entity_id and kind = 'send')
     or exists (select 1 from public.bridge_delivery_refusals where message_id = m.entity_id) then return null; end if;
  select * into author from public.entities where id = m.author_id;
  if author.kind = 'bridge' then return null; end if;
  if m.message_batch_id is not null and exists (
       select 1 from public.messages twin
        where twin.message_batch_id = m.message_batch_id and twin.entity_id <> m.entity_id
          and (exists (select 1 from public.bridge_outbox ob where ob.message_id = twin.entity_id and ob.kind = 'send')
               or exists (select 1 from public.bridge_delivery_refusals r where r.message_id = twin.entity_id)
               or exists (select 1 from public.message_origins oo where oo.message_id = twin.entity_id))) then
    return null;
  end if;

  select e.dst_id, de.kind into source, source_kind
    from public.edges e join public.entities de on de.id = e.dst_id
   where e.src_id = m.entity_id and e.type = 'authored_from' and de.kind in ('work_session', 'chat')
   limit 1;

  parent := self.parent_id;
  if parent is not null then
    o := internal.bridge_origin_of(parent);
    if o.message_id is not null then select * into b from public.bridges where entity_id = o.bridge_id; end if;
  end if;
  if b.entity_id is null then
    select br.* into b from public.bridges br
     where br.ended_at is null
       and ((br.target_kind <> 'channel' and br.entity_id = m.anchor_id)
            or (br.target_kind = 'channel' and br.target_id = m.anchor_id))
     limit 1;
  end if;
  if b.entity_id is null then
    -- outbound: all, on the target; a chat's own turn output crosses by the turn rule.
    select br.* into b from public.bridges br
     where br.ended_at is null and br.target_id = m.anchor_id and br.policy ->> 'outbound' = 'all'
       and source is distinct from br.target_id
     limit 1;
  end if;
  if b.entity_id is null then return null; end if;

  if author.kind = 'member' then
    poster := 'member';
  elsif source_kind = 'chat' then
    poster := 'chat'; teammate := author.id;
  else
    poster := 'worker'; teammate := author.id; session := case when source_kind = 'work_session' then source end;
  end if;
  if poster <> 'member' then
    directed := coalesce((internal.bridge_try('public.bridge_post_is_directed', 'uuid', m.entity_id::text))::text::boolean, false);
  end if;
  text_out := internal.bridge_signed(b, m.author_id, session, poster, m.body);
  perform internal.bridge_outbox_enqueue(b.entity_id, m.entity_id, 'send',
    jsonb_strip_nulls(jsonb_build_object('text', text_out,
      'replyTo', case when o.message_id is not null and o.bridge_id = b.entity_id then internal.bridge_quote_ref(parent) end)),
    jsonb_strip_nulls(jsonb_build_object('poster', poster, 'teammateId', teammate, 'sessionId', session,
      'directed', directed,
      'replyToExternalId', case when o.bridge_id = b.entity_id then o.external_message_id end)));
  return null;
end
$$;
revoke all on function internal.bridge_outbound_after_message() from public;
create constraint trigger messages_bridge_outbound after insert on public.messages
  deferrable initially deferred for each row execute function internal.bridge_outbound_after_message();

-- A chat target's turn answer to a routed message crosses (§2.3: the Phase-1
-- relay, now the rule), at commit so the answer's final text is in place.
create or replace function internal.bridge_outbound_after_turn() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare t public.chat_turns; o public.message_origins; b public.bridges; answer public.messages; c public.chats;
begin
  select * into t from public.chat_turns where turn_id = new.turn_id;
  if t.state is distinct from 'completed' or t.agent_message_id is null then return null; end if;
  o := internal.bridge_origin_of(t.user_message_id);
  if o.message_id is null or o.direction <> 'in' then return null; end if;
  select * into b from public.bridges where entity_id = o.bridge_id;
  select * into c from public.chats where entity_id = t.chat_id;
  if b.target_id is distinct from t.chat_id then return null; end if;
  select * into answer from public.messages where entity_id = t.agent_message_id;
  if answer.entity_id is null or btrim(answer.body) = '' then return null; end if;
  perform internal.bridge_outbox_enqueue(b.entity_id, answer.entity_id, 'send',
    jsonb_build_object('text', internal.bridge_signed(b, c.teammate_id, null, 'chat', answer.body),
                       'replyTo', internal.bridge_quote_ref(o.message_id)),
    jsonb_build_object('poster', 'chat', 'teammateId', c.teammate_id, 'directed', true,
                       'replyToExternalId', o.external_message_id));
  return null;
end
$$;
revoke all on function internal.bridge_outbound_after_turn() from public;
create constraint trigger chat_turns_bridge_outbound after update of state on public.chat_turns
  deferrable initially deferred for each row
  when (new.state = 'completed' and old.state is distinct from 'completed')
  execute function internal.bridge_outbound_after_turn();

-- A bridge notice (B1b-4's command answers, the watchdog): authored by the
-- bridge, signed `tm8: …`, on the log anchor, idempotent on the key.
create or replace function internal.bridge_post_notice(p_bridge uuid, p_text text, p_reply_to uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; n public.bridge_notices; anchor uuid; anchor_e public.entities; parent_row public.messages;
        msg uuid; delivery jsonb; body text := left(btrim(coalesce(p_text, '')), 9990);
begin
  perform internal.require_bridges_worker();
  if body = '' then raise exception 'a notice needs text' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bridge-notice:' || p_key, 0));
  select * into n from public.bridge_notices where idempotency_key = p_key;
  if n.message_id is not null then
    select coalesce(
      (select jsonb_build_object('status', 'pending', 'outboxId', ob.id) from public.bridge_outbox ob
        where ob.message_id = n.message_id and ob.kind = 'send'),
      (select jsonb_strip_nulls(jsonb_build_object('status', 'refused', 'reason', r.reason, 'retryAfterMs', r.retry_after_ms))
         from public.bridge_delivery_refusals r where r.message_id = n.message_id)) into delivery;
    return jsonb_build_object('messageId', n.message_id, 'delivery', delivery, 'replayed', true);
  end if;
  select * into b from public.bridges where entity_id = p_bridge;
  if b.entity_id is null then raise exception 'bridge not found' using errcode = 'P0002'; end if;
  anchor := internal.bridge_log_anchor(b);
  select * into anchor_e from public.entities where id = anchor;
  if p_reply_to is not null then
    select * into parent_row from public.messages where entity_id = p_reply_to and anchor_id = anchor;
  end if;
  msg := internal.new_id();
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
  values (msg, b.space_id, 'message', parent_row.entity_id, null, b.entity_id, anchor_e.visibility);
  insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
  values (msg, anchor, case when parent_row.entity_id is not null then coalesce(parent_row.root_message_id, parent_row.entity_id) end,
          b.entity_id, body, 'bridge-notice:' || p_key);
  insert into public.bridge_notices(idempotency_key, bridge_id, message_id) values (p_key, b.entity_id, msg);
  delivery := internal.bridge_outbox_enqueue(b.entity_id, msg, 'send',
    jsonb_strip_nulls(jsonb_build_object('text', internal.bridge_signed(b, b.entity_id, null, 'notice', body),
      'replyTo', case when parent_row.entity_id is not null then internal.bridge_quote_ref(parent_row.entity_id) end)),
    jsonb_strip_nulls(jsonb_build_object('poster', 'notice',
      'replyToExternalId', case when parent_row.entity_id is not null then (internal.bridge_origin_of(parent_row.entity_id)).external_message_id end)));
  return jsonb_build_object('messageId', msg, 'delivery', delivery);
end
$$;
revoke all on function internal.bridge_post_notice(uuid, text, uuid, text) from public;
grant execute on function internal.bridge_post_notice(uuid, text, uuid, text) to tm8_app;

-- A reaction on a bridged message (in or out), through the outbox.
create or replace function internal.bridge_react_message(p_bridge uuid, p_message uuid, p_emoji text, p_key text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare o public.message_origins;
begin
  perform internal.require_bridges_worker();
  if p_emoji is null or char_length(p_emoji) not between 1 and 16 then
    raise exception 'one emoji' using errcode = '22023';
  end if;
  o := internal.bridge_origin_of(p_message);
  if o.message_id is null or o.bridge_id <> p_bridge then
    raise exception 'that message did not cross this bridge' using errcode = '22023';
  end if;
  return internal.bridge_outbox_enqueue(p_bridge, o.message_id, 'react',
    jsonb_build_object('target', internal.bridge_quote_ref(o.message_id), 'emoji', p_emoji),
    jsonb_build_object('poster', 'system', 'reaction', coalesce(p_key, p_emoji)));
end
$$;
revoke all on function internal.bridge_react_message(uuid, uuid, text, text) from public;
grant execute on function internal.bridge_react_message(uuid, uuid, text, text) to tm8_app;

-- /mute and /unmute (v2 §4.4): a space admin's act. Stays on the allowlist.
create or replace function public.bridge_set_mute(p_bridge uuid, p_until timestamptz) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges;
begin
  b := internal.bridge_for_admin(p_bridge);
  if p_until is not null and (p_until <= now() or p_until > now() + interval '30 days') then
    raise exception 'mute for up to 30 days' using errcode = '22023';
  end if;
  update public.bridges set muted_until = p_until where entity_id = b.entity_id;
  return jsonb_build_object('bridgeId', b.entity_id, 'mutedUntil', p_until);
end
$$;
revoke all on function public.bridge_set_mute(uuid, timestamptz) from public;
grant execute on function public.bridge_set_mute(uuid, timestamptz) to tm8_app;

-- Dispatch (the hub): take due rows for these runtimes, re-check the hard
-- facts that can change after enqueue, and answer the frames to send.
create or replace function internal.bridge_outbox_take(p_runtime_ids text[], p_limit integer) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r record; frames jsonb := '[]'::jsonb; reason text;
begin
  perform internal.require_bridges_worker();
  for r in
    select ob.*, c.runtime_id, c.status as conn_status, b.paused_at, b.ended_at, b.muted_until,
           b.policy ->> 'direction' as direction, b.external_conversation_id as conv
      from public.bridge_outbox ob
      join public.bridge_connections c on c.id = ob.connection_id
      join public.bridges b on b.entity_id = ob.bridge_id
     where (ob.status = 'pending' or (ob.status = 'failed_retryable' and coalesce(ob.next_attempt_at, now()) <= now()))
       and c.runtime_id = any(p_runtime_ids) and c.status = 'linked'
     order by ob.created_at
     limit greatest(least(p_limit, 100), 1)
     for update of ob skip locked
  loop
    reason := case
      when r.ended_at is not null then 'bridge_ended'
      when r.paused_at is not null or r.muted_until > now() then 'bridge_paused'
      when r.direction = 'in' then 'direction_in'
      when not (r.conv = any(internal.bridge_allowlist_ids(r.connection_id))) then 'not_connected' end;
    if reason is not null then
      update public.bridge_outbox set status = 'failed_permanent', settled_at = now(), last_error = reason where id = r.id;
      update public.entities set updated_at = clock_timestamp() where id = r.message_id and deleted_at is null;
      continue;
    end if;
    update public.bridge_outbox set status = 'dispatching', attempts = attempts + 1, dispatched_at = now() where id = r.id;
    frames := frames || jsonb_build_array(jsonb_build_object('runtimeId', r.runtime_id, 'frame',
      case r.kind
        when 'send' then jsonb_strip_nulls(jsonb_build_object('type', 'send', 'outboxId', r.id,
          'connectionId', r.connection_id, 'conversationId', r.conv, 'text', r.payload ->> 'text',
          'replyTo', r.payload -> 'replyTo'))
        else jsonb_build_object('type', 'react', 'outboxId', r.id, 'connectionId', r.connection_id,
          'conversationId', r.conv, 'target', r.payload -> 'target', 'emoji', r.payload ->> 'emoji') end));
  end loop;
  return frames;
end
$$;
revoke all on function internal.bridge_outbox_take(text[], integer) from public;
grant execute on function internal.bridge_outbox_take(text[], integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- §7. Commands (§2.3 step 2): the state machine B1b-4 claims and settles.
-- -----------------------------------------------------------------------------

-- pending -> running (or re-claims a running row older than 2 minutes). False
-- when settled, claimed fresh elsewhere, or out of attempts (then `failed`).
create or replace function internal.bridge_command_claim(p_message_id uuid) returns boolean
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare o public.message_origins;
begin
  perform internal.require_bridges_worker();
  select * into o from public.message_origins where message_id = p_message_id for update;
  if o.message_id is null or o.command_state is null then return false; end if;
  if o.command_state in ('done', 'failed') then return false; end if;
  if o.command_state = 'running' and o.command_claimed_at > now() - interval '2 minutes' then return false; end if;
  if o.command_attempts >= 5 then
    update public.message_origins set command_state = 'failed', command_settled_at = now() where message_id = p_message_id;
    return false;
  end if;
  update public.message_origins
     set command_state = 'running', command_claimed_at = now(), command_attempts = command_attempts + 1
   where message_id = p_message_id;
  return true;
end
$$;
revoke all on function internal.bridge_command_claim(uuid) from public;
grant execute on function internal.bridge_command_claim(uuid) to tm8_app;

create or replace function internal.bridge_command_settle(p_message_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  if p_outcome not in ('done', 'failed', 'pending') then
    raise exception 'a command settles done or failed (or pending to retry)' using errcode = '22023';
  end if;
  update public.message_origins
     set command_state = p_outcome,
         command_settled_at = case when p_outcome = 'pending' then null else now() end
   where message_id = p_message_id and command_state is not null;
end
$$;
revoke all on function internal.bridge_command_settle(uuid, text) from public;
grant execute on function internal.bridge_command_settle(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §8. The watchdog (D19) and the delivery badge.
-- -----------------------------------------------------------------------------

-- One tick: a runtime silent for three heartbeats (90 s) marks its connections
-- offline (so every bridge on them derives `degraded`) and raises ONE fyi per
-- connection to its owner; a heartbeat again clears it. A routed message whose
-- turn failed or stalled gets ⚠️ on the provider through the outbox and one
-- fyi on its bridge. Stuck dispatches return to retry.
create or replace function internal.bridge_watchdog_tick() returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare c record; r record; first_bridge public.bridges; owner_member uuid; downs integer := 0; ups integer := 0;
        warned integer := 0; requeued integer := 0; result jsonb;
begin
  perform internal.require_bridges_worker();

  update public.bridge_outbox set status = 'failed_retryable', next_attempt_at = now()
   where status = 'dispatching' and dispatched_at < now() - interval '2 minutes';
  get diagnostics requeued = row_count;

  for c in select * from public.bridge_connections
            where status in ('linked', 'connecting', 'offline') and runtime_id is not null and down_since is null
              and coalesce(heartbeat_at, last_seen_at, created_at) < now() - interval '90 seconds'
            for update skip locked loop
    update public.bridge_connections set status = 'offline', down_since = now() where id = c.id;
    select b.* into first_bridge from public.bridges b
     where b.connection_id = c.id and b.ended_at is null order by b.created_at limit 1;
    if first_bridge.entity_id is not null then
      select m.entity_id into owner_member from public.members m join public.accounts a on a.identity_id = m.identity_id
       where a.id = c.owner_account_id and m.space_id = first_bridge.space_id and m.status = 'active' limit 1;
      perform internal.raise_attention_signal(first_bridge.space_id, first_bridge.entity_id,
        'bridge.runtime_down:' || c.id,
        'The ' || c.label || ' connection''s runtime stopped answering; its bridges are degraded until it is back.',
        'fyi', 'review', coalesce(owner_member, first_bridge.entity_id));
    end if;
    downs := downs + 1;
  end loop;

  for c in select * from public.bridge_connections
            where down_since is not null and heartbeat_at > down_since for update skip locked loop
    update public.bridge_connections set down_since = null where id = c.id;
    for first_bridge in select * from public.bridges b where b.connection_id = c.id loop
      perform internal.clear_attention_signal(first_bridge.space_id, 'bridge.runtime_down:' || c.id, null,
                                              'the runtime is back');
    end loop;
    ups := ups + 1;
  end loop;

  for r in select o.message_id, o.bridge_id, b.space_id, b.connection_id
             from public.message_origins o
             join public.bridges b on b.entity_id = o.bridge_id and b.ended_at is null
             join public.messages copy on copy.message_batch_id = 'bridge-in:' || o.bridge_id || ':' || o.external_message_id
                                     and copy.entity_id <> o.message_id
             join public.chat_turns t on t.user_message_id = copy.entity_id
            where o.direction = 'in' and o.routed and o.created_at > now() - interval '24 hours'
              and (t.state = 'error' or (t.state in ('queued', 'running') and t.queued_at < now() - interval '10 minutes'))
              and not exists (select 1 from public.bridge_outbox ob
                               where ob.message_id = o.message_id and ob.kind = 'react' and ob.reaction = 'watchdog')
  loop
    perform internal.bridge_outbox_enqueue(r.bridge_id, r.message_id, 'react',
      jsonb_build_object('target', internal.bridge_quote_ref(r.message_id), 'emoji', '⚠️'),
      jsonb_build_object('poster', 'system', 'reaction', 'watchdog'));
    perform internal.raise_attention_signal(r.space_id, r.bridge_id, 'bridge.turn_failed:' || r.bridge_id,
      'A message from this bridge got no answer: its turn failed or stalled. It was marked ⚠️ in the group.',
      'fyi', 'review', r.bridge_id);
    warned := warned + 1;
  end loop;

  result := jsonb_build_object('runtimeDown', downs, 'runtimeBack', ups, 'warned', warned, 'requeued', requeued);
  return result;
end
$$;
revoke all on function internal.bridge_watchdog_tick() from public;
grant execute on function internal.bridge_watchdog_tick() to tm8_app;

-- The `bridge.delivery` badge of each readable message that crossed or was
-- refused: {messageId, status, reason?, retryAfterMs?, externalMessageId?, at}.
create or replace function internal.bridge_message_delivery(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select coalesce(jsonb_agg(d order by d ->> 'messageId'), '[]'::jsonb) from (
    select jsonb_strip_nulls(jsonb_build_object(
             'messageId', ob.message_id, 'bridgeId', ob.bridge_id,
             'status', case ob.status when 'dispatching' then 'pending' else ob.status end,
             'externalMessageId', ob.external_message_id,
             'detail', case when ob.status like 'failed%' then ob.last_error end,
             'at', coalesce(ob.settled_at, ob.created_at))) as d
      from public.bridge_outbox ob
     where ob.message_id = any(p_ids) and ob.kind = 'send' and internal.entity_readable(ob.message_id)
    union all
    select jsonb_strip_nulls(jsonb_build_object(
             'messageId', r.message_id, 'bridgeId', r.bridge_id, 'status', 'refused', 'reason', r.reason,
             'retryAfterMs', r.retry_after_ms, 'at', r.created_at))
      from public.bridge_delivery_refusals r
     where r.message_id = any(p_ids) and internal.entity_readable(r.message_id)
  ) x
$$;
revoke all on function internal.bridge_message_delivery(uuid[]) from public;
grant execute on function internal.bridge_message_delivery(uuid[]) to tm8_app;

reset role;

analyze public.bridge_delivery_refusals, public.bridge_notices;
