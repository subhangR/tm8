-- =============================================================================
-- 411 — Bridges B1b-6: the command executor's follow-up doors.
-- (Provisional number: the bridges merger assigns the final one at merge.)
--
-- Design of record: docs/features/bridges/BRIDGES-V2-DESIGN.md §4.4 (/result),
-- §4.6 (Readers tier), §4.8 (privacy). Task 01a18b69-4aba-757d-a409-2e5c1b8f921d.
--
-- Predecessor: 401_bridge_commands.sql (B1b-4), whose objects this extends;
-- 401 is not edited (it is applied and checksummed before this lands).
--
-- WHAT THIS FILE DOES
--   §1  public.bridge_command_input: 401's body, unchanged, plus
--       `commandState` (398's message_origins.command_state), so the executor
--       can tell the group once when 398's claim has failed a command after
--       its attempts;
--   §2  public.bridge_command_guest_result: a guest's /result — the latest
--       message a worker of THIS bridge authored, when every member of the
--       space may read it (visibility 'space'). Executor-only, like 401's doors.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. One stored command (401), now with its state.
-- -----------------------------------------------------------------------------
create or replace function public.bridge_command_input(p_message_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  o public.message_origins;
  m public.messages;
  b public.bridges;
begin
  perform internal.require_bridge_commands_worker();
  select * into o from public.message_origins where message_id = p_message_id and direction = 'in';
  if o.message_id is null then return null; end if;
  select * into m from public.messages where entity_id = p_message_id;
  select * into b from public.bridges where entity_id = o.bridge_id;
  return jsonb_build_object(
    'bridgeId', o.bridge_id,
    'spaceId', b.space_id,
    'connectionId', o.connection_id,
    'messageId', o.message_id,
    'externalMessageId', o.external_message_id,
    'senderExternalId', coalesce(o.external_sender_id, ''),
    'author', internal.bridge_resolve_author(o.bridge_id, coalesce(o.external_sender_id, '')),
    'text', m.body,
    'edited', m.edited_at is not null or m.redacted_at is not null,
    'replyTo', case when o.external_reply_to_id is null then null
                    else jsonb_build_object('externalMessageId', o.external_reply_to_id) end,
    -- 411: B1b-2's state (398); the executor tells the group once when it ends failed.
    'commandState', o.command_state);
end
$$;
revoke all on function public.bridge_command_input(uuid) from public;
grant execute on function public.bridge_command_input(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- §2. A guest's /result.
-- -----------------------------------------------------------------------------
create or replace function public.bridge_command_guest_result(p_bridge_id uuid, p_session_id uuid)
returns setof text language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_bridge_commands_worker();
  if not exists (select 1 from public.edges where src_id = p_session_id and dst_id = p_bridge_id and type = 'authored_from') then
    return;
  end if;
  return query
    select m.body from public.edges ed
      join public.messages m on m.entity_id = ed.src_id
      join public.entities me on me.id = m.entity_id
     where ed.type = 'authored_from' and ed.dst_id = p_session_id
       and m.redacted_at is null and me.deleted_at is null and me.visibility = 'space'
     order by m.created_at desc
     limit 1;
end
$$;
revoke all on function public.bridge_command_guest_result(uuid, uuid) from public;
grant execute on function public.bridge_command_guest_result(uuid, uuid) to tm8_app;

reset role;
