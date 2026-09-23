-- =============================================================================
-- 200 — a session can be RUN: "continue this session" derives a task (extends
-- 064/099).
--
-- 064 refused `work_session` outright: "a work_session is a launch RESULT, not
-- a subject; deriving a task for one and spawning it would nest sessions with
-- no way for a reader to tell which anchor is which." The owner has since asked
-- for exactly the gesture that refusal ruled out — a ▶ on a session that spawns
-- a NEW session carrying the old one's context, told to read its transcript
-- and wait for instructions.
--
-- The refusal's worry was ambiguity, and it is answered by the derivation, not
-- by relaxing anything downstream. Exactly as 064 designed for every other
-- kind, the new session is anchored on a TASK (never on the old session), and
-- that task:
--
--   · is titled 'Continue: <session title>', not 'Work on: …' — you do not
--     "work on" a run, you pick it up;
--   · carries a `derived_from` edge to the source session, so the provenance
--     is one edge, readable by anyone, and distinct from the `working_on` edge
--     the new session holds on the task;
--   · names the source session by id in its body, together with the EXPLICIT
--     READS that recover its context LIVE — its transcript, its messages, and
--     what it was told at spawn — rather than a snapshot. A running session is
--     still moving, and 099 already ruled for threads that a pasted snapshot
--     goes stale the instant the source moves on;
--   · lists the tasks the source session was `working_on`, so the continuation
--     knows what work the transcript is about without a second lookup;
--   · tells the agent to summarise and then WAIT, rather than to resume the
--     old work on its own initiative. The person pressing ▶ is about to give
--     instructions; an agent that charges ahead on a guess is the failure mode.
--
-- Nothing else changes. `working_on` still has dst `['task']` only, the spawn
-- RPC still asserts a live task, and the reuse / force_new / several-open
-- rules are 099's, applied to a session exactly as to any other kind.
--
-- SAME SIGNATURE as 099, so `create or replace` replaces the body in place:
-- there is no overload left behind for a positional call to hit.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.derive_task_for_entity(
  p_space_id uuid, p_entity_id uuid, p_actor_id uuid default null,
  p_force_new boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  source public.entities;
  actor uuid;
  content jsonb;
  source_title text;
  title_prefix text := 'Work on: ';
  task_id uuid;
  open_task_ids uuid[];
  activity_id uuid;
  msg public.messages;
  ws public.work_sessions;
  session_tasks text;
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
  -- stays true; a session's carries the reads that recover it; every other
  -- kind keeps 064's jsonb_pretty rendering.
  if source.kind = 'message' then
    description :=
      'Launched from message `' || p_entity_id::text || '` — the root of a thread anchored on `'
      || msg.anchor_id::text || '`.'
      || E'\n\nThe thread is LIVE and may have grown since this task was written. Read it in full before working, and re-read it before reporting:'
      || E'\n\n    tm8 message list ' || msg.anchor_id::text || ' --root ' || p_entity_id::text
      || E'\n\nRoot message:\n\n' || msg.body;
  elsif source.kind = 'work_session' then
    select * into ws from public.work_sessions where entity_id = p_entity_id;
    title_prefix := 'Continue: ';

    -- What the source session was assigned, so the transcript has a subject.
    select string_agg('    - `' || t.entity_id::text || '` ' || t.title
                        || ' (' || t.work_status || ')',
                      E'\n' order by e.created_at)
      into session_tasks
      from public.edges w
      join public.tasks t on t.entity_id = w.dst_id
      join public.entities e on e.id = t.entity_id
     where w.type = 'working_on'
       and w.src_id = p_entity_id
       and e.deleted_at is null;

    description :=
      'Continue from work session `' || p_entity_id::text || '` ("' || source_title || '"'
      || coalesce(', ' || nullif(ws.agent_tool, ''), '')
      || coalesce(', ' || nullif(ws.model, ''), '')
      || ', status ' || coalesce(ws.status, 'unknown') || ').'
      || E'\n\nYou are picking up where that session left off. It may still be running, so read it LIVE rather than trusting this note:'
      || E'\n\n1. Read its transcript — what its agent said and did:'
      || E'\n\n       tm8 session transcript ' || p_entity_id::text || ' --last 200'
      || E'\n\n2. Read its context and messages — results, blockers and replies posted on it:'
      || E'\n\n       tm8 entity context ' || p_entity_id::text
      || E'\n\n3. If you need what it was originally told, read its launch prompt:'
      || E'\n\n       tm8 session launch ' || p_entity_id::text
      || coalesce(E'\n\nIt was working on:\n\n' || session_tasks, '')
      || E'\n\nThen reply with a short summary of where that session stands — what was done, what is open, and anything that looks unfinished or broken — and WAIT for instructions. Do not resume or change its work until you are asked to.';
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
    left(title_prefix || source_title, 500),
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

revoke all on function public.derive_task_for_entity(uuid, uuid, uuid, boolean) from public;
grant execute on function public.derive_task_for_entity(uuid, uuid, uuid, boolean) to tm8_app;

reset role;
