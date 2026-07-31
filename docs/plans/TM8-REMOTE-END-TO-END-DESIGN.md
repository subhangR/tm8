# tm8 — Remote End-to-End Design (Phase 2)

> ### ⚠ PARTIALLY SUPERSEDED — verified 2026-07-31
>
> Specific claims below were re-checked against the tree and found **false or stale**. The body is left unedited: it was accurate when written, and it remains the historical record. Corrections, with `file:line`, are tabulated in **`docs/plans/TM8-IDENTITY-OPEN-THREADS.md` §3**; the verified current state is **`docs/plans/TM8-AUTH-AND-IDENTITY-VERIFIED-STATE.md`**.
>
> - `:355` "align `PgIdentityRepository` to the RPC signatures" — **understates the work 2–3×**. Prefer this document's own stated alternative ("a fresh minimal query set mirroring `loopback.ts`"). A new migration is also required: `008:204-206` gives `accounts`/`auth_sessions` zero RLS policies by design.
> - ~11 `file:line` citations have drifted (e.g. `main.ts:266-271` → `:288-293`). Substance checked out every time; only lines moved.
> - Status: still a **draft pending ratification**. It is not a record of built behaviour.
>
> **Do not cite this document for current behaviour without re-verifying against code.** Three claims were published as verified during a 2026-07-31 investigation purely by trusting it; all three were wrong.


**Status:** design draft, for adversarial review
**Date:** 2026-07-27
**Dependencies:** `docs/plans/PHASE-2-REMOTE-SERVER-INTEGRATION.md` (binding boundary — its §2 invariants are not relitigated here, its §11 is the 15-item checklist this document closes), `docs/plans/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 FINAL GO, `docs/tm8-architecture/05-DECISIONS.md`, and the three research briefs (corpus, code, clients) prepared for this design pass.

**Depth note:** this document targets "90–95% right," not adversarially-perfect. Secondary decisions are pushed into the OPEN list at the end with a one-line recommendation each, rather than designed to death. Where the corpus already decided something, this document cites it instead of re-deriving it.

---

## 0. What this document is

The boundary doc (`PHASE-2-REMOTE-SERVER-INTEGRATION.md`) says remote must reuse the local domain exactly, names eight binding invariants (§2), and lists 15 wire-spec items that gate implementation-readiness (§11). This document closes those 15 items across seven layers: contract, backend, auth/identity, CLI, agent harness, UI, and a coherence check tying it all back to the existing local conventions.

Nothing here changes local (Phase-1) behavior. Every new operation is additive; every reused mechanism is cited, not reinvented.

---

## 1. L1 — Contract

### 1.1 Server identity/metadata DTO

```ts
interface ServerIdentity {
  serverId: string;          // stable, immutable, minted once at first boot of a Server process
  displayName: string;
  contractVersion: string;   // semver, mirrors CONTRACT_VERSION (packages/contract/src/index.ts:6)
  grammarVersion: string;    // CLI grammar version this Server's catalog was generated against
  catalogDigest: string;     // hash of OPERATIONS (catalog.ts:30-164) — same field the harness bootstrap
                              // manifest already reserves (server.catalogDigest, brief-clients §C5 §5.1)
  capabilityEpoch: string;   // reuses the existing actions.list epoch (contract.ts:877-896)
  reachability: 'direct' | 'gateway';
  bootAt: string;            // ISO timestamp
}
```

New op: `server.describe` — `GET /v2/server`, kind `read`, status `v1`. This is a catalog op (goes through the normal envelope, appears in discovery, is authenticated like any read) — deliberately distinct from `/health`, which stays exactly what it is today: an unenveloped liveness probe outside `/v2` (`http/server.ts:119-133`). `/health` answers "is the process up"; `server.describe` answers "what Server is this, and what can it do." Conflating them would put a discovery DTO outside the envelope conventions everything else follows — don't.

### 1.2 Connection record DTO

`Connection` is a client-side concept (PHASE-2 §3 term table) — it is not a server operation, it is local storage. Shape, shared by CLI (§4) and UI (§6d):

```ts
interface ConnectionRecord {
  connectionId: string;      // local id, client-minted
  label: string;             // human label, e.g. "home", "work-gateway"
  mode: 'direct' | 'gateway';
  baseUrl: string;           // direct: the Server's own URL; gateway: the gateway's URL
  serverId?: string;         // gateway mode only, once resolved
  authRef: string;           // opaque pointer into a secret store — never the secret itself (§11 item 2)
  lastConnectedAt?: string;
}
```

### 1.3 Discovery operations

- `server.describe` — `GET /v2/server` (above). Called against a direct Connection's Server, or against a gateway-resolved Server once routed.
- `gateway.listServers` — `GET /v2/gateway/servers`, kind `read`, returns `Page<GatewayServerSummary>` using the existing keyset `Page<T>` shape (`contract.ts:206`, `Cursor = string`). `GatewayServerSummary = {serverId, displayName, status: 'running'|'stopped'|'starting', lastSeenAt}`.
- `gateway.resolveServer` — `POST /v2/gateway/servers/:serverId/resolve`, kind `command`. Starts a hosted Server if stopped (subject to §2.2 lifecycle rules) and returns `{serverId, relayBaseUrl, tokenExchange: {...}}` — `relayBaseUrl` is the gateway-relative path the client actually talks to; it is never the hosted Server's own bind address (§2.1).

### 1.4 Capability discovery + contract-version negotiation

Capability discovery reuses the existing mechanism verbatim: `actions.list`'s `capabilityEpoch` (`contract.ts:877-896`, already entity/actor-scoped) extends naturally to a Server-level capability document (detailed in §6a) — no new capability primitive.

Contract-version negotiation has no existing mechanism (`CONTRACT_VERSION` is reported only via `/health` today, brief-code §A7) — this is the one place §11 item 6 is genuinely greenfield. Decision: every request carries an `X-TM8-Contract-Version` header (same style as the already-reserved `X-TM8-Client` header, `http/config.ts:10-12`); the server compares its own major version against the header's major version. Mismatched majors → `not_implemented` (501) with `details.reason = 'contract_version_unsupported'` — deliberately **not** `upstream_unavailable`: a version mismatch is a permanent condition until the client upgrades, and `not_implemented` is already outside `RETRYABLE_BY_DEFAULT` (`contract.ts:523`), so a client whose generic retry logic keys on error *code* rather than the `retryable` flag does the safe thing by default (see §1.5). Minor/patch differences are always accepted (a newer server is a superset). This is boring on purpose — version negotiation does not need to be more sophisticated than "reject on major mismatch, accept otherwise."

**UNCERTAIN:** a header-based check is simple but is only ever enforced per-request, after the client has already committed to calling a specific operation with a specific body shape — a client running a much older grammar could still construct a request the server's *current* major version no longer accepts in the shape sent, and the resulting `invalid_input` wouldn't obviously point back to "your contract version is too old." An alternative would fold the version check into `server.describe`/`gateway.listServers` responses so a well-behaved client checks compatibility once, up front, before making any catalog call — this design leans on the header as the enforcement backstop and `server.describe` (§1.1, which already returns `contractVersion`) as the place a client is expected to check proactively, but hasn't fully specified the proactive-check contract a client library should follow.

### 1.5 Error taxonomy for gateway-vs-home-Server failures

No new `CommandErrorCode` is added — the 13-code closed enum (`contract.ts:508-521`) stays closed, per the extension precedent already established for amendments (`AmendmentErrorReason`/`details.reason`, WORKSPACE-LAYOUT R4-3, "reuse existing frozen codes with a typed, stable `details.reason`"). New reasons, added to the existing `AmendmentErrorReason` enum (`contract.ts:488-496`), split across two existing codes by whether the failure is transient or permanent:

Riding `upstream_unavailable` (503, already in `RETRYABLE_BY_DEFAULT`, `contract.ts:523`) — genuinely transient, hop-level failures:
- `gateway_unreachable` — client cannot reach the gateway at all.
- `server_unreachable` — gateway reached, resolved Server not responding.
- `server_not_hosted` — gateway has no such `serverId`.
- `server_starting` — hosted Server cold-starting; retry after backoff.
- `token_exchange_failed` — gateway could not mint a Server-scoped token (§3).

Riding `not_implemented` (501, **not** in `RETRYABLE_BY_DEFAULT`) — a permanent condition until the client changes something:
- `contract_version_unsupported` — major-version mismatch (§1.4). Deliberately kept off `upstream_unavailable`: see §1.4 for why the code choice itself (not just the `retryable` flag) needs to say "don't retry."

A new optional `ErrorDetails.origin: 'gateway' | 'home_server'` field tags which hop actually failed, feeding §11 item 14 (observability/correlation) without any new error code.

Two worked examples, using the existing `WireErrorBody` shape (`envelope.ts:18-26`) unchanged:

```json
// A hosted Server is cold and the gateway hasn't finished starting it:
{ "error": {
    "code": "upstream_unavailable", "status": 503, "retryable": true,
    "message": "Server is starting", "requestId": "req_abc123",
    "details": { "reason": "server_starting", "origin": "gateway" }
}}

