-- =============================================================================
-- 230 — a membership ends by TOMBSTONE, never by DELETE (plan 01a0d9eb W1, G6,
-- K8; rows T14/T15).
--
-- THE GAP. There was no way to leave a space or remove a member. The only exit
-- was a hand-written DELETE, and three `on delete restrict` FKs refuse it the
-- moment a member has used the space (chat_turns.requested_by_member_id,
-- chats.configured_by_member_id, and the member's own authored history). A
-- DELETE would also orphan every activity row and message that names them.
--
-- THE SHAPE. `members.status` is active | left | removed, and `left_at` dates
-- the end. The row, the member entity and everything they authored stay, so
-- old content still renders; the read path reports the status and the client
-- renders "(left)". Nothing here deletes a member row.
--
-- WHAT "ENDED" MEANS. Every membership answer asks for `status = 'active'`:
--
--   member_space_ids()      every member_space_ids RLS policy (members_select,
--                           entities_select, spaces_select's member arm, …),
--                           and the inline-membership policies that read
--                           `members` under RLS (user_profiles, read_marks,
--                           notifications, file_upload_slots, …) inherit it
--   is_space_member(s)      and so require_space_member
--   is_space_admin(s)       and so require_space_admin
--   current_member_id(s)    and so resolve_actor
--   can_act_as(a, s)        + a deactivated persona cannot be acted as
--   entity_readable(t), entity_row_visible(...)
--   inspect_owned_teammate_inbox (both overloads)
--
-- Each body is 227's text with one added conjunct. 227's pin stays INLINE
-- (A10): the conjunct is a column test on the row the body already reads, not
-- a call, so the once-per-statement budgets are unchanged.
--
-- THE EFFECTS, in the one transaction that flips the status
-- (internal.end_membership):
--   * auth sessions pinned to the space for the member's account (browser/cli
--     sessions are unpinned and survive for their other spaces; every helper
--     above refuses them here), agent tokens of the sessions stopped below, and
--     agent tokens acting as the member's personas — revoked;
--   * the member's live work sessions in the space — the ones their account's
--     agent token drives, the ones they launched on a space credential (206's
--     launcher key, which is SC-6's containment set), and the ones created as
--     them — recorded exited (`stopped_by_operator`). The PTY kill is the TS
--     step after commit: SQL cannot reach a process;
--   * their personas — deactivated (`team_members.deactivated_at`), kept;
--   * `assigned_to` edges to them or their personas — removed, each with an
--     `unlinked` activity row carrying the reason, on the task;
--   * link tokens they own (W6's `space_link_tokens`) — deleted, only if the
--     table exists, so W6 needs no change here.
--
-- COMING BACK. A new invite, or joining a public space, reactivates the same
-- row (attach_member): the member keeps their id, so their history re-joins
-- them. A REMOVED member cannot re-enter through the public door; an admin's
-- invite is the way back.
--
-- NO ROW REWRITE. `add column ... default 'active'` with a constant default is
-- a catalog-only change (PG 11+): no existing row is rewritten, and every
-- existing member reads `active`, which they are. The CHECKs are validated by
-- a scan, not a rewrite. `left_at` and `deactivated_at` are nullable, no
-- default.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

alter table public.members
  add column status text not null default 'active',
  add column left_at timestamptz;

alter table public.members
  add constraint members_status_check
    check (status in ('active', 'left', 'removed')),
  add constraint members_left_at_matches_status
    check ((status = 'active') = (left_at is null));

comment on column public.members.status is
  'active | left (spaces.leave) | removed (spaces.members.remove). A membership '
  'ends by tombstone, never by DELETE (230, K8). Every membership helper reads '
  'active rows only.';
comment on column public.members.left_at is
  'When the membership ended; null exactly while status = active (230).';

alter table public.team_members
  add column deactivated_at timestamptz;

comment on column public.team_members.deactivated_at is
  'Set when the owning member leaves or is removed (230). The persona and its '
  'history are kept; nobody can act as it until the owner is reactivated.';

-- ---------------------------------------------------------------------------
-- The 227 helpers, + `status = 'active'`.
-- ---------------------------------------------------------------------------

create or replace function internal.member_space_ids()
returns uuid[] language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(array_agg(m.space_id), '{}'::uuid[])
    from public.members m
   where m.identity_id = internal.identity_id()
     and m.status = 'active'
     and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
          or m.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
$$;

create or replace function internal.is_space_member(target_space uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null
    and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
         or target_space = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
    and exists (
      select 1 from public.members m
       where m.space_id = target_space and m.identity_id = internal.identity_id()
         and m.status = 'active'
    )
$$;

create or replace function internal.is_space_admin(target_space uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null
    and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
         or target_space = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
    and exists (
      select 1 from public.members m
       where m.space_id = target_space
         and m.identity_id = internal.identity_id()
         and m.status = 'active'
         and m.role in ('owner','admin')
    )
$$;

create or replace function internal.current_member_id(target_space uuid)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select m.entity_id from public.members m
   where m.space_id = target_space and m.identity_id = internal.identity_id()
     and m.status = 'active'
     and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
          or target_space = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
$$;

create or replace function internal.can_act_as(target_actor uuid, target_space uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null
    and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
         or target_space = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
    and (
    exists (
      select 1 from public.members member_row
       where member_row.entity_id = target_actor
         and member_row.space_id = target_space
         and member_row.identity_id = internal.identity_id()
         and member_row.status = 'active'
    )
    or (
      exists (
        select 1
          from public.members viewer_member
          join public.entities viewer_entity on viewer_entity.id = viewer_member.entity_id
         where viewer_member.space_id = target_space
           and viewer_member.identity_id = internal.identity_id()
           and viewer_member.status = 'active'
           and viewer_entity.deleted_at is null
      )
      and exists (
        select 1
          from public.team_members teammate
          join public.entities teammate_entity on teammate_entity.id = teammate.entity_id
         where teammate.entity_id = target_actor
           and teammate.deactivated_at is null
           and teammate_entity.space_id = target_space
           and teammate_entity.deleted_at is null
      )
    )
  )
$$;

create or replace function internal.entity_readable(target uuid)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities entity_row
     where entity_row.id = target
       and entity_row.deleted_at is null
       -- WAS: `internal.is_space_member(entity_row.space_id)`.
       and internal.identity_id() is not null
       and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
            or entity_row.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
       and exists (
         select 1 from public.members m
          where m.space_id = entity_row.space_id
            and m.identity_id = internal.identity_id()
            and m.status = 'active'
       )
       and (
         entity_row.visibility = 'space'
         or (
           entity_row.visibility = 'restricted'
           and entity_row.kind = 'project'
           and exists (
             select 1
               from public.project_links link
               join public.space_projects active_link
                 on active_link.space_id = link.space_id
                and active_link.project_id = link.project_id
              where link.project_entity_id = entity_row.id
                and link.space_id = entity_row.space_id
           )
         )
       )
  )
$$;

create or replace function internal.entity_row_visible(p_id uuid, p_space_id uuid, p_kind text, p_visibility text)
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select (
    -- WAS: `internal.is_space_member(p_space_id)`. Identical expression, one
    -- SQL-function call level shallower. See 002 for the original.
    internal.identity_id() is not null
    and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
         or p_space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
    and exists (
      select 1 from public.members m
       where m.space_id = p_space_id
         and m.identity_id = internal.identity_id()
         and m.status = 'active'
    )
  ) and (
    p_visibility = 'space'
    or (
      -- 021: a restricted `project` projection is visible exactly while its
      -- space link is active. Same shape as entity_readable's carve-out.
      p_visibility = 'restricted'
      and p_kind = 'project'
      and exists (
        select 1
          from public.project_links link
          join public.space_projects active_link
            on active_link.space_id = link.space_id
           and active_link.project_id = link.project_id
         where link.project_entity_id = p_id
           and link.space_id = p_space_id
      )
    )
  )
$$;

create or replace function public.inspect_owned_teammate_inbox(p_team_member_id uuid, p_limit integer default 50)
returns setof public.notifications language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select n.* from public.notifications n
  join public.team_members tm on tm.entity_id = n.recipient_team_member_id
  join public.members owner on owner.entity_id = tm.owner_member_id
  where tm.entity_id = p_team_member_id
    and owner.identity_id = internal.identity_id()
    and owner.status = 'active'
    and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
         or n.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;

create or replace function public.inspect_owned_teammate_inbox(
  p_team_member_id uuid, p_space_id uuid, p_unread boolean,
  p_before_created_at timestamptz, p_before_id uuid, p_limit integer
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
     and owner_row.status = 'active'
     and (nullif(current_setting('tm8.session_space_id', true), '')::uuid is null
          or notification_row.space_id = nullif(current_setting('tm8.session_space_id', true), '')::uuid)
     and (p_space_id is null or notification_row.space_id = p_space_id)
     and (coalesce(p_unread, false) = false
       or notification_row.read_at is null)
     and (p_before_created_at is null or p_before_id is null
       or (notification_row.created_at, notification_row.id)
          < (p_before_created_at, p_before_id))
   order by notification_row.created_at desc, notification_row.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 101)
$$;

-- ---------------------------------------------------------------------------
-- Readers that list the caller's memberships directly (no helper in between).
-- ---------------------------------------------------------------------------

create or replace function public.current_actor_scope()
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
begin
  return jsonb_build_object(
    'identityId', identity,
    'memberIds', coalesce((
      select jsonb_agg(jsonb_build_object('memberId', m.entity_id, 'spaceId', m.space_id, 'role', m.role)
             order by m.joined_at)
        from public.members m where m.identity_id = identity and m.status = 'active'), '[]'::jsonb),
    'teamMembers', coalesce((
      select jsonb_agg(jsonb_build_object('id', tm.entity_id, 'spaceId', owner.space_id,
                                          'ownerMemberId', tm.owner_member_id, 'name', tm.name)
             order by tm.name)
        from public.team_members tm
        join public.members owner on owner.entity_id = tm.owner_member_id
       where owner.identity_id = identity
         and owner.status = 'active'
         and tm.deactivated_at is null), '[]'::jsonb));
end
$$;

create or replace function public.current_identity()
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  result jsonb;
begin
  select jsonb_build_object(
      'identityId', a.identity_id, 'accountId', a.id, 'username', a.username,
      'displayName', coalesce(p.display_name, a.display_name), 'avatar', p.avatar,
      'email', coalesce(p.email, a.email),
      'globalId', p.global_id,
      'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner, 'status', a.status,
      'actingAs', internal.acting_as(),
      'memberships', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'spaceId', m.space_id, 'memberId', m.entity_id, 'role', m.role)
               order by m.joined_at)
          from public.members m
         where m.identity_id = a.identity_id and m.status = 'active'), '[]'::jsonb))
    into result
    from public.accounts a
    left join public.user_profiles p on p.identity_id = a.identity_id
   where a.identity_id = identity;
  if result is null then
    raise exception 'no account for the bound identity' using errcode = '28000';
  end if;
  return result;
end
$$;

create or replace function public.current_space_identity(p_space_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare result jsonb;
begin
  perform internal.require_space_member(p_space_id);
  select jsonb_build_object(
      'spaceId', m.space_id, 'memberId', m.entity_id, 'role', m.role,
      'identityId', m.identity_id, 'displayName', coalesce(m.display_name, p.display_name),
      'teamMemberIds', coalesce((
        select jsonb_agg(tm.entity_id order by tm.name)
          from public.team_members tm where tm.owner_member_id = m.entity_id), '[]'::jsonb))
    into result
    from public.members m
    left join public.user_profiles p on p.identity_id = m.identity_id
   where m.space_id = p_space_id and m.identity_id = internal.identity_id()
     and m.status = 'active';
  return result;
end
$$;

-- Iterates the caller's spaces and resolves an actor in each: a space they
-- have left would have no actor there and refuse the whole call.
create or replace function public.queue_tracking_refresh(p_entity_ids uuid[] default '{}'::uuid[], p_actor_id uuid default null::uuid, p_client_mutation_id text default null::text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare replay jsonb; row_value record; requester uuid; actor uuid; request_id uuid; request_ids uuid[] := '{}';
  -- The tm8.actor_id claim exactly as the caller entered with it: '' when
  -- unbound, the requested actor when acting-as. internal.claim_text returns
  -- null for a blank claim, hence the coalesce. tm8.acting_as is a separate
  -- claim this function never writes, so it is preserved on its own.
  entry_actor text := coalesce(internal.claim_text('tm8.actor_id'),'');
  normalized uuid[] := array(select distinct value from unnest(coalesce(p_entity_ids,'{}'::uuid[])) value order by value);
begin
  replay := internal.ledger_replay(p_client_mutation_id,'tracking.refresh'); if replay is not null then return replay; end if;
  if cardinality(normalized)>0 and exists(
    select 1 from unnest(normalized) requested
    left join public.entities e on e.id=requested and e.deleted_at is null and e.kind in ('pull_request','commit')
    where e.id is null or not internal.is_space_member(e.space_id)
  ) then
    raise exception 'tracking entity not found or not readable' using errcode='P0002';
  end if;
  for row_value in
    select memberships.space_id,
      case when cardinality(normalized)=0 then null::uuid[]
           else array_agg(e.id order by e.id) end entity_ids
      from public.members memberships
      left join public.entities e on cardinality(normalized)>0 and e.id=any(normalized)
                                 and e.space_id=memberships.space_id
     where memberships.identity_id=internal.identity_id()
       and memberships.status='active'
       and (cardinality(normalized)=0 or e.id is not null)
     group by memberships.space_id
     order by memberships.space_id
  loop
    -- THE FIX. Without this, the previous iteration's per-Space member id is
    -- still bound and short-circuits resolve_actor's coalesce below, so this
    -- Space is authorized against the PREVIOUS Space's actor and refused.
    perform set_config('tm8.actor_id',entry_actor,true);
    requester := internal.current_member_id(row_value.space_id);
    actor := internal.resolve_actor(p_actor_id,row_value.space_id); perform internal.bind_actor(actor);
    insert into public.tracking_refresh_requests(space_id,requested_by,entity_ids)
    values(row_value.space_id,requester,row_value.entity_ids) returning id into request_id;
    request_ids := request_ids || request_id;
  end loop;
  -- Leave the transaction's claim as this function found it: a per-Space actor
  -- must not escape a call that deliberately spans Spaces.
  perform set_config('tm8.actor_id',entry_actor,true);
  if cardinality(request_ids)=0 then raise exception 'no readable Space to refresh' using errcode='42501'; end if;
  return internal.ledger_record(p_client_mutation_id,'tracking.refresh',jsonb_build_object(
    'accepted',true,'status','queued','requestIds',request_ids));
end
$$;

-- ---------------------------------------------------------------------------
-- Coming back: the same row is reactivated, never a second row (the unique
-- (space_id, identity_id) key would refuse one anyway).
-- ---------------------------------------------------------------------------

create or replace function internal.attach_member(p_space_id uuid, p_identity text, p_role text default 'member'::text)
returns uuid language plpgsql
set search_path = public, internal, pg_temp as $$
declare
  member_id uuid;
  member_status text;
  profile public.user_profiles;
begin
  select entity_id, status into member_id, member_status from public.members
   where space_id = p_space_id and identity_id = p_identity
   for update;
  if member_id is not null and member_status = 'active' then
    return member_id;
  end if;
  if member_id is not null then
    -- 230: a tombstoned membership comes back as itself, with the role this
    -- door grants, so everything it authored is theirs again.
    update public.members
       set status = 'active', left_at = null, role = p_role
     where entity_id = member_id;
    update public.team_members
       set deactivated_at = null
     where owner_member_id = member_id and deactivated_at is not null;
    perform internal.record_activity(p_space_id, member_id, member_id, 'joined',
              null, jsonb_build_object('role', p_role, 'previousStatus', member_status));
    return member_id;
  end if;
  select * into profile from public.user_profiles where identity_id = p_identity;
  if profile.identity_id is null then
    insert into public.user_profiles(identity_id) values (p_identity) returning * into profile;
  end if;
  member_id := internal.new_id();
  insert into public.entities(id, space_id, kind, created_by)
  values (member_id, p_space_id, 'member', member_id);
  insert into public.members(entity_id, space_id, identity_id, role, display_name)
  values (member_id, p_space_id, p_identity, p_role, profile.display_name);
  perform internal.record_activity(p_space_id, member_id, member_id, 'joined',
            null, jsonb_build_object('role', p_role));
  return member_id;
end
$$;

create or replace function public.join_public_space(p_space_id uuid, p_client_mutation_id text default null::text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  target public.spaces;
  member_id uuid;
  member_status text;
  existed boolean;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    -- THE SECURITY BOUNDARY. internal.ledger_replay takes
    -- pg_advisory_xact_lock on the cmid and only then selects, so this call
    -- runs with that lock HELD and the recorded row guaranteed visible. The
    -- identical call before ledger_replay is a fast path, NOT the boundary:
    -- it runs unlocked and reads "not found" against a victim's still
    -- uncommitted row. See the TOCTOU note in this file's header.
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Also closes the shared-operation-string crossing: a redeem_invite cmid
    -- carries the invite's Space, which will not match the Space addressed here
    -- unless it is genuinely the same Space.
    perform internal.require_replay_subject(
      replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;
  identity := internal.require_identity();
  select * into target from public.spaces where id = p_space_id;
  if target.id is null then
    raise exception 'space not found' using errcode = 'P0002';
  end if;
  select entity_id, status into member_id, member_status from public.members
   where space_id = p_space_id and identity_id = identity;
  existed := member_id is not null and member_status = 'active';
  if not existed then
    if target.visibility <> 'public' then
      raise exception 'space is not public' using errcode = '42501';
    end if;
    -- 230: a member an admin REMOVED does not walk back in through the public
    -- door. An invite is the way back; leaving on your own is not a ban.
    if member_status = 'removed' then
      raise exception 'you were removed from this space: ask an admin for an invite'
        using errcode = '42501';
    end if;
    member_id := internal.attach_member(p_space_id, identity, 'member');
  end if;
  result := jsonb_build_object('spaceId', p_space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

create or replace function public.redeem_invite(p_code text, p_client_mutation_id text default null::text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  invite public.space_invites;
  member_id uuid;
  existed boolean;
  result jsonb;
  addressed_space uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.invites.redeem');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    select space_id into addressed_space
      from public.space_invites where code = p_code;
    if addressed_space is not null then
      perform internal.require_replay_subject(
        replay ->> 'spaceId', addressed_space::text, 'space');
    end if;
    return replay;
  end if;
  identity := internal.require_identity();
  select * into invite from public.space_invites where code = p_code for update;
  if invite.id is null then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  if invite.revoked_at is not null then
    raise exception 'invite was revoked' using errcode = '42501';
  end if;
  if invite.expires_at is not null and invite.expires_at < now() then
    raise exception 'invite has expired' using errcode = '42501';
  end if;

  -- 230: "already a member" means an ACTIVE member. A tombstoned row is
  -- reactivated by attach_member and spends a use, as a first join does.
  select entity_id into member_id from public.members
   where space_id = invite.space_id and identity_id = identity and status = 'active';
  existed := member_id is not null;
  if not existed then
    if invite.use_count >= invite.max_uses then
      raise exception 'invite is exhausted' using errcode = '53400';
    end if;
    member_id := internal.attach_member(invite.space_id, identity, invite.role);
    update public.space_invites set use_count = use_count + 1 where id = invite.id;
    perform internal.notify(invite.space_id, invite.created_by, 'join', member_id, member_id,
                            jsonb_build_object('inviteId', invite.id, 'role', invite.role));
  end if;
  result := jsonb_build_object('spaceId', invite.space_id, 'memberId', member_id, 'joined', not existed,
                               'patches', jsonb_build_array(internal.command_entity(member_id)));
  return internal.ledger_record(p_client_mutation_id, 'spaces.invites.redeem', result);
end
$$;

create or replace function public.preview_invite(p_code text)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  invite public.space_invites;
  space public.spaces;
  viewer text;
  inviter text;
  status text;
begin
  select * into invite from public.space_invites where code = p_code;
  if invite.id is null then
    return jsonb_build_object('status', 'unknown');
  end if;

  select * into space from public.spaces where id = invite.space_id;
  if space.id is null then
    -- The Space was deleted out from under a live code. Same answer as an
    -- unknown code: there is nothing to join and nothing to name.
    return jsonb_build_object('status', 'unknown');
  end if;

  -- ALREADY IN — checked before the code's own health, because a membership
  -- outlives the link that granted it. This is the branch the report needed:
  -- the holder of a spent link may be the person who spent it.
  --
  -- NULL for an anonymous caller, which is most of them. `redeem_invite`
  -- resolves membership by (space_id, identity_id) against this same table;
  -- this asks the identical question so the two operations cannot answer
  -- differently about the same person again (230: an ACTIVE membership).
  viewer := internal.identity_id();
  if viewer is not null and exists (
       select 1 from public.members
        where space_id = invite.space_id
          and identity_id = viewer
          and members.status = 'active') then
    return jsonb_build_object(
      'status',    'member',
      'spaceId',   space.id,
      'spaceName', space.name
    );
  end if;

  status := case
    when invite.revoked_at is not null then 'revoked'
    when invite.expires_at is not null and invite.expires_at < now() then 'expired'
    when invite.use_count >= invite.max_uses then 'exhausted'
    else 'valid'
  end;

  if status <> 'valid' then
    return jsonb_build_object('status', status, 'spaceName', space.name);
  end if;

  select coalesce(nullif(btrim(m.display_name), ''), nullif(btrim(p.display_name), ''))
    into inviter
    from public.members m
    left join public.user_profiles p on p.identity_id = m.identity_id
   where m.entity_id = invite.created_by;

  return jsonb_build_object(
    'status',    'valid',
    'spaceId',   space.id,
    'spaceName', space.name,
    'role',      invite.role,
    'invitedBy', inviter,
    'expiresAt', invite.expires_at
  );
end
$$;

-- A role is a property of an ACTIVE membership, and the owner floor counts
-- active owners: an owner who left must not be the one keeping it up.
create or replace function public.set_member_role(p_space_id uuid, p_member_id uuid, p_role text, p_actor_id uuid default null::uuid, p_client_mutation_id text default null::text)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  target public.members;
  caller_role text;
  owner_count integer;
  activity_id uuid;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.members.updateRole');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;

  -- R1.
  perform internal.require_space_admin(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);

  if p_role not in ('owner','admin','member') then
    raise exception 'unknown role %', p_role using errcode = '22023';
  end if;

  -- The space is named in the predicate, not just used to authorize: a member
  -- id from another Space must be "not found here", never "found and updated".
  -- 230: so is a member who has left or been removed.
  select * into target from public.members
   where entity_id = p_member_id and space_id = p_space_id and status = 'active'
   for update;
  if target.entity_id is null then
    raise exception 'member not found in this space' using errcode = 'P0002';
  end if;

  select m.role into caller_role from public.members m
   where m.space_id = p_space_id and m.identity_id = internal.identity_id()
     and m.status = 'active';

  -- R2. Both directions, in one test: the owner role may not be handed out or
  -- taken away by anyone who does not hold it.
  if (p_role = 'owner' or target.role = 'owner') and caller_role is distinct from 'owner' then
    raise exception 'only an owner may grant or revoke the owner role'
      using errcode = '42501';
  end if;

  -- Already there. Returning the entity rather than raising keeps the
  -- operation idempotent for a client that re-sends a settled state — and
  -- keeps the ledger's record of that cmid truthful about what happened.
  if target.role = p_role then
    result := internal.command_result(p_member_id, null, null, array[p_member_id]);
    return internal.ledger_record(p_client_mutation_id, 'spaces.members.updateRole', result);
  end if;

  -- R3. The lock is over the space's OWNER rows, taken before the count, so
  -- two concurrent demotions serialize on each other instead of both reading
  -- "there are two of us" and both committing. A concurrent PROMOTION is not
  -- covered by this lock and does not need to be: it only ever raises the
  -- count, and the invariant this defends is a floor.
  if target.role = 'owner' and p_role <> 'owner' then
    perform 1 from public.members
     where space_id = p_space_id and role = 'owner' and status = 'active' for update;
    select count(*) into owner_count from public.members
     where space_id = p_space_id and role = 'owner' and status = 'active';
    if owner_count <= 1 then
      raise exception 'a space must keep at least one owner: promote a successor first'
        using errcode = '42501';
    end if;
  end if;

  update public.members set role = p_role where entity_id = p_member_id;

  -- 'updated' is the activity verb 003:35-38 admits for this; the summary
  -- carries both ends so a reader of the feed learns the direction without
  -- re-reading the row it describes (which by then may have moved again).
  activity_id := internal.record_activity(p_space_id, p_member_id, actor, 'updated',
                   null, jsonb_build_object('role', p_role, 'previousRole', target.role));
  -- The person whose standing changed is told. `internal.notify` already
  -- refuses to notify an actor about their own action, so an admin adjusting
  -- their own row is silent by construction.
  perform internal.notify(p_space_id, p_member_id, 'role.changed', p_member_id, actor,
                          jsonb_build_object('role', p_role, 'previousRole', target.role),
                          activity_id);

  result := internal.command_result(p_member_id, null, activity_id, array[p_member_id]);
  return internal.ledger_record(p_client_mutation_id, 'spaces.members.updateRole', result);
end
$$;

-- ---------------------------------------------------------------------------
-- internal.end_membership — the one writer of a tombstone and its effects.
-- Callers have authorized, locked the row and bound the actor. Everything is
-- done BEFORE the status flips: the edge and activity triggers still see an
-- active member while they run.
-- ---------------------------------------------------------------------------

create or replace function internal.end_membership(p_member_id uuid, p_status text, p_actor uuid)
returns jsonb language plpgsql
set search_path = public, internal, pg_temp as $$
declare
  target public.members;
  target_account uuid;
  persona_ids uuid[];
  stopped_ids uuid[];
  revoked_count integer;
  unassigned_ids uuid[] := '{}';
  edge_row public.edges;
  v_ended_reason text;
  person_name text;
  activity_id uuid;
  now_at timestamptz := now();
begin
  if p_status not in ('left', 'removed') then
    raise exception 'unknown membership ending %', p_status using errcode = '22023';
  end if;
  select * into target from public.members where entity_id = p_member_id for update;
  if target.entity_id is null or target.status <> 'active' then
    raise exception 'member not found in this space' using errcode = 'P0002';
  end if;

  select a.id into target_account from public.accounts a where a.identity_id = target.identity_id;
  select coalesce(array_agg(tm.entity_id order by tm.entity_id), '{}'::uuid[]) into persona_ids
    from public.team_members tm where tm.owner_member_id = target.entity_id;
  select coalesce(nullif(btrim(target.display_name), ''), nullif(btrim(p.display_name), ''), 'A member')
    into person_name
    from public.user_profiles p where p.identity_id = target.identity_id;
  person_name := coalesce(person_name, 'A member');

  -- 1. THEIR LIVE WORK SESSIONS IN THIS SPACE. Three keys, any of which makes
  --    a session theirs: their account's live agent token drives it; they
  --    launched it on a space credential (206's launcher key — SC-6's
  --    containment set, so that containment fires here); it was created as
  --    them. Nothing here keys on a persona's OWNER: another member driving
  --    this member's persona is that member's session.
  select coalesce(array_agg(ws.entity_id order by ws.entity_id), '{}'::uuid[]) into stopped_ids
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where e.space_id = target.space_id
     and ws.status in ('spawning', 'running', 'idle')
     and (
       e.created_by = target.entity_id
       or (target_account is not null and exists (
             select 1 from public.auth_sessions s
              where s.work_session_id = ws.entity_id
                and s.account_id = target_account
                and s.revoked_at is null))
       or (target_account is not null and exists (
             select 1 from public.session_space_credentials ssc
              where ssc.work_session_id = ws.entity_id
                and ssc.launcher_account_id = target_account))
     );

  v_ended_reason := case p_status
    when 'left' then 'Stopped because the member who launched it left the space.'
    else 'Stopped because the member who launched it was removed from the space.' end;

  if cardinality(stopped_ids) > 0 then
    -- The single-writer flag work_session_transition itself sets (R29). The
    -- transition RPC cannot be used: it re-checks the LAUNCHER's membership,
    -- which is what is ending, and a remover need not share it.
    perform set_config('tm8.work_session_transition', 'on', true);
    update public.work_sessions
       set status = 'exited',
           ended_kind = 'stopped_by_operator',
           ended_reason = v_ended_reason,
           error = coalesce(error, 'membership ended: the PTY is killed after commit, exit code not observed'),
           exited_at = coalesce(exited_at, now_at)
     where entity_id = any(stopped_ids);
    perform set_config('tm8.work_session_transition', 'off', true);
    update public.entities
       set version = version + 1, activity_at = now_at, updated_at = now_at
     where id = any(stopped_ids);
  end if;

  -- 2. TOKENS. Pinned to this space for their account (agent tokens, and any
  --    future pinned kind); every token of a session stopped above, whoever
  --    minted it; agent tokens acting as their personas. An unpinned
  --    browser/cli session is theirs for their other spaces and stays — every
  --    membership helper now refuses it here.
  update public.auth_sessions s
     set revoked_at = now_at
   where s.revoked_at is null
     and (
       (target_account is not null and s.account_id = target_account and s.space_id = target.space_id)
       or s.work_session_id = any(stopped_ids)
       or (s.kind in ('agent', 'agent_runtime') and s.acting_as_team_member_id = any(persona_ids))
     );
  get diagnostics revoked_count = row_count;

  -- 3. THEIR PERSONAS: kept, deactivated.
  update public.team_members
     set deactivated_at = now_at
   where owner_member_id = target.entity_id and deactivated_at is null;

  -- 4. ASSIGNMENTS, each with the reason on the task's own feed.
  for edge_row in
    select g.* from public.edges g
     where g.type = 'assigned_to'
       and g.space_id = target.space_id
       and (g.dst_id = target.entity_id or g.dst_id = any(persona_ids))
     order by g.created_at, g.id
     for update
  loop
    delete from public.edges where id = edge_row.id;
    perform internal.record_activity(
      target.space_id, edge_row.src_id, p_actor, 'unlinked', edge_row.id,
      jsonb_build_object(
        'type', 'assigned_to',
        'dstId', edge_row.dst_id,
        'reason', case p_status when 'left' then 'member_left' else 'member_removed' end,
        'note', person_name || case p_status when 'left' then ' left the space' else ' was removed from the space' end
                || ', so this is no longer assigned to them.'));
    unassigned_ids := unassigned_ids || edge_row.src_id;
  end loop;

  -- 5. LINK TOKENS they own (W6). Guarded by existence so W6 lands without
  --    touching this function; dynamic so this compiles before the table does.
  if to_regclass('public.space_link_tokens') is not null then
    execute 'delete from public.space_link_tokens where member_id = $1' using target.entity_id;
  end if;

  -- 6. THE TOMBSTONE. Last, so every step above ran against an active member.
  update public.members
     set status = p_status, left_at = now_at
   where entity_id = target.entity_id;
  update public.entities
     set version = version + 1, activity_at = now_at, updated_at = now_at
   where id = target.entity_id;

  activity_id := internal.record_activity(target.space_id, target.entity_id, p_actor, 'updated',
                   null, jsonb_build_object('status', p_status, 'previousStatus', 'active'));

  return jsonb_build_object(
    'spaceId', target.space_id,
    'memberId', target.entity_id,
    'status', p_status,
    'leftAt', now_at,
    'stoppedSessionIds', to_jsonb(stopped_ids),
    'deactivatedPersonaIds', to_jsonb(persona_ids),
    'unassignedEntityIds', to_jsonb(array(select distinct u from unnest(unassigned_ids) u order by u)),
    'revokedTokenCount', revoked_count,
    'activity', activity_id,
    -- For the server's after-commit step (closing this identity's sockets on
    -- this space). The facade strips it before the response.
    'identityId', target.identity_id);
end
$$;

revoke all on function internal.end_membership(uuid, text, uuid) from public;

-- spaces.leave — the caller ends their own membership. Human-only: an agent
-- token must not be able to take its launcher out of a space.
create or replace function public.leave_space(p_space_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target public.members;
  owner_count integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.leave');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  perform internal.require_space_member(p_space_id);
  select * into target from public.members
   where space_id = p_space_id and identity_id = internal.identity_id() and status = 'active'
   for update;
  if target.entity_id is null then
    raise exception 'not a member of this space' using errcode = 'P0002';
  end if;

  -- The owner floor, as set_member_role keeps it: lock, then count.
  if target.role = 'owner' then
    perform 1 from public.members
     where space_id = p_space_id and role = 'owner' and status = 'active' for update;
    select count(*) into owner_count from public.members
     where space_id = p_space_id and role = 'owner' and status = 'active';
    if owner_count <= 1 then
      raise exception 'the last owner cannot leave: make someone else an owner first'
        using errcode = '42501';
    end if;
  end if;

  perform internal.bind_actor(target.entity_id);
  result := internal.end_membership(target.entity_id, 'left', target.entity_id);
  return internal.ledger_record(p_client_mutation_id, 'spaces.leave', result);
end
$$;

-- spaces.members.remove — an admin ends someone else's membership. Only an
-- owner removes an owner; yourself goes through spaces.leave.
create or replace function public.remove_space_member(p_space_id uuid, p_member_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  target public.members;
  caller_role text;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaces.members.remove');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'spaceId', p_space_id::text, 'space');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  perform internal.require_space_admin(p_space_id);
  select m.entity_id, m.role into actor, caller_role from public.members m
   where m.space_id = p_space_id and m.identity_id = internal.identity_id() and m.status = 'active';

  select * into target from public.members
   where entity_id = p_member_id and space_id = p_space_id and status = 'active'
   for update;
  if target.entity_id is null then
    raise exception 'member not found in this space' using errcode = 'P0002';
  end if;
  if target.entity_id = actor then
    raise exception 'to leave a space yourself, use spaces.leave' using errcode = '22023';
  end if;
  if target.role = 'owner' and caller_role is distinct from 'owner' then
    raise exception 'only an owner may remove an owner' using errcode = '42501';
  end if;

  perform internal.bind_actor(actor);
  result := internal.end_membership(target.entity_id, 'removed', actor);
  return internal.ledger_record(p_client_mutation_id, 'spaces.members.remove', result);
end
$$;

-- accounts.disable — a node admin turns an account off. set_account_disabled
-- (007) already revokes every session; this adds the human-only gate, the
-- self/owner guards, idempotency, and the live work sessions the server must
-- contain after commit (captured BEFORE the revoke, while the token still
-- names them). Memberships are untouched: the graph keeps who acted (R6).
create or replace function public.disable_account(p_account_id uuid, p_client_mutation_id text default null)
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  target public.accounts;
  live_ids uuid[];
  revoked_count integer;
  result jsonb;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'accounts.disable');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(replay ->> 'accountId', p_account_id::text, 'account');
    return replay;
  end if;

  perform internal.require_human_auth_kind();
  perform internal.require_node_admin();
  select * into target from public.accounts where id = p_account_id for update;
  if target.id is null then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target.identity_id = internal.identity_id() then
    raise exception 'you cannot disable your own account' using errcode = '42501';
  end if;
  if target.is_owner then
    raise exception 'the node owner''s account cannot be disabled' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct ws.entity_id), '{}'::uuid[]) into live_ids
    from public.work_sessions ws
   where ws.status in ('spawning', 'running', 'idle')
     and (exists (select 1 from public.auth_sessions s
                   where s.work_session_id = ws.entity_id
                     and s.account_id = p_account_id
                     and s.revoked_at is null)
          or exists (select 1 from public.session_space_credentials ssc
                      where ssc.work_session_id = ws.entity_id
                        and ssc.launcher_account_id = p_account_id));

  select count(*) into revoked_count from public.auth_sessions
   where account_id = p_account_id and revoked_at is null;
  perform public.set_account_disabled(p_account_id, true);
  select * into target from public.accounts where id = p_account_id;

  result := jsonb_build_object(
    'accountId', target.id,
    'status', target.status,
    'disabledAt', target.disabled_at,
    'revokedSessionCount', revoked_count,
    'stoppedSessionIds', to_jsonb(live_ids),
    'identityId', target.identity_id);
  return internal.ledger_record(p_client_mutation_id, 'accounts.disable', result);
end
$$;

revoke all on function public.leave_space(uuid, text) from public;
grant execute on function public.leave_space(uuid, text) to tm8_app;
revoke all on function public.remove_space_member(uuid, uuid, text) from public;
grant execute on function public.remove_space_member(uuid, uuid, text) to tm8_app;
revoke all on function public.disable_account(uuid, text) from public;
grant execute on function public.disable_account(uuid, text) to tm8_app;

-- VERIFY: every pinned helper still reaches the pin inline (227/A10), and
-- every membership helper reads active rows only.
do $verify$
declare missing text;
begin
  select string_agg(p.proname, ', ') into missing
    from pg_proc p
   where p.pronamespace = 'internal'::regnamespace
     and p.proname in ('member_space_ids','is_space_member','is_space_admin',
                       'current_member_id','can_act_as','entity_readable','entity_row_visible')
     and (p.prosrc not like '%current_setting(''tm8.session_space_id'', true)%'
          or p.prosrc like '%session_space_id()%');
  if missing is not null then
    raise exception 'VERIFY 230: not pinned inline: %', missing;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into missing
    from pg_proc p
   where p.proname in ('member_space_ids','is_space_member','is_space_admin','current_member_id',
                       'can_act_as','entity_readable','entity_row_visible',
                       'inspect_owned_teammate_inbox','current_actor_scope','current_identity',
                       'current_space_identity','queue_tracking_refresh','preview_invite')
     and p.pronamespace in ('internal'::regnamespace, 'public'::regnamespace)
     and p.prosrc not like '%status = ''active''%'
     and p.prosrc not like '%status=''active''%';
  if missing is not null then
    raise exception 'VERIFY 230: membership helper reads tombstoned rows: %', missing;
  end if;
end
$verify$;

reset role;
