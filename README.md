# tm8

Unified entity-graph rebuild of Maestro. Phase 1 (v1: the node) — one from-contract build (graph engine + facade) + one transplant (execution), shipping a full local-maestro replacement that is natively a collab space.

**Execution bible:** `docs/architecture/09-IMPLEMENTATION-PLAN.md`. Architecture is FINAL (`docs/architecture/00-08`) — implement, do not relitigate. Amendments in `STATE.md` (AM-1: **no Tauri — server + web only**; user-directed 2026-07-25).

**Documentation:** [`docs/README.md`](docs/README.md) is the map — ten sections, each with its own index. Paths changed on 2026-08-02; [`docs/MOVED-PATHS.md`](docs/MOVED-PATHS.md) translates the old ones.

## Getting started

```bash
./install.sh          # cluster, database, roles, migrations, build — then RUNS it
```

Then open **http://127.0.0.1:4611**. That is the whole thing: it ends with the
server and the UI running in your terminal, having verified `/health` says
`db:ok`. `--no-start` installs without starting; `--env prod --service` installs
it as an always-on service instead (systemd on Linux, launchd on macOS — it comes
back after a reboot). Idempotent — re-run it any time. `./install.sh --status`
reports what is installed, migrated and running. Full guide: [`docs/ops/INSTALL.md`](docs/ops/INSTALL.md).

**To run agents, the host needs a logged-in agent CLI.** tm8 stores no agent
credential — a spawned session runs the machine's own `claude` or `codex` login.
Install passes a warning if neither is present; `tm8 doctor` reports presence AND
login. Without one, a spawn sits at `running` forever with the refusal only in
the terminal. Install: `npm i -g @anthropic-ai/claude-code` then `claude` to log
in (or `npm i -g @openai/codex` then `codex login`).

**Nothing in this repo starts Postgres.** `packages/server/src/sidecar/` looks
like it does and is dead code (only `import type` reaches it), so `bun install &&
bun run dev` on its own gives you a server that logs `graph: NOT CONFIGURED` and
answers `501` to every operation. Run the installer once first.

## Workspace layout

| Package | Role | Runtime |
|---|---|---|
| `packages/contract` | THE LAW: types + zod + operation catalog + WorkspaceEvent + errors. The only shared dependency (T-L12). | any |
| `packages/server` | Graph engine, HTTP/WS facade, event mapper, identity block, derived-truth assembly, sidecar lifecycle, scheduler; serves the built web UI | **node** |
| `packages/execution` | PTY host (server-side spawn — the only spawn path), SpawnService, manifest composition | **node** |
| `packages/cli` | Graph CLI + compat adapter + manifest reader (worker init) | node |
| `packages/ui` | Transplanted collab-v2 module + terminal components — **web app** (no desktop shell; arrives at M2) | bun/vite |
| `db/migrations` | ONE clean migration sequence (no legacy history) | — |
| `tools/conformance` | Contract conformance suite — runs against any base URL (M1 gate artifact) | bun |

There is **no `apps/desktop`** (AM-1): the UI is a browser app talking to tm8-server over HTTP/WS. Agent sessions spawn as server-side PTYs; the `session:spawn` payload shape is preserved verbatim on the server path (R29). Terminals render in the browser via xterm (WebGL renderer on Chromium, DOM fallback); exited-session terminals unmount; log memory is bounded.

## Ports, databases & data dirs

The one table is [`deploy/environments.sh`](deploy/environments.sh) — print it with
`bash deploy/environments.sh`. Everything reads it from there.

| env | server | open | vite dev | pg | database | data |
|---|---|---|---|---|---|---|
| `dev` | **4610** | 4611 | 4611 | 5442 | `tm8_dev` | `~/.tm8-dev/` |
| `staging` | **8887** | 8888 | 18888 | 5443 | `tm8_staging` | `/var/lib/tm8/staging/` |
| `prod` | **17777** | 7777 | — | 5442 | `tm8_prod` | `/var/lib/tm8/prod/` |
| `private` | **7779** | — | — | 5444 | `tm8_private` | `/var/lib/tm8/private/` |

`server` is the node process, always bound to loopback. `open` is what a human
opens — nginx in front of prod, vite in front of dev.

This table used to say prod was 4610 with data in `~/.tm8/`, which described no
instance that has ever existed: prod has been 17777 behind nginx on 7777 the whole
time. Two other files disagreed with it in two further ways. The live topology is
canonical (ruled 2026-08-12) and now lives in exactly one place.

## Hard rules

- **Contract-first:** nothing imports Postgres types or server internals across package lines; `packages/contract` is the only cross-package dependency.
- **Runtime split:** `packages/server` and `packages/execution` run under **node**, never bun (node-pty is broken under bun). Everything else may use bun.
- **No legacy references:** zero Firebase/Supabase references, zero UID-bypass machinery, no imported migration history.
- Verification is scoped: per-package `tsc -b` / `vitest`. Never run parallel vite builds.
- **The product UI is `packages/tm8-ui`.** `packages/ui` is the legacy collab-v2
  oracle — not served, not built, not started. The launchers pointed at the wrong
  one until 2026-08-12.
- **`bun run build` is `tsc -b` ONLY.** The UI needs its own `vite build`. Skipping
  it ships a stale UI against a new server, with no error anywhere.
