# Session spawn flow audit

Date: 2026-07-29  
Scope: read-only trace from a task-row `Run` click through the UI seam, contract/catalog, HTTP facade, graph/RPC, manifest, PTY spawn, and exit transition. No app, database, test suite, or real agent/session was run.

## Verdict

**The real click-to-spawn flow is not wired end to end.** The transport and server/execution call graph is present and internally coherent for a valid project-backed Claude request, but neither current task launch surface reliably constructs such a request:

- the workspace gives both launch surfaces static fixture teammates/projects/profiles/capacity even when `useGateData` selected the real seam;
- inline Quick Launch always sends `workdir: { mode: 'scratch' }`, which the registered server handler always refuses;
- the full sheet bypasses `LaunchConfig` with `as never`, drops most displayed selections, and sends a non-UUID fixture project/persona to the real server;
- repeated clicks reuse a ledger idempotency key, and non-Claude executable/prompt construction is inconsistent;
- the PTY receives the entire server process environment, not the curated environment whose names are recorded.

In a non-production browser with no override, the app now selects the real seam (`realSeamFlag.ts:94-100`, `useGateData.ts:126-139`), so these are live blockers. A production build is separately hard-wired back to the fixture seam (`realSeamFlag.ts:94-96`).

## Ordered hop trace

