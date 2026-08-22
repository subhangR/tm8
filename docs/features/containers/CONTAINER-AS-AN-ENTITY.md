# TM8 — Container as an entity: design

**Author:** Opus 5 1M Teammate (session `01a021a4-521d-7f58-8829-f63f2856373f`)
**Date:** 2026-08-21
**Origin:** task `01a021a1-a690-76c9-8bf0-f651c83c26d2` — "Container As an Entity"
**Status:** design only. No product source was edited, no migration was written, no kind was
seeded, nothing was run. Not ratified.
**Companion:** [`RUNTIME-ENVIRONMENT-SEAM.md`](RUNTIME-ENVIRONMENT-SEAM.md) — the verified survey
of what exists today. Every "this is missing" claim below is sourced from it.

---

## 0. How to read this

Three tiers, marked inline:

- **VERIFIED** — read in the tree, quoted with `file:line`, resolved against `main` at `91ce09e1`
  (2026-08-21). The tree wins over this document.
- **DESIGNED** — a decision this document makes. Binding on implementation if ratified; not yet.
- **OWNER** — a position stated by the owner in the originating discussion, recorded verbatim in
  intent.

---

## 1. The proposal, and the one-line shape

**OWNER**, the originating framing:

> a container has some files, some setup and some things already defined, so that a container
> becomes a workspace for the agent, with the entire files, and credentials, and everything
> packaged, and an agent or terminal spawn goes into a container […] it's like memory for the
> agent, but memory is not just the files, the environment, the tools, the installations, the
> setups and all that, already built can also be considered memory, so that it's easy for agents
> to continue on setup on any machine.

**OWNER**, added second:

> this container as entity is not just for spawning agents inside the container, it's also for the
> agents to *run* these containers and run some tests or something against them.

**OWNER**, added third — and this is what the feature is *for* (§4B):

> the idea is we create some environments like `tm8-web-dev`, `tm8-mobile-dev` or something like
> that where we already have installed mobile things or browsers or whatever, tools, and for a
> task we can run it on a specific container.

**DESIGNED** — the resulting shape in one line:

> A **container** is a *declared environment* pinned to an image digest — either a project's own,
> or a **named entry in a shared catalog** (`tm8-web-dev`, `tm8-mobile-dev`). A **worktree** is a
> checkout mounted into it. A **session** is a PTY exec'd inside it. A **task** can name the
> environment it needs. And an agent can also *operate* containers it does not live in — start
> them, run a suite against them, read the exit code, tear them down.

Layering: `container ⊃ worktree ⊃ session`. Only the container is new. **Worktrees do not
change** — they stay host-side `git worktree add`, because bind-mounting a host path into a
container is free. That is the single biggest reason this is additive rather than a rewrite.

---

## 2. Why the reframe matters: memory vs. reproducible state

**DESIGNED** — the owner's "it's like memory" instinct is right about the *value* and misleading
about the *mechanism*. Sharpened:

> **Memory is replayable knowledge. A container is reproducible state.**

A memory entity is worth keeping even when it is slightly wrong; you read it and judge. A warm
environment that is slightly wrong is *worse than nothing* — it produces a green test run that
lies, or a white screen with no error. Environments therefore need something memories do not: a
mechanical staleness answer.

This is not a new ruling in this repo. **VERIFIED** `db/migrations/057_worktrees.sql:62-65`
already made it for worktrees:

> No `head_commit_oid` / `tree_digest` / `dirty` columns: those are point-in-time samples of a
> checkout, not properties of an allocation; **storing them guarantees they are stale.**

---

## 3. How a Docker image actually works — and the correction that follows

The first pass of this design said *"store the derivation, not the bytes."* That is **too blunt,
and Docker is the counter-example.** Recorded here because the correction is the load-bearing
idea.

### 3.1 The mechanism

An OCI image is not a snapshot of a machine. It is three things:

1. **A manifest** — JSON listing layers by `sha256:…`
2. **A config** — JSON: env, entrypoint, working dir, and the build history
3. **Layers** — each a `tar.gz` of *filesystem changes*, addressed by the hash of its own bytes

