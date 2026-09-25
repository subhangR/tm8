# Events, commands, actions, search

This group covers the operations that sit outside any one entity family: the durable and
live event feed (`events.*`), the generic undo path for a mutation's inverse
(`commands.undo`), palette capability discovery (`actions.list`), and the reserved
full-text search slot (`search.query`). All six are catalog rows in
`packages/contract/src/catalog.ts`, projected onto HTTP by the catalog-driven router
(`packages/server/src/http/router.ts`) and onto one multiplexed WebSocket
(`events.subscribe`, `WS /v2/ws`) for the stream case. Every HTTP response — success or
error — rides the same envelope: `{ data, requestId }` on success (DEV-6,
`packages/server/src/http/types.ts:94`), `{ error: { code, message, details?, requestId,
retryable } }` on failure (`packages/contract/src/contract.ts:1643-1668`).

## Summary

| name | method | path | kind | served |
|---|---|---|---|---|
| `commands.undo` | POST | `/v2/undo` | command | yes |
| `search.query` | GET | `/v2/search` | read | no — reserved, 501 forever |
| `actions.list` | GET | `/v2/actions` | read | yes |
| `events.subscribe` | WS | `/v2/ws` | stream | yes |
| `events.poll` | GET | `/v2/spaces/:spaceId/events` | read | yes |
| `events.changes` | GET | `/v2/spaces/:spaceId/events/changes` | read | yes |

(`containers.stream` is a discoverability alias of `events.subscribe` — same `WS /v2/ws`
binding, no second socket. `packages/contract/src/catalog.ts:553`.)

## Shared types

**`CommandResult`** (`packages/contract/src/contract.ts:1687-1695`) — every command's
response shape, including `commands.undo`'s:

| field | type | description |
|---|---|---|
| `entity` | `EntityDetail` (optional) | the touched entity's current state |
| `edge` | `EdgeView` (optional) | the touched edge, if any |
| `activity` | `ActivityItem` (optional) | activity row the mutation produced |
| `patches` | `EntitySummary[]` | other entities the mutation side-affected |
| `undo` | `UndoToken` (optional) | present only when this mutation itself issued a new undo token |
| `warnings` | `ResultWarning[]` (optional) | present only when the server has something to say |

**`UndoToken`** (`contract.ts:1679`): `{ token: string; label: string; expiresAt?: string }`.
**`ResultWarning`** (`contract.ts:1685`): `{ code: string; message: string }`.

**`WorkspaceEventEnvelope`** (`contract.ts:1346-1352`) — every event on the durable stream
and the poll fallback carries this:

| field | type | description |
|---|---|---|
| `spaceId` | `SpaceId` | — |
| `seq` | `number` | per-space monotonic; gaps allowed, order is authoritative; the `events.poll`/`events.changes` cursor |
| `occurredAt` | `string` | ISO timestamp |
| `schemaVersion` | `number` | bumped when the envelope or a payload shape changes incompatibly (`WORKSPACE_EVENT_SCHEMA_VERSION`) |

**`WorkspaceEvent`** (`contract.ts:1361-1438`) — the envelope plus a big discriminated union
on `type`; every event carries its full typed payload (no bare-id variants that force a
refetch). Discriminants include `entity.upsert`/`entity.deleted`, `entity.activity_touched`,
`edge.upsert`/`edge.deleted`, `message.created`/`updated`/`deleted`, `counter.changed`,
`activity.created`, `notification.created`/`read`, `menu.updated`,
`space.default_channel.updated`, `git.commit_recorded`, `git.pr_state_changed`,
`git.worktree_status_changed`, `project.association.corrected`, `handoff.*`,
`message.delivery_reserved`/`settled`, `message.attachments.updated`,
`interaction_profile.*`, `work_session.profile_pinned`/`repinned`, `presence.changed`,
`typing.changed`, `voice.participants.changed`. Most carry `clientMutationId?: string`
echoing the originating command for optimistic reconciliation.
**`DurableWorkspaceEvent`** (`contract.ts:1443`) = `WorkspaceEvent` minus the three
ephemeral, non-ledgered variants (`presence.changed`, `typing.changed`,
`voice.participants.changed`) — what `events.poll`, `events.changes` and the durable half
of `events.subscribe` ever emit.

**`PaletteAction`** (`contract.ts:3636-3648`) and **`ActionDiscoveryResult`**
(`contract.ts:3649-3655`) / **`ActionRows`** / **`ActionDiscoveryPage`**
(`contract.ts:3671-3698`) — see `actions.list` below.

