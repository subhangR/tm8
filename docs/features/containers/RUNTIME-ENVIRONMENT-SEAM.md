# TM8 — The runtime-environment seam: what exists today

**Author:** Opus 5 1M Teammate (session `01a021a4-521d-7f58-8829-f63f2856373f`)
**Date:** 2026-08-21
**Status:** survey only. No product source was edited, no migration was written, nothing was run.
**Companion:** [`CONTAINER-AS-AN-ENTITY.md`](CONTAINER-AS-AN-ENTITY.md) — the design this survey
was gathered for. Read this one first; the design's claims about "what's missing" are only as
good as this inventory.

---

## 0. How to read this

Two tiers of authority, marked inline:

- **VERIFIED** — the file was read in this session and the quote is exact. Line numbers were
  gathered against a stale worktree and then **re-resolved against `main` at `91ce09e1`**
  (2026-08-21) before this document was committed. The tree wins over this document.
- **SWEPT** — surfaced by a codebase sweep and not re-read line-by-line. Treat as a strong
  pointer, not a quotation.

The seam in one sentence: **tm8 decides *where* and *how* an agent runs entirely at spawn time,
from a project path and an ambient OS environment, and records almost none of it.**

---

## 1. `worktree` is already a core entity kind — and it is the pattern to copy

**VERIFIED** `packages/contract/src/schemas.ts:127-139` — `CoreEntityKindSchema` lists 21 kinds:

```
channel, task, message, member, team_member, doc, file, spell, skill,
pull_request, commit, work_session, collection, project, interaction_profile,
voice_channel, memory, worktree, artifact, loop, graph
```

`worktree` landed in `db/migrations/057_worktrees.sql`. Its structure is the single most
important prior art for any future "environment" kind, because it already solved the
version-noise problem by **splitting semantic identity from operational truth**:

**VERIFIED** `db/migrations/057_worktrees.sql:69-82` — the semantic table:

```sql
create table public.worktrees (
  entity_id         uuid primary key references public.entities(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete restrict,
  path              text not null check (path like '/%' and path not like '%..%'),
  branch            text not null check (char_length(btrim(branch)) between 1 and 255),
  base_ref          text not null,
  base_commit_oid   text not null check (base_commit_oid ~ '^[0-9a-f]{40}$'),
  status            text not null default 'active'
                      check (status in ('active','merged','abandoned','deleted')),
  status_changed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (path),
  unique (project_id, branch)
);
```

Four rulings in that file are binding on anything built next to it:

1. **VERIFIED** `057:22-30` — two tables, deliberately. `public.worktrees` is entity-backed and
   **has** the `snapshot_entity_version` trigger, so one semantic transition = exactly one
   `entities.version` bump. `public.worktree_allocations` is operational disk truth
   (`preparing/ready/cleanup_pending/missing/failed` + the session lease), is **not**
   entity-backed, and has **no** snapshot trigger — "a write here is mechanically incapable of
   bumping `entities.version`, which is the structural guarantee the memories lane depends on."

2. **VERIFIED** `057:53-58` — `project_id` is `on delete restrict`, deliberately unlike
   `work_sessions.project_id` (`set null`): *"a worktree without a project is meaningless — it is
   a checkout OF something."*

3. **VERIFIED** `057:62-65` — **the staleness ruling.** *"No `head_commit_oid` / `tree_digest` /
   `dirty` columns: those are point-in-time samples of a checkout, not properties of an
   allocation; storing them guarantees they are stale. Consumers sample Git when they need them."*

4. **VERIFIED** `057:57-59` — immutability of `path/branch/base_ref/base_commit_oid/project_id`
   is enforced by the update door accepting none of them **plus the absence of any UPDATE grant**
   on the table; `status` gets an R29 single-writer guard
   (`internal.guard_worktree_status`, `057:103`), modelled on `work_sessions_guard_status`.

