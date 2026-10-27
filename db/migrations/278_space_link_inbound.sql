-- =============================================================================
-- 278 — space links, the TARGET side (lane L2 of task 01a0fb5b; owner
-- decisions D2 and D7 in form 01a0fb65).
--
-- D2 (b): the admins of a target space B see every link INTO B, read the audit
-- of the calls made through each one, and may revoke a link. Creating a link
-- still needs no approval from B.
-- D7 (a): owning both spaces is never an authority on its own. Every check here
-- is internal.is_space_admin(B), which holds the session pin (227/232): a
-- session pinned to the home space A answers "not an admin of B" even for an
-- identity that owns both, so B's admin acts from B or not at all. A revoked
-- link refuses a sign-in from every member, B's own owners included; only an
-- explicit restore by a B admin lifts it.
--
--   * space_links.target_revoked_at / target_revoked_by: the link-level
--     revocation, on the shared link row, so it survives a member's remove and
--     re-add (add_space_link reuses the one link per home/target pair, and the
--     link's lifecycle is command-owned: 251 §10b refuses a generic delete).
--   * A trigger on space_link_tokens refuses status -> 'signed_in' while the
--     link is revoked, so login and relogin (251 store_space_link_session) are
--     refused without re-copying their bodies.
--   * list_inbound_space_links (spaceLinks.inbound.list),
--     list_inbound_space_link_audit (spaceLinks.inbound.audit): B-admin reads.
--     The audit reads 260's cross_space_audit, the one audit table (L4 stamps
--     its spawn provenance there too), SCOPED TO B: a row is shown only when
--     its target is B and its link targets B on this server. Home-side ids
--     (work session, persona) are not returned; the caller is named by their
--     own member row in B.
--   * revoke_inbound_space_link / restore_inbound_space_link
--     (spaceLinks.inbound.revoke|restore): human-only (the strict gate), B
--     admin. Revoke signs every member's row out: each stored session is
--     revoked and its sealed bytes forgotten, and the link raises attention in
--     the home space.
--   * internal.space_link_json gains targetRevokedAt, so the home side sees why
--     its sign-in is refused. Body otherwise 251's, verbatim.
--
-- Links to a space on ANOTHER server (target_server_id set, W8) are not
-- inbound here: their rows live on the home server. Out of scope.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The link-level revocation and the audit's target index.
-- -----------------------------------------------------------------------------
alter table public.space_links
  add column if not exists target_revoked_at timestamptz,
  add column if not exists target_revoked_by uuid references public.members(entity_id) on delete set null;

comment on column public.space_links.target_revoked_at is
  '277 (D2): set when an admin of the TARGET space revoked this link; a sign-in is refused until a target admin restores it.';

create index if not exists cross_space_audit_target_idx
  on public.cross_space_audit(target_space_id, created_at desc, id desc)
  where target_space_id is not null;

-- -----------------------------------------------------------------------------
-- 2. No sign-in on a revoked link. A trigger, so 251's login/relogin bodies are
--    not re-copied: their one update to 'signed_in' is refused and the whole
--    call (the minted session included) rolls back.
-- -----------------------------------------------------------------------------
create or replace function internal.space_link_refuse_revoked_sign_in()
returns trigger language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if exists (select 1 from public.space_links l
              where l.entity_id = new.link_id and l.target_revoked_at is not null) then
    raise exception 'this space link was revoked by an admin of the target space' using errcode = '42501',
      detail = jsonb_build_object('reason', 'space_link_target_revoked')::text;
  end if;
  return new;
end
$$;

drop trigger if exists space_link_tokens_refuse_revoked_sign_in on public.space_link_tokens;
create trigger space_link_tokens_refuse_revoked_sign_in
before insert or update of status on public.space_link_tokens
for each row
when (new.status = 'signed_in')
execute function internal.space_link_refuse_revoked_sign_in();

-- -----------------------------------------------------------------------------
-- 3. The home view carries the revocation. 251's body plus `targetRevokedAt`.
-- -----------------------------------------------------------------------------
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
                           and internal.is_space_member(s.id)),
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

-- -----------------------------------------------------------------------------
-- 4. Helpers: the B-admin check, and one inbound link as B's admins see it.
-- -----------------------------------------------------------------------------

