# Execution (work sessions)

This family covers the lifecycle of a `work_session` — the entity behind one running (or once-running) agent or shell — from `execution.spawn` through the debug/observability reads (`journal`, `launch`, `transcript`, `liveness`) to the browser-only "session git rail" (`execution.git*`, 10 ops) that lets a browser, which has no machine of its own, run the same checkpoint/rollback/stage/commit/merge/cherry-pick/branch/stash verbs the CLI runs directly via `@tm8/execution/worktree` on its own machine. `execution.dispatch` hands an entity to a space's dispatcher session without naming a teammate; `execution.prompt` is a v1 catalog operation that stays registered (never 501) but is permanently refused to every public/HTTP caller — it exists only as an internal delivery adapter reachable by a server-minted principal, with `messages.post` as the real, public authoring path. Every write in this family is idempotent by `clientMutationId` when the server's idempotency ledger is enabled; every read that depends on filesystem or in-process state (journal, launch, transcript, the git rail, liveness) answers a named `available:false`/`unavailableReason` instead of a 404 or 500 when the underlying session/worktree/file is missing — a pattern used pervasively across this family.

## Summary

| name | method | path | kind | served |
|---|---|---|---|---|
| `execution.spawn` | POST | `/v2/execution/spawn` | command | yes |
| `execution.terminal.start` | POST | `/v2/execution/terminal` | command | yes |
| `execution.prompt` | POST | `/v2/entities/:id/commands/prompt` | command | yes (registered) — always 403 to public callers |
| `execution.terminate` | POST | `/v2/entities/:id/commands/terminate` | command | yes |
| `execution.streams.attach` | POST | `/v2/entities/:id/commands/streams-attach` | command | yes |
| `execution.resume` | POST | `/v2/entities/:id/commands/resume` | command | yes |
| `execution.sessions.share` | POST | `/v2/entities/:id/commands/sharing` | command | yes |
| `execution.journal` | GET | `/v2/work-sessions/:workSessionId/journal` | read | yes |
| `execution.launch` | GET | `/v2/work-sessions/:workSessionId/launch` | read | yes |
| `execution.gitStatus` | GET | `/v2/work-sessions/:workSessionId/git/status` | read | yes |
| `execution.gitDiff` | GET | `/v2/work-sessions/:workSessionId/git/diff` | read | yes |
| `execution.gitCheckpoint` | POST | `/v2/work-sessions/:workSessionId/git/checkpoint` | command | yes |
| `execution.gitRollback` | POST | `/v2/work-sessions/:workSessionId/git/rollback` | command | yes |
| `execution.gitCommit` | POST | `/v2/work-sessions/:workSessionId/git/commit` | command | yes |
| `execution.gitStage` | POST | `/v2/work-sessions/:workSessionId/git/stage` | command | yes |
| `execution.gitMerge` | POST | `/v2/work-sessions/:workSessionId/git/merge` | command | yes |
| `execution.gitCherryPick` | POST | `/v2/work-sessions/:workSessionId/git/cherry-pick` | command | yes |
| `execution.gitBranch` | POST | `/v2/work-sessions/:workSessionId/git/branch` | command | yes |
| `execution.gitStash` | POST | `/v2/work-sessions/:workSessionId/git/stash` | command | yes |
| `execution.liveness` | GET | `/v2/spaces/:spaceId/execution/liveness` | read | yes |
| `execution.transcript` | GET | `/v2/work-sessions/:workSessionId/transcript` | read | yes |
| `execution.dispatch` | POST | `/v2/execution/dispatch` | command | yes |

All 22 catalog rows are `status: v1` (`packages/contract/src/catalog.ts:253-521`, exact lines per operation cited in each section below) — none are `reserved`, so none answer `501 not_implemented`. `execution.prompt` is the one exception to "served means the caller gets what they asked for": it is registered and never 501, but its public handler unconditionally throws `403 forbidden`.

## Family-wide shared types

**`CommandContext`** (`packages/contract/src/contract.ts:1697-1706`; Zod `commandContextShape`/`CommandContextSchema`, `packages/contract/src/schemas.ts:1662-1669`) — the envelope every command DTO in this family extends:

| field | type | description |
|---|---|---|
| actorId | EntityId | optional; the acting identity, when distinct from the authenticated caller |
| clientMutationId | string | optional unless a specific DTO requires it; the idempotency key |
| workSessionId | EntityId | optional; present when the command is scoped to a session |

**`CommandResult`** (`contract.ts:1687-1695`) — the shared response `data` shape for `spawn`, `terminal.start`, `terminate`, `resume`, `sessions.share` (and generically for most command ops elsewhere in the contract), assembled by `assembleCommandResult()` (`packages/server/src/facade/execution-handlers.ts:2124-2131`):

| field | type | description |
|---|---|---|
| entity | EntityDetail | optional; the affected entity's full detail view (see the entities.* reference for `EntityDetail`/`EntitySummary`, `contract.ts:691`) |
| edge | EdgeView | optional |
| activity | ActivityItem | optional |
| patches | EntitySummary[] | incidental summary updates the command produced |
| undo | UndoToken | optional |
| warnings | ResultWarning[] | optional |

`execution.streams.attach` does **not** return `CommandResult` — see its own section.

**`ERROR_STATUS`** (`CommandErrorCode → HTTP status`, `contract.ts:1613-1637`) and **`CollabError`** (`contract.ts:1649-1669`, carrying `code`, `status`, `requestId`, `retryable`, `details.reason`) are the taxonomy every error in this doc is drawn from. Two independent translators feed it: `packages/server/src/db/errors.ts:62` `translateDbError` maps a Postgres `SQLSTATE` straight from an RPC (table at `packages/server/src/http/errors.ts:37-67`, e.g. `23514/23503/23505→invariant_violation`, `40001→version_conflict`, `53400→limit_exceeded`, `42501→forbidden`, `P0002→not_found`), and `execution-handlers.ts:2070-2093` `toCollabError` maps a JS-level `SpawnError` (`packages/execution/src/spawn/types.ts:1419-1435`) the same way (`conflict→invariant_violation`, `internal`/default→`upstream_unavailable`). A malformed (non-uuid) `:id`/`:workSessionId` path segment resolves to `not_found` (404), not `invalid_input` (`requireUuidParam`, `packages/server/src/facade/context.ts:127-133`).

**`SessionGitFile`** (`contract.ts:5180-5187`) — `{ status: string /* two-column XY, e.g. "M ", "??" */, path: string, origPath?: string }`, shared by every git-rail read/write that reports a file list. **Dirty counts** — `{ staged: number, unstaged: number, untracked: number, total: number }` — is the shape `gitStatus` and `gitStage` both return.

**The "available:false with a named reason" pattern**, used by `execution.journal`, `execution.launch`, `execution.transcript`, and all 10 `execution.git*` ops: instead of a 404/500 for a session that predates a feature or has no live worktree, the read returns `available: false` plus a stable `unavailableReason` string and empty/null data — see each op's Response table for its own enum.

**Idempotency** is disabled by default at the HTTP layer (`packages/server/src/http/idempotency.ts`); when disabled, `normalizeCommandInputForIdempotencyMode` injects a fresh `randomUUID()` as `clientMutationId` before Zod validation for any command whose DTO accepts one (`commandAcceptsClientMutationId`), so "each request must execute rather than replay." When enabled, the ledger keys on `(clientMutationId, operationName)`, generally subject-bound (session/entity id) so a replay cannot be handed a different subject's result.

---

