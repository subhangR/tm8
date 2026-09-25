# Edges, edge types, entity kinds, graph, collections, placements, saved views

This group covers the tm8 relationship graph and the read/write surfaces built on
top of it. `edges.*` and `edgeTypes.list` are the raw, typed relation store (a
row in `public.edges`: `src_id --type--> dst_id` plus a `props` jsonb bag,
validated against a per-type registered schema in `public.edge_types`).
`collections.*` and `graph.query` are both read projections over the same
underlying entity/edge tables — `collections.query` returns a flat or grouped
page of `EntitySummary` rows, `graph.query` returns a bounded node+edge lens
(`GraphResult`) suitable for a canvas. `placements.apply` is the single
higher-level "what does it mean to drop A onto B" verb: it never lets a caller
pick an edge type directly, translating a closed `intent` enum into whatever
edge write, hierarchy move, or message post the server decides that intent
means. `savedViews.*` persist a named `CollectionQuery` (plus optional canvas
layout) per space, shared or private. `entityKinds.*` is the custom entity-kind
registry (the `c:*` namespace) that lets a space extend the core entity
vocabulary with its own field schema and capability flags.

All 17 operations are catalog `status: 'v1'` (none are `reserved`) and all 17
have a registered handler — none answers `501 not_implemented`.

## Operations at a glance

| name | method | path | kind | served |
|---|---|---|---|---|
| `edges.list` | GET | `/v2/edges` | read | yes |
| `edges.create` | POST | `/v2/edges` | command | yes |
| `edges.patch` | PATCH | `/v2/edges/:edgeId` | command | yes |
| `edges.delete` | DELETE | `/v2/edges/:edgeId` | command | yes |
| `edgeTypes.list` | GET | `/v2/edge-types` | read | yes |
| `collections.query` | POST | `/v2/collections/query` | read | yes |
| `collections.addItem` | POST | `/v2/collections/:id/items` | command | yes |
| `collections.removeItem` | DELETE | `/v2/collections/:id/items/:entityId` | command | yes |
| `graph.query` | POST | `/v2/graph/query` | read | yes |
| `placements.apply` | POST | `/v2/placements` | command | yes |
| `savedViews.list` | GET | `/v2/spaces/:spaceId/saved-views` | read | yes |
| `savedViews.create` | POST | `/v2/saved-views` | command | yes |
| `savedViews.update` | PATCH | `/v2/saved-views/:viewId` | command | yes |
| `savedViews.delete` | DELETE | `/v2/saved-views/:viewId` | command | yes |
| `entityKinds.list` | GET | `/v2/spaces/:spaceId/entity-kinds` | read | yes |
| `entityKinds.create` | POST | `/v2/spaces/:spaceId/entity-kinds` | command | yes |
| `entityKinds.update` | PATCH | `/v2/spaces/:spaceId/entity-kinds/:kind` | command | yes |

`collections.query` and `graph.query` are both `POST` even though they are
`kind: 'read'` (catalog comment, `packages/contract/src/catalog.ts:407`): each
takes a structured query DTO too large/nested for a query string.

Source for the catalog rows: `packages/contract/src/catalog.ts:150-172` (edges,
collections, graph, placements), `:236-239` (saved views), `:310-312`
(entity kinds).

## Shared types

Every response envelope is `{ "data": <shape below>, "requestId": string }`
(success) or `{ "error": { code, message, details?, requestId, retryable } }`
(failure) — `packages/contract/src/envelope.ts:13-30`, `packages/server/src/http/errors.ts:76-113`.

**`Page<T>`** — `{ items: T[], nextCursor: string | null, total?: number }`.
`total` is the true count of the match under the query's filters (not just the
loaded page) whenever a query is grouped or paged past one page —
`packages/contract/src/contract.ts:993` (`Page`), computed in
`packages/server/src/facade/handlers/collections.ts:796-845`.

**`ActorSummary`** — `{ id, kind: 'member'|'team_member'|'work_session', displayName, avatar? }`.
`packages/contract/src/contract.ts:107-121`.

**`EntitySummary`** — the tile-sized entity projection used everywhere in this
group (`collections.query` items, `graph.query` nodes, `edges.list`
`source`/`target`). Documented fully in the entities-family reference; the
fields this group touches are `id`, `spaceId`, `kind`, `title`, `parentId`,
`position`, `version`, `activityAt`, `createdBy`, `capabilities?`.
`packages/contract/src/contract.ts:154-207`.

**`CollectionQuery`** (also the base shape `GraphQuery` extends and the shape a
`SavedView` stores) —

