-- =============================================================================
-- 175  "UNSEEN" MEANS CREATED SINCE YOU LOOKED, NOT TOUCHED SINCE YOU LOOKED.
--
-- THE DEFECT, MEASURED ON PROD (2026-08-30, `spaces.counts` as a real member):
--
--     message  6806 total / 6506 unseen      task          470 / 458
--     doc       897 /  812                   file          443 / 438
--     work_session 614 / 508                 commit        223 / 223
--     memory     25 /   25                   pull_request  133 / 133
--
-- `unseen` is within a rounding error of `total` for every kind in the space.
-- A counter that is always on is not a counter; the dashboard draws each
-- kind's lifetime total twice, once plain and once in bold, which is the exact
-- condition migration 068 was written to end. It came back. This file explains
-- why, and fixes the two causes rather than re-flooring the watermark a second
-- time.
--
-- CAUSE 1 — THE PREDICATE IS `activity_at`.
-- 063 defined unseen as "activity since your read mark", and 068's tests pin
-- it deliberately: "'Seen' means seen AS IT IS NOW, not seen once and never
-- again." That rule is defensible for a two-person space and untenable here.
-- Activity is what the AGENTS generate: a status flip, a linked commit, a
-- posted message all bump `entities.activity_at`. On a space where a fleet is
-- working continuously, every row you have ever read returns to unseen within
-- minutes, and no amount of reading can ever get ahead of it.
--
-- The product question the number answers is "what is NEW here" — the user's
-- words, 2026-08-30: it should light up "when a session or chat or task is
-- CREATED, not everything". Creation is a fact that happens ONCE per row, so a
-- counter built on it can actually reach zero. Activity cannot.
--
-- This is a REVERSAL of 063/068's stated rule, not an oversight being
-- corrected, so it is written down here and the two tests that pin the old
-- rule are rewritten rather than deleted. What is lost is real and is named:
-- an entity that CHANGES after you read it no longer re-flags. That signal
-- still exists on the surfaces that can afford per-row precision — the unread
-- badge on a channel (`public.unread_counts`, untouched by this file) and the
-- activity timeline on the entity itself. What it may no longer do is drive a
-- space-wide aggregate, because in aggregate it saturates.
--
-- CAUSE 2 — THE WATERMARK NEVER ADVANCES, so no semantics could have survived.
-- 068 added `members.counters_since` and set it once, at migration time, with
-- the intent that it be a per-member floor. Nothing has ever written it since:
-- `counters_since` appears in ZERO lines of `packages/server`,
-- `packages/contract` and `packages/tm8_ui_2.0`. It is a constant. The only
-- other clearing signal is `read_marks`, which is keyed PER ANCHOR — so the
-- only way to clear the task badge is to open all 470 tasks one at a time, and
-- kinds nobody opens individually (nobody clicks a commit) are pinned at 100%
-- unseen forever. 063's own header predicted this shape; 068 fixed the
-- cold-start half of it and left the steady state.
--
-- THE FIX: DERIVE A PER-KIND WATERMARK FROM MARKS THAT ALREADY EXIST.
-- A member's watermark for kind K becomes
--
--     greatest( members.counters_since,
--               max(read_marks.last_read_at) over entities of kind K in this space )
--
-- and `unseen` counts rows of K CREATED after it. Read as a sentence: "things
-- of this kind created since the last time you opened one of these."
--
-- WHY THIS AND NOT A NEW TABLE OR A NEW OPERATION. A `kind_read_marks` table
-- with a `spaces.counts.mark` operation to write it is the obvious design, and
-- it is worse here for two reasons. It adds a row to `packages/contract`'s
-- OPERATIONS catalog, which is a documented ~20-pin cascade across five
-- packages for a feature that needs no new client call. And it invents a
-- second, parallel record of "the member looked at this" beside `read_marks`,
-- which the UI ALREADY writes unconditionally on every entity open
-- (`views/open-entity.ts`: "an entity you looked at is one you have seen").
-- The signal is already in the database. This file reads it.
--
-- CONSEQUENCE, STATED PLAINLY: the watermark now SELF-ADVANCES for any kind
-- the member actually opens, which is what makes the badge clearable by using
-- the product instead of by a migration. For a kind the member never opens it
-- still falls back to `counters_since` and still saturates. That is not fixed
-- here and does not need to be: the client change shipping with this migration
-- stops such kinds (commit, pull_request, file, doc, ...) from drawing an
-- unseen badge at all. A number nobody can clear should not be shown, and the
-- decision about which kinds carry one is registry data, not schema.
--
-- WHAT IS NOT CHANGED. `total` — same rows, same predicate, same number.
-- The visibility predicate 158 so carefully inlined, verbatim, including the
-- restricted-project carve-out and the credential-session exclusion. The
-- signature, grants, volatility, security context and result shape. No RLS
-- policy. No table is altered. `public.unread_counts` is not touched.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- `public.space_kind_counts` — the dashboard's numbers.
--
-- Last defined in 158 (which changed how visibility is read, not what unseen
-- means). Reproduced verbatim except for the `me` CTE's companion `kind_marks`
-- CTE, its LEFT JOIN, and the `filter (...)` expression.
--
-- ON `kind_marks` AND DISCLOSURE. It joins `read_marks` to `entities` WITHOUT
-- restating the readability predicate, and that is safe in the one direction
-- that matters. Every row it can see is a row THIS MEMBER already marked read,
-- so it discloses nothing they have not already opened; and its only effect on
-- the output is to RAISE a watermark, which can only ever make `unseen`
-- smaller. It cannot cause a restricted entity to be counted, because the
-- counting scan below is unchanged and still filters `e` itself. A mark on a
-- since-deleted entity likewise only raises the watermark, which is correct:
-- you did look at it, on that date.
--
-- `left join kind_marks` cannot fan out the scan: `kind_marks` is grouped by
-- `kind` and so holds at most one row per key.
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
  ),
  kind_marks as (
    select marked_entity.kind, max(mark_row.last_read_at) as last_read_at
      from public.read_marks mark_row
      join public.entities marked_entity
        on marked_entity.id = mark_row.anchor_id
     where mark_row.member_id = (select member_id from me)
       and marked_entity.space_id = p_space_id
     group by marked_entity.kind
  )
  select e.kind,
         count(*)::integer as total,
         -- CREATED after the watermark. Was `e.activity_at > ...`; see header.
         count(*) filter (
           where e.created_at > greatest(
             coalesce((select counters_since from me), '-infinity'::timestamptz),
             coalesce(kind_mark.last_read_at, '-infinity'::timestamptz)
           )
         )::integer as unseen
    from public.entities e
    -- WAS: `left join public.read_marks ... on mark_row.anchor_id = e.id`, one
    -- mark per ROW. Now one watermark per KIND, which is the granularity the
    -- number is reported at and the only granularity a member can clear.
    left join kind_marks kind_mark
      on kind_mark.kind = e.kind
   where e.space_id = p_space_id
     and e.deleted_at is null
     and internal.is_space_member(p_space_id)
     -- Unchanged from 158: the readability predicate read off `e` rather than
     -- looked up per row. See that file's header for the measurement.
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
     -- `kind_mark.last_read_at` is grouped, not aggregated, because it appears
     -- inside the `filter` above. It is 1:1 with `e.kind` (`kind_marks` is
     -- itself grouped by kind), so this produces exactly the same groups as
     -- `group by e.kind` did — one row per kind, as the signature promises.
   group by e.kind, kind_mark.last_read_at
$$;
revoke all on function public.space_kind_counts(uuid) from public;
grant execute on function public.space_kind_counts(uuid) to tm8_app;
