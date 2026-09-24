-- =============================================================================
-- 207  TASK-KEYED SESSION NUDGES, and the first loop that uses them: task_state.
--
-- Spec: doc 01a0cf2f (prompt v2.0) §4 and §6.1 #11, decision Q16.
--
-- 103 gave the forge loops a durable dedup (§J) and an outbox (§K), and both
-- are keyed on a PULL REQUEST: `pending_session_nudges.pr_entity_id` is NOT
-- NULL and `loop_kind` is CHECKed to ci_failure|merge_conflict|review_thread.
-- The prompt-v2 loops are about a TASK and a SESSION, with no pull request in
-- sight, and their dedup rule is coarser than §J's content signature: each one
-- fires ONCE per (session, task, loop), ever. So this file adds a sibling pair
-- rather than bending 103's tables around a second key.
--
--   A. `session_task_nudges` — THE LEDGER. One row per (session, task, loop)
--      that has fired, with its firing timestamp (Q20: "timestamp the
--      nudges"). The primary key IS the dedup rule; a restart cannot re-send
--      because the answer lives in Postgres, not in a Map.
--
--   B. `internal.claim_task_nudge` — THE SEAM. Claims the ledger row, or
--      reports that it was already claimed. Every loop in §4 — closure,
--      exit_without_receipt, delegation_audit (S3) and task_state (here) —
--      claims through this one function, so "once per (session, task, loop)"
--      is stated in exactly one place.
--
--   C. `pending_task_nudges` — THE OUTBOX, for loops whose trigger is a DB
--      write. Detection writes a row in the same transaction as the fact
--      (103 §K's rule: a transition must not be consumed by being observed),
--      carrying the facts the TypeScript DECISION needs. Nothing here decides
--      whether to nudge; see packages/server/src/tracking/task-nudges.ts.
--
--   D. task_state DETECTION — two AFTER triggers:
--        * tasks.work_status moves INTO done or cancelled;
--        * an `assigned_to` edge from a task to a teammate is deleted.
--      Each enqueues one row per LIVE AGENT session that is `working_on` the
--      task (for an unassignment: only sessions of the unassigned teammate),
--      recording the acting actor and the session's teammate so the decision
--      can suppress a session's own transition.
--
--   E. The doors: claim (drain read), post (claim + send + settle in ONE
--      transaction, 103 §K4's shape), retire (the decision declined).
--
-- WHAT IS DELIBERATELY NOT HERE. closure, exit_without_receipt and
-- delegation_audit are admitted by the ledger's CHECK so S3 needs no schema
-- change to claim them, but nothing detects or sends them yet.
--
-- SECURITY PROPERTIES carried over from 103/148, each load-bearing:
--   * The addressee is resolved IN SQL from edges in the task's own Space, and
--     re-checked at send time (live, agent, same Space). A security-definer
--     caller must never be handed a session from somewhere else (148).
--   * Credential terminals are not addressees (`internal.is_agent_session`,
--     103 F0).
--   * The send goes through 019's `w2_post_message_batch`, never the revoked
--     raw door, so the delivery intent is minted (103 K4).
--   * The body is built by the server from ids and a status enum. There is no
--     third-party text in a task_state nudge, so there is nothing to fence.
--   * Detection can never fail the write it observes: a task transition or an
--     unassignment that could be rolled back by a nudge bug is a far worse
--     outcome than a missed nudge. The enqueue is guarded and WARNs instead.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- A. The ledger.
-- -----------------------------------------------------------------------------
create table if not exists public.session_task_nudges (
  space_id        uuid not null references public.spaces(id) on delete cascade,
  work_session_id uuid not null references public.entities(id) on delete cascade,
  task_id         uuid not null references public.entities(id) on delete cascade,
  loop_kind       text not null check (loop_kind in (
                    'closure', 'exit_without_receipt', 'delegation_audit', 'task_state')),
  fired_at        timestamptz not null default now(),
  -- The message the firing produced, when the loop's action is a message.
  -- NULL for an action that is not one (S3's attention and notes).
  message_id      uuid,
  -- Why it fired, for the Q21 rates; never read by the dedup.
  detail          jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  primary key (space_id, work_session_id, task_id, loop_kind)
);
create index if not exists session_task_nudges_task_idx
  on public.session_task_nudges(task_id, loop_kind);
create index if not exists session_task_nudges_fired_idx
  on public.session_task_nudges(loop_kind, fired_at);

comment on table public.session_task_nudges is
  'One row per (session, task, loop) that has fired (207 A). The key is the '
  'dedup: a loop fires once per session and task, and a restart cannot re-send.';

alter table public.session_task_nudges enable row level security;
revoke all on public.session_task_nudges from public;

-- -----------------------------------------------------------------------------
-- B. The seam. TRUE when this call made the claim, FALSE when the loop had
--    already fired for this (session, task). Callers hold the transaction that
--    performs the action, so a failed action rolls the claim back with it.
--
--    The advisory lock serialises two claimers of the same key so the loser
--    sees the winner's row instead of racing it into a unique violation.
-- -----------------------------------------------------------------------------
create or replace function internal.claim_task_nudge(
  p_space_id uuid, p_work_session_id uuid, p_task_id uuid, p_loop_kind text,
  p_detail jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare claimed integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    p_work_session_id::text || ':task-nudge:' || p_task_id::text || ':' || p_loop_kind, 0));
  insert into public.session_task_nudges(space_id, work_session_id, task_id, loop_kind, detail)
  values (p_space_id, p_work_session_id, p_task_id, p_loop_kind, coalesce(p_detail, '{}'::jsonb))
  on conflict (space_id, work_session_id, task_id, loop_kind) do nothing;
  get diagnostics claimed = row_count;
  return claimed = 1;
end
$$;

revoke all on function internal.claim_task_nudge(uuid, uuid, uuid, text, jsonb) from public;

-- -----------------------------------------------------------------------------
-- C. The outbox.
--
-- `cause` is WHAT happened (cancelled | completed | unassigned); `status` is
-- the task's work_status after it, which is what the message names. `actor_id`
-- is whoever made the write (internal.actor_id(): the claim, or acting-as), and
-- `teammate_id` is the session's own teammate (its `relates_to` team_member).
-- The decision compares the two; neither is trusted for addressing.
-- -----------------------------------------------------------------------------
create table if not exists public.pending_task_nudges (
  id              uuid primary key default internal.new_id(),
  space_id        uuid not null references public.spaces(id) on delete cascade,
  work_session_id uuid not null references public.entities(id) on delete cascade,
  task_id         uuid not null references public.entities(id) on delete cascade,
  loop_kind       text not null check (loop_kind in (
                    'closure', 'exit_without_receipt', 'delegation_audit', 'task_state')),
  cause           text not null check (cause in ('cancelled', 'completed', 'unassigned')),
  status          text,
  actor_id        uuid,
  teammate_id     uuid,
  detected_at     timestamptz not null default now(),
  state           text not null default 'pending'
                    check (state in ('pending', 'delivered', 'retired')),
  attempts        integer not null default 0,
  last_error      text,
  settled_at      timestamptz,
  retire_reason   text,
  message_id      uuid
);

-- One UNTOLD row per (session, task, loop). A second transition while the
-- first is still queued (cancel, then unassign) adds nothing: the ledger would
-- refuse the second send anyway, and the first row already says "stop".
create unique index if not exists pending_task_nudges_untold_idx
  on public.pending_task_nudges(work_session_id, task_id, loop_kind)
  where state = 'pending';
create index if not exists pending_task_nudges_pending_idx
  on public.pending_task_nudges(detected_at) where state = 'pending';

comment on table public.pending_task_nudges is
  'Detected-but-untold task transitions for a session (207 C). Written in the '
  'same transaction as the transition; decided in TypeScript; sent by '
  'post_task_nudge, which claims session_task_nudges in the same transaction.';

alter table public.pending_task_nudges enable row level security;
revoke all on public.pending_task_nudges from public;

-- -----------------------------------------------------------------------------
-- D. task_state detection.
-- -----------------------------------------------------------------------------

-- The enqueue both triggers share. `p_teammate_id` narrows to one teammate's
-- sessions (unassignment); NULL means every session working the task.
create or replace function internal.enqueue_task_state_nudges(
  p_task_id uuid, p_cause text, p_status text, p_teammate_id uuid
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  task_space uuid;
  acting uuid := internal.actor_id();
begin
  -- The task must still exist: an `assigned_to` edge is also deleted by the
  -- cascade from a task (or teammate) being hard-deleted, and the outbox's
  -- foreign key would then fail the delete. A deleted task is not a transition
  -- anybody needs to be told about.
  select e.space_id into task_space
    from public.entities e
   where e.id = p_task_id and e.kind = 'task' and e.deleted_at is null;
  if task_space is null then return; end if;

  insert into public.pending_task_nudges(
    space_id, work_session_id, task_id, loop_kind, cause, status, actor_id, teammate_id)
  select task_space, s.session_id, p_task_id, 'task_state', p_cause, p_status, acting, s.teammate_id
    from (
      select distinct on (se.id) se.id as session_id, tm.id as teammate_id
        from public.edges w
        join public.entities se
          on se.id = w.src_id and se.kind = 'work_session' and se.deleted_at is null
         -- Same Space as the task: the addressee never leaves it (148).
         and se.space_id = task_space
        join public.work_sessions ws on ws.entity_id = se.id
        left join public.edges r
          on r.src_id = se.id and r.type = 'relates_to'
        left join public.entities tm
          on tm.id = r.dst_id and tm.kind = 'team_member' and tm.space_id = task_space
       where w.dst_id = p_task_id and w.type = 'working_on'
         and ws.status in ('spawning', 'running', 'idle')
         and internal.is_agent_session(se.id)
       order by se.id, (tm.id is null), r.created_at
    ) s
   where p_teammate_id is null or s.teammate_id = p_teammate_id
  on conflict (work_session_id, task_id, loop_kind) where state = 'pending' do nothing;
end
$$;

revoke all on function internal.enqueue_task_state_nudges(uuid, text, text, uuid) from public;

create or replace function internal.task_state_nudge_on_status() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  begin
    perform internal.enqueue_task_state_nudges(
      new.entity_id,
      case new.work_status when 'cancelled' then 'cancelled' else 'completed' end,
      new.work_status,
      null);
  exception when others then
    -- Never fail the transition over a nudge (header, last bullet).
    raise warning 'task_state nudge enqueue failed for task %: % (%)',
      new.entity_id, sqlerrm, sqlstate;
  end;
  return null;
end
$$;

drop trigger if exists tasks_task_state_nudge on public.tasks;
create trigger tasks_task_state_nudge
after update of work_status on public.tasks
for each row
when (new.work_status is distinct from old.work_status
      and new.work_status in ('done', 'cancelled'))
execute function internal.task_state_nudge_on_status();

create or replace function internal.task_state_nudge_on_unassign() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  begin
    perform internal.enqueue_task_state_nudges(old.src_id, 'unassigned', null, old.dst_id);
  exception when others then
    raise warning 'task_state nudge enqueue failed for unassignment of task %: % (%)',
      old.src_id, sqlerrm, sqlstate;
  end;
  return null;
end
$$;

drop trigger if exists edges_task_state_nudge on public.edges;
create trigger edges_task_state_nudge
after delete on public.edges
for each row
when (old.type = 'assigned_to')
execute function internal.task_state_nudge_on_unassign();

-- -----------------------------------------------------------------------------
-- E1. The drain read. Every pending row is returned, WITH the session's current
--     status, because the decision (not SQL) owns "is this worth sending": a
--     row whose session has exited is retired by the decision, not left to rot.
--     Rows older than the age-out retire first, with a stated reason.
-- -----------------------------------------------------------------------------
create or replace function public.claim_pending_task_nudges(
  p_limit integer default 50, p_max_age_hours integer default 24
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_identity();

  update public.pending_task_nudges q
     set state = 'retired', settled_at = now(), retire_reason = 'expired'
   where q.state = 'pending'
     and internal.is_space_member(q.space_id)
     and q.detected_at < now() - make_interval(hours => greatest(coalesce(p_max_age_hours, 24), 1));

  select coalesce(jsonb_agg(t.payload order by t.detected_at), '[]'::jsonb) into result
    from (
      select q.detected_at,
        jsonb_build_object(
          'pendingId', q.id,
          'spaceId', q.space_id,
          'workSessionId', q.work_session_id,
          'taskId', q.task_id,
          'loopKind', q.loop_kind,
          'cause', q.cause,
          'status', q.status,
          'actorId', q.actor_id,
          'teammateId', q.teammate_id,
          'sessionStatus', ws.status,
          'attempts', q.attempts
        ) as payload
        from public.pending_task_nudges q
        left join public.work_sessions ws on ws.entity_id = q.work_session_id
       where q.state = 'pending'
         and internal.is_space_member(q.space_id)
       order by q.detected_at
       limit greatest(coalesce(p_limit, 50), 1)
    ) t;

  return jsonb_build_object('pending', result);
end
$$;

-- -----------------------------------------------------------------------------
-- E2. post_task_nudge — claim, send and settle in ONE transaction (103 K4).
--
--     Liveness and agent-ness are re-checked here rather than trusted from the
--     drain read: the session may have exited between the two. The ledger
--     claim comes after those checks, so a session that was not live is never
--     recorded as told.
-- -----------------------------------------------------------------------------
create or replace function public.post_task_nudge(
  p_pending_id uuid, p_body text, p_client_mutation_id text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  q public.pending_task_nudges;
  session_status text;
  session_space uuid;
  posted jsonb;
  new_message_id uuid;
begin
  perform internal.require_identity();
  select * into q from public.pending_task_nudges where id = p_pending_id for update;
  if not found then
    raise exception 'no pending task nudge %', p_pending_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(q.space_id);
  if q.state <> 'pending' then
    return jsonb_build_object('posted', false, 'reason', 'already_settled', 'state', q.state);
  end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'task nudge body is required' using errcode = '22023';
  end if;
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;

  select ws.status, se.space_id into session_status, session_space
    from public.work_sessions ws
    join public.entities se on se.id = ws.entity_id and se.deleted_at is null
   where ws.entity_id = q.work_session_id;
  if session_status is null or session_status not in ('spawning', 'running', 'idle')
     or session_space is distinct from q.space_id then
    update public.pending_task_nudges
       set state = 'retired', settled_at = now(), retire_reason = 'session_not_live'
     where id = p_pending_id;
    return jsonb_build_object('posted', false, 'reason', 'session_not_live',
                              'sessionStatus', session_status);
  end if;
  if not internal.is_agent_session(q.work_session_id) then
    update public.pending_task_nudges
       set state = 'retired', settled_at = now(), retire_reason = 'not_an_agent_session'
     where id = p_pending_id;
    return jsonb_build_object('posted', false, 'reason', 'not_an_agent_session');
  end if;

  if not internal.claim_task_nudge(
    q.space_id, q.work_session_id, q.task_id, q.loop_kind,
    jsonb_build_object('cause', q.cause, 'status', q.status, 'actorId', q.actor_id)
  ) then
    update public.pending_task_nudges
       set state = 'retired', settled_at = now(), retire_reason = 'duplicate'
     where id = p_pending_id;
    return jsonb_build_object('posted', false, 'reason', 'duplicate');
  end if;

  -- 019's door. If it raises, the claim above and the settlement below roll
  -- back with it and the row stays pending for the next tick.
  posted := public.w2_post_message_batch(
    array[q.work_session_id], p_body, null, '{}'::uuid[], '{}'::uuid[], null, null,
    p_client_mutation_id);
  new_message_id := (posted -> 'messageIds' ->> 0)::uuid;

  update public.session_task_nudges
     set message_id = new_message_id
   where space_id = q.space_id and work_session_id = q.work_session_id
     and task_id = q.task_id and loop_kind = q.loop_kind;

  update public.pending_task_nudges
     set state = 'delivered', settled_at = now(), message_id = new_message_id,
         attempts = attempts + 1
   where id = p_pending_id;

  return jsonb_build_object(
    'posted', true, 'messageId', new_message_id, 'workSessionId', q.work_session_id,
    'messageBatchId', posted ->> 'messageBatchId');
end
$$;

-- -----------------------------------------------------------------------------
-- E3. The decision declined. Unlike 103's stacked-PR suppression, which is a
--     statement about right now, a task_state suppression (the session's own
--     transition, a session that is no longer live) is final, so the row is
--     settled with the reason rather than left queued. `p_error` instead of a
--     reason records a failed attempt and leaves the row pending.
-- -----------------------------------------------------------------------------
create or replace function public.settle_pending_task_nudge(
  p_pending_id uuid, p_retire_reason text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare q public.pending_task_nudges;
begin
  perform internal.require_identity();
  select * into q from public.pending_task_nudges where id = p_pending_id for update;
  if not found then
    raise exception 'no pending task nudge %', p_pending_id using errcode = 'P0002';
  end if;
  perform internal.require_space_member(q.space_id);
  if nullif(btrim(coalesce(p_retire_reason, '')), '') is not null then
    update public.pending_task_nudges
       set state = 'retired', settled_at = now(), retire_reason = left(p_retire_reason, 100)
     where id = p_pending_id and state = 'pending';
  else
    update public.pending_task_nudges
       set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500)
     where id = p_pending_id and state = 'pending';
  end if;
  return jsonb_build_object('pendingId', p_pending_id);
end
$$;

revoke all on function public.claim_pending_task_nudges(integer, integer) from public;
grant execute on function public.claim_pending_task_nudges(integer, integer) to tm8_app;
revoke all on function public.post_task_nudge(uuid, text, text) from public;
grant execute on function public.post_task_nudge(uuid, text, text) to tm8_app;
revoke all on function public.settle_pending_task_nudge(uuid, text, text) from public;
grant execute on function public.settle_pending_task_nudge(uuid, text, text) to tm8_app;

reset role;
