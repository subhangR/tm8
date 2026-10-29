-- =============================================================================
-- 384 — loops become first-class (design of record 01a182d4, §2; task 01a182d5).
--
-- Predecessor: the highest on main at open, 377_mcp_refresh_failures_and_revoke_all.sql;
-- 378 belongs to PR #1389 (coordinator arbitration, 2026-10-28).
--
-- KEPT AT 384 BELOW MAIN'S TOP AT MERGE (387-390): a deliberate exception to the
-- PR-cleanup ordinal rule (Loops lead ruling, 2026-10-29). An upgraded database
-- applies this file after 390 and a fresh one applies it before 387; both end in
-- the same schema. Checked: 384 creates, replaces or drops no object that 387
-- (claim_text, header_text, rename_work_session), 388 (snapshot_entity_version,
-- start_tool_session, tools_snapshot) or 389 (Tools PR-C: start_tool_session,
-- issue_tool_session_loop_session) touches, and none of 387-390 adds or drops
-- a column. Of the helpers 384's bodies call, only internal.claim_text is
-- replaced (387), and they call whichever body is live. The one object 384
-- shares with 390 (Tools PR-E) is internal.header_kind_allowed, whose body there
-- is §6's list verbatim, so either order leaves the same function. §1 and §2
-- disable loops_w2_snapshot_version around their backfills, so whichever
-- snapshot_entity_version is live never sees them.
--
-- §1 adds the definition and policy columns of §2.1 with the action backfill;
-- §2 extends 343's armer trigger with `armed_at` and the widened bookkeeping
-- list; §3 replaces create_loop/update_loop (091) with signatures carrying
-- every new field (new parameters trail the old ones, so positional callers
-- written against 091 keep resolving); §4 adds the `loop_runs` projection of
-- §2.2 and its settle door (PR2's claim door writes the rows); §5 teaches 375's
-- due read about pauses; §6 lets loops carry selection headers.
--
-- Scheduling stays server-owned: the doors store the `next_run_at` they are
-- handed and never compute one. The TypeScript handlers own the grammar
-- (packages/server/src/scheduler/schedule.ts).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Columns (§2.1). Anything the executor branches on is a column; what is
--     passed through to execution.spawn stays in `config`.
-- -----------------------------------------------------------------------------
alter table public.loops
  add column action text not null default 'spawn'
    check (action in ('spawn', 'dispatch', 'tool')),
  add column tool_id uuid references public.entities(id) on delete set null,
  add column tool_inputs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(tool_inputs) = 'object'),
  add column timezone text not null default 'UTC'
    check (length(btrim(timezone)) between 1 and 64),
  add column paused_until timestamptz,
  add column armed_at timestamptz,
  add column concurrency text not null default 'skip'
    check (concurrency in ('skip', 'queue')),
  add column max_runtime_seconds integer
    check (max_runtime_seconds between 60 and 86400),
  add column retry_attempts smallint not null default 0
    check (retry_attempts between 0 and 5),
  add column retry_delay_seconds integer not null default 300
    check (retry_delay_seconds between 30 and 3600),
  add column retry_attempt smallint not null default 0
    check (retry_attempt >= 0);

comment on column public.loops.action is
  '384: what a firing does. spawn requires team_member_id; tool requires tool_id '
  '(team_member_id is then the runs-as persona); dispatch needs neither.';
comment on column public.loops.timezone is
  '384: the IANA zone the cron half of the schedule is evaluated in. Membership '
  'in the IANA set is checked by the server before the door.';
comment on column public.loops.armed_at is
  '384: when armed_by_* was last stamped; set and cleared by the same trigger.';

-- Backfill (§2.1): a loop that names no runner has always meant "route through
-- the dispatcher" (091). The update is bookkeeping a migration owes the rows,
-- not a human or agent edit: with the triggers on, 343's stamp would read it as
-- a non-human content change and NULL every armer, and the version snapshot
-- would bump every loop. Table-owner `disable trigger` (the 174 pattern),
-- rolled back with the migration if anything below fails.
alter table public.loops disable trigger loops_stamp_armed_by;
alter table public.loops disable trigger loops_touch_updated_at;
alter table public.loops disable trigger loops_w2_snapshot_version;
update public.loops set action = 'dispatch' where team_member_id is null;
alter table public.loops enable trigger loops_w2_snapshot_version;
alter table public.loops enable trigger loops_touch_updated_at;
alter table public.loops enable trigger loops_stamp_armed_by;

