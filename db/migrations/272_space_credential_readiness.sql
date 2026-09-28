-- 272 (placeholder 997 on lane S7; set at the merge position after main 1e53e1650's 271)
-- =============================================================================
-- space_credential_readiness(p_space_id). Spec doc 01a0e248 §10.4, §11 row
-- S7 (connect + readiness half), §8.3 Q1. Release 1 is ADDITIVE: this is a
-- read. Nothing refuses on it; R2's S7-refusal will.
--
-- TWO THRESHOLDS, NEVER ONE TICK (ruling, 2026-09-27). A space can be green to
-- launch and still have dead tracking, so the answer carries both, apart:
--
--   canLaunch  per provider (anthropic, openai, github): the caller's auto
--              ladder would find an ACTIVE space credential — their own
--              my_default (member_defaults, a credential they own, private or
--              public) or the space default — and the space's policy lets the
--              `space` source run at all. This is exactly what
--              `resolveSessionCredentials` reads on the auto path
--              (my_space_credential_default_id, then read_space_credential_for_spawn
--              with a null id), so green here means the spawn would bind.
--   canPoll    an ACTIVE, SPACE-OWNED (owner_account_id is null), PUBLIC github
--              credential exists. §10.5: background readers use the space's
--              own credential, never a member's private one, so a member-owned
--              github credential makes canLaunch.github green and leaves
--              canPoll red. The launch policy does not govern pollers.
--
-- `stale` NEVER counts, in either threshold: the spawn reader refuses it. It is
-- reported as the reason instead, so the UI can say "re-login" rather than
-- "connect". `pending` and `revoked` never count either.
--
-- activeCredentials is every ACTIVE credential of that provider in the space,
-- whoever owns it — §8.3 Q1's predicate exactly (`status = 'active'`), so an
-- operator seeding spaces (S9) can reconcile this read against Q1. Members can
-- already select those rows under 206's RLS (key hint and login masked by 239);
-- this adds a count, never a label, hint, login or secret.
--
-- METADATA ONLY: booleans, ids, counts and reason words. MEMBER-SCOPED: a
-- non-member gets 42501 from require_space_member, like every 206 reader. It is
-- NOT human-only in SQL: R2's spawn refusal will call it under agent claims
-- (an agent's claims are its root human launcher's). The catalog operation
-- `credentials.space.readiness` is human-only, like every credentials.* row.
--
-- SHARED-OBJECT REGISTER (coordinator doc 01a0e26b): this migration redefines or alters
-- NOTHING. It creates one new function, public.space_credential_readiness(uuid),
-- which no earlier migration defines. No triggers, views, checks or edge types.
-- It only READS space_credentials, member_defaults, space_credential_policies.
-- Its predicates mirror 255's my_space_credential_default_id and 256's
-- read_space_credential_for_spawn (null id): change those, change this.
-- =============================================================================

set role tm8_graph_owner;

create or replace function public.space_credential_readiness(p_space_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, internal, pg_temp as $$
declare
  v_account uuid;
  v_provider text;
  v_allowed text[];
  v_space_allowed boolean;
  v_mine uuid;
  v_mine_stale boolean;
  v_default uuid;
  v_default_stale boolean;
  v_active integer;
  v_ready boolean;
  v_reason text;
  v_by_provider jsonb := '{}'::jsonb;
  v_missing text[] := array[]::text[];
  v_poll_id uuid;
  v_poll_active integer;
  v_poll_stale boolean;
begin
  perform internal.require_space_member(p_space_id);
  v_account := internal.current_account_id();

  foreach v_provider in array array['anthropic', 'openai', 'github'] loop
    -- D5: an absent policy row allows every source.
    select pol.allowed_sources into v_allowed
      from public.space_credential_policies pol
     where pol.space_id = p_space_id and pol.provider = v_provider;
    v_space_allowed := v_allowed is null or 'space' = any(v_allowed);

    -- my_default: my_space_credential_default_id's predicate (255).
    select sc.id, false into v_mine, v_mine_stale
      from public.member_defaults md
      join public.space_credentials sc on sc.id = md.credential_id
     where md.space_id = p_space_id and md.account_id = v_account
       and md.provider = v_provider and sc.status = 'active';
    if v_mine is null then
      v_mine_stale := exists (
        select 1 from public.member_defaults md
          join public.space_credentials sc on sc.id = md.credential_id
         where md.space_id = p_space_id and md.account_id = v_account
           and md.provider = v_provider and sc.status = 'stale');
    end if;

    -- space_default: read_space_credential_for_spawn's null-id predicate (256).
    -- The default is public by constraint (239), so every member may use it.
    select sc.id into v_default
      from public.space_credentials sc
     where sc.space_id = p_space_id and sc.provider = v_provider
       and sc.is_default and sc.status = 'active';
    v_default_stale := v_default is null and exists (
      select 1 from public.space_credentials sc
       where sc.space_id = p_space_id and sc.provider = v_provider
         and sc.is_default and sc.status = 'stale');

    -- §8.3 Q1's predicate, for reconciliation.
    select count(*) into v_active
      from public.space_credentials sc
     where sc.space_id = p_space_id and sc.provider = v_provider and sc.status = 'active';

    v_ready := v_space_allowed and (v_mine is not null or v_default is not null);
    v_reason := case
      when v_ready then null
      when not v_space_allowed then 'policy_excludes_space'
      when v_mine_stale or v_default_stale then 'stale'
      else 'no_credential'
    end;
    if not v_ready then
      v_missing := v_missing || v_provider;
    end if;

    v_by_provider := v_by_provider || jsonb_build_object(v_provider, jsonb_build_object(
      'ready', v_ready,
      'via', case when not v_space_allowed then null
                  when v_mine is not null then 'my_default'
                  when v_default is not null then 'space_default' end,
      'credentialId', case when v_space_allowed then coalesce(v_mine, v_default) end,
      'myDefaultId', v_mine,
      'spaceDefaultId', v_default,
      'spaceSourceAllowed', v_space_allowed,
      'activeCredentials', v_active,
      'reason', v_reason));
  end loop;

  -- canPoll: space-owned, public, active github. Prefer the space default, then
  -- the oldest, so the answer is stable.
  select sc.id into v_poll_id
    from public.space_credentials sc
   where sc.space_id = p_space_id and sc.provider = 'github' and sc.status = 'active'
     and sc.owner_account_id is null and sc.visibility = 'public'
   order by sc.is_default desc, sc.created_at, sc.id
   limit 1;
  select count(*) into v_poll_active
    from public.space_credentials sc
   where sc.space_id = p_space_id and sc.provider = 'github' and sc.status = 'active'
     and sc.owner_account_id is null and sc.visibility = 'public';
  v_poll_stale := v_poll_id is null and exists (
    select 1 from public.space_credentials sc
     where sc.space_id = p_space_id and sc.provider = 'github' and sc.status = 'stale'
       and sc.owner_account_id is null and sc.visibility = 'public');

  return jsonb_build_object(
    'spaceId', p_space_id,
    'canLaunch', jsonb_build_object(
      'ready', cardinality(v_missing) = 0,
      'missing', to_jsonb(v_missing),
      'providers', v_by_provider),
    'canPoll', jsonb_build_object(
      'ready', v_poll_id is not null,
      'missing', case when v_poll_id is null then '["github"]'::jsonb else '[]'::jsonb end,
      'credentialId', v_poll_id,
      'activeSpaceOwnedCredentials', v_poll_active,
      'reason', case when v_poll_id is not null then null
                     when v_poll_stale then 'stale'
                     else 'no_space_owned_credential' end));
end
$$;

comment on function public.space_credential_readiness(uuid) is
  'Doc 01a0e248 S7: per-space credential readiness, TWO thresholds (canLaunch: '
  'caller''s active my_default or space default per provider, policy allowing; '
  'canPoll: an active space-owned public github credential). Active only, '
  'metadata only, member-scoped. Read the header of migration space_credential_readiness before changing it.';

revoke all on function public.space_credential_readiness(uuid) from public;
grant execute on function public.space_credential_readiness(uuid) to tm8_app;

reset role;
