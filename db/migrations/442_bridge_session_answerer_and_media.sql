-- 442: a bridge's session target answers, sees and hears what it is routed
-- (task 01a1da4c, "make sure the WhatsApp bridge works").
--
-- Three faults, each seen on prod on 2026-11-14 in a family WhatsApp group whose
-- bridge targets a work session:
--
--   §1  The session target was never the answerer. 413 §5 names an answerer
--       only for a directed worker, so the target session's reply to a bridged
--       message counted as undirected (399 bridge_post_is_directed) and fell
--       in 406's six-per-ten-minutes bucket: its seventh reply in ten minutes
--       was refused rate_limited, and a refusal is final. The target now
--       answers each message it is routed, unless a directed worker holds the
--       answer.
--   §2  Photos never reached the session. 413 §4 attaches each fetched file to
--       the log message alone, and a session target reads its routed copy (a
--       batch twin on its own anchor), which had no attachments. A fetched file
--       is now attached to the log message and to every routed copy of it, and
--       R11's re-made copy (425) gets the files already fetched.
--   §3  Delivery raced the fetch, and a voice note was silent. The server now
--       waits for a message's media before it delivers or wakes a chat
--       (bridge_media_pending), and a voice note transcribed on this host (no
--       API) is kept on its media row and appended to the message and its
--       copies as one line (bridge_media_transcript).
--
-- Ownership follows the functions restated: the §2/§3 media doors are
-- tm8_graph_owner's (413 §4); bridge_inbound_deliveries is the migration
-- owner's (413 §5, 425).

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §2. A fetched file is attached to the log message and every routed copy.
--     413's body verbatim except the edge insert, which now covers the batch
--     twins: the session copy and the chat copy share message_batch_id with the
--     log message (bridge-in:<bridge>:<external id>).
-- -----------------------------------------------------------------------------
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
  select e.space_id, v_file, t.entity_id, 'attached_to', m.author_id
    from public.messages t
    join public.entities te on te.id = t.entity_id and te.deleted_at is null and te.space_id = e.space_id
   where t.entity_id = p_message
      or (m.message_batch_id is not null and t.message_batch_id = m.message_batch_id);
  perform internal.w1_set_writer('');
  -- The attached_to edges' own trigger (w2_sync_message_attachments_insert)
  -- rewrites each message's attachment manifest, which emits message.updated.
  update public.bridge_media set status = 'done', file_id = v_file, last_error = null
   where message_id = p_message and idx = p_idx;
  return v_file;
end
$$;
revoke all on function internal.bridge_media_attach(uuid, integer, text, bigint, text, text) from public;
grant execute on function internal.bridge_media_attach(uuid, integer, text, bigint, text, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. Settling before delivery, and voice-note transcripts.
-- -----------------------------------------------------------------------------

-- The media items of a message the server should still wait for before it
-- delivers the message: those being fetched, and those never tried. An item
-- that failed once and is backing off (413: 30 s and doubling) is not waited
-- for; it is attached to the message and its copies whenever it arrives.
create or replace function internal.bridge_media_pending(p_message uuid) returns integer
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridges_worker();
  return (select count(*)::int from public.bridge_media
           where message_id = p_message
             and (status = 'fetching' or (status = 'pending' and attempts = 0)));
end
$$;
revoke all on function internal.bridge_media_pending(uuid) from public;
grant execute on function internal.bridge_media_pending(uuid) to tm8_app;

alter table public.bridge_media
  add column transcript text,
  add column transcript_language text,
  add column transcript_error text,
  add column transcribed_at timestamptz;

-- A voice note's transcript, made on this host by the server's transcriber:
-- kept on the media row, and appended as one line to the log message and every
-- routed copy, so the session reading its copy and every reader of the log see
-- what was said. A failure is recorded and changes no message. Once per item:
-- a second call changes nothing and answers false. The line is cut to fit the
-- message body's 10,000-character limit (001 §7).
create or replace function internal.bridge_media_transcript(
  p_message uuid, p_idx integer, p_text text, p_language text, p_error text
) returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare bm public.bridge_media; m public.messages; v_text text; v_lang text; v_head text;
begin
  perform internal.require_bridges_worker();
  select * into bm from public.bridge_media where message_id = p_message and idx = p_idx for update;
  if bm.message_id is null then raise exception 'bridge media not found' using errcode = 'P0002'; end if;
  if bm.transcribed_at is not null then return false; end if;
  v_text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), '');
  v_lang := nullif(left(btrim(coalesce(p_language, '')), 12), '');
  update public.bridge_media
     set transcript = v_text, transcript_language = v_lang,
         transcript_error = case when v_text is null then left(coalesce(nullif(btrim(p_error), ''), 'empty'), 300) end,
         transcribed_at = now()
   where message_id = p_message and idx = p_idx;
  if v_text is null then return false; end if;
  v_head := '[voice note transcript' || coalesce(' (' || v_lang || ')', '') || ': ';
  select * into m from public.messages where entity_id = p_message;
  perform internal.bind_actor(m.author_id);
  update public.messages t
     set body = case
           when btrim(t.body) = '' then left(v_head || v_text, 9999) || ']'
           else t.body || E'\n' || left(v_head || v_text, 9998 - char_length(t.body)) || ']'
         end
    from public.entities te
   where te.id = t.entity_id and te.deleted_at is null
     and (t.entity_id = p_message or (m.message_batch_id is not null and t.message_batch_id = m.message_batch_id))
     -- room for the head, a few words and the closing bracket
     and char_length(t.body) + char_length(v_head) + 20 <= 10000;
  return true;