// The client's contract version is too old for this Server's catalog:
{ "error": {
    "code": "not_implemented", "status": 501, "retryable": false,
    "message": "Contract version not supported", "requestId": "req_def456",
    "details": { "reason": "contract_version_unsupported", "origin": "home_server" }
}}
```

Both fit the existing `CollabError` constructor (`contract.ts:533-557`) with no new fields beyond the already-typed `details` bag — a client that doesn't know about `origin`/the new `reason` values still gets a perfectly valid, already-understood `upstream_unavailable` or `not_implemented` it can (or, for the latter, correctly won't) retry using logic it already has.

### 1.6 Additive-only constraint

`server.*`, `gateway.*`, `auth.*` (§3) are pure infrastructure — none of them read or write entities, spaces, messages, or edges. This satisfies §5's "must not duplicate graph CRUD" by construction: there is no entity behind a `Server` or `Connection`, so there is nothing to duplicate.

New remote-facing ops land in the catalog as `status: 'reserved'` first (same precedent as `search.query`, `bridge.fetchBlob` — `catalog.ts:95,111,183-184`), flipping to `v1` as each Phase-2 layer actually ships, per §8 sequencing.

### 1.7 Full new-operation table

Every new operation this design introduces, in the same shape as an `OPERATIONS` row (`catalog.ts:30-164`):

| name | method | path | kind | initial status |
|---|---|---|---|---|
| `server.describe` | GET | `/v2/server` | read | reserved → v1 |
| `gateway.listServers` | GET | `/v2/gateway/servers` | read | reserved → v1 |
| `gateway.resolveServer` | POST | `/v2/gateway/servers/:serverId/resolve` | command | reserved → v1 |
| `auth.login` | POST | `/v2/auth/login` | command | reserved → v1 |
| `auth.exchangeGatewayToken` | POST | `/v2/auth/exchange` | command | reserved → v1 |
| `auth.refresh` | POST | `/v2/auth/refresh` | command | reserved → v1 |
| `auth.revoke` | POST | `/v2/auth/revoke` | command | reserved → v1 |
| `auth.sessions.list` | GET | `/v2/auth/sessions` | read | reserved → v1 |
| `teamMembers.mintToken` | POST | `/v2/team-members/:id/token` | command | reserved → v1 |
| `bridge.fetchBlob` | GET | `/v2/bridge/blobs/:fileEntityId` | read | already reserved → v1 (§2.5) |

Ten new rows total, plus one existing reserved row (`bridge.fetchBlob`) that flips to `v1`. `search.query` is untouched by this design — it remains reserved for reasons unrelated to remote. None of these rows have a `kind: 'stream'` — the WS control protocol they ride on (§2.4) is unchanged, so no new stream-kind row is needed.

---

## 2. L2 — Backend (gateway, relay, events, blobs, PTY)

### 2.1 Gateway responsibilities and hard limits

Cite `05-DECISIONS.md` T-D6 verbatim rather than re-deriving it: "Gateway = routing + relay + hosted-workspace spawner + remote-facing auth surface (fronting the server's identity block), recycling maestro-gateway Design A — never graph data, never the primary account store [R1]."

Hard limit that follows directly: **the gateway never opens a direct connection to a hosted Server's Postgres.** It only proxies HTTP/WS to that Server's own bound port. This is what keeps "gateway owns routing and relay only" (§2.7) true in practice, not just in prose — there is no code path by which the gateway process could read graph rows even if compromised, because it holds no DB credential for any hosted Server.

### 2.2 Hosted-Server lifecycle and resource governance

Process-per-user, per T-D6's cited precedent ("recycling maestro-gateway Design A"). Each hosted Server is spawned as its own OS process, **bound loopback-only** on an ephemeral port — exactly like a local Server (S1, `10-SECURITY-MODEL.md`). Within this hosted topology the gateway is the only non-loopback listener; no hosted Server process ever binds non-loopback itself. (A Direct, non-hosted Server electing S1's non-loopback carve-out is a separate topology, governed by §3.6.) This means the existing S1 guarantee ("server refuses to start non-loopback with auth disabled") is preserved unchanged for every hosted Server — Phase 2 does not weaken it, it adds exactly one non-loopback listener (the gateway) in front of a fleet of processes that are each, individually, still as locked-down as today's single local Server.

Resource governance numbers (process count, CPU/mem/disk caps per hosted Server) are not fully specified here — see OPEN #3. The anchor point: the existing execution session concurrency cap (8 sessions per Server, `execution-handlers.ts:107`) is a reasonable order-of-magnitude reference for "how much one hosted Server process should be allowed to do," not a number to copy verbatim.

### 2.2.1 Hosted-Server registration — trust and account bootstrap

§3.1.1's token-exchange flow depends on two things established during one administrative, out-of-band step — when a gateway operator provisions a hosted Server for a specific user (the process-per-user model, T-D6) — before any client ever calls `auth.exchangeGatewayToken`:

1. **A shared HMAC secret**, minted fresh per hosted Server. Handed to the hosted-Server process via its own boot configuration (the same class of mechanism `TM8_DATABASE_URL`/`TM8_DELIVERY_DATABASE_URL` already use, `http/config.ts`, `main.ts:129-138`), and kept by the gateway. This is the first-cut keying model — see §3.1.1's resolution of the asymmetric-vs-HMAC question — adopted because a fresh secret per hosted Server is already scoped to just that Server; an asymmetric signing scheme would buy no additional isolation under this keying model, only more machinery. (Upgrade path, if ever needed: move to per-fleet signed assertions only if multiple gateways must vouch for the same Server pool — not a Phase-2 requirement.)
2. **A subject** — a stable, hosted-Server-local identifier string (never the gateway's own `accountId`, never treated as portable across Servers) that registration records against a pre-provisioned local `Account` row on that hosted Server. §3.1.1a specifies exactly how this resolves at exchange time.

This is a **one-time, admin-side bootstrap per hosted Server**, not a per-login or per-request exchange — it never touches the graph, never appears in `gateway.listServers`' response, and is invisible to every client. Rotation policy for the shared secret is OPEN #4.

### 2.2.2 Resource-limit shape (numbers deferred, structure is not)

```ts
interface HostedServerLimits {
  maxConcurrentSessions: number;   // anchored on execution-handlers.ts:107's existing 8
  maxMemoryMb: number;
  maxCpuPercent: number;
  maxDiskMb: number;
  idleShutdownAfterMinutes: number; // hosted Server stops itself when unused, becomes 'stopped' in gateway.listServers
}
```
One `HostedServerLimits` record per hosted Server, set by the gateway operator at registration time (§2.2.1), enforced by whatever OS-level mechanism backs the spawner (plain process + rlimit per OPEN #12). `idleShutdownAfterMinutes` is what makes `gateway.resolveServer`'s "starting" status (§1.3) a real, expected state rather than an edge case — a hosted Server that nobody has used recently is expected to be stopped, and resolving it again is a normal cold start, not a failure.

### 2.3 Relay mechanics

The gateway relay is a **dumb pipe** at both layers it touches:

- **HTTP relay**: forwards a catalog request verbatim (after token exchange, §3) to the resolved hosted Server and returns its response unchanged. The gateway adds nothing to the envelope and strips nothing from it.
- **WS relay**: forwards `WorkspaceControlFrame`/`WorkspaceEvent`/`WorkspaceControlAck` frames byte-for-byte. The gateway must not rewrite `spaceId`, inject a `serverId`, or otherwise touch payload — this is what makes §2.8 ("live bytes are not graph data") hold for the relayed JSON control channel too, not just PTY bytes.

```
Client                    Gateway                       Hosted Server
  │  POST /v2/spaces/:id/entities                          │
  │  Authorization: Bearer <server-scoped token>            │
  ├──────────────────────►│                                 │
  │                       │  forwards verbatim, adds only   │
  │                       │  its own hop-level requestId     │
  │                       │  for correlation (§11 item 14)   │
  │                       ├────────────────────────────────►│
  │                       │                                 │  normal handler,
  │                       │                                 │  normal envelope
  │                       │◄────────────────────────────────┤
  │◄──────────────────────┤  response body byte-for-byte    │
  │  {data, requestId}    │  (requestId is the ORIGIN's,     │
  │                       │   never rewritten to the         │
  │                       │   gateway's own)                 │
```

The client-visible `requestId` in the envelope is always minted by the hosted Server that actually handled the request (`nextRequestId()`, `http/server.ts:109`, unchanged) — the gateway's own hop-correlation id is a separate, log-only value (§11 item 14 / OPEN #10), never substituted into the wire envelope. A client that has never heard of gateways gets an indistinguishable response either way.

### 2.4 Event/cursor model — resolving the §7 proposal

PHASE-2 §7 proposes keeping the Space-scoped `WorkspaceEvent` envelope unmodified (no `serverId` field) and keying client-side cursors by `(serverId, spaceId)`, with the selected Connection supplying Server context. **This design approves that proposal as written**, with one concrete topology decision that makes it actually work for multiple simultaneous Servers:

**One WS connection per resolved Server.** A client with three hosted Servers open has three separate WS connections (each relayed independently by the gateway, or connected directly), not one socket multiplexing all three. This is what lets the Connection supply Server context implicitly — the socket itself is already scoped to exactly one Server, so nothing on the wire needs to say which Server an event belongs to. `WorkspaceControlFrame`/`WorkspaceEvent`/`WorkspaceControlAck` (`contract.ts:397-453`) need **zero shape changes**. The already-landed `resume {spaceId, since}` frame stays unambiguous because the socket it travels on already identifies the Server.

The client resolves `(serverId, spaceId) → lastAppliedSeq` at the point it persists a cursor, reading `serverId` off the Connection the socket belongs to — `serverId` is never sent on the wire. This is deliberately the position that "adding a Server field to every graph event would be a wire-shape fork solely to serve a client bookkeeping need the client already has via its own socket topology" — which is exactly the kind of fork §2.6 ("one operation catalog... cannot fork") warns against in spirit, even though `serverId`-on-event wouldn't literally duplicate an op.

**Adopting the WS subscribe/unsubscribe amendment for multi-Server:** the amendment already exists in the contract (`contract.ts:397-453`, landed per the brief-corpus timeline — proposed pre-freeze, skipped for G1A "polling suffices," later ruled back in via W0–W5 arbitration §20.1/§23.6). Nothing about its *shape* needs to change for multi-Server. The adoption is entirely a client-topology decision: use the existing frames over the one-socket-per-Server model above, instead of the implicit single-socket-single-Server case Phase 1 never had to think about. This closes §11 item 8 with **no new wire shape**, only a documented client behavior.

Retention stays exactly what it is (~5 min / 1000 events per Space, `poll.ts:73`). Reconnect-past-retention is the one place this needs an actual answer: today nothing distinguishes "since is stale because of retention pruning" from any other resume. Recommendation (kept in OPEN #2 rather than designed further): add a `truncated: true` flag to the resume path's response when the requested `since` predates the earliest retained event; the client falls back to a fresh `entities.get`/re-subscribe instead of assuming it caught up cleanly.

Multi-Server backoff/health reporting across N open sockets is scoped down deliberately — see OPEN #1.

Worked topology example — a client with two Connections, "home" (direct) and "work-gateway" (resolving two hosted Servers, `srv-A` and `srv-B`):

```
Client
  ├─ WS #1  → Server "home"                (direct;   cursors keyed by (home, spaceId))
  ├─ WS #2  → gateway relay → Server srv-A  (gateway;  cursors keyed by (srv-A, spaceId))
  └─ WS #3  → gateway relay → Server srv-B  (gateway;  cursors keyed by (srv-B, spaceId))
```

Each socket independently subscribes/unsubscribes/resumes using the unmodified `WorkspaceControlFrame` union; each is authorized against that Server's own `DbSubscriptionAuthorizer` (`events/control.ts:56-103`), which already derives its answer from that Server's own `spaces` RLS predicate — nothing about multi-Server changes how a single subscription is authorized, because from any one Server's point of view, remote is invisible. It just sees a normal WS client.

**UNCERTAIN:** one-socket-per-Server is chosen over a single multiplexed socket (through the gateway) carrying a `serverId` per frame. The multiplexed alternative would need exactly one new field on `WorkspaceControlFrame`/`WorkspaceEvent` and would reduce socket count, at the cost of the wire-shape change this design avoids and a more complex gateway fan-in/fan-out. This design's bet is that socket count stays small in practice (a handful of open Servers per user session) and that avoiding a contract change is worth more than the socket-count savings — but if a future usage pattern involves a client routinely holding open dozens of hosted Servers at once, that bet should be revisited.

### 2.4.1 Retention/reconnect edge, spelled out

Today: `resume {spaceId, since}` seeds delivery at "the last seq actually replayed," never at the raw requested `since` (`events/control.ts:231-236`) — this behavior is unchanged by remote. The only genuinely new case is a client that has been disconnected longer than the ~5-minute/1000-event retention window (`poll.ts:73`) — plausible for remote in a way it rarely was for local, since a laptop closing a lid and reopening across a gateway hop is a much more common event than a local process staying open. Per OPEN #2, the recommended (not yet built) fix is a `truncated: true` flag on the ack; until built, the client-observable symptom is simply a `resume` that silently starts from whatever the log actually has — not wrong, just less informative than it could be. This is safe to ship without the flag; it is a rough edge, not a correctness gap.

### 2.5 Blob relay

`bridge.fetchBlob` (`GET /v2/bridge/blobs/:fileEntityId`, reserved today at `catalog.ts:111`) is specified here: the gateway relay forwards the request to the home Server's own `files.download` handler, which already rechecks Space membership, re-verifies the checksum, and sets `content-disposition` correctly (`F3`, `facade/services/w2/files.ts:282-313`). The gateway adds nothing and strips nothing — pure byte-proxy of the raw response (`files.download` already bypasses the JSON envelope via the `raw()` `HandlerResult`, `http/server.ts:236-244`; the relay preserves that). This activates the reserved catalog row (flip `status: 'reserved' → 'v1'`) without touching `files.download` itself.

Direct Connections never need `bridge.fetchBlob` — a direct Connection calls `files.download` straight against the Server. The bridge op exists only because a gateway-relayed client cannot reach a hosted Server's loopback-bound port directly and must tunnel through the gateway's own HTTP surface.

### 2.6 PTY relay — and the view/drive enforcement gap

The gateway relays the WS byte stream for `execution.streams.attach`'s returned URL the same way as the event socket: unchanged bytes, no inspection.

**Load-bearing gap, not optional:** `pty-ws-server.ts:247-249` today always wires `onInput → pty.write(...)` regardless of the grant's `mode`. On a single-owner local node this is harmless (§1 of `10-SECURITY-MODEL.md` explicitly scopes "malicious space members" out of v1's threat model). The moment a second human can be a *view-only* collaborator on a remote Space, this stops being harmless — a view grant that can still type is a real security hole, not a theoretical one. This must be fixed as part of Phase 2, not treated as an open item:

1. `grant_stream_attach` already accepts a `tokenHash` parameter, currently hardcoded to `null` ("bearer tokens for streams are post-G1A," `execution-handlers.ts:322`). Wire it: mint a real per-grant token, store its hash, return the plaintext once in `StreamAttachGrant.token` (`contract.ts:1073-1081` already has this optional field).
2. The PTY WS upgrade must **reject outright** if the presented token doesn't resolve to a live, unexpired grant — upgrade-time rejection, not just input-time gating, is the actual enforcement point. This is a real architectural addition, not a parameter flip: `PtyWsServerOptions` (`pty-ws-server.ts:66-70`) is `{pty, logger}` today — no identity, no DB handle, no authorize hook of any kind — so this adds a new `grantLookup` dependency (backed by `Db`) and threads it through `main.ts`'s composition (`execution ? createPtyWsServer(...) : undefined`, `main.ts:237`, currently `{pty: execution.pty}` only) alongside `pty`. Size this in sequencing (§8/§10) as the scope it actually is, not a one-line change.
3. `pty-ws-server.ts`'s input handler must additionally check `mode === 'drive'` before calling `pty.write`; a `view`-mode connection's input frames are dropped, never forwarded — this is defense-in-depth *behind* the upgrade-time rejection in point 2, not a substitute for it.

This closes §11 item 11 and is carried as a **MUST-FIX**, sequenced in §8.

Sketch of the enforcement change (illustrative, not a literal diff):

```ts
// pty-ws-server.ts, current (execution-handlers.ts:247-249 wiring):
onInput: (data) => pty.write(sessionId, data)   // fires regardless of grant mode

// pty-ws-server.ts, required — rejection at upgrade time (point 2), gating at input time (point 3):
handleUpgrade: async (req) => {
  const grant = await grantLookup.resolve(tokenFromUrl(req));
  if (!grant || grant.expired) return rejectUpgrade(req);   // new: reject before any socket exists
  ...
},
onInput: (data) => {
  if (grant.mode !== 'drive') return;           // view-mode connections are dropped, not forwarded
  pty.write(sessionId, data);
}
```

`grant` is resolved from the token presented in the connection URL, hashed and looked up against the row `grant_stream_attach` already wrote (now with a real, non-null `tokenHash`, §2.6 point 1). Confirmed during this pass (the code brief had flagged `PtyHostService` as unread, §E4): `PtyHostService.write(sessionId, data)` (`packages/execution/src/pty/PtyHostService.ts:420-424`) is pure PTY plumbing with no concept of grants or modes — it just writes to the process. This confirms `pty-ws-server.ts` is the only place that can know about the grant and gate on it; no lower-layer change is needed. What *is* needed, honestly: a new DB-backed dependency threaded into a component that structurally has none today (point 2) — that is the actual size of this MUST-FIX.

**Security note (browser transport constraint):** browsers cannot set custom headers on a WebSocket upgrade, so the plaintext grant token must ride the PTY WS upgrade URL as a query parameter — the first place tm8 puts a live bearer-equivalent secret into a URL. The 15-minute grant TTL bounds the exposure but log retention routinely exceeds it, so the gateway relay's and the hosted Server's access-log middleware **must redact the `token` query param** before writing any request log line (§11 item 14, observability).

---

## 3. L3 — Auth & Identity

This layer gates everything else — no `auth.*` op exists today, and a second human cannot sign in (`brief-code §A8`). The good news, confirmed against the working tree: **this is wiring, not greenfield.** `packages/server/src/identity/` already models the full auth domain — `Account`, `AuthSession` (`kind: 'browser'|'cli'|'agent'`, `actingAsTeamMemberId`, `tokenHash`), `ClaimSet`, a scrypt password hasher, and token-format machinery (`identity/types.ts:77-192`, `identity/crypto.ts`). `loopback.ts:14-18` says outright: "the moment [loopback binding] changes, this is replaced by the bearer path (S8), and those are one change, not two." `RequestIdentity.kind` already includes `'bearer'` (`http/types.ts:22-23`) — nothing resolves it yet.

### 3.1 New operations

- `auth.login` — `POST /v2/auth/login`, `{username, password}` → `{accountId, sessionToken, expiresAt}`. Direct-Connection login, built on the existing `StoredCredential` (scrypt) + `AuthSession(kind: 'browser'|'cli')`.
- `auth.exchangeGatewayToken` — `POST /v2/auth/exchange`. Called by a client already authenticated to a gateway, exchanging that session for a Server-scoped token on a specific resolved `serverId`. Mechanism: the gateway mints a short-lived **signed assertion** (`{accountId claim, serverId, exp}`) using a gateway↔Server shared verification key established at hosted-Server registration time — not a shared password, not a shared session table. The hosted Server's own `auth.exchangeGatewayToken`-receiving endpoint verifies the signature and mints its **own** `AuthSession` + `tokenHash`, through the identical local mechanism `auth.login` uses. The hosted Server never needs to trust the gateway's database, only a verification key — this is what keeps "gateway never becomes... the primary account store" (T-D6/R1) true even under token exchange.
- `auth.refresh` — `POST /v2/auth/refresh`, `{refreshToken}` → new token + expiry. Idempotent replay via the existing request-hash ledger pattern (`files.ts:173-204`), so a retried refresh returns the same new token rather than minting two.
- `auth.revoke` — `POST /v2/auth/revoke`, revokes the caller's own session, or (node-admin/owner) a named account's sessions — the disablement path.
- `auth.sessions.list` — `GET /v2/auth/sessions`, lists live `AuthSession` rows for the caller's account, so a client can enumerate before revoking (supports the "effects on live sockets" requirement below).

All five follow the existing envelope/error/idempotency conventions verbatim — no new response shape, no new error code.

### 3.1.1 Two flows, spelled out

**Direct login:**

```
Client → Server:  auth.login {username, password}
Server:           verify StoredCredential (scrypt) → mint AuthSession(kind='browser'|'cli')
Server → Client:  {accountId, sessionToken (plaintext, once), expiresAt}
Client:           stores sessionToken (§3.2), sends Authorization: Bearer <sessionToken> thereafter
```

**Gateway login + Server-scoped exchange:**

```
Client → Gateway:      auth.login {username, password}      (gateway's OWN account, not the hosted Server's)
Gateway:                mints its own AuthSession, scoped to gateway-level operations only (gateway.*)
Client → Gateway:      gateway.resolveServer {serverId}
Gateway → Client:      {relayBaseUrl, tokenExchange: {assertionRequired: true}}
Client → Gateway:      auth.exchangeGatewayToken {serverId}
Gateway:                mints an HMAC-signed exchange token {subject, serverId, exp} using the
                        shared secret established at hosted-Server registration (§2.2.1),
                        NOT the gateway's own accountId
Gateway → hosted Server: forwards the exchange token to that Server's exchange endpoint
Hosted Server:           verifies the HMAC → resolves `subject` per §3.1.1a → mints its OWN
                         AuthSession(kind='browser'|'cli') exactly as auth.login would
Hosted Server → Gateway → Client:  {accountId, sessionToken, expiresAt}  (Server-scoped, usable
                                    directly against relayBaseUrl thereafter)
```

The important property: after exchange, the client holds a token minted **by the hosted Server**, checked against **that Server's own** `AuthSession` table. The gateway's role ends at handing over an HMAC-signed subject claim — it never issues, stores, or validates the Server-scoped token itself. This is what makes "gateway never becomes the primary account store" true for the exchange flow specifically, not just as a general principle.

**Resolved (was UNCERTAIN in the prior draft):** an asymmetric signed-assertion scheme was originally proposed here; §2.2.1 point 1 adopts shared HMAC instead, since registration already mints a fresh secret per hosted Server — under that keying model asymmetric signing adds machinery without adding isolation. The upgrade path (per-fleet signed assertions) is noted in §2.2.1 and stays unbuilt until a multi-gateway-per-Server-pool topology actually needs it.

### 3.1.1a Account resolution at exchange time

The exchange token's claim is the **subject** string recorded at registration (§2.2.1 point 2) — never a raw `accountId` shared between the gateway and the hosted Server's own namespace. This is what avoids a de facto portable-identity requirement that would contradict §3.7/PHASE-2 §6's explicit deferral: the gateway's notion of "who is this" and the hosted Server's notion of "which local Account" are related only through the subject string registration recorded, not through a shared id space.

At exchange, the hosted Server:

1. Looks up the presented `subject` against the `Account` row registration provisioned for it (§2.2.1 point 2).
2. **Found** → mints `AuthSession(kind='browser'|'cli')` for that Account, exactly as `auth.login` would for a directly-authenticated user — no special-cased session shape.
3. **Not found** → refuses with the existing `forbidden` code (`contract.ts:508-521`) — plain, no new `details.reason` needed, since this is an ordinary authorization refusal, not a hop-level infrastructure failure (contrast `token_exchange_failed`, §1.5, which covers the gateway-side failure to mint the exchange token at all — a different, transient failure mode from a permanent unknown-subject refusal). The hosted Server **never auto-provisions** an Account on an unrecognized subject — auto-provisioning would turn exchange into a silent account-creation path, letting anyone who can reach the gateway mint themselves a new local Account on every hosted Server it fronts. Account creation stays an explicit, admin-side act (registration); exchange is purely an authentication step over an already-provisioned identity.

### 3.1.2 `AuthSession` lifecycle states

| State | Entered by | Exited by |
|---|---|---|
| `active` | `auth.login` / `auth.exchangeGatewayToken` success | expiry, `auth.revoke`, account disablement |
| `expired` | access-token TTL elapses (§3.2) | `auth.refresh` (mints a new `active` session) |
| `revoked` | `auth.revoke`, or cascaded from account disablement (§3.3) | terminal — never re-activated; a new login is required |

No new states beyond what `AuthSession`'s existing `tokenHash`/expiry fields already support (`identity/types.ts:113-127`) — this table documents behavior, it does not add columns.

### 3.2 Token storage, expiry, refresh, revocation

- Storage lives client-side and is layer-specific: CLI stores in an OS keychain when available, else a `0600` file (§4.3); browser UI cannot use an httpOnly cookie (different origins per Connection) and instead keeps the token in memory + an encrypted-at-rest per-Connection store, consistent with the existing bearer pattern (`client.ts:212` already sends `Authorization: Bearer`).
- Expiry: short-lived access token (order of an hour — matches the existing 15-minute-scale precedent for stream grants, `execution-handlers.ts:322`) plus a longer-lived refresh token (order of 30 days). Exact numbers are OPEN #8 — the split itself is the decision, and it's a standard one on purpose ("keep it boring").
- Revocation: marking an `AuthSession` revoked takes effect on the next request immediately, because the bearer resolver (§3.4) checks revocation status every time. For **live sockets** specifically, the existing per-connection WS authorize seam (`events/ws-server.ts:44`) needs a periodic re-check (recommend: poll every 60s, OPEN #9) so a revoked session's open WS actually closes rather than just failing new requests.

### 3.3 Account disablement effects

Disabling an Account cascades to revoking every `AuthSession` it owns, via the same mechanism as §3.2. Bridge/blob tokens are already short-lived and per-`uploadId` scoped (`F2`) — disablement doesn't need special handling there; already-issued grants simply expire. PTY stream-attach grants (once wired per §2.6) get the same treatment: disablement should proactively revoke live grants too, closing active attach sockets via the same poll mechanism.

### 3.4 Agent bearer tokens narrowed to a team-member persona

New op: `teamMembers.mintToken` — `POST /v2/team-members/:id/token`, callable only by the Member who owns that `team_member`. Creates an `AuthSession{kind: 'agent', actingAsTeamMemberId}` — the exact shape already modeled (`types.ts:113-127`). This is the minting authority the harness doc left unnamed (brief-clients §C1: "no minting authority is named") — the CLI's existing `TM8_AGENT_TOKEN` env var is the *carrier* for this token, not its source; today nothing mints it, this op does.

`claimsFor` (`facade/context.ts`) resolves an agent-kind session's claims exactly like the human path, but with `actorId` forced to the `teamMemberId` and `canActAs` restricted to that one id. **No new claims path** — this feeds the existing `ClaimSet` shape (`types.ts:155-177`) through the same single-defined `claimsFor`, satisfying the hard structural constraint below.

### 3.5 The seam, and the hard constraint it must respect

`test/one-identity-path.test.ts` structurally enforces that `claimsFor` is defined in exactly one file (`facade/context.ts`) and that claim binding via `set_config` happens in exactly one file (`db/client.ts`), because the same bug — an identity-less resolver, then a globally-bound actor — was independently reintroduced twice in one day by two different lane authors. **The auth layer must feed this single path, never fork it.** Concretely: `identityResolver` (`main.ts:266-271`) gains a second implementation — `createBearerIdentityResolver(db)` — that hashes the incoming `Authorization` header, looks up the `AuthSession` by `tokenHash`, checks expiry/revocation, and returns `{kind: 'bearer', identityId, actorId, actingAsTeamMemberId?}`. The WS authorize seam (`events/ws-server.ts:44`) calls the same resolver. `claimsFor` and `db/client.ts` do not change at all — they already accept whatever `identityId`/`actorId` the resolver hands them.

**Known pre-work, not a design question:** `PgIdentityRepository` has real bugs today (wrong column names, wrong RPC argument order) because nothing exercises it — every passing identity test runs against the in-memory repository (`loopback.ts:5-12`). The bearer resolver needs a working repository; either fix `PgIdentityRepository`'s bugs by aligning it to the RPC signatures `loopback.ts` already calls correctly, or write a fresh minimal query set that mirrors `loopback.ts`'s proven calls. This is scoped, concrete work — call it out explicitly in sequencing (§8), don't let it hide inside "wire up auth."

### 3.6 Origin/Host/CORS/CSRF posture

`checkTransport()` (`http/security.ts`, named seam at `http/config.ts:10-12`) is where S2 (Host allowlist), S3 (WS Origin), S4 (CORS), S6 (`X-TM8-Client` header) all land — currently deferred no-ops. Phase 2 requirement:

- **Host allowlist (S2)**, **WS Origin check (S3)**, and **CORS (S4)** apply to **any Server bound non-loopback** — not only the gateway. §2.2 keeps *hosted* Servers loopback-only, but a *Direct* Connection is not required to be loopback: S1's own carve-out already permits `TM8_BIND` non-loopback provided bearer auth is enabled, and that is exactly the topology this design's `ConnectionRecord(mode: 'direct')`/`auth.login` machinery is built to serve (e.g. a self-hosted Server reachable over a VPN, or a public bind with auth). Banning that topology (browser access only through a gateway) would outlaw a use case the Connection model and CLI are explicitly built to support — not the fix. Instead: `checkTransport()`'s enforcement (the config shape below) is not gateway-specific code, it's a rule any non-loopback listener runs, gateway or direct. CLI/agents send no Origin and authenticate via the bearer path (S8) as today — unchanged. A Server that stays loopback-only (the default) needs none of this, exactly as today.
- **CSRF**: bearer-token-in-header auth (the existing model, `client.ts:212`) has no ambient-cookie attack surface, so no separate CSRF token scheme is introduced. This is the boring, correct answer — state it as a decision, not a gap.

Example non-loopback transport config (extends `ServerConfig`, `http/config.ts:20-50`; applies wherever a Server — gateway or direct — binds non-loopback):

```ts
interface NonLoopbackTransportConfig {
  allowedHosts: string[];    // S2 — Host header allowlist
  allowedOrigins: string[];  // S3 — WS Origin allowlist for browser UI clients
  // no CORS wildcard, no cookie-based session — matches the CSRF decision above
}
```

The gateway always carries one (it is always non-loopback, §2.1). A Direct Connection's Server carries one only if its operator opts into non-loopback binding (S1's carve-out) — the loopback default needs nothing here. Hosted Servers spawned by a gateway carry no equivalent config — they stay loopback-bound (§2.2) and never see a browser Origin or foreign Host header directly, regardless of how the gateway in front of them is configured.

### 3.7 Portable identity forward-compatibility

Not required now (PHASE-2 §6 explicitly). `IdentityId` is already opaque and immutable, documented specifically for this reason ("R6 re-key compatibility... so they can change without rekeying," `identity/types.ts`) — the forward-compat requirement is already satisfied by a property the type already has. No action needed beyond citing it.

---

## 4. L4 — CLI

### 4.1 Nouns

Two new nouns, added to the existing noun-first grammar (`domain-command = noun, {subnoun}, verb, {argument}`, brief-clients §A1):

```
tm8 connection add <label> --url <baseUrl> [--gateway]
tm8 connection list
tm8 connection remove <label>
tm8 connection use <label>
tm8 server list                 # gateway Connection: gateway.listServers; direct: single-element from server.describe
tm8 server select <serverId>    # gateway Connection with multiple hosted Servers
```

No existing noun changes shape. This satisfies "must stay one CLI" by construction — everything else about the grammar (global flags, EBNF, exit codes) is unchanged.

### 4.1.1 Worked example session

```
$ tm8 connection add home --url http://127.0.0.1:4610
Connection "home" added (direct). Not yet authenticated — run `tm8 auth login --connection home`.

$ tm8 auth login --connection home
Username: owner
Password: ********
Logged in to "home" as owner. Token stored in keychain (tm8-home).

$ tm8 connection add work-gateway --url https://gw.example.internal --gateway
Connection "work-gateway" added (gateway). Not yet authenticated.

$ tm8 auth login --connection work-gateway
Username: alice
Password: ********
Logged in to gateway "work-gateway" as alice.

$ tm8 server list --connection work-gateway
SERVER ID   DISPLAY NAME     STATUS
srv-A       alice-dev-box    running
srv-B       team-shared      stopped

$ tm8 server select srv-B --connection work-gateway
Resolving srv-B... starting hosted Server (this may take a few seconds)
Exchanged Server-scoped token for srv-B. Connection "work-gateway" now targets srv-B.

$ tm8 space list --connection work-gateway
(lists spaces on srv-B, using the exchanged token — identical output shape to a local `tm8 space list`)

$ tm8 connection use home
Active connection set to "home". Subsequent commands default to it without --connection.

$ tm8 space list
(lists spaces on "home" — zero-flag local usage, unchanged from today)
```

Every command after `connection add`/`auth login` uses the **same** verbs (`space list`, etc.) that exist today — nothing about the noun-first grammar for graph operations changes; only `--connection` selects which Server they run against.

### 4.2 Targeting flag

New global flag: **`--connection <label>`** — not `--profile`, deliberately: "Interaction Profile" is an unrelated existing concept (harness/prompt/UI-policy), and reusing the word would collide (brief-clients §A5 flags this explicitly). "Connection" matches the domain term PHASE-2 §3 already defines.

Precedence extends the existing four-tier chain in `context.ts:170-201` by inserting a flag tier at the front:

```
--connection flag
  → TM8_CONNECTION env (session-injected, parallel to existing TM8_BASE_URL)
    → local config's activeConnection field
      → implicit local fallback (today's IMPLICIT_LOCAL_BASE_URL, unchanged)
```

Zero-config local usage needs no new flag — the implicit-local tier is preserved exactly as today's fallback, so every existing local workflow keeps working unmodified.

### 4.3 Config/credential storage

Extends the existing `~/.config/tm8/config.json` (`context.ts` `loadLocalConfig`, brief-clients §B1) rather than inventing a second config file:

```json
{
  "baseUrl": "...",
  "activeConnection": "home",
  "connections": [
    { "label": "home", "mode": "direct", "baseUrl": "https://...", "authRef": "keychain:tm8-home" },
    { "label": "work-gateway", "mode": "gateway", "baseUrl": "https://gw.example/", "authRef": "keychain:tm8-work-gw" }
  ]
}
```

`baseUrl` stays as a legacy alias for the default/implicit Connection — no breaking change for existing configs.

Credentials are never inline in `config.json`. `authRef` points at an OS keychain entry (macOS Keychain / libsecret / Windows Credential Manager, via an existing cross-platform library — evaluated at implementation time, OPEN #7), with a documented `0600` file fallback under `~/.config/tm8/credentials/<label>.token` when no keychain is available. This satisfies §11 item 2's secret-storage requirement.

### 4.4 Client wiring

`context.ts`'s resolver gets the new flag tier. `client.ts`'s existing `token?: string` field — already explicitly labeled "the reserved Phase-2 transport seam" (`client.ts:63-67`) — is now populated from the resolved Connection's credential instead of only `TM8_AGENT_TOKEN`. `TM8_AGENT_TOKEN` remains valid as an override for the agent/session-injected case (unchanged, §5).

No new exit codes: 3 (`unauthenticated`) and 7 (`retryable transport`) already cover expired-auth and gateway-unreachable cases; the new `upstream_unavailable` reasons (§1.5) map to exit 7 automatically since `upstream_unavailable` is already in `RETRYABLE_BY_DEFAULT`.

---

## 5. L5 — Agent Harness

### 5.1 Credential minting and scope

`teamMembers.mintToken` (§3.4) is the minting authority. Minted at spawn time, TTL bounded to the session's expected lifetime, delivered exactly as the harness doc already specifies: via scoped environment (`TM8_AGENT_TOKEN`), never serialized into manifest/graph/logs/prompts (brief-clients §C1, §18.3 — unchanged).

### 5.2 Command discovery

Unchanged mechanism (`tm8 help --format json`, `action list`, `entity context`, brief-clients §C3) — it already works against any target once the CLI's `--connection` flag is threaded through. A remote-targeted agent's discovery output reflects that Server's own `catalogDigest`/`grammarVersion`/`capabilityEpoch`, which may legitimately differ (a remote Server may have `execution.spawn` disabled) — that difference is exactly what the capability-gating layer (§6a, §5.4) is for.

### 5.3 Manifest field gap

The harness *design* doc already specifies a `server: {id, baseUrl, catalogDigest, grammarVersion, capabilityEpoch}` block in the bootstrap manifest (§5.1). The **shipped CLI** `manifest.ts` has no such field (brief-clients §B5) — this is a straight implementation gap, not a new design decision. Add `Tm8Manifest.server` matching the already-specified shape, populated by `worker-init.ts`'s manifest projection alongside the existing `spaceId`/`project` fields:

```json
{
  "manifestVersion": 2,
  "sessionId": "ws_...",
  "spaceId": "sp_...",
  "server": {
    "id": "srv-B",
    "baseUrl": "https://gw.example.internal/relay/srv-B",
    "catalogDigest": "sha256:...",
    "grammarVersion": "4",
    "capabilityEpoch": "ep_..."
  },
  "project": { "id": "proj_...", "workingDir": "/work/..." },
  "mode": "worker",
  "...": "unchanged fields"
}
```

Every other field is exactly what `manifest.ts` (`manifest.ts:84-110`) already produces — this is additive, not a rewrite of the manifest shape.

### 5.4 Hosted execution: collaborate while `execution.spawn` honestly refuses

PHASE-2 §10 already states the split: graph membership and execution permission are separate, and a remote Space member may collaborate while `execution.spawn` returns `not_implemented` or `forbidden` on that Server composition. Mechanism: a per-Server admin setting `executionEnabled: boolean` (a Server-level config, not a graph entity) gates whether the `execution.*` handlers are registered at all — mirroring today's existing `db ? register : undefined` composition pattern in `main.ts`. The UI/CLI/harness all learn this the same way any other capability is learned: through `actions.list`/`capabilityEpoch` (§6a) — no special-cased "remote execution disabled" code path anywhere.

### 5.5 Report-back

Unchanged. A hosted or remote-targeted agent reports back through the same catalogued `messages.post`/`execution.prompt`-internal-gated delivery mechanism, against its **own home Server** — a work session belongs to one Server, same as today. Cross-Server coordinator relationships are out of scope; there is no new channel.

---

## 6. L6 — UI

### 6a. The local-vs-remote capability delta, as a system

The mechanism already exists in embryo: `EntityCapabilities` and the `@tm8/ui-data` `capabilities` export gate every consumer uniformly, under the standing law "disabled-with-reason — never dropped, never faked" (UI-SPEC §4.12). `actions.list` already returns `capabilityEpoch` and a per-action `authzTarget` (`contract.ts:877-896`).

Design: extend this into a `ServerCapabilityDocument`, fetched once per Connection and invalidated on `capabilityEpoch` bump (same semantics as today's action-discovery cache) — it feeds the **same** `EntityCapabilities`/`capabilities` seam, not a second one. A remote Server's reduced capability set (execution disabled, a reserved op still unbuilt there) is just another input to a computation the UI already renders correctly. No new UI paradigm.

Vocabulary — the part that shows up in every action bar — is three states, deliberately not more:

- **"Not available on this Server"** — a genuine capability-off (e.g. execution disabled).
- **"Reconnecting…"** — transient: socket down, not a capability absence. Must never be conflated with the line above.
- **"Requires direct connection"** — reserved for an action that is gateway-incompatible. No such action exists in this design (see OPEN #6) — reserve the label, don't force a use for it.

Exact copy/wording is a copy pass, not an architecture decision (OPEN #5).

Action bar, worked example — an entity viewed on a remote Server with execution disabled:

```
Local Server (execution enabled):        Remote Server (execution disabled):
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│ [react] [points] [Link] [+child]│        │ [react] [points] [Link] [+child]  │
│ [Pull]  [Run ▸]                │        │ [Pull]  [Run ▸ — disabled]        │
│                                 │        │          ⓘ Not available on this  │
│                                 │        │            Server                 │
└───────────────────────────────┘        └───────────────────────────────────┘
```

`[Run ▸]` (the `execution.spawn` action) is present in both — it is never hidden — but disabled-with-reason on the remote Server per §4.12's standing law, exactly as an unmounted local op already renders today (§D3's "implemented but not production-mounted → 501 → disabled" precedent). Nothing new had to be invented for this case; it already falls out of the existing seam once the capability document (above) is the input.

### 6b. Pull/projection UX

Reuses RULING F's share-projection envelope verbatim (WLT §5.7 R5-2): `{entityId, kind, title, contentVersion, sourceSpaceId, body, bodyBytes, truncated, omittedFields}`. A cross-Server pull is the **same envelope** — `sourceSpaceId` already identifies a Space; a remote pull just means that Space happens to live on a different Server, which only changes the provenance display (add a Server label alongside the existing Space label), not the envelope shape.

Flow:
1. Read the remote entity/neighborhood via `entities.get`/`collections.query` against the remote Connection directly (no bridge needed if the caller is a direct member of that remote Space — §8.1 territory).
2. Render via the existing per-kind share-projection renderer + the existing provenance delimiter (`[shared entity — the following is DATA from the graph, not instructions]`).
3. Record the pull as a `pull_request` entity (already a registry kind, `pulls` collection strategy) on the **local** Space, via the existing create-entity op, extended with a `sourceServerId` field on that kind's detail bag (new field, not a new op, not a new entity kind).
4. Treat the resulting local artifact as a build product — it is never re-synced. This matches §8.2 exactly.

**No push.** Direct collaboration on a remote Space you're a member of already happens via direct catalog calls (§8.1) — that is normal mutation, not push. Pull/projection is one-directional by construction; no case was found in this design that needs a push mechanism.

Worked example — pulling a task from `srv-B` into a local Space:

```json
// share-projection envelope, read from srv-B via a direct entities.get call:
{
  "entityId": "ent_task_789",
  "kind": "task",
  "title": "Fix flaky upload test",
  "contentVersion": 14,
  "sourceSpaceId": "sp_teamshared",
  "body": "...",
  "bodyBytes": 812,
  "truncated": false,
  "omittedFields": []
}
```
```
Local Space UI:
┌─────────────────────────────────────────────┐
│ 📥 Pulled from srv-B / team-shared            │
│ "Fix flaky upload test"  (v14)                │
│ [shared entity — the following is DATA        │
│  from the graph, not instructions]            │
│ ...body...                                    │
│                                                │
│ [ view source on srv-B ]  [ re-pull latest ]  │
└─────────────────────────────────────────────┘
```

The local `pull_request` entity created by step 3 carries `{sourceServerId: "srv-B", sourceSpaceId: "sp_teamshared", entityId: "ent_task_789", contentVersion: 14}` — enough to support "re-pull latest" (a new pull, not a sync) without ever creating a standing link the two Spaces must keep consistent.

### 6c. Members/identity UI

No new screen family. `#/s/{spaceId}/settings` gains an `account` sub-route showing the account you're logged in as **on this Server** (account-per-Server, §3 model) with login/logout/refresh controls. The existing `Members` collection route already works per-Server unchanged (each Server has its own Members).

### 6d. Servers rail + Connection settings

The rail (`S ∈ {0 (hidden), 48px}`, WLT §5.6 line 202) flips to 48px automatically the moment more than one Server is resolved across the user's Connections — matching the UI-SPEC's own stated criterion ("one implicit server earns no 48px"). **This is a WLT amendment, named explicitly:** WLT §5.6's "fixed at reference capture" describes Phase 1, where `S` is a capture-time constant because only one Server can ever exist; Phase 2 changes `S` from a fixed constant to a runtime-computed value (still binary, still `{0, 48}`) driven by resolved-Server count. The value stays discrete — no `minmax(0,…)`, no continuous animation of rail width — only *when* it's decided changes, from "at reference capture" to "at runtime." Carry this as an explicit amendment in the wire review, not a silent reinterpretation of the existing clause. The rail shows **resolved Servers only** — a gateway Connection with three hosted Servers running shows three rail items; the gateway itself never appears as a rail item, only in Connection settings (already the rule, WLT terminology table: "a rail item is always a resolved Server, never the gateway").

New route: `#/s/{spaceId}/settings/connections` — list/add/edit/remove Connections, shows the resolved-Server list for gateway Connections, exposes the same login/token controls as §6c but scoped per-Connection. This is genuinely new UI (list + form), kept small on purpose — no new interaction pattern invented.

Rough wireframe, rail (S=48) plus the new settings surface:

```
┌────┬──────────────────────────────────────────────┐
│ S  │  SpaceTabBar → SpaceShell → MenuRail → ...    │
│48px│                                                │
│    │  #/s/{spaceId}/settings/connections            │
│[H] │  ┌──────────────────────────────────────────┐ │
│(●) │  │ Connections                               │ │
│    │  │  ● home            direct   connected     │ │
│[A] │  │  ● work-gateway     gateway  2 servers ▾  │ │
│    │  │      ├─ srv-A  alice-dev-box   running    │ │
│[B] │  │      └─ srv-B  team-shared     stopped ▶  │ │
│    │  │                                            │ │
│[+] │  │  [ + add connection ]                      │ │
└────┴──└──────────────────────────────────────────────┘
```

`[H]`, `[A]`, `[B]` are rail items for resolved Servers "home", `srv-A` (alias "A"), `srv-B` (alias "B") — the gateway itself ("work-gateway") never gets a rail slot, matching D1's rule. `[+]` opens the same add-connection form reachable from settings.

### 6e. Route grammar — the additive prefix

WLT §2.2 (line 100) names the requirement ("Server selection enters the grammar only in Phase 2, additive prefix") without specifying syntax — this design picks it:

```
#/srv/{serverId}/s/{spaceId}/...
```

`srv/{serverId}` prepends before the existing `s/{spaceId}` segment; every route below that point is byte-identical to today's grammar. The prefix is **omittable** — an omitted prefix means "the Server the default/active Connection resolves to," which is exactly today's implicit behavior. Every existing Phase-1 deep link keeps working unchanged; that's what makes this additive rather than a breaking rewrite.

`srv` (not `server`) matches the existing terse route-segment convention (`s`, `k`, `e`) and does not collide with the reserved-slug list (`home feed inbox workspace settings channel e k`).

The 2048-char length cap and the existing overflow drop order (`t` → `pin` → `p` → `q`) are unchanged — the new prefix is small, fixed-format, and doesn't compete with the existing overflow budget.

Deep links across Servers: a link the receiving client can't resolve (no matching Connection) fails the same way an unresolvable local link would — a "connection not found, add one?" prompt, not a new error class.

Multi-Server cursors are **not** part of the URL — they're a client runtime concern (§2.4's `(serverId, spaceId) → lastAppliedSeq` store). The URL says where you're looking; the cursor store tracks what you've already seen.

### 6f. Streaming: view vs. drive, reconnect/relay states

View-vs-drive enforcement is the server-side MUST-FIX from §2.6; the UI consequence is a `mode` badge on terminal chrome sourced from the grant response, plus client-side keystroke suppression in view mode as defense-in-depth (the server check is what actually matters — this is belt-and-suspenders, not the primary control). Reuses the existing `TerminalPool` lease model (`acquireHost`/`releaseHost`, UI-SPEC §4.8.1) unchanged structurally.

Reconnect/relay: extend the existing warm/suspend/evict state machine (`HIDE_GRACE_MS`, `RECONCILE_INTERVAL_MS`, `WARM_LRU_SIZE`) with one new transient state — **"reconnecting"** — for when a gateway-relayed PTY socket drops while the underlying hosted session is still alive (a relay hiccup, not a process exit). This must **not** trigger the epoch-based respawn path (`pty-ws-server.ts` epoch equality check) — a relay hiccup is not a respawn, and the existing replay protocol already handles this correctly as long as the gateway relay stays byte-transparent (§2.3).

---

## 7. L7 — Coherence

| New/changed thing | Existing convention it follows | Citation |
|---|---|---|
| `server.describe`, `gateway.*`, `auth.*` | Envelope `{data, requestId}`, `OperationName` catalog, `bindPath` | `envelope.ts:13-16`, `catalog.ts:28-30` |
| Gateway/home-Server error mapping | Reuse `upstream_unavailable`(503) + new `details.reason`, no new codes | R4-3 pattern; `contract.ts:488-521` |
| `gateway.listServers` | `Page<T>` keyset pagination | `contract.ts:206` |
| `auth.refresh`/`auth.revoke` replay | `clientMutationId` + request-hash ledger | `files.ts:173-204` |
| PTY grant token | `StreamAttachGrant.token` field (already declared, unwired) | `contract.ts:1073-1081`; `execution-handlers.ts:322` |
| `bridge.fetchBlob` activation | Reserved→v1 flip; reuses `files.download`'s membership/checksum logic unchanged | `catalog.ts:111,183-184`; `files.ts:282-313` |
| Multi-Server WS topology | `WorkspaceControlFrame`/`Ack` unchanged; one-socket-per-Server is client-side | `contract.ts:397-453` |
| Bearer `identityResolver` | Same `IdentityResolver` seam as loopback; same `claimsFor`/`db/client.ts` binding | `main.ts:266-271`; `loopback.ts:14-18` |
| Agent persona token | `AuthSession.kind='agent'` + `actingAsTeamMemberId` (already modeled) | `identity/types.ts:113-127` |
| Remote execution capability gating | `actions.list`/`capabilityEpoch`/`EntityCapabilities` seam | `contract.ts:877-896` |
| CLI `--connection` targeting | Existing 4-tier `context.ts` resolution, extended not replaced | `context.ts:170-201` |
| Connection config storage | Extends existing `~/.config/tm8/config.json` | `context.ts:96-155` |
| Route prefix | Additive per WLT §2.2 line 100; overflow/cap rules unchanged | WLT line 100 |
| Pull/projection envelope | RULING F share-projection envelope, unchanged shape | WLT §5.7 R5-2 |
| Server capability document | Same epoch-invalidation semantics as existing action discovery | `contract.ts:877-896` |

No second graph schema, no new entity kind for Server/Connection/Gateway, no new `CommandErrorCode`, no new pagination style, no fork in idempotency or version-conflict handling. The seven layers above add operations and client-side bookkeeping; they do not add a parallel domain model.

### 7.1 Anti-patterns this design forecloses

For an implementer or reviewer checking a future PR against this design, these are the concrete tells that a change has drifted off the boundary, each tied to the invariant it would violate:

- **A `serverId` column added to `workspace_events` or the `WorkspaceEvent` envelope** — violates §2.4's resolution of PHASE-2 §7; the client-side `(serverId, spaceId)` cursor key is sufficient, and a Server already knows its own identity without being told on every row.
- **A new `CommandErrorCode`** for any gateway/remote failure — violates §1.5; every such failure fits an existing frozen code + a `details.reason` (`upstream_unavailable` for transient hop failures, `not_implemented` for the permanent version-mismatch case, §1.4–1.5), following the R4-3 precedent already established for amendments.
- **The gateway process holding a Postgres connection string for a hosted Server** — violates §2.1 and T-D6/R1 directly; the gateway relays HTTP/WS, it never reads graph rows.
- **A hosted Server binding non-loopback** — violates §2.2 and S1; within a gateway's hosted fleet, the gateway is the only non-loopback listener. (A Direct, non-hosted Server may bind non-loopback only under S1's own auth-required carve-out, with §3.6's transport rules — that is a different topology, not an exception to this rule.)
- **`claimsFor` or a second `set_config` binder appearing outside `facade/context.ts`/`db/client.ts`** — violates the hard constraint in §3.5, the exact bug `test/one-identity-path.test.ts` exists to catch, now with a second lane (auth) that could reintroduce it.
- **A cross-Server foreign key or edge, anywhere, including inside a `pull_request` entity's edges** — violates §2.5 of the binding invariants; the `sourceServerId` field in §6b is a plain data field on a local entity, not a foreign key into another Server's tables.
- **A "hubspace" or "remote workspace" UI concept** — violates §2.3/§12; Workspace stays a UI view, the rail shows Servers, not a gateway-as-content abstraction.
- **A CLI flag named `--profile` for connection targeting** — collides with the existing Interaction Profile concept (§4.2); use `--connection`.

---

## 8. VERDICT

| Layer | Verdict |
|---|---|
| L1 Contract | Implementation-ready — DTOs, ops, and error reasons are fully specified. |
| L2 Backend | Implementation-ready; PTY drive-enforcement (§2.6) is a scoped MUST-FIX, not open-ended. |
| L3 Auth & Identity | Implementation-ready — reuses the existing unwired model plus one new bearer resolver and five new ops; `PgIdentityRepository`'s known bugs are scoped pre-work. |
| L4 CLI | Implementation-ready — one flag, two nouns, one config-file extension; no EBNF rewrite. |
| L5 Agent Harness | Implementation-ready — one manifest field gap-fill, one new minting op. |
| L6 UI | Mostly implementation-ready — capability delta, pull UX, rail, and route prefix are decided; wording/copy and a couple of visual states are deliberately left OPEN. |
| L7 Coherence | Demonstrated by the table above — no forked nouns, no second graph schema, no new error codes. |

**Overall: implementation-ready to begin Phase-2 build.** Three concrete MUST-FIX items carry forward into sequencing (PTY drive enforcement, `PgIdentityRepository` bug fixes, bearer resolver wiring) — they are scoped work items, not open design questions.

---

## 9. OPEN items

Each of these was deliberately not designed further, per the depth directive. One-line recommendation each.

1. **WS multi-socket backoff/health reporting** across many open Server connections — recommend simple per-socket exponential backoff with jitter; no central coordinator.
2. **Resume-past-retention behavior** — recommend defining a new success-ack frame (the contract's first: today's only ack, `WorkspaceControlAck`, is exclusively a refusal, `contract.ts:445-453`) carrying `truncated: true` when the requested `since` predates the earliest retained event; client falls back to a fresh read + re-subscribe.
3. **Hosted-Server resource governance numbers** (exact CPU/mem/disk caps) — recommend anchoring on the existing execution session cap (8) as an order-of-magnitude reference, tune empirically.
4. **Gateway↔hosted-Server shared-key rotation policy** — recommend standard periodic rotation (e.g. 90 days) with an overlap window.
5. **Capability-delta label copy/wording** — recommend a normal UI-copy pass, not an architecture decision.
6. **Whether any action is genuinely gateway-incompatible** (needing "requires direct connection") — recommend leaving the label reserved and unused until a concrete case appears.
7. **OS keychain library choice** for CLI credential storage — recommend evaluating an existing maintained cross-platform library at implementation time.
8. **Exact access/refresh token TTLs** — recommend 1h/30d as a reasonable default, adjust from real usage.
9. **Socket-side revocation check cadence** — recommend a 60s poll; revisit only if it proves too slow.
10. **Cross-relay observability/request-ID correlation** (§11 item 14) — recommend propagating the origin `requestId` unchanged, with a gateway-added `relayRequestId` in logs only (no wire-shape change).
11. **Conformance suite shape** for direct vs. gateway-mediated access (§11 item 15) — recommend running the existing conformance suite twice (once per topology) rather than writing a parallel suite.
12. **Hosted-workspace sandboxing mechanism** (containers vs. plain process + rlimit) — recommend starting with plain process + rlimit, matching the cited "process-per-user" precedent; revisit only if isolation proves insufficient.

---

## 10. BUILD SEQUENCING

1. **L1 contract additions** — new DTOs/ops/error reasons land as `reserved` catalog rows first; zero runtime behavior change.
2. **L3 auth wiring** — must land before any other remote-facing work, because every other layer's remote path assumes a working bearer identity. Fix `PgIdentityRepository`'s known bugs, wire the bearer `identityResolver`, ship `auth.*`, ship `teamMembers.mintToken`.
3. **L2 backend** — gateway relay + hosted-Server lifecycle, built against the now-working auth layer. The PTY drive-enforcement fix (§2.6) is independent of the gateway and could land standalone even earlier, since it also hardens the local single-Server case.
4. **L4 CLI + L5 harness** — thin clients over L1+L3+L2; can proceed in parallel once L3's `auth.*` ops exist, since both only need a working token to exchange.
5. **L6 UI** — capability delta, rail, route prefix, pull UX; depends on L1 (capability doc), L3 (account/connection settings), and L2 (streaming states) at least being stubbed. UI work can start against a mocked gateway before L2 is fully live.
6. **L7 coherence** is not a phase — it's the review checklist (§7's table) applied continuously at every step above.

