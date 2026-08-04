# tm8 remote status — 2026-07-29

> ### ⚠ PARTIALLY SUPERSEDED — verified 2026-07-31
>
> Specific claims below were re-checked against the tree and found **false or stale**. The body is left unedited: it was accurate when written, and it remains the historical record. Corrections, with `file:line`, are tabulated in **`docs/identity/IDENTITY-OPEN-THREADS.md` §3**; the verified current state is **`docs/identity/AUTH-AND-IDENTITY-VERIFIED-STATE.md`**.
>
> - "A's bearer token is deliberately not forwarded to B" — **true of the CLI path only**; `http/remote-proxy.ts:38-47` forwards `authorization` and `cookie`.
> - "Add server is visible but disabled" / "Unavailable remote UI is honest" — **no longer true**; the UI server switcher is real and mounted.
> - "The catalog currently has 106 operations" — **stale**; measured 110 / 108 `v1` / 2 reserved.
> - "`PgIdentityRepository` … auth-session row names differ" — **understated 2–3×**; ~24 defects, and it also needs a new migration.
>
> **Do not cite this document for current behaviour without re-verifying against code.** Three claims were published as verified during a 2026-07-31 investigation purely by trusting it; all three were wrong.


**Scope:** current working tree at `HEAD 1a1b70e`, including uncommitted work present during the audit.

## Implementation update — local named-Server slice

The first local-only slice is now implemented and tested:

- Server A persists node-local named routes through `serverConnections.list/create/get/delete`.
- `tm8 server add|get|list|remove` manages those routes; add checks the target's `/health` first.
- `tm8 --server <name> …` resolves the name through A and invokes the ordinary catalog API directly on B.
- A's bearer token is deliberately not forwarded to B. `username` is stored as future auth metadata;
  no password is stored because remote authentication is not implemented yet.
- Two real Servers were started on `127.0.0.1:4710` and `127.0.0.1:4720`, backed by separate databases.
  Through A's `remote-b` connection the CLI created a Space, Teammate, and ProjectResource on B, linked
  the project, and spawned a work session whose state was `running` and whose node was `127.0.0.1:4720`.

This does not add browser Connection selection, cross-Server pull/projection, non-loopback networking,
or authentication. Those remain later gates below.

## Bottom line

tm8 is a capable **single local Server** with a real graph API, event stream, server-side PTY execution,
CLI client, and browser UI. It is **not yet a multi-Server product**.

Today an operator can run a second isolated tm8 process on another local port and data directory, and a
CLI can be manually pointed at one base URL at a time. The product cannot register that second Server,
authenticate to it, show both Servers together, pull/projection data between them, or target sessions at
it through a saved Connection. A Server on another machine is unreachable by design because tm8 refuses
non-loopback binds until bearer authentication and transport hardening exist.

The remote architecture is strong enough to build from. The missing work is mostly control plane,
authentication, multi-connection client state, and relay/security work—not a replacement graph model.

## Requested capability matrix

| User outcome | Current status | What works now | Missing product work |
|---|---|---|---|
| Run another tm8 Server locally | **Partial / operator-only** | Distinct `TM8_PORT`, `TM8_UI_PORT`, `TM8_PG_PORT`, and `TM8_DATA_DIR` are documented and guarded | No Server registry, lifecycle UI, or saved Connection |
| Add that Server in the local UI | **Not implemented** | The complete add/resolved/gateway/failure frame set exists as honest UI specimens | Connect is intentionally refused; no endpoint discovery operation or Connection store |
| Connect to it | **Partial / one target at a time** | CLI accepts a configured `baseUrl`; browser real seam accepts an injected base URL | No `server.describe`, per-Server auth, `--server`, Connection selection, or concurrent clients |
| Read its Spaces and entities | **Mechanism exists, product flow absent** | Normal catalog reads are transport-independent | No authenticated remote selection, Server-scoped route, or multi-Server cache ownership |
| Pull data into the local Server | **Not implemented** | Local `entities.commands.pull` semantics and provenance-oriented graph nouns exist | No cross-Server bridge; `bridge.fetchBlob` is reserved and forced to 501; no projection/report-back workflow |
| Run sessions on it | **Local engine implemented; remote targeting absent** | `execution.spawn`, prompt, terminate, attach, PTY replay, heartbeat, and browser terminal exist | No saved target Server, remote token flow, or authorized remote PTY attach |
| See live events from both Servers | **Not implemented** | Strong per-Space WS + poll fallback and reconnect logic for one Server | Need one socket per Server and cursor key `(serverId, spaceId)` |
| Use a gateway / hosted Servers | **Design only** | High-level gateway and relay boundaries are documented | No gateway/bridge package, routes, process manager, relay, or topology conformance suite |

