# tm8 — configuration, environments, and how to start it

**Owner:** Ops (Argo). **Status:** live from W0.
**Companion docs:** `docs/ops/SIDECAR-PACKAGING.md` (how the Postgres sidecar ships and is managed — R15).

There is no installed desktop app (AM-1/T-D21). tm8 is **a server plus a web UI**, so
"start the app" means "start tm8-server". This document is the normative reference for
how that is configured and how the dev and prod stacks stay out of each other's way —
and out of live maestro's way.

---

## 1. One-command start

| What you want | Command | Result |
|---|---|---|
| Develop | `bun run dev` | preflight → scoped build → tm8-server under **node** → Vite UI on 4611 → watch + rebuild + restart |
| Develop, server only | `bun run dev:server` | same, without the UI dev server |
| Run it for real | `bun run start` | build everything (incl. one UI bundle) → tm8-server on 4610 serving the built UI |
| Diagnose | `bun run doctor` | print the resolved config and every preflight check, start nothing |
| Run the merge gate | `bun run check` | install + per-package `tsc -b` + vitest + migration gate |

`bun run dev` is a thin shim: the orchestrator itself is `scripts/dev.mjs` and runs under
**node**, because it supervises `packages/server` and `packages/execution` and
**node-pty is broken under bun**. Bun is used for installs, the UI, and test running only.

What `bun run dev` does, in order:

1. **Resolve env** — defaults + `.env` files (§2).
2. **Preflight** — node ≥ 20, launcher not running under bun, data dir not inside
   `~/.maestro*`, no port collision with live maestro, ports actually free,
   `node_modules` present. A failure prints exactly what to change and aborts (§4).
3. **Build** — `tsc -b packages/server`, which pulls `packages/contract` in through its
   project reference. Scoped, sequential. **Never a vite build here.**
4. **Run** — `node --enable-source-maps packages/server/dist/index.js` with the resolved
   env. The sidecar Postgres on `TM8_PG_PORT` is started by *tm8-server itself* (R15,
   `packages/server`, W1) — the orchestrator only reserves and reports the port.
5. **UI** — starts the Vite dev server on `TM8_UI_PORT` **when `packages/ui` is a real
   Vite app**. It is not yet (it arrives at W3/M2), so today the orchestrator prints a
   one-line note and continues server-only. Nothing to change when the UI lands: the
   detector flips automatically.
6. **Watch** — rebuilds on changes under `packages/{contract,server}/src` and restarts the
   server on a successful rebuild. A failed rebuild leaves the last good server running.

Everything the orchestrator spawns dies with it (SIGINT → SIGTERM → SIGKILL after 4s).
A stranded server holding 4610 is precisely the failure the isolation rules exist to prevent.

---

## 2. Configuration

All configuration is environment variables, prefixed `TM8_`. Resolution order, first wins:

1. the real process environment
2. `.env.<TM8_ENV>.local` — per-developer, per-env
3. `.env.local` — per-developer
4. `.env`
5. built-in defaults

All four `.env` forms are gitignored; `.env.example` is the tracked template.
**tm8 runs correctly with no `.env` at all** — create one only to move a port or a data dir.

| Variable | dev default | prod default | Meaning |
|---|---|---|---|
| `TM8_ENV` | `dev` | `prod` | Selects the default set below. `bun run dev` implies dev, `bun run start` implies prod; setting it explicitly overrides both. |
| `TM8_DATA_DIR` | `~/.tm8-dev` | `~/.tm8` | Everything durable: the sidecar PG cluster, backups, logs, the single-instance lock. |
| `TM8_PORT` | `4610` | `4610` | tm8-server: HTTP API + WebSocket + the built web UI. |
| `TM8_UI_PORT` | `4611` | `4611` | Vite dev server (dev only). |
| `TM8_PG_PORT` | `5442` | `5442` | Sidecar Postgres, owned by tm8-server. |
| `TM8_LOG_LEVEL` | `debug` | `info` | `error` \| `warn` \| `info` \| `debug`. |

Two tooling-only variables:

| Variable | Default | Meaning |
|---|---|---|
| `TM8_MIGRATION_DATABASE_URL` | — | Where `tools/ci/migrations-check.sh` applies the sequence. Falls back to `DATABASE_URL`, then to the sidecar on `TM8_PG_PORT`. |
| `NO_COLOR` | — | Set to anything to strip ANSI colour from the launchers and CI. |

### Containers (TM8-CONTAINERS-DESIGN §10.1)

Machines an agent runs in or drives. **The feature is OFF by default** and a node
that has never been configured for containers must not start accepting them after
an upgrade — which is why the gate is a literal `on`/`off` rather than a
boolean-ish `0`/`1`: it is the value an operator reads in a runbook, and anything
that is neither is refused at boot rather than silently treated as off.

