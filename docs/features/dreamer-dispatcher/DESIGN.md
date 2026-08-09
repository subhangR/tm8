# Dreamer & Dispatcher — Design

Status: DESIGN AGREED (decisions locked with Subhang 2026-08-09 on task
`019fe4e0-cbbd-7523-83ca-1aaad8067fa2`). Not implemented.

## 1. Summary

Two features that close the loop on teammate context quality:

- **Dispatcher** — a fifth agent mode. A resident per-space agent whose only
  job is: given a dispatch request for an entity, read the teammate roster and
  the memory graph, pick the best teammate plus the relevant memories, and
  spawn the work session. It never does the work itself.
- **Loop** — a new first-class graph entity: a scheduled expression that
  triggers a task spawn with a configuration, on a period. Loops are the
  generic async-job primitive, visible and editable in UI and CLI like any
  entity.
- **Dreamer** — not a new mechanism: a seeded teammate plus a seeded loop.
  Periodically walks teammates and their memory edges and cleans the context
  that gets injected — marking stale/wrong memories and consolidating
  clusters — so injection stays clean and verified.

Dispatcher and Dreamer are the completion of the 056 memories design:
Dispatcher ≈ Phase 4 (agent delivery of memories into assignments), Dreamer ≈
Phase 5 (consolidation loop). We extend that design rather than build a
parallel memory system.

## 2. Decisions record

| # | Question | Decision |
|---|----------|----------|
| D1 | Memory substrate | **056 memory entities** are the one substrate. Extend/complete the 056 design (Phases 3–5). Migrate and retire `team_members.memories` jsonb. |
| D2 | Dispatcher lifecycle | **Resident.** One dispatcher session per space. If none is alive, spawn it first, then send the dispatch request to it as a message. |
| D3 | Memory delivery to sessions | **Both channels:** (a) spawn-time append — `execution.spawn` gains `memoryIds`, CLI gains `--memory <id>` (repeatable); (b) memories attach to TASKS via edge and are auto-injected when a session spawns on that task. Agents can attach memories to tasks. |
| D4 | Dispatcher scope | Fifth `dispatcher` mode with its own prompt kernel. **Strictly selects from existing teammates** — it never creates teammates, never does the work. |
| D5 | UI entry | Inside the existing launcher (LaunchSheet, opened by Run on any launchable entity): a **Dispatch** option next to the manual teammate/model picker. |
| D6 | Loop kind | **First-class core entity kind.** Full graph citizen: schedule expression, spawn configuration; each firing creates/derives a task and spawns on it, with edges to the loop, so the graph is maintained. |
| D7 | Dreamer powers | Sweep **through teammates and their memory edges** and clean them: mark (disputes/supersedes/staleness) + consolidate (author new memories that supersede clusters). **No hard delete, no persona/identity edits.** |
| D8 | Seeding | Dispatcher teammate + default Dreamer loop seeded at space bootstrap alongside the default teammates (`default-teammates.ts` path). |

## 3. Current-state grounding (verified in tree, 2026-08-09)

- Mode enum is four values in ~13 files; the contract chokepoint is
  `packages/contract/src/schemas.ts:1634`
  (`z.enum(['worker','coordinator','coordinated-worker','coordinated-coordinator'])`),
  mirrored in `contract.ts`, `prompt/src/index.ts` (AgentMode + kernels),
  `execution/src/spawn/{types,manifest}.ts`, `cli/src/commands/session.ts`,
  `tm8-ui/src/domain/launch.ts`, and the DB check on `team_members.mode` /
  `work_sessions.mode`.
- `ExecutionSpawnInputSchema` (`schemas.ts:1623–1641`) already carries
  `promptExtra` (free-text injection) — `memoryIds` slots alongside it.
- Memory injection today: `execution/src/spawn/manifest.ts:967` copies
  `member.memories` (the `team_members.memories` jsonb column,
  `002_identity.sql`) into the manifest's `agent.memory`. This is the jsonb
  path D1 retires.
- 056 (`db/migrations/056_entity_memory.sql`): `memory` core kind,
  `public.memories` (statement/mechanism/subject_scope/does_not_establish/
  measured_at), epistemic edge types (verifies/disputes/based_on/…),
  append-only edge trigger, `create_memory`/`update_memory` doors, staleness
  badge derived at read time. Zero dedicated catalog ops — memory rides
  `entities.create`/`entities.patch`. Phases 3–5 (sweeps, agent delivery,
  consolidation loop) were never built.
- Launch is entity-generic: `public.derive_task_for_entity` (064) derives a
  task for any launchable kind before `execution.spawn`; by spawn time every
  subject IS a task, so the task-attached-memory channel (D3b) covers every
  launch path.
- Scheduler exists: `packages/server/src/scheduler/scheduler.ts` —
  self-rescheduling unref'd timers, per-job lock, failure isolation; jobs
  registered in `scheduler/index.ts` (backup + 4 retention policies). Loops
  become its first DB-defined work.
