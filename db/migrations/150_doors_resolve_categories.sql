-- =============================================================================
-- 150  THE THREE DOORS RESOLVE CATEGORIES.
--
-- Phase 3 of "Kind, Status, Category, Workflow", and the crux of the whole
-- change. 147 put the category on the envelope, 149 built the workflow tables
-- and a validating trigger that NOTHING has ever exercised — `status_id` is
-- NULL on every row in the database as this file begins.
--
-- This is the file that makes it non-NULL. It is therefore the first writer the
-- 149 trigger has ever had, and every invariant that file asserted is asserted
-- for real from here on.
--
-- ## What "the three doors" means, and why it is the crux
--
-- 132's header states the precondition in as many words: removing a member from
-- `task_workflows_structural_statuses` requires each of the three write doors to
-- FIRST grow its own guard. The constraint is not a wart — it is the load-bearing
-- consequence of three writes that deliberately do not consult any vocabulary:
--
--   create_task      → `tasks.work_status` DEFAULT 'open'  (001:519, via 036's body)
--   execution_spawn  → `work_status = 'working'`           (131:194-196)
--   complete_task    → `work_status = 'done'`              (082:399)
--
-- After this file each of them resolves a STATE from the entity's workflow by
-- CATEGORY. The literals stop being decisions and become a projection.
--
-- ## The one function the design named, and the three it needs around it
--
--   internal.workflow_state_for_category(p_entity_id, p_category) → uuid
--       The door resolver, exactly as sub-doc 3 specifies. Walks
--       entity → workflow → states, filters by category, returns the
--       `is_default` state else the lowest-`position` one. RAISES when the
--       workflow has no state in that category — the honest failure, and the
--       reason the per-category requirement below exists.
--
--   internal.workflow_for_entity(space, kind, type_value) → uuid
--       WHERE THE PHASE 5 SEAM IS. Today there is no kind → workflow link at
--       all (`entity_kinds.workflow_id` is phase 5), so resolution is:
--         1. the space's workflow for this kind whose NAME is the task's `type`
--            axis value — i.e. the rows 149 copied out of `task_workflows`,
--            whose `name` IS the `type_value` by construction;
--         2. otherwise THE built-in default workflow (space_id NULL).
--       Phase 5 inserts `entity_kinds.workflow_id` as step 0 and deletes step 1
--       when the `type` axis dies in phase 6. The order is encoded here, in one
--       function, so that is a one-file edit.
--
--   internal.workflow_initial_state(space, kind, type_value) → uuid
--       Birth. `is_initial` is a stronger claim than `is_default` — exactly one
--       per workflow, and it must be `to_do` (149 enforces all three ways) — so
--       creation resolves it by that flag rather than by category.
--
--   internal.work_status_for_state(p_state_id) → text
--       THE TRANSITIONAL INVERSE, and the only genuinely ugly thing here. See
--       "the two columns" below. It dies with `tasks.work_status` in phase 5.
--
-- ## The two columns, and why this file has to write both
--
-- `tasks.work_status` still exists, still carries a DDL CHECK naming exactly
-- seven literals, and is still what 132's vocabulary trigger, the projector, the
-- read path and every board column read. `entities.status_id` is the future and
-- is NULL everywhere. Phase 5 folds the first into the second. Until then a door
-- that wrote only one of them would be writing a lie into the other.
--
-- So the doors resolve a STATE and then PROJECT it onto the legacy column:
--
--     state name is one of the seven  → write the name  (every migrated workflow;
--                                        `working`, `in_review`, `blocked` stay
--                                        distinct, which a category-only
--                                        projection would flatten)
--     otherwise                       → write the category's canonical literal
--                                        (the built-in default's states are
--                                        DISPLAY names — "In Progress" — and 149
--                                        chose that asymmetry deliberately)
--
-- and the reverse — legacy `work_status` writer → `status_id` — is one trigger,
-- described next.
--
-- ## ONE authority on `status_category`, and how 147's two triggers are retired
--
-- 147 shipped two TRANSITIONAL writers of `entities.status_category` and said in
-- its own header that phase 3's doors are what replace them. This file replaces
-- both, and the replacement is not a deletion, because deleting them would
-- regress a filter that shipped in phase 1:
--
--   `entities_seed_status_category` (147:186) wrote the category for a newborn
--       task from the literal 'open'. It BECOMES `entities_seed_initial_status`,
--       which writes `status_id` — the initial state of the resolved workflow —
--       and lets 149's `entities_status_from_state` DERIVE the category from it.
--       Still BEFORE INSERT on `entities`, which is what keeps a creation ONE
--       event (147's header, and `ws-e2e.pg.test.ts` "the mutation must be
--       captured exactly once" is the tripwire).
--
--   `tasks_category` (147:233) wrote the category from `tasks.work_status`. It
--       BECOMES the BRIDGE: it writes `status_id`, not the category, and 149's
--       trigger derives the category from the state. It cannot be dropped
--       because `set_work_state` is a fourth writer of `work_status` and is
--       explicitly NOT this phase's to touch (re-keying its `done` refusal by
--       category is phase 4) — without the bridge, every open→pulled→working
--       move would leave `status_id` pointing at the state the task has left.
--
-- The result is that `entities.status_category` has exactly ONE authority: the
-- state row, via 149's trigger. Nothing in this file assigns that column. The
-- single exception is documented at the bridge itself and is unreachable through
-- any door today.
--
-- ## The consequence to expect: transitions are now VALIDATED
--
-- 149's `entities_status_from_state` refuses a move the ruled category set does
-- not allow. Every path above now goes through it, so two moves that the literal
-- world permitted are refused from here on:
--
--   * `set_work_state` from a `done`/`cancelled` task straight to
--     `working`/`in_review`/`blocked` — `done → in_progress` is not in the ruled
--     set. Reopening goes `done → to_do` (open, pulled) first, which IS ruled.
--   * `complete_task` on a `cancelled` task — `cancelled → done` is not ruled
--     either; the ruled reading is that done comes from to_do or in_progress.
--
-- Both are the RULED behaviour arriving, not new rules invented here, and both
-- refuse with 149's machine-readable `transition_not_allowed` detail rather than
-- a bare sqlstate. They bite only rows that have adopted a status: a task whose
-- `status_id` is still NULL takes 149's "birth or adoption" arm, so no existing
-- row in any database changes behaviour until something moves it.
--
-- ## What this file does NOT do (phase 4, deliberately)
--
--   * `task_workflows_structural_statuses` is NOT dropped. The per-category
--     requirement below is the thing that has to exist FIRST; dropping the
--     structural three is phase 4's, after the completion gate moves.
--   * The completion gate does NOT move onto the transition. It still sits
--     inside `complete_task` — the acceptance-criteria loop and the
--     `completion_gate = 'pr_merged'` block, both reproduced verbatim below, at
--     the same place 082 put them. That is where phase 4 lifts them from.
--   * `set_work_state` is untouched. Its `done` refusal is still keyed on the
--     literal (060:36).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- THE RESOLUTION ORDER, and the phase 5 seam.
--
-- `p_type_value` is the task's `type` axis value or NULL. 132 keyed the whole
-- vocabulary mechanism on that axis and 149 copied each `task_workflows` row to
-- a workflow whose `name` IS the `type_value`, so a lookup by name is the join
-- those two files already agreed on — not a new convention.
--
-- A space with no `task_workflows` row for the value (or a task with no type at
-- all, which is most of them) falls through to the built-in default. That is the
-- same "never touched" posture 132's trigger takes for the same inputs.
-- -----------------------------------------------------------------------------
create or replace function internal.workflow_for_entity(
  p_space_id uuid, p_kind text, p_type_value text
) returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  -- PHASE 5 INSERTS ITS ARM HERE, first:
  --   select workflow_id from public.entity_kinds
  --    where kind = p_kind and space_id is not distinct from p_space_id
  --      and workflow_id is not null
  select coalesce(
    (select w.id from public.workflows w
      where w.space_id = p_space_id and w.kind = p_kind
        and p_type_value is not null and w.name = p_type_value
      limit 1),
    (select w.id from public.workflows w where w.space_id is null limit 1)
  )
$$;

comment on function internal.workflow_for_entity(uuid, text, text) is
  'Which workflow governs an entity. THE PHASE 5 SEAM: today there is no '
  'kind -> workflow link, so it is the space''s per-type workflow (149''s copy of '
  'task_workflows, keyed name = type_value) else THE built-in default. Phase 5 '
  'adds entity_kinds.workflow_id as the first arm; phase 6 deletes the second.';

-- -----------------------------------------------------------------------------
-- The category default, by workflow. `is_default` is a TIEBREAK and nothing
-- more (149:210): unset means lowest position wins, which is what lets a freshly
-- authored workflow resolve correctly with nobody having set a flag.
--
-- Returns NULL rather than raising. The raising version is the door resolver
-- below; the bridge needs the quiet one, because a migrated workflow is allowed
-- to omit `cancelled` (132 rules it narrowable) and a trigger that raised there
-- would turn a legal `set_work_state` into an abort.
-- -----------------------------------------------------------------------------
create or replace function internal.find_workflow_state_for_category(
  p_workflow_id uuid, p_category text
) returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select s.id from public.workflow_states s
   where s.workflow_id = p_workflow_id and s.category = p_category
   order by s.is_default desc, s.position asc
   limit 1
$$;

-- -----------------------------------------------------------------------------
-- THE DOOR RESOLVER. Signature exactly as sub-doc 3 specifies.
--
-- It raises when the workflow has no state in the category, and the raise is the
-- point: a door that silently wrote nothing would leave a spawned task looking
-- unstarted forever. The per-category requirement at the bottom of this file is
-- what makes the raise unreachable for the kinds that can actually spawn and
-- complete — the requirement and this raise are two halves of one decision.
-- -----------------------------------------------------------------------------
create or replace function internal.workflow_state_for_category(
  p_entity_id uuid, p_category text
) returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  type_value text;
  wf_id uuid;
  resolved_state uuid;
begin
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then
    raise exception 'entity % not found', p_entity_id using errcode = 'P0002';
  end if;

  -- The `type` axis is a TASK concept and this function is not. Every other kind
  -- resolves with a NULL type value, which is the built-in default arm.
  if e.kind = 'task' then
    select nullif(btrim(coalesce(t.axes ->> 'type', '')), '') into type_value
      from public.tasks t where t.entity_id = p_entity_id;
  end if;

  wf_id := internal.workflow_for_entity(e.space_id, e.kind, type_value);
  if wf_id is null then
    raise exception 'no workflow governs entity %', p_entity_id
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'no_workflow_for_entity',
              'entityId', p_entity_id,
              'kind', e.kind
            )::text;
  end if;

  resolved_state := internal.find_workflow_state_for_category(wf_id, p_category);
  if resolved_state is null then
    raise exception 'workflow % has no % state', wf_id, p_category
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'workflow_missing_category',
              'workflowId', wf_id,
              'category', p_category,
              'entityId', p_entity_id
            )::text;
  end if;
  return resolved_state;
