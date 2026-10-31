-- =============================================================================
-- 413 — Bridges B1b-8: inbound completion. (Provisional number; the bridges
-- merger assigns the final one.)
-- (Authored as 402; renumbered to 413 at merge by the bridges merger: next free above main's 412.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- §2.3 steps 3 and 5, §2.7, §2.8 / D30, D39. Task
-- 01a18bb0-d554-7223-b193-c9618a5a5338. Builds on 398 (B1b-2), which is
-- immutable once applied: every object below that 398 defines is restated
-- from main's latest body, changed only where this header says. For
-- public.bridge_runtime_inbound that is 406_loops_bridge_targets (L, #1433),
-- which redefined 398's: every '406 (L, D26, D69)' block (the reply to a live
-- loop session's post routed to that session) is kept verbatim. 406's L origin
-- passes the participant object as L wrote it; only this file's own branches
-- pass the display string (N1).
--
-- WHAT THIS FILE DOES
--   §1  internal.bridge_signed becomes VOLATILE (#1428 review N2): a worker's
--       signature writes through B1b-3's bridge_poster_handle (the space handle
--       and its appearance), so it is not a STABLE function;
--   §2  public.bridge_runtime_inbound passes the participant's display STRING
--       to add_bridge_origin (#1428 review N1; D22's origin.sender.participant).
--   §3  reactions and poll votes are stored (D39): one reaction per (message,
--       sender), the latest wins and an empty emoji removes it; one vote per
--       (poll, voter), its selected option hashes, or the sealed payload the
--       server opens with the poll's stored messageSecret. 398's inbound
--       acknowledged and dropped both; §2's restated body routes them here.
--   §4  media as files (§2.3 step 3): inbound records one bridge_media row per
--       media item; the bridges worker fetches the bytes from the runtime
--       (media.fetch, D39 handles), writes them to the blob store and attaches
--       a file entity to the log message; failures retry, then stop.
--   §5  delivery to sessions (§2.2, §2.7, D30): a session target gets its
--       routed copy; B1b-3's bridge_message_audience names the directed (and
--       thread/all-listening) workers. internal.bridge_inbound_deliveries
--       answers the dispatch routes once per (message, session), records the
--       answerer for a directed delivery and adds the bridge origin to every
--       directed or routed session (add_bridge_origin, deduped there).
--
-- CORRECTION TO 395's HEADER (fix-forward; 395 is applied and checksummed, so
-- it is not edited). 395 says it touches no object of Mobile's 391, but its §2
-- restates auth_sessions_kind_check (adding 'bridge_runtime'), which 391 also
-- rewrites. Any later rewrite of that check must re-derive it from the live
-- definition and keep both 'mobile' and 'bridge_runtime'. This file touches
-- neither auth_sessions_kind_check nor chat_turns_requested_by_auth_kind_check.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. 398's internal.bridge_signed, VOLATILE.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_signed(b public.bridges, p_author uuid, p_session uuid, p_poster text, p_text text)
returns text language plpgsql volatile set search_path = public, internal, pg_temp as $$
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

-- -----------------------------------------------------------------------------
-- §2. public.bridge_runtime_inbound, restated from 406 (L), which restated
--     398's; the origin's participant is the display string on this file's
--     own branches.
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
  -- 406 (L)
  loop_sid uuid;
  sess_e public.entities;
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

  return jsonb_build_object('status', 'stored', 'messageId', log_id, 'bridgeId', b.entity_id,
                            'command', false, 'routed', routed, 'copyId', copy_id, 'wakeChat', wake,
                            'author', author);
end
$$;
revoke all on function public.bridge_runtime_inbound(jsonb, boolean) from public;
grant execute on function public.bridge_runtime_inbound(jsonb, boolean) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. Reactions and poll votes (D39). Server-owned rows beside the message
--     they are about; the app role reads reactions through RLS on the message,
--     and never reads a sealed vote.
-- -----------------------------------------------------------------------------
create table public.bridge_reactions (
  message_id          uuid not null references public.messages(entity_id) on delete cascade,
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  external_sender_id  text not null,
  author_id           uuid not null references public.entities(id),
  emoji               text not null check (char_length(emoji) between 1 and 16),
  external_message_id text not null,
  reacted_at          timestamptz not null,
  primary key (message_id, external_sender_id)
);
alter table public.bridge_reactions enable row level security;
create policy bridge_reactions_select on public.bridge_reactions for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_reactions.message_id and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_reactions to tm8_app;

create table public.bridge_poll_votes (
  poll_message_id     uuid not null references public.messages(entity_id) on delete cascade,
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  voter_external_id   text not null,
  author_id           uuid not null references public.entities(id),
  selected_hashes     text[],
  -- SERVER-ONLY: a vote the runtime could not open (D39); withheld from tm8_app.
  sealed              jsonb,
  external_message_id text not null,
  voted_at            timestamptz not null,
  primary key (poll_message_id, voter_external_id),
  check (selected_hashes is not null or sealed is not null)
);
alter table public.bridge_poll_votes enable row level security;
create policy bridge_poll_votes_select on public.bridge_poll_votes for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_poll_votes.poll_message_id and readable_entity.deleted_at is null offset 0)));
grant select (poll_message_id, bridge_id, voter_external_id, author_id, selected_hashes, external_message_id, voted_at)
  on public.bridge_poll_votes to tm8_app;

