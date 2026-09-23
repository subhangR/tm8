-- =============================================================================
-- 205  WORKSPACE_EVENTS.SUBJECT_IDS -- the index the scoped change feed reads.
--
-- Spec: "scoped change feed (`tm8 event changes`)", doc 01a0cf35, sections 2
-- fact 3, 4 Storage, 5 `index_incomplete` and 8 step 2.
--
-- THE PROBLEM. `workspace_events` is indexed on (space_id, seq) only, and every
-- id an event is ABOUT lives inside its jsonb payload, under a key that depends
-- on the event type. "Which events touched these entities" is therefore a
-- sequential scan plus a per-row jsonb decode. The change feed (step 3) needs
-- that question answered from an index.
--
-- THE SHAPE.
--
--   * `subject_ids uuid[]` -- the entity ids the event is about:
--       entity.upsert / entity.deleted / entity.activity_touched   id
--       edge.upsert / edge.deleted                                  src_id, dst_id
--       message.created / .updated / .deleted                       entity_id, anchor_id
--       activity.created                                            entity_id
--       notification.created / .read                                target_entity_id
--       git.commit_recorded / git.pr_state_changed /
--         git.worktree_status_changed                               the fact's entity id
--     Every other event type gets '{}'. NULL has exactly one meaning:
--     NOT YET INDEXED. It never means "about nothing", so a reader can never
--     mistake an unindexed row for a non-match.
--
--   * It is filled by a BEFORE INSERT trigger on `workspace_events` itself, not
--     inside `internal.capture_workspace_event`. The capture trigger is only one
--     of the writers: about twenty RPCs (015, 019, 021, 027, 031, 032, 040, 082,
--     ...) insert into this table directly. A column filled only by the capture
--     trigger would leave those rows NULL forever, and the watermark below
--     could never be honest. One derivation function,
--     `internal.event_subject_ids`, serves the live trigger AND the backfill, so
--     the two cannot disagree about what a row is about.
--
--   * A GIN index, PARTIAL on `subject_ids is not null`. `db/migrate.mjs` runs
--     every file in ONE transaction (`psql -1`), so CREATE INDEX CONCURRENTLY
--     is impossible here. The partial predicate makes that harmless: at apply
--     time every existing row is NULL, so the index is built EMPTY, instantly,
--     inside the ACCESS EXCLUSIVE lock the ADD COLUMN already holds. The
--     backfill then fills it row by row. The overlap operator (`&&`) is strict,
--     so the planner proves `subject_ids is not null` from any `subject_ids &&
--     $ids` predicate and uses this index without the caller restating it.
--
--   * An online, batched, resumable backfill: `public.backfill_event_subject_ids`
--     indexes ONE batch of ONE space per call, walking DOWN from the newest
--     unindexed seq, and commits. The server's scheduler calls it in a loop
--     (packages/server/src/scheduler/jobs/event-subject-backfill.ts). Row locks
--     only, on rows nobody else updates (the log is append-only); no long lock.
--
--   * A per-space low watermark, `internal.event_subject_index.indexed_from`:
--     EVERY ROW OF THAT SPACE WITH seq >= indexed_from HAS subject_ids SET.
--     Per space because seq is per space -- a single global number in seq units
--     would mean nothing. A space with no row here has nothing to backfill
--     (it was created after this migration, or held no unindexed rows), so its
--     watermark is 1. The backfill lowers indexed_from after each batch, and
--     sets it to 1 (and stamps completed_at) when nothing below remains.
--
--   * `public.event_subject_indexed_from(space)` reads the watermark for the
--     server's gate (packages/server/src/events/subject-index.ts). A feed request
--     whose cursor reaches below the watermark is refused with
--     `index_incomplete`. There is no jsonb fallback.
--
-- RE-RUN SAFETY. Every statement is idempotent (`if not exists`, `create or
-- replace`, `drop ... if exists` + create, and an upsert that only ever RAISES
-- a watermark to cover NULL rows it finds), so applying this file twice changes
-- nothing that the first application did not.
-- =============================================================================

alter table public.workspace_events add column if not exists subject_ids uuid[];