end
$$;

comment on function internal.workflow_state_for_category(uuid, text) is
  'THE door resolver (sub-doc 3). entity -> workflow -> states, filtered by '
  'category, is_default else lowest position. RAISES when the workflow has no '
  'state in the category — the honest failure, and the reason a workflow for a '
  'spawnable/completable kind is REQUIRED to carry in_progress and done states.';

-- -----------------------------------------------------------------------------
-- Birth. Resolved by `is_initial`, not by category: 149 makes it exactly one per
-- workflow and forces it to be `to_do`, so it is a stronger and more specific
-- claim than "the default to_do state", and creation is precisely where the
-- stronger claim is the one you want.
-- -----------------------------------------------------------------------------
create or replace function internal.workflow_initial_state(
  p_space_id uuid, p_kind text, p_type_value text
) returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select s.id from public.workflow_states s
   where s.workflow_id = internal.workflow_for_entity(p_space_id, p_kind, p_type_value)
     and s.is_initial
   limit 1
$$;

-- -----------------------------------------------------------------------------
-- THE TRANSITIONAL INVERSE. `tasks.work_status` is not retired until phase 5 and
-- carries a DDL CHECK naming exactly seven literals, so a door that resolved
-- "Shipped" cannot write "Shipped" there.
--
-- Name first, category second, and the order matters. A category-only projection
-- would collapse `working`, `in_review` and `blocked` — three distinct states of
-- every migrated workflow — into one literal, silently destroying the board
-- column a space is already using. A name match keeps them, and only the states
-- the legacy column CANNOT represent (the built-in default's display names) fall
-- back to the category's canonical literal.
--
-- The canonical literals are the structural three plus `cancelled`, i.e. exactly
-- 132's guaranteed vocabulary members, so the projection can never write a
-- status a space's workflow forbids.
--
-- THIS FUNCTION DIES WITH `tasks.work_status` IN PHASE 5. It has no other use.
-- -----------------------------------------------------------------------------
create or replace function internal.work_status_for_state(p_state_id uuid)
returns text language sql stable set search_path = public, internal, pg_temp as $$
  select case
    when s.name = any (array['open','pulled','working','in_review','blocked','done','cancelled'])
      then s.name
    else case s.category
      when 'to_do'       then 'open'
      when 'in_progress' then 'working'
      when 'done'        then 'done'
      when 'cancelled'   then 'cancelled'
    end
  end
  from public.workflow_states s where s.id = p_state_id
$$;

comment on function internal.work_status_for_state(uuid) is
  'TRANSITIONAL: projects a workflow state onto the legacy tasks.work_status '
  'vocabulary. The state NAME when the legacy column can hold it (every migrated '
  'workflow), else the category''s canonical literal. Dies with the column in '
  'phase 5.';

-- -----------------------------------------------------------------------------
-- The bridge's own resolver: legacy literal -> state, the inverse of the above.
--
-- Name first for the same reason and with the same result, so the round trip
-- state -> literal -> state is the identity on every workflow that exists: a
-- migrated workflow matches by name; the built-in default has no state named
-- `working`, so the literal resolves back through the category to the same state
-- the door picked. That identity is what makes a `create_task` stay ONE event —
-- the bridge fires on the `tasks` insert, resolves the state the envelope
-- already carries, finds it equal, and updates nothing.
-- -----------------------------------------------------------------------------
create or replace function internal.workflow_state_for_work_status(
  p_entity_id uuid, p_work_status text
) returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  type_value text;
  wf_id uuid;
  resolved_state uuid;
begin
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then return null; end if;

  select nullif(btrim(coalesce(t.axes ->> 'type', '')), '') into type_value
    from public.tasks t where t.entity_id = p_entity_id;

  wf_id := internal.workflow_for_entity(e.space_id, e.kind, type_value);
  if wf_id is null then return null; end if;

  select s.id into resolved_state from public.workflow_states s
   where s.workflow_id = wf_id and s.name = p_work_status;
  if resolved_state is not null then return resolved_state; end if;

  return internal.find_workflow_state_for_category(
    wf_id, internal.work_status_category(p_work_status));
end
$$;

-- =============================================================================
-- 147'S TWO TRANSITIONAL TRIGGERS, REPLACED.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. BIRTH. Was `entities_seed_status_category`; writes `status_id` now and lets
--    149's trigger derive the category from it.
--
-- STILL BEFORE INSERT ON `public.entities`, and that is the whole reason this is
-- a trigger rather than a line in each create door. An entity is TWO inserts
-- (`entities`, then the detail table) and `entities_capture_event` is AFTER
-- INSERT per row, so anything written to the envelope from the detail side
-- DOUBLES the creation event. Writing it into NEW here means `to_jsonb(new)`
-- already carries the status when the capture trigger reads it.
--
-- It cannot see the `type` axis — the `tasks` row does not exist yet at BEFORE
-- INSERT — so it resolves with a NULL type value, i.e. the built-in default.
-- `create_task` KNOWS the axes and passes the type-aware state in explicitly
-- (see `internal.create_envelope` below); this trigger is guarded on
-- `status_id is null` and leaves that alone. The two other task-creating doors
-- (064's `derive_task_for_entity`, 099's thread derivation) insert no axes at
-- all, so the built-in default is the right answer for them and they need no
-- edit — which is why this stayed a trigger.
--
-- Trigger firing order among BEFORE INSERT triggers on `public.entities` is
-- alphabetical, and `entities_seed_initial_status` < `entities_status_from_state`
-- still holds ('se' < 'st'). 149's header depends on that ordering; renaming
-- kept it.
-- -----------------------------------------------------------------------------
drop trigger entities_seed_status_category on public.entities;
drop function internal.seed_entity_status_category();

create or replace function internal.seed_entity_initial_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  resolved_state uuid;
begin
  if new.status_id is null and new.status_category is null and new.kind = 'task' then
    resolved_state := internal.workflow_initial_state(new.space_id, new.kind, null);
    if resolved_state is not null then
      new.status_id := resolved_state;
    else
      -- Unreachable: the built-in default workflow is seeded by 149 and 149's
      -- deferred trigger makes "exactly one initial state" an invariant of every
      -- workflow row. Kept because a birth trigger that null-dereferences is a
      -- birth trigger that stops every task in the product from being created,
      -- and 147's behaviour is a correct answer to fall back to.
      new.status_category := internal.work_status_category('open');
    end if;
  end if;
  return new;
end
$$;

create trigger entities_seed_initial_status
before insert on public.entities
for each row execute function internal.seed_entity_initial_status();

-- -----------------------------------------------------------------------------
-- 2. THE BRIDGE. Was `tasks_category`; writes `status_id` now.
--
-- Every writer of `tasks.work_status` passes through here: the three doors, and
-- `set_work_state`, which this phase does not touch. Writing `status_id` (rather
-- than the category) is what leaves `entities.status_category` with exactly ONE
-- authority — the state row, via 149's trigger — instead of two that can
-- disagree, which is the thing 147's header flagged and asked phase 3 to settle.
--
-- `is distinct from` is not an optimization, it is the event posture 147 chose
-- and this keeps: a zero-row UPDATE emits no `entity.upsert`, so a status move
-- that resolves to the state the entity is already in tells no client anything.
-- It is also what makes the INSERT arm free and keeps a creation ONE event.
--
-- Firing order among AFTER triggers on `public.tasks` is alphabetical:
-- `tasks_announce_unblocked` < `tasks_category_bridge` < `tasks_snapshot_version`.
-- Unchanged from 147's reasoning, and it still matters: the category is written
-- before `snapshot_entity_version` bumps `entities.version`, so the last event a
-- client sees for a status edit carries both the new version and the new
-- category in one row.
-- -----------------------------------------------------------------------------
drop trigger tasks_category on public.tasks;
drop function internal.sync_entity_status_category();

create or replace function internal.bridge_task_status_to_state() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  resolved_state uuid := internal.workflow_state_for_work_status(new.entity_id, new.work_status);
begin
  if resolved_state is not null then
    update public.entities
       set status_id = resolved_state
     where id = new.entity_id
       and status_id is distinct from resolved_state;
    return new;
  end if;

  -- THE ONE REMAINING DIRECT WRITE OF THE COLUMN, and it is unreachable through
  -- any door today: it needs a workflow with no state of the status's category
  -- at all, and for a TYPED task 132's vocabulary trigger has already refused
  -- the status by then (a workflow's states ARE its vocabulary, 149's copy), while
  -- an untyped task resolves to the built-in default, which has all four. It
  -- exists so that a future workflow which genuinely cannot express a status
  -- degrades to 147's exact behaviour rather than leaving the category stale.
  update public.entities
     set status_category = internal.work_status_category(new.work_status)
   where id = new.entity_id
     and status_category is distinct from internal.work_status_category(new.work_status);
  return new;
end
$$;

create trigger tasks_category_bridge
after insert or update of work_status on public.tasks
for each row execute function internal.bridge_task_status_to_state();

-- =============================================================================
-- THE PER-CATEGORY REQUIREMENT — what replaces the structural three.
--
-- 132 forces {open, working, done} into every vocabulary because three doors
-- write those literals blind. This file makes the doors resolve instead, so the
-- requirement becomes a claim about CATEGORIES and about what the kind can
-- actually DO:
--
--     every workflow                      >= 1 to_do state
--     spawnable or completable kinds      >= 1 in_progress AND >= 1 done state
--
-- The to_do arm is already implied by 149's exactly-one-initial rule (an initial
-- state must be `to_do`), and is asserted anyway: the two rules are independent
-- claims and the day someone relaxes one is the day the other has to still hold.
--
-- THE STRUCTURAL CONSTRAINT IS NOT DROPPED HERE. Sub-doc 3's ordering is
-- explicit: the doors change, then the gate moves onto the transition, and only
-- THEN does `task_workflows_structural_statuses` go. This file is step 3 of 6.
--
-- Deferred, on both tables, for exactly 149's reasons: at-least-one is a claim
-- about the absence of a row and is false for the whole duration of a legal
-- write, and deleting a workflow cascades its states away and must not then trip
-- a rule about them.
-- =============================================================================
create or replace function internal.workflow_kind_is_executable(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  -- Spawnable AND completable are the same set today: `execution_spawn` and
  -- `complete_task` both take a `task`, and the built-in default (kind NULL)
  -- governs tasks among everything else. Phase 5 gives twenty kinds a status and
  -- phase 6 gives `c:` kinds a `base_kind`; both widen THIS function — the
  -- predicate is deliberately one place rather than inlined into the assertion.
  select p_kind is null or p_kind = 'task'
$$;

create or replace function internal.assert_workflow_category_coverage() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  -- NOT initialized in DECLARE, and for the reason 149:294 writes out at length:
  -- a declaration default is evaluated before the body, so referencing
  -- `new.workflow_id` there raises the instant this is attached to `workflows`.
  target uuid;
  workflow_kind text;
  required text[];
  missing text[];
  required_category text;
begin
  if tg_table_name = 'workflows' then
    target := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    target := case when tg_op = 'DELETE' then old.workflow_id else new.workflow_id end;
  end if;

  select w.kind into workflow_kind from public.workflows w where w.id = target;
  if not found then
    return null;
  end if;

  required := case when internal.workflow_kind_is_executable(workflow_kind)
                   then array['to_do', 'in_progress', 'done']
                   else array['to_do'] end;
  missing := '{}'::text[];
  foreach required_category in array required loop
    if not exists (
      select 1 from public.workflow_states s
       where s.workflow_id = target and s.category = required_category
    ) then
      missing := missing || required_category;
    end if;
  end loop;

  if cardinality(missing) > 0 then
    raise exception 'workflow % is missing required categories: %', target, missing
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'workflow_missing_required_categories',
              'workflowId', target,
              'kind', workflow_kind,
              'missing', to_jsonb(missing)
            )::text;
  end if;
  return null;
