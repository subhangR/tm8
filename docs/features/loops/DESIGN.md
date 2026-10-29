# Loops: a first-class scheduled-work primitive — design of record

Status: v3, 2026-10-28. v1 accepted by the coordinator; v2 folded in the review notes; v3 folds in the three research reports (tasks 01a182c9-df49, 01a182ca-0c9e, 01a182ca-4055) and the coordinator's seam rulings. Baseline moved to origin/main d77e1d27f (latest migration 377). Owner: Loops lead (task 01a182bc-7600-7582-9761-25a45eed348d). Supersedes docs/features/dreamer-dispatcher/DESIGN.md §4.4 (D6) for everything loop-shaped; D6's firing semantics are kept where this doc does not say otherwise. Sibling: the Tools lane (task 01a182bc-9002-714c-a4e8-62b35c04130d) owns the tool runtime that §3.4 calls.

Verified baseline: origin/main fcc49604b. What exists today: `public.loops` (091) with `create_loop`/`update_loop` doors; the `loops.execute-due` scheduler job (60 s tick, skip-never-backfill, PTY-liveness overlap guard, errors recorded and never disable); `triggered_by` edges as the only run history; CRUD riding `entities.create`/`entities.patch`; no `loops.*` catalog operations; no `tm8 loop` noun; a UI dialog that takes raw entity ids and raw JSON and computes `nextRunAt` in the browser from a duplicated grammar; nothing in MCP or the prompt templates. One loop in prod ("Dreamer daily sweep"), two firings.

## As shipped (loops PR6, 2026-10-29)

This is the design of record (tm8 doc 01a182d4-2e46-7faf-a981-02011769562c) with what changed on the way in. Where this section and the body disagree, this section is what the code does. The user guide is [LOOPS.md](LOOPS.md), and local verification is [VERIFY.md](VERIFY.md). The CLI reference is [docs/api-and-cli/LOOP-CLI.md](../../api-and-cli/LOOP-CLI.md).

**Pull requests.**
- PR1, contract, `loops.*` core ops and server-owned scheduling: #1406.
- PR2, runs and control: #1398.
- PR3, spawn config and the tool action: #1408.
- PR4, `tm8 loop`: #1405.
- PR5a, the form and the list: #1385.
- PR5b, the page and the runs table: #1386.
- PR6, these docs, the help page, MCP, the prompt line and e2e.

**Migrations.**
- 384 `loops_first_class` (PR1): the new loops columns including `armed_at`, the `loop_runs` table, the new `create_loop`/`update_loop` signatures, `loop_run_settle` and the backfill.
- 385 `loop_run_claim` (PR2): `loop_run_claim` (claim, then fire) and `loops_park_orphans`.

The body's "378+" was renumbered at merge, as §10 expected. Both numbers sort below main's 387–390, by the lead's ruling: each migration's header names the check that a fresh and an upgraded database converge. PR3's tool-gate migration (`386_loop_tool_run_gate.sql` on its branch) is reserved 394, above main's top at its merge (the Mobile track holds 391–393).

