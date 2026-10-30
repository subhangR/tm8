-- =============================================================================
-- 406 — Bridges B1b-5 (option B, B1b coordinator ruling 2026-10-30): the hub's
-- `connect` is a member request, so it runs under the begin caller's own
-- claims and internal.bridge_runtime_connect admits that caller only when
-- they own the connection.
--
-- internal.bridge_runtime_connect is restated from 398 (its only and latest
-- definition); the one change is the gate. Before, only the in-process
-- bridges worker could call it, so bridges.connections.begin had to bind the
-- worker's backgroundJob claim inside a member's request. Now the gate
-- admits:
--   * the bridges worker (internal.is_bridges_worker(), unchanged), or
--   * a human auth kind whose account owns the connection
--     (owner_account_id = internal.current_account_id());
-- and refuses everything else with 42501, reason not_connection_owner.
-- Nothing else in 398 is touched.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function internal.bridge_runtime_connect(p_connection uuid, p_runtime_id text) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections;
begin
  -- 406: the worker, or the number's human owner (was internal.require_bridges_worker()).
  -- The human test is 083's internal.require_human_auth_kind itself, not a copy
  -- of its kind list, so a later human kind (mobile) is admitted here too.
  if not internal.is_bridges_worker() then
    begin
      perform internal.require_human_auth_kind();
    exception when insufficient_privilege then
      raise exception 'only the connection''s owner, at a keyboard, can connect it' using errcode = '42501',
        detail = jsonb_build_object('reason', 'not_connection_owner')::text;
    end;
    if not exists (select 1 from public.bridge_connections c
                    where c.id = p_connection and c.owner_account_id = internal.current_account_id()) then
      raise exception 'only the connection''s owner can connect it' using errcode = '42501',
        detail = jsonb_build_object('reason', 'not_connection_owner')::text;
    end if;
  end if;
  update public.bridge_connections set runtime_id = p_runtime_id
   where id = p_connection and status <> 'removed' returning * into conn;
  if conn.id is null then raise exception 'bridge connection not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('connectionId', conn.id, 'provider', conn.provider,
                            'allowlist', internal.bridge_allowlist_frame(conn.id));
end
$$;
revoke all on function internal.bridge_runtime_connect(uuid, text) from public;
grant execute on function internal.bridge_runtime_connect(uuid, text) to tm8_app;

reset role;