end
$$;

comment on function internal.assert_workflow_category_coverage() is
  'The per-category requirement that REPLACES task_workflows_structural_statuses '
  '(dropped in phase 4, not here). Every workflow needs a to_do state; a workflow '
  'governing a spawnable/completable kind also needs in_progress and done, which '
  'is exactly what makes internal.workflow_state_for_category''s raise '
  'unreachable at the spawn and complete doors.';

create constraint trigger workflows_assert_category_coverage
after insert or update on public.workflows
deferrable initially deferred
for each row execute function internal.assert_workflow_category_coverage();

create constraint trigger workflow_states_assert_category_coverage
after insert or update or delete on public.workflow_states
deferrable initially deferred
for each row execute function internal.assert_workflow_category_coverage();

-- =============================================================================
-- THE DOORS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The envelope gains an optional status.
--
-- DROP and CREATE, not `create or replace`: adding a defaulted parameter makes a
-- new signature rather than replacing the old one, and the five-argument calls
-- in 007, 017, 036, 064, 099, 111, 129 and 131 would then match BOTH candidates
-- and fail as "function is not unique". Dropping first leaves exactly one
-- function, which every existing positional call resolves to with the new
-- parameter defaulted — plpgsql bodies resolve their callees at run time, so no
-- caller needs re-issuing.
--
-- It is `internal`, called only from migration-defined doors, and carried no
-- grants of its own to restore.
-- -----------------------------------------------------------------------------
drop function internal.create_envelope(uuid, text, uuid, uuid, double precision);