| Hop | File:line | Status | Note |
|---:|---|:---:|---|
| 1 | `packages/tm8-ui/src/domain/actions.ts:211-220` | OK | `ActionRef = run` is marked `flow: 'launch'` and availability is gated on catalog op `execution.spawn` plus `canEdit`. |
| 2 | `packages/tm8-ui/src/panels/EntityListPanel.tsx:1135-1151,1167-1193` | OK | The row action resolves registry data, opens the launch flow instead of dispatching directly, and stops the row click. |
| 3 | `packages/tm8-ui/src/panels/EntityListPanel.tsx:1091-1109` | OK | The expanded row mounts `LaunchQuickConfig` with the real task id/title, current `spaceId`, spawn callback, and caller-provided mutation id. |
| 4 | `packages/tm8-ui/src/views/WorkspaceView.tsx:191-203` | ISSUE | Quick Launch sources are always `LAUNCH_TEAMMATES` and `LAUNCH_CAPACITY`, not data hydrated from the active seam. Its mutation id is the deterministic `launch:${taskId}`. |
| 5 | `packages/tm8-ui/src/views/launch-fixtures.ts:66-120` | ISSUE | The supplied teammate/project/profile ids are presentation fixtures (`ent-tm-forge`, `pj-tm8ui`, `pf-standard`), not UUID-backed resources from the real node; capacity is always the invented `5/8`. |
| 6 | `packages/tm8-ui/src/domain/launch.ts:340-356` | ISSUE | Quick config defaults every teammate to `{ kind: 'scratch' }`. The selected model/tool are taken from the fixture teammate (or UI defaults) and mode is always `worker`. |
| 7 | `packages/tm8-ui/src/panels/launch/LaunchQuickConfig.tsx:116-128,257-295` | ISSUE | Quick Launch calls the shared builder with the task id/title, but it has no project control, so every real submission remains scratch. Rejections are correctly retained and rendered rather than swallowed. |
| 8 | `packages/tm8-ui/src/views/WorkspaceView.tsx:220-231` | ISSUE | The full sheet is also fed the static `LAUNCH_*` fixtures, even when `data` is backed by `createRealSeam`. |
| 9 | `packages/tm8-ui/src/views/LaunchSheet.tsx:86-110,168-200,292-302` | ISSUE | The sheet allows multiple project ids and a pseudo-project marked `scratch`, resolves a profile, and submits `{teammateId, projectIds, profileId}`; it does not submit the displayed teammate model/tool or a mode. |
| 10 | `packages/tm8-ui/src/views/GateApp.tsx:349-364` | ISSUE | Full-sheet submission keeps only `projectIds[0]`, ignores `profileId`, omits task title/model/tool/mode, casts `projectId` and the partial config with `as never`, and reuses `launch:${subjectId}:${teammateId}`. |
| 11 | `packages/tm8-ui/src/domain/launch.ts:405-437` | ISSUE | For a complete `LaunchConfig`, the builder maps scratch/project to `projectId + workdir`, preserves task ids/title/profile/prompt/consent, and supplies space/persona/model/tool/mode. But it coerces nullable `teamMemberId` with `as EntityId`; the full-sheet cast lets missing `mode`, `model`, and `agentToolId` become runtime `undefined` and disappear during JSON serialization. |
| 12 | `packages/tm8-ui/src/views/realSeamFlag.ts:94-100,134-143`; `packages/tm8-ui/src/views/useGateData.ts:126-140` | ISSUE | Development/staging defaults to the real HTTP seam, test to fixture, but production is unconditionally fixture. There is no runtime fallback from a failed real node, which is correct. |
| 13 | `packages/tm8-ui/src/views/useGateData.ts:342-350` | OK | `spawn()` awaits `seam.commands.spawn(input)` and then rehydrates. It deliberately discards the `CommandResult`; the authoritative reads are fetched again. A rejection propagates to the launch surface. |
| 14 | `packages/tm8-ui/src/data/seam.ts:195-215`; `packages/tm8-ui/src/data/real/seam-real.ts:253-281` | OK | The seam command accepts `ExecutionSpawnInput` verbatim and the real seam delegates `spawn` to the typed op wrapper. |
| 15 | `packages/tm8-ui/src/data/real/ops.ts:329-332`; `packages/tm8-ui/src/data/real/http.ts:151-200` | OK | The op wrapper calls catalog name `execution.spawn`; HTTP derives method/path from the catalog, JSON-serializes the input, unwraps `{data, requestId}`, and turns non-2xx responses into `CollabError`. |
| 16 | `packages/contract/src/catalog.ts:132-136` | OK | `execution.spawn` is present as `POST /v2/execution/spawn`, command, `v1`. The recurring declaration-without-consumer failure is not present for spawn. |
| 17 | `packages/contract/src/contract.ts:1006-1056`; `packages/contract/src/schemas.ts:1212-1233` | ISSUE | Type and strict schema agree field-for-field, including scratch/worktree and `interactionProfileId`. However, those advertised inputs are not all implemented by the server/execution layer (hops 22 and 28). ID primitives are only non-empty strings (`schemas.ts:68-69,1116`), so fixture-shaped non-UUID ids pass HTTP validation and fail later in PostgreSQL. |
| 18 | `packages/server/src/http/router.ts:77-105`; `packages/server/src/http/server.ts:156-183` | OK | Router entries are generated from the catalog. The request matches method/path, resolves identity, retrieves the registered handler, validates the body using `INPUT_SCHEMAS`, and invokes it. |
| 19 | `packages/server/src/facade/input-schemas.ts:164-173`; `packages/server/src/http/server.ts:220-226` | OK | `execution.spawn` is bound to `ExecutionSpawnInputSchema`; invalid/unknown fields become a 400 `invalid_input`. |
| 20 | `packages/server/src/main.ts:98-113,144-154` | OK | With a database configured, bootstrap builds one execution runtime and registers its handlers on the same registry used by HTTP. Without a database the op honestly remains 501. |
| 21 | `packages/server/src/facade/execution-handlers.ts:397-431`; `packages/server/src/main.ts:237-241` | OK | The runtime constructs one `PtyHostService`, wires its exit callback to the same `SpawnService`, and hands that same PTY host to the WS layer. |
| 22 | `packages/server/src/facade/execution-handlers.ts:626-655` | ISSUE | The registered spawn handler rejects `workdir.mode=scratch` and any `interactionProfileId` before graph work. Otherwise it copies space/persona/tasks/project/workdir/consent/mode/model/tool/title/prompt/mutation id into `SpawnRequest`, defaulting omitted launch fields to `null`. |
| 23 | `packages/server/src/facade/execution-handlers.ts:125-209` | OK | Persona and tasks are read from the requested space. **Known project gotcha is fixed:** project lookup uses `public.projects JOIN public.space_projects`, not `entities kind=project` (`:141-163`). Caller task order is restored in memory. |
| 24 | `packages/execution/src/spawn/SpawnService.ts:140-170` | OK | `SpawnService` receives the handler parameters intact, resolves persona/default launch config and graph-owned cwd, then calls `createWorkSession` with the resolved values. |
| 25 | `packages/execution/src/spawn/manifest.ts:103-126,137-170` | ISSUE | Explicit request mode/model/tool correctly precede persona defaults. Project cwd comes from graph truth. Worktree is advertised but always throws `not_implemented`; projectless requests are turned into a server scratch path while retaining workdir mode `project` unless the rejected `scratch` discriminant reached this layer. |
| 26 | `packages/server/src/facade/execution-handlers.ts:213-249`; `db/migrations/007_rpc_catalog.sql:2027-2113` | OK | The graph port calls `public.execution_spawn` in declared positional order. The RPC checks identity/persona/cap/trust/linkage, creates the `work_session` row in `spawning`, creates every `working_on` task edge and the persona `relates_to` edge, and records the ledger result in the same transaction. |
| 27 | `db/migrations/001_core_graph.sql:691-718`; `db/migrations/007_rpc_catalog.sql:2116-2164` | OK | `work_sessions` stores node/project/cwd/status/tool/model/mode/exit fields. Status has one writer; transition persists exit code/error and timestamps. |
| 28 | `packages/execution/src/spawn/SpawnService.ts:172-240`; `packages/execution/src/spawn/manifest.ts:454-523`; `db/migrations/007_rpc_catalog.sql:2166-2178` | OK | After the session id exists, scratch cwd is session-specific; manifest carries persona, resolved launch, cwd/project, ordered task DTOs, and `promptExtra`. The file is written before PTY spawn and the same manifest plus env **names** is recorded in `session_manifests`. |
| 29 | `packages/execution/src/spawn/SpawnService.ts:252-260` | OK | Manifest file write is atomic at reader level: write `*.tmp`, then rename. |
| 30 | `packages/execution/src/spawn/manifest.ts:213-218,236-271,299-307` | ISSUE | Claude command construction is coherent. Non-Claude tool selection is not: unknown tools (including the UI-offered `echo-agent`) fall back to `claude`, while a mapped `codex` command gets Claude's `--append-system-prompt` whenever no global override is set. |
| 31 | `packages/execution/src/spawn/manifest.ts:325-406`; `packages/execution/src/spawn/SpawnService.ts:213-219`; `packages/execution/src/pty/PtyHostService.ts:380-394` | ISSUE | `composeEnv` builds/records a curated set, but PTY spawn merges `{...process.env, ...env}`. The child receives all server variables while the manifest row records only curated names. |
| 32 | `packages/execution/src/spawn/SpawnService.ts:223-240`; `packages/execution/src/pty/PtyHostService.ts:367-413,505-506` | OK | The actual child receives session id, full shell command, graph/server-derived cwd, composed env, and optional terminal dimensions. It is spawned through `shell -c` and installed in the live session map. |
| 33 | `packages/execution/src/pty/PtyHostService.ts:434-503`; `packages/execution/src/spawn/SpawnService.ts:517-570` | OK | The null-exit evidence gotcha is fixed in the current tree: `exitCode` and signal are carried to the sink; a failed exit with neither writes an explicit named-unknown error; transition failure is printed even without an injected logger. |
| 34 | `packages/execution/src/spawn/SpawnService.ts:236-240`; `packages/server/src/facade/execution-handlers.ts:657-663`; `packages/tm8-ui/src/views/GateApp.tsx:365-373` | SUSPECT | Spawn returns 201 after PTY creation and `running` transition but does not wait for a boot/readiness window. An agent that dies immediately after those awaits can still make the sheet close and show “The session is running”; the detached exit path corrects the row afterward. This is a plausible UI-level explanation for the observed ~40 ms death looking successful, but the actual death cause was not reproduced. |
| 35 | `packages/contract/src/catalog.ts:164-165`; `packages/tm8-ui/src/data/real/ops.ts:84-96`; `packages/server/src/facade/execution-handlers.ts:588-625` | OK | The prior liveness catalog gotcha is fixed: `execution.liveness` exists in the catalog, the UI binds its catalog path, and the server registers a handler. `ops.ts:212` still has a stale “Uncataloged today” comment and uses `callPath`, but the path is catalog-derived and functional. |