-- -----------------------------------------------------------------------------
-- §2. The armer (343) gains `armed_at`; bookkeeping is widened.
--
--     Same inversion as 343 (B28): bookkeeping is SUBTRACTED, so a column added
--     later is content until it is listed here. New bookkeeping: `armed_at`
--     (written by this trigger), `paused_until` (a pause or resume never
--     re-authorises content), `retry_attempt` (the executor's counter). The new
--     content columns (action, tool_id, tool_inputs, timezone, concurrency,
--     max_runtime_seconds, retry_*) re-stamp or clear like any other edit.
-- -----------------------------------------------------------------------------
create or replace function internal.stamp_loop_armed_by() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_space uuid; v_member uuid; v_human boolean; v_content_changed boolean;
begin
  v_human := coalesce(internal.claim_text('tm8.auth_kind'), '') in ('browser', 'cli')
             and coalesce(internal.claim_text('tm8.via_link'), '') = '';

  if tg_op = 'INSERT' then
    if not v_human then
      new.armed_at := null;
      return new;
    end if;
  else
    v_content_changed :=
         (to_jsonb(new) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'paused_until' - 'retry_attempt' - 'armed_at'
            - 'armed_by_member_id' - 'armed_by_identity_id')
      is distinct from
         (to_jsonb(old) - 'next_run_at' - 'last_run_at' - 'last_error' - 'updated_at'
            - 'enabled' - 'paused_until' - 'retry_attempt' - 'armed_at'
            - 'armed_by_member_id' - 'armed_by_identity_id')
      or (new.enabled and not old.enabled);
    if not v_content_changed then
      new.armed_by_member_id := old.armed_by_member_id;
      new.armed_by_identity_id := old.armed_by_identity_id;
      new.armed_at := old.armed_at;
      return new;
    end if;
    if not v_human then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
      new.armed_at := null;
      return new;
    end if;
  end if;

  select space_id into v_space from public.entities where id = new.entity_id;
  if v_space is null then return new; end if;
  v_member := internal.current_member_id(v_space);
  if v_member is null then
    if tg_op <> 'INSERT' then
      new.armed_by_member_id := null;
      new.armed_by_identity_id := null;
    end if;
    new.armed_at := null;
    return new;
  end if;
  new.armed_by_member_id := v_member;
  new.armed_by_identity_id := internal.identity_id();
  new.armed_at := now();
  return new;
end
$$;
revoke all on function internal.stamp_loop_armed_by() from public;

-- Loops armed before 384 have no recorded instant; their last update is the
-- closest truth there is.
alter table public.loops disable trigger loops_stamp_armed_by;
alter table public.loops disable trigger loops_touch_updated_at;
alter table public.loops disable trigger loops_w2_snapshot_version;
update public.loops set armed_at = updated_at where armed_by_member_id is not null;
alter table public.loops enable trigger loops_w2_snapshot_version;
alter table public.loops enable trigger loops_touch_updated_at;
alter table public.loops enable trigger loops_stamp_armed_by;

-- -----------------------------------------------------------------------------
-- §3. The doors. The old arities are dropped so exactly one of each exists.
-- -----------------------------------------------------------------------------

-- The runner invariants, checked against the row a door is about to leave.
create or replace function internal.assert_loop_runner(
  p_space_id uuid, p_action text, p_team_member_id uuid, p_tool_id uuid, p_timezone text
) returns void language plpgsql stable set search_path = public, internal, pg_temp as $$
begin
  if p_action is null or p_action not in ('spawn', 'dispatch', 'tool') then
    raise exception 'loop action must be spawn, dispatch or tool' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_timezone, ''))) not between 1 and 64 then
    raise exception 'loop timezone is required' using errcode = '22023';
  end if;
  if p_action = 'spawn' and p_team_member_id is null then
    raise exception 'a spawn loop requires team_member_id' using errcode = '22023';
  end if;
  -- The executors choose spawn or dispatch from the runner (091), so a runner
  -- on a dispatch loop would make it fire as a spawn of that runner.
  if p_action = 'dispatch' and p_team_member_id is not null then
    raise exception 'a dispatch loop names no runner (team_member_id must be null)' using errcode = '22023';
  end if;
  if p_action = 'tool' then
    if p_tool_id is null then
      raise exception 'a tool loop requires tool_id' using errcode = '22023';
    end if;
    perform 1 from public.entities t
      where t.id = p_tool_id and t.space_id = p_space_id
        and t.kind = 'tool' and t.deleted_at is null;
    if not found then
      raise exception 'loop tool_id must name a live tool in this space' using errcode = '23503';
    end if;
  elsif p_tool_id is not null then
    raise exception 'tool_id is only meaningful for a tool loop' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.assert_loop_runner(uuid, text, uuid, uuid, text) from public;

