-- =============================================================================
-- 152  UNIVERSAL STATUS. EVERY KIND GETS A WORKFLOW.
--
-- Phase 5 of "Kind, Status, Category, Workflow". 147 added the column, 149 built
-- the workflow tables, 150 pointed the three task doors at them, 151 moved the
-- completion gate onto the transition. All four were about TASKS. This file is
-- the one that makes `entities.status_id` mean something for the other twenty
-- kinds, which is what the whole program was for.
--
-- Four changes, in dependency order:
--
--   1. `entity_kinds.workflow_id` — the kind → workflow link, and the arm 150
--      left commented in place inside `internal.workflow_for_entity`.
--   2. Birth widens from `kind = 'task'` to EVERY kind.
--   3. The backfill: every pre-existing row of every kind adopts a status.
--   4. `internal.is_resolved` and `public.ready_to_work` stop reading literals
--      and read the category.
--
-- ## The seeding table, and why it is not "everything to_do"
--
-- The ruled default is the default workflow's `to_do` state. The exception is
-- kinds whose rows are FACTS ABOUT THE PAST: a commit exists because it was
-- made. It is not "to do". Nothing will ever move it. Seeding such a row into
-- `to_do` would not merely read oddly on a tab — it would make the row BLOCK
-- every `depends_on` pointing at it, forever, which is precisely the opposite of
-- what `internal.is_resolved` has answered for that kind since 003.
--
--   commit    done   a commit exists because it was made
--   message   done   a message exists because it was sent
--   file      done   a file row exists because the bytes arrived
--   memory    done   a memory is a recorded observation, not an intention
--   artifact  done   an artifact exists because a run produced it
--   everything else   the default workflow's `to_do` state
--
-- and `pull_request` is seeded from the forge state it already carries —
-- `merged` → done, `closed` → cancelled, anything else → to_do — so the
-- category agrees with the kind-behaviour override below rather than contradicts
-- it on day one.
--
-- THE SAME TABLE GOVERNS BIRTH, not just the backfill, and that is deliberate.
-- A commit created tomorrow is exactly as much a fact about the past as one
-- created last year; a birth rule that disagreed with the backfill rule would
-- mean the graph's answer to "is this commit resolved" depended on which side of
-- this migration it was written. It lives in ONE function,
-- `internal.kind_seeds_done`, read by both.
--
-- ## What this changes about what blocks what (owner decision #3)
--
-- Before this file, `internal.is_resolved` answered by kind with a literal, and
-- its `else` arm — doc, spell, skill, file, commit, and by omission every kind
-- added since 003 — returned TRUE unconditionally: existing and not deleted IS
-- resolved. After this file it answers `status_category = 'done'`. Two ripples,
-- both ruled, both intended:
--
--   * a `work_session` (and a `doc`, a `project`, a `loop`…) that reaches the
--     done category now RESOLVES a `depends_on` — the thing decision #3 asked
--     for, and the first time a non-task has ever been able to unblock anything;
--   * the mirror image: a `doc` in `to_do` now BLOCKS a hard dependency that
--     pointed at it, where before its mere existence unblocked. That is the same
--     ruling read backwards and it is the honest reading — "this task depends on
--     that doc" plainly means the doc has to be finished, not filed.
--
-- `pull_request` keeps its own answer as an explicit KIND-BEHAVIOUR OVERRIDE:
-- resolved iff the forge says merged. `pull_requests.state` is synced from the
-- forge by 103's observer and no workflow transition runs when it changes, so
-- deriving PR resolution from the category would make it stale the moment a PR
-- merged outside the product. Preserving that arm is a ruling (sub-doc 7 §3.3),
-- not an oversight.
--
-- ## The one-event law
--
-- Birth stays a BEFORE INSERT trigger writing `new.status_id` in place, so a
-- creation is still exactly one `entity.upsert`. Widening the trigger's `if`
-- from one kind to all of them does not change that; `ws-e2e.pg.test.ts`'s "the
-- mutation must be captured exactly once" is the tripwire and it now covers
-- twenty more creation paths than it did.
--
-- The BACKFILL is a bulk write to the envelope, so it takes 147's escape:
-- `alter table … disable trigger entities_capture_event` (table-owner-safe, and
-- rolled back with the migration) rather than `session_replication_role`, which
-- is superuser-only and would silence the status trigger that DERIVES the
-- category — the one trigger the backfill depends on running.
--
-- ## Gating: why a bulk write into `done` is legal
--
-- 149's `internal.validate_status_transition` refuses `to_do → done` without the
-- conditions 151 attached. It does not refuse BIRTH OR ADOPTION: `tg_op =
-- 'INSERT' or old.status_id is null` returns early, because a condition is a
-- claim about a MOVE and there is no move here. Every row this file touches has
-- `status_id is null`, so every one of them takes that arm. This is the
-- documented, ruled property (151's header, sub-doc 7 §8) that makes seeding a
-- commit straight into `done` possible without weakening a gate for anybody.
--
-- ## What this file does NOT do
--
--   * `tasks.work_status` is NOT dropped, and neither are the three things that
--     die with it (`tasks_category_bridge`, `internal.work_status_for_state`,
--     `internal.work_status_target_category`). The wire rename is phase 9 and
--     the column outlives this phase; `set_work_state` still routes through the
--     bridge and is untouched here.
--   * `internal.workflow_kind_is_executable` is NOT widened. Spawnable and
--     completable stay task-shaped; giving every kind a status is not the same
--     claim as giving every kind a spawn door, and widening it is a ruling.
--   * The `type`-axis arm inside `internal.workflow_for_entity` stays. Phase 6
--     deletes it when the axis dies.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. THE KIND → WORKFLOW LINK.
--
-- `on delete set null` rather than `restrict`: a workflow that is deleted should
-- leave the kind resolving to the built-in default — inert, exactly the posture
-- 149 chose for `workflows.kind` when the kind it names is deleted — not make
-- the workflow undeletable because a kind row happens to point at it.
-- -----------------------------------------------------------------------------
alter table public.entity_kinds
  add column workflow_id uuid references public.workflows(id) on delete set null;

comment on column public.entity_kinds.workflow_id is
  'The workflow governing entities of this kind. NULL means the built-in default '
  'workflow. Resolution order lives in internal.workflow_for_entity.';

-- A core kind is global (`space_id is null`); a custom kind belongs to one
-- space. Neither may point at another space's workflow, and a global kind may
-- only point at a global workflow — otherwise one space's vocabulary would
-- govern every space's entities of that kind. There is no declarative form of
-- "null or equal" across two nullable columns, so it is a trigger.
create or replace function internal.validate_entity_kind_workflow() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  wf_space uuid;
  wf_found boolean;
begin
  if new.workflow_id is null then
    return new;
  end if;
  select w.space_id, true into wf_space, wf_found
    from public.workflows w where w.id = new.workflow_id;
  if not coalesce(wf_found, false) then
    -- Unreachable through the FK; kept so the trigger cannot null-dereference
    -- into a misleading message if it is ever run before the constraint.
    raise exception 'workflow % does not exist', new.workflow_id using errcode = '23503';
  end if;
  if wf_space is not null and wf_space is distinct from new.space_id then
    raise exception 'kind % may not use a workflow from another space', new.kind
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'workflow_space_mismatch',
              'kindSpaceId', new.space_id,
              'workflowSpaceId', wf_space
            )::text;
  end if;
  return new;