comment on column public.workspace_events.subject_ids is
  'Entity ids this event is about (see internal.event_subject_ids). NULL means '
  'NOT YET INDEXED and never "about nothing" -- an event about nothing is ''{}''. '
  'Readers must gate on public.event_subject_indexed_from (migration 205).';

-- -----------------------------------------------------------------------------
-- The derivation. IMMUTABLE: a pure function of (event_type, payload).
-- -----------------------------------------------------------------------------
create or replace function internal.event_subject_ids(p_event_type text, p_payload jsonb)
returns uuid[] language sql immutable parallel safe
set search_path = pg_catalog, pg_temp as $$
  -- `array(...)` is '{}' on no rows, never NULL. The uuid shape check keeps a
  -- malformed payload value from raising inside an INSERT trigger: a bad id
  -- is dropped, the event is still written.
  select array(
    select distinct candidate::uuid
      from unnest(case
        when p_event_type in ('entity.upsert', 'entity.deleted', 'entity.activity_touched')
          then array[p_payload ->> 'id']
        when p_event_type in ('edge.upsert', 'edge.deleted')
          then array[p_payload ->> 'src_id', p_payload ->> 'dst_id']
        when p_event_type in ('message.created', 'message.updated', 'message.deleted')
          then array[p_payload ->> 'entity_id', p_payload ->> 'anchor_id']
        when p_event_type = 'activity.created'
          then array[p_payload ->> 'entity_id']
        when p_event_type in ('notification.created', 'notification.read')
          then array[p_payload ->> 'target_entity_id']
        when p_event_type = 'git.commit_recorded'
          then array[p_payload ->> 'commitEntityId']
        when p_event_type = 'git.pr_state_changed'
          then array[p_payload ->> 'prEntityId']
        when p_event_type = 'git.worktree_status_changed'
          then array[p_payload ->> 'worktreeEntityId']
        else array[]::text[]
      end) as candidate
     where candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by 1)
$$;

comment on function internal.event_subject_ids(text, jsonb) is
  'The entity ids a workspace_events row is about, from its type and payload. '
  'Shared by the insert trigger and the backfill (migration 205). Never NULL.';

create or replace function internal.workspace_events_fill_subject_ids() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  new.subject_ids := internal.event_subject_ids(new.event_type, new.payload);
  return new;
end
$$;

drop trigger if exists workspace_events_fill_subject_ids on public.workspace_events;
create trigger workspace_events_fill_subject_ids before insert on public.workspace_events
for each row execute function internal.workspace_events_fill_subject_ids();

create index if not exists workspace_events_subject_ids_gin_idx
  on public.workspace_events using gin (subject_ids)
  where subject_ids is not null;

-- -----------------------------------------------------------------------------
-- The watermark.
-- -----------------------------------------------------------------------------
create table if not exists internal.event_subject_index (
  space_id     uuid primary key references public.spaces(id) on delete cascade,
  -- Every row of this space with seq >= indexed_from has subject_ids set.
  indexed_from bigint not null check (indexed_from >= 1),
  completed_at timestamptz,
  updated_at   timestamptz not null default now()
);

comment on table internal.event_subject_index is
  'Per-space low watermark of the subject_ids backfill (migration 205): every '
  'workspace_events row of the space with seq >= indexed_from has subject_ids set. '
  'No row = fully indexed.';

-- Seed from the NULL rows actually present. Correct on first apply (all rows
-- are NULL; the ADD COLUMN above holds ACCESS EXCLUSIVE, so no writer can slip
-- a row in between) and on any re-apply (only a space that still has NULL rows
-- above its recorded watermark moves, and it moves UP -- the safe direction).
insert into internal.event_subject_index (space_id, indexed_from)
select space_id, max(seq) + 1
  from public.workspace_events
 where subject_ids is null
 group by space_id
on conflict (space_id) do update
   set indexed_from = excluded.indexed_from,
       completed_at = null,
       updated_at   = now()
 where excluded.indexed_from > internal.event_subject_index.indexed_from;

-- -----------------------------------------------------------------------------
-- The backfill door: ONE batch of ONE space per call, one transaction per call.
-- -----------------------------------------------------------------------------
create or replace function public.backfill_event_subject_ids(p_batch integer default 500)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  batch integer := least(greatest(coalesce(p_batch, 500), 1), 10000);
  target record;
  low bigint;
  touched integer := 0;
  pending integer;