### `execution.spawn`
`POST /v2/execution/spawn` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3032-3181`)
CLI: `tm8 session spawn --teammate <id> [--space <id>] [--task <id>...] [--memory <id>...] [--launch-project <id>] [--workdir project|scratch|worktree] [--base-ref <ref>] [--mode worker|coordinator|coordinated-worker|coordinated-coordinator|dispatcher] [--access-mode safe|acceptEdits|auto|plan|fullAccess] [--reasoning-effort low|medium|high|xhigh|max|ultra] [--credential-source <provider=member|space|node[:<id>]>...] [--interaction-profile <id>] [--context <text-source>] [--confirm-untrusted] [--force-new-task] [--mutation-id <id>]` (`packages/cli/src/commands/session.ts:450-557`; discovery row `packages/cli/src/discovery/operations.ts:1704-1717`)

Creates and starts a new `work_session` — resolves the persona, project, workdir mode, model/harness/access posture and initial context selection, mints an agent token, composes the launch manifest, and starts the real process/PTY.

**Path params** — none (body-only).

**Request body** (`ExecutionSpawnInputSchema`, `.strict()`, `packages/contract/src/schemas.ts:3206-3268`; type `ExecutionSpawnInput`, `contract.ts:4749-4866`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| clientMutationId | string | yes | min 1 | idempotency key |
| spaceId | uuid | yes | | target space |
| teamMemberId | uuid | yes | | persona to run as |
| parentSessionId | uuid | no | must be `work_session` or `chat` kind, same space | spawning lineage |
| taskIds | uuid[] | no | each resolved via `derive_task_for_entity` (RPC 064) | tasks to attach |
| forceNewTask | boolean | no | default false | |
| projectId | uuid \| null | no | must link to spaceId; trust-gated | |
| workdir | object (discriminated) | no | `{mode:'project'}` \| `{mode:'scratch'}` \| `{mode:'worktree', baseRef?}` | where the session works |
| workdir.baseRef | string | no | 1-255 chars | only for `mode:'worktree'` |
| confirmUntrusted | `true` | no | required to launch untrusted project | |
| interactionProfileId | uuid | no | | |
| mode | enum | no | `worker\|coordinator\|coordinated-worker\|coordinated-coordinator\|dispatcher` | |
| model | string \| null | no | | |
| agentTool | string \| null | no | | |
| reasoningEffort | enum | no | `low\|medium\|high\|xhigh\|max\|ultra` | |
| accessMode | enum | no | `safe\|acceptEdits\|auto\|plan\|fullAccess` | |
| credentialSources | object | no | `{anthropic?,openai?,github?}` each `member\|space\|node`, `.strict()` | |
| credentialSource | enum | no | deprecated global fallback | |
| spaceCredentialIds | object | no | `{anthropic?,openai?,github?}` uuids | |
| title | string | no | | |
| promptExtra | string \| null | no | manifest-time only | |
| memoryIds | uuid[] | no | max 32; mutually exclusive with `selection` | |
| selection | object | no | `{memoryIds?,skillIds?,referenceIds?}`, each max 240; refined ≥1 group | |
| selectionReasons | object | no | `{memories?,skills?,references?}` each `jev-failed\|jev-pending\|not-asked\|cli` | must not name a group `selection` also names |
| jevRunId | uuid | no | | best-effort link to an Ask Jev run |
| harnessSurface | enum | no | `minimal\|inherit` | |
| plugins | string[] | no | max 64, each 1-200 chars trimmed | |
| cols, rows | number | no | int 1-1000 (`TerminalDimSchema`, `schemas.ts:2188`) | initial PTY geometry |
| actorId, workSessionId | uuid | no | `commandContextShape` | |

Example request:
```json
POST /v2/execution/spawn
{
  "clientMutationId": "3f6a...-uuid",
  "spaceId": "<space-uuid>",
  "teamMemberId": "<teammate-uuid>",
  "taskIds": ["<task-uuid>"],
  "workdir": { "mode": "worktree", "baseRef": "origin/main" },
  "mode": "worker",
  "accessMode": "acceptEdits"
}
```
(illustrative, from schema)

**Response** — `201 Created`, `CommandResult` (`entity` = the new `work_session` EntityDetail).
```json
{ "data": { "entity": { "id": "<uuid>", "kind": "work_session", "...": "..." }, "patches": [] }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `invalid_input` (400) — RPC 22023: "persona belongs to another space"; "a spawn parent must be a work_session or a chat (got %)"; "parent session belongs to another space"; "worktree mode requires a project" (`db/migrations/178_spawn_parent_may_be_a_chat.sql:86,98-99,102,127`).
- `forbidden` (403) — "not permitted to spawn this persona"; "project is not linked to this space"; "spawning into an untrusted project requires explicit confirmation" (178:89,119,122-124).
- `limit_exceeded` (429) — "session concurrency cap reached", `details:{cap, live}`; cap from `TM8_SESSION_CAP` (default 64, `execution-handlers.ts:1647-1658`).
- `not_found` (404) — "project not found" (178:115).
- `upstream_unavailable` (503) — "execution_spawn returned no work_session id" (`execution-handlers.ts:955`); or any `SpawnError('internal', ...)` from manifest/credential/trust-probe resolution.

**Notes**: idempotent — ledger key `(clientMutationId, 'execution.spawn')` (178:66-72,160-166); a replay returns the stored result and suppresses duplicate side effects. Side effects: creates the `work_session` entity, `working_on` edges to each task, `relates_to` edge to the teammate, may auto-start a `to_do` task, best-effort `dispatched_by` edge when the spawner is itself a `dispatcher`-mode session, best-effort `jevRunId` link, may provision a git worktree (`workdir.mode:'worktree'`).
Source: `packages/contract/src/catalog.ts:253`; `packages/contract/src/schemas.ts:3206-3268`; `packages/server/src/facade/execution-handlers.ts:3032-3181`.

---

### `execution.terminal.start`
`POST /v2/execution/terminal` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3198-3220`)
CLI: none

Starts a bare shell `work_session` (session_kind `shell`) — a PTY on the node's login shell, no agent, no manifest, no persona. Deliberately has no CLI form: `packages/cli/src/discovery/operations.ts:1722-1737` records this as "a SCOPE DECISION rather than a refusal ... a CLI form would need no security change."

**Path params** — none.

**Request body** (`ExecutionTerminalStartInputSchema`, `.strict()`, `schemas.ts:3300-3309`; type `contract.ts:4893-4914`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| clientMutationId | string | yes | min 1 | |
| spaceId | uuid | yes | | |
| projectId | uuid \| null | no | root of the project, never a worktree | |
| confirmUntrusted | `true` | no | | |
| title | string | no | max 200 | defaults server-side to `'Terminal'` |
| cols, rows | number | no | int 1-1000 | |
| actorId, workSessionId | uuid | no | `commandContextShape` | |

Note: the body carries **no command/argv field** — enforced by `.strict()` as a security boundary (comment at `schemas.ts:3290-3299`); it can never be silently added.

Example request:
```json
POST /v2/execution/terminal
{ "clientMutationId": "<uuid>", "spaceId": "<space-uuid>", "title": "scratch shell" }
```
(illustrative, from schema)

**Response** — `201 Created`, `CommandResult` (`entity.sessionKind:'shell'`, `entity.agentTool: null`).

**Errors**:
- `limit_exceeded` (429) — "terminal concurrency cap reached"; separate cap from spawn, `TM8_TERMINAL_CAP` (default 4, `execution-handlers.ts:1009-1027,1673-1680`; RPC guard `db/migrations/101_shell_sessions.sql:195-199`).
- `not_found` (404) — "project not found" (101:207).
- `forbidden` (403) — "project is not linked to this space"; "opening a terminal in an untrusted project requires explicit confirmation" (101:211,213-216).

**Notes**: idempotent, ledger key `(clientMutationId, 'execution.terminal.start')` (101:187-190). RPC: `public.start_shell_session` (`db/migrations/101_shell_sessions.sql:174-259`; call site `execution-handlers.ts:1013-1039`).
Source: `packages/contract/src/catalog.ts:258`; `packages/contract/src/schemas.ts:3300-3309`; `packages/server/src/facade/execution-handlers.ts:3198-3220`.

---

### `execution.prompt`
`POST /v2/entities/:id/commands/prompt` · kind: command · status: v1 · served: yes (registered, `execution-handlers.ts:3314`) — every public/HTTP caller gets a hard-coded `403 forbidden`, never a 501
CLI: none — `packages/cli/src/commands/session.ts:6-15` states no flag/alias/debug path enables a caller-facing form; discovery row `operations.ts:1771-1785` (`reason:'use_message_send'`, `composite:'messages.post'`)

A v1 catalog operation kept registered on purpose so it answers honestly (an unregistered v1 op would 501, falsely claiming the capability doesn't exist), but its public handler is `async () => refusePublicExecutionPrompt()` (`execution-handlers.ts:3314`), which always throws. The real delivery path, `promptInternal` (`packages/server/src/facade/services/w2/execution.ts`), is reachable only by an object minted by `mintSystemDeliveryPrincipal` and checked by identity in a private `WeakSet` — no request shape can forge it.

**Path params**

| name | type | description |
|---|---|---|
| id | uuid | the target `work_session` entity id |

**Request body** (`ExecutionPromptInputSchema`, `.strict()`, `schemas.ts:3343-3346`; type `contract.ts:4959-4961`) — validated (schema-only) even though the handler always refuses, because request validation runs *before* the handler is reached (`input-schemas.ts:9-15`; `server.ts:427-439,461`):

| field | type | required | constraints |
|---|---|---|---|
| message | string | yes | min 1 |
| actorId, clientMutationId, workSessionId | — | no | `commandContextShape` |

**Response** — never a success for a public caller.

**Errors**:
- `invalid_input` (400) — a schema-invalid body (e.g. empty `message`) is rejected before the handler runs, so it never reaches the refusal.
- `forbidden` (403) — every schema-valid public request: `refusePublicExecutionPrompt()` throws `CollabError('forbidden', 'execution.prompt is a Server-internal delivery adapter; the public authoring route is messages.post', { details: { reason: 'use_message_send', publicComposite: 'messages.post' } })` (`packages/server/src/facade/services/w2/execution.ts:74,84-90`).

**Notes**: to reach a live session as a real caller, use `messages.post` — persistence first, delivery second. The internal path writes via `public.record_execution_command` with `p_operation='execution.prompt'` (only `execution.prompt`/`execution.terminate` are accepted there, `db/migrations/041_w2_sec1_stage2_execution_command_resource_binding.sql:95-97`) and delivers into the live PTY, settling via a `PromptSettlementWaiter`.
Source: `packages/contract/src/catalog.ts:259`; `packages/contract/src/schemas.ts:3343-3346`; `packages/server/src/facade/execution-handlers.ts:3293-3314`; `packages/server/src/facade/services/w2/execution.ts:74-90`.

---

### `execution.terminate`
`POST /v2/entities/:id/commands/terminate` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3340-3352`)
CLI: `tm8 session terminate <work-session-id> [--force] --yes [--mutation-id <id>]` (`--yes` required for this destructive op; `packages/cli/src/commands/session.ts:638-657`; discovery `operations.ts:1800-1809`)

