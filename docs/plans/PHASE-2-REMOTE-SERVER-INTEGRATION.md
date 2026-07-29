# tm8 — Phase 2 Remote Server Integration

**Status:** deferred design boundary, documentation-only, 2026-07-26  
**Phase:** Phase 2; not part of the local Phase-1 architecture or current implementation  
**Purpose:** define how a remote Server connects to the local domain without inventing a parallel domain model  
**Dependency:** `DOMAIN-ARCHITECTURE-DECISIONS.md`; `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 FINAL GO

> **Normative subordination:** local domain behavior is governed by the v2.11 workspace-layout spec, its closed review ledger, and the FINAL `docs/tm8-architecture/00-10` corpus. This companion fixes only the integration boundary. Every connection, gateway, relay, route-prefix, token-exchange, and multi-Server event choice marked as a proposal remains subject to the separate Phase-2 wire review.

---

## 1. Decision

Remote operation must reuse the local domain exactly.

A remote Server is an ordinary tm8 Server reached through a different Connection. `Remote` is relative to the client; it is not an entity kind, database boundary, or separate API family.

```text
tm8 client
  └─ Connection
      ├─ direct endpoint ───────────→ Server
      └─ gateway endpoint → Gateway → Server
                                      ├─ Spaces
                                      ├─ ProjectResources
                                      └─ Execution capabilities
```

There is no `hubspace`, `remote_workspace`, remote-only Space, or replicated shadow Server.

This document records invariants and the required future wire specification. It deliberately does not freeze unreviewed endpoint names or authorize implementation.

---

## 2. Local-domain invariants that remote must preserve

1. **Server remains the root domain.** A gateway resolves and routes to Servers; it does not replace them.
2. **A Space is single-homed.** Its entities, edges, memberships, event sequence, files, and history have one home Server.
3. **Workspace remains a UI view.** Remote topology never introduces another Workspace domain object.
4. **Projects remain Server-local.** A ProjectResource links only to Spaces on its Server.
5. **Graph entities stay Space-scoped.** No cross-Server edge or foreign key exists.
6. **One operation catalog remains the graph API.** Local and remote entity behavior cannot fork.
7. **The gateway owns routing and relay only.** It never becomes the graph store or primary account store.
8. **Live bytes are not graph data.** Terminal streams may be relayed, but are never replicated through event storage.

---

## 3. Terms

| Term | Meaning |
|---|---|
| **Connection** | Client-side configuration for reaching a Server directly or through a gateway |
| **Direct endpoint** | Network endpoint of one Server |
| **Gateway endpoint** | Network endpoint that authenticates and resolves one or more hosted Servers |
| **Server** | Same top-level tm8 domain used locally |
| **Home Server** | Server that owns a Space, entity, ProjectResource, work session, or blob |
| **Remote Server** | Any Server reached through a non-local Connection; relative adjective only |
| **Bridge** | Client-side/server-side module that invokes the remote Server's normal catalog and performs explicit pull/report-back behavior |
| **Relay** | Dumb transport forwarding for streams or requests when direct reachability is unavailable |

---

## 4. Connection modes

### 4.1 Direct Connection

The client stores one endpoint and authenticates directly to one Server:

```text
Connection → Server → Spaces
```

The Server advertises its stable identity, contract version, capabilities, and the Spaces visible to the authenticated account.

### 4.2 Gateway Connection

The client authenticates to a gateway, which enumerates or resolves hosted Servers:

```text
Connection → Gateway → Server A
                     → Server B
                     → Server C
```

The UI rail displays resolved Servers, never the gateway as though it were graph content. A gateway may be represented in Connection Settings, but a rail destination is a Server.

The gateway may:

- Authenticate and exchange tokens
- Route requests to a resolved Server
- Start/stop hosted Server processes
- Relay event or terminal streams
- Apply infrastructure resource limits

The gateway may not:

- Store authoritative Spaces or entities
- Mutate graph tables outside the operation catalog
- Own ProjectResources on behalf of a Server
- Become the primary durable event log
- Inspect or persist relayed terminal bytes as graph history

---

## 5. API reuse

After a Connection resolves a Server and credential, the client uses the same catalog operations it uses locally:

```text
spaces.list
entities.get
collections.query
messages.post              with anchorId in its input
events.poll
execution.spawn            when capability permits
```

Remote access changes:

- Server selection/base URL
- Authentication context
- Network failure and reconnect behavior
- Capability availability
- Optional relay mechanics

Remote access does **not** change:

- Operation names
- Entity DTOs
- Space membership semantics
- Error taxonomy
- Keyset pagination
- Command idempotency
- Version conflict behavior
- `WorkspaceEvent` payloads

Gateway and Connection control-plane operations are additive infrastructure APIs. They must not duplicate graph CRUD.

---

## 6. Identity and authorization

The current architecture uses account-per-Server identity:

- A human authenticates to each Server on which they have an account.
- A Server account may have membership in zero or more Spaces.
- Space membership and role authorize graph access.
- Server owner/admin authorizes infrastructure and ProjectResource administration.
- A Space role alone never grants arbitrary code execution on a host.

Phase 2 must specify:

- Direct login and token exchange
- Gateway login and Server-scoped token exchange
- Token storage, expiry, refresh, and revocation
- Account disablement effects on sockets and bridge tokens
- Agent bearer tokens narrowed to a team-member persona
- Origin/Host/CORS/CSRF rules for browser clients
- Stable future compatibility with portable identity without rekeying history

Portable cross-Server identity is not required to connect the domain model; attribution remains Server-local until a later identity amendment.

---

## 7. Space and event behavior

A remote Space remains owned by its home Server. Clients query and mutate it directly through that Server's catalog.

Durable event ordering remains `(spaceId, seq)` on the wire because the home Server owns the Space. A multi-Server client stores cursors under a composite client-side key:

```text
(serverId, spaceId) → lastAppliedSeq
```

**Phase-2 proposal:** retain the existing Space-scoped `WorkspaceEvent` envelope without adding `serverId`; the selected Connection supplies Server context, and the client keys cursors by `(serverId, spaceId)`. This is coherent with the current contract, but the future wire specification must explicitly approve or replace it. Adding a Server field to every graph event appears redundant, but that conclusion is not yet a settled corpus invariant.

Phase 2 must specify:

- Client-to-server subscribe/unsubscribe control frames
- Membership authorization for subscriptions
- Reconnect and cursor replay
- Token refresh while sockets are active
- Behavior after the event-retention window expires
- Multi-Server backoff and health reporting
- Ephemeral presence isolation from durable event cursors

Remote event caches are memory-bounded and cursor-keyed. Durable replication of remote events into the local graph is forbidden.

---

## 8. Cross-Server collaboration

### 8.1 Direct participation

If the caller is a member of a remote Space, they invoke that Space's home Server directly through the normal catalog. Creates, patches, messages, edges, and commands remain remote mutations on the authoritative graph.

### 8.2 Pull/projection

When remote content is needed in a local Space or Project context, the bridge performs an explicit projection:

- Read a remote entity or neighborhood at a version.
- Produce a local artifact/projection with provenance.
- Record the pull on the source through the sanctioned command/edge path.
- Treat the local artifact as a build product, not a synchronized clone.
- Report back only through catalogued append or command operations.

No field-level multi-master synchronization is allowed.

### 8.3 Project boundary

ProjectResources never cross Servers:

```text
Allowed:
  Server A / Project A ↔ Server A / Space A

