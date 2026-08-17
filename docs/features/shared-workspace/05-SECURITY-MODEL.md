# Hosted-workspace security model

## Security promise

Within the supported deployment threat model, one tenant must not be able to use
tm8, the network, the filesystem, process inspection, a session identifier, or a
crafted request to read or control another tenant's workspace.

That promise is narrower and more honest than “secure by any means”: the node
operator and host kernel remain trusted. A root or kernel compromise can read
every tenant. Mutually distrusting tenants who do not trust a shared kernel need
separate VMs; tenants who do not trust the operator need separate nodes.

## Assets and boundaries

| Asset | Boundary |
|---|---|
| Shared tasks, docs, messages, files | Space membership and graph authorization |
| Workspace database | Dedicated database credential and server binding |
| Repositories and home directory | Private volume/container or VM |
| GitHub/cloud/model credentials | Workspace-local secret store |
| Agent authority | Short-lived, session-bound, teammate-scoped credential |
| Terminal/control stream | Explicit session→workspace authorization on every action/frame |
| Cross-workspace work/result | Authenticated, policy-checked bridge operation |
| CPU, memory, PIDs, disk, network | Container/VM resource and network policy |

## Non-negotiable invariants

1. **Workspace is derived from identity.** The authoritative workspace ID never
   comes from a client payload.
2. **One server, one workspace, one database.** A hosted server cannot select a
   database dynamically per request.
3. **One execution boundary per workspace.** No two tenants share a uid, home,
   container, secret store, or writable project root.
4. **No anonymous owner in multi-workspace mode.** Missing/invalid credentials
   receive 401 even on loopback.
5. **Every agent is authenticated.** Its credential is session-bound and scoped
   to the teammate it may act as.
6. **Secrets do not transit the hub.** The graph and manifest record names, never
   values; values are resolved inside the workspace.
7. **Session ownership is checked repeatedly.** Attach-time authorization alone
   is insufficient; input, resize, termination, replay, and runner frames enforce
   the same workspace binding.
8. **Paths are contained before and after resolution.** Symlinks cannot escape a
   workspace root.
9. **No unsafe fallback.** An unavailable private runner/container makes launch
   fail; it never moves execution to the hub.
10. **Private artifacts have private modes.** Manifest/journal files are 0600 and
    their roots and scratch directories are 0700, including upgraded nodes.
11. **Provisioning identifiers are server-minted.** Display names never become
    database, container, role, route, or filesystem identifiers.
12. **Default deny.** Execution, bridge grants, and delegated launch are disabled
    until explicitly enabled at the appropriate scope.

## Threats the design must test

### Horizontal request tampering

Alice changes a workspace, session, file, or database identifier to Bob's. The
gateway/server derives Alice's workspace independently and rejects the mismatch.

### Loopback privilege escalation

An agent calls the hub API on `127.0.0.1` without a credential. Multi-workspace
mode returns 401. Loopback conveys locality, not identity.

### Filesystem and process snooping

An agent reads another home, `/proc/<pid>/environ`, shared temp directory, stale
0644 manifest, SSH agent, or container socket. Separate execution identities and
private roots deny it; tests cover pre-existing files and temp/symlink handling.

### Credential inheritance

The hub accidentally copies its own model-provider or cloud environment into a
tenant process. The spawn contract uses workspace-local named-secret resolution
and rejects ambient operator credentials.

### Session-frame confusion

A runner or browser attaches legitimately, then sends control frames naming a
different session. Every frame/action rechecks the session's workspace.

### Bridge deputy attack

The central teammate requests work with Alice's authority or tricks Alice's
workspace into reporting private context. Requests preserve requester and
executor identity separately, default to deny, use versioned policy, and report
only bounded intentional results.

### Resource denial

A tenant fork-bombs, fills disk, or saturates network. Cgroup/quota/network limits
contain the tenant before node-wide resources are exhausted. This is availability
isolation, not only confidentiality.

## What is intentionally shared

Data posted to a shared Space is shared with its authorized members. Results
reported to the hub are visible under that Space's policy. The central teammate
therefore has a cross-tenant read position over **reported results**, not over
private workspaces. The system cannot stop a member from intentionally posting a
secret into a shared task or message; prevention and redaction at that boundary
remain product requirements.

## Trusted computing base

The trusted computing base includes the host operator/kernel, gateway,
provisioner, workspace server image, container/VM runtime, Postgres cluster, and
bridge implementation. The provisioner is especially sensitive because it can
create databases, containers, volumes, and credentials. Keep it small,
allowlisted, node-admin-only, auditable, and free of shell interpolation.

## Release gate

Multi-workspace mode must stay unavailable until all items in the security test
matrix in [Implementation status](06-IMPLEMENTATION-STATUS.md) pass in CI and on
the production deployment shape. Documentation, process-per-user servers, or RLS
alone do not satisfy the execution-isolation requirement.