A layer is a **diff**, not a disk. `RUN pnpm install` yields a tarball of "what appeared under
`node_modules/`". Stack them with overlayfs and you get a filesystem. The image ID is a hash of
its content; `pull` fetches only the layers you lack. Content-addressing is what makes an image
built on one machine reproduce on another — which is exactly the owner's "continue on any
machine".

The build cache is keyed **per instruction**: same base + same command + same copied files → reuse
the cached layer; otherwise rebuild that layer *and every layer after it*.

### 3.2 The corrected rule

Docker stores **both** the derivation (the Dockerfile) and the bytes (the layers), and the bytes
are **content-addressed by their inputs**. So:

> **DESIGNED — bytes are safe when they are keyed by a hash of their inputs. Bytes are poison when
> they are a snapshot with no input key.**

The test is a single question: **can you mechanically tell whether it is stale?**

| Artifact | Key | Stale-detectable? | Verdict |
|---|---|---|---|
| Layer from `COPY pnpm-lock.yaml` + `RUN pnpm install` | lockfile hash | yes | **safe — cache forever** |
| `docker commit` of a hand-tweaked container | nothing | no | **poison** |
| A tarball of `/workspace` | nothing | no | **poison** |

Migration 057's ruling is the second case, not the first. This document over-applied it on the
first pass. **Docker-style layers are the first case and they are exactly right here.**

---

## 4. Two roles, one kind

**OWNER** raised the second use case; **DESIGNED** is the way to satisfy both without two kinds.

| Role | What it is | Who attaches |
|---|---|---|
| **Workspace** | the environment the agent *lives in* — toolchain, deps, the agent CLI | the PTY, via `docker exec -it` |
| **Target / service** | a Postgres, a Redis, the app under test | nothing; reachable over the network |
| **Ephemeral run** | "run this command in a fresh instance, give me exit code + logs" | nothing; the output is the point |

**DESIGNED — do not model the role on the entity.** `devcontainer.json` already solved this: it
carries `dockerComposeFile` plus a `service` field naming which service the dev container is. So:

> **The `container` entity is the *environment* — possibly several processes. `container_instances`
> rows are per *service*. One designated service is the workspace; the rest are targets.**

This matters more than it looks. It is the difference between "agents get a nicer sandbox" and
"agents get a reproducible integration-test rig", and the second is where the recorded pain is:

- **VERIFIED (survey §8)** the dev Postgres sidecar is one shared cluster on 5442 that concurrent
  lanes contend for;
- **VERIFIED (survey §8)** `vite --port` on a busy port dies silently and `curl` then 200s
  *another lane's tree*.

Both are "the agent needed an isolated service and there wasn't one". A per-container network with
per-lane service instances is the fix, and it falls out of this model for free.

---

## 4B. Named environments — the catalog

**OWNER**, and this is the shape the feature is *for*:

> the idea is we create some environments like `tm8-web-dev`, `tm8-mobile-dev` or something like
> that where we already have installed mobile things or browsers or whatever, tools, and for a
> task we can run it on a specific container.

**DESIGNED.** A catalog of named, reusable environments — and it **overturns the `project_id not
null` decision** made in §5.1 below, which is recorded there rather than quietly edited away.

### 4B.1 Two flavours, distinguished by whether they belong to a repo

| | **Project container** | **Catalog container** |
|---|---|---|
| Example | this repo's own devcontainer | `tm8-web-dev`, `tm8-mobile-dev`, `tm8-db` |
| `project_id` | not null | **null** |
| Spec | `.devcontainer/devcontainer.json` in the repo | a Dockerfile in a designated infra location, or a bare image ref |
| `input_digest` covers | spec + lockfile (+ migration chain) | the spec only — without a repo there is no lockfile |
| Tracks | the codebase | the toolchain |

The catalog is where *"already installed"* lives, and it is the half of the feature that a
per-project container cannot deliver:

- **`tm8-web-dev`** — node, pnpm, a real Chrome with the CDP plumbing, Playwright
- **`tm8-mobile-dev`** — the device toolchain, emulators, the mobile-audit harness
- **`tm8-db`** — a Postgres at the current migration chain, used as a *target* (§10)

