-- =============================================================================
-- 410 — Bridges B3 follow-up: mangled /link codes are matched or burned; an
-- admin who revokes a pinned invite ends the link it made. (Provisional
-- number, above B3's 408 and R's 409; the bridges merger assigns the final
-- one at merge.)
--
-- Task 01a18c06-804e-7368-bdf0-a0af30fd27eb, from the #1432 review.
-- internal.bridge_redeem_link_code starts from 408's body, the latest.
--
--   §1  A code is read as the group wrote it. Autocorrect turns '-' into an
--       en-dash, a phone inserts a space, a reader drops the hyphen: every
--       space, dash-like character, '_', '.' and ':' is removed and the code
--       re-read as TM8-XXXXXX (internal.bridge_link_code_normalize).
--   §2  A try that matches no code but is within two edits (Levenshtein: a
--       wrong, extra or missing character, two at most) of a live code of the
--       provider burns that code (D59): everyone in the group has read it, and
--       a near miss shows it. Codes are stored as salted digests (D58), so the
--       near codes are found by digesting every valid code within two edits of
--       what was typed (at most about 40,000 strings for six characters, before duplicates go) against the salt of
--       each live code: live codes last ten minutes, so they are few.
--   §3  revoke_invite on a pinned invite (D60) also revokes the 'invite' link
--       redeeming it made, if that link is still live: the admin who pinned
--       the number can take back a link the invite gave the wrong person.
-- =============================================================================

set local lock_timeout = '5s';

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- §1. The code as typed, normalized.
-- -----------------------------------------------------------------------------
-- 'TM8-' followed by what was typed after TM8, with every separator removed;
-- '' when nothing code-like was sent. A body without the TM8 prefix is read as
-- the body.
create or replace function internal.bridge_link_code_normalize(p_code text) returns text
language sql immutable set search_path = public, internal, pg_temp as $$
  select case when v = '' then '' else 'TM8-' || regexp_replace(v, '^TM8', '') end
    from (select regexp_replace(upper(coalesce(p_code, '')),
                   '[[:space:]\u00AD\u2010-\u2015\u2212\uFE58\uFE63\uFF0D_.:-]+', '', 'g') as v) t
$$;
revoke all on function internal.bridge_link_code_normalize(text) from public;

