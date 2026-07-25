# tm8 STATE

## ⚡ HANDOFF FOR FRESH VEGA (written 2026-07-25 at controlled shutdown; read this first, then the amendments, then everything else)

**You are Vega, CTO of tm8.** The user stopped the maestro server deliberately after wave salvage; every prior session is gone. Repo HEAD (`e1bd4de`) is fully Vega-verified — trust the commits, not memories. Your immediate mission per the user: **drive testing of tm8 session spawning** (the G1A loop), then finish Phase 1 = the loop ONLY (AM-5).

### Verified-true state (all reproduced by prior Vega at commit time)
| Lane | State | Reproduce with |
|---|---|---|
| Contract (FROZEN d8f4ae9) | **81 catalog entries = 78 v1 + 3 reserved** (freeze record said 73 — that was an undercount, corrected here; server frame reports 80 — one-off audit for the discrepancy is a 5-min task) | `bun run typecheck`; contract vitest 22/22 |
| db 001–006 | apply clean to fresh db | `PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_check node db/migrate.mjs reset --force` |
| **db 007 RPC catalog + 008 RLS** | **NOT WRITTEN — the top blocker.** Cygnus (tm_1784942907336_l3xwp0oda) was mid-flight; respawn him on task task_1784944699768_kifemjszm with slice-first order (STATE 'Slice-first migration order') + claims ruling + F1/F2 mandates (all recorded below) | — |
| Identity block | DONE, 61/61 tests; seam documented in `src/identity/index.ts`; PG-backed tests pending 002-at-5442 (say the word to Lyra tm_1784942923389_w9tgzxce7) | `cd packages/server && bun run test` (157/157 total) |
| Server frame | DONE: boots :4610, catalog-driven router, honest 501s; conformance vs REAL frame == stub profile (3F/4P/58skip) | `node packages/server/dist/index.js` then `TM8_CONFORMANCE_BASE_URL=http://127.0.0.1:4610 bun run test` in tools/conformance — **`dist/main.js` is NOT the entry point**: it defines `main()` and never calls it, so running it exits 0 silently with no server and no output, which reads as a crash-free failure (Phoenix, 2026-07-25). Only `dist/index.js` self-starts. |
| Sidecar + scheduler | landed w/ tests (in the 157) | same suite |
| PTY host lift | DONE: harness 5/5, scars intact | `cd packages/execution && bun run harness` |
| Rigs | keystroke-echo rig READY (needs a controlled session on :4570 — `tools/rigs/perf/PROCEDURE.md`); 4 legacy baselines captured | `node tools/rigs/perf/echo-dry-run.mjs --help` |

### Remaining path to G1A (in order)
1. **Cygnus: 007-slice RPCs + 008-slice RLS** (everything else queues behind this).
2. **Facade slice handlers** (Altair tm_1784942923643_pt95o62ow → Deneb/Sirius if he wants hands): plug into the frame's handler registry; identity seam + db RPCs; WS events with (spaceId,seq) envelope.
3. **SpawnService** (Orion's team; Draco's `attach()` seam is ready): graph reads → work_session + manifest (in-process) → spawn via PtyHostService; old spawn route = behavioral oracle (agent-maestro maestro-server/src, ~850-LOC inline route — run `graphify query` there first).
4. **CLI worker-init minimal** (Phoenix tm_1784942971125_lj13ikkc2): manifest reader + report-back verbs.
5. **UI snapshot → packages/ui + RealFacade**: WAIT for the snapshot package from Atlas's coordinator (sess_1784923719598_k7wt05wk3, may be dead — re-establish via user); rules in 'UI snapshot rules' below.
6. **G1A acceptance**: browser loop + Lynx's echo rig diff vs legacy baselines (never absolute ms — rig floor is 10–16ms, see PROCEDURE §1).