## Ranked issues

### 1. CONFIRMED — real-seam launch controls are populated with fixture identities and resources

**What breaks:** In the real browser path, both quick and full launch render static teammates/projects/profiles/capacity rather than rows from the active node.

**Concrete failure:** Full-sheet project launch submits ids such as `ent-tm-forge` and `pj-tm8ui`. The contract's non-empty-string schemas accept them, but the server compares them with UUID columns and returns `not_found` (`22P02` maps to `not_found` in `packages/server/src/http/errors.ts:42-49`). No real `work_session` is created. Capacity and profile provenance shown before launch are also invented.

**Evidence:** `WorkspaceView.tsx:191-203,220-229`; `launch-fixtures.ts:66-120`; real seam selection at `useGateData.ts:126-139`; UUID-backed reads at `execution-handlers.ts:127-149`.

**Fix direction:** Add real seam reads/view-model adapters for linked projects, team members, profiles/defaults, and execution capacity; pass those into `WorkspaceView`. Keep fixtures only behind the fixture seam/test composition.

### 2. CONFIRMED — every inline Quick Launch requests a scratch mode the server refuses

**What breaks:** Quick Launch has no project picker and its canonical default target is scratch.

**Concrete failure:** `buildSpawnInput` emits `projectId: null, workdir: {mode:'scratch'}` and `execution.spawn` immediately returns 501 `not_implemented`. Therefore the row-level two-click Run path cannot spawn on the real server even if teammate ids are fixed.