`tm8-web-dev` is worth calling out because it converts a recurring, expensive problem into a
provisioning detail: browser verification currently depends on whatever Chrome happens to be on
the machine, past whatever auth wall happens to be up. A named environment with a known browser
is a reproducible answer to that.

### 4B.2 The uniqueness constraint this forces

**Postgres treats NULLs as distinct in a UNIQUE constraint**, so the `unique (project_id, name)`
in §5.1 does *not* prevent two catalog containers both named `tm8-web-dev`. Two partial indexes
are required:

```sql
create unique index containers_project_name_uq
  on public.containers(project_id, name) where project_id is not null;
create unique index containers_catalog_name_uq
  on public.containers(name)             where project_id is null;
```

**VERIFIED** — the tree already uses exactly this idiom for exactly this reason. `057:43` seeds
the kind registry with `on conflict (kind) where space_id is null do nothing`, because a null
scope column is not a value.

### 4B.3 Name versus digest — the reproducibility split

A catalog name is a moving reference; an image digest is not. **That distinction already has a
ruling in this repo, one level down** — **VERIFIED** `057:57-58`:

> `base_commit_oid` is the reproducibility anchor: refs move, a resolved OID does not.

**DESIGNED**, exactly parallel:

- a task or session points at the container **entity** — the *name* — so dispatch always gets the
  current catalog build;
- every `container_instances` and `container_runs` row records the **digest that actually ran**.

Neither half is sufficient alone. Pin only the name and an old run becomes unreproducible; pin
only the digest and the catalog can never be updated. `base_ref` + `base_commit_oid` is the
same pair of facts about a checkout, and it is already load-bearing.

### 4B.4 Inheritance belongs in the spec, not the schema

`tm8-web-dev` and `tm8-mobile-dev` will share a base. **DESIGNED — do not model that with an
`extends` edge or a `base_container_id` column.** A Dockerfile's `FROM` already expresses it and
the layer cache already exploits it; a second declaration in the graph is a second source of truth
that will drift from the first. The UI may *display* the relationship by reading the resolved
image's parent digests. It must not *own* it.

### 4B.5 Which container does a task run in?

**OWNER** — *"for a task we can run it on a specific container."*

**DESIGNED — an edge, `runs_in` (task → container)**, resolved at spawn through a four-step
precedence ladder:

1. an explicit `--container <id>` on the spawn call;
2. the task's `runs_in` edge;
3. the project's default container;
4. none → today's native spawn, unchanged.

This is deliberately the same shape as the spawn defaults that already exist — **VERIFIED**
`contract.ts:2923` describes `ProjectDefaults` as *"Per-project spawn defaults, overridable per
`execution.spawn` call"* — so it introduces no new precedence vocabulary to learn.

**An edge rather than a column**, for two reasons. A task may legitimately need more than one
environment (build in `tm8-web-dev`, verify against `tm8-db`, screenshot in `tm8-mobile-dev`);
and it is the house rule — **VERIFIED** `db/migrations/005_custom_kinds.sql:12`: *"If a relation
matters, it is an edge, full stop (R8)."* A new row in `public.edge_types` (`001:900`) declares
it, with `src_kinds = {task}` and `dst_kinds = {container}`.

---

## 5. Data model

**DESIGNED.** Structure copied deliberately from `057_worktrees.sql`.

### 5.1 `container` — new core entity kind, semantic, versioned

Entity-backed. **Has** the `snapshot_entity_version` trigger, so one semantic transition = one
`entities.version` bump.

```
entity_id        uuid pk → public.entities(id) on delete cascade
project_id       uuid null → public.projects(id) on delete restrict   -- null = catalog (§4B)
name             text not null
spec_kind        text check in ('devcontainer','compose','dockerfile','image-ref')
spec_source      text            -- repo-relative path, infra path, or a registry ref
input_digest     text            -- sha256 over spec + the files it declares as inputs
resolved_image   text            -- sha256:… (or a per-service map, for 'compose')
built_at         timestamptz
workspace_service text           -- which service the PTY execs into; null = single-container
env_var_names    text[] not null default '{}'   -- NAMES only
network_policy   jsonb           -- reuse CommandNetworkPolicy's shape (types.ts:51)
status           text check in ('active','stale','retired')
status_changed_at timestamptz not null default now()
-- uniqueness is TWO partial indexes, not one constraint — see §4B.2
```

