# TM8 — Worktrees: design and phased implementation plan

**Author:** worktrees design worker (`sess_1785450789291_ekks1smst`)
**Date:** 2026-07-31
**Status:** design only. No product source was edited, no migration was run, no Git worktree was
created, nothing was committed. The working tree was dirty with three other workstreams throughout;
it was left alone.
**Supersedes:** nothing. This document did not previously exist — the worktree material lived only
as prose inside the memory/staleness design docs and as a recovered transcript digest.

---

## 0. How to read this, and what its claims are worth

Three tiers of authority appear below, and they are marked:

- **VERIFIED** — I read the file and quote a `file:line`. The tree wins over every document.
- **DESIGNED** — a decision this document makes. Binding on implementation, not yet ratified by the user.
- **PRIOR** — inherited from `sess_1785384914507_78l2n90cm` via `docs/features/foundation/NEW-ENTITIES-SESSION-DIGEST.md` §3.
  That session wrote nothing to disk; its conclusions are a strong prior from a competent reader,
  not settled fact. Where I depart from it, I say so and why.

Line numbers were taken on 2026-07-31 against a dirty tree. Treat them as hints with quoted anchors.

Two seam memos are binding companions to this document and were agreed with the sibling workers
before either of them froze a schema:

- `docs/features/foundation/MEMO-WORKTREE-SEAM-ANSWERS.md` — answers W1–W6 to the memories worker.
- `/Users/subhang/Desktop/tm8-artifacts-handoff/A-FROM-WORKTREES.md` — the confirmed
  `sourceProvenance.worktree` envelope for the artifacts worker.

---

## 1. The three-layer map: shipped, designed, pending

The seam in one sentence: **tm8 already has durable launch provenance and mutable graph
associations, and neither of them is a managed Git worktree.**

```
Server-owned filesystem / Git state          <-- LAYER 3: does not exist at all today
        |
        v
ProjectResource  --projected into each Space as a `project` entity   <-- LAYER 1: shipped
        |
        +-- worktree entity = durable graph identity + semantic lifecycle   <-- LAYER 2: designed, not built
                  |-- in_worktree edges       = mutable queryable association
                  +-- work_session.workdir_*  = immutable launch provenance   <-- shipped (columns exist, mode unreachable)
```

### 1.1 Layer 1 — shipped and load-bearing (VERIFIED)

**Projects are resources, not entities.** `public.projects` is node-scoped with a `unique
(working_dir)` and carries no hierarchy, edges, or messages — `db/migrations/001_core_graph.sql:246-262`:

```sql
create table public.projects (
  id           uuid primary key default internal.new_id(),
  name         text not null check (char_length(btrim(name)) between 1 and 200),
  repo_url     text,
  working_dir  text not null check (working_dir like '/%' and working_dir not like '%..%'),
  trust        text not null default 'untrusted' check (trust in ('trusted', 'untrusted')),
  ...
  unique (working_dir)
);
```

**Space linkage is M:N through a join table with a materialized projection.** `public.space_projects`
(`001:264-271`) is the mutable link; migration 015 adds `public.project_links` and
`public.project_projection_details` (`015_w1_foundations.sql:58-77`) plus
`internal.materialize_project_projection` (`015:894-950`), driven by a trigger on the join table
(`015:994-1023`). The effect: **each link materializes exactly one per-Space `entities` row of kind
`project`**, so ordinary graph edges can point at a project without turning a filesystem resource
into an entity. Unlinking soft-deletes the projection; the resource survives; re-linking revives the
same row and bumps `materialized_version`. Active links are capped at 16 (`015:951-989`).

**Launch provenance and association are already two different things, pointing at two different
targets.** This is the single most load-bearing shipped fact for this design, and it is stronger
than "one is immutable and one is mutable":

| | `work_sessions.project_id` | `in_project` edge |
|---|---|---|
| points at | the project **resource** (`001:698`, `on delete set null`) | the per-Space project **projection entity** (`015:35`) |
| cardinality | one, nullable | many, capped at 16 live per session (`015:685-696`) |
| mutability | immutable launch origin | ordinarily mutable for `task`/`work_session` (`015:641-643`) |
| public name | `launchProjectId` (`contract.ts:219-225`) | not directly named; read through edges |

They are seeded together — a trigger writes the initial `in_project` edge on session insert
(`015:1112-1139`) — and then diverge. `internal.guard_space_project_link` treats them as two
*independent* liveness sources when refusing an unlink (`015:970-981`). Flatten them and you
silently rewrite history.

**Execution is shipped and disciplined.** `execution.spawn` is the only session-birth path;
`work_session` is excluded from `entities.create` (S10). Trust gating and the session cap are
enforced **in SQL, not TypeScript** — `db/migrations/048_work_session_spawn_parent.sql:57-78`:

```sql
  if internal.live_work_session_count(null) >= greatest(coalesce(p_session_cap, 8), 1) then
    raise exception 'session concurrency cap reached' using errcode = '53400', ...
  ...
    if project.trust = 'untrusted' and not coalesce(p_confirm_untrusted, false) then
      raise exception 'spawning into an untrusted project requires explicit confirmation'
        using errcode = '42501', ...
```

Spawn-failure retirement (`SpawnService.ts:341-349`), PTY exit handling (`:627-675`), and startup
ghost reconciliation (`main.ts:342-347` → `SpawnService.ts:590-610`) all exist.

### 1.2 Two stale claims, corrected

**Correction 1 — `HOW-TO-TEST.md` around line 392 says `worktree` returns HTTP 501. That is stale
prose.** It never reaches the server. Three independent layers refuse it first:

- **The wire schema** (`packages/contract/src/schemas.ts:1329-1332`) is a two-member discriminated
  union of `.strict()` objects. There is no `worktree` variant, no `baseRef`, no `path`:
  ```ts
  export const SpawnWorkdirSchema: z.ZodType<SpawnWorkdir> = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('project') }).strict(),
    z.object({ mode: z.literal('scratch') }).strict(),
  ]);
  ```
- **The contract type** documents the omission deliberately (`contract.ts:1111-1115`): *"Worktree
  remains a future execution capability and is intentionally absent until the node can create one."*
- **The CLI** rejects it locally by omission from a closed set — `packages/cli/src/commands/session.ts:51-53`
  (`const WORKDIRS = ['project', 'scratch'] as const`) checked at `:70-82` and called at `:134`.
  Exit code **2** (`packages/cli/src/exit.ts:27`, `EXIT_USAGE`), message
  `--workdir expects project|scratch, got "worktree"`. **Nothing is sent to the server.**

Meanwhile the **database still reserves the value**. `001:700` originally had
`check (workdir_mode in ('project','worktree'))`; `015:302-305` widened it to include `scratch`
without dropping `worktree`. And the live spawn RPC still branches on it —
`048_work_session_spawn_parent.sql:77-78`:

```sql
    elsif coalesce(p_workdir_mode,'project') = 'worktree' then
      raise exception 'worktree mode requires a project' using errcode = '22023';
```

