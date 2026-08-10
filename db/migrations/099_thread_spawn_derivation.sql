-- =============================================================================
-- 099 — spawn an agent ON A THREAD: message-aware derivation (extends 064).
--
-- 064 made "launch anything" true by deriving a task from the launched entity,
-- and its header explains at length why launch stays TASK-ONLY and why widening
-- `working_on` dst kinds beyond ['task'] (001:905) is the wrong move. THIS
-- MIGRATION HONOURS THAT REFUSAL: nothing here relaxes an edge registry, an
-- assertion, or the prompt contract. The task remains the one assignment
-- anchor; a thread reaches the agent by DERIVATION, exactly as 064 designed.
--
-- What 064 did not anticipate is the subject being a MESSAGE — a thread root.
-- Three defects, measured on this box:
--
--   1. The derived task was titled 'Work on: Untitled'.
--      `internal.entity_display_title` coalesces over title / name / statement
--      / branch / path, and a message row has none of them — its text lives in
--      `body`. A `body` arm is added, EXCERPTED: a body may be 10,000 chars and
--      `tasks.title` is 500, and a multi-line body must still read as a title.
--      `left(...)` counts CHARACTERS, not bytes, so it cannot split a UTF-8
--      sequence (064 makes the same point about the title cap).
--
--   2. 'Full thread visible' was not met. The derived task's description was
--      `jsonb_pretty` of the ROOT row alone. Deliberately NOT fixed by copying
--      the thread's branch into the task body: a thread is by definition still
--      moving, and a snapshot goes stale the instant someone replies. Instead
--      the body carries the root plus an EXPLICIT NAMED READ the agent can run
--      — `tm8 message list <channelId> --root <rootId>` (the CLI flag already
--      exists: packages/cli/src/commands/message.ts maps --root to
--      rootMessageId) — so the agent reads the thread LIVE, which is the only
--      version that stays true.
--
--   3. A second, separate piece of work could not start in a thread. The reuse
--      branch returned the newest open derived task unconditionally, so the
--      second dispatch silently landed on the first task. `p_force_new` mints
--      a fresh task past the reuse lookup. And once a thread CAN hold several
--      open derived tasks, "newest wins" becomes a guess — so when several
--      exist and the caller did not force, the function now REFUSES, carrying
--      every candidate id, and the UI must name one explicitly (dispatching a
--      task id directly is 064's untouched fast path). The server never
--      silently picks among several.
--
-- MESSAGE NORMALIZATION. Dispatching ANY message in a thread derives from its
-- ROOT (`coalesce(root_message_id, entity_id)`). "Work on this thread" means
-- the same task whether the user clicked the root or the fourth reply, and it
-- keeps the reuse lookup and `derived_from` edges single-valued per thread.
--
-- WHY `p_force_new` ON THIS FUNCTION rather than a caller-written task+edge:
-- 064 declares `derived_from` is 'Written only by public.derive_task_for_entity',
-- and `internal.attach_on_create` hard-refuses any type outside
-- ('attached_to','relates_to') at 007:898 — there is no supported way to create
-- the task and hand-write the edge. The parameter is the boundary.
--
-- IDEMPOTENCY CAVEAT, inherited honestly: 064's no-ledger argument rests on the
-- reuse branch making a second call return the SAME task. A `p_force_new` call
-- opts out of that and therefore mints on every call — which is the requested
-- meaning of the gesture ("a NEW task here"), and the caller's spawn/dispatch
-- remains the ledgered operation exactly as before.
--
-- The old 3-arg signature is DROPPED, not replaced: `create or replace` with a
-- new parameter list would leave the 3-arg function behind as an overload and
-- every existing positional call would keep hitting the old body.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The display title learns to read a message body.
--
-- The arm sits LAST, after every explicit name column: a kind that names
-- itself must keep winning over prose (documents carry both `title` and
-- `body`, and their title is their name). Whitespace is collapsed first so a
-- multi-line body reads as one line, then excerpted to 120 characters — small
-- enough to leave room under the 500-char title cap behind the 'Work on: '
-- prefix, long enough to recognise the thread.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_display_title(p_content jsonb)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select coalesce(
    nullif(p_content ->> 'title', ''),
    nullif(p_content ->> 'name', ''),
    nullif(p_content ->> 'statement', ''),
    nullif(p_content ->> 'branch', ''),
    nullif(p_content ->> 'path', ''),
    -- `left` counts CHARACTERS, so a multibyte sequence cannot be split.
    nullif(left(trim(regexp_replace(p_content ->> 'body', '\s+', ' ', 'g')), 120), ''),
    'Untitled'
  )
$$;

drop function if exists public.derive_task_for_entity(uuid, uuid, uuid);

create function public.derive_task_for_entity(
  p_space_id uuid, p_entity_id uuid, p_actor_id uuid default null,
  p_force_new boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  source public.entities;
  actor uuid;
  content jsonb;
  source_title text;
  task_id uuid;
  open_task_ids uuid[];
  activity_id uuid;
  msg public.messages;
  description text;
begin
  perform internal.require_space_member(p_space_id);

  select * into source
    from public.entities
   where id = p_entity_id and space_id = p_space_id and deleted_at is null;
  if source.id is null then
    raise exception 'entity % is not a live entity in space %', p_entity_id, p_space_id
      using errcode = '22023';
  end if;

  -- Fast path. A task is already its own anchor: return it and write NOTHING,
  -- so every existing task launch behaves exactly as it did before 064.
  if source.kind = 'task' then
    return jsonb_build_object(
      'taskId', p_entity_id, 'sourceEntityId', p_entity_id,
      'sourceKind', 'task', 'created', false);
  end if;

  -- A work_session is a launch RESULT, not a subject; deriving a task for one
  -- and spawning it would nest sessions with no way for a reader to tell which
  -- anchor is which. Refuse rather than produce that shape.
  if source.kind = 'work_session' then
    raise exception 'cannot derive a task from a work_session' using errcode = '22023';
  end if;

  -- A message means ITS THREAD: normalize any reply to the thread root before
  -- deriving, so `derived_from` targets roots only and reuse is stable no
  -- matter which message in the thread was dispatched.
  if source.kind = 'message' then
    select * into msg from public.messages where entity_id = p_entity_id;
    if msg.root_message_id is not null and msg.root_message_id <> p_entity_id then
      p_entity_id := msg.root_message_id;
      select * into source
        from public.entities
       where id = p_entity_id and space_id = p_space_id and deleted_at is null;
      if source.id is null then
        raise exception 'thread root % is not a live entity in space %', p_entity_id, p_space_id
          using errcode = '22023';
      end if;
      select * into msg from public.messages where entity_id = p_entity_id;
    end if;
  end if;

  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  -- Every open derived task for this entity, newest first. `entity_readable`
  -- is not needed here: require_space_member has passed and a derived task is
  -- created by this function alone, so there is no restricted row to leak.
  select coalesce(array_agg(t.entity_id order by e.created_at desc, t.entity_id desc), '{}')
    into open_task_ids
    from public.edges d
    join public.tasks t on t.entity_id = d.src_id
    join public.entities e on e.id = t.entity_id
   where d.type = 'derived_from'
     and d.dst_id = p_entity_id
     and e.space_id = p_space_id
     and e.deleted_at is null
     and t.work_status not in ('done', 'cancelled');

  if not p_force_new then
    -- Exactly one open derivation is 'continue this thread's work' — reuse it.
    -- Several is a fork only the CALLER can resolve: refuse with every
    -- candidate, never guess. The caller continues one by dispatching its task
    -- id directly (the fast path above), or forces a new one.
    if cardinality(open_task_ids) > 1 then
      raise exception 'several open tasks are derived from entity %; name one or pass force_new',
        p_entity_id
        using errcode = '22023',
              detail = jsonb_build_object('openDerivedTaskIds', to_jsonb(open_task_ids))::text;
    end if;
    if cardinality(open_task_ids) = 1 then
      return jsonb_build_object(
        'taskId', open_task_ids[1], 'sourceEntityId', p_entity_id,
        'sourceKind', source.kind, 'created', false);
    end if;
  end if;

  content := internal.entity_content(p_entity_id);
  source_title := internal.entity_display_title(content);

  -- A thread root's task body carries the root VERBATIM plus the read that
  -- stays true; every other kind keeps 064's jsonb_pretty rendering.
  if source.kind = 'message' then
    description :=
      'Launched from message `' || p_entity_id::text || '` — the root of a thread anchored on `'
      || msg.anchor_id::text || '`.'
      || E'\n\nThe thread is LIVE and may have grown since this task was written. Read it in full before working, and re-read it before reporting:'
      || E'\n\n    tm8 message list ' || msg.anchor_id::text || ' --root ' || p_entity_id::text
      || E'\n\nRoot message:\n\n' || msg.body;
  else
    description :=
      'Launched from ' || source.kind || ' `' || p_entity_id::text || '`.' ||
      E'\n\n' || jsonb_pretty(content);
  end if;

  task_id := internal.create_envelope(p_space_id, 'task', actor, null, null);
  insert into public.tasks(entity_id, title, description)
  values (
    task_id,
    -- `left` counts CHARACTERS, not bytes, so it cannot split a UTF-8
    -- sequence — no separate multibyte-safe truncation is needed.
    left('Work on: ' || source_title, 500),
    -- Capped because `documents.body` alone permits 200000 bytes and pasting
    -- that into a task row would make the list unreadable and the prompt huge.
    left(description, 8000)
  );
  perform internal.record_initial_version(task_id, actor);

  -- Provenance AND backlink, in one edge. Inserted directly rather than through
  -- `internal.attach_on_create`, which hard-refuses any type outside
  -- ('attached_to','relates_to') at 007:898.
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, task_id, p_entity_id, 'derived_from', actor)
  on conflict (src_id, dst_id, type) do nothing;

  activity_id := internal.record_activity(
    p_space_id, task_id, actor, 'created', null,
    jsonb_build_object('kind', 'task', 'derivedFrom', p_entity_id::text,
                       'derivedKind', source.kind));

  return jsonb_build_object(
    'taskId', task_id, 'sourceEntityId', p_entity_id,
    'sourceKind', source.kind, 'created', true, 'activityId', activity_id);
end
$$;

-- -----------------------------------------------------------------------------
-- 2. The open derivations for an entity, as a READ the UI can list.
--
-- The refusal above is only usable if the caller can see what it is choosing
-- between. Messages normalize to their thread root by the same rule as the
-- derivation, so asking about any reply answers about its thread.
-- -----------------------------------------------------------------------------
create function public.open_derived_tasks_for_entity(
  p_space_id uuid, p_entity_id uuid
) returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  root_id uuid := p_entity_id;
begin
  perform internal.require_space_member(p_space_id);

  select coalesce(m.root_message_id, m.entity_id) into root_id
    from public.messages m
    join public.entities e on e.id = m.entity_id
   where m.entity_id = p_entity_id and e.space_id = p_space_id;
  if root_id is null then
    root_id := p_entity_id;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'taskId', x.entity_id, 'title', x.title,
             'workStatus', x.work_status, 'createdAt', x.created_at))
      from (select t.entity_id, t.title, t.work_status, e.created_at
              from public.edges d
              join public.tasks t on t.entity_id = d.src_id
              join public.entities e on e.id = t.entity_id
             where d.type = 'derived_from'
               and d.dst_id = root_id
               and e.space_id = p_space_id
               and e.deleted_at is null
               and t.work_status not in ('done', 'cancelled')
             order by e.created_at desc, t.entity_id desc) x
  ), '[]'::jsonb);
