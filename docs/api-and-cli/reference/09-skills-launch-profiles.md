# Skills, Launch, and Interaction Profiles

This family covers three loosely related groups of operations that all shape what a
teammate's session loads and how it behaves:

- **`skills.*`** — the filesystem-backed skill catalog (Claude/Codex/Hermes/Agents skill
  files under project or home roots), its `skill` entity mirror in the graph, and the
  equip/unequip edges that decide which skills a teammate carries into a launch.
- **`launch.*`** — read-only advice and defaults for the launch sheet UI: `launch.suggest`
  asks Jev (an LLM advisor) for model/teammate/memory/skill picks, and `launch.defaults`
  computes what a launch would load with nothing explicitly selected, using spawn's own
  loaders so the two can never drift.
- **`interactionProfiles.*`** — the propose → update → validate → activate lifecycle for
  an *Interaction Profile*: a versioned, frozen-shape bundle of prompt policy, tool
  discovery policy, feed policy and composer policy that a session pins to.

All are HTTP-only; `skills.*` (except `roots` and `preview`) also project onto `tm8 skill
*` CLI verbs, and `interactionProfiles.*` (except the two `*.setDefault` operations, out of
scope for this file) project onto `tm8 interaction-profile *`. `launch.*` has no CLI verb —
catalog comments mark both as UI-only (`packages/contract/src/catalog.ts:59-66`).

## Summary

| name | method | path | kind | served |
|---|---|---|---|---|
| `skills.roots` | GET | `/v2/spaces/:spaceId/skills/roots` | read | yes |
| `skills.create` | POST | `/v2/spaces/:spaceId/skills` | command | yes |
| `skills.edit` | PATCH | `/v2/skills/:id` | command | yes |
| `skills.equip` | POST | `/v2/skills/:id/equip` | command | yes |
| `skills.unequip` | POST | `/v2/skills/:id/unequip` | command | yes |
| `skills.scan` | POST | `/v2/spaces/:spaceId/skills/scan` | command | yes |
| `skills.list` | GET | `/v2/spaces/:spaceId/skills` | read | yes |
| `skills.preview` | GET | `/v2/spaces/:spaceId/skills/preview` | read | yes |
| `skills.show` | GET | `/v2/skills/:id` | read | yes |
| `launch.suggest` | POST | `/v2/spaces/:spaceId/launch/suggest` | command | yes |
| `launch.defaults` | GET | `/v2/spaces/:spaceId/launch/defaults` | read | yes |
| `interactionProfiles.propose` | POST | `/v2/spaces/:spaceId/interaction-profiles` | command | yes |
| `interactionProfiles.updateDraft` | PATCH | `/v2/interaction-profiles/:profileId/draft` | command | yes |
| `interactionProfiles.validate` | POST | `/v2/interaction-profiles/:profileId/validate` | command | yes |
| `interactionProfiles.preview` | POST | `/v2/interaction-profiles/:profileId/preview` | read | yes |
| `interactionProfiles.activate` | POST | `/v2/interaction-profiles/:profileId/activate` | command | yes |
| `interactionProfiles.retire` | POST | `/v2/interaction-profiles/:profileId/retire` | command | yes |

All 17 are `status: 'v1'` and all 17 have a registered handler (none answer `501
not_implemented`). Source: `packages/contract/src/catalog.ts:50-58` (skills), `:59-66`
(launch), `:333-338` (interactionProfiles).

## Shared plumbing

**Envelope.** Every successful response is `{ data, requestId }` and nothing else
(`packages/server/src/http/server.ts:516`, DEV-6). Every error is `{ error: { code,
message, details?, requestId, retryable } }` with `status = ERROR_STATUS[code]`
(`packages/contract/src/contract.ts:1628-1637`, `packages/server/src/http/errors.ts:89-112`).
A handler that isn't registered answers `501 not_implemented` before body validation runs
(`packages/server/src/http/server.ts:16,28-31,425`); none of these 17 hit that path.

**Command envelope.** Every command body may carry `actorId?: string` (uuid) and
`clientMutationId?: string`; `workSessionId?: string` is also read generically but unused
by this family (`packages/server/src/facade/context.ts:32-46`). When the server's
`idempotencyEnabled` config is not explicitly `false`, the facade injects a fresh
`clientMutationId` into a command body that omits one, so a `.strict()` input schema that
declared no such field would 400 every request (`packages/server/src/http/server.ts` —
`normalizeCommandInputForIdempotencyMode`). `clientMutationId` is the operation's
idempotency key: SQL writers open with `internal.ledger_replay(cmid, '<op name>')` — a
replayed id returns the SAME stored jsonb result rather than re-running the write, and
close with `internal.ledger_record(cmid, '<op name>', result)` (e.g.
`db/migrations/129_task_assignment_provenance.sql:75-81`,
`db/migrations/027_w2_entity_kinds_profiles.sql:826-866`).

