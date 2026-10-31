-- =============================================================================
-- 425 — Bridges manage their sessions (R11), plus the routing fixes R1, R3, R8.
--
-- Research: tm8 doc 01a1932d-ccef-7652-b8f1-b42d33186711 (§6, §7, §9). Task
-- 01a1933d-b1df-7642-a58d-90cfb87a7dfb. Builds on 395, 398, 399, 413. Every
-- object below that an earlier file defines is restated from its latest body
-- (395 for bridge_view and retarget_bridge, 413 for bridge_runtime_inbound and
-- bridge_inbound_deliveries), changed only where a `425` comment says.
--
-- WHAT THIS FILE DOES
--   §1  R1: `direction: out` is enforced inbound. The message is still logged
--       (it is the group's record) but never routed, never a turn, never
--       delivered to a session. Before this, only the outbox read `direction`.
--   §2  R11: bridge_runtime_inbound tells the server when a routed copy is for
--       a session that is not running (`targetSession.live = false`), so the
--       server resumes it, or starts a new one and moves the bridge, BEFORE it
--       delivers. bridge_inbound_deliveries re-makes the copy on the bridge's
--       current session when the bridge moved after the copy was made.
--   §3  R11: two doors for the bridges worker — bridge_managed_context (what
--       the keeper needs to resume or replace a session) and
--       bridge_managed_retarget (move a chat/session bridge onto a session the
--       server just started, for `/new` and for a dead target). Neither is
--       callable by an app role, a member or an agent.
--   §4  R3: retarget_bridge refuses a move across the channel line
--       (`retarget_changes_log`): a channel is its own log, a chat or session
--       logs on the bridge.
--   §5  R8: bridge_view says whether the target can take a message
--       (`target.live`) and why not (`health.detail`).
-- =============================================================================

set local lock_timeout = '5s';

reset role;

-- -----------------------------------------------------------------------------
-- §1/§2. 413's bridge_inbound_deliveries, restated (owned by the migration
--        owner, as 413 created it: it writes session_message_reply_routes).
-- -----------------------------------------------------------------------------
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
  -- 425 (R1): nothing from a `direction: out` group is pushed at a session.
  if b.policy ->> 'direction' = 'out' then return routes; end if;
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
    -- 425 (R11): the bridge moved to a new session after the copy was made
    -- (the old one could not resume): the copy follows it, once.
    if copy is null then
      copy := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      select copy, b.space_id, 'message', null, null, m.author_id, te.visibility
        from public.entities te where te.id = b.target_id and te.deleted_at is null;
      if found then
        insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
        values (copy, b.target_id, null, m.author_id, m.body, m.message_batch_id);
      else
        copy := null;
      end if;
    end if;
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

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1/§2. 413's public.bridge_runtime_inbound, restated.
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

-- -----------------------------------------------------------------------------
-- §3. The keeper's doors (bridges worker only).
-- -----------------------------------------------------------------------------