create function internal.create_envelope(
  p_space_id uuid, p_kind text, p_actor uuid, p_parent_id uuid, p_position double precision,
  p_status_id uuid default null
) returns uuid language plpgsql set search_path = public, internal, pg_temp as $$
declare new_id uuid := internal.new_id();
begin
  -- `status_id` rides the INSERT rather than following it. An UPDATE here would
  -- be a second `entity.upsert` for one creation — the one-event law, 147:146.
  insert into public.entities(id, space_id, kind, parent_id, position, created_by, status_id)
  values (new_id, p_space_id, p_kind, p_parent_id, p_position, p_actor, p_status_id);
  return new_id;
end
$$;

-- -----------------------------------------------------------------------------
-- DOOR 1 — `create_task`. 036's body (the live definition), with the initial
-- state resolved and handed to the envelope.
--
-- Note what is NOT here: a `work_status` write. There never was one — the
-- literal 'open' came from the column DEFAULT (001:519), which is why the
-- structural constraint listed creation as depending on `open` ∈ statuses. The
-- default still stands and the bridge maps it back to the same state, so a
-- created task carries a status_id from the envelope insert and a work_status
-- from the column default, and the two agree by construction. Phase 5 deletes
-- the second half of that sentence.
--
-- The type axis is read from `p_axes`, not from the `tasks` row, because the
-- `tasks` row does not exist until three lines later — and it is the reason this
-- door resolves explicitly instead of leaning on the birth trigger like 064 and
-- 099 do.
-- -----------------------------------------------------------------------------
create or replace function public.create_task(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_axes jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_priority text default 'medium',
  p_acceptance_criteria jsonb default '[]'::jsonb, p_points_estimate integer default null,
  p_due_date date default null, p_attach_to uuid default null,
  p_attach_edge_type text default 'attached_to', p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  task_id uuid;
  activity_id uuid;
  result jsonb;
  initial_state uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.create');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  -- 150: the workflow's INITIAL state, not the literal 'open'.
  initial_state := internal.workflow_initial_state(
    p_space_id, 'task',
    nullif(btrim(coalesce(coalesce(p_axes, '{}'::jsonb) ->> 'type', '')), ''));

  task_id := internal.create_envelope(p_space_id, 'task', actor, p_parent_id, p_position,
                                      initial_state);
  insert into public.tasks(entity_id, title, description, axes, priority,
                           acceptance_criteria, points_estimate, due_date)
  values (task_id, p_title, coalesce(p_description, ''), coalesce(p_axes, '{}'::jsonb),
          coalesce(p_priority, 'medium'), coalesce(p_acceptance_criteria, '[]'::jsonb),
          p_points_estimate, p_due_date);
  perform internal.record_initial_version(task_id, actor);
  perform internal.attach_on_create(p_space_id, task_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, task_id, actor, 'created',
                   null, jsonb_build_object('kind', 'task'));

  result := internal.command_result(task_id, null, activity_id, array[task_id]);
  return internal.ledger_record(p_client_mutation_id, 'entities.create', result);
end
$$;

-- -----------------------------------------------------------------------------
-- DOOR 2 — `execution_spawn`. 131's body verbatim except the marked block.
--
-- ⚠ 131's MERGE HAZARD IS STILL LIVE and now has a third participant. 129 and
-- 131 both issue `create or replace function public.execution_spawn` and edit
-- adjacent lines of the same loop; this file is the third, and GIT WILL SHOW NO
-- CONFLICT with either, because the three files never touch. The body below is
-- 131's — the highest-numbered, therefore the live definition — with 129's
-- `assigned_to` insert left exactly as 131 left it (`on conflict do nothing`;
-- 129's own BEFORE trigger at 129:37 is what fills `assigned_by` from
-- `created_by`, so the provenance still lands). Anyone replacing this function
-- again must union the bodies rather than take one whole. The detectors are
-- `spawn-starts-the-task.pg.test.ts` and `assignment-provenance.pg.test.ts`,
-- which both run against a real PostgreSQL in CI.
--
-- THE CHANGE, in two halves:
--
--   the GUARD  `and work_status in ('open','pulled')` becomes
--              `and e.status_category = 'to_do'`. MORE correct than the literal
--              list, not merely different: a space that authored a third `to_do`
--              status is skipped by the list today and is picked up by the
--              category. The set is identical for every space that exists.
--
--   the VALUE  the literal 'working' becomes the workflow's default
--              `in_progress` state, projected onto the legacy column. The
--              resolver RAISES if the workflow has no `in_progress` state, which
--              is exactly the failure the per-category requirement above makes
--              unreachable; the raise is evaluated in the SET clause, so it is
--              reached only for rows the WHERE already matched — a task that is
--              not in `to_do` cannot abort a spawn.
--
-- `returning ... into` rather than a separate select, so that the `if found`
-- gate stays ADJACENT to the UPDATE. 131's warning is exact: FOUND reflects the
-- LAST statement executed, and the two edge inserts sit immediately above.
-- RETURNING INTO on a zero-row UPDATE leaves FOUND false and the variable NULL,
-- which is the behaviour the gate wants.
--
-- ⚠ `reset role`, AND IT IS NOT COSMETIC. Unlike `create_task` (036) and
-- `complete_task` (082), NONE of the five migrations that have written this
-- function (043, 048, 111, 129, 131) issues `set role tm8_graph_owner` — so
-- `public.execution_spawn` is owned by the APPLIER, not by the schema owner, and
-- the `revoke`/`grant` pair below fails with "must be owner of function
-- execution_spawn" under the role this file otherwise runs as. (Measured, not
-- assumed: that is exactly how this file first failed.) Reproducing 131's
-- posture is the fix; changing the owner here is not, because it would silently
-- move a function five other migrations expect to own.
-- -----------------------------------------------------------------------------
reset role;

