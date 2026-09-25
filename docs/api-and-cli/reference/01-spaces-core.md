# Spaces (core)

A **Space** is tm8's top-level container — a team's shared workspace. This
group covers the Space lifecycle (list/create/get/update), the two boot-time
reads a client issues after picking a Space (`navigation`, `home`), the menu
rail's per-kind counters (`counts`), read-only projections used by the
Settings/Configs pages (`settings`, `configs`), the gamification reads
(`leaderboard`, `awards`), the customizable navigation menu (`menu.get`,
`menu.update`), and two space-wide defaults (`defaultChannel.set`,
`interactionProfile.setDefault`). Sibling groups (not covered here) own
members, invites, task axes, task/workflow definitions — all mounted under
`/v2/spaces/:spaceId/...` alongside these.

Every operation in this group is `status: v1` and every one has a registered
handler (none answer `501 not_implemented`).

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `spaces.list` | GET | `/v2/spaces` | read | yes |
| `spaces.create` | POST | `/v2/spaces` | command | yes |
| `spaces.get` | GET | `/v2/spaces/:spaceId` | read | yes |
| `spaces.update` | PATCH | `/v2/spaces/:spaceId` | command | yes |
| `spaces.navigation` | GET | `/v2/spaces/:spaceId/navigation` | read | yes |
| `spaces.home` | GET | `/v2/spaces/:spaceId/home` | read | yes |
| `spaces.counts` | GET | `/v2/spaces/:spaceId/counts` | read | yes |
| `spaces.settings` | GET | `/v2/spaces/:spaceId/settings` | read | yes |
| `spaces.configs` | GET | `/v2/spaces/:spaceId/configs` | read | yes |
| `spaces.leaderboard` | GET | `/v2/spaces/:spaceId/leaderboard` | read | yes |
| `spaces.awards` | GET | `/v2/spaces/:spaceId/awards` | read | yes |
| `spaces.menu.get` | GET | `/v2/spaces/:spaceId/menu` | read | yes |
| `spaces.menu.update` | PUT | `/v2/spaces/:spaceId/menu` | command | yes |
| `spaces.defaultChannel.set` | PUT | `/v2/spaces/:spaceId/default-channel` | command | yes |
| `spaces.interactionProfile.setDefault` | PUT | `/v2/spaces/:spaceId/interaction-profile-default` | command | yes |

Source (catalog rows): `packages/contract/src/catalog.ts:73-81,106-107,321-323,340`.

## Shared types (define once)

**Envelope.** Every response is `{ "data": <shape below>, "requestId": "req_..." }`
(`packages/server/src/http/server.ts:516,556,566`). A command's success status
is `200` unless noted; `spaces.create` answers `201`.

**Errors.** Every error is `{ "error": { "code", "message", "details"?, "requestId", "retryable" } }`
with HTTP status from `ERROR_STATUS` (`packages/contract/src/contract.ts:1628-1638`).
Codes used by this group: `invalid_input` (400), `unauthenticated` (401),
`forbidden` (403), `not_found` (404), `version_conflict`/`conflict` (409),
`invalid_cursor` (400), `upstream_unavailable` (503). A raw Postgres error is
mapped through a fixed SQLSTATE table (`packages/server/src/http/errors.ts:34-64`);
anything not in that table becomes `upstream_unavailable`, never a guessed 400.

**`CommandContext`** (shape shared by every command body in this group unless
noted): `actorId?: EntityId`, `clientMutationId?: string`, `workSessionId?: EntityId`.
Zod shape at `packages/contract/src/schemas.ts:1662-1666`; type at
`packages/contract/src/contract.ts:1698`.

**`SpaceSummary`** — the shape returned by `spaces.list`/`spaces.get`/`spaces.create`/`spaces.update`:

| field | type | description |
|---|---|---|
| `id` | string | Space id |
| `name` | string | |
| `description` | string | |
| `memberCount` | number | |
| `unreadTotal` | number \| null | Always `null` on this shape — deliberately not measured here (cost); see Notes on `spaces.navigation` for the real number. |
| `githubRepo` | string \| null | optional |
| `createdAt` | string (ISO) | |
| `sessionShareDefault` | `'none'` \| `'space'` | optional; default posture for new sessions (187) |
| `sessionDriveDefault` | `'owner'` \| `'space'` | optional |