### `project_id` is nullable — a decision reversed, on purpose

The first pass of this design made `project_id` **`not null`**, reasoning from **VERIFIED**
`057:53-58` (*"a worktree without a project is meaningless — it is a checkout OF something"*) plus
a sharper-sounding argument: the spec file lives in the repo, so a container with no codebase has
no spec.

**That argument is wrong, and §4B is why.** It holds for a *project* container and fails for a
*catalog* container: `tm8-mobile-dev` is a toolchain, not a checkout, and its spec lives wherever
the infra keeps it. Making `project_id` `not null` would have forced every named environment to
be adopted by an arbitrary repo — the single most useful thing containers can do, modelled as an
accident.

The `not null` reasoning is left here rather than deleted because the *worktree* precedent it
came from is still correct, and a later reader is otherwise likely to re-derive it and "fix" the
column back. **`on delete restrict` is kept**: a project container must not outlive its project.

Immutability follows 057: `spec_kind`/`spec_source`/`project_id` are accepted by no update door
and the table carries no UPDATE grant. `status` gets an **R29 single-writer guard**, modelled on
`internal.guard_worktree_status` (**VERIFIED** `057:103`).

### 5.2 `container_instances` — operational, NOT entity-backed

**No** snapshot trigger — a write here must be mechanically incapable of bumping
`entities.version`, exactly as **VERIFIED** `057:22-30` requires of `worktree_allocations`. This
is not stylistic: instance churn is high-frequency, and every avoidable `entities.version` bump is
event-log waste and false staleness on every pinned memory.

```
id                    uuid pk
container_entity_id   uuid not null → public.containers(entity_id) on delete cascade
node_id               text not null
service_name          text not null default 'workspace'
docker_container_id   text
image_digest          text
state                 text check in ('provisioning','ready','stopped','missing','failed')
lease                 -- session holding it, if any
started_at, last_seen_at, ended_at
```

### 5.3 `container_runs` — operational, the ephemeral arm

Separate table because **the output is the point**, and a run is not a lease on a long-lived thing.

```
id, container_entity_id, node_id, image_digest,
command text, exit_code integer,
started_at, ended_at, log_ref   -- points at a file/artifact entity, not inline
```

### 5.4 Graph wiring

- **Edge `in_container`** (work_session → container), mirroring `in_worktree`.
- **Edge `runs_in`** (task → container) — the catalog routing of §4B.5. Both need a row in
  `public.edge_types` (**VERIFIED** `db/migrations/001_core_graph.sql:900`), which is where
  `src_kinds`/`dst_kinds` are declared and enforced.
- **Column `work_sessions.container_id uuid null`.** **Nullable is the entire back-compat story:**
  `null` means today's native spawn, completely unchanged. **VERIFIED (survey §6)** the sibling
  `workdir_mode` shows the hazard to avoid — its TS union admits `'scratch'` while the CHECK
  constraint does not. **Write the TS union and the CHECK in one change.**

---

## 6. Bake vs. mount — the load-bearing decision

**DESIGNED.**

| Thing | Where | Why |
|---|---|---|
| OS + toolchain (node, pnpm, git, `psql`) | **image layer** | changes monthly; content-addressed; shareable |
| Deps, keyed on lockfile hash | **image layer** | this *is* the warm environment — the whole payoff |
| **The agent CLI** (`claude-code`/`codex`) | **image layer**, at `/usr/local/bin` | must land where `resolveAgentBinary` looks — §6.2 |
| **The `tm8` CLI** | **bind mount from the server's checkout — NEVER baked** | version-coupled to the running server — §6.3 |
| Repo / worktree | **bind mount**, host → `/workspace` | baking it makes every container a stale fork |
| Credential home (`~/.claude`, `gh` config dir) | **bind mount, read-only** | §6.1 |
| Env *values* | **injected at exec** | preserves the S15 guarantee |

