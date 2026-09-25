# Credentials

The `credentials.*` family covers three things a member manages under Settings: **per-member
vendor credentials** (`credentials.status`, `.delete`, `.loginSessions.*`) — the Anthropic,
OpenAI, GitHub, Gemini, Hermes, Cursor, Kimi and Groq accounts a human connects for agent
spawns to use; **server-side service keys** (`credentials.serviceKeys.*`) — today only
`typesafe`, the key tm8 itself uses to answer ✦ Ask Jev, sealed at rest and never injected
into a spawned session; and **space credentials** (`credentials.space.*`, design 01a0cfa8,
migration 206) — API keys or GitHub tokens a space owns and shares among its members, plus the
per-space/per-node **policy** that decides which credential sources (`member` / `space` /
`node`) a space accepts per provider.

Every one of these 15 operations is **human-session-only**, `status` and reads included — an
agent's bearer token carries its owner's full identity (not a reduced principal), so an
unguarded read would leak the owner's login metadata and an unguarded delete would revoke the
owner's token. The guard (`requireHumanSession`, layer 1) checks only the server-resolved
`ctx.identity.authKind` and admits `browser` and `cli` — never `agent`. A second, unbypassable
layer (`internal.require_human_auth_kind()`) re-checks the same fact inside every credential
RPC. All 15 rows are registered — none answer `501`. **None have a CLI command** (`cmd: null`
for all 15 in `packages/cli/src/discovery/operations.ts:307-504`): the guard already admits a
`cli`-kind human session, so adding CLI commands is scope, not a security change, per that
file's own comment.

## Summary

| Operation | Method | Path | Kind | Served |
|---|---|---|---|---|
| `credentials.status` | GET | `/v2/identity/credentials` | read | yes |
| `credentials.delete` | DELETE | `/v2/identity/credentials/:provider` | command | yes |
| `credentials.loginSessions.start` | POST | `/v2/identity/credentials/login-sessions` | command | yes |
| `credentials.loginSessions.finish` | POST | `/v2/identity/credentials/login-sessions/:id/finish` | command | yes |
| `credentials.serviceKeys.status` | GET | `/v2/identity/credentials/service-keys` | read | yes |
| `credentials.serviceKeys.put` | PUT | `/v2/identity/credentials/service-keys/:provider` | command | yes |
| `credentials.serviceKeys.delete` | DELETE | `/v2/identity/credentials/service-keys/:provider` | command | yes |
| `credentials.space.list` | GET | `/v2/spaces/:spaceId/credentials` | read | yes |
| `credentials.space.create` | POST | `/v2/spaces/:spaceId/credentials` | command | yes |
| `credentials.space.rekey` | PUT | `/v2/space-credentials/:credentialId/secret` | command | yes |
| `credentials.space.setDefault` | POST | `/v2/space-credentials/:credentialId/default` | command | yes |
| `credentials.space.rename` | PATCH | `/v2/space-credentials/:credentialId` | command | yes |
| `credentials.space.delete` | DELETE | `/v2/space-credentials/:credentialId` | command | yes |
| `credentials.space.policy.get` | GET | `/v2/spaces/:spaceId/credential-policy` | read | yes |
| `credentials.space.policy.set` | PUT | `/v2/spaces/:spaceId/credential-policy/:provider` | command | yes |

All 15 rows are `status: v1` (none `reserved`). Source: `packages/contract/src/catalog.ts:473-496`.
Two sibling rows, `node.credentials.status` and `node.credentials.policy.set`
(`catalog.ts:498-499`), are the node-admin fallback surface and are **not** in this group's
scope; `credentials.space.policy.get`'s response embeds a read-only view of that same node
policy (see `CredentialsSpacePolicyView` below) — documented there, not repeated here.

Handler registration: `packages/server/src/facade/handlers/w2/credentials.ts:486-504`
(`registerCredentialHandlers`), delegating to `W2CredentialCatalogService`
(`packages/server/src/facade/services/w2/credential-catalog.ts`, `status`/`delete`),
`W2CredentialSessionsService` (`.../credential-sessions.ts`, `start`/`finish`),
`DbServiceKeyStore` (`packages/server/src/credentials/service-key-store.ts`, service keys) and
`SpaceCredentialCatalogService` (`.../space-credential-catalog.ts`, `credentials.space.*`).
Input schemas: `packages/server/src/facade/input-schemas.ts:212-224`.

