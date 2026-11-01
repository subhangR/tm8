-- Preserve native PN/LID mentions through inbound storage and command retries.
-- Resolve author aliases in either direction, refusing conflicting identities.
-- Restates 425 inbound, 429 author resolution and 414 command input; other behavior is unchanged.
set local lock_timeout = '5s';
set role tm8_graph_owner;

create or replace function internal.bridge_resolve_author(p_bridge_id uuid, p_sender_external_id text)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  ids text[];
  link public.bridge_identity_links;
  member_id uuid;
  participant public.bridge_participants;
  owner_identity public.accounts.identity_id%type;
begin
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then
    raise exception 'bridge not found' using errcode = 'P0002';
  end if;
  select * into participant from public.bridge_participants
   where bridge_id = p_bridge_id and (external_id = p_sender_external_id or p_sender_external_id = any(alt_external_ids))
   order by (external_id = p_sender_external_id) desc, last_seen_at desc limit 1;
  select array_agg(distinct id) into ids from (
    select p_sender_external_id id
    union all
    select unnest(array[p.external_id] || p.alt_external_ids) from public.bridge_participants p
     where p.bridge_id = p_bridge_id and (p.external_id = p_sender_external_id or p_sender_external_id = any(p.alt_external_ids))
  ) aliases;
  -- A conflicting alias must never lend one person's membership to another.
  if (select count(*) from unnest(ids) id where id like '%@s.whatsapp.net') > 1
     or (select count(*) from unnest(ids) id where id like '%@lid') > 1
     or (select count(distinct l.identity_id) from public.bridge_identity_links l
         where l.provider = b.provider and l.external_id = any(ids) and l.revoked_at is null
           and (l.space_id is null or l.space_id = b.space_id)) > 1 then
    return jsonb_build_object('kind', 'bridge', 'actorId', p_bridge_id, 'trust', 'guest', 'identityConflict', true,
      'participant', jsonb_build_object('displayName', coalesce(participant.display_name, 'Guest')));
  end if;

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
  else
    -- 429: the linked number itself speaks for the account that linked it.
    select a.identity_id into owner_identity
      from public.bridge_connections c join public.accounts a on a.id = c.owner_account_id
     where c.id = b.connection_id and c.self_ids && ids;
    if owner_identity is not null then
      select m.entity_id into member_id
        from public.members m join public.entities e on e.id = m.entity_id
       where m.space_id = b.space_id and m.identity_id = owner_identity
         and m.status = 'active' and e.deleted_at is null
       limit 1;
    end if;
  end if;

  if member_id is null then
    return jsonb_build_object('kind', 'bridge', 'actorId', p_bridge_id, 'trust', 'guest',
      'participant', jsonb_build_object('displayName', coalesce(participant.display_name, 'Guest')));
  end if;
  if link.id is null then
    return jsonb_build_object('kind', 'member', 'actorId', member_id, 'trust', 'linked',
      'identityId', owner_identity, 'linkId', null, 'ownNumber', true,
      'participant', jsonb_build_object('displayName', coalesce(participant.display_name, '')));
  end if;
  return jsonb_build_object('kind', 'member', 'actorId', member_id,
    'trust', case when link.space_id is null then 'linked' else 'asserted' end,
    'identityId', link.identity_id, 'linkId', link.id,
    'participant', jsonb_build_object('displayName', coalesce(participant.display_name, '')));
end
$$;
revoke all on function internal.bridge_resolve_author(uuid, text) from public;
grant execute on function internal.bridge_resolve_author(uuid, text) to tm8_graph_owner;

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
    sender_display, provider_payload, media)
  values (log_id, b.entity_id, conn.id, 'in', ext, conv, sender, reply_ext, ts,
          case when p_command then 'pending' end, sender_name,
          jsonb_build_object('mentions', coalesce(p_frame -> 'mentions', '[]'::jsonb)),
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
    'mentions', coalesce(o.provider_payload -> 'mentions', '[]'::jsonb),
    'edited', m.edited_at is not null or m.redacted_at is not null,
    'replyTo', case when o.external_reply_to_id is null then null
                    else jsonb_build_object('externalMessageId', o.external_reply_to_id) end,
    -- 414: B1b-2's state (398); the executor tells the group once when it ends failed.
    'commandState', o.command_state);
end
$$;
revoke all on function public.bridge_command_input(uuid) from public;
grant execute on function public.bridge_command_input(uuid) to tm8_app;


reset role;
