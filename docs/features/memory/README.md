# Entity memory and staleness

Memory attached to entities, and the machinery that notices when it has gone stale.

| Document | What it is |
|---|---|
| [`MEMORY-DESIGN-FINAL.md`](MEMORY-DESIGN-FINAL.md) | **The resolved design and the implementation plan.** Read this one |
| [`MEMORY-AND-STALENESS-DESIGN.md`](MEMORY-AND-STALENESS-DESIGN.md) | The earlier W6 design it resolves — kept for the reasoning |
| [`MEMORY-STALENESS-API-CLI-DESIGN.md`](MEMORY-STALENESS-API-CLI-DESIGN.md) | The API and CLI surface |
| [`MEMORY-STALENESS-DESIGN-REVIEW.md`](MEMORY-STALENESS-DESIGN-REVIEW.md) | Design review of the data model and API/CLI, verified against the tree |
| [`MEMORY-STALENESS-DESIGN-BRIEF.md`](MEMORY-STALENESS-DESIGN-BRIEF.md) | The context-engineering brief behind it all |
| [`BRIEF-MEMORIES.md`](BRIEF-MEMORIES.md) | The lane brief — what this worker was asked to produce |

`MEMORY-DESIGN-FINAL.md` supersedes `MEMORY-AND-STALENESS-DESIGN.md` where they
disagree.

## Shared seam

This lane shares a foundation with worktrees and artifacts. The purge-exemption
rule that migration `056` implements is specified in
[`../foundation/FOUNDATION-VERIFICATION.md`](../foundation/FOUNDATION-VERIFICATION.md),
not here.