**Two different validation paths, same `invalid_input` code, different `details`.**
Operations listed in `packages/server/src/facade/input-schemas.ts`'s `INPUT_SCHEMAS` map
(`skills.create`, `skills.edit`, `skills.equip`, `skills.unequip`, `skills.scan`,
`launch.suggest` — lines 307-311, 313) are validated centrally before the handler runs;
a failure raises `invalid_input` with `details: { issues: <zod issues array> }`
(`packages/server/src/http/server.ts:507-513`). The six `interactionProfiles.*` command
operations in this file are **not** bound there — they are explicitly listed in
`UNBOUND_COMMAND_OPERATIONS` (`packages/server/src/facade/input-schemas.ts:429-436`,
covering propose/updateDraft/validate/activate/retire; `.preview` is a `read`-kind op and
is unbound for the same reason) — and instead validate inside
`W2EntityKindsProfileService` via a local `parseInput` helper that raises `invalid_input`
with only the **first** zod issue's message, no `details.issues` array
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:78-84`). `skills.roots`,
`skills.list`, `skills.preview`, `skills.show` and `launch.defaults` take no validated
body at all (GET reads); `skills.preview`'s query object is parsed with the zod schema's
plain `.parse()` rather than `.safeParse()` (`packages/server/src/skills/handlers.ts:59-74`)
— **unverified as fully intentional, but observed:** a malformed query there throws a raw
`ZodError`, which is not a `CollabError`, so it is *not* caught by the closed taxonomy and
surfaces as a generic `503 upstream_unavailable` ("internal server error") rather than
`400 invalid_input` (`packages/server/src/http/errors.ts:99-121`).

**Path params that aren't UUIDs are `not_found`, not `invalid_input`.** Every `:id`,
`:spaceId`, `:profileId` here is read with `requireUuidParam`, which raises `not_found`
(404) for a non-uuid value rather than 400 — "a string that cannot be a uuid cannot
identify a row" (`packages/server/src/facade/context.ts:117-133`).

**`CommandResult` (nominal write-command shape).**
```
entity?: EntityDetail
edge?: EdgeView
activity?: ActivityItem
patches: EntitySummary[]
undo?: UndoToken
warnings?: ResultWarning[]
```
Source: `packages/contract/src/contract.ts:1687-1694`, schema at
`packages/contract/src/schemas.ts:2252`. **Not enforced on the wire**: no output-schema
validation runs on the command response path (`packages/server/src/http/registry.ts`,
`http/server.ts` — `writeResult` forwards the handler's return value as-is). Two operations
in this file return the *raw* jsonb of a `internal.command_result(...)`-built SQL RPC
rather than a schema-conformant `CommandResult`: `skills.equip`'s success path returns
`write_edge`'s jsonb verbatim, whose `edge` field is `to_jsonb(public.edges row)` — i.e.
snake-case columns (`id, src_id, dst_id, type, props, created_at, updated_at, assigned_by,
assigned_at`), not the camelCase `EdgeView` the type declares
(`packages/server/src/skills/mutations.ts:36`; RPC at
`db/migrations/129_task_assignment_provenance.sql:52-83`; `internal.command_edge` at
`db/migrations/007_rpc_catalog.sql:44-47`). `skills.edit`'s no-`sourcePath` branch is
similar: `update_skill_entity`'s `entity` field is `to_jsonb(entities row)` merged with
`content`/`counters`, not a full `EntityDetail` (no `hierarchy`/`connections`/`capabilities`/
`badges`/`state`) (`db/migrations/017_w2_entities_commands_tracking.sql:248-265`).

**`EntitySummary` / `EntityDetail`.** Every entity-kind operation elsewhere in the API
uses these two shapes; skills reuse them rather than defining their own. `EntitySummary`
carries `id, spaceId, kind, title, parentId, position, visibility, version, activityAt,
createdAt, updatedAt, deletedAt, createdBy, counters, state, badges` plus optional
`capabilities` (`packages/contract/src/contract.ts:154-；196`, exact list at lines
154-196). `EntityDetail extends EntitySummary` and adds `content, hierarchy, connections,
capabilities, header?` (`packages/contract/src/contract.ts:691-700`). The skill-specific
`state` discriminant (`state.kind === 'skill'`) is:
```
description?: string
equipped: boolean
changedOnDisk: boolean
provider: 'claude' | 'agents' | 'codex' | 'hermes' | 'tm8'
level: 'system' | 'admin' | 'user' | 'project' | 'nested' | 'plugin' | 'synced' | 'session' | 'space'
root?: { kind: 'home' | 'project' | 'plugin' | 'subdir'; ref: string | null }
sourcePath?: string
dirName?: string
frontmatter: Record<string, unknown>
loaderMetadata?: Record<string, unknown>
contentHash?: string
fileMtime?: string
bodyBytes?: number
bundle?: { scripts: number; references: number; assets: number }
missing: boolean
lastSeenAt?: string
```
Source: `packages/contract/src/schemas.ts:486-501` (schema), same shape mirrored as a plain
TS type at `packages/contract/src/contract.ts` (search `kind: 'skill'`, line 445/795 for the
narrower list-row unions).

**Skill reference/index types**, shared by `skills.preview`, `skills.list`'s
`SkillReference`-derived state, and elsewhere:
```
SkillIndexEntry   { entityId, name, description, provider, level, sourcePath?, loadPointer,
                     native: boolean, hash?, allowImplicitInvocation?, viaTaskId? }
