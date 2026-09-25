# Auth, identity, server connections, node, team members

This group covers who is calling (`identity.get`, `identity.profile.update`),
local account authentication and node bootstrap (`auth.*`), a node's routing
table of other tm8 Servers (`serverConnections.*`), a node admin's view of the
node's own fallback vendor credentials (`node.credentials.*`), and one
Teammate default (`teamMembers.interactionProfile.setDefault`). It does not
cover per-member vendor credentials (`credentials.*`) or per-space credentials
(`credentials.space.*`) — sibling operations in the same catalog region,
covered elsewhere.

Every operation below is `status: v1` and every one has a registered handler
(none answer `501 not_implemented`).

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `identity.get` | GET | `/v2/identity` | read | yes |
| `identity.profile.update` | POST | `/v2/identity/profile` | command | yes |
| `serverConnections.list` | GET | `/v2/server-connections` | read | yes |
| `serverConnections.create` | POST | `/v2/server-connections` | command | yes |
| `serverConnections.get` | GET | `/v2/server-connections/:name` | read | yes |
| `serverConnections.delete` | DELETE | `/v2/server-connections/:name` | command | yes |
| `teamMembers.interactionProfile.setDefault` | PUT | `/v2/team-members/:teamMemberId/interaction-profile-default` | command | yes |
| `auth.signup` | POST | `/v2/auth/signup` | command | yes |
| `auth.login` | POST | `/v2/auth/login` | command | yes |
| `auth.logout` | POST | `/v2/auth/logout` | command | yes |
| `auth.session.get` | GET | `/v2/auth/session` | read | yes |
| `auth.password.change` | POST | `/v2/auth/password` | command | yes |
| `auth.invite.resolve` | POST | `/v2/auth/invite/resolve` | read | yes |
| `auth.invite.signup` | POST | `/v2/auth/invite/signup` | command | yes |
| `auth.claim` | POST | `/v2/auth/claim` | command | yes |
| `auth.claim.status` | GET | `/v2/auth/claim` | read | yes |
| `auth.claim.reissue` | POST | `/v2/auth/claim/reissue` | command | yes |
| `node.credentials.status` | GET | `/v2/node/credentials` | read | yes |
| `node.credentials.policy.set` | PUT | `/v2/node/credential-policy/:provider` | command | yes |

Source (catalog rows): `packages/contract/src/catalog.ts:68-72,339,379,386-390,401,409,420,438-439,447,498-499`.

## Shared types (define once)

**Envelope.** Every response is `{ "data": <shape below>, "requestId": "req_..." }`.
A command's success status is `200` unless noted; `serverConnections.create`
answers `201`.

**Errors.** Every error is `{ "error": { "code", "message", "details"?, "requestId", "retryable" } }`
with HTTP status from `ERROR_STATUS` (`packages/contract/src/contract.ts:1628-1638`).
A raw Postgres error is mapped through a fixed SQLSTATE table
(`packages/server/src/http/errors.ts:34-64`): `28000`→`unauthenticated`,
`42501`→`forbidden`, `P0002`/`22P02`→`not_found`, `22023`→`invalid_input`,
`23514`/`23503`/`23505`→`invariant_violation`, `40001`→`version_conflict`.
Anything not in that table degrades to `upstream_unavailable` (503), never a
guessed 400.

**`CommandContext`** (the shape most command bodies extend, unless a
per-operation note says otherwise): `actorId?: EntityId`,
`clientMutationId?: string`, `workSessionId?: EntityId`. Zod shape
(`commandContextShape`) at `packages/contract/src/schemas.ts:1662-1666`.

**`auth.*` is outside this pattern on purpose.** None of the ten `auth.*`
DTOs extend `CommandContext`: a session row is not a graph mutation, so
there is no idempotency ledger and no `clientMutationId`/`actorId` on the
wire — the strict Zod schemas refuse both. `commandAcceptsClientMutationId(name)`
(`packages/contract/src/contract.ts:1778-1780`) returns `false` for every
`auth.*` operation and `true` for everything else in this group.
Source: `packages/server/src/facade/handlers/w2/auth.ts:1-29`.

**`AuthAccountView`** — the account half of every auth response, never a
credential:

| field | type | description |
|---|---|---|
| `accountId` | string (uuid) | |
| `identityId` | string | |
| `username` | string | |
| `displayName` | string \| null | |
| `isNodeAdmin` | boolean | node-level role |
| `isOwner` | boolean | |

Source: `packages/contract/src/contract.ts:1807-1814`; schema `schemas.ts:1792-1799`.

**`AuthSessionView`** — the session half of every auth response; the bearer
token itself appears exactly once, at issuance, never here:

