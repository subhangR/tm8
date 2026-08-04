# How hosted workspaces work

## 1. Separate collaboration from execution

Hosted workspaces use two independent boundaries:

| Boundary | Protects | Membership |
|---|---|---|
| **Space** | Graph data: tasks, docs, messages, files, edges | Many people and teammates |
| **Hosted workspace** | Execution: processes, credentials, home directory, project files, database | One owner identity |

Alice and Bob can work on the same task in the hub Space without either agent
running under the other's GitHub or cloud account. Their shared task is visible
because Space membership allows it; their credentials remain private because the
agents execute in different workspaces.

## 2. Components

### Hub gateway

The gateway authenticates users, routes each request to the correct tm8-server,
controls hosted-workspace lifecycle, relays streams, and exposes the bridge. It
does not query tenant databases directly and does not store tenant credentials.

### Hosted tm8-server

Every hosted workspace has its own tm8-server process. That process serves one
workspace and connects only to that workspace's database. A request routed to
Alice's server cannot select Bob's rows because Bob's rows are in another
database, behind another server.

### Container

Every hosted server runs inside its own rootless container with a private home,
filesystem, secret store, network policy, CPU/memory/PID limits, and persistent
volume. Containers are the baseline because self-service provisioning must be
reversible and resource-limited without creating host accounts from a web
request. Separate VMs are the stronger deployment for mutually distrusting
tenants or a threat model that requires separate kernels.

### Database

Each workspace gets one database in the hub's managed Postgres cluster. Database
names derive from server-minted immutable IDs, never a display name or other
client input. The shared cluster is an operational optimization; database
credentials and database ownership remain per workspace.

### Central teammate and bridge

The central teammate works in the hub's shared graph. It proposes work and reads
reported results. Private work crosses the boundary only through an explicit
bridge operation. A bridge request records the authenticated requester, target
workspace, payload reference, policy decision, and outcome.

## 3. Provisioning flow

Provisioning is a saga, not one create call:

```text
node admin requests workspace
        │
        ▼
server mints workspace ID ── never derived from display name
        │
        ▼
create database + database role
        │
        ▼
create private volumes + secret store
        │
        ▼
create rootless container with resource/network limits
        │
        ▼
migrate database and create owner identity
        │
        ▼
route through gateway
        │
        ▼
end-to-end probe AS the new owner
        │
        ├── fails: mark unhealthy and roll back/reconcile
        └── passes: workspace is ready
```

No intermediate success makes the workspace ready. The readiness proof is an
authenticated end-to-end request routed through the gateway to the new server
and database as the new owner.

## 4. Session launch flow

1. The caller authenticates at the gateway.
2. The server derives the caller's workspace from the authenticated identity.
   A client never supplies the authoritative workspace ID.
3. The target server verifies that the selected teammate and task are visible to
   the caller.
4. tm8 mints a session-bound agent credential scoped to the teammate.
5. The hosted workspace starts the process inside its own execution boundary.
6. Every terminal/control frame is checked against the session's workspace.
7. Session output and results are reported through normal graph or bridge
   operations with the executor's identity preserved.

If the correct workspace cannot be reached, launch fails. There is no fallback
that starts the process in the hub server's environment.

## 5. Collaboration flow

The hub does not read private tenant databases. Collaboration therefore has an
explicit direction:

1. People and the central teammate create shared work in a hub Space.
2. A hosted workspace pulls an authorized snapshot or receives a spawn request
   through the bridge.
3. The owner's policy accepts or denies the request. Default is deny.
4. Work runs in the owner's environment and under the owner's identity.
5. The workspace reports an intentional result back to the shared Space.

This makes the privacy behavior unsurprising: the hub sees what a workspace
explicitly reports, not its repository, shell history, secrets, or unrelated
tasks.

## 6. Credential flow

The server and manifest carry secret **names**, never secret values. Values are
resolved inside the private workspace at execution time. The target design keeps
the tm8 agent credential out of the general child environment as well, exposing
it to the tm8 CLI through a workspace-local authenticated socket so build tools
and package scripts do not inherit it.

The node admin should not upload a member's GitHub or cloud credentials. Members
enrol and rotate their own credentials inside their workspace.

## 7. Failure rules

- A missing runner/container is an unavailable workspace, not permission to run
  on the hub.
- A partial provision is unhealthy until the end-to-end probe succeeds.
- A revoked user loses gateway sessions, bridge grants, and running processes;
  authored graph history remains attributed to them.
- A workspace/database mismatch is a security failure and must fail closed.
- macOS remains single-workspace unless it can supply the same isolation
  properties; it must not silently emulate multi-workspace mode with one uid.

