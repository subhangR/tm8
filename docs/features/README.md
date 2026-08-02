# Features

One directory per feature. Each holds its design, its brief, and any review or
verification specific to it.

| Feature | Directory | Entry point |
|---|---|---|
| Foundation | [`foundation/`](foundation/) | [`FOUNDATION-VERIFICATION.md`](foundation/FOUNDATION-VERIFICATION.md) |
| Entity memory | [`memory/`](memory/) | [`MEMORY-DESIGN-FINAL.md`](memory/MEMORY-DESIGN-FINAL.md) |
| Worktrees | [`worktrees/`](worktrees/) | [`WORKTREE-DESIGN.md`](worktrees/WORKTREE-DESIGN.md) |
| Artifacts | [`artifacts/`](artifacts/) | [`ARTIFACTS-DESIGN.md`](artifacts/ARTIFACTS-DESIGN.md) |
| Derived edges | [`graph/`](graph/) | [`README.md`](graph/README.md) |
| Voice channels | [`voice/`](voice/) | [`VOICE-CHANNELS-PLAN.md`](voice/VOICE-CHANNELS-PLAN.md) |
| Session resume | [`resume/`](resume/) | [`SESSION-RESUME-PLAN.md`](resume/SESSION-RESUME-PLAN.md) |
| Shared workspace | [`shared-workspace/`](shared-workspace/) | [`SHARED-WORKSPACE-DESIGN.md`](shared-workspace/SHARED-WORKSPACE-DESIGN.md) |

Most feature directories also carry the lane brief they were built from:
[`worktrees/BRIEF-WORKTREES.md`](worktrees/BRIEF-WORKTREES.md),
[`artifacts/BRIEF-ARTIFACTS.md`](artifacts/BRIEF-ARTIFACTS.md),
[`memory/BRIEF-MEMORIES.md`](memory/BRIEF-MEMORIES.md) — a record of what was asked
for, not of what shipped.

## [`foundation/`](foundation/) — read this before the other three

Memory, worktrees and artifacts were built as three lanes over **one shared seam**.
`foundation/` is that seam.

- [`FOUNDATION-VERIFICATION.md`](foundation/FOUNDATION-VERIFICATION.md) — the seven
  cross-cutting claims, verified against a live DB. **Load-bearing:** migrations
  `055`/`056` and the DB tests cite its V4 purge-exemption rule by name.
- [`BRIEF-FOUNDATION.md`](foundation/BRIEF-FOUNDATION.md) — the brief that scoped it.
- [`BUILD-ORDER-AND-OWNERSHIP.md`](foundation/BUILD-ORDER-AND-OWNERSHIP.md) — file
  ownership across the three lanes, so they did not clobber each other.
- [`NEW-ENTITIES-SESSION-DIGEST.md`](foundation/NEW-ENTITIES-SESSION-DIGEST.md) — digest
  of the session that designed all three.
- [`MEMO-MEMORY-SEAM-QUESTIONS.md`](foundation/MEMO-MEMORY-SEAM-QUESTIONS.md) and
  [`MEMO-WORKTREE-SEAM-ANSWERS.md`](foundation/MEMO-WORKTREE-SEAM-ANSWERS.md) — the
  cross-lane exchange that settled the shared questions. Read as a pair.

## Where the runbooks are

Design lives here; *operating* it lives in [`../ops/`](../ops/). Voice is split
that way on purpose: the plan is in `voice/`, and how to actually get two tabs
talking is [`../ops/VOICE-CHANNELS.md`](../ops/VOICE-CHANNELS.md).

## Status is not recorded here

These are designs and plans. Whether a feature is shipped, half-shipped or
uncommitted is not something a design document can tell you — check the tree.