**Auth sits at step 2, immediately after the pure-contract layer**, because routing, relay, CLI targeting, harness credential minting, and UI account/session display are all gated on having a real identity to hand — there is nothing else meaningfully buildable before it.

---

## 11. Coverage of PHASE-2 §11's 15 wire-spec items

| # | Item | Where addressed |
|---|---|---|
| 1 | Stable Server identity and metadata DTO | §1.1 (`ServerIdentity`) |
| 2 | Connection record DTO and secret-storage rules | §1.2 (`ConnectionRecord`) + §4.3 (config extension, keychain) |
| 3 | Direct and gateway discovery operations | §1.3 (`server.describe`, `gateway.listServers`) |
| 4 | Gateway Server-enumeration and resolution responses | §1.3 (`gateway.listServers`/`resolveServer`) |
| 5 | Login, exchange, refresh, revoke, disable flows | §3.1–3.3 (`auth.*`) |
| 6 | Capability discovery and contract-version negotiation | §1.4 |
| 7 | Multi-Server client route grammar and deep links | §6e |
| 8 | WebSocket subscription/control protocol | §2.4 (adopt existing frames, one-socket-per-Server) |
| 9 | Reconnect, retention-expiry, offline-cache behavior | §2.4, mostly; OPEN #2 for the truncated-resume edge |
| 10 | Blob relay and authorized fetch protocol | §2.5 |
| 11 | Terminal relay, attach, view/drive authorization | §2.6 (MUST-FIX) + §6f |
| 12 | Hosted-Server lifecycle and resource governance | §2.2; numbers OPEN #3 |
| 13 | Error mapping for gateway-vs-home-Server failures | §1.5 |
| 14 | Observability, request IDs, audit correlation across relays | OPEN #10 |
| 15 | Conformance suite for direct and gateway-mediated access | OPEN #11 |

