-- =============================================================================
-- 994 (PLACEHOLDER; the real ordinal is assigned at merge position by the
-- credentials coordinator, which holds the sequence for every migration in
-- flight) — action facts for credential, space_link and server (task 01a0e24d,
-- proposal doc 01a0e257 v2).
--
-- `actions.list` derives what it advertises from row state (the forms columns
-- are the precedent). For these three kinds the deciding predicates live in
-- security-definer functions tm8_app cannot call (`can_manage_space_credential`
-- and `can_revoke_space_credential` are revoked from public, 255), and the
-- rows they take have columns tm8_app cannot read (`key_hint`,
-- `display_login`, 239). So discovery cannot evaluate them itself. This
-- function evaluates the SAME predicates the doors use, on the stored row, and
-- returns booleans and statuses only: no secret, no hint, no login, no path.
--
-- A non-member (and a caller who cannot see the entity) gets an all-null row,
-- so discovery advertises nothing, which is what the doors would answer.
-- =============================================================================

create or replace function internal.entity_action_facts(p_entity_id uuid)
returns table (
  cred_can_manage   boolean,
  cred_can_revoke   boolean,
  cred_is_owner     boolean,
  cred_can_claim    boolean,
  cred_can_usage    boolean,
  cred_status       text,
  cred_shape        text,
  link_mine_status  text,
  link_is_member    boolean,
  link_ever_signed_in boolean,
  server_can_remove boolean
)
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  sc public.space_credentials;
  lnk public.space_links;
  tok public.space_link_tokens;
  srv public.servers;
  me uuid;
begin
  select * into sc from public.space_credentials where id = p_entity_id;
  if sc.id is not null and internal.is_space_member(sc.space_id) then
    -- 255's own predicates, not a copy of them.
    cred_can_manage := internal.can_manage_space_credential(sc);
    cred_can_revoke := internal.can_revoke_space_credential(sc);
    cred_is_owner := sc.owner_account_id is not null
      and sc.owner_account_id = internal.current_account_id();
    -- claim_space_credential (255): ownerless, not chosen space-owned, the
    -- caller created it, not revoked.
    cred_can_claim := sc.owner_account_id is null and not sc.space_owned_chosen
      and sc.created_by_account_id is not null
      and sc.created_by_account_id = internal.current_account_id()
      and sc.status <> 'revoked';
    -- space_credential_usage (255), by its stated intent: the owner, or an
    -- admin when the row is public or ownerless. The coalesce is deliberate.
    -- 255 writes `if not (owner = me or …)`, and on an ownerless row that is
    -- `not NULL`, so the door admits every member. That is a door defect
    -- (reported, task 01a0e24d; fixed by the same coalesce in placeholder 993, its own PR, which
    -- lands first), and discovery does not advertise through it. Until that
    -- fix lands, discovery is DELIBERATELY STRICTER than the door: a
    -- non-admin member is not offered a read the leaky door would grant.
    -- That is the safe direction. Do not "align" this fact down to the door;
    -- that reopens the hole while making the two agree.
    cred_can_usage := coalesce(sc.owner_account_id = internal.current_account_id(), false)
      or ((sc.visibility = 'public' or sc.owner_account_id is null)
          and internal.is_space_admin(sc.space_id));
    cred_status := sc.status;
    cred_shape := sc.shape;
    return next;
    return;
  end if;

  select * into lnk from public.space_links where entity_id = p_entity_id;
  if lnk.entity_id is not null then
    me := internal.current_member_id(lnk.home_space_id);
    if me is not null then
      link_is_member := true;
      select t.* into tok
        from public.space_link_tokens t
       where t.link_id = lnk.entity_id and t.member_id = me;
      link_mine_status := tok.status;
      -- store_space_link_session (256) refuses a relogin of a row that was
      -- never signed in; the same four columns decide it here.
      link_ever_signed_in := tok.id is not null
        and not (tok.auth_session_id is null and tok.status = 'signed_out'
                 and tok.last_used_at is null and tok.expires_at is null);
    end if;
    return next;
    return;
  end if;

  select s.* into srv from public.servers s where s.entity_id = p_entity_id;
  if srv.entity_id is not null then
    me := internal.current_member_id(srv.home_space_id);
    if me is not null then
      -- remove_server (261): the creator or a space admin.
      server_can_remove := exists (select 1 from public.entities e
                                    where e.id = srv.entity_id and e.created_by = me)
        or internal.is_space_admin(srv.home_space_id);
    end if;
    return next;
    return;
  end if;

  return next;
end
$$;

revoke all on function internal.entity_action_facts(uuid) from public;
grant execute on function internal.entity_action_facts(uuid) to tm8_app;

comment on function internal.entity_action_facts(uuid) is
  'Row-state facts actions.list needs for credential, space_link and server '
  'verbs, evaluated with the doors'' own predicates. Booleans and statuses '
  'only; never a secret, key hint, login or path.';