Source: `packages/contract/src/contract.ts:3411-3450`; builder `toSpaceSummary`
at `packages/server/src/facade/handlers/spaces.ts:46-72`, columns at
`packages/server/src/facade/handlers/spaces.ts:117-125`.

**`ActorSummary`** / **`EntitySummary`** — shared shapes from the entities
family (`packages/contract/src/contract.ts:107-129,154-`); referenced by
`spaces.navigation`, `spaces.leaderboard`, `spaces.awards`. Not redefined here;
key fields used below: `ActorSummary{ id, kind, displayName, avatar?, isAgent }`,
`EntitySummary{ id, spaceId, kind, title, parentId, ... }`.

**`TaskAxis`**, **`TaskWorkflow`** — embedded in `spaces.settings`'s response.
`TaskAxis{ id, spaceId, name, axisValues: string[], kind: 'default'|'manual', position }`
(`contract.ts:3501-3508`); `TaskWorkflow{ id, spaceId, typeValue, statuses: WorkStatus[] }`
(`contract.ts:3522-3527`).

---

### `spaces.list`
`GET /v2/spaces` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/spaces.ts:127-139`)
CLI: `tm8 space list`

Lists every Space the caller is a member of, plus public ones (filtered by the
`spaces_select` RLS policy — no explicit membership filter in the handler).
Ordered `created_at desc, id desc`. Not paginated (no `limit`/`cursor`; the CLI
command refuses `--mutation-id` but still accepts a page-shaped `--limit`
locally, which is silently unused by the operation since the handler ignores
query params — confirmed by reading `spacesList` at `spaces.ts:127-139`, which
takes no `ctx.query`).

**Response** — 200; `data` is `SpaceSummary[]`.

Deliberately excludes `unreadTotal` measurement (`null` on every row) — this
is the first request of workspace boot and the field would cost a
SECURITY-DEFINER-gated scan of `public.messages` per Space (documented at
length in `spaces.ts:74-116`, with prod buffer-count measurements from
2026-08-19).

Example (illustrative, from schema):
```json
{
  "data": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "Acme Engineering",
      "description": "",
      "memberCount": 12,
      "unreadTotal": null,
      "githubRepo": null,
      "createdAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "requestId": "req_00003a"
}
```

**Errors** — none beyond the generic auth/db taxonomy; an unauthenticated
caller never reaches this handler (rejected earlier in the pipeline).
**Notes** — no idempotency (read). No pagination.
Source: catalog `catalog.ts:73`; handler `spaces.ts:127-139`.

---

### `spaces.create`
`POST /v2/spaces` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/spaces.ts:165-229`)
CLI: `tm8 space create <name> [--description <text|@file|-> ] [--visibility private|public] [--mutation-id <id>]`

Creates a Space, its owner membership, a default `general` channel and the
default task axis in one transaction (RPC `create_space`), then (if
`launchBootstrap` is configured) best-effort seeds the default teammates —
a seeding failure is logged and swallowed, not raised to the caller.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `name` | string | yes | min length 1 | |
| `description` | string | no | | defaults to `''` |
| `visibility` | `'private'` \| `'public'` | no | | defaults to `'private'` |
| `githubRepo` | string \| null | no | | |
| `clientMutationId` | string | no | | idempotency key |
| `actorId` | EntityId | no | | not bound into this command's ledger — a new Space has no actor namespace yet |
| `workSessionId` | EntityId | no | | |

Schema: `CreateSpaceInputSchema`, `packages/contract/src/schemas.ts:2699-2705`;
type `CreateSpaceInput`, `packages/contract/src/contract.ts:2942-2948`.
Bound centrally via `packages/server/src/facade/input-schemas.ts:231`.

Example request:
```json
{ "name": "Acme Engineering", "visibility": "private", "clientMutationId": "c-1" }
```

**Response** — 201; `data`:

