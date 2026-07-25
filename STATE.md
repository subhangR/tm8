# tm8 STATE

**Updated:** 2026-07-25 (W0 in progress)
**CTO/coordinator:** Vega (sess_1784943069601_y42xw5b9m). Only Vega commits.
**Maestro project:** proj_1784943131214_fkap03n0m (workingDir: this repo).
**Execution bible:** docs/tm8-architecture/09-IMPLEMENTATION-PLAN.md. Architecture FINAL (00-08). Do not relitigate.

## Amendments (user-directed, override the docs)

- **AM-1 (2026-07-25): No Tauri. tm8 is server + web only.**
  - `apps/desktop` does not exist and will not be built. `packages/ui` is a browser app; Vite dev on 4611; production bundle served by tm8-server (4610).
  - The ONLY spawn path is the server-side PTY host (old maestro's `MAESTRO_PTY_HOST=server` mode becomes the primary path, not a variant). The `session:spawn` payload shape (session, command, cwd, envVars, manifest path, ids, provenance) is preserved verbatim on the server path (R29).
  - Terminals: xterm in browser — WebGL renderer on Chromium with DOM fallback; NO WebGL/Canvas addon assumptions beyond that; unmount terminals of exited sessions; bounded log-strip memory. Terminal perf parity with old maestro is the regression bar (G3).
  - M2/M3 items mentioning Tauri/apps/desktop are re-scoped to: web boot flow (browser → tm8-server auth auto-owner → workspace UI) and server-side spawn plumbing.
  - AM-1 is now canonical in the master corpus as **T-D21** (05-DECISIONS.md) + status amendment on 09; both re-vendored here 2026-07-25. Draco's persona updated design-side (lift scope = PTY host + terminal components only).
  - Design-session nuances to carry: (a) the G3 perf-parity bar is measured against old maestro's **desktop** terminal on the same machine — web-only rendering inherits old maestro's WebGL-on-Chromium web path, so parity is achievable but must be **measured explicitly, never assumed** (Polaris owns the measurement at W5); (b) with "install the app" gone, the **one-command start story** (tm8-server starts sidecar PG, serves/points to UI; `bun run dev` for dev + a single launcher for prod) is a W0/W1 deliverable — startup UX is part of the definition of done, owned by Altair's sidecar/ops workstream at W1.

- **AM-2 (2026-07-25, user-sanctioned implementation review — CONDITIONAL GO adopted).** An independent review (sess_1784945489792_14ws8ejrk) was accepted by the user. Adopted into the plan:
  - **P0 contract amendments — must land BEFORE migrations/events freeze (W1a, blocks W1b):**
    1. **Projects first-class:** `project` resource (repoUrl, workingDir, trust level), `space_projects` many-to-many, `projects.*` operation family, working-dir/worktree semantics; `execution.spawn` takes a real projectId, not an untyped ref.
    2. **Blob I/O:** `files.*` lifecycle (initiate/complete/abort upload, authorized download), checksums, size/MIME limits, GC policy, blobs included in backup/export; bridge fetch-blob shape reserved for Phase 2.
    3. **WorkspaceEvent envelope:** every event carries `{spaceId, seq (per-space monotonic), occurredAt, schemaVersion, clientMutationId? (on all mutation-derived events)}` — no bare-entity-id variants on the multiplexed socket.
    4. **Security model:** new `docs/tm8-architecture/10-SECURITY-MODEL.md` — loopback-only default bind; non-loopback requires token auth; WS Origin checks; CSRF/CORS posture; DNS-rebinding defense (Host allowlist); path-traversal/symlink guards (blobs, worktrees); secret redaction in manifests/transcripts/logs/backups; agent-governance minimums (session concurrency cap, terminate-as-cancellation, audit via command_ledger; budgets later).
    5. **Doc contradictions:** master-corpus rewrite requested from the design session (04/06/09 normative Tauri text → rewritten per T-D21; 08 FAIL conclusion → clean passing verification appended); re-vendor after.
  - **Sequencing restructure — Phase 1A vertical slice before platform completeness:**
    - **1A (prove the loop):** space + project link · task/doc/team_member/skill · spawn one server PTY · execution.prompt delivery · progress report-back · PR/commit link · completion + transcript · restart/recovery · security + terminal-perf acceptance. A minimal dev terminal page (a rig, NOT product UI) hosts xterm for the slice.
    - **1B (platform completeness):** channels/inbox/collections/custom kinds/points, full op catalog green (G1), Atlas UI transplant (G2, T-D18 timing unchanged), **basic Postgres FTS behind search.query (un-reserved in 1B)**, minimal old-maestro import (tasks/docs). Deferred within Phase 1: leaderboard polish, custom-kind UX polish, saved-views/axes UI (schema keeps them all).
  - **Revised wave map:** W1a Rigel contract amendments + conformance updates → contract freeze · W1b Cygnus migrations + Lyra identity + Castor sidecar/scheduler (gate: apply-clean + RLS negative + identity tests) · W2 facade slice + events/WS (gate G1A-server: 1A ops conformance-green) · W2.5 execution vertical pulled forward (PTY lift, minimal SpawnService, prompt delivery, CLI compat core) → **gate G1A = Phase 1A acceptance (the loop works)** · then W3+ for 1B: full conformance green (G1), UI transplant (G2), full execution parity + golden workflows (G3).
  - **Session-limit ops rule:** ≤3 concurrent worker sessions fleet-wide; leads do not fan out wider without Vega approval.

- **AM-3 (2026-07-25, user decision): Gate G1A includes the NEW UI, wired.** The first gate is now: in the browser, on the Collab V2 UI, open a space → see tasks → run a task → `execution.spawn` creates a work_session with a composed manifest → terminal panel streams the live server PTY → progress lands in the task thread → completion produces a transcript. Everything else (1B platform completeness, remaining screens, golden workflows) proceeds only after G1A passes.
  - Mechanism: an **early snapshot** of Atlas's collab-v2 module — taken from **committed, gate-verified state only** (never their working tree; their build stays untouched) — transplants into `packages/ui` at W2 kickoff (latest possible moment before wiring, to capture the most finished waves). A minimal vite host (port 4611; prod served by tm8-server) + `RealFacade` over the slice ops + work_session panel hosting the lifted terminal component complete the wiring at W2.5.
  - T-D18 adjustment: Atlas's team still finishes their mock build undisturbed and still owns the M2 **final re-sync** (mechanical: self-contained module + frozen CollabFacade seam + my ui-snapshot drift tracking). The 9-point handoff protocol stands.

## Wave status

| Wave | Status | Notes |
|---|---|---|
| W0 (M0 scaffold + contract + conformance) | **DONE — G0 PASSED 2026-07-25** | Contract + conformance landed and verified by Vega (typecheck green; contract 18/18; conformance red-in-the-right-way against the honest stub: 3 failed + 4 passed + 47 red-skipped, headline = 26 v1 GETs answering 501). Ops (Argo: start story/CI) + rigs (Lynx) finishing as non-gating W0 tail. |
| W1a (contract amendments per AM-2) | **IN PROGRESS** | Rigel: projects/blobs/event-envelope/governance into @tm8/contract + conformance updates → contract freeze. First W1b work was reset by the session limit before producing files. |
| W1b (db+RPC+RLS · identity · sidecar+scheduler) | queued behind W1a | Cygnus: db/migrations vs AMENDED contract. Lyra: identity (packages/server/src/identity/). Castor via Altair: sidecar+scheduler. Dev PG18 bootstrapped by Vega at ~/.tm8-dev/pg (port 5442). |
| W2 (facade+derived truth · events+WS · conformance completion) | not started | Gate G1 = M1 |
| W3 (UI transplant + RealFacade · web boot) | not started | waits on Atlas's collab-v2-ui W5 (T-D18) |
| W4 (execution lifts · SpawnService+execution.* · CLI+adapter) | not started | |
| W5 (spell port, transcript, acceptance, perf parity) | not started | Gate G3 = Phase 1 done |

## Gates

- **G0: PASSED 2026-07-25** (Vega-verified). Contract surface: `@tm8/contract` = contract.ts (§1 near-verbatim UI transcription incl. CollabError/ERROR_STATUS; §2 tm8 extensions: work_session/collection state+content, c:* custom kinds scalars-only, execution.* inputs, EntityKindDef, Create/UpdateSpaceInput; work_session is spawn-only — excluded from entities.create), catalog.ts (62-op closed catalog + HTTP bindings; search.query = only reserved slot; execution.spawn = POST /v2/execution/spawn, prompt/terminate/streams-attach = /v2/entities/:id/commands/*; spaces.home = GET /v2/spaces/:spaceId/home; WS /v2/ws + poll fallback /v2/spaces/:spaceId/events), schemas.ts (zod for every shape, compile-bound z.ZodType<T>, .strict() DTOs and inputs), cursor.ts (DEV-5 {v:2,k:[...]} base64url), envelope.ts (DEV-6 {data,requestId}; DEV-8 wire error per api-design 04 §4 normative nesting — note: UI doc-comment sketch differs, relayed to Keystone). `tools/conformance` = catalog-driven client + honest stub (:4610) + world builder + 8 suites (envelope/taxonomy/cursors/idempotency/events/reads/commands/execution). Conformance test/ dirs are vitest-only (not tsc -b rootDir) — accepted posture. Route bindings accepted by Vega as listed.
- G1/G2/G3: pending.

## Ground rules (law)

- Workers/leads NEVER run git. Vega reviews diffs and commits per verified wave.
- Package-disjoint ownership per 09 §1. Cross-boundary needs route through Vega.
- Scoped `tsc -b`/`vitest` only; never parallel vite builds.
- `packages/server` + `packages/execution` run under node, never bun (node-pty).
- Ports 4610 (server) / 4611 (UI dev) / 5442 (sidecar PG); data ~/.tm8 (dev ~/.tm8-dev).
- Polaris independently verifies from W2 onward; a claim Polaris did not reproduce is not green.

## Team (expanded 2026-07-25 — seven sub-teams under tm8 Org)

- Rigel (Platform lead): contract + db/RPC + identity/RLS — workers Cygnus (db/RPC), Lyra (identity/RLS).
- Altair (Server lead): facade + events + sidecar lifecycle code + scheduler — workers Deneb, Sirius, Castor.
- Orion (Execution lead): PTY lifts + SpawnService + CLI — workers Draco (lift scope per T-D21: PTY host + terminal components only, no Tauri), Phoenix.
- Atlas (UI lead): existing Collab V2 UI team; joins at W3 (M2) after their mock build completes.
- **Ops — Argo (lead) + Vela (CI/packaging): one-command start story, CI-as-merge-gate (conformance suite), env isolation, release packaging incl sidecar distribution (R15).** Supersedes the earlier note assigning one-command start to Altair — sidecar *lifecycle code* stays Altair/Castor; start story/packaging/CI = Argo. Active from W0.
- **Quality — Polaris (lead; audits only, writes no product code, reports only to Vega) + Lynx (builds test machinery: conformance plumbing post-G0 handoff, golden-workflow rigs, execution.prompt PTY round-trip rig, SpawnService parity fixtures, perf rigs).** Active from W0.
- **Gateway — Cepheus (lead) + Pavo + Volans: DORMANT until G3 (Phase 2 owners; do not spawn in Phase 1).**

Ownership boundary during W0: Rigel owns tools/conformance until G0; Lynx works in tools/rigs/ only, takes conformance extension post-G0.

## Operational facts (verified by workers)

- Old maestro LIVE server for perf baselining = **:4570** (authMode none, commit 07d504d) and it already runs `MAESTRO_PTY_HOST=server`; read-only PTY attach verified at `ws://localhost:4570/pty?sessionId=<id>&offset=<n>` (Lynx, 2026-07-25). Staging 4569/4568 and prod 3001 also exist — do not disturb any of them with writes.
- Non-invasive baseline capturable now: attach/hydration latency, replay throughput, live-frame cadence, 16ms-coalescing conformance, multi-subscriber fan-out skew. Keystroke-echo round-trip needs a controlled session — scheduled through Vega.
- tools/rigs/ is intentionally ZERO-dependency (node ≥22 global fetch/WebSocket) to avoid bun.lock churn.
- **UI snapshot rules (from Atlas's coordinator, in writing):** every committed SHA on feat/collab-v2-ui is a FULL-TREE gate-verified state (partial states never commit) — any committed SHA is a safe snapshot. **Preferred snapshot point: Keystone's W5.4 reconciliation commit** (covers the entire tm8 G0 contract delta: reserved kinds, custom-kind types, execution family as honest 501s, normative error body, strict-DTO audit, space inputs); their coordinator forwards that SHA + interface-diff summary as the snapshot signal. CollabFacade interface-change tripwire armed in Atlas's gate protocol. Their suite: 827/827 at last report.