**Evidence:** `domain/launch.ts:340-356,418-429`; `LaunchQuickConfig.tsx:257-274`; `execution-handlers.ts:626-630`. The contract advertises scratch at `contract.ts:1006-1045` and `schemas.ts:1212-1225`.

**Fix direction:** Implement scratch end to end (execution type, DB workdir constraint/semantics, handler) or stop advertising/emitting it and require a real linked project. Do not silently reinterpret scratch as project mode.

### 3. CONFIRMED — spawned agents inherit the server's entire process environment

**What breaks:** The environment whose names are audited is not the environment actually passed to the child.

**Concrete failure:** Variables such as `TM8_DATABASE_URL`, `TM8_DELIVERY_DATABASE_URL`, and unrelated server/operator secrets can be exposed to the agent. `session_manifests.env_var_names` omits them, so the audit record understates exposure.

**Evidence:** curated construction at `manifest.ts:325-406`; recorded names at `SpawnService.ts:213-219`; unconditional full merge at `PtyHostService.ts:380-394`.

**Fix direction:** Pass an allowlisted complete child environment. If baseline shell variables are needed, copy named safe keys explicitly; never merge all of `process.env` inside `PtyHostService`.

### 4. CONFIRMED — the full sheet displays configuration it does not send

**What breaks:** `GateApp` fabricates a partial `LaunchConfig` and suppresses the type errors with `as never`.

**Concrete failure:**

- selected/resolved `profileId` is dropped, so the promised immutable profile has no effect;
- only the first selected project survives; all additional project associations are silently dropped;
- the `scratch` pseudo-project is sent as a real `projectId`;
- displayed teammate model/tool and launch mode are absent, so server persona defaults win instead;
- title is absent, so the database/UI gets generic `Session` even though the manifest falls back to the task title.

**Evidence:** selection shape at `LaunchSheet.tsx:86-110,168-200,292-302`; partial cast and first-only selection at `GateApp.tsx:349-364`; builder reads missing properties at `domain/launch.ts:420-433`; generic title mapping at `packages/server/src/facade/entity-read.ts:527-548`.

