# Isolated workspaces and optional central authentication

This is the implementation record for the architecture approved on 2026-09-08.
It supersedes the older no-Supabase and one-server-per-workspace proposals.

## Accepted behavior

- `TM8_DISTRIBUTED_SYSTEM_FLAG=false`: local authentication and PostgreSQL, no
  Supabase dependency. `true`: central Supabase authentication and machine mapping.
- One tm8 UI/API and graph database per machine. The application runs as system
  user `tm8` at `/workspace/tm8`; user execution runs in separate private containers.
- GitHub-only login/signup (user amendment on 2026-09-09), invite-only enrollment, ten assigned workspaces per
  machine by default. Cloud provisioning and cross-machine sharing are deferred.
- Private user checkouts, shared machine-local Git repositories, optional GitHub
  remotes. Existing accounts, graph IDs, memberships and files must be preserved.
- Supabase migration requires a GitHub identity with verified email and an
  invitation or explicit GitHub linking. Old password hashes are retained only
  for rollback; password sign-in/signup/reset endpoints are disabled.

## Delivery and verification

Unchecked work is not shipped behavior. Do not enable a mode or claim its
security properties until its integration and isolation tests pass.

- [x] Contracts, configuration and additive workspace migrations
- [x] Central directory, atomic capacity allocation and enrollment
- [x] Supabase/local auth adapters, invitations and machine handoff
- [x] Restricted runtime broker and persistent private Ubuntu runners
- [x] Workspace-bound file and terminal operations
- [ ] Agent, background and legacy runtime adapters
- [x] Projects, private checkouts and Git synchronization
- [x] Workspace UI, CLI and MCP integration
- [x] Inventory, resumable migration and cutover tooling
- [x] Docker/system-user deployments and operating documentation
- [x] Two-user isolation, restart, migration and authentication acceptance tests

## Release constraints

Never fall back to application-host execution when a private runner is missing.
Never expose runtime sockets or service/database credentials to user containers.
Workspace IDs, paths and runtime identities are server-derived. Authentication
and authorization remain separate; node administration grants no implicit user
workspace access. Shared space membership grants access to intentionally shared
project commits, not another member's private uncommitted files or credentials.

## Implementation evidence (2026-09-08)

- Graph migrations 185–187 applied successfully to the development database.
- Central directory: four PostgreSQL/HTTP tests pass, covering invite linking,
  concurrent capacity, sticky placement, handoff replay/expiry and revocation.
- Broker: five policy/unit tests pass. Real Docker acceptance passed two-user
  provisioning, private mounts/limits, shared commits, private dirty files,
  traversal refusal, dirty-pull refusal, restart persistence, public GitHub
  egress, metadata denial and terminal ownership. Fixture resources removed.
- Node: five HTTP/PostgreSQL workspace tests pass, plus four configuration and
  eight existing single-identity-path tests.
- UI production build and typecheck pass. Auth frame/reset tests pass; the gate
  fixture now simulates HttpOnly cookies and all 54 gate tests pass.
- CLI workspace commands and MCP workspace guides are implemented. CLI
  capabilities runs successfully against the development node.

## Additional evidence (2026-09-09)

- Graph migrations through 192 applied after a PostgreSQL backup. The development
  database has one existing account and no spaces/projects requiring file cutover.
- Standalone GitHub OAuth: six PostgreSQL tests pass for explicit linking,
  invite-only enrollment, replay, revoked parent sessions and enrollment-role guards.
- Six two-node PostgreSQL/HTTP tests pass for machine-bound handoff, no local
  administrator bootstrap, capacity updates, accepted space invitations, logout
  and live socket revocation.
- Eight control-directory/provider-adapter tests pass, including Supabase PKCE
  recovery, stable directory imports and explicit GitHub linking despite Supabase
  email auto-linking or mixed password/OAuth authentication claims.
- Updated runner image passed the real two-user Docker acceptance suite again.
- Copy tests pass for ordinary Git repositories and linked worktrees, including
  staged/unstaged/untracked data. Real Docker/PostgreSQL migration passed stable
  IDs, preserved originals, ownership refusal and successful rerun checks.
- CLI catalog and command discovery: 83 pass, one existing skipped test. The
  generated conformance manifest now accounts for all 217 operations.
- Application, runner, broker and control images build. Production and central
  deployment overlays and migration operating guides are added.
- The operator migration image builds and runs inventory. The production Compose
  overlay passes UI/API health, mandatory login, system-user and mount checks.
- Real Chrome acceptance passes password sign-in, HttpOnly cookie storage,
  workspace/space/project creation, file save, commit/push, execution in an Ubuntu
  terminal and session restoration after reload. It uses a disposable backend.
- All 100 existing UI auth tests pass, as do the server identity/contract/socket
  regressions. The conformance manifest is current and all 12 foundation tests pass.

## Remaining integration work

- Worker task execution now uses the private runner, as described below.
  Coordinated agents, chat/background work, previews, session Git-rail commands,
  native transcript adapters, session resume and host project-file operations
  remain disabled in isolated mode. No application-host execution fallback exists.
