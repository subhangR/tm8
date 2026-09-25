-- =============================================================================
-- 227 — the membership helpers honour `tm8.session_space_id` (plan 01a0d9eb W0a).
--
-- THE LEAK. An agent token is minted for one work session or one chat in space
-- A, but every helper below asks only "is this IDENTITY a member of X?". The
-- identity behind an agent token is the human who launched it, a member of
-- every space they belong to, so the token could read and write in space B.
--
-- THE PIN. When the server binds `tm8.session_space_id` (226's
-- `auth_sessions.space_id`, forwarded for agent kinds while
-- `TM8_SPACE_SESSIONS` is not `off`), every membership answer is intersected
-- with that one space. When the claim is unset or blank, the added conjunct is
-- `null is null` = true and each helper is exactly its previous body.
--
--   member_space_ids()      (218)  every member_space_ids RLS policy + 220 RPCs
--   is_space_member(s)      (002)  and so require_space_member, which calls it
--   is_space_admin(s)       (002)  and so require_space_admin
--   current_member_id(s)    (002)  and so resolve_actor
--   can_act_as(a, s)        (075)
--   entity_readable(t)      (159)  inlined membership
--   entity_row_visible(...) (159)  inlined membership
--
-- INLINE, NOT A CALL (plan A10). 159 measured 4.8x from removing one nested
-- SQL-function level from these predicates, so the pin is the literal
-- `nullif(current_setting('tm8.session_space_id', true), '')::uuid`, not
-- `internal.session_space_id()`. That function exists for callers outside the
-- hot path (tests, W3's audit). Each body is otherwise the latest shipped text.
--
-- FAILS CLOSED. A claim that is not a uuid raises 22P02 rather than reading as
-- unpinned; the server only ever binds a value read from a uuid column.
--
-- INLINE-MEMBERSHIP SURFACES (review round 1). Policies that inline their own
-- membership (user_profiles, read_marks, file_upload_slots, notifications,
-- work_session_view_preferences) read `members` or `entities` under the
-- caller's RLS, so they inherit the pin from members_select/entities_select.
-- The SECURITY DEFINER inspect_owned_teammate_inbox reads them without RLS and
-- is pinned below.
-- The public arm of spaces_select is W3's (K7).
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function internal.session_space_id()
returns uuid language sql stable as $$
  select nullif(internal.claim_text('tm8.session_space_id'), '')::uuid
$$;

comment on function internal.session_space_id() is
  'The space this request''s session is pinned to (227), or null for an '
  'unpinned session. Not for RLS hot paths: those inline the expression (A10).';

create or replace function internal.member_space_ids()
returns uuid[] language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select coalesce(array_agg(m.space_id), '{}'::uuid[])
    from public.members m
   where m.identity_id = internal.identity_id()
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
         and m.role in ('owner','admin')
    )
$$;

create or replace function internal.current_member_id(target_space uuid)
returns uuid language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select m.entity_id from public.members m
   where m.space_id = target_space and m.identity_id = internal.identity_id()
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
    )
    or (
      exists (
        select 1
          from public.members viewer_member
          join public.entities viewer_entity on viewer_entity.id = viewer_member.entity_id
         where viewer_member.space_id = target_space
           and viewer_member.identity_id = internal.identity_id()
           and viewer_entity.deleted_at is null
      )
      and exists (
        select 1
          from public.team_members teammate
          join public.entities teammate_entity on teammate_entity.id = teammate.entity_id
         where teammate.entity_id = target_actor
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

revoke all on function internal.session_space_id() from public;
grant execute on function internal.session_space_id() to tm8_app;
revoke all on function internal.member_space_ids() from public;
grant execute on function internal.member_space_ids() to tm8_app;
revoke all on function internal.is_space_member(uuid) from public;
grant execute on function internal.is_space_member(uuid) to tm8_app;
revoke all on function internal.is_space_admin(uuid) from public;
grant execute on function internal.is_space_admin(uuid) to tm8_app;
revoke all on function internal.current_member_id(uuid) from public;
grant execute on function internal.current_member_id(uuid) to tm8_app;
revoke all on function internal.can_act_as(uuid, uuid) from public;
grant execute on function internal.can_act_as(uuid, uuid) to tm8_app;
revoke all on function internal.entity_readable(uuid) from public;
grant execute on function internal.entity_readable(uuid) to tm8_app;
revoke all on function internal.entity_row_visible(uuid, uuid, text, text) from public;
grant execute on function internal.entity_row_visible(uuid, uuid, text, text) to tm8_app;


-- ---------------------------------------------------------------------------
-- Inline-membership surfaces (review round 1). An RLS policy's subquery on
-- `members` runs under the caller's RLS, and members_select is pinned through
-- member_space_ids() above, so file_upload_slots_select, notifications_select,
-- user_profiles_select and read_marks_select already refuse B (the matrix pins
-- the first two). A SECURITY DEFINER function reads `members` WITHOUT RLS, so
-- the one such surface an agent reaches needs the conjunct itself.
--
-- inspect_owned_teammate_inbox (023, both overloads): SECURITY DEFINER, gated
-- only on "I own this teammate". `inbox.list` calls it when the caller is not
-- acting, which is exactly the persona-less agent session above.
create or replace function public.inspect_owned_teammate_inbox(p_team_member_id uuid, p_limit integer default 50)
returns setof public.notifications language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select n.* from public.notifications n
  join public.team_members tm on tm.entity_id = n.recipient_team_member_id
  join public.members owner on owner.entity_id = tm.owner_member_id
  where tm.entity_id = p_team_member_id
    and owner.identity_id = internal.identity_id()
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

revoke all on function public.inspect_owned_teammate_inbox(uuid, integer) from public;
grant execute on function public.inspect_owned_teammate_inbox(uuid, integer) to tm8_app;
revoke all on function public.inspect_owned_teammate_inbox(uuid, uuid, boolean, timestamptz, uuid, integer) from public;
grant execute on function public.inspect_owned_teammate_inbox(uuid, uuid, boolean, timestamptz, uuid, integer) to tm8_app;

-- VERIFY: no helper on the pinned list reaches the pin through a call (A10).
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
    raise exception 'VERIFY 227: not pinned inline: %', missing;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into missing
    from pg_proc p
   where p.proname = 'inspect_owned_teammate_inbox'
     and p.pronamespace = 'public'::regnamespace
     and (p.prosrc not like '%current_setting(''tm8.session_space_id'', true)%'
          or p.prosrc like '%session_space_id()%');
  if missing is not null then
    raise exception 'VERIFY 227: not pinned inline: %', missing;
  end if;

end
$verify$;

reset role;
