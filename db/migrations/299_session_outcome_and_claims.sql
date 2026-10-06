-- =============================================================================
-- 299 — a session's OUTCOME is not its PROCESS, and a claim has a lifetime.
-- Spec D1 (doc 01a110ab), task P0a 01a10c66. Replaces Design Rules §2.1/§2.2.
--
-- THE DEFECT. One column, `work_sessions.status`, answered two questions: is
-- the work done, and is the process alive. 142 of 173 sessions in the
-- reporting space ended `exited / stopped_by_operator`, finished and abandoned
-- work alike; a crash after the work was done moved the row back to In
-- Progress; a "completed" session could claim more work; and an exit with code
-- 0 was recorded as `completed` whatever state the work was in. Separately,
-- `working_on` edges were never ended — `task complete` left them in place and
-- no session ending touched them — so current work and history were the same
-- rows.
--
-- THE MODEL (spec §3).
--
--   outcome  open -> completed | stopped, set by `session complete` (with a
--            receipt and the claim check) or by an operator's Stop. Once
--            completed it is final; stopped -> open only through resume.
--            SINGLE WRITER: the functions in this file (tm8.work_session_outcome).
--   process  `status` + `ended_kind`, unchanged in meaning, still written only by
--            `work_session_transition` / `execution_resume`. NO process event
--            writes the outcome — not exit, crash, restart, reaper or terminate.
--
-- `ended_kind` 'completed' is renamed `exited_clean` (a clean exit says nothing
-- about the work), and `lost` (ghost reaper) and `credential_revoked` (credential
-- containment, which used to masquerade as stopped_by_operator) are added.
--
-- CATEGORY (spec §3.2): outcome first, then process.
--   completed -> done, stopped -> cancelled, open+spawning -> to_do,
--   open+anything else -> in_progress (an ended open session is unfinished).
--
-- CLAIMS (spec §6). `working_on` rows are KEPT when they end: props gain
-- `endedAt` and `endReason` (task_done, task_cancelled, released,
-- session_completed, session_stopped, task_reset, backfill). Every write of
-- `tasks.work_status` ends or updates the task's claims in the same
-- transaction, through ONE trigger, so set_work_state, complete_task, the gate
-- path and any later writer cannot disagree. Reads of current work filter
-- `props->>'endedAt' is null`.
--
-- A claim made from inside an agent session is the SESSION's claim (src = the
-- work_session), read off the verified `tm8.work_session_id` claim the server
-- forwards from the bearer — not the team member the token acts as.
--
-- EVENTS: session.outcome_changed, session.process_changed (from triggers, so
-- every writer emits them) and edge.ended.
--
-- D2 EXTENSION POINT. Everything `session complete` refuses on is computed by
-- `internal.session_completion_blockers`, one jsonb list. A child-session /
-- handover check adds rows there; the refusal shape does not change.
-- =============================================================================

-- Runs as the migration user, not tm8_graph_owner: several functions replaced
-- here (work_session_transition, set_session_done, execution_resume, the 2-arg
-- session_status_category) are owned by it since 171/174.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.work_sessions
  add column outcome text not null default 'open',
  add column outcome_at timestamptz,
  add column outcome_by uuid references public.entities(id) on delete set null,
  add column receipt_message_id uuid references public.messages(entity_id) on delete set null,
  add column outcome_source text,
  add column outcome_note text;

alter table public.work_sessions
  add constraint work_sessions_outcome_check
    check (outcome in ('open', 'completed', 'stopped')),
  add constraint work_sessions_outcome_source_check
    check (outcome_source is null or outcome_source in ('self', 'operator', 'backfill')),
  -- An open session has no outcome facts; a settled one always has its time and source.
  add constraint work_sessions_outcome_together_check
    check ((outcome = 'open') = (outcome_at is null)
       and (outcome = 'open') = (outcome_source is null)),
  add constraint work_sessions_receipt_completed_check
    check (receipt_message_id is null or outcome = 'completed');

comment on column public.work_sessions.outcome is
  'Spec D1 §3: is the WORK finished. open | completed | stopped. Process events never write it.';

-- ---------------------------------------------------------------------------
-- 2. End kinds
-- ---------------------------------------------------------------------------

alter table public.work_sessions drop constraint work_sessions_ended_kind_check;
alter table public.work_sessions add constraint work_sessions_ended_kind_check
  check (ended_kind is null or ended_kind in (
    'exited_clean', 'stopped_by_operator', 'server_restart', 'out_of_memory',
    'crashed', 'unknown', 'container_stopped', 'runtime_lost',
    'lost', 'credential_revoked'));

-- ---------------------------------------------------------------------------
-- 3. Claims carry endedAt / endReason
-- ---------------------------------------------------------------------------

update public.edge_types
   set props_schema = jsonb_build_object(
         'type', 'object',
         'additionalProperties', true,
         'properties', jsonb_build_object(
           'note',             jsonb_build_object('type', jsonb_build_array('string', 'null')),
           'status',           jsonb_build_object('type', 'string'),
           'startedAt',        jsonb_build_object('type', 'string'),
           'endedAt',          jsonb_build_object('type', jsonb_build_array('string', 'null')),
           'endReason',        jsonb_build_object('type', jsonb_build_array('string', 'null')),
           'endNote',          jsonb_build_object('type', jsonb_build_array('string', 'null')),
           'handoffMessageId', jsonb_build_object('type', jsonb_build_array('string', 'null'))))
 where type = 'working_on';

create index if not exists edges_working_on_active_src_idx
  on public.edges (src_id) where type = 'working_on' and (props->>'endedAt') is null;
create index if not exists edges_working_on_active_dst_idx
  on public.edges (dst_id) where type = 'working_on' and (props->>'endedAt') is null;

-- The claim status vocabulary (spec R2). `pulled`/`open` are not claim states.
create or replace function internal.claim_status_for(p_work_status text)
returns text language sql immutable
set search_path = public, internal, pg_temp as $$
  select case when p_work_status in ('working', 'in_review', 'blocked') then p_work_status
              else 'working' end
$$;

