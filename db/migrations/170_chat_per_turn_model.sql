-- =============================================================================
-- 170  A CHAT TURN CARRIES THE MODEL IT WAS SENT WITH (per-turn model choice).
--
-- THE DEFECT. `chat_threads.model` is write-once (104): it is chosen in the
-- composer before the first send and then fixed for the life of the thread. The
-- composer's model drop-up disables itself the moment the thread is configured,
-- because a control that changed nothing would be worse than a disabled one. So
-- the only way to answer "use a different model" today is to abandon the
-- conversation and start another one, which throws away the context that made
-- the question worth asking.
--
-- THE SHAPE IS NOT NEW. This is 153/154 for the model instead of the mode, and
-- deliberately identical to it line for line, because the two facts have the
-- same lifetime and the same carrier:
--
--   1. public.messages gains a nullable `requested_model` (this file).
--   2. w2_post_message_batch passes an optional model through to it (this file
--      — unlike 153, the passthrough is NOT deferred to a companion change;
--      shipping the column without it would leave a picker that writes nowhere).
--   3. the enqueue trigger copies messages.requested_model onto
--      chat_turns.model, and the turn's PRICING model follows the override
--      rather than the thread default (this file).
--   4. claim_next_chat_turn resolves the effective model as
--      coalesce(turn.model, thread.model) and also returns the raw per-turn
--      choice for the read projection (this file).
--
-- The thread's model stays the write-once DEFAULT it always was. A turn may
-- override it; the binding is never rewritten.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT VALIDATE. It does not check the model
-- against a list. Two reasons, and both are load-bearing:
--
--   · `agent_tool`, `provider` and `model` are free text everywhere else in this
--     schema — the only constraint any of them carries is a length check. A
--     model enum in the database would be the exact staleness the model-catalog
--     work exists to remove: a provider ships a model and the fix is a
--     migration. 153 could afford an enum because the six chat modes are OUR
--     vocabulary; model ids are somebody else's.
--   · The one rule that DOES apply — chat runs claude-code models only, so an
--     override must be a model this node's catalog knows and that launches
--     under claude-code — needs the launch catalog to evaluate, and the catalog
--     lives in @tm8/contract, not in Postgres. The server refuses a bad
--     override at messages.post with a sentence naming the reason, which is the
--     same guard `chat.threads.start` already applies to the thread's first
--     model. This file enforces only what it can see: a bounded, non-empty
--     string.
--
-- PRICING FOLLOWS THE OVERRIDE; PROVIDER DOES NOT NEED TO. `chat_turns` records
-- `pricing_provider`/`pricing_model` at enqueue so a turn's cost is priced
-- against what it actually ran on, and the model half must therefore track the
-- override. The provider half does not move, and that is correct rather than an
-- omission: the accepted overrides all launch under claude-code, and every
-- claude-code entry in the launch catalog is `anthropic`. If chat ever accepts a
-- second agent tool, this line is one of the places that has to be revisited,
-- which is why it is called out here rather than left to be discovered.
-- =============================================================================

-- 1. The carrier on the message. Nullable: an omitted model means "use the
--    thread default", which is every message posted before this migration and
--    every client that does not send one.
alter table public.messages
  add column requested_model text
  check (requested_model is null
         or char_length(btrim(requested_model)) between 1 and 100);

comment on column public.messages.requested_model is
  'Optional per-turn model chosen at send time. NULL ⇒ the thread default '
  '(chat_threads.model). Consumed by the chat enqueue trigger; ignored for '
  'non-chat messages. Not validated against a catalog here — see 170.';

-- 2. The per-turn model on the queue row. Nullable for the same reason, and the
--    thread model remains the write-once default it always was.
alter table public.chat_turns
  add column model text
  check (model is null or char_length(btrim(model)) between 1 and 100);

comment on column public.chat_turns.model is
  'The model this specific turn runs under, copied from the sending message. '
  'NULL ⇒ resolve to the thread default at claim time.';

