-- =============================================================================
-- 385 — the loop executor CLAIMS a run before it fires it (design 01a182d4
--       §3.3; task 01a182d5-de68). Loops PR2.
--
-- Predecessor: 384_loops_first_class.sql.
--
-- KEPT AT 385 BELOW MAIN'S TOP AT MERGE (387-390): a deliberate exception to the
-- PR-cleanup ordinal rule, as 384's is (Loops lead ruling, 2026-10-29). An
-- upgraded database applies this file after 390 and a fresh one applies it
-- before 387; both end in the same schema. Checked: 385 only CREATES the eight
-- functions listed below, none of which exists before it, and replaces or drops
-- nothing that 387 (claim_text, header_text, rename_work_session), 388
-- (snapshot_entity_version, start_tool_session, tools_snapshot), 389 (Tools
-- PR-C: start_tool_session, issue_tool_session_loop_session) or 390 (Tools PR-E:
-- header_kind_allowed) touches. None of 387-390 adds or drops a column 385 reads
-- (loops, loop_runs, work_sessions, members, entities) or replaces a helper it
-- calls (is_loops_worker, require_space_member, resolve_actor, ledger_replay,
-- ledger_record). What it calls at run time (claim_text through
-- is_loops_worker, the loops snapshot trigger) resolves to whichever body is
-- live.
--
-- WHAT 384 LEFT FOR THIS FILE. 384 added `loop_runs` and one door,
-- `loop_run_settle` (settle once), and taught 375's due read about pauses. It
-- has no insert door: rows are written here, by the claim, in one transaction
-- with it (a free-standing insert door would let any member forge run history;
-- review 5 of #1406). 384 did not decide HOW a firing is recorded, because
-- research A measured two defects in the old job that a plain "insert a row,
-- then update_loop" would have kept:
--
--   1. A human edit mid-firing made `update_loop` fail its version check, so
--      the bookkeeping write was dropped: `next_run_at` never advanced and the
--      loop fired AGAIN on the next tick (a second session for one deadline).
--   2. The bookkeeping mutation id was keyed on the ENTITY VERSION, so it moved
--      with every unrelated edit and keyed nothing stable.
--
-- THE FIX: claim first, then fire. `loop_run_claim` locks the loop row, re-checks
-- that it is still due, decides overlap, inserts the run row and advances
-- `next_run_at` in ONE transaction keyed on the run id — never on the entity
-- version. The executor then fires the claimed run and records the launch
-- outcome through `loop_run_launched` / `loop_run_launch_failed`. A human edit
-- during a firing affects only later runs; a second node running the same job
-- would skip the row the first one holds (`for update skip locked`).
--
-- THE GRAMMAR STAYS IN TYPESCRIPT. These doors never compute a next run: the
-- executor evaluates the schedule (scheduler/schedule.ts, timezone-aware) and
-- hands the door the advanced instant, or the reason the schedule could not be
-- evaluated. One grammar, as the design requires.
--
-- Objects:
--   internal.loop_acting_identity(loop)        the 375 rule, factored once
--   public.loop_acting_as(loop)                 {identityId, memberId, via} for views
--   public.loops_claimable(limit, now)          the due read the executor claims from
--   public.loops_park_orphans(now)              'needs arming' on loops nobody can run as
--   public.loop_run_claim(...)                  the claim (schedule and Run now)
--   public.loop_run_launched(run, task, session)
--   public.loop_run_launch_failed(run, error, now)   retry backoff lives here
--   public.loop_runs_open_for_executor(now)     the max-runtime / settle sweep read
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Who a firing runs as (375 §2, unchanged rule, factored so the due read,
--     the orphan sweep, Run now and the view agree): the human who armed the
--     loop while still an active member, else the space's active owner, else
--     NULL. Owner-executed from the definers below; never callable by the app.
-- -----------------------------------------------------------------------------
create or replace function internal.loop_acting_identity(p_loop_id uuid)
returns text
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(
    (select m.identity_id
       from public.loops l
       join public.entities e on e.id = l.entity_id
       join public.members m on m.identity_id = l.armed_by_identity_id
                            and m.space_id = e.space_id
      where l.entity_id = p_loop_id
        and m.status = 'active'),
    (select m.identity_id
       from public.entities e
       join public.members m on m.space_id = e.space_id
      where e.id = p_loop_id
        and m.role = 'owner'
        and m.status = 'active'
      order by m.entity_id
      limit 1))
$$;
revoke all on function internal.loop_acting_identity(uuid) from public;

comment on function internal.loop_acting_identity(uuid) is
  '385: the identity the NEXT firing of this loop runs as (375 rule): the armer '
  'while an active member, else the space''s active owner, else NULL.';

-- For LoopView.state.actingAs (§4.2) and the Run now handler: who, and by which
-- rule. A member of the loop''s space or the executor may ask.
create or replace function public.loop_acting_as(p_loop_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  v_space uuid;
  v_armer text;
  v_identity text;
  v_member uuid;
begin
  select e.space_id, l.armed_by_identity_id into v_space, v_armer
    from public.loops l join public.entities e on e.id = l.entity_id
   where l.entity_id = p_loop_id and e.deleted_at is null;
  if v_space is null then
    raise exception 'loop % not found', p_loop_id using errcode = 'P0002';
  end if;
  if not internal.is_loops_worker() then
    perform internal.require_space_member(v_space);
  end if;
  v_identity := internal.loop_acting_identity(p_loop_id);
  if v_identity is null then
    return jsonb_build_object('identityId', null, 'memberId', null, 'via', 'none');
  end if;
  select m.entity_id into v_member from public.members m
   where m.space_id = v_space and m.identity_id = v_identity and m.status = 'active'
   order by m.entity_id limit 1;
  return jsonb_build_object(
    'identityId', v_identity,
    'memberId', v_member,
    'via', case when v_identity = v_armer then 'armer' else 'fallback' end);
end
$$;
revoke all on function public.loop_acting_as(uuid) from public;
grant execute on function public.loop_acting_as(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- §2. The due read the executor CLAIMS from. Supersedes 375's
--     `loops_due_for_executor` for the job (that function stays for its own
--     tests and any other reader): the same predicates plus §3.2's pause rule
--     and the orphan filter, and every column a firing branches on (§2.1).
--
--     A loop with no identity to act as is NOT returned — §2's sweep parks it
--     with a reason instead, so 25 orphans can no longer sit at the front of
--     the queue and starve every other loop on the node (research A).
-- -----------------------------------------------------------------------------
create or replace function public.loops_claimable(
  p_limit integer default 25, p_now timestamptz default now(),
  p_live_session_ids uuid[] default '{}'::uuid[]
)
returns table (
  entity_id            uuid,
  space_id             uuid,
  title                text,
  schedule             text,
  timezone             text,
  action               text,
  team_member_id       uuid,
  subject_id           uuid,
  tool_id              uuid,
  tool_inputs          jsonb,
  prompt               text,
  config               jsonb,
  version              integer,
  concurrency          text,
  max_runtime_seconds  integer,
  retry_attempts       integer,
  retry_delay_seconds  integer,
  retry_attempt        integer,
  paused_until         timestamptz,
  next_run_at          timestamptz,
  act_as_identity      text
)
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select l.entity_id, e.space_id, l.title, l.schedule, l.timezone, l.action,
         l.team_member_id, l.subject_id, l.tool_id, l.tool_inputs, l.prompt, l.config,
         e.version, l.concurrency, l.max_runtime_seconds,
         l.retry_attempts::integer, l.retry_delay_seconds, l.retry_attempt::integer,
         l.paused_until, l.next_run_at, a.act_as
    from public.loops l
    join public.entities e on e.id = l.entity_id
    cross join lateral (select internal.loop_acting_identity(l.entity_id) as act_as) a
   where internal.is_loops_worker()
     and l.enabled
     and e.deleted_at is null
     and l.next_run_at is not null
     and l.next_run_at <= p_now
     and (l.paused_until is null or l.paused_until <= p_now)
     and a.act_as is not null
     -- A queue loop held back by a LIVE open firing stays due (§3.3) but is not
     -- claimable: it would take one of the tick's slots every tick and starve
     -- the loops behind it. Live is the claim's own rule (the PTY set the
     -- executor passes, or a launch still in flight), so a run whose session
     -- died with the node never holds the loop: it reaches the claim and fires
     -- (§3.2 restart), and the sweep settles the dead run. A dispatch run's
     -- session is the space's shared dispatcher, never the run's liveness.
     and not (l.concurrency = 'queue' and exists (
           select 1 from public.loop_runs r
            where r.loop_id = l.entity_id and r.launch = 'fired' and r.outcome is null
              and not (r.action = 'dispatch' and r.session_id is not null)
              and (r.session_id = any(coalesce(p_live_session_ids, '{}'::uuid[]))
                   or (r.session_id is null and r.fired_at > p_now - interval '10 minutes'))))
   order by l.next_run_at
   limit greatest(coalesce(p_limit, 25), 0)
$$;
revoke all on function public.loops_claimable(integer, timestamptz, uuid[]) from public;
grant execute on function public.loops_claimable(integer, timestamptz, uuid[]) to tm8_app;

comment on function public.loops_claimable(integer, timestamptz, uuid[]) is
  '385: due loops across every space with everything a firing branches on, for '
  'the in-process executor only (internal.is_loops_worker). A lapsed pause is '
  'due (§3.2); a loop with no identity to act as is left to loops_park_orphans.';

-- A due loop nobody can act as is parked LOUDLY: `last_error` says why, once,
-- and the clock keeps running, so the moment the space has an active owner (or
-- the armer returns) the loop is due and fires once. Idempotent: a loop already
-- carrying the reason is not rewritten, so its version does not churn per tick.
create or replace function public.loops_park_orphans(p_now timestamptz default now())
returns table (entity_id uuid, space_id uuid, title text)
language plpgsql volatile security definer
set search_path = public, internal, pg_temp as $$
declare
  v_reason constant text := 'needs arming: no active member of this space to run the loop as';
begin
  if not internal.is_loops_worker() then
    return;
  end if;
  return query
    with due as (
      select l.entity_id, e.space_id
        from public.loops l
        join public.entities e on e.id = l.entity_id
       where l.enabled
         and e.deleted_at is null
         and l.next_run_at is not null
         and l.next_run_at <= p_now
         and (l.paused_until is null or l.paused_until <= p_now)
         and internal.loop_acting_identity(l.entity_id) is null
         and l.last_error is distinct from v_reason
    )
    update public.loops l
       set last_error = v_reason, updated_at = now()
      from due
     where l.entity_id = due.entity_id
    returning l.entity_id, due.space_id, l.title;
end
$$;
revoke all on function public.loops_park_orphans(timestamptz) from public;
grant execute on function public.loops_park_orphans(timestamptz) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. The claim (§3.3). ONE transaction: lock the loop, re-check it is due,
--     decide overlap, insert the run row, advance the schedule.
--
--     p_trigger 'schedule' is the executor's (worker claim required; the loop
--     must still be due at p_now — a human edit that recomputed next_run_at
--     in between makes this return {claimed:false, reason:'not_due'}).
--     p_trigger 'manual' is Run now (a member of the space; enabled, paused and
--     next_run_at are irrelevant and untouched — a human asked for a run).
--
--     Overlap is decided from OPEN runs: launch='fired', unsettled, and either
--     a session that is live right now (p_live_session_ids is the PTY map the
--     executor reads, 375's probe) or a launch still in flight (no session yet,
--     fired within the last ten minutes — the job's own timeout). A session
--     that died with the node is therefore not an overlap, so a loop cannot
--     wedge after a crash; 171's ghost reconciliation settles its row.
--
--     Results (jsonb): {claimed:true, runId, launch:'fired'|'skipped', skipReason,
--     attempt, actedAsIdentityId, requestedBy} or {claimed:false, reason:
--     'not_due'|'locked'|'overlap'|'queued', waitingOnRunId}.
--
--     Order of decision: an unevaluable schedule parks the loop before anything
--     else (next_run_at NULL, last_error = the reason; §3.3 "parked, never
--     silently never-due"); then overlap (skip → a 'skipped'/'overlap' row and
--     the schedule advances; queue → NO row and next_run_at untouched, so the
--     loop stays due and fires on the first tick the previous run has settled;
--     Run now → refused unless forced); then the fire: a 'fired' row with
--     attempt = retry_attempt + 1, next_run_at = the advanced instant,
--     last_run_at = now.
-- -----------------------------------------------------------------------------
create or replace function public.loop_run_claim(
  p_loop_id uuid,
  p_now timestamptz,
  p_trigger text,
  p_live_session_ids uuid[] default '{}'::uuid[],
  p_next_run_at timestamptz default null,
  p_schedule_error text default null,
  p_acted_as_identity_id text default null,
  p_requested_by uuid default null,
  p_force boolean default false,
  p_client_mutation_id text default null
) returns jsonb language plpgsql volatile security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  l public.loops;
  v_space uuid;
  v_deleted timestamptz;
  v_act_as text;
  v_requested_by uuid;
  v_open_run uuid;
  v_run uuid;
  v_attempt integer;
  v_result jsonb;
begin
  if p_trigger is null or p_trigger not in ('schedule', 'manual') then
    raise exception 'loop run trigger must be schedule or manual' using errcode = '22023';
  end if;
  if p_trigger = 'schedule' and not internal.is_loops_worker() then
    raise exception 'scheduled claims belong to the loop executor' using errcode = '42501';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'loops.runs.claim');
  if replay is not null then return replay; end if;

  -- The locks, entity row FIRST: update_loop takes entities (assert_version)
  -- and then loops, and this claim's own update of loops locks entities again
  -- through the version-snapshot trigger, so locking loops first could
  -- deadlock with a human's save. A row someone else holds is skipped, not
  -- waited for: the holder is deciding this very deadline or editing it, and
  -- the next tick re-reads.
  -- FOR UPDATE, not NO KEY UPDATE: the snapshot trigger re-locks this row FOR
  -- UPDATE, and that upgrade would wait on an edge insert's FOR KEY SHARE while
  -- the edge's activity touch waits on this claim (a deadlock, reproduced on PG16).
  perform 1 from public.entities where id = p_loop_id for update skip locked;
  if not found then
    perform 1 from public.entities where id = p_loop_id;
    if not found then
      raise exception 'loop % not found', p_loop_id using errcode = 'P0002';
    end if;
    return jsonb_build_object('claimed', false, 'reason', 'locked');
  end if;
  select * into l from public.loops where entity_id = p_loop_id for update skip locked;
  if l.entity_id is null then
    perform 1 from public.loops where entity_id = p_loop_id;
    if not found then
      raise exception 'loop % not found', p_loop_id using errcode = 'P0002';
    end if;
    return jsonb_build_object('claimed', false, 'reason', 'locked');
  end if;
  select e.space_id, e.deleted_at into v_space, v_deleted from public.entities e where e.id = p_loop_id;
  if v_space is null or v_deleted is not null then
    raise exception 'loop % not found', p_loop_id using errcode = 'P0002';
  end if;

  if p_trigger = 'schedule' then
    if not (l.enabled and l.next_run_at is not null and l.next_run_at <= p_now
            and (l.paused_until is null or l.paused_until <= p_now)) then
      return jsonb_build_object('claimed', false, 'reason', 'not_due');
    end if;
    if p_next_run_at is null and p_schedule_error is null then
      raise exception 'a scheduled claim needs the advanced next_run_at or the schedule error'
        using errcode = '22023';
    end if;
  else
    if not internal.is_loops_worker() then
      perform internal.require_space_member(v_space);
      v_requested_by := internal.resolve_actor(p_requested_by, v_space);
    else
      v_requested_by := p_requested_by;
    end if;
  end if;

  v_act_as := coalesce(p_acted_as_identity_id, internal.loop_acting_identity(p_loop_id));

  -- 1. An unevaluable schedule parks the loop with the reason on it.
  if p_trigger = 'schedule' and p_schedule_error is not null then
    insert into public.loop_runs(loop_id, space_id, fired_at, trigger, requested_by, action, attempt,
                                 acted_as_identity_id, launch, skip_reason, error, ended_at)
    values (p_loop_id, v_space, p_now, 'schedule', null, l.action, 1,
            v_act_as, 'skipped', 'schedule_invalid', p_schedule_error, p_now)
    returning id into v_run;
    update public.loops
       set next_run_at = null, last_error = p_schedule_error, updated_at = now()
     where entity_id = p_loop_id;
    v_result := jsonb_build_object('claimed', true, 'runId', v_run, 'launch', 'skipped',
                                   'skipReason', 'schedule_invalid', 'attempt', 1,
                                   'actedAsIdentityId', v_act_as, 'requestedBy', null);
    return internal.ledger_record(p_client_mutation_id, 'loops.runs.claim', v_result);
  end if;

  -- 2. Overlap: is a previous run of this loop still open AND alive?
  select r.id into v_open_run
    from public.loop_runs r
   where r.loop_id = p_loop_id
     and r.launch = 'fired'
     and r.outcome is null
     -- A dispatch run's session is the shared dispatcher; it settles at delivery.
     and not (r.action = 'dispatch' and r.session_id is not null)
     and (r.session_id = any(coalesce(p_live_session_ids, '{}'::uuid[]))
          or (r.session_id is null and r.fired_at > p_now - interval '10 minutes'))
   order by r.fired_at desc
   limit 1;

  if v_open_run is not null and not (p_trigger = 'manual' and coalesce(p_force, false)) then
    if p_trigger = 'manual' then
      return jsonb_build_object('claimed', false, 'reason', 'overlap', 'waitingOnRunId', v_open_run);
    end if;
    if l.concurrency = 'queue' then
      -- Stays due; no row per tick (§12). The view derives "waiting on <run>".
      return jsonb_build_object('claimed', false, 'reason', 'queued', 'waitingOnRunId', v_open_run);
    end if;
    insert into public.loop_runs(loop_id, space_id, fired_at, trigger, requested_by, action, attempt,
                                 acted_as_identity_id, launch, skip_reason, error, ended_at)
    values (p_loop_id, v_space, p_now, 'schedule', null, l.action, 1,
            v_act_as, 'skipped', 'overlap', null, p_now)
    returning id into v_run;
    update public.loops
       set next_run_at = p_next_run_at, updated_at = now()
     where entity_id = p_loop_id;
    v_result := jsonb_build_object('claimed', true, 'runId', v_run, 'launch', 'skipped',
                                   'skipReason', 'overlap', 'attempt', 1,
                                   'actedAsIdentityId', v_act_as, 'requestedBy', null,
                                   'waitingOnRunId', v_open_run);
    return internal.ledger_record(p_client_mutation_id, 'loops.runs.claim', v_result);
  end if;

  -- 3. The firing. attempt counts THIS deadline's tries (1 + retry_attempt).
  v_attempt := coalesce(l.retry_attempt, 0) + 1;
  insert into public.loop_runs(loop_id, space_id, fired_at, trigger, requested_by, action, attempt,
                               acted_as_identity_id, launch)
  values (p_loop_id, v_space, p_now, p_trigger, v_requested_by, l.action, v_attempt,
          v_act_as, 'fired')
  returning id into v_run;

  if p_trigger = 'schedule' then
    update public.loops
       set next_run_at = p_next_run_at, last_run_at = p_now, updated_at = now()
     where entity_id = p_loop_id;
  else
    update public.loops
       set last_run_at = p_now, updated_at = now()
     where entity_id = p_loop_id;
  end if;

  v_result := jsonb_build_object('claimed', true, 'runId', v_run, 'launch', 'fired',
                                 'skipReason', null, 'attempt', v_attempt,
                                 'actedAsIdentityId', v_act_as, 'requestedBy', v_requested_by);
  return internal.ledger_record(p_client_mutation_id, 'loops.runs.claim', v_result);
end
$$;
revoke all on function public.loop_run_claim(uuid,timestamptz,text,uuid[],timestamptz,text,text,uuid,boolean,text) from public;
grant execute on function public.loop_run_claim(uuid,timestamptz,text,uuid[],timestamptz,text,text,uuid,boolean,text) to tm8_app;

comment on function public.loop_run_claim(uuid,timestamptz,text,uuid[],timestamptz,text,text,uuid,boolean,text) is
  '385: claim one run of a loop before firing it: lock, re-check due, decide '
  'overlap (skip/queue/409), insert the loop_runs row and advance next_run_at in '
  'one transaction keyed on the run id. The executor (schedule) or a member (Run '
  'now). The schedule grammar is evaluated by the caller, never here.';

-- -----------------------------------------------------------------------------
-- §4. The launch outcome, written AFTER the fire returned.
--
--     Success: the run gets its task and session; the loop''s retry counter
--     resets and last_error clears (§3.3). Failure: the run becomes
--     launch='failed' with the error; last_error is set; a scheduled run with
--     retries left is re-armed at now + retry_delay_seconds with retry_attempt
--     advanced (so the next claim reports attempt n+1), and one that has
--     exhausted its retries goes back to 0 so the next deadline gets a fresh
--     budget. Failures never disable (unchanged since 091). A manual run never
--     retries: the human who pressed Run now sees the refusal.
-- -----------------------------------------------------------------------------
create or replace function public.loop_run_launched(
  p_run_id uuid, p_task_id uuid default null, p_session_id uuid default null
) returns jsonb language plpgsql volatile security definer
set search_path = public, internal, pg_temp as $$
declare r public.loop_runs;
begin
  select * into r from public.loop_runs where id = p_run_id for update;
  if r.id is null then
    raise exception 'loop run % not found', p_run_id using errcode = 'P0002';
  end if;
  if not internal.is_loops_worker() then
    perform internal.require_space_member(r.space_id);
  end if;
  if r.launch <> 'fired' then
    raise exception 'loop run % was not fired (launch=%)', p_run_id, r.launch using errcode = '22023';
  end if;
  update public.loop_runs
     set task_id = coalesce(p_task_id, task_id), session_id = coalesce(p_session_id, session_id)
   where id = p_run_id
   returning * into r;
  -- A parked loop (no deadline) keeps the reason it is parked: a Run now that
  -- launched does not make its schedule evaluable (§3.3, never silently never-due).
  update public.loops
     set retry_attempt = 0,
         last_error = case when next_run_at is null then last_error end,
         updated_at = now()
   where entity_id = r.loop_id
     and (retry_attempt <> 0 or (last_error is not null and next_run_at is not null));
  return jsonb_build_object('runId', r.id, 'taskId', r.task_id, 'sessionId', r.session_id, 'attempt', r.attempt);
end
$$;
revoke all on function public.loop_run_launched(uuid,uuid,uuid) from public;
grant execute on function public.loop_run_launched(uuid,uuid,uuid) to tm8_app;

create or replace function public.loop_run_launch_failed(
  p_run_id uuid, p_error text, p_now timestamptz default now()
) returns jsonb language plpgsql volatile security definer
set search_path = public, internal, pg_temp as $$
declare
  r public.loop_runs;
  l public.loops;
  v_retry_at timestamptz;
  v_error text := left(coalesce(nullif(btrim(p_error), ''), 'launch failed'), 4000);
begin
  select * into r from public.loop_runs where id = p_run_id for update;
  if r.id is null then
    raise exception 'loop run % not found', p_run_id using errcode = 'P0002';
  end if;
  if not internal.is_loops_worker() then
    perform internal.require_space_member(r.space_id);
  end if;
  if r.launch <> 'fired' or r.outcome is not null then
    raise exception 'loop run % is not an open firing', p_run_id using errcode = '22023';
  end if;
  update public.loop_runs
     set launch = 'failed', error = v_error, ended_at = p_now
   where id = p_run_id
   returning * into r;

  select * into l from public.loops where entity_id = r.loop_id for update;
  -- Re-armed only while the loop is as the claim left it: the claim stamped
  -- updated_at in the run's own transaction, so a later stamp is a write made
  -- during the firing (a human's edit, a disable), and that write wins. The
  -- retry never pushes a sooner deadline later.
  if r.trigger = 'schedule' and l.retry_attempt < l.retry_attempts and l.updated_at <= r.created_at then
    v_retry_at := least(l.next_run_at, p_now + make_interval(secs => l.retry_delay_seconds));
    update public.loops
       set retry_attempt = l.retry_attempt + 1,
           next_run_at = v_retry_at,
           last_error = v_error,
           updated_at = now()
     where entity_id = r.loop_id;
  else
    -- A manual failure leaves a scheduled retry series alone (no extra
    -- attempt), and does not overwrite the reason a parked loop carries.
    update public.loops
       set retry_attempt = case when r.trigger = 'manual' then retry_attempt else 0 end,
           last_error = case when r.trigger = 'manual' and next_run_at is null then last_error else v_error end,
           updated_at = now()
     where entity_id = r.loop_id;
  end if;
  return jsonb_build_object('runId', r.id, 'attempt', r.attempt, 'retryAt', v_retry_at);
end
$$;
revoke all on function public.loop_run_launch_failed(uuid,text,timestamptz) from public;
grant execute on function public.loop_run_launch_failed(uuid,text,timestamptz) to tm8_app;

-- -----------------------------------------------------------------------------
-- §5. The sweep's read: every open firing (launch='fired', unsettled) across
--     every space, with the session facts the executor settles from. Worker
--     only. The executor: stops and settles 'timed_out' a live session past
--     fired_at + max_runtime_seconds; settles 'completed'/'failed' from a
--     session that has reached a terminal status (a tool run''s non-zero exit
--     is 'failed'); settles 'failed' a launch that never recorded a session
--     within ten minutes (the server died mid-firing). `act_as_identity` is the
--     identity whose membership lets the stop go through the ordinary doors:
--     the run''s own, while still active, else the loop''s current one.
--     `session_node_id` is the node that hosts the session: only that node''s
--     PTY map can say it is gone, so a node calls lost only its own sessions
--     (or ones with no node recorded), as SpawnService and the reaper do.
-- -----------------------------------------------------------------------------
create or replace function public.loop_runs_open_for_executor(p_now timestamptz default now())
returns table (
  run_id               uuid,
  loop_id              uuid,
  space_id             uuid,
  action               text,
  trigger              text,
  fired_at             timestamptz,
  session_id           uuid,
  max_runtime_seconds  integer,
  session_status       text,
  session_kind         text,
  exit_code            integer,
  tool_exit_code       integer,
  exited_at            timestamptz,
  act_as_identity      text,
  session_outcome      text,
  session_node_id      text
)
language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select r.id, r.loop_id, r.space_id, r.action, r.trigger, r.fired_at, r.session_id,
         l.max_runtime_seconds,
         ws.status, ws.session_kind, ws.exit_code, ws.tool_exit_code,
         coalesce(ws.exited_at, ws.tool_exited_at),
         coalesce(
           (select m.identity_id from public.members m
             where m.identity_id = r.acted_as_identity_id and m.space_id = r.space_id and m.status = 'active'),
           internal.loop_acting_identity(r.loop_id)),
         ws.outcome,
         ws.node_id
    from public.loop_runs r
    join public.loops l on l.entity_id = r.loop_id
    left join public.work_sessions ws on ws.entity_id = r.session_id
   where internal.is_loops_worker()
     and r.launch = 'fired'
     and r.outcome is null
   order by r.fired_at
   limit 500
$$;
revoke all on function public.loop_runs_open_for_executor(timestamptz) from public;
grant execute on function public.loop_runs_open_for_executor(timestamptz) to tm8_app;

comment on function public.loop_runs_open_for_executor(timestamptz) is
  '385: open loop firings across every space with their session facts, for the '
  'executor''s max-runtime and settle sweep only (internal.is_loops_worker).';

reset role;