| Variable | Default | Meaning |
|---|---|---|
| `TM8_CONTAINERS` | `off` | `on` \| `off`. The feature gate. With it off, **every container runtime operation answers `501 not_implemented`** — never `404`, never a silent success. **The birth verb is NOT hidden:** `containers.create` is still advertised with the gate off and answers 501 when called. (An earlier version of this row claimed it was hidden. Nothing implements that — the gate has one reader, the 501 site.) Graph-only reads keep working: a container that already exists is still an entity, and a node that has stopped serving runtimes has not stopped being able to describe what it has. |
| `TM8_CONTAINER_PROVIDERS` | `docker,gvisor,android-emulator` | Comma list of providers to enable, **in preference order** — the first that can serve a profile at an acceptable isolation class wins. `fake` is the in-memory test provider. |
| `TM8_CONTAINER_CAP` | `4` | Live containers per node. Enforced **inside** the create door, not by the service: two server processes on one node would otherwise both read a free slot and both create. |
| `TM8_CONTAINER_EXEC_CAP` | `8` | Exec terminals per node. Disjoint from the agent-session cap — an exec terminal never burns an agent slot. |
| `TM8_CONTAINER_DATA_DIR` | `<dataDir>/containers` | Per-container private directories. Derived from `TM8_DATA_DIR` so two nodes on one box cannot collide. |
| `TM8_CONTAINER_IMAGE_REGISTRY` | `ghcr.io/subhangr/tm8` | Where profile images come from. |
| `TM8_CONTAINER_KEEP_FAILED` | `0` | `1` keeps the runtime of a **failed** container instead of destroying it during compensation. Debugging only: it leaks runtimes by design, so a node left with it on accumulates them until reconciliation or a human clears them. |

A misspelled `TM8_CONTAINERS` value fails at boot with a named error rather than
defaulting — the one place in this table where being wrong is louder than being
absent, because "off" and "unparseable" would otherwise look identical while
meaning very different things about operator intent.

**Adding a variable:** it goes in `scripts/lib/env.mjs` (so the launchers pass it through),
in `.env.example` with a comment, and in the table above. Any `TM8_*` key present in a
`.env` file is forwarded to the server even if the launchers do not know it — so the server
block can grow its own config (`TM8_PG_BIN_DIR`, backup cadence, …) without touching Ops
files. Document it here anyway.

---

## 3. Environment isolation

Three stacks may exist on one machine. They must never share a port or a directory.

| Stack | Server | UI dev | Postgres | Data |
|---|---|---|---|---|
| **live maestro (prod)** | 3001 | — | — | `~/.maestro/` |
| **live maestro (staging)** | 4569 | 4568 | — | `~/.maestro-staging/` |
| **tm8** | **4610** | **4611** | **5442** | `~/.tm8` / `~/.tm8-dev` |

Also spoken for on this machine: 4567 (maestro server default), 4570, 4571 (collab-v2 UI dev).
`scripts/lib/env.mjs` holds these as `MAESTRO_RESERVED_PORTS` / `MAESTRO_RESERVED_DIRS`, and
preflight hard-fails if tm8 is pointed at any of them. **Live maestro keeps running untouched
throughout Phase 1** — that is a project-level requirement, not a courtesy.

### tm8 dev and tm8 prod at the same time

The canonical port numbers (4610/4611/5442) are the *same* for dev and prod; only the data
dir differs. That is fine while you run one at a time, and running one at a time is the
normal case. To run **both** concurrently, every one of these must differ — R15 is explicit
that a dual stack gets distinct data dirs **and** ports:

```dotenv
# .env.prod.local — a prod stack alongside a running dev stack
TM8_DATA_DIR=~/.tm8
TM8_PORT=4620
TM8_UI_PORT=4621
TM8_PG_PORT=5443
```

> **Open item for Vega.** The architecture pins one port triple (4610/4611/5442) and two data
> dirs, so a concurrent dev+prod stack has no *canonical* second port set. The offsets above
> (`+10` for the server pair, `5443` for the sidecar, matching `SIDECAR-PACKAGING.md` §7) are an
> Ops recommendation, not law. Until it is ratified, the launchers do the safe thing: preflight
> refuses to start on an occupied port and names the variable to change, rather than silently
> binding something else.

Sharing a data dir across two running servers is the one unrecoverable mistake here
(two postmasters, one cluster). The real defence is not the port: the sidecar listens on a
Unix socket **inside its data dir**, so two clusters have no shared endpoint to collide on, and
`packages/server` holds a single-instance lock on top of that. See
`docs/ops/SIDECAR-PACKAGING.md` §7. `TM8_PG_PORT` is a tooling endpoint (`psql`, `pg_isready`);
preflight treats it as a warning, not a hard failure, for exactly that reason.

---

## 4. When start fails

`bun run doctor` prints the resolved config and every check without starting anything.
For the agent CLI (`claude`/`codex`) and its login state — the one prerequisite
`bun run doctor` does not cover — run **`tm8 doctor`** (the CLI). Common failures
and what they mean:

