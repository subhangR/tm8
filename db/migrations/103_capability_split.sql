-- =============================================================================
-- 103 — the capability split (2026-08-12).
--
-- 101 named nine capabilities and granted them; nothing used them. This
-- migration re-points every node-admin gate onto the narrowest one that fits,
-- and removes the transitional `is_node_admin` arm from `internal.has_capability`
-- so `account_capabilities` becomes the whole truth.
--
-- WHY THIS MATTERS, measured on the prod node: SEVEN of the EIGHT accounts hold
-- `is_node_admin`, and that one flag gates everything from "register a working
-- directory" to "reset any account's password". Any of those seven can take any
-- other account. The cause was the gate, not the grants — connecting a folder
-- required node admin, so granting node admin became the onboarding path.
--
-- SEVENTEEN functions, not eighteen. An earlier count said eighteen; it came
-- from a grep that also matched SUPERSEDED definitions and two space-admin
-- gates. Taking the LAST definition of each name — which is what actually runs
-- — gives seventeen. `update_space` and `delete_task_axis` are
-- `require_space_admin` and are deliberately not touched.
--
-- HOW THIS IS APPLIED, and why it is not seventeen rewritten function bodies.
-- Every one of the seventeen is a GUARD SWAP: one line changes and the body is
-- untouched. Re-declaring each function by hand would mean re-transcribing
-- seventeen signatures and bodies, and the first attempt at exactly that failed
-- on `revoke_account_sessions` — it returns `integer`, not `bigint`, and
-- Postgres refuses a return-type change on replace. That is a whole class of
-- silent drift (a mistyped default, a dropped `stable`, a lost `security
-- definer`) waiting to happen seventeen times.
--
-- So instead: read each function's CURRENT definition with `pg_get_functiondef`,
-- assert the guard is present, replace exactly that call, and execute the
-- result. Signatures, return types, volatility, `security definer` and
-- `search_path` are carried through by construction rather than by care, and
-- the reviewable artefact is the MAPPING TABLE below rather than 400 lines of
-- copied plpgsql.
--
-- Self-service is preserved exactly. `set_account_credential`,
-- `issue_auth_session` and `revoke_auth_session` each gate only the
-- act-on-someone-ELSE branch; changing your own password, logging in, and
-- logging yourself out still need no capability. Login depends on that.
-- =============================================================================
set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. `has_capability` stops implying from the flag.
--
-- `is_owner` still implies everything — a node has exactly one owner (002:63)
-- and it is the account of last resort. `is_node_admin` no longer implies
-- anything; the column survives one release before being dropped, so a rollback
-- is a one-line revert of this function rather than a data migration.
-- -----------------------------------------------------------------------------
create or replace function internal.has_capability(p_capability text) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.identity_id() is not null and exists (
    select 1 from public.accounts a
     where a.identity_id = internal.identity_id()
       and a.status = 'active'
       and (
         a.is_owner
         or exists (select 1 from public.account_capabilities c
                     where c.account_id = a.id and c.capability = p_capability)
       )
  )
$$;

-- -----------------------------------------------------------------------------
-- 2. THE MAPPING. This table is the reviewable artefact of this migration.
--
-- THE ONE JUDGEMENT CALL — the three project functions map to
-- `projects.register.any`, NOT to `projects.register`, even though the second
-- is the one every user already holds and the one meant to end the onboarding
-- problem. Ordering is why: `projects.register` is meant to mean "inside my own
-- home", and the containment trigger that makes it mean that has not been built
-- yet. Using it here would not narrow anything — it would WIDEN project
-- creation from seven accounts to all eight with no boundary to contain it. It
-- stays at `.any` until homes land.
-- -----------------------------------------------------------------------------
do $split$
declare
  mapping constant text[][] := array[
    -- account lifecycle — the four that can take the node
    ['ensure_account',                  'users.provision'],
    ['set_account_credential',          'users.credentials'],
    ['set_account_disabled',            'users.suspend'],
    ['revoke_account_sessions',         'users.suspend'],
    -- sessions: only the act-on-someone-else branch is gated in these bodies
    ['issue_auth_session',              'users.suspend'],
    ['revoke_auth_session',             'users.suspend'],
    -- node maintenance
    ['prune_auth_sessions',             'node.maintain'],
    ['sweep_file_upload_slots',         'node.maintain'],
    ['mark_file_upload_slots_purged',   'node.maintain'],
    ['purge_deleted_file_blobs',        'node.maintain'],
    ['live_agent_session_work_ids',     'node.maintain'],
    ['revoke_orphaned_agent_sessions',  'node.maintain'],
    -- local server connections
    ['create_server_connection',        'connections.manage'],
    ['delete_server_connection',        'connections.manage'],
    -- projects — see the judgement call above
    ['create_project',                  'projects.register.any'],
    ['update_project',                  'projects.register.any'],
    ['update_project_w2',               'projects.register.any']
  ];
  fn text;
  capability text;
  src text;
  patched text;
  n integer := 0;
begin
  for i in 1 .. array_length(mapping, 1) loop
    fn := mapping[i][1];
    capability := mapping[i][2];

    -- One definition per name is expected. If an overload ever appears, this
    -- migration must be re-derived rather than silently patch an arbitrary one.
    if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public' and p.proname = fn) <> 1 then
      raise exception 'public.% is not exactly one function — re-derive the mapping', fn;
    end if;

    select pg_get_functiondef(p.oid) into src
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = fn;

    -- Asserted, not assumed. If the guard is absent the mapping is stale, and
    -- continuing would leave exactly the hole this migration exists to close.
    if position('internal.require_node_admin()' in src) = 0 then
      raise exception 'public.% no longer calls require_node_admin() — re-derive the mapping', fn;
    end if;

    patched := replace(src, 'internal.require_node_admin()',
                            format('internal.require_capability(%L)', capability));
    execute patched;
    n := n + 1;
  end loop;

  if n <> 17 then
    raise exception 'expected to re-point 17 functions, re-pointed %', n;
  end if;
  raise notice 're-pointed % node-admin gates onto named capabilities', n;
end
$split$;

-- The one node-admin read policy left, moved to the matching capability.
drop policy if exists server_connections_node_admin_select on public.server_connections;
create policy server_connections_node_admin_select on public.server_connections
  for select using (internal.has_capability('connections.manage'));

-- -----------------------------------------------------------------------------
-- 3. Guard: nothing in `public` may still decide on node admin.
--
-- A migration that quietly missed a call site would leave exactly the hole this
-- file closes, so the check runs here rather than only in a test.
-- `internal.require_node_admin` itself survives — unused, and dropped alongside
-- the column next release, so a rollback stays cheap.
-- -----------------------------------------------------------------------------
do $verify$
declare leftover text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into leftover
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   -- prokind 'f' = a plain function. `pg_get_functiondef` throws on aggregates
   -- and window functions, and `public` contains some (array_agg et al).
   where ns.nspname = 'public' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) like '%require_node_admin()%';
  if leftover is not null then
    raise exception 'these public functions still gate on node admin: %', leftover;
  end if;

  -- And the flag must no longer be able to imply a capability.
  if (select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'internal' and p.proname = 'has_capability' and p.prokind = 'f')
     like '%is_node_admin%' then
    raise exception 'internal.has_capability still implies from is_node_admin';
  end if;
end
$verify$;

reset role;