### Gotchas the fleet found (do not rediscover these)
- Draco HAND-COPIED prebuilt `node-pty`/`@xterm/headless`/`@xterm/addon-serialize` into `packages/execution/node_modules` (bun install strips node-pty's spawn-helper exec bit). A real install needs npm, or bun + `chmod +x` the darwin spawn-helper. Packaging item for Argo (tm_1784943810645_4pbuyw77b).
  - **Refined 2026-07-25 (Orion, reproduced live while adding `pg`):** the PREBUILDS SURVIVE a bun install — only the **mode bit** is lost. `bun add` re-links node-pty through `node_modules/.bun/`, `spawn-helper` lands 0644, and the harness goes 5/5 → 0/5 with `posix_spawnp failed`. Fix is one command: **`bash scripts/repair-node-pty.sh`** (chmods every darwin spawn-helper under the repo, store copies included), then re-verify with `cd packages/execution && bun run harness`. Run it after ANY bun install.
- `tools/ci/check.sh` flips conformance advisory→BLOCKING when anything answers :4610 — with 0 ops implemented that's a guaranteed red. Don't run check.sh with the dev server up until real ops land (or gate with TM8_CONFORMANCE_GATE=advisory).
- packages/server tests flap when the dev server/PG is up concurrently (isolation gap — Altair's to fix, parked).
- PG18 runs at 127.0.0.1:5442 (superuser `tm8`, data `~/.tm8-dev/pg`, logs `~/.tm8-dev/pg.log`); `initdb` needs LANG=en_US.UTF-8. Scratch dbs `tm8_salvage_check`/`tm8_check` are disposable.
- Old maestro live server = :4570 (perf baselines); NEVER write to it without the rig's `--confirm-controlled` discipline (Lynx's near-miss: a 'working' session can look idle).
- Spawn all workers `--model opus-5` (user law). Workers never run git — YOU commit per verified wave. `maestro` CLI can hang when the server is loaded — keep prompts short, verify via files not logs when in doubt.

### Pending contract amendment (the ONE approved post-freeze change; assign to Rigel tm_1784942907081_vduwa76a0 before Sirius's WS work)
The contract has no **client→server WS control message** shape (subscribe-to-space / unsubscribe / presence-channel toggle) — browsers cannot subscribe over the wire; the frame's registry has the methods but nothing may call them. Amendment must define the control frames + zod schemas + conformance coverage. Blocked-behind-it: W2-DECOMPOSITION S4 only (S1–S3 proceed).

### Adjudications on record (do not relitigate)
- Catalog count (FINAL, audited twice): frozen contract at d8f4ae9 = **81 entries = 79 v1 + 2 reserved (search.query, bridge.fetchBlob), unchanged since freeze** — `git diff d8f4ae9 HEAD -- packages/contract/` empty. Rigel's "73" was a report miscount, not drift. `/health` correctly reports 80 HTTP-mounted routes because `events.subscribe` is WS-only. CLOSED — do not re-audit.
- W2 plan: Altair's decomposition ACCEPTED verbatim — `docs/plans/W2-DECOMPOSITION.md` (with Vega's G1A-subset note). packages/server test dir is shared across owners — scope per-owner runs during waves; whole-dir green required only at gates.

### AM-6 (2026-07-25, user-directed handoff): Orion coordinates the G1A final mile
Vega's Fable session hit rate limits; the user directed handoff to an **Opus 5 Orion** — active session **sess_1784969663040_6x4o5wk02** (model `claude-opus-5`; session AND its task task_1784969644070_lsnbg8f6m live in the Agent-maestro project proj_1770533548982_3bgizuthk because the TASK's project determines where the terminal opens — three earlier spawn attempts failed on this or were closed; workers must follow the same pattern), working in the tm8 repo. Delegated: spawning the five delivery lanes (Deneb facade-slice, Sirius events-poll, Draco SpawnService, Phoenix CLI, Cygnus db-tests — binding specs in the task description) and **commit authority at Orion-verified checkpoints only** (reproduce claims before committing; honest messages; no history rewrites; no docs/tm8-architecture edits). Goal is USER-TESTABLE basic flows (create task, spawn session, prompt, complete) + `HOW-TO-TEST.md` at repo root — NOT full conformance (AM-5 trim within the trim). Contract stays frozen; WS-control amendment SKIPPED (polling suffices). Escalate only genuine scope/design forks to the user.

### Standing user directives (all law, details in Amendments below)
AM-1/T-D21 no Tauri (server+web only) · AM-2 review adoption · AM-3 G1A includes the wired UI · AM-4 security deferred past G1A (loopback bind only) · AM-5 **Phase 1 = the loop, then STOP and report** · Opus-5-only spawns · org roster + boundaries in 'Team' section.

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
  - **Session-limit ops rule (amended by user directive, utilization over caution):** ≤5 concurrent worker sessions fleet-wide, all with package/subdir-disjoint scopes so a platform kill loses no coordination state (work is file-resumable; Vega salvage-verifies and commits). Leads do not fan out without Vega approval.