| field | type | description |
|---|---|---|
| `sessionId` | string (uuid) | |
| `kind` | `'browser'` \| `'cli'` \| `'agent'` \| `'agent_runtime'` | |
| `actingAsTeamMemberId` | string \| null | persona-scoped agent sessions only |
| `runtimeMemberId` | string \| null | optional; chat runtime only |
| `runtimeThreadRootId` | string \| null | optional; pre-176 chat runtimes only |
| `runtimeChatId` | string \| null | optional; chat runtime only |
| `label` | string \| null | |
| `createdAt` | string (ISO) | optional; present at issuance |
| `expiresAt` | string (ISO) | |

Source: `packages/contract/src/contract.ts:1789-1804`; schema `schemas.ts:1801-1810`.

**Login-shaped result** — `AuthLoginResult` / `AuthClaimResult` /
`AuthInviteSignupResult` (the last adds `spaceId`, `memberId`) all share
`{ token: string, account: AuthAccountView, session: AuthSessionView }`, where
`token` is `tm8s_<sessionId>.<secret>`, returned exactly once and never
recoverable. A `kind !== 'browser'` login (e.g. `kind: 'cli'`) returns this
JSON body only; a browser login/claim/invite-signup additionally sets a
`Secure, HttpOnly` session cookie (`Set-Cookie`) and `cache-control: no-store`,
built by `sessionCookie()` (`packages/server/src/http/session-cookie.ts`).

**`AuthPasswordSchema`** — every password field (signup, claim, invite
signup, login's not checked here, password-change's `newPassword`) is
8–1024 characters. **`AuthUsernameSchema`** — 1–100 characters, no
whitespace, normalized lower-case server-side. Source: `schemas.ts:1758-1764`.

---

### `identity.get`
`GET /v2/identity` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/identity.ts:28-36`)
CLI: `tm8 identity get`

Who the caller is on this node: the bound identity's account row, profile
overlay, and every Space membership. No `--space` / path parameter — this is
authorized against the server, not a Space.

**Response** — 200; `data` shape:

| field | type | description |
|---|---|---|
| `identityId` | string | |
| `accountId` | string | |
| `username` | string | |
| `displayName` | string \| null | profile override, else account default |
| `avatar` | string \| null | |
| `email` | string \| null | profile override, else account default |
| `globalId` | string \| null | cross-server display claim, `issuer:subject` shape |
| `isNodeAdmin` | boolean | |
| `isOwner` | boolean | |
| `status` | string | account status |
| `actingAs` | string \| null | |
| `memberships` | array of `{ spaceId, memberId, role }` | ordered by `joined_at` |

Example (illustrative, from schema):
```json
{
  "data": {
    "identityId": "id_11111111-1111-1111-1111-111111111111",
    "accountId": "22222222-2222-2222-2222-222222222222",
    "username": "alice",
    "displayName": "Alice",
    "avatar": null,
    "email": null,
    "globalId": null,
    "isNodeAdmin": true,
    "isOwner": true,
    "status": "active",
    "actingAs": null,
    "memberships": [
      { "spaceId": "33333333-3333-3333-3333-333333333333", "memberId": "44444444-4444-4444-4444-444444444444", "role": "owner" }
    ]
  },
  "requestId": "req_00003a"
}
```

**Errors** — `unauthenticated` (401) — `current_identity` raises SQLSTATE
`28000` ("no account for the bound identity") when the bound claim resolves
to no account row — the honest answer to "who am I" from an unresolved
caller; there is no separate check in the handler.
**Notes** — no idempotency (read). RPC: `current_identity`
(`db/migrations/067_identity_profile_global_id.sql:50-77`, copied from
007:372 plus `globalId`).
Source: catalog `catalog.ts:68`; handler `identity.ts:28-36`; registration
`packages/server/src/facade/handlers/w2/identity-spaces.ts:50`.

---

### `identity.profile.update`
`POST /v2/identity/profile` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/identity.ts:47-64`)
CLI: `tm8 identity profile set [--display-name <s>] [--avatar <s>] [--email <s>] [--global-id <issuer:subject>] [--mutation-id <id>]`

The caller writes their OWN `user_profiles` row. No `actorId` field (a
profile belongs to an identity, not a per-space actor) — the wire is strict
and refuses one if sent.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | idempotency key |
| `displayName` | string | no | 1–200 chars | |
| `avatar` | string | no | 1–2000 chars | |
| `email` | string | no | 3–320 chars | |
| `globalId` | string | no | 3–200 chars, `issuer:subject`, no whitespace | cross-server display claim; never an authorization input |

Only provided (non-null) fields are written; there is no way to clear a
populated field back to `null` through this operation.