-- The tm8 message a provider id names on this bridge: an inbound log copy or
-- one of our own sends.
create or replace function internal.bridge_message_for(p_bridge uuid, p_external text) returns uuid
language sql stable set search_path = public, internal, pg_temp as $$
  select o.message_id from public.message_origins o
   where o.bridge_id = p_bridge and o.external_message_id = p_external
   order by o.direction limit 1
$$;
revoke all on function internal.bridge_message_for(uuid, text) from public;

-- The author a sender resolves to, without touching presence (a reaction is
-- not a message, so it does not count toward message_count).
create or replace function internal.bridge_sender_actor(b public.bridges, p_sender text) returns uuid
language sql stable set search_path = public, internal, pg_temp as $$
  select case when p_sender is null then b.entity_id
              else (internal.bridge_resolve_author(b.entity_id, p_sender) ->> 'actorId')::uuid end
$$;
revoke all on function internal.bridge_sender_actor(public.bridges, text) from public;

create or replace function internal.bridge_store_reaction(b public.bridges, p_connection uuid, p_frame jsonb) returns jsonb
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  target uuid := internal.bridge_message_for(b.entity_id, p_frame #>> '{reaction,externalMessageId}');
  sender text := p_frame #>> '{sender,externalId}';
  emoji text := coalesce(p_frame #>> '{reaction,emoji}', '');
  at timestamptz := coalesce(to_timestamp((p_frame ->> 'ts')::double precision), now());
begin
  if target is null or sender is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'reaction_target_unknown');
  end if;
  if emoji = '' then
    delete from public.bridge_reactions where message_id = target and external_sender_id = sender and reacted_at <= at;
    return jsonb_build_object('status', 'stored', 'kind', 'reaction', 'messageId', target, 'removed', true);
  end if;
  insert into public.bridge_reactions(message_id, bridge_id, external_sender_id, author_id, emoji, external_message_id, reacted_at)
  values (target, b.entity_id, sender, internal.bridge_sender_actor(b, sender), left(emoji, 16), p_frame ->> 'externalMessageId', at)
  on conflict (message_id, external_sender_id) do update
    set emoji = excluded.emoji, author_id = excluded.author_id,
        external_message_id = excluded.external_message_id, reacted_at = excluded.reacted_at
    where bridge_reactions.reacted_at <= excluded.reacted_at;
  update public.messages set updated_at = clock_timestamp() where entity_id = target;
  return jsonb_build_object('status', 'stored', 'kind', 'reaction', 'messageId', target);
end
$$;
revoke all on function internal.bridge_store_reaction(public.bridges, uuid, jsonb) from public;

create or replace function internal.bridge_store_poll_vote(b public.bridges, p_connection uuid, p_frame jsonb) returns jsonb
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  poll uuid := internal.bridge_message_for(b.entity_id, p_frame #>> '{pollVote,pollMessageId}');
  hashes text[];
  sealed jsonb := case when jsonb_typeof(p_frame #> '{pollVote,sealed}') = 'object' then p_frame #> '{pollVote,sealed}' end;
  voter text;
  at timestamptz := coalesce(to_timestamp((p_frame ->> 'ts')::double precision), now());
  n integer := 0;
begin
  if poll is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'poll_unknown');
  end if;
  if jsonb_typeof(p_frame #> '{pollVote,selectedHashes}') = 'array' then
    select coalesce(array_agg(h), '{}') into hashes from jsonb_array_elements_text(p_frame #> '{pollVote,selectedHashes}') h;
  end if;
  if hashes is null and sealed is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'poll_vote_empty');
  end if;
  for voter in select jsonb_array_elements_text(coalesce(p_frame #> '{pollVote,voterIds}',
                 jsonb_build_array(p_frame #>> '{sender,externalId}'))) loop
    continue when voter is null;
    insert into public.bridge_poll_votes(poll_message_id, bridge_id, voter_external_id, author_id, selected_hashes, sealed,
                                         external_message_id, voted_at)
    values (poll, b.entity_id, voter, internal.bridge_sender_actor(b, voter), hashes, sealed, p_frame ->> 'externalMessageId', at)
    on conflict (poll_message_id, voter_external_id) do update
      set selected_hashes = excluded.selected_hashes, sealed = excluded.sealed, author_id = excluded.author_id,
          external_message_id = excluded.external_message_id, voted_at = excluded.voted_at
      where bridge_poll_votes.voted_at <= excluded.voted_at;
    n := n + 1;
  end loop;
  update public.messages set updated_at = clock_timestamp() where entity_id = poll;
  return jsonb_build_object('status', 'stored', 'kind', 'poll_vote', 'messageId', poll, 'votes', n);
end
$$;
revoke all on function internal.bridge_store_poll_vote(public.bridges, uuid, jsonb) from public;


-- #1442 review F2: the runtime's fetch handles (the message's media keys, D39)
-- live only in bridge_media, server-only. §2's inbound writes message_origins
-- .media with descriptive fields alone, and the app role no longer reads the
-- column (398 granted it); every other column stays readable.
revoke select (media) on public.message_origins from tm8_app;

-- -----------------------------------------------------------------------------
-- §4. Media as files (§2.3 step 3). One row per inbound media item; the worker
--     fetches, the blob store holds the bytes, and the file entity is attached
--     to the log message exactly as a message attachment is: an attached_to
--     edge, whose trigger keeps the message's attachment manifest.
-- -----------------------------------------------------------------------------
create table public.bridge_media (
  message_id  uuid not null references public.messages(entity_id) on delete cascade,
  idx         integer not null check (idx >= 0),
  bridge_id   uuid not null references public.bridges(entity_id) on delete cascade,
  -- SERVER-ONLY: the runtime's fetch handle (the message's media keys, D39).
  handle      text not null,
  kind        text not null,
  mime        text,
  file_name   text,
  status      text not null default 'pending' check (status in ('pending', 'fetching', 'done', 'failed')),
  attempts    integer not null default 0,
  file_id     uuid references public.entities(id) on delete set null,
  last_error  text,
  next_at     timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  primary key (message_id, idx)
);
create index bridge_media_due_idx on public.bridge_media(next_at) where status in ('pending', 'fetching');
alter table public.bridge_media enable row level security;
-- No policy and no grant: the worker's definer doors are the only readers.

-- The worker takes due items for these runtimes; a fetch a crash abandoned is
-- due again after two minutes. Answers what the media.fetch frame needs.
create or replace function internal.bridge_media_take(p_runtime_ids text[], p_limit integer) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r record; items jsonb := '[]'::jsonb;
begin
  perform internal.require_bridges_worker();
  for r in
    select bm.message_id, bm.idx, bm.handle, bm.kind, bm.mime, bm.file_name, b.space_id, b.connection_id,
           b.external_conversation_id, c.runtime_id
      from public.bridge_media bm
      join public.bridges b on b.entity_id = bm.bridge_id
      join public.bridge_connections c on c.id = b.connection_id
     where bm.next_at <= now()
       and (bm.status = 'pending' or (bm.status = 'fetching' and bm.next_at <= now()))
       and c.runtime_id = any(p_runtime_ids) and c.status = 'linked' and b.ended_at is null
     order by bm.created_at
     limit greatest(least(p_limit, 20), 1)
     for update of bm skip locked
  loop
    update public.bridge_media set status = 'fetching', attempts = attempts + 1, next_at = now() + interval '2 minutes'
     where message_id = r.message_id and idx = r.idx;
    items := items || jsonb_build_array(jsonb_build_object(
      'messageId', r.message_id, 'idx', r.idx, 'handle', r.handle, 'kind', r.kind, 'mime', r.mime,
      'fileName', r.file_name, 'spaceId', r.space_id, 'connectionId', r.connection_id,
      'conversationId', r.external_conversation_id, 'runtimeId', r.runtime_id));
  end loop;
  return items;
end
$$;
revoke all on function internal.bridge_media_take(text[], integer) from public;
grant execute on function internal.bridge_media_take(text[], integer) to tm8_app;

-- The bytes are in the blob store: create the file entity (authored like the
-- message) and attach it to the log message. Idempotent per (message, idx).
create or replace function internal.bridge_media_attach(
  p_message uuid, p_idx integer, p_storage_path text, p_size bigint, p_sha256 text, p_mime text
) returns uuid language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare bm public.bridge_media; m public.messages; e public.entities; v_file uuid; v_name text;
begin
  perform internal.require_bridges_worker();
  select * into bm from public.bridge_media where message_id = p_message and idx = p_idx for update;
  if bm.message_id is null then raise exception 'bridge media not found' using errcode = 'P0002'; end if;
  if bm.status = 'done' then return bm.file_id; end if;
  select * into m from public.messages where entity_id = p_message;
  select * into e from public.entities where id = p_message;
  v_name := left(coalesce(nullif(btrim(bm.file_name), ''), bm.kind || '-' || (p_idx + 1)), 200);
  perform internal.bind_actor(m.author_id);
  v_file := internal.create_envelope(e.space_id, 'file', m.author_id, null, null, null);
  insert into public.files(entity_id, name, mime_type, size_bytes, storage_path, checksum_sha256)
  values (v_file, v_name, coalesce(nullif(p_mime, ''), bm.mime, 'application/octet-stream'), p_size, p_storage_path, p_sha256);
  perform internal.record_initial_version(v_file, m.author_id);
  perform internal.w1_set_writer('message_attachment');
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (e.space_id, v_file, p_message, 'attached_to', m.author_id);
  perform internal.w1_set_writer('');
  -- The attached_to edge's own trigger (w2_sync_message_attachments_insert)
  -- rewrites the message's attachment manifest, which emits message.updated.
  update public.bridge_media set status = 'done', file_id = v_file, last_error = null
   where message_id = p_message and idx = p_idx;
  return v_file;
end
$$;
revoke all on function internal.bridge_media_attach(uuid, integer, text, bigint, text, text) from public;
grant execute on function internal.bridge_media_attach(uuid, integer, text, bigint, text, text) to tm8_app;

-- A fetch that failed: retried with backoff up to five attempts, or stopped
-- at once when the runtime says it can never succeed (too large, gone).
create or replace function internal.bridge_media_fail(p_message uuid, p_idx integer, p_reason text, p_retry boolean)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  update public.bridge_media
     set status = case when p_retry and attempts < 5 then 'pending' else 'failed' end,
         next_at = now() + make_interval(secs => 30 * power(2, attempts)),
         last_error = left(coalesce(p_reason, 'failed'), 300)
   where message_id = p_message and idx = p_idx and status <> 'done';
end
$$;
revoke all on function internal.bridge_media_fail(uuid, integer, text, boolean) from public;
grant execute on function internal.bridge_media_fail(uuid, integer, text, boolean) to tm8_app;


-- -----------------------------------------------------------------------------
-- §5. Delivery to sessions (§2.2, §2.7, D30). The server delivers after commit
--     through the same stored-first PTY path every message uses; this answers
--     the routes. B1b-3's doors are called only when its migration is present.
-- -----------------------------------------------------------------------------
create table public.bridge_inbound_deliveries (
  message_id   uuid not null references public.messages(entity_id) on delete cascade,
  session_id   uuid not null references public.entities(id) on delete cascade,
  reason       text not null,
  delivered_at timestamptz not null default now(),
  primary key (message_id, session_id)
);
alter table public.bridge_inbound_deliveries enable row level security;
-- No policy and no grant: written and read only by the definer below.


reset role;

-- §5's two functions write 076's session_message_reply_routes, which is owned
-- by the migration owner and under RLS. Like 214's form_delivery_route they are
-- therefore owned by the migration owner (created after `reset role`); both
-- are gated on the bridges worker or called only by a gated definer.
-- One dispatch route (message-dispatch.ts DispatchableRoute), as 214's
-- form_delivery_route builds it, plus the bridge origin element (B1b-3's
-- bridge_origin_facts) the incoming-message envelope renders.
create or replace function internal.bridge_route_json(p_message uuid, p_session uuid, p_directed boolean)
returns jsonb language plpgsql set search_path = public, internal, pg_temp as $$
declare m public.messages; anchor_kind text; facts jsonb;
begin
  select * into m from public.messages where entity_id = p_message;
  select e.kind into anchor_kind from public.entities e where e.id = m.anchor_id;
  insert into public.session_message_reply_routes(
    target_message_id, target_work_session_id, source_anchor_id, source_message_id, addressing_kind)
  values (p_message, p_session, m.anchor_id, p_message, 'anchored_message')
  on conflict do nothing;
  if to_regprocedure('public.bridge_origin_facts(uuid,uuid,boolean)') is not null then
    execute 'select public.bridge_origin_facts($1, $2, $3)' into facts using p_message, p_session, p_directed;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'targetMessageId', p_message,
    'targetWorkSessionId', p_session,
    'messageBatchId', m.message_batch_id,
    'senderActorId', m.author_id,
    'senderActorKind', (select e.kind from public.entities e where e.id = m.author_id),
    'sourceAnchorId', m.anchor_id,
    'sourceAnchorKind', anchor_kind,
    'sourceMessageId', p_message,
    'threadRootMessageId', coalesce(m.root_message_id, p_message),
    'body', m.body,
    'addressingKind', 'anchored_message',
    'bridgeOrigin', facts,
    'rollingControlMaxBytes', coalesce((
      select (pin.resolved_snapshot #>> '{agentProjection,promptPolicy,rollingControlMaxBytes}')::integer
        from public.work_session_interaction_pins pin
       where pin.work_session_id = p_session order by pin.pin_revision desc limit 1), 16384),
    'sessionInputAllowed', coalesce((
      select case
        when jsonb_array_length(coalesce(
          pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}', '[]'::jsonb)) = 0 then true
        else coalesce((pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}')
                        ? 'tm8.session-input', false) end
        from public.work_session_interaction_pins pin
       where pin.work_session_id = p_session order by pin.pin_revision desc limit 1), true)))
    || jsonb_build_object('threadParentMessageId', null, 'attachments', m.attachments, 'contextAnchors', '[]'::jsonb);
end
$$;
revoke all on function internal.bridge_route_json(uuid, uuid, boolean) from public;

-- The routes one stored inbound message owes, each at most once. Directed and
-- routed deliveries add the bridge origin to the session (D30: what prompted
-- the work); a directed one also makes that session the message's answerer.
create or replace function internal.bridge_inbound_deliveries(p_message uuid) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  o public.message_origins; b public.bridges; m public.messages; copy uuid; s record; routes jsonb := '[]'::jsonb;
  origin jsonb; author jsonb;
begin
  perform internal.require_bridges_worker();
  select * into o from public.message_origins where message_id = p_message and direction = 'in';
  if o.message_id is null or o.command_state is not null then return routes; end if;
  select * into b from public.bridges where entity_id = o.bridge_id;
  select * into m from public.messages where entity_id = p_message;
  author := case when o.external_sender_id is null then null
                 else internal.bridge_resolve_author(b.entity_id, o.external_sender_id) end;
  origin := jsonb_strip_nulls(jsonb_build_object(
    'bridgeId', b.entity_id, 'messageId', p_message, 'providerMessageId', o.external_message_id,
    'sender', jsonb_build_object(
      'participant', coalesce(author #>> '{participant,displayName}', o.sender_display),
      'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
    'command', null));

  -- A session target: its routed copy (the batch twin anchored on it).
  if b.target_kind = 'work_session' and o.routed then
    select t.entity_id into copy from public.messages t
     where t.message_batch_id = m.message_batch_id and t.anchor_id = b.target_id limit 1;
    if copy is not null then
      insert into public.bridge_inbound_deliveries(message_id, session_id, reason) values (p_message, b.target_id, 'routed')
      on conflict do nothing;
      if found then
        routes := routes || jsonb_build_array(internal.bridge_route_json(copy, b.target_id, false));
        perform internal.bridge_try('public.add_bridge_origin', 'uuid,jsonb', b.target_id::text, origin::text);
      end if;
    end if;
  end if;

  -- Workers: directed (@handle, a reply to its post, its /work thread) and
  -- those listening at thread/all (B1b-3, §2.7). Un-directed and not listening:
  -- nothing is pushed; the reader counts it as unread.
  if to_regprocedure('public.bridge_message_audience(uuid,uuid)') is not null then
    for s in execute 'select session_id, reason from public.bridge_message_audience($1, $2)' using b.entity_id, p_message loop
      continue when s.session_id = b.target_id;
      insert into public.bridge_inbound_deliveries(message_id, session_id, reason) values (p_message, s.session_id, s.reason)
      on conflict do nothing;
      continue when not found;
      routes := routes || jsonb_build_array(internal.bridge_route_json(p_message, s.session_id, s.reason = 'directed'));
      if s.reason = 'directed' then
        perform internal.bridge_try('public.set_bridge_answerer', 'uuid,uuid', p_message::text, s.session_id::text);
        perform internal.bridge_try('public.add_bridge_origin', 'uuid,jsonb', s.session_id::text, origin::text);
      end if;
    end loop;
  end if;
  return routes;
end
$$;
revoke all on function internal.bridge_inbound_deliveries(uuid) from public;
grant execute on function internal.bridge_inbound_deliveries(uuid) to tm8_app;