- **AM-3 (2026-07-25, user decision): Gate G1A includes the NEW UI, wired.** The first gate is now: in the browser, on the Collab V2 UI, open a space → see tasks → run a task → `execution.spawn` creates a work_session with a composed manifest → terminal panel streams the live server PTY → progress lands in the task thread → completion produces a transcript. Everything else (1B platform completeness, remaining screens, golden workflows) proceeds only after G1A passes.
  - Mechanism: an **early snapshot** of Atlas's collab-v2 module — taken from **committed, gate-verified state only** (never their working tree; their build stays untouched) — transplants into `packages/ui` at W2 kickoff (latest possible moment before wiring, to capture the most finished waves). A minimal vite host (port 4611; prod served by tm8-server) + `RealFacade` over the slice ops + work_session panel hosting the lifted terminal component complete the wiring at W2.5.
  - T-D18 adjustment: Atlas's team still finishes their mock build undisturbed and still owns the M2 **final re-sync** (mechanical: self-contained module + frozen CollabFacade seam + my ui-snapshot drift tracking). The 9-point handoff protocol stands.

- **AM-4 (2026-07-25, user directive): security work DEFERRED past G1A; speed to the working loop is the only priority.** v1-now security = bind 127.0.0.1, nothing else. Lynx's security suite cancelled for now; Altair's middleware trimmed to loopback bind + one seam file (Host/Origin/CSRF/CORS slot in post-G1A). 10-SECURITY-MODEL.md remains the post-G1A hardening spec — G1A's acceptance no longer includes its §10 checklist. DB-level items already in flight (RLS, F1/F2 RPC guards) stay — they are correctness, not ceremony, and cost nothing extra.
- **Model policy (user directive 2026-07-25): all spawned sessions run Opus 5 only** (`--model opus-5` on spawn). Vega (this session) stays as-is.
- **AM-5 (2026-07-25, user directive): Phase 1 = the G1A loop, nothing more.** After the current contract freeze, ALL remaining scope moves to post-Phase-1: former 1B platform completeness (channels/inbox/collections polish, custom kinds runtime UX, points/awards surfaces, full 73-op conformance green, golden workflows, Postgres FTS search, old-maestro import), security hardening (AM-4), and any further waves. Phase 1 DONE = in the browser on the snapshotted UI: open space → see tasks → run task → execution.spawn → manifest-booted agent in a live server-PTY terminal → progress in thread → complete + transcript. On G1A pass: Vega reports Phase 1 complete and STOPS — no new work without user direction. In-flight W1b/W2-prep/PTY-lift lanes are all loop-critical and continue; anything a worker surfaces that is not loop-critical gets parked in STATE.md under 'Post-Phase-1 backlog', not built.