Stops a running session's PTY (graceful by default, `force` kills it) and records the terminal status/ending facts.

**Path params**

| name | type | description |
|---|---|---|
| id | uuid | the `work_session` entity id |

**Request body** (`ExecutionTerminateInputSchema`, `.strict()`, `schemas.ts:3348-3351`; type `contract.ts:4968-4970`):

| field | type | required | description |
|---|---|---|---|
| force | boolean | no | graceful stop by default; force kills the PTY |
| actorId, clientMutationId, workSessionId | — | no | `commandContextShape` |

Example request: `POST /v2/entities/<id>/commands/terminate` `{ "force": false }` (illustrative, from schema)

**Response** — `200 OK`, `CommandResult`.

**Errors**:
- `invalid_input` (400) — RPC-level "unsupported execution command: %" (only fires if operation is neither `execution.prompt` nor `execution.terminate`; effectively unreachable from this handler, `041...sql:95-97`).
- `not_found` (404) — entity missing/deleted (`internal.live_entity`).
- `upstream_unavailable` (503) — `SpawnError('internal', ...)`: "failed to terminate work session %: the kill signal itself failed" — the DB is deliberately left non-terminal rather than lying (`SpawnService.ts:2811-2816`).

**Notes**: idempotent via `public.record_execution_command` ledgering (`execution-handlers.ts:1557-1565`). Terminating an already-dead session is treated as the user cancelling something that just finished, not an error. Writes `endedKind`/`endedReason` (migration 171).
Source: `packages/contract/src/catalog.ts:260`; `packages/contract/src/schemas.ts:3348-3351`; `packages/server/src/facade/execution-handlers.ts:3316-3352`; `packages/execution/src/spawn/SpawnService.ts:2722-2820`.

---

### `execution.streams.attach`
`POST /v2/entities/:id/commands/streams-attach` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3386-3425`)
CLI: `tm8 session attach <work-session-id> --mode view|drive [--grant-only] [--mutation-id <id>]` (`--format json` implies `--grant-only`; `session.ts:713-741`; discovery `operations.ts:1810-1819`)

Mints a one-shot WebSocket capability grant to attach to a session's live PTY, in `view` or `drive` mode.

**Path params**

| name | type | description |
|---|---|---|
| id | uuid | the `work_session` entity id |

**Request body** (`ExecutionStreamsAttachInputSchema`, `.strict()`, `schemas.ts:3360-3363`; type `contract.ts:4995-4997`):

| field | type | required | constraints |
|---|---|---|---|
| mode | enum | yes | `view \| drive` |
| actorId, clientMutationId, workSessionId | — | no | `commandContextShape` |

**Response** — `200 OK` with header `cache-control: no-store`. **Not** a `CommandResult` — a dedicated `StreamAttachGrant` DTO (`contract.ts:5020-5029`), built explicitly in the handler:

| field | type | description |
|---|---|---|
| workSessionId | EntityId | target session |
| url | string | `/v2/ws?sessionId=<id>&mode=<mode>` (server-relative, transport-only) |
| protocol | `'ws'` | |
| mode | `'view'\|'drive'` | echoed grant mode |
| token | string | one-shot PTY bearer capability; never in `url`; returned once |
| expiresAt | ISO string | ≤60s TTL, server-clamped, default 30s |

```json
{ "data": { "workSessionId": "<uuid>", "url": "/v2/ws?sessionId=<uuid>&mode=view", "protocol": "ws", "mode": "view", "token": "<redacted>", "expiresAt": "2026-09-25T12:00:30.000Z" }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `invalid_input` (400) — "invalid stream grant credential" / "invalid stream mode" (server-internal defensive checks, effectively unreachable from a well-formed client) (`db/migrations/202_work_session_sharing_provenance.sql:120-121,145-147`).
- `forbidden` (403) — "this session is not shared" (view gate); "this session is view-only for you" (drive gate) (202:162-164,168-172).
- `upstream_unavailable` (503) — "stream grant mint returned an invalid scope" / "...invalid expiration" (`execution-handlers.ts:3406-3412`).
- `not_found` (404) — session missing/deleted.

**Notes**: idempotent, ledger key `(clientMutationId, 'execution.streams.attach')`, subject-bound to session id + mode (202:129-138). Side effect: upserts a row in `public.stream_grants`. RPC: `public.grant_stream_attach` (202:105-191; call site `execution-handlers.ts:1567-1585`).
Source: `packages/contract/src/catalog.ts:261`; `packages/contract/src/schemas.ts:3360-3363`; `packages/server/src/facade/execution-handlers.ts:3386-3425`.

---

### `execution.resume`
`POST /v2/entities/:id/commands/resume` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3322-3338`)
CLI: `tm8 session resume <work-session-id> [--mutation-id <id>]` (`session.ts:622-636`; discovery `operations.ts:1786-1799`)

Restarts a `work_session` that has exited or failed, re-spawning its PTY via provider-native resume (`claude --resume <uuid>` / `codex resume <id>`) and re-reading persona/project/model/workdir from the graph rather than accepting them again.

**Path params**

| name | type | description |
|---|---|---|
| id | uuid | the `work_session` entity id |

**Request body** (`ExecutionResumeInputSchema`, `.strict()`, `schemas.ts:3353-3358`; type `contract.ts:4984-4989`):

| field | type | required | constraints |
|---|---|---|---|
| clientMutationId | string | yes | min 1 |
| cols, rows | number | no | int 1-1000 |
| actorId, workSessionId | — | no | `commandContextShape` |

**Response** — `200 OK`, `CommandResult`.

**Errors** (RPC `db/migrations/062_session_resume.sql`):
- `forbidden` (403) — "not permitted to resume this persona" (062:91).
- `invariant_violation` (409) — "work session is not resumable from status %" (062:97-98).
- `limit_exceeded` (429) — "session concurrency cap reached" (062:104-106), same cap as spawn.
- `not_found` (404) — session missing/deleted.
- JS-level (`SpawnService.resume`, via `toCollabError`): `invariant_violation` (409) — "already has a live terminal — nothing to resume"; "is '<status>' — only exited or failed sessions can be resumed"; "recorded as an isolated worktree but its row carries no workdir path"; "already has a different native session id recorded"; "has no recorded native session id ... cannot be resumed" (`SpawnService.ts:1931-1942,2046-2119`). `invalid_input` (400) — "has no linked Teammate — cannot reconstruct its launch"; "agent tool '<tool>' has no resume-by-id contract" (1944-1949,2009-2014). `not_implemented` (501) — "resume is not supported under a TM8_AGENT_CMD operator wrapper" (2016-2021). `not_found` (404) — "the worktree for session %s is gone" (2057-2064).

**Notes**: idempotent, ledger key `(clientMutationId, 'execution.resume')`, subject-bound to session id (062:78-80); a replay short-circuits before re-acquiring a worktree lease or spawning a second process (`SpawnService.ts:2136-2158`). Side effects: `status` transitions `exited/failed → spawning → running`, clears prior exit evidence, moves `node_id`, bumps `entities.version`, records activity `'restored'`.
Source: `packages/contract/src/catalog.ts:262`; `packages/contract/src/schemas.ts:3353-3358`; `packages/server/src/facade/execution-handlers.ts:3316-3338`; `packages/execution/src/spawn/SpawnService.ts:1918-2130`.

---

### `execution.sessions.share`
`POST /v2/entities/:id/commands/sharing` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3364-3384`)
CLI: `tm8 session share <work-session-id> [--share none|space] [--drive owner|space] [--expect-version <n>] [--mutation-id <id>]` (`session.ts:673-711`; discovery `operations.ts:1820-1829`)