| field | type | description |
|---|---|---|
| `space` | SpaceSummary | the created Space, read back through the same path `spaces.get` uses |
| `memberId` | string | the caller's new owner-member entity id |
| `defaultChannelId` | string | the seeded `general` channel's entity id |

Example:
```json
{
  "data": {
    "space": { "id": "11111111-1111-1111-1111-111111111111", "name": "Acme Engineering", "description": "", "memberCount": 1, "unreadTotal": null, "githubRepo": null, "createdAt": "2026-09-25T00:00:00.000Z" },
    "memberId": "22222222-2222-2222-2222-222222222222",
    "defaultChannelId": "33333333-3333-3333-3333-333333333333"
  },
  "requestId": "req_00003b"
}
```

**Errors** — `upstream_unavailable` if the space was created by the RPC but is
not readable back (should not happen in practice). Otherwise the generic RPC
error taxonomy (SQLSTATE table).
**Notes** — idempotent via `clientMutationId` (command ledger). No
`expectedVersion` (nothing to version yet). Side effect: seeds default
teammates best-effort when configured.
Source: catalog `catalog.ts:74`; schema `schemas.ts:2699-2705`; handler
`spaces.ts:165-229`; registered `packages/server/src/facade/handlers/w2/identity-spaces.ts:53`.

---

### `spaces.get`
`GET /v2/spaces/:spaceId` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/spaces.ts:141-157`)
CLI: `tm8 space get [<space-id>]` (falls back to the space from context)

Fetches one Space by id.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` is `SpaceSummary`.

**Errors** — `not_found` ("no such space: `<id>`") both when the space does
not exist and when RLS makes it unreadable — the two cases are made
indistinguishable deliberately, so a caller cannot learn a private space
exists. A malformed (non-uuid) `spaceId` also becomes `not_found` (`requireUuidParam`,
`packages/server/src/facade/context.ts:127-132`), not a 400.
**Notes** — no idempotency (read).
Source: catalog `catalog.ts:75`; handler `spaces.ts:141-157`.

---

### `spaces.update`
`PATCH /v2/spaces/:spaceId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/identity-spaces.ts:453-476`)
CLI: `tm8 space update [<space-id>] [--name <n>] [--description <text|@file|->] [--github-repo <url|none>] [--session-share none|space] [--session-drive owner|space] [--mutation-id <id>]`

Patches Space metadata and/or the two session-sharing defaults (187). At
least one field must be present or the handler refuses locally
(`invalid_input`). Forwards only an allow-listed subset of body keys to the
RPC `w2_update_space`, which validates the sharing-default vocabulary itself
(SQLSTATE `22023` → `invalid_input`).

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `name` | string | no | min length 1 | |
| `description` | string | no | | |
| `githubRepo` | string \| null | no | | |
| `sessionShareDefault` | `'none'` \| `'space'` | no | | default posture for **new** sessions only; never retroactive |
| `sessionDriveDefault` | `'owner'` \| `'space'` | no | | |
| `clientMutationId` | string | yes | | required (`requireMutationId`) |
| `actorId` | EntityId | no | uuid | |
| `workSessionId` | EntityId | no | | accepted by the schema, unused by the handler's patch allow-list |

Schema: `UpdateSpaceInputSchema`, `packages/contract/src/schemas.ts:2708-2717`
(`.strict()` — an unnamed key is a 400 at the door); type `UpdateSpaceInput`,
`packages/contract/src/contract.ts:2951-2966`. Note: the handler
(`W2IdentitySpacesService.spacesUpdate`) reads the body itself via a local
allow-list rather than the centrally-bound schema object; both agree on the
same five patchable keys.

Example request:
```json
{ "name": "Acme Eng (renamed)", "clientMutationId": "c-2" }
```

**Response** — 200; `data` is `SpaceSummary` (patched).

**Errors** — `invalid_input` — "at least one Space metadata field is required"
when the patch is empty, or a bad sharing-default value from the RPC.
**Notes** — idempotent via required `clientMutationId`. No `expectedVersion` —
this PATCH is not optimistic-locked.
Source: catalog `catalog.ts:76`; schema `schemas.ts:2708-2717`; handler
`services/w2/identity-spaces.ts:453-476`; registered
`handlers/w2/identity-spaces.ts:55`.

