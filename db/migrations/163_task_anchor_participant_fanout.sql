-- =============================================================================
-- 163  A MESSAGE ON A TASK REACHES EVERY LIVE SESSION IN THAT TASK'S
--      CONVERSATION -- NOT JUST THE ONE THAT WAS SPAWNED ON IT.
--
-- THE DEFECT, measured on the live node (tm8_stable, 2026-08-19). 121 added the
-- fourth target class and it works exactly as written -- and exactly as written
-- is one relation wide. `working_on` is issued by ONE writer: 111's spawn RPC,
-- for the ONE session a spawn puts on the task. 121 then correctly excludes the
-- author. So on the overwhelmingly common topology -- a coordinator opens a
-- task, spawns one worker on it, the worker reports back on the anchor -- the
-- membership set is {the worker}, minus {the worker}, and the fan-out routes to
-- nobody. `tm8 message send --to <task-id>` is durable and silent again, for a
-- different reason than the one 121 fixed.
--
-- MEASURED, not reasoned. On the live graph, last 14 days:
--
--     1506  messages anchored on a task
--      367  reached at least one live session under 121's rule
--      449  reached NOBODY and had a live session that this file now reaches
--      690  had no live peer under either rule (correctly silent)
--
-- So 55% of the reachable traffic was being dropped.
--
-- HOW TO REPRODUCE THAT REPLAY, because the obvious way is wrong by 40x.
-- Liveness has to be reconstructed AT THE TIME OF EACH MESSAGE, from
-- `work_sessions.exited_at`, not read off the session's CURRENT status. A
-- reviewer who used current status independently got 0->1472 / 1->21 and would
-- have concluded the numbers above were fabricated; with `exited_at` the replay
-- reproduces to within one day of new traffic.
--
-- TWO WORKED EXAMPLES, and the second one is this change's own review.
--
--   * Task `01a01ae6`: worker session `01a01ae7` posted seven messages to the
--     anchor between 22:21 and 22:30. `session_message_reply_routes` holds zero
--     rows for all seven. The session that CREATED that task, `01a01a5f`, was
--     `idle` -- that is, live, with a terminal -- for every one of them.
--   * Task `01a01b61`, opened so that a second Opus 5 session could review THIS
--     FILE. The reviewer posted its findings to both anchors and then counted:
--     four copies on the task anchor produced ZERO route rows, while the two on
--     the author's work_session anchor produced two and delivered. The only
--     reason the review was ever read is that the reviewer was told not to
--     trust the task anchor.
--
-- WHICH RELATION ACTUALLY CARRIES THE REPAIR. Attributing every (message,
-- session) pair the replay produces: SPOKEN 659 pairs, WORKING 533, OPENED 482.
-- But by SOLE reachability -- messages that exactly one relation saves --
-- only-OPENED is 270, only-WORKING 44, only-SPOKEN 38. So `created_in` alone is
-- a third of the entire fix, which promotes the "it is client-asserted" caveat
-- below from a footnote to a headline property of this change.
--
-- THE MEMBERSHIP SET, WIDENED FROM ONE RELATION TO THREE.
--
--     WORKING  `working_on` edge, session -> task.   121's rule, unchanged.
--              "this PROCESS is on it."
--     OPENED   `created_in` edge, task -> session.   NEW.
--              The session that created the task. This is the coordinator, and
--              it is the one the report names. 489 tasks on the live node carry
--              this edge; a task a human opened in the UI carries none, gets no
--              extra target, and keeps its ordinary inbox notification. It adds
--              AT MOST ONE target, always: 066's `edges_created_in_source_idx`
--              is unique on the source, because two contradictory claims about
--              where a thing was born is a defect, not a difference of opinion.
--     SPOKEN   `authored_from` on any EARLIER message anchored on this task.
--              NEW. A session that has already posted on the task is in the
--              conversation. This is the sub-session case from the report: a
--              session nobody spawned on the task, that reported on it anyway,
--              is unreachable by both edges above and is reachable by its own
--              participation.
--
-- `assigned_to` is STILL not in this set, and 121's reasoning for that is
-- unchanged and correct: it hangs off a Teammate and names a PERSON, and a wake
-- has to reach a PROCESS. An assignee with no live session keeps the inbox
-- notification it already had.
--
-- WHY MEMBERSHIP AND NOT LINEAGE. The obvious alternative is "wake the session
-- that spawned mine". There is no such relation to walk: `work_sessions` has no
-- parent column and no spawn-lineage table exists (`dispatched_by`, 10 rows
-- node-wide, is the dispatcher feature and not this). `created_in` is the
-- durable fact that actually records who opened the work, and SPOKEN covers
-- every participant lineage would have found plus the ones it would not.
--
-- ONE OF THE THREE IS UNVERIFIED, AND IT IS SAID OUT LOUD RATHER THAN GLOSSED.
-- 066 describes `created_in` as CLIENT-ASSERTED ("unverified until agents carry
-- session-scoped tokens; see authored_from for the verified form"), so OPENED
-- routes on a claim while WORKING and SPOKEN route on server-recorded facts.
-- The reachable consequence is bounded and it is not an escalation: the edge is
-- refused across a Space boundary, the target must be a live agent session in
-- the message's own Space, and the copy delivered is one the poster was already
-- entitled to write. So the worst a forged edge buys is enrolling one live
-- session of your own Space into one of your own task's conversations -- which
-- is what posting on a task it already works buys today, and what
-- `promptPolicy.allowedInjectionKinds` already lets a session refuse.
--
-- FIVE NARROWINGS. 121's four are kept verbatim and a fifth is added.
--
--   1. LIVE SESSIONS ONLY (`spawning`/`running`/`idle`), 121's argument
--      unchanged and now load-bearing three times over: SPOKEN in particular
--      accumulates every session that ever touched a long-lived task, and
--      without this an old task would reserve a delivery per DEAD participant
--      on every post. Note this reads `work_sessions.status` -- the PROCESS --
--      and deliberately not 156's `entities.status_category`: a session a user
--      has ticked done keeps running and keeps its terminal, so it is still a
--      live participant.
--   2. NOT THE AUTHOR'S OWN SESSION, by its own `authored_from` edge.
--   3. ONLY WHEN NO OTHER CLASS ALREADY OWES THAT SESSION A COPY.
--   4. SAME SPACE, NOT DELETED.
--   5. AGENT SESSIONS ONLY (`session_kind = 'agent'`). NEW, and it is not
--      decoration: it is created by the two new relations. `working_on` is
--      written by the spawn RPC and therefore only ever names an agent, but a
--      `shell` session is a bash prompt and a `credential` session is an
--      interactive login, and BOTH can create a task or post on one by running
--      the CLI. Under OPENED and SPOKEN either one becomes a delivery target,
--      and the delivery layer would not stop it: `sessionInputAllowed` is read
--      from an interaction-profile pin that a shell session does not have, so
--      it defaults to TRUE and the envelope gets TYPED INTO THE USER'S SHELL.
--      Measured on the live node, all 628 `working_on`, all 490 task
--      `created_in` and all 424 task-message authors are `agent`, so this
--      narrowing changes nothing that exists and closes the hazard this file
--      would otherwise open.
--
-- WAKE AMPLIFICATION. A wider membership set is a wider wake and 120 removed the
-- wake budget, so "does this storm?" has to be answered from data. Replaying the
-- same 14 days under this file's rule, targets per message:
--
--     0 -> 691    1 -> 606    2 -> 150    3 -> 41    4 -> 1    5 -> 19
--
-- Ninety-five percent of posts reach two sessions or fewer and the maximum is
-- five. NO CAP IS ADDED, because a cap with no measured pressure behind it is a
-- mechanism nobody can tune. But the sentence that used to sit here -- "so this
-- does not storm" -- was a bigger claim than the measurement supports, and this
-- is the smaller one:
--
--     THAT REPLAY DESCRIBES 121'S TRAFFIC AND CANNOT BOUND THIS FILE'S. It was
--     produced under a regime where posting on a task wakes nobody, and the
--     entire point of this change is to make posting on a task worth doing.
--     SPOKEN is also MONOTONIC -- there is no way to leave a conversation -- and
--     a woken session's reply lands back on the task (src is the task, by
--     construction), which permanently enrols it. Under 121 that first step
--     almost never fires, so the feedback term CANNOT APPEAR IN PAST DATA. The
--     headroom is already visible: 99 tasks on this node have >= 2 distinct
--     agent speakers and one has 10.
--
-- What replaces the missing bound is FORWARD data, and it needs no new counter
-- because `session_message_reply_routes` already records one row per target per
-- post. Fan-out width over real 162 traffic is one query:
--
--     select count(*) n, count(*) filter (where true) from (
--       select r.source_message_id, count(*) width
--         from public.session_message_reply_routes r
--         join public.entities a on a.id = r.source_anchor_id and a.kind = 'task'
--        group by 1) w;
--
-- If that distribution moves, the cap discussion reopens with an argument
-- instead of an anecdote. The per-session opt-out already exists meanwhile: the
-- interaction profile's `promptPolicy.allowedInjectionKinds` drops
-- `tm8.session-input` and this function returns `sessionInputAllowed: false` for
-- that target, which `message-dispatch.ts` skips before reserving.
--
-- Two adjacent facts recorded because they bound how long a stale member lives,
-- and neither is repaired here: liveness admits `spawning` WITH NO TIMEOUT (one
-- session on this node has been `spawning` for 154 hours), and a single session
-- has opened as many as 70 tasks (p95 22), so an OPENED membership can outlive
-- its usefulness by hours. `work_sessions.mode` (worker/coordinator/dispatcher,
-- server-written) is a better-quality signal than `created_in` but it is not a
-- substitute: it says WHAT a session is, never WHICH TASK it opened, which is
-- the whole question here.
--
-- THE ORDER IS NOT THE PLANNER'S TO CHOOSE, and this is the one thing in this
-- file that no amount of reading the SQL would have caught.
--
-- `w2_task_conversation_sessions` is `language sql stable` with a single-query
-- body, which makes it INLINABLE. Once Postgres inlines it, `join ... on true`
-- stops being a per-row lateral and becomes an ordinary subquery the planner may
-- reorder -- and it chooses to apply `entities anchor ... kind = 'task'` LAST.
-- So a message anchored on a CHANNEL walked that channel's entire history
-- through the SPOKEN arm and then discarded every row on `Rows Removed by
-- Filter: 1`. Measured on the live node with EXPLAIN (ANALYZE, BUFFERS):
--
--     guard, channel post w/ 209 siblings   121:   5 buffers   0.032 ms
--                                           naive: 712 buffers 0.553 ms
--     CTE,   work_session post w/ 84 sibs   naive: 323 buffers
--                                           fenced:  6 buffers, `never executed`
--
-- All 2437 non-task messages on this node paid it, on every post. Both halves
-- are therefore made DETERMINISTIC rather than left to the planner: the guard
-- becomes a plpgsql IF (a real branch), and the CTE gets a `materialized` fence
-- so the anchor-kind test provably runs first and drives an empty lateral.
-- `set search_path` on the function would defeat inlining and fixes the guard,
-- but it was measured NOT to fix the CTE (323 -> 370), so it is not the answer.
--
-- NO TYPESCRIPT IN THE BLAST RADIUS, for the same reason 121 had none: the
-- routes this returns are dispatched by the same `dispatchSessionMessages`
-- loop, over the same reserve/claim/settle RPCs, with the same envelope shape
-- and the same `anchored_message` addressing kind, as every other session copy.
--
-- GENERATED by copying the complete live 145 definition forward and replacing
-- exactly one CTE and one over-approximating disjunct. Never edit 121 or 145:
-- deployed databases have already recorded them. The owner caveat in 121's
-- header remains load-bearing -- `session_message_reply_routes` is owned by the
-- default migration role and a SECURITY DEFINER body created under
-- `tm8_graph_owner` cannot touch it -- so this migration likewise has no
-- `set role`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- THE MEMBERSHIP SET, AS ONE FUNCTION.
-- ---------------------------------------------------------------------------
-- It is deliberately ONE function called TWICE rather than a union written
-- twice, because the two callers below answer different questions from the
-- same set: the guard asks "does this batch owe anything at all?" and the CTE
-- asks "whom exactly?". 121 split those two decisions apart and warned in its
-- own header that computing them separately lets them drift; a shared
-- definition is that warning taken to its conclusion. The guard is still an
-- over-approximation -- it applies liveness and kind but not the author
-- exclusion or the already-owed narrowing -- because being wrong there costs
-- one empty pass through a loop, while being wrong the other way drops the
-- whole class silently, which is the exact defect this file repairs.
--
-- `p_batch_message_ids` excludes THE BATCH BEING POSTED from the SPOKEN arm.
-- Without it a message whose `authored_from` edge is already written would
-- make its own author a member and rely entirely on narrowing 2 to take it
-- back out; worse, a two-message batch on one task would make each message's
-- author a member through the other. Membership means "has spoken BEFORE".
--
-- SECURITY INVOKER on purpose (no `security definer`): every caller is already
-- the SECURITY DEFINER routing function, so this runs with that function's
-- authority and adds none of its own. Same shape as `internal.w2_addressing_kind`.
create or replace function internal.w2_task_conversation_sessions(
  p_task_id uuid,
  p_batch_message_ids uuid[]
) returns table (work_session_id uuid) language sql stable as $$
  -- WORKING: `working_on` names the PROCESS that is on the task (111, 121).
  select work.src_id
    from public.edges work
   where work.dst_id = p_task_id and work.type = 'working_on'
  union
  -- OPENED: `created_in` names the session that created the task -- the
  -- coordinator. Direction is task -> session, the opposite of `working_on`.
  select opened.dst_id
    from public.edges opened
   where opened.src_id = p_task_id and opened.type = 'created_in'
  union
  -- SPOKEN: any session that has already posted on this task is in the
  -- conversation, whether or not anything ever put it on the task.
  select authored.dst_id
    from public.messages prior
    join public.edges authored
      on authored.src_id = prior.entity_id and authored.type = 'authored_from'
   where prior.anchor_id = p_task_id
     and not (prior.entity_id = any(coalesce(p_batch_message_ids, '{}'::uuid[])))
