-- =============================================================================
-- 132  TASK WORKFLOWS — a space narrows the status vocabulary per `type` value.
--
-- This cashes in the ruling written at tm8-ui domain/registry.ts:88-101: "when
-- a real workflow lands (keyed on the `type` axis, space-scoped like
-- task_axes), it narrows THIS list; the control does not change shape."
-- Owner rulings (task-types wave, 2026-08-16): keyed STRICTLY on the `type`
-- axis; a task whose status becomes illegal under a new type value is ALLOWED
-- and flagged off-workflow (a DERIVED fact, never stored, never rewritten);
-- structural statuses are {open, working, done}.
--
-- WHAT A RULE IS. One row per (space, type value): the SUBSET of the seven
-- work statuses that tasks of that type may be moved TO. There is no
-- transition matrix — nothing in the rulings asked for one, and a nullable
-- `transitions` column nobody reads would be dead schema wearing a promise.
-- If transitions are ever ruled in, a column then is additive and cheap.
-- The column is `type_value`, not `axis_value`: generalising to other axes,
-- if ever ruled, adds a column rather than renaming one.
--
-- WHY ENFORCEMENT IS A TRIGGER ON `public.tasks`, NOT a function edit.
-- `set_work_state` was the obvious door and it is the WRONG one, twice over,
-- both measured 2026-08-16:
--   * it never sees `done` — 007:1876 (rewritten 037:75, reason detail 060:16)
--     refuses `done` outright with use_complete_command, so a vocabulary's
--     `done` membership would be decorative at that door;
--   * it is not the only door — 131's `execution_spawn` (PR #254) writes
--     `work_status = 'working'` DIRECTLY on spawn.
-- A row trigger closes every door at once — set_work_state, complete_task,
-- execution_spawn, and any future writer — and touches NO existing function,
-- which matters because `create or replace` collisions across branches have
-- silently reverted work in this repo twice (execution_spawn is ALREADY a
-- documented two-branch pile-up: 129 vs 131). `internal.validate_task_axes`
-- on this same table is the precedent for exactly this shape.
--
-- STRUCTURAL STATUSES — the check constraint requires {open, working, done}
-- in every vocabulary, so the narrowable set is exactly
-- {pulled, in_review, blocked, cancelled}. Each structural member maps to a
-- WRITER a vocabulary must not be able to break:
--   * open    — creation writes it; excluding it births every task of the
--               type off-workflow;
--   * working — 131's spawn door writes it by owner ruling; excluding it
--               would make spawning on the type abort mid-transaction;
--   * done    — complete_task alone writes it; excluding it authors a board
--               with no exit while the Complete button ignores the rule.
-- "Every task can always be created, worked, and finished" is therefore a
-- SCHEMA invariant, and complete_task needs no knowledge of workflows — its
-- acceptance and pr_merged gates are untouched and unweakened.
--
-- ⚠ DEPENDENT CALLERS — doors that are safe ONLY because of this constraint.
-- None of them consults the vocabulary, BY DELIBERATE DECISION at each door,
-- and each decision stands on one structural member:
--   * `execution_spawn` (131, PR #254)  → depends on 'working' ∈ statuses.
--     It writes work_status='working' directly with no guard; refusal there
--     would abort a spawn mid-transaction.
--   * task creation (`create_task` and every entities.create path)
--                                       → depends on 'open' ∈ statuses.
--   * `complete_task`                   → depends on 'done' ∈ statuses.
--     The alternative — teaching it workflows — entangles two independent
--     gates and was explicitly rejected in review.
-- REMOVING A MEMBER FROM THE STRUCTURAL SET is therefore never a one-line
-- edit to this constraint: each door named above must first gain its OWN
-- vocabulary guard (or an owner ruling must accept the new failure mode at
-- that door). A constraint whose justification lives only in a chat thread
-- is a constraint someone will relax; this list is the justification, at
-- the scene.
--
-- `cancelled` stays NARROWABLE, deliberately: it is a deliberate human
-- statement reachable through set_work_state's six, and a type may
-- legitimately forbid it (the same reasoning 131's header uses for why a
-- spawn never writes it).
--
-- BEHAVIOUR AT THE TRIGGER, precisely:
--   * fires only when `work_status` actually CHANGES (and on INSERT); a TYPE
--     change never fires it, so re-typing a task to a vocabulary its current
--     status is outside of is ALLOWED — the derived off-workflow flag is the
--     product's answer, per the ruling;
--   * moving FROM an illegal status is free; moving TO one refuses — which is
--     what "its next transition must move it into the vocabulary" means;
--   * a task with no `type` value, a type with no rule, or a space with no
--     rules is NEVER touched: today's behaviour exactly, for every existing
--     task in every existing space (the pre-132 suite staying green is the
--     backward-compatibility proof).
--
-- THE RAISE CARRIES A MACHINE-READABLE DETAIL (060's own lesson, cited above:
-- the state door had refused correctly for months while clients saw a bare
-- sqlstate). `details.reason = 'workflow_forbids_status'` plus the type
-- value, the rejected status and the allowed list — a client renders "type
-- code does not allow blocked" without string-matching a sentence.
--
-- ⚠ BLAST RADIUS — READ BEFORE WRITING A BACKFILL. This is a ROW trigger on
-- `public.tasks`: any future bulk `update tasks set work_status = ...` — a
-- repair, a rename migration, a data fix — runs the vocabulary check per row
-- and can abort mid-migration in a space whose workflow the migration author
-- never heard of. That is the correct default: a backfill is a writer like
-- any other. A DELIBERATE, fenced backfill that must bypass it uses
--   set local session_replication_role = replica;
-- inside its own transaction (which disables ALL non-replica triggers on the
-- session, validate_task_axes included — so re-validate what you wrote).
-- An undocumented trigger that fails someone else's migration is a trap;
-- this one is a rule, and this header is the rule's text.
-- =============================================================================

set role tm8_graph_owner;

create table public.task_workflows (
  id          uuid primary key default internal.new_id(),
  space_id    uuid not null references public.spaces(id) on delete cascade,
  -- The `type` AXIS value this rule governs. Deliberately not an FK into
  -- task_axes.axis_values (an array, nothing to reference): a rule for a
  -- value the axis no longer declares is INERT by construction — no task can
  -- carry the value (the axis registry refuses removing a value in use), so
  -- the trigger's lookup never matches it — and stays editable/deletable.
  type_value  text not null check (char_length(btrim(type_value)) between 1 and 100),
  statuses    text[] not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (space_id, type_value),
  -- Only the seven. (Duplicate detection needs a subquery, which a check
  -- constraint cannot hold — it lives in `upsert_task_workflow`, the same
  -- split 016 uses for axis values.)
  constraint task_workflows_statuses_valid check (
    statuses <@ array['open','pulled','working','in_review','done','blocked','cancelled']::text[]
    and array_position(statuses, null) is null
  ),
  -- The structural three — see the header. The narrowable set is exactly
  -- {pulled, in_review, blocked, cancelled}.
  constraint task_workflows_structural_statuses check (
    array['open','working','done']::text[] <@ statuses
  )
);

create index task_workflows_space_idx on public.task_workflows(space_id, type_value);

create trigger task_workflows_touch_updated_at before update on public.task_workflows
for each row execute function internal.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The one enforcement point.
-- ---------------------------------------------------------------------------
create or replace function internal.validate_task_workflow() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  tv text;
  vocab text[];
begin
  -- Only a real status CHANGE is this trigger's business. A type change, a
  -- description edit, an axes write — none of them fire past this line, which
  -- is what keeps the ruling's "allowed and flagged, never refused, never
  -- rewritten" true for re-typing.
  if tg_op = 'UPDATE' and new.work_status is not distinct from old.work_status then
    return new;
  end if;

  tv := new.axes ->> 'type';
  if tv is null then return new; end if;

  select w.statuses into vocab
    from public.task_workflows w
    join public.entities e on e.id = new.entity_id
   where w.space_id = e.space_id and w.type_value = tv;
  if vocab is null then return new; end if;

  if new.work_status <> all (vocab) then
    raise exception 'workflow for type % does not allow status %', tv, new.work_status
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'workflow_forbids_status',
              'typeValue', tv,
              'status', new.work_status,
              'allowed', array_to_json(vocab)
            )::text;
  end if;
  return new;