Example request:
```json
{ "clientMutationId": "cm_1", "displayName": "Alice", "globalId": "github:alice123" }
```

**Response** — 200; `data` is `IdentityProfileView`:

| field | type | description |
|---|---|---|
| `identityId` | string | |
| `displayName` | string \| null | |
| `avatar` | string \| null | |
| `email` | string \| null | |
| `globalId` | string \| null | |

Example:
```json
{ "data": { "identityId": "id_1111...", "displayName": "Alice", "avatar": null, "email": null, "globalId": "github:alice123" }, "requestId": "req_00003b" }
```

**Errors** — `invalid_input` (400) — `clientMutationId` missing/empty, or an
`actorId` present and not a UUID (checked in the `requireMutationId` wrapper
before the handler runs).
**Notes** — idempotent via `clientMutationId` (ledger-recorded RPC:
`update_identity_profile`, `db/migrations/067_identity_profile_global_id.sql:92-125`).
No `expectedVersion` (upsert by identity, not optimistic-locked). No pagination.
Source: catalog `catalog.ts:379`; schema `schemas.ts:1741-1755`; handler
`identity.ts:47-64`; wrapper `identity-spaces.ts:19-35,51`.

---

### `serverConnections.list`
`GET /v2/server-connections` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/server-connections.ts:54-61`)
CLI: `tm8 server list`

Lists this node's named routes to other tm8 Servers, ordered by name. Rows
are routing configuration, never credentials (no password column exists).
Visibility is RLS-gated to node admins (`server_connections_node_admin_select`
policy on `internal.is_node_admin()`); a non-admin caller sees an empty list,
not a `forbidden`.

**Response** — 200; `data` is `ServerConnection[]`:

| field | type | description |
|---|---|---|
| `id` | string (uuid) | |
| `name` | string | lower-case, `^[a-z][a-z0-9-]{0,62}$` |
| `baseUrl` | string | origin only, http/https, no path/query/fragment/credentials |
| `username` | string \| null | optional |
| `createdAt` | string (ISO) | |
| `updatedAt` | string (ISO) | |

Example (illustrative, from schema):
```json
{ "data": [ { "id": "aaaa...", "name": "staging", "baseUrl": "https://staging.example.com", "username": null, "createdAt": "2026-08-01T00:00:00.000Z", "updatedAt": "2026-08-01T00:00:00.000Z" } ], "requestId": "req_00003c" }
```

**Errors** — none beyond the generic auth taxonomy.
**Notes** — no idempotency (read). No pagination (small, node-local table).
Source: catalog `catalog.ts:69`; schema `schemas.ts:1713-1719`; service
`server-connections.ts:54-61`; table `db/migrations/044_local_server_connections.sql:9-30`.

---

### `serverConnections.create`
`POST /v2/server-connections` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/server-connections.ts:76-86`)
CLI: `tm8 server add <name> --url <url> [--username <s>] [--mutation-id <id>]` — the CLI probes `GET /health` on the target URL and checks `contractVersion` before calling this operation.

Registers a named route to another tm8 Server. Node-admin only
(`internal.require_node_admin()` inside the RPC).

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | idempotency key |
| `name` | string | yes | lower-case, `^[a-z][a-z0-9-]{0,62}$` | unique (case-insensitive) |
| `baseUrl` | string | yes | http/https origin only, ≤2048 chars | no path, query, fragment, or embedded credentials |
| `username` | string \| null | no | 1–100 chars | |

Example request:
```json
{ "clientMutationId": "cm_2", "name": "staging", "baseUrl": "https://staging.example.com", "username": "bot" }
```

**Response** — 201; `data` is `ServerConnection` (see `serverConnections.list`).

**Errors** — `forbidden` (403) — caller is not a node admin.
`invariant_violation` (409) — a connection with that name already exists
(unique index `server_connections_name_unique`, SQLSTATE `23505`), or
`clientMutationId` is already bound to a different connection name
(SQLSTATE `23514`, raised explicitly by the RPC on ledger replay mismatch).
**Notes** — idempotent via `clientMutationId`, recorded in the command
ledger (`internal.ledger_replay`/`ledger_record`) — a replayed call with the
same id returns the original result rather than erroring or duplicating.
Source: catalog `catalog.ts:70`; schema `schemas.ts:1722-1727`; service
`server-connections.ts:76-86`; RPC `create_server_connection`
(`db/migrations/044_local_server_connections.sql:35-73`).

---

