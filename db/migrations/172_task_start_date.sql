-- 172 — START DATE on a task, cut along the groove `due_date` already made.
--
-- A task has had an END date since 001 (`due_date`). It has never had a BEGIN
-- date, so "when does this start" and "when is it late" were the same question,
-- and scheduling could only ever be expressed as a deadline.
--
-- WHY THIS FILE MIRRORS `due_date` INSTEAD OF INVENTING A SHAPE. `due_date` is
-- already plumbed end to end — column → RPC → projector → entity-read → contract
-- → UI — and every one of those hops has a decided posture (explicit-null means
-- CLEAR, NULLs sort last, `date` not `timestamptz`). A second date field that
-- disagreed with the first on any of those would make the two impossible to read
-- together. So `start_date` is `due_date` with a different name, deliberately,
-- down to the `p_clear_*` flag.
--
-- NULLABLE, NEVER DEFAULTED — 107's rule, and 171 restates it. NULL means no
-- start date was ever set. It must render as NO CLAIM. There is no backfill in
-- this file and there must not be one in a later file: inventing a start date
-- for ~300 live tasks nobody scheduled would be fabricating data, not migrating
-- it. "Every task has a start date" means the FIELD exists on every task.
--
-- NO ORDERING CONSTRAINT between `start_date` and `due_date`, on purpose. A
-- start after a due date is a planning mistake a person should SEE, not a write
-- the database refuses — and a check constraint here would reject the ordinary
-- edit sequence (set start, then move due) halfway through.

set role tm8_graph_owner;

alter table public.tasks add column if not exists start_date date;

-- Mirrors `tasks_due_date_idx` (001:531): partial, because the overwhelming
-- majority of rows are NULL and an index over them buys nothing.
create index if not exists tasks_start_date_idx
  on public.tasks(start_date) where start_date is not null;

-- =============================================================================
-- WHY BOTH RPCs ARE DROPPED AND NOT `create or replace`d.
--
-- `create or replace function` matches on name AND argument types. Adding a
-- parameter does not replace anything — it creates a SECOND, OVERLOADED
-- function, and because every added parameter here has a default, an existing
-- 14-argument call then matches BOTH candidates and fails with "function
-- create_task(...) is not unique". The old signature has to go.
--
-- ⚠ AND THE DROP IS WHY THE GRANTS BELOW ARE NOT OPTIONAL. This is 171's
-- warning and 162's defect, re-armed the same way:
--
--   * 008's `grant execute on all functions in schema public to tm8_app` RAN
--     ONCE, at 008. It is not a default privilege. `create or replace` carried
--     that ACL forward across 036/038/150 because REPLACE preserves grants.
--     A DROP does not. The functions below are NEW objects with NO grant, so
--     without the `grant` every caller gets a bare permission denied on the
--     first real create — a failure no static check can see, because the SQL
--     is valid and the migration applies clean.
--   * Postgres gives a new function EXECUTE TO PUBLIC by default, so granting
--     `tm8_app` without REVOKING PUBLIC first would leave these two write doors
--     callable by every role that can connect — including
--     `tm8_delivery_worker`, which exists precisely to hold three RPCs and
--     nothing else. The revoke is the security half; the grant is the
--     functioning half. Neither alone is correct.
--
-- `set role tm8_graph_owner` above is the third leg: 036 and 038 both created
-- these functions under that role, so they are owned by it. Dropping and
-- recreating as the applier would silently move ownership, and the
-- revoke/grant pair would fail with "must be owner of function" — which is
-- exactly how 150 first failed on `execution_spawn` (150:700).
-- =============================================================================

drop function if exists public.create_task(
  uuid, text, uuid, text, jsonb, uuid, double precision, text, jsonb, integer,
  date, uuid, text, text);

