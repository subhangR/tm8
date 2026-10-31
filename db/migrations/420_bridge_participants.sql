-- =============================================================================
-- 420 — Bridges P: the People tab's read and write (bridges.participants.list,
--       bridges.participants.update).
-- (Provisional number; the bridges merger assigns the final one.)
-- (Authored as 404; renumbered to 420 at merge by the bridges merger: main's 404 is the launch lane's boot phase.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §2.4, §3.2,
-- §3.4, §4.4 (People); D50-D51 (§8). Task 01a189db-34a6-7873-975e-9da024aa70ac.
--
-- Predecessor: 395_bridge_schema.sql. Adds functions only; no table, no policy.
--
-- WHY A DEFINER READ, NOT A SELECT UNDER RLS (D50). A participant's trust word
-- needs the link that resolves it, and 395's policy on bridge_identity_links
-- lets a member see only their own links (and an admin only space-scoped ones):
-- identity-scoped rows "surface to a space only through the resolver, never as
-- a list" (§3.2). So this function resolves each row exactly as
-- internal.bridge_resolve_author does — identity-scoped link first, else this
-- space's assertion, then that identity's ACTIVE member row in the bridge's
-- space — and returns the OUTCOME (trust, member id), never the link row, its
-- id or its identity id. A link whose member left reads as a guest, as on
-- inbound.
--
-- MASKING (§2.4, §6). External ids go through internal.bridge_mask unless the
-- caller is an admin of the bridge's space; a member's alternate ids are
-- withheld (an empty array), not masked, because '…9494' twice says nothing.
-- Readability is checked here (definer), as bridge_view does: a caller who
-- cannot read the bridge entity gets null.
--
-- THE WRITE (D52). One owner (coordinator ruling, 2026-10-30: P owns
-- bridges.participants.update; B1c's #1436 drops its copy). The assertion
-- semantics live in ONE internal core, internal.bridge_assert_participant,
-- with B1c's rules; B1c's Phase-1 import calls it server-side. The catalog
-- door, public.update_bridge_participant, adds the human-only and
-- space-admin checks and the mute. An assertion makes a number count as a
-- person, so no agent makes one. The activity row names the participant
-- masked, never by its raw id.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.bridge_participants_view(p_bridge_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  admin boolean;
  me text := internal.identity_id();
begin
  if not internal.entity_readable(p_bridge_id) then return null; end if;
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null then return null; end if;
  admin := internal.is_space_admin(b.space_id);

  return jsonb_build_object('spaceId', b.space_id, 'admin', admin, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
             'externalId', case when admin then p.external_id else internal.bridge_mask(p.external_id) end,
             'altExternalIds', case when admin then to_jsonb(p.alt_external_ids) else '[]'::jsonb end,
             'masked', not admin,
             'displayName', p.display_name,
             'avatarRef', p.avatar_ref,
             'muted', p.muted,
             'firstSeenAt', p.first_seen_at,
             'lastSeenAt', p.last_seen_at,
             'messageCount', p.message_count,
             'trust', case when m.member_id is null then 'guest'
                           when l.space_id is null then 'linked' else 'asserted' end,
             'memberId', m.member_id,
             'link', case when m.member_id is null then null
                          else jsonb_build_object('method', l.method, 'verifiedAt', l.verified_at) end,
             'you', m.member_id is not null and me is not null and l.identity_id = me)
           order by p.last_seen_at desc, p.external_id)
      from public.bridge_participants p
      -- The resolver's order: an identity-scoped link, else this space's assertion.
      left join lateral (
        select l.* from public.bridge_identity_links l
         where l.provider = b.provider and l.revoked_at is null
           and (l.external_id = p.external_id or l.external_id = any(p.alt_external_ids))
           and (l.space_id is null or l.space_id = b.space_id)
         order by (l.space_id is not null), l.verified_at
         limit 1) l on true
      left join lateral (
        select mem.entity_id as member_id
          from public.members mem join public.entities me_e on me_e.id = mem.entity_id
         where l.id is not null and mem.space_id = b.space_id and mem.identity_id = l.identity_id
           and mem.status = 'active' and me_e.deleted_at is null
         limit 1) m on true
     where p.bridge_id = p_bridge_id), '[]'::jsonb));