### `serverConnections.get`
`GET /v2/server-connections/:name` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/server-connections.ts:63-74`)
CLI: `tm8 server get <name>`

Reads one named connection by name (case-insensitive).

**Path params**

| name | type | description |
|---|---|---|
| `name` | string | lower-cased before lookup |

**Response** — 200; `data` is `ServerConnection`.

**Errors** — `not_found` (404) — no connection with that name, or the row
exists but the caller is not a node admin (RLS filters it out — same wire
shape either way).
**Notes** — no idempotency (read).
Source: catalog `catalog.ts:71`; service `server-connections.ts:63-74`.

---

### `serverConnections.delete`
`DELETE /v2/server-connections/:name` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/server-connections.ts:88-98`)
CLI: `tm8 server remove <name> --yes [--mutation-id <id>]`

Deletes a named connection. Node-admin only. Returns the deleted row.

**Path params**

| name | type | description |
|---|---|---|
| `name` | string | lower-cased before lookup |

**Request body**

| field | type | required | description |
|---|---|---|---|
| `clientMutationId` | string | yes | idempotency key |

**Response** — 200; `data` is `ServerConnection` (the row as it was before deletion).

**Errors** — `forbidden` (403) — caller is not a node admin.
`not_found` (404) — no connection with that name (RPC raises SQLSTATE
`P0002`, "server connection not found"). `invariant_violation` (409) —
`clientMutationId` already bound to a different connection name (`23514`).
**Notes** — idempotent via `clientMutationId` (command ledger).
Source: catalog `catalog.ts:72`; schema `schemas.ts:1729-1732`; service
`server-connections.ts:88-98`; RPC `delete_server_connection`
(`db/migrations/044_local_server_connections.sql:75-113`).

---

### `teamMembers.interactionProfile.setDefault`
`PUT /v2/team-members/:teamMemberId/interaction-profile-default` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/entity-kinds-profiles.ts:332-343`)
CLI: `tm8 teammate interaction-profile set-default <team-member-id> <interaction-profile-id|none> --expect-version <n> --yes [--mutation-id <id>]`

Sets (or clears, with `none`) the Interaction Profile a Teammate's spawns
default to when nothing else pins one. Human-principal only: a caller
`acting_as` a Teammate is refused, and the caller must be a Space owner/admin
member of the Teammate's own Space.

**Path params**

| name | type | description |
|---|---|---|
| `teamMemberId` | string (uuid) | must be an `entities` row of kind `team_member`, not deleted |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | yes | min 1 char | idempotency key |
| `expectedVersion` | number | yes | positive integer | optimistic lock on the Teammate entity's `version` |
| `profileId` | string (EntityId) \| null | yes | | the Profile to default to; `null` clears it |

Example request:
```json
{ "clientMutationId": "cm_3", "expectedVersion": 4, "profileId": "55555555-5555-5555-5555-555555555555" }
```

**Response** — 200; `data` is `TeammateProfileDefaultView`:

| field | type | description |
|---|---|---|
| `teamMemberId` | string | |
| `defaultInteractionProfileId` | string \| null | |
| `version` | number | the Teammate entity's version after the write (unchanged if the default did not actually change) |

Example:
```json
{ "data": { "teamMemberId": "66666666-...", "defaultInteractionProfileId": "55555555-...", "version": 5 }, "requestId": "req_00003d" }
```

**Errors** — `not_found` (404) — no such Teammate, or it is deleted
(`details.reason` not set; SQLSTATE `P0002`). `forbidden` (403) —
`details.reason: "profile_principal_required"` — caller is `acting_as`
someone, or is not an owner/admin member of the Teammate's Space
(`internal.require_human_space_admin`). `not_found` (404) — the named
Profile doesn't exist, isn't in the same Space, or isn't visible
(`internal.w2g12_assert_active_profile`). `conflict`/`forbidden` (409/403) —
`details.reason: "profile_retired"` — the named Profile is retired.
`version_conflict` (409) — `expectedVersion` does not match the Teammate's
current version (`internal.assert_version`).
**Notes** — idempotent via `clientMutationId` (command ledger,
`internal.w2g12_authorize_replay` re-checks authorization on replay). Emits
`workspace_events` row `interaction_profile.teammate_default_updated`
(`teamMemberId`, `profileId`, `version`, `selectedBy`) only when the default
actually changes.
Source: catalog `catalog.ts:339`; schema `schemas.ts:4272-4276,4327-4330`;
service `entity-kinds-profiles.ts:332-343`; RPC `set_teammate_profile_default`
(`db/migrations/027_w2_entity_kinds_profiles.sql:1146-1202`); guard
`internal.require_human_space_admin` (`db/migrations/015_w1_foundations.sql:1145-1165`).

---

### `auth.signup`
`POST /v2/auth/signup` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:88-102`)
CLI: `tm8 auth signup <username> --password <p> [--display-name <s>] [--email <s>] [--node-admin]`