| field | type | description |
|---|---|---|
| `spaceId` | string (uuid) | required |
| `kinds` | `EntityKind[]` | optional kind filter |
| `subtreeOf` | entity id | restrict to a subtree |
| `parentId` | entity id \| `null` | direct children of, or top-level when `null` |
| `filters` | object | see below; every member optional |
| `filters.status` | `WorkStatus[]` | task-only |
| `filters.priority` | `('low'\|'medium'\|'high'\|'urgent')[]` | task-only |
| `filters.assigneeIds` / `assignedByIds` | entity id[] | |
| `filters.edge` | `{type, direction: 'incoming'\|'outgoing', entityId}` | one edge-shaped filter |
| `filters.sessionStatus` | `WorkSessionStatus[]` | work_session-only; refused together with `status`/`priority` (kind-disjoint, `invalid_input`) |
| `filters.category` | `StatusCategory[]` | kind-neutral lifecycle bucket |
| `filters.terms` | string[] | any-of substring match (memory rows only) |
| `filters.titleContains` | string | case-insensitive title substring, any kind |
| `filters.deleted` | `'exclude'\|'only'\|'include'` | default `exclude` |
| `filters.activeSince` | ISO datetime (with offset) | `activityAt >=` window |
| `filters.readyToPull` / `inReviewForActorId` / `mentionedActorId` / `workedByActorId` / `inFlightForActorId` / `needsActorId` / `skillProvider` / `skillLevel` / `skillRoot` / `skillMissing` / `skillEquipped` | various | preset/skill filters |
| `layout` | `'list'\|'board'\|'tree'\|'feed'\|'gallery'\|'graph'` | advisory to the caller's renderer |
| `groupBy` | `'status'\|'assignee'\|'priority'\|`axis:${string}`` | |
| `sort` | `'activityAt_desc'\|'updatedAt_desc'\|'createdAt_desc'\|'position'\|'dueDate'\|'startDate'\|'priority'` | default `activityAt_desc` |
| `cursor` | opaque string | keyset cursor, fingerprinted to the query |
| `limit` | integer | default 50, max 200 (`packages/server/src/facade/context.ts:144-153`) |

Full filter list: `packages/contract/src/contract.ts:998-1075`; Zod source:
`packages/contract/src/schemas.ts:1106-1166` (filters), `:1167-1180` (top
level).

**`CommandResult`** — the shape every mutation in this group returns (except
`savedViews.*`, which return a `SavedView` directly, and `entityKinds.*`,
which return an `EntityKindDef` directly):

| field | type | present when |
|---|---|---|
| `entity` | `EntityDetail` | the command touched/created an addressable entity (e.g. a `subtask`/`reparent` placement) |
| `edge` | `EdgeView` | the command wrote or touched exactly one edge, both endpoints resolvable |
| `activity` | `ActivityItem` | an activity row was recorded |
| `patches` | `EntitySummary[]` | every entity whose summary changed as a side effect (endpoints of the edge, moved entity, etc.) — always present, may be empty |
| `undo` | `{token, label, expiresAt?}` | the command minted a 5-minute undo token |
| `warnings` | `{code, message}[]` | present only when the server has something to say about a silent normalization |

`packages/contract/src/contract.ts:1687-1693`; assembled from the raw RPC
result in `packages/server/src/facade/handlers/entities.ts:319-407`.

**`EdgeView`** — `{id, type, source: EntitySummary, target: EntitySummary,
props, createdBy: ActorSummary, createdAt, updatedAt, resolved?, hard?}`.
`resolved`/`hard` are populated only for `type === 'depends_on'`.
`packages/contract/src/contract.ts:899-900`.

