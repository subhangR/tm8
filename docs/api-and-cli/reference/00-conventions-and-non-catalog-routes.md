# Conventions and non-catalog routes

This file covers what every operation in the other 14 reference files shares
— transport, envelope, errors, auth, idempotency, pagination, rate limiting —
plus every HTTP route `tm8-server` answers that is **not** generated from the
operation catalog (`packages/contract/src/catalog.ts`). The catalog-driven
router (`packages/server/src/http/router.ts`) is a pure projection of
`MOUNTED_OPERATIONS`: "if you find yourself typing a path string into
[router.ts], the catalog is wrong, not the router" (router.ts:9). Everything
documented here instead lives in the request pipeline itself
(`packages/server/src/http/server.ts`) as a hand-wired dispatch that runs
*before* or *around* the catalog router, because each one either carries raw
bytes (never JSON), authenticates a non-tm8 caller, or is infrastructure
rather than an operation.

## Summary — non-catalog routes

| Route | Method | Path | Auth | Served |
|---|---|---|---|---|
| Liveness probe | GET | `/health` | none | yes (`server.ts:255-310`) |
| Artifact preview | GET, HEAD | `/p/:sessionId/:token/*` | capability token in path | yes (`artifact-preview.ts:171-328`) |
| Raw file upload | PUT | `/v2/files/uploads/:uploadId/content` | identity + `FileUploadGrant` token | yes (`w2-file-upload.ts:99-193`) |
| Clipboard image upload | POST | `/v2/clipboard/images?sessionId=` | identity (RLS on the session entity) | yes (`clipboard-upload.ts:55-114`) |
| LiveKit voice webhook | POST | `/v2/voice/webhook` | LiveKit HMAC signature | yes (`voice-webhook.ts:101-176`) |
| Named-Server relay | any + WS upgrade | `/v2/server-connections/:name/proxy/*` | forwarded (no tm8 identity check at this hop) | yes (`remote-proxy.ts:96-176`) |
| Static UI bundle | GET | anything not `/v2/*` or `/health` | none | yes when `TM8_UI_DIR` is set (`static.ts:62-106`) |

None of these rows exist in `OPERATIONS`; they are not `read`/`command`/`stream`
and have no `status: v1|reserved` — "served" here just means "this node has
the route wired," which for every one of them is unconditional except static
(absent when `TM8_UI_DIR` is unset) and depends on optional constructor
options being passed to `createFacadeServer` (`server.ts:78-154`).

---

## Base URL, the `/v2` mount, and space addressing

`tm8-server` binds loopback-only by default (`127.0.0.1`, `TM8_PORT` default
`4610`; a non-loopback `TM8_BIND` is a boot-time config error, S1 — see
`config.ts:447-452`). Every catalog operation is mounted under `BASE_PATH =
'/v2'` (`packages/contract/src/catalog.ts:47`); non-catalog routes above are
the exceptions (`/health`, `/p/...`, and the static bundle sit outside it).

A Space is addressed as a path segment, `:spaceId`, on almost every catalog
route (`/v2/spaces/:spaceId/...`); there is no header or query-string form.
Path params use `:name` notation in the catalog and match exactly one
non-empty, non-`/` URL segment, percent-decoded (`router.ts:11-13,66-119`).
The one grammar exception is a trailing `*` wildcard, which binds the
remainder of the path *including slashes* to a `rest` param — used today only
by `containers.proxy` (`router.ts:56-64`). IDs (`EntityId`, `SpaceId`, etc.)
are plain strings (`packages/contract/src/contract.ts:31-32`) and are UUIDs
by convention; several non-catalog routes enforce the UUID shape by regex at
the transport boundary (e.g. `w2-file-upload.ts:14`, `clipboard-upload.ts:37`,
`artifact-preview.ts:99`).

## Authentication

One identity resolver serves every transport — HTTP, WS upgrade, and the raw
support routes — deliberately, because a resolver only some transports run
through is a resolver whose bugs some transports never exercise
(`identity-resolver.ts:1-16`). `RequestIdentity.kind` is one of
`'auto-owner' | 'bearer' | 'anonymous'` (`packages/server/src/http/types.ts:22-67`):

- **Session cookie** — `__Host-tm8-session` (`session-cookie.ts:4`), an
  `HttpOnly; Secure; SameSite=Strict; Path=/` cookie set at `auth.login`/
  `auth.signup`. Read via `readTm8SessionCookie` (`session-cookie.ts:6-18`).
  The browser UI's only carrier — a native WebSocket cannot attach a custom
  header, so the cookie is how it authenticates too.
