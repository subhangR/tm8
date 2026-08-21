# tm8 environments

Established 2026-07-31, corrected 2026-08-12. Treat any instruction that conflicts
with this as stale.

**The one table lives in [`deploy/environments.sh`](../../deploy/environments.sh).**
Print it with `bash deploy/environments.sh`. Every script reads it from there, so
this page describes it rather than restating it.

| | `dev` | `staging` | `prod` | `private` |
|---|---|---|---|---|
| server (node) | **4610** | **8887** | **17777** | **7779** |
| what a human opens | 4611 (vite) | 8888 (nginx) | 7777 (nginx) | — |
| vite dev | 4611 | 18888 | — | — |
| database | `tm8_dev` @ 5442 | `tm8_staging` @ 5443 | `tm8_prod` @ 5442 | `tm8_private` @ 5444 |
| checkout | your clone | `/opt/tm8/staging` | `/opt/tm8/prod` | `/opt/tm8/private` |
| env file | `.env.dev.local` | `/etc/tm8/staging.env` | `/etc/tm8/prod.env` | `/etc/tm8/private.env` |
| units | (foreground) | `tm8-staging`, `tm8-staging-ui` | `tm8-prod` | `tm8-private` |
| reloads on edit? | **yes** | **yes** (vite dev over source) | **no** — a built bundle | **no** |
| UI serving | vite dev | vite dev over source | built `dist/` | built `dist/` |

`server` is the node process and is always loopback-only. Postgres is the **system**
Postgres (ruled 2026-08-12) — `staging` and `private` have their own clusters;
`dev` and `prod` share the 5442 cluster but not a database.

## What this page used to say, and why it was wrong

It described **two** installations on a macOS laptop: prod as a frozen snapshot in
`~/.local/share/tm8-stable` on 7777/7778 with database `tm8_stable`, and staging as
the working tree on 8887/8888. `README.md` described a *third* topology (4610/4611,
data in `~/.tm8/`), and `deploy/utho/deploy.sh` described a fourth — the one that
was actually running.

Three of the four were fiction, and every new reader was sent to a machine that did
not exist. That was the onboarding bug. The live topology is now canonical and the
numbers live in one file.

## Installing any of them

```bash
./install.sh                          # dev, into this clone
./install.sh --env prod --systemd     # prod: unit file, enabled, started, verified
./install.sh --env staging --systemd
./install.sh --env prod --status
```

Full guide: [`INSTALL.md`](INSTALL.md).

## Deploying a pushed ref to an installed box

```bash
./deploy/utho/deploy.sh staging <ref>
./deploy/utho/deploy.sh prod <ref> --plan   # print the migration delta, change nothing
./deploy/utho/deploy.sh prod <ref>          # typed confirmation required
```

The box fetches from GitHub — this never rsyncs a working tree, so what runs there
is always a commit you can name.

**The distinction that matters:** if you want to *see your code change*, look at
staging. Prod will not show it until someone rebuilds and redeploys the
snapshot. Editing the tree and then checking 7777 proves nothing — that has
burned people before.

## The four commands

Added 2026-08-05. Everything below this section still holds; these wrap it.

```bash
bun run local                      # LOCAL: postgres → build → serve 7777/7778
bun run local:status               # LOCAL: database + instance, in one report
./deploy/utho/deploy.sh staging <ref>   # UTHO staging  (8888)
./deploy/utho/deploy.sh prod    <ref>   # UTHO prod     (7777)
```

**`bun run local` is `bun run prod` plus a database.** The only thing it adds is
`deploy/pg/ensure-cluster.sh`, which makes the 5442 cluster exist before
`deploy.sh` asserts it does. That assertion (`deploy.sh` step 1) was the whole
gap: **nothing in this repo ever started Postgres.** `packages/server/src/sidecar/`
is a complete ten-file Postgres lifecycle subsystem and it is imported by
*nothing* — the cluster serving prod was a hand-started postmaster that happened
to still be up, and a reboot ended the one-command story.

Two things that bootstrap encodes, because both are silent:

- PG18 on macOS dies at **startup** with `FATAL: postmaster became multithreaded
  during startup` unless `LC_ALL` is a valid locale. Not at `initdb` — that part
  succeeds. So the cluster's ability to boot depended on whose shell launched it,
  which is why "it worked when I ran it" and "it survives a reboot" were
  different claims.
- Stopping tm8 leaves the cluster **up**, deliberately. That one cluster holds
  `tm8_staging` and ~130 test databases besides prod's `tm8_stable`. Stop it on
  purpose: `bun run pg -- --stop`.

**The Utho script deploys a PUSHED REF only** — it never pushes, and never rsyncs
your working tree, so what runs on the box is always a commit you can name.
Uncommitted edits are invisible to it by design.

```bash
./deploy/utho/deploy.sh prod origin/main --plan   # show the commits + FULL migration text
./deploy/utho/deploy.sh staging <ref> --from-scratch  # wipe the checkout, rebuild clean
./deploy/utho/deploy.sh staging --status
```

`prod` requires you to type `deploy prod` after it prints the migration bodies.
That gate is not decoration: a migration reached this box unread once and killed
every `messages.post`. Branch builds go to the **staging slot** — `--from-scratch`
is refused for prod, because wiping prod's checkout is an outage, not a deploy.

Four things about the box that make the obvious recipe wrong, all verified
2026-08-05 and all encoded in the script:

| | |
|---|---|
| `/etc/tm8/*.env` is `0600 root:root` | the `tm8` user **cannot read it** — the documented `runuser -u tm8 -- . /etc/tm8/prod.env` step could never have worked |
| staging's `TM8_DATABASE_URL` is a `tm8_app` URL | it **cannot** create `applied_migrations`; migrations need an explicit superuser URL |
| root fetches, `tm8` builds | `tm8` has no `~/.ssh` and cannot reach GitHub; root building leaves files the services can't read |
| staging is vite **dev**, prod is a built `dist` | prod needs a *separate* `vite build`; staging needs none |

Both boxes' databases differ from local: prod is `tm8_prod` @ **5442**, staging is
`tm8_staging` @ **5443**. Local's `tm8_stable` exists only on the Mac.

## Deploying prod — one command

```bash
cd ~/Desktop/Projects/tm8
bun run prod                 # or: ./deploy/prod/deploy.sh
```

That builds **whatever is checked out right now** — current branch, uncommitted
edits and all — from scratch, migrates `tm8_stable`, and restarts 7777/7778 on
it. Roughly 30s on a warm tree. Everything it needs is in `deploy/prod/`:

| | |
|---|---|
| `env.sh` | the single source of truth for prod's ports, DB, data dir and flags |
| `deploy.sh` | the one command (below) |
| `run-server.sh` / `run-ui.sh` | what the supervisors actually exec |
| `supervise.sh` | keep-alive restart policy (there is no launchd agent) |

```bash
bun run prod:status      # what is listening, which build serves it, health
bun run prod:restart     # restart the current build, no rebuild
bun run prod:rollback    # swap the previous build back in
bun run prod:stop
./deploy/prod/deploy.sh --build-only   # stage + compile only; prod keeps running
./deploy/prod/deploy.sh --no-backup --no-migrate
```

What it does, in this order: preflight → rsync the checkout to
`~/.local/share/tm8-stable-next` → hardlink `node_modules` → `tsc -b --force`
**and** a separate `vite build` → `pg_dump` → stop → `db/migrate.mjs up` →
rotate (`-next` → live, live → `-prev`) → start supervised → verify.

Properties worth knowing:

- **The build happens before anything is stopped.** A compile error costs zero
  downtime and prod keeps serving the previous build.
- **The UI is a separate build.** `bun run build` is `tsc -b` only. Skipping the
  `vite build` half ships a stale UI against a new server, silently. deploy.sh
  does both and then asserts both artifacts exist.
