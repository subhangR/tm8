-- =============================================================================
-- 121  A MESSAGE ON A TASK NOW WAKES THE SESSIONS WORKING THAT TASK.
--
-- THE DEFECT, measured on the applied chain. `w2_record_session_message_routes`
-- (072, redefined by 076 and again by 099) has exactly three target classes:
--
--     ANCHOR   the copy's own anchor, when that anchor IS a work_session
--     REPLY    authored_from(parent) -- the session being answered
--     MENTION  session ids the caller names explicitly (099's @tag poke)
--
-- A message anchored on a TASK matches none of them. It falls through the
-- "DOES THIS BATCH OWE ANYONE A LIVE COPY?" guard and the function returns `[]`
-- before it writes a single route. So `tm8 message send --to <task-id>` -- the
-- gesture every agent prompt tells agents to use to report a milestone, a
-- result or a blocker on their assignment -- is DURABLE AND SILENT: the row is
-- in the graph, the anchor's counters move, and no session working that task
-- ever learns it happened. The only way to reach a peer was to already know its
-- work_session id and poke it directly, which means the task -- the one id
-- everyone involved shares -- was the one address that did not route.
--
-- THE FOURTH CLASS.
--
--     TASK     work_sessions with a `working_on` edge to the message's task
--              anchor, delivered THAT anchor's copy
--
-- `working_on` is the right edge and `assigned_to` is not: 111's header draws
-- the line and this migration keeps it. `assigned_to` hangs off a Teammate and
-- means "this PERSON owns it"; `working_on` hangs off a work_session and means
-- "this PROCESS is on it". A wake has to reach a process, so it follows the
-- edge that names one. An assignee with no live session is unreachable by
-- definition and gets the ordinary inbox notification it already got.
--
-- src is (the task, the message anchored on it), so a woken session's reply
-- resolves back to the task and the conversation stays where the work is --
-- the same stability argument 076 makes for reply targets and 099 for pokes.
-- `internal.w2_addressing_kind` already answers `anchored_message` for a task
-- anchor, which is an existing value of the route table's check constraint and
-- of the contract's addressingKind union. Nothing downstream is new: the routes
-- this returns are dispatched by the same `dispatchSessionMessages` loop, over
-- the same reserve/claim/settle RPCs, as every other session copy. There is no
-- TypeScript change in this migration's blast radius.
--
-- FOUR NARROWINGS, EACH ONE LOAD-BEARING.
--
--   1. LIVE SESSIONS ONLY (`spawning`/`running`/`idle`). The mention class
--      deliberately admits idle-but-not-terminal targets and leaves PTY
--      liveness to the delivery layer; a task fan-out cannot copy that. A task
--      of any age has accumulated every session that ever touched it, so an
--      unfiltered edge walk would reserve a delivery per DEAD session on every
--      message, each one settling `failed_permanent`/`session_not_live` and
--      each one raising an inbox fallback. Same terminal-status set the wake
--      budget's own cleanup sweep uses (015:2055).
--   2. NOT THE AUTHOR'S OWN SESSION. Unlike every existing class, self-hit here
--      is the COMMON case, not the corner: an agent reporting on the task it is
--      working on is `working_on` that task. `message-dispatch.ts` would skip
--      the delivery, but the route row would still be written and would still
--      occupy the (target_message_id, target_work_session_id) primary key. So
--      the authoring session is excluded in SQL, by its own `authored_from`
--      edge, and no row is written at all.
--   3. ONLY WHEN NO OTHER CLASS ALREADY OWES THAT SESSION A COPY. Prevents one
--      batch waking one session twice -- e.g. a reply on a task whose parent
--      was authored by a session that is also working that task. The union
--      already dedupes IDENTICAL rows; this handles the case where the two
--      classes agree on the session but differ on the source, which the union
--      cannot collapse and the primary key would reject as a conflicting
--      origin (23514).
--   4. SAME SPACE, NOT DELETED. Same test the mention class applies.
--
-- THE CONVERSATION ANCHOR IS NOW RESOLVED ONLY WHEN A CLASS NEEDS IT. Task
-- routes derive their source from each message's OWN anchor and never read
-- `p_conversation_anchor_id`. Leaving the old unconditional resolution in place
-- would have turned a previously-silent multi-anchor post that happens to
-- include a task into a hard 22023 ("multi-anchor session delivery requires
-- conversationAnchorId") -- a batch that used to return `[]` would now refuse.
-- The resolution and both of its raises are therefore gated on a class that
-- actually consumes them being owed, or on the caller having passed an anchor
-- to be validated. Every batch that owed a copy before this migration takes the
-- identical path through the identical checks.
--
-- GENERATED from pg_get_functiondef, not transcribed. This function has been
-- redefined twice already; only 099's body carries the mention class, so a
-- reader working from 072 or 076 would be reading a body that has not run in a
-- long time.
--
-- NO `set role` HERE, AND THAT IS DELIBERATE -- 099 learned it the hard way.
-- `session_message_reply_routes` is owned by the DEFAULT migration role, not by
-- `tm8_graph_owner` (measured: pg_class.relowner is `tm8`). Recreating this
-- function under `tm8_graph_owner` leaves a SECURITY DEFINER body that cannot
-- touch its own table: "permission denied for table
-- session_message_reply_routes", at runtime, on every messages.post.
-- =============================================================================

create or replace function public.w2_record_session_message_routes(
  p_message_ids uuid[],
  p_conversation_anchor_id uuid default null,
  p_mention_session_ids uuid[] default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
-- `author_id` is BOTH a local below and a real column of public.messages, and
-- the batch guard compares them in one predicate over that table. Without this
-- option that reference is ambiguous and every call dies with SQLSTATE 42702 --
-- which is every messages.post. See 072 and the repair in PR #8.
#variable_conflict use_variable
declare
  message_count integer;
  batch_id text;
  author_id uuid;
  message_space uuid;
  source_message_id uuid;
  source_anchor_kind text;
  mention_ids uuid[] := array(select distinct unnest(coalesce(p_mention_session_ids, '{}'::uuid[])));
  -- 121: split out of the old single `if not exists(...) and not exists(...)`
  -- guard, because the answer is now needed TWICE -- once to decide whether the
  -- batch owes anything at all, and once to decide whether the conversation
  -- anchor has to be resolved. Computing it into a local keeps those two
  -- decisions from drifting apart.
  owes_addressed_copy boolean;
  owes_task_copy boolean;
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

  -- Fail before the early exit, not after: an invalid poke target must refuse
  -- even when the batch owes nothing else, or the caller learns the target was
  -- bad only on the batches that happened to owe other deliveries.
  if exists (
    select 1 from unnest(mention_ids) s(session_id)
     where not exists (
       select 1 from public.work_sessions ws
         join public.entities se on se.id = ws.entity_id
        where ws.entity_id = s.session_id
          and se.space_id = message_space and se.deleted_at is null
     )
  ) then
    raise exception 'poke target is not a live work session in this space' using errcode = '22023';
  end if;

  -- DOES THIS BATCH OWE ANYONE A LIVE COPY? 076's two disjuncts, plus 099's
  -- explicit pokes. These three are the ADDRESSED classes: each names its
  -- target, directly or through the thread, and each reads the conversation
  -- anchor below.
  owes_addressed_copy :=
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
       )
    or cardinality(mention_ids) > 0;

  -- 121's disjunct. Over-approximates the CTE below on purpose: it does not
  -- re-test the author-exclusion or the already-owed narrowing, because being
  -- wrong here costs one extra pass through a loop that then yields nothing,
  -- while being wrong the other way silently drops the whole class.
  owes_task_copy := exists (
    select 1
      from public.messages m
      join public.entities anchor
        on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
      join public.edges work on work.dst_id = m.anchor_id and work.type = 'working_on'
      join public.work_sessions ws on ws.entity_id = work.src_id
     where m.entity_id = any(p_message_ids)
       and ws.status in ('spawning', 'running', 'idle')
  );

  if not owes_addressed_copy and not owes_task_copy then
    return result;
  end if;

  -- Only the addressed classes read the conversation anchor, so only they may
  -- force it to exist. A task-only batch reaches its sessions without one.
  if owes_addressed_copy or p_conversation_anchor_id is not null then
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
    -- ANCHOR TARGETS: 072's rule, byte-for-byte in meaning.
    with anchor_targets as (
      select m.entity_id               as target_message_id,
             m.anchor_id               as target_work_session_id,
             p_conversation_anchor_id  as src_anchor_id,
             source_message_id         as src_message_id
        from public.messages m
        join public.entities anchor on anchor.id = m.anchor_id
       where m.entity_id = any(p_message_ids) and anchor.kind = 'work_session'
    ),
    -- REPLY TARGETS: the session that authored the message this copy answers
    -- (076's rule, byte-for-byte in meaning).
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
    -- MENTION TARGETS: caller-named sessions, delivered the CONVERSATION copy.
    -- src is (the conversation anchor, the tagging message itself), so the
    -- poked session's reply lands back in the thread (099's rule, unchanged).
    mention_targets as (
      select source_message_id          as target_message_id,
             s.session_id               as target_work_session_id,
             p_conversation_anchor_id   as src_anchor_id,
             source_message_id          as src_message_id
        from unnest(mention_ids) s(session_id)
    ),
    -- TASK TARGETS (121): the live sessions WORKING the task this copy is
    -- anchored on, delivered that anchor's own copy. src is (the task, the
    -- message on it), so the woken session answers on the task.
    task_targets as (
      select m.entity_id  as target_message_id,
             ws.entity_id as target_work_session_id,
             m.anchor_id  as src_anchor_id,
             m.entity_id  as src_message_id
        from public.messages m
        join public.entities anchor
          on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
        join public.edges work on work.dst_id = m.anchor_id and work.type = 'working_on'
        join public.work_sessions ws on ws.entity_id = work.src_id
        join public.entities se on se.id = ws.entity_id
       where m.entity_id = any(p_message_ids)
         and ws.status in ('spawning', 'running', 'idle')
         and se.space_id = message_space
         and se.deleted_at is null
         -- Narrowing 2: never hand a session back its own message.
         and not exists (
           select 1 from public.edges authored
            where authored.src_id = m.entity_id
              and authored.type = 'authored_from'
              and authored.dst_id = ws.entity_id
         )
         -- Narrowing 3: yield to any class that already owes this session a
         -- copy of this batch, whatever source that class recorded.
         and not exists (
           select 1 from anchor_targets a where a.target_work_session_id = ws.entity_id
         )
         and not exists (
           select 1 from reply_targets r where r.target_work_session_id = ws.entity_id
         )
         and not exists (
           select 1 from mention_targets x where x.target_work_session_id = ws.entity_id
         )
    )
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from anchor_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from reply_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from mention_targets
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
      -- Read for the TARGET session, not the anchor (076's point, unchanged).
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

revoke all on function public.w2_record_session_message_routes(uuid[], uuid, uuid[]) from public;
grant execute on function public.w2_record_session_message_routes(uuid[], uuid, uuid[]) to tm8_app;
