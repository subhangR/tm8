-- =============================================================================
-- 153  KIND ABSORBS THE TYPE AXIS.
--
-- Phase 6 of "Kind, Status, Category, Workflow", and the phase the first five
-- were building toward. 147 gave the envelope a category, 149 built the workflow
-- tables, 150 pointed the doors at them, 151 moved the completion gate onto the
-- transition, 152 gave every kind a workflow. Each of those widened a mechanism.
-- This one DELETES one.
--
-- ## The two mechanisms that never intersected
--
-- Until this file a space had two ways to say "this is an epic":
--
--   the `type` axis    a row in `task_axes` named `type`, whose values are TAGS.
--                      A value can carry a status vocabulary (132's
--                      `task_workflows`) and nothing else — no icon, no fields,
--                      no label, no behaviour. Task-only.
--   a `c:` kind        a row in `entity_kinds` with a typed, evolvable field
--                      schema (001/005/027) and an icon — and, until this file,
--                      no status, no workflow, no task behaviour, rendering as
--                      the one static "Item" row in the client registry.
--
-- Neither is the concept. The concept is the UNION of the two columns, and it is
-- spelled KIND. This file merges them: a `type` value becomes a `c:` kind that
-- EXTENDS `task`, and the axis dies.
--
-- ## THIS IS ONE CHANGE, and that is a correctness property
--
-- A space that can define both `c:epic` and a `type` value `epic` has two
-- answers to "what does the board group by". There is deliberately no window in
-- which both exist: the kinds are created, the tasks are re-kinded, the axis
-- values are stripped and the axis row is deleted inside this transaction.
--
-- ## `extends`, and only `extends`
--
-- `entity_kinds.base_kind` is the inheritance link and it is NOT decoration —
-- it says WHICH IRREDUCIBLE CODE RUNS. `c:epic` with `base_kind = 'task'` has a
-- `public.tasks` detail row and therefore assignees, acceptance criteria,
-- points, the spawn door and the completion gate, because every one of those is
-- reached through machinery that asks the ROW what it carries. What it cannot do
-- is grow a terminal by configuration: `base_kind` selects among behaviours that
-- already exist, which is why this is not an amendment of T-L4/T-D11 ("custom
-- kinds are data-shaped, not behavior-shaped"). Single inheritance only. No
-- `implements`, no mixins.
--
-- **`base_kind` is constrained to `task` and nothing else** (see §1). Not because
-- the mechanism is task-shaped — it is not — but because a base kind is a
-- promise that a detail row of that shape can be CREATED, and `task` is the only
-- one whose create door this file widens. Widening the set is a one-line
-- constraint change plus a door; guessing at the promise now is how a kind ends
-- up declaring a base whose rows nothing can make.
--
-- ## THE AMENDMENT: parenting follows the BASE kind (ruled 2026-08-18)
--
-- `internal.validate_entity_parent` (001:397) has required parent and child to
-- share a kind for the whole life of the schema, so `c:epic` could never parent
-- a `task`. The design left epic→story containment open between "an edge" and
-- "move the constraint"; it was RULED to move the constraint.
--
-- Edge-based containment was rejected because it would make epic→story invisible
-- to `entity_tree`, to subtree progress rollups and to drag-into-parent, and
-- would need a parallel rendering path beside the one hierarchy already has.
-- The positive argument is stronger: `base_kind` already means "which code
-- runs". If a `c:epic` IS a task for assignees, acceptance, spawn and
-- completion, then refusing it as a parent of tasks makes the IS-A claim a lie
-- at exactly the layer where epics matter most.
--
-- The cost is accepted and paid here: "a subtree is homogeneous in kind" was an
-- invariant this trigger enforced, and three other places leaned on it.
-- `internal.assign_entity_position` scoped sibling positions by kind (§3.2) and
-- would have handed a task and an epic under one parent the same position.
-- `public.entity_tree` (007:2309) already emits `kind` per row and asserts
-- nothing, and the recursive subtree walks in `delete_entity`/`restore_entity`
-- key on `parent_id` alone — both were audited and are correct unchanged.
--
-- ## What actually runs, in order
--
--   1. `entity_kinds` gains `base_kind`, `label`, `label_plural`.
--   2. `internal.base_kind_of` — the one resolver. Everything else calls it.
--   3. The five invariants that compared kind literals compare BASE kinds:
--      parent, position, detail envelope, edge endpoints, `live_entity`.
--      `internal.entity_content` dispatches on the base kind.
--   4. Workflow resolution loses its `type`-value arm — the arm 150 wrote and
--      marked "PHASE 6 DELETES THIS". Four functions stop reading `axes->>'type'`.
--   5. The doors: `create_task` learns a kind, `complete_task` /
--      `place_entity` / `derive_task_for_entity` stop reading the literal, and
--      the entity-kind CRUD learns `extends`.
--   6. THE MIGRATION: type values → `c:` kinds → tasks re-kinded → axis gone.
--   7. `task_workflows` is retired whole: trigger, function, both RPCs, table.
--
-- ## Migration-number provenance
--
-- 152 was the highest prefix on `origin/main` when this file was written and
-- again when it was pushed. Three lanes have raced this counter in this program;
-- a stolen prefix surfaces as a MERGE CONFLICT on the sweep chain-count pin,
-- not as a migration error.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. THE KIND ROW LEARNS WHAT IT IS.
--
-- `label`/`label_plural` do not exist today: the client derives a label by
-- slicing `c:` off the front, which is why every custom kind in the product
-- renders as "Item". They are nullable, and NULL keeps meaning "the client's
-- registry row is authoritative" — Phase 10 is what serves them for core kinds.
-- What this file populates is the labels of the kinds it CREATES, because a
-- migrated `epic` that rendered as "Item" would be a regression against the
-- axis it replaces.
--
-- `base_kind` is `custom`-only and `task`-only, both enforced. A CORE kind
-- extending another core kind would be a second dispatch path over code that
-- already dispatches on the kind literal, and there is no such kind. See the
-- header for why the value set is one element wide.
-- -----------------------------------------------------------------------------
alter table public.entity_kinds
  add column label        text check (label is null or char_length(btrim(label)) between 1 and 100),
  add column label_plural text check (label_plural is null or char_length(btrim(label_plural)) between 1 and 100),
  add column base_kind    text;

alter table public.entity_kinds
  add constraint entity_kinds_base_kind_shape check (
    base_kind is null or (origin = 'custom' and base_kind = 'task')
  );

comment on column public.entity_kinds.base_kind is
  'The `extends` link. NOT decoration: it names which irreducible code runs for '
  'entities of this kind. A row with base_kind = ''task'' carries a public.tasks '
  'detail row and inherits assignees, acceptance criteria, points, the spawn '
  'door and the completion gate. Resolved by internal.base_kind_of; constrained '
  'to ''task'' because that is the only base whose create door exists.';
comment on column public.entity_kinds.label is
  'Singular display label. NULL means the client registry row is authoritative.';
comment on column public.entity_kinds.label_plural is
  'Plural display label. NULL means the client registry row is authoritative.';

-- -----------------------------------------------------------------------------
-- 2. THE RESOLVER.
--
-- One function, called from five triggers and four doors, so that "what does
-- this kind really behave as" has exactly one answer and one place to change.
--
-- `stable`, not `immutable`: it reads a table. It is on the hot path of every
-- entity insert and every edge write, and the read it does is a unique-index
-- probe on `entity_kinds(space_id, kind)` — a table with tens of rows.
--
-- A NULL space (a core kind's own row, or a caller that has no space in hand)
-- resolves to the kind itself, because `entity_kinds_base_kind_shape` forbids a
-- core row from carrying a base at all: there is nothing to find.
-- -----------------------------------------------------------------------------
create or replace function internal.base_kind_of(p_kind text, p_space_id uuid)
returns text language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select k.base_kind
       from public.entity_kinds k
      where k.kind = p_kind
        and k.space_id = p_space_id
        and k.base_kind is not null
      limit 1),
    p_kind)
