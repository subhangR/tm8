-- A TASK'S THREAD WAKES THE TASK'S LIVE SESSIONS.
--
-- THE DEFECT. 072/076 compute a message's live-delivery targets as "anchors of
-- the batch that are work_sessions" plus "the session that authored the parent
-- of a reply". A message anchored on a TASK matched neither, so it produced
-- ZERO session deliveries — while the worker system prompt orders agents to
-- report milestones "on the assignment anchor", which IS a task. Measured over
-- three days on a live node (2026-08-07): every agent-authored task-anchored
-- message had zero delivery rows; every work_session-anchored one had one. 077
-- routed task-anchor reports to human watchers, but no agent session ever woke
-- from one. One agent visibly learned the workaround in production: it posted
-- the same review twice, once on the task (heard by nobody) and once on the
-- counterpart's session (answered within a minute). The system prompt's core
-- claim — "a message on the anchor is how work becomes visible" — was false
-- between agents, and the agents that trusted it worked in silence.
--
-- THE RULE. A message copy anchored on a task owes a live copy to every
-- NON-DEAD work session attached to that task by the graph:
--
--   working_on  (work_session -> task)  the sessions working it, and
--   created_in  (task -> work_session)  the session that created it — for a
--                                       delegated task, the coordinator.
--
-- "Non-dead" mirrors `reserve_session_message_delivery`'s own liveness rule
-- (`status not in ('exited','failed')`) rather than pinning `'running'`, so a
-- future legal status does not silently re-open the hole. The author's own
-- session is excluded twice already — the dispatch loop skips
-- `target = source` and the reservation RPC refuses self-contact — and human
-- authors have no source session, which means a member's message on a task now
-- reaches the agents working that task. That last consequence is not a side
-- effect, it is half the point.
--
-- Threaded replies on a task thread fan out the same way: a task thread is the
-- task's conversation, and everyone attached to the task hears it. The reply
-- target of every copy stays the task with the copy as parent, so answering
-- keeps the thread in one place — same stability argument as 076.