**Fix direction:** Make the sheet own/return a complete `LaunchConfig`; use the same builder without casts; model scratch as the discriminated target rather than a project row; either implement extra project associations/profile pinning or refuse those controls with a reason.

### 5. CONFIRMED — launch mutation ids are reused across distinct user launches

**What breaks:** Quick uses `launch:${taskId}` forever; full uses `launch:${taskId}:${teammateId}` forever.

**Concrete failure:** The database ledger treats a later launch as a retry and replays the old session result (`execution_spawn` returns at the replay guard). If the old PTY is live, the UI reports success but creates nothing. If the old row is terminal, `SpawnService` can attempt a new PTY under the replayed old session id and then fail the forbidden terminal-to-running transition, leaving a child/process-row mismatch.

**Evidence:** `WorkspaceView.tsx:191-203`; `GateApp.tsx:349-355`; ledger replay at `007_rpc_catalog.sql:2045-2046`; replayed entity id is accepted as a fresh result at `execution-handlers.ts:213-249`; `spawnIfAbsent` then runs at `SpawnService.ts:223-236`.

**Fix direction:** Mint a fresh UUID/random id per deliberate submit and retain it only for transport retry of that same submit. Also make the execution RPC result expose replay so `SpawnService` never boots a new process for a ledger replay.

### 6. CONFIRMED — production builds are hard-wired to fixture data

**What breaks:** `resolveSeamSource` returns `fixture` before considering overrides whenever `MODE === 'production'`.

**Concrete failure:** A production build's Run action never makes the HTTP spawn call; fixture `spawn()` merely inserts an in-memory running summary (`seam-fixture.ts:844-872`). The production UI can therefore claim a session exists with no server manifest or child process.

**Evidence:** `realSeamFlag.ts:94-100`; seam construction at `useGateData.ts:126-139`; fixture spawn at `seam-fixture.ts:844-872`.

**Fix direction:** Default production to real and make fixture mode an explicit dev/test/demo composition that is visibly labelled.

### 7. CONFIRMED — non-Claude `agentTool` does not reach a correct child command

**What breaks:** Binary selection and prompt-delivery selection use different sources.

**Concrete failure:** With no global `TM8_AGENT_CMD`, mapped `codex` becomes `codex --append-system-prompt ...`, even though the source itself states Codex needs `-c developer_instructions=...`. Unknown tools fall back to Claude; the UI-offered `echo-agent` is not in the binary map and therefore also launches Claude unless a node-wide override happens to be set.

**Evidence:** UI offering at `domain/launch.ts:50-62`; map/fallback at `manifest.ts:213-246`; prompt selection at `manifest.ts:291-307`; the test gap is visible at `packages/execution/test/spawn-manifest.test.ts:176-183`, which tests non-Claude only when `TM8_AGENT_CMD` is explicitly set.

**Fix direction:** Pass resolved `agentTool` into prompt construction, implement verified per-tool flags/prompt delivery, add `echo-agent` to the per-session map, and reject unsupported tools instead of silently launching Claude.

### 8. CONFIRMED — the v1 input contract advertises unimplemented spawn variants

**What breaks:** Strict validation accepts scratch, worktree, and interaction profiles as v1 inputs, while downstream code refuses them.

**Concrete failure:** Scratch and profile ids receive handler-level 501s; worktree reaches execution then receives 501. A client generated solely from the v1 contract cannot know these advertised choices are unusable.

**Evidence:** `contract.ts:1006-1055`; `schemas.ts:1212-1233`; scratch/profile refusal at `execution-handlers.ts:626-633`; worktree refusal at `manifest.ts:137-153`.

**Fix direction:** Implement the declared variants or amend capability discovery/contract status so clients can gate them before submission. Keep a single source of supported spawn variants.

### 9. SUSPECTED — immediate child death can be acknowledged as a successful launch

**What breaks:** There is no child boot/readiness settlement in the HTTP await chain.

**Concrete failure:** If the PTY is created and the `running` transition commits before a ~40 ms child exit callback wins, the handler can return 201 and the full sheet closes with “The session is running.” The detached exit path later corrects the row to `failed`, but the launch surface has already rendered success.

