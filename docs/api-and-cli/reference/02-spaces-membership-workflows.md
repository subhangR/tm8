# Spaces: members, invites, task axes, workflows

This group covers the membership and configuration surface of a Space: who belongs
and at what role (`spaces.members.*`), how new members join (`spaces.invites.*`),
the space-scoped `type` axis vocabulary used to narrow the legacy work-status
enum (`spaces.taskAxes.*`, `spaces.taskWorkflows.*`), and the newer open,
user-named workflow states/transitions that supersede the task-workflow
vocabulary (`spaces.workflows.*`). All 16 operations are HTTP-bound under
`/v2/spaces/:spaceId/...` (plus two path-shortened exceptions,
`spaces.invites.redeem` at `/v2/invites/redeem` and `spaces.invites.revoke` at
a nested `/revoke` action route), are all `status: v1`, and are all served.

Every command in this family takes the standard command envelope
(`clientMutationId` required, `actorId` optional) and every command RPC is
backed by a Postgres `SECURITY DEFINER` function that re-validates
authorization and invariants itself — the facade handler validates shape and
binds claims, but authorization decisions and idempotency (`command_ledger`)
live in SQL.

## Operations summary

| name | method | path | kind | served |
|---|---|---|---|---|
| `spaces.members.list` | GET | `/v2/spaces/:spaceId/members` | read | yes |
| `spaces.members.updateRole` | PATCH | `/v2/spaces/:spaceId/members/:memberId` | command | yes |
| `spaces.invites.list` | GET | `/v2/spaces/:spaceId/invites` | read | yes |
| `spaces.invites.create` | POST | `/v2/spaces/:spaceId/invites` | command | yes |
| `spaces.invites.revoke` | POST | `/v2/spaces/:spaceId/invites/:inviteId/revoke` | command | yes |
| `spaces.invites.redeem` | POST | `/v2/invites/redeem` | command | yes |
| `spaces.taskAxes.list` | GET | `/v2/spaces/:spaceId/task-axes` | read | yes |
| `spaces.taskAxes.create` | POST | `/v2/spaces/:spaceId/task-axes` | command | yes |
| `spaces.taskAxes.update` | PATCH | `/v2/spaces/:spaceId/task-axes/:axisId` | command | yes |
| `spaces.taskAxes.delete` | DELETE | `/v2/spaces/:spaceId/task-axes/:axisId` | command | yes |
| `spaces.taskWorkflows.list` | GET | `/v2/spaces/:spaceId/task-workflows` | read | yes |
| `spaces.taskWorkflows.upsert` | POST | `/v2/spaces/:spaceId/task-workflows` | command | yes |
| `spaces.taskWorkflows.delete` | DELETE | `/v2/spaces/:spaceId/task-workflows/:workflowId` | command | yes |
| `spaces.workflows.list` | GET | `/v2/spaces/:spaceId/workflows` | read | yes |
| `spaces.workflows.upsert` | POST | `/v2/spaces/:spaceId/workflows` | command | yes |
| `spaces.workflows.delete` | DELETE | `/v2/spaces/:spaceId/workflows/:workflowId` | command | yes |

Source (catalog rows): `packages/contract/src/catalog.ts:82-105`.

## Shared types

All defined in `packages/contract/src/contract.ts` unless noted.

**`ActorSummary`** (contract.ts:107-130) — `{ id, kind: 'member'|'team_member'|'work_session', displayName, avatar?, role?, ownerMemberId?, isAgent, via?: { sessionId } }`.

**`SpaceMemberRole`** (contract.ts:2987) — `'owner' | 'admin' | 'member'`.

**`WorkStatus`** (contract.ts:80-81) — `'open'|'pulled'|'working'|'in_review'|'done'|'blocked'|'cancelled'` (the seven legacy statuses).

**`StatusCategory`** (contract.ts:103) — `'to_do'|'in_progress'|'done'|'cancelled'` (the four closed workflow-state categories).

**Member row** — `{ actor: ActorSummary, role: SpaceMemberRole, joinedAt: string }` (`SpaceSettings['members'][number]`, contract.ts:3598). Returned bare (as an array) by `spaces.members.list`.

