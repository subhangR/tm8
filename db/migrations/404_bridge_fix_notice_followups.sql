-- =============================================================================
-- 404 — Bridges F follow-ups: a cancelled report is never "Fixed", a refused
-- notice is retried and bounded, and the no-PR notice reads the close-out.
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Design of record: BRIDGE-ENTITY-DESIGN.md D70 and D72 (amended here). Task
-- 01a18ba0-105f, the three review notes on #1437. Builds on 403; every
-- function replaced below is 403's own, from its reviewed body (7d48aedc9).
--
--   §1  CANCELLED (D70): a report in the cancelled category posts nothing, not
--       on a merge and not on a later event.
--   §2  RETRY (D70): a notice that fails is recorded in bridge_fix_pending. It
--       is retried when the report's open answer settles, is handed over or is
--       removed (the usual refusal is 399's answerer guard), on any later
--       event for the task, and by the sweep. After 5 attempts or 30 minutes
--       it gives up: the pending row is kept as `given_up` and an fyi
--       attention request is raised on the task.
--   §3  CLOSE-OUT (D72): entering done without a merged PR opens a 10-minute
--       window. The first person or teammate message on the task after the
--       done move is "what was done" and posts at once (the routine's
--       close-out comes after `task complete`). When the window ends with no
--       such message, the sweep posts the newest message from before.
--   §4  the sweep: internal.bridge_fix_sweep(), run by the in-process bridges
--       worker every 2 minutes. It only closes the waits above, the two that
--       need a clock. Notices stay event-driven.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §2/§3. The two waits.
-- -----------------------------------------------------------------------------
create table public.bridge_fix_pending (
  task_id             uuid not null references public.entities(id) on delete cascade,
  bridge_id           uuid not null references public.bridges(entity_id) on delete cascade,
  provider_message_id text not null,
  status              text not null default 'retrying' check (status in ('retrying', 'given_up')),
  attempts            integer not null default 1 check (attempts >= 1),
  first_at            timestamptz not null default now(),
  last_at             timestamptz not null default now(),
  last_error          text,
  primary key (task_id, bridge_id, provider_message_id)
);
create index bridge_fix_pending_retrying_idx on public.bridge_fix_pending(bridge_id, provider_message_id)
  where status = 'retrying';
alter table public.bridge_fix_pending enable row level security;
create policy bridge_fix_pending_select on public.bridge_fix_pending for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_fix_pending.task_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_fix_pending to tm8_app;

create table public.bridge_fix_closeouts (
  task_id  uuid primary key references public.entities(id) on delete cascade,
  done_at  timestamptz not null default now()
);
alter table public.bridge_fix_closeouts enable row level security;
create policy bridge_fix_closeouts_select on public.bridge_fix_closeouts for select to tm8_app
  using ((exists (select 1 from public.entities readable_entity
                   where readable_entity.id = bridge_fix_closeouts.task_id
                     and readable_entity.deleted_at is null offset 0)));
grant select on public.bridge_fix_closeouts to tm8_app;

-- The bounds, one screen each.
create or replace function internal.bridge_fix_closeout_window() returns interval
language sql immutable as $$ select interval '10 minutes' $$;
create or replace function internal.bridge_fix_retry_limit() returns integer
language sql immutable as $$ select 5 $$;
create or replace function internal.bridge_fix_retry_age() returns interval
language sql immutable as $$ select interval '30 minutes' $$;
revoke all on function internal.bridge_fix_closeout_window() from public;
revoke all on function internal.bridge_fix_retry_limit() from public;
revoke all on function internal.bridge_fix_retry_age() from public;

-- A message that can say what was done: by a member or a teammate, not blank,
-- not a bridge's copy or notice (403's rule).
create or replace function internal.bridge_fix_closeout_text(p_task uuid, p_after timestamptz)
returns text language sql stable set search_path = public, internal, pg_temp as $$
  select left(btrim(m.body), 700)
    from public.messages m
    join public.entities me on me.id = m.entity_id and me.deleted_at is null
    join public.entities au on au.id = m.author_id and au.kind in ('member', 'team_member')
   where m.anchor_id = p_task and btrim(m.body) <> ''
     and coalesce(m.message_batch_id, '') not like 'bridge-%'
     and m.created_at >= p_after
   order by m.created_at, m.entity_id
   limit 1
$$;
revoke all on function internal.bridge_fix_closeout_text(uuid, timestamptz) from public;