**`GraphEdgeView`** — the same edge facts as `EdgeView`, but `sourceId`/
`targetId` are bare ids instead of embedded `EntitySummary` (endpoints are
already in the same response's `nodes` array) — `packages/contract/src/contract.ts:919-921`.

**Error taxonomy.** Every `CollabError` carries a closed `code` mapped to an
HTTP status by `ERROR_STATUS` (`packages/contract/src/contract.ts:1628-1636`):
`invalid_input`/`invalid_cursor`→400, `unauthenticated`→401, `forbidden`→403,
`not_found`→404, `version_conflict`/`conflict`/`invariant_violation`→409,
`limit_exceeded`→429, `not_implemented`→501. A Postgres error surfaces through
a mechanical SQLSTATE table (`packages/server/src/http/errors.ts:35-63`):
`42501`→`forbidden`, `P0002`/`22P02`→`not_found`, `22023`→`invalid_input`,
`23514`/`23503`/`23505`→`invariant_violation`, `40001`→`version_conflict`,
`53400`→`limit_exceeded`. Below, "raises `<code>`" means the RPC's SQLSTATE
maps to that code via this table.

---

### `edges.list`
`GET /v2/edges` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/edges-placements.ts:301`)
CLI: `tm8 edge list [--source <id>] [--target <id>] [--type <t>] [--direction incoming|outgoing] [--limit <n>] [--cursor <c>]`

Pages the raw edge relation, both endpoints joined live (a tombstoned endpoint
hides the edge). `--target` is the CLI's name for the wire's `destination`.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `source` | uuid | no | — | filter to edges whose *query-relative* source is this entity |
| `destination` | uuid | no | — | filter to edges whose *query-relative* destination is this entity |
| `type` | string | no | non-empty when present | edge type |
| `direction` | `incoming`\|`outgoing` | no | default `outgoing` | reframes which storage endpoint `source`/`destination` address — see Notes |
| `cursor` | opaque string | no | must match this exact filter set (fingerprinted) | keyset page cursor |
| `limit` | integer | no | 1..200, default 50 | page size |

**Response** — 200; `data: Page<EdgeView>`.

```json
{
  "data": {
    "items": [
      {
        "id": "3d5e...",
        "type": "depends_on",
        "source": { "id": "task-a", "title": "Ship the thing", "...": "EntitySummary" },
        "target": { "id": "task-b", "title": "Design review", "...": "EntitySummary" },
        "props": { "hard": true },
        "createdBy": { "id": "mem-1", "kind": "member", "displayName": "<redacted>" },
        "createdAt": "2026-09-20T10:00:00.000Z",
        "updatedAt": "2026-09-20T10:00:00.000Z",
        "resolved": false,
        "hard": true
      }
    ],
    "nextCursor": null
  },
  "requestId": "req_00001a"
}
```
(illustrative, from schema)

**Errors** — `invalid_input` (400): malformed `source`/`destination` uuid, empty
`type`, `direction` outside `incoming|outgoing`, non-positive `limit`.
`invalid_cursor` (400): cursor's embedded fingerprint doesn't match the
current filter set, or its shape isn't `[fingerprint, timestamp, id]`.

**Notes** — No auth beyond space membership (RLS via the caller's claims — no
explicit `require_space_member` call in this read path, but every SELECT runs
under the caller's JWT claims same as elsewhere). `direction: incoming` swaps
which physical column (`src_id`/`dst_id`) `source`/`destination` filter, but
the returned `EdgeView.source`/`.target` always reflect true storage
direction, never the query's framing. Cursor is opaque and scoped
(`edges.list`); reusing one from a different filter combination is refused.
Source: query builder `packages/server/src/facade/services/w2/edges-placements.ts:161-242`;
catalog row `packages/contract/src/catalog.ts:150`.

---

### `edges.create`
`POST /v2/edges` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/edges-placements.ts:311`)
CLI: `tm8 edge create <source-entity-id> <edge-type> <target-entity-id> [--props <json>]`

Writes (or upserts) one typed edge. `on conflict (src_id, dst_id, type) do
update` — creating the same triple twice updates `props` rather than
duplicating the row.

