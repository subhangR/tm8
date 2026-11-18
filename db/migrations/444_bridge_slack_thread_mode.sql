-- =============================================================================
-- 444 — Slack thread mode: one session per Slack thread (design doc
-- 01a1ed5f-40af §1.2-1.3, §2.1; task 01a1eddf-2e4e, lane F of the Slack build).
--
-- Builds on 395, 399, 406, 425 and on 443 (lane A: Slack as a provider,
-- bridge_outbox.thread_ts, the bot's user id in bridge_connections.self_ids).
-- Every object an earlier file defines is restated from its latest body and
-- changed only where a `444` comment says: internal.validate_bridge_policy
-- (395), public.bridge_message_audience (399), public.bridge_runtime_inbound
-- (425). 443 restates none of them.
--
-- WHAT THIS FILE DOES
--   §1  policy.threadMode ('off' | 'mention' | 'every'), Slack only. A new
--       Slack bridge gets 'mention'; the existing policy patch changes it.
--   §2  public.bridge_threads: one row per Slack thread that started a
--       session. The root message's ts is the thread's anchor (unique per
--       bridge, so a root that arrives twice starts one session).
--   §3  399's audience: a session holding the '/thread' origin of a root hears
--       every message in that thread, as '/work' workers hear theirs.
--   §4  425's inbound: a top-level Slack message that mentions the bot
--       ('mention') or any top-level message ('every') is stored unrouted with
--       its thread row and asks for a session (targetSession.live = false), so
--       the server's keeper starts it before delivery. A reply in such a
--       thread goes to that session alone, and resumes it when it has stopped.
--   §5  The keeper's and the watchdog's doors (bridges worker only):
--       bridge_thread_context, bridge_thread_bind, bridge_threads_due,
--       bridge_thread_idle_stopped.
--   §6  bridge_outbox.thread_ts on insert: a Slack reply goes into the thread
--       of the message it answers, and a thread session's own posts go into
--       its thread. A slash command ('cmd:<trigger_id>') is never a thread.
--
-- WHERE THE SESSION LIVES. A thread session is a child of the bridge's target
-- when the target is a work session. A bridge that targets a chat or a channel
-- has no session to hang it under, so its thread sessions are top-level
-- sessions run as the bridge's teammate (else the chat's), each bridged to its
-- own Slack thread only; the chat or channel keeps the channel's top level.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- 443 adds this column; restated defensively so this file also stands alone.
alter table public.bridge_outbox add column if not exists thread_ts text;

-- -----------------------------------------------------------------------------
-- §1. policy.threadMode. 395's validator, restated: the one optional field.
-- -----------------------------------------------------------------------------
create or replace function internal.validate_bridge_policy(p jsonb) returns void
language plpgsql immutable set search_path = public, internal, pg_temp as $$
declare k text;
begin
  if jsonb_typeof(p) is distinct from 'object'
     or not (p ?& array['trigger', 'direction', 'outbound', 'whoMayTrigger', 'voice', 'style']) then
    raise exception 'incomplete bridge policy' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    -- 444: threadMode is the one optional field.
    if not k = any(array['trigger', 'direction', 'outbound', 'whoMayTrigger', 'voice', 'style', 'threadMode']) then
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
  -- 444
  if p ? 'threadMode' and (jsonb_typeof(p -> 'threadMode') <> 'string' or p ->> 'threadMode' not in ('off', 'mention', 'every')) then
    raise exception 'policy.threadMode must be off, mention or every' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.validate_bridge_policy(jsonb) from public;

-- A Slack bridge always has a thread mode ('mention' unless asked otherwise);
-- no other provider has native threads, so none may set one.
create or replace function internal.bridge_thread_mode_row() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.provider = 'slack' then
    if not (new.policy ? 'threadMode') then
      new.policy := new.policy || '{"threadMode":"mention"}'::jsonb;
    end if;
  elsif new.policy ? 'threadMode' then
    raise exception 'policy.threadMode is for Slack bridges only' using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_thread_mode_row() from public;
-- Fires after bridges_guard (names sort), which has already validated the rest.
create trigger bridges_thread_mode before insert or update of policy, provider on public.bridges
for each row execute function internal.bridge_thread_mode_row();