create or replace function public.execution_spawn(
  p_space_id uuid, p_team_member_id uuid, p_task_ids uuid[] default '{}'::uuid[],
  p_project_id uuid default null, p_workdir_mode text default 'project',
  p_workdir_path text default null, p_base_ref text default null,
  p_mode text default null, p_model text default null, p_agent_tool text default null,
  p_title text default null, p_node_id text default null,
  p_confirm_untrusted boolean default false, p_session_cap integer default 8,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_parent_session_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  persona public.entities;
  project public.projects;
  parent_session public.entities;
  session_id uuid;
  task_id uuid;
  patches uuid[];
  started_status text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  persona := internal.live_entity(p_team_member_id, 'team_member');
  if persona.space_id <> p_space_id then
    raise exception 'persona belongs to another space' using errcode = '22023';
  end if;
  if not internal.can_act_as(p_team_member_id, p_space_id) then
    raise exception 'not permitted to spawn this persona' using errcode = '42501';
  end if;

  if p_parent_session_id is not null then
    parent_session := internal.live_entity(p_parent_session_id, 'work_session');
    if parent_session.space_id <> p_space_id then
      raise exception 'parent session belongs to another space' using errcode = '22023';
    end if;
  end if;

  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.live_work_session_count(null))::text;
  end if;

  if p_project_id is not null then
    select * into project from public.projects where id = p_project_id;
    if project.id is null then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.space_projects
                    where space_id = p_space_id and project_id = p_project_id) then
      raise exception 'project is not linked to this space' using errcode = '42501';
    end if;
    if project.trust = 'untrusted' and not coalesce(p_confirm_untrusted, false) then
      raise exception 'spawning into an untrusted project requires explicit confirmation'
        using errcode = '42501',
              detail = jsonb_build_object('projectId', p_project_id, 'trust', project.trust)::text;
    end if;
  elsif coalesce(p_workdir_mode, 'project') = 'worktree' then
    raise exception 'worktree mode requires a project' using errcode = '22023';
  end if;

  session_id := internal.create_envelope(
    p_space_id, 'work_session', actor, p_parent_session_id, null
  );
  insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                   workdir_path, base_ref, status, agent_tool, model, mode)
  values (session_id, coalesce(p_title, ''), p_node_id, p_project_id,
          coalesce(p_workdir_mode, 'project'), p_workdir_path, p_base_ref,
          'spawning', p_agent_tool, p_model, p_mode);

  patches := array[session_id];
  foreach task_id in array coalesce(p_task_ids, '{}'::uuid[]) loop
    perform internal.live_entity(task_id, 'task');
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, session_id, task_id, 'working_on', actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- ADDED IN 111. The durable half of the same fact. Inside the loop and
    -- inside this transaction, so a task cannot end up naming an assignee for a
    -- session that was rolled back.
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (p_space_id, task_id, p_team_member_id, 'assigned_to',
            jsonb_build_object('via', 'spawn'), actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- ADDED IN 131, REKEYED IN 150. The task has started. The `where` is still
    -- the whole rule — only a task that has not started yet can be started — but
    -- "has not started" is now the CATEGORY, not a list of two literals, and the
    -- status written is the workflow's own `in_progress` state.
    update public.tasks t
       set work_status = internal.work_status_for_state(
             internal.workflow_state_for_category(t.entity_id, 'in_progress')),
           updated_at = now()
     where t.entity_id = task_id
       and exists (select 1 from public.entities e
                    where e.id = t.entity_id and e.status_category = 'to_do')
    returning t.work_status into started_status;
    -- ⚠ KEEP THIS ADJACENT TO THE UPDATE ABOVE. `FOUND` reflects the LAST
    -- statement executed, not the last UPDATE. The two edge inserts above both
    -- set it, so a statement inserted between the UPDATE and this `if` turns
    -- the honesty gate into a lie that no test would catch: the cases below
    -- assert the count of `work.changed` rows, and a gate reading a preceding
    -- insert's FOUND would still satisfy most of them.
    if found then
      perform internal.record_activity(p_space_id, task_id, actor, 'work.changed', null,
        jsonb_build_object('status', started_status, 'via', 'spawn'));
    end if;
    patches := patches || task_id;
  end loop;
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (p_space_id, session_id, p_team_member_id, 'relates_to', actor)
  on conflict (src_id, dst_id, type) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'execution.spawn',
           internal.command_result(session_id, null,
             internal.record_activity(p_space_id, session_id, actor, 'created', null,
               jsonb_build_object(
                 'kind', 'work_session',
                 'teamMemberId', p_team_member_id,
                 'parentSessionId', p_parent_session_id
               )),
             patches)) || jsonb_build_object('__tm8_replayed', false);
