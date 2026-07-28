-- =============================================================================
-- 023 W2.G08 — inbox recipients, owner inspection, and durable read state.
--
-- The W1 schema already carries the discriminated notification recipient and
-- its four keyset indexes. This migration completes the callable behavior:
-- Member and acting-as Teammate reads remain disjoint, owner inspection is a
-- named read-only capability, and both write operations use the command ledger.
-- =============================================================================
set role tm8_graph_owner;

-- The server binds the canonical tm8.actor_id claim. A human Member page is
-- available only without a Teammate actor (or with that same Member selected),
-- while a Teammate page requires the exact owned Teammate actor.
drop policy notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to tm8_app
  using (
    (recipient_team_member_id is null
      and (
        internal.actor_id() is null
        or exists (
          select 1 from public.members selected_member
           where selected_member.entity_id = internal.actor_id()
             and selected_member.identity_id = internal.identity_id()
        )
      )
      and exists (
        select 1 from public.members recipient_member
         where recipient_member.entity_id = notifications.recipient_member_id
           and recipient_member.identity_id = internal.identity_id()
      ))
    or
    (recipient_team_member_id is not null
      and recipient_team_member_id = internal.actor_id()
      and internal.can_act_as(recipient_team_member_id, space_id))
  );

-- Owner inspection is deliberately a filtered overload of the W1 named
-- capability. It is stable/read-only and never calls either read-state writer.
create or replace function public.inspect_owned_teammate_inbox(
  p_team_member_id uuid,
  p_space_id uuid,
  p_unread boolean,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_limit integer
) returns setof public.notifications language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select notification_row.*
    from public.notifications notification_row
    join public.team_members teammate_row
      on teammate_row.entity_id = notification_row.recipient_team_member_id
    join public.members owner_row
      on owner_row.entity_id = teammate_row.owner_member_id
   where teammate_row.entity_id = p_team_member_id
     and owner_row.identity_id = internal.identity_id()
     and (p_space_id is null or notification_row.space_id = p_space_id)
     and (coalesce(p_unread, false) = false
       or notification_row.read_at is null)
     and (p_before_created_at is null or p_before_id is null
       or (notification_row.created_at, notification_row.id)
          < (p_before_created_at, p_before_id))
   order by notification_row.created_at desc, notification_row.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 101)
$$;

-- A read cursor belongs to the authenticated human Member in the anchor's
-- Space. GREATEST makes concurrent commands monotonic; the returned time is the
-- persisted time, not a losing contender's local clock value.
create or replace function public.mark_read(
  p_anchor_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  anchor_row public.entities;
  selected_member_id uuid;
  selected_actor_id uuid := internal.actor_id();
  marked_at timestamptz := clock_timestamp();
  persisted_at timestamptz;
  replay jsonb;
  ledger_identity text;
  ledger_actor uuid;
  result jsonb;
begin
  perform internal.require_identity();
  if p_client_mutation_id is null or btrim(p_client_mutation_id) = '' then
    raise exception 'clientMutationId is required' using errcode = '22023';
  end if;

  anchor_row := internal.live_entity(p_anchor_id);
  if not internal.entity_readable(p_anchor_id) then
    raise exception 'anchor not found' using errcode = 'P0002';
  end if;
  selected_member_id := internal.current_member_id(anchor_row.space_id);
  if selected_member_id is null then
    raise exception 'anchor not found' using errcode = 'P0002';
  end if;
  if selected_actor_id is not null and selected_actor_id <> selected_member_id then
    raise exception 'Teammate read state is not a Member read cursor' using errcode = '42501';
  end if;

  select identity_id, actor_id into ledger_identity, ledger_actor
    from public.command_ledger where client_mutation_id = p_client_mutation_id;
  if found and (ledger_identity is distinct from internal.identity_id()
      or ledger_actor is distinct from selected_actor_id) then
    raise exception 'clientMutationId belongs to another principal' using errcode = '23514';
  end if;

  replay := internal.ledger_replay(p_client_mutation_id, 'readMarks.upsert');
  if replay is not null then
    if replay->>'anchorId' is distinct from p_anchor_id::text then
      raise exception 'clientMutationId belongs to another read anchor' using errcode = '23514';
    end if;
    return replay;
  end if;

  insert into public.read_marks(member_id, anchor_id, last_read_at)
  values (selected_member_id, p_anchor_id, marked_at)
  on conflict (member_id, anchor_id) do update
    set last_read_at = greatest(read_marks.last_read_at, excluded.last_read_at)
  returning last_read_at into persisted_at;

  update public.notifications notification_row
     set read_at = coalesce(notification_row.read_at, persisted_at)
   where notification_row.recipient_member_id = selected_member_id
     and notification_row.recipient_team_member_id is null
     and notification_row.target_entity_id = p_anchor_id
     and notification_row.read_at is null;

  result := jsonb_build_object(
    'anchorId', p_anchor_id,
    'lastReadAt', persisted_at,
    'patches', '[]'::jsonb
  );
  return internal.ledger_record(p_client_mutation_id, 'readMarks.upsert', result);
end
$$;

-- Marking a single notification is recipient-addressed. Recipient authority is
-- established before the child id is looked up, so a real and a fabricated id
-- have the same absence behavior for an unauthorized principal.
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

-- The W1 one-argument writer has no command-ledger identity and is therefore
-- closed to the application. Only the ledgered overload is callable.
revoke all on function public.mark_notification_read(uuid) from public;
revoke execute on function public.mark_notification_read(uuid) from tm8_app;
revoke all on function public.mark_notification_read(uuid, text, uuid, text) from public;
revoke all on function public.inspect_owned_teammate_inbox(
  uuid, uuid, boolean, timestamptz, uuid, integer
) from public;
revoke all on function public.mark_read(uuid, text) from public;

grant execute on function public.mark_notification_read(uuid, text, uuid, text) to tm8_app;
grant execute on function public.inspect_owned_teammate_inbox(
  uuid, uuid, boolean, timestamptz, uuid, integer
) to tm8_app;
grant execute on function public.mark_read(uuid, text) to tm8_app;

reset role;