-- The caller's own work session, from the server-verified bearer. NULL for a
-- human or CLI caller, and NULL when the claim names a row that is not a
-- session in that space (never trust a stale id into an edge source).
create or replace function internal.caller_work_session(p_space_id uuid)
returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  raw text := internal.claim_text('tm8.work_session_id');
  sid uuid;
begin
  if raw is null or raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select e.id into sid
    from public.entities e
    join public.work_sessions ws on ws.entity_id = e.id
   where e.id = raw::uuid and e.space_id = p_space_id and e.deleted_at is null;
  return sid;
end
$$;

-- Ends the given claims: stamps endedAt/endReason (and the hand-off), keeps the
-- row, and emits `edge.ended` beside the row's own `edge.upsert`. Rows already
-- ended are skipped, so every caller may pass a superset.
create or replace function internal.end_claims(
  p_edge_ids uuid[], p_reason text, p_note text default null,
  p_handoff_message_id uuid default null, p_ended_at timestamptz default null)
returns integer language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  r record;
  n integer := 0;
  at timestamptz := coalesce(p_ended_at, now());
begin
  if p_reason not in ('task_done', 'task_cancelled', 'released', 'session_completed',
                      'session_stopped', 'task_reset', 'backfill') then
    raise exception 'invalid claim end reason: %', p_reason using errcode = '22023';
  end if;
  for r in
    update public.edges ed
       set props = ed.props || jsonb_build_object(
             'endedAt', to_jsonb(at),
             'endReason', p_reason)
           || case when p_note is not null then jsonb_build_object('endNote', p_note) else '{}'::jsonb end
           || case when p_handoff_message_id is not null
                   then jsonb_build_object('handoffMessageId', p_handoff_message_id) else '{}'::jsonb end
     where ed.id = any(p_edge_ids)
       and ed.type = 'working_on'
       and (ed.props->>'endedAt') is null
    returning ed.id, ed.space_id, ed.src_id, ed.dst_id
  loop
    n := n + 1;
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (r.space_id, internal.next_event_seq(r.space_id), 'edge.ended',
            jsonb_build_object('id', r.id, 'type', 'working_on', 'src_id', r.src_id,
                               'dst_id', r.dst_id, 'endReason', p_reason, 'endedAt', at),
            internal.claim_cmid());
  end loop;
  return n;
end
$$;

-- A new claim row: `status` and `startedAt` always present (spawn inserts
-- bare props), and a completed session can never become a claimant (spec §3
-- rule 5) — the backstop under set_work_state's own named refusal.
create or replace function internal.working_on_claim_defaults()
returns trigger language plpgsql
set search_path = public, internal, pg_temp as $$
declare
  v_outcome text;
  v_reopening boolean;
begin
  if new.type <> 'working_on' then return new; end if;
  v_reopening := tg_op = 'INSERT'
    or ((old.props->>'endedAt') is not null and (new.props->>'endedAt') is null);
  if v_reopening then
    select ws.outcome into v_outcome from public.work_sessions ws where ws.entity_id = new.src_id;
    if v_outcome = 'completed' then
      raise exception 'a completed session cannot claim work'
        using errcode = '23514', detail = '{"reason":"session_completed"}';
    end if;
  end if;
  if not (new.props ? 'status') then
    new.props := new.props || jsonb_build_object('status',
      internal.claim_status_for((select t.work_status from public.tasks t where t.entity_id = new.dst_id)));
  end if;
  if not (new.props ? 'startedAt') or new.props->'startedAt' = 'null'::jsonb then
    new.props := new.props || jsonb_build_object('startedAt', to_jsonb(now()));
  end if;
  return new;
end
$$;

drop trigger if exists edges_working_on_claim_defaults on public.edges;
create trigger edges_working_on_claim_defaults
  before insert or update of props on public.edges
  for each row when (new.type = 'working_on')
  execute function internal.working_on_claim_defaults();

-- THE ONE PLACE claims follow their task (spec §6.9). Runs after
-- tasks_category_bridge (trigger names fire in order), so the entity's
-- category is already the new one.
create or replace function internal.claims_follow_task_status()
returns trigger language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  cat text;
  ids uuid[];
begin
  select e.status_category into cat from public.entities e where e.id = new.entity_id;
  cat := coalesce(cat, internal.work_status_category(new.work_status));

  select coalesce(array_agg(ed.id), '{}') into ids
    from public.edges ed
   where ed.dst_id = new.entity_id and ed.type = 'working_on'
     and (ed.props->>'endedAt') is null;
  if cardinality(ids) = 0 then return new; end if;

  if cat = 'done' then
    perform internal.end_claims(ids, 'task_done');
  elsif cat = 'cancelled' then
    perform internal.end_claims(ids, 'task_cancelled');
  elsif new.work_status = 'open' then
    perform internal.end_claims(ids, 'task_reset');
  elsif new.work_status in ('working', 'in_review', 'blocked') then
    update public.edges ed
       set props = ed.props || jsonb_build_object('status', new.work_status)
     where ed.id = any(ids)
       and ed.props->>'status' is distinct from new.work_status;
  end if;
  return new;
end
$$;

drop trigger if exists tasks_claims_follow_status on public.tasks;
create trigger tasks_claims_follow_status
  after update of work_status on public.tasks
  for each row when (old.work_status is distinct from new.work_status)
  execute function internal.claims_follow_task_status();


