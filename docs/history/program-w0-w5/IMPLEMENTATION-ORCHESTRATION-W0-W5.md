# tm8 Implementation Orchestration — W0 through W5

**Status:** user-authorized implementation program, 2026-07-26  
**Scope:** complete design closure, contract/storage foundations, API implementation and independent API testing, CLI implementation and independent CLI testing. Stop after W5. UI implementation and Remote Phase 2 are out of scope.  
**Program authority:** the user released AM-5 for W0–W5 only. The design documents remain authoritative until W0 adopts the exact amendment dossier.

## 1. Authority order

1. Shipped migrations and package source describe current implementation truth.
2. `packages/contract/src/catalog.ts` and shared schemas describe the current frozen contract.
3. `docs/architecture/00-10`, including the T-D decision log.
4. `docs/architecture/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 and `WORKSPACE-LAYOUT-REVIEW.md` through Round 12.
5. The W0-approved amendment dossier becomes the sole authority for W1–W5 changes.
6. The subordinate companions indexed by `FINAL-DESIGN-SET.md` explain domain, API, CLI, communication, harness, UI and remote boundaries.

The final independent review is `FINAL-DESIGN-SET-REVIEW.md`. Its B1/B2 blockers and required major repairs are mandatory W0 inputs, not implementation TODOs to ignore.

## 2. Model and responsibility policy

| Work | Required model/tool | Reasoning | Rule |
|---|---|---|---|
| Program and wave coordination | Codex `gpt-5.6-sol` | `xhigh` | Coordinates only with enough local work to integrate and verify. |
| Any implementation or code modification | Codex `gpt-5.6-sol` | `xhigh` | TDD: write or tighten a failing test first, implement, then run scoped and integration suites. |
| Independent API/CLI testing | Codex `gpt-5.6-terra` or Claude `claude-sonnet-5` | Terra `high`; Sonnet default | Must not be the implementation session. Tests public behavior and reports evidence to the wave coordinator. |
| Low-complexity/grunt work | `gpt-5.6-terra` or `claude-sonnet-5` | Terra `medium` unless risk warrants `high` | Mechanical inventories, fixtures, documentation sync, repetitive test expansion. No load-bearing design decisions. |
| Wave gate review | fresh Claude `claude-opus-5` | narrow review prompt | Review only: changed scope, governing invariants, diff summary and test evidence. Never implements. One concise verdict. |

Maestro team-member records persist the model but not reasoning effort. Therefore **every Sol session spawn must explicitly pass `--reasoning-effort xhigh`**, Terra test spawns pass `high`, and Terra grunt spawns pass `medium`. A coordinator must treat a spawn without the required effort as invalid and replace it.

## 3. Universal spawn packet

Every coordinator must give every spawned session:

1. the exact parent/child task ID and wave;
2. the absolute tm8 working directory and owned files/packages;
3. the governing docs and exact relevant sections;
4. implemented-versus-proposed status and the current gate dependency;
5. invariants that may not change;
6. explicit deliverables and non-goals;
7. TDD or independent-test role;
8. exact validation commands and required evidence;
9. collision boundaries with parallel workers;
10. reporting destination and the rule that workers never run git.

Workers must read the supplied references before editing. Coordinators integrate only after every group reports tests and ownership is conflict-free.

## 4. Wave protocol

For every wave:

1. Coordinator reads the root task, this plan, prior gate report and wave references.
2. Coordinator creates a child-task DAG and attaches the relevant documents.
3. Coordinator spawns package-disjoint workers in bounded parallel batches.
4. Sol code workers use TDD and return changed files, tests and risks.
5. Coordinator integrates, runs the complete wave suite and resolves cross-group failures.
6. For W3 and W5, independent Terra/Sonnet sessions test every API/CLI group from the public boundary.
7. An additional Terra/Sonnet **agentic testing gate** exercises realistic discovery-and-use journeys without internal knowledge.
8. Only after those gates pass does the coordinator spawn a fresh, limited-scope Claude Opus 5 gatekeeper.
9. All gatekeeper findings are fixed and reverified. The coordinator records APPROVE with evidence.
10. Only the full-program coordinator may start the next wave. Stop after W5.

## 5. Waves

### W0 — Design closure, adoption and amendment dossier

**Coordinator:** W0 Adoption and Dossier Coordinator.  
**Goal:** close the final Opus review, update all authoritative companions, obtain Vega adoption, log the T-D20/R17 reversal and freeze one exact amendment dossier.

Mandatory closure:

- B1: make `execution.prompt` Server-internal delivery-adapter-only; Member/Teammate callers receive `forbidden` with `details.reason='use_message_send'`; add conformance.
- B2: bound every live wake, including new top-level sends, by a durable unordered session-pair budget enforced during reservation; add the send-loop case.
- M1/M3: register `interaction_profile` across every exhaustive registry and replace raw feed predicate arrays with versioned named scope.
- Resolve DOMAIN/harness ownership, harness closure gate, ledger traceability/tense and the source-backed minor sweep from the final review.
- Produce consistency matrices rather than duplicate prose: kind × route × projection × capability × menu × migration, and operation × DTO × binding × handler × CLI × tests.

**Gate G0:** fresh Opus 5 APPROVE; Vega adoption recorded; dossier frozen; no unresolved blocker/major.

### W1 — Contract, migration and conformance foundation

**Coordinator:** W1 Contract and Storage Coordinator.  
**Parallel Sol code streams:** contract/catalog/schemas; additive migrations/RLS/locks; conformance harness/generators; identity/system-principal seams. Shared contract and migration sequence have one coordinator-owned integration order.

**Gate G1:** strict schemas build; migrations apply from empty and current supported state; RLS negatives, lock races and contract-generation tests pass; catalog accounting is exact.

### W2 — API implementation by group

**Coordinator:** W2 API Implementation Coordinator.  
Spawn one Sol xhigh implementation session per group in bounded parallel batches. Every group owns handlers, service/RPC wiring and tests for its set:

1. identity + Spaces;
2. universal entities + entity commands + tracking;
3. edges + edge-type registry + placements;
4. messages + attachments + delivery + handoffs;
5. collections + graph + undo;
6. Projects + Project projections + session associations;
7. files + bridge;
8. inbox + read marks + notifications;
9. saved views + actions;
10. events + presence + replay;
11. execution + session lifecycle + internal delivery adapter;
12. entity kinds + Interaction Profiles/defaults/pins;
13. universal feed + activity provenance + bounded focus;
14. menu/default channel and remaining dossier operations;
15. reserved search/bridge behavior and honest `not_implemented` coverage.

Each implementation session adds/updates failing tests first and runs its group suite. No group may invent a DTO or error outside the W0 dossier.

**Gate G2:** coordinator integration suite green; all implemented routes generated from the catalog; no hidden public mutation seam.

### W3 — Independent API verification and agentic API gate

**Coordinator:** W3 API Verification Coordinator.  
For every W2 group, spawn an independent Terra-high or Sonnet-5 session that tests all operations in that group through public HTTP/WS and database-observable outcomes. Testers do not trust implementation tests and do not edit production code; defects return to new Sol xhigh fix sessions.

Required cross-group testing: authorization/act-as, RLS, idempotency identity, optimistic concurrency, pagination/cursors, event ordering/replay, crash windows, wake bounds, project link/unlink races, recovery and implemented/reserved honesty.

Then spawn an independent Terra/Sonnet **agentic API gate** that starts from generated discovery and completes realistic multi-step workflows without repository-internal knowledge.

**Gate G3:** every API group reports complete pass evidence; agentic API journeys pass; fresh narrow Opus 5 APPROVE.

### W4 — CLI and harness implementation by group

**Coordinator:** W4 CLI Implementation Coordinator.  
Spawn Sol xhigh implementation sessions by CLI group:

1. global grammar, auth/context, output, errors and mutation IDs;
2. Space and identity/admin commands;
3. entity CRUD/query/context/feed and task commands;
4. edge/connection/placement grammar;
5. message/reply/attachment/delivery/handoff grammar;
6. Project/file/bridge grammar;
7. inbox/read-mark/saved-view/action grammar;
8. event/presence/watch grammar;
9. session/execution/profile grammar;
10. kind/search/help/completion and generated command discovery;
11. harness bootstrap, scoped credentials, lazy discovery and orchestration prompts.

The CLI is generated/bound from the contract wherever possible. There is no public `prompt`, `report`, `progress`, compatibility alias or second communication channel.

**Gate G4:** all CLI group/unit/integration tests pass against a real local Server; help/completion and JSON output match the contract.

### W5 — Independent CLI verification and agentic CLI gate

**Coordinator:** W5 CLI Verification Coordinator.  
For every W4 group, spawn an independent Terra-high or Sonnet-5 session. Each tester exercises commands against a real Server, including success, authorization, validation, conflict, retry/replay, cursor, mixed-batch and terminal-state behavior. Production fixes go to separate Sol xhigh sessions.

Then run an independent agentic harness gate: a fresh Terra/Sonnet agent receives only the bounded bootstrap and lazy discovery surfaces and must complete the end-to-end workflow:

`Space → Project → task → spawn → native PTY → durable message → reply → PR/commit association → task completion → transcript/restart recovery`.

**Gate G5 / program stop:** every CLI group passes, agentic discovery/use passes without hidden prompts or repository knowledge, API conformance remains green, and a fresh limited-scope Claude Opus 5 gatekeeper returns APPROVE. Record the handoff for W6, but do not start UI work.

## 6. Git and evidence discipline

- Workers and wave coordinators do not run git. Vega/authorized lead owns commits after an approved gate.
- Dirty-tree ownership is preserved; no destructive commands.
- Every group report includes owned files, tests added first, commands run, results, unresolved risks and compatibility impact.
- Every wave produces one gate document attached to its task. Opus reads the gate document, changed files and only the necessary authoritative sections.
- A passing test without public-boundary evidence does not close W3 or W5.
