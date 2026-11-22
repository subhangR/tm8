-- =============================================================================
-- 451 — Vault alerts reach the owner's inbox (Secure Vault brief v2, MSG 14
-- test 8 "owner alerted"; task 01a1fa87-dd1a, WS-A subtask 01a1fac0-e086).
--
-- Builds on 003 (public.notifications), 015 (recipient_team_member_id) and 227
-- (the grant style for internal helpers). Restates no earlier object.
--
-- WHAT RAISES AN ALERT. The vault broker (packages/vault) raises one, metadata
-- only, when it refuses an egress call, detects a canary, refuses a value
-- request, sees repeated fill failures, a passkey from a new device, a used
-- recovery code, refresh-token reuse, a pending approval or an audit outage.
-- It carries pending alerts to the tm8 server on the x-tm8-vault-alerts header
-- of an attested response. The relay (packages/server/src/vault/relay.ts)
-- strips that header, never forwards it, and calls internal.vault_notify once
-- per alert.
--
-- WHY A DEFINER FUNCTION. The broker's queue is global: an alert for a member
-- of space B can ride on the response to a caller in space A, so the write
-- cannot be authorised as that caller. tm8_app has no insert on notifications
-- (every other row is written by a trigger), and this function is the only way
-- the vault writes one. It writes nothing, and returns null, unless:
--   * the kind is one of the nine broker alert kinds (VAULT_ALERT_KINDS in
--     packages/vault/src/core-types.ts; the relay test pins the parity),
--   * the recipient is an ACTIVE member of the named space, and
--   * params is a JSON object of at most 4 KiB.
-- So the most a caller holding tm8_app can do with it is put a vault-kind row
-- in the inbox of a member of the space it names. It cannot read, cannot write
-- any other kind, and never touches schema vault (450: tm8_app has no access).
--
-- ONE ROW PER BURST. An unread row of the same kind, for the same item and
-- recipient, created in the last 15 minutes, is bumped (payload.count,
-- payload.lastAt) instead of repeated, so an agent looping on a refused egress
-- call cannot flood the owner's inbox.
--
-- THE ROW. kind = 'vault_' || alert kind, so the inbox reads "Vault canary
-- detected" with no UI change (tm8-ui inbox-model.ts humanises unknown kinds
-- and files them under EVERYTHING ELSE). No target and no actor: a vault item
-- is not a graph entity, and the broker names no actor. The payload carries the
-- alert kind, item id, params, first and last time and a count. No value and no
-- secret ever: the broker schema-checks and canary-scans params before it
-- queues an alert (packages/vault/src/broker/alerts.ts).
-- =============================================================================

create or replace function internal.vault_notify(
  p_space uuid, p_member uuid, p_kind text, p_item uuid, p_params jsonb, p_at timestamptz
) returns uuid
language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  v_kind text;
  v_id uuid;
begin
  if p_space is null or p_member is null or p_at is null or p_kind is null
     or p_kind not in ('egress_refused', 'canary_detected', 'value_request_refused',
                       'fill_repeated_failures', 'passkey_new_device', 'recovery_code_used',
                       'refresh_reuse_detected', 'approval_requested', 'audit_unavailable')
     or p_params is null or jsonb_typeof(p_params) <> 'object'
     or octet_length(p_params::text) > 4096 then
    return null;
  end if;
  if not exists (select 1 from public.members m
                  where m.entity_id = p_member and m.space_id = p_space and m.status = 'active') then
    return null;
  end if;

  v_kind := 'vault_' || p_kind;
  select n.id into v_id
    from public.notifications n
   where n.recipient_member_id = p_member
     and n.recipient_team_member_id is null
     and n.space_id = p_space
     and n.kind = v_kind
     and n.read_at is null
     and n.created_at > now() - interval '15 minutes'
     and (n.payload->>'itemId') is not distinct from p_item::text
   order by n.created_at desc, n.id desc
   limit 1
   for update;
  if v_id is not null then
    update public.notifications
       set payload = payload
         || jsonb_build_object('count', coalesce((payload->>'count')::int, 1) + 1,
                               'lastAt', greatest(p_at, (payload->>'lastAt')::timestamptz))
     where id = v_id;
    return v_id;
  end if;

  insert into public.notifications(space_id, recipient_member_id, kind, payload)
  values (p_space, p_member, v_kind,
          jsonb_build_object('alert', p_kind, 'itemId', p_item, 'params', p_params,
                             'at', p_at, 'lastAt', p_at, 'count', 1))
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function internal.vault_notify(uuid, uuid, text, uuid, jsonb, timestamptz) from public;
grant execute on function internal.vault_notify(uuid, uuid, text, uuid, jsonb, timestamptz) to tm8_app;