end
$$;

-- `create or replace` keeps the grants; restated so a reader of this file alone
-- does not have to go and check that it did. Same pair 131 restated, verbatim.
revoke all on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) from public;

grant execute on function public.execution_spawn(
  uuid, uuid, uuid[], uuid, text, text, text, text, text, text, text, text,
  boolean, integer, uuid, text, uuid
) to tm8_app;

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- DOOR 3 — `complete_task`. 082's body verbatim except the status write.
--
-- BOTH GATES ARE REPRODUCED UNCHANGED AND IN PLACE: the acceptance-criteria loop
-- and the `completion_gate = 'pr_merged'` block, at the same point 082 put them,
-- immediately before the status write. PHASE 4 LIFTS THEM FROM HERE onto
-- `workflow_transitions.conditions` for the →done transition. They are still
-- keyed on the literal `'done'` by way of the `already complete` check above
-- them; that re-keying is phase 4's too, and it is safe until then because the
-- resolver's projection writes the literal `done` for every workflow whose done
-- state the legacy column cannot name.
--
-- One behaviour follows from the resolver rather than from any line here: a
-- CANCELLED task can no longer be completed. `cancelled → done` is not in the
-- ruled category set, so 149's trigger refuses the move with
-- `transition_not_allowed`. That is the ruled design arriving at its first
-- writer, and it bites only tasks that have already adopted a status.
-- -----------------------------------------------------------------------------
create or replace function public.complete_task(
  p_task_id uuid, p_expected_version integer, p_completer_ids uuid[] default '{}'::uuid[],
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  completer uuid;
  task public.tasks;
  activity_id uuid;
  patches uuid[];
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.complete');
  if replay is not null then return replay; end if;
  select * into e from public.entities where id = p_task_id and kind = 'task' and deleted_at is null for update;
  if e.id is null then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);

  select * into task from public.tasks where entity_id = p_task_id;
  if task.work_status = 'done' then
    raise exception 'task is already complete' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(task.acceptance_criteria) c
     where not coalesce((c ->> 'done')::boolean, false)
  ) then
    raise exception 'all acceptance criteria must be complete first' using errcode = '23514';
  end if;

  -- 082: the opt-in git-facts gate. See 082's C4 header for the refusal
  -- conditions. PHASE 4 MOVES THIS BLOCK (and the criteria check above it) onto
  -- the →done transition's `conditions`.
  if task.completion_gate = 'pr_merged' then
    if not exists (
      select 1 from public.edges ed
        join public.pull_requests pr on pr.entity_id = ed.dst_id
       where ed.src_id = p_task_id and ed.type = 'tracks'
    ) then
      raise exception 'completion gate pr_merged: no tracked pull request on this task'
        using errcode = '23514', detail = '{"reason":"gate_no_tracked_pr"}';
    end if;
    if exists (
      select 1 from public.edges ed
        join public.pull_requests pr on pr.entity_id = ed.dst_id
       where ed.src_id = p_task_id and ed.type = 'tracks'
         and (pr.state <> 'merged' or pr.ci_status = 'failing')
    ) then
      raise exception 'completion gate pr_merged: a tracked pull request is unmerged or CI-red'
        using errcode = '23514', detail = '{"reason":"gate_pr_unmerged_or_ci_red"}';
    end if;
  end if;

  patches := array[p_task_id];
  -- 150: the workflow's default `done` state, not the literal.
  update public.tasks
     set work_status = internal.work_status_for_state(
           internal.workflow_state_for_category(p_task_id, 'done')),
         updated_at = now()
   where entity_id = p_task_id;

  foreach completer in array coalesce(p_completer_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.entities c
       where c.id = completer and c.space_id = e.space_id
         and c.kind in ('member','team_member') and c.deleted_at is null
    ) then
      raise exception 'invalid completer %', completer using errcode = '23503';
    end if;
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (e.space_id, p_task_id, completer, 'completed_by', actor)
    on conflict (src_id, dst_id, type) do nothing;
    -- The award is idempotent per (command, completer): a retry of the same
    -- completion cannot pay twice, which is why the key includes both.
    insert into public.point_events(space_id, entity_id, actor_id, amount, reason, ref_id, client_event_id)
    select e.space_id, completer, actor, task.points_estimate, 'award', p_task_id,
           case when p_client_mutation_id is null then null
                else p_client_mutation_id || ':award:' || completer::text end
     where coalesce(task.points_estimate, 0) > 0
    on conflict (client_event_id) do nothing;
    patches := patches || completer;
  end loop;

  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'completed', null,
                   jsonb_build_object('completerIds', to_jsonb(coalesce(p_completer_ids, '{}'::uuid[]))));
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.complete',
           internal.command_result(p_task_id, null, activity_id, patches));