- GitHub external login/push/create needs operator configuration for a live
  verification; no Supabase or GitHub application credentials were provided.
- Automatic AWS/Azure VM and DNS provisioning remains deferred. Register machine
  capacity manually; a full fleet presents the waiting-for-capacity state.

## GitHub-only amendment (2026-09-09)

The later user instruction supersedes the password-authentication evidence above.
Both product login screens now expose only GitHub. Local and central password
signup/login/reset endpoints refuse requests; the control app also refuses raw
Supabase token exchange. Central PKCE accepts only GitHub flows. Migration 193
allows the private initial setup token to claim the existing owner through
GitHub without storing a password; linked or disabled owners remain claimed.
Existing unlinked accounts have an explicit operator mapping tool. Live GitHub
sign-in requires OAuth application settings. They were subsequently configured
locally, and the first owner completed GitHub enrollment and created a workspace,
space and Git project.

Verification: seven local GitHub tests (including password-free owner setup),
six workspace API tests, six distributed-node tests, seven control-directory
tests and two GitHub UI tests pass. Chrome acceptance passes the complete GitHub
callback/cookie/workspace/Git/terminal flow using a controlled provider fixture.
Graph migration 193 is applied locally after a backup. The control image is
rebuilt; apply central migration 005 when deploying the control app.

## Private provider connections (2026-09-09)

The four `credentials.*` endpoints now route to private workspace runners when
isolation is enabled. Claude Code and Codex are installed at pinned versions in
the runner image. Settings and the Agent tools dialog use a workspace websocket
returned by login start. Provider logins run fixed argv, expire after ten minutes,
and retain output long enough to finish after a CLI exits. HTTP and websocket
authorization refuse agent identities, including an agent carrying the owner's
account. Finish checks the actual CLI status and confirms a persistent credential
file before returning `stored: true`.

Disconnect stops all processes in the owner's runner before logging out of the
selected provider, preventing a pending login from restoring it after logout.
Other users, home volumes, project files and other providers' stored credentials
are retained. This change does not enable legacy `chat.start` or shared-host
agent execution. Complete provider account authorization remains interactive.

Verification: 95 credential UI tests, seven workspace HTTP/PostgreSQL tests,
three credential authorization/socket tests, and eight broker/security tests
pass. Real Docker tests reach both provider authorization prompts through the
restricted proxy and confirm cache persistence and logout with a controlled
credential fixture. Chrome checks the Agent tools dialog and both Settings
connections against a disposable real backend, including websocket input and
an incomplete login remaining disconnected. Core/UI builds and generated
conformance checks pass. The existing local workspace was upgraded without
changing its Git HEAD or working tree. No real Claude/OpenAI user account was
authorized by these tests.

## Private task launch amendment (2026-09-09)

The launch roster was tied to the host-project bootstrap, which is disabled in
isolated mode. New isolated spaces now seed the model catalog's worker personas
without enabling Dreamer/Dispatcher automation. Startup also repairs the local
owner's existing spaces without linking application source code as a project.

`execution.spawn`, `execution.terminate`, `execution.streams.attach`,
`execution.liveness`, `execution.launch` and `execution.journal` now have private
adapters. They reuse graph RPCs for persona authorization, task assignment,
profile pins, mutation replay and status transitions. The session's node id binds
it to its owner's workspace. Other members may read shared graph entities, but
cannot attach to or control that owner's private processes or terminal output.
Grant consumption is single-use, view grants cannot write/resize, and websocket
authorization rechecks membership and account state during the connection.

The broker launches fixed provider executables as UID 1000, with literal argv,
the chosen model/effort/access mode, and the task/persona/skill context. It only
uses the owner's provider login. Claude's already-authenticated first-run setup
and per-directory trust are initialized after tm8's project trust gate. Codex
receives the authorized working directory's trust for that invocation. Scratch
and worktree paths are server-generated UUID paths inside the user's home.
Worktree changes remain on their private `tm8/<uuid>` branch for user review.

Session output is a bounded 1 MiB replay per session stored in the broker's
private state volume. App restart reconnects to an existing Docker exec. Broker
restart stops the exact old process group, records an interruption and restores
its saved replay. Normal exit and Stop release the graph concurrency slot.
Task completion remains a human review action: these workers do not receive a
tm8 API credential or connectivity to the graph/control/database network.

Verification includes PostgreSQL/API authorization and duplicate-launch checks,
real Docker worktree/scratch execution and child-process termination with a
controlled provider image, browser model selection/launch/terminal reconnect,
and single-use/read-only terminal grants. The controlled image exists only in
`deploy/workspaces/test`; production continues to use the pinned official CLIs.
The connected local Claude account also executed `pwd` and `id -u` through the
private task adapter, reported its scratch directory and UID 1000, and was
stopped successfully. The existing project HEAD and clean working tree were
unchanged after the runner upgrade and this verification.