SkippedSkill      { entityId, name, hash?, sourcePath?, reason }
EffectiveSkills   { native: SkillIndexEntry[]; indexed: SkillIndexEntry[]; skipped: SkippedSkill[]; scannedAt: string | null }
```
Source: `packages/contract/src/skill-reference.ts:1-60`, schemas at
`packages/contract/src/schemas.ts:363-374`.

**Interaction-profile policy types**, shared by all six `interactionProfiles.*` operations
below (defined once here, referenced by name in each operation):
```
ClosedPromptPolicy {
  kernelTemplate: string
  manifestMaxBytes: number        // 1..4096
  kernelMaxBytes: number          // 1..6144
  initialContextMaxBytes: number  // 1..32768
  rollingControlMaxBytes: number  // 1..32768
  allowedInjectionKinds: string[] // unique
  untrustedEncoding: 'escaped-xml'
}
ToolDiscoveryPolicy {
  rootHelpRef: 'tm8://help'
  preloadNouns: string[]          // unique
  semanticSearchEnabled: boolean
  semanticMaxMatches: number      // 0..5
  nounShardMaxBytes: number       // 1..32768
  commandShardMaxBytes: number    // 1..32768
  entityContextDefaultBytes: number // 1024..32768
  providerToolRegistrationAllowlist?: OperationName[]  // unique
}
FeedPolicy {
  scope: 'direct_v1' | 'session_chat_v1' | 'channel_threads_v1' | 'thread_v1' | 'task_discussion_v1'
  pageSize: number         // 1..100
  bodyExcerptBytes: number // 0..4096
}
ComposerInteractionPolicy {
  schemaRef: string
  supportsReply: boolean
  supportsAttachments: boolean
  allowedAttachmentKinds: string[]  // unique
  operationBindings: OperationName[] // unique
}
InteractionProfileDraft {
  name: string              // 1..80 chars
  templateKey: string
  templateVersion: number   // positive int
  promptPolicy: ClosedPromptPolicy
  toolDiscoveryPolicy: ToolDiscoveryPolicy
  feedPolicy: FeedPolicy
  providerCaptureMode: 'explicit-only'
  composerPolicy: ComposerInteractionPolicy
  initialContentSurface?: 'terminal' | 'chat'
  contextIndex?: boolean
  contextBudgets?: { memories?, skills?, references?, teammates?: number (0..32768 each) }
  contextFloors?:  { memories?, skills?, references?, teammates?: number (0..3 each) }
}
```
Source (types): `packages/contract/src/contract.ts:6591-6631` (`ClosedPromptPolicy` through
`ComposerInteractionPolicy`), `:6611-6631` (`InteractionProfileDraft`); (schemas):
`packages/contract/src/schemas.ts:4155-4237`. A draft's JSON shape is ALSO re-checked, more
strictly, inside the SQL writer (`internal.w2g12_assert_profile_draft_input`,
`db/migrations/027_w2_entity_kinds_profiles.sql:424-460+`) — every one of the eight top-level
keys is required and no extra key is allowed there either, so a client-side zod pass and a
server-side SQL pass agree independently.

```
InteractionProfileView {
  profileId, spaceId, status: 'draft'|'active'|'retired'
  currentDraftVersion: number
  validatedVersion: number | null;  validatedHash: string | null
  activeVersion: number | null;     activeHash: string | null
  generatedByTeamMemberId: EntityId | null
  retiredAt: string | null
  version: number
  draft: InteractionProfileDraft
  warnings?: ResultWarning[]
}
```
Source: `packages/contract/src/contract.ts:6671-6691`, schema
`packages/contract/src/schemas.ts:4285-4299`. This is the response shape of `propose`,
`updateDraft`, `activate` and `retire`.

## `skills.roots`
`GET /v2/spaces/:spaceId/skills/roots` · kind: read · status: v1 · served: yes
(`packages/server/src/skills/mutations.ts:16-23`)
CLI: none

The authorized filesystem roots a skill scan or a `skills.create` can write into for this
space: linked projects (id + working dir) and authorized home directories.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Response** — `200`; `data`:

| field | type | description |
|---|---|---|
| `projects` | `{ id: string; workingDir: string }[]` | space-linked projects a skill can be authored into |
| `homes` | `string[]` | authorized home directories (always includes the server OS account home; plus each linked project's configured `defaults.homeDir`) |

Example (illustrative, from schema):
```json
{ "data": { "projects": [{ "id": "b1e2...", "workingDir": "/home/tm8/prod-data/worktrees/.../repo" }], "homes": ["/home/tm8"] }, "requestId": "req_00000a" }
```

**Errors** — `forbidden` (403): caller is not a member of the space, or `actorId` is not
one they can act as (`packages/server/src/skills/mutations.ts:88-91`, no `details.reason`,
just a message).

**Notes**: no idempotency (read). The full `SkillRoots` the underlying
`resolveSkillRoots` computes also carries `projectBoundaries`, `codexHomes`, `hermesHomes`,
`claudeManagedDir` (`packages/server/src/skills/discovery.ts:11-20`), but this handler
returns only `projects` and `homes` — the rest is internal to scanning.
Source: catalog `packages/contract/src/catalog.ts:50`; handler
`packages/server/src/skills/mutations.ts:16-23`; roots resolver
`packages/server/src/skills/service.ts:14-33`.

## `skills.create`
`POST /v2/spaces/:spaceId/skills` · kind: command · status: v1 · served: yes
(`packages/server/src/skills/mutations.ts:45-68`)
CLI: `tm8 skill create --root <id-or-path> --name <name> [--provider agents|claude|codex|hermes] [--level project|user] [--description <text-or-@file>] [--body <text-or-@file>] [--mutation-id <id>]`

Writes a new skill file under an authorized root (a linked project's working directory for
`level: 'project'`, or an authorized home directory for `level: 'user'`), then forces a scan
of that root so the new skill's entity mirror exists before the response returns.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `provider` | enum | no | `agents`\|`claude`\|`codex`\|`hermes`, default `agents` | skill file dialect |
| `level` | enum | no | `project`\|`user`, default `project` | which root kind `root` names |
| `root` | string | yes | min 1 | a project id (when `level: 'project'`) or an authorized home path (when `level: 'user'`) |
| `name` | string | yes | min 1 | skill name |
| `description` | string | no | default `''` | |
| `body` | string | no | default `''` | skill markdown body |
| `actorId` | uuid | no | | acting principal |
| `clientMutationId` | string | no | | idempotency key |

Example request:
```
POST /v2/spaces/<spaceId>/skills
{ "level": "project", "provider": "agents", "root": "<projectId>", "name": "deploy-runbook", "description": "How to deploy", "body": "# Deploy\n..." }
```

**Response** — `200`; `data`:

| field | type | description |
|---|---|---|
| `id` | string \| null | the new skill entity's id, looked up by `source_path` after the scan (`null` if the scan somehow didn't record it) |
| `sourcePath` | string | the file path written |
| `scan` | `SkillScanResult` | the forced scan's result — see `skills.scan` |

Example (illustrative, from schema):
```json
{ "data": { "id": "c4a1...", "sourcePath": "/home/.../deploy-runbook/SKILL.md", "scan": { "scannedAt": "2026-09-25T12:00:00.000Z", "discovered": 12, "upserted": 1, "missing": 0, "errors": [] } }, "requestId": "req_00000b" }
```

**Errors**:
- `invalid_input` (400) — body fails the zod schema (`details.issues`); or
  `level: 'project'` with a `provider` other than `agents`/`claude` ("project authoring
  supports agents and claude providers", no `details.reason`).
- `forbidden` (403) — `root` (a project id) is not linked to this space; or, for
  `level: 'user'`, `root` does not resolve to an authorized home directory; or the caller
  fails the same space-membership/act-as check `skills.roots` uses.

**Notes**: idempotent via `clientMutationId` (forwarded to the forced scan's debounce key,
not a ledger replay itself — the write is a filesystem write, not a SQL RPC). No
`expectedVersion` (creation). Side effect: writes a file to disk and forces a skill scan of
the containing root (`force: true`).
Source: catalog `packages/contract/src/catalog.ts:51`; input schema
`packages/server/src/skills/mutations.ts:13`, bound at
`packages/server/src/facade/input-schemas.ts:307`; handler
`packages/server/src/skills/mutations.ts:45-68`.

## `skills.edit`
`PATCH /v2/skills/:id` · kind: command · status: v1 · served: yes
(`packages/server/src/skills/mutations.ts:70-87`)
CLI: `tm8 skill edit <id> --expected-version <n> [--content-hash <hash>] [--name <n>] [--description <text-or-@file>] [--body <text-or-@file>] [--mutation-id <id>]`

Edits a skill. Branches on whether the skill entity has a `sourcePath`: a file-backed skill
is rewritten on disk (subject to a content-hash check and a writable-root/level check) and
the containing root is rescanned; a skill with **no** `sourcePath` (a native/system entity)
is patched directly in the database instead. **The two branches return different response
shapes** (see Response).

**Path params**

| name | type | description |
|---|---|---|
| `id` | uuid | the skill entity id |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `expectedVersion` | number | yes | positive int | optimistic-concurrency guard against the skill entity's current version |
| `contentHash` | string | no | | expected on-disk content hash (file-backed skills only); defaults to the cached `detail.state.contentHash` |
| `name` | string | no | min 1 | |
| `description` | string | no | | |
| `body` | string | no | | |
| `actorId` | uuid | no | | |
| `clientMutationId` | string | no | | |

**Response** — `200`; `data` is one of:
- No `sourcePath` (native/system skill): the raw jsonb of `update_skill_entity`'s
  `internal.command_result(...)` — an entity object built by `to_jsonb(entities row)` merged
  with `content`/`counters` (NOT a full `EntityDetail`), plus `activity` and `patches`. See
  "Shared plumbing" above.
- Has a writable `sourcePath`: a `SkillScanResult` (`scannedAt, discovered, upserted,
  missing, errors, skipped?`) — the rescan of the file's root, exactly like `skills.scan`'s
  response. **No `entity`/`id` field at all** in this branch; the caller re-reads via
  `skills.show` to see the edited fields.

**Errors**:
- `invalid_input` (400) — body fails the schema.
- `not_found` (404) — entity is not a skill.
- `version_conflict` (409) — `detail.version !== input.expectedVersion` (checked before
  authorization or the writable-root check).
- `forbidden` (403) — caller fails space membership/act-as; or the skill's `level` is one
  of `system`, `admin`, `plugin`, `synced`, `session` ("this skill scope is read-only"); or
  the file is no longer found among discovered candidates, or its level is one of the same
  read-only set ("skill is outside writable roots").

**Notes**: idempotency for the no-`sourcePath` branch runs through the SQL ledger
(`operation: 'entities.patch'`, not `'skills.edit'` — the update reuses the generic entity
patch RPC); the file-backed branch has no ledger record (a filesystem write plus a
debounced rescan). `expectedVersion` guards both branches. Side effect (file-backed
branch): rewrites the skill file and forces a rescan.
Source: catalog `packages/contract/src/catalog.ts:52`; input schema
`packages/server/src/skills/mutations.ts:14`; handler
`packages/server/src/skills/mutations.ts:70-87`; native-branch RPC
`db/migrations/017_w2_entities_commands_tracking.sql:248-265`.

## `skills.equip`
`POST /v2/skills/:id/equip` · kind: command · status: v1 · served: yes
(`packages/server/src/skills/mutations.ts:26,43`)
CLI: `tm8 skill equip <id> --teammate <teamMemberId> [--mutation-id <id>]`

Creates an `equips` edge from a `team_member` entity to a `skill` entity, both required to
be live and in the same space. This is what makes the skill part of that teammate's
persona equipment (as opposed to a spawn-task-scoped skill).

**Path params**

| name | type | description |
|---|---|---|
| `id` | uuid | the skill entity id (edge source is resolved server-side; this is the edge target) |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `teamMemberId` | uuid | yes | | the teammate to equip the skill onto |
| `actorId` | uuid | no | | |
| `clientMutationId` | string | no | | |

**Response** — `200`; `data`: the raw jsonb `write_edge` returns — shaped like
`internal.command_result(null, edgeId, activityId, [srcId, dstId], undo?)`:

| field | type | description |
|---|---|---|
| `edge` | raw `public.edges` row (snake_case: `id, src_id, dst_id, type, props, created_at, updated_at, assigned_by, assigned_at`) | the new/updated `equips` edge — see "Shared plumbing" for why this is not a camelCase `EdgeView` |
| `activity` | uuid | the recorded activity id |
| `patches` | `[]` | always empty here |
| `undo` | `{ token, label, expiresAt? }` \| absent | present when `equips` is not `append_only` in `edge_types` |

**Errors**:
- `invalid_input` (400) — body fails schema.
- `not_found` (404) — `id`/`teamMemberId` is not a uuid; or either entity doesn't exist /
  is deleted, isn't the expected kind (`skill` / `team_member`), or the two are in
  different spaces ("skill and teammate must be in the same space").

**Notes**: idempotent via `clientMutationId` through `write_edge`'s
`internal.ledger_replay('edges.create', ...)` (the ledger operation name is `edges.create`,
not `skills.equip`). No `expectedVersion`. Side effect: the equip is what `skills.preview`
and spawn's own loaders read to compute a teammate's effective skill set.
Source: catalog `packages/contract/src/catalog.ts:53`; input schema
`packages/server/src/skills/mutations.ts:12`; handler
`packages/server/src/skills/mutations.ts:26-43`; RPC
`db/migrations/129_task_assignment_provenance.sql:52-83`.

## `skills.unequip`
`POST /v2/skills/:id/unequip` · kind: command · status: v1 · served: yes
(`packages/server/src/skills/mutations.ts:26,44`)
CLI: `tm8 skill unequip <id> --teammate <teamMemberId> [--mutation-id <id>]`

Removes the `equips` edge from a teammate to a skill, if one exists.

**Path params** — same as `skills.equip`.
**Request body** — same shape as `skills.equip` (`SkillEquipInputSchema` is reused for both
operations).

**Response** — `200`; `data`: `{ removed: boolean }` — `true` if an `equips` edge existed
and was deleted, `false` if none existed. **Note**: `delete_edge`'s own RPC result is
discarded; this is a hand-built object, not a `CommandResult`.

**Errors**: same as `skills.equip` (`invalid_input`, `not_found` for the same reasons —
the skill/teammate existence and same-space check runs identically for both operations).

**Notes**: idempotent by nature (a second unequip on an already-unequipped pair returns
`{removed:false}` rather than erroring), so `clientMutationId` here is accepted but not the
mechanism that makes it safe to retry. When an edge IS deleted, `delete_edge`'s own ledger
record uses the `edges.delete` operation name internally (not surfaced in the response).
Source: catalog `packages/contract/src/catalog.ts:54`; handler
`packages/server/src/skills/mutations.ts:26-44`.

## `skills.scan`
`POST /v2/spaces/:spaceId/skills/scan` · kind: command · status: v1 · served: yes
(`packages/server/src/skills/handlers.ts:34-38`)
CLI: `tm8 skill scan [--root <projectId>] [--all] [--mutation-id <id>]`

Forces a filesystem walk of the space's authorized skill roots and upserts/marks-missing
the `skills` rows that mirror what it finds. Debounced per `(spaceId, identityId, actorId,
roots)` key unless `force`, which this handler always passes.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `root` | uuid | no | mutually exclusive with `all` | scan only this project's root |
| `all` | boolean | no | mutually exclusive with `root` | scan every authorized root (default behavior when neither is given is "every authorized root" too — `root`/`all` only narrow or don't change that; see note) |
| `actorId` | uuid | no | | |
| `clientMutationId` | string | no | | |

**Response** — `200`; `data` (`SkillScanResult`):

| field | type | description |
|---|---|---|
| `scannedAt` | ISO string | when this scan ran |
| `discovered` | number | candidate skill files found |
| `upserted` | number | `skills` rows written/refreshed |
| `missing` | number | previously-known references now missing on disk |
| `errors` | `{ path: string; error: string }[]` | per-path scan failures (never turns an unreadable subtree into "missing") |
| `skipped` | boolean (optional) | `true` only when a debounced re-run served a cached result — never true here since this handler always forces |

Example (illustrative, from schema):
```json
{ "data": { "scannedAt": "2026-09-25T12:00:00.000Z", "discovered": 12, "upserted": 2, "missing": 0, "errors": [] }, "requestId": "req_00000c" }
```

**Errors**:
- `invalid_input` (400) — `root` and `all` both given (schema `.refine`); or body fails
  the schema otherwise.
- `forbidden` (403) — not a space member; or, when `actorId` is set, not authorized to
  scan as that actor; or (via `resolveSkillRoots`) `root` names a project not linked to
  this space.

**Notes**: not ledger-idempotent (no SQL RPC wraps the whole scan in
`ledger_replay`/`ledger_record`); safety against duplicate concurrent scans comes from the
in-process `SkillScanDebouncer`, keyed by claims+roots, not from `clientMutationId`. No
`expectedVersion`. Side effect: `upsert_skill_reference` / `mark_skill_references_missing`
RPC calls per discovered/missing file.
Source: catalog `packages/contract/src/catalog.ts:55`; input schema
`packages/server/src/skills/handlers.ts:16`, bound at
`packages/server/src/facade/input-schemas.ts:311`; handler
`packages/server/src/skills/handlers.ts:34-38`; scan engine
`packages/server/src/skills/service.ts:54-65`, `packages/server/src/skills/scanner.ts:11-13,20`.

## `skills.list`
`GET /v2/spaces/:spaceId/skills` · kind: read · status: v1 · served: yes
(`packages/server/src/skills/handlers.ts:39-55`)
CLI: `tm8 skill list [--root <ref>] [--limit <n>] [--cursor <cursor>]`

Paginated list of `skill` entities in a space, oldest-id-first, optionally filtered to one
scan root.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `root` | string | no | | filters to skills whose `public.skills.root_ref` matches (the root reference recorded at scan time — a project id or a home/plugin path, per `skillReferenceMetadata`) |
| `limit` | integer string | no | default 50, max 200 | `invalid_input` if present and not a positive integer |
| `cursor` | opaque string | no | | encodes `[spaceId, lastId]`; `invalid_cursor` if it decodes to the wrong space or shape |

**Response** — `200`; `data`:

| field | type | description |
|---|---|---|
| `items` | `EntitySummary[]` | one row per skill entity (`state.kind === 'skill'`), assembled the same way any entity list assembles summaries |
| `nextCursor` | string \| null | present iff more rows exist past this page |

Example (illustrative, from schema):
```json
{ "data": { "items": [{ "id": "c4a1...", "kind": "skill", "title": "deploy-runbook", "state": { "kind": "skill", "equipped": true, "level": "project", "provider": "agents", "missing": false, "changedOnDisk": false, "frontmatter": {} } }], "nextCursor": null }, "requestId": "req_00000d" }
```

**Errors**: `invalid_cursor` (400) — cursor malformed or names a different space.
`invalid_input` (400) — `limit` present but not a positive integer.

**Notes**: read, no idempotency. No `total` field (unlike the generic `pageOf<T>` helper's
optional `total` — this handler builds the page object by hand without one).
Source: catalog `packages/contract/src/catalog.ts:56`; handler
`packages/server/src/skills/handlers.ts:39-55`; cursor/limit helpers
`packages/server/src/facade/context.ts:127-154`.

## `skills.preview`
`GET /v2/spaces/:spaceId/skills/preview` · kind: read · status: v1 · served: yes
(`packages/server/src/skills/handlers.ts:56-125`)
CLI: none

Computes what a launch would ACTUALLY load into a session's skill index for a given
teammate (and optionally a project/workdir/task set) — the same effective-skills
computation (`computeEffectiveSkills`) a spawn uses, so the launch sheet's preview cannot
drift from spawn's real behavior.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `teamMemberId` | uuid | yes | | the teammate whose equipment to preview |
| `projectId` | uuid | no | must be linked to the space | resolves a working-dir root for path-relative skill discovery |
| `agentTool` | enum | no | `claude-code`\|`codex` | defaults to the teammate's own `agent_tool` |
| `workdir` | string | no | must start with `/` | defaults to the project root or `/` |
| `agentConfigDir` | string | no | must start with `/` | |
| `taskIds` | comma-separated uuid list | no | at most 64 ids, each must be a uuid | the launch's spawn tasks, whose `equips` join the defaults set exactly as spawn joins them |

**Response** — `200`; `data` (`SkillPreviewResult`, extends `EffectiveSkills`):

| field | type | description |
|---|---|---|
| `native` | `SkillIndexEntry[]` | skills loaded natively (provider-native mechanism) |
| `indexed` | `SkillIndexEntry[]` | skills loaded via tm8's own index |
| `skipped` | `SkippedSkill[]` | equipped skills left out, with `reason` (see vocabulary in `skill-reference.ts:41-52`: `missing`, `native-shadowed`, `byte-budget`, `not-selected`, `task-name-collision`, legacy `relevance`) |
| `scannedAt` | string \| null | most recent `lastSeenAt` among the equipped rows |
| `rows` | `SkillPreviewRow[]` | one row per equipped skill (see below) |
| `installedPlugins` | `string[]` (optional) | Claude plugin ids (`<name>@<marketplace>`) a claude-code launch by this caller could load; absent when there's no credential root to read |
| `pluginSkillIds` | `Record<string, string[]>` (optional) | per installed-plugin id, the live plugin-provided skill entity ids |
| `defaultSkillIds` | `string[]` (optional) | the launch's edge-driven skill defaults in spawn order |

`SkillPreviewRow`: `{ entityId, entityVersion?, name, description, provider, level,
sourcePath?, scope: 'native'|'indexed'|'skipped', indexLine: string|null, contentHash?,
missing: boolean, equippedBy: 'persona'|'ancestor', disableModelInvocation: boolean,
allowImplicitInvocation: boolean, reason? }` (`packages/contract/src/skill-reference.ts:62-78`).

**Errors**:
- **Unverified as fully intentional; observed from source**: a malformed query (missing
  `teamMemberId`, a non-uuid, `taskIds` with >64 entries or a non-uuid entry, etc.) throws
  a raw `ZodError` from the handler's inline `.parse()`
  (`packages/server/src/skills/handlers.ts:74`) rather than a `CollabError`, so it surfaces
  as `503 upstream_unavailable` ("internal server error"), not `400 invalid_input`.
- `not_found` (404) — `teamMemberId` doesn't resolve to a live teammate in this space; or
  `projectId` given but not linked to this space.

**Notes**: read, no idempotency, no CLI verb (design 01a0d348 §3.5's F3 composer preview is
a UI-only concern). Side effect: none (pure read plus optional plugin-directory listing).
Source: catalog `packages/contract/src/catalog.ts:57`; handler
`packages/server/src/skills/handlers.ts:56-125`; response type
`packages/contract/src/skill-reference.ts:62-105`.

## `skills.show`
`GET /v2/skills/:id` · kind: read · status: v1 · served: yes
(`packages/server/src/skills/handlers.ts:127-131`)
CLI: `tm8 skill show <id>`

Full entity detail for one skill, via the generic entity-get path (`getEntity`), narrowed
to `kind === 'skill'`.

**Path params**

| name | type | description |
|---|---|---|
| `id` | uuid | the skill entity id |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `header` | string | no | `authored` (default) \| `resolved`; any other value is read as `authored` with a `header_mode_unknown` warning | generic entity-header read mode, shared by every `entities.get`-style read, not skill-specific |

**Response** — `200`; `data`: `EntityDetail` whose `state.kind === 'skill'` (see the
skill-state shape in "Shared plumbing" above), plus a `warnings?: ResultWarning[]` array
when `header` was unrecognized.

**Errors**: `not_found` (404) — entity doesn't exist / is deleted (via `getEntity`), or
exists but is not a skill.

**Notes**: read, no idempotency. `id` that isn't a uuid also answers `not_found` (via
`requireUuidParam`), not `invalid_input`.
Source: catalog `packages/contract/src/catalog.ts:58`; handler
`packages/server/src/skills/handlers.ts:127-131`; shared `getEntity`
`packages/server/src/facade/services/w2/entities-commands-tracking.ts:1317-1326`.

## `launch.suggest`
`POST /v2/spaces/:spaceId/launch/suggest` · kind: command · status: v1 · served: yes
(`packages/server/src/jev/handlers.ts:75-142`)
CLI: none (UI only — no CLI verb, and nothing on the spawn path calls this)

Asks Jev (an LLM advisor) for launch-sheet suggestions across up to four independent
groups (`model`, `teammates`, `memories`, `skills`); each group is its own costed call and
one group failing never blocks another. Classified `command` because it writes cost-tracking
rows (`jev_runs`/`jev_calls`), not because it mutates anything a person would recognize as
data; `requestId` (not `clientMutationId`) is its idempotency key.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `runId` | uuid | yes | | stable id for the whole launch-sheet/popup session |
| `requestId` | uuid | yes | | one per "Ask Jev" press; the idempotency key for THIS call — a retried `requestId` never double-counts a Jev call |
| `subjectId` | uuid | yes | | the entity being launched from |
| `draft` | `{ title: string (max 500); description: string (max 50000) }` | no | | the Run popup's live text, when it differs from the subject's |
| `teamMemberId` | uuid | no | | required for `memories`/`skills` groups — without it those groups are skipped with `no_teammate` |
| `groups` | `('model'\|'teammates'\|'memories'\|'skills')[]` | yes | non-empty, no duplicates | which groups to ask |
| `clientMutationId` | string | no | | transport-only; the handler ignores it (`requestId` is the real idempotency key) |

Example request:
```json
{ "runId": "b0e1...", "requestId": "f3a2...", "subjectId": "9c11...", "teamMemberId": "aa21...", "groups": ["model", "skills"] }
```

**Response** — `200`; `data` (`LaunchSuggestResult`):

| field | type | description |
|---|---|---|
| `runId` | uuid | echoed |
| `groups.model` | `JevGroupResult<ModelSuggestion>` (optional) | present iff `model` was requested |
| `groups.teammates` | `JevGroupResult<TeammateSuggestion>` (optional) | |
| `groups.memories` | `JevGroupResult<EntitySuggestion>` (optional) | |
| `groups.skills` | `JevGroupResult<EntitySuggestion>` (optional) | |
| `run` | `JevCost` | running total for the whole `runId`, including earlier requests |

`JevGroupResult<T>` is a discriminated union on `status`: `{status:'ok', value: T, cost:
JevCost}` \| `{status:'failed', reason: JevFailure, cost: JevCost}` \|
`{status:'skipped', reason: 'no_candidates'|'no_subject_text'|'no_teammate', cost:
JevCost}`. `JevCost = { calls, inputTokens, outputTokens, usd, latencyMs }`.
`ModelSuggestion = { tier: 'economy'|'standard'|'premium'|'frontier', model, agentTool:
'claude-code'|'codex', effort, need: number, workKind, reasons: string[] }`.
`TeammateSuggestion = { items: RankedEntity[], noFit: boolean }`.
`EntitySuggestion = { items: RankedEntity[], considered: number, total: number }`.
`RankedEntity = { entityId, kind: 'memory'|'skill'|'team_member', title, sources:
('teammate'|'inherited'|'task'|'space')[], score: 0..3, level:
'irrelevant'|'background'|'useful'|'critical', suggested: boolean }`.
`JevFailure = 'no_key'|'timeout'|'budget'|'rate_limited'|'overloaded'|'server_error'|
'http_error'|'network'|'unparsed'`.

Example (illustrative, from schema):
```json
{ "data": { "runId": "b0e1...", "groups": { "model": { "status": "ok", "value": { "tier": "standard", "model": "claude-sonnet-5", "agentTool": "claude-code", "effort": "medium", "need": 1.4, "workKind": "bugfix", "reasons": ["..."] }, "cost": { "calls": 1, "inputTokens": 900, "outputTokens": 40, "usd": 0.002, "latencyMs": 640 } } }, "run": { "calls": 1, "inputTokens": 900, "outputTokens": 40, "usd": 0.002, "latencyMs": 640 } }, "requestId": "req_00000e" }
```

**Errors**:
- `invalid_input` (400) — body fails the strict schema (empty/duplicate `groups`, missing
  required fields, oversized `draft` text): `details.issues`.
- `forbidden` (403) — caller is not a space member.
- (No group failure raises an HTTP error — a Jev call failing, or `no_key` when neither the
  caller's own TypeSafe key nor the node's is configured, answers `200` with that group's
  `status: 'failed'|'skipped'`.)

**Notes**: idempotency key is `requestId`, not `clientMutationId` (unusual for this API —
called out explicitly in the type). No `expectedVersion` (nothing here is optimistically
versioned). No pagination. Side effects: one `jev_calls` row per attempted group (including
failures) and an upsert to the `runId`'s running totals; nothing it returns takes effect
until a person applies a suggestion through an ordinary `execution.spawn` field.
Source: catalog `packages/contract/src/catalog.ts:62`; types+schemas
`packages/contract/src/launch-suggest.ts` (types 1-169, schemas 175-269); handler
`packages/server/src/jev/handlers.ts:75-142`; input schema binding
`packages/server/src/facade/input-schemas.ts:313`.

## `launch.defaults`
`GET /v2/spaces/:spaceId/launch/defaults` · kind: read · status: v1 · served: yes
(`packages/server/src/launch/defaults.ts:38-118`)
CLI: none (UI only)

What a launch would load per selection group (`memories`, `skills`, `references`) with
nothing explicitly ticked — computed with spawn's OWN default loaders
(`facade/spawn-defaults.ts`), in the caller's RLS transaction, so what this pre-ticks and
what a subsequent `execution.spawn` actually loads cannot drift apart. Lenient by design: a
missing/malformed/deleted/unreadable teammate or subject yields empty groups plus a
`warnings` line, never a refusal — only authorization refuses.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `teamMemberId` | uuid-shaped string | **no in practice** (the `LaunchDefaultsInput` TS type marks it required, but the handler treats an absent/malformed/unresolvable value leniently with a warning rather than refusing — see Notes) | | the teammate the launch would run as; without a resolvable one, memory/skill defaults are empty |
| `subjectId` | uuid-shaped string | no | | the entity launched from; without a resolvable one (or one with no open task yet), no task-derived defaults are included |

**Response** — `200`; `data` (`LaunchDefaultsResult`):

| field | type | description |
|---|---|---|
| `memories` | `LaunchDefaultsGroup` | |
| `skills` | `LaunchDefaultsGroup` | |
| `references` | `LaunchDefaultsGroup` | |
| `taskId` | string \| null | the subject's resolved open task; `null` if it has none yet (a spawn would mint one) |
| `warnings` | `string[]` | human-readable reasons a group is emptier than asked |

`LaunchDefaultsGroup = { items: LaunchDefaultItem[] /* truncated to
SPAWN_SELECTION_GROUP_LIMIT = 240, spawn order */, total: number /* true count; above
items.length the group can't be sent as an exact set */ }`.
`LaunchDefaultItem = { entityId, kind: string, title: string, via: 'teammate'|'inherited'|
'task'|'linked'|'attached', headerText: string|null, headerSource:
'authored'|'native'|'derived'|null }`.

Example (illustrative, from schema):
```json
{ "data": { "memories": { "items": [], "total": 0 }, "skills": { "items": [{ "entityId": "c4a1...", "kind": "skill", "title": "deploy-runbook", "via": "teammate", "headerText": "How to deploy", "headerSource": "native" }], "total": 1 }, "references": { "items": [], "total": 0 }, "taskId": "9c11...", "warnings": [] }, "requestId": "req_00000f" }
```

**Errors**: `forbidden` (403) — caller is not a member of the space (the ONLY refusal;
everything else about a bad `teamMemberId`/`subjectId` degrades to a warning, per file
header comment "LENIENT (Subhang's rule, 2026-09-25)").

**Notes**: read, no idempotency, no pagination (hard-capped at
`SPAWN_SELECTION_GROUP_LIMIT` instead). `SPAWN_SELECTION_GROUP_LIMIT = 240`
(`packages/contract/src/contract.ts:4708`). No auth beyond space membership. The contract's
`LaunchDefaultsInput` interface (`packages/contract/src/launch-defaults.ts:54-59`) declares
`teamMemberId` as required — this is the one place in this file where the interface and the
handler's actual runtime behavior verifiably diverge; the handler reads it as
`ctx.query.get('teamMemberId')?.trim() ?? ''` and treats empty/malformed/unresolvable the
same as any other lenient miss (`packages/server/src/launch/defaults.ts:43,54-67`).
Source: catalog `packages/contract/src/catalog.ts:66`; types
`packages/contract/src/launch-defaults.ts:32-69`; handler
`packages/server/src/launch/defaults.ts:38-118`.

## `interactionProfiles.propose`
`POST /v2/spaces/:spaceId/interaction-profiles` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:252-265`)
CLI: `tm8 interaction-profile propose --data <json-source>`

