-- R2 seeding gate, node-wide (doc 01a0e248 §8.3 Q5, task 01a0e75e). READ-ONLY.
-- Run as a role that bypasses RLS (graph owner), e.g.
--   psql "$URL" -v window="'30 days'" -f db/reports/credential_seeding_gate.sql
-- One row per space: green (every used provider seeded) / red (missing listed)
-- / idle (no agent session in the window; never red). Ids and counts only: no
-- label, key hint, login, secret, session id or project name.
--
-- This is the SAME verdict as internal.credential_seeding_gate(window) (the
-- readiness migration space_credential_readiness_per_used_provider), written
-- as a plain query so it runs on a node that has not applied that migration
-- yet and inside a read-only transaction. The pg test holds the two equal:
-- change one, change both. Read that migration's header for the rules.
\if :{?window}
\else
  \set window '''30 days'''
\endif
begin read only;

with prov(provider, ord) as (values ('anthropic', 1), ('openai', 2), ('github', 3)),
recent as (
  select e.space_id, sm.manifest->'launch'->'effectiveCredentialSources' as eff,
         sm.work_session_id is not null as has_manifest, ws.agent_tool
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
    left join public.session_manifests sm on sm.work_session_id = ws.entity_id
   where ws.session_kind = 'agent' and ws.created_at >= now() - (:window)::interval),
sessions as (
  select s.id as space_id,
         count(r.space_id)::integer as agent_sessions,
         count(r.space_id) filter (where r.eff is null or jsonb_typeof(r.eff) <> 'object' or r.eff = '{}'::jsonb)::integer
           as sessions_without_record
    from public.spaces s left join recent r on r.space_id = s.id
   group by s.id),
session_used as (
  select distinct r.space_id, src.key as provider
    from recent r,
         jsonb_each(case when jsonb_typeof(r.eff) = 'object' then r.eff else '{}'::jsonb end) src
   where jsonb_typeof(src.value) <> 'null' and src.key in ('anthropic', 'openai', 'github')
  union
  -- ruling (A): a session WITH a manifest but no map infers from agent_tool; github never.
  select distinct r.space_id, case r.agent_tool when 'codex' then 'openai' else 'anthropic' end
    from recent r
   where r.has_manifest and (r.eff is null or jsonb_typeof(r.eff) <> 'object' or r.eff = '{}'::jsonb)
     and r.agent_tool in ('claude-code', 'claude', 'codex')),
gh_projects as (
  select s.id as space_id,
         count(p.id) filter (where p.repo_url ~* '^(https?://|ssh://|git://)?([^/@]+@)?(www\.)?github\.com[:/]')::integer as n
    from public.spaces s
    left join public.space_projects sp on sp.space_id = s.id
    left join public.projects p on p.id = sp.project_id
   group by s.id),
needs as (
  select s.id as space_id, pv.provider, pv.ord,
         exists (select 1 from session_used u where u.space_id = s.id and u.provider = pv.provider) as launch,
         (pv.provider = 'github' and g.n > 0) as poll
    from public.spaces s cross join prov pv join gh_projects g on g.space_id = s.id),
verdict as (
  select n.space_id, n.provider, n.ord,
         case when not n.launch then null
              when pol.allowed_sources is not null and not ('space' = any(pol.allowed_sources)) then 'policy_excludes_space'
              when exists (select 1 from public.space_credentials sc where sc.space_id = n.space_id and sc.provider = n.provider
                              and sc.is_default and sc.status = 'active') then null
              when exists (select 1 from public.space_credentials sc where sc.space_id = n.space_id and sc.provider = n.provider
                              and sc.is_default and sc.status = 'stale') then 'stale'
              when exists (select 1 from public.space_credentials sc where sc.space_id = n.space_id and sc.provider = n.provider
                              and sc.status = 'active') then 'no_default'
              else 'no_credential' end as launch_reason,
         case when not n.poll then null
              when exists (select 1 from public.space_credentials sc where sc.space_id = n.space_id and sc.provider = 'github'
                              and sc.status = 'active' and sc.owner_account_id is null and sc.visibility = 'public') then null
              when exists (select 1 from public.space_credentials sc where sc.space_id = n.space_id and sc.provider = 'github'
                              and sc.status = 'stale' and sc.owner_account_id is null and sc.visibility = 'public') then 'stale'
              else 'no_space_owned_credential' end as poll_reason
    from needs n
    left join public.space_credential_policies pol on pol.space_id = n.space_id and pol.provider = n.provider
   where n.launch or n.poll),
per_space as (
  select s.space_id, s.agent_sessions, s.sessions_without_record, g.n as github_projects,
         coalesce(array_agg(v.provider order by v.ord) filter (where v.provider is not null), array[]::text[]) as used_providers,
         coalesce(array_agg(v.provider order by v.ord)
                    filter (where v.launch_reason is not null or v.poll_reason is not null), array[]::text[]) as missing
    from sessions s
    join gh_projects g on g.space_id = s.space_id
    left join verdict v on v.space_id = s.space_id
   group by s.space_id, s.agent_sessions, s.sessions_without_record, g.n)
select space_id,
       case when agent_sessions = 0 then 'idle' when cardinality(missing) = 0 then 'green' else 'red' end as state,
       used_providers, missing, agent_sessions, sessions_without_record, github_projects
  from per_space
 order by case when agent_sessions = 0 then 2 when cardinality(missing) = 0 then 1 else 0 end, space_id;

rollback;