**Errata fixed in §5.**
- `--credential-source` is the scalar `member|space|node`; there is no `provider=` form.
- The selection headers (`--when-to-use`, `--summary`, `--keyword`) are written with `entities.header.set` after `loops.create`, never by it. A failed header write names the created loop and the mutation id to re-run with.
- `--clear-subject` became `--subject none`, and `edit` gained `--clear-inputs`.
- `edit --base-ref none` clears a worktree's base ref (before PR4's review it was stored as a ref named "none").
- `show` labels the next instants "schedule from now" (the body's "upcoming").

**Deviations and open items.**
- **The tool action waits on PR3.** Until #1408 merges, a tool loop is accepted, but every firing is refused: `TOOL_LOOP_NOT_RUNNABLE`, recorded as the run's launch error and the loop's last error. Until then a spawn also passes only `config.model`, `agentTool` and `accessMode`; `projectId`, `mode` and `reasoningEffort` arrive as null. §3.4's full mapping is PR3's.
- **Every firing moves the loop's entity version.** `loop_run_claim` updates `next_run_at`/`last_run_at`, and the version snapshot counts them. This is accepted for v1, with follow-up task 01a1870b-8794. Every surface handles it. The CLI's `version_conflict` hint says a loop's version also moves when it fires. The UI's edit form re-reads the loop and resends the same patch, under the same mutation id, when nothing it changes moved, and asks the human to re-read only on a real overlap. The list's Enabled switch re-reads and flips the fresh row. MCP's `loops.update` guide says to read again and retry.
- **Run now on a disabled loop** fires it once and leaves the schedule off (§3.3: a manual run leaves `next_run_at` alone). The page says so beside the button.
- **A dispatch run settles `completed` at delivery** (`jobs/loops.ts`, `run-handlers.ts`): its row reads completed at delivery. The run's session is the space's shared Dispatcher (`resolveDispatcherSession` usually reuses a live one), which only routes the task; the worker it starts is not linked from the run, so the run's task is the way to the work.
- **Failure accounting (§3.3, as designed).** Only a launch failure writes the loop's `last_error` and is retried (`loop_run_launch_failed`). A run that fails after it started, or times out, settles through `loop_run_settle` on its run row only, and the next good launch clears an old `last_error`.
- **Acting identity (§7, as designed).** The armer while still an active member, else the space's active owner (shown through `actingAs`), else none: only then is the loop parked as *needs arming*, keeping its `next_run_at`.
- **The list (§6).** The legacy desktop list draws the loops table. The tab-workspace Work browser and the phone keep the generic list, with its kind menu, cursor, filters and verbs, and show each loop's schedule and next run as the row's second line, from the summary's state arm. A loops table in the Browser is follow-up task 01a1878d-c242.
- **MCP (§8).** `loops.get`, `loops.list`, `loops.runs.list`, `loops.runs.get` and `loops.schedule.preview` are in `tm8_read`. The eight commands are in `tm8_act`, each with a minted `clientMutationId`. The guide summaries carry the schedule grammar, the timezone and what each action does.
- **Prompt (§8).** The v2 coordinator layer carries one sentence: "Recurring work is a loop, not a waiting worker: `tm8 loop preview`, then `tm8 loop create`." That adds 92 B to the two coordinator modes. There is no `PROMPT_VERSION` change, since the version tags the frame and the frame is unchanged.
- **`tm8 kind list`** shows `loop create` as the loop's create command. `tm8 entity create loop` still works, and the server ignores a client `nextRunAt` (§3.1).

## 1. Definition

A **loop** is a durable intention to do a piece of work repeatedly: *when* (a schedule), *what* (an action: spawn a teammate session, let the Dispatcher route it, or run a tool), *about what* (an optional subject entity and an instruction), and *how* (spawn settings and operating policy). Every firing of a loop produces a **run**: a dated record of what the firing did (which task, which session, outcome, duration, error) so that a human can see at a glance whether the loop is healthy, what it last did, and open the session that did it.

Loops are first-class: a core entity kind (`loop`) with its own catalog operations (`loops.*`), its own CLI noun (`tm8 loop`), its own UI (list, page, create/edit form, run history) and MCP parity. The server owns all schedule state; no client ever computes when a loop runs next.

A loop is "do this periodically", not a queue: missed firings are not backfilled (D6). A loop is also not a trigger system: v1 triggers are the schedule and a human pressing Run now. Event triggers and conditions are a follow-up (§13).

## 2. Structure

### 2.1 `public.loops` — definition and schedule state (migration: next free number at PR time; 371 as of this writing)

Existing columns stay (title, schedule, team_member_id, subject_id, prompt, config, enabled, last_run_at, next_run_at, last_error, created_at, updated_at). Added:

| column | type | meaning |
|---|---|---|
| `action` | text not null default 'spawn', check in ('spawn','dispatch','tool') | what a firing does. Backfill: `team_member_id is null` → 'dispatch', else 'spawn'. |
| `tool_id` | uuid null references entities(id) on delete set null | the tool to run when action='tool' (must be a live `tool` in the same space) |
| `tool_inputs` | jsonb not null default '{}' (object) | stored inputs for the tool, validated against the tool definition on write and at fire time |
| `timezone` | text not null default 'UTC' | IANA zone the cron half of the schedule is evaluated in; intervals are zone-free |
| `paused_until` | timestamptz null | while in the future the loop is not due; a human pause with an end |
| `armed_by_member_id`, `armed_by_identity_id` | (exist since 343) | the ARMER: stamped by trigger `loops_stamp_armed_by` when a HUMAN (browser/cli, not via link) inserts, enables (false→true) or edits content; an agent's such write NULLs them. Not re-added; read and shown. |
| `armed_at` | timestamptz null | NEW: set/cleared by the same trigger exactly where it sets/clears `armed_by_*`; the trigger's content comparison must exclude the bookkeeping columns (`armed_at`, `paused_until`, `retry_attempt`, `next_run_at`, `last_*`, `updated_at`, `enabled`, `armed_by_*`) so pause/resume/bookkeeping never re-stamp or clear the armer, while `action`/`tool_id`/`tool_inputs`/`timezone`/`concurrency`/`max_runtime_seconds`/`retry_*` edits do (they are content). |
| `concurrency` | text not null default 'skip', check in ('skip','queue') | what to do when the previous run is still live |
| `max_runtime_seconds` | integer null, check 60..86400 | stop a run that outlives this |
| `retry_attempts` | smallint not null default 0, check 0..5 | retries for a firing that failed to launch |
| `retry_delay_seconds` | integer not null default 300, check 30..3600 | |
| `retry_attempt` | smallint not null default 0 | current retry counter, reset on a successful launch |

Rule for what is a column and what is in `config`: anything the executor **branches on** is a column (typed, indexed, visible in the due query); anything that is **passed through** to `execution.spawn` is in `config`, validated by `LoopSpawnConfigSchema` (§4.2) on every write. `config` therefore holds: model, agentTool, reasoningEffort, accessMode, mode, projectId, workdir {mode, baseRef}, memoryIds, credentialSource, interactionProfileId. Unknown keys are refused.

Invariants enforced in the doors: action='spawn' requires `team_member_id`; action='tool' requires `tool_id` (a live tool in the same space) and MAY carry `team_member_id` — for a tool action it is the **runs-as persona**, required (checked in TS at `loops.create/update` against the tool's current definition, error path `definition.teamMemberId`) when the tool's `tm8Access` is read|write, optional when none; action='dispatch' needs neither; `timezone` must be a valid IANA name (checked server-side in TS before the door; the door checks only non-empty); `schedule` must parse (`assertValidSchedule`, which today is exported but never called, becomes mandatory on every write: `loops.*` and the `entities.*` loop arms refuse with invalid_input/22023).

### 2.2 `public.loop_runs` — the run projection (same migration)

Not an entity kind. A projection table the executor writes and the read ops join. It never contradicts the graph: the `triggered_by` edges stay (343/348 provenance depends on them); the table adds the *outcome* the edges cannot carry.

| column | type | meaning |
|---|---|---|
| `id` | uuid pk | |
| `loop_id` | uuid not null references loops(entity_id) on delete cascade | |
| `space_id` | uuid not null | denormalised for RLS and listing |
| `fired_at` | timestamptz not null | the firing instant (the scheduler's `firedAt`, or now for Run now) |
| `trigger` | text not null check in ('schedule','manual') | |
| `requested_by` | uuid null | actor for manual runs |
| `action` | text not null | snapshot of the loop's action at fire time |
| `attempt` | smallint not null default 1 | 1 + retry_attempt at fire time |
| `acted_as_identity_id` | text null | the identity the firing ran as (the armer, or the fallback — see §7), snapshotted so history stays true after membership changes |
| `launch` | text not null check in ('fired','skipped','failed') | the executor's verdict about the FIRING itself |
| `skip_reason` | text null check in ('overlap','paused','schedule_invalid') | |
| `error` | text null | launch error text, or the settle error |
| `task_id` | uuid null references entities(id) on delete set null | |
| `session_id` | uuid null references entities(id) on delete set null | the work_session (agent or tool run) |
| `outcome` | text null check in ('completed','failed','stopped','timed_out') | written when settled by the executor/stop op; null while running or when nothing settles it |
| `ended_at` | timestamptz null | |
| `created_at` | timestamptz not null default now() | |

Written by ONE claim door (§3.3) in the same transaction that advances `next_run_at`, keyed on the run id — never on the entity version. Indexes: `(loop_id, fired_at desc)`; partial `(session_id) where outcome is null and launch='fired'` for the max-runtime sweep. RLS: select using `internal.entity_readable(loop_id)`. Writers: two definer doors, `public.loop_run_record(...)` and `public.loop_run_settle(p_run_id, p_outcome, p_error)`, granted to tm8_app; the executor and the stop handler go through them so runs land in the command ledger like every other write.

**Run status is derived at read time**, never stored twice: `skipped` if launch='skipped'; `failed` if launch='failed' or outcome='failed'; `stopped`/`timed_out` from outcome; otherwise `running` while the session is live (work_sessions status / PTY liveness) and `completed` once it has exited (tool runs: `failed` when the pinned exit code is non-zero). A session that died with the node is reconciled by the existing ghost reconciliation (ended_kind `server_restart`) or the lost-session reaper (`failed/lost`) and the run view maps those to `failed` with the ended reason shown; `exitCode` null reads as unknown, never as zero. Usage: `work_sessions.usage` (185: token totals per model plus the harness's own `costUsd` when it recorded one) is joined onto each run as `usage` and summed per loop; `costUsd` is labelled 'as reported by the harness' and null means unknown.

### 2.3 Contract state and content

`EntityState` arm (list rows): `{ kind:'loop', action, schedule, timezone, enabled, pausedUntil, teamMemberId, toolId, subjectId, nextRunAt, lastRunAt, lastError }`. `EntityContent` arm adds `prompt, config, toolInputs, concurrency, maxRuntimeSeconds, retry`. The `entity_content` SQL arm is unchanged (whole row up), so no shared-object replacement is needed for content; the state projection gains the new columns.

## 3. Semantics

### 3.1 Scheduling is server-owned
`nextRunAt(schedule, from, timezone)` in `packages/server/src/scheduler/schedule.ts` is the only implementation. Intervals (`every <n>{m|h|d}`) are zone-free. Cron (5 fields, POSIX dom/dow OR) is evaluated by stepping minutes in UTC and matching the **wall-clock fields in `timezone`** (Intl.DateTimeFormat parts; no new dependency). DST: a wall-clock minute that does not exist is skipped; one that occurs twice fires once (first occurrence) — documented, tested. Validation: `Intl.supportedValuesOf('timeZone')`.

`describeSchedule(schedule, timezone)` returns a human summary ("Every 15 minutes", "Every day at 09:00 Europe/London", "Weekdays at 08:30 UTC", "Cron `17 3 1 * *` (UTC)"). `loops.schedule.preview` returns `{ valid, problem, summary, next[] }` and is what the UI and CLI show while a human types.

When `next_run_at` is written: on create (enabled) = next(now); on any update that changes `schedule`/`timezone` = next(now); on **enable** = next(now) — a loop disabled for a week does not fire the instant it is re-enabled; on **disable** = unchanged (reporting only; the due query ignores disabled rows). After a firing, the executor advances from `firedAt` (never from the missed deadline). `entities.create`/`entities.patch` on kind `loop` keep working for compatibility, but the server computes `nextRunAt` itself and **ignores a client-supplied value** (logged, not refused — the old UI sends one until PR5 lands; after PR5 no client sends it).

### 3.2 Due, pause, misfire, restart
Due query (extends 375's `loops_due_for_executor`): `enabled and deleted_at is null and next_run_at <= now() and (paused_until is null or paused_until <= now()) and act_as_identity is not null` — a loop with no resolvable acting identity (§7) is parked with `last_error` 'needs arming' instead of being re-selected every tick (25+ such orphans starved the queue on main, research A). Pause does not stop the clock: when the pause ends (by time or `loops.resume`), a loop whose deadline passed while paused fires **once** at the next tick, then resumes cadence. This is deliberate: "pause until Monday 09:00" on a daily 09:00 loop must fire Monday 09:00, which recomputing-from-now would skip; and one catch-up firing is not a backfill storm. Misfire policy stays skip-never-backfill. Restart: nothing is persisted beyond `next_run_at`; the first tick is 60 s after boot; the overlap guard reads live PTYs (none after a restart), so a due loop fires.

### 3.3 Firing, concurrency, retry, max runtime
**Claim first, then fire.** Research A showed two defects in the current job: a human edit mid-firing makes `update_loop` fail its version check, so the bookkeeping write is dropped and the loop can fire twice; and the bookkeeping mutation id is keyed on the entity version. PR2 therefore adds a definer door `public.loop_run_claim(p_limit, p_now)` that, in ONE transaction, selects due loops `for update skip locked`, advances `next_run_at` from `p_now` (or parks/retries per below), inserts one `loop_runs` row per claimed loop (launch='fired' pending, or 'skipped' with reason) and returns the claimed runs with everything a firing needs. The executor then fires each claimed run with mutation id `loop-fire:<run id>` and settles it with `loop_run_settle`. No bookkeeping write asserts the entity version; a human edit during a firing affects only later runs. The due read, the claim and the overlap decision happen inside the door, so a slow tick cannot widen the conflict window and a second node could run the job safely.

Per claimed loop: (1) **overlap** is decided from open runs (a run is open until settled) plus PTY liveness (the existing probe) — this covers dispatcher firings and restarts without a best-effort edge: `concurrency='skip'` → the claim records launch='skipped', reason 'overlap', and advances; `'queue'` → the claim leaves `next_run_at` unchanged (stays due), writes no new row (the first skipped row stands), and the loop fires on the first tick the previous run has settled; (2) **launch** per action (§3.4); on success the run gets task_id/session_id and `retry_attempt` resets; on launch failure: if `retry_attempt < retry_attempts` → `retry_attempt += 1`, `next_run_at = now + retry_delay_seconds`, run launch='failed' with error; else launch='failed' and the schedule advances normally. `last_error` is set on failure and cleared on success; failures never disable (unchanged). A loop whose schedule is unsatisfiable is parked (not due) with the reason recorded, never cleared to "never due" silently.

**Max runtime**: every tick the job sweeps open runs whose session is live and `fired_at + max_runtime_seconds < now()`: stop through the same server path `execution.terminate` uses (`SpawnService.terminate`, which today sends SIGHUP with no grace — recorded as a follow-up, §13), then `loop_run_settle(outcome='timed_out')`.

**Run now** (`loops.runNow`): claims a manual run through the same door (trigger='manual', requested_by=actor, `next_run_at` untouched) and fires it **synchronously through the same port**, returning the run (with `taskId`, `sessionId`) in the response. Overlap → `409 conflict`, code `loop_run_overlap`, with the live run id, unless `force:true`.

### 3.4 Actions
- **spawn**: derive the task from `subject_id` (or the loop itself) via `derive_task_for_entity` (unchanged), then `SpawnService.spawn` with the loop's `config` mapped 1:1 onto `SpawnRequest` (today only model/agentTool/accessMode travel and `projectId` is always null — PR3 maps projectId, workdir, mode, reasoningEffort, memoryIds, credentialSource, interactionProfileId), `promptExtra = prompt`, `title = loop title`, `triggeredByLoopId` inside the spawn transaction (348, unchanged).
- **dispatch**: unchanged (resolve the Dispatcher session, `sendDispatchRequest`, best-effort `triggered_by` from the Dispatcher session).
- **tool**: `LoopExecutorPort.fireTool(loop, claims, firedAt)` → `{ taskId: null, sessionId }` (no derived task for a tool firing). Contract agreed with the Tools lane and ruled by the coordinator on the Tools anchor (2026-10-28, "DECISIONS on RB's findings"), implemented by Tools PR-C (task 01a182cd-2f12-7d34-92ed-fb60adc049de):
  `ToolRuntime.runScheduled(claims: DbClaims, { toolId, inputs, firingKey, triggeredByLoopId, runAsTeamMemberId?, title? }): Promise<{ sessionId, toolVersion, sourceSha256 }>`.
  - **Identity**: `claims` are `claimsForLoop` exactly as the spawn action gets them since 375 (identity = the armer, else the fallback of §7; `nodeAdmin:false`; no authKind). Never the loopback owner (not a member of human-created spaces) and never a synthetic human auth kind (a 323 token would make a scheduler "human" at ~80 branch points). `created_by` = that member; `parent_id` null; bound secrets resolve from the tool's current binding under that account and fail closed.
  - **Provenance edge**: `start_tool_session` gains a trailing `p_triggered_by_loop_id` (drop the old arity, the 348 pattern): inside its transaction it checks the loop is live, same space, `tool_id` matches, then `w1_set_writer('spawn')` and inserts `triggered_by` run→loop `{provenance:true, firedAt}`. That marked edge is the mint's authority and the overlap guard's read. The loop side writes NO edge.
  - **Token** (tm8Access read|write): new `public.issue_tool_session_loop_session(p_session_id, p_loop_id, p_team_member_id, p_token_hash, p_expires_at, p_api_scope)` mints a kind-`agent` token acting as the loop's persona (`runAsTeamMemberId = loops.team_member_id`), gated on no-bearer claims, a live tool run created by the current member with `parent_id` null, the marked edge, the loop live with that persona, `can_act_as`, `tm8_access ≠ none`; scope read if the access or `p_api_scope` is read; writes `participates_in` persona→run; revoked by the existing 319 trigger and resolver backstop. tm8Access=none mints nothing — the tool just runs. A persona-less loop with a tm8Access≠none tool is refused before any mint (and already refused at `loops.create/update`).
  - **Inputs**: validated at fire time against the CURRENT definition by the same resolver `tools.run` uses; a renamed, removed, newly required or invalid input throws `invalid_input` naming every offending input BEFORE any session exists; the executor records it as the run's launch error and the loop's `last_error`, surfaced on the loop page, never silently skipped. Also validated at `loops.create/update` so a human sees the problem when they type it. A loop fires the current definition like cron runs the current script; the run pins `tool_version` and source sha; no version pin on the loop. `p_tool_version = tool.version` always, never null (null skips the stale check and could run old source under a new sha; a 40001 is a `last_error`, not a silent stale run).
  - **Fixed semantics**: `firingKey = <loopId>:<firedAt ISO>` → mutation id `tool-fire:<firingKey>` (two firings are two runs; a transport retry is a replay); keepOpen=false (a keep-open shell would hold a cap slot and stay "live" forever); cwd = the acting identity's per-tool scratch dir; no passed secrets. The run is a `work_session` with `session_kind='tool'`; state (running|exited|timed_out|killed), exit code, started/exited and the redacted output tail are read through the tool run view. A non-zero exit is the RUN's outcome (`failed`), not a firing failure.
  - **Launch failures recorded on the run and `last_error`**: `invalid_input` (stale/invalid stored inputs), `40001` (source edited between load and start), `limit_exceeded` (the acting member already has 8 tool sessions, open UI tabs included), `42501` credential unavailable (the acting account cannot use the binding), `42501` mint refused (no persona / cannot act as), 'Tool launch failed' (the killed row stays in history).
  - Wiring: PR-C adds an optional `tools?: { runScheduled }` dep to `createLoopExecutorPort`; PR3 here owns `fireTool` and the action branch.

### 3.5 Lifecycle
create → (enabled by default) → firing… ; `disable` (keeps schedule, stops firing), `enable` (recompute next), `pause until` (temporary), `resume`, `edit live` (version-guarded; a schedule/timezone change recomputes next; an edit while a run is live affects only later runs), `stop run` (stops the live session, run outcome 'stopped'), `delete` (ordinary `entities.delete`; cascades runs; sessions and tasks remain). Every write is a door call under `--expect-version`.

## 4. API — `loops.*` catalog operations

### 4.1 Rows (packages/contract/src/catalog.ts)
```
loops.create            POST  /v2/spaces/:spaceId/loops                     command
loops.update            PATCH /v2/loops/:loopId                             command   expectedVersion
loops.get               GET   /v2/loops/:loopId                             read
loops.list              GET   /v2/spaces/:spaceId/loops                     read      ?enabled= ?action= ?words= ?limit= ?cursor=
loops.enable            POST  /v2/loops/:loopId/enable                      command   expectedVersion
loops.disable           POST  /v2/loops/:loopId/disable                     command   expectedVersion
loops.pause             POST  /v2/loops/:loopId/pause                       command   expectedVersion, {until}
loops.resume            POST  /v2/loops/:loopId/resume                      command   expectedVersion
loops.runNow            POST  /v2/loops/:loopId/run                         command   {force?}
loops.runs.list         GET   /v2/loops/:loopId/runs                        read      ?status= ?limit= ?cursor=
loops.runs.get          GET   /v2/loop-runs/:runId                          read
loops.runs.stop         POST  /v2/loop-runs/:runId/stop                     command
loops.schedule.preview  POST  /v2/spaces/:spaceId/loops/schedule-preview    read      {schedule, timezone?, count?}
```
Delete uses the existing `entities.delete`. All rows `status:'v1'`; none `humanOnly` (see §7 for the one open question). PR1 adds every row; rows whose handler lands in PR2 answer 501 `not_implemented` until then (the catalog already supports this, DEV-13).

### 4.2 Types (packages/contract/src/contract.ts; zod in schemas.ts)
```ts
export type LoopAction = 'spawn' | 'dispatch' | 'tool';
export type LoopConcurrency = 'skip' | 'queue';
export type LoopRunTrigger = 'schedule' | 'manual';
export type LoopRunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'timed_out';
export type LoopRunSkipReason = 'overlap' | 'paused' | 'schedule_invalid';

export interface LoopSpawnConfig {
  model?: string | null;
  agentTool?: string | null;
  reasoningEffort?: LaunchReasoningEffort | null;
  accessMode?: LaunchAccessMode | null;
  mode?: 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator' | null;
  projectId?: ProjectId | null;
  workdir?: { mode: WorkSessionWorkdirMode; baseRef?: string | null } | null;
  memoryIds?: EntityId[];           // max 32
  credentialSource?: LaunchCredentialSource | null;
  interactionProfileId?: EntityId | null;
}                                   // zod: .strict() — unknown keys refused

export interface LoopDefinition {   // what a human writes; every field present on read
  title: string;                    // 1..200
  schedule: string;                 // every <n>{m|h|d} | 5-field cron
  timezone: string;                 // IANA, default 'UTC'
  action: LoopAction;
  teamMemberId: EntityId | null;    // required when action='spawn'
  subjectId: EntityId | null;
  toolId: EntityId | null;          // required when action='tool'
  toolInputs: Record<string, unknown>;
  prompt: string;                   // <= 20000
  config: LoopSpawnConfig;
  concurrency: LoopConcurrency;
  maxRuntimeSeconds: number | null; // 60..86400
  retry: { attempts: number; delaySeconds: number }; // 0..5, 30..3600
}

export interface LoopSchedulePreview {
  valid: boolean; problem: string | null; summary: string; next: string[]; // ISO instants, up to `count` (default 5, max 10)
}

export interface LoopRun {
  id: string; loopId: EntityId; spaceId: SpaceId;
  firedAt: string; trigger: LoopRunTrigger; requestedBy: ActorRef | null;
  action: LoopAction; attempt: number;
  status: LoopRunStatus; skipReason: LoopRunSkipReason | null; error: string | null;
  taskId: EntityId | null; sessionId: EntityId | null;
  startedAt: string | null; endedAt: string | null; durationMs: number | null;
  exitCode: number | null; outputTail: string | null;   // tool runs only; outputTail only on runs.get
  actedAs: ActorRef | null;         // the identity the firing ran as
  endedKind: string | null;         // work_sessions.ended_kind when settled by the session (server_restart, lost, stopped_by_operator…)
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; source: 'harness' | null } | null; // from work_sessions.usage (185); null = unknown, never zero
}

export interface LoopView {
  id: EntityId; spaceId: SpaceId; version: number;
  definition: LoopDefinition;
  schedule: LoopSchedulePreview;    // loops.get: summary + next 5; loops.list rows: summary/valid/problem only with next: [] (no per-row cron stepping — an unsatisfiable cron costs ~500k steps)
  state: {
    enabled: boolean; pausedUntil: string | null;
    nextRunAt: string | null; lastRunAt: string | null; lastError: string | null;
    armedBy: ActorRef | null; armedAt: string | null;   // 343's armer + new armed_at
    actingAs: { identity: ActorRef | null; via: 'armer' | 'fallback' | 'none' };  // who the NEXT firing will run as (§7)
    waitingOnRunId: string | null;  // concurrency='queue' and a previous run is still live
  };
  runs: { total: number; last: LoopRun | null; last24h: { fired: number; failed: number; skipped: number }; usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } };
  createdBy: ActorRef; createdAt: string; updatedAt: string;
  capabilities: { canEdit: boolean; canControl: boolean; canRun: boolean; canDelete: boolean };
}

// Inputs (all carry commandContextShape + clientMutationId like tools.*)
export interface LoopCreateInput { spaceId; definition: LoopDefinition /* timezone/config/concurrency/retry/toolInputs optional with defaults */; enabled?: boolean /* default true */ }
export interface LoopUpdateInput { loopId; expectedVersion: number; definition: Partial<LoopDefinition> /* null clears nullable ids */ }
export interface LoopEnableInput { loopId; expectedVersion }          // also disable, resume
export interface LoopPauseInput  { loopId; expectedVersion; until: string /* ISO, > now, <= now+365d */ }
export interface LoopRunNowInput { loopId; force?: boolean }  → { run: LoopRun }
export interface LoopRunStopInput { runId }                   → { run: LoopRun }
export interface LoopSchedulePreviewInput { spaceId; schedule: string; timezone?: string; count?: number }
loops.list → { items: LoopView[]; nextCursor: string | null }   loops.runs.list → { items: LoopRun[]; nextCursor }
```
Every command returns the updated `LoopView` (like `tools.update` returns the tool), so a CLI or UI never needs a second read.

### 4.3 Errors
`invalid_input` (schedule unparseable / timezone unknown / action–runner mismatch / tool inputs invalid, with a field path), `conflict` (`version_conflict`; `loop_run_overlap` on runNow), `not_found`, `forbidden` (capabilities), `invariant_violation` (tool deleted since configured).

## 5. CLI — `tm8 loop` (packages/cli/src/commands/loop.ts; help via the CommandModule metadata like `tool.ts`)
```
tm8 loop create <title> --schedule <expr> [--timezone <iana>]
      (--teammate <id|name> | --dispatch | --tool <name|id> [--input <k>=<v>...])
      [--subject <entity-id>] [--prompt <text|@file>]
      [--model <m>] [--agent-tool <t>] [--reasoning-effort <e>] [--access-mode <a>] [--mode <m>]
      [--launch-project <id>] [--workdir project|worktree|scratch] [--base-ref <ref>]
      [--memory <id>...] [--credential-source member|space|node] [--interaction-profile <id>]
      [--concurrency skip|queue] [--max-runtime <seconds>] [--retry <n>] [--retry-delay <seconds>]
      [--disabled] [--when-to-use <text>] [--summary <text>] [--keyword <k>...] [--mutation-id <id>]   # headers: entities.header.set after loops.create
tm8 loop list [--enabled|--disabled] [--action spawn|dispatch|tool] [--words <w>] [--limit] [--cursor]
tm8 loop show <id|title>
tm8 loop edit <id> --expect-version <n> [any create flag] [--subject none] [--base-ref none] [--clear-tool] [--clear-inputs]
tm8 loop enable|disable|resume <id> --expect-version <n>
tm8 loop pause <id> --until <iso|+<n>{m|h|d}> --expect-version <n>
tm8 loop run-now <id> [--force]            → prints run id, task id, session id, and `tm8 session transcript <id>` hint
tm8 loop runs <id> [--status <s>] [--limit] [--cursor]
tm8 loop run-show <run-id>
tm8 loop stop <run-id>
tm8 loop preview --schedule <expr> [--timezone <iana>] [--count <n>]
```
Discovery plumbing: the CLI's `ROWS` table (packages/cli/src/discovery/operations.ts) is exhaustive over `OperationName`, so PR1's contract commit adds the 13 rows (`cmd: null`, reason 'ships in PR4 (tm8 loop)', tags, summaries), `NOUN_BY_FAMILY loops:'loop'`, `NOUN_SUMMARY`, recomputes `CATALOG_DIGEST`, regenerates the conformance manifest and re-pins the frozen counts; PR4 fills `cmd`/`syn`/`examples`, adds `LOOP_COMMANDS` to `commands/registry.ts`, an optional noun guide for the schedule grammar, and `domain/kind-nouns.ts` `loop: { nouns: ['loop'] }` so the entity help toolkit lists the commands. Rules: `--teammate` accepts a name (resolved through the teammate list, like `tm8 tool` resolves tool names); every command prints human text by default and `--format json` for machines; `tm8 help loop`, `tm8 help loop <verb>` and `tm8 help --query "schedule a teammate"` resolve; `tm8 entity create loop` keeps working. Docs: docs/api-and-cli/LOOP-CLI.md.

## 6. UI (packages/tm8-ui/src/loops/)
- **List** (`/loops`): columns Title · Runs (teammate chip, "Dispatcher", or tool name) · Schedule (summary) · Next run (relative + absolute on hover) · Last run (status chip + relative) · Enabled (switch). Header "New loop". Home rail: decided cross-lane — `loop` and `tool` leave the admin group and become visible first-class rail entries; the Tools lane's PR-A makes that one edit for both kinds, so no Loops PR touches domain/home-rail.ts.
- **Create / Edit form** (dialog from the New tab chooser, list header and command palette; the same form edits): Name · *What should run?* segmented control Teammate / Dispatcher decides / Tool with a teammate picker, or a tool picker plus the tool's inputs form (reuse the tools RunDialog inputs component) · *About* subject entity picker (optional, searchable, any kind) · *Instructions* (prompt) · *When*: presets Hourly / Daily at… / Weekdays at… / Weekly on… / Every N minutes|hours / Custom cron, a timezone select (default: browser zone), and a live preview panel from `loops.schedule.preview` (summary + next 5, debounced) · *Advanced* (collapsed): model, reasoning effort, access mode, mode, project + workdir + base ref, memories, credential source, interaction profile, concurrency, max runtime, retries · *Enable now* toggle. Server validation errors render inline on the field named in the error. The form never computes schedule state.
- **Page**: header with status pill (Enabled / Paused until … / Disabled / Waiting on previous run), "Next run in 3 h (Thu 09:00 UTC)", last error banner; controls Run now · Pause… (quick picks 1 h / until tomorrow 09:00 / custom) · Enable|Disable · Edit · Delete; blocks WHAT IT RUNS, SCHEDULE (summary + next 5), SETTINGS (definition list of config), RUNS (table: fired at, trigger, status chip, duration, task link, session link, error; Stop on running rows; a row opens the session's transcript/terminal tab). Replaces the raw `peer-rows` block; `triggered_by` edges remain visible under connections.
- Panel block `loop-controls` is replaced by `loop-header` + `loop-runs` blocks (new `ContentBlockKind` names + cases in `panels/bodies/GenericBody.tsx`, archetype stays `generic`); `LoopCreateControl` and `loops/schedule.ts` (browser grammar) are deleted.
- Decisions from the reuse research: `loop` joins `NEW_KINDS` (keyboard/contract.ts) so the New tab, ⌘K "New…" and the `n` chords offer it; the Workspace draft gap is fixed (`tab-workspace/adapters/draft.tsx` `draftBodyFor` gets a `scheduled-work` branch rendering the loop form, since the generic header form cannot create a loop). Reuse: `ComposerSelect` (runner/project/access/mode/timezone; offer an explicit "Dispatcher decides" option since it cannot be emptied), `ModelEffortPicker`/`EffortSlider` + `domain/model-catalog.ts`, `domain/launch.ts` vocabulary and `new-session/useLaunchComposerState.ts` for the advanced spawn settings, `MembershipPicker` + `useMembershipSurface().searchPage` for the subject picker, `tools/InputValue.tsx` + `tools/values.ts` for tool inputs (add `list()` to `ToolPort` for the tool picker), `RefusalCard`/`classifyFailure`/`DisabledAction` for refusals. Run rows open the session with the panel's `onOpenEntity` (workspace.tabs.open); list rows need the loop facts on the summary (`state` arm), since entity lists have no column concept — row facts go through `list.tile` badges/signal.

## 7. Permissions and safety
- Create, edit, delete: any space member, human or agent (unchanged; the doors require membership). Research A: `canEdit:false` on loops today is only `'loop'` missing from the editable set in `entity-read.ts` (fixed in PR1); capabilities become per viewer (`canEdit`, `canControl` = enable/disable/pause/resume/stop, `canRun`, `canDelete`).
- **Arming** (343): a human's insert, enable or content edit stamps `armed_by_*`; an agent's write clears it. Coordinator ruling (2026-10-28): arming stays member-allowed, the armer is recorded and shown ("armed by X at T"); no `humanOnly` on `loops.enable/resume/runNow`.
- **Acting identity of a firing** (375): the armer while still an active member, else a fallback. On main the fallback is the space's active owner, which means an agent-armed (= unarmed) loop runs as the owner — an escalation raised as DECISION NEEDED on the lead anchor with the recommendation: fallback to the loop's creator (the member the writer acted for) if still active, else park with `last_error` 'needs arming'. The coordinator's standing ruling until Subhang decides: the fallback MINTS exactly as `execution_spawn` does (one policy for spawn and tool), made visible — the page shows "armed by X (no longer a member) · running as <fallback>", and the run's invoker label is "loop <title>". `LoopView.state.actingAs` carries who the next firing runs as and via what rule, so the page never hides it.
- MCP connectors (343/347) root only at a human armer with a marked edge; an unarmed loop has `no_human_provenance` and gets no account connectors — fail closed, unchanged.
- Safety rails: `maxPerTick` 25 (unchanged); the global agent-session cap and the per-member 8-tool-session cap apply; a loop never fires more than once per tick; an unsatisfiable schedule parks the loop with the reason recorded; `accessMode` for loop spawns defaults to the persona's default, never silently `fullAccess`; a tool loop cannot hold a secret in `tool_inputs` (the bound secret is used) and cannot override cwd.

## 8. Discoverability
`tm8 help loop …` (+ `--query`), MCP: the space MCP server exposes five group tools whose directories are the curated `guide()` arrays in packages/mcp/src/tools.ts; add `LOOP_GUIDES` — reads (get, list, runs.list, runs.get, schedule.preview) into `tm8_read`, commands into `tm8_act` — plus `REQUIRES_MUTATION_ID` entries and a mention in the `tm8_act` purpose string; write the schedule grammar, timezone and action meanings INTO the guide summaries (that is the only text a model sees); test modelled on 'forms through MCP' (packages/mcp/test/tools.test.ts); entity help page `entity-help/kinds/loop.tsx` rewritten to the new truths (Run now fires immediately; runs table; timezone; pickers); docs/features/loops/{DESIGN.md (this doc), LOOPS.md (user guide), VERIFY.md}; docs/api-and-cli/LOOP-CLI.md and an index entry; one line in the coordinator routine/prompt about `tm8 loop` for recurring work (shared with the Tools lane's prompt change).

## 9. Answers to the seven design questions
1. **Server-owned scheduling, `loops.*` ops**: yes. Why: two grammars drifted once already (browser vs server); a client that writes `nextRunAt` can wedge or double-fire a loop; and the ops give every surface (CLI, UI, MCP) one typed view with preview. `entities.*` stays for compatibility with the server computing the deadline.
2. **Run record**: edges stay (provenance), plus the `loop_runs` projection with derived status. Why: edges cannot say "skipped", "failed to launch", "timed out" or "manual", and a list that must join sessions to show outcomes needs one place to anchor them. Session and transcript are one click from the run row.
3. **What a firing can do**: spawn, dispatch, tool. Each is a first-class `action` with its own required fields and picker. Anything else (webhooks, messages) is a tool.
4. **Spawn configuration**: the full `LoopSpawnConfig` (§4.2) plus loop-level policy columns (concurrency, max runtime, retry). Skills follow the persona (no per-loop skill override in v1); memories via `memoryIds`.
5. **Schedule UX**: presets + custom cron, IANA timezone, server preview with summary and next 5; Run now fires synchronously and returns the session.
6. **Lifecycle and control**: enable/disable/pause-until/resume/edit-live/stop-run/delete as §3.5; armer recorded; run counts and last-24 h health on the view; restart semantics §3.2. Cost: sessions carry no cost telemetry today (research confirming), so v1 shows run count, durations and failures; a cost column is a follow-up when sessions record it.
7. **Discoverability**: §8.

## 10. Delivery plan (one worker per PR, worktree lanes, Reviewer on every PR)
| PR | scope | depends on |
|---|---|---|
| PR1 contract + migration + `loops.*` core | §2 migration (378+: loops columns incl. `armed_at`, loop_runs, doors incl. new create_loop/update_loop signatures, backfill), §4 types/schemas/ALL catalog rows + the CLI `ROWS` discovery rows (cmd null), handlers create/update/get/list/enable/disable/pause/resume/schedule.preview, timezone-aware `nextRunAt`, `describeSchedule`, `assertValidSchedule` on every write, server-computed nextRunAt in the `entities.*` loop arm, `'loop'` in the editable set, pg + unit tests | — (first commit = contract, pushed early) |
| PR2 runs + control | `loop_run_claim` door (claim-then-fire, §3.3) extending 375's due function with the §7 acting-identity rule and the orphan filter, executor fires claimed runs and settles them, derived status view incl. `usage` and `endedKind`, runNow (synchronous via port), runs.list/get/stop (via the `execution.terminate` path), max-runtime sweep, concurrency queue, retry, `actingAs` on the view, main.ts wiring | PR1 |
| PR3 spawn config + tool action | full config → SpawnRequest mapping, fireTool via Tools runtime, input validation on write and at fire time, triggered_by for tool runs | PR1 (+ Tools lead agreement) |
| PR4 CLI `tm8 loop` | §5, help, tests, LOOP-CLI.md, dev-server transcripts | PR1 contract (runs verbs exercised once PR2 is up) |
| PR5a UI form + list | create/edit form with pickers and preview, list columns, mount points, delete browser grammar | PR1 contract |
| PR5b UI page + runs | page header/controls, pause dialog, runs table with session links, stop | PR1 contract, PR2 for live data |
| PR6 docs + help + MCP + e2e | docs/features/loops, entity help rewrite, MCP guide entries, routine line, e2e over scheduling/firing/UI create | all |

Shared-file protocol with the Tools lane: loop additions in separate blocks/files; catalog rows appended under a `// loops` comment; CLI module `commands/loop.ts`; rebase on main when ready; branch names exchanged on both lead anchors. Migrations: next free number at PR time, rollback file per db/README.md; expect renumbering on rebase.

## 11. Verification plan
- pg suites (staging cluster 5443): every `loops.*` op; create→preview→enable→runNow→runs.list shows running→stop→stopped; pause/resume with a lapsed deadline fires once; queue vs skip; retry backoff; max runtime; timezone cron across a DST edge; invalid schedule stays enabled with reason; `entities.create` loop ignores client nextRunAt; migration up and rollback.
- Executor unit tests with a fake port (existing pattern: packages/server/test/scheduler/loops-job.test.ts, schedule.test.ts, facade/loop.test.ts).
- Commands (research C): pg suites `cd packages/server && TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres ./node_modules/.bin/vitest run --no-file-parallelism test/db/loops.pg.test.ts test/events/loop-visibility.pg.test.ts test/scheduler/loops-space-visibility.pg.test.ts test/scheduler/wired.pg.test.ts`; SQL doors `TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5443/tm8_test_<lane> node db/test/run.mjs` (resets that db, runs db/test/loop_rpcs.test.mjs); UI `cd packages/tm8-ui && ./node_modules/.bin/vitest run src/loops src/entity-help src/authoring src/domain/registry.test.ts`; CLI `cd packages/cli && ./node_modules/.bin/vitest run test/loop.test.ts`; MCP `cd packages/mcp && bun run test`; `bun install` first in a fresh lane and export TM8_W1_ADMIN_DATABASE_URL before `bash tools/ci/check.sh --fast` (it skips the migrations stage).
- CLI vitest per verb + a transcript against a dev-slot server attached to the lead task.
- UI vitest for the form (validation, preview, pickers), page controls, runs table; e2e create flow; screenshots attached.
- Real end-to-end on a dev-slot server with real PTYs: one loop per action fired by Run now and by the tick; evidence attached to the lead task.

## 12. Decisions needed from the owner
None blocking. Reviewer briefs must cover (coordinator notes): PR2 — stopSession goes through the same server path execution.stop uses, run settle on every exit path, queue concurrency never writes a new run row per tick, retry never exceeds retry_attempts, runNow overlap is a 409; PR3 — the fire-time invalid_input path lands as last_error AND a run row with launch=failed, and no second triggered_by for tool runs. Will be raised on the lead anchor with "DECISION NEEDED:" if the provenance research makes arming humanOnly (changes who can press Run now).

## 13. Out of scope / follow-ups
Ghost reconciliation and the lost-session reaper run as the node owner and cannot see sessions in spaces the owner is not a member of (the 375 bug class; loop-fired sessions there stay 'running' after a restart) — needs the 375 fix outside this lane. `execution.terminate` sends SIGHUP with no grace and ignores `force`; a SIGTERM→grace→SIGKILL ladder and `stopped_by` on the run are follow-ups. Two seed paths disagree on arming (boot seed unarmed, spaces.create seed armed by the creator). Event triggers (on entity change / on message) and conditions (`skipIf`), per-run budgets and cost (needs session telemetry), per-loop skill overrides, a run log beyond the session transcript, cross-space loops.
