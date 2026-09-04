-- =============================================================================
-- 162  `public.set_session_done` STOPS BEING EXECUTABLE BY EVERY ROLE.
--
-- ITS OWN PR ON PURPOSE. This began life as a second commit on the task-anchor
-- fan-out branch (#441), because that is where the red was noticed. Review said
-- to split it, and review was right: this is a one-line security repair that
-- reds EVERY PR branched after 156, and it should not wait on a debate about
-- message routing. It carries no dependency on that branch in either direction.
--
-- It repairs 156, and it is a separate migration for exactly the reason every
-- file in this directory is: its own blast radius, revertible on its own.
--
-- THE DEFECT. 156 creates `public.set_session_done` -- the tick -- as SECURITY
-- DEFINER and then neither revokes nor grants it. Postgres gives a new function
-- EXECUTE to PUBLIC by default, so the door is callable by every role that can
-- connect, including `tm8_delivery_worker`, which exists precisely so that the
-- delivery adapter holds three RPCs and nothing else. Its three sibling doors in
-- 150 (`execution_spawn` and friends) each restate `revoke ... from public` +
-- `grant execute ... to tm8_app`; 156 is the one that does not.
--
-- HOW IT SURFACES, AND WHY IT IS WORTH ITS OWN FILE. As a red test on EVERY open
-- PR branched after 156 -- still true as of 2026-08-20, re-checked against
-- origin/main at 69540f1e, which contains no revoke or grant for this function
-- anywhere in db/migrations:
--
--   test/db/w2-execution.pg.test.ts
--     > "cleanup runs on the existing owner path -- no fourth delivery RPC"
--     AssertionError: expected [ ...(4) ] to deeply equal [ ...(3) ]
--     +   "set_session_done"
--
-- That assertion enumerates `has_function_privilege('tm8_delivery_worker', ...)`
-- over schema `public` and pins the delivery role's whole surface at three
-- names. It is the same detector that caught 132's missing revokes and was
-- repaired by 138, and it is doing its job again: a PUBLIC grant is not visible
-- in a diff of the function, only in a diff of the SURFACE.
--
-- The function's own body still authorizes its caller, so this is a defence in
-- depth restored rather than an open door closed -- but the delivery role's
-- surface is a stated invariant with a test behind it, and a stated invariant
-- that has drifted is worth a file whether or not it is reachable today.
--
-- NO `create or replace` HERE ON PURPOSE. Re-declaring the body to fix a grant
-- would put a second copy of a 90-line door in the chain that a later reader has
-- to diff against 156 to trust. Grants are separable from bodies, so this file
-- changes only grants.
-- =============================================================================

revoke all on function public.set_session_done(uuid, integer, uuid, text) from public;
grant execute on function public.set_session_done(uuid, integer, uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- VERIFY -- exactly what THIS FILE establishes, and not one thing more.
--
-- The first draft asserted the delivery role's WHOLE surface, the way the test
-- does, and it was wrong the moment it ran: `w2-profiles.pg.test.ts` applies a
-- FROZEN TRANCHE rather than the whole chain, and mid-chain that surface
-- legitimately holds `w2_edit_message` and `w2_tombstone_message`, which later
-- files revoke. A migration is replayed at every position in history that has
-- ever existed, so its VERIFY may only assert an invariant its own statements
-- have just created. The whole-surface pin belongs where it already lives — in
-- a test, which always runs against a complete chain.
-- -----------------------------------------------------------------------------
do $verify$
begin
  if has_function_privilege(
       'tm8_delivery_worker',
       'public.set_session_done(uuid, integer, uuid, text)', 'EXECUTE') then
    raise exception 'set_session_done is still executable by the delivery role';
  end if;
  if not has_function_privilege(
       'tm8_app',
       'public.set_session_done(uuid, integer, uuid, text)', 'EXECUTE') then
    raise exception 'set_session_done must remain executable by tm8_app';
  end if;
end
$verify$;