---

### `spaces.navigation`
`GET /v2/spaces/:spaceId/navigation` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/spaces.ts:241-318`)
CLI: `tm8 space navigation get [<space-id>]`

Returns the viewer's own summary plus the Space's channel tree — the first
read a client issues after opening a Space. Requires membership; an empty
tree is never substituted for a refusal (would misreport "no channels" for
"you can't see this").

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` (`SpaceNavigation`):

| field | type | description |
|---|---|---|
| `spaceId` | string | |
| `viewer` | ActorSummary | the caller's own actor row in this space |
| `unreadTotal` | number | true measured total across every anchor kind (task/doc/channel), NOT the sum of per-channel counts below |
| `channels` | NavChannelNode[] | root-level nodes; each `{ entity: EntitySummary, childCount, children: NavChannelNode[] }` |

A channel whose parent is outside the readable set (deleted/unreadable) is
surfaced as a root rather than dropped.

Example (illustrative, from schema):
```json
{
  "data": {
    "spaceId": "11111111-1111-1111-1111-111111111111",
    "viewer": { "id": "22222222-2222-2222-2222-222222222222", "kind": "member", "displayName": "<redacted>", "isAgent": false },
    "unreadTotal": 3,
    "channels": [
      { "entity": { "id": "33333333-3333-3333-3333-333333333333", "spaceId": "11111111-1111-1111-1111-111111111111", "kind": "channel", "title": "general" }, "childCount": 0, "children": [] }
    ]
  },
  "requestId": "req_00003c"
}
```

**Errors** — `unauthenticated` if `claims.identityId` is absent (should be
unreachable); `forbidden` ("not a member of this space") if the caller has no
`members` row for this Space.
**Notes** — one `unread_counts` RPC call serves both the per-channel counts
and the space-wide total (previously issued twice; merged for cost — see
comment at `spaces.ts:269-286`).
Source: catalog `catalog.ts:77`; type `contract.ts:3451-3457`; handler
`spaces.ts:241-318`; registered `handlers/w2/identity-spaces.ts:56`.

---

### `spaces.home`
`GET /v2/spaces/:spaceId/home` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/spaces.ts:329-387`)
CLI: `tm8 space home get [<space-id>]`

The "My Work" snapshot: three server-defined task presets (`readyToPull`,
`inFlight` for the caller, `needsMe`) plus a compact activity feed, all read
inside one transaction so the snapshot is internally consistent.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` (`HomeSnapshot`):

| field | type | description |
|---|---|---|
| `readyToPull` | CollectionResult | `collections.query`-shaped result, filter `readyToPull: true`, `kinds: ['task']` |
| `inFlight` | CollectionResult | filter `inFlightForActorId: <caller's member entity id>` |
| `needsMe` | CollectionResult | filter `needsActorId: <caller's member entity id>` |
| `activity` | `Page<ActivityItem>` | `nextCursor` always `null` — no operation accepts a Space-scoped activity cursor today |

Each preset carries its own re-runnable `query` (`CollectionResult.query`), so
a client can page past the first page of any preset via `collections.query`.

**Errors** — `unauthenticated`; `forbidden` ("not a member of this space").
**Notes** — read-only snapshot; the four sub-reads run sequentially inside one
transaction (the pooled pg client cannot run them concurrently).
Source: catalog `catalog.ts:78`; type `contract.ts:3493-3499`; handler
`spaces.ts:329-387`; registered `handlers/w2/identity-spaces.ts:57`.

---

### `spaces.counts`
`GET /v2/spaces/:spaceId/counts` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/spaces.ts:406-429`)
CLI: `tm8 space counts get [<space-id>]`

The menu rail's per-entity-kind counters, in one grouped RPC scan
(`space_kind_counts`) rather than a `Page.total` per list.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` is `SpaceKindCounts` — `Partial<Record<EntityKind, { total: number; unseen: number }>>`.
A kind with no rows in the Space is **absent**, not present with zeroes.

