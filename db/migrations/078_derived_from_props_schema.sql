-- =============================================================================
-- 078 — every registered edge type publishes a props schema again.
--
-- NUMBERED 078 because origin/main's chain ends at 077_notify_anchor_watchers.sql.
-- Authored on origin/feat/per-user-private-workspaces and brought here unchanged
-- except for this paragraph; that branch is unmerged, so the defect below is live
-- on main and on every database built from it.
--
-- NUMBER CONTENTION, stated rather than discovered on merge: two other unmerged
-- branches also claim 078 (078_private_projects.sql,
-- 078_worktree_provisioning_and_tracking_observer.sql). db/migrate.mjs hard-fails
-- on a duplicate three-digit prefix, so whichever of those lands after this one
-- must renumber. That is unavoidable from here — 078 is simply the next free
-- number on main — and it is cheaper to renumber a file than to ship a second
-- migration doing the same repair under a different name.
--
-- WHAT WAS WRONG. 018 established the registry invariant that EVERY row of
-- public.edge_types carries a props_schema: it backfilled one for every type
-- shipped up to that point ('{}' properties plus additionalProperties: true for
-- the ones with no known semantic fields), and 018's own suite asserts it —
--
--     select count(*) filter (where props_schema is null) from public.edge_types
--
-- must be 0 (packages/server/test/db/w2-edges-placements.pg.test.ts:290).
--
-- 064 then registered `derived_from` WITHOUT one. Every other type added after
-- 018 supplied its own (056 memory types, 057 in_worktree, 065 anchored_to /
-- messaged, 066 created_in); 064 is the single omission, and it is null on prod
-- today. So the assertion fails on any database whose chain reaches 064.
--
-- WHY IT IS NOT COSMETIC. `internal.validate_edge_props_schema` (018:94) opens
-- with `if schema is null then return new; end if;`, so a null registry row is
-- not "no fields declared", it is NO VALIDATION AT ALL — `derived_from` is the
-- one edge type whose props are unchecked on insert and update. The registry
-- reads as though it enforces something it does not.
--
-- THE SCHEMA CHOSEN. The same open object 018 gave every type with no known
-- semantic fields. `derived_from` is written by exactly one caller
-- (public.derive_task_for_entity, 064:197) which supplies no props, and it is
-- not in the origin-stamping list of internal.guard_w1_edge (066), so it has no
-- field to declare — what it needs is the enforced OBJECT shape, not new fields.
--
-- THE DEFAULT is the durable half. The backfill fixes the one row that exists;
-- the column default means the next migration that registers a type and forgets
-- props_schema lands on the open object rather than silently re-opening the same
-- hole. Both halves are guarded so re-running the chain changes nothing.
-- =============================================================================
set role tm8_graph_owner;

update public.edge_types
   set props_schema = jsonb_build_object(
     'type', 'object',
     'properties', '{}'::jsonb,
     'additionalProperties', true
   )
 where props_schema is null;

alter table public.edge_types
  alter column props_schema set default jsonb_build_object(
    'type', 'object',
    'properties', '{}'::jsonb,
    'additionalProperties', true
  );

comment on column public.edge_types.props_schema is
  'Object schema enforced on edges.props by internal.validate_edge_props_schema. '
  'Every registered type publishes one (018); the 071 default keeps that true '
  'for types registered later.';

reset role;