-- -----------------------------------------------------------------------------
-- §2. The threads that started a session.
-- -----------------------------------------------------------------------------
create table public.bridge_threads (
  bridge_id        uuid not null references public.bridges(entity_id) on delete cascade,
  -- The root message's provider id (Slack ts): the thread's anchor.
  root_external_id text not null check (char_length(root_external_id) between 1 and 256),
  root_message_id  uuid not null references public.messages(entity_id) on delete cascade,
  -- Null until the keeper has started it (or when the session was deleted).
  session_id       uuid references public.entities(id) on delete set null,
  created_at       timestamptz not null default now(),
  -- The last message in the thread, either way; idle is measured from it.
  last_activity_at timestamptz not null default now(),
  -- Set when the idle sweep stopped the session; cleared when it is bound
  -- again, or when the session runs again by any other way (a manual resume).
  idle_stopped_at  timestamptz,
  -- When the sweep last handed this thread out to be stopped: a stop that is
  -- skipped or fails is not handed out again for 15 minutes, so a thread that
  -- cannot be stopped never holds a place in every sweep.
  stop_attempted_at timestamptz,
  start_attempts   integer not null default 0 check (start_attempts >= 0),
  primary key (bridge_id, root_external_id),
  unique (root_message_id)
);
-- The sweep's three scans, each on its own partial index: stop candidates
-- (session set, oldest activity first), sessions to un-mark after a manual
-- resume, and starts the server missed (no session yet).
create index bridge_threads_stop_idx on public.bridge_threads(last_activity_at)
  where session_id is not null and idle_stopped_at is null;
create index bridge_threads_stopped_idx on public.bridge_threads(session_id) where idle_stopped_at is not null;
create index bridge_threads_unstarted_idx on public.bridge_threads(created_at) where session_id is null;
alter table public.bridge_threads enable row level security;
-- No policy and no grant: written and read only by the definers below.

-- -----------------------------------------------------------------------------
-- §3. 399's public.bridge_message_audience, restated: the thread line.
-- -----------------------------------------------------------------------------
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
     where o.bridge_id = p_bridge_id and o.message_id = root and not o.inherited
       -- 444: a Slack thread's session hears its thread, except a guest's
       -- message on a bridge where only linked members may trigger (a guest is
       -- authored as the bridge itself).
       and (o.command = '/work'
            or (o.command = '/thread'
                and ((select br.policy ->> 'whoMayTrigger' from public.bridges br where br.entity_id = p_bridge_id) = 'anyone'
                     or m.author_id is distinct from p_bridge_id)))
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