Source for the catalog rows themselves: `packages/contract/src/catalog.ts:173,176,242,245,246,249`.

---

### `commands.undo`
`POST /v2/undo` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/graph-undo.ts:234`)
CLI: `tm8 undo apply <undo-token> [--mutation-id <id>]`

Redeems an undo token a previous mutation issued, running that mutation's registered
inverse. Only four operations register an inverse: `edges.delete` → re-create the edge,
`entities.move` → move back, `entities.restore` → the tombstone's own inverse, and
`messages.delete` → **redact** the message body (`[redacted]`, mentions/attachments
cleared) rather than delete the row — the row stays in its thread. Not every mutation
issues a token, a token expires, and it is spendable exactly once.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `token` | string | yes | length 8–200 | the opaque token from the original mutation's `CommandResult.undo.token` |
| `actorId` | EntityId (uuid) | no | must be the original actor, or the caller's own if acting-as | who is undoing |
| `clientMutationId` | string | no | non-empty | idempotency key for this undo itself |

Schema: `UndoCommandInputSchema`, `packages/server/src/facade/input-schemas.ts:177-181`
(registered at `input-schemas.ts:303`); re-validated by hand in the handler
(`graph-undo.ts:211-232`) since the RPC path also accepts raw `ctx.body`.

Example request:
```
POST /v2/undo
{"token": "und_8f2a...", "clientMutationId": "cmid_01"}
```

**Response** — 200; `data` is a `CommandResult` (see Shared types). A successful
`edges.delete` undo returns `patches` naming the endpoints; a `messages.delete` undo
returns `entity` as the now-redacted message.

```json
{"data": {"patches": [{"id": "<redacted>", "kind": "message", "version": 4}]}, "requestId": "req_00001a"}
```

**Errors**

- `not_found` (404) — token does not exist. Postgres `P0002` from `undo_command`
  (`db/migrations/020_w2_collections_graph_undo.sql:61-63`), mapped at
  `packages/server/src/http/errors.ts:40`.
- `forbidden` (403) — the caller is not the original actor and cannot act as them.
  Postgres `42501` (`020_w2_collections_graph_undo.sql:69,73`), mapped at `errors.ts:39`.
- `invariant_violation` (409) — `details.reason`-free message body from Postgres `23514`:
  "undo token already redeemed", "undo token expired", or (on an idempotent replay with a
  mismatched mutation id) "client mutation id does not redeem this token"
  (`020_w2_collections_graph_undo.sql:81,87,90`; mapped at `errors.ts:49`).
- `invalid_input` (400) — malformed body (`token` not 8–200 chars, `actorId` not a uuid,
  empty `clientMutationId`) — `graph-undo.ts:212-224`.
- `not_implemented` (501) — defensive only: an `undo_tokens.operation` with no registered
  inverse, unreachable given the table's own check constraint (`0A000`,
  `020_w2_collections_graph_undo.sql:131`).

**Notes** — Idempotent via `clientMutationId`: a replayed mutation id reuses
`internal.ledger_replay`/`ledger_record` inside the same RPC (`020_w2_collections_graph_undo.sql:52,79-84,138-142`)
and returns the same `CommandResult` rather than re-running the inverse. No
`expectedVersion` — the inverse re-applies unconditionally rather than re-checking the
caller's optimistic-concurrency version. No pagination. Emits whatever durable event the
underlying inverse RPC emits (e.g. `edge.upsert`, `entity.upsert`).

---

### `search.query`
`GET /v2/search` · kind: read · status: reserved · served: no (answers 501 not_implemented)
CLI: `tm8 search query "<text>"` — refuses **locally**, without a network round trip

Deliberately unbuilt in v1 (DEV-13): the catalog carries the row for discoverability but
`HandlerRegistry.register` throws if any handler ever tries to bind it
(`packages/server/src/facade/registry.ts:33-36,41-45`), so the deployment must answer an
honest `501 not_implemented`, never a 404 or a fake 200.

No request or response shape is defined anywhere in `@tm8/contract` — `unverified:
searched packages/contract/src/contract.ts and schemas.ts for a "Search"-named schema/DTO;
none exists`. The CLI command (`packages/cli/src/commands/search.ts:26-52`) does not even
attempt the request: it looks up the catalog's own `reserved` status via `discoveryFor`
and throws `not_implemented` client-side, pointing the caller at
`tm8 entity query --kind <kind>`, `tm8 graph query --focus <entity-id>`, or
`tm8 message list <anchor-id>` as structural substitutes.

**Errors**

- `not_implemented` (501) — always, for every request, on every node
  (`packages/server/src/http/errors.ts:187`; reserved-op registration guard at
  `registry.ts:33-36`).

**Notes** — No idempotency, no pagination, no auth requirement defined (none of these
apply to an operation with no implementation). Un-reserving this row would require a
contract amendment (`registry.ts:34-36`).

---

### `actions.list`
`GET /v2/actions` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/saved-views-actions.ts:779`, registered at `packages/server/src/facade/handlers/w2/saved-views-actions.ts:32`)
CLI: `tm8 action list [--for <entity-id>] [--all] [--schema v2] [--limit <n>] [--cursor <c>]`