drop function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text);

create function public.create_loop(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_schedule text default null, p_team_member_id uuid default null,
  p_subject_id uuid default null, p_prompt text default '',
  p_config jsonb default '{}'::jsonb, p_enabled boolean default true,
  p_next_run_at timestamptz default null,
  p_parent_id uuid default null, p_position double precision default null,
  p_client_mutation_id text default null,
  -- 384
  p_action text default null, p_tool_id uuid default null,
  p_tool_inputs jsonb default '{}'::jsonb, p_timezone text default 'UTC',
  p_concurrency text default 'skip', p_max_runtime_seconds integer default null,
  p_retry_attempts integer default 0, p_retry_delay_seconds integer default 300,
  -- The server's reason when it could compute no next run (§3.3: parked, never
  -- silently never-due). Like p_next_run_at, stored as handed, never computed.
  p_last_error text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  loop_id uuid;
  activity_id uuid;
  v_action text;
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

  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then
    raise exception 'loop title is required (1..200 chars after trim)' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_schedule, ''))) not between 1 and 200 then
    raise exception 'loop schedule is required (1..200 chars after trim)' using errcode = '22023';
  end if;

  -- Same-space containment (091): without it a loop could fire across the
  -- boundary every period under the loop creator's authority.
  if p_team_member_id is not null then
    perform 1 from public.entities e
      where e.id = p_team_member_id and e.space_id = p_space_id
        and e.kind = 'team_member' and e.deleted_at is null;
    if not found then
      raise exception 'loop team_member_id must name a live team_member in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.entities e
      where e.id = p_subject_id and e.space_id = p_space_id and e.deleted_at is null;
    if not found then
      raise exception 'loop subject_id must name a live entity in this space'
        using errcode = '23503';
    end if;
  end if;

  -- A caller written against 091 names no action: the old meaning holds.
  v_action := coalesce(p_action, case when p_team_member_id is null then 'dispatch' else 'spawn' end);
  perform internal.assert_loop_runner(p_space_id, v_action, p_team_member_id, p_tool_id, p_timezone);

  loop_id := internal.create_envelope(p_space_id, 'loop', actor, p_parent_id, p_position);
  insert into public.loops(entity_id, title, schedule, team_member_id, subject_id, prompt,
                           config, enabled, next_run_at, action, tool_id, tool_inputs,
                           timezone, concurrency, max_runtime_seconds, retry_attempts,
                           retry_delay_seconds, last_error)
  values (loop_id, btrim(p_title), btrim(p_schedule), p_team_member_id, p_subject_id,
          coalesce(p_prompt, ''), coalesce(p_config, '{}'::jsonb),
          coalesce(p_enabled, true), p_next_run_at, v_action, p_tool_id,
          coalesce(p_tool_inputs, '{}'::jsonb), btrim(coalesce(p_timezone, 'UTC')),
          coalesce(p_concurrency, 'skip'), p_max_runtime_seconds,
          coalesce(p_retry_attempts, 0), coalesce(p_retry_delay_seconds, 300), p_last_error);
  perform internal.record_initial_version(loop_id, actor);

  activity_id := internal.record_activity(p_space_id, loop_id, actor, 'created',
                   null, jsonb_build_object('kind', 'loop'));
  return internal.ledger_record(p_client_mutation_id, 'entities.create',
           internal.command_result(loop_id, null, activity_id, array[loop_id]));