end
$$;

create trigger entity_kinds_validate_workflow
before insert or update of workflow_id, space_id on public.entity_kinds
for each row execute function internal.validate_entity_kind_workflow();

-- -----------------------------------------------------------------------------
-- 2. ARM 0. 150 left the insertion point commented in place; this is it.
--
-- The lookup is the SAME two-step the envelope's kind validation and the UI's
-- KindRegistry both do — `(space_id, kind)` first, then the core row with
-- `space_id is null`. A one-step `space_id is not distinct from p_space_id`
-- would have matched only custom kinds, because every core kind row carries a
-- NULL `space_id` while the entities of that kind carry a real one, so a core
-- kind's workflow would have been invisible.
-- -----------------------------------------------------------------------------
create or replace function internal.workflow_for_entity(
  p_space_id uuid, p_kind text, p_type_value text
) returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(
    -- 0. the kind's own workflow — the space's row for this kind…
    (select k.workflow_id from public.entity_kinds k
      where k.kind = p_kind and k.space_id = p_space_id and k.workflow_id is not null
      limit 1),
    --    …else the core row for it.
    (select k.workflow_id from public.entity_kinds k
      where k.kind = p_kind and k.space_id is null and k.workflow_id is not null
      limit 1),
    -- 1. the space's per-type workflow (149's copy of `task_workflows`, whose
    --    `name` IS the type_value by construction). PHASE 6 DELETES THIS ARM.
    (select w.id from public.workflows w
      where w.space_id = p_space_id and w.kind = p_kind
        and p_type_value is not null and w.name = p_type_value
      limit 1),
    -- 2. THE built-in default workflow.
    (select w.id from public.workflows w where w.space_id is null limit 1)
  )