-- 3. The enqueue trigger: 153''s body VERBATIM plus one column and one
--    coalesce. The requested model travels from the message row onto the turn
--    it queues exactly as the requested mode already does, and the turn's
--    pricing model is the model it will actually run on.
create or replace function internal.queue_chat_human_reply() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  binding public.chat_threads;
  author_member public.members;
  auth_kind text;
begin
  if new.root_message_id is null then return new; end if;
  select * into binding from public.chat_threads where root_message_id = new.root_message_id;
  if binding.root_message_id is null then return new; end if;
  select * into author_member from public.members
   where entity_id = new.author_id and space_id = binding.space_id;
  if author_member.entity_id is null then return new; end if;
  auth_kind := internal.claim_text('tm8.auth_kind');
  if auth_kind not in ('browser', 'cli') then return new; end if;
  insert into public.chat_turns(
    root_message_id, user_message_id, requested_by_member_id, requested_by_auth_kind,
    mode, model, pricing_provider, pricing_model, queued_at
  ) values (
    binding.root_message_id, new.entity_id, author_member.entity_id, auth_kind,
    new.requested_chat_mode, new.requested_model, binding.provider,
    coalesce(new.requested_model, binding.model), new.created_at
  ) on conflict (user_message_id) do nothing;
  return new;
end
$$;

-- 4. The claim projection: 153''s body verbatim, with two changes to the
--    returned object — `model` now resolves the per-turn override against the
--    thread default, and the raw per-turn choice is exposed for the read model.
--    `provider` and `agentTool` stay the thread's; see the header.
create or replace function public.claim_next_chat_turn(p_root_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  binding public.chat_threads;
  turn_row public.chat_turns;
  user_message public.messages;
  requester public.members;
begin
  perform internal.require_identity();
  select * into binding from public.chat_threads
   where root_message_id = p_root_message_id for update;
  if binding.root_message_id is null or binding.configured_by_identity_id <> internal.identity_id() then
    raise exception 'chat thread not found for this identity' using errcode = 'P0002';
  end if;
  select * into turn_row from public.chat_turns
   where root_message_id = p_root_message_id
     and (state = 'queued' or (state = 'running' and lease_expires_at < now()))
   order by queued_at, user_message_id for update skip locked limit 1;
  if turn_row.turn_id is null then return null; end if;
  update public.chat_turns
     set state = 'running', attempt_no = attempt_no + 1,
         started_at = coalesce(started_at, now()), lease_expires_at = now() + interval '10 minutes',
         updated_at = now()
   where turn_id = turn_row.turn_id returning * into turn_row;
  select * into user_message from public.messages where entity_id = turn_row.user_message_id;
  select * into requester from public.members
   where entity_id = coalesce(turn_row.requested_by_member_id, binding.configured_by_member_id);
  return jsonb_build_object(
    'turnId', turn_row.turn_id,
    'rootMessageId', binding.root_message_id,
    'spaceId', binding.space_id,
    'userMessageId', turn_row.user_message_id,
    'agentMessageId', turn_row.agent_message_id,
    'body', user_message.body,
    'attachments', coalesce(user_message.attachments, '[]'::jsonb),
    'anchorId', binding.anchor_id,
    'requesterIdentityId', binding.configured_by_identity_id,
    'requesterAuthKind', binding.requester_auth_kind,
    'requestedByMemberId', requester.entity_id,
    'requestedByIdentityId', requester.identity_id,
    'requestedByAuthKind', case
      when turn_row.requested_by_auth_kind is not null then turn_row.requested_by_auth_kind
      when requester.entity_id = binding.configured_by_member_id then binding.requester_auth_kind
      else null
    end,
    'requestedByDisplayName', requester.display_name,
    'teammateId', binding.teammate_id,
    -- The effective model this turn runs on: the per-turn override if the
    -- sender chose one, else the thread's write-once default.
    'model', coalesce(turn_row.model, binding.model),
    -- The raw per-turn choice (NULL ⇒ inherited), for the turn read model.
    'requestedModel', turn_row.model,
    'provider', binding.provider,
    'agentTool', binding.agent_tool,
    'chatMode', coalesce(turn_row.mode, binding.chat_mode),
    'mode', turn_row.mode,
    'nativeSessionId', binding.native_session_id,
    'cwd', binding.cwd,
    'runtimeState', binding.runtime_state,
    'nextSeq', case when turn_row.agent_message_id is null then 0 else
      (select coalesce(max(seq) + 1, 0) from public.message_parts
        where message_id = turn_row.agent_message_id) end
  );
end
$$;

-- 5. messages.post carries the per-turn model. 154''s body VERBATIM save two
--    lines: the new `p_chat_turn_model` parameter (defaulted, so every existing
--    9-arg caller is unchanged), and the one message INSERT that now also
--    writes requested_model. The old 9-arg overload is dropped so a single
--    definition remains, exactly as 154 dropped 019''s 8-arg one.
drop function if exists public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text);

