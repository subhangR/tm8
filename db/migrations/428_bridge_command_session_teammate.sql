-- =============================================================================
-- 428 — Bridges: /work on a session bridge runs as the session's teammate.
--
-- Task 01a1937d-d745-7c27-b9f2-ab2beb358191. Bridge 01a19370 (tm8 · Bugs)
-- lands in a work session that runs as agile-cheetah, yet every /work was
-- refused "this bridge has no worker teammate": the bridge's own teammate_id
-- was null (the add-bridge wizard never sent the "Runs as" pick; fixed in the
-- client) and 414's bridge_command_context only fell back to the target's
-- teammate for a CHAT target. A session target returned null.
--
-- WHAT THIS FILE DOES
--   §1  internal.bridge_target_teammate(kind, id): who a chat or session target
--       runs as — the chat's teammate; a session's persona (its latest
--       `participates_in` edge, what entity-read shows as the session's
--       teammate), else the teammate its auth session acts as (425's
--       bridge_managed_context arm). A channel has none.
--   §2  public.bridge_command_context: 414's body, unchanged except that
--       `targetTeammateId` reads §1 for every target kind.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The target's teammate.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_target_teammate(p_kind text, p_target uuid) returns uuid
language sql stable set search_path = public, internal, pg_temp as $$
  select case p_kind
    when 'chat' then (select c.teammate_id from public.chats c where c.entity_id = p_target)
    when 'work_session' then coalesce(
      (select pe.src_id from public.edges pe
         join public.team_members tm on tm.entity_id = pe.src_id
        where pe.type = 'participates_in' and pe.dst_id = p_target
        order by pe.created_at desc limit 1),
      (select a.acting_as_team_member_id from public.auth_sessions a
        where a.work_session_id = p_target and a.acting_as_team_member_id is not null
        order by a.created_at desc limit 1))
  end
$$;
revoke all on function internal.bridge_target_teammate(text, uuid) from public;

-- -----------------------------------------------------------------------------
-- §2. The bridge's facts (414), with the session target's teammate.
-- -----------------------------------------------------------------------------
create or replace function public.bridge_command_context(
  p_bridge_id uuid, p_member_id uuid, p_reply_to_external_id text)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  e public.entities;
  v_role text;
  v_status text;
  reply_message uuid;
  reply_direction text;
  muted_until timestamptz;
begin
  perform internal.require_bridge_commands_worker();
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then return null; end if;
  -- B1b-2's /mute column; read so this file applies before or after theirs.
  begin
    execute 'select muted_until from public.bridges where entity_id = $1' into muted_until using p_bridge_id;
  exception when undefined_column then
    muted_until := null;
  end;
  select * into e from public.entities where id = p_bridge_id;
  if p_member_id is not null then
    select mb.role, mb.status into v_role, v_status
      from public.members mb where mb.entity_id = p_member_id and mb.space_id = b.space_id;
  end if;
  if p_reply_to_external_id is not null then
    select r.message_id, r.direction into reply_message, reply_direction
      from public.message_origins r
     where r.bridge_id = p_bridge_id and r.external_message_id = p_reply_to_external_id
     order by (r.direction = 'out') desc
     limit 1;
  end if;
  return jsonb_build_object(
    'bridgeId', b.entity_id,
    'spaceId', b.space_id,
    'provider', b.provider,
    'title', coalesce(b.conversation ->> 'title', ''),
    'targetKind', b.target_kind,
    'targetId', b.target_id,
    'teammateId', b.teammate_id,
    -- 428: a session target's teammate too, not only a chat's.
    'targetTeammateId', internal.bridge_target_teammate(b.target_kind, b.target_id),
    'targetTitle', internal.bridge_target_title(b.target_kind, b.target_id),
    -- 414: where the group's log lives (399), so /result quotes only what the group saw.
    'logAnchor', internal.bridge_log_anchor(b.entity_id),
    'whoMayTrigger', b.policy ->> 'whoMayTrigger',
    'direction', b.policy ->> 'direction',
    'trigger', b.policy ->> 'trigger',
    'mutedUntil', muted_until,
    'pausedAt', b.paused_at,
    'endedAt', b.ended_at,
    'deleted', e.deleted_at is not null,
    'memberRole', case when v_status = 'active' then v_role end,
    'replyTo', case when p_reply_to_external_id is null then null else jsonb_build_object(
      'messageId', reply_message, 'direction', reply_direction) end);
end
$$;
revoke all on function public.bridge_command_context(uuid, uuid, text) from public;
grant execute on function public.bridge_command_context(uuid, uuid, text) to tm8_app;

reset role;