-- The caller's admin member in B, or 42501. is_space_admin holds the session
-- pin, so this is where D7 is enforced: a session pinned to A is refused here
-- whatever the identity's role in B.
create or replace function internal.require_inbound_link_admin(p_space_id uuid)
returns uuid language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  if p_space_id is null or not internal.is_space_admin(p_space_id) then
    raise exception 'only an admin of this space can see or change the links into it' using errcode = '42501',
      detail = jsonb_build_object('reason', 'space_link_inbound_admin_only')::text;
  end if;
  return internal.current_member_id(p_space_id);
end
$$;

-- A home member's own member row in B (the same identity), or null.
create or replace function internal.space_link_target_member(p_home_member_id uuid, p_target_space_id uuid)
returns public.members language sql stable security definer set search_path = public, internal, pg_temp as $$
  select mb.* from public.members ma
    join public.members mb on mb.identity_id = ma.identity_id and mb.space_id = p_target_space_id
   where ma.entity_id = p_home_member_id
   limit 1
$$;

-- One inbound link. The home space's name is shown to B's admins: they cannot
-- judge a link they cannot name. Each holder is named by their member row in
-- B, never by a home-side id.
create or replace function internal.space_link_inbound_json(p_link_id uuid)
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', l.entity_id,
    'homeSpaceId', l.home_space_id,
    'homeSpaceName', (select s.name from public.spaces s where s.id = l.home_space_id),
    'targetSpaceId', l.target_space_id,
    'createdAt', l.created_at,
    'revokedAt', l.target_revoked_at,
    'revokedByMemberId', l.target_revoked_by,
    'lastCallAt', (select max(a.created_at) from public.cross_space_audit a
                    where a.link_id = l.entity_id and a.target_space_id = l.target_space_id),
    'holders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'targetMemberId', (internal.space_link_target_member(t.member_id, l.target_space_id)).entity_id,
               'displayName', (internal.space_link_target_member(t.member_id, l.target_space_id)).display_name,
               'status', t.status,
               'allowSpawn', t.allow_spawn,
               'spawnBudget', t.spawn_budget,
               'expiresAt', t.expires_at,
               'lastUsedAt', t.last_used_at) order by t.created_at, t.id)
        from public.space_link_tokens t
       where t.link_id = l.entity_id), '[]'::jsonb))
    from public.space_links l
   where l.entity_id = p_link_id
$$;

-- An inbound link of B, locked for a write; P0002 for anything else (a link
-- into another space, a remote link, a missing one), so a B admin cannot probe
-- other spaces' links by id.
create or replace function internal.inbound_space_link_row(p_space_id uuid, p_link_id uuid)
returns public.space_links language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  link public.space_links;
begin
  select l.* into link from public.space_links l
    join public.entities e on e.id = l.entity_id
   where l.entity_id = p_link_id and l.target_space_id = p_space_id
     and l.target_server_id is null and e.deleted_at is null
   for update of l;
  if link.entity_id is null then
    raise exception 'space link not found' using errcode = 'P0002';
  end if;
  return link;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. spaceLinks.inbound.list — every link into B on this server. B admin.
