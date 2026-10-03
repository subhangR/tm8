-- =============================================================================
-- 291 — a status transition
-- records only the status. Task 01a0fe67, issue #32.
--
-- THE DEFECT. `set_work_state` upserted `working_on <actor> -> task` for every
-- target except open/cancelled. So `tm8 task transition <id> in_review` run by
-- an AUDITOR (or a UI status dropdown, or a coordinator moving a worker's task
-- to blocked) wrote the caller into the graph as the task's worker, and the
-- story trail then showed them as working on it. Moving a status and claiming
-- the work are different questions; one verb answered both.
--
-- THE FIX. An eighth argument, `p_claim`, default FALSE:
--
--   p_claim = true   the old behaviour, unchanged: the caller's working_on edge
--                    is upserted (or dropped on open/cancelled). Reached by
--                    `tm8 task transition --claim` / `{ claim: true }`.
--   p_claim = false  `tasks.work_status` and the work.changed activity row,
--                    nothing else. NO edge is created. If the caller ALREADY
--                    holds a working_on edge on this task, it follows the
--                    transition (status prop updated, or dropped on
--                    open/cancelled) — that is the caller's own existing claim
--                    staying truthful, not a new claim. Every other actor's edge
--                    is left alone.
--
-- `note` and `startedAt` live on the edge. Without a claim and without an
-- existing edge there is nowhere to keep them, so they are refused rather than
-- silently dropped (22023, reason claim_required).
--
-- The command result's `edge` is the caller's edge when one was written, else
-- null — the same shape as an open/cancelled transition always had.
--
-- Signature change => DROP + CREATE, and DROP discards the ACL, so the grant
-- from 037 is restored exactly (tm8_app EXECUTE, nothing for PUBLIC).
--
-- STRAY EDGES (acceptance ac2). The edges this defect already wrote cannot be
-- told apart from real claims in SQL (both are actor-sourced working_on rows
-- with the same props), so no blanket delete here. They are removed with
-- `tm8 edge delete <edge-id>`; the three named in #32 were removed that way.
-- =============================================================================

set role tm8_graph_owner;

drop function if exists public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean);

create or replace function public.set_work_state(
  p_task_id uuid,
  p_status text,
  p_actor_id uuid default null,
  p_started_at timestamptz default null,
  p_note text default null,
  p_client_mutation_id text default null,
  p_clear_note boolean default false,
  p_claim boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  edge_id uuid;
  holds_edge boolean;
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

  -- 291: without a claim, only an edge the caller already holds is touched.
  holds_edge := coalesce(p_claim, false) or exists (
    select 1 from public.edges
     where src_id = actor and dst_id = p_task_id and type = 'working_on');

  if not holds_edge and (p_note is not null or p_started_at is not null) then
    raise exception 'note and startedAt are recorded on the working_on edge; pass claim to record them'
      using errcode = '22023', detail = '{"reason":"claim_required"}';
  end if;

  if not holds_edge then
    null;
  elsif p_status in ('open','cancelled') then
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
      -- 037's merge: `note` falls back to the stored value; an explicit
      -- p_clear_note wins over both. `edges.props` is the PRE-UPDATE row.
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

revoke all on function public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean, boolean) from public;
grant execute on function public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean, boolean) to tm8_app;

comment on function public.set_work_state(uuid, text, uuid, timestamptz, text, text, boolean, boolean) is
  'Task work-state transition. Writes the status; records the caller as working_on '
  'only when p_claim is true (291). An edge the caller already holds follows the transition.';

reset role;