- Bootstrap seeding: `packages/server/src/bootstrap/default-teammates.ts` —
  idempotent by seed name, called from boot repair AND `spaces.create`, rows
  created via `public.create_team_member` rpc.
- UI launcher: `packages/tm8-ui/src/views/LaunchSheet.tsx` (teammates,
  profiles, capacity, refusal reason → `onLaunch(config)`).
- Teammate config edits are owner-governed; agents get `forbidden` on persona
  edits. Nothing here relaxes that: dispatch never mutates teammates (D3).

## 4. Architecture

### 4.1 Memory substrate (completing 056)

- New edge type `remembered_by` (memory → team_member) is the operational
  "this memory belongs to this teammate's working set" link. (056's epistemic
  edges stay what they are: provenance/verification, not routing.)
- New edge use: memory → task attachment (D3b). Reuse `attached_to` is
  FORBIDDEN for provenance-lookalikes per the 064 lesson only when a reuse
  lookup keys on it; here attachment IS the user semantic, so
  `attached_to(memory → task)` is correct and inherits RLS/purge/events.
- Migration path off jsonb: a one-time migration converts each
  `team_members.memories[]` element into a memory entity +
  `remembered_by` edge; `manifest.ts` switches from `member.memories` to a
  graph read; the jsonb column is dropped in a later migration once the read
  path is proven (two-step, since :7777/:7778 serve frozen binaries).

### 4.2 Injection at spawn (D3)

`loadSpawnContext` gains two memory sources, composed into the existing
`agent.memory` manifest field (prompt templates unchanged in shape):

1. Teammate working set: memories with `remembered_by` → the teammate
   (replaces the jsonb read at `manifest.ts:967`).
2. Task-attached: memories with `attached_to` → any task in `taskIds`
   (auto-injected; this is how the Dispatcher hands context to the session it
   spawns, and how any agent enriches a task for future sessions).
3. Request `memoryIds` (spawn-time append, D3a): validated same-space memory
   entities, injected for THAT session only. CLI: `tm8 session spawn
   --memory <id>` (repeatable).

Each injected memory renders with its staleness marker so the receiving agent
knows what is verified vs disputed.

### 4.3 Dispatcher (D2, D4, D5)

- **Mode**: add `dispatcher` to the mode enum (all touchpoints in §3 bullet 1)
  plus a `dispatcherBootstrapControl()` kernel in `packages/prompt`:
  context = teammate roster + memory-graph summary + live-session capacity;
  allowed verbs = read teammates/memories/tasks, attach memories to the task,
  `execution.spawn`, `message reply`; explicit prohibition on doing the work,
  editing teammates, or creating teammates.
- **Resolution ("is there a dispatcher?")**: server-side, not UI-side. New
  op `execution.dispatch` (input ≈ `{spaceId, subjectId, note?}`):
  1. Find a live work_session in this space with `mode='dispatcher'` and
     status `running|idle` (liveness-checked — status alone lies; reuse the
     existing liveness probe, not `work_sessions.status`).
  2. If none: spawn one (seeded Dispatcher teammate, `dispatcher` mode) and
     wait for boot settlement.
  3. Derive the task for `subjectId` (existing 064 path) and send the
     dispatch request **to the dispatcher session id** (not just the anchor —
     anchor delivery can silently miss a session) as a trusted envelope
     carrying the task id, requester, and note.
  The dispatcher then picks teammate + memories, attaches chosen memories to
  the task (D3b), calls `execution.spawn`, and replies on the task anchor with
  who/why.
- **UI**: LaunchSheet gets a **Dispatch** action beside the manual flow; it
  calls `execution.dispatch` and closes. No picker, no sheet fields required.
- **Graph**: dispatched session records `dispatched_by` edge → dispatcher
  session (provenance: "why this teammate" lands as the dispatcher's anchor
  message).

### 4.4 Loop — first-class core kind (D6)

Table `public.loops` (entity_id PK → entities, kind `loop`):

```
schedule        text        -- v1 grammar: 'every <n>{m|h|d}' OR 5-field cron
team_member_id  uuid null   -- who runs; null = route through Dispatcher
subject_id      uuid null   -- entity to derive the task from (task/doc/teammate/…)
prompt          text        -- the instruction for each firing
config          jsonb       -- spawn overrides (model, accessMode, …)
enabled         boolean     -- default true
last_run_at     timestamptz null
next_run_at     timestamptz null
last_error      text null
```

- **Firing semantics (graph-maintained, per D6)**: each due firing
  (a) derives/creates a task for the loop (064 pattern — the loop itself is
  the launchable subject when `subject_id` is null), (b) spawns a session on
  it via the normal `execution.spawn` path with the loop's config, (c) writes
  `triggered_by` edge (task/session → loop). Run history = the loop's edge
  neighborhood; no separate run table.