end
$$;
revoke all on function internal.bridge_participants_view(uuid) from public;
grant execute on function internal.bridge_participants_view(uuid) to tm8_app;

-- A person's provider address (B1c's rule, shared): one address, no spaces;
-- on WhatsApp a phone-number JID or a LID, never a group.
create or replace function internal.bridge_valid_external_id(p_provider text, p_external_id text)
returns void language plpgsql immutable set search_path = public, internal, pg_temp as $$
begin
  if p_external_id is null or char_length(p_external_id) not between 1 and 256 or p_external_id ~ '\s' then
    raise exception 'externalId must be one provider address, without spaces' using errcode = '22023';
  end if;
  if p_provider = 'whatsapp' and p_external_id !~ '^[0-9]{5,20}@(s\.whatsapp\.net|lid)$' then
    raise exception 'a WhatsApp link names a person: <digits>@s.whatsapp.net or <digits>@lid' using errcode = '22023';
  end if;
end
$$;
revoke all on function internal.bridge_valid_external_id(text, text) from public;

-- THE ONE ASSERTION CORE (D52, coordinator ruling 2026-10-30). Both the
-- catalog door below and B1c's Phase-1 import (server-side, as the importing
-- admin) call this; neither re-implements it. It checks NO caller rights: the
-- caller has. It needs no participant row (the import runs before anyone has
-- spoken). p_member_id null revokes. Returns whether anything changed.
-- p_alternates are the same person's other addresses (a WhatsApp number and
-- its LID): inbound keys a roster row by the sender and keeps the other as an
-- alternate, and the resolver reads both, so every rule here reads all of
-- them too (review r2 F4). The import passes none.
--   assert   refused `link_conflict` when a verified (identity-scoped) link,
--            or this space's live assertion, on ANY of the addresses names
--            someone else; the same person is a no-op; a new assertion is
--            written on p_external_id
--   revoke   ends this space's assertions on every address, even beside a
--            verified link; nothing to revoke is a no-op
create or replace function internal.bridge_assert_participant(
  p_space_id uuid, p_provider text, p_external_id text, p_member_id uuid, p_actor uuid,
  p_alternates text[] default '{}'
) returns boolean language plpgsql set search_path = public, internal, pg_temp as $$
declare
  ids text[];
  v_identity text;
  v_id text;
  live_other boolean;
  live_same boolean;
begin
  perform internal.bridge_valid_external_id(p_provider, p_external_id);
  ids := array(select distinct x from unnest(array[p_external_id] || coalesce(p_alternates, '{}')) x where x is not null);
  foreach v_id in array ids loop
    perform internal.bridge_valid_external_id(p_provider, v_id);
  end loop;
  -- Lock this space's live assertions on the person before deciding.
  perform 1 from public.bridge_identity_links
   where provider = p_provider and external_id = any(ids)
     and space_id = p_space_id and revoked_at is null
   for update;

  if p_member_id is null then
    update public.bridge_identity_links set revoked_at = now()
     where provider = p_provider and external_id = any(ids)
       and space_id = p_space_id and revoked_at is null;
    return found;
  end if;

  -- Only a member of THIS space: an admin of one space cannot make a number
  -- count as someone in another (D5).
  select m.identity_id into v_identity
    from public.members m join public.entities e on e.id = m.entity_id
   where m.entity_id = p_member_id and m.space_id = p_space_id
     and m.status = 'active' and e.deleted_at is null;
  if v_identity is null then
    raise exception 'member not found in this space' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.bridge_identity_links
              where provider = p_provider and external_id = any(ids)
                and space_id is null and revoked_at is null and identity_id <> v_identity) then
    perform internal.bridge_refuse('link_conflict',
      'this address is verified as someone else; they must unlink it first');
  end if;
  select bool_or(identity_id <> v_identity), bool_or(identity_id = v_identity) into live_other, live_same
    from public.bridge_identity_links
   where provider = p_provider and external_id = any(ids)
     and space_id = p_space_id and revoked_at is null;
  if coalesce(live_other, false) then
    perform internal.bridge_refuse('link_conflict',
      'this address is already asserted as another member here; revoke that first');
  end if;
  -- Already them: verified on any address, or asserted here.
  if coalesce(live_same, false) or exists (select 1 from public.bridge_identity_links
              where provider = p_provider and external_id = any(ids)
                and space_id is null and revoked_at is null and identity_id = v_identity) then
    return false;
  end if;
  begin
    insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id,
                                             asserted_by_member_id, verified_at)
    values (p_provider, p_external_id, v_identity, 'admin', p_space_id, p_actor, now());
  exception when unique_violation then
    perform internal.bridge_refuse('link_conflict', 'a concurrent assertion for this address won; read it and retry');
  end;
  return true;