$$;

comment on function internal.base_kind_of(text, uuid) is
  'coalesce(entity_kinds.base_kind, kind) for one kind in one space. THE '
  'resolver: every invariant that used to compare a kind literal compares this '
  'instead, which is what makes `c:epic extends task` true rather than merely '
  'recorded.';

-- -----------------------------------------------------------------------------
-- 3. THE INVARIANTS THAT COMPARED LITERALS NOW COMPARE BASES.
--
-- Five of them, and the audit that says five is the whole list is in the header.
-- Each keeps its original body verbatim except the marked comparison, because a
-- reissue is the only way PostgreSQL lets a line inside a function change and a
-- reissue that also rewrites something else is how an unrelated regression
-- arrives with no diff to blame.
-- -----------------------------------------------------------------------------

-- 3.1 PARENT. THE AMENDMENT. `c:epic` (base `task`) may parent `task`.
create or replace function internal.validate_entity_parent() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare parent public.entities;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'entity cannot be its own parent' using errcode = '23514';
  end if;

  select * into parent from public.entities where id = new.parent_id;
  if not found then
    raise exception 'parent entity does not exist' using errcode = '23503';
  end if;
  if parent.space_id <> new.space_id then
    raise exception 'parent must be in the same space' using errcode = '23514';
  end if;
  -- 153: SAME BASE KIND, not the same kind. The literal comparison this
  -- replaces is the reason `c:epic` could never parent a story. The message
  -- names both the kinds and the bases, because "task must be the same kind as
  -- task" is the refusal a reader would otherwise get when two custom kinds
  -- with different bases meet.
  if internal.base_kind_of(parent.kind, parent.space_id)
     <> internal.base_kind_of(new.kind, new.space_id) then
    raise exception 'parent must share the child''s base kind (% [%] <> % [%])',
      parent.kind, internal.base_kind_of(parent.kind, parent.space_id),
      new.kind, internal.base_kind_of(new.kind, new.space_id)
      using errcode = '23514';
  end if;

  if exists (
    with recursive ancestors(id, depth) as (
      select parent.id, 1
      union all
      select e.parent_id, a.depth + 1
        from public.entities e
        join ancestors a on e.id = a.id
       where e.parent_id is not null
         and a.depth < 1024
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'hierarchy cycle refused' using errcode = '23514';
  end if;
  return new;
end
$$;

comment on function internal.validate_entity_parent() is
  'Hierarchy is same-BASE-kind as of 153 (was same-kind since 001). Space, '
  'self-parent and cycle rules unchanged.';

-- 3.2 POSITION. The direct consequence of 3.1: siblings under one parent may now
-- be of different kinds sharing a base, and a max() scoped by the literal kind
-- would hand an epic and a task the same position — a silent ordering collision
-- with no error and no test that would notice.
create or replace function internal.assign_entity_position() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.position is null then
    select coalesce(max(e.position), 0) + 1 into new.position
      from public.entities e
     where e.space_id = new.space_id
       and internal.base_kind_of(e.kind, e.space_id)
           = internal.base_kind_of(new.kind, new.space_id)
       and e.parent_id is not distinct from new.parent_id
       and e.deleted_at is null
       and e.id <> new.id;
  end if;
  return new;
end
$$;

-- 3.3 DETAIL ENVELOPE. This is what lets a `c:epic` have a `public.tasks` row at
-- all: the trigger `tasks_validate_kind` passes `'task'` as its expected kind and
-- has compared it to `entities.kind` since 001.
create or replace function internal.validate_detail_envelope() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  expected text := tg_argv[0];
  e public.entities;
  declared_space text;
begin
  select * into e from public.entities where id = new.entity_id;
  if e.id is null then
    raise exception '% detail row has no entity', expected using errcode = '23503';
  end if;
  -- 153: a detail row belongs to an entity whose BASE kind is this table's kind.
  if internal.base_kind_of(e.kind, e.space_id) <> expected then
    raise exception '% detail row requires an entity of kind % (got %)', expected, expected, e.kind
      using errcode = '23514';
  end if;
  declared_space := to_jsonb(new) ->> 'space_id';
  if declared_space is not null and declared_space::uuid <> e.space_id then
    raise exception '% detail row space_id must match its envelope', expected using errcode = '23514';
  end if;
  return new;
end
$$;

-- 3.4 EDGE ENDPOINTS. `assigned_to` declares src_kinds `{task}` and `working_on`
-- declares dst_kinds `{task}` (001:902,905). An epic that could not be assigned
-- or worked on would inherit the task's shape and none of its verbs.
--
-- The registry arrays keep naming CORE kinds only; widening happens at the
-- comparison, not by writing every custom kind into every array — which is the
-- posture that makes a kind created tomorrow work without a migration.
create or replace function internal.validate_edge() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  src public.entities;
  dst public.entities;
  registered public.edge_types;
  src_base text;
  dst_base text;
begin
  select * into src from public.entities where id = new.src_id;
  select * into dst from public.entities where id = new.dst_id;
  if src.id is null or dst.id is null then
    raise exception 'edge endpoint does not exist' using errcode = '23503';
  end if;
  if src.space_id <> new.space_id or dst.space_id <> new.space_id then
    raise exception 'edge endpoints must live in the edge space' using errcode = '23514';
  end if;

  select * into registered from public.edge_types where type = new.type;
  if found then
    -- 153: an endpoint satisfies the registry by its own kind OR by its base.
    -- Both are accepted, so a registry array naming a custom kind directly
    -- keeps working.
    src_base := internal.base_kind_of(src.kind, src.space_id);
    dst_base := internal.base_kind_of(dst.kind, dst.space_id);
    -- '*' means any registered kind: used by the deliberately-any types.
    if not (src.kind = any(registered.src_kinds) or src_base = any(registered.src_kinds)
            or registered.src_kinds = array['*']) then
      raise exception 'edge % rejects source kind %', new.type, src.kind using errcode = '23514';
    end if;
    if not (dst.kind = any(registered.dst_kinds) or dst_base = any(registered.dst_kinds)
            or registered.dst_kinds = array['*']) then
      raise exception 'edge % rejects destination kind %', new.type, dst.kind using errcode = '23514';
    end if;
  elsif new.type !~ '^x:[a-z0-9][a-z0-9_]{0,48}$' then
    raise exception 'unregistered edge types must be namespaced x:*' using errcode = '23514';
  end if;
  return new;
end
$$;

-- 3.5 `internal.live_entity`. THE HIGH-LEVERAGE ONE, and the reason this file
-- does not have to reissue `public.execution_spawn`.
--
-- Four doors assert "this id is a task" by calling `live_entity(id, 'task')`:
-- `set_work_state` (151:551), `update_task_content` (038:374) and
-- `execution_spawn` (150:791) — the last of which carries a documented
-- five-migration merge hazard and is the function this program most wants to
-- leave alone. Widening the assertion here widens all four, and does it in nine
-- lines instead of six hundred.
create or replace function internal.live_entity(target uuid, expected_kind text default null)
returns public.entities language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare e public.entities;
begin
  select * into e from public.entities where id = target and deleted_at is null;
  if e.id is null then
    raise exception 'entity % not found', target using errcode = 'P0002';
  end if;
  -- 153: the kind OR its base satisfies the expectation.
  if expected_kind is not null
     and e.kind <> expected_kind
     and internal.base_kind_of(e.kind, e.space_id) <> expected_kind then
    raise exception 'entity % is a %, expected %', target, e.kind, expected_kind using errcode = '22023';
  end if;
  return e;
end
$$;

-- 3.6 CONTENT ASSEMBLY. `internal.entity_content` routed every `c:%` kind to
-- `public.custom_entities` (135:105). A `c:epic` whose body lives in
-- `public.tasks` would have assembled to NULL there — no title on the event
-- path, no title in any read that goes through this function.
--
-- The dispatch key becomes the BASE kind. The `fields` overlay is what keeps the
-- other half of the promise: a kind that extends `task` AND declares a field
-- schema gets both, rather than having to choose. Nothing creates such a row
-- yet — §5.4 refuses a field schema on an inheriting kind until the create door
-- can populate one — and the overlay is written now because the alternative is a
-- reader discovering the absence as a NULL.
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb; base text; custom_fields jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  base := internal.base_kind_of(e.kind, e.space_id);
  if base like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case base
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      else content := '{}'::jsonb;
    end case;
    -- An INHERITING kind: the base's detail row is the body, and the custom
    -- fields ride alongside when the kind has any.
    if e.kind like 'c:%' then
      select c.fields into custom_fields from public.custom_entities c where c.entity_id = target;
      content := coalesce(content, '{}'::jsonb)
                 || jsonb_build_object('fields', coalesce(custom_fields, '{}'::jsonb));
    end if;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. WORKFLOW RESOLUTION LOSES ITS TYPE-VALUE ARM.
--
-- 150 wrote that arm and marked it "PHASE 6 DELETES THIS ARM"; 152 carried it
-- forward unchanged. It resolved a task's workflow by looking up 149's copy of
-- `task_workflows`, keyed on `tasks.axes ->> 'type'`. With the type value gone,
-- the lookup has no key and the arm has no subject: the kind's own
-- `workflow_id` (arm 0, added by 152) is now the whole answer for the kinds this
-- file creates, because §6 writes it there.
--
-- The parameter goes with the arm. A defaulted-away `p_type_value` that every
-- caller passes NULL to is a slot the next reader has to prove is dead, so the
-- signature changes and PostgreSQL is made to find the callers. DROP before
-- CREATE, deliberately: `create or replace` with a shorter argument list creates
-- an OVERLOAD, and a two-argument call would then be ambiguous against the
-- three-argument one with its default.
-- -----------------------------------------------------------------------------
drop function internal.workflow_initial_state(uuid, text, text);
drop function internal.workflow_for_entity(uuid, text, text);

create function internal.workflow_for_entity(p_space_id uuid, p_kind text)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select coalesce(
    -- 0. the kind's own workflow — the space's row for this kind…
    (select k.workflow_id from public.entity_kinds k
      where k.kind = p_kind and k.space_id = p_space_id and k.workflow_id is not null
      limit 1),
    --    …else the core row for it. (A core kind cannot carry a per-space
    --    workflow: `entity_kinds_origin_shape` limits space-scoped rows to `c:`
    --    names, so a core kind's only options are a global workflow or the
    --    default. Phase 5 measured this; it is a property of the schema, not an
    --    omission here.)
    (select k.workflow_id from public.entity_kinds k
      where k.kind = p_kind and k.space_id is null and k.workflow_id is not null
      limit 1),
    -- 1. THE built-in default workflow. (149's per-type arm was here. It is
    --    gone with the type axis; the vocabulary it carried now belongs to a
    --    kind, and arm 0 finds it.)
    (select w.id from public.workflows w where w.space_id is null limit 1)
  )
$$;

comment on function internal.workflow_for_entity(uuid, text) is
  'Which workflow governs an entity: entity_kinds.workflow_id (the space row, '
  'then the core row), else THE built-in default. 153 removed the per-type arm '
  'and its parameter when the type axis was retired into kind.';

create function internal.workflow_initial_state(p_space_id uuid, p_kind text)
returns uuid language sql stable set search_path = public, internal, pg_temp as $$
  select s.id from public.workflow_states s
   where s.workflow_id = internal.workflow_for_entity(p_space_id, p_kind)
     and s.is_initial
   limit 1
$$;

-- 4.1 The three callers that read the axis.
create or replace function internal.workflow_state_for_category(
  p_entity_id uuid, p_category text
) returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  wf_id uuid;
  resolved_state uuid;
begin
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then
    raise exception 'entity % not found', p_entity_id using errcode = 'P0002';
  end if;

  -- 153: 150 read `tasks.axes ->> 'type'` here and threaded it into the
  -- resolver. The kind IS the answer now.
  wf_id := internal.workflow_for_entity(e.space_id, e.kind);
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

create or replace function internal.workflow_state_for_work_status(
  p_entity_id uuid, p_work_status text
) returns uuid language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  wf_id uuid;
  resolved_state uuid;
begin
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then return null; end if;

  -- 153: the type-value lookup that stood here is gone with the axis.
  wf_id := internal.workflow_for_entity(e.space_id, e.kind);
  if wf_id is null then return null; end if;

  select s.id into resolved_state from public.workflow_states s
   where s.workflow_id = wf_id and s.name = p_work_status;
  if resolved_state is not null then return resolved_state; end if;

  return internal.find_workflow_state_for_category(
    wf_id, internal.work_status_category(p_work_status));
end
$$;

create or replace function internal.seed_entity_initial_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  resolved_state uuid;
begin
  if new.status_id is null and new.status_category is null then
    if internal.kind_seeds_done(new.kind) then
      resolved_state := internal.find_workflow_state_for_category(
        internal.workflow_for_entity(new.space_id, new.kind), 'done');
    end if;
    if resolved_state is null then
      resolved_state := internal.workflow_initial_state(new.space_id, new.kind);
    end if;
    if resolved_state is not null then
      new.status_id := resolved_state;
    elsif internal.base_kind_of(new.kind, new.space_id) = 'task' then
      new.status_category := internal.work_status_category('open');
    end if;
  end if;
  return new;
end
$$;

-- 4.2 `internal.workflow_kind_is_executable` — the widening point 150 named.
--
-- 150 wrote it as `p_kind is null or p_kind = 'task'` and said in as many words
-- that "phase 6 gives `c:` kinds a `base_kind`; both widen THIS function".
--
-- It keeps its one-argument signature and therefore cannot know which space is
-- asking. That is not a gap: the question it answers is "can entities of this
-- kind be spawned and completed", the answer is a property of the BASE, and two
-- spaces that both define `c:epic` extending `task` give the same answer. The
-- only construction that differs is two spaces defining the same custom NAME
-- with different bases — where this returns true for both, which widens the
-- coverage assertion it feeds. That assertion is a REQUIREMENT ("this workflow
-- must cover all four categories"), so a false positive asks for more, never
-- less: the safe direction.
--
-- `immutable` → `stable`. It reads a table now.
create or replace function internal.workflow_kind_is_executable(p_kind text)
returns boolean language sql stable set search_path = public, internal, pg_temp as $$
  select p_kind is null
      or p_kind = 'task'
      or exists (select 1 from public.entity_kinds k
                  where k.kind = p_kind and k.base_kind = 'task')
$$;

comment on function internal.workflow_kind_is_executable(text) is
  'Whether entities of this kind reach the spawn and completion doors — true '
  'for `task` and for every kind that extends it. 153 widened it from the '
  'literal, which is the widening 150 wrote it to receive.';

-- -----------------------------------------------------------------------------
-- 5. THE DOORS.
-- -----------------------------------------------------------------------------

-- 5.1 `create_task` learns which kind it is creating.
--
-- The default keeps every existing caller honest — `create_task(...)` with no
-- kind still makes a `task`. DROP before CREATE for the same ambiguity reason as
-- §4, and the explicit grant because DROP takes the ACL with it.
drop function public.create_task(uuid, text, uuid, text, jsonb, uuid, double precision,
                                 text, jsonb, integer, date, uuid, text, text);

create function public.create_task(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_axes jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_priority text default 'medium',
  p_acceptance_criteria jsonb default '[]'::jsonb, p_points_estimate integer default null,
  p_due_date date default null, p_attach_to uuid default null,
  p_attach_edge_type text default 'attached_to', p_client_mutation_id text default null,
  p_kind text default 'task'
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  task_id uuid;
  activity_id uuid;
  result jsonb;
  initial_state uuid;
  kind text := coalesce(nullif(btrim(p_kind), ''), 'task');
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

  -- 153: the door accepts `task` and any kind of this space that EXTENDS task.
  -- Refusing here rather than letting the detail-envelope trigger refuse means
  -- the caller gets "kind X does not extend task" instead of "task detail row
  -- requires an entity of kind task", which names the wrong thing.
  if internal.base_kind_of(kind, p_space_id) <> 'task' then
    raise exception 'kind % does not extend task', kind using errcode = '22023',
      detail = json_build_object('reason', 'kind_does_not_extend_task', 'kind', kind)::text;
  end if;

  -- 150: the workflow's INITIAL state, not the literal 'open'. 153: resolved
  -- from the KIND, which is where the vocabulary the `type` value used to carry
  -- now lives.
  initial_state := internal.workflow_initial_state(p_space_id, kind);

  task_id := internal.create_envelope(p_space_id, kind, actor, p_parent_id, p_position,
                                      initial_state);
  insert into public.tasks(entity_id, title, description, axes, priority,
                           acceptance_criteria, points_estimate, due_date)
  values (task_id, p_title, coalesce(p_description, ''), coalesce(p_axes, '{}'::jsonb),
          coalesce(p_priority, 'medium'), coalesce(p_acceptance_criteria, '[]'::jsonb),
          p_points_estimate, p_due_date);
  perform internal.record_initial_version(task_id, actor);
  perform internal.attach_on_create(p_space_id, task_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, task_id, actor, 'created',
                   null, jsonb_build_object('kind', kind));

  result := internal.command_result(task_id, null, activity_id, array[task_id]);
  return internal.ledger_record(p_client_mutation_id, 'entities.create', result);
end
$$;

revoke all on function public.create_task(uuid, text, uuid, text, jsonb, uuid, double precision,
  text, jsonb, integer, date, uuid, text, text, text) from public;
grant execute on function public.create_task(uuid, text, uuid, text, jsonb, uuid, double precision,
  text, jsonb, integer, date, uuid, text, text, text) to tm8_app;

-- 5.2 `complete_task`. 151's body verbatim except the `kind = 'task'` literal in
-- the lookup, which would have made an epic uncompletable.
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
  -- 153: base kind, so a `c:epic` completes through the same door and the same
  -- gate. `for update` posture unchanged.
  select * into e from public.entities
   where id = p_task_id
     and internal.base_kind_of(kind, space_id) = 'task'
     and deleted_at is null
   for update;
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
  -- transition's conditions and are reached from the status write below. THE ONE
  -- CASE THE TRIGGER CANNOT SEE is a task with no status at all: adoption is not
  -- a transition, so a NULL `status_id` would take the birth arm and skip both.
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

-- 5.3 `place_entity` (018:301) holds TWO kind literals, and the second one is
-- the drag-into-parent path the ruling named.
--
--   `assign`   decided direction by comparing both endpoints to `task`, so
--              assigning a member to an epic raised "assign needs a task and a
--              member/team_member" — about an entity that IS one.
--   `subtask`  / `reparent` refused unless `source.kind = target.kind`. That is
--              `validate_entity_parent`'s rule stated a second time, in a second
--              place, and if only the trigger moved then dropping a story onto
--              an epic would be refused HERE while the same move made through
--              `entities.patch` succeeded. Two answers again.
--
-- 018's body otherwise verbatim.
create or replace function public.place_entity(
  p_source_id uuid, p_target_id uuid, p_intent text, p_embed_message text default null,
  p_position double precision default null, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, internal, pg_temp
as $$
declare
  replay jsonb;
  source public.entities;
  target public.entities;
  actor uuid;
  task_id uuid;
  assignee_id uuid;
  next_position double precision;
  result jsonb;
  message_result jsonb;
  message_id uuid;
  body text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'placements.apply');
  if replay is not null then return replay; end if;
  source := internal.live_entity(p_source_id);
  target := internal.live_entity(p_target_id);
  if source.space_id <> target.space_id then
    raise exception 'placement endpoints must be in the same space' using errcode = '23514';
  end if;
  perform internal.require_space_member(source.space_id);
  actor := internal.resolve_actor(p_actor_id, source.space_id);
  perform internal.bind_actor(actor);

  case p_intent
    when 'attach' then
      result := public.write_edge(
        p_source_id, p_target_id, 'attached_to', '{}'::jsonb, actor, null);
      if p_embed_message is not null then
        body := concat_ws(
          ' ', nullif(btrim(p_embed_message), ''),
          '{{embed:' || p_source_id::text || '}}');
        message_result := public.post_message(
          p_target_id, body, actor, null, '[]'::jsonb, '[]'::jsonb, null);
      end if;

    when 'assign' then
      -- 153: base kind on both arms. An epic is assignable because it is a task.
      if internal.base_kind_of(source.kind, source.space_id) = 'task'
         and target.kind in ('member','team_member') then
        task_id := source.id;
        assignee_id := target.id;
      elsif internal.base_kind_of(target.kind, target.space_id) = 'task'
            and source.kind in ('member','team_member') then
        task_id := target.id;
        assignee_id := source.id;
      else
        raise exception 'assign needs a task and a member/team_member' using errcode = '22023';
      end if;
      result := public.write_edge(
        task_id, assignee_id, 'assigned_to', '{}'::jsonb, actor, null);

    when 'depend' then
      result := public.write_edge(
        p_target_id, p_source_id, 'depends_on', '{"hard":true}'::jsonb, actor, null);

    when 'subtask', 'reparent' then
      -- 153: SAME BASE KIND, matching internal.validate_entity_parent exactly.
      if internal.base_kind_of(source.kind, source.space_id)
         <> internal.base_kind_of(target.kind, target.space_id) then
        raise exception 'hierarchy placements require same-base-kind endpoints' using errcode = '22023';
      end if;
      if p_position is null then
        select coalesce(max(e.position), -1) + 1 into next_position
          from public.entities e
         where e.parent_id = p_target_id and e.deleted_at is null;
      else
        next_position := p_position;
      end if;
      result := public.move_entity(
        p_source_id, p_target_id, next_position, source.version, actor, null);

    when 'embed' then
      body := concat_ws(
        ' ', nullif(btrim(coalesce(p_embed_message, '')), ''),
        '{{embed:' || p_source_id::text || '}}');
      message_result := public.post_message(
        p_target_id, body, actor, null, '[]'::jsonb, '[]'::jsonb, null);
      message_id := (message_result #>> '{entity,id}')::uuid;
      result := jsonb_set(
        message_result,
        '{undo}',
        internal.issue_undo_token(
          source.space_id, actor, 'Undo embed', 'messages.delete',
          jsonb_build_object('messageId', message_id)),
        true);

    else
      raise exception 'unsupported placement intent: %', p_intent using errcode = '22023';
  end case;

  return internal.ledger_record(p_client_mutation_id, 'placements.apply', result);
end
$$;

-- 5.4 The entity-kind CRUD learns `extends`, and the labels.
--
-- The refusal of a field schema on an inheriting kind is stated as a refusal,
-- not omitted: `create_task` writes a `public.tasks` row and no
-- `public.custom_entities` row, so a declared field would be a schema nothing
-- can populate. §3.6 already reads such a row if one appears. This is the line
-- that lifts when the create door grows a `p_fields`.
create or replace function internal.w2g12_entity_kind_view(p_kind_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', kind_row.id,
    'kind', kind_row.kind,
    'origin', kind_row.origin,
    'spaceId', kind_row.space_id,
    'icon', kind_row.icon,
    'label', kind_row.label,
    'labelPlural', kind_row.label_plural,
    'baseKind', kind_row.base_kind,
    'workflowId', kind_row.workflow_id,
    'fieldSchema', kind_row.field_schema,
    'capabilities', kind_row.capabilities,
    'createdBy', kind_row.created_by,
    'createdAt', internal.w2g12_iso(kind_row.created_at)
  )
  from public.entity_kinds kind_row where kind_row.id = p_kind_id
$$;

create or replace function internal.assert_base_kind(p_base_kind text, p_field_schema jsonb)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if p_base_kind is null then
    return;
  end if;
  if p_base_kind <> 'task' then
    raise exception 'a kind may only extend `task` (got %)', p_base_kind using errcode = '22023',
      detail = json_build_object('reason', 'unsupported_base_kind', 'baseKind', p_base_kind)::text;
  end if;
  if jsonb_array_length(coalesce(p_field_schema, '[]'::jsonb)) > 0 then
    raise exception 'a kind that extends task may not declare custom fields yet'
      using errcode = '22023',
            detail = json_build_object('reason', 'base_kind_with_field_schema')::text;
  end if;
end
$$;

create or replace function public.w2_create_entity_kind(
  p_space_id uuid,
  p_kind text,
  p_icon text,
  p_field_schema jsonb,
  p_capabilities jsonb,
  p_actor_id uuid,
  p_client_mutation_id text,
  p_base_kind text default null,
  p_label text default null,
  p_label_plural text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; kind_id uuid; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entityKinds.create');
  if replay is not null then
    perform internal.w2g12_authorize_replay('entityKinds.create', replay);
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  if p_kind is null or p_kind !~ '^c:[a-z0-9][a-z0-9_]{0,48}$' then
    raise exception 'custom entity kinds must use the c:* namespace' using errcode = '22023';
  end if;
  if p_icon is not null and char_length(p_icon) > 100 then
    raise exception 'entity-kind icon is too long' using errcode = '22023';
  end if;
  perform internal.w2g12_assert_field_schema(coalesce(p_field_schema, '[]'::jsonb));
  perform internal.w2g12_assert_capabilities(coalesce(p_capabilities, '{}'::jsonb));
  perform internal.assert_base_kind(nullif(btrim(coalesce(p_base_kind, '')), ''),
                                    coalesce(p_field_schema, '[]'::jsonb));
  insert into public.entity_kinds(kind, origin, space_id, icon, field_schema, capabilities,
                                  base_kind, label, label_plural, created_by)
  values (p_kind, 'custom', p_space_id, p_icon, coalesce(p_field_schema, '[]'::jsonb),
          coalesce(p_capabilities, '{}'::jsonb),
          nullif(btrim(coalesce(p_base_kind, '')), ''),
          nullif(btrim(coalesce(p_label, '')), ''),
          nullif(btrim(coalesce(p_label_plural, '')), ''),
          actor)
  returning id into kind_id;
  result := internal.w2g12_entity_kind_view(kind_id);
  return internal.ledger_record(p_client_mutation_id, 'entityKinds.create', result);
end
$$;

revoke all on function public.w2_create_entity_kind(uuid, text, text, jsonb, jsonb, uuid, text,
  text, text, text) from public;
grant execute on function public.w2_create_entity_kind(uuid, text, text, jsonb, jsonb, uuid, text,
  text, text, text) to tm8_app;

create or replace function public.w2_update_entity_kind(
  p_space_id uuid,
  p_kind text,
  p_patch jsonb,
  p_actor_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; actor uuid; current_row public.entity_kinds; new_schema jsonb; result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entityKinds.update');
  if replay is not null then
    perform internal.w2g12_authorize_replay('entityKinds.update', replay);
    return replay;
  end if;
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  -- 153: `label` and `labelPlural` join the patch key whitelist. `baseKind` does
  -- NOT. Re-basing a kind would change which detail table its EXISTING rows are
  -- supposed to have, and no amount of validation makes that a patch — it is a
  -- data migration wearing an update's clothes.
  if p_kind is null or p_kind !~ '^c:[a-z0-9][a-z0-9_]{0,48}$'
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or exists (
       select 1 from jsonb_object_keys(p_patch) patch_key
        where patch_key not in ('icon','fieldSchema','capabilities','allowTightening',
                                'label','labelPlural')
     ) then
    raise exception 'invalid custom entity-kind update' using errcode = '22023';
  end if;
  select * into current_row from public.entity_kinds
   where space_id = p_space_id and kind = p_kind and origin = 'custom' for update;
  if current_row.id is null then raise exception 'custom entity kind not found' using errcode = 'P0002'; end if;
  if p_patch ? 'icon' and jsonb_typeof(p_patch -> 'icon') not in ('string','null') then
    raise exception 'entity-kind icon must be a string or null' using errcode = '22023';
  end if;
  if p_patch ? 'label' and jsonb_typeof(p_patch -> 'label') not in ('string','null') then
    raise exception 'entity-kind label must be a string or null' using errcode = '22023';
  end if;
  if p_patch ? 'labelPlural' and jsonb_typeof(p_patch -> 'labelPlural') not in ('string','null') then
    raise exception 'entity-kind labelPlural must be a string or null' using errcode = '22023';
  end if;
  if p_patch ? 'allowTightening' and jsonb_typeof(p_patch -> 'allowTightening') <> 'boolean' then
    raise exception 'allowTightening must be boolean' using errcode = '22023';
  end if;
  new_schema := case when p_patch ? 'fieldSchema' then p_patch -> 'fieldSchema' else current_row.field_schema end;
  perform internal.w2g12_assert_field_schema(new_schema);
  perform internal.assert_base_kind(current_row.base_kind, new_schema);
  if p_patch ? 'capabilities' then perform internal.w2g12_assert_capabilities(p_patch -> 'capabilities'); end if;
  perform internal.assert_schema_evolution(
    current_row.field_schema,
    new_schema,
    coalesce((p_patch ->> 'allowTightening')::boolean, false)
  );
  if coalesce((p_patch ->> 'allowTightening')::boolean, false) then
    perform internal.w2g12_assert_fields_match_schema(custom_row.fields, new_schema)
      from public.custom_entities custom_row
      join public.entities entity_row on entity_row.id = custom_row.entity_id
     where entity_row.space_id = p_space_id and entity_row.kind = p_kind;
  end if;
  update public.entity_kinds
     set icon = case when p_patch ? 'icon' then p_patch ->> 'icon' else icon end,
         field_schema = new_schema,
         label = case when p_patch ? 'label' then p_patch ->> 'label' else label end,
         label_plural = case when p_patch ? 'labelPlural' then p_patch ->> 'labelPlural' else label_plural end,
         capabilities = case when p_patch ? 'capabilities' then p_patch -> 'capabilities' else capabilities end
   where id = current_row.id;
  result := internal.w2g12_entity_kind_view(current_row.id);
  return internal.ledger_record(p_client_mutation_id, 'entityKinds.update', result);
end
$$;

-- 5.5 `derive_task_for_entity`'s fast path (099's body, which supersedes 064's).
-- "A task is already its own anchor" is true of an epic too; without this an
-- epic launch would DERIVE a second task beside it.
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

  -- Fast path. A task is already its own anchor: return it and write NOTHING.
  -- 153: BASE kind, and the reported `sourceKind` is the row's own kind rather
  -- than the literal `task`, because "you launched an epic" is what happened.
  if internal.base_kind_of(source.kind, source.space_id) = 'task' then
    return jsonb_build_object(
      'taskId', p_entity_id, 'sourceEntityId', p_entity_id,
      'sourceKind', source.kind, 'created', false);
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
    -- candidate, never guess.
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
-- 6. THE MIGRATION. ONE TRANSACTION, NO INTERMEDIATE STATE.
--
-- ## Which values migrate
--
-- Sub-doc 4 says "each `type` value WITH A WORKFLOW becomes a `c:` kind". Taken
-- literally that loses data: a value carried by live tasks but with no
-- `task_workflows` row would vanish with the axis, and the tasks holding it
-- would silently become untyped. So the rule applied here is the union —
-- **a value migrates if it has a workflow OR if any task carries it** — which is
-- a superset of the ruled set and loses nothing. A value that is merely
-- DECLARED in `axis_values`, unused and unworkflowed, is dropped: it names no
-- row and configures no behaviour.
--
-- ## Naming
--
-- `epic` → `c:epic`, `Bug Fix` → `c:bug_fix`. On a collision with an existing
-- custom kind the slug takes a numeric suffix rather than merging into a kind
-- somebody else defined for another purpose.
--
-- ## The workflow the value carried
--
-- 149 copied every `task_workflows` row into `public.workflows` (space_id = the
-- space, kind = 'task', name = the type value). Those rows are the vocabularies
-- spaces actually authored, and they move onto the new kind: `workflow_id` on
-- the kind row, and `workflows.kind` re-pointed from 'task' to the new kind so
-- that "which workflows belong to this kind" keeps answering correctly.
--
-- ## The event trigger
--
-- `entities_capture_event` is DISABLED around the bulk writes — `ALTER TABLE …
-- DISABLE TRIGGER`, which is table-owner-safe and rolled back by migrate.mjs -1,
-- never `session_replication_role = replica`, which is superuser-only and
-- silences every trigger including the validators this migration is relying on
-- to prove the re-kind is legal.
-- -----------------------------------------------------------------------------
alter table public.entities disable trigger entities_capture_event;

do $migrate$
declare
  space_row record;
  value_row record;
  slug text;
  candidate text;
  suffix integer;
  new_kind text;
  wf_id uuid;
  kinds_created integer := 0;
  tasks_rekinded integer := 0;
  moved integer;
begin
  for space_row in select id from public.spaces loop
    for value_row in
      -- every type value that is USED or WORKFLOWED, and nothing else
      select v.value
        from (
          select distinct t.axes ->> 'type' as value
            from public.tasks t
            join public.entities e on e.id = t.entity_id
           where e.space_id = space_row.id
             and nullif(btrim(coalesce(t.axes ->> 'type', '')), '') is not null
          union
          select tw.type_value
            from public.task_workflows tw
           where tw.space_id = space_row.id
        ) v
       where nullif(btrim(coalesce(v.value, '')), '') is not null
       order by v.value
    loop
      slug := btrim(lower(regexp_replace(btrim(value_row.value), '[^a-zA-Z0-9]+', '_', 'g')), '_');
      slug := left(slug, 44);
      if slug !~ '^[a-z0-9][a-z0-9_]{0,48}$' then
        raise exception 'type value % does not yield a legal kind slug (got %)',
          value_row.value, slug using errcode = '22023';
      end if;
      candidate := slug;
      suffix := 1;
      while exists (select 1 from public.entity_kinds k
                     where k.space_id = space_row.id and k.kind = 'c:' || candidate) loop
        suffix := suffix + 1;
        candidate := left(slug, 42) || '_' || suffix::text;
      end loop;
      new_kind := 'c:' || candidate;

      -- The workflow the value carried, if it carried one. Matched through
      -- `task_workflows` as well as by name so that a workflow a space authored
      -- through the Phase 2 API and happened to name after a type value is not
      -- captured by accident.
      select w.id into wf_id
        from public.workflows w
        join public.task_workflows tw
          on tw.space_id = w.space_id and tw.type_value = w.name
       where w.space_id = space_row.id and w.kind = 'task' and w.name = value_row.value
       limit 1;

      insert into public.entity_kinds(kind, origin, space_id, base_kind, label, label_plural,
                                      field_schema, capabilities, workflow_id)
      values (new_kind, 'custom', space_row.id, 'task',
              initcap(replace(value_row.value, '_', ' ')),
              initcap(replace(value_row.value, '_', ' ')) || 's',
              '[]'::jsonb, '{}'::jsonb, wf_id);
      kinds_created := kinds_created + 1;

      if wf_id is not null then
        update public.workflows set kind = new_kind where id = wf_id;
      end if;

      update public.entities e
         set kind = new_kind
       where e.space_id = space_row.id
         and e.kind = 'task'
         and exists (select 1 from public.tasks t
                      where t.entity_id = e.id and t.axes ->> 'type' = value_row.value);
      get diagnostics moved = row_count;
      tasks_rekinded := tasks_rekinded + moved;
    end loop;
  end loop;

  -- The tag itself. Every task loses the `type` key, and the axis row goes with
  -- it — in that order, because `internal.validate_task_axes` refuses a task
  -- holding a key no axis declares, which would make the surviving rows
  -- un-patchable for the rest of their lives.
  update public.tasks set axes = axes - 'type' where axes ? 'type';
  delete from public.task_axes where name = 'type';

  raise notice '153: % kinds created, % tasks re-kinded', kinds_created, tasks_rekinded;
end
$migrate$;

-- ⚠ `SET CONSTRAINTS ALL IMMEDIATE` FIRST, and it is not decoration.
--
-- 149 armed two DEFERRED constraint triggers (the per-category coverage
-- assertions) and this file's re-kind touches rows they watch, so at this point
-- the transaction is holding pending trigger events — and `ALTER TABLE` refuses
-- with "cannot ALTER TABLE ... because it has pending trigger events". Firing
-- them here rather than at COMMIT also means a coverage violation surfaces AS
-- this migration, several statements from the write that caused it, instead of
-- as an unattributable failure at the end of the file.
--
-- Measured, not assumed: on an EMPTY database this line is unnecessary and the
-- file applied clean without it. It was the rehearsal against a copy of the live
-- graph that failed — the one case where the bulk writes above actually touch
-- rows.
set constraints all immediate;

alter table public.entities enable trigger entities_capture_event;

-- 6.1 New spaces stop being born with a `type` axis. 015's body verbatim, minus
-- the seed. (007:467 seeds it too and is superseded by this one; a superseded
-- definition is not a live door.)
create or replace function public.create_space(
  p_name text, p_description text default '', p_visibility text default 'private',
  p_github_repo text default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  space_id uuid := internal.new_id();
  member_id uuid := internal.new_id();
  channel_id uuid := internal.new_id();
  profile public.user_profiles;
  result jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.create');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();
  if coalesce(p_visibility, 'private') not in ('private','public') then
    raise exception 'invalid space visibility' using errcode = '22023';
  end if;

  select * into profile from public.user_profiles where identity_id = identity;
  if profile.identity_id is null then
    insert into public.user_profiles(identity_id) values (identity) returning * into profile;
  end if;
  insert into public.spaces(id, name, description, github_repo, visibility, created_by_identity)
  values (space_id, p_name, coalesce(p_description, ''), p_github_repo,
          coalesce(p_visibility, 'private'), identity);
  insert into public.entities(id, space_id, kind, created_by)
  values (member_id, space_id, 'member', member_id);
  insert into public.members(entity_id, space_id, identity_id, role, display_name)
  values (member_id, space_id, identity, 'owner', profile.display_name);
  insert into public.entities(id, space_id, kind, created_by)
  values (channel_id, space_id, 'channel', member_id);
  insert into public.channels(entity_id, space_id, name, topic)
  values (channel_id, space_id, 'general', 'General collaboration');

  perform internal.w1_set_writer('space_settings');
  update public.spaces set default_channel_id = channel_id where id = space_id;
  perform internal.w1_set_writer(null);
  insert into public.space_menu_configs(space_id, schema_version, revision, payload)
  values (space_id, 1, 1, internal.w1_default_menu_payload());
  -- 153: the `type` axis seed was here. A new space gets no taxonomy axis;
  -- taxonomy is KIND now, and `task_axes` survives for honest tags.
  perform internal.record_activity(space_id, member_id, member_id, 'joined',
            null, jsonb_build_object('role', 'owner'));

  result := jsonb_build_object(
    'space', (select to_jsonb(s) from public.spaces s where s.id = space_id),
    'memberId', member_id,
    'defaultChannelId', channel_id)
    || jsonb_build_object('patches', jsonb_build_array(internal.command_entity(channel_id),
                                                       internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.create', result);
end
$$;

-- 6.2 A `type` axis cannot come back. The values are kinds now; a space that
-- re-created the axis would restore the two-answers problem this file exists to
-- delete, and would do it without any of 132's machinery to make it mean
-- anything.
alter table public.task_axes
  add constraint task_axes_type_is_a_kind check (lower(btrim(name)) <> 'type');

comment on constraint task_axes_type_is_a_kind on public.task_axes is
  '153. `type` is not an axis — it is the kind. Axes remain for honest tags '
  '(team, quarter).';

-- -----------------------------------------------------------------------------
-- 7. `task_workflows` IS RETIRED, WHOLE.
--
-- 132 shipped a table, a trigger on `public.tasks`, two admin RPCs, a Settings
-- section, a CLI verb and a 371-line pg test to give a `type` VALUE a status
-- vocabulary. 149 copied the rows into `public.workflows`; 151 dropped its
-- structural constraint once the doors stopped writing literals; §6 moved the
-- copies onto the kinds. Nothing reads it. It goes.
--
-- The trigger goes FIRST: it validates `tasks.work_status` against a vocabulary
-- keyed on `axes ->> 'type'`, which §6 has just deleted, so from here it can
-- only ever be a no-op that costs a lookup per write.
-- -----------------------------------------------------------------------------
drop trigger if exists tasks_validate_workflow on public.tasks;
drop function if exists internal.validate_task_workflow();
drop function if exists public.upsert_task_workflow(uuid, text, text[], text);
drop function if exists public.delete_task_workflow(uuid, uuid, text);
drop table if exists public.task_workflows;

-- -----------------------------------------------------------------------------
-- 8. VERIFY.
--
-- The division of labour 152 stated holds here: a migration cannot manufacture
-- rows to test itself against, so this block guards a POPULATED node (the shapes
-- and the counts that must agree with each other whatever the data was) and
-- `packages/server/test/db/kind-absorbs-the-type-axis.pg.test.ts` guards a fresh
-- one (the behaviours: an epic parents a story, is assignable, spawnable and
-- completable, and the type axis cannot be recreated).
-- -----------------------------------------------------------------------------
do $verify$
declare
  bad integer;
  n integer;
begin
  -- the columns exist and are nullable
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'entity_kinds'
     and column_name in ('base_kind','label','label_plural') and is_nullable = 'YES';
  if n <> 3 then
    raise exception '153 verify: expected 3 nullable new entity_kinds columns, found %', n;
  end if;

  -- task_workflows and its trigger are gone
  if to_regclass('public.task_workflows') is not null then
    raise exception '153 verify: public.task_workflows still exists';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'tasks_validate_workflow' and not tgisinternal) then
    raise exception '153 verify: tasks_validate_workflow still exists';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public' and p.proname in ('upsert_task_workflow','delete_task_workflow')) then
    raise exception '153 verify: a task_workflow RPC survived';
  end if;

  -- no `type` axis anywhere, and no task still carrying the tag
  select count(*) into bad from public.task_axes where lower(btrim(name)) = 'type';
  if bad > 0 then raise exception '153 verify: % type axis rows survived', bad; end if;
  select count(*) into bad from public.tasks where axes ? 'type';
  if bad > 0 then raise exception '153 verify: % tasks still carry axes.type', bad; end if;

  -- every kind this file created is well-formed: custom, task-based, labelled,
  -- and every entity wearing it has the task detail row that claim implies
  select count(*) into bad from public.entity_kinds k
   where k.base_kind is not null
     and (k.origin <> 'custom' or k.base_kind <> 'task' or k.label is null or k.label_plural is null);
  if bad > 0 then raise exception '153 verify: % malformed base_kind rows', bad; end if;

  select count(*) into bad
    from public.entities e
    join public.entity_kinds k on k.kind = e.kind and k.space_id = e.space_id
   where k.base_kind = 'task'
     and not exists (select 1 from public.tasks t where t.entity_id = e.id);
  if bad > 0 then
    raise exception '153 verify: % entities of a task-based kind have no tasks row', bad;
  end if;

  -- and every one of them still has a status in its kind's workflow — the
  -- property §6 relies on when it re-points `workflows.kind` instead of
  -- re-resolving every row.
  select count(*) into bad
    from public.entities e
    join public.entity_kinds k on k.kind = e.kind and k.space_id = e.space_id
    left join public.workflow_states s on s.id = e.status_id
   where k.base_kind = 'task'
     and (e.status_id is null
          or s.workflow_id is distinct from internal.workflow_for_entity(e.space_id, e.kind));
  if bad > 0 then
    raise exception '153 verify: % migrated entities hold a status outside their kind''s workflow', bad;
  end if;

  raise notice '153 verify: ok';
end
$verify$;

reset role;