### 6.1 Credentials must never enter a layer

**VERIFIED (survey §4)** `db/migrations/006_execution_side.sql:38-58` — `session_manifests` stores
env var **names** only, and `internal.guard_manifest_secrets()` raises `23514` on a
credential-shaped string, because *"if a credential-shaped string ever reaches a manifest, the
write fails loudly instead of quietly persisting a secret that then flows into every backup and
transcript."*

An image layer is strictly worse than a manifest for this. **A secret written in one layer and
`rm`'d in a later layer is still sitting in the earlier layer's tarball, forever, and travels with
every push and pull.** This is a well-known way tokens leak out of published images.

> **DESIGNED — the build must fail if a credential path or a credential-shaped string appears in
> any layer.** Same spirit as the S15 trigger, extended from manifests to images. The precedent
> exists; reuse the regex.

### 6.2 The agent binary — a packaging convention, not a code change

**VERIFIED** `manifest.ts:1128` `resolveAgentBinary(binary, path)` and `:1110`
`withAgentBinDirs(path, parentEnv)` compose the PATH the PTY sees, from a **hardcoded candidate
list that ignores ambient `PATH`** — **VERIFIED** `manifest.ts:1089-1096`:

```ts
function agentBinDirCandidates(parentEnv: NodeJS.ProcessEnv): string[] {
  const home = parentEnv['HOME'];
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin'];
  if (home) {
    dirs.push(join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.volta', 'bin'));
  }
  return dirs;
}
```

**This resolves cheaply, and better than the first pass assumed.** `/opt/homebrew/bin` is
macOS-only, but **`/usr/local/bin` is on the list and is the natural install location inside a
Linux image**. So:

> **DESIGNED — install the agent CLI at `/usr/local/bin` in the image. `agentBinDirCandidates`
> needs no change.**

That downgrades what §17 listed as "the one piece of existing code this feature forces a decision
about" into a documented packaging convention. **VERIFIED** `manifest.ts:1103-1108` confirms the
list is shared with `composeCredentialEnv` precisely because *"the PATH problem is genuinely
identical for both"* — so a convention that satisfies one satisfies both.

### 6.3 The `tm8` CLI must be MOUNTED, never installed into the image

Every workspace container needs the `tm8` CLI, because the CLI *is* the reporting loop. But
**installing it in the image is the one thing the existing code explicitly defends against.**

**VERIFIED** `manifest.ts:1042-1054`:

> Put the `tm8` binary on the agent's PATH. The system prompt instructs the agent to report
> durably with `tm8 message send --to <anchor-entity-id>` — that IS the reporting loop […] and it
> is the only way its work becomes visible in the graph. `@tm8/cli` is a workspace package with a
> `bin` entry that **nothing ever installs globally**, so without this every one of those commands
> dies with "command not found" **and the agent looks broken while believing it reported**.
> PREPENDED so a **stale globally-installed `tm8` cannot shadow the build this server actually
> shipped with**.

**VERIFIED** `manifest.ts:1172-1188` — `cliBinDir()` resolves
`fileURLToPath(new URL('../../../cli/dist', import.meta.url))`, i.e. **`packages/cli/dist` inside
the server's own checkout**, and symlinks `tm8 → index.js` there if the link is missing.

Three consequences, all load-bearing:

1. **A baked `tm8` is exactly the "stale globally-installed `tm8`" that `composeEnv` prepends its
   own bin dir to shadow.** Baking it re-creates, inside the image, the failure the current code
   goes out of its way to prevent — and the failure mode named in that comment is the worst kind:
   *the agent looks broken while believing it reported.*
2. **The coupling is to the server's catalog, not just its version.** `tm8 help` returns a
   `catalogDigest`; a CLI built from a different commit can disagree with the running server about
   which operations exist. An image is rebuilt on a toolchain cadence (§4B.1) and the server moves
   on every merge — guaranteed drift.
3. **The mount cannot be read-only, or must be pre-warmed.** `cliBinDir()` *writes* the
   `tm8 → index.js` symlink when absent and **returns `null` if it cannot** — which silently
   yields a container with no `tm8` on `PATH`. Either mount read-write, or guarantee the symlink
   exists on the host first (any prior native spawn creates it). **This is a real trap: the
   failure is silent and looks like a broken agent.**