So a projected `worktree` **with** a project would be *accepted by the RPC today*. The gate is
entirely in the contract/CLI/UI layer, not in the database. Two more places still accept the string:
`packages/cli/src/harness/bootstrap-manifest.ts:79` (`WORKDIR_MODES` includes `worktree`), and the
identical guard branches at `007_rpc_catalog.sql:2086` and `043_spawn_replay_and_status_events.sql:61`.

*The honesty principle behind the stale 501 survives and is adopted below as the
capability-advertisement rule (§7.4): never fall back silently, and never advertise a mode the node
cannot actually service.*

**Correction 2 — no Git worktree manager exists, and symlink-safe containment is not shipped.**

I searched all of `packages/*/src` for `git worktree`, `simple-git`, `isomorphic-git`,
`spawn('git'`, `execFile('git'`, and the bare word `git`. **There are zero Git process invocations
and zero Git libraries in product source.** Process spawning in the whole product is `node-pty`
(`PtyHostService.ts`) and `node:child_process` for the Postgres sidecar (`sidecar/exec.ts:14`).
`packages/execution/src/spawn/manifest.ts:14-17` records the omission explicitly: *"Deliberately NOT
ported … worktree creation."*

Runtime cwd validation is a two-line string check — `manifest.ts:177-185`:

```ts
    const dir = context.project.workingDir;
    if (!dir.startsWith('/') || dir.includes('..')) {
      throw new SpawnError('project working directory is not a safe absolute path', 'internal', ...);
    }
```

That is: leading `/`, and the substring `..` anywhere. **No `realpath`. No symlink resolution. No
containment check against any allowed root. No normalization.** The stronger S11 rule — *"Computed
paths must resolve (after symlink resolution) inside the project root or the node's worktree area"*
— lives **only** in `docs/architecture/10-SECURITY-MODEL.md` §5. `realpath` is called in the
codebase exactly once, in `workspace-trust.ts:102,166`, and that is a config-key derivation, not a
validation.

**Two further shipped defects found during verification that the prior session did not report.**
I am recording them because worktree provisioning will inherit both:

- **`work_sessions.workdir_path` is wrong for every scratch session today.** `SpawnService.ts:160-162`
  resolves the path *before* a session id exists, yielding `<dataDir>/scratch/pending`; that value is
  persisted at `:177`. The real cwd is re-derived at `:190` as `<dataDir>/scratch/<sessionId>` and
  used for the manifest and the PTY. The graph row therefore records a path the process never used.
  Worktree provisioning must not repeat this: **the path must be computed before the DB write, from
  an id generated before the DB write** (§5.3).
- **Nothing ever cleans up a scratch directory.** No `rm` on failure, on exit, or at startup;
  `discardManifest` (`SpawnService.ts:684-686`) exists and is called from no production path. A
  worktree area with the same property would leak Git checkouts, which is why §6 makes cleanup a
  first-class, retried, reconciled obligation rather than a `finally` block.

### 1.3 Layer 2/3 — designed and pending

Nothing exists. Verified inventory of the string `worktree` in `db/migrations/`: **8 hits in 4
files, all of them either the `workdir_mode` CHECK or the "requires a project" guard branch.** No
table, no column, no path derivation, no lifecycle. No `memory`, `worktree`, or `artifact` kind
exists in the contract or the kind registry (15 core kinds, seeded at `001:311-324` and `015:29-32`).

### 1.4 What must not ship, unchanged from the prior session's verdict

- **`tm8 worktree add <path>`** — a raw client-supplied path violates the server-computed-path rule
  and S11 directly.
- **Unrestricted generic client-created worktrees** — i.e. `entities.create` with `kind: 'worktree'`.
  §4.4 makes this structurally impossible rather than merely discouraged.

---

## 2. The worktree entity

### 2.1 Kind registration (DESIGNED)

```sql
insert into public.entity_kinds(kind, origin, space_id, icon) values
  ('worktree', 'core', null, 'git-branch')
on conflict (kind) where space_id is null do nothing;
```

Following the only precedent for adding a core kind after the baseline (`015:29-32`). Constraints
this inherits, all VERIFIED:

- `kind` is **not** an enum and **not** a CHECK. It is `text` validated by
  `internal.validate_entity_kind()` against `public.entity_kinds` (`001:358-375`).
- `entity_kinds_origin_shape` (`001:299-303`) requires `origin='core'` ⟹ `space_id is null` and
  `kind !~ '^c:'`.
- `entity_kinds_guard_core` (`005_custom_kinds.sql:238`) blocks update/delete of core rows. **An
  added core kind is permanent.** This is a one-way door and should be treated as such at gate G1.
- The SQL row alone is **not enough and failing to pair it is fatal**: `packages/contract/src/contract.ts:31-36`
  freezes `CoreEntityKind`, and `packages/server/src/events/projector.ts:63` throws
  `EntityKindDriftError` at runtime for any DB kind outside that union. SQL and TypeScript must land
  in the same change.

### 2.2 Detail table (DESIGNED)

```sql
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
```

Design notes, each with a reason:

- **`entity_id` and `updated_at` are named exactly that on purpose.** `internal.snapshot_entity_version()`
  reads `new.entity_id` and `new.updated_at` **unqualified** (`001:1130-1176`). Rename either and the
  trigger raises at runtime, not at migration time.
- **`project_id` is `on delete restrict`, not `set null`.** A worktree without a project is
  meaningless — it is a checkout *of* something. This deliberately differs from
  `work_sessions.project_id` (`001:698`, `on delete set null`), where a null means "projectless
  scratch session," a legitimate state.
- **`base_commit_oid` is `not null` and immutable.** This is the field that makes `base_ref`
  reproducible, and it is the one fact the artifacts worker's provenance envelope genuinely needs
  from me. Refs move; a resolved OID does not. Resolved once, at `git worktree add` time.
- **No `head_commit_oid`, no `tree_digest`, no `dirty` column.** Those are point-in-time samples of
  a checkout, not properties of an allocation. Storing them guarantees they will be stale, and a
  stale digest is worse than an absent one. Consumers sample Git at the moment they need them.
- **No operational state.** See §3 — this is a structural guarantee, not a convention.
- **`unique (path)` and `unique (project_id, branch)`** implement "unique computed paths and
  branches, with no silent queuing" (PRIOR amendment 5) at the storage layer, so a collision is a
  `23505` rather than a race that quietly reuses someone else's checkout.

### 2.3 Semantic lifecycle (DESIGNED)

```
                 +--> merged  --+
   active -------|              +--> deleted
                 +--> abandoned-+
```

Forward-only. `active` is never a legal target. `deleted` is terminal. Self-transitions are
idempotent no-ops. This mirrors the shape of the shipped work-session transition function
(`043_spawn_replay_and_status_events.sql:105-118`), including the `select ... for update` before the
decision.

Meanings, stated precisely because the whole staleness mechanic keys off them:

| status | means | does **not** mean |
|---|---|---|
| `active` | the branch is live work | the directory exists on disk (see §3) |
| `merged` | a human or agent **recorded** that the branch landed, and the server did not refuse the claim (§9.1) | the server observed a merge |
| `abandoned` | the work was explicitly given up | the server inferred it from silence |
| `deleted` | the working directory has been removed from disk | the graph node is gone |

**`deleted` is a semantic status, not a graph deletion.** The entity's `deleted_at` is a separate,
subsequent write. Both fire on a normal delete, in that order. The memories worker's derivation
must let `basisDeleted` win over `basisMoved`; that is settled in the seam memo (W5).

### 2.4 Snapshot trigger — ship-blocker 1 (DESIGNED, and non-negotiable)

```sql
create trigger worktrees_touch_updated_at before update on public.worktrees
for each row execute function internal.touch_updated_at();

create trigger worktrees_snapshot_version after update on public.worktrees
for each row execute function internal.snapshot_entity_version();
```

plus `internal.record_initial_version(entity_id, actor)` inside `create_worktree` (`001:1211-1217`).

**Why this is a ship-blocker and not a nicety (VERIFIED).** Version advancement is **per-table
opt-in**. `internal.snapshot_entity_version()` (`001:1130-1176`) is attached to exactly **11** detail
tables — `tasks`, `documents`, `spells`, `skills`, `collections` (001), `team_members` (002),
`custom_entities` (005), `channels`, `files`, `pull_requests`, `commits` (017). There is no event
trigger and no registry-driven attachment.

And the cited precedent is a precedent for the *omission*: `grep snapshot_entity_version
db/migrations/015_w1_foundations.sql` returns **zero matches** while 015 creates 28 other triggers.
015 also never calls `record_initial_version`, so `project` entities have **no `entity_versions` rows
at all**. That is a *projection* kind opting out of versioning entirely; `worktree` is an *authored*
kind and opts in on both counts.

Without the trigger: a merge transition writes the detail row, `entities.version` stays put, no
pinned memory drifts, no badge fires, no sweep row appears. **Silence, in the reassuring
direction** — the exact failure class the staleness design exists to close.

**A property of the trigger that consumers must design around, which I do not think has been stated
anywhere yet.** It **debounces** (`001:1127-1128,1156-1167`): a second write by the same actor
inside `internal.version_debounce_window()` (5 minutes) **overwrites the existing `entity_versions`
row** rather than inserting a new one — while still bumping `entities.version`. The
`pinnedVersion < target.version` formula is therefore safe, but any derivation that walks
`entity_versions` history sees a **collapsed** history. A worktree going `active → merged` then
`merged → deleted` inside five minutes under one actor — which is the **normal** cleanup path —
produces two version bumps and one snapshot row. Read that as compression, not data loss.

### 2.5 Patch door — ship-blocker 2 (DESIGNED)

`entities.patch` dispatches per kind in TypeScript (`packages/server/src/facade/services/w2/entities-commands-tracking.ts:1039-1108`);
a core kind with no `case` hits `throw new CollabError('not_implemented', …)`. So
`update_worktree` is required or the lifecycle transition is unreachable.

**The apparent contradiction, and its resolution.** `patchEntity` calls `assertGenericLifecycle`
*before* the switch, and kinds in `RESTRICTED_LIFECYCLE_KINDS` (`:56-62` —
`member`, `message`, `work_session`, `project`, `interaction_profile`) are refused outright. I want a
server-owned lifecycle, which reads like a reason to add `worktree` to that set — but doing so makes
the patch door unreachable, defeating ship-blocker 2.

**Resolution: `worktree` is NOT added to `RESTRICTED_LIFECYCLE_KINDS`. The door itself owns the
semantics.** `update_worktree` accepts exactly two things — a `status` transition and
`expectedVersion` — and refuses everything else. `path`, `branch`, `base_ref`, `base_commit_oid` and
`project_id` are **immutable after creation**; a patch naming them is `invalid_input`, not a silent
drop. That is what makes generic-shaped patch safe here: the client supplies intent, the server
owns every consequence. It also keeps the zero-new-operation shape the prior session wanted
(PRIOR §5), because CLI transition sugar routes through `entities.patch`.

The door must reproduce the full post-038 sequence. The model is `update_channel`
(`038_w2_sec1_stage2_entities_patch_resource_binding.sql:58-91`), and the ordering is not optional:

```
require_replay_principal(cmid)
  -> ledger_replay(cmid, 'entities.patch')
       -> replay branch: require_replay_principal AGAIN (runs with the advisory lock HELD)
                         require_replay_subject(replay #>> '{entity,id}', p_entity_id::text, 'entity')
  -> live_entity(p_entity_id, 'worktree')
  -> require_space_member(e.space_id)
  -> resolve_actor / bind_actor
  -> assert_version(p_entity_id, p_expected_version)     -- 014_assert_version_locks.sql:60 is live
  -> set claim tm8.worktree_transition = 'on'
  -> UPDATE public.worktrees ...                          -- detail table ONLY; never touch entities.version
  -> reset claim
  -> ledger_record(... command_result(... record_activity ...))
```

Binding is `{entity,id}` against the door's own first argument, matching 038's eleven doors —
**not** 036's `{entity,space_id}` shape, because like those eleven this function takes no
`p_space_id` (`038:31-33`).

Note the review's F2 concern (`reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`): the
`entities.patch` label's eleven existing doors are recorded as unbound in
`W0-W5-HANDOFF-STATE.md:2733`. This design **extends the 036/038 binding pattern to door twelve
rather than inheriting the gap**, and says so explicitly rather than by silence — which is how that
incident happened the first time.

### 2.6 Single-writer status guard, R29 shape (DESIGNED)

```sql
-- before update of status on public.worktrees
if new.status is distinct from old.status
   and coalesce(internal.claim_text('tm8.worktree_transition'), '') <> 'on' then
  raise exception 'worktree.status has a single writer: the worktree transition door'
    using errcode = '23514', detail = 'call public.update_worktree(...)';
end if;
if new.status is distinct from old.status then new.status_changed_at := now(); end if;
```

Modelled on `work_sessions_guard_status` (`001:730-747`). **The R29 shape is required, not optional,
because three writers plausibly exist:** an agent/CLI recording an observed merge; the delete path
driven from CLI or UI; and startup reconciliation, a server-internal writer with no user in the
loop. Three writers with different trust postures and different preflight obligations is exactly the
condition R29 was introduced for.

### 2.7 Create door (DESIGNED)

`public.create_worktree(p_space_id, p_project_id, p_path, p_branch, p_base_ref, p_base_commit_oid,
p_actor_id, p_client_mutation_id)`, `security definer`, ledger label **`execution.spawn`** — not
`entities.create`. It calls `internal.create_envelope(p_space_id, 'worktree', actor, null, null)`
and `internal.record_initial_version`.

**`worktree` is excluded from the `createEntity` dispatch switch** (`entities-commands-tracking.ts:962-1037`),
whose `default` arm throws `forbidden` for non-`c:` kinds. That is amendment 1 made structural:
there is no client-reachable path that creates a worktree entity, because the only caller of
`create_worktree` is the server's own provisioning saga. The public `CreateEntityInput.kind`
`Exclude<>` at `contract.ts:713` gains `'worktree'` so the refusal is visible in the type, not just
at runtime.