end
$$;
revoke all on function internal.bridge_assert_participant(uuid, text, text, uuid, uuid, text[]) from public;
grant execute on function internal.bridge_assert_participant(uuid, text, text, uuid, uuid, text[]) to tm8_graph_owner;

-- bridges.participants.update: the catalog door. Human-only and space-admin
-- on top of the core. Mute needs the participant row; an assertion does not.
create or replace function public.update_bridge_participant(
  p_bridge_id uuid, p_external_id text, p_patch jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; actor uuid; b public.bridges; k text; p public.bridge_participants;
  v_changed boolean := false; v_fields jsonb := '{}'::jsonb;
begin
  perform internal.require_human_auth_kind();
  b := internal.bridge_for_admin(p_bridge_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.participants.update');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'bridgeId', p_bridge_id::text, 'entity');
    return replay;
  end if;
  actor := internal.resolve_actor(p_actor_id, b.space_id);
  perform internal.bind_actor(actor);

  if jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb then
    raise exception 'patch must be a non-empty object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not k = any(array['muted', 'memberId']) then
      raise exception 'unknown participant field %', k using errcode = '22023';
    end if;
  end loop;

  -- The roster row this address belongs to, by its key or as an alternate
  -- (inbound keys a row by the sender and keeps the other id as an alternate).
  select * into p from public.bridge_participants
   where bridge_id = p_bridge_id and (external_id = p_external_id or p_external_id = any(alt_external_ids))
   order by (external_id = p_external_id) desc limit 1;

  if p_patch ? 'muted' then
    if jsonb_typeof(p_patch -> 'muted') <> 'boolean' then
      raise exception 'muted must be a boolean' using errcode = '22023';
    end if;
    if p.bridge_id is null then
      raise exception 'participant not found on this bridge' using errcode = 'P0002';
    end if;
    update public.bridge_participants set muted = (p_patch ->> 'muted')::boolean
     where bridge_id = p_bridge_id and external_id = p.external_id and muted is distinct from (p_patch ->> 'muted')::boolean;
    if found then v_changed := true; v_fields := v_fields || jsonb_build_object('muted', (p_patch ->> 'muted')::boolean); end if;
  end if;

  if p_patch ? 'memberId' then
    if jsonb_typeof(p_patch -> 'memberId') not in ('null', 'string') then
      raise exception 'memberId must be a member id or null' using errcode = '22023';
    end if;
    if internal.bridge_assert_participant(b.space_id, b.provider, p_external_id,
                                          nullif(p_patch ->> 'memberId', '')::uuid, actor,
                                          case when p.bridge_id is null then '{}'::text[]
                                               else array[p.external_id] || p.alt_external_ids end) then
      v_changed := true;
      v_fields := v_fields || jsonb_build_object('assertion', case when jsonb_typeof(p_patch -> 'memberId') = 'null' then 'revoked' else 'asserted' end);
    end if;
  end if;

  if v_changed then
    -- The participant is named masked: activity is readable by every member.
    perform internal.record_activity(b.space_id, p_bridge_id, actor, 'updated', null,
      jsonb_build_object('kind', 'bridge', 'op', 'bridges.participants.update',
                         'participant', internal.bridge_mask(p_external_id)) || v_fields);
  end if;
  return internal.ledger_record(p_client_mutation_id, 'bridges.participants.update',
    jsonb_build_object('bridgeId', p_bridge_id, 'externalId', p_external_id, 'changed', v_changed));
end
$$;
revoke all on function public.update_bridge_participant(uuid, text, jsonb, uuid, text) from public;
grant execute on function public.update_bridge_participant(uuid, text, jsonb, uuid, text) to tm8_app;

reset role;