**Invite row** — `{ id: string, code: string, role: 'admin'|'member', maxUses: number, uses: number, expiresAt: string|null, revoked: boolean }` (`SpaceSettings['invites'][number]`, contract.ts:3600). Returned bare (as an array) by `spaces.invites.list`, and as the `data` of `spaces.invites.create` / `spaces.invites.revoke`. The invite `code` is the live bearer credential; it is stripped before being written to `command_ledger` ("strip at rest", `db/migrations/032_w2_sec1_stage1b_replay_resource_binding.sql`) so a replayed create/revoke response is rehydrated from the live row rather than a stored blob.

**`TaskAxis`** (contract.ts:3501-3508) — `{ id, spaceId, name, axisValues: string[], kind: 'default'|'manual', position: number }`.

**`TaskWorkflow`** (contract.ts:3522-3528) — `{ id, spaceId, typeValue: string, statuses: WorkStatus[] }`. One row per `(space, type value)`; `statuses` is the subset of the seven `WorkStatus` values tasks of that type may be moved to. `{open, working, done}` are structural and always present (enforced by a table check constraint, not re-validated by the RPC beyond uniqueness).

**`Workflow`** (contract.ts:3539-3553) — `{ id, spaceId: string|null, name, kind: string|null, states: WorkflowState[], transitions: WorkflowTransition[] }`. `spaceId: null` + `kind: null` identifies the one built-in default workflow (not editable). Supersedes `TaskWorkflow` but does not replace it in v1 — `spaces.taskWorkflows.*` stays live.

**`WorkflowState`** (contract.ts:3555-3565) — `{ id, workflowId, name, category: StatusCategory, position: number, isInitial: boolean, isDefault: boolean }`.

**`WorkflowTransition`** (contract.ts:3567-3578) — `{ id, workflowId, fromStateId: string|null, toStateId, conditions: Record<string, unknown> }`. `fromStateId: null` means "any source state".

**Command envelope** (`CommandContext`, contract.ts:1697-1705) — every command body may carry `actorId?`, `clientMutationId`, `workSessionId?`. Handlers in this family enforce `clientMutationId` as required at runtime (`requireMutationId` in `packages/server/src/facade/services/w2/identity-spaces.ts:199-205`) even though the shared Zod shape (`commandContextShape`, `packages/contract/src/schemas.ts:1662-1666`) types it optional — the schemas re-used here (`TaskAxisInputSchema`, `TaskWorkflowInputSchema`, `WorkflowInputSchema`) spread that shape and don't re-narrow it. `RequiredCommandContextSchema` (`packages/server/src/facade/input-schemas.ts:154-157`) is `.strict()` and does declare `clientMutationId` as required at the schema level; it's used for `taskAxes.delete`, `taskWorkflows.delete`, `workflows.delete`, `invites.revoke`.

**Errors — shared across this family.** SQLSTATE decides the wire code (never message text), mapped in `packages/server/src/http/errors.ts:37-67`:

| SQLSTATE | code | HTTP | typical source in this family |
|---|---|---|---|
| `42501` | `forbidden` | 403 | `internal.require_space_member` / `require_space_admin` refusal; owner-only role rules; revoked/expired invite |
| `P0002` | `not_found` | 404 | row not found under the (space, id) predicate |
| `22023` | `invalid_input` | 400 | vocabulary/shape checks raised in the RPC body |
| `23514` | `invariant_violation` | 409 | check-constraint-shaped business rules (e.g. "cannot rename an axis still in use") |
| `23503`/`23505` | `invariant_violation` | 409 | FK/unique violations (e.g. deleting a workflow state still occupied by an entity) |
| `53400` | `limit_exceeded` | 429 | invite exhausted (`use_count >= max_uses`) |
| unmapped | `upstream_unavailable` | 503 | any other database error, sqlstate preserved in `details.sqlstate` |

`unauthenticated` (401) is raised in TypeScript, before any SQL call, by `claimsFor`/`viewerIdentityOf` when the caller has no resolved identity.

---

