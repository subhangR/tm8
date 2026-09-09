# Ubuntu 24.04 with private user workspaces

The application runs as the locked `tm8` system account at `/workspace/tm8`.
This checkout is bind-mounted there, so development runs the source in this
directory. Ubuntu containers share Docker's Linux kernel; they are not full VMs.

From the repository root with Docker running:

```bash
node deploy/docker/configure.mjs
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml build workspace-image
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml up --build -d
docker compose ps
```

Open **http://127.0.0.1:4611** after the application is healthy. Follow the
first-administrator claim link in `docker compose logs tm8` for a fresh node.
Claim links are credentials; keep the logs private. Subsequent accounts need an
invitation. Loopback access does not automatically sign in as the owner.

```bash
docker compose exec tm8 bash
docker compose exec tm8 bun run build
docker compose exec tm8 bash -c 'cd packages/tm8-ui && bun run build'
```

Vite reloads UI changes; the development launcher rebuilds watched server and
contract changes. Restart the service for changes outside its watch list.
Linux dependencies live in named Docker volumes, including native `node-pty`.
Do not install Mac dependencies into those volumes.

## Storage and identities

| Component | Identity | Persistent storage |
| --- | --- | --- |
| tm8 UI/API | `tm8`, UID 1000, locked, no supplementary groups | `/var/lib/tm8` |
| PostgreSQL | `postgres` in a separate container | `postgres_data` volume |
| Workspace broker | restricted operator service; only Docker socket holder | broker state and Unix socket volumes |
| Each user runner | `user`, UID 1000 in its own container | one private home volume at `/home/user` |
| Shared Git store | separate container without networking | repository volume, never mounted into user runners |

The web database principals cannot create databases, bypass RLS or assume the
graph owner. The node enrollment principal can execute only its enrollment RPCs.
No user container receives graph credentials, service state or the Docker socket.
CPU/memory/PID limits default to 2 CPUs, 4096 MiB and 256 processes per user.
The broker refuses new provisioning below 15% available disk space; disk quotas
are not enforced per user.

Runners have private Docker networks. The egress proxy permits public HTTP/HTTPS,
pins DNS results, and rejects private, link-local and metadata destinations.
SSH remotes and direct outbound sockets are not enabled. Project GitHub remotes
use HTTPS. GitHub credentials stay in the user's private home.

In **My workspace**, create/retry the workspace, select a space, then create a
Git repository, clone GitHub, or import a folder relative to your workspace home.
The existing **New space** dialog also creates private Git projects. Checkouts
live at `/home/user/projects/<project-id>`; IDs remain stable across renames.

The isolated mode supports workspace files, interactive terminals, Git, and
worker task sessions using Claude Code or Codex. Open a task, choose **Run**,
select a teammate/model, and **Launch**. Connect that provider in Settings first.
Scratch sessions get a private Git directory; project/worktree sessions use the
user's checkout. The terminal supports input, reconnect, and Stop. Coordinated
agents, chat, background jobs and host-file APIs still need runner adapters.

Use the workspace UI, CLI or MCP to fetch/pull/push the managed `tm8` shared
repository. The `tm8://` remote is a managed transport marker; ordinary
`git push tm8` in a shell is not a supported transport. `git push origin` works
with the connected HTTPS GitHub remote. Pulls are fast-forward only and refuse
dirty checkouts. Uncommitted edits stay private; only pushed commits are shared.

```bash
tm8 workspace ensure
tm8 workspace project create --body '{"spaceId":"SPACE_UUID","name":"demo","source":{"kind":"init"},"clientMutationId":"CREATE_UUID"}'
tm8 workspace git PROJECT_UUID status
tm8 workspace git PROJECT_UUID push --remote tm8
# Read a GitHub token from a private JSON file or stdin, keeping it out of argv.
tm8 workspace github credential --body @/private/github-credential.json
```

## Authentication modes

Sign-in and signup are **GitHub-only**. New users still need invitations. Password
login, password signup/reset and the password-based claim API are disabled.
`TM8_DISTRIBUTED_SYSTEM_FLAG=false` keeps GitHub identity bindings, invites and
sessions in the node's PostgreSQL database. Supabase is not required.