create or replace function public.w2_record_session_message_routes(
  p_message_ids uuid[],
  p_conversation_anchor_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
-- `author_id` is BOTH a local below and a real column of public.messages, and
-- the batch guard compares them in one predicate over that table. Without this
-- option that reference is ambiguous and every call dies with SQLSTATE 42702 —
-- which is every messages.post. See 072 and the repair in PR #8.
#variable_conflict use_variable
declare
  message_count integer;
  batch_id text;
  author_id uuid;
  message_space uuid;
  source_message_id uuid;
  source_anchor_kind text;
  has_session_conversation boolean;
  route_row record;
  result jsonb := '[]'::jsonb;
begin
  if cardinality(coalesce(p_message_ids, '{}'::uuid[])) < 1 then
    raise exception 'message route recording requires a message batch' using errcode = '22023';
  end if;
  if cardinality(p_message_ids) <> cardinality(array(select distinct unnest(p_message_ids))) then
    raise exception 'message route ids must be unique' using errcode = '22023';
  end if;

  select m.message_batch_id, m.author_id, e.space_id into batch_id, author_id, message_space
    from public.messages m join public.entities e on e.id = m.entity_id
   where m.entity_id = p_message_ids[1];
  select count(*) into message_count
    from public.messages m
   where m.entity_id = any(p_message_ids);
  if message_count <> cardinality(p_message_ids)
     or exists (
       select 1 from public.messages m
        where m.entity_id = any(p_message_ids)
          and (m.message_batch_id is distinct from batch_id or m.author_id is distinct from author_id)
     )
     or author_id is distinct from coalesce(internal.actor_id(), internal.current_member_id(message_space)) then
    raise exception 'message route batch does not match the current authored command' using errcode = '42501';
  end if;

  -- DOES THIS BATCH OWE ANYONE A LIVE COPY? 072 asked "is any anchor a
  -- work_session"; 076 added "does a reply answer a session-authored parent";
  -- 079 adds "is any anchor a task with a non-dead attached session". The
  -- guard is still needed: a batch that owes nothing must return an empty set
  -- rather than fall through to conversation-anchor resolution, which raises
  -- on a multi-anchor batch with no conversationAnchorId.
  has_session_conversation :=
    exists (
      select 1 from public.messages m join public.entities e on e.id = m.anchor_id
       where m.entity_id = any(p_message_ids) and e.kind = 'work_session'
    )
    or exists (
      select 1
        from public.messages m
        join public.entities me on me.id = m.entity_id
        join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
       where m.entity_id = any(p_message_ids) and me.parent_id is not null
    );
  if not has_session_conversation
     and not exists (
       select 1
         from public.messages m
         join public.entities anchor
           on anchor.id = m.anchor_id and anchor.deleted_at is null and anchor.kind = 'task'
         join public.edges lnk
           on (lnk.type = 'working_on' and lnk.dst_id = m.anchor_id)
           or (lnk.type = 'created_in' and lnk.src_id = m.anchor_id)
         join public.work_sessions ws
           on ws.entity_id = case when lnk.type = 'working_on' then lnk.src_id else lnk.dst_id end
          and ws.status not in ('exited','failed')
        where m.entity_id = any(p_message_ids)
     )
  then
    return result;
  end if;

  -- Conversation-anchor resolution exists for session conversations (the DM
  -- home and the reply thread). A batch that owes copies ONLY through a task
  -- anchor has no session conversation to resolve — and resolving one anyway
  -- would newly reject multi-anchor task sends that 076 accepted (by returning
  -- early). The guard set here is EXACTLY 076's pass-through set, so every
  -- batch shape that reached this code before behaves byte-for-byte the same.
  if has_session_conversation then
    if p_conversation_anchor_id is null then
      if cardinality(p_message_ids) <> 1 then
        raise exception 'multi-anchor session delivery requires conversationAnchorId' using errcode = '22023';
      end if;
      select m.anchor_id into p_conversation_anchor_id
        from public.messages m where m.entity_id = p_message_ids[1];
    end if;

    select m.entity_id, e.kind into source_message_id, source_anchor_kind
      from public.messages m
      join public.entities e on e.id = m.anchor_id and e.deleted_at is null
     where m.entity_id = any(p_message_ids)
       and m.anchor_id = p_conversation_anchor_id;
    if source_message_id is null then
      raise exception 'conversationAnchorId must identify one message-batch anchor' using errcode = '22023';
    end if;
  end if;

  for route_row in
    -- ANCHOR TARGETS: 072's rule, byte-for-byte in meaning. The copy's own
    -- anchor is a session, so that session receives it, and a reply to it goes
    -- back to the conversation the batch named.
    with anchor_targets as (
      select m.entity_id               as target_message_id,
             m.anchor_id               as target_work_session_id,
             p_conversation_anchor_id  as src_anchor_id,
             source_message_id         as src_message_id
        from public.messages m
        join public.entities anchor on anchor.id = m.anchor_id
       where m.entity_id = any(p_message_ids) and anchor.kind = 'work_session'
    ),
    -- REPLY TARGETS: the session that authored the message this copy answers.
    -- `src_anchor_id` is the copy's OWN anchor — the thread's home — and
    -- `src_message_id` is the copy itself, so the recipient's reply resolves
    -- back to the same anchor with this copy as its parent. That is exactly
    -- what `reply anchor must equal parent anchor` demands, which is what makes
    -- the exchange stable for any number of rounds rather than only the first.
    reply_targets as (
      select m.entity_id    as target_message_id,
             origin.dst_id  as target_work_session_id,
             m.anchor_id    as src_anchor_id,
             m.entity_id    as src_message_id
        from public.messages m
        join public.entities me on me.id = m.entity_id
        join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
        join public.work_sessions ws on ws.entity_id = origin.dst_id
       where m.entity_id = any(p_message_ids) and me.parent_id is not null
    ),
    -- TASK TARGETS (079): every non-dead session the graph attaches to a task
    -- anchor, keyed to the copy itself so a reply resolves to the task thread
    -- with this copy as parent. A session that is ITSELF an anchor of this
    -- batch is excluded — its copy is already the anchor target of a different
    -- message row, and this copy targeting it too would double-inject the same
    -- batch into one terminal. When a session is reached by both the reply rule
    -- and the task rule the two rows are identical in all four columns and the
    -- union collapses them.
    task_targets as (
      select m.entity_id         as target_message_id,
             listener.session_id as target_work_session_id,
             m.anchor_id         as src_anchor_id,
             m.entity_id         as src_message_id
        from public.messages m
        join public.entities anchor
          on anchor.id = m.anchor_id and anchor.deleted_at is null and anchor.kind = 'task'
        join lateral (
          select w.src_id as session_id
            from public.edges w
           where w.type = 'working_on' and w.dst_id = m.anchor_id
          union
          select c.dst_id
            from public.edges c
           where c.type = 'created_in' and c.src_id = m.anchor_id
        ) listener on true
        join public.work_sessions ws
          on ws.entity_id = listener.session_id
         and ws.status not in ('exited','failed')
       where m.entity_id = any(p_message_ids)
         and not exists (
           select 1 from public.messages sibling
            where sibling.entity_id = any(p_message_ids)
              and sibling.anchor_id = listener.session_id
         )
    )
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from anchor_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from reply_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from task_targets
  loop
    insert into public.session_message_reply_routes(
      target_message_id, target_work_session_id, source_anchor_id,
      source_message_id, addressing_kind
    ) values (
      route_row.target_message_id,
      route_row.target_work_session_id,
      route_row.src_anchor_id,
      route_row.src_message_id,
      internal.w2_addressing_kind(route_row.src_anchor_id, route_row.target_work_session_id)
    )
    on conflict (target_message_id, target_work_session_id) do update
      set target_message_id = excluded.target_message_id
      where session_message_reply_routes.source_anchor_id = excluded.source_anchor_id
        and session_message_reply_routes.source_message_id = excluded.source_message_id
        and session_message_reply_routes.addressing_kind = excluded.addressing_kind;
    if not found then
      raise exception 'message reply route conflicts with its recorded origin' using errcode = '23514';
    end if;

    result := result || jsonb_build_array(jsonb_build_object(
      'targetMessageId', route_row.target_message_id,
      'targetWorkSessionId', route_row.target_work_session_id,
      'messageBatchId', batch_id,
      'senderActorId', author_id,
      'senderActorKind', (select e.kind from public.entities e where e.id = author_id),
      'sourceAnchorId', route_row.src_anchor_id,
      'sourceAnchorKind', (select e.kind from public.entities e where e.id = route_row.src_anchor_id),
      'sourceMessageId', route_row.src_message_id,
      'threadParentMessageId', (select e.parent_id from public.entities e where e.id = route_row.src_message_id),
      'threadRootMessageId', (select coalesce(m.root_message_id, m.entity_id)
        from public.messages m where m.entity_id = route_row.src_message_id),
      'body', (select m.body from public.messages m where m.entity_id = route_row.target_message_id),
      'contextAnchors', (
        select coalesce(jsonb_agg(jsonb_build_object('id', sibling.anchor_id, 'kind', sibling_anchor.kind)
          order by sibling.anchor_id), '[]'::jsonb)
          from public.messages sibling
          join public.entities sibling_anchor on sibling_anchor.id = sibling.anchor_id
         where sibling.entity_id = any(p_message_ids)
           and sibling.anchor_id <> route_row.src_anchor_id
           and sibling.anchor_id <> route_row.target_work_session_id
      ),
      -- Read for the TARGET session. A reply target is not the copy's anchor,
      -- so a policy read keyed on the anchor would apply the wrong session's
      -- budget and injection allowlist to it.
      'rollingControlMaxBytes', coalesce((
        select (pin.resolved_snapshot #>> '{agentProjection,promptPolicy,rollingControlMaxBytes}')::integer
          from public.work_session_interaction_pins pin
         where pin.work_session_id = route_row.target_work_session_id
         order by pin.pin_revision desc limit 1
      ), 16384),
      'sessionInputAllowed', coalesce((
        select case
          when jsonb_array_length(coalesce(
            pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}', '[]'::jsonb
          )) = 0 then true
          else coalesce(
            (pin.resolved_snapshot #> '{agentProjection,promptPolicy,allowedInjectionKinds}')
              ? 'tm8.session-input',
            false
          )
        end
          from public.work_session_interaction_pins pin
         where pin.work_session_id = route_row.target_work_session_id
         order by pin.pin_revision desc limit 1
      ), true),
      'addressingKind',
        internal.w2_addressing_kind(route_row.src_anchor_id, route_row.target_work_session_id)
    ));
  end loop;
  return result;
end
$$;
