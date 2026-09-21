-- =============================================================================
-- 195 — `preview_invite` learns who is asking, so a member is never told their
--        own space is out of reach (task 01a0baf5, "Invite Link is not working").
--
-- WHAT WAS REPORTED. Zaheer minted a one-use member invite for the Space
-- `Syed` (`inv_…8d6f`, max_uses 1) and sent it to Tharak. Tharak opened it and
-- the browser answered **"This invite is used up"**. The Space was real, the
-- link was real, and the invite had not been revoked or expired.
--
-- WHAT HAD ACTUALLY HAPPENED, read off the production row rather than guessed:
-- the invite was created 18:21:07 and Tharak's member row exists with
-- `joined_at` 18:22:56. THE JOIN HAD ALREADY SUCCEEDED. He had used his own
-- link, landed on a screen that never left (the browser half of this fix), and
-- opened the link a second time to find out what went wrong. The second open
-- is what produced the card in the screenshot.
--
-- WHY THE CARD WAS WRONG, and it is a disagreement between two functions over
-- one invite. `redeem_invite` (118) is CLAIM-AWARE and short-circuits on
-- membership: it looks the caller up in `public.members` BEFORE it checks
-- exhaustion, so an existing member redeeming a spent code gets
-- `{"joined": false}` and their space id — verified live against the same code
-- that rendered "used up". `preview_invite` is CLAIM-FREE and had no such
-- branch, so it answered purely on `use_count >= max_uses`. The screen asks
-- the preview first and believed it. Two operations, one invite, opposite
-- answers, and the one the person saw was the one that could not see them.
--
-- THE FIX: a `member` status, ahead of every dead status.
--
-- Membership does not evaporate when the link that conferred it dies, so the
-- branch is placed BEFORE revoked/expired/exhausted rather than beside them. A
-- member holding a revoked code is still a member; telling them the Space
-- "doesn't open any more" is false in exactly the way the report describes.
--
-- WHY THIS DISCLOSES NOTHING NEW. The branch fires only when the caller's own
-- identity already has a row in `public.members` for that Space — someone who
-- can list the Space, its id and its name from a dozen other reads. It hands a
-- member two facts about a Space they are IN. 118's disclosure rule is about
-- what a code is worth to a STRANGER, and for a stranger every answer here is
-- byte-for-byte what it was: `unknown` still carries nothing, and a dead code
-- still names the Space and never the inviter.
--
-- STILL CLAIM-FREE. `internal.identity_id()` reads a `SET LOCAL` claim through
-- `internal.claim_text`, which returns NULL rather than raising when the claim
-- is unset (001:147-157). An anonymous caller — the common case, since a join
-- link is usually opened signed out — takes `viewer is null` and falls
-- straight through to the logic 118 shipped. Nothing about this function
-- REQUIRES an identity; it merely uses one when the request carried one.
-- `auth.invite.resolve` is amended in the same change to bind the caller's
-- identity when their request has a session, and to keep passing none when it
-- does not.
--
-- NUMBERED 195, MEASURED 2026-09-19 against ALL remote refs (`git ls-tree` of
-- `db/migrations` over every `refs/remotes/*`). The union's max is 194, which
-- is also main's head here — but the union is the measure, never previous+1
-- (135's numbering note, restated by 194).
--
-- `create or replace` PRESERVES GRANTS — the function is amended, never
-- dropped, so 118:439's `grant execute … to tm8_app` survives. 008:251-253
-- left default privileges untouched, so a DROP here would silently make the
-- operation unreachable; the grant is re-stated at the foot all the same,
-- because a grant that is already held costs nothing and a missing one costs
-- the whole join journey.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.preview_invite(p_code text)
returns jsonb language plpgsql stable security definer
set search_path = public, internal, pg_temp as $$
declare
  invite public.space_invites;
  space public.spaces;
  viewer text;
  inviter text;
  status text;
begin
  select * into invite from public.space_invites where code = p_code;
  if invite.id is null then
    return jsonb_build_object('status', 'unknown');
  end if;

  select * into space from public.spaces where id = invite.space_id;
  if space.id is null then
    -- The Space was deleted out from under a live code. Same answer as an
    -- unknown code: there is nothing to join and nothing to name.
    return jsonb_build_object('status', 'unknown');
  end if;

  -- ALREADY IN — checked before the code's own health, because a membership
  -- outlives the link that granted it. This is the branch the report needed:
  -- the holder of a spent link may be the person who spent it.
  --
  -- NULL for an anonymous caller, which is most of them. `redeem_invite`
  -- resolves membership by (space_id, identity_id) against this same table;
  -- this asks the identical question so the two operations cannot answer
  -- differently about the same person again.
  viewer := internal.identity_id();
  if viewer is not null and exists (
       select 1 from public.members
        where space_id = invite.space_id
          and identity_id = viewer) then
    return jsonb_build_object(
      'status',    'member',
      'spaceId',   space.id,
      'spaceName', space.name
    );
  end if;

  status := case
    when invite.revoked_at is not null then 'revoked'
    when invite.expires_at is not null and invite.expires_at < now() then 'expired'
    when invite.use_count >= invite.max_uses then 'exhausted'
    else 'valid'
  end;

  if status <> 'valid' then
    return jsonb_build_object('status', status, 'spaceName', space.name);
  end if;

  select coalesce(nullif(btrim(m.display_name), ''), nullif(btrim(p.display_name), ''))
    into inviter
    from public.members m
    left join public.user_profiles p on p.identity_id = m.identity_id
   where m.entity_id = invite.created_by;

  return jsonb_build_object(
    'status',    'valid',
    'spaceId',   space.id,
    'spaceName', space.name,
    'role',      invite.role,
    'invitedBy', inviter,
    'expiresAt', invite.expires_at
  );
end
$$;

comment on function public.preview_invite(text) is
  'What a join code lets you join, answered before the holder is anybody here '
  '(118, amended 195). Claim-free — an anonymous caller gets 118''s answer '
  'unchanged. When the request DOES carry an identity that already belongs to '
  'the invite''s Space, it answers ''member'' with that Space''s id and name '
  'ahead of revoked/expired/exhausted, so the person who already used their own '
  'link is never told the Space is out of reach.';

reset role;

-- 118:439 granted this and `create or replace` keeps it. Re-stated because
-- 008:251-253 means an ungranted function here is silently unreachable.
grant execute on function public.preview_invite(text) to tm8_app;