Example (illustrative, from schema — the shape matches a live `tm8 space counts get` response; the values are made up):
```json
{
  "data": { "task": { "total": 42, "unseen": 5 }, "doc": { "total": 7, "unseen": 0 } },
  "requestId": "req_00003d"
}
```

**Errors** — generic auth taxonomy (`unauthenticated`); the RPC is
`security definer` and re-checks membership/readability itself rather than
relying on a handler-side check.
**Notes** — read-only; not derived from `queryCollection` (counting is not
paging — a capped page would either be wrong or scan the whole table).
Source: catalog `catalog.ts:79`; type `contract.ts:3462-3474`; handler
`spaces.ts:406-429`; registered `handlers/w2/identity-spaces.ts:58`.

---

### `spaces.settings`
`GET /v2/spaces/:spaceId/settings` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/identity-spaces.ts:478-530`)
CLI: `tm8 space settings get [<space-id>]`

The Settings-page aggregate: Space summary, members, invites, task axes, task
workflows, the stored menu, and the two space-wide defaults, all read inside
one transaction. Requires membership (any role). The assembled object is
re-validated against `SpaceSettingsViewSchema` before being returned — a
stored-row shape violation becomes `upstream_unavailable` rather than an
unvalidated payload reaching the wire.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` (`SpaceSettingsView`, extends `SpaceSettings`):

| field | type | description |
|---|---|---|
| `space` | SpaceSummary | |
| `members` | `Array<{ actor: ActorSummary; role: SpaceMemberRole; joinedAt: string }>` | `SpaceMemberRole = 'owner'\|'admin'\|'member'` |
| `invites` | `Array<{ id, code, role: 'admin'\|'member', maxUses, uses, expiresAt: string\|null, revoked: boolean }>` | |
| `taskAxes` | TaskAxis[] | |
| `taskWorkflows` | TaskWorkflow[] | optional; absent means "none defined" on a pre-132 fixture |
| `menu` | MenuConfig | `{ schemaVersion: 1, revision: number, groups: MenuGroup[] }` — same shape as `spaces.menu.get` |
| `defaultChannelId` | EntityId \| null | |
| `defaultInteractionProfileId` | EntityId \| null | |
| `settingsRevision` | number | the optimistic-concurrency guard used by `spaces.menu.update` / `spaces.defaultChannel.set` / `spaces.interactionProfile.setDefault` |