Sets a session's `shareMode`/`driveMode` (who can view/drive its PTY). Narrowing revokes existing live stream grants.

**Path params**

| name | type | description |
|---|---|---|
| id | uuid | the `work_session` entity id |

**Request body** (`ExecutionSessionsShareInputSchema`, `.strict()`, refined, `schemas.ts:3370-3381`; type `contract.ts:5013-5018`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| shareMode | enum | no | `none \| space` (not `'explicit'` — readable but not writable via this door) | |
| driveMode | enum | no | `owner \| space` | |
| expectedVersion | integer | no | ≥0 | optimistic concurrency against the session entity's version |
| actorId, clientMutationId, workSessionId | — | no | `commandContextShape` | |

At least one of `shareMode`/`driveMode` is required (`.refine`, `invalid_input` at the schema layer if neither is present). An absent field merges (leaves unchanged) rather than resetting.

**Response** — `200 OK`, `CommandResult`.

**Errors**:
- `invalid_input` (400) — "nothing to change: name share_mode, drive_mode, or both" (RPC-level defense-in-depth, unreachable given the schema refinement); "unknown share_mode/drive_mode: %" (unreachable, zod enum) (`db/migrations/202_work_session_sharing_provenance.sql:217-227`).
- `forbidden` (403) — "only the session owner or a space admin may change its sharing" (202:234-239).
- `version_conflict` (409) — `expectedVersion` mismatch, `details:{entityId, currentVersion}` (`internal.assert_version`, `db/migrations/007_rpc_catalog.sql:69-83`).
- `not_found` (404) — session missing/deleted.

**Notes**: idempotent, ledger key `(clientMutationId, 'execution.sessions.share')`, subject-bound (202:209-214). Side effects: updates `share_mode`/`drive_mode`/`sharing_set_at`, bumps `entities.version`; narrowing (`share_mode:'none'` or `drive_mode:'owner'`) revokes live `stream_grants` for everyone but the creator's own identity.
Source: `packages/contract/src/catalog.ts:267`; `packages/contract/src/schemas.ts:3370-3381`; `packages/server/src/facade/execution-handlers.ts:3354-3384`.

---

### `execution.journal`
`GET /v2/work-sessions/:workSessionId/journal` · kind: read · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:2800-2836`)
CLI: `tm8 session journal <work-session-id> [--limit <count>] [--before <line-index>]` (`operations.ts:1837-1850`)

Reads a session's own on-disk `tm8` CLI command journal (`<dataDir>/journals/<sessionId>.jsonl`) — every `tm8` invocation the session's process made, what it printed, and byte-derived token estimates. Records only `tm8` commands, not general shell history.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id (validated as uuid; resolved as a live `work_session` entity under the caller's claims — that read IS the authorization gate) |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| limit | integer | no | default 100 (`JOURNAL_LIMIT_DEFAULT`), capped at 500 (`JOURNAL_LIMIT_MAX`) | page size |
| before | integer | no | 0-based line ordinal, ≥0 | pagination cursor — read the window immediately older than this ordinal |

**Response** — `200 OK`, `data` = `SessionJournalPage` (`contract.ts:5680-5717` approx.; Zod `SessionJournalPageSchema`, `schemas.ts:3544-3558`):

| field | type | description |
|---|---|---|
| sessionId | EntityId | |
| available | boolean | false when there is no journal file to read |
| unavailableReason | `'no_journal_file'\|'unreadable'\|null` | |
| totals | object | `{invocations, failed, agentToCliEst, cliToAgentEst, estimator:'chars/4', malformed}` |
| records | `SessionJournalRecord[]` | see below |
| hasMore | boolean | true if there is an older page |

`SessionJournalRecord` (`contract.ts:5540-5570` approx.; `SessionJournalRecordSchema`, `schemas.ts:3511-3542`): `v:1`, `seq`, `class?:'agent'|'harness'|'human'`, `sessionId`, `spaceId`, `teamMemberId`, `pid`, `startedAt`, `durationMs`, `command:{path,argv,cwd}`, `input:{stdinChars}`, `output:{stdoutChars,stderrChars,stdoutSample,stderrSample,truncated}`, `calls: SessionJournalCall[]`, `contextRead?:{schemaVersion}`, `result:{exitCode,error}`, `tokens:{estimator:'chars/4',agentToCli,cliToAgent}`.

```json
{ "data": { "sessionId": "<uuid>", "available": true, "unavailableReason": null, "totals": { "invocations": 12, "failed": 0, "agentToCliEst": 4200, "cliToAgentEst": 9800, "estimator": "chars/4", "malformed": 0 }, "records": [ { "v": 1, "seq": 11, "sessionId": "<uuid>", "spaceId": "<uuid>", "teamMemberId": "<uuid>", "pid": 4821, "startedAt": "2026-09-25T10:00:00.000Z", "durationMs": 340, "command": { "path": ["entities","get"], "argv": ["tm8","entities","get","<id>"], "cwd": "/work" }, "input": { "stdinChars": 0 }, "output": { "stdoutChars": 512, "stderrChars": 0, "stdoutSample": "...", "stderrSample": "", "truncated": false }, "calls": [], "result": { "exitCode": 0, "error": null }, "tokens": { "estimator": "chars/4", "agentToCli": 3, "cliToAgent": 128 } } ], "hasMore": false }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `not_found` (404) — "no such work session: <id>".
- `invalid_input` (400) — `limit`/`before` present but not a valid positive/non-negative integer.

**Notes**: no auth beyond the entity read (RLS on `entities`) — an unreadable session is indistinguishable from a missing one. Token counts are byte-derived estimates ("chars/4"), never the model provider's reported usage.
Source: `packages/contract/src/catalog.ts:274`; `packages/contract/src/contract.ts:5524-5680` (record/page types); `packages/contract/src/schemas.ts:3500-3558`; `packages/server/src/facade/execution-handlers.ts:2791-2836`.

---

### `execution.launch`
`GET /v2/work-sessions/:workSessionId/launch` · kind: read · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:2855-2920`)
CLI: `tm8 session launch <work-session-id>` (`operations.ts:1851-1862`)

Reads what a session was told at spawn time: its stored manifest, env var *names* only, and its verbatim system/task prompts (never recomposed).

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

No entity pre-check here (unlike `journal`) — the `session_manifests_select` RLS policy already requires `entity_readable(work_session_id)`, so a caller who cannot read the session sees exactly the same shape as a session with no manifest.

**Response** — `200 OK`, `data` = `SessionLaunchRecord` (`contract.ts:5524+`≈; `SessionLaunchRecordSchema`, `schemas.ts:3566-3596`):

| field | type | description |
|---|---|---|
| sessionId | EntityId | |
| available | boolean | false when there is no `session_manifests` row |
| unavailableReason | `'no_manifest_row'\|null` | |
| manifest | `Record<string,unknown> \| null` | deliberately untyped/unvalidated raw jsonb |
| envVarNames | string[] | names only, never values |
| prompts.system / prompts.task | string \| null | verbatim as recorded |
| prompts.unavailableReason | `'not_recorded'\|null` | true for both when neither was captured (pre-073 sessions) |
| recordedAt | string \| null | ISO timestamp |
| launchContext | object \| null | `{entries:[{entityId,role,kind,title,source,viaTaskId,skillLoad,jev}], hiddenCount, unlinkedMemories, unlinkedSkillCount}` |

```json
{ "data": { "sessionId": "<uuid>", "available": true, "unavailableReason": null, "manifest": { "mode": "worker" }, "envVarNames": ["ANTHROPIC_API_KEY", "TM8_SESSION_ID"], "prompts": { "system": "<redacted>", "task": "<redacted>", "unavailableReason": null }, "recordedAt": "2026-09-25T09:58:00.000Z", "launchContext": { "entries": [], "hiddenCount": 0, "unlinkedMemories": [], "unlinkedSkillCount": 0 } }, "requestId": "<uuid>" }
```
(illustrative, from schema — real prompts/env var names redacted per capture rules regardless)

**Errors**: none specific to this handler beyond the standard auth/RLS path (an unreadable session renders identically to one with no manifest, by design).

**Notes**: `envVarNames` intentionally carries names, not values — no secret material rides this read. `launchContext` is computed by `projectLaunchContext(db, claims, manifest)`.
Source: `packages/contract/src/catalog.ts:283`; `packages/contract/src/schemas.ts:3560-3596`; `packages/server/src/facade/execution-handlers.ts:2837-2920`.

---

### `execution.gitStatus`
`GET /v2/work-sessions/:workSessionId/git/status` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:429-513`)
CLI: none — the CLI runs git directly on its own machine via `@tm8/execution/worktree` (`tm8 worktree status`); this HTTP op exists only because a browser has no machine (`operations.ts:1865-1871`, `reason:'cli_runs_git_locally'`)

Branch, dirty counts, and ahead/behind the session's base, read live from the session's worktree (resolved server-side from the newest `in_worktree` graph edge — no request ever names a filesystem path).

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Response** — `200 OK`, `data` = `SessionGitStatus` (`contract.ts:5194-5221`):

| field | type | description |
|---|---|---|
| sessionId | EntityId | |
| available | boolean | |
| unavailableReason | `'no_worktree'\|'worktree_not_active'\|'worktree_unreadable'\|null` | |
| worktreeId | EntityId \| null | |
| branch | string \| null | |
| baseRef | string \| null | |
| baseOid | string \| null | |
| headOid | string \| null | |
| ahead / behind | number \| null | commits HEAD has that base lacks / vice versa; null if base doesn't resolve |
| dirty | object | `{staged, unstaged, untracked, total}` |
| files | `SessionGitFile[]` | capped at 200 (`STATUS_FILES_CAP`) |
| filesTruncated | boolean | |
| stashes | `SessionGitStashEntry[]` | optional; rides this read so `gitStash` needs no read half |
| checkedAt | string | ISO |

```json
{ "data": { "sessionId": "<uuid>", "available": true, "unavailableReason": null, "worktreeId": "<uuid>", "branch": "tm8/session-abc", "baseRef": "origin/main", "baseOid": "<sha>", "headOid": "<sha>", "ahead": 3, "behind": 0, "dirty": { "staged": 1, "unstaged": 2, "untracked": 0, "total": 3 }, "files": [ { "status": " M", "path": "src/foo.ts" } ], "filesTruncated": false, "checkedAt": "2026-09-25T10:00:00.000Z" }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**: none thrown for a missing/inactive worktree — that is the `available:false` path, not an error. `not_found` (404) only if `workSessionId` itself doesn't resolve to a live entity (`resolveLane`, `execution-git.ts:350-376`).

**Notes**: a git status listing that overflows an 8 MiB buffer (`STATUS_BYTES_MAX`) degrades to `worktree_unreadable` rather than throwing (comment at `execution-git.ts:69-94`). `-uall` is used so new directories list their files rather than collapsing to `dir/`.
Source: `packages/contract/src/catalog.ts:291`; `packages/contract/src/contract.ts:5190-5221`; `packages/server/src/facade/services/execution-git.ts:429-513`.

---

### `execution.gitDiff`
`GET /v2/work-sessions/:workSessionId/git/diff` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:515-`≈820)
CLI: none — same `cli_runs_git_locally` reason as `gitStatus`