Node-admin provisioning of a new local account. **Never open
self-registration** — the gate (`ensure_account`'s node-admin check) runs
under the CALLER's own claims in SQL, so an unauthenticated caller gets
`unauthenticated` and a non-admin gets `forbidden`.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `username` | string | yes | 1–100 chars, no whitespace | normalized lower-case |
| `password` | string | yes | 8–1024 chars | hashed server-side (scrypt) |
| `displayName` | string | no | 1–200 chars | |
| `email` | string | no | 3–320 chars | |
| `isNodeAdmin` | boolean | no | default `false` | node-level role only; never widens `can_act_as` |

**Response** — 200; `data` is `{ account: AuthAccountView }`.

**Errors** — `unauthenticated` (401) — no account/credential on the request
(SQLSTATE `28000`). `forbidden` (403) — caller is authenticated but not a
node admin (SQLSTATE `42501`). `conflict` (409) — the username already
exists (`ensure_account` is idempotent-by-lookup; the handler detects the
returned identity differs from the one it tried to create and refuses rather
than silently handing back someone else's account).
**Notes** — no `clientMutationId` (outside the idempotency ledger; a retry
mints nothing new here because it 409s on the existing username instead).
No `actorId`. RPC: `ensure_account` (007 F1).
Source: catalog `catalog.ts:386`; schema `schemas.ts:1770-1777`; handler
`auth.ts:88-102`; `signupAccount` (`packages/server/src/identity/pg-auth.ts:351-376`).

---

### `auth.login`
`POST /v2/auth/login` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:105-131`)
CLI: `tm8 auth login <username> --password <password> [--kind browser|cli] [--label <label>] [--print-token]` (the CLI defaults `kind` to `cli`, not the operation's own `browser` default)

Claim-free credential exchange: verifies the password with constant-work
scrypt (a dummy verifier runs for an unknown username, so timing does not
enumerate accounts) and mints a session.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `username` | string | yes | | |
| `password` | string | yes | 1–1024 chars | |
| `kind` | `'browser'` \| `'cli'` | no | default `browser` | `agent`/`agent_runtime` refused — those are minted at spawn |
| `label` | string | no | 1–200 chars | shown in session listings |

**Response** — 200; `data` is the login-shaped result (see Shared types). A
`kind: 'browser'` (default) response also sets the session cookie.

**Errors** — `unauthenticated` (401) — unknown username, wrong password, or
the account is disabled (`status !== 'active'`) — one uniform message and
code for all three, so none is enumerable.
**Notes** — no idempotency ledger; a retried login mints a second session,
which is correct (not an error). No `actorId`.
Source: catalog `catalog.ts:387`; schema `schemas.ts:1779-1784`; handler
`auth.ts:105-131`; `loginWithPassword` (`pg-auth.ts:270-330`).

---

### `auth.logout`
`POST /v2/auth/logout` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:138-158`)
CLI: `tm8 auth logout [--session-id <id>]`

Revokes the presented bearer session, or (self, or node admin) an explicitly
named one. `revoke_auth_session` enforces self-or-node-admin in SQL — naming
someone else's session as a non-admin is a `forbidden`, not a silent no-op.

**Request body**

| field | type | required | description |
|---|---|---|---|
| `sessionId` | string (uuid) | no | defaults to the session presented in the `Authorization` header |

**Response** — 200; `data`: `{ sessionId: string, revoked: boolean }`. Also
clears the session cookie.

**Errors** — `invalid_input` (400) — no `sessionId` given and the caller is
the loopback auto-owner (which carries no session to default to).
`forbidden` (403) — naming a session that is not the caller's own, without
node admin.
**Notes** — no idempotency ledger.
Source: catalog `catalog.ts:388`; schema `schemas.ts:1786-1788`; handler
`auth.ts:138-158`.

---

### `auth.session.get`
`GET /v2/auth/session` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:166-236`)
CLI: `tm8 auth session`

Who the caller is and how they authenticated. A bearer token is re-verified
live (revocation/expiry/disablement surface immediately, never from a
cache); the loopback auto-owner answers with `session: null`.

**Response** — 200; `data` is `AuthSessionGetResult`:

| field | type | description |
|---|---|---|
| `authKind` | `'bearer'` \| `'auto-owner'` | |
| `account` | `AuthAccountView` | |
| `session` | `AuthSessionView` \| null | `null` only for `auto-owner` |

A `browser`-kind session response also refreshes the session cookie (lets
pre-cookie browser sessions upgrade into the WebSocket-authenticating
carrier).

**Errors** — `unauthenticated` (401) — anonymous caller, or a bearer identity
that failed to resolve.
**Notes** — no idempotency (read).
Source: catalog `catalog.ts:389`; schema `schemas.ts:1811-1814`; handler
`auth.ts:166-236`.

---

### `auth.password.change`
`POST /v2/auth/password` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:476-519`)
CLI: `tm8 auth password --current <current-password> --new <new-password>`

