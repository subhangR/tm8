-- 047 — allow the HTTP liveness handler to read execution capacity.
--
-- execution.liveness runs this read-only function directly as tm8_app rather
-- than through a SECURITY DEFINER RPC. Migration 006 revoked the schema-wide
-- default and no later migration restored this one explicit capability.

set role tm8_graph_owner;

grant execute on function internal.live_work_session_count(uuid) to tm8_app;

reset role;