- **Executor**: ONE new scheduler job (`scheduler/jobs/loops.ts`), registered
  like backup/retention: poll `enabled and next_run_at <= now()` per space,
  fire, recompute `next_run_at` from `schedule`, record `last_error` on
  failure without disabling. Overlap guard: skip a firing if the previous
  firing's session is still live. Node-local single-writer is fine (matches
  the scheduler's existing single-node assumption).
- **Attribution (flagged open in review)**: spawned sessions carry
  `created_by = the loop's creator`; the `triggered_by` edge is the honest
  provenance. No new actor identity in v1.
- **Surface**: kind row (`entity_kinds`, origin core) + content-hydration arm
  + contract `CoreEntityKind` + `CoreEntityKindSchema` + kind-dispositions
  row + tm8-ui registry row (`launchable: false`; primary action = Enable/
  Disable + Run now). Create/edit rides `entities.create`/`entities.patch`
  with `create_loop`/`update_loop` doors, exactly the 056 memory pattern —
  zero new catalog rows for CRUD. Only `execution.dispatch` is a new catalog
  op (see §5 hazards).

### 4.5 Dreamer (D7, D8)

- A seeded teammate ("Dreamer", worker mode, persona = the cleanup mission)
  plus a seeded default loop (`every 1d`, disabled-by-default is NOT wanted —
  seeded enabled, per D8's "from day one"; interval reviewable).
- Each firing: walk the space's teammates and their `remembered_by` sets plus
  epistemic edges, then:
  - **Mark**: write `disputes`/`supersedes`/staleness edges on memories that
    contradict newer evidence or reference dead entities.
  - **Consolidate**: author new merged memories that `supersedes` clusters of
    overlapping ones; move the `remembered_by` working-set edge to the
    consolidated memory.
  - Never hard-delete; never edit teammate `identity`; report a summary
    message on its task anchor every run (work nobody can see has not
    happened).
- Guardrail matches 056's append-only edge trigger — the substrate already
  physically resists deletion.

### 4.6 Seeding (D8)

`default-teammates.ts` grows two idempotent passes (same seed-name keying):
1. Dispatcher teammate (`mode='dispatcher'`, model from
   `LAUNCH_MODEL_CATALOG` default).
2. Dreamer teammate + its loop entity (seed-keyed like
   `bootstrap:teammate:…` idempotency strings).

## 5. Known hazards to budget for (from prior waves)

- **Adding a catalog op is repo-wide**: `execution.dispatch` breaks ~32 tests
  (count pins, CATALOG_DIGEST in TWO files, conformance manifest, generator
  noun). Read actual numbers out of failures — a pin already red on main
  stays red under `previous+1`.
- **Migration number**: this branch's tree tops at 073 but lanes hold up to
  083 (082 credential, 083 wake-cap). Compute the next number from the union
  of main + all lane ledgers + origin refs at implementation time (the
  080/081 race). Expect ≥ 084.
- **Core-kind addition** breaks count pins too (kind-count assertions,
  `entity_content` arm count — 19 arms today).
- **Mode enum** touches ~13 files; `tsc -b` silently skips the server build —
  grep the bundle after building.
- **Liveness**: never trust `work_sessions.status` for "is the dispatcher
  alive"; sessions die in 40ms with NULL exit_code, and `statusOf` history
  says probe, don't read.
- **Delivery**: send dispatch requests to the session id, not only the
  anchor — anchor delivery has silently missed live sessions (0 rows in
  `session_message_deliveries`).

## 6. Phasing

1. **P1 Memory substrate**: `remembered_by` edge type + jsonb→entity
   migration + manifest read switch + `memoryIds` on spawn + `--memory` CLI.
   (Ships value alone: spawn-time memory append.)
2. **P2 Task-attached injection**: `attached_to(memory→task)` +
   `loadSpawnContext` merge + UI attach affordance on tasks.
3. **P3 Dispatcher**: mode enum + kernel + `execution.dispatch` +
   resident resolution + LaunchSheet Dispatch option + seeding.
4. **P4 Loop kind**: migration + contract + doors + scheduler job + UI
   registry row.
5. **P5 Dreamer**: persona + seeded loop + sweep behavior (prompt-side; no
   new server code beyond P1–P4).

Each phase is independently landable; P3 depends on P1–P2, P5 on all.

## 7. Open questions (non-blocking, flagged for review)

- Loop attribution: `created_by = loop creator` accepted? (§4.4)
- Dispatcher capacity: does dispatch respect the existing launch capacity
  refusal, and does the dispatcher queue or refuse when at capacity?
- Dreamer default cadence (`every 1d` proposed) and model (cheap model?).
- Should `execution.dispatch` be callable by agents (a coordinator routing
  through the dispatcher) or human-only in v1?