-- -----------------------------------------------------------------------------
create or replace function public.list_inbound_space_links(p_space_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_inbound_link_admin(p_space_id);
  return coalesce((
    select jsonb_agg(internal.space_link_inbound_json(l.entity_id) order by l.created_at, l.entity_id)
      from public.space_links l
      join public.entities e on e.id = l.entity_id
     where l.target_space_id = p_space_id
       and l.target_server_id is null
       and e.deleted_at is null
  ), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. spaceLinks.inbound.audit — calls made INTO B, newest first. B admin.
--    Scoped to B twice: the row's target is B, and its link targets B here.
-- -----------------------------------------------------------------------------
create or replace function public.list_inbound_space_link_audit(
  p_space_id uuid,
  p_link_id uuid default null,
  p_limit integer default 50,
  p_before timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
begin
  perform internal.require_inbound_link_admin(p_space_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'linkId', a.link_id,
      'homeSpaceId', a.home_space_id,
      'targetSpaceId', a.target_space_id,
      'targetMemberId', (internal.space_link_target_member(a.member_id, p_space_id)).entity_id,
      'displayName', (internal.space_link_target_member(a.member_id, p_space_id)).display_name,
      'op', a.op,
      'viaChain', to_jsonb(a.via_chain),
      'result', a.result,
      'reason', a.reason,
      'remoteId', a.remote_id,
      'createdAt', a.created_at) order by a.created_at desc, a.id desc)
    from (
      select a.* from public.cross_space_audit a
        join public.space_links l on l.entity_id = a.link_id
       where a.target_space_id = p_space_id
         and l.target_space_id = p_space_id
         and l.target_server_id is null
         and (p_link_id is null or a.link_id = p_link_id)
         and (p_before is null or a.created_at < p_before)
       order by a.created_at desc, a.id desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) a), '[]'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 7. spaceLinks.inbound.revoke — B admin, human session. Every member's row on
--    the link is signed out (session revoked, sealed bytes forgotten) and no
--    sign-in succeeds until a B admin restores the link.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_inbound_space_link(
  p_space_id uuid,
  p_link_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  me uuid;
  link public.space_links;
  row public.space_link_tokens;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.inbound.revoke');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  me := internal.require_inbound_link_admin(p_space_id);
  perform internal.bind_actor(me);
  link := internal.inbound_space_link_row(p_space_id, p_link_id);

  if link.target_revoked_at is null then
    update public.space_links
       set target_revoked_at = now(), target_revoked_by = me, updated_at = now()
     where entity_id = link.entity_id;
  end if;

  for row in select * from public.space_link_tokens t where t.link_id = link.entity_id for update loop
    if row.auth_session_id is not null then
      update public.auth_sessions set revoked_at = now()
       where id = row.auth_session_id and revoked_at is null;
    end if;
    update public.space_link_tokens
       set ciphertext = null, nonce = null, auth_session_id = null,
           status = case when status = 'left' then 'left' else 'signed_out' end
     where id = row.id;
    perform internal.space_link_raise_attention(row,
      'An admin of the linked space revoked this link. Signing in is refused until they restore it.');
  end loop;

  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.inbound.revoke',
           internal.space_link_inbound_json(link.entity_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 8. spaceLinks.inbound.restore — B admin, human session. Lifts the
--    revocation; every member signs in again for themselves.
-- -----------------------------------------------------------------------------
create or replace function public.restore_inbound_space_link(
  p_space_id uuid,
  p_link_id uuid,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  me uuid;
  link public.space_links;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'spaceLinks.inbound.restore');
  if replay is not null then
    perform internal.require_replay_subject(replay ->> 'id', p_link_id::text, 'entity');
    return replay;
  end if;
  perform internal.require_human_auth_kind();
  me := internal.require_inbound_link_admin(p_space_id);
  perform internal.bind_actor(me);
  link := internal.inbound_space_link_row(p_space_id, p_link_id);
  update public.space_links
     set target_revoked_at = null, target_revoked_by = null, updated_at = now()
   where entity_id = link.entity_id;
  return internal.ledger_record(p_client_mutation_id, 'spaceLinks.inbound.restore',
           internal.space_link_inbound_json(link.entity_id));
end
$$;

-- -----------------------------------------------------------------------------
-- 9. Grants — full signatures.
-- -----------------------------------------------------------------------------
revoke all on function internal.space_link_refuse_revoked_sign_in() from public;
revoke all on function internal.require_inbound_link_admin(uuid) from public;
revoke all on function internal.space_link_target_member(uuid, uuid) from public;
revoke all on function internal.space_link_inbound_json(uuid) from public;
revoke all on function internal.inbound_space_link_row(uuid, uuid) from public;

revoke all on function public.list_inbound_space_links(uuid) from public;
grant execute on function public.list_inbound_space_links(uuid) to tm8_app;
revoke all on function public.list_inbound_space_link_audit(uuid, uuid, integer, timestamptz) from public;
grant execute on function public.list_inbound_space_link_audit(uuid, uuid, integer, timestamptz) to tm8_app;
revoke all on function public.revoke_inbound_space_link(uuid, uuid, text) from public;
grant execute on function public.revoke_inbound_space_link(uuid, uuid, text) to tm8_app;
revoke all on function public.restore_inbound_space_link(uuid, uuid, text) from public;
grant execute on function public.restore_inbound_space_link(uuid, uuid, text) to tm8_app;

reset role;