end
$$;
revoke all on function internal.bridge_media_transcript(uuid, integer, text, text, text) from public;
grant execute on function internal.bridge_media_transcript(uuid, integer, text, text, text) to tm8_app;

reset role;

-- -----------------------------------------------------------------------------
-- §1 and §2 (R11). 425's body verbatim except: the routed session target
--     becomes the answerer when nobody holds the answer after the directed
--     workers are named, and a re-made copy gets the files already fetched.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_inbound_deliveries(p_message uuid) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  o public.message_origins; b public.bridges; m public.messages; copy uuid; s record; routes jsonb := '[]'::jsonb;
  origin jsonb; author jsonb; target_routed boolean := false;
begin
  perform internal.require_bridges_worker();
  select * into o from public.message_origins where message_id = p_message and direction = 'in';
  if o.message_id is null or o.command_state is not null then return routes; end if;
  select * into b from public.bridges where entity_id = o.bridge_id;
  select * into m from public.messages where entity_id = p_message;
  if b.policy ->> 'direction' = 'out' then return routes; end if;
  author := case when o.external_sender_id is null then null
                 else internal.bridge_resolve_author(b.entity_id, o.external_sender_id) end;
  origin := jsonb_strip_nulls(jsonb_build_object(
    'bridgeId', b.entity_id, 'messageId', p_message, 'providerMessageId', o.external_message_id,
    'sender', jsonb_build_object(
      'participant', coalesce(author #>> '{participant,displayName}', o.sender_display),
      'memberId', case when author ->> 'kind' = 'member' then author ->> 'actorId' end),
    'command', null));
  if b.target_kind = 'work_session' and o.routed then
    select t.entity_id into copy from public.messages t
     where t.message_batch_id = m.message_batch_id and t.anchor_id = b.target_id limit 1;
    if copy is null then
      copy := internal.new_id();
      insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
      select copy, b.space_id, 'message', null, null, m.author_id, te.visibility
        from public.entities te where te.id = b.target_id and te.deleted_at is null;
      if found then
        insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body, message_batch_id)
        values (copy, b.target_id, null, m.author_id, m.body, m.message_batch_id);
        -- 442 §2: the files already fetched for the log message come along.
        if exists (select 1 from public.bridge_media bm where bm.message_id = p_message and bm.file_id is not null) then
          perform internal.bind_actor(m.author_id);
          perform internal.w1_set_writer('message_attachment');
          insert into public.edges(space_id, src_id, dst_id, type, created_by)
          select b.space_id, bm.file_id, copy, 'attached_to', m.author_id
            from public.bridge_media bm
            join public.entities fe on fe.id = bm.file_id and fe.deleted_at is null
           where bm.message_id = p_message and bm.status = 'done';
          perform internal.w1_set_writer('');
        end if;
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
        target_routed := true;
      end if;
    end if;
  end if;
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
  -- 442 §1: the session target answers what it was routed, unless a directed
  -- worker holds the answer (named above, or on an earlier delivery). Its reply
  -- to its copy (a batch twin of this log message) is then directed (399), so
  -- 406's undirected bucket never refuses it. An open answer held by a former
  -- target (one R11 replaced) passes to this one.
  if target_routed and not exists (
       select 1 from public.bridge_message_answerers a
        where a.message_id = p_message
          and not (a.status = 'open' and a.answerer_id <> b.target_id
                   and exists (select 1 from public.bridge_inbound_deliveries d
                                where d.message_id = p_message and d.session_id = a.answerer_id and d.reason = 'routed'))) then
    perform internal.bridge_try('public.set_bridge_answerer', 'uuid,uuid', p_message::text, b.target_id::text);
  end if;
  return routes;
end
$$;
revoke all on function internal.bridge_inbound_deliveries(uuid) from public;
grant execute on function internal.bridge_inbound_deliveries(uuid) to tm8_app;