## Shared types

Defined in `packages/contract/src/contract.ts` (types) / `packages/contract/src/schemas.ts`
(Zod), referenced by name below.

**Envelope.** Every response is `{ "data": <shape below>, "requestId": "req_..." }`, HTTP `200`
for all 15 ops (`packages/server/src/http/server.ts:521,556` — no handler here sets a
non-default status).

**Enums**
- `CredentialProviderName` (member vendor credentials, `schemas.ts:1941-1942`): `anthropic | openai | github | gemini | hermes | cursor | kimi | groq`. `kimi` and `groq` run tm8's own paste harness rather than a vendor CLI, but the wire does not distinguish them from an OAuth provider.
- `ServiceKeyProviderName` (`schemas.ts:2006`): `typesafe` only — deliberately not a member of `CredentialProviderName`, since service keys are never agent credentials.
- `SpaceCredentialProviderName` (`schemas.ts:2048`): `anthropic | openai | github`.
- `SpaceCredentialShape` (`schemas.ts:2050`): `login | api_key | token`. `credentials.space.create` only ever creates `api_key` or `token` (a `login`-shaped space credential is created by `credentials.loginSessions.start`/`.finish` with `spaceCredential` set — see below).
- `SpaceCredentialStatus` (`schemas.ts:2051`): `pending | active | stale | revoked`.
- `CredentialPolicySource` (`schemas.ts:2053`): `member | space | node` — which layer a space is willing to accept a credential from, per provider.
- `CredentialStatus` (internal to `CredentialConnectionView.status`, `schemas.ts:1945`): `active | stale | revoked`, widened on the wire to also admit `unavailable` (a node measurement, never persisted) and `null` (no row at all).