> **DESIGNED — mount `packages/cli/dist` from the server's checkout into every workspace
> container and prepend it to `PATH`, exactly as `composeEnv` does today. The image supplies the
> `node` runtime that executes it; it must not supply the CLI.**

The image therefore owes the workspace three things and no more: a `node` able to run the CLI
bundle, the agent CLI at `/usr/local/bin`, and the toolchain the environment is *named* for.
Everything identity-bearing — the CLI, credentials, the checkout — arrives as a mount.

`TM8_BASE_URL` must also resolve from inside the container; see §12, and note the Codex
loopback-proxy precedent solves the same problem for a different confinement.

---

## 7. Spec format: adopt `devcontainer.json`, do not invent one

**DESIGNED.** It already expresses base image, features, `postCreateCommand`, mounts, forwarded
ports, and — critically for §4 — `dockerComposeFile` + `service`. Cursor and VS Code speak it, so
repos that already carry one work on day one, and a developer can run the same environment without
tm8 at all.

**Store the *reference*, not the contents.** A project container's spec is versioned by git;
duplicating it into the graph creates a second source of truth that will drift. The entity's job is
to record *which* spec, *what digest it resolved to*, and *whether that is still current*.

**A catalog container's spec has no repo to live in** (§4B.1), which is why the column is
`spec_source` rather than `spec_path`: it holds a repo-relative path for a project container, and
for a catalog container either a path in a designated infra location or a bare registry ref. The
rule is unchanged — the graph stores a reference and a resolved digest, never the spec body.

**Open, and worth deciding early:** where the catalog's Dockerfiles live. A dedicated infra repo
keeps them reviewable and versioned, which is what makes `input_digest` computable for a catalog
container at all. Inline spec text on the entity would make `tm8-mobile-dev` editable from the UI
and simultaneously destroy its provenance. This design assumes the former.

---

## 8. The invalidation rule — this is the whole feature

**DESIGNED.**

```
input_digest = sha256( spec file ‖ each file the spec declares as an input )
```

For this repo that means `devcontainer.json` plus `pnpm-lock.yaml`, and for a container that
provisions a database, the migration chain.

On every spawn and every run: recompute over the current worktree.

- digest matches → use the image, no questions;
- digest differs → the container is **`stale`**. Surface it in the panel, offer a rebuild, and
  **do not silently use it**.

Without this rule, the feature ships as a rotting cache — the same failure class as the stale
`cli`/`contract` `dist` that white-screens `tm8-ui` with no error (**VERIFIED (survey §8)**). With
it, the graph *answers* the staleness question instead of a human discovering it via a symptom
three layers away.

> This is the acceptance test for the whole design: **if you cannot compute "is it stale", do not
> ship it.**

---

## 9. Spawn flow

**DESIGNED.**

```
tm8 session spawn --container <id> [--workdir worktree --base-ref main]
  │
  ├─ resolve container entity; recompute input_digest against the worktree
  │     mismatch → refuse or rebuild, per policy (never silently proceed)
  ├─ resolve/build image → resolved_image
  ├─ find a ready container_instance on this node, else start one
  │     mounts:  worktree → /workspace          (rw)
  │              credential home → …            (ro)
  │     network: per network_policy; graph reachable via the host gateway
  ├─ docker exec -it <instance> <agent binary>   ← the PTY attaches here
  └─ record the in_container edge + work_sessions.container_id
```

**VERIFIED** `manifest.ts:456` — `buildAgentCommand` is *"one place that decides which binary the
PTY actually runs"*, and `resolveWorkdir` (`:391`) / `composeEnv` (`:920`) are the matching single
points for cwd and env. **This is why the change is one seam and not a scattering.**
`resolveWorkdir` gains a container branch; `composeEnv` gains the mount spec.

**DESIGNED — containers outlive sessions.** Many sessions exec into one warm instance. That is
where the speed comes from, and it is what makes "a container becomes a workspace for the agent"
literally true rather than a metaphor.