-- What the keeper needs to resume or replace a bridge's session: the target,
-- whether it runs, the teammate a new one runs as, and whose authority the
-- launch borrows (the member who created the bridge, else the number's owner).
create or replace function public.bridge_managed_context(p_bridge_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; e public.entities; who text; teammate uuid;
begin
  perform internal.require_bridges_worker();
  select br.* into b from public.bridges br where br.entity_id = p_bridge_id;
  select * into e from public.entities where id = p_bridge_id;
  if b.entity_id is null or e.deleted_at is not null then return null; end if;
  select m.identity_id into who from public.members m join public.entities me on me.id = m.entity_id
   where m.entity_id = e.created_by and m.space_id = b.space_id and m.status = 'active' and me.deleted_at is null;
  if who is null then
    select a.identity_id into who
      from public.bridge_connections c join public.accounts a on a.id = c.owner_account_id
      join public.members m on m.identity_id = a.identity_id and m.space_id = b.space_id and m.status = 'active'
     where c.id = b.connection_id limit 1;
  end if;
  teammate := coalesce(b.teammate_id,
    case b.target_kind
      when 'chat' then (select c.teammate_id from public.chats c where c.entity_id = b.target_id)
      when 'work_session' then (select a.acting_as_team_member_id from public.auth_sessions a
                                 where a.work_session_id = b.target_id and a.acting_as_team_member_id is not null
                                 order by a.created_at desc limit 1)
    end);
  return jsonb_build_object(
    'bridgeId', b.entity_id, 'spaceId', b.space_id,
    'title', b.conversation ->> 'title',
    'targetKind', b.target_kind, 'targetId', b.target_id,
    'targetTitle', internal.bridge_target_title(b.target_kind, b.target_id),
    'targetLive', case when b.target_kind = 'work_session' then internal.bridge_session_live(b.target_id)
                       else exists (select 1 from public.entities t where t.id = b.target_id and t.deleted_at is null) end,
    'teammateId', teammate,
    'actingIdentityId', who,
    'live', b.ended_at is null and b.paused_at is null);
end
$$;
revoke all on function public.bridge_managed_context(uuid) from public;
grant execute on function public.bridge_managed_context(uuid) to tm8_app;

-- Move a chat/session bridge onto a session (or chat) the server itself just
-- started for it. The human door (retarget_bridge) stays the only way to pick
-- an arbitrary target; this one only ever lands on a live entity in the same
-- space that has no bridge, on the same side of the channel line.
create or replace function public.bridge_managed_retarget(
  p_bridge_id uuid, p_target_id uuid, p_actor_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare b public.bridges; e public.entities; target public.entities; actor uuid; v_constraint text;
begin
  perform internal.require_bridges_worker();
  if p_reason is null or p_reason not in ('new', 'resume_failed') then
    raise exception 'reason must be new or resume_failed' using errcode = '22023';
  end if;
  select * into b from public.bridges where entity_id = p_bridge_id for update;
  select * into e from public.entities where id = p_bridge_id;
  if b.entity_id is null or e.deleted_at is not null or b.ended_at is not null then
    perform internal.bridge_refuse('bridge_ended', 'this bridge was removed');
  end if;
  if b.target_kind = 'channel' then
    perform internal.bridge_refuse('retarget_changes_log', 'a channel bridge has no session to replace');
  end if;
  select * into target from public.entities where id = p_target_id;
  if target.id is null or target.deleted_at is not null or target.space_id <> b.space_id
     or target.kind not in ('chat', 'work_session') then
    raise exception 'the new target must be a chat or session in the bridge''s space' using errcode = '22023';
  end if;
  if target.id = b.target_id then
    return internal.bridge_view(p_bridge_id);
  end if;
  perform internal.bridge_assert_target_free(p_target_id, p_bridge_id);
  -- The actor is a member of the bridge's space (the sender of /new, or the
  -- keeper's acting member); otherwise the bridge's creator.
  select m.entity_id into actor from public.members m
   where m.entity_id = p_actor_id and m.space_id = b.space_id and m.status = 'active';
  actor := coalesce(actor, e.created_by);
  begin
    update public.bridges set target_kind = target.kind, target_id = target.id
     where entity_id = p_bridge_id returning * into b;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform internal.bridge_reraise_unique(v_constraint);
  end;
  perform internal.bridge_write_target_edge(b, actor);
  perform internal.record_activity(b.space_id, p_bridge_id, actor, 'updated', null,
    jsonb_build_object('kind', 'bridge', 'retargetedTo', target.id, 'managed', p_reason));
  return internal.bridge_view(p_bridge_id);
end
$$;
revoke all on function public.bridge_managed_retarget(uuid, uuid, uuid, text) from public;
grant execute on function public.bridge_managed_retarget(uuid, uuid, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §4. 395's retarget_bridge, restated.
-- -----------------------------------------------------------------------------
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
  -- 425 (R3): a channel is its own log; a chat or session logs on the bridge.
  -- Moving across that line would strand the history and keep a policy made
  -- for the other kind, so it is refused: remove the bridge and connect the
  -- group again instead.
  if (b.target_kind = 'channel') <> (target.kind = 'channel') then
    perform internal.bridge_refuse('retarget_changes_log',
      format('a bridge to a %s cannot move to a %s: remove it and connect the group again',
             case b.target_kind when 'channel' then 'channel' else 'chat or session' end,
             case target.kind when 'channel' then 'channel' else 'chat or session' end),
      jsonb_build_object('from', b.target_kind, 'to', target.kind));
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

-- -----------------------------------------------------------------------------
-- §5. 395's internal.bridge_view, restated.
-- -----------------------------------------------------------------------------
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
  target_live boolean;
begin
  -- Definer, so readability is checked here, not left to RLS: a caller who
  -- cannot read the bridge entity gets nothing, from any space.
  if not internal.entity_readable(p_bridge_id) then return null; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then return null; end if;
  select * into conn from public.bridge_connections where id = b.connection_id;
  admin := internal.is_space_admin(b.space_id);
  target_live := case when b.target_kind = 'work_session' then internal.bridge_session_live(b.target_id)
                      else exists (select 1 from public.entities t where t.id = b.target_id and t.deleted_at is null) end;

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
      'title', coalesce(internal.bridge_target_title(b.target_kind, b.target_id), ''),
      -- 425 (R8): whether the target can take a message right now.
      'live', target_live),
    'policy', b.policy,
    'status', status,
    'health', jsonb_build_object(
      'connection', case when conn.status in ('linked', 'connecting', 'logged_out') then conn.status else 'offline' end,
      'lastInboundAt', last_in, 'lastOutboundAt', last_out,
      'queued', coalesce(queued, 0), 'failed24h', coalesce(failed, 0),
      'detail', case when conn.status = 'removed' then 'connection removed'
                     when not target_live and b.target_kind = 'work_session'
                       then 'the session has ended; the next message resumes it, or starts a new one'
                     when not target_live then 'the ' || case b.target_kind when 'chat' then 'chat' else 'channel' end
                       || ' was deleted; move the bridge to another one' end),
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

reset role;