### 2.8 Edge registry (DESIGNED)

```sql
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
```

- `src_kinds` mirrors `in_project` (`015:35`). `memory` is deliberately **not** a source kind:
  memories reach a worktree through `based_on`, a pinned epistemic edge, not an association.
- **It must carry its own `props_schema`.** Migration 018's bulk `UPDATE` (`018:19-59`) has already
  run and will not sweep a later-registered row; `internal.validate_edge_props_schema` short-circuits
  on a NULL schema (`018:103`), so omitting it means *no props validation at all*.
- **Mutable, not append-only.** `in_worktree` is **not** added to the recorder-owned writer list at
  `015:615-624`, so it stays correctable through generic `edges.create` / `edges.delete`.
- **No unique index.** The `one-per-source` hazard the artifacts worker found on `authored_from`
  (`015:295-296`) is deliberately not reproduced here.
- The registry **cannot express cardinality** (VERIFIED — `public.edge_types` at `001:751-760` has
  `src_kinds`, `dst_kinds`, `description`, `props_schema`, `acyclic`, and no cardinality column).
  Uniqueness is per-triple only, via `unique (src_id, dst_id, type)` (`001:772`). Any "at most one
  live worktree per session" rule is a guard-trigger concern, not a registry one — and this design
  does not impose one, because a session legitimately reads several worktrees.

**`props.origin` stamping needs exactly one line in a shared W1 guard — resolved, see below.**
`internal.guard_w1_edge` (`015:592-703`, trigger attached at `:704`) has **two** distinct branches
that matter here, and conflating them caused a round-trip with the sibling workers:

- the **recorder-ownership** branch (`015:615-624`), which refuses a write unless the W1 writer token
  matches a per-type value. **`in_worktree` deliberately stays OUT of this branch** — that is what
  makes it an ordinarily mutable association rather than server-owned provenance.
- the **`props.origin` stamping** branch (`015:619-620`), which stamps
  `coalesce(nullif(writer,''), 'user')` for `in_project` and `participates_in`. **`in_worktree` joins
  this one**, so a spawn-created association is distinguishable from a hand-drawn one. The change is
  a single array element:
  ```sql
  if new.type in ('in_project','participates_in','in_worktree') then
  ```

Because `create or replace` swaps the **entire** ~112-line function body, two feature migrations
re-declaring it means the lexically later filename silently wins and the earlier one's changes
vanish with no error. All three concurrent designs need to touch it.

**Resolution (agreed with the artifacts worker, 2026-07-31):** neither the `edge_types` array
widenings nor the guard body lives in any feature migration. One shared prerequisite migration —
`051_edge_guard_multi_kind.sql`, owned by the artifacts worker — lands **first** and owns both, with
a single `create or replace internal.guard_w1_edge` carrying every feature's change: the
recorder-ownership equality generalized to a per-type permitted-writer **set**, and the one-element
stamping addition above. Feature migrations are then purely additive and no shared object is ever
re-declared twice. Gate G0.3 tracks it.

Writer token claimed for this design: **`worktree_manager`** (artifacts holds `artifact_publisher`,
memories holds `memory_recorder`). It is claimed for the provisioning saga's server-origin stamping,
**not** for recorder ownership.

### 2.9 The rest of the plug-in surface (VERIFIED requirements, easy to forget)

- **`internal.entity_content()` needs a `worktree` arm.** The live definition is
  `017_w2_entities_commands_tracking.sql:16-46` (four earlier redefinitions exist). **Omitting this
  is the exact bug migration 011 exists to document: content silently returns `{}`.**