"What did this session change": working tree vs the merge-base of the session's base ref by default, narrowable to `staged`/`unstaged` and/or a single `path`. The numstat digest is always complete; the unified diff text is byte-capped.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| maxBytes | integer | no | default 256 KiB, capped at 1 MiB | unified diff text cap |
| scope | enum | no | `session` (default) \| `staged` \| `unstaged` | which comparison to run |
| path | string | no | guarded by `assertSafePathspec` (no absolute, no `..`, no leading dash) | narrow to one file |

**Response** — `200 OK`, `data` = `SessionGitDiff` (`contract.ts:5294-5354`):

| field | type | description |
|---|---|---|
| sessionId, available, unavailableReason, branch, baseRef, baseOid | — | same shape as `gitStatus` |
| mergeBaseOid | string \| null | commit the diff is measured from |
| headOid | string \| null | |
| stat | object | `{filesChanged, additions, deletions}` |
| files | `SessionGitDiffFile[]` | `{path, additions, deletions}`; additions/deletions null for binary; capped at 500 (`DIFF_FILES_CAP`) |
| filesTruncated | boolean | |
| diff | string | unified diff text, capped at `maxBytes` |
| diffTruncated | boolean | |
| scope | `SessionGitDiffScope` | echoed back, never inferred |
| path | string \| null | echoed back |
| hunks | `SessionGitDiffHunk[] \| null` | selectable hunks; only for `staged`/`unstaged` scope with a single `path` and an uncapped diff |
| hunkDigest | string \| null | pins `hunks` to the read; echo back to `execution.gitStage` |
| untracked | boolean | true when `path` names a file git is not tracking |
| checkedAt | string | |

```json
{ "data": { "sessionId": "<uuid>", "available": true, "unavailableReason": null, "branch": "tm8/session-abc", "baseRef": "origin/main", "baseOid": "<sha>", "mergeBaseOid": "<sha>", "headOid": "<sha>", "stat": { "filesChanged": 1, "additions": 4, "deletions": 1 }, "files": [ { "path": "src/foo.ts", "additions": 4, "deletions": 1 } ], "filesTruncated": false, "diff": "diff --git a/src/foo.ts b/src/foo.ts\n...", "diffTruncated": false, "scope": "session", "path": null, "hunks": null, "hunkDigest": null, "untracked": false, "checkedAt": "2026-09-25T10:00:00.000Z" }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `invalid_input` (400) — `maxBytes` not a positive integer; `scope` not one of `session|staged|unstaged`; an unsafe `path` (`path_outside_worktree` when a symlink escapes the worktree, `execution-git.ts:270-279`).
- `not_found` (404) — session doesn't resolve.

**Notes**: an untracked path is diffed via `git diff --no-index` only in `session` scope (the whole new file); `staged`/`unstaged` answer empty for an untracked path — both are correct, not gaps. A path that resolves to a `.gitignore`d file is refused rather than dumped (see `check-ignore` handling in the source).
Source: `packages/contract/src/catalog.ts:292`; `packages/contract/src/contract.ts:5233-5354`; `packages/server/src/facade/services/execution-git.ts:515-820`.

---

### `execution.gitCheckpoint`
`POST /v2/work-sessions/:workSessionId/git/checkpoint` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:844-858`)
CLI: none over HTTP for the browser rail — the CLI's own `tm8 session checkpoint` runs `checkpoint()` from `@tm8/execution/worktree` directly, on its own machine, bypassing this op entirely (`packages/cli/src/commands/session-git.ts:1-40`)