### `spaces.members.list`
`GET /v2/spaces/:spaceId/members` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/identity-spaces.ts:532`)
CLI: `tm8 space member list [<space-id>]`

Lists every member of a space (actor, role, join time), ordered by `joinedAt asc, entity_id asc`.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |

**Query params** — accepted by the CLI (`--limit`, `--cursor`) but **not read** by the handler (`spacesMembersList`, identity-spaces.ts:532-540, never touches `ctx.query`); the full member list is always returned, unpaginated. `unverified: whether this is deliberate or a gap — no code comment addresses it.`

**Response** — 200; `data` is a bare array of member rows (no envelope object, no cursor):

| field | type | description |
|---|---|---|
| `actor` | ActorSummary | |
| `role` | SpaceMemberRole | |
| `joinedAt` | string (ISO) | |

```json
{ "data": [
  { "actor": { "id": "<redacted>", "kind": "member", "displayName": "Ada", "isAgent": false }, "role": "owner", "joinedAt": "2026-08-01T00:00:00.000Z" }
], "requestId": "req_000123" }
```
(illustrative, from schema)

**Errors** — `unauthenticated` (401) no identity; `forbidden` (403) caller is not a member of the space.
**Notes** — read; no idempotency key. Requires plain membership (`requireMembership(q, spaceId, claims)`, not admin).
Source: catalog `catalog.ts:82`; handler `identity-spaces.ts:532-540`; `loadMembers` at `identity-spaces.ts:351-365`.

---

### `spaces.members.updateRole`
`PATCH /v2/spaces/:spaceId/members/:memberId` · kind: command · status: v1 · served: yes (`identity-spaces.ts:597`)
CLI: `tm8 space member role <member-id> --role <owner|admin|member> --yes`

Changes a member's space role. The subject is the path pair `(spaceId, memberId)`; every rule (admin required, owner-only for granting/revoking owner, last-owner floor) is enforced in SQL (`public.set_member_role`, `db/migrations/118_member_roles_and_invite_roles.sql:243-335`), not in the handler.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | uuid | the space |
| `memberId` | uuid | the member's entity id |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes (enforced by handler) | non-empty | idempotency key |
| `actorId` | uuid | no | | acting-as persona |
| `role` | string | yes | one of `owner`\|`admin`\|`member` | the new role |

Example request:
```json
PATCH /v2/spaces/{spaceId}/members/{memberId}
{ "clientMutationId": "c-1", "role": "admin" }
```

**Response** — 200; `data` is the generic command-result envelope (`CommandResult`, contract.ts:1687-1694) built by SQL's `internal.command_result`: `{ entity, activity, patches }` with nulls stripped. Here `entity` is the member's underlying entity (`command_entity(p_member_id)`) and `activity` is the raised activity-feed id. If the target already has the requested role, the call is a no-op that still returns this shape (idempotent-on-settled-state) rather than raising.

| field | type | description |
|---|---|---|
| `entity` | EntityDetail (`unverified: exact shape of command_entity` output not traced further) | the member row projected as an entity |
| `activity` | string (uuid) | the raised activity id, when a change happened |
| `patches` | EntitySummary[] | `[memberId]` |

**Errors** — `forbidden` (403): not a space admin (R1); only an owner may grant/revoke `owner` (R2); "a space must keep at least one owner" when demoting the last owner (R3). `not_found` (404): member not found in this space. `invalid_input` (400): `role` not one of the three values.
**Notes** — idempotent via `clientMutationId` + subject-bound replay (space id). Notifies the affected member (`role.changed`) unless they are also the actor.
Source: catalog `catalog.ts:83`; input schema `UpdateMemberRoleInputSchema` (`packages/contract/src/schemas.ts:2739-2742`); handler `identity-spaces.ts:597-614`; RPC `db/migrations/118_member_roles_and_invite_roles.sql:243-340`.

---

### `spaces.invites.list`
`GET /v2/spaces/:spaceId/invites` · kind: read · status: v1 · served: yes (`identity-spaces.ts:542`)
CLI: `tm8 space invite list [<space-id>]`

Lists invites created for a space, most recent first, **including live codes** — admin-only.

**Path params** — `spaceId` (uuid).
**Query params** — same as `spaces.members.list`: CLI sends `--limit`/`--cursor`, handler ignores them; full list returned.

**Response** — 200; bare array of invite rows:

| field | type | description |
|---|---|---|
| `id` | uuid | |
| `code` | string | the live bearer credential |
| `role` | `'admin'`\|`'member'` | role granted on redemption |
| `maxUses` | number | |
| `uses` | number | `use_count` |
| `expiresAt` | string\|null | ISO |
| `revoked` | boolean | `revoked_at is not null` |

```json
{ "data": [
  { "id": "<redacted>", "code": "<redacted>", "role": "member", "maxUses": 1, "uses": 0, "expiresAt": null, "revoked": false }
], "requestId": "req_000124" }
```
(illustrative, from schema — codes are credential material and were not captured live)

**Errors** — `unauthenticated` (401); `forbidden` (403) space **admin** required (`requireMembership(q, spaceId, claims, 'admin')`), stricter than every other `list` op in this family.
**Notes** — read, no idempotency key. Response carries credential material (`code`); the CLI (`noteCredentialDisclosure`) surfaces a warning to the operator.
Source: catalog `catalog.ts:84`; handler `identity-spaces.ts:542-550`; `loadInvites` at `identity-spaces.ts:367-376`.

---

### `spaces.invites.create`
`POST /v2/spaces/:spaceId/invites` · kind: command · status: v1 · served: yes (`identity-spaces.ts:552`)
CLI: `tm8 space invite create [<space-id>] [--max-uses N] [--expires-at <iso|none>] [--role admin|member]`

Mints a new invite code for a space. Space-admin only.

**Path params** — `spaceId` (uuid).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | non-empty | idempotency key |
| `actorId` | uuid | no | | acting-as persona |
| `maxUses` | integer | no | positive integer; default `1` | redemption limit |
| `expiresAt` | string\|null | no | ISO timestamp or `null`; default `null` | expiry |
| `role` | string | no | `'admin'`\|`'member'`; default `'member'` | role redemption confers — **never `'owner'`** (R4: a forwarded link cannot mint an owner) |

Body is `.strict()` at both the Zod layer (`InviteCreateInputSchema`) and the handler (`assertStrictKeys`) — an unknown field is a 400.

Example request:
```json
POST /v2/spaces/{spaceId}/invites
{ "clientMutationId": "c-2", "maxUses": 5, "role": "admin" }
```

**Response** — 201; `data` is an invite row (see `spaces.invites.list` shape) including the live `code`.
```json
{ "data": { "id": "<redacted>", "code": "<redacted>", "role": "admin", "maxUses": 5, "uses": 0, "expiresAt": null, "revoked": false }, "requestId": "req_000125" }
```
(illustrative, from schema)

**Errors** — `invalid_input` (400): `maxUses` not a positive integer; `expiresAt` not a valid ISO timestamp or null; `role` not `'admin'`/`'member'` (both a TS-side 400 and, redundantly, a SQL 22023 "an invite may confer admin or member, not %" if reached another way). `forbidden` (403): not a space admin.
**Notes** — idempotent; replay is bound to the addressed space (a cross-space replay of the same `clientMutationId` is refused, not silently served — this closed a documented invite-code leak, `db/migrations/032_w2_sec1_stage1b_replay_resource_binding.sql`). The live code is stripped before being written to `command_ledger` ("strip at rest") and the replay path rehydrates from the live row.
Source: catalog `catalog.ts:85`; schema `InviteCreateInputSchema` (`packages/server/src/facade/input-schemas.ts:159-169`); handler `identity-spaces.ts:552-582`; RPC `public.create_invite` (`db/migrations/118_member_roles_and_invite_roles.sql:120-172`).

---

### `spaces.invites.revoke`
`POST /v2/spaces/:spaceId/invites/:inviteId/revoke` · kind: command · status: v1 · served: yes (`identity-spaces.ts:616`)
CLI: `tm8 space invite revoke <invite-id> --yes`

Revokes an invite (sets `revoked_at`), refusing further redemption. Idempotent: revoking an already-revoked invite just returns it unchanged (`coalesce(revoked_at, now())`).

**Path params** — `spaceId` (uuid), `inviteId` (uuid) — both are asserted in one predicate, so an invite id from another space answers `not_found`, not a cross-space update.

**Request body** — `RequiredCommandContextSchema`: `clientMutationId` (required), `actorId` (optional); `.strict()`.

**Response** — 200; `data` is the updated invite row (see `spaces.invites.list` shape).

**Errors** — `forbidden` (403) not a space admin; `not_found` (404) no such invite in this space.
**Notes** — idempotent, replay bound to both the invite id and the space id (two independent confusion axes). Code is stripped from the ledger and rehydrated on replay, same as `invites.create`.
Source: catalog `catalog.ts:86`; handler `identity-spaces.ts:616-630`; RPC `public.w2_revoke_invite` (`db/migrations/032_w2_sec1_stage1b_replay_resource_binding.sql:477-533`, superseding `016_w2_identity_spaces.sql:330`).

---

### `spaces.invites.redeem`
`POST /v2/invites/redeem` · kind: command · status: v1 · served: yes (`identity-spaces.ts:632`)
CLI: `tm8 space invite redeem <code>`

Redeems a code as the **current caller** (not an acted-as persona — see Notes), attaching membership at the role the invite carries. No `spaceId` path param: the space is resolved from the code itself.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | non-empty | idempotency key |
| `actorId` | uuid | no | accepted by schema, but ignored — see Notes | |
| `code` | string | yes | non-empty | the invite code |

**Response** — 200; `data`:

| field | type | description |
|---|---|---|
| `spaceId` | uuid | the space joined |
| `memberId` | uuid | the caller's (possibly pre-existing) member entity id |
| `joined` | boolean | `true` if this call created the membership; `false` if the caller was already a member (no re-role on replay of an existing membership) |
| `patches` | EntitySummary[] | `[command_entity(memberId)]` |

**Errors** — `not_found` (404) no invite with this code. `forbidden` (403): invite revoked, or expired (`expires_at < now()`). `limit_exceeded` (429): invite exhausted (`use_count >= max_uses`), SQLSTATE `53400`. `unauthenticated` (401) no identity.
**Notes** — idempotent, replay bound to the space the code addresses. The handler deliberately builds claims **without** the request's `actorId` (`claimsFor(owner, ctx, { clientMutationId })`, identity-spaces.ts:643) — "redeeming creates the caller's human membership... acting as a persona from another Space is neither an authorization input nor honest audit attribution for this identity-level transition" — so a supplied `actorId` has no effect on this op even though the schema admits it.
Source: catalog `catalog.ts:87`; schema `InviteRedeemInputSchema` (`packages/server/src/facade/input-schemas.ts:171-175`); handler `identity-spaces.ts:632-647`; RPC `public.redeem_invite` (`db/migrations/118_member_roles_and_invite_roles.sql:187-238`, superseding `031_w2_sec1_replay_principal_resource_binding.sql:499` and `007_rpc_catalog.sql:617`).

---

### `spaces.taskAxes.list`
`GET /v2/spaces/:spaceId/task-axes` · kind: read · status: v1 · served: yes (`identity-spaces.ts:649`)
CLI: `tm8 space task-axis list [<space-id>]`

Lists the space's task axes (e.g. the `type` axis and any custom manual axes), ordered by `position, name, id`.

**Path params** — `spaceId` (uuid). No query params (no pagination on this op — not even a CLI `--limit`/`--cursor` flag).

**Response** — 200; bare array of `TaskAxis`.
```json
{ "data": [
  { "id": "<redacted>", "spaceId": "<redacted>", "name": "type", "axisValues": ["feature", "bug", "chore"], "kind": "default", "position": 0 }
], "requestId": "req_000126" }
```
(illustrative, from schema)

**Errors** — `unauthenticated` (401); `forbidden` (403) not a member.
**Notes** — read; membership (not admin) required.
Source: catalog `catalog.ts:88`; handler `identity-spaces.ts:649-657`; `loadTaskAxes` at `identity-spaces.ts:427-436`.

---

### `spaces.taskAxes.create`
`POST /v2/spaces/:spaceId/task-axes` · kind: command · status: v1 · served: yes (`identity-spaces.ts:659`)
CLI: `tm8 space task-axis create <name> --value <v> [--value <v>...] --kind default|manual --position N`

Creates a new task axis in a space. Admin-only.

**Path params** — `spaceId` (uuid).

**Request body** (`TaskAxisInput` / `TaskAxisInputSchema`, `packages/contract/src/schemas.ts:2645-2651`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | non-empty | |
| `actorId` | uuid | no | | |
| `name` | string | yes | 1–100 chars after trim | axis name |
| `axisValues` | string[] | yes | unique, non-empty (after trim) strings | the value vocabulary |
| `kind` | string | yes | `'default'`\|`'manual'` | |
| `position` | number | yes | finite | display order |

**Response** — 201; `data` is a `TaskAxis`.

**Errors** — `invalid_input` (400): name length, duplicate/empty axis values, or bad `kind` (all SQLSTATE `22023`). `forbidden` (403) not a space admin.
**Notes** — idempotent via `clientMutationId`. Not a whole-body-strict Zod schema at this op's binding beyond the fields listed (the schema itself is `.strict()`).
Source: catalog `catalog.ts:89`; schema `packages/contract/src/schemas.ts:2645-2651`; handler `identity-spaces.ts:659-679`; RPC `public.w2_create_task_axis` (`db/migrations/016_w2_identity_spaces.sql:148-190`).

---

### `spaces.taskAxes.update`
`PATCH /v2/spaces/:spaceId/task-axes/:axisId` · kind: command · status: v1 · served: yes (`identity-spaces.ts:681`)
CLI: `tm8 space task-axis update <axis-id> --name <n> --value <v>... --kind ... --position N`

Replaces a task axis's full definition (whole-shape update, not a patch — omitting `--value` would redefine the axis with no values). Admin-only.

**Path params** — `spaceId` (uuid), `axisId` (uuid).
**Request body** — same shape as `spaces.taskAxes.create` (`TaskAxisInputSchema`); all fields required (whole replace).

**Response** — 200; `data` is the updated `TaskAxis`.

**Errors** — `not_found` (404) no such axis in this space. `invalid_input` (400): same shape checks as create. `invariant_violation` (409, SQLSTATE `23514`): demoting the built-in `'default'`-kind axis to `'manual'`; renaming an axis whose old name tasks still carry in `axes`; removing an axis value that tasks still use. `forbidden` (403) not a space admin.
**Notes** — idempotent via `clientMutationId`.
Source: catalog `catalog.ts:90`; handler `identity-spaces.ts:681-694`; RPC `public.w2_update_task_axis` (`db/migrations/016_w2_identity_spaces.sql:195-279`).

---

### `spaces.taskAxes.delete`
`DELETE /v2/spaces/:spaceId/task-axes/:axisId` · kind: command · status: v1 · served: yes (`identity-spaces.ts:696`)
CLI: `tm8 space task-axis delete <axis-id> --yes`

Deletes a task axis. Admin-only; refuses if the axis is the default axis or still in use by any task.

**Path params** — `spaceId` (uuid), `axisId` (uuid).
**Request body** — `RequiredCommandContextSchema`: `clientMutationId` required, `actorId` optional, `.strict()`.

**Response** — 200; `data`: `{ axisId: string }`.

**Errors** — `not_found` (404) no such axis. `invariant_violation` (409, `23514`): the default axis cannot be deleted; the axis is still in use by tasks. `forbidden` (403) not a space admin.
**Notes** — idempotent via `clientMutationId`.
Source: catalog `catalog.ts:91`; handler `identity-spaces.ts:696-710`; RPC `public.w2_delete_task_axis` (`db/migrations/016_w2_identity_spaces.sql:283-326`).

---

### `spaces.taskWorkflows.list`
`GET /v2/spaces/:spaceId/task-workflows` · kind: read · status: v1 · served: yes (`identity-spaces.ts:712`)
CLI: `tm8 space task-workflow list [<space-id>]`

Lists per-`type`-value status vocabularies for a space, ordered by `type_value, id`.

**Path params** — `spaceId` (uuid). No query params.

**Response** — 200; bare array of `TaskWorkflow`.
```json
{ "data": [
  { "id": "<redacted>", "spaceId": "<redacted>", "typeValue": "bug", "statuses": ["open","working","done","blocked"] }
], "requestId": "req_000127" }
```
(illustrative, from schema)

**Errors** — `unauthenticated` (401); `forbidden` (403) not a member.
**Notes** — read; membership (not admin) required. `unverified: read-only status of this whole sub-family going forward` — the 149 migration header says taskWorkflows "stays read-only until phase 6 retires the `type` axis," but `spaces.taskWorkflows.upsert`/`.delete` are still live v1 command ops in the catalog and registry today.
Source: catalog `catalog.ts:94`; handler `identity-spaces.ts:712-720`; `loadTaskWorkflows` at `identity-spaces.ts:378-387`.

---

### `spaces.taskWorkflows.upsert`
`POST /v2/spaces/:spaceId/task-workflows` · kind: command · status: v1 · served: yes (`identity-spaces.ts:722`)
CLI: `tm8 space task-workflow set <type-value> --status <s> [--status <s>...]`

Upserts the status vocabulary for one `(space, typeValue)` pair — natural-key upsert, not create+update.

**Path params** — `spaceId` (uuid).

**Request body** (`TaskWorkflowInput` / `TaskWorkflowInputSchema`, `packages/contract/src/schemas.ts:2653-2659`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | non-empty | |
| `actorId` | uuid | no | | |
| `typeValue` | string | yes | non-empty | the `type` axis value this rule governs |
| `statuses` | WorkStatus[] | yes | must include `open`, `working`, `done` (table check constraint); must be one of the 7 known statuses; no duplicates (checked in the RPC, SQLSTATE `22023`) | the allowed subset |

**Response** — 200; `data` is the upserted `TaskWorkflow`.

**Errors** — `invalid_input` (400, `22023`): duplicate entries in `statuses`. `invariant_violation` (409, `23514` via table check constraints, not a handler-level check): missing one of `{open, working, done}`, or a status outside the seven-value vocabulary. `forbidden` (403) not a space admin.
**Notes** — idempotent via `clientMutationId`. `unverified: exact wire error shape when the table CHECK constraint (rather than the RPC's explicit RAISE) fires` — it still reaches the client as SQLSTATE `23514` → `invariant_violation` via `translateDbError`, but carries whatever message Postgres attaches to the named constraint, not a hand-authored one.
Source: catalog `catalog.ts:95`; schema `packages/contract/src/schemas.ts:2653-2659`; handler `identity-spaces.ts:722-734`; RPC `public.upsert_task_workflow` (`db/migrations/132_task_workflows.sql:171-201`).

---

### `spaces.taskWorkflows.delete`
`DELETE /v2/spaces/:spaceId/task-workflows/:workflowId` · kind: command · status: v1 · served: yes (`identity-spaces.ts:776`)
CLI: `tm8 space task-workflow delete <workflow-id> --yes`

Deletes a per-type vocabulary rule, widening that type back to all seven statuses. Never data loss (no task row changes).

**Path params** — `spaceId` (uuid), `workflowId` (uuid — a `task_workflows.id`).
**Request body** — `RequiredCommandContextSchema`.

**Response** — 200; `data`: `{ workflowId: string }`.

**Errors** — `not_found` (404) no such rule in this space. `forbidden` (403) not a space admin.
**Notes** — idempotent via `clientMutationId`.
Source: catalog `catalog.ts:96`; handler `identity-spaces.ts:776-790`; RPC `public.delete_task_workflow` (`db/migrations/132_task_workflows.sql:203-225`).

---

### `spaces.workflows.list`
`GET /v2/spaces/:spaceId/workflows` · kind: read · status: v1 · served: yes (`identity-spaces.ts:736`)
CLI: `tm8 space workflow list [<space-id>]`

Lists the space's own workflows **plus** the built-in global default (`space_id is null`), ordered `space_id nulls last, kind asc nulls first, name asc` — the default sorts last. Each workflow embeds its full `states` and `transitions`.

**Path params** — `spaceId` (uuid). No query params.

**Response** — 200; bare array of `Workflow` (each with nested `states`/`transitions` arrays, see Shared types).
```json
{ "data": [
  { "id": "<redacted>", "spaceId": "<redacted>", "name": "Bugs", "kind": "bug",
    "states": [ { "id": "<redacted>", "workflowId": "<redacted>", "name": "Triage", "category": "to_do", "position": 1, "isInitial": true, "isDefault": false } ],
    "transitions": [] }
], "requestId": "req_000128" }
```
(illustrative, from schema; array trimmed to 1 item)

**Errors** — `unauthenticated` (401); `forbidden` (403) not a member.
**Notes** — read; membership (not admin) required.
Source: catalog `catalog.ts:103`; handler `identity-spaces.ts:736-744`; `loadWorkflows` at `identity-spaces.ts:398-425`.

---

### `spaces.workflows.upsert`
`POST /v2/spaces/:spaceId/workflows` · kind: command · status: v1 · served: yes (`identity-spaces.ts:746`)
CLI: `tm8 space workflow set <name> --kind <k> --state "<name>:<category>[:initial][:default]" [--state ...] [--transition "[<from>]->to"...]`

Upserts a whole workflow document on the natural key `(space, kind, name)`. **Whole-document**: `states` REPLACES the state set and `transitions` replaces the transition set every call — there is no add-one-state door, because every invariant here (exactly one initial state, unique positions, transition endpoints inside the workflow's own states) is a property of the workflow as a whole.

**Path params** — `spaceId` (uuid).

**Request body** (`WorkflowInput` / `WorkflowInputSchema`, `packages/contract/src/schemas.ts:2679-2690`)

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | non-empty | |
| `actorId` | uuid | no | | |
| `name` | string | yes | non-empty | |
| `kind` | string \| null | yes (nullable) | server refuses `null` for a space-scoped workflow (only the built-in default may be kindless) | the task `kind` this workflow governs |
| `states.*` | `WorkflowStateInput[]` | yes | min 1 item | see below |
| `states[].name` | string | yes | non-empty | |
| `states[].category` | StatusCategory | yes | one of the 4 | |
| `states[].position` | integer | no | defaults to array order (1-based) | |
| `states[].isInitial` | boolean | no | exactly one `true` across the array (RPC-checked, `22023`, `details.reason: 'workflow_initial_state_required'`) | |
| `states[].isDefault` | boolean | no | at most one per category (tiebreak only) | |
| `transitions.*` | `WorkflowTransitionInput[]` | no | | overrides; empty/absent means ruled category defaults apply |
| `transitions[].from` | string \| null | no | must name a state in `states` if present | omitted/null = ANY source |
| `transitions[].to` | string | yes | must name a state in `states` (RPC-checked, `22023`, `details.reason: 'unknown_state'`) | |
| `transitions[].conditions` | object | no | | |

Example request:
```json
POST /v2/spaces/{spaceId}/workflows
{ "clientMutationId": "c-3", "name": "Bugs", "kind": "bug",
  "states": [ { "name": "Triage", "category": "to_do", "isInitial": true }, { "name": "Fixed", "category": "done" } ],
  "transitions": [ { "to": "Fixed" } ] }
```

**Response** — 200; `data` is the upserted `Workflow` (with fresh `states`/`transitions`).

**Errors** — `forbidden` (403, `42501`): not a space admin; `p_space_id is null` ("the built-in default workflow is not editable" — unreachable through the HTTP route, which always carries a path `spaceId`, but present in the RPC). `invalid_input` (400, `22023`): no states given; not exactly one `isInitial` state (`details.reason: 'workflow_initial_state_required'`); a transition names an unknown state (`details.reason: 'unknown_state'`, plus `state` naming which one). `invariant_violation` (409, `23503`): removing a state that entities still occupy (`entities.status_id` is `ON DELETE RESTRICT`, surfaced via the state-replace `delete`).
**Notes** — idempotent via `clientMutationId`. States and transitions are addressed by **name**, not id, in the request (a caller authoring a workflow has no ids yet); the response returns the persisted rows with real ids.
Source: catalog `catalog.ts:104`; schema `packages/contract/src/schemas.ts:2661-2690`; handler `identity-spaces.ts:746-757`; RPC `public.upsert_workflow` (`db/migrations/149_workflows.sql:659-785`).

---

### `spaces.workflows.delete`
`DELETE /v2/spaces/:spaceId/workflows/:workflowId` · kind: command · status: v1 · served: yes (`identity-spaces.ts:760`)
CLI: `tm8 space workflow delete <workflow-id> --yes`

Deletes a space's workflow (states/transitions cascade). Unlike `taskWorkflows.delete`, this **can** be data loss: an entity still sitting in one of the deleted states is protected only by the `entities.status_id` FK's `RESTRICT`, which surfaces as `invariant_violation`.

**Path params** — `spaceId` (uuid), `workflowId` (uuid). The built-in default (`space_id is null`) can never match a caller's `spaceId`, so attempting to delete it answers `not_found`, not `forbidden`.
**Request body** — `RequiredCommandContextSchema`.

**Response** — 200; `data`: `{ workflowId: string }`.

**Errors** — `not_found` (404) no such workflow in this space (including the built-in default, by construction). `invariant_violation` (409, `23503`) a state in this workflow still holds entities. `forbidden` (403) not a space admin.
**Notes** — idempotent via `clientMutationId`.
Source: catalog `catalog.ts:105`; handler `identity-spaces.ts:760-774`; RPC `public.delete_workflow` (`db/migrations/149_workflows.sql:787-827`).

---

## Notes on the doc

- All handlers live in one class, `W2IdentitySpacesService` (`packages/server/src/facade/services/w2/identity-spaces.ts`), registered in `packages/server/src/facade/handlers/w2/identity-spaces.ts:60-75`.
- None of the 16 ops in this group are paginated server-side even where the CLI exposes `--limit`/`--cursor` (`members.list`, `invites.list`); per-space row counts for members/invites/axes/workflows are assumed small enough that a full unpaginated list is acceptable — this is an observation from reading the code, not a documented design decision found in comments.
- Every command RPC follows the same shape: `internal.ledger_replay` first (idempotency short-circuit), then `internal.require_space_admin` or `internal.require_space_member`, then the domain write, then `internal.ledger_record`.
