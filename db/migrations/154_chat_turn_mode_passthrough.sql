-- =============================================================================
-- 154  MESSAGES.POST CARRIES THE PER-TURN CHAT MODE (shape A, step 2).
--
-- Migration 153 added messages.requested_chat_mode and made the enqueue trigger
-- copy it onto chat_turns.mode; #395 made the runtime honour the effective mode.
-- This is the missing piece: getting the mode a human chose at send time ONTO
-- the message, so it flows message → chat_turns.mode → the turn envelope.
--
-- MECHANISM: an explicit parameter on w2_post_message_batch. The first cut of
-- this rode a transaction-local `tm8.chat_turn_mode` setting read by a BEFORE
-- INSERT trigger — but the mode is NOT a claim (it gates no authorization; it is
-- a per-turn UI preference), and putting a non-claim in the tm8.* claims
-- namespace tripped the one-identity-path guard by design. A value that flows
-- from client input to a DB write belongs in a scoped, auditable argument, not
-- in transaction-global settings state. So the mode is a real parameter here.
--
-- w2_post_message_batch is 019's body VERBATIM save two lines: the new
-- `p_chat_turn_mode` parameter (defaulted, so every existing 8-arg caller is
-- unchanged), and the one message INSERT that now also writes
-- requested_chat_mode. The 153 enqueue trigger and the claim RPC are untouched.
-- The old 8-arg overload is dropped so a single definition remains.
-- =============================================================================

drop function if exists public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text);

