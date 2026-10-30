-- =============================================================================
-- 402 — Bridges B3: code and invite links (BRIDGE-ENTITY-DESIGN §2.4, §4.6, D5).
-- (Provisional number: the bridges merger assigns the final one at merge.)
--
-- Task 01a189db-323a-7c7c-a4c2-2e4c35019ba3. Predecessor on main: 396. Builds
-- on 395's bridge_identity_links and bridge_link_codes; touches no object the
-- open B1b migrations (399, 400, 401) touch.
--
-- WHAT THIS FILE DOES
--   §1  bridge_link_attempts (failed /link tries, D59) and bridge_invite_pins
--       (an invite minted for one participant, §2.4 "Invite");
--   §2  the member's own doors: begin_bridge_link (mint TM8-XXXXXX, human
--       only), my_bridge_links (Account → Linked identities) and
--       revoke_bridge_link (the identity itself; an admin for an assertion);
--   §3  internal.bridge_redeem_link_code: the /link verb's body. It answers an
--       outcome instead of raising, so a failed try is recorded (D59). It is
--       internal: the command executor's door (B1b-4) wraps it;
--   §4  pin_bridge_invite (spaces.invites.create's bridgeParticipant) and the
--       two triggers that complete the link when the pinned invite is redeemed
--       (D60).
--
-- Links made here are identity-scoped (space_id null, D5): a code or an
-- invite proves the person, so the link holds in every space they are in.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. Tables.
-- -----------------------------------------------------------------------------

-- D59: a failed /link try, per sender. Five in an hour lock the sender out of
-- /link for the rest of that hour, valid code or not. No app grant.
create table public.bridge_link_attempts (
  provider     text not null check (internal.bridge_provider_known(provider)),
  external_id  text not null,
  attempted_at timestamptz not null default now()
);
create index bridge_link_attempts_sender_idx
  on public.bridge_link_attempts(provider, external_id, attempted_at desc);
alter table public.bridge_link_attempts enable row level security;

-- D60: an invite minted for one participant. Redeeming it links the joiner's
-- identity to the participant's provider id. No app grant: the doors and the
-- trigger read it.
create table public.bridge_invite_pins (
  invite_id     uuid primary key references public.space_invites(id) on delete cascade,
  bridge_id     uuid not null references public.bridges(entity_id) on delete cascade,
  provider      text not null check (internal.bridge_provider_known(provider)),
  external_id   text not null,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  link_id       uuid references public.bridge_identity_links(id) on delete set null
);
create index bridge_invite_pins_participant_idx on public.bridge_invite_pins(bridge_id, external_id);
alter table public.bridge_invite_pins enable row level security;

-- -----------------------------------------------------------------------------
-- §2. The member's own doors.
-- -----------------------------------------------------------------------------

-- D58: six characters from 32 (no 0/O, 1/I), about 10^9 codes; 395's check
-- admits four to eight.
create or replace function internal.bridge_new_link_code() returns text
language plpgsql volatile set search_path = public, internal, pg_temp as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := uuid_send(gen_random_uuid());
  out text := 'TM8-';
begin
  for i in 0..5 loop
    out := out || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return out;
end
$$;
revoke all on function internal.bridge_new_link_code() from public;

-- bridges.links.begin: a code for the caller's own identity, ten minutes, one
-- use. Human only: an agent cannot mint a proof of its owner. A new code ends
-- the caller's earlier unused codes for the provider.
create or replace function public.begin_bridge_link(p_provider text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  v_row public.bridge_link_codes;
  recent integer;
begin
  perform internal.require_human_auth_kind();
  identity := internal.require_identity();
  if p_provider is null or not internal.bridge_provider_known(p_provider) then
    raise exception 'unknown provider %', p_provider using errcode = '22023';
  end if;
  select count(*) into recent from public.bridge_link_codes
   where identity_id = identity and created_at > now() - interval '1 hour';
  if recent >= 10 then
    raise exception 'too many link codes in the last hour; try again later' using errcode = '42501',
      detail = jsonb_build_object('reason', 'rate_limited')::text;
  end if;
  update public.bridge_link_codes set expires_at = least(expires_at, now())
   where identity_id = identity and provider = p_provider and used_at is null and expires_at > now();
  loop
    begin
      insert into public.bridge_link_codes(code, identity_id, provider, expires_at)
      values (internal.bridge_new_link_code(), identity, p_provider, now() + interval '10 minutes')
      returning * into v_row;
      exit;
    exception when unique_violation then
      -- A collision with an old code: draw again.
    end;
  end loop;
  return jsonb_build_object('code', v_row.code, 'provider', v_row.provider,
                            'expiresAt', v_row.expires_at, 'createdAt', v_row.created_at);
end
$$;
revoke all on function public.begin_bridge_link(text) from public;
grant execute on function public.begin_bridge_link(text) to tm8_app;

create or replace function internal.bridge_link_json(l public.bridge_identity_links)
returns jsonb language sql stable set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'id', l.id, 'provider', l.provider, 'externalId', l.external_id,
    'masked', internal.bridge_mask(l.external_id), 'method', l.method,
    'trust', case when l.space_id is null then 'linked' else 'asserted' end,
    'spaceId', l.space_id,
    'spaceName', (select s.name from public.spaces s where s.id = l.space_id),
    'verifiedAt', l.verified_at, 'revokedAt', l.revoked_at)
$$;
revoke all on function internal.bridge_link_json(public.bridge_identity_links) from public;

-- bridges.links.list: the caller's own live links and their live code, if
-- any. Identity-scoped links always; an admin's assertion about the caller
-- only when the session is not pinned to another space (227, as 395's RLS).
create or replace function public.my_bridge_links()
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  pinned uuid := internal.session_space_id();
begin
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(internal.bridge_link_json(l) order by l.verified_at desc, l.id)
        from public.bridge_identity_links l
       where l.identity_id = identity and l.revoked_at is null
         and (l.space_id is null or pinned is null or l.space_id = pinned)), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.code, 'provider', c.provider,
                                          'expiresAt', c.expires_at, 'createdAt', c.created_at)
                       order by c.created_at desc)
        from public.bridge_link_codes c
       where c.identity_id = identity and c.used_at is null and c.expires_at > now()), '[]'::jsonb));