**Request body** (`CreateEdgeInput`, extends `CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `srcId` | uuid | yes | | edge source entity |
| `dstId` | uuid | yes | | edge destination entity |
| `type` | string | yes | min length 1 | edge type; must be a row in `public.edge_types` for props validation to run, but an unregistered type is not itself refused |
| `props` | object | no | must not contain `origin` (Server-owned) | edge properties; validated per-type against `edge_types.props_schema` if the type is registered |
| `actorId` | uuid | no | | acting member/team_member override |
| `clientMutationId` | string | no | | idempotency key |
| `workSessionId` | uuid | no | | provenance |

Example request:
```json
{ "srcId": "task-a", "dstId": "task-b", "type": "depends_on", "props": { "hard": true } }
```

**Response** — 201; `data: CommandResult` (with `edge` populated, both
endpoints in `patches`; carries an `edges.delete`-labeled `undo` token).

**Errors**
- `forbidden` (403) — `props.origin` supplied (`42501`); type is one of the
  recorder-owned types (`shared_into`, `authored_from`, `selected_profile`,
  `defaults_to_profile`) written by anything but its owning recorder;
  `type: 'attached_to'` from a `file` to a `message` written by anything but
  the message-attachment command (`details.reason: 'attachment_edge_owned'`);
  caller is not a space member.
- `invariant_violation` (409) — endpoints in different spaces (`23514`);
  `type: 'in_project'` naming a project with no live projection/link
  (`details.reason: 'project_not_linked'`, `23514`); edge `props` fails the
  registered type's JSON-schema-lite validation (`22023`→`invalid_input`,
  not `invariant_violation` — see next line).
- `invalid_input` (400) — `props` value/type mismatch against the registered
  schema, or an unregistered `additionalProperties:false` field (`22023`).
- `not_found` (404) — `srcId`/`dstId` does not resolve to a live entity
  (`P0002`).
- `limit_exceeded` (429) — a `work_session` source already has 16 live
  `in_project` associations (`details.reason: 'project_association_cap'`, `53400`).

**Notes** — Idempotent via `clientMutationId` (command ledger,
`internal.ledger_replay`/`ledger_record`); replaying the same id returns the
original result without re-executing. Emits an `edge.upsert`-class activity
(`linked`). `props.origin` is stamped server-side for provenance-owned types
(`in_project`, `participates_in`, `in_worktree`, `anchored_to`, `messaged`,
`created_in`) regardless of what the caller sent. Source: RPC `write_edge`
(`db/migrations/018_w2_edges_placements.sql:145`), ownership/cap guard trigger
`internal.guard_w1_edge` (`db/migrations/211_forms_ops.sql:70`), handler
`packages/server/src/facade/services/w2/edges-placements.ts:311-331`.

---

### `edges.patch`
`PATCH /v2/edges/:edgeId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/edges-placements.ts:333`)
CLI: `tm8 edge update <edge-id> --props <json>`

Replaces an edge's `props` wholesale (endpoints and type are immutable).

**Path params** — `edgeId` | uuid | the edge to patch.

**Request body** (`PatchEdgeInput`, extends `CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `props` | object | yes | must not contain `origin` | full replacement of edge properties (a server-owned `origin`, if present, is preserved across the replace) |
| `actorId` / `clientMutationId` / `workSessionId` | — | no | | command envelope |

**Response** — 200; `data: CommandResult` (with `edge` populated when both
endpoints resolve).

**Errors** — `forbidden` (403): `props.origin` supplied, or the edge's
`props.origin` is being changed by a writer not on the allowed correction list
(`project_correction`, `handoff_recorder`, `message_recorder`, `profile_pin`,
`profile_default`); a materialized `in_project` association on a
`pull_request`/`commit` (requires a correction command instead). `not_found`
(404): no such edge (`P0002`). `invalid_input` (400): `props` fails the
registered type's schema.

**Notes** — Idempotent via `clientMutationId`. Source: RPC `update_edge`
(`db/migrations/018_w2_edges_placements.sql:219`), handler
`packages/server/src/facade/services/w2/edges-placements.ts:333-352`.

---

### `edges.delete`
`DELETE /v2/edges/:edgeId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/edges-placements.ts:354`)
CLI: `tm8 edge delete <edge-id> --yes`

**Path params** — `edgeId` | uuid | the edge to delete.

**Request body** — bare `CommandContext` (`actorId?`, `clientMutationId?`, `workSessionId?`).

**Response** — 200; `data: CommandResult` (`patches` carries both former
endpoints; no `edge`/`entity`; carries an undo token labeled to re-`edges.create`
the same triple).

**Errors** — `not_found` (404): no such edge. `invariant_violation` (409):
deleting the sole surviving `participates_in` edge of a `spawning`/`running`/
`idle` work session ("a live work session must retain one participant").
`forbidden` (403): the edge type/`origin` combination is recorder- or
correction-owned (same rules as `edges.patch`).

**Notes** — Idempotent via `clientMutationId`. Source: RPC `delete_edge`
(`db/migrations/018_w2_edges_placements.sql:263`), handler
`packages/server/src/facade/services/w2/edges-placements.ts:354-370`.

---

### `edgeTypes.list`
`GET /v2/edge-types` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/edges-placements.ts:306`)
CLI: `tm8 edge type list`

Lists the registered edge-type vocabulary (no path/query params, no
pagination — every registered type is returned).

**Response** — 200; `data: EdgeTypeView[]`.

| field | type | description |
|---|---|---|
| `type` | string | edge type name |
| `sourceKinds` / `destinationKinds` | `EntityKind[]` | permitted endpoint kinds |
| `direction` | `'directed'` | always directed (no undirected edge types exist) |
| `description` | string | |
| `propsSchema` | object | the JSON-Schema-lite object this type's `props` is validated against |
| `acyclic` | boolean | whether the type refuses a cycle on write |

```json
{
  "data": [
    { "type": "depends_on", "sourceKinds": ["task"], "destinationKinds": ["task"],
      "direction": "directed", "description": "...", "propsSchema": {"type":"object","properties":{"hard":{"type":"boolean"}}}, "acyclic": true }
  ],
  "requestId": "req_00001b"
}
```
(illustrative, from schema)

**Errors** — none beyond the generic auth/5xx paths; this is a plain table read.

**Notes** — No mutation surface exists for the type registry itself (types are
seeded by migration). Source: `packages/server/src/facade/services/w2/edges-placements.ts:244-259`;
`propsSchema` seeded in `db/migrations/018_w2_edges_placements.sql:16-58`.

---

### `collections.query`
`POST /v2/collections/query` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/collections.ts:847`)
CLI: `tm8 entity query --kind <k>... [--subtree <id>] [--status <s>]... [--assignee <id>]... [--ready] [--limit <n>] [--cursor <c>]` (the public invocation is `entity query`, not a `collection` noun — `collections.query` is the wire operation name)

