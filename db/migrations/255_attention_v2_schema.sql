-- =============================================================================
-- 255 · ATTENTION v2 SCHEMA (slice S3; spec chapter 1 "Model & lifecycle",
-- chapter 5 "Database: one aggregate", register F1).
--
-- ONE migration, additive. The RPCs from 050 and the form raise/resolve from
-- 211 are NOT changed here: they keep writing the columns they know about, and
-- every new column has a default or is nullable, so old clients still list,
-- create and resolve. The new verbs (resolve root, unresolve, withdraw, mark
-- seen, delivery sweep) are S4.
--
--   1. attention_requests gains source_session_id, origin, signal_key,
--      assignee_id, action_type, level, note_deliver_after, note_message_id and
--      resolution_batch_id; status gains `cleared`.
--   2. CLEAN SLATE (R8): every open/acknowledged row is resolved with the note
--      'attention redesign', resolved_by null (the system), and NO delivery --
--      note_deliver_after stays null, which is what the S4 sweep keys on, and
--      nothing here inserts a message.
--   3. attention_seen (request, member) with RLS: per-person Seen (G4).
--   4. The dedupe partial unique indexes (Q10).
--   5. internal.attention_root_id + the attention_rollup view: request -> root
--      (a session's working_on task, a form's attached_to task, else itself;
--      one hop, R3). The root is computed, never stored, so re-linking a
--      session moves its requests.
--   6. attention_badges (252) is redefined over the rollup and gains the
--      chapter 1 fields plus the raised-by badge for work sessions and chats
--      (F1).
--   7. attention_requests_flag_changed (254) also flags -- and touches -- the
--      rollup root and the raising session, so their summaries re-project.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns and status.
-- -----------------------------------------------------------------------------
alter table public.attention_requests
  -- The work session OR chat that raised it (F1). Stamped server-side from the
  -- caller's bearer by S4; null for humans and legacy rows. The kind is
  -- checked by internal.attention_requests_validate below.
  add column source_session_id uuid references public.entities(id) on delete set null,
  -- agent | human | system (Q2). NOT NULL; the BEFORE INSERT trigger fills it
  -- from requested_by for writers that do not know the column yet (050, 211).
  add column origin text check (origin in ('agent', 'human', 'system')),
  -- Only on system rows: lets tm8 find and clear its own row.
  add column signal_key text check (signal_key is null or char_length(signal_key) between 1 and 500),
  -- A member, set only when the raiser names someone (R1). No default.
  add column assignee_id uuid references public.entities(id) on delete set null,
  add column action_type text not null default 'decide'
    check (action_type in ('decide', 'approve', 'unblock', 'review', 'fyi')),
  add column level text not null default 'normal'
    check (level in ('fyi', 'normal', 'high', 'urgent')),
  -- Set by S4's resolve to now() + 8s (Q6). Null means "never deliver".
  add column note_deliver_after timestamptz,
  -- The message the note became once delivered. A message IS an entity.
  add column note_message_id uuid references public.entities(id) on delete set null,
  -- Groups the rows one Resolve settled, so Undo reopens exactly that set.
  add column resolution_batch_id uuid;

-- Legacy rows: origin derived from requested_by (a teammate persona is an
-- agent, anyone else a human). level/action_type took their defaults above.
update public.attention_requests ar
   set origin = case when e.kind = 'team_member' then 'agent' else 'human' end
  from public.entities e
 where e.id = ar.requested_by;
update public.attention_requests set origin = 'human' where origin is null;

alter table public.attention_requests
  alter column origin set not null,
  add constraint attention_requests_signal_key_system_check
    check (signal_key is null or origin = 'system');

alter table public.attention_requests drop constraint attention_requests_status_check;
alter table public.attention_requests add constraint attention_requests_status_check
  check (status in ('open', 'acknowledged', 'resolved', 'dismissed', 'cleared'));

-- Fills origin for writers that predate it, and pins the kinds F1 and R1 name.
-- A trigger rather than a CHECK because the rule reads another row.
create or replace function internal.attention_requests_validate() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.origin is null then
    new.origin := case
      when (select kind from public.entities where id = new.requested_by) = 'team_member' then 'agent'
      else 'human'
    end;
  end if;
  if new.source_session_id is not null
     and (tg_op = 'INSERT' or new.source_session_id is distinct from old.source_session_id)
     and not exists (select 1 from public.entities
                      where id = new.source_session_id and kind in ('work_session', 'chat')) then
    raise exception 'attention source must be a work session or a chat' using errcode = '22023';
  end if;
  if new.assignee_id is not null
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
     and not exists (select 1 from public.entities where id = new.assignee_id and kind = 'member') then
    raise exception 'attention assignee must be a member' using errcode = '22023';
  end if;
  return new;
end
$$;

create trigger attention_requests_validate
before insert or update of origin, source_session_id, assignee_id on public.attention_requests
for each row execute function internal.attention_requests_validate();