create or replace function public.w2_post_message_batch(
  p_anchor_ids uuid[], p_body text, p_parent_message_id uuid default null,
  p_mention_ids uuid[] default '{}'::uuid[], p_attachment_ids uuid[] default '{}'::uuid[],
  p_source_work_session_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null, p_chat_turn_mode text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; anchors uuid[]; mentions uuid[]; files uuid[]; anchor_count integer;
  first_anchor public.entities; anchor public.entities; parent public.messages;
  parent_envelope public.entities; target_space uuid; actor uuid; thread_root uuid;
  mention_json jsonb; attachment_json jsonb; message_ids uuid[]:='{}'::uuid[];
  message_id uuid; stable_hash text; replay_hash text; replay_author uuid; replay_space uuid;
  delivery_intents jsonb:='[]'::jsonb; require_space_files boolean:=false; result jsonb;
  turn_mode text;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id)='' then
    raise exception 'clientMutationId is required' using errcode='22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 10000 then
    raise exception 'message body must contain 1..10000 characters' using errcode='22023';
  end if;
  -- The per-turn chat mode. NULL is legal and means "no request" (the thread
  -- default resolves at claim time). A non-NULL value that is NOT one of the six
  -- modes FAILS LOUD, exactly like the clientMutationId and body guards above —
  -- so a seventh mode added to the ChatMode enum and the composer but missed in
  -- this list surfaces as an error instead of every send silently falling back
  -- to the thread default. Only meaningful for a chat-thread anchor; harmless
  -- (but still validated) on any other message.
  if p_chat_turn_mode is not null
     and p_chat_turn_mode not in ('ask','explain','plan','build','orchestrate','craft') then
    raise exception 'unknown chat turn mode: %', p_chat_turn_mode using errcode='22023';
  end if;
  turn_mode := p_chat_turn_mode;
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into anchors
    from unnest(coalesce(p_anchor_ids,'{}'::uuid[])) item(value);
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into mentions
    from unnest(coalesce(p_mention_ids,'{}'::uuid[])) item(value);
  select coalesce(array_agg(value order by value),'{}'::uuid[]) into files
    from unnest(coalesce(p_attachment_ids,'{}'::uuid[])) item(value);
  anchor_count:=cardinality(anchors);
  if anchor_count not between 1 and 16 or anchor_count<>cardinality(coalesce(p_anchor_ids,'{}'::uuid[]))
     or cardinality(mentions)>16 or cardinality(mentions)<>cardinality(coalesce(p_mention_ids,'{}'::uuid[]))
     or cardinality(files)>16 or cardinality(files)<>cardinality(coalesce(p_attachment_ids,'{}'::uuid[])) then
    raise exception 'message batch requires bounded unique anchors, mentions, and files' using errcode='22023';
  end if;
  if anchor_count*cardinality(files)>64 then
    raise exception 'anchor by attachment pair limit exceeded' using errcode='54000';
  end if;
  if octet_length(convert_to(jsonb_build_object(
      'anchorIds',anchors,'body',p_body,'parentMessageId',p_parent_message_id,
      'mentionIds',mentions,'attachmentIds',files,'actorId',p_actor_id
    )::text,'UTF8'))>262144 then
    raise exception 'canonical message request exceeds 256 KiB' using errcode='54000';
  end if;

  replay:=internal.ledger_replay(p_client_mutation_id,'messages.post');
  if replay is not null then
    replay_author:=nullif(replay#>>'{_audit,authorId}','')::uuid;
    replay_space:=nullif(replay#>>'{_audit,spaceId}','')::uuid;
    replay_hash:=internal.w2_message_batch_hash(
      internal.identity_id(),p_actor_id,replay_author,replay_space,
      anchors,p_body,p_parent_message_id,mentions,files);
    if replay_hash is distinct from replay->>'_stableHash' then
      raise exception 'message batch identity mismatch' using errcode='23514',
        detail='message_batch_identity_mismatch';
    end if;
    return replay;
  end if;

  perform 1 from public.entities e where e.id=any(anchors) order by e.id for update;
  if (select count(*) from public.entities e
       where e.id=any(anchors) and e.deleted_at is null and internal.entity_readable(e.id))<>anchor_count then
    raise exception 'message anchor not found' using errcode='P0002';
  end if;
  select * into first_anchor from public.entities where id=anchors[1];
  target_space:=first_anchor.space_id;
  if exists(select 1 from public.entities e where e.id=any(anchors) and e.space_id<>target_space) then
    raise exception 'message anchors must share one Space' using errcode='23514';
  end if;
  require_space_files:=exists(select 1 from public.entities e where e.id=any(anchors) and e.visibility='space');
  perform internal.require_space_member(target_space);
  actor:=internal.resolve_actor(p_actor_id,target_space);
  perform internal.bind_actor(actor);

  if p_parent_message_id is not null then
    if anchor_count<>1 then raise exception 'a reply has exactly one anchor' using errcode='22023'; end if;
    perform 1 from public.entities where id=p_parent_message_id for update;
    select * into parent from public.messages where entity_id=p_parent_message_id;
    select * into parent_envelope from public.entities where id=p_parent_message_id;
    if parent.entity_id is null or not internal.entity_readable(parent.entity_id) then
      raise exception 'parent message not found' using errcode='P0002';
    end if;
    if parent.anchor_id<>anchors[1] then
      raise exception 'reply anchor must equal parent anchor' using errcode='23514';
    end if;
    thread_root:=coalesce(parent.root_message_id,parent.entity_id);
  end if;

  perform 1 from public.entities e where e.id=any(files) order by e.id for update;
  mention_json:=internal.w2_resolve_mentions(mentions,target_space);
  attachment_json:=internal.w2_validate_attachment_files(files,target_space,require_space_files);

  if p_source_work_session_id is not null then
    perform 1 from public.entities e join public.work_sessions ws on ws.entity_id=e.id
     where e.id=p_source_work_session_id and e.space_id=target_space and e.deleted_at is null
       and exists(select 1 from public.edges edge where edge.src_id=actor
                   and edge.dst_id=p_source_work_session_id and edge.type='participates_in')
     for update;
    if not found then
      raise exception 'authored_from provenance does not match the resolved author session'
        using errcode='42501';
    end if;
  end if;

  stable_hash:=internal.w2_message_batch_hash(
    internal.identity_id(),p_actor_id,actor,target_space,
    anchors,p_body,p_parent_message_id,mentions,files);

  foreach message_id in array anchors loop
    select * into anchor from public.entities where id=message_id;
    message_id:=internal.new_id();
    insert into public.entities(id,space_id,kind,parent_id,position,created_by,visibility)
    values(message_id,target_space,'message',p_parent_message_id,null,actor,anchor.visibility);
    insert into public.messages(
      entity_id,anchor_id,root_message_id,author_id,body,mentions,attachments,
      client_msg_id,message_batch_id,requested_chat_mode
    ) values(
      message_id,anchor.id,thread_root,actor,p_body,mention_json,attachment_json,null,p_client_mutation_id,turn_mode
    );
    message_ids:=array_append(message_ids,message_id);
    if anchor.kind='work_session' then
      delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
        'messageId',message_id,'targetWorkSessionId',anchor.id,
        'content',p_body,'mode','send'));
    end if;
  end loop;

  if p_source_work_session_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_work_session_id,'authored_from',actor
        from unnest(message_ids) item(id);
    perform internal.w1_set_writer('');
  end if;
  if cardinality(files)>0 then
    perform internal.w1_set_writer('message_attachment');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,file_id,message_ref,'attached_to',actor
        from unnest(files) f(file_id) cross join unnest(message_ids) m(message_ref);
    perform internal.w1_set_writer('');
  end if;

  if parent.entity_id is not null then
    perform internal.w2_notify_actor(
      target_space,parent.author_id,'message_reply',parent.anchor_id,actor,
      jsonb_build_object('messageId',message_ids[1],'parentMessageId',parent.entity_id,
                         'anchorId',parent.anchor_id));
  end if;

  result:=jsonb_build_object(
    'messageBatchId',p_client_mutation_id,
    'messageIds',to_jsonb(message_ids),
    'deliveryIntents',delivery_intents,
    '_stableHash',stable_hash,
    '_audit',jsonb_build_object('authorId',actor,'spaceId',target_space)
  );
  return internal.ledger_record(p_client_mutation_id,'messages.post',result);
end
$$;

revoke all on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text) from public;
grant execute on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text) to tm8_app;