end
$$;

drop function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text);

/*
 * `p_next_run_at` stays writable here because the executor advances it through
 * this same door (091). `p_expected_version` NULL skips the version assertion:
 * that is the executor's bookkeeping path, whose write must not be refused by a
 * human's concurrent edit (design §3.3). Every human or agent edit passes one.
 */
create function public.update_loop(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_schedule text default null,
  p_team_member_id uuid default null, p_clear_team_member boolean default false,
  p_subject_id uuid default null, p_clear_subject boolean default false,
  p_prompt text default null, p_config jsonb default null,
  p_enabled boolean default null,
  p_next_run_at timestamptz default null, p_clear_next_run_at boolean default false,
  p_last_run_at timestamptz default null,
  p_last_error text default null, p_clear_last_error boolean default false,
  p_client_mutation_id text default null,
  -- 384
  p_action text default null, p_tool_id uuid default null, p_clear_tool boolean default false,
  p_tool_inputs jsonb default null, p_timezone text default null,
  p_paused_until timestamptz default null, p_clear_paused_until boolean default false,
  p_concurrency text default null,
  p_max_runtime_seconds integer default null, p_clear_max_runtime boolean default false,
  p_retry_attempts integer default null, p_retry_delay_seconds integer default null,
  p_retry_attempt integer default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  l public.loops;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'loop');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_expected_version is not null then
    perform internal.assert_version(p_entity_id, p_expected_version);
  end if;

  if p_schedule is not null and length(btrim(p_schedule)) not between 1 and 200 then
    raise exception 'loop schedule must be 1..200 chars after trim' using errcode = '22023';
  end if;
  if p_team_member_id is not null then
    perform 1 from public.entities tm
      where tm.id = p_team_member_id and tm.space_id = e.space_id
        and tm.kind = 'team_member' and tm.deleted_at is null;
    if not found then
      raise exception 'loop team_member_id must name a live team_member in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.entities s
      where s.id = p_subject_id and s.space_id = e.space_id and s.deleted_at is null;
    if not found then
      raise exception 'loop subject_id must name a live entity in this space'
        using errcode = '23503';
    end if;
  end if;
  if p_title is not null and length(btrim(p_title)) not between 1 and 200 then
    raise exception 'loop title must be 1..200 chars after trim' using errcode = '22023';
  end if;

  update public.loops
     set title          = coalesce(btrim(p_title), title),
         schedule       = coalesce(btrim(p_schedule), schedule),
         team_member_id = case when p_clear_team_member then null
                               else coalesce(p_team_member_id, team_member_id) end,
         subject_id     = case when p_clear_subject then null
                               else coalesce(p_subject_id, subject_id) end,
         prompt         = coalesce(p_prompt, prompt),
         config         = coalesce(p_config, config),
         enabled        = coalesce(p_enabled, enabled),
         next_run_at    = case when p_clear_next_run_at then null
                               else coalesce(p_next_run_at, next_run_at) end,
         last_run_at    = coalesce(p_last_run_at, last_run_at),
         last_error     = case when p_clear_last_error then null
                                else coalesce(p_last_error, last_error) end,
         action         = coalesce(p_action, action),
         tool_id        = case when p_clear_tool then null
                               else coalesce(p_tool_id, tool_id) end,
         tool_inputs    = coalesce(p_tool_inputs, tool_inputs),
         timezone       = coalesce(btrim(p_timezone), timezone),
         paused_until   = case when p_clear_paused_until then null
                               else coalesce(p_paused_until, paused_until) end,
         concurrency    = coalesce(p_concurrency, concurrency),
         max_runtime_seconds = case when p_clear_max_runtime then null
                               else coalesce(p_max_runtime_seconds, max_runtime_seconds) end,
         retry_attempts = coalesce(p_retry_attempts, retry_attempts),
         retry_delay_seconds = coalesce(p_retry_delay_seconds, retry_delay_seconds),
         retry_attempt  = coalesce(p_retry_attempt, retry_attempt),
         updated_at     = now()
   where entity_id = p_entity_id
   returning * into l;

  -- Judged on the row the edit leaves, so a patch cannot strand a spawn loop
  -- without its runner by clearing one field at a time; and only when the patch
  -- touches the runner. Bookkeeping, enable/disable, pause and renames must
  -- never re-judge it: a tool deleted since the loop was configured would make
  -- every one of them fail, and the executor's write that advances next_run_at
  -- with them (the loop would be re-selected every tick, holding a slot).
  if p_action is not null or p_team_member_id is not null or p_clear_team_member
     or p_tool_id is not null or p_clear_tool then
    perform internal.assert_loop_runner(e.space_id, l.action, l.team_member_id, l.tool_id, l.timezone);
  end if;

  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'loop')), array[p_entity_id]));