Creates a new Interaction Profile entity in `draft` status with draft version 1. The
proposer must be a `team_member` (which becomes `generatedByTeamMemberId`) or a
space owner/admin `member` (which leaves it `null`).

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space (must match `body.spaceId`) |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | idempotency key |
| `spaceId` | uuid | yes | must equal the path `spaceId` | |
| `draft` | `InteractionProfileDraft` | yes | see shared types above; SQL also re-checks the exact key set | the initial draft |

Example request (via CLI): `tm8 interaction-profile propose --data @profile.json` with
`profile.json` containing `{"draft": {"name": "...", "templateKey": "...", ...}}` (the CLI
adds `spaceId` and `clientMutationId` itself).

**Response** — `200`; `data`: `InteractionProfileView` (see shared types) — a fresh draft
with `status: 'draft'`, `currentDraftVersion: 1`, `validatedVersion/activeVersion: null`.
May carry `warnings: [{ code: 'context_budgets_over_ceiling', message }]` when the draft's
`contextBudgets` exceed the initial-context ceiling beside the frame baseline — saved
anyway; a launch trims and records every drop
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:58-67`).

**Errors**:
- `invalid_input` (400) — body fails the local `parseInput` check, message is the FIRST
  zod issue only (no `details.issues`); or `body.spaceId !== pathSpaceId`; or (from SQL,
  code `22023`→`invalid_input`) the draft's JSON shape fails
  `internal.w2g12_assert_profile_draft_input` (wrong/missing/extra top-level keys, `name`
  not 1-80 chars, empty `templateKey`, non-positive `templateVersion`).
- `forbidden` (403) — caller is neither a `team_member` nor an owner/admin `member`
  (`db/migrations/027_w2_entity_kinds_profiles.sql:844-855`).
- `invariant_violation` (409) with `details.reason: 'profile_capture_mode_reserved'` —
  `providerCaptureMode` is anything but `'explicit-only'` (frozen for Phase 1).
- `upstream_unavailable` (503) — the SQL RPC's returned jsonb fails
  `InteractionProfileViewSchema` ("violates the frozen contract") — an internal-consistency
  guard, not expected in normal operation.

**Notes**: idempotent via `clientMutationId` through `internal.ledger_replay(cmid,
'interactionProfiles.propose')`. No `expectedVersion` (creation). No pagination. Auth: any
space member who is a teammate, OR a human owner/admin. Side effect: an `interaction_profile`
entity plus its version-1 row; records a `created` activity.
Source: catalog `packages/contract/src/catalog.ts:333`; input type/schema
`packages/contract/src/contract.ts:6636-6640`, `packages/contract/src/schemas.ts:4238-4242`;
handler `packages/server/src/facade/services/w2/entity-kinds-profiles.ts:252-265`; RPC
`db/migrations/027_w2_entity_kinds_profiles.sql:826-866`.

## `interactionProfiles.updateDraft`
`PATCH /v2/interaction-profiles/:profileId/draft` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:267-280`)
CLI: `tm8 interaction-profile update <profileId> --expect-version <n> --data <json-source>`