- **Bearer tokens** — `Authorization: Bearer tm8s_<sessionId>.<secret>`
  (`TOKEN_PREFIX = 'tm8s_'`, `identity/crypto.ts:104`). The CLI and spawned
  agent carrier. Resolved by `resolveBearerIdentity` against the session's
  token hash, never a client-asserted claim.
- **Agent tokens** are the same bearer mechanism with `authKind` recorded on
  the verified session row as `'agent'` or `'agent_runtime'`
  (`AuthSessionKindView`, `contract.ts:1786`) — server-resolved, never
  client-supplied, and becomes `SET LOCAL tm8.auth_kind` (types.ts:42-55).
  `agent`/`agent_runtime` are never accepted at `auth.login` (internal mints
  only).
- **Both present and disagreeing is a hard refusal.** If a request carries
  both an `Authorization` bearer and a session cookie, they must name the
  *same* token, or the request is refused `unauthenticated` /
  `conflicting authentication credentials` (`identity-resolver.ts:55-57`) —
  this is why a capability token (e.g. the upload grant) must never ride in
  `Authorization` on a browser-reachable route; see `TM8_UPLOAD_TOKEN_HEADER`
  below.
- **Auto-owner (S5/T-L7)** — the single-machine default: a loopback TCP peer
  with no `X-Forwarded-*`/`X-Real-IP` evidence and no session/bearer
  credential is auto-authenticated as the node's owner
  (`autoOwnerResolver`, `security.ts:275-287`), unless
  `TM8_DISABLE_AUTO_OWNER`/`disableAutoOwner` is set. A reverse proxy also
  connects over loopback, so `hasForwardingEvidence` narrows to anonymous the
  moment a forwarding header appears (`security.ts:264-266`).
- **Login/signup dead-cookie recovery** — for `auth.login`/`auth.signup`
  only, a revoked session cookie that would otherwise refuse the whole
  request is stripped and identity is re-resolved as if it were absent
  (`server.ts:398-425`) — otherwise a password reset can permanently lock a
  browser out of its own re-authentication.

Transport-level checks (`http/security.ts`) run before identity resolution:
S2 Host allowlist (loopback names + `extraAllowedHostnames`), S3 Origin
allowlist (a request with no `Origin` is a non-browser client and is
allowed; `Origin: null` — opaque-origin/sandboxed callers — is always
refused), S4 same-origin CORS (no `Access-Control-Allow-Origin` is ever
emitted; a CORS preflight is refused outright), S6 CSRF (`X-TM8-Client`
required on any state-changing request that carries a tm8-named cookie —
matched loosely by substring `tm8` in the cookie name, `security.ts:177-199`,
because cookies are host- not port-scoped). All four run in
`checkTransport` (`security.ts:213-228`); the WS upgrade listener runs the
S2+S3 subset itself via `checkUpgradeTransport` since it never reaches the
ordinary handler (`security.ts:237-244`).

## Success envelope, error envelope, and the error taxonomy

**Success:** `{ "data": <op-specific shape>, "requestId": "req_..." }`
(`envelope()`, `packages/contract/src/envelope.ts:28-30`). List responses put
`nextCursor` **inside** `data.page`, never at the envelope level. The one
sanctioned escape is a `raw`/`raw-stream` handler result (`files.download`
and similar), which writes bytes directly and skips the envelope
(`server.ts:521-557`, `types.ts:108-127`).

**Error:** `{ "error": { "code", "message", "details"?, "requestId",
"retryable" } }` (`WireErrorBody`, `envelope.ts:18-26`), written by the single
serializer/writer pair `toWireError`/`sendWireError`
(`packages/server/src/http/errors.ts:88-173`) — no route hand-builds an error
body. `CollabError` is the one error type handlers throw
(`contract.ts:1649-1669`); anything else that escapes a handler is logged
server-side and answered as a generic `upstream_unavailable` (503) so
internal failure text never reaches the client (`errors.ts:108-138`).

**The closed taxonomy** (`CommandErrorCode`, `contract.ts:1613-1626`) and its
HTTP mapping (`ERROR_STATUS`, `contract.ts:1628-1637`):