Commits all work-in-progress (tracked and untracked, `git add -A` + commit) on the session's own branch as a checkpoint. A clean tree succeeds without creating a commit.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** (`ExecutionGitCheckpointInputSchema`, `.strict()`, `schemas.ts:3383-3386`; type `contract.ts:5046-5049`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| message | string | no | min 1 | defaults to `tm8 checkpoint <ISO timestamp>` server-side |
| actorId, clientMutationId, workSessionId | — | no | `commandContextShape` | |

**Response** — `200 OK`, `data` = `SessionGitCheckpointResult` (`contract.ts:5356-5365`): `{sessionId, worktreeId, oid, branch, created:boolean, files:SessionGitFile[]}` — `created:false` and `files:[]` when the tree was already clean.

**Errors** (via `liftWorktreeError`, mapping `WorktreeError.code` straight through except `internal→invariant_violation`):
- `conflict` (409) — `no_operable_worktree` family from `requireActiveLane` (`no_worktree`/`worktree_not_active`/`no_branch`); `detached_head`; `branch_mismatch` (worktree checked out to a different branch than the graph records); `merge_in_progress` (`git-mutations.ts:148,151-154,166-169`).
- `invariant_violation` (409) — `add_failed`/`commit_failed` (underlying git command failed, `internal` code lifted; `git-mutations.ts:283,290`).
- `invalid_input` (400) — `empty_message`/`message_too_long`/`unsafe_message` (`git-mutations.ts:65,68,71,74`).

**Notes**: not ledgered by `clientMutationId` at the DB layer (this rail's writes are plain argv git, not RPC-backed) — repeating the same request creates a second checkpoint commit only if the tree is dirty again; a clean tree always succeeds as a no-op.
Source: `packages/contract/src/catalog.ts:293`; `packages/contract/src/schemas.ts:3383-3386`; `packages/server/src/facade/services/execution-git.ts:844-858`; `packages/execution/src/worktree/git-mutations.ts:265-293`.

---

### `execution.gitRollback`
`POST /v2/work-sessions/:workSessionId/git/rollback` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:860-875`)
CLI: none over HTTP — CLI's `tm8 session rollback` calls `rollback()` from `@tm8/execution/worktree` locally

Restores the worktree to a checkpoint (`git reset --hard <to>`), moving the branch ref with it. Rolled-over commits stay reachable via reflog.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** (`ExecutionGitRollbackInputSchema`, `.strict()`, `schemas.ts:3388-3392`; type `contract.ts:5051-5059`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| to | string | yes | min 1 | checkpoint ref: full oid, short oid, or symbolic ref |
| force | boolean | no | | also deletes untracked files that would otherwise block the rollback |

**Response** — `200 OK`, `data` = `SessionGitRollbackResult` (`contract.ts:5367-5377`): `{sessionId, worktreeId, oid, branch, previousOid, deletedUntracked:string[]}`.

**Errors**:
- `conflict` (409) — `untracked_files_present` when untracked files exist and `force` is not set (`git-mutations.ts:330-334`); plus the shared `no_worktree`/`branch_mismatch`/`detached_head` family.
- `not_found` (404) — `commit_not_found` when `to` doesn't resolve to a commit in this worktree (`resolveCommitish`, `git-mutations.ts:240-243`).
- `invariant_violation` (409) — `reset_failed`/`clean_failed` (underlying git command failed).

**Notes**: untracked files are the one unrecoverable case (they may exist in no commit), so they gate on `force`; tracked WIP is discarded unconditionally, which is what rollback exists to do.
Source: `packages/contract/src/catalog.ts:294`; `packages/contract/src/schemas.ts:3388-3392`; `packages/server/src/facade/services/execution-git.ts:860-875`; `packages/execution/src/worktree/git-mutations.ts:316-350`.

---

### `execution.gitCommit`
`POST /v2/work-sessions/:workSessionId/git/commit` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:898-987`)
CLI: none over HTTP — CLI's `tm8 worktree commit` runs locally

Commits a specific selection of paths (`paths`) or the whole tree (`all:true`) — never the ambient index — refusing if the index already holds staged content outside the selection.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** (`ExecutionGitCommitInputSchema`, `.strict()`, `schemas.ts:3394-3399`; type `contract.ts:5061-5067`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| message | string | yes | min 1 | |
| paths | string[] | no | each min 1 | pathspecs to stage before committing |
| all | boolean | no | | stage everything (`git add -A`) before committing |

**Response** — `200 OK`, `data` = `SessionGitCommitResult` (`contract.ts:5379-5385`): `{sessionId, worktreeId, oid, branch, files:SessionGitFile[]}`.

**Errors**:
- `conflict` (409) — `staged_outside_selection` — `details:{reason, outsidePaths (capped 200), outsideCount, hint}` when the index already holds staged paths the selection didn't name (`execution-git.ts:913-926`); plus `nothing_staged` (`git-mutations.ts:734-741`) if nothing ends up staged; plus the shared `no_worktree`/`branch_mismatch`/`merge_in_progress` family.
- `invalid_input` (400) — `unsafe_pathspec`, `empty_message`/`message_too_long`/`unsafe_message`.
- `invariant_violation` (409) — `commit_failed`.

**Notes**: a staged deletion with no replacement file on disk is dropped from the re-stage list rather than failing `git add` with exit 128 (`execution-git.ts:928-972`) — "delete a file, Stage, Commit selected" completes correctly.
Source: `packages/contract/src/catalog.ts:295`; `packages/contract/src/schemas.ts:3394-3399`; `packages/server/src/facade/services/execution-git.ts:898-987`; `packages/execution/src/worktree/git-mutations.ts:723-751`.

---

### `execution.gitStage`
`POST /v2/work-sessions/:workSessionId/git/stage` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:998-1080`)
CLI: none over HTTP — CLI's `tm8 worktree stage` runs locally

Stages or unstages paths (`action:'stage'|'unstage'`), the whole tree (`all`), or specific hunks within one file (`hunks`) — `git add -p` without the interactive prompt. Returns the full post-operation status, not an acknowledgement.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** (`ExecutionGitStageInputSchema`, `.strict()`, `schemas.ts:3406-3432`; type `contract.ts:5092-5128`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| action | enum | yes | `stage \| unstage` | |
| paths | string[] | no | each min 1 | mutually exclusive with `hunks` |
| all | boolean | no | | whole worktree |
| hunks.path | string | no | min 1 | required if `hunks` present |
| hunks.indices | number[] | no | 1-based, from a prior `gitDiff`'s `hunks` | which hunks to (un)stage |
| hunks.digest | string | no | min 1 | echoed `hunkDigest` from that `gitDiff` read; refuses if the file moved underneath it |

The server refuses an empty combination (`nothing_to_stage`/`nothing_to_unstage`) rather than the schema rejecting it, so the error names which verb wanted what.

**Response** — `200 OK`, `data` = `SessionGitStageResult` (`contract.ts:5130-5163`):

| field | type | description |
|---|---|---|
| sessionId, worktreeId, branch | — | |
| action | `'stage'\|'unstage'` | |
| paths | string[] | paths git actually acted on (may be longer than the request for unstage on a rename) |
| all | boolean | |
| staged | `SessionGitFile[]` | index-vs-HEAD after the operation |
| files | `SessionGitFile[]` | full porcelain status after the operation, capped |
| filesTruncated | boolean | |
| dirty | object | `{staged, unstaged, untracked, total}` |
| hunkSelection | object | optional; `{path, applied, total}` for a hunk request |
| checkedAt | string | |

**Errors**:
- `invalid_input` (400) — `nothing_to_stage`/`nothing_to_unstage` (`git-mutations.ts:366,459`); `unsafe_pathspec`; `no_hunks_selected` (`git-mutations.ts:665`); hunk index out of range/invalid.
- `conflict` (409) — shared `no_worktree`/`branch_mismatch`/`merge_in_progress` family.

**Notes**: hunk indices are never patch text — the server re-derives and slices the diff itself, so a client cannot smuggle an arbitrary `git apply --cached` payload.
Source: `packages/contract/src/catalog.ts:298`; `packages/contract/src/schemas.ts:3401-3432`; `packages/server/src/facade/services/execution-git.ts:998-1142`.

---

### `execution.gitMerge`
`POST /v2/work-sessions/:workSessionId/git/merge` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:1143-1166`)
CLI: none over HTTP — CLI's `tm8 worktree merge` runs locally

