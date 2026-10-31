-- =============================================================================
-- 426 — Bridges: public.bridge_runtime_state could never succeed.
-- (426, not 425: #1479 holds 425_bridge_handover_followups.)
--
-- 398 declared a plpgsql variable `self_ids` in a function whose UPDATE sets
-- the column `bridge_connections.self_ids`. The bare `self_ids` on the SET
-- right-hand side is ambiguous, so every connection.state frame failed with
-- 42702 "column reference "self_ids" is ambiguous" (mapped to 503). The
-- runtime's link code and every status change ride that frame, so no number
-- could link: the dialog sat at "Waiting for WhatsApp to send a code…".
-- Found on prod 2026-10-31, the first time a runtime was attached there.
--
-- public.bridge_runtime_state is restated from 398 (its only and latest
-- definition); the one change is the variable's name, v_self_ids.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function public.bridge_runtime_state(p_frame jsonb) returns jsonb
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections; st text := p_frame ->> 'status'; v_self_ids text[];
begin
  perform internal.bridge_runtime_session();
  if st not in ('connecting', 'linked', 'logged_out', 'offline') then
    raise exception 'unknown connection status' using errcode = '22023';
  end if;
  select array_remove(array[p_frame #>> '{self,id}', p_frame #>> '{self,lid}'], null) into v_self_ids;
  update public.bridge_connections
     set status = st, last_seen_at = now(),
         self_ids = case when cardinality(v_self_ids) > 0 then v_self_ids else bridge_connections.self_ids end,
         external_account_id = coalesce(p_frame #>> '{self,id}', external_account_id)
   where id = (p_frame ->> 'connectionId')::uuid and status <> 'removed'
  returning * into conn;
  if conn.id is null then raise exception 'bridge connection not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('connectionId', conn.id, 'status', conn.status);
end
$$;
revoke all on function public.bridge_runtime_state(jsonb) from public;
grant execute on function public.bridge_runtime_state(jsonb) to tm8_app;

reset role;
