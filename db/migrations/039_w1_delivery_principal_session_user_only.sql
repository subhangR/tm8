-- =============================================================================
-- 039  W1 — internal.require_delivery_principal must require the delivery
--           worker to be AUTHENTICATED, not merely ASSUMED.
--
-- THE DEFECT, at 015:1346-1347
--
--   if session_user <> 'tm8_delivery_worker'
--      and coalesce(current_setting('role', true), '') <> 'tm8_delivery_worker' then
--
--   It is an AND, so satisfying EITHER limb passes. A SUPERUSER MAY ASSUME ANY
--   ROLE, so `set local role tm8_delivery_worker` from a superuser connection
--   satisfies the second limb and the guard admits it. The closed three-RPC
--   delivery surface is therefore reachable by any principal PERMITTED TO ASSUME
--   the role — a maintenance script, a second node, a psql session.
--
-- WHY session_user IS THE LIMB THAT SURVIVES
--
--   session_user is fixed at AUTHENTICATION and is the one value SET ROLE cannot
--   change. Measured on the applied chain: as a superuser, after
--   `set local role tm8_delivery_worker`, current_user and current_setting('role')
--   BOTH read tm8_delivery_worker while session_user still reads the superuser.
--   A guard written against current_user — or against current_setting('role'),
--   which is what the deleted limb reads — PASSES IN EXACTLY THE CASE IT EXISTS
--   TO CATCH. This is the same reasoning already load-bearing in the boot guard
--   at facade/services/w2/execution.ts:355-368, which asserts session_user.
--
--   NOTE FOR ANYONE TEMPTED TO SIMPLIFY THIS FURTHER: current_setting(
--   'is_superuser') is NOT a safe substitute either. SET ROLE to a non-superuser
--   DROPS that flag, so is_superuser=off is not evidence of a non-superuser
--   CONNECTION. The correct predicate is pg_roles.rolsuper WHERE rolname =
--   session_user, which is what the boot guard uses. Recorded here because it is
--   the plausible-looking simplification that silently reintroduces the class.
--
-- WHY THIS DOES NOT BREAK THE PRODUCTION PATH — measured, not reasoned
--
--   PgW2DeliveryRpcPort.withPrincipal (facade/services/w2/execution.ts:394)
--   issues `set local role tm8_delivery_worker` UNCONDITIONALLY, including on a
--   connection already authenticated as that role. That still works: a role may
--   always SET ROLE to itself, even one created `noinherit` with no memberships.
--   Verified on the applied chain rather than assumed — had it failed, this
--   migration would have broken delivery while passing every test that described
--   it. And the authenticated worker passes on session_user ALONE, with no
--   `set local role` at all, so the surviving limb is sufficient even if that
--   line is ever removed.
--
-- SCOPE. This is a create-or-replace of ONE internal function. Exactly one
-- catalog signature differs. The body below is the runtime pg_get_functiondef
-- text from the applied 34-file chain with the second disjunct deleted and
-- NOTHING else changed — all four remaining checks (principal tuple, budget
-- version, expiry, no actor claims) are carried over verbatim.
--
-- WHAT THIS IS NOT. It does not constrain what an operator puts in a connection
-- URL; it constrains what the database will accept once connected. The boot
-- guard remains a separate, complementary mitigation. And the guard still checks
-- WHICH role authenticated, never HOW — the TRUST-auth environment caveat is a
-- separate and unaffected fact.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.require_delivery_principal(
  expected_delivery uuid, expected_message uuid, expected_target uuid,
  expected_budget_version integer default null
) returns void language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare expires_at timestamptz;
begin
  -- TIGHTENED (039). Was an AND with current_setting('role'), which a superuser
  -- satisfied by assuming the role. session_user survives SET ROLE; that is the
  -- entire point.
  if session_user <> 'tm8_delivery_worker' then
    raise exception 'system delivery adapter database role required' using errcode = '42501';
  end if;
  if internal.claim_text('tm8.principal_type') <> 'system_delivery_adapter'
     or nullif(internal.claim_text('tm8.delivery_id'), '')::uuid is distinct from expected_delivery
     or nullif(internal.claim_text('tm8.delivery_message_id'), '')::uuid is distinct from expected_message
     or nullif(internal.claim_text('tm8.delivery_target_work_session_id'), '')::uuid
          is distinct from expected_target then
    raise exception 'delivery principal tuple mismatch' using errcode = '42501';
  end if;
  if expected_budget_version is not null
     and nullif(internal.claim_text('tm8.delivery_pair_budget_version'), '')::integer
          is distinct from expected_budget_version then
    raise exception 'delivery reservation version mismatch' using errcode = '42501';
  end if;
  expires_at := nullif(internal.claim_text('tm8.delivery_expires_at'), '')::timestamptz;
  if expires_at is null or expires_at <= now() then
    raise exception 'delivery principal expired' using errcode = '42501';
  end if;
  if internal.actor_id() is not null or internal.acting_as() is not null then
    raise exception 'delivery principal cannot carry actor claims' using errcode = '42501';
  end if;
end
$$;

reset role;
