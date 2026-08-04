# Architecture

What tm8 is, the rules it may not break, and the vocabulary everything else uses.
**This section is FINAL** — implement against it, do not relitigate it. Amendments
are recorded in `05-DECISIONS.md` and in `../../STATE.md`.

## The numbered set — read in order

| # | Document | What it settles |
|---|---|---|
| 00 | [`00-VISION.md`](00-VISION.md) | What is being built and why it replaces Maestro |
| 01 | [`01-LAWS.md`](01-LAWS.md) | **The laws.** The single most-cited document in the repo |
| 02 | [`02-NODE-AND-GATEWAY.md`](02-NODE-AND-GATEWAY.md) | Node, workspace and gateway boundaries |
| 03 | [`03-ENTITY-GRAPH-DELTAS.md`](03-ENTITY-GRAPH-DELTAS.md) | The inherited entity model plus tm8's additions |
| 04 | [`04-EXECUTION-TRANSPLANT.md`](04-EXECUTION-TRANSPLANT.md) | Why execution is transplanted rather than rebuilt |
| 05 | [`05-DECISIONS.md`](05-DECISIONS.md) | The decision log — every ruling, with its reason |
| 06 | [`06-SEQUENCING-AND-REVIEW.md`](06-SEQUENCING-AND-REVIEW.md) | Repo shape and the review charter |
| 07 | [`07-ARCHITECTURE-REVIEW.md`](07-ARCHITECTURE-REVIEW.md) | The T-D19 gate review |
| 08 | [`08-AMENDMENT-VERIFICATION.md`](08-AMENDMENT-VERIFICATION.md) | Second review pass over the amendments |
| 09 | [`09-IMPLEMENTATION-PLAN.md`](09-IMPLEMENTATION-PLAN.md) | **The execution bible** for Phase 1 |
| 10 | [`10-SECURITY-MODEL.md`](10-SECURITY-MODEL.md) | The security model for the local node |

[`COMBINED.md`](COMBINED.md) is all eleven concatenated — one file to hand to a model
or grep in a single pass. It is generated from the above; the numbered files win.

## Alongside them

| Document | What it is |
|---|---|
| [`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md`](WORKSPACE-LAYOUT-AND-TERMINOLOGY.md) | The domain vocabulary (v2.11, FINAL). Where words like *space*, *workspace*, *project* get their meanings |
| [`WORKSPACE-LAYOUT-REVIEW.md`](WORKSPACE-LAYOUT-REVIEW.md) | The adversarial review that produced that vocabulary |
| [`DOMAIN-ARCHITECTURE-DECISIONS.md`](DOMAIN-ARCHITECTURE-DECISIONS.md) | Local domain architecture decisions, below the laws |
| [`GRAPH-NATIVE-KERNEL-VARIANT.md`](GRAPH-NATIVE-KERNEL-VARIANT.md) | "Variant G" — an alternative kernel shape, kept for the argument it records |