**VERIFIED** `057:37-43` — the registry insert is
`insert into public.entity_kinds(kind, origin, space_id, icon) values ('worktree','core',null,'git-branch')`
and the comment calls it *"a ONE-WAY DOOR"*: `entity_kinds_guard_core` (mig 005) fires on
UPDATE/DELETE only, so a core kind can be seeded and never removed. The TypeScript twin must land
in the same change *"or EntityKindDriftError kills the projector lane."*

**VERIFIED** `057:11-20` — the shared-object hazard. §5 of that file does
`create or replace function internal.entity_content`, which *"swaps the ENTIRE body, so the
lexically-later migration silently wins and every earlier feature's `when` arm vanishes with no
error."* The chain at the time was `001 → 005 → 011 → 015 → 017 → 053 → 055 → 056`. Whoever writes
the next arm must copy **the latest** body, and verify with `pg_get_functiondef`, never by reading
the migration that introduced the function.

---

## 2. `project` is deliberately NOT an entity

**VERIFIED** `packages/contract/src/contract.ts:2908-2915`:

> A project is a repo/workingDir reference linked to spaces many-to-many (T-D17: workspace = root
> container of one server instance; space = sharing boundary; projects = linked resources). It
> deliberately is NOT an entity — **no hierarchy, edges, messages, or reactions** — so it lives as
> a resource DTO + the `projects.*` op family, and rides `space_projects` in the schema.

**VERIFIED** `contract.ts:2921-2946`:

```ts
export type ProjectTrustLevel = 'trusted' | 'untrusted';

export interface ProjectDefaults {
  model?: string | null;
  agentTool?: string | null;
  mode?: 'worker' | 'coordinator' | 'coordinated-worker' | 'coordinated-coordinator' | 'dispatcher' | null;
}

export interface ProjectResource {
  id: ProjectId;
  name: string;
  repoUrl?: string | null;
  /** Absolute path on the owning node; path-traversal/symlink-guarded (10-SECURITY-MODEL). */
  workingDir: string;
  trust: ProjectTrustLevel;
  defaults: ProjectDefaults;
  /** Migration/remediation state for the 16-active-link cap. */
  linkFrozen?: boolean;
  activeLinkCount?: number;
  createdAt: string;
  updatedAt: string;
}
```

**`ProjectDefaults` is a proto-environment**: a named, persisted bundle of *how to run here*. It is
the closest thing the graph has today to an environment record, and it holds exactly three fields.

**VERIFIED** `contract.ts:2917-2921` — trust is already framed as the future sandbox seam:
*"`untrusted` projects are spawn-restricted — the execution block refuses (**or sandboxes, later**)
sessions whose cwd resolves into them."* The word "later" is doing a lot of work; nothing
implements the sandbox half for the general case (see §5).

---

## 3. One seam decides cwd, env and binary

**VERIFIED** — `packages/execution/src/spawn/` contains exactly these files:

```
SpawnService.ts          agent-credentials.ts     checkout-branch.ts
codex-network-preflight.ts   index.ts             manifest.ts
native-session.ts        sandbox-probe.ts         secret-redaction.ts
skills.ts                types.ts                 workspace-trust.ts
worktree-provisioning.ts worktree-reconcile.ts    worktree-reconcile.test.ts
```

**VERIFIED** — `manifest.ts` is the single decision point. Its exported surface includes:

| Symbol | Line | What it settles |
|---|---|---|
| `DEFAULT_MODEL = 'sonnet'` | 46 | model fallback |
| `DEFAULT_AGENT_TOOL = 'claude-code'` | 48 | tool fallback |
| `DEFAULT_PERMISSION_MODE = 'auto'` | 63 | permission fallback |
| `CODEX_LOOPBACK_HOSTS = ['127.0.0.1','localhost']` | 91 | the only network allowlist in the repo |
| `agentToolForModel()` | 140 | model name → agent CLI |
| `resolveCommandNetworkPolicy()` | 193 | network posture |
| `resolveLaunchConfig()` | 289 | the composed launch decision |
| `resolveWorkdir()` | 391 | **cwd** |
| `buildAgentCommand()` / `buildCodexArgs()` | 490 / 563 | argv |
| `composeEnv()` | 920 | **env** |
| `withAgentBinDirs()` / `resolveAgentBinary()` | 1110 / 1128 | **PATH and the binary** |
| `composeManifest()` | 1218 | the stored manifest |

