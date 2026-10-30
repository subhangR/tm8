-- =============================================================================
-- 402 — Bridges B1b-8: inbound completion. (Provisional number; the bridges
-- merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md (FINAL v4)
-- §2.3 steps 3 and 5, §2.7, §2.8 / D30, D39. Task
-- 01a18bb0-d554-7223-b193-c9618a5a5338. Builds on 398 (B1b-2), which is
-- immutable once applied: every object below that 398 defines is restated
-- from 398's exact body, changed only where this header says.
--
-- WHAT THIS FILE DOES
--   §1  internal.bridge_signed becomes VOLATILE (#1428 review N2): a worker's
--       signature writes through B1b-3's bridge_poster_handle (the space handle
--       and its appearance), so it is not a STABLE function;
--   §2  public.bridge_runtime_inbound passes the participant's display STRING
--       to add_bridge_origin (#1428 review N1; D22's origin.sender.participant).
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
-- §2. 398's public.bridge_runtime_inbound; the origin's participant is the
--     display string.
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
                           'sender', jsonb_build_object('participant', author #>> '{participant,displayName}',
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

reset role;
