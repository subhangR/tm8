# Containers

The `containers.*` family (TM8-CONTAINERS-DESIGN) manages node-local sandboxed machines —
shell, desktop, browser, android, ios and docker-in-docker profiles — that an agent or human
can create, drive and destroy. A container is an **entity** like any other: there is
deliberately no `containers.get` — read a container with the universal entity reads
(`entities.get`, `entities.children`, `entities.connections`, `collections.query`, documented
in the Entities reference). Only two reads are family-specific, because their truth lives on
the serving node rather than in the graph: `containers.providers.list` (what this node can
run) and `containers.logs` (its buffered stdout/stderr). Two more reads are node-local byte
transports rather than graph facts: `containers.files.get` (tar download) and
`containers.proxy` (a reverse proxy into an exposed container port). `containers.stream` is
not a second socket — it re-declares the existing `WS /v2/ws` (`events.subscribe`) binding so
the container family is discoverable under its own name; the PTY, screen frames and every
other container surface dial that one socket and it dispatches on the grant token.

**Every one of the 24 non-stream operations answers `501 not_implemented` on this build,
regardless of input.** This is not a per-operation gap; it is the current state of the whole
family, verified by reading the handler registration, not inferred:

- `packages/server/src/facade/index.ts:295` calls `registerW2ContainerHandlers(registry, { config: deps.config })` — **no `service` is ever passed**, so `ContainerHandlerDeps.service` is `undefined` on every server this repo builds today.
- `packages/server/src/facade/handlers/w2/containers.ts:240-265` registers a real handler function for all 24 rows (so the HTTP router does find a handler — this is *not* the router's own 404-for-unregistered-op path), but every one of those handlers is `unbound()` (`containers.ts:228-231`), whose body unconditionally `throw fail('not_implemented', ...)`. Reaching that body is called out in the source as itself "a wiring bug" that phase 1 is meant to replace.
- Before even reaching `unbound()`, `withContainerRuntime` (`containers.ts:189-221`) checks, in order: (1) `TM8_CONTAINERS` gate — `off` by default (`docs/ops/CONFIG.md:89`); (2) whether the op is in the `P0_IMPLEMENTED` set (7 of the 24: create/start/stop/pause/resume/destroy/providers.list); (3) whether `deps.service` exists. Because of the two points above, every operation fails at (1) when the gate is off (the default), or at (3) once the gate is on (since `service` is never composed) — and would still fail inside `unbound()` even if a service somehow existed.

So the "served" line below is written precisely: **the operation has a registered handler
(so it is not a router-level 404), but that handler always throws 501** — the specific reason
text differs by which of the three checks fails first. Confirmed live against this space:

```
$ tm8 container providers --format json
tm8: not_implemented: containers.providers.list: containers are not enabled on this node (TM8_CONTAINERS=off) · requestId: req_6881d2_29zd
```
(captured)

One correction to that "always 501" claim: **Zod body validation runs before the handler is
invoked** (`packages/server/src/http/server.ts:427-461` — `registry.get` finds the registered
stub handler first, then `INPUT_SCHEMAS[opName]` validates the body, then the handler is
called). So for the 19 commands bound in `INPUT_SCHEMAS` (everything except
`containers.files.put`, which is intentionally unbound — see its schema note below), a
malformed body **does** answer `400 invalid_input` today, exactly as the frozen contract
promises; only a *schema-valid* request reaches the always-501 stub. The four family-specific
reads (`files.get`, `logs`, `proxy`, `providers.list`) have no request body to validate and go
straight to the 501. The schemas below describe the contract these operations are frozen to,
not full end-to-end behavior — validation is real today, execution is not.

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `containers.create` | POST | `/v2/containers` | command | registered, always 501 (no service composed) |
| `containers.start` | POST | `/v2/containers/:containerId/commands/start` | command | registered, always 501 (no service composed) |
| `containers.stop` | POST | `/v2/containers/:containerId/commands/stop` | command | registered, always 501 (no service composed) |
| `containers.pause` | POST | `/v2/containers/:containerId/commands/pause` | command | registered, always 501 (no service composed) |
| `containers.resume` | POST | `/v2/containers/:containerId/commands/resume` | command | registered, always 501 (no service composed) |
| `containers.destroy` | POST | `/v2/containers/:containerId/commands/destroy` | command | registered, always 501 (no service composed) |
| `containers.update` | PATCH | `/v2/containers/:containerId` | command | registered, always 501 (not built: graph-only write path) |
| `containers.policy.set` | POST | `/v2/containers/:containerId/commands/policy` | command | registered, always 501 (not built: egress proxy, phase 4) |
| `containers.run` | POST | `/v2/containers/:containerId/commands/run` | command | registered, always 501 (not built: docker provider, phase 1) |
| `containers.terminal.start` | POST | `/v2/containers/:containerId/terminals` | command | registered, always 501 (not built: docker provider, phase 1) |
| `containers.attach` | POST | `/v2/containers/:containerId/attach` | command | registered, always 501 (not built: stream bridge, phase 2) |
| `containers.stream` | WS | `/v2/ws` (alias of `events.subscribe`) | stream | yes — socket is served (`events/ws-server.ts`) for event streaming; container-grant dispatch not found in that file |
| `containers.computer` | POST | `/v2/containers/:containerId/commands/computer` | command | registered, always 501 (not built: desktop profile, phase 2) |
| `containers.browser.endpoint` | POST | `/v2/containers/:containerId/commands/browser-endpoint` | command | registered, always 501 (not built: browser profile, phase 2) |
| `containers.files.put` | PUT | `/v2/containers/:containerId/files` | command | registered, always 501 (not built: file transfer, phase 5) |
| `containers.files.get` | GET | `/v2/containers/:containerId/files` | read | registered, always 501 (not built: file transfer, phase 5) |
| `containers.logs` | GET | `/v2/containers/:containerId/logs` | read | registered, always 501 (not built: docker provider, phase 1) |
| `containers.expose` | POST | `/v2/containers/:containerId/commands/expose` | command | registered, always 501 (not built: port exposure, phase 3) |
| `containers.unexpose` | POST | `/v2/containers/:containerId/commands/unexpose` | command | registered, always 501 (not built: port exposure, phase 3) |
| `containers.proxy` | GET | `/v2/containers/:containerId/ports/:port/*` | read | registered, always 501 (not built: exposed-port proxy, phase 3) |
| `containers.snapshot` | POST | `/v2/containers/:containerId/commands/snapshot` | command | registered, always 501 (not built: snapshots, phase 3) |
| `containers.fork` | POST | `/v2/containers/:containerId/commands/fork` | command | registered, always 501 (not built: forking, phase 3) |
| `containers.attention` | POST | `/v2/containers/:containerId/commands/attention` | command | registered, always 501 (not built: screen surface, phase 2) |
| `containers.providers.list` | GET | `/v2/containers/providers` | read | registered, always 501 (no service composed) |
| `containers.pools.set` | POST | `/v2/containers/:containerId/commands/pool` | command | registered, always 501 (not built: warm pools, phase 3) |

All 25 rows are `status: v1` (none are `reserved`). Source: `packages/contract/src/catalog.ts:539-566`.

## Shared types

Defined in `packages/contract/src/contract.ts` (types) and `packages/contract/src/schemas.ts`
(Zod), referenced by name below rather than repeated per operation.

**Enums**
- `ContainerProfile`: `shell | desktop | browser | android | ios | dind | custom`
- `ContainerStatus`: `requested | provisioning | running | paused | stopping | stopped | destroying | destroyed | failed` — read-only, single writer `public.set_container_status`
- `ContainerIsolationClass`: `process | container | gvisor | microvm | vm`, ordered weakest→strongest
- `ContainerSurfaceKind`: `terminal | screen | browser | adb | docker | http`
- `ContainerNetworkPreset`: `open | balanced | locked`
- `ContainerShareMode` (work-session vocabulary): `none | space | explicit`
- `ContainerPortShare` (exposed-port vocabulary — **not** the same set as `ContainerShareMode**): `none | space | link`

**`CommandContext`** — embedded in every command input: `actorId?: EntityId`, `clientMutationId?: string`, `workSessionId?: EntityId`. Each container command re-declares `clientMutationId` as required (`z.string().min(1)`). Source: `contract.ts:1698-1706`, `schemas.ts:1662-1669`.

**`CommandResult`** — the generic envelope most container commands return: `{ entity?: EntityDetail, edge?: EdgeView, activity?: ActivityItem, patches: EntitySummary[], undo?: UndoToken, warnings?: ResultWarning[] }`. For containers, `entity` (when present) is the container's `EntityDetail` — see the Entities reference for that shape. Source: `contract.ts:1687-1695`.

**`ContainerSpec`** (read) / **`ContainerSpecInput`** (write, all members optional — the node fills the rest from the profile catalog):

| field | type | notes |
|---|---|---|
| `profile` | `ContainerProfile` | input: top-level on `containers.create`, not part of the spec object |
| `image` | `string` | optional |
| `cpus` | `number` (0.25–16) | |
| `memMiB` | `integer` (128–65536) | |
| `diskMiB` | `integer` (512–512000) | optional |
| `mounts` | `ContainerMount[]` (read) / `ContainerMountInput[]` (write), max 16 | **read side carries no host path** (R5): `{guest, ro}` only. Write side is `{host, guest, ro}`; `guest` must start with `/`. A mount cannot round-trip — you send a host path and never read it back. |
| `env` | `Record<string,string>`, max 256 keys, each value ≤32768 chars | **secret-looking keys are refused** at the contract (400), by name — see below |
| `ports` | `number[]` (1–65535), max 32 | |
| `network` | `ContainerNetworkPolicy` = `{preset: ContainerNetworkPreset, allow: string[] (max 256)}` | |
| `surfaces` | `Partial<Record<ContainerSurfaceKind, {enabled: boolean, port?: number}>>` | |
| `labels` | `Record<string,string>`, values ≤1024 chars | read side always includes `tm8.container=<entityId>` and `tm8.space=<spaceId>` |

**Secret-looking env keys are refused, by name** (`schemas.ts:4712-4794`): any key matching `/(SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH)/i`, or `/(^|_)(PWD|SESSION_KEY|BEARER)(_|$)/i`, or an exact match on `ANTHROPIC_API_KEY|OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|TM8_AGENT_TOKEN` is rejected with `400 invalid_input` naming the key (never the value). Secrets reach a container through the credential path instead.

**`ContainerLifecycle`** (read, all required) / **`ContainerLifecycleInput`** (write, all optional):

| field | type | notes |
|---|---|---|
| `ephemeral` | `boolean` | |
| `ttlSeconds` | `integer\|null` (60–604800) | `null` = no TTL |
| `idleHibernateSeconds` | `integer\|null` (60–604800) | `null` = no idle hibernation |
| `graceSeconds` | `integer` (0–86400) | how long a stopped ephemeral machine survives before reclaim |
| `snapshotOnStop` | `boolean` | |

**`ContainerProviderDescriptor`** (`containers.providers.list` result item):

| field | type |
|---|---|
| `id` | `string` |
| `isolation` | `ContainerIsolationClass` |
| `profiles` | `ContainerProfile[]` |
| `surfaces` | `ContainerSurfaceKind[]` |
| `features` | `{pause, snapshot, fork, expose, nested, gpu}` (all `boolean`) |
| `limits` | `{maxContainers, maxCpus, maxMemMiB}` (numbers) |
| `probe` | `{ok: boolean, detail: string, measuredAt: string}` — produced by **actually creating and destroying** a tiny container, never a PATH check |

**Error taxonomy** (design, `packages/execution/src/containers/errors.ts` + `handlers/w2/containers.ts:132-165`) — mapped from a closed `ContainerErrorCode` union but currently **unreachable** because no `ContainerService` is ever composed:

| `ContainerErrorCode` | HTTP / `CommandErrorCode` |
|---|---|
| `invalid_spec` | 400 `invalid_input` |
| `not_found` | 404 `not_found` |
| `forbidden` | 403 `forbidden` |
| `policy` (isolation policy refusal) | 403 `forbidden` |
| `state` | 409 `invariant_violation` |
| `budget` | 429 `limit_exceeded` |
| `no_provider` | 501 `not_implemented` |
| `runtime`, `timeout` | 503 `upstream_unavailable` |

The error `detail` a `ContainerError` carries is a free-form `Record<string, unknown>`, **not** a fixed `{reason}` field — unlike the closed-taxonomy families elsewhere in the contract. The 501s every operation currently throws instead carry `details: { operation: '<op.name>' }` (`containers.ts:199-219`), with the human-readable reason embedded in the error **message**, not in a `details.reason` field. `unverified`: whether a future real handler will start populating `details.reason` — nothing in the current source does.

## Operations

### `containers.create`
`POST /v2/containers` · kind: command · status: v1 · served: registered (`handlers/w2/containers.ts:241`), always 501 today — `TM8_CONTAINERS=off` gives `"containers.create: containers are not enabled on this node (TM8_CONTAINERS=off)"`; with the gate on it fails one check later with `"containers.create: this node has no container runtime composed"` (no `ContainerService` is ever wired)
CLI: `tm8 container create <profile> [--title] [--project] [--image] [--provider] [--node] [--cpus] [--mem] [--disk] [--mount host:guest[:ro]]... [--env K=V]... [--port N]... [--network open|balanced|locked] [--allow host]... [--ephemeral|--persistent] [--ttl s] [--idle-hibernate s] [--grace s] [--snapshot-on-stop] [--share none|space|explicit] [--parent id] [--template id] [--confirm-untrusted] [--no-start] [--label k=v]...` (`packages/cli/src/commands/container.ts:598-681`)

The birth verb — creates a container row and (by default) starts its runtime in one saga; not reachable via `entities.create` (refused server-side, same as `work_session`).

**Path params** — none (spaceId travels in the body).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `spaceId` | `SpaceId` | yes | | owning space |
| `title` | string\|null | no | 1–512 | |
| `profile` | `ContainerProfile` | yes | | selects surface/image defaults |
| `provider` | string\|null | no | 1–64 | `null`/omitted = node picks best provider satisfying policy |
| `nodeId` | string\|null | no | 1–255 | `null`/omitted = the serving node |
| `image` | string\|null | no | 1–1024 | also settable inside `spec.image`; top-level wins for a `custom` profile |
| `spec` | `ContainerSpecInput` | no | | see shared types |
| `lifecycle` | `ContainerLifecycleInput` | no | | see shared types |
| `shareMode` | `ContainerShareMode` | no | | |
| `parentId` | `EntityId`\|null | no | | parent must be a RUNNING `dind`/microvm container, same space |
| `templateId` | `EntityId`\|null | no | | |
| `projectId` | `EntityId`\|null | no | | mounts the project's working dir at `/workspace` (rw) + a `mounts` edge |
| `confirmUntrusted` | `true` | no (required if `projectId` is untrusted) | literal `true` | same gate as `execution.spawn` |
| `start` | boolean | no | default `true` | `false` (`--no-start`) creates without starting |

Example request (illustrative, from schema):
```json
{
  "clientMutationId": "cm_01",
  "spaceId": "019f...",
  "profile": "shell",
  "spec": { "cpus": 1, "memMiB": 1024, "env": { "FOO": "bar" } },
  "start": true
}
```

**Response** — `CommandResult` with `entity` = the new container's `EntityDetail` (fields: id, version, `status`, `profile`, `provider`, `isolation`, `nodeId`, `surfaces`, ... — full shape belongs to the Entities reference / `entity-read.ts`).

**Errors** — `400 invalid_input` is **reachable today**: `ContainersCreateInputSchema` validates the body (including the secret-looking-env-key refusal) before the handler runs, so a malformed request never reaches the 501 stub. A schema-valid request always gets `501 not_implemented`, for the reason in the summary table. Designed-but-unreachable (require real execution, which never runs): `403 forbidden` (policy refusal — isolation class too weak), `429 limit_exceeded` (`TM8_CONTAINER_CAP` reached), `501 not_implemented` (`no_provider` — no provider satisfies profile+policy).
**Notes** — idempotent via `clientMutationId`; `TM8_CONTAINER_CAP` (default 4) is enforced inside the create door, not the service, so two processes on one node cannot both read a free slot.
Source: catalog `catalog.ts:539`; schema `schemas.ts:4891-4908`, type `contract.ts:3991-4013`; handler `handlers/w2/containers.ts:241`.

---

### `containers.start` / `containers.stop` / `containers.pause` / `containers.resume`
`POST /v2/containers/:containerId/commands/{start|stop|pause|resume}` · kind: command · status: v1 · served: registered, always 501 (same two-stage reason as `containers.create` — these 4 are also in `P0_IMPLEMENTED` and fail at "no container runtime composed" once the gate is on)
CLI: `tm8 container start|stop|pause|resume <id> --expect-version <n> [--timeout-ms ms]` (`container.ts:690-719`; one function, `lifecycleVerb`, parameterized by verb)

Lifecycle transitions on an existing container. One shared input shape.

**Path params**

| name | type | description |
|---|---|---|
| `containerId` | `EntityId` | |

**Request body** (`ContainersLifecycleInput`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | integer | yes | ≥0 | optimistic-concurrency guard |
| `timeoutMs` | integer | no | 1000–600000 | provider-side operation budget; **not** the CLI's global `--timeout` (that is a transport deadline in seconds, a different clock and unit) |

Example: `tm8 container stop c_01 --expect-version 3`

**Response** — `CommandResult` with `entity` = the updated container.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`. Designed-but-unreachable (require real execution): `409 version_conflict` (stale `expectedVersion`, carries `current: EntityDetail`), `409 invariant_violation` (illegal transition — legal edges live in `internal.container_transition_allowed`), `404 not_found`.
**Notes** — `destroy` is the separate operation below (adds `force`/`keepSnapshot`); these four never destroy state.
Source: catalog `catalog.ts:540-543`; schema `schemas.ts:4913-4918`, type `contract.ts:4016-4020`; handler `handlers/w2/containers.ts:242-245`.

---

### `containers.destroy`
`POST /v2/containers/:containerId/commands/destroy` · kind: command · status: v1 · served: registered, always 501 (P0-listed; same "no runtime composed" reason once gated on)
CLI: `tm8 container destroy <id> --expect-version <n> [--force] [--keep-snapshot] [--timeout-ms ms]` — deliberately **no** `--yes`; naming `--expect-version` is itself the confirming act (`container.ts:721-752`)

Tears the container down. `force` changes *how* it stops, not *whether* the caller may — no separate confirmation flag.

**Path params** — `containerId: EntityId`.

**Request body** (`ContainersDestroyInput` extends `ContainersLifecycleInput`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | integer | yes | ≥0 | |
| `timeoutMs` | integer | no | 1000–600000 | |
| `force` | boolean | no | | skip graceful shutdown |
| `keepSnapshot` | boolean | no | | preserve a snapshot instead of discarding runtime state |

**Response** — `CommandResult` with `entity` = the container in `destroying`/`destroyed` status. `canDelete` stays false on a container — it is destroyed, never graph-deleted.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`. Designed-but-unreachable: `409 version_conflict`, `404 not_found`.
Source: catalog `catalog.ts:544`; schema `schemas.ts:4920-4927`, type `contract.ts:4022-4025`; handler `handlers/w2/containers.ts:246`.

---

### `containers.update`
`PATCH /v2/containers/:containerId` · kind: command · status: v1 · served: registered, always 501 — not P0; reason: `"lands with the graph-only write path"`
CLI: `tm8 container update <id> --expect-version <n> [--title] [--ephemeral|--persistent|--ttl s|--idle-hibernate s|--grace s|--snapshot-on-stop] [--share none|space|explicit] [--label k=v]...` — refuses an update with no field beyond the guard (`container.ts:757-789`)

Mutates title, lifecycle, share mode and/or labels. Runtime state (start/stop/...) and network policy go through their own verbs.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `expectedVersion` | integer | yes | ≥0 |
| `title` | string | no | 1–512 |
| `lifecycle` | `ContainerLifecycleInput` | no | |
| `shareMode` | `ContainerShareMode` | no | |
| `labels` | `Record<string,string>` | no | values ≤1024 |

**Response** — `CommandResult` with `entity` = the updated container.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented` (`"containers.update: lands with the graph-only write path"`). Designed-but-unreachable: `409 version_conflict`.
Source: catalog `catalog.ts:545`; schema `schemas.ts:4929-4937`, type `contract.ts:4027-4034`; handler `handlers/w2/containers.ts:247`.

---

### `containers.policy.set`
`POST /v2/containers/:containerId/commands/policy` · kind: command · status: v1 · served: registered, always 501 — reason: `"network policy arrives with the egress proxy (phase 4)"`
CLI: `tm8 container policy <id> --expect-version <n> --network open|balanced|locked [--allow host]...` — `--network` is required (create has a profile default; this verb exists only to set it) (`container.ts:794-815`)

Sets the container's egress policy.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `expectedVersion` | integer | yes | ≥0 |
| `network` | `ContainerNetworkPolicy` = `{preset, allow}` | yes | `allow`: string[], max 256, each ≤253 chars |

**Response** — `CommandResult` with `entity` = the updated container.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`. Designed-but-unreachable: `409 version_conflict`.
Source: catalog `catalog.ts:546`; schema `schemas.ts:4939-4944`, type `contract.ts:4036-4040`; handler `handlers/w2/containers.ts:248`.

---

### `containers.run`
`POST /v2/containers/:containerId/commands/run` · kind: command · status: v1 · served: registered, always 501 — reason: `"one-shot exec arrives with the docker provider (phase 1)"`
CLI: `tm8 container run <id> [--cwd] [--env K=V]... [--timeout-ms ms] [--stdin src] [--user u] -- <argv...>` and `tm8 container adb <id> [--timeout-ms ms] -- <adb args...>` (sugar: prefixes `argv` with `adb`, no separate operation) (`container.ts:825-897`)

One-shot command execution inside the container, synchronous, with captured stdout/stderr.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `argv` | string[] | yes | 1–256 entries, each unbounded length | |
| `cwd` | string | no | 1–4096 | |
| `env` | `Record<string,string>` | no | secret-key refusal applies | |
| `stdin` | string | no | ≤1048576 chars | |
| `timeoutMs` | integer | no | 1000–600000 | |
| `user` | string | no | 1–255 | |

**Response** (`ContainersRunResult`)

| field | type | description |
|---|---|---|
| `exitCode` | `number\|null` | `null` = process was killed |
| `stdout` | string | |
| `stderr` | string | |
| `truncated` | boolean | full stream available via `containers.logs` |
| `durationMs` | number | |
| `timedOut` | boolean | |

Example response (illustrative, from schema):
```json
{ "data": { "exitCode": 0, "stdout": "hi\n", "stderr": "", "truncated": false, "durationMs": 42, "timedOut": false }, "requestId": "req_..." }
```

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:547`; schema `schemas.ts:4946-4955, 5059-5066`, type `contract.ts:4042-4059`; handler `handlers/w2/containers.ts:249`.

---

### `containers.terminal.start`
`POST /v2/containers/:containerId/terminals` · kind: command · status: v1 · served: registered, always 501 — reason: `"exec terminals arrive with the docker provider (phase 1)"`
CLI: `tm8 container terminal <id> [--title] [--cwd] [--cols n] [--rows n]` (`container.ts:908-929`)

Opens an interactive PTY as a real `work_session`, running the image's own login shell. Deliberately no `argv` parameter — same RCE boundary as `execution.terminal.start`.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `title` | string | no | 1–512 |
| `cwd` | string | no | 1–4096 |
| `cols` | integer | no | 1–1000 |
| `rows` | integer | no | 1–1000 |

**Response** (`ContainersTerminalStartResult`): `{ workSessionId: EntityId, containerId: EntityId }`. Attach to the PTY with the work-session's own attach path (`tm8 session attach <workSessionId>`), over the shared `containers.stream` socket.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:548`; schema `schemas.ts:4957-4964, 5068-5071`, type `contract.ts:4067-4078`; handler `handlers/w2/containers.ts:250`.

---

### `containers.attach`
`POST /v2/containers/:containerId/attach` · kind: command · status: v1 · served: registered, always 501 — reason: `"surface attach arrives with the stream bridge (phase 2)"`
CLI: `tm8 container attach <id> --surface screen|browser|adb|docker [--mode view|drive]` (default mode `view`); prints the grant only, opens nothing (`container.ts:939-963`)

Mints a `SurfaceAttachGrant` for a non-terminal surface (screen/browser/adb/docker streams). `terminal` is reached via `containers.terminal.start` instead, so it is excluded from this operation's `surface` union.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `surface` | `'screen'\|'browser'\|'adb'\|'docker'` | yes | |
| `mode` | `'view'\|'drive'` | yes | |

**Response** (`SurfaceAttachGrant`)

| field | type | description |
|---|---|---|
| `containerId` | `EntityId` | |
| `surface` | `ContainerSurfaceKind` | |
| `encoding` | `'rfb'\|'frames'\|'cdp'\|'adb'\|'docker'` | |
| `url` | string | |
| `protocol` | `'ws'` | |
| `mode` | `'view'\|'drive'` | |
| `token` | string | travels **only** in the `tm8-grant.<token>` WS subprotocol, never the URL |
| `expiresAt` | string | |
| `geometry` | `{w, h, dpr}` | optional |

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
**Notes** — a URL-embedded token is refused by the transport rather than degrading — the one documented exception is `containers.browser.endpoint` below.
Source: catalog `catalog.ts:549`; schema `schemas.ts:4966-4971, 5073-5083`, type `contract.ts:4080-4102`; handler `handlers/w2/containers.ts:251`.

---

### `containers.stream`
`WS /v2/ws` (alias of `events.subscribe`) · kind: stream · status: v1 · served: yes, as `events.subscribe` — the socket itself is live (`packages/server/src/events/ws-server.ts`); `unverified`: container-specific grant dispatch on that socket — no `container` reference found in `ws-server.ts`
CLI: none (dialed directly by a client using a grant/token from `containers.attach`, `containers.terminal.start`, etc.)

Not a second endpoint: this row exists so the family is discoverable in the catalog. The PTY, screen frames, browser CDP and every other container surface share the one `/v2/ws` socket and it dispatches per-connection on the grant token supplied.

**Path params** — none (WS upgrade, not routed through the HTTP router — `router.ts` explicitly excludes `WS` operations).
**Request / Response** — not JSON envelope; frame protocol is per-surface (`encoding` on the `SurfaceAttachGrant`).
**Errors** — n/a at the HTTP layer.
**Notes** — this is the only alias row in the catalog (`aliasOf: 'events.subscribe'`); the conformance/router generator explicitly skips alias rows when mounting routes.
Source: catalog `catalog.ts:553`; router comment `packages/server/src/http/router.ts:22-29`.

---

### `containers.computer`
`POST /v2/containers/:containerId/commands/computer` · kind: command · status: v1 · served: registered, always 501 — reason: `"computer actions arrive with the desktop profile (phase 2)"`
CLI: `tm8 container computer <id> <action> [--x] [--y] [--to X,Y] [--text] [--keys] [--dx] [--dy] [--ms] [--url] [--no-screenshot] [--keep] [--out file] [--scale 0.25-1]`; sugar forms `tm8 container screenshot <id>` (action=`screenshot`) and `tm8 container browser <id> goto <url>` / `browser <id> text` (`container.ts:1035-1153`)

Computer-use style actions (screenshot/click/type/scroll/goto/...) — vocabulary is deliberately the intersection of Anthropic's computer-use tool, Playwright and adb.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `action` | `'screenshot'\|'click'\|'double_click'\|'right_click'\|'move'\|'drag'\|'type'\|'key'\|'scroll'\|'wait'\|'goto'\|'text'` | yes | |
| `x`, `y` | number | no | |
| `to` | `{x: number, y: number}` | no | |
| `text` | string | no | ≤65536 |
| `keys` | string | no | ≤256 |
| `dx`, `dy` | number | no | |
| `ms` | integer | no | 0–60000 |
| `url` | string | no | 1–4096 |
| `screenshot` | boolean | no | default `true` — return a screenshot after the action |
| `keep` | boolean | no | store the screenshot as an artifact revision |
| `scale` | number | no | 0.25–1 |

**Response** (`ContainersComputerResult`)

| field | type | description |
|---|---|---|
| `ok` | boolean | |
| `screenshot` | `{mime: 'image/png'\|'image/jpeg', base64: string, w, h, scale}` | optional |
| `text` | string | optional |
| `artifactRevision` | `{artifactId: EntityId, revisionNumber: number}` | optional, when `keep: true` |

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:554`; schema `schemas.ts:4973-4990`, type `contract.ts:4109-4135`; handler `handlers/w2/containers.ts:252`.

---

### `containers.browser.endpoint`
`POST /v2/containers/:containerId/commands/browser-endpoint` · kind: command · status: v1 · served: registered, always 501 — reason: `"the CDP endpoint arrives with the browser profile (phase 2)"`
CLI: `tm8 container browser <id> endpoint [--ttl seconds]` (`container.ts:1103-1130`)

Mints a Chrome DevTools Protocol WebSocket endpoint for Playwright's `connectOverCDP`.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `ttlSeconds` | integer | no | 1–3600 |

**Response** (`ContainersBrowserEndpointResult`): `{ wsEndpoint: string, expiresAt: string, cdpVersion: string }`.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
**Notes** — `wsEndpoint` is a **bearer-bound URL** (`/v2/containers/:id/cdp/<grantId>`), the one documented exception to subprotocol-only grant carriage, because `connectOverCDP` cannot send a WS subprotocol; multi-use, ≤1h, bound to actor+container, revoked on stop, never logged.
Source: catalog `catalog.ts:555`; schema `schemas.ts:4992-4996`, type `contract.ts:4137-4152`; handler `handlers/w2/containers.ts:253`.

---

### `containers.files.put`
`PUT /v2/containers/:containerId/files` · kind: command · status: v1 · served: registered, always 501 — reason: `"file transfer arrives in phase 5"`
CLI: `tm8 container cp <id> <local-path> ctr:<remote-path>` — the CLI validates the `ctr:` direction locally then refuses to send anything (exits with the CLI's "catalogued, not built here" code) rather than emit a JSON body the tar-stream endpoint cannot read (`container.ts:1187-1226`)

Copies a tar archive **into** the container. **No Zod body schema** — deliberately: the request body is a tar octet-stream, not JSON, and a strict object schema would reject every legitimate upload. Listed in `UNBOUND_COMMAND_OPERATIONS` for exactly this reason (`input-schemas.ts:448-453`).

**Path params** — `containerId: EntityId`.
**Query params** — `unverified`: destination path is presumably a query or header parameter (e.g. destination directory) since it cannot travel in a strict JSON body and the tar stream is the body; no query-parsing code exists yet to confirm the parameter name.
**Request body** — raw `application/x-tar` (or similar) octet stream. No `clientMutationId` field in the body (a command DTO normally requires one, but this op is exempted — see `input-schemas.ts:448-453`); `unverified` how a mutation id is carried for idempotency (header?) if at all.

**Response** — `unverified`: no result type defined in `contract.ts`/`schemas.ts`.
**Errors** — `501 not_implemented` (always, today).
Source: catalog `catalog.ts:556`; unbound-list note `packages/server/src/facade/input-schemas.ts:448-453`; handler `handlers/w2/containers.ts:254`.

---

### `containers.files.get`
`GET /v2/containers/:containerId/files` · kind: read · status: v1 · served: registered, always 501 — reason: `"file transfer arrives in phase 5"`
CLI: `tm8 container cp <id> ctr:<remote-path> <local-path>` (refuses `--mutation-id`, since it's a read; same "not sent" refusal as `files.put` today) (`container.ts:1156-1226`)

Copies a path out of the container as a tar archive.

**Path params** — `containerId: EntityId`.
**Query params** — `unverified`: presumably a `path` query parameter naming what to tar up; no query-parsing code exists yet to confirm.
**Response** — raw tar octet-stream (`unverified` exact content-type); no `data`/`requestId` JSON envelope expected for a byte-stream read.
**Errors** — `501 not_implemented` (always, today).
Source: catalog `catalog.ts:557`; CLI comment `packages/cli/src/commands/container.ts:1156-1177`; handler `handlers/w2/containers.ts:255`.

---

### `containers.logs`
`GET /v2/containers/:containerId/logs` · kind: read · status: v1 · served: registered, always 501 — reason: `"node-side logs arrive with the docker provider (phase 1)"`
CLI: `tm8 container logs <id> [--since ts] [--tail 1-10000] [--follow]` (refuses `--mutation-id`) (`container.ts:1229-1246`)

Buffered stdout/stderr from the container's runtime — node-local truth, hence a family-specific read rather than a graph field.

**Path params** — `containerId: EntityId`.
**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `since` | string | no | — | timestamp lower bound (exact format `unverified` — CLI passes the raw `--since` value through) |
| `tail` | string (stringified int) | no | 1–10000 (CLI-enforced) | number of trailing lines |
| `follow` | `'true'` | no | — | present only when `--follow` is set; streaming behavior over plain HTTP GET is `unverified` |

**Response** (`ContainersLogsResult`)

| field | type | description |
|---|---|---|
| `containerId` | `EntityId` | |
| `lines` | `Array<{ts: string, stream: 'stdout'\|'stderr', text: string}>` | |
| `truncated` | boolean | |

**Errors** — `501 not_implemented` (always, today).
Source: catalog `catalog.ts:558`; schema `schemas.ts:5085-5093`, type `contract.ts:4208-4212`; CLI query building `container.ts:1229-1246`; handler `handlers/w2/containers.ts:256`.

---

### `containers.expose`
`POST /v2/containers/:containerId/commands/expose` · kind: command · status: v1 · served: registered, always 501 — reason: `"port exposure arrives in phase 3"`
CLI: `tm8 container expose <id> <port> --expect-version <n> [--share none|space|link]` (`container.ts:1249-1280`)

Exposes a container port for reverse-proxy access via `containers.proxy`.

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `expectedVersion` | integer | yes | ≥0 |
| `port` | integer | yes | 1–65535 |
| `share` | `ContainerPortShare` | no | `none\|space\|link` |

**Response** (`ContainersExposeResult`): `{ port: number, url: string, shareToken?: string }` — `url` is derived as `/v2/containers/<id>/ports/<port>/` (the `containers.proxy` binding), not stored.

**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
**Notes** — `shareToken` (when `share: 'link'`) is present in the JSON DTO but the CLI's human rendering deliberately does not print it, to avoid leaking a bearer token into terminal scrollback.
Source: catalog `catalog.ts:559`; schema `schemas.ts:4998-5004`, type `contract.ts:4154-4165`; handler `handlers/w2/containers.ts:257`.

---

### `containers.unexpose`
`POST /v2/containers/:containerId/commands/unexpose` · kind: command · status: v1 · served: registered, always 501 — reason: `"port exposure arrives in phase 3"`
CLI: `tm8 container unexpose <id> <port> --expect-version <n>` (`container.ts:1283-1301`)

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `expectedVersion` | integer | yes | ≥0 |
| `port` | integer | yes | 1–65535 |

**Response** — `CommandResult` with `entity` = the updated container.
**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:560`; schema `schemas.ts:5006-5011`, type `contract.ts:4167-4171`; handler `handlers/w2/containers.ts:258`.

---

### `containers.proxy`
`GET /v2/containers/:containerId/ports/:port/*` · kind: read · status: v1 · served: registered, always 501 — reason: `"the exposed-port proxy arrives in phase 3"`
CLI: none (dialed directly as a URL — e.g. from a browser — not invoked as a JSON RPC)

Reverse-proxies an HTTP request into an exposed container port. The trailing `*` binds the remainder of the path **including slashes** to a `rest` param (`WILDCARD_PARAM`), because a reverse proxy needs the full sub-path (`assets/app.js`); this is the only wildcard route in the catalog, and the router requires `(.*)` (not `(.+)`) so `/ports/8080/` with an empty remainder still matches as the proxy's index request.

**Path params**

| name | type | description |
|---|---|---|
| `containerId` | `EntityId` | |
| `port` | integer | the exposed port |
| `rest` (wildcard `*`) | string | remainder of the path, forwarded to the container |

**Response** — whatever the proxied HTTP server returns; not a `{data, requestId}` envelope.
**Errors** — `501 not_implemented` (always, today).
Source: catalog `catalog.ts:561`; router wildcard handling `packages/server/src/http/router.ts:56-64, 84-100`; handler `handlers/w2/containers.ts:259`.

---

### `containers.snapshot`
`POST /v2/containers/:containerId/commands/snapshot` · kind: command · status: v1 · served: registered, always 501 — reason: `"snapshots arrive in phase 3"`
CLI: `tm8 container snapshot <id> --expect-version <n> [--name] [--make-template]` (`container.ts:1304-1326`)

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `expectedVersion` | integer | yes | ≥0 |
| `name` | string | no | 1–255 |
| `makeTemplate` | boolean | no | |

**Response** — `CommandResult` with `entity` = the container (snapshot metadata presumably attached; exact shape `unverified` — no dedicated result type in the contract).
**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:562`; schema `schemas.ts:5013-5019`, type `contract.ts:4173-4178`; handler `handlers/w2/containers.ts:260`.

---

### `containers.fork`
`POST /v2/containers/:containerId/commands/fork` · kind: command · status: v1 · served: registered, always 501 — reason: `"forking arrives in phase 3"`
CLI: `tm8 container fork <id> [--title] [lifecycle flags] [--cpus] [--mem] [--disk]` — no version guard (forking reads the source, does not change it) (`container.ts:1330-1358`)

Creates a new container from this one's snapshot.

**Path params** — `containerId: EntityId` (the source/template).

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `title` | string | no | 1–512 |
| `lifecycle` | `ContainerLifecycleInput` | no | |
| `spec` | `ContainerSpecInput` | no | |

**Response** — `CommandResult` with `entity` = the new (forked) container.
**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:563`; schema `schemas.ts:5021-5027`, type `contract.ts:4180-4185`; handler `handlers/w2/containers.ts:261`.

---

### `containers.attention`
`POST /v2/containers/:containerId/commands/attention` · kind: command · status: v1 · served: registered, always 501 — reason: `"takeover requests arrive with the screen surface (phase 2)"`
CLI: `tm8 container attention <id> --reason login|captcha|2fa|payment|approval|other [--detail text] [--points n]` (same bounded-points shape as `attentionRequests.create`) (`container.ts:1362-1387`)

Asks a human to take over the container (login walls, CAPTCHAs, payment, etc).

**Path params** — `containerId: EntityId`.

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `reason` | `'login'\|'captcha'\|'2fa'\|'payment'\|'approval'\|'other'` | yes | |
| `detail` | string | no | ≤4096 |
| `points` | integer | no | 1–100 |

**Response** — `CommandResult` with `entity` = the container.
**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:564`; schema `schemas.ts:5029-5035`, type `contract.ts:4187-4192`; handler `handlers/w2/containers.ts:262`.

---

### `containers.providers.list`
`GET /v2/containers/providers` · kind: read · status: v1 · served: registered, always 501 — P0-listed; today's reason is `"containers.providers.list: containers are not enabled on this node (TM8_CONTAINERS=off)"` (default gate), or `"this node has no container runtime composed"` once the gate is on
CLI: `tm8 container providers [--node id]` (refuses `--mutation-id`) (`container.ts:1420-1432`)

Lists what this node can actually run: providers, cached images, and live capacity — the two family-specific reads because the truth is on the node, not the graph.

**Path params** — none.
**Query params**

| name | type | required | default | description |
|---|---|---|---|---|
| `node` | string | no | this node | scope the query to a different node |

**Response** (`ContainersProvidersListResult`)

| field | type | description |
|---|---|---|
| `nodeId` | string | |
| `providers` | `ContainerProviderDescriptor[]` | see shared types |
| `images` | `Array<{profile: ContainerProfile, ref: string, digest: string\|null, cached: boolean}>` | |
| `caps` | `{containers: number, live: number}` | |

Example response (captured, real 501 — no successful response exists on this node):
```
$ tm8 container providers --format json
tm8: not_implemented: containers.providers.list: containers are not enabled on this node (TM8_CONTAINERS=off) · requestId: req_6881d2_29zd
```

**Errors** — `501 not_implemented` (always, today, for either of the two reasons above).
Source: catalog `catalog.ts:565`; schema `schemas.ts:5044-5057`, type `contract.ts:4201-4206`; handler `handlers/w2/containers.ts:263`.

---

### `containers.pools.set`
`POST /v2/containers/:containerId/commands/pool` · kind: command · status: v1 · served: registered, always 501 — reason: `"warm pools arrive in phase 3"`
CLI: `tm8 container pool <template-id> --expect-version <n> --warm 0-8` (`container.ts:1392-1410`)

Sets how many warm child machines to keep ready from a **template** container.

**Path params** — `containerId: EntityId` (the template).

**Request body**

| field | type | required | constraints |
|---|---|---|---|
| `clientMutationId` | string | yes | min 1 |
| `expectedVersion` | integer | yes | ≥0 |
| `warm` | integer | yes | 0–8 |

**Response** — `CommandResult` with `entity` = the template container.
**Errors** — `400 invalid_input` is reachable today (schema validates the body first). A schema-valid request always gets `501 not_implemented`.
Source: catalog `catalog.ts:566`; schema `schemas.ts:5037-5042`, type `contract.ts:4194-4199`; handler `handlers/w2/containers.ts:264`.