end
$$;

create trigger tasks_validate_workflow
before insert or update of work_status on public.tasks
for each row execute function internal.validate_task_workflow();

-- ---------------------------------------------------------------------------
-- The CRUD doors, shaped exactly like 016's task-axis family: space-admin
-- only, replay-ledgered, every rule in SQL. Upsert rather than create+update
-- because the natural key is (space, type_value) and the UI edits one row per
-- value — fewer ops, smaller catalog blast.
-- ---------------------------------------------------------------------------
create or replace function public.upsert_task_workflow(
  p_space_id uuid,
  p_type_value text,
  p_statuses text[],
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row_out public.task_workflows;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskWorkflows.upsert');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  -- Duplicates only — vocabulary validity and the structural three are the
  -- TABLE's constraints, and a second copy here would drift from the rule
  -- that decides. This one check lives here because a check constraint
  -- cannot hold the subquery.
  if cardinality(p_statuses) <> cardinality(array(select distinct s from unnest(p_statuses) s)) then
    raise exception 'workflow statuses must be unique' using errcode = '22023';
  end if;
  insert into public.task_workflows(space_id, type_value, statuses)
  values (p_space_id, btrim(p_type_value), p_statuses)
  on conflict (space_id, type_value)
  do update set statuses = excluded.statuses
  returning * into row_out;

  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.taskWorkflows.upsert',
    jsonb_build_object('workflow', to_jsonb(row_out), 'patches', '[]'::jsonb)
  );
end
$$;

create or replace function public.delete_task_workflow(
  p_space_id uuid,
  p_workflow_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row_found public.task_workflows;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.taskWorkflows.delete');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);
  select * into row_found
    from public.task_workflows
   where id = p_workflow_id and space_id = p_space_id
   for update;
  if row_found.id is null then
    raise exception 'task workflow not found' using errcode = 'P0002';
  end if;
  -- Deleting a rule is never data loss: it widens the vocabulary back to the
  -- seven, and no task row changes. Nothing to warn about, nothing refused.
  delete from public.task_workflows where id = p_workflow_id;
  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.taskWorkflows.delete',
    jsonb_build_object('workflowId', p_workflow_id, 'patches', '[]'::jsonb)
  );
end
$$;

grant select on public.task_workflows to tm8_app;
grant execute on function
  public.upsert_task_workflow(uuid, text, text[], text),
  public.delete_task_workflow(uuid, uuid, text)
to tm8_app;

reset role;
