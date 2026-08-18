-- =============================================================================
-- 151  THE COMPLETION GATE MOVES ONTO THE TRANSITION.
--
-- Phase 4 of "Kind, Status, Category, Workflow". 150 made the three doors
-- resolve a STATE by category instead of writing a literal. The gate did not
-- move with them: it is still welded inside `complete_task`, keyed on the value
-- `done` rather than on the category, and 150's own header marks the two blocks
-- as this file's to lift.
--
-- ## The hole this closes, in one sentence
--
-- A space may author a workflow whose done state is called `Shipped`. From 150
-- onward `complete_task` resolves that state correctly — but every check it runs
-- first is a check that lives INSIDE `complete_task`, so any OTHER writer of
-- `entities.status_id` (phase 5's universal-status door, a repair, an admin
-- tool) moves a task into `Shipped` with an unfinished checklist and an unmerged
-- PR and nothing says a word. Someone will create a status called `Shipped` on
-- day one; the gate has to be a property of ENTERING THE DONE CATEGORY, not a
-- property of one RPC.
--
-- ## Where it goes, and why there
--
-- Into `internal.validate_status_transition` — 149's BEFORE trigger on
-- `public.entities`, which is already THE one enforcement point for status
-- writes and already refuses a move the ruled category set does not allow. It is
-- 132's argument, unchanged: a row trigger closes every door at once and touches
-- no existing function, where a function edit closes exactly the door it edits.
--
-- The trigger asks two questions of a move, in order:
--
--   1. IS IT ALLOWED?  (149) the ruled category set, or the override rows if any
--      row names the target state.
--   2. ARE ITS PRECONDITIONS MET?  (this file) the effective `conditions` for
--      the move, evaluated against the entity.
--
-- ## Conditions: defaults, and what a `workflow_transitions` row does to them
--
-- 149's `conditions` column has been `not null default '{}'` and empty since it
-- shipped, waiting for this. Two conditions exist and both are TASK-shaped:
--
--   {"acceptanceCriteria": true}  every acceptanceCriteria[].done is true
--   {"completionGate": true}      honour the task's own `completion_gate`
--                                 column (082's opt-in `pr_merged` gate)
--
-- THE DEFAULT SET IS NOT ROWS. `internal.default_transition_conditions` returns
-- both for any move INTO the done category from outside it, so a workflow with
-- zero `workflow_transitions` rows — which is every workflow that exists — is
-- gated. Requiring a row would have meant the gate applied only to spaces that
-- had configured one, i.e. none, which is the hole restated rather than closed.
--
-- A matching override row's `conditions` are merged ON TOP of the defaults, and
-- that is deliberately NOT the same posture 149 took for allowedness. 149 rules
-- that a row naming state X governs entry into X EXCLUSIVELY — because that is
-- the only reading that can express "Blocked may only be entered from In
-- Review". Applied to conditions, the same reading would mean adding one
-- restricting row silently DROPS the acceptance-criteria gate on that state:
-- a gate that disappears when you tighten a rule. So:
--
--   * omission never disables a default — a row that says nothing about
--     `acceptanceCriteria` keeps it;
--   * an explicit `{"acceptanceCriteria": false}` DOES disable it, because a
--     space that means it should be able to say it, and saying it is legible in
--     the row rather than implicit in the row's existence;
--   * a more specific row (`from_state_id` = the state being left) is merged
--     after the ANY row, so it wins where they disagree.
--
-- The defaults key on the CATEGORY CHANGE, not on the target category: moving
-- `Shipped -> Released` is a refinement inside `done` (149's axiom) and is not
-- an entry into the category, so it does not re-run a gate the entry already
-- ran.
--
-- ## What is NOT a condition
--
-- Cross-entity dependency (`depends_on`, `is_resolved`, the unblock ripple)
-- stays edges, per sub-doc 3. Both conditions here are preconditions on THIS
-- entity — its own checklist, its own linked PR — which is exactly what a
-- transition condition is. A condition that read another entity's status would
-- make the trigger a graph traversal and the refusal a mystery.
--
-- ## BIRTH IS NOT A TRANSITION
--
-- 149's trigger returns early on INSERT and on adoption (`old.status_id is
-- null`), and conditions are evaluated after that arm, so an entity created
-- directly into a done state is not gated. That is 149's ruling and this file
-- keeps it: there is no "from" to have a precondition about, and phase 5 seeds
-- kinds whose rows are facts-about-the-past (`commit`) straight into `done`.
--
-- ## `set_work_state` re-keys, and the bridge STAYS
--
-- 060:36 refuses the literal `done` with `{"reason":"use_complete_command"}`.
-- That refusal is now asked of the target STATE'S CATEGORY, which is the same
-- hole as the gate's: a space whose workflow maps the state named `in_review` to
-- the `done` category walks `set_work_state('in_review')` straight past a
-- refusal that is looking for the string `done`.
--
-- `tasks_category_bridge` (150) is NOT retired here. 150's header asks this
-- phase to decide, and the decision is that it stays until `tasks.work_status`
-- does, in phase 5 — see the note at `set_work_state` below for the argument.
--
-- ## AND ONLY THEN: `task_workflows_structural_statuses`
--
-- Dropped at the bottom of this file, which is step 5 of sub-doc 3's ordering
-- and the whole reason the ordering exists. `doors-resolve-categories.pg.test.ts`
-- PINS the constraint present so that phase 3 could not silently skip ahead;
-- that pin is flipped in the same change, deliberately, not deleted.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- THE DEFAULT CONDITION SET, as one function, for the same reason
-- `internal.category_transition_allowed` is one function: changing it is
-- changing the product's rule, and that should be a one-screen diff a reviewer
-- can weigh rather than a data migration nobody reads.
--
-- `p_from_category` is NULL only for a move whose old state has vanished, which
-- the FK makes unrepresentable; `is distinct from` handles it as "not already
-- done", the safe side.
-- -----------------------------------------------------------------------------
create or replace function internal.default_transition_conditions(
  p_from_category text, p_to_category text
) returns jsonb language sql immutable set search_path = public, internal, pg_temp as $$
  select case
    when p_to_category = 'done' and p_from_category is distinct from 'done'
      then '{"acceptanceCriteria": true, "completionGate": true}'::jsonb
    else '{}'::jsonb
  end
$$;

comment on function internal.default_transition_conditions(text, text) is
  'The preconditions on ENTERING a category, needing no workflow_transitions '
  'rows at all — the same posture internal.category_transition_allowed takes for '
  'allowedness. Both of today''s conditions guard entry into `done`, and they do '
  'not re-fire on a refinement move that was already inside it.';

-- -----------------------------------------------------------------------------
-- The EFFECTIVE conditions for one move: the defaults, then every matching
-- override row merged on top. See the header for why this is a merge and not a
-- replacement.
--
-- `order by (t.from_state_id is null) desc` puts the ANY row first so the
-- specific row is applied last and wins. Two rows can match at most — the unique
-- key is (workflow, from, to) with `nulls not distinct` — so this is a fold over
-- at most two elements, not a scan someone will have to index later.
-- -----------------------------------------------------------------------------
create or replace function internal.transition_conditions(
  p_from_state_id uuid, p_to_state_id uuid
) returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  to_category   text;
  from_category text;
  effective     jsonb;
  override      jsonb;
begin
  select s.category into to_category from public.workflow_states s where s.id = p_to_state_id;
  if to_category is null then
    return '{}'::jsonb;
  end if;
  select s.category into from_category from public.workflow_states s where s.id = p_from_state_id;

  effective := internal.default_transition_conditions(from_category, to_category);

  for override in
    select t.conditions from public.workflow_transitions t
     where t.to_state_id = p_to_state_id
       and (t.from_state_id is null or t.from_state_id = p_from_state_id)
     order by (t.from_state_id is null) desc
  loop
    effective := effective || override;
  end loop;

  return effective;
end
$$;

comment on function internal.transition_conditions(uuid, uuid) is
  'The conditions that actually apply to one move: the category defaults with '
  'any matching workflow_transitions.conditions merged ON TOP. Omission never '
  'disables a default; an explicit false does. Unlike ALLOWEDNESS (149), an '
  'override row does not replace the default set — a gate that vanished because '
  'someone tightened a rule is the failure this whole phase exists to prevent.';

-- -----------------------------------------------------------------------------
-- The evaluator. Every raise here is 082's, message for message, because the
-- messages are what `git-graph-082.pg.test.ts` and the product's refusal copy
-- have asserted since 082 shipped and a moved check that renamed its refusals
-- would read as a new rule rather than the same one from a better place.
--
-- The acceptance-criteria raise gains the machine-readable detail it never had —
-- 060's whole lesson, cited by 132 and by 149: a door that refuses correctly for
-- months while clients see a bare sqlstate has not communicated anything.
--
-- NON-TASK KINDS pass vacuously. Both conditions read columns of `public.tasks`;
-- an entity with no `tasks` row has neither a checklist nor a linked-PR gate, and
-- phase 5 gives twenty kinds a status without giving them either. A future
-- kind-shaped condition adds a key here, next to these two.
-- -----------------------------------------------------------------------------
create or replace function internal.assert_transition_conditions(
  p_entity_id uuid, p_conditions jsonb
) returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  t public.tasks;
begin
  if p_conditions is null or p_conditions = '{}'::jsonb then
    return;
  end if;

  select * into t from public.tasks where entity_id = p_entity_id;
  if t.entity_id is null then
    return;
  end if;

  if coalesce((p_conditions ->> 'acceptanceCriteria')::boolean, false)
     and exists (
       select 1 from jsonb_array_elements(t.acceptance_criteria) c
        where not coalesce((c ->> 'done')::boolean, false)
     ) then
    raise exception 'all acceptance criteria must be complete first'
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'acceptance_criteria_incomplete',
              'entityId', p_entity_id
            )::text;
  end if;

  -- 082's opt-in git-facts gate, verbatim. See 082's C4 header for the refusal
  -- conditions; the only change is that it is now asked of a MOVE rather than of
  -- a command, so every writer of the status is asked it.
  if coalesce((p_conditions ->> 'completionGate')::boolean, false)
     and t.completion_gate = 'pr_merged' then
    if not exists (
      select 1 from public.edges ed
        join public.pull_requests pr on pr.entity_id = ed.dst_id
       where ed.src_id = p_entity_id and ed.type = 'tracks'
    ) then
      raise exception 'completion gate pr_merged: no tracked pull request on this task'
        using errcode = '23514', detail = '{"reason":"gate_no_tracked_pr"}';
    end if;
    if exists (
      select 1 from public.edges ed
        join public.pull_requests pr on pr.entity_id = ed.dst_id
       where ed.src_id = p_entity_id and ed.type = 'tracks'
         and (pr.state <> 'merged' or pr.ci_status = 'failing')
    ) then
      raise exception 'completion gate pr_merged: a tracked pull request is unmerged or CI-red'
        using errcode = '23514', detail = '{"reason":"gate_pr_unmerged_or_ci_red"}';
    end if;
  end if;
end
$$;

comment on function internal.assert_transition_conditions(uuid, jsonb) is
  'Evaluates a move''s effective conditions against the entity. Both of today''s '
  'conditions are preconditions on THIS entity (its checklist, its linked PR) — '
  'cross-entity dependency stays edges (sub-doc 3). An entity with no tasks row '
  'passes vacuously.';

-- -----------------------------------------------------------------------------
-- 149'S TRIGGER, with the second question added.
--
-- Byte-identical to 149's body down to the `if not allowed` raise; the ONLY
-- addition is the `perform` below it. Reproduced whole rather than wrapped
-- because this is the one enforcement point for status writes and a reader who
-- opens it should see the entire rule, which is 149's own argument for writing
-- it as one function.
--
-- ORDER IS PART OF THE RULE. Allowedness first: "you may not go from cancelled
-- to done" and "your checklist is unfinished" are different refusals, and asking
-- the second about a move that was never legal would answer a question nobody
-- asked. It also means the conditions never run for a refused move, so an
-- expensive future condition costs nothing on the refusal path.
-- -----------------------------------------------------------------------------
create or replace function internal.validate_status_transition() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  new_state public.workflow_states;
  old_state public.workflow_states;
  overridden boolean;
  allowed boolean;
begin
  -- Clearing a status is not a transition. Nothing in the product does it; a
  -- repair migration might, and refusing it would make this trigger the thing
  -- standing between an operator and a fix.
  if new.status_id is null then
    return new;
  end if;

  select * into new_state from public.workflow_states where id = new.status_id;
  if new_state.id is null then
    raise exception 'status % is not a workflow state', new.status_id using errcode = '23503';
  end if;

  -- BIRTH, or adoption of a status by a row that had none. There is no "from"
  -- category to rule on, so there is no rule to apply — and, from 151, no
  -- precondition either: a condition is a claim about a MOVE.
  if tg_op = 'INSERT' or old.status_id is null then
    new.status_category := new_state.category;
    return new;
  end if;

  if old.status_id = new.status_id then
    new.status_category := new_state.category;
    return new;
  end if;

  select * into old_state from public.workflow_states where id = old.status_id;

  if old_state.workflow_id <> new_state.workflow_id then
    raise exception 'cannot move entity % between workflows', new.id
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'cross_workflow_transition',
              'fromWorkflowId', old_state.workflow_id,
              'toWorkflowId', new_state.workflow_id
            )::text;
  end if;

  -- The override question is asked about the TARGET state only. See 149's
  -- header: if anything overrides entry into this state, the defaults stop
  -- applying to it and ONLY to it. That is ALLOWEDNESS; conditions merge instead
  -- (151's header).
  select exists (
    select 1 from public.workflow_transitions t where t.to_state_id = new_state.id
  ) into overridden;

  if overridden then
    select exists (
      select 1 from public.workflow_transitions t
       where t.to_state_id = new_state.id
         and (t.from_state_id is null or t.from_state_id = old_state.id)
    ) into allowed;
  else
    allowed := internal.category_transition_allowed(old_state.category, new_state.category);
  end if;

  if not allowed then
    raise exception 'transition from % to % is not allowed', old_state.name, new_state.name
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'transition_not_allowed',
              'workflowId', new_state.workflow_id,
              'fromStateId', old_state.id,
              'fromState', old_state.name,
              'fromCategory', old_state.category,
              'toStateId', new_state.id,
              'toState', new_state.name,
              'toCategory', new_state.category,
              'overridden', overridden
            )::text;
  end if;

  -- 151: THE GATE. The move is legal; are its preconditions met?
  perform internal.assert_transition_conditions(
    new.id, internal.transition_conditions(old_state.id, new_state.id));

  new.status_category := new_state.category;
  return new;
end
$$;

-- =============================================================================
-- THE DOORS THAT WERE KEYED ON THE LITERAL
-- =============================================================================

-- -----------------------------------------------------------------------------
-- `complete_task` — 150's body with BOTH gate blocks REMOVED and the
-- already-complete guard re-keyed to the category.
--
-- The gates are not deleted, they are relocated: the status write four lines
-- below reaches `internal.bridge_task_status_to_state`, which writes
-- `entities.status_id`, which fires 149's trigger, which now asks them. The
-- refusal a caller sees is the same sqlstate, the same message and the same
-- `details.reason` as before — it simply also fires for callers that never went
-- through this function.
--
-- WHAT STAYS HERE, and why it cannot move: `task is already complete`. Entering
-- a state you are already in is not a transition (149 returns early on
-- `old.status_id = new.status_id`) and a move BETWEEN two done states is a legal
-- refinement, so the trigger has nothing to refuse and would let a second
-- `complete_task` award points twice. It is re-keyed to the CATEGORY for the
-- same reason everything else in this file is — `Shipped` is complete.
--
-- `coalesce(e.status_category, ...)` because a task whose `status_id` is somehow
-- NULL (150 backfilled every row that existed, and 149's trigger derives the
-- category for every row written since) must still be refused a second
-- completion; falling back to the legacy column is the answer 082 gave and it is
-- the right one to keep as the floor.
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
  -- 151: the CATEGORY, not the literal. A space whose done state is called
  -- `Shipped` has a complete task, and completing it twice must still refuse.
  if coalesce(e.status_category, internal.work_status_category(task.work_status)) = 'done' then
    raise exception 'task is already complete' using errcode = '23514';
  end if;

  -- 151: THE TWO GATES USED TO BE HERE — the acceptance-criteria loop and 082's
  -- `completion_gate = 'pr_merged'` block. They now live on the →done
  -- transition's conditions (`internal.default_transition_conditions`) and are
  -- reached from the status write below, through the bridge and 149's trigger.
  -- Anything that moves a task into the done category is asked them now, not
  -- just this function.
  --
  -- THE ONE CASE THE TRIGGER CANNOT SEE: a task with no status at all. Adoption
  -- is not a transition (149), so a NULL `status_id` would take the trigger's
  -- birth arm and skip both gates. 150 backfilled every task that existed and
  -- `entities_seed_initial_status` gives every new one a status at birth, so
  -- this is unreachable — and it is exactly the shape of unreachable that turns
  -- into an ungated completion the day a repair leaves one row behind.
  if e.status_id is null then
    perform internal.assert_transition_conditions(
      p_task_id, internal.default_transition_conditions(null, 'done'));
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

-- -----------------------------------------------------------------------------
-- The category a legacy `work_status` literal actually lands in FOR THIS TASK.
--
-- Not `internal.work_status_category`, which answers for the literal in the
-- abstract. The bridge resolves a literal NAME-first against the entity's own
-- workflow, so in a space that mapped its state named `in_review` to the `done`
-- category, `set_work_state(task, 'in_review')` lands in `done` — and a refusal
-- that consults the literal's abstract category would wave it through. This
-- function asks the same question the bridge will answer.
--
-- Falls back to the literal's own category when nothing resolves (no workflow,
-- or a status the workflow cannot express), so the literal `done` is still
-- refused in a database with no workflows at all.
--
-- DIES WITH `tasks.work_status` IN PHASE 5, alongside
-- `internal.work_status_for_state` and the bridge.
-- -----------------------------------------------------------------------------
create or replace function internal.work_status_target_category(
  p_entity_id uuid, p_work_status text
) returns text language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select s.category from public.workflow_states s
      where s.id = internal.workflow_state_for_work_status(p_entity_id, p_work_status)),
    internal.work_status_category(p_work_status))
$$;

-- -----------------------------------------------------------------------------
-- `set_work_state` — 060's body with the `done` refusal re-keyed to the target
-- state's CATEGORY. Everything else is 060 verbatim (which is 037's
-- absent-means-merge version).
--
-- THE ORDER OF THE TWO CHECKS IS REVERSED FROM 060 and the outcomes are
-- identical for all seven literals: an unknown string is still 22023
-- `invalid work status`, and a status that lands in the done category is still
-- 23514 / `use_complete_command`. 060 could nest the second inside the first
-- because the only done-category status WAS the literal `done`; that is exactly
-- the assumption this file exists to delete.
--
-- ⚠ WHY THE BRIDGE STAYS (150's header asks this phase to decide).
-- The alternative was to have this function write `entities.status_id` directly
-- and retire `tasks_category_bridge`. Rejected, for three reasons:
--   * `tasks.work_status` lives until phase 5 and this is not its only writer —
--     a repair, a backfill and 132's own vocabulary trigger all sit on that
--     column. The bridge closes every one of them; a write here closes one.
--     It is 132's argument for a trigger over a function edit, unchanged.
--   * The bridge is what routes this door THROUGH 149's trigger, which is what
--     makes the gate and the ruled transition set apply to `set_work_state` at
--     all. Writing `status_id` here would work too, but it would be a second
--     path into the same validator rather than the same one.
--   * Two writes per call (the tasks row AND the envelope) is two chances for
--     them to disagree, and 150 spent its whole header removing the second
--     authority on this exact fact.
-- The bridge retires WITH the column, in phase 5, and that is the change that
-- should carry it.
--
-- The `working_on` edge branch is deliberately NOT re-keyed: `open` and
-- `cancelled` drop the edge while `pulled` — also `to_do` — keeps it, so the
-- literals there encode a claim about the actor's intent, not about the
-- category. Re-keying it would change behaviour for `pulled` on the way past.
-- -----------------------------------------------------------------------------
create or replace function public.set_work_state(
  p_task_id uuid, p_status text, p_actor_id uuid default null::uuid,
  p_started_at timestamp with time zone default null::timestamp with time zone,
  p_note text default null::text, p_client_mutation_id text default null::text,
  p_clear_note boolean default false
) returns jsonb language plpgsql security definer
set search_path to 'public', 'internal', 'pg_temp' as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  edge_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.work');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  if p_status not in ('open','pulled','working','in_review','blocked','done','cancelled') then
    raise exception 'invalid work status: %', p_status using errcode = '22023';
  end if;
  -- 151: the TARGET STATE'S CATEGORY, not the string `done`.
  if internal.work_status_target_category(p_task_id, p_status) = 'done' then
    raise exception 'completion goes through complete_task'
      using errcode = '23514', detail = '{"reason":"use_complete_command"}';
  end if;

  if p_status in ('open','cancelled') then
    delete from public.edges
     where src_id = actor and dst_id = p_task_id and type = 'working_on';
  else
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (e.space_id, actor, p_task_id, 'working_on',
            jsonb_build_object(
              'status', p_status,
              'startedAt', coalesce(p_started_at, now()),
              'note', case when p_clear_note then null else p_note end),
            actor)
    on conflict (src_id, dst_id, type) do update
      -- The merge. `note` is the only field a caller cannot express, so it is
      -- the only one that falls back to the stored value; `edges.props` is the
      -- PRE-UPDATE row. An explicit p_clear_note wins over both.
      set props = jsonb_build_object(
            'status', p_status,
            'startedAt', coalesce(p_started_at, now()),
            'note', case
                      when p_clear_note then null
                      else coalesce(p_note, edges.props->>'note')
                    end),
          updated_at = now()
    returning id into edge_id;
  end if;

  update public.tasks set work_status = p_status, updated_at = now() where entity_id = p_task_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.work',
           internal.command_result(p_task_id, edge_id,
             internal.record_activity(e.space_id, p_task_id, actor, 'work.changed', edge_id,
               jsonb_build_object('status', p_status)), array[p_task_id]));
end
$$;

-- =============================================================================
-- AND ONLY THEN: THE STRUCTURAL CONSTRAINT GOES.
--
-- 132's header states the precondition in as many words: removing a member from
-- `task_workflows_structural_statuses` requires each of the three write doors to
-- FIRST grow its own guard. As of 150 they resolve a state by category, and as
-- of this file the completion gate rides the transition rather than the literal.
-- Both preconditions are now met, and 150 shipped the replacement — the
-- per-category coverage requirement on `workflows` / `workflow_states`, which is
-- a claim about what the KIND can do rather than about three strings.
--
-- WHAT THIS ACTUALLY UNLOCKS, precisely: a space may now author a `type`
-- vocabulary that omits `open`, `working` or `done`. What it does NOT unlock is
-- a task of such a type COMPLETING while 132's `tasks_validate_workflow` trigger
-- still polices the legacy column against that same vocabulary — the door
-- resolves the workflow's done state and projects it onto `tasks.work_status`,
-- and if the vocabulary no longer contains the projected literal, 132 refuses
-- with `workflow_forbids_status`. That is an honest, machine-readable refusal
-- rather than corruption, and it is transitional by construction: phase 6
-- retires `task_workflows` and its trigger together, which is the change that
-- makes the unlock complete. The product's own settings surface still declines
-- to author such a vocabulary client-side (`tm8-ui/src/domain/workflows.ts`), so
-- nothing reaches that refusal today.
--
-- `if exists` because 132's constraint is the kind of object a repair migration
-- may already have removed in a hand-tended database, and a phase-ordering step
-- that cannot be re-run is a step someone has to hand-edit at 3am.
-- =============================================================================
alter table public.task_workflows drop constraint if exists task_workflows_structural_statuses;

do $verify$
declare
  still_there bigint;
begin
  select count(*) into still_there
    from pg_constraint where conname = 'task_workflows_structural_statuses';
  if still_there > 0 then
    raise exception '151: task_workflows_structural_statuses survived the drop';
  end if;

  -- The replacement must be the thing standing where it stood. Not a count of
  -- rows — a claim that the two constraint triggers 150 installed are attached,
  -- because THEY are what makes `internal.workflow_state_for_category`'s raise
  -- unreachable at the spawn and complete doors now that nothing else does.
  select count(*) into still_there
    from pg_trigger
   where tgname in ('workflows_assert_category_coverage',
                    'workflow_states_assert_category_coverage')
     and not tgisinternal;
  if still_there <> 2 then
    raise exception '151: the per-category coverage triggers are missing (found %)', still_there;
  end if;
end
$verify$;

reset role;