-- 150's body verbatim except the marked `start_date` additions. Reproduced in
-- full rather than patched, because a dropped function has no body to patch.
create or replace function public.create_task(
  p_space_id uuid, p_title text, p_actor_id uuid default null, p_description text default '',
  p_axes jsonb default '{}'::jsonb, p_parent_id uuid default null,
  p_position double precision default null, p_priority text default 'medium',
  p_acceptance_criteria jsonb default '[]'::jsonb, p_points_estimate integer default null,
  p_due_date date default null,
  p_start_date date default null,                            -- 172
  p_attach_to uuid default null,
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
                           acceptance_criteria, points_estimate, due_date, start_date)
  values (task_id, p_title, coalesce(p_description, ''), coalesce(p_axes, '{}'::jsonb),
          coalesce(p_priority, 'medium'), coalesce(p_acceptance_criteria, '[]'::jsonb),
          p_points_estimate, p_due_date, p_start_date);
  perform internal.record_initial_version(task_id, actor);
  perform internal.attach_on_create(p_space_id, task_id, actor, p_attach_to, p_attach_edge_type);
  activity_id := internal.record_activity(p_space_id, task_id, actor, 'created',
                   null, jsonb_build_object('kind', 'task'));

  result := internal.command_result(task_id, null, activity_id, array[task_id]);
  return internal.ledger_record(p_client_mutation_id, 'entities.create', result);
end
$$;

drop function if exists public.update_task_content(
  uuid, integer, uuid, text, text, jsonb, text, text, jsonb, integer, date,
  boolean, text);

-- 038's body verbatim except the marked `start_date` additions.
--
-- THE `p_clear_start_date` FLAG IS NOT REDUNDANT, for the same reason
-- `p_clear_due_date` is not (handlers/entities.ts:683). `coalesce(p_start_date,
-- start_date)` cannot distinguish "the caller did not mention start_date" from
-- "the caller explicitly sent null to CLEAR it" — both arrive as NULL. Without
-- the flag a start date could be set but never unset.
create or replace function public.update_task_content(
  p_task_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_description text default null, p_axes jsonb default null,
  p_work_status text default null, p_priority text default null,
  p_acceptance_criteria jsonb default null, p_points_estimate integer default null,
  p_due_date date default null, p_clear_due_date boolean default false,
  p_start_date date default null, p_clear_start_date boolean default false,   -- 172
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_task_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_task_id, p_expected_version);
  if p_work_status = 'done' then
    raise exception 'completion goes through complete_task' using errcode = '23514';
  end if;

  update public.tasks
     set title = coalesce(p_title, title),
         description = coalesce(p_description, description),
         axes = coalesce(p_axes, axes),
         work_status = coalesce(p_work_status, work_status),
         priority = coalesce(p_priority, priority),
         acceptance_criteria = coalesce(p_acceptance_criteria, acceptance_criteria),
         points_estimate = coalesce(p_points_estimate, points_estimate),
         due_date = case when p_clear_due_date then null else coalesce(p_due_date, due_date) end,
         start_date = case when p_clear_start_date then null                       -- 172
                           else coalesce(p_start_date, start_date) end,
         updated_at = now()
   where entity_id = p_task_id;
  activity_id := internal.record_activity(e.space_id, p_task_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'task'));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_task_id, null, activity_id, array[p_task_id]));
end
$$;

-- See the block above: a DROP loses the ACL, and a new function is PUBLIC by
-- default. Both halves, for both functions.
revoke all on function public.create_task(
  uuid, text, uuid, text, jsonb, uuid, double precision, text, jsonb, integer,
  date, date, uuid, text, text) from public;
revoke all on function public.update_task_content(
  uuid, integer, uuid, text, text, jsonb, text, text, jsonb, integer, date,
  boolean, date, boolean, text) from public;

grant execute on function public.create_task(
  uuid, text, uuid, text, jsonb, uuid, double precision, text, jsonb, integer,
  date, date, uuid, text, text) to tm8_app;
grant execute on function public.update_task_content(
  uuid, integer, uuid, text, text, jsonb, text, text, jsonb, integer, date,
  boolean, date, boolean, text) to tm8_app;

reset role;