**`CredentialConnectionView`** (one entry per provider in `credentials.status`'s `providers` array, `schemas.ts:1957-1975`):

| field | type | description |
|---|---|---|
| `provider` | `CredentialProviderName` | |
| `connected` | boolean | Only an `active` stored row (and an available CLI, see Notes) counts. |
| `login` | string \| null | Never populated for `anthropic` (R4). |
| `authMethod` | string \| null | |
| `status` | `CredentialStatus \| 'unavailable' \| null` | `unavailable` = the vendor CLI isn't installed on this node; `null` = no credential row. |
| `connectedAt` | string (ISO) \| null | |
| `lastVerifiedAt` | string (ISO) \| null | |
| `routing` | `CredentialRoutingView` \| null | Non-null only for the two providers (`kimi`, `groq`) that route through another connected provider's backend. |

**`CredentialRoutingView`** (`schemas.ts:1950-1955`): `{ agentTool: string, role: 'backend', counterpart: CredentialProviderName, active: boolean }`.

**`SpaceCredentialView`** (the shape every `credentials.space.*` mutation and `.list` returns per row, `schemas.ts:2066-2082`):

| field | type | description |
|---|---|---|
| `id` | string | |
| `spaceId` | string | |
| `provider` | `SpaceCredentialProviderName` | |
| `shape` | `SpaceCredentialShape` | |
| `label` | string | 1..80 chars, unique per space+provider. |
| `isDefault` | boolean | What a launch naming the space source without an id uses. |
| `status` | `SpaceCredentialStatus` | |
| `createdByAccountId` | string \| null | |
| `displayLogin` | string \| null | The vendor probe's verdict at create/rekey time — never the secret. |
| `keyHint` | string (≤4 chars) \| null | Last four characters at most. |
| `createdAt` / `updatedAt` / `lastUsedAt` / `lastProbeAt` | string (ISO) \| null | |

**`ServiceKeyView`** (`schemas.ts:2014-2021`): `{ provider: ServiceKeyProviderName, connected: boolean, keyHint: string(≤4)|null, updatedAt: string|null, nodeFallback: boolean }`. `nodeFallback` is one boolean — whether the node environment (`TYPESAFE_API_KEY`) carries a fallback — never the key itself.

**Idempotency.** Every command body here admits an optional `clientMutationId: string (min 1)`; none require it (unlike `forms.*`). None of these DTOs declare `actorId`/`commandContextShape` — deliberately: a credential operation must never run on another actor's behalf (finding D2), so an acting-as claim on the wire is a `400` (`.strict()` schema), not a field the server has to remember to ignore.

**Common error** — `forbidden`, `details.reason: 'credentials_human_only'`: the caller's session `authKind` is not `browser` or `cli` (an agent token, or no resolved kind). Raised at the facade (`requireHumanSession`, `packages/server/src/facade/handlers/w2/credentials.ts:129-141`) for the per-member and service-key ops, and again inside `SpaceCredentialCatalogService`/SQL for the space ops. Not repeated per operation below.

---

### `credentials.status`
`GET /v2/identity/credentials` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/credential-catalog.ts:264-329`)
CLI: none

Reads the merged connection status of every vendor credential this member (identity) can
have, in a fixed provider order, plus whether the string-shaped GitHub credential store
(migration 093) exists on this node at all.

**Path params** — none.

**Response** — 200; `data` is `CredentialsStatusView`:

| field | type | description |
|---|---|---|
| `providers` | `CredentialConnectionView[]` | One entry per `CredentialProviderName`, always all 8, in the fixed provider order. An absent row renders as `connected: false`, every other field `null`. |
| `gitCredentialStore` | `'present' \| 'absent'` | Honest degradation: `absent` means the github entry's `connected` is **unmeasured**, not measured false. |

```json
{ "data": { "providers": [
      { "provider": "anthropic", "connected": true, "login": null, "authMethod": "oauth",
        "status": "active", "connectedAt": "2026-08-01T00:00:00Z",
        "lastVerifiedAt": "2026-09-20T00:00:00Z", "routing": null },
      { "provider": "github", "connected": false, "login": null, "authMethod": null,
        "status": null, "connectedAt": null, "lastVerifiedAt": null, "routing": null }
    ], "gitCredentialStore": "present" },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — none beyond the common `credentials_human_only` forbidden.

**Notes** — Read-only; no idempotency key. `status`/`connected` are further overlaid per
provider with a **node measurement** of whether the vendor's CLI binary is actually
installed/resolvable (`withMeasuredAvailability`): an unresolvable binary forces
`connected: false, status: 'unavailable'`; a resolver failure forces
`status: 'stale'`. This overlay runs *after* authorization, deliberately, so an unauthenticated
caller never learns which CLIs a node has installed. Source: `packages/contract/src/catalog.ts:473`;
schema `schemas.ts:1977-1983`.

---

### `credentials.delete`
`DELETE /v2/identity/credentials/:provider` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/credential-catalog.ts:415-447`)
CLI: none

Disconnects one vendor credential: revokes the stored credential (row + on-disk bytes) first,
then kills the login terminal for that (account, provider) pair, then the account's live agent
sessions that were carrying that provider's credential. This is **containment, not
revocation** — a process that already read the secret keeps holding it; only rotating the
credential at the vendor invalidates it.

**Path params**

| name | type | description |
|---|---|---|
| `provider` | `CredentialProviderName` | Validated against the schema enum, not a hand-kept list. |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | no | min 1 | |

Example request: `DELETE /v2/identity/credentials/github`

**Response** — 200; `data` is `CredentialsDeleteResult`:

| field | type | description |
|---|---|---|
| `provider` | `CredentialProviderName` | |
| `revoked` | boolean | Whether step 1 (the row/bytes) succeeded. |
| `terminatedCredentialSessionIds` | string[] | Login terminals killed. |
| `terminatedAgentSessionIds` | string[] | Agent sessions killed. |
| `failures` | `{step: 'revoke'\|'credentialSession'\|'agentSession', sessionId?: string, reason: string}[]` | Best-effort: a failed kill never un-revokes. |

```json
{ "data": { "provider": "github", "revoked": true,
    "terminatedCredentialSessionIds": [], "terminatedAgentSessionIds": ["ws_1..."],
    "failures": [] },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (unsupported provider path segment). For `github` specifically, if
the node has no string-shaped credential store (migration 093 not present), nothing is thrown —
the row-1 failure is instead recorded in `failures` with `step: 'revoke'` and `revoked: false`.

**Notes** — Idempotent in effect (deleting an already-absent credential is a no-op success);
`clientMutationId` optional, feeds the command ledger when enabled. No `expectedVersion`
(credentials aren't versioned entities). Side effects: kills PTYs and agent sessions server-side
(see description). Source: `packages/contract/src/catalog.ts:474`; schema `schemas.ts:1985-1999`;
handler `credential-catalog.ts:415-520` (revoke ordering rationale at `:1-65`).

---

### `credentials.loginSessions.start`
`POST /v2/identity/credentials/login-sessions` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/credential-sessions.ts:397` `start()`)
CLI: none

Opens a short-lived PTY terminal in which the member completes a vendor login (OAuth device
code, or tm8's own paste harness for `kimi`/`groq`). If `spaceCredential` is set, the login is
onto a **space**-owned credential (`anthropic`/`openai` only) instead of the member's own.

**Path params** — none.

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `spaceId` | string (EntityId) | yes | | |
| `provider` | `CredentialProviderName` | yes | | |
| `cols` | number | no | int, 1..1000 | Terminal geometry only — no command/args/flags field exists on this input by design. |
| `rows` | number | no | int, 1..1000 | |
| `spaceCredential` | `{label: string(1..80)}` \| `{credentialId: string(uuid)}` | no | exactly one shape | Names a new space credential (by label) or an existing one to re-login (by id). Only valid when `provider` is `anthropic` or `openai`. |
| `clientMutationId` | string | no | min 1 | |

Example request:
```json
POST /v2/identity/credentials/login-sessions
{ "spaceId": "3e5d...", "provider": "anthropic" }
```

**Response** — 200; `data` is `CredentialsLoginSessionStartResult`:

| field | type | description |
|---|---|---|
| `workSessionId` | string (EntityId) | Id used to `.finish` this login. |
| `spaceId` | string | |
| `provider` | `CredentialProviderName` | |
| `expiresAt` | string (ISO) | Deliberately shorter than the vendor's device-code lifetime. |
| `command` | string | The command the terminal runs. |
| `spaceCredential` | `SpaceCredentialView` | Only present when `spaceCredential` was requested. |

```json
{ "data": { "workSessionId": "ws_1...", "spaceId": "3e5d...", "provider": "anthropic",
    "expiresAt": "2026-09-25T12:10:00Z", "command": "claude setup-token" },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (unsupported provider; a space login naming both or neither of
`label`/`credentialId`; the node's vendor CLI is not installed, message names the binary);
`forbidden` (an acting-as claim reached the service — finding D2 — or, for a space login, a
non-human `authKind`, `details.reason: 'credentials_human_only'`); `conflict`
(`details.reason: 'login_open'` — a login onto this space credential, or a member login for
this provider, is already open elsewhere; retry after finishing/closing it); `upstream_unavailable`
(the node could not determine whether the vendor CLI is installed).

**Notes** — Not idempotent in the usual sense (each call opens a new PTY); `clientMutationId`
optional. One live login terminal per (account, provider) or per space credential is enforced
by a unique index; the RPC (`start_credential_session` / space equivalent) derives the account
from the caller's own membership (never `internal.resolve_actor`) so a login can never be
opened as another actor. Side effects: mints a `work_session` row (`session_kind='credential'`,
`share_mode='none'`), spawns a PTY. Source: `packages/contract/src/catalog.ts:475`; schema
`schemas.ts:2190-2208`; handler `packages/server/src/facade/handlers/w2/credentials.ts:331-346`;
service `credential-sessions.ts:397-514` (member), `:1104-1209` (space).

---

### `credentials.loginSessions.finish`
`POST /v2/identity/credentials/login-sessions/:id/finish` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/credential-sessions.ts:531` `finish()`)
CLI: none

Closes a login terminal and records what the verification **probe** established — never the
terminal's exit code (a member who reads the device code and closes the tab exits `0` having
captured nothing).

**Path params**

| name | type | description |
|---|---|---|
| `id` | string | The `workSessionId` returned by `.start`. |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | no | min 1 | |

Example request: `POST /v2/identity/credentials/login-sessions/ws_1.../finish`

**Response** — 200; `data` is `CredentialsLoginSessionFinishResult`:

| field | type | description |
|---|---|---|
| `workSessionId` | string | |
| `provider` | `CredentialProviderName` | |
| `connected` | boolean | The probe's verdict. |
| `login` | string \| null | |
| `authMethod` | string \| null | |
| `status` | `CredentialStatus` (`active\|stale\|revoked`) | |
| `stored` | boolean | Separate from `connected` on purpose: a verified GitHub login is `connected: true, stored: false` where 093 isn't present. |
| `terminated` | boolean | Whether the PTY was actually killed. |
| `spaceCredential` | `SpaceCredentialView` | Only present for a space login. |

```json
{ "data": { "workSessionId": "ws_1...", "provider": "anthropic", "connected": true,
    "login": "user@example.com", "authMethod": "oauth", "status": "active",
    "stored": true, "terminated": true },
  "requestId": "req_..." }
```
(illustrative, from schema — login/email replaced with `<redacted>`-style placeholder)

**Errors** — `not_found` (no live credential session on this node for that `workSessionId` —
also the answer for someone else's session, deliberately, so this can't be used to probe which
ids are live); `upstream_unavailable` (`details` none — the PTY host could not kill the
terminal, or the probe itself failed and there is no other outcome to report).

**Notes** — Idempotent in effect: calling `.finish` again on an already-closed session answers
the recorded outcome rather than `not_found` (a sweep or a second click must not turn a
successful login into a reported failure). Side effect: writes the credential row (member) or
promotes the space credential from its staging home to the live one (space, `SC-4`) **only on
a positive probe** — a `stale` probe writes nothing rather than a `stale` row. Source:
`packages/contract/src/catalog.ts:476`; schema `schemas.ts:2220-2239`; handler
`packages/server/src/facade/handlers/w2/credentials.ts:348-368`; service
`credential-sessions.ts:531-604` (`finish`), `:1227-` (`runSpaceClose`, promote order).

---

### `credentials.serviceKeys.status`
`GET /v2/identity/credentials/service-keys` · kind: read · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/credentials.ts:386-395`)
CLI: none

Reads which server-side service keys (today: `typesafe`, used for ✦ Ask Jev) this member has
stored, and whether this node has a fallback key of its own.

**Path params** — none.

**Response** — 200; `data` is `CredentialsServiceKeysStatusView`:

| field | type | description |
|---|---|---|
| `keys` | `ServiceKeyView[]` | One entry per `ServiceKeyProviderName` (today just `typesafe`). |
| `store` | `'present' \| 'absent'` | Whether the member's service-key store exists at all. |

```json
{ "data": { "keys": [
      { "provider": "typesafe", "connected": true, "keyHint": "ab12", "updatedAt": "2026-09-01T00:00:00Z", "nodeFallback": false } ],
    "store": "present" },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — none beyond the common `credentials_human_only` forbidden.

**Notes** — Read-only. `keyHint` is at most 4 characters — never enough to use. A service key
is used by the server for this member's own requests and is never injected into a spawned
agent session (that's what separates it from `CredentialProviderName`). Source:
`packages/contract/src/catalog.ts:481`; schema `schemas.ts:2023-2026`.

---

### `credentials.serviceKeys.put`
`PUT /v2/identity/credentials/service-keys/:provider` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/credentials.ts:397-404`)
CLI: none

Stores or replaces this member's service key for the given provider, encrypted at rest. The
key is re-parsed (trimmed) inside the handler and is never echoed back — only its response's
last-four-character `keyHint`.

**Path params**

| name | type | description |
|---|---|---|
| `provider` | `ServiceKeyProviderName` | `typesafe` only. |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `apiKey` | string | yes | trimmed, 8..1024 chars, no internal whitespace | |
| `clientMutationId` | string | no | min 1 | |

Example request:
```json
PUT /v2/identity/credentials/service-keys/typesafe
{ "apiKey": "<redacted>" }
```

**Response** — 200; `data` is `ServiceKeyView` (see Shared types).

```json
{ "data": { "provider": "typesafe", "connected": true, "keyHint": "ab12",
    "updatedAt": "2026-09-25T00:00:00Z", "nodeFallback": false },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (key too short/long, contains whitespace, or unsupported provider
path segment) beyond the common `credentials_human_only` forbidden.

**Notes** — Replaces any existing key for that provider; `clientMutationId` optional. Source:
`packages/contract/src/catalog.ts:482`; schema `schemas.ts:2028-2033`.

---

### `credentials.serviceKeys.delete`
`DELETE /v2/identity/credentials/service-keys/:provider` · kind: command · status: v1 · served: yes (`packages/server/src/facade/handlers/w2/credentials.ts:406-413`)
CLI: none

Removes this member's stored service key. Ask Jev then falls back to the node's own key, if
the node has one.

**Path params**

| name | type | description |
|---|---|---|
| `provider` | `ServiceKeyProviderName` | `typesafe` only. |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | no | min 1 | |

Example request: `DELETE /v2/identity/credentials/service-keys/typesafe`

**Response** — 200; `data` is `CredentialsServiceKeyDeleteResult`: `{ provider: ServiceKeyProviderName, revoked: true }`.

```json
{ "data": { "provider": "typesafe", "revoked": true }, "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — none beyond the common `credentials_human_only` forbidden (unsupported provider
path segment is `invalid_input`).

**Notes** — Idempotent: deleting an absent key is already the requested state; no session is
ever killed since no session holds a service key. Source: `packages/contract/src/catalog.ts:483`;
schema `schemas.ts:2035-2042`.

---

### `credentials.space.list`
`GET /v2/spaces/:spaceId/credentials` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:112-115`)
CLI: none

Lists a space's shared agent credentials (metadata only — never a secret). Any member of the
space may list; revoked credentials are not returned.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string | |

**Response** — 200; `data` is `CredentialsSpaceListView`: `{ spaceId: string, credentials: SpaceCredentialView[] }`.

```json
{ "data": { "spaceId": "3e5d...", "credentials": [
      { "id": "sc_1...", "spaceId": "3e5d...", "provider": "github", "shape": "token",
        "label": "CI bot", "isDefault": true, "status": "active", "createdByAccountId": "acc_1...",
        "displayLogin": "ci-bot", "keyHint": "wxyz", "createdAt": "2026-08-01T00:00:00Z",
        "updatedAt": "2026-08-01T00:00:00Z", "lastUsedAt": null, "lastProbeAt": null } ] },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — none beyond the common `credentials_human_only` forbidden (RLS scopes the query to
members; a non-member sees an empty list rather than `forbidden`, per `internal.is_space_member`
scoping used elsewhere in this file).

**Notes** — Read-only, no pagination cursor (a space's credential set is small). Source:
`packages/contract/src/catalog.ts:489`; schema `schemas.ts:2084-2087`.

---

### `credentials.space.create`
`POST /v2/spaces/:spaceId/credentials` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:118-149`)
CLI: none

Adds an `api_key`- or `token`-shaped space credential — **after** the vendor accepts it (I6):
the secret is probed against the vendor first, and a refused key is never stored. D1: any
member may create one.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `provider` | `SpaceCredentialProviderName` | yes | | |
| `shape` | `'api_key' \| 'token'` | yes | `github` ⇒ must be `token`; `anthropic`/`openai` ⇒ must be `api_key` | |
| `label` | string | yes | trimmed, 1..80 chars | |
| `secret` | string | yes | trimmed, 8..4096 chars, no internal whitespace | Never stored if the vendor rejects it. |
| `clientMutationId` | string | no | min 1 | |

Example request:
```json
POST /v2/spaces/3e5d.../credentials
{ "provider": "github", "shape": "token", "label": "CI bot", "secret": "<redacted>" }
```

**Response** — 200; `data` is `SpaceCredentialView` (see Shared types).

```json
{ "data": { "id": "sc_2...", "spaceId": "3e5d...", "provider": "github", "shape": "token",
    "label": "CI bot", "isDefault": false, "status": "active", "createdByAccountId": "acc_1...",
    "displayLogin": "ci-bot", "keyHint": "wxyz", "createdAt": "2026-09-25T00:00:00Z",
    "updatedAt": "2026-09-25T00:00:00Z", "lastUsedAt": null, "lastProbeAt": "2026-09-25T00:00:00Z" },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `invalid_input` (`provider`/`shape` mismatch caught by the schema `.refine`; the
vendor rejected the key, `details.reason: 'credential_rejected'`); `forbidden` (`'not a member
of this space'`); `upstream_unavailable` (the vendor could not be reached to check the key,
`details.reason: 'credential_probe_unreachable'`).

**Notes** — Not idempotent against a duplicate label at the API layer beyond the store's own
uniqueness; `clientMutationId` optional. The stored secret is sealed with the node credential
key; the probe and store never log or echo the raw secret. Source:
`packages/contract/src/catalog.ts:490`; schema `schemas.ts:2089-2100`; handler
`packages/server/src/facade/handlers/w2/credentials.ts:433-437`.

---

### `credentials.space.rekey`
`PUT /v2/space-credentials/:credentialId/secret` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:156-196`)
CLI: none

Replaces a space credential's secret. D11: only its creator or a space admin. The new secret is
probed against the vendor before it replaces the old one; live sessions keep the old secret,
the next spawn picks up the new one.

**Path params**

| name | type | description |
|---|---|---|
| `credentialId` | string | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `secret` | string | yes | trimmed, 8..4096 chars, no internal whitespace | |
| `clientMutationId` | string | no | min 1 | |

Example request:
```json
PUT /v2/space-credentials/sc_2.../secret
{ "secret": "<redacted>" }
```

**Response** — 200; `data` is `SpaceCredentialView`.

**Errors** — `not_found` (no such credential); `forbidden` (`"only the credential's creator or
a space admin can change it"`); `invalid_input` (the credential is `shape: 'login'` — a login
credential is renewed by logging in again, not by pasting a key; or the vendor rejected the new
key, `details.reason: 'credential_rejected'`); `invariant_violation` (the credential is not
`active`/`stale` — e.g. already `revoked`); `upstream_unavailable`
(`details.reason: 'credential_probe_unreachable'`).

**Notes** — `clientMutationId` optional. `provider`/`shape` never change on rekey. Source:
`packages/contract/src/catalog.ts:491`; schema `schemas.ts:2102-2105`.

---

### `credentials.space.setDefault`
`POST /v2/space-credentials/:credentialId/default` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:202-204`)
CLI: none

Makes a space credential its provider's default — what a launch uses when it names the space
source without an explicit credential id. D11: creator or space admin.

**Path params**

| name | type | description |
|---|---|---|
| `credentialId` | string | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | no | min 1 | |

**Response** — 200; `data` is `SpaceCredentialView` (with `isDefault: true`).

**Errors** — `not_found`; `forbidden` (not creator/space admin) — both raised by the underlying
RPC (`store.setDefault`), not spelled out separately in the service.

**Notes** — `clientMutationId` optional; no request body fields beyond it
(`CredentialsSpaceCommandInputSchema`). Source: `packages/contract/src/catalog.ts:492`; schema
`schemas.ts:2112-2114`.

---

### `credentials.space.rename`
`PATCH /v2/space-credentials/:credentialId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:198-200`)
CLI: none

Renames a space credential. Labels are unique per space and provider.

**Path params**

| name | type | description |
|---|---|---|
| `credentialId` | string | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `label` | string | yes | trimmed, 1..80 chars | |
| `clientMutationId` | string | no | min 1 | |

**Response** — 200; `data` is `SpaceCredentialView` (with the new `label`).

**Errors** — `not_found`; `forbidden` (not creator/space admin); `conflict` (label already in
use for that space+provider) — all raised by the underlying store/RPC.

**Notes** — `clientMutationId` optional. Source: `packages/contract/src/catalog.ts:493`; schema
`schemas.ts:2107-2110`.

---

### `credentials.space.delete`
`DELETE /v2/space-credentials/:credentialId` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:216-312`)
CLI: none

Deletes a space credential and kills every live session using it, whoever launched it. Order:
(1) revoke the row — this is the authorization check and the point of no return; (2) read every
live session and open login terminal on it; (3) kill each; (4) stamp each killed login terminal
finished; (5) remove a login credential's file home last. Steps after (1) are best-effort and
reported in `failures`, never rolled back.

**Path params**

| name | type | description |
|---|---|---|
| `credentialId` | string | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `clientMutationId` | string | no | min 1 | |

**Response** — 200; `data` is `CredentialsSpaceDeleteResult`:

| field | type | description |
|---|---|---|
| `credentialId` | string | |
| `revoked` | boolean | |
| `terminatedLoginSessionIds` | string[] | |
| `terminatedAgentSessionIds` | string[] | |
| `failures` | `{step: 'loginSession'\|'agentSession'\|'files', sessionId?: string, reason: string}[]` | |

```json
{ "data": { "credentialId": "sc_2...", "revoked": true,
    "terminatedLoginSessionIds": [], "terminatedAgentSessionIds": ["ws_2..."],
    "failures": [] },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — `not_found` / `forbidden` (not creator/space admin) from the revoke step (the RPC
decides — not spelled out as separate throws in this service; a failure here is the returned
answer, since revoke is not best-effort).

**Notes** — `clientMutationId` optional. `revoked: true` alongside a non-empty `failures` is a
correct, expected partial-disconnect answer, not a contradiction. Source:
`packages/contract/src/catalog.ts:494`; schema `schemas.ts:2112-2126`.

---

### `credentials.space.policy.get`
`GET /v2/spaces/:spaceId/credential-policy` · kind: read · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:314-327`)
CLI: none

Reads which credential sources (`member`/`space`/`node`) a space accepts per provider, and the
node's own fallback policy alongside it.

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string | |

**Response** — 200; `data` is `CredentialsSpacePolicyView`:

| field | type | description |
|---|---|---|
| `spaceId` | string | |
| `providers` | `SpaceCredentialPolicyEntry[]` | `{provider: SpaceCredentialProviderName, allowedSources: CredentialPolicySource[]|null}` — `null` means no policy: every source allowed. |
| `node` | `NodeCredentialPolicyEntry[]` | `{provider: SpaceCredentialProviderName, allowNode: boolean|null}` — the node-admin policy this group's `node.credentials.policy.set` sets (out of scope here; read-only echo). |

```json
{ "data": { "spaceId": "3e5d...", "providers": [
      { "provider": "anthropic", "allowedSources": null },
      { "provider": "github", "allowedSources": ["space", "member"] } ],
    "node": [ { "provider": "anthropic", "allowNode": null } ] },
  "requestId": "req_..." }
```
(illustrative, from schema)

**Errors** — none beyond the common `credentials_human_only` forbidden.

**Notes** — Read-only. Source: `packages/contract/src/catalog.ts:495`; schema
`schemas.ts:2138-2142`.

---

### `credentials.space.policy.set`
`PUT /v2/spaces/:spaceId/credential-policy/:provider` · kind: command · status: v1 · served: yes (`packages/server/src/facade/services/w2/space-credential-catalog.ts:330-338`)
CLI: none

Sets which credential sources a space allows for one provider. Space admin only (D5, RPC-checked).

**Path params**

| name | type | description |
|---|---|---|
| `spaceId` | string | |
| `provider` | `SpaceCredentialProviderName` | |

**Request body**

| field | type | required | constraints | description |
|---|---|---|---|---|
| `allowedSources` | `CredentialPolicySource[]` \| `null` | yes | 1..3 items, no repeats; `null` removes the policy | |
| `clientMutationId` | string | no | min 1 | |

Example request:
```json
PUT /v2/spaces/3e5d.../credential-policy/github
{ "allowedSources": ["space", "member"] }
```

**Response** — 200; `data` is `CredentialsSpacePolicySetResult`: `{ spaceId, provider, allowedSources }`.

**Errors** — `invalid_input` (a source named twice, or an unsupported provider path segment);
`forbidden` (not a space admin) — raised by the RPC.

**Notes** — `clientMutationId` optional. Source: `packages/contract/src/catalog.ts:496`; schema
`schemas.ts:2144-2150`.
