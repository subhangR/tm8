-- =============================================================================
-- 246 — mark_notification_read honours the session's space pin
-- (W3-audit #852 finding F1, follow-up S2, task 01a0db30).
--
-- THE HOLE. The 4-argument writer (023) is SECURITY DEFINER and authorizes its
-- member arm by `members.identity_id = internal.identity_id()` alone. A session
-- pinned to space A (`tm8.session_space_id`, 226/227) therefore marked the same
-- identity's space-B notification read, over the DB and over
-- PUT /v2/inbox/:id/read. The membership helpers already honour the pin (227);
-- this function reads `members` directly and so never saw it.
--
-- THE FIX. Both member-arm `exists` — the authorization check and the update's
-- own guard — also require the member row to be in the pinned space when a pin
-- is bound. An unpinned session (pin null) is unchanged. The refusal is the same
-- P0002 'notification not found' as a fabricated id, so a pinned session learns
-- nothing about another space. The team-member arm is unchanged: it authorizes
-- through internal.can_act_as.
--
-- Additive: CREATE OR REPLACE only; the signature, grants and the ledger/replay
-- order are 023's, untouched.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.mark_notification_read(
  p_notification_id uuid,
  p_recipient_type text,
  p_recipient_id uuid,
  p_client_mutation_id text
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  selected_actor_id uuid := internal.actor_id();
  selected_is_authorized boolean := false;
  replay jsonb;
  notification_row public.notifications;
  ledger_identity text;
  ledger_actor uuid;
begin
  perform internal.require_identity();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;
  if p_recipient_type not in ('member', 'team_member') then
    raise exception 'invalid inbox recipient discriminator' using errcode = '22023';
  end if;

  if p_recipient_type = 'member' then
    select exists (
      select 1 from public.members member_row
       where member_row.identity_id = internal.identity_id()
         and (p_recipient_id is null or member_row.entity_id = p_recipient_id)
         and (selected_actor_id is null or selected_actor_id = member_row.entity_id)
         and (internal.session_space_id() is null
           or member_row.space_id = internal.session_space_id())
    ) into selected_is_authorized;
  else
    if p_recipient_id is null or selected_actor_id is distinct from p_recipient_id then
      selected_is_authorized := false;
    else
      select exists (
        select 1
          from public.team_members teammate_row
          join public.entities teammate_entity on teammate_entity.id = teammate_row.entity_id
         where teammate_row.entity_id = p_recipient_id
           and internal.can_act_as(teammate_row.entity_id, teammate_entity.space_id)
      ) into selected_is_authorized;
    end if;
  end if;
  if not selected_is_authorized then
    raise exception 'notification not found' using errcode = 'P0002';
  end if;

  select identity_id, actor_id into ledger_identity, ledger_actor
    from public.command_ledger where client_mutation_id = p_client_mutation_id;
  if found and (ledger_identity is distinct from internal.identity_id()
      or ledger_actor is distinct from selected_actor_id) then
    raise exception 'clientMutationId belongs to another principal' using errcode = '23514';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'inbox.markRead');
  if replay is not null then
    if replay->>'id' is distinct from p_notification_id::text
       or (p_recipient_type = 'member' and p_recipient_id is not null
         and replay->>'recipient_member_id' is distinct from p_recipient_id::text)
       or (p_recipient_type = 'team_member'
         and replay->>'recipient_team_member_id' is distinct from p_recipient_id::text) then
      raise exception 'clientMutationId belongs to another notification recipient'
        using errcode = '23514';
    end if;
    return replay;
  end if;

  if p_recipient_type = 'member' then
    update public.notifications target_notification
       set read_at = coalesce(target_notification.read_at, clock_timestamp())
     where target_notification.id = p_notification_id
       and target_notification.recipient_team_member_id is null
       and (p_recipient_id is null
         or target_notification.recipient_member_id = p_recipient_id)
       and exists (
         select 1 from public.members member_row
          where member_row.entity_id = target_notification.recipient_member_id
            and member_row.identity_id = internal.identity_id()
            and (internal.session_space_id() is null
              or member_row.space_id = internal.session_space_id())
       )
    returning * into notification_row;
  else
    update public.notifications target_notification
       set read_at = coalesce(target_notification.read_at, clock_timestamp())
     where target_notification.id = p_notification_id
       and target_notification.recipient_team_member_id = p_recipient_id
    returning * into notification_row;
  end if;

  if notification_row.id is null then
    raise exception 'notification not found' using errcode = 'P0002';
  end if;
  return internal.ledger_record(
    p_client_mutation_id,
    'inbox.markRead',
    to_jsonb(notification_row)
  );
end
$$;

do $verify$
begin
  if has_function_privilege('public', 'public.mark_notification_read(uuid,text,uuid,text)', 'execute') then
    raise exception 'VERIFY 246: PUBLIC can execute mark_notification_read';
  end if;
  if not has_function_privilege('tm8_app', 'public.mark_notification_read(uuid,text,uuid,text)', 'execute') then
    raise exception 'VERIFY 246: tm8_app cannot execute mark_notification_read';
  end if;
  if (select count(*) from pg_proc p
       where p.oid = 'public.mark_notification_read(uuid,text,uuid,text)'::regprocedure
         and p.prosrc like '%member_row.space_id = internal.session_space_id()%') <> 1 then
    raise exception 'VERIFY 246: mark_notification_read does not check the session space pin';
  end if;
end
$verify$;

reset role;