**Errors** — `not_found` ("no such space"); `forbidden` ("not a member of this
space"); `unauthenticated`; `upstream_unavailable` — "Space menu configuration
is missing" if the `space_menu_configs` row is absent, or "stored Space
settings violate the frozen contract" on a schema mismatch.
**Notes** — read-only. `settingsRevision` is the single guard value shared by
three separate mutations in this group.
Source: catalog `catalog.ts:80`; types `contract.ts:3596-3616`; handler
`services/w2/identity-spaces.ts:478-530`; registered
`handlers/w2/identity-spaces.ts:59`.

---

### `spaces.configs`
`GET /v2/spaces/:spaceId/configs` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/configs.ts:11-24`)
CLI: `tm8 space configs get [<space-id>]`

Every knob that shapes tm8's behaviour for this Space, read-only and
redacted: a `secret` env knob reports `{kind:'secret', present}` and its value
is never read. Node-environment knobs (`node`) are visible only to a node
admin on a human (`browser`/`cli`) auth session; every other caller gets
`node: {visible:false}`.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` (`SpaceConfigsView`):

| field | type | description |
|---|---|---|
| `spaceId` | string | |
| `node` | `{visible:true, knobs: ConfigKnobView[]}` \| `{visible:false, reason: string}` | gated on `claims.nodeAdmin && authKind in ('browser','cli')` |
| `cli` | ConfigKnobView[] | always `{kind:'unobservable', reason}` — read in the caller's own shell, not the server |
| `code` | ConfigKnobView[] | compiled-in constants |
| `teammates` | ConfigSubjectView[] | `{id, name, knobs: ConfigKnobView[]}` per team member in the space |
| `profiles` | ConfigSubjectView[] | per non-retired interaction profile |

`ConfigKnobView { name, group, summary, value: ConfigValue, source, default, definedAt, change }`;
`ConfigValue = {kind:'value',text} | {kind:'unset'} | {kind:'secret',present} | {kind:'unobservable',reason}`.

**Errors** — `not_found` — "space `<id>` not found".
**Notes** — read-only, no pagination. Never emits a secret's value, only
whether it is set.
Source: catalog `catalog.ts:81`; types `contract.ts:2507-2542`; handler
`packages/server/src/configs/service.ts:217-253`; registered
`handlers/w2/configs.ts:11-24`.

---

### `spaces.leaderboard`
`GET /v2/spaces/:spaceId/leaderboard` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/identity-spaces.ts:792-844`)
CLI: `tm8 space leaderboard get [<space-id>] [--limit <n>] [--cursor <opaque>]`

Ranks every member/team_member actor in the Space by summed point-event
score, descending, keyset-paginated.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `limit` | integer | no | default 50, max 200 (`limitOf`, `context.ts:142-151`) | |
| `cursor` | string (opaque) | no | encodes `[score, actorId]` | continuation token; the CLI never decodes it |

**Response** — 200; `data` is `Page<LeaderboardRow>`:
`LeaderboardRow { actor: ActorSummary, score: number, rank: number }`
(`contract.ts:3581`). `rank` is a SQL `rank()` window over the whole scored
set, not just the returned page.

**Errors** — `forbidden` (not a member); `invalid_cursor` — "score must be
numeric" on a malformed cursor.
**Notes** — read-only. Ties broken by `actor_id asc` for a stable cursor.
Source: catalog `catalog.ts:106`; type `contract.ts:3581`; handler
`services/w2/identity-spaces.ts:792-844`; registered
`handlers/w2/identity-spaces.ts:76`.

---

### `spaces.awards`
`GET /v2/spaces/:spaceId/awards` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/identity-spaces.ts:846-905`)
CLI: `tm8 space award list [<space-id>] [--limit <n>] [--cursor <opaque>]`

Lists point-events of reason `'award'` for the Space, newest first,
keyset-paginated.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `limit` | integer | no | default 50, max 200 | |
| `cursor` | string (opaque) | no | encodes `[createdAt, id]` | |

**Response** — 200; `data` is `Page<PointEventView>`:

| field | type | description |
|---|---|---|
| `id` | string | |
| `recipient` | ActorSummary | the actor the points were credited to |
| `actor` | ActorSummary | who granted them |
| `amount` | number | |
| `reason` | `'grant'\|'award'\|'seed'` | always `'award'` on this operation's rows |
| `onEntity` | EntitySummary \| null | resolved from the same entity id as `recipient` (the row carries one `entity_id`, read both as the recipient actor and as this summary) |
| `ref` | EntitySummary \| null | e.g. the task that generated the award, when `ref_id` is set |
| `createdAt` | string (ISO) | |

Source of the `onEntity`/`recipient` mapping:
`packages/server/src/facade/services/w2/identity-spaces.ts:864-897` (both are
read off `point_row.entity_id`, aliased `recipient_id`).

**Errors** — `forbidden` (not a member); `invalid_cursor` — "createdAt must be
an ISO timestamp".
**Notes** — read-only. The cursor's `createdAt` is carried as a
microsecond-precision string, never round-tripped through a JS `Date`.
Source: catalog `catalog.ts:107`; type `contract.ts:3584-3592`; handler
`services/w2/identity-spaces.ts:846-905`; registered
`handlers/w2/identity-spaces.ts:77`.

---