---

## 12. Review dispositions

One bounded fix pass, applied against the adversarial review's 6 findings plus the coordinator's 2 minor additions. All applied, none rebutted.

- **R1 (BLOCKER, §3.1.1 account resolution at exchange)** — applied. §2.2.1 now provisions a pre-registered `Account` + a stable `subject` string as part of registration; new §3.1.1a specifies exchange-time resolution (found → mint session; not found → `forbidden`, never auto-provision).
- **R2 (MAJOR, §2.6 PTY re-scope)** — applied. §2.6 point 2 now names the real addition (`grantLookup` dependency, `Db` threaded through `main.ts:237`'s composition, upgrade-time rejection as the actual enforcement point) instead of "an unwired parameter finally being wired."
- **R3 (MAJOR, §3.6 direct non-loopback Servers)** — applied. Host allowlist/Origin/CORS now scoped to "any non-loopback Server," not gateway-only; the config renamed `NonLoopbackTransportConfig`; direct non-loopback browser access is explicitly not banned.
- **R4 (MINOR, assertion vs. HMAC)** — applied. §2.2.1 adopts shared HMAC-per-hosted-Server as the first-cut keying model; the asymmetric-assertion machinery is removed from the main line and kept only as a one-sentence upgrade path. §3.1.1's flow diagram and UNCERTAIN #2 updated to match; UNCERTAIN #2 is now marked resolved rather than open.
- **R5 (MINOR, token in PTY upgrade URL)** — applied. §2.6 adds an explicit log-redaction requirement for the `token` query param, tied to §11 item 14.
- **R6 (MINOR, OPEN #2 wording)** — applied. OPEN #2 now says "define a new success-ack frame (the contract's first)" instead of "add a flag."
- **C1 (coordinator, §6d vs. WLT §5.6 fixed-at-capture)** — applied. §6d now names the runtime-flip behavior as an explicit WLT amendment (constant → runtime-computed, still discrete `{0,48}`) rather than silently reinterpreting the existing clause.
- **C2 (coordinator, §1.4/§1.5 retryable-vs-code semantics)** — applied. `contract_version_unsupported` moved off `upstream_unavailable` onto `not_implemented` (already outside `RETRYABLE_BY_DEFAULT`), so the error *code* itself — not just the `retryable` flag — tells a naively-coded retry loop not to retry a permanent condition.
- **C3 (coordinator consistency patch, post-fix-pass)** — applied by the coordinator during verification: three clauses left stale by R3/C2 were aligned — §2.2's and §7.1's "gateway is the only non-loopback listener" scoped to the hosted-fleet topology (Direct non-loopback Servers are governed by §3.6), and §7.1's error-code anti-pattern updated to reflect `not_implemented` for the version-mismatch case.