begin
  perform internal.require_identity();
  if not internal.is_node_admin() then
    raise exception 'backfilling event subjects requires node admin' using errcode = '42501';
  end if;

  -- SKIP LOCKED: two nodes (or two ticks) never index the same space at once,
  -- and neither waits on the other.
  select s.space_id, s.indexed_from into target
    from internal.event_subject_index s
   where s.completed_at is null
   order by s.space_id
   limit 1
     for update skip locked;

  if not found then
    return jsonb_build_object('done', true, 'updated', 0, 'pendingSpaces',
      (select count(*) from internal.event_subject_index where completed_at is null));
  end if;

  -- The next `batch` rows below the watermark, by seq. Seqs can be sparse
  -- (pruning), so the batch is sized in ROWS, not in a seq span.
  select min(seq) into low
    from (select e.seq from public.workspace_events e
           where e.space_id = target.space_id and e.seq < target.indexed_from
           order by e.seq desc
           limit batch) b;

  if low is null then
    -- Nothing below the watermark: every row of the space is indexed.
    update internal.event_subject_index
       set indexed_from = 1, completed_at = now(), updated_at = now()
     where space_id = target.space_id;
  else
    update public.workspace_events e
       set subject_ids = internal.event_subject_ids(e.event_type, e.payload)
     where e.space_id = target.space_id
       and e.seq >= low and e.seq < target.indexed_from
       and e.subject_ids is null;
    get diagnostics touched = row_count;

    update internal.event_subject_index
       set indexed_from = low, updated_at = now()
     where space_id = target.space_id;
  end if;

  select count(*) into pending from internal.event_subject_index where completed_at is null;

  return jsonb_build_object(
    'done', pending = 0,
    'spaceId', target.space_id,
    'indexedFrom', coalesce(low, 1),
    'updated', touched,
    'pendingSpaces', pending);
end
$$;

revoke all on function public.backfill_event_subject_ids(integer) from public;
grant execute on function public.backfill_event_subject_ids(integer) to tm8_app;

-- -----------------------------------------------------------------------------
-- The gate's read: the space's watermark, 1 when fully indexed.
-- -----------------------------------------------------------------------------
create or replace function public.event_subject_indexed_from(p_space_id uuid)
returns bigint language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_space_member(p_space_id);
  return coalesce(
    (select indexed_from from internal.event_subject_index where space_id = p_space_id),
    1);
end
$$;

revoke all on function public.event_subject_indexed_from(uuid) from public;
grant execute on function public.event_subject_indexed_from(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- VERIFY. Only what this file creates.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if (select count(*) from pg_trigger
       where tgrelid = 'public.workspace_events'::regclass
         and tgname = 'workspace_events_fill_subject_ids'
         and tgenabled = 'O' and not tgisinternal) <> 1 then
    raise exception '205: workspace_events_fill_subject_ids must exist exactly once and be enabled';
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'workspace_events_subject_ids_gin_idx') then
    raise exception '205: workspace_events_subject_ids_gin_idx is missing';
  end if;

  -- The derivation must never yield NULL: NULL is reserved for "not indexed".
  if internal.event_subject_ids('some.unknown_type', '{}'::jsonb) is null then
    raise exception '205: event_subject_ids returned NULL for an unknown type -- NULL means not indexed';
  end if;

  if internal.event_subject_ids('edge.upsert',
       '{"src_id":"00000000-0000-0000-0000-000000000001","dst_id":"00000000-0000-0000-0000-000000000002"}')
     <> array['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002']::uuid[] then
    raise exception '205: edge subjects must be {src_id, dst_id}';
  end if;

  -- The watermark invariant, checked against the table as it stands now.
  if exists (
    select 1 from public.workspace_events e
      left join internal.event_subject_index s on s.space_id = e.space_id
     where e.subject_ids is null
       and e.seq >= coalesce(s.indexed_from, 1)) then
    raise exception '205: a NULL subject_ids row sits at or above its space''s indexed_from';
  end if;
end
$verify$;
