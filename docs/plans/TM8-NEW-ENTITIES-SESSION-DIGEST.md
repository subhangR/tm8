# New entities (Memories / Worktrees / Artifacts) — digest of session `sess_1785384787653_t6o2uxxw8`

Recovered 2026-07-31 from maestro session records and Codex rollout transcripts.
Source of truth for this digest:

- `~/.maestro/sessions/sess_1785384787653_t6o2uxxw8/manifest.json` (launch manifest)
- `~/.maestro/data/sessions/sess_1785384787653_t6o2uxxw8.json` (11-event timeline)
- `~/.maestro/data/sessions/sess_178538491450{7_11izemwxh,7_78l2n90cm,6_hkfpgm4zl}.json`
- `~/.maestro/data/session-prompts/sp_17853853*.json` (8 inter-session handoffs, full text)
- `~/.codex/sessions/2026/07/30/rollout-2026-07-30T09-4{3-11,5-18}-*.jsonl` (full transcripts)

---

## 1. What the session actually was

Parent task `task_1785383578161_12tv3klgm` ("Memories, worktrees and artifaacts"), run as a
`gpt-5.6-sol` worker at high reasoning effort, `bypassPermissions`, cwd `/Users/subhang/Desktop/Projects/tm8`.

The ask had three parts: (a) explain the *memory* design and what is pending, (b) do the same for
*worktrees*, (c) design a **new** feature — *artifacts*, HTML+JS bundles generated and viewable
inside the app — and spawn one interactive Sol worker per feature.

The parent completed in ~3 minutes by mapping the entity substrate and spawning three children:

| Feature | Session | Child task | Status |
|---|---|---|---|
| Memories | `sess_1785384914507_11izemwxh` (`memory-design-guide`) | `task_1785384900793_ijwazouy0` | completed |
| Worktrees | `sess_1785384914507_78l2n90cm` (`worktree-design-guide`) | `task_1785384900794_6nkgkm30v` | completed |
| Artifacts | `sess_1785384914506_hkfpgm4zl` (`artifact-design-guide`) | `task_1785384900794_d3j5labey` | completed |

All three finished read-only. **Zero repository files were written by any of the four sessions**,
and no task docs or session docs were attached — the entire output exists only in the transcripts
and the eight inter-session handoff messages. Worker↔worker traffic also happened directly
(worktrees ↔ artifacts negotiated the provenance envelope without going through the parent).

## 2. Memories

Existing design docs (on disk, pre-dating the session):
`docs/plans/TM8-MEMORY-AND-STALENESS-DESIGN.md`, `TM8-MEMORY-STALENESS-API-CLI-DESIGN.md`,
`TM8-MEMORY-STALENESS-DESIGN-BRIEF.md`, `docs/plans/reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`.

**Model.** A memory is a first-class typed entity, not the legacy `team_members.memories` JSON blob.
Required shape: `statement`, `mechanism` (how it was learned), `subjectScope`, `doesNotEstablish`
(the nearby conclusion a reader must *not* infer), optional `measuredAt`. Scope rides in the typed
`EntityState`, the statement in `EntityContent`, so a value can't be copied away from its caveat.

Edges: `based_on` (version-pinned epistemic basis), `copy_of`, `supersedes`, `disputes`, `verifies`,
`remembers` (ownership), `in_worktree`, `authored_from`.