create or replace function public.w2_post_message_batch(
  p_anchor_ids uuid[], p_body text, p_parent_message_id uuid default null,
  p_mention_ids uuid[] default '{}'::uuid[], p_attachment_ids uuid[] default '{}'::uuid[],
  p_source_work_session_id uuid default null, p_actor_id uuid default null,
  p_client_mutation_id text default null, p_chat_turn_mode text default null,
  p_chat_turn_model text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; anchors uuid[]; mentions uuid[]; files uuid[]; anchor_count integer;
  first_anchor public.entities; anchor public.entities; parent public.messages;
  parent_envelope public.entities; target_space uuid; actor uuid; thread_root uuid;
  mention_json jsonb; attachment_json jsonb; message_ids uuid[]:='{}'::uuid[];
  message_id uuid; stable_hash text; replay_hash text; replay_author uuid; replay_space uuid;
  delivery_intents jsonb:='[]'::jsonb; require_space_files boolean:=false; result jsonb;
  turn_mode text; turn_model text;
begin
  if p_client_mutation_id is null or btrim(p_client_mutation_id)='' then
    raise exception 'clientMutationId is required' using errcode='22023';
  end if;
  if p_body is null or char_length(p_body) not between 1 and 10000 then
    raise exception 'message body must contain 1..10000 characters' using errcode='22023';
  end if;
  if p_chat_turn_mode is not null
     and p_chat_turn_mode not in ('ask','explain','plan','build','orchestrate','craft') then
    raise exception 'unknown chat turn mode: %', p_chat_turn_mode using errcode='22023';
  end if;
  -- The per-turn model. NULL is legal and means "no request" (the thread
  -- default resolves at claim time). Unlike the mode above there is no list to
  -- check it against — model ids are the provider's vocabulary, not ours (170
  -- header) — so the guard is the shape the column accepts, and an empty or
  -- oversized string fails loud here rather than silently becoming a NULL that
  -- looks like "the sender did not ask".
  if p_chat_turn_model is not null
     and char_length(btrim(p_chat_turn_model)) not between 1 and 100 then
    raise exception 'chat turn model must contain 1..100 characters' using errcode='22023';
  end if;
  turn_mode := p_chat_turn_mode;
  turn_model := btrim(p_chat_turn_model);
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
      client_msg_id,message_batch_id,requested_chat_mode,requested_model
    ) values(
      message_id,anchor.id,thread_root,actor,p_body,mention_json,attachment_json,null,
      p_client_mutation_id,turn_mode,nullif(turn_model,'')
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

revoke all on function public.claim_next_chat_turn(uuid) from public;
grant execute on function public.claim_next_chat_turn(uuid) to tm8_app;

revoke all on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text, text) from public;
grant execute on function public.w2_post_message_batch(
  uuid[], text, uuid, uuid[], uuid[], uuid, uuid, text, text, text) to tm8_app;