Rotates the caller's OWN credential. This is CHANGE, not reset: the current
password must be proven (same scrypt work `auth.login` spends) even though
the caller already holds a session, so a walk-up on an open session cannot
silently re-credential the account. Every OTHER live session for the account
is revoked; the session making the change (if any) is spared.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `currentPassword` | string | yes | 1–1024 chars | proven before the write |
| `newPassword` | string | yes | 8–1024 chars | |

**Response** — 200; `data`: `{ accountId: string, revokedOtherSessions: number }`.
Sets `cache-control: no-store`.

**Errors** — `unauthenticated` (401) — anonymous caller, or `currentPassword`
does not verify, or the account is disabled — one uniform refusal for a
wrong password and an unclaimed loopback owner with no stored credential
(neither state is enumerable).
**Notes** — no idempotency ledger, no `clientMutationId`. Write is
`set_account_credential` under the caller's own claims (no node admin
needed to change your own credential), paired in one transaction with
`revoke_account_sessions_except`.
Source: catalog `catalog.ts:401`; schema `schemas.ts:1875-1889`; handler
`auth.ts:476-519`; `changePassword` (`pg-auth.ts:524-556`).

---

### `auth.invite.resolve`
`POST /v2/auth/invite/resolve` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:285-313`)
CLI: `tm8 space invite resolve <code>`

What an invite code lets you join, before the holder is anybody on this
node. **POST with `kind: 'read'`, deliberately**: the code is a bearer
capability and must travel in the body, never a URL path (which would leak
into access logs, browser history, `Referer`). Claim-free — reachable with
no account — but not claim-blind: if the request carries a resolved identity
(bearer or loopback auto-owner), it is forwarded to SQL so an existing
member correctly sees `status: 'member'` instead of a stale `exhausted`.

**Request body**

| field | type | required | description |
|---|---|---|---|
| `code` | string | yes | the invite code |

**Response** — 200; `data` is `InvitePreview`, a discriminated union on `status`:

| `status` | additional fields |
|---|---|
| `unknown` | none |
| `revoked` \| `expired` \| `exhausted` | `spaceName` |
| `member` | `spaceId`, `spaceName` |
| `valid` | `spaceId`, `spaceName`, `role` (never `owner`), `invitedBy` (string \| null), `expiresAt` (string \| null) |

Example (illustrative, from schema):
```json
{ "data": { "status": "valid", "spaceId": "33333333-...", "spaceName": "Acme Engineering", "role": "member", "invitedBy": "Alice", "expiresAt": null }, "requestId": "req_00003e" }
```

**Errors** — none beyond the generic taxonomy; disclosure rules are decided
entirely in SQL (`public.preview_invite`) so one rule serves every transport.
**Notes** — no idempotency ledger, no `actorId`/`clientMutationId` (the DTO
declares neither).
Source: catalog `catalog.ts:409`; type `contract.ts:3011-3013`; union
`contract.ts:3048-3060`; handler `auth.ts:285-313`.

---

### `auth.invite.signup`
`POST /v2/auth/invite/signup` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:534-564`)
CLI: `tm8 auth invite signup --code <inv_...> --username <username> --password <password> [--display-name <name>] [--email <email>]`

Redeems an invite that CREATES the account. Claim-free — the invite code is
the only authorization. `signup_via_invite` creates the account, the
profile, the membership, and consumes the invite atomically; it hard-codes
`isNodeAdmin: false` / `isOwner: false` with no input path that can reach
them. Signing up signs you in.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `code` | string | yes | | `inv_…` |
| `username` | string | yes | 1–100 chars, no whitespace | |
| `password` | string | yes | 8–1024 chars | |
| `displayName` | string | no | 1–200 chars | |
| `email` | string | no | 3–320 chars | |
| `kind` | `'browser'` \| `'cli'` | no | default `browser` | |

**Response** — 200; `data` is the login-shaped result plus `spaceId`
(SpaceId) and `memberId` (EntityId) — the Space and membership row the
invite created. A `browser`-kind response also sets the session cookie.

**Errors** — `upstream_unavailable` (503) — `signup_via_invite` returned no
row (should not happen in practice). Invite-specific refusals (invalid/dead
code, etc.) surface as whatever `signup_via_invite` raises — unverified: the
exact SQLSTATE/`details.reason` set was not traced into `signup_via_invite`'s
SQL body in this pass.
**Notes** — no idempotency ledger, no `actorId`/`clientMutationId`.
Source: catalog `catalog.ts:420`; schema `schemas.ts:1895-1903`; handler
`auth.ts:534-564`; `signupViaInvite` (`pg-auth.ts:588-625`).