### `spaces.menu.get`
`GET /v2/spaces/:spaceId/menu` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/menu-default-channel.ts:130-139`)
CLI: `tm8 space menu get [<space-id>]`

Returns the Space's stored navigation menu (RPC `get_space_menu`), validated
against the frozen `MenuConfig` shape before being returned.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Response** — 200; `data` is `MenuConfig`:

| field | type | description |
|---|---|---|
| `schemaVersion` | `1` | |
| `revision` | number | optimistic-concurrency guard for `spaces.menu.update` |
| `groups` | MenuGroup[] | `{ id, label, items: MenuItem[] }`, max 8 groups |

`MenuItem = {type:'view', ref: MenuViewRef, children?: MenuLeaf[]} | {type:'kind', ref: MenuKindRef}`.
`MenuViewRef` is one of `dashboard\|feed\|inbox\|workspace\|graph\|channels\|files\|settings\|git\|messages\|board\|craft\|help`
(`contract.ts:3096`). `MenuKindRef` is any `EntityKind` except `message`.

**Errors** — `upstream_unavailable` — "stored Space menu violates the frozen
MenuConfig contract" if the stored row fails schema validation.
**Notes** — read-only.
Source: catalog `catalog.ts:321`; types `contract.ts:3117-3130,3385-3391`;
schema `schemas.ts:2806-2810`; handler
`services/w2/menu-default-channel.ts:130-139`; registered
`handlers/w2/menu-default-channel.ts:16`.

---

### `spaces.menu.update`
`PUT /v2/spaces/:spaceId/menu` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/menu-default-channel.ts:141-160`)
CLI: `tm8 space menu update [<space-id>] --expect-revision <n> --data <json-source> [--mutation-id <id>]`

Replaces the Space's stored menu via RPC `update_space_menu`, guarded by
`expectedRevision`.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min length 1 | |
| `expectedRevision` | integer | yes | ≥ 0 | optimistic-concurrency guard against `MenuConfig.revision` |
| `payload.schemaVersion` | `1` | yes | | |
| `payload.groups` | MenuGroup[] | yes | max 8 groups, group ids/refs globally unique, must include the `settings` view ref | |

Schema: `UpdateMenuInputSchema`, `packages/contract/src/schemas.ts:2812-2816`;
type `UpdateMenuInput`, `packages/contract/src/contract.ts:3394-3398`.
**Note on wiring:** this operation is listed in
`UNBOUND_COMMAND_OPERATIONS` (`packages/server/src/facade/input-schemas.ts:433`)
— it has no binding in the central dispatch-time schema map — but the
handler itself parses the body against `UpdateMenuInputSchema` before use
(`menu-default-channel.ts:42-48,144`), so the body is validated, just not
through the shared table.

Example request:
```json
{ "clientMutationId": "c-3", "expectedRevision": 4, "payload": { "schemaVersion": 1, "groups": [ { "id": "work", "label": "Work", "items": [ { "type": "view", "ref": "settings" } ] } ] } }
```

**Response** — 200; `data` is `MenuConfig` (the new stored menu, with
`revision` incremented).

**Errors** — `invalid_input` (malformed payload); `conflict` — normalized from
a `version_conflict` whose `details.reason` is `menu_revision_conflict` or
`menu_upgrade_required` (`menu-default-channel.ts:96-111`); `upstream_unavailable`
if the RPC's own result or event-effect payload fails re-validation.
**Notes** — idempotent via required `clientMutationId`. `expectedRevision` is
the optimistic-lock guard. No `actorId` accepted (the DTO is not a
`CommandContext`); side effect: may emit a `menu.updated` event (only on the
first committed attempt, never on a ledger replay).
Source: catalog `catalog.ts:322`; schema `schemas.ts:2812-2816`; handler
`services/w2/menu-default-channel.ts:141-160`; registered
`handlers/w2/menu-default-channel.ts:17`.

---

