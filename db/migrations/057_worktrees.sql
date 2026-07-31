-- =============================================================================
-- 057 — Worktrees: the `worktree` core entity kind, its detail table, the
-- operational allocation table, the `in_worktree` edge registry row, and the
-- two doors (create_worktree / update_worktree).
--
-- Design: docs/plans/TM8-WORKTREE-DESIGN.md. Shared prerequisites already
-- landed in 052 (edge-guard multi-kind: the `in_worktree` props.origin
-- stamping line and the `worktree_manager` writer token) — NOTHING from 052 is
-- re-declared here. `internal.guard_w1_edge` is not touched by this file.
--
-- ⚠ SHARED-OBJECT NOTICE (the 052/053/055/056 rule, continued).
-- §5 below does `create or replace function internal.entity_content`. That
-- swaps the ENTIRE body, so the lexically-later migration silently wins and
-- every earlier feature's `when` arm vanishes with no error. The base text
-- here is copied verbatim from 056 (the latest definition at the time of
-- writing: 001 → 005 → 011 → 015 → 017 → 053 → 055 → 056), plus one arm.
-- WHOEVER WRITES THE NEXT ARM MUST COPY THIS FILE'S BODY, NOT AN EARLIER
-- ONE'S, or `worktree` content hydration disappears. Verify with
-- pg_get_functiondef against a scratch chain, never by reading the migration
-- that introduced the function.
--
-- Two state machines, two tables, deliberately (design §3):
--   * public.worktrees — SEMANTIC lifecycle (active→merged|abandoned→deleted).
--     Entity-backed, versioned: it HAS the snapshot trigger, so one semantic
--     transition = exactly one entities.version bump = staleness signals fire.
--   * public.worktree_allocations — OPERATIONAL disk truth (preparing/ready/
--     cleanup_pending/missing/failed + the session lease). NOT entity-backed,
--     and it has NO snapshot trigger — a write here is mechanically incapable
--     of bumping entities.version, which is the structural guarantee the
--     memories lane depends on (MEMO-WORKTREE-SEAM-ANSWERS.md W3).
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    seeding a new core kind is an ordinary insert — and a ONE-WAY DOOR.
--    The TypeScript twin (CoreEntityKind in packages/contract/src/contract.ts)
--    lands in the same change, or EntityKindDriftError kills the projector lane.
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('worktree', 'core', null, 'git-branch')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Semantic detail table.
--
--    Column names `entity_id` and `updated_at` are LOAD-BEARING:
--    internal.snapshot_entity_version() reads new.entity_id / new.updated_at
--    unqualified (001:1130) and raises at runtime, not migration time, if
--    either is renamed.
--
--    project_id is `on delete restrict`, deliberately unlike
--    work_sessions.project_id (`set null`): a worktree without a project is
--    meaningless — it is a checkout OF something.
--
--    base_commit_oid is the reproducibility anchor: refs move, a resolved OID
--    does not. Immutability of path/branch/base_ref/base_commit_oid/project_id
--    is enforced by the update door accepting none of them (design §2.5) plus
--    the absence of any UPDATE grant on this table.
--
--    No head_commit_oid / tree_digest / dirty columns: those are point-in-time
--    samples of a checkout, not properties of an allocation; storing them
--    guarantees they are stale. Consumers sample Git when they need them.
--
--    unique(path) + unique(project_id, branch): a collision is a 23505, never
--    a silent reuse of someone else's checkout.
-- -----------------------------------------------------------------------------
create table public.worktrees (
  entity_id         uuid primary key references public.entities(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete restrict,
  path              text not null check (path like '/%' and path not like '%..%'),
  branch            text not null check (char_length(btrim(branch)) between 1 and 255),
  base_ref          text not null,
  base_commit_oid   text not null check (base_commit_oid ~ '^[0-9a-f]{40}$'),
  status            text not null default 'active'
                      check (status in ('active','merged','abandoned','deleted')),
  status_changed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (path),
  unique (project_id, branch)
);

create trigger worktrees_validate_kind
before insert or update of entity_id on public.worktrees
for each row execute function internal.validate_detail_envelope('worktree');

create trigger worktrees_touch_updated_at before update on public.worktrees
for each row execute function internal.touch_updated_at();

-- Ship-blocker 1 (design §2.4): without this trigger a merge transition writes
-- the detail row, entities.version stays put, no pinned memory drifts, no
-- badge fires — silence in the reassuring direction. Note it DEBOUNCES
-- (001:1156): active→merged→deleted inside 5 minutes under one actor produces
-- two version bumps and ONE snapshot row. Compression, not data loss.
create trigger worktrees_snapshot_version after update on public.worktrees
for each row execute function internal.snapshot_entity_version();

-- R29 single-writer guard (design §2.6, modelled on work_sessions_guard_status,
-- 001:730). Three writers plausibly exist (agent/CLI recording a merge, the
-- delete path, startup reconciliation), so `status` gets exactly one door.
create or replace function internal.guard_worktree_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.status is distinct from old.status
     and coalesce(internal.claim_text('tm8.worktree_transition'), '') <> 'on' then
    raise exception 'worktree.status has a single writer: the worktree transition door'
      using errcode = '23514',
            detail = 'call public.update_worktree(...) — R29';
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end
$$;
create trigger worktrees_guard_status before update of status on public.worktrees
for each row execute function internal.guard_worktree_status();

-- -----------------------------------------------------------------------------
-- 3. Operational allocation table. NOT entity-backed, NO snapshot trigger —
--    that absence is the point (see the header). Disk-health flap must be
--    mechanically incapable of drifting a pinned memory.
--
--    ⚠ worktree_entity_id carries NO foreign key to public.entities, on
--    purpose, and this is a deliberate deviation from the design's §3.2 DDL
--    sketch: the provisioning saga (design §4.4–§4.7) generates the worktree
--    id and RESERVES this row (state='preparing') in its own transaction
--    BEFORE `git worktree add` runs and BEFORE the entity row exists — §6.2
--    explicitly reconciles "allocation row, Git entry, NO DB entity". An FK
--    would make the reservation step impossible. Orphaned rows are the
--    reconciler's to clean, exactly like orphaned directories.
-- -----------------------------------------------------------------------------
create table public.worktree_allocations (
  worktree_entity_id uuid primary key,
  node_id            text not null,
  state              text not null default 'preparing'
                       check (state in ('preparing','ready','cleanup_pending','missing','failed')),
  lease_session_id   uuid references public.entities(id) on delete set null,
  lease_acquired_at  timestamptz,
  preflight_token    text,
  preflight_at       timestamptz,
  failure_code       text,
  failure_detail     jsonb not null default '{}'::jsonb,
  attempts           integer not null default 0 check (attempts >= 0),
  last_reconciled_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One write-capable live-session lease per physical worktree; reuse of a
-- leased worktree is refused (limit_exceeded), never queued (design §3.4).
create unique index worktree_allocations_lease_idx
  on public.worktree_allocations(lease_session_id) where lease_session_id is not null;

create trigger worktree_allocations_touch_updated_at before update on public.worktree_allocations
for each row execute function internal.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Edge registry: the mutable association. It carries its OWN props_schema
--    because 018's bulk sweep has already run and will not cover a later row
--    (a NULL schema would mean no props validation at all).
--
--    `in_worktree` is deliberately NOT recorder-owned (052 keeps it out of
--    that branch — filing errors stay correctable through generic
--    edges.create/edges.delete), but it IS origin-stamped (052 added it to
--    the stamping list), so a spawn-created association is distinguishable
--    from a hand-drawn one. `memory` is deliberately NOT a src_kind: memories
--    reach a worktree through `based_on`, a pinned epistemic edge.
--    No unique index: several sessions may legitimately read one worktree.
-- -----------------------------------------------------------------------------
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema) values
  ('in_worktree',
   array['task','work_session','pull_request','commit'],
   array['worktree'],
   'Space-local association to a live Worktree',
   false,
   jsonb_build_object('type','object',
     'properties', jsonb_build_object('origin', jsonb_build_object('type','string')),
     'additionalProperties', true))
on conflict (type) do nothing;

-- -----------------------------------------------------------------------------
-- 5. Content hydration. See the SHARED-OBJECT NOTICE at the top of this file
--    before replacing this function again.
--    Body: 056's, verbatim, plus the `worktree` arm.
-- -----------------------------------------------------------------------------
create or replace function internal.entity_content(target uuid)
returns jsonb language plpgsql stable set search_path = public, internal, pg_temp as $$
declare e public.entities; content jsonb;
begin
  select * into e from public.entities where id = target;
  if e.id is null then return null; end if;
  if e.kind like 'c:%' then
    select jsonb_build_object('title', c.title, 'fields', c.fields) into content
      from public.custom_entities c where c.entity_id = target;
  else
    case e.kind
      when 'task' then select to_jsonb(t) - 'entity_id' into content from public.tasks t where t.entity_id = target;
      when 'doc' then select to_jsonb(d) - 'entity_id' into content from public.documents d where d.entity_id = target;
      when 'spell' then select to_jsonb(s) - 'entity_id' into content from public.spells s where s.entity_id = target;
      when 'skill' then select to_jsonb(s) - 'entity_id' into content from public.skills s where s.entity_id = target;
      when 'team_member' then select to_jsonb(t) - 'entity_id' into content from public.team_members t where t.entity_id = target;
      when 'collection' then select to_jsonb(c) - 'entity_id' into content from public.collections c where c.entity_id = target;
      when 'channel' then select to_jsonb(c) - 'entity_id' into content from public.channels c where c.entity_id = target;
      when 'voice_channel' then select to_jsonb(v) - 'entity_id' into content from public.voice_channels v where v.entity_id = target;
      when 'artifact' then select to_jsonb(a) - 'entity_id' into content from public.artifacts a where a.entity_id = target;
      when 'memory' then select to_jsonb(m) - 'entity_id' into content from public.memories m where m.entity_id = target;
      when 'worktree' then select to_jsonb(w) - 'entity_id' into content from public.worktrees w where w.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Create door. Ledger label `execution.spawn`, NOT `entities.create`
--    (design §2.7): there is no client-reachable path that creates a worktree
--    entity — `worktree` is excluded from the createEntity dispatch and from
--    CreateEntityInput.kind, and the only caller of this function is the
--    server's own provisioning saga. Replay binding is the 036 create shape
--    ({entity,space_id} against p_space_id) because a create names a space.
--
--    Paths and branches are SERVER-COMPUTED by the WorktreeManager before this
--    door is called (S11, design §4.4); this function validates shape, it does
--    not trust provenance — the table CHECKs are the last line, not the first.
--
--    ⚠ Locking discipline (design §5.1): internal.ledger_replay is the FIRST
--    statement here and takes an advisory lock on the mutation id. The
--    per-project Git lock must therefore be taken OUTSIDE and BEFORE this
--    ledgered transaction, in the node's WorktreeManager — nesting it beneath
--    the replay lock is the documented deadlock pattern (036:100, 032:123).
-- -----------------------------------------------------------------------------
create or replace function public.create_worktree(
  p_space_id uuid, p_project_id uuid, p_path text, p_branch text,
  p_base_ref text, p_base_commit_oid text, p_actor_id uuid default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  actor uuid;
  worktree_id uuid;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.spawn');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,space_id}', p_space_id::text, 'space');
    return replay;
  end if;
  perform internal.require_space_member(p_space_id);
  actor := internal.resolve_actor(p_actor_id, p_space_id);
  perform internal.bind_actor(actor);
  -- Admission mirrors the spawn RPC (048:67): a worktree is only creatable
  -- against a project actively linked to this space.
  if not exists (select 1 from public.space_projects
                  where space_id = p_space_id and project_id = p_project_id) then
    raise exception 'project is not linked to this space' using errcode = '42501';
  end if;
  worktree_id := internal.create_envelope(p_space_id, 'worktree', actor, null, null);
  insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid)
  values (worktree_id, p_project_id, p_path, btrim(p_branch), p_base_ref, lower(p_base_commit_oid));
  perform internal.record_initial_version(worktree_id, actor);
  activity_id := internal.record_activity(p_space_id, worktree_id, actor, 'created',
                   null, jsonb_build_object('kind', 'worktree', 'branch', btrim(p_branch)));
  return internal.ledger_record(p_client_mutation_id, 'execution.spawn',
           internal.command_result(worktree_id, null, activity_id, array[worktree_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 7. Transition door — ship-blocker 2 (design §2.5). The twelfth door on the
--    `entities.patch` ledger label, carrying the 038 binding shape
--    ({entity,id} against its own first argument) rather than inheriting the
--    pre-036 gap.
--
--    The door accepts exactly a status transition (+ expectedVersion + an
--    optional preflight token). path/branch/base_ref/base_commit_oid/
--    project_id are immutable after creation — the TypeScript patch arm
--    refuses them by name with invalid_input, never a silent drop, and this
--    function simply has no parameters for them.
--
--    Forward-only, mirroring work_session_transition (043:105): `active` is
--    never a legal target, `deleted` is terminal, self-transitions are
--    idempotent no-ops (recorded in the ledger, no version bump).
--
--    The preflight token closes the TOCTOU window between the Git dirty/
--    unpushed preflight (a node-side read; SQL cannot run Git) and this
--    commit: a transition to 'deleted' while a READY allocation exists
--    requires a fresh matching token minted by the WorktreeManager and
--    written to the allocation row. Design §5.4 records the cost honestly:
--    this is the only patch door whose arm performs I/O around the RPC.
--
--    The detail-table UPDATE is the ONLY write; entities.version is bumped by
--    the snapshot trigger, exactly once. This function must never touch
--    public.entities.version directly.
-- -----------------------------------------------------------------------------
create or replace function public.update_worktree(
  p_entity_id uuid, p_expected_version integer, p_status text,
  p_actor_id uuid default null, p_client_mutation_id text default null,
  p_preflight_token text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  actor uuid;
  current_status text;
  alloc public.worktree_allocations;
  allowed boolean;
  activity_id uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'entities.patch');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'worktree');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_status not in ('merged','abandoned','deleted') then
    -- 'active' lands here too: it is never a legal target.
    raise exception 'invalid worktree status target: %', p_status using errcode = '22023';
  end if;

  select status into current_status from public.worktrees
   where entity_id = p_entity_id for update;
  allowed := case
    when current_status = p_status then true            -- idempotent no-op
    when current_status = 'deleted' then false          -- terminal
    when current_status = 'active' then true            -- active → any target
    when p_status = 'deleted' then true                 -- merged|abandoned → deleted
    else false end;                                     -- merged ↔ abandoned
  if not allowed then
    raise exception 'illegal worktree transition % -> %', current_status, p_status
      using errcode = '23514';
  end if;

  if current_status = p_status then
    -- No write, no version bump, but the command is still ledgered so the
    -- client's retry story stays uniform.
    return internal.ledger_record(p_client_mutation_id, 'entities.patch',
             internal.command_result(p_entity_id, null, null, array[p_entity_id]));
  end if;

  -- TOCTOU gate: 'deleted' claims the working directory has been removed, so
  -- while a READY allocation exists on disk the caller must present a fresh
  -- preflight token (minted by the node after its dirty/unpushed checks).
  if p_status = 'deleted' then
    select * into alloc from public.worktree_allocations
     where worktree_entity_id = p_entity_id for update;
    if found and alloc.state = 'ready' then
      if alloc.lease_session_id is not null then
        raise exception 'worktree is leased by a live session' using errcode = '53400',
          detail = 'worktree_leased';
      end if;
      if p_preflight_token is null or alloc.preflight_token is null
         or alloc.preflight_token <> p_preflight_token
         or alloc.preflight_at is null
         or alloc.preflight_at < now() - interval '60 seconds' then
        raise exception 'worktree delete requires a fresh preflight' using errcode = '23514',
          detail = 'stale_preflight';
      end if;
    end if;
  end if;

  perform set_config('tm8.worktree_transition', 'on', true);
  update public.worktrees set status = p_status where entity_id = p_entity_id;
  perform set_config('tm8.worktree_transition', 'off', true);

  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'worktree', 'status', p_status));
  return internal.ledger_record(p_client_mutation_id, 'entities.patch',
           internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 8. RLS + grants. Failing closed is the point (008:250): a new table is
--    unreadable until this file says otherwise. SELECT only — the doors are
--    the write surface; there is no INSERT/UPDATE/DELETE grant on either
--    table to anyone. Allocation writes belong to the provisioning saga and
--    reconciler, which arrive with their own (security definer) surface in
--    the spawn-integration phase; until then the table is owner-writable only.
--    An allocation row in its pre-entity window (reservation before creation)
--    has no entity, so entity_readable() is false and the row is invisible —
--    correct: there is nothing yet for a client to see.
-- -----------------------------------------------------------------------------
alter table public.worktrees enable row level security;
alter table public.worktree_allocations enable row level security;

create policy worktrees_select on public.worktrees for select to tm8_app
  using (internal.entity_readable(entity_id));
create policy worktree_allocations_select on public.worktree_allocations for select to tm8_app
  using (internal.entity_readable(worktree_entity_id));

grant select on public.worktrees to tm8_app;
grant select on public.worktree_allocations to tm8_app;

-- 008's wholesale grant was a one-time statement; functions created afterwards
-- need their own revoke/grant with FULL argument signatures (050/053 precedent).
revoke all on function public.create_worktree(uuid,uuid,text,text,text,text,uuid,text) from public;
grant execute on function public.create_worktree(uuid,uuid,text,text,text,text,uuid,text) to tm8_app;
revoke all on function public.update_worktree(uuid,integer,text,uuid,text,text) from public;
grant execute on function public.update_worktree(uuid,integer,text,uuid,text,text) to tm8_app;

reset role;
