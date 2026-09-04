-- =============================================================================
-- 158  THE TWO COUNTING RPCs STOP RE-FETCHING ROWS THEY ARE ALREADY HOLDING.
--
-- `public.space_kind_counts` and `public.unread_counts` are both
-- `security definer`, and both re-check per-entity readability themselves
-- rather than leaning on RLS — deliberately, and that stays true here. 063
-- states the reason: a counter must never disclose that a restricted entity
-- exists when the corresponding list would hide it.
--
-- The defect is not THAT they re-check. It is HOW. Both call
-- `internal.entity_readable(<id>)` once per row, and that function opens with
--
--     select exists (select 1 from public.entities entity_row
--                     where entity_row.id = target ...)
--
-- — a primary-key lookup for a row the surrounding query has ALREADY joined and
-- has in hand. `space_kind_counts` is scanning `public.entities e` and then
-- asks the same table for `e` again. `unread_counts` joins `message_entity` and
-- `anchor_entity` and then asks for both of them again, per message row.
--
-- That would be merely wasteful if the call were cheap. It is not, and the
-- reason is worth writing down because it is the single most expensive fact
-- about this schema:
--
--   `internal.entity_readable` is a `security definer` SQL function whose body
--   calls ANOTHER `security definer` SQL function (`internal.is_space_member`)
--   that itself contains a query. A nested SQL function containing a query
--   cannot keep its plan across calls when it is invoked from inside another
--   SQL function's body, so it is re-initialised per row. Measured on staging
--   over 7 000 calls, 2026-08-19:
--
--     entity_readable as shipped (nested)          137 us/call
--     same body, is_space_member inlined by hand    31 us/call   4.4x
--
--   Full ladder, same harness, one variable at a time: removing the
--   `project_links`/`space_projects` carve-out changed NOTHING (125 us);
--   dropping `set search_path` changed nothing (124 us); dropping
--   `security definer` changed nothing (133 us); FLATTENING THE NESTING, with
--   the carve-out fully intact, took 119 us to 25 us. The nesting is the cost.
--
-- Fixing the nesting means editing an RLS policy's function, which is a change
-- to the enforcement path and is proposed separately, with evidence, rather
-- than smuggled into a performance migration. THIS file takes the other half
-- of the win, which needs no policy change at all: where the caller already
-- holds the row, read the visibility off the row instead of calling a function
-- to go and fetch it again.
--
-- `internal.entity_readable(x)` expands, by its own definition, to
--
--     x exists, and x.deleted_at is null,
--     and internal.is_space_member(x.space_id),
--     and (x.visibility = 'space'
--          or (x.visibility = 'restricted' and x.kind = 'project'
--              and <the space_projects carve-out>))
--
-- Every conjunct below is written out. Nothing is dropped as "obviously true":
-- where a conjunct is already guaranteed by an existing join or WHERE clause
-- the comment says which one, so the next reader can check the reasoning
-- instead of trusting it.
--
-- MEASURED ON PROD (read-only, inside begin/rollback, 7 084 entities /
-- 4 540 messages, 2026-08-19):
--
--   space_kind_counts   1 119 ms -> 92 ms   (12x)
--   unread_counts       1 290 ms -> 46 ms   (28x)
--
-- Both verified to return IDENTICAL output on prod data before and after:
-- `space_kind_counts` matches on all 17 kinds present, total and unseen,
-- including the `project` row that exercises the restricted carve-out;
-- `unread_counts` matches on all 163 anchors with a non-zero count, and the
-- summed unread total is 506 either way.
--
-- Neither function's signature, grants, volatility, security context nor
-- result shape changes. No RLS policy is touched. No table is altered.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. `public.space_kind_counts` — the rail's numbers.
--
-- Last defined in 101 (which changed the session-kind predicate, not this).
-- Reproduced verbatim except for the `internal.entity_readable(e.id)` line.
--
-- The three conjuncts of `entity_readable(e.id)` other than visibility are all
-- already enforced above it and are NOT restated:
--   * "the row exists"        — `e` IS the row.
--   * `deleted_at is null`    — `e.deleted_at is null`, one line up.
--   * `is_space_member(space)`— `e.space_id = p_space_id` (one line up) and
--                               `internal.is_space_member(p_space_id)`, kept.
-- -----------------------------------------------------------------------------
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
     -- WAS: `and internal.entity_readable(e.id)`. Same predicate, read off `e`
     -- rather than looked up again per row. See this file's header.
     and (
       e.visibility = 'space'
       or (
         e.visibility = 'restricted'
         and e.kind = 'project'
         and exists (
           select 1
             from public.project_links link
             join public.space_projects active_link
               on active_link.space_id = link.space_id
              and active_link.project_id = link.project_id
            where link.project_entity_id = e.id
              and link.space_id = e.space_id
         )
       )
     )
     -- Unchanged from 101. Spelled as the exact kind being hidden, so a future
     -- session kind is COUNTED unless someone writes it in here.
     and not exists (select 1 from public.work_sessions ws
                      where ws.entity_id = e.id and ws.session_kind = 'credential')
   group by e.kind