---

## 10. Running containers *as targets*

**DESIGNED.** Two operations beyond spawn, both of which an agent can call:

- **`container.up` / `container.down`** — bring the environment's services up on this node,
  returning `container_instances` rows. For a `compose` spec this is the whole project; the
  workspace service is optional. Services share a per-container network, so the agent resolves
  peers by service name (`postgres:5432`) instead of contending for a host port.
- **`container.run`** — one-shot: start a fresh instance from `resolved_image`, execute a command,
  capture exit code + logs into a `container_runs` row, tear down.

**Why this is the stronger half of the case.** Today a lane that wants a clean database gets the
one shared cluster on 5442, and a lane that wants a dev server gambles on a port. Both failures are
silent and both have cost real debugging time. Per-container networks make "give me a clean
Postgres at the current migration chain" a one-line, reproducible, *disposable* request — and the
migration chain is exactly the kind of input `input_digest` should cover.

---

## 11. Resume

**DESIGNED.** Session identity becomes `(node_id, docker_container_id)` instead of an absolute
path.

**VERIFIED (survey §7)** resume today `stat()`s `work_sessions.workdir_path` and **refuses** if the
directory is gone, rather than silently choosing another cwd. Containers change the failure mode
for the better:

- instance present → `docker exec` back in, as before;
- instance gone (reboot, daemon restart) → **re-provision from `resolved_image` and remount the
  worktree**, then exec;
- image digest unresolvable → *now* refuse.

Re-provisioning is safe **precisely because the environment is reproducible.** That is the payoff
for storing a digest instead of a snapshot, and it is a strictly better contract than "the
directory vanished, give up."

---

## 12. Networking

**DESIGNED.** Reuse `CommandNetworkPolicy`
(`{ mode, allowedHosts, proxyEnabled }`, **VERIFIED (survey §5)** in
`packages/execution/src/spawn/types.ts:51`) rather than inventing a second posture vocabulary.

The containerised agent must still reach the graph server on the host. **VERIFIED (survey §5)**
this exact problem is already solved once, for Codex: `CODEX_LOOPBACK_HOSTS = ['127.0.0.1',
'localhost']` (`manifest.ts:91`) plus `codexLoopbackConfigArgs()` (`:110`) exist so a confined
sandbox can phone home. **Read `codex-network-preflight.ts` before designing container networking**
— it is the only precedent in the repo for "confined and still connected", and its host-based (not
port-based) allowlist shape is a lesson already paid for.

---

## 13. The macOS tax — do not discover this in P2

**DESIGNED, and stated as a risk rather than solved.** Docker on macOS is a Linux VM. Two real
consequences:

1. **Bind-mounted `node_modules` across the VM boundary is slow** — the canonical complaint.
   Mitigation is a named volume for `node_modules` rather than a bind mount, which conveniently
   matches §6 (deps are baked/volumed, source is mounted). **Measure it before committing to P2.**
2. The rest of the stack is native on the Mac — the PTY host, worktrees under
   `~/.local/share/tm8/data/worktrees/`, the Postgres sidecar on 5442. A containerised agent must
   cross back to reach the graph (§12).

---

## 14. Phasing

**DESIGNED.**

| Phase | Contents | Gate |
|---|---|---|
| **P1 — model + local docker + the first catalog entry** | the kind, detail tables, doors, `container_instances`, `in_container`, `--container` on spawn, `docker run` / `exec`, the CLI mount of §6.3, panel showing spec + digest + staleness + live instances. **One catalog container, `tm8-web-dev`, built and used.** Native spawn untouched (`container_id` null). | one session runs inside `tm8-web-dev` and one runs natively, from the same task |
| **P2 — the digest loop, routing and targets** | `input_digest` computation, rebuild-on-stale, the `runs_in` edge and its precedence ladder (§4B.5), `container.up/down/run`, `container_runs`, per-container networks, `tm8-mobile-dev` and `tm8-db` | a task routed to `tm8-mobile-dev` runs there without being told twice; a lane gets its own Postgres; two lanes run suites concurrently without port contention |
| **P3 — portability** | `node_id` points at another machine; catalog images pull from a registry | **no data-model change required** |

