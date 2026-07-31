-- =============================================================================
-- 058 — indexes for the UNFILTERED collections.query sort paths.
--
-- `collections.query` with no `kinds` filter — the home feed, "everything in
-- this space", and every list a client opens before narrowing — runs
--
--     where e.space_id = $1 and e.deleted_at is null
--     order by e.activity_at desc, e.id desc          (activityAt_desc, DEFAULT)
--     order by e.created_at  desc, e.id desc          (createdAt_desc)
--
-- The only existing candidates lead with `kind` in the second position
-- (001_core_graph.sql:346-347), so the planner cannot use them to satisfy this
-- ordering: measured on a live space, it bitmap-scans every live row and
-- top-N-sorts — O(rows in space) per page, on the DEFAULT path of the busiest
-- read in the product. With these two partial indexes the same query is a pure
-- index-only scan that stops at the LIMIT: O(page), flat as the space grows.
-- (Verified with EXPLAIN ANALYZE before/after in a rolled-back transaction:
-- Sort node gone, Index Only Scan, cost 14.4 → 4.7 at 219 rows.)
--
-- Partial on `deleted_at is null` because the read path always filters live
-- rows; tombstones stay out of the index entirely, matching
-- entities_parent_position_idx's precedent (001:348).
-- =============================================================================
set role tm8_graph_owner;

create index entities_space_activity_live_idx
  on public.entities(space_id, activity_at desc, id desc)
  where deleted_at is null;

create index entities_space_created_live_idx
  on public.entities(space_id, created_at desc, id desc)
  where deleted_at is null;

reset role;