Merges a ref (default: the session's recorded base ref) forward into the session's branch. Only this direction is supported — base is checked out elsewhere or nowhere, and this rail must not mutate the user's primary checkout.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** (`ExecutionGitMergeInputSchema`, `.strict()`, `schemas.ts:3434-3438`; type `contract.ts:5174-5178`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| fromRef | string | no | min 1 | defaults to the session's recorded base ref (or base oid) |
| message | string | no | min 1 | |

**Response** — `200 OK`, `data` = `SessionGitMergeResult` (`contract.ts:5457-5459`, union):
- `{sessionId, worktreeId, status:'merged'|'up_to_date', oid, fromRef, fromOid}`
- `{sessionId, worktreeId, status:'conflict', fromRef, fromOid, conflictedPaths:string[]}` — the merge is aborted and the worktree restored clean; conflict is data, not an error.

**Errors**:
- `conflict` (409) — `no_base_ref` (handler-level, when neither `fromRef` nor a recorded base is available, `execution-git.ts:1148-1151`); plus shared `no_worktree`/`branch_mismatch`/`merge_in_progress` family.
- `invariant_violation` (409) — an abort itself fails (`WorktreeError.code:'internal'` lifted).

**Notes**: a merge conflict never leaves the worktree mid-merge — `mergeFromRef`'s abort is verified server-side before the response is sent.
Source: `packages/contract/src/catalog.ts:299`; `packages/contract/src/schemas.ts:3434-3438`; `packages/server/src/facade/services/execution-git.ts:1143-1166`; `packages/execution/src/worktree/git-mutations.ts:770-850`.

---

### `execution.gitCherryPick`
`POST /v2/work-sessions/:workSessionId/git/cherry-pick` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:1186-1198`)
CLI: none over HTTP — CLI's `tm8 worktree cherry-pick` runs locally

Applies one or more commits onto the session's branch. A conflict aborts the whole sequence (verified) and returns the conflicted paths as data.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** (`ExecutionGitCherryPickInputSchema`, `.strict()`, `schemas.ts:3440-3443`; type `contract.ts:5393-5396`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| commits | string[] | yes | min 1 item, each min 1 char | commitishes, oldest first |

**Response** — `200 OK`, `data` = `SessionGitCherryPickResult` (`contract.ts:5398-5400`, union):
- `{sessionId, worktreeId, status:'picked', branch, fromOids:string[], newOids:string[]}`
- `{sessionId, worktreeId, status:'conflict', branch, fromOids:string[], conflictedPaths:string[]}`

**Errors**:
- `invalid_input` (400) — `no_commits` (empty array, though the schema's `.min(1)` already rejects this) (`git-mutations.ts:1075`).
- `conflict` (409) — shared `no_worktree`/`branch_mismatch`/`merge_in_progress` family.
- `invariant_violation` (409) — abort failure.

**Notes**: multi-commit picks are all-or-nothing — the first conflict aborts the entire sequence.
Source: `packages/contract/src/catalog.ts:305`; `packages/contract/src/schemas.ts:3440-3443`; `packages/server/src/facade/services/execution-git.ts:1186-1198`; `packages/execution/src/worktree/git-mutations.ts:1059-1130`.

---

### `execution.gitBranch`
`POST /v2/work-sessions/:workSessionId/git/branch` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:1200-1225`)
CLI: none over HTTP — CLI's `tm8 worktree branch` runs locally