end
$$;

revoke all on function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text,text,uuid,jsonb,text,text,integer,integer,integer,text) from public;
grant execute on function public.create_loop(uuid,text,uuid,text,uuid,uuid,text,jsonb,boolean,timestamptz,uuid,double precision,text,text,uuid,jsonb,text,text,integer,integer,integer,text) to tm8_app;
revoke all on function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text,text,uuid,boolean,jsonb,text,timestamptz,boolean,text,integer,boolean,integer,integer,integer) from public;
grant execute on function public.update_loop(uuid,integer,uuid,text,text,uuid,boolean,uuid,boolean,text,jsonb,boolean,timestamptz,boolean,timestamptz,text,boolean,text,text,uuid,boolean,jsonb,text,timestamptz,boolean,text,integer,boolean,integer,integer,integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- §4. `loop_runs` (§2.2): the outcome the `triggered_by` edges cannot carry.
--     Not an entity kind. Status is derived at read time, never stored twice.
-- -----------------------------------------------------------------------------
create table public.loop_runs (
  id                   uuid primary key default gen_random_uuid(),
  loop_id              uuid not null references public.loops(entity_id) on delete cascade,
  space_id             uuid not null,
  fired_at             timestamptz not null,
  trigger              text not null check (trigger in ('schedule', 'manual')),
  requested_by         uuid,
  action               text not null check (action in ('spawn', 'dispatch', 'tool')),
  attempt              smallint not null default 1 check (attempt >= 1),
  acted_as_identity_id text,
  launch               text not null check (launch in ('fired', 'skipped', 'failed')),
  skip_reason          text check (skip_reason in ('overlap', 'paused', 'schedule_invalid')),
  error                text,
  task_id              uuid references public.entities(id) on delete set null,
  session_id           uuid references public.entities(id) on delete set null,
  outcome              text check (outcome in ('completed', 'failed', 'stopped', 'timed_out')),
  ended_at             timestamptz,
  created_at           timestamptz not null default now(),
  check ((launch = 'skipped') = (skip_reason is not null))
);

create index loop_runs_loop_fired_idx on public.loop_runs (loop_id, fired_at desc);
-- The max-runtime sweep (PR2) reads open fired runs by session.
create index loop_runs_open_session_idx on public.loop_runs (session_id)
  where outcome is null and launch = 'fired';

alter table public.loop_runs enable row level security;
-- Readable exactly when the loop is: entities' own RLS decides, in the 218 shape
-- (no per-row membership helper).
create policy loop_runs_select on public.loop_runs for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity where readable_entity.id = loop_runs.loop_id and readable_entity.deleted_at is null offset 0)));
grant select on public.loop_runs to tm8_app;

