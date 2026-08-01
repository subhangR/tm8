-- =============================================================================
-- 064 — derive a task from any entity, so anything can be launched.
--
-- Launch has always been task-only, and the restriction is welded in at four
-- layers: the UI manifest lists the `run` action only under `kind:'task'`; the
-- spawn facade's context loader joins `public.tasks`; `public.execution_spawn`
-- (048:92) asserts `internal.live_entity(task_id, 'task')`; and the edge
-- registry (001:905) declares `working_on` dst kinds `array['task']`.
--
-- WHY THIS MIGRATION RELAXES NONE OF THEM. The obvious design — widen
-- `working_on` to dst `['*']`, drop the live_entity assertion, rename the
-- contract field, generalise `<tm8_task_prompt>` — touches the DB, the
-- contract, the prompt envelope and every reader of `working_on`, and leaves
-- two permanent notions of "what this session is about". The cheaper model is
-- to keep TASK as the one and only assignment anchor and make the *other*
-- kinds reach it: launching a doc derives a task FOR that doc, then spawns the
-- task. Everything downstream of spawn — the RPC, the edge, the prompt, the
-- agent's "reply on the assignment anchor" instruction — is untouched and
-- keeps its single, already-proven shape. By the time `execution_spawn` runs,
-- every id it receives genuinely IS a task.
--
-- IDEMPOTENCY WITHOUT A LEDGER ENTRY. This function takes no
-- p_client_mutation_id and records nothing in the mutation ledger. That is
-- deliberate, and it is not a gap: the reuse branch below makes a second call
-- for the same entity return the SAME task, so the operation is naturally
-- idempotent and needs no replay machinery to become so. Avoiding the ledger
-- also avoids the documented deadlock pattern — `internal.ledger_replay` takes
-- an advisory lock on the mutation id, and this runs inside the spawn path,
-- which takes its own in `public.execution_spawn`. Nesting them is exactly the
-- hazard 057:180-188 warns about (see also 036:100, 032:123). The caller's
-- spawn remains ledgered; the derivation rides its transaction boundary.
--
-- WHY A DEDICATED `derived_from` EDGE TYPE. Both obvious markers are wrong.
--
-- `tasks.axes` looks like the cheap place to stamp a source id and is actively
-- rejected by the database: `internal.validate_task_axes` (001:565) checks every
-- axis name against `public.task_axes`, the per-space taxonomy users curate via
-- `space task-axis create`, and raises `22023 unknown task axis` for anything
-- unregistered. `axes` is a USER vocabulary; a system provenance marker does not
-- belong in it even where a space happened to have registered the name.
--
-- Reusing `attached_to` is wrong for the opposite reason: it is SHARED. It means
-- "context attachment" and a user can attach any task to any doc by hand, so a
-- reuse lookup keyed on it would silently hijack an unrelated task the user
-- attached themselves and launch the wrong anchor.
--
-- A dedicated type has neither problem. Nothing but this function writes
-- `derived_from`, so its presence means "this task exists BECAUSE of that
-- entity" and nothing else — while the backlink and the marker stay ONE object,
-- with no side table to keep in sync and no second source of truth. It also
-- inherits the machinery a new table would have had to re-earn: edges are
-- already covered by RLS, by the purge path and by the event-capture trigger.
--
-- Reuse is scoped to OPEN tasks. Re-launching an entity whose derived task was
-- marked done mints a fresh one: a closed task is a closed anchor, and
-- reopening it would reattach new session history to finished work.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- The `derived_from` edge type: task → the entity it was derived from.
--
-- `on conflict do nothing` so re-running the chain is safe. dst is `'*'` for the
-- same reason `attached_to` is — anything can be launched, and re-listing every
-- kind here would drift the moment a kind is added.
-- -----------------------------------------------------------------------------
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic) values
  ('derived_from', array['task'], array['*'],
   'Provenance: this task was auto-created to launch that entity (064). Written only by public.derive_task_for_entity.',
   false)
on conflict (type) do nothing;

