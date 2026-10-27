-- =============================================================================
-- 333: a link's target name for the caller's own pinned session.
--
-- 251/278 show `targetSpaceName` only when internal.is_space_member(target)
-- holds. That check honours the session pin (227), and every agent session is
-- pinned to its home space, so an agent never saw a target's name, even when
-- its human is a member of the target and the agent was reading the target
-- through that very link. `tm8 link list` showed bare ids and nobody could
-- tell which linked space was which.
--
-- The name now also shows when the caller's identity is an active member of
-- the target AND the caller's own row on this link is signed_in. Such a caller
-- can already read the whole target through the link, so the name tells it
-- nothing new. P8 is unchanged: a home member with no membership in the target,
-- or with no live sign-in of their own on the link, still sees no name.
--
-- Body otherwise 278's, verbatim.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function internal.space_link_json(p_link_id uuid, p_member_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', l.entity_id,
    'homeSpaceId', l.home_space_id,
    'targetSpaceId', l.target_space_id,
    'targetServerId', l.target_server_id,
    'targetSpaceName', (select s.name from public.spaces s
                         where s.id = l.target_space_id
                           and l.target_server_id is null
                           and (internal.is_space_member(s.id)
                                or (internal.identity_id() is not null
                                    and exists (select 1 from public.space_link_tokens t
                                                 where t.link_id = l.entity_id
                                                   and t.member_id = p_member_id
                                                   and t.status = 'signed_in')
                                    and exists (select 1 from public.members m
                                                 where m.space_id = s.id
                                                   and m.identity_id = internal.identity_id()
                                                   and m.status = 'active')))),
    'createdAt', l.created_at,
    'targetRevokedAt', l.target_revoked_at,
    'statusSummary', jsonb_build_object(
      'signedIn',    (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'signed_in'),
      'signedOut',   (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'signed_out'),
      'left',        (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'left'),
      'unreachable', (select count(*) from public.space_link_tokens t where t.link_id = l.entity_id and t.status = 'unreachable')),
    'mine', (select internal.space_link_row_json(t) from public.space_link_tokens t
              where t.link_id = l.entity_id and t.member_id = p_member_id))
    from public.space_links l
   where l.entity_id = p_link_id
$$;

revoke all on function internal.space_link_json(uuid, uuid) from public;

reset role;
