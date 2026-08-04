# BRIEF — Worktrees: complete the design and implementation plan

You own **one** feature: first-class **worktree** entities plus the server-managed Git worktree
lifecycle in tm8. Two sibling workers own memories and artifacts; you will need to talk to them
(see §7).

## 0. Provenance of this brief — read this first

Everything in §3–§5 was **recovered from a prior session's transcript**, not from an approved
document. On 2026-07-30, session `sess_1785384914507_78l2n90cm` reconciled the shipped runtime
against the worktree design and reported its conclusions as chat messages. It **wrote nothing to
disk** — unlike memories, **there is no worktree design document in this repository at all**. Its
conclusions were recovered on 2026-07-31 into `docs/features/foundation/NEW-ENTITIES-SESSION-DIGEST.md` §3.

Treat §3–§5 as **a strong prior from a competent reader, not as settled fact**. The user has not
ratified it. Where it conflicts with the current tree, **the tree wins** — and say so. Where you
think it is wrong, say that too.

Note the prior session's own verdict, which frames your job:
**GO on the reconciled design; NO-GO on implementing the memory documents unchanged.** The
worktree material inside the memory design docs is the part it refused to sign off literally.

## 1. Your mission

Produce a **complete design and a phased implementation plan** for worktrees: the graph entity,
the server-owned Git lifecycle, the spawn integration, and recovery. You are writing the document
that does not yet exist.

You are **design-only**. Do not modify product source, do not run migrations, do not create Git
worktrees, do not commit. The working tree is dirty with other people's in-flight work — leave it
alone. Writing your own new documents under `docs/features/worktrees/` is expected and fine.

## 2. Read before you write

- `docs/features/foundation/NEW-ENTITIES-SESSION-DIGEST.md` — §3 and §5 are yours
- `docs/features/memory/MEMORY-AND-STALENESS-DESIGN.md` — around line 353, the proposed worktree entity
- `docs/features/memory/MEMORY-STALENESS-DESIGN-REVIEW.md` — around line 166, the two ship-blockers
- `docs/architecture/10-SECURITY-MODEL.md` — the S11 realpath-containment rule, around line 36
- `docs/architecture/04-EXECUTION-TRANSPLANT.md`
- `HOW-TO-TEST.md` around line 392 — **known stale**, see §3

Current tree, to verify against:

- `db/migrations/015_w1_foundations.sql` — `space_projects` around line 58, the project entity
  projection, `workdir_mode` enum around line 305, `in_project` around line 495
- `packages/contract/src/contract.ts` around line 1059 — `launchProjectId`
- `packages/contract/src/schemas.ts` around line 1329 — `SpawnWorkdir`
- `packages/cli/src/commands/session.ts` around line 23 — the local worktree rejection
- `packages/execution/src/spawn/manifest.ts` around line 170 — current cwd validation
- `packages/execution/src/spawn/SpawnService.ts`

Line numbers are from 2026-07-30 and the tree is dirty. **Treat them as hints, not addresses.**

## 3. What is shipped — and the corrections to stale prose

The seam: tm8 already has durable launch provenance and mutable graph associations. **Neither is a
managed Git worktree.**

```
Server-owned filesystem/Git state
        |
        v
ProjectResource -- projected into each Space as a project entity
        |
        +-- worktree entity = durable graph identity/lifecycle
                  |-- in_worktree edges = queryable associations
                  +-- work_session columns = immutable launch provenance
```

Shipped: node-scoped `ProjectResource` rows linked M:N to Spaces through `space_projects`, where
migration 015 materializes one Space-local project entity projection per link — this lets ordinary
graph edges point at a project without turning a filesystem resource into an entity.
`work_session.project_id`, exposed as `launchProjectId`, is **immutable launch provenance**, while
`in_project` is the independent **mutable M:N association** for sessions, tasks, PRs, and commits.
Keeping those two distinct is load-bearing for you and for the artifacts worker.
`execution.spawn` is the only session-creation path; project and server-managed scratch cwd modes
work; trust confirmation, the node session cap, spawn-failure retirement, PTY exit handling, and
startup ghost reconciliation all exist.