**Evidence:** synchronous PTY return at `PtyHostService.ts:367-413,505-506`; detached exit callback at `:434-503`; spawn awaits only `running` at `SpawnService.ts:227-240`; 201 at `execution-handlers.ts:657-663`; success notice at `GateApp.tsx:365-373`.

**Fix direction:** Add a short, explicit boot settlement/early-exit race to `SpawnService.spawn`, or weaken the UI acknowledgement to “session created” and keep the launch state attached until liveness/status confirms running.

### 10. SUSPECTED — `buildSpawnInput` is not type-safe at its own boundary

**What breaks:** `LaunchConfig.teamMemberId` is nullable, but the builder coerces it with `as EntityId` instead of accepting a validated/non-null config type.

**Concrete failure:** Any caller that skips `canLaunch` can produce `teamMemberId: null`; the strict HTTP schema rejects it. The current full-sheet call already demonstrates how `as never` can bypass the intended precondition and drop other fields.

**Evidence:** nullable definition at `domain/launch.ts:316-336`; cast at `:420-429`; bypass at `GateApp.tsx:356-361`.

**Fix direction:** Split editable and submittable config types, or have the builder validate/narrow and return a refusal/result. Remove all spawn-path `as never` casts.

## Confirmed intact parameter chain (valid project-backed Claude request)

- `spaceId`: builder `domain/launch.ts:421-422` → handler `execution-handlers.ts:642-644` → context/RPC `SpawnService.ts:143-159` → manifest `manifest.ts:470-476` and env `:353-363`.
- `teamMemberId`: builder `domain/launch.ts:423` → handler `execution-handlers.ts:644` → graph read `execution-handlers.ts:127-139` → RPC/session-persona edge `007_rpc_catalog.sql:2051-2059,2103-2106` → manifest/env `manifest.ts:480-489,353-363`.
- `model`, `agentTool`, `mode`: builder `domain/launch.ts:426-428` → handler `execution-handlers.ts:649-651` → precedence `manifest.ts:103-126` → work-session row `SpawnService.ts:155-170` / `007_rpc_catalog.sql:2088-2093` → manifest/command/env `manifest.ts:490-495,236-271,353-365`.
- Project target: builder `domain/launch.ts:418-425` → handler `execution-handlers.ts:646-647` → `public.projects + space_projects` `execution-handlers.ts:141-163` → graph-owned cwd `manifest.ts:137-170` → DB row and PTY cwd `SpawnService.ts:155-174,227-234`.
- `taskIds`: quick/sheet callers → builder `domain/launch.ts:430` → handler `execution-handlers.ts:645` → task context `execution-handlers.ts:166-209` → transactional `working_on` edges `007_rpc_catalog.sql:2095-2102` → ordered manifest tasks `manifest.ts:501-516` and `TM8_TASK_IDS` `:353-363`.
- `clientMutationId`: UI caller → builder `domain/launch.ts:421` → command envelope/handler `execution-handlers.ts:635-655` → RPC `execution-handlers.ts:220-240` → ledger replay/record `007_rpc_catalog.sql:2045-2046,2108-2112`. Shape is intact; uniqueness is not (issue 5).

## Not traced / not verified dynamically

- No app, HTTP server, PostgreSQL instance, PTY, or agent CLI was run, per the read-only/no-real-session instruction. Runtime database contents, installed tool versions, PATH, proxy configuration, and filesystem permissions were not verified.
- The actual cause of the observed ~40 ms Codex death was not reproduced. The audit found a confirmed Codex command-construction defect and a confirmed success-before-readiness window, either of which can contribute, but does not claim one was the measured cause.
- The exact client-visible output of the non-Claude commands was not collected; failure consequences are derived from the constructed command and the source's own documented per-tool flag requirements.
- Interaction-profile resolution/pinning beyond the explicit server refusal was not followed because no spawn can currently carry one through the handler.
- Worktree creation is explicitly post-G1A/unimplemented; no external git/worktree code path exists to trace.
