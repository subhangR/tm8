-- =============================================================================
-- 423 — Bridges B1b-7: a connection's lifecycle in its spaces.
-- (Authored as 401; renumbered to 407 so it follows #1427's 405, whose
-- internal.bridge_credential_guard it restates; renumbered to 423 on the merge
-- of batch 7 cut A, after #1427's 421/422. The guard body here still starts
-- from 421's, which nothing in 400-420 redefines.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §2.5 (the
-- owner leaving the space pauses every bridge on their connection there;
-- removing the connection logs the device out and ends them all), §3.4
-- (bridges.connections.remove, bridges.conversations.list), D28.
-- Task 01a18b92-9c32-7da5-91c5-6c2865364f9b.
--
-- Predecessors: 398 (B1b-2: the allowlist follows bridges.paused_at and
-- ended_at in the database, so everything here reaches the runtime without a
-- TS hook) and 421 (B1b-5: the offered credential and its guard).
--
-- WHAT THIS FILE DOES
--   §1  the owner leaving or being removed already pauses: end_membership
--       (239) revokes every credential the member owns in the space before the
--       tombstone (and 239's guard refuses a tombstone over a live one), so the
--       offer is revoked and 421's trigger pauses its bridges. Nothing new here;
--       the test pins that path (leave_space, remove_space_member);
--   §2  internal.bridge_credential_guard, restated from 421 (its latest
--       definition) plus one arm: a bridge whose connection's owner is not an
--       active member of its space cannot be resumed (`owner_not_member`);
--   §3  remove_bridge_connection (owner, human-only): the connection becomes
--       'removed', every live bridge on it ends (as bridges.remove ends one),
--       and every offer of it is revoked. The server then sends the runtime
--       `disconnect {logout: true}`;
--   §4  bridge_connection_for_owner: the runtime a connection is on, for the
--       owner only (bridges.conversations.list asks that runtime live; the
--       list is never stored).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §2. A bridge resumes only while its connection's owner is an active member.
--     Restated from 421 (the latest definition); the new arm is marked.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_credential_guard() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare cred public.space_credentials;
begin
  if tg_op = 'INSERT' then
    if new.credential_id is null then
      select * into cred from public.space_credentials
       where bridge_connection_id = new.connection_id and space_id = new.space_id and status <> 'revoked';
      if cred.id is null then
        perform internal.bridge_refuse('connection_not_offered',
          'offer this connection to the space first: tm8 bridge connection offer <connection-id> --space <space-id>',
          jsonb_build_object('connectionId', new.connection_id));
      end if;
      new.credential_id := cred.id;
    else
      select * into cred from public.space_credentials where id = new.credential_id;
      if cred.id is null or cred.bridge_connection_id is distinct from new.connection_id
         or cred.space_id <> new.space_id or cred.status = 'revoked' then
        raise exception 'a bridge rides the credential offered for its connection in its space' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.credential_id is distinct from old.credential_id then
    raise exception 'a bridge''s credential is fixed' using errcode = '42501';
  end if;
  -- 423: the owner of the number left the space (§2.5). Checked first: it is the
  -- reason to name, since leaving also revoked the offer.
  if old.paused_at is not null and new.paused_at is null and new.ended_at is null
     and not exists (select 1 from public.bridge_connections c
                       join public.accounts a on a.id = c.owner_account_id
                       join public.members m on m.identity_id = a.identity_id
                      where c.id = new.connection_id and m.space_id = new.space_id and m.status = 'active') then
    perform internal.bridge_refuse('owner_not_member',
      'the owner of this bridge''s number is no longer a member of the space; it stays paused');
  end if;
  if old.paused_at is not null and new.paused_at is null and new.ended_at is null
     and exists (select 1 from public.space_credentials sc where sc.id = new.credential_id and sc.status = 'revoked') then
    perform internal.bridge_refuse('connection_withdrawn',
      'this bridge''s connection was withdrawn from the space; its owner can offer it again, then resume');
  end if;
  return new;
end
$$;
revoke all on function internal.bridge_credential_guard() from public;

-- -----------------------------------------------------------------------------
-- §3. bridges.connections.remove.
-- -----------------------------------------------------------------------------
create or replace function public.remove_bridge_connection(
  p_connection_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; conn public.bridge_connections; b record; ended uuid[] := '{}'; revoked uuid[];
begin
  perform internal.require_human_auth_kind();
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.connections.remove');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{connection,id}', p_connection_id::text, 'connection');
    return replay;
  end if;
  -- The owner, a live connection (refuses one already removed).
  conn := internal.bridge_own_connection(p_connection_id);

  -- Every live bridge on it ends as bridges.remove ends one: the tombstone
  -- stays readable, pending outbox rows fail permanently.
  for b in
    select br.entity_id, br.space_id, e.created_by from public.bridges br join public.entities e on e.id = br.entity_id
     where br.connection_id = conn.id and br.ended_at is null
     order by br.entity_id
  loop
    update public.bridges set ended_at = now(), paused_at = null where entity_id = b.entity_id;
    update public.bridge_outbox set status = 'failed_permanent', settled_at = now()
     where bridge_id = b.entity_id and status in ('pending', 'dispatching', 'failed_retryable');
    perform internal.record_activity(b.space_id, b.entity_id,
      coalesce(internal.current_member_id(b.space_id), b.created_by), 'deleted', null,
      jsonb_build_object('kind', 'bridge', 'op', 'bridges.connections.remove', 'connectionId', conn.id));
    ended := ended || b.entity_id;
  end loop;

  select coalesce(array_agg(id order by id), '{}') into revoked from public.space_credentials
   where bridge_connection_id = conn.id and status <> 'revoked';
  update public.space_credentials set status = 'revoked', status_reason = null where id = any(revoked);

  update public.bridge_connections set status = 'removed' where id = conn.id returning * into conn;
  return internal.ledger_record(p_client_mutation_id, 'bridges.connections.remove', jsonb_build_object(
    'connection', internal.bridge_connection_json(conn),
    'endedBridgeIds', to_jsonb(ended),
    'revokedCredentialIds', to_jsonb(revoked)));
end
$$;
revoke all on function public.remove_bridge_connection(uuid, text) from public;
grant execute on function public.remove_bridge_connection(uuid, text) to tm8_app;

-- -----------------------------------------------------------------------------
-- §4. Where to ask for the group list: the owner's own live connection only
--     (D28: not a node admin, not another member).
-- -----------------------------------------------------------------------------
create or replace function public.bridge_connection_for_owner(p_connection_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare conn public.bridge_connections;
begin
  perform internal.require_human_auth_kind();
  select * into conn from public.bridge_connections where id = p_connection_id;
  if conn.id is null or conn.status = 'removed' then
    raise exception 'bridge connection not found' using errcode = 'P0002';
  end if;
  if conn.owner_account_id is distinct from internal.current_account_id() then
    raise exception 'only the connection''s owner can list its groups' using errcode = '42501',
      detail = jsonb_build_object('reason', 'not_connection_owner')::text;
  end if;
  return jsonb_build_object('id', conn.id, 'provider', conn.provider, 'status', conn.status, 'runtimeId', conn.runtime_id);
end
$$;
revoke all on function public.bridge_connection_for_owner(uuid) from public;
grant execute on function public.bridge_connection_for_owner(uuid) to tm8_app;

reset role;
