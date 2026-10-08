-- A legacy cancellation's instant is unknown. Record only the wall-clock time
-- at which it was observed, after all in-flight task writers have finished.
-- This is a conservative upper bound, never an exact status timestamp.
set local lock_timeout = '5s';
set role tm8_graph_owner;

-- A snapshot taken before the lock would invalidate the observation proof.
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception '317 requires READ COMMITTED isolation';
  end if;
end $$;
lock table public.tasks in share row exclusive mode;

create table internal.task_cancellation_observations (
  task_id uuid primary key references public.tasks(entity_id) on delete cascade,
  status_changed_not_after timestamptz not null
);
revoke all on internal.task_cancellation_observations from public, tm8_app;
alter table internal.task_cancellation_observations enable row level security;
create policy task_cancellation_observations_select
  on internal.task_cancellation_observations for select to tm8_app
  using (internal.entity_readable(task_id));
grant select on internal.task_cancellation_observations to tm8_app;

-- This statement gets its READ COMMITTED snapshot after the lock. now(), task
-- updated_at, activity and entity_versions all use transaction-start clocks
-- and cannot prove this bound under reverse commit ordering.
do $$ declare observed_at timestamptz := clock_timestamp(); begin
  insert into internal.task_cancellation_observations(task_id, status_changed_not_after)
    select entity_id, observed_at from public.tasks
     where work_status = 'cancelled' and status_changed_at is null;
end $$;

-- 316 stamps UPDATE transitions. INSERT is a separate authoritative status
-- establishment, including tasks created already cancelled. Bulk restore/import
-- MUST set tm8.bulk_load=on to preserve unknown historical timestamps; an
-- imported cancellation did not happen at restore time. Preserve imported exact
-- timestamps as well. Ordinary creates supply NULL and get the insertion clock.
create function internal.stamp_task_initial_status()
returns trigger language plpgsql
set search_path = pg_catalog, public, internal, pg_temp as $$
begin
  if new.status_changed_at is null
     and coalesce(current_setting('tm8.bulk_load', true), '') <> 'on' then
    new.status_changed_at := clock_timestamp();
  end if;
  return new;
end $$;
revoke all on function internal.stamp_task_initial_status() from public;
create trigger tasks_stamp_initial_status
  before insert on public.tasks
  for each row execute function internal.stamp_task_initial_status();

-- An observation describes one uninterrupted legacy cancellation. Discard it
-- on a real transition or an exact stamp, so a later explicit NULL cannot
-- resurrect a bound belonging to an earlier cancellation.
create function internal.invalidate_task_cancellation_observation()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, internal, pg_temp as $$
begin
  if new.work_status is distinct from old.work_status or new.status_changed_at is not null then
    delete from internal.task_cancellation_observations where task_id = new.entity_id;
  end if;
  return new;
end $$;
revoke all on function internal.invalidate_task_cancellation_observation() from public;
create trigger tasks_invalidate_cancellation_observation
  after update of work_status, status_changed_at on public.tasks
  for each row execute function internal.invalidate_task_cancellation_observation();

-- Restore/import tooling that bypasses triggers must discard these observations
-- for replaced tasks. This table is per observed row, not a deployment epoch:
-- later imported NULL rows get no global bound. Restore metadata only alongside
-- the matching task state; a bypassed status write cannot prove continuity.
-- As with 316, this wall clock assumes no backwards system clock step during
-- the transition/observation. It is not a historical or transaction-start clock.
reset role;