**P3 requiring no schema change is the reason to build P1 as containers rather than as a "named
local recipe".** A recipe abstraction would have to be rewritten to reach P3; this does not. Said
the other way: do not let a cheaper local-only design smuggle in the "continue on any machine"
promise that only the containerised one can keep.

---

## 15. Non-goals

**DESIGNED — explicitly out of scope, so that a later reader does not read absence as oversight.**

- **No remote hosts in v1.** The model does not foreclose them (§14 P3); nothing implements them.
- **No layers or image bytes in the graph.** The graph stores digests; a registry or the local
  Docker store holds bytes. Storing blobs in Postgres would recreate every problem this design
  exists to avoid.
- **No baked repo, no baked secrets** (§6).
- **No docker-in-docker.**
- **No per-session containers** — that throws away the warmth, which is the point.
- **No replacement for worktrees.** They are mounted, not superseded.

---

## 16. What this costs

**VERIFIED (survey §1)** — seeding a core kind is a **one-way door**:
`entity_kinds_guard_core` (mig 005) fires on UPDATE/DELETE only, so `('container','core',null,…)`
can be inserted and never removed. The TypeScript twin must land in the same change *"or
EntityKindDriftError kills the projector lane"* (`057:39`).

The touch list, roughly eight places:

1. `packages/contract/src/schemas.ts` — `CoreEntityKindSchema`
2. `packages/contract/src/contract.ts` — `CoreEntityKind` + the DTOs
3. a new migration — registry insert, two detail tables, the three triggers, an
   `internal.entity_content()` arm, create/update doors, RLS, the R29 status guard
4. `packages/server/src/facade/handlers/…`
5. `packages/server/src/facade/input-schemas.ts`
6. `packages/cli/src/discovery/operations.ts`
7. `packages/tm8-ui/src/panels/detail/tabs.tsx`
8. the UI kind-icon registry

**The single sharpest trap**, **VERIFIED** `057:11-20`: the `internal.entity_content()` arm is a
`create or replace` that **swaps the entire function body**, so a migration that copies an older
body silently deletes a later kind's hydration *with no error*. Copy from the **latest** migration
defining it and verify with `pg_get_functiondef` against a scratch chain — never by reading the
migration that introduced the function.

Also non-negotiable, from the survey's §6 drifts: **write the TS union and the SQL CHECK constraint
in the same change.** `workdir_mode` already admits `'scratch'` in TypeScript and rejects it in
Postgres; this feature should not add a third instance of that.

---

## 17. Open questions for the owner

1. ~~**`resolveAgentBinary`** — change the resolver?~~ **ANSWERED (§6.2): no.** `/usr/local/bin`
   is already in `agentBinDirCandidates` and is the natural install path in a Linux image, so this
   is a packaging convention rather than a code change.
2. **Rebuild policy on stale** — refuse and ask, or rebuild automatically? (§8) Automatic is
   friendlier and can burn minutes at spawn time.
3. **Does a container survive a node restart?** `--restart unless-stopped` versus re-provision on
   resume (§11). Re-provision is more honest; restart is faster.
4. **Scope of `input_digest`** — is the migration chain an input for a container that provisions a
   database? (§10) Says yes; wants confirmation, because it makes the digest churn with every
   migration.
5. ~~**Is `project_id` really `not null`?**~~ **ANSWERED by the owner (§4B): no, it must be
   nullable** — a catalog of named environments is the point, and those belong to no repo.
6. **Where do the catalog's Dockerfiles live?** (§7) A dedicated infra repo is assumed, because
   `input_digest` needs a versioned spec to hash. Inline spec text would make the catalog
   UI-editable and destroy its provenance.
7. **Is the `tm8` CLI mount read-write?** (§6.3) `cliBinDir()` writes a symlink and returns `null`
   if it cannot, which silently produces a container with no `tm8` on `PATH` — the failure looks
   like a broken agent. Either mount read-write or guarantee the symlink is pre-warmed.
8. **How does a catalog container get built the first time, and by whom?** P1 assumes a human
   builds `tm8-web-dev`; nothing here designs a build queue.
