-- =============================================================================
-- 148  WORKFLOWS: states, transitions, and the category-level default rules.
--
-- Phase 2 of "Kind, Status, Category, Workflow". 147 put `status_category` on
-- the envelope and left `status_id` pointing at nothing — deliberately, because
-- the table it references did not exist. This file creates that table, and
-- therefore adds the foreign key 147 could not.
--
-- ## What a workflow IS here
--
--   workflow             a named set of states + transitions, bound to a kind.
--                        A TABLE, not an entity — sibling to `task_axes`, which
--                        001:535 already rules is "space-scoped configuration,
--                        not entities".
--   state                one position in that workflow. Has a NAME (open,
--                        user-defined) and a CATEGORY (one of exactly four,
--                        closed forever by 147's check constraint).
--   transition           an OVERRIDE. Not the rule — the deviation from it.
--
-- ## The one idea that makes this not-Jira: DEFAULTS AT THE CATEGORY LEVEL
--
-- Jira makes you draw every arrow. Twelve states is up to 144 decisions, which
-- is why nobody configures Jira twice. Here the defaults are expressed BETWEEN
-- CATEGORIES, of which there are four, forever:
--
--     any          -> cancelled     (ruled)
--     to_do        -> in_progress
--     in_progress  -> done
--     to_do        -> done          (ruled: done comes from to_do or in_progress)
--     done         -> to_do         (reopen)
--     cancelled    -> to_do         (revive)
--
-- A workflow with twelve custom states inherits all of that and works
-- IMMEDIATELY with zero rows in `workflow_transitions`. That is the whole
-- point, and it is the thing that has to still be true in three years.
--
-- ### The axiom the ruled set does not state, and could not work without
--
-- **A move WITHIN a category is always legal.** `in_progress -> in_progress`
-- is not in the ruled list above, and if the list were read as exhaustive then
-- a workflow with In Review and Blocked — the exact refinement the design sells
-- as free — could not move a task between them. That would make the twelve-state
-- promise false on the first workflow anyone writes.
--
-- It is a DERIVATION, not a new ruling: "the category is the only status concept
-- anything outside a workflow may read" (sub-doc 1 §4). A move that does not
-- change the category is invisible to every tab, filter, badge, rollup and gate
-- in the product. There is nothing for a category-level rule to have an opinion
-- about, so refusing it would be a rule about names — the one thing the design
-- forbids. It is encoded as the first arm of `internal.category_transition_allowed`
-- rather than as six more rows in the ruled table, so that it reads as the axiom
-- it is.
--
-- ### What an OVERRIDE row means, precisely — RULED HERE, flagged to phase 3
--
-- The design says a `workflow_transitions` row is "an override, added only where
-- a space wants to deviate", and gives one example: *"Blocked may only be
-- entered from In Review"*. That example is a RESTRICTION, so "rows are extra
-- allowances" cannot be the semantic — it could never express it. Nor can
-- "any row switches the whole workflow to whitelist mode": overriding one state
-- would silently un-configure the other eleven, which is the Jira failure this
-- design exists to avoid.
--
-- **The semantic is PER TARGET STATE.** If any `workflow_transitions` row names
-- state X as `to_state_id`, then entry into X is governed EXCLUSIVELY by those
-- rows and the category default no longer applies to X. Every other state in
-- the workflow keeps the defaults, untouched.
--
--   * "Blocked may only be entered from In Review" = ONE row
--     (from = In Review, to = Blocked).
--   * "anything may enter Shipped" = ONE row (from = NULL/ANY, to = Shipped) —
--     a WIDENING, which the same mechanism gives for free.
--
-- Scoped, minimal, and it degrades correctly: delete the row and X returns to
-- the defaults. This reading is a ruling made at implementation time; it is
-- recorded here because phase 3's doors and phase 4's gate both stand on it.
--
-- ## What this file does NOT do (later phases, deliberately)
--
--   * `entity_kinds` gains no `workflow_id` — phase 5/6. Nothing here resolves
--     "which workflow governs this entity", because there is no link to walk
--     yet, and inventing one now would be schema wearing a promise.
--   * The three doors (`create_task`, `execution_spawn`, `complete_task`) still
--     write `work_status` literals — phase 3. `internal.workflow_state_for_category`
--     is phase 3's function and is NOT defined here.
--   * `entities.status_id` therefore stays NULL on every row in the database
--     after this migration. The FK, the trigger and the transition rules below
--     are all live and all unexercised by production writers — which is exactly
--     the state you want a validator in before the writers arrive.
--   * `task_workflows` is COPIED, never dropped, and its trigger is untouched.
--     It stays read-only-in-practice until phase 6. 147's transitional writers
--     (`entities_seed_status_category`, `tasks_category`) are likewise left
--     alone: they are phase 3's to replace, and fighting them here would give
--     `status_category` two writers with no way to break the tie.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- workflows
--
-- `space_id` IS NULLABLE, and the NULL is the design. A NULL space_id means the
-- BUILT-IN DEFAULT workflow: one global row, seeded once at the bottom of this
-- file, governing every kind that has not been given a workflow of its own
-- (`entity_kinds.workflow_id is null`, phase 5). The alternative — one default
-- workflow row per space — would need a trigger on `public.spaces` and would
-- make "the default" a thing that can drift per space, which is the opposite of
-- what a default is. A new space gets correct behaviour with zero rows.
--
-- `kind` is nullable for the same reason: NULL means "governs any kind". The
-- built-in default is the only row that is allowed to say that; a space-scoped
-- workflow names the kind it governs.
-- -----------------------------------------------------------------------------
create table public.workflows (
  id         uuid primary key default internal.new_id(),
  space_id   uuid references public.spaces(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 100),
  -- The kind this workflow governs. Not an FK into `public.entity_kinds`:
  -- that table is keyed (kind, space_id) with core rows carrying a NULL
  -- space_id, so there is no single column to reference, and a workflow
  -- authored for a `c:` kind that is later deleted should go INERT rather than
  -- block the delete — the same reasoning 132 wrote for `type_value`.
  kind       text check (kind is null or char_length(btrim(kind)) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one built-in default, and it is the only kind-less row.
  constraint workflows_builtin_is_kindless check (space_id is not null or kind is null),
  -- The natural key. For workflows migrated out of `task_workflows` below,
  -- `name` IS the `type_value` — that equality is phase 6's join key when it
  -- turns each `type` axis value into a `c:` kind, and it is why this
  -- constraint is (space_id, kind, name) rather than a surrogate-only table.
  constraint workflows_space_kind_name_key unique nulls not distinct (space_id, kind, name)
);

create unique index workflows_builtin_singleton_idx
  on public.workflows((true)) where space_id is null;

create index workflows_space_idx on public.workflows(space_id, kind);

create trigger workflows_touch_updated_at before update on public.workflows
for each row execute function internal.touch_updated_at();

comment on table public.workflows is
  'A named set of states + transitions bound to a kind. Configuration, not an '
  'entity (001:535 precedent, task_axes). space_id NULL = THE built-in default '
  'workflow, one global row, used by every kind with no workflow of its own.';

-- -----------------------------------------------------------------------------
-- workflow_states
--
-- `category` repeats 147's closed four rather than referencing them. There is
-- no `categories` table and there must never be one: the whole design trades
-- OPEN statuses for CLOSED categories, and a table is a set someone can insert
-- into. Two check constraints naming the same four literals is the correct
-- amount of duplication for a set that is closed forever.
--
-- `is_initial` and `is_default` are different strengths of claim and the
-- difference matters:
--
--   is_initial  EXACTLY ONE per workflow, and it MUST be `to_do`. It is where
--               an entity is born. Enforced three ways below: a check for the
--               category, a partial unique index for at-most-one, and a
--               DEFERRED constraint trigger for at-least-one (deferred because
--               a workflow is written states-first and cannot be legal in the
--               middle of its own insert).
--   is_default  AT MOST ONE per (workflow, category), and it is only a tiebreak:
--               phase 3's resolver takes the `is_default` state in a category or
--               the lowest-`position` one. Lowest-position is the default
--               default precisely so that a freshly authored workflow resolves
--               correctly with nobody having set a flag.
--
-- `position` is unique per workflow and the constraint is DEFERRABLE, because
-- reordering two states is a swap and a swap is illegal halfway through.
-- -----------------------------------------------------------------------------
create table public.workflow_states (
  id          uuid primary key default internal.new_id(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  category    text not null check (category in ('to_do', 'in_progress', 'done', 'cancelled')),
  position    int  not null,
  is_initial  boolean not null default false,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint workflow_states_initial_is_to_do check (not is_initial or category = 'to_do'),
  constraint workflow_states_name_key unique (workflow_id, name),
  constraint workflow_states_position_key unique (workflow_id, position) deferrable initially deferred,
  -- The composite key that lets `workflow_transitions` prove BOTH its endpoints
  -- live in the workflow it claims to belong to, declaratively, with no trigger.
  constraint workflow_states_id_workflow_key unique (id, workflow_id)
);

create unique index workflow_states_one_initial_idx
  on public.workflow_states(workflow_id) where is_initial;

create unique index workflow_states_one_default_per_category_idx
  on public.workflow_states(workflow_id, category) where is_default;

create index workflow_states_workflow_idx
  on public.workflow_states(workflow_id, category, position);

create trigger workflow_states_touch_updated_at before update on public.workflow_states
for each row execute function internal.touch_updated_at();

comment on column public.workflow_states.category is
  'One of the closed four. The ONLY status concept anything outside a workflow '
  'may read (sub-doc 1 §4). A state NAME is open and user-defined; branching on '
  'one outside registry/workflow code is the invariant this design exists to buy.';

comment on column public.workflow_states.is_default is
  'Tiebreak for "the default state of this category", used by phase 3''s '
  'internal.workflow_state_for_category. Unset means lowest position wins — so a '
  'freshly authored workflow resolves correctly with zero configuration.';

-- -----------------------------------------------------------------------------
-- workflow_transitions — the OVERRIDE table. See the header for the semantic.
--
-- `from_state_id` NULL means ANY, and it is the reason the unique constraint is
-- `nulls not distinct`: without it a workflow could hold two identical
-- "anything may enter Shipped" rows, which is not a second rule, it is the same
-- rule twice.
--
-- The composite foreign keys are doing real work. `(to_state_id, workflow_id)`
-- referencing `workflow_states(id, workflow_id)` makes "a transition whose
-- endpoint belongs to a DIFFERENT workflow" unrepresentable rather than merely
-- refused — which matters because that row would not throw, it would silently
-- fail to match at validation time and read as "the default applied".
-- -----------------------------------------------------------------------------
create table public.workflow_transitions (
  id            uuid primary key default internal.new_id(),
  workflow_id   uuid not null references public.workflows(id) on delete cascade,
  from_state_id uuid,
  to_state_id   uuid not null,
  -- Preconditions on entering the TARGET state. Two exist today and both are
  -- still welded inside `complete_task`: every acceptanceCriteria[].done, and
  -- completionGate = 'pr_merged'. Phase 4 moves them HERE. Empty until then,
  -- and the column is `not null default '{}'` so phase 4 never has to reason
  -- about a NULL that means the same as an empty object.
  conditions    jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint workflow_transitions_from_fk
    foreign key (from_state_id, workflow_id)
    references public.workflow_states(id, workflow_id) on delete cascade,
  constraint workflow_transitions_to_fk
    foreign key (to_state_id, workflow_id)
    references public.workflow_states(id, workflow_id) on delete cascade,
  constraint workflow_transitions_not_self check (from_state_id is distinct from to_state_id),
  constraint workflow_transitions_key
    unique nulls not distinct (workflow_id, from_state_id, to_state_id)
);

create index workflow_transitions_to_idx
  on public.workflow_transitions(to_state_id);

create trigger workflow_transitions_touch_updated_at before update on public.workflow_transitions
for each row execute function internal.touch_updated_at();

comment on table public.workflow_transitions is
  'OVERRIDES, not rules. The rules are the category-level defaults in '
  'internal.category_transition_allowed and need no rows at all. If ANY row '
  'names state X as to_state_id, entry into X is governed exclusively by those '
  'rows; every other state in the workflow keeps the defaults.';

-- -----------------------------------------------------------------------------
-- The FK 147 could not add.
--
-- `on delete restrict`: a state that entities are sitting in is not deletable,
-- and that is the honest answer — the alternative (`set null`) would silently
-- strip the status off live work to let an admin tidy a list. The whole-workflow
-- upsert RPC below surfaces this as a refusal the admin can act on.
--
-- Every row in the table has status_id NULL right now, so the validation scan is
-- trivial and this needs no NOT VALID staging.
-- -----------------------------------------------------------------------------
alter table public.entities
  add constraint entities_status_id_fkey
  foreign key (status_id) references public.workflow_states(id) on delete restrict;

create index entities_status_id_idx on public.entities(status_id) where status_id is not null;

-- -----------------------------------------------------------------------------
-- Exactly-one-initial, as a DEFERRED constraint trigger.
--
-- The partial unique index above gives at-most-one. At-LEAST-one cannot be an
-- index: it is a claim about the absence of a row, and it is false for the
-- entire duration of a legal write (a workflow's first state does not exist
-- while its `workflows` row is being inserted). So it is checked at COMMIT, on
-- both tables, and only for workflows that still exist — deleting a workflow
-- cascades its states away and must not then trip a rule about them.
-- -----------------------------------------------------------------------------
create or replace function internal.assert_workflow_has_initial() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  -- NOT initialized in DECLARE. A declaration's default is evaluated BEFORE the
  -- body, so `coalesce(new.workflow_id, old.workflow_id)` there raises
  -- "record new has no field workflow_id" the instant this trigger is attached
  -- to `workflows` — whose rows have `id`, not `workflow_id`. Same reason the
  -- assignments below are guarded by tg_op: `new` is unassigned on DELETE and
  -- `old` is unassigned on INSERT, and touching either is an error, not a NULL.
  target uuid;
  initial_count int;
begin
  if tg_table_name = 'workflows' then
    target := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    target := case when tg_op = 'DELETE' then old.workflow_id else new.workflow_id end;
  end if;

  if not exists (select 1 from public.workflows where id = target) then
    return null;
  end if;
  select count(*) into initial_count
    from public.workflow_states where workflow_id = target and is_initial;
  if initial_count <> 1 then
    raise exception 'workflow % must have exactly one initial state, found %', target, initial_count
      using errcode = '23514',
            detail = json_build_object(
              'reason', 'workflow_initial_state_required',
              'workflowId', target,
              'initialStates', initial_count
            )::text;
  end if;
  return null;
end
$$;

create constraint trigger workflows_assert_initial
after insert or update on public.workflows
deferrable initially deferred
for each row execute function internal.assert_workflow_has_initial();

create constraint trigger workflow_states_assert_initial
after insert or update or delete on public.workflow_states
deferrable initially deferred
for each row execute function internal.assert_workflow_has_initial();

-- -----------------------------------------------------------------------------
-- THE RULED SET, as one function.
--
-- No `else` arm that guesses: everything not named is refused. The first arm is
-- the axiom argued in the header — a move that does not change the category is
-- invisible to every consumer of a category, so there is nothing to refuse.
--
-- IMMUTABLE and total over the closed four, which is what lets a caller inline
-- it and what makes the ruled set auditable by reading one screen. Changing this
-- function is changing the product's ruling, and that is the intended cost.
-- -----------------------------------------------------------------------------
create or replace function internal.category_transition_allowed(
  from_category text,
  to_category   text
) returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select case
    -- The axiom: refinement inside a category is free.
    when from_category = to_category                              then true
    -- any -> cancelled (ruled).
    when to_category = 'cancelled'                                then true
    when from_category = 'to_do'       and to_category = 'in_progress' then true
    when from_category = 'in_progress' and to_category = 'done'        then true
    -- done comes from to_do or in_progress (ruled).
    when from_category = 'to_do'       and to_category = 'done'        then true
    -- reopen.
    when from_category = 'done'        and to_category = 'to_do'       then true
    -- revive.
    when from_category = 'cancelled'   and to_category = 'to_do'       then true
    else false
  end
$$;

comment on function internal.category_transition_allowed(text, text) is
  'The RULED category-level default transition set (2026-08-18 addendum, sub-doc '
  '1). These are the DEFAULTS and they need no rows: a twelve-state workflow '
  'inherits all of them. A workflow_transitions row overrides them for ONE '
  'target state. The same-category arm is an axiom, not a ruling: a move that '
  'does not change the category is invisible to everything that reads one.';

-- -----------------------------------------------------------------------------
-- The one enforcement point for status writes.
--
-- A BEFORE trigger on `public.entities`, mirroring 132's choice of a trigger over
-- a function edit and for the identical reason: `status_id` will acquire several
-- writers (phase 3's three doors, phase 5's backfills, a future set_status), and
-- a row trigger closes every door at once while touching no existing function.
--
-- It does TWO things, and the second is not optional:
--
--   1. VALIDATES the transition (below).
--   2. DERIVES `status_category` from the state. `status_category` is
--      denormalized, and the moment `status_id` becomes writable there are two
--      candidate authorities for the same fact. Deriving it here means there is
--      only ever one: the state row. A caller that sets `status_id` cannot leave
--      the category stale or set it to something the state disagrees with.
--
-- Order of BEFORE INSERT triggers on `public.entities` is alphabetical:
-- `entities_seed_status_category` (147) < `entities_status_from_state`. So 147's
-- seed writes `to_do` for a task, and this one overwrites it from the state IF a
-- status_id was supplied. Since nothing in this phase supplies one, 147's
-- behaviour is bit-for-bit unchanged — which is the point of the ordering, not
-- an accident of it.
--
-- WHAT IT DOES NOT CHECK: that the state belongs to the workflow of the entity's
-- KIND. There is no kind -> workflow link until phase 5, so that check has
-- nothing to read. What it CAN prove — and does — is that both endpoints of the
-- move live in the SAME workflow, which is the half of that invariant that is
-- knowable today and the half that catches a cross-workflow write.
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
    -- Unreachable through the FK; kept because a trigger that assumes its own
    -- FK is a trigger that null-dereferences the day someone drops it.
    raise exception 'status % is not a workflow state', new.status_id using errcode = '23503';
  end if;

  -- BIRTH, or adoption of a status by a row that had none. There is no
  -- "from" category to rule on, so there is no rule to apply. Phase 3 is what
  -- makes this arm mean "the workflow's initial state", by being the thing that
  -- writes it; constraining it here would refuse phase 5's backfill of twenty
  -- kinds into states that are deliberately not `to_do`.
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

  -- The override question is asked about the TARGET state only. See the header:
  -- if anything overrides entry into this state, the defaults stop applying to
  -- it and ONLY to it.
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
    -- 060's lesson, cited by 132's header: a door that refuses correctly for
    -- months while clients see a bare sqlstate has not communicated anything.
    -- `overridden` is in the detail because "why was this refused" has two very
    -- different answers and a client should not have to guess which.
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

  new.status_category := new_state.category;
  return new;
end
$$;

create trigger entities_status_from_state
before insert or update of status_id on public.entities
for each row execute function internal.validate_status_transition();

-- =============================================================================
-- SEEDS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. THE built-in default workflow. One row, no space, no kind.
--
-- Four states, one per category — so out of the box status and category
-- COINCIDE, and a space that later adds "In Review" is adding a second
-- `in_progress` state while every tab, filter and badge keeps working untouched
-- because they all read the category.
--
-- These four carry DISPLAY names ("To Do"), where the migrated workflows below
-- carry the raw `work_status` literals ("in_review"). That asymmetry is
-- deliberate: the migrated states must keep the identity the product already
-- shows for them, and the default workflow is new and has no legacy to preserve.
-- The fixed id makes the built-in addressable from a test and from phase 3's
-- resolver without a name lookup.
-- -----------------------------------------------------------------------------
-- ONE statement, not two, and that is load-bearing. `workflows_assert_initial`
-- is DEFERRED to commit, so an `insert into workflows` followed by a separate
-- `insert into workflow_states` is legal only if both land in the same
-- transaction. Both real appliers do give it one — `db/migrate.mjs:243` and
-- `w1-pg.ts`'s harness both run `psql -1` — but "correct only under a flag the
-- caller passes" is not a property this file should have. A data-modifying CTE
-- is one statement under every applier, and it is the shape the task_workflows
-- copy below already has. (Measured: the two-statement version fails with
-- "must have exactly one initial state, found 0" under a plain `psql -f`.)
with created as (
  insert into public.workflows(id, space_id, name, kind)
  values ('00000000-0000-4000-8000-00000000f100', null, 'Default', null)
  returning id
)
insert into public.workflow_states(workflow_id, name, category, position, is_initial, is_default)
select created.id, seed.name, seed.category, seed.position, seed.is_initial, seed.is_default
from created, (values
  ('To Do',       'to_do',       1, true,  true),
  ('In Progress', 'in_progress', 2, false, true),
  ('Done',        'done',        3, false, true),
  ('Cancelled',   'cancelled',   4, false, true)
) as seed(name, category, position, is_initial, is_default);

-- -----------------------------------------------------------------------------
-- 2. One workflow per existing `task_workflows` row.
--
-- COPY, not move. `task_workflows` keeps its rows, its constraint and its
-- enforcement trigger; it is authoritative for `tasks.work_status` until phase 6
-- retires the `type` axis. Two tables describing the same vocabulary is a
-- transitional cost that was accepted when the phase order was ruled, and the
-- alternative — deleting the rows the live trigger reads — would change every
-- board's behaviour in the middle of a six-phase migration.
--
--   name  = the `type_value`, EXACTLY. Phase 6's join key. Not decorated with
--           " workflow" or title-cased, because a decorated name is a name
--           somebody has to reverse-engineer.
--   kind  = 'task'. Every one of these governs tasks today; phase 6 re-points
--           them at the `c:` kind the type value becomes.
--   states = the row's `statuses[]`, in the product's LIFECYCLE order rather
--           than array order. `statuses` is a set the admin passed in whatever
--           order the UI happened to send, and `position` is what phase 3's
--           resolver reads to pick a category's default state — so ordering it
--           by the array would make "the default in_progress state" depend on
--           the order of checkboxes in a form. The canonical order is the
--           board's own column order (tm8-ui board-screen.test.ts:87):
--           open, pulled, working, in_review, blocked, done, cancelled.
--   category = 147's `internal.work_status_category`, called rather than
--           re-tabulated, so the RULED mapping still lives in exactly one place.
--   is_initial = the `open` state. 132's `task_workflows_structural_statuses`
--           constraint guarantees `open` is in every vocabulary, which is why
--           this can be an unconditional join rather than a fallback chain. The
--           deferred assert above is what turns that reasoning into a check
--           instead of a comment.
--
-- No `is_default` flags: lowest position within the category is exactly right
-- here (`working` before `in_review` before `blocked`), and a flag that agrees
-- with the default is a flag that will disagree with it after the next edit.
-- -----------------------------------------------------------------------------
with canonical(status, ordinal) as (
  values ('open', 1), ('pulled', 2), ('working', 3), ('in_review', 4),
         ('blocked', 5), ('done', 6), ('cancelled', 7)
), created as (
  insert into public.workflows(space_id, name, kind)
  select w.space_id, w.type_value, 'task' from public.task_workflows w
  returning id, space_id, name
)
insert into public.workflow_states(workflow_id, name, category, position, is_initial)
select
  created.id,
  canonical.status,
  internal.work_status_category(canonical.status),
  canonical.ordinal,
  canonical.status = 'open'
from created
join public.task_workflows tw
  on tw.space_id is not distinct from created.space_id and tw.type_value = created.name
join canonical on canonical.status = any (tw.statuses);

-- -----------------------------------------------------------------------------
-- Belt and braces. A seed that silently copied nothing looks exactly like a
-- seed that ran against an empty table, and 147's own verify block is the
-- precedent: prove the instrument had something to measure before trusting it.
-- -----------------------------------------------------------------------------
do $verify$
declare
  source_count   bigint;
  copied_count   bigint;
  state_mismatch bigint;
  bad_initial    bigint;
begin
  select count(*) into source_count from public.task_workflows;
  select count(*) into copied_count from public.workflows where kind = 'task' and space_id is not null;
  if copied_count <> source_count then
    raise exception '148 seed incomplete: % task_workflows rows became % workflows',
      source_count, copied_count;
  end if;

  -- Every vocabulary member became a state, and no extras appeared.
  select count(*) into state_mismatch
    from public.task_workflows tw
    join public.workflows w
      on w.space_id = tw.space_id and w.kind = 'task' and w.name = tw.type_value
   where (select count(*) from public.workflow_states s where s.workflow_id = w.id)
         <> cardinality(tw.statuses);
  if state_mismatch > 0 then
    raise exception '148 seed incomplete: % migrated workflows have the wrong state count',
      state_mismatch;
  end if;

  -- The invariant the deferred trigger enforces going forward, asserted once
  -- for the rows this file itself wrote.
  select count(*) into bad_initial
    from public.workflows w
   where (select count(*) from public.workflow_states s
           where s.workflow_id = w.id and s.is_initial) <> 1;
  if bad_initial > 0 then
    raise exception '148 seed incomplete: % workflows lack exactly one initial state', bad_initial;
  end if;
end
$verify$;

-- =============================================================================
-- ADMIN DOORS
--
-- Shaped exactly like 132's pair, and for the same reasons: space-admin only,
-- replay-ledgered, every rule in SQL. TWO operations, not eight.
--
-- WHY WHOLE-DOCUMENT UPSERT rather than per-state and per-transition CRUD. The
-- invariants here are about a workflow AS A WHOLE — exactly one initial state,
-- unique positions, transitions whose endpoints are its own states. Per-row
-- doors would make every one of those a deferred-constraint dance for the
-- caller ("delete In Review" is legal only in the same transaction as whatever
-- replaces it), and would multiply the catalog surface by four to buy a UI
-- nobody has asked for. One door that takes the whole workflow makes the
-- invariants a property of a single statement, which is also what 132 chose
-- when it put `statuses[]` on the upsert rather than shipping an add-status op.
-- =============================================================================

create or replace function public.upsert_workflow(
  p_space_id uuid,
  p_name text,
  p_kind text,
  p_states jsonb,
  p_transitions jsonb,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  workflow_row public.workflows;
  state_count int;
  initial_count int;
  name_by_key jsonb := '{}'::jsonb;
  element jsonb;
  from_id uuid;
  to_id uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.workflows.upsert');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);

  if p_space_id is null then
    -- The built-in default belongs to no space and to no admin. It is seeded by
    -- migration and changed by migration; a space that wants different states
    -- authors its own workflow, which is the entire point of the table.
    raise exception 'the built-in default workflow is not editable' using errcode = '42501';
  end if;

  if jsonb_typeof(p_states) <> 'array' or jsonb_array_length(p_states) = 0 then
    raise exception 'a workflow needs at least one state' using errcode = '22023';
  end if;

  -- Validity that a check constraint cannot hold (it needs the whole array),
  -- kept to exactly the checks the TABLE cannot make — the category CHECK, the
  -- initial-is-to_do CHECK and the uniqueness indexes all still decide, and a
  -- second copy of them here would drift from the rule that decides.
  select count(*) filter (where (s ->> 'isInitial')::boolean is true), count(*)
    into initial_count, state_count
    from jsonb_array_elements(p_states) s;
  if initial_count <> 1 then
    raise exception 'a workflow needs exactly one initial state, got %', initial_count
      using errcode = '22023',
            detail = json_build_object('reason', 'workflow_initial_state_required')::text;
  end if;

  -- Upsert the envelope. `on conflict` on the natural key is what makes this an
  -- upsert rather than a create — the UI edits one workflow per (kind, name),
  -- the same shape 132's (space, type_value) has.
  insert into public.workflows(space_id, name, kind)
  values (p_space_id, btrim(p_name), nullif(btrim(p_kind), ''))
  on conflict (space_id, kind, name) do update set name = excluded.name
  returning * into workflow_row;

  -- REPLACE the state set. A state still holding entities cannot be deleted —
  -- `entities_status_id_fkey` is ON DELETE RESTRICT and this is exactly where
  -- that refusal is supposed to surface. Matching on NAME (the table's own
  -- natural key) is what keeps a rename-free edit from orphaning live work.
  delete from public.workflow_states s
   where s.workflow_id = workflow_row.id
     and s.name <> all (select coalesce(e ->> 'name', '') from jsonb_array_elements(p_states) e);

  insert into public.workflow_states(workflow_id, name, category, position, is_initial, is_default)
  select
    workflow_row.id,
    e ->> 'name',
    e ->> 'category',
    coalesce((e ->> 'position')::int, ordinality::int),
    coalesce((e ->> 'isInitial')::boolean, false),
    coalesce((e ->> 'isDefault')::boolean, false)
  from jsonb_array_elements(p_states) with ordinality as t(e, ordinality)
  on conflict (workflow_id, name) do update set
    category   = excluded.category,
    position   = excluded.position,
    is_initial = excluded.is_initial,
    is_default = excluded.is_default;

  -- Transitions are addressed by state NAME, never by id: a caller authoring a
  -- workflow in one call does not have ids to reference, and a caller editing
  -- one should not have to fetch them. NULL/absent `from` is the ANY arm.
  select jsonb_object_agg(s.name, to_jsonb(s.id)) into name_by_key
    from public.workflow_states s where s.workflow_id = workflow_row.id;

  delete from public.workflow_transitions where workflow_id = workflow_row.id;

  if jsonb_typeof(p_transitions) = 'array' then
    for element in select value from jsonb_array_elements(p_transitions) loop
      to_id := (name_by_key ->> (element ->> 'to'))::uuid;
      if to_id is null then
        raise exception 'transition names unknown state %', element ->> 'to'
          using errcode = '22023',
                detail = json_build_object('reason', 'unknown_state', 'state', element ->> 'to')::text;
      end if;
      if element ? 'from' and jsonb_typeof(element -> 'from') <> 'null' then
        from_id := (name_by_key ->> (element ->> 'from'))::uuid;
        if from_id is null then
          raise exception 'transition names unknown state %', element ->> 'from'
            using errcode = '22023',
                  detail = json_build_object('reason', 'unknown_state', 'state', element ->> 'from')::text;
        end if;
      else
        from_id := null;
      end if;
      insert into public.workflow_transitions(workflow_id, from_state_id, to_state_id, conditions)
      values (workflow_row.id, from_id, to_id, coalesce(element -> 'conditions', '{}'::jsonb))
      on conflict (workflow_id, from_state_id, to_state_id) do update
        set conditions = excluded.conditions;
    end loop;
  end if;

  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.workflows.upsert',
    jsonb_build_object(
      'workflow', to_jsonb(workflow_row),
      'states', (select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
                   from public.workflow_states s where s.workflow_id = workflow_row.id),
      'transitions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
                        from public.workflow_transitions t where t.workflow_id = workflow_row.id),
      'patches', '[]'::jsonb
    )
  );
end
$$;

create or replace function public.delete_workflow(
  p_space_id uuid,
  p_workflow_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  row_found public.workflows;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.workflows.delete');
  if replay is not null then return replay; end if;

  perform internal.require_space_admin(p_space_id);
  perform internal.resolve_actor(internal.actor_id(), p_space_id);

  select * into row_found
    from public.workflows
   where id = p_workflow_id and space_id = p_space_id
   for update;
  if row_found.id is null then
    -- Also the answer for the built-in default, whose space_id is NULL and
    -- therefore matches no caller's p_space_id. Not found is the right shape:
    -- it is not the caller's row to delete and its existence is not news.
    raise exception 'workflow not found' using errcode = 'P0002';
  end if;

  -- Unlike 132's delete — which was never data loss because it merely widened a
  -- vocabulary — this one CAN be: states cascade, and an entity sitting in one
  -- is protected only by `entities_status_id_fkey`'s RESTRICT. That FK raises
  -- 23503 through the cascade, so the refusal is real and no second check here
  -- would add anything except a way to disagree with it.
  delete from public.workflows where id = p_workflow_id;

  return internal.ledger_record(
    p_client_mutation_id,
    'spaces.workflows.delete',
    jsonb_build_object('workflowId', p_workflow_id, 'patches', '[]'::jsonb)
  );
end
$$;

grant select on public.workflows, public.workflow_states, public.workflow_transitions to tm8_app;

-- 138 EXISTS BECAUSE 132 SKIPPED THESE TWO LINES. A `security definer` function
-- is `execute`-able by PUBLIC by default, so granting it to `tm8_app` is not
-- what restricts it — revoking it from PUBLIC is. 132 shipped without the
-- revoke and `138_task_workflow_grant_repair.sql` is the whole migration that
-- exists to add it, after the `tm8_delivery_worker` surface sweep went red.
-- Doing it in the same file as the function is the only version of this that
-- does not need a sequel.
revoke all on function
  public.upsert_workflow(uuid, text, text, jsonb, jsonb, text),
  public.delete_workflow(uuid, uuid, text)
from public;

grant execute on function
  public.upsert_workflow(uuid, text, text, jsonb, jsonb, text),
  public.delete_workflow(uuid, uuid, text)
to tm8_app;

reset role;