| Code | HTTP | Retryable by default |
|---|---|---|
| `invalid_input` | 400 | no |
| `invalid_cursor` | 400 | no |
| `unauthenticated` | 401 | no |
| `forbidden` | 403 | no |
| `not_found` | 404 | no |
| `version_conflict` | 409 | no |
| `conflict` | 409 | no |
| `invariant_violation` | 409 | no |
| `context_budget_too_small` | 422 | no |
| `form_answers_invalid` | 422 | no |
| `form_not_open` | 409 | no |
| `form_structure_frozen` | 409 | no |
| `form_response_limit` | 409 | no |
| `form_respondent_not_allowed` | 403 | no |
| `payload_too_large` | 413 | no |
| `rate_limited` | 429 | **yes** |
| `limit_exceeded` | 429 | **yes** |
| `not_implemented` | 501 | no |
| `upstream_unavailable` | 503 | **yes** |

`RETRYABLE_BY_DEFAULT = {rate_limited, limit_exceeded, upstream_unavailable}`
(`contract.ts:1639`); any `CollabError` may override `retryable` explicitly
(e.g. `read-admission.ts:150-159` marks its 503 retryable even though that is
already the default). A `429`/`503` that carries `details.retryAfterSeconds`
gets a `Retry-After` header — the raiser owns the number, the writer only
reads it (`errors.ts:141-150,169-170`).

A raw Postgres error is mapped through a fixed, mechanical SQLSTATE table
(never a regex on the error message) — `SQLSTATE_TO_ERROR_CODE`
(`errors.ts:37-67`); anything not in that table degrades to
`upstream_unavailable`, a wrong-but-honest 503 rather than a guessed 400.
`details.reason` is a per-family stable string the handler chooses (e.g.
Postgres custom error classes `TFA01`/`TFN01`/... for forms map to fixed
codes with `reason` distinguishing the refusal — see the per-family reference
docs for the actual `reason` values each op raises).

`requestId` is minted once per request, before anything can fail
(`nextRequestId`, `packages/server/src/http/request-id.ts:20-23`; format
`req_<3-byte-hex-process-tag>_<base36-counter>`) and echoed in every success
envelope, every error body, the `x-tm8-request-id` response header, and (at
the DB layer) `SET LOCAL tm8.request_id`, so a client report and a server/DB
audit row are joinable by one id.

## Idempotency

**HTTP-layer normalization** (`http/idempotency.ts`): when the command ledger
is disabled (`TM8_IDEMPOTENCY_ENABLED=0`; **enabled by default**), every
command body that is allowed to carry `clientMutationId`
(`commandAcceptsClientMutationId(opName)`, `contract.ts:1778-1780` — true for
every op except `auth.*`, whose DTOs `.strict()`-forbid it) gets a fresh
`randomUUID()` injected before validation, overwriting whatever the caller
sent (`normalizeCommandInputForIdempotencyMode`, `idempotency.ts:20-43`).
This makes each HTTP command execute as a new mutation when the ledger is
off, rather than fail schema validation on a required field.

**The real replay mechanism is the command ledger**, at the database layer:
a command handler opens with `internal.ledger_replay(clientMutationId,
opName)` (gated by `internal.idempotency_enabled()`, which the server pool
sets via session var `tm8.idempotency_enabled=on` unless
`TM8_IDEMPOTENCY_ENABLED=0` — see the extended comment at
`packages/server/src/facade/execution-handlers.ts:2617-2640`). A replayed
`clientMutationId` returns the original result again (e.g. `SpawnService`'s
`replayed` branch returns the original session id with `reused: true` and
boots no new process) rather than re-executing. Callers that want a stable
retry semantics must supply a `clientMutationId` that is stable **per
distinct intent** — reusing one across genuinely different actions silently
no-ops every call after the first, permanently (the ledger is not pruned;
`retention.command-ledger` is a registered no-op job).

`CommandContext` (the shape embedded in most command bodies) is
`{ actorId?: EntityId, clientMutationId?: string, workSessionId?: EntityId }`
(zod: `packages/contract/src/schemas.ts:1662-1666`; type:
`packages/contract/src/contract.ts:1698`). `auth.*` DTOs omit both
`actorId` and `clientMutationId` entirely — an authentication session row is
not a graph mutation, and a retried login/signup is correct to mint a second
session, not replay the first.

Some catalog command operations have **no bound input schema on this server**
at all (`UNBOUND_COMMAND_OPERATIONS`,
`packages/server/src/facade/input-schemas.ts:432-`) — a pre-existing,
enumerated gap; one already-shipped consequence was `execution.resume`
silently skipping ledger idempotency because nothing enforced
`clientMutationId` server-side (`input-schemas.ts:410-425`).

