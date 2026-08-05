-- =============================================================================
-- 078 — per-user PRIVATE Projects: an owner column, a share mode, and the two
--       read predicates that must always agree about them.
--
-- THE PROBLEM. `public.projects` (001:246-259) is a NODE registry: a row has a
-- name, a workingDir and a trust grant, and no owner at all. Every write path
-- into it — `create_project` (007:755), `update_project` (007:781),
-- `update_project_w2` (021:214) — opens with `internal.require_node_admin()`.
-- So on a shared node an ordinary member cannot register the directory they
-- work out of, and if an admin registers it for them, `space_projects` +
-- `internal.materialize_project_projection` publish it to the WHOLE Space.
-- There is no third state. That is what this migration adds.
--
-- WHY NOT `visibility = 'restricted'`. It is the obvious-looking hook and it is
-- the wrong one. `restricted` means invisible to EVERYONE; the single carve-out
-- that makes a Project projection readable at all is `kind = 'project'` + an
-- active `space_projects` link, and that carve-out admits the row to the whole
-- Space by construction. Worse, 021 re-asserts `visibility = 'restricted'` on
-- the projection on EVERY relink (021:161-169), so any per-user value written
-- into that column is erased by the next `link/unlink` cycle. Privacy has to
-- live on the resource row, where the materializer never touches it.
--
-- THE SHAPE IS COPIED FROM `saved_views`, which already solved this exact
-- problem in this codebase: an owner column plus
-- `share_mode text check (share_mode in ('private','space'))`, read-enforced in
-- one RLS policy (008:163-168). The only difference is the owner's TYPE. A
-- saved view is Space-scoped, so it points at a `members.entity_id`. A Project
-- is a NODE resource that outlives and spans Spaces, so it points at
-- `accounts.id` — the node-level principal — via `owner_account_id`. Pointing a
-- node resource at a per-Space member row would mean the same human loses their
-- own project by leaving one Space.
--
-- ----------------------------------------------------------------------------
-- DECISION: A PRIVATE PROJECT IS INVISIBLE TO SPACE ADMINS. Stated plainly
-- because it is the one rule here somebody will want to relax later.
--
-- `share_mode = 'private'` is not a soft "unlisted" hint; it is the answer to
-- "may other people in this Space see the path I am working out of, the repo I
-- have checked out, and the sessions I spawn there". A Space admin administers
-- the SPACE — membership, invites, channels. Admin-over-a-container has never
-- implied read-over-its-members' private things in this schema, and the
-- precedent is explicit: `saved_views_select` gives a private view to its owner
-- and to nobody else, admins included, and `internal.can_act_as` (002:252)
-- states in its own comment that node-admin does NOT widen who you may speak
-- as. A privacy control with an admin bypass is a listing preference wearing a
-- privacy control's name, and users calibrate their behaviour to the name.
--
-- The ONE deliberate asymmetry, which is not an exception to the above: a NODE
-- admin still sees the private project's REGISTRY ROW through
-- `projects_select`. That is not a policy choice so much as an honest one — a
-- node admin administers `working_dir` and `trust` on this machine, holds the
-- filesystem those paths name, and revoking their registry read would hide the
-- row from the person who can already `ls` it. What they do NOT get is the
-- Space PROJECTION: the graph seam below has no node-admin branch, so a private
-- project never appears in anybody else's Space feed, graph or menu.
-- ----------------------------------------------------------------------------
--
-- THE TWO FUNCTIONS THAT MUST CHANGE TOGETHER. The `kind = 'project'` carve-out
-- is written out TWICE — `internal.entity_row_visible` (070, the `entities`
-- row policy) and `internal.entity_readable` (021:32-56, the satellite-read
-- predicate). Migration 070 exists ONLY because someone changed one of them and
-- not the other, and the failure mode was a projection that vanished from
-- direct reads while its counters and versions stayed readable. Both are
-- rewritten below, from the same text, in this file. The new
-- `w2-private-projects.pg.test.ts` asserts the two AGREE on the same row rather
-- than testing each alone, so the next person to edit one gets a red.
--
-- WRITE PATHS ARE NEW FUNCTIONS, NOT EDITS. 007 and 021 are applied migrations
-- and immutable; `db/migrate.mjs` checksums them. `create_owned_project` and
-- `update_owned_project` are therefore additions, and the node-admin paths they
-- sit beside are left exactly as they are.
--
-- WHAT THE NEW RPCs DO NOT DO. They do not validate `working_dir` against the
-- allowed root. That check is the server's (S11) and it holds the configuration
-- that says what the root IS; duplicating it here would produce two answers
-- that drift. What they DO enforce is the SHAPE the 001 CHECK already demands —
-- absolute, no `..` — as an early, typed error instead of a raw 23514.
--
-- Trust stays a node-admin grant. A member creating their own project may only
-- create it `untrusted`, and may not promote it later: S12 says trust is an
-- explicit grant and never a default, and "explicit" cannot mean "asserted by
-- the person who benefits".
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. The columns.
--
-- `owner_account_id` is NULLABLE and that is the compatibility story: every row
-- that exists today is node-owned/shared and stays that way. Only rows created
-- through the new RPCs carry an owner.
-- -----------------------------------------------------------------------------
alter table public.projects
  add column if not exists owner_account_id uuid references public.accounts(id);