-- Rows are written by PR2's claim door (one transaction with the claim), never
-- by a free-standing insert door: a member could forge run history with one.
-- The one door here settles a run's outcome, keyed on the run id, never the
-- entity version.
-- Settles once: a second settle of the same run is a no-op that reports the
-- outcome already recorded, so the stop handler and the executor cannot race
-- one outcome over another.
create or replace function public.loop_run_settle(
  p_run_id uuid, p_outcome text, p_error text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare r public.loop_runs;
begin
  -- A null outcome would stamp ended_at and leave the run open to a second settle.
  if p_outcome is null then
    raise exception 'a loop run settles with an outcome' using errcode = '22023';
  end if;
  select * into r from public.loop_runs where id = p_run_id for update;
  if r.id is null then
    raise exception 'loop run % not found', p_run_id using errcode = 'P0002';
  end if;
  if not internal.is_loops_worker() then
    perform internal.require_space_member(r.space_id);
  end if;
  if r.outcome is null then
    update public.loop_runs
       set outcome = p_outcome, ended_at = now(), error = coalesce(p_error, error)
     where id = p_run_id
     returning * into r;
  end if;
  return jsonb_build_object('runId', r.id, 'outcome', r.outcome, 'endedAt', r.ended_at);
end
$$;

revoke all on function public.loop_run_settle(uuid,text,text) from public;
grant execute on function public.loop_run_settle(uuid,text,text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §5. 375's due read skips a loop paused into the future (§3.2) and returns
--     `timezone` and `action` after 375's columns: the executor advances a cron
--     loop in its own zone (§3.1), and a tool loop is not fired as a spawn or a
--     dispatch before the tool action exists (loops PR3). A new return shape
--     needs a drop; PR2's claim door supersedes this read for the job.
-- -----------------------------------------------------------------------------
drop function public.loops_due_for_executor(integer);

create function public.loops_due_for_executor(p_limit integer default 25)
returns table (
  entity_id        uuid,
  space_id         uuid,
  title            text,
  schedule         text,
  team_member_id   uuid,
  subject_id       uuid,
  prompt           text,
  config           jsonb,
  version          integer,
  act_as_identity  text,
  timezone         text,
  action           text
)
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select l.entity_id,
         e.space_id,
         l.title,
         l.schedule,
         l.team_member_id,
         l.subject_id,
         l.prompt,
         l.config,
         e.version,
         coalesce(
           (select m.identity_id
              from public.members m
             where m.identity_id = l.armed_by_identity_id
               and m.space_id = e.space_id
               and m.status = 'active'),
           (select m.identity_id
              from public.members m
             where m.space_id = e.space_id
               and m.role = 'owner'
               and m.status = 'active'
             order by m.entity_id
             limit 1)
         ) act_as_identity,
         l.timezone,
         l.action
    from public.loops l
    join public.entities e on e.id = l.entity_id
   where internal.is_loops_worker()
     and l.enabled
     and e.deleted_at is null
     and l.next_run_at is not null
     and l.next_run_at <= now()
     and (l.paused_until is null or l.paused_until <= now())
   order by l.next_run_at
   limit greatest(coalesce(p_limit, 25), 0)
$$;

comment on function public.loops_due_for_executor(integer) is
  '375/384: due loops across every space, for the in-process loop executor only '
  '(internal.is_loops_worker). Read-only. `act_as_identity` is the human who '
  'armed the loop (343), else the space owner, else NULL when the space has no '
  'active member left to act as. 384: a loop paused into the future is not due; '
  '`timezone` and `action` trail the 375 columns.';

revoke all on function public.loops_due_for_executor(integer) from public;
grant execute on function public.loops_due_for_executor(integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- §6. Selection headers for loops. Sibling definer: Tools PR-E's
--     390_tool_selection_headers.sql replaces this function with the SAME
--     list, so either order leaves the converged set.
-- -----------------------------------------------------------------------------
create or replace function internal.header_kind_allowed(p_kind text)
returns boolean language sql immutable set search_path = public, internal, pg_temp as $$
  select p_kind in ('team_member', 'doc', 'artifact', 'drawing', 'file', 'task', 'collection', 'story', 'tool', 'loop')
$$;

analyze public.loop_runs, public.loops;

reset role;