**Optimistic concurrency** is `expectedVersion: number` on the many command
DTOs that carry it (e.g. `contract.ts:2564,2629,2644,2660,2762,2769,2784,...`).
A version mismatch raises `version_conflict` (409), whose wire body carries
`details.current: EntityDetail` — the caller's local copy is stale and the
server's current state rides along so the client can re-diff instead of
blindly retrying (`toWireError`, `errors.ts:90-93`).

## Pagination

Every list is ordered by a keyset — `(uuidv7 id)` or `(sortValues…, id)` —
never an offset. The wire cursor is an opaque base64url string encoding
`{ v: 2, k: [...lastSortValues, lastId] }`
(`packages/contract/src/cursor.ts:11-19`). `encodeCursor`/`decodeCursor`
(`cursor.ts:36-67`) reject anything malformed, offset-shaped
(`/^off:/` or all-digits — explicitly refused, DEV-5), wrong-version, or
structurally wrong with `invalid_cursor` (400) — never a silent restart at
page 1. `nextCursor: null` inside `data.page` means the list is exhausted.
`limit` bounds (default/max) are set per operation in
`packages/contract/src/schemas.ts`; see each family's reference file for the
exact numbers on its list operations.

Event **sequence replay** (`events.subscribe`'s durable stream) is a
different, monotonic `seq` cursor — not a keyset page — documented in
`14-events-commands-actions-search.md`; the two fan-outs are structurally
separate (a webhook-sourced *ephemeral* event, like the voice roster below,
is deliberately never written to the durable stream, or it would poison
every subscriber's `seq` cursor — see Notes on the voice webhook route).

## Rate limiting and read admission

**Auth rate limiting** (`http/auth-rate-limit.ts`) guards
`RATE_LIMITED_AUTH_OPS = {auth.login, auth.signup, auth.password.change,
auth.claim, auth.claim.reissue, auth.invite.resolve, auth.invite.signup}`
(`auth-rate-limit.ts:73-81`) on two independent dimensions, both backed by
`FixedWindowLimiter` (`fixed-window.ts`, in-memory, per-process, fixed
window with lazy bounded eviction — resets on restart):

- **Client → attempts**: every guarded op call counts, success or failure —
  the flood limit. Default 60 attempts / 60s (`DEFAULT_AUTH_RATE_LIMITS`,
  `auth-rate-limit.ts:53-61`), keyed by `wsClientKey` (TCP peer, upgraded to
  `X-Real-IP` only when the peer is itself loopback — `ws-admission.ts:27-35`).
- **Principal → failures**: only wrong answers count (`username` field on
  `auth.login`/`auth.signup`/`auth.invite.signup`; nothing else is a bucket
  key — an invite/claim code is a bearer capability and is never used as a
  map key), and a success clears the bucket outright. Default 10 failures /
  15 minutes (`auth-rate-limit.ts:56-60`). Checked with `peek` (before the
  handler) and recorded with `hit`/`clear` (after, in `finally`/`catch`,
  `server.ts:459-466`).

Both raise `rate_limited` (429, retryable) with `details.retryAfterSeconds`
(`auth-rate-limit.ts:187-194`) — worded identically regardless of which
dimension tripped, so a 429 does not oracle "does this account exist."

**Read admission** (`http/read-admission.ts`) caps concurrent catalog
`kind: 'read'` operations below the Postgres pool size so a read wave cannot
starve commands/streams of a pooled connection. Admitted:
`readLimitForPool(poolMax) = poolMax - max(2, ceil(poolMax/4))`
(`read-admission.ts:220-223` — pool 32 → 24 admitted, 8 reserved). Past the
cap a read queues **in-process** (holding no DB connection) up to
`maxQueue` (default `4 × limit`) and `maxWaitMs` (default 8000ms, under the
client's 15s deadline); past either, or if the client disconnects while
queued, the read is refused/dropped without ever reaching the handler
(`read-admission.ts:1-29,105-147`). A refusal here is `upstream_unavailable`
(503, retryable) with `details.reason` `read_admission_timeout` or
`read_admission_queue_full` (`read-admission.ts:149-160`). Never applied to
commands — a command waiting here would be exactly the starvation the gate
exists to prevent, moved up one layer. `/health` reports live gate stats at
`data.readAdmission` when wired (`server.ts:295`).

**WS admission** (`http/ws-admission.ts`) is a separate connection-capacity
gate (not request-rate): `maxConnections` (256), `maxConnectionsPerClient`
(16), `maxConnectionsPerIdentity` (16), plus an upgrade-attempt fixed window
(`maxUpgradeAttempts: 120 / 60s`) reusing the same `FixedWindowLimiter`
(`ws-admission.ts:15-21,58-97`). `preflight()` runs before expensive
auth/grant work; `admit()` atomically reserves total/client/identity
capacity and returns an idempotent `release()`.

**Body size** (`http/body.ts`): every request body is buffered under a hard
cap (`TM8_MAX_BODY_BYTES`, default 8MiB — `config.ts:454-458`), refused
*while streaming* (never fully buffered) as `payload_too_large` (413); a
sender that keeps pushing past `4×` the cap has its socket destroyed rather
than drained politely (`body.ts:25-33,41-70`). Body parsing runs **before**
routing — a malformed body is malformed regardless of which operation it was
aimed at (`server.ts:21-27`) — so `POST /v2/entities` with `'{not json'`
answers 400 `invalid_input` even though `/v2/entities` itself would 404 for
some other reason.

## Reserved ops, and 501 vs 404

`OperationStatus` is `'v1' | 'reserved'` (`catalog.ts:18`).
`RESERVED_OPERATIONS = OPERATIONS.filter(op => op.status === 'reserved')`
(`catalog.ts:598`) — e.g. `search.query` (`GET /v2/search`, catalog.ts:176)
and `bridge.fetchBlob` (catalog.ts:228). A reserved operation is *mounted* by
the router like any other (so its method+path exists and is
discoverable/routable) but has no registered handler, so it always answers
`501 not_implemented` (`notImplemented()`, `errors.ts:184-188`), checked
**before** zod validation (`server.ts:427-428` — DEV-13: an unbuilt operation
must say so, not complain about a missing query param). A path with **no**
catalog binding at all — any method, any segment the router's compiled
regexes don't match — is `404 not_found` (`server.ts:356`). A path that
exists under a *different* method than the one used is also `not_found`, not
`405`: the closed taxonomy has no `method_not_allowed` (router.ts:18-21).

---

## Non-catalog routes — detail

### Liveness probe
`GET /health` · served: yes (`packages/server/src/http/server.ts:255-310`)
CLI: `tm8 doctor`, `tm8 server status` (both probe this endpoint)

Deliberately **unenveloped** (no `{data, requestId}` wrapper) and outside
`/v2` — it must not look like a catalog operation. Reports whether the node
can actually serve a read (a bounded 2s `select 1` through the same pool
every space-scoped read uses, not just in-memory router state — added after
a prod incident where `/health` stayed 200 while every `/v2/spaces/:id/*`
read hung), plus catalog build coverage and background-job status.

**Response** — 200 (or 503 if the DB probe fails); `data`-less raw JSON body:

| field | type | description |
|---|---|---|
| `ok` | boolean | `false` only when the DB probe fails |
| `server` | string | always `"tm8-server"` |
| `contractVersion` | string | `CONTRACT_VERSION` (`packages/contract/src/index.ts:6`, currently `"0.1.0"`) |
| `operations` | number | count of routes the router mounted |
| `implemented` | number | count of registered handlers |
| `db` | `'ok'` \| `'unavailable'` | present only when a `healthProbe` was wired |
| `readAdmission` | object | present only when read admission is wired; `{limit, active, queued, maxQueue}` |
| `jobs` | array | present only when `jobsStatus` is wired; each `{name, state, lastRunAt, lastError, runs, failures, overruns, nextRunAt}` |

Example (illustrative, from schema):
```json
{
  "ok": true,
  "server": "tm8-server",
  "contractVersion": "0.1.0",
  "operations": 210,
  "implemented": 205,
  "db": "ok",
  "readAdmission": { "limit": 24, "active": 2, "queued": 0, "maxQueue": 96 }
}
```

**Errors** — none in the taxonomy sense; a failed DB probe is `ok: false` /
HTTP 503 with the same shape, not a `CollabError`.
**Notes** — no auth, no rate limit, no read-admission gate on itself (it *is*
the probe). Not paginated. No idempotency (GET, no side effects).
Source: `packages/server/src/http/server.ts:255-310`.

---

### Artifact preview
`GET, HEAD /p/:previewSessionId/:token/*` · served: yes (`packages/server/src/http/artifact-preview.ts:171-328`)
CLI: none

Serves one asset of a published artifact bundle revision, gated by a
capability token in the URL path (never a header — an iframe can't attach
one). An empty trailing path serves the revision's entrypoint. Dispatched
**before** the ordinary transport checks (S3/S4/CSRF) but **after** S2 (Host
allowlist) — the sandboxed preview document is an opaque origin and its own
`fetch()` of its sibling files arrives as `Origin: null`, which the API
pipeline's S3 otherwise refuses. It shares no other middleware with the
catalog pipeline: no cookie parsing, no identity resolution beyond the
capability lookup, no static fallback.

**Path params**

| name | type | description |
|---|---|---|
| `previewSessionId` | string (uuid) | `artifact_preview_sessions.id` |
| `token` | string (64-hex) | raw capability token; only its sha256 ever touches the DB |
| `rest` (wildcard) | string | asset path within the bundle; `''` means "serve the entrypoint" |

**Response** — 200 with the asset's stored `media_type` and bytes (HEAD omits
the body); every response (including refusals) carries a fixed hardened
header set: a strict `content-security-policy` (`sandbox allow-scripts`
inside it — the load-bearing line: it forces an opaque origin even if the
preview URL is opened top-level, not just when framed), `cross-origin-
resource-policy: cross-origin`, `access-control-allow-origin: *` (safe here
because the token in the path *is* the access control), `x-content-type-
options: nosniff`, `referrer-policy: no-referrer`, `cache-control: no-store`
(`artifact-preview.ts:150-204`).

**Errors** — all plain-text, never JSON/HTML (a refusal must not be a
document the browser could interpret, and must not reflect request content):
`405` (method other than GET/HEAD), `403` (wrong host in second-origin mode;
session revoked; artifact soft-deleted or viewer no longer a member), `404`
(malformed route, unknown session/token pair, unknown asset path), `401`
(session past `expires_at`), `500` (any other failure).
**Notes** — no idempotency/pagination (GET-only). Authorization is two-step:
the session row is looked up under the node-owner's claims, then every
content read re-runs under the *viewer's* claims via ordinary RLS, so a
viewer who loses access loses the preview mid-session. Content type comes
from the stored blob entry, never sniffed from the request.
Source: `packages/server/src/http/artifact-preview.ts:96-328`.

---

### Raw file upload
`PUT /v2/files/uploads/:uploadId/content` · served: yes (`packages/server/src/http/w2-file-upload.ts:99-193`)
CLI: none directly (the CLI's file-upload flow calls the catalog `files.*` ops to get the grant, then PUTs bytes here)

The raw-byte counterpart to the catalog `files.uploadInit`/`files.uploadComplete`
flow (not documented here — see `11-projects-files.md`). Dispatched before
`readJsonBody`, matched by regex directly in `server.ts`, so it never reaches
the JSON body reader or the catalog router.

**Path params**

| name | type | description |
|---|---|---|
| `uploadId` | string (uuid) | `file_upload_slots.id`, minted by `files.uploadInit` |

**Request body** — raw bytes (the file content), streamed directly into the
blob store. Two separate credentials: `context.identity` (WHO — resolved the
normal way from session cookie/`Authorization`, used to build DB claims) and
the grant token (WHICH SLOT — a capability minted at `uploadInit`, verified
here by sha256 hash). The grant rides in `x-tm8-upload-token`
(`TM8_UPLOAD_TOKEN_HEADER`, `packages/contract/src/envelope.ts:72-73`); a
legacy fallback still accepts it in `Authorization` **only** when that header
does not look like a tm8 session token (`w2-file-upload.ts:63-81`) — a real
`tm8s_...` session bearer in `Authorization` is never treated as a grant.

**Response** — `204 No Content` on success (both the "just staged, nothing
more to do" and the "verified and settled" outcomes answer 204 —
`w2-file-upload.ts:123-131,170-175`).

**Errors** — `unauthenticated` (no identity, or a malformed/missing grant
token), `invalid_input` (upload slot already completed/aborted, or the
settle RPC reports a non-`staged` outcome). A settlement failure after bytes
were written triggers a best-effort blob removal so a half-written upload is
never visible to `files.uploadComplete` (`w2-file-upload.ts:176-191`).
**Notes** — idempotent in effect (a re-PUT of an already-`staged` slot is a
204 no-op via the `authorize.outcome === 'staged'` branch) but not via
`clientMutationId` — this route is outside the catalog and the command
ledger entirely. No pagination. Two Postgres RPCs anchor the state machine:
`w2_authorize_file_upload` and `w2_settle_file_upload_write`.
Source: `packages/server/src/http/w2-file-upload.ts:1-193`.

---

### Clipboard image upload
`POST /v2/clipboard/images?sessionId=<uuid>` · served: yes (`packages/server/src/http/clipboard-upload.ts:55-114`)
CLI: none (used by the terminal/PTY paste flow only)

Raw bytes in (a pasted clipboard image), an absolute node-local path out,
which the caller then types into the named PTY session as plain text. Kept
the `/images` spelling even though the store now takes any agent-readable
file — the URL is a wire identifier and renaming it would break already-open
tabs. Dispatched before `readJsonBody` for the same raw-bytes reason as the
upload PUT.

**Query params**

| name | type | required | default / constraints | description |
|---|---|---|---|---|
| `sessionId` | string (uuid) | yes | must match a visible, non-deleted `work_session` entity | the PTY session the image is pasted into |

**Request body** — raw bytes, capped at `store.maxBytes`
(`CLIPBOARD_MAX_BYTES_DEFAULT = 10MiB`, `packages/server/src/files/clipboard-store.ts:111`),
refused while streaming past the cap. Optional `x-tm8-filename` header used
only for its extension (the store generates the actual stored name).

**Response** — `201 Created`:

| field | type | description |
|---|---|---|
| `path` | string | absolute node-local path to the stored file |
| `filename` | string | generated stored filename |
| `mimeType` | string | declared or sniffed content type |
| `bytes` | number | stored size |

Example (illustrative, from schema):
```json
{ "path": "/home/tm8/.../clip-abc123.png", "filename": "clip-abc123.png", "mimeType": "image/png", "bytes": 48213 }
```

**Errors** — `not_found` (missing/malformed `sessionId`, or the session
entity is not visible/deleted under the caller's own RLS claims — visibility
and "not found" are deliberately the same answer). A body over the cap is
refused by the store (`payload_too_large` semantics via `readRawBody`).
**Notes** — authorization reuses the PTY-attach rule exactly: the caller must
be able to *see* the `work_session` entity under their own claims (RLS
decides; membership of the owning Space is the only rule). No idempotency
key, no pagination — this is a single raw upload, not a catalog command.
Source: `packages/server/src/http/clipboard-upload.ts:1-124`.

---

### LiveKit voice webhook
`POST /v2/voice/webhook` · served: yes (`packages/server/src/http/voice-webhook.ts:101-176`)
CLI: none — this is a server-to-server callback *from* LiveKit, never a
client-initiated call, and is deliberately absent from the catalog so no tm8
client can discover a "publish a roster event" verb.

Authenticated by LiveKit's own request-signing key (HMAC over the exact raw
body — read before JSON parsing so re-serialization can't change the digest,
`voice-webhook.ts:11-15`), never by a tm8 identity. Publishes an **ephemeral**
`voice.participants.changed` presence event; never written to the durable
event stream (which would poison every subscriber's `seq` cursor and leave
stale "who's in the call" rows after a crash).

**Request body** — LiveKit's webhook JSON (`event`, `room.name`,
`participant.identity`/`participant.name`). Only `participant_joined` and
`participant_left` are acted on; every other LiveKit event type (e.g.
`track_published`, `room_started`) is acknowledged 200 and ignored, because
LiveKit retries any non-2xx and an uninteresting callback must not become a
retry storm.

**Response** — `200`:

| field | type | description |
|---|---|---|
| `data.room` | string | the room (= `voice_channel` entity id) |
| `data.participants` | number | current roster size after this event |
| `data.ignored` | string | present instead of the above when the event type/room was not acted on |

**Errors** — `400 invalid_input` (unreadable/oversized body — capped
256KiB; not JSON; a `participant_*` event missing room/identity), `401
unauthorized` (signature verification failed — worded with LiveKit's own
rejection reason, e.g. bad HMAC or stale timestamp). A webhook for a room
this node doesn't recognise is dropped with `200 {data:{ignored:"unknown room"}}`,
never an error, since LiveKit cannot fix an unrecognised room by retrying.
**Notes** — no tm8 auth, no idempotency key (a join/leave is applied to
in-memory roster state directly), no pagination. A publish failure after a
roster mutation is logged but never surfaces to LiveKit as an error — retrying
would double-apply the already-correct in-memory join/leave.
Source: `packages/server/src/http/voice-webhook.ts:1-177`.

---

### Named-Server relay (proxy)
`ANY /v2/server-connections/:name/proxy/*` (HTTP) and the matching WS
upgrade · served: yes (`packages/server/src/http/remote-proxy.ts:96-176`)
CLI: none directly — reached by a browser/client already pointed at a proxied
URL after resolving a named Server connection via the catalog
`serverConnections.*` family (see `04-entities.md`/relevant reference file for
that catalog op).

A same-origin relay: `tm8-server` forwards the request (any method, and WS
upgrades) to another named tm8 Server's own HTTP(S) origin, so a browser
never has to open a second-origin connection to a remote node. Matched and
dispatched **before** `checkTransport`/routing for HTTP, and from its own
listener on the `upgrade` event for WS (`server.ts:188-216,250-253`).

**Path params**

| name | type | description |
|---|---|---|
| `name` | string, `^[a-z][a-z0-9-]{0,62}$` | the registered Server connection name |
| upstream path (rest of the URL after `/proxy`) | string | forwarded verbatim; must be `/health`, `/v2`, or start with `/v2/` — nothing else is exposed |

**Request/response** — transparent passthrough of method, body, and (most)
headers in both directions. `Cookie`, `Host`, `Origin`, `Referer`, and
`Content-Length` are **stripped** and replaced before forwarding —
`Authorization` is deliberately the one credential header still forwarded,
because it is the remote's own carrier and cookies never cross nodes safely
(cookies are host-scoped and forwarding one both leaks this node's session to
an untrusted remote and causes `identity-resolver.ts`'s
"conflicting credentials" refusal on every subsequent call, since the browser
then holds passes for both origins under one cookie jar — `remote-proxy.ts:38-76`).
An `access-control-allow-origin` header on the upstream's reply is stripped
before relaying back. A `x-tm8-server-proxy-hop` header marks a request that
has already traversed this relay once, so a target that itself proxies back
is refused as `invariant_violation` (loop guard) rather than looping forever.

**Errors** — `not_found` (bad name shape, unregistered connection name, or
an upstream path outside the `/health`|`/v2` allowlist), `invalid_input`
(unparseable connection name segment, or the registered URL isn't
`http:`/`https:`), `upstream_unavailable` (the remote Server couldn't be
reached), `invariant_violation` (proxy loop detected). WS-specific: a
malformed/unresolvable route on upgrade answers a raw `404`/`502` HTTP status
line over the socket rather than the JSON error envelope (there's no HTTP
response object left to write one to).
**Notes** — no identity check *at this hop*; whatever the client sent
(minus the stripped headers) is what reaches the remote, which authenticates
it independently. No idempotency/pagination semantics of its own — those
belong to whatever operation the forwarded request actually invokes on the
remote node.
Source: `packages/server/src/http/remote-proxy.ts:1-177`.

---

### Static UI bundle
`GET <anything not /v2/* or /health>` · served: yes only when `TM8_UI_DIR` is
configured (`packages/server/src/http/static.ts:62-106`)
CLI: none (browser navigation only)

Serves the built `tm8-ui` bundle same-origin in production (dev uses Vite on
a separate port). Consulted **only after** `/v2/*` and `/health` have been
ruled out, so it can never shadow the API surface — an unknown `/v2/...` path
is always an honest `not_found`, never `index.html` with a 200
(`server.ts:323-329`).

**Request** — any GET path outside `/v2`/`/health`. Path is normalized and
verified to resolve inside `TM8_UI_DIR` after symlink-free normalization
(traversal guard, `static.ts:65-85`); an extension-less path that doesn't
resolve to a real file falls back to `index.html` (SPA client-routing), but a
path *with* an extension that's missing 404s honestly rather than returning
HTML with a 200.

**Response** — 200 with the file's bytes and a `content-type` derived from
its extension (`static.ts:38-54`; unknown extensions get
`application/octet-stream`); no envelope (this is not an operation).

**Errors** — none of the taxonomy's `CollabError`s; a non-matching path
simply falls through (`serve()` returns `false`) to the catalog router's
`not_found`.
**Notes** — no auth (same posture as any other static asset on a
same-origin-only, loopback-bound node), no idempotency/pagination.
Source: `packages/server/src/http/static.ts:1-123`.
