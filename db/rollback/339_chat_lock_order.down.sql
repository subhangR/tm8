-- =============================================================================
-- ROLLBACK for 339_chat_lock_order.sql — NOT a migration (db/migrate.mjs never
-- reads this directory). Run by hand, as the migration owner, only to undo 339:
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/339_chat_lock_order.down.sql
--   psql "$OWNER_URL" -c "delete from public.applied_migrations where filename = '339_chat_lock_order.sql'"
--
-- Restores 176's w2_post_message_batch (and with it the post/turn deadlock).
-- No server change depends on 339.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.w2_post_message_batch(
  p_anchor_ids uuid[], p_body text, p_parent_message_id uuid default null,
  p_mention_ids uuid[] default '{}'::uuid[], p_attachment_ids uuid[] default '{}'::uuid[],
  p_source_work_session_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null, p_chat_turn_mode text default null,
  p_source_chat_id uuid default null
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
  -- 176. A message may name at most one source, and a chat anchor queues a turn
  -- for whoever wrote it.
  source_chat public.chats; chat_anchor public.chats;
  queued_turn_id uuid; actor_kind text; queue_auth_kind text;
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
  -- ONE SOURCE PER MESSAGE, refused here rather than resolved by precedence.
  -- `edges_authored_from_source_idx` already makes one authored_from per source
  -- entity a hard rule; a batch naming two sources would either violate it or
  -- silently drop one, and "silently drop one" is how provenance becomes a
  -- guess. 42501-worthy? No: this is a malformed request, not a denied one.
  if p_source_work_session_id is not null and p_source_chat_id is not null then
    raise exception 'a message has one source: name a work session or a chat, not both'
      using errcode='22023';
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

  -- The chat analogue of the check above. A session proves provenance with a
  -- `participates_in` edge from the author; a chat's author IS its bound
  -- teammate, so the binding edge is the same proof in the shape chat has. The
  -- server never takes this id from request input — it comes off the bearer's
  -- own `runtime_chat_id` row — but the door is authorized independently, so a
  -- future caller cannot claim a chat it does not run.
  if p_source_chat_id is not null then
    select c.* into source_chat
      from public.chats c
      join public.entities e on e.id=c.entity_id
     where c.entity_id=p_source_chat_id and e.space_id=target_space and e.deleted_at is null
     for update of c;
    if source_chat.entity_id is null or source_chat.teammate_id<>actor then
      raise exception 'authored_from provenance does not match the resolved author chat'
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
    -- 176 — THE CHAT ARM. This replaces `internal.queue_chat_human_reply`
    -- (104/115/153), whose author test was the second half of the reported
    -- defect: a team_member author had no `members` row, found no turn to queue,
    -- and the message stayed inert context. Ruling R-A removes every gate that
    -- was there — no author-kind test, no auth-kind test, no cap, no per-chat
    -- wake flag — and keeps exactly one, which sessions already have:
    --
    --   A CHAT IS NEVER HANDED ITS OWN MESSAGE.
    --
    -- The guard is keyed on the SOURCE, not on the author. Keying it on the
    -- author (`actor = chat.teammate_id`) would also suppress a message the
    -- teammate wrote from a DIFFERENT chat or session, which is precisely the
    -- traffic this feature exists to carry. It is keyed on the source because
    -- the orchestrator's own `Agent turn in progress.` placeholder is posted
    -- with the chat as both anchor and source — that post is the reason the
    -- guard exists and the reason it has this shape.
    if anchor.kind='chat' and p_source_chat_id is distinct from anchor.id then
      select * into chat_anchor from public.chats where entity_id=anchor.id;
      if chat_anchor.entity_id is not null then
        select e.kind into actor_kind from public.entities e where e.id=actor;
        -- The turn's auth kind is PROVENANCE and must stay unforgeable: only the
        -- two human kinds the column admits are recorded, and an agent-authored
        -- turn records none rather than inheriting the configurer's.
        queue_auth_kind := case
          when internal.claim_text('tm8.auth_kind') in ('browser','cli')
            then internal.claim_text('tm8.auth_kind') else null end;
        insert into public.chat_turns(
          chat_id, root_message_id, user_message_id,
          requested_by_member_id, requested_by_actor_id,
          requested_by_session_id, requested_by_chat_id,
          requested_by_auth_kind, mode, pricing_provider, pricing_model, queued_at
        ) values (
          chat_anchor.entity_id, null, message_id,
          case when actor_kind='member' then actor else null end, actor,
          p_source_work_session_id, p_source_chat_id,
          queue_auth_kind, coalesce(turn_mode, chat_anchor.chat_mode),
          chat_anchor.provider, chat_anchor.model, now()
        ) returning turn_id into queued_turn_id;
        delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
          'kind','chat_turn','messageId',message_id,
          'chatId',chat_anchor.entity_id,'turnId',queued_turn_id));
      end if;
    end if;
  end loop;

  if p_source_work_session_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_work_session_id,'authored_from',actor
        from unnest(message_ids) item(id);
    perform internal.w1_set_writer('');
  end if;
  -- 176: the same provenance write, to a chat. Without it a reply to a chat
  -- agent's post has nothing to resolve and 168's `recorded_only` fallback is
  -- the best a chat could get.
  if p_source_chat_id is not null then
    perform internal.w1_set_writer('message_recorder');
    insert into public.edges(space_id,src_id,dst_id,type,created_by)
      select target_space,id,p_source_chat_id,'authored_from',actor
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
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text, uuid) from public;
grant execute on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text, uuid) to tm8_app;

reset role;
