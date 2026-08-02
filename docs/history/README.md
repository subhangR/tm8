# History

Closed programs and inherited design. **Record, not law.** Nothing in this section
governs current work — but a surprising amount of current behaviour is only
explained here.

## [`program-w0-w5/`](program-w0-w5/) — the Phase 1 delivery program

Waves W0 through W5, closed. Roughly 7,000 lines of ledger.

**Enter through [`PROGRAM-CLOSE.md`](program-w0-w5/PROGRAM-CLOSE.md)** — it exists
because the ledgers are chronological and unusable as a starting point. It points
at the rest; it restates none of it.

| Document | What it is |
|---|---|
| [`PROGRAM-CLOSE.md`](program-w0-w5/PROGRAM-CLOSE.md) | **START HERE.** The entry point |
| [`W0-W5-HANDOFF-STATE.md`](program-w0-w5/W0-W5-HANDOFF-STATE.md) | Program law, amendments M-1…M-5, every ruling and finding |
| [`W0-AMENDMENT-DOSSIER.md`](program-w0-w5/W0-AMENDMENT-DOSSIER.md) · [`W0-CONSISTENCY-MATRICES.md`](program-w0-w5/W0-CONSISTENCY-MATRICES.md) | The governing authority for the program |
| [`W0-GATE-REPORT.md`](program-w0-w5/W0-GATE-REPORT.md) · [`W0-G0.1-AMENDMENT-REPORT.md`](program-w0-w5/W0-G0.1-AMENDMENT-REPORT.md) | W0 gates |
| [`W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md`](program-w0-w5/W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md) | W1 evidence |
| [`W2-DECOMPOSITION.md`](program-w0-w5/W2-DECOMPOSITION.md) · [`W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md`](program-w0-w5/W2-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md) · [`W2-SEC1-STAGE2-ENUMERATION.md`](program-w0-w5/W2-SEC1-STAGE2-ENUMERATION.md) | W2, including the replay resource-binding enumeration cited by migration `036` |
| [`W3-PUBLIC-AND-AGENTIC-EVIDENCE.md`](program-w0-w5/W3-PUBLIC-AND-AGENTIC-EVIDENCE.md) | Independent API verification, the §4 acceptance matrix |
| [`W4-CLI-IMPLEMENTATION-EVIDENCE.md`](program-w0-w5/W4-CLI-IMPLEMENTATION-EVIDENCE.md) · [`W4-CLI-HANDOFF.md`](program-w0-w5/W4-CLI-HANDOFF.md) | CLI and harness evidence, and the terminal handoff |
| [`W5-COORDINATOR-STANDING-ORDERS.md`](program-w0-w5/W5-COORDINATOR-STANDING-ORDERS.md) · [`W5-DUO-STRUCTURE.md`](program-w0-w5/W5-DUO-STRUCTURE.md) | W5 — which was cancelled |
| [`IMPLEMENTATION-ORCHESTRATION-W0-W5.md`](program-w0-w5/IMPLEMENTATION-ORCHESTRATION-W0-W5.md) | How the waves were sequenced |
| [`FINAL-DESIGN-SET.md`](program-w0-w5/FINAL-DESIGN-SET.md) · [`FINAL-DESIGN-SET-REVIEW.md`](program-w0-w5/FINAL-DESIGN-SET-REVIEW.md) | The design set and its independent review |

**The warning the program left about itself:** every coordinator figure that was
challenged fell, to workers who opened a file. These documents carry numbers that
were true when written and were never re-derived. Treat any count in them as a
prompt to go measure, not as a fact.

## [`collab-v2/`](collab-v2/) — the inherited design

Maestro's Collab V2. tm8 is a rebuild of it, and `packages/contract` §1 is a
near-verbatim transcription of its UI contract — so this is provenance, not dead
weight.

| Path | What it is |
|---|---|
| [`ENTITY-GRAPH-DESIGN.md`](collab-v2/ENTITY-GRAPH-DESIGN.md) | The Collab V2 entity graph |
| [`UI-DATA-CONTRACT.md`](collab-v2/UI-DATA-CONTRACT.md) | The UI data contract that `packages/contract` was transcribed from |
| [`GAPS-AND-EXTENSIONS.md`](collab-v2/GAPS-AND-EXTENSIONS.md) | Gaps, non-goals, extension backlog |
| [`api-design/`](collab-v2/api-design/) | The API layer design — [`00-OVERVIEW`](collab-v2/api-design/00-OVERVIEW.md), [`01-DATA-MODEL`](collab-v2/api-design/01-DATA-MODEL.md), [`02-API-ARCHITECTURE`](collab-v2/api-design/02-API-ARCHITECTURE.md), [`03-CONSUMER-SURFACES`](collab-v2/api-design/03-CONSUMER-SURFACES.md), [`04-COMMUNICATION-MODEL`](collab-v2/api-design/04-COMMUNICATION-MODEL.md), [`05-COHERENCE-MATRIX`](collab-v2/api-design/05-COHERENCE-MATRIX.md) |
| [`ui-plan/`](collab-v2/ui-plan/) | [`01-IMPLEMENTATION-PLAN`](collab-v2/ui-plan/01-IMPLEMENTATION-PLAN.md), [`02-ORCHESTRATION-PLAN`](collab-v2/ui-plan/02-ORCHESTRATION-PLAN.md), and the [UX brief](collab-v2/ui-plan/COLLAB_V2_UI_UX_BRIEF.md) |
| [`ui-snapshot/`](collab-v2/ui-snapshot/) | Vendored source snapshots — the contract and facade the transplant was measured against |
| [`crib-supabase/`](collab-v2/crib-supabase/) | The original Supabase migrations, kept for reference only. **Not tm8's migration history** |

`packages/ui` is the live transplant of this module. It is still consulted as a
parity oracle even though `packages/tm8-ui` is what ships.