Forbidden:
  Server A / Project A ↔ Server B / Space B

Cross-Server alternative:
  Server B entity → explicit projection/handoff → Server A Space/entity/session
```

This avoids distributed transactions, cross-database foreign keys, and ambiguous execution ownership.

---

## 9. Files and live streams

### 9.1 Files

Blob metadata remains a Space entity. Blob bytes remain on the Space's home Server. Remote download and future bridge fetch must:

- Recheck Space membership
- Verify the file entity and storage path
- Preserve size, MIME, checksum, and content-disposition rules
- Relay bytes without copying graph authority to the gateway

The reserved bridge blob operation remains unimplemented until the Phase-2 wire contract is approved.

### 9.2 Terminal streams

Session state remains a `work_session` entity on its home Server. Terminal bytes flow over a live socket to that Server or through a relay.

- The graph authorizes stream attachment.
- The session home Server owns the PTY.
- A gateway relay is a dumb pipe.
- Stream bytes never enter `workspace_events` or a remote cache.
- Remote viewing does not imply permission to drive input.
- Hosted execution is disabled unless the Server advertises and authorizes it.

---

## 10. Hosted execution boundary

Graph membership and execution permission are separate.

Phase 2 hosted execution must define:

- Server-level execution enablement
- Space/project trust requirements
- Per-Server and per-Space concurrency caps
- Process, CPU, memory, and disk limits
- Credential and configuration-directory isolation
- Worktree/path containment
- View-versus-drive stream grants
- Termination as the cancellation mechanism
- Audit through the command ledger

A remote Space member may be allowed to collaborate while `execution.spawn` honestly returns `not_implemented` or `forbidden` on that Server composition.

---

## 11. Required Phase-2 wire specification

Remote is not implementation-ready until a reviewed specification freezes:

1. Stable Server identity and metadata DTO
2. Connection record DTO and secret-storage rules
3. Direct and gateway discovery operations
4. Gateway Server-enumeration and resolution responses
5. Login, exchange, refresh, revoke, and disable flows
6. Capability discovery and contract-version negotiation
7. Multi-Server client route grammar and deep links
8. WebSocket subscription/control protocol
9. Reconnect, retention-expiry, and offline-cache behavior
10. Blob relay and authorized fetch protocol
11. Terminal relay, attach, and view/drive authorization
12. Hosted-Server lifecycle and resource governance
13. Error mapping for gateway-versus-home-Server failures
14. Observability, request IDs, and audit correlation across relays
15. Conformance suite for direct and gateway-mediated access

Endpoint names and wire shapes belong in that specification, not in implementation pull requests.

---

## 12. Non-goals

Phase 2 remote integration does not introduce:

- A second graph schema
- A remote-only entity model
- Cross-Server edges or foreign keys
- Transparent field-level replication
- Multi-master Spaces
- Gateway-owned graph data
- Automatic ProjectResource movement
- A new meaning of Workspace
- A `hubspace` noun

---

## 13. Coherence assessment

### Conceptual remote fit — **8.2/10, strong foundation**

The local domain accepts remote operation cleanly because Server and Space ownership are explicit, the API is contract-first, and single-homing prevents distributed graph authority.

The design is not rated as implementation-ready because the control-plane wire contract, identity flows, subscription protocol, and relay behavior remain intentionally unspecified. Those are Phase-2 tasks, not defects in the local domain.

The remote design should improve without changing local nouns. If a future proposal requires redefining Server, Space, Workspace, ProjectResource, or entity ownership merely to support transport, the proposal is violating this boundary.
