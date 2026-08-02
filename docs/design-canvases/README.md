# Design canvases

Frozen exports from the design tool, plus the upload bundles that were handed to it.
**Read-only.** Nothing here is edited in place — a new round is a new directory.

| Round | Directory | Exported |
|---|---|---|
| 1 | [`2026-07-27-round-1/`](2026-07-27-round-1/) | 2026-07-27 |
| 2 | [`2026-07-28-round-2/`](2026-07-28-round-2/) | 2026-07-28 |

These were previously two sibling directories at the repo root named
`T0-1 workspace structure review` and `T0-1 workspace structure review (1)`, which
gave no way to tell which was current.

## How the two rounds differ

Round 2 is very nearly a superset of round 1. The exceptions, which is why both are
kept:

- `DESIGN-REQUESTS-ROUND-2.md` exists **only in round 1** (it is the request that
  produced round 2, despite the name).
- Round 2 adds six canvases: `T3-3 Account Menu`, `T5-1 Home Dashboard`,
  `T5-2 Board Feed Gallery Layouts`, `T5-3 Doc Authoring`,
  `T5-5 T5-6 Launch & Authoring Flows`, `T5-7 Discussion Tab Body`.
- `uploads/tm8-ui-design/05-DESIGN-SYSTEM/tokens.css` **differs between the two
  rounds** and has never been reconciled. If you are pulling tokens from here,
  check which round you are reading.

## The uploads are copies, and they have drifted

`uploads/tm8-ui-design/07-CURRENT-CODE/` and `08-SPECS/` are point-in-time copies of
repo source and specs, taken so the design tool had self-contained context. They
were accurate on their export date and have not been updated since.

**Never treat a file under `uploads/` as current.** The live copies are in
`packages/tm8-ui/` and under [`../ui/`](../ui/) and [`../architecture/`](../architecture/).
Relative links inside the `08-SPECS/` copies were already broken at export time —
the flattening dropped the `_research/` directory they point at.