Capability discovery for the command palette (G09): every operation the caller is
currently authorized to invoke, either globally or ranked against one target entity's own
operations first. This is strictly an authorization/availability listing — it never marks
individual rows `allowed`/`reasonCode` (the frozen contract has no such fields; a CLI- or
doc-invented one would be this layer making an authorization claim it doesn't own).

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `contextEntityId` | uuid | no | — | scope the list to one entity's operations, most relevant first |
| `scope` | `contextual`\|`all` | no | default `contextual` | with a context entity, `all` appends space-level and global ops after the entity's own |
| `schema` | `v1`\|`v2` | no | default `v1` | `v2` returns the paged, factored `ActionRows` shape; `limit`/`cursor` require `schema=v2` |
| `limit` | integer | no (v2 only) | default 20, max 100 | v2 page size |
| `cursor` | opaque string | no (v2 only) | keyset, bound to `capabilityEpoch` | continue a v2 page |

Source: `packages/server/src/facade/services/w2/saved-views-actions.ts:557-563` (`scope`),
`:731-736` (`schema`), `:737-747` (`limit`), `:764-778` (`actionPage`/`cursor`).

Example request: `GET /v2/actions?contextEntityId=<id>&scope=all&schema=v2&limit=20`

**Response** — 200.

v1 (default), `data` is `ActionDiscoveryResult` (`contract.ts:3649-3655`):

| field | type | description |
|---|---|---|
| `actorId` | EntityId | whose palette this is |
| `targetEntityId` | EntityId (optional) | echoes `contextEntityId` |
| `targetVersion` | number (optional) | the target's version at read time |
| `capabilityEpoch` | string | hash of the actor's complete authorized inventory at this instant; short-lived |
| `actions` | `PaletteAction[]` | see below |

`PaletteAction` (`contract.ts:3636-3648`): `id`, `label`, `kind`
(`navigate`\|`create`\|`link`\|`pull`\|`status`\|...), `operation` (an `OperationName`),
`targetEntityId?`, `targetVersion?`, `capabilityEpoch`, `authzTarget`
(`server`\|`space`\|`project`\|`entity`\|`session`), `exposure`
(`public`\|`composite`\|`internal`\|`reserved`), `helpRef`.

v2 (`schema=v2`), `data` is `ActionDiscoveryPage` (`contract.ts:3680-3698`) — the same
answer factored: `schema: 'tm8.actions.v2'`, `actorId`, `target?: {id,kind,version}`,
`capabilityEpoch`, `columns: ['operation','kind','authzTarget','exposure']`, `rows` (one
4-tuple per action instead of a repeated object), `total`, `nextCursor` (null when
exhausted).

```json
{"data": {"actorId": "<redacted>", "capabilityEpoch": "cap:9f2e...",
  "actions": [{"id": "a1", "label": "Move", "kind": "status",
    "operation": "entities.move", "authzTarget": "entity", "exposure": "public",
    "helpRef": "entities.move"}]}, "requestId": "req_00002b"}
```
(illustrative, from schema)

**Errors**

- `invalid_input` (400) — `scope` not `contextual`/`all`; `schema` not `v1`/`v2`;
  `limit`/`cursor` given with `schema=v1`; `limit` out of `1..100`
  (`saved-views-actions.ts:559-563,731-736,793-795,737-747`).
- `not_found` (404) — `contextEntityId` names an entity the caller cannot read or that is
  deleted (`saved-views-actions.ts:643-645`, "no readable entity").
- `invalid_cursor` (400) — cursor's embedded fingerprint (context entity, scope,
  `capabilityEpoch`) no longer matches — the underlying capability state moved
  (`saved-views-actions.ts:754-762`).