## Implemented and good

1. **The domain boundary is correct for remote.** A Server owns its Spaces; Spaces stay single-homed;
   gateways route but do not own graph data; Projects remain Server-local. This avoids distributed
   transactions and accidental multi-master replication.
2. **The API is already transport-independent.** The catalog currently has 106 operations: 104 `v1`
   and two explicit reserved operations (`search.query`, `bridge.fetchBlob`). UI, CLI, and Server use
   catalog-derived paths instead of inventing a remote-only API family.
3. **The local data plane is substantial.** Graph reads/writes, messages, files, projects, events,
   execution, liveness, and PTY streaming exist. Remote should select a Server and reuse these operations.
4. **Event recovery is a good foundation.** The browser uses WS subscription plus HTTP polling fallback,
   a single dispatch path, monotonic per-Space cursors, reconnect backoff, and replay/resume.
5. **Execution is genuinely server-side.** Spawned agents run on the Server that owns the session. The
   manifest already records Server identity-shaped fields (`id`, `baseUrl`, catalog digest, grammar
   version, capability epoch), and the CLI already carries `TM8_BASE_URL` plus an optional bearer-token
   seam.
6. **Local stack isolation is treated seriously.** Separate ports and data roots are documented; shared
   data directories are refused rather than guessed around.
7. **Unavailable remote UI is honest.** “Add server” is visible but disabled with an exact Phase-2 reason;
   the UI does not pretend specimen data came from a handshake.
8. **The remote design is coherent.** The Phase-2 documents define direct and gateway Connections,
   Server discovery, auth/token exchange, per-Server routing, relay boundaries, projection instead of
   replication, and a build sequence.

## Missing, risky, or bad

### Product blockers

- There is no stable persisted Server identity and no `server.describe` operation.
- There is no Connection DTO/store, connection CRUD, selected-Server route prefix, or server-grouped rail.
- The browser constructs one real seam for the app lifetime and sends no bearer authorization header.
- The CLI now supports local named Connections and an explicit `--server` target. It still has no
  authenticated or non-loopback remote transport.
- The Server uses loopback auto-owner identity. Auth tables and services exist, but login, refresh,
  revoke, session-inspection, and bearer identity resolution are not mounted as public operations.
- The Server hard-refuses non-loopback binding. This is correct today, but means a second machine cannot
  be connected.
- There is no bridge runtime. The only explicit bridge operation, blob fetch, is contract-reserved and
  cannot be registered by the handler registry.
- There is no gateway runtime or hosted-Server process manager.

### Security blockers—must precede remote exposure

- Host allowlisting, Origin checks, CORS posture, and browser mutation CSRF checks are wired as no-ops.
- The PTY WebSocket currently accepts a `sessionId`, upgrades, and forwards binary input directly to the
  PTY without checking the attach grant, identity, view/drive mode, or Origin. Exposing this remotely
  would turn knowledge of a session id into terminal read/write access.
- The production composition resolves every request as the local owner. A bearer token sent today does
  not select an authenticated remote account.
- The Postgres identity repository is not ready for remote auth: its auth-session row names currently
  differ from migration `002` (`team_member_id`/`issued_at`/`last_seen_at` versus
  `acting_as_team_member_id`/`created_at`/`last_used_at`). Passing identity tests are primarily against
  the in-memory repository, so they do not close this integration gap.

### Delivery and evidence risks

- The detailed remote design is a draft/untracked working-tree document, while the older boundary doc
  still says the wire contract is not implementation-ready. It needs one explicit ratification and a
  catalog amendment before code starts.
- The working tree is heavily dirty across contract, execution, Server, CLI, and UI. Remote work should
  begin from a named stabilized checkpoint, not on top of unidentified concurrent edits.
- Targeted contract tests are currently red: 40/43 passed. The failures are source/test drift around the
  newly required liveness capacity and UUID-only spawn fields. Remote contract additions should not be
  layered onto a red contract gate.
- No direct-vs-gateway topology conformance suite exists.

## Current plan in the repository

The architecture plans four reusable pieces:

1. **Connection:** client-side record for a direct Server or a gateway endpoint.
2. **Bridge:** outbound client using the normal operation catalog for reads, writes, event subscription,
   explicit pull/projection, blob fetch, and report-back.
3. **Gateway:** authentication, Server enumeration/resolution, hosted-Server lifecycle, and dumb relays;
   never graph storage.
4. **Home Server:** authoritative owner of each Space, entity, file, work session, event sequence, and PTY.

The detailed Phase-2 draft proposes `server.describe`, `gateway.listServers`,
`gateway.resolveServer`, auth login/exchange/refresh/revoke operations, team-member token minting,
Server-scoped routes, one event socket per Server, and gateway relays. It explicitly forbids transparent
replication and cross-Server graph edges.

## Recommended delivery order

### Gate R0 — stabilize and harden the local node

- Make the contract suite green and freeze a checkpoint.
- Align `PgIdentityRepository` with migration `002` and add real Postgres auth-session tests.
- Implement bearer identity resolution through the single existing identity seam.
- Enforce Host, Origin, CORS, and CSRF rules.
- Require and consume an attach grant on PTY upgrade; enforce view versus drive before accepting input.

**Exit:** a bearer-authenticated non-loopback Server can be enabled without widening the local auto-owner
path, and a hostile browser cannot attach to or drive a PTY.

### Gate R1 — direct Connection MVP (build this before a gateway)

- Add stable Server identity and `server.describe`.
- Freeze `ConnectionRecord` and auth/session wire DTOs in `@tm8/contract`.
- Add auth login/session/refresh/logout and token revocation.
- Add CLI `server`/`connection` commands plus `--server <name>` targeting.
- Add a local Connection store with secrets held through an opaque secret reference.
- Make the UI own a client/seam per Server; add the real endpoint handshake, sign-in, saved Connection,
  server-grouped rail, and `/s/:serverId/...` deep-link prefix.
- Key event state and caches by `(serverId, spaceId)` and maintain one WS per connected Server.
- Target execution calls and terminal sockets at the session's home Server.

**Exit:** the local UI can add Server B, browse B's Spaces, create/mutate entities on B, spawn a session
on B, prompt/terminate it, and reconnect to its terminal—while Server A remains open.

### Gate R2 — explicit cross-Server pull and report-back

- Build the bridge as a catalog client, not a second API.
- Pull a remote entity/subtree at a version into a local projection artifact with source provenance.
- Record the pull on the source Server and make report-back append-only/idempotent.
- Unreserve and implement authorized `bridge.fetchBlob` only with the approved wire shape.
- Add stale-source and version-conflict UI; never imply a live synchronized clone.

**Exit:** an entity owned by B can be intentionally projected into A, refreshed explicitly, and linked
back to its immutable source identity/version without creating cross-Server edges.

### Gate R3 — gateway and hosted Servers

- Add Server enumeration/resolution, token exchange, hosted lifecycle, quotas, cold-start states, event
  relay, blob relay, and PTY relay.
- Run the same conformance suite against direct and gateway-mediated topologies.

This is not required for the first useful multi-Server workflow. Direct Connections should prove the
domain and security model before hosted orchestration is added.

## Acceptance scenario for the requested outcome

1. Start A on `4610` with data root A and B on `4620` with data root B.
2. In A's UI, choose **Add server**, enter B's endpoint, verify B's stable identity/version, authenticate,
   and save the Connection without plaintext credentials in the config record.
3. The rail shows A and B as separate Server groups. Spaces and routes retain their home Server context.
4. Open a B Space, read and mutate its graph, disconnect/reconnect, and resume events from B's cursor.
5. Pull one B entity into an A Space. The A artifact records B, source entity id, source version, and pull
   time; no automatic bidirectional sync occurs.
6. Spawn a session targeted at B. The work-session entity and PTY live on B; the browser attaches using a
   scoped grant, can reconnect/replay, and cannot drive with a view-only grant.
7. Revoke the B credential. New HTTP calls and existing event/PTY sockets stop within the specified
   revocation window while A continues working.

## Audit evidence

Targeted tests run against the current working tree:

- Server frame + identity + PTY: **104/104 passed**.
- CLI context + HTTP client: **31/31 passed**.
- UI real HTTP/WS connection + auth specimens: **112/112 passed**.
- Contract focused suite: **40/43 passed**; three drift failures described above.

These are focused foundation checks, not a claim that the dirty working tree or a remote topology is
release-green.