end
$$;

revoke all on function internal.entity_display_title(jsonb) from public;
revoke all on function public.derive_task_for_entity(uuid, uuid, uuid, boolean) from public;
revoke all on function public.open_derived_tasks_for_entity(uuid, uuid) from public;
grant execute on function public.derive_task_for_entity(uuid, uuid, uuid, boolean) to tm8_app;
grant execute on function public.open_derived_tasks_for_entity(uuid, uuid) to tm8_app;

-- Sections 1-2 above are 064's functions and stay under 064's owner. The route
-- recorder below is 072/076's function: those migrations run as the DEFAULT
-- migration role, which owns session_message_reply_routes — recreating it as
-- tm8_graph_owner would leave a SECURITY DEFINER body that cannot touch its
-- own table (measured: 'permission denied for table session_message_reply_routes').
reset role;

-- -----------------------------------------------------------------------------
-- 3. @TAG ON A REPLY: the poke rides the DELIVERY route, not a second anchor.
--
-- Today an @tag reaches a session by adding it as a second message ANCHOR, and
-- a threaded reply has EXACTLY ONE anchor, equal to its parent's (019:416) —
-- a rule this migration leaves fully intact, for 076's reason: a thread lives
-- in one place. So @tag-on-a-reply cannot use the anchor trick at all.
--
-- 072/076 already split "where a message is STORED" from "who it WAKES", and
-- 076 already computes `threadRootMessageId` on every route envelope. The poke
-- is therefore a THIRD target class beside 076's two:
--
--     ANCHOR TARGETS  — the copy's own anchor, when it is a work_session
--     REPLY TARGETS   — authored_from(parent): the session being answered
--     MENTION TARGETS — sessions the CALLER names, delivered the conversation
--                       copy without being made an anchor of it
--
-- A mention route's src_anchor_id is the conversation anchor (the thread's
-- home) and its src_message_id is the tagging message itself, so the poked
-- session's reply resolves to (anchor = channel, parent = the tagging reply)
-- and lands IN the thread — the same stability argument 076 makes for reply
-- targets. `addressing_kind` computes `channel_mention` for a channel-homed
-- conversation, which is exactly what the tag means.
--
-- Named targets are VALIDATED, not skimmed: a poke that names anything but a
-- live work_session in the message's space raises rather than silently
-- dropping the wake — a silent drop is the precise defect 076 was built to
-- kill. Liveness of the PTY is still the delivery layer's concern; route rows
-- for idle sessions are stored-and-undelivered exactly like any other.
--
-- The parameter DEFAULTS NULL and every existing caller passes two arguments,
-- so behaviour is unchanged until a caller opts in (the facade field is
-- additive and the UI wiring is gated on review). Old 2-arg signature dropped
-- for the same overload reason as derive_task_for_entity above.
-- -----------------------------------------------------------------------------
drop function if exists public.w2_record_session_message_routes(uuid[], uuid);