**Notes** — `capabilityEpoch` digests the caller's *complete* authorized inventory in
registry order, independent of `scope`/`schema` filtering, so two views of the same state
always carry the same epoch (`saved-views-actions.ts:695-699`). No mutation id (it's a
read). Pagination is v2-only, keyset, bound to the epoch. No events emitted.

---

### `events.subscribe`
`WS /v2/ws` · kind: stream · status: v1 · served: yes (`packages/server/src/events/ws-server.ts:117`, path from catalog at `ws-server.ts:39`)
CLI: `tm8 event watch [--entity <id>...] [--type <t>...] [--presence] [--until-match --timeout <seconds>]` (space taken from the CLI's current context)

The one multiplexed WebSocket for the whole workspace event stream — no per-space or
per-entity socket (T-L10). The client performs the RFC 6455 upgrade at `/v2/ws`
(`ws-server.ts:113-180`), then drives a small client→server control protocol over the same
socket to say which Spaces it wants and whether it wants presence/typing.

**Path params** — none (the path is fixed; scope is asserted after the handshake via
control frames).

**Request body** — none at the HTTP layer. After upgrade, the client sends
`WorkspaceControlFrame` JSON text frames (`contract.ts:1502-1535`):

| frame `type` | fields | description |
|---|---|---|
| `subscribe` | `spaceIds: SpaceId[]` | add Spaces to this connection's durable fan-out (≤ `MAX_CONTROL_FRAME_SPACES` = 100, `contract.ts:1485`) |
| `unsubscribe` | `spaceIds: SpaceId[]` | remove them |
| `presence` | `on: boolean` | toggle the ephemeral presence/typing channel for already-subscribed Spaces |
| `resume` | `spaceId: SpaceId; since: number` | replay stored events for one Space after seq `since` |
| `presence.set` | `spaceId, entityId, viewing: boolean, typing: boolean` | announce this caller's own ephemeral presence at an entity |

Every named Space is authorized against the same membership predicate as `spaces.get`; an
unreadable Space is never added to the fan-out set.

**Response** — server→client frames are `WorkspaceEvent` JSON (durable variants from
`subscribe`/`resume`; ephemeral `presence.changed`/`typing.changed`/
`voice.participants.changed` only after `presence: {on:true}`), or one `WorkspaceControlAck`
(`contract.ts:1550-1560`) `{ type: 'control.refused', frame, spaceId?, reason: 'forbidden'|'malformed' }`
for a refused frame — the only server→client message that is not a `WorkspaceEvent`, so a
client can tell "not allowed" from "this Space is simply quiet".

**Errors** — pre-upgrade refusals are plain HTTP, not the JSON envelope (there is no
socket yet to carry it): `400` bad path/missing headers/unsupported WS version
(`ws-server.ts:125-141`), `401` if `authorize` throws (`ws-server.ts:159-163`), `429`/`503`
from the admission controller (`ws-server.ts:145-152,166-174`). After upgrade, a refused
control frame is a `control.refused` ack, not a socket close.

**Notes** — No idempotency/mutation id (not a command). No REST-style pagination;
`resume` replays from a `seq` cursor. Presence/typing never ride the durable stream or
`events.poll`/`events.changes` (DEV-4; ephemeral, `contract.ts:1439-1442`). `heartbeatMs`
and `missedPongLimit` govern liveness (`ws-server.ts:53-54`). `containers.stream` shares
this exact socket as a discoverability alias.

---

### `events.poll`
`GET /v2/spaces/:spaceId/events` · kind: read · status: v1 · served: yes (`packages/server/src/events/handlers.ts:110`)
CLI: `tm8 event list [--after <seq>] [--limit <n>] [--entity <id>]`

The catch-up fallback for a client that lost the socket: "every durable event after seq
N", full bodies included, backed by `public.workspace_events`
(`packages/server/src/events/poll.ts:1-24`).

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the Space to poll |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `since` | non-negative integer seq | no | default 0 | per-space `seq`; replay from the last seq durably applied |
| `limit` | positive integer | no | default 200 (`DEFAULT_POLL_LIMIT`), clamped to 500 (`MAX_POLL_LIMIT`) | page size |
| `entity` | uuid | no | — | narrow to events whose canonical subject set includes this entity |

Source: `packages/server/src/events/handlers.ts:56-90` (`parseSince`/`parseLimit`/`parseEntity`),
limits at `poll.ts:131-132`.

Example request: `GET /v2/spaces/<id>/events?since=1042&limit=100`

**Response** — 200; `data` is a `DurableEventPage` (`packages/server/src/events/poll.ts:72-84`):

| field | type | description |
|---|---|---|
| `items` | `DurableWorkspaceEvent[]` | events readable by the caller, in ascending seq |
| `nextCursor` | string \| null | the last seq **examined** (not just returned) — always a valid next `?since=`, never null (this feed has no end, only "caught up") |
| `hasMore` | boolean (optional) | the examine cap was hit — more rows may exist past `examinedThrough` |
| `examinedThrough` | number (optional) | last seq examined, including skipped/unreadable/non-matching rows |

```json
{"data": {"items": [{"spaceId": "<redacted>", "seq": 1043, "occurredAt": "2026-09-25T00:00:00Z",
  "schemaVersion": 1, "type": "entity.upsert", "entity": {"id": "<redacted>", "kind": "task"}}],
  "nextCursor": "1043", "hasMore": false, "examinedThrough": 1043}, "requestId": "req_00003c"}
```
(illustrative, from schema)

**Errors**

- `invalid_cursor` (400) — `since` not a non-negative integer, or out of safe-integer range
  (`handlers.ts:56-65`).
- `invalid_input` (400) — `limit` not a positive integer; `entity` not a uuid
  (`handlers.ts:71-77`, `:87-93`).
- `invalid_input` (400) — missing `spaceId` (`handlers.ts:113`).
- `not_implemented` (501) — a node with no durable event log configured
  (`NotImplementedEventLog`, `poll.ts:110-121`) refuses rather than answering an empty
  page, which would read as "you have missed nothing".

**Notes** — No mutation id (read). Cursor is the raw `seq`, not an opaque keyset cursor —
reusable verbatim as the next `?since=` (`poll.ts:56-63`). Authorization is
`workspace_events_select` RLS plus a role drop to `tm8_app` for the whole read+hydration
transaction, so a superuser pool connection cannot bypass it (`poll.ts:164-176`). Exempt
from the CLI's read cache by construction (`packages/cli/src/commands/event.ts:808-810`).

---

### `events.changes`
`GET /v2/spaces/:spaceId/events/changes` · kind: read · status: v1 · served: yes (`packages/server/src/events/handlers.ts:133`)
CLI: `tm8 event changes [--after <seq>] [--entity <id>...] [--anchor <id>...] [--subtree <id>...] [--kind <k>...] [--change <c>...] [--events] [--total-bytes <n>]`

The scoped change digest: "did anything I care about change since seq N?", answered as one
line per changed entity (`changed[]`, naming what moved and who moved it) rather than a
full event replay — or, with `--events`, thin per-event rows. Backed by the same durable
log as `events.poll`, narrowed by a GIN subject-id index (`packages/server/src/events/changes.ts:1-30`).

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the Space to scan |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `after` (alias `since`) | non-negative integer seq | no | default 0 | resume point |
| `entity` | uuid, repeatable/comma-joined | no | — | exact entities: their own rows, edges on them, PR/commit facts, notifications |
| `anchor` | uuid, repeatable/comma-joined | no | — | like `entity`, plus messages anchored to it roll up |
| `subtree` | uuid, repeatable/comma-joined | no | — | like `anchor`, plus the whole descendant subtree |
| `kind` | string, repeatable/comma-joined | no | — | filter changed entities by kind |
| `change` | string, repeatable/comma-joined | no | must be in the closed vocabulary | filter by change class: `created`, `updated`, `status`, `deleted`, `message`, `edge+`, `edge-`, `assigned`, `unassigned`, `pr`, `commit`, `notified` (each optionally `:detail`) |
| `events` | `true`\|`1` | no | default false | thin per-event rows instead of the per-entity digest |
| `totalBytes` | integer | no | default 16384, range 8192..32768 | response byte budget |

Combined scope (`entity`+`anchor`+`subtree`, resolved) is capped at 1000 ids
(`EVENT_CHANGES_MAX_SCOPE_IDS`); rows examined per request capped at 2000
(`EVENT_CHANGES_MAX_EXAMINED`); entities per digest page capped at 50
(`EVENT_CHANGES_MAX_ENTITIES`). Source: `packages/server/src/events/changes.ts:76-158`
(`parseChangesQuery`), constants at `packages/contract/src/contract.ts:6820-6838`.

Example request: `GET /v2/spaces/<id>/events/changes?after=500&anchor=<id>&change=status`

**Response** — 200; `data` is `EventChangesView` (`packages/contract/src/contract.ts:6937-6947`):

| field | type | description |
|---|---|---|
| `scope` | `EventChangesScope` (optional) | echoes the selectors given; omitted on a quiet/unchanged answer |
| `since` | number | the `after` this request used |
| `through` | number | cursor to resume from (`--after <through>`) |
| `more` | boolean | page stopped before the scope was exhausted |
| `gap` | `EventChangesGap` \| null | set when `after` is below the oldest retained event — `{after, oldestRetained}` |
| `unresolved` | `EntityId[]` | named ids the caller could not resolve/read |
| `changed` | `EventChangeEntry[]` (optional) | the digest, omitted when `--events` was requested |
| `events` | `EventChangeThinRow[]` (optional) | thin rows, present only with `--events` |
| `next` | string (optional) | the continuation command spelled out; omitted on an unchanged/quiet poll |

`EventChangeEntry` (`contract.ts:6882-6911`): `id`, `kind`, `title` (null only for a
hard-deleted entity), `parentId?`, `v` (current version, valid as `expectedVersion`),
`status?` (tasks/work sessions only), `lastSeq`, `changes: string[]`, `actors: string[]`,
`messages?: EventChangeMessage[]`, `messagesTotal?`, `messagesTotalAtLeast?`,
`messagesMore?`, `messagesNext?`. `EventChangeMessage` (`contract.ts:6866-6880`): `id`,
`author`, `replyTo`, `toMe`, `excerpt`, `truncated`. `EventChangeThinRow`
(`contract.ts:6913-6927`): `seq`, `type`, `id`, plus event-shape-dependent fields
(`kind`, `v`, `edge`, `src`, `dst`, `anchor`, `entity`, `verb`, `status`, `actor`).

```json
{"data": {"since": 500, "through": 512, "more": false, "gap": null, "unresolved": [],
  "scope": {"anchor": ["<redacted>"], "change": ["status"]},
  "changed": [{"id": "<redacted>", "kind": "task", "title": "Fix the thing", "v": 7,
    "status": "done", "lastSeq": 512, "changes": ["status:done"], "actors": ["<redacted>"]}],
  "next": "tm8 event changes --anchor <redacted> --change status --after 512"},
  "requestId": "req_00004d"}
```
(illustrative, from schema)

**Errors** — the three feed-specific refusals ride existing `CommandErrorCode`s, named by
`details.reason` (`EventChangesRefusal`, `contract.ts:6848`):

- `invalid_cursor` (400) — `index_incomplete`: the scanned window reaches below the
  subject-index backfill watermark; retried later once the backfill catches up
  (`packages/server/src/events/subject-index.ts:22-23,41`).
- `invalid_input` (400) — `scope_too_large`: resolved scope exceeds 1000 ids
  (`changes.ts:1071-1085`); also plain `invalid_input` for a malformed `after`/`totalBytes`
  or a `change` value outside the vocabulary (`changes.ts:119-146`).
- `payload_too_large` (413) — `digest_group_too_large`: even the smallest byte-compacted
  first group/event does not fit `totalBytes`; retry with a larger `--total-bytes` or
  `--events` (`changes.ts:612-625`, `:710-714`).
- `not_found` (404) — every explicitly named `entity`/`anchor`/`subtree` id was
  unreadable/unresolved (`changes.ts:891`).

**Notes** — No mutation id (read). `through` is the cursor; `next` spells the exact
continuing CLI command. Pages never skip a partial change-group — a cap stops *before* the
group that would cross it. Visibility is enforced by the same event-row mapper as
`events.poll` (RLS under the caller's claims); one exception: a hard-deleted entity the
caller explicitly named is reported from its captured spine if the caller could read that
row under event RLS.

---

## Summary of unverified items

- `search.query` request/response shape: **unverified** — confirmed by search (no
  `Search`-prefixed schema/type anywhere in `packages/contract/src/contract.ts` or
  `schemas.ts`) that none is defined; the operation is reserved with no shape by design,
  not a gap in this doc.

All other fields above are cited to source. No real CLI examples were captured against a
live space — the "Optional: real response examples" step was skipped in favor of
schema-derived illustrative examples, all marked accordingly, given `commands.undo` is a
command (excluded from capture) and the remaining reads would need a populated space and
live server session; every example JSON above is marked "(illustrative, from schema)".