**Two stale claims to correct in whatever you write:**

- Public `SpawnWorkdir` and the CLI expose only `project | scratch`. The CLI rejects `worktree`
  locally with exit 2, and the wire schema would reject it if sent directly. The **database enum
  still reserves** `worktree`. So `HOW-TO-TEST.md` saying it returns HTTP 501 is **stale prose** —
  though the honesty principle behind it (never fall back silently) still holds and should survive
  into your design.
- **No Git worktree manager exists.** Symlink-safe containment is **not shipped**: runtime cwd
  resolution checks only absolute-path shape and `..`. The stronger realpath-containment rule (S11)
  lives only in the security design document.

## 4. What was designed, and the one part that must not ship

Designed in the memory/staleness docs: a Space-scoped first-class `worktree` entity with `path`,
`branch`, `base_ref`, `project_id`, and a forward lifecycle `active -> merged|abandoned -> deleted`;
`in_worktree` edges from sessions, tasks, PRs and commits; `work_session.workdir_*` as launch
provenance with associations living in edges; a **snapshot trigger on `worktrees`** so every
lifecycle transition advances `entities.version`; consequently a memory pinned with
`based_on.props.pinnedVersion` becomes `basisMoved` the moment a merge or abandon lands; optimistic
lifecycle writes through `entities.patch(expectedVersion)`; and CLI listing/transition sugar.

The independent review added two **ship-blockers**: the per-table snapshot trigger and an
`update_worktree` patch door. Without either, merge-to-pin-drift silently does nothing.
Version advancement is per-table opt-in — it is not automatic for every entity detail table.

**Do not ship unchanged:** `tm8 worktree add <path>` and unrestricted generic client-created
worktrees. A raw client-supplied path violates the server-computed-path rule and S11.

## 5. The pending execution design

Offered as a starting point; improve it, and pressure-test it.

**Provisioning as a server-owned saga.** Validate the linked Project, trust consent, Git
repository, requested base ref, and capacity. Canonicalize the repository and node worktree roots
with `realpath`; reject symlink components and escapes. Acquire a per-project lock and reserve an
operation record with a generated worktree id, branch, and computed path such as
`<dataDir>/worktrees/<projectId>/<worktreeId>`. Resolve the base ref to a commit and invoke
`git worktree add` **via an argv array, never shell interpolation**. In one database transaction,
create the active worktree entity, the work session, the immutable launch fields, and the
`in_worktree` edge. Then spawn the PTY and transition the session normally.

**Two state machines, kept apart.** An operational allocation table tracks `preparing`, `ready`,
`cleanup_pending`, `missing`, and failure detail — this describes **disk health**. The graph
entity's `active/merged/abandoned/deleted` describes **semantic lifecycle**. Conflating them lets
a half-created directory masquerade as an active worktree, which is exactly the class of lie this
design exists to prevent.

**Concurrency and cleanup.** One write-capable live-session lease per physical worktree by
default. Per-project serialization for Git administrative operations. Unique computed paths and
branches, with **no silent queuing**. The existing node session cap stays, plus a separate
configurable worktree/disk cap. Session exit releases the lease but **preserves dirty or unmerged
work**. Merge, abandon and delete go through a single server-owned transition path, analogous to
the guarded work-session status writer. Delete refuses a live lease and refuses dirty or unpushed
state unless explicitly forced, then uses `git worktree remove` and `git worktree prune`. Cleanup
failures stay `cleanup_pending` and retry idempotently.

**Startup reconciliation** compares allocation records, `git worktree list --porcelain`, filesystem
entries, graph entities, and live PTYs. It repairs safe partial states and quarantines orphans —
and it **never guesses** that work was merged or abandoned. Absence of evidence is not a merge.

**Public surface.** Spawn accepts **intent, never paths**: `{mode:"worktree", baseRef?}` for a new
allocation, or an existing worktree id for reuse. CLI and UI advertise this only after the server
capability actually works. The UI then gains Project / Scratch / Isolated worktree choices, a
resolved base commit, an existing-active chooser, lease/dirty/cleanup health, and explicit
destructive confirmations. CLI transition sugar can keep the zero-new-operation shape by routing
through the specialized `entities.patch` worktree door — provided that door owns the Git checks
and side effects rather than the client.

