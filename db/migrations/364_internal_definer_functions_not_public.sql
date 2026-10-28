-- =============================================================================
-- 364: no SECURITY DEFINER function in `internal` is executable by PUBLIC.
--
-- 001-008 closed the schema with `revoke all on all functions in schema
-- internal from public`, but that statement only reaches functions that exist
-- when it runs. A function created later gets Postgres's default EXECUTE to
-- PUBLIC, and nineteen SECURITY DEFINER helpers created since then never had it
-- revoked. tm8_app holds USAGE on `internal` (the RLS policies call
-- internal.identity_id()), so it could call each of them directly, as the
-- function owner, with no claims bound. For example:
--
--   set role tm8_app;
--   select internal.stop_work_session_core(<any session>, <any actor>, 'x');
--
-- stopped a session in any space, ended its claims and recorded the chosen
-- actor as `outcome_by`. The public wrappers (302's stop_work_session,
-- complete_work_session, ...) do the live-entity and membership checks; the
-- *_core helpers do none, because they were only ever meant to be reached
-- through those wrappers.
--
-- No app code calls them directly: each is reached from another SECURITY
-- DEFINER function or a trigger, so it runs as an owner role, and the one owner
-- that needs an explicit grant gets it below. The trigger functions here could
-- not be called directly anyway; they are revoked too so that the catalog
-- invariant is exact. db/test/function_grants.test.mjs
-- pins that invariant, so the next function that misses its revoke fails CI
-- instead of shipping.
-- =============================================================================

revoke all on function internal.caller_work_session(uuid) from public;
revoke all on function internal.complete_work_session_core(uuid, uuid, uuid) from public;
revoke all on function internal.end_claims(uuid[], text, text, uuid, timestamptz) from public;
revoke all on function internal.mcp_security_fingerprint(uuid) from public;
revoke all on function internal.member_for_actor(uuid, uuid) from public;
revoke all on function internal.reopen_session(uuid, text, text, uuid) from public;
revoke all on function internal.require_delivery_principal(uuid, uuid, uuid) from public;
revoke all on function internal.resolve_session_receipt(uuid, uuid) from public;
revoke all on function internal.stop_work_session_core(uuid, uuid, text, text) from public;

-- What the PUBLIC grant was silently carrying: definer functions owned by
-- tm8_graph_owner call these across owners (link_project_w2 ->
-- member_for_actor, the tool-session RPCs -> caller_work_session, the delivery
-- RPCs -> require_delivery_principal, the MCP credential reads ->
-- mcp_security_fingerprint), and the edges_working_on_claim_defaults trigger
-- reaches reopen_session as whichever owner did the insert. The migrating role
-- owns the rest or is a member of tm8_graph_owner, so tm8_graph_owner is the one
-- grant needed. db/test caught the missing grant as "permission denied for
-- function member_for_actor" in every world-building suite.
grant execute on function internal.caller_work_session(uuid) to tm8_graph_owner;
grant execute on function internal.complete_work_session_core(uuid, uuid, uuid) to tm8_graph_owner;
grant execute on function internal.end_claims(uuid[], text, text, uuid, timestamptz) to tm8_graph_owner;
grant execute on function internal.mcp_security_fingerprint(uuid) to tm8_graph_owner;
grant execute on function internal.member_for_actor(uuid, uuid) to tm8_graph_owner;
grant execute on function internal.reopen_session(uuid, text, text, uuid) to tm8_graph_owner;
grant execute on function internal.require_delivery_principal(uuid, uuid, uuid) to tm8_graph_owner;
grant execute on function internal.resolve_session_receipt(uuid, uuid) to tm8_graph_owner;
grant execute on function internal.stop_work_session_core(uuid, uuid, text, text) to tm8_graph_owner;

-- Trigger functions: not callable outside a trigger, revoked for the invariant.
revoke all on function internal.apply_space_session_sharing_default() from public;
revoke all on function internal.chat_assign_turn_order() from public;
revoke all on function internal.chat_capture_part() from public;
revoke all on function internal.check_runs_on_pairing() from public;
revoke all on function internal.claims_follow_task_status() from public;
revoke all on function internal.craft_workspaces_prune_page() from public;
revoke all on function internal.emit_work_session_events() from public;
revoke all on function internal.project_runs_on_edge() from public;
revoke all on function internal.task_state_nudge_on_status() from public;
revoke all on function internal.task_state_nudge_on_unassign() from public;

do $$
declare
  leaked text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into leaked
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'internal'
     and p.prosecdef
     and has_function_privilege('public', p.oid, 'execute');
  if leaked is not null then
    raise exception '364 VERIFY: SECURITY DEFINER functions in internal still executable by PUBLIC: %', leaked;
  end if;
end
$$;