---

### `auth.claim`
`POST /v2/auth/claim` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:335-366`)
CLI: `tm8 auth claim --token <tm8c_...> --username <username> --password <password> [--display-name <name>] [--email <email>]` (also `tm8 auth claim --show`, an on-box read of `<dataDir>/setup-token`, not this operation)

The first-run node-ownership ceremony. Sets a credential on the node's
EXISTING owner account (preserving `identity_id`, so everything the
auto-owner already created stays theirs) rather than creating a new account.
Claim-free by construction — the one-time `tm8c_…` token is the
authorization, checked and burned atomically inside `claim_node`. Signs you
in on success.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `token` | string | yes | `^tm8c_[A-Za-z0-9_-]+$`, 8–200 chars | from the boot log or `<dataDir>/setup-token` |
| `username` | string | yes | 1–100 chars, no whitespace | |
| `password` | string | yes | 8–1024 chars | |
| `displayName` | string | no | 1–200 chars | |
| `email` | string | no | 3–320 chars | |
| `kind` | `'browser'` \| `'cli'` | no | default `browser` | |

**Response** — 200; `data` is the login-shaped result. A `browser`-kind
response also sets the session cookie.

**Errors** — `unauthenticated` (401) — the token does not start with
`tm8c_`, or is wrong/already burned — one uniform message for both, mirroring
`auth.login`'s refusal not distinguishing a bad username from a bad
password. `forbidden` (403) — the token is presented against a node that is
already claimed (`claim_node` re-asserts unclaimed state before burning the
token). This is a deliberate exception to "don't disclose state": `auth.claim.status`
already publishes `claimed` to anonymous callers.
**Notes** — no idempotency ledger, no `actorId`/`clientMutationId`. Session
issuance is delegated to the same `loginWithPassword` path `auth.login` uses.
Source: catalog `catalog.ts:438`; schema `schemas.ts:1841-1848`; handler
`auth.ts:335-366`; `claimNode` (`pg-auth.ts:465-494`).

---

### `auth.claim.status`
`GET /v2/auth/claim` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:380-398`)
CLI: `tm8 node mode` (a purpose-named alias — same read, no new operation)

The bootstrap read a client can ask with no credential at all, so a UI gate
can pick claim/sign-in/invite framing from a fact rather than a browser-local
guess. Deliberately does NOT report whether a live claim token currently
exists (that is a filesystem fact whose disclosure would tell a stranger
whether a claim attempt would win).

**Response** — 200; `data` is `AuthClaimStatusResult`:

| field | type | description |
|---|---|---|
| `claimed` | boolean | true once any active account has a credential |
| `mode` | `'single'` \| `'multi'` | `TM8_NODE_MODE`; `single` = loopback caller resolves as owner with no credential |
| `signupPath` | `'claim'` \| `'invite'` \| `'admin'` | what this node will accept right now: `claim` while unclaimed, `invite` once claimed (an invite authorizes self-signup), a node admin can still use `auth.signup` regardless |

Example (illustrative, from schema):
```json
{ "data": { "claimed": true, "mode": "single", "signupPath": "invite" }, "requestId": "req_00003f" }
```

**Errors** — none; anonymous-readable by design.
**Notes** — no idempotency (read). Shares its path with `auth.claim`
(GET vs POST on `/v2/auth/claim`), the established pattern also used by
`artifacts.publish`/`artifacts.revisions.list`.
Source: catalog `catalog.ts:439`; schema `schemas.ts:1858-1862`; handler
`auth.ts:380-398`; `nodeIsClaimed` (`pg-auth.ts:400-403`).

---

