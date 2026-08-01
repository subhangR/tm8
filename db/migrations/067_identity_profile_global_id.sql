-- =============================================================================
-- 067 identity profile — global display identity (Identity v2 Stage 0).
--
-- One nullable column and one writer. `user_profiles.global_id` holds the
-- cross-server display binding for the human behind an identity, in the
-- ratified `issuer:subject` shape (Identity v2 doc 7 §2 P4) — e.g. a value
-- like `example-issuer:12345`. The schema does not know or care what the
-- issuer means: this is a generic text claim, never consulted by any
-- permission decision, RLS policy or guard (doc 7 invariant I6).
--
-- Deliberately NOT unique: NULL rows are the norm (nothing has ever populated
-- this table's display columns), and a uniqueness constraint on a
-- display-only claim would promote it toward an authorization key it must
-- never become.
--
-- The writer is the first catalog path to this table. 007's
-- `upsert_user_profile` predates the command ledger and carries no
-- clientMutationId; rather than widen a shared body other arms may rely on,
-- `identity.profile.update` gets its own RPC with the standard guard
-- sequence. Authorization is the bound claim ONLY: the caller writes the row
-- for `internal.require_identity()` and there is no parameter to name anyone
-- else.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The column. Shape-checked like identity_id (002:22), one colon seam:
--    a non-empty issuer, then a non-empty subject (which may itself contain
--    colons). No whitespace anywhere.
-- -----------------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists global_id text
  constraint user_profiles_global_id_shape check (
    global_id is null
    or (char_length(global_id) between 3 and 200
        and global_id ~ '^[^:[:space:]]+:[^[:space:]]+$')
  );

-- Non-unique on purpose (see header). Partial: the common row has none.
create index if not exists user_profiles_global_id_idx
  on public.user_profiles(global_id) where global_id is not null;

-- -----------------------------------------------------------------------------
-- 2. identity.get gains `globalId`.
--
-- ⚠ Shared function body: this is 007:372's `current_identity` copied verbatim
-- plus ONE added key. Every existing key must survive — `identity.get` is the
-- whole node's "who am I".
-- -----------------------------------------------------------------------------
create or replace function public.current_identity()
returns jsonb language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  identity text := internal.require_identity();
  result jsonb;
begin
  select jsonb_build_object(
      'identityId', a.identity_id, 'accountId', a.id, 'username', a.username,
      'displayName', coalesce(p.display_name, a.display_name), 'avatar', p.avatar,
      'email', coalesce(p.email, a.email),
      'globalId', p.global_id,
      'isNodeAdmin', a.is_node_admin, 'isOwner', a.is_owner, 'status', a.status,
      'actingAs', internal.acting_as(),
      'memberships', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'spaceId', m.space_id, 'memberId', m.entity_id, 'role', m.role)
               order by m.joined_at)
          from public.members m where m.identity_id = a.identity_id), '[]'::jsonb))
    into result
    from public.accounts a
    left join public.user_profiles p on p.identity_id = a.identity_id
   where a.identity_id = identity;
  if result is null then
    raise exception 'no account for the bound identity' using errcode = '28000';
  end if;
  return result;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. identity.profile.update — the writer.
--
-- Guard sequence per the catalog convention (031/036/062 lineage): replay is
-- yours → idempotent short-circuit → identify the caller → write. No space, no
-- actor: a profile belongs to an identity, so `resolve_actor`/`bind_actor`
-- have no subject here and attribution machinery is untouched (doc 5 §6).
--
-- Only provided (non-null) fields are written; absent fields keep their
-- value. Clearing a populated field back to NULL is deliberately not
-- expressible through this RPC — same coalesce semantics as 007's
-- upsert_user_profile.
-- -----------------------------------------------------------------------------
create or replace function public.update_identity_profile(
  p_display_name text default null, p_avatar text default null,
  p_email text default null, p_global_id text default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  identity text;
  replay jsonb;
  profile public.user_profiles;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'identity.profile.update');
  if replay is not null then return replay; end if;
  identity := internal.require_identity();

  insert into public.user_profiles(identity_id, display_name, avatar, email, global_id)
  values (identity, p_display_name, p_avatar, p_email, p_global_id)
  on conflict (identity_id) do update
    set display_name = coalesce(excluded.display_name, user_profiles.display_name),
        avatar = coalesce(excluded.avatar, user_profiles.avatar),
        email = coalesce(excluded.email, user_profiles.email),
        global_id = coalesce(excluded.global_id, user_profiles.global_id),
        updated_at = now()
  returning * into profile;

  return internal.ledger_record(p_client_mutation_id, 'identity.profile.update',
    jsonb_build_object(
      'identityId', profile.identity_id,
      'displayName', profile.display_name,
      'avatar', profile.avatar,
      'email', profile.email,
      'globalId', profile.global_id));
end
$$;

-- 042 retired the blanket grant; every new RPC states its audience.
revoke all on function public.update_identity_profile(text, text, text, text, text) from public;
grant execute on function public.update_identity_profile(text, text, text, text, text) to tm8_app;

reset role;