- **RLS and grants are not inherited.** `001:1227-1228` revokes all function privileges from public,
  and `008_rls_policies.sql:250-252` states the intent: *"a new table is unreadable until a migration
  says otherwise. Failing closed is the point."* So: `enable row level security`, a select policy
  gated on `internal.entity_readable(entity_id)` (008's pattern at `:88-108`), and
  `revoke ... / grant execute ... to tm8_app` **with full argument-type signatures** (017's pattern
  at `:685-700`).
- **`entity-read.ts` needs a `left join public.worktrees`** in the universal read.
- **`tools/conformance/src/foundations/kind-dispositions.ts`** is typed over `CoreEntityKind` and
  will fail to compile until updated. That is a feature.
- **`MenuKindRef` (`contract.ts:876`)** — worktree is *not* a menu-creatable kind (§2.7).

---

## 3. The operational allocation and lease model, kept structurally distinct

### 3.1 Why two state machines (PRIOR, adopted, and strengthened)

The prior session's argument stands: conflating disk health with semantic lifecycle *"lets a
half-created directory masquerade as an active worktree."* I am adopting it and adding the
mechanism that makes it a guarantee rather than a discipline.

### 3.2 The table (DESIGNED)

```sql
create table public.worktree_allocations (
  worktree_entity_id uuid primary key references public.entities(id) on delete cascade,
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
create unique index worktree_allocations_lease_idx
  on public.worktree_allocations(lease_session_id) where lease_session_id is not null;
```

**This table is not entity-backed.** It has no `entities` row of its own, no `entity_id` column, and
— decisively — **no `snapshot_entity_version` trigger attached, because that trigger is per-table
and I do not attach it here.**

That is the structural guarantee the memories worker asked for (W3): a write to
`worktree_allocations` has **no path** to `entities.version`, because no trigger connects them.
Disk-health flap is *mechanically incapable* of drifting a pinned memory. The invariant — **one
entity version bump per semantic transition, zero for operational churn** — is enforced by schema
topology, not by reviewer vigilance, and §8's test matrix hammers the allocation row through every
state asserting `entities.version` is unchanged.

### 3.3 Operational states

| state | means | who sets it |
|---|---|---|
| `preparing` | reserved; Git has not finished | provisioning saga, step 4 |
| `ready` | directory exists, `git worktree list` agrees | provisioning saga, step 7 |
| `cleanup_pending` | removal owed; retry idempotently | transition door, or reconciliation |
| `missing` | the directory is gone from disk, unexpectedly | reconciliation only |
| `failed` | provisioning failed; `failure_code`/`failure_detail` populated | provisioning saga, any step |

The two cross-products worth stating, because they are the ones people get wrong:

- **`status='active'` + `state='missing'` is a legal, expected state.** The graph must not claim a
  merge or an abandonment it did not observe (§9.2). Absence of a directory is not evidence about
  the work. Consumers who need disk truth read `state`; consumers who need epistemic truth read
  `status`. A memory pinned to such a worktree correctly reads as undrifted — nothing about the
  claim's basis changed, only the disk.
- **`status='merged'` + `state='ready'` is also legal** — merged work whose checkout has not been
  cleaned up yet. `merged` does not imply removal.

### 3.4 The lease

One **write-capable live-session lease per physical worktree**, enforced by the partial unique index
above. `lease_session_id` points at a `work_session` entity.

- Acquired inside the provisioning transaction, or on reuse of an existing worktree.
- **Released on session exit — the lease, not the work.** Dirty or unmerged content is preserved;
  release means "no live session owns this," never "this is safe to delete."
- Reuse of a leased worktree is refused with `limit_exceeded`, **not queued**. Silent queuing turns
  a capacity error into an unexplained hang.
- Release is idempotent and is driven from the same PTY-exit path that already writes the session
  transition (`SpawnService.ts:627-675`), plus reconciliation as a backstop — because that path
  has a known hole: it pops claims from a **process-local** `sessionAuth` map (`:632-640`) and
  returns without writing when the map is empty, which is every session after a restart.

---

## 4. The provisioning saga

Public intent in, server-owned everything else. Each step names its failure behavior; a step that
fails leaves the system in a state the reconciler (§6) can finish or undo.

### 4.1 Step 0 — admission (before anything is reserved)

| check | failure |
|---|---|
| Space membership, identity, capability | `forbidden` / `unauthorized` (existing paths) |
| `projectId` present | `invalid_input` — worktree mode **requires** a project, matching the shipped guard at `048:77` |
| Project linked to this Space (`space_projects`) | `forbidden`, `project is not linked to this space` — reuse `048:67-71` |
| `trust='untrusted'` without `confirmUntrusted` | `forbidden` — reuse `048:72-78`. **No new trust concept.** |
| node live-session cap | `limit_exceeded` — reuse `internal.live_work_session_count` (`048:57-61`) |
| **worktree/disk cap** (new, configurable, separate) | `limit_exceeded`, `worktree_cap` |

The worktree cap is deliberately separate from the session cap: they bound different scarce
resources (concurrent processes vs. disk and Git-metadata footprint), and one worktree can outlive
many sessions.

### 4.2 Step 1 — repository validation

Canonicalize `project.working_dir` with `realpath`. Confirm it is a Git repository
(`git rev-parse --git-dir`). **Failure: `invalid_input`, `not_a_git_repository`** — never a fallback
to project mode. Falling back silently is the failure this whole design is an argument against.

### 4.3 Step 2 — base ref resolution

Resolve the requested `baseRef` (default: the repo's current `HEAD` symbolic branch) to a 40-hex
commit OID via `git rev-parse --verify <ref>^{commit}`.

- Unknown ref → `invalid_input`, `base_ref_not_found`.
- **The resolved OID is what gets stored**, and the symbolic ref is stored alongside it as
  provenance only. Refs move; this is the difference between a reproducible record and a plausible one.

### 4.4 Step 3 — path and branch computation (S11 containment)

**Server-computed, always.** No client input reaches this step.

```
worktreeId   := generated uuid          -- generated HERE, before any DB write
branch       := tm8/<worktreeId>        -- the WHOLE id; a truncated one collides (see below)
worktreeRoot := realpath(<dataDir>/worktrees)
path         := <worktreeRoot>/<projectId>/<worktreeId>
```

Containment, per S11:

1. `realpath` the **worktree root** and the **repository root**. If either contains a symlink
   component that escapes, refuse.
2. `realpath` the **parent** of the computed path (the leaf does not exist yet) and assert it is a
   prefix-boundary-aware descendant of `worktreeRoot` — i.e. compare **path segments**, never
   `String.startsWith`, so `/data/worktrees-evil` cannot pass as inside `/data/worktrees`.
3. After creation, `realpath` the created directory and re-assert containment. **A check before
   creation is a check against a path that does not exist yet**; the post-creation assertion is what
   actually closes the symlink race. Failure here is a cleanup obligation, not a warning.

Failure at any point: `invalid_input`, and **the allocation is not reserved**.

Note this is strictly stronger than the shipped `manifest.ts:177-185` check, which this design does
not modify (that is Layer-1 work outside this scope) but does supersede for worktree paths.

### 4.5 Step 4 — reserve, under a per-project lock

Acquire the per-project Git lock (§5.1), then in one transaction insert the
`worktree_allocations` row in `state='preparing'` with the generated id, computed path, and branch.
`unique (path)` and `unique (project_id, branch)` on `public.worktrees`, plus the allocation PK,
make a collision a `23505` rather than a silent reuse.

Failure: nothing was created on disk; the row is set `failed`. A `preparing` row with no directory
is the canonical safe partial the reconciler cleans (§6.2).

### 4.6 Step 5 — `git worktree add`, argv-only

```
git -C <repoRoot> worktree add --detach=false -b <branch> <path> <baseCommitOid>
```

invoked as an **argv array through `execFile`, never a shell string, never string interpolation**
(amendment 5; and there is no existing Git invocation to imitate, so the pattern is set here). The
base is the **resolved OID**, not the symbolic ref — so a ref that moves between step 2 and step 5
cannot silently change what was checked out.

Failure: allocation → `failed` with `failure_code` and `git` stderr in `failure_detail`; if a
directory was partially created, → `cleanup_pending` instead, so §6 removes it.

### 4.7 Step 6 — one database transaction

Create, atomically: the `worktree` entity (via `create_worktree`, which also writes the initial
version row); the `work_session` row through the existing `execution_spawn` RPC with
`workdir_mode='worktree'` and `workdir_path=<path>` as **immutable launch provenance**; the
`in_worktree` edge; and the lease on the allocation row.

**This is where the shipped scratch-path defect must not be repeated.** The path persisted here is
the same string that step 5 created and step 4.4.3 re-validated, because the id was generated at
step 4.4 rather than derived from a session id that does not exist yet.

Failure: transaction rolls back; the on-disk worktree is now orphaned → allocation `cleanup_pending`.
The reconciler removes it. This is the one window where disk leads the database, and it is
deliberately the *safe* direction: an unreferenced directory is recoverable, a database row pointing
at nothing is not.

### 4.8 Step 7 — publish and spawn

Allocation → `ready`. Then the existing spawn path proceeds unchanged: manifest, workspace trust
seeding, PTY, transition to `running`.

Failure after `ready`: the existing spawn-failure retirement runs (`SpawnService.ts:341-349`); the
lease is released; **the worktree is preserved**, because a failed spawn says nothing about the value
of the checkout.

---

## 5. Concurrency, caps, cleanup

### 5.1 Per-project serialization for Git administrative operations

`git worktree add/remove/prune` mutate shared repository metadata (`.git/worktrees/`), so they must
serialize per repository.

Primitive: `pg_advisory_xact_lock(pg_catalog.hashtextextended('worktree:' || projectId, 0))`,
the same primitive the ledger already uses for mutation-id serialization
(`016_w2_identity_spaces.sql:12-26`).

**A real hazard, VERIFIED and easy to trip:** `internal.ledger_replay` is the *first* statement of
`public.execution_spawn` (`048:34`) and takes an advisory lock keyed on the mutation id. So every
spawn **already runs under an advisory lock**, and nesting a project lock beneath it is exactly the
deadlock pattern `036:100-105` and `032:123-129` warn about. Therefore: **the per-project Git lock is
acquired outside and before the ledgered transaction**, in the node's WorktreeManager, and is held
across steps 4–7 as an in-process keyed mutex *plus* the advisory lock taken in the reservation
transaction only. The existing in-process mutex (`workspace-trust.ts:45-60`) is a single global
promise chain and must be generalized to a `Map<projectId, Promise>` — that generalization is a named
Phase-1 work item, not an assumption.

### 5.2 Caps

- Node live-session cap: **unchanged**, reused as-is. (Correcting the documentation while I am here:
  it is not per-node. `internal.live_work_session_count(null)` counts **globally**, `048:57-61`.)
- Worktree cap: new, separate, configurable, enforced at step 0. Refuse with `limit_exceeded`.
- Lease: one write-capable live session per worktree, partial unique index, **no queuing**.

### 5.3 Cleanup

Single server-owned path, analogous to the guarded work-session status writer.

Delete refuses when:
- a live lease exists → `conflict`;
- the worktree is **dirty** (`git status --porcelain` non-empty) → `conflict`, `dirty_worktree`;
- the branch has **unpushed** commits not reachable from any remote ref → `conflict`, `unpushed_commits`;

unless `force: true` is explicitly supplied. **`force` is never a default, never inferred from a
`--yes`, and is echoed in the confirmation copy.**

Then: `git worktree remove <path>` followed by `git worktree prune`, both argv-only, both under the
per-project lock, both idempotent. Failure leaves `state='cleanup_pending'` with `attempts`
incremented; a bounded-backoff retry runs on the reconciliation tick. **Cleanup never blocks the
semantic transition** — the entity may be `deleted` while the allocation is still
`cleanup_pending`, and that asymmetry is deliberate: the graph records what was decided, the
allocation records what has actually happened on disk.

### 5.4 The preflight token, and the TOCTOU window it closes

The dirty/unpushed checks are **Git reads**, and `update_worktree` is a SQL function that cannot run
Git. So the checks happen in the TypeScript `case 'worktree':` arm of `patchEntity`, before the RPC —
which opens a window in which the tree changes between check and commit.

Closing it: the preflight writes `preflight_token` (a digest over the Git preflight result) and
`preflight_at` to the allocation row. `update_worktree` locks that row `FOR UPDATE` inside its
transaction and refuses a token that is absent, mismatched, or older than a short TTL
(`conflict`, `stale_preflight`). The client retries; the retry re-reads Git.

**Stated as a cost, not hidden:** this makes the `worktree` patch arm the only one of the twelve that
performs I/O around its RPC. That is a genuine departure from the shape of the other eleven, and it
is the price of a lifecycle whose truth lives outside Postgres. The alternative — trusting the
client's assertion that the tree is clean — is worse.

---

## 6. Startup reconciliation

### 6.1 What it compares

Five sources, cross-checked: `worktree_allocations` rows for this node; `git worktree list
--porcelain` per project; filesystem entries under `<dataDir>/worktrees/<projectId>/`; `worktree`
entities and their `status`; and live PTYs.

It extends, and must not duplicate, the shipped ghost reconciliation
(`main.ts:342-347` → `execution-handlers.ts:345-360` → `SpawnService.ts:590-610`), whose documented
limits it inherits: rows with a different or NULL `node_id` are left alone; it never throws; and
`nodeId` defaults to `` `${config.host}:${config.port}` `` (`execution-handlers.ts:528`), so **a node
whose port changes orphans its own prior rows permanently.** For sessions that is a stuck row; for
worktrees it would be a leaked Git checkout, which is worse. Phase 4 must therefore give worktree
allocations a **stable node identity** rather than a host:port string. Named as a work item, not
waved at.

### 6.2 Repairs it may make

| observed | repair |
|---|---|
| `preparing`, no directory, no Git entry | `failed`; safe to retry |
| `preparing`, directory exists, no Git entry | remove directory, `failed` |
| `preparing`, Git entry exists, no DB entity | `cleanup_pending`; remove |
| `ready`, directory gone | `missing` — **status untouched** |
| `cleanup_pending` | retry `remove` + `prune`, bounded backoff |
| lease held by a session with no live PTY and a terminal status | release lease |
| Git entry with no allocation row at all | **quarantine, do not delete** |

### 6.3 What it must never do

- **Never infer `merged` or `abandoned`.** Absence of evidence is not a merge. No timeout, no
  heuristic, no "the branch is gone so it must have landed."
- **Never delete an unrecognized Git worktree.** The repository may be shared with a human's own
  worktrees. Quarantine means: record it, surface it, touch nothing.
- **Never write `status` outside `update_worktree`** — the R29 guard makes this a `23514` rather
  than a code-review question.
- **Never throw.** Reconciliation is cleanup, not a precondition for serving traffic
  (`main.ts:329-341`).

---

## 7. Public surface

### 7.1 Spawn: intent, never paths

```ts
export type SpawnWorkdir =
  | { mode: 'project' }
  | { mode: 'scratch' }
  | { mode: 'worktree'; baseRef?: string }      // new allocation
  | { mode: 'worktree'; worktreeId: WorktreeId }; // reuse an existing one
```

`.strict()` on every member, as today. **No `path` field exists in any variant** — that is amendment
2 made structural rather than documentary. `baseRef` is a symbolic ref, validated and resolved
server-side; a client cannot supply an OID either, because supplying one would let a client pin a
commit the server never validated against the repository.

### 7.2 CLI

- `tm8 session spawn --workdir worktree [--base-ref <ref>] [--worktree <id>]` — the closed set at
  `session.ts:51-53` gains `worktree`, and the rationale comment at `session.ts:20-25` and the
  discovery string at `discovery/operations.ts:950` are updated in the same change, because a stale
  "not advertised until the node can create one safely" is precisely the kind of prose this
  document's §1.2 had to correct.
- `tm8 worktree list [--project <id>] [--status <s>]`
- `tm8 worktree merged|abandon|delete <id> [--force]` — **sugar over `entities.patch`**, adding zero
  catalog operations. The catalog is at **110** operations (VERIFIED), and this design keeps it there.
- **`tm8 worktree add <path>` does not exist**, and there is no flag anywhere that accepts a path.

### 7.3 UI

Launch offers Project / Scratch / **Isolated worktree**. When worktree is chosen: the resolved base
**commit** is shown next to the ref (because the ref alone is not what you get); an existing-active
chooser lists reusable worktrees with lease, dirty, and cleanup health read from
`worktree_allocations`; destructive actions require explicit confirmation naming the branch, and
`force` is a separate deliberate affordance, never bundled into "confirm."

Both UIs currently hardcode a workdir (`packages/ui/src/real/RealFacade.ts:544-550` always sends
`{mode:'project'}`; `packages/tm8-ui/src/domain/launch.ts:515` picks scratch or project), so this is
additive in both.

### 7.4 The capability-advertisement rule

**The CLI and UI advertise worktree mode only when the server reports the capability as operational
for the target project.** Operational means: a Git repository was found, the worktree root
canonicalized, and the cap not exhausted. Where it is not operational, the mode is **absent from the
choices**, and an explicit request returns a *specific* error naming the reason.

Three prohibitions, in order of how tempting they are:

1. **Never fall back silently** to project or scratch mode. This is the surviving principle from the
   stale 501 prose (§1.2), and it is the whole point.
2. **Never advertise before the node can service it.** The shipped CLI already gets this right by
   omitting `worktree` from a closed set rather than sending it and hoping; keep that discipline.
3. **Never let the database be the gate.** Today `048:77` would accept `workdir_mode='worktree'` with
   a project attached, and only the contract layer stops it. Phase 1 must land the manager and the
   contract change together, because the layer that is currently holding the line is the one being
   opened.

---

## 8. Security

| id | rule | status | this design |
|---|---|---|---|
| **S10** | spawn only through the catalog; `work_session` excluded from `entities.create` | shipped | extended: `worktree` also excluded from `entities.create` (§2.7) |
| **S11** | server-computed paths; must resolve **after symlink resolution** inside the project root or the node's worktree area | **design-only today** — runtime checks absolute shape and `..` (`manifest.ts:177-185`) | implemented for worktree paths: §4.4, with segment-wise containment and a **post-creation re-assertion** |
| **S12** | `trust` gating with per-spawn `confirmUntrusted` | shipped in SQL (`048:72-78`) | reused unchanged; no new trust concept, no worktree-specific bypass |
| — | Git invoked as an **argv array**, never a shell string | no Git exists | §4.6; the pattern is established here because there is nothing to imitate |
| — | per-project serialization of Git admin ops | no primitive is keyed | §5.1, including the ledger-lock nesting hazard |
| — | dirty/unpushed protection; `force` explicit | n/a | §5.3 |

Two security notes I want on the record:

- **The argv rule is the highest-value item in this table.** A `baseRef` is client-supplied text that
  reaches a Git command line. Every other control here mitigates a mistake; this one prevents a
  command injection. `execFile` with an argv array, no `shell: true`, no template strings, and a
  ref-shape validation on top as defense in depth.
- **`realpath` before creation is not sufficient**, because the leaf does not exist yet. The
  post-creation re-assertion (§4.4.3) is the check that actually closes the symlink race, and it is
  the one most likely to be dropped as redundant during implementation.

---

## 9. Phased implementation plan

Ordering follows the prior session's proposal (storage/contracts → manager → spawn → recovery →
CLI/UI → tests), with one deliberate change: **crash and concurrency tests move from a final phase
into the gate of each phase that can produce the failure.** A test suite that arrives last tests a
design nobody can still change.

### Phase 0 — freeze the seams (no code)

Deliverables: this document; the two seam memos; ownership of `internal.guard_w1_edge` resolved with
the artifacts worker.

**Gate G0** — all pass before Phase 1 opens:
1. Memories worker has frozen a schema against W1–W6. *(Answered in `MEMO-WORKTREE-SEAM-ANSWERS.md`.)*
2. Artifacts worker has accepted the corrected envelope, including the two rejected fields.
3. **G0.3 — the shared prerequisite migration `051_edge_guard_multi_kind.sql` has landed**, owned by
   the artifacts worker, carrying every `edge_types` widening and the single
   `create or replace internal.guard_w1_edge`. **No feature migration may re-declare that function.**
   This is a shared-hazard gate, not paperwork: `create or replace` swaps a ~112-line body with no
   error, so a collision is invisible until someone tests the exact branch that vanished, and the
   recovery is a third migration.
4. User ratification that adding the core kind `worktree` is a **one-way door** (`005:238`).

### Phase 1 — storage and contract

Migration **054** — `051` is the shared prerequisite (G0.3), `052`/`053` are the artifacts and
memories feature migrations; the relative order of the three feature migrations does not matter once
051 has landed, so 054 is a placeholder for "after the shared one." Numbering rules VERIFIED: 025,
026 and 028 are absent from the sequence; gaps are fine, reuse is not (`migrate.mjs:129-133`).

Bill of materials, and every line of it is required:

1. `entity_kinds` seed row.
2. `public.worktrees` + `touch_updated_at` trigger.
3. **`worktrees_snapshot_version` trigger** — ship-blocker 1.
4. `internal.record_initial_version` call inside `create_worktree`.
5. `worktrees_guard_status` — R29 single writer.
6. `public.worktree_allocations` + partial unique lease index, **with no snapshot trigger** — the
   structural guarantee of §3.2.
7. `internal.entity_content()` `worktree` arm — the migration-011 bug if omitted.
8. `create_worktree` and **`update_worktree`** doors — ship-blocker 2 — with 038-pattern binding.
9. `in_worktree` edge type row **carrying its own `props_schema`** (a new `insert`, not a widening —
   so it does **not** belong in the shared migration).
10. RLS enable + select policy; `revoke`/`grant execute` with full signatures.

**Not in this migration, by G0.3:** the `in_worktree` origin-stamping line in
`internal.guard_w1_edge`. It lives in `051_edge_guard_multi_kind.sql`. If an implementer finds
themselves typing `create or replace internal.guard_w1_edge` here, that is the bug.

TypeScript, same change: `CoreEntityKind`; `EntityState`/`EntityContent` variants;
`CreateEntityInput.kind` `Exclude<>`; `patchEntity` `case 'worktree'`; `entity-read.ts` join;
conformance kind-disposition row.

Migration hygiene (VERIFIED): filename `NNN_lower_snake_case.sql`; the runner is `db/migrate.mjs`,
hashing each file independently (`:134-138`) with drift refusal (`:203-212`) — **a per-file ledger,
not a hash chain, so a new file invalidates nothing**. There is no manifest listing migrations. The
only pinned digest in the repo covers **015 alone**
(`tools/conformance/src/foundations/migration-inventory.ts:6-8`), so adding 051 requires no digest
update — but *editing 015* would require updating three places. This design edits no existing
migration.

**Gate G1:**
- **G1.1 — the mutation test that matters.** RED: omit the snapshot trigger, transition to `merged`,
  assert `entities.version` **unchanged** and a pinned memory **not** drifted. GREEN: with the
  trigger, version bumps by **exactly 1** and `basisMoved` appears on the next read.
- **G1.2 — the W3 guarantee.** Drive `worktree_allocations` through all five states plus lease
  acquire/release; assert `entities.version` unchanged throughout.
- **G1.3 — R29.** A direct `update public.worktrees set status=...` outside the door raises `23514`.
- **G1.4 — content.** `entities.get` on a worktree returns populated content, not `{}`.
- **G1.5 — kind drift.** Boot the projector; assert no `EntityKindDriftError`.
- **G1.6 — patch door.** `entities.patch` with `expectedVersion` mismatch → `conflict`; with an
  immutable field (`path`, `branch`, `base_ref`) → `invalid_input`, **not** a silent drop.
- **G1.7 — full migration replay.** `tools/ci/migrations-check.sh` replays 001→051 into a scratch DB.

### Phase 2 — WorktreeManager (Git, no public surface)

Argv-only invoker; `realpath` containment with the post-creation re-assertion; the keyed per-project
mutex (generalizing `workspace-trust.ts:45-60` from one global promise chain to `Map<projectId,…>`);
`add`/`remove`/`prune`/`list --porcelain`; dirty and unpushed probes; preflight-token minting.

**Gate G2:**
- **G2.1 — injection.** `baseRef` values containing `;`, `` ` ``, `$(…)`, newlines, and a leading `-`
  are refused or passed inertly; assert no shell was involved.
- **G2.2 — containment (this is S11's acceptance item 3).** A symlinked project dir, a symlinked
  worktree root, a `..` component, and a sibling-prefix path (`/data/worktrees-evil` against root
  `/data/worktrees`) all → `invalid_input`. The sibling-prefix case is the one a `startsWith`
  implementation passes and a segment-wise one fails.
- **G2.3 — post-creation race.** Replace the leaf with a symlink between validation and creation;
  assert the post-creation assertion catches it and cleans up.
- **G2.4 — concurrency.** N concurrent `add` calls on one repository: assert serialization, N
  distinct paths and branches, zero corrupted `.git/worktrees` metadata.
- **G2.5 — idempotent cleanup.** `remove` twice, `remove` on an already-gone directory, `remove`
  under a held lock — all converge without error.

### Phase 3 — spawn integration

Contract `SpawnWorkdir` variants; the saga wired into `SpawnService`; lease acquisition; the
`in_worktree` edge; immutable launch fields.

**Gate G3 — crash tests, one per saga boundary.** Kill the server between each numbered step of §4
and assert the reconciler converges: `preparing`+no-dir → `failed`; `preparing`+dir → removed;
Git-entry+no-entity → removed; committed-tx+no-PTY → worktree preserved, lease released.
Plus: **G3.5** — spawn failure after `ready` preserves the worktree (a failed spawn is not evidence
about a checkout); **G3.6** — the persisted `workdir_path` equals the path the PTY actually used
(the shipped scratch defect, §1.2, not reintroduced).

### Phase 4 — recovery and cleanup

Startup reconciliation; `cleanup_pending` retry with bounded backoff; quarantine; **stable node
identity** replacing `host:port` (§6.1).

**Gate G4:** every row of the §6.2 table exercised; **G4.5** — a quarantined foreign Git worktree is
reported and **not** touched; **G4.6** — reconciliation never infers `merged` or `abandoned` under
any input, including a deleted branch and a vanished directory; **G4.7** — a node restarted on a
different port still reconciles its own allocations.

### Phase 5 — CLI and UI

Closed-set widening plus the stale-rationale prose updates; `tm8 worktree` sugar over
`entities.patch`; UI launch choice, base-commit display, health surfacing, destructive confirmations.

**Gate G5:** catalog still declares **110** operations; capability advertisement is absent (not
errored, not silently downgraded) where the node cannot service it; `--force` is never implied by a
generic confirm.

### 9.6 Test matrix summary

| class | where | representative |
|---|---|---|
| version/staleness | G1.1, G1.2 | trigger omitted → silent green (RED); allocation churn → no bump |
| single-writer | G1.3 | direct status UPDATE → `23514` |
| contract/kind | G1.4–G1.6 | content not `{}`; no kind drift; immutable field refused |
| security | G2.1–G2.3 | argv injection; segment-wise containment; post-creation symlink race |
| concurrency | G2.4, G5 | N concurrent adds; lease contention → `limit_exceeded`, not a hang |
| crash | G3.1–G3.6 | kill at each saga boundary; disk-leads-DB is the only permitted direction |
| recovery | G4.1–G4.7 | every §6.2 row; never-infer; foreign-worktree quarantine |

---

## 10. Open questions and residual risk

### 10.1 Who observes a Git merge — the honest answer, and one improvement on it

**The server cannot detect a merge. Something must record it. That something is an agent or a human,
through one explicit action.** No design in this document changes that, and any claim otherwise would
be false.

What I can add: **the server cannot observe a merge, but it can refuse a false claim.**
`git merge-base --is-ancestor <worktree-tip> <base-branch-tip>` verifies that the claimed merge
actually landed. So `merged` is *verifiable rather than trusted*, which makes the resulting pin-drift
better evidence than "someone asserted it."

Two documented holes, and they are why this is verification and not a gate:

1. **Squash-merge and rebase-merge defeat ancestry.** After a GitHub squash merge the branch tip is
   genuinely not an ancestor of the base tip, though the work truly merged. So the check must be
   **advisory with an explicit override**, and the override should record *how* it merged
   (`mergedVia: 'ancestor' | 'squash' | 'rebase' | 'asserted'`) rather than discarding the distinction.
2. **An empty worktree looks merged.** A worktree with zero commits has a tip equal to its base
   commit, which trivially *is* an ancestor of the base tip. The check must first require at least
   one commit unreachable from base, and answer `empty` rather than `merged` otherwise. This is the
   failure that would fire on every abandoned-before-started worktree — the most common case.

**Unresolved sub-question, genuinely open:** should merging a tm8 `pull_request` entity cascade a
`merged` transition to a linked worktree? It is the one place tm8 already models a merge. Against it:
the PR entity's merge state is itself recorded rather than observed, so a cascade chains two
unverified records and makes the provenance *look* stronger than it is. I lean no, and I do not think
this document should decide it alone.

### 10.2 Risks I am accepting, named

- **Adding a core kind is a one-way door.** `entity_kinds_guard_core` (`005:238`) blocks update and
  delete of core rows. Mitigation: gate G0.4 is a user ratification, not a technical check.
- **The `worktree` patch arm does I/O.** §5.4. Genuinely asymmetric with the other eleven doors;
  mitigated by the preflight token, not eliminated.
- **The `guard_w1_edge` rewrite is a shared mutable resource** across three concurrent designs.
  Structurally resolved by the shared prerequisite migration (G0.3), but the resolution depends on a
  convention — "never re-declare a shared object in a feature migration" — that nothing enforces
  mechanically. A CI check asserting that no migration above 051 contains
  `create or replace ... guard_w1_edge` would make it real. Recommended, not scoped here.
- **Reconciliation depends on `host:port` node identity** today; that is a leaked-checkout hazard
  rather than a stuck-row hazard. Phase 4 work item, not an assumption.
- **`git worktree` requires a real filesystem and a real Git.** Not available in every deployment
  target this program may later want. The capability rule (§7.4) makes that a refusal rather than a
  crash, which is the most that can be promised.

### 10.3 What I did not verify, and would need to

- Whether the conformance manifest (`tools/conformance/generated/w1-conformance-manifest.json`)
  snapshots **function bodies**. If it does, the `guard_w1_edge` rewrite requires a manifest
  regeneration that this plan does not currently budget for.
- Whether `internal.version_debounce_window()`'s 5-minute value is configurable per-kind. §2.4's
  history-collapse consequence would change if it were.
- Whether any deployment already has directories under `<dataDir>/worktrees/`. There is no code that
  creates them, so I expect none — but "no code creates it" and "nothing is there" are different
  claims, and I only verified the first.
