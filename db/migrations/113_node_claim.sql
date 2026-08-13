-- =============================================================================
-- 113 — the first-run node claim: how account #1 gets a credential on a node
-- the operator cannot reach over loopback.
--
-- READ `docs/identity/FIRST-RUN-CLAIM-DESIGN.md` FIRST. This file implements
-- decisions D1 and D2 of that design; the rationale is not repeated here.
--
-- THE DEFECT THIS CLOSES.
--
-- `resolveLoopbackOwner` (server, identity/loopback.ts) mints the owner account
-- with `password_hash = null` — deliberate, because a loopback-only node may
-- have no password. But that bootstrap CONSUMES the one unauthenticated signup
-- window: 007's `ensure_account` is claim-free only `while (select 1 from
-- public.accounts)` is empty, and from the second request onward it demands a
-- node admin. The only node admin without a password is the loopback auto-owner
-- arm, which correctly refuses any caller that is not on the box. So a node
-- reached over Tailscale or through a reverse proxy shows a sign-in card for an
-- account that does not exist and cannot be created. That is the whole bug.
--
-- WHAT "UNCLAIMED" MEANS, AND WHY IT IS NOT "NO ACCOUNTS".
--
-- A node is CLAIMED once ANY account on it has a `password_hash`. Not "an owner
-- row exists" — the bootstrap always makes one, so that test is never true.
-- Not "more than one account exists" — that would re-open the window on a node
-- whose second account was deleted. The chosen definition means nodes already
-- provisioned through `docs/identity/PROVISION-SECOND-ACCOUNT.md` read as
-- CLAIMED and never mint a token: this migration is a no-op for them.
--
-- Unclaimed is a strictly bounded state. An unclaimed node is one nobody has
-- ever logged into, so it holds nothing but the auto-owner's own work — which
-- is what bounds the authority of a leaked claim token (design §3.1).
--
-- WHY `claim_node` SETS A CREDENTIAL RATHER THAN CREATING AN ACCOUNT (D2).
--
-- The alternative — leave the passwordless `owner` row and sign the human up
-- beside it — permanently orphans every row created before the claim under a
-- ghost identity nobody can log in as, and leaves the human NOT the node owner.
-- Claiming in place keeps `identity_id` byte-identical, so every `created_by`,
-- every `spaces.created_by_identity` FK and every attribution in the graph
-- stays correct and becomes the claimant's. `ensure_account`'s F1 guard is
-- untouched: this function never inserts into `public.accounts`.
--
-- WHY THE TOKEN IS STORED AS A HASH.
--
-- Same discipline as `auth_sessions.token_hash` (002): the plaintext exists in
-- the boot log and in `<dataDir>/setup-token` (0600) and nowhere else. A
-- database dump of an unclaimed node must not be a way to claim it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The token store.
--
-- RLS enabled with ZERO POLICIES, following 008:204-206's precedent for
-- `accounts` and `auth_sessions`: zero policies means zero rows for `tm8_app`,
-- and the SECURITY DEFINER RPCs below are the only way in. There is no grant on
-- this table at all — not even select. A claim token must never be readable
-- through the ordinary read path, because the ordinary read path on an
-- unclaimed node is the loopback auto-owner, and a token readable by the party
-- that already has ownership is pure exposure with no use.
-- -----------------------------------------------------------------------------
create table if not exists public.node_claim_tokens (
  token_hash  text primary key,
  created_at  timestamptz not null default now(),
  used_at     timestamptz,
  used_by     text
);

comment on table public.node_claim_tokens is
  'First-run claim tokens, sha256 hashes only. Single-use: `used_at` non-null is '
  'burned. Inert once the node is claimed — see public.node_is_claimed().';

alter table public.node_claim_tokens enable row level security;
alter table public.node_claim_tokens force row level security;

-- -----------------------------------------------------------------------------
-- internal.node_is_claimed_unsafe — the definition, in one place.
--
-- `internal` and no grant: callers go through the two SECURITY DEFINER
-- functions below. Named `_unsafe` because it reads `accounts` with RLS
-- bypassed by the definer context and answers a question about the whole node —
-- correct inside a definer, wrong to expose.
-- -----------------------------------------------------------------------------
create or replace function internal.node_is_claimed_unsafe()
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.accounts
     where password_hash is not null
       and status = 'active'
  );
$$;

revoke all on function internal.node_is_claimed_unsafe() from public;

-- -----------------------------------------------------------------------------
-- public.node_is_claimed — backs `auth.claim.status`.
--
-- CLAIM-FREE BY DESIGN, and readable by an anonymous caller. It tells the
-- person who just installed the node the single thing they need to know, and it
-- tells an attacker nothing they could not learn by attempting a claim. The
-- alternative — requiring identity — would make the UI unable to decide which
-- frame to render without already being signed in, which is the bootstrap
-- circularity this whole design exists to break.
--
-- It deliberately does NOT report whether a live token exists. That is a fact
-- about the operator's filesystem, not about the node, and reporting it would
-- tell a stranger whether a claim is currently winnable.
-- -----------------------------------------------------------------------------
create or replace function public.node_is_claimed()
returns boolean language sql stable security definer
set search_path = public, internal, pg_temp as $$
  select internal.node_is_claimed_unsafe();
$$;

comment on function public.node_is_claimed() is
  'Claim-free (auth bootstrap): a caller deciding whether to claim has no identity yet. '
  'True once any active account has a password_hash.';

revoke all on function public.node_is_claimed() from public;
grant execute on function public.node_is_claimed() to tm8_app;

-- -----------------------------------------------------------------------------
-- public.issue_node_claim_token — mint, at boot, while unclaimed.
--
-- Claim-free for the same reason `ensure_account` is: at first boot there is no
-- identity to bind. The guard is the node's own state, not the caller's — and
-- it is re-read inside this function rather than trusted from the server,
-- because "is this node claimed" is exactly the kind of check that goes stale
-- between a read and a write.
--
-- Existing unburned tokens are burned first, so there is never more than one
-- live token. `--reissue` is therefore a rotation, not an accumulation: an
-- operator who reissues three times has invalidated the first two, which is
-- what "reissue" has to mean if the printed URL is to be trustworthy.
-- -----------------------------------------------------------------------------
create or replace function public.issue_node_claim_token(p_token_hash text)
returns void language plpgsql security definer
set search_path = public, internal, pg_temp as $$
begin
  if p_token_hash is null or btrim(p_token_hash) = '' then
    raise exception 'claim token hash is required' using errcode = '22023';
  end if;
  if internal.node_is_claimed_unsafe() then
    raise exception 'this node is already claimed' using errcode = '42501';
  end if;

  update public.node_claim_tokens
     set used_at = now(), used_by = 'superseded'
   where used_at is null;

  insert into public.node_claim_tokens(token_hash) values (p_token_hash)
  on conflict (token_hash) do nothing;
end
$$;

comment on function public.issue_node_claim_token(text) is
  'Claim-free (auth bootstrap). Refuses once the node is claimed. Burns any prior '
  'live token so exactly one claim URL is ever valid.';

revoke all on function public.issue_node_claim_token(text) from public;
grant execute on function public.issue_node_claim_token(text) to tm8_app;

-- -----------------------------------------------------------------------------
-- public.claim_node — the ceremony. ONE transaction, or none of it.
--
-- Claim-free: the TOKEN is the authorization. That is the entire point of the
-- design — it authorizes without requiring loopback, so an operator who can
-- read the boot log or the data dir can claim from any device.
--
-- THE ORDER OF THE GUARDS IS LOAD-BEARING.
--
--   1. lock the owner row FOR UPDATE. Taken FIRST, before either check, so two
--      concurrent claims serialize here rather than both passing a check and
--      both writing. Locking the token row instead would not help: the second
--      claimant could present a DIFFERENT live token.
--   2. re-assert the node is unclaimed. A valid token is NOT sufficient on its
--      own — someone else may have claimed in the window, and a token that
--      outlived its node's unclaimed state must not overwrite a real
--      credential. This is the check that makes a leaked token inert.
--   3. burn the token by hash, `where used_at is null`, and require that the
--      UPDATE touched a row. Doing the burn as the discriminating write rather
--      than as a separate select-then-update is what makes single-use real under
--      concurrency.
--
-- REFUSAL SHAPES. A bad token and an already-burned token both raise 28000 —
-- the same refusal, for the reason `auth.login` will not distinguish "no such
-- account" from "wrong password". A token presented against an already-CLAIMED
-- node raises 42501 instead, because guard 2 runs before guard 3. That
-- distinction leaks nothing: `public.node_is_claimed()` publishes the same fact
-- to anonymous callers by design, and "already claimed" is far more actionable
-- to an operator than a generic credential refusal. Asserted in
-- packages/server/test/w3/node-claim.test.ts.
-- -----------------------------------------------------------------------------
create or replace function public.claim_node(
  p_token_hash text,
  p_username text,
  p_password_algorithm text,
  p_password_hash text,
  p_display_name text default null,
  p_email text default null
) returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  a public.accounts;
  burned integer;
  handle text := lower(btrim(p_username));
begin
  if handle is null or handle = '' then
    raise exception 'username is required' using errcode = '22023';
  end if;
  if p_password_hash is null or p_password_algorithm is null then
    raise exception 'a credential is required to claim this node' using errcode = '22023';
  end if;

  -- 1. Serialize every concurrent claim on the single owner row.
  select * into a from public.accounts where is_owner for update;
  if a.id is null then
    raise exception 'this node has no owner account to claim' using errcode = 'P0002';
  end if;

  -- 2. The token is not sufficient on its own.
  if internal.node_is_claimed_unsafe() then
    raise exception 'this node is already claimed' using errcode = '42501';
  end if;

  -- 3. Burn-as-discriminator: single-use under concurrency.
  update public.node_claim_tokens
     set used_at = now(), used_by = a.identity_id
   where token_hash = p_token_hash
     and used_at is null;
  get diagnostics burned = row_count;
  if burned = 0 then
    raise exception 'invalid or already-used claim token' using errcode = '28000';
  end if;

  -- The username may collide with a non-owner account provisioned by CLI. That
  -- is a 23505 from the unique index, which is the right answer: pick another.
  update public.accounts
     set username           = handle,
         display_name       = coalesce(p_display_name, display_name),
         email              = coalesce(p_email, email),
         password_algorithm = p_password_algorithm,
         password_hash      = p_password_hash,
         is_node_admin      = true
   where id = a.id
  returning * into a;

  -- The profile is what chat and attribution render. `ensure_account` created
  -- this row at bootstrap with the placeholder display name; the claimant's own
  -- name replaces it, and every pre-claim row they created now renders as them.
  insert into public.user_profiles(identity_id, display_name, email)
  values (a.identity_id, coalesce(p_display_name, handle), p_email)
  on conflict (identity_id) do update
    set display_name = coalesce(excluded.display_name, user_profiles.display_name),
        email        = coalesce(excluded.email, user_profiles.email);

  return to_jsonb(a) - 'password_hash';
end
$$;

comment on function public.claim_node(text, text, text, text, text, text) is
  'Claim-free (auth bootstrap): the token is the authorization. Sets a credential on '
  'the EXISTING owner row — never creates an account, so ensure_account F1 is untouched '
  'and identity_id (and every attribution keyed to it) is preserved.';

revoke all on function public.claim_node(text, text, text, text, text, text) from public;
grant execute on function public.claim_node(text, text, text, text, text, text) to tm8_app;