**VERIFIED** `manifest.ts:456` — the file's own comment on `buildAgentCommand`: *"one place that
decides which binary the PTY actually runs."* That is the property that makes a container seam a
single change rather than a scattering.

**VERIFIED** `manifest.ts:407` and `:428` — `resolveWorkdir` notes that the path it returns for a
worktree is *"the REPOSITORY root, which the provisioning saga replaces"*, and that it must refuse
the server's own cwd *"(which would let an agent write into the tm8 checkout)."*

**SWEPT** — worktrees are created by `worktree-provisioning.ts` (`git worktree add`) and swept at
startup by `worktree-reconcile.ts`.

---

## 4. Secrets are structurally absent from the graph, and that is enforced

**VERIFIED** `db/migrations/006_execution_side.sql:22-31`:

```sql
create table public.session_manifests (
  work_session_id uuid primary key references public.entities(id) on delete cascade,
  manifest        jsonb not null check (jsonb_typeof(manifest) = 'object'),
  -- Names only, e.g. ['ANTHROPIC_API_KEY'] — the execution block injects the
  -- values from the OS environment at spawn time and they never come back here.
  env_var_names   text[] not null default '{}'::text[],
  created_at      timestamptz not null default now()
);
```

**VERIFIED** `006:38-58` — `internal.guard_manifest_secrets()` is defence in depth for S15. It
raises `23514` if the rendered manifest matches
`(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})`, and `22023` if any
`env_var_names` entry fails `^[A-Z][A-Z0-9_]{0,80}$`. The stated reason: *"if a credential-shaped
string ever reaches a manifest, the write fails loudly instead of quietly persisting a secret that
then flows into every backup and transcript."*