### `spaces.defaultChannel.set`
`PUT /v2/spaces/:spaceId/default-channel` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/menu-default-channel.ts:162-172`)
CLI: `tm8 space default-channel set [<space-id>] <channel-id|none> --expect-revision <n> [--mutation-id <id>]`

Sets (or clears, with `channelId: null`) the Space's default channel via RPC
`set_space_default_channel`, guarded by `expectedSettingsRevision`.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min length 1 | |
| `expectedSettingsRevision` | integer | yes | > 0 | guards `SpaceSettingsView.settingsRevision` |
| `channelId` | EntityId \| null | yes | | `null` clears the default |

Schema: `SetDefaultChannelInputSchema`, `packages/contract/src/schemas.ts:2818-2822`;
type `SetDefaultChannelInput`, `packages/contract/src/contract.ts:3400-3404`.
Also in `UNBOUND_COMMAND_OPERATIONS` (`input-schemas.ts:434`) for the same
reason as `spaces.menu.update` — self-validated in the handler
(`menu-default-channel.ts:50-56,165`), not centrally bound.

⚠ The CLI flag is `--expect-revision` binding to field `expectedSettingsRevision`
— the *same flag spelling* `space menu update` uses for its own, differently
named field `expectedRevision`. The two are not interchangeable
(`packages/cli/src/commands/space.ts:1150-1172`).

**Response** — 200; `data` is `SpaceSettingsView` (see `spaces.settings`) — the
full settings projection, not just the changed field.

**Errors** — `invalid_input`; `conflict` (revision mismatch, from
`version_conflict` + `details.currentRevision`); `upstream_unavailable` if the
result fails `SpaceSettingsViewSchema` validation.
**Notes** — idempotent via required `clientMutationId`. No `actorId` accepted.
Source: catalog `catalog.ts:323`; schema `schemas.ts:2818-2822`; handler
`services/w2/menu-default-channel.ts:162-172`; registered
`handlers/w2/menu-default-channel.ts:18`.

---

### `spaces.interactionProfile.setDefault`
`PUT /v2/spaces/:spaceId/interaction-profile-default` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:345-357`)
CLI: `tm8 space interaction-profile set-default <interaction-profile-id|none> --expect-settings-revision <n> [--confirm-agent-generated] --yes [--mutation-id <id>]`
(requires a human principal and explicit `--yes` confirmation, per
`packages/cli/src/commands/teammate.ts:149-153`)

Sets (or clears) the Space's default interaction profile via RPC
`set_space_profile_default`, guarded by `expectedSettingsRevision`.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | | |
| `expectedSettingsRevision` | integer | yes | | guards `SpaceSettingsView.settingsRevision` |
| `profileId` | EntityId \| null | yes | | `null` clears the default |
| `confirmAgentGenerated` | `true` | no | | required by the RPC when the target profile was agent-generated (unvalidated human review) |

Schema: `SetSpaceProfileDefaultInputSchema`, defined at
`packages/contract/src/schemas.ts:4278`; type `SetSpaceProfileDefaultInput`,
`packages/contract/src/contract.ts:6664-6668`. Also listed in
`UNBOUND_COMMAND_OPERATIONS` (`input-schemas.ts:441`); self-validated in the
handler via `parseInput(SetSpaceProfileDefaultInputSchema, ...)`
(`entity-kinds-profiles.ts:348`).

**Response** — 200; `data` is `SpaceProfileDefaultView`:

| field | type | description |
|---|---|---|
| `spaceId` | string | |
| `defaultInteractionProfileId` | EntityId \| null | |
| `settingsRevision` | number | the new revision |

Source: `packages/contract/src/contract.ts:6726-6730`.

**Errors** — normalized through `normalizeG12Error`
(`entity-kinds-profiles.ts:141-167`): a frozen `details.reason` of
`profile_not_validated`, `profile_retired`, `profile_principal_required`, or
`profile_capture_mode_reserved` surfaces at its SQLSTATE-mapped code with
`details.reason` set; `profile_referenced_default` is forced to `conflict`
regardless of its raw code; a `version_conflict` carrying
`details.currentRevision` is remapped to `conflict` (dossier §8.2).
**Notes** — idempotent via `clientMutationId`. `expectedSettingsRevision` is
the optimistic-lock guard, distinct in name from `spaces.menu.update`'s
`expectedRevision`. Actor selection for this op is Bearer-derived
(`ctx.identity.actorId`), never taken from the body.
Source: catalog `catalog.ts:340`; types `contract.ts:6664-6668,6726-6730`;
handler `services/w2/entity-kinds-profiles.ts:345-357`; registered
`handlers/w2/entity-kinds-profiles.ts:22`.