- **Rollback is one `mv`.** The previous build stays at
  `~/.local/share/tm8-stable-prev`; the pre-migration dump is in
  `~/.local/share/tm8-prod-backups` with the newest path in `LAST_PROD_BACKUP`.
  A schema rollback is *not* automatic — restore the dump yourself.
- **Stopping is anchored to absolute paths inside the prod directory.** A bare
  `pkill -f packages/server/dist/index.js` also kills staging; this does not.
  The pre-2026-08-02 supervisors were launched relatively, so they are matched
  loosely by name and then filtered by CWD.
- **Concurrent deploys are locked out.** Two at once silently corrupt each other:
  one's `rm -rf …-next` deletes the other's staged build, and identical trees
  produce identical vite hashes, so the collision looks like success.
- **Logs survive deploys** — `~/.local/share/tm8-prod-logs/{server,ui}.log`,
  outside the directory that rotates.
- **Do not run a full deploy from inside a tm8-spawned session.** Spawned agents
  are children of the prod server, so stopping it kills the session running the
  deploy. Use `--build-only` there, or run the full deploy from a plain terminal.

## Starting staging

```bash
cd ~/Desktop/Projects/tm8
./deploy/staging/run-server.sh    # 8887 — tsc -b --watch + auto-restart
./deploy/staging/run-ui.sh        # 8888 — vite dev, HMR
```

Both read `deploy/staging/env.sh`, which is the single source of truth for
staging's ports, database and data dir. Neither script takes arguments.

Pointing the CLI at staging:

```bash
TM8_BASE_URL=http://127.0.0.1:8887 tm8 <command>
```

The CLI has **no `--server` flag**; `TM8_BASE_URL` is the switch. Without it the
CLI talks to whatever its config says, which is usually *prod* — so a command
you thought landed on staging can silently mutate prod.

## What was done to establish this (2026-07-31)

- `tm8_staging` created empty and migrated from `001` through `061`. It is a
  clean room: it has **no prod rows**, by choice.
- `~/.tm8-staging/{data,workspace}` created, isolated. Note prod's stable build
  deliberately *shares* its data dir with the old dev instance; staging does
  not share with anything, so a cloned-in row referencing a prod blob would
  dangle. Keep staging's DB self-consistent.
- The launchd agent `com.tm8.local-server` (the old live dev server on **:4610**)
  was unloaded and its plist renamed to
  `~/Library/LaunchAgents/com.tm8.local-server.plist.disabled-for-staging`.
  **Staging replaces :4610.** To bring :4610 back, rename it and
  `launchctl load` it — but then decide which one owns the live-dev role,
  because two live servers over the same tree is how split-brain starts.

## Verified, not assumed

Each of these was actually run:

- `GET /health` on 8887 direct and through the 8888 proxy → both `db: ok`.
- `GET /v2/spaces` — staging returned `[]`, prod returned its 3 spaces, at the
  same moment. The environments are genuinely separate.
- Row counts at creation: `tm8_staging` 0 spaces / 0 entities;
  `tm8_stable` 3 / 336; `tm8_dev` 18 / 917.
- Live reload: appending a line to `packages/server/src/main.ts` produced
  `rebuild ok — restarting server` → `SIGTERM` → a new listener on 8887.
- A space named `tm8-staging` was created on staging and appears **only** there;
  prod's count stayed at 3.

## Known rough edges

- Neither staging process has a supervisor. If one dies it stays dead. Prod has
  `supervise.sh` for exactly this reason — other lanes pattern-kill every
  process matching `packages/server/dist/index.js`, which matches staging too.
- `TM8_IDEMPOTENCY_ENABLED=0` is set on staging for the same documented reason
  as prod (see the comments in `env.sh`). `TM8_PREVIEW_ENABLED=0` is **not**:
  since the same-origin `/p/` route landed (2026-08-16) previews default on and
  need no second listener, so artifact preview works on staging.
- Staging runs the *uncommitted* working tree, including other lanes' in-flight
  migrations. `run-server.sh` does not migrate the DB; if a lane adds a
  migration, run `TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_staging
  node db/migrate.mjs up` yourself.
