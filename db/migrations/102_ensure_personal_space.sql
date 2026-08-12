-- =============================================================================
-- 102 — every identity gets its space, including the ones the control plane
--       did not create (2026-08-11).
--
-- 101 made `provision_user` the one way to create a USER. It is not the one way
-- to create an ACCOUNT: `resolveLoopbackOwner` (identity/loopback.ts) still
-- mints the node owner through `ensure_account` at first boot, claim-free, on a
-- virgin database — and it must, because that path runs before any identity
-- exists to authorize anything.
--
-- The consequence was visible the moment `users.list` shipped:
--
--     owner  [owner node-admin]
--       space    NO PERSONAL SPACE
--       home     no home record
--
-- which is exactly the defect this whole phase exists to remove, surviving on
-- the one path that skips the control plane. 101's backfill fixed the accounts
-- that existed WHEN IT RAN; it could not fix one created afterwards.
--
-- So: an idempotent, SELF-SCOPED repair. It takes no argument and operates on
-- the caller's own identity, which is why it needs no capability — asking for
-- your own space to exist is not an administrative act. Called at boot for the
-- loopback owner and on every successful login, so "logging in lands you in
-- your space" is true for every identity however its account was made.
-- =============================================================================
set role tm8_graph_owner;

create or replace function public.ensure_personal_space()
returns jsonb language plpgsql security definer
set search_path = public, internal, pg_temp as $$
declare
  identity text;
  account public.accounts;
  existing public.spaces;
  home public.user_homes;
  next_serial integer;
  space_result jsonb;
  new_space uuid;
  created boolean := false;
begin
  identity := internal.require_identity();

  select * into existing from public.spaces where personal_for_identity = identity;
  if existing.id is not null then
    -- Fast path, and the common one: one indexed lookup and out. This runs on
    -- every login, so it must cost nothing once the space exists.
    return jsonb_build_object('spaceId', existing.id, 'created', false);
  end if;

  -- An identity with no account is not a person this node provisions a space
  -- for — it would be a graph-side profile with no way to log in. Answer
  -- honestly rather than manufacturing a space nobody can reach.
  select * into account from public.accounts where identity_id = identity;
  if account.id is null then
    return jsonb_build_object('spaceId', null, 'created', false, 'reason', 'no account');
  end if;

  space_result := internal.create_space_for(
    identity,
    coalesce(nullif(btrim(account.display_name), ''), account.username) || '''s Space',
    'Personal space', 'private', null);
  new_space := (space_result -> 'space' ->> 'id')::uuid;
  update public.spaces set personal_for_identity = identity where id = new_space;
  created := true;

  -- The home record too, on the same terms 101's backfill used: 'shared-uid' is
  -- what this node actually gives an agent today, and 'pending' would imply
  -- queued work that nothing is going to do.
  select * into home from public.user_homes where identity_id = identity;
  if home.identity_id is null then
    next_serial := nextval('public.user_home_serial');
    insert into public.user_homes(identity_id, serial, os_username, home_path, isolation)
    values (identity, next_serial, 'tm8u' || next_serial::text,
            '/srv/tm8/homes/tm8u' || next_serial::text, 'shared-uid');
  end if;

  insert into public.account_capabilities(account_id, capability)
  values (account.id, 'projects.register')
  on conflict do nothing;

  return jsonb_build_object('spaceId', new_space, 'created', created);
end
$$;

revoke all on function public.ensure_personal_space() from public;
grant execute on function public.ensure_personal_space() to tm8_app;

reset role;