Create, rename, or delete a branch in the session's worktree. Refuses to touch a branch checked out in any worktree, or the session's recorded base branch.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** — discriminated union on `action` (`ExecutionGitBranchInputSchema`, `schemas.ts:3445-3449`; type `contract.ts:5409-5413`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| action | `'create'` | yes | | |
| name | string | yes (create) | min 1 | |
| from | string | no (create) | min 1 | base commitish; defaults to current HEAD |
| action | `'rename'` | yes | | |
| from | string | yes (rename) | min 1 | |
| to | string | yes (rename) | min 1 | |
| action | `'delete'` | yes | | |
| name | string | yes (delete) | min 1 | |
| force | boolean | no (delete) | | delete even if unmerged |

**Response** — `200 OK`, `data` = `SessionGitBranchResult` (`contract.ts:5415-5425`, union matching the action):
- create: `{sessionId, worktreeId, action:'create', name, oid}`
- rename: `{sessionId, worktreeId, action:'rename', from, to, oid}`
- delete: `{sessionId, worktreeId, action:'delete', name, deletedOid, measuredAgainst, forced}`

**Errors**:
- `not_found` (404) — `branch_not_found` (rename/delete of a nonexistent branch).
- `conflict` (409) — the protected-branch refusal (session's recorded base ref, with/without remote prefix, `execution-git.ts:1176-1184`); a branch checked out in any worktree; `branch_delete_failed` (unmerged without `force`).
- `invalid_input` (400) — `branch_create_failed`/`branch_rename_failed` (illegal branch name or git-level failure).

**Notes**: `measuredAgainst` on a delete result names what "unmerged" was measured against (the worktree's HEAD branch) — the receipt is explicit about the check that passed.
Source: `packages/contract/src/catalog.ts:306`; `packages/contract/src/schemas.ts:3445-3449`; `packages/server/src/facade/services/execution-git.ts:1200-1225`; `packages/execution/src/worktree/git-mutations.ts:928-1057`.

---

### `execution.gitStash`
`POST /v2/work-sessions/:workSessionId/git/stash` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/execution-git.ts:1227-1258`)
CLI: none over HTTP — CLI's `tm8 worktree stash` runs locally; the stash *list* is read via `execution.gitStatus`'s `stashes` field, not a separate op

Push, pop, or drop a stash entry in the session's worktree. Push stores untracked files (`-u`) with no force gate; a conflicted pop retains the entry and reports conflicted paths as data; drop gates on `force`.

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Request body** — discriminated union on `action` (`ExecutionGitStashInputSchema`, `schemas.ts:3451-3455`; type `contract.ts:5435-5439`):

| field | type | required | constraints | description |
|---|---|---|---|---|
| action | `'push'` | yes | | |
| message | string | no (push) | min 1 | |
| action | `'pop'` | yes | | |
| index | integer | no (pop) | ≥0 | defaults to the newest entry |
| action | `'drop'` | yes | | |
| index | integer | yes (drop) | ≥0 | |
| force | boolean | no (drop) | | |

**Response** — `200 OK`, `data` = `SessionGitStashResult` (`contract.ts:5441-5446`, union):
- `{action:'push', status:'stashed', oid, branch, files}` or `{action:'push', status:'clean', branch}` (nothing to stash)
- `{action:'pop', status:'popped', oid, branch, files}` or `{action:'pop', status:'conflict', oid, branch, conflictedPaths}`
- `{action:'drop', droppedOid, subject}`

**Errors**:
- `not_found` (404) — `stash_not_found` when `index` names no entry, `details:{entries: <count>}` (`git-mutations.ts:1219,1282`).
- `invalid_input` (400) — `invalid_stash_index` (negative/non-integer, `git-mutations.ts:1137`).
- `conflict` (409) — shared `no_worktree`/`branch_mismatch` family.

**Notes**: `SessionGitStashEntry` (`contract.ts:5449-5454`): `{index, oid, subject, date}` — this is the shape `gitStatus`'s `stashes` field returns.
Source: `packages/contract/src/catalog.ts:307`; `packages/contract/src/schemas.ts:3451-3455`; `packages/server/src/facade/services/execution-git.ts:1227-1258`; `packages/execution/src/worktree/git-mutations.ts:1142-1296`.

---

### `execution.liveness`
`GET /v2/spaces/:spaceId/execution/liveness` · kind: read · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:2743-2790`)
CLI: `tm8 session liveness [--space <space-id>]` (`operations.ts:1978-1989`)

The one authority on "is there a live PTY right now" — answered from the node's in-process PTY map, scoped to one space, never from recorded `work_sessions.status` (which can be stale between server boots; ghost reconciliation only runs at startup).

**Path params**

| name | type | description |
|---|---|---|
| spaceId | uuid | the space to scope the liveness check to |

**Response** — `200 OK`, `data` = `ExecutionLiveness` (`contract.ts:5495-5522`):

| field | type | description |
|---|---|---|
| liveEntityIds | EntityId[] | `work_session` entity ids in this space with a live PTY on this node, right now |
| nodeBootId | string | stable for this server process's lifetime; rotates on restart |
| checkedAt | string | ISO, point-in-time |
| capacity | object | `{used, total}` — node-wide admission truth also used by `execution.spawn`'s concurrency gate |
| eventHwm | number \| null | durable event high-water mark for this space (`space_event_seq.last_seq`); null means it cannot be established (never "no events") |

```json
{ "data": { "liveEntityIds": ["<uuid>"], "nodeBootId": "<boot-id>", "checkedAt": "2026-09-25T10:00:00.000Z", "capacity": { "used": 3, "total": 64 }, "eventHwm": 128734 }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `not_found` (404) — "no such space: <id>" (RLS-indistinguishable from a foreign space).

**Notes**: a live id the caller cannot read (RLS) stays invisible rather than leaking another space's session id. Comparing `nodeBootId` across two reads tells a client "same node, session genuinely gone" from "node restarted, statuses are stale until reconciliation."
Source: `packages/contract/src/catalog.ts:342`; `packages/contract/src/contract.ts:5480-5522`; `packages/contract/src/schemas.ts:3479-3492`; `packages/server/src/facade/execution-handlers.ts:2738-2790`.

---

### `execution.transcript`
`GET /v2/work-sessions/:workSessionId/transcript` · kind: read · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:2937-3020`≈)
CLI: `tm8 session transcript <work-session-id> [--last <count>]` (`operations.ts:1963-1977`)

Reads what the agent SAID — the newest turns of its own native transcript file (claude-code or codex dialect), normalized to `user`/`assistant` prose entries, with tool-call counts and token totals for the read window. Never the PTY (ANSI repaints) and never the CLI journal (no model output).

**Path params**

| name | type | description |
|---|---|---|
| workSessionId | uuid | the `work_session` entity id |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| last | integer | no | default 20 (`TRANSCRIPT_LAST_DEFAULT`), capped at 200 (`TRANSCRIPT_LAST_MAX`) | newest N entries to return |
| before | integer | no | positive byte offset, from a prior page's `windowStart` | page-back cursor |
| files | `'1'` | no | | when set, also scans the whole transcript for observed Edit/Write tool calls |

**Response** — `200 OK`, `data` = `SessionTranscriptPage` (`contract.ts:5865-5943`):

| field | type | description |
|---|---|---|
| sessionId | EntityId | |
| available | boolean | |
| unavailableReason | `'no_native_session_id'\|'unsupported_agent_tool'\|'no_transcript_file'\|'unreadable'\|null` | |
| searchedPaths | string[] | bounded set of candidate files checked when unavailable |
| agentTool | `'claude-code'\|'codex'\|null` | |
| entries | `SessionTranscriptEntry[]` | oldest-first; `{at, source:'user'\|'assistant', text, truncated}` |
| stats | `SessionTranscriptStats \| null` | window aggregates: `{partial, userMessages, assistantMessages, toolCalls, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, tools:[{name,count}], models:[string]}` — never a lifetime total |
| stuck | `SessionTranscriptStuck \| null` | heuristic: `{silentMs, toolCallsSinceText}` |
| lastActivityAt | string \| null | |
| malformed | number | unparseable lines, surfaced not dropped |
| windowStart | number \| null | byte-offset page-back cursor |
| hasOlder | boolean | true iff `windowStart > 0` |
| fileChanges | `SessionFileChanges \| null` | optional; present only when `files=1` and the dialect supports it (claude-code) |
| context | `SessionTranscriptContext \| null` | optional; the latest request's context-window usage snapshot |

```json
{ "data": { "sessionId": "<uuid>", "available": true, "unavailableReason": null, "searchedPaths": [], "agentTool": "claude-code", "entries": [ { "at": "2026-09-25T10:00:00.000Z", "source": "assistant", "text": "<redacted>", "truncated": false } ], "stats": { "partial": true, "userMessages": 1, "assistantMessages": 1, "toolCalls": 4, "inputTokens": 12000, "outputTokens": 800, "cacheReadTokens": 9000, "cacheCreationTokens": 0, "tools": [{ "name": "Read", "count": 4 }], "models": ["claude-sonnet-5"] }, "stuck": null, "lastActivityAt": "2026-09-25T10:00:00.000Z", "malformed": 0, "windowStart": 4096, "hasOlder": true }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `not_found` (404) — session doesn't resolve.
- `invalid_input` (400) — `last`/`before` present but not a valid positive integer.

**Notes**: tool call *arguments* and *output* are never returned — only that a tool was called and its name — because tool bodies are where file contents and secrets travel. `stuck` is a heuristic (evidence, not verdict); `execution.liveness` is the authority on whether anything is running. `fileChanges.source` is always `'transcript'` (observed tool calls), never a git diff.
Source: `packages/contract/src/catalog.ts:510`; `packages/contract/src/contract.ts:5770-6060`≈; `packages/contract/src/schemas.ts:3683+`; `packages/server/src/facade/execution-handlers.ts:2921-3020`.

---

### `execution.dispatch`
`POST /v2/execution/dispatch` · kind: command · status: v1 · served: yes (`packages/server/src/facade/execution-handlers.ts:3236-3291`)
CLI: `tm8 session dispatch <subject-entity-id> [--space <space-id>] [--note <text>] [--force-new-task] [--mutation-id <id>]` (`operations.ts:1755-1770`)

Hands any launchable entity to a space's dispatcher session, which picks the teammate and spawns — the caller never names who does the work. If no dispatcher session is alive, the server spawns one first and waits for it to settle (liveness-probed, never read off `work_sessions.status`). The task is derived and the request stored *before* anything is pushed at a terminal, so a missed delivery is still recoverable.

**Path params** — none (body-only).

**Request body** (`ExecutionDispatchInputSchema`, `.strict()`, `schemas.ts:3321-3328`; type `contract.ts:4917+`≈):

| field | type | required | constraints | description |
|---|---|---|---|---|
| clientMutationId | string | yes | min 1 | |
| spaceId | uuid | yes | | |
| subjectId | uuid | yes | | any launchable entity; derived to a task server-side exactly as `--task` is |
| forceNewTask | boolean | no | | |
| note | string | no | max 4000 | |
| actorId, workSessionId | uuid | no | `commandContextShape` | |

**Response** — `202 Accepted`, `data` = `ExecutionDispatchResult` (`ExecutionDispatchResultSchema`, `schemas.ts:3335-3341`):

| field | type | description |
|---|---|---|
| taskId | EntityId | the derived task |
| dispatcherSessionId | EntityId | the (possibly newly spawned) dispatcher session |
| dispatcherSpawned | boolean | true if this call spawned the dispatcher |
| requestMessageId | EntityId | optional; the stored request message, when one was created |
| delivery | `'delivered'\|'undelivered'` | reported, never thrown on — an undelivered push still leaves a durable stored message |

```json
{ "data": { "taskId": "<uuid>", "dispatcherSessionId": "<uuid>", "dispatcherSpawned": false, "requestMessageId": "<uuid>", "delivery": "delivered" }, "requestId": "<uuid>" }
```
(illustrative, from schema)

**Errors**:
- `upstream_unavailable` (503) — "could not derive a task for <subjectId>" (`execution-handlers.ts:3250`).
- Any error `resolveDispatcherSession`/`sendDispatchRequest` can raise while spawning/finding the dispatcher session (shares `execution.spawn`'s error surface for the spawn path).

**Notes**: idempotency keys are derived from `clientMutationId`: `${clientMutationId}:dispatcher-spawn` for the dispatcher spawn and `${clientMutationId}:dispatch-request` for the request message, so one client mutation id safely covers both possible side effects. `requesterActorId` is deliberately `null` when the caller names no actor (the common UI case) rather than the caller's non-uuid identity id, which previously raised a Postgres `22P02` on every UI-originated dispatch; `internal.resolve_actor(null, space)` falls back to the caller's own member row.
Source: `packages/contract/src/catalog.ts:521`; `packages/contract/src/schemas.ts:3321-3341`; `packages/server/src/facade/execution-handlers.ts:3222-3291`.