-- -----------------------------------------------------------------------------
-- §2. Near misses.
-- -----------------------------------------------------------------------------
-- Every string one edit from p_s whose length is in p_lens: a character
-- replaced or deleted, or one inserted anywhere, over the code alphabet
-- (408's: no 0/O, 1/I).
create or replace function internal.bridge_link_code_edits(p_s text, p_lens int[]) returns setof text
language sql immutable set search_path = public, internal, pg_temp as $$
  with a(ch) as (select unnest(string_to_array('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', null)))
  select overlay(p_s placing a.ch from i for 1) from generate_series(1, length(p_s)) i, a
   where length(p_s) = any(p_lens)
  union
  select overlay(p_s placing a.ch from i for 0) from generate_series(1, length(p_s) + 1) i, a
   where length(p_s) + 1 = any(p_lens)
  union
  select overlay(p_s placing '' from i for 1) from generate_series(1, length(p_s)) i
   where length(p_s) - 1 = any(p_lens)
$$;
revoke all on function internal.bridge_link_code_edits(text, int[]) from public;

-- The live codes of p_provider within two edits of the typed body. Bodies of
-- 4 to 8 characters only: nothing shorter or longer is two edits from six.
create or replace function internal.bridge_link_code_near(p_provider text, p_body text)
returns setof public.bridge_link_codes language sql stable set search_path = public, internal, pg_temp as $$
  with live as (
    select * from public.bridge_link_codes
     where provider = p_provider and used_at is null and expires_at > now()
  ), one as (
    select internal.bridge_link_code_edits(p_body, array[5, 6, 7]) as s
     where length(p_body) between 4 and 8 and exists (select 1 from live)
  ), cand as (
    select s from one where length(s) = 6
    union select internal.bridge_link_code_edits(s, array[6]) from one
    union select p_body where length(p_body) = 6 and exists (select 1 from live)
  )
  select distinct l.* from live l
    join cand on cand.s ~ '^[A-HJ-NP-Z2-9]{6}$'
             and l.digest = internal.bridge_link_code_digest(l.salt, 'TM8-' || cand.s)
$$;
revoke all on function internal.bridge_link_code_near(text, text) from public;

-- -----------------------------------------------------------------------------
-- The /link body (408's), reading the normalized code and burning near misses.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_redeem_link_code(
  p_bridge_id uuid, p_sender_external_id text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  b public.bridges;
  c public.bridge_link_codes;
  existing public.bridge_identity_links;
  l public.bridge_identity_links;
  v_code text := internal.bridge_link_code_normalize(p_code);
  fail text;
  near int := 0;
begin
  select * into b from public.bridges where entity_id = p_bridge_id;
  if b.entity_id is null or b.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'bridge_ended');
  end if;
  if p_sender_external_id is null or p_sender_external_id = '' then
    raise exception 'a /link needs its sender' using errcode = '22023';
  end if;

  if v_code ~ '^TM8-[A-HJ-NP-Z2-9]{6}$' then
    select m.* into c from internal.bridge_link_code_match(v_code) m
     order by (m.used_at is null and m.expires_at > now()) desc, m.created_at desc limit 1;
    if c.id is not null then
      perform 1 from public.bridge_link_codes where id = c.id for update;
      select * into c from public.bridge_link_codes where id = c.id;
    end if;
  end if;

  if (select count(*) from public.bridge_link_attempts a
       where a.provider = b.provider and a.external_id = p_sender_external_id
         and a.attempted_at > now() - interval '1 hour') >= 5 then
    fail := 'rate_limited';
  elsif c.id is null then fail := 'bad_code';
  elsif c.used_at is not null then fail := 'used';
  elsif c.expires_at <= now() then fail := 'expired';
  elsif c.provider <> b.provider then fail := 'wrong_provider';
  end if;

  if fail is null then
    select * into existing from public.bridge_identity_links
     where provider = b.provider and external_id = p_sender_external_id
       and space_id is null and revoked_at is null;
    if existing.id is not null and existing.identity_id <> c.identity_id then
      -- The number is someone else's proof. That holder unlinks first; a code
      -- does not take a number from another account.
      fail := 'linked_elsewhere';
    end if;
  end if;

  if fail is not null then
    if fail in ('bad_code', 'used', 'expired', 'wrong_provider', 'rate_limited') then
      insert into public.bridge_link_attempts(provider, external_id) values (b.provider, p_sender_external_id);
    end if;
    if c.id is not null and c.used_at is null and c.expires_at > now() then
      update public.bridge_link_codes set used_at = now() where id = c.id;
      return jsonb_build_object('ok', false, 'reason', fail, 'burned', true);
    end if;
    -- A near miss (a typo, an autocorrected character, a dropped one) names a
    -- live code just as well: the group has read it. Burn every live code of
    -- this provider within two edits of what was typed.
    if c.id is null and v_code like 'TM8-%' then
      update public.bridge_link_codes k set used_at = now()
       where k.id in (select n.id from internal.bridge_link_code_near(b.provider, substr(v_code, 5)) n);
      get diagnostics near = row_count;
      if near > 0 then
        return jsonb_build_object('ok', false, 'reason', fail, 'burned', true);
      end if;
    end if;
    return jsonb_build_object('ok', false, 'reason', fail);
  end if;

  update public.bridge_link_codes set used_at = now() where id = c.id;
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
-- §3. Revoking a pinned invite ends the link it made.
-- -----------------------------------------------------------------------------
create or replace function internal.bridge_revoke_invite_pin_link() returns trigger
language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  update public.bridge_identity_links l set revoked_at = now()
    from public.bridge_invite_pins p
   where p.invite_id = new.id and p.link_id = l.id
     and l.method = 'invite' and l.revoked_at is null;
  return null;
end
$$;
revoke all on function internal.bridge_revoke_invite_pin_link() from public;
create trigger space_invites_bridge_pin_revoke after update of revoked_at on public.space_invites
  for each row when (new.revoked_at is not null and old.revoked_at is null)
  execute function internal.bridge_revoke_invite_pin_link();

reset role;