end
$$;
revoke all on function public.my_bridge_links() from public;
grant execute on function public.my_bridge_links() to tm8_app;

-- bridges.links.revoke: the identity a link names may end it, whatever its
-- method; a space admin may end an assertion scoped to their space. Human
-- only. Revoking twice answers the revoked row.
create or replace function public.revoke_bridge_link(p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  l public.bridge_identity_links;
begin
  perform internal.require_human_auth_kind();
  identity := internal.require_identity();
  select * into l from public.bridge_identity_links where id = p_link_id for update;
  if l.id is null
     or not (l.identity_id = identity or (l.space_id is not null and internal.is_space_admin(l.space_id))) then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  if l.revoked_at is null then
    update public.bridge_identity_links set revoked_at = now() where id = l.id returning * into l;
  end if;
  return internal.bridge_link_json(l);
end
$$;
revoke all on function public.revoke_bridge_link(uuid) from public;
grant execute on function public.revoke_bridge_link(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- §3. /link TM8-XXXXXX, as the command executor runs it.
--
-- Only ever reached from an inbound on a connected conversation (D28, D37): a
-- DM to the number never arrives. Answers {ok, reason, …} rather than raising
-- so a failed try is kept (D59). Reasons: rate_limited, bridge_ended,
-- bad_code, expired, used, wrong_provider, linked_elsewhere. A code for the
-- identity this number is already linked to answers ok with already: true.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_redeem_link_code(
  p_bridge_id uuid, p_sender_external_id text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  c public.bridge_link_codes;
  existing public.bridge_identity_links;
  l public.bridge_identity_links;
  v_code text := upper(btrim(coalesce(p_code, '')));
  fail text;
begin
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null or b.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'bridge_ended');
  end if;
  if p_sender_external_id is null or p_sender_external_id = '' then
    raise exception 'a /link needs its sender' using errcode = '22023';
  end if;
  if (select count(*) from public.bridge_link_attempts a
       where a.provider = b.provider and a.external_id = p_sender_external_id
         and a.attempted_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  if v_code !~ '^TM8-[A-Z0-9]{4,8}$' then
    fail := 'bad_code';
  else
    select * into c from public.bridge_link_codes where bridge_link_codes.code = v_code for update;
    if c.code is null then fail := 'bad_code';
    elsif c.used_at is not null then fail := 'used';
    elsif c.expires_at <= now() then fail := 'expired';
    elsif c.provider <> b.provider then fail := 'wrong_provider';
    end if;
  end if;
  if fail is not null then
    insert into public.bridge_link_attempts(provider, external_id) values (b.provider, p_sender_external_id);
    return jsonb_build_object('ok', false, 'reason', fail);
  end if;

  select * into existing from public.bridge_identity_links
   where provider = b.provider and external_id = p_sender_external_id
     and space_id is null and revoked_at is null;
  if existing.id is not null and existing.identity_id <> c.identity_id then
    -- The number is someone else's proof. That holder unlinks first; a code
    -- does not take a number from another account. The code stays unused.
    return jsonb_build_object('ok', false, 'reason', 'linked_elsewhere');
  end if;
  update public.bridge_link_codes set used_at = now() where bridge_link_codes.code = c.code;
  if existing.id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'link', internal.bridge_link_json(existing),
                              'identityId', existing.identity_id);
  end if;
  insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
  values (b.provider, p_sender_external_id, c.identity_id, 'code', now())
  returning * into l;
  return jsonb_build_object('ok', true, 'already', false, 'link', internal.bridge_link_json(l),
                            'identityId', l.identity_id);
end
$$;
revoke all on function internal.bridge_redeem_link_code(uuid, text, text) from public;
grant execute on function internal.bridge_redeem_link_code(uuid, text, text) to tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §4. Invite to space (D60): pin a participant to an invite; redeeming it
--     makes an identity-scoped link with method 'invite'.
-- -----------------------------------------------------------------------------
create or replace function public.pin_bridge_invite(p_invite_id uuid, p_bridge_id uuid, p_external_id text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  inv public.space_invites;
  pin public.bridge_invite_pins;
  actor uuid;
begin
  b := internal.bridge_for_admin(p_bridge_id);
  select * into inv from public.space_invites where id = p_invite_id;
  if inv.id is null or inv.space_id <> b.space_id then
    raise exception 'invite not found in this bridge''s space' using errcode = 'P0002';
  end if;
  if inv.max_uses <> 1 then
    raise exception 'an invite for one participant has maxUses 1' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bridge_participants p
                  where p.bridge_id = p_bridge_id and p.external_id = p_external_id) then
    raise exception 'participant not found on this bridge' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.bridge_identity_links l
              where l.provider = b.provider and l.external_id = p_external_id
                and l.space_id is null and l.revoked_at is null) then
    perform internal.bridge_refuse('already_linked', 'this participant is already linked to a tm8 account');
  end if;
  select entity_id into actor from public.members
   where space_id = b.space_id and identity_id = internal.require_identity() and status = 'active';
  insert into public.bridge_invite_pins(invite_id, bridge_id, provider, external_id, created_by)
  values (p_invite_id, p_bridge_id, b.provider, p_external_id, actor)
  on conflict (invite_id) do nothing;
  select * into pin from public.bridge_invite_pins where invite_id = p_invite_id;
  if pin.bridge_id <> p_bridge_id or pin.external_id <> p_external_id then
    raise exception 'this invite is pinned to another participant' using errcode = '22023';
  end if;
  return jsonb_build_object('inviteId', pin.invite_id, 'bridgeId', pin.bridge_id,
                            'externalId', pin.external_id, 'masked', internal.bridge_mask(pin.external_id));
end
$$;
revoke all on function public.pin_bridge_invite(uuid, uuid, text) from public;
grant execute on function public.pin_bridge_invite(uuid, uuid, text) to tm8_app;

-- Both redeem paths (redeem_invite, signup_via_invite) call
-- internal.attach_member and then spend the invite's use, in one transaction.
-- The member trigger notes who just joined; the invite trigger reads that
-- note when a pinned invite is spent. The note is transaction-local and is
-- cleared once read.
create or replace function internal.bridge_note_joined_member() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  perform set_config('tm8_bridge.joined_identity', new.identity_id, true);
  return null;
end
$$;
revoke all on function internal.bridge_note_joined_member() from public;
create trigger members_bridge_note_joined after insert or update of status on public.members
  for each row when (new.status = 'active') execute function internal.bridge_note_joined_member();

create or replace function internal.bridge_complete_invite_pin() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  pin public.bridge_invite_pins;
  joined text := nullif(current_setting('tm8_bridge.joined_identity', true), '');
  l public.bridge_identity_links;
begin
  select * into pin from public.bridge_invite_pins
   where invite_id = new.id and completed_at is null for update;
  if pin.invite_id is null or joined is null then
    return null;
  end if;
  perform set_config('tm8_bridge.joined_identity', '', true);
  begin
    insert into public.bridge_identity_links(provider, external_id, identity_id, method,
                                             asserted_by_member_id, verified_at)
    values (pin.provider, pin.external_id, joined, 'invite', pin.created_by, now())
    returning * into l;
  exception when unique_violation then
    -- Linked by a code since the invite was made: that proof stands.
    l := null;
  end;
  update public.bridge_invite_pins set completed_at = now(), link_id = l.id where invite_id = pin.invite_id;
  return null;
end
$$;
revoke all on function internal.bridge_complete_invite_pin() from public;
create trigger space_invites_bridge_pin after update of use_count on public.space_invites
  for each row when (new.use_count > old.use_count) execute function internal.bridge_complete_invite_pin();

reset role;

analyze public.bridge_link_attempts, public.bridge_invite_pins;