Appends a new draft version (`currentDraftVersion + 1`) to an existing profile.

**Path params**

| name | type | description |
|---|---|---|
| `profileId` | uuid | the Interaction Profile entity id |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | number | yes | positive int | optimistic guard on the profile ENTITY's version (not the draft version) |
| `draft` | `InteractionProfileDraft` | yes | | the new draft body |

**Response** — `200`; `data`: `InteractionProfileView` with `currentDraftVersion`
incremented; same `warnings` mechanism as `propose`.

**Errors**:
- `invalid_input` (400) — same as `propose`'s draft-shape checks.
- `not_found` (404) — profile entity doesn't exist / is deleted (from `assert_version`'s
  `P0002`, or the authorization lookup).
- `invariant_violation` (409) with `details.reason: 'profile_retired'` — profile status is
  `retired`.
- `version_conflict` (409) — `expectedVersion` doesn't match the entity's current version;
  the comment in source notes this check runs AFTER route-entity authorization
  deliberately: an unauthorized caller learning "a profile exists at version N" from a
  `version_conflict` is considered acceptable, versus running version-check first and
  leaking existence to someone who never should have resolved the id.
- `forbidden` (403) — caller is a `team_member` other than the one that proposed it, or a
  `member` who isn't owner/admin.

**Notes**: idempotent via `clientMutationId` (`ledger_replay('interactionProfiles.updateDraft', ...)`).
`expectedVersion` is required (guards the ENTITY row, which is bumped on every draft/validate/
activate/retire transition via `internal.w2g12_advance_profile_entity`). Side effect: records
an `updated` activity.
Source: catalog `packages/contract/src/catalog.ts:334`; input type/schema
`packages/contract/src/contract.ts:6641-6645`, `packages/contract/src/schemas.ts:4244-4248`;
handler `packages/server/src/facade/services/w2/entity-kinds-profiles.ts:267-280`; RPC
`db/migrations/027_w2_entity_kinds_profiles.sql:873-905`.

