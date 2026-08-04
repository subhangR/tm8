-- 073 — teammates are shared launch personas within their space.
--
-- A teammate's owner_member_id records who created/configures the persona; it
-- is not an exclusive right to run it. Every active human member of the same
-- space may launch and operate that teammate. The work_session envelope still
-- records the launching member in entities.created_by, while the session's
-- relates_to / participates_in edge records which teammate is running.
--
-- Node administration does not grant space membership, and neither a caller
-- from another space nor a deleted teammate becomes actable through this rule.

set role tm8_graph_owner;

create or replace function internal.can_act_as(target_actor uuid, target_space uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and (
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

comment on function internal.can_act_as(uuid, uuid) is
  'A member may author as their own member row or any active teammate in the same space. '
  'Teammate ownership controls persona administration, not launch/use authority.';

reset role;