create function public.w2_record_session_message_routes(
  p_message_ids uuid[],
  p_conversation_anchor_id uuid default null,
  p_mention_session_ids uuid[] default null
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
  mention_ids uuid[] := array(select distinct unnest(coalesce(p_mention_session_ids, '{}'::uuid[])));
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

  -- DOES THIS BATCH OWE ANYONE A LIVE COPY? 076's two disjuncts, plus the
  -- explicit pokes: a batch with mention targets owes copies even when nothing
  -- is anchored on a session and nothing is a reply.
  if not exists (
       select 1 from public.messages m join public.entities e on e.id = m.anchor_id
        where m.entity_id = any(p_message_ids) and e.kind = 'work_session'
     )
     and not exists (
       select 1
         from public.messages m
         join public.entities me on me.id = m.entity_id
         join public.edges origin on origin.src_id = me.parent_id and origin.type = 'authored_from'
        where m.entity_id = any(p_message_ids) and me.parent_id is not null
     )
     and cardinality(mention_ids) = 0
  then
    return result;
  end if;

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
    -- poked session's reply lands back in the thread.
    mention_targets as (
      select source_message_id          as target_message_id,
             s.session_id               as target_work_session_id,
             p_conversation_anchor_id   as src_anchor_id,
             source_message_id          as src_message_id
        from unnest(mention_ids) s(session_id)
    )
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from anchor_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from reply_targets
     union
    select target_message_id, target_work_session_id, src_anchor_id, src_message_id
      from mention_targets
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
