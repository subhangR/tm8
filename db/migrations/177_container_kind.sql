-- =============================================================================
-- 177 — `container`, the machine-as-entity core kind.
--
-- A container is an entity: one envelope in `public.entities`, one detail row
-- in `public.containers`, and the ordinary version/event/RLS machinery every
-- other kind already has. A machine an agent can drive is not a new subsystem
-- bolted beside the graph; it is a row in it. Template: `135_graph_kind.sql`.
--
-- NUMBERED 177, MEASURED NOT ASSUMED (2026-09-03). The rule from 135's header
-- is the union of `db/migrations` across ALL origin heads, never previous+1.
-- Measured over a pruned fetch: 566 origin heads → 65 `db/migrations` blobs not
-- on main → the union's max three-digit prefix is 176, not 173. The three
-- prefixes above main's tip live on branches, which is exactly why the union is
-- the measure:
--
--     173  173_menu_codebrain_tab.sql                       origin/main
--     174  174_tracking_refresh_says_why_it_stopped.sql     PR #527
--     175  175_unseen_means_created.sql                     PR #564
--     176  176_chat_entity.sql                              origin/tm8/01a064ed
--
-- The Design and the Plan both say `174`; they were written before that
-- measurement. Read 174 as 177 throughout. On a collision at merge time the fix
-- is to RENAME this one file, never to add a second — a stolen prefix surfaces
-- only as a chain-COUNT pin conflict, and the worse half is no conflict at all
-- (two branches making the identical pin edit auto-merge one short). The
-- order-free duplicate-prefix assertion already exists at
-- `tools/ci/migrations-check.sh:69` and CI runs it; this file does not re-add it.
--
-- -----------------------------------------------------------------------------
-- SHARED-OBJECT NOTICE — read before editing, and before rebasing this file
-- -----------------------------------------------------------------------------
--
-- §7 REPLACES `internal.entity_content`, and §10 REPLACES
-- `public.work_session_transition`. Both are shared bodies: `create or replace`
-- in two different files never conflicts in git, never errors, and never reds a
-- test — whichever migration lands SECOND silently wins WHOLESALE, and the arm
-- the other one added is gone. That is 135's own warning ("copying an older body
-- silently drops kinds") and it has bitten this chain before.
--
-- Every `create or replace` here was checked against every migration blob
-- reachable from any origin head but absent from main (65 blobs, 61 unique
-- files). Live collisions — a branch whose prefix is still FREE on main, so it
-- can apply as written:
--
--     internal.entity_content   ← 176_chat_entity.sql (origin/tm8/01a064ed)
--
-- and that is the only one. Everything else that greps as a collision sits on a
-- prefix ALREADY OCCUPIED on main by a different file (076, 078, 082, 086, 087,
-- 090, 091, 107, 153, 155), so it cannot apply without renumbering. Dead,
-- measured rather than assumed.
--
-- TWO SHARED BODIES WERE DELIBERATELY NOT JOINED, and not joining them is the
-- cheapest possible fix for a shared-body hazard:
--
--   * `public.space_kind_counts` — NOT TOUCHED. Design §3.6/§15 call it an
--     "allow-list — add it or exec terminals vanish from the rail". That was
--     true at 083 and 101 FIXED it: 101 §4 replaced `ws.session_kind <> 'agent'`
--     with `ws.session_kind = 'credential'`, and 158 (the current body) carries
--     it forward with the comment "Spelled as the exact kind being hidden, so a
--     future session kind is COUNTED unless someone writes it in here." There is
--     no kind allow-list in that function at all — it is
--     `select e.kind, count(*) … group by e.kind` — so `container` is counted
--     the moment the kind row below exists, and `container_exec` is counted
--     because it is not `credential`. Re-creating it would have put a SIXTH copy
--     of that body in the chain to change nothing, and would have collided with
--     PR #564, which re-creates it too. Asserted by test instead.
--
--   * `public.execution_spawn` — NOT TOUCHED. Design §3.6 says its
--     `p_workdir_mode` must learn `container`. It already accepts it: 150:714
--     takes the argument and 150:786 passes it straight to the INSERT with no
--     allow-list, and the single `elsif` (150:776, "worktree mode requires a
--     project") does not catch `container`. The column CHECK is the only gate,
--     and §9 widens it. That is sufficient and complete. It also matters that
--     176 re-creates `execution_spawn` too: this is the most-re-created body in
--     the chain (007 → 043 → 048 → 111 → 129 → 131 → 150, seven copies) and
--     joining it would have been the worst hazard in the file.
--
-- -----------------------------------------------------------------------------
-- MIGRATION-165 NOTICE
-- -----------------------------------------------------------------------------
--
-- `entities_capture_event` was SPLIT in 165 into
-- `entities_capture_event_ins_del` and `entities_capture_event_upd`. The old
-- `alter table public.entities disable trigger entities_capture_event` idiom
-- ERRORS since 165 and is not used here.
--
-- The same migration's lesson shapes §4: heartbeats and usage samples are
-- written every 10-30 s per container by the node and must NEVER reach the
-- entity. They live in `public.container_runtime_state`, which has no
-- `snapshot_entity_version` trigger and therefore emits no `entity.upsert` and
-- bumps no version. A periodic UPDATE on the detail row would emit one event
-- every 10 s per machine and starve live renames.
--
-- -----------------------------------------------------------------------------
-- OWNERSHIP
-- -----------------------------------------------------------------------------
--
-- `set role tm8_graph_owner` / `reset role` brackets the whole file (135/150
-- posture). SECURITY DEFINER functions run as the OWNER, `tm8_graph_owner`, not
-- as the caller, so every door below carries its own `revoke all … from public`
-- + `grant execute … to tm8_app` on the FULL argument signature, plus the
-- migration-162 `has_function_privilege` self-check in §15. A missing
-- `revoke … from public` is invisible in a diff of the function and visible only
-- in a diff of the SURFACE, where it reds every open PR.
-- =============================================================================

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 1. Registry. `entity_kinds_guard_core` (005) fires on UPDATE/DELETE only, so
--    the seed is an ordinary insert (053/056/091/135 precedent).
-- -----------------------------------------------------------------------------
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('container', 'core', null, 'box')
on conflict (kind) where space_id is null do nothing;

-- -----------------------------------------------------------------------------
-- 2. Detail table.
--
--    `entity_id` and `updated_at` are load-bearing: `snapshot_entity_version()`
--    reads both unqualified (135:61 precedent).
--
--    `status` is guarded by §3 and has exactly ONE writer,
--    `public.set_container_status`. `runtime_ref` is provider-owned and opaque
--    to the graph — a docker container id, a VM id, an emulator serial — and
--    the graph never parses it.
-- -----------------------------------------------------------------------------
create table public.containers (
  entity_id         uuid primary key references public.entities(id) on delete cascade,
  title             text not null default '' check (char_length(title) <= 500),
  profile           text not null
                    check (profile in ('shell','desktop','browser','android','ios','dind','custom')),
  provider          text not null check (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  isolation         text not null
                    check (isolation in ('process','container','gvisor','microvm','vm')),
  -- Same meaning as `work_sessions.node_id`: which node hosts the runtime.
  node_id           text not null,
  image             text not null default '',
  -- ContainerSpec. Validated by the door (§11), not by a schema in a trigger —
  -- 001 §9's rule that validating JSON schema in a trigger is cost without a
  -- consumer. The CHECK asserts the CONTAINER TYPE only.
  spec              jsonb not null default '{}'::jsonb check (jsonb_typeof(spec) = 'object'),
  -- SERVER-ONLY (ruling R5, Design v4). Bind-mount HOST paths and provider
  -- options live here and NEVER in `spec`, because `internal.command_entity`
  -- (007:36) embeds `entity_content` in the command result a CLIENT receives.
  -- `spec.mounts` entries carry guest path + `ro` only; the host half is split
  -- out into `host_spec.mounts` by the create door (§11) and subtracted again
  -- in §7's arm. Same treatment the `chat` arm gives `cwd`/`native_session_id`.
  host_spec         jsonb not null default '{}'::jsonb check (jsonb_typeof(host_spec) = 'object'),
  lifecycle         jsonb not null default '{"ephemeral":true}'::jsonb
                    check (jsonb_typeof(lifecycle) = 'object'),
  status            text not null default 'requested'
                    check (status in ('requested','provisioning','running','paused',
                                      'stopping','stopped','destroying','destroyed','failed')),
  status_changed_at timestamptz not null default now(),
  share_mode        text not null default 'none' check (share_mode in ('none','space','explicit')),
  role              text not null default 'machine' check (role in ('machine','template')),
  runtime_ref       text,
  surfaces          jsonb not null default '{}'::jsonb check (jsonb_typeof(surfaces) = 'object'),
  labels            jsonb not null default '{}'::jsonb check (jsonb_typeof(labels) = 'object'),
  error             text,
  -- Provenance ONLY. T-L3: relations are edges. This column exists so the
  -- ephemeral-binding sweeper (§11.2) can ask "was this made FOR that session"
  -- without walking edges on a timer; it is not the session→container relation,
  -- which is the `runs_in` edge.
  spawned_by        uuid references public.entities(id) on delete set null,
  started_at        timestamptz,
  stopped_at        timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index containers_node_live_idx on public.containers(node_id)
  where status in ('requested','provisioning','running','paused','stopping','destroying');
create index containers_expires_idx on public.containers(expires_at)
  where expires_at is not null and status in ('running','paused','stopped');
create index containers_spawned_by_idx on public.containers(spawned_by)
  where spawned_by is not null;

create trigger containers_validate_kind
before insert or update of entity_id on public.containers
for each row execute function internal.validate_detail_envelope('container');

create trigger containers_touch_updated_at before update on public.containers
for each row execute function internal.touch_updated_at();

-- AFTER UPDATE, not `before insert or update`. Design §3.1 spells this trigger
-- `before insert or update`, which cannot work: `snapshot_entity_version()`
-- reads OLD (001:1138), and referencing OLD in an INSERT trigger raises
-- `record "old" is not assigned yet` — every create would fail. 135:85 and
-- 057 both use `after update`, and the initial version comes from
-- `internal.record_initial_version` inside the create door instead. Reported to
-- the coordinator as a Design §3.1 correction.
create trigger containers_w2_snapshot_version after update on public.containers
for each row execute function internal.snapshot_entity_version();

alter table public.containers enable row level security;

create policy containers_select on public.containers for select to tm8_app
  using (internal.entity_readable(entity_id));

-- SELECT only. The doors below are the entire write surface (T-L5).
grant select on public.containers to tm8_app;

-- -----------------------------------------------------------------------------
-- 3. Single-writer status guard (Design §3.2, §11.1).
--
--    Modelled on `internal.guard_worktree_status` (057:103) and, before it,
--    `internal.guard_work_session_status` (001:730). Several writers plausibly
--    exist — the create saga, the reconciler, two sweepers, the CLI — so
--    `status` gets exactly ONE door and the trigger refuses everyone else. This
--    is R29 applied to a third table.
--
--    The claim `tm8.container_transition` is what `public.set_container_status`
--    sets for the duration of its own UPDATE. Commenting out the claim check is
--    this lane's negative control: it must red the "direct status update
--    refused" test and NOTHING else.
--
--    LEGALITY IS ENFORCED HERE TOO, not only in the door. A door can be
--    bypassed by a future second door; a trigger cannot. `container_transition_allowed`
--    is the edge table from Design §11.1, and it is IMMUTABLE so the planner may
--    fold it.
-- -----------------------------------------------------------------------------
create or replace function internal.container_transition_allowed(p_from text, p_to text)
returns boolean language sql immutable parallel safe as $$
  select case
    -- `destroyed` is terminal. Nothing leaves it, including `destroyed` itself
    -- (the guard only fires when the value actually changes).
    when p_from = 'destroyed' then false
    -- Universal edges, from Design §11.1's "(any) → destroying" row and its
    -- "running → failed / provisioning → failed" rows generalised: any machine
    -- that is not already gone can be torn down, and any machine that is not
    -- already gone or already failed can fail.
    when p_to = 'destroying' then true
    when p_to = 'failed' and p_from <> 'failed' then true
    -- The forward path. NOTE: `destroyed` is reachable ONLY through
    -- `destroying`. Design §11.1's ASCII sketch draws `stopped ──▶ destroyed`
    -- directly, but its transition TABLE — the authoritative half, and the one
    -- the coordinator's frozen ruling names — routes every teardown through
    -- `destroying` so the provider call always has a state to be observed in.
    -- Reported to the coordinator as a Design §11.1 ambiguity with this
    -- resolution.
    else (p_from, p_to) in (
      ('requested',    'provisioning'),
      ('provisioning', 'running'),
      ('running',      'paused'),
      ('running',      'stopping'),
      ('paused',       'running'),
      ('paused',       'stopping'),
      ('stopping',     'stopped'),
      ('stopped',      'running'),
      ('destroying',   'destroyed')
    )
  end
$$;

comment on function internal.container_transition_allowed(text, text) is
  'The container status machine (Design §11.1) as data. `destroyed` is '
  'terminal; `destroying` and `failed` are reachable from anywhere that is not '
  'already terminal; `destroyed` is reachable only through `destroying`.';

create or replace function internal.guard_container_status() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  if new.status is distinct from old.status
     and coalesce(internal.claim_text('tm8.container_transition'), '') <> 'on' then
    raise exception 'container.status has a single writer: public.set_container_status'
      using errcode = '23514',
            detail = 'call public.set_container_status(...) — R29';
  end if;
  if new.status is distinct from old.status then
    if not internal.container_transition_allowed(old.status, new.status) then
      raise exception 'container status % -> % is not a legal transition', old.status, new.status
        using errcode = '23514',
              detail = 'legal edges are Design §11.1 / internal.container_transition_allowed';
    end if;
    new.status_changed_at := now();
  end if;
  return new;
end
$$;

create trigger containers_guard_status before update of status on public.containers
for each row execute function internal.guard_container_status();

-- -----------------------------------------------------------------------------
-- 4. Operational side tables (Design §3.3). T-L3 "operational": NO snapshot
--    trigger, NO events, NO version bump. See the MIGRATION-165 NOTICE above —
--    this absence is the entire point of these two tables existing.
-- -----------------------------------------------------------------------------

-- Heartbeats and usage, written every 10-30 s by the node.
--
-- DELIBERATELY NO FOREIGN KEY on `container_entity_id`, exactly as
-- `worktree_allocations` (057 §3) has none: the node writes this row before the
-- entity is durable and after it is destroyed, and a FK would turn ordinary
-- reconciliation ordering into a constraint violation.
create table public.container_runtime_state (
  container_entity_id uuid primary key,
  node_id             text not null,
  last_seen_at        timestamptz not null default now(),
  usage               jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  probe               jsonb not null default '{}'::jsonb check (jsonb_typeof(probe) = 'object'),
  attempts            integer not null default 0 check (attempts >= 0),
  failure_code        text,
  failure_detail      jsonb not null default '{}'::jsonb check (jsonb_typeof(failure_detail) = 'object'),
  last_reconciled_at  timestamptz,
  updated_at          timestamptz not null default now()
);
create index container_runtime_state_node_idx on public.container_runtime_state(node_id);

create trigger container_runtime_state_touch before update on public.container_runtime_state
for each row execute function internal.touch_updated_at();

alter table public.container_runtime_state enable row level security;

-- Borrows the entity's readability, like `worktree_allocations`. A row whose
-- entity is gone is readable by nobody, which is the honest answer.
create policy container_runtime_state_select on public.container_runtime_state
  for select to tm8_app using (internal.entity_readable(container_entity_id));

grant select on public.container_runtime_state to tm8_app;

-- Exposed ports and their share tokens. HASH ONLY — the bearer never lands.
create table public.container_exposures (
  container_entity_id uuid not null references public.containers(entity_id) on delete cascade,
  port                integer not null check (port between 1 and 65535),
  share               text not null default 'none' check (share in ('none','space','link')),
  share_token_hash    text check (share_token_hash is null or share_token_hash ~ '^[a-f0-9]{64}$'),
  created_by          uuid not null references public.entities(id),
  created_at          timestamptz not null default now(),
  primary key (container_entity_id, port)
);

alter table public.container_exposures enable row level security;

create policy container_exposures_select on public.container_exposures
  for select to tm8_app using (internal.entity_readable(container_entity_id));

grant select on public.container_exposures to tm8_app;

-- -----------------------------------------------------------------------------
-- 5. `stream_grants` learns a second subject (Design §3.3, §6.1).
--
--    T-L10: there is exactly ONE live-media path in tm8 — the PTY WebSocket
--    with a single-use grant (087) — and containers add surface KINDS to it,
--    not a second path. So this is four columns on 006's table, not a new one.
--
--    `work_session_id` loses NOT NULL. The replacement invariant is stricter
--    than the one it removes: EXACTLY ONE of the two subjects, enforced by
--    CHECK, so a row can never name both or neither.
--
--    `multi_use` is the CDP exception and nothing else (Design §16.1):
--    Playwright's `connectOverCDP` dials once over HTTP and once over WS, so a
--    single-use grant cannot serve it. It is the ONLY way past the 60 s clamp,
--    it is capped at 1 h, and it is bound to actor + surface + container like
--    every other grant.
-- -----------------------------------------------------------------------------
alter table public.stream_grants alter column work_session_id drop not null;

alter table public.stream_grants
  add column if not exists container_entity_id uuid references public.entities(id) on delete cascade;
alter table public.stream_grants
  add column if not exists surface text;
alter table public.stream_grants
  add column if not exists multi_use boolean not null default false;

do $$ begin
  alter table public.stream_grants add constraint stream_grants_surface_check
    check (surface is null or surface in ('screen','browser','adb','docker'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.stream_grants add constraint stream_grants_subject_check
    check (num_nonnulls(work_session_id, container_entity_id) = 1);
exception when duplicate_object then null; end $$;

-- A container grant must name its surface; a session grant must not.
do $$ begin
  alter table public.stream_grants add constraint stream_grants_surface_subject_check
    check ((container_entity_id is null) = (surface is null));
exception when duplicate_object then null; end $$;

-- 006:102's `stream_grants_live_idx` is UNIQUE on
-- (work_session_id, subject_identity, mode) WHERE revoked_at is null. Container
-- rows carry a NULL there and a unique index treats NULLs as distinct, so they
-- never collide in it and it needs no change. Containers get the parallel index,
-- keyed on the surface as well because one actor may hold a screen grant and a
-- browser grant on the same machine at the same time.
create unique index stream_grants_container_live_idx
  on public.stream_grants(container_entity_id, subject_identity, surface, mode)
  where revoked_at is null and container_entity_id is not null;

comment on column public.stream_grants.container_entity_id is
  'Set when this grant is for a CONTAINER surface rather than a work session '
  'PTY. Exactly one of work_session_id / container_entity_id is non-null (177).';
comment on column public.stream_grants.multi_use is
  'The CDP exception ONLY (Design §16.1): Playwright dials a debugger endpoint '
  'twice, so that one grant survives consumption. Capped at 1 h; every other '
  'grant stays single-use with the 087 60 s clamp.';

-- -----------------------------------------------------------------------------
-- 6. Edge types (Design §3.4).
--
--    `internal.validate_edge` (001:778) enforces the kind pairs, so these five
--    rows ARE the schema for how a machine may be wired into the graph.
--
--    Nesting is NOT an edge type: it rides the spine's `parent_id`
--    (homogeneous hierarchy, container inside container), which
--    `entities.children` and the tree UI already render.
--
--    `drives` is written ONCE per (session, container) by `record_container_drive`
--    with `on conflict do nothing`, never per action: an edge write fires ~15
--    triggers and bumps `activity_at` on BOTH endpoints, so a per-action edge
--    would make every keystroke a graph write.
-- -----------------------------------------------------------------------------
--
--    ⚠ EVERY ROW NEEDS A NON-NULL `props_schema`. Design §3.4 spells `drives`
--    and `controls` with `null`, and 001:756 calls the column "nullable and
--    UNENFORCED in v1" — but `w2-edges-placements.pg.test.ts:285` pins
--    `count(*) filter (where props_schema is null) = 0` across the WHOLE
--    registry, so a null here reds a suite this lane never runs. CI caught it;
--    no focused suite could. All 38 pre-existing rows carry a schema, and the
--    11 with no meaningful properties use the empty-object form below — so that
--    is the convention for `drives` and `controls`, not an invention.
--
--    `additionalProperties: true` on all five for the same reason: every
--    existing row has it, and props are unenforced in v1, so a row that omitted
--    it would be the only one making a claim about closedness.
insert into public.edge_types(type, src_kinds, dst_kinds, description, props_schema, acyclic) values
  ('runs_in', array['work_session'], array['container'],
   'the session''s process tree executes inside the container',
   '{"type":"object","properties":{"launcher":{"type":"string"}},"additionalProperties":true}'::jsonb, false),
  ('drives', array['work_session'], array['container'],
   'the session uses the container through tools (run/computer/attach)',
   '{"type":"object","properties":{},"additionalProperties":true}'::jsonb, false),
  ('mounts', array['container'], array['project'],
   'the project working dir is bind-mounted in the container',
   '{"type":"object","properties":{"guest":{"type":"string"},"ro":{"type":"boolean"}},"additionalProperties":true}'::jsonb, false),
  ('snapshot_of', array['container'], array['container'],
   'this container was forked from that snapshot/template',
   '{"type":"object","properties":{"image":{"type":"string"}},"additionalProperties":true}'::jsonb, true),
  ('controls', array['team_member','member'], array['container'],
   'explicit input (takeover/exec) grant from the creator',
   '{"type":"object","properties":{},"additionalProperties":true}'::jsonb, false)
on conflict (type) do nothing;

-- -----------------------------------------------------------------------------
-- 7. Content hydration. SEE THE SHARED-OBJECT NOTICE AT THE TOP OF THIS FILE.
--
--    THE BODY BELOW IS `176_chat_entity.sql`'s, RE-COPIED FROM `origin/main`
--    ON 2026-09-03 AFTER #575 MERGED — the 083:697 idiom, and it is
--    load-bearing. It was 135's until that merge; 176 then became the newest
--    writer, so the body was re-copied rather than rebased forward. The chain of
--    definitions is now 001 → 005 → 011 → 015 → 017 → 053 → 055 → 056 → 057 →
--    091 → 135 → 176, and this file is 177. The `container` arm is the ONLY
--    addition: verified by diffing this body against 176's, which shows exactly
--    two added lines and nothing else, and by confirming the `chat` arm — with
--    its `cwd` / `native_session_id` / `client_mutation_id` R5 subtractions —
--    is byte-identical to 176's.
--
--    WHY A RE-COPY AND NOT A MERGE: apply order is a plain filename sort
--    (`db/migrate.mjs:142`), so on every fresh database 176 applies and then 177
--    applies, and THIS body is the one that survives. Merge order is irrelevant;
--    the HIGHER-NUMBERED file must carry every arm. A rebase does not do this
--    for you — the two files never conflict in git — which is why it is done by
--    hand and proved by diff.
--
--    OMITTING AN ARM IS SILENT. Content resolves to '{}'::jsonb forever: no
--    error, no failed migration, no red test unless something asserts that
--    kind's content specifically. That is why
--    `packages/server/test/db/entity-content-all-kinds.pg.test.ts` resolves
--    content for EVERY core kind rather than for `container` alone.
--
--    ⚠ IF YOU REBASE THIS FILE, RE-COPY THIS BODY FROM `origin/main` AT THAT
--    MOMENT, and diff to prove your arm is the only delta. 176 is on main now;
--    the next file to re-create this function inherits the same obligation. The two do not conflict in git and neither
--    errors; whichever lands SECOND wins wholesale and silently drops the
--    other's arm. The agreed rule, binding on both lanes: WHICHEVER MERGES
--    SECOND COPIES THIS BODY FROM `origin/main` AT MERGE TIME AND ADDS ITS OWN
--    ARM ON TOP — never from 135.
--
--    R5 SUBTRACTION (Design v4). `runtime_ref` and `host_spec` are subtracted
--    here for the same reason the `chat` arm subtracts `cwd` and
--    `native_session_id`: `internal.command_entity` (007:36) embeds this result
--    in what a CLIENT receives, and a provider's opaque runtime id and the
--    host's real filesystem paths stay server-side. `spec` is safe to return
--    because the create door has already split every host path out of it.
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
      when 'loop' then select to_jsonb(l) - 'entity_id' into content from public.loops l where l.entity_id = target;
      when 'graph' then select to_jsonb(g) - 'entity_id' into content from public.graphs g where g.entity_id = target;
      when 'chat' then select to_jsonb(c) - 'entity_id' - 'cwd' - 'native_session_id' - 'client_mutation_id'
                       into content from public.chats c where c.entity_id = target;
      when 'file' then select to_jsonb(f) - 'entity_id' into content from public.files f where f.entity_id = target;
      when 'message' then select to_jsonb(m) - 'entity_id' into content from public.messages m where m.entity_id = target;
      when 'work_session' then select to_jsonb(ws) - 'entity_id' into content from public.work_sessions ws where ws.entity_id = target;
      when 'member' then select to_jsonb(mem) - 'entity_id' into content from public.members mem where mem.entity_id = target;
      when 'pull_request' then select to_jsonb(pr) - 'entity_id' into content from public.pull_requests pr where pr.entity_id = target;
      when 'commit' then select to_jsonb(cm) - 'entity_id' into content from public.commits cm where cm.entity_id = target;
      when 'project' then select to_jsonb(p) - 'entity_id' into content from public.project_projection_details p where p.entity_id = target;
      when 'interaction_profile' then select to_jsonb(p) - 'entity_id' into content from public.interaction_profiles p where p.entity_id = target;
      when 'container' then select to_jsonb(c) - 'entity_id' - 'runtime_ref' - 'host_spec'
                              into content from public.containers c where c.entity_id = target;
      else content := '{}'::jsonb;
    end case;
  end if;
  return coalesce(content, '{}'::jsonb);
end
$$;

-- -----------------------------------------------------------------------------
-- 8. `session_kind = 'container_exec'` (Design §3.6, §8.3).
--
--    101's header is an AUDIT of every SQL surface that branches on
--    `session_kind`, and it ends "Read the 083 and 101 headers before adding a
--    fourth value, and redo 101's audit rather than assuming it covered you."
--    This is that read. Every item, and what 177 does about it:
--
--     1. `internal.live_work_session_count` (083:198) — `= 'agent'`.
--        NOT TOUCHED, AND THAT IS THE DECISION. An exec terminal must not burn
--        an agent spawn slot. §10 adds a disjoint count instead, the third
--        repetition of the pattern 083 and 101 each used.
--
--     2. `internal.w1_backfill_participant` (083 §5) — `<> 'agent'` ⇒ 0.
--        NOT TOUCHED, correct as written: an exec session has no team_member
--        and never will, so there is no participant to backfill and falling
--        through would emit `participant_backfill_unresolved` forever.
--
--     3. `internal.repair_w1_foundations`'s session loop — `= 'agent'`.
--        NOT TOUCHED, correct: nothing composes a prompt for an exec terminal,
--        so there is no interaction profile to pin and no participant.
--
--     4. `public.space_kind_counts` — NOT TOUCHED, and this is the one the
--        Design got wrong. 101 §4 REPLACED 083's `<> 'agent'` allow-list with
--        `= 'credential'`, and 158 (the current body) carries it forward with
--        the comment "a future session kind is COUNTED unless someone writes it
--        in here." `container_exec` is a future session kind, so it is already
--        counted — which is what we want, a terminal a member started belongs
--        in the rail. See the SHARED-OBJECT NOTICE.
--
--     4b. `credential-catalog.ts:521` — `where ws.session_kind = 'agent'`,
--        inside `terminateAgentSessions`. SQL embedded in TypeScript, which a
--        grep of this directory cannot see, which is why 101 named it
--        separately and why it is named again here. NOT TOUCHED, correct:
--        disconnecting a vendor credential must not kill exec terminals, which
--        hold no vendor credential.
--
--     5. `public.execution_spawn` — NOT TOUCHED. See the SHARED-OBJECT NOTICE:
--        it already passes `p_workdir_mode` through unvalidated, so widening
--        the column CHECK below is sufficient and complete.
--
--    Beyond 101's five: `public.set_session_done` (156, grants repaired by 162)
--    has no `session_kind` predicate and needs none — an exec session finishes
--    like any other. `public.work_session_transition` DOES change, but for
--    `ended_kind`, not for `session_kind`; see §9.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  drop constraint if exists work_sessions_session_kind_check;
alter table public.work_sessions
  add constraint work_sessions_session_kind_check
    check (session_kind in ('agent', 'credential', 'shell', 'container_exec'));

comment on column public.work_sessions.session_kind is
  'agent = a real agent session. credential = an interactive vendor-login '
  'terminal (083). shell = a vanilla terminal, a PTY on the login shell with '
  'no agent attached (101). container_exec = a PTY inside a container, whose '
  'workdir_mode is ''container'' and whose node_id is the container''s (177). '
  'Anything that assumed a work_sessions row is an agent must narrow on this. '
  'Read the 083, 101 and 177 headers before adding a fifth value, and redo '
  '101''s audit rather than assuming it covered you.';

-- The `workdir_mode` widening. THE CONSTRAINT BEING EXTENDED IS 015's, NOT
-- 001's: 001 created it as ('project','worktree') and 015:304 widened it to add
-- 'scratch', so 015 is the current definition. (167's ('project','scratch')
-- check belongs to `chat_threads`, a different table — a grep for
-- `workdir_mode` lands there and it is NOT this constraint.)
alter table public.work_sessions
  drop constraint if exists work_sessions_workdir_mode_check;
alter table public.work_sessions
  add constraint work_sessions_workdir_mode_check
    check (workdir_mode in ('project','worktree','scratch','container'));

-- -----------------------------------------------------------------------------
-- 9. `ended_kind` learns the two ways a container ends a session (Design §8.3).
--
--    Gated TWICE — the table CHECK (171:35) and a hardcoded in-list inside the
--    function body (171:91) — so both must be widened or a legal ending is
--    refused at runtime with 22023.
--
--    `container_stopped`: the machine was stopped deliberately, so the exec
--    session inside it ended with it. `runtime_lost`: reconciliation found the
--    runtime gone without a stop ever being requested. Keeping them distinct is
--    the same discipline as 171's `out_of_memory` — an involuntary death must
--    stay distinguishable from an orderly one.
-- -----------------------------------------------------------------------------
alter table public.work_sessions
  drop constraint if exists work_sessions_ended_kind_check;
alter table public.work_sessions
  add constraint work_sessions_ended_kind_check
    check (ended_kind is null or ended_kind in (
      'completed', 'stopped_by_operator', 'server_restart',
      'out_of_memory', 'crashed', 'unknown',
      'container_stopped', 'runtime_lost'));

--    THE BODY BELOW IS `171_session_ended_reason.sql`'s, COPIED FROM
--    `origin/main` ON 2026-09-03. The in-list is the ONLY line changed. The
--    signature is unchanged (171 dropped the old 6-arg form deliberately —
--    Postgres would treat a 7th defaulted parameter as an overload and a
--    positional call would raise 'function is not unique'), so this is a
--    `create or replace` with no `drop`, and the existing grant survives it.
--    Re-stated in §15 anyway, per the 162 idiom.
--
--    NO off-main branch re-creates this function — checked across all 566
--    origin heads — so unlike §7 this body has no live collision.
-- ⚠ ROLE BRACKET. 171 does NOT `set role tm8_graph_owner`, so
--   `public.work_session_transition` is owned by the role that RAN that
--   migration, not by tm8_graph_owner. `create or replace` on a function you do
--   not own fails with `must be owner of function`, so this one object — and
--   its grants, down in §23 — is written OUTSIDE the file's owner bracket.
--   Measured, not guessed: the first draft of this file did not do this and the
--   chain stopped here with exactly that error. The same trap is why 150 and
--   176 both carry notes about `execution_spawn`'s six earlier writers.
reset role;

create or replace function public.work_session_transition(
  p_session_id uuid, p_status text, p_exit_code integer default null,
  p_error text default null, p_transcript_doc_id uuid default null,
  p_client_mutation_id text default null, p_ended_kind text default null,
  p_ended_reason text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e public.entities;
  current_status text;
  allowed boolean;
begin
  replay := internal.ledger_replay(p_client_mutation_id, 'execution.transition');
  if replay is not null then return replay; end if;
  e := internal.live_entity(p_session_id, 'work_session');
  perform internal.require_space_member(e.space_id);
  if p_status not in ('spawning','running','idle','exited','failed') then
    raise exception 'invalid work_session status: %', p_status using errcode = '22023';
  end if;
  if p_ended_kind is not null and p_ended_kind not in (
       'completed','stopped_by_operator','server_restart',
       'out_of_memory','crashed','unknown',
       -- ADDED IN 177. The only change to this body; see §9.
       'container_stopped','runtime_lost') then
    raise exception 'invalid work_session ended_kind: %', p_ended_kind using errcode = '22023';
  end if;

  select status into current_status from public.work_sessions where entity_id = p_session_id for update;
  allowed := case
    when current_status = p_status then true
    when current_status in ('exited','failed') then false
    when p_status = 'spawning' then false
    else true end;
  if not allowed then
    raise exception 'illegal work_session transition % -> %', current_status, p_status
      using errcode = '23514';
  end if;

  perform set_config('tm8.work_session_transition', 'on', true);
  update public.work_sessions
     set status = p_status,
         exit_code = coalesce(p_exit_code, exit_code),
         error = coalesce(p_error, error),
         transcript_doc_id = coalesce(p_transcript_doc_id, transcript_doc_id),
         -- The ending facts are only meaningful on a terminal status. A
         -- running/idle transition carrying them would be a caller bug, and
         -- silently storing them would date-stamp an ending that never
         -- happened.
         ended_kind = case when p_status in ('exited','failed')
                           then coalesce(p_ended_kind, ended_kind) else ended_kind end,
         ended_reason = case when p_status in ('exited','failed')
                             then coalesce(p_ended_reason, ended_reason) else ended_reason end,
         started_at = case when p_status = 'running' then coalesce(started_at, now()) else started_at end,
         exited_at = case when p_status in ('exited','failed') then coalesce(exited_at, now()) else exited_at end
   where entity_id = p_session_id;
  perform set_config('tm8.work_session_transition', 'off', true);

  update public.entities
     set version = version + 1, activity_at = now(), updated_at = now()
   where id = p_session_id;

  return internal.ledger_record(p_client_mutation_id, 'execution.transition',
           internal.command_result(p_session_id, null, null, array[p_session_id]));
end
$$;

set role tm8_graph_owner;

-- -----------------------------------------------------------------------------
-- 10. Counts. Two disjoint counters, mirroring 083 §3 and 101 §2.
--
--     `container_count` is the per-node quota input (Design §11.4,
--     TM8_CONTAINER_CAP default 4 — this Mac has 16 GiB and the defaults leave
--     room for the node, Postgres and one emulator).
--
--     `container_exec_session_count` is disjoint from BOTH
--     `live_work_session_count` and `shell_session_count`, so a wall of exec
--     terminals can never starve agent spawns and a full agent cap can never
--     refuse a terminal. That is the whole reason `live_work_session_count`
--     keeps its `= 'agent'` filter untouched.
--
--     Both are keyed by NODE, not by space: the resource being rationed is one
--     machine's CPU and memory, and a node hosts every space it serves.
-- -----------------------------------------------------------------------------
create or replace function internal.container_count(p_node_id text)
returns integer language sql stable set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.containers c
    join public.entities e on e.id = c.entity_id
   where c.node_id = p_node_id
     and c.status in ('requested','provisioning','running','paused','stopping')
     and e.deleted_at is null
$$;

comment on function internal.container_count(text) is
  'Live containers on one node, for create_container_entity''s own cap '
  '(Design §11.4). Counts every status that holds runtime resources, so a '
  'machine stuck in `provisioning` still occupies a slot.';

create or replace function internal.container_exec_session_count(p_node_id text)
returns integer language sql stable set search_path = public, internal, pg_temp as $$
  select count(*)::integer
    from public.work_sessions ws
    join public.entities e on e.id = ws.entity_id
   where ws.node_id = p_node_id
     and ws.status in ('spawning','running','idle')
     and ws.session_kind = 'container_exec'
     and e.deleted_at is null
$$;

comment on function internal.container_exec_session_count(text) is
  'Live CONTAINER EXEC sessions on one node, for '
  'start_container_exec_session''s own cap. Disjoint from '
  'internal.live_work_session_count, internal.credential_session_count and '
  'internal.shell_session_count so no one session kind can starve another.';

-- -----------------------------------------------------------------------------
-- 11. `public.create_container_entity` — the birth door.
--
--     Ledger op `containers.create`. Unlike 135's graph, a container is NOT an
--     ordinary `entities.create` to a client: it has its own operation family
--     because creating one provisions a real machine, and the ledger is where
--     that is audited (Design §12.6).
--
--     THE SPEC SPLIT (R5, Design v4). `p_spec` arrives with everything the
--     caller knows, including bind-mount HOST paths. It leaves in two pieces:
--     `spec` keeps guest path + `ro` and goes to clients through
--     `entity_content`; `host_spec` keeps the host halves and never leaves the
--     server. Doing the split HERE rather than in the node is what makes it an
--     invariant of the row instead of a convention of one caller.
-- -----------------------------------------------------------------------------
create or replace function public.create_container_entity(
  p_space_id uuid, p_title text, p_actor_id uuid default null,
  p_profile text default 'shell', p_provider text default 'docker',
  p_isolation text default 'container',
  p_node_id text default null, p_image text default '',
  p_spec jsonb default '{}'::jsonb,
  p_lifecycle jsonb default '{"ephemeral":true}'::jsonb,
  p_share_mode text default 'none', p_role text default 'machine',
  p_parent_id uuid default null, p_project_id uuid default null,
  p_template_id uuid default null,
  p_spawned_by uuid default null, p_cap integer default 4,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay        jsonb;
  actor         uuid;
  container_id  uuid;
  activity_id   uuid;
  parent_row    public.entities;
  mount_entry   jsonb;
  guest_mounts  jsonb := '[]'::jsonb;
  host_mounts   jsonb := '[]'::jsonb;
  clean_spec    jsonb;
  host_spec_out jsonb := '{}'::jsonb;
  env_key       text;
  port_entry    jsonb;
  live_count    integer;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.create');
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

  -- --- shape validation, all 22023 ------------------------------------------
  if length(btrim(coalesce(p_title, ''))) > 500 then
    raise exception 'container title must be at most 500 chars' using errcode = '22023';
  end if;
  if coalesce(p_profile, '') not in ('shell','desktop','browser','android','ios','dind','custom') then
    raise exception 'unknown container profile: %', p_profile using errcode = '22023';
  end if;
  if coalesce(p_provider, '') !~ '^[a-z][a-z0-9-]{0,31}$' then
    raise exception 'container provider must be a lowercase slug (got %)', p_provider
      using errcode = '22023';
  end if;
  if coalesce(p_isolation, '') not in ('process','container','gvisor','microvm','vm') then
    raise exception 'unknown isolation level: %', p_isolation using errcode = '22023';
  end if;
  -- A container without a node is a machine with nowhere to run. The reconciler
  -- and both sweepers key on `node_id`, so a NULL here is invisible to all
  -- three and leaks a runtime nothing will ever collect.
  if p_node_id is null or btrim(p_node_id) = '' then
    raise exception 'container node_id is required' using errcode = '22023';
  end if;
  if coalesce(p_share_mode, '') not in ('none','space','explicit') then
    raise exception 'unknown share_mode: %', p_share_mode using errcode = '22023';
  end if;
  if coalesce(p_role, '') not in ('machine','template') then
    raise exception 'unknown container role: %', p_role using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_spec, '{}'::jsonb)) <> 'object' then
    raise exception 'container spec must be a JSON object' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_lifecycle, '{}'::jsonb)) <> 'object' then
    raise exception 'container lifecycle must be a JSON object' using errcode = '22023';
  end if;

  clean_spec := coalesce(p_spec, '{}'::jsonb);

  -- SECRETS NEVER ENTER THE MACHINE THROUGH THE GRAPH (Design §12.3). A spec is
  -- stored in Postgres and returned to clients; a vendor token pasted into
  -- `env` would be durable, replicated and readable by every space member. The
  -- refusal is on the KEY NAME because that is what a caller controls, and it
  -- is deliberately broad — a false refusal costs one rename, a false accept
  -- costs a leaked credential.
  if clean_spec ? 'env' then
    if jsonb_typeof(clean_spec->'env') <> 'object' then
      raise exception 'container spec.env must be a JSON object' using errcode = '22023';
    end if;
    for env_key in select jsonb_object_keys(clean_spec->'env') loop
      if env_key ~* '(secret|token|password|passwd|api[_-]?key|credential|private[_-]?key|access[_-]?key|auth)' then
        raise exception 'container spec.env may not carry a secret-looking key: %', env_key
          using errcode = '22023',
                detail = 'secrets reach a machine through the node''s injection path, never through the graph (Design §12.3)';
      end if;
    end loop;
  end if;

  if clean_spec ? 'ports' then
    if jsonb_typeof(clean_spec->'ports') <> 'array' then
      raise exception 'container spec.ports must be a JSON array' using errcode = '22023';
    end if;
    for port_entry in select value from jsonb_array_elements(clean_spec->'ports') loop
      if jsonb_typeof(port_entry) <> 'number'
         or (port_entry)::text !~ '^[0-9]+$'
         or (port_entry)::text::integer not between 1 and 65535 then
        raise exception 'container spec.ports entries must be integers in 1..65535 (got %)', port_entry
          using errcode = '22023';
      end if;
    end loop;
  end if;

  -- THE MOUNT SPLIT. `host` is absolute and `..`-free (the same rule
  -- `work_sessions.workdir_path` enforces in its column CHECK) and then leaves
  -- the client-visible half entirely.
  if clean_spec ? 'mounts' then
    if jsonb_typeof(clean_spec->'mounts') <> 'array' then
      raise exception 'container spec.mounts must be a JSON array' using errcode = '22023';
    end if;
    for mount_entry in select value from jsonb_array_elements(clean_spec->'mounts') loop
      if jsonb_typeof(mount_entry) <> 'object' then
        raise exception 'container spec.mounts entries must be objects' using errcode = '22023';
      end if;
      if (mount_entry->>'host') is null or (mount_entry->>'host') !~ '^/'
         or (mount_entry->>'host') like '%..%' then
        raise exception 'container mount host path must be absolute and free of "..": %',
          coalesce(mount_entry->>'host', '<null>') using errcode = '22023';
      end if;
      if (mount_entry->>'guest') is null or (mount_entry->>'guest') !~ '^/'
         or (mount_entry->>'guest') like '%..%' then
        raise exception 'container mount guest path must be absolute and free of "..": %',
          coalesce(mount_entry->>'guest', '<null>') using errcode = '22023';
      end if;
      guest_mounts := guest_mounts || jsonb_build_array(jsonb_build_object(
        'guest', mount_entry->>'guest',
        'ro',    coalesce((mount_entry->>'ro')::boolean, false)));
      host_mounts := host_mounts || jsonb_build_array(jsonb_build_object(
        'host',  mount_entry->>'host',
        'guest', mount_entry->>'guest',
        'ro',    coalesce((mount_entry->>'ro')::boolean, false)));
    end loop;
    clean_spec    := jsonb_set(clean_spec, '{mounts}', guest_mounts);
    host_spec_out := jsonb_set(host_spec_out, '{mounts}', host_mounts, true);
  end if;

  -- --- quota (Design §11.4) --------------------------------------------------
  live_count := internal.container_count(p_node_id);
  if live_count >= greatest(coalesce(p_cap, 4), 1) then
    raise exception 'container capacity reached on node %', p_node_id
      using errcode = '53400',
            detail = jsonb_build_object('cap', p_cap, 'live', live_count,
                                        'nodeId', p_node_id)::text;
  end if;

  -- --- relations -------------------------------------------------------------
  -- Nesting rides the spine's parent_id (homogeneous hierarchy), so the parent
  -- must itself be a container in the same space.
  if p_parent_id is not null then
    parent_row := internal.live_entity(p_parent_id, 'container');
    if parent_row.space_id <> p_space_id then
      raise exception 'a nested container must share its parent''s space' using errcode = '23514';
    end if;
  end if;
  if p_project_id is not null then
    perform internal.live_entity(p_project_id, 'project');
  end if;
  if p_template_id is not null then
    perform internal.live_entity(p_template_id, 'container');
  end if;

  container_id := internal.create_envelope(p_space_id, 'container', actor, p_parent_id, null);

  insert into public.containers(
    entity_id, title, profile, provider, isolation, node_id, image,
    spec, host_spec, lifecycle, status, share_mode, role, spawned_by)
  values (
    container_id, btrim(coalesce(p_title, '')), p_profile, p_provider, p_isolation,
    btrim(p_node_id), coalesce(p_image, ''),
    clean_spec, host_spec_out, coalesce(p_lifecycle, '{"ephemeral":true}'::jsonb),
    'requested', coalesce(p_share_mode, 'none'), coalesce(p_role, 'machine'), p_spawned_by);

  perform internal.record_initial_version(container_id, actor);

  -- Edges AFTER the detail row: `validate_edge` reads both endpoints' kinds.
  if p_project_id is not null then
    insert into public.edges(space_id, src_id, dst_id, type, created_by)
    values (p_space_id, container_id, p_project_id, 'mounts', actor)
    on conflict (src_id, dst_id, type) do nothing;
  end if;
  if p_template_id is not null then
    insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
    values (p_space_id, container_id, p_template_id, 'snapshot_of', actor,
            jsonb_build_object('image', coalesce(p_image, '')))
    on conflict (src_id, dst_id, type) do nothing;
  end if;

  activity_id := internal.record_activity(p_space_id, container_id, actor, 'created',
                   null, jsonb_build_object('kind', 'container',
                                            'profile', p_profile,
                                            'provider', p_provider));

  return internal.ledger_record(p_client_mutation_id, 'containers.create',
           internal.command_result(container_id, null, activity_id, array[container_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 12. `public.update_container` — the mutable, non-status half of the record.
--
--     `status` is NOT reachable from here; §3's trigger refuses it and §13 is
--     its only writer. `null` MERGES (the 091/135 patch pattern).
-- -----------------------------------------------------------------------------
create or replace function public.update_container(
  p_entity_id uuid, p_expected_version integer, p_actor_id uuid default null,
  p_title text default null, p_lifecycle jsonb default null,
  p_share_mode text default null, p_labels jsonb default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e      public.entities;
  actor  uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.update');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  e := internal.live_entity(p_entity_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  if p_title is not null and char_length(p_title) > 500 then
    raise exception 'container title must be at most 500 chars' using errcode = '22023';
  end if;
  if p_share_mode is not null and p_share_mode not in ('none','space','explicit') then
    raise exception 'unknown share_mode: %', p_share_mode using errcode = '22023';
  end if;
  if p_lifecycle is not null and jsonb_typeof(p_lifecycle) <> 'object' then
    raise exception 'container lifecycle must be a JSON object' using errcode = '22023';
  end if;
  if p_labels is not null and jsonb_typeof(p_labels) <> 'object' then
    raise exception 'container labels must be a JSON object' using errcode = '22023';
  end if;

  update public.containers
     set title      = coalesce(btrim(p_title), title),
         lifecycle  = coalesce(p_lifecycle, lifecycle),
         share_mode = coalesce(p_share_mode, share_mode),
         labels     = coalesce(p_labels, labels),
         -- `lifecycle.ttlSeconds` is the durable half of the TTL sweeper's
         -- input, so a lifecycle edit must move `expires_at` with it or the
         -- sweeper keeps acting on the old deadline.
         expires_at = case
           when p_lifecycle is null then expires_at
           when (p_lifecycle->>'ttlSeconds') is null then expires_at
           else coalesce(started_at, created_at)
                + make_interval(secs => (p_lifecycle->>'ttlSeconds')::double precision)
         end,
         updated_at = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'containers.update',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'container')),
             array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 13. `public.set_container_status` — THE ONLY WRITER OF `status`.
--
--     TWO MODES, and the difference is `p_client_mutation_id`:
--
--       * LEDGERED (cmid non-null). A human or agent asked for this:
--         `p_operation` names the op and `p_expected_version`, when given, is
--         asserted. These are the transitions someone can be held to.
--
--       * NODE-INTERNAL (cmid null, p_operation null). The saga's
--         provisioning→running, the reconciler's running→failed, the sweeper's
--         idle→paused. No ledger row and no version assert, because there is no
--         client holding a version and no command to be idempotent about —
--         ledgering machine chatter would fill the ledger with rows nobody can
--         replay.
--
--     The claim is set with `is_local => true` so it dies with the transaction:
--     a leaked claim would silently make the single-writer guard a no-op for
--     every later statement on that connection.
-- -----------------------------------------------------------------------------
create or replace function public.set_container_status(
  p_entity_id uuid, p_status text,
  p_runtime_ref text default null, p_surfaces jsonb default null,
  p_error text default null,
  p_actor_id uuid default null, p_operation text default null,
  p_expected_version integer default null,
  p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay      jsonb;
  e           public.entities;
  actor       uuid;
  prior       text;
  ledger_op   text;
  activity_id uuid;
begin
  if p_status not in ('requested','provisioning','running','paused',
                      'stopping','stopped','destroying','destroyed','failed') then
    raise exception 'unknown container status: %', p_status using errcode = '22023';
  end if;
  if p_surfaces is not null and jsonb_typeof(p_surfaces) <> 'object' then
    raise exception 'container surfaces must be a JSON object' using errcode = '22023';
  end if;

  ledger_op := coalesce(p_operation, 'containers.status');
  if p_client_mutation_id is not null then
    if p_operation is null then
      raise exception 'a ledgered container transition must name its operation'
        using errcode = '22023';
    end if;
    if p_operation not in ('containers.start','containers.stop','containers.pause',
                           'containers.resume','containers.destroy') then
      raise exception 'unknown container operation: %', p_operation using errcode = '22023';
    end if;
    perform internal.require_replay_principal(p_client_mutation_id);
    replay := internal.ledger_replay(p_client_mutation_id, p_operation);
    if replay is not null then
      perform internal.require_replay_principal(p_client_mutation_id);
      perform internal.require_replay_subject(
        replay #>> '{entity,id}', p_entity_id::text, 'entity');
      return replay;
    end if;
  end if;

  e := internal.live_entity(p_entity_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  if p_expected_version is not null then
    perform internal.assert_version(p_entity_id, p_expected_version);
  end if;

  -- FOR UPDATE: two sweepers and the reconciler can reach the same row, and the
  -- legality check must see the status the UPDATE will actually replace.
  select status into prior from public.containers where entity_id = p_entity_id for update;
  if prior is null then
    raise exception 'container % has no detail row', p_entity_id using errcode = 'P0002';
  end if;

  if prior is distinct from p_status
     and not internal.container_transition_allowed(prior, p_status) then
    raise exception 'container status % -> % is not a legal transition', prior, p_status
      using errcode = '23514';
  end if;

  perform set_config('tm8.container_transition', 'on', true);
  update public.containers
     set status      = p_status,
         runtime_ref = coalesce(p_runtime_ref, runtime_ref),
         surfaces    = coalesce(p_surfaces, surfaces),
         -- A transition that says nothing about an error must not erase the one
         -- an earlier transition measured (171's coalesce discipline). Reaching
         -- `running` DOES clear it: the machine is demonstrably fine.
         error       = case when p_status = 'running' then null
                            else coalesce(p_error, error) end,
         started_at  = case when p_status = 'running' then coalesce(started_at, now())
                            else started_at end,
         stopped_at  = case when p_status in ('stopped','failed','destroyed')
                            then coalesce(stopped_at, now()) else stopped_at end,
         updated_at  = now()
   where entity_id = p_entity_id;
  perform set_config('tm8.container_transition', 'off', true);

  -- `destroyed` is terminal and soft-deletes the envelope: the record stays for
  -- history (edges included — Design §11.1), the runtime is gone.
  if p_status = 'destroyed' then
    update public.entities set deleted_at = now(), updated_at = now()
     where id = p_entity_id and deleted_at is null;
  end if;

  activity_id := internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
                   null, jsonb_build_object('kind', 'container',
                                            'status', p_status, 'from', prior));

  if p_client_mutation_id is null then
    return internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]);
  end if;
  return internal.ledger_record(p_client_mutation_id, ledger_op,
           internal.command_result(p_entity_id, null, activity_id, array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 14. `public.record_container_surfaces` — a surface coming live IS a real
--     change, so this bumps the version (via §2's snapshot trigger) and emits
--     the ordinary `entity.upsert`. Contrast §16, which must not.
--
--     Node-internal: no ledger, no version assert, no membership check. The node
--     is reporting an observation about a machine it hosts, not acting for a
--     principal, and there may be no identity claim on the connection at all.
-- -----------------------------------------------------------------------------
create or replace function public.record_container_surfaces(
  p_entity_id uuid, p_surfaces jsonb
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if jsonb_typeof(coalesce(p_surfaces, 'null'::jsonb)) <> 'object' then
    raise exception 'container surfaces must be a JSON object' using errcode = '22023';
  end if;
  perform internal.live_entity(p_entity_id, 'container');
  update public.containers
     set surfaces = p_surfaces, updated_at = now()
   where entity_id = p_entity_id;
end
$$;

-- -----------------------------------------------------------------------------
-- 15. `public.set_container_policy` — network policy (Design §12.2).
--
--     Recorded at `spec -> 'network'` rather than in a column of its own: it is
--     part of how the machine is configured, it is client-visible, and a
--     column would have to be re-created by every later policy axis. Ledgered,
--     because a network policy change is consequential and belongs in the audit
--     (Design §12.6).
-- -----------------------------------------------------------------------------
create or replace function public.set_container_policy(
  p_entity_id uuid, p_expected_version integer, p_network jsonb,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e      public.entities;
  actor  uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.policy.set');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  if jsonb_typeof(coalesce(p_network, 'null'::jsonb)) <> 'object' then
    raise exception 'container network policy must be a JSON object' using errcode = '22023';
  end if;
  e := internal.live_entity(p_entity_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  update public.containers
     set spec = jsonb_set(spec, '{network}', p_network, true),
         updated_at = now()
   where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'containers.policy.set',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'container', 'policy', 'network')),
             array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 16. `public.record_container_drive` — the `drives` edge, written ONCE.
--
--     Idempotent by `on conflict do nothing`, and that is not an optimisation:
--     an edge write fires ~15 triggers and bumps `activity_at` on BOTH
--     endpoints, so writing it per action would make every agent keystroke a
--     graph write on the session AND the machine.
-- -----------------------------------------------------------------------------
create or replace function public.record_container_drive(
  p_session_id uuid, p_container_id uuid
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  session_row   public.entities;
  container_row public.entities;
begin
  session_row   := internal.live_entity(p_session_id, 'work_session');
  container_row := internal.live_entity(p_container_id, 'container');
  if session_row.space_id <> container_row.space_id then
    raise exception 'a session may only drive a container in its own space'
      using errcode = '42501';
  end if;
  insert into public.edges(space_id, src_id, dst_id, type, created_by)
  values (session_row.space_id, p_session_id, p_container_id, 'drives',
          coalesce(session_row.created_by, container_row.created_by))
  on conflict (src_id, dst_id, type) do nothing;
end
$$;

-- -----------------------------------------------------------------------------
-- 17. `public.record_container_heartbeat` — THE ONE THAT MUST NOT TOUCH THE
--     ENTITY. See the MIGRATION-165 NOTICE at the top of this file.
--
--     Written every 10-30 s per machine. It writes `container_runtime_state`
--     and NOTHING else: no `containers` UPDATE, no version bump, no
--     `entity.upsert`. If you ever find yourself adding a `containers` write
--     here, you are re-introducing the defect 165 exists to have removed.
-- -----------------------------------------------------------------------------
create or replace function public.record_container_heartbeat(
  p_entity_id uuid, p_node_id text,
  p_usage jsonb default '{}'::jsonb, p_probe jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public, internal, pg_temp as $$
begin
  if p_node_id is null or btrim(p_node_id) = '' then
    raise exception 'heartbeat node_id is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_usage, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_probe, '{}'::jsonb)) <> 'object' then
    raise exception 'heartbeat usage and probe must be JSON objects' using errcode = '22023';
  end if;

  -- No FK and no `live_entity` check on purpose (§4): the node heartbeats a
  -- runtime it can see, and it may see one whose entity is not yet durable or
  -- already soft-deleted. Refusing those would turn ordinary reconciliation
  -- ordering into an error the node cannot act on.
  insert into public.container_runtime_state(
    container_entity_id, node_id, last_seen_at, usage, probe)
  values (p_entity_id, btrim(p_node_id), now(),
          coalesce(p_usage, '{}'::jsonb), coalesce(p_probe, '{}'::jsonb))
  on conflict (container_entity_id) do update
    set node_id      = excluded.node_id,
        last_seen_at = excluded.last_seen_at,
        usage        = excluded.usage,
        probe        = excluded.probe;
end
$$;

-- -----------------------------------------------------------------------------
-- 18. `public.node_containers` — the reconciler's input (Design §11.3).
--
--     Modelled on `node_worktree_allocations` (081:410): a plain
--     `where node_id = $1`, definer, stable, `tm8_app` only. It returns the
--     facts that live in Postgres — the record and whether an entity still
--     backs it — and leaves the runtime, the provider's label listing and the
--     live PTY map to the node, which is the only place those can be observed.
-- -----------------------------------------------------------------------------
create or replace function public.node_containers(p_node_id text)
returns table (
  container_entity_id uuid, node_id text, status text, profile text, provider text,
  runtime_ref text, spec jsonb, lifecycle jsonb, expires_at timestamptz,
  status_changed_at timestamptz, entity_exists boolean, deleted boolean,
  last_seen_at timestamptz, attempts integer, failure_code text
) language sql security definer stable set search_path = public, internal, pg_temp as $$
  select c.entity_id, c.node_id, c.status, c.profile, c.provider,
         c.runtime_ref, c.spec, c.lifecycle, c.expires_at,
         c.status_changed_at,
         (e.id is not null) as entity_exists,
         (e.deleted_at is not null) as deleted,
         rs.last_seen_at, rs.attempts, rs.failure_code
    from public.containers c
    left join public.entities e on e.id = c.entity_id
    left join public.container_runtime_state rs on rs.container_entity_id = c.entity_id
   where c.node_id = p_node_id
   order by c.created_at;
$$;

-- -----------------------------------------------------------------------------
-- 19. `public.sweep_containers` — the sweepers' input (Design §11.3).
--
--     Returns rows DUE for action; the node then acts through
--     `set_container_status`, so this function moves nothing itself. Three
--     reasons, in priority order — a machine past its TTL is torn down even if
--     it also looks idle:
--
--       ttl   — `expires_at` has passed. Ephemeral machines are destroyed,
--               persistent ones stopped (Design §11.3).
--       grace — an ephemeral machine whose spawning session has ended, stopped
--               longer ago than `lifecycle.graceSeconds` (default 600 s). The
--               grace window exists so a human can still open the screen and
--               read what happened (Design §11.2).
--       idle  — running, nothing attached, no live exec session, quiet for
--               `lifecycle.idleHibernateSeconds`. Pause only.
--
--     `distinct on` keeps exactly one row per machine so the node cannot be
--     handed `stop` and `destroy` for the same container in one pass.
-- -----------------------------------------------------------------------------
create or replace function public.sweep_containers(
  p_node_id text, p_now timestamptz default now()
) returns table (container_entity_id uuid, action text, reason text)
language sql security definer stable set search_path = public, internal, pg_temp as $$
  with candidate as (
    select c.entity_id,
           case when coalesce((c.lifecycle->>'ephemeral')::boolean, true)
                then 'destroy' else 'stop' end as ttl_action,
           c.status, c.lifecycle, c.expires_at, c.stopped_at, c.spawned_by,
           coalesce((c.lifecycle->>'graceSeconds')::double precision, 600) as grace_seconds,
           (c.lifecycle->>'idleHibernateSeconds')::double precision as idle_seconds,
           rs.last_seen_at
      from public.containers c
      left join public.container_runtime_state rs on rs.container_entity_id = c.entity_id
      join public.entities e on e.id = c.entity_id and e.deleted_at is null
     where c.node_id = p_node_id
  ),
  due as (
    select entity_id, ttl_action as action, 'ttl' as reason, 1 as rank
      from candidate
     where expires_at is not null
       and expires_at < p_now
       and status in ('running','paused','stopped')
    union all
    select entity_id, 'destroy', 'grace', 2
      from candidate
     where status = 'stopped'
       and coalesce((lifecycle->>'ephemeral')::boolean, true)
       and spawned_by is not null
       and stopped_at is not null
       and stopped_at + make_interval(secs => grace_seconds) < p_now
       and not exists (
         select 1 from public.work_sessions ws
          where ws.entity_id = candidate.spawned_by
            and ws.status not in ('exited','failed'))
    union all
    select entity_id, 'pause', 'idle', 3
      from candidate
     where status = 'running'
       and idle_seconds is not null
       and coalesce(last_seen_at, p_now) + make_interval(secs => idle_seconds) < p_now
       and not exists (
         select 1 from public.stream_grants g
          where g.container_entity_id = candidate.entity_id
            and g.revoked_at is null and g.expires_at > p_now)
       and not exists (
         select 1
           from public.edges edge
           join public.work_sessions ws on ws.entity_id = edge.src_id
          where edge.dst_id = candidate.entity_id
            and edge.type = 'runs_in'
            and ws.session_kind = 'container_exec'
            and ws.status in ('spawning','running','idle'))
  )
  select distinct on (entity_id) entity_id, action, reason
    from due
   order by entity_id, rank;
$$;

-- -----------------------------------------------------------------------------
-- 20. Surface grants (Design §3.3, §6.1, §12.4).
--
--     087's two functions, with a container and a surface in place of a work
--     session. Everything that made 087 a credential rather than an audit
--     by-product is kept: a SHA-256 hash only (the bearer never lands in the
--     database), the clamp, the atomic single-use UPDATE, and ONE refusal
--     string for every failure mode so a caller cannot distinguish expired from
--     replayed from wrong-surface from forged.
--
--     `p_multi_use` is the CDP exception (Design §16.1) and the only way past
--     60 s. It is still bound to actor + surface + container and still revoked
--     when the machine stops.
-- -----------------------------------------------------------------------------
create or replace function public.grant_surface_attach(
  p_container_id uuid, p_surface text, p_mode text, p_token_hash text,
  p_ttl interval default interval '30 seconds', p_multi_use boolean default false
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  e             public.entities;
  container_row public.containers;
  identity      text;
  grant_row     public.stream_grants;
  effective_ttl interval;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid surface grant credential' using errcode = '22023';
  end if;
  if p_surface not in ('screen','browser','adb','docker') then
    raise exception 'invalid container surface' using errcode = '22023';
  end if;
  if p_mode not in ('view','drive') then
    raise exception 'invalid stream mode' using errcode = '22023';
  end if;

  effective_ttl := case when coalesce(p_multi_use, false)
    then least(greatest(coalesce(p_ttl, interval '30 seconds'), interval '1 second'),
               interval '3600 seconds')
    else least(greatest(coalesce(p_ttl, interval '30 seconds'), interval '1 second'),
               interval '60 seconds')
  end;

  e := internal.live_entity(p_container_id, 'container');
  perform internal.require_space_member(e.space_id);
  identity := internal.identity_id();
  select * into container_row from public.containers where entity_id = p_container_id;

  -- The surface must exist ON THE RECORD before a grant to it can be minted.
  -- T-L10: the graph announces, the socket delivers — a grant to a surface the
  -- machine never announced is a grant to nothing.
  if coalesce((container_row.surfaces #>> array[p_surface, 'live'])::boolean, false) is not true then
    raise exception 'surface attach refused' using errcode = '42501';
  end if;
  if container_row.status <> 'running' then
    raise exception 'surface attach refused' using errcode = '42501';
  end if;

  if container_row.share_mode = 'none'
     and e.created_by is distinct from internal.current_member_id(e.space_id)
     and not internal.can_act_as(e.created_by, e.space_id) then
    raise exception 'surface attach refused' using errcode = '42501';
  end if;
  -- Control (Design §12.4) is the creator, or an actor the creator named with a
  -- `controls` edge.
  if p_mode = 'drive'
     and not internal.can_act_as(e.created_by, e.space_id)
     and not exists (
       select 1 from public.edges edge
        where edge.dst_id = p_container_id
          and edge.type = 'controls'
          and edge.src_id = internal.current_member_id(e.space_id)) then
    raise exception 'surface attach refused' using errcode = '42501';
  end if;

  insert into public.stream_grants(
    container_entity_id, surface, subject_identity, mode, granted_by,
    token_hash, expires_at, multi_use
  ) values (
    p_container_id, p_surface, identity, p_mode, e.created_by,
    p_token_hash, now() + effective_ttl, coalesce(p_multi_use, false)
  )
  -- The inference predicate must IMPLY the partial index's predicate, so it
  -- repeats both conjuncts. `where revoked_at is null` alone does not imply
  -- `container_entity_id is not null` and Postgres answers "there is no unique
  -- or exclusion constraint matching the ON CONFLICT specification".
  on conflict (container_entity_id, subject_identity, surface, mode)
    where revoked_at is null and container_entity_id is not null
  do update set
    token_hash = excluded.token_hash,
    expires_at = excluded.expires_at,
    multi_use  = excluded.multi_use
  returning * into grant_row;

  return jsonb_build_object('grantId', grant_row.id, 'expiresAt', grant_row.expires_at);
end
$$;

create or replace function public.consume_surface_attach(
  p_container_id uuid, p_surface text, p_mode text, p_token_hash text
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  claim_identity text := nullif(current_setting('tm8.identity_id', true), '');
  consumed       public.stream_grants;
begin
  -- All credential failures deliberately converge on the same branch. Do not
  -- report whether the container, surface, mode, hash, identity, expiry or an
  -- already-consumed row was the part that failed to match.
  if p_mode not in ('view','drive')
     or p_surface not in ('screen','browser','adb','docker')
     or p_token_hash is null
     or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'surface attach refused' using errcode = '42501';
  end if;

  update public.stream_grants
     set revoked_at = case when multi_use then null else now() end
   where container_entity_id = p_container_id
     and surface = p_surface
     and mode = p_mode
     and token_hash = p_token_hash
     and revoked_at is null
     and expires_at > now()
     and (claim_identity is null or subject_identity = claim_identity)
  returning * into consumed;

  if consumed.id is null then
    raise exception 'surface attach refused' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'containerId',     consumed.container_entity_id,
    'surface',         consumed.surface,
    'mode',            consumed.mode,
    'canDrive',        (consumed.mode = 'drive'),
    'subjectIdentity', consumed.subject_identity);
end
$$;

comment on function public.consume_surface_attach(uuid, text, text, text) is
  'Atomically consumes one short-lived hash-only CONTAINER SURFACE grant. '
  'Invalid, expired, replayed, cross-container, wrong-surface, wrong-mode and '
  'wrong-identity credentials all fail with the same refusal. A multi_use '
  'grant (the CDP exception) is verified but not revoked.';

-- -----------------------------------------------------------------------------
-- 21. `public.start_container_exec_session` (Design §8.3).
--
--     The mirror of `start_shell_session` (101 §3) with the container as the
--     single server-derived input: `node_id` and `workdir_path` are READ OFF
--     THE MACHINE, never accepted from the caller, because a PTY that claims to
--     be in a container it is not in is a lie the graph would then serve.
--
--     `p_cols` / `p_rows` ARE VALIDATED AND NOT PERSISTED, and that is
--     deliberate rather than an oversight: `work_sessions` has no terminal
--     geometry columns (checked — 001:694 plus every later `add column`), so
--     there is nowhere honest to put them. They are echoed in the result for
--     the node to size the PTY with. Adding two columns to `work_sessions` for
--     a value that changes on every window resize would be the wrong trade, and
--     the frozen signature is preserved either way.
-- -----------------------------------------------------------------------------
create or replace function public.start_container_exec_session(
  p_container_id uuid, p_title text default null, p_actor_id uuid default null,
  p_cols integer default null, p_rows integer default null,
  p_cap integer default 8, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay        jsonb;
  e             public.entities;
  container_row public.containers;
  actor         uuid;
  session_id    uuid;
  live_count    integer;
  exec_workdir  text;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.terminal.start');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    -- Bound to the CONTAINER, not to the session: the session id is minted by
    -- this call, so it cannot be the thing a replay is checked against. The
    -- container is the resource the caller addressed.
    perform internal.require_replay_subject(
      replay #>> '{containerId}', p_container_id::text, 'container');
    return replay;
  end if;

  if p_cols is not null and p_cols not between 1 and 1000 then
    raise exception 'terminal columns must be in 1..1000' using errcode = '22023';
  end if;
  if p_rows is not null and p_rows not between 1 and 1000 then
    raise exception 'terminal rows must be in 1..1000' using errcode = '22023';
  end if;

  e := internal.live_entity(p_container_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);

  select * into container_row from public.containers where entity_id = p_container_id;
  if container_row.status <> 'running' then
    raise exception 'a container must be running to exec into it (status %)', container_row.status
      using errcode = '23514';
  end if;

  -- Exec is control (Design §12.4): the creator, or an actor named by a
  -- `controls` edge the creator wrote.
  if not internal.can_act_as(e.created_by, e.space_id)
     and not exists (
       select 1 from public.edges edge
        where edge.dst_id = p_container_id
          and edge.type = 'controls'
          and edge.src_id = internal.current_member_id(e.space_id)) then
    raise exception 'exec access is limited to the machine''s owner and its controllers'
      using errcode = '42501';
  end if;

  live_count := internal.container_exec_session_count(container_row.node_id);
  if live_count >= greatest(coalesce(p_cap, 8), 1) then
    raise exception 'container exec concurrency cap reached' using errcode = '53400',
      detail = jsonb_build_object('cap', p_cap, 'live', live_count,
                                  'nodeId', container_row.node_id)::text;
  end if;

  -- `spec.workdir` is guest-side and already validated absolute by the create
  -- door's mount rules; the column CHECK (absolute, no `..`) is the backstop.
  exec_workdir := coalesce(nullif(btrim(coalesce(container_row.spec->>'workdir', '')), ''),
                           '/workspace');

  -- A ROOT, ALWAYS — 101's reasoning: the exec terminal is opened by a person
  -- or an agent against a machine, not descended from a spawning session.
  session_id := internal.create_envelope(e.space_id, 'work_session', actor, null, null);
  insert into public.work_sessions(entity_id, title, node_id, project_id, workdir_mode,
                                   workdir_path, status, session_kind)
  values (session_id, coalesce(nullif(btrim(p_title), ''), 'Terminal'),
          container_row.node_id, null, 'container',
          exec_workdir, 'spawning', 'container_exec');

  -- The binding edge. `runs_in` is the claim that this session's process tree
  -- executes INSIDE that machine — which is what lets the container reconciler
  -- end the session when the runtime goes (Design §8.3).
  insert into public.edges(space_id, src_id, dst_id, type, created_by, props)
  values (e.space_id, session_id, p_container_id, 'runs_in', actor,
          jsonb_build_object('launcher', 'container_exec'))
  on conflict (src_id, dst_id, type) do nothing;

  return internal.ledger_record(p_client_mutation_id, 'containers.terminal.start',
           jsonb_build_object(
             'sessionId', session_id,
             'containerId', p_container_id,
             'cols', p_cols,
             'rows', p_rows,
             'commandResult', internal.command_result(session_id, null,
               internal.record_activity(e.space_id, session_id, actor, 'created', null,
                 jsonb_build_object('kind', 'work_session',
                                    'sessionKind', 'container_exec',
                                    'containerId', p_container_id)),
               array[session_id, p_container_id])));
end
$$;

-- -----------------------------------------------------------------------------
-- 22. Exposed ports (Design §6.2's `http` row, §12.2).
--
--     `share_token_hash` is a hash, never a bearer — the same rule 087 applies
--     to stream grants, for the same reason: this table is replicated, backed
--     up and readable by every space member.
-- -----------------------------------------------------------------------------
create or replace function public.expose_container_port(
  p_entity_id uuid, p_expected_version integer, p_port integer,
  p_share text default 'none', p_share_token_hash text default null,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e      public.entities;
  actor  uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.expose');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  if p_port is null or p_port not between 1 and 65535 then
    raise exception 'exposed port must be in 1..65535 (got %)', p_port using errcode = '22023';
  end if;
  if coalesce(p_share, '') not in ('none','space','link') then
    raise exception 'unknown port share mode: %', p_share using errcode = '22023';
  end if;
  if p_share_token_hash is not null and p_share_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid port share credential' using errcode = '22023';
  end if;
  -- A `link` share with nothing to check is a public port wearing a private
  -- label, so the hash is required exactly there.
  if p_share = 'link' and p_share_token_hash is null then
    raise exception 'a link-shared port requires a share token hash' using errcode = '22023';
  end if;

  e := internal.live_entity(p_entity_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  insert into public.container_exposures(
    container_entity_id, port, share, share_token_hash, created_by)
  values (p_entity_id, p_port, coalesce(p_share, 'none'), p_share_token_hash, actor)
  on conflict (container_entity_id, port) do update
    set share            = excluded.share,
        share_token_hash = excluded.share_token_hash;

  -- `container_exposures` carries no snapshot trigger, so the version bump that
  -- tells the panel a port appeared has to come from the entity itself.
  update public.containers set updated_at = now() where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'containers.expose',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'container', 'port', p_port)),
             array[p_entity_id]));
end
$$;

create or replace function public.unexpose_container_port(
  p_entity_id uuid, p_expected_version integer, p_port integer,
  p_actor_id uuid default null, p_client_mutation_id text default null
) returns jsonb language plpgsql security definer set search_path = public, internal, pg_temp as $$
declare
  replay jsonb;
  e      public.entities;
  actor  uuid;
begin
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'containers.unexpose');
  if replay is not null then
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{entity,id}', p_entity_id::text, 'entity');
    return replay;
  end if;
  -- The MIRROR of expose's range check, and it is not decoration. Without it a
  -- null or out-of-range port makes `port = p_port` match nothing, the delete
  -- affects zero rows, and the door still ledgers a command, bumps the version
  -- and writes an activity row — REPORTING SUCCESS FOR SOMETHING THAT DID NOT
  -- HAPPEN. Found by auditing this file for one-sided guards: expose carried
  -- four input validations and unexpose carried none, which is the shape that
  -- appears exactly where a hazard HAS been thought about, because the care on
  -- the guarded side is what makes the mirror look already handled.
  if p_port is null or p_port not between 1 and 65535 then
    raise exception 'exposed port must be in 1..65535 (got %)', p_port using errcode = '22023';
  end if;

  e := internal.live_entity(p_entity_id, 'container');
  perform internal.require_space_member(e.space_id);
  actor := internal.resolve_actor(p_actor_id, e.space_id);
  perform internal.bind_actor(actor);
  perform internal.assert_version(p_entity_id, p_expected_version);

  delete from public.container_exposures
   where container_entity_id = p_entity_id and port = p_port;

  update public.containers set updated_at = now() where entity_id = p_entity_id;

  return internal.ledger_record(p_client_mutation_id, 'containers.unexpose',
           internal.command_result(p_entity_id, null,
             internal.record_activity(e.space_id, p_entity_id, actor, 'updated',
               null, jsonb_build_object('kind', 'container', 'unexposed', p_port)),
             array[p_entity_id]));
end
$$;

-- -----------------------------------------------------------------------------
-- 22b. The status -> CATEGORY projection (the universal tabs).
--
--     WHY THIS EXISTS. The category tabs — To Do · In Progress · Done ·
--     Cancelled — are UNIVERSAL: every kind draws them. Without this section a
--     container is seeded into the space's default workflow by
--     `internal.seed_entity_initial_status` (152:243) and NEVER MOVES AGAIN.
--     Measured on a full chain before this was written: `status_category` read
--     `to_do` at `requested` and still read `to_do` at `destroyed`, with
--     `status_id` pinned to the "To Do" state the whole way. Every machine —
--     running, stopped, destroyed — files under To Do, and In Progress and Done
--     are permanently empty.
--
--     That is not a hypothetical. It is the defect `work_session` shipped, which
--     migration 155 exists to have fixed, and whose field report its registry
--     row still carries: "477 sessions on the launch node, To Do 0 / In Progress
--     6 / Done 471 … Landing there is landing on an empty screen."
--
--     WHY THIS IS NOT 155's THREE-PIECE BRIDGE. 155 resolves the category to a
--     workflow STATE and writes `entities.status_id`, letting
--     `entities_status_from_state` (149:498) derive the category from it. That
--     works for sessions and CANNOT work for containers, and the reason is
--     measured rather than aesthetic:
--
--       `internal.category_transition_allowed` (149) refuses `done ->
--       in_progress`. Under the ruled mapping `stopped` is `done` and `running`
--       is `in_progress`, so `containers.start` on a stopped machine —
--       `stopped -> running`, a LEGAL container transition — would resolve to a
--       forbidden category edge and raise 23514 from
--       `internal.validate_status_transition`. That raise happens INSIDE
--       `public.set_container_status`, so it does not mis-file a row: IT ABORTS
--       THE DOOR. Three of this kind's twenty-three legal transitions are
--       affected (`stopped -> running`, `stopped -> destroying`,
--       `failed -> destroying`), two of them P0 acceptance steps.
--
--     Brute-forcing all 4^9 assignments against the container transition table
--     shows no way out by relabelling: holding the semantically fixed cells,
--     every consistent assignment requires `stopped = in_progress`, which
--     contradicts the ruled mapping. The conflict is structural — the category
--     algebra assumes a mostly-forward lifecycle, while a machine CYCLES
--     (`stopped -> running`) and tears down FROM EVERY BUCKET (`any ->
--     destroying`).
--
--     SO: this bridge writes the CATEGORY DIRECTLY and clears `status_id`.
--     `entities_status_from_state` is `before update of status_id` and returns
--     early when the new value is null (149:11, "Clearing a status is not a
--     transition… refusing it would make this trigger the thing standing
--     between an operator and a fix"), so the category written in the same
--     statement survives — verified on a live chain, both in one UPDATE and on
--     every later category-only write.
--
--     A container therefore has NO workflow state, and that is the honest
--     statement rather than a workaround: a machine's lifecycle is node-owned
--     and single-writer, not a workflow anyone authored. 152 seeded containers
--     into a default workflow they never asked for. Nothing downstream reads
--     `status_id` — `internal.is_resolved` (152:329) reads `status_category`,
--     151's completion gate is scoped `kind = 'task'`, and `packages/server/src`
--     contains no `status_id` reference at all.
-- -----------------------------------------------------------------------------
create or replace function internal.container_status_category(p_status text)
returns text language sql immutable set search_path = public, internal, pg_temp as $$
  select case p_status
    when 'requested'    then 'to_do'
    when 'provisioning' then 'to_do'
    when 'running'      then 'in_progress'
    when 'paused'       then 'in_progress'
    when 'stopping'     then 'in_progress'
    -- `destroying` is IN PROGRESS, not done: a provider call is still in
    -- flight, and filing it under Done shows a machine as gone while it is
    -- still being torn down. Same reasoning that routes every teardown
    -- through `destroying` in the first place.
    when 'destroying'   then 'in_progress'
    when 'stopped'      then 'done'
    when 'destroyed'    then 'done'
    -- `failed` is DONE, not cancelled, and it is 155's existing ruling rather
    -- than a new one: `cancelled` is for a thing a human decided to stop; a
    -- machine that fell over decided nothing. The failure is a badge and an
    -- `error` string, not a category, and two lifecycles of the same shape
    -- answering the universal tabs differently would be its own defect.
    when 'failed'       then 'done'
  end
$$;

comment on function internal.container_status_category(text) is
  'The RULED containers.status -> status_category mapping. Returns NULL for an '
  'unknown status rather than guessing, so a tenth status added later files '
  'nothing (visible as a missing arm) instead of filing wrongly.';

create or replace function internal.bridge_container_status_to_category() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
declare category text := internal.container_status_category(new.status);
begin
  -- No bucket for this status: leave the column alone rather than file the row
  -- under one nobody chose. 155's property, kept deliberately.
  if category is null then
    return new;
  end if;
  update public.entities
     set status_category = category,
         status_id       = null
   where id = new.entity_id
     -- The distinct-guard: without it every heartbeat-adjacent status write
     -- would emit an `entity.upsert` for a value that did not change.
     and (status_category is distinct from category or status_id is not null);
  return new;
end
$$;

-- INSERT as well as UPDATE. At birth the seeded state's category already agrees
-- with `requested`, so the category itself does not move — but `status_id`
-- still points at a workflow state this kind does not use, and leaving it there
-- until the first transition would make containers disagree with each other
-- about whether they have one. The cost is honest and worth stating: creation
-- emits a second `entity.upsert` (150's one-event law), which is acceptable
-- here and not for `create_task` because that law protects against
-- HIGH-FREQUENCY writes starving live renames, and a machine is created a
-- handful of times in its life. Heartbeats — the actual high-frequency write —
-- stay off the entity entirely (§4, §17).
--
-- THE ALTERNATIVE WAS CONSIDERED AND REJECTED, recorded so the next person who
-- notices the double `entity.upsert` does not "fix" it: seeding this at BEFORE
-- INSERT, by teaching `internal.seed_entity_initial_status` to skip workflow
-- seeding for `container`, would give one event AND a consistent row. It loses
-- on blast radius. That function is re-created by BOTH 150 and 152 and is
-- traversed by the creation of EVERY kind, so special-casing containers there
-- means joining a shared body — the hazard this file avoids twice over, in
-- `space_kind_counts` and `execution_spawn` — and putting a container-shaped
-- condition in every other kind's birth path, to save one event on an operation
-- that happens a handful of times per machine. Two events, localized entirely
-- to containers, is the better trade.
create trigger containers_category_bridge
after insert or update of status on public.containers
for each row execute function internal.bridge_container_status_to_category();

-- =============================================================================
-- 23. GRANTS — full argument signatures, every one.
--
-- 008's wholesale `grant execute on all functions in schema public to tm8_app`
-- was a ONE-TIME statement; a function created afterwards is not covered by it.
-- Postgres gives a new function EXECUTE to PUBLIC by default, so the
-- `revoke all … from public` half is the security-relevant one — and it is
-- INVISIBLE in a diff of the function, visible only in a diff of the SURFACE,
-- where its absence reds every open PR (162's whole story).
--
-- The `internal.*` helpers are NOT granted to tm8_app: they are called from
-- inside SECURITY DEFINER bodies, which run as `tm8_graph_owner`.
-- =============================================================================
revoke all on function public.create_container_entity(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,uuid,integer,text) from public;
grant execute on function public.create_container_entity(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,uuid,integer,text) to tm8_app;

revoke all on function public.update_container(uuid,integer,uuid,text,jsonb,text,jsonb,text) from public;
grant execute on function public.update_container(uuid,integer,uuid,text,jsonb,text,jsonb,text) to tm8_app;

revoke all on function public.set_container_status(uuid,text,text,jsonb,text,uuid,text,integer,text) from public;
grant execute on function public.set_container_status(uuid,text,text,jsonb,text,uuid,text,integer,text) to tm8_app;

revoke all on function public.record_container_surfaces(uuid,jsonb) from public;
grant execute on function public.record_container_surfaces(uuid,jsonb) to tm8_app;

revoke all on function public.set_container_policy(uuid,integer,jsonb,uuid,text) from public;
grant execute on function public.set_container_policy(uuid,integer,jsonb,uuid,text) to tm8_app;

revoke all on function public.record_container_drive(uuid,uuid) from public;
grant execute on function public.record_container_drive(uuid,uuid) to tm8_app;

revoke all on function public.record_container_heartbeat(uuid,text,jsonb,jsonb) from public;
grant execute on function public.record_container_heartbeat(uuid,text,jsonb,jsonb) to tm8_app;

revoke all on function public.node_containers(text) from public;
grant execute on function public.node_containers(text) to tm8_app;

revoke all on function public.sweep_containers(text,timestamptz) from public;
grant execute on function public.sweep_containers(text,timestamptz) to tm8_app;

revoke all on function public.grant_surface_attach(uuid,text,text,text,interval,boolean) from public;
grant execute on function public.grant_surface_attach(uuid,text,text,text,interval,boolean) to tm8_app;

revoke all on function public.consume_surface_attach(uuid,text,text,text) from public;
grant execute on function public.consume_surface_attach(uuid,text,text,text) to tm8_app;

revoke all on function public.start_container_exec_session(uuid,text,uuid,integer,integer,integer,text) from public;
grant execute on function public.start_container_exec_session(uuid,text,uuid,integer,integer,integer,text) to tm8_app;

revoke all on function public.expose_container_port(uuid,integer,integer,text,text,uuid,text) from public;
grant execute on function public.expose_container_port(uuid,integer,integer,text,text,uuid,text) to tm8_app;

revoke all on function public.unexpose_container_port(uuid,integer,integer,uuid,text) from public;
grant execute on function public.unexpose_container_port(uuid,integer,integer,uuid,text) to tm8_app;

-- §9 re-created this under its EXISTING signature, so 171's grant survived the
-- `create or replace`. Restated anyway: a grant that is only true by inheritance
-- is a grant nobody can verify from this file (162's idiom). OUTSIDE the owner
-- bracket for the same reason §9 is — tm8_graph_owner does not own this
-- function and cannot grant on it.
reset role;
revoke all on function public.work_session_transition(uuid,text,integer,text,uuid,text,text,text) from public;
grant execute on function public.work_session_transition(uuid,text,integer,text,uuid,text,text,text) to tm8_app;
set role tm8_graph_owner;

-- =============================================================================
-- 24. VERIFY — EXACTLY WHAT THIS FILE ESTABLISHES, AND NOT ONE THING MORE.
--
-- 162's lesson, learned the hard way: a migration is replayed at EVERY position
-- in history that has ever existed, because tranche suites
-- (`w2-profiles.pg.test.ts`, `assignment-provenance.pg.test.ts`) slice the chain
-- and replay named files mid-chain. A chain-wide assertion — "the app role's
-- whole function surface is these N names" — is TRUE at the tip and FALSE
-- mid-chain, and it fails there. So every assertion below is about an object
-- one of the statements above just created.
--
-- The `has_function_privilege` pairs are the 162 idiom: they catch the missing
-- `revoke … from public` that a function diff cannot show.
-- =============================================================================
do $verify$
declare
  door        text;
  doors       text[] := array[
    'public.create_container_entity(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,uuid,integer,text)',
    'public.update_container(uuid,integer,uuid,text,jsonb,text,jsonb,text)',
    'public.set_container_status(uuid,text,text,jsonb,text,uuid,text,integer,text)',
    'public.record_container_surfaces(uuid,jsonb)',
    'public.set_container_policy(uuid,integer,jsonb,uuid,text)',
    'public.record_container_drive(uuid,uuid)',
    'public.record_container_heartbeat(uuid,text,jsonb,jsonb)',
    'public.node_containers(text)',
    'public.sweep_containers(text,timestamptz)',
    'public.grant_surface_attach(uuid,text,text,text,interval,boolean)',
    'public.consume_surface_attach(uuid,text,text,text)',
    'public.start_container_exec_session(uuid,text,uuid,integer,integer,integer,text)',
    'public.expose_container_port(uuid,integer,integer,text,text,uuid,text)',
    'public.unexpose_container_port(uuid,integer,integer,uuid,text)'
  ];
begin
  -- 1. Every door this file creates is executable by tm8_app and by nobody else.
  foreach door in array doors loop
    if not has_function_privilege('tm8_app', door, 'EXECUTE') then
      raise exception '177: % must be executable by tm8_app', door;
    end if;
    if has_function_privilege('public', door, 'EXECUTE') then
      raise exception '177: % is still executable by PUBLIC (missing revoke)', door;
    end if;
  end loop;

  -- 2. The kind row exists, so `validate_detail_envelope('container')` can pass.
  if not exists (select 1 from public.entity_kinds
                  where kind = 'container' and space_id is null) then
    raise exception '177: the container kind row is missing';
  end if;

  -- 3. The single-writer guard is armed. Without this trigger every door in the
  --    file still works and the invariant is simply gone.
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'containers'
       and t.tgname = 'containers_guard_status'
       and t.tgenabled <> 'D') then
    raise exception '177: containers_guard_status must exist and be enabled';
  end if;

  -- 4. The status machine says what §3's header says it says. Three probes:
  --    one legal edge, one illegal edge, and the terminal state.
  if not internal.container_transition_allowed('requested', 'provisioning') then
    raise exception '177: requested -> provisioning must be legal';
  end if;
  if internal.container_transition_allowed('requested', 'running') then
    raise exception '177: requested -> running must NOT be legal';
  end if;
  if internal.container_transition_allowed('destroyed', 'running') then
    raise exception '177: destroyed is terminal';
  end if;

  -- 5. The `container` arm of entity_content exists. This is the assertion that
  --    catches the silent-drop shape described in §7 IF the drop happens in
  --    this file; the all-core-kinds test catches it when it happens in
  --    someone else's.
  if (select prosrc from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'internal' and p.proname = 'entity_content')
     not like '%when ''container'' then%' then
    raise exception '177: internal.entity_content has no container arm';
  end if;

  -- 6. The five edge types are registered, so validate_edge can enforce them.
  if (select count(*) from public.edge_types
       where type in ('runs_in','drives','mounts','snapshot_of','controls')) <> 5 then
    raise exception '177: all five container edge types must be registered';
  end if;

  -- 7. The widened CHECKs actually admit the new values.
  if not exists (
    select 1 from pg_constraint
     where conname = 'work_sessions_session_kind_check'
       and pg_get_constraintdef(oid) like '%container_exec%') then
    raise exception '177: work_sessions_session_kind_check must admit container_exec';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'work_sessions_workdir_mode_check'
       and pg_get_constraintdef(oid) like '%container%') then
    raise exception '177: work_sessions_workdir_mode_check must admit container';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'work_sessions_ended_kind_check'
       and pg_get_constraintdef(oid) like '%runtime_lost%') then
    raise exception '177: work_sessions_ended_kind_check must admit runtime_lost';
  end if;

  -- 8. `container_runtime_state` must have NO version-snapshot trigger. This is
  --    the migration-165 invariant stated as an assertion: if someone adds one,
  --    heartbeats start emitting an entity.upsert every 10 s per machine and
  --    nothing else in the codebase will complain.
  if exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
     where c.relname = 'container_runtime_state'
       and p.proname = 'snapshot_entity_version') then
    raise exception '177: container_runtime_state must NOT snapshot entity versions (165)';
  end if;

  -- 9. The category projection exists and is armed. Without the trigger the
  --    mapping function is dead code and every container files under To Do
  --    forever — the defect §22b exists to prevent, which is invisible to every
  --    other assertion in this block.
  if internal.container_status_category('destroyed') is distinct from 'done'
     or internal.container_status_category('running') is distinct from 'in_progress'
     or internal.container_status_category('requested') is distinct from 'to_do' then
    raise exception '177: internal.container_status_category does not match the ruled mapping';
  end if;
  if internal.container_status_category('not-a-status') is not null then
    raise exception '177: container_status_category must return NULL for an unknown status';
  end if;
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'containers'
       and t.tgname = 'containers_category_bridge'
       and t.tgenabled <> 'D') then
    raise exception '177: containers_category_bridge must exist and be enabled';
  end if;

  -- 10. `stream_grants` names exactly one subject per row.
  if not exists (
    select 1 from pg_constraint
     where conname = 'stream_grants_subject_check') then
    raise exception '177: stream_grants must constrain its subject to exactly one';
  end if;
end
$verify$;

reset role;
