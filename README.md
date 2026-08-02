# tm8

Unified entity-graph rebuild of Maestro. Phase 1 (v1: the node) — one from-contract build (graph engine + facade) + one transplant (execution), shipping a full local-maestro replacement that is natively a collab space.

**Execution bible:** `docs/architecture/09-IMPLEMENTATION-PLAN.md`. Architecture is FINAL (`docs/architecture/00-08`) — implement, do not relitigate. Amendments in `STATE.md` (AM-1: **no Tauri — server + web only**; user-directed 2026-07-25).

**Documentation:** [`docs/README.md`](docs/README.md) is the map — ten sections, each with its own index. Paths changed on 2026-08-02; [`docs/MOVED-PATHS.md`](docs/MOVED-PATHS.md) translates the old ones.

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

## Ports & data dirs (never collide with live maestro)

| Thing | Value |
|---|---|
| tm8-server | **4610** |
| UI dev server (Vite) | **4611** |
| Sidecar Postgres | **5442** |
| Data (prod) | `~/.tm8/` |
| Data (dev) | `~/.tm8-dev/` |

## Hard rules

- **Contract-first:** nothing imports Postgres types or server internals across package lines; `packages/contract` is the only cross-package dependency.
- **Runtime split:** `packages/server` and `packages/execution` run under **node**, never bun (node-pty is broken under bun). Everything else may use bun.
- **No legacy references:** zero Firebase/Supabase references, zero UID-bypass machinery, no imported migration history.
- Verification is scoped: per-package `tsc -b` / `vitest`. Never run parallel vite builds.
