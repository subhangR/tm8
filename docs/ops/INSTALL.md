# Installing tm8

```bash
git clone https://github.com/subhangR/tm8.git
cd tm8
./install.sh
```

That is the whole thing. It ends with tm8 **running** — server and UI — having
first verified that `/health` reports `db:ok`. Open **http://127.0.0.1:4611**.

Idempotent: run it again any time.

```bash
./install.sh --no-start       # set everything up, start nothing
```

---

## What it actually does

Eleven phases, in this order, because each one depends on the last:

| # | Phase | Why it cannot be skipped |
|---|---|---|
| 1 | Prerequisites | node **22** (node-pty's prebuilds are proven on that major), bun, a Postgres **16 or newer** server and client (16 is the floor per `deploy/environments.sh`; this repo's clusters run 18), git, curl, and — to run agents — an agent CLI (`claude` or `codex`) the host is logged in to |
| 2 | Cluster | Nothing in this repo starts Postgres — see [below](#the-sidecar-that-never-ran). A cluster already on the slot's port is reused **only** if this installer created it — see [below](#a-cluster-already-on-the-port) |
| 3 | Superuser + loopback trust | The subtle one. See [below](#why-loopback-trust-is-a-real-step) |
| 4 | Database | Created **empty** |
| 5 | Dependencies | `bun install`, then node-pty's `spawn-helper` made executable |
| 6 | Build | `tsc -b` **and** a separate `vite build` — `bun run build` is tsc only |
| 7 | Env file | Carries both database URLs. The `prod` slot also gets `TM8_NODE_MODE=multi` and stubs for `TM8_PUBLIC_ORIGIN`, `TM8_ALLOWED_*`, `TM8_PROJECT_ROOTS` |
| 8 | Data directories | `TM8_DATA_DIR`, `TM8_PROJECT_DIR` |
| 9 | Migrations | 300+ files. **The server does not migrate at boot.** On a re-run with pending migrations, a `pg_dump -Fc` is taken first (newest five kept; `--no-backup` skips it) |
| 10 | Service | A systemd unit (Linux) or launchd agents (macOS), with `--service` |
| 11 | Start + verify | Runs it, then confirms `/health` says `db:ok` and one real catalog read succeeds |

**Seeding needs no phase.** Once the schema is current and the server boots, the
loopback auto-owner creates the first account and `bootstrap/launch-resources`
seeds each space's teammate roster. This is the one part of onboarding that
already worked.

## The commands

```bash
./install.sh                          # dev slot into this clone, then run it
./install.sh --no-start               # …but leave nothing running
./install.sh --env prod --service     # server install: unit file, enabled, started
./install.sh --port 4710 --pg-port 5599   # this slot on other ports (theirs are taken)
./install.sh --status                 # what is installed, migrated and running
./install.sh --dry-run                # print every step, change nothing
./install.sh --reset                  # DROP the database and re-migrate (asks first)
./install.sh --uninstall              # stop + remove the service, keep all data
./install.sh --print-env              # the env file it would write
```

Also `bun run setup`, `bun run setup:status`, `bun run setup:dry-run`.

Useful flags: `--no-start`, `--no-build`, `--no-migrate`, `--no-backup`,
`--configure-pg-hba`, `--adopt-cluster`, `--port`, `--pg-port`, `--yes`,
`--layout system|user`. Port overrides are written into the env file; pass them
again to `--status`.

Running a server for other people? [`OPERATOR-GUIDE.md`](OPERATOR-GUIDE.md)
covers the service user's agent login, a reverse proxy, TLS, backups and upgrades.

## A cluster already on the port

Each slot has a fixed Postgres port (`dev` and `prod` share **5442**). If
something already answers there, the installer reuses it only when it carries
the installer's own marker — a comment, `tm8-install.sh:cluster`, on the `tm8`
role, written when the installer created (or was told to adopt) the cluster.
Anything else is refused, because adopting adds a superuser role and a database
and may loosen `pg_hba`. On a laptop that already runs a tm8 node, 5442 *is*
that node's live cluster.

- A fresh cluster of your own: `./install.sh --pg-port 5599` (any free port).
- A cluster that is tm8's but predates the marker (an older install):
  `./install.sh --adopt-cluster` once; it is marked and later runs just reuse it.

## What "running" means per slot

`dev` and `staging` build **no UI bundle** — they serve source through Vite. So
starting only the node server there would give you a working API and no app to
open. For those slots the installer hands off to `scripts/dev.mjs`, which runs the
server *and* the Vite UI together and reloads both. `prod` and `private` serve a
built `dist/`, so their server is the whole thing, and `--systemd` runs it as a
service rather than in your terminal.

## The environments

One table, in `deploy/environments.sh`. Print it with `bash deploy/environments.sh`:

| env | server | open | vite dev | pg | database | units |
|---|---|---|---|---|---|---|
| `dev` | 4610 | 4611 | 4611 | 5442 | `tm8_dev` | (foreground) |
| `staging` | 8887 | 8888 | 18888 | 5443 | `tm8_staging` | `tm8-staging`, `tm8-staging-ui` |
| `prod` | 17777 | 7777 | — | 5442 | `tm8_prod` | `tm8-prod` |
| `private` | 7779 | — | — | 5444 | `tm8_private` | `tm8-private` |

**`server` is the node process and is always loopback-only.** `open` is the port a
human uses — nginx in front of prod, vite in front of dev. Never identify an
instance by probing a port: vite and nginx both proxy `/health` through, so 7777
and 4611 answer "healthy tm8-server" and tell you nothing about which build you
reached. Identify by listener → process → path.

Two layouts:

| | checkout | env file | data |
|---|---|---|---|
| `system` (`--systemd`) | `/opt/tm8/<slot>` | `/etc/tm8/<slot>.env` | `/var/lib/tm8/<slot>/` |
| `user` (default) | your clone | `<clone>/.env.<slot>.local` | `~/.tm8-<slot>/` |

---

## Why loopback trust is a real step

Migrations `001` and `015` create `tm8_graph_owner`, `tm8_app` and
`tm8_delivery_worker` with `LOGIN` and **no password**. The server's delivery path
must *authenticate* as `tm8_delivery_worker` over TCP — being able to `SET ROLE`
to it is explicitly not enough, and
`packages/server/src/facade/services/w2/execution.ts` rejects the weaker
connection.

Under Debian's default `pg_hba.conf` (`host all all 127.0.0.1/32 scram-sha-256`) a
passwordless role simply cannot log in. The result is not an error. Messages get
stored and then never pushed to a live terminal — a silent failure that reads as
"delivery is flaky".

So `pg_hba` must trust loopback. That is safe **only** because the cluster binds
`127.0.0.1` and nothing else, which the installer asserts rather than assumes —
and it sets `listen_addresses` *before* it relaxes `pg_hba`, never the reverse.

On a cluster the installer created, it does this itself. On a cluster it
*adopted*, it checks and prints the exact line, and changes nothing unless you
pass `--configure-pg-hba`. Someone else's cluster is not the installer's to
reconfigure.

Phase 3 ends with a real login as `tm8` over `127.0.0.1`. When that is refused,
the run stops there and names the `pg_hba` rule that matched first, before any
database is created. It used to warn, create the database, and only fail in phase
4 with "created the database but cannot query …". On a fresh Debian/Ubuntu server
with `--pg-port 5432 --adopt-cluster`, that was the usual outcome: the stock
`host all all 127.0.0.1/32 scram-sha-256` matched first. Re-run with
`--configure-pg-hba`. As a non-root user that needs passwordless sudo, because
Debian's `pg_hba.conf` belongs to `postgres`. The installer reads that file through
the server (`pg_read_file`) and reloads with `pg_reload_conf()`, so both work under
peer auth.

Installing the `postgresql` package on Debian/Ubuntu creates cluster `<major>/main`
on 5432. The dev slot's cluster is also named `main`, so on a fresh server
`pg_createcluster` used to refuse it. When that name is taken on another port, the
installer now names the slot's cluster `tm8_<slot>`. A plain `./install.sh` then
gets a cluster of its own on 5442, and `--adopt-cluster` isn't needed.

## The sidecar that never ran

`packages/server/src/sidecar/` is fourteen files of Postgres lifecycle management
— `cluster.ts`, `health.ts`, `upgrade.ts`, `backup.ts`, `migrate.ts`. It is
**dead code**: the only references to it from outside its own directory are
`import type` in the scheduler, so no tm8 process has ever constructed a
`SidecarManager`.

For a long time `scripts/dev.mjs` and `scripts/start.mjs` printed that the
sidecar Postgres "is managed by tm8-server (R15)", and `deploy/prod/deploy.sh`
opened by *asserting* that 5442 already answered. The cluster that answered was a
hand-started postmaster that happened to still be up. A reboot would have ended
it, and every one-command story with it.

Reviving that subsystem was considered and ruled against on 2026-08-12: tm8 uses
the system Postgres, under a real service manager, and `install.sh` is what puts
it there. The false claims have been removed from the launchers.

## Troubleshooting

**Run `bun run doctor` first.** It now checks the things that actually break:
Postgres reachability, whether the database exists, how many migrations are
applied versus on disk, and whether the delivery role can authenticate. It used
to check node's version, three ports and `node_modules` — all of which are true
of an installation with no database at all, in which every operation answers 501.

**Then run `tm8 doctor`** (the CLI, once built) — it additionally checks the
agent CLI: whether `claude`/`codex` are on PATH AND logged in. A session on the
node's own credential runs the host's login, so a node can pass every check above
and still be unable to run a single agent that way; this is the check that says so.
(Members can instead connect their own or a space's credential under Settings →
Credentials.) On a service install, log in as the service user:
`sudo -u tm8 -H claude auth login`.

| Symptom | Cause |
|---|---|
| `graph: NOT CONFIGURED … all operations answer 501` | No `TM8_DATABASE_URL`. Run `./install.sh`. |
| Everything returns `501 not_implemented` | Same. A tm8 with no database looks like a running tm8. |
| A spawn is refused: "this session runs on the node's own claude login, and the node has none" | The node's OS user has no `claude`/`codex` login. Log in as that user (`sudo -u tm8 -H claude auth login` on a service install), or launch on a member or space credential. |
| A session fails with `agent_onboarding_screen` | Same cause, caught after boot: Claude Code started its first-run theme picker / login screen. |
| Messages send but never appear in a terminal | `tm8_delivery_worker` cannot authenticate. See [above](#why-loopback-trust-is-a-real-step). |
| `503` on `/v2/execution/spawn`, or "spawning is broken" | node-pty's `spawn-helper` lost its executable bit. `bash scripts/repair-node-pty.sh`. |
| Server is new but the UI is stale | `bun run build` is **tsc only**. The UI needs its own `vite build` (`cd packages/tm8_ui_2.0 && bun run build`). |
| `psql: command not found`, or a version mismatch | A bare `psql` is whichever formula got linked. Set `TM8_PSQL` to a versioned path. |
| The unit is `inactive` after a "restart" | Something signalled the process. A clean Node exit is status 0, so `Restart=on-failure` does not bring it back. Use `systemctl` only. |

**`/health` passing is not proof the product works.** It proves a listener and a
database connection. Prove the rest with a real read:

```bash
TM8_BASE_URL=http://127.0.0.1:4610 node packages/cli/dist/tm8 space list
```

If you run that from inside a tm8-spawned agent session, clear the session's
identity first — an ambient `TM8_AGENT_TOKEN` points at the node that spawned you
and makes a perfectly healthy server answer `unauthenticated: invalid token`:

```bash
env -u TM8_AGENT_TOKEN -u TM8_BASE_URL -u TM8_ACTOR_ID \
  TM8_BASE_URL=http://127.0.0.1:4610 node packages/cli/dist/tm8 space list
```

`install.sh` and the launchers strip these automatically; a hand-run command has
to do it itself.

## Deploying a pushed ref

`install.sh` sets a machine up. `deploy/utho/deploy.sh` moves a **pushed git ref**
onto an already-installed box:

```bash
./deploy/utho/deploy.sh staging <ref>
./deploy/utho/deploy.sh prod <ref> --plan    # show the migration delta, change nothing
./deploy/utho/deploy.sh prod <ref>           # requires typed confirmation
```

It never rsyncs a working tree: the box fetches from GitHub, so what runs there is
always a commit you can name. It needs `ssh` access and root on the target.