The prior session's six amendments, which it wanted frozen before a GO:

1. Worktrees are created only through `execution.spawn`; reject generic client-created worktrees
   and remove `tm8 worktree add <path>`.
2. Clients supply intent — project, base ref, or existing worktree id — never a filesystem path.
3. Add a server-owned allocation/lease table for provisioning, cleanup, missing-path recovery, and
   exclusive session ownership.
4. Lifecycle transitions are server-owned and single-writer.
5. Require realpath/symlink containment, per-project Git locking, idempotent cleanup, and
   dirty/unpushed protection.
6. Wire the `worktrees` snapshot trigger and the `update_worktree` door so lifecycle changes
   genuinely bump versions and trigger pin drift.

Implementation order it proposed: storage/contracts, then WorktreeManager, then spawn integration,
then recovery/cleanup, then CLI/UI, then crash/concurrency/security tests.

## 6. Rebase facts — verify these yourself

Verified against the working tree on 2026-07-31. **Re-verify; do not trust blindly.**

- The catalog declares **110** operations, not the 101 the older docs assume.
- The migration chain reaches **050**. The design's proposed migration 038 is long taken, and the
  actual 038 already binds the existing `entities.patch` doors.
- Edge `props_schema` validation already shipped in migration **018**.
- No `memory`, `worktree`, or `artifact` kind exists anywhere in the contract today.
- The dirty tree carries an in-flight attention-request system (migration 050). Do not treat it as
  shipped.

## 7. Coordination

Siblings, spawned with you:

- **memories** worker — memories pin worktrees via `based_on`, and your lifecycle transitions are
  what make those pins drift. Worktree lifecycle ownership is a **jointly owned** decision. Agree
  on the worktree entity shape and on who writes transitions before either of you freezes a schema.
- **artifacts** worker — you already sent them a provenance envelope in the prior session and they
  adopted it. The load-bearing points: snapshot an immutable versioned `sourceProvenance` object,
  never a live DTO; keep `launchProjectId` (nullable, immutable launch origin) **separate** from
  sorted `associatedProjectIds`, because `in_project` is mutable M:N; reproducibility rests on
  **resolved commit OIDs and a dirty-tree digest, never refs alone**; exclude `workingDir` and node
  data paths as host-local and non-portable; keep facts tm8 cannot yet supply **explicitly nullable
  rather than invented**. Make sure their design and yours agree on field names and semantics.

Use `maestro session siblings` to find them and `maestro session prompt <id> --message "..."` to
talk. **Prose sent that way gets mangled by the shell**: backticks execute, and an apostrophe
truncates the message and runs the remainder as commands. The CLI prints a success checkmark
either way. Avoid backticks and apostrophes in messages entirely, or write to a file and send the
path.

## 8. Deliverable

Write to `docs/features/worktrees/WORKTREE-DESIGN.md` — this document does not exist yet and is the main
artifact of your task. It must contain:

1. The shipped/designed/pending three-layer map, with the stale-prose corrections called out.
2. The worktree entity: fields, lifecycle, snapshot trigger, patch door, edge registry entries.
3. The operational allocation/lease model, kept explicitly distinct from semantic lifecycle.
4. The provisioning saga, step by step, including every validation and the failure behavior of each.
5. Concurrency, leases, caps, cleanup, and startup reconciliation rules.
6. The public spawn/CLI/UI surface, and the capability-advertisement rule.
7. Security: S11 realpath containment, argv-only Git invocation, per-project locking, trust gating.
8. A phased implementation plan with gates and a test matrix, including crash and concurrency tests.
9. An honest **open questions / residual risk** section — in particular, who observes a Git merge.
   The server cannot detect one automatically; something must record the transition. Say what.

Report milestones with `maestro task report progress <taskId> "..."` and finish with
`maestro task report complete <taskId> "..."`.
