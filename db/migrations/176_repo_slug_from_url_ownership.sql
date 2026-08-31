-- =============================================================================
-- 176  `internal.repo_slug_from_url` GETS THE OWNER THE REST OF THE SCHEMA HAS.
--
-- ITS OWN FILE, for the reason every file in this directory is: one defect, one
-- blast radius, revertible on its own. It repairs 148. It changes no body and
-- no behaviour that a caller can observe -- it changes an OWNER and a GRANT, so
-- that a door which has been throwing since 2026-08-18 stops throwing.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
--
-- Nearly every function in `public` and `internal` is created inside
-- `set role tm8_graph_owner; ... reset role;` -- 001:68/1230 establishes the
-- convention and ~40 files restate it. 148 omits it. Postgres therefore made
-- the migration runner (`tm8`, a SUPERUSER) the owner of the one function that
-- file creates, and 148's grant names only `tm8_app`:
--
--   internal | repo_slug_from_url | owner=tm8              | {tm8=X/tm8,tm8_app=X/tm8}
--   internal | pr_owning_session  | owner=tm8_graph_owner  | (default)
--   public   | observer_watch_targets | owner=tm8_graph_owner secdef=t
--
-- 148's own comment reasons the grant out loud, and reasons it in the wrong
-- direction (148:113-116):
--
--   "tm8_app needs it because `pr_owning_session` is STABLE, not SECURITY
--    DEFINER -- the nested call runs as whoever called the outer function."
--
-- The nested call does run as whoever called the outer function. But the outer
-- function is `public.observer_watch_targets`, which IS SECURITY DEFINER
-- (103:400), so "whoever called" is its DEFINER -- `tm8_graph_owner` -- and not
-- the `tm8_app` session that invoked the door. `tm8_graph_owner` is the one
-- role 148 did not grant.
--
-- Reproduced read-only against prod (tm8_prod @ 5442) on 2026-08-31:
--
--   => set role tm8_graph_owner; select internal.repo_slug_from_url('...');
--   ERROR:  permission denied for function repo_slug_from_url
--
--   => select has_function_privilege(
--        'tm8_graph_owner','internal.repo_slug_from_url(text)','execute');
--   f
--
-- ── HOW IT SURFACES ─────────────────────────────────────────────────────────
--
-- As the ONLY permanently-failing background job on the node. `/health`:
--
--   {"name":"tracking.forge-watcher","state":"idle",
--    "lastError":"permission denied for function repo_slug_from_url",
--    "runs":1231,"failures":1231}
--
-- 1231 of 1231 -- every run since the process started, and by inspection every
-- run since 148 was applied (2026-08-18 18:14 UTC), because the throw is on the
-- FIRST statement of the tick and cannot be reached conditionally.
--
-- The chain, once, in full:
--
--   loops.ts:107   db.rpc('public.observer_watch_targets', ...)   <- NOT in a try
--     -> public.observer_watch_targets      security definer, owner tm8_graph_owner
--        -> internal.pr_owning_session      stable, NOT secdef -> still graph_owner
--           -> internal.repo_slug_from_url  owner tm8, no grant to graph_owner
--              -> 42501
--
-- That `rpc` sits ABOVE the per-target try/catch (loops.ts:130-141) and above
-- the nudge drain's own try/catch (loops.ts:150-158), so the exception ends the
-- whole tick. Two consequences, both visible in prod data:
--
--   * 52 open/draft pull requests carry a `tracks` edge and are therefore in the
--     watch list. None has been polled since. PR state, CI status and mergeable
--     state on the UI are frozen at whatever the queue-driven observer last
--     happened to fetch.
--
--   * `public.pending_session_nudges` -- the queue the drain exists to empty --
--     holds 3 rows in status `pending` with `attempts = 0`, the oldest detected
--     2026-08-17. `attempts` is still 0 because the drain is never reached, not
--     because delivery failed. The last row to reach `delivered` is dated
--     2026-08-15, three days before 148.
--
-- ── THE REPAIR, AND WHY IT IS THE OWNER AND NOT JUST A GRANT ────────────────
--
-- A bare `grant execute ... to tm8_graph_owner` would also clear the 42501, and
-- it would leave a SUPERUSER owning a function in `internal` -- the state 148
-- created by accident and the state the `set role` convention exists to
-- prevent. `alter ... owner to` fixes the cause rather than the symptom, and it
-- is the smaller long-term surface: an owner has EXECUTE implicitly, so the
-- grant list shrinks instead of growing.
--
-- Safe because ownership on this function carries no other meaning: it is
-- `language sql`, `immutable`, and NOT `security definer`, so nothing executes
-- with its owner's authority. Postgres rewrites the grantor in the existing ACL
-- on `alter owner`, so `tm8_app`'s EXECUTE from 148 survives; it is restated
-- below anyway, because a grant that is only implied by a rewrite rule is a
-- grant the next reader has to look up.
--
-- NO `create or replace` HERE ON PURPOSE, per 162: re-declaring the body to fix
-- a privilege would put a second copy of the function in the chain that a later
-- reader has to diff against 148 to trust. Grants and owners are separable from
-- bodies, and this file changes only grants and owners.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
--
-- 27 other functions share the same accidental `tm8` ownership, all created by
-- the same missing `set role` in 15 files (142, 144, 145, 148, 153, 154, 156,
-- 158, 161, 162, 163, 165, 166, 168, 171). They are NOT touched here. Every one
-- of the others is either SECURITY DEFINER -- so it runs as `tm8` and works,
-- wrongly but not visibly -- or has default PUBLIC execute. Only this one sits
-- non-secdef beneath a `tm8_graph_owner` definer, which is what turns a smell
-- into an outage. Re-owning the other 27 is a real repair with a real blast
-- radius (it changes the authority 21 SECURITY DEFINER doors execute WITH) and
-- it belongs in its own file, behind its own test run.
--
-- The durable fix for the CLASS is a check in `tools/ci/migrations-check.sh`,
-- which today asserts nothing about `set role` -- that is why 15 files drifted
-- without a single red. Also its own change.
-- =============================================================================

