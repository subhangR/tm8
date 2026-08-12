-- =============================================================================
-- 104 — de-escalation (2026-08-12).
--
-- 103 stopped `is_node_admin` implying anything, which sounds like the fix and
-- is not. 101's backfill had already granted every existing node admin the FULL
-- capability set as explicit rows — deliberately, so that removing the flag's
-- implication could not take away access anybody was actually using. The result
-- after 103 is that the same seven accounts still hold `users.credentials` and
-- can still reset each other's passwords, now by row rather than by flag.
--
-- THIS migration is the one that reduces the risk. It removes the four
-- account-lifecycle capabilities from everyone who should not have them.
--
-- THE POLICY, stated rather than implied:
--
--   KEEP account lifecycle (users.provision / credentials / suspend / delete)
--     · the owner            — is_owner already implies everything; the account
--                              of last resort, and not expressible any other way
--     · `breakglass`         — exists for exactly this, by name and convention
--
--   KEEP operational capabilities for everyone who had node admin
--     · projects.register.any, connections.manage, node.maintain
--       These are what the flag was actually being used for. Taking them away
--       would repeat the original mistake in the other direction: the reason
--       seven people held node admin is that ordinary work required it, and a
--       de-escalation that breaks ordinary work gets reverted.
--
--   EVERY account keeps `projects.register` (granted at provision).
--
-- Deliberately conservative and trivially reversible: granting a capability
-- back is one command (`tm8 user grant <account> <capability>`), while an
-- account takeover is not reversible at all. If someone turns out to need
-- `users.suspend`, that is a grant, not a revert of this migration.
-- =============================================================================
set role tm8_graph_owner;

do $deescalate$
declare
  lifecycle constant text[] := array[
    'users.provision', 'users.credentials', 'users.suspend', 'users.delete'
  ];
  -- Accounts that keep the lifecycle set. `is_owner` is structural; the
  -- break-glass account is named, because "which account is the emergency one"
  -- is a human decision that no column records.
  keepers constant text[] := array['breakglass'];
  removed integer;
  survivors integer;
begin
  delete from public.account_capabilities c
   using public.accounts a
   where a.id = c.account_id
     and c.capability = any (lifecycle)
     and a.is_owner is false
     and lower(a.username) <> all (select lower(k) from unnest(keepers) k);
  get diagnostics removed = row_count;

  -- The floor, checked rather than assumed. A de-escalation that locked the
  -- node out of its own administration would be a worse outcome than the one it
  -- is fixing, so refuse instead of committing it.
  --
  -- Scoped to nodes that HAVE accounts. A virgin database has none, so it has
  -- nobody to lock out and nothing was removed — and the first `provision_user`
  -- there mints the owner through the first-run hole. Without this scoping the
  -- guard refuses every fresh database, which is how it announced itself: it
  -- failed 86 test suites at once, every one of them a scratch DB.
  select count(*) into survivors
    from public.accounts a
   where a.status = 'active'
     and (a.is_owner
          or exists (select 1 from public.account_capabilities c
                      where c.account_id = a.id and c.capability = 'users.credentials'));
  if survivors = 0 and exists (select 1 from public.accounts where status = 'active') then
    raise exception 'refusing to leave this node with no account able to reset a credential';
  end if;

  raise notice 'de-escalation: removed % lifecycle capability row(s); % account(s) can still reset a credential',
    removed, survivors;
end
$deescalate$;

-- -----------------------------------------------------------------------------
-- The flag itself.
--
-- `is_node_admin` now implies nothing (103) and gates nothing (103's guard), so
-- it is inert. It is NOT dropped here: keeping the column for one release makes
-- this whole change a one-line revert of `internal.has_capability` rather than a
-- data migration, and `AuthAccountView.isNodeAdmin` is still on the wire.
--
-- What it must no longer do is look like authority to a human reading a list,
-- so `tm8 user list` renders it as a legacy marker rather than a role.
-- -----------------------------------------------------------------------------
comment on column public.accounts.is_node_admin is
  'LEGACY, inert since migration 103. Implies no capability and gates no RPC. '
  'Authority lives in public.account_capabilities. Retained one release so the '
  'capability split can be reverted without a data migration; drop after that.';

reset role;
