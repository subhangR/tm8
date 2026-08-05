-- =============================================================================
-- 080 — resolve the caller's own account id for tm8_app.
--
-- WHY THIS EXISTS. Per-user workspaces name each account's private directory
-- after its account id, so the server must answer "which account is calling?"
-- on every browse. It cannot read the answer directly: `public.accounts` has no
-- grant to `tm8_app` at all (008 grants select only on the graph tables), and
-- adding one would hand the application role every account row in order to
-- learn one fact about itself.
--
-- WHY NOT internal.account_id(). That accessor already exists (001:161) and
-- reads a `tm8.account_id` claim — but nothing sets that claim. `DbClaims`
-- carries identity, actor, node_admin and request_id and nothing else
-- (packages/server/src/db/types.ts:26-40), so `internal.account_id()` returns
-- NULL on every request today. Teaching the claim pipeline a fifth claim is a
-- change to the contract every RLS policy reads from; resolving the account
-- from the identity we already bind is strictly smaller and cannot alter how
-- any existing policy evaluates.
--
-- SO: the same shape 008/021 use whenever `tm8_app` needs a fact from a table
-- it may not read — a `security definer` function that answers exactly one
-- question and is granted to nothing else. It is `stable`, takes no argument,
-- and is keyed on `internal.identity_id()`, so a caller cannot ask it about
-- anybody but themselves. An unbound claim yields NULL, which the server
-- refuses rather than defaulting.
--
-- `status = 'active'` is part of the predicate on purpose: a suspended account
-- should stop resolving to a workspace, not keep one it can no longer reach.
-- =============================================================================
set role tm8_graph_owner;

create or replace function internal.workspace_account_id() returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select account_row.id
    from public.accounts account_row
   where account_row.identity_id = internal.identity_id()
     and account_row.status = 'active'
$$;

comment on function internal.workspace_account_id() is
  'The calling identity''s own active account id, or NULL. Keyed on internal.identity_id(); cannot be asked about another account.';

revoke all on function internal.workspace_account_id() from public;
grant execute on function internal.workspace_account_id() to tm8_app;

reset role;