alter function internal.repo_slug_from_url(text) owner to tm8_graph_owner;

revoke all on function internal.repo_slug_from_url(text) from public;
grant execute on function internal.repo_slug_from_url(text) to tm8_app;

-- -----------------------------------------------------------------------------
-- VERIFY -- exactly what THIS FILE establishes, and not one thing more.
--
-- Per 162: a migration is replayed at every position in history that has ever
-- existed, so its VERIFY may only assert an invariant its own statements have
-- just created. Three assertions, all local to this function:
--
--   1. the definer chain can now execute it   (the outage, gone)
--   2. tm8_app can still execute it           (148's intent, preserved)
--   3. PUBLIC cannot                          (001:1227's posture, restated)
--
-- The end-to-end pin -- that `observer_watch_targets` returns rows rather than
-- raising 42501 -- belongs in a real-DB test, not here: it needs a PR row, a
-- `tracks` edge and an identity, none of which a migration may invent.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if not has_function_privilege(
       'tm8_graph_owner', 'internal.repo_slug_from_url(text)', 'EXECUTE') then
    raise exception
      'repo_slug_from_url is still not executable by tm8_graph_owner -- '
      'the forge watcher will keep raising 42501';
  end if;

  if not has_function_privilege(
       'tm8_app', 'internal.repo_slug_from_url(text)', 'EXECUTE') then
    raise exception 'repo_slug_from_url must remain executable by tm8_app (148)';
  end if;

  if has_function_privilege(
       'public', 'internal.repo_slug_from_url(text)', 'EXECUTE') then
    raise exception 'repo_slug_from_url must not be executable by PUBLIC';
  end if;
end
$verify$;