-- ---------------------------------------------------------------------------
-- 3b. SQL readers of CURRENT work skip ended claims (spec §6.9). History
--     readers (story_trail, stories_containing, derive_task_for_entity, form
--     attachment, conversation routing) keep every claim. The done/cancelled
--     nudge (enqueue_task_state_nudges) is deliberately NOT filtered: it runs
--     after tasks_claims_follow_status in the same statement, so it must still
--     see the claims that statement just ended.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attention_badges(p_entity_ids uuid[])
 RETURNS TABLE(entity_id uuid, pending_count integer, total_points integer, max_points integer, latest_reason text, oldest_requested_at timestamp with time zone, max_level text, assignee_ids uuid[], rolled_up_count integer, raised_pending_count integer, raised_max_level text, raised_latest_reason text, raised_oldest_requested_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  with ids as (
    select distinct x.id from unnest(p_entity_ids) as x(id)
  ),
  -- Requests that could land on an id: pinned to it, or pinned to something
  -- with a roll-up edge to it. Bounds the rollup to indexed candidates.
  candidates as (
    select ar.id from public.attention_requests ar
     where ar.entity_id = any(p_entity_ids) and ar.status in ('open', 'acknowledged')
    union
    select ar.id from public.edges e
      join public.attention_requests ar on ar.entity_id = e.src_id
     where e.dst_id = any(p_entity_ids) and e.type in ('working_on', 'attached_to')
       and (e.type <> 'working_on' or (e.props->>'endedAt') is null)
       and ar.status in ('open', 'acknowledged')
  ),
  pending as (
    select ar.*, r.root_id
      from public.attention_requests ar
      join public.attention_rollup r on r.request_id = ar.id
     where ar.id in (select c.id from candidates c)
  ),
  badge as (
    select x.id as entity_id,
           count(*)::int as pending_count,
           sum(p.points)::int as total_points,
           max(p.points)::int as max_points,
           (array_agg(p.reason order by p.created_at desc, p.id desc))[1] as latest_reason,
           min(p.created_at) as oldest_requested_at,
           (array_agg(p.level order by array_position(array['fyi','normal','high','urgent'], p.level) desc))[1] as max_level,
           coalesce(array_agg(distinct p.assignee_id) filter (where p.assignee_id is not null), '{}') as assignee_ids,
           (count(*) filter (where p.entity_id <> x.id))::int as rolled_up_count
      from ids x
      join pending p on p.root_id = x.id or p.entity_id = x.id
     group by x.id
  ),
  raiser as (
    select x.id as entity_id
      from ids x
      join public.entities k on k.id = x.id and k.kind in ('work_session', 'chat')
  ),
  raised as (
    select s.entity_id,
           count(ar.id)::int as raised_pending_count,
           array_agg(ar.level order by array_position(array['fyi','normal','high','urgent'], ar.level) desc)
             filter (where ar.id is not null) as levels,
           array_agg(ar.reason order by ar.created_at desc, ar.id desc) filter (where ar.id is not null) as reasons,
           min(ar.created_at) as raised_oldest_requested_at
      from raiser s
      left join public.attention_requests ar
        on ar.source_session_id = s.entity_id and ar.status in ('open', 'acknowledged')
     group by s.entity_id
  )
  select coalesce(b.entity_id, r.entity_id),
         coalesce(b.pending_count, 0),
         coalesce(b.total_points, 0),
         coalesce(b.max_points, 0),
         b.latest_reason,
         b.oldest_requested_at,
         b.max_level,
         coalesce(b.assignee_ids, '{}'),
         coalesce(b.rolled_up_count, 0),
         r.raised_pending_count,
         r.levels[1],
         r.reasons[1],
         r.raised_oldest_requested_at
    from badge b
    full join raised r on r.entity_id = b.entity_id
   where coalesce(b.pending_count, 0) > 0 or coalesce(r.raised_pending_count, 0) > 0
$function$;

CREATE OR REPLACE FUNCTION internal.attention_root_candidates(p_root_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  select array[p_root_id] || coalesce(
    (select array_agg(e.src_id) from public.edges e
      where e.dst_id = p_root_id and e.type in ('working_on', 'attached_to')
        and (e.type <> 'working_on' or (e.props->>'endedAt') is null)),
    '{}'::uuid[])
$function$;

CREATE OR REPLACE FUNCTION internal.raise_blocked_dependencies(p_task_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
declare
  dep record;
  raised integer := 0;
begin
  if not exists (select 1 from public.entities
                  where id = p_task_id and kind = 'task' and deleted_at is null)
     or internal.is_resolved(p_task_id)
     or not (
       exists (select 1 from public.edges a where a.src_id = p_task_id and a.type = 'assigned_to')
       or exists (select 1 from public.edges w
                    join public.work_sessions ws on ws.entity_id = w.src_id
                   where w.dst_id = p_task_id and w.type = 'working_on' and (w.props->>'endedAt') is null
                     and ws.status in ('spawning', 'running', 'idle'))
     ) then
    return 0;
  end if;
  for dep in
    select e.id, e.space_id, e.dst_id, e.created_by,
           coalesce(nullif(btrim(t.title), ''), b.kind) as blocker
      from public.edges e
      join public.entities b on b.id = e.dst_id
      left join public.tasks t on t.entity_id = e.dst_id
     where e.src_id = p_task_id and e.type = 'depends_on'
       and coalesce((e.props ->> 'hard')::boolean, true)
       and not internal.is_resolved(e.dst_id)
  loop
    -- A blocker completing concurrently (T1) holds its entities row until it
    -- commits. Wait on that row, then re-read in a NEW statement -- a fresh READ
    -- COMMITTED snapshot -- so this raise cannot land after T1's clear ran for
    -- a blocker that is by then resolved. (If this raise commits first, T1's
    -- clear runs later and sees it.)
    perform 1 from public.entities where id = dep.dst_id for share;
    continue when internal.is_resolved(dep.dst_id);
    perform internal.raise_attention_signal(
      dep.space_id, p_task_id, 'depends_on:' || dep.id, 'Blocked by: ' || dep.blocker,
      'normal', 'unblock', coalesce(internal.actor_id(), dep.created_by));
    raised := raised + 1;
  end loop;
  return raised;
end
$function$;

CREATE OR REPLACE FUNCTION internal.story_tally(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'internal', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'work',       count(*) filter (where e.status_category in ('to_do', 'in_progress', 'done')),
    'done',       count(*) filter (where e.status_category = 'done'),
    'inProgress', count(*) filter (where e.status_category = 'in_progress' and not b.blocked),
    'toDo',       count(*) filter (where e.status_category = 'to_do' and not b.blocked),
    'blocked',    count(*) filter (where e.status_category in ('to_do', 'in_progress') and b.blocked),
    'cancelled',  count(*) filter (where e.status_category = 'cancelled'),
    'staleInProgress', count(*) filter (
      where e.kind = 'task' and e.status_category = 'in_progress' and not b.blocked
        and not exists (
          select 1 from public.edges w
          join public.entities se on se.id = w.src_id
            and se.kind = 'work_session' and se.deleted_at is null
          join public.work_sessions ws on ws.entity_id = se.id
          where w.dst_id = e.id and w.type = 'working_on' and (w.props->>'endedAt') is null
            and ws.status in ('spawning', 'running', 'idle'))))
  from public.entities e
  left join public.tasks t on t.entity_id = e.id
  cross join lateral (select coalesce(t.work_status = 'blocked', false) or exists (
    select 1 from public.edges dep
    where dep.src_id = e.id and dep.type = 'depends_on'
      and coalesce((dep.props ->> 'hard')::boolean, true)
      and not internal.is_resolved(dep.dst_id)) as blocked) b
  where e.id = any(coalesce(p_ids, '{}'::uuid[])) and e.deleted_at is null
$function$;

-- ---------------------------------------------------------------------------
-- 4. Category: outcome first, then process (spec §3.2)
-- ---------------------------------------------------------------------------

create or replace function internal.session_category(p_outcome text, p_status text)
returns text language sql immutable
set search_path = public, internal, pg_temp as $$
  select case
    when p_outcome = 'completed' then 'done'
    when p_outcome = 'stopped'   then 'cancelled'
    when p_status = 'spawning'   then 'to_do'
    when p_status in ('running', 'idle', 'exited', 'failed') then 'in_progress'
  end
$$;

-- The 2-arg form is kept for its callers and now answers for an OPEN session:
-- every ending of unfinished work is in_progress (extends 174 to all endings).
create or replace function internal.session_status_category(p_status text, p_ended_kind text)
returns text language sql immutable
set search_path = public, internal, pg_temp as $$
  select internal.session_category('open', p_status)
$$;

create or replace function internal.workflow_state_for_session(p_entity_id uuid, p_outcome text, p_status text)
returns uuid language plpgsql stable
set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  wf_id uuid;
  category text := internal.session_category(p_outcome, p_status);
begin
  if category is null then return null; end if;
  select * into e from public.entities where id = p_entity_id;
  if e.id is null then return null; end if;
  wf_id := internal.workflow_for_entity(e.space_id, e.kind, null);
  if wf_id is null then return null; end if;
  return internal.find_workflow_state_for_category(wf_id, category);
end
$$;

create or replace function internal.bridge_session_status_to_state()
returns trigger language plpgsql
set search_path = public, internal, pg_temp as $$
declare
  category       text := internal.session_category(new.outcome, new.status);
  resolved_state uuid := internal.workflow_state_for_session(new.entity_id, new.outcome, new.status);
  current_cat    text;
begin
  select e.status_category into current_cat from public.entities e where e.id = new.entity_id;

  -- A move the workflow forbids is declined rather than raised: the process
  -- writer must never fail because of where the row is filed.
  if category is not null and current_cat is not null
     and not internal.category_transition_allowed(current_cat, category) then
    return new;
  end if;

  if resolved_state is not null then
    update public.entities set status_id = resolved_state
     where id = new.entity_id and status_id is distinct from resolved_state;
    return new;
  end if;
  if category is not null then
    update public.entities set status_category = category
     where id = new.entity_id and status_category is distinct from category;
  end if;
  return new;
end
$$;

drop trigger if exists work_sessions_category_bridge on public.work_sessions;
create trigger work_sessions_category_bridge
  after insert or update of status, ended_kind, outcome on public.work_sessions
  for each row execute function internal.bridge_session_status_to_state();

-- ---------------------------------------------------------------------------
-- 5. Outcome single writer + the two session events
-- ---------------------------------------------------------------------------

create or replace function internal.guard_work_session_outcome()
returns trigger language plpgsql
set search_path = public, internal, pg_temp as $$
begin
  if new.outcome is not distinct from old.outcome
     and new.outcome_at is not distinct from old.outcome_at
     and new.outcome_by is not distinct from old.outcome_by
     and new.receipt_message_id is not distinct from old.receipt_message_id
     and new.outcome_source is not distinct from old.outcome_source
     and new.outcome_note is not distinct from old.outcome_note then
    return new;
  end if;
  if coalesce(internal.claim_text('tm8.work_session_outcome'), '') <> 'on' then
    raise exception 'work_session.outcome has a single writer: session complete / stop / resume'
      using errcode = '23514', detail = 'Spec D1 §3: process events never write the outcome';
  end if;
  if old.outcome = 'completed' and new.outcome <> 'completed' then
    raise exception 'a completed session cannot be reopened'
      using errcode = '23514', detail = '{"reason":"session_completed"}';
  end if;
  return new;
end
$$;

drop trigger if exists work_sessions_guard_outcome on public.work_sessions;
create trigger work_sessions_guard_outcome
  before update on public.work_sessions
  for each row execute function internal.guard_work_session_outcome();

create or replace function internal.emit_work_session_events()
returns trigger language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  space uuid;
begin
  select e.space_id into space from public.entities e where e.id = new.entity_id;
  if space is null then return new; end if;
  if new.status is distinct from old.status then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (space, internal.next_event_seq(space), 'session.process_changed',
            jsonb_build_object('id', new.entity_id, 'from', old.status, 'to', new.status,
                               'endedKind', new.ended_kind, 'endedReason', new.ended_reason,
                               'outcome', new.outcome, 'at', now()),
            internal.claim_cmid());
  end if;
  if new.outcome is distinct from old.outcome then
    insert into public.workspace_events(space_id, seq, event_type, payload, client_mutation_id)
    values (space, internal.next_event_seq(space), 'session.outcome_changed',
            jsonb_build_object('id', new.entity_id, 'from', old.outcome, 'to', new.outcome,
                               'outcomeBy', new.outcome_by, 'receiptMessageId', new.receipt_message_id,
                               'outcomeSource', new.outcome_source, 'status', new.status, 'at', now()),
            internal.claim_cmid());
  end if;
  return new;
end
$$;

drop trigger if exists work_sessions_emit_events on public.work_sessions;
create trigger work_sessions_emit_events
  after update of status, outcome on public.work_sessions
  for each row execute function internal.emit_work_session_events();

-- ---------------------------------------------------------------------------
-- 6. The process writer accepts the new end kinds
-- ---------------------------------------------------------------------------

create or replace function public.work_session_transition(
  p_session_id uuid, p_status text, p_exit_code integer default null, p_error text default null,
  p_transcript_doc_id uuid default null, p_client_mutation_id text default null,
  p_ended_kind text default null, p_ended_reason text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  current_status text;
  allowed boolean;
  v_kind text := p_ended_kind;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.transition');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_status not in ('spawning','running','idle','exited','failed') then
    raise exception 'invalid work_session status: %', p_status using errcode = '22023';
  end if;
  -- 299: `completed` is the pre-299 spelling of `exited_clean`. Accepted so a
  -- server older than this migration keeps working during a deploy.
  if v_kind = 'completed' then v_kind := 'exited_clean'; end if;
  if v_kind is not null and v_kind not in (
       'exited_clean','stopped_by_operator','server_restart',
       'out_of_memory','crashed','unknown',
       'container_stopped','runtime_lost','lost','credential_revoked') then
    raise exception 'invalid work_session ended_kind: %', p_ended_kind using errcode = '22023';
  end if;

  select status into current_status from public.work_sessions where entity_id = p_session_id for update;
  allowed := case
    when current_status = p_status then true
    when current_status in ('exited','failed') then false
    when p_status = 'spawning' then false
    else true end;
  if not allowed then
    raise exception 'illegal work_session transition % -> %', current_status, p_status
      using errcode = '23514';
  end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = p_status,
         exit_code = coalesce(p_exit_code, exit_code),
         error = coalesce(p_error, error),
         transcript_doc_id = coalesce(p_transcript_doc_id, transcript_doc_id),
         ended_kind = case when p_status in ('exited','failed')
                           then coalesce(v_kind, ended_kind) else ended_kind end,
         ended_reason = case when p_status in ('exited','failed')
                             then coalesce(p_ended_reason, ended_reason) else ended_reason end,
         started_at = case when p_status = 'running' then coalesce(started_at, now()) else started_at end,
         exited_at = case when p_status in ('exited','failed') then coalesce(exited_at, now()) else exited_at end
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;

  return internal.ledger_record(p_client_mutation_id, 'execution.transition',
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Concurrency limit: a completed session is spare capacity (spec §5.3)
-- ---------------------------------------------------------------------------

create or replace function internal.live_work_session_count(target_space uuid default null)
returns integer language sql stable
set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.status in ('spawning','running','idle')
     and ws.outcome <> 'completed'
     and ws.session_kind = 'agent'
     and e.deleted_at is null
     and (target_space is null or e.space_id = target_space)
$$;

-- ---------------------------------------------------------------------------
-- 8. Complete / stop / release
-- ---------------------------------------------------------------------------

-- Where a session's close-out may live: the session itself and every task it
-- has claimed (active or ended).
create or replace function internal.session_anchor_ids(p_session_id uuid)
returns uuid[] language sql stable
set search_path = public, internal, pg_temp as $$
  select array[p_session_id] || coalesce(array_agg(distinct ed.dst_id), '{}')
    from public.edges ed
   where ed.src_id = p_session_id and ed.type = 'working_on'
$$;

-- EVERYTHING `session complete` refuses on, as one list (spec §6.3 R6). D2 adds
-- its child-session rows here. Each row: {reason, taskId, title, status}.
create or replace function internal.session_completion_blockers(p_session_id uuid)
returns jsonb language sql stable
set search_path = public, internal, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'reason', 'claim_open',
           'taskId', ed.dst_id,
           'title', coalesce(t.title, ''),
           'status', coalesce(t.work_status, ed.props->>'status'),
           'claimStatus', ed.props->>'status')
           order by ed.created_at), '[]'::jsonb)
    from public.edges ed
    left join public.tasks t on t.entity_id = ed.dst_id
   where ed.src_id = p_session_id and ed.type = 'working_on'
     and (ed.props->>'endedAt') is null
     and coalesce(ed.props->>'status', 'working') not in ('in_review', 'blocked')
     and coalesce(t.work_status, 'working') not in ('in_review', 'blocked', 'done', 'cancelled')
$$;

-- The receipt rule (spec §4.1): an explicit receipt must sit on one of the
-- session's anchors; otherwise the latest message the session (or its
-- teammate) wrote on one of them since the session began.
create or replace function internal.resolve_session_receipt(p_session_id uuid, p_receipt uuid)
returns uuid language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  anchors uuid[] := internal.session_anchor_ids(p_session_id);
  born timestamptz;
  found uuid;
begin
  if p_receipt is not null then
    select m.entity_id into found
      from public.messages m join public.entities me on me.id = m.entity_id
     where m.entity_id = p_receipt and m.anchor_id = any(anchors) and me.deleted_at is null;
    if found is null then
      raise exception 'the receipt must be a message on the session''s anchor'
        using errcode = '23514',
              detail = jsonb_build_object('reason', 'receipt_not_on_anchor',
                                          'anchorIds', to_jsonb(anchors))::text;
    end if;
    return found;
  end if;
  select e.created_at into born from public.entities e where e.id = p_session_id;
  select m.entity_id into found
    from public.messages m join public.entities me on me.id = m.entity_id
   where m.anchor_id = any(anchors)
     and me.deleted_at is null and m.redacted_at is null
     and m.created_at >= born
     and (m.author_id = p_session_id or m.author_id in (
           select r.dst_id from public.edges r where r.src_id = p_session_id and r.type = 'relates_to'))
   order by m.created_at desc, m.entity_id desc
   limit 1;
  if found is null then
    raise exception 'session complete needs a close-out message (the receipt) on the session''s anchor'
      using errcode = '23514',
            detail = jsonb_build_object('reason', 'receipt_required',
                                        'anchorIds', to_jsonb(anchors))::text;
  end if;
  return found;
end
$$;

-- self when the caller IS this session, operator otherwise.
create or replace function internal.outcome_source_for(p_session_id uuid, p_space_id uuid)
returns text language sql stable
set search_path = public, internal, pg_temp as $$
  select case when internal.caller_work_session(p_space_id) = p_session_id then 'self' else 'operator' end
$$;

create or replace function internal.complete_work_session_core(
  p_session_id uuid, p_receipt uuid, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  e public.entities;
  ws public.work_sessions;
  blockers jsonb;
  receipt uuid;
  ids uuid[];
  ended integer;
begin
  select * into e from public.entities where id = p_session_id;
  select * into ws from public.work_sessions where entity_id = p_session_id for update;
  if ws.outcome = 'completed' then
    -- Idempotent: a retried close-out is not an error.
    return jsonb_build_object('outcome', 'completed', 'receiptMessageId', ws.receipt_message_id,
                              'endedClaims', 0, 'alreadyCompleted', true);
  end if;
  if ws.outcome = 'stopped' then
    raise exception 'a stopped session must be resumed before it can complete'
      using errcode = '23514', detail = '{"reason":"session_stopped"}';
  end if;

  blockers := internal.session_completion_blockers(p_session_id);
  if jsonb_array_length(blockers) > 0 then
    raise exception 'session has claims still in progress: finish them, move them to in_review/blocked, or release them with a note'
      using errcode = '23514',
            detail = jsonb_build_object('reason', 'claims_open', 'tasks', blockers)::text;
  end if;
  receipt := internal.resolve_session_receipt(p_session_id, p_receipt);

  select coalesce(array_agg(ed.id), '{}') into ids
    from public.edges ed
   where ed.src_id = p_session_id and ed.type = 'working_on' and (ed.props->>'endedAt') is null;
  ended := internal.end_claims(ids, 'session_completed', null, receipt);

  perform set_config('tm8.work_session_outcome', 'on', true);
  update public.work_sessions
     set outcome = 'completed', outcome_at = now(), outcome_by = p_actor,
         receipt_message_id = receipt,
         outcome_source = internal.outcome_source_for(p_session_id, e.space_id),
         outcome_note = null
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_outcome', 'off', true);

  update public.entities set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;
  return jsonb_build_object('outcome', 'completed', 'receiptMessageId', receipt,
                            'endedClaims', ended, 'alreadyCompleted', false);
end
$$;

create or replace function internal.stop_work_session_core(
  p_session_id uuid, p_actor uuid, p_note text, p_source text default 'operator')
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  ws public.work_sessions;
  ids uuid[];
  ended integer;
begin
  select * into ws from public.work_sessions where entity_id = p_session_id for update;
  if ws.outcome = 'completed' then
    raise exception 'a completed session cannot be stopped; close its process instead'
      using errcode = '23514', detail = '{"reason":"session_completed"}';
  end if;
  if ws.outcome = 'stopped' then
    return jsonb_build_object('outcome', 'stopped', 'endedClaims', 0, 'alreadyStopped', true);
  end if;
  select coalesce(array_agg(ed.id), '{}') into ids
    from public.edges ed
   where ed.src_id = p_session_id and ed.type = 'working_on' and (ed.props->>'endedAt') is null;
  ended := internal.end_claims(ids, 'session_stopped', p_note);

  perform set_config('tm8.work_session_outcome', 'on', true);
  update public.work_sessions
     set outcome = 'stopped', outcome_at = now(), outcome_by = p_actor,
         outcome_source = p_source, outcome_note = nullif(btrim(coalesce(p_note, '')), '')
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_outcome', 'off', true);

  update public.entities set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;
  return jsonb_build_object('outcome', 'stopped', 'endedClaims', ended, 'alreadyStopped', false);
end
$$;

create or replace function public.complete_work_session(
  p_session_id uuid, p_receipt_message_id uuid default null,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  res jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.complete');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  res := internal.complete_work_session_core(p_session_id, p_receipt_message_id, actor);
  return internal.ledger_record(p_client_mutation_id, 'execution.complete',
           internal.command_result(p_session_id, null,
             case when (res->>'alreadyCompleted')::boolean then null else
               internal.record_activity(e.space_id, p_session_id, actor, 'completed', null,
                 jsonb_build_object('kind', 'work_session', 'action', 'session_completed',
                                    'receiptMessageId', res->'receiptMessageId',
                                    'endedClaims', res->'endedClaims', 'processEnded', false)) end,
             array[p_session_id]) || jsonb_build_object('outcome', res));
end
$$;

create or replace function public.stop_work_session(
  p_session_id uuid, p_note text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  res jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.stop');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  res := internal.stop_work_session_core(p_session_id, actor, p_note, 'operator');
  return internal.ledger_record(p_client_mutation_id, 'execution.stop',
           internal.command_result(p_session_id, null,
             case when (res->>'alreadyStopped')::boolean then null else
               internal.record_activity(e.space_id, p_session_id, actor, 'updated', null,
                 jsonb_build_object('kind', 'work_session', 'action', 'session_stopped',
                                    'note', p_note, 'endedClaims', res->'endedClaims')) end,
             array[p_session_id]) || jsonb_build_object('outcome', res));
end
$$;

-- `tm8 task release <id> --note` (spec R4): end the caller's claim, keep the
-- task's status. The note is the hand-off.
create or replace function public.release_task_claim(
  p_task_id uuid, p_note text,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  claimant uuid;
  ids uuid[];
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.release');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_task_id, 'task');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'a release needs a hand-off note' using errcode = '22023',
      detail = '{"reason":"note_required"}';
  end if;
  claimant := coalesce(internal.caller_work_session(e.space_id), actor);
  select coalesce(array_agg(ed.id), '{}') into ids
    from public.edges ed
   where ed.src_id = claimant and ed.dst_id = p_task_id and ed.type = 'working_on'
     and (ed.props->>'endedAt') is null;
  if cardinality(ids) = 0 then
    raise exception 'you hold no active claim on this task' using errcode = '23514',
      detail = '{"reason":"no_claim"}';
  end if;
  perform internal.end_claims(ids, 'released', btrim(p_note));
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.release',
           internal.command_result(p_task_id, ids[1],
             internal.record_activity(e.space_id, p_task_id, actor, 'work.changed', ids[1],
               jsonb_build_object('action', 'released', 'note', btrim(p_note),
                                  'claimantId', claimant)),
             array[p_task_id]));
end
$$;

-- The row tick (`entities.commands.complete` on a session) IS session complete
-- now: it needs the receipt and passes the claim check, and it is no longer a
-- toggle — a completed session cannot be un-ticked (Q2 A).
create or replace function public.set_session_done(
  p_entity_id uuid, p_expected_version integer,
  p_actor_id uuid default null, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  ws public.work_sessions;
  res jsonb;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.commands.complete');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_entity_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);
  select * into ws from public.work_sessions where entity_id = p_entity_id;
  if ws.outcome = 'completed' then
    raise exception 'a completed session cannot be reopened; start a follow-up session'
      using errcode = '23514', detail = '{"reason":"session_completed"}';
  end if;
  res := internal.complete_work_session_core(p_entity_id, null, actor);
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.complete',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'completed', null,
               jsonb_build_object('kind', 'work_session', 'action', 'session_completed',
                                  'receiptMessageId', res->'receiptMessageId',
                                  'endedClaims', res->'endedClaims',
                                  'sessionStatus', ws.status, 'processEnded', false))));
end
$$;

-- ---------------------------------------------------------------------------
-- 9. set_work_state: the session is the claimant; claims end via the trigger
-- ---------------------------------------------------------------------------

create or replace function public.set_work_state(
  p_task_id uuid, p_status text, p_actor_id uuid default null,
  p_started_at timestamptz default null, p_note text default null,
  p_client_mutation_id text default null, p_clear_note boolean default false,
  p_claim boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  claimant uuid;
  edge_id uuid;
  holds_edge boolean;
  v_outcome text;
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
  if internal.work_status_target_category(p_task_id, p_status) = 'done' then
    raise exception 'completion goes through complete_task'
      using errcode = '23514', detail = '{"reason":"use_complete_command"}';
  end if;

  -- 299: inside an agent session the claim is the SESSION's.
  claimant := coalesce(internal.caller_work_session(e.space_id), actor);

  if coalesce(p_claim, false) then
    select ws.outcome into v_outcome from public.work_sessions ws where ws.entity_id = claimant;
    if v_outcome = 'completed' then
      raise exception 'a completed session cannot claim work; start a follow-up session'
        using errcode = '23514', detail = '{"reason":"session_completed"}';
    end if;
  end if;

  holds_edge := coalesce(p_claim, false) or exists (
    select 1 from public.edges
     where src_id = claimant and dst_id = p_task_id and type = 'working_on'
       and (props->>'endedAt') is null);

  if not holds_edge and (p_note is not null or p_started_at is not null) then
    raise exception 'note and startedAt are recorded on the working_on edge; pass claim to record them'
      using errcode = '22023', detail = '{"reason":"claim_required"}';
  end if;

  if holds_edge and p_status not in ('open', 'cancelled') then
    insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
    values (e.space_id, claimant, p_task_id, 'working_on',
            jsonb_build_object(
              'status', internal.claim_status_for(p_status),
              'startedAt', coalesce(p_started_at, now()),
              'note', case when p_clear_note then null else p_note end),
            actor)
    on conflict (src_id, dst_id, type) do update
      -- An ENDED claim taken again is a new claim: fresh props, no end facts.
      -- An active one merges `note` as 037 did.
      set props = case
            when (edges.props->>'endedAt') is not null then jsonb_build_object(
              'status', internal.claim_status_for(p_status),
              'startedAt', coalesce(p_started_at, now()),
              'note', case when p_clear_note then null else p_note end)
            else jsonb_build_object(
              'status', internal.claim_status_for(p_status),
              'startedAt', coalesce(p_started_at, (edges.props->>'startedAt')::timestamptz, now()),
              'note', case when p_clear_note then null
                           else coalesce(p_note, edges.props->>'note') end)
          end,
          updated_at = now()
    returning id into edge_id;
  end if;

  -- open/cancelled: the claims_follow_task_status trigger ends every claim.
  update public.tasks set work_status = p_status, updated_at = now() where entity_id = p_task_id;
  return internal.ledger_record(p_client_mutation_id, 'entities.commands.work',
           internal.command_result(p_task_id, edge_id,
             internal.record_activity(e.space_id, p_task_id, actor, 'work.changed', edge_id,
               jsonb_build_object('status', p_status)), array[p_task_id]));
end
$$;

-- ---------------------------------------------------------------------------
-- 10. Resume: refused once completed; a stopped session reopens (logged)
-- ---------------------------------------------------------------------------

create or replace function public.execution_resume(
  p_session_id uuid, p_session_cap integer default 8, p_actor_id uuid default null,
  p_client_mutation_id text default null, p_node_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  member_id uuid;
  current_status text;
  current_outcome text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.resume');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_session_id::text, 'work session');
    return replay || jsonb_build_object('__tm8_replayed', true);
  end if;

  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  select dst_id into member_id
    from public.edges
   where src_id = p_session_id and type = 'relates_to'
   limit 1;
  if member_id is not null and not internal.can_act_as(member_id, e.space_id) then
    raise exception 'not permitted to resume this persona' using errcode = '42501';
  end if;

  select status, outcome into current_status, current_outcome
    from public.work_sessions where entity_id = p_session_id for update;
  -- 299 (spec §3 rule 5, Q2 A): one session is one piece of work with one receipt.
  if current_outcome = 'completed' then
    raise exception 'a completed session cannot be resumed; start a follow-up session'
      using errcode = '23514', detail = '{"reason":"session_completed"}';
  end if;
  if current_status not in ('exited', 'failed') then
    raise exception 'work session is not resumable from status %', current_status
      using errcode = '23514';
  end if;

  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_session_cap,
                                  'live', internal.live_work_session_count(null))::text;
  end if;

  -- 299: resume reopens stopped work. The activity row below records it.
  if current_outcome = 'stopped' then
    perform set_config('tm8.work_session_outcome', 'on', true);
    update public.work_sessions
       set outcome = 'open', outcome_at = null, outcome_by = null,
           outcome_source = null, outcome_note = null
     where entity_id = p_session_id;
    perform set_config('tm8.work_session_outcome', 'off', true);
  end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = 'spawning', exit_code = null, error = null, exited_at = null,
         node_id = coalesce(p_node_id, node_id)
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;

  return internal.ledger_record(p_client_mutation_id, 'execution.resume',
           internal.command_result(p_session_id, null,
             internal.record_activity(e.space_id, p_session_id, actor, 'restored', null,
               jsonb_build_object('kind', 'work_session', 'action', 'resumed',
                                  'fromStatus', current_status,
                                  'fromOutcome', current_outcome,
                                  'reopened', current_outcome = 'stopped')),
             array[p_session_id])) || jsonb_build_object('__tm8_replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- 11. Backfill (spec §8)
-- ---------------------------------------------------------------------------

-- 11a. Renames and reclassifications of process facts.
update public.work_sessions set ended_kind = 'exited_clean' where ended_kind = 'completed';
update public.work_sessions
   set ended_kind = 'credential_revoked'
 where ended_kind = 'stopped_by_operator'
   and ended_reason like 'Stopped because the %credential it was running on%';

-- 11b. Outcomes. Order matters: the claim test reads the claims before 11c ends them.
do $backfill$
declare
  r record;
  v_outcome text;
  anchors uuid[];
  member uuid;
  closed_out boolean;
  claims_settled boolean;
begin
  perform set_config('tm8.work_session_outcome', 'on', true);
  for r in
    select ws.entity_id, ws.status, ws.ended_kind, ws.exited_at, e.status_category, e.created_at
      from public.work_sessions ws join public.entities e on e.id = ws.entity_id
  loop
    v_outcome := 'open';
    if r.status in ('spawning', 'running', 'idle') then
      -- A live session an operator already ticked to Done was completed by them.
      if r.status_category = 'done' then v_outcome := 'completed'; end if;
    elsif r.ended_kind in ('stopped_by_operator', 'exited_clean') then
      anchors := internal.session_anchor_ids(r.entity_id);
      select dst_id into member from public.edges
       where src_id = r.entity_id and type = 'relates_to' limit 1;
      select exists (
        select 1 from public.messages m
         where m.anchor_id = any(anchors)
           and (m.author_id = r.entity_id or m.author_id = member)
           and m.created_at between coalesce(r.exited_at, now()) - interval '30 minutes'
                                and coalesce(r.exited_at, now()) + interval '1 minute'
      ) into closed_out;
      select not exists (
        select 1 from public.edges ed join public.tasks t on t.entity_id = ed.dst_id
         where ed.src_id = r.entity_id and ed.type = 'working_on'
           and t.work_status not in ('done', 'in_review')
      ) into claims_settled;
      v_outcome := case when closed_out and claims_settled then 'completed' else 'stopped' end;
    elsif r.status_category = 'done' then
      -- Ticked done by an operator after another kind of ending.
      v_outcome := 'completed';
    elsif coalesce(r.exited_at, r.created_at) < now() - interval '7 days' then
      -- Spec §5.3.1 case 5: old crashes must not flood Interrupted.
      v_outcome := 'stopped';
    end if;

    if v_outcome <> 'open' then
      update public.work_sessions
         set outcome = v_outcome,
             outcome_at = coalesce(exited_at, now()),
             outcome_source = 'backfill'
       where entity_id = r.entity_id;
    end if;
  end loop;
  perform set_config('tm8.work_session_outcome', 'off', true);
end
$backfill$;

-- 11c. Every historical claim ends (already decided).
update public.edges ed
   set props = ed.props || jsonb_build_object(
         'endedAt', to_jsonb(coalesce(
           (select ws.exited_at from public.work_sessions ws
             where ws.entity_id = ed.src_id and ws.status in ('exited', 'failed')), now())),
         'endReason', 'backfill')
 where ed.type = 'working_on' and (ed.props->>'endedAt') is null;

-- 11d. Re-file every session by the §3.2 table. Clearing status_id first makes
-- the second write an adoption, not a transition (validate_status_transition),
-- so a row the old rules filed somewhere the new table never would — a
-- crashed session under Done — moves without tripping the category rules.
do $refile$
declare
  r record;
  target uuid;
  cat text;
begin
  for r in
    select ws.entity_id, ws.outcome, ws.status, e.status_id, e.status_category
      from public.work_sessions ws join public.entities e on e.id = ws.entity_id
  loop
    cat := internal.session_category(r.outcome, r.status);
    if cat is null or cat = r.status_category then continue; end if;
    target := internal.workflow_state_for_session(r.entity_id, r.outcome, r.status);
    if target is not null then
      update public.entities set status_id = null where id = r.entity_id;
      update public.entities set status_id = target where id = r.entity_id;
    else
      update public.entities set status_category = cat where id = r.entity_id;
    end if;
  end loop;
end
$refile$;

-- ---------------------------------------------------------------------------
-- 12. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.complete_work_session(uuid, uuid, uuid, text) from public;
revoke all on function public.stop_work_session(uuid, text, uuid, text) from public;
revoke all on function public.release_task_claim(uuid, text, uuid, text) from public;
grant execute on function public.complete_work_session(uuid, uuid, uuid, text) to tm8_app;
grant execute on function public.stop_work_session(uuid, text, uuid, text) to tm8_app;
grant execute on function public.release_task_claim(uuid, text, uuid, text) to tm8_app;

comment on function public.complete_work_session(uuid, uuid, uuid, text) is
  'Spec D1 §4.1: outcome -> completed. Claim check (claims_open), receipt rule (receipt_required), '
  'ends remaining claims with session_completed. Never touches the process.';
comment on function public.stop_work_session(uuid, text, uuid, text) is
  'Spec D1 §4.2: operator stops without completing. outcome -> stopped, claims end with session_stopped.';
comment on function public.release_task_claim(uuid, text, uuid, text) is
  'Spec D1 R4: end the caller''s claim on a task with a hand-off note; the task keeps its status.';

