-- =============================================================================
-- 142  READ THE NODE OWNER BY FLAG, SO A CLAIMED NODE CAN BOOT IN MULTI MODE.
--
-- THE BUG THIS CLOSES. Converting an existing tm8 node to multiplayer — the one
-- documented conversion journey (docs/identity/FIRST-RUN-CLAIM-DESIGN.md §5.2:
-- "one env line and a restart") — BRICKED the node. A claimed database booted
-- with TM8_NODE_MODE=multi died before it listened:
--     tm8-server failed to start: account creation requires an authenticated
--     node admin
--
-- THE MECHANISM. The loopback owner resolver (identity/loopback.ts) read the
-- owner row by the literal username `owner`, via resolve_account_credential.
-- But `claim_node` (116:288) RENAMES that row's username to the claimant's
-- chosen handle when the node is claimed. So on any claimed node the read
-- misses, the resolver falls through to `ensure_account`, and — because a
-- claimed node HAS accounts — F1 (007:163-169) demands an authenticated node
-- admin. There is none at boot: multi mode forces disableAutoOwner (config.ts:
-- 418, design D4), which is correct and must stay. `ensure_account` raises
-- 28000 and nothing on the boot path catches it. Virgin nodes survived only
-- because their owner is still named `owner` and has zero prior accounts.
--
-- Two boot paths in production (factory) composition hit this uncaught:
-- main.ts:233 (launch bootstrap) and main.ts:267 (chat boot sweep). Disabling
-- launch bootstrap did NOT help, because the chat sweep resolves the owner too.
--
-- THE FIX. Read the owner by the `is_owner` FLAG — the canonical, immutable
-- selector — instead of by a username the claim ceremony is free to change.
-- `ensure_account` sets `is_owner` (and forces `is_node_admin`) on the one owner
-- row (007:190-193); `claim_node` never clears it (116:288-296). So exactly one
-- row matches on every bootstrapped node, whatever its username has become.
--
-- WHY THIS IS THE THIRD, AND STRICTLY NARROWEST, CLAIM-FREE READ. 007:105-108
-- and 007:126-130 call resolve_auth_session and resolve_account_credential "the
-- second and last" claim-free holes. This is a third, and it is deliberate: a
-- caller working out what the loopback identity IS has, by definition, no
-- identity to bind. It is strictly LESS exposure than the read it replaces —
-- resolve_account_credential returns the owner's password_hash to any claim-free
-- caller who guesses the username; this returns the owner's public identity
-- fields and NO secret at all. It also widens nothing at the network boundary:
-- the only callers of the resolver are boot-internal and the single-mode
-- auto-owner arm. In multi mode http/identity-resolver.ts:84 narrows a network
-- caller to anonymous BEFORE the resolver is ever reached, so this read is never
-- on a path that could authenticate a stranger.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- public.resolve_node_owner — the single is_owner row, or NULL on a virgin node.
--
-- Shape matches resolve_account_credential's camelCase object (loopback.ts's
-- `toOwner` normaliser reads either casing), MINUS every secret: no
-- password_hash, no password_algorithm. A node with no owner yet (virgin, zero
-- accounts) returns NULL, which routes the resolver to `ensure_account`'s
-- claim-free first-run mint.
--
-- SECURITY DEFINER because `accounts` has RLS with zero policies for tm8_app
-- (008:204-206) — the same reason resolve_account_credential is a definer. The
-- single-owner unique index (002:65) guarantees `limit 1` is the whole story.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_node_owner()
returns jsonb language sql stable security definer set search_path = public, internal, pg_temp as $$
  select jsonb_build_object(
    'accountId', a.id, 'identityId', a.identity_id, 'username', a.username,
    'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner, 'status', a.status)
    from public.accounts a
   where a.is_owner
   limit 1
$$;

comment on function public.resolve_node_owner() is
  'Claim-free by design (loopback owner bootstrap): reads the single is_owner '
  'account by flag, so a node whose owner username was changed by claim_node '
  'still resolves. Returns public identity fields only — never a credential.';

-- New function added after 008''s blanket grant, so grant explicitly, and lock
-- PUBLIC out first (the default EXECUTE-to-PUBLIC on new functions) exactly as
-- 116''s claim-free definers do.
revoke all on function public.resolve_node_owner() from public;
grant execute on function public.resolve_node_owner() to tm8_app;