-- -----------------------------------------------------------------------------
-- The kind-agnostic display title.
--
-- Every kind names itself in a different column, and `internal.entity_content`
-- (last replaced 057:189) already returns each one's detail row as jsonb — so
-- the title is a coalesce over the keys those rows actually use rather than a
-- second per-kind CASE that would drift from the first. Covered by the listed
-- keys: doc/task/pull_request `title`, team_member/artifact/project `name`,
-- memory `statement`, worktree `branch` then `path`.
--
-- NOTE this reads `content`, not `public.entities`. There is no title column on
-- the envelope; a kind's name lives only in its detail table.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_display_title(p_content jsonb)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select coalesce(
    nullif(p_content ->> 'title', ''),
    nullif(p_content ->> 'name', ''),
    nullif(p_content ->> 'statement', ''),
    nullif(p_content ->> 'branch', ''),
    nullif(p_content ->> 'path', ''),
    'Untitled'
  )
$$;

-- -----------------------------------------------------------------------------
-- public.derive_task_for_entity — the whole feature.
--
-- Contract: given ANY live entity in the space, return the id of a task that
-- represents working on it. For a task, that is the task itself and nothing is
-- written. For anything else, an existing open derived task, or a new one.
--
-- SECURITY DEFINER with the standard preamble: membership is checked against
-- the space the request names, the actor is resolved from claims when the
-- caller passes null (the same convention `createWorkSession` uses), and
-- `bind_actor` attributes the trigger-written version and activity rows.
-- -----------------------------------------------------------------------------
create or replace function public.derive_task_for_entity(
  p_space_id uuid, p_entity_id uuid, p_actor_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  source public.entities;
  actor uuid;
  content jsonb;
  source_title text;
  task_id uuid;
  activity_id uuid;
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

  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  -- Reuse. `entity_readable` is not needed here: require_space_member has
  -- passed and a derived task is created by this function alone, so there is
  -- no restricted row to leak. Newest wins if history somehow holds several.
  select t.entity_id into task_id
    from public.edges d
    join public.tasks t on t.entity_id = d.src_id
    join public.entities e on e.id = t.entity_id
   where d.type = 'derived_from'
     and d.dst_id = p_entity_id
     and e.space_id = p_space_id
     and e.deleted_at is null
     and t.work_status not in ('done', 'cancelled')
   order by e.created_at desc
   limit 1;

  if task_id is not null then
    return jsonb_build_object(
      'taskId', task_id, 'sourceEntityId', p_entity_id,
      'sourceKind', source.kind, 'created', false);
  end if;

  content := internal.entity_content(p_entity_id);
  source_title := internal.entity_display_title(content);

  task_id := internal.create_envelope(p_space_id, 'task', actor, null, null);
  insert into public.tasks(entity_id, title, description)
  values (
    task_id,
    -- `left` counts CHARACTERS, not bytes, so it cannot split a UTF-8
    -- sequence — no separate multibyte-safe truncation is needed.
    left('Work on: ' || source_title, 500),
    -- The agent reads this verbatim inside <tm8_task_prompt>, so the source's
    -- content goes in the body: without it the agent knows only an id and must
    -- spend a round trip on `tm8 entity context` that it may simply skip.
    -- Capped because `documents.body` alone permits 200000 bytes and pasting
    -- that into a task row would make the list unreadable and the prompt huge.
    left(
      'Launched from ' || source.kind || ' `' || p_entity_id::text || '`.' ||
      E'\n\n' || jsonb_pretty(content),
      8000)
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

-- The reuse lookup probes (dst_id, type) once per non-task launch; the existing
-- edge indexes lead with src_id, so this is the one that serves it.
create index if not exists edges_derived_from_dst_idx
  on public.edges(dst_id)
  where type = 'derived_from';

revoke all on function internal.entity_display_title(jsonb) from public;
revoke all on function public.derive_task_for_entity(uuid, uuid, uuid) from public;
grant execute on function public.derive_task_for_entity(uuid, uuid, uuid) to tm8_app;

reset role;