## `interactionProfiles.validate`
`POST /v2/interaction-profiles/:profileId/validate` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:282-293`)
CLI: `tm8 interaction-profile validate <profileId> --expect-version <n>`

Validates the profile's CURRENT draft version (idempotent per version: re-validating an
already-validated version returns the cached verdict rather than recomputing).

**Path params**

| name | type | description |
|---|---|---|
| `profileId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | number | yes | positive int | guards the profile entity's version |

**Response** — `200`; `data` (`ProfileValidationView`):

| field | type | description |
|---|---|---|
| `profileId` | uuid | |
| `profileVersion` | number | the draft version that was validated |
| `status` | `'valid'` \| `'invalid'` | |
| `validatedHash` | string \| null | non-null iff `status === 'valid'` |
| `issues` | `ProfileValidationIssue[]` (`{ path, code, message }`) | validation findings; empty when valid |

Example (illustrative, from schema):
```json
{ "data": { "profileId": "d5f2...", "profileVersion": 2, "status": "valid", "validatedHash": "sha256:ab12...", "issues": [] }, "requestId": "req_000010" }
```

**Errors**: `invalid_input`, `not_found`, `invariant_violation` (`profile_retired`),
`version_conflict`, `forbidden` — same causes as `updateDraft` (this RPC calls the same
`w2g12_authorize_profile_draft` + `assert_version` pair); additionally `not_found` (404) if
the current-draft version row is somehow missing (`P0002`, "Interaction Profile version not
found" — an internal-consistency case).

**Notes**: idempotent both ways — `clientMutationId` via the ledger, AND re-validating an
unchanged current draft version returns the stored verdict without recomputation (checked
by `version_row.validation_status = 'unvalidated'`). `validatedHash` is what
`interactionProfiles.activate` must be given verbatim, together with the version number, to
activate — NOT an optimistic guard on the latest draft (CLI file header, rule 1). Side
effect: records an `updated` activity when validation actually runs.
Source: catalog `packages/contract/src/catalog.ts:335`; input type/schema
`packages/contract/src/contract.ts:6646`, `packages/contract/src/schemas.ts:4250-4253`;
response type/schema `packages/contract/src/contract.ts:6693-6705`,
`packages/contract/src/schemas.ts:4301-4313`; handler
`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:282-293`; RPC
`db/migrations/027_w2_entity_kinds_profiles.sql:910-963`.

## `interactionProfiles.preview`
`POST /v2/interaction-profiles/:profileId/preview` · kind: read · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:295-306`)
CLI: `tm8 interaction-profile preview <profileId> --version <n>`

A sanitized, non-interactive projection of one profile VERSION — no prompt policy, tool
discovery policy or capture mode, because this is meant to be shown to a person deciding
whether to activate it, not fed to a session. POST because the CLI/`--version` flag
disambiguation forced it (see CLI file header comment on the historical `--version` bug),
but it is a pure read: no `clientMutationId`, no ledger, no write.

**Path params**

| name | type | description |
|---|---|---|
| `profileId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `profileVersion` | number | yes | positive int | the draft version to preview |

**Response** — `200`; `data` (`InteractionProfilePreview`):

| field | type | description |
|---|---|---|
| `profileId` | uuid | |
| `profileVersion` | number | |
| `name` | string | |
| `templateKey` | string | |
| `templateVersion` | number | |
| `feedPolicy` | `FeedPolicy` | |
| `composerPolicy` | `ComposerInteractionPolicy` | |
| `validatedHash` | string \| null | hash of that version if it has been validated, else `null` |
| `generatedByTeamMemberId` | uuid \| null | |

**Errors**: `not_found` (404) — profile doesn't exist/is deleted/isn't readable
(`internal.entity_readable`); or that `profileVersion` doesn't exist for this profile.
`invalid_input` (400) — body fails the local `parseInput` check (missing/non-positive
`profileVersion`).

**Notes**: read — no idempotency, no `expectedVersion`. Auth is whatever
`internal.entity_readable` grants (RLS-level readability), not the propose/updateDraft
teammate-or-admin gate. This is the ONE of the six `interactionProfiles.*` operations whose
underlying SQL function is `language ... stable` (a genuine read, not `security definer`
write semantics like the others, though it IS still `security definer` for RLS-bypass
purposes — see source comment "POST read by catalog classification: no cmid, no ledger, no
event and no write").
Source: catalog `packages/contract/src/catalog.ts:336`; input type/schema
`packages/contract/src/contract.ts:6647`, `packages/contract/src/schemas.ts:4255-4257`;
response type/schema `packages/contract/src/contract.ts:6708-6719`,
`packages/contract/src/schemas.ts:4315-4325`; handler
`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:295-306`; RPC
`db/migrations/027_w2_entity_kinds_profiles.sql:966-994`.

## `interactionProfiles.activate`
`POST /v2/interaction-profiles/:profileId/activate` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:308-318`)
CLI: `tm8 interaction-profile activate <profileId> --validated-version <n> --validation-hash <hash> --yes`

Activates one EXACT validated artifact (version + hash together), never "the latest
draft" — this is a deliberate anti-drift design (CLI file header rule 1): a draft edited
after validation cannot be activated under a hash describing different bytes.

**Path params**

| name | type | description |
|---|---|---|
| `profileId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `validatedVersion` | number | yes | positive int | the exact draft version that was validated |
| `validatedHash` | string | yes | min 1 | must equal that version's recorded `validated_hash` exactly |
| `confirm` | `true` | yes | literal `true` | explicit confirmation (§7.5: no destructive/irreversible step is inferred) |

**Response** — `200`; `data`: `InteractionProfileView` with `status: 'active'`,
`activeVersion`/`activeHash` set to the given version/hash.

**Errors**:
- `invalid_input` (400) — body fails schema; or (SQL, code `22023`) `confirm` is falsy
  ("activation confirmation required" — no `details.reason`, this one is not in the
  frozen-reasons set).
- `not_found` (404) — profile doesn't exist/deleted.
- `forbidden` (403) with `details.reason: 'profile_principal_required'` — caller is not an
  authenticated human Member owner/admin (an agent token, or an `--as` selecting a
  different actor, is refused CLIENT-SIDE by the CLI before the request is even sent — see
  `requireHumanPrincipal` in `interaction-profile.ts:68-79` — and again server-side by
  `internal.require_human_space_admin`).
- `invariant_violation` (409) with `details.reason: 'profile_retired'` — profile is
  retired.
- `invariant_violation` (409) with `details.reason: 'profile_not_validated'` — no version
  row matches `(validatedVersion, validatedHash)` with `validation_status = 'valid'`.

**Notes**: idempotent via `clientMutationId`. No optimistic `expectedVersion` on this one —
identity is carried by `validatedVersion`+`validatedHash` instead, which the CLI's own
header comment calls out as NOT an optimistic guard on the latest draft. Auth: human Member
owner/admin ONLY — `ActivateInteractionProfileInput` is `.strict()` and declares no
`actorId`, so the DTO itself cannot carry a different acting identity. Side effects: flips
`status`/`activeVersion`/`activeHash` (only if they actually changed — re-activating the
same version/hash is a no-op past the ledger check) and emits an
`interaction_profile.activated` workspace event carrying a `structuredDiff`.
Source: catalog `packages/contract/src/catalog.ts:337`; input type/schema
`packages/contract/src/contract.ts:6648-6653`, `packages/contract/src/schemas.ts:4259-4265`;
handler `packages/server/src/facade/services/w2/entity-kinds-profiles.ts:308-318`; RPC
`db/migrations/027_w2_entity_kinds_profiles.sql:996-1055`; human-principal gate
`db/migrations/015_w1_foundations.sql:1145-1166`.

## `interactionProfiles.retire`
`POST /v2/interaction-profiles/:profileId/retire` · kind: command · status: v1 · served: yes
(`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:320-330`)
CLI: `tm8 interaction-profile retire <profileId> --expect-version <n> --yes`

Permanently retires a profile (`status: 'retired'`, `retiredAt` set). Refuses while any
space or teammate still names this profile as its default.

**Path params**

| name | type | description |
|---|---|---|
| `profileId` | uuid | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 | |
| `expectedVersion` | number | yes | positive int | guards the profile entity's version — REQUIRED, derived from runtime introspection of the frozen zod schema per the CLI file header (rule 4), not invented by the CLI |
| `confirm` | `true` | yes | literal `true` | |

**Response** — `200`; `data`: `InteractionProfileView` with `status: 'retired'`,
`retiredAt` set.

**Errors**:
- `invalid_input` (400) — body fails schema; or `confirm` falsy (`22023`, "retirement
  confirmation required").
- `not_found` (404) — profile doesn't exist/deleted.
- `forbidden` (403) with `details.reason: 'profile_principal_required'` — same human
  owner/admin gate as `activate` (client- and server-side).
- `version_conflict` (409) — `expectedVersion` mismatch.
- `invariant_violation` (409) with `details.reason: 'profile_retired'` — already retired.
- `conflict` (409) with `details.reason: 'profile_referenced_default'` — this profile is
  still a space's or a teammate's default (checked against `public.spaces
  .default_interaction_profile_id` and `defaults_to_profile` edges). This is the ONE
  frozen reason whose code is remapped: its SQLSTATE (`23514`) would otherwise map to
  `invariant_violation`, but the seam's `REASON_CODE_OVERRIDE` forces `conflict`
  (`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:137-139`, `:161`).

**Notes**: idempotent via `clientMutationId`. `expectedVersion` required (same reasoning as
`updateDraft`). Auth: human Member owner/admin only, same as `activate`. Side effects: sets
`status`/`retiredAt`, records a `deleted`-kind activity, and emits an
`interaction_profile.retired` workspace event.
Source: catalog `packages/contract/src/catalog.ts:338`; input type/schema
`packages/contract/src/contract.ts:6654-6658`, `packages/contract/src/schemas.ts:4266-4271`;
handler `packages/server/src/facade/services/w2/entity-kinds-profiles.ts:320-330`; RPC
`db/migrations/027_w2_entity_kinds_profiles.sql:1058-1097`; error normalization
`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:128-167`.