| Message | Cause | Fix |
|---|---|---|
| `launcher runtime is node` failed | you ran the orchestrator under bun | use `bun run dev` (which shells out to node) or `node scripts/dev.mjs` |
| `TM8_PORT=4610 already in use` | another tm8 (or something else) is on it | stop it, or set `TM8_PORT` in `.env` |
| `TM8_PG_PORT=5442 already in use` (warning) | a previous sidecar is still up | fine if it belongs to this data dir; otherwise stop it or move the port |
| `data dir … resolves inside live maestro's data dir` | `TM8_DATA_DIR` points at `~/.maestro*` | point it at `~/.tm8-dev` or `~/.tm8` |
| `dependencies installed` failed | no `node_modules` | `bun install` |
| server "exited cleanly (scaffold has no listener yet)" | expected until W2 — `packages/server` is still the W0 scaffold | nothing to do |

---

## 5. CI — the merge gate

One script, three call sites: your terminal, the optional pre-push hook, and GitHub Actions.

```bash
bun run check              # full gate
bash tools/ci/check.sh --fast   # skip install + migration apply (what the hook runs)
```

Stages, in order — each runs to completion so one invocation surfaces every problem:

1. **toolchain** — bun and node present, node ≥ 20 (hard requirement: server + execution
   run under node).
2. **install** — `bun install`, or `bun install --frozen-lockfile` when `CI` is set.
3. **typecheck** — per-package scoped `tsc -b`, **sequentially**, in dependency order:
   `packages/contract` → `server` → `execution` → `cli` → `tools/conformance`. A package with
   no `tsconfig.json` is reported as skipped, not silently passed. `packages/ui` is checked
   with its own scoped `tsc -b` once it exists; **the gate never fans out vite builds** —
   concurrent vite builds SIGTERM each other.
4. **tests** — `bun run test` per package, but only where test files actually exist
   (`vitest run` exits non-zero on "no test files"). Placeholder `echo` test scripts and
   empty suites are reported as skipped. As `packages/contract/test/` and
   `tools/conformance/` fill in, they light up automatically.
   **The conformance suite is the merge gate from G0 onward** — once it runs, a red
   conformance run is a red merge.
5. **migrations** — `tools/ci/migrations-check.sh` (§6).

The run ends with a PASS/FAIL/SKIP summary. Skips are always printed with a reason; nothing
is quietly dropped.

### The pre-push hook (opt-in)

```bash
bun run hooks:install     # git config core.hooksPath tools/ci/hooks
bun run hooks:uninstall
git push --no-verify      # bypass once
```

Not installed for you. It runs `check.sh --fast`; the full gate is what runs remotely.

### GitHub Actions

`.github/workflows/ci.yml` is written and ready for the day tm8 gains a remote. Two jobs:
`check` (install + typecheck + tests) and `migrations` (the same migration script against a
Postgres service container). The service container's image tag must stay aligned with the
sidecar major pinned in `docs/ops/SIDECAR-PACKAGING.md` — a drift between CI's Postgres and
the shipped one is exactly the bug class the migration gate exists to catch.

---

## 6. The migration gate

`tools/ci/migrations-check.sh` has two layers:

- **Static** (always): file naming `NNN_lower_snake_case.sql`, no duplicate sequence numbers,
  and the no-legacy-references law (T-D3) — a grep that fails the build on `supabase`,
  `firebase`, `auth.uid()`, `service_role`, `SUPABASE_` anywhere under `db/migrations/`.
- **Apply** (when a Postgres is reachable): create a throwaway database, apply the whole
  sequence in lexical order with `ON_ERROR_STOP=1`, drop it. If no `psql` or no reachable
  server, it **skips loudly** and still runs the static layer.

`db/migrations/` is empty until W1, so today the script announces itself as a passing
placeholder. It goes live automatically the moment the first `NNN_*.sql` lands — no wiring
needed from the db workstream.

---

## 7. File map (Ops-owned)

```
scripts/dev.mjs                dev orchestrator (bun run dev)
scripts/start.mjs              prod launcher (bun run start)
scripts/doctor.mjs             diagnostics (bun run doctor)
scripts/lib/env.mjs            env resolution + reserved ports/dirs
scripts/lib/preflight.mjs      preflight checks
scripts/lib/run.mjs            child-process supervision + prefixed logging
scripts/lib/ui.mjs             "is packages/ui real yet?" detection
tools/ci/check.sh              the merge gate
tools/ci/migrations-check.sh   migration static + apply gate
tools/ci/hooks/pre-push        opt-in hook
.github/workflows/ci.yml       remote CI, ready for a remote
.env.example                   the tracked env template
docs/ops/CONFIG.md             this file
docs/ops/SIDECAR-PACKAGING.md  R15 sidecar distribution + lifecycle plan
```

These files are Ops-owned. Changes to `packages/*` sources, `db/`, or `tools/conformance`
route through their owners; changes here route through Ops.