Standalone GitHub login needs `TM8_GITHUB_CLIENT_ID`,
`TM8_GITHUB_CLIENT_SECRET`, `TM8_PUBLIC_ORIGIN` and the enrollment database URL.
Set the GitHub client ID and secret in the ignored root `.env`; Compose passes
them only into the application. Restart tm8 after configuring them.
Register the callback `<TM8_PUBLIC_ORIGIN>/v2/auth/github/callback` in the GitHub
OAuth application. For local Docker development the callback is
`http://127.0.0.1:4611/v2/auth/github/callback`. The first administrator uses the
private initial setup link and completes it through GitHub. An existing signed-in
account can use **Link GitHub for sign-in**; otherwise use the explicit operator
mapping in the migration guide. A matching email never links existing accounts.
GitHub sign-in and GitHub repository credentials are separate connections.

Claude Code and OpenAI Codex are installed in the private Ubuntu workspace
image. Open **Settings → Agent credentials**, then **Connect** on either card.
The **Agent tools** setup dialog uses the same private login path. Claude prints
an authorization link and accepts the returned code in the terminal. Codex uses
device-code authentication; enable device login in ChatGPT security settings if
your account requires it. After authorization, select **I've finished signing in**.
See [Claude authentication](https://code.claude.com/docs/en/authentication) and
[Codex authentication](https://developers.openai.com/codex/auth).

Provider credentials remain under `/home/user/.claude` and `/home/user/.codex`
in that user's persistent home volume. Login commands and status probes never
run as the shared tm8 service user. Only human browser/CLI sessions can access
credential endpoints or their terminals. Login terminals expire after ten
minutes. Disconnect restarts only that user's workspace to stop running tools,
then logs out of the selected provider; project files are retained. Other
providers' saved connections remain in the home volume.

After rebuilding the workspace image, update existing runners with:

```bash
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml \
  --profile build-images build workspace-image workspace-broker
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml \
  up -d --no-deps workspace-broker
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml \
  exec -T workspace-broker node --input-type=module \
  < deploy/workspaces/refresh-runners.mjs
```

This replaces outdated user containers, closes their running terminals, and
retains their named home volumes. Provider connections and task sessions both use
the private workspace. Restarting the app preserves running task terminals;
restarting the broker interrupts its tasks and retains their bounded output and
exit evidence. Start a new session after a broker restart.

See [distributed deployment](DISTRIBUTED.md) for the Supabase control app, machine
registration, capacity and public HTTPS deployment. AWS/Azure describe registered
machines in this release; automatic VM/DNS provisioning is deferred.

## Backups, migration and tests

`docker compose down` retains volumes. Do not use `down --volumes` when data must
survive. Back up PostgreSQL, each user home, the shared repository volume and the
broker state together while work is quiesced. A database backup alone does not
contain users' code or credentials. The legacy development cluster is copied on
first separate-PostgreSQL startup and remains in the original service-home volume
for rollback. Startup refuses to copy a running cluster.

[Project migration](../workspaces/README.md) inventories existing IDs and copies
files before changing project paths. It never deletes original projects.

```bash
bash deploy/docker/test.sh bash -c 'cd packages/server && bun x vitest run test/workspaces --cache=false'
bash deploy/docker/test.sh node --test apps/control-plane/test/directory.test.mjs
bash deploy/docker/test.sh node --test deploy/workspaces/test/migration.test.mjs
docker compose -f compose.yaml -f deploy/docker/workspaces.compose.yaml exec -T workspace-broker node --input-type=module < apps/workspace-broker/test/docker.test.mjs
```

The test launcher gives a disposable test process database administration inside
the PostgreSQL network namespace. It does not grant that access to the web app.
Tests create their own databases/containers and clean them up.

Current integration status and remaining legacy execution adapters are tracked
in [the implementation record](../../docs/architecture/WORKSPACE-IMPLEMENTATION.md).