end
$$;

-- =============================================================================
-- BACKFILL: every task adopts the status it is already in.
--
-- `status_id` is NULL on every row in the database at this point. Leaving it
-- that way would mean the first status move of each existing task takes 149's
-- "birth or adoption" arm — correct, but it would also mean the column stays a
-- promise for months on the tasks nobody touches, and phase 5's universal-status
-- work would inherit a table that is half migrated for no reason.
--
-- The write targets the ENVELOPE, not `public.tasks`, so 132's per-row
-- vocabulary trigger is not in the path and the escape 132's header sanctions
-- (`session_replication_role = replica`) is not the one this needs. 147's
-- precedent applies exactly: disable the ONE trigger whose firing would be
-- wrong — `entities_capture_event`, which would otherwise emit one synthetic
-- `entity.upsert` per task in every space, attributed to nobody, at an unchanged
-- version. Owner-safe, and rolled back by `migrate.mjs -1`.
--
-- `entities_status_from_state` is deliberately LEFT ON: it is what derives
-- `status_category`, and every row here takes its "adoption" arm (old status_id
-- is NULL) so no transition rule is applied to a status nobody chose.
--
-- The resolver is the BRIDGE's, name-first, so a task in `in_review` in a space
-- with a migrated workflow lands in that workflow's `in_review` state rather
-- than being flattened to its first `in_progress` one.
-- =============================================================================
alter table public.entities disable trigger entities_capture_event;

