# Derived task workStatus from git facts — design (no code)

Tier 4 git×graph, item 5. Design only; nothing here ships behavior.

## Problem

`tasks.work_status` is hand-maintained. The graph now holds git facts that
often contradict it: a task whose tracked PR merged an hour ago still says
`working`; a task whose lane's worktree was abandoned still says `in_review`.
Humans reconcile this by reading three surfaces. The machine should.

## Position: PROJECT, never mutate

The derived status must be a **read-time projection**, not a write-back into
`tasks.work_status`. Three reasons:

1. **`work_status` is a command surface.** `set_work_state` and `complete_task`
   are ledgered, version-guarded, activity-recorded semantic commands. A
   background writer flipping `work_status` would bypass the ledger (or spam
   it), fight the version guard, and turn every user correction into a race
   against the reconciler.
2. **Facts can be stale or wrong.** PR state arrives via a polling observer
   (078); worktree status via reconciliation. Deriving is reversible —
   a wrong projection heals on the next read. A wrong write is a mutation
   someone must notice and undo.
3. **The precedent is already in the codebase.** `currently working` badges are
   derived at read time from `working_on` edges, not stored. Derived truth
   lives in projections; stored truth answers "what did someone decide".

## The projection

A `derivedWorkStatus` field on the task read projection (entity context /
collections), computed from, in priority order:

| Signal | Source | Derived hint |
|---|---|---|
| all tracked PRs merged | `tracks` → `pull_requests.state` | `done?` (suggest complete; never auto-complete) |
| any tracked PR open + CI failing | `pull_requests.ci_status` | `blocked?` |
| any tracked PR open, CI passing/unknown | `pull_requests.state` | `in_review?` |
| session in worktree with commits ahead | `in_worktree` + `created_in` commit edges | `working?` |
| worktree abandoned/deleted, task not done | `worktrees.status` | `stalled?` |
| no git facts at all | — | no hint (projection absent) |

The `?` is the point: the projection is a **hint**, shaped as
`{ suggested: WorkStatus, reason: string, factSeq: number }`, sitting NEXT to
the stored `workStatus`, never replacing it. `factSeq` is the ledger seq of
the newest git event considered, so a client can tell a fresh hint from a
stale one — and `tm8 event watch` on `git.pr_state_changed` (082) is the
invalidation signal.

## Delivery mechanics (when implemented)

- Compute in the facade task-read service (SQL join over `tracks` /
  `in_worktree` / facts tables — all indexed by entity_id), no new tables, no
  jobs. Cost is per-read and bounded by linked-artifact counts (small).
- Surface in `tm8 task get` / entity context as `derivedWorkStatus`, and as a
  soft badge in the UI ("PR merged — complete?").
- The only *action* ever taken from the projection is a **notification**
  (attention request on the task when `done?` persists across N reads), never
  a status write. Completion still goes through `complete_task`, where the 082
  gate can verify the same facts transactionally.

## Rejected alternatives

- **Trigger-driven write-back** (PR merge event flips `work_status`):
  rejected per "Position" above; also the 082 gate would then be checking a
  status its own producer wrote — circular.
- **A second stored column** (`derived_status` maintained by a job): stale
  between ticks, doubles the invariants, and still needs the read-time join
  to explain *why*. Storage buys nothing the join doesn't give.
- **Auto-complete on merge**: violates the acceptance-criteria and completer
  semantics of `complete_task` (who is the completer? are criteria done?).
  The gate direction (refuse until merged) is safe; the reverse is not.