-- -----------------------------------------------------------------------------
-- §4. 425's public.bridge_runtime_inbound, restated: thread mode.
-- -----------------------------------------------------------------------------
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
  -- 444: a native thread reply names its root; Slack also fills replyTo with
  -- it, and the root is what the reply threads under either way.
  thread_root_ext text := nullif(p_frame #>> '{thread,rootExternalMessageId}', '');
  reply_ext text := coalesce(nullif(p_frame #>> '{replyTo,externalMessageId}', ''), thread_root_ext);
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
  -- 406 (L)
  loop_sid uuid;
  sess_e public.entities;
  -- 444 (thread mode)
  th public.bridge_threads;
  thread_mode text;
  starts boolean := false;
begin
  perform internal.bridge_runtime_session();
  if ext is null or conv is null or char_length(ext) > 256 then
    raise exception 'inbound needs a conversationId and an externalMessageId' using errcode = '22023';
  end if;
  select * into conn from public.bridge_connections where id = (p_frame ->> 'connectionId')::uuid;
  if conn.id is null or conn.status = 'removed' then
    return jsonb_build_object('status', 'refused', 'reason', 'unknown_connection');
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

  -- §3 (B1b-8): a reaction and a poll vote are not messages; they are stored
  -- beside the message they are about (D39), after the allowlist check.
  if jsonb_typeof(p_frame -> 'reaction') = 'object' then
    return internal.bridge_store_reaction(b, conn.id, p_frame);
  end if;
  if jsonb_typeof(p_frame -> 'pollVote') = 'object' then
    return internal.bridge_store_poll_vote(b, conn.id, p_frame);
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
          -- F2: descriptive fields only; the fetch handle (media keys, D39) lives in bridge_media.
          nullif((select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'kind', m ->> 'kind', 'mime', m ->> 'mime', 'fileName', m ->> 'fileName',
                    'caption', m ->> 'caption', 'size', m -> 'size'))), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_frame -> 'media', '[]'::jsonb)) m), '[]'::jsonb));
  -- §4 (B1b-8): each media item becomes a file attached to this log message,
  -- fetched from the runtime after commit (§2.3 step 3).
  insert into public.bridge_media(message_id, idx, bridge_id, handle, kind, mime, file_name)
  select log_id, (m.ord - 1)::int, b.entity_id, m.item ->> 'handle', coalesce(m.item ->> 'kind', 'document'),
         m.item ->> 'mime', m.item ->> 'fileName'
    from jsonb_array_elements(coalesce(p_frame -> 'media', '[]'::jsonb)) with ordinality m(item, ord)
   where m.item ->> 'handle' is not null and m.item ->> 'handle' <> '';

  -- A command is stored, never routed (§2.3 step 2).
  if p_command then
    return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                              'command', true, 'routed', false);
  end if;

  -- 425 (R1): `direction: out` means nothing from the group reaches tm8's
  -- agents. The message is still the group's record on the log; it is never
  -- routed, starts no turn and wakes no session (the deliveries skip it too).
  if b.policy ->> 'direction' = 'out' then
    return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                              'command', false, 'routed', false, 'author', author);
  end if;

  -- 444: thread mode (Slack). A reply in a thread that started a session goes
  -- to that session alone: it is logged under the root, never routed to the
  -- bridge's target, and reaches the session through 399's directed audience
  -- ('/thread' origin on the root). A session that is not running is resumed
  -- first through 425's door (targetSession.live = false, the keeper). A
  -- top-level message that mentions the bot ('mention') or any top-level
  -- message ('every') starts a session of its own: stored unrouted, with its
  -- thread row, and the keeper starts the session before delivery.
  allowed := b.policy ->> 'whoMayTrigger' = 'anyone' or author ->> 'kind' = 'member';
  if thread_root_ext is not null then
    select * into th from public.bridge_threads
     where bridge_id = b.entity_id and root_external_id = thread_root_ext for update;
    if th.bridge_id is not null then
      update public.bridge_threads set last_activity_at = now()
       where bridge_id = th.bridge_id and root_external_id = th.root_external_id;
      return jsonb_strip_nulls(jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
        'command', false, 'routed', false, 'author', author,
        'thread', jsonb_build_object('rootExternalId', th.root_external_id, 'sessionId', th.session_id),
        'targetSession', case when allowed and (th.session_id is null or not internal.bridge_session_live(th.session_id))
                              then jsonb_build_object('sessionId', coalesce(th.session_id, b.target_id), 'live', false) end));
    end if;
  -- A start is a trigger like any other: never on a log-only bridge
  -- (trigger 'none') or one tm8 may not post to (direction 'in'; 'out'
  -- returned above), and whoMayTrigger applies (`allowed`).
  elsif b.provider = 'slack' and reply_ext is null and ext not like 'cmd:%'
        and jsonb_typeof(p_frame -> 'slashCommand') is distinct from 'object'
        and b.policy ->> 'trigger' <> 'none' and b.policy ->> 'direction' = 'both' then
    thread_mode := coalesce(b.policy ->> 'threadMode', 'off');
    starts := case thread_mode
      when 'every' then true
      when 'mention' then
           body ~* '(^|[^[:alnum:]_])@tm8([^[:alnum:]_]|$)'
        or exists (select 1 from jsonb_array_elements_text(coalesce(p_frame -> 'mentions', '[]'::jsonb)) j(id)
                    where j.id = any(conn.self_ids))
      else false end;
    if starts and allowed then
      insert into public.bridge_threads(bridge_id, root_external_id, root_message_id)
      values (b.entity_id, ext, log_id)
      on conflict (bridge_id, root_external_id) do nothing;
      return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
        'command', false, 'routed', false, 'author', author,
        'thread', jsonb_build_object('rootExternalId', ext, 'started', true),
        'targetSession', jsonb_build_object('sessionId', b.target_id, 'live', false));
    end if;
  end if;

  -- 406 (L, D26, D69): a reply to a post by a live interactive loop session goes
  -- to that session, which becomes its answerer and gains the group as an
  -- origin (D30). Once the session has closed, the chat answers as before.
  if parent_msg is not null
     and (b.policy ->> 'whoMayTrigger' = 'anyone' or author ->> 'kind' = 'member') then
    loop_sid := internal.loop_reply_session(parent_msg);
    if loop_sid is not null then
      select * into sess_e from public.entities where id = loop_sid;
      copy_id := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      values (copy_id, b.space_id, 'message', null, null, (author ->> 'actorId')::uuid, sess_e.visibility);
      insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
      values (copy_id, loop_sid, null, (author ->> 'actorId')::uuid, body, batch);
      perform public.set_bridge_answerer(log_id, loop_sid);
      perform public.add_bridge_origin(loop_sid,
        jsonb_build_object('bridgeId', b.entity_id, 'messageId', log_id, 'providerMessageId', ext,
                           'sender', jsonb_build_object('participant', author -> 'participant',
                             'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
                           'command', null));
      update public.message_origins set routed = true where message_id = log_id;
      return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                                'command', false, 'routed', true, 'copyId', copy_id, 'wakeChat', null,
                                'wakeSession', jsonb_build_object('sessionId', loop_sid), 'author', author);
    end if;
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
                           'sender', jsonb_build_object('participant', author #>> '{participant,displayName}',
                             'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
                           'command', null)::text);
    end if;
  elsif triggered and allowed and b.target_kind = 'work_session' then
    -- §5 (B1b-8): a session target gets the routed copy anchored on it; the
    -- worker delivers it after commit (§2.2: the stored-first PTY delivery).
    select * into target_e from public.entities where id = b.target_id;
    if target_e.deleted_at is null then
      copy_id := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      values (copy_id, b.space_id, 'message', null, null, (author ->> 'actorId')::uuid, target_e.visibility);
      insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
      values (copy_id, b.target_id, null, (author ->> 'actorId')::uuid, body, batch);
      routed := true;
    end if;
  end if;
  if routed then
    update public.message_origins set routed = true where message_id = log_id;
  end if;

  -- 425 (R11): a routed copy to a session that is not running asks the server
  -- to resume it (else replace it) before the copy is delivered.
  return jsonb_strip_nulls(jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                            'command', false, 'routed', routed, 'copyId', copy_id, 'wakeChat', wake,
                            'author', author,
                            'targetSession', case when routed and b.target_kind = 'work_session' then
                              jsonb_build_object('sessionId', b.target_id, 'live', internal.bridge_session_live(b.target_id)) end))
         || jsonb_build_object('wakeChat', wake, 'copyId', copy_id);
