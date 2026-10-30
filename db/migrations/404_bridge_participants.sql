-- =============================================================================
-- 404 — Bridges P: the People tab's read and write (bridges.participants.list,
--       bridges.participants.update).
-- (Provisional number; the bridges merger assigns the final one.)
--
-- Design of record: docs/features/bridges/BRIDGE-ENTITY-DESIGN.md §2.4, §3.2,
-- §3.4, §4.4 (People); D50-D51 (§8). Task 01a189db-34a6-7873-975e-9da024aa70ac.
--
-- Predecessor: 395_bridge_schema.sql. Adds two functions; no table, no policy.
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
-- THE WRITE (D52). public.update_bridge_participant: mute, and the admin's
-- assertion (*This is <member>*) or its revocation. Human-only and admin-only,
-- like 395's other identity-shaped doors: an assertion makes a number count as
-- a person, so no agent makes one. The assertion is space-scoped (§2.4) and is
-- refused `already_linked` while the participant resolves through the
-- person's own verified link, which an admin cannot override or revoke. The
-- activity row names the participant masked, never by its raw id.
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

create or replace function public.update_bridge_participant(
  p_bridge_id uuid, p_external_id text, p_patch jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb; actor uuid; b public.bridges; p public.bridge_participants; k text;
  v_identity text; v_member uuid; v_ids text[]; v_fields jsonb := '{}'::jsonb;
begin
  perform internal.require_human_auth_kind();
  b := internal.bridge_for_admin(p_bridge_id);
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'bridges.participants.update');
  if replay is not null then
    perform internal.require_replay_subject(replay #>> '{entity,id}', p_bridge_id::text, 'entity');
    return replay;
  end if;
  actor := internal.resolve_actor(p_actor_id, b.space_id);
  perform internal.bind_actor(actor);

  select * into p from public.bridge_participants where bridge_id = p_bridge_id and external_id = p_external_id;
  if p.bridge_id is null then
    raise exception 'participant not found on this bridge' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb then
    raise exception 'patch must be a non-empty object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not k = any(array['muted', 'memberId']) then
      raise exception 'unknown participant field %', k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'muted' then
    if jsonb_typeof(p_patch -> 'muted') <> 'boolean' then
      raise exception 'muted must be a boolean' using errcode = '22023';
    end if;
    update public.bridge_participants set muted = (p_patch ->> 'muted')::boolean
     where bridge_id = p_bridge_id and external_id = p_external_id;
    v_fields := v_fields || jsonb_build_object('muted', (p_patch ->> 'muted')::boolean);
  end if;

  if p_patch ? 'memberId' then
    v_ids := array[p.external_id] || p.alt_external_ids;
    -- The person's own verified link wins on inbound (the resolver's order),
    -- so an assertion under it would say nothing; it is theirs to revoke.
    if exists (select 1 from public.bridge_identity_links l
                where l.provider = b.provider and l.external_id = any(v_ids)
                  and l.revoked_at is null and l.space_id is null) then
      perform internal.bridge_refuse('already_linked',
        'this participant has linked their own number; only they can unlink it');
    end if;
    update public.bridge_identity_links l set revoked_at = now()
     where l.provider = b.provider and l.external_id = any(v_ids)
       and l.revoked_at is null and l.space_id = b.space_id;
    if jsonb_typeof(p_patch -> 'memberId') = 'null' then
      v_fields := v_fields || jsonb_build_object('assertion', 'revoked');
    else
      v_member := (p_patch ->> 'memberId')::uuid;
      select mem.identity_id into v_identity
        from public.members mem join public.entities e on e.id = mem.entity_id
       where mem.entity_id = v_member and mem.space_id = b.space_id
         and mem.status = 'active' and e.deleted_at is null;
      if v_identity is null then
        raise exception 'memberId must be an active member of this space' using errcode = '22023';
      end if;
      insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id,
                                               asserted_by_member_id, verified_at)
      values (b.provider, p.external_id, v_identity, 'admin', b.space_id, actor, now());
      v_fields := v_fields || jsonb_build_object('assertion', 'asserted', 'memberId', v_member);
    end if;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'bridges.participants.update',
    internal.command_result(p_bridge_id, null,
      internal.record_activity(b.space_id, p_bridge_id, actor, 'updated', null,
        jsonb_build_object('kind', 'bridge', 'participant', internal.bridge_mask(p.external_id)) || v_fields),
      array[p_bridge_id]));
end
$$;
revoke all on function public.update_bridge_participant(uuid, text, jsonb, uuid, text) from public;
grant execute on function public.update_bridge_participant(uuid, text, jsonb, uuid, text) to tm8_app;

reset role;