The one generic list/board/tree read: a filtered, sorted, optionally-grouped
page of `EntitySummary`, keyset-paginated.

**Request body** — `CollectionQuery` (see Shared types above). `.strict()` —
an unrecognized key is `invalid_input`.

Example request:
```json
{ "spaceId": "space-1", "kinds": ["task"], "filters": { "status": ["open"] }, "limit": 25 }
```

**Response** — 200; `data: CollectionResult`.

| field | type | description |
|---|---|---|
| `query` | `CollectionQuery` | the query as resolved (defaulted `sort`/`limit` filled in) — reproducible on re-execution |
| `page` | `Page<EntitySummary>` | |
| `groups` | `CollectionGroup[]` | present only when `groupBy` was set; each `{key, label, items, nextCursor?, total?}` |

**Errors** — `invalid_input` (400): unsupported `sort`, unsupported `groupBy`,
or the `status`/`priority` + `sessionStatus` kind-disjoint combination
(refused by schema `superRefine`, never a confident empty result).
`invalid_cursor` (400): cursor fingerprint/shape mismatch.

**Notes** — No mutation id (read). `Page.total` is a true server-side count
(not `items.length`) whenever the page wasn't a complete, uncursored match —
see `pageIsWholeMatch`, which skips the extra `count(*)` when the fetched page
already proves it's everything. Source: `packages/server/src/facade/handlers/collections.ts:624-722`
(query builder), `:754-845` (total/group total), `:847-853` (handler).

---

### `collections.addItem`
`POST /v2/collections/:id/items` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/collections.ts:862`)
CLI: `tm8 collection add <collection-id> <entity-id> [--position <n>]`

Sugar over a `contains` edge (collection → entity, ordered by
`props.position`). Re-adding an existing member re-positions it rather than
duplicating.

**Path params** — `id` | uuid | the collection (any live entity; not restricted to a "collection" kind label).

**Request body** (`CollectionAddItemInput`, extends `CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `entityId` | uuid | yes | must differ from `id` | member to add |
| `position` | number | no | finite | explicit position; omitted ⇒ appended after the current max (never defaulted to `0` client-side) |

**Response** — 200; `data: CommandResult` (`patches` = [collection, entity]).

**Errors** — `invalid_input` (400): `entityId === id` ("a collection cannot
contain itself", `22023`). `not_found` (404): collection or entity not live.

**Notes** — Idempotent via `clientMutationId`. Rides the `edges.create` ledger
family and the edge-write trigger, so live collection views refresh through
the existing `edge.upsert` event with no new plumbing. A non-numeric stored
`position` (from a hand-crafted `edges.create` on the same `contains` triple)
is simply excluded from the max-position scan rather than raising. Source: RPC
`set_collection_item` (`db/migrations/100_collection_membership.sql:86`),
handler `packages/server/src/facade/handlers/collections.ts:862-880`.

---

### `collections.removeItem`
`DELETE /v2/collections/:id/items/:entityId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/collections.ts:881`)
CLI: `tm8 collection remove <collection-id> <entity-id> --yes`

**Path params**

| name | type | description |
|---|---|---|
| `id` | uuid | the collection |
| `entityId` | uuid | the member to remove |

**Request body** — bare `CommandContext`.

**Response** — 200; `data: CommandResult` (`patches` = [collection, entity]; no `edge`).

**Errors** — `not_found` (404): the entity is not currently a member of this
collection (`P0002`), **or** the collection itself is not live — unlike
`edges.delete`, only the collection endpoint needs to be live, not the member,
so a membership pointing at an archived entity can still be cleaned up.

**Notes** — Idempotent via `clientMutationId`. Ledgered under the
`edges.delete` family. Source: RPC `remove_collection_item`
(`db/migrations/100_collection_membership.sql:27`), handler
`packages/server/src/facade/handlers/collections.ts:881-897`.

---