**SWEPT** — `agent-credentials.ts` resolves a per-member **credential home directory** (the vendor
CLI's config dir) rather than injecting raw tokens; `secret-redaction.ts` scrubs output.
**VERIFIED** `manifest.ts:838` — the `gh` lookup path is explicitly modelled
(`GH_CONFIG_DIR > …`), and `manifest.ts:946` notes the credential env var *"only names which
directory the agent's vendor CLI reads."*

**This is the constraint any environment feature must not break.** A container that "packages
credentials" would become the first durable home for secret *values* in the system.

---

## 5. There is no container, image, VM or remote host anywhere in the repo

**SWEPT**, searched for: `docker`, `container`, `devcontainer`, `image`, `podman`, `firecracker`,
`e2b`, `modal`, `ssh`, `remote host`. What exists:

- `sandbox-probe.ts` — probes **Codex's** sandbox capability only. Returns
  `SandboxDecision { unavailable, degradedReason }` and degrades the requested mode to an
  available one. Nothing equivalent exists for `claude-code`.
- `codex-network-preflight.ts` + **VERIFIED** `manifest.ts:91,100,110` —
  `CODEX_LOOPBACK_HOSTS`, `CODEX_LOOPBACK_CONFIG_OVERRIDES`, `codexLoopbackConfigArgs()`. A
  loopback-only proxy so a tm8-owned Codex sandbox can still reach the graph server. This is the
  single precedent for "the agent is confined and still needs to phone home", and it is worth
  reading before designing container networking.
- `CommandNetworkPolicy { mode: 'loopback-proxy'|'full-access'|'provider-default'|'operator-defined', allowedHosts, proxyEnabled }`
  in `types.ts` — a reusable shape.

**Nothing else.** No OCI image concept, no `devcontainer.json` handling, no remote execution, no
`docker` invocation. Every spawn is a native process on the node that hosts the PTY.

---

## 6. What a `work_session` records about its runtime

**VERIFIED** `db/migrations/001_core_graph.sql:694-718`:

```sql
create table public.work_sessions (
  entity_id         uuid primary key references public.entities(id) on delete cascade,
  title             text not null default '' check (char_length(title) <= 500),
  node_id           text,                                  -- which node hosts the PTY
  project_id        uuid references public.projects(id) on delete set null,
  -- Server-COMPUTED working directory (S11): never accepted raw from a client.
  workdir_mode      text not null default 'project' check (workdir_mode in ('project','worktree')),
  workdir_path      text check (workdir_path is null or (workdir_path like '/%' and workdir_path not like '%..%')),
  base_ref          text,
  status            text not null default 'spawning'
    check (status in ('spawning','running','idle','exited','failed')),
  status_changed_at timestamptz not null default now(),
  agent_tool        text,
  model             text,
  mode              text check (mode is null or mode in
                       ('worker','coordinator','coordinated-worker','coordinated-coordinator')),
  share_mode        text not null default 'none' check (share_mode in ('none','space','explicit')),
  transcript_doc_id uuid references public.entities(id) on delete set null,
  exit_code         integer, error text,
  started_at timestamptz, exited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**VERIFIED** `001:727-730` — R29: `status` has a single writer,
`public.work_session_transition` (007), guarded by `internal.guard_work_session_status` so
*"a well-meaning future RPC cannot quietly become writer #2."*

### Two drifts worth knowing before extending this table

- **VERIFIED** `contract.ts:2903` declares
  `WorkSessionWorkdirMode = 'project' | 'worktree' | 'scratch'`, but the DB check at `001:700` is
  `in ('project','worktree')`. **`scratch` is expressible in TypeScript and rejected by Postgres.**
- **VERIFIED** `ProjectDefaults.mode` (`contract.ts:2927`) admits `'dispatcher'`; the
  `work_sessions.mode` check (`001:708`) does not.

Both are the same class of hazard the container work would add a third instance of if the
TS union and the CHECK constraint are not written in one change.

---

## 7. Resume

**SWEPT** — `execution.resume` (`packages/contract/src/catalog.ts:212`) re-attaches by reading
`work_sessions.workdir_path`, then `stat()`ing it (`SpawnService.ts:206-219`, an `isDirectory`
helper whose comment is *"is there still a directory at this path? — resume needs this before
honouring recorded path"*). If the directory is gone the session **refuses** rather than silently
downgrading to another cwd.

**This is the contract a portable environment breaks.** An absolute local path is the session's
identity across restarts. Any design that moves execution off this node has to replace it, and
"replace it with something reproducible" is precisely the argument for an image digest.

---

## 8. The gap, stated plainly

| Question | Answered today by |
|---|---|
| Which directory? | `resolveWorkdir()` at spawn, from `projects.working_dir` or a worktree path |
| Which agent binary? | `resolveAgentBinary()` scanning a composed PATH |
| Which env vars? | `composeEnv()` reading the ambient OS environment |
| Which credentials? | a per-member credential *home directory*, by path |
| Which toolchain, versions, installs, builds, caches? | **nothing — an untracked side effect of a directory** |
| Is that environment stale? | **nothing — no input is recorded, so no answer is computable** |

The last two rows are the feature. Everything above them already works.

### The recorded cost of rows 5 and 6

Drawn from this workspace's own incident notes, all of which reduce to *"the environment was not a
first-class thing anyone could name or verify"*:

- worktree `node_modules` provisioning has a bespoke recipe and must never be symlinked wholesale;
- a stale `cli`/`contract` `dist` white-screens `tm8-ui` with no error;
- worktrees under `~/.local/share/tm8/` have been swept mid-session, destroying uncommitted work;
- the agent-CLI lookup consults a hardcoded list and **ignores ambient `PATH`**, so a CI-only red
  does not reproduce on a Mac;
- `vite --port` on a busy port dies silently and `curl` then 200s **another lane's tree**;
- the dev Postgres sidecar is one shared cluster on 5442 that concurrent lanes contend for.

The last two are not workspace problems at all — they are *"the agent needed an isolated service to
test against and there wasn't one."* That is the second half of the container case, and it is
argued in the design doc.