$$;

comment on function internal.workflow_for_entity(uuid, text, text) is
  'Which workflow governs an entity, in order: entity_kinds.workflow_id (space '
  'row then core row), else the space''s per-type workflow (149''s copy of '
  'task_workflows, keyed name = type_value), else THE built-in default. Phase 6 '
  'deletes the type-value arm when the type axis dies.';

-- -----------------------------------------------------------------------------
-- 3. THE SEEDING TABLE, in one place, read by both birth and backfill.
--
-- A function rather than a table because it is a CLAIM ABOUT THE KIND — the
-- same shape as `internal.is_resolved`'s pull_request arm below — and because a
-- configurable version of it is `entity_kinds.workflow_id` plus an initial state,
-- which already exists as of this file. A space that wants a different answer
-- authors a workflow; this is only the answer for the kinds tm8 ships.
--
-- `pull_request` is NOT in here: its seed is not a constant, it is a reading of
-- `pull_requests.state`, and it only applies to the backfill (a newborn PR is
-- open by construction, so `to_do` is right for it).
-- -----------------------------------------------------------------------------
create or replace function internal.kind_seeds_done(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('commit', 'message', 'file', 'memory', 'artifact')
$$;

comment on function internal.kind_seeds_done(text) is
  'Kinds whose rows are facts about the past: existence IS completion, so they '
  'are born and backfilled into the done category rather than to_do. Read by '
  'internal.seed_entity_initial_status and by 152''s backfill.';

-- -----------------------------------------------------------------------------
-- 4. BIRTH, widened from `task` to every kind.
--
-- Still BEFORE INSERT on `public.entities`, still assigning `new.status_id` in
-- place, so a creation is still ONE event. Still ordered before
-- `entities_status_from_state` ('se' < 'st'), which is what derives the category
-- from the state this trigger picks.
--
-- The `elsif new.kind = 'task'` fallback is 150's, kept verbatim and kept
-- task-only on purpose: it exists because a birth trigger that
-- null-dereferences stops every task in the product from being created, and the
-- literal it falls back to (`open`) is a TASK literal. For any other kind there
-- is nothing honest to fall back to, and the row is simply born without a
-- status — which is the state every row of every non-task kind was in before
-- this file, so the failure mode is "no worse than yesterday" rather than
-- "creation aborts". It remains unreachable: 149 seeds the built-in default and
-- makes "exactly one initial state" an invariant of every workflow row.
-- -----------------------------------------------------------------------------
create or replace function internal.seed_entity_initial_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  resolved_state uuid;
begin
  if new.status_id is null and new.status_category is null then
    if internal.kind_seeds_done(new.kind) then
      resolved_state := internal.find_workflow_state_for_category(
        internal.workflow_for_entity(new.space_id, new.kind, null), 'done');
    end if;
    if resolved_state is null then
      resolved_state := internal.workflow_initial_state(new.space_id, new.kind, null);
    end if;
    if resolved_state is not null then
      new.status_id := resolved_state;
    elsif new.kind = 'task' then
      new.status_category := internal.work_status_category('open');
    end if;
  end if;
  return new;
end
$$;

comment on function internal.seed_entity_initial_status() is
  'Birth. EVERY kind adopts a status at creation: the resolved workflow''s '
  'is_initial state, or its done state for the facts-about-the-past kinds '
  '(internal.kind_seeds_done). BEFORE INSERT and in place, so a creation stays '
  'exactly one event.';

-- -----------------------------------------------------------------------------
-- 5. THE BACKFILL.
--
-- Every row of every kind that has no status adopts one. Soft-deleted rows
-- included: `deleted_at` is the archive axis and orthogonal to status (sub-doc 7
-- §5), and a restored entity with a NULL status would be the one row in the
-- graph the four tabs cannot show.
--
-- One statement, so one pass over the table. The trigger 149 installed derives
-- `status_category` from the state — nothing here writes that column, which
-- keeps its single authority intact.
-- -----------------------------------------------------------------------------
alter table public.entities disable trigger entities_capture_event;

with seed as (
  select e.id,
         internal.workflow_for_entity(e.space_id, e.kind, null) as workflow_id,
         case
           when internal.kind_seeds_done(e.kind) then 'done'
           when e.kind = 'pull_request' then
             coalesce(
               (select case p.state when 'merged' then 'done'
                                    when 'closed' then 'cancelled'
                                    else 'to_do' end
                  from public.pull_requests p where p.entity_id = e.id),
               'to_do')
           else 'to_do'
         end as category
    from public.entities e
   where e.status_id is null
)
update public.entities e
   set status_id = coalesce(
         internal.find_workflow_state_for_category(seed.workflow_id, seed.category),
         -- A migrated per-type workflow is allowed to omit `cancelled` (132
         -- rules the vocabulary narrowable), so the ruled default is the belt.
         -- Unreachable for the kinds above, which all resolve to the built-in
         -- default workflow and its four complete categories.
         internal.find_workflow_state_for_category(seed.workflow_id, 'to_do'))
  from seed
 where seed.id = e.id;

alter table public.entities enable trigger entities_capture_event;

-- -----------------------------------------------------------------------------
-- 6. `internal.is_resolved` READS THE CATEGORY.
--
-- Six kinds' worth of literals and an `else true` that silently covered the
-- fourteen kinds added after 003, replaced by one predicate plus one declared
-- kind-behaviour override. See the header for the ripple and the ruling.
--
-- `coalesce(… , false)` rather than a bare comparison: a NULL category would
-- make this return NULL, and every caller phrases the test as
-- `not internal.is_resolved(x)`, where NULL is not FALSE — a row with no status
-- would silently stop blocking instead of blocking. After the backfill above
-- there is no such row, and this is the belt that keeps a future one honest.
-- -----------------------------------------------------------------------------
create or replace function internal.is_resolved(target uuid) returns boolean
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; resolved boolean;
begin
  select * into e from public.entities where id = target;
  if e.id is null or e.deleted_at is not null then
    return false;
  end if;
  -- THE ONE KIND-BEHAVIOUR OVERRIDE. `pull_requests.state` is synced from the
  -- forge (103) and no workflow transition runs when it moves, so the category
  -- would go stale the moment a PR merged outside the product.
  if e.kind = 'pull_request' then
    select p.state = 'merged' into resolved from public.pull_requests p
     where p.entity_id = target;
    return coalesce(resolved, false);
  end if;
  return coalesce(e.status_category = 'done', false);
end
$$;

comment on function internal.is_resolved(uuid) is
  'Does this entity resolve a depends_on? status_category = ''done'' for every '
  'kind, with pull_request overridden to the forge''s merged state. Replaces '
  '003''s per-kind literals and its else-arm that resolved on mere existence.';

-- -----------------------------------------------------------------------------
-- 7. `public.ready_to_work` READS THE CATEGORY.
--
-- `open`/`pulled` were the two `to_do` literals (147's mapping), so this is the
-- same set expressed once instead of enumerated — and it now follows a space
-- that renamed them, which the literal could not.
--
-- It stays task-shaped: the signature returns task columns and the question
-- ("what can I pull") is a task question. Widening it to every kind is not this
-- phase's, and would change what the readyToPull home preset returns.
-- -----------------------------------------------------------------------------
create or replace function public.ready_to_work(p_space_id uuid)
returns table(entity_id uuid, title text, priority text, work_status text, due_date date, sort_position double precision)
language sql stable set search_path = public, internal, pg_temp as $$
  select t.entity_id, t.title, t.priority, t.work_status, t.due_date, e.position
    from public.tasks t
    join public.entities e on e.id = t.entity_id
   where e.space_id = p_space_id
     and e.deleted_at is null
     and e.status_category = 'to_do'
     and not exists (
       select 1 from public.edges dep
        where dep.src_id = t.entity_id
          and dep.type = 'depends_on'
          and coalesce((dep.props ->> 'hard')::boolean, true)
          and not internal.is_resolved(dep.dst_id)
     )
   order by
     case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
     t.due_date nulls last, e.position, t.entity_id
$$;

-- -----------------------------------------------------------------------------
-- No revoke here, deliberately, and it is worth saying why rather than leaving
-- it to look like the omission `138_task_workflow_grant_repair.sql` exists to
-- repair. That rule is about SECURITY DEFINER functions, which run with the
-- owner's rights and so must not be executable by PUBLIC. Neither function
-- added here is a definer: both run with the caller's rights and read only
-- tables the caller can already read. `internal.kind_seeds_done` is also called
-- from a BEFORE INSERT trigger on `public.entities`, i.e. by every role that
-- creates an entity, so revoking PUBLIC without enumerating those roles is how
-- entity creation stops working for one of them. 149 and 150 took the same
-- posture for their invoker-rights `internal` helpers.
-- -----------------------------------------------------------------------------

do $verify$
declare
  n bigint;
  uncategorised bigint;
begin
  -- 5.1 Nothing is left without a status. This is THE claim of the phase.
  select count(*) into n from public.entities where status_id is null;
  if n > 0 then
    raise exception '152: % entities still have no status', n;
  end if;

  select count(*) into uncategorised from public.entities where status_category is null;
  if uncategorised > 0 then
    raise exception '152: % entities have a status but no category', uncategorised;
  end if;

  -- 5.2 The seeding table was actually applied — not merely available. Counted
  -- as a DISAGREEMENT (rows of a done-seeded kind that are not done), because a
  -- count of matching rows is vacuously satisfied by an empty database.
  select count(*) into n
    from public.entities e
   where internal.kind_seeds_done(e.kind)
     and e.status_category is distinct from 'done';
  if n > 0 then
    raise exception '152: % facts-about-the-past rows were not seeded done', n;
  end if;

  select count(*) into n
    from public.entities e
    join public.pull_requests p on p.entity_id = e.id
   where p.state = 'merged' and e.status_category is distinct from 'done';
  if n > 0 then
    raise exception '152: % merged pull requests were not seeded done', n;
  end if;

  -- 5.3 The event trigger is back on. A backfill that left it disabled would be
  -- a graph that silently stopped telling clients anything.
  select count(*) into n
    from pg_trigger
   where tgname = 'entities_capture_event'
     and tgrelid = 'public.entities'::regclass
     and tgenabled = 'O';
  if n <> 1 then
    raise exception '152: entities_capture_event is not enabled (found %)', n;
  end if;

  -- 5.4 The column exists and is nullable, which is what "unset means the
  -- built-in default" requires. Arm 0's RESOLUTION cannot be proven here — with
  -- one global workflow, pointing a kind at it and getting it back is a result
  -- arm 2 produces identically — so it is proven in
  -- `universal-status.pg.test.ts`, which can author a second workflow.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'entity_kinds'
     and column_name = 'workflow_id' and is_nullable = 'YES';
  if n <> 1 then
    raise exception '152: entity_kinds.workflow_id is missing or not nullable';
  end if;
end
$verify$;

reset role;
