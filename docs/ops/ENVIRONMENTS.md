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