- **AM-5 UI corollary (user-directed, relayed to Atlas's coordinator 2026-07-25):** the collab-v2 UI build finishes ONLY loop-critical surfaces + Keystone's W5.4 reconciliation, then CODE-FREEZES; W4/W5 and non-loop screens are post-Phase-1. Snapshot package (SHA, facade interface-diff→freeze, tests/purity, dep manifest, deferral list) is the transplant trigger.

## Post-Phase-1 backlog (parked, do not build)

- (accumulates here as workers surface non-loop items)
- **PTY harness burst check is flaky, ~1 in 4 under load** — `spawn a real PTY and coalesce a 200-line burst into few frames` intermittently reports `captured all 200 lines (got 199)`. Established by Draco on a CLEAN tree before he wrote anything, so it is pre-existing and not attributable to SpawnService. It is in the coalescing assertion's timing, not in the PTY. Not blocking G1A; will waste somebody's afternoon eventually.
- **`packages/server/src/identity/pg-store.ts` is DEAD ON ARRIVAL against the delivered 002/007 — repair or delete it post-G1A.** Written against Cygnus's published notes rather than the shipped migration. Three independent breaks, all found by Deneb 2026-07-25 before writing any code: (a) column names — it selects `login`/`node_admin`/`password_algo`, real 002:45-62 has `username`/`is_node_admin`/`password_algorithm` plus a `status` column it does not know about; (b) return types — it does `SELECT <cols> FROM public.ensure_account(...)` etc., but ALL of those RPCs return **JSONB**, not records (007:110,131,150,288), so every such query is a runtime type error; (c) `ensure_account` arity — real signature is 8 args `(p_identity_id, p_username, p_display_name, p_email, p_is_owner, p_is_node_admin, p_password_algorithm, p_password_hash)`, pg-store passes 7 in a different order. STATE's "61/61 identity tests" are ALL against `InMemoryIdentityRepository`; the PG path has never executed. G1A routes around it via a new `identity/loopback.ts` (Orion's ruling: rewriting an uncalled file on the critical path is pure risk).

## Wave status

| Wave | Status | Notes |
|---|---|---|
| W0 (M0 scaffold + contract + conformance) | **DONE — G0 PASSED 2026-07-25** | Contract + conformance landed and verified by Vega (typecheck green; contract 18/18; conformance red-in-the-right-way against the honest stub: 3 failed + 4 passed + 47 red-skipped, headline = 26 v1 GETs answering 501). Ops (Argo: start story/CI) + rigs (Lynx) finishing as non-gating W0 tail. |
| W1a (contract amendments per AM-2) | **DONE 2026-07-25 — CONTRACT FROZEN** | Catalog 62→73 ops (projects.*, files.*, bridge.fetchBlob reserved). WorkspaceEvent: eventId REMOVED, envelope {spaceId, seq per-space monotonic, occurredAt, schemaVersion:1}, cmid on all mutation-derived variants. limit_exceeded (429, capacity) added to taxonomy. execution.spawn: typed projectId + workdir{mode: project|worktree}. Exactly TWO §1 touches, loud-marked (contract.ts:237 envelope, :314 limit_exceeded) — relayed to UI team. Vega-verified: typecheck green, contract 22/22, conformance red-right-way (3F/4P/58 skip), check.sh --fast green. **Post-freeze contract changes require a Vega-approved amendment, logged here.** |
| W1b (db+RPC+RLS · identity · sidecar+scheduler) | **IN PROGRESS** | Cygnus: db/migrations vs FROZEN contract (+ Rigel's notes: projects + space_projects tables w/ trust default 'untrusted', file upload slots + blobs path convention, per-space monotonic event-seq counter, cmid uniqueness per DEV-9). Lyra: identity (packages/server/src/identity/). Castor: sidecar+scheduler (formalize Vega's hand-bootstrapped PG18 at ~/.tm8-dev/pg:5442 into lifecycle code). All three report directly to Vega this wave (session-cap: 3 workers, no lead sessions). |
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
- **Claims contract (canonical, RULED 2026-07-25 — supersedes the earlier 8-name version):** trusted SET LOCAL surface is FOUR settings only: `tm8.identity_id`, `tm8.actor_id` (effective author), `tm8.node_admin` ('on'|'off'), `tm8.request_id`. **RLS resolves membership/can_act_as from TABLES** (`internal.is_space_member/is_space_admin/can_act_as`) — never from claim snapshots (staleness-window argument, Lyra). No advisory claims in the DB session. Identity block still computes full ClaimSet server-side for facade capability gating + acting_as pre-verification (UX pre-check; RLS is authority). Security mandates: `ensure_account` raises 28000 unless zero-accounts-first-run or node-admin caller (F1); `public.resolve_account_credential(p_login)` is the sole claim-free auth read (F2). Credentials inline in `accounts` (v1); `UNIQUE(is_owner) WHERE is_owner`; `identity_id` immutable via trigger; `token_hash` sha256-hex only. Changes route through Vega.
- **Slice-first migration order (user directive):** Cygnus delivers a SLICE-READY CHECKPOINT (001-core subset, 002 identity, projects/space_projects, 006 execution, 007-slice RPCs for the G1A loop, 008-slice RLS) before completing 003/004/005 + full 007/008 — facade wiring starts on the checkpoint.
- **UI snapshot rules (from Atlas's coordinator, in writing):** every committed SHA on feat/collab-v2-ui is a FULL-TREE gate-verified state (partial states never commit) — any committed SHA is a safe snapshot. **Preferred snapshot point: Keystone's W5.4 reconciliation commit** (covers the entire tm8 G0 contract delta: reserved kinds, custom-kind types, execution family as honest 501s, normative error body, strict-DTO audit, space inputs); their coordinator forwards that SHA + interface-diff summary as the snapshot signal. CollabFacade interface-change tripwire armed in Atlas's gate protocol. Their suite: 827/827 at last report.