-- -----------------------------------------------------------------------------
-- 403's check, with §1-§3. Body from 7d48aedc9; changes are marked 404.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_fix_check(p_task uuid)
returns integer language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  t public.tasks; e public.entities; v_kind text; body text; done_text text; prs text; posted integer := 0; r record;
  w public.bridge_fix_closeouts; p public.bridge_fix_pending;
begin
  select * into e from public.entities where id = p_task and kind = 'task' and deleted_at is null;
  -- 404 §1: a deleted or cancelled report is never announced, and nothing
  -- waits for it (a wait left behind would be swept forever).
  if e.id is null or e.status_category = 'cancelled' then
    delete from public.bridge_fix_closeouts where task_id = p_task;
    delete from public.bridge_fix_pending where task_id = p_task and status = 'retrying';
    return 0;
  end if;
  if not exists (select 1 from public.bridge_fix_reports where task_id = p_task) then
    if not internal.bridge_task_is_bug(p_task) then return 0; end if;
    if not exists (select 1 from internal.bridge_task_origins(p_task)) then return 0; end if;
    insert into public.bridge_fix_reports(task_id, via) values (p_task, 'label') on conflict do nothing;
  end if;
  select * into t from public.tasks where entity_id = p_task;

  if internal.bridge_fix_merged(p_task) then
    v_kind := 'merged';
    select string_agg(pr.url, ' ' order by pr.number) into prs
      from public.edges ed join public.pull_requests pr on pr.entity_id = ed.dst_id
     where ed.src_id = p_task and ed.type = 'tracks';
    body := format('Fixed: %s. Merged %s', t.title, prs);
    delete from public.bridge_fix_closeouts where task_id = p_task;
  elsif e.status_category = 'done' then
    v_kind := 'done_without_pr';
    -- 404 §3: the first close-out after the done move, or, once the window
    -- has passed, the newest message from before it.
    insert into public.bridge_fix_closeouts(task_id) values (p_task) on conflict do nothing;
    select * into w from public.bridge_fix_closeouts where task_id = p_task;
    done_text := internal.bridge_fix_closeout_text(p_task, w.done_at);
    if done_text is null then
      if w.done_at > now() - internal.bridge_fix_closeout_window() then return 0; end if;
      done_text := internal.bridge_fix_what_was_done(p_task);
    end if;
    body := case when done_text is not null then format('Done: %s. %s', t.title, done_text)
                 else format('Done: %s (closed without a pull request).', t.title) end;
  else
    -- Reopened before its close-out or its retry: both start again on the
    -- next done.
    delete from public.bridge_fix_closeouts where task_id = p_task;
    delete from public.bridge_fix_pending where task_id = p_task and status = 'retrying';
    return 0;
  end if;

  for r in select * from internal.bridge_task_origins(p_task) loop
    select * into p from public.bridge_fix_pending
     where task_id = p_task and bridge_id = r.bridge_id and provider_message_id = r.provider_message_id;
    -- 404 §2: a notice that gave up stays given up (its fyi is the record).
    if p.status = 'given_up' then continue; end if;
    begin
      perform internal.bridge_fix_post(p_task, r.bridge_id, r.message_id, r.provider_message_id, v_kind, body);
      posted := posted + 1;
      delete from public.bridge_fix_pending
       where task_id = p_task and bridge_id = r.bridge_id and provider_message_id = r.provider_message_id;
    exception when others then
      -- A refusal (another session's open answer on the report, a vanished
      -- bridge) must not fail the write that got us here. The marker rolled
      -- back with the savepoint; the pending row says to retry.
      raise warning 'bridge fix notice for task % on bridge %: %', p_task, r.bridge_id, sqlerrm;
      perform internal.bridge_fix_record_failure(p_task, r.bridge_id, r.provider_message_id, sqlerrm);
    end;
  end loop;
  if v_kind = 'done_without_pr' then
    delete from public.bridge_fix_closeouts where task_id = p_task;
  end if;
  return posted;
end
$$;
revoke all on function internal.bridge_fix_check(uuid) from public;

-- One failed attempt: count it, and give up past the bounds with an fyi.
create or replace function internal.bridge_fix_record_failure(
  p_task uuid, p_bridge uuid, p_provider_message_id text, p_error text)
returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare p public.bridge_fix_pending; b public.bridges; title text;
begin
  insert into public.bridge_fix_pending(task_id, bridge_id, provider_message_id, last_error)
  values (p_task, p_bridge, p_provider_message_id, left(p_error, 500))
  on conflict (task_id, bridge_id, provider_message_id) do update
     set attempts = bridge_fix_pending.attempts + 1, last_at = now(), last_error = excluded.last_error
   where bridge_fix_pending.status = 'retrying'
  returning * into p;
  if p.task_id is null then return; end if;
  if p.attempts < internal.bridge_fix_retry_limit() and p.first_at > now() - internal.bridge_fix_retry_age() then
    return;
  end if;
  update public.bridge_fix_pending set status = 'given_up'
   where task_id = p_task and bridge_id = p_bridge and provider_message_id = p_provider_message_id;
  select * into b from public.bridges where entity_id = p_bridge;
  select tk.title into title from public.tasks tk where tk.entity_id = p_task;
  perform internal.raise_attention_signal(b.space_id, p_task,
    'bridge.fix_notice_failed:' || p_bridge || ':' || p_provider_message_id,
    format('The fix notice for "%s" could not be posted in %s after %s attempts: %s',
           coalesce(title, 'this task'), coalesce(b.conversation ->> 'title', 'the group'),
           p.attempts, coalesce(p.last_error, 'unknown error')),
    'fyi', 'review', p_bridge);
end
$$;
revoke all on function internal.bridge_fix_record_failure(uuid, uuid, text, text) from public;

-- -----------------------------------------------------------------------------
-- §2. Retry when the report's answer settles, is handed over or goes away.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_fix_on_answer() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare v_message uuid; o public.message_origins; task uuid;
begin
  begin
    if tg_op = 'DELETE' then v_message := old.message_id; else v_message := new.message_id; end if;
    select * into o from public.message_origins where message_id = v_message;
    if o.message_id is null then return null; end if;
    for task in select distinct p.task_id from public.bridge_fix_pending p
                 where p.bridge_id = o.bridge_id and p.provider_message_id = o.external_message_id
                   and p.status = 'retrying' loop
      perform internal.bridge_fix_check(task);
    end loop;
  exception when others then
    raise warning 'bridge fix retry on answer %: %', v_message, sqlerrm;
  end;
  return null;
end
$$;
revoke all on function internal.bridge_fix_on_answer() from public;
create constraint trigger bridge_message_answerers_fix_retry after update or delete on public.bridge_message_answerers
  deferrable initially deferred for each row execute function internal.bridge_fix_on_answer();

-- -----------------------------------------------------------------------------
-- §3. The close-out: the first qualifying message on a report waiting for one.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_fix_on_closeout() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  begin
    if exists (select 1 from public.bridge_fix_closeouts where task_id = new.anchor_id) then
      perform internal.bridge_fix_check(new.anchor_id);
    end if;
  exception when others then
    raise warning 'bridge fix close-out for task %: %', new.anchor_id, sqlerrm;
  end;
  return null;
end
$$;
revoke all on function internal.bridge_fix_on_closeout() from public;
create constraint trigger messages_bridge_fix_closeout after insert on public.messages
  deferrable initially deferred for each row execute function internal.bridge_fix_on_closeout();

-- -----------------------------------------------------------------------------
-- §4. The sweep: the waits that need a clock.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_fix_sweep() returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare task uuid; closeouts integer := 0; retries integer := 0;
begin
  perform internal.require_bridges_worker();
  for task in select c.task_id from public.bridge_fix_closeouts c
               where c.done_at <= now() - internal.bridge_fix_closeout_window()
               order by c.done_at limit 100 loop
    begin
      perform internal.bridge_fix_check(task);
      closeouts := closeouts + 1;
    exception when others then
      raise warning 'bridge fix sweep, close-out for task %: %', task, sqlerrm;
    end;
  end loop;
  for task in select p.task_id from public.bridge_fix_pending p
               where p.status = 'retrying'
               group by p.task_id order by min(p.last_at) limit 100 loop
    begin
      perform internal.bridge_fix_check(task);
      retries := retries + 1;
    exception when others then
      raise warning 'bridge fix sweep, retry for task %: %', task, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('closeouts', closeouts, 'retries', retries);
end
$$;
revoke all on function internal.bridge_fix_sweep() from public;
grant execute on function internal.bridge_fix_sweep() to tm8_app;

reset role;

analyze public.bridge_fix_pending;
analyze public.bridge_fix_closeouts;
