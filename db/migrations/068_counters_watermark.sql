-- =============================================================================
-- 068 — give the rail counters a per-member WATERMARK, so "unseen" stops
-- meaning "everything that has ever existed".
--
-- THE DEFECT, MEASURED. On the tm8 space: 356 live entities, 24 read marks —
-- 93.3% of rows had never been marked read, because `read_marks` was only ever
-- written for CHANNELS until 063 shipped. So `unseen` came back equal to
-- `total` for nearly every kind (docs 61/61, teammates 19/19, tasks 37/38) and
-- the rail drew each kind's lifetime total twice: once plain, once in bold.
-- Every number was large, none was actionable, and the only way to clear one
-- was to open all sixty-one docs by hand.
--
-- WHY A WATERMARK AND NOT A BACKFILL. Inserting a read mark per (member,
-- entity) pair would fix today and re-break tomorrow: the next member to join
-- inherits the whole history as "unseen" and sees the same wall of numbers.
-- It also writes N×M rows to state something a single timestamp states
-- exactly — "this member's counters start here".
--
-- The rule this encodes: YOU CANNOT HAVE FAILED TO SEE WHAT PREDATES YOU.
-- An entity whose last activity is older than the member's watermark is not
-- new to them; it is simply history. Existing members get `now()` at migration
-- time (their counters start clean today); every member created afterwards
-- gets their own creation instant by default, so a person joining a five-year-
-- old space sees an empty rail rather than five years of backlog.
--
-- `joined_at` was NOT reused for this. It is a historical fact about
-- membership, and bending it to mean "counters start here" would both lie
-- about history and break the moment someone wants to reset their counters
-- without re-joining.
-- =============================================================================
set role tm8_graph_owner;

alter table public.members
  add column if not exists counters_since timestamptz not null default now();

comment on column public.members.counters_since is
  'Rail counters ignore entities whose activity predates this instant. Defaults '
  'to member creation so a new member never inherits a space''s backlog as unseen.';

-- Existing members: start their counters now. Idempotent by the `if not
-- exists` above — a re-run adds no column and this update is a no-op against
-- rows that already carry a value, because the column default has already
-- populated every existing row at ADD COLUMN time.

create or replace function public.space_kind_counts(p_space_id uuid)
returns table(kind text, total integer, unseen integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  with me as (
    select m.entity_id as member_id, m.counters_since
      from public.members m
     where m.space_id = p_space_id
       and m.identity_id = internal.identity_id()
     limit 1
  )
  select e.kind,
         count(*)::integer as total,
         -- Unseen = changed since the LATER of "when I last opened it" and
         -- "when my counters start". The watermark is the floor: without it a
         -- never-opened row is unseen forever, which is how 93% of a workspace
         -- ended up bold.
         count(*) filter (
           where e.activity_at > greatest(
             coalesce(mark_row.last_read_at, '-infinity'::timestamptz),
             coalesce((select counters_since from me), '-infinity'::timestamptz)
           )
         )::integer as unseen
    from public.entities e
    left join public.read_marks mark_row
      on mark_row.anchor_id = e.id
     and mark_row.member_id = (select member_id from me)
   where e.space_id = p_space_id
     and e.deleted_at is null
     and internal.is_space_member(p_space_id)
     and internal.entity_readable(e.id)
   group by e.kind
$$;

revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;

reset role;