**Staleness is derived, never stored** — computed from graph facts at read time:
`superseded` → `disputed` → `basisMoved` (display precedence; payload keeps all reasons).
A stored status would itself become another stale copy. Absence of marks reads as *unflagged*,
never *verified* — otherwise an unexamined entity acquires false authority.
Asymmetry is deliberate: disputing is cheap (evidence + one edge); verification is expensive
(fresh evidence, mechanism, named answered disputes, target's current version, independent reader).

**What ships today vs. design-only.** Shipped substrate: entity envelopes/versions/snapshots,
edge registry + acyclicity + edge events, enforced edge `props_schema` (migration 018),
atomic initial connections, `copy_of` and message `authored_from`, `PullState.contentStale`
(the direct precedent for pinned-version drift), work-session launch coordinates, and the legacy
memory blob injected into the v1 prompt. Design-only: the `memory`/`worktree` kinds and tables,
all mark edges, append-only enforcement, the create/update doors, `badges.staleness`,
supersession-aware context reads, CLI groups, sweeps, and legacy-blob migration.

**Six blocking decisions before Phase 1:**
1. Split `about` (subject routing / context inclusion) from `based_on` (epistemic, version-pinned).
   One edge cannot mean both.
2. Make only *epistemic* history append-only — `disputes`, `verifies`, `supersedes`, `based_on`,
   `copy_of`. `remembers` and `in_worktree` are mutable associations and must stay correctable.
3. Restrict `verifies` evidence to entity kinds with enforceable independent-session provenance
   (initially messages and memories); files/docs/commits/PRs carry no session origin.
4. Define how eligible, non-stale memories reach a newly spawned agent. **This is the largest gap:**
   v1 manifests inject `team_members.memories`, but the v2 bootstrap *explicitly omits* memory —
   graph memories will not transfer to new agents at all until a selection/injection policy exists.
5. Rebase onto the current tree (see §5).
6. Finalize worktree lifecycle ownership (who records merge/abandon, project identity, deletion).

Implementation can stay **zero-new-catalog-operation** via generic `entities`/`edges` doors, with
four specialized doors: `create_memory`, `update_memory`, `create_worktree`, `update_worktree`.

## 3. Worktrees

The seam: tm8 already has durable launch provenance and mutable graph associations — neither is
a managed Git worktree.

```
Server-owned filesystem/Git state
        │
        ▼
ProjectResource ── projected into each Space as a project entity
        │
        └── worktree entity = durable graph identity/lifecycle
                  ├── in_worktree edges = queryable associations
                  └── work_session columns = immutable launch provenance
```

**Shipped.** Node-scoped `ProjectResource` linked M:N through `space_projects`; migration 015
materializes one Space-local project entity projection per link. `work_session.project_id`
(`launchProjectId`) is immutable launch provenance; `in_project` is the mutable M:N association.
`execution.spawn` is the only session-birth path; project + scratch cwd modes work; trust gating,
node session cap, spawn-failure retirement, PTY exit handling, and startup ghost reconciliation exist.

**Exactness corrections to stale prose.** Public `SpawnWorkdir` and the CLI expose only
`project | scratch` (`packages/contract/src/schemas.ts:1331`, `packages/cli/src/commands/session.ts:23`);
the CLI rejects `worktree` locally with exit 2 and the wire schema would reject it too. The DB enum
still *reserves* `worktree` (`db/migrations/015_w1_foundations.sql:305`). So `HOW-TO-TEST.md:392`'s
"returns 501" is **stale** — though its honesty principle (never fall back silently) still holds.
No Git worktree manager exists. Symlink-safe containment is **not shipped**: runtime cwd resolution
checks only absolute shape and `..` (`packages/execution/src/spawn/manifest.ts:170`); the S11
realpath-containment rule lives only in `docs/tm8-architecture/10-SECURITY-MODEL.md:36`.

**Do not ship unchanged:** `tm8 worktree add <path>` and unrestricted client-created worktrees
violate the server-computed-path rule.

**Pending design — server-owned allocation saga.** Validate project/trust/repo/base-ref/capacity →
`realpath`-canonicalize repo and worktree roots, reject symlink components or escapes → per-project
lock, reserve an allocation row with generated id/branch/path `<dataDir>/worktrees/<projectId>/<worktreeId>`
→ resolve base ref to a commit, `git worktree add` via **argv array, never shell interpolation** →
one DB transaction creating the active worktree entity + work session + immutable launch fields +
`in_worktree` edge → spawn PTY.

Keep two state machines separate: an **operational** allocation table
(`preparing`/`ready`/`cleanup_pending`/`missing`) describing disk health, and the **semantic** graph
lifecycle (`active → merged|abandoned → deleted`). Conflating them lets a half-created directory
masquerade as an active worktree. One write-capable session lease per physical worktree, no silent
queuing, a separate configurable worktree/disk cap. Session exit releases the lease but preserves
dirty/unmerged work. Delete refuses a live lease and dirty/unpushed state unless forced, then
`git worktree remove` + `prune`; failures stay `cleanup_pending` and retry idempotently. Startup
reconciliation cross-checks allocation rows, `git worktree list --porcelain`, filesystem, graph
entities, and live PTYs — repairing safe partials, quarantining orphans, and **never guessing** that
work was merged or abandoned.

Public spawn takes *intent*, never paths: `{mode:"worktree", baseRef?}` or an existing worktree id.
CLI/UI advertise it only after the server capability is operational.

The design review's two ship-blockers stand: the `worktrees` snapshot trigger and the
`update_worktree` patch door. Without both, merge→pin-drift silently does nothing — version
advancement is per-table opt-in, not automatic.

**Verdict: GO on the reconciled design; NO-GO on implementing the memory documents unchanged.**

## 4. Artifacts (new feature)

**Decision:** a first-class core `artifact` entity whose typed detail is the current immutable
static-web bundle revision. Rejected: a custom kind (scalar-only, no commands/triggers) and
file/zip alone (no bundle, version, provenance, or runtime policy).

**Model agnosticism is a hard invariant.** The manifest is `tm8.web-artifact/1`, runtime
`web-static-v1`, plus entrypoint and sorted `files(path, mediaType, size, sha256)`. No provider,
model, agent tool, prompt, generator, or storage URL appears in it or affects execution. A human,
any model, CI, or an import uses the identical publish API; identical bytes hash identically.
Model/tool details stay optional provenance reachable through a `work_session`. The preview runtime
exposes no model SDK or provider bridge. UI says "artifact", never "AI artifact".

**Physical model.** `artifacts` detail table; append-only `artifact_bundle_revisions`;
`artifact_bundle_entries`; internal Space-scoped `stored_blobs` shared with `file` entities after a
compatibility backfill. Manifest is JCS-canonicalized then SHA-256'd; bundle revision ≠ entity
version, but every publish gets a **non-debounced** entity version/snapshot.

**Provenance** (refined jointly with the worktree worker). Each revision stores an immutable,
versioned `sourceProvenance` snapshot — never live DTOs: `schemaVersion`, `publishedAt`, `spaceId`,
`sourceWorkSessionId`, `launchProjectId` (nullable immutable launch origin) kept **separate** from
sorted `associatedProjectIds` (because `in_project` is mutable M:N); project snapshot
`{projectResourceId, spaceProjectEntityId?, repoUrlAtPublish?, repoIdentity?}`; worktree snapshot
`{worktreeEntityId?, entityVersion?, branch?, baseRef?, baseCommitOid?, headCommitOid?, treeDigest?,
lifecycleStatusAtPublish?}`; build `{sourceCommitOid, dirty, uncommittedTreeDigest?}`.
Reproducibility rests on **resolved commit OIDs plus a dirty-tree digest, never refs alone** — refs
and project metadata move. Excluded as host-local/sensitive/non-portable: `workingDir`/`workdirPath`
and node data paths. Excluded as execution metadata, not source provenance: model, tool, profile.
Facts tm8 cannot yet supply (worktree identity/version/status, resolved OIDs) stay **explicitly
nullable rather than invented**.

**Relations.** Widen server-owned `authored_from` to artifact→work_session, `in_project` to
artifact→project projection, `attached_to` for context. Note the naming collision: the generic feed
presentation discriminator currently called `artifact` should be renamed **`entity-change`**.

**Preview / sandbox.** POST an authenticated short-lived preview session on the privileged origin,
then iframe a **separate preview service on a separate origin**. Startup must *refuse to boot* if the
two origins coincide. Sandbox is `allow-scripts` only — never `allow-same-origin`, `allow-downloads`,
`allow-forms`, `allow-popups`, or top-navigation; opaque origin; no parent message bridge in MVP.
The preview service has no API routes and no cookies; capability scoped to artifact+revision+viewer+TTL;
`no-store`/`nosniff`/`no-referrer`/`frame-ancestors app`; strict `Permissions-Policy`;
CSP `default-src 'none'` with an explicit preview origin for script/style/img bundle assets and
connect/worker/object/frame/form blocked. A **distinct hostname, not merely a port**, is mandatory once
cookie auth exists (local canonical pair: `127.0.0.1` app vs `localhost` preview). MVP accepts only
self-contained relative assets; external/bare dependencies rejected. Network, clipboard, storage, and
download are denied — the host controls export/copy. Export is a deterministic zip from the privileged
origin. Limits: ≤128 files, ≤25 MiB total default, path/MIME rules, request/concurrency/rate caps,
user-click Run.

**Lifecycle.** Batch upload grants reuse W2BlobStore path/checksum/token controls; publish is atomic
(entity + revision + blob refs + edges); updates require `expectedVersion` + `clientMutationId`;
restore creates a *new* revision; there is no mutable draft entity. Delete revokes grants immediately;
soft delete retains revisions/blobs 30 days; hard purge is reference-aware mark/sweep — the current
soft-purge job is a **stub** and must become real.

**Phase-0 release gates (prerequisites, not polish):** implement tm8's currently-deferred **S2 Host,
S3 Origin, S4 CORS, S6 CSRF** checks; never serve artifact HTML via `files.download` or the app's
static origin; no debounced artifact publish; a real GC sweep; negative RLS/capability/path/CSP/
browser-isolation tests.

**Phases.** 0 — freeze contract + security + `stored_blob` seam. 1 — vertical create/update/show/
preview/export with self-contained bundles and optional provenance. 2 — revision UI/restore, GC,
backups, import/export, bridge. 3 — deterministic dependency builder, quarantine/scanning,
process-level quotas.

**Accepted residual risk:** a browser iframe cannot give hard CPU/memory limits or perfect egress
containment against self-navigation. MVP mitigates with opaque sandboxing, CSP, separate origin/process,
quotas, and click-to-run. Hard limits require a separate renderer process/container from phase one.

**Verdict: conditional GO** — implementation-ready, but executable preview must not ship until the
Phase-0 security gates pass.

## 5. Rebase facts (verified against the working tree on 2026-07-31 — still true)

The design docs are stale in these implementation assumptions:

| Design doc says | Working tree actually |
|---|---|
| catalog frozen at 101 operations | **110** (`packages/contract/src/catalog.ts`) |
| next migration is 038 | chain reaches **050** (`db/migrations/050_entity_attention.sql`) |
| edge `props_schema` validation must be added | already shipped in **018** |
| migration 038 must bind `entities.patch` doors | actual 038 **already binds** them |
| ledger forbids derived values in responses | ledger stores *raw* results and the facade rehydrates projections after replay — derived staleness **may** appear in command responses; only persistence *inside ledger JSON* is forbidden |

Also unchanged since: no `memory`, `worktree`, or `artifact` kind exists anywhere in the contract;
no artifact or worktree design document was ever written to disk. The dirty tree additionally carries
an in-flight generic **attention-request** system (migration 050) — attention must remain workflow
prioritization only, **never staleness authority**: it is mutable, bulk-resolvable, and carries
neither pinned evidence nor independent verification.

## 6. What is pending, in one list

1. **Amend the memory design docs** with the six blocking decisions (§2) *before* any DDL — otherwise
   developers make schema-level decisions implicitly in code.
2. **Write the worktree design down.** It exists only in a transcript. Freeze the six amendments (§3).
3. **Write the artifacts design down.** Same — it exists only in a transcript and handoff messages.
4. **Memory→agent injection policy for v2 bootstrap** — the feature is incomplete without it.
5. **Phase-0 security work** (S2 Host / S3 Origin / S4 CORS / S6 CSRF, real GC sweep, S11 realpath
   containment) gates *both* artifacts preview and worktree provisioning.
6. Then build in order: storage/contracts → WorktreeManager → spawn integration → recovery/cleanup →
   CLI/UI → crash/concurrency/security tests.