$$;
revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 2. `public.unread_counts` — per-anchor unread, used by `spaces.navigation`
--    AND by `loadUnreadCounts` in the summary assembler, which fires on EVERY
--    collections.query / graph.query page that contains at least one channel.
--    That second caller is why this is on the boot path at all.
--
-- Last defined in 016. Reproduced verbatim except for the two
-- `internal.entity_readable(...)` lines, which become the same predicate read
-- off the two `entities` rows the query already joins.
--
-- One conjunct here is NOT already guaranteed and so is ADDED explicitly:
-- `anchor_entity.deleted_at is null`. The existing join constrains
-- `anchor_entity` on `id` and `space_id` only, so `entity_readable(anchor_id)`
-- was the sole thing excluding messages anchored to a deleted entity. Dropping
-- the call without restating this would have CHANGED the counts. It is written
-- below, and the prod equivalence check above (163 anchors, 506 total, both
-- identical) is what confirms it was the only such gap.
--
-- For `message_entity`: `deleted_at is null` is already in its join;
-- `is_space_member(message_entity.space_id)` is restated in full rather than
-- assumed from the anchor's space, because nothing in this query constrains a
-- message envelope to live in the same space as its anchor.
--
-- For `anchor_entity`: `is_space_member(anchor_entity.space_id)` IS already
-- guaranteed — the join pins `anchor_entity.space_id = p_space_id` and
-- `internal.is_space_member(p_space_id)` is kept below — so it is not restated.
-- -----------------------------------------------------------------------------
create or replace function public.unread_counts(p_space_id uuid)
returns table(anchor_id uuid, unread integer)
language sql stable security definer set search_path = public, internal, pg_temp as $$
  with me as (select internal.current_member_id(p_space_id) as member_id)
  select message_row.anchor_id, count(*)::integer as unread
    from public.messages message_row
    join public.entities message_entity
      on message_entity.id = message_row.entity_id and message_entity.deleted_at is null
    join public.entities anchor_entity
      on anchor_entity.id = message_row.anchor_id and anchor_entity.space_id = p_space_id
    left join public.read_marks mark_row
      on mark_row.anchor_id = message_row.anchor_id
     and mark_row.member_id = (select member_id from me)
   where internal.is_space_member(p_space_id)
     -- WAS: `and internal.entity_readable(message_row.entity_id)`.
     and internal.is_space_member(message_entity.space_id)
     and (
       message_entity.visibility = 'space'
       or (
         message_entity.visibility = 'restricted'
         and message_entity.kind = 'project'
         and exists (
           select 1
             from public.project_links link
             join public.space_projects active_link
               on active_link.space_id = link.space_id
              and active_link.project_id = link.project_id
            where link.project_entity_id = message_entity.id
              and link.space_id = message_entity.space_id
         )
       )
     )
     -- WAS: `and internal.entity_readable(message_row.anchor_id)`. The
     -- `deleted_at` conjunct is NEW here only in the sense that the call used
     -- to carry it; see this section's header.
     and anchor_entity.deleted_at is null
     and (
       anchor_entity.visibility = 'space'
       or (
         anchor_entity.visibility = 'restricted'
         and anchor_entity.kind = 'project'
         and exists (
           select 1
             from public.project_links link
             join public.space_projects active_link
               on active_link.space_id = link.space_id
              and active_link.project_id = link.project_id
            where link.project_entity_id = anchor_entity.id
              and link.space_id = anchor_entity.space_id
         )
       )
     )
     and message_row.author_id is distinct from (select member_id from me)
     and (mark_row.last_read_at is null
       or message_row.entity_id > internal.uuid_at(mark_row.last_read_at))
   group by message_row.anchor_id
$$;
revoke all on function public.unread_counts(uuid) from public;
grant execute on function public.unread_counts(uuid) to tm8_app;