$$;

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

  -- 121's disjunct, in TWO STATEMENTS, and the split is a measured performance
  -- fix rather than a stylistic one. See "THE ORDER IS NOT THE PLANNER'S TO
  -- CHOOSE" in this file's header: written as one query with the anchor-kind
  -- test as a join predicate, Postgres INLINES the membership function and is
  -- then free to reorder, and it puts `entities anchor` LAST -- so a message on
  -- a CHANNEL walks that channel's entire history through the SPOKEN arm and
  -- throws all of it away on `Rows Removed by Filter: 1`. Measured on the live
  -- node, a channel post with 209 siblings: 5 buffers before, 712 after.
  --
  -- A plpgsql IF is a real branch and not a planner preference, so the cheap
  -- question is asked first and the expensive one is not asked at all unless the
  -- batch actually has a task anchor. Every non-task post -- 2437 of the 4382
  -- messages on this node -- takes the first statement and stops.
  owes_task_copy := false;
  if exists (
    select 1
      from public.messages m
      join public.entities anchor on anchor.id = m.anchor_id
     where m.entity_id = any(p_message_ids)
       and anchor.kind = 'task' and anchor.deleted_at is null
  ) then
    -- Over-approximates the CTE below on purpose: it does not re-test the
    -- author-exclusion or the already-owed narrowing, because being wrong here
    -- costs one extra pass through a loop that then yields nothing, while being
    -- wrong the other way silently drops the whole class.
    owes_task_copy := exists (
      select 1
        from public.messages m
        join public.entities anchor
          on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
        join internal.w2_task_conversation_sessions(m.anchor_id, p_message_ids) member on true
        join public.work_sessions ws on ws.entity_id = member.work_session_id
       where m.entity_id = any(p_message_ids)
         and ws.status in ('spawning', 'running', 'idle')
         and ws.session_kind = 'agent'
    );
  end if;

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
    -- THE TASK ANCHORS OF THIS BATCH, FENCED. `as materialized` is the CTE's
    -- half of the same performance fix the guard above takes as a plpgsql IF,
    -- and it is required for the same reason: without the fence the planner
    -- inlines the membership function, reorders, and evaluates the anchor-kind
    -- test AFTER the walk. A batch that reaches this loop at all has satisfied
    -- an ADDRESSED class -- a work-session anchor, a reply, a poke -- so the
    -- common case here is a batch with NO task anchor, and it must not pay.
    -- Measured on the live node, a work_session post with 84 siblings:
    -- 323 buffers unfenced, 6 fenced with every task-side node `never executed`.
    task_anchored as materialized (
      select m.entity_id as message_id, m.anchor_id as task_id
        from public.messages m
        join public.entities anchor
          on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
       where m.entity_id = any(p_message_ids)
    ),
    -- TASK TARGETS (121, widened by 163): the live AGENT sessions in this
    -- task's conversation -- working it, or having opened it, or having spoken
    -- on it -- delivered that anchor's own copy. src is (the task, the message
    -- on it), so the woken session answers on the task.
    task_targets as (
      select m.message_id as target_message_id,
             ws.entity_id as target_work_session_id,
             m.task_id    as src_anchor_id,
             m.message_id as src_message_id
        from task_anchored m
        join internal.w2_task_conversation_sessions(m.task_id, p_message_ids) member
          on true
        join public.work_sessions ws on ws.entity_id = member.work_session_id
        join public.entities se on se.id = ws.entity_id
       where ws.status in ('spawning', 'running', 'idle')
         -- Narrowing 5 (163): a wake is typed into a terminal, and only an
         -- agent's terminal is reading prompts. A `shell` or `credential`
         -- session can open a task or post on one through the CLI, has no
         -- interaction pin, and would therefore pass `sessionInputAllowed`.
         and ws.session_kind = 'agent'
         and se.space_id = message_space
         and se.deleted_at is null
         -- Narrowing 2: never hand a session back its own message.
         and not exists (
           select 1 from public.edges authored
            where authored.src_id = m.message_id
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
      -- 134: one canonical route, one canonical copy manifest. This field was
      -- already audience-validated before the message row was stored (019).
      'attachments', (select coalesce(m.attachments, '[]'::jsonb)
        from public.messages m where m.entity_id = route_row.target_message_id),
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

revoke all on function internal.w2_task_conversation_sessions(uuid, uuid[]) from public;
revoke all on function public.w2_record_session_message_routes(uuid[], uuid, uuid[]) from public;
grant execute on function public.w2_record_session_message_routes(uuid[], uuid, uuid[]) to tm8_app;

-- -----------------------------------------------------------------------------
-- VERIFY -- only what THIS file establishes. The whole-surface pins live in
-- tests, which always run a complete chain; a migration is replayed at every
-- position in history that has ever existed, so a chain-wide assertion here
-- aborts on drift that is not drift.
--
-- The membership helper deliberately has NO grant. It is called only from inside
-- a SECURITY DEFINER body and therefore runs with that function's authority, so
-- a grant would widen its reach for no caller that exists -- and the assertion
-- that nobody but the owner can reach it is exactly the kind of thing that is
-- silently true today and silently false after someone "fixes" a permission
-- error by granting rather than by finding the real caller.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if has_function_privilege(
       'tm8_app', 'internal.w2_task_conversation_sessions(uuid, uuid[])', 'EXECUTE') then
    raise exception 'the membership helper must not be directly callable by tm8_app';
  end if;
  if not has_function_privilege(
       'tm8_app', 'public.w2_record_session_message_routes(uuid[], uuid, uuid[])', 'EXECUTE') then
    raise exception 'the routing function must remain executable by tm8_app';
  end if;
  -- The three membership arms are what this file is FOR; a later `create or
  -- replace` that loses one would otherwise be caught by nothing until a
  -- coordinator went quiet again.
  if (select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'internal' and p.proname = 'w2_task_conversation_sessions'
         and p.prosrc like '%working_on%' and p.prosrc like '%created_in%'
         and p.prosrc like '%authored_from%') <> 1 then
    raise exception 'the membership helper must carry all three arms: working_on, created_in, authored_from';
  end if;
end
$verify$;
