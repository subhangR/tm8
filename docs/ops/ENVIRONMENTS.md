# tm8 environments — PROD and STAGING are two separate tm8's

Established 2026-07-31. This is the standard; treat any instruction that
conflicts with it as stale.

There are **two** tm8 installations on this machine. They share nothing but the
Postgres *cluster* (one server on 5442, two different databases inside it).

| | **PROD** | **STAGING** |
|---|---|---|
| UI | http://127.0.0.1:**7777** | http://127.0.0.1:**8888** |
| Server | http://127.0.0.1:**7778** | http://127.0.0.1:**8887** |
| Code | `~/.local/share/tm8-stable` — a **frozen `tsc -b` snapshot** | `~/Desktop/Projects/tm8` — **the live working tree** |
| Reloads? | **No.** Never. It is a built thing. | **Yes.** Server rebuilds+restarts on source change; UI is vite dev with HMR. |
| UI serving | `vite preview` over a built `dist/` | `vite dev` over source |
| Database | `tm8_stable` @ 5442 | `tm8_staging` @ 5442 |
| Data dir | `~/.local/share/tm8/data` | `~/.tm8-staging/data` |
| Workspace | `~/.local/share/tm8/workspace` | `~/.tm8-staging/workspace` |
| Launch scripts | `~/.local/share/tm8-stable/run-{server,ui}.sh` | `deploy/staging/run-{server,ui}.sh` (in-repo) |

**The distinction that matters:** if you want to *see your code change*, look at
staging. Prod will not show it until someone rebuilds and redeploys the
snapshot. Editing the tree and then checking 7777 proves nothing — that has
burned people before.

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
- `TM8_IDEMPOTENCY_ENABLED=0` and `TM8_PREVIEW_ENABLED=0` are set on staging for
  the same documented reasons as prod (see the comments in `env.sh`). Artifact
  preview therefore does **not** work on staging.
- Staging runs the *uncommitted* working tree, including other lanes' in-flight
  migrations. `run-server.sh` does not migrate the DB; if a lane adds a
  migration, run `TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_staging
  node db/migrate.mjs up` yourself.
