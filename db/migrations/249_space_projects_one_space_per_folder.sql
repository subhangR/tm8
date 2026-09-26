-- =============================================================================
-- 249 — one space per folder: the unique index W11 deferred (K13).
--
-- 234 made every NEW grant one-space-per-folder (the guard trigger) but could
-- not build the index: 7 folders on prod were granted to two spaces. Once the
-- K13 unlinks have removed the second grant (doc 01a0db2d), this builds it.
-- Additive: one index, no row is written.
--
-- Decision 29: a loopback single node writes internal.node_policy
-- project_folders = 'shared' at boot and may link one folder into several
-- spaces. The index must not exist there. So it is built only where the node
-- has recorded 'one_space' (an open node that has booted 234's server). On any
-- other node — 'shared', or no row yet — this file changes nothing and says so;
-- the guard trigger keeps enforcing new grants either way.
--
-- PREFLIGHT: on a 'one_space' node it REFUSES, naming every folder still
-- granted twice, and nothing is created. Unlink the extra grants first.
-- The DDL is 234's internal.space_project_unique_index_sql(), so the name and
-- shape cannot drift from what 234 recorded.
-- =============================================================================

do $$
declare
  policy text;
  doubled text;
begin
  select value into policy from internal.node_policy where key = 'project_folders';
  if policy is distinct from 'one_space' then
    raise notice '249: node policy project_folders is %, not one_space; space_projects_one_space_per_folder not built',
      coalesce(quote_literal(policy), 'unset');
    return;
  end if;

  if exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'space_projects_one_space_per_folder') then
    raise notice '249: space_projects_one_space_per_folder already exists; nothing to do';
    return;
  end if;

  select string_agg(format('%s %s (%s spaces: %s)', p.name, d.project_id, d.grants, d.spaces), '; ' order by p.name)
    into doubled
    from (select sp.project_id, count(*) as grants, string_agg(sp.space_id::text, ', ' order by sp.space_id) as spaces
            from public.space_projects sp
           group by sp.project_id
          having count(*) > 1) d
    join public.projects p on p.id = d.project_id;
  if doubled is not null then
    raise exception '249 refused: folders still granted to more than one space: %', doubled
      using errcode = '23505',
            hint = 'Unlink the extra grants (tm8 project unlink <project-id> --space <space-id>; K13 runbook in doc 01a0db2d), then re-run. Nothing was created.';
  end if;

  execute internal.space_project_unique_index_sql();
end
$$;
