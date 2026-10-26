-- =============================================================================
-- 365 — row-level security on the four workflow tables.
--
-- WHAT WAS WRONG
--   132 (`task_workflows`) and 149 (`workflows`, `workflow_states`,
--   `workflow_transitions`) granted SELECT to tm8_app but never enabled RLS,
--   breaking 008's "every table, no exceptions" rule. So any tm8_app caller —
--   a member of space A, a stranger, or a request that forgot to bind
--   `tm8.identity_id` — read every space's workflow names, state names and
--   transition conditions. Checked on a fresh database before this migration:
--
--     set role tm8_app;                       -- no identity claim at all
--     select count(*) from public.workflows;  -- every space's rows
--
-- THE POLICIES (read-only; writes stay SECURITY DEFINER RPCs, unchanged)
--   workflows             the built-in default (space_id NULL) is reference
--                         data for any authenticated identity, exactly like a
--                         core `entity_kinds` row; a space's own workflows are
--                         visible to its members. Same predicate shape as
--                         `entity_kinds_select` after 218.
--   workflow_states,
--   workflow_transitions  readable iff their workflow is. The sub-select runs
--                         as the caller, so `workflows_select` filters it and
--                         the rule lives in one place (218's readable_entity
--                         pattern). `workflow_id` is the leading column of a
--                         unique key on both, so each probe is a pkey lookup.
--   task_workflows        visible to members of its space. Superseded by
--                         `workflows` in 149 but still granted, so still fenced.
--
-- WHY NOTHING ELSE BREAKS
--   Every function that reads these tables (132/149/150/151/152) is either a
--   SECURITY DEFINER RPC or an internal helper reached from one, or from a
--   trigger fired by one; both run as tm8_graph_owner, the table owner, which
--   RLS does not apply to (no FORCE here, matching 008). A direct tm8_app read
--   now sees its own spaces plus the built-in default, which is everything a
--   correctly-bound caller could legitimately have asked for.
-- =============================================================================

set role tm8_graph_owner;

alter table public.workflows            enable row level security;
alter table public.workflow_states      enable row level security;
alter table public.workflow_transitions enable row level security;
alter table public.task_workflows       enable row level security;

create policy workflows_select on public.workflows for select to tm8_app
  using (((space_id is null) and (internal.identity_id() is not null))
         or (space_id = any ((select internal.member_space_ids())::uuid[])));

create policy workflow_states_select on public.workflow_states for select to tm8_app
  using (exists (select 1 from public.workflows readable_workflow
                  where readable_workflow.id = workflow_states.workflow_id));

create policy workflow_transitions_select on public.workflow_transitions for select to tm8_app
  using (exists (select 1 from public.workflows readable_workflow
                  where readable_workflow.id = workflow_transitions.workflow_id));

create policy task_workflows_select on public.task_workflows for select to tm8_app
  using (space_id = any ((select internal.member_space_ids())::uuid[]));

-- VERIFY: fail the migration rather than ship a table that is readable and
-- unfenced. Catches a future edit that drops one of the lines above.
do $verify$
declare missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into missing
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('workflows', 'workflow_states', 'workflow_transitions', 'task_workflows')
     and (not c.relrowsecurity
          or not exists (select 1 from pg_policy p where p.polrelid = c.oid));
  if missing is not null then
    raise exception '365: workflow tables without RLS or a policy: %', missing;
  end if;
end
$verify$;

reset role;