-- Added nullable so the backfill below is a real, visible statement rather than
-- an implicit DEFAULT fill. Nothing currently visible may become invisible, so
-- existing rows are stated as 'space' explicitly, then the column is closed.
alter table public.projects add column if not exists share_mode text;

update public.projects set share_mode = 'space' where share_mode is null;

alter table public.projects alter column share_mode set default 'space';
alter table public.projects alter column share_mode set not null;

do $shape$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.projects'::regclass and conname = 'projects_share_mode_check'
  ) then
    alter table public.projects
      add constraint projects_share_mode_check check (share_mode in ('private','space'));
  end if;

  -- A private project with no owner would be invisible to literally everyone,
  -- including whoever made it, and would be unreachable through the owner-only
  -- write path below. The schema refuses to represent it.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.projects'::regclass and conname = 'projects_private_needs_owner'
  ) then
    alter table public.projects
      add constraint projects_private_needs_owner
      check (share_mode <> 'private' or owner_account_id is not null);
  end if;
end
$shape$;

create index if not exists projects_owner_account_idx
  on public.projects(owner_account_id) where owner_account_id is not null;

comment on column public.projects.owner_account_id is
  'Node-level principal that owns this Project (accounts.id). NULL = node-owned, '
  'the pre-078 shape. Deliberately an account and not a member: a Project spans '
  'Spaces, so its owner must survive leaving one.';
comment on column public.projects.share_mode is
  'private = visible only to owner_account_id, Space admins included (078). '
  'space = the pre-078 behaviour: visible to every member of every linked Space.';

-- -----------------------------------------------------------------------------
-- 2. The caller's account, resolved from the ONE claim with authority.
--
-- `internal.account_id()` (001:161) reads the `tm8.account_id` CLAIM, and 002's
-- header is explicit that only `tm8.identity_id` is trusted — the rest are a
-- server-side fast path that a buggy or hostile caller could set. An
-- authorization predicate may not read a claim it cannot verify, so this
-- resolves through `public.accounts` instead, exactly as
-- `internal.is_authenticated` and `internal.require_node_admin` do.
--
-- SECURITY DEFINER because `accounts` carries RLS with ZERO policies (008 §2):
-- evaluated as `tm8_app` this would see no rows and return NULL for everybody,
-- which fails in the reassuring direction — every private project would look
-- like somebody else's.
-- -----------------------------------------------------------------------------
create or replace function internal.current_account_id() returns uuid
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select a.id from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active'
$$;

revoke all on function internal.current_account_id() from public;
grant execute on function internal.current_account_id() to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. The read seam — BOTH predicates, same carve-out, one file.
--
-- Read `internal.entity_readable` and `internal.entity_row_visible` below as a
-- pair. The project branch is byte-identical between them apart from the two
-- differences 070 already documented: `entity_row_visible` takes the row's
-- columns as arguments (the policy already holds the row) and does not filter
-- tombstones (tombstone presentation belongs to the handlers).
--
-- The added conjunct is the whole feature:
--
--     resource.share_mode = 'space'
--     or resource.owner_account_id = internal.current_account_id()
--
-- NULL BEHAVIOUR IS LOAD-BEARING and fails closed. For an unauthenticated or
-- account-less caller `current_account_id()` is NULL, so the equality is NULL,
-- so the OR falls through to `share_mode = 'space'` — never to true. There is
-- no `is not distinct from` here on purpose: that spelling would make a private
-- project with a NULL owner readable by every account-less caller. The
-- `projects_private_needs_owner` CHECK above means such a row cannot exist, and
-- this expression means it would not help if it did.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_readable(target uuid) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select exists (
    select 1 from public.entities entity_row
     where entity_row.id = target
       and entity_row.deleted_at is null
       and internal.is_space_member(entity_row.space_id)
       and (
         entity_row.visibility = 'space'
         or (
           entity_row.visibility = 'restricted'
           and entity_row.kind = 'project'
           and exists (
             select 1
               from public.project_links link
               join public.space_projects active_link
                 on active_link.space_id = link.space_id
                and active_link.project_id = link.project_id
               join public.projects resource
                 on resource.id = link.project_id
              where link.project_entity_id = entity_row.id
                and link.space_id = entity_row.space_id
                and (
                  resource.share_mode = 'space'
                  or resource.owner_account_id = internal.current_account_id()
                )
           )
         )
       )
  )