### `auth.claim.reissue`
`POST /v2/auth/claim/reissue` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/auth.ts:421-461`)
CLI: none found (unverified: searched `packages/cli/src/commands/*.ts` for `auth.claim.reissue`; not found — likely operated by hitting the endpoint directly on-box, or via a not-yet-located command)

Rotates the first-run claim token when the printed one is lost. **On-box by
construction**: admits ONLY the loopback auto-owner arm — a remote caller
(even a bearer node admin) is refused, because the freshly minted token is a
node-ownership capability. Inert on an already-claimed node.

**Request body** — none.

**Response** — 200; `data` is `AuthClaimReissueResult`:

| field | type | description |
|---|---|---|
| `token` | string | fresh `tm8c_…` plaintext, returned only to the on-box caller |
| `claimUrl` | string | `{origin}/#claim={token}` |
| `tokenPath` | string \| null | the 0600 `<dataDir>/setup-token` path written, or `null` if the write failed (the reissue still succeeds) |

**Errors** — `forbidden` (403) — the caller is not the loopback auto-owner
("reissue is on-box only"), or the node is already claimed ("its claim token
is inert, so there is nothing to reissue").
**Notes** — no idempotency ledger. An ordinary server restart *reprints* the
live token (a separate boot-time code path) rather than rotating it; this
operation is the deliberate rotation act.
Source: catalog `catalog.ts:447`; schema `schemas.ts:1864-1869`; handler
`auth.ts:421-461`; `issueNodeClaimToken` (`pg-auth.ts:416-420`).

---

### `node.credentials.status`
`GET /v2/node/credentials` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/credentials.ts:468-472`)
CLI: none found (unverified: searched `packages/cli/src/commands/*.ts` for `node.credentials`; only appears in `packages/cli/src/discovery/operations.ts`, a discovery listing, not a command)

The node's own fallback vendor credentials — human-only and node-admin-only.
Reports, per provider, the node policy and whether the server's own
environment carries a matching key (a boolean only; the key itself is never
described).

**Response** — 200; `data` is `NodeCredentialsStatusView`:

| field | type | description |
|---|---|---|
| `providers` | `NodeCredentialStatusEntry[]` | one entry per `anthropic`, `openai`, `github` |

`NodeCredentialStatusEntry`:

| field | type | description |
|---|---|---|
| `provider` | `'anthropic'` \| `'openai'` \| `'github'` | |
| `allowNode` | boolean \| null | `null` = no policy set (node fallback allowed) |
| `envKeyPresent` | boolean | whether this provider's server env var (e.g. `ANTHROPIC_API_KEY`) is set and non-blank |

Example (illustrative, from schema):
```json
{ "data": { "providers": [ { "provider": "anthropic", "allowNode": null, "envKeyPresent": true }, { "provider": "openai", "allowNode": false, "envKeyPresent": false }, { "provider": "github", "allowNode": null, "envKeyPresent": false } ] }, "requestId": "req_000040" }
```

**Errors** — `forbidden` (403) — `details.reason: "credentials_human_only"`
if the session is not `browser`/`cli` (an agent holding its owner's identity
is refused first); `details.reason: "node_admin_required"` if the (human)
caller is not a node admin.
**Notes** — no idempotency (read). Two-layer guard: `requireHumanSession`
(reads only server-resolved `ctx.identity.authKind`) then
`requireNodeAdmin` (reads server-resolved `claims.nodeAdmin`); SQL repeats
both via `internal.require_human_auth_kind()`/`internal.require_node_admin()`.
Source: catalog `catalog.ts:498`; schema `schemas.ts:2164-2166`; handler
`credentials.ts:468-472`; service `SpaceCredentialCatalogService.nodeStatus`
(`packages/server/src/facade/services/w2/space-credential-catalog.ts:341-349`).

---

### `node.credentials.policy.set`
`PUT /v2/node/credential-policy/:provider` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/credentials.ts:474-480`)
CLI: none found (unverified — same search as `node.credentials.status`)

Sets (or clears) whether a provider's node fallback credential may be used
at all. Human-only, node-admin-only, same two-layer guard as `status`.

**Path params**

| name | type | description |
|---|---|---|
| `provider` | `'anthropic'` \| `'openai'` \| `'github'` | |

**Request body**

| field | type | required | description |
|---|---|---|---|
| `allowNode` | boolean \| null | yes | `null` removes the policy (node fallback allowed by default) |
| `clientMutationId` | string | no | accepted by the schema but not read by this handler — see Notes |

Example request:
```json
{ "allowNode": false }
```

**Response** — 200; `data` is `NodeCredentialPolicyEntry`:

| field | type | description |
|---|---|---|
| `provider` | string | echoes the path param |
| `allowNode` | boolean \| null | the value just set |

Example:
```json
{ "data": { "provider": "anthropic", "allowNode": false }, "requestId": "req_000041" }
```

**Errors** — `invalid_input` (400) — `:provider` is not one of
`anthropic`/`openai`/`github`. `forbidden` (403) — same two reasons as
`node.credentials.status` (`credentials_human_only`, `node_admin_required`).
**Notes** — **not idempotency-ledgered**: although `NodeCredentialsPolicySetInputSchema`
accepts an optional `clientMutationId`, `principalFor`/`claimsOf` in this
handler builds claims with no command envelope and `setNodePolicy` is called
without it — a retried call simply re-applies the same policy (naturally
idempotent as a set, not ledger-deduplicated). No `expectedVersion`.
Source: catalog `catalog.ts:499`; schema `schemas.ts:2168-2170`; handler
`credentials.ts:474-480`; service `SpaceCredentialCatalogService.setNodePolicy`
(`space-credential-catalog.ts:351-358`).