update public.entities e
   set status_id = internal.workflow_state_for_work_status(e.id, t.work_status)
  from public.tasks t
 where t.entity_id = e.id
   and e.status_id is null
   and internal.workflow_state_for_work_status(e.id, t.work_status) is not null;

alter table public.entities enable trigger entities_capture_event;

-- -----------------------------------------------------------------------------
-- Belt and braces, 147's and 149's shared posture: a disabled trigger is exactly
-- the state in which a mistake goes unnoticed. Three claims, and the third is
-- the one that would be silent — a status_id whose category disagrees with the
-- column the product filters on is the precise corruption this whole phase
-- exists to make impossible.
-- -----------------------------------------------------------------------------
do $verify$
declare
  unadopted    bigint;
  bad_category bigint;
  bad_workflow bigint;
begin
  select count(*) into unadopted
    from public.tasks t join public.entities e on e.id = t.entity_id
   where e.status_id is null;
  if unadopted > 0 then
    raise exception '150 backfill incomplete: % tasks still have a NULL status_id', unadopted;
  end if;

  select count(*) into bad_category
    from public.entities e join public.workflow_states s on s.id = e.status_id
   where e.status_category is distinct from s.category;
  if bad_category > 0 then
    raise exception '150 backfill inconsistent: % entities disagree with their state''s category',
      bad_category;
  end if;

  -- Every workflow that governs tasks must satisfy the per-category requirement
  -- the triggers above enforce going forward. Asserted once, here, for the rows
  -- that already existed — a deferred constraint trigger says nothing about them.
  select count(*) into bad_workflow
    from public.workflows w
   where internal.workflow_kind_is_executable(w.kind)
     and (select count(distinct s.category) from public.workflow_states s
           where s.workflow_id = w.id
             and s.category in ('to_do', 'in_progress', 'done')) <> 3;
  if bad_workflow > 0 then
    raise exception '150: % task workflows lack a to_do/in_progress/done state', bad_workflow;
  end if;
end
$verify$;

reset role;