### `graph.query`
`POST /v2/graph/query` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/graph-undo.ts:196`)
CLI: `tm8 graph query --focus <id> [--hops <n>] [--edge-type <t>]... [--mode free|dependency] [--limit <n>] [--cursor <c>]`

A bounded, RLS-filtered node+edge lens for a canvas: candidate nodes come from
the same `collections.query` semantics, then edges among them are traversed
outward from an optional `focusId`.

**Request body** (`GraphQuery` = `CollectionQuery` + the fields below, `.strict()`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| *(all `CollectionQuery` fields)* | | `spaceId` required | | candidate node scope/filter |
| `focusId` | uuid | no | must be among the candidate nodes, else empty result | traversal origin |
| `hops` | integer | no | 1..3; **requires `focusId`** (else `invalid_input`); default 1 when `focusId` set | traversal depth |
| `edgeTypes` | string[] | no | | restrict traversal/edge-set to these types |
| `mode` | `'free'`\|`'dependency'` | no | | `dependency` forces `edgeTypes` to `['depends_on']` regardless of the field above |

**Response** — 200; `data: GraphResult`.

| field | type | description |
|---|---|---|
| `nodes` | `EntitySummary[]` | selected nodes (candidates, or the BFS frontier from `focusId` out to `hops`, capped at `limit`) |
| `edges` | `GraphEdgeView[]` | the complete induced edge set among `nodes` (not merely traversal edges) |
| `clusters` | `{parentId, childIds}[]` | groups selected nodes by `parentId` when the parent is itself selected |
| `layout` | `Record<id, {x,y}>` | optional; not populated by this handler today |

**Errors** — `invalid_input` (400): `focusId` not a uuid; `hops` given without
`focusId`; `hops` not an integer in 1..3. `invalid_cursor` (400): inherited
from the candidate `collections.query` cursor check.

**Notes** — No mutation id (read; the CLI refuses `--mutation-id` locally,
`packages/cli/src/commands/graph.ts:6-8`). Traversal discovers through a hard
1,000-edge ceiling per query before applying the caller's `limit`, so
`limit: 10` never means "focus must happen to be in the first ten
candidates." Both candidate and edge reads execute as the caller (RLS), and
both endpoint-liveness joins are re-checked so a tombstone can't enter through
an otherwise-live edge. Source: `packages/server/src/facade/handlers/w2/graph-undo.ts:37-203`.

---

### `placements.apply`
`POST /v2/placements` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/edges-placements.ts:372`)
CLI: `tm8 placement apply <source-entity-id> attach|assign|depend|subtask|embed|reparent <target-entity-id>`

The intent-level "drop A onto B" verb. The caller never names an edge type;
the server maps `intent` to the concrete write:

| `intent` | effect |
|---|---|
| `attach` | `write_edge(source, target, 'attached_to')`; if `embedMessage` given, also posts a message on `target` embedding `source` |
| `assign` | requires one endpoint `kind: 'task'` and the other `'member'`/`'team_member'`; writes `assigned_to` from task to assignee |
| `depend` | writes `depends_on` from **target to source** (`hard: true`) — i.e. `target` becomes dependent on `source` |
| `subtask` / `reparent` | requires same-kind endpoints; moves `source` under `target` via `move_entity` (appends after current max position unless `embedMessage`'s sibling flag `position` — see body — is set) |
| `embed` | posts a message on `target` embedding `source`; the message itself carries the undo token (`messages.delete`), not a synthetic "unembed" |

**Request body** (`PlacementInput`, extends `CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `sourceId` | uuid | yes | | the entity being placed |
| `targetId` | uuid | yes | | the destination |
| `intent` | `'attach'\|'assign'\|'depend'\|'subtask'\|'embed'\|'reparent'` | yes | closed enum | what the placement means |
| `embedMessage` | string | no | | text for `attach`'s optional embed / `embed`'s message body; **not bound by the CLI** (`packages/cli/src/commands/placement.ts:47`) |

Example request:
```json
{ "sourceId": "file-1", "targetId": "task-1", "intent": "attach" }
```

**Response** — 200; `data: CommandResult`. Shape depends on `intent`: `attach`/
`depend`/`assign` populate `edge`; `subtask`/`reparent` populate `entity`
(the moved entity's detail, via `move_entity`); `embed` populates `entity`
(the posted message) with an `undo` token labeled to reverse via
`messages.delete`.

**Errors** — `invalid_input` (400): `intent` outside the enum (`22023`,
should not reach the server past schema validation but is also guarded in the
RPC); `assign` where neither endpoint pairing is `(task, member|team_member)`
(`22023`); `subtask`/`reparent` with differing endpoint kinds (`22023`).
`invariant_violation` (409): `sourceId`/`targetId` in different spaces
(`23514`). `not_found` (404): either endpoint not live (`P0002`).
`version_conflict` (409): concurrent modification of `source` racing a
`subtask`/`reparent` move (the RPC reads `source.version` and passes it to
`move_entity` as the expected version).

**Notes** — Idempotent via `clientMutationId`; ledgered under
`placements.apply`. `depend`'s edge direction is easy to misread: passing
`sourceId=A, targetId=B, intent=depend` makes **B** depend on **A** (the edge
is written `target -> depends_on -> source`). The CLI's `--embed-message` flag
does not exist — an `attach`/`embed` placement always posts a bare embed
marker unless a future grammar amendment adds it. Source: RPC `place_entity`
(`db/migrations/018_w2_edges_placements.sql:301`), handler
`packages/server/src/facade/services/w2/edges-placements.ts:372-392`.

---

### `savedViews.list`
`GET /v2/spaces/:spaceId/saved-views` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/saved-views-actions.ts:99`)
CLI: `tm8 saved-view list`

**Path params** — `spaceId` | uuid | the space to list views for.

**Response** — 200; `data: SavedView[]` — a **bare, unpaginated array**; there
is no `limit`/`cursor`/`nextCursor` on this operation (confirmed against a
live server: `--limit 1` still returns every stored view — the CLI refuses
both flags by name rather than silently drop them,
`packages/cli/src/commands/saved-view.ts:87-124`).

`SavedView`: `{id, spaceId, name, shareMode: 'private'|'space', query: CollectionQuery, graphLayout?, createdBy: ActorSummary, createdAt}`.

**Errors** — none beyond generic auth; visibility (space-shared rows plus only
the caller's own private rows) is enforced by RLS, not by this handler.

**Notes** — Ordered `created_at desc, id desc`. Source:
`packages/server/src/facade/services/w2/saved-views-actions.ts:99-125`.

---

### `savedViews.create`
`POST /v2/saved-views` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/saved-views-actions.ts:127`)
CLI: `tm8 saved-view create <name> --share private|space --query <json-source> [--graph-layout <json-source>]`

**Request body** (`SavedViewInput`, extends `CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `name` | string | yes | 1..200 chars after trim | |
| `shareMode` | `'private'\|'space'` | yes | | |
| `query` | `CollectionQuery` | yes | `query.spaceId` must equal the space the view is created in | the saved query |
| `graphLayout` | `Record<id,{x,y}>` | no | | canvas node positions |
| `clientMutationId` | string | **required** (not optional despite `CommandContext`) | non-empty | idempotency key; the RPC 400s without one |

Example request:
```json
{ "name": "My board", "shareMode": "private", "query": { "spaceId": "space-1", "kinds": ["task"] }, "clientMutationId": "cmid-1" }
```

**Response** — 201; `data: SavedView`.

**Errors** — `invalid_input` (400): missing/blank `clientMutationId`; `name`
outside 1..200 chars; `shareMode` not `private`/`space`; `query`/`graphLayout`
not an object; `query.spaceId` missing or not equal to the path space
(`22023`). `forbidden` (403): caller is not a space member.

**Notes** — Idempotent (ledgered under `savedViews.create`); replay is
re-authorized against the ORIGINAL owner, not merely re-served, so a replayed
`clientMutationId` from a different member is refused. Source: RPC
`create_saved_view` (`db/migrations/024_w2_saved_views_actions.sql:12`),
handler `packages/server/src/facade/services/w2/saved-views-actions.ts:127-146`.

---

### `savedViews.update`
`PATCH /v2/saved-views/:viewId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/saved-views-actions.ts:148`)
CLI: `tm8 saved-view update <saved-view-id> --name <name> --share private|space --query <json-source> [--graph-layout <json-source>]`

**Path params** — `viewId` | uuid | the saved view to replace.

**Request body** — same shape as `savedViews.create`'s `SavedViewInput`. This
is a **wholesale replacement**, not a partial patch: `name`, `shareMode` and
`query` are all required and all three are overwritten; there is no
`expectedVersion` guard anywhere in this operation (`SavedView` publishes no
version to guard). Omitting `graphLayout` **nulls** any previously stored
layout — the server does not merge it (CLI docs this explicitly,
`packages/cli/src/commands/saved-view.ts:199-208`). `query.spaceId` cannot
change from the view's current space.

**Response** — 200; `data: SavedView`.

**Errors** — `invalid_input` (400): same shape checks as create, plus
`query.spaceId` disagreeing with the view's stored space ("a saved view cannot
move between Spaces"). `not_found` (404): no such view (`P0002`). `forbidden`
(403): caller is not the view's owner ("only the saved view owner may update
it").

**Notes** — Idempotent via required `clientMutationId`; replay re-authorized
against the original owner. Source: RPC `update_saved_view`
(`db/migrations/024_w2_saved_views_actions.sql:77`), handler
`packages/server/src/facade/services/w2/saved-views-actions.ts:148-168`.

---

### `savedViews.delete`
`DELETE /v2/saved-views/:viewId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/saved-views-actions.ts:170`)
CLI: `tm8 saved-view delete <saved-view-id> --yes`

**Path params** — `viewId` | uuid.

**Request body** — bare `CommandContext`, but `clientMutationId` is required
(same as create/update).

**Response** — 200; `data: SavedView` (the deleted row, as it was).

**Errors** — `not_found` (404): no such view. `forbidden` (403): caller is not
the view's owner.

**Notes** — Idempotent via required `clientMutationId`. Source: RPC
`delete_saved_view` (`db/migrations/024_w2_saved_views_actions.sql:149`),
handler `packages/server/src/facade/services/w2/saved-views-actions.ts:170-184`.

