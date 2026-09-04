-- 138 — repair 132's missing PUBLIC revoke (found by this lane's CI run on
-- PR #292; the defect is main's, the fix rides here because the detector
-- that catches it — w2-execution.pg.test.ts's tm8_delivery_worker surface
-- enumeration — blocks every PR until someone repairs it).
--
-- 132 created two SECURITY DEFINER functions and granted them to tm8_app,
-- but never revoked PUBLIC's default EXECUTE. A definer function is callable
-- by every role until revoked (008's wholesale revoke was a one-time
-- statement; 050/053/056/091 all restate the rule and carry their own
-- revoke+grant pair — 132 is the one that forgot). Concretely measured:
-- `tm8_delivery_worker`, whose whole surface is meant to be the three
-- delivery RPCs, could execute upsert_task_workflow and
-- delete_task_workflow through PUBLIC.
--
-- Full argument signatures, nothing inherited — the 091 wording.

set role tm8_graph_owner;

revoke all on function public.upsert_task_workflow(uuid, text, text[], text) from public;
revoke all on function public.delete_task_workflow(uuid, uuid, text) from public;

-- tm8_app's own grant (132) is unaffected by the PUBLIC revoke; restated
-- here so this file leaves the intended surface explicit rather than implied.
grant execute on function
  public.upsert_task_workflow(uuid, text, text[], text),
  public.delete_task_workflow(uuid, uuid, text)
to tm8_app;

reset role;