-- -----------------------------------------------------------------------------
-- 2. CLEAN SLATE (R8). Runs while 254's flag trigger is still the one attached,
-- so the entity touch after it stays a FULL entity.upsert and an open tab's
-- badge clears live. No message is written and note_deliver_after stays null.
-- -----------------------------------------------------------------------------
do $cutover$
declare
  touched uuid[];
begin
  with settled as (
    update public.attention_requests
       set status = 'resolved', resolved_by = null, resolved_at = now(),
           resolution_note = 'attention redesign', version = version + 1
     where status in ('open', 'acknowledged')
    returning entity_id
  )
  select coalesce(array_agg(distinct entity_id), '{}') into touched from settled;

  update public.entities set updated_at = clock_timestamp()
   where id = any(touched) and deleted_at is null;

  if exists (select 1 from public.attention_requests where status in ('open', 'acknowledged')) then
    raise exception '255: clean-slate cutover left an open attention request';
  end if;
end
$cutover$;

-- -----------------------------------------------------------------------------
-- 3. Per-person Seen (G4). Never changes status or counts (G2, Q3). Written by
-- S4's mark-seen verb (security definer), so tm8_app only reads.
-- -----------------------------------------------------------------------------
set role tm8_graph_owner;

create table public.attention_seen (
  request_id uuid not null references public.attention_requests(id) on delete cascade,
  member_id uuid not null references public.entities(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (request_id, member_id)
);
create index attention_seen_member_idx on public.attention_seen(member_id, request_id);

-- Readable iff the request is (its own policy runs inside the EXISTS) AND the
-- row is the caller's own: a member never sees who else has looked.
alter table public.attention_seen enable row level security;
create policy attention_seen_select on public.attention_seen for select to tm8_app
  using (exists (select 1 from public.attention_requests r
                  where r.id = attention_seen.request_id
                    and attention_seen.member_id = internal.current_member_id(r.space_id)));
grant select on public.attention_seen to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. Dedupe (Q10). Null session / null signal never conflict, so humans and
-- legacy rows are not deduped.
-- -----------------------------------------------------------------------------
create unique index attention_requests_open_session_reason_uq
  on public.attention_requests(entity_id, source_session_id, md5(reason))
  where status = 'open' and source_session_id is not null;
create unique index attention_requests_open_signal_uq
  on public.attention_requests(entity_id, signal_key)
  where status = 'open' and signal_key is not null;
-- The raised-by badge reads by source.
create index attention_requests_open_source_idx
  on public.attention_requests(source_session_id)
  where source_session_id is not null and status in ('open', 'acknowledged');

reset role;

-- A never-analyzed table is estimated at 10 pages however empty it is (225;
-- never-analyzed-tables.pg.test.ts), and the badge and list reads join it.
analyze public.attention_seen;

-- -----------------------------------------------------------------------------
-- 5. Roll-up (G6, Q5, R3). ONE rule, used by the view, the badge and the flag
-- trigger. One hop: a work session's working_on task, a form's attached_to
-- task, otherwise the entity itself. Several matching edges pick the NEWEST
-- (re-linking adds the new edge). A deleted task is not a root.
-- -----------------------------------------------------------------------------
create or replace function internal.attention_root_id(p_entity_id uuid) returns uuid
language sql stable as $$
  select coalesce(
    (select e.dst_id
       from public.entities s
       join public.edges e on e.src_id = s.id
       join public.entities t on t.id = e.dst_id
      where s.id = p_entity_id
        and ((s.kind = 'work_session' and e.type = 'working_on')
          or (s.kind = 'form' and e.type = 'attached_to'))
        and t.kind = 'task' and t.deleted_at is null
      order by e.created_at desc, e.id desc
      limit 1),
    p_entity_id)
$$;

create view public.attention_rollup with (security_invoker = true) as
  select ar.id as request_id,
         ar.space_id,
         ar.entity_id,
         internal.attention_root_id(ar.entity_id) as root_id,
         ar.status
    from public.attention_requests ar;

comment on view public.attention_rollup is
  'Attention v2 roll-up: request -> root_id (a session''s working_on task, a '
  'form''s attached_to task, else the request''s own entity; one hop). '
  'Security invoker: the caller''s RLS on attention_requests and edges applies.';

-- -----------------------------------------------------------------------------
-- 6. The badge (chapter 1 + F1). Per requested id X:
--   * the attention badge covers open requests whose root is X OR which are
--     pinned to X -- so a root counts its rolled-up requests, and a pinned
--     non-root (a form, a session) still shows its own (F1(1)) with
--     rolled_up_count 0. mine/all count distinct roots from the list read,
--     never by summing badges, so nothing is counted twice.
--   * the raised-by badge (raised_*) covers open requests whose
--     source_session_id is X, wherever pinned. Non-null only for work_session
--     and chat ids.
-- A row can carry pending_count 0 (a session that raised elsewhere), so both
-- server callers skip those rows for badges.attention.
-- The return type grows, so the function is dropped and recreated.
-- -----------------------------------------------------------------------------
drop function public.attention_badges(uuid[]);

create function public.attention_badges(p_entity_ids uuid[])
returns table (
  entity_id uuid,
  pending_count integer,
  total_points integer,
  max_points integer,
  latest_reason text,
  oldest_requested_at timestamptz,
  max_level text,
  assignee_ids uuid[],
  rolled_up_count integer,
  raised_pending_count integer,
  raised_max_level text,
  raised_latest_reason text,
  raised_oldest_requested_at timestamptz
) language sql stable as $$
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
$$;

comment on function public.attention_badges(uuid[]) is
  'Attention v2 badge per entity (migration 255): open requests rolled up to it '
  'or pinned to it, plus the raised-by badge (raised_*) for work sessions and '
  'chats. A row may carry pending_count 0 when only raised_* applies. Security '
  'invoker: RLS on attention_requests applies. The single source for '
  'entity-read and the projector.';

-- -----------------------------------------------------------------------------
-- 7. The flag trigger (254) also covers the root and the raising session.
-- Flagging alone only exempts a touch from 165's thin downgrade, and the 050
-- and 211 writers touch only the request's own entity_id -- so an extra id
-- flagged for the FIRST time in the transaction is also touched, once.
-- clock_timestamp(), not now(): if the row was already written in this
-- transaction its updated_at is now(), a now() touch would be byte-identical,
-- 165's `old.* is distinct from new.*` would not fire, and no upsert would be
-- sent. updated_at only, so activity_at recency does not move; it writes no
-- entity_versions row, so version and attribution are untouched.
-- -----------------------------------------------------------------------------
create or replace function internal.attention_requests_flag_changed() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare
  -- NULL before the first set_config in a session, '' after a transaction-local
  -- one ends: both mean nothing is flagged.
  flagged text[] := coalesce(string_to_array(
    nullif(current_setting('tm8.attention_changed', true), ''), ','), '{}');
  own uuid[] := '{}';
  extra uuid[] := '{}';
  to_touch uuid[] := '{}';
  id uuid;
begin
  -- NEW and OLD exist only for their own operations; reading the other is an
  -- error, not a NULL, so each is read inside a branch that knows.
  if tg_op <> 'DELETE' then
    own := own || new.entity_id;
    extra := extra || internal.attention_root_id(new.entity_id) || new.source_session_id;
  end if;
  if tg_op <> 'INSERT' then
    own := own || old.entity_id;
    extra := extra || internal.attention_root_id(old.entity_id) || old.source_session_id;
  end if;
  -- The request's own entity: flagged only; its writer touches it.
  foreach id in array own loop
    if not (id::text = any(flagged)) then
      flagged := flagged || id::text;
    end if;
  end loop;
  foreach id in array extra loop
    continue when id is null or id = any(own) or id::text = any(flagged);
    flagged := flagged || id::text;
    to_touch := to_touch || id;
  end loop;
  -- The flag first, so capture_workspace_event sees it on the touch.
  perform set_config('tm8.attention_changed', array_to_string(flagged, ','), true);
  if cardinality(to_touch) > 0 then
    update public.entities set updated_at = clock_timestamp()
     where public.entities.id = any(to_touch) and deleted_at is null;
  end if;
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- Grants. PUBLIC gets EXECUTE on every new function by default and the
-- delivery role's surface is pinned by w2-execution.pg.test.ts, so it is
-- revoked everywhere. attention_root_id is called by the invoker-rights view
-- and badge (tm8_app on the request path, tm8_graph_owner for the projector)
-- and by the flag trigger under the RPCs' definer role. Trigger functions need
-- no EXECUTE grant to fire.
-- -----------------------------------------------------------------------------
revoke all on function internal.attention_requests_validate() from public;
revoke all on function internal.attention_root_id(uuid) from public;
grant execute on function internal.attention_root_id(uuid) to tm8_app, tm8_graph_owner;
revoke all on function public.attention_badges(uuid[]) from public;
grant execute on function public.attention_badges(uuid[]) to tm8_app, tm8_graph_owner;
grant select on public.attention_rollup to tm8_app, tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- VERIFY. Asserts only what THIS FILE creates.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if exists (select 1 from public.attention_requests where status in ('open', 'acknowledged')) then
    raise exception '255: open attention requests remain after the clean slate';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public'
        and indexname in ('attention_requests_open_session_reason_uq', 'attention_requests_open_signal_uq')) <> 2 then
    raise exception '255: the two dedupe indexes must exist';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.attention_seen'::regclass) then
    raise exception '255: attention_seen must have RLS enabled';
  end if;
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'internal' and p.proname = 'attention_requests_flag_changed'
         and p.prosrc like '%attention_root_id%' and p.prosrc like '%clock_timestamp()%') <> 1 then
    raise exception '255: the flag trigger must flag and touch the rollup root';
  end if;
end
$verify$;