---

### `entityKinds.list`
`GET /v2/spaces/:spaceId/entity-kinds` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:194`)
CLI: `tm8 kind list`

Lists every core kind plus every custom (`c:*`) kind registered for this
space.

**Path params** — `spaceId` | uuid.

**Response** — 200; `data: EntityKindDef[]`, core kinds first (`origin: 'core'`
sorts before `'custom'`), then by `kind`.

`EntityKindDef`: `{id, kind, origin: 'core'|'custom', spaceId: string|null, icon?, fieldSchema: CustomFieldDef[], capabilities: Record<string,boolean>, createdBy?, createdAt}`.
`CustomFieldDef`: `{name, type: 'text'|'number'|'bool'|'date'|'enum', required?, values?}`.

**Errors** — none beyond generic auth.

**Notes** — Core kinds have `spaceId: null`. Source:
`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:194-207`;
types `packages/contract/src/contract.ts:6776-6790`.

---

### `entityKinds.create`
`POST /v2/spaces/:spaceId/entity-kinds` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:209`)
CLI: `tm8 kind create c:<name> --schema <json-array> [--capabilities <json>] [--icon <value|none>]`

Registers a new custom entity kind for the space.

**Path params** — `spaceId` | uuid.

**Request body** (`EntityKindCreateInput`, extends `CommandContext`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `kind` | string | yes | schema-level: starts with `c:`, length > 2; RPC-level (authoritative): `^c:[a-z0-9][a-z0-9_]{0,48}$` | the new kind name |
| `icon` | string \| `null` | no | ≤ 100 chars | |
| `fieldSchema` | `CustomFieldDef[]` | yes | validated shape (name/type/required/values) | |
| `capabilities` | `Record<string,boolean>` | no | validated vocabulary | |
| `clientMutationId` | string | **required** | non-empty | |

Example request:
```json
{ "kind": "c:recipe", "fieldSchema": [{"name":"servings","type":"number"}], "clientMutationId": "cmid-2" }
```

**Response** — 200 (not 201 — this row is not wrapped in the create-status
helper other `*.create` operations use); `data: EntityKindDef`.

**Errors** — `invalid_input` (400): `kind` fails the `c:[a-z0-9][a-z0-9_]{0,48}` regex
(`22023`); `icon` too long; `fieldSchema`/`capabilities` fail their internal
shape assertions. `forbidden` (403): caller is not a **space admin**
(`require_space_admin`, stricter than every other write in this group).

**Notes** — Idempotent via required `clientMutationId`. Errors are normalized
through a shared "frozen reason" lift (`normalizeG12Error`) shared with the
Interaction Profile operations in the same service; none of this group's three
`entityKinds.*` ops currently raise one of those named reasons. Source: RPC
`w2_create_entity_kind` (`db/migrations/027_w2_entity_kinds_profiles.sql:326`),
handler `packages/server/src/facade/services/w2/entity-kinds-profiles.ts:209-229`.

---

### `entityKinds.update`
`PATCH /v2/spaces/:spaceId/entity-kinds/:kind` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:231`)
CLI: `tm8 kind update c:<name> [--schema <json>] [--capabilities <json>] [--icon <value|none>] [--allow-tightening]`

Partially updates a custom kind's icon, field schema, and/or capabilities.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |
| `kind` | string | the custom kind's name (`c:...`) |

**Request body** (`EntityKindUpdateInput`, extends `CommandContext`) — at
least one of `icon`, `fieldSchema`, `capabilities`, `allowTightening` must be
present (CLI refuses an empty update locally); `clientMutationId` is
**required**.

| field | type | required | constraints | description |
|---|---|---|---|---|
| `icon` | string \| `null` | no | | |
| `fieldSchema` | `CustomFieldDef[]` | no | schema evolution checked against the current schema (see Notes) | |
| `capabilities` | `Record<string,boolean>` | no | | |
| `allowTightening` | boolean | no | | allows a schema change that would otherwise be refused as narrowing |

**Response** — 200; `data: EntityKindDef` (the full row after patch).

**Errors** — `invalid_input` (400): unrecognized patch key, empty patch,
`kind` not matching the `c:*` pattern, `icon`/`allowTightening` wrong JSON
type. `not_found` (404): no such custom kind in this space (`P0002`).
`forbidden` (403): caller is not a space admin.

**Notes** — Idempotent via required `clientMutationId`. A field-schema change
that removes/narrows a field is refused unless `allowTightening: true` — and
even then, if any live `custom_entities` row of this kind holds data the
narrower schema would reject, the update raises rather than silently
truncating existing rows. Source: RPC `w2_update_entity_kind`
(`db/migrations/027_w2_entity_kinds_profiles.sql:362`), handler
`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:231-250`.