end
$$;
revoke all on function public.bridge_runtime_inbound(jsonb, boolean) from public;
grant execute on function public.bridge_runtime_inbound(jsonb, boolean) to tm8_app;


-- -----------------------------------------------------------------------------
-- §5. The keeper's and the watchdog's doors (bridges worker only).
-- -----------------------------------------------------------------------------

-- What the keeper needs to start or resume the session of the thread a stored
-- message belongs to: 425's managed context (teammate, acting member, bridge
-- live) plus the thread, its session and where a new one hangs. Null when the
-- message is in no thread that started a session.
create or replace function public.bridge_thread_context(p_bridge_id uuid, p_message_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  m public.messages; th public.bridge_threads; b public.bridges; ctx jsonb;
  root_o public.message_origins; root_m public.messages; author jsonb;
begin
  perform internal.require_bridges_worker();
  select * into m from public.messages where entity_id = p_message_id;
  if m.entity_id is null then return null; end if;
  select * into th from public.bridge_threads
   where bridge_id = p_bridge_id and root_message_id = coalesce(m.root_message_id, m.entity_id);
  if th.bridge_id is null then return null; end if;
  ctx := public.bridge_managed_context(p_bridge_id);
  if ctx is null then return null; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  select * into root_o from public.message_origins where message_id = th.root_message_id;
  select * into root_m from public.messages where entity_id = th.root_message_id;
  author := case when root_o.external_sender_id is not null
                 then internal.bridge_resolve_author(b.entity_id, root_o.external_sender_id) end;
  return ctx || jsonb_build_object(
    'rootMessageId', th.root_message_id,
    'rootExternalId', th.root_external_id,
    'rootText', left(coalesce(root_m.body, ''), 4000),
    'sessionId', th.session_id,
    'sessionLive', th.session_id is not null and internal.bridge_session_live(th.session_id),
    -- The bridge's target session is the thread session's parent. A chat or
    -- channel target has none, so its thread sessions are top-level sessions,
    -- each bridged to its own thread (see WHERE THE SESSION LIVES above).
    'parentSessionId', case when b.target_kind = 'work_session'
                             and exists (select 1 from public.entities t where t.id = b.target_id and t.deleted_at is null)
                            then b.target_id end,
    'sender', jsonb_strip_nulls(jsonb_build_object(
      'participant', coalesce(author #>> '{participant,displayName}', root_o.sender_display),
      'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end)));
end
$$;
revoke all on function public.bridge_thread_context(uuid, uuid) from public;
grant execute on function public.bridge_thread_context(uuid, uuid) to tm8_app;

-- The thread's session is this one (just started, or a resume that came back
-- as a new session): it holds the root as its '/thread' origin, which is what
-- 399's audience routes the thread's messages by.
create or replace function public.bridge_thread_bind(p_bridge_id uuid, p_root_external_id text, p_session_id uuid)
returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare th public.bridge_threads; b public.bridges; s public.entities; root_o public.message_origins; author jsonb;
begin
  perform internal.require_bridges_worker();
  select * into th from public.bridge_threads
   where bridge_id = p_bridge_id and root_external_id = p_root_external_id for update;
  if th.bridge_id is null then raise exception 'bridge thread not found' using errcode = 'P0002'; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  select * into s from public.entities where id = p_session_id;
  if s.id is null or s.deleted_at is not null or s.kind <> 'work_session' or s.space_id <> b.space_id then
    raise exception 'a thread session is a work session in the bridge''s space' using errcode = '22023';
  end if;
  update public.bridge_threads
     set session_id = p_session_id, idle_stopped_at = null, stop_attempted_at = null, last_activity_at = now()
   where bridge_id = th.bridge_id and root_external_id = th.root_external_id;
  select * into root_o from public.message_origins where message_id = th.root_message_id;
  author := case when root_o.external_sender_id is not null
                 then internal.bridge_resolve_author(b.entity_id, root_o.external_sender_id) end;
  perform internal.bridge_holder_add(p_session_id, jsonb_build_object(
    'bridgeId', p_bridge_id, 'messageId', th.root_message_id, 'providerMessageId', th.root_external_id,
    'sender', jsonb_strip_nulls(jsonb_build_object(
      'participant', coalesce(author #>> '{participant,displayName}', root_o.sender_display),
      'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end)),
    'command', '/thread'), false, null, 0);
  return true;
end
$$;
revoke all on function public.bridge_thread_bind(uuid, text, uuid) from public;
grant execute on function public.bridge_thread_bind(uuid, text, uuid) to tm8_app;

-- The watchdog's work, oldest first, at most p_limit stops and 5 starts:
--   'stop'  a thread session waiting for input (status idle) with nothing in
--           its thread for p_idle_seconds. Handing one out marks it
--           (stop_attempted_at) and it is not handed out again for 15 minutes,
--           whatever becomes of the stop.
--   'start' a thread whose session never started (the server stopped between
--           the inbound commit and the keeper), tried at most 3 times within
--           its first hour. Each one handed out counts as an attempt.
-- First it un-marks threads whose session runs again since the sweep stopped
-- it (a manual resume), and prunes the threads of removed (ended) or deleted
-- bridges once their session no longer runs: no message can reach them again.
-- A live bridge keeps every thread row, since a reply weeks later still
-- resumes that thread's session.
create or replace function public.bridge_threads_due(p_idle_seconds integer, p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare stops jsonb; starts jsonb; n integer := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  perform internal.require_bridges_worker();
  update public.bridge_threads t set idle_stopped_at = null
    from public.work_sessions ws
   where t.idle_stopped_at is not null and ws.entity_id = t.session_id
     and ws.status in ('spawning', 'running', 'idle') and ws.status_changed_at > t.idle_stopped_at;
  delete from public.bridge_threads t
   where (t.bridge_id, t.root_external_id) in (
     select d.bridge_id, d.root_external_id from public.bridge_threads d
       join public.bridges br on br.entity_id = d.bridge_id
       join public.entities be on be.id = d.bridge_id
      where (br.ended_at is not null or be.deleted_at is not null)
        and (d.session_id is null or not internal.bridge_session_live(d.session_id))
      limit 500);

  with due as (
    select t.bridge_id, t.root_external_id from public.bridge_threads t
      join public.work_sessions ws on ws.entity_id = t.session_id and ws.status = 'idle'
      join public.entities se on se.id = t.session_id and se.deleted_at is null
      join public.entities be on be.id = t.bridge_id and be.deleted_at is null
     where t.session_id is not null and t.idle_stopped_at is null
       and t.last_activity_at < now() - make_interval(secs => greatest(p_idle_seconds, 60))
       and (t.stop_attempted_at is null or t.stop_attempted_at < now() - interval '15 minutes')
     order by t.last_activity_at
     limit n
     for update of t skip locked
  ), marked as (
    update public.bridge_threads t set stop_attempted_at = now()
      from due where t.bridge_id = due.bridge_id and t.root_external_id = due.root_external_id
    returning t.bridge_id, t.root_external_id, t.root_message_id, t.session_id, t.last_activity_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('action', 'stop', 'bridgeId', marked.bridge_id,
                                               'rootExternalId', marked.root_external_id,
                                               'rootMessageId', marked.root_message_id,
                                               'sessionId', marked.session_id)
                            order by marked.last_activity_at), '[]'::jsonb) into stops
    from marked;
  with due as (
    select t.bridge_id, t.root_external_id from public.bridge_threads t
      join public.bridges br on br.entity_id = t.bridge_id and br.ended_at is null and br.paused_at is null
      join public.entities be on be.id = t.bridge_id and be.deleted_at is null
     where t.session_id is null and t.start_attempts < 3
       and t.created_at < now() - interval '1 minute' and t.created_at > now() - interval '1 hour'
     order by t.created_at
     limit least(n, 5)
     for update of t skip locked
  ), bumped as (
    update public.bridge_threads t set start_attempts = t.start_attempts + 1
      from due where t.bridge_id = due.bridge_id and t.root_external_id = due.root_external_id
    returning t.bridge_id, t.root_external_id, t.root_message_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('action', 'start', 'bridgeId', bumped.bridge_id,
                                               'rootExternalId', bumped.root_external_id,
                                               'rootMessageId', bumped.root_message_id)), '[]'::jsonb) into starts
    from bumped;
  return stops || starts;
end
$$;
revoke all on function public.bridge_threads_due(integer, integer) from public;
grant execute on function public.bridge_threads_due(integer, integer) to tm8_app;

-- The sweep stopped this thread's session for idleness; the next reply resumes it.
create or replace function public.bridge_thread_idle_stopped(p_bridge_id uuid, p_root_external_id text)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  update public.bridge_threads set idle_stopped_at = now()
   where bridge_id = p_bridge_id and root_external_id = p_root_external_id;
end
$$;
revoke all on function public.bridge_thread_idle_stopped(uuid, text) from public;
grant execute on function public.bridge_thread_idle_stopped(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §6. Which Slack thread an outbound message goes into (bridge_outbox.thread_ts).
--     A reply goes into the thread of the message it answers: an inbound
--     message's thread root is its replyTo (Slack fills it with the root on
--     every thread reply), else the message itself; one of tm8's own posts is
--     in the thread it was posted to. A post that answers nothing, by a
--     session holding a '/thread' origin on this bridge, goes into that
--     thread. A slash command ('cmd:<trigger_id>') is never a thread: its
--     answer goes to the channel. Reactions carry no thread.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_outbox_thread_ts() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v text; poster uuid;
begin
  if new.thread_ts like 'cmd:%' then new.thread_ts := null; end if;
  if new.thread_ts is not null or new.kind is distinct from 'send'
     or (select br.provider from public.bridges br where br.entity_id = new.bridge_id) is distinct from 'slack' then
    return new;
  end if;
  if new.external_reply_to is not null and new.external_reply_to not like 'cmd:%' then
    select coalesce(nullif(o.external_reply_to_id, ''), o.external_message_id) into v
      from public.message_origins o
     where o.bridge_id = new.bridge_id and o.external_message_id = new.external_reply_to and o.direction = 'in'
     limit 1;
    if v is null then
      select coalesce(ob.thread_ts, ob.external_message_id) into v
        from public.bridge_outbox ob
       where ob.bridge_id = new.bridge_id and ob.external_message_id = new.external_reply_to
       limit 1;
    end if;
    v := coalesce(v, new.external_reply_to);
  end if;
  if v is null then
    poster := coalesce(new.session_id, internal.bridge_message_poster(new.message_id));
    if poster is not null then
      select t.root_external_id into v
        from public.session_bridge_origins o
        join public.bridge_threads t on t.bridge_id = o.bridge_id and t.root_message_id = o.message_id
       where o.holder_id = poster and o.bridge_id = new.bridge_id and o.command = '/thread'
       order by t.last_activity_at desc
       limit 1;
    end if;
  end if;
  if v like 'cmd:%' then v := null; end if;
  new.thread_ts := v;
  if v is not null then
    update public.bridge_threads set last_activity_at = now()
     where bridge_id = new.bridge_id and root_external_id = v;
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_outbox_thread_ts() from public;
create trigger bridge_outbox_thread_ts before insert on public.bridge_outbox
for each row execute function internal.bridge_outbox_thread_ts();

reset role;

analyze public.bridge_threads;
