# Hosted-workspace implementation status

**Checked against:** repository tree on 2026-08-03.

This page prevents the design and user guides from being mistaken for shipped
behavior. Update it when code lands; do not infer status from a design document.

## Current state

| Capability | Status | Evidence / consequence |
|---|---|---|
| Space-scoped graph authorization and RLS | Shipped for the current server | The server binds the application DB role; this protects graph data according to current policies. |
| Session-bound agent token | Shipped | `execution-handlers.ts` issues a work-session token; `SpawnService` injects it for the agent. |
| Private manifest/journal/scratch modes | Implemented in this change, pending merge/deploy | `SpawnService` creates 0600 files and 0700 roots, repairs old files/dirs, and refuses temp-file symlink redirection; covered by `spawn-loop.test.ts`. |
| Postgres cluster lifecycle primitives | Partial | `packages/server/src/sidecar/` can create/migrate/manage databases; it is not a tenant provisioner. |
| Gateway authentication and routing | Not implemented | No gateway package or hosted-workspace routing surface exists. |
| Hosted server provisioner | Not implemented | No component creates one tm8-server/container per workspace. |
| Workspace data model and bindings | Not implemented | No first-class hosted-workspace lifecycle or workspace ID on all required execution resources. |
| Rootless container/VM isolation | Not implemented | Current PTYs run under the tm8-server OS identity. |
| Multi-workspace auto-owner shutdown | Not implemented | Missing credentials still resolve to the local owner path. This is unsafe for multi-user exposure. |
| Workspace-local named-secret resolution | Not implemented | The current spawn environment still inherits selected provider credentials and home/config paths from the server environment. |
| Agent credential broker/socket | Not implemented | The agent token remains in the agent environment and can be inherited by child processes. |
| Per-workspace resource/network policy | Not implemented | No tenant cgroup/quota/network lifecycle exists. |
| Bridge pull/report/delegated-launch protocol | Not implemented | Only a reserved bridge blob operation exists; there is no collaboration bridge. |
| Hosted-workspace administration UI | Not implemented | Users cannot create or manage hosted workspaces from the UI. |
| Hosted-workspace member UI | Not implemented | No enrolment, secret, isolation, health, or bridge-policy screen exists. |
| Multi-tenant isolation test suite | Not implemented | Current tests do not launch two real tenant containers/VMs and attack the boundary. |

## What is safe to use today

Use tm8 as a single-owner local/node environment under the current documented
deployment assumptions. Space membership can separate graph visibility among
authenticated users, but current execution does **not** separate their OS
credentials, home directories, or processes.

Do not put mutually private GitHub/cloud credentials into agents sharing the
current tm8-server process. Do not expose the current loopback auto-owner server
as a multi-user hosted service.

## Minimum implementation order

1. **Close ambient authority:** disable unauthenticated owner behavior whenever
   hosted workspaces are enabled; stop copying server credentials/home into
   tenant launches; keep private on-disk modes and agent tokens enforced.
2. **Create the workspace model:** immutable workspace ID and owner binding;
   workspace ID on projects/sessions/allocations; server-derived selection;
   authorization and negative tests.
3. **Build the gateway/provisioner:** one database, volume set, rootless
   container, tm8-server, credentials, route, resource policy, and end-to-end
   probe per workspace; rollback-safe and idempotent.
4. **Move execution behind the boundary:** a hosted server/runner controls only
   its own sessions, with no in-process fallback and explicit per-action/frame
   checks.
5. **Build workspace-local secret resolution:** values stay out of the hub and
   the tm8 agent credential stays out of general child environments.
6. **Build administration and member UX:** provision, enrol, health, resource,
   secret, suspend/revoke/delete, and audit flows.
7. **Build the bridge:** pull, bounded report-back, policy-controlled delegated
   launch, requester/executor attribution, revocation, and audit.
8. **Ship only after adversarial verification** on the actual container/VM
   deployment.

## Security test matrix

Every row is a release gate, not a best-effort test:

| Test | Required result |
|---|---|
| Change workspace/session ID in HTTP and WebSocket traffic | Rejected without revealing target existence or data |
| Call hub API without auth from tenant loopback | 401 |
| Read another tenant's volume/home/manifest/journal/process env | OS/runtime denial |
| Reach another workspace database | Network and database denial |
| Attach/input/resize/terminate another tenant session | Authorization denial on every action/frame |
| Stop target workspace, then launch | Clear unavailable response; no hub fallback |
| Plant symlinks/path traversal in writable roots | Containment denial; no outside read/write |
| Inspect tenant child process environment | No operator credentials; no generally inheritable tm8 agent credential |
| Fork bomb / memory bomb / disk fill | Contained by tenant resource policy |
| Fail each provisioning step and retry | Converges or rolls back without a ready partial tenant |
| Revoke member during running session/bridge transfer | Sessions and grants terminate; shared authorship remains |
| Restore backup under wrong workspace binding | Restore refused |

## Definition of done

The feature is complete only when an administrator can create a workspace from
the UI, the owner can enrol private credentials and run agents, the central
teammate can collaborate through an explicit bridge, and the two-tenant attack
suite proves that neither tenant can read or control the other's environment.

Process separation without credential/filesystem/session/resource tests is not
completion.

