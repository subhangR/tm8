-- 995 (placeholder; the Release Owner sets the ordinal at the merge position after 273)
-- =============================================================================
-- Readiness PER USED PROVIDER: make the R2 seeding gate reachable. Task
-- 01a0e75e (R1/S7b), spec doc 01a0e248 §8.3 and §11 row S9 ("re-run §8.3 daily
-- until every space is green PER PROVIDER IT USES"). ADDITIVE: a read. Nothing
-- refuses on it.
--
-- THE DEFECT (272:74, :155). 272's canLaunch.ready is "no provider missing"
-- over ALL THREE providers, so a space that never launches on openai can never
-- be green, and the hold-until-seeded gate (form 01a0e726) could not be met.
-- 272 is not edited (migrate.mjs checksums applied files) and canLaunch keeps
-- its meaning: it is the CALLER's launch answer, and the drift guard in the pg
-- test holds it to the spawn ladder. This migration adds a separate verdict.
--
-- USED PROVIDERS ARE DERIVED, NOT DECLARED (coordinator ruling, implementing
-- §8.3 as written). Over a window (default 30 days) of AGENT work sessions in
-- the space (entities.space_id; work_sessions.created_at in the window;
-- shells and credential-login sessions launch on no provider):
--   anthropic, openai  used when a session's
--                      manifest->'launch'->'effectiveCredentialSources' names
--                      the provider with a non-null source (Q2's read);
--   github             the same, OR the space has a project whose repo_url is
--                      on github.com (the pollers read it, §10.5).
-- A space with NO agent session in the window is `idle`: reported apart, never
-- red, whatever else it holds.
--
-- SESSIONS WITH NO EFFECTIVE MAP (coordinator ruling (A), 2026-09-28). On
-- tm8_prod at 10:22Z, 579 of 859 agent sessions in the 30-day window had no
-- map: real claude-code and codex launches from before the map was recorded
-- (to 2026-09-24). Reading only the map made 8 spaces FALSE GREEN. So for an
-- agent session that HAS a manifest but no (or an empty) map, the provider is
-- inferred from agent_tool: claude-code and claude -> anthropic, codex ->
-- openai; any other tool infers nothing. github is never inferred (only its
-- map entry or a github.com project makes it used). A session with NO manifest
-- infers nothing. Every session without a map, manifest or not, is counted in
-- sessionsWithoutRecord beside the verdict. Once the window is past 09-24 the
-- inference is a no-op for sessions that record their map.
--
-- THE VERDICT IS THE SPACE'S, NOT THE CALLER'S. Seeding is about whether the
-- space launches for EVERY member at the cut, so per used provider:
--   launch  (provider used by a session): the space policy lets `space` run
--           (absent row = every source, D5) AND an ACTIVE space default exists:
--           256 read_space_credential_for_spawn's null-id branch, which every
--           member's ladder reaches. A member's private my_default seeds one
--           person, not the space, so it does not count here (it still counts
--           in canLaunch, which is per caller).
--   poll    (github used by a github project): an ACTIVE, SPACE-OWNED, PUBLIC
--           github credential: 272's canPoll predicate.
-- `stale`, `pending`, `revoked` never count. Reasons, first failing need wins:
-- policy_excludes_space, stale, no_default (active credentials exist, none is
-- the space default), no_credential; then no_space_owned_credential / stale.
-- state = idle | green (every used provider ready) | red; readyForCut =
-- state <> 'red'. A non-idle space whose sessions name no provider, with no
-- github project, uses nothing and is green.
--
-- METADATA ONLY: booleans, counts, provider names and reason words; no label,
-- key hint, login, secret, session id or project name.
--
-- OPERATOR GATE (§8.3 Q5): internal.credential_seeding_gate(window) lists every
-- space green/red/idle. Node-wide, so it is NOT granted to tm8_app; run it as
-- the graph owner inside `begin read only; ... rollback;`.
--
-- SHARED-OBJECT REGISTER (doc 01a0e26b, "R1/S7b declarations"): redefines
-- public.space_credential_readiness(uuid) from 272 (its only definition),
-- body VERBATIM plus one returned key `seeding`; creates
-- internal.space_credential_seeding(uuid, interval) and
-- internal.credential_seeding_gate(interval). Reads nothing of 273's (S1) or
-- 271's (S6). Read dependencies: 256's null-id predicate, 206/239 policy rule,
-- 272's canPoll predicate. R2 S4/S7-refusal: change which credential a launch
-- binds, re-check this.
-- =============================================================================

set role tm8_graph_owner;

create or replace function internal.space_credential_seeding(p_space_id uuid, p_window interval)
returns jsonb
language plpgsql stable set search_path = public, internal, pg_temp as $$
declare
  v_since timestamptz := now() - p_window;
  v_sessions integer;
  v_unrecorded integer;
  v_session_used text[];
  v_github_projects integer;
  v_provider text;
  v_needs text[];
  v_used text[] := array[]::text[];
  v_missing text[] := array[]::text[];
  v_allowed text[];
  v_space_allowed boolean;
  v_default_active boolean;
  v_default_stale boolean;
  v_any_active boolean;
  v_poll_active boolean;
  v_poll_stale boolean;
  v_launch_reason text;
  v_poll_reason text;
  v_ready boolean;
  v_providers jsonb := '{}'::jsonb;
  v_state text;
begin
  if p_window is null or p_window <= interval '0' then
    raise exception 'space_credential_seeding: the window must be a positive interval'
      using errcode = '22023';
  end if;

  with recent as (
    select ws.entity_id, sm.manifest->'launch'->'effectiveCredentialSources' as eff,
           sm.work_session_id is not null as has_manifest, ws.agent_tool
      from public.work_sessions ws
      join public.entities e on e.id = ws.entity_id
      left join public.session_manifests sm on sm.work_session_id = ws.entity_id
     where e.space_id = p_space_id and ws.session_kind = 'agent' and ws.created_at >= v_since)
  select count(*)::integer,
         count(*) filter (where eff is null or jsonb_typeof(eff) <> 'object' or eff = '{}'::jsonb)::integer,
         coalesce((select array_agg(distinct src.key)
                     from recent r2,
                          jsonb_each(case when jsonb_typeof(r2.eff) = 'object' then r2.eff else '{}'::jsonb end) src
                    where jsonb_typeof(src.value) <> 'null'
                      and src.key in ('anthropic', 'openai', 'github')), array[]::text[])
      || coalesce((select array_agg(distinct case r3.agent_tool when 'codex' then 'openai' else 'anthropic' end)
                     from recent r3
                    where r3.has_manifest
                      and (r3.eff is null or jsonb_typeof(r3.eff) <> 'object' or r3.eff = '{}'::jsonb)
                      and r3.agent_tool in ('claude-code', 'claude', 'codex')), array[]::text[])
    into v_sessions, v_unrecorded, v_session_used
    from recent;

  select count(*)::integer into v_github_projects
    from public.space_projects sp
    join public.projects p on p.id = sp.project_id
   where sp.space_id = p_space_id
     and p.repo_url ~* '^(https?://|ssh://|git://)?([^/@]+@)?(www\.)?github\.com[:/]';

  foreach v_provider in array array['anthropic', 'openai', 'github'] loop
    v_needs := array[]::text[];
    if v_provider = any(v_session_used) then v_needs := v_needs || 'launch'::text; end if;
    if v_provider = 'github' and v_github_projects > 0 then v_needs := v_needs || 'poll'::text; end if;
    continue when cardinality(v_needs) = 0;
    v_used := v_used || v_provider;

    v_launch_reason := null;
    if 'launch' = any(v_needs) then
      select pol.allowed_sources into v_allowed
        from public.space_credential_policies pol
       where pol.space_id = p_space_id and pol.provider = v_provider;
      v_space_allowed := v_allowed is null or 'space' = any(v_allowed);
      v_default_active := exists (
        select 1 from public.space_credentials sc
         where sc.space_id = p_space_id and sc.provider = v_provider
           and sc.is_default and sc.status = 'active');
      v_default_stale := exists (
        select 1 from public.space_credentials sc
         where sc.space_id = p_space_id and sc.provider = v_provider
           and sc.is_default and sc.status = 'stale');
      v_any_active := exists (
        select 1 from public.space_credentials sc
         where sc.space_id = p_space_id and sc.provider = v_provider and sc.status = 'active');
      v_launch_reason := case
        when not v_space_allowed then 'policy_excludes_space'
        when v_default_active then null
        when v_default_stale then 'stale'
        when v_any_active then 'no_default'
        else 'no_credential'
      end;
    end if;

    v_poll_reason := null;
    if 'poll' = any(v_needs) then
      v_poll_active := exists (
        select 1 from public.space_credentials sc
         where sc.space_id = p_space_id and sc.provider = 'github' and sc.status = 'active'
           and sc.owner_account_id is null and sc.visibility = 'public');
      v_poll_stale := exists (
        select 1 from public.space_credentials sc
         where sc.space_id = p_space_id and sc.provider = 'github' and sc.status = 'stale'
           and sc.owner_account_id is null and sc.visibility = 'public');
      v_poll_reason := case
        when v_poll_active then null
        when v_poll_stale then 'stale'
        else 'no_space_owned_credential'
      end;
    end if;

    v_ready := v_launch_reason is null and v_poll_reason is null;
    if not v_ready then v_missing := v_missing || v_provider; end if;

    v_providers := v_providers || jsonb_build_object(v_provider, jsonb_build_object(
      'ready', v_ready,
      'needs', to_jsonb(v_needs),
      'launchReason', v_launch_reason,
      'pollReason', v_poll_reason,
      'reason', coalesce(v_launch_reason, v_poll_reason)));
  end loop;

  v_state := case when v_sessions = 0 then 'idle'
                  when cardinality(v_missing) = 0 then 'green'
                  else 'red' end;

  return jsonb_build_object(
    'window', p_window::text,
    'agentSessions', v_sessions,
    'sessionsWithoutRecord', v_unrecorded,
    'githubProjects', v_github_projects,
    'usedProviders', to_jsonb(v_used),
    'providers', v_providers,
    'missing', to_jsonb(v_missing),
    'state', v_state,
    'readyForCut', v_state <> 'red');
end
$$;

comment on function internal.space_credential_seeding(uuid, interval) is
  'Doc 01a0e248 §8.3/S9, task 01a0e75e: a space''s used providers (agent sessions in the window, '
  'github projects) and the R2 seeding verdict per used provider, caller-independent. Metadata only. '
  'Read the header of migration space_credential_readiness_per_used_provider before changing it.';
revoke all on function internal.space_credential_seeding(uuid, interval) from public;

-- §8.3 Q5: the node-wide operator gate. One row per space.
create or replace function internal.credential_seeding_gate(p_window interval default interval '30 days')
returns table (
  space_id uuid,
  state text,
  used_providers text[],
  missing text[],
  agent_sessions integer,
  sessions_without_record integer,
  github_projects integer)
language sql stable set search_path = public, internal, pg_temp as $$
  select s.id,
         g->>'state',
         array(select jsonb_array_elements_text(g->'usedProviders')),
         array(select jsonb_array_elements_text(g->'missing')),
         (g->>'agentSessions')::integer,
         (g->>'sessionsWithoutRecord')::integer,
         (g->>'githubProjects')::integer
    from public.spaces s
    cross join lateral internal.space_credential_seeding(s.id, p_window) g
   order by case g->>'state' when 'red' then 0 when 'green' then 1 else 2 end, s.id
$$;

comment on function internal.credential_seeding_gate(interval) is
  'Doc 01a0e248 §8.3 Q5, task 01a0e75e: every space green / red (missing providers) / idle for the '
  'R2 seeding gate. Node-wide, operator-only (graph owner, read-only transaction). Ids and counts only.';
revoke all on function internal.credential_seeding_gate(interval) from public;

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
    'seeding', internal.space_credential_seeding(p_space_id, interval '30 days'),
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
  'metadata only, member-scoped; seeding (995): the providers the space used in 30 days and the R2 gate '
  'verdict, caller-independent. Read the headers of migrations space_credential_readiness and '
  'space_credential_readiness_per_used_provider before changing it.';

revoke all on function public.space_credential_readiness(uuid) from public;
grant execute on function public.space_credential_readiness(uuid) to tm8_app;

reset role;
