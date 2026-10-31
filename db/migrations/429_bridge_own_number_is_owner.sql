-- =============================================================================
-- 429 — Bridges: a message from the linked number itself is its owner's.
-- (429: main holds 425–427; #1481 holds 428.)
--
-- The number a bridge rides was linked by its owner, who proved control of it
-- by pairing the device. Yet a message they typed on that phone resolved to a
-- GUEST: bridge_resolve_author (395) only knows bridge_identity_links, and an
-- owner has no reason to verify the number they just linked. With the default
-- whoMayTrigger 'linked', the owner's own `@tm8` was logged and never routed,
-- so a new session bridge received nothing. Found on prod 2026-10-31.
--
-- internal.bridge_resolve_author is restated from 395 (its only and latest
-- definition). The one change: when no identity link matches, a sender whose
-- ids include the connection's own ids (bridge_connections.self_ids, 398) is
-- the connection owner's ACTIVE member in the bridge's space, trust 'linked'.
-- Links still win when present; an owner who has left the space stays a guest.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

create or replace function internal.bridge_resolve_author(p_bridge_id uuid, p_sender_external_id text)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  ids text[];
  link public.bridge_identity_links;
  member_id uuid;
  participant public.bridge_participants;
  owner_identity public.accounts.identity_id%type;
begin
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then
    raise exception 'bridge not found' using errcode = 'P0002';
  end if;
  select * into participant from public.bridge_participants
   where bridge_id = p_bridge_id and external_id = p_sender_external_id;
  ids := array[p_sender_external_id] || coalesce(participant.alt_external_ids, '{}');

  select * into link from public.bridge_identity_links l
   where l.provider = b.provider and l.external_id = any(ids) and l.revoked_at is null
     and l.space_id is null
   order by l.verified_at limit 1;
  if link.id is null then
    select * into link from public.bridge_identity_links l
     where l.provider = b.provider and l.external_id = any(ids) and l.revoked_at is null
       and l.space_id = b.space_id
     order by l.verified_at limit 1;
  end if;

  if link.id is not null then
    select m.entity_id into member_id
      from public.members m join public.entities e on e.id = m.entity_id
     where m.space_id = b.space_id and m.identity_id = link.identity_id
       and m.status = 'active' and e.deleted_at is null
     limit 1;
  else
    -- 429: the linked number itself speaks for the account that linked it.
    select a.identity_id into owner_identity
      from public.bridge_connections c join public.accounts a on a.id = c.owner_account_id
     where c.id = b.connection_id and c.self_ids && ids;
    if owner_identity is not null then
      select m.entity_id into member_id
        from public.members m join public.entities e on e.id = m.entity_id
       where m.space_id = b.space_id and m.identity_id = owner_identity
         and m.status = 'active' and e.deleted_at is null
       limit 1;
    end if;
  end if;

  if member_id is null then
    return jsonb_build_object('kind', 'bridge', 'actorId', p_bridge_id, 'trust', 'guest',
      'participant', jsonb_build_object('displayName', coalesce(participant.display_name, 'Guest')));
  end if;
  if link.id is null then
    return jsonb_build_object('kind', 'member', 'actorId', member_id, 'trust', 'linked',
      'identityId', owner_identity, 'linkId', null, 'ownNumber', true,
      'participant', jsonb_build_object('displayName', coalesce(participant.display_name, '')));
  end if;
  return jsonb_build_object('kind', 'member', 'actorId', member_id,
    'trust', case when link.space_id is null then 'linked' else 'asserted' end,
    'identityId', link.identity_id, 'linkId', link.id,
    'participant', jsonb_build_object('displayName', coalesce(participant.display_name, '')));
end
$$;
revoke all on function internal.bridge_resolve_author(uuid, text) from public;
grant execute on function internal.bridge_resolve_author(uuid, text) to tm8_graph_owner;

reset role;
