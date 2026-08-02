# UI

The specification for the tm8 web UI, the audit of what actually exists, and the
program that built it. The live package is `packages/tm8-ui`.

| Document | What it is |
|---|---|
| [`UI-SPEC-FINAL.md`](UI-SPEC-FINAL.md) | **The buildable specification.** Independent architecture review plus the spec it produced |
| [`UI-IMPLEMENTATION-PLAN.md`](UI-IMPLEMENTATION-PLAN.md) | The implementation plan against that spec |
| [`WORKSPACE-LOAD-PERFORMANCE.md`](WORKSPACE-LOAD-PERFORMANCE.md) | Workspace load time — measurement and plan |

## [`audit/`](audit/) — what exists versus what was designed

The gap audit and its research. [`audit/UI-GAP-AUDIT.md`](audit/UI-GAP-AUDIT.md) is
the summary; `audit/_research/` holds the four exhaustive passes behind it
(inventory, contract-op matrix, old-Maestro benchmark, design-intent baseline).

Also here: the transplant specs and wave records
(`PIXEL-TRANSPLANT-SPEC.md`, `WORKSPACE-TRANSPLANT-PLAN.md`,
`TERMINAL-TRANSPLANT-NOTES.md`, `WAVE-*.md`, `LANE-B-POST-DELIVERY-NOTES.md`)
and the image evidence in `audit/reference/`, `audit/artifacts/`,
`audit/output/` and `audit/verification/`.

## [`orchestration/`](orchestration/) — how it was built

The program charter, the coordinator and worker briefs, the surface-coverage
audits, and the graph-view design track. Start with
[`orchestration/CHARTER.md`](orchestration/CHARTER.md).

## Two packages, and only one of them is the product

- `packages/tm8-ui` — **the product.**
- `packages/ui` — the transplanted Collab V2 module. It is still consulted as an
  oracle for parity, but it is not what ships. A whole feature has been built into
  the wrong one before; check which package you are in before you start.

## Note on verification

No vitest test in this repo can catch a layout defect. Pixel claims need a real
browser against real markup — see the harnesses in `packages/tm8-ui/e2e/`.