$$;

create or replace function internal.entity_row_visible(
  p_id uuid, p_space_id uuid, p_kind text, p_visibility text
) returns boolean
language sql stable security definer set search_path = public, internal, pg_temp as $$
  select internal.is_space_member(p_space_id) and (
    p_visibility = 'space'
    or (
      p_visibility = 'restricted'
      and p_kind = 'project'
      and exists (
        select 1
          from public.project_links link
          join public.space_projects active_link
            on active_link.space_id = link.space_id
           and active_link.project_id = link.project_id
          join public.projects resource
            on resource.id = link.project_id
         where link.project_entity_id = p_id
           and link.space_id = p_space_id
           and (
             resource.share_mode = 'space'
             or resource.owner_account_id = internal.current_account_id()
           )
      )
    )
  )
$$;

revoke all on function internal.entity_row_visible(uuid, uuid, text, text) from public;
grant execute on function internal.entity_row_visible(uuid, uuid, text, text) to tm8_app;
grant execute on function internal.entity_readable(uuid) to tm8_app;

-- -----------------------------------------------------------------------------
-- 4. The registry row itself.
--
-- Hiding the PROJECTION while leaving `projects_select` (008:178-182) wide open
-- would be theatre: that policy hands every member of every linked Space the
-- row's `name`, `repo_url` and `working_dir`, which is most of what "private"
-- was supposed to protect. The rewrite keeps 008's two original branches
-- verbatim and adds the share test to the member branch, plus one new branch so
-- an owner can see a project they have not linked to any Space yet — otherwise
-- `create_owned_project` would return a row its own author cannot read back.
--
-- The node-admin branch is unchanged; see the DECISION block in the header for
-- why that is the deliberate limit of this feature and not an oversight.
-- -----------------------------------------------------------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to tm8_app
  using (
    internal.is_node_admin()
    or owner_account_id = internal.current_account_id()
    or (
      (share_mode = 'space' or owner_account_id = internal.current_account_id())
      and exists (
        select 1 from public.space_projects sp
         where sp.project_id = projects.id
           and internal.is_space_member(sp.space_id)
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Creation, for a principal who is not a node admin.
--
-- The node-admin path (`public.create_project`, 007:755) is untouched and stays
-- unrestricted. This one is the member path, and every relaxation it makes is
-- paid for by a narrowing:
--
--   * a non-admin may create ONLY `share_mode = 'private'` — publishing to a
--     Space is still a Space-admin act, via link_project_w2;
--   * a non-admin may create ONLY in their own name — `p_owner_account_id`
--     naming anyone else is 42501, not a silent substitution, because a silent
--     substitution would let a caller believe they had shared something;
--   * a non-admin may create ONLY `untrusted` (S12).
--
-- `p_space_id` is optional but is the normal call: an unlinked private project
-- has no projection and therefore no presence in the graph at all. Linking here
-- rather than through `link_project_w2` is what makes the member path work —
-- that RPC requires `require_space_admin`, and requiring an admin to publish
-- your private project to you would defeat the point. It is safe precisely
-- BECAUSE the project is private: the link creates a projection only its owner
-- can see. The `space_projects` insert triggers (015) do the materialization,
-- the 16-link cap and the `active_link_count` bookkeeping.
-- -----------------------------------------------------------------------------
create or replace function public.create_owned_project(
  p_name text,
  p_working_dir text,
  p_repo_url text default null,
  p_trust text default 'untrusted',
  p_defaults jsonb default '{}'::jsonb,
  p_share_mode text default 'private',
  p_owner_account_id uuid default null,
  p_space_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  caller_account uuid;
  caller_is_node_admin boolean := false;
  share text := coalesce(p_share_mode, 'private');
  trust_level text := coalesce(p_trust, 'untrusted');
  owner_account uuid;
  project public.projects;
  created_id uuid;
  actor uuid;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.create');
  if replay is not null then return replay; end if;
  perform internal.require_identity();

  select a.id, (a.is_node_admin or a.is_owner)
    into caller_account, caller_is_node_admin
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active';
  if caller_account is null then
    raise exception 'no active account for this identity' using errcode = '42501';
  end if;

  if share not in ('private','space') then
    raise exception 'invalid share mode' using errcode = '22023';
  end if;
  if trust_level not in ('trusted','untrusted') then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;

  -- A private project defaults to the caller; a shared one defaults to nobody,
  -- which is the pre-078 node-owned shape.
  owner_account := coalesce(
    p_owner_account_id,
    case when share = 'private' then caller_account else null end
  );

  if not caller_is_node_admin then
    if share <> 'private' then
      raise exception 'only a node admin may register a shared Project'
        using errcode = '42501', detail = 'project_share_mode_forbidden';
    end if;
    if owner_account is distinct from caller_account then
      raise exception 'a Project may only be created in the caller''s own name'
        using errcode = '42501', detail = 'project_owner_forbidden';
    end if;
    if trust_level <> 'untrusted' then
      raise exception 'trust is a node-admin grant, never self-asserted'
        using errcode = '42501', detail = 'project_trust_forbidden';
    end if;
  end if;

  -- Shape only. Which roots are allowed is the server's question (S11).
  if p_working_dir is null or p_working_dir not like '/%' or p_working_dir like '%..%' then
    raise exception 'workingDir must be an absolute path with no parent-directory segments'
      using errcode = '22023', detail = 'project_working_dir_shape';
  end if;

  insert into public.projects(
    name, working_dir, repo_url, trust, defaults, owner_account_id, share_mode
  ) values (
    p_name, p_working_dir, p_repo_url, trust_level,
    coalesce(p_defaults, '{}'::jsonb), owner_account, share
  )
  returning * into project;
  created_id := project.id;

  if p_space_id is not null then
    perform internal.require_space_member(p_space_id);
    actor := internal.current_member_id(p_space_id);
    if actor is null then
      raise exception 'no actor available in this space' using errcode = '42501';
    end if;
    perform internal.bind_actor(actor);
    perform 1 from public.spaces where id = p_space_id for update;
    insert into public.space_projects(space_id, project_id, linked_by)
    values (p_space_id, created_id, actor)
    on conflict (space_id, project_id) do nothing;
    -- The 015 link triggers advance active_link_count on this row; re-read so
    -- the returned envelope is the row as it now stands, not as it was inserted.
    select * into project from public.projects where id = created_id;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'projects.create',
    jsonb_build_object(
      'project', to_jsonb(project),
      'spaceId', p_space_id,
      'patches', '[]'::jsonb
    ));
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Editing, by the owner.
--
-- `update_project_w2` (021:214) keeps the node-admin path and is untouched; the
-- patch grammar here is deliberately its grammar plus `shareMode`, so a caller
-- can be routed to either function without reshaping the patch.
--
-- Authority is OWNERSHIP, not membership and not admin: `owner_account_id` must
-- be the caller's account. A node admin who is not the owner is refused HERE
-- and uses `update_project_w2` instead — one function, one authority model,
-- rather than a function whose meaning depends on who is calling it.
--
-- `shareMode` is patchable because publishing your own project to your Space,
-- and withdrawing it again, is the owner's call. It cannot be used to hide a
-- node-owned project from a Space: those rows have a NULL owner, so they never
-- pass the authority check above.
-- -----------------------------------------------------------------------------
create or replace function public.update_owned_project(
  p_project_id uuid, p_patch jsonb, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  patch jsonb := coalesce(p_patch, '{}'::jsonb);
  caller_account uuid;
  caller_is_node_admin boolean := false;
  project public.projects;
  next_name text;
  next_working_dir text;
  next_repo_url text;
  next_trust text;
  next_defaults jsonb;
  next_share text;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'projects.update');
  if replay is not null then return replay; end if;
  perform internal.require_identity();

  select a.id, (a.is_node_admin or a.is_owner)
    into caller_account, caller_is_node_admin
    from public.accounts a
   where a.identity_id = internal.identity_id() and a.status = 'active';
  if caller_account is null then
    raise exception 'no active account for this identity' using errcode = '42501';
  end if;

  if jsonb_typeof(patch) <> 'object'
     or patch - array['name','workingDir','repoUrl','trust','defaults','shareMode']::text[]
        <> '{}'::jsonb then
    raise exception 'invalid Project update patch' using errcode = '22023';
  end if;

  select * into project from public.projects where id = p_project_id for update;
  if project.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  -- Not-found and not-yours are the same answer on purpose for a PRIVATE
  -- project: a distinguishable 42501 would confirm the row exists to someone
  -- who is not allowed to know that.
  if project.owner_account_id is null or project.owner_account_id <> caller_account then
    if project.share_mode = 'private' then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
    raise exception 'not the owner of this Project'
      using errcode = '42501', detail = 'project_owner_required';
  end if;
  if project.link_frozen then
    raise exception 'Project is frozen above the active-link cap'
      using errcode = '53400', detail = 'project_over_cap';
  end if;

  if patch ? 'name' and jsonb_typeof(patch->'name') <> 'string' then
    raise exception 'name must be a string' using errcode = '22023';
  end if;
  if patch ? 'workingDir' and jsonb_typeof(patch->'workingDir') <> 'string' then
    raise exception 'workingDir must be a string' using errcode = '22023';
  end if;
  if patch ? 'repoUrl' and jsonb_typeof(patch->'repoUrl') not in ('string','null') then
    raise exception 'repoUrl must be a string or null' using errcode = '22023';
  end if;
  if patch ? 'trust' and (jsonb_typeof(patch->'trust') <> 'string'
      or patch->>'trust' not in ('trusted','untrusted')) then
    raise exception 'invalid trust level' using errcode = '22023';
  end if;
  if patch ? 'defaults' and jsonb_typeof(patch->'defaults') <> 'object' then
    raise exception 'defaults must be an object' using errcode = '22023';
  end if;
  if patch ? 'shareMode' and (jsonb_typeof(patch->'shareMode') <> 'string'
      or patch->>'shareMode' not in ('private','space')) then
    raise exception 'invalid share mode' using errcode = '22023';
  end if;

  next_name := case when patch ? 'name' then patch->>'name' else project.name end;
  next_working_dir := case when patch ? 'workingDir' then patch->>'workingDir' else project.working_dir end;
  next_repo_url := case when patch ? 'repoUrl' then patch->>'repoUrl' else project.repo_url end;
  next_trust := case when patch ? 'trust' then patch->>'trust' else project.trust end;
  next_defaults := case when patch ? 'defaults' then patch->'defaults' else project.defaults end;
  next_share := case when patch ? 'shareMode' then patch->>'shareMode' else project.share_mode end;

  if next_trust = 'trusted' and project.trust <> 'trusted' and not caller_is_node_admin then
    raise exception 'trust is a node-admin grant, never self-asserted'
      using errcode = '42501', detail = 'project_trust_forbidden';
  end if;
  if next_working_dir is null or next_working_dir not like '/%' or next_working_dir like '%..%' then
    raise exception 'workingDir must be an absolute path with no parent-directory segments'
      using errcode = '22023', detail = 'project_working_dir_shape';
  end if;

  update public.projects
     set name = next_name,
         working_dir = next_working_dir,
         repo_url = next_repo_url,
         trust = next_trust,
         defaults = next_defaults,
         share_mode = next_share
   where id = p_project_id
     and (name, working_dir, repo_url, trust, defaults, share_mode)
       is distinct from (next_name, next_working_dir, next_repo_url, next_trust,
                         next_defaults, next_share)
  returning * into project;
  if project.id is null then
    select * into project from public.projects where id = p_project_id;
  end if;

  return internal.ledger_record(p_client_mutation_id, 'projects.update',
    jsonb_build_object('project', to_jsonb(project), 'patches', '[]'::jsonb));
end
$$;

-- 008 granted EXECUTE on everything in `public` that existed AT THAT MOMENT and
-- deliberately left default privileges alone, so a function added later is not
-- covered — and, worse, carries Postgres's default EXECUTE to PUBLIC. Both new
-- RPCs are SECURITY DEFINER, so that default is closed explicitly before the
-- one intended grant is made.
revoke all on function public.create_owned_project(
  text, text, text, text, jsonb, text, uuid, uuid, text) from public;
revoke all on function public.update_owned_project(uuid, jsonb, text) from public;
grant execute on function public.create_owned_project(
  text, text, text, text, jsonb, text, uuid, uuid, text) to tm8_app;
grant execute on function public.update_owned_project(uuid, jsonb, text) to tm8_app;

comment on function public.create_owned_project(
  text, text, text, text, jsonb, text, uuid, uuid, text) is
  'Member-path Project registration (078). A non-admin may create only a '
  'private, untrusted Project owned by their own account; node admins are '
  'unrestricted here and keep public.create_project as well.';
comment on function public.update_owned_project(uuid, jsonb, text) is
  'Owner-path Project edit (078). Authority is owner_account_id = the caller''s '
  'account; node admins who are not the owner use public.update_project_w2.';

reset role;
